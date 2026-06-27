import type { Scene } from "../types";

/** Scene title from metadata, or the filename (without extension) from the file path. */
export function resolveSceneTitle(scene: Scene): string {
  if (scene.title) return scene.title;

  const path = scene.files?.[0]?.path;
  if (path) {
    const pathParts = path.split(/[/\\]/);
    return pathParts[pathParts.length - 1].replace(/\.[^/.]+$/, "");
  }

  return "";
}
