// Plugin-wide constants.

export const STORAGE_KEY = "stash-battle-state";
export const CACHE_DB_NAME = "stash-battle-cache";
export const CACHE_DB_VERSION = 1;
export const CACHE_STORE_NAME = "scenes";
export const CACHE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes cache expiry

// toggle: should scene2/opponents obey the same filter as scene1?
// default is false (don't apply filter to both sides); user can override via UI.
export const DEFAULT_FILTER_OPPONENTS = false;

// LocalStorage keys for user preferences.
export const FILTER_OPPONENTS_KEY = "sb_filterOpponents";
export const MUTE_PREVIEWS_KEY = "sb_mutePreviews";

// Swiss mode: initial rank band (±N) when picking a similar-strength opponent; doubles until candidates exist.
export const SWISS_OPPONENT_REACH_INITIAL = 10;
export const SWISS_OPPONENT_REACH_MULTIPLIER = 2;

// Gauntlet/champion: random pick among the N closest undefeated opponents above the climber.
export const CLIMB_OPPONENT_PICK_WINDOW = 5;
