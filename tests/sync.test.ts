import assert from "node:assert/strict";
import { test } from "node:test";

import { refreshSceneInCache } from "../src/cache";
import { bulkUpdateScenes, holdStashListRefresh, refreshStashCache } from "../src/graphql";
import { restoreElo, syncStashRatings, writeElo } from "../src/rating";
import { battles, elo, sceneRecord } from "../src/score";
import { updateSettingsNow } from "../src/settings";
import { state } from "../src/state";
import type { Scene } from "../src/types";

const scene = (id: string, eloValue: number | null, rating100: number | null): Scene => ({
  id,
  rating100,
  custom_fields: eloValue === null ? {} : { stash_battle_elo: eloValue },
});

/** A fake Stash GraphQL endpoint that records each request and answers with empty data. */
function fakeFetch(): { bodies: { query: string; variables: Record<string, unknown> }[] } {
  const record = { bodies: [] as { query: string; variables: Record<string, unknown> }[] };
  globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
    record.bodies.push(JSON.parse(init.body));
    return { json: async () => ({ data: {} }) };
  }) as unknown as typeof fetch;
  return record;
}

/** A fake Apollo cache holding some scenes, recording evictions. */
function fakeApollo(entries: Record<string, Record<string, unknown>>) {
  const evicted: string[] = [];
  const cache = {
    identify: ({ id }: { id: string }) => `Scene:${id}`,
    modify: ({ id, fields }: { id: string; fields: Record<string, (existing: unknown) => unknown> }) => {
      const entry = entries[id];
      if (!entry) return false;
      for (const [name, fn] of Object.entries(fields)) if (name in entry) entry[name] = fn(entry[name]);
      return true;
    },
    evict: ({ fieldName }: { fieldName?: string }) => {
      evicted.push(fieldName ?? "");
      return true;
    },
    gc: () => [],
  };
  (globalThis as unknown as { window: unknown }).window = {
    PluginApi: { utils: { StashService: { getClient: () => ({ cache }) } } },
  };
  return { entries, evicted };
}

test("syncStashRatings writes only changed ratings, grouped by value, in one request", async () => {
  const record = fakeFetch();
  fakeApollo({});
  state.settings = { ...state.settings, stashRatings: "linear" };
  state.memoryCache.allScenes = [
    scene("a", 1800, 80), // already right (1800 → 80)
    scene("b", 1740, 70), // 1740 → 74
    scene("c", 1740, null), // → 74
    scene("d", 1500, 49), // → 50
    scene("u", null, 33), // unrated: never written
  ];

  assert.equal(await syncStashRatings(), 3);
  assert.equal(record.bodies.length, 1);
  assert.deepEqual(record.bodies[0].variables, {
    u0: { ids: ["b", "c"], rating100: 74 },
    u1: { ids: ["d"], rating100: 50 },
  });
  // The cache now holds the written ratings, so the next sync writes nothing
  assert.deepEqual(state.memoryCache.allScenes.map((s) => s.rating100), [80, 74, 74, 50, 33]);
  assert.equal(await syncStashRatings(), 0);
  assert.equal(record.bodies.length, 1);
});

test("syncStashRatings does nothing on Don't update", async () => {
  const record = fakeFetch();
  state.settings = { ...state.settings, stashRatings: "off" };
  state.memoryCache.allScenes = [scene("b", 1740, 70)];
  assert.equal(await syncStashRatings(), 0);
  assert.equal(record.bodies.length, 0);
});

test("refreshStashCache updates cached scenes and drops cached lists only when ratings changed", () => {
  const apollo = fakeApollo({
    "Scene:1": { rating100: 70 },
    "Scene:2": { rating100: 40, custom_fields: { other_plugin: "x", stash_battle_elo: 1400 } },
  });
  refreshStashCache([{ id: "1", rating100: 74 }, { id: "9", rating100: 10 }], true);
  assert.equal(apollo.entries["Scene:1"].rating100, 74);
  assert.deepEqual(apollo.evicted, ["findScenes"]);

  refreshStashCache([{ id: "2", elo: { elo: 1612.5, battles: 3, seeded: true } }], false);
  assert.deepEqual(apollo.entries["Scene:2"].custom_fields, {
    other_plugin: "x",
    stash_battle_elo: 1612.5,
    stash_battle_battles: 3,
    stash_battle_seeded: true,
  });
  assert.deepEqual(apollo.evicted, ["findScenes"], "ELO-only changes keep cached lists");

  refreshStashCache([{ id: "2", elo: null }], false);
  assert.deepEqual(apollo.entries["Scene:2"].custom_fields, { other_plugin: "x" });
});

