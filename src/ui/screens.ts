// Victory and placement end-screens for Champion and Placement runs.

import { elo } from "../score";
import { resetRunState, state } from "../state";
import { saveState } from "../storage";
import type { PlacementPairResult, Scene } from "../types";
import { loadNewPair, setActionsVisible } from "./mainUI";
import { resolveSceneTitle } from "./sceneTitle";

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
        <button id="sb-new-run" class="btn btn-primary">${buttonLabel}</button>
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
}

/** Capture display values, clear run state, then show the end screen. */
function finishRunShowEndScreen(html: string): void {
  resetRunState();
  saveState();
  showEndScreen(html);
}

function eloLine(value: number | null): string {
  return value === null ? "" : `<br>ELO: <strong>${Math.round(value)}</strong>`;
}

/** Champion beat every scene above it, or a climb from the bottom never lost: it's #1. */
export function showVictoryScreen(champion: Scene, winStreak: number): void {
  const html = buildEndScreenHtml(
    champion,
    "👑",
    "CHAMPION!",
    `Reached the top: ${winStreak} win${winStreak === 1 ? "" : "s"} in a row!${eloLine(elo(champion))}`,
    "Start New Run",
  );

  finishRunShowEndScreen(html);
}

export function showPlacementScreen(result: Extract<PlacementPairResult, { done: true }>): void {
  const { scene, rank, battles, streak, fromBottom } = result;
  const streakText = fromBottom && streak > 0 ? `🔥 ${streak} win streak · ` : "";
  const battlesText = battles ? ` · ${battles} battle${battles === 1 ? "" : "s"}` : "";
  const html = buildEndScreenHtml(
    scene,
    "📍",
    "PLACED!",
    `${streakText}Rank <strong>#${rank}</strong> of ${state.totalScenesCount}${battlesText}${eloLine(result.elo)}`,
    "Start New Run",
  );

  finishRunShowEndScreen(html);
}
