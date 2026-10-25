// What each "Stash ratings" option does, shared by the setup screen and the Settings dropdown.

import { exampleRating, formatRating } from "../ratingDisplay";
import { seed } from "../score";
import type { StashRatingsMode } from "../types";

// Descriptions are getters: their example ratings follow how this Stash shows ratings (stars or
// decimal), which is only known once the settings have loaded.
export const STASH_RATINGS_OPTIONS: readonly { value: StashRatingsMode; label: string; readonly desc: string }[] = [
  { value: "off", label: "Don't update", desc: "ELO is saved; your Stash ratings stay as they are." },
  {
    value: "linear",
    label: "Straight-line",
    get desc(): string {
      const ex = exampleRating(50);
      return `Rating = ELO converted back (${seed(ex)} = ${formatRating(ex, true)}). Very high or low scenes stop at the top or bottom of the scale.`;
    },
  },
  {
    value: "percentile",
    label: "Percentile",
    get desc(): string {
      const ex = exampleRating(90);
      return `Rating = percentile in your library: ${formatRating(ex, true)} means the scene ranks above about ${ex}% of your scenes. The top scene gets the top rating, the bottom scene the lowest.`;
    },
  },
];

export function stashRatingsOption(value: StashRatingsMode): (typeof STASH_RATINGS_OPTIONS)[number] {
  return STASH_RATINGS_OPTIONS.find((option) => option.value === value) ?? STASH_RATINGS_OPTIONS[0];
}
