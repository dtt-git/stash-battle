// What each "Stash ratings" option does, shared by the setup screen and the Settings dropdown.

import type { StashRatingsMode } from "../types";

export const STASH_RATINGS_OPTIONS: readonly { value: StashRatingsMode; label: string; desc: string }[] = [
  { value: "off", label: "Don't update", desc: "ELO is saved; your Stash ratings stay as they are." },
  {
    value: "linear",
    label: "Straight-line",
    desc: "Rating = ELO converted back (1500 = 50, 10 ELO per point). Very high or low scenes stop at 100 or 1.",
  },
  {
    value: "percentile",
    label: "Percentile",
    desc: "Rating = percentile in your library: 90 means the scene ranks above about 90% of your scenes. Top scene 100, bottom 1.",
  },
];

export function stashRatingsOption(value: StashRatingsMode): (typeof STASH_RATINGS_OPTIONS)[number] {
  return STASH_RATINGS_OPTIONS.find((option) => option.value === value) ?? STASH_RATINGS_OPTIONS[0];
}
