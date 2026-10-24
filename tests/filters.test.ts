import assert from "node:assert/strict";
import { test } from "node:test";
import { readFilters, scenesListQuery } from "../src/filters";

/** Point the global window at a URL (Node has no window). */
function at(pathname: string, search: string): void {
  (globalThis as unknown as { window: unknown }).window = { location: { pathname, search } };
}

test("the Scenes page and scene pages keep their filter query", () => {
  at("/scenes", "?q=beach");
  assert.equal(scenesListQuery(), "?q=beach");
  assert.equal(readFilters().filterActive, true);
  at("/scenes/123", "?q=beach");
  assert.equal(scenesListQuery(), "?q=beach");
});

test("other pages' queries aren't read as a Scenes filter", () => {
  // Stash Battle opens from every page; a performer search isn't a scene search
  at("/performers", "?q=anna&sortby=name");
  assert.equal(scenesListQuery(), "");
  assert.equal(readFilters().filterActive, false);
  at("/", "");
  assert.equal(readFilters().filterActive, false);
  at("/scenesx", "?q=beach");
  assert.equal(scenesListQuery(), "");
});
