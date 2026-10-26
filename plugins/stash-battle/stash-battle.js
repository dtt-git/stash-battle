"use strict";
(() => {
  // src/constants.ts
  var STORAGE_KEY = "stash-battle-state";
  var CACHE_DB_NAME = "stash-battle-cache";
  var CACHE_DB_VERSION = 2;
  var CACHE_STORE_NAME = "scenes";
  var CACHE_MAX_AGE_MS = 5 * 60 * 1e3;
  var EXPLORE_PAGE_SIZES = [30, 60, 120, 240, 0];
  var PLUGIN_ID = "stash-battle";
  var DEFAULT_SETTINGS = {
    stashRatings: "off",
    eloSetupAt: null,
    eloSetupMode: null,
    openInNewTab: false,
    placementFromBottom: false,
    tierBorders: true,
    previewVolume: 50,
    explorePageSize: 60,
    autoplayPreviews: true,
    filterOpponents: false,
    cleanMode: false,
    pauseMediaOnOpen: true
  };
  var LEGACY_FILTER_OPPONENTS_KEY = "sb_filterOpponents";
  var LEGACY_MUTE_PREVIEWS_KEY = "sb_mutePreviews";
  var SWISS_OPPONENT_ELO_WINDOW = 100;
  var SWISS_OPPONENT_MIN_CANDIDATES = 10;
  var CLIMB_OPPONENT_PICK_WINDOW = 5;
  var CHAMPION_UNRATED_ELO = 1e3;
  var UPSET_MAX_CHANCE = 40;
  var CLIMB_SMALL_POOL_WARN_AT = 10;
  var ELO_FIELD = "stash_battle_elo";
  var BATTLES_FIELD = "stash_battle_battles";
  var SEEDED_FIELD = "stash_battle_seeded";
  var WINS_FIELD = "stash_battle_wins";
  var LOSSES_FIELD = "stash_battle_losses";
  var PEAK_FIELD = "stash_battle_peak";
  var STREAK_FIELD = "stash_battle_streak";
  var BEST_STREAK_FIELD = "stash_battle_best_streak";
  var RECORD_FIELD_KEYS = [WINS_FIELD, LOSSES_FIELD, PEAK_FIELD, STREAK_FIELD, BEST_STREAK_FIELD];
  var ELO_FIELD_KEYS = [ELO_FIELD, BATTLES_FIELD, SEEDED_FIELD, ...RECORD_FIELD_KEYS];
  var ELO_START = 1500;
  var ELO_DIVISOR = 400;
  var ELO_K_TIERS = [
    [10, 40],
    [30, 24],
    [Infinity, 16]
  ];
  var TIERS = [
    { id: "legendary", name: "Legendary", emoji: "👑", top: 0.01 },
    { id: "diamond", name: "Diamond", emoji: "💎", top: 0.05 },
    { id: "platinum", name: "Platinum", emoji: "🔷", top: 0.15 },
    { id: "gold", name: "Gold", emoji: "🥇", top: 0.35 },
    { id: "silver", name: "Silver", emoji: "🥈", top: 0.65 },
    { id: "bronze", name: "Bronze", emoji: "🥉", top: 1 }
  ];
  var ELO_PER_RATING_POINT = 10;
  var SEEDED_HEAD_START = 10;
  var PLACEMENT_EDGE_GAP = 25;
  var PLACEMENT_MAX_JUMP_SHARE = 0.1;
  var PLACEMENT_MIN_MAX_JUMP = 4;

  // src/elo.ts
  function eloKFactor(kGames2) {
    for (const [below, k] of ELO_K_TIERS) {
      if (kGames2 < below) return k;
    }
    return ELO_K_TIERS[ELO_K_TIERS.length - 1][1];
  }
  function eloExpected(elo2, opponentElo) {
    return 1 / (1 + Math.pow(10, (opponentElo - elo2) / ELO_DIVISOR));
  }
  function winChances(elo2, opponentElo) {
    const first = Math.min(99, Math.max(1, Math.round(eloExpected(elo2, opponentElo) * 100)));
    return [first, 100 - first];
  }
  function roundElo(elo2) {
    return Math.round(elo2 * 10) / 10;
  }
  function eloResult(winner, loser) {
    const surprise = 1 - eloExpected(winner.elo, loser.elo);
    return {
      winner: roundElo(winner.elo + eloKFactor(winner.kGames) * surprise),
      loser: roundElo(loser.elo - eloKFactor(loser.kGames) * surprise)
    };
  }

  // src/score.ts
  function readNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string" && value.trim() !== "") {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }
  function elo(scene) {
    return readNumber(scene.custom_fields?.[ELO_FIELD]);
  }
  function isRated(scene) {
    return elo(scene) !== null;
  }
  function battles(scene) {
    const n = readNumber(scene.custom_fields?.[BATTLES_FIELD]);
    return n !== null && n > 0 ? Math.floor(n) : 0;
  }
  function isSeeded(scene) {
    const value = scene.custom_fields?.[SEEDED_FIELD];
    return value === true || value === 1 || value === "true" || value === "1";
  }
  function kGames(scene) {
    return battles(scene) + (isSeeded(scene) ? SEEDED_HEAD_START : 0);
  }
  function isProvisional(scene) {
    return isRated(scene) && kGames(scene) < ELO_K_TIERS[0][0];
  }
  function sceneRecord(scene) {
    const fields = scene.custom_fields;
    const count = (key) => {
      const n = readNumber(fields?.[key]);
      return n === null ? null : Math.max(0, Math.floor(n));
    };
    const wins = count(WINS_FIELD);
    const losses = count(LOSSES_FIELD);
    const peak = readNumber(fields?.[PEAK_FIELD]);
    if (wins === null && losses === null && peak === null) return null;
    return {
      wins: wins ?? 0,
      losses: losses ?? 0,
      peak: peak ?? elo(scene) ?? 0,
      streak: count(STREAK_FIELD) ?? 0,
      bestStreak: count(BEST_STREAK_FIELD) ?? 0
    };
  }
  function recordText(scene) {
    const record = sceneRecord(scene);
    if (record) return `${record.wins}–${record.losses}`;
    return battles(scene) === 0 ? "0–0" : null;
  }
  function recordAfter(record, results2, startElo, newElo) {
    const next = record ? { ...record } : { wins: 0, losses: 0, peak: startElo, streak: 0, bestStreak: 0 };
    for (const won of results2) {
      if (won) {
        next.wins++;
        next.streak++;
        next.bestStreak = Math.max(next.bestStreak, next.streak);
      } else {
        next.losses++;
        next.streak = 0;
      }
    }
    next.peak = roundElo(Math.max(next.peak, newElo));
    return next;
  }
  function eloCustomFields(value) {
    const fields = { [ELO_FIELD]: value.elo, [BATTLES_FIELD]: value.battles, [SEEDED_FIELD]: value.seeded };
    const record = value.record;
    if (record) {
      Object.assign(fields, {
        [WINS_FIELD]: record.wins,
        [LOSSES_FIELD]: record.losses,
        [PEAK_FIELD]: record.peak,
        [STREAK_FIELD]: record.streak,
        [BEST_STREAK_FIELD]: record.bestStreak
      });
    }
    return fields;
  }
  function seed(rating100) {
    return ELO_START + (rating100 - 50) * ELO_PER_RATING_POINT;
  }
  function effectiveElo(scene, unratedElo = ELO_START) {
    return elo(scene) ?? unratedElo;
  }
  function linearRating(eloValue) {
    const rating = Math.round(50 + (eloValue - ELO_START) / ELO_PER_RATING_POINT);
    return Math.min(100, Math.max(1, rating));
  }
  function percentileRatings(scenes2) {
    const rated = scenes2.map((scene) => ({ id: scene.id, elo: elo(scene) })).filter((s) => s.elo !== null).sort((a, b) => b.elo - a.elo);
    const ratings = /* @__PURE__ */ new Map();
    const n = rated.length;
    if (n === 1) {
      ratings.set(rated[0].id, 50);
      return ratings;
    }
    let start = 0;
    while (start < n) {
      let end = start;
      while (end + 1 < n && rated[end + 1].elo === rated[start].elo) end++;
      const rating = 100 - Math.round(99 * ((start + end) / 2) / (n - 1));
      for (let i = start; i <= end; i++) ratings.set(rated[i].id, rating);
      start = end + 1;
    }
    return ratings;
  }
  function stashRatingTargets(scenes2, mode) {
    if (mode === "percentile") return percentileRatings(scenes2);
    const targets = /* @__PURE__ */ new Map();
    if (mode === "linear") {
      for (const scene of scenes2) {
        const value = elo(scene);
        if (value !== null) targets.set(scene.id, linearRating(value));
      }
    }
    return targets;
  }
  function stashRatingChanges(scenes2, mode) {
    const current2 = new Map(scenes2.map((scene) => [scene.id, scene.rating100 ?? null]));
    const changes = /* @__PURE__ */ new Map();
    for (const [id, rating] of stashRatingTargets(scenes2, mode)) {
      if (current2.get(id) !== rating) changes.set(id, rating);
    }
    return changes;
  }
  function startingElo(scene, start) {
    if (start === "fresh") return { elo: ELO_START, battles: 0, seeded: false };
    return scene.rating100 != null ? { elo: seed(scene.rating100), battles: 0, seeded: true } : null;
  }
  function withEloFields(customFields, value) {
    const fields = { ...customFields };
    for (const key of ELO_FIELD_KEYS) delete fields[key];
    if (value) Object.assign(fields, eloCustomFields(value));
    return fields;
  }
  function eloFields(scene) {
    const value = elo(scene);
    if (value === null) return null;
    const record = sceneRecord(scene);
    return { elo: value, battles: battles(scene), seeded: isSeeded(scene), ...record ? { record } : {} };
  }
  function afterSetup(scene, start) {
    return { ...scene, custom_fields: withEloFields(scene.custom_fields, startingElo(scene, start)) };
  }
  function compareByElo(a, b) {
    const eloA = elo(a);
    const eloB = elo(b);
    if (eloA === null) return eloB === null ? 0 : 1;
    if (eloB === null) return -1;
    return eloB - eloA;
  }
  function sortByElo(scenes2) {
    return scenes2.sort(compareByElo);
  }
  function eloInsertionIndex(pool, eloValue) {
    const idx = pool.findIndex((s) => {
      const other = elo(s);
      return other === null || other < eloValue;
    });
    return idx === -1 ? pool.length : idx;
  }
  function swissOpponentIndexes(pool, eloValue, excludeId, window2, minCount) {
    const others = pool.map((scene, idx) => ({ idx, gap: Math.abs(effectiveElo(scene) - eloValue), id: scene.id })).filter((s) => s.id !== excludeId);
    const inWindow = others.filter((s) => s.gap <= window2);
    if (inWindow.length >= minCount || inWindow.length === others.length) return inWindow.map((s) => s.idx);
    const byGap = [...others].sort((a, b) => a.gap - b.gap);
    const cutoff = byGap[Math.min(minCount, byGap.length) - 1].gap;
    return byGap.filter((s) => s.gap <= cutoff).map((s) => s.idx).sort((a, b) => a - b);
  }
  function placementElo(aboveElo, belowElo) {
    if (aboveElo === null && belowElo === null) return ELO_START;
    if (aboveElo === null) return roundElo(belowElo + PLACEMENT_EDGE_GAP);
    if (belowElo === null) return roundElo(aboveElo - PLACEMENT_EDGE_GAP);
    const mid = roundElo((aboveElo + belowElo) / 2);
    return mid > belowElo ? mid : aboveElo;
  }

  // src/graphql.ts
  async function graphqlQuery(query, variables = {}) {
    const response = await fetch("/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query, variables })
    });
    const result = await response.json();
    if (result.errors) {
      console.error("[Stash Battle] GraphQL error:", result.errors);
      throw new Error(result.errors[0].message);
    }
    return result.data;
  }
  var SCENE_FRAGMENT = `
    id
    title
    date
    rating100
    play_count
    custom_fields
    paths {
      screenshot
      preview
    }
    files {
      duration
      path
    }
    studio {
      name
    }
    performers {
      name
    }
    tags {
      name
    }
  `;
  var FIND_SCENES_QUERY = `
      query FindScenesByRating($filter: FindFilterType, $scene_filter: SceneFilterType) {
        findScenes(filter: $filter, scene_filter: $scene_filter) {
          count
          scenes {
            ${SCENE_FRAGMENT}
          }
        }
      }
    `;
  var customFieldsSupport = null;
  function sceneCustomFieldsSupported() {
    customFieldsSupport ?? (customFieldsSupport = graphqlQuery(
      `query { __type(name: "Scene") { fields { name } } }`
    ).then((data) => data.__type?.fields.some((f) => f.name === "custom_fields") ?? true).catch((e) => {
      console.warn("[Stash Battle] Could not check for scene custom fields:", e);
      return true;
    }));
    return customFieldsSupport;
  }
  function stashApolloCache() {
    try {
      return window.PluginApi?.utils?.StashService?.getClient?.()?.cache;
    } catch {
      return void 0;
    }
  }
  var holdListRefresh = false;
  var listsStale = false;
  function dropStashLists(cache = stashApolloCache()) {
    listsStale = false;
    if (!cache) return;
    try {
      cache.evict({ id: "ROOT_QUERY", fieldName: "findScenes" });
      cache.gc();
    } catch (e) {
      console.warn("[Stash Battle] Could not refresh Stash's scene lists:", e);
    }
  }
  function holdStashListRefresh(hold) {
    holdListRefresh = hold;
    if (!hold && listsStale) dropStashLists();
  }
  function refreshStashCache(updates, ratingsChanged) {
    const cache = stashApolloCache();
    if (!cache) return;
    try {
      for (const update of updates) {
        const id = cache.identify({ __typename: "Scene", id: update.id });
        if (!id) continue;
        const fields = {};
        if (update.rating100 !== void 0) fields.rating100 = () => update.rating100;
        if (update.elo !== void 0) {
          const value = update.elo;
          fields.custom_fields = (existing) => withEloFields(existing, value);
        }
        cache.modify({ id, fields });
      }
    } catch (e) {
      console.warn("[Stash Battle] Could not update Stash's page cache:", e);
    }
    if (ratingsChanged) {
      listsStale = true;
      if (!holdListRefresh) dropStashLists(cache);
    }
  }
  function getSceneIdFromUrl() {
    const match = window.location.pathname.match(/^\/scenes\/(\d+)$/);
    return match ? match[1] : null;
  }
  async function fetchSceneById(sceneId) {
    const query = `
      query FindScene($id: ID!) {
        findScene(id: $id) {
          ${SCENE_FRAGMENT}
        }
      }
    `;
    const result = await graphqlQuery(query, { id: sceneId });
    return result.findScene;
  }

  // src/ui/deleteDialog.ts
  var OPEN_EVENT = "stash-battle:open-delete-dialog";
  var CLOSE_EVENT = "stash-battle:close-delete-dialog";
  var bridgeRegistered = false;
  var pendingResult = null;
  var DeleteScenesDialog = null;
  var dialogLoaded = Promise.resolve();
  function settle(deleted) {
    const resolve = pendingResult;
    pendingResult = null;
    resolve?.(deleted);
  }
  function isStashDeleteDialogAvailable() {
    return bridgeRegistered;
  }
  function isDeleteDialogOpen() {
    return pendingResult !== null;
  }
  function cancelDeleteDialog() {
    if (!pendingResult) return;
    window.dispatchEvent(new CustomEvent(CLOSE_EVENT));
    settle(false);
  }
  function registerDeleteDialogBridge() {
    const api = window.PluginApi;
    if (bridgeRegistered || !api?.loadableComponents?.DeleteScenesDialog) {
      if (!api?.loadableComponents?.DeleteScenesDialog) {
        console.warn("[Stash Battle] Stash's delete dialog isn't available to plugins; Clean mode is disabled");
      }
      return;
    }
    bridgeRegistered = true;
    const { React } = api;
    dialogLoaded = api.loadableComponents.DeleteScenesDialog().then((mod) => {
      DeleteScenesDialog = mod.DeleteScenesDialog ?? mod.default ?? null;
    }).catch((e) => console.error("[Stash Battle] Failed to load Stash's delete dialog:", e));
    function DeleteBridge() {
      const [scene, setScene] = React.useState(null);
      React.useEffect(() => {
        const open = (e) => {
          e.stopImmediatePropagation();
          e.preventDefault();
          setScene(e.detail);
        };
        const close = () => setScene(null);
        window.addEventListener(OPEN_EVENT, open);
        window.addEventListener(CLOSE_EVENT, close);
        return () => {
          window.removeEventListener(OPEN_EVENT, open);
          window.removeEventListener(CLOSE_EVENT, close);
        };
      }, []);
      if (!scene || !DeleteScenesDialog) return null;
      return React.createElement(DeleteScenesDialog, {
        selected: [scene],
        onClose: (deleted) => {
          setScene(null);
          settle(deleted);
        }
      });
    }
    api.patch.after(
      "MainNavBar.UtilityItems",
      (...args) => React.createElement(
        React.Fragment,
        null,
        args[args.length - 1],
        React.createElement(DeleteBridge)
      )
    );
  }
  async function confirmDeleteScene(scene) {
    if (!bridgeRegistered) return false;
    cancelDeleteDialog();
    await dialogLoaded;
    if (!DeleteScenesDialog) return false;
    const { findScene } = await graphqlQuery(
      `query BattleDeletableScene($id: ID!) { findScene(id: $id) { id title interactive files { path } } }`,
      { id: scene.id }
    );
    if (!findScene) return false;
    const result = new Promise((resolve) => {
      pendingResult = resolve;
    });
    if (!requestDialog(findScene)) {
      console.warn("[Stash Battle] Stash's delete dialog bridge isn't mounted");
      settle(false);
      window.alert("Couldn't open Stash's delete dialog. Reload the page and try again.");
    }
    return result;
  }
  function requestDialog(scene) {
    const request = new CustomEvent(OPEN_EVENT, { detail: scene, cancelable: true });
    return !window.dispatchEvent(request);
  }

  // src/filters.ts
  function scenesListQuery() {
    const path = window.location.pathname;
    return path === "/scenes" || path.startsWith("/scenes/") ? window.location.search : "";
  }
  function getSearchParams() {
    return new URLSearchParams(scenesListQuery());
  }
  function getFindFilter(overrides = {}, searchParams = getSearchParams()) {
    const filter = {
      per_page: overrides.per_page ?? -1,
      sort: overrides.sort ?? (searchParams.get("sortby") || "rating"),
      direction: overrides.direction ?? (searchParams.get("sortdir")?.toUpperCase() || "DESC"),
      ...overrides
    };
    const query = searchParams.get("q");
    if (query) {
      filter.q = query;
    }
    return filter;
  }
  function translateJSON(jsonString, decoding) {
    let inString = false;
    let escape = false;
    return [...jsonString].map((c) => {
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
    }).join("");
  }
  var CRITERION_CATEGORIES = {
    // Boolean: no modifier, value is "true"/"false" string -> convert to boolean
    boolean: /* @__PURE__ */ new Set(["organized", "interactive", "performer_favorite"]),
    // StringEnum: URL has modifier but GraphQL just expects the string value directly
    stringEnum: /* @__PURE__ */ new Set(["is_missing", "has_markers"]),
    // Multi: value is array of {id, label} -> extract IDs only
    multi: /* @__PURE__ */ new Set(["performers", "groups", "movies", "galleries"]),
    // HierarchicalMulti: value has {items, excluded, depth} -> rename to {value, excludes, depth} and extract IDs
    hierarchicalMulti: /* @__PURE__ */ new Set(["tags", "studios", "performer_tags"])
  };
  var RESOLUTION_MAP = {
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
    Huge: "HUGE"
  };
  var ORIENTATION_MAP = {
    Landscape: "LANDSCAPE",
    Portrait: "PORTRAIT",
    Square: "SQUARE"
  };
  var idOf = (v) => typeof v === "object" && v && v.id ? v.id : v;
  function getSceneFilter(searchParams = getSearchParams()) {
    const sceneFilter = {};
    if (!searchParams.has("c")) return null;
    for (const cStr of searchParams.getAll("c")) {
      try {
        const decoded = translateJSON(cStr, true);
        const cObj = JSON.parse(decoded);
        const filterType = cObj.type;
        if (!filterType) {
          console.warn("[Stash Battle] Filter missing type:", cObj);
          continue;
        }
        const { type: _type, ...rest } = cObj;
        if (CRITERION_CATEGORIES.boolean.has(filterType)) {
          sceneFilter[filterType] = rest.value === "true" || rest.value === true;
          continue;
        }
        if (CRITERION_CATEGORIES.stringEnum.has(filterType)) {
          sceneFilter[filterType] = rest.value;
          continue;
        }
        if (CRITERION_CATEGORIES.multi.has(filterType)) {
          const result = { modifier: rest.modifier };
          const val = rest.value || {};
          if (val.items !== void 0) {
            const items = val.items || [];
            const excluded = val.excluded || [];
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
        if (CRITERION_CATEGORIES.hierarchicalMulti.has(filterType)) {
          const val = rest.value || {};
          const items = val.items || [];
          const excluded = val.excluded || [];
          sceneFilter[filterType] = {
            modifier: rest.modifier,
            value: items.map(idOf),
            excludes: excluded.map(idOf),
            depth: val.depth ?? 0
          };
          continue;
        }
        if (filterType === "resolution") {
          sceneFilter[filterType] = {
            modifier: rest.modifier,
            value: RESOLUTION_MAP[rest.value] || rest.value
          };
          continue;
        }
        if (filterType === "orientation") {
          const values = Array.isArray(rest.value) ? rest.value : [rest.value];
          sceneFilter[filterType] = {
            value: values.map((v) => ORIENTATION_MAP[v] || v).filter(Boolean)
          };
          continue;
        }
        if (filterType === "duplicated") {
          sceneFilter[filterType] = {
            duplicated: rest.value === "true" || rest.value === true
          };
          continue;
        }
        if (rest.value && typeof rest.value === "object" && !Array.isArray(rest.value) && "value" in rest.value) {
          sceneFilter[filterType] = {
            modifier: rest.modifier,
            value: rest.value.value,
            ...rest.value.value2 !== void 0 && { value2: rest.value.value2 }
          };
        } else if (rest.modifier === "IS_NULL" || rest.modifier === "NOT_NULL") {
          sceneFilter[filterType] = {
            modifier: rest.modifier,
            value: 0
          };
        } else {
          sceneFilter[filterType] = rest;
        }
      } catch (e) {
        console.error("[Stash Battle] Failed to parse filter:", cStr, e);
      }
    }
    return Object.keys(sceneFilter).length > 0 ? sceneFilter : null;
  }
  function readFilters() {
    const searchParams = getSearchParams();
    const sceneFilter = getSceneFilter(searchParams);
    const q = searchParams.get("q") || "";
    return {
      filterKey: JSON.stringify({ q, filter: sceneFilter || {} }),
      sceneFilter,
      filterActive: Boolean(sceneFilter || searchParams.has("c") || searchParams.get("q"))
    };
  }

  // src/stats.ts
  function ratedElos(scenes2) {
    return scenes2.map((scene) => ({ scene, elo: elo(scene) })).filter((s) => s.elo !== null);
  }
  function overview(scenes2) {
    const rated = ratedElos(scenes2);
    return {
      rated: rated.length,
      unrated: scenes2.length - rated.length,
      provisional: scenes2.filter(isProvisional).length,
      battles: rated.reduce((sum, s) => sum + battles(s.scene), 0)
    };
  }
  function eloHistogram(scenes2, size = 25) {
    const rated = ratedElos(scenes2);
    if (rated.length === 0) return [];
    const bucketOf = (value) => Math.floor(value / size) * size;
    const counts = /* @__PURE__ */ new Map();
    for (const { elo: value } of rated) counts.set(bucketOf(value), (counts.get(bucketOf(value)) ?? 0) + 1);
    const lowest = Math.min(...counts.keys());
    const highest = Math.max(...counts.keys());
    const buckets = [];
    for (let from = lowest; from <= highest; from += size) buckets.push({ from, count: counts.get(from) ?? 0 });
    return buckets;
  }
  function largestTie(scenes2) {
    const counts = /* @__PURE__ */ new Map();
    for (const { elo: value } of ratedElos(scenes2)) counts.set(value, (counts.get(value) ?? 0) + 1);
    let best = null;
    for (const [value, count] of counts) {
      if (count >= 2 && (!best || count > best.count || count === best.count && value > best.elo)) {
        best = { elo: value, count };
      }
    }
    return best;
  }
  function ratingScaleTicks(scenes2, mode, marks = [1, 25, 50, 75, 100]) {
    if (mode === "linear") return marks.map((rating) => ({ elo: seed(rating), rating }));
    if (mode !== "percentile") return [];
    const ratings = percentileRatings(scenes2);
    const rated = ratedElos(scenes2).filter((s) => ratings.has(s.scene.id));
    if (rated.length === 0) return [];
    const ticks = [];
    for (const rating of marks) {
      let nearest = rated[0];
      for (const s of rated) {
        const gap = Math.abs(ratings.get(s.scene.id) - rating);
        const nearestGap = Math.abs(ratings.get(nearest.scene.id) - rating);
        if (gap < nearestGap) nearest = s;
      }
      if (!ticks.some((t) => t.elo === nearest.elo)) ticks.push({ elo: nearest.elo, rating });
    }
    return ticks;
  }
  function median(values) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
  function gemsSplit(scenes2) {
    const rated = ratedElos(scenes2);
    if (rated.length === 0) return null;
    return { elo: median(rated.map((s) => s.elo)), plays: median(rated.map((s) => s.scene.play_count ?? 0)) };
  }
  function settledBuckets(scenes2) {
    const limits = ELO_K_TIERS.map(([below]) => below).filter(Number.isFinite);
    const edges = [0, 1, ...limits];
    const buckets = edges.map((min, i) => ({
      min,
      max: i + 1 < edges.length ? edges[i + 1] - 1 : null,
      count: 0
    }));
    for (const { scene } of ratedElos(scenes2)) {
      const n = battles(scene);
      const bucket = [...buckets].reverse().find((b) => n >= b.min);
      if (bucket) bucket.count++;
    }
    return buckets;
  }
  function leastTested(pool, excludeId, random = Math.random) {
    const candidates = pool.length > 1 ? pool.filter((s) => s.id !== excludeId) : pool;
    if (candidates.length === 0) return null;
    const fewest = Math.min(...candidates.map(battles));
    const tied = candidates.filter((s) => battles(s) === fewest);
    return tied[Math.min(tied.length - 1, Math.floor(random() * tied.length))];
  }
  function tierMap(scenes2) {
    const settled = scenes2.filter((scene) => !isProvisional(scene)).map((scene) => ({ id: scene.id, elo: elo(scene) })).filter((s) => s.elo !== null).sort((a, b) => b.elo - a.elo);
    const tiers = /* @__PURE__ */ new Map();
    const n = settled.length;
    let start = 0;
    while (start < n) {
      let end = start;
      while (end + 1 < n && settled[end + 1].elo === settled[start].elo) end++;
      const above = (start + end) / 2 / n;
      const tier = TIERS.find((t) => above < t.top) ?? TIERS[TIERS.length - 1];
      for (let i = start; i <= end; i++) tiers.set(settled[i].id, tier);
      start = end + 1;
    }
    return tiers;
  }
  var tierCache = null;
  function cachedTierMap(scenes2) {
    const key = scenes2.map((s) => `${elo(s) ?? ""}/${battles(s)}`).join(",");
    if (tierCache?.scenes !== scenes2 || tierCache.key !== key) tierCache = { scenes: scenes2, key, tiers: tierMap(scenes2) };
    return tierCache.tiers;
  }
  function tierDescription(tier) {
    const index = TIERS.findIndex((t) => t.id === tier.id);
    const percent = (share) => `${Math.round(share * 100)}%`;
    const where = index === TIERS.length - 1 && index > 0 ? `below the top ${percent(TIERS[index - 1].top)}` : `in the top ${percent(tier.top)}`;
    return `${tier.name}: ${where} of your scenes with a settled ELO`;
  }
  function topByRecord(scenes2, key, n) {
    return scenes2.map((scene) => ({ scene, record: sceneRecord(scene) })).filter((s) => s.record !== null && key(s.record) > 0).sort((a, b) => key(b.record) - key(a.record)).slice(0, n);
  }
  function leastTestedPool(scenes2) {
    if (scenes2.length === 0) return null;
    const fewest = Math.min(...scenes2.map(battles));
    const pool = scenes2.filter((s) => battles(s) === fewest);
    return { battles: fewest, count: pool.length, unrated: pool.filter((s) => elo(s) === null).length };
  }

  // src/explore.ts
  var DEFAULT_EXPLORE_FILTERS = {
    query: "",
    group: null,
    eloMin: null,
    eloMax: null,
    sort: "elo-desc"
  };
  function exploreEntries(scenes2, tiers, title) {
    return scenes2.map((scene, index) => ({
      scene,
      rank: elo(scene) === null ? null : index + 1,
      tier: tiers.get(scene.id) ?? null,
      text: [title(scene), scene.studio?.name ?? "", ...(scene.performers ?? []).map((p) => p.name)].join(" ").toLowerCase()
    }));
  }
  function inGroup(entry, group) {
    if (group === null) return true;
    if (group === "unrated") return elo(entry.scene) === null;
    if (group === "provisional") return isProvisional(entry.scene);
    return entry.tier?.id === group;
  }
  function filterExplore(entries2, filters2) {
    const words = filters2.query.toLowerCase().split(/\s+/).filter(Boolean);
    const ranged = filters2.eloMin !== null || filters2.eloMax !== null;
    const matches = entries2.filter((entry) => {
      if (!inGroup(entry, filters2.group)) return false;
      if (words.some((word) => !entry.text.includes(word))) return false;
      if (ranged) {
        const value = elo(entry.scene);
        if (value === null) return false;
        if (filters2.eloMin !== null && value < filters2.eloMin) return false;
        if (filters2.eloMax !== null && value > filters2.eloMax) return false;
      }
      return true;
    });
    return sortExplore(matches, filters2.sort);
  }
  function byRecord(a, b, ...keys) {
    const ra = sceneRecord(a.scene);
    const rb = sceneRecord(b.scene);
    if (!ra || !rb) return (ra ? 0 : 1) - (rb ? 0 : 1);
    for (const key of keys) {
      const diff = key(rb) - key(ra);
      if (diff) return diff;
    }
    return 0;
  }
  function sortExplore(entries2, sort) {
    const byRank = (a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity);
    const plays = (e) => e.scene.play_count ?? 0;
    const compare = {
      "elo-desc": byRank,
      "elo-asc": (a, b) => a.rank === null || b.rank === null ? byRank(a, b) : b.rank - a.rank,
      "plays-desc": (a, b) => plays(b) - plays(a) || byRank(a, b),
      "plays-asc": (a, b) => plays(a) - plays(b) || byRank(a, b),
      "battles-desc": (a, b) => battles(b.scene) - battles(a.scene) || byRank(a, b),
      "battles-asc": (a, b) => battles(a.scene) - battles(b.scene) || byRank(a, b),
      // Record sorts put scenes without a record last
      "record-desc": (a, b) => byRecord(a, b, (r) => r.wins - r.losses, (r) => r.wins) || byRank(a, b),
      "peak-desc": (a, b) => byRecord(a, b, (r) => r.peak) || byRank(a, b),
      "streak-desc": (a, b) => byRecord(a, b, (r) => r.bestStreak) || byRank(a, b)
    };
    return [...entries2].sort(compare[sort]);
  }
  function filterBattlesWithin(filters2, bothSides) {
    return bothSides && filters2.group !== "unrated";
  }
  function explorePoolScenes(scenes2, filters2, title) {
    const text = filters2.query.trim() ? title : () => "";
    return filterExplore(exploreEntries(scenes2, cachedTierMap(scenes2), text), { ...filters2, sort: "elo-desc" }).map((e) => e.scene);
  }

  // src/state.ts
  function oneScenePool(sceneId) {
    return { filters: { ...DEFAULT_EXPLORE_FILTERS }, label: "", sceneId };
  }
  function explorePoolWithin() {
    const pool = state.explorePool;
    return pool !== null && !pool.sceneId && filterBattlesWithin(pool.filters, state.settings.filterOpponents);
  }
  var state = {
    currentPair: { left: null, right: null },
    currentRanks: { left: null, right: null },
    currentMode: "swiss",
    championScene: null,
    championWins: 0,
    championDefeated: [],
    placement: null,
    totalScenesCount: 0,
    leftPoolSize: null,
    disableChoice: false,
    savedFilterParams: "",
    settings: { ...DEFAULT_SETTINGS },
    resettingElo: false,
    leastTested: false,
    explorePool: null,
    shuffledFilteredScenes: [],
    shuffleIndex: 0,
    shuffleFilterKey: null,
    memoryCache: {
      allScenes: null,
      filteredScenes: null,
      filterKey: null,
      timestamp: null
    }
  };
  function resetRunState() {
    state.championScene = null;
    state.championWins = 0;
    state.championDefeated = [];
    state.placement = null;
  }
  function resetShuffle() {
    state.shuffledFilteredScenes = [];
    state.shuffleIndex = 0;
    state.shuffleFilterKey = null;
  }
  function isRunActive() {
    switch (state.currentMode) {
      case "champion":
        return state.championScene !== null;
      case "placement":
        return (state.placement?.battles ?? 0) > 0;
      default:
        return false;
    }
  }
  function isEloSetupPending() {
    return !state.settings.eloSetupAt || state.resettingElo;
  }

  // src/cache.ts
  function openCacheDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(CACHE_DB_NAME, CACHE_DB_VERSION);
      request.onerror = () => {
        console.error("[Stash Battle] IndexedDB error:", request.error);
        reject(request.error);
      };
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (db.objectStoreNames.contains(CACHE_STORE_NAME)) db.deleteObjectStore(CACHE_STORE_NAME);
        db.createObjectStore(CACHE_STORE_NAME, { keyPath: "cacheKey" });
      };
    });
  }
  async function getCachedScenes(cacheKey) {
    try {
      const db = await openCacheDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(CACHE_STORE_NAME, "readonly");
        const store = transaction.objectStore(CACHE_STORE_NAME);
        const request = store.get(cacheKey);
        request.onsuccess = () => {
          const result = request.result;
          if (result && Date.now() - result.timestamp < CACHE_MAX_AGE_MS) {
            resolve(result);
          } else {
            resolve(null);
          }
        };
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => db.close();
      });
    } catch (e) {
      console.error("[Stash Battle] Cache read error:", e);
      return null;
    }
  }
  async function setCachedScenes(cacheKey, scenes2, count, filterKey, timestamp = Date.now()) {
    try {
      const db = await openCacheDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(CACHE_STORE_NAME, "readwrite");
        const store = transaction.objectStore(CACHE_STORE_NAME);
        const data = {
          cacheKey,
          scenes: scenes2,
          count,
          timestamp,
          ...filterKey !== void 0 && { filterKey }
        };
        const request = store.put(data);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => db.close();
      });
    } catch (e) {
      console.error("[Stash Battle] Cache write error:", e);
    }
  }
  async function clearSceneCache() {
    try {
      console.log("[Stash Battle] 🗑️ Clearing all scene caches...");
      const db = await openCacheDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(CACHE_STORE_NAME, "readwrite");
        const store = transaction.objectStore(CACHE_STORE_NAME);
        const request = store.clear();
        request.onsuccess = () => {
          state.memoryCache = { allScenes: null, filteredScenes: null, filterKey: null, timestamp: null };
          console.log("[Stash Battle] ✅ All caches cleared (memory + IndexedDB)");
          resolve();
        };
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => db.close();
      });
    } catch (e) {
      console.error("[Stash Battle] ❌ Cache clear error:", e);
    }
  }
  async function clearFilteredCache() {
    try {
      const db = await openCacheDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(CACHE_STORE_NAME, "readwrite");
        const store = transaction.objectStore(CACHE_STORE_NAME);
        const request = store.delete("filtered-scenes");
        request.onsuccess = () => {
          state.memoryCache.filteredScenes = null;
          state.memoryCache.filterKey = null;
          console.log("[Stash Battle] 🗑️ Filtered cache cleared (memory + IndexedDB)");
          resolve();
        };
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => db.close();
      });
    } catch (e) {
      console.error("[Stash Battle] ❌ Filtered cache clear error:", e);
      state.memoryCache.filteredScenes = null;
      state.memoryCache.filterKey = null;
    }
  }
  async function backgroundRefreshAllScenes() {
    const cacheKey = "all-scenes";
    try {
      console.log("[Stash Battle] 🔄 Background refresh started (all scenes)...");
      const startTime = Date.now();
      const result = await graphqlQuery(FIND_SCENES_QUERY, {
        filter: {
          per_page: -1,
          sort: "rating",
          direction: "DESC"
        },
        scene_filter: null
      });
      const scenes2 = sortByElo(result.findScenes.scenes || []);
      const count = result.findScenes.count || scenes2.length;
      const fetchTime = Date.now() - startTime;
      const oldCount = state.memoryCache.allScenes ? state.memoryCache.allScenes.length : 0;
      if (count !== oldCount) {
        console.log(
          `[Stash Battle] 📊 Scene count changed: ${oldCount} → ${count} (${count > oldCount ? "+" : ""}${count - oldCount})`
        );
      } else {
        console.log(`[Stash Battle] 📊 Scene count unchanged: ${count}`);
      }
      state.memoryCache.allScenes = scenes2;
      state.memoryCache.timestamp = Date.now();
      await setCachedScenes(cacheKey, scenes2, count);
      console.log(`[Stash Battle] ✅ Background refresh complete: ${scenes2.length} scenes in ${fetchTime}ms`);
    } catch (e) {
      console.error("[Stash Battle] ❌ Background refresh failed:", e);
    }
  }
  async function getAllScenesCached() {
    const cacheKey = "all-scenes";
    if (state.memoryCache.allScenes) {
      const cacheAge = Math.round((Date.now() - (state.memoryCache.timestamp ?? 0)) / 1e3);
      const isStale = Date.now() - (state.memoryCache.timestamp ?? 0) >= CACHE_MAX_AGE_MS;
      console.log(
        `[Stash Battle] 💾 Memory cache hit (all scenes): ${state.memoryCache.allScenes.length} scenes, age: ${cacheAge}s${isStale ? " [STALE]" : ""}`
      );
      if (isStale) {
        console.log(`[Stash Battle] ⏰ Cache stale (>${CACHE_MAX_AGE_MS / 1e3}s), triggering background refresh...`);
        backgroundRefreshAllScenes();
      }
      return { scenes: state.memoryCache.allScenes, count: state.memoryCache.allScenes.length };
    }
    console.log("[Stash Battle] 🔍 Memory cache miss, checking IndexedDB...");
    const cached = await getCachedScenes(cacheKey);
    if (cached) {
      const cacheAge = Math.round((Date.now() - cached.timestamp) / 1e3);
      const isStale = Date.now() - cached.timestamp >= CACHE_MAX_AGE_MS;
      console.log(
        `[Stash Battle] 💿 IndexedDB cache hit (all scenes): ${cached.scenes.length} scenes, age: ${cacheAge}s${isStale ? " [STALE]" : ""}`
      );
      state.memoryCache.allScenes = cached.scenes;
      state.memoryCache.timestamp = cached.timestamp;
      if (isStale) {
        console.log(`[Stash Battle] ⏰ Cache stale (>${CACHE_MAX_AGE_MS / 1e3}s), triggering background refresh...`);
        backgroundRefreshAllScenes();
      }
      return { scenes: cached.scenes, count: cached.count };
    }
    console.log("[Stash Battle] 🌐 No cache found, fetching all scenes from network (first load)...");
    const startTime = Date.now();
    const result = await graphqlQuery(FIND_SCENES_QUERY, {
      filter: {
        per_page: -1,
        sort: "rating",
        direction: "DESC"
      },
      scene_filter: null
    });
    const scenes2 = sortByElo(result.findScenes.scenes || []);
    const count = result.findScenes.count || scenes2.length;
    const fetchTime = Date.now() - startTime;
    state.memoryCache.allScenes = scenes2;
    state.memoryCache.timestamp = Date.now();
    await setCachedScenes(cacheKey, scenes2, count);
    console.log(`[Stash Battle] ✅ Fetched and cached ${scenes2.length} scenes in ${fetchTime}ms`);
    return { scenes: scenes2, count };
  }
  async function backgroundRefreshFilteredScenes(filters2) {
    const cacheKey = "filtered-scenes";
    try {
      console.log("[Stash Battle] 🔄 Background refresh started (filtered scenes)...");
      const startTime = Date.now();
      const result = await graphqlQuery(FIND_SCENES_QUERY, {
        filter: getFindFilter({
          per_page: -1,
          sort: "rating",
          direction: "DESC"
        }),
        scene_filter: filters2.sceneFilter
      });
      const scenes2 = sortByElo(result.findScenes.scenes || []);
      const count = result.findScenes.count || scenes2.length;
      const fetchTime = Date.now() - startTime;
      if (state.memoryCache.filterKey === filters2.filterKey) {
        const oldCount = state.memoryCache.filteredScenes ? state.memoryCache.filteredScenes.length : 0;
        if (count !== oldCount) {
          console.log(
            `[Stash Battle] 📊 Filtered count changed: ${oldCount} → ${count} (${count > oldCount ? "+" : ""}${count - oldCount})`
          );
        } else {
          console.log(`[Stash Battle] 📊 Filtered count unchanged: ${count}`);
        }
        state.memoryCache.filteredScenes = scenes2;
        state.memoryCache.timestamp = Date.now();
        await setCachedScenes(cacheKey, scenes2, count, filters2.filterKey);
        console.log(`[Stash Battle] ✅ Background refresh complete: ${scenes2.length} filtered scenes in ${fetchTime}ms`);
      } else {
        console.log("[Stash Battle] ⚠️ Filter changed during refresh, discarding results");
      }
    } catch (e) {
      console.error("[Stash Battle] ❌ Background refresh (filtered) failed:", e);
    }
  }
  async function getFilteredScenesCached(filters2) {
    const { filterKey, sceneFilter } = filters2;
    const cacheKey = "filtered-scenes";
    console.log("[Stash Battle] 🔎 Filter active, checking filtered cache...");
    if (state.memoryCache.filteredScenes && state.memoryCache.filterKey === filterKey) {
      const cacheAge = Math.round((Date.now() - (state.memoryCache.timestamp ?? 0)) / 1e3);
      const isStale = Date.now() - (state.memoryCache.timestamp ?? 0) >= CACHE_MAX_AGE_MS;
      console.log(
        `[Stash Battle] 💾 Memory cache hit (filtered): ${state.memoryCache.filteredScenes.length} scenes, age: ${cacheAge}s${isStale ? " [STALE]" : ""}`
      );
      if (isStale) {
        console.log(`[Stash Battle] ⏰ Cache stale (>${CACHE_MAX_AGE_MS / 1e3}s), triggering background refresh...`);
        backgroundRefreshFilteredScenes(filters2);
      }
      return { scenes: state.memoryCache.filteredScenes, count: state.memoryCache.filteredScenes.length };
    }
    console.log("[Stash Battle] 🔍 Memory cache miss (filtered), checking IndexedDB...");
    const cached = await getCachedScenes(cacheKey);
    if (cached && cached.filterKey === filterKey) {
      const cacheAge = Math.round((Date.now() - cached.timestamp) / 1e3);
      const isStale = Date.now() - cached.timestamp >= CACHE_MAX_AGE_MS;
      console.log(
        `[Stash Battle] 💿 IndexedDB cache hit (filtered): ${cached.scenes.length} scenes, age: ${cacheAge}s${isStale ? " [STALE]" : ""}`
      );
      state.memoryCache.filteredScenes = cached.scenes;
      state.memoryCache.filterKey = filterKey;
      state.memoryCache.timestamp = cached.timestamp;
      if (isStale) {
        console.log(`[Stash Battle] ⏰ Cache stale (>${CACHE_MAX_AGE_MS / 1e3}s), triggering background refresh...`);
        backgroundRefreshFilteredScenes(filters2);
      }
      return { scenes: cached.scenes, count: cached.count };
    }
    if (cached) {
      console.log("[Stash Battle] 💿 IndexedDB cache exists but filter changed, fetching new data...");
    } else {
      console.log("[Stash Battle] 💿 IndexedDB cache miss (filtered)");
    }
    console.log("[Stash Battle] 🌐 Fetching filtered scenes from network...");
    const startTime = Date.now();
    const result = await graphqlQuery(FIND_SCENES_QUERY, {
      filter: getFindFilter({
        per_page: -1,
        sort: "rating",
        direction: "DESC"
      }),
      scene_filter: sceneFilter
    });
    const scenes2 = sortByElo(result.findScenes.scenes || []);
    const count = result.findScenes.count || scenes2.length;
    const fetchTime = Date.now() - startTime;
    state.memoryCache.filteredScenes = scenes2;
    state.memoryCache.filterKey = filterKey;
    state.memoryCache.timestamp = Date.now();
    await setCachedScenes(cacheKey, scenes2, count, filterKey);
    console.log(`[Stash Battle] ✅ Fetched and cached ${scenes2.length} filtered scenes in ${fetchTime}ms`);
    return { scenes: scenes2, count };
  }
  function applyElo(scene, value) {
    scene.custom_fields = withEloFields(scene.custom_fields, value);
  }
  function latestScene(scene) {
    return state.memoryCache.allScenes?.find((s) => s.id === scene.id) ?? state.memoryCache.filteredScenes?.find((s) => s.id === scene.id) ?? scene;
  }
  function setEloInCache(scene, value) {
    applyElo(scene, value);
    for (const pool of [state.memoryCache.allScenes, state.memoryCache.filteredScenes]) {
      const idx = pool ? pool.findIndex((s) => s.id === scene.id) : -1;
      if (!pool || idx === -1) continue;
      const [cached] = pool.splice(idx, 1);
      if (cached !== scene) applyElo(cached, value);
      pool.splice(value ? eloInsertionIndex(pool, value.elo) : pool.length, 0, cached);
    }
    persistCacheSoon();
  }
  function setRatingsInCache(ratings) {
    for (const pool of [state.memoryCache.allScenes, state.memoryCache.filteredScenes]) {
      for (const scene of pool ?? []) {
        const rating = ratings.get(scene.id);
        if (rating !== void 0) scene.rating100 = rating;
      }
    }
    persistCacheSoon();
  }
  function refreshSceneInCache(fresh) {
    for (const pool of [state.memoryCache.allScenes, state.memoryCache.filteredScenes]) {
      const cached = pool?.find((s) => s.id === fresh.id);
      if (cached) cached.rating100 = fresh.rating100 ?? null;
    }
    setEloInCache(fresh, eloFields(fresh));
  }
  var PERSIST_DEBOUNCE_MS = 1e3;
  var persistTimer = null;
  function persistCacheSoon() {
    if (typeof indexedDB === "undefined") return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persistCache();
    }, PERSIST_DEBOUNCE_MS);
  }
  async function persistCache() {
    const lists = [
      ["all-scenes", state.memoryCache.allScenes],
      ["filtered-scenes", state.memoryCache.filteredScenes]
    ];
    for (const [cacheKey, scenes2] of lists) {
      if (!scenes2) continue;
      const cached = await getCachedScenes(cacheKey);
      if (!cached) continue;
      if (cacheKey === "filtered-scenes" && cached.filterKey !== state.memoryCache.filterKey) continue;
      await setCachedScenes(cacheKey, scenes2, scenes2.length, cached.filterKey, cached.timestamp);
    }
  }
  async function removeSceneEverywhere(sceneId) {
    const without = (scenes2) => scenes2 ? scenes2.filter((s) => s.id !== sceneId) : scenes2;
    state.memoryCache.allScenes = without(state.memoryCache.allScenes);
    state.memoryCache.filteredScenes = without(state.memoryCache.filteredScenes);
    const shuffleIdx = state.shuffledFilteredScenes.findIndex((s) => s.id === sceneId);
    if (shuffleIdx !== -1) {
      state.shuffledFilteredScenes.splice(shuffleIdx, 1);
      if (shuffleIdx < state.shuffleIndex) state.shuffleIndex--;
    }
    for (const cacheKey of ["all-scenes", "filtered-scenes"]) {
      const cached = await getCachedScenes(cacheKey);
      if (cached && cached.scenes.some((s) => s.id === sceneId)) {
        const scenes2 = cached.scenes.filter((s) => s.id !== sceneId);
        await setCachedScenes(cacheKey, scenes2, scenes2.length, cached.filterKey, cached.timestamp);
      }
    }
    console.log(`[Stash Battle] 🗑️ Removed scene ${sceneId} from caches`);
  }

  // src/sceneActions.ts
  async function fetchSceneFields(ids) {
    const aliases = ids.map((id, i) => `s${i}: findScene(id: ${JSON.stringify(id)}) { id rating100 custom_fields }`).join("\n");
    const result = await graphqlQuery(`{ ${aliases} }`);
    return new Map(Object.values(result).flatMap((s) => s ? [[s.id, s]] : []));
  }
  function isSceneNotFoundError(error) {
    return error instanceof Error && /not found/i.test(error.message);
  }

  // src/ratingDisplay.ts
  var STAR_STEPS = { full: 1, half: 0.5, quarter: 0.25, tenth: 0.1 };
  var DEFAULT_RATING_SYSTEM = { type: "stars", starStep: 1 };
  var current = DEFAULT_RATING_SYSTEM;
  function parseRatingSystem(ui) {
    const options2 = ui?.ratingSystemOptions;
    return {
      type: options2?.type === "decimal" ? "decimal" : "stars",
      starStep: STAR_STEPS[String(options2?.starPrecision)] ?? 1
    };
  }
  function setRatingSystem(ui) {
    current = parseRatingSystem(ui);
  }
  function getRatingSystem() {
    return current;
  }
  function ratingValue(rating100, system = current) {
    if (system.type === "decimal") return (Math.round(rating100) / 10).toFixed(1);
    const stars = Math.max(system.starStep, Math.round(rating100 / 20 / system.starStep) * system.starStep);
    return String(Number(stars.toFixed(2)));
  }
  function formatRating(rating100, long = false, system = current) {
    const value = ratingValue(rating100, system);
    if (system.type === "decimal") return value;
    return long ? `${value} star${value === "1" ? "" : "s"}` : `${value}★`;
  }
  function ratingStarts(rating100, system = current) {
    if (system.type === "decimal") return `a ${ratingValue(rating100, system)} starts`;
    const text = formatRating(rating100, true, system);
    return `${text} ${text.endsWith("stars") ? "start" : "starts"}`;
  }
  function scaleMarks(system = current) {
    return system.type === "decimal" ? [1, 25, 50, 75, 100] : [1, 40, 60, 80, 100];
  }
  function exampleRating(rating100, system = current) {
    if (system.type === "decimal") return rating100;
    const grid = 20 * system.starStep;
    return Math.max(grid, Math.floor(rating100 / grid) * grid);
  }

  // src/settings.ts
  var CONFIG_QUERY = `{ configuration { plugins } }`;
  var LOAD_QUERY = `{ configuration { plugins ui } }`;
  var CONFIGURE_PLUGIN_MUTATION = `
      mutation ConfigurePlugin($plugin_id: ID!, $input: Map!) {
        configurePlugin(plugin_id: $plugin_id, input: $input)
      }
    `;
  var SAVE_DEBOUNCE_MS = 400;
  var saveTimer = null;
  var legacyFunMode = false;
  var STASH_RATINGS_MODES = ["off", "percentile", "linear"];
  var ELO_STARTS = ["ratings", "fresh"];
  function oneOf(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
  }
  function clampPercent(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : fallback;
  }
  function normalize(raw, base) {
    const bool = (key) => typeof raw[key] === "boolean" ? raw[key] : base[key];
    return {
      // A missing or unknown value is "off". (Removed keys, see REMOVED_KEYS, are dropped.)
      stashRatings: oneOf(raw.stashRatings, STASH_RATINGS_MODES, "off"),
      // Setup flags have no fallback: raw always carries them (stored config, or current + patch)
      eloSetupAt: typeof raw.eloSetupAt === "string" && raw.eloSetupAt ? raw.eloSetupAt : null,
      eloSetupMode: ELO_STARTS.includes(raw.eloSetupMode) ? raw.eloSetupMode : null,
      openInNewTab: bool("openInNewTab"),
      autoplayPreviews: bool("autoplayPreviews"),
      filterOpponents: bool("filterOpponents"),
      cleanMode: bool("cleanMode"),
      pauseMediaOnOpen: bool("pauseMediaOnOpen"),
      placementFromBottom: bool("placementFromBottom"),
      tierBorders: bool("tierBorders"),
      previewVolume: clampPercent(raw.previewVolume ?? base.previewVolume, base.previewVolume),
      explorePageSize: EXPLORE_PAGE_SIZES.includes(Number(raw.explorePageSize)) ? Number(raw.explorePageSize) : base.explorePageSize
    };
  }
  function legacyDefaults() {
    const settings = { ...DEFAULT_SETTINGS };
    try {
      if (localStorage.getItem(LEGACY_FILTER_OPPONENTS_KEY) === "1") settings.filterOpponents = true;
      if (localStorage.getItem(LEGACY_MUTE_PREVIEWS_KEY) === "1") settings.previewVolume = 0;
    } catch {
    }
    return settings;
  }
  async function loadSettings() {
    try {
      const data = await graphqlQuery(LOAD_QUERY);
      setRatingSystem(data.configuration.ui);
      const stored = data.configuration.plugins?.[PLUGIN_ID];
      legacyFunMode = stored?.funMode === true;
      hallOfFame = mergeHallOfFame(parseHallOfFame(stored?.[HALL_OF_FAME_KEY]), []);
      state.settings = stored ? normalize(stored, DEFAULT_SETTINGS) : legacyDefaults();
      return true;
    } catch (e) {
      console.error("[Stash Battle] Failed to load settings, using current values:", e);
      return false;
    }
  }
  function hadFunMode() {
    return legacyFunMode;
  }
  var unsaved = /* @__PURE__ */ new Set();
  async function fetchStoredConfig() {
    const data = await graphqlQuery(
      CONFIG_QUERY
    );
    return data.configuration.plugins?.[PLUGIN_ID];
  }
  var REMOVED_KEYS = ["funMode", "unratedRating", "showTiers"];
  function mergeConfig(stored, current2, unsavedKeys, extra = {}) {
    const merged = stored ? { ...stored, ...normalize(stored, current2) } : { ...current2 };
    for (const key of unsavedKeys) merged[key] = current2[key];
    Object.assign(merged, extra);
    for (const key of REMOVED_KEYS) delete merged[key];
    return Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== null && value !== void 0));
  }
  var configWrites = Promise.resolve();
  function saveConfig(extra = {}) {
    const run = configWrites.then(async () => {
      const keys = [...unsaved];
      unsaved.clear();
      try {
        const stored = await fetchStoredConfig();
        const input = mergeConfig(stored, state.settings, keys, typeof extra === "function" ? extra(stored) : extra);
        await graphqlQuery(CONFIGURE_PLUGIN_MUTATION, { plugin_id: PLUGIN_ID, input });
        return true;
      } catch (e) {
        console.error("[Stash Battle] Failed to save settings:", e);
        for (const key of keys) unsaved.add(key);
        return false;
      }
    });
    configWrites = run;
    return run;
  }
  function persistSettings() {
    return saveConfig();
  }
  var HALL_OF_FAME_KEY = "statsHallOfFame";
  var hallOfFame = [];
  function parseHallOfFame(value) {
    if (typeof value !== "string" || !value) return [];
    try {
      const list = JSON.parse(value);
      if (!Array.isArray(list)) return [];
      return list.filter(
        (e) => typeof e?.id === "string" && typeof e?.date === "string" && !Number.isNaN(Date.parse(e.date))
      );
    } catch {
      return [];
    }
  }
  function mergeHallOfFame(a, b) {
    const earliest = /* @__PURE__ */ new Map();
    for (const entry of [...a, ...b]) {
      const known = earliest.get(entry.id);
      if (!known || Date.parse(entry.date) < Date.parse(known.date)) earliest.set(entry.id, entry);
    }
    return [...earliest.values()].sort((x, y) => Date.parse(x.date) - Date.parse(y.date));
  }
  function getHallOfFame() {
    return hallOfFame;
  }
  async function addToHallOfFame(sceneId, date = (/* @__PURE__ */ new Date()).toISOString()) {
    if (hallOfFame.some((e) => e.id === sceneId)) return;
    hallOfFame = mergeHallOfFame(hallOfFame, [{ id: sceneId, date }]);
    await saveConfig((stored) => {
      hallOfFame = mergeHallOfFame(parseHallOfFame(stored?.[HALL_OF_FAME_KEY]), hallOfFame);
      return { [HALL_OF_FAME_KEY]: JSON.stringify(hallOfFame) };
    });
  }
  async function keepOnlyHallOfFame(keepIds) {
    const keep = new Set(keepIds);
    if (hallOfFame.every((e) => keep.has(e.id))) return;
    const drop = new Set(hallOfFame.filter((e) => !keep.has(e.id)).map((e) => e.id));
    hallOfFame = hallOfFame.filter((e) => !drop.has(e.id));
    await saveConfig((stored) => {
      hallOfFame = mergeHallOfFame(parseHallOfFame(stored?.[HALL_OF_FAME_KEY]), hallOfFame).filter((e) => !drop.has(e.id));
      return { [HALL_OF_FAME_KEY]: JSON.stringify(hallOfFame) };
    });
  }
  async function clearHallOfFame() {
    hallOfFame = [];
    return saveConfig({ [HALL_OF_FAME_KEY]: null });
  }
  function updateSettings(patch) {
    state.settings = normalize({ ...state.settings, ...patch }, state.settings);
    for (const key of Object.keys(patch)) unsaved.add(key);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void persistSettings();
    }, SAVE_DEBOUNCE_MS);
  }
  async function updateSettingsNow(patch) {
    state.settings = normalize({ ...state.settings, ...patch }, state.settings);
    for (const key of Object.keys(patch)) unsaved.add(key);
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    return persistSettings();
  }

  // src/rating.ts
  var SCENE_MISSING_EVENT = "stash-battle:scene-missing";
  var SCENE_UPDATE_MUTATION = `
      mutation SceneUpdate($input: SceneUpdateInput!) {
        sceneUpdate(input: $input) {
          id
        }
      }
    `;
  function reportWriteError(sceneId, what, e) {
    console.error(`[Stash Battle] Failed to ${what} for scene ${sceneId}:`, e);
    if (isSceneNotFoundError(e)) {
      window.dispatchEvent(new CustomEvent(SCENE_MISSING_EVENT, { detail: sceneId }));
    }
  }
  function sameElo(a, b) {
    if (a === null || b === null) return a === b;
    return JSON.stringify(eloCustomFields(a)) === JSON.stringify(eloCustomFields(b));
  }
  async function saveEloFields(scene, value, customFields, what, rating100) {
    const previous = eloFields(latestScene(scene));
    setEloInCache(scene, value);
    refreshStashCache([{ id: scene.id, elo: value }], false);
    try {
      const input = { id: scene.id, custom_fields: customFields, ...rating100 !== void 0 ? { rating100 } : {} };
      await graphqlQuery(SCENE_UPDATE_MUTATION, { input });
    } catch (e) {
      reportWriteError(scene.id, what, e);
      if (sameElo(eloFields(latestScene(scene)), value)) {
        setEloInCache(scene, previous);
        refreshStashCache([{ id: scene.id, elo: previous }], false);
      }
      return false;
    }
    if (rating100 !== void 0) {
      setRatingsInCache(/* @__PURE__ */ new Map([[scene.id, rating100]]));
      refreshStashCache([{ id: scene.id, rating100 }], true);
    }
    scheduleStashRatingSync();
    return true;
  }
  function writeElo(scene, elo2, battles2, results2) {
    const write = saveElo(scene, elo2, battles2, results2);
    pendingWrites.add(write);
    void write.finally(() => pendingWrites.delete(write));
    return write;
  }
  var pendingWrites = /* @__PURE__ */ new Set();
  async function eloWritesSettled() {
    await Promise.allSettled([...pendingWrites]);
  }
  async function saveElo(scene, elo2, battles2, results2) {
    const current2 = latestScene(scene);
    const record = recordAfter(sceneRecord(current2), results2, elo(current2) ?? elo2, elo2);
    const value = { elo: elo2, battles: battles2, seeded: isSeeded(scene), record };
    if (await saveEloFields(scene, value, { partial: eloCustomFields(value) }, "save ELO")) {
      console.log(`[Stash Battle] 📝 Saved scene ${scene.id} ELO ${elo2} (${battles2} battles)`);
      noteTopScene();
    }
  }
  function noteTopScene() {
    const top = state.memoryCache.allScenes?.[0];
    if (top && isRated(top) && !getHallOfFame().some((e) => e.id === top.id)) void addToHallOfFame(top.id);
  }
  async function restoreElo(scene, value, rating100 = null) {
    const current2 = latestScene(scene);
    if (sameElo(eloFields(current2), value)) return;
    const customFields = value ? { partial: eloCustomFields(value), ...value.record ? {} : { remove: RECORD_FIELD_KEYS } } : { remove: ELO_FIELD_KEYS };
    const ratingBack = value === null && (current2.rating100 ?? null) !== rating100 ? rating100 : void 0;
    if (await saveEloFields(scene, value, customFields, "undo ELO", ratingBack)) {
      console.log(`[Stash Battle] ↶ Restored scene ${scene.id} ELO ${value ? value.elo : "(unrated)"}`);
    }
  }
  async function writeStashRatings(ratings) {
    const idsByRating = /* @__PURE__ */ new Map();
    for (const [id, rating] of ratings) {
      const ids = idsByRating.get(rating) ?? [];
      ids.push(id);
      idsByRating.set(rating, ids);
    }
    if (idsByRating.size === 0) return;
    const values = [...idsByRating.keys()];
    const mutation = `
      mutation SyncStashRatings(${values.map((r) => `$r${r}: BulkSceneUpdateInput!`).join(", ")}) {
        ${values.map((r) => `r${r}: bulkSceneUpdate(input: $r${r}) { id }`).join("\n        ")}
      }
    `;
    const variables = Object.fromEntries(
      values.map((r) => [`r${r}`, { ids: idsByRating.get(r), rating100: r }])
    );
    await graphqlQuery(mutation, variables);
    console.log(`[Stash Battle] 📝 Wrote ${ratings.size} Stash ratings (${values.length} distinct values)`);
  }
  function applyStashRatings(ratings) {
    setRatingsInCache(ratings);
    refreshStashCache(
      [...ratings].map(([id, rating100]) => ({ id, rating100 })),
      ratings.size > 0
    );
  }
  var SYNC_DEBOUNCE_MS = 500;
  var syncTimer = null;
  function scheduleStashRatingSync() {
    if (state.settings.stashRatings === "off") return;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncTimer = null;
      void syncStashRatings();
    }, SYNC_DEBOUNCE_MS);
  }
  var ratingWrites = Promise.resolve();
  function queueRatingWrite(task) {
    const run = ratingWrites.then(task);
    ratingWrites = run.catch(() => void 0);
    return run;
  }
  function syncStashRatings() {
    return queueRatingWrite(async () => {
      const mode = state.settings.stashRatings;
      const scenes2 = state.memoryCache.allScenes;
      if (mode === "off" || !scenes2) return 0;
      const changes = stashRatingChanges(scenes2, mode);
      if (changes.size === 0) return 0;
      try {
        await writeStashRatings(changes);
        applyStashRatings(changes);
        return changes.size;
      } catch (e) {
        console.error("[Stash Battle] Failed to sync Stash ratings:", e);
        return 0;
      }
    });
  }

  // src/eloSetup.ts
  var SETUP_SCENES_QUERY = `
      query FindScenesForEloSetup {
        findScenes(filter: { per_page: -1 }) {
          scenes {
            id
            rating100
            custom_fields
          }
        }
      }
    `;
  async function fetchSetupScenes() {
    const data = await graphqlQuery(SETUP_SCENES_QUERY);
    return data.findScenes.scenes ?? [];
  }
  function setupRatingChanges(scenes2, start, stashRatings) {
    return stashRatingChanges(
      scenes2.map((scene) => afterSetup(scene, start)),
      stashRatings
    );
  }
  var BULK_UPDATE_MUTATION = `
      mutation BulkSceneUpdate($input: BulkSceneUpdateInput!) {
        bulkSceneUpdate(input: $input) {
          id
        }
      }
    `;
  async function seedFromRatings(rated) {
    const idsByRating = /* @__PURE__ */ new Map();
    for (const scene of rated) {
      const rating = scene.rating100;
      const ids = idsByRating.get(rating) ?? [];
      ids.push(scene.id);
      idsByRating.set(rating, ids);
    }
    if (idsByRating.size === 0) return;
    const values = [...idsByRating.keys()];
    const mutation = `
      mutation SeedElo(${values.map((r) => `$s${r}: BulkSceneUpdateInput!`).join(", ")}) {
        ${values.map((r) => `s${r}: bulkSceneUpdate(input: $s${r}) { id }`).join("\n        ")}
      }
    `;
    const variables = Object.fromEntries(
      values.map((r) => {
        const partial = eloCustomFields({ elo: seed(r), battles: 0, seeded: true });
        return [`s${r}`, { ids: idsByRating.get(r), custom_fields: { partial, remove: RECORD_FIELD_KEYS } }];
      })
    );
    await graphqlQuery(mutation, variables);
  }
  async function runEloSetup(scenes2, start, stashRatings, onProgress) {
    const summary = { eloWritten: 0, eloCleared: 0, ratingsWritten: 0 };
    if (start === "ratings") {
      const rated = scenes2.filter((scene) => scene.rating100 != null);
      onProgress("elo", 0, rated.length);
      await seedFromRatings(rated);
      onProgress("elo", rated.length, rated.length);
      summary.eloWritten = rated.length;
      const stale = scenes2.filter((scene) => scene.rating100 == null && isRated(scene)).map((scene) => scene.id);
      if (stale.length > 0) {
        await graphqlQuery(BULK_UPDATE_MUTATION, {
          input: { ids: stale, custom_fields: { remove: ELO_FIELD_KEYS } }
        });
        summary.eloCleared = stale.length;
      }
    } else {
      const ids = scenes2.map((scene) => scene.id);
      onProgress("elo", 0, ids.length);
      if (ids.length > 0) {
        await graphqlQuery(BULK_UPDATE_MUTATION, {
          input: {
            ids,
            custom_fields: { partial: eloCustomFields({ elo: ELO_START, battles: 0, seeded: false }), remove: RECORD_FIELD_KEYS }
          }
        });
      }
      onProgress("elo", ids.length, ids.length);
      summary.eloWritten = ids.length;
    }
    try {
      await clearHallOfFame();
    } catch (e) {
      console.warn("[Stash Battle] Couldn't clear the hall of fame:", e);
    }
    const changes = setupRatingChanges(scenes2, start, stashRatings);
    if (changes.size > 0) {
      onProgress("ratings", 0, changes.size);
      await writeStashRatings(changes);
      onProgress("ratings", changes.size, changes.size);
      summary.ratingsWritten = changes.size;
    }
    refreshStashCache(
      scenes2.map((scene) => ({ id: scene.id, elo: startingElo(scene, start), rating100: changes.get(scene.id) })),
      changes.size > 0
    );
    console.log(
      `[Stash Battle] ✅ ELO setup (${start}, Stash ratings ${stashRatings}): ${summary.eloWritten} ELO written, ${summary.eloCleared} cleared, ${summary.ratingsWritten} Stash ratings written`
    );
    return summary;
  }

  // src/storage.ts
  var STATE_VERSION = 3;
  var MODES = ["swiss", "placement", "champion"];
  function restoreMode(saved) {
    if (saved === "gauntlet") return "placement";
    return MODES.includes(saved) ? saved : "swiss";
  }
  function saveState() {
    const snapshot = {
      version: STATE_VERSION,
      currentPair: state.currentPair,
      currentRanks: state.currentRanks,
      currentMode: state.currentMode,
      championScene: state.championScene,
      championWins: state.championWins,
      championDefeated: state.championDefeated,
      placement: state.placement,
      totalScenesCount: state.totalScenesCount,
      savedFilterParams: scenesListQuery()
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch (e) {
      console.error("[Stash Battle] Failed to save state:", e);
    }
  }
  function loadState() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        state.currentMode = restoreMode(parsed.currentMode);
        state.savedFilterParams = parsed.savedFilterParams || "";
        if (parsed.version !== STATE_VERSION) {
          console.log("[Stash Battle] 📋 Saved session is from an older version, starting fresh");
          return true;
        }
        state.currentPair = parsed.currentPair || { left: null, right: null };
        state.currentRanks = parsed.currentRanks || { left: null, right: null };
        state.championScene = parsed.championScene ?? null;
        state.championWins = parsed.championWins || 0;
        state.championDefeated = parsed.championDefeated || [];
        state.placement = parsed.placement || null;
        state.totalScenesCount = parsed.totalScenesCount || 0;
        return true;
      }
    } catch (e) {
      console.error("[Stash Battle] Failed to load state:", e);
    }
    return false;
  }

  // src/ui/confirmDialog.ts
  var cancelOpen = null;
  function isConfirmDialogOpen() {
    return cancelOpen !== null;
  }
  function cancelConfirmDialog() {
    cancelOpen?.();
  }
  function confirmDialog(opts) {
    cancelOpen?.();
    const host = document.getElementById("sb-modal");
    if (!host) return Promise.resolve(false);
    const overlay = document.createElement("div");
    overlay.className = "sb-dialog-backdrop";
    overlay.innerHTML = `
      <div class="sb-dialog" role="dialog" aria-modal="true" aria-labelledby="sb-dialog-title">
        <h3 id="sb-dialog-title" class="sb-dialog-title">${opts.title}</h3>
        <div class="sb-dialog-body">${opts.body}</div>
        <p class="sb-dialog-error" hidden></p>
        <div class="sb-dialog-actions">
          <button type="button" class="btn btn-secondary" data-role="cancel">Cancel</button>
          <button type="button" class="btn btn-primary" data-role="confirm">${opts.confirmLabel}</button>
        </div>
      </div>`;
    host.appendChild(overlay);
    const confirmBtn = overlay.querySelector('[data-role="confirm"]');
    const cancelBtn = overlay.querySelector('[data-role="cancel"]');
    const error = overlay.querySelector(".sb-dialog-error");
    confirmBtn.focus();
    return new Promise((resolve) => {
      let busy = false;
      const close = (result) => {
        overlay.remove();
        cancelOpen = null;
        resolve(result);
      };
      cancelOpen = () => {
        if (!busy) close(false);
      };
      cancelBtn.addEventListener("click", () => cancelOpen?.());
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) cancelOpen?.();
      });
      confirmBtn.addEventListener("click", async () => {
        if (!opts.action) {
          close(true);
          return;
        }
        busy = true;
        error.hidden = true;
        confirmBtn.disabled = cancelBtn.disabled = true;
        confirmBtn.textContent = opts.workingLabel ?? "Working...";
        try {
          await opts.action();
          close(true);
        } catch (e) {
          busy = false;
          confirmBtn.disabled = cancelBtn.disabled = false;
          confirmBtn.textContent = opts.confirmLabel;
          error.textContent = `That didn't work: ${e instanceof Error ? e.message : String(e)}. You can try again.`;
          error.hidden = false;
        }
      });
    });
  }

  // src/navigation.ts
  function navigateToUrl(url) {
    closeModal();
    const path = url.startsWith("/") ? url : new URL(url).pathname + new URL(url).search;
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
  }

  // src/placement.ts
  function newPlacementRun(scene, fromBottom) {
    return {
      scene,
      fromBottom,
      aboveId: null,
      belowId: null,
      lastOpponentId: null,
      lastWon: null,
      galloping: fromBottom || elo(scene) !== null,
      step: 1,
      battles: 0,
      streak: 0,
      results: [],
      rangeLo: 0,
      rangeHi: 0
    };
  }
  function tieGroupEdge(pool, idx, dir) {
    const value = elo(pool[idx]);
    let edge = idx;
    while (edge + dir >= 0 && edge + dir < pool.length && elo(pool[edge + dir]) === value) edge += dir;
    return edge;
  }
  function placementBounds(run, pool) {
    const aboveIdx = run.aboveId ? pool.findIndex((s) => s.id === run.aboveId) : -1;
    const belowIdx = run.belowId ? pool.findIndex((s) => s.id === run.belowId) : -1;
    return {
      lo: aboveIdx >= 0 ? tieGroupEdge(pool, aboveIdx, 1) + 1 : 0,
      hi: belowIdx >= 0 ? tieGroupEdge(pool, belowIdx, -1) : pool.length
    };
  }
  function bottomIndex(pool) {
    for (let i = pool.length - 1; i >= 0; i--) {
      if (elo(pool[i]) !== null) return i;
    }
    return pool.length - 1;
  }
  function maxPlacementJump(poolSize) {
    return Math.max(PLACEMENT_MIN_MAX_JUMP, Math.round(poolSize * PLACEMENT_MAX_JUMP_SHARE));
  }
  function nextPlacementIndex(run, pool, lo, hi) {
    if (run.galloping) {
      if (run.lastOpponentId === null) {
        if (run.fromBottom) return bottomIndex(pool);
        return eloInsertionIndex(pool, elo(run.scene) ?? 0);
      }
      const lastIdx = pool.findIndex((s) => s.id === run.lastOpponentId);
      if (lastIdx >= 0) {
        const dir = run.lastWon ? -1 : 1;
        const target = tieGroupEdge(pool, lastIdx, dir) + dir * Math.min(run.step, maxPlacementJump(pool.length));
        if (target >= lo && target < hi) return target;
      }
    }
    return lo + Math.floor((hi - lo) / 2);
  }
  function placementStep(run, pool) {
    const { lo, hi } = placementBounds(run, pool);
    if (lo >= hi) return { done: true, slot: Math.min(lo, hi), lo, hi };
    const index = Math.max(lo, Math.min(hi - 1, nextPlacementIndex(run, pool, lo, hi)));
    return { done: false, index, lo, hi };
  }
  function recordPlacementResult(run, won, opponentId) {
    if (run.lastWon !== null) {
      if (run.lastWon === won) run.step *= 2;
      else run.galloping = false;
    }
    if (won) run.belowId = opponentId;
    else run.aboveId = opponentId;
    if (won && run.streak === run.battles) run.streak++;
    run.lastOpponentId = opponentId;
    run.lastWon = won;
    run.battles++;
    run.results = [...run.results ?? [], won];
  }
  function landingElo(pool, slot) {
    let above = null;
    for (let i = slot - 1; i >= 0 && above === null; i--) above = elo(pool[i]);
    let below = null;
    for (let i = slot; i < pool.length && below === null; i++) below = elo(pool[i]);
    return placementElo(above, below);
  }

  // src/sceneTitle.ts
  function resolveSceneTitle(scene) {
    if (scene.title) return scene.title;
    const path = scene.files?.[0]?.path;
    if (path) {
      const pathParts = path.split(/[/\\]/);
      return pathParts[pathParts.length - 1].replace(/\.[^/.]+$/, "");
    }
    return "";
  }

  // src/pairs.ts
  function shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }
  var lastShownSceneId = null;
  function isShuffleCycleComplete(filterKey) {
    return state.shuffleFilterKey === filterKey && state.shuffledFilteredScenes.length > 0 && state.shuffleIndex >= state.shuffledFilteredScenes.length;
  }
  function startNewPass(leftPool) {
    console.log("[Stash Battle] 🔀 Reshuffling (completed full cycle)");
    state.shuffledFilteredScenes = shuffleArray(leftPool);
    state.shuffleIndex = 0;
    if (lastShownSceneId && state.shuffledFilteredScenes.length > 1 && state.shuffledFilteredScenes[0].id === lastShownSceneId) {
      const swapIdx = 1 + Math.floor(Math.random() * (state.shuffledFilteredScenes.length - 1));
      [state.shuffledFilteredScenes[0], state.shuffledFilteredScenes[swapIdx]] = [
        state.shuffledFilteredScenes[swapIdx],
        state.shuffledFilteredScenes[0]
      ];
      console.log("[Stash Battle] 🔄 Swapped first scene to avoid repeat");
    }
  }
  function getNextFilteredScene(leftPool, filterKey) {
    if (leftPool.length === 0) {
      console.log("[Stash Battle] 🏁 Filtered pool is empty");
      return null;
    }
    if (filterKey !== state.shuffleFilterKey || state.shuffledFilteredScenes.length === 0) {
      console.log("[Stash Battle] 🔀 Shuffling filtered scenes (filter changed or first load)");
      state.shuffledFilteredScenes = shuffleArray(leftPool);
      state.shuffleIndex = 0;
      state.shuffleFilterKey = filterKey;
      lastShownSceneId = null;
    }
    const inPool = new Map(leftPool.map((s) => [s.id, s]));
    let scene;
    for (let tries = 0; !scene && tries < 2; tries++) {
      if (state.shuffleIndex >= state.shuffledFilteredScenes.length) startNewPass(leftPool);
      while (!scene && state.shuffleIndex < state.shuffledFilteredScenes.length) {
        scene = inPool.get(state.shuffledFilteredScenes[state.shuffleIndex].id);
        state.shuffleIndex++;
      }
    }
    if (!scene) return null;
    lastShownSceneId = scene.id;
    console.log(
      `[Stash Battle] 📍 Picked scene ${scene.id} (${state.shuffledFilteredScenes.length - state.shuffleIndex} left in this pass)`
    );
    return scene;
  }
  function buildOpponentPool(allScenes, leftPool, filters2) {
    if (state.explorePool ? explorePoolWithin() : state.settings.filterOpponents && filters2.filterActive) {
      return leftPool;
    }
    const rated = allScenes.filter(isRated);
    return rated.length >= 1 ? rated : allScenes;
  }
  async function loadScenePools(filters2) {
    let leftPool;
    let allScenes;
    if (state.explorePool) {
      allScenes = (await getAllScenesCached()).scenes || [];
      const { sceneId, filters: poolFilters } = state.explorePool;
      leftPool = sceneId ? allScenes.filter((s) => s.id === sceneId) : explorePoolScenes(allScenes, poolFilters, resolveSceneTitle);
    } else if (filters2.filterActive) {
      const passComplete = isShuffleCycleComplete(filters2.filterKey);
      if (passComplete) {
        console.log("[Stash Battle] 🔁 Pass complete, re-fetching filtered scenes");
        await clearFilteredCache();
      }
      console.log("[Stash Battle] 📋 Filter active, fetching filtered + all scenes");
      const [filteredResult, allResult] = await Promise.all([
        getFilteredScenesCached(filters2),
        getAllScenesCached()
      ]);
      leftPool = filteredResult.scenes || [];
      allScenes = allResult.scenes || [];
      if (passComplete) startNewPass(leftPool);
    } else {
      console.log("[Stash Battle] 📋 No filter active, using all scenes");
      allScenes = (await getAllScenesCached()).scenes || [];
      leftPool = allScenes;
    }
    state.leftPoolSize = leftPool.length;
    return { leftPool, allScenes };
  }
  async function pairRanks(left, right) {
    const filters2 = currentFilters();
    const { leftPool, allScenes } = await loadScenePools(filters2);
    let pool = buildOpponentPool(allScenes, leftPool, filters2);
    const rank = (scene) => {
      const idx = pool.findIndex((s) => s.id === scene.id);
      return idx >= 0 ? idx + 1 : null;
    };
    if (state.currentMode === "placement") {
      pool = pool.filter((s) => s.id !== left.id);
      return [null, rank(right)];
    }
    return [rank(left), rank(right)];
  }
  async function leastTestedSource() {
    const filters2 = readFilters();
    if (!filters2.filterActive) return { scenes: (await getAllScenesCached()).scenes || [], filtered: false };
    return { scenes: (await getFilteredScenesCached(filters2)).scenes || [], filtered: true };
  }
  function currentFilters() {
    const pool = state.explorePool;
    if (pool) {
      const filterKey = pool.sceneId ? `scene:${pool.sceneId}` : `explore:${JSON.stringify(pool.filters)}`;
      return { filterKey, sceneFilter: null, filterActive: true };
    }
    return readFilters();
  }
  async function buildSwissPools() {
    const filters2 = currentFilters();
    const { leftPool, allScenes } = await loadScenePools(filters2);
    if (allScenes.length < 2) {
      throw new Error("Not enough scenes for comparison.");
    }
    const rightPool = buildOpponentPool(allScenes, leftPool, filters2);
    if (explorePoolWithin() && rightPool.length < 2) {
      throw new Error("Not enough scenes in this Explore filter for a match. You need at least 2 scenes.");
    }
    if (!state.explorePool && state.settings.filterOpponents && filters2.filterActive && rightPool.length < 2) {
      throw new Error("Not enough scenes in your filter for a match. You need at least 2 scenes.");
    }
    return { leftPool, rightPool, filterKey: filters2.filterKey };
  }
  async function fetchSwissPair(forcedLeftScene = null) {
    const { leftPool, rightPool, filterKey } = await buildSwissPools();
    const scene1 = forcedLeftScene || (state.leastTested ? leastTested(leftPool, state.currentPair.left?.id ?? null) : getNextFilteredScene(leftPool, filterKey));
    if (!scene1) {
      throw new Error("No scenes match your filter criteria.");
    }
    const { scene2, ranks } = pickSwissOpponent(scene1, rightPool);
    return { scenes: [scene1, scene2], ranks };
  }
  function pickSwissOpponent(scene1, rightPool) {
    const scene1IdxInPool = rightPool.findIndex((s) => s.id === scene1.id);
    const scene1RankInPool = scene1IdxInPool >= 0 ? scene1IdxInPool + 1 : null;
    const candidates = swissOpponentIndexes(
      rightPool,
      effectiveElo(latestScene(scene1)),
      scene1.id,
      SWISS_OPPONENT_ELO_WINDOW,
      SWISS_OPPONENT_MIN_CANDIDATES
    );
    if (candidates.length === 0) {
      throw new Error("Not enough scenes for comparison. You need at least 2 scenes.");
    }
    const idx = candidates[Math.floor(Math.random() * candidates.length)];
    return {
      scene2: rightPool[idx],
      ranks: [scene1RankInPool, idx + 1]
    };
  }
  function pickClosestChampionOpponent(remainingOpponents) {
    const closest = remainingOpponents.slice(-CLIMB_OPPONENT_PICK_WINDOW);
    return closest[Math.floor(Math.random() * closest.length)];
  }
  function getRemainingChampionOpponents(champion, rightPool, championIndex) {
    const championElo = effectiveElo(champion, CHAMPION_UNRATED_ELO);
    return rightPool.filter((s, idx) => {
      if (s.id === champion.id || state.championDefeated.includes(s.id)) return false;
      return idx < championIndex || (elo(s) ?? -Infinity) >= championElo;
    });
  }
  function findLowestRated(scenes2, excludeId) {
    for (let i = scenes2.length - 1; i >= 0; i--) {
      const s = scenes2[i];
      if (s.id !== excludeId && isRated(s)) {
        return { scene: s, index: i };
      }
    }
    const fallbackIndex = scenes2.findIndex((s) => s.id !== excludeId);
    return { scene: scenes2[fallbackIndex], index: fallbackIndex };
  }
  async function fetchChampionPair(forcedLeftScene = null) {
    const filters2 = currentFilters();
    console.log("[Stash Battle] 📋 Fetching scenes for champion...");
    const { leftPool, allScenes } = await loadScenePools(filters2);
    const rightPool = buildOpponentPool(allScenes, leftPool, filters2);
    state.totalScenesCount = rightPool.length;
    if (allScenes.length < 2) {
      throw new Error("Not enough scenes for comparison.");
    }
    if (!state.championScene) {
      state.championDefeated = [];
      const challenger = forcedLeftScene || getNextFilteredScene(leftPool, filters2.filterKey);
      if (!challenger) {
        throw new Error("No scenes match your filter criteria.");
      }
      const challengerIndex = rightPool.findIndex((s) => s.id === challenger.id);
      const { scene: lowestRated, index: lowestIndex } = findLowestRated(rightPool, challenger.id);
      if (!lowestRated) {
        throw new Error("Not enough scenes for comparison. You need at least 2 scenes.");
      }
      return {
        scenes: [challenger, lowestRated],
        ranks: [challengerIndex >= 0 ? challengerIndex + 1 : null, lowestIndex + 1],
        isVictory: false
      };
    }
    const champion = state.championScene;
    const championIndex = rightPool.findIndex((s) => s.id === champion.id);
    const remainingOpponents = getRemainingChampionOpponents(champion, rightPool, championIndex);
    if (remainingOpponents.length === 0) {
      return { scenes: [champion], ranks: [1], isVictory: true };
    }
    const nextOpponent = pickClosestChampionOpponent(remainingOpponents);
    const nextOpponentIndex = rightPool.findIndex((s) => s.id === nextOpponent.id);
    return {
      scenes: [champion, nextOpponent],
      ranks: [championIndex >= 0 ? championIndex + 1 : null, nextOpponentIndex + 1],
      isVictory: false
    };
  }
  function pickAmongTies(pool, idx, lo, hi) {
    const target = elo(pool[idx]);
    const ties = [];
    for (let i = lo; i < hi; i++) {
      if (elo(pool[i]) === target) ties.push(i);
    }
    return ties[Math.floor(Math.random() * ties.length)];
  }
  async function fetchPlacementPair(forcedLeftScene = null) {
    const filters2 = currentFilters();
    const { leftPool, allScenes } = await loadScenePools(filters2);
    if (allScenes.length < 2) {
      throw new Error("Not enough scenes for comparison.");
    }
    if (!state.placement) {
      const scene = forcedLeftScene || getNextFilteredScene(leftPool, filters2.filterKey);
      if (!scene) {
        throw new Error("No scenes match your filter criteria.");
      }
      state.placement = newPlacementRun(scene, state.settings.placementFromBottom);
    }
    const run = state.placement;
    const pool = buildOpponentPool(allScenes, leftPool, filters2).filter((s) => s.id !== run.scene.id);
    if (pool.length === 0) {
      throw new Error("Not enough scenes for comparison. You need at least 2 scenes.");
    }
    state.totalScenesCount = pool.length + 1;
    const step = placementStep(run, pool);
    run.rangeLo = Math.min(step.lo, step.hi);
    run.rangeHi = step.hi;
    if (step.done) {
      const newElo = landingElo(pool, step.slot);
      const newBattles = battles(latestScene(run.scene)) + run.battles;
      console.log(
        `[Stash Battle] 📍 Placement: scene ${run.scene.id} placed at #${step.slot + 1} after ${run.battles} battles, ELO ${newElo}`
      );
      await writeElo(run.scene, newElo, newBattles, run.results ?? []);
      return {
        done: true,
        scene: run.scene,
        rank: step.slot + 1,
        elo: newElo,
        battles: run.battles,
        streak: run.streak,
        fromBottom: run.fromBottom
      };
    }
    const idx = pickAmongTies(pool, step.index, step.lo, step.hi);
    return { done: false, scenes: [run.scene, pool[idx]], ranks: [null, idx + 1] };
  }

  // src/ui/sceneCard.ts
  var PROVISIONAL_TIP = `Provisional: fewer than ${ELO_K_TIERS[0][0]} battles, so this ELO is still settling`;
  function tierPill(tier) {
    return `<span class="sb-tier sb-tier-${tier.id}" title="${tierDescription(tier)}">${tier.emoji}<span class="sb-tier-name"> ${tier.name}</span></span>`;
  }
  function formatDuration(seconds) {
    if (!seconds) return "N/A";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor(seconds % 3600 / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
    }
    return `${m}:${s.toString().padStart(2, "0")}`;
  }
  function createSceneCard(scene, side, rank = null, statusBadge = null, tier = null) {
    const file = scene.files && scene.files[0] ? scene.files[0] : {};
    const duration = file.duration;
    const performers = scene.performers && scene.performers.length > 0 ? scene.performers.map((p) => p.name).join(", ") : "No performers";
    const studio = scene.studio ? scene.studio.name : "No studio";
    const tags = scene.tags ? scene.tags.slice(0, 5).map((t) => t.name) : [];
    const compactDetail = scene.studio?.name || (scene.performers?.length ? performers : "") || tags.join(", ");
    const title = resolveSceneTitle(scene);
    const screenshotPath = scene.paths ? scene.paths.screenshot : null;
    const previewPath = scene.paths ? scene.paths.preview : null;
    const { openInNewTab, cleanMode } = state.settings;
    const stashRating = scene.rating100 ? formatRating(scene.rating100) : "None";
    const eloValue = elo(scene);
    const unratedAs = state.currentMode === "swiss" ? ELO_START : state.currentMode === "champion" ? CHAMPION_UNRATED_ELO : null;
    const provisional = isProvisional(scene);
    let eloLabel;
    if (eloValue !== null) {
      eloLabel = `ELO ${Math.round(eloValue)}${provisional ? "?" : ""}${rank !== null && rank !== void 0 ? ` · #${rank}` : ""}`;
    } else {
      eloLabel = unratedAs !== null ? `ELO ${unratedAs} · Unrated` : "Unrated";
    }
    const border = tier !== null && state.settings.tierBorders;
    const rankTitle = provisional ? ` title="${PROVISIONAL_TIP}"` : "";
    const record = recordText(scene);
    const rankDisplay = `${tier ? tierPill(tier) : ""}<span class="sb-scene-rank"${rankTitle}>${eloLabel}</span>`;
    let statusBadgeHtml = "";
    if (typeof statusBadge === "string") {
      statusBadgeHtml = `<div class="sb-streak-badge">${statusBadge}</div>`;
    } else if (statusBadge !== null && statusBadge > 0) {
      statusBadgeHtml = `<div class="sb-streak-badge">🔥 ${statusBadge} win${statusBadge > 1 ? "s" : ""}</div>`;
    }
    const currentParams = scenesListQuery();
    const sceneUrl2 = `/scenes/${scene.id}${currentParams}`;
    const linkTarget = openInNewTab ? ` target="_blank" rel="noopener"` : "";
    return `
      <div class="sb-scene-card${border ? ` sb-tier-${tier?.id}` : ""}" data-side="${side}"${border ? ` data-tier="${tier?.id}"` : ""}>
        <div class="sb-scene-media">
          <a class="sb-scene-image-container pwr-scene-image-container" href="${sceneUrl2}"${linkTarget}>
            ${screenshotPath ? `<img class="sb-scene-image pwr-scene-image" src="${screenshotPath}" alt="${title}" loading="lazy" />` : `<div class="sb-scene-image sb-no-image">No Screenshot</div>`}
            ${previewPath ? `<video class="sb-hover-preview pwr-hover-preview" src="${previewPath}" loop muted playsinline></video>` : ""}
          </a>
          <div class="sb-scene-duration">${formatDuration(duration)}</div>
          <button type="button" class="sb-card-mute" aria-label="Play this preview with sound">🔇</button>
          ${statusBadgeHtml}
          <div class="sb-click-hint">${openInNewTab ? "Click to open in new tab" : "Click to open scene"}</div>
          <a class="sb-open-link" href="${sceneUrl2}" target="_blank" rel="noopener" title="Open scene in new tab">↗</a>
          ${cleanMode && isStashDeleteDialogAvailable() ? `<button type="button" class="sb-delete-btn" title="Delete this scene from Stash">🗑</button>` : ""}
        </div>

        <div class="sb-scene-body" data-winner="${scene.id}">
          <div class="sb-scene-info pwr-scene-info">
            <div class="sb-scene-title-row">
              <h3 class="sb-scene-title">${title}</h3>
              ${rankDisplay}
            </div>

            <div class="sb-scene-meta">
              <div class="sb-meta-item sb-meta-plays"><strong>Play Count:</strong> ${scene.play_count || 0}</div>
              <div class="sb-meta-item sb-meta-battles">${record !== null ? `<strong>Record:</strong> ${record}` : `<strong>Battles:</strong> ${battles(scene)}`}</div>
              <div class="sb-meta-item sb-meta-rating"><strong>Stash Rating:</strong> ${stashRating}<span class="sb-meta-record-inline"> · ${record !== null ? `<strong>Record:</strong> ${record}` : `${battles(scene)} battle${battles(scene) === 1 ? "" : "s"}`}</span></div>
              <div class="sb-meta-item sb-meta-compact">${compactDetail}</div>
              <div class="sb-meta-item sb-meta-studio"><strong>Studio:</strong> ${studio}</div>
              <div class="sb-meta-item sb-meta-performers"><strong>Performers:</strong> ${performers}</div>
              <div class="sb-meta-item sb-tags-row"><strong>Tags:</strong> ${tags.length > 0 ? tags.map((tag) => `<span class="sb-tag">${tag}</span>`).join("") : '<span class="sb-none">None</span>'}</div>
            </div>
          </div>

          <div class="sb-choose-btn">
            ✓ Choose<span class="sb-choose-long"> This Scene</span>
          </div>
        </div>
      </div>
    `;
  }

  // src/ui/miniCard.ts
  function escapeHtml(text) {
    return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  }
  function plural(n, word) {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
  }
  function sceneUrl(sceneId) {
    return `/scenes/${sceneId}${scenesListQuery()}`;
  }
  function miniCardHtml(entry, link = true) {
    const { scene, rank, tier } = entry;
    const title = escapeHtml(resolveSceneTitle(scene) || `Scene ${scene.id}`);
    const value = elo(scene);
    const provisional = isProvisional(scene);
    const eloText = value === null ? "Unrated" : `ELO ${Math.round(value)}${provisional ? "?" : ""}${rank !== null ? ` · #${rank}` : ""}`;
    const screenshot = scene.paths?.screenshot;
    const thumb = screenshot ? `<img class="sb-mini-img pwr-scene-image" src="${screenshot}" alt="" loading="lazy" />` : `<div class="sb-mini-img sb-no-image">No Screenshot</div>`;
    const plays = scene.play_count ?? 0;
    const body = `
          <div class="sb-mini-thumb pwr-scene-image-container">${thumb}</div>
          <div class="sb-mini-body pwr-scene-info">
            <div class="sb-mini-title" title="${title}">${title}</div>
            <div class="sb-mini-elo">${tier ? tierPill(tier) : ""}<span class="sb-mini-rank"${provisional ? ` title="${PROVISIONAL_TIP}"` : ""}>${eloText}</span></div>
            <div class="sb-mini-meta">${plural(plays, "play")} · ${recordText(scene) ?? plural(battles(scene), "battle")}</div>
          </div>`;
    const tierAttrs = tier ? ` sb-tier-${tier.id}" data-tier="${tier.id}` : "";
    const preview = scene.paths?.preview ? ` data-preview="${scene.paths.preview}"` : "";
    if (!link) return `<div class="sb-mini-card sb-mini-static${tierAttrs}">${body}</div>`;
    const target = state.settings.openInNewTab ? ` target="_blank" rel="noopener"` : "";
    return `
        <div class="sb-mini-card${tierAttrs}" data-scene-id="${scene.id}"${preview}>
          <a class="sb-mini-link" href="${sceneUrl(scene.id)}"${target}>${body}</a>${scene.paths?.preview ? `<div class="sb-mini-overlay"><button type="button" class="sb-card-mute sb-mini-mute" aria-label="Play this preview with sound">🔇</button></div>` : ""}
          <button type="button" class="sb-mini-battle" data-battle="${scene.id}" title="Battle this scene">⚔️</button>
        </div>`;
  }
  var previewCard = null;
  function startMiniPreview(card) {
    if (card === previewCard) return;
    stopMiniPreview();
    const src = card.dataset.preview;
    const thumb = card.querySelector(".sb-mini-thumb");
    if (!src || !thumb) return;
    previewCard = card;
    const video = document.createElement("video");
    video.className = "sb-mini-video pwr-hover-preview";
    video.src = src;
    video.volume = sliderToVolume(state.settings.previewVolume);
    video.muted = state.settings.previewVolume === 0;
    video.loop = true;
    video.playsInline = true;
    thumb.appendChild(video);
    video.play().catch(() => {
    });
    updateMiniMuteIcons();
  }
  function stopMiniPreview() {
    previewCard?.querySelector(".sb-mini-video")?.remove();
    previewCard = null;
    updateMiniMuteIcons();
  }
  function updateMiniMuteIcons() {
    document.querySelectorAll(".sb-mini-mute").forEach((button) => {
      const card = button.closest(".sb-mini-card");
      const video = card && card === previewCard ? card.querySelector(".sb-mini-video") : null;
      const heard = video !== null && !video.muted;
      button.textContent = heard ? "🔊" : "🔇";
      button.setAttribute("aria-label", heard ? "Mute this preview" : "Play this preview with sound");
    });
  }
  function handleMiniMuteTap(e) {
    const button = e.target.closest(".sb-mini-mute");
    if (!button) return false;
    e.preventDefault();
    const card = button.closest(".sb-mini-card[data-preview]");
    if (!card) return true;
    const video = card === previewCard ? card.querySelector(".sb-mini-video") : null;
    if (video && !video.muted) {
      video.muted = true;
    } else {
      if (state.settings.previewVolume === 0) document.querySelector(".sb-volume-icon")?.click();
      if (video) {
        video.volume = sliderToVolume(state.settings.previewVolume);
        video.muted = false;
      } else {
        startMiniPreview(card);
      }
    }
    updateMiniMuteIcons();
    return true;
  }
  function handleMiniThumbTap(e) {
    if (!isTouchDevice()) return false;
    const thumb = e.target.closest(".sb-mini-thumb");
    const card = thumb?.closest(".sb-mini-card[data-preview]");
    if (!card) return false;
    e.preventDefault();
    if (previewCard === card) stopMiniPreview();
    else startMiniPreview(card);
    return true;
  }
  function miniPreviewCard() {
    return previewCard;
  }

  // src/ui/screens.ts
  function buildEndScreenHtml(scene, crown, headline, statsHtml, buttonLabel) {
    const title = resolveSceneTitle(scene);
    const screenshotPath = scene.paths?.screenshot ?? null;
    return `
      <div class="sb-end-screen">
        <div class="sb-end-screen-icon">${crown}</div>
        <h2 class="sb-end-screen-headline">${headline}</h2>
        <div class="sb-end-screen-scene pwr-scene-image-container">
          ${screenshotPath ? `<img class="sb-end-screen-image pwr-scene-image" src="${screenshotPath}" alt="${title}" />` : `<div class="sb-end-screen-image sb-no-image">No Screenshot</div>`}
        </div>
        <h3 class="sb-end-screen-name">${title}</h3>
        <p class="sb-end-screen-stats">${statsHtml}</p>
        <div class="sb-end-actions">
          <button id="sb-new-run" class="btn btn-primary">${buttonLabel}</button>
        </div>
      </div>
    `;
  }
  function showEndScreen(html) {
    const comparisonArea = document.getElementById("sb-comparison-area");
    if (!comparisonArea) return;
    comparisonArea.innerHTML = html;
    setActionsVisible(false);
    comparisonArea.querySelector("#sb-new-run")?.addEventListener("click", () => {
      loadNewPair();
    });
    const newRun = comparisonArea.querySelector("#sb-new-run");
    if (newRun && canUndo()) {
      newRun.insertAdjacentHTML("afterend", `<button id="sb-end-undo" class="btn btn-secondary" title="Undo your last pick (Backspace)">↶ Undo</button>`);
      comparisonArea.querySelector("#sb-end-undo")?.addEventListener("click", () => void undoLastPick());
    }
  }
  function finishRunShowEndScreen(html) {
    resetRunState();
    state.currentPair = { left: null, right: null };
    state.currentRanks = { left: null, right: null };
    saveState();
    showEndScreen(html);
  }
  function eloLine(scene, value) {
    if (value === null) return "";
    let line = `<br>ELO: <strong>${Math.round(value)}</strong>`;
    const mode = state.settings.stashRatings;
    const scenes2 = state.memoryCache.allScenes;
    if (mode !== "off" && scenes2) {
      const rating = stashRatingTargets(scenes2, mode).get(scene.id);
      if (rating !== void 0) line += ` · Stash Rating: <strong>${formatRating(rating)}</strong>`;
    }
    return line;
  }
  function showVictoryScreen(champion, winStreak) {
    const html = buildEndScreenHtml(
      champion,
      "👑",
      "CHAMPION!",
      `Reached the top: ${winStreak} win${winStreak === 1 ? "" : "s"} in a row!${eloLine(champion, elo(latestScene(champion)))}`,
      "Start New Run"
    );
    finishRunShowEndScreen(html);
  }
  function showPlacementScreen(result) {
    const { scene, rank, battles: battles2, streak, fromBottom } = result;
    const streakText = fromBottom && streak > 0 ? `🔥 ${streak} win streak · ` : "";
    const battlesText = battles2 ? ` · ${battles2} battle${battles2 === 1 ? "" : "s"}` : "";
    const html = buildEndScreenHtml(
      scene,
      "📍",
      "PLACED!",
      `${streakText}Rank <strong>#${rank}</strong> of ${state.totalScenesCount}${battlesText}${eloLine(scene, result.elo)}`,
      "Start New Run"
    );
    finishRunShowEndScreen(html);
  }

  // src/ui/stashRatingsText.ts
  var STASH_RATINGS_OPTIONS = [
    { value: "off", label: "Don't update", desc: "ELO is saved; your Stash ratings stay as they are." },
    {
      value: "linear",
      label: "Straight-line",
      get desc() {
        const ex = exampleRating(50);
        return `Rating = ELO converted back (${seed(ex)} = ${formatRating(ex, true)}). Very high or low scenes stop at the top or bottom of the scale.`;
      }
    },
    {
      value: "percentile",
      label: "Percentile",
      get desc() {
        const ex = exampleRating(90);
        return `Rating = percentile in your library: ${formatRating(ex, true)} means the scene ranks above about ${ex}% of your scenes. The top scene gets the top rating, the bottom scene the lowest.`;
      }
    }
  ];
  function stashRatingsOption(value) {
    return STASH_RATINGS_OPTIONS.find((option) => option.value === value) ?? STASH_RATINGS_OPTIONS[0];
  }

  // src/ui/settingsPanel.ts
  var SECTIONS = [
    {
      title: "ELO",
      rows: [
        // The hint is the selected option's description (kept current by syncSettingsControls)
        { key: "stashRatings", title: "Stash ratings update mode", hint: "" },
        {
          action: "reset-elo",
          title: "Reset ELO",
          hint: "Start every scene's ELO over, from its Stash rating or at 1500",
          button: "Reset ELO…"
        },
        {
          action: "clear-hall-of-fame",
          title: "Clear hall of fame",
          hint: "Empty the Records tab's list of scenes that have been #1. It's kept in Stash's plugin settings, so restoring Stash's database doesn't change it",
          button: "Clear…"
        }
      ]
    },
    {
      title: "Battles",
      rows: [
        { key: "filterOpponents", title: "Use filtered scenes for both sides", hint: "Opponents also come from the current scene list filter instead of your whole rated library" },
        { key: "placementFromBottom", title: "Placement: start from the bottom", hint: "Placement ignores the scene's current ELO: it starts against the bottom scene and climbs, jumping further with each win (this replaces Gauntlet)" }
      ]
    },
    {
      title: "Scenes",
      rows: [
        // Narrow phones hide the tab bar's slider (only its mute button fits), so it's here instead
        { key: "previewVolume", title: "Preview volume", hint: "How loud the hovered or tapped card's preview plays. 0 mutes it", className: "sb-setting-phone-only" },
        { key: "autoplayPreviews", title: "Autoplay previews", hint: "Loop both previews silently; hover a card to hear it" },
        { key: "pauseMediaOnOpen", title: "Pause playing video when Stash Battle opens", hint: "Stops the scene you're watching so its audio doesn't overlap the battle previews" },
        { key: "tierBorders", title: "Tier colours on card borders", hint: "Each battle card's border takes the colour of its tier (👑 Legendary down to 🥉 Bronze), as on the Explore cards" },
        { key: "openInNewTab", title: "Open scenes in a new tab", hint: "Clicking a thumbnail opens the scene in a new browser tab" },
        { key: "cleanMode", title: "Clean mode", hint: "Show a 🗑 button on each card to delete the scene from Stash" }
      ]
    }
  ];
  var DEFAULT_UNMUTE_VOLUME = 50;
  var volumeBeforeMute = null;
  var activeTab = "battle";
  function getActiveTab() {
    return activeTab;
  }
  function volumeIcon(volume) {
    if (volume === 0) return "🔇";
    return volume < 50 ? "🔉" : "🔊";
  }
  function settingControl(key) {
    if (key === "previewVolume") {
      const volume = state.settings.previewVolume;
      return `<div class="sb-setting-volume"><input type="range" min="0" max="100" step="1" data-setting="previewVolume" value="${volume}" aria-label="Preview volume"><span class="sb-volume-value">${volume}</span></div>`;
    }
    if (key === "stashRatings") {
      const options2 = STASH_RATINGS_OPTIONS.map(
        ({ value, label }) => `<option value="${value}" ${value === state.settings.stashRatings ? "selected" : ""}>${label}</option>`
      ).join("");
      return `<select data-setting="${key}" class="form-control form-control-sm sb-setting-select" aria-label="Stash ratings update mode">${options2}</select>`;
    }
    const id = `sb-setting-${key}`;
    return `
          <div class="custom-control custom-switch">
            <input type="checkbox" class="custom-control-input" id="${id}" data-setting="${key}" ${state.settings[key] ? "checked" : ""}>
            <label class="custom-control-label" for="${id}"></label>
          </div>`;
  }
  var TABS = [
    { id: "battle", emoji: "⚔️", name: "Battle" },
    { id: "explore", emoji: "🔎", name: "Explore" },
    { id: "stats", emoji: "📊", name: "Stats" },
    { id: "records", emoji: "🏆", name: "Records" },
    { id: "settings", emoji: "⚙", name: "Settings" }
  ];
  function createTabBar() {
    const { previewVolume } = state.settings;
    return `
      <div class="sb-tab-bar">
        <nav class="nav nav-tabs sb-tabs" role="tablist">
          ${TABS.map(
      ({ id, emoji, name }) => `<a class="nav-item nav-link${id === "battle" ? " active" : ""}" role="tab" data-tab="${id}" aria-selected="${id === "battle"}" aria-label="${name}" title="${name}"><span class="sb-tab-emoji" aria-hidden="true">${emoji}</span><span class="sb-tab-name"> ${name}</span></a>`
    ).join("")}
        </nav>
        <div class="sb-volume" title="Preview volume">
          <button type="button" class="sb-volume-icon" aria-label="Mute previews">${volumeIcon(previewVolume)}</button>
          <input type="range" min="0" max="100" step="1" data-setting="previewVolume" value="${previewVolume}" aria-label="Preview volume">
          <span class="sb-volume-value">${previewVolume}</span>
        </div>
      </div>
    `;
  }
  function settingRowHtml(row) {
    const hint = "key" in row && row.key === "stashRatings" ? stashRatingsOption(state.settings.stashRatings).desc : row.hint;
    const hintFor = "key" in row ? ` data-hint-for="${row.key}"` : "";
    const control = "key" in row ? settingControl(row.key) : `<button type="button" class="btn btn-secondary btn-sm" data-action="${row.action}">${row.button}</button>`;
    const rowClass = "key" in row && row.className ? ` ${row.className}` : "";
    return `
            <div class="setting${rowClass}">
              <div>
                <h3>${row.title}</h3>
                <div class="sub-heading"${hintFor}>${hint}</div>
              </div>
              <div>${control}</div>
            </div>`;
  }
  function createSettingsTab() {
    const sections = SECTIONS.map(
      ({ title, rows }) => `
        <div class="setting-section">
          <h1>${title}</h1>
          <div class="card">
            ${rows.map(settingRowHtml).join("")}
          </div>
        </div>`
    ).join("");
    return `
      <div class="sb-tab-panel sb-settings-tab" data-panel="settings" hidden>
        ${sections}
        <p class="sb-settings-note">Saves to Stash, also under Settings → Plugins.</p>
      </div>
    `;
  }
  function syncSettingsControls(root) {
    root.querySelectorAll("input[data-setting]").forEach((input) => {
      const key = input.dataset.setting;
      const value = state.settings[key];
      if (input.type === "checkbox") input.checked = Boolean(value);
      else input.value = String(value);
    });
    root.querySelectorAll("select[data-setting]").forEach((select) => {
      select.value = String(state.settings[select.dataset.setting]);
    });
    root.querySelectorAll('[data-hint-for="stashRatings"]').forEach((hint) => {
      hint.textContent = stashRatingsOption(state.settings.stashRatings).desc;
    });
    const volume = state.settings.previewVolume;
    root.querySelectorAll(".sb-volume-icon").forEach((el) => {
      el.textContent = volumeIcon(volume);
      el.setAttribute("aria-label", volume === 0 ? "Unmute previews" : "Mute previews");
    });
    root.querySelectorAll(".sb-volume-value").forEach((el) => el.textContent = String(volume));
  }
  function showTab(root, tab) {
    activeTab = tab;
    root.querySelectorAll(".sb-tabs .nav-link").forEach((link) => {
      const on = link.dataset.tab === tab;
      link.classList.toggle("active", on);
      link.setAttribute("aria-selected", String(on));
    });
    root.querySelectorAll(".sb-tab-panel").forEach((panel) => {
      panel.hidden = panel.dataset.panel !== tab;
    });
  }
  function bindSettingsControls(root, onChange, onTabChange, beforeChange = async () => true) {
    const apply = (patch, key) => {
      updateSettings(patch);
      syncSettingsControls(root);
      onChange(key);
    };
    root.querySelectorAll("input[data-setting]").forEach((input) => {
      const key = input.dataset.setting;
      const eventName = input.type === "range" ? "input" : "change";
      input.addEventListener(eventName, () => {
        const value = input.type === "checkbox" ? input.checked : Number(input.value);
        apply({ [key]: value }, key);
      });
    });
    root.querySelectorAll("select[data-setting]").forEach((select) => {
      const key = select.dataset.setting;
      select.addEventListener("change", async () => {
        const value = select.value;
        select.disabled = true;
        try {
          if (await beforeChange(key, value)) apply({ [key]: value }, key);
          else syncSettingsControls(root);
        } finally {
          select.disabled = false;
        }
      });
    });
    root.querySelectorAll(".sb-volume-icon").forEach((btn) => {
      btn.addEventListener("click", () => {
        const current2 = state.settings.previewVolume;
        if (current2 > 0) {
          volumeBeforeMute = current2;
          apply({ previewVolume: 0 }, "previewVolume");
        } else {
          apply({ previewVolume: volumeBeforeMute ?? DEFAULT_UNMUTE_VOLUME }, "previewVolume");
        }
      });
    });
    root.querySelectorAll(".sb-tabs .nav-link").forEach((link) => {
      link.addEventListener("click", () => {
        const tab = link.dataset.tab;
        if (tab === activeTab) return;
        showTab(root, tab);
        onTabChange(tab);
      });
    });
  }

  // src/ui/exploreTab.ts
  var SEARCH_DEBOUNCE_MS = 150;
  var PAGE_CLICK_GUARD_MS = 700;
  var SORTS = [
    { value: "elo-desc", label: "ELO: highest first" },
    { value: "elo-asc", label: "ELO: lowest first" },
    { value: "plays-desc", label: "Most played" },
    { value: "plays-asc", label: "Least played" },
    { value: "battles-desc", label: "Most battles" },
    { value: "battles-asc", label: "Fewest battles" },
    { value: "record-desc", label: "Best record" },
    { value: "peak-desc", label: "Highest peak ELO" },
    { value: "streak-desc", label: "Longest win streak" }
  ];
  var filters = { ...DEFAULT_EXPLORE_FILTERS };
  var entries = [];
  var results = [];
  var page = 0;
  var ignoreCardClicksUntil = 0;
  var actions = null;
  function createExploreTab() {
    return `
      <div class="sb-tab-panel sb-explore-tab" data-panel="explore" hidden>
        <div id="sb-explore-content"></div>
      </div>
    `;
  }
  function setExploreFilters(patch) {
    filters = { ...DEFAULT_EXPLORE_FILTERS, ...patch };
    page = 0;
  }
  function isFiltered() {
    return filters.query.trim() !== "" || filters.group !== null || filters.eloMin !== null || filters.eloMax !== null;
  }
  function pageSize() {
    return state.settings.explorePageSize || Math.max(1, results.length);
  }
  function pageCount() {
    return Math.max(1, Math.ceil(results.length / pageSize()));
  }
  function controlsHtml() {
    const groups = [
      ...TIERS.map((t) => ({ value: t.id, label: `${t.emoji} ${t.name}` })),
      { value: "provisional", label: "Provisional" },
      { value: "unrated", label: "Unrated" }
    ];
    const chip = (value, label) => `<button type="button" class="sb-chip${filters.group === value ? " active" : ""}" data-group="${value ?? ""}">${label}</button>`;
    const number = (value) => value === null ? "" : String(value);
    return `
        <div class="sb-explore-controls">
          <div class="sb-explore-row">
            <input type="search" class="sb-explore-input sb-explore-search" placeholder="🔍  Search titles, studios, performers" value="${escapeHtml(filters.query)}" aria-label="Search scenes">
            <select class="sb-explore-input sb-explore-select sb-explore-sort" aria-label="Sort">
              ${SORTS.map((s) => `<option value="${s.value}"${s.value === filters.sort ? " selected" : ""}>${s.label}</option>`).join("")}
            </select>
          </div>
          <div class="sb-explore-row sb-explore-row-wrap">
            <div class="sb-chips">${chip(null, "All")}${groups.map((g) => chip(g.value, g.label)).join("")}</div>
            <div class="sb-explore-range">
              <span>ELO</span>
              <input type="number" class="sb-explore-input sb-explore-elo" data-bound="min" placeholder="from" value="${number(filters.eloMin)}" aria-label="Lowest ELO">
              <span>–</span>
              <input type="number" class="sb-explore-input sb-explore-elo" data-bound="max" placeholder="to" value="${number(filters.eloMax)}" aria-label="Highest ELO">
            </div>
          </div>
          <div class="sb-explore-status-row">
            <div class="sb-explore-status"></div>
            <div class="sb-explore-paging">
              <select class="sb-explore-input sb-explore-select sb-pager-select sb-explore-per-page" aria-label="Scenes per page">
                ${EXPLORE_PAGE_SIZES.map((n) => `<option value="${n}"${n === state.settings.explorePageSize ? " selected" : ""}>${n ? `${n} per page` : "All on one page"}</option>`).join("")}
              </select>
              <div class="sb-explore-pager"></div>
            </div>
          </div>
        </div>
        <div class="sb-explore-grid"></div>
        <div class="sb-explore-pager sb-explore-pager-bottom"></div>`;
  }
  function pagerHtml() {
    const pages = pageCount();
    if (pages <= 1) return "";
    const options2 = Array.from(
      { length: pages },
      (_, i) => `<option value="${i}"${i === page ? " selected" : ""}>Page ${i + 1} of ${pages}</option>`
    ).join("");
    return `
          <button type="button" class="sb-pager-btn" data-page-step="-1"${page === 0 ? " disabled" : ""} aria-label="Previous page">‹</button>
          <select class="sb-explore-input sb-explore-select sb-pager-select" aria-label="Page">${options2}</select>
          <button type="button" class="sb-pager-btn" data-page-step="1"${page >= pages - 1 ? " disabled" : ""} aria-label="Next page">›</button>`;
  }
  function showPage(content) {
    stopMiniPreview();
    page = Math.min(Math.max(0, page), pageCount() - 1);
    const grid = content.querySelector(".sb-explore-grid");
    if (grid) {
      grid.innerHTML = results.length ? results.slice(page * pageSize(), (page + 1) * pageSize()).map((entry) => miniCardHtml(entry)).join("") : `<p class="sb-stats-empty">No scenes match.</p>`;
    }
    content.querySelectorAll(".sb-explore-pager").forEach((pager) => pager.innerHTML = pagerHtml());
  }
  function filterLabel() {
    const parts = [];
    const tier = TIERS.find((t) => t.id === filters.group);
    if (tier) parts.push(`${tier.emoji} ${tier.name}`);
    else if (filters.group === "provisional") parts.push("Provisional");
    else if (filters.group === "unrated") parts.push("Unrated");
    if (filters.eloMin !== null || filters.eloMax !== null) {
      parts.push(`ELO ${filters.eloMin ?? "…"}–${filters.eloMax ?? "…"}`);
    }
    if (filters.query.trim()) parts.push(`“${escapeHtml(filters.query.trim())}”`);
    return parts.join(" · ");
  }
  function battleButtonHtml() {
    if (!isFiltered() || results.length === 0) return "";
    const within = filterBattlesWithin(filters, state.settings.filterOpponents);
    const n = results.length;
    const scenes2 = `${n} scene${n === 1 ? "" : "s"}`;
    const label = filters.group === "unrated" ? `📍 Place these ${scenes2}` : filters.group === "provisional" ? `🔁 Keep testing these ${scenes2}` : `⚔️ Battle these ${scenes2}`;
    const tip = filters.group === "unrated" ? "Placement, one scene at a time, against your whole library" : within ? "Swiss, with both sides from these scenes (“Use filtered scenes for both sides” is on)" : "Swiss, these scenes against your whole library (turn on “Use filtered scenes for both sides” in Settings to keep both sides in the filter)";
    const disabled = within && n < 2 ? " disabled" : "";
    return `<button type="button" class="btn btn-primary btn-sm sb-explore-battle" data-explore-battle title="${tip}"${disabled}>${label}</button>`;
  }
  function applyFilters(content, keepPage = false) {
    results = filterExplore(entries, filters);
    if (!keepPage) page = 0;
    const status = content.querySelector(".sb-explore-status");
    if (status) {
      status.innerHTML = `<span>${results.length === entries.length ? `${entries.length} scenes` : `${results.length} of ${entries.length} scenes`}${isFiltered() ? ` · <a href="#" data-explore-clear>Clear filters</a>` : ""}</span>${battleButtonHtml()}`;
    }
    showPage(content);
  }
  function goToPage(content, scrollRoot, next) {
    page = next;
    showPage(content);
    ignoreCardClicksUntil = Date.now() + PAGE_CLICK_GUARD_MS;
    const controls = content.querySelector(".sb-explore-controls");
    if (!scrollRoot || !controls) return;
    const offset = controls.getBoundingClientRect().top - scrollRoot.getBoundingClientRect().top;
    if (offset < 0) scrollRoot.scrollTop += offset;
  }
  function bindControls(content, scrollRoot) {
    let searchTimer = null;
    content.querySelector(".sb-explore-search")?.addEventListener("input", (e) => {
      filters.query = e.target.value;
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => applyFilters(content), SEARCH_DEBOUNCE_MS);
    });
    content.querySelector(".sb-explore-sort")?.addEventListener("change", (e) => {
      filters.sort = e.target.value;
      applyFilters(content);
    });
    content.querySelectorAll(".sb-explore-elo").forEach((input) => {
      input.addEventListener("change", () => {
        const value = input.value.trim() === "" ? null : Number(input.value);
        const bound = Number.isFinite(value) ? value : null;
        if (input.dataset.bound === "min") filters.eloMin = bound;
        else filters.eloMax = bound;
        applyFilters(content);
      });
    });
    if (content.dataset.bound === "1") return;
    content.dataset.bound = "1";
    content.addEventListener("click", (e) => onContentClick(e, content, scrollRoot));
    content.addEventListener("change", (e) => {
      const select = e.target;
      if (select.classList.contains("sb-explore-per-page")) {
        updateSettings({ explorePageSize: Number(select.value) });
        goToPage(content, scrollRoot, 0);
      } else if (select.classList.contains("sb-pager-select")) {
        goToPage(content, scrollRoot, Number(select.value));
      }
    });
    content.addEventListener("mouseover", (e) => {
      if (isTouchDevice()) return;
      const card = e.target.closest(".sb-mini-card[data-preview]");
      if (card) startMiniPreview(card);
    });
    content.addEventListener("mouseout", (e) => {
      const playing = miniPreviewCard();
      if (playing && content.contains(playing) && !playing.contains(e.relatedTarget)) stopMiniPreview();
    });
  }
  function onContentClick(e, content, scrollRoot) {
    const target = e.target;
    const chip = target.closest(".sb-chip");
    if (chip) {
      filters.group = chip.dataset.group || null;
      content.querySelectorAll(".sb-chip").forEach((c) => c.classList.toggle("active", c === chip));
      applyFilters(content);
      return;
    }
    if (target.closest("[data-explore-clear]")) {
      e.preventDefault();
      filters = { ...DEFAULT_EXPLORE_FILTERS, sort: filters.sort };
      render(content, scrollRoot);
      return;
    }
    const step = target.closest("[data-page-step]");
    if (step) {
      goToPage(content, scrollRoot, page + Number(step.dataset.pageStep));
      return;
    }
    if (Date.now() < ignoreCardClicksUntil && target.closest(".sb-mini-card")) {
      e.preventDefault();
      return;
    }
    if (target.closest("[data-explore-battle]")) {
      stopMiniPreview();
      actions?.battleFilter(filters, filterLabel());
      return;
    }
    if (handleMiniMuteTap(e) || handleMiniThumbTap(e)) return;
    const battle = target.closest("[data-battle]");
    if (battle?.dataset.battle) {
      stopMiniPreview();
      actions?.battleScene(battle.dataset.battle);
      return;
    }
    const link = target.closest(".sb-mini-link");
    if (link) {
      stopMiniPreview();
      handleSceneLinkClick(e, link);
    }
  }
  function render(content, scrollRoot) {
    content.innerHTML = controlsHtml();
    bindControls(content, scrollRoot);
    applyFilters(content, true);
  }
  async function renderExploreTab(modal, tabActions) {
    actions = tabActions;
    const content = modal.querySelector("#sb-explore-content");
    if (!content) return;
    if (isEloSetupPending()) {
      content.innerHTML = `<p class="sb-stats-empty">Explore opens once the ELO setup on the Battle tab is done.</p>`;
      return;
    }
    content.innerHTML = `<div class="sb-loading">Loading scenes...</div>`;
    let scenes2;
    try {
      scenes2 = (await getAllScenesCached()).scenes ?? [];
    } catch (e) {
      console.error("[Stash Battle] Couldn't load scenes for Explore:", e);
      content.innerHTML = `<p class="sb-stats-empty">Couldn't load your scenes. Switch tabs to try again.</p>`;
      return;
    }
    entries = exploreEntries(scenes2, tierMap(scenes2), resolveSceneTitle);
    render(content, modal.querySelector(".sb-modal-content"));
  }

  // src/ui/recordsTab.ts
  var RECORDS_TOP = 5;
  var HALL_OF_FAME_SHOWN = 10;
  var entriesById = /* @__PURE__ */ new Map();
  var battleScene = () => {
  };
  function createRecordsTab() {
    return `
      <div class="sb-tab-panel sb-records-tab" data-panel="records" hidden>
        <div id="sb-records-content"></div>
      </div>
    `;
  }
  function shortDate(iso) {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(void 0, { year: "numeric", month: "short", day: "numeric" });
  }
  function fullDate(iso) {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(void 0, { dateStyle: "medium", timeStyle: "short" });
  }
  function recordRow(title, items, empty, shown = Infinity) {
    const cards = items.filter(({ scene }) => entriesById.has(scene.id)).map(({ scene, caption, tip }, i) => {
      const extra = i >= shown ? " sb-record-extra" : "";
      return `<div class="sb-record-item${extra}"${extra ? " hidden" : ""}><div class="sb-record-caption"${tip ? ` title="${tip}"` : ""}>${caption}</div>${miniCardHtml(entriesById.get(scene.id))}</div>`;
    });
    const more = cards.length > shown ? ` <a href="#" class="sb-record-more" data-records-more>Show all (${cards.length})</a>` : "";
    return `
        <div class="setting-section sb-stats-section">
          <h1>${title}${more}</h1>
          <div class="card">
            ${cards.length ? `<div class="sb-record-cards">${cards.join("")}</div>` : `<p class="sb-stats-muted">${empty}</p>`}
          </div>
        </div>`;
  }
  function recordsHtml(scenes2) {
    const byId = new Map(scenes2.map((s) => [s.id, s]));
    const hall = [...getHallOfFame()].sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).map((e) => ({ scene: byId.get(e.id), date: e.date })).filter((e) => e.scene !== void 0).map(({ scene, date }) => ({ scene, caption: `👑 #1 since ${shortDate(date)}`, tip: `First reached #1 on ${fullDate(date)}` }));
    const streaks = topByRecord(scenes2, (r) => r.bestStreak, RECORDS_TOP).map(({ scene, record }) => ({
      scene,
      caption: `🔥 ${plural(record.bestStreak, "win")} in a row`
    }));
    const peaks = topByRecord(scenes2, (r) => r.peak, RECORDS_TOP).map(({ scene, record }) => ({
      scene,
      caption: `📈 Peak ELO ${Math.round(record.peak)}`
    }));
    return `
        <div class="sb-records">
          ${recordRow("👑 Hall of fame", hall, "No scene has been #1 yet.", HALL_OF_FAME_SHOWN)}
          ${recordRow("🔥 Longest win streaks", streaks, "No win streaks yet: records start counting with your next battle.")}
          ${recordRow("📈 Highest peak ELO", peaks, "No peaks yet: records start counting with your next battle.")}
          <p class="sb-stats-note">Records count battles since they began; earlier battles only add to a scene's battle count.</p>
        </div>`;
  }
  function onClick(e) {
    const target = e.target;
    const more = target.closest("[data-records-more]");
    if (more) {
      e.preventDefault();
      more.closest(".sb-stats-section")?.querySelectorAll(".sb-record-extra").forEach((card) => card.hidden = false);
      more.remove();
      return;
    }
    if (handleMiniMuteTap(e) || handleMiniThumbTap(e)) return;
    const battle = target.closest("[data-battle]");
    if (battle?.dataset.battle) {
      stopMiniPreview();
      battleScene(battle.dataset.battle);
      return;
    }
    const link = target.closest(".sb-mini-link");
    if (link) {
      stopMiniPreview();
      handleSceneLinkClick(e, link);
    }
  }
  function bindEvents(content) {
    if (content.dataset.bound === "1") return;
    content.dataset.bound = "1";
    content.addEventListener("click", onClick);
    content.addEventListener("mouseover", (e) => {
      if (isTouchDevice()) return;
      const card = e.target.closest(".sb-mini-card[data-preview]");
      if (card) startMiniPreview(card);
    });
    content.addEventListener("mouseout", (e) => {
      const playing = miniPreviewCard();
      if (playing && content.contains(playing) && !playing.contains(e.relatedTarget)) stopMiniPreview();
    });
  }
  async function renderRecordsTab(modal, onBattleScene) {
    battleScene = onBattleScene;
    const content = modal.querySelector("#sb-records-content");
    if (!content) return;
    if (isEloSetupPending()) {
      content.innerHTML = `<p class="sb-stats-empty">Records show once the ELO setup on the Battle tab is done.</p>`;
      return;
    }
    if (!content.querySelector(".sb-records")) content.innerHTML = `<div class="sb-loading">Loading records...</div>`;
    let scenes2;
    try {
      scenes2 = (await getAllScenesCached()).scenes ?? [];
    } catch (e) {
      console.error("[Stash Battle] Couldn't load scenes for records:", e);
      content.innerHTML = `<p class="sb-stats-empty">Couldn't load your scenes. Switch tabs to try again.</p>`;
      return;
    }
    noteTopScene();
    entriesById = new Map(exploreEntries(scenes2, cachedTierMap(scenes2), resolveSceneTitle).map((entry) => [entry.scene.id, entry]));
    content.innerHTML = recordsHtml(scenes2);
    bindEvents(content);
  }

  // src/ui/statsTab.ts
  var BUCKET_SIZE = 25;
  var NARROW_BUCKET_SIZE = 50;
  var NARROW_CHART_PX = 500;
  var TIE_NOTE_MIN = 10;
  var PLAY_TICKS = [0, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1e3];
  var scenes = [];
  var entriesById2 = /* @__PURE__ */ new Map();
  var actions2 = null;
  var resizeBound = false;
  function createStatsTab() {
    return `
      <div class="sb-tab-panel sb-stats-tab" data-panel="stats" hidden>
        <div id="sb-stats-content"></div>
      </div>
    `;
  }
  function niceStep(rough) {
    const power = Math.pow(10, Math.floor(Math.log10(Math.max(rough, 1))));
    for (const m of [1, 2, 5, 10]) if (m * power >= rough) return m * power;
    return 10 * power;
  }
  function barPath(x, y, w, h) {
    const r = Math.min(3, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }
  function section(title, body, id = "") {
    return `
        <div class="setting-section sb-stats-section"${id ? ` id="${id}"` : ""}>
          <h1>${title}</h1>
          <div class="card">${body}</div>
        </div>`;
  }
  function overviewHtml() {
    const o = overview(scenes);
    const tile = (value, label, tip) => `<div class="sb-stat-tile" title="${tip}"><div class="sb-stat-value">${value.toLocaleString()}</div><div class="sb-stat-label">${label}</div></div>`;
    return `<div class="sb-stat-tiles">
          ${tile(o.rated, "Scenes with an ELO", "Scenes Stash Battle has an ELO for")}
          ${tile(o.unrated, "Unrated", "Scenes with no ELO yet: they get one after their first battle, or from Placement")}
          ${tile(o.provisional, "Provisional", `Fewer than ${ELO_K_TIERS[0][0]} battles, so their ELO is still settling (shown with a “?”)`)}
          ${tile(o.battles, "Battles", "Every scene's battle count added up, so a battle counts once for each scene in it")}
        </div>`;
  }
  function histogramSvg(width) {
    const size = width < NARROW_CHART_PX ? NARROW_BUCKET_SIZE : BUCKET_SIZE;
    const buckets = eloHistogram(scenes, size);
    if (buckets.length === 0) return "";
    const mode = state.settings.stashRatings;
    const ticks = ratingScaleTicks(scenes, mode, scaleMarks());
    let lo = buckets[0].from;
    let hi = buckets[buckets.length - 1].from + size;
    for (const t of ticks) {
      lo = Math.min(lo, Math.floor(t.elo / size) * size);
      hi = Math.max(hi, Math.ceil((t.elo + 1) / size) * size);
    }
    const m = { left: 40, right: 12, top: 10 };
    const plotW = width - m.left - m.right;
    const plotH = width < 500 ? 120 : 170;
    const axisH = 22;
    const scaleH = ticks.length > 0 ? 46 : 0;
    const height = m.top + plotH + axisH + scaleH;
    const x = (value) => m.left + (value - lo) / (hi - lo) * plotW;
    const maxCount = Math.max(...buckets.map((b) => b.count));
    const step = niceStep(maxCount / 3);
    const yMax = Math.max(step, Math.ceil(maxCount / step) * step);
    const y = (count) => m.top + plotH - count / yMax * plotH;
    const base = m.top + plotH;
    const parts = [];
    if (mode === "linear" && ticks.length > 0) {
      const first = ticks[0];
      const last = ticks[ticks.length - 1];
      if (lo < first.elo) {
        parts.push(
          `<rect class="sb-chart-clamp" x="${x(lo)}" y="${m.top}" width="${x(first.elo) - x(lo)}" height="${plotH}" data-tip="Below ${first.elo}, every ELO is a Stash rating of ${formatRating(first.rating, true)}"/>`
        );
      }
      if (hi > last.elo) {
        parts.push(
          `<rect class="sb-chart-clamp" x="${x(last.elo)}" y="${m.top}" width="${x(hi) - x(last.elo)}" height="${plotH}" data-tip="Above ${last.elo}, every ELO is a Stash rating of ${formatRating(last.rating, true)}"/>`
        );
      }
    }
    for (let v = 0; v <= yMax; v += step) {
      parts.push(`<line class="sb-chart-grid" x1="${m.left}" x2="${width - m.right}" y1="${y(v)}" y2="${y(v)}"/>`);
      parts.push(`<text class="sb-chart-label" x="${m.left - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`);
    }
    for (const b of buckets) {
      const x0 = x(b.from);
      const w = x(b.from + size) - x0;
      const tip = `ELO ${b.from}–${b.from + size - 1}: ${plural(b.count, "scene")}`;
      const bar = b.count > 0 ? `<path class="sb-chart-bar" d="${barPath(x0 + 1, y(b.count), Math.max(1, w - 2), base - y(b.count))}"/>` : "";
      parts.push(`<g class="sb-chart-hit" data-tip="${tip}${b.count ? " · click to see them" : ""}" data-from="${b.from}" data-to="${b.from + size - 0.1}"><rect x="${x0}" y="${m.top}" width="${w}" height="${plotH}" fill="transparent"/>${bar}</g>`);
    }
    parts.push(`<line class="sb-chart-axis" x1="${m.left}" x2="${width - m.right}" y1="${base}" y2="${base}"/>`);
    const labelStep = plotW / ((hi - lo) / 100) >= 44 ? 100 : 200;
    for (let v = Math.ceil(lo / labelStep) * labelStep; v <= hi; v += labelStep) {
      parts.push(`<text class="sb-chart-label" x="${x(v)}" y="${base + 16}" text-anchor="middle">${v}</text>`);
    }
    if (ticks.length > 0) {
      const top = base + axisH;
      const lineY = top + 20;
      parts.push(`<text class="sb-chart-caption" x="${m.left}" y="${top + 10}">Stash rating (${stashRatingsOption(mode).label})</text>`);
      parts.push(`<line class="sb-chart-scale" x1="${x(ticks[0].elo)}" x2="${x(ticks[ticks.length - 1].elo)}" y1="${lineY}" y2="${lineY}"/>`);
      for (const t of ticks) {
        parts.push(`<line class="sb-chart-scale" x1="${x(t.elo)}" x2="${x(t.elo)}" y1="${lineY - 4}" y2="${lineY + 4}"/>`);
        parts.push(
          `<text class="sb-chart-label sb-chart-scale-label" x="${x(t.elo)}" y="${lineY + 18}" text-anchor="middle" data-tip="Stash rating ${formatRating(t.rating, true)} at ELO ${Math.round(t.elo)}">${formatRating(t.rating)}</text>`
        );
      }
    }
    return `<svg class="sb-chart-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="How many scenes have each ELO">${parts.join("")}</svg>`;
  }
  function distributionNote() {
    const notes = [];
    const tie = largestTie(scenes);
    if (tie && tie.count >= TIE_NOTE_MIN) {
      notes.push(`${tie.count} scenes are still tied at ELO ${Math.round(tie.elo)}.`);
    }
    if (state.settings.stashRatings === "off") {
      notes.push("Stash ratings aren't being updated, so there's no rating scale under the chart.");
    } else if (state.settings.stashRatings === "percentile") {
      notes.push("Percentile spreads ratings across the whole scale by rank, so the scale follows your library.");
    }
    return notes.length ? `<p class="sb-stats-note">${notes.join(" ")}</p>` : "";
  }
  function jitter(id, range) {
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = hash * 31 + id.charCodeAt(i) | 0;
    return (Math.abs(hash) % 1e3 / 1e3 - 0.5) * 2 * range;
  }
  function scatterSvg(width, split) {
    const rated = scenes.map((scene) => ({ scene, elo: elo(scene) })).filter((s) => s.elo !== null);
    if (rated.length < 2) return "";
    const m = { left: 44, right: 14, top: 12, bottom: 34 };
    const height = width < 500 ? 260 : 340;
    const plotW = width - m.left - m.right;
    const plotH = height - m.top - m.bottom;
    const maxPlays = Math.max(1, ...rated.map((s) => s.scene.play_count ?? 0));
    const elos = rated.map((s) => s.elo);
    const lo = Math.floor((Math.min(...elos) - 1) / 100) * 100;
    const hi = Math.ceil((Math.max(...elos) + 1) / 100) * 100;
    const x = (plays) => m.left + Math.sqrt(plays) / Math.sqrt(maxPlays) * plotW;
    const y = (value) => m.top + (hi - value) / (hi - lo) * plotH;
    const base = m.top + plotH;
    const parts = [];
    const eloStep = plotH / ((hi - lo) / 100) >= 26 ? 100 : 200;
    for (let v = Math.ceil(lo / eloStep) * eloStep; v <= hi; v += eloStep) {
      parts.push(`<line class="sb-chart-grid" x1="${m.left}" x2="${width - m.right}" y1="${y(v)}" y2="${y(v)}"/>`);
      parts.push(`<text class="sb-chart-label" x="${m.left - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`);
    }
    let lastTickX = -Infinity;
    for (const plays of PLAY_TICKS.filter((p) => p <= maxPlays)) {
      if (x(plays) - lastTickX < 30) continue;
      lastTickX = x(plays);
      parts.push(`<text class="sb-chart-label" x="${x(plays)}" y="${base + 16}" text-anchor="middle">${plays}</text>`);
    }
    parts.push(`<line class="sb-chart-axis" x1="${m.left}" x2="${width - m.right}" y1="${base}" y2="${base}"/>`);
    parts.push(`<text class="sb-chart-caption" x="${width - m.right}" y="${base + 30}" text-anchor="end">Play count →</text>`);
    parts.push(`<text class="sb-chart-caption" x="${m.left + 6}" y="${m.top + plotH / 2}" transform="rotate(-90 ${m.left - 32} ${m.top + plotH / 2})" text-anchor="middle" dx="-38">ELO</text>`);
    parts.push(`<line class="sb-chart-split" x1="${x(split.plays)}" x2="${x(split.plays)}" y1="${m.top}" y2="${base}"/>`);
    parts.push(`<line class="sb-chart-split" x1="${m.left}" x2="${width - m.right}" y1="${y(split.elo)}" y2="${y(split.elo)}"/>`);
    for (const { scene, elo: value } of rated) {
      const plays = scene.play_count ?? 0;
      const spread = Math.max(3, (x(plays + 1) - x(plays)) * 0.3);
      const offset = plays === 0 ? Math.abs(jitter(scene.id, spread)) : jitter(scene.id, spread);
      const cx = Math.min(width - m.right, x(plays) + offset);
      const cy = y(value) + jitter(`${scene.id}y`, 2);
      parts.push(`<circle class="sb-dot" cx="${cx}" cy="${cy}" r="4" data-id="${scene.id}"/>`);
    }
    parts.push(`<text class="sb-chart-quadrant" x="${m.left + 8}" y="${m.top + 16}">💎 Hidden gems</text>`);
    parts.push(`<text class="sb-chart-quadrant" x="${width - m.right - 8}" y="${base - 10}" text-anchor="end">Overplayed</text>`);
    return `<svg class="sb-chart-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="ELO against play count">${parts.join("")}</svg>`;
  }
  var leastTestedScenes = [];
  var leastTestedFiltered = false;
  function leastTestedText() {
    const pool = leastTestedPool(leastTestedScenes);
    if (!pool) return "";
    const rated = pool.count - pool.unrated;
    const who = pool.battles === 0 ? `${rated} with an ELO (the “No battles yet” bar)${pool.unrated > 0 ? ` and ${pool.unrated} unrated` : ""}.` : `The fewest battles any scene has is ${pool.battles}, and ${plural(pool.count, "scene")} have that many.`;
    return leastTestedFiltered ? `${who} From your Scenes page filter.` : who;
  }
  function settledHtml() {
    const buckets = settledBuckets(scenes);
    const max = Math.max(1, ...buckets.map((b) => b.count));
    const label = (min, max2) => {
      if (max2 === 0) return "No battles yet";
      if (max2 === null) return `${min}+ battles`;
      return `${min}–${max2} battles`;
    };
    const rows = buckets.map(
      (b) => `
          <div class="sb-settled-row" title="${plural(b.count, "scene")} with ${label(b.min, b.max).toLowerCase()}">
            <span class="sb-settled-label">${label(b.min, b.max)}</span>
            <span class="sb-settled-track"><span class="sb-settled-bar" style="width: ${b.count / max * 100}%"></span></span>
            <span class="sb-settled-count">${b.count}</span>
          </div>`
    ).join("");
    const { provisional } = overview(scenes);
    const provisionalText = provisional > 0 ? `<strong>${plural(provisional, "scene")}</strong> ${provisional === 1 ? "is" : "are"} still provisional: fewer than ${ELO_K_TIERS[0][0]} battles, so ${provisional === 1 ? "its" : "their"} ELO still moves a lot with each battle.` : `No scene is provisional. Scenes seeded from your star ratings start with a ${ELO_K_TIERS[0][0]}-battle head start, so only scenes that started without one can be.`;
    return `
          <div class="sb-settled">${rows}</div>
          <p class="sb-stats-note">${provisionalText}</p>
          <div class="sb-stats-actions">
            <button type="button" class="btn btn-secondary btn-sm" data-stats-action="least-tested">Battle the least-tested (${plural(leastTestedPool(leastTestedScenes)?.count ?? 0, "scene")})</button>
            <span class="sb-stats-muted">${leastTestedText()}</span>
          </div>`;
  }
  function drawCharts(root) {
    const histogram = root.querySelector("#sb-stats-histogram");
    if (histogram) histogram.innerHTML = histogramSvg(histogram.clientWidth) + '<div class="sb-chart-tip" hidden></div>';
    const scatter = root.querySelector("#sb-stats-scatter");
    const split = gemsSplit(scenes);
    if (scatter && split) scatter.innerHTML = scatterSvg(scatter.clientWidth, split) + '<div class="sb-chart-tip" hidden></div>';
  }
  function placeTip(chart, tip, at, card) {
    const box = chart.getBoundingClientRect();
    const x = at.clientX - box.left;
    const y = at.clientY - box.top;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const clamp = (value, max) => Math.max(0, Math.min(value, max));
    if (card) {
      const left = x + 16 + w <= box.width ? x + 16 : x - 16 - w;
      tip.style.left = `${clamp(left, box.width - w)}px`;
      tip.style.top = `${clamp(y - h / 2, box.height - h)}px`;
      return;
    }
    const above = y - h - 12;
    tip.style.left = `${clamp(x + 14, box.width - w - 4)}px`;
    tip.style.top = `${above >= 0 ? above : y + 18}px`;
  }
  function bindTooltips(chart) {
    const show = (e) => {
      const tip = chart.querySelector(".sb-chart-tip");
      if (!tip || isTouchDevice()) return;
      const target = e.target;
      const dot = target.closest(".sb-dot");
      const entry = dot?.dataset.id ? entriesById2.get(dot.dataset.id) : void 0;
      if (entry) {
        if (tip.dataset.cardFor !== entry.scene.id) {
          tip.dataset.cardFor = entry.scene.id;
          tip.innerHTML = miniCardHtml(entry, false);
        }
        tip.classList.add("sb-chart-tip-card");
      } else {
        const text = target.closest("[data-tip]")?.getAttribute("data-tip");
        if (!text) {
          delete tip.dataset.cardFor;
          tip.hidden = true;
          return;
        }
        delete tip.dataset.cardFor;
        tip.classList.remove("sb-chart-tip-card");
        tip.textContent = text;
      }
      tip.hidden = false;
      placeTip(chart, tip, e, Boolean(entry));
    };
    chart.addEventListener("pointermove", show);
    chart.addEventListener("pointerleave", () => {
      const tip = chart.querySelector(".sb-chart-tip");
      if (!tip || tip.classList.contains("sb-chart-tip-pinned")) return;
      tip.hidden = true;
      delete tip.dataset.cardFor;
    });
  }
  function openScene(sceneId, e) {
    const url = sceneUrl(sceneId);
    if (state.settings.openInNewTab || e.ctrlKey || e.metaKey || e.shiftKey) window.open(url, "_blank", "noopener");
    else navigateToUrl(url);
  }
  function pinCard(dot, entry) {
    pinTip(dot, miniCardHtml(entry), true);
  }
  function pinTip(anchor, html, card) {
    const chart = anchor.closest(".sb-chart");
    const tip = chart?.querySelector(".sb-chart-tip");
    if (!chart || !tip) return;
    tip.innerHTML = html;
    tip.classList.toggle("sb-chart-tip-card", card);
    tip.classList.add("sb-chart-tip-pinned");
    tip.hidden = false;
    const r = anchor.getBoundingClientRect();
    placeTip(chart, tip, { clientX: r.left + r.width / 2, clientY: r.top + Math.min(r.height / 2, 40) }, card);
  }
  function unpinCard(root) {
    root.querySelectorAll(".sb-chart-tip-pinned").forEach((tip) => {
      tip.classList.remove("sb-chart-tip-pinned");
      tip.hidden = true;
    });
  }
  function onContentClick2(e) {
    const target = e.target;
    const root = e.currentTarget;
    if (!actions2) return;
    if (target.closest(".sb-chart-tip-pinned")) {
      const battle = target.closest("[data-battle]");
      const link = target.closest(".sb-mini-link");
      const explore = target.closest("[data-explore-from]");
      if (battle?.dataset.battle) actions2.battleScene(battle.dataset.battle);
      else if (link) handleSceneLinkClick(e, link);
      else if (explore) actions2.exploreRange(Number(explore.dataset.exploreFrom), Number(explore.dataset.exploreTo));
      return;
    }
    const bar = target.closest("[data-from]");
    if (bar?.dataset.from && bar.querySelector(".sb-chart-bar")) {
      const from = Number(bar.dataset.from);
      const to = Number(bar.dataset.to);
      if (isTouchDevice()) {
        const text = (bar.dataset.tip ?? "").replace(/ · click to see them$/, "");
        pinTip(bar, `<div class="sb-chart-tip-text">${text}</div><button type="button" class="btn btn-primary btn-sm" data-explore-from="${from}" data-explore-to="${to}">🔎 See them in Explore</button>`, false);
        return;
      }
      unpinCard(root);
      actions2.exploreRange(from, to);
      return;
    }
    const dot = target.closest(".sb-dot");
    const entry = dot?.dataset.id ? entriesById2.get(dot.dataset.id) : void 0;
    if (dot && entry && isTouchDevice()) {
      pinCard(dot, entry);
      return;
    }
    unpinCard(root);
    if (dot?.dataset.id) {
      openScene(dot.dataset.id, e);
      return;
    }
    if (target.closest("[data-stats-action='least-tested']")) actions2.battleLeastTested();
  }
  function bindEvents2(root) {
    root.querySelectorAll(".sb-chart").forEach(bindTooltips);
    if (root.dataset.bound !== "1") {
      root.dataset.bound = "1";
      root.addEventListener("click", onContentClick2);
    }
    if (!resizeBound) {
      resizeBound = true;
      let timer = null;
      window.addEventListener("resize", () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          const panel = document.querySelector("#sb-modal .sb-stats-tab:not([hidden])");
          if (panel && scenes.length > 0) drawCharts(panel);
        }, 150);
      });
    }
  }
  async function renderStatsTab(modal, statsActions2) {
    actions2 = statsActions2;
    const panel = modal.querySelector(".sb-stats-tab");
    const content = modal.querySelector("#sb-stats-content");
    if (!panel || !content) return;
    if (isEloSetupPending()) {
      content.innerHTML = `<p class="sb-stats-empty">Stats show once the ELO setup on the Battle tab is done.</p>`;
      return;
    }
    if (!content.querySelector(".sb-stats-section")) content.innerHTML = `<div class="sb-loading">Loading stats...</div>`;
    try {
      scenes = (await getAllScenesCached()).scenes ?? [];
    } catch (e) {
      console.error("[Stash Battle] Couldn't load scenes for stats:", e);
      content.innerHTML = `<p class="sb-stats-empty">Couldn't load your scenes. Switch tabs to try again.</p>`;
      return;
    }
    try {
      ({ scenes: leastTestedScenes, filtered: leastTestedFiltered } = await leastTestedSource());
    } catch {
      leastTestedScenes = scenes;
      leastTestedFiltered = false;
    }
    if (!scenes.some((s) => elo(s) !== null)) {
      content.innerHTML = `<p class="sb-stats-empty">No scene has an ELO yet.</p>`;
      return;
    }
    const tiers = tierMap(scenes);
    entriesById2 = new Map(exploreEntries(scenes, tiers, resolveSceneTitle).map((entry) => [entry.scene.id, entry]));
    content.innerHTML = [
      section("Overview", overviewHtml()),
      section("How settled the rankings are", settledHtml()),
      section(
        "ELO distribution",
        `<div class="sb-chart" id="sb-stats-histogram"></div>${distributionNote()}<p class="sb-stats-note">Click a bar to see its scenes in Explore.</p>`
      ),
      section(
        "Hidden gems and overplayed",
        `<p class="sb-stats-note sb-stats-intro">Each dot is a scene: higher is a better ELO, further right is played more. The dashed lines are the middle of your library. Hover a dot to see the scene; click it to open it.</p>
          <div class="sb-chart" id="sb-stats-scatter"></div>`
      )
    ].join("");
    drawCharts(panel);
    bindEvents2(content);
  }

  // src/ui/mainUI.ts
  var MODES2 = [
    {
      mode: "swiss",
      icon: "⚖️",
      title: "Swiss",
      desc: "Fair matchups",
      tip: "Each scene faces an opponent with a similar ELO. Both scenes' ELO changes after every pick, and every scene stays in the rotation."
    },
    {
      mode: "placement",
      icon: "📍",
      title: "Placement",
      desc: "Place a scene",
      tip: "Finds where one scene belongs. Each pick narrows the range of ranks it could land in (shown on its card) until its spot is found, about 10 picks for an unrated scene.\n\nLooking for Gauntlet? Turn on “Placement: start from the bottom” in Settings to make a scene climb the ladder from the bottom."
    },
    {
      mode: "champion",
      icon: "🏆",
      title: "Champion",
      desc: "Winner stays on",
      tip: "Winner stays on: the scene you pick keeps defending against new challengers until it's beaten, then the winner takes over. Both scenes' ELO changes after every pick."
    }
  ];
  function createMainUI() {
    const modeButtons = MODES2.map(
      ({ mode, icon, title, desc, tip }) => `
            <button class="sb-mode-btn ${state.currentMode === mode ? "active" : ""}" data-mode="${mode}" data-tip="${tip}" aria-description="${tip}">
              <span class="sb-mode-icon">${icon}</span>
              <span class="sb-mode-title">${title}</span>
              <span class="sb-mode-desc">${desc}</span>
            </button>`
    ).join("");
    return `
      <div id="stash-battle-container" class="sb-container">
        <div class="sb-header">
          <h1 class="sb-title">⚔️ Stash Battle</h1>
          ${createTabBar()}
        </div>

        <div class="sb-tab-panel" data-panel="battle">
          <div id="sb-setup-area" class="sb-setup-area" hidden></div>
          <div class="sb-mode-row">
            <div class="sb-mode-toggle">${modeButtons}
            </div>
            <button type="button" class="sb-mode-info-btn" aria-controls="sb-mode-info" aria-expanded="false" aria-label="What does this mode do?">ⓘ</button>
          </div>
          <p id="sb-mode-info" class="sb-mode-info" hidden></p>

          <p id="sb-climb-pool-warning" class="sb-climb-warning" hidden>
            Champion can behave oddly with small filtered pools when both sides use the filter
            (fewer than ${CLIMB_SMALL_POOL_WARN_AT} scenes). Use a larger filter, or turn off
            "Use filtered scenes for both sides" in Settings.
          </p>

          <p id="sb-pool-status" class="sb-pool-status" hidden></p>
          <p id="sb-ratings-note" class="sb-pool-status sb-ratings-note" hidden>
            Stash ratings aren't being changed · <a href="#" data-action="open-settings">change in Settings</a>
          </p>

          <div class="sb-content">
            <div id="sb-comparison-area" class="sb-comparison-area">
              <div class="sb-loading">Loading scenes...</div>
            </div>
            <div class="sb-actions">
              <div class="sb-action-buttons">
                <button id="sb-undo-btn" class="btn btn-secondary" title="Undo your last pick (Backspace)" disabled>↶ Undo</button>
                <button id="sb-skip-btn" class="btn btn-secondary">Skip</button>
                <button id="sb-refresh-cache-btn" class="btn btn-secondary" title="Refresh scene list from server (use if you've added new scenes)">🔄 Refresh</button>
              </div>
              <div class="sb-keyboard-hint">
                <span>←</span> choose left ·
                <span>→</span> choose right ·
                <span>Space</span> skip ·
                <span>⌫</span> undo
              </div>
            </div>
          </div>
        </div>

        ${createExploreTab()}
        ${createStatsTab()}
        ${createRecordsTab()}
        ${createSettingsTab()}
      </div>
    `;
  }
  function updateModeInfo() {
    const info = document.getElementById("sb-mode-info");
    const mode = MODES2.find((m) => m.mode === state.currentMode);
    if (info && mode) info.innerHTML = `<strong>${mode.icon} ${mode.title}:</strong> ${mode.tip.replace(/\n/g, "<br>")}`;
  }
  function updateRatingsNote() {
    const note = document.getElementById("sb-ratings-note");
    if (note) note.hidden = state.settings.stashRatings !== "off";
  }
  function filterOpponentsText() {
    return state.settings.filterOpponents ? " · against each other" : " · against your whole library";
  }
  function updatePoolStatus() {
    const status = document.getElementById("sb-pool-status");
    if (!status) return;
    const count = state.leftPoolSize;
    const countHtml = count === null ? "" : ` · <strong>${count} scene${count === 1 ? "" : "s"}</strong>`;
    const pool = state.explorePool;
    if (pool?.sceneId) {
      const scene = state.memoryCache.allScenes?.find((s) => s.id === pool.sceneId);
      const name = scene ? `: <strong>${escapeHtml(resolveSceneTitle(scene))}</strong>` : "";
      status.innerHTML = `Battling one scene${name} · against your whole library · <a href="#" data-action="stop-explore-pool">Stop</a>`;
    } else if (pool) {
      const against = explorePoolWithin() ? "against each other" : "against your whole library";
      status.innerHTML = `Battling from Explore: <strong>${pool.label}</strong>${countHtml} · ${against} · <a href="#" data-action="stop-explore-pool">Stop</a>`;
    } else if (state.leastTested) {
      const filtered = readFilters().filterActive;
      const from = filtered ? `your Scenes page filter${countHtml}${filterOpponentsText()}` : `your whole library${countHtml}`;
      status.innerHTML = `Battling your least-tested scenes first, from ${from} · <a href="#" data-action="stop-least-tested">Stop</a>`;
    } else if (readFilters().filterActive) {
      status.innerHTML = `Rating scenes from your Scenes page filter${countHtml}${filterOpponentsText()}`;
    } else {
      status.innerHTML = `Rating scenes from your whole library${countHtml}<span class="sb-pool-hint"> · filter the Scenes page to narrow it down</span>`;
    }
    status.hidden = false;
  }
  function climbStatusBadge(scene) {
    if (state.currentMode === "placement") {
      const run = state.placement;
      if (run?.scene.id !== scene.id) return null;
      if (run.fromBottom && run.battles > 0 && run.streak === run.battles) return run.streak;
      if (run.rangeHi === run.rangeLo) return null;
      return `📍 Narrowing between #${run.rangeLo + 1} and #${run.rangeHi + 1}`;
    }
    if (state.currentMode === "champion" && state.championScene?.id === scene.id) {
      return state.championWins;
    }
    return null;
  }
  function bindSceneChoice(body, choice) {
    body.addEventListener("click", () => handleSceneChoice(choice));
  }
  function setActionsVisible(visible) {
    const actionsEl = document.querySelector(".sb-actions");
    if (actionsEl) actionsEl.style.display = visible ? "" : "none";
  }
  function isTouchDevice() {
    return window.matchMedia("(hover: none)").matches;
  }
  function handleSceneLinkClick(e, link) {
    const nativeNewTab = link.target === "_blank" && state.settings.openInNewTab;
    if (nativeNewTab || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigateToUrl(link.getAttribute("href") || "");
  }
  function sliderToVolume(slider) {
    return Math.pow(slider / 100, 3);
  }
  function applyPreviewSettings() {
    const { previewVolume, autoplayPreviews } = state.settings;
    const battleVisible = getActiveTab() === "battle";
    document.querySelector(".sb-vs-container")?.classList.toggle("sb-autoplay", autoplayPreviews);
    document.querySelectorAll("#sb-comparison-area .sb-scene-card").forEach((card) => {
      const video = card.querySelector(".sb-hover-preview");
      if (!video) return;
      const hovered = !isTouchDevice() && card.matches(":hover");
      const active = hovered || card.classList.contains("sb-previewing");
      const muted = !active || previewVolume === 0 || card.classList.contains("sb-card-muted");
      video.volume = sliderToVolume(previewVolume);
      video.muted = muted;
      const button = card.querySelector(".sb-card-mute");
      if (button) {
        button.textContent = muted ? "🔇" : "🔊";
        button.setAttribute("aria-label", muted ? "Play this preview with sound" : "Mute this preview");
      }
      if (battleVisible && (autoplayPreviews || active)) {
        if (video.paused) video.play().catch(() => {
        });
      } else {
        video.pause();
        video.currentTime = 0;
      }
    });
  }
  function bindPreview(card) {
    const video = card.querySelector(".sb-hover-preview");
    if (!video) return;
    card.addEventListener("mouseenter", () => {
      if (isTouchDevice()) return;
      if (!state.settings.autoplayPreviews) video.currentTime = 0;
      video.volume = sliderToVolume(state.settings.previewVolume);
      video.muted = state.settings.previewVolume === 0;
      video.play().catch(() => {
      });
    });
    card.addEventListener("mouseleave", () => {
      if (isTouchDevice()) return;
      if (state.settings.autoplayPreviews) {
        video.muted = true;
        return;
      }
      video.pause();
      video.currentTime = 0;
    });
  }
  function togglePreview(card) {
    const previewing = !card.classList.contains("sb-previewing");
    document.querySelectorAll(".sb-scene-card.sb-previewing").forEach((c) => c.classList.remove("sb-previewing"));
    card.classList.toggle("sb-previewing", previewing);
    card.classList.remove("sb-card-muted");
    applyPreviewSettings();
  }
  function toggleCardSound(card) {
    const video = card.querySelector(".sb-hover-preview");
    if (video && !video.muted) {
      card.classList.add("sb-card-muted");
      applyPreviewSettings();
      return;
    }
    if (state.settings.previewVolume === 0) document.querySelector(".sb-volume-icon")?.click();
    if (card.classList.contains("sb-previewing")) {
      card.classList.remove("sb-card-muted");
      applyPreviewSettings();
    } else {
      togglePreview(card);
    }
  }
  function vsDivider(left, right) {
    if (state.currentMode === "placement") {
      return `<div class="sb-vs-divider"><span class="sb-vs-text">VS</span></div>`;
    }
    const [leftChance, rightChance] = winChances(battleElo(latestScene(left)), battleElo(latestScene(right)));
    const favoured = (chance) => chance > 50 ? " sb-favoured" : "";
    const tip = `Chance each scene wins, from their ELO: left ${leftChance}%, right ${rightChance}%`;
    return `
        <div class="sb-vs-divider">
          <div class="sb-vs-stack" title="${tip}">
            <span class="sb-win-chance sb-win-chance-left${favoured(leftChance)}">${leftChance}%</span>
            <span class="sb-vs-text">VS</span>
            <span class="sb-win-chance sb-win-chance-right${favoured(rightChance)}">${rightChance}%</span>
            <span class="sb-win-bar" aria-hidden="true"><span style="width: ${leftChance}%"></span></span>
          </div>
        </div>`;
  }
  function pairTiers(scenes2) {
    const library = state.memoryCache.allScenes;
    if (!library) return scenes2.map(() => null);
    const tiers = cachedTierMap(library);
    return scenes2.map((scene) => tiers.get(scene.id) ?? null);
  }
  function renderPair(scenes2, ranks) {
    const comparisonArea = document.getElementById("sb-comparison-area");
    if (!comparisonArea) return;
    const statusBadges = scenes2.map(climbStatusBadge);
    const tiers = pairTiers(scenes2);
    comparisonArea.innerHTML = `
      <div class="sb-vs-container">
        ${createSceneCard(scenes2[0], "left", ranks[0], statusBadges[0], tiers[0])}
        ${vsDivider(scenes2[0], scenes2[1])}
        ${createSceneCard(scenes2[1], "right", ranks[1], statusBadges[1], tiers[1])}
      </div>
    `;
    const left = scenes2[0];
    const right = scenes2[1];
    const leftCard = comparisonArea.querySelector('.sb-scene-card[data-side="left"]');
    const rightCard = comparisonArea.querySelector('.sb-scene-card[data-side="right"]');
    const leftBody = leftCard?.querySelector(".sb-scene-body");
    const rightBody = rightCard?.querySelector(".sb-scene-body");
    if (left && right && leftCard && rightCard && leftBody && rightBody) {
      bindSceneChoice(leftBody, {
        winner: left,
        loser: right,
        left,
        right,
        winnerCard: leftCard,
        loserCard: rightCard,
        winnerRank: ranks[0],
        loserRank: ranks[1]
      });
      bindSceneChoice(rightBody, {
        winner: right,
        loser: left,
        left,
        right,
        winnerCard: rightCard,
        loserCard: leftCard,
        winnerRank: ranks[1],
        loserRank: ranks[0]
      });
      leftCard.querySelector(".sb-delete-btn")?.addEventListener("click", () => void deleteFromBattle(left));
      rightCard.querySelector(".sb-delete-btn")?.addEventListener("click", () => void deleteFromBattle(right));
    }
    comparisonArea.querySelectorAll(".sb-scene-card").forEach((card) => {
      const thumb = card.querySelector(".sb-scene-image-container");
      thumb?.addEventListener("click", (e) => {
        if (isTouchDevice()) {
          e.preventDefault();
          togglePreview(card);
          return;
        }
        handleSceneLinkClick(e, thumb);
      });
      card.querySelector(".sb-card-mute")?.addEventListener("click", (e) => {
        e.preventDefault();
        toggleCardSound(card);
      });
      const openLink = card.querySelector(".sb-open-link");
      openLink?.addEventListener("click", (e) => {
        if (!state.settings.openInNewTab) handleSceneLinkClick(e, openLink);
      });
      bindPreview(card);
    });
    applyPreviewSettings();
    setActionsVisible(true);
    const skipBtn = document.querySelector("#sb-skip-btn");
    if (skipBtn) skipBtn.disabled = isRunActive();
    updateUndoButton();
  }
  function skipPair() {
    if (isRunActive() || state.disableChoice) return;
    state.disableChoice = true;
    if (state.currentMode !== "swiss") {
      resetRunState();
      saveState();
    }
    loadNewPair();
  }
  var pairLoads = 0;
  async function loadNewPair(forcedLeftSceneId = null) {
    if (isEloSetupPending()) return;
    state.disableChoice = false;
    const comparisonArea = document.getElementById("sb-comparison-area");
    if (!comparisonArea) return;
    const load = ++pairLoads;
    const superseded = () => load !== pairLoads;
    console.log(
      `[Stash Battle] 🎮 Loading new pair (mode: ${state.currentMode})${forcedLeftSceneId ? ` with forced scene ${forcedLeftSceneId}` : ""}...`
    );
    const startTime = Date.now();
    if (!comparisonArea.querySelector(".sb-vs-container")) {
      const hasCache = state.memoryCache.allScenes !== null;
      comparisonArea.innerHTML = `<div class="sb-loading">${hasCache ? "Loading scenes..." : "Loading and caching scenes (first load may take a moment)..."}</div>`;
    }
    try {
      let forcedLeftScene = null;
      if (forcedLeftSceneId) {
        forcedLeftScene = await fetchSceneById(forcedLeftSceneId);
        if (superseded()) return;
        if (forcedLeftScene) refreshSceneInCache(forcedLeftScene);
        if (!forcedLeftScene) {
          console.warn("[Stash Battle] Could not fetch scene from URL, falling back to normal pairing");
        }
      }
      let scenes2 = [];
      let ranks = [null, null];
      if (state.currentMode === "placement") {
        const placementResult = await fetchPlacementPair(forcedLeftScene);
        if (superseded()) return;
        if (placementResult.done) {
          if (placementResult.fromBottom && placementResult.rank === 1) {
            showVictoryScreen(placementResult.scene, placementResult.streak);
          } else {
            showPlacementScreen(placementResult);
          }
          return;
        }
        scenes2 = placementResult.scenes;
        ranks = placementResult.ranks;
      } else if (state.currentMode === "champion") {
        const championResult = await fetchChampionPair(forcedLeftScene);
        if (superseded()) return;
        if (championResult.isVictory) {
          showVictoryScreen(championResult.scenes[0], state.championWins);
          return;
        }
        scenes2 = championResult.scenes;
        ranks = championResult.ranks;
      } else {
        const swissResult = await fetchSwissPair(forcedLeftScene);
        if (superseded()) return;
        scenes2 = swissResult.scenes;
        ranks = swissResult.ranks;
      }
      if (scenes2.length < 2) {
        comparisonArea.innerHTML = '<div class="sb-error">Not enough scenes available for comparison.</div>';
        return;
      }
      state.currentPair.left = scenes2[0];
      state.currentPair.right = scenes2[1];
      state.currentRanks.left = ranks[0];
      state.currentRanks.right = ranks[1];
      const loadTime = Date.now() - startTime;
      console.log(
        `[Stash Battle] ✅ Pair loaded in ${loadTime}ms: Scene ${scenes2[0].id} (rank #${ranks[0]}) vs Scene ${scenes2[1].id} (rank #${ranks[1]})`
      );
      renderPair(scenes2, ranks);
      updatePoolStatus();
      updateClimbPoolWarning();
      saveState();
    } catch (error) {
      console.error("[Stash Battle] Error loading scenes:", error);
      const message = error instanceof Error ? error.message : String(error);
      const isNoScenes = message.includes("No scenes") || message.includes("Not enough");
      comparisonArea.innerHTML = `
        <div class="sb-error-screen">
          <div class="sb-error-icon">⚠️</div>
          <p class="sb-error-message">${message}</p>
          <button id="sb-error-retry" class="btn btn-primary">Retry</button>
        </div>
      `;
      setActionsVisible(true);
      const retryBtn = document.getElementById("sb-error-retry");
      if (retryBtn) {
        retryBtn.addEventListener("click", async () => {
          retryBtn.disabled = true;
          retryBtn.textContent = "Loading...";
          if (isNoScenes) {
            await clearFilteredCache();
            resetShuffle();
          }
          await loadNewPair();
        });
      }
    }
  }
  function pairMatchesRun(left, right) {
    if (state.currentMode === "placement") return state.placement?.scene.id === left.id;
    if (state.currentMode === "champion" && state.championScene) {
      return state.championScene.id === left.id || state.championScene.id === right.id;
    }
    return true;
  }
  async function restoreCurrentPair() {
    if (isEloSetupPending()) return;
    const left = state.currentPair.left;
    const right = state.currentPair.right;
    if (!pairMatchesRun(left, right)) {
      console.log("[Stash Battle] 📂 Saved pair doesn't belong to the current run, loading a new pair");
      await loadNewPair();
      return;
    }
    state.disableChoice = false;
    if (!await verifyCurrentPair()) return;
    let ranks = [state.currentRanks.left, state.currentRanks.right];
    try {
      ranks = await pairRanks(left, right);
      state.currentRanks = { left: ranks[0], right: ranks[1] };
    } catch (e) {
      console.warn("[Stash Battle] Could not load scene pools for the saved pair's ranks:", e);
    }
    console.log("[Stash Battle] 📂 Rendering saved pair");
    renderPair([left, right], ranks);
    updatePoolStatus();
  }
  async function verifyCurrentPair() {
    const { left, right } = state.currentPair;
    if (!left || !right) return true;
    try {
      const fresh = await fetchSceneFields([left.id, right.id]);
      const gone = [left, right].find((s) => !fresh.has(s.id));
      if (gone) {
        console.log(`[Stash Battle] 👻 Scene ${gone.id} in the current pair no longer exists`);
        await handleSceneGone(gone.id);
        return false;
      }
      for (const scene of [left, right]) {
        const fields = fresh.get(scene.id);
        if (!fields) continue;
        scene.rating100 = fields.rating100 ?? null;
        scene.custom_fields = fields.custom_fields ?? {};
        refreshSceneInCache(scene);
      }
    } catch (e) {
      console.warn("[Stash Battle] Could not verify current pair:", e);
    }
    return true;
  }
  function dropFromRun(sceneId) {
    state.championDefeated = state.championDefeated.filter((id) => id !== sceneId);
    const run = state.placement;
    if (!run) return;
    if (run.aboveId === sceneId) run.aboveId = null;
    if (run.belowId === sceneId) run.belowId = null;
    if (run.lastOpponentId === sceneId) {
      run.lastOpponentId = null;
      run.galloping = false;
    }
  }
  async function handleSceneGone(sceneId) {
    await removeSceneEverywhere(sceneId);
    const { left, right } = state.currentPair;
    const runSceneIds = [left?.id, state.placement?.scene.id, state.championScene?.id];
    if (runSceneIds.includes(sceneId)) {
      resetRunState();
      saveState();
      await loadNewPair();
      return;
    }
    dropFromRun(sceneId);
    saveState();
    const keepId = right?.id === sceneId ? left?.id : null;
    await loadNewPair(keepId ?? null);
  }
  async function deleteFromBattle(scene) {
    if (state.disableChoice) return;
    const deleted = await confirmDeleteScene(scene);
    if (!deleted) return;
    state.disableChoice = true;
    await handleSceneGone(scene.id);
  }
  function battleElo(scene) {
    return state.currentMode === "champion" ? effectiveElo(scene, CHAMPION_UNRATED_ELO) : effectiveElo(scene);
  }
  function resolveComparison(winner, loser) {
    const latestWinner = latestScene(winner);
    const latestLoser = latestScene(loser);
    const winnerSide = { elo: battleElo(latestWinner), kGames: kGames(latestWinner) };
    const loserSide = { elo: battleElo(latestLoser), kGames: kGames(latestLoser) };
    const result = eloResult(winnerSide, loserSide);
    void writeElo(winner, result.winner, battles(latestWinner) + 1, [true]);
    void writeElo(loser, result.loser, battles(latestLoser) + 1, [false]);
    return {
      winner: { from: winnerSide.elo, to: result.winner },
      loser: { from: loserSide.elo, to: result.loser },
      upset: winChances(winnerSide.elo, loserSide.elo)[0] <= UPSET_MAX_CHANCE
    };
  }
  function updateClimbPoolWarning() {
    const warning = document.getElementById("sb-climb-pool-warning");
    if (!warning) return;
    const isClimb = state.currentMode === "champion";
    const filters2 = currentFilters();
    const smallPool = state.totalScenesCount > 0 && state.totalScenesCount < CLIMB_SMALL_POOL_WARN_AT;
    warning.hidden = !(isClimb && state.settings.filterOpponents && filters2.filterActive && smallPool);
  }
  function handlePlacementChoice(choice) {
    const run = state.placement;
    if (!run) {
      state.disableChoice = false;
      return;
    }
    const won = choice.winner.id === run.scene.id;
    recordPlacementResult(run, won, won ? choice.loser.id : choice.winner.id);
    saveState();
    choice.winnerCard.classList.add("sb-winner");
    choice.loserCard.classList.add("sb-loser");
    scheduleNextPair(600);
  }
  function handleChampionChoice(choice) {
    const { winner: winnerScene, loser: loserScene, left, winnerCard, loserCard } = choice;
    if (!state.championScene) state.championScene = left;
    const change = resolveComparison(winnerScene, loserScene);
    if (winnerScene.id === state.championScene.id) {
      state.championDefeated.push(loserScene.id);
      state.championWins++;
    } else {
      state.championScene = winnerScene;
      state.championDefeated = [loserScene.id];
      state.championWins = 1;
    }
    saveState();
    showPickResult(winnerCard, loserCard, change);
  }
  function showPickResult(winnerCard, loserCard, change) {
    winnerCard.classList.add("sb-winner");
    loserCard.classList.add("sb-loser");
    showRatingAnimation(winnerCard, change.winner.from, change.winner.to, true, change.upset);
    showRatingAnimation(loserCard, change.loser.from, change.loser.to, false);
    scheduleNextPairAfterAnimations();
  }
  function handleSceneChoice(choice) {
    if (state.disableChoice) return;
    state.disableChoice = true;
    lastPick = takePickSnapshot(choice);
    updateUndoButton();
    const { winner: winnerScene, loser: loserScene, winnerCard, loserCard } = choice;
    if (state.currentMode === "placement") {
      handlePlacementChoice(choice);
      return;
    }
    if (state.currentMode === "champion") {
      handleChampionChoice(choice);
      return;
    }
    const change = resolveComparison(winnerScene, loserScene);
    saveState();
    showPickResult(winnerCard, loserCard, change);
  }
  var RATING_ANIM_MAX_TOTAL_MS = 1400;
  var RATING_ANIM_HOLD_MS = 300;
  var RATING_ANIM_COUNT_BUDGET_MS = RATING_ANIM_MAX_TOTAL_MS - RATING_ANIM_HOLD_MS;
  var RATING_ANIM_DEFAULT_STEP_MS = 50;
  var RATING_ANIM_MIN_STEP_MS = 8;
  function scheduleNextPairAfterAnimations() {
    scheduleNextPair(1500);
  }
  var nextPairTimer = null;
  function scheduleNextPair(ms) {
    if (nextPairTimer) clearTimeout(nextPairTimer);
    nextPairTimer = setTimeout(() => {
      nextPairTimer = null;
      void loadNewPair();
    }, ms);
  }
  var lastPick = null;
  var undoing = false;
  function takePickSnapshot(choice) {
    const run = state.placement;
    const written = state.currentMode === "placement" ? run ? [run.scene] : [] : [choice.left, choice.right];
    return {
      mode: state.currentMode,
      left: choice.left,
      right: choice.right,
      ranks: [state.currentRanks.left, state.currentRanks.right],
      fields: written.map((scene) => ({ scene, value: eloFields(latestScene(scene)), rating100: latestScene(scene).rating100 ?? null })),
      championScene: state.championScene,
      championWins: state.championWins,
      championDefeated: [...state.championDefeated],
      // A copy: the run object itself changes with every pick
      placement: run ? { ...run, results: [...run.results ?? []] } : null,
      hallIds: getHallOfFame().map((e) => e.id)
    };
  }
  function canUndo() {
    return lastPick !== null && !undoing;
  }
  function clearUndo() {
    lastPick = null;
    updateUndoButton();
  }
  function updateUndoButton() {
    document.querySelectorAll("#sb-undo-btn, #sb-end-undo").forEach((btn) => btn.disabled = !canUndo());
  }
  async function undoLastPick() {
    const pick = lastPick;
    if (!pick || undoing) return;
    undoing = true;
    lastPick = null;
    updateUndoButton();
    if (nextPairTimer) {
      clearTimeout(nextPairTimer);
      nextPairTimer = null;
    }
    pairLoads++;
    state.disableChoice = true;
    try {
      await eloWritesSettled();
      await Promise.all(pick.fields.map(({ scene, value, rating100 }) => restoreElo(scene, value, rating100)));
      await keepOnlyHallOfFame(pick.hallIds);
    } catch (e) {
      console.error("[Stash Battle] Undo couldn't put everything back:", e);
    }
    if (state.currentMode !== pick.mode) {
      state.currentMode = pick.mode;
      document.querySelectorAll(".sb-mode-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === pick.mode));
      updateModeInfo();
      updateClimbPoolWarning();
    }
    state.championScene = pick.championScene;
    state.championWins = pick.championWins;
    state.championDefeated = pick.championDefeated;
    state.placement = pick.placement;
    state.currentPair = { left: pick.left, right: pick.right };
    state.currentRanks = { left: pick.ranks[0], right: pick.ranks[1] };
    state.disableChoice = false;
    undoing = false;
    console.log(`[Stash Battle] ↶ Undid the last pick (scene ${pick.left.id} vs ${pick.right.id})`);
    renderPair([pick.left, pick.right], pick.ranks);
    updatePoolStatus();
    saveState();
  }
  function showRatingAnimation(card, oldElo, newElo, isWinner, upset = false) {
    const oldRating = Math.round(oldElo);
    const newRating = Math.round(newElo);
    const change = newRating - oldRating;
    const overlay = document.createElement("div");
    overlay.className = `sb-rating-overlay ${isWinner ? "sb-rating-winner" : "sb-rating-loser"}`;
    const ratingDisplay = document.createElement("div");
    ratingDisplay.className = "sb-rating-display";
    ratingDisplay.textContent = String(oldRating);
    const changeDisplay = document.createElement("div");
    changeDisplay.className = "sb-rating-change";
    changeDisplay.textContent = change > 0 ? `+${change}` : String(change);
    overlay.appendChild(ratingDisplay);
    overlay.appendChild(changeDisplay);
    if (upset) {
      const upsetDisplay = document.createElement("div");
      upsetDisplay.className = "sb-rating-upset";
      upsetDisplay.textContent = "Upset!";
      overlay.appendChild(upsetDisplay);
    }
    card.appendChild(overlay);
    const totalSteps = Math.abs(change);
    if (totalSteps === 0) {
      ratingDisplay.textContent = String(newRating);
      setTimeout(() => overlay.remove(), RATING_ANIM_MAX_TOTAL_MS);
      return;
    }
    const stepMs = Math.min(
      RATING_ANIM_DEFAULT_STEP_MS,
      Math.max(RATING_ANIM_MIN_STEP_MS, Math.round(RATING_ANIM_COUNT_BUDGET_MS / totalSteps))
    );
    let currentDisplay = oldRating;
    const step = change > 0 ? 1 : -1;
    let stepCount = 0;
    const interval = setInterval(() => {
      stepCount++;
      currentDisplay += step;
      ratingDisplay.textContent = String(currentDisplay);
      if (stepCount >= totalSteps) {
        clearInterval(interval);
        ratingDisplay.textContent = String(newRating);
      }
    }, stepMs);
    setTimeout(() => overlay.remove(), RATING_ANIM_MAX_TOTAL_MS);
  }

  // src/ui/icons.ts
  var SWORDS_PATHS = `
  <path fill="currentColor" d="m24 29 5-5L6 1H1v5z"/>
  <path fill="currentColor" d="M1 1v5l23 23 2.5-2.5z"/>
  <path fill="currentColor" d="M33.424 32.808c.284-.284.458-.626.531-.968l-5.242-6.195-.7-.702c-.565-.564-1.57-.473-2.249.205l-.614.612c-.677.677-.768 1.683-.204 2.247l.741.741 6.15 5.205c.345-.072.688-.247.974-.532z"/>
  <path fill="currentColor" d="M33.424 32.808c.284-.284.458-.626.531-.968l-1.342-1.586-.737 3.684c.331-.077.661-.243.935-.518zm-3.31-5.506-.888 4.44 1.26 1.067.82-4.1zm-1.4-1.657-.702-.702a1.2 1.2 0 0 0-.326-.224l-.978 4.892 1.26 1.066.957-4.783zm-2.402-.888a2 2 0 0 0-.548.392l-.614.61a2 2 0 0 0-.51.86c-.143.51-.047 1.036.306 1.388l.596.596zm0 0q0-.003 0 0"/>
  <path fill="currentColor" d="M33.25 36a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5M29.626 22.324a1.034 1.034 0 0 1 0 1.462l-6.092 6.092a1.032 1.032 0 0 1-1.686-.336 1.03 1.03 0 0 1 .224-1.126l6.092-6.092a1.033 1.033 0 0 1 1.462 0"/>
  <path fill="currentColor" d="M22.072 31.627a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5M29.626 24.073a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5"/>
  <path fill="currentColor" d="M22.072 30.877a1 1 0 1 0 0-2 1 1 0 0 0 0 2M29.626 23.323a1 1 0 1 0 0-2 1 1 0 0 0 0 2M33.903 29.342a.76.76 0 0 1 0 1.078l-3.476 3.475a.762.762 0 0 1-1.078-1.078l3.476-3.475a.76.76 0 0 1 1.078 0M12 29l-5-5L30 1h5v5z"/>
  <path fill="currentColor" d="M35 1v5L12 29l-2.5-2.5z"/>
  <path fill="currentColor" d="M2.576 32.808a1.95 1.95 0 0 1-.531-.968l5.242-6.195.7-.702c.565-.564 1.57-.473 2.249.205l.613.612c.677.677.768 1.683.204 2.247l-.741.741-6.15 5.205a1.95 1.95 0 0 1-.974-.532z"/>
  <path fill="currentColor" d="M2.576 32.808a1.95 1.95 0 0 1-.531-.968l1.342-1.586.737 3.684a1.93 1.93 0 0 1-.935-.518zm3.31-5.506.888 4.44-1.26 1.067-.82-4.1zm1.4-1.657.702-.702a1.2 1.2 0 0 1 .326-.224l.978 4.892-1.26 1.066-.957-4.783zm2.402-.888c.195.095.382.225.548.392l.613.612c.254.254.425.554.51.86.143.51.047 1.035-.306 1.387l-.596.596zm0 0q0-.003 0 0"/>
  <path fill="currentColor" d="M2.75 36a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5M6.374 22.324a1.034 1.034 0 0 0 0 1.462l6.092 6.092a1.033 1.033 0 1 0 1.462-1.462l-6.092-6.092a1.033 1.033 0 0 0-1.462 0"/>
  <path fill="currentColor" d="M13.928 31.627a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5M6.374 24.073a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5"/>
  <path fill="currentColor" d="M13.928 30.877a1 1 0 1 0 0-2 1 1 0 0 0 0 2M6.374 23.323a1 1 0 1 0 0-2 1 1 0 0 0 0 2M2.097 29.342a.76.76 0 0 0 0 1.078l3.476 3.475a.763.763 0 0 0 1.078-1.078l-3.476-3.475a.76.76 0 0 0-1.078 0"/>
`;

  // src/ui/sceneElo.ts
  var ITEM_CLASS = "sb-scene-elo";
  var NARROW_QUERY = "(max-width: 576px)";
  var TITLE = "Stash Battle ELO, and rank in your library. Click to battle this scene.";
  function labelText(scene, rank) {
    const value = elo(scene);
    if (value === null) return "ELO · Unrated";
    return `ELO ${Math.round(value)}${isProvisional(scene) ? "?" : ""}${rank !== null ? ` · #${rank}` : ""}`;
  }
  function titleText(scene, tier) {
    const lines = [TITLE];
    if (isProvisional(scene)) lines.push(PROVISIONAL_TIP);
    if (tier) lines.push(`${tier.emoji} ${tierDescription(tier)}`);
    return lines.join("\n");
  }
  async function sceneAndRank(sceneId) {
    const { scenes: scenes2 } = await getAllScenesCached();
    const index = scenes2.findIndex((s) => s.id === sceneId);
    if (index >= 0) {
      const scene2 = scenes2[index];
      return { scene: scene2, rank: isRated(scene2) ? index + 1 : null, tier: cachedTierMap(scenes2).get(sceneId) ?? null };
    }
    const scene = await fetchSceneById(sceneId);
    return scene ? { scene, rank: null, tier: null } : null;
  }
  var openBattle = () => {
  };
  var SWORDS_ICON = `<svg class="svg-inline--fa fa-icon" aria-hidden="true" focusable="false" viewBox="0 0 36 36" width="1em" height="1em">${SWORDS_PATHS}</svg>`;
  function iconHtml(tier) {
    return tier ? `<span class="sb-scene-elo-emoji" aria-hidden="true">${tier.emoji}</span>` : SWORDS_ICON;
  }
  function createItem() {
    const item = document.createElement("span");
    item.className = ITEM_CLASS;
    item.innerHTML = `
      <button type="button" class="minimal btn btn-secondary sb-scene-elo-button" title="${TITLE}">
        <span class="sb-scene-elo-icon">${SWORDS_ICON}</span>
        <span class="sb-scene-elo-value"></span>
      </button>`;
    item.querySelector("button")?.addEventListener("click", () => openBattle());
    return item;
  }
  function placeItem(item) {
    if (window.matchMedia(NARROW_QUERY).matches) {
      const subheader = document.querySelector(".scene-subheader");
      if (!subheader) return false;
      if (subheader.firstElementChild !== item) subheader.prepend(item);
      item.classList.add("sb-scene-elo-sub");
      return true;
    }
    item.classList.remove("sb-scene-elo-sub");
    const toolbar = document.querySelector(".scene-toolbar");
    if (!toolbar) return false;
    if (toolbar.contains(item)) return true;
    const playCount = toolbar.querySelector('button[title="Play Count"]')?.closest(".scene-toolbar-group > *");
    if (playCount) {
      playCount.before(item);
      return true;
    }
    const group = toolbar.querySelector(".scene-toolbar-group:last-child");
    if (!group) return false;
    group.prepend(item);
    return true;
  }
  function isPlaced(item, sceneId) {
    if (item?.dataset.sceneId !== sceneId) return false;
    return window.matchMedia(NARROW_QUERY).matches ? Boolean(item.closest(".scene-subheader")) : Boolean(item.closest(".scene-toolbar"));
  }
  var rendering = null;
  var loaded = null;
  async function renderSceneElo(force = false) {
    const sceneId = getSceneIdFromUrl();
    if (!sceneId || !document.querySelector(".scene-toolbar, .scene-subheader")) return;
    if (!force && isPlaced(document.querySelector(`.${ITEM_CLASS}`), sceneId)) return;
    if (rendering === sceneId) return;
    rendering = sceneId;
    try {
      if (!await sceneCustomFieldsSupported()) return;
      const result = !force && loaded?.sceneId === sceneId ? loaded.result : await sceneAndRank(sceneId);
      if (result) loaded = { sceneId, result };
      if (!result || getSceneIdFromUrl() !== sceneId) return;
      const item = document.querySelector(`.${ITEM_CLASS}`) ?? createItem();
      if (!placeItem(item)) return;
      item.dataset.sceneId = sceneId;
      const value = item.querySelector(".sb-scene-elo-value");
      if (value) value.textContent = labelText(result.scene, result.rank);
      item.querySelector("button")?.setAttribute("title", titleText(result.scene, result.tier));
      const icon = item.querySelector(".sb-scene-elo-icon");
      if (icon) icon.innerHTML = iconHtml(result.tier);
    } catch (e) {
      console.warn("[Stash Battle] Couldn't show the scene's ELO:", e);
    } finally {
      rendering = null;
    }
  }
  function refreshSceneElo() {
    void renderSceneElo(true);
  }
  function registerSceneElo(onClick2) {
    openBattle = onClick2;
    let queued = false;
    const check = () => {
      queued = false;
      if (getSceneIdFromUrl()) void renderSceneElo();
    };
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      setTimeout(check, 50);
    }).observe(document.body, { childList: true, subtree: true });
    window.matchMedia(NARROW_QUERY).addEventListener("change", check);
    check();
  }

  // src/ui/ratingPreview.ts
  var NOW_RATINGS = [100, 100, 96, 85, 74, 70, 62, 45, 20, null];
  var BATTLED_ELO = [2150, 1980, 1700, 1650, 1600, 1550, 1500, 1400, 1250, 1100];
  function exampleScenes() {
    return NOW_RATINGS.map((rating100, i) => ({ id: `example-${i}`, rating100, custom_fields: {} }));
  }
  function squares(scenes2, mode) {
    const targets = stashRatingTargets(scenes2, mode);
    return scenes2.map((scene) => {
      const rating = targets.get(scene.id) ?? scene.rating100 ?? null;
      return { elo: elo(scene), rating, changed: rating !== (scene.rating100 ?? null) };
    });
  }
  function squareHtml({ elo: eloValue, rating, changed }, showChange) {
    const classes = ["sb-pv-square"];
    if (rating === null) classes.push("sb-pv-unrated");
    if (rating !== null && rating > 55) classes.push("sb-pv-strong");
    if (showChange && changed) classes.push("sb-pv-changed");
    const fill = rating === null ? "" : ` style="--sb-pv-fill: ${rating}%"`;
    return `
            <div class="sb-pv-cell">
              <span class="sb-pv-elo">${eloValue === null ? "" : Math.round(eloValue)}</span>
              <span class="${classes.join(" ")}"${fill}>${rating === null ? "–" : ratingValue(rating)}</span>
            </div>`;
  }
  function rowHtml(label, cells, note, options2 = {}) {
    return `
          <div class="sb-pv-row${options2.muted ? " sb-pv-muted" : ""}">
            <div class="sb-pv-label">${label}</div>
            <div class="sb-pv-squares">${cells.map((cell) => squareHtml(cell, options2.showChange ?? false)).join("")}
            </div>
            <div class="sb-pv-note">${note}</div>
          </div>`;
  }
  var TWEEN_MS = 400;
  var tweens = /* @__PURE__ */ new WeakMap();
  function tweenText(el, target) {
    const running2 = tweens.get(el);
    if (running2) {
      cancelAnimationFrame(running2.frame);
      clearTimeout(running2.timer);
      tweens.delete(el);
    }
    const from = Number(el.textContent);
    const to = Number(target);
    const decimals = target.includes(".") ? target.split(".")[1].length : 0;
    if (el.textContent === "" || target === "" || !Number.isFinite(from) || !Number.isFinite(to) || from === to) {
      el.textContent = target;
      return;
    }
    const startTime = performance.now();
    const timer = setTimeout(() => {
      const current2 = tweens.get(el);
      if (current2) cancelAnimationFrame(current2.frame);
      tweens.delete(el);
      el.textContent = target;
    }, TWEEN_MS + 50);
    const step = (now) => {
      const t = Math.min(1, (now - startTime) / TWEEN_MS);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = (from + (to - from) * eased).toFixed(decimals);
      if (t < 1) tweens.set(el, { frame: requestAnimationFrame(step), timer });
    };
    tweens.set(el, { frame: requestAnimationFrame(step), timer });
  }
  function showRatingPreview(container, start, stashRatings) {
    const next = document.createElement("div");
    next.innerHTML = renderRatingPreview(start, stashRatings);
    const current2 = container.querySelector(".sb-rating-preview");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!current2 || reducedMotion) {
      container.replaceChildren(...next.childNodes);
      return;
    }
    const fresh = next.querySelector(".sb-rating-preview");
    const pairs = (selector) => {
      const now = current2.querySelectorAll(selector);
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
  function renderRatingPreview(start, stashRatings) {
    const off = stashRatings === "off";
    const now = squares(exampleScenes(), "off");
    const setUp = squares(exampleScenes().map((scene) => afterSetup(scene, start)), stashRatings);
    const changedCount = setUp.filter((cell) => cell.changed).length;
    const battled = exampleScenes().map((scene, i) => ({ ...scene, custom_fields: { [ELO_FIELD]: BATTLED_ELO[i] } }));
    const later = squares(battled, stashRatings);
    const unchangedNote = "Stash ratings stay as they are";
    const laterNote = off ? unchangedNote : stashRatings === "percentile" ? "Evenly spaced by rank, whatever the gaps" : `Gaps show, but 2150 is stuck at ${formatRating(100, true)}`;
    return `
        <div class="sb-rating-preview">
          <p class="sb-pv-legend">Each square below is an example scene: its ELO above, its Stash rating${getRatingSystem().type === "stars" ? " in stars" : ""} inside.</p>
          ${rowHtml("Now in Stash", now, "")}
          ${rowHtml("After setup", setUp, off ? unchangedNote : `${changedCount} of 10 change`, { muted: off, showChange: !off })}
          ${rowHtml("After lots of battles", later, laterNote, { muted: off })}
        </div>`;
  }

  // src/ui/setupScreen.ts
  var SETUP_ACTIVE_CLASS = "sb-setup-active";
  var running = false;
  var options = {};
  var plural2 = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  function setupArea(root) {
    return root.querySelector("#sb-setup-area");
  }
  function isSetupRunning() {
    return running;
  }
  function showSetupScreen(root, onDone, screenOptions = {}) {
    const area = setupArea(root);
    if (!area) return;
    area.closest(".sb-tab-panel")?.classList.add(SETUP_ACTIVE_CLASS);
    area.hidden = false;
    if (running) return;
    options = screenOptions;
    void loadChoices(area, onDone);
  }
  function hideSetupScreen(root) {
    const area = setupArea(root);
    if (!area || running) return;
    area.closest(".sb-tab-panel")?.classList.remove(SETUP_ACTIVE_CLASS);
    area.hidden = true;
    area.innerHTML = "";
  }
  async function loadChoices(area, onDone) {
    area.innerHTML = `<div class="sb-loading">Loading your library...</div>`;
    let scenes2;
    try {
      scenes2 = await fetchSetupScenes();
    } catch (e) {
      console.error("[Stash Battle] ELO setup: could not load scenes:", e);
      showError(area, "Couldn't load your scenes from Stash.", () => void loadChoices(area, onDone));
      return;
    }
    renderChoices(area, scenes2, onDone);
  }
  function radio(name, value, label, desc, checked) {
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
  function ratingsMessage(start, mode, changes) {
    const backup = "Take a Stash backup first (Settings → Tasks → Backup).";
    let text;
    let warn = true;
    if (mode === "off") {
      text = "Stash ratings won't change.";
      warn = false;
    } else if (changes === 0) {
      text = "No Stash ratings change now: every scene converts back to its current rating.";
      warn = false;
    } else if (start === "fresh") {
      text = `⚠️ Every scene starts at 1500 ELO, so <strong>every Stash rating becomes ${formatRating(50, true)}</strong>: ${plural2(changes, "rating")} change, unrated scenes included. ${backup}`;
    } else {
      text = `⚠️ <strong>${plural2(changes, "Stash rating")} change</strong> now, spread evenly by rank. A scene you rated ${formatRating(100, true)} by hand may end up lower. ${backup}`;
    }
    return `<p class="sb-setup-message${warn ? " sb-setup-warning" : ""}">${text}</p>`;
  }
  function renderChoices(area, scenes2, onDone) {
    const total = scenes2.length;
    const rated = scenes2.filter((scene) => scene.rating100 != null).length;
    const unrated = total - rated;
    const withElo = scenes2.filter(isRated).length;
    const upgradeNote = !state.settings.eloSetupAt && !hadFunMode() ? " Before 3.0, ratings changed after every battle; Straight-line with Use my ratings is closest to that." : "";
    const reset = options.reset === true;
    const choice = { start: "ratings", stashRatings: reset ? state.settings.stashRatings : "off" };
    area.innerHTML = `
      <div class="sb-setup">
        <h2 class="sb-setup-title">${reset ? "Reset ELO" : "Set up ELO"}</h2>
        <p class="sb-setup-intro">
          ${reset ? "Choose how ELO starts again. This overwrites every scene's ELO and battle count." : "Stash Battle now gives each scene an ELO score, saved in its custom fields. Wins raise it, losses lower it. Choose how it starts. This runs once."}
        </p>
        ${withElo > 0 && !reset ? `<p class="sb-setup-warning">${plural2(withElo, "scene")} already ${withElo === 1 ? "has" : "have"} an ELO from an earlier setup that didn't finish. Setting up again overwrites ${withElo === 1 ? "it" : "them"}.</p>` : ""}
        <div class="sb-setup-questions">
          <fieldset class="sb-setup-question">
            <legend>How should ELO start?</legend>
            ${radio(
      "start",
      "ratings",
      "Use my ratings",
      `Your ${plural2(rated, "rated scene")} start from their rating: ${ratingStarts(exampleRating(50))} at ${seed(exampleRating(50))} ELO.${unrated > 0 ? ` The ${unrated} unrated ${unrated === 1 ? "one stays" : "ones stay"} unrated.` : ""}`,
      true
    )}
            ${radio(
      "start",
      "fresh",
      "Start everyone at 1500",
      `All ${plural2(total, "scene")} start equal.`,
      false
    )}
          </fieldset>
          <fieldset class="sb-setup-question">
            <legend>Should Stash Battle change your Stash ratings?</legend>
            ${STASH_RATINGS_OPTIONS.map(
      ({ value, label, desc }) => radio("stashRatings", value, label, desc, value === choice.stashRatings)
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
    const slot = area.querySelector('[data-role="ratings-warning"]');
    const preview = area.querySelector('[data-role="preview"]');
    const startBtn = area.querySelector('[data-role="start"]');
    const changeCounts = /* @__PURE__ */ new Map();
    const messageFor = /* @__PURE__ */ new Map();
    const messageByHtml = /* @__PURE__ */ new Map();
    for (const start of ["ratings", "fresh"]) {
      for (const mode of ["off", "linear", "percentile"]) {
        const changes = setupRatingChanges(scenes2, start, mode).size;
        const html = ratingsMessage(start, mode, changes);
        let message = messageByHtml.get(html);
        if (!message) {
          slot.insertAdjacentHTML("beforeend", html);
          message = slot.lastElementChild;
          messageByHtml.set(html, message);
        }
        changeCounts.set(`${start}:${mode}`, changes);
        messageFor.set(`${start}:${mode}`, message);
      }
    }
    const update = () => {
      showRatingPreview(preview, choice.start, choice.stashRatings);
      const key = `${choice.start}:${choice.stashRatings}`;
      const shown = messageFor.get(key);
      for (const message of slot.children) message.classList.toggle("sb-shown", message === shown);
      const changes = changeCounts.get(key) ?? 0;
      startBtn.textContent = changes > 0 ? `Start ELO and change ${plural2(changes, "rating")}` : "Start ELO";
    };
    area.querySelectorAll('input[type="radio"]').forEach((input) => {
      input.addEventListener("change", () => {
        if (input.name === "start") choice.start = input.value;
        else choice.stashRatings = input.value;
        update();
      });
    });
    startBtn.addEventListener("click", () => void runSetup(area, scenes2, choice, onDone));
    update();
  }
  function progressHtml(phase, done, total) {
    const percent = total > 0 ? Math.round(done / total * 100) : 100;
    const label = phase === "elo" ? `Saving starting ELO: ${done} of ${plural2(total, "scene")}` : `Updating Stash ratings: ${plural2(total, "scene")}`;
    return `
      <div class="sb-setup sb-setup-progress">
        <h2 class="sb-setup-title">Setting up ELO...</h2>
        <div class="progress"><div class="progress-bar" role="progressbar" style="width: ${percent}%" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100"></div></div>
        <p class="sb-setup-progress-label">${label}</p>
        <p class="sb-setup-note">You can close Stash Battle; setup keeps going while this Stash tab stays open. If the tab closes first, Stash Battle asks again next time, and running it again is safe.</p>
      </div>`;
  }
  async function runSetup(area, scenes2, choice, onDone) {
    running = true;
    area.innerHTML = progressHtml("elo", 0, 0);
    if (state.settings.eloSetupAt && !await updateSettingsNow({ eloSetupAt: null, eloSetupMode: null })) {
      console.warn("[Stash Battle] Couldn't clear the setup flag before resetting ELO; continuing");
    }
    let summary;
    try {
      summary = await runEloSetup(scenes2, choice.start, choice.stashRatings, (phase, done, total) => {
        area.innerHTML = progressHtml(phase, done, total);
      });
    } catch (e) {
      running = false;
      console.error("[Stash Battle] ELO setup failed:", e);
      showError(
        area,
        `Setup stopped partway: ${escapeHtml2(e instanceof Error ? e.message : String(e))}. Running it again is safe; it overwrites what was written.`,
        () => void loadChoices(area, onDone)
      );
      return;
    }
    await clearSceneCache();
    resetShuffle();
    resetRunState();
    state.currentPair = { left: null, right: null };
    state.currentRanks = { left: null, right: null };
    saveState();
    await finishSetup(area, summary, choice, onDone);
  }
  async function finishSetup(area, summary, choice, onDone) {
    const saved = await updateSettingsNow({
      eloSetupAt: (/* @__PURE__ */ new Date()).toISOString(),
      eloSetupMode: choice.start,
      stashRatings: choice.stashRatings
    });
    if (!saved) {
      state.settings = { ...state.settings, eloSetupAt: null };
      showError(
        area,
        "Your ELO is saved, but Stash Battle couldn't record in Stash that setup finished.",
        () => void finishSetup(area, summary, choice, onDone)
      );
      return;
    }
    running = false;
    const eloLine2 = choice.start === "ratings" ? `${plural2(summary.eloWritten, "scene")} got a starting ELO from ${summary.eloWritten === 1 ? "its" : "their"} rating. Unrated scenes stay unrated until they battle.` : `${plural2(summary.eloWritten, "scene")} start at 1500 ELO.`;
    const clearedLine = summary.eloCleared > 0 ? `<li>${plural2(summary.eloCleared, "scene")} without a Stash rating had an old ELO removed.</li>` : "";
    const optionLabel = choice.stashRatings === "percentile" ? "Percentile" : "Straight-line";
    const ratingsLine = choice.stashRatings === "off" ? "Stash ratings weren't changed, and battles won't change them." : summary.ratingsWritten === 0 ? `Stash ratings already matched (${optionLabel}), so none changed. Battles keep them in step from now on.` : `${plural2(summary.ratingsWritten, "Stash rating")} updated (${optionLabel}). Battles keep them in step from now on.`;
    area.innerHTML = `
      <div class="sb-setup sb-setup-done">
        <h2 class="sb-setup-title">✅ ELO is ready</h2>
        <ul class="sb-setup-summary">
          <li>${eloLine2}</li>
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
  function escapeHtml2(text) {
    return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  }
  function showError(area, message, retry) {
    area.innerHTML = `
      <div class="sb-setup sb-error-screen">
        <div class="sb-error-icon">⚠️</div>
        <p class="sb-error-message">${message}</p>
        <button type="button" class="btn btn-primary" data-role="retry">Try again</button>
      </div>`;
    area.querySelector('[data-role="retry"]')?.addEventListener("click", retry);
  }

  // src/ui/modal.ts
  var modalKeyHandler = null;
  var sceneMissingListenerAdded = false;
  var BATTLE_OPEN_CLASS = "sb-battle-open";
  function rerenderCurrentPair() {
    const { left, right } = state.currentPair;
    if (!left || !right || state.disableChoice || !document.querySelector("#sb-comparison-area .sb-vs-container")) {
      return;
    }
    renderPair([left, right], [state.currentRanks.left, state.currentRanks.right]);
  }
  async function confirmSettingChange(key, value) {
    if (key !== "stashRatings") return true;
    const next = value;
    if (next === "off" || next === state.settings.stashRatings) return true;
    let changes;
    try {
      changes = stashRatingChanges(await fetchSetupScenes(), next);
    } catch (e) {
      console.error("[Stash Battle] Couldn't load scenes to switch Stash ratings:", e);
      await confirmDialog({
        title: "Couldn't load your scenes",
        body: "<p>Stash Battle needs your whole library to work out the new Stash ratings. Nothing was changed; try again.</p>",
        confirmLabel: "OK"
      });
      return false;
    }
    if (changes.size === 0) return true;
    const { label, desc } = stashRatingsOption(next);
    const count = `${changes.size} Stash rating${changes.size === 1 ? "" : "s"}`;
    return confirmDialog({
      title: `Switch Stash ratings update mode to ${label}?`,
      body: `
        <p>${desc}</p>
        <p><strong>${count} change now.</strong> After that, battles keep Stash ratings in step with
        ELO, and a star rating you change by hand in Stash is overwritten the next time Stash Battle
        writes that scene.</p>
        <p>Take a Stash backup first (Settings → Tasks → Backup).</p>`,
      confirmLabel: `Update ${count}`,
      workingLabel: "Updating...",
      action: () => queueRatingWrite(async () => {
        await writeStashRatings(changes);
        applyStashRatings(changes);
      })
    });
  }
  async function confirmClearHallOfFame() {
    const count = getHallOfFame().length;
    await confirmDialog({
      title: "Clear the hall of fame?",
      body: `
        <p>${count === 0 ? "The hall of fame is already empty." : `The ${plural(count, "scene")} that ${count === 1 ? "has" : "have"} been #1 will be taken off the list.`}
        Your current #1 joins it again, from today, the next time you battle or open Records.</p>
        <p>ELO and records aren't touched.</p>`,
      confirmLabel: "Clear hall of fame",
      workingLabel: "Clearing…",
      action: async () => {
        if (!await clearHallOfFame()) throw new Error("Couldn't save to Stash. Try again.");
      }
    });
  }
  async function startResetElo(modal) {
    const ratingsOn = state.settings.stashRatings !== "off";
    const ok = await confirmDialog({
      title: "Reset ELO?",
      body: `
        <p>Every scene's ELO and battle count will be overwritten. Next you choose how ELO starts
        again: from your Stash ratings, or 1500 for everyone.${ratingsOn ? " Stash ratings are then updated from the new ELO." : ""}</p>
        <p>Nothing changes until you press Start on the next screen.</p>`,
      confirmLabel: "Continue"
    });
    if (!ok) return;
    state.resettingElo = true;
    showTab(modal, "battle");
    modal.querySelectorAll(".sb-hover-preview").forEach((v) => v.pause());
    showSetupScreen(modal, () => afterSetup2(modal), {
      reset: true,
      onCancel: () => {
        state.resettingElo = false;
        hideSetupScreen(modal);
        if (state.currentPair.left && state.currentPair.right) void restoreCurrentPair();
        else void loadNewPair();
      }
    });
  }
  function afterSetup2(modal) {
    state.resettingElo = false;
    clearUndo();
    syncSettingsControls(modal);
    updateRatingsNote();
    void loadNewPair(getSceneIdFromUrl());
  }
  function switchMode(modal, mode) {
    state.currentMode = mode;
    resetRunState();
    state.shuffleIndex = 0;
    state.leastTested = false;
    modal.querySelectorAll(".sb-mode-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.mode === state.currentMode);
    });
    updateModeInfo();
    updateClimbPoolWarning();
    updatePoolStatus();
  }
  function statsActions(modal) {
    const toBattle = () => {
      resetRunState();
      state.currentPair = { left: null, right: null };
      state.currentRanks = { left: null, right: null };
      updatePoolStatus();
      showTab(modal, "battle");
      applyPreviewSettings();
    };
    return {
      // Like opening Stash Battle from the scene's page: the scene battles, in the current mode,
      // until stopped
      battleScene: (sceneId) => {
        state.leastTested = false;
        state.explorePool = oneScenePool(sceneId);
        resetShuffle();
        toBattle();
        void loadNewPair(sceneId);
      },
      // Explore at this ELO range (a histogram bar)
      exploreRange: (eloMin, eloMax) => {
        setExploreFilters({ eloMin, eloMax });
        showTab(modal, "explore");
        const scrollToCards = () => {
          const scroller = modal.querySelector(".sb-modal-content");
          const status = modal.querySelector(".sb-explore-status-row");
          if (!scroller) return;
          scroller.scrollTop = 0;
          if (status) scroller.scrollTop = status.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8;
        };
        void renderExploreTab(modal, statsActions(modal)).then(scrollToCards);
      },
      // Swiss with the fewest-battled scenes on the left, until stopped or the mode changes
      battleLeastTested: () => {
        if (state.currentMode !== "swiss") switchMode(modal, "swiss");
        state.explorePool = null;
        state.leastTested = true;
        toBattle();
        void loadNewPair();
      },
      // Battle an Explore filter until stopped: unrated scenes go to Placement; other filters use
      // Swiss (the mode can be changed after)
      battleFilter: (filters2, label) => {
        state.leastTested = false;
        state.explorePool = { filters: { ...filters2 }, label };
        resetShuffle();
        const mode = filters2.group === "unrated" ? "placement" : "swiss";
        if (state.currentMode !== mode) switchMode(modal, mode);
        toBattle();
        void loadNewPair();
        saveState();
      }
    };
  }
  function stopExplorePool() {
    state.explorePool = null;
    resetShuffle();
    resetRunState();
    saveState();
    void loadNewPair();
  }
  function onSettingChanged(key) {
    switch (key) {
      case "stashRatings":
        updateRatingsNote();
        scheduleStashRatingSync();
        break;
      case "filterOpponents":
        if (state.currentMode !== "swiss") resetRunState();
        saveState();
        loadNewPair();
        updateClimbPoolWarning();
        break;
      case "placementFromBottom": {
        const sceneId = state.currentMode === "placement" ? state.placement?.scene.id : void 0;
        if (sceneId) {
          resetRunState();
          saveState();
          void loadNewPair(sceneId);
        }
        break;
      }
      case "previewVolume":
      case "autoplayPreviews":
        applyPreviewSettings();
        break;
      case "openInNewTab":
      case "cleanMode":
      case "tierBorders":
        rerenderCurrentPair();
        break;
    }
  }
  async function openModal() {
    console.log("[Stash Battle] 🎯 Opening modal...");
    const [settingsOk, customFieldsOk] = await Promise.all([loadSettings(), sceneCustomFieldsSupported()]);
    if (!customFieldsOk) {
      showMessageModal(
        "Stash Battle needs a newer version of Stash: it stores each scene's ELO in scene custom fields, which this Stash doesn't have. Update Stash to use Stash Battle."
      );
      return;
    }
    if (!settingsOk && isEloSetupPending()) {
      showMessageModal("Stash Battle couldn't load its settings from Stash. Close Stash Battle and try again.");
      return;
    }
    addKeySwallowers();
    holdStashListRefresh(true);
    if (state.settings.pauseMediaOnOpen) {
      document.querySelectorAll("video, audio").forEach((v) => v.pause());
    }
    if (!sceneMissingListenerAdded) {
      sceneMissingListenerAdded = true;
      window.addEventListener(SCENE_MISSING_EVENT, (e) => {
        void handleSceneGone(e.detail);
      });
    }
    const hasState = loadState();
    console.log(`[Stash Battle] 📋 LocalStorage state: ${hasState ? "found" : "none"}`);
    const currentFilterParams = scenesListQuery();
    const filtersChanged = hasState && state.savedFilterParams !== currentFilterParams;
    if (filtersChanged) {
      console.log("[Stash Battle] Filter params changed, resetting run state and filtered cache");
      state.currentPair = { left: null, right: null };
      state.currentRanks = { left: null, right: null };
      resetRunState();
      state.savedFilterParams = currentFilterParams;
      state.memoryCache.filteredScenes = null;
      state.memoryCache.filterKey = null;
      resetShuffle();
    }
    const scenePageId = getSceneIdFromUrl();
    const sceneAlreadyInPair = scenePageId && state.currentPair.left && state.currentPair.right && (String(state.currentPair.left.id) === scenePageId || String(state.currentPair.right.id) === scenePageId);
    const forceSceneBattle = scenePageId && !sceneAlreadyInPair;
    if (forceSceneBattle) {
      console.log(`[Stash Battle] 🎯 Opened from scene page ${scenePageId}, starting new battle with this scene`);
      resetRunState();
      state.currentPair = { left: null, right: null };
      state.currentRanks = { left: null, right: null };
    }
    if (scenePageId && state.explorePool?.sceneId !== scenePageId) {
      state.leastTested = false;
      state.explorePool = oneScenePool(scenePageId);
      resetShuffle();
    }
    const existingModal = document.getElementById("sb-modal");
    if (existingModal && existingModal.classList.contains("sb-modal-hidden") && existingModal.querySelector("#stash-battle-container")) {
      console.log("[Stash Battle] ♻️ Reusing existing modal");
      existingModal.classList.remove("sb-modal-hidden", "sb-modal-closing");
      document.body.classList.add(BATTLE_OPEN_CLASS);
      showTab(existingModal, "battle");
      syncSettingsControls(existingModal);
      updateRatingsNote();
      if (modalKeyHandler) {
        document.removeEventListener("keydown", modalKeyHandler, true);
        document.addEventListener("keydown", modalKeyHandler, true);
      }
      const modalContent2 = existingModal.querySelector(".sb-modal-content");
      if (modalContent2) modalContent2.focus();
      if (isEloSetupPending()) {
        showSetupScreen(existingModal, () => afterSetup2(existingModal));
        return;
      }
      hideSetupScreen(existingModal);
      updatePoolStatus();
      if (forceSceneBattle) {
        loadNewPair(scenePageId);
      } else if (filtersChanged) {
        loadNewPair();
      } else if (!state.currentPair.left || !state.currentPair.right) {
        if (!document.querySelector("#sb-comparison-area .sb-end-screen")) loadNewPair();
      } else if (document.querySelector("#sb-comparison-area .sb-vs-container")) {
        applyPreviewSettings();
        void verifyCurrentPair();
      }
      return;
    }
    if (existingModal) existingModal.remove();
    if (!state.savedFilterParams) {
      state.savedFilterParams = currentFilterParams;
    }
    const modal = document.createElement("div");
    modal.id = "sb-modal";
    modal.innerHTML = `
      <div class="sb-modal-backdrop"></div>
      <div class="sb-modal-content">
        <button class="sb-modal-close" aria-label="Close">✕</button>
        ${createMainUI()}
      </div>
    `;
    document.body.appendChild(modal);
    document.body.classList.add(BATTLE_OPEN_CLASS);
    const modalContent = modal.querySelector(".sb-modal-content");
    if (modalContent) {
      modalContent.setAttribute("tabindex", "-1");
      modalContent.style.outline = "none";
      modalContent.focus();
      modalContent.addEventListener(
        "scroll",
        () => {
          if (modalContent.scrollLeft !== 0) modalContent.scrollLeft = 0;
        },
        { passive: true }
      );
    }
    modal.querySelectorAll(".sb-mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const newMode = btn.dataset.mode;
        if (newMode !== state.currentMode) {
          switchMode(modal, newMode);
          loadNewPair(getSceneIdFromUrl());
          saveState();
        }
      });
    });
    const modeInfoBtn = modal.querySelector(".sb-mode-info-btn");
    const modeInfo = modal.querySelector("#sb-mode-info");
    modeInfoBtn?.addEventListener("click", () => {
      if (!modeInfo) return;
      updateModeInfo();
      modeInfo.hidden = !modeInfo.hidden;
      modeInfoBtn.setAttribute("aria-expanded", String(!modeInfo.hidden));
    });
    showTab(modal, "battle");
    bindSettingsControls(
      modal,
      onSettingChanged,
      (tab) => {
        applyPreviewSettings();
        stopMiniPreview();
        if (tab === "stats") void renderStatsTab(modal, statsActions(modal));
        if (tab === "records") void renderRecordsTab(modal, statsActions(modal).battleScene);
        if (tab === "explore") void renderExploreTab(modal, statsActions(modal));
      },
      confirmSettingChange
    );
    updateRatingsNote();
    updatePoolStatus();
    modal.querySelector("#sb-pool-status")?.addEventListener("click", (e) => {
      const target = e.target;
      if (target.closest('[data-action="stop-explore-pool"]')) {
        e.preventDefault();
        stopExplorePool();
      } else if (target.closest('[data-action="stop-least-tested"]')) {
        e.preventDefault();
        state.leastTested = false;
        updatePoolStatus();
      }
    });
    modal.querySelector('[data-action="reset-elo"]')?.addEventListener("click", () => void startResetElo(modal));
    modal.querySelector('[data-action="clear-hall-of-fame"]')?.addEventListener("click", () => void confirmClearHallOfFame());
    modal.querySelector('[data-action="open-settings"]')?.addEventListener("click", (e) => {
      e.preventDefault();
      showTab(modal, "settings");
      applyPreviewSettings();
    });
    modal.querySelector("#sb-skip-btn")?.addEventListener("click", skipPair);
    modal.querySelector("#sb-undo-btn")?.addEventListener("click", () => void undoLastPick());
    const refreshCacheBtn = modal.querySelector("#sb-refresh-cache-btn");
    if (refreshCacheBtn) {
      refreshCacheBtn.addEventListener("click", async () => {
        if (state.disableChoice) return;
        const label = refreshCacheBtn.textContent;
        refreshCacheBtn.disabled = true;
        refreshCacheBtn.textContent = "🔄 Refreshing...";
        try {
          await clearSceneCache();
          resetShuffle();
          resetRunState();
          saveState();
          await loadNewPair();
        } catch (e) {
          console.error("[Stash Battle] Refresh failed:", e);
        } finally {
          refreshCacheBtn.disabled = false;
          refreshCacheBtn.textContent = label;
        }
      });
    }
    if (isEloSetupPending()) {
      console.log("[Stash Battle] 🧭 ELO setup not done yet, showing setup");
      showSetupScreen(modal, () => afterSetup2(modal));
    } else if (forceSceneBattle) {
      console.log(`[Stash Battle] 🎯 Starting battle with scene ${scenePageId} from scene page`);
      loadNewPair(scenePageId);
    } else if (hasState && state.currentPair.left && state.currentPair.right && !filtersChanged) {
      console.log(
        `[Stash Battle] 📂 Restoring saved pair from localStorage (Scene ${state.currentPair.left.id} vs Scene ${state.currentPair.right.id})`
      );
      void restoreCurrentPair();
    } else {
      console.log("[Stash Battle] 🆕 No saved pair or filters changed, loading new pair...");
      loadNewPair();
    }
    modal.querySelector(".sb-modal-backdrop")?.addEventListener("click", closeModal);
    modal.querySelector(".sb-modal-close")?.addEventListener("click", closeModal);
    if (modalKeyHandler) {
      document.removeEventListener("keydown", modalKeyHandler, true);
    }
    modalKeyHandler = function(e) {
      const activeModal = document.getElementById("sb-modal");
      if (!activeModal) {
        if (modalKeyHandler) document.removeEventListener("keydown", modalKeyHandler, true);
        modalKeyHandler = null;
        return;
      }
      if (isDeleteDialogOpen()) return;
      e.stopImmediatePropagation();
      if (isConfirmDialogOpen()) {
        if (e.key === "Escape") {
          e.preventDefault();
          cancelConfirmDialog();
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeModal();
        return;
      }
      if (getActiveTab() !== "battle" || isEloSetupPending()) return;
      const active = document.activeElement;
      const tag = active?.tagName;
      const isToggle = tag === "INPUT" && (active?.type === "checkbox" || active?.type === "radio");
      if (tag === "INPUT" && !isToggle || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "ArrowLeft" && state.currentPair.left) {
        e.preventDefault();
        const leftChoose = activeModal.querySelector('.sb-scene-card[data-side="left"] .sb-choose-btn');
        if (leftChoose) leftChoose.click();
      }
      if (e.key === "ArrowRight" && state.currentPair.right) {
        e.preventDefault();
        const rightChoose = activeModal.querySelector('.sb-scene-card[data-side="right"] .sb-choose-btn');
        if (rightChoose) rightChoose.click();
      }
      if (e.key === "Backspace") {
        e.preventDefault();
        void undoLastPick();
        return;
      }
      if (e.key === " " || e.code === "Space") {
        if (tag === "BUTTON" || isToggle) return;
        e.preventDefault();
        skipPair();
      }
    };
    document.addEventListener("keydown", modalKeyHandler, true);
  }
  function showMessageModal(message) {
    document.getElementById("sb-modal")?.remove();
    const modal = document.createElement("div");
    modal.id = "sb-modal";
    modal.innerHTML = `
      <div class="sb-modal-backdrop"></div>
      <div class="sb-modal-content">
        <button class="sb-modal-close" aria-label="Close">✕</button>
        <div class="sb-error-screen">
          <div class="sb-error-icon">⚠️</div>
          <p class="sb-error-message">${message}</p>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    document.body.classList.add(BATTLE_OPEN_CLASS);
    modal.querySelector(".sb-modal-backdrop")?.addEventListener("click", closeModal);
    modal.querySelector(".sb-modal-close")?.addEventListener("click", closeModal);
  }
  function isModalVisible() {
    const modal = document.getElementById("sb-modal");
    return modal !== null && !modal.classList.contains("sb-modal-hidden");
  }
  var keySwallowersAdded = false;
  function addKeySwallowers() {
    if (keySwallowersAdded) return;
    keySwallowersAdded = true;
    const swallow = (e) => {
      if (isModalVisible() && !isDeleteDialogOpen()) e.stopImmediatePropagation();
    };
    document.addEventListener("keypress", swallow, true);
    document.addEventListener("keyup", swallow, true);
  }
  function closeModal() {
    const modal = document.getElementById("sb-modal");
    if (!modal || modal.classList.contains("sb-modal-hidden")) return;
    cancelDeleteDialog();
    cancelConfirmDialog();
    stopMiniPreview();
    holdStashListRefresh(false);
    refreshSceneElo();
    if (state.resettingElo && !isSetupRunning()) {
      state.resettingElo = false;
      hideSetupScreen(modal);
    }
    modal.querySelectorAll(".sb-hover-preview").forEach((v) => v.pause());
    modal.classList.add("sb-modal-closing");
    setTimeout(() => {
      modal.classList.add("sb-modal-hidden");
      document.body.classList.remove(BATTLE_OPEN_CLASS);
      modal.classList.remove("sb-modal-closing");
    }, 200);
    if (modalKeyHandler) {
      document.removeEventListener("keydown", modalKeyHandler, true);
    }
  }

  // src/ui/navButton.ts
  var BUTTON_ID = "plugin_sb";
  var ICON_ID = "plugin_sb_icon";
  var NAV_ITEM_CLASS = "col-4 col-sm-3 col-md-2 col-lg-auto nav-link";
  var LINK_CLASS = "minimal p-4 p-xl-2 d-flex d-xl-inline-block flex-column justify-content-between align-items-center btn btn-primary";
  var LINK_HTML = `<svg aria-hidden="true" focusable="false" class="svg-inline--fa fa-icon nav-menu-icon d-block d-xl-inline mb-2 mb-xl-0" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36">${SWORDS_PATHS}</svg><span>Battle</span>`;
  function onButtonClick(e) {
    e.preventDefault();
    void openModal();
  }
  function placeNavIcon() {
    const existing = document.getElementById(ICON_ID);
    const buttons = document.querySelector(".navbar-buttons");
    if (!buttons) return;
    if (existing && buttons.contains(existing)) {
      fitNavIcon(existing);
      return;
    }
    const item = existing ?? document.createElement("a");
    item.id = ICON_ID;
    item.className = "mr-2 sb-nav-icon";
    item.innerHTML = `
        <button type="button" class="minimal d-flex align-items-center h-100 btn btn-primary" title="Stash Battle" aria-label="Stash Battle">
          <svg aria-hidden="true" focusable="false" class="svg-inline--fa fa-icon" viewBox="0 0 36 36">${SWORDS_PATHS}</svg>
        </button>`;
    item.querySelector("button")?.addEventListener("click", onButtonClick);
    const after = buttons.querySelector("#tcode-nav-btn") ?? buttons.querySelector("#plugin_sfw")?.closest(".navbar-buttons > *");
    if (after) after.after(item);
    else buttons.prepend(item);
    fitNavIcon(item, true);
  }
  function fitNavIcon(item, force = false) {
    const key = `${window.innerWidth}:${item.parentElement?.childElementCount ?? 0}`;
    if (!force && key === fittedFor) return;
    item.style.removeProperty("display");
    if (getComputedStyle(item).display === "none") {
      fittedFor = key;
      return;
    }
    const brand = document.querySelector(".navbar-brand")?.getBoundingClientRect();
    if (!brand || brand.height === 0) return;
    fittedFor = key;
    if (item.getBoundingClientRect().top >= brand.bottom - 1) item.style.display = "none";
  }
  var fittedFor = "";
  function registerNavIcon() {
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      setTimeout(() => {
        queued = false;
        placeNavIcon();
      }, 50);
    }).observe(document.body, { childList: true, subtree: true });
    let resizeTimer = null;
    window.addEventListener("resize", () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(placeNavIcon, 100);
    });
    document.addEventListener("visibilitychange", () => {
      const icon = document.getElementById(ICON_ID);
      if (icon && !document.hidden) fitNavIcon(icon, true);
    });
    placeNavIcon();
  }
  function registerNavButton() {
    registerNavIcon();
    const api = window.PluginApi;
    if (api?.components?.["MainNavBar.MenuItems"] && typeof api.patch?.before === "function") {
      patchNavButton(api);
      return;
    }
    injectNavButton();
    const observer = new MutationObserver(() => {
      injectNavButton();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }
  function patchNavButton(api) {
    const { React } = api;
    function BattleNavItem() {
      return React.createElement(
        "div",
        { id: BUTTON_ID, className: NAV_ITEM_CLASS },
        React.createElement("a", {
          href: "#",
          className: LINK_CLASS,
          onClick: onButtonClick,
          dangerouslySetInnerHTML: { __html: LINK_HTML }
        })
      );
    }
    api.patch.before("MainNavBar.MenuItems", (props, ...rest) => [
      {
        ...props,
        children: [props.children, React.createElement(BattleNavItem, { key: BUTTON_ID })]
      },
      ...rest
    ]);
  }
  function injectNavButton() {
    if (document.getElementById(BUTTON_ID)) return;
    const navItem = document.createElement("div");
    navItem.className = NAV_ITEM_CLASS;
    navItem.id = BUTTON_ID;
    const link = document.createElement("a");
    link.href = "#";
    link.className = LINK_CLASS;
    link.innerHTML = LINK_HTML;
    link.addEventListener("click", onButtonClick);
    navItem.appendChild(link);
    const navTarget = document.querySelector(".navbar-nav");
    if (navTarget) {
      navTarget.appendChild(navItem);
    }
  }

  // src/main.ts
  function init() {
    console.log("[Stash Battle] Initialized");
    registerDeleteDialogBridge();
    registerNavButton();
    registerSceneElo(() => void openModal());
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
