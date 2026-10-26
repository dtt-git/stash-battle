// Central mutable runtime state.
//
// The original plugin used module-level `let` bindings shared across many functions.
// ES modules cannot reassign an imported binding from another module, so all shared
// mutable values live on this single `state` object that every module imports.

import { DEFAULT_SETTINGS } from "./constants";
import { DEFAULT_EXPLORE_FILTERS, filterBattlesWithin, type ExploreFilters } from "./explore";
import type { Mode, Pair, PlacementRun, Ranks, Scene, Settings } from "./types";

/**
 * What's battled until Stop in place of the Scenes page filter: an Explore filter (see
 * filterBattlesWithin for who battles whom), or one scene (its ⚔️, or opened from its page).
 */
export interface ExplorePool {
  filters: ExploreFilters;
  /** "👑 Legendary · ELO 1600–1700", for the note above the cards. */
  label: string;
  /** Set when battling one scene: it's the whole pool, against your whole library (`filters` unused). */
  sceneId?: string;
}

/** One scene, battled until Stop (it keeps coming back on the left). */
export function oneScenePool(sceneId: string): ExplorePool {
  return { filters: { ...DEFAULT_EXPLORE_FILTERS }, label: "", sceneId };
}

/** The battled Explore filter's scenes are on both sides (read each pick, so the setting applies at once). */
export function explorePoolWithin(): boolean {
  const pool = state.explorePool;
  return pool !== null && !pool.sceneId && filterBattlesWithin(pool.filters, state.settings.filterOpponents);
}

export interface MemoryCache {
  allScenes: Scene[] | null; // All scenes (no filter)
  filteredScenes: Scene[] | null; // Scenes matching current filter
  filterKey: string | null; // Current filter params for cache validation
  timestamp: number | null; // When cache was populated
}

export interface BattleState {
  // Current comparison pair and mode
  currentPair: Pair;
  currentRanks: Ranks;
  currentMode: Mode;
  // Champion run tracking
  championScene: Scene | null; // The scene defending (winner stays on)
  championWins: number; // Its current win streak
  championDefeated: string[]; // IDs of scenes it has beaten in this run
  // Placement run tracking
  placement: PlacementRun | null;
  totalScenesCount: number; // Total scenes for position display
  leftPoolSize: number | null; // Scenes on the "to rate" side (filter or whole library); null until loaded
  disableChoice: boolean; // Prevents multiple rapid choice events
  savedFilterParams: string; // Stored URL filter params to detect changes
  // User settings (defaults until loadSettings() resolves)
  settings: Settings;
  resettingElo: boolean; // Reset ELO's setup screen is showing (battles wait, like a first setup)
  leastTested: boolean; // Stats → "Battle the least-tested": Swiss takes the fewest-battled scene on the left
  explorePool: ExplorePool | null; // Explore → "Battle these", or one scene: replaces the Scenes page filter
  // Shuffle state for the left-side pool (prevents repeats when skipping)
  shuffledFilteredScenes: Scene[];
  shuffleIndex: number;
  shuffleFilterKey: string | null;
  // Scene cache (memory tier)
  memoryCache: MemoryCache;
}

export const state: BattleState = {
  currentPair: { left: null, right: null },
  currentRanks: { left: null, right: null },
  currentMode: "swiss",
  championScene: null,
  championWins: 0,
  championDefeated: [],
  placement: null,
  totalScenesCount: 0,
  leftPoolSize: null,
  disableChoice: false,
  savedFilterParams: "",
  settings: { ...DEFAULT_SETTINGS },
  resettingElo: false,
  leastTested: false,
  explorePool: null,
  shuffledFilteredScenes: [],
  shuffleIndex: 0,
  shuffleFilterKey: null,
  memoryCache: {
    allScenes: null,
    filteredScenes: null,
    filterKey: null,
    timestamp: null,
  },
};

/** Clear any Champion / Placement run in progress. */
export function resetRunState(): void {
  state.championScene = null;
  state.championWins = 0;
  state.championDefeated = [];
  state.placement = null;
}

/** Forget the left-side shuffle so the next pick reshuffles from a fresh pool. */
export function resetShuffle(): void {
  state.shuffledFilteredScenes = [];
  state.shuffleIndex = 0;
  state.shuffleFilterKey = null;
}

/** True while a Champion / Placement run is under way (skip is disabled). */
export function isRunActive(): boolean {
  switch (state.currentMode) {
    case "champion":
      return state.championScene !== null;
    case "placement":
      return (state.placement?.battles ?? 0) > 0;
    default:
      return false;
  }
}

/** ELO setup hasn't finished (or Reset ELO is showing it), so it shows instead of loading pairs. */
export function isEloSetupPending(): boolean {
  return !state.settings.eloSetupAt || state.resettingElo;
}
