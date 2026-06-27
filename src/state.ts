// Central mutable runtime state.
//
// The original plugin used module-level `let` bindings shared across many functions.
// ES modules cannot reassign an imported binding from another module, so all shared
// mutable values live on this single `state` object that every module imports.

import { DEFAULT_FILTER_OPPONENTS, FILTER_OPPONENTS_KEY, MUTE_PREVIEWS_KEY } from "./constants";
import type { Mode, Pair, Ranks, Scene } from "./types";

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
  totalScenesCount: number; // Total scenes for position display
  disableChoice: boolean; // Prevents multiple rapid choice events
  savedFilterParams: string; // Stored URL filter params to detect changes
  // User toggles
  filterOpponents: boolean;
  mutePreviews: boolean;
  // Shuffle state for filtered scenes (prevents duplicates when skipping)
  shuffledFilteredScenes: Scene[];
  shuffleIndex: number;
  shuffleFilterKey: string | null;
  removedSceneIds: Set<string>; // Scenes removed this session (survives background refresh)
  // Scene cache (memory tier)
  memoryCache: MemoryCache;
}

function readBooleanPref(key: string, fallback: boolean): boolean {
  try {
    const stored = localStorage.getItem(key);
    if (stored !== null) return stored === "1";
  } catch {
    /* ignore */
  }
  return fallback;
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
  totalScenesCount: 0,
  disableChoice: false,
  savedFilterParams: "",
  filterOpponents: readBooleanPref(FILTER_OPPONENTS_KEY, DEFAULT_FILTER_OPPONENTS),
  mutePreviews: readBooleanPref(MUTE_PREVIEWS_KEY, false),
  shuffledFilteredScenes: [],
  shuffleIndex: 0,
  shuffleFilterKey: null,
  removedSceneIds: new Set<string>(),
  memoryCache: {
    allScenes: null,
    filteredScenes: null,
    filterKey: null,
    timestamp: null,
  },
};

export function resetGauntletState(): void {
  state.gauntletClimber = null;
  state.gauntletWins = 0;
  state.gauntletClimberRank = 0;
  state.gauntletDefeated = [];
  state.gauntletFalling = false;
  state.gauntletFallingScene = null;
}
