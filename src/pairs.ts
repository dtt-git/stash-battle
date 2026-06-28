// Matchmaking: build the scene pairs for each comparison mode.

import { clearFilteredCache, getAllScenesCached, getFilteredScenesCached } from "./cache";
import { CLIMB_OPPONENT_PICK_WINDOW, SWISS_OPPONENT_REACH_INITIAL, SWISS_OPPONENT_REACH_MULTIPLIER } from "./constants";
import { readFilters, type ListFilters } from "./filters";
import { updateSceneRating } from "./rating";
import { state } from "./state";
import type {
  ChampionPairResult,
  GauntletPairResult,
  Rank,
  Scene,
  SwissPairResult,
} from "./types";

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

/** Next left-side scene from the shuffled left pool (no network fetch). */
function getNextFilteredScene(leftPool: Scene[], filterKey: string): Scene | null {
  if (state.shuffleFilterKey !== null && filterKey !== state.shuffleFilterKey) {
    console.log("[Stash Battle] 🔀 Filter changed, resetting removed scenes tracking");
    state.removedSceneIds.clear();
  }

  const availableScenes = leftPool.filter((s) => !state.removedSceneIds.has(s.id));

  if (availableScenes.length === 0) {
    console.log("[Stash Battle] 🏁 Filtered pool exhausted - all scenes rated!");
    return null;
  }

  if (filterKey !== state.shuffleFilterKey || state.shuffledFilteredScenes.length === 0) {
    console.log("[Stash Battle] 🔀 Shuffling filtered scenes (filter changed or first load)");
    state.shuffledFilteredScenes = shuffleArray(availableScenes);
    state.shuffleIndex = 0;
    state.shuffleFilterKey = filterKey;
    lastShownSceneId = null;
  }

  if (state.shuffleIndex >= state.shuffledFilteredScenes.length) {
    console.log("[Stash Battle] 🔀 Reshuffling (completed full cycle)");
    state.shuffledFilteredScenes = shuffleArray(availableScenes);
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

  const scene = state.shuffledFilteredScenes[state.shuffleIndex];
  state.shuffleIndex++;
  lastShownSceneId = scene.id;
  console.log(
    `[Stash Battle] 📍 Picked scene ${scene.id} (${state.shuffledFilteredScenes.length - state.shuffleIndex} remaining in pool, ${state.removedSceneIds.size} removed this session)`,
  );
  return scene;
}

function buildOpponentPool(allScenes: Scene[], leftPool: Scene[], filters: ListFilters): Scene[] {
  if (state.filterOpponents && filters.filterActive) {
    return leftPool;
  }
  const ratedOnly = allScenes.filter((s) => s.rating100 != null);
  return ratedOnly.length >= 1 ? ratedOnly : allScenes;
}

async function resetLeftPool(): Promise<void> {
  await clearFilteredCache();
  state.shuffledFilteredScenes = [];
  state.shuffleIndex = 0;
  state.shuffleFilterKey = null;
  state.removedSceneIds.clear();
}

async function loadScenePools(
  filters: ListFilters,
): Promise<{ leftPool: Scene[]; allScenes: Scene[] }> {
  if (filters.filterActive) {
    console.log("[Stash Battle] 📋 Filter active, fetching filtered + all scenes");
    const [filteredResult, allResult] = await Promise.all([
      getFilteredScenesCached(filters),
      getAllScenesCached(),
    ]);
    return {
      leftPool: filteredResult.scenes || [],
      allScenes: allResult.scenes || [],
    };
  }

  console.log("[Stash Battle] 📋 No filter active, using all scenes");
  const allResult = await getAllScenesCached();
  const allScenes = allResult.scenes || [];
  return { leftPool: allScenes, allScenes };
}

function pickLeftScene(
  forcedLeftScene: Scene | null,
  leftPool: Scene[],
  filterKey: string,
): Scene | null {
  return forcedLeftScene || getNextFilteredScene(leftPool, filterKey);
}

function hasLeftAvailable(leftPool: Scene[], forcedLeftScene: Scene | null): boolean {
  return (
    forcedLeftScene !== null ||
    leftPool.some((s) => !state.removedSceneIds.has(s.id))
  );
}

/** Load left/right pools; refresh once if the left pool or filter-opponents right pool is depleted. */
async function buildSwissPools(forcedLeftScene: Scene | null): Promise<{
  leftPool: Scene[];
  rightPool: Scene[];
  filterKey: string;
}> {
  let filters = readFilters();
  let { leftPool, allScenes } = await loadScenePools(filters);

  if (allScenes.length < 2) {
    throw new Error("Not enough scenes for comparison.");
  }

  let rightPool = buildOpponentPool(allScenes, leftPool, filters);

  const needsLeftRefresh = !hasLeftAvailable(leftPool, forcedLeftScene);
  const needsOpponentRestart =
    state.filterOpponents && filters.filterActive && rightPool.length < 2;

  if (!needsLeftRefresh && !needsOpponentRestart) {
    return { leftPool, rightPool, filterKey: filters.filterKey };
  }

  if (needsLeftRefresh) {
    console.log("[Stash Battle] 🏁 Pool exhausted, fetching fresh from network...");
  } else {
    console.log("[Stash Battle] 🔄 Filtered opponent pool too small, restarting cycle...");
  }

  await resetLeftPool();
  leftPool = filters.filterActive
    ? (await getFilteredScenesCached(filters)).scenes || []
    : allScenes;
  filters = readFilters();
  rightPool = buildOpponentPool(allScenes, leftPool, filters);

  if (needsOpponentRestart && rightPool.length < 2) {
    throw new Error("Not enough scenes in your filter for a match. You need at least 2 scenes.");
  }

  return {
    leftPool,
    rightPool,
    filterKey: filters.filterKey,
  };
}

// Swiss mode: left = scene to rate (filtered pool), right = similar-strength opponent
export async function fetchSwissPair(forcedLeftScene: Scene | null = null): Promise<SwissPairResult> {
  const { leftPool, rightPool, filterKey } = await buildSwissPools(forcedLeftScene);

  const scene1 = pickLeftScene(forcedLeftScene, leftPool, filterKey);
  if (!scene1) {
    throw new Error("No scenes match your filter criteria.");
  }

  const { scene2, ranks } = pickSwissOpponent(scene1, rightPool);
  return { scenes: [scene1, scene2], ranks };
}

/** Pick a random opponent near scene1's rank in the rating-sorted right pool (expanding band if needed). */
function pickSwissOpponent(
  scene1: Scene,
  rightPool: Scene[],
): { scene2: Scene; ranks: [Rank, Rank] } {
  const scene1IdxInPool = rightPool.findIndex((s) => s.id === scene1.id);
  const effectiveScene1Idx = scene1IdxInPool >= 0 ? scene1IdxInPool : rightPool.length;
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

/** Random pick from the N undefeated opponents closest above the climber (list is rating-sorted DESC). */
function pickClosestClimbOpponent(remainingOpponents: Scene[]): Scene {
  const closest = remainingOpponents.slice(-CLIMB_OPPONENT_PICK_WINDOW);
  return closest[Math.floor(Math.random() * closest.length)];
}

/** Undefeated opponents above the climber in the rating-sorted right pool. */
function getRemainingClimbOpponents(
  climber: Scene,
  rightPool: Scene[],
  climberIndex: number,
): Scene[] {
  return rightPool.filter((s, idx) => {
    if (s.id === climber.id || state.gauntletDefeated.includes(s.id)) return false;
    return idx < climberIndex || (s.rating100 || 0) >= (climber.rating100 || 0);
  });
}

async function getClimbOpponentPool(): Promise<Scene[]> {
  const filters = readFilters();
  const { leftPool, allScenes } = await loadScenePools(filters);
  return buildOpponentPool(allScenes, leftPool, filters);
}

/** Apply ELO from a climber win; bump above the beaten opponent when the pool is cleared. */
export async function applyClimbWinRating(
  climber: Scene,
  beatenOpponent: Scene,
  eloRating: number,
): Promise<number> {
  climber.rating100 = eloRating;

  const rightPool = await getClimbOpponentPool();
  const climberIndex = rightPool.findIndex((s) => s.id === climber.id);
  // If the climber has remaining opponents return ELO rating as normal
  if (getRemainingClimbOpponents(climber, rightPool, climberIndex).length > 0) {
    return eloRating;
  }

  // If the climber has no remaining opponents, ensure their rating is above the opponent they just beat
  const minWinnerRating = Math.min(100, (beatenOpponent.rating100 ?? 0) + 1);
  if (eloRating < minWinnerRating) {
    await updateSceneRating(climber.id, minWinnerRating);
    climber.rating100 = minWinnerRating;
  }
  return climber.rating100 ?? eloRating;
}

// Find the lowest actually rated scene in a descending-sorted array, excluding a specific scene
// Returns { scene, index } or fallback to first non-excluded scene if none rated
function findLowestRated(scenes: Scene[], excludeId: string): { scene: Scene; index: number } {
  for (let i = scenes.length - 1; i >= 0; i--) {
    const s = scenes[i];
    if (s.id !== excludeId && s.rating100 != null) {
      return { scene: s, index: i };
    }
  }
  // Fallback to any scene if none rated
  const fallbackIndex = scenes.findIndex((s) => s.id !== excludeId);
  return { scene: scenes[fallbackIndex], index: fallbackIndex };
}

// Gauntlet mode: champion vs next challenger
export async function fetchGauntletPair(
  forcedLeftScene: Scene | null = null,
): Promise<GauntletPairResult> {
  const filters = readFilters();

  console.log("[Stash Battle] 📋 Fetching scenes for gauntlet...");
  const { leftPool, allScenes } = await loadScenePools(filters);

  let rightPool = buildOpponentPool(allScenes, leftPool, filters);
  state.totalScenesCount = rightPool.length;

  if (allScenes.length < 2) {
    throw new Error("Not enough scenes for comparison.");
  }

  // Handle falling mode - find next opponent BELOW to test against (from full collection)
  if (state.gauntletFalling && state.gauntletFallingScene) {
    const fallingScene = state.gauntletFallingScene;
    const fallingIndex = rightPool.findIndex((s) => s.id === fallingScene.id);

    const belowOpponents = rightPool.filter((s, idx) => {
      if (s.id === fallingScene.id || state.gauntletDefeated.includes(s.id)) return false;
      return idx > fallingIndex; // Below in ranking
    });

    if (belowOpponents.length === 0) {
      // Hit the bottom - place 1 below the last opponent that beat them
      const finalRank = rightPool.length;
      const lastDefeatedById = state.gauntletDefeated[state.gauntletDefeated.length - 1];
      const lastOpponent = rightPool.find((s) => s.id === lastDefeatedById);
      const finalRating = Math.max(1, (lastOpponent?.rating100 || 1) - 1);
      updateSceneRating(fallingScene.id, finalRating);

      return {
        scenes: [fallingScene],
        ranks: [finalRank],
        isVictory: false,
        isFalling: true,
        isPlacement: true,
        placementRank: finalRank,
        placementRating: finalRating,
      };
    } else {
      // Get next opponent below (first one, closest to falling scene)
      const nextBelow = belowOpponents[0];
      const nextBelowIndex = rightPool.findIndex((s) => s.id === nextBelow.id);

      // Update the falling scene's rank for display
      state.gauntletClimberRank = fallingIndex + 1;

      return {
        scenes: [fallingScene, nextBelow],
        ranks: [fallingIndex + 1, nextBelowIndex + 1],
        isVictory: false,
        isFalling: true,
      };
    }
  }

  // If no climber yet, pick from filtered pool to start
  if (!state.gauntletClimber) {
    state.gauntletDefeated = [];
    state.gauntletFalling = false;
    state.gauntletFallingScene = null;

    const challenger = forcedLeftScene || getNextFilteredScene(leftPool, filters.filterKey);

    if (!challenger) {
      throw new Error("No scenes match your filter criteria.");
    }

    const challengerIndex = rightPool.findIndex((s) => s.id === challenger.id);

    // Start at the bottom - find lowest rated scene in rightPool
    const { scene: lowestRated, index: lowestIndex } = findLowestRated(rightPool, challenger.id);

    state.gauntletClimberRank = challengerIndex >= 0 ? challengerIndex + 1 : rightPool.length;

    return {
      scenes: [challenger, lowestRated],
      ranks: [state.gauntletClimberRank, lowestIndex + 1],
      isVictory: false,
      isFalling: false,
    };
  }

  const climber = state.gauntletClimber;
  const climberIndex = rightPool.findIndex((s) => s.id === climber.id);

  state.gauntletClimberRank = climberIndex >= 0 ? climberIndex + 1 : 1;

  const remainingOpponents = getRemainingClimbOpponents(climber, rightPool, climberIndex);

  // If no opponents left, the climber has conquered the ladder
  if (remainingOpponents.length === 0) {
    state.gauntletClimberRank = 1;
    return {
      scenes: [climber],
      ranks: [1],
      isVictory: true,
      isFalling: false,
    };
  }

  const nextOpponent = pickClosestClimbOpponent(remainingOpponents);
  const nextOpponentIndex = rightPool.findIndex((s) => s.id === nextOpponent.id);

  return {
    scenes: [climber, nextOpponent],
    ranks: [climberIndex + 1, nextOpponentIndex + 1],
    isVictory: false,
    isFalling: false,
  };
}

// Champion mode: like gauntlet but winner stays on (no falling)
export async function fetchChampionPair(
  forcedLeftScene: Scene | null = null,
): Promise<ChampionPairResult> {
  const filters = readFilters();

  console.log("[Stash Battle] 📋 Fetching scenes for champion...");
  const { leftPool, allScenes } = await loadScenePools(filters);

  let rightPool = buildOpponentPool(allScenes, leftPool, filters);
  state.totalScenesCount = rightPool.length;

  if (allScenes.length < 2) {
    throw new Error("Not enough scenes for comparison.");
  }

  // If no climber yet, pick from filtered pool to start
  if (!state.gauntletClimber) {
    state.gauntletDefeated = [];

    if (!forcedLeftScene && leftPool.length < 1) {
      throw new Error("No scenes match your filter criteria.");
    }

    const challenger = forcedLeftScene || getNextFilteredScene(leftPool, filters.filterKey);

    if (!challenger) {
      throw new Error("No scenes match your filter criteria.");
    }

    const challengerIndex = rightPool.findIndex((s) => s.id === challenger.id);

    // Start at the bottom - find lowest actually rated scene
    const { scene: lowestRated, index: lowestIndex } = findLowestRated(rightPool, challenger.id);

    state.gauntletClimberRank = challengerIndex >= 0 ? challengerIndex + 1 : rightPool.length;

    return {
      scenes: [challenger, lowestRated],
      ranks: [state.gauntletClimberRank, lowestIndex + 1],
      isVictory: false,
    };
  }

  const climber = state.gauntletClimber;
  const climberIndex = rightPool.findIndex((s) => s.id === climber.id);

  state.gauntletClimberRank = climberIndex >= 0 ? climberIndex + 1 : 1;

  const remainingOpponents = getRemainingClimbOpponents(climber, rightPool, climberIndex);
  
  // If no opponents left, the climber has conquered the ladder
  if (remainingOpponents.length === 0) {
    state.gauntletClimberRank = 1;
    return {
      scenes: [climber],
      ranks: [1],
      isVictory: true,
    };
  }

  const nextOpponent = pickClosestClimbOpponent(remainingOpponents);
  const nextOpponentIndex = rightPool.findIndex((s) => s.id === nextOpponent.id);

  return {
    scenes: [climber, nextOpponent],
    ranks: [climberIndex + 1, nextOpponentIndex + 1],
    isVictory: false,
  };
}
