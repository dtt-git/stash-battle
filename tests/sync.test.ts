import assert from "node:assert/strict";
import { test } from "node:test";

import { refreshSceneInCache } from "../src/cache";
import { holdStashListRefresh, refreshStashCache } from "../src/graphql";
import { syncStashRatings, writeElo } from "../src/rating";
import { battles, elo } from "../src/score";
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
  const vars = record.bodies[0].variables as Record<string, { ids: string[]; rating100: number }>;
  assert.deepEqual(vars.r74, { ids: ["b", "c"], rating100: 74 });
  assert.deepEqual(vars.r50, { ids: ["d"], rating100: 50 });
  assert.equal(Object.keys(vars).length, 2);
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
    await writeElo(held, 1640, 5);
  } finally {
    console.error = originalError;
  }
  assert.equal(elo(state.memoryCache.allScenes[0]), 1600);
  assert.equal(battles(state.memoryCache.allScenes[0]), 4);
  assert.equal(elo(held), 1600);
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
