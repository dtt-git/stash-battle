// A scene's ELO (read from its custom fields), ELO ordering, and conversions between ELO and
// Stash's 1-100 rating. Pure functions: no state, no I/O.

import {
  BATTLES_FIELD,
  BEST_STREAK_FIELD,
  ELO_FIELD,
  ELO_FIELD_KEYS,
  ELO_K_TIERS,
  ELO_PER_RATING_POINT,
  ELO_START,
  LOSSES_FIELD,
  PEAK_FIELD,
  PLACEMENT_EDGE_GAP,
  SEEDED_FIELD,
  SEEDED_HEAD_START,
  STREAK_FIELD,
  WINS_FIELD,
} from "./constants";
import { roundElo } from "./elo";
import type { EloFields, EloStart, Scene, SceneRecord, StashRatingsMode } from "./types";

/** Custom field values should come back as numbers; numeric strings are accepted too. */
function readNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** The scene's stored ELO, or null when it has none (unrated). */
export function elo(scene: Scene): number | null {
  return readNumber(scene.custom_fields?.[ELO_FIELD]);
}

export function isRated(scene: Scene): boolean {
  return elo(scene) !== null;
}

/** Real battles that moved the scene's ELO. */
export function battles(scene: Scene): number {
  const n = readNumber(scene.custom_fields?.[BATTLES_FIELD]);
  return n !== null && n > 0 ? Math.floor(n) : 0;
}

/** The scene's starting ELO came from its Stash rating. (Stash stores `true` as 1.) */
export function isSeeded(scene: Scene): boolean {
  const value = scene.custom_fields?.[SEEDED_FIELD];
  return value === true || value === 1 || value === "true" || value === "1";
}

/** The count K is based on: real battles, plus the head start for seeded scenes. */
export function kGames(scene: Scene): number {
  return battles(scene) + (isSeeded(scene) ? SEEDED_HEAD_START : 0);
}

/**
 * The scene's ELO is still settling: it has fewer K-games than the first K tier's limit (10), the
 * stage where each battle moves it the most. Seeded scenes start past it; unrated ones aren't.
 */
export function isProvisional(scene: Scene): boolean {
  return isRated(scene) && kGames(scene) < ELO_K_TIERS[0][0];
}

/** The scene's record, or null before its first battle since records began. */
export function sceneRecord(scene: Scene): SceneRecord | null {
  const fields = scene.custom_fields;
  const count = (key: string): number | null => {
    const n = readNumber(fields?.[key]);
    return n === null ? null : Math.max(0, Math.floor(n));
  };
  const wins = count(WINS_FIELD);
  const losses = count(LOSSES_FIELD);
  const peak = readNumber(fields?.[PEAK_FIELD]);
  if (wins === null && losses === null && peak === null) return null;
  return {
    wins: wins ?? 0,
    losses: losses ?? 0,
    peak: peak ?? elo(scene) ?? 0,
    streak: count(STREAK_FIELD) ?? 0,
    bestStreak: count(BEST_STREAK_FIELD) ?? 0,
  };
}

/**
 * "12–5" (wins–losses), or null for a scene whose battles all came before records began (it
 * shows its battle count instead). A scene with no battles at all shows "0–0".
 */
export function recordText(scene: Scene): string | null {
  const record = sceneRecord(scene);
  if (record) return `${record.wins}–${record.losses}`;
  return battles(scene) === 0 ? "0–0" : null;
}

/**
 * A record after more picks, in order (true = won), with the peak raised to `newElo`. A scene's
 * first record starts from `startElo` (its ELO before these picks) as the peak.
 */
export function recordAfter(record: SceneRecord | null, results: boolean[], startElo: number, newElo: number): SceneRecord {
  const next: SceneRecord = record ? { ...record } : { wins: 0, losses: 0, peak: startElo, streak: 0, bestStreak: 0 };
  for (const won of results) {
    if (won) {
      next.wins++;
      next.streak++;
      next.bestStreak = Math.max(next.bestStreak, next.streak);
    } else {
      next.losses++;
      next.streak = 0;
    }
  }
  next.peak = roundElo(Math.max(next.peak, newElo));
  return next;
}

