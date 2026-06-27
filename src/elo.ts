// ELO rating logic (pure calculations — callers apply results and persist).

import type { ComparisonDeltas, ComparisonInput } from "./types";

const MIN_RATING = 1;
const MAX_RATING = 100;

// Dynamic K-factor based on play_count (similar to chess ELO for new vs established players)
export function getKFactor(playCount: number): number {
  if (playCount < 3) return 12;
  if (playCount < 8) return 8;
  if (playCount < 15) return 6;
  return 4;
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
