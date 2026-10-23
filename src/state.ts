// Central mutable runtime state.
//
// The original plugin used module-level `let` bindings shared across many functions.
// ES modules cannot reassign an imported binding from another module, so all shared
// mutable values live on this single `state` object that every module imports.

import { DEFAULT_SETTINGS } from "./constants";
import type { Mode, Pair, PlacementRun, Ranks, Scene, Settings } from "./types";

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
  // Gauntlet / champion run tracking
  gauntletClimber: Scene | null; // The scene currently climbing (on a win streak)
  gauntletWins: number; // Current win streak
  gauntletClimberRank: number; // Climber's current rank position (1 = top)
  gauntletDefeated: string[]; // IDs of scenes defeated in current run
  gauntletFalling: boolean; // True when climber lost and is finding their floor
  gauntletFallingScene: Scene | null; // The scene that's falling to find its position
  // Placement run tracking
  placement: PlacementRun | null;
  totalScenesCount: number; // Total scenes for position display
  leftPoolSize: number | null; // Scenes on the "to rate" side (filter or whole library); null until loaded
  disableChoice: boolean; // Prevents multiple rapid choice events
  savedFilterParams: string; // Stored URL filter params to detect changes
  // User settings (defaults until loadSettings() resolves)
  settings: Settings;
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
  gauntletClimber: null,
  gauntletWins: 0,
  gauntletClimberRank: 0,
  gauntletDefeated: [],
  gauntletFalling: false,
  gauntletFallingScene: null,
  placement: null,
  totalScenesCount: 0,
  leftPoolSize: null,
  disableChoice: false,
  savedFilterParams: "",
  settings: { ...DEFAULT_SETTINGS },
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

/** Clear any gauntlet / champion / placement run in progress. */
export function resetRunState(): void {
  state.gauntletClimber = null;
  state.gauntletWins = 0;
  state.gauntletClimberRank = 0;
  state.gauntletDefeated = [];
  state.gauntletFalling = false;
  state.gauntletFallingScene = null;
  state.placement = null;
}

/** Forget the left-side shuffle so the next pick reshuffles from a fresh pool. */
export function resetShuffle(): void {
  state.shuffledFilteredScenes = [];
  state.shuffleIndex = 0;
  state.shuffleFilterKey = null;
}

/** True while a gauntlet/champion/placement run is under way (skip is disabled). */
export function isRunActive(): boolean {
  switch (state.currentMode) {
    case "gauntlet":
    case "champion":
      return state.gauntletClimber !== null;
    case "placement":
      return (state.placement?.battles ?? 0) > 0;
    default:
      return false;
  }
}

/** The one-time ELO setup hasn't finished yet, so Battle shows it instead of loading pairs. */
export function isEloSetupPending(): boolean {
  return !state.settings.eloSetupAt;
}
