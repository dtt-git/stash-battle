// Matchmaking: build the scene pairs for each comparison mode.

import { clearFilteredCache, getAllScenesCached, getFilteredScenesCached } from "./cache";
import {
  CHAMPION_UNRATED_RATING,
  CLIMB_OPPONENT_PICK_WINDOW,
  SWISS_OPPONENT_REACH_INITIAL,
  SWISS_OPPONENT_REACH_MULTIPLIER,
} from "./constants";
import { readFilters, type ListFilters } from "./filters";
import { landingElo, newPlacementRun, placementStep } from "./placement";
import { writeElo } from "./rating";
import { effectiveElo, elo, eloInsertionIndex, games, isRated } from "./score";
import { state } from "./state";
import type { ChampionPairResult, PlacementPairResult, Rank, Scene, SwissPairResult } from "./types";

function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// Track last scene to avoid immediate repeat after reshuffle
let lastShownSceneId: string | null = null;

/** True once every scene in the current shuffle has been shown (time to re-query the filter). */
function isShuffleCycleComplete(filterKey: string): boolean {
  return (
    state.shuffleFilterKey === filterKey &&
    state.shuffledFilteredScenes.length > 0 &&
    state.shuffleIndex >= state.shuffledFilteredScenes.length
  );
}

/** Reshuffle the left pool for a new pass, without showing the previous pass's last scene first. */
function startNewPass(leftPool: Scene[]): void {
  console.log("[Stash Battle] 🔀 Reshuffling (completed full cycle)");
  state.shuffledFilteredScenes = shuffleArray(leftPool);
  state.shuffleIndex = 0;

  if (
    lastShownSceneId &&
    state.shuffledFilteredScenes.length > 1 &&
    state.shuffledFilteredScenes[0].id === lastShownSceneId
  ) {
    const swapIdx = 1 + Math.floor(Math.random() * (state.shuffledFilteredScenes.length - 1));
    [state.shuffledFilteredScenes[0], state.shuffledFilteredScenes[swapIdx]] = [
      state.shuffledFilteredScenes[swapIdx],
      state.shuffledFilteredScenes[0],
    ];
    console.log("[Stash Battle] 🔄 Swapped first scene to avoid repeat");
  }
}

/** Next left-side scene from the shuffled left pool (no network fetch). Scenes stay in the pool. */
function getNextFilteredScene(leftPool: Scene[], filterKey: string): Scene | null {
  if (leftPool.length === 0) {
    console.log("[Stash Battle] 🏁 Filtered pool is empty");
    return null;
  }

  if (filterKey !== state.shuffleFilterKey || state.shuffledFilteredScenes.length === 0) {
    console.log("[Stash Battle] 🔀 Shuffling filtered scenes (filter changed or first load)");
    state.shuffledFilteredScenes = shuffleArray(leftPool);
    state.shuffleIndex = 0;
    state.shuffleFilterKey = filterKey;
    lastShownSceneId = null;
  }

  if (state.shuffleIndex >= state.shuffledFilteredScenes.length) {
    startNewPass(leftPool);
  }

  const scene = state.shuffledFilteredScenes[state.shuffleIndex];
  state.shuffleIndex++;
  lastShownSceneId = scene.id;
  console.log(
    `[Stash Battle] 📍 Picked scene ${scene.id} (${state.shuffledFilteredScenes.length - state.shuffleIndex} left in this pass)`,
  );
  return scene;
}

/**
 * Opponents (right side), sorted by ELO: scenes with an ELO, or the filtered scenes when "use
 * filtered scenes for both sides" is on (unrated ones then sort last).
 */
function buildOpponentPool(allScenes: Scene[], leftPool: Scene[], filters: ListFilters): Scene[] {
  if (state.settings.filterOpponents && filters.filterActive) {
    return leftPool;
  }
  const rated = allScenes.filter(isRated);
  return rated.length >= 1 ? rated : allScenes;
}

/** Load the left ("to rate") and full pools. Both come from the cache, sorted by ELO. */
async function loadScenePools(
  filters: ListFilters,
): Promise<{ leftPool: Scene[]; allScenes: Scene[] }> {
  let leftPool: Scene[];
  let allScenes: Scene[];

  if (filters.filterActive) {
    // Re-query the filter after each full pass so filters like "unrated" shrink as scenes get rated
    const passComplete = isShuffleCycleComplete(filters.filterKey);
    if (passComplete) {
      console.log("[Stash Battle] 🔁 Pass complete, re-fetching filtered scenes");
      await clearFilteredCache();
    }
    console.log("[Stash Battle] 📋 Filter active, fetching filtered + all scenes");
    const [filteredResult, allResult] = await Promise.all([
      getFilteredScenesCached(filters),
      getAllScenesCached(),
    ]);
    leftPool = filteredResult.scenes || [];
    allScenes = allResult.scenes || [];
    // Start the next pass now, so later loads in a run (which pick no new left scene) don't
    // see the pass as complete and re-fetch the filter every time
    if (passComplete) startNewPass(leftPool);
  } else {
    console.log("[Stash Battle] 📋 No filter active, using all scenes");
    allScenes = (await getAllScenesCached()).scenes || [];
    leftPool = allScenes;
  }

  state.leftPoolSize = leftPool.length;
  return { leftPool, allScenes };
}

