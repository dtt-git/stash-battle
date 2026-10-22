// Plugin-wide constants.

export const STORAGE_KEY = "stash-battle-state";
export const CACHE_DB_NAME = "stash-battle-cache";
export const CACHE_DB_VERSION = 1;
export const CACHE_STORE_NAME = "scenes";
export const CACHE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes cache expiry

import type { Settings } from "./types";

/** Plugin id (folder name) — key for this plugin's settings in Stash's configuration. */
export const PLUGIN_ID = "stash-battle";

export const DEFAULT_SETTINGS: Settings = {
  funMode: false,
  openInNewTab: false,
  unratedRating: 50,
  previewVolume: 50,
  autoplayPreviews: true,
  filterOpponents: false,
  cleanMode: false,
  pauseMediaOnOpen: true,
};

// Pre-2.7 localStorage preference keys (migrated into plugin settings).
export const LEGACY_FILTER_OPPONENTS_KEY = "sb_filterOpponents";
export const LEGACY_MUTE_PREVIEWS_KEY = "sb_mutePreviews";

// Swiss mode: initial rank band (±N) when picking a similar-strength opponent; doubles until candidates exist.
export const SWISS_OPPONENT_REACH_INITIAL = 10;
export const SWISS_OPPONENT_REACH_MULTIPLIER = 2;

// Gauntlet/champion: random pick among the N closest undefeated opponents above the climber.
export const CLIMB_OPPONENT_PICK_WINDOW = 5;

/** Show a UI warning when the climb opponent pool is smaller than this (filter opponents on). */
export const CLIMB_SMALL_POOL_WARN_AT = 10;

/** play_count stand-in when the climber wins in gauntlet/champion (0 → K=12). */
export const CLIMB_K_PLAY_COUNT = 0;
