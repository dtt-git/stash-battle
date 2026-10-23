// Plugin-wide constants.

export const STORAGE_KEY = "stash-battle-state";
export const CACHE_DB_NAME = "stash-battle-cache";
/** 2 (3.0): cached scenes from before need custom_fields and ELO order, so the store is cleared. */
export const CACHE_DB_VERSION = 2;
export const CACHE_STORE_NAME = "scenes";
export const CACHE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes cache expiry

import type { Settings, Tier } from "./types";

/** Plugin id (folder name) — key for this plugin's settings in Stash's configuration. */
export const PLUGIN_ID = "stash-battle";

export const DEFAULT_SETTINGS: Settings = {
  stashRatings: "off",
  eloSetupAt: null,
  eloSetupMode: null,
  openInNewTab: false,
  placementFromBottom: false,
  showTiers: true,
  previewVolume: 50,
  autoplayPreviews: true,
  filterOpponents: false,
  cleanMode: false,
  pauseMediaOnOpen: true,
};

// Pre-2.7 localStorage preference keys (migrated into plugin settings).
export const LEGACY_FILTER_OPPONENTS_KEY = "sb_filterOpponents";
export const LEGACY_MUTE_PREVIEWS_KEY = "sb_mutePreviews";

/**
 * Swiss: the opponent is picked at random from every scene within ±this ELO (win chances between
 * 36% and 64%). A pick that close still tells over 90% of what a 50/50 one does, and a scene meets
 * far more varied opponents than a window of nearby ranks, which on a seeded library is mostly
 * ties.
 */
export const SWISS_OPPONENT_ELO_WINDOW = 100;
/** Swiss: when fewer scenes than this are in the window (top, bottom, small pools), take this many nearest. */
export const SWISS_OPPONENT_MIN_CANDIDATES = 10;

// Champion: random pick among the N closest undefeated opponents above the champion.
export const CLIMB_OPPONENT_PICK_WINDOW = 5;

/**
 * ELO an unrated scene counts as in Champion: 1000, the bottom (what a 0 rating seeds to), so a
 * newcomer climbs from there as before. Swiss counts unrated scenes as ELO_START (1500).
 */
export const CHAMPION_UNRATED_ELO = 1000;

/**
 * A pick is an "Upset!" when the winner's win chance (as shown, in %) was at most this: about 70
 * ELO below its opponent. Swiss opponents are within ±100, so about 1 pick in 7 if ELO is right.
 */
export const UPSET_MAX_CHANCE = 40;

/** Show a UI warning when Champion's opponent pool is smaller than this (filter opponents on). */
export const CLIMB_SMALL_POOL_WARN_AT = 10;

// --- True ELO (stored in scene custom fields) ---

/** Scene custom field keys. Writes use `partial`, so other plugins' fields are never touched. */
export const ELO_FIELD = "stash_battle_elo";
/** Real battles that moved this scene's ELO (Placement adds its run's battles when the scene lands). */
export const BATTLES_FIELD = "stash_battle_battles";
/** True when the scene's starting ELO came from its Stash rating (setup's "Use my ratings"). */
export const SEEDED_FIELD = "stash_battle_seeded";
/** All of Stash Battle's per-scene fields (removed together when a scene becomes unrated). */
export const ELO_FIELD_KEYS = [ELO_FIELD, BATTLES_FIELD, SEEDED_FIELD];

export const ELO_START = 1500;
export const ELO_DIVISOR = 400;

/** K by K-games (battles, plus the head start if seeded): [below this count, K]; the last has no limit. */
export const ELO_K_TIERS: readonly (readonly [number, number])[] = [
  [10, 40],
  [30, 24],
  [Infinity, 16],
];

/**
 * Tiers ("Show tiers on cards"), best first, by rank among the library's settled scenes: a scene
 * whose rank is within the top `top` share gets the first tier that fits. Every tier always has
 * scenes in it, whatever the library's ELO spread. The last tier takes everyone else.
 */
export const TIERS: readonly Tier[] = [
  { id: "legendary", name: "Legendary", emoji: "👑", top: 0.01 },
  { id: "diamond", name: "Diamond", emoji: "💎", top: 0.05 },
  { id: "platinum", name: "Platinum", emoji: "🔷", top: 0.15 },
  { id: "gold", name: "Gold", emoji: "🥇", top: 0.35 },
  { id: "silver", name: "Silver", emoji: "🥈", top: 0.65 },
  { id: "bronze", name: "Bronze", emoji: "🥉", top: 1 },
];

/**
 * ELO points per 1-100 rating point. The pre-3.0 math divided by 40 on the 1-100 scale, so one
 * rating point already meant exactly 10 standard (divisor 400) ELO points.
 */
export const ELO_PER_RATING_POINT = 10;

/**
 * Head start (counted as battles for K only) for scenes seeded from their Stash rating: their
 * rating already says something, so they skip the biggest swings. Changing it applies to every
 * seeded scene at once, because it isn't stored.
 */
export const SEEDED_HEAD_START = 10;

/** ELO gap above the top / below the bottom scene when Placement lands a scene at an edge. */
export const PLACEMENT_EDGE_GAP = 25;

/**
 * Placement's doubling jumps are capped at this share of the pool (but at least
 * PLACEMENT_MIN_MAX_JUMP ranks), so a winning streak climbs instead of leaping to #1. In a
 * 600-scene library: at most 60 ranks per jump, about one extra battle on average.
 */
export const PLACEMENT_MAX_JUMP_SHARE = 0.1;
export const PLACEMENT_MIN_MAX_JUMP = 4;
