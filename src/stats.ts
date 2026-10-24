// Library-wide numbers worked out from the scenes: tiers, and the Stats tab's overview, ELO
// distribution, hidden gems and how settled the rankings are. Pure functions: no state, no I/O.

import { ELO_K_TIERS, TIERS } from "./constants";
import { battles, elo, isProvisional, percentileRatings, sceneRecord, seed } from "./score";
import type { Scene, SceneRecord, StashRatingsMode, Tier } from "./types";

/** Rated scenes with their ELO (unrated ones dropped). */
function ratedElos(scenes: Scene[]): { scene: Scene; elo: number }[] {
  return scenes
    .map((scene) => ({ scene, elo: elo(scene) }))
    .filter((s): s is { scene: Scene; elo: number } => s.elo !== null);
}

export interface Overview {
  rated: number;
  unrated: number;
  provisional: number;
  /** Sum of every scene's battles: a battle counts once for each scene in it. */
  battles: number;
}

export function overview(scenes: Scene[]): Overview {
  const rated = ratedElos(scenes);
  return {
    rated: rated.length,
    unrated: scenes.length - rated.length,
    provisional: scenes.filter(isProvisional).length,
    battles: rated.reduce((sum, s) => sum + battles(s.scene), 0),
  };
}

export interface HistogramBucket {
  /** The bucket covers from..from + size (exclusive). */
  from: number;
  count: number;
}

/** Rated scenes counted in `size`-ELO buckets, lowest to highest, empty buckets in between included. */
export function eloHistogram(scenes: Scene[], size = 25): HistogramBucket[] {
  const rated = ratedElos(scenes);
  if (rated.length === 0) return [];
  const bucketOf = (value: number): number => Math.floor(value / size) * size;
  const counts = new Map<number, number>();
  for (const { elo: value } of rated) counts.set(bucketOf(value), (counts.get(bucketOf(value)) ?? 0) + 1);
  const lowest = Math.min(...counts.keys());
  const highest = Math.max(...counts.keys());
  const buckets: HistogramBucket[] = [];
  for (let from = lowest; from <= highest; from += size) buckets.push({ from, count: counts.get(from) ?? 0 });
  return buckets;
}

/** The biggest group of scenes sharing one ELO (null when no two scenes share one). */
export function largestTie(scenes: Scene[]): { elo: number; count: number } | null {
  const counts = new Map<number, number>();
  for (const { elo: value } of ratedElos(scenes)) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: { elo: number; count: number } | null = null;
  for (const [value, count] of counts) {
    if (count >= 2 && (!best || count > best.count || (count === best.count && value > best.elo))) {
      best = { elo: value, count };
    }
  }
  return best;
}

export interface ScaleTick {
  elo: number;
  rating: number;
}

/** Stash ratings marked on the ELO axis. */
const SCALE_RATINGS = [1, 25, 50, 75, 100];

/**
 * Where Stash ratings sit on the ELO axis under the update mode: Straight-line is fixed (1 at
 * 1010, 50 at 1500, 100 at 2000); Percentile depends on the library (each mark at the ELO of the
 * scene whose rating is closest to it). None for "off".
 */
