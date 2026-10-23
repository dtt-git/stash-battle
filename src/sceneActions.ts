// Scene lookups for detecting scenes deleted while they were in a battle, and for bringing a
// saved pair's ELO and Stash rating up to date.

import { graphqlQuery } from "./graphql";
import type { Scene } from "./types";

export type SceneFields = Pick<Scene, "id" | "rating100" | "custom_fields">;

/**
 * The current Stash rating and custom fields of these scenes, by id; ids that no longer exist
 * are missing. (findScenes(ids) errors on any missing id, so it's aliased findScene lookups.)
 */
export async function fetchSceneFields(ids: string[]): Promise<Map<string, SceneFields>> {
  const aliases = ids
    .map((id, i) => `s${i}: findScene(id: ${JSON.stringify(id)}) { id rating100 custom_fields }`)
    .join("\n");
  const result = await graphqlQuery<Record<string, SceneFields | null>>(`{ ${aliases} }`);
  return new Map(Object.values(result).flatMap((s) => (s ? [[s.id, s] as const] : [])));
}

/** True for GraphQL errors Stash raises when a scene id no longer exists. */
export function isSceneNotFoundError(error: unknown): boolean {
  return error instanceof Error && /not found/i.test(error.message);
}
