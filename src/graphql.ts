// GraphQL access against the Stash backend.

import type { FindSceneResult, Scene } from "./types";

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
