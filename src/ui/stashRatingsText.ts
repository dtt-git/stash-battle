// What each "Stash ratings" option does, shared by the setup screen and the Settings dropdown.

import type { StashRatingsMode } from "../types";

export const STASH_RATINGS_OPTIONS: readonly { value: StashRatingsMode; label: string; desc: string }[] = [
  { value: "off", label: "Don't update", desc: "ELO is saved; your Stash ratings stay as they are." },
  {
    value: "linear",
    label: "Straight-line",
    desc: "Rating = ELO converted back (1500 = 5.0, or 2.5 stars). Very high or low scenes stop at the top or bottom of the scale.",
  },
  {
    value: "percentile",
    label: "Percentile",
    desc: "Rating = percentile in your library: 9.0 (4.5 stars) means the scene ranks above about 90% of your scenes. The top scene gets the top rating, the bottom scene the lowest.",
  },
];

export function stashRatingsOption(value: StashRatingsMode): (typeof STASH_RATINGS_OPTIONS)[number] {
  return STASH_RATINGS_OPTIONS.find((option) => option.value === value) ?? STASH_RATINGS_OPTIONS[0];
}
