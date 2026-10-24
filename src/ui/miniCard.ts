// A small scene card (Explore tab, and the hover card on the Stats tab's hidden gems chart):
// thumbnail, title, tier and "ELO 1820 · #97", plays and battles. Returns an HTML string.
// The thumbnail, image and info carry the pre-2.0 pwr-* class names too, so SFW Switch blurs them
// as it does the battle cards.

import type { ExploreEntry } from "../explore";
import { battles, elo, isProvisional } from "../score";
import { state } from "../state";
import { sliderToVolume } from "./mainUI";
import { tierPill, PROVISIONAL_TIP } from "./sceneCard";
import { resolveSceneTitle } from "./sceneTitle";

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The scene's page, keeping the current Scenes filter in the URL (like the battle cards). */
export function sceneUrl(sceneId: string): string {
  return `/scenes/${sceneId}${window.location.search}`;
}

/**
 * `link`: the thumbnail and text are a link to the scene's page, and a ⚔️ button battles it.
 * Without it (the hover card) it's display only.
 */
export function miniCardHtml(entry: ExploreEntry, link = true): string {
  const { scene, rank, tier } = entry;
  const title = escapeHtml(resolveSceneTitle(scene) || `Scene ${scene.id}`);
  const value = elo(scene);
  const provisional = isProvisional(scene);
  const eloText =
    value === null ? "Unrated" : `ELO ${Math.round(value)}${provisional ? "?" : ""}${rank !== null ? ` · #${rank}` : ""}`;
  const screenshot = scene.paths?.screenshot;
  const thumb = screenshot
    ? `<img class="sb-mini-img pwr-scene-image" src="${screenshot}" alt="" loading="lazy" />`
    : `<div class="sb-mini-img sb-no-image">No Screenshot</div>`;
  const plays = scene.play_count ?? 0;
  const body = `
          <div class="sb-mini-thumb pwr-scene-image-container">${thumb}</div>
          <div class="sb-mini-body pwr-scene-info">
            <div class="sb-mini-title" title="${title}">${title}</div>
            <div class="sb-mini-elo">${tier ? tierPill(tier) : ""}<span class="sb-mini-rank"${provisional ? ` title="${PROVISIONAL_TIP}"` : ""}>${eloText}</span></div>
            <div class="sb-mini-meta">${plural(plays, "play")} · ${plural(battles(scene), "battle")}</div>
          </div>`;
  const tierAttrs = tier ? ` sb-tier-${tier.id}" data-tier="${tier.id}` : "";
  const preview = scene.paths?.preview ? ` data-preview="${scene.paths.preview}"` : "";
  if (!link) return `<div class="sb-mini-card sb-mini-static${tierAttrs}">${body}</div>`;
  const target = state.settings.openInNewTab ? ` target="_blank" rel="noopener"` : "";
  return `
        <div class="sb-mini-card${tierAttrs}" data-scene-id="${scene.id}"${preview}>
          <a class="sb-mini-link" href="${sceneUrl(scene.id)}"${target}>${body}</a>
          <button type="button" class="sb-mini-battle" data-battle="${scene.id}" title="Battle this scene">⚔️</button>
        </div>`;
}

// ---------- Preview (one small card at a time, anywhere) ----------

let previewCard: HTMLElement | null = null;

/**
 * Play a small card's preview over its thumbnail, heard at the preview volume like a hovered
 * battle card (0 mutes it). Only one plays at a time: starting another stops the last.
 */
export function startMiniPreview(card: HTMLElement): void {
  if (card === previewCard) return;
  stopMiniPreview();
  const src = card.dataset.preview;
  const thumb = card.querySelector(".sb-mini-thumb");
  if (!src || !thumb) return;
  previewCard = card;
  const video = document.createElement("video");
  video.className = "sb-mini-video pwr-hover-preview";
  video.src = src;
  video.volume = sliderToVolume(state.settings.previewVolume);
  video.muted = state.settings.previewVolume === 0;
  video.loop = true;
  video.playsInline = true;
  thumb.appendChild(video);
  video.play().catch(() => {});
}

export function stopMiniPreview(): void {
  previewCard?.querySelector(".sb-mini-video")?.remove();
  previewCard = null;
}

/** The small card whose preview is playing, if any. */
export function miniPreviewCard(): HTMLElement | null {
  return previewCard;
}
