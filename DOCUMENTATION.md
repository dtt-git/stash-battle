# Stash Battle — Technical Documentation

> For LLM agents and contributors working on the plugin. This documents the nuanced behavior, architecture, and design decisions that aren't obvious from the code alone.

## ⚠️ Keeping This Document Up To Date

**This file must be updated whenever you change behavior in the plugin.** If you modify rating logic, scene pool filtering, mode behavior, caching, UI components, or any other documented behavior, update the relevant section here in the same changeset.

When adding new features or fixing bugs:
1. Update any existing sections that are affected by your change
2. If the change introduces a subtle edge case or non-obvious behavior, add it to the **Common Pitfalls & Edge Cases** section
3. If you add a new mode, config option, or major feature, add a new section for it

If you're an LLM agent: read this file before making changes to understand existing behavior, and update it after making changes to keep it accurate.

---

## Architecture Overview

The plugin is authored in **strict TypeScript** under [`src/`](src/) and bundled by **esbuild** into a single IIFE at `plugins/stash-battle/stash-battle.js` — which is the file Stash actually injects into its UI (alongside a CSS file and a YAML manifest). The committed `stash-battle.js` is a **build artifact**; never edit it by hand — edit the TypeScript modules and rebuild. The plugin adds a "Battle" button to the `/scenes` page that opens a modal where users compare scenes head-to-head to build rankings via an ELO system.

> The bundle output must remain a single IIFE with no `import`/`export`, because the distribution path (`stash-battle.yml` → `build_site.sh` → GitHub Pages index) ships exactly the files in `plugins/stash-battle/`. esbuild's `format: "iife"` guarantees this.

### Entry Flow

1. `init()` fires on `DOMContentLoaded`
2. `injectNavButton()` injects a nav item on `/scenes` pages (list and individual scene pages)
3. A `MutationObserver` re-adds the button on SPA navigation (Stash uses React Router)
4. Clicking the button opens `openModal()` which renders the full battle UI
5. If opened from an individual scene page (`/scenes/123`), the scene is forced onto the left side of a new battle — unless it's already one of the two scenes in the current pair, in which case the existing pair is restored

### Core State

All shared mutable state lives on a single `state` object exported from [`src/state.ts`](src/state.ts) (type `BattleState`). Modules read and write it as `state.currentMode`, `state.gauntletClimber`, etc.

> **Why a central object instead of module-level `let`s?** ES modules cannot reassign a binding imported from another module (`import { x }` is read-only at the importer). The original monolith used closure-scoped `let`s freely; after splitting into modules, every value that is *reassigned* from more than one module must live on a shared object. So `currentMode = "swiss"` became `state.currentMode = "swiss"`. Values that are only mutated within one module stay local to it (e.g. `lastShownSceneId` in `pairs.ts`, `modalKeyHandler` in `ui/modal.ts`).

Key fields:

| Field | Purpose |
|---|---|
| `state.currentPair` | `{ left, right }` — the two scenes currently displayed |
| `state.currentRanks` | `{ left, right }` — rank positions for display |
| `state.currentMode` | `"swiss"`, `"placement"`, `"gauntlet"`, or `"champion"` |
| `state.gauntletClimber` | The scene actively climbing the ladder (on a win streak) in gauntlet/champion modes |
| `state.gauntletWins` | Current win streak count |
| `state.gauntletClimberRank` | Climber's rank position in the opponent pool (1 = top) |
| `state.gauntletDefeated` | Array of scene IDs the climber has beaten (prevents rematches) |
| `state.gauntletFalling` | Boolean — true when the climber lost and is finding their floor |
| `state.gauntletFallingScene` | The scene object currently in falling mode |
| `state.placement` | The in-progress Placement run (`PlacementRun`), or `null` — see Placement Mode |
| `state.totalScenesCount` | Size of the opponent pool (used for "Rank #X of Y" display) |
| `state.leftPoolSize` | Size of the left ("to rate") pool — filter or whole library — for the status line; `null` until pools load |
| `state.settings` | User settings (`Settings` in `types.ts`), loaded from Stash's plugin config — see Settings |
| `state.memoryCache` | In-memory scene cache (see Caching Strategy) |
| `state.shuffledFilteredScenes` / `state.shuffleIndex` / `state.shuffleFilterKey` | Filtered-pool shuffle traversal |

Helpers in `state.ts`: `resetRunState()` clears gauntlet/champion **and** placement run fields between runs; `resetShuffle()` forgets the left-side shuffle; `isRunActive()` says whether a run is under way (Skip is disabled while it is).

> **Terminology**: During a gauntlet/champion **run**, the left-side streak holder is `gauntletClimber`. **Champion** means either the **Champion** game mode or the end-of-run victor on the victory screen — not the in-run state field (which was formerly named `gauntletChampion`).

---

## Project Structure & Build

### Source layout (`src/`)

