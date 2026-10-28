import assert from "node:assert/strict";
import { test } from "node:test";
import { scenesListQuery } from "../src/filters";
import { getSceneIdFromUrl } from "../src/graphql";
import { basePath, stashRoute, stashUrl } from "../src/stashUrl";

/** Stash at `base` (its <base href>), on the page `pathname` (Node has no window or document). */
function at(base: string | null, pathname: string, search = ""): void {
  const g = globalThis as unknown as { window: unknown; document: unknown };
  g.window = { location: { pathname, search, href: `https://example.com${pathname}${search}` } };
  g.document = { querySelector: () => (base === null ? null : { getAttribute: () => base }) };
}

test("Stash at the root: paths are unchanged", () => {
  at("/", "/scenes/12");
  assert.equal(basePath(), "/");
  assert.equal(stashUrl("graphql"), "/graphql");
  assert.equal(stashRoute(), "/scenes/12");
  // No <base> at all
  at(null, "/scenes/12");
  assert.equal(stashUrl("/graphql"), "/graphql");
});

test("Stash under a subpath: requests and links go under it, routes come without it", () => {
  at("/stash/", "/stash/scenes/12", "?q=beach");
  assert.equal(stashUrl("graphql"), "/stash/graphql");
  assert.equal(stashUrl("scenes/12?q=beach"), "/stash/scenes/12?q=beach");
  assert.equal(stashRoute(), "/scenes/12");
  assert.equal(getSceneIdFromUrl(), "12");
  assert.equal(scenesListQuery(), "?q=beach");
  // The subpath's own home page, with or without the slash
  at("/stash/", "/stash/");
  assert.equal(stashRoute(), "/");
  at("/stash/", "/stash");
  assert.equal(stashRoute(), "/");
  // A base without the trailing slash still joins cleanly
  at("/stash", "/stash/performers", "?q=anna");
  assert.equal(stashUrl("graphql"), "/stash/graphql");
  assert.equal(stashRoute(), "/performers");
  assert.equal(scenesListQuery(), "");
});
