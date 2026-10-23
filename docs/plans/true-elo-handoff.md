# Handoff: 3.0 true ELO rework

Pick-up notes for continuing the work in [true-elo-mode.md](true-elo-mode.md) in a new agent session. Read the plan first; this file covers status, conventions and gotchas.

## Status (Oct 22, 2026)

| Stage | State |
|---|---|
| 1. ELO core | Done, reviewed, committed. |
| 2. Write path + setup screen, remove fun mode | Done, reviewed, committed. |
| 3. Modes/cache/UI onto ELO, Gauntlet becomes Placement's "Start from the bottom" | Done, reviewed, committed. Brian's go for Stage 4 is still needed. |
| 4. "Stash ratings" dropdown + sync, Reset ELO, Stash page-cache refresh | Not started |
| 5. Docs, CHANGELOG, version 3.0.0 | Not started |

- **Branch:** `elo-mode`, created from `main` at `d3e740f`.
- **Commits:** Stages 1, 2 and 3 are separate commits on `elo-mode` (plus Stage 2's review polish and the navbar merge). None is pushed.
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
- **`src/rating.ts`:** `ratingsEnabled` removed. New `writeElo(id, elo, games)` and `clearElo(id)`: one `sceneUpdate`, custom fields only, with the cached objects updated via `setEloInCache` (no re-sort). New `writeStashRatings(map)`: one request, one aliased `bulkSceneUpdate` per distinct value. Stage 4's debounced `syncStashRatings` should wrap it. `updateSceneRating` stays for the modes.
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

## Gotchas for Stage 4 onward

- **Keep the plugin working at every checkpoint.**
  - The modes keep using rating100 until Stage 3, so Stage 2 adds `writeElo` / `clearElo` alongside `updateSceneRating` rather than replacing it.
  - Removing fun mode in Stage 2 touches `cache.ts` (sandbox), `rating.ts` (`ratingsEnabled`), `mainUI.ts` (fun badge, animations), `screens.ts` ("not saved" notes), `modal.ts` (`onSettingChanged` case and `resetSandbox` calls), `constants.ts`, `types.ts`, `settings.ts`, `settingsPanel.ts` and the yml.
- **Per-battle sync:** `resolveComparison` fires both `writeElo`s without awaiting them. `syncStashRatings` should be debounced after them, and it should also update the cached scenes' `rating100` (nothing does that any more), plus `refreshStashCache` for Stash's own pages.
- **Saved-session scenes:** `writeElo` updates the scene object it's given and the cache copies. A champion restored from localStorage is a separate object, which is why the scene is passed in and not just its id.
- **Reset ELO (Stage 4)** can reuse `showSetupScreen` as is, and `runEloSetup` already removes stale ELO under "Use my ratings". The "Before 3.0..." note is hidden once `eloSetupAt` is set, so Reset ELO should clear the flag only after its confirmation.
- **The Settings tab has no `<select>` control yet** (`settingControl` in `settingsPanel.ts` only does checkboxes and the number box). Stage 4 adds one. `stashRatings` stays out of the yml, because Stash's plugin settings page has no dropdown type.
- **Opening Battle in automation:** the nav link is an `<a>` whose text is exactly "Battle". To log GraphQL traffic, wrap `window.fetch` and record each request's operation name, whether it's a mutation, and any errors.
- **Screenshots:** `browser_take_screenshot` downscales. For exact sizes, use CDP `Emulation.setDeviceMetricsOverride` (1280x960, because card tags hide below 900px of height) plus `Page.captureScreenshot` with a clip, and clear the emulation afterwards.

## Other open items (outside the ELO plan)

- **SFW Switch:** after [stashapp/CommunityScripts#800](https://github.com/stashapp/CommunityScripts/pull/800) merges, remove the `pwr-*` classes and their comment from `src/ui/sceneCard.ts`, and the "SFW Switch compatibility" note in `DOCUMENTATION.md`.
- **Minimum Stash version:** look up which Stash version added scene custom fields, for the README (Stage 5).

## Previous session

The full discussion behind every decision is in the agent transcript `6569f1e6-9801-45d9-80c3-6cdd00953842`.