export function ratingScaleTicks(scenes: Scene[], mode: StashRatingsMode): ScaleTick[] {
  if (mode === "linear") return SCALE_RATINGS.map((rating) => ({ elo: seed(rating), rating }));
  if (mode !== "percentile") return [];
  const ratings = percentileRatings(scenes);
  const rated = ratedElos(scenes).filter((s) => ratings.has(s.scene.id));
  if (rated.length === 0) return [];
  const ticks: ScaleTick[] = [];
  for (const rating of SCALE_RATINGS) {
    let nearest = rated[0];
    for (const s of rated) {
      const gap = Math.abs((ratings.get(s.scene.id) as number) - rating);
      const nearestGap = Math.abs((ratings.get(nearest.scene.id) as number) - rating);
      if (gap < nearestGap) nearest = s;
    }
    if (!ticks.some((t) => t.elo === nearest.elo)) ticks.push({ elo: nearest.elo, rating });
  }
  return ticks;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The hidden gems chart's quadrant lines: the median ELO and median play count of rated scenes. */
export interface GemsSplit {
  elo: number;
  plays: number;
}

export function gemsSplit(scenes: Scene[]): GemsSplit | null {
  const rated = ratedElos(scenes);
  if (rated.length === 0) return null;
  return { elo: median(rated.map((s) => s.elo)), plays: median(rated.map((s) => s.scene.play_count ?? 0)) };
}

/**
 * "gem": ranked above the median but played less than the median (a hidden gem); "overplayed":
 * below the median ELO but played more. Null for everything else, and for unrated scenes.
 */
export function gemsQuadrant(scene: Scene, split: GemsSplit): "gem" | "overplayed" | null {
  const value = elo(scene);
  if (value === null) return null;
  const plays = scene.play_count ?? 0;
  if (value > split.elo && plays < split.plays) return "gem";
  if (value < split.elo && plays > split.plays) return "overplayed";
  return null;
}

export interface SettledBucket {
  min: number;
  /** Inclusive; null for the open-ended last bucket. */
  max: number | null;
  count: number;
}

/**
 * Rated scenes by real battles: none yet, then the K tiers' ranges (1-9, 10-29, 30+), so each
 * bucket after the first is a stage where a battle moves ELO by a different amount.
 */
export function settledBuckets(scenes: Scene[]): SettledBucket[] {
  const limits = ELO_K_TIERS.map(([below]) => below).filter(Number.isFinite);
  const edges = [0, 1, ...limits];
  const buckets: SettledBucket[] = edges.map((min, i) => ({
    min,
    max: i + 1 < edges.length ? edges[i + 1] - 1 : null,
    count: 0,
  }));
  for (const { scene } of ratedElos(scenes)) {
    const n = battles(scene);
    const bucket = [...buckets].reverse().find((b) => n >= b.min);
    if (bucket) bucket.count++;
  }
  return buckets;
}

/**
 * "Battle the least-tested": the scene in the pool with the fewest real battles (unrated scenes
 * have none), at random among equals. `excludeId` (the scene just shown) is skipped unless it's
 * the only one.
 */
export function leastTested(pool: Scene[], excludeId: string | null, random: () => number = Math.random): Scene | null {
  const candidates = pool.length > 1 ? pool.filter((s) => s.id !== excludeId) : pool;
  if (candidates.length === 0) return null;
  const fewest = Math.min(...candidates.map(battles));
  const tied = candidates.filter((s) => battles(s) === fewest);
  return tied[Math.min(tied.length - 1, Math.floor(random() * tied.length))];
}

/**
 * Tier for every settled scene (rated and not provisional), by rank among them: a scene whose
 * rank is within the top `tier.top` share gets that tier. Tied scenes share the middle position
 * of their tie group, as in percentileRatings, so they always share a tier. Provisional and
 * unrated scenes get none, like "unranked" until placement matches are done.
 */
export function tierMap(scenes: Scene[]): Map<string, Tier> {
  const settled = scenes
    .filter((scene) => !isProvisional(scene))
    .map((scene) => ({ id: scene.id, elo: elo(scene) }))
    .filter((s): s is { id: string; elo: number } => s.elo !== null)
    .sort((a, b) => b.elo - a.elo);

  const tiers = new Map<string, Tier>();
  const n = settled.length;
  let start = 0;
  while (start < n) {
    let end = start;
    while (end + 1 < n && settled[end + 1].elo === settled[start].elo) end++;
    // Share of settled scenes ranked above this tie group's middle (0 for the top scene)
    const above = (start + end) / 2 / n;
    const tier = TIERS.find((t) => above < t.top) ?? TIERS[TIERS.length - 1];
    for (let i = start; i <= end; i++) tiers.set(settled[i].id, tier);
    start = end + 1;
  }
  return tiers;
}

let tierCache: { scenes: Scene[]; key: string; tiers: Map<string, Tier> } | null = null;

/**
 * tierMap for the all-scenes cache, worked out again only when it changes: a different array, or
 * any scene's ELO or battles (battles change them in place). The key is one cheap pass; the sort
 * is skipped.
 */
export function cachedTierMap(scenes: Scene[]): Map<string, Tier> {
  const key = scenes.map((s) => `${elo(s) ?? ""}/${battles(s)}`).join(",");
  if (tierCache?.scenes !== scenes || tierCache.key !== key) tierCache = { scenes, key, tiers: tierMap(scenes) };
  return tierCache.tiers;
}

/** Tooltip for a tier: "Gold: in the top 35% of your scenes with a settled ELO". */
export function tierDescription(tier: Tier): string {
  const index = TIERS.findIndex((t) => t.id === tier.id);
  const percent = (share: number): string => `${Math.round(share * 100)}%`;
  const where =
    index === TIERS.length - 1 && index > 0
      ? `below the top ${percent(TIERS[index - 1].top)}`
      : `in the top ${percent(tier.top)}`;
  return `${tier.name}: ${where} of your scenes with a settled ELO`;
}

/** Up to `n` scenes with a record, highest `key` first (ties keep the library's ELO order). */
export function topByRecord(scenes: Scene[], key: (r: SceneRecord) => number, n: number): { scene: Scene; record: SceneRecord }[] {
  return scenes
    .map((scene) => ({ scene, record: sceneRecord(scene) }))
    .filter((s): s is { scene: Scene; record: SceneRecord } => s.record !== null && key(s.record) > 0)
    .sort((a, b) => key(b.record) - key(a.record))
    .slice(0, n);
}

/**
 * The least-tested pool: how many scenes share the fewest real battles (`count`), that number,
 * and how many of them are unrated (they have no battles, so they're in it whenever it's 0).
 */
export function leastTestedPool(scenes: Scene[]): { battles: number; count: number; unrated: number } | null {
  if (scenes.length === 0) return null;
  const fewest = Math.min(...scenes.map(battles));
  const pool = scenes.filter((s) => battles(s) === fewest);
  return { battles: fewest, count: pool.length, unrated: pool.filter((s) => elo(s) === null).length };
}
