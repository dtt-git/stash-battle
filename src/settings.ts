// User settings stored in Stash's plugin configuration (configuration.plugins["stash-battle"]),
// so they follow the user across browsers. Also editable in Stash → Settings → Plugins.

import {
  DEFAULT_SETTINGS,
  EXPLORE_PAGE_SIZES,
  LEGACY_FILTER_OPPONENTS_KEY,
  LEGACY_MUTE_PREVIEWS_KEY,
  PLUGIN_ID,
} from "./constants";
import { graphqlQuery } from "./graphql";
import { setRatingSystem } from "./ratingDisplay";
import { state } from "./state";
import type { EloStart, Settings, StashRatingsMode } from "./types";

const CONFIG_QUERY = `{ configuration { plugins } }`;
/** On load, also Stash's interface settings: how it shows ratings (stars or decimal). */
const LOAD_QUERY = `{ configuration { plugins ui } }`;

const CONFIGURE_PLUGIN_MUTATION = `
      mutation ConfigurePlugin($plugin_id: ID!, $input: Map!) {
        configurePlugin(plugin_id: $plugin_id, input: $input)
      }
    `;

const SAVE_DEBOUNCE_MS = 400;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Pre-3.0 fun mode was on in the stored config (so Battle wasn't changing Stash ratings). */
let legacyFunMode = false;

const STASH_RATINGS_MODES: readonly StashRatingsMode[] = ["off", "percentile", "linear"];
const ELO_STARTS: readonly EloStart[] = ["ratings", "fresh"];

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function clampPercent(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : fallback;
}

/** Coerce a stored config map into Settings (Stash may omit keys or store numbers as strings). */
function normalize(raw: Record<string, unknown>, base: Settings): Settings {
  const bool = (key: keyof Settings): boolean =>
    typeof raw[key] === "boolean" ? (raw[key] as boolean) : (base[key] as boolean);
  return {
    // A missing or unknown value is "off". (Removed keys, see REMOVED_KEYS, are dropped.)
    stashRatings: oneOf(raw.stashRatings, STASH_RATINGS_MODES, "off"),
    // Setup flags have no fallback: raw always carries them (stored config, or current + patch)
    eloSetupAt: typeof raw.eloSetupAt === "string" && raw.eloSetupAt ? raw.eloSetupAt : null,
    eloSetupMode: ELO_STARTS.includes(raw.eloSetupMode as EloStart) ? (raw.eloSetupMode as EloStart) : null,
    openInNewTab: bool("openInNewTab"),
    autoplayPreviews: bool("autoplayPreviews"),
    filterOpponents: bool("filterOpponents"),
    cleanMode: bool("cleanMode"),
    pauseMediaOnOpen: bool("pauseMediaOnOpen"),
    placementFromBottom: bool("placementFromBottom"),
    tierBorders: bool("tierBorders"),
    previewVolume: clampPercent(raw.previewVolume ?? base.previewVolume, base.previewVolume),
    explorePageSize: EXPLORE_PAGE_SIZES.includes(Number(raw.explorePageSize)) ? Number(raw.explorePageSize) : base.explorePageSize,
  };
}

/** Defaults overlaid with the pre-2.7 localStorage toggles, for users who never saved settings. */
function legacyDefaults(): Settings {
  const settings = { ...DEFAULT_SETTINGS };
  try {
    if (localStorage.getItem(LEGACY_FILTER_OPPONENTS_KEY) === "1") settings.filterOpponents = true;
    if (localStorage.getItem(LEGACY_MUTE_PREVIEWS_KEY) === "1") settings.previewVolume = 0;
  } catch {
    /* ignore */
  }
  return settings;
}

/**
 * Fetch settings from Stash into state.settings. On failure, keeps the current values and
 * returns false.
 */
export async function loadSettings(): Promise<boolean> {
  try {
    const data = await graphqlQuery<{ configuration: { plugins: Record<string, Record<string, unknown>>; ui: unknown } }>(LOAD_QUERY);
    setRatingSystem(data.configuration.ui);
    const stored = data.configuration.plugins?.[PLUGIN_ID];
    legacyFunMode = stored?.funMode === true;
    hallOfFame = mergeHallOfFame(parseHallOfFame(stored?.[HALL_OF_FAME_KEY]), []);
    state.settings = stored ? normalize(stored, DEFAULT_SETTINGS) : legacyDefaults();
    return true;
  } catch (e) {
    console.error("[Stash Battle] Failed to load settings, using current values:", e);
    return false;
  }
}

/** True if the stored config still has pre-3.0 fun mode switched on. */
export function hadFunMode(): boolean {
  return legacyFunMode;
}

/** Settings changed in this tab and not saved yet. */
const unsaved = new Set<keyof Settings>();

/** The stored config map, fresh from Stash (undefined if Stash Battle never saved one). */
async function fetchStoredConfig(): Promise<Record<string, unknown> | undefined> {
  const data = await graphqlQuery<{ configuration: { plugins: Record<string, Record<string, unknown>> } }>(
    CONFIG_QUERY,
  );
  return data.configuration.plugins?.[PLUGIN_ID];
}

/** Keys earlier versions stored and this one drops from the config on its next save. */
const REMOVED_KEYS = ["funMode", "unratedRating", "showTiers"];

/**
 * The config map to save. configurePlugin replaces the whole map, so it starts from the stored
 * one, not this tab's copy (another tab may have saved since this one loaded: finished the ELO
 * setup, say), with this tab's unsaved settings on top. Keys that aren't settings (the hall of
 * fame) are kept; removed ones and unset values are left out. `extra` adds or replaces such keys.
 */
export function mergeConfig(
  stored: Record<string, unknown> | undefined,
  current: Settings,
  unsavedKeys: readonly (keyof Settings)[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const merged: Record<string, unknown> = stored ? { ...stored, ...normalize(stored, current) } : { ...current };
  for (const key of unsavedKeys) merged[key] = current[key];
  Object.assign(merged, extra);
  for (const key of REMOVED_KEYS) delete merged[key];
  return Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== null && value !== undefined));
}

