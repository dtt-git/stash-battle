// The 🏆 Records tab: the hall of fame (every scene that has been #1, newest first), and the
// longest win streaks and highest peak ELOs, as small cards. Built from Stash Battle's
// all-scenes cache each time the tab opens. Cards open the scene's page, their ⚔️ battles it, and
// hovering (on touch, tapping the thumbnail) plays the preview, as on Explore.

import { getAllScenesCached } from "../cache";
import { exploreEntries, type ExploreEntry } from "../explore";
import { noteTopScene } from "../rating";
import { resolveSceneTitle } from "../sceneTitle";
import { getHallOfFame } from "../settings";
import { isEloSetupPending } from "../state";
import { cachedTierMap, topByRecord } from "../stats";
import type { Scene } from "../types";
import { handleSceneLinkClick, isTouchDevice } from "./mainUI";
import { handleMiniMuteTap, handleMiniThumbTap, miniCardHtml, miniPreviewCard, plural, startMiniPreview, stopMiniPreview } from "./miniCard";

/** Scenes listed in the streak and peak rows. */
const RECORDS_TOP = 5;
/** Hall of fame cards shown before "Show all (N)" (the stored list itself isn't capped). */
const HALL_OF_FAME_SHOWN = 10;

let entriesById = new Map<string, ExploreEntry>();
let battleScene: (sceneId: string) => void = () => {};

export function createRecordsTab(): string {
  return `
      <div class="sb-tab-panel sb-records-tab" data-panel="records" hidden>
        <div id="sb-records-content"></div>
      </div>
    `;
}

function shortDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** The full date and time, for the caption's tooltip. */
function fullDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * A row of small cards, each with a caption above it ("#1 since Oct 24, 2026"). With `shown`, the
 * cards past it start hidden behind a "Show all (N)" link.
 */
function recordRow(title: string, items: { scene: Scene; caption: string; tip?: string }[], empty: string, shown = Infinity): string {
  const cards = items
    .filter(({ scene }) => entriesById.has(scene.id))
    .map(({ scene, caption, tip }, i) => {
      const extra = i >= shown ? " sb-record-extra" : "";
      return `<div class="sb-record-item${extra}"${extra ? " hidden" : ""}><div class="sb-record-caption"${tip ? ` title="${tip}"` : ""}>${caption}</div>${miniCardHtml(entriesById.get(scene.id) as ExploreEntry)}</div>`;
    });
  const more = cards.length > shown ? ` <a href="#" class="sb-record-more" data-records-more>Show all (${cards.length})</a>` : "";
  return `
        <div class="setting-section sb-stats-section">
          <h1>${title}${more}</h1>
          <div class="card">
            ${cards.length ? `<div class="sb-record-cards">${cards.join("")}</div>` : `<p class="sb-stats-muted">${empty}</p>`}
          </div>
        </div>`;
}

/** Hall of fame (newest #1 first), and the top scenes by best win streak and by peak ELO. */
function recordsHtml(scenes: Scene[]): string {
  const byId = new Map(scenes.map((s) => [s.id, s]));
  // Newest first, by the time each reached #1 (several can on the same day)
  const hall = [...getHallOfFame()]
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
    .map((e) => ({ scene: byId.get(e.id), date: e.date }))
    .filter((e): e is { scene: Scene; date: string } => e.scene !== undefined)
    .map(({ scene, date }) => ({ scene, caption: `👑 #1 since ${shortDate(date)}`, tip: `First reached #1 on ${fullDate(date)}` }));
  const streaks = topByRecord(scenes, (r) => r.bestStreak, RECORDS_TOP).map(({ scene, record }) => ({
    scene,
    caption: `🔥 ${plural(record.bestStreak, "win")} in a row`,
  }));
  const peaks = topByRecord(scenes, (r) => r.peak, RECORDS_TOP).map(({ scene, record }) => ({
    scene,
    caption: `📈 Peak ELO ${Math.round(record.peak)}`,
  }));
  return `
        <div class="sb-records">
          ${recordRow("👑 Hall of fame", hall, "No scene has been #1 yet.", HALL_OF_FAME_SHOWN)}
          ${recordRow("🔥 Longest win streaks", streaks, "No win streaks yet: records start counting with your next battle.")}
          ${recordRow("📈 Highest peak ELO", peaks, "No peaks yet: records start counting with your next battle.")}
          <p class="sb-stats-note">Records count battles since they began; earlier battles only add to a scene's battle count.</p>
        </div>`;
}

/** Cards: ⚔️ battles the scene, the rest opens its page; "Show all" reveals the hidden cards. */
function onClick(e: MouseEvent): void {
  const target = e.target as Element;
  const more = target.closest<HTMLElement>("[data-records-more]");
  if (more) {
    e.preventDefault();
    more.closest(".sb-stats-section")?.querySelectorAll<HTMLElement>(".sb-record-extra").forEach((card) => (card.hidden = false));
    more.remove();
    return;
  }
  if (handleMiniMuteTap(e) || handleMiniThumbTap(e)) return;
  const battle = target.closest<HTMLElement>("[data-battle]");
  if (battle?.dataset.battle) {
    stopMiniPreview();
    battleScene(battle.dataset.battle);
    return;
  }
  const link = target.closest<HTMLAnchorElement>(".sb-mini-link");
  if (link) {
    stopMiniPreview();
    handleSceneLinkClick(e, link);
  }
}

/** The content element outlives each render, so its handlers are bound once. */
function bindEvents(content: HTMLElement): void {
  if (content.dataset.bound === "1") return;
  content.dataset.bound = "1";
  content.addEventListener("click", onClick);
  // Previews play on hover, as on Explore (touch screens have no hover)
  content.addEventListener("mouseover", (e) => {
    if (isTouchDevice()) return;
    const card = (e.target as Element).closest<HTMLElement>(".sb-mini-card[data-preview]");
    if (card) startMiniPreview(card);
  });
  content.addEventListener("mouseout", (e) => {
    const playing = miniPreviewCard();
    if (playing && content.contains(playing) && !playing.contains(e.relatedTarget as Node | null)) stopMiniPreview();
  });
}

/** Fill the Records tab from the all-scenes cache (call each time the tab opens). */
export async function renderRecordsTab(modal: HTMLElement, onBattleScene: (sceneId: string) => void): Promise<void> {
  battleScene = onBattleScene;
  const content = modal.querySelector<HTMLElement>("#sb-records-content");
  if (!content) return;
  if (isEloSetupPending()) {
    content.innerHTML = `<p class="sb-stats-empty">Records show once the ELO setup on the Battle tab is done.</p>`;
    return;
  }
  if (!content.querySelector(".sb-records")) content.innerHTML = `<div class="sb-loading">Loading records...</div>`;
  let scenes: Scene[];
  try {
    scenes = (await getAllScenesCached()).scenes ?? [];
  } catch (e) {
    console.error("[Stash Battle] Couldn't load scenes for records:", e);
    content.innerHTML = `<p class="sb-stats-empty">Couldn't load your scenes. Switch tabs to try again.</p>`;
    return;
  }
  // The current #1 joins the hall of fame if it isn't there yet (as after a battle)
  noteTopScene();
  entriesById = new Map(exploreEntries(scenes, cachedTierMap(scenes), resolveSceneTitle).map((entry) => [entry.scene.id, entry]));
  content.innerHTML = recordsHtml(scenes);
  bindEvents(content);
}
