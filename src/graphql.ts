// GraphQL access against the Stash backend.

import { BATTLES_FIELD, ELO_FIELD, ELO_FIELD_KEYS, SEEDED_FIELD } from "./constants";
import type { ApolloCacheLike } from "./pluginApi";
import type { EloFields, FindSceneResult, Scene } from "./types";

export async function graphqlQuery<T = unknown>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch("/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const result = await response.json();
  if (result.errors) {
    console.error("[Stash Battle] GraphQL error:", result.errors);
    throw new Error(result.errors[0].message);
  }
  return result.data as T;
}

export const SCENE_FRAGMENT = `
    id
    title
    date
    rating100
    play_count
    custom_fields
    paths {
      screenshot
      preview
    }
    files {
      duration
      path
    }
    studio {
      name
    }
    performers {
      name
    }
    tags {
      name
    }
  `;

export const FIND_SCENES_QUERY = `
      query FindScenesByRating($filter: FindFilterType, $scene_filter: SceneFilterType) {
        findScenes(filter: $filter, scene_filter: $scene_filter) {
          count
          scenes {
            ${SCENE_FRAGMENT}
          }
        }
      }
    `;

let customFieldsSupport: Promise<boolean> | null = null;

/**
 * Whether this Stash has scene custom fields (needed for ELO storage). Checked once per page
 * load via introspection; if introspection itself fails, assume yes and let real queries report.
 */
export function sceneCustomFieldsSupported(): Promise<boolean> {
  customFieldsSupport ??= graphqlQuery<{ __type: { fields: { name: string }[] } | null }>(
    `query { __type(name: "Scene") { fields { name } } }`,
  )
    .then((data) => data.__type?.fields.some((f) => f.name === "custom_fields") ?? true)
    .catch((e) => {
      console.warn("[Stash Battle] Could not check for scene custom fields:", e);
      return true;
    });
  return customFieldsSupport;
}

/** A change Stash Battle wrote to a scene, to mirror into Stash's own page cache. */
export interface StashCacheUpdate {
  id: string;
  rating100?: number;
  /** New ELO fields, or null when they were removed. */
  elo?: EloFields | null;
}

/**
 * Stash Battle writes with plain fetch, so Stash's own pages (Apollo) never see the changes and
 * keep showing old ratings until refreshed. Mirror the changes into Apollo's cached scenes, and
 * when ratings changed, drop cached scene lists so rating-sorted lists re-sort. Does nothing if
 * Stash doesn't expose its client.
 */
export function refreshStashCache(updates: StashCacheUpdate[], ratingsChanged: boolean): void {
  let cache: ApolloCacheLike | undefined;
  try {
    cache = window.PluginApi?.utils?.StashService?.getClient?.()?.cache;
  } catch {
    cache = undefined;
  }
  if (!cache) return;
  try {
    for (const update of updates) {
      const id = cache.identify({ __typename: "Scene", id: update.id });
      if (!id) continue;
      const fields: Record<string, (existing: unknown) => unknown> = {};
      if (update.rating100 !== undefined) fields.rating100 = () => update.rating100;
      if (update.elo !== undefined) {
        const value = update.elo;
        fields.custom_fields = (existing) => {
          const next = { ...((existing as Record<string, unknown> | null) ?? {}) };
          for (const key of ELO_FIELD_KEYS) delete next[key];
          if (value) {
            next[ELO_FIELD] = value.elo;
            next[BATTLES_FIELD] = value.battles;
            next[SEEDED_FIELD] = value.seeded;
          }
          return next;
        };
      }
      // Apollo only calls modifiers for fields it has cached, so missing ones are skipped
      cache.modify({ id, fields });
    }
    if (ratingsChanged) {
      cache.evict({ id: "ROOT_QUERY", fieldName: "findScenes" });
      cache.gc();
    }
  } catch (e) {
    console.warn("[Stash Battle] Could not update Stash's page cache:", e);
  }
}

// Extract scene ID from individual scene pages like /scenes/123
export function getSceneIdFromUrl(): string | null {
  const match = window.location.pathname.match(/^\/scenes\/(\d+)$/);
  return match ? match[1] : null;
}

export async function fetchSceneById(sceneId: string): Promise<Scene | null> {
  const query = `
      query FindScene($id: ID!) {
        findScene(id: $id) {
          ${SCENE_FRAGMENT}
        }
      }
    `;
  const result = await graphqlQuery<FindSceneResult>(query, { id: sceneId });
  return result.findScene;
}