| Module | Responsibility |
|---|---|
| `types.ts` | Shared types: `Scene` (mirrors `SCENE_FRAGMENT`), `Mode`, `Settings`, `PlacementRun`, `Pair`, `Ranks`, GraphQL response shapes, pair-result shapes |
| `constants.ts` | `STORAGE_KEY`, `CACHE_DB_*`, `PLUGIN_ID`, `DEFAULT_SETTINGS`, `SWISS_OPPONENT_REACH_*`, `CLIMB_OPPONENT_PICK_WINDOW`, `CLIMB_SMALL_POOL_WARN_AT`, `CLIMB_K_PLAY_COUNT`, legacy localStorage pref keys, `DELETE_FILE_PREF_KEY` |
| `state.ts` | Central mutable `state` object + `resetRunState()`, `resetShuffle()`, `isRunActive()` |
| `settings.ts` | `loadSettings` / `updateSettings` — settings in Stash plugin config (`configurePlugin`) |
| `graphql.ts` | `graphqlQuery`, `SCENE_FRAGMENT`, `FIND_SCENES_QUERY`, `fetchSceneById`, `getSceneIdFromUrl` |
| `cache.ts` | IndexedDB + memory cache, stale-while-revalidate, `updateSceneInCache`, `repositionSceneInArray`, `removeSceneEverywhere` |
| `storage.ts` | `saveState` / `loadState` / `clearState` (localStorage) |
| `filters.ts` | URL filter parsing (`getSceneFilter`, `translateJSON`), `getFindFilter`, `readFilters`, `buildFilterKey`, `checkForFilters` |
| `navigation.ts` | `navigateToUrl` (History API + popstate for React Router) |
| `pairs.ts` | Matchmaking: `fetchSwissPair`, `fetchPlacementPair`, `fetchGauntletPair`, `fetchChampionPair`, `recordPlacementResult`, `applyClimbWinRating`, `findLowestRated`, filtered-pool shuffle (`getNextFilteredScene`, internal) |
| `elo.ts` | `getKFactor`, `effectiveRating`, `calculateRatingChanges` (pure ELO math) |
| `rating.ts` | `updateSceneRating`, `ratingsEnabled` (fun mode gate), `SCENE_MISSING_EVENT` |
| `sceneActions.ts` | `findExistingSceneIds`, `isSceneNotFoundError` (deleted-scene detection) |
| `ui/sceneCard.ts` | `createSceneCard`, `formatDuration` |
| `ui/screens.ts` | `showVictoryScreen`, `showPlacementScreen` |
| `ui/mainUI.ts` | `createMainUI`, `renderPair`, `loadNewPair`, `restoreCurrentPair`, `verifyCurrentPair`, `handleSceneGone`, `skipPair`, `setActionsVisible`, `applyPreviewSettings`, `updateClimbPoolWarning`, scene choice handling, rating animation |
| `ui/settingsPanel.ts` | Battle / Settings tab bar (`showTab`, `getActiveTab`), preview volume + mute button, Settings tab rows, `bindSettingsControls` / `syncSettingsControls` |
| `ui/deleteDialog.ts` | Clean mode: bridge that opens Stash's own `DeleteScenesDialog` (`registerDeleteDialogBridge`, `confirmDeleteScene`) |
| `ui/navButton.ts` | `shouldShowNavButton`, `injectNavButton` |
| `ui/modal.ts` | `openModal`, `closeModal`, keyboard handler |
| `main.ts` | Entry point: `init()` + `DOMContentLoaded` bootstrap |

The modules have intentional circular references (e.g. `navigation` → `modal` → `mainUI` → `screens` → `mainUI`). These are safe because every cross-module reference is a runtime function call, not a top-level access, and all exports are hoisted function declarations.

### Build tooling

- **esbuild** ([`scripts/build.mjs`](scripts/build.mjs)) bundles `src/main.ts` → `plugins/stash-battle/stash-battle.js` as an IIFE. esbuild transpiles but does **not** type-check.
- **TypeScript** ([`tsconfig.json`](tsconfig.json), `strict: true`) is used purely for type-checking via `tsc --noEmit`.

### npm scripts

| Command | What it does |
|---|---|
| `npm run build` | Production bundle → `plugins/stash-battle/stash-battle.js` |
| `npm run dev` | Watch `src/`, rebuild on save, deploy bundle + css + yml into the live Stash plugins folder (when `STASH_PLUGINS_DIR` is set) |
| `npm run typecheck` | Strict type-check (`tsc --noEmit`) |

### Dev deploy + live reload

`npm run dev` writes each rebuild straight into the live Stash plugins folder. The target is read from `STASH_PLUGINS_DIR` (set it in a gitignored `.env` — see `.env.example`), resolving to `<STASH_PLUGINS_DIR>/stash-battle`; if it's unset or `none`, deploying is skipped. `build.mjs` loads `.env` via Node's built-in `process.loadEnvFile()`, so machine-specific paths never get committed.

**No auto-reload in the browser:** Stash's CSP allows `connect-src` only to `'self'`, `data:`, `ws:`, and `wss:` — so a dev-time `EventSource` to `http://localhost:7331` (esbuild's live-reload SSE) is blocked. After each save, refresh Stash manually (F5). The value of `npm run dev` is watch + deploy, not automatic page refresh.

---

## The Two Sides

The battle UI always shows two scenes:

