// Setup preview: ten example scenes in three rows (now in Stash / after setup / after lots of
// battles). Every number comes from the real score.ts functions, so the preview can't drift
// from what setup and the Stash ratings options actually do.

import { ELO_FIELD } from "../constants";
import { afterSetup, elo, stashRatingTargets } from "../score";
import type { EloStart, Scene, StashRatingsMode } from "../types";

/** Example Stash ratings today: the tie at 100 shows how ratings bunch up at the top. */
const NOW_RATINGS: (number | null)[] = [100, 100, 96, 85, 74, 70, 62, 45, 20, null];

/** Example ELO once battles have spread the scenes out (the same for both start choices). */
const BATTLED_ELO = [2150, 1980, 1700, 1650, 1600, 1550, 1500, 1400, 1250, 1100];

interface Square {
  elo: number | null;
  rating: number | null;
  changed: boolean;
}

function exampleScenes(): Scene[] {
  return NOW_RATINGS.map((rating100, i) => ({ id: `example-${i}`, rating100, custom_fields: {} }));
}

/** Each scene's Stash rating under the mode: written ones get their target, others stay as now. */
function squares(scenes: Scene[], mode: StashRatingsMode): Square[] {
  const targets = stashRatingTargets(scenes, mode);
  return scenes.map((scene) => {
    const rating = targets.get(scene.id) ?? scene.rating100 ?? null;
    return { elo: elo(scene), rating, changed: rating !== (scene.rating100 ?? null) };
  });
}

function squareHtml({ elo: eloValue, rating, changed }: Square, showChange: boolean): string {
  const classes = ["sb-pv-square"];
  if (rating === null) classes.push("sb-pv-unrated");
  if (rating !== null && rating > 55) classes.push("sb-pv-strong");
  if (showChange && changed) classes.push("sb-pv-changed");
  const fill = rating === null ? "" : ` style="--sb-pv-fill: ${rating}%"`;
  return `
            <div class="sb-pv-cell">
              <span class="sb-pv-elo">${eloValue === null ? "" : Math.round(eloValue)}</span>
              <span class="${classes.join(" ")}"${fill}>${rating ?? "–"}</span>
            </div>`;
}

function rowHtml(label: string, cells: Square[], note: string, options: { muted?: boolean; showChange?: boolean } = {}): string {
  return `
          <div class="sb-pv-row${options.muted ? " sb-pv-muted" : ""}">
            <div class="sb-pv-label">${label}</div>
            <div class="sb-pv-squares">${cells.map((cell) => squareHtml(cell, options.showChange ?? false)).join("")}
            </div>
            <div class="sb-pv-note">${note}</div>
          </div>`;
}

/** How long a number counts from its old value to its new one (colours fade over the same time in CSS). */
const TWEEN_MS = 400;

/** Running count per element: its animation frame, and a timer that lands it if frames stall. */
const tweens = new WeakMap<Element, { frame: number; timer: ReturnType<typeof setTimeout> }>();

/** Count an element's number from what it shows now to `target`; non-numbers (–, blank) just swap. */
function tweenText(el: Element, target: string): void {
  const running = tweens.get(el);
  if (running) {
    cancelAnimationFrame(running.frame);
    clearTimeout(running.timer);
    tweens.delete(el);
  }
  const from = Number(el.textContent);
  const to = Number(target);
  if (el.textContent === "" || target === "" || !Number.isFinite(from) || !Number.isFinite(to) || from === to) {
    el.textContent = target;
    return;
  }
  const startTime = performance.now();
  // Background tabs get no animation frames: land on the final number regardless
  const timer = setTimeout(() => {
    const current = tweens.get(el);
    if (current) cancelAnimationFrame(current.frame);
    tweens.delete(el);
    el.textContent = target;
  }, TWEEN_MS + 50);
  const step = (now: number): void => {
    const t = Math.min(1, (now - startTime) / TWEEN_MS);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = String(Math.round(from + (to - from) * eased));
    if (t < 1) tweens.set(el, { frame: requestAnimationFrame(step), timer });
  };
  tweens.set(el, { frame: requestAnimationFrame(step), timer });
}

/**
 * Show the preview in `container`. When one is already there, it's updated in place so the
 * numbers count to their new values and the colours fade (CSS transitions) instead of jumping.
 */
export function showRatingPreview(container: HTMLElement, start: EloStart, stashRatings: StashRatingsMode): void {
  const next = document.createElement("div");
  next.innerHTML = renderRatingPreview(start, stashRatings);
  const current = container.querySelector(".sb-rating-preview");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!current || reducedMotion) {
    container.replaceChildren(...next.childNodes);
    return;
  }

  const fresh = next.querySelector(".sb-rating-preview") as Element;
  const pairs = (selector: string): [Element, Element][] => {
    const now = current.querySelectorAll(selector);
    return [...fresh.querySelectorAll(selector)].map((el, i) => [now[i], el]);
  };
  for (const [el, to] of pairs(".sb-pv-row")) el.className = to.className;
  for (const [el, to] of pairs(".sb-pv-note")) el.textContent = to.textContent;
  for (const [el, to] of pairs(".sb-pv-elo")) tweenText(el, to.textContent ?? "");
  for (const [el, to] of pairs(".sb-pv-square")) {
    el.className = to.className;
    el.setAttribute("style", to.getAttribute("style") ?? "");
    tweenText(el, to.textContent ?? "");
  }
}

/** The preview for one pair of setup answers, as an HTML string. */
export function renderRatingPreview(start: EloStart, stashRatings: StashRatingsMode): string {
  const off = stashRatings === "off";
  const now = squares(exampleScenes(), "off");

  const setUp = squares(exampleScenes().map((scene) => afterSetup(scene, start)), stashRatings);
  const changedCount = setUp.filter((cell) => cell.changed).length;

  const battled = exampleScenes().map((scene, i) => ({ ...scene, custom_fields: { [ELO_FIELD]: BATTLED_ELO[i] } }));
  const later = squares(battled, stashRatings);

  const unchangedNote = "Stash ratings stay as they are";
  const laterNote = off
    ? unchangedNote
    : stashRatings === "percentile"
      ? "Evenly spaced by rank, whatever the gaps"
      : "Gaps show, but 2150 is stuck at 100";

  return `
        <div class="sb-rating-preview">
          <p class="sb-pv-legend">Above each square: ELO. Inside: Stash rating.</p>
          ${rowHtml("Now in Stash", now, "")}
          ${rowHtml("After setup", setUp, off ? unchangedNote : `${changedCount} of 10 change`, { muted: off, showChange: !off })}
          ${rowHtml("After lots of battles", later, laterNote, { muted: off })}
        </div>`;
}
