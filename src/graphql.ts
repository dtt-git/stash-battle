// GraphQL access against the Stash backend.

import type { ApolloCacheLike } from "./pluginApi";
import { withEloFields } from "./score";
import { stashRoute, stashUrl } from "./stashUrl";
import type { EloFields, FindSceneResult, Scene } from "./types";

export async function graphqlQuery<T = unknown>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch(stashUrl("graphql"), {
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

/** Scene ids per bulk update request, so long writes report progress and no one request runs for ages. */
export const BULK_CHUNK_SIZE = 200;

/** One bulkSceneUpdate: these scenes get the same changes (rating100, custom_fields, ...). */
export interface BulkUpdateGroup {
  ids: string[];
  changes: Record<string, unknown>;
}

/**
 * Write the groups in requests of at most `chunkSize` scenes (one aliased bulkSceneUpdate per
 * group or piece of one), calling `onProgress` with the scenes written so far after each.
 * Stash runs other plugins' Scene.Update.Post hooks for every scene before it answers, so with
 * such a plugin enabled each request can take a while.
 */
export async function bulkUpdateScenes(
  groups: BulkUpdateGroup[],
  onProgress?: (done: number, total: number) => void,
  chunkSize = BULK_CHUNK_SIZE,
): Promise<void> {
  const total = groups.reduce((n, group) => n + group.ids.length, 0);
  let done = 0;
  let request: BulkUpdateGroup[] = [];
  let size = 0;
  const send = async (): Promise<void> => {
    if (request.length === 0) return;
    const mutation = `
      mutation BulkSceneUpdates(${request.map((_, i) => `$u${i}: BulkSceneUpdateInput!`).join(", ")}) {
        ${request.map((_, i) => `u${i}: bulkSceneUpdate(input: $u${i}) { id }`).join("\n        ")}
      }
    `;
    const variables = Object.fromEntries(request.map((group, i) => [`u${i}`, { ...group.changes, ids: group.ids }]));
    await graphqlQuery(mutation, variables);
    done += size;
    request = [];
    size = 0;
    onProgress?.(done, total);
  };
  for (const group of groups) {
    for (let start = 0; start < group.ids.length; ) {
      const ids = group.ids.slice(start, start + chunkSize - size);
      request.push({ ids, changes: group.changes });
      size += ids.length;
      start += ids.length;
      if (size >= chunkSize) await send();
    }
  }
  await send();
}

/** Scene.Update.Post: the hook Stash runs for every scene Stash Battle writes. */
const SCENE_UPDATE_HOOK = "Scene.Update.Post";

/**
 * Names of enabled plugins with a scene update hook. Stash runs it once per scene, one after
 * another, so a library-wide write (ELO setup) can take hours with one enabled. [] if unknown.
 */
export async function sceneUpdateHookPlugins(): Promise<string[]> {
  try {
    const data = await graphqlQuery<{
      plugins: { name: string; enabled: boolean; hooks: { hooks: string[] | null }[] | null }[] | null;
    }>(`query { plugins { name enabled hooks { hooks } } }`);
    return (data.plugins ?? [])
      .filter((p) => p.enabled && p.hooks?.some((h) => h.hooks?.includes(SCENE_UPDATE_HOOK)))
      .map((p) => p.name);
  } catch (e) {
    console.warn("[Stash Battle] Could not check other plugins' hooks:", e);
    return [];
  }
}

export const SCENE_FRAGMENT = `
    id
    title
    date
    rating100
    play_count
    o_counter
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
  rating100?: number | null;
  /** New ELO fields, or null when they were removed. */
  elo?: EloFields | null;
}

function stashApolloCache(): ApolloCacheLike | undefined {
  try {
    return window.PluginApi?.utils?.StashService?.getClient?.()?.cache;
  } catch {
    return undefined;
  }
}

/** While Stash Battle is open, Stash's cached scene lists are dropped once on close, not every battle. */
let holdListRefresh = false;
let listsStale = false;

/** Drop Stash's cached scene lists (they refetch), so rating-sorted lists re-sort. */
function dropStashLists(cache: ApolloCacheLike | undefined = stashApolloCache()): void {
  listsStale = false;
  if (!cache) return;
  try {
    cache.evict({ id: "ROOT_QUERY", fieldName: "findScenes" });
    cache.gc();
  } catch (e) {
    console.warn("[Stash Battle] Could not refresh Stash's scene lists:", e);
  }
}

/**
 * Hold back dropping Stash's scene lists while Stash Battle is open (true); releasing it (false)
 * drops them once if ratings changed meanwhile. The pages behind the modal can wait, and a drop
 * per battle would refetch every list each pick.
 */
export function holdStashListRefresh(hold: boolean): void {
  holdListRefresh = hold;
  if (!hold && listsStale) dropStashLists();
}

/**
 * Stash Battle writes with plain fetch, so Stash's own pages (Apollo) never see the changes and
 * keep showing old ratings until refreshed. Mirror the changes into Apollo's cached scenes, and
 * when ratings changed, drop cached scene lists so rating-sorted lists re-sort (held back while
 * Stash Battle is open, see holdStashListRefresh). Does nothing if Stash doesn't expose its client.
 */
export function refreshStashCache(updates: StashCacheUpdate[], ratingsChanged: boolean): void {
  const cache = stashApolloCache();
  if (!cache) return;
  try {
    for (const update of updates) {
      const id = cache.identify({ __typename: "Scene", id: update.id });
      if (!id) continue;
      const fields: Record<string, (existing: unknown) => unknown> = {};
      if (update.rating100 !== undefined) fields.rating100 = () => update.rating100;
      if (update.elo !== undefined) {
        const value = update.elo;
        fields.custom_fields = (existing) => withEloFields(existing as Record<string, unknown> | null, value);
      }
      // Apollo only calls modifiers for fields it has cached, so missing ones are skipped
      cache.modify({ id, fields });
    }
  } catch (e) {
    console.warn("[Stash Battle] Could not update Stash's page cache:", e);
  }
  if (ratingsChanged) {
    listsStale = true;
    if (!holdListRefresh) dropStashLists(cache);
  }
}

// Extract scene ID from individual scene pages like /scenes/123
export function getSceneIdFromUrl(): string | null {
  const match = stashRoute().match(/^\/scenes\/(\d+)$/);
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
