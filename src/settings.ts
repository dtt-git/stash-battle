// User settings stored in Stash's plugin configuration (configuration.plugins["stash-battle"]),
// so they follow the user across browsers. Also editable in Stash → Settings → Plugins.

import {
  DEFAULT_SETTINGS,
  LEGACY_FILTER_OPPONENTS_KEY,
  LEGACY_MUTE_PREVIEWS_KEY,
  PLUGIN_ID,
} from "./constants";
import { graphqlQuery } from "./graphql";
import { state } from "./state";
import type { EloStart, Settings, StashRatingsMode } from "./types";

const CONFIG_QUERY = `{ configuration { plugins } }`;

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
    // A missing or unknown value is "off". (Removed keys, funMode and unratedRating, are dropped.)
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
    showTiers: bool("showTiers"),
    previewVolume: clampPercent(raw.previewVolume ?? base.previewVolume, base.previewVolume),
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
    const stored = await fetchStoredConfig();
    legacyFunMode = stored?.funMode === true;
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

async function persistSettings(): Promise<boolean> {
  const keys = [...unsaved];
  unsaved.clear();
  try {
    // configurePlugin replaces the whole map, so this tab's unsaved changes go on top of the
    // stored config, not this tab's copy of it: another tab may have saved since this one loaded
    // (finished the ELO setup, say), and an older copy would undo that.
    const stored = await fetchStoredConfig();
    const merged: Record<string, unknown> = stored ? { ...normalize(stored, state.settings) } : { ...state.settings };
    for (const key of keys) merged[key] = state.settings[key];
    // Unset keys are left out
    const input = Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== null));
    await graphqlQuery(CONFIGURE_PLUGIN_MUTATION, { plugin_id: PLUGIN_ID, input });
    return true;
  } catch (e) {
    console.error("[Stash Battle] Failed to save settings:", e);
    for (const key of keys) unsaved.add(key);
    return false;
  }
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
