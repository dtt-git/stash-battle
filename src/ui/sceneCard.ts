// Renders an individual scene card (returns an HTML string).

import { CHAMPION_UNRATED_ELO, ELO_K_TIERS, ELO_START } from "../constants";
import { scenesListQuery } from "../filters";
import { formatRating } from "../ratingDisplay";
import { showsCardDetail } from "../settings";
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
  // Phones have room for one detail beside the rating: the first the scene has (studio, then
  // performers, then tags) of those Card details shows, or none
  const compactDetail =
    (showsCardDetail("studio") && scene.studio?.name) ||
    (showsCardDetail("performers") && scene.performers?.length ? performers : "") ||
    (showsCardDetail("tags") ? tags.join(", ") : "");

  const title = resolveSceneTitle(scene);

  const screenshotPath = scene.paths ? scene.paths.screenshot : null;
  const previewPath = scene.paths ? scene.paths.preview : null;
  const { openInNewTab, cleanMode } = state.settings;
  const stashRating = scene.rating100 ? formatRating(scene.rating100) : "None";

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

  // The lines Settings → Card details picked. Where the record, play count and O count lines are
  // hidden (tablets, phones, short screens) they join the rating line, which then shows even with
  // the rating off.
  const showRecord = showsCardDetail("record");
  const inline = [
    showRecord ? (record !== null ? `<strong>Record:</strong> ${record}` : `${battles(scene)} battle${battles(scene) === 1 ? "" : "s"}`) : "",
    showsCardDetail("plays") ? `<span title="Play Count">▶︎ ${scene.play_count || 0}</span>` : "",
    showsCardDetail("oCount") ? `<span title="O Count">💦 ${scene.o_counter || 0}</span>` : "",
  ].filter(Boolean);
  let ratingLine = "";
  if (showsCardDetail("rating")) {
    ratingLine = `<div class="sb-meta-item sb-meta-rating"><strong>Stash Rating:</strong> ${stashRating}${inline.map((part) => `<span class="sb-meta-inline"> · ${part}</span>`).join("")}</div>`;
  } else if (inline.length) {
    const parts = inline.map((part, i) => `<span class="sb-meta-inline">${i ? " · " : ""}${part}</span>`).join("");
    ratingLine = `<div class="sb-meta-item sb-meta-rating sb-meta-inline-only">${parts}</div>`;
  }
  const metaHtml = [
    showsCardDetail("plays") ? `<div class="sb-meta-item sb-meta-plays"><strong>Play Count:</strong> ${scene.play_count || 0}</div>` : "",
    showsCardDetail("oCount") ? `<div class="sb-meta-item sb-meta-ocount"><strong>O Count:</strong> ${scene.o_counter || 0}</div>` : "",
    showRecord ? `<div class="sb-meta-item sb-meta-battles">${record !== null ? `<strong>Record:</strong> ${record}` : `<strong>Battles:</strong> ${battles(scene)}`}</div>` : "",
    ratingLine,
    compactDetail ? `<div class="sb-meta-item sb-meta-compact">${compactDetail}</div>` : "",
    showsCardDetail("studio") ? `<div class="sb-meta-item sb-meta-studio"><strong>Studio:</strong> ${studio}</div>` : "",
    showsCardDetail("performers") ? `<div class="sb-meta-item sb-meta-performers"><strong>Performers:</strong> ${performers}</div>` : "",
    showsCardDetail("tags")
      ? `<div class="sb-meta-item sb-tags-row"><strong>Tags:</strong> ${tags.length > 0 ? tags.map((tag) => `<span class="sb-tag">${tag}</span>`).join("") : '<span class="sb-none">None</span>'}</div>`
      : "",
  ]
    .filter(Boolean)
    .join("\n              ");

  // Status badge: win-streak count (formatted) or custom label (e.g. falling mode)
  let statusBadgeHtml = "";
  if (typeof statusBadge === "string") {
    statusBadgeHtml = `<div class="sb-streak-badge">${statusBadge}</div>`;
  } else if (statusBadge !== null && statusBadge > 0) {
    statusBadgeHtml = `<div class="sb-streak-badge">🔥 ${statusBadge} win${statusBadge > 1 ? "s" : ""}</div>`;
  }

  // Keep the Scenes page's filter in the URL when opening the scene
  const currentParams = scenesListQuery();
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
              ${metaHtml}
            </div>
          </div>

          <div class="sb-choose-btn">
            ✓ Choose<span class="sb-choose-long"> This Scene</span>
          </div>
        </div>
      </div>
    `;
}
