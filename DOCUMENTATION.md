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

The plugin is authored in **strict TypeScript** under [`src/`](src/) and bundled by **esbuild** into a single IIFE at `plugins/stash-battle/stash-battle.js` — which is the file Stash actually injects into its UI (alongside a CSS file and a YAML manifest). The committed `stash-battle.js` is a **build artifact**; never edit it by hand — edit the TypeScript modules and rebuild. The plugin adds a "Battle" button to Stash's navbar that opens a modal where users compare scenes head-to-head to build rankings with a true ELO system. Besides the battle itself, the modal has tabs to browse the library by ELO (**Explore**), see how the rankings look (**Stats**), and keep records (**Records**: win/loss, peaks, streaks, a hall of fame).

> The bundle output must remain a single IIFE with no `import`/`export`, because the distribution path (`stash-battle.yml` → `build_site.sh` → GitHub Pages index) ships exactly the files in `plugins/stash-battle/`. esbuild's `format: "iife"` guarantees this.

**Requires Stash v0.31.0 or newer**: scene custom fields (where ELO is stored) were added in [v0.31.0](https://github.com/stashapp/stash/releases/tag/v0.31.0). `sceneCustomFieldsSupported()` checks by introspection on every open and shows a "needs a newer Stash" message instead of loading.

### Entry Flow

1. `init()` fires on `DOMContentLoaded`: `registerDeleteDialogBridge()`, `registerNavButton()` and `registerSceneElo(openModal)`
2. **Nav button** (`ui/navButton.ts`): where Stash has the plugin patch API, a `BattleNavItem` React component is patched into `MainNavBar.MenuItems` with `PluginApi.patch.before` (after Stash's own page links). It shows on **every page** (before 3.0 only on `/`, `/scenes` and `/scenes/*`); the Scenes filter is only read on Scenes pages (`scenesListQuery`, see URL Filter Integration). Without the patch API it falls back to injecting the button into the DOM and re-adding it from a `MutationObserver`.
   - **Top-bar icon** (`#plugin_sb_icon`): below 1200px Stash folds its page links into the ☰ menu, so the link is only one tap away there. A swords button is also placed in the navbar's `.navbar-buttons`, right after other plugins' buttons (TCode, SFW Switch), on every page; it's hidden at 1200px and up (CSS). It's DOM injection (`MainNavBar.UtilityItems` is hidden at those widths), re-placed by a `MutationObserver`. `fitNavIcon` hides it when it would wrap the bar onto a second row (shown at 393px and 768px, hidden at 375px with two other plugin buttons). Measuring forces a layout, so it only re-measures when the window width or the number of buttons changed, or when the tab becomes visible (a background tab has no layout, so it measures nothing until then).
3. Clicking the button calls `openModal()`: settings and the custom-fields check load in parallel, then either the one-time **ELO setup** shows (see ELO Setup) or the battle UI loads
4. **Scene page ELO** (`ui/sceneElo.ts`): on `/scenes/:id`, an item (`.sb-scene-elo`) goes into `.scene-toolbar`, in front of Play Count: a single Stash `minimal btn btn-secondary` button holding an icon and `ELO 1740 · #50` (`ELO 1540?` while provisional), so the icon and text highlight together. The icon is the scene's tier emoji (👑 💎 🔷 🥇 🥈 🥉, centred in a fixed box so every emoji lines up), or the swords (from `ui/icons.ts`, shared with the navbar) for provisional and unrated scenes; the tooltip names the tier. On phones (≤576px, a `matchMedia` listener) the button leads the `.scene-subheader` line instead ("🔷 ELO 1960 · #41 · date · 60 fps | 4K"): in the toolbar it widened the page and made it scroll sideways. The loaded result is kept, so re-placing the button after a re-render doesn't fetch again; its padding and gap match the count buttons next to it. ScenePage isn't a patchable component, so it's DOM injection, re-added from a `MutationObserver` (batched with a 50 ms timer; animation frames don't run in background tabs) whenever React re-renders the toolbar. ELO and rank come from `getAllScenesCached()` (index in the ELO-sorted cache, the same as the cards; a scene newer than the cache is fetched, without a rank). Stash's own custom-field filter can't do the count: in v0.31.1 numeric comparisons don't match (Common Pitfalls #19). Clicking it calls `openModal()`; `closeModal()` calls `refreshSceneElo()` so it shows the new ELO.
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
| `state.leastTested` | Stats → "Battle the least-tested" is on: Swiss takes the fewest-battled scene on the left (see Stats Tab) |
| `state.explorePool` | Explore → "Battle these N scenes": `{ filters, label }` of the Explore filter being battled, or `null` (see Battling an Explore filter) |
| `state.memoryCache` | In-memory scene cache (see Caching Strategy) |
| `state.shuffledFilteredScenes` / `state.shuffleIndex` / `state.shuffleFilterKey` | Filtered-pool shuffle traversal |

Helpers in `state.ts`: `resetRunState()` clears Champion **and** Placement run fields between runs; `resetShuffle()` forgets the left-side shuffle; `isRunActive()` says whether a run is under way (Skip is disabled while it is); `isEloSetupPending()` is true until setup has finished (`eloSetupAt` set) and while Reset ELO is showing.

---

## Project Structure & Build

### Source layout (`src/`)

| Module | Responsibility |
|---|---|
| `types.ts` | Shared types: `Scene` (mirrors `SCENE_FRAGMENT`), `EloFields`, `Mode`, `Settings`, `StashRatingsMode`, `EloStart`, `PlacementRun`, `Pair`, `Ranks`, GraphQL response shapes, pair-result shapes |
| `constants.ts` | Cache/storage keys, `DEFAULT_SETTINGS`, `EXPLORE_PAGE_SIZES`, ELO constants (`ELO_START`, `ELO_DIVISOR`, `ELO_K_TIERS`, `SEEDED_HEAD_START`, `ELO_PER_RATING_POINT`), custom field keys (`ELO_FIELD`, `BATTLES_FIELD`, `SEEDED_FIELD`, the record fields, `RECORD_FIELD_KEYS`, `ELO_FIELD_KEYS`), `TIERS`, `UPSET_MAX_CHANCE`, Placement (`PLACEMENT_EDGE_GAP`, `PLACEMENT_MAX_JUMP_SHARE`, `PLACEMENT_MIN_MAX_JUMP`), Champion (`CHAMPION_UNRATED_ELO`, `CLIMB_OPPONENT_PICK_WINDOW`, `CLIMB_SMALL_POOL_WARN_AT`), Swiss window (`SWISS_OPPONENT_ELO_WINDOW`, `SWISS_OPPONENT_MIN_CANDIDATES`) |
| `state.ts` | Central mutable `state` object + `resetRunState()`, `resetShuffle()`, `isRunActive()`, `isEloSetupPending()`, `explorePoolWithin()` |
| `settings.ts` | `loadSettings` / `updateSettings` / `updateSettingsNow` — settings in Stash plugin config (`configurePlugin`), `mergeConfig` (the map to save), `hadFunMode()`; the hall of fame (`getHallOfFame`, `addToHallOfFame`, `keepOnlyHallOfFame`, `clearHallOfFame`, `parseHallOfFame`, `mergeHallOfFame`) |
| `elo.ts` | Pure ELO math: `eloKFactor`, `eloExpected`, `winChances`, `eloResult`, `roundElo` |
| `score.ts` | Pure: a scene's ELO fields (`elo`, `isRated`, `battles`, `isSeeded`, `kGames`, `isProvisional`, `eloFields`, `eloCustomFields`), records (`sceneRecord`, `recordAfter`, `recordText`), Swiss opponents (`swissOpponentIndexes`), `seed`, `effectiveElo`, ELO ↔ Stash rating (`linearRating`, `percentileRatings`, `stashRatingTargets`, `stashRatingChanges`), setup (`startingElo`, `afterSetup`), ordering (`compareByElo`, `sortByElo`, `eloInsertionIndex`), `placementElo` |
| `stats.ts` | Pure: tiers (`tierMap`, `cachedTierMap`, `tierDescription`) and the Stats / Records maths (`overview`, `eloHistogram`, `largestTie`, `ratingScaleTicks`, `median`, `gemsSplit`, `gemsQuadrant`, `settledBuckets`, `leastTested`, `leastTestedPool`, `topByRecord`) |
| `explore.ts` | Pure: Explore's entries, search, filters and sorts (`exploreEntries`, `filterExplore`, `sortExplore`), battling a filter (`filterBattlesWithin`, `explorePoolScenes`) |
| `ratingDisplay.ts` | How this Stash shows ratings (`setRatingSystem`, `getRatingSystem`, `parseRatingSystem`) and formatting to match (`formatRating`, `ratingValue`, `ratingStarts`, `exampleRating`, `scaleMarks`) |
| `sceneTitle.ts` | `resolveSceneTitle`: the title, or the file name without its extension |
| `placement.ts` | Pure Placement search: `newPlacementRun`, `placementStep`, `recordPlacementResult`, `landingElo`, `bottomIndex`, `maxPlacementJump` |
| `graphql.ts` | `graphqlQuery`, `SCENE_FRAGMENT`, `FIND_SCENES_QUERY`, `fetchSceneById`, `getSceneIdFromUrl`, `sceneCustomFieldsSupported`, `refreshStashCache` (Stash's Apollo cache) |
| `pluginApi.ts` | Minimal typing of `window.PluginApi` (React, patch, components, Event, StashService's Apollo client) |
| `cache.ts` | IndexedDB + memory cache, stale-while-revalidate, sorted by ELO; `setEloInCache`, `setRatingsInCache`, `removeSceneEverywhere` |
| `storage.ts` | `saveState` / `loadState` / `clearState` (localStorage, versioned) |
| `filters.ts` | URL filter parsing (`getSceneFilter`, `translateJSON`), `getFindFilter`, `readFilters`, `buildFilterKey`, `checkForFilters`, `scenesListQuery` (the query, on Scenes pages only) |
| `navigation.ts` | `navigateToUrl` (History API + popstate for React Router) |
| `pairs.ts` | Matchmaking: `fetchSwissPair`, `fetchPlacementPair`, `fetchChampionPair`, `loadPoolSize`, `pairRanks`, `currentFilters` (a battled Explore filter, else the URL filter), `leastTestedSource`, filtered-pool shuffle (`getNextFilteredScene`, internal) |
| `rating.ts` | Writes: `writeElo` (ELO, battles and record in one request), `restoreElo` and `eloWritesSettled` (undo), `noteTopScene` (hall of fame), `clearElo`, `writeStashRatings`, `applyStashRatings`, `queueRatingWrite`, `scheduleStashRatingSync` / `syncStashRatings`, `SCENE_MISSING_EVENT` |
| `eloSetup.ts` | One-time ELO setup: `fetchSetupScenes`, `setupRatingChanges`, `runEloSetup` |
| `sceneActions.ts` | `findExistingSceneIds`, `isSceneNotFoundError` (deleted-scene detection) |
| `ui/sceneCard.ts` | `createSceneCard`, `tierPill`, `formatDuration` |
| `ui/screens.ts` | `showVictoryScreen`, `showPlacementScreen` (both with "↶ Undo") |
| `ui/exploreTab.ts` | The 🔎 Explore tab: `createExploreTab`, `renderExploreTab`, `setExploreFilters` (Stats opens it at an ELO range) |
| `ui/statsTab.ts` | The 📊 Stats tab: `createStatsTab`, `renderStatsTab`; the charts are hand-drawn SVG |
| `ui/recordsTab.ts` | The 🏆 Records tab: `createRecordsTab`, `renderRecordsTab` |
| `ui/miniCard.ts` | The small cards of Explore, Records and the Stats hover card: `miniCardHtml`, shared previews (`startMiniPreview`, `stopMiniPreview`, one at a time), touch taps (`handleMiniThumbTap`, `handleMiniMuteTap`), `escapeHtml`, `plural`, `sceneUrl` |
| `ui/mainUI.ts` | `createMainUI`, `renderPair`, `loadNewPair`, `restoreCurrentPair`, `verifyCurrentPair`, `handleSceneGone`, `skipPair`, `setActionsVisible`, `applyPreviewSettings`, `updateClimbPoolWarning`, `updateRatingsNote`, `updatePoolStatus`, choice handling (`resolveComparison`), win chances at the VS, rating animation, undo (`undoLastPick`, `canUndo`, `clearUndo`), shared helpers (`isTouchDevice`, `handleSceneLinkClick`, `sliderToVolume`) |
| `ui/setupScreen.ts` | The ELO setup / Reset ELO screen: `showSetupScreen`, `hideSetupScreen`, `isSetupRunning` |
| `ui/ratingPreview.ts` | The setup's 10-scene preview: `renderRatingPreview`, `showRatingPreview` (animated in place) |
| `ui/stashRatingsText.ts` | Labels and descriptions of the three Stash ratings options (shared by setup and Settings) |
| `ui/confirmDialog.ts` | In-modal confirmation dialog with an async action (`confirmDialog`, `isConfirmDialogOpen`, `cancelConfirmDialog`) |
| `ui/settingsPanel.ts` | The tab bar, Battle · Explore · Stats · Records · Settings (`createTabBar`, `showTab`, `getActiveTab`), preview volume + mute button, Settings tab rows, `bindSettingsControls` / `syncSettingsControls` |
| `ui/deleteDialog.ts` | Clean mode: bridge that opens Stash's own `DeleteScenesDialog` (`registerDeleteDialogBridge`, `confirmDeleteScene`) |
| `ui/navButton.ts` | `registerNavButton`: the menu link and the top-bar icon |
| `ui/sceneElo.ts` | `registerSceneElo`, `refreshSceneElo`: the ELO and rank on Stash's scene pages (toolbar) |
| `ui/icons.ts` | `SWORDS_PATHS`: the crossed swords (navbar button and top-bar icon, scene page ELO) |
| `ui/modal.ts` | `openModal`, `closeModal`, tab wiring (the actions Explore and Stats call: battle a scene, the least-tested, an Explore filter), keyboard handler, Stash ratings switch confirmation, Reset ELO |
| `main.ts` | Entry point: `init()` + `DOMContentLoaded` bootstrap |

The modules have intentional circular references (e.g. `navigation` → `modal` → `mainUI` → `screens` → `mainUI`). These are safe because every cross-module reference is a runtime function call, not a top-level access, and all exports are hoisted function declarations.

### Build tooling

- **esbuild** ([`scripts/build.mjs`](scripts/build.mjs)) bundles `src/main.ts` → `plugins/stash-battle/stash-battle.js` as an IIFE. esbuild transpiles but does **not** type-check.
- **TypeScript** ([`tsconfig.json`](tsconfig.json), `strict: true`) is used purely for type-checking via `tsc --noEmit`.
- **Headless harness** ([`scripts/harness.mjs`](scripts/harness.mjs)): `playwright-core` drives the Chrome (or Edge) already installed, headless, against the running Stash (`STASH_URL`, default `http://localhost:9999`). Every `/graphql` request goes through a fake layer, so **nothing is ever written to Stash**: `real` mode passes reads through and refuses every mutation; `fresh` hides Stash Battle's config and `stash_battle_*` fields (a first install) and keeps writes in memory, so later reads see them; `old` answers the custom-fields introspection without them; `big` serves a seeded synthetic library of any size. A privacy guard runs before Stash's scripts (the page behind the modal, images and videos hidden; titles, studios, performers and tags become placeholders). Both scripts snapshot Stash's scenes and Stash Battle's config before and compare after.
- **Screenshots** ([`scripts/screenshots.mjs`](scripts/screenshots.mjs)): the README / forum shots as lossless PNGs, desktop at 2x (1040 px wide window, the modal box clipped) and phone at 3x (393 x 852, touch, hover off). The setup shot answers the config without `eloSetupAt` and hides the "earlier setup didn't finish" notice. Champion's streak and Placement's picks are made with their writes refused. The scene-page shots (`scene-page`, `phone-scene-page`) open a tiered scene's page and make only the toolbar (wide) or the subheader (phone) visible, so the scene's title, cover and video never show; Stash's own page writes (play activity) are refused like the rest.
- **Smoke checks** ([`scripts/smoke.mjs`](scripts/smoke.mjs)): `fresh` runs a first install twice ("Use my ratings" + Don't update, "Start everyone at 1500" + Percentile): setup, picks, records, undo, every mode and tab, no page errors. `old` checks the "needs a newer Stash" message. `big [size]` times opening, a pick, each tab, Explore's sort and search on a synthetic library (default 20,000 scenes) and reports the longest main-thread block. Measured Oct 2026: 20,000 scenes open in about 1 s and every tab in under 0.2 s; 50,000 open in 1.6 s, Stats in 0.5 s. (Stash's own time to return a big library isn't included: the synthetic library is served instantly.)
- **Tests** ([`scripts/test.mjs`](scripts/test.mjs)): Node can't run TypeScript directly, so the script bundles `tests/*.test.ts` with esbuild into `.test-build/` and runs them with Node's built-in test runner. The pure modules (`elo.ts`, `score.ts`, `placement.ts`, `stats.ts`, `explore.ts`) and `mergeConfig` / the hall of fame helpers (`tests/settings.test.ts`) are tested directly; `tests/sync.test.ts` covers the Stash rating sync and the Apollo refresh with a fake `fetch` and a fake `PluginApi`.

### npm scripts

| Command | What it does |
|---|---|
| `npm run build` | Production bundle → `plugins/stash-battle/stash-battle.js` |
| `npm run dev` | Watch `src/`, rebuild on save, deploy bundle + css + yml into the live Stash plugins folder (when `STASH_PLUGINS_DIR` is set) |
| `npm run typecheck` | Strict type-check (`tsc --noEmit`) |
| `npm test` | Unit tests (`tests/*.test.ts`) |
| `npm run smoke` | Headless smoke checks against the running Stash, nothing written (`-- fresh`, `-- old`, `-- big [size]`) |
| `npm run screenshots` | Retake the README screenshots into `docs/screenshots/` (`-- battle,gems` for some), nothing written |

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
Scenes matching the current URL filter parameters (`c`, `q` params), also sorted by ELO. If no filter is active, this equals `allScenes`. Used exclusively for the **left side** — the "scenes to be rated" pool. While an Explore filter is being battled, it replaces the URL filter (`currentFilters()`, see Battling an Explore filter).

### `opponentPool` (right side)
Determined per-fetch in each mode function (`buildOpponentPool`):

```
if a battled Explore filter → filteredScenes when explorePoolWithin(), else allScenes with an ELO
else if filterOpponents AND hasFilter → opponentPool = filteredScenes
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
- Both write the in-memory lists back to IndexedDB (`persistCacheSoon`, debounced 1 s, keeping each entry's timestamp so the 5-minute expiry is unchanged). Without it, a reload within 5 minutes read the copy from before the battles: old ELO, old order, so ranks lagged until the Refresh button.
- **`refreshSceneInCache(fresh)`** brings a scene's cached copies in line with values fetched on their own: the forced scene-page scene (`fetchSceneById` in `loadNewPair`), and a restored pair (`verifyCurrentPair` now fetches `rating100` and `custom_fields` with its existence check, updates the pair's objects, then calls this). They can be newer than the cache, e.g. after battles in another tab.

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
| `stash_battle_wins` / `stash_battle_losses` | Picks won and lost (Swiss, Champion, and each pick of a Placement run) |
| `stash_battle_peak` | Highest ELO reached (starts at the ELO before the scene's first recorded pick) |
| `stash_battle_streak` / `stash_battle_best_streak` | Current and longest win streak |

`EloFields` (`types.ts`) is `{ elo, battles, seeded, record? }`; `eloCustomFields()` turns it into the map Stash stores. Every write sends the first three, plus the five **record** fields once the scene has a record (`sceneRecord`), in the **same** `sceneUpdate`: `writeElo(scene, elo, battles, results)` works the new record out with `recordAfter` (`results` are the picks in order, true = won). Placement runs keep their `results` and add them when the scene lands. Battles from before records began have no win/loss: such a scene shows "Battles: N" until its next pick (`recordText` is null for it). `RECORD_FIELD_KEYS` lists the record fields, `ELO_FIELD_KEYS` all eight, for removal (setup, Reset ELO, `clearElo`). Stash's Custom Fields table is widened (CSS) to fit `stash_battle_best_streak`.

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

### Win chances, provisional ELO and tiers

- **Win chances** (`winChances` in `elo.ts`): each side's `eloExpected` as a whole percent, clamped to 1-99 (100% would read as a sure thing) and rounded so the pair adds up to 100. Shown at the VS between the cards (`vsDivider` in `mainUI.ts`): `58%` VS `42%` over a thin two-colour bar, the favourite brighter; on phones in the VS pill. They use the ELO the pick will use (`battleElo`: unrated = 1500 in Swiss, 1000 in Champion). **Hidden in Placement**: its scene's ELO doesn't change per pick, and an unrated one has no ELO.
- **Upset!**: the rating animation adds a small "Upset!" on the winner when its chance was **`UPSET_MAX_CHANCE` (40%) or less** (`resolveComparison` returns `upset`). Under 50% would flag about half of all Swiss picks; 35% almost never fires with the ±100 Swiss window.
- **Provisional** (`isProvisional` in `score.ts`): rated and `kGames` below the first K tier's limit (10, read from `ELO_K_TIERS`, so retuning K moves both): the stage where each battle moves the ELO by up to 40. Seeded scenes start past it. Shown as a `?` after the ELO (`ELO 1540? · #212`, tooltip "Provisional: …") on cards and the scene page button.
- **Tiers** (`TIERS` in `constants.ts`, `tierMap` in `stats.ts`): by rank among **settled** scenes (rated, not provisional), so every tier always has scenes whatever the library's spread. Tied scenes share their group's middle position (as in `percentileRatings`), so they share a tier. Provisional and unrated scenes get none.

| Tier | Who | Colour |
|---|---|---|
| 👑 Legendary | top 1% | #ff5277 |
| 💎 Diamond | top 5% | #3d9bff |
| 🔷 Platinum | top 15% | #2ee0c0 |
| 🥇 Gold | top 35% | #ffd23f |
| 🥈 Silver | top 65% | #8f99a5 |
| 🥉 Bronze | the rest | #c46a2b |

  The colours were checked with a palette validator (colour-blind, normal-vision and contrast checks all pass). The tier pill (`tierPill` in `sceneCard.ts`, tooltip from `tierDescription`) always shows: battle cards, small cards, the scene page icon. `tierBorders` (default on) also colours the battle cards' borders; small cards always have tier borders. `cachedTierMap` works the map out again only when the all-scenes array or any scene's ELO or battles changed (one cheap pass builds the key), since cards, Explore and the scene page all ask for it.

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
   (or, with "Battle the least-tested" on, the fewest-battled scene; see Stats)
2. Collect the opponents within **±`SWISS_OPPONENT_ELO_WINDOW` (100) ELO** of its ELO (`swissOpponentIndexes` in `score.ts`; unrated counts as 1500), or the `SWISS_OPPONENT_MIN_CANDIDATES` (10) nearest when fewer are in range
3. Pick randomly from candidates

The old window was ±10 ranks: a median farthest opponent of 20 ELO, about a third of them exact ties, which teaches little. Live, 25 pairs under ±100 had gaps up to 100, average 40.

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

Each card shows: screenshot (with preview video), title, duration, the **tier pill** and **ELO badge**, studio, performers, play count, **Record**, **Stash Rating**, tags, and a "Choose This Scene" button.

- **ELO badge** (`.sb-scene-rank`): `ELO 1740 · #50` (rank when known), `ELO 1540?` while provisional. Unrated: `ELO 1500 · Unrated` in Swiss, `ELO 1000 · Unrated` in Champion, plain `Unrated` in Placement.
- **Tier pill** (`.sb-tier`) before it: emoji and name (emoji only on phones). With `tierBorders` the card's border takes the tier colour (`data-tier`); untiered cards keep the grey border. Hover never changes the border colour (blue would read as Diamond).
- Meta lines (the Stash rating as Stash shows it: "7.4" or "3.5★", see `ratingDisplay.ts`): "Record: 12–5" (`.sb-meta-battles`; "Battles: N" for a scene whose battles all came before records; hidden wherever Play Count is) and "Stash Rating: 74/100" (or "None"). Where Play Count and the record line are hidden (tablets, phones, short screens) the record follows the rating instead: "74/100 · 12–5" (`.sb-meta-record-inline`).

Card media structure: `.sb-scene-media` wraps the thumbnail **link** (`a.sb-scene-image-container`, holding the `img` and `video`) plus sibling overlays (duration, status badge, click hint, ↗ open link, 🗑 delete button). Overlays are siblings, not children, so SFW blur on the link doesn't blur them; non-interactive overlays use `pointer-events: none` so hover still reaches the link.

**Card border and corners** (see Pitfalls): the card has no CSS border. Its 2px border is a `::after` layer drawn **on top** of the content (`--sb-card-border`: #333, hover #0d6efd, winner #28a745, loser #dc3545), so content is clipped once, at the card's outer rounded edge. The thumbnail container, image and preview video carry the card's 12px top corners themselves. The layer sits at z-index 101, so anything that must show above the cards (the mode tooltips) uses a higher one (200). Small cards (Explore, Records, hover cards) use the same `::after` border; their thumbnail starts 1px inside the card (margin `1px 1px 0`, 9px corners), because a cropped picture let a faint line through the doubly anti-aliased edge under the dark grey border of untiered cards.

**SFW Switch compatibility**: the thumbnail link, image, video, scene info and end-screen image also carry the plugin's pre-2.0 `pwr-*` class names (`pwr-scene-image-container`, `pwr-scene-image`, `pwr-hover-preview`, `pwr-scene-info`). The SFW Switch plugin's CSS still targets those names to blur Stash Battle — **don't remove them**.

**Thumbnail click**: plain click → SPA `navigateToUrl`; ctrl/cmd/shift/middle click → native new tab; with `openInNewTab` → `target="_blank"`. A click on the rest of the card (title, details, Choose) picks it.

**Touch screens** (`isTouchDevice()` in `mainUI.ts`: `(hover: none)`, the one check every module uses):
- A thumbnail tap only plays / stops that card's preview, with sound. (A second tap opening the scene was tried and dropped: it was confusing.) The card's details still pick it, and the **↗** link (top right, touch only) opens the scene.
- A **🔊/🔇 button** at the preview's bottom left (`.sb-card-mute`) shows whether that card's preview is heard and mutes / unmutes just that preview (`toggleCardSound`, the card's `sb-card-muted` class); unmuting at volume 0 turns the volume back on (through the tab bar's speaker, which remembers the level).
- Small cards (Explore, Records) work the same: a thumbnail tap plays / stops (`handleMiniThumbTap`), the mute button sits over the thumbnail (`.sb-mini-overlay`, `handleMiniMuteTap`), and the info below opens the scene.
- Phone thumbnails and previews use `object-fit: cover`, so the 2:1 box has no black bars.

**Previews**: hovering a card plays its preview at `previewVolume` (0 = muted). With `autoplayPreviews`, both previews loop muted as soon as the pair renders and hovering only unmutes. `applyPreviewSettings()` re-applies volume/autoplay to rendered videos (slider moves, setting changes, modal reopen).

**Badges** (over the screenshot), via the `statusBadge` parameter of `createSceneCard`:
- Win streak: `🔥 X wins` (number) — Champion's champion, and "Start from the bottom" runs before their first loss
- Placement range: `📍 Narrowing between #lo and #hi` (string)

### Scene Pool Status Line and Notes

- `#sb-pool-status` (above the cards, every mode) says where the left-side scenes come from, as one line: a battled Explore filter, "Battle the least-tested", or "Rating scenes from your Scenes page filter · N scenes" + "· against each other" with "Use filtered scenes for both sides", else "· against your whole library" (the same words as a battled Explore filter), or "Rating scenes from your whole library · N scenes · filter the Scenes page to narrow it down". `restoreCurrentPair` loads the pools in the background via `loadPoolSize()` to fill in the count.
- `#sb-ratings-note`: see Stash Ratings Update Mode.
- `#sb-climb-pool-warning`: see Filter opponents + Champion.

### Mode Tooltips

Each mode button carries a short explanation in `data-tip` (from `MODES` in `mainUI.ts`), rendered by a CSS `::after` tooltip on hover (0.35s delay) or keyboard focus, and mirrored in `aria-description`. The tooltip uses `white-space: pre-line`, so a `\n` in a tip starts a new line (Placement's tip points Gauntlet users to "Start from the bottom" after a blank line). The first and last buttons anchor their tooltip to their outer edge so it isn't clipped.

Touch screens have no hover, so `(hover: none)` shows an **ⓘ** button at the end of the mode row; it toggles `#sb-mode-info` with the current mode's explanation (`updateModeInfo()`, `\n` → `<br>`). Three modes plus ⓘ fit on one row down to 320px, icons included.

### Action Bar (Skip / Refresh)

`setActionsVisible()` is the only thing that shows/hides `.sb-actions`: **every `renderPair` shows it**, the error screen shows it, and only end screens hide it. The bar is `position: sticky; bottom: 0` inside the scrolling modal content so Skip stays reachable.

### Layout

- Cards sit side by side down to 640px wide; the card row's max width is tied to viewport height (`calc(135vh + 120px)`) so 16:9 thumbnails don't push the choose buttons off short screens.
- `max-height: 900px` (laptops): compact header (smaller title, no mode descriptions), play count, battles and tags hidden.
- `≤1000px`: play count, battles and tags hidden, smaller VS.
- `≤640px` (phones): full-screen modal (`100dvh`), stacked compact cards (2:1 thumbnails, one meta line, short "✓ Choose"), the VS pill (with the win chances) sits centred in an 18px gap between the cards (8px clear of each), mode buttons as a segmented row, compact tab bar; the Stash ratings dropdown and Reset ELO rows stack.
- Phones: the modal's sideways scroll is pinned to 0 (focus or scroll-into-view could shift an `overflow-x: hidden` box), and charts clip to their own box.

### Rating Animations

After each Swiss / Champion pick, an overlay counts the **ELO** change in whole points:
- Green overlay with `+X` on the winner, red with `−X` on the loser (75% opaque over the card)
- Step speed scales with |change| so large jumps finish within the window; small changes use ~50ms per point
- Overlay removed after **1400ms**; next pair loads after **1500ms**
- The overlay has no border-radius of its own: the card clips it (see Card border and corners)
- No glows: the winning card's green and the loser's red are border colours only, and the VS text has no shadow
- "Upset!" under the winner's change when it had 40% or less (see Win chances)
- The next pair loads from one timer (`scheduleNextPair`), so an undo can cancel it

### Victory / Placement Screens

- **Victory** (Champion, or a "Start from the bottom" climb that never lost): crown, "CHAMPION!", "Reached the top: N wins in a row!", final ELO
- **Placement**: pin, "PLACED!", streak (bottom runs), rank, battles, final ELO
- With a Stash ratings update mode on, the ELO line also shows `Stash Rating: N`: the scene's target from `stashRatingTargets` over the all-scenes cache (the cache already has the new ELO), so it's what the sync writes, even if that write is still on its way
- Both show "Start New Run" (`#sb-new-run`), which resets run state, and "↶ Undo" (`#sb-end-undo`, styled like the action bar's, under it in `.sb-end-actions`) while the pick that ended the run can be undone
- No glow. They use the cards' entry animation (`fadeIn`, 0.3s); while an end screen shows, the battle area has `overflow: clip` (`.sb-comparison-area:has(> .sb-end-screen)`), because the end screen sits flush with the window's bottom (the action bar is hidden) and the slide-in would otherwise make the content 20px taller for a moment and flash a scrollbar.

### Keyboard Shortcuts

| Key | Action |
|---|---|
| Escape | Close the modal; cancels a confirmation dialog instead when one is open (does nothing while Stash's delete dialog is open — Stash's modals ignore Escape too) |
| Left Arrow | Choose left scene (presses its Choose button) |
| Right Arrow | Choose right scene |
| Space | Skip (disabled while a Champion/Placement run is active) |
| Backspace | Undo the last pick |

**Key containment**: while the modal is visible, every `keydown` is stopped in the capture phase (`stopImmediatePropagation`, no `preventDefault`), and `keypress`/`keyup` are swallowed by `addKeySwallowers()`. Stash's hotkeys (Mousetrap on `document`) therefore never act on the page behind the modal, while default actions — typing in inputs, slider arrows, checkbox Space — still happen.

Battle shortcuts only work on the Battle tab, and not while ELO setup is showing or a confirmation dialog is open. They're ignored while focus is in a text/number/range input or a select, but still work with a checkbox focused. While Stash's delete dialog is open, Stash Battle stops intercepting keys entirely so the dialog gets them.

---

## Explore, Stats and Records Tabs

All three are built from Stash Battle's all-scenes cache (`getAllScenesCached`, ELO-sorted) each time the tab opens: no extra requests. They share the **small card** (`ui/miniCard.ts`): thumbnail, tier pill and tier-coloured border (always, whatever `tierBorders` says), `ELO 1820 · #97`, then plays, battles and the record ("12–5"). Clicking a small card opens the scene page (`handleSceneLinkClick`, so "Open scenes in a new tab" applies); its ⚔️ button battles it (Battle tab, `loadNewPair(sceneId)`, like opening from a scene page). Hovering plays the preview at the preview volume, one at a time (`startMiniPreview` / `stopMiniPreview`); while it plays the thumbnail is hidden, and any tab change stops it. Small cards carry the SFW Switch `pwr-*` class names too.

### Explore (🔎)

The whole library as small cards, a page at a time.

- **Search** (title or file name, studio, performers), **chips** for each tier, Provisional and Unrated, an **ELO range** (a range leaves unrated scenes out), and **sorts**: ELO high/low, plays most/least, battles most/least, best record (wins − losses, then wins), highest peak ELO, longest win streak. Record sorts put scenes without a record last; ties keep the ELO order. All pure, in `src/explore.ts`.
- **Pages**: `explorePageSize` cards per page (30 / 60 / 120 / 240 / All; a dropdown in the status line, saved in the plugin config, not in the yml), with ‹ / page dropdown / › at the top and bottom. Only the bottom pager scrolls back up. Card clicks are ignored for 700 ms after a page change (a quick second click on › landed on a card). `scrollbar-gutter: stable` while Explore shows, so the page doesn't shift when the scrollbar comes and goes.
- The filters survive switching tabs and closing the modal (module state, not saved).
- Stats opens Explore at a histogram bar's ELO range (`setExploreFilters`), scrolled so the scene-count line sits just above the first row.

#### Battling an Explore filter

The status line offers **"⚔️ Battle these N scenes"** for any filter that has scenes (**"📍 Place these N scenes"** for Unrated, **"🔁 Keep testing these N scenes"** for Provisional). It sets `state.explorePool` (`{ filters, label }`) and switches to the Battle tab:

- The filter's scenes **replace the Scenes page filter** as the left pool: `currentFilters()` in `pairs.ts` returns a filter keyed `explore:<filters JSON>`, and `loadScenePools` takes the scenes from `explorePoolScenes` (the Explore filtering itself), recomputed on every pick. So placed scenes leave an Unrated pool, and the shuffle skips scenes that have left the pool since it was made.
- **Who they battle** (`filterBattlesWithin(filters, bothSides)`, read each pick through `explorePoolWithin()` so the setting applies at once): it follows "Use filtered scenes for both sides" like the Scenes page filter. Off: the filter's scenes vs the whole rated library. On: within the filter. **Unrated always battles the library** and switches to Placement: placing a scene among other unrated ones (none has an ELO) would land them all at 1500.
- The pool status line names it ("Battling from Explore: **👑 Legendary · ELO 1600–1700** · N scenes · against your whole library") with a **Stop** link (`stopExplorePool` in `modal.ts`). It survives mode changes and closing Stash Battle, and ends on Stop (or "Battle the least-tested", which turns it off).

### Stats (📊)

Hand-drawn SVG (no chart library), sized to the panel and redrawn on resize. Titles show only on hover or tap.

1. **Overview**: scenes with an ELO, unrated, provisional, total battles (sum of `stash_battle_battles`).
2. **How settled**: bars for 0, 1-9, 10-29 and 30+ real battles (the K tiers, `settledBuckets`; the seeded head start doesn't count). **"Battle the least-tested (N scenes)"** sets `state.leastTested`: Swiss takes the scene with the fewest real battles on the left (`leastTested`: random among equals, never the one just shown) instead of the shuffle, until Stop (the pool line above the cards reads "Battling your least-tested scenes first, from your whole library · N scenes · Stop", in place of the usual line, as a battled Explore filter's does), a mode change, or battling a scene or an Explore filter; it survives closing Stash Battle. The pool is the Scenes page filter's scenes, or the whole library (`leastTestedSource`), unrated scenes included; the description spells out the count ("557 scenes have no battles yet: 461 with an ELO and 96 unrated"), from `leastTestedPool`.
3. **ELO distribution**: a histogram in 25-ELO bars (50-ELO under 500px wide), with the Stash rating scale for the current update mode under it (Straight-line ticks with the clamped zones shaded, or Percentile ticks) and a note for a big tie ("142 scenes still tied at 1500", `largestTie`). Clicking a bar opens Explore at its range; on touch a tap pins "ELO 1600–1649: 55 scenes" with a "🔎 See them in Explore" button.
4. **Hidden gems / overplayed**: ELO up, play count across (square-root scale), split at the median ELO and play count (`gemsSplit`, `gemsQuadrant`): top left "Hidden gems", bottom right "Overplayed". Hovering a dot shows its small card beside the pointer, kept inside the chart; clicking opens the scene page. On touch a tap pins the card (link + ⚔️); the pinned card ignores the tap's own `pointerleave`.

The click handler is bound once per panel (`dataset.bound`), not on every render.

### Records (🏆)

- **Hall of fame**: every scene that has ever been #1, newest first by the time it first got there, as small cards with the date. The newest 10 show, with "Show all (N)" (the stored list isn't capped).
- **Longest win streaks** and **highest peak ELOs**: the top 5 each (`topByRecord`), from the record fields.
- Opening the tab calls `noteTopScene()` first, so the current #1 is always in the list.

#### Hall of fame storage

`statsHallOfFame` in the plugin config: a JSON string of `[{ id, date }]` (ISO time it first reached #1).

- `noteTopScene()` runs after each ELO write: if the library's #1 (the all-scenes cache's first scene) is rated and not in the list, `addToHallOfFame` adds it.
- Saves go through `saveConfig`'s queue and **merge** with the stored list (`mergeHallOfFame`: one entry per scene, the earliest date kept, sorted by full time), so two tabs can't drop each other's entries.
- `parseHallOfFame` drops anything unreadable: entries need a string id and a date `Date.parse` can read.
- Setup and Reset ELO empty it (`clearHallOfFame`), and so does **Settings → ELO → Clear hall of fame** (a confirmation dialog, `confirmClearHallOfFame` in `modal.ts`; the current #1 joins again on the next ELO write or Records opening). Undo removes an entry the undone pick added (`keepOnlyHallOfFame`).
- **A database restore doesn't touch it.** Stash keeps plugin settings in its config file (`config.yml`), not the database, so restoring a database backup brings back old scenes, ELO and records but leaves the hall of fame (and every other Stash Battle setting, `eloSetupAt` included) as they were. That's what Clear hall of fame is for.

---

## Undo Last Pick

**↶ Undo** in the action bar (and Backspace) takes back the last pick; end screens show their own "↶ Undo" next to Start New Run, since the action bar is hidden there. One level.

- `handleSceneChoice` takes a `PickSnapshot` before the pick: the mode, the pair and its ranks, the ELO fields of every scene the pick writes (both in Swiss and Champion; Placement's scene, which is written when it lands), Champion's run (scene, wins, defeated), a copy of the Placement run, and the hall of fame's ids.
- `undoLastPick` cancels the next-pair timer (`scheduleNextPair`) and bumps `pairLoads`, so a pair load already under way stops before showing anything (each `loadNewPair` checks it's still the newest after every await). It waits for writes still on their way (`eloWritesSettled`), then `restoreElo` writes each scene's fields back exactly: a scene that had no record loses the record fields its pick created, and one that was unrated loses its ELO again. Nothing is written when the fields already match.
- Then the run state, the mode (if it changed since), and the same pair come back, to pick again. Rated scenes' Stash ratings follow their restored ELO on the next sync. A scene the pick took from unrated to rated is different: the sync gave it a Stash rating, and the sync only writes scenes with an ELO, so it would never take that back. The snapshot keeps each scene's `rating100`, and `restoreElo` puts it back (or clears it) in the same `sceneUpdate` that removes the ELO fields.
- Setup and Reset ELO clear the snapshot (`clearUndo`): its values no longer apply. Checked live in all three modes, including Placement mid-run and after landing.

---

## Settings

**UI**: the modal header has a Stash-style tab bar (`nav nav-tabs`): **⚔️ Battle** · **🔎 Explore** · **📊 Stats** · **🏆 Records** · **⚙️ Settings** on the left, the preview volume on the right (visible on every tab). On phones ≤480px the volume slider hides (the speaker still mutes; a "Preview volume" row appears in Settings instead, `sb-setting-phone-only`), and the tabs you're not on show only their emoji (≤360px: every tab), each at least 44 × 44px, names kept as `aria-label` / tooltip. The tabs shrink and scroll sideways rather than widen the modal. Tabs swap `.sb-tab-panel` elements in place. The Settings tab reuses Stash's `.setting-section` / `.setting` rows and `custom-switch` toggles; `.sb-settings-tab` only re-tints them. The dropdown is drawn in the modal's dark palette with a chevron (Stash sets `appearance: none` on selects). The modal always reopens on the Battle tab. While Settings is showing, battle shortcuts are off and previews are paused.

Sections: **ELO** (Stash ratings update mode, Reset ELO, Clear hall of fame), **Battles**, **Scenes**.

Stored in Stash's plugin config (`configuration.plugins["stash-battle"]`, written with `configurePlugin`) so they follow the user across devices; most are also declared under `settings:` in `stash-battle.yml` so they appear in Stash → Settings → Plugins. `openModal()` awaits `loadSettings()` each time, and a reused modal re-syncs its controls.

| Key | Default | Effect |
|---|---|---|
| `stashRatings` | `"off"` | Stash ratings update mode — see that section. Not in the yml |
| `eloSetupAt` / `eloSetupMode` | `null` | Set when ELO setup finishes (ISO time; `"ratings"` / `"fresh"`). Not in the yml or the Settings tab |
| `placementFromBottom` | false | Placement's "Start from the bottom" |
| `filterOpponents` | false | Right side obeys the list filter too |
| `openInNewTab` | false | Thumbnail opens the scene in a new tab |
| `tierBorders` | **true** | Battle cards' borders take their tier's colour (the pill always shows). Replaces 3.0's earlier `showTiers` |
| `explorePageSize` | 60 | Explore cards per page (30 / 60 / 120 / 240, or 0 = all). Set from Explore's dropdown; not in the yml or the Settings tab |
| `statsHallOfFame` | — | The hall of fame (JSON string). Not a setting: kept by `mergeConfig` (see Records) |
| `previewVolume` | 50 | Preview volume on a cubic curve (`video.volume = (v/100)³`, so 50 ≈ 0.125), 0 = muted (slider on the tab bar; the speaker mutes / restores) |
| `autoplayPreviews` | true | Loop both previews muted; hover to hear |
| `cleanMode` | false | 🗑 delete button on each card |
| `pauseMediaOnOpen` | **true** | Pause Stash's playing video/audio when Stash Battle opens. Stash's plugin settings page shows unset booleans as off, but a missing key means the default (on) |

- `configurePlugin` **replaces** the whole map, so every save sends every key (`updateSettings` debounced 400ms for the slider; `updateSettingsNow` for setup's flags). Null values are left out. A save re-reads the stored config and builds the map with `mergeConfig`: the stored map (keys that aren't settings, like `statsHallOfFame`, are **kept**), its settings normalized, this tab's unsaved keys on top, then any `extra` keys, minus `REMOVED_KEYS`. So a tab that loaded settings before another tab finished the setup can't undo it. Config writes run one at a time (`saveConfig`'s queue), each starting from what the last one saved.
- `REMOVED_KEYS` (`funMode`, `unratedRating`, `showTiers`) are dropped on the next save; an unknown `stashRatings` becomes `"off"`.
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

**Restoring a saved pair**: `restoreCurrentPair` first checks the pair belongs to the current run (`pairMatchesRun`: Placement's run scene on the left, or the champion in the pair); a pair without its run (from before runs cleared their pair on the end screen) loads a new pair instead, since picks would have nothing to act on. Then the ranks are worked out again from the current pools (`pairRanks` in `pairs.ts`), not the saved ones. Finished runs clear `currentPair` (`finishRunShowEndScreen`), and a reopened modal keeps showing the end screen.

**Deleted elsewhere**: `restoreCurrentPair` and the reused-modal path call `verifyCurrentPair()` (aliased `findScene` lookups via `fetchSceneFields` — `findScenes(ids:)` errors if any id is missing), and a write that fails with "not found" dispatches `SCENE_MISSING_EVENT`; all of them route to `handleSceneGone`.

---

## State Persistence

State is saved to `localStorage` under `"stash-battle-state"` after every battle and on certain mode changes. Restored on modal open.

**Saved fields**: `version`, `currentPair`, `currentRanks`, `currentMode`, `championScene`, `championWins`, `championDefeated`, `placement`, `totalScenesCount`, `savedFilterParams`. (Settings are not here — they live in Stash's plugin config.) A battled Explore filter and "Battle the least-tested" live only in memory: they survive closing and reopening the modal, but not a page reload. Records and the hall of fame are in Stash (custom fields, plugin config), never in browser storage.

**Versioning**: `STATE_VERSION` is 3 (3.0). An older save keeps only its mode and filter params — its scenes lack custom fields and Gauntlet runs no longer exist — so the pair and run start fresh. A saved `currentMode` of `"gauntlet"` loads as `"placement"`.

**Filter change detection**: `savedFilterParams` stores the URL search string. If it differs on modal open, run state and caches are reset.

### Scene Page Battle

When the Battle button is clicked on an individual scene page (`/scenes/123`):

1. `getSceneIdFromUrl()` extracts the scene ID from the URL pathname
2. If the scene is already in `currentPair.left` or `currentPair.right`, the existing pair is restored normally
3. Otherwise a new battle is forced: run state reset, `currentPair` / `currentRanks` cleared, `fetchSceneById()` loads the scene, and it's passed as `forcedLeftScene` through `loadNewPair` → the active mode's fetch, replacing the normal `getNextFilteredScene()` pick

---

## URL Filter Integration

The plugin reads Stash's URL filter parameters to determine which scenes to show, **only on Scenes pages** (`/scenes`, and `/scenes/:id`, which keeps the list's query): `scenesListQuery()` returns "" anywhere else, because Stash Battle opens from every page and other pages' queries filter their own lists (`/performers?q=anna` isn't a scene search). Everything that uses the query goes through it: the filter itself, the saved state's filter check, and the scene links on cards.


- **`q`** parameter: text search query
- **`c`** parameters: structured criteria (JSON-encoded with `()` instead of `{}`)
- **`sortby`** / **`sortdir`**: sort options

`getSceneFilter()` parses these into a GraphQL `SceneFilterType`. Supported criterion types: boolean, stringEnum, multi, hierarchicalMulti, resolution, orientation, duplicated, and standard numeric/string comparisons. **Custom-field criteria are not handled** (no special case for Stash's `custom_fields` criterion list), so a Scenes-page filter on `stash_battle_elo` isn't known to carry into Stash Battle; untested. Stash's own numeric custom-field filters are broken anyway (Common Pitfalls #19).

---

## GraphQL Integration

All data comes from Stash's GraphQL API:

- **`findScenes`**: scene lists with `per_page: -1` (sorted client-side by ELO); a slim `id rating100 custom_fields` version for setup and the Stash ratings switch (`fetchSetupScenes`)
- **`findScene`**: a single scene (scene page battle); aliased batches check whether the current pair still exists
- **`sceneUpdate`** with `custom_fields: { partial | remove }`: ELO writes (`writeElo` sends the ELO, battles, seeded flag and record together; `restoreElo` for undo; `clearElo`). `partial` and `remove` can be combined in one input.
- **`bulkSceneUpdate`**: setup ("Use my ratings": one aliased call per distinct rating; "Start everyone at 1500": one call, every id), removing stale ELO, and Stash rating writes (`writeStashRatings`: one aliased call per distinct value, in one request)
- **`__type(name: "Scene")`** introspection: the custom-fields capability check
- Clean mode deletes go through Stash's own dialog (its `scenesDestroy` mutation)
- **`configuration { plugins }`** / **`configurePlugin`**: settings
- **Fragment fields** (`SCENE_FRAGMENT`): `id`, `title`, `date`, `rating100`, `play_count`, `custom_fields`, `paths` (screenshot, preview), `files` (duration, path), `studio` (name), `performers` (name), `tags` (name). `custom_fields` includes other plugins' fields too.
- Stash updates a scene's `updated_at` on any write, even one that changes nothing visible.

---

## Common Pitfalls & Edge Cases

1. **Never write `rating100` outside the Stash ratings sync.** Battles write ELO only (`writeElo`); Stash ratings change only through `writeStashRatings` (setup, the dropdown switch, `syncStashRatings`). The one exception: undoing a pick that rated an unrated scene puts back the Stash rating the sync wrote for it (`restoreElo`, see Undo Last Pick).

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

13. **Rounded corners and clipping** (the card): don't put the card's border back on the card box. A CSS border's inner edge and the `overflow: hidden` clip of the content are two curves in the same place, each anti-aliased against the dark card background, which shows as a dark seam at the corners (worst under the green/red rating overlay). The border is an `::after` drawn on top, so content is clipped once. Playing videos can also be composited outside the parent's rounded clip, so the thumbnail, image and video carry the 12px top corners themselves. Don't give the rating overlay its own radius either. **Tried and reverted:** a 2px `box-shadow` ring just outside the card (`0 0 0 2px`) instead of the `::after` layer. It stopped a playing video (a GPU layer) from painting over the border on phones, but brought the inner-corner seam back, so it went; insetting the preview video 2px instead showed the thumbnail around the video, so that went too. The mobile video-over-border bleed is accepted as it is.

14. **Stash's settings rows give buttons a right margin** (`.setting-section .setting > div:last-child .btn`); the Reset ELO button overrides it with a more specific selector so it lines up with the other controls.

15. **Stash's `.nav-tabs` margins**: Stash centers `.nav-tabs` with auto margins; `.sb-tabs.nav-tabs { margin: 0 }` keeps the tabs left-aligned next to the volume control.

16. **Stash's modals ignore Escape**: Stash's `ModalComponent` sets `keyboard: false` and no backdrop `onHide`, so its delete dialog closes only via Cancel/Delete. Stash Battle matches that rather than force-closing it.

17. **Setup flags and `configurePlugin`**: because `configurePlugin` replaces the whole map, `eloSetupAt` / `eloSetupMode` / `stashRatings` must go through `updateSettings` / `updateSettingsNow` and `normalize()`, or the next settings save drops them. Keys that aren't settings (`statsHallOfFame`) survive only because `mergeConfig` starts from the stored map; write them through `saveConfig`'s `extra`, never with a separate `configurePlugin` call (it would race the queue).

18. **Other tabs**: each tab keeps its own in-memory cache, so battles in one tab reach another only when its cache refreshes (5 minutes, or the Refresh button). A restored pair and a scene-page scene are fetched fresh, so their own ELO is always current; the rest of the order catches up on refresh.
19. **Stash's custom-field filters don't compare numbers** (v0.31.1): on a numeric field like `stash_battle_elo`, `EQUALS` and `GREATER_THAN` match nothing, `LESS_THAN` matches every scene, and `BETWEEN` matches nothing; `NOT_NULL` and boolean `EQUALS true` work. The filter value seems to be compared as text against the stored number (SQLite sorts every number below every text). Same family as [stashapp/stash#5682](https://github.com/stashapp/stash/issues/5682). So ranks are counted client-side, and Scenes-page filters on ELO or battles give wrong results in Stash itself, before Stash Battle sees them. Don't store ELO as text to work around it: it would break numeric order everywhere else.

20. **Sticky `:hover` on touch screens**: after a tap, mobile browsers keep `:hover` on the tapped element until something else is tapped. Code that asks "is this card hovered / active?" must ignore `:hover` when `isTouchDevice()`, or a second thumbnail tap reads the card as still active (it did: a second tap failed to mute). Use `isTouchDevice()` from `mainUI.ts` rather than a new `matchMedia` check.

21. **Anything that loads a pair must check it's still wanted**: `loadNewPair` awaits several fetches, and an undo (or a newer load) can happen in between. Each load takes a number from `pairLoads` and returns after every await if a newer one started (`superseded()`); `undoLastPick` bumps the counter too. Without it, the pair loaded for after the pick replaced the undone pair a moment later.

22. **Phones and sideways scroll**: anything with `white-space: nowrap` or a fixed minimum width can widen the modal (or Stash's page) past the screen. The tab bar did (now shrinking, scrolling tabs), and the scene page button in Stash's toolbar did (now in the subheader on phones). Check new rows at 320-393px.

23. **Background tabs**: the browser runs no animation frames, `IntersectionObserver` callbacks may not arrive, and elements have no layout (zero rects). Use timers for anything that must run while hidden (the scene page button), and don't measure layout until the tab is visible again (the top-bar icon waits for `visibilitychange`). Explore uses real pages instead of endless scrolling partly for this reason.

24. **A battled pool changes as you battle** (an Explore filter on Unrated loses each scene it places): the left pool is worked out again on every pick, and `getNextFilteredScene` skips shuffled scenes that are no longer in it. Battling a scene that shares its ELO with others moves it to the end of its tie group, so its rank can change within the tie (#5 can show as #13).

25. **Never show a raw `rating100`** ("74/100") in the UI: Stash shows ratings as a 0-10 decimal or as stars (`configuration.ui.ratingSystemOptions`), and so does Stash Battle, through `formatRating` / `ratingValue` in `ratingDisplay.ts` (loaded with the settings: `loadSettings` asks for `configuration { plugins ui }`). Examples in descriptions use `exampleRating`, because on whole stars a stored 50 (1500 ELO) has no star value of its own.
