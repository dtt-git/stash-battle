// Persist scene ratings to Stash and keep the local cache in sync.

import { clearSceneInCache, updateSceneInCache } from "./cache";
import { graphqlQuery } from "./graphql";
import { isSceneNotFoundError } from "./sceneActions";
import { state } from "./state";

/** Window event fired when a rating write finds the scene was deleted elsewhere (detail = scene id). */
export const SCENE_MISSING_EVENT = "stash-battle:scene-missing";

/** False in fun mode: battles must not change any rating, in Stash or in local scene objects. */
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

/** Write rating to Stash (null clears) and sync the in-memory cache. */
export async function updateSceneRating(sceneId: string, rating100: number | null): Promise<void> {
  if (!ratingsEnabled()) {
    console.log(`[Stash Battle] 🎈 Fun mode: not saving rating for scene ${sceneId}`);
    return;
  }
  const stashRating =
    rating100 === null ? null : Math.max(1, Math.min(100, rating100));

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
