// One-time ELO setup: give every scene a starting ELO (from its Stash rating, or 1500 for all),
// then optionally sync Stash ratings from the new ELO. Re-running it overwrites, so an
// interrupted setup is safe to repeat.

import { ELO_FIELD_KEYS, ELO_START, RECORD_FIELD_KEYS } from "./constants";
import { bulkUpdateScenes, graphqlQuery, refreshStashCache, type BulkUpdateGroup } from "./graphql";
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

/**
 * Each rated scene's starting fields, from its own rating. Scenes with the same Stash rating get
 * the same fields, so it's one bulk update group per distinct rating.
 */
function seedGroups(rated: Scene[]): BulkUpdateGroup[] {
  const idsByRating = new Map<number, string[]>();
  for (const scene of rated) {
    const rating = scene.rating100 as number;
    const ids = idsByRating.get(rating) ?? [];
    ids.push(scene.id);
    idsByRating.set(rating, ids);
  }
  return [...idsByRating].map(([rating, ids]) => ({
    ids,
    // Records start over too (setup and Reset ELO)
    changes: {
      custom_fields: { partial: eloCustomFields({ elo: seed(rating), battles: 0, seeded: true }), remove: RECORD_FIELD_KEYS },
    },
  }));
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

  const groups: BulkUpdateGroup[] = [];
  if (start === "ratings") {
    const rated = scenes.filter((scene) => scene.rating100 != null);
    groups.push(...seedGroups(rated));
    summary.eloWritten = rated.length;

    // Only matters on a re-run: scenes with an ELO but no Stash rating become unrated again
    const stale = scenes.filter((scene) => scene.rating100 == null && isRated(scene)).map((scene) => scene.id);
    if (stale.length > 0) groups.push({ ids: stale, changes: { custom_fields: { remove: ELO_FIELD_KEYS } } });
    summary.eloCleared = stale.length;
  } else {
    groups.push({
      ids: scenes.map((scene) => scene.id),
      changes: {
        custom_fields: { partial: eloCustomFields({ elo: ELO_START, battles: 0, seeded: false }), remove: RECORD_FIELD_KEYS },
      },
    });
    summary.eloWritten = scenes.length;
  }
  const eloTotal = summary.eloWritten + summary.eloCleared;
  onProgress("elo", 0, eloTotal);
  await bulkUpdateScenes(groups, (done) => onProgress("elo", done, eloTotal));
  onProgress("elo", eloTotal, eloTotal);

  // Records start over with the ELO, the hall of fame too
  try {
    await clearHallOfFame();
  } catch (e) {
    console.warn("[Stash Battle] Couldn't clear the hall of fame:", e);
  }

  const changes = setupRatingChanges(scenes, start, stashRatings);
  if (changes.size > 0) {
    onProgress("ratings", 0, changes.size);
    await writeStashRatings(changes, (done) => onProgress("ratings", done, changes.size));
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