- **Left side (scene1)**: Drawn from the **filtered pool** — these are the scenes the user wants to rate. In gauntlet/champion modes, this is the active **climber** (`gauntletClimber`).
- **Right side (scene2)**: Drawn from the **opponent pool** — these serve as rated benchmarks for comparison.

This distinction is fundamental to the entire plugin.

---

## Scene Pools

### `allScenes`
All scenes in the Stash library, sorted by `rating` DESC via GraphQL. Fetched once and cached aggressively. Includes both rated and unrated scenes.

### `filteredScenes`
Scenes matching the current URL filter parameters (`c`, `q` params). If no filter is active, this equals `allScenes`. Used exclusively for the **left side** — the "scenes to be rated" pool.

### `opponentPool` (right side)
Determined per-fetch in each mode function:

```
if filterOpponents AND hasFilter → opponentPool = filteredScenes
else → opponentPool = allScenes (rated only)
```

**Critical behavior**: When the opponent pool comes from `allScenes`, unrated scenes are **excluded** (`rating100 != null` filter). This prevents unrated scenes from appearing as right-side opponents. If no rated scenes exist yet (bootstrap), it falls back to `allScenes` including unrated.

**Exception**: When `filterOpponents` is true and a filter is active, the filtered pool is used as-is for both sides — unrated scenes may appear on the right if the filter includes them. This is intentional for scenarios like filtering for "unrated only" on both sides to bootstrap ratings.

### `totalScenesCount`
Set from `opponentPool.length` (not `allScenes.length`), so the "Rank #X of Y" display is consistent with the pool the ranks come from.

---

## Caching Strategy

### Three Layers

1. **Memory cache** (`memoryCache`) — instant, lives for the session
2. **IndexedDB** (`stash-battle-cache` DB) — survives page reloads
3. **Network** (GraphQL) — source of truth, slowest

### Stale-While-Revalidate

On cache hit, the data is returned immediately. If the cache is older than `CACHE_MAX_AGE_MS` (5 minutes), a background refresh is kicked off (not awaited) to update the cache for next time.

### Cache Keys

- `"all-scenes"` — all scenes, no filter
- `"filtered-scenes"` — single slot for filtered scenes (overwrites on filter change to prevent IndexedDB bloat)

### `filterKey`

A JSON string of the current filter parameters. Stored alongside the filtered cache to detect when the filter has changed and the cache is stale.

---

## Filtered Pool Management

### Shuffled Traversal

Filtered scenes are shuffled (Fisher-Yates) and traversed sequentially via `shuffleIndex`. This ensures every scene is shown once before any repeat. The shuffle is invalidated when the filter changes (`shuffleFilterKey` check).

### Pool Recycling (scenes stay in the pool)

Since 2.7, battled scenes are **not** removed from the filtered pool — every scene stays available on both sides, and the shuffle simply starts a new pass when it reaches the end.

At the end of each full pass (`isShuffleCycleComplete` in `pairs.ts`), `loadScenePools` clears the filtered cache and **re-queries the filter from Stash** before reshuffling. Filters whose membership depends on rating (e.g. "rating is null") therefore still shrink naturally as scenes get rated — just once per pass instead of after every battle.

`updateSceneInCache` repositions the scene in **both** `allScenes` and `filteredScenes`, because the filtered list doubles as the (rating-sorted) opponent pool when filter-opponents is on.

---

## Rating / ELO System

### Scale
Ratings are integers from **1 to 100**. Clamped with `Math.min(100, Math.max(1, ...))`.

### Unrated Scenes
Unrated scenes (`rating100 = null`) count as the **`unratedRating`** setting in **Swiss** (`effectiveRating(rating100, unratedRating)`, clamped to ≥1). The default `0` means rating **1** — start at the bottom and earn the way up; `50` is closer to a classic ELO start. Swiss matchmaking also places an unrated left scene where that rating would sit in the sorted pool, instead of at the bottom.

Gauntlet/Champion always treat unrated as 1 regardless of the setting: their climb logic uses the climber's pool position, so a mid-pool starting rating would skip every opponent between the bottom and 50.

### ELO Formula

```
ratingDiff = loserRating - winnerRating
expectedWinner = 1 / (1 + 10^(ratingDiff / 40))
winnerGain = max(1, round(K * (1 - expectedWinner)))
loserLoss = max(1, round(K * expectedWinner))
```

The divisor of 40 (instead of standard chess 400) is because the rating scale is 1-100 instead of ~800-2800.

### K-Factor (Dynamic)

Based on `play_count` — scenes with more plays have more stable ratings:

| Play Count | K-Factor | Category |
|---|---|---|
| < 3 | 12 | New — volatile, find true rating fast |
| < 8 | 8 | Settling — moderate changes |
| < 15 | 6 | Established — smaller changes |
| ≥ 15 | 4 | Very established — stable |

**Gauntlet/Champion climber wins**: When the active climber (or falling scene) wins, K uses `CLIMB_K_PLAY_COUNT` (0 → K=12) instead of the scene's real `play_count`. Swiss and non-climber sides still use actual play count.

### Mode-Specific Rating Behavior

**Swiss mode**: True ELO — both sides get rating changes based on their respective K-factors.

