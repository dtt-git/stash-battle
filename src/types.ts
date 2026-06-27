// Shared type definitions for the Stash Battle plugin.

/** The three comparison modes the plugin supports. */
export type Mode = "swiss" | "gauntlet" | "champion";

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
  paths?: ScenePaths | null;
  files?: SceneFile[] | null;
  studio?: NamedRef | null;
  performers?: NamedRef[] | null;
  tags?: NamedRef[] | null;
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

interface GauntletPairBase {
  scenes: Scene[];
  ranks: Rank[];
}

/** Normal gauntlet pair (climbing or run start). */
export interface GauntletActivePair extends GauntletPairBase {
  isVictory: false;
  isFalling: false;
  isPlacement?: false;
}

/** Climber has no remaining opponents. */
export interface GauntletVictoryResult extends GauntletPairBase {
  isVictory: true;
  isFalling: false;
}

/** Falling scene still searching for their floor. */
export interface GauntletFallingPair extends GauntletPairBase {
  isVictory: false;
  isFalling: true;
  isPlacement?: false;
}

/** Falling scene hit the bottom — run ends with placement screen. */
export interface GauntletPlacementResult extends GauntletPairBase {
  isVictory: false;
  isFalling: true;
  isPlacement: true;
  placementRank: number;
  placementRating: number;
}

export type GauntletPairResult =
  | GauntletActivePair
  | GauntletVictoryResult
  | GauntletFallingPair
  | GauntletPlacementResult;

export interface ChampionPairResult {
  scenes: Scene[];
  ranks: Rank[];
  isVictory: boolean;
}


/** Role of a scene in climb/champion battles (Swiss treats everyone as combatant). */
export type BattleRole = "climber" | "benchmark" | "combatant";

export interface BattleSide {
  rating: number;
  playCount: number;
  role: BattleRole;
}

export interface ComparisonDeltas {
  winner: number;
  loser: number;
}

/** Inputs for pure two-sided ELO (no mode or role — caller applies policy). */
export interface ComparisonInput {
  winner: Pick<BattleSide, "rating" | "playCount">;
  loser: Pick<BattleSide, "rating" | "playCount">;
}
