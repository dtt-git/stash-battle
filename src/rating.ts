// Persist scene ratings to Stash and keep the local cache in sync.

import { clearSceneInCache, setSandboxRating, updateSceneInCache } from "./cache";
import { graphqlQuery } from "./graphql";
import { isSceneNotFoundError } from "./sceneActions";
import { state } from "./state";

/** Window event fired when a rating write finds the scene was deleted elsewhere (detail = scene id). */
export const SCENE_MISSING_EVENT = "stash-battle:scene-missing";

/**
 * False in fun mode. Only for UI (rating animations, "not saved" notes): the write path below
 * handles fun mode itself, so battle logic never needs to check this.
 */
export function ratingsEnabled(): boolean {
  return !state.settings.funMode;
}

const SCENE_UPDATE_MUTATION = `
      mutation SceneUpdate($input: SceneUpdateInput!) {
        sceneUpdate(input: $input) {
          id
          rating100
        }
      }
    `;

/**
 * Write a rating (null clears): to Stash and the cache, or in fun mode only to the in-memory
 * sandbox, so battles behave normally without saving anything.
 */
export async function updateSceneRating(sceneId: string, rating100: number | null): Promise<void> {
  const stashRating =
    rating100 === null ? null : Math.max(1, Math.min(100, rating100));

  if (!ratingsEnabled()) {
    console.log(`[Stash Battle] 🎈 Fun mode: scene ${sceneId} rating ${stashRating} kept in memory only`);
    setSandboxRating(sceneId, stashRating);
    return;
  }

  try {
    await graphqlQuery(SCENE_UPDATE_MUTATION, {
      input: {
        id: sceneId,
        rating100: stashRating,
      },
    });

    if (stashRating === null) {
      console.log(`[Stash Battle] 📝 Cleared scene ${sceneId} rating in Stash`);
      clearSceneInCache(sceneId);
    } else {
      console.log(`[Stash Battle] 📝 Updated scene ${sceneId} rating to ${stashRating} in Stash`);
      updateSceneInCache(sceneId, stashRating);
    }
  } catch (e) {
    const action = stashRating === null ? "clear" : "update";
    console.error(`[Stash Battle] Failed to ${action} scene ${sceneId} rating:`, e);
    if (isSceneNotFoundError(e)) {
      window.dispatchEvent(new CustomEvent(SCENE_MISSING_EVENT, { detail: sceneId }));
    }
  }
}