**Gauntlet/Champion modes**: Only the **active climber** (or falling scene) gets rating changes. Defenders are benchmarks — their ratings stay the same. Exception: if a **100-rated** defender loses, they drop to 99 (dethrone mechanic — breaks ties at the top of the scale).

**Champion mode loss**: When the climber loses, their rating is **preserved** — they earned it through wins. The winner becomes the new climber. No ELO penalty.

**Placement mode**: No per-battle ELO. One rating is written at the end, between the final neighbours (see Placement Mode).

**Fun mode** (setting): `ratingsEnabled()` is false → `updateSceneRating` is a no-op, `resolveComparison` returns zero deltas, and handlers skip their **local** `rating100` mutations too (climber bumps, champion takeover, falling floor, placement result, gauntlet's first-choice clear). Rating overlays are hidden and end screens note the rating wasn't saved. Local mutations matter because scene objects are shared with the cache — changing them would reorder ranks without a matching Stash write.

**Fun mode in Gauntlet**: a real run clears a rated challenger's rating so it climbs from the bottom. Fun mode can't, so on the first choice `gauntletClimber` becomes an in-memory **copy** with `rating100: null` (the cached object is untouched). `climberPoolIndex()` treats a rating-less climber as unplaced (-1), so it climbs from the bottom through every undefeated scene. On a loss the copy becomes `gauntletFallingScene`, and since its rating never rose, falling starts just below the scene that beat it (`gauntletDefeated[0]`) instead of at its untouched real rank. Swiss, Placement and Champion need nothing special: they just don't write.

---

## Game Modes

### Swiss Mode

The default mode. Pairs scenes with similar ratings for meaningful comparisons.

**Pairing logic**:
1. Pick the next scene from the shuffled filtered pool (left side)
2. Find its position in the opponent pool (sorted by rating DESC)
3. If the scene is unrated (or not in the opponent pool), position it where `effectiveRating` would sit in the sorted pool (the end, with the default `unratedRating` of 0)
4. Collect candidates within ±N of that position (starts at `SWISS_OPPONENT_REACH_INITIAL`, doubles until candidates exist — important for tiny pools where the initial reach may exceed pool size)
5. Pick randomly from candidates

**After battle**: Both get ELO updates. Both stay in the pool (see Pool Recycling).

### Placement Mode

Finds a scene's spot with as few battles as possible — a bounded search with momentum ("ping-pong") instead of Gauntlet's climb. Lives in `fetchPlacementPair` / `recordPlacementResult` (`pairs.ts`) and `handlePlacementChoice` (`mainUI.ts`); Gauntlet and Champion are untouched.

- The pool is the usual rating-sorted opponent pool **minus** the scene being placed. The scene's slot lies in `[lo, hi)`. A **win** against index *i* sets `hi = i`; a **loss** sets `lo = i + 1`. Bounds are stored as the bounding opponents' ids (`aboveId` / `belowId`) and resolved to indices on every fetch, so a background cache refresh can't corrupt them.
- **Rated scene**: starts right below its current rating (`insertionIndex`) and **gallops** — each same-direction result doubles the step (1, 2, 4, 8…), measured from the far edge of the last opponent's **tie group** (another scene with the same rating teaches nothing). The first reversal switches to bisection. A correctly rated scene confirms in ~2–4 battles; a badly mis-rated one costs ~2·log2(distance).
- **Unrated scene**: plain bisection from the middle — ⌈log2(N+1)⌉ battles (≈9–10 for ~500 rated scenes).
- Opponents with equal ratings are interchangeable: `pickAmongTies` chooses randomly among them within bounds.
- **Done** when `lo >= hi`. Rating = `round((above + below) / 2)` when there's an integer strictly between the neighbours, else the **above** neighbour's rating (ties sort first-come in `repositionSceneInArray`, so this keeps the rank). Edges: top = below + 1, bottom = above − 1. Written once via `updateSceneRating`; the placement screen shows rank and battle count.
- The run is created when the pair **loads** (`battles = 0`), so Skip still works before the first choice and resets the run.
- Badge on the scene: `📍 Narrowing between #lo and #hi` — the range of ranks it can still land in (no pick count; it was more confusing than useful).

### Filter opponents + Gauntlet/Champion

When **`filterOpponents` is on** and a **URL filter is active**, left and right draw from the same filtered list. Gauntlet and champion still use the **same ELO-relative climb rules** as the full-library case (index-based remaining opponents, falling mode on mid-run loss, global floor on first pair).

**Small pools**: With fewer than `CLIMB_SMALL_POOL_WARN_AT` (10) scenes in the filter, results can feel odd — e.g. starting near the top of the list may end the run after only a few fights without facing every scene. The UI shows a warning when this combination applies.

When filter opponents is off, the opponent pool is the full rated library.

### Gauntlet Mode

A climb-the-ladder mode where a challenger fights their way up from the bottom.

**Initial pairing**:
1. Pick the next scene from the shuffled filtered pool as challenger (left side)
2. Find the **lowest actually rated** scene in the opponent pool (`findLowestRated`)
3. Display: challenger vs that floor benchmark

**Rated challenger — re-verify on first choice** (gauntlet only):
- If the challenger already has a rating, it is **cleared** (`rating100 → null`) when you make your **first choice** in the run — not when the pair loads

**First battle — challenger loses**:
- `gauntletClimber` is set to the left-side scene **before** ELO runs
- Placement rating: `max(1, winner.rating - 1)`
- Placement rank: `#totalScenesCount`
- Run ends — no falling mode

**Climbing**:
- Climber wins → opponent added to `gauntletDefeated`, streak increments, climber's rating increases via ELO
- Next opponent: picked randomly from up to `CLIMB_OPPONENT_PICK_WINDOW` of the closest undefeated opponents above the climber (by index or rating)
- `repositionSceneInArray` moves the climber in `allScenes` after rating changes

**Climber loses (mid-run)** → **Falling mode**:
- The old climber becomes `gauntletFallingScene`; pairing/ELO use the faller via `gauntletFalling` + `activeClimberId()`
- `gauntletDefeated` is reset to `[winnerId]` (tracks who beat them for bottom placement)
- Falling scene faces opponents **below** it in the ranking to find its floor

**Falling mode outcomes**:
- Falling scene **wins**: Found their floor. Rating set to `loserRating + 1`. Rating animation, then placement screen.
- Falling scene **loses**: Keep falling. Winner added to `gauntletDefeated`.
- **Hits the bottom** (no opponents below): Rating set to `max(1, lastOpponent.rating - 1)`.

**Victory**: When `remainingOpponents` is empty, the climber has conquered the opponent pool. On the winning choice (after ELO), if the pool is cleared their rating is bumped above the last beaten opponent when needed (`applyClimbWinRating` in `pairs.ts`).

### Champion Mode

Like gauntlet but simpler — winner always takes over, no falling.

**Key differences from Gauntlet**:
- **No re-verify**: rated challengers are **not** cleared on first choice
- When the climber loses, they keep their earned rating — the **winner becomes the new climber** and the run continues
- **No falling mode**

---

## UI Behavior

### Scene Cards

Each card shows: screenshot (with preview video), title, duration, rank, studio, performers, play count, current rating, tags, and a "Choose This Scene" button.

Card media structure: `.sb-scene-media` wraps the thumbnail **link** (`a.sb-scene-image-container`, holding the `img` and `video`) plus sibling overlays (duration, status badge, click hint, ↗ open link, 🗑 delete button). Overlays are siblings, not children, so SFW blur on the link doesn't blur them; non-interactive overlays use `pointer-events: none` so hover still reaches the link.

**SFW Switch compatibility**: the thumbnail link, image, video, scene info and end-screen image also carry the plugin's pre-2.0 `pwr-*` class names (`pwr-scene-image-container`, `pwr-scene-image`, `pwr-hover-preview`, `pwr-scene-info`). The SFW Switch plugin's CSS still targets those names to blur Stash Battle — **don't remove them**.

**Thumbnail click**: plain click → SPA `navigateToUrl`; ctrl/cmd/shift/middle click → native new tab; with `openInNewTab` → `target="_blank"`. On touch devices (`(hover: none)`) a tap toggles the preview with sound instead, and the ↗ link opens the scene.

**Previews**: hovering a card plays its preview at `previewVolume` (0 = muted). With `autoplayPreviews`, both previews loop muted as soon as the pair renders and hovering only unmutes. `applyPreviewSettings()` re-applies volume/autoplay to rendered videos (slider moves, setting changes, modal reopen).

**Badges** (displayed over the screenshot):
- Win streak: `🔥 X wins` (number — pass win count as `statusBadge` to `createSceneCard`)
- Falling mode: `📍 Finding final placement...` (string)
- Placement range: `📍 Narrowing between #lo and #hi` (string)
- The badge slot accepts either type via the `statusBadge` parameter on `createSceneCard`

### Scene Pool Status Line

`#sb-pool-status` (above the cards, every mode) says where the left-side scenes come from, since that's easy to miss: "Rating scenes from your Scenes page filter · N scenes" (+ "· opponents from the filter too" when `filterOpponents` is on), or "Rating scenes from your whole library · N scenes · filter the Scenes page to narrow it down". `loadScenePools` records `state.leftPoolSize`; `updatePoolStatus()` runs after every `renderPair` from `loadNewPair` and after `restoreCurrentPair`, which also loads the (cached) pools in the background via `loadPoolSize()` and re-runs `updatePoolStatus()` when they arrive, since a restored pair skips the normal fetch. On phones it's one ellipsized line without the trailing hint.

### Mode Tooltips

Each mode button carries a short explanation in `data-tip` (from `MODES` in `mainUI.ts`), rendered by a CSS `::after` tooltip on hover (0.35s delay) or keyboard focus, and mirrored in `aria-description`. The first and last mode buttons anchor their tooltip to their outer edge so it isn't clipped by the modal (the buttons sit in their own `.sb-mode-toggle` inside `.sb-mode-row`, so `:first-child`/`:last-child` still mean Swiss/Champion).

Touch screens have no hover, so `(hover: none)` shows an **ⓘ** button at the end of the mode row; it toggles `#sb-mode-info`, a panel with the current mode's explanation (`updateModeInfo()`, also refreshed on mode switch). Below 400px wide the mode icons are hidden so four modes + ⓘ fit on one row.

### Action Bar (Skip / Refresh)

`setActionsVisible()` is the only thing that shows/hides `.sb-actions`: **every `renderPair` shows it**, the error screen shows it, and only end screens hide it. (Before 2.7 several paths back to a pair forgot to un-hide it, so the buttons "disappeared" after a placement.) The bar is `position: sticky; bottom: 0` inside the scrolling modal content so Skip stays reachable.

### Layout

- Cards sit side by side down to 640px wide; the card row's max width is tied to viewport height (`calc(135vh + 120px)`) so 16:9 thumbnails don't push the choose buttons off short screens.
- `max-height: 900px` (laptops): compact header (no subtitle/mode descriptions), play count and tags hidden.
- `≤1000px`: play count and tags hidden, smaller VS.
- `≤640px` (phones): full-screen modal (`100dvh`), stacked compact cards (2:1 thumbnails, one meta line, short "✓ Choose"), VS badge overlaps the gap, mode buttons as a segmented row, compact tab bar.

### Rating Animations

After each battle, an overlay animates the rating change:
- Green overlay with `+X` for positive changes; red for negative (CSS class still follows winner/loser card)
- **Direction follows the numeric change**, not winner/loser role — a losing placement that raises rating (e.g. 0 → 89) counts **up**
- Step speed scales with |change| so large jumps (e.g. final victory bump) finish within the window; small changes use ~50ms per point
- Overlay removed after **1400ms**; next pair loads after **1500ms**
- Final climb win animates to the full victory-bump rating, not just the last battle's ELO delta

### Victory / Placement Screens

- **Victory**: Crown icon, "CHAMPION!", scene info, streak stats, **final rating**
- **Placement**: Pin icon, "PLACED!", final rank and rating
- Both show a "Start New Run" button that resets run state
- Placement runs also show the battle count; fun mode adds a "rating not saved" note

### Keyboard Shortcuts

| Key | Action |
|---|---|
| Escape | Close modal (does nothing while Stash's delete dialog is open — Stash's modals ignore Escape too) |
| Left Arrow | Choose left scene |
| Right Arrow | Choose right scene |
| Space | Skip (disabled while a gauntlet/champion/placement run is active) |

**Key containment**: while the modal is visible, every `keydown` is stopped in the capture phase (`stopImmediatePropagation`, no `preventDefault`), and `keypress`/`keyup` are swallowed by `addKeySwallowers()`. Stash's hotkeys (Mousetrap on `document`) therefore never act on the page behind the modal (e.g. arrows paging the scene list), while default actions — typing in inputs, slider arrows, checkbox Space — still happen.

Battle shortcuts only work on the Battle tab. They're also ignored while focus is in a text/number/range input (the volume slider keeps its arrow keys), but still work with a checkbox focused — focus stays on a checkbox after toggling it. While Stash's delete dialog is open, Battle stops intercepting keys entirely so the dialog gets them.

---

## Settings

**UI**: the modal header has a Stash-style tab bar (`nav nav-tabs`, the same pattern as Stash-TCode): **Battle** | **Settings** on the left, the preview volume on the right (visible on both tabs). Tabs swap `.sb-tab-panel` elements in place. The Settings tab reuses Stash's `.setting-section` / `.setting` rows and `custom-switch` toggles (Stash's global CSS styles them; `.sb-settings-tab` only re-tints them to Battle's palette). The modal always reopens on the Battle tab, and `#sb-modal` is anchored to the top (not vertically centered) so switching to the shorter Settings tab doesn't move the header. While Settings is showing, battle shortcuts are off and previews are paused (`applyPreviewSettings` checks `getActiveTab()`).

Stored in Stash's plugin config (`configuration.plugins["stash-battle"]`, written with `configurePlugin`) so they follow the user across devices; also declared under `settings:` in `stash-battle.yml` so they appear in Stash → Settings → Plugins (Stash needs a plugin reload to pick up YAML changes). `openModal()` awaits `loadSettings()` each time, and a reused modal re-syncs its controls.

| Key | Default | Effect |
|---|---|---|
| `funMode` | false | No rating writes (see Fun mode above); badge at the top of the Battle tab (not the header, so toggling it doesn't move the tab bar) |
| `openInNewTab` | false | Thumbnail opens the scene in a new tab |
| `unratedRating` | 0 | What unrated scenes count as in Swiss |
| `previewVolume` | 50 | Preview volume, 0 = muted (slider on the tab bar; the speaker icon mutes / restores the previous level) |
| `autoplayPreviews` | false | Loop both previews muted; hover to hear |
| `filterOpponents` | false | Right side obeys the list filter too |
| `cleanMode` | false | 🗑 delete button on each card |
| `pauseMediaOnOpen` | **true** | Pause Stash's playing video/audio when Battle opens (applied after `loadSettings`). Stash's plugin settings page shows unset booleans as off, but a missing key means the default (on) |

- `configurePlugin` **replaces** the whole map, so `updateSettings` always sends every key (debounced 400ms for the slider).
- Users with no saved config get defaults overlaid with the pre-2.7 localStorage toggles (`sb_filterOpponents`; `sb_mutePreviews=1` → volume 0).
- Every control has `data-setting="<key>"`; `bindSettingsControls` wires them generically and `onSettingChanged` in `modal.ts` applies side effects (reload pair for filterOpponents, re-render cards for openInNewTab/cleanMode/unratedRating, re-apply previews, fun badge).

## Clean Mode (deleting scenes)

With `cleanMode` on, each card has a 🗑 button that opens **Stash's own `DeleteScenesDialog`** — the same options ("Delete file (and funscript)", "Delete generated supporting files"), defaults (`configuration.defaults.deleteFile` / `deleteGenerated`), file list (incl. funscript; "moved to trash" when a trash path is set), delete mutation and "Deleted Scene" toast as deleting inside Stash. Stash also refreshes its own lists afterwards.

How the bridge works (`ui/deleteDialog.ts`):
- The dialog needs Stash's React context (intl, configuration, Apollo, toasts), so it can't be rendered standalone. `registerDeleteDialogBridge()` (called from `main.ts`) patches a tiny `DeleteBridge` component into `MainNavBar.UtilityItems` via `PluginApi.patch.after`; react-bootstrap portals the modal to `<body>`.
- `PluginApi.loadableComponents.DeleteScenesDialog` is a loader that resolves to the **module** — loading it does *not* add it to `PluginApi.components`. The bridge takes `mod.DeleteScenesDialog` from the module (preloaded at startup; `confirmDeleteScene` awaits it).
- `confirmDeleteScene(scene)` fetches the fields the dialog reads (`id title interactive files { path }`) and dispatches a cancelable `stash-battle:open-delete-dialog` event; the first mounted bridge `preventDefault`s it. Plugins load **after** Stash's first render, so on a fresh page the bridge may not be mounted yet: if nobody handles the event, Battle re-navigates to the current URL (`replaceState` + `popstate`, same URL) to re-render the navbar, then retries once.
- The dialog calls `onClose(true)` after a successful delete, `false` on cancel or error (Stash toasts errors itself). On `true` Battle runs `handleSceneGone(id)`.
- While Battle is open, `body.sb-battle-open` lifts Stash's `.modal` / `.modal-backdrop` above the battle modal (z-index 10060 / 10050).
- If this Stash doesn't expose `DeleteScenesDialog` to plugins, the bridge isn't registered and the 🗑 button is hidden.

After a delete, `handleSceneGone(id)`:

1. `removeSceneEverywhere` drops it from `allScenes`, `filteredScenes`, both IndexedDB entries and the shuffle (adjusting `shuffleIndex`) — no Refresh needed.
2. If it was the **left** scene or the run's scene (placement scene, climber, falling scene) → `resetRunState()` and a fresh pair.
3. Otherwise (an opponent) → drop it from `gauntletDefeated` and placement bounds, and `loadNewPair(leftId)`. Swiss and pre-run climbs keep the left scene via the forced-scene path; active runs ignore the forced id and simply re-run their current step.

**Deleted elsewhere**: `restoreCurrentPair` and the reused-modal path call `verifyCurrentPair()` (aliased `findScene` lookups — `findScenes(ids:)` errors if any id is missing), and a rating write that fails with "not found" dispatches `SCENE_MISSING_EVENT`; all of them route to `handleSceneGone`.

---

## State Persistence

State is saved to `localStorage` under `"stash-battle-state"` after every battle and on certain mode changes. Restored on modal open.

**Saved fields**: `currentPair`, `currentRanks`, `currentMode`, `gauntletClimber`, `gauntletWins`, `gauntletClimberRank`, `gauntletDefeated`, `gauntletFalling`, `gauntletFallingScene`, `placement`, `totalScenesCount`, `savedFilterParams`. (Settings are not here — they live in Stash's plugin config.)

**Migration**: Older saves used `gauntletChampion` / `gauntletChampionRank`; `loadState()` reads those as fallbacks when the new keys are absent.

**Filter change detection**: `savedFilterParams` stores the URL search string. If it differs on modal open, run state and caches are reset.

### Scene Page Battle

When the Battle button is clicked on an individual scene page (`/scenes/123`):

1. `getSceneIdFromUrl()` extracts the scene ID from the URL pathname
2. If the scene is already in `currentPair.left` or `currentPair.right`, the existing pair is restored normally (no disruption)
3. If the scene is NOT in the current pair, a new battle is forced:
   - Run state is reset
   - `currentPair` and `currentRanks` are cleared
   - `fetchSceneById()` loads the scene via GraphQL
   - The scene is passed as `forcedLeftScene` through `loadNewPair` → the active mode's fetch function
   - In all modes, the forced scene replaces the normal `getNextFilteredScene()` call for the left/challenger side

---

## URL Filter Integration

The plugin reads Stash's URL filter parameters to determine which scenes to show:

- **`q`** parameter: text search query
- **`c`** parameters: structured criteria (JSON-encoded with `()` instead of `{}`)
- **`sortby`** / **`sortdir`**: sort options (default: `rating` DESC)

`getSceneFilter()` parses these into a GraphQL `SceneFilterType`. Supported criterion types: boolean, stringEnum, multi, hierarchicalMulti, resolution, orientation, duplicated, and standard numeric/string comparisons.

---

## GraphQL Integration

All data comes from Stash's GraphQL API:

- **`findScenes`** query: fetches scene lists with `per_page: -1`, sorted by rating DESC
- **`findScene`** query: fetches a single scene by ID (scene page battle); aliased batches check whether the current pair still exists
- **`sceneUpdate`** mutation: writes rating changes back to Stash
- Clean mode deletes go through Stash's own dialog (its `scenesDestroy` mutation), not a Battle query
- **`configuration { plugins }`** query / **`configurePlugin`** mutation: settings
- **Fragment fields** (`SCENE_FRAGMENT` in `graphql.ts`): `id`, `title`, `date`, `rating100`, `play_count`, `paths` (screenshot, preview), `files` (duration, path), `studio` (name), `performers` (name), `tags` (name)

---

## Common Pitfalls & Edge Cases

1. **First gauntlet battle ELO**: `gauntletClimber` must be set *before* `calculateRatingChanges` runs (via `resolveComparison` in `mainUI`), otherwise the climber role is unassigned and no ELO change occurs.

2. **First battle loss**: Placement rating is always `max(1, winner.rating - 1)`. Rank is `#totalScenesCount`. Animation uses `rating100 ?? 0` as the start value.

3. **Small filtered pool + filter opponents**: Gauntlet/champion use ELO-relative win logic even when both sides draw from a small filter. The UI warns when the pool has fewer than `CLIMB_SMALL_POOL_WARN_AT` scenes.

4. **Unrated in opponent pool**: Without the rated-only filter, unrated scenes cluster at the bottom of the DESC-sorted list. Swiss mode's ±reach around an unrated left-side scene would pick other unrated scenes as opponents — defeating the purpose.

5. **Tiny Swiss pool + filter opponents**: Opponent reach starts at `min(SWISS_OPPONENT_REACH_INITIAL, pool.length)` and doubles until candidates exist — required for 2–3 scene filtered pools.

6. **Falling scene at the bottom**: If the falling scene was already the lowest-rated scene, `belowOpponents` is immediately empty. The rating is set to 1 below the last opponent's rating rather than hardcoded to 1.

7. **Climber loss in champion mode**: The climber keeps their rating when they lose — no ELO penalty. Falling mode does not apply; the winner takes over.

8. **`repositionSceneInArray`**: After a rating change, the scene is moved in `allScenes` to maintain global rankings.

9. **Scenes stay in the filtered pool**: there is no per-battle removal anymore (the old `removedSceneIds` / `removeFromFilteredPool` are gone). Rating-dependent filters shrink once per pass, when the filter is re-queried.

10. **Pool size for rank display**: `totalScenesCount` is set from `opponentPool.length`, not `allScenes.length`. This ensures "Rank #X of Y" is consistent when unrated scenes are excluded from the pool.

11. **Scene page battle with active gauntlet**: Opening battle from a scene page always resets gauntlet state if the scene isn't already in the pair. This prevents a forced scene from being injected mid-gauntlet-run, which would corrupt climber/defeated tracking.

12. **Scene page ID matching**: Scene IDs from the URL and from GraphQL are compared as strings via `String()`. The `getSceneIdFromUrl()` regex requires a pure numeric path segment (`/scenes/(\d+)$`) — tab paths like `/scenes/123/markers` won't match.

14. **Gauntlet skip before first choice**: Resets gauntlet run state but advances the shared-ladder shuffle — does not repeat the same challenger/opponent pair.

15. **Action bar visibility**: only `setActionsVisible()` may show/hide `.sb-actions`. Any new path that renders a pair must go through `renderPair` (which shows it).

16. **`[hidden]` vs component display**: `.sb-container [hidden]` / `#sb-modal [hidden]` force `display: none !important`, because component rules like `display: flex` otherwise override the `hidden` attribute.

17. **Placement ties**: with integer ratings, scenes inside a tie group are interchangeable as opponents, but the final slot can still land inside the group (the user may prefer one tied scene over another). The rating then equals the group's rating.

18. **Fun mode and shared scene objects**: scene objects in `currentPair`/runs are often the same objects as in the cache. Any new code that sets `scene.rating100` locally must check `ratingsEnabled()` first.

19. **Stash's `.nav-tabs` margins**: Stash centers `.nav-tabs` with auto margins; `.sb-tabs.nav-tabs { margin: 0 }` keeps Battle's tabs left-aligned next to the volume control.

20. **Stash's modals ignore Escape**: Stash's `ModalComponent` sets `keyboard: false` and no backdrop `onHide`, so its delete dialog closes only via Cancel/Delete. Battle matches that rather than force-closing it.

21. **Climber copies**: in fun-mode Gauntlet, `gauntletClimber`/`gauntletFallingScene` are copies of the scene, not the cached object, and the scene's real entry stays in the pool at its old rank. Compare by `id`, never by object identity, and get the climber's position from `climberPoolIndex()`.
