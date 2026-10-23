// Persist ELO (and Stash ratings) to Stash and keep the local cache in sync.

import { setEloInCache } from "./cache";
import { ELO_FIELD, GAMES_FIELD } from "./constants";
import { graphqlQuery } from "./graphql";
import { isSceneNotFoundError } from "./sceneActions";
import type { Scene } from "./types";

/** Window event fired when a rating write finds the scene was deleted elsewhere (detail = scene id). */
export const SCENE_MISSING_EVENT = "stash-battle:scene-missing";

const SCENE_UPDATE_MUTATION = `
      mutation SceneUpdate($input: SceneUpdateInput!) {
        sceneUpdate(input: $input) {
          id
        }
      }
    `;

function reportWriteError(sceneId: string, what: string, e: unknown): void {
  console.error(`[Stash Battle] Failed to ${what} for scene ${sceneId}:`, e);
  if (isSceneNotFoundError(e)) {
    window.dispatchEvent(new CustomEvent(SCENE_MISSING_EVENT, { detail: sceneId }));
  }
}

/**
 * Save a scene's ELO and games count (custom fields only; `partial` leaves other plugins'
 * fields alone). The scene object and the cache are updated straight away, so the next pair
 * already sees the new ELO; the write to Stash follows.
 */
export async function writeElo(scene: Scene, elo: number, games: number): Promise<void> {
  setEloInCache(scene, { elo, games });
  try {
    await graphqlQuery(SCENE_UPDATE_MUTATION, {
      input: { id: scene.id, custom_fields: { partial: { [ELO_FIELD]: elo, [GAMES_FIELD]: games } } },
    });
    console.log(`[Stash Battle] 📝 Saved scene ${scene.id} ELO ${elo} (${games} games)`);
  } catch (e) {
    reportWriteError(scene.id, "save ELO", e);
  }
}

/** Remove a scene's ELO and games count, making it unrated again. */
export async function clearElo(scene: Scene): Promise<void> {
  setEloInCache(scene, null);
  try {
    await graphqlQuery(SCENE_UPDATE_MUTATION, {
      input: { id: scene.id, custom_fields: { remove: [ELO_FIELD, GAMES_FIELD] } },
    });
    console.log(`[Stash Battle] 📝 Cleared scene ${scene.id} ELO`);
  } catch (e) {
    reportWriteError(scene.id, "clear ELO", e);
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
