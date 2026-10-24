// Persist/restore the battle session to localStorage.

import { STORAGE_KEY } from "./constants";
import { scenesListQuery } from "./filters";
import { state } from "./state";
import type { Mode, Pair, PlacementRun, Ranks, Scene } from "./types";

/**
 * Bumped when saved sessions can't be restored as they are. 3 (3.0): scenes are ranked by ELO
 * from custom fields, which older saved scenes lack, and Gauntlet runs no longer exist.
 */
const STATE_VERSION = 3;

const MODES: readonly Mode[] = ["swiss", "placement", "champion"];

interface PersistedState {
  version?: number;
  currentPair?: Pair;
  currentRanks?: Ranks;
  currentMode?: string;
  championScene?: Scene | null;
  championWins?: number;
  championDefeated?: string[];
  placement?: PlacementRun | null;
  totalScenesCount?: number;
  savedFilterParams?: string;
}

/** A saved mode name as a current mode: Gauntlet became Placement's "Start from the bottom". */
function restoreMode(saved: string | undefined): Mode {
  if (saved === "gauntlet") return "placement";
  return MODES.includes(saved as Mode) ? (saved as Mode) : "swiss";
}

/** Saves the current battle session to localStorage. */
export function saveState(): void {
  const snapshot: PersistedState = {
    version: STATE_VERSION,
    currentPair: state.currentPair,
    currentRanks: state.currentRanks,
    currentMode: state.currentMode,
    championScene: state.championScene,
    championWins: state.championWins,
    championDefeated: state.championDefeated,
    placement: state.placement,
    totalScenesCount: state.totalScenesCount,
    savedFilterParams: scenesListQuery(),
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
      state.currentMode = restoreMode(parsed.currentMode);
      state.savedFilterParams = parsed.savedFilterParams || "";
      if (parsed.version !== STATE_VERSION) {
        // Older sessions hold scenes without ELO: keep the mode, start a fresh pair and run
        console.log("[Stash Battle] 📋 Saved session is from an older version, starting fresh");
        return true;
      }
      state.currentPair = parsed.currentPair || { left: null, right: null };
      state.currentRanks = parsed.currentRanks || { left: null, right: null };
      state.championScene = parsed.championScene ?? null;
      state.championWins = parsed.championWins || 0;
      state.championDefeated = parsed.championDefeated || [];
      state.placement = parsed.placement || null;
      state.totalScenesCount = parsed.totalScenesCount || 0;
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
