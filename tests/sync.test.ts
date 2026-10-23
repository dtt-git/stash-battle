import assert from "node:assert/strict";
import { test } from "node:test";

import { refreshStashCache } from "../src/graphql";
import { syncStashRatings } from "../src/rating";
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
