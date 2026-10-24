import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_SETTINGS } from "../src/constants";
import { mergeConfig, parseHallOfFame } from "../src/settings";

test("mergeConfig keeps keys that aren't settings, such as the hall of fame", () => {
  const stored = { stashRatings: "linear", previewVolume: 30, statsHallOfFame: '[{"id":"1","date":"2026-10-24"}]' };
  const merged = mergeConfig(stored, { ...DEFAULT_SETTINGS, previewVolume: 70 }, ["previewVolume"]);
  assert.equal(merged.statsHallOfFame, stored.statsHallOfFame);
  assert.equal(merged.previewVolume, 70);
  // Not changed in this tab: the stored value wins
  assert.equal(merged.stashRatings, "linear");
});

test("mergeConfig drops removed keys and unset values, and applies extra keys", () => {
  const stored = { funMode: true, unratedRating: 50, showTiers: true, previewVolume: 30 };
  const merged = mergeConfig(stored, DEFAULT_SETTINGS, [], { statsHallOfFame: "[]" });
  assert.equal("funMode" in merged, false);
  assert.equal("unratedRating" in merged, false);
  assert.equal("showTiers" in merged, false);
  assert.equal("eloSetupAt" in merged, false); // null: unset
  assert.equal(merged.statsHallOfFame, "[]");
  // null in extra removes a key
  assert.equal("statsHallOfFame" in mergeConfig({ statsHallOfFame: "[]" }, DEFAULT_SETTINGS, [], { statsHallOfFame: null }), false);
});

test("parseHallOfFame reads the stored list and ignores anything broken", () => {
  assert.deepEqual(parseHallOfFame('[{"id":"7","date":"2026-10-24T10:00:00.000Z"}]'), [{ id: "7", date: "2026-10-24T10:00:00.000Z" }]);
  assert.deepEqual(parseHallOfFame('[{"id":7},{"id":"8","date":"x"}]'), [{ id: "8", date: "x" }]);
  assert.deepEqual(parseHallOfFame("not json"), []);
  assert.deepEqual(parseHallOfFame(undefined), []);
  assert.deepEqual(parseHallOfFame('{"id":"1"}'), []);
});
