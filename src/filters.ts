// URL filter parsing for Stash list → GraphQL scene queries.

import type { FindFilterType, SceneFilterType } from "./types";

// Get current URL search params
export function getSearchParams(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}

// Build FindFilterType from current URL search params (or an explicit params object).
export function getFindFilter(
  overrides: Partial<FindFilterType> = {},
  searchParams: URLSearchParams = getSearchParams(),
): FindFilterType {
  const filter: FindFilterType = {
    per_page: overrides.per_page ?? -1,
    sort: overrides.sort ?? (searchParams.get("sortby") || "rating"),
    direction: overrides.direction ?? (searchParams.get("sortdir")?.toUpperCase() || "DESC"),
    ...overrides,
  };

  // Include search query if present
  const query = searchParams.get("q");
  if (query) {
    filter.q = query;
  }

  return filter;
}

// Translate JSON string between URL format (parentheses) and standard JSON (braces)
// Ported from Stash's ListFilterModel.translateJSON
// This safely handles parentheses inside quoted strings
export function translateJSON(jsonString: string, decoding: boolean): string {
  let inString = false;
  let escape = false;
  return [...jsonString]
    .map((c) => {
      if (escape) {
        escape = false;
        return c;
      }
      switch (c) {
        case "\\":
          if (inString) escape = true;
          break;
        case '"':
          inString = !inString;
          break;
        case "(":
          if (decoding && !inString) return "{";
          break;
        case ")":
          if (decoding && !inString) return "}";
          break;
      }
      return c;
    })
    .join("");
}

// Criterion category mappings for URL -> GraphQL transformation
// Each category requires different transformation logic
const CRITERION_CATEGORIES = {
  // Boolean: no modifier, value is "true"/"false" string -> convert to boolean
  boolean: new Set(["organized", "interactive", "performer_favorite"]),
  // StringEnum: URL has modifier but GraphQL just expects the string value directly
  stringEnum: new Set(["is_missing", "has_markers"]),
  // Multi: value is array of {id, label} -> extract IDs only
  multi: new Set(["performers", "groups", "movies", "galleries"]),
  // HierarchicalMulti: value has {items, excluded, depth} -> rename to {value, excludes, depth} and extract IDs
  hierarchicalMulti: new Set(["tags", "studios", "performer_tags"]),
};

// Resolution string to GraphQL enum mapping
// URL uses human-readable strings, GraphQL expects ResolutionEnum values
const RESOLUTION_MAP: Record<string, string> = {
  "144p": "VERY_LOW",
  "240p": "LOW",
  "360p": "R360P",
  "480p": "STANDARD",
  "540p": "WEB_HD",
  "720p": "STANDARD_HD",
  "1080p": "FULL_HD",
  "1440p": "QUAD_HD",
  "4k": "FOUR_K",
  "5k": "FIVE_K",
  "6k": "SIX_K",
  "7k": "SEVEN_K",
  "8k": "EIGHT_K",
  Huge: "HUGE",
};

// Orientation string to GraphQL enum mapping
const ORIENTATION_MAP: Record<string, string> = {
  Landscape: "LANDSCAPE",
  Portrait: "PORTRAIT",
  Square: "SQUARE",
};

const idOf = (v: any): unknown => (typeof v === "object" && v && v.id ? v.id : v);