/** Load the pools (served from cache when possible) just to record the left pool's size. */
export async function loadPoolSize(): Promise<void> {
  await loadScenePools(readFilters());
}

/** Load left (scene to rate) and right (opponent) pools for Swiss. */
async function buildSwissPools(): Promise<{
  leftPool: Scene[];
  rightPool: Scene[];
  filterKey: string;
}> {
  const filters = readFilters();
  const { leftPool, allScenes } = await loadScenePools(filters);

  if (allScenes.length < 2) {
    throw new Error("Not enough scenes for comparison.");
  }

  const rightPool = buildOpponentPool(allScenes, leftPool, filters);
  if (state.settings.filterOpponents && filters.filterActive && rightPool.length < 2) {
    throw new Error("Not enough scenes in your filter for a match. You need at least 2 scenes.");
  }

  return { leftPool, rightPool, filterKey: filters.filterKey };
}

// Swiss mode: left = scene to rate (filtered pool), right = similar-strength opponent
export async function fetchSwissPair(forcedLeftScene: Scene | null = null): Promise<SwissPairResult> {
  const { leftPool, rightPool, filterKey } = await buildSwissPools();

  const scene1 = forcedLeftScene || getNextFilteredScene(leftPool, filterKey);
  if (!scene1) {
    throw new Error("No scenes match your filter criteria.");
  }

  const { scene2, ranks } = pickSwissOpponent(scene1, rightPool);
  return { scenes: [scene1, scene2], ranks };
}

/** Pick a random opponent near scene1's rank in the ELO-sorted right pool (expanding band if needed). */
function pickSwissOpponent(
  scene1: Scene,
  rightPool: Scene[],
): { scene2: Scene; ranks: [Rank, Rank] } {
  const scene1IdxInPool = rightPool.findIndex((s) => s.id === scene1.id);
  // Rated scenes match around their own rank; unrated ones around where `unratedRating` would sit
  const effectiveScene1Idx =
    isRated(scene1) && scene1IdxInPool >= 0
      ? scene1IdxInPool
      : eloInsertionIndex(rightPool, effectiveElo(scene1, state.settings.unratedRating));
  const scene1RankInPool = scene1IdxInPool >= 0 ? scene1IdxInPool + 1 : null;

  const candidates: { scene: Scene; idx: number }[] = [];
  // Prefer similar-strength matchups (±reach ranks). If the band is empty (edges, unrated left
  // scene, tiny pool), double reach until we find candidates or cover the whole pool.
  for (
    let reach = Math.min(SWISS_OPPONENT_REACH_INITIAL, rightPool.length);
    candidates.length === 0 && reach <= rightPool.length;
    reach = Math.min(reach * SWISS_OPPONENT_REACH_MULTIPLIER, rightPool.length)
  ) {
    for (let i = effectiveScene1Idx - reach; i <= effectiveScene1Idx + reach; i++) {
      if (i >= 0 && i < rightPool.length && i !== scene1IdxInPool) {
        candidates.push({ scene: rightPool[i], idx: i });
      }
    }
    if (reach === rightPool.length) break;
  }

  if (candidates.length === 0) {
    throw new Error("Not enough scenes for comparison. You need at least 2 scenes.");
  }

  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  return {
    scene2: pick.scene,
    ranks: [scene1RankInPool, pick.idx + 1],
  };
}

/** Random pick from the N unbeaten opponents closest above the champion (list is ELO-sorted). */
function pickClosestChampionOpponent(remainingOpponents: Scene[]): Scene {
  const closest = remainingOpponents.slice(-CLIMB_OPPONENT_PICK_WINDOW);
  return closest[Math.floor(Math.random() * closest.length)];
}

/** Opponents above the champion in the ELO-sorted pool that it hasn't beaten in this run. */
function getRemainingChampionOpponents(champion: Scene, rightPool: Scene[], championIndex: number): Scene[] {
  const championElo = effectiveElo(champion, CHAMPION_UNRATED_RATING);
  return rightPool.filter((s, idx) => {
    if (s.id === champion.id || state.championDefeated.includes(s.id)) return false;
    return idx < championIndex || (elo(s) ?? -Infinity) >= championElo;
  });
}

