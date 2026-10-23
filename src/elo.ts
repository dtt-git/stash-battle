// ELO math (pure calculations: callers apply the results and persist them).

import { ELO_DIVISOR, ELO_K_TIERS } from "./constants";

/** K for a scene with this many K-games (see kGames): new scenes move a lot, established ones little. */
export function eloKFactor(kGames: number): number {
  for (const [below, k] of ELO_K_TIERS) {
    if (kGames < below) return k;
  }
  return ELO_K_TIERS[ELO_K_TIERS.length - 1][1];
}

/** Probability that a scene rated `elo` beats one rated `opponentElo`. */
export function eloExpected(elo: number, opponentElo: number): number {
  return 1 / (1 + Math.pow(10, (opponentElo - elo) / ELO_DIVISOR));
}

export interface EloSide {
  elo: number;
  /** Battles plus any seeded head start (score.ts kGames): sets this side's K. */
  kGames: number;
}

/** Stored ELO precision (one decimal), so small late-career changes aren't rounded away. */
export function roundElo(elo: number): number {
  return Math.round(elo * 10) / 10;
}

/**
 * Two-sided ELO for a head-to-head win; each side uses its own K. Returns the new ELOs.
 * Each side moves by K × (actual − expected): the winner by K × (1 − its win chance), the loser
 * by K × (0 − its own win chance), which is the same 1 − winner's chance. With equal K the
 * points are exactly zero-sum.
 */
export function eloResult(winner: EloSide, loser: EloSide): { winner: number; loser: number } {
  const surprise = 1 - eloExpected(winner.elo, loser.elo);
  return {
    winner: roundElo(winner.elo + eloKFactor(winner.kGames) * surprise),
    loser: roundElo(loser.elo - eloKFactor(loser.kGames) * surprise),
  };
}
