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

The plugin is a single IIFE (`stash-battle.js`, ~2600 lines) injected into the Stash UI. It has no build step — just raw JS, a CSS file, and a YAML manifest. It adds a "Battle" button to the `/scenes` page that opens a modal where users compare scenes head-to-head to build rankings via an ELO system.

### Entry Flow

1. `init()` fires on `DOMContentLoaded`
2. `addFloatingButton()` injects a nav item on `/scenes` pages
3. A `MutationObserver` re-adds the button on SPA navigation (Stash uses React Router)
4. Clicking the button opens `openRankingModal()` which renders the full battle UI

### Core State

All state lives in closure-scoped variables (no globals). Key variables:

| Variable | Purpose |
|---|---|
| `currentPair` | `{ left, right }` — the two scenes currently displayed |
| `currentRanks` | `{ left, right }` — rank positions for display |
| `currentMode` | `"swiss"`, `"gauntlet"`, or `"champion"` |
| `gauntletChampion` | The scene on a winning streak (gauntlet/champion modes) |
| `gauntletWins` | Current win streak count |
| `gauntletDefeated` | Array of scene IDs the champion has beaten (prevents rematches) |
| `gauntletFalling` | Boolean — true when a champion lost and is finding their floor |
| `gauntletFallingScene` | The scene object currently in falling mode |
| `totalScenesCount` | Size of the opponent pool (used for "Rank #X of Y" display) |
| `filterOpponents` | Whether the right-side pool obeys the same filter as the left side |

---

## The Two Sides

The battle UI always shows two scenes:

- **Left side (scene1)**: Drawn from the **filtered pool** — these are the scenes the user wants to rate. In gauntlet/champion modes, this is the champion.
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

**Gauntlet/Champion modes**: Only the **active scene** (champion or falling scene) gets rating changes. Defenders are benchmarks — their ratings stay the same. Exception: if the defender is **rank #1** and loses, they drop by 1 point (dethrone mechanic).

**Champion mode loss**: When the champion loses, their rating is **preserved** — they earned it through wins. They just get replaced by the new champion. No ELO penalty.

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
3. Display: challenger vs lowest rated

**First battle special handling**:
- `gauntletChampion` is set to the left-side scene **before** `handleComparison` runs, so the first battle properly calculates ELO
- If the right side wins on the first battle, it simply becomes champion — **no falling mode** is triggered

**Climbing**:
- Champion wins → opponent added to `gauntletDefeated`, streak increments, champion's rating increases via ELO
- Next opponent: picked randomly from up to 5 of the closest undefeated scenes ranked above the champion (`remainingOpponents` filtered by `idx < championIndex` or `rating >= champion's rating`). This selection window prevents every climb from fighting the exact same sequence of opponents.
- As champion wins and their rating increases, `repositionSceneInArray` moves them up in the sorted pool. The champion can leapfrog multiple opponents if their ELO gain is large enough — skipped opponents are excluded from future matchups since they now rank below the champion

**Champion loses → Falling mode**:
- The old champion becomes `gauntletFallingScene`
- The winner becomes the new `gauntletChampion`
- Falling scene faces opponents **below** it in the ranking to find its floor

**Falling mode outcomes**:
- Falling scene **wins**: Found their floor. Rating set to `loserRating + 1`. Placement screen shown.
- Falling scene **loses**: Keep falling. Winner added to `gauntletDefeated`.
- **Hits the bottom** (no opponents below): Rating set to `max(1, lastOpponent.rating - 1)` — one below whatever beat them last.

**Victory**: When `remainingOpponents` is empty, the champion has conquered all scenes. Victory screen shown.

### Champion Mode

Like gauntlet but simpler — winner always takes over, no falling.

**Key differences from Gauntlet**:
- When champion loses, they keep their earned rating (no ELO penalty)
- Winner becomes new champion immediately
- No falling mode — the old champion just gets replaced
- Otherwise identical pairing and climbing logic

---

## UI Behavior

### Scene Cards

Each card shows: screenshot (with hover video preview), title, duration, rank, studio, performers, play count, current rating, tags, and a "Choose This Scene" button.

**Badges** (displayed over the screenshot):
- Win streak: `🔥 X wins` (number)
- Falling mode: `📍 Finding placement...` (string)
- The badge slot accepts either type via the `streak` parameter on `createSceneCard`

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
| Space | Skip (disabled during gauntlet/champion with active champion) |

---

## State Persistence

State is saved to `localStorage` under `"stash-battle-state"` after every battle and on certain mode changes. Restored on modal open.

**Saved fields**: `currentPair`, `currentRanks`, `currentMode`, `gauntletChampion`, `gauntletWins`, `gauntletChampionRank`, `gauntletDefeated`, `gauntletFalling`, `gauntletFallingScene`, `totalScenesCount`, `savedFilterParams`.

**Filter change detection**: `savedFilterParams` stores the URL search string. If it differs on modal open, gauntlet state and caches are reset.

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
- **`sceneUpdate`** mutation: writes rating changes back to Stash
- **Fragment fields**: `id`, `title`, `date`, `rating100`, `play_count`, `paths` (screenshot, preview), `files` (path, duration, resolution), `studio`, `performers`, `tags`

---

## Common Pitfalls & Edge Cases

1. **First gauntlet battle ELO**: `gauntletChampion` must be set *before* `handleComparison` runs, otherwise all role checks evaluate to false and no ELO change occurs.

2. **First battle right-side win**: If the user picks the right side on the first gauntlet battle, it should become champion without triggering falling mode. The `isFirstBattle` flag handles this.

3. **Unrated in opponent pool**: Without the rated-only filter, unrated scenes cluster at the bottom of the DESC-sorted list. Swiss mode's ±10 reach around an unrated left-side scene would pick other unrated scenes as opponents — defeating the purpose.

4. **Falling scene at the bottom**: If the falling scene was already the lowest-rated scene (e.g., it was picked as the initial gauntlet opponent and later became champion), `belowOpponents` is immediately empty. The rating is set to 1 below the last opponent's rating rather than hardcoded to 1.

5. **Champion loss in champion mode**: The champion keeps their rating when they lose — no ELO penalty. The `isFallingLoser` check (not `isChampionLoser`) controls this.

6. **`repositionSceneInArray`**: After a rating change, the scene is physically moved in the sorted array to maintain correct rankings. This means `findIndex` lookups against the opponent pool always reflect the latest ratings.

7. **Background refresh race condition**: `removedSceneIds` persists across background cache refreshes. Without it, a background refresh could re-add scenes to the filtered pool that were already processed this session.

8. **Pool size for rank display**: `totalScenesCount` is set from `opponentPool.length`, not `allScenes.length`. This ensures "Rank #X of Y" is consistent when unrated scenes are excluded from the pool.
