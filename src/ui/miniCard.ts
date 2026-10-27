// A small scene card (Explore tab, and the hover card on the Stats tab's hidden gems chart):
// thumbnail, title, tier and "ELO 1820 · #97", plays and battles. Returns an HTML string.
// The thumbnail, image and info carry the pre-2.0 pwr-* class names too, so SFW Switch blurs them
// as it does the battle cards.

import type { ExploreEntry } from "../explore";
import { scenesListQuery } from "../filters";
import { battles, elo, isProvisional, recordText } from "../score";
import { state } from "../state";
import { isTouchDevice, sliderToVolume } from "./mainUI";
import { tierPill, PROVISIONAL_TIP } from "./sceneCard";
import { resolveSceneTitle } from "../sceneTitle";

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The scene's page, keeping the current Scenes filter in the URL (like the battle cards). */
export function sceneUrl(sceneId: string): string {
  return `/scenes/${sceneId}${scenesListQuery()}`;
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
            <div class="sb-mini-meta">${plural(plays, "play")} · ${recordText(scene) ?? plural(battles(scene), "battle")}</div>
          </div>`;
  const tierAttrs = tier ? ` sb-tier-${tier.id}" data-tier="${tier.id}` : "";
  const preview = scene.paths?.preview ? ` data-preview="${scene.paths.preview}"` : "";
  if (!link) return `<div class="sb-mini-card sb-mini-static${tierAttrs}">${body}</div>`;
  const target = state.settings.openInNewTab ? ` target="_blank" rel="noopener"` : "";
  return `
        <div class="sb-mini-card${tierAttrs}" data-scene-id="${scene.id}"${preview}>
          <a class="sb-mini-link" href="${sceneUrl(scene.id)}"${target}>${body}</a>${
            scene.paths?.preview
              ? `<div class="sb-mini-overlay"><button type="button" class="sb-card-mute sb-mini-mute" aria-label="Play this preview with sound">🔇</button></div>`
              : ""
          }
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
  updateMiniMuteIcons();
}

export function stopMiniPreview(): void {
  previewCard?.querySelector(".sb-mini-video")?.remove();
  previewCard = null;
  updateMiniMuteIcons();
}

/** Each small card's mute button (touch) shows whether its preview is heard right now. */
function updateMiniMuteIcons(): void {
  document.querySelectorAll<HTMLElement>(".sb-mini-mute").forEach((button) => {
    const card = button.closest(".sb-mini-card");
    const video = card && card === previewCard ? card.querySelector<HTMLVideoElement>(".sb-mini-video") : null;
    const heard = video !== null && !video.muted;
    button.textContent = heard ? "🔊" : "🔇";
    button.setAttribute("aria-label", heard ? "Mute this preview" : "Play this preview with sound");
  });
}

/**
 * Touch: a small card's mute button. Heard → muted (the preview keeps playing). Not heard → its
 * preview plays with sound (starting it, and turning the preview volume back on if it was at 0).
 * Returns true when it handled the tap.
 */
export function handleMiniMuteTap(e: Event): boolean {
  const button = (e.target as Element).closest(".sb-mini-mute");
  if (!button) return false;
  e.preventDefault();
  const card = button.closest<HTMLElement>(".sb-mini-card[data-preview]");
  if (!card) return true;
  const video = card === previewCard ? card.querySelector<HTMLVideoElement>(".sb-mini-video") : null;
  if (video && !video.muted) {
    video.muted = true;
  } else {
    // The tab bar's speaker restores the volume from before muting
    if (state.settings.previewVolume === 0) document.querySelector<HTMLButtonElement>(".sb-volume-icon")?.click();
    if (video) {
      video.volume = sliderToVolume(state.settings.previewVolume);
      video.muted = false;
    } else {
      startMiniPreview(card);
    }
  }
  updateMiniMuteIcons();
  return true;
}

/**
 * Touch screens, like the battle cards: a tap on a small card's thumbnail plays its preview (with
 * sound) or stops it, instead of following the card's link; the info below opens the scene.
 * Returns true when it handled the tap.
 */
export function handleMiniThumbTap(e: Event): boolean {
  if (!isTouchDevice()) return false;
  const thumb = (e.target as Element).closest(".sb-mini-thumb");
  const card = thumb?.closest<HTMLElement>(".sb-mini-card[data-preview]");
  if (!card) return false;
  e.preventDefault();
  if (previewCard === card) stopMiniPreview();
  else startMiniPreview(card);
  return true;
}

/** The small card whose preview is playing, if any. */
export function miniPreviewCard(): HTMLElement | null {
  return previewCard;
}
