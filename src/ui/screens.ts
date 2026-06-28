// Victory and placement end-screens for gauntlet/champion runs.

import { resetGauntletState, state } from "../state";
import { saveState } from "../storage";
import type { Scene } from "../types";
import { loadNewPair } from "./mainUI";
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
        <div class="sb-end-screen-scene">
          ${
            screenshotPath
              ? `<img class="sb-end-screen-image" src="${screenshotPath}" alt="${title}" />`
              : `<div class="sb-end-screen-image sb-no-image">No Screenshot</div>`
          }
        </div>
        <h3 class="sb-end-screen-name">${title}</h3>
        <p class="sb-end-screen-stats">${statsHtml}</p>
        <button id="sb-new-gauntlet" class="btn btn-primary">${buttonLabel}</button>
      </div>
    `;
}

/** Render an end screen, hide battle controls, and wire the new-run button. */
function showEndScreen(html: string): void {
  const comparisonArea = document.getElementById("sb-comparison-area");
  if (!comparisonArea) return;

  comparisonArea.innerHTML = html;

  const actionsEl = document.querySelector<HTMLElement>(".sb-actions");
  if (actionsEl) actionsEl.style.display = "none";

  comparisonArea.querySelector("#sb-new-gauntlet")?.addEventListener("click", () => {
    if (actionsEl) actionsEl.style.display = "";
    loadNewPair();
  });
}

/** Capture display values, clear run state, then show the end screen. */
function finishRunShowEndScreen(html: string): void {
  resetGauntletState();
  saveState();
  showEndScreen(html);
}

export function showVictoryScreen(champion: Scene): void {
  const totalScenes = state.totalScenesCount;
  const winStreak = state.gauntletWins;
  const ratingLine =
    champion.rating100 != null
      ? `<br>Rating: <strong>${champion.rating100}/100</strong>`
      : "";

  const html = buildEndScreenHtml(
    champion,
    "👑",
    "CHAMPION!",
    `Conquered all ${totalScenes} scenes with a ${winStreak} win streak!${ratingLine}`,
    "Start New Gauntlet",
  );

  finishRunShowEndScreen(html);
}

export function showPlacementScreen(scene: Scene, rank: number, finalRating: number): void {
  const html = buildEndScreenHtml(
    scene,
    "📍",
    "PLACED!",
    `Rank <strong>#${rank}</strong> of ${state.totalScenesCount}<br>Rating: <strong>${finalRating}/100</strong>`,
    "Start New Run",
  );

  finishRunShowEndScreen(html);
}
