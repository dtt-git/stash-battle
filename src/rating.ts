// Persist ELO (and Stash ratings) to Stash and keep the local cache in sync.

import { setEloInCache, setRatingsInCache } from "./cache";
import { ELO_FIELD_KEYS } from "./constants";
import { graphqlQuery, refreshStashCache } from "./graphql";
import { isSceneNotFoundError } from "./sceneActions";
import { eloCustomFields, isSeeded, stashRatingChanges } from "./score";
import { state } from "./state";
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
 * Save a scene's ELO and battle count (custom fields only; `partial` leaves other plugins'
 * fields alone). Whether it was seeded stays as it was. The scene object and the cache are
 * updated straight away, so the next pair already sees the new ELO; the write to Stash follows.
 */
export async function writeElo(scene: Scene, elo: number, battles: number): Promise<void> {
  const value = { elo, battles, seeded: isSeeded(scene) };
  setEloInCache(scene, value);
  refreshStashCache([{ id: scene.id, elo: value }], false);
  scheduleStashRatingSync();
  try {
    await graphqlQuery(SCENE_UPDATE_MUTATION, {
      input: { id: scene.id, custom_fields: { partial: eloCustomFields(value) } },
    });
    console.log(`[Stash Battle] 📝 Saved scene ${scene.id} ELO ${elo} (${battles} battles)`);
  } catch (e) {
    reportWriteError(scene.id, "save ELO", e);
  }
}

/** Remove a scene's ELO fields, making it unrated again. */
export async function clearElo(scene: Scene): Promise<void> {
  setEloInCache(scene, null);
  refreshStashCache([{ id: scene.id, elo: null }], false);
  scheduleStashRatingSync();
  try {
    await graphqlQuery(SCENE_UPDATE_MUTATION, {
      input: { id: scene.id, custom_fields: { remove: ELO_FIELD_KEYS } },
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

/** After Stash ratings were written: update the cached scenes and Stash's own page cache. */
export function applyStashRatings(ratings: Map<string, number>): void {
  setRatingsInCache(ratings);
  refreshStashCache(
    [...ratings].map(([id, rating100]) => ({ id, rating100 })),
    ratings.size > 0,
  );
}

/** Wait this long after the last ELO write, so both scenes of a pick sync in one request. */
const SYNC_DEBOUNCE_MS = 500;
let syncTimer: ReturnType<typeof setTimeout> | null = null;

/** Sync Stash ratings soon (debounced), unless the "Stash ratings" setting is "off". */
export function scheduleStashRatingSync(): void {
  if (state.settings.stashRatings === "off") return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void syncStashRatings();
  }, SYNC_DEBOUNCE_MS);
}

/**
 * Bring Stash ratings in line with ELO for the whole library (the all-scenes cache): work out
 * every scene's target under the current setting, and write only the ones that differ from the
 * cached rating, in one request. Returns how many were written.
 */
export async function syncStashRatings(): Promise<number> {
  const mode = state.settings.stashRatings;
  const scenes = state.memoryCache.allScenes;
  if (mode === "off" || !scenes) return 0;
  const changes = stashRatingChanges(scenes, mode);
  if (changes.size === 0) return 0;
  try {
    await writeStashRatings(changes);
    applyStashRatings(changes);
    return changes.size;
  } catch (e) {
    console.error("[Stash Battle] Failed to sync Stash ratings:", e);
    return 0;
  }
}