/** The config write in progress (or the last one), so the next starts from what it saved. */
let configWrites: Promise<unknown> = Promise.resolve();

/**
 * Save this tab's unsaved settings plus `extra` keys, after any config write in progress. `extra`
 * can be worked out from the stored config (to merge with what another tab saved).
 */
function saveConfig(
  extra: Record<string, unknown> | ((stored: Record<string, unknown> | undefined) => Record<string, unknown>) = {},
): Promise<boolean> {
  const run = configWrites.then(async () => {
    const keys = [...unsaved];
    unsaved.clear();
    try {
      const stored = await fetchStoredConfig();
      const input = mergeConfig(stored, state.settings, keys, typeof extra === "function" ? extra(stored) : extra);
      await graphqlQuery(CONFIGURE_PLUGIN_MUTATION, { plugin_id: PLUGIN_ID, input });
      return true;
    } catch (e) {
      console.error("[Stash Battle] Failed to save settings:", e);
      for (const key of keys) unsaved.add(key);
      return false;
    }
  });
  configWrites = run;
  return run;
}

function persistSettings(): Promise<boolean> {
  return saveConfig();
}

// ---------- Hall of fame (Stats → Records) ----------

/** Plugin config key: every scene that has ever been #1, with the date it first got there. */
const HALL_OF_FAME_KEY = "statsHallOfFame";

export interface HallOfFameEntry {
  id: string;
  /** When it first reached #1 (ISO time). */
  date: string;
}

let hallOfFame: HallOfFameEntry[] = [];

/** The stored list (a JSON string in the config); anything unreadable counts as empty. */
export function parseHallOfFame(value: unknown): HallOfFameEntry[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const list: unknown = JSON.parse(value);
    if (!Array.isArray(list)) return [];
    return list.filter(
      (e): e is HallOfFameEntry =>
        typeof e?.id === "string" && typeof e?.date === "string" && !Number.isNaN(Date.parse(e.date)),
    );
  } catch {
    return [];
  }
}

/**
 * Two lists as one: each scene once, with its earliest time, oldest first (by the stored time, not
 * the day: several scenes can reach #1 on the same day).
 */
export function mergeHallOfFame(a: readonly HallOfFameEntry[], b: readonly HallOfFameEntry[]): HallOfFameEntry[] {
  const earliest = new Map<string, HallOfFameEntry>();
  for (const entry of [...a, ...b]) {
    const known = earliest.get(entry.id);
    if (!known || Date.parse(entry.date) < Date.parse(known.date)) earliest.set(entry.id, entry);
  }
  return [...earliest.values()].sort((x, y) => Date.parse(x.date) - Date.parse(y.date));
}

/** The hall of fame, oldest first (by the time each scene first reached #1). */
export function getHallOfFame(): readonly HallOfFameEntry[] {
  return hallOfFame;
}

/**
 * Add a scene that has just reached #1 (once: its first time is kept) and save the list, merged
 * with the stored one, so another tab's additions aren't lost.
 */
export async function addToHallOfFame(sceneId: string, date = new Date().toISOString()): Promise<void> {
  if (hallOfFame.some((e) => e.id === sceneId)) return;
  hallOfFame = mergeHallOfFame(hallOfFame, [{ id: sceneId, date }]);
  await saveConfig((stored) => {
    hallOfFame = mergeHallOfFame(parseHallOfFame(stored?.[HALL_OF_FAME_KEY]), hallOfFame);
    return { [HALL_OF_FAME_KEY]: JSON.stringify(hallOfFame) };
  });
}

/**
 * Undo: take out the entries for scenes not in `keepIds` (added by the pick being undone), from
 * this tab's list and the stored one.
 */
export async function keepOnlyHallOfFame(keepIds: readonly string[]): Promise<void> {
  const keep = new Set(keepIds);
  if (hallOfFame.every((e) => keep.has(e.id))) return;
  const drop = new Set(hallOfFame.filter((e) => !keep.has(e.id)).map((e) => e.id));
  hallOfFame = hallOfFame.filter((e) => !drop.has(e.id));
  await saveConfig((stored) => {
    hallOfFame = mergeHallOfFame(parseHallOfFame(stored?.[HALL_OF_FAME_KEY]), hallOfFame).filter((e) => !drop.has(e.id));
    return { [HALL_OF_FAME_KEY]: JSON.stringify(hallOfFame) };
  });
}

/** Empty the list (setup, Reset ELO, Settings → Clear hall of fame). Resolves false if saving failed. */
export async function clearHallOfFame(): Promise<boolean> {
  hallOfFame = [];
  return saveConfig({ [HALL_OF_FAME_KEY]: null });
}

/** Update settings locally right away and persist to Stash (debounced, for sliders). */
export function updateSettings(patch: Partial<Settings>): void {
  state.settings = normalize({ ...state.settings, ...patch }, state.settings);
  for (const key of Object.keys(patch) as (keyof Settings)[]) unsaved.add(key);
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void persistSettings();
  }, SAVE_DEBOUNCE_MS);
}

/** Update settings and save to Stash right away (no debounce). Resolves false if saving failed. */
export async function updateSettingsNow(patch: Partial<Settings>): Promise<boolean> {
  state.settings = normalize({ ...state.settings, ...patch }, state.settings);
  for (const key of Object.keys(patch) as (keyof Settings)[]) unsaved.add(key);
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  return persistSettings();
}
