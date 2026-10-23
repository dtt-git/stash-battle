# Stash Battle — Technical Documentation

> For LLM agents and contributors working on the plugin. This documents the nuanced behavior, architecture, and design decisions that aren't obvious from the code alone.

## ⚠️ Keeping This Document Up To Date

**This file must be updated whenever you change behavior in the plugin.** If you modify ELO logic, scene pool filtering, mode behavior, caching, UI components, or any other documented behavior, update the relevant section here in the same changeset.

When adding new features or fixing bugs:
1. Update any existing sections that are affected by your change
2. If the change introduces a subtle edge case or non-obvious behavior, add it to the **Common Pitfalls & Edge Cases** section
3. If you add a new mode, config option, or major feature, add a new section for it

If you're an LLM agent: read this file before making changes to understand existing behavior, and update it after making changes to keep it accurate.

---

## Architecture Overview

The plugin is authored in **strict TypeScript** under [`src/`](src/) and bundled by **esbuild** into a single IIFE at `plugins/stash-battle/stash-battle.js` — which is the file Stash actually injects into its UI (alongside a CSS file and a YAML manifest). The committed `stash-battle.js` is a **build artifact**; never edit it by hand — edit the TypeScript modules and rebuild. The plugin adds a "Battle" button to Stash's navbar that opens a modal where users compare scenes head-to-head to build rankings with a true ELO system.

> The bundle output must remain a single IIFE with no `import`/`export`, because the distribution path (`stash-battle.yml` → `build_site.sh` → GitHub Pages index) ships exactly the files in `plugins/stash-battle/`. esbuild's `format: "iife"` guarantees this.

