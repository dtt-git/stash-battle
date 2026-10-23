// Placement search, kept pure (no state or I/O) so whole runs can be simulated in tests.
//
// The scene's slot lies in [lo, hi) of the ELO-sorted opponent pool. A win against index i
// means the slot is above i (hi = i); a loss means it's below (lo = i + 1). A rated scene starts
// next to its current ELO and gallops (steps 1, 2, 4, 8...) while results keep going the same
// way; the first reversal (or an unrated scene) switches to halving the remaining range.
// "Start from the bottom" runs ignore the scene's ELO: they start against the bottom scene and
// gallop upward, so each win doubles the jump until the first loss.

import { PLACEMENT_MAX_JUMP_SHARE, PLACEMENT_MIN_MAX_JUMP } from "./constants";
import { elo, eloInsertionIndex, placementElo } from "./score";
import type { PlacementRun, Scene } from "./types";

export function newPlacementRun(scene: Scene, fromBottom: boolean): PlacementRun {
  return {
    scene,
    fromBottom,
    aboveId: null,
    belowId: null,
    lastOpponentId: null,
    lastWon: null,
    galloping: fromBottom || elo(scene) !== null,
    step: 1,
    battles: 0,
    streak: 0,
    rangeLo: 0,
    rangeHi: 0,
  };
}

/** Current [lo, hi) slot bounds, resolved from the bounding opponents' ids. */
export function placementBounds(run: PlacementRun, pool: Scene[]): { lo: number; hi: number } {
  const aboveIdx = run.aboveId ? pool.findIndex((s) => s.id === run.aboveId) : -1;
  const belowIdx = run.belowId ? pool.findIndex((s) => s.id === run.belowId) : -1;
  return { lo: aboveIdx + 1, hi: belowIdx >= 0 ? belowIdx : pool.length };
}

/** The pool's lowest scene with an ELO (unrated ones sort last), or its last scene if none has one. */
export function bottomIndex(pool: Scene[]): number {
  for (let i = pool.length - 1; i >= 0; i--) {
    if (elo(pool[i]) !== null) return i;
  }
  return pool.length - 1;
}

/** Largest jump a galloping run makes in this pool (see PLACEMENT_MAX_JUMP_SHARE). */
export function maxPlacementJump(poolSize: number): number {
  return Math.max(PLACEMENT_MIN_MAX_JUMP, Math.round(poolSize * PLACEMENT_MAX_JUMP_SHARE));
}

/** Where the next opponent should come from (before clamping into [lo, hi)). */
function nextPlacementIndex(run: PlacementRun, pool: Scene[], lo: number, hi: number): number {
  if (run.galloping) {
    if (run.lastOpponentId === null) {
      if (run.fromBottom) return bottomIndex(pool);
      // Start just below the scene's current ELO: a correctly rated scene confirms in ~2 battles
      return eloInsertionIndex(pool, elo(run.scene) ?? 0);
    }
    const lastIdx = pool.findIndex((s) => s.id === run.lastOpponentId);
    if (lastIdx >= 0) {
      // Step from the far edge of the last opponent's tie group: another equal ELO teaches nothing
      const dir = run.lastWon ? -1 : 1;
      const lastElo = elo(pool[lastIdx]);
      let edge = lastIdx;
      while (edge + dir >= 0 && edge + dir < pool.length && elo(pool[edge + dir]) === lastElo) {
        edge += dir;
      }
      const target = edge + dir * Math.min(run.step, maxPlacementJump(pool.length));
      // A jump past the search range would land on its end (straight to #1, say): halve instead
      if (target >= lo && target < hi) return target;
    }
  }
  return lo + Math.floor((hi - lo) / 2);
}

export type PlacementStep =
  | { done: true; slot: number; lo: number; hi: number }
  | { done: false; index: number; lo: number; hi: number };

/** The run's next step on this pool: the opponent index to battle, or the slot it has landed in. */
export function placementStep(run: PlacementRun, pool: Scene[]): PlacementStep {
  const { lo, hi } = placementBounds(run, pool);
  if (lo >= hi) return { done: true, slot: Math.min(lo, hi), lo, hi };
  const index = Math.max(lo, Math.min(hi - 1, nextPlacementIndex(run, pool, lo, hi)));
  return { done: false, index, lo, hi };
}

/** Record a placement battle result and update the momentum and the win streak. */
export function recordPlacementResult(run: PlacementRun, won: boolean, opponentId: string): void {
  if (run.lastWon !== null) {
    if (run.lastWon === won) run.step *= 2;
    else run.galloping = false;
  }
  if (won) run.belowId = opponentId;
  else run.aboveId = opponentId;

  // The streak counts wins until the first loss, so it only grows while every battle was a win
  if (won && run.streak === run.battles) run.streak++;
  run.lastOpponentId = opponentId;
  run.lastWon = won;
  run.battles++;
}

/**
 * ELO for a scene landing at `slot` of the pool: between the nearest neighbours that have an ELO
 * (unrated opponents, possible in a filtered pool, say nothing about it). See placementElo.
 */
export function landingElo(pool: Scene[], slot: number): number {
  let above: number | null = null;
  for (let i = slot - 1; i >= 0 && above === null; i--) above = elo(pool[i]);
  let below: number | null = null;
  for (let i = slot; i < pool.length && below === null; i++) below = elo(pool[i]);
  return placementElo(above, below);
}
