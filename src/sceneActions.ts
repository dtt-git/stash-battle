// Scene lookups for detecting scenes deleted while they were in a battle.

import { graphqlQuery } from "./graphql";

/** Which of these scene ids still exist in Stash. (findScenes(ids) errors on any missing id.) */
export async function findExistingSceneIds(ids: string[]): Promise<Set<string>> {
  const aliases = ids.map((id, i) => `s${i}: findScene(id: ${JSON.stringify(id)}) { id }`).join("\n");
  const result = await graphqlQuery<Record<string, { id: string } | null>>(`{ ${aliases} }`);
  return new Set(Object.values(result).flatMap((s) => (s ? [s.id] : [])));
}

/** True for GraphQL errors Stash raises when a scene id no longer exists. */
export function isSceneNotFoundError(error: unknown): boolean {
  return error instanceof Error && /not found/i.test(error.message);
}
