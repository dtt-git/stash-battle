# Handoff: 3.0 true ELO rework

Pick-up notes for continuing the work in [true-elo-mode.md](true-elo-mode.md) in a new agent session. Read the plan first; this file covers status, conventions and gotchas.

## Status (Oct 22, 2026)

| Stage | State |
|---|---|
| 1. ELO core | **Done and verified, waiting for Brian's review. Not committed.** |
| 2. Write path + setup screen, remove fun mode | Not started. Waits for Brian's go after reviewing Stage 1. |
| 3. Modes/cache/UI onto ELO, Gauntlet becomes Placement's "Start from the bottom" | Not started |
| 4. "Stash ratings" dropdown + sync, Reset ELO | Not started |
| 5. Docs, CHANGELOG, version 3.0.0 | Not started |

- **Branch:** `elo-mode`, created from `main` at `d3e740f`.
- **Uncommitted Stage 1 changes:**
  - Changed: `.gitignore`, `package.json`, `tsconfig.json`, `src/constants.ts`, `src/elo.ts`, `src/graphql.ts`, `src/types.ts`, `src/ui/modal.ts`, and the built `plugins/stash-battle/stash-battle.js`.
  - New: `src/score.ts`, `scripts/test.mjs`, `tests/score.test.ts`, `tests/elo.test.ts`, and `docs/plans/`.
- **Open question for Brian:** whether to commit Stage 1 to the branch before Stage 2 starts. It was offered; he hasn't answered yet.

## How to work with Brian (agreed process)

- **Stage by stage, with a review checkpoint after each stage:**
  1. Run `npm run typecheck` and `npm test`.
  2. Deploy.
  3. Run that stage's checks in the browser, with screenshots and the GraphQL requests inspected.
  4. Report and **stop**.
  - Never start the next stage until he has tried it and said go.
- **Don't build beyond the plan.** Ask (AskQuestion tool) before changing anything outside it. He often refines the design mid-stream: update `true-elo-mode.md` when he does.
- **Writing style:** plain language, full sentences, concrete examples with numbers. He is not a chess or ELO expert and asks "why" a lot, so explain the reasoning.
- **Git:**
  - Only commit as the **dtt-git** user. The local git identity is already `dtt <dark7882009@hotmail.com>`.
  - To push, the gh account must be dtt-git (`gh auth switch --user dtt-git`). Then run `git -c credential.helper= -c "credential.helper=!gh auth git-credential" push`, because the Windows credential manager prompt fails.
  - Don't push or open PRs unless asked.
- **Never read `.env`** (it's blocked, and it's private).
- **No NSFW content in screenshots:**
  - Before any screenshot, hide images and videos: inject `#sb-modal img, #sb-modal video { visibility: hidden !important; }`.
  - Rewrite `.sb-scene-title`, `.sb-meta-studio`, `.sb-meta-performers` and `.sb-tags-row` to "Scene A/B", "Studio A/B", "Performer A/B" and "Tag 1 · Tag 2 · Tag 3".

## Environment

- **Stash:** v0.31.1 at `http://localhost:9999/`, the real library. It has 611 scenes, 521 of them rated. Brian **has taken a backup**, and testing on the real library is approved.
  - Stage 2+ checks write ELO custom fields.
  - Stage 4 checks rewrite Stash ratings.
  - At the end, report what was written.
- **Existing custom fields:** one scene has fields from other plugins (`hotornot_stats`, `scene_record`, both strings). None of our `stash_battle_*` fields exist yet.
- **Deploy:**
  - `npm run dev` watches `src/`, rebuilds, and copies the bundle, css and yml into `H:\ya\Stash\plugins\stash-battle` (`STASH_PLUGINS_DIR` from `.env`).
  - Reload Stash afterwards, since Stash's CSP blocks auto-reload.
  - A watcher (`node scripts/build.mjs --watch`) may still be running from the last session. Check with `Get-CimInstance Win32_Process -Filter "Name='node.exe'"` before starting another.
  - To confirm the deploy, compare hashes of `plugins\stash-battle\stash-battle.js` and the deployed copy.
- **Node 22.14:** it can't run TypeScript directly, which is why `scripts/test.mjs` bundles the tests first.

## What Stage 1 built

- `custom_fields` was added to `SCENE_FRAGMENT` (`src/graphql.ts`) and `Scene.custom_fields` (`src/types.ts`).
- **Constants** in `src/constants.ts`:
  - `ELO_FIELD = "stash_battle_elo"` and `GAMES_FIELD = "stash_battle_games"`,
  - `ELO_START` 1500 and `ELO_DIVISOR` 400,
  - `ELO_K_TIERS`: K 40 under 10 games, 24 under 30, then 16,
  - `ELO_PER_RATING_POINT` 10, `SEEDED_GAMES` 10 and `PLACEMENT_EDGE_GAP` 25.
