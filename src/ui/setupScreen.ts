// One-time ELO setup screen, shown in the Battle tab in place of the battle until it's done.
// Two questions side by side (how ELO starts, whether Stash Battle writes Stash ratings) above
// a shared preview, then a progress view while eloSetup.ts writes, then a summary. Reset ELO
// (Settings) shows the same screen in reset mode, with a Cancel button.

import { clearSceneCache } from "../cache";
import { fetchSetupScenes, runEloSetup, setupRatingChanges, type SetupPhase, type SetupSummary } from "../eloSetup";
import { isRated } from "../score";
import { hadFunMode, updateSettingsNow } from "../settings";
import { resetRunState, resetShuffle, state } from "../state";
import { saveState } from "../storage";
import type { EloStart, Scene, StashRatingsMode } from "../types";
import { showRatingPreview } from "./ratingPreview";
import { STASH_RATINGS_OPTIONS } from "./stashRatingsText";

/** On the Battle panel while setup shows; CSS hides the battle UI (modes, cards, actions). */
const SETUP_ACTIVE_CLASS = "sb-setup-active";

/** True from Start until the writes finish or fail; reopening Battle meanwhile keeps the progress. */
let running = false;

export interface SetupScreenOptions {
  /** Reset ELO: everything already has an ELO; the current Stash ratings option is preselected. */
  reset?: boolean;
  /** Reset mode's Cancel button (before anything is written). */
  onCancel?: () => void;
}

let options: SetupScreenOptions = {};

