// A scene's ELO (read from its custom fields), ELO ordering, and conversions between ELO and
// Stash's 1-100 rating. Pure functions: no state, no I/O.

import { ELO_FIELD, ELO_PER_RATING_POINT, ELO_START, GAMES_FIELD, SEEDED_GAMES } from "./constants";
import type { EloStart, Scene, StashRatingsMode } from "./types";

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

/** Rated battles the scene's ELO is based on (sets its K). */
export function games(scene: Scene): number {
  const n = readNumber(scene.custom_fields?.[GAMES_FIELD]);
  return n !== null && n > 0 ? Math.floor(n) : 0;
}

/** Starting ELO for a 1-100 Stash rating: 50 is 1500, so 1-100 maps onto 1010-2000. */
export function seed(rating100: number): number {
  return ELO_START + (rating100 - 50) * ELO_PER_RATING_POINT;
}

/** ELO used in battle math: the stored ELO, or seed(unratedRating) for unrated scenes. */
export function effectiveElo(scene: Scene, unratedRating: number): number {
  return elo(scene) ?? seed(unratedRating);
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
export function startingElo(scene: Scene, start: EloStart): { elo: number; games: number } | null {
  if (start === "fresh") return { elo: ELO_START, games: 0 };
  return scene.rating100 != null ? { elo: seed(scene.rating100), games: SEEDED_GAMES } : null;
}

/** A copy of the scene as it would be right after setup (its ELO fields replaced). */
export function afterSetup(scene: Scene, start: EloStart): Scene {
  const custom_fields = { ...scene.custom_fields };
  delete custom_fields[ELO_FIELD];
  delete custom_fields[GAMES_FIELD];
  const initial = startingElo(scene, start);
  if (initial) {
    custom_fields[ELO_FIELD] = initial.elo;
    custom_fields[GAMES_FIELD] = initial.games;
  }
  return { ...scene, custom_fields };
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
