// Matchmaking: build the scene pairs for each comparison mode.

import { clearFilteredCache, getAllScenesCached, getFilteredScenesCached, latestScene } from "./cache";
import {
  CHAMPION_UNRATED_ELO,
  CLIMB_OPPONENT_PICK_WINDOW,
  SWISS_OPPONENT_ELO_WINDOW,
  SWISS_OPPONENT_MIN_CANDIDATES,
} from "./constants";
import { explorePoolScenes } from "./explore";
import { readFilters, type ListFilters } from "./filters";
import { landingElo, newPlacementRun, placementStep } from "./placement";
import { writeElo } from "./rating";
import { battles, effectiveElo, elo, isRated, swissOpponentIndexes } from "./score";
import { explorePoolWithin, state } from "./state";
import { resolveSceneTitle } from "./sceneTitle";
import { leastTested } from "./stats";
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

  // The shuffle keeps its pass's scene objects; a background refresh may have replaced them since,
  // and scenes that have left the pool (placed out of an "Unrated" pool, say) are skipped
  const inPool = new Map(leftPool.map((s) => [s.id, s]));
  let scene: Scene | undefined;
  for (let tries = 0; !scene && tries < 2; tries++) {
    if (state.shuffleIndex >= state.shuffledFilteredScenes.length) startNewPass(leftPool);
    while (!scene && state.shuffleIndex < state.shuffledFilteredScenes.length) {
      scene = inPool.get(state.shuffledFilteredScenes[state.shuffleIndex].id);
      state.shuffleIndex++;
    }
  }
  if (!scene) return null;
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
  if (state.explorePool ? explorePoolWithin() : state.settings.filterOpponents && filters.filterActive) {
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

  if (state.explorePool) {
    // An Explore filter, worked out again each time (scenes join and leave it as ELO changes)
    allScenes = (await getAllScenesCached()).scenes || [];
    leftPool = explorePoolScenes(allScenes, state.explorePool.filters, resolveSceneTitle);
  } else if (filters.filterActive) {
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

/**
 * Ranks for a restored pair from the current pools (also recording the left pool's size), the way
 * the pair fetchers work them out: the place in the opponent pool, and in Placement, none for the
 * scene being placed and the opponent's place in the pool without it.
 */
export async function pairRanks(left: Scene, right: Scene): Promise<[Rank, Rank]> {
  const filters = currentFilters();
  const { leftPool, allScenes } = await loadScenePools(filters);
  let pool = buildOpponentPool(allScenes, leftPool, filters);
  const rank = (scene: Scene): Rank => {
    const idx = pool.findIndex((s) => s.id === scene.id);
    return idx >= 0 ? idx + 1 : null;
  };
  if (state.currentMode === "placement") {
    pool = pool.filter((s) => s.id !== left.id);
    return [null, rank(right)];
  }
  return [rank(left), rank(right)];
}

/**
 * The scenes "Battle the least-tested" picks from: the Scenes page filter's, or the whole library
 * (it turns off a battled Explore filter).
 */
export async function leastTestedSource(): Promise<{ scenes: Scene[]; filtered: boolean }> {
  const filters = readFilters();
  if (!filters.filterActive) return { scenes: (await getAllScenesCached()).scenes || [], filtered: false };
  return { scenes: (await getFilteredScenesCached(filters)).scenes || [], filtered: true };
}

/** The active filter: an Explore filter being battled, or else the Scenes page's (URL) filter. */
export function currentFilters(): ListFilters {
  const pool = state.explorePool;
  if (pool) return { filterKey: `explore:${JSON.stringify(pool.filters)}`, sceneFilter: null, filterActive: true };
  return readFilters();
}

/** Load left (scene to rate) and right (opponent) pools for Swiss. */
async function buildSwissPools(): Promise<{
  leftPool: Scene[];
  rightPool: Scene[];
  filterKey: string;
}> {
  const filters = currentFilters();
  const { leftPool, allScenes } = await loadScenePools(filters);

  if (allScenes.length < 2) {
    throw new Error("Not enough scenes for comparison.");
  }

  const rightPool = buildOpponentPool(allScenes, leftPool, filters);
  if (explorePoolWithin() && rightPool.length < 2) {
    throw new Error("Not enough scenes in this Explore filter for a match. You need at least 2 scenes.");
  }
  if (!state.explorePool && state.settings.filterOpponents && filters.filterActive && rightPool.length < 2) {
    throw new Error("Not enough scenes in your filter for a match. You need at least 2 scenes.");
  }

  return { leftPool, rightPool, filterKey: filters.filterKey };
}

// Swiss mode: left = scene to rate (filtered pool), right = similar-strength opponent
export async function fetchSwissPair(forcedLeftScene: Scene | null = null): Promise<SwissPairResult> {
  const { leftPool, rightPool, filterKey } = await buildSwissPools();

  // "Battle the least-tested" (Stats tab) takes the fewest-battled scene instead of the shuffle
  const scene1 =
    forcedLeftScene ||
    (state.leastTested ? leastTested(leftPool, state.currentPair.left?.id ?? null) : getNextFilteredScene(leftPool, filterKey));
  if (!scene1) {
    throw new Error("No scenes match your filter criteria.");
  }

  const { scene2, ranks } = pickSwissOpponent(scene1, rightPool);
  return { scenes: [scene1, scene2], ranks };
}

/**
 * Pick a random opponent within ±SWISS_OPPONENT_ELO_WINDOW of scene1's ELO in the ELO-sorted right
 * pool (unrated scenes count as 1500), or among the nearest few when the window has too few.
 */
function pickSwissOpponent(
  scene1: Scene,
  rightPool: Scene[],
): { scene2: Scene; ranks: [Rank, Rank] } {
  const scene1IdxInPool = rightPool.findIndex((s) => s.id === scene1.id);
  const scene1RankInPool = scene1IdxInPool >= 0 ? scene1IdxInPool + 1 : null;

  const candidates = swissOpponentIndexes(
    rightPool,
    effectiveElo(latestScene(scene1)),
    scene1.id,
    SWISS_OPPONENT_ELO_WINDOW,
    SWISS_OPPONENT_MIN_CANDIDATES,
  );
  if (candidates.length === 0) {
    throw new Error("Not enough scenes for comparison. You need at least 2 scenes.");
  }

  const idx = candidates[Math.floor(Math.random() * candidates.length)];
  return {
    scene2: rightPool[idx],
    ranks: [scene1RankInPool, idx + 1],
  };
}

/** Random pick from the N unbeaten opponents closest above the champion (list is ELO-sorted). */
function pickClosestChampionOpponent(remainingOpponents: Scene[]): Scene {
  const closest = remainingOpponents.slice(-CLIMB_OPPONENT_PICK_WINDOW);
  return closest[Math.floor(Math.random() * closest.length)];
}

/** Opponents above the champion in the ELO-sorted pool that it hasn't beaten in this run. */
function getRemainingChampionOpponents(champion: Scene, rightPool: Scene[], championIndex: number): Scene[] {
  const championElo = effectiveElo(champion, CHAMPION_UNRATED_ELO);
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
  const filters = currentFilters();

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
  const filters = currentFilters();
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
    // Only the placed scene's ELO changes; it's credited with the battles this run took
    const newElo = landingElo(pool, step.slot);
    const newBattles = battles(latestScene(run.scene)) + run.battles;
    console.log(
      `[Stash Battle] 📍 Placement: scene ${run.scene.id} placed at #${step.slot + 1} after ${run.battles} battles, ELO ${newElo}`,
    );
    await writeElo(run.scene, newElo, newBattles, run.results ?? []);
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
