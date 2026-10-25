// How the user's Stash shows ratings (Settings → Interface → Rating system): stars, with a
// precision, or a 0-10 decimal. Stash stores 1-100 either way; Stash Battle shows ratings the
// way Stash does, so a 74 reads "7.4" or "3.5★", never "74/100".

export interface RatingSystem {
  type: "stars" | "decimal";
  /** The smallest star step: 1 (full), 0.5, 0.25 or 0.1. Unused for decimal. */
  starStep: number;
}

const STAR_STEPS: Record<string, number> = { full: 1, half: 0.5, quarter: 0.25, tenth: 0.1 };

/** Stash's own default when nothing is saved: whole stars. */
export const DEFAULT_RATING_SYSTEM: RatingSystem = { type: "stars", starStep: 1 };

let current: RatingSystem = DEFAULT_RATING_SYSTEM;

/** Read Stash's `configuration.ui` (its ratingSystemOptions). Anything unreadable means the default. */
export function parseRatingSystem(ui: unknown): RatingSystem {
  const options = (ui as { ratingSystemOptions?: { type?: unknown; starPrecision?: unknown } } | null | undefined)?.ratingSystemOptions;
  return {
    type: options?.type === "decimal" ? "decimal" : "stars",
    starStep: STAR_STEPS[String(options?.starPrecision)] ?? 1,
  };
}

/** Remember the rating system from Stash's `configuration.ui` (loaded with the settings). */
export function setRatingSystem(ui: unknown): void {
  current = parseRatingSystem(ui);
}

export function getRatingSystem(): RatingSystem {
  return current;
}

/** The number Stash shows for a 1-100 rating: 74 → "7.4" (decimal), "3.5" or "4" (stars). */
export function ratingValue(rating100: number, system: RatingSystem = current): string {
  if (system.type === "decimal") return (Math.round(rating100) / 10).toFixed(1);
  // Never 0 stars for a rating that's set: the lowest is one step
  const stars = Math.max(system.starStep, Math.round(rating100 / 20 / system.starStep) * system.starStep);
  return String(Number(stars.toFixed(2)));
}

/** A rating as Stash shows it: "7.4" or "3.5★"; `long` spells stars out ("3.5 stars"). */
export function formatRating(rating100: number, long = false, system: RatingSystem = current): string {
  const value = ratingValue(rating100, system);
  if (system.type === "decimal") return value;
  return long ? `${value} star${value === "1" ? "" : "s"}` : `${value}★`;
}

/** "a 5.0 starts" / "2.5 stars start": a rating as the subject of a sentence, with its verb. */
export function ratingStarts(rating100: number, system: RatingSystem = current): string {
  if (system.type === "decimal") return `a ${ratingValue(rating100, system)} starts`;
  const text = formatRating(rating100, true, system);
  return `${text} ${text.endsWith("stars") ? "start" : "starts"}`;
}

/** Where the Stats chart marks Stash ratings: 0.1 / 2.5 / 5.0 / 7.5 / 10.0, or 1-5 stars. */
export function scaleMarks(system: RatingSystem = current): number[] {
  return system.type === "decimal" ? [1, 25, 50, 75, 100] : [1, 40, 60, 80, 100];
}

/**
 * A 1-100 rating near `rating100` (at or below it) that this system can show exactly, for
 * examples in descriptions: on whole stars a 50 (2.5 stars) doesn't exist, so it's 40 (2 stars).
 */
export function exampleRating(rating100: number, system: RatingSystem = current): number {
  if (system.type === "decimal") return rating100;
  const grid = 20 * system.starStep;
  return Math.max(grid, Math.floor(rating100 / grid) * grid);
}
