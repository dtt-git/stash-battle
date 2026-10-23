// One-time ELO setup: give every scene a starting ELO (from its Stash rating, or 1500 for all),
// then optionally sync Stash ratings from the new ELO. Re-running it overwrites, so an
// interrupted setup is safe to repeat.

import { ELO_FIELD_KEYS, ELO_START, SETUP_BATCH_SIZE } from "./constants";
import { graphqlQuery, refreshStashCache } from "./graphql";
import { writeStashRatings } from "./rating";
import { afterSetup, eloCustomFields, isRated, startingElo, stashRatingChanges } from "./score";
import type { EloFields, EloStart, Scene, StashRatingsMode } from "./types";

export type SetupPhase = "elo" | "ratings";

/** Progress callback: `done` of `total` scenes finished in this phase. */
export type SetupProgress = (phase: SetupPhase, done: number, total: number) => void;

export interface SetupSummary {
  eloWritten: number; // Scenes given a starting ELO
  eloCleared: number; // Scenes whose old ELO was removed (re-run with "Use my ratings")
  ratingsWritten: number; // Stash ratings changed
}

const SETUP_SCENES_QUERY = `
      query FindScenesForEloSetup {
        findScenes(filter: { per_page: -1 }) {
          scenes {
            id
            rating100
            custom_fields
          }
        }
      }
    `;

/** Every scene's id, Stash rating and custom fields, fresh from Stash (not the 5-minute cache). */
export async function fetchSetupScenes(): Promise<Scene[]> {
  const data = await graphqlQuery<{ findScenes: { scenes: Scene[] } }>(SETUP_SCENES_QUERY);
  return data.findScenes.scenes ?? [];
}

/** The Stash ratings the setup would change: scene id to new rating (none for "off"). */
export function setupRatingChanges(scenes: Scene[], start: EloStart, stashRatings: StashRatingsMode): Map<string, number> {
  return stashRatingChanges(
    scenes.map((scene) => afterSetup(scene, start)),
    stashRatings,
  );
}

const BULK_UPDATE_MUTATION = `
      mutation BulkSceneUpdate($input: BulkSceneUpdateInput!) {
        bulkSceneUpdate(input: $input) {
          id
        }
      }
    `;

/** Seed each rated scene from its own rating: aliased sceneUpdates, SETUP_BATCH_SIZE per request. */
async function seedFromRatings(rated: Scene[], onProgress: SetupProgress): Promise<void> {
  for (let start = 0; start < rated.length; start += SETUP_BATCH_SIZE) {
    const batch = rated.slice(start, start + SETUP_BATCH_SIZE);
    const mutation = `
      mutation SeedElo(${batch.map((_, i) => `$s${i}: SceneUpdateInput!`).join(", ")}) {
        ${batch.map((_, i) => `s${i}: sceneUpdate(input: $s${i}) { id }`).join("\n        ")}
      }
    `;
    const variables = Object.fromEntries(
      batch.map((scene, i) => {
        const partial = eloCustomFields(startingElo(scene, "ratings") as EloFields);
        return [`s${i}`, { id: scene.id, custom_fields: { partial } }];
      }),
    );
    await graphqlQuery(mutation, variables);
    onProgress("elo", start + batch.length, rated.length);
  }
}

/**
 * Run the setup on `scenes` (from fetchSetupScenes): write the starting ELO, then, unless
 * stashRatings is "off", the Stash ratings that change. Throws if a request fails; whatever
 * was written by then stays, and running it again overwrites it.
 */
export async function runEloSetup(
  scenes: Scene[],
  start: EloStart,
  stashRatings: StashRatingsMode,
  onProgress: SetupProgress,
): Promise<SetupSummary> {
  const summary: SetupSummary = { eloWritten: 0, eloCleared: 0, ratingsWritten: 0 };

  if (start === "ratings") {
    const rated = scenes.filter((scene) => scene.rating100 != null);
    onProgress("elo", 0, rated.length);
    await seedFromRatings(rated, onProgress);
    summary.eloWritten = rated.length;

    // Only matters on a re-run: scenes with an ELO but no Stash rating become unrated again
    const stale = scenes.filter((scene) => scene.rating100 == null && isRated(scene)).map((scene) => scene.id);
    if (stale.length > 0) {
      await graphqlQuery(BULK_UPDATE_MUTATION, {
        input: { ids: stale, custom_fields: { remove: ELO_FIELD_KEYS } },
      });
      summary.eloCleared = stale.length;
    }
  } else {
    const ids = scenes.map((scene) => scene.id);
    onProgress("elo", 0, ids.length);
    if (ids.length > 0) {
      await graphqlQuery(BULK_UPDATE_MUTATION, {
        input: { ids, custom_fields: { partial: eloCustomFields({ elo: ELO_START, battles: 0, seeded: false }) } },
      });
    }
    onProgress("elo", ids.length, ids.length);
    summary.eloWritten = ids.length;
  }

  const changes = setupRatingChanges(scenes, start, stashRatings);
  if (changes.size > 0) {
    onProgress("ratings", 0, changes.size);
    await writeStashRatings(changes);
    onProgress("ratings", changes.size, changes.size);
    summary.ratingsWritten = changes.size;
  }

  // Stash's own pages: every scene's ELO (or its removal) and any changed rating
  refreshStashCache(
    scenes.map((scene) => ({ id: scene.id, elo: startingElo(scene, start), rating100: changes.get(scene.id) })),
    changes.size > 0,
  );

  console.log(
    `[Stash Battle] ✅ ELO setup (${start}, Stash ratings ${stashRatings}): ${summary.eloWritten} ELO written, ${summary.eloCleared} cleared, ${summary.ratingsWritten} Stash ratings written`,
  );
  return summary;
}