interface Choice {
  start: EloStart;
  stashRatings: StashRatingsMode;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

function setupArea(root: ParentNode): HTMLElement | null {
  return root.querySelector<HTMLElement>("#sb-setup-area");
}

/** True while setup is writing (Start pressed, not finished or failed yet). */
export function isSetupRunning(): boolean {
  return running;
}

/** Show the setup in the Battle tab. `onDone` runs once setup has finished and been saved. */
export function showSetupScreen(root: ParentNode, onDone: () => void, screenOptions: SetupScreenOptions = {}): void {
  const area = setupArea(root);
  if (!area) return;
  area.closest(".sb-tab-panel")?.classList.add(SETUP_ACTIVE_CLASS);
  area.hidden = false;
  if (running) return;
  options = screenOptions;
  void loadChoices(area, onDone);
}

/** Put the battle UI back (setup finished, possibly elsewhere). */
export function hideSetupScreen(root: ParentNode): void {
  const area = setupArea(root);
  if (!area || running) return;
  area.closest(".sb-tab-panel")?.classList.remove(SETUP_ACTIVE_CLASS);
  area.hidden = true;
  area.innerHTML = "";
}

async function loadChoices(area: HTMLElement, onDone: () => void): Promise<void> {
  area.innerHTML = `<div class="sb-loading">Loading your library...</div>`;
  let scenes: Scene[];
  try {
    scenes = await fetchSetupScenes();
  } catch (e) {
    console.error("[Stash Battle] ELO setup: could not load scenes:", e);
    showError(area, "Couldn't load your scenes from Stash.", () => void loadChoices(area, onDone));
    return;
  }
  renderChoices(area, scenes, onDone);
}

function radio(name: string, value: string, label: string, desc: string, checked: boolean): string {
  const id = `sb-setup-${name}-${value}`;
  return `
              <div class="custom-control custom-radio sb-setup-option">
                <input type="radio" class="custom-control-input" id="${id}" name="${name}" value="${value}" ${checked ? "checked" : ""}>
                <label class="custom-control-label" for="${id}">
                  <strong>${label}</strong>
                  <span class="sb-setup-desc">${desc}</span>
                </label>
              </div>`;
}

/** What the second answer does to Stash ratings now: a warning when ratings change, else a calm line. */
function ratingsMessage(start: EloStart, mode: StashRatingsMode, changes: number): string {
  const backup = "Take a Stash backup first (Settings → Tasks → Backup).";
  let text: string;
  let warn = true;
  if (mode === "off") {
    text = "Stash ratings won't change.";
    warn = false;
  } else if (changes === 0) {
    text = "No Stash ratings change now: every scene converts back to its current rating.";
    warn = false;
  } else if (start === "fresh") {
    text = `⚠️ Every scene starts at 1500 ELO, so <strong>every Stash rating becomes 5.0 (2.5 stars)</strong>: ${plural(changes, "rating")} change, unrated scenes included. ${backup}`;
  } else {
    text = `⚠️ <strong>${plural(changes, "Stash rating")} change</strong> now, spread evenly by rank. A scene you rated 10.0 (5 stars) by hand may end up lower. ${backup}`;
  }
  return `<p class="sb-setup-message${warn ? " sb-setup-warning" : ""}">${text}</p>`;
}

function renderChoices(area: HTMLElement, scenes: Scene[], onDone: () => void): void {
  const total = scenes.length;
  const rated = scenes.filter((scene) => scene.rating100 != null).length;
  const unrated = total - rated;
  const withElo = scenes.filter(isRated).length;
  // Re-runs (Reset ELO, Stage 4) and pre-3.0 fun mode users had no rating updates to lose
  const upgradeNote =
    !state.settings.eloSetupAt && !hadFunMode()
      ? " Before 3.0, ratings changed after every battle; Straight-line with Use my ratings is closest to that."
      : "";

  const reset = options.reset === true;
  const choice: Choice = { start: "ratings", stashRatings: reset ? state.settings.stashRatings : "off" };

  area.innerHTML = `
      <div class="sb-setup">
        <h2 class="sb-setup-title">${reset ? "Reset ELO" : "Set up ELO"}</h2>
        <p class="sb-setup-intro">
          ${
            reset
              ? "Choose how ELO starts again. This overwrites every scene's ELO and battle count."
              : "Stash Battle now gives each scene an ELO score, saved in its custom fields. Wins raise it, losses lower it. Choose how it starts. This runs once."
          }
        </p>
        ${
          withElo > 0 && !reset
            ? `<p class="sb-setup-warning">${plural(withElo, "scene")} already ${withElo === 1 ? "has" : "have"} an ELO from an earlier setup that didn't finish. Setting up again overwrites ${withElo === 1 ? "it" : "them"}.</p>`
            : ""
        }
        <div class="sb-setup-questions">
          <fieldset class="sb-setup-question">
            <legend>How should ELO start?</legend>
            ${radio(
              "start",
              "ratings",
              "Use my ratings",
              `Your ${plural(rated, "rated scene")} start from their rating: a 5.0 (2.5 stars) starts at 1500 ELO.${unrated > 0 ? ` The ${unrated} unrated ${unrated === 1 ? "one stays" : "ones stay"} unrated.` : ""}`,
              true,
            )}
            ${radio(
              "start",
              "fresh",
              "Start everyone at 1500",
              `All ${plural(total, "scene")} start equal.`,
              false,
            )}
          </fieldset>
          <fieldset class="sb-setup-question">
            <legend>Should Stash Battle change your Stash ratings?</legend>
            ${STASH_RATINGS_OPTIONS.map(({ value, label, desc }) =>
              radio("stashRatings", value, label, desc, value === choice.stashRatings),
            ).join("")}
            <p class="sb-setup-note">You can change this later in Settings.${upgradeNote}</p>
          </fieldset>
        </div>
        <div class="sb-setup-message-slot" data-role="ratings-warning"></div>
        <h3 class="sb-setup-subtitle">Preview</h3>
        <div data-role="preview"></div>
        <div class="sb-setup-actions">
          ${reset ? `<button type="button" class="btn btn-secondary" data-role="cancel">Cancel</button>` : ""}
          <button type="button" class="btn btn-primary" data-role="start">Start ELO</button>
        </div>
      </div>`;

  area.querySelector('[data-role="cancel"]')?.addEventListener("click", () => options.onCancel?.());

  const slot = area.querySelector<HTMLElement>('[data-role="ratings-warning"]') as HTMLElement;
  const preview = area.querySelector<HTMLElement>('[data-role="preview"]') as HTMLElement;
  const startBtn = area.querySelector<HTMLButtonElement>('[data-role="start"]') as HTMLButtonElement;

  // Every answer's message sits in the slot at once, stacked in one grid cell, so the slot is
  // always as tall as the longest and switching answers never moves the layout below it.
  // Answers with the same message share one element, so switching between them doesn't fade.
  const changeCounts = new Map<string, number>();
  const messageFor = new Map<string, Element>();
  const messageByHtml = new Map<string, Element>();
  for (const start of ["ratings", "fresh"] as const) {
    for (const mode of ["off", "linear", "percentile"] as const) {
      const changes = setupRatingChanges(scenes, start, mode).size;
      const html = ratingsMessage(start, mode, changes);
      let message = messageByHtml.get(html);
      if (!message) {
        slot.insertAdjacentHTML("beforeend", html);
        message = slot.lastElementChild as Element;
        messageByHtml.set(html, message);
      }
      changeCounts.set(`${start}:${mode}`, changes);
      messageFor.set(`${start}:${mode}`, message);
    }
  }

  const update = (): void => {
    showRatingPreview(preview, choice.start, choice.stashRatings);
    const key = `${choice.start}:${choice.stashRatings}`;
    const shown = messageFor.get(key);
    for (const message of slot.children) message.classList.toggle("sb-shown", message === shown);
    const changes = changeCounts.get(key) ?? 0;
    startBtn.textContent = changes > 0 ? `Start ELO and change ${plural(changes, "rating")}` : "Start ELO";
  };

  area.querySelectorAll<HTMLInputElement>('input[type="radio"]').forEach((input) => {
    input.addEventListener("change", () => {
      if (input.name === "start") choice.start = input.value as EloStart;
      else choice.stashRatings = input.value as StashRatingsMode;
      update();
    });
  });
  startBtn.addEventListener("click", () => void runSetup(area, scenes, choice, onDone));
  update();
}

function progressHtml(phase: SetupPhase, done: number, total: number): string {
  const percent = total > 0 ? Math.round((done / total) * 100) : 100;
  const label =
    phase === "elo"
      ? `Saving starting ELO: ${done} of ${plural(total, "scene")}`
      : `Updating Stash ratings: ${plural(total, "scene")}`;
  return `
      <div class="sb-setup sb-setup-progress">
        <h2 class="sb-setup-title">Setting up ELO...</h2>
        <div class="progress"><div class="progress-bar" role="progressbar" style="width: ${percent}%" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100"></div></div>
        <p class="sb-setup-progress-label">${label}</p>
        <p class="sb-setup-note">You can close Stash Battle; setup keeps going while this Stash tab stays open. If the tab closes first, Stash Battle asks again next time, and running it again is safe.</p>
      </div>`;
}

async function runSetup(area: HTMLElement, scenes: Scene[], choice: Choice, onDone: () => void): Promise<void> {
  running = true;
  area.innerHTML = progressHtml("elo", 0, 0);
  // A reset clears the "setup finished" flag first, so if it's interrupted Stash Battle asks again
  if (state.settings.eloSetupAt && !(await updateSettingsNow({ eloSetupAt: null, eloSetupMode: null }))) {
    console.warn("[Stash Battle] Couldn't clear the setup flag before resetting ELO; continuing");
  }
  let summary: SetupSummary;
  try {
    summary = await runEloSetup(scenes, choice.start, choice.stashRatings, (phase, done, total) => {
      area.innerHTML = progressHtml(phase, done, total);
    });
  } catch (e) {
    running = false;
    console.error("[Stash Battle] ELO setup failed:", e);
    showError(
      area,
      `Setup stopped partway: ${escapeHtml(e instanceof Error ? e.message : String(e))}. Running it again is safe; it overwrites what was written.`,
      () => void loadChoices(area, onDone),
    );
    return;
  }

  // Cached scenes and any saved pair predate the new ELO (and possibly the new ratings)
  await clearSceneCache();
  resetShuffle();
  resetRunState();
  state.currentPair = { left: null, right: null };
  state.currentRanks = { left: null, right: null };
  saveState();

  await finishSetup(area, summary, choice, onDone);
}

/** Save the completion flags (retrying on request), then show the summary. */
async function finishSetup(area: HTMLElement, summary: SetupSummary, choice: Choice, onDone: () => void): Promise<void> {
  const saved = await updateSettingsNow({
    eloSetupAt: new Date().toISOString(),
    eloSetupMode: choice.start,
    stashRatings: choice.stashRatings,
  });
  if (!saved) {
    // Without the flag, setup would show again on the next open: keep it pending here too
    state.settings = { ...state.settings, eloSetupAt: null };
    showError(
      area,
      "Your ELO is saved, but Stash Battle couldn't record in Stash that setup finished.",
      () => void finishSetup(area, summary, choice, onDone),
    );
    return;
  }
  running = false;

  const eloLine =
    choice.start === "ratings"
      ? `${plural(summary.eloWritten, "scene")} got a starting ELO from ${summary.eloWritten === 1 ? "its" : "their"} rating. Unrated scenes stay unrated until they battle.`
      : `${plural(summary.eloWritten, "scene")} start at 1500 ELO.`;
  const clearedLine =
    summary.eloCleared > 0 ? `<li>${plural(summary.eloCleared, "scene")} without a Stash rating had an old ELO removed.</li>` : "";
  const optionLabel = choice.stashRatings === "percentile" ? "Percentile" : "Straight-line";
  const ratingsLine =
    choice.stashRatings === "off"
      ? "Stash ratings weren't changed, and battles won't change them."
      : summary.ratingsWritten === 0
        ? `Stash ratings already matched (${optionLabel}), so none changed. Battles keep them in step from now on.`
        : `${plural(summary.ratingsWritten, "Stash rating")} updated (${optionLabel}). Battles keep them in step from now on.`;

  area.innerHTML = `
      <div class="sb-setup sb-setup-done">
        <h2 class="sb-setup-title">✅ ELO is ready</h2>
        <ul class="sb-setup-summary">
          <li>${eloLine}</li>
          ${clearedLine}
          <li>${ratingsLine}</li>
        </ul>
        <div class="sb-setup-actions">
          <button type="button" class="btn btn-primary" data-role="done">Start battling</button>
        </div>
      </div>`;
  area.querySelector('[data-role="done"]')?.addEventListener("click", () => {
    hideSetupScreen(area.ownerDocument);
    onDone();
  });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}

function showError(area: HTMLElement, message: string, retry: () => void): void {
  area.innerHTML = `
      <div class="sb-setup sb-error-screen">
        <div class="sb-error-icon">⚠️</div>
        <p class="sb-error-message">${message}</p>
        <button type="button" class="btn btn-primary" data-role="retry">Try again</button>
      </div>`;
  area.querySelector('[data-role="retry"]')?.addEventListener("click", retry);
}