test("refreshStashCache is a no-op when Stash doesn't expose its client", () => {
  (globalThis as unknown as { window: unknown }).window = {};
  assert.doesNotThrow(() => refreshStashCache([{ id: "1", rating100: 5 }], true));
});

test("syncStashRatings runs one sync at a time, each starting from the last one's writes", async () => {
  const record = fakeFetch();
  const instant = globalThis.fetch;
  // The first request takes a moment, so the second sync starts while it's still writing
  globalThis.fetch = (async (url: unknown, init: { body: string }) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return instant(url as string, init as RequestInit);
  }) as unknown as typeof fetch;
  fakeApollo({});
  state.settings = { ...state.settings, stashRatings: "linear" };
  state.memoryCache.allScenes = [scene("b", 1740, 70)];

  const [first, second] = await Promise.all([syncStashRatings(), syncStashRatings()]);
  assert.deepEqual([first, second], [1, 0]);
  assert.equal(record.bodies.length, 1);
});

test("holdStashListRefresh drops Stash's scene lists once on release, not on every write", () => {
  const apollo = fakeApollo({ "Scene:1": { rating100: 70 } });
  holdStashListRefresh(true);
  refreshStashCache([{ id: "1", rating100: 74 }], true);
  refreshStashCache([{ id: "1", rating100: 75 }], true);
  assert.equal(apollo.entries["Scene:1"].rating100, 75, "cached scenes still update");
  assert.deepEqual(apollo.evicted, []);
  holdStashListRefresh(false);
  assert.deepEqual(apollo.evicted, ["findScenes"]);
  holdStashListRefresh(true);
  holdStashListRefresh(false);
  assert.deepEqual(apollo.evicted, ["findScenes"], "nothing changed, nothing dropped");
});

test("writeElo puts the old ELO back when the write fails", async () => {
  globalThis.fetch = (async () => ({ json: async () => ({ errors: [{ message: "database is locked" }] }) })) as unknown as typeof fetch;
  fakeApollo({});
  state.settings = { ...state.settings, stashRatings: "off" };
  const cached = { ...scene("w", 1600, null), custom_fields: { stash_battle_elo: 1600, stash_battle_battles: 4 } };
  state.memoryCache.allScenes = [cached];
  state.memoryCache.filteredScenes = null;
  const held = { ...cached }; // a separate copy, like a saved pair's scene
  const originalError = console.error;
  console.error = () => {};
  try {
    await writeElo(held, 1640, 5, [true]);
  } finally {
    console.error = originalError;
  }
  assert.equal(elo(state.memoryCache.allScenes[0]), 1600);
  assert.equal(battles(state.memoryCache.allScenes[0]), 4);
  assert.equal(elo(held), 1600);
  // The record it would have started is rolled back too
  assert.equal(sceneRecord(state.memoryCache.allScenes[0]), null);
});

test("writeElo sends the record in the same request as the ELO, then notes a new #1", async () => {
  const bodies: { query: string; variables: { input: { custom_fields: { partial: Record<string, unknown> } } } }[] = [];
  globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.query.includes("configuration")) return { json: async () => ({ data: { configuration: { plugins: {} } } }) };
    return { json: async () => ({ data: { sceneUpdate: { id: "r" }, configurePlugin: {} } }) };
  }) as unknown as typeof fetch;
  fakeApollo({});
  state.settings = { ...state.settings, stashRatings: "off" };
  const cached = { ...scene("r", 1600, null), custom_fields: { stash_battle_elo: 1600, stash_battle_battles: 4, stash_battle_wins: 2, stash_battle_losses: 1, stash_battle_peak: 1610, stash_battle_streak: 1, stash_battle_best_streak: 2 } };
  state.memoryCache.allScenes = [cached];
  state.memoryCache.filteredScenes = null;
  await writeElo(cached, 1625, 5, [true]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const updates = bodies.filter((body) => body.query.includes("sceneUpdate"));
  assert.equal(updates.length, 1);
  // The only scene is #1, so it joins the hall of fame (a config read, then the save)
  assert.ok(bodies.some((body) => body.query.includes("configurePlugin") && JSON.stringify(body.variables).includes('\\"id\\":\\"r\\"')));
  assert.deepEqual(updates[0].variables.input.custom_fields.partial, {
    stash_battle_elo: 1625,
    stash_battle_battles: 5,
    stash_battle_seeded: false,
    stash_battle_wins: 3,
    stash_battle_losses: 1,
    stash_battle_peak: 1625,
    stash_battle_streak: 2,
    stash_battle_best_streak: 2,
  });
});