/** EloFields as the custom fields map Stash stores (the record's fields only once it has one). */
export function eloCustomFields(value: EloFields): Record<string, unknown> {
  const fields: Record<string, unknown> = { [ELO_FIELD]: value.elo, [BATTLES_FIELD]: value.battles, [SEEDED_FIELD]: value.seeded };
  const record = value.record;
  if (record) {
    Object.assign(fields, {
      [WINS_FIELD]: record.wins,
      [LOSSES_FIELD]: record.losses,
      [PEAK_FIELD]: record.peak,
      [STREAK_FIELD]: record.streak,
      [BEST_STREAK_FIELD]: record.bestStreak,
    });
  }
  return fields;
}

/** Starting ELO for a 1-100 Stash rating: 50 is 1500, so 1-100 maps onto 1010-2000. */
export function seed(rating100: number): number {
  return ELO_START + (rating100 - 50) * ELO_PER_RATING_POINT;
}

/** ELO used in battle math: the stored ELO, or `unratedElo` for unrated scenes (1500 by default). */
export function effectiveElo(scene: Scene, unratedElo: number = ELO_START): number {
  return elo(scene) ?? unratedElo;
}

/** Straight-line Stash rating: the inverse of seed(), clamped to 1-100. */
export function linearRating(eloValue: number): number {
  const rating = Math.round(50 + (eloValue - ELO_START) / ELO_PER_RATING_POINT);
  return Math.min(100, Math.max(1, rating));
}

/**
 * Percentile Stash ratings for every scene with an ELO: the top scene is 100, the bottom 1,
 * evenly spaced by rank. Tied scenes share the middle position of their tie group, so a fully
 * tied library is 50 everywhere. Unrated scenes are left out.
 */
export function percentileRatings(scenes: Scene[]): Map<string, number> {
  const rated = scenes
    .map((scene) => ({ id: scene.id, elo: elo(scene) }))
    .filter((s): s is { id: string; elo: number } => s.elo !== null)
    .sort((a, b) => b.elo - a.elo);

  const ratings = new Map<string, number>();
  const n = rated.length;
  if (n === 1) {
    ratings.set(rated[0].id, 50);
    return ratings;
  }

  let start = 0;
  while (start < n) {
    let end = start;
    while (end + 1 < n && rated[end + 1].elo === rated[start].elo) end++;
    // Rounding inside keeps a tie at the exact middle on 50 rather than 51
    const rating = 100 - Math.round((99 * ((start + end) / 2)) / (n - 1));
    for (let i = start; i <= end; i++) ratings.set(rated[i].id, rating);
    start = end + 1;
  }
  return ratings;
}

/** Target Stash rating for every scene with an ELO, under the given mode (none for "off"). */
export function stashRatingTargets(scenes: Scene[], mode: StashRatingsMode): Map<string, number> {
  if (mode === "percentile") return percentileRatings(scenes);
  const targets = new Map<string, number>();
  if (mode === "linear") {
    for (const scene of scenes) {
      const value = elo(scene);
      if (value !== null) targets.set(scene.id, linearRating(value));
    }
  }
  return targets;
}

/** The Stash ratings a sync would write: scene id to new rating, only where it differs from now. */
export function stashRatingChanges(scenes: Scene[], mode: StashRatingsMode): Map<string, number> {
  const current = new Map(scenes.map((scene) => [scene.id, scene.rating100 ?? null]));
  const changes = new Map<string, number>();
  for (const [id, rating] of stashRatingTargets(scenes, mode)) {
    if (current.get(id) !== rating) changes.set(id, rating);
  }
  return changes;
}

/**
 * ELO and games a scene gets from the one-time setup, or null when it starts unrated.
 * "ratings" seeds rated scenes from their Stash rating; "fresh" starts every scene at 1500.
 */
