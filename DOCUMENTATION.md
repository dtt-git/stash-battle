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
| `state.currentMode` | `"swiss"`, `"gauntlet"`, or `"champion"` |
| `state.gauntletClimber` | The scene actively climbing the ladder (on a win streak) in gauntlet/champion modes |
| `state.gauntletWins` | Current win streak count |
| `state.gauntletClimberRank` | Climber's rank position in the opponent pool (1 = top) |
| `state.gauntletDefeated` | Array of scene IDs the climber has beaten (prevents rematches) |
| `state.gauntletFalling` | Boolean — true when the climber lost and is finding their floor |
| `state.gauntletFallingScene` | The scene object currently in falling mode |
| `state.totalScenesCount` | Size of the opponent pool (used for "Rank #X of Y" display) |
| `state.filterOpponents` | Whether the right-side pool obeys the same filter as the left side |
| `state.mutePreviews` | Whether hover-preview videos are muted |
| `state.memoryCache` | In-memory scene cache (see Caching Strategy) |
| `state.shuffledFilteredScenes` / `state.shuffleIndex` / `state.shuffleFilterKey` | Filtered-pool shuffle traversal |
| `state.removedSceneIds` | Scenes processed this session (survives background refresh) |

`resetGauntletState()` (also in `state.ts`) clears the climber/streak/falling fields between runs.

> **Terminology**: During a gauntlet/champion **run**, the left-side streak holder is `gauntletClimber`. **Champion** means either the **Champion** game mode or the end-of-run victor on the victory screen — not the in-run state field (which was formerly named `gauntletChampion`).

---

## Project Structure & Build

### Source layout (`src/`)

| Module | Responsibility |
|---|---|
| `types.ts` | Shared types: `Scene` (mirrors `SCENE_FRAGMENT`), `Mode`, `Pair`, `Ranks`, GraphQL response shapes, pair-result shapes |
| `constants.ts` | `STORAGE_KEY`, `CACHE_DB_*`, `DEFAULT_FILTER_OPPONENTS`, `SWISS_OPPONENT_REACH_*`, `CLIMB_OPPONENT_PICK_WINDOW`, localStorage pref keys |
| `state.ts` | Central mutable `state` object + `resetGauntletState()` |
| `graphql.ts` | `graphqlQuery`, `SCENE_FRAGMENT`, `FIND_SCENES_QUERY`, `fetchSceneById`, `getSceneIdFromUrl` |
| `cache.ts` | IndexedDB + memory cache, stale-while-revalidate, `updateSceneInCache`, `removeFromFilteredPool`, `repositionSceneInArray` |
| `storage.ts` | `saveState` / `loadState` / `clearState` (localStorage) |
| `filters.ts` | URL filter parsing (`getSceneFilter`, `translateJSON`), `getFindFilter`, `readFilters`, `buildFilterKey`, `checkForFilters` |
| `navigation.ts` | `navigateToUrl` (History API + popstate for React Router) |
| `pairs.ts` | Matchmaking: `fetchSwissPair`, `fetchGauntletPair`, `fetchChampionPair`, `findLowestRated`, filtered-pool shuffle (`getNextFilteredScene`, internal) |
| `elo.ts` | `getKFactor`, `calculateRatingChanges` (pure ELO math) |
| `rating.ts` | `updateSceneRating` (Stash mutation) |
| `ui/sceneCard.ts` | `createSceneCard`, `formatDuration` |
| `ui/screens.ts` | `showVictoryScreen`, `showPlacementScreen` |
| `ui/mainUI.ts` | `createMainUI`, `renderPair`, `loadNewPair`, `restoreCurrentPair`, scene choice handling, rating animation |
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

### `removedSceneIds`

A `Set` tracking scenes that have been processed this session. This survives background cache refreshes (which could re-add scenes to the memory cache). Scenes are removed from the filtered pool after each battle via `removeFromFilteredPool()`.

### Pool Exhaustion

When all filtered scenes have been processed (`getNextFilteredScene` returns `null`):
1. Clear filtered cache (memory + IndexedDB)
2. Reset shuffle state and `removedSceneIds`
3. Re-fetch from network
4. Retry — picks up newly-qualifying scenes (e.g., a scene that was just rated into the filter range)

---

## Rating / ELO System

### Scale
Ratings are integers from **1 to 100**. Clamped with `Math.min(100, Math.max(1, ...))`.

### Unrated Scenes
Unrated scenes (`rating100 = null`) are treated as rating **1** — they start at the bottom and earn their way up. This prevents the jarring behavior of unrated scenes jumping to mid-range after a single win.

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

