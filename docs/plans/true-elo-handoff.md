# Handoff: 3.0 true ELO rework

Pick-up notes for continuing the work in [true-elo-mode.md](true-elo-mode.md) in a new agent session. Read the plan first; this file covers status, conventions and gotchas.

## Status (Oct 22, 2026)

| Stage | State |
|---|---|
| 1. ELO core | Done, reviewed, committed. |
| 2. Write path + setup screen, remove fun mode | Done, reviewed, committed. |
| 3. Modes/cache/UI onto ELO, Gauntlet becomes Placement's "Start from the bottom" | Done, reviewed, committed. |
| 4. "Stash ratings" dropdown + sync, Reset ELO, Stash page-cache refresh | Done, reviewed, committed. |
| 5. Docs, CHANGELOG, version 3.0.0 | Done and committed; pushed with a PR into `main`. |

- **Branch:** `elo-mode`, created from `main` at `d3e740f`.
- **Commits:** Stages 1-5 are separate commits on `elo-mode` (plus Stage 2's review polish and the navbar merge), pushed with a PR into `main` at Brian's request.
- **Navbar change:** `PluginApi.patch` for the nav button was made on its own branch, `claude/amazing-rubin-4ce4c3` (commit `9e74ce2`, from `main`). It's now merged into `elo-mode` (merge `a00e75d`). It touches `main.ts`, `navButton.ts` and `deleteDialog.ts` and adds `src/pluginApi.ts`. Checked after the merge: the button shows on Scenes, hides on Performers and opens the ELO setup.

## How to work with Brian (agreed process)

- **Stage by stage, with a review checkpoint after each stage:**
  1. Run `npm run typecheck` and `npm test`.
  2. Deploy.
  3. Run that stage's checks in the browser, with screenshots and the GraphQL requests inspected.
  4. Report and **stop**.
  - Never start the next stage until he has tried it and said go.
- **Don't build beyond the plan.** Ask (AskQuestion tool) before changing anything outside it. He often refines the design mid-stream: update `true-elo-mode.md` when he does.
- **Writing style:** plain language, full sentences, concrete examples with numbers. He is not a chess or ELO expert and asks "why" a lot, so explain the reasoning.
- **Naming:** call the plugin "Stash Battle", never just "Battle", in UI text and in messages to Brian. "Battle" is fine only for the navbar button and the "⚔️ Battle" tab, since those name the button and the tab.
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

## What Stage 2 built

- **Settings** (`src/types.ts`, `src/constants.ts`, `src/settings.ts`):
  - `funMode` removed. A stored `funMode` is dropped on load and disappears from the config on the next save (checked).
  - New `stashRatings` (`"off"` default; unknown values become `"off"`), `eloSetupAt` (ISO time string) and `eloSetupMode` (`"ratings"` / `"fresh"`). `stashRatings` arrived a stage early because setup saves its second answer there; the dropdown is still Stage 4.
  - `loadSettings()` now returns whether it loaded. `updateSettingsNow()` saves without the debounce and reports failure. `persistSettings` leaves out null keys. `hadFunMode()` says whether the stored config had pre-3.0 fun mode on.
- **`src/score.ts`:** `startingElo(scene, start)`, `afterSetup(scene, start)` (a copy with our fields replaced), `stashRatingTargets(scenes, mode)` and `stashRatingChanges(scenes, mode)` (only ratings that differ). 17 unit tests now, including the preview's numbers.
- **`src/rating.ts`:** `ratingsEnabled` removed. New `writeElo(id, elo, games)` (later `writeElo(scene, elo, battles)`) and `clearElo(id)`: one `sceneUpdate`, custom fields only, with the cached objects updated via `setEloInCache` (no re-sort). New `writeStashRatings(map)`: one request, one aliased `bulkSceneUpdate` per distinct value. Stage 4's debounced `syncStashRatings` should wrap it. `updateSceneRating` stays for the modes.
- **`src/eloSetup.ts`:** `fetchSetupScenes()` (fresh `id rating100 custom_fields` for every scene, not the cache), `setupRatingChanges()` and `runEloSetup()`.
  - "Use my ratings": aliased `sceneUpdate`s, `SETUP_BATCH_SIZE` (50) per request. Then one `bulkSceneUpdate` with `custom_fields.remove` for scenes that have an ELO but no Stash rating, which only happens on a re-run. That is the plan's Reset ELO rule, applied to every setup run.
  - "Start everyone at 1500": one `bulkSceneUpdate` with every id.
  - Then `writeStashRatings` if the second answer isn't "off".
- **`src/ui/setupScreen.ts` + `src/ui/ratingPreview.ts`:** the screen renders into `#sb-setup-area` in the Battle panel. The panel gets `sb-setup-active`, and CSS hides everything else in it. A module-level `running` flag keeps the progress view if Battle is closed and reopened mid-setup. When the writes finish, it clears the scene cache, shuffle, run state and saved pair, then saves the flags. If saving the flags fails, it offers a retry and stays pending.
  - Extra notes beyond the plan: "N scenes already have an ELO from an earlier setup that didn't finish" (shown when any scene has one), and the Start button reads "Start ELO and change N ratings" when ratings would change.
- **Gating** (`isEloSetupPending()` in `src/state.ts`, true while `eloSetupAt` is unset): `loadNewPair` and `restoreCurrentPair` return early, the battle keyboard shortcuts are off, and `openModal` shows the setup on both the new-modal and reused-modal paths. If settings fail to load while setup looks pending, a message modal shows instead, so a network blip can't trigger a re-run.
- **Fixed in passing:** a message modal (settings failed, or Stage 1's "needs a newer Stash") was reused as if it were the battle modal on the next open. Reuse now requires `#stash-battle-container`.
- **Fun mode removed** from `cache.ts` (sandbox), `pairs.ts`, `mainUI.ts` (badge, `sandboxScene`; animations always run and the next pair loads after 1500 ms), `screens.ts`, `sceneCard.ts`, `settingsPanel.ts`, the yml and the css. `DOCUMENTATION.md` and `README.md` still describe it (Stage 5).

### Interim behaviour until Stage 3

The modes still write `rating100` through `updateSceneRating`, so **battling during Stage 2 still changes Stash ratings**, even after choosing "Don't update". Setup itself doesn't. The setup screen's wording describes 3.0's final behaviour.

### Verified on Brian's Stash

- **Write shapes:** `sceneUpdate` and `bulkSceneUpdate` both take `custom_fields { full, partial, remove }`, where `remove` is a list of keys. Values come back as JSON numbers, decimals included (1612.5 came back as 1612.5).
- **First open:** setup shows, with no pool request (`FindScenesByRating`) before it's done.
- **Preview:** all six answer combinations give the plan's numbers and "N of 10 change" counts. Live counts on this library:
  - Percentile + Use my ratings changes 516 ratings.
  - A fresh start with either update option changes 604 (7 scenes are already at 50).
  - Straight-line + Use my ratings changes 0.
- **Use my ratings + Don't update:**
  - 11 requests, 521 scenes, about 0.5 s.
  - Every rated scene got `seed(rating)` with 10 games, and unrated scenes got nothing.
  - No `rating100` was sent, and 0 of 611 Stash ratings changed.
  - Scene 1186's `hotornot_stats` / `scene_record` survived.
- **Start at 1500 + Don't update:** one `bulkSceneUpdate` with 611 ids, all 1500 / 0 games, 0 ratings changed.
- **Interrupted setup** (requests slowed, page reloaded after 4 of 11 batches):
  - The flag wasn't saved, and setup showed again with the "already have an ELO" note.
  - The re-run fixed every scene and removed the stale ELO from the 90 unrated ones.
  - Closing and reopening Battle mid-setup kept the progress view.
- **Settings load failure (faked):** the message shows, and the next open recovers.
- **Other checks:** the Settings tab no longer has the fun mode row. Preview squares shrink without wrapping or overflowing at 640 and 375 px wide.
- **Not exercised for real:** writing Stash ratings (`writeStashRatings`, i.e. setup with Percentile or Straight-line and a non-zero count), because it rewrites Brian's ratings. It needs his go-ahead, or testing in Stage 4.
- **Library state left behind:**
  - Every `stash_battle_*` field was removed and the setup flags cleared, so the setup shows again for Brian.
  - Stash ratings are unchanged, but every scene's `updated_at` changed (bulk writes touch it even when nothing visible changes).
  - The config now has `stashRatings: "off"` and no `funMode`.
- **Screenshots in this session:** the built-in browser pane crops screenshots (device pixel ratio 1.25), so layout was checked with DOM measurements instead. Also hide the page behind the modal (`body > *:not(#sb-modal) { visibility: hidden }`), because the Scenes page can show through in a screenshot.

### Feedback round 1 (after Brian tried the setup)

- **Naming:** the setup screen, the message modals and the "Pause playing video when Stash Battle opens" setting (Settings tab and yml) now say "Stash Battle".
- **Preview animation:** `showRatingPreview(container, start, stashRatings)` in `ratingPreview.ts` updates the existing preview in place. Numbers count to their new values over 400 ms (eased; a timer lands them even when the tab gets no animation frames). Fills, the "changed" outline and the greyed rows fade with CSS transitions. Both are off under `prefers-reduced-motion`. `renderRatingPreview` still returns the plain HTML string.
- **Brian ran setup with Percentile and then restored a backup.** Restoring the database doesn't restore the plugin config, so the "setup finished" flag was still set; it was cleared by hand (see the console snippet in the session). After that restore, scene 1178 reads 39 (it was 35 before testing) and 1473 reads 38 (was 42), so the backup was slightly older.
- **Plugin API ideas:** reviewed in the plan ("Plugin API ideas") and decided by Brian. The Stash page-cache refresh (`refreshStashCache`) is now part of Stage 4. The backend setup task and the rating-edit hook are not being done. The navbar `PluginApi.patch` change runs as its own session and branch from `main`, separate from `elo-mode`.

### Feedback round 2 (Stage 2 review)

- **Brian's Percentile run looked right:** ratings spread 1-100, and the rating-sorted list matched.
- **Setup wording shortened** at Brian's request (intro, option descriptions, a single note, preview caption). The warnings were left as they were.
- **The Stash settings page showed the old plugin settings** ("Fun mode", "Battle opens") even after Reload plugins. The yml on disk was right; Stash just hadn't re-read it. `mutation { reloadPlugins }` fixed it, and a page refresh shows it.
- **Another session's test deploy:** the navbar session deployed its `main`-based build (no ELO setup) into the live plugins folder while testing, then copied ours back. While that build was loaded, Stash Battle opened straight to a battle, which looked like the setup flag had been set. It hadn't been: no flag and no ELO fields.
  - **Lesson:** parallel sessions share the live Stash plugins folder. Tell Brian before another session deploys there, and reload plugins afterwards.

## What Stage 3 built

- **Battles write ELO only:**
  - Swiss and Champion share `resolveComparison` in `mainUI.ts`: two-sided `eloResult`, and both scenes get `writeElo(scene, elo, games + 1)`.
  - Placement writes once, when the scene lands: `landingElo`, with `games + battles`.
  - Nothing writes `rating100` any more. `updateSceneRating` and the cache's rating100 helpers are gone.
- **`writeElo(scene, ...)` / `clearElo(scene)`** now take the scene object. They update it and the cache right away (`setEloInCache` re-sorts the cached copies by ELO), then send the write. This replaces the old "update the cache after the write" order, so the next pair always sees the new ELO.
- **Cache:**
  - Every network fetch is sorted with `sortByElo` (Stash can't sort by a custom field).
  - `CACHE_DB_VERSION` is 2, and the upgrade deletes and recreates the store.
- **Saved sessions** (`storage.ts`): `STATE_VERSION` 3. Older saves keep only the mode (`gauntlet` becomes `placement`) and the filter params, so the pair and run start fresh.
- **State:** `gauntlet*` replaced by `championScene`, `championWins` and `championDefeated`.
- **Placement** (new pure `src/placement.ts`: `newPlacementRun`, `placementStep`, `recordPlacementResult`, `landingElo`, `bottomIndex`):
  - The search is unchanged but compares ELO.
  - Landing ELO is the midpoint of the nearest rated neighbours, or ±25 at an edge (`placementElo` in `score.ts`). The integer-gap workaround is gone.
  - **"Start from the bottom"** (`placementFromBottom`: setting, Settings row, yml):
    - The run's `fromBottom` flag is read when the run starts.
    - The first opponent is the bottom rated scene, then it gallops upward.
    - `streak` counts the wins before the first loss. The card shows "🔥 N wins" until then, and "Narrowing..." after.
    - A climb that never loses lands at #1 and gets the victory screen. Otherwise the placed screen shows the streak, rank, battles and ELO.
    - Changing the setting mid-run restarts that scene's run (`onSettingChanged` in `modal.ts`), with nothing written.
- **Champion:** winner stays on, with plain two-sided ELO every pick. The "climber keeps its rating", 100-to-99 and "beat the last opponent + 1" rules are gone.
  - **Decision made here:** an unrated scene counts as rating 0 (ELO 1000, `CHAMPION_UNRATED_RATING`), the bottom, as before. Swiss alone uses the "Unrated scene rating" setting.
- **Gauntlet removed:** the mode button, `fetchGauntletPair`, falling mode, the climb helpers, the types and the state. The Placement tooltip points Gauntlet users to the setting, and the small-pool warning names only Champion.
- **UI:**
  - Cards show `ELO 1740 · #50` and a "Stash Rating: 74/100" line. Unrated scenes show the ELO they count as, in the same order: `ELO 1500 · Unrated` in Swiss (from the setting), `ELO 1000 · Unrated` in Champion (`CHAMPION_UNRATED_RATING`, now in `constants.ts`), and plain `Unrated` in Placement.
  - Animations count whole ELO points.
  - End screens show the final ELO. The victory text reads "Reached the top: N wins in a row!"
- **`elo.ts`:** the pre-3.0 1-100 functions are deleted. `roundElo` is exported.
- **Small safety fix:** the Swiss opponent search could loop forever on a pool with only the scene itself; it now stops once it has covered the pool.

### Stage 1 bug fixed here

`eloResult` took the loser's points as K × (the winner's win chance) instead of K × (1 − the winner's win chance). That's only correct when both chances are 50%. A favourite losing an upset was let off lightly, and an underdog losing was over-punished. It was spotted in the first live Swiss pick (1900 beat 1920: +12.7 / −11.3; it should be −12.7). Fixed, and tests now cover the loser's side and zero-sum at any gap.

### Verified on Brian's Stash

Testing used Brian's real setup from 21:27 (Use my ratings + Percentile). Every scene's ELO and games were snapshotted first and restored afterwards, so the 9 battled scenes are back exactly. Stash ratings didn't change at any point.

- **Swiss:** each pick writes two `SceneUpdate`s with `custom_fields.partial` only. 1520 vs 1520 moved ±12 (K 24). The overlay counts ELO.
- **Champion:**
  - The challenger started against #521 (ELO 1010) and gained 0.3 while the bottom scene lost 0.3.
  - The streak badge counted 1 and 2.
  - A 1820 challenger beat the 1812.6 champion and took over, with a streak of 1.
- **Placement:** the 1801 scene landed at #144 between 1810 and 1800, at ELO 1805, after 5 battles. Its games went 13 → 18, and that was the only write.
- **Start from the bottom:**
  - The first opponent was the bottom scene (#520).
  - The streak went 1/2/3, with jumps #520 → #518 → #516 → #511.
  - Toggling it off and on mid-run restarted the same scene, with no writes.
  - 11 straight wins gave the victory screen, ELO 2025 and games 10 → 21, as one write.
- **Other checks:**
  - A saved `gauntlet` session opened as Placement and re-saved as version 3.
  - The cache DB is at version 2.
  - Battles from a scene page work in Placement and Swiss.
  - A filtered pool (20 scenes) paired an unrated scene ("counts as 1500") against a 1490.
  - Cards fit at 375 px.
- **Simulated battle counts** (600-scene pool, `tests/placement.test.ts` and a one-off script):
  - "Start from the bottom" takes 8 battles near the bottom, 18 in the middle and near the top, and 11 to beat the top. The average over all slots is 16.2, and the maximum is 18.
  - Normal Placement takes 2 battles for a correctly rated scene and 9-10 for an unrated one.
- **Tests:** 26 unit tests pass.

### Stage 3 review feedback (applied)

- **End-screen scrollbar flash (pre-3.0 bug):** the end screens slid in from 20 px lower over 0.5 s. With the Skip/Refresh bar hidden, the end screen sits flush with the window's bottom, so the slide overflowed by exactly 20 px and showed a scrollbar for half a second. They now use the cards' entry animation (`fadeIn`, 0.3 s). While an end screen shows, the battle area has `overflow: clip` (`.sb-comparison-area:has(> .sb-end-screen)`), so the slide's last 20 px is clipped instead of growing the page; measured 0 overflow on the first frame. (On the way, Brian tried no animation, then asked for the card-style one.) The pair cards still use the sliding `fadeIn` (0.3 s); they weren't reported.
- **End screens:** no more glow (the headline's `text-shadow` and the image frame's `box-shadow`). The gold border stays.
- **Cards:** "Stash Rating:" is capitalised.
- **Placement tooltip:** dropped "Only its ELO changes, once at the end." The Gauntlet pointer comes after a blank line: the tooltip CSS is `white-space: pre-line`, and the touch ⓘ text turns `\n` into `<br>`.

- **Phones:** the mode emojis show again. The ≤400 px rule that hid them was there so four modes fit; three modes fit at 320 px with emojis, measured. The stacked-card gap is 18 px (was 8 px), so the 21 px VS badge has 8 px clear of each card instead of overlapping them by 2-3 px.

- **Placement jump cap** (Brian's request, after seeing a "Start from the bottom" run leap to #1 after 9 wins):
  - The doubling jump is capped at 10% of the pool, but at least 4 ranks (`PLACEMENT_MAX_JUMP_SHARE`, `PLACEMENT_MIN_MAX_JUMP`, `maxPlacementJump`).
  - A jump that would pass the search range halves the range instead of landing on its end.
  - It applies to normal Placement too.
  - Measured on a 600-scene pool: an average "Start from the bottom" run takes 17.0 battles (was 16.2) and the longest 21 (was 18). Beating #1 takes 21 wins (was 11). Normal Placement is unchanged (2 / 9-10).
  - Live: opponents went 520 → 519 → 516 → 510 → 501 → 486 → 454 → 387 → 327 → 276 → 222 → 167 → 114 → 59 → 22. A rank gap can exceed the cap by the size of a tied-ELO group, because the jump starts from the far end of the tie.
- **Settings tab:** the "Unrated scene rating" box is right-aligned with the switches and uses the modal's dark palette (`#121212`, `#444` border, primary-colour border on focus, no inset shadow) instead of Stash's blue-grey inputs. (Brian tried the Skip buttons' grey and went back to dark, because grey didn't read as an input box.)
- **Winning card and VS text:** no glows. The winning card's green `box-shadow` and the VS text's red `text-shadow` are gone; the green border and the red VS colour stay.

### Interim until Stage 4

Brian's setup chose Percentile, but per-battle Stash rating sync is Stage 4. Until then, battles change ELO only, and the Stash ratings written at setup slowly drift from the ELO order.

## What Stage 4 built

- **Per-battle sync** (`rating.ts`):
  - `writeElo` / `clearElo` call `scheduleStashRatingSync()` (debounced 500 ms, so a pick's two writes share one sync; skipped on "off").
  - `syncStashRatings()` works out the targets for the whole all-scenes cache (`stashRatingChanges`) and writes only the scenes whose cached `rating100` differs, via `writeStashRatings` (one request, one aliased `bulkSceneUpdate` per value).
  - `applyStashRatings()` then updates the cached `rating100` (`setRatingsInCache`) and Stash's page cache.
- **Stash's page cache** (`refreshStashCache` in `graphql.ts`, types in `pluginApi.ts`):
  - Uses `PluginApi.utils.StashService.getClient().cache`.
  - Every ELO write `modify`s the scene's cached `custom_fields`; every rating write `modify`s `rating100` and evicts `ROOT_QUERY.findScenes` (then `gc`), so lists re-sort.
  - Setup and Reset ELO mirror their writes too. It quietly does nothing if the client isn't there.
- **Settings tab, new "ELO" section:**
  - **"Stash ratings" dropdown** (`<select data-setting>`; `syncSettingsControls` covers selects). The row's description follows the selected option. The option texts live in `ui/stashRatingsText.ts`, shared with the setup screen.
  - **Switching:** `bindSettingsControls` takes a `beforeChange` hook. The modal's `confirmSettingChange`:
    - fetches the library fresh (`fetchSetupScenes`) and counts the changes;
    - switches without a warning when that count is 0, or when switching to "off";
    - otherwise opens the confirmation dialog, whose action runs the full sync. Cancel or Escape puts the dropdown back.
  - **Reset ELO button:** confirmation, then the setup screen in reset mode (`showSetupScreen(..., { reset, onCancel })`):
    - "Reset ELO" title and intro, the current Stash ratings option preselected, and a Cancel button.
    - `state.resettingElo` keeps battles paused (`isEloSetupPending`). Closing Stash Battle before Start cancels the reset.
    - Pressing Start clears the saved "setup finished" flag first, so an interrupted reset asks again on the next open.
- **Confirmation dialog** (`ui/confirmDialog.ts`): inside the modal. It runs an async action with a "working" button state and shows errors in place. The modal's key handler gives Escape to it (`isConfirmDialogOpen` / `cancelConfirmDialog`).
- **Battle tab note:** "Stash ratings aren't being changed · change in Settings" (`#sb-ratings-note`, `updateRatingsNote`), shown on "off". The link opens Settings.
- **Narrow screens:** the dropdown and Reset rows stack. The Reset button lines up with the other controls (overriding Stash's `.setting > div:last-child .btn` right margin).
- **Setup summary:** "Stash ratings already matched (…), so none changed" when a sync had nothing to write.
- **Tests:** `tests/sync.test.ts` covers the sync (fake Stash: only changed ratings, grouped by value, one request, nothing on "off", nothing on a second run) and the page-cache refresh (fake Apollo). 31 tests pass.

### Verified on Brian's Stash

Testing started from Brian's real state (Percentile, the 21:27 setup). Every scene's rating, ELO and games, plus the plugin config, were snapshotted first, then restored exactly: 523 ELOs and 271 ratings put back, 0 scenes differ, and the config is identical.

- **Settings:** the "ELO" section comes first, showing the "Stash ratings" dropdown on Percentile with its description and "Reset ELO…". The Battle tab note is hidden on Percentile.
- **Percentile, per battle:**
  - The first Swiss pick wrote the 2 ELOs plus one `SyncStashRatings` request for 314 scenes in 74 groups. That was a catch-up: Stage 3 battles had moved ELO without syncing, and 5 scenes had an ELO but no rating.
  - The next pick synced 48 scenes in 9 groups. **Why so many:** 436 of 527 rated scenes share their ELO with others (seeded ties, groups of up to 22), and a tie group shares its middle rank. When a battled scene leaves or joins a group, the whole group's rating can move by 1. This fades as battles spread ELO; Brian chose to keep this rule (see below).
- **Switching to Straight-line:**
  - The dialog said "518 Stash ratings change now". Escape cancelled it, put the dropdown back and wrote nothing.
  - Confirming sent one request for 518 scenes plus the settings save. All 527 rated scenes then matched `linearRating(elo)`.
  - Stash's Apollo cache: 0 of the 40 cached scenes were stale.
- **"Don't update":** no dialog; only the settings save. The note appeared, its link opened Settings, and a pick wrote ELO only.
- **Back to Percentile:** the dialog showed again, one request updated 518 scenes, and all 527 matched the percentile mapping (top 100, bottom 1).
- **Reset ELO:**
  - Cancelling the dialog, cancelling the reset screen, and closing Stash Battle mid-reset all wrote nothing.
  - A real reset (Use my ratings + Percentile):
    1. the flag was cleared;
    2. `SeedElo` ×11;
    3. the flag was saved again;
    4. all 527 scenes were seeded from their rating with 10 games, and none was left with an ELO but no rating;
    5. 0 ratings changed, because they were already percentile values.
  - The "Before 3.0" note doesn't show on a reset.

### Stage 4 review feedback (applied)

- **Dropdown:** renamed to "Stash ratings update mode" (row, aria-label, dialog title). It has a drawn chevron, because Stash sets `appearance: none` on selects; the dark rule uses `background-color` so the chevron isn't wiped.
- **"Unrated scene rating" removed** (Brian, Oct 22). It's gone from `Settings`, the defaults, `normalize()` (a stored value is dropped on the next save), the Settings tab, the yml and the CSS.
  - `effectiveElo(scene, unratedElo = ELO_START)` now takes an ELO.
  - Swiss counts unrated scenes as 1500; Champion as `CHAMPION_UNRATED_ELO` (1000, the bottom).
  - Unrated cards read `ELO 1500 · Unrated` in Swiss and `ELO 1000 · Unrated` in Champion.
- **Brian ran Reset ELO himself at 22:36** (Use my ratings + Percentile). All 611 scenes now have an ELO.

### New per-scene fields (Brian, Oct 22)

`stash_battle_games` mixed real battles with the seeded head start of 10, so it couldn't be shown as a battle count.

- **Now:** `stash_battle_battles` (real battles) and `stash_battle_seeded` (`EloFields` in types; `ELO_FIELD_KEYS` for removal). K comes from `kGames` = battles + `SEEDED_HEAD_START` (10) if seeded, and is never stored, so retuning applies to everyone.
- **Every write sends all three fields:** `eloCustomFields()`. `writeElo(scene, elo, battles)` keeps the scene's seeded flag.
- **Stash stores `true` as `1`** (and presumably `false` as `0`). `isSeeded` accepts true/1/"true"/"1".
- **Cards** show "Battles: N" under Play Count, hidden where Play Count is hidden.
- **Brian's library was converted in place:**
  - Every scene had `games >= 10` after his 22:36 "Use my ratings" reset, so all 611 became `seeded: 1, battles: games - 10`, and `stash_battle_games` was removed. That's 546 scenes at 0 battles, the rest at 1-6.
  - ELO and Stash ratings were untouched, and verified.
  - A combined `partial` + `remove` in one `custom_fields` input works.
- **Live check:** two seeded scenes at 1500 with 0 battles moved ±12 (K 24, so the head start works), and each went to 1 battle. Those 2 scenes and the 3 synced ratings were restored afterwards.
- **No migration code:** 3.0 is unreleased, so only this library ever had the old field.

### Decided: tied scenes keep sharing the middle rating

Seeded ELOs tie a lot, so early Percentile syncs rewrite a whole tie group when one member moves (48 scenes on the second live pick). A tie-break (for example by previous Stash rating, then id) would have cut that to the scenes actually passed, but a fresh start would then show an arbitrary 100-1 spread instead of 50 everywhere. **Brian chose to keep the plan's rule** (Oct 22): the extra writes fade as battles break the ties.

## What Stage 5 built

- **Docs:** `DOCUMENTATION.md` is rewritten for 3.0: the ELO system, setup and Reset ELO, the update modes, the modes, the cards, the navbar patch, and pitfalls including the corner-rendering fixes. The `README.md` has Requirements (Stash v0.31.0+, confirmed on the [v0.31.0 release notes](https://github.com/stashapp/stash/releases/tag/v0.31.0): "Custom field support has been added to scenes"), features, How It Works with the new K table, and the star-edit warning. The `CHANGELOG.md` v3.0.0 entry opens with "Before you update".
- **Version** 3.0.0 in `package.json` and the yml.
- **Screenshots** (`docs/screenshots/`): `battle.jpg`, `setup.png` (new), `placement.png`, `champion.png` and `settings.png`, all 764 px wide.
  - The browser tool caps captures at about 800 px wide, so they were taken with an emulated 1040x960 viewport. That's above the 1000 px and 900 px-height compact-layout cut-offs, so Play Count, Battles and Tags show.
  - Content guard: hide `img`/`video` and the page behind the modal, plus a `MutationObserver` that rewrites titles, studios, performers and tags to placeholders on every render. **Reinstall it after every page reload**: two slips happened when a reload dropped it, and both files were deleted.
  - The setup shot was taken by temporarily removing `eloSetupAt` from the config (restored right after), with the re-run note hidden.
  - Placement writes nothing mid-run. Champion's two picks were restored from a snapshot (3 scenes, 2 ratings, config identical).
- **Forum drafts** (`docs/forum/`, not committed): `update-3.0.md` (a reply in the style of post #73) and `op-3.0.md` (the full OP, with `UPLOAD_*` placeholders for the new images; the two navbar `upload://` images are reused). Thread: https://discourse.stashapp.cc/t/stash-battle/5180.
- **Corner fixes during Stage 5** (Brian's bug report): the card border is now a `::after` drawn on top, and the thumbnail, image and video have 12px top corners. See DOCUMENTATION Pitfalls 13.

## Open follow-ups

- **Custom-field filters:** `filters.ts` doesn't translate Stash's `custom_fields` criteria, so a Scenes-page filter on `stash_battle_elo` probably doesn't carry into Stash Battle. Untested; documented as such.
- **SFW Switch:** after [stashapp/CommunityScripts#800](https://github.com/stashapp/CommunityScripts/pull/800) merges, remove the `pwr-*` classes and the "SFW Switch compatibility" note.

## Gotchas for later work

- **Keep the plugin working at every checkpoint.**
  - The modes keep using rating100 until Stage 3, so Stage 2 adds `writeElo` / `clearElo` alongside `updateSceneRating` rather than replacing it.
  - Removing fun mode in Stage 2 touches `cache.ts` (sandbox), `rating.ts` (`ratingsEnabled`), `mainUI.ts` (fun badge, animations), `screens.ts` ("not saved" notes), `modal.ts` (`onSettingChanged` case and `resetSandbox` calls), `constants.ts`, `types.ts`, `settings.ts`, `settingsPanel.ts` and the yml.
- **Saved-session scenes:** `writeElo` updates the scene object it's given and the cache copies. A champion restored from localStorage is a separate object, which is why the scene is passed in and not just its id.
- **Sync relies on the all-scenes cache's `rating100`:** after a full sync it's updated in memory, but the IndexedDB copy isn't. A reload within the cache's 5 minutes can make the first sync rewrite a few ratings to the same values (harmless, but it touches `updated_at`).
- **Stage 5 docs:** `DOCUMENTATION.md` still describes fun mode, Gauntlet and rating100 ELO. The README needs the minimum Stash version (scene custom fields) and a note that star edits are overwritten while Stash ratings are being updated.
- **Reset ELO (Stage 4)** can reuse `showSetupScreen` as is, and `runEloSetup` already removes stale ELO under "Use my ratings". The "Before 3.0..." note is hidden once `eloSetupAt` is set, so Reset ELO should clear the flag only after its confirmation.
- **The Settings tab has no `<select>` control yet** (`settingControl` in `settingsPanel.ts` only does checkboxes and the number box). Stage 4 adds one. `stashRatings` stays out of the yml, because Stash's plugin settings page has no dropdown type.
- **Opening Battle in automation:** the nav link is an `<a>` whose text is exactly "Battle". To log GraphQL traffic, wrap `window.fetch` and record each request's operation name, whether it's a mutation, and any errors.
- **Screenshots:** `browser_take_screenshot` downscales. For exact sizes, use CDP `Emulation.setDeviceMetricsOverride` (1280x960, because card tags hide below 900px of height) plus `Page.captureScreenshot` with a clip, and clear the emulation afterwards.

## Other open items (outside the ELO plan)

- **SFW Switch:** after [stashapp/CommunityScripts#800](https://github.com/stashapp/CommunityScripts/pull/800) merges, remove the `pwr-*` classes and their comment from `src/ui/sceneCard.ts`, and the "SFW Switch compatibility" note in `DOCUMENTATION.md`.
- **Minimum Stash version:** look up which Stash version added scene custom fields, for the README (Stage 5).

## Previous session

The full discussion behind every decision is in the agent transcript `6569f1e6-9801-45d9-80c3-6cdd00953842`.