export function startingElo(scene: Scene, start: EloStart): EloFields | null {
  if (start === "fresh") return { elo: ELO_START, battles: 0, seeded: false };
  return scene.rating100 != null ? { elo: seed(scene.rating100), battles: 0, seeded: true } : null;
}

/** A copy of a custom fields map with the ELO fields set to `value` (or, with null, removed). */
export function withEloFields(customFields: Record<string, unknown> | null | undefined, value: EloFields | null): Record<string, unknown> {
  const fields = { ...customFields };
  for (const key of ELO_FIELD_KEYS) delete fields[key];
  if (value) Object.assign(fields, eloCustomFields(value));
  return fields;
}

/** The scene's ELO fields (and record, once it has one), or null when it's unrated. */
export function eloFields(scene: Scene): EloFields | null {
  const value = elo(scene);
  if (value === null) return null;
  const record = sceneRecord(scene);
  return { elo: value, battles: battles(scene), seeded: isSeeded(scene), ...(record ? { record } : {}) };
}

/** A copy of the scene as it would be right after setup (its ELO fields replaced). */
export function afterSetup(scene: Scene, start: EloStart): Scene {
  return { ...scene, custom_fields: withEloFields(scene.custom_fields, startingElo(scene, start)) };
}

/** Highest ELO first, unrated scenes last. Equal ELOs keep their order (Array.sort is stable). */
export function compareByElo(a: Scene, b: Scene): number {
  const eloA = elo(a);
  const eloB = elo(b);
  if (eloA === null) return eloB === null ? 0 : 1;
  if (eloB === null) return -1;
  return eloB - eloA;
}

/** Sort scenes in place by ELO (see compareByElo) and return the same array. */
export function sortByElo(scenes: Scene[]): Scene[] {
  return scenes.sort(compareByElo);
}

/** Index where a scene with this ELO would sit in an ELO-sorted pool: below every equal or higher one. */
export function eloInsertionIndex(pool: Scene[], eloValue: number): number {
  const idx = pool.findIndex((s) => {
    const other = elo(s);
    return other === null || other < eloValue;
  });
  return idx === -1 ? pool.length : idx;
}

/**
 * Indexes of the Swiss opponents for a scene at `eloValue`: every scene in the pool within
 * ±`window` ELO (unrated ones count as ELO_START, as in Swiss battles), or, when that's fewer than
 * `minCount`, the `minCount` nearest by ELO (plus any tied with the last of them). The scene
 * itself (`excludeId`) is never one.
 */
export function swissOpponentIndexes(
  pool: Scene[],
  eloValue: number,
  excludeId: string,
  window: number,
  minCount: number,
): number[] {
  const others = pool
    .map((scene, idx) => ({ idx, gap: Math.abs(effectiveElo(scene) - eloValue), id: scene.id }))
    .filter((s) => s.id !== excludeId);
  const inWindow = others.filter((s) => s.gap <= window);
  if (inWindow.length >= minCount || inWindow.length === others.length) return inWindow.map((s) => s.idx);
  const byGap = [...others].sort((a, b) => a.gap - b.gap);
  const cutoff = byGap[Math.min(minCount, byGap.length) - 1].gap;
  return byGap.filter((s) => s.gap <= cutoff).map((s) => s.idx).sort((a, b) => a - b);
}

/**
 * ELO for a scene Placement lands between two neighbours (null where there's none, or the
 * neighbour is unrated): their midpoint, or PLACEMENT_EDGE_GAP beyond the only one at an edge.
 */
export function placementElo(aboveElo: number | null, belowElo: number | null): number {
  if (aboveElo === null && belowElo === null) return ELO_START;
  if (aboveElo === null) return roundElo((belowElo as number) + PLACEMENT_EDGE_GAP);
  if (belowElo === null) return roundElo(aboveElo - PLACEMENT_EDGE_GAP);
  // Neighbours 0.1 apart (or tied) have no room between them: take the upper one's ELO, which
  // still sorts the scene below it (equal ELOs go below) and so in the same slot
  const mid = roundElo((aboveElo + belowElo) / 2);
  return mid > belowElo ? mid : aboveElo;
}