### Mode-Specific Rating Behavior

**Swiss mode**: True ELO — both sides get rating changes based on their respective K-factors.

**Gauntlet/Champion modes**: Only the **active climber** (or falling scene) gets rating changes. Defenders are benchmarks — their ratings stay the same. Exception: if a **100-rated** defender loses, they drop to 99 (dethrone mechanic — breaks ties at the top of the scale).

**Champion mode loss**: When the climber loses, their rating is **preserved** — they earned it through wins. The winner becomes the new climber. No ELO penalty.

---

## Game Modes

### Swiss Mode

The default mode. Pairs scenes with similar ratings for meaningful comparisons.

**Pairing logic**:
1. Pick the next scene from the shuffled filtered pool (left side)
2. Find its position in the opponent pool (sorted by rating DESC)
3. If the scene isn't in the opponent pool (unrated), position it at the end (lowest ranked)
4. Collect candidates within ±10 of that position
5. If no candidates found, **expand the search** (double the reach) until candidates exist
6. Pick randomly from candidates

**After battle**: Both scenes are removed from the filtered pool. Both get ELO updates.

### Gauntlet Mode

A climb-the-ladder mode where a challenger fights their way up from the bottom.

**Initial pairing**:
1. Pick a scene from the filtered pool as the challenger (left side)
2. Find the **lowest actually rated** scene in the opponent pool (`findLowestRated` — explicitly skips unrated)
3. Display: challenger vs lowest rated (a rated challenger still shows its current rating/rank until you pick a side)

**Rated challenger — re-verify on first choice**:
- If the challenger already has a rating, it is **cleared** (`rating100 → null`) when you make your **first choice** in the run — not when the pair loads
- From that point the run treats the scene as unrated: floor test, per-battle ELO, climb from the bottom