// Build SceneFilterType from URL 'c' params (defaults to current page URL).
export function getSceneFilter(
  searchParams: URLSearchParams = getSearchParams(),
): SceneFilterType | null {
  const sceneFilter: SceneFilterType = {};

  if (!searchParams.has("c")) return null;

  for (const cStr of searchParams.getAll("c")) {
    try {
      // Decode URL format: () -> {} (safely preserving strings)
      const decoded = translateJSON(cStr, true);
      const cObj: any = JSON.parse(decoded);

      const filterType: string | undefined = cObj.type;
      if (!filterType) {
        console.warn("[Stash Battle] Filter missing type:", cObj);
        continue;
      }

      // Remove type from the object - it becomes the key
      const { type: _type, ...rest } = cObj;

      // Category: Boolean (organized, interactive, performer_favorite)
      if (CRITERION_CATEGORIES.boolean.has(filterType)) {
        sceneFilter[filterType] = rest.value === "true" || rest.value === true;
        continue;
      }

      // Category: StringEnum (sceneIsMissing, hasMarkers)
      if (CRITERION_CATEGORIES.stringEnum.has(filterType)) {
        sceneFilter[filterType] = rest.value;
        continue;
      }

      // Category: Multi (performers, groups, movies, galleries)
      if (CRITERION_CATEGORIES.multi.has(filterType)) {
        const result: Record<string, unknown> = { modifier: rest.modifier };
        const val = rest.value || {};

        if (val.items !== undefined) {
          const items: any[] = val.items || [];
          const excluded: any[] = val.excluded || [];
          result.value = items.map(idOf);
          if (excluded.length > 0) {
            result.excludes = excluded.map(idOf);
          }
        } else if (Array.isArray(rest.value)) {
          result.value = rest.value.map(idOf);
        } else if (rest.modifier === "IS_NULL" || rest.modifier === "NOT_NULL") {
          result.value = [];
        } else {
          result.value = rest.value;
        }

        sceneFilter[filterType] = result;
        continue;
      }

      // Category: HierarchicalMulti (tags, studios, performer_tags)
      if (CRITERION_CATEGORIES.hierarchicalMulti.has(filterType)) {
        const val = rest.value || {};
        const items: any[] = val.items || [];
        const excluded: any[] = val.excluded || [];
        sceneFilter[filterType] = {
          modifier: rest.modifier,
          value: items.map(idOf),
          excludes: excluded.map(idOf),
          depth: val.depth ?? 0,
        };
        continue;
      }

      // Category: Resolution (needs string -> enum conversion)
      if (filterType === "resolution") {
        sceneFilter[filterType] = {
          modifier: rest.modifier,
          value: RESOLUTION_MAP[rest.value] || rest.value,
        };
        continue;
      }

      // Category: Orientation (multi-select enum, no modifier)
      if (filterType === "orientation") {
        const values: any[] = Array.isArray(rest.value) ? rest.value : [rest.value];
        sceneFilter[filterType] = {
          value: values.map((v) => ORIENTATION_MAP[v] || v).filter(Boolean),
        };
        continue;
      }

      // Category: Duplicated (phash duplicate filter - different structure)
      if (filterType === "duplicated") {
        sceneFilter[filterType] = {
          duplicated: rest.value === "true" || rest.value === true,
        };
        continue;
      }

      // Category: Standard (number, string, date, timestamp, duration, special)
      if (
        rest.value &&
        typeof rest.value === "object" &&
        !Array.isArray(rest.value) &&
        "value" in rest.value
      ) {
        // Flatten: { modifier, value: { value: X, value2: Y } } -> { modifier, value: X, value2: Y }
        sceneFilter[filterType] = {
          modifier: rest.modifier,
          value: rest.value.value,
          ...(rest.value.value2 !== undefined && { value2: rest.value.value2 }),
        };
      } else if (rest.modifier === "IS_NULL" || rest.modifier === "NOT_NULL") {
        // IS_NULL/NOT_NULL don't use the value, but the schema still requires it
        sceneFilter[filterType] = {
          modifier: rest.modifier,
          value: 0,
        };
      } else {
        // Pass through as-is (string criteria, special criteria like phash, stash_id, etc.)
        sceneFilter[filterType] = rest;
      }
    } catch (e) {
      console.error("[Stash Battle] Failed to parse filter:", cStr, e);
    }
  }

  return Object.keys(sceneFilter).length > 0 ? sceneFilter : null;
}

/** Parsed filter state for the current Stash list URL. */
export interface ListFilters {
  filterKey: string;
  sceneFilter: SceneFilterType | null;
  filterActive: boolean;
}

/** Read URL filter state once (cache key, GraphQL scene_filter, active flag). */
export function readFilters(): ListFilters {
  const searchParams = getSearchParams();
  const sceneFilter = getSceneFilter(searchParams);
  const q = searchParams.get("q") || "";
  return {
    filterKey: JSON.stringify({ q, filter: sceneFilter || {} }),
    sceneFilter,
    filterActive: Boolean(sceneFilter || searchParams.has("c") || searchParams.get("q")),
  };
}

// Cache key for the current list URL (criteria + text search).
export function buildFilterKey(): string {
  return readFilters().filterKey;
}

/** True when the current Stash list URL has active filters (criteria and/or text search). */
export function checkForFilters(): boolean {
  return readFilters().filterActive;
}
