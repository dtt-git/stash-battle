// Persist ratings and ELO to Stash and keep the local cache in sync.

import { clearSceneInCache, setEloInCache, updateSceneInCache } from "./cache";
import { ELO_FIELD, GAMES_FIELD } from "./constants";
import { graphqlQuery } from "./graphql";
import { isSceneNotFoundError } from "./sceneActions";

/** Window event fired when a rating write finds the scene was deleted elsewhere (detail = scene id). */
export const SCENE_MISSING_EVENT = "stash-battle:scene-missing";

const SCENE_UPDATE_MUTATION = `
      mutation SceneUpdate($input: SceneUpdateInput!) {
        sceneUpdate(input: $input) {
          id
          rating100
        }
      }
    `;

function reportWriteError(sceneId: string, what: string, e: unknown): void {
  console.error(`[Stash Battle] Failed to ${what} for scene ${sceneId}:`, e);
  if (isSceneNotFoundError(e)) {
    window.dispatchEvent(new CustomEvent(SCENE_MISSING_EVENT, { detail: sceneId }));
  }
}

/** Write a rating (null clears) to Stash and the cache. */
export async function updateSceneRating(sceneId: string, rating100: number | null): Promise<void> {
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
    reportWriteError(sceneId, stashRating === null ? "clear rating" : "update rating", e);
  }
}

/**
 * Save a scene's ELO and games count (custom fields only; `partial` leaves other plugins'
 * fields alone) to Stash and the cache.
 */
export async function writeElo(sceneId: string, elo: number, games: number): Promise<void> {
  try {
    await graphqlQuery(SCENE_UPDATE_MUTATION, {
      input: { id: sceneId, custom_fields: { partial: { [ELO_FIELD]: elo, [GAMES_FIELD]: games } } },
    });
    console.log(`[Stash Battle] 📝 Saved scene ${sceneId} ELO ${elo} (${games} games)`);
    setEloInCache(sceneId, { elo, games });
  } catch (e) {
    reportWriteError(sceneId, "save ELO", e);
  }
}

/** Remove a scene's ELO and games count, making it unrated again. */
export async function clearElo(sceneId: string): Promise<void> {
  try {
    await graphqlQuery(SCENE_UPDATE_MUTATION, {
      input: { id: sceneId, custom_fields: { remove: [ELO_FIELD, GAMES_FIELD] } },
    });
    console.log(`[Stash Battle] 📝 Cleared scene ${sceneId} ELO`);
    setEloInCache(sceneId, null);
  } catch (e) {
    reportWriteError(sceneId, "clear ELO", e);
  }
}

/**
 * Write Stash ratings (scene id to 1-100) in one GraphQL request: one aliased bulkSceneUpdate
 * per distinct value. Throws on failure; doesn't touch the cache.
 */
export async function writeStashRatings(ratings: Map<string, number>): Promise<void> {
  const idsByRating = new Map<number, string[]>();
  for (const [id, rating] of ratings) {
    const ids = idsByRating.get(rating) ?? [];
    ids.push(id);
    idsByRating.set(rating, ids);
  }
  if (idsByRating.size === 0) return;

  const values = [...idsByRating.keys()];
  const mutation = `
      mutation SyncStashRatings(${values.map((r) => `$r${r}: BulkSceneUpdateInput!`).join(", ")}) {
        ${values.map((r) => `r${r}: bulkSceneUpdate(input: $r${r}) { id }`).join("\n        ")}
      }
    `;
  const variables = Object.fromEntries(
    values.map((r) => [`r${r}`, { ids: idsByRating.get(r), rating100: r }]),
  );
  await graphqlQuery(mutation, variables);
  console.log(`[Stash Battle] 📝 Wrote ${ratings.size} Stash ratings (${values.length} distinct values)`);
}