**First battle special handling**:
- `gauntletClimber` is set to the left-side scene **before** ELO runs, so the first battle assigns the climber role correctly
- If the **left/challenger wins**: normal climb begins
- If the **challenger loses** to the floor benchmark (lowest rated opponent): they are **placed at the bottom** immediately — rank `#totalScenesCount`, rating `max(1, floorOpponent.rating - 1)` (just below this collection's floor, not scale minimum 1). No falling mode and the run does not transfer to the right-side benchmark

**Climbing**:
- Climber wins → opponent added to `gauntletDefeated`, streak increments, climber's rating increases via ELO
- Next opponent: picked randomly from up to 5 of the closest undefeated scenes ranked above the climber (`remainingOpponents` filtered by `idx < climberIndex` or `rating >= climber's rating`). This selection window prevents every climb from fighting the exact same sequence of opponents.
- As the climber wins and their rating increases, `repositionSceneInArray` moves them up in the sorted pool. They can leapfrog multiple opponents if their ELO gain is large enough — skipped opponents are excluded from future matchups since they now rank below the climber

**Climber loses → Falling mode**:
- The old climber becomes `gauntletFallingScene` and stays in `gauntletClimber` until the run ends (for skip/persist); pairing and ELO use the faller via `gauntletFalling` + `activeClimberId()`
- `gauntletDefeated` is reset to the fight winner (tracks who beat them for bottom placement)
- Falling scene faces opponents **below** it in the ranking to find its floor

**Falling mode outcomes**:
- Falling scene **wins**: Found their floor. Rating set to `loserRating + 1`. Placement screen shown.
- Falling scene **loses**: Keep falling. Winner added to `gauntletDefeated`.
- **Hits the bottom** (no opponents below): Rating set to `max(1, lastOpponent.rating - 1)` — one below whatever beat them last.

**Victory**: When `remainingOpponents` is empty, the climber has conquered all scenes. Victory screen shown (this is when we call them the **champion** in the UI).

### Champion Mode

Like gauntlet but simpler — winner always takes over, no falling.

**Key differences from Gauntlet**:
- When the climber loses, they keep their earned rating (no ELO penalty)
- Winner becomes the new `gauntletClimber` immediately
- No falling mode — the old climber just gets replaced
- Otherwise identical pairing and climbing logic

---

## UI Behavior

### Scene Cards

Each card shows: screenshot (with hover video preview), title, duration, rank, studio, performers, play count, current rating, tags, and a "Choose This Scene" button.

**Badges** (displayed over the screenshot):
- Win streak: `🔥 X wins` (number — pass win count as `statusBadge` to `createSceneCard`)
- Falling mode: `📍 Finding final placement...` (string)
- The badge slot accepts either type via the `statusBadge` parameter on `createSceneCard`

### Rating Animations

After each battle, an overlay animates the rating change:
- Green with `+X` for the winner
- Red with `-X` for the loser
- Count-up/count-down animation over ~500ms
- Overlay removed after 1400ms, then new pair loads

### Victory / Placement Screens

- **Victory**: Crown icon, "CHAMPION!", scene info, streak stats
- **Placement**: Pin icon, "PLACED!", final rank and rating
- Both show a "Start New Run" button that resets gauntlet state

### Keyboard Shortcuts

| Key | Action |
|---|---|
| Escape | Close modal |
| Left Arrow | Choose left scene |
| Right Arrow | Choose right scene |
| Space | Skip (disabled during gauntlet/champion with an active climber) |

---

## State Persistence

State is saved to `localStorage` under `"stash-battle-state"` after every battle and on certain mode changes. Restored on modal open.

**Saved fields**: `currentPair`, `currentRanks`, `currentMode`, `gauntletClimber`, `gauntletWins`, `gauntletClimberRank`, `gauntletDefeated`, `gauntletFalling`, `gauntletFallingScene`, `totalScenesCount`, `savedFilterParams`.

**Migration**: Older saves used `gauntletChampion` / `gauntletChampionRank`; `loadState()` reads those as fallbacks when the new keys are absent.

**Filter change detection**: `savedFilterParams` stores the URL search string. If it differs on modal open, gauntlet state and caches are reset.

### Scene Page Battle

When the Battle button is clicked on an individual scene page (`/scenes/123`):

1. `getSceneIdFromUrl()` extracts the scene ID from the URL pathname
2. If the scene is already in `currentPair.left` or `currentPair.right`, the existing pair is restored normally (no disruption)
3. If the scene is NOT in the current pair, a new battle is forced:
   - Gauntlet state is reset
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
- **`findScene`** query: fetches a single scene by ID (used for scene page battle)
- **`sceneUpdate`** mutation: writes rating changes back to Stash
- **Fragment fields** (`SCENE_FRAGMENT` in `graphql.ts`): `id`, `title`, `date`, `rating100`, `play_count`, `paths` (screenshot, preview), `files` (duration, path), `studio` (name), `performers` (name), `tags` (name)

---

## Common Pitfalls & Edge Cases

1. **First gauntlet battle ELO**: `gauntletClimber` must be set *before* `calculateRatingChanges` runs (via `resolveComparison` in `mainUI`), otherwise the climber role is unassigned and no ELO change occurs.

2. **First battle challenger loss**: Fight 1 is always challenger vs the lowest-rated opponent. If the challenger loses, they are placed at the bottom and the run ends. Rated challengers are cleared to unrated on **first choice** (not pair load), then fight 1 proceeds like an unrated scene.

3. **Unrated in opponent pool**: Without the rated-only filter, unrated scenes cluster at the bottom of the DESC-sorted list. Swiss mode's ±10 reach around an unrated left-side scene would pick other unrated scenes as opponents — defeating the purpose.

4. **Falling scene at the bottom**: If the falling scene was already the lowest-rated scene (e.g., it was picked as the initial gauntlet opponent and later became the climber), `belowOpponents` is immediately empty. The rating is set to 1 below the last opponent's rating rather than hardcoded to 1.

5. **Climber loss in champion mode**: The climber keeps their rating when they lose — no ELO penalty. Falling-mode ELO is bypassed entirely in champion mode.

6. **`repositionSceneInArray`**: After a rating change, the scene is physically moved in the sorted array to maintain correct rankings. This means `findIndex` lookups against the opponent pool always reflect the latest ratings.

7. **Background refresh race condition**: `removedSceneIds` persists across background cache refreshes. Without it, a background refresh could re-add scenes to the filtered pool that were already processed this session.

8. **Pool size for rank display**: `totalScenesCount` is set from `opponentPool.length`, not `allScenes.length`. This ensures "Rank #X of Y" is consistent when unrated scenes are excluded from the pool.

9. **Scene page battle with active gauntlet**: Opening battle from a scene page always resets gauntlet state if the scene isn't already in the pair. This prevents a forced scene from being injected mid-gauntlet-run, which would corrupt climber/defeated tracking.

10. **Scene page ID matching**: Scene IDs from the URL and from GraphQL are compared as strings via `String()`. The `getSceneIdFromUrl()` regex requires a pure numeric path segment (`/scenes/(\d+)$`) — tab paths like `/scenes/123/markers` won't match.
