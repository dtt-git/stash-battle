// Renders an individual scene card (returns an HTML string).

import { CHAMPION_UNRATED_ELO, ELO_K_TIERS, ELO_START } from "../constants";
import { battles, elo, isProvisional, recordText } from "../score";
import { state } from "../state";
import { tierDescription } from "../stats";
import { isStashDeleteDialogAvailable } from "./deleteDialog";
import type { Rank, Scene, Tier } from "../types";
import { resolveSceneTitle } from "../sceneTitle";

/** Tooltip for a provisional ELO (the "?" after it). */
export const PROVISIONAL_TIP = `Provisional: fewer than ${ELO_K_TIERS[0][0]} battles, so this ELO is still settling`;

/** Small pill with the tier's emoji and name (the name hides on phones). */
export function tierPill(tier: Tier): string {
  return `<span class="sb-tier sb-tier-${tier.id}" title="${tierDescription(tier)}">${tier.emoji}<span class="sb-tier-name"> ${tier.name}</span></span>`;
}

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
  tier: Tier | null = null,
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
  const { openInNewTab, cleanMode } = state.settings;
  const stashRating = scene.rating100 ? `${scene.rating100}/100` : "None";

  // ELO badge: "ELO 1740 · #50" when rated (rank when known), with a "?" while it's provisional.
  // Unrated scenes show the ELO they count as in this mode in the same order, "ELO 1500 ·
  // Unrated" (Placement has none: "Unrated").
  const eloValue = elo(scene);
  const unratedAs =
    state.currentMode === "swiss" ? ELO_START : state.currentMode === "champion" ? CHAMPION_UNRATED_ELO : null;
  const provisional = isProvisional(scene);
  let eloLabel: string;
  if (eloValue !== null) {
    eloLabel = `ELO ${Math.round(eloValue)}${provisional ? "?" : ""}${rank !== null && rank !== undefined ? ` · #${rank}` : ""}`;
  } else {
    eloLabel = unratedAs !== null ? `ELO ${unratedAs} · Unrated` : "Unrated";
  }
  // "Tier colours on card borders": the border takes the tier's colour (the pill always shows)
  const border = tier !== null && state.settings.tierBorders;
  const rankTitle = provisional ? ` title="${PROVISIONAL_TIP}"` : "";
  // "Record: 12–5"; battles from before records began show as "Battles: N"
  const record = recordText(scene);
  const rankDisplay = `${tier ? tierPill(tier) : ""}<span class="sb-scene-rank"${rankTitle}>${eloLabel}</span>`;

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
      <div class="sb-scene-card${border ? ` sb-tier-${tier?.id}` : ""}" data-side="${side}"${border ? ` data-tier="${tier?.id}"` : ""}>
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
          <button type="button" class="sb-card-mute" aria-label="Play this preview with sound">🔇</button>
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
              <div class="sb-meta-item sb-meta-battles">${record !== null ? `<strong>Record:</strong> ${record}` : `<strong>Battles:</strong> ${battles(scene)}`}</div>
              <div class="sb-meta-item sb-meta-rating"><strong>Stash Rating:</strong> ${stashRating}<span class="sb-meta-record-inline"> · ${record !== null ? `<strong>Record:</strong> ${record}` : `${battles(scene)} battles`}</span></div>
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