/** Lowest scene with an ELO in the pool (excluding one scene), or any other scene if none has one. */
function findLowestRated(scenes: Scene[], excludeId: string): { scene: Scene | undefined; index: number } {
  for (let i = scenes.length - 1; i >= 0; i--) {
    const s = scenes[i];
    if (s.id !== excludeId && isRated(s)) {
      return { scene: s, index: i };
    }
  }
  const fallbackIndex = scenes.findIndex((s) => s.id !== excludeId);
  return { scene: scenes[fallbackIndex], index: fallbackIndex };
}

// Champion mode: winner stays on, starting against the lowest-rated scene
export async function fetchChampionPair(
  forcedLeftScene: Scene | null = null,
): Promise<ChampionPairResult> {
  const filters = readFilters();

  console.log("[Stash Battle] 📋 Fetching scenes for champion...");
  const { leftPool, allScenes } = await loadScenePools(filters);

  const rightPool = buildOpponentPool(allScenes, leftPool, filters);
  state.totalScenesCount = rightPool.length;

  if (allScenes.length < 2) {
    throw new Error("Not enough scenes for comparison.");
  }

  // No champion yet: the challenger from the left pool starts against the lowest-rated scene
  if (!state.championScene) {
    state.championDefeated = [];

    const challenger = forcedLeftScene || getNextFilteredScene(leftPool, filters.filterKey);
    if (!challenger) {
      throw new Error("No scenes match your filter criteria.");
    }

    const challengerIndex = rightPool.findIndex((s) => s.id === challenger.id);
    const { scene: lowestRated, index: lowestIndex } = findLowestRated(rightPool, challenger.id);
    if (!lowestRated) {
      throw new Error("Not enough scenes for comparison. You need at least 2 scenes.");
    }

    return {
      scenes: [challenger, lowestRated],
      ranks: [challengerIndex >= 0 ? challengerIndex + 1 : null, lowestIndex + 1],
      isVictory: false,
    };
  }

  const champion = state.championScene;
  const championIndex = rightPool.findIndex((s) => s.id === champion.id);
  const remainingOpponents = getRemainingChampionOpponents(champion, rightPool, championIndex);

  // No opponents left: the champion has beaten everyone above it
  if (remainingOpponents.length === 0) {
    return { scenes: [champion], ranks: [1], isVictory: true };
  }

  const nextOpponent = pickClosestChampionOpponent(remainingOpponents);
  const nextOpponentIndex = rightPool.findIndex((s) => s.id === nextOpponent.id);

  return {
    scenes: [champion, nextOpponent],
    ranks: [championIndex >= 0 ? championIndex + 1 : null, nextOpponentIndex + 1],
    isVictory: false,
  };
}

// --- Placement mode (the search itself is in placement.ts) ---

/** Random pick among scenes in [lo, hi) that share pool[idx]'s ELO (their order is arbitrary). */
function pickAmongTies(pool: Scene[], idx: number, lo: number, hi: number): number {
  const target = elo(pool[idx]);
  const ties: number[] = [];
  for (let i = lo; i < hi; i++) {
    if (elo(pool[i]) === target) ties.push(i);
  }
  return ties[Math.floor(Math.random() * ties.length)];
}

// Placement mode: left = scene being placed, right = the next opponent in its search range
export async function fetchPlacementPair(
  forcedLeftScene: Scene | null = null,
): Promise<PlacementPairResult> {
  const filters = readFilters();
  const { leftPool, allScenes } = await loadScenePools(filters);

  if (allScenes.length < 2) {
    throw new Error("Not enough scenes for comparison.");
  }

  if (!state.placement) {
    const scene = forcedLeftScene || getNextFilteredScene(leftPool, filters.filterKey);
    if (!scene) {
      throw new Error("No scenes match your filter criteria.");
    }
    state.placement = newPlacementRun(scene, state.settings.placementFromBottom);
  }
  const run = state.placement;

  const pool = buildOpponentPool(allScenes, leftPool, filters).filter((s) => s.id !== run.scene.id);
  if (pool.length === 0) {
    throw new Error("Not enough scenes for comparison. You need at least 2 scenes.");
  }
  state.totalScenesCount = pool.length + 1;

  const step = placementStep(run, pool);
  run.rangeLo = Math.min(step.lo, step.hi);
  run.rangeHi = step.hi;

  if (step.done) {
    // Only the placed scene's ELO changes; its games count the battles this run took
    const newElo = landingElo(pool, step.slot);
    const newGames = games(run.scene) + run.battles;
    console.log(
      `[Stash Battle] 📍 Placement: scene ${run.scene.id} placed at #${step.slot + 1} after ${run.battles} battles, ELO ${newElo}`,
    );
    await writeElo(run.scene, newElo, newGames);
    return {
      done: true,
      scene: run.scene,
      rank: step.slot + 1,
      elo: newElo,
      battles: run.battles,
      streak: run.streak,
      fromBottom: run.fromBottom,
    };
  }

  const idx = pickAmongTies(pool, step.index, step.lo, step.hi);
  return { done: false, scenes: [run.scene, pool[idx]], ranks: [null, idx + 1] };
}
