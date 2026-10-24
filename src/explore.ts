// The Explore tab's search, filters and sorting over the library. Pure functions: no state, no I/O.

import { battles, elo, isProvisional } from "./score";
import { cachedTierMap } from "./stats";
import type { Scene, Tier } from "./types";

/** A library scene with what Explore shows and filters on. */
export interface ExploreEntry {
  scene: Scene;
  /** Rank among rated scenes (1 = top), null when unrated. */
  rank: number | null;
  tier: Tier | null;
  /** Lower-cased title, studio and performers, for search. */
  text: string;
}

/** A tier id, or "provisional" / "unrated"; null shows everyone. */
export type ExploreGroup = string | null;

export type ExploreSort = "elo-desc" | "elo-asc" | "plays-desc" | "plays-asc" | "battles-desc" | "battles-asc";

export interface ExploreFilters {
  query: string;
  group: ExploreGroup;
  /** Inclusive ELO range; null for no limit. A range leaves unrated scenes out. */
  eloMin: number | null;
  eloMax: number | null;
  sort: ExploreSort;
}

export const DEFAULT_EXPLORE_FILTERS: ExploreFilters = {
  query: "",
  group: null,
  eloMin: null,
  eloMax: null,
  sort: "elo-desc",
};

/**
 * Entries for an ELO-sorted library (unrated scenes last, as the all-scenes cache keeps it):
 * the index is the rank. `title` names a scene (its title or file name).
 */
export function exploreEntries(
  scenes: Scene[],
  tiers: Map<string, Tier>,
  title: (scene: Scene) => string,
): ExploreEntry[] {
  return scenes.map((scene, index) => ({
    scene,
    rank: elo(scene) === null ? null : index + 1,
    tier: tiers.get(scene.id) ?? null,
    text: [title(scene), scene.studio?.name ?? "", ...(scene.performers ?? []).map((p) => p.name)].join(" ").toLowerCase(),
  }));
}

function inGroup(entry: ExploreEntry, group: ExploreGroup): boolean {
  if (group === null) return true;
  if (group === "unrated") return elo(entry.scene) === null;
  if (group === "provisional") return isProvisional(entry.scene);
  return entry.tier?.id === group;
}

/** Entries matching the filters, in the chosen order. Every word of the query must match. */
export function filterExplore(entries: ExploreEntry[], filters: ExploreFilters): ExploreEntry[] {
  const words = filters.query.toLowerCase().split(/\s+/).filter(Boolean);
  const ranged = filters.eloMin !== null || filters.eloMax !== null;
  const matches = entries.filter((entry) => {
    if (!inGroup(entry, filters.group)) return false;
    if (words.some((word) => !entry.text.includes(word))) return false;
    if (ranged) {
      const value = elo(entry.scene);
      if (value === null) return false;
      if (filters.eloMin !== null && value < filters.eloMin) return false;
      if (filters.eloMax !== null && value > filters.eloMax) return false;
    }
    return true;
  });
  return sortExplore(matches, filters.sort);
}

/** Sorted copy. ELO sorts keep unrated scenes last either way; ties keep the library (ELO) order. */
export function sortExplore(entries: ExploreEntry[], sort: ExploreSort): ExploreEntry[] {
  const byRank = (a: ExploreEntry, b: ExploreEntry): number => (a.rank ?? Infinity) - (b.rank ?? Infinity);
  const plays = (e: ExploreEntry): number => e.scene.play_count ?? 0;
  const compare: Record<ExploreSort, (a: ExploreEntry, b: ExploreEntry) => number> = {
    "elo-desc": byRank,
    "elo-asc": (a, b) => (a.rank === null || b.rank === null ? byRank(a, b) : b.rank - a.rank),
    "plays-desc": (a, b) => plays(b) - plays(a) || byRank(a, b),
    "plays-asc": (a, b) => plays(a) - plays(b) || byRank(a, b),
    "battles-desc": (a, b) => battles(b.scene) - battles(a.scene) || byRank(a, b),
    "battles-asc": (a, b) => battles(a.scene) - battles(b.scene) || byRank(a, b),
  };
  return [...entries].sort(compare[sort]);
}

/**
 * Battling an Explore filter: do both sides come from the filter? Like the Scenes page filter,
 * only with "Use filtered scenes for both sides" (`bothSides`). Never for unrated scenes: they're
 * placed, and placing a scene among other unrated ones (none has an ELO) would land them all at
 * 1500.
 */
export function filterBattlesWithin(filters: ExploreFilters, bothSides: boolean): boolean {
  return bothSides && filters.group !== "unrated";
}

/** The scenes an Explore filter picks from an ELO-sorted library, in ELO order. */
export function explorePoolScenes(scenes: Scene[], filters: ExploreFilters, title: (scene: Scene) => string): Scene[] {
  // Run on every pick: search text is only built when there's a query to match
  const text = filters.query.trim() ? title : (): string => "";
  return filterExplore(exploreEntries(scenes, cachedTierMap(scenes), text), { ...filters, sort: "elo-desc" }).map((e) => e.scene);
}
