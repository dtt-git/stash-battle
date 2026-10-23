// Shared type definitions for the Stash Battle plugin.

/** The comparison modes the plugin supports. */
export type Mode = "swiss" | "placement" | "champion";

/** How ELO starts at setup: from current Stash ratings, or 1500 for every scene. */
export type EloStart = "ratings" | "fresh";

/** Whether and how Battle writes Stash ratings from ELO. */
export type StashRatingsMode = "off" | "percentile" | "linear";

/** User settings, persisted in Stash's plugin configuration (see settings.ts). */
export interface Settings {
  stashRatings: StashRatingsMode; // Stash ratings written from ELO ("off" never writes them)
  eloSetupAt: string | null; // When the one-time ELO setup finished (ISO time); null = not yet
  eloSetupMode: EloStart | null; // How that setup started ELO
  openInNewTab: boolean; // Thumbnail click opens the scene in a new tab
  placementFromBottom: boolean; // Placement runs start at the bottom scene and climb (replaces Gauntlet)
  previewVolume: number; // 0-100, 0 = muted
  autoplayPreviews: boolean; // Loop both previews (muted) without hovering
  filterOpponents: boolean; // Right side obeys the list filter too
  cleanMode: boolean; // Show a delete button on each card
  pauseMediaOnOpen: boolean; // Pause Stash's playing video/audio when Battle opens
}

export interface SceneFile {
  duration?: number | null;
  path?: string | null;
}

export interface ScenePaths {
  screenshot?: string | null;
  preview?: string | null;
}

export interface NamedRef {
  name: string;
}

/** A scene as returned by SCENE_FRAGMENT. */
export interface Scene {
  id: string;
  title?: string | null;
  date?: string | null;
  rating100?: number | null;
  play_count?: number | null;
  /** Stash's scene custom fields map (ours: stash_battle_elo / _battles / _seeded). */
  custom_fields?: Record<string, unknown> | null;
  paths?: ScenePaths | null;
  files?: SceneFile[] | null;
  studio?: NamedRef | null;
  performers?: NamedRef[] | null;
  tags?: NamedRef[] | null;
}

/** Stash Battle's per-scene data, stored as scene custom fields (see constants.ts). */
export interface EloFields {
  elo: number;
  battles: number;
  seeded: boolean;
}

/** Rank position in the opponent pool (1 = top), or null when unknown. */
export type Rank = number | null;

export interface Pair {
  left: Scene | null;
  right: Scene | null;
}

export interface Ranks {
  left: Rank;
  right: Rank;
}

// --- GraphQL request/response shapes ---

export interface FindFilterType {
  per_page?: number;
  sort?: string;
  direction?: string;
  q?: string;
  [key: string]: unknown;
}

export type SceneFilterType = Record<string, unknown>;

export interface FindScenesResult {
  findScenes: {
    count: number;
    scenes: Scene[];
  };
}

export interface FindSceneResult {
  findScene: Scene | null;
}

// --- Cache shapes ---

export interface CacheEntry {
  cacheKey: string;
  scenes: Scene[];
  count: number;
  filterKey?: string;
  timestamp: number;
}

// --- Pair fetch results ---

export interface SwissPairResult {
  scenes: Scene[];
  ranks: Rank[];
}

/**
 * An in-progress Placement run. The scene's slot in the ELO-sorted pool is narrowed between
 * two opponents (stored by id so ranks survive background cache refreshes).
 */
export interface PlacementRun {
  scene: Scene;
  fromBottom: boolean; // "Start from the bottom": first opponent is the bottom scene, then climb
  aboveId: string | null; // Lowest-ranked scene that beat it (slot is below this one)
  belowId: string | null; // Highest-ranked scene it beat (slot is above this one)
  lastOpponentId: string | null;
  lastWon: boolean | null;
  galloping: boolean; // Step doubles each battle until the first direction reversal
  step: number;
  battles: number;
  streak: number; // Wins before the first loss (the climb's win streak)
  rangeLo: number; // Current slot range for display (0-based, inclusive)
  rangeHi: number;
}

export type PlacementPairResult =
  | { done: false; scenes: Scene[]; ranks: Rank[] }
  | { done: true; scene: Scene; rank: number; elo: number; battles: number; streak: number; fromBottom: boolean };

export interface ChampionPairResult {
  scenes: Scene[];
  ranks: Rank[];
  isVictory: boolean;
}
