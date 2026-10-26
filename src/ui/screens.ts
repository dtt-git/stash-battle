// Victory and placement end-screens for Champion and Placement runs.

import { latestScene } from "../cache";
import { formatRating } from "../ratingDisplay";
import { elo, stashRatingTargets } from "../score";
import { resetRunState, state } from "../state";
import { saveState } from "../storage";
import type { PlacementPairResult, Scene } from "../types";
import { canUndo, loadNewPair, setActionsVisible, undoLastPick } from "./mainUI";
import { resolveSceneTitle } from "../sceneTitle";

function buildEndScreenHtml(
  scene: Scene,
  crown: string,
  headline: string,
  statsHtml: string,
  buttonLabel: string,
): string {
  const title = resolveSceneTitle(scene);
  const screenshotPath = scene.paths?.screenshot ?? null;

  return `
      <div class="sb-end-screen">
        <div class="sb-end-screen-icon">${crown}</div>
        <h2 class="sb-end-screen-headline">${headline}</h2>
        <div class="sb-end-screen-scene pwr-scene-image-container">
          ${
            screenshotPath
              ? `<img class="sb-end-screen-image pwr-scene-image" src="${screenshotPath}" alt="${title}" />`
              : `<div class="sb-end-screen-image sb-no-image">No Screenshot</div>`
          }
        </div>
        <h3 class="sb-end-screen-name">${title}</h3>
        <p class="sb-end-screen-stats">${statsHtml}</p>
        <div class="sb-end-actions">
          <button id="sb-new-run" class="btn btn-primary">${buttonLabel}</button>
        </div>
      </div>
    `;
}

/** Render an end screen, hide battle controls, and wire the new-run button. */
function showEndScreen(html: string): void {
  const comparisonArea = document.getElementById("sb-comparison-area");
  if (!comparisonArea) return;

  comparisonArea.innerHTML = html;
  setActionsVisible(false);

  comparisonArea.querySelector("#sb-new-run")?.addEventListener("click", () => {
    loadNewPair();
  });
  // The pick that ended the run can be taken back from here too (the Undo bar is hidden)
  const newRun = comparisonArea.querySelector("#sb-new-run");
  if (newRun && canUndo()) {
    newRun.insertAdjacentHTML("afterend", `<button id="sb-end-undo" class="btn btn-secondary" title="Undo your last pick (Backspace)">↶ Undo</button>`);
    comparisonArea.querySelector("#sb-end-undo")?.addEventListener("click", () => void undoLastPick());
  }
}

/** Capture display values, clear run state, then show the end screen. */
function finishRunShowEndScreen(html: string): void {
  resetRunState();
  // The last pair belongs to the finished run: a reload mustn't restore it without its run
  state.currentPair = { left: null, right: null };
  state.currentRanks = { left: null, right: null };
  saveState();
  showEndScreen(html);
}

/**
 * "ELO: 1740" ("ELO: 1520 → 1740" given where it started), plus "· Stash Rating: 74" while an
 * update mode is on. The rating is worked out the way the sync does it (it may still be on its
 * way to Stash), so it's what Stash will show.
 */
function eloLine(scene: Scene, value: number | null, from: number | null = null): string {
  if (value === null) return "";
  const start = from === null ? "" : `${Math.round(from)} → `;
  let line = `<br>ELO: ${start}<strong>${Math.round(value)}</strong>`;
  const mode = state.settings.stashRatings;
  const scenes = state.memoryCache.allScenes;
  if (mode !== "off" && scenes) {
    const rating = stashRatingTargets(scenes, mode).get(scene.id);
    if (rating !== undefined) line += ` · Stash Rating: <strong>${formatRating(rating)}</strong>`;
  }
  return line;
}

/**
 * Champion beat every scene above it, or a climb from the bottom never lost: it's #1. A climb
 * passes where the scene started (its rank, or null when it was unrated, and its ELO).
 */
export function showVictoryScreen(
  champion: Scene,
  winStreak: number,
  start?: { rank: number | null; elo: number | null },
): void {
  const from = start ? ` from ${start.rank === null ? "unrated" : `#${start.rank}`}` : "";
  const html = buildEndScreenHtml(
    champion,
    "👑",
    "CHAMPION!",
    `Reached the top${from}: ${winStreak} win${winStreak === 1 ? "" : "s"} in a row!${eloLine(champion, elo(latestScene(champion)), start?.elo ?? null)}`,
    "Start New Run",
  );

  finishRunShowEndScreen(html);
}

export function showPlacementScreen(result: Extract<PlacementPairResult, { done: true }>): void {
  const { scene, rank, battles, streak, fromBottom, startRank } = result;
  const streakText = fromBottom && streak > 0 ? `🔥 ${streak} win streak · ` : "";
  const battlesText = battles ? ` · ${battles} battle${battles === 1 ? "" : "s"}` : "";
  // "#120 → #45 of 600": where it was before the run, then where it landed
  const from = startRank === null ? "Unrated" : `#${startRank}`;
  const html = buildEndScreenHtml(
    scene,
    "📍",
    "PLACED!",
    `${streakText}${from} → <strong>#${rank}</strong> of ${state.totalScenesCount}${battlesText}${eloLine(scene, result.elo, result.startElo)}`,
    "Start New Run",
  );

  finishRunShowEndScreen(html);
}
