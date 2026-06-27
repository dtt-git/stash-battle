// Renders an individual scene card (returns an HTML string).

import type { Rank, Scene } from "../types";
import { resolveSceneTitle } from "./sceneTitle";

export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds) return "N/A";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function createSceneCard(
  scene: Scene,
  side: "left" | "right",
  rank: Rank = null,
  statusBadge: number | string | null = null,
): string {
  const file = scene.files && scene.files[0] ? scene.files[0] : {};
  const duration = file.duration;
  const performers =
    scene.performers && scene.performers.length > 0
      ? scene.performers.map((p) => p.name).join(", ")
      : "No performers";
  const studio = scene.studio ? scene.studio.name : "No studio";
  const tags = scene.tags ? scene.tags.slice(0, 5).map((t) => t.name) : [];

  const title = resolveSceneTitle(scene);

  const screenshotPath = scene.paths ? scene.paths.screenshot : null;
  const previewPath = scene.paths ? scene.paths.preview : null;
  const stashRating = scene.rating100 ? `${scene.rating100}/100` : "Unrated";

  // Numeric rank badge (#N), omitted when null
  let rankDisplay = "";
  if (rank !== null && rank !== undefined) {
    rankDisplay = `<span class="sb-scene-rank">#${rank}</span>`;
  }

  // Status badge: win-streak count (formatted) or custom label (e.g. falling mode)
  let statusBadgeHtml = "";
  if (typeof statusBadge === "string") {
    statusBadgeHtml = `<div class="sb-streak-badge">${statusBadge}</div>`;
  } else if (statusBadge !== null && statusBadge > 0) {
    statusBadgeHtml = `<div class="sb-streak-badge">🔥 ${statusBadge} win${statusBadge > 1 ? "s" : ""}</div>`;
  }

  // Preserve URL search params when opening scene
  const currentParams = window.location.search;
  const sceneUrl = `/scenes/${scene.id}${currentParams}`;

  return `
      <div class="sb-scene-card" data-side="${side}">
        <div class="sb-scene-image-container" data-scene-url="${sceneUrl}">
          ${
            screenshotPath
              ? `<img class="sb-scene-image" src="${screenshotPath}" alt="${title}" loading="lazy" />`
              : `<div class="sb-scene-image sb-no-image">No Screenshot</div>`
          }
          ${previewPath ? `<video class="sb-hover-preview" src="${previewPath}" loop playsinline></video>` : ""}
          <div class="sb-scene-duration">${formatDuration(duration)}</div>
          ${statusBadgeHtml}
          <div class="sb-click-hint">Click to open scene</div>
        </div>

        <div class="sb-scene-body" data-winner="${scene.id}">
          <div class="sb-scene-info">
            <div class="sb-scene-title-row">
              <h3 class="sb-scene-title">${title}</h3>
              ${rankDisplay}
            </div>

            <div class="sb-scene-meta">
              <div class="sb-meta-item"><strong>Studio:</strong> ${studio}</div>
              <div class="sb-meta-item"><strong>Performers:</strong> ${performers}</div>
              <div class="sb-meta-item"><strong>Play Count:</strong> ${scene.play_count || 0}</div>
              <div class="sb-meta-item"><strong>Rating:</strong> ${stashRating}</div>
              <div class="sb-meta-item sb-tags-row"><strong>Tags:</strong> ${tags.length > 0 ? tags.map((tag) => `<span class="sb-tag">${tag}</span>`).join("") : '<span class="sb-none">None</span>'}</div>
            </div>
          </div>

          <div class="sb-choose-btn">
            ✓ Choose This Scene
          </div>
        </div>
      </div>
    `;
}
