// ELO rating logic (pure calculations — callers apply results and persist).

import { ELO_DIVISOR, ELO_K_TIERS } from "./constants";
import type { ComparisonDeltas, ComparisonInput } from "./types";

// --- Standard ELO (3.0: uncapped, stored in custom fields) ---

/** K for a scene with this many rated games: new scenes move a lot, established ones little. */
export function eloKFactor(games: number): number {
  for (const [below, k] of ELO_K_TIERS) {
    if (games < below) return k;
  }
  return ELO_K_TIERS[ELO_K_TIERS.length - 1][1];
}

/** Probability that a scene rated `elo` beats one rated `opponentElo`. */
export function eloExpected(elo: number, opponentElo: number): number {
  return 1 / (1 + Math.pow(10, (opponentElo - elo) / ELO_DIVISOR));
}

export interface EloSide {
  elo: number;
  games: number;
}

/** Stored ELO precision (one decimal), so small late-career changes aren't rounded away. */
function roundElo(elo: number): number {
  return Math.round(elo * 10) / 10;
}

/** Two-sided ELO for a head-to-head win; each side uses its own K. Returns the new ELOs. */
export function eloResult(winner: EloSide, loser: EloSide): { winner: number; loser: number } {
  const expected = eloExpected(winner.elo, loser.elo);
  return {
    winner: roundElo(winner.elo + eloKFactor(winner.games) * (1 - expected)),
    loser: roundElo(loser.elo - eloKFactor(loser.games) * expected),
  };
}

// --- Pre-3.0 rating100 ELO ---

const MIN_RATING = 1;
const MAX_RATING = 100;

// Dynamic K-factor based on play_count (similar to chess ELO for new vs established players)
export function getKFactor(playCount: number): number {
  if (playCount < 3) return 12;
  if (playCount < 8) return 8;
  if (playCount < 15) return 6;
  return 4;
}

/** Rating used in ELO math: the stored rating, or `unratedRating` for unrated scenes (min 1). */
export function effectiveRating(rating100: number | null | undefined, unratedRating: number): number {
  return rating100 || clampRating(unratedRating);
}

function clampRating(rating: number): number {
  return Math.min(MAX_RATING, Math.max(MIN_RATING, rating));
}

function expectedScore(ratingA: number, ratingB: number): number {
  const ratingDiff = ratingB - ratingA;
  return 1 / (1 + Math.pow(10, ratingDiff / 40));
}

/** Standard two-sided ELO for a head-to-head win. Returns effective deltas (post-clamp). */
export function calculateRatingChanges(input: ComparisonInput): ComparisonDeltas {
  const { winner, loser } = input;

  const expected = expectedScore(winner.rating, loser.rating);
  const winnerChange = Math.max(1, Math.round(getKFactor(winner.playCount) * (1 - expected)));
  const loserChange = -Math.max(1, Math.round(getKFactor(loser.playCount) * expected));

  const winnerNew = clampRating(winner.rating + winnerChange);
  const loserNew = clampRating(loser.rating + loserChange);

  return {
    winner: winnerNew - winner.rating,
    loser: loserNew - loser.rating,
  };
}
