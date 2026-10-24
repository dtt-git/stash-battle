// Persist ELO (and Stash ratings) to Stash and keep the local cache in sync.

import { latestScene, setEloInCache, setRatingsInCache } from "./cache";
import { ELO_FIELD_KEYS } from "./constants";
import { graphqlQuery, refreshStashCache } from "./graphql";
import { isSceneNotFoundError } from "./sceneActions";
import { elo as eloOf, eloCustomFields, eloFields, isRated, isSeeded, recordAfter, sceneRecord, stashRatingChanges } from "./score";
import { addToHallOfFame, getHallOfFame } from "./settings";
import { state } from "./state";
import type { EloFields, Scene } from "./types";

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

/** True when both are unrated, or hold the same ELO fields (record included). */
function sameElo(a: EloFields | null, b: EloFields | null): boolean {
  if (a === null || b === null) return a === b;
  return JSON.stringify(eloCustomFields(a)) === JSON.stringify(eloCustomFields(b));
}

/**
 * Update the scene object, the cache and Stash's page cache straight away (so the next pair
 * already sees the change), then write to Stash. If the write fails, put the old value back,
 * unless a later write has replaced it since. Stash ratings sync only after a successful write.
 */
async function saveEloFields(scene: Scene, value: EloFields | null, customFields: Record<string, unknown>, what: string): Promise<boolean> {
  const previous = eloFields(latestScene(scene));
  setEloInCache(scene, value);
  refreshStashCache([{ id: scene.id, elo: value }], false);
  try {
    await graphqlQuery(SCENE_UPDATE_MUTATION, { input: { id: scene.id, custom_fields: customFields } });
  } catch (e) {
    reportWriteError(scene.id, what, e);
    if (sameElo(eloFields(latestScene(scene)), value)) {
      setEloInCache(scene, previous);
      refreshStashCache([{ id: scene.id, elo: previous }], false);
    }
    return false;
  }
  scheduleStashRatingSync();
  return true;
}

/**
 * Save a scene's ELO and battle count, and its record with `results` added (each pick in order,
 * true = won), in one write (custom fields only; `partial` leaves other plugins' fields alone).
 * Whether it was seeded stays as it was.
 */
export async function writeElo(scene: Scene, elo: number, battles: number, results: boolean[]): Promise<void> {
  const current = latestScene(scene);
  const record = recordAfter(sceneRecord(current), results, eloOf(current) ?? elo, elo);
  const value: EloFields = { elo, battles, seeded: isSeeded(scene), record };
  if (await saveEloFields(scene, value, { partial: eloCustomFields(value) }, "save ELO")) {
    console.log(`[Stash Battle] 📝 Saved scene ${scene.id} ELO ${elo} (${battles} battles)`);
    noteTopScene();
  }
}

/** The library's #1 (the all-scenes cache is ELO-sorted) joins the hall of fame if it's new there. */
export function noteTopScene(): void {
  const top = state.memoryCache.allScenes?.[0];
  if (top && isRated(top) && !getHallOfFame().some((e) => e.id === top.id)) void addToHallOfFame(top.id);
}

/** Remove a scene's ELO fields, making it unrated again. */
export async function clearElo(scene: Scene): Promise<void> {
  if (await saveEloFields(scene, null, { remove: ELO_FIELD_KEYS }, "clear ELO")) {
    console.log(`[Stash Battle] 📝 Cleared scene ${scene.id} ELO`);
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

/** The Stash rating write in progress (or the last one), so the next waits for it. */
let ratingWrites: Promise<unknown> = Promise.resolve();

/**
 * Run a Stash ratings write after any in progress, so each one starts from the ratings the
 * previous one wrote (overlapping writes could repeat work or finish out of order).
 */
export function queueRatingWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = ratingWrites.then(task);
  ratingWrites = run.catch(() => undefined);
  return run;
}

/**
 * Bring Stash ratings in line with ELO for the whole library (the all-scenes cache): work out
 * every scene's target under the current setting, and write only the ones that differ from the
 * cached rating, in one request. Queued behind any write in progress. Returns how many were written.
 */
export function syncStashRatings(): Promise<number> {
  return queueRatingWrite(async () => {
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
  });
}