- **`src/elo.ts`:** new `eloKFactor`, `eloExpected` and `eloResult`. ELO is stored rounded to one decimal place. The old rating100 functions (`getKFactor`, `calculateRatingChanges`, `effectiveRating`) are kept under a "Pre-3.0" heading because the modes still use them. Stage 3 deletes them.
- **`src/score.ts`:** `elo`, `isRated`, `games`, `seed`, `effectiveElo`, `linearRating`, `percentileRatings`, `compareByElo`, `sortByElo` and `eloInsertionIndex`.
  - Nothing imports it yet, so esbuild leaves it out of the bundle. That's expected: searching the bundle for `stash_battle_elo` finds nothing until Stage 2 or 3.
  - The percentile formula is `100 - round(99 * mid / (N - 1))`, where `mid` is the middle position of a tie group, so everything tied gives 50.
- **Capability check:** `sceneCustomFieldsSupported()` in `graphql.ts` runs an introspection of `Scene` fields, memoized per page load, and assumes yes if the introspection itself fails. `openModal()` in `src/ui/modal.ts` runs it alongside `loadSettings()`. If it fails, `showUnsupportedStash()` renders a "needs a newer Stash" modal.
- **Tests:** 14 unit tests in `tests/`, all passing. They include the plan's example numbers, a check that `linearRating(seed(r)) === r` for 1-100, ties, clamping and K tiers.

### Verified in the browser

- **New build served:** Stash serves the new bundle. Stash/the browser caches `/plugin/stash-battle/javascript`, so fetch it with `{ cache: "no-store" }` when checking.
- **Battle opens normally:** one introspection request, then `FindScenesByRating` with `custom_fields`. No errors and no mutations.
- **Unsupported Stash:** faking the introspection response without `custom_fields` (by wrapping `window.fetch` in the page) shows the message, the close button works, and a reload clears the fake.

## Gotchas for Stage 2 onward

- **Keep the plugin working at every checkpoint.**
  - The modes keep using rating100 until Stage 3, so Stage 2 adds `writeElo` / `clearElo` alongside `updateSceneRating` rather than replacing it.
  - Removing fun mode in Stage 2 touches `cache.ts` (sandbox), `rating.ts` (`ratingsEnabled`), `mainUI.ts` (fun badge, animations), `screens.ts` ("not saved" notes), `modal.ts` (`onSettingChanged` case and `resetSandbox` calls), `constants.ts`, `types.ts`, `settings.ts`, `settingsPanel.ts` and the yml.
- **The setup screen must run before any pool loads.** That's in `openModal()`: after settings and the capability check, before `loadNewPair` / `restoreCurrentPair`, and also on the reused-modal path.
- **The setup flags (`eloSetupAt`, `eloSetupMode`) are saved in the plugin config.** `configurePlugin` replaces the whole map, so save them through the existing settings path (`updateSettings`, plus `normalize()` in `src/settings.ts`), or they'll be lost on the next settings save.
- **Write shapes to confirm against this Stash first** (introspection or a single test scene):
  - `sceneUpdate(input: { id, custom_fields: { partial: { stash_battle_elo, stash_battle_games } } })`,
  - `bulkSceneUpdate(input: { ids, custom_fields: { partial: {...} } })`,
  - `custom_fields.remove: [keys]` for clearing.
  - After the first write, check whether values come back as numbers or strings.
- **Batching:** "Use my ratings" sends about 50 aliased `sceneUpdate` calls per request (a constant, to be tuned on Brian's library). "Start at 1500" is a single `bulkSceneUpdate`.
- **Setup preview:**
  - It's in `src/ui/ratingPreview.ts`: 10 squares in 3 rows (Now / After setup / After lots of battles).
  - Its numbers come from the real `seed`, `percentileRatings` and `linearRating`. The expected values are in the plan.
  - Both setup questions are shown at once, and the preview redraws when either changes.
- **The Settings tab has no `<select>` control yet** (`settingControl` in `settingsPanel.ts` only does checkboxes and the number box). Stage 4 adds one. `stashRatings` stays out of the yml, because Stash's plugin settings page has no dropdown type.
- **Opening Battle in automation:** the nav link is an `<a>` whose text is exactly "Battle". To log GraphQL traffic, wrap `window.fetch` and record each request's operation name, whether it's a mutation, and any errors.
- **Screenshots:** `browser_take_screenshot` downscales. For exact sizes, use CDP `Emulation.setDeviceMetricsOverride` (1280x960, because card tags hide below 900px of height) plus `Page.captureScreenshot` with a clip, and clear the emulation afterwards.

## Other open items (outside the ELO plan)

- **SFW Switch:** after [stashapp/CommunityScripts#800](https://github.com/stashapp/CommunityScripts/pull/800) merges, remove the `pwr-*` classes and their comment from `src/ui/sceneCard.ts`, and the "SFW Switch compatibility" note in `DOCUMENTATION.md`.
- **Minimum Stash version:** look up which Stash version added scene custom fields, for the README (Stage 5).

## Previous session

The full discussion behind every decision is in the agent transcript `6569f1e6-9801-45d9-80c3-6cdd00953842`.