test("a settings save keeps what another tab stored, plus only this tab's changes", async () => {
  const bodies: { query: string; variables: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const stored = { eloSetupAt: "2026-10-22T10:00:00.000Z", eloSetupMode: "ratings", stashRatings: "percentile", previewVolume: 40 };
    return { json: async () => ({ data: { configuration: { plugins: { "stash-battle": stored } } } }) };
  }) as unknown as typeof fetch;
  // This tab loaded its settings before the other tab finished the setup
  state.settings = { ...state.settings, eloSetupAt: null, eloSetupMode: null, stashRatings: "off" };

  assert.equal(await updateSettingsNow({ previewVolume: 10 }), true);
  const saved = bodies.at(-1)?.variables.input as Record<string, unknown>;
  assert.equal(saved.eloSetupAt, "2026-10-22T10:00:00.000Z");
  assert.equal(saved.eloSetupMode, "ratings");
  assert.equal(saved.stashRatings, "percentile");
  assert.equal(saved.previewVolume, 10);
});

test("refreshSceneInCache brings a scene's cached copy up to date and moves it to its rank", () => {
  state.memoryCache.allScenes = [scene("a", 1800, 80), scene("b", 1700, 70), scene("c", 1600, 60)];
  state.memoryCache.filteredScenes = null;
  // Fresh from Stash (changed in another tab): b is now on top, with a new Stash rating
  const fresh: Scene = { id: "b", rating100: 90, custom_fields: { stash_battle_elo: 1900, stash_battle_battles: 7, stash_battle_seeded: 1 } };
  refreshSceneInCache(fresh);
  const cached = state.memoryCache.allScenes;
  assert.deepEqual(cached.map((s) => s.id), ["b", "a", "c"]);
  assert.equal(cached[0].rating100, 90);
  assert.equal(elo(cached[0]), 1900);
  assert.equal(battles(cached[0]), 7);
  assert.notEqual(cached[0], fresh, "the cached object is updated, not replaced");
});

test("restoreElo (undo) writes the old fields back and removes what the pick added", async () => {
  const inputs: { custom_fields: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body);
    if (body.query.includes("sceneUpdate")) inputs.push(body.variables.input);
    return { json: async () => ({ data: { sceneUpdate: { id: "x" } } }) };
  }) as unknown as typeof fetch;
  fakeApollo({});
  state.settings = { ...state.settings, stashRatings: "off" };

  // A scene whose first battle created its record: back to no record
  const picked = { ...scene("x", 1600, null), custom_fields: { stash_battle_elo: 1612, stash_battle_battles: 5, stash_battle_seeded: 1, stash_battle_wins: 1, stash_battle_losses: 0, stash_battle_peak: 1612, stash_battle_streak: 1, stash_battle_best_streak: 1 } };
  state.memoryCache.allScenes = [picked];
  state.memoryCache.filteredScenes = null;
  await restoreElo(picked, { elo: 1600, battles: 4, seeded: true });
  assert.deepEqual(inputs[0].custom_fields, {
    partial: { stash_battle_elo: 1600, stash_battle_battles: 4, stash_battle_seeded: true },
    remove: ["stash_battle_wins", "stash_battle_losses", "stash_battle_peak", "stash_battle_streak", "stash_battle_best_streak"],
  });
  assert.equal(elo(picked), 1600);
  assert.equal(sceneRecord(picked), null);

  // Already as it was: nothing written
  await restoreElo(picked, { elo: 1600, battles: 4, seeded: true });
  assert.equal(inputs.length, 1);

  // A scene that was unrated before the pick: unrated again
  await restoreElo(picked, null);
  assert.equal((inputs[1].custom_fields.remove as string[]).length, 8);
  assert.equal(elo(picked), null);
});

test("bulkUpdateScenes splits big writes into requests of at most chunkSize scenes", async () => {
  const record = fakeFetch();
  const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  const progress: number[] = [];
  await bulkUpdateScenes(
    [
      { ids: ids("a", 5), changes: { rating100: 10 } },
      { ids: ids("b", 2), changes: { rating100: 20 } },
    ],
    (done, total) => progress.push(done, total),
    3,
  );
  // a0-a2 | a3-a4 + b0 | b1: a group split across requests keeps its changes in each piece
  assert.deepEqual(
    record.bodies.map((body) => body.variables),
    [
      { u0: { ids: ["a0", "a1", "a2"], rating100: 10 } },
      { u0: { ids: ["a3", "a4"], rating100: 10 }, u1: { ids: ["b0"], rating100: 20 } },
      { u0: { ids: ["b1"], rating100: 20 } },
    ],
  );
  assert.deepEqual(progress, [3, 7, 6, 7, 7, 7]);
  // Nothing to write: no request
  await bulkUpdateScenes([{ ids: [], changes: { rating100: 1 } }]);
  assert.equal(record.bodies.length, 3);
});