**Requires Stash v0.31.0 or newer**: scene custom fields (where ELO is stored) were added in [v0.31.0](https://github.com/stashapp/stash/releases/tag/v0.31.0). `sceneCustomFieldsSupported()` checks by introspection on every open and shows a "needs a newer Stash" message instead of loading.

### Entry Flow

1. `init()` fires on `DOMContentLoaded`: `registerDeleteDialogBridge()`, `registerNavButton()` and `registerSceneElo(openModal)`
2. **Nav button** (`ui/navButton.ts`): where Stash has the plugin patch API, a `BattleNavItem` React component is patched into `MainNavBar.MenuItems` with `PluginApi.patch.before` (after Stash's own page links). It reads the route on every render and re-renders on `PluginApi.Event`'s `stash:location`, showing only on `/`, `/scenes` and `/scenes/*`. Without the patch API it falls back to injecting the button into the DOM and re-adding it from a `MutationObserver`.
3. Clicking the button calls `openModal()`: settings and the custom-fields check load in parallel, then either the one-time **ELO setup** shows (see ELO Setup) or the battle UI loads
4. **Scene page ELO** (`ui/sceneElo.ts`): on `/scenes/:id`, an item (`.sb-scene-elo`) goes into `.scene-toolbar`, in front of Play Count: a single Stash `minimal btn btn-secondary` button holding the swords (from `ui/icons.ts`, shared with the navbar) and `ELO 1740 · #50`, so the icon and text highlight together; its padding and gap match the count buttons next to it. ScenePage isn't a patchable component, so it's DOM injection, re-added from a `MutationObserver` (batched with a 50 ms timer; animation frames don't run in background tabs) whenever React re-renders the toolbar. ELO and rank come from `getAllScenesCached()` (index in the ELO-sorted cache, the same as the cards; a scene newer than the cache is fetched, without a rank). Stash's own custom-field filter can't do the count: in v0.31.1 numeric comparisons don't match (Common Pitfalls #19). Clicking it calls `openModal()`; `closeModal()` calls `refreshSceneElo()` so it shows the new ELO.
5. If opened from an individual scene page (`/scenes/123`), the scene is forced onto the left side of a new battle — unless it's already one of the two scenes in the current pair, in which case the existing pair is restored

### Core State

All shared mutable state lives on a single `state` object exported from [`src/state.ts`](src/state.ts) (type `BattleState`). Modules read and write it as `state.currentMode`, `state.championScene`, etc.

> **Why a central object instead of module-level `let`s?** ES modules cannot reassign a binding imported from another module (`import { x }` is read-only at the importer). Every value that is *reassigned* from more than one module lives on a shared object. Values that are only mutated within one module stay local to it (e.g. `lastShownSceneId` in `pairs.ts`, `modalKeyHandler` in `ui/modal.ts`).

Key fields:

| Field | Purpose |
|---|---|
| `state.currentPair` | `{ left, right }` — the two scenes currently displayed |
| `state.currentRanks` | `{ left, right }` — rank positions for display |
| `state.currentMode` | `"swiss"`, `"placement"` or `"champion"` |
| `state.championScene` | Champion mode: the scene defending (winner stays on) |
| `state.championWins` | Its current win streak |
| `state.championDefeated` | IDs of scenes it has beaten this run (no rematches) |
| `state.placement` | The in-progress Placement run (`PlacementRun`), or `null` — see Placement Mode |
| `state.totalScenesCount` | Size of the opponent pool (used for "Rank #X of Y" display) |
| `state.leftPoolSize` | Size of the left ("to rate") pool — filter or whole library — for the status line; `null` until pools load |
| `state.settings` | User settings (`Settings` in `types.ts`), loaded from Stash's plugin config — see Settings |
| `state.resettingElo` | Reset ELO's setup screen is showing (battles wait, like a first setup) |
| `state.memoryCache` | In-memory scene cache (see Caching Strategy) |
| `state.shuffledFilteredScenes` / `state.shuffleIndex` / `state.shuffleFilterKey` | Filtered-pool shuffle traversal |

Helpers in `state.ts`: `resetRunState()` clears Champion **and** Placement run fields between runs; `resetShuffle()` forgets the left-side shuffle; `isRunActive()` says whether a run is under way (Skip is disabled while it is); `isEloSetupPending()` is true until setup has finished (`eloSetupAt` set) and while Reset ELO is showing.

---

## Project Structure & Build

### Source layout (`src/`)

| Module | Responsibility |
|---|---|
| `types.ts` | Shared types: `Scene` (mirrors `SCENE_FRAGMENT`), `EloFields`, `Mode`, `Settings`, `StashRatingsMode`, `EloStart`, `PlacementRun`, `Pair`, `Ranks`, GraphQL response shapes, pair-result shapes |
| `constants.ts` | Cache/storage keys, `DEFAULT_SETTINGS`, ELO constants (`ELO_START`, `ELO_DIVISOR`, `ELO_K_TIERS`, `SEEDED_HEAD_START`, `ELO_PER_RATING_POINT`), custom field keys (`ELO_FIELD`, `BATTLES_FIELD`, `SEEDED_FIELD`, `ELO_FIELD_KEYS`), Placement (`PLACEMENT_EDGE_GAP`, `PLACEMENT_MAX_JUMP_SHARE`, `PLACEMENT_MIN_MAX_JUMP`), Champion (`CHAMPION_UNRATED_ELO`, `CLIMB_OPPONENT_PICK_WINDOW`, `CLIMB_SMALL_POOL_WARN_AT`), Swiss reach |
| `state.ts` | Central mutable `state` object + `resetRunState()`, `resetShuffle()`, `isRunActive()`, `isEloSetupPending()` |
| `settings.ts` | `loadSettings` / `updateSettings` / `updateSettingsNow` — settings in Stash plugin config (`configurePlugin`), `hadFunMode()` |
| `elo.ts` | Pure ELO math: `eloKFactor`, `eloExpected`, `eloResult`, `roundElo` |
| `score.ts` | Pure: a scene's ELO fields (`elo`, `isRated`, `battles`, `isSeeded`, `kGames`, `eloCustomFields`), `seed`, `effectiveElo`, ELO ↔ Stash rating (`linearRating`, `percentileRatings`, `stashRatingTargets`, `stashRatingChanges`), setup (`startingElo`, `afterSetup`), ordering (`compareByElo`, `sortByElo`, `eloInsertionIndex`), `placementElo` |
| `placement.ts` | Pure Placement search: `newPlacementRun`, `placementStep`, `recordPlacementResult`, `landingElo`, `bottomIndex`, `maxPlacementJump` |
| `graphql.ts` | `graphqlQuery`, `SCENE_FRAGMENT`, `FIND_SCENES_QUERY`, `fetchSceneById`, `getSceneIdFromUrl`, `sceneCustomFieldsSupported`, `refreshStashCache` (Stash's Apollo cache) |
| `pluginApi.ts` | Minimal typing of `window.PluginApi` (React, patch, components, Event, StashService's Apollo client) |
| `cache.ts` | IndexedDB + memory cache, stale-while-revalidate, sorted by ELO; `setEloInCache`, `setRatingsInCache`, `removeSceneEverywhere` |
| `storage.ts` | `saveState` / `loadState` / `clearState` (localStorage, versioned) |
| `filters.ts` | URL filter parsing (`getSceneFilter`, `translateJSON`), `getFindFilter`, `readFilters`, `buildFilterKey`, `checkForFilters` |
| `navigation.ts` | `navigateToUrl` (History API + popstate for React Router) |
| `pairs.ts` | Matchmaking: `fetchSwissPair`, `fetchPlacementPair`, `fetchChampionPair`, `loadPoolSize`, filtered-pool shuffle (`getNextFilteredScene`, internal) |
| `rating.ts` | Writes: `writeElo`, `clearElo`, `writeStashRatings`, `applyStashRatings`, `queueRatingWrite`, `scheduleStashRatingSync` / `syncStashRatings`, `SCENE_MISSING_EVENT` |
| `eloSetup.ts` | One-time ELO setup: `fetchSetupScenes`, `setupRatingChanges`, `runEloSetup` |
| `sceneActions.ts` | `findExistingSceneIds`, `isSceneNotFoundError` (deleted-scene detection) |
| `ui/sceneCard.ts` | `createSceneCard`, `formatDuration` |
| `ui/screens.ts` | `showVictoryScreen`, `showPlacementScreen` |
| `ui/mainUI.ts` | `createMainUI`, `renderPair`, `loadNewPair`, `restoreCurrentPair`, `verifyCurrentPair`, `handleSceneGone`, `skipPair`, `setActionsVisible`, `applyPreviewSettings`, `updateClimbPoolWarning`, `updateRatingsNote`, choice handling (`resolveComparison`), rating animation |
| `ui/setupScreen.ts` | The ELO setup / Reset ELO screen: `showSetupScreen`, `hideSetupScreen`, `isSetupRunning` |
| `ui/ratingPreview.ts` | The setup's 10-scene preview: `renderRatingPreview`, `showRatingPreview` (animated in place) |
| `ui/stashRatingsText.ts` | Labels and descriptions of the three Stash ratings options (shared by setup and Settings) |
| `ui/confirmDialog.ts` | In-modal confirmation dialog with an async action (`confirmDialog`, `isConfirmDialogOpen`, `cancelConfirmDialog`) |
| `ui/settingsPanel.ts` | Battle / Settings tab bar (`showTab`, `getActiveTab`), preview volume + mute button, Settings tab rows, `bindSettingsControls` / `syncSettingsControls` |
| `ui/deleteDialog.ts` | Clean mode: bridge that opens Stash's own `DeleteScenesDialog` (`registerDeleteDialogBridge`, `confirmDeleteScene`) |
| `ui/navButton.ts` | `registerNavButton`, `shouldShowNavButton` |
| `ui/sceneElo.ts` | `registerSceneElo`, `refreshSceneElo`: the ELO and rank on Stash's scene pages (toolbar) |
| `ui/icons.ts` | `SWORDS_PATHS`: the crossed swords (navbar button, scene page ELO) |
| `ui/modal.ts` | `openModal`, `closeModal`, keyboard handler, Stash ratings switch confirmation, Reset ELO |
| `main.ts` | Entry point: `init()` + `DOMContentLoaded` bootstrap |

The modules have intentional circular references (e.g. `navigation` → `modal` → `mainUI` → `screens` → `mainUI`). These are safe because every cross-module reference is a runtime function call, not a top-level access, and all exports are hoisted function declarations.

### Build tooling

- **esbuild** ([`scripts/build.mjs`](scripts/build.mjs)) bundles `src/main.ts` → `plugins/stash-battle/stash-battle.js` as an IIFE. esbuild transpiles but does **not** type-check.
- **TypeScript** ([`tsconfig.json`](tsconfig.json), `strict: true`) is used purely for type-checking via `tsc --noEmit`.
- **Tests** ([`scripts/test.mjs`](scripts/test.mjs)): Node can't run TypeScript directly, so the script bundles `tests/*.test.ts` with esbuild into `.test-build/` and runs them with Node's built-in test runner. The pure modules (`elo.ts`, `score.ts`, `placement.ts`) are tested directly; `tests/sync.test.ts` covers the Stash rating sync and the Apollo refresh with a fake `fetch` and a fake `PluginApi`.

### npm scripts

| Command | What it does |
|---|---|
| `npm run build` | Production bundle → `plugins/stash-battle/stash-battle.js` |
| `npm run dev` | Watch `src/`, rebuild on save, deploy bundle + css + yml into the live Stash plugins folder (when `STASH_PLUGINS_DIR` is set) |
| `npm run typecheck` | Strict type-check (`tsc --noEmit`) |
| `npm test` | Unit tests (`tests/*.test.ts`) |

### Dev deploy + live reload

`npm run dev` writes each rebuild straight into the live Stash plugins folder. The target is read from `STASH_PLUGINS_DIR` (set it in a gitignored `.env` — see `.env.example`), resolving to `<STASH_PLUGINS_DIR>/stash-battle`; if it's unset or `none`, deploying is skipped. `build.mjs` loads `.env` via Node's built-in `process.loadEnvFile()`, so machine-specific paths never get committed.

**No auto-reload in the browser:** Stash's CSP allows `connect-src` only to `'self'`, `data:`, `ws:`, and `wss:` — so a dev-time `EventSource` to `http://localhost:7331` (esbuild's live-reload SSE) is blocked. After each save, refresh Stash manually (F5). YAML changes (plugin settings shown on Stash's Settings → Plugins page) need **Reload plugins** there, then a refresh.

---

## The Two Sides

The battle UI always shows two scenes:

- **Left side (scene1)**: Drawn from the **filtered pool** — the scenes the user wants to rate. In Champion mode, this is the defending **champion**; in Placement, the scene being placed.
- **Right side (scene2)**: Drawn from the **opponent pool** — rated benchmarks for comparison.

This distinction is fundamental to the entire plugin.

---

## Scene Pools

### `allScenes`
All scenes in the Stash library, fetched with `per_page: -1` and **sorted client-side by ELO** (`sortByElo`: highest first, unrated last; Stash can't sort by a custom field). Fetched once and cached aggressively. Includes both rated and unrated scenes.

### `filteredScenes`
Scenes matching the current URL filter parameters (`c`, `q` params), also sorted by ELO. If no filter is active, this equals `allScenes`. Used exclusively for the **left side** — the "scenes to be rated" pool.

### `opponentPool` (right side)
Determined per-fetch in each mode function (`buildOpponentPool`):

```
if filterOpponents AND hasFilter → opponentPool = filteredScenes
else → opponentPool = allScenes with an ELO (isRated)
```

**Critical behavior**: from `allScenes`, unrated scenes (no `stash_battle_elo`) are **excluded**, so they never appear as right-side opponents. If no scene has an ELO yet, it falls back to `allScenes` including unrated.

**Exception**: When `filterOpponents` is true and a filter is active, the filtered pool is used as-is for both sides — unrated scenes may appear on the right if the filter includes them (they sort last). Intentional for filtering on unrated scenes on both sides.

### `totalScenesCount`
Set from `opponentPool.length` (not `allScenes.length`), so the "Rank #X of Y" display is consistent with the pool the ranks come from.

---

## Caching Strategy

### Three Layers

1. **Memory cache** (`memoryCache`) — instant, lives for the session
2. **IndexedDB** (`stash-battle-cache` DB, `CACHE_DB_VERSION` 2) — survives page reloads. Version 2 (3.0) deletes and recreates the store, because older entries hold scenes without custom fields, in rating order.
3. **Network** (GraphQL) — source of truth, slowest

### Stale-While-Revalidate

On cache hit, the data is returned immediately. If the cache is older than `CACHE_MAX_AGE_MS` (5 minutes), a background refresh is kicked off (not awaited) to update the cache for next time.

### Cache Keys

- `"all-scenes"` — all scenes, no filter
- `"filtered-scenes"` — single slot for filtered scenes (overwrites on filter change to prevent IndexedDB bloat)

### `filterKey`

A JSON string of the current filter parameters. Stored alongside the filtered cache to detect when the filter has changed and the cache is stale.

### Keeping the cache current

- **`setEloInCache(scene, fields | null)`** (called by `writeElo` / `clearElo` *before* the network write) sets the ELO fields on the scene object it's given and on its cached copies in **both** `allScenes` and `filteredScenes`, and moves the cached copies to their new place in the ELO order (`eloInsertionIndex`; unrated to the end). The scene object is passed (not just an id) because a scene restored from localStorage, like a saved champion, is a different object from the cached one. If the write fails, the old fields are put back (unless a later write has replaced them since).
- **`latestScene(scene)`** returns the cached copy (all scenes, then filtered), or the scene itself. Objects held across battles (the Swiss shuffle, a saved pair, a Champion or Placement run) go stale once a background refresh swaps in new copies, so battle math (`resolveComparison`, Placement's landing) reads ELO and battles through it, and the Swiss left scene is taken from the current pool by id.
- **`setRatingsInCache(map)`** sets `rating100` on cached scenes after Stash Battle wrote Stash ratings (order is ELO, so it doesn't move).
- Neither updates the IndexedDB copy; it refreshes within 5 minutes.

---

## Filtered Pool Management

### Shuffled Traversal

Filtered scenes are shuffled (Fisher-Yates) and traversed sequentially via `shuffleIndex`. This ensures every scene is shown once before any repeat. The shuffle is invalidated when the filter changes (`shuffleFilterKey` check).

### Pool Recycling (scenes stay in the pool)

Battled scenes are **not** removed from the filtered pool — every scene stays available on both sides, and the shuffle simply starts a new pass when it reaches the end.

At the end of each full pass (`isShuffleCycleComplete` in `pairs.ts`), `loadScenePools` clears the filtered cache and **re-queries the filter from Stash** before reshuffling, so filters whose membership changes as you battle (e.g. on rating while Stash ratings are being updated) shrink once per pass. The next pass is started (`startNewPass`) right after that re-query, so loads that don't pick a new left scene (later picks of a Champion/Placement run, `loadPoolSize`) don't see the pass as complete again.

---

## ELO System

### What's stored (scene custom fields)

Stash Battle keeps its own score in Stash's **scene custom fields** (Stash v0.31.0+). Every write uses `custom_fields.partial` (or `remove` with our keys), so other plugins' fields on the same scene are never touched.

| Field | Meaning |
|---|---|
| `stash_battle_elo` | The scene's ELO (one decimal place, uncapped). No field = unrated. |
| `stash_battle_battles` | Real battles that moved this scene's ELO. Shown on cards as "Battles: N". |
| `stash_battle_seeded` | True when the starting ELO came from the scene's Stash rating (setup's "Use my ratings"). **Stash stores `true` as `1`**, so `isSeeded` accepts true/1/"true"/"1". "Start everyone at 1500" writes false. |

`EloFields` (`types.ts`) is this triple; `eloCustomFields()` turns it into the map Stash stores, and every write sends all three. `ELO_FIELD_KEYS` lists them for removal.

### ELO math (`elo.ts`)

- Standard scale: start `ELO_START` 1500, divisor `ELO_DIVISOR` 400, **no clamp**.
- `eloExpected(a, b) = 1 / (1 + 10^((b − a) / 400))`.
- `eloResult(winner, loser)`: each side moves by **its own K × (1 − winner's expected score)** — the winner up, the loser down. With equal K the points are exactly zero-sum. Rounded to one decimal (`roundElo`).
- **K is never stored.** It comes from `kGames` (`score.ts`) = `battles` + `SEEDED_HEAD_START` (10) if seeded, through `ELO_K_TIERS`:

| kGames | K |
|---|---|
| < 10 | 40 — new scenes find their level fast |
| < 30 | 24 |
| ≥ 30 | 16 |

Seeded scenes skip the K 40 stage: their Stash rating already says something. Because K is worked out, retuning the tiers or the head start applies to every scene immediately.

### Where battles and K apply

- **Swiss and Champion** use K: both scenes' ELO change every pick (`resolveComparison` in `mainUI.ts`), and both get `battles + 1`.
- **Placement** never uses K: it sets the placed scene's ELO directly from its neighbours when the run lands, and adds the run's battle count to the scene's `battles`. Opponents don't change.
- Stash's `play_count` plays no part.

### Unrated scenes

Scenes without `stash_battle_elo` count as **1500** in Swiss (`effectiveElo(scene)` with the default) and as **`CHAMPION_UNRATED_ELO` (1000, the bottom)** in Champion, so a newcomer climbs from the bottom there. Swiss matchmaking places an unrated left scene where 1500 would sit in the sorted pool. A scene becomes rated on its first battle.

### Seed: Stash rating → ELO

`seed(r) = 1500 + (r − 50) × 10`, mapping 1-100 onto 1010-2000 (`ELO_PER_RATING_POINT` = 10). The pre-3.0 math divided by 40 on the 1-100 scale, so one rating point already meant 10 standard ELO points: seeding at 10 keeps every win chance the old system predicted.

### ELO → Stash rating (only when "Stash ratings update mode" isn't off)

Both in `score.ts`; only scenes **with an ELO** are ever written.

- **Straight-line** (`linearRating`): `clamp(round(50 + (elo − 1500) / 10), 1, 100)`, the exact inverse of `seed` — after "Use my ratings" every scene converts back to its own rating. 1995+ shows 100 and 1014− shows 1.
- **Percentile** (`percentileRatings`): `rating = 100 − round(99 × i / (N − 1))`, where `i` is the scene's position in the ELO ranking of the **whole library** (0 = top) and `N` the number of scenes with an ELO. Tied scenes share the **middle position** of their tie group, so a fully tied library (a fresh start) is 50 everywhere; a single scene is 50. Rounding inside the bracket keeps a middle tie at 50, not 51.
- `stashRatingTargets(scenes, mode)` gives every target; `stashRatingChanges(scenes, mode)` only the ones that differ from the scene's current `rating100`.

---

## ELO Setup (first open) and Reset ELO

**When:** `openModal()` shows `ui/setupScreen.ts` in the Battle tab instead of the battle while `isEloSetupPending()` (no `eloSetupAt` in the plugin config). The Battle panel gets `sb-setup-active`, which hides every other child (modes, cards, actions); `loadNewPair` / `restoreCurrentPair` return early and the battle shortcuts are off, so no pool loads before setup. If settings fail to load while setup looks pending, a message modal shows instead, so a network blip can't trigger a re-run.

**The screen:** two questions side by side (stacked on narrow screens), the Stash ratings message, a preview, and Start.

1. **How should ELO start?**
   - **Use my ratings:** every scene with a Stash rating gets `{ elo: seed(rating100), battles: 0, seeded: true }`. Unrated scenes stay unrated. Scenes with the same Stash rating get the same fields, so it's one aliased `bulkSceneUpdate` per distinct rating, all in one request. On a re-run, scenes that have an ELO but no Stash rating get our fields **removed** (one `bulkSceneUpdate` with `remove`).
   - **Start everyone at 1500:** every scene gets `{ elo: 1500, battles: 0, seeded: false }` in a single `bulkSceneUpdate`.
2. **Should Stash Battle change your Stash ratings?** — the three options (texts in `ui/stashRatingsText.ts`), "Don't update" preselected on first setup. The answer is saved as the `stashRatings` setting; if it isn't "off", the full sync (`writeStashRatings`) runs right after the ELO writes.

**Stash ratings message** (`.sb-setup-message-slot`): every distinct message for the six answer combinations is rendered at once, stacked in one grid cell, and only the current one is visible. The slot keeps the height of the longest, so switching answers never moves the preview; combinations with identical text share one element, so switching between them doesn't fade. Warnings state the exact count of ratings that change (and that a fresh start makes everything 50); the Start button reads "Start ELO and change N ratings".

**Preview** (`ui/ratingPreview.ts`): 10 fixed example scenes in three rows — now in Stash; after setup (starting ELO above, resulting Stash rating inside, changed squares outlined, "N of 10 change"); after lots of battles. Every number comes from the real `afterSetup` / `stashRatingTargets` / `percentileRatings` / `linearRating`, so it can't drift. `showRatingPreview` updates an existing preview in place: numbers count to their new values over 400 ms (a timer lands them even when the tab gets no animation frames) and colours fade by CSS transition; both are off under `prefers-reduced-motion`.

**Finishing:** after the writes, the scene cache, shuffle, run state and saved pair are reset (they predate the new ELO), then `eloSetupAt` (ISO time) and `eloSetupMode` are saved with `updateSettingsNow`. If that save fails, the screen offers a retry and setup stays pending. The summary screen's "Start battling" calls `afterSetup()` in `modal.ts`.

**Interrupted setup:** nothing marks it done, so it shows again on the next open, with a note that N scenes already have an ELO; re-running overwrites. A module-level `running` flag keeps the progress view when Stash Battle is closed and reopened mid-setup.

**Reset ELO** (Settings → ELO): a confirmation dialog, then the same screen in reset mode (`showSetupScreen(..., { reset: true, onCancel })`): "Reset ELO" title, the current Stash ratings option preselected, and a Cancel button. `state.resettingElo` keeps battles paused. Closing Stash Battle before Start cancels the reset (`closeModal`). Pressing Start first clears the saved `eloSetupAt`, so an interrupted reset asks again next time.

**Upgrade note:** on first setup, users who weren't in pre-3.0 fun mode (`hadFunMode()` reads the stored `funMode`) see "Before 3.0, ratings changed after every battle; Straight-line with Use my ratings is closest to that."

---

## Stash Ratings Update Mode

`stashRatings`: `"off"` (default) | `"percentile"` | `"linear"`. Not in the yml (Stash's plugin settings page has no dropdown type), so the warning and sync always run.

### Switching (Settings dropdown)

`bindSettingsControls` takes a `beforeChange` hook for dropdowns; `confirmSettingChange` in `modal.ts`:

- To **"off"**, or a switch that changes nothing: no warning, nothing written.
- Otherwise it fetches the library fresh (`fetchSetupScenes`), counts `stashRatingChanges`, and opens the confirmation dialog ("Switch Stash ratings update mode to Percentile?", the option's description, "N Stash ratings change now", that hand-edited stars get overwritten, a backup reminder). Confirming runs `writeStashRatings` + `applyStashRatings` as the dialog's action; only then is the setting saved. Cancel or Escape puts the dropdown back.

### Per-battle sync (`rating.ts`)

- `writeElo` / `clearElo` call `scheduleStashRatingSync()` once the write succeeds: debounced `SYNC_DEBOUNCE_MS` (500 ms) so a pick's two writes share one sync; skipped on "off". Switching the update mode schedules one too, to catch anything an old-mode sync changed after the switch was counted.
- `syncStashRatings()` computes `stashRatingChanges` over the whole **all-scenes cache** and writes only scenes whose cached `rating100` differs: one request (`writeStashRatings`: one aliased `bulkSceneUpdate` per distinct value). Then `applyStashRatings` updates the cache and Stash's page cache. Syncs and the switch's full write run through `queueRatingWrite`, one at a time, so each starts from the ratings the last one wrote.
- **Percentile and ties:** tied scenes share their group's middle rank, so when one member of a tie group leaves or joins it, the whole group's rating can move by 1. Seeded ELOs tie a lot at first (every scene with the same Stash rating starts equal), so early syncs can write dozens of ratings per battle; it fades as ELO spreads out. Kept deliberately over a tie-break, which would turn a fresh start into an arbitrary 100-1 spread.
- While an update mode is on, a star edit made in Stash lasts until Stash Battle next writes that scene.

### Stash's own page cache (`refreshStashCache` in `graphql.ts`)

Stash Battle writes with plain `fetch`, so Stash's pages (Apollo) wouldn't see the changes. After every write, the changes are mirrored into `PluginApi.utils.StashService.getClient().cache`: `cache.modify` on `Scene:<id>` for `rating100` and `custom_fields` (Apollo only calls modifiers for fields it has cached), and when ratings changed, `cache.evict({ id: "ROOT_QUERY", fieldName: "findScenes" })` + `gc()` so rating-sorted lists re-sort. While Stash Battle is open that drop is held back (`holdStashListRefresh`) and done once on close, so lists don't refetch every pick. Quietly does nothing if the client isn't exposed.

### Battle tab note

On "off", `#sb-ratings-note` says "Stash ratings aren't being changed · change in Settings" (`updateRatingsNote()`); the link opens the Settings tab.

---

## Game Modes

### Swiss Mode

The default mode. Pairs scenes with similar ELO for meaningful comparisons.

**Pairing logic**:
1. Pick the next scene from the shuffled filtered pool (left side)
2. Find its position in the opponent pool (sorted by ELO)
3. If the scene is unrated (or not in the opponent pool), position it where 1500 would sit (`eloInsertionIndex`)
4. Collect candidates within ±N of that position (starts at `SWISS_OPPONENT_REACH_INITIAL`, doubles until candidates exist, and stops once it has covered the pool)
5. Pick randomly from candidates

**After battle**: both get two-sided ELO and `battles + 1`. Both stay in the pool.

### Placement Mode

Finds a scene's spot with as few battles as possible — a bounded search with momentum. The search is pure and lives in [`src/placement.ts`](src/placement.ts) (so whole runs are simulated in `tests/placement.test.ts`); `fetchPlacementPair` (`pairs.ts`) and `handlePlacementChoice` (`mainUI.ts`) drive it.

- The pool is the usual ELO-sorted opponent pool **minus** the scene being placed. The scene's slot lies in `[lo, hi)`. A **win** against index *i* sets `hi` to the top of *i*'s tie group; a **loss** sets `lo` to just below its bottom (for a scene with no ties, `hi = i` and `lo = i + 1`). Bounds are stored as the bounding opponents' ids (`aboveId` / `belowId`) and resolved to indices on every fetch, so a background cache refresh can't corrupt them.
- **Rated scene**: starts right below its current ELO (`eloInsertionIndex`) and **gallops** — each same-direction result doubles the step (1, 2, 4, 8…), measured from the far edge of the last opponent's **tie group** (another scene with the same ELO teaches nothing). The first reversal switches to bisection. A correctly rated scene confirms in ~2 battles.
- **Jump cap**: a gallop jump is at most `maxPlacementJump(pool)` = 10% of the pool (`PLACEMENT_MAX_JUMP_SHARE`), at least `PLACEMENT_MIN_MAX_JUMP` (4) ranks, and a jump that would pass the search range halves the range instead of landing on its end. So a winning streak climbs instead of leaping to #1. A rank gap can exceed the cap by the size of a tie group (the jump starts from the tie's far edge).
- **Unrated scene**: plain bisection from the middle — ⌈log2(N+1)⌉ battles (≈9–10 for ~500 rated scenes).
- Opponents with equal ELO are interchangeable: `pickAmongTies` chooses randomly among them within bounds.
- **Done** when `lo >= hi`. ELO = `landingElo`: the midpoint of the nearest neighbours **with an ELO** above and below (`placementElo`), or `PLACEMENT_EDGE_GAP` (25) beyond the only one at an edge, 1500 with none. Neighbours too close to fit a value between (0.1 apart) give the upper one's ELO, which still sorts the scene into its slot. Written once via `writeElo` with `battles + run.battles`; nothing else changes.
- The run is created when the pair **loads** (`battles = 0`), so Skip still works before the first choice and resets the run.
- Badge on the scene: `📍 Narrowing between #lo and #hi`.

#### "Start from the bottom" (replaces Gauntlet)

`placementFromBottom` setting (Settings → Battles, and a yml BOOLEAN). The run's `fromBottom` flag is read when the run starts.

- Ignores the scene's ELO: the first opponent is the bottom rated scene of the pool (`bottomIndex`), then it gallops upward with the same capped doubling.
- `streak` counts wins before the first loss (it grows only while `streak === battles`); the card shows "🔥 N wins" until then, then the narrowing badge.
- A climb that never loses lands at slot 0: **victory screen** ("Reached the top: N wins in a row!"). Otherwise the placed screen shows the streak, rank, battles and ELO.
- Changing the setting mid-run restarts that scene's run from the new start (`onSettingChanged` in `modal.ts`); nothing is written before a scene lands.
- Cost on a 600-scene pool: 8 battles near the bottom, ~17-21 for the middle and top, 21 to beat #1 (average 17.0, worst 21).

### Champion Mode

Winner stays on, with plain two-sided ELO every pick.

- **Start**: the challenger from the left pool against the **lowest-rated** scene of the opponent pool (`findLowestRated`).
- **Each pick**: `resolveComparison` changes both scenes' ELO (`battles + 1` each). If the champion wins, the opponent joins `championDefeated` and the streak grows; if it loses, the **winner becomes the champion** (`championDefeated = [loser]`, streak 1).
- **Next opponent**: random among up to `CLIMB_OPPONENT_PICK_WINDOW` of the closest unbeaten opponents above the champion (by pool index or ELO).
- **Victory**: no unbeaten opponents above → victory screen.
- Unrated scenes count as 1000 (the bottom) here.

### Filter opponents + Champion

When **`filterOpponents` is on** and a **URL filter is active**, left and right draw from the same filtered list. With fewer than `CLIMB_SMALL_POOL_WARN_AT` (10) scenes, results can feel odd (a run may end after a few fights); the Battle tab shows a warning for that combination.

---

## UI Behavior

### Scene Cards

Each card shows: screenshot (with preview video), title, duration, the **ELO badge**, studio, performers, play count, **Battles**, **Stash Rating**, tags, and a "Choose This Scene" button.

- **ELO badge** (`.sb-scene-rank`): `ELO 1740 · #50` (rank when known). Unrated: `ELO 1500 · Unrated` in Swiss, `ELO 1000 · Unrated` in Champion, plain `Unrated` in Placement.
- Meta lines: "Battles: N" (`.sb-meta-battles`, hidden wherever Play Count is) and "Stash Rating: 74/100" (or "None").

Card media structure: `.sb-scene-media` wraps the thumbnail **link** (`a.sb-scene-image-container`, holding the `img` and `video`) plus sibling overlays (duration, status badge, click hint, ↗ open link, 🗑 delete button). Overlays are siblings, not children, so SFW blur on the link doesn't blur them; non-interactive overlays use `pointer-events: none` so hover still reaches the link.

**Card border and corners** (see Pitfalls): the card has no CSS border. Its 2px border is a `::after` layer drawn **on top** of the content (`--sb-card-border`: #333, hover #0d6efd, winner #28a745, loser #dc3545), so content is clipped once, at the card's outer rounded edge. The thumbnail container, image and preview video carry the card's 12px top corners themselves.

**SFW Switch compatibility**: the thumbnail link, image, video, scene info and end-screen image also carry the plugin's pre-2.0 `pwr-*` class names (`pwr-scene-image-container`, `pwr-scene-image`, `pwr-hover-preview`, `pwr-scene-info`). The SFW Switch plugin's CSS still targets those names to blur Stash Battle — **don't remove them**.

**Thumbnail click**: plain click → SPA `navigateToUrl`; ctrl/cmd/shift/middle click → native new tab; with `openInNewTab` → `target="_blank"`. On touch devices (`(hover: none)`) a tap toggles the preview with sound instead, and the ↗ link opens the scene.

**Previews**: hovering a card plays its preview at `previewVolume` (0 = muted). With `autoplayPreviews`, both previews loop muted as soon as the pair renders and hovering only unmutes. `applyPreviewSettings()` re-applies volume/autoplay to rendered videos (slider moves, setting changes, modal reopen).

**Badges** (over the screenshot), via the `statusBadge` parameter of `createSceneCard`:
- Win streak: `🔥 X wins` (number) — Champion's champion, and "Start from the bottom" runs before their first loss
- Placement range: `📍 Narrowing between #lo and #hi` (string)

### Scene Pool Status Line and Notes

- `#sb-pool-status` (above the cards, every mode) says where the left-side scenes come from: "Rating scenes from your Scenes page filter · N scenes" (+ "· opponents from the filter too"), or "Rating scenes from your whole library · N scenes · filter the Scenes page to narrow it down". `restoreCurrentPair` loads the pools in the background via `loadPoolSize()` to fill in the count.
- `#sb-ratings-note`: see Stash Ratings Update Mode.
- `#sb-climb-pool-warning`: see Filter opponents + Champion.

### Mode Tooltips

Each mode button carries a short explanation in `data-tip` (from `MODES` in `mainUI.ts`), rendered by a CSS `::after` tooltip on hover (0.35s delay) or keyboard focus, and mirrored in `aria-description`. The tooltip uses `white-space: pre-line`, so a `\n` in a tip starts a new line (Placement's tip points Gauntlet users to "Start from the bottom" after a blank line). The first and last buttons anchor their tooltip to their outer edge so it isn't clipped.

Touch screens have no hover, so `(hover: none)` shows an **ⓘ** button at the end of the mode row; it toggles `#sb-mode-info` with the current mode's explanation (`updateModeInfo()`, `\n` → `<br>`). Three modes plus ⓘ fit on one row down to 320px, icons included.

### Action Bar (Skip / Refresh)

`setActionsVisible()` is the only thing that shows/hides `.sb-actions`: **every `renderPair` shows it**, the error screen shows it, and only end screens hide it. The bar is `position: sticky; bottom: 0` inside the scrolling modal content so Skip stays reachable.

### Layout

- Cards sit side by side down to 640px wide; the card row's max width is tied to viewport height (`calc(135vh + 120px)`) so 16:9 thumbnails don't push the choose buttons off short screens.
- `max-height: 900px` (laptops): compact header (no subtitle/mode descriptions), play count, battles and tags hidden.
- `≤1000px`: play count, battles and tags hidden, smaller VS.
- `≤640px` (phones): full-screen modal (`100dvh`), stacked compact cards (2:1 thumbnails, one meta line, short "✓ Choose"), the VS badge sits in an 18px gap between the cards (8px clear of each), mode buttons as a segmented row, compact tab bar; the Stash ratings dropdown and Reset ELO rows stack.

### Rating Animations

After each Swiss / Champion pick, an overlay counts the **ELO** change in whole points:
- Green overlay with `+X` on the winner, red with `−X` on the loser (75% opaque over the card)
- Step speed scales with |change| so large jumps finish within the window; small changes use ~50ms per point
- Overlay removed after **1400ms**; next pair loads after **1500ms**
- The overlay has no border-radius of its own: the card clips it (see Card border and corners)
- No glows: the winning card's green and the loser's red are border colours only, and the VS text has no shadow

### Victory / Placement Screens

- **Victory** (Champion, or a "Start from the bottom" climb that never lost): crown, "CHAMPION!", "Reached the top: N wins in a row!", final ELO
- **Placement**: pin, "PLACED!", streak (bottom runs), rank, battles, final ELO
- Both show "Start New Run" (`#sb-new-run`), which resets run state
- No glow. They use the cards' entry animation (`fadeIn`, 0.3s); while an end screen shows, the battle area has `overflow: clip` (`.sb-comparison-area:has(> .sb-end-screen)`), because the end screen sits flush with the window's bottom (the action bar is hidden) and the slide-in would otherwise make the content 20px taller for a moment and flash a scrollbar.

### Keyboard Shortcuts

| Key | Action |
|---|---|
| Escape | Close the modal; cancels a confirmation dialog instead when one is open (does nothing while Stash's delete dialog is open — Stash's modals ignore Escape too) |
| Left Arrow | Choose left scene |
| Right Arrow | Choose right scene |
| Space | Skip (disabled while a Champion/Placement run is active) |

**Key containment**: while the modal is visible, every `keydown` is stopped in the capture phase (`stopImmediatePropagation`, no `preventDefault`), and `keypress`/`keyup` are swallowed by `addKeySwallowers()`. Stash's hotkeys (Mousetrap on `document`) therefore never act on the page behind the modal, while default actions — typing in inputs, slider arrows, checkbox Space — still happen.

Battle shortcuts only work on the Battle tab, and not while ELO setup is showing or a confirmation dialog is open. They're ignored while focus is in a text/number/range input or a select, but still work with a checkbox focused. While Stash's delete dialog is open, Stash Battle stops intercepting keys entirely so the dialog gets them.

---

## Settings

**UI**: the modal header has a Stash-style tab bar (`nav nav-tabs`): **Battle** | **Settings** on the left, the preview volume on the right (visible on both tabs). Tabs swap `.sb-tab-panel` elements in place. The Settings tab reuses Stash's `.setting-section` / `.setting` rows and `custom-switch` toggles; `.sb-settings-tab` only re-tints them. The dropdown is drawn in the modal's dark palette with a chevron (Stash sets `appearance: none` on selects). The modal always reopens on the Battle tab. While Settings is showing, battle shortcuts are off and previews are paused.

Sections: **ELO** (Stash ratings update mode, Reset ELO), **Battles**, **Scenes**.

Stored in Stash's plugin config (`configuration.plugins["stash-battle"]`, written with `configurePlugin`) so they follow the user across devices; most are also declared under `settings:` in `stash-battle.yml` so they appear in Stash → Settings → Plugins. `openModal()` awaits `loadSettings()` each time, and a reused modal re-syncs its controls.

| Key | Default | Effect |
|---|---|---|
| `stashRatings` | `"off"` | Stash ratings update mode — see that section. Not in the yml |
| `eloSetupAt` / `eloSetupMode` | `null` | Set when ELO setup finishes (ISO time; `"ratings"` / `"fresh"`). Not in the yml or the Settings tab |
| `placementFromBottom` | false | Placement's "Start from the bottom" |
| `filterOpponents` | false | Right side obeys the list filter too |
| `openInNewTab` | false | Thumbnail opens the scene in a new tab |
| `previewVolume` | 50 | Preview volume on a cubic curve (`video.volume = (v/100)³`, so 50 ≈ 0.125), 0 = muted (slider on the tab bar; the speaker mutes / restores) |
| `autoplayPreviews` | true | Loop both previews muted; hover to hear |
| `cleanMode` | false | 🗑 delete button on each card |
| `pauseMediaOnOpen` | **true** | Pause Stash's playing video/audio when Stash Battle opens. Stash's plugin settings page shows unset booleans as off, but a missing key means the default (on) |

- `configurePlugin` **replaces** the whole map, so every save sends every key (`updateSettings` debounced 400ms for the slider; `updateSettingsNow` for setup's flags). Null values are left out. A save re-reads the stored config and puts only this tab's unsaved keys on top, so a tab that loaded settings before another tab finished the setup can't undo it.
- `normalize()` drops removed keys (`funMode`, `unratedRating`) on the next save; an unknown `stashRatings` becomes `"off"`.
- Users with no saved config get defaults overlaid with the pre-2.7 localStorage toggles (`sb_filterOpponents`; `sb_mutePreviews=1` → volume 0).
- Every control has `data-setting="<key>"`; `bindSettingsControls` wires them generically and `onSettingChanged` in `modal.ts` applies side effects (reload pair for filterOpponents, restart a Placement run for placementFromBottom, re-render cards for openInNewTab/cleanMode, re-apply previews, the ratings note).

## Clean Mode (deleting scenes)

With `cleanMode` on, each card has a 🗑 button that opens **Stash's own `DeleteScenesDialog`** — the same options, defaults, file list, delete mutation and toast as deleting inside Stash.

How the bridge works (`ui/deleteDialog.ts`):
- The dialog needs Stash's React context (intl, configuration, Apollo, toasts), so it can't be rendered standalone. `registerDeleteDialogBridge()` patches a tiny `DeleteBridge` component into `MainNavBar.UtilityItems` via `PluginApi.patch.after`; react-bootstrap portals the modal to `<body>`.
- `PluginApi.loadableComponents.DeleteScenesDialog` is a loader that resolves to the **module** — loading it does *not* add it to `PluginApi.components`. The bridge takes `mod.DeleteScenesDialog` from the module (preloaded at startup; `confirmDeleteScene` awaits it).
- `confirmDeleteScene(scene)` fetches the fields the dialog reads (`id title interactive files { path }`) and dispatches a cancelable `stash-battle:open-delete-dialog` event; the first mounted bridge `preventDefault`s it. If nobody handles it, Stash Battle shows an error.
- The dialog calls `onClose(true)` after a successful delete, `false` on cancel or error. On `true` Stash Battle runs `handleSceneGone(id)`.
- While Stash Battle is open, `body.sb-battle-open` lifts Stash's `.modal` / `.modal-backdrop` above the battle modal (z-index 10060 / 10050).
- If this Stash doesn't expose `DeleteScenesDialog` to plugins, the bridge isn't registered and the 🗑 button is hidden.

After a delete, `handleSceneGone(id)`:

1. `removeSceneEverywhere` drops it from `allScenes`, `filteredScenes`, both IndexedDB entries (keeping their original timestamps) and the shuffle (adjusting `shuffleIndex`) — no Refresh needed.
2. If it was the **left** scene or the run's scene (placement scene, champion) → `resetRunState()` and a fresh pair.
3. Otherwise (an opponent) → drop it from `championDefeated` and placement bounds, and `loadNewPair(leftId)`.

**Deleted elsewhere**: `restoreCurrentPair` and the reused-modal path call `verifyCurrentPair()` (aliased `findScene` lookups — `findScenes(ids:)` errors if any id is missing), and a write that fails with "not found" dispatches `SCENE_MISSING_EVENT`; all of them route to `handleSceneGone`.

---

## State Persistence

State is saved to `localStorage` under `"stash-battle-state"` after every battle and on certain mode changes. Restored on modal open.

**Saved fields**: `version`, `currentPair`, `currentRanks`, `currentMode`, `championScene`, `championWins`, `championDefeated`, `placement`, `totalScenesCount`, `savedFilterParams`. (Settings are not here — they live in Stash's plugin config.)

**Versioning**: `STATE_VERSION` is 3 (3.0). An older save keeps only its mode and filter params — its scenes lack custom fields and Gauntlet runs no longer exist — so the pair and run start fresh. A saved `currentMode` of `"gauntlet"` loads as `"placement"`.

**Filter change detection**: `savedFilterParams` stores the URL search string. If it differs on modal open, run state and caches are reset.

### Scene Page Battle

When the Battle button is clicked on an individual scene page (`/scenes/123`):

1. `getSceneIdFromUrl()` extracts the scene ID from the URL pathname
2. If the scene is already in `currentPair.left` or `currentPair.right`, the existing pair is restored normally
3. Otherwise a new battle is forced: run state reset, `currentPair` / `currentRanks` cleared, `fetchSceneById()` loads the scene, and it's passed as `forcedLeftScene` through `loadNewPair` → the active mode's fetch, replacing the normal `getNextFilteredScene()` pick

---

## URL Filter Integration

The plugin reads Stash's URL filter parameters to determine which scenes to show:

- **`q`** parameter: text search query
- **`c`** parameters: structured criteria (JSON-encoded with `()` instead of `{}`)
- **`sortby`** / **`sortdir`**: sort options

`getSceneFilter()` parses these into a GraphQL `SceneFilterType`. Supported criterion types: boolean, stringEnum, multi, hierarchicalMulti, resolution, orientation, duplicated, and standard numeric/string comparisons. **Custom-field criteria are not handled** (no special case for Stash's `custom_fields` criterion list), so a Scenes-page filter on `stash_battle_elo` isn't known to carry into Stash Battle; untested. Stash's own numeric custom-field filters are broken anyway (Common Pitfalls #19).

---

## GraphQL Integration

All data comes from Stash's GraphQL API:

- **`findScenes`**: scene lists with `per_page: -1` (sorted client-side by ELO); a slim `id rating100 custom_fields` version for setup and the Stash ratings switch (`fetchSetupScenes`)
- **`findScene`**: a single scene (scene page battle); aliased batches check whether the current pair still exists
- **`sceneUpdate`** with `custom_fields: { partial | remove }`: ELO writes (`writeElo`, `clearElo`). `partial` and `remove` can be combined in one input.
- **`bulkSceneUpdate`**: setup ("Use my ratings": one aliased call per distinct rating; "Start everyone at 1500": one call, every id), removing stale ELO, and Stash rating writes (`writeStashRatings`: one aliased call per distinct value, in one request)
- **`__type(name: "Scene")`** introspection: the custom-fields capability check
- Clean mode deletes go through Stash's own dialog (its `scenesDestroy` mutation)
- **`configuration { plugins }`** / **`configurePlugin`**: settings
- **Fragment fields** (`SCENE_FRAGMENT`): `id`, `title`, `date`, `rating100`, `play_count`, `custom_fields`, `paths` (screenshot, preview), `files` (duration, path), `studio` (name), `performers` (name), `tags` (name). `custom_fields` includes other plugins' fields too.
- Stash updates a scene's `updated_at` on any write, even one that changes nothing visible.

---

## Common Pitfalls & Edge Cases

1. **Never write `rating100` outside the Stash ratings sync.** Battles write ELO only (`writeElo`); Stash ratings change only through `writeStashRatings` (setup, the dropdown switch, `syncStashRatings`).

2. **Custom field writes must use `partial` / `remove` with our keys**, never `full`: other plugins store their own fields on the same scenes.

3. **Stash stores booleans as numbers** in custom fields (`true` → `1`). Read flags with `isSeeded`, not `=== true`.

4. **Unrated in the opponent pool**: without the rated-only filter, unrated scenes cluster at the bottom of the ELO-sorted list, and Swiss's ±reach around an unrated left scene would pick other unrated scenes. Hence `isRated` in `buildOpponentPool`.

5. **Tiny Swiss pool + filter opponents**: opponent reach starts at `min(SWISS_OPPONENT_REACH_INITIAL, pool.length)` and doubles until candidates exist, stopping once it covers the pool (a pool holding only the scene itself errors instead of looping).

6. **Pass the scene object to `writeElo`**, not an id: restored scenes (a saved champion, a forced scene-page scene) are separate objects from the cached ones, and `setEloInCache` updates both.

7. **Placement ties**: scenes inside an ELO tie group are interchangeable as opponents, and a result counts for the opponent's whole group (`placementBounds` snaps to the group's edge). A scene can only get an ELO above or below a group, not inside it, so this keeps the landing ELO strictly between its neighbours and the shown rank true. Right after "Start everyone at 1500" the whole library is one group, so a Placement run takes one battle and lands at 1525 or 1475; it gets useful once Swiss has spread ELO out.

8. **Pool size for rank display**: `totalScenesCount` comes from `opponentPool.length`, not `allScenes.length`.

9. **Scene page battle with an active run**: opening Stash Battle from a scene page resets the run if the scene isn't already in the pair, so a forced scene can't corrupt a Champion or Placement run.

10. **Scene page ID matching**: IDs are compared as strings via `String()`. `getSceneIdFromUrl()` requires a pure numeric segment (`/scenes/(\d+)$`).

11. **Action bar visibility**: only `setActionsVisible()` may show/hide `.sb-actions`. Any new path that renders a pair must go through `renderPair`.

12. **`[hidden]` vs component display**: `.sb-container [hidden]` / `#sb-modal [hidden]` force `display: none !important`, because component rules like `display: flex` otherwise override the `hidden` attribute.

13. **Rounded corners and clipping** (the card): don't put the card's border back on the card box. A CSS border's inner edge and the `overflow: hidden` clip of the content are two curves in the same place, each anti-aliased against the dark card background, which shows as a dark seam at the corners (worst under the green/red rating overlay). The border is an `::after` drawn on top, so content is clipped once. Playing videos can also be composited outside the parent's rounded clip, so the thumbnail, image and video carry the 12px top corners themselves. Don't give the rating overlay its own radius either.

14. **Stash's settings rows give buttons a right margin** (`.setting-section .setting > div:last-child .btn`); the Reset ELO button overrides it with a more specific selector so it lines up with the other controls.

15. **Stash's `.nav-tabs` margins**: Stash centers `.nav-tabs` with auto margins; `.sb-tabs.nav-tabs { margin: 0 }` keeps the tabs left-aligned next to the volume control.

16. **Stash's modals ignore Escape**: Stash's `ModalComponent` sets `keyboard: false` and no backdrop `onHide`, so its delete dialog closes only via Cancel/Delete. Stash Battle matches that rather than force-closing it.

17. **Setup flags and `configurePlugin`**: because `configurePlugin` replaces the whole map, `eloSetupAt` / `eloSetupMode` / `stashRatings` must go through `updateSettings` / `updateSettingsNow` and `normalize()`, or the next settings save drops them.

18. **The cache's `rating100` drives the per-battle sync**: after a full sync it's updated in memory but not in IndexedDB, so a reload within 5 minutes can make the first sync rewrite a few ratings to the same values (harmless, but it touches `updated_at`).
19. **Stash's custom-field filters don't compare numbers** (v0.31.1): on a numeric field like `stash_battle_elo`, `EQUALS` and `GREATER_THAN` match nothing, `LESS_THAN` matches every scene, and `BETWEEN` matches nothing; `NOT_NULL` and boolean `EQUALS true` work. The filter value seems to be compared as text against the stored number (SQLite sorts every number below every text). Same family as [stashapp/stash#5682](https://github.com/stashapp/stash/issues/5682). So ranks are counted client-side, and Scenes-page filters on ELO or battles give wrong results in Stash itself, before Stash Battle sees them. Don't store ELO as text to work around it: it would break numeric order everywhere else.
