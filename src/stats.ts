// Library-wide numbers worked out from the scenes (tiers so far). Pure functions: no state, no I/O.

import { TIERS } from "./constants";
import { elo, isProvisional } from "./score";
import type { Scene, Tier } from "./types";

/**
 * Tier for every settled scene (rated and not provisional), by rank among them: a scene whose
 * rank is within the top `tier.top` share gets that tier. Tied scenes share the middle position
 * of their tie group, as in percentileRatings, so they always share a tier. Provisional and
 * unrated scenes get none, like "unranked" until placement matches are done.
 */
export function tierMap(scenes: Scene[]): Map<string, Tier> {
  const settled = scenes
    .filter((scene) => !isProvisional(scene))
    .map((scene) => ({ id: scene.id, elo: elo(scene) }))
    .filter((s): s is { id: string; elo: number } => s.elo !== null)
    .sort((a, b) => b.elo - a.elo);

  const tiers = new Map<string, Tier>();
  const n = settled.length;
  let start = 0;
  while (start < n) {
    let end = start;
    while (end + 1 < n && settled[end + 1].elo === settled[start].elo) end++;
    // Share of settled scenes ranked above this tie group's middle (0 for the top scene)
    const above = (start + end) / 2 / n;
    const tier = TIERS.find((t) => above < t.top) ?? TIERS[TIERS.length - 1];
    for (let i = start; i <= end; i++) tiers.set(settled[i].id, tier);
    start = end + 1;
  }
  return tiers;
}

/** Tooltip for a tier: "Gold: in the top 35% of your scenes with a settled ELO". */
export function tierDescription(tier: Tier): string {
  const index = TIERS.findIndex((t) => t.id === tier.id);
  const percent = (share: number): string => `${Math.round(share * 100)}%`;
  const where =
    index === TIERS.length - 1 && index > 0
      ? `below the top ${percent(TIERS[index - 1].top)}`
      : `in the top ${percent(tier.top)}`;
  return `${tier.name}: ${where} of your scenes with a settled ELO`;
}
