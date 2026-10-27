// One-time ELO setup: give every scene a starting ELO (from its Stash rating, or 1500 for all),
// then optionally sync Stash ratings from the new ELO. Re-running it overwrites, so an
// interrupted setup is safe to repeat.

import { ELO_FIELD_KEYS, ELO_START, RECORD_FIELD_KEYS } from "./constants";
import { graphqlQuery, refreshStashCache } from "./graphql";
import { writeStashRatings } from "./rating";
import { clearHallOfFame } from "./settings";
import { afterSetup, eloCustomFields, isRated, seed, startingElo, stashRatingChanges } from "./score";
import { state } from "./state";
import type { EloStart, Scene, StashRatingsMode } from "./types";

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

/**
 * Seed each rated scene from its own rating. Scenes with the same Stash rating get the same
 * starting fields, so it's one aliased bulkSceneUpdate per distinct rating, all in one request.
 */
async function seedFromRatings(rated: Scene[]): Promise<void> {
  const idsByRating = new Map<number, string[]>();
  for (const scene of rated) {
    const rating = scene.rating100 as number;
    const ids = idsByRating.get(rating) ?? [];
    ids.push(scene.id);
    idsByRating.set(rating, ids);
  }
  if (idsByRating.size === 0) return;

  const values = [...idsByRating.keys()];
  const mutation = `
      mutation SeedElo(${values.map((r) => `$s${r}: BulkSceneUpdateInput!`).join(", ")}) {
        ${values.map((r) => `s${r}: bulkSceneUpdate(input: $s${r}) { id }`).join("\n        ")}
      }
    `;
  const variables = Object.fromEntries(
    values.map((r) => {
      const partial = eloCustomFields({ elo: seed(r), battles: 0, seeded: true });
      // Records start over too (setup and Reset ELO)
      return [`s${r}`, { ids: idsByRating.get(r), custom_fields: { partial, remove: RECORD_FIELD_KEYS } }];
    }),
  );
  await graphqlQuery(mutation, variables);
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
  // It rewrites the whole library, which test mode can't keep in this tab only
  if (state.settings.testMode) throw new Error("Test mode is on: turn it off in Settings to set up ELO.");
  const summary: SetupSummary = { eloWritten: 0, eloCleared: 0, ratingsWritten: 0 };

  if (start === "ratings") {
    const rated = scenes.filter((scene) => scene.rating100 != null);
    onProgress("elo", 0, rated.length);
    await seedFromRatings(rated);
    onProgress("elo", rated.length, rated.length);
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
        input: {
          ids,
          custom_fields: { partial: eloCustomFields({ elo: ELO_START, battles: 0, seeded: false }), remove: RECORD_FIELD_KEYS },
        },
      });
    }
    onProgress("elo", ids.length, ids.length);
    summary.eloWritten = ids.length;
  }

  // Records start over with the ELO, the hall of fame too
  try {
    await clearHallOfFame();
  } catch (e) {
    console.warn("[Stash Battle] Couldn't clear the hall of fame:", e);
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
