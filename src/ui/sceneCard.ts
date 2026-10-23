// Renders an individual scene card (returns an HTML string).

import { state } from "../state";
import { isStashDeleteDialogAvailable } from "./deleteDialog";
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
  const { unratedRating, openInNewTab, cleanMode } = state.settings;
  const unratedLabel =
    state.currentMode === "swiss" && unratedRating > 1 ? `Unrated (counts as ${unratedRating})` : "Unrated";
  const stashRating = scene.rating100 ? `${scene.rating100}/100` : unratedLabel;

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
  const linkTarget = openInNewTab ? ` target="_blank" rel="noopener"` : "";

  // pwr-* classes are the plugin's pre-2.0 names; SFW Switch still targets them to blur Stash Battle.
  // Badges sit outside the (blurred) image container so they stay readable in SFW mode.
  return `
      <div class="sb-scene-card" data-side="${side}">
        <div class="sb-scene-media">
          <a class="sb-scene-image-container pwr-scene-image-container" href="${sceneUrl}"${linkTarget}>
            ${
              screenshotPath
                ? `<img class="sb-scene-image pwr-scene-image" src="${screenshotPath}" alt="${title}" loading="lazy" />`
                : `<div class="sb-scene-image sb-no-image">No Screenshot</div>`
            }
            ${previewPath ? `<video class="sb-hover-preview pwr-hover-preview" src="${previewPath}" loop muted playsinline></video>` : ""}
          </a>
          <div class="sb-scene-duration">${formatDuration(duration)}</div>
          ${statusBadgeHtml}
          <div class="sb-click-hint">${openInNewTab ? "Click to open in new tab" : "Click to open scene"}</div>
          <a class="sb-open-link" href="${sceneUrl}" target="_blank" rel="noopener" title="Open scene in new tab">↗</a>
          ${cleanMode && isStashDeleteDialogAvailable() ? `<button type="button" class="sb-delete-btn" title="Delete this scene from Stash">🗑</button>` : ""}
        </div>

        <div class="sb-scene-body" data-winner="${scene.id}">
          <div class="sb-scene-info pwr-scene-info">
            <div class="sb-scene-title-row">
              <h3 class="sb-scene-title">${title}</h3>
              ${rankDisplay}
            </div>

            <div class="sb-scene-meta">
              <div class="sb-meta-item sb-meta-studio"><strong>Studio:</strong> ${studio}</div>
              <div class="sb-meta-item sb-meta-performers"><strong>Performers:</strong> ${performers}</div>
              <div class="sb-meta-item sb-meta-plays"><strong>Play Count:</strong> ${scene.play_count || 0}</div>
              <div class="sb-meta-item sb-meta-rating"><strong>Rating:</strong> ${stashRating}</div>
              <div class="sb-meta-item sb-tags-row"><strong>Tags:</strong> ${tags.length > 0 ? tags.map((tag) => `<span class="sb-tag">${tag}</span>`).join("") : '<span class="sb-none">None</span>'}</div>
            </div>
          </div>

          <div class="sb-choose-btn">
            ✓ Choose<span class="sb-choose-long"> This Scene</span>
          </div>
        </div>
      </div>
    `;
}
