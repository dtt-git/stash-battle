// Persist/restore the battle session to localStorage.

import { STORAGE_KEY } from "./constants";
import { state } from "./state";
import type { Mode, Pair, Ranks, Scene } from "./types";

interface PersistedState {
  currentPair?: Pair;
  currentRanks?: Ranks;
  currentMode?: Mode;
  gauntletClimber?: Scene | null;
  gauntletWins?: number;
  gauntletClimberRank?: number;
  gauntletDefeated?: string[];
  gauntletFalling?: boolean;
  gauntletFallingScene?: Scene | null;
  totalScenesCount?: number;
  savedFilterParams?: string;
  /** @deprecated Renamed to gauntletClimber */
  gauntletChampion?: Scene | null;
  /** @deprecated Renamed to gauntletClimberRank */
  gauntletChampionRank?: number;
}

/** Saves the current battle session to localStorage. */
export function saveState(): void {
  const snapshot: PersistedState = {
    currentPair: state.currentPair,
    currentRanks: state.currentRanks,
    currentMode: state.currentMode,
    gauntletClimber: state.gauntletClimber,
    gauntletWins: state.gauntletWins,
    gauntletClimberRank: state.gauntletClimberRank,
    gauntletDefeated: state.gauntletDefeated,
    gauntletFalling: state.gauntletFalling,
    gauntletFallingScene: state.gauntletFallingScene,
    totalScenesCount: state.totalScenesCount,
    savedFilterParams: window.location.search,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch (e) {
    console.error("[Stash Battle] Failed to save state:", e);
  }
}

export function loadState(): boolean {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as PersistedState;
      state.currentPair = parsed.currentPair || { left: null, right: null };
      state.currentRanks = parsed.currentRanks || { left: null, right: null };
      state.currentMode = parsed.currentMode || "swiss";
      state.gauntletClimber = parsed.gauntletClimber ?? parsed.gauntletChampion ?? null;
      state.gauntletWins = parsed.gauntletWins || 0;
      state.gauntletClimberRank = parsed.gauntletClimberRank ?? parsed.gauntletChampionRank ?? 0;
      state.gauntletDefeated = parsed.gauntletDefeated || [];
      state.gauntletFalling = parsed.gauntletFalling || false;
      state.gauntletFallingScene = parsed.gauntletFallingScene || null;
      state.totalScenesCount = parsed.totalScenesCount || 0;
      state.savedFilterParams = parsed.savedFilterParams || "";
      return true;
    }
  } catch (e) {
    console.error("[Stash Battle] Failed to load state:", e);
  }
  return false;
}

export function clearState(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    console.error("[Stash Battle] Failed to clear state:", e);
  }
}
