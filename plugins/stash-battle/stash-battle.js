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
    pauseMediaOnOpen: true,
    testMode: false
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
    if (state.settings.testMode && state.memoryCache.allScenes?.some((s) => s.id === fresh.id)) return;
    for (const pool of [state.memoryCache.allScenes, state.memoryCache.filteredScenes]) {
      const cached = pool?.find((s) => s.id === fresh.id);
      if (cached) cached.rating100 = fresh.rating100 ?? null;
    }
    setEloInCache(fresh, eloFields(fresh));
  }
  var PERSIST_DEBOUNCE_MS = 1e3;
  var persistTimer = null;
  function persistCacheSoon() {
    if (typeof indexedDB === "undefined" || state.settings.testMode) return;
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
      testMode: bool("testMode"),
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
      if (state.settings.testMode && stored?.testMode === true) return true;
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
      if (state.settings.testMode && !keys.includes("testMode")) return true;
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
  async function setTestMode(on) {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!on) unsaved.clear();
    state.settings = { ...state.settings, testMode: on };
    unsaved.add("testMode");
    const saved = await saveConfig();
    if (!on) await loadSettings();
    return saved;
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
    const testing = state.settings.testMode;
    setEloInCache(scene, value);
    if (!testing) refreshStashCache([{ id: scene.id, elo: value }], false);
    try {
      const input = { id: scene.id, custom_fields: customFields, ...rating100 !== void 0 ? { rating100 } : {} };
      if (testing) console.log(`[Stash Battle] 🧪 Test mode: not saving scene ${scene.id} (${what})`);
      else await graphqlQuery(SCENE_UPDATE_MUTATION, { input });
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
      if (!testing) refreshStashCache([{ id: scene.id, rating100 }], true);
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
    if (state.settings.testMode) {
      console.log(`[Stash Battle] 🧪 Test mode: not saving ${ratings.size} Stash ratings`);
      return;
    }
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
    if (state.settings.testMode) return;
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
    if (state.settings.testMode) throw new Error("Test mode is on: turn it off in Settings to set up ELO.");
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
    },
    {
      title: "Testing",
      rows: [
        {
          key: "testMode",
          title: "🧪 Test mode",
          hint: "Try things without saving anything to Stash: ELO, records, Stash ratings, the hall of fame and settings changes only last until you turn it off or reload the page. Clean mode's deletes are still real"
        }
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
        if (key === "testMode") {
          input.disabled = true;
          void setTestMode(input.checked).finally(() => {
            input.disabled = false;
            syncSettingsControls(root);
            onChange(key);
          });
          return;
        }
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
      ...TIERS.map((t) => ({ value: t.id, label: `${t.emoji} ${t.name}`, tip: tierDescription(t) })),
      { value: "provisional", label: "Provisional", tip: PROVISIONAL_TIP },
      { value: "unrated", label: "Unrated", tip: "No ELO yet" }
    ];
    const chip = (value, label, tip = "") => `<button type="button" class="sb-chip${filters.group === value ? " active" : ""}" data-group="${value ?? ""}"${tip ? ` title="${tip}"` : ""}>${label}</button>`;
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
            <div class="sb-chips">${chip(null, "All")}${groups.map((g) => chip(g.value, g.label, g.tip)).join("")}</div>
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
        <p id="sb-test-note" class="sb-pool-status sb-test-note" hidden>
          🧪 <strong>Test mode</strong>: nothing is saved to Stash · <a href="#" data-action="open-settings">turn off in Settings</a>
        </p>

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
    const test = document.getElementById("sb-test-note");
    if (test) test.hidden = !state.settings.testMode;
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
    if (state.settings.testMode) {
      await confirmDialog({
        title: "Turn off test mode first",
        body: "<p>Reset ELO rewrites every scene in your library, which test mode can't hold back. Turn off test mode in Settings, then reset.</p>",
        confirmLabel: "OK"
      });
      return;
    }
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
  async function forgetTestChanges() {
    clearUndo();
    resetRunState();
    resetShuffle();
    state.currentPair = { left: null, right: null };
    state.currentRanks = { left: null, right: null };
    saveState();
    await clearSceneCache();
  }
  function onSettingChanged(key) {
    switch (key) {
      case "testMode": {
        updateRatingsNote();
        const modal = document.getElementById("sb-modal");
        if (modal) syncSettingsControls(modal);
        if (state.settings.testMode) clearUndo();
        else void forgetTestChanges().then(() => loadNewPair());
        break;
      }
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
    const wasTesting = state.settings.testMode;
    const [settingsOk, customFieldsOk] = await Promise.all([loadSettings(), sceneCustomFieldsSupported()]);
    if (wasTesting && !state.settings.testMode) await forgetTestChanges();
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
    if (forceSceneBattle && state.explorePool?.sceneId !== scenePageId) {
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
    modal.querySelectorAll('[data-action="open-settings"]').forEach(
      (link) => link.addEventListener("click", (e) => {
        e.preventDefault();
        showTab(modal, "settings");
        applyPreviewSettings();
      })
    );
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL2NvbnN0YW50cy50cyIsICIuLi8uLi9zcmMvZWxvLnRzIiwgIi4uLy4uL3NyYy9zY29yZS50cyIsICIuLi8uLi9zcmMvZ3JhcGhxbC50cyIsICIuLi8uLi9zcmMvdWkvZGVsZXRlRGlhbG9nLnRzIiwgIi4uLy4uL3NyYy9maWx0ZXJzLnRzIiwgIi4uLy4uL3NyYy9zdGF0cy50cyIsICIuLi8uLi9zcmMvZXhwbG9yZS50cyIsICIuLi8uLi9zcmMvc3RhdGUudHMiLCAiLi4vLi4vc3JjL2NhY2hlLnRzIiwgIi4uLy4uL3NyYy9zY2VuZUFjdGlvbnMudHMiLCAiLi4vLi4vc3JjL3JhdGluZ0Rpc3BsYXkudHMiLCAiLi4vLi4vc3JjL3NldHRpbmdzLnRzIiwgIi4uLy4uL3NyYy9yYXRpbmcudHMiLCAiLi4vLi4vc3JjL2Vsb1NldHVwLnRzIiwgIi4uLy4uL3NyYy9zdG9yYWdlLnRzIiwgIi4uLy4uL3NyYy91aS9jb25maXJtRGlhbG9nLnRzIiwgIi4uLy4uL3NyYy9uYXZpZ2F0aW9uLnRzIiwgIi4uLy4uL3NyYy9wbGFjZW1lbnQudHMiLCAiLi4vLi4vc3JjL3NjZW5lVGl0bGUudHMiLCAiLi4vLi4vc3JjL3BhaXJzLnRzIiwgIi4uLy4uL3NyYy91aS9zY2VuZUNhcmQudHMiLCAiLi4vLi4vc3JjL3VpL21pbmlDYXJkLnRzIiwgIi4uLy4uL3NyYy91aS9zY3JlZW5zLnRzIiwgIi4uLy4uL3NyYy91aS9zdGFzaFJhdGluZ3NUZXh0LnRzIiwgIi4uLy4uL3NyYy91aS9zZXR0aW5nc1BhbmVsLnRzIiwgIi4uLy4uL3NyYy91aS9leHBsb3JlVGFiLnRzIiwgIi4uLy4uL3NyYy91aS9yZWNvcmRzVGFiLnRzIiwgIi4uLy4uL3NyYy91aS9zdGF0c1RhYi50cyIsICIuLi8uLi9zcmMvdWkvbWFpblVJLnRzIiwgIi4uLy4uL3NyYy91aS9pY29ucy50cyIsICIuLi8uLi9zcmMvdWkvc2NlbmVFbG8udHMiLCAiLi4vLi4vc3JjL3VpL3JhdGluZ1ByZXZpZXcudHMiLCAiLi4vLi4vc3JjL3VpL3NldHVwU2NyZWVuLnRzIiwgIi4uLy4uL3NyYy91aS9tb2RhbC50cyIsICIuLi8uLi9zcmMvdWkvbmF2QnV0dG9uLnRzIiwgIi4uLy4uL3NyYy9tYWluLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBQbHVnaW4td2lkZSBjb25zdGFudHMuXHJcblxyXG5leHBvcnQgY29uc3QgU1RPUkFHRV9LRVkgPSBcInN0YXNoLWJhdHRsZS1zdGF0ZVwiO1xyXG5leHBvcnQgY29uc3QgQ0FDSEVfREJfTkFNRSA9IFwic3Rhc2gtYmF0dGxlLWNhY2hlXCI7XHJcbi8qKiAyICgzLjApOiBjYWNoZWQgc2NlbmVzIGZyb20gYmVmb3JlIG5lZWQgY3VzdG9tX2ZpZWxkcyBhbmQgRUxPIG9yZGVyLCBzbyB0aGUgc3RvcmUgaXMgY2xlYXJlZC4gKi9cclxuZXhwb3J0IGNvbnN0IENBQ0hFX0RCX1ZFUlNJT04gPSAyO1xyXG5leHBvcnQgY29uc3QgQ0FDSEVfU1RPUkVfTkFNRSA9IFwic2NlbmVzXCI7XHJcbmV4cG9ydCBjb25zdCBDQUNIRV9NQVhfQUdFX01TID0gNSAqIDYwICogMTAwMDsgLy8gNSBtaW51dGVzIGNhY2hlIGV4cGlyeVxyXG5cclxuaW1wb3J0IHR5cGUgeyBTZXR0aW5ncywgVGllciB9IGZyb20gXCIuL3R5cGVzXCI7XHJcblxyXG4vKiogRXhwbG9yZSdzIFwicGVyIHBhZ2VcIiBjaG9pY2VzOyAwIHNob3dzIGV2ZXJ5IHNjZW5lIG9uIG9uZSBwYWdlLiAqL1xyXG5leHBvcnQgY29uc3QgRVhQTE9SRV9QQUdFX1NJWkVTOiByZWFkb25seSBudW1iZXJbXSA9IFszMCwgNjAsIDEyMCwgMjQwLCAwXTtcclxuXHJcbi8qKiBQbHVnaW4gaWQgKGZvbGRlciBuYW1lKSDigJQga2V5IGZvciB0aGlzIHBsdWdpbidzIHNldHRpbmdzIGluIFN0YXNoJ3MgY29uZmlndXJhdGlvbi4gKi9cclxuZXhwb3J0IGNvbnN0IFBMVUdJTl9JRCA9IFwic3Rhc2gtYmF0dGxlXCI7XHJcblxyXG5leHBvcnQgY29uc3QgREVGQVVMVF9TRVRUSU5HUzogU2V0dGluZ3MgPSB7XHJcbiAgc3Rhc2hSYXRpbmdzOiBcIm9mZlwiLFxyXG4gIGVsb1NldHVwQXQ6IG51bGwsXHJcbiAgZWxvU2V0dXBNb2RlOiBudWxsLFxyXG4gIG9wZW5Jbk5ld1RhYjogZmFsc2UsXHJcbiAgcGxhY2VtZW50RnJvbUJvdHRvbTogZmFsc2UsXHJcbiAgdGllckJvcmRlcnM6IHRydWUsXHJcbiAgcHJldmlld1ZvbHVtZTogNTAsXHJcbiAgZXhwbG9yZVBhZ2VTaXplOiA2MCxcclxuICBhdXRvcGxheVByZXZpZXdzOiB0cnVlLFxyXG4gIGZpbHRlck9wcG9uZW50czogZmFsc2UsXHJcbiAgY2xlYW5Nb2RlOiBmYWxzZSxcclxuICBwYXVzZU1lZGlhT25PcGVuOiB0cnVlLFxyXG4gIHRlc3RNb2RlOiBmYWxzZSxcclxufTtcclxuXHJcbi8vIFByZS0yLjcgbG9jYWxTdG9yYWdlIHByZWZlcmVuY2Uga2V5cyAobWlncmF0ZWQgaW50byBwbHVnaW4gc2V0dGluZ3MpLlxyXG5leHBvcnQgY29uc3QgTEVHQUNZX0ZJTFRFUl9PUFBPTkVOVFNfS0VZID0gXCJzYl9maWx0ZXJPcHBvbmVudHNcIjtcclxuZXhwb3J0IGNvbnN0IExFR0FDWV9NVVRFX1BSRVZJRVdTX0tFWSA9IFwic2JfbXV0ZVByZXZpZXdzXCI7XHJcblxyXG4vKipcclxuICogU3dpc3M6IHRoZSBvcHBvbmVudCBpcyBwaWNrZWQgYXQgcmFuZG9tIGZyb20gZXZlcnkgc2NlbmUgd2l0aGluIMKxdGhpcyBFTE8gKHdpbiBjaGFuY2VzIGJldHdlZW5cclxuICogMzYlIGFuZCA2NCUpLiBBIHBpY2sgdGhhdCBjbG9zZSBzdGlsbCB0ZWxscyBvdmVyIDkwJSBvZiB3aGF0IGEgNTAvNTAgb25lIGRvZXMsIGFuZCBhIHNjZW5lIG1lZXRzXHJcbiAqIGZhciBtb3JlIHZhcmllZCBvcHBvbmVudHMgdGhhbiBhIHdpbmRvdyBvZiBuZWFyYnkgcmFua3MsIHdoaWNoIG9uIGEgc2VlZGVkIGxpYnJhcnkgaXMgbW9zdGx5XHJcbiAqIHRpZXMuXHJcbiAqL1xyXG5leHBvcnQgY29uc3QgU1dJU1NfT1BQT05FTlRfRUxPX1dJTkRPVyA9IDEwMDtcclxuLyoqIFN3aXNzOiB3aGVuIGZld2VyIHNjZW5lcyB0aGFuIHRoaXMgYXJlIGluIHRoZSB3aW5kb3cgKHRvcCwgYm90dG9tLCBzbWFsbCBwb29scyksIHRha2UgdGhpcyBtYW55IG5lYXJlc3QuICovXHJcbmV4cG9ydCBjb25zdCBTV0lTU19PUFBPTkVOVF9NSU5fQ0FORElEQVRFUyA9IDEwO1xyXG5cclxuLy8gQ2hhbXBpb246IHJhbmRvbSBwaWNrIGFtb25nIHRoZSBOIGNsb3Nlc3QgdW5kZWZlYXRlZCBvcHBvbmVudHMgYWJvdmUgdGhlIGNoYW1waW9uLlxyXG5leHBvcnQgY29uc3QgQ0xJTUJfT1BQT05FTlRfUElDS19XSU5ET1cgPSA1O1xyXG5cclxuLyoqXHJcbiAqIEVMTyBhbiB1bnJhdGVkIHNjZW5lIGNvdW50cyBhcyBpbiBDaGFtcGlvbjogMTAwMCwgdGhlIGJvdHRvbSAod2hhdCBhIDAgcmF0aW5nIHNlZWRzIHRvKSwgc28gYVxyXG4gKiBuZXdjb21lciBjbGltYnMgZnJvbSB0aGVyZSBhcyBiZWZvcmUuIFN3aXNzIGNvdW50cyB1bnJhdGVkIHNjZW5lcyBhcyBFTE9fU1RBUlQgKDE1MDApLlxyXG4gKi9cclxuZXhwb3J0IGNvbnN0IENIQU1QSU9OX1VOUkFURURfRUxPID0gMTAwMDtcclxuXHJcbi8qKlxyXG4gKiBBIHBpY2sgaXMgYW4gXCJVcHNldCFcIiB3aGVuIHRoZSB3aW5uZXIncyB3aW4gY2hhbmNlIChhcyBzaG93biwgaW4gJSkgd2FzIGF0IG1vc3QgdGhpczogYWJvdXQgNzBcclxuICogRUxPIGJlbG93IGl0cyBvcHBvbmVudC4gU3dpc3Mgb3Bwb25lbnRzIGFyZSB3aXRoaW4gwrExMDAsIHNvIGFib3V0IDEgcGljayBpbiA3IGlmIEVMTyBpcyByaWdodC5cclxuICovXHJcbmV4cG9ydCBjb25zdCBVUFNFVF9NQVhfQ0hBTkNFID0gNDA7XHJcblxyXG4vKiogU2hvdyBhIFVJIHdhcm5pbmcgd2hlbiBDaGFtcGlvbidzIG9wcG9uZW50IHBvb2wgaXMgc21hbGxlciB0aGFuIHRoaXMgKGZpbHRlciBvcHBvbmVudHMgb24pLiAqL1xyXG5leHBvcnQgY29uc3QgQ0xJTUJfU01BTExfUE9PTF9XQVJOX0FUID0gMTA7XHJcblxyXG4vLyAtLS0gVHJ1ZSBFTE8gKHN0b3JlZCBpbiBzY2VuZSBjdXN0b20gZmllbGRzKSAtLS1cclxuXHJcbi8qKiBTY2VuZSBjdXN0b20gZmllbGQga2V5cy4gV3JpdGVzIHVzZSBgcGFydGlhbGAsIHNvIG90aGVyIHBsdWdpbnMnIGZpZWxkcyBhcmUgbmV2ZXIgdG91Y2hlZC4gKi9cclxuZXhwb3J0IGNvbnN0IEVMT19GSUVMRCA9IFwic3Rhc2hfYmF0dGxlX2Vsb1wiO1xyXG4vKiogUmVhbCBiYXR0bGVzIHRoYXQgbW92ZWQgdGhpcyBzY2VuZSdzIEVMTyAoUGxhY2VtZW50IGFkZHMgaXRzIHJ1bidzIGJhdHRsZXMgd2hlbiB0aGUgc2NlbmUgbGFuZHMpLiAqL1xyXG5leHBvcnQgY29uc3QgQkFUVExFU19GSUVMRCA9IFwic3Rhc2hfYmF0dGxlX2JhdHRsZXNcIjtcclxuLyoqIFRydWUgd2hlbiB0aGUgc2NlbmUncyBzdGFydGluZyBFTE8gY2FtZSBmcm9tIGl0cyBTdGFzaCByYXRpbmcgKHNldHVwJ3MgXCJVc2UgbXkgcmF0aW5nc1wiKS4gKi9cclxuZXhwb3J0IGNvbnN0IFNFRURFRF9GSUVMRCA9IFwic3Rhc2hfYmF0dGxlX3NlZWRlZFwiO1xyXG4vKipcclxuICogQSBzY2VuZSdzIHJlY29yZCAoU3RhdHMg4oaSIFJlY29yZHMpOiBwaWNrcyB3b24gYW5kIGxvc3QsIGhpZ2hlc3QgRUxPLCBhbmQgd2luIHN0cmVha3MgKHRoZVxyXG4gKiBjdXJyZW50IG9uZSBpcyBrZXB0IHRvIGtub3cgd2hlbiBpdCBiZWF0cyB0aGUgYmVzdCkuIFdyaXR0ZW4gd2l0aCB0aGUgRUxPIG9uY2UgYSBzY2VuZSBoYXMgb25lLlxyXG4gKi9cclxuZXhwb3J0IGNvbnN0IFdJTlNfRklFTEQgPSBcInN0YXNoX2JhdHRsZV93aW5zXCI7XHJcbmV4cG9ydCBjb25zdCBMT1NTRVNfRklFTEQgPSBcInN0YXNoX2JhdHRsZV9sb3NzZXNcIjtcclxuZXhwb3J0IGNvbnN0IFBFQUtfRklFTEQgPSBcInN0YXNoX2JhdHRsZV9wZWFrXCI7XHJcbmV4cG9ydCBjb25zdCBTVFJFQUtfRklFTEQgPSBcInN0YXNoX2JhdHRsZV9zdHJlYWtcIjtcclxuZXhwb3J0IGNvbnN0IEJFU1RfU1RSRUFLX0ZJRUxEID0gXCJzdGFzaF9iYXR0bGVfYmVzdF9zdHJlYWtcIjtcclxuLyoqIFRoZSByZWNvcmQncyBmaWVsZHMgKHJlbW92ZWQgYnkgc2V0dXAgYW5kIFJlc2V0IEVMTywgd2hpY2ggc3RhcnQgZXZlcnkgcmVjb3JkIG92ZXIpLiAqL1xyXG5leHBvcnQgY29uc3QgUkVDT1JEX0ZJRUxEX0tFWVMgPSBbV0lOU19GSUVMRCwgTE9TU0VTX0ZJRUxELCBQRUFLX0ZJRUxELCBTVFJFQUtfRklFTEQsIEJFU1RfU1RSRUFLX0ZJRUxEXTtcclxuLyoqIEFsbCBvZiBTdGFzaCBCYXR0bGUncyBwZXItc2NlbmUgZmllbGRzIChyZW1vdmVkIHRvZ2V0aGVyIHdoZW4gYSBzY2VuZSBiZWNvbWVzIHVucmF0ZWQpLiAqL1xyXG5leHBvcnQgY29uc3QgRUxPX0ZJRUxEX0tFWVMgPSBbRUxPX0ZJRUxELCBCQVRUTEVTX0ZJRUxELCBTRUVERURfRklFTEQsIC4uLlJFQ09SRF9GSUVMRF9LRVlTXTtcclxuXHJcbmV4cG9ydCBjb25zdCBFTE9fU1RBUlQgPSAxNTAwO1xyXG5leHBvcnQgY29uc3QgRUxPX0RJVklTT1IgPSA0MDA7XHJcblxyXG4vKiogSyBieSBLLWdhbWVzIChiYXR0bGVzLCBwbHVzIHRoZSBoZWFkIHN0YXJ0IGlmIHNlZWRlZCk6IFtiZWxvdyB0aGlzIGNvdW50LCBLXTsgdGhlIGxhc3QgaGFzIG5vIGxpbWl0LiAqL1xyXG5leHBvcnQgY29uc3QgRUxPX0tfVElFUlM6IHJlYWRvbmx5IChyZWFkb25seSBbbnVtYmVyLCBudW1iZXJdKVtdID0gW1xyXG4gIFsxMCwgNDBdLFxyXG4gIFszMCwgMjRdLFxyXG4gIFtJbmZpbml0eSwgMTZdLFxyXG5dO1xyXG5cclxuLyoqXHJcbiAqIFRpZXJzIChcIlNob3cgdGllcnMgb24gY2FyZHNcIiksIGJlc3QgZmlyc3QsIGJ5IHJhbmsgYW1vbmcgdGhlIGxpYnJhcnkncyBzZXR0bGVkIHNjZW5lczogYSBzY2VuZVxyXG4gKiB3aG9zZSByYW5rIGlzIHdpdGhpbiB0aGUgdG9wIGB0b3BgIHNoYXJlIGdldHMgdGhlIGZpcnN0IHRpZXIgdGhhdCBmaXRzLiBFdmVyeSB0aWVyIGFsd2F5cyBoYXNcclxuICogc2NlbmVzIGluIGl0LCB3aGF0ZXZlciB0aGUgbGlicmFyeSdzIEVMTyBzcHJlYWQuIFRoZSBsYXN0IHRpZXIgdGFrZXMgZXZlcnlvbmUgZWxzZS5cclxuICovXHJcbmV4cG9ydCBjb25zdCBUSUVSUzogcmVhZG9ubHkgVGllcltdID0gW1xyXG4gIHsgaWQ6IFwibGVnZW5kYXJ5XCIsIG5hbWU6IFwiTGVnZW5kYXJ5XCIsIGVtb2ppOiBcIvCfkZFcIiwgdG9wOiAwLjAxIH0sXHJcbiAgeyBpZDogXCJkaWFtb25kXCIsIG5hbWU6IFwiRGlhbW9uZFwiLCBlbW9qaTogXCLwn5KOXCIsIHRvcDogMC4wNSB9LFxyXG4gIHsgaWQ6IFwicGxhdGludW1cIiwgbmFtZTogXCJQbGF0aW51bVwiLCBlbW9qaTogXCLwn5S3XCIsIHRvcDogMC4xNSB9LFxyXG4gIHsgaWQ6IFwiZ29sZFwiLCBuYW1lOiBcIkdvbGRcIiwgZW1vamk6IFwi8J+lh1wiLCB0b3A6IDAuMzUgfSxcclxuICB7IGlkOiBcInNpbHZlclwiLCBuYW1lOiBcIlNpbHZlclwiLCBlbW9qaTogXCLwn6WIXCIsIHRvcDogMC42NSB9LFxyXG4gIHsgaWQ6IFwiYnJvbnplXCIsIG5hbWU6IFwiQnJvbnplXCIsIGVtb2ppOiBcIvCfpYlcIiwgdG9wOiAxIH0sXHJcbl07XHJcblxyXG4vKipcclxuICogRUxPIHBvaW50cyBwZXIgMS0xMDAgcmF0aW5nIHBvaW50LiBUaGUgcHJlLTMuMCBtYXRoIGRpdmlkZWQgYnkgNDAgb24gdGhlIDEtMTAwIHNjYWxlLCBzbyBvbmVcclxuICogcmF0aW5nIHBvaW50IGFscmVhZHkgbWVhbnQgZXhhY3RseSAxMCBzdGFuZGFyZCAoZGl2aXNvciA0MDApIEVMTyBwb2ludHMuXHJcbiAqL1xyXG5leHBvcnQgY29uc3QgRUxPX1BFUl9SQVRJTkdfUE9JTlQgPSAxMDtcclxuXHJcbi8qKlxyXG4gKiBIZWFkIHN0YXJ0IChjb3VudGVkIGFzIGJhdHRsZXMgZm9yIEsgb25seSkgZm9yIHNjZW5lcyBzZWVkZWQgZnJvbSB0aGVpciBTdGFzaCByYXRpbmc6IHRoZWlyXHJcbiAqIHJhdGluZyBhbHJlYWR5IHNheXMgc29tZXRoaW5nLCBzbyB0aGV5IHNraXAgdGhlIGJpZ2dlc3Qgc3dpbmdzLiBDaGFuZ2luZyBpdCBhcHBsaWVzIHRvIGV2ZXJ5XHJcbiAqIHNlZWRlZCBzY2VuZSBhdCBvbmNlLCBiZWNhdXNlIGl0IGlzbid0IHN0b3JlZC5cclxuICovXHJcbmV4cG9ydCBjb25zdCBTRUVERURfSEVBRF9TVEFSVCA9IDEwO1xyXG5cclxuLyoqIEVMTyBnYXAgYWJvdmUgdGhlIHRvcCAvIGJlbG93IHRoZSBib3R0b20gc2NlbmUgd2hlbiBQbGFjZW1lbnQgbGFuZHMgYSBzY2VuZSBhdCBhbiBlZGdlLiAqL1xyXG5leHBvcnQgY29uc3QgUExBQ0VNRU5UX0VER0VfR0FQID0gMjU7XHJcblxyXG4vKipcclxuICogUGxhY2VtZW50J3MgZG91YmxpbmcganVtcHMgYXJlIGNhcHBlZCBhdCB0aGlzIHNoYXJlIG9mIHRoZSBwb29sIChidXQgYXQgbGVhc3RcclxuICogUExBQ0VNRU5UX01JTl9NQVhfSlVNUCByYW5rcyksIHNvIGEgd2lubmluZyBzdHJlYWsgY2xpbWJzIGluc3RlYWQgb2YgbGVhcGluZyB0byAjMS4gSW4gYVxyXG4gKiA2MDAtc2NlbmUgbGlicmFyeTogYXQgbW9zdCA2MCByYW5rcyBwZXIganVtcCwgYWJvdXQgb25lIGV4dHJhIGJhdHRsZSBvbiBhdmVyYWdlLlxyXG4gKi9cclxuZXhwb3J0IGNvbnN0IFBMQUNFTUVOVF9NQVhfSlVNUF9TSEFSRSA9IDAuMTtcclxuZXhwb3J0IGNvbnN0IFBMQUNFTUVOVF9NSU5fTUFYX0pVTVAgPSA0O1xyXG4iLCAiLy8gRUxPIG1hdGggKHB1cmUgY2FsY3VsYXRpb25zOiBjYWxsZXJzIGFwcGx5IHRoZSByZXN1bHRzIGFuZCBwZXJzaXN0IHRoZW0pLlxuXG5pbXBvcnQgeyBFTE9fRElWSVNPUiwgRUxPX0tfVElFUlMgfSBmcm9tIFwiLi9jb25zdGFudHNcIjtcblxuLyoqIEsgZm9yIGEgc2NlbmUgd2l0aCB0aGlzIG1hbnkgSy1nYW1lcyAoc2VlIGtHYW1lcyk6IG5ldyBzY2VuZXMgbW92ZSBhIGxvdCwgZXN0YWJsaXNoZWQgb25lcyBsaXR0bGUuICovXG5leHBvcnQgZnVuY3Rpb24gZWxvS0ZhY3RvcihrR2FtZXM6IG51bWJlcik6IG51bWJlciB7XG4gIGZvciAoY29uc3QgW2JlbG93LCBrXSBvZiBFTE9fS19USUVSUykge1xuICAgIGlmIChrR2FtZXMgPCBiZWxvdykgcmV0dXJuIGs7XG4gIH1cbiAgcmV0dXJuIEVMT19LX1RJRVJTW0VMT19LX1RJRVJTLmxlbmd0aCAtIDFdWzFdO1xufVxuXG4vKiogUHJvYmFiaWxpdHkgdGhhdCBhIHNjZW5lIHJhdGVkIGBlbG9gIGJlYXRzIG9uZSByYXRlZCBgb3Bwb25lbnRFbG9gLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVsb0V4cGVjdGVkKGVsbzogbnVtYmVyLCBvcHBvbmVudEVsbzogbnVtYmVyKTogbnVtYmVyIHtcbiAgcmV0dXJuIDEgLyAoMSArIE1hdGgucG93KDEwLCAob3Bwb25lbnRFbG8gLSBlbG8pIC8gRUxPX0RJVklTT1IpKTtcbn1cblxuLyoqXG4gKiBCb3RoIHNpZGVzJyB3aW4gY2hhbmNlcyBhcyB3aG9sZSBwZXJjZW50YWdlcyB0aGF0IGFsd2F5cyBhZGQgdXAgdG8gMTAwLCBrZXB0IHdpdGhpbiAxLTk5IChhXG4gKiBcIjEwMCVcIiB3b3VsZCByZWFkIGFzIGEgc3VyZSB0aGluZywgYW5kIEVMTyBuZXZlciBpcykuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB3aW5DaGFuY2VzKGVsbzogbnVtYmVyLCBvcHBvbmVudEVsbzogbnVtYmVyKTogW251bWJlciwgbnVtYmVyXSB7XG4gIGNvbnN0IGZpcnN0ID0gTWF0aC5taW4oOTksIE1hdGgubWF4KDEsIE1hdGgucm91bmQoZWxvRXhwZWN0ZWQoZWxvLCBvcHBvbmVudEVsbykgKiAxMDApKSk7XG4gIHJldHVybiBbZmlyc3QsIDEwMCAtIGZpcnN0XTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBFbG9TaWRlIHtcbiAgZWxvOiBudW1iZXI7XG4gIC8qKiBCYXR0bGVzIHBsdXMgYW55IHNlZWRlZCBoZWFkIHN0YXJ0IChzY29yZS50cyBrR2FtZXMpOiBzZXRzIHRoaXMgc2lkZSdzIEsuICovXG4gIGtHYW1lczogbnVtYmVyO1xufVxuXG4vKiogU3RvcmVkIEVMTyBwcmVjaXNpb24gKG9uZSBkZWNpbWFsKSwgc28gc21hbGwgbGF0ZS1jYXJlZXIgY2hhbmdlcyBhcmVuJ3Qgcm91bmRlZCBhd2F5LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJvdW5kRWxvKGVsbzogbnVtYmVyKTogbnVtYmVyIHtcbiAgcmV0dXJuIE1hdGgucm91bmQoZWxvICogMTApIC8gMTA7XG59XG5cbi8qKlxuICogVHdvLXNpZGVkIEVMTyBmb3IgYSBoZWFkLXRvLWhlYWQgd2luOyBlYWNoIHNpZGUgdXNlcyBpdHMgb3duIEsuIFJldHVybnMgdGhlIG5ldyBFTE9zLlxuICogRWFjaCBzaWRlIG1vdmVzIGJ5IEsgw5cgKGFjdHVhbCDiiJIgZXhwZWN0ZWQpOiB0aGUgd2lubmVyIGJ5IEsgw5cgKDEg4oiSIGl0cyB3aW4gY2hhbmNlKSwgdGhlIGxvc2VyXG4gKiBieSBLIMOXICgwIOKIkiBpdHMgb3duIHdpbiBjaGFuY2UpLCB3aGljaCBpcyB0aGUgc2FtZSAxIOKIkiB3aW5uZXIncyBjaGFuY2UuIFdpdGggZXF1YWwgSyB0aGVcbiAqIHBvaW50cyBhcmUgZXhhY3RseSB6ZXJvLXN1bS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVsb1Jlc3VsdCh3aW5uZXI6IEVsb1NpZGUsIGxvc2VyOiBFbG9TaWRlKTogeyB3aW5uZXI6IG51bWJlcjsgbG9zZXI6IG51bWJlciB9IHtcbiAgY29uc3Qgc3VycHJpc2UgPSAxIC0gZWxvRXhwZWN0ZWQod2lubmVyLmVsbywgbG9zZXIuZWxvKTtcbiAgcmV0dXJuIHtcbiAgICB3aW5uZXI6IHJvdW5kRWxvKHdpbm5lci5lbG8gKyBlbG9LRmFjdG9yKHdpbm5lci5rR2FtZXMpICogc3VycHJpc2UpLFxuICAgIGxvc2VyOiByb3VuZEVsbyhsb3Nlci5lbG8gLSBlbG9LRmFjdG9yKGxvc2VyLmtHYW1lcykgKiBzdXJwcmlzZSksXG4gIH07XG59XG4iLCAiLy8gQSBzY2VuZSdzIEVMTyAocmVhZCBmcm9tIGl0cyBjdXN0b20gZmllbGRzKSwgRUxPIG9yZGVyaW5nLCBhbmQgY29udmVyc2lvbnMgYmV0d2VlbiBFTE8gYW5kXG4vLyBTdGFzaCdzIDEtMTAwIHJhdGluZy4gUHVyZSBmdW5jdGlvbnM6IG5vIHN0YXRlLCBubyBJL08uXG5cbmltcG9ydCB7XG4gIEJBVFRMRVNfRklFTEQsXG4gIEJFU1RfU1RSRUFLX0ZJRUxELFxuICBFTE9fRklFTEQsXG4gIEVMT19GSUVMRF9LRVlTLFxuICBFTE9fS19USUVSUyxcbiAgRUxPX1BFUl9SQVRJTkdfUE9JTlQsXG4gIEVMT19TVEFSVCxcbiAgTE9TU0VTX0ZJRUxELFxuICBQRUFLX0ZJRUxELFxuICBQTEFDRU1FTlRfRURHRV9HQVAsXG4gIFNFRURFRF9GSUVMRCxcbiAgU0VFREVEX0hFQURfU1RBUlQsXG4gIFNUUkVBS19GSUVMRCxcbiAgV0lOU19GSUVMRCxcbn0gZnJvbSBcIi4vY29uc3RhbnRzXCI7XG5pbXBvcnQgeyByb3VuZEVsbyB9IGZyb20gXCIuL2Vsb1wiO1xuaW1wb3J0IHR5cGUgeyBFbG9GaWVsZHMsIEVsb1N0YXJ0LCBTY2VuZSwgU2NlbmVSZWNvcmQsIFN0YXNoUmF0aW5nc01vZGUgfSBmcm9tIFwiLi90eXBlc1wiO1xuXG4vKiogQ3VzdG9tIGZpZWxkIHZhbHVlcyBzaG91bGQgY29tZSBiYWNrIGFzIG51bWJlcnM7IG51bWVyaWMgc3RyaW5ncyBhcmUgYWNjZXB0ZWQgdG9vLiAqL1xuZnVuY3Rpb24gcmVhZE51bWJlcih2YWx1ZTogdW5rbm93bik6IG51bWJlciB8IG51bGwge1xuICBpZiAodHlwZW9mIHZhbHVlID09PSBcIm51bWJlclwiKSByZXR1cm4gTnVtYmVyLmlzRmluaXRlKHZhbHVlKSA/IHZhbHVlIDogbnVsbDtcbiAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gXCJzdHJpbmdcIiAmJiB2YWx1ZS50cmltKCkgIT09IFwiXCIpIHtcbiAgICBjb25zdCBuID0gTnVtYmVyKHZhbHVlKTtcbiAgICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pID8gbiA6IG51bGw7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbi8qKiBUaGUgc2NlbmUncyBzdG9yZWQgRUxPLCBvciBudWxsIHdoZW4gaXQgaGFzIG5vbmUgKHVucmF0ZWQpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVsbyhzY2VuZTogU2NlbmUpOiBudW1iZXIgfCBudWxsIHtcbiAgcmV0dXJuIHJlYWROdW1iZXIoc2NlbmUuY3VzdG9tX2ZpZWxkcz8uW0VMT19GSUVMRF0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaXNSYXRlZChzY2VuZTogU2NlbmUpOiBib29sZWFuIHtcbiAgcmV0dXJuIGVsbyhzY2VuZSkgIT09IG51bGw7XG59XG5cbi8qKiBSZWFsIGJhdHRsZXMgdGhhdCBtb3ZlZCB0aGUgc2NlbmUncyBFTE8uICovXG5leHBvcnQgZnVuY3Rpb24gYmF0dGxlcyhzY2VuZTogU2NlbmUpOiBudW1iZXIge1xuICBjb25zdCBuID0gcmVhZE51bWJlcihzY2VuZS5jdXN0b21fZmllbGRzPy5bQkFUVExFU19GSUVMRF0pO1xuICByZXR1cm4gbiAhPT0gbnVsbCAmJiBuID4gMCA/IE1hdGguZmxvb3IobikgOiAwO1xufVxuXG4vKiogVGhlIHNjZW5lJ3Mgc3RhcnRpbmcgRUxPIGNhbWUgZnJvbSBpdHMgU3Rhc2ggcmF0aW5nLiAoU3Rhc2ggc3RvcmVzIGB0cnVlYCBhcyAxLikgKi9cbmV4cG9ydCBmdW5jdGlvbiBpc1NlZWRlZChzY2VuZTogU2NlbmUpOiBib29sZWFuIHtcbiAgY29uc3QgdmFsdWUgPSBzY2VuZS5jdXN0b21fZmllbGRzPy5bU0VFREVEX0ZJRUxEXTtcbiAgcmV0dXJuIHZhbHVlID09PSB0cnVlIHx8IHZhbHVlID09PSAxIHx8IHZhbHVlID09PSBcInRydWVcIiB8fCB2YWx1ZSA9PT0gXCIxXCI7XG59XG5cbi8qKiBUaGUgY291bnQgSyBpcyBiYXNlZCBvbjogcmVhbCBiYXR0bGVzLCBwbHVzIHRoZSBoZWFkIHN0YXJ0IGZvciBzZWVkZWQgc2NlbmVzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGtHYW1lcyhzY2VuZTogU2NlbmUpOiBudW1iZXIge1xuICByZXR1cm4gYmF0dGxlcyhzY2VuZSkgKyAoaXNTZWVkZWQoc2NlbmUpID8gU0VFREVEX0hFQURfU1RBUlQgOiAwKTtcbn1cblxuLyoqXG4gKiBUaGUgc2NlbmUncyBFTE8gaXMgc3RpbGwgc2V0dGxpbmc6IGl0IGhhcyBmZXdlciBLLWdhbWVzIHRoYW4gdGhlIGZpcnN0IEsgdGllcidzIGxpbWl0ICgxMCksIHRoZVxuICogc3RhZ2Ugd2hlcmUgZWFjaCBiYXR0bGUgbW92ZXMgaXQgdGhlIG1vc3QuIFNlZWRlZCBzY2VuZXMgc3RhcnQgcGFzdCBpdDsgdW5yYXRlZCBvbmVzIGFyZW4ndC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzUHJvdmlzaW9uYWwoc2NlbmU6IFNjZW5lKTogYm9vbGVhbiB7XG4gIHJldHVybiBpc1JhdGVkKHNjZW5lKSAmJiBrR2FtZXMoc2NlbmUpIDwgRUxPX0tfVElFUlNbMF1bMF07XG59XG5cbi8qKiBUaGUgc2NlbmUncyByZWNvcmQsIG9yIG51bGwgYmVmb3JlIGl0cyBmaXJzdCBiYXR0bGUgc2luY2UgcmVjb3JkcyBiZWdhbi4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzY2VuZVJlY29yZChzY2VuZTogU2NlbmUpOiBTY2VuZVJlY29yZCB8IG51bGwge1xuICBjb25zdCBmaWVsZHMgPSBzY2VuZS5jdXN0b21fZmllbGRzO1xuICBjb25zdCBjb3VudCA9IChrZXk6IHN0cmluZyk6IG51bWJlciB8IG51bGwgPT4ge1xuICAgIGNvbnN0IG4gPSByZWFkTnVtYmVyKGZpZWxkcz8uW2tleV0pO1xuICAgIHJldHVybiBuID09PSBudWxsID8gbnVsbCA6IE1hdGgubWF4KDAsIE1hdGguZmxvb3IobikpO1xuICB9O1xuICBjb25zdCB3aW5zID0gY291bnQoV0lOU19GSUVMRCk7XG4gIGNvbnN0IGxvc3NlcyA9IGNvdW50KExPU1NFU19GSUVMRCk7XG4gIGNvbnN0IHBlYWsgPSByZWFkTnVtYmVyKGZpZWxkcz8uW1BFQUtfRklFTERdKTtcbiAgaWYgKHdpbnMgPT09IG51bGwgJiYgbG9zc2VzID09PSBudWxsICYmIHBlYWsgPT09IG51bGwpIHJldHVybiBudWxsO1xuICByZXR1cm4ge1xuICAgIHdpbnM6IHdpbnMgPz8gMCxcbiAgICBsb3NzZXM6IGxvc3NlcyA/PyAwLFxuICAgIHBlYWs6IHBlYWsgPz8gZWxvKHNjZW5lKSA/PyAwLFxuICAgIHN0cmVhazogY291bnQoU1RSRUFLX0ZJRUxEKSA/PyAwLFxuICAgIGJlc3RTdHJlYWs6IGNvdW50KEJFU1RfU1RSRUFLX0ZJRUxEKSA/PyAwLFxuICB9O1xufVxuXG4vKipcbiAqIFwiMTLigJM1XCIgKHdpbnPigJNsb3NzZXMpLCBvciBudWxsIGZvciBhIHNjZW5lIHdob3NlIGJhdHRsZXMgYWxsIGNhbWUgYmVmb3JlIHJlY29yZHMgYmVnYW4gKGl0XG4gKiBzaG93cyBpdHMgYmF0dGxlIGNvdW50IGluc3RlYWQpLiBBIHNjZW5lIHdpdGggbm8gYmF0dGxlcyBhdCBhbGwgc2hvd3MgXCIw4oCTMFwiLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVjb3JkVGV4dChzY2VuZTogU2NlbmUpOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3QgcmVjb3JkID0gc2NlbmVSZWNvcmQoc2NlbmUpO1xuICBpZiAocmVjb3JkKSByZXR1cm4gYCR7cmVjb3JkLndpbnN94oCTJHtyZWNvcmQubG9zc2VzfWA7XG4gIHJldHVybiBiYXR0bGVzKHNjZW5lKSA9PT0gMCA/IFwiMOKAkzBcIiA6IG51bGw7XG59XG5cbi8qKlxuICogQSByZWNvcmQgYWZ0ZXIgbW9yZSBwaWNrcywgaW4gb3JkZXIgKHRydWUgPSB3b24pLCB3aXRoIHRoZSBwZWFrIHJhaXNlZCB0byBgbmV3RWxvYC4gQSBzY2VuZSdzXG4gKiBmaXJzdCByZWNvcmQgc3RhcnRzIGZyb20gYHN0YXJ0RWxvYCAoaXRzIEVMTyBiZWZvcmUgdGhlc2UgcGlja3MpIGFzIHRoZSBwZWFrLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVjb3JkQWZ0ZXIocmVjb3JkOiBTY2VuZVJlY29yZCB8IG51bGwsIHJlc3VsdHM6IGJvb2xlYW5bXSwgc3RhcnRFbG86IG51bWJlciwgbmV3RWxvOiBudW1iZXIpOiBTY2VuZVJlY29yZCB7XG4gIGNvbnN0IG5leHQ6IFNjZW5lUmVjb3JkID0gcmVjb3JkID8geyAuLi5yZWNvcmQgfSA6IHsgd2luczogMCwgbG9zc2VzOiAwLCBwZWFrOiBzdGFydEVsbywgc3RyZWFrOiAwLCBiZXN0U3RyZWFrOiAwIH07XG4gIGZvciAoY29uc3Qgd29uIG9mIHJlc3VsdHMpIHtcbiAgICBpZiAod29uKSB7XG4gICAgICBuZXh0LndpbnMrKztcbiAgICAgIG5leHQuc3RyZWFrKys7XG4gICAgICBuZXh0LmJlc3RTdHJlYWsgPSBNYXRoLm1heChuZXh0LmJlc3RTdHJlYWssIG5leHQuc3RyZWFrKTtcbiAgICB9IGVsc2Uge1xuICAgICAgbmV4dC5sb3NzZXMrKztcbiAgICAgIG5leHQuc3RyZWFrID0gMDtcbiAgICB9XG4gIH1cbiAgbmV4dC5wZWFrID0gcm91bmRFbG8oTWF0aC5tYXgobmV4dC5wZWFrLCBuZXdFbG8pKTtcbiAgcmV0dXJuIG5leHQ7XG59XG5cbi8qKiBFbG9GaWVsZHMgYXMgdGhlIGN1c3RvbSBmaWVsZHMgbWFwIFN0YXNoIHN0b3JlcyAodGhlIHJlY29yZCdzIGZpZWxkcyBvbmx5IG9uY2UgaXQgaGFzIG9uZSkuICovXG5leHBvcnQgZnVuY3Rpb24gZWxvQ3VzdG9tRmllbGRzKHZhbHVlOiBFbG9GaWVsZHMpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gIGNvbnN0IGZpZWxkczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7IFtFTE9fRklFTERdOiB2YWx1ZS5lbG8sIFtCQVRUTEVTX0ZJRUxEXTogdmFsdWUuYmF0dGxlcywgW1NFRURFRF9GSUVMRF06IHZhbHVlLnNlZWRlZCB9O1xuICBjb25zdCByZWNvcmQgPSB2YWx1ZS5yZWNvcmQ7XG4gIGlmIChyZWNvcmQpIHtcbiAgICBPYmplY3QuYXNzaWduKGZpZWxkcywge1xuICAgICAgW1dJTlNfRklFTERdOiByZWNvcmQud2lucyxcbiAgICAgIFtMT1NTRVNfRklFTERdOiByZWNvcmQubG9zc2VzLFxuICAgICAgW1BFQUtfRklFTERdOiByZWNvcmQucGVhayxcbiAgICAgIFtTVFJFQUtfRklFTERdOiByZWNvcmQuc3RyZWFrLFxuICAgICAgW0JFU1RfU1RSRUFLX0ZJRUxEXTogcmVjb3JkLmJlc3RTdHJlYWssXG4gICAgfSk7XG4gIH1cbiAgcmV0dXJuIGZpZWxkcztcbn1cblxuLyoqIFN0YXJ0aW5nIEVMTyBmb3IgYSAxLTEwMCBTdGFzaCByYXRpbmc6IDUwIGlzIDE1MDAsIHNvIDEtMTAwIG1hcHMgb250byAxMDEwLTIwMDAuICovXG5leHBvcnQgZnVuY3Rpb24gc2VlZChyYXRpbmcxMDA6IG51bWJlcik6IG51bWJlciB7XG4gIHJldHVybiBFTE9fU1RBUlQgKyAocmF0aW5nMTAwIC0gNTApICogRUxPX1BFUl9SQVRJTkdfUE9JTlQ7XG59XG5cbi8qKiBFTE8gdXNlZCBpbiBiYXR0bGUgbWF0aDogdGhlIHN0b3JlZCBFTE8sIG9yIGB1bnJhdGVkRWxvYCBmb3IgdW5yYXRlZCBzY2VuZXMgKDE1MDAgYnkgZGVmYXVsdCkuICovXG5leHBvcnQgZnVuY3Rpb24gZWZmZWN0aXZlRWxvKHNjZW5lOiBTY2VuZSwgdW5yYXRlZEVsbzogbnVtYmVyID0gRUxPX1NUQVJUKTogbnVtYmVyIHtcbiAgcmV0dXJuIGVsbyhzY2VuZSkgPz8gdW5yYXRlZEVsbztcbn1cblxuLyoqIFN0cmFpZ2h0LWxpbmUgU3Rhc2ggcmF0aW5nOiB0aGUgaW52ZXJzZSBvZiBzZWVkKCksIGNsYW1wZWQgdG8gMS0xMDAuICovXG5leHBvcnQgZnVuY3Rpb24gbGluZWFyUmF0aW5nKGVsb1ZhbHVlOiBudW1iZXIpOiBudW1iZXIge1xuICBjb25zdCByYXRpbmcgPSBNYXRoLnJvdW5kKDUwICsgKGVsb1ZhbHVlIC0gRUxPX1NUQVJUKSAvIEVMT19QRVJfUkFUSU5HX1BPSU5UKTtcbiAgcmV0dXJuIE1hdGgubWluKDEwMCwgTWF0aC5tYXgoMSwgcmF0aW5nKSk7XG59XG5cbi8qKlxuICogUGVyY2VudGlsZSBTdGFzaCByYXRpbmdzIGZvciBldmVyeSBzY2VuZSB3aXRoIGFuIEVMTzogdGhlIHRvcCBzY2VuZSBpcyAxMDAsIHRoZSBib3R0b20gMSxcbiAqIGV2ZW5seSBzcGFjZWQgYnkgcmFuay4gVGllZCBzY2VuZXMgc2hhcmUgdGhlIG1pZGRsZSBwb3NpdGlvbiBvZiB0aGVpciB0aWUgZ3JvdXAsIHNvIGEgZnVsbHlcbiAqIHRpZWQgbGlicmFyeSBpcyA1MCBldmVyeXdoZXJlLiBVbnJhdGVkIHNjZW5lcyBhcmUgbGVmdCBvdXQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwZXJjZW50aWxlUmF0aW5ncyhzY2VuZXM6IFNjZW5lW10pOiBNYXA8c3RyaW5nLCBudW1iZXI+IHtcbiAgY29uc3QgcmF0ZWQgPSBzY2VuZXNcbiAgICAubWFwKChzY2VuZSkgPT4gKHsgaWQ6IHNjZW5lLmlkLCBlbG86IGVsbyhzY2VuZSkgfSkpXG4gICAgLmZpbHRlcigocyk6IHMgaXMgeyBpZDogc3RyaW5nOyBlbG86IG51bWJlciB9ID0+IHMuZWxvICE9PSBudWxsKVxuICAgIC5zb3J0KChhLCBiKSA9PiBiLmVsbyAtIGEuZWxvKTtcblxuICBjb25zdCByYXRpbmdzID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgY29uc3QgbiA9IHJhdGVkLmxlbmd0aDtcbiAgaWYgKG4gPT09IDEpIHtcbiAgICByYXRpbmdzLnNldChyYXRlZFswXS5pZCwgNTApO1xuICAgIHJldHVybiByYXRpbmdzO1xuICB9XG5cbiAgbGV0IHN0YXJ0ID0gMDtcbiAgd2hpbGUgKHN0YXJ0IDwgbikge1xuICAgIGxldCBlbmQgPSBzdGFydDtcbiAgICB3aGlsZSAoZW5kICsgMSA8IG4gJiYgcmF0ZWRbZW5kICsgMV0uZWxvID09PSByYXRlZFtzdGFydF0uZWxvKSBlbmQrKztcbiAgICAvLyBSb3VuZGluZyBpbnNpZGUga2VlcHMgYSB0aWUgYXQgdGhlIGV4YWN0IG1pZGRsZSBvbiA1MCByYXRoZXIgdGhhbiA1MVxuICAgIGNvbnN0IHJhdGluZyA9IDEwMCAtIE1hdGgucm91bmQoKDk5ICogKChzdGFydCArIGVuZCkgLyAyKSkgLyAobiAtIDEpKTtcbiAgICBmb3IgKGxldCBpID0gc3RhcnQ7IGkgPD0gZW5kOyBpKyspIHJhdGluZ3Muc2V0KHJhdGVkW2ldLmlkLCByYXRpbmcpO1xuICAgIHN0YXJ0ID0gZW5kICsgMTtcbiAgfVxuICByZXR1cm4gcmF0aW5ncztcbn1cblxuLyoqIFRhcmdldCBTdGFzaCByYXRpbmcgZm9yIGV2ZXJ5IHNjZW5lIHdpdGggYW4gRUxPLCB1bmRlciB0aGUgZ2l2ZW4gbW9kZSAobm9uZSBmb3IgXCJvZmZcIikuICovXG5leHBvcnQgZnVuY3Rpb24gc3Rhc2hSYXRpbmdUYXJnZXRzKHNjZW5lczogU2NlbmVbXSwgbW9kZTogU3Rhc2hSYXRpbmdzTW9kZSk6IE1hcDxzdHJpbmcsIG51bWJlcj4ge1xuICBpZiAobW9kZSA9PT0gXCJwZXJjZW50aWxlXCIpIHJldHVybiBwZXJjZW50aWxlUmF0aW5ncyhzY2VuZXMpO1xuICBjb25zdCB0YXJnZXRzID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgaWYgKG1vZGUgPT09IFwibGluZWFyXCIpIHtcbiAgICBmb3IgKGNvbnN0IHNjZW5lIG9mIHNjZW5lcykge1xuICAgICAgY29uc3QgdmFsdWUgPSBlbG8oc2NlbmUpO1xuICAgICAgaWYgKHZhbHVlICE9PSBudWxsKSB0YXJnZXRzLnNldChzY2VuZS5pZCwgbGluZWFyUmF0aW5nKHZhbHVlKSk7XG4gICAgfVxuICB9XG4gIHJldHVybiB0YXJnZXRzO1xufVxuXG4vKiogVGhlIFN0YXNoIHJhdGluZ3MgYSBzeW5jIHdvdWxkIHdyaXRlOiBzY2VuZSBpZCB0byBuZXcgcmF0aW5nLCBvbmx5IHdoZXJlIGl0IGRpZmZlcnMgZnJvbSBub3cuICovXG5leHBvcnQgZnVuY3Rpb24gc3Rhc2hSYXRpbmdDaGFuZ2VzKHNjZW5lczogU2NlbmVbXSwgbW9kZTogU3Rhc2hSYXRpbmdzTW9kZSk6IE1hcDxzdHJpbmcsIG51bWJlcj4ge1xuICBjb25zdCBjdXJyZW50ID0gbmV3IE1hcChzY2VuZXMubWFwKChzY2VuZSkgPT4gW3NjZW5lLmlkLCBzY2VuZS5yYXRpbmcxMDAgPz8gbnVsbF0pKTtcbiAgY29uc3QgY2hhbmdlcyA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG4gIGZvciAoY29uc3QgW2lkLCByYXRpbmddIG9mIHN0YXNoUmF0aW5nVGFyZ2V0cyhzY2VuZXMsIG1vZGUpKSB7XG4gICAgaWYgKGN1cnJlbnQuZ2V0KGlkKSAhPT0gcmF0aW5nKSBjaGFuZ2VzLnNldChpZCwgcmF0aW5nKTtcbiAgfVxuICByZXR1cm4gY2hhbmdlcztcbn1cblxuLyoqXG4gKiBFTE8gYW5kIGdhbWVzIGEgc2NlbmUgZ2V0cyBmcm9tIHRoZSBvbmUtdGltZSBzZXR1cCwgb3IgbnVsbCB3aGVuIGl0IHN0YXJ0cyB1bnJhdGVkLlxuICogXCJyYXRpbmdzXCIgc2VlZHMgcmF0ZWQgc2NlbmVzIGZyb20gdGhlaXIgU3Rhc2ggcmF0aW5nOyBcImZyZXNoXCIgc3RhcnRzIGV2ZXJ5IHNjZW5lIGF0IDE1MDAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzdGFydGluZ0VsbyhzY2VuZTogU2NlbmUsIHN0YXJ0OiBFbG9TdGFydCk6IEVsb0ZpZWxkcyB8IG51bGwge1xuICBpZiAoc3RhcnQgPT09IFwiZnJlc2hcIikgcmV0dXJuIHsgZWxvOiBFTE9fU1RBUlQsIGJhdHRsZXM6IDAsIHNlZWRlZDogZmFsc2UgfTtcbiAgcmV0dXJuIHNjZW5lLnJhdGluZzEwMCAhPSBudWxsID8geyBlbG86IHNlZWQoc2NlbmUucmF0aW5nMTAwKSwgYmF0dGxlczogMCwgc2VlZGVkOiB0cnVlIH0gOiBudWxsO1xufVxuXG4vKiogQSBjb3B5IG9mIGEgY3VzdG9tIGZpZWxkcyBtYXAgd2l0aCB0aGUgRUxPIGZpZWxkcyBzZXQgdG8gYHZhbHVlYCAob3IsIHdpdGggbnVsbCwgcmVtb3ZlZCkuICovXG5leHBvcnQgZnVuY3Rpb24gd2l0aEVsb0ZpZWxkcyhjdXN0b21GaWVsZHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbCB8IHVuZGVmaW5lZCwgdmFsdWU6IEVsb0ZpZWxkcyB8IG51bGwpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gIGNvbnN0IGZpZWxkcyA9IHsgLi4uY3VzdG9tRmllbGRzIH07XG4gIGZvciAoY29uc3Qga2V5IG9mIEVMT19GSUVMRF9LRVlTKSBkZWxldGUgZmllbGRzW2tleV07XG4gIGlmICh2YWx1ZSkgT2JqZWN0LmFzc2lnbihmaWVsZHMsIGVsb0N1c3RvbUZpZWxkcyh2YWx1ZSkpO1xuICByZXR1cm4gZmllbGRzO1xufVxuXG4vKiogVGhlIHNjZW5lJ3MgRUxPIGZpZWxkcyAoYW5kIHJlY29yZCwgb25jZSBpdCBoYXMgb25lKSwgb3IgbnVsbCB3aGVuIGl0J3MgdW5yYXRlZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlbG9GaWVsZHMoc2NlbmU6IFNjZW5lKTogRWxvRmllbGRzIHwgbnVsbCB7XG4gIGNvbnN0IHZhbHVlID0gZWxvKHNjZW5lKTtcbiAgaWYgKHZhbHVlID09PSBudWxsKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgcmVjb3JkID0gc2NlbmVSZWNvcmQoc2NlbmUpO1xuICByZXR1cm4geyBlbG86IHZhbHVlLCBiYXR0bGVzOiBiYXR0bGVzKHNjZW5lKSwgc2VlZGVkOiBpc1NlZWRlZChzY2VuZSksIC4uLihyZWNvcmQgPyB7IHJlY29yZCB9IDoge30pIH07XG59XG5cbi8qKiBBIGNvcHkgb2YgdGhlIHNjZW5lIGFzIGl0IHdvdWxkIGJlIHJpZ2h0IGFmdGVyIHNldHVwIChpdHMgRUxPIGZpZWxkcyByZXBsYWNlZCkuICovXG5leHBvcnQgZnVuY3Rpb24gYWZ0ZXJTZXR1cChzY2VuZTogU2NlbmUsIHN0YXJ0OiBFbG9TdGFydCk6IFNjZW5lIHtcbiAgcmV0dXJuIHsgLi4uc2NlbmUsIGN1c3RvbV9maWVsZHM6IHdpdGhFbG9GaWVsZHMoc2NlbmUuY3VzdG9tX2ZpZWxkcywgc3RhcnRpbmdFbG8oc2NlbmUsIHN0YXJ0KSkgfTtcbn1cblxuLyoqIEhpZ2hlc3QgRUxPIGZpcnN0LCB1bnJhdGVkIHNjZW5lcyBsYXN0LiBFcXVhbCBFTE9zIGtlZXAgdGhlaXIgb3JkZXIgKEFycmF5LnNvcnQgaXMgc3RhYmxlKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb21wYXJlQnlFbG8oYTogU2NlbmUsIGI6IFNjZW5lKTogbnVtYmVyIHtcbiAgY29uc3QgZWxvQSA9IGVsbyhhKTtcbiAgY29uc3QgZWxvQiA9IGVsbyhiKTtcbiAgaWYgKGVsb0EgPT09IG51bGwpIHJldHVybiBlbG9CID09PSBudWxsID8gMCA6IDE7XG4gIGlmIChlbG9CID09PSBudWxsKSByZXR1cm4gLTE7XG4gIHJldHVybiBlbG9CIC0gZWxvQTtcbn1cblxuLyoqIFNvcnQgc2NlbmVzIGluIHBsYWNlIGJ5IEVMTyAoc2VlIGNvbXBhcmVCeUVsbykgYW5kIHJldHVybiB0aGUgc2FtZSBhcnJheS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzb3J0QnlFbG8oc2NlbmVzOiBTY2VuZVtdKTogU2NlbmVbXSB7XG4gIHJldHVybiBzY2VuZXMuc29ydChjb21wYXJlQnlFbG8pO1xufVxuXG4vKiogSW5kZXggd2hlcmUgYSBzY2VuZSB3aXRoIHRoaXMgRUxPIHdvdWxkIHNpdCBpbiBhbiBFTE8tc29ydGVkIHBvb2w6IGJlbG93IGV2ZXJ5IGVxdWFsIG9yIGhpZ2hlciBvbmUuICovXG5leHBvcnQgZnVuY3Rpb24gZWxvSW5zZXJ0aW9uSW5kZXgocG9vbDogU2NlbmVbXSwgZWxvVmFsdWU6IG51bWJlcik6IG51bWJlciB7XG4gIGNvbnN0IGlkeCA9IHBvb2wuZmluZEluZGV4KChzKSA9PiB7XG4gICAgY29uc3Qgb3RoZXIgPSBlbG8ocyk7XG4gICAgcmV0dXJuIG90aGVyID09PSBudWxsIHx8IG90aGVyIDwgZWxvVmFsdWU7XG4gIH0pO1xuICByZXR1cm4gaWR4ID09PSAtMSA/IHBvb2wubGVuZ3RoIDogaWR4O1xufVxuXG4vKipcbiAqIEluZGV4ZXMgb2YgdGhlIFN3aXNzIG9wcG9uZW50cyBmb3IgYSBzY2VuZSBhdCBgZWxvVmFsdWVgOiBldmVyeSBzY2VuZSBpbiB0aGUgcG9vbCB3aXRoaW5cbiAqIMKxYHdpbmRvd2AgRUxPICh1bnJhdGVkIG9uZXMgY291bnQgYXMgRUxPX1NUQVJULCBhcyBpbiBTd2lzcyBiYXR0bGVzKSwgb3IsIHdoZW4gdGhhdCdzIGZld2VyIHRoYW5cbiAqIGBtaW5Db3VudGAsIHRoZSBgbWluQ291bnRgIG5lYXJlc3QgYnkgRUxPIChwbHVzIGFueSB0aWVkIHdpdGggdGhlIGxhc3Qgb2YgdGhlbSkuIFRoZSBzY2VuZVxuICogaXRzZWxmIChgZXhjbHVkZUlkYCkgaXMgbmV2ZXIgb25lLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc3dpc3NPcHBvbmVudEluZGV4ZXMoXG4gIHBvb2w6IFNjZW5lW10sXG4gIGVsb1ZhbHVlOiBudW1iZXIsXG4gIGV4Y2x1ZGVJZDogc3RyaW5nLFxuICB3aW5kb3c6IG51bWJlcixcbiAgbWluQ291bnQ6IG51bWJlcixcbik6IG51bWJlcltdIHtcbiAgY29uc3Qgb3RoZXJzID0gcG9vbFxuICAgIC5tYXAoKHNjZW5lLCBpZHgpID0+ICh7IGlkeCwgZ2FwOiBNYXRoLmFicyhlZmZlY3RpdmVFbG8oc2NlbmUpIC0gZWxvVmFsdWUpLCBpZDogc2NlbmUuaWQgfSkpXG4gICAgLmZpbHRlcigocykgPT4gcy5pZCAhPT0gZXhjbHVkZUlkKTtcbiAgY29uc3QgaW5XaW5kb3cgPSBvdGhlcnMuZmlsdGVyKChzKSA9PiBzLmdhcCA8PSB3aW5kb3cpO1xuICBpZiAoaW5XaW5kb3cubGVuZ3RoID49IG1pbkNvdW50IHx8IGluV2luZG93Lmxlbmd0aCA9PT0gb3RoZXJzLmxlbmd0aCkgcmV0dXJuIGluV2luZG93Lm1hcCgocykgPT4gcy5pZHgpO1xuICBjb25zdCBieUdhcCA9IFsuLi5vdGhlcnNdLnNvcnQoKGEsIGIpID0+IGEuZ2FwIC0gYi5nYXApO1xuICBjb25zdCBjdXRvZmYgPSBieUdhcFtNYXRoLm1pbihtaW5Db3VudCwgYnlHYXAubGVuZ3RoKSAtIDFdLmdhcDtcbiAgcmV0dXJuIGJ5R2FwLmZpbHRlcigocykgPT4gcy5nYXAgPD0gY3V0b2ZmKS5tYXAoKHMpID0+IHMuaWR4KS5zb3J0KChhLCBiKSA9PiBhIC0gYik7XG59XG5cbi8qKlxuICogRUxPIGZvciBhIHNjZW5lIFBsYWNlbWVudCBsYW5kcyBiZXR3ZWVuIHR3byBuZWlnaGJvdXJzIChudWxsIHdoZXJlIHRoZXJlJ3Mgbm9uZSwgb3IgdGhlXG4gKiBuZWlnaGJvdXIgaXMgdW5yYXRlZCk6IHRoZWlyIG1pZHBvaW50LCBvciBQTEFDRU1FTlRfRURHRV9HQVAgYmV5b25kIHRoZSBvbmx5IG9uZSBhdCBhbiBlZGdlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGxhY2VtZW50RWxvKGFib3ZlRWxvOiBudW1iZXIgfCBudWxsLCBiZWxvd0VsbzogbnVtYmVyIHwgbnVsbCk6IG51bWJlciB7XG4gIGlmIChhYm92ZUVsbyA9PT0gbnVsbCAmJiBiZWxvd0VsbyA9PT0gbnVsbCkgcmV0dXJuIEVMT19TVEFSVDtcbiAgaWYgKGFib3ZlRWxvID09PSBudWxsKSByZXR1cm4gcm91bmRFbG8oKGJlbG93RWxvIGFzIG51bWJlcikgKyBQTEFDRU1FTlRfRURHRV9HQVApO1xuICBpZiAoYmVsb3dFbG8gPT09IG51bGwpIHJldHVybiByb3VuZEVsbyhhYm92ZUVsbyAtIFBMQUNFTUVOVF9FREdFX0dBUCk7XG4gIC8vIE5laWdoYm91cnMgMC4xIGFwYXJ0IChvciB0aWVkKSBoYXZlIG5vIHJvb20gYmV0d2VlbiB0aGVtOiB0YWtlIHRoZSB1cHBlciBvbmUncyBFTE8sIHdoaWNoXG4gIC8vIHN0aWxsIHNvcnRzIHRoZSBzY2VuZSBiZWxvdyBpdCAoZXF1YWwgRUxPcyBnbyBiZWxvdykgYW5kIHNvIGluIHRoZSBzYW1lIHNsb3RcbiAgY29uc3QgbWlkID0gcm91bmRFbG8oKGFib3ZlRWxvICsgYmVsb3dFbG8pIC8gMik7XG4gIHJldHVybiBtaWQgPiBiZWxvd0VsbyA/IG1pZCA6IGFib3ZlRWxvO1xufVxuIiwgIi8vIEdyYXBoUUwgYWNjZXNzIGFnYWluc3QgdGhlIFN0YXNoIGJhY2tlbmQuXG5cbmltcG9ydCB0eXBlIHsgQXBvbGxvQ2FjaGVMaWtlIH0gZnJvbSBcIi4vcGx1Z2luQXBpXCI7XG5pbXBvcnQgeyB3aXRoRWxvRmllbGRzIH0gZnJvbSBcIi4vc2NvcmVcIjtcbmltcG9ydCB0eXBlIHsgRWxvRmllbGRzLCBGaW5kU2NlbmVSZXN1bHQsIFNjZW5lIH0gZnJvbSBcIi4vdHlwZXNcIjtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdyYXBocWxRdWVyeTxUID0gdW5rbm93bj4oXG4gIHF1ZXJ5OiBzdHJpbmcsXG4gIHZhcmlhYmxlczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fSxcbik6IFByb21pc2U8VD4ge1xuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKFwiL2dyYXBocWxcIiwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgaGVhZGVyczoge1xuICAgICAgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIsXG4gICAgfSxcbiAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IHF1ZXJ5LCB2YXJpYWJsZXMgfSksXG4gIH0pO1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXNwb25zZS5qc29uKCk7XG4gIGlmIChyZXN1bHQuZXJyb3JzKSB7XG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIEdyYXBoUUwgZXJyb3I6XCIsIHJlc3VsdC5lcnJvcnMpO1xuICAgIHRocm93IG5ldyBFcnJvcihyZXN1bHQuZXJyb3JzWzBdLm1lc3NhZ2UpO1xuICB9XG4gIHJldHVybiByZXN1bHQuZGF0YSBhcyBUO1xufVxuXG5leHBvcnQgY29uc3QgU0NFTkVfRlJBR01FTlQgPSBgXG4gICAgaWRcbiAgICB0aXRsZVxuICAgIGRhdGVcbiAgICByYXRpbmcxMDBcbiAgICBwbGF5X2NvdW50XG4gICAgY3VzdG9tX2ZpZWxkc1xuICAgIHBhdGhzIHtcbiAgICAgIHNjcmVlbnNob3RcbiAgICAgIHByZXZpZXdcbiAgICB9XG4gICAgZmlsZXMge1xuICAgICAgZHVyYXRpb25cbiAgICAgIHBhdGhcbiAgICB9XG4gICAgc3R1ZGlvIHtcbiAgICAgIG5hbWVcbiAgICB9XG4gICAgcGVyZm9ybWVycyB7XG4gICAgICBuYW1lXG4gICAgfVxuICAgIHRhZ3Mge1xuICAgICAgbmFtZVxuICAgIH1cbiAgYDtcblxuZXhwb3J0IGNvbnN0IEZJTkRfU0NFTkVTX1FVRVJZID0gYFxuICAgICAgcXVlcnkgRmluZFNjZW5lc0J5UmF0aW5nKCRmaWx0ZXI6IEZpbmRGaWx0ZXJUeXBlLCAkc2NlbmVfZmlsdGVyOiBTY2VuZUZpbHRlclR5cGUpIHtcbiAgICAgICAgZmluZFNjZW5lcyhmaWx0ZXI6ICRmaWx0ZXIsIHNjZW5lX2ZpbHRlcjogJHNjZW5lX2ZpbHRlcikge1xuICAgICAgICAgIGNvdW50XG4gICAgICAgICAgc2NlbmVzIHtcbiAgICAgICAgICAgICR7U0NFTkVfRlJBR01FTlR9XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgYDtcblxubGV0IGN1c3RvbUZpZWxkc1N1cHBvcnQ6IFByb21pc2U8Ym9vbGVhbj4gfCBudWxsID0gbnVsbDtcblxuLyoqXG4gKiBXaGV0aGVyIHRoaXMgU3Rhc2ggaGFzIHNjZW5lIGN1c3RvbSBmaWVsZHMgKG5lZWRlZCBmb3IgRUxPIHN0b3JhZ2UpLiBDaGVja2VkIG9uY2UgcGVyIHBhZ2VcbiAqIGxvYWQgdmlhIGludHJvc3BlY3Rpb247IGlmIGludHJvc3BlY3Rpb24gaXRzZWxmIGZhaWxzLCBhc3N1bWUgeWVzIGFuZCBsZXQgcmVhbCBxdWVyaWVzIHJlcG9ydC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNjZW5lQ3VzdG9tRmllbGRzU3VwcG9ydGVkKCk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBjdXN0b21GaWVsZHNTdXBwb3J0ID8/PSBncmFwaHFsUXVlcnk8eyBfX3R5cGU6IHsgZmllbGRzOiB7IG5hbWU6IHN0cmluZyB9W10gfSB8IG51bGwgfT4oXG4gICAgYHF1ZXJ5IHsgX190eXBlKG5hbWU6IFwiU2NlbmVcIikgeyBmaWVsZHMgeyBuYW1lIH0gfSB9YCxcbiAgKVxuICAgIC50aGVuKChkYXRhKSA9PiBkYXRhLl9fdHlwZT8uZmllbGRzLnNvbWUoKGYpID0+IGYubmFtZSA9PT0gXCJjdXN0b21fZmllbGRzXCIpID8/IHRydWUpXG4gICAgLmNhdGNoKChlKSA9PiB7XG4gICAgICBjb25zb2xlLndhcm4oXCJbU3Rhc2ggQmF0dGxlXSBDb3VsZCBub3QgY2hlY2sgZm9yIHNjZW5lIGN1c3RvbSBmaWVsZHM6XCIsIGUpO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfSk7XG4gIHJldHVybiBjdXN0b21GaWVsZHNTdXBwb3J0O1xufVxuXG4vKiogQSBjaGFuZ2UgU3Rhc2ggQmF0dGxlIHdyb3RlIHRvIGEgc2NlbmUsIHRvIG1pcnJvciBpbnRvIFN0YXNoJ3Mgb3duIHBhZ2UgY2FjaGUuICovXG5leHBvcnQgaW50ZXJmYWNlIFN0YXNoQ2FjaGVVcGRhdGUge1xuICBpZDogc3RyaW5nO1xuICByYXRpbmcxMDA/OiBudW1iZXIgfCBudWxsO1xuICAvKiogTmV3IEVMTyBmaWVsZHMsIG9yIG51bGwgd2hlbiB0aGV5IHdlcmUgcmVtb3ZlZC4gKi9cbiAgZWxvPzogRWxvRmllbGRzIHwgbnVsbDtcbn1cblxuZnVuY3Rpb24gc3Rhc2hBcG9sbG9DYWNoZSgpOiBBcG9sbG9DYWNoZUxpa2UgfCB1bmRlZmluZWQge1xuICB0cnkge1xuICAgIHJldHVybiB3aW5kb3cuUGx1Z2luQXBpPy51dGlscz8uU3Rhc2hTZXJ2aWNlPy5nZXRDbGllbnQ/LigpPy5jYWNoZTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxufVxuXG4vKiogV2hpbGUgU3Rhc2ggQmF0dGxlIGlzIG9wZW4sIFN0YXNoJ3MgY2FjaGVkIHNjZW5lIGxpc3RzIGFyZSBkcm9wcGVkIG9uY2Ugb24gY2xvc2UsIG5vdCBldmVyeSBiYXR0bGUuICovXG5sZXQgaG9sZExpc3RSZWZyZXNoID0gZmFsc2U7XG5sZXQgbGlzdHNTdGFsZSA9IGZhbHNlO1xuXG4vKiogRHJvcCBTdGFzaCdzIGNhY2hlZCBzY2VuZSBsaXN0cyAodGhleSByZWZldGNoKSwgc28gcmF0aW5nLXNvcnRlZCBsaXN0cyByZS1zb3J0LiAqL1xuZnVuY3Rpb24gZHJvcFN0YXNoTGlzdHMoY2FjaGU6IEFwb2xsb0NhY2hlTGlrZSB8IHVuZGVmaW5lZCA9IHN0YXNoQXBvbGxvQ2FjaGUoKSk6IHZvaWQge1xuICBsaXN0c1N0YWxlID0gZmFsc2U7XG4gIGlmICghY2FjaGUpIHJldHVybjtcbiAgdHJ5IHtcbiAgICBjYWNoZS5ldmljdCh7IGlkOiBcIlJPT1RfUVVFUllcIiwgZmllbGROYW1lOiBcImZpbmRTY2VuZXNcIiB9KTtcbiAgICBjYWNoZS5nYygpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS53YXJuKFwiW1N0YXNoIEJhdHRsZV0gQ291bGQgbm90IHJlZnJlc2ggU3Rhc2gncyBzY2VuZSBsaXN0czpcIiwgZSk7XG4gIH1cbn1cblxuLyoqXG4gKiBIb2xkIGJhY2sgZHJvcHBpbmcgU3Rhc2gncyBzY2VuZSBsaXN0cyB3aGlsZSBTdGFzaCBCYXR0bGUgaXMgb3BlbiAodHJ1ZSk7IHJlbGVhc2luZyBpdCAoZmFsc2UpXG4gKiBkcm9wcyB0aGVtIG9uY2UgaWYgcmF0aW5ncyBjaGFuZ2VkIG1lYW53aGlsZS4gVGhlIHBhZ2VzIGJlaGluZCB0aGUgbW9kYWwgY2FuIHdhaXQsIGFuZCBhIGRyb3BcbiAqIHBlciBiYXR0bGUgd291bGQgcmVmZXRjaCBldmVyeSBsaXN0IGVhY2ggcGljay5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhvbGRTdGFzaExpc3RSZWZyZXNoKGhvbGQ6IGJvb2xlYW4pOiB2b2lkIHtcbiAgaG9sZExpc3RSZWZyZXNoID0gaG9sZDtcbiAgaWYgKCFob2xkICYmIGxpc3RzU3RhbGUpIGRyb3BTdGFzaExpc3RzKCk7XG59XG5cbi8qKlxuICogU3Rhc2ggQmF0dGxlIHdyaXRlcyB3aXRoIHBsYWluIGZldGNoLCBzbyBTdGFzaCdzIG93biBwYWdlcyAoQXBvbGxvKSBuZXZlciBzZWUgdGhlIGNoYW5nZXMgYW5kXG4gKiBrZWVwIHNob3dpbmcgb2xkIHJhdGluZ3MgdW50aWwgcmVmcmVzaGVkLiBNaXJyb3IgdGhlIGNoYW5nZXMgaW50byBBcG9sbG8ncyBjYWNoZWQgc2NlbmVzLCBhbmRcbiAqIHdoZW4gcmF0aW5ncyBjaGFuZ2VkLCBkcm9wIGNhY2hlZCBzY2VuZSBsaXN0cyBzbyByYXRpbmctc29ydGVkIGxpc3RzIHJlLXNvcnQgKGhlbGQgYmFjayB3aGlsZVxuICogU3Rhc2ggQmF0dGxlIGlzIG9wZW4sIHNlZSBob2xkU3Rhc2hMaXN0UmVmcmVzaCkuIERvZXMgbm90aGluZyBpZiBTdGFzaCBkb2Vzbid0IGV4cG9zZSBpdHMgY2xpZW50LlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVmcmVzaFN0YXNoQ2FjaGUodXBkYXRlczogU3Rhc2hDYWNoZVVwZGF0ZVtdLCByYXRpbmdzQ2hhbmdlZDogYm9vbGVhbik6IHZvaWQge1xuICBjb25zdCBjYWNoZSA9IHN0YXNoQXBvbGxvQ2FjaGUoKTtcbiAgaWYgKCFjYWNoZSkgcmV0dXJuO1xuICB0cnkge1xuICAgIGZvciAoY29uc3QgdXBkYXRlIG9mIHVwZGF0ZXMpIHtcbiAgICAgIGNvbnN0IGlkID0gY2FjaGUuaWRlbnRpZnkoeyBfX3R5cGVuYW1lOiBcIlNjZW5lXCIsIGlkOiB1cGRhdGUuaWQgfSk7XG4gICAgICBpZiAoIWlkKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IGZpZWxkczogUmVjb3JkPHN0cmluZywgKGV4aXN0aW5nOiB1bmtub3duKSA9PiB1bmtub3duPiA9IHt9O1xuICAgICAgaWYgKHVwZGF0ZS5yYXRpbmcxMDAgIT09IHVuZGVmaW5lZCkgZmllbGRzLnJhdGluZzEwMCA9ICgpID0+IHVwZGF0ZS5yYXRpbmcxMDA7XG4gICAgICBpZiAodXBkYXRlLmVsbyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGNvbnN0IHZhbHVlID0gdXBkYXRlLmVsbztcbiAgICAgICAgZmllbGRzLmN1c3RvbV9maWVsZHMgPSAoZXhpc3RpbmcpID0+IHdpdGhFbG9GaWVsZHMoZXhpc3RpbmcgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCBudWxsLCB2YWx1ZSk7XG4gICAgICB9XG4gICAgICAvLyBBcG9sbG8gb25seSBjYWxscyBtb2RpZmllcnMgZm9yIGZpZWxkcyBpdCBoYXMgY2FjaGVkLCBzbyBtaXNzaW5nIG9uZXMgYXJlIHNraXBwZWRcbiAgICAgIGNhY2hlLm1vZGlmeSh7IGlkLCBmaWVsZHMgfSk7XG4gICAgfVxuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS53YXJuKFwiW1N0YXNoIEJhdHRsZV0gQ291bGQgbm90IHVwZGF0ZSBTdGFzaCdzIHBhZ2UgY2FjaGU6XCIsIGUpO1xuICB9XG4gIGlmIChyYXRpbmdzQ2hhbmdlZCkge1xuICAgIGxpc3RzU3RhbGUgPSB0cnVlO1xuICAgIGlmICghaG9sZExpc3RSZWZyZXNoKSBkcm9wU3Rhc2hMaXN0cyhjYWNoZSk7XG4gIH1cbn1cblxuLy8gRXh0cmFjdCBzY2VuZSBJRCBmcm9tIGluZGl2aWR1YWwgc2NlbmUgcGFnZXMgbGlrZSAvc2NlbmVzLzEyM1xuZXhwb3J0IGZ1bmN0aW9uIGdldFNjZW5lSWRGcm9tVXJsKCk6IHN0cmluZyB8IG51bGwge1xuICBjb25zdCBtYXRjaCA9IHdpbmRvdy5sb2NhdGlvbi5wYXRobmFtZS5tYXRjaCgvXlxcL3NjZW5lc1xcLyhcXGQrKSQvKTtcbiAgcmV0dXJuIG1hdGNoID8gbWF0Y2hbMV0gOiBudWxsO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmV0Y2hTY2VuZUJ5SWQoc2NlbmVJZDogc3RyaW5nKTogUHJvbWlzZTxTY2VuZSB8IG51bGw+IHtcbiAgY29uc3QgcXVlcnkgPSBgXG4gICAgICBxdWVyeSBGaW5kU2NlbmUoJGlkOiBJRCEpIHtcbiAgICAgICAgZmluZFNjZW5lKGlkOiAkaWQpIHtcbiAgICAgICAgICAke1NDRU5FX0ZSQUdNRU5UfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgYDtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZ3JhcGhxbFF1ZXJ5PEZpbmRTY2VuZVJlc3VsdD4ocXVlcnksIHsgaWQ6IHNjZW5lSWQgfSk7XG4gIHJldHVybiByZXN1bHQuZmluZFNjZW5lO1xufVxuIiwgIi8vIENsZWFuIG1vZGU6IG9wZW4gU3Rhc2gncyBvd24gRGVsZXRlU2NlbmVzRGlhbG9nLCBzbyBkZWxldGluZyBmcm9tIGEgYmF0dGxlIGJlaGF2ZXMgZXhhY3RseSBsaWtlXHJcbi8vIGRlbGV0aW5nIGluIFN0YXNoIChzYW1lIG9wdGlvbnMgYW5kIGRlZmF1bHRzLCBmaWxlIGxpc3QsIGRlbGV0ZSBjYWxsIGFuZCB0b2FzdCkuXHJcbi8vXHJcbi8vIFRoZSBkaWFsb2cgbmVlZHMgU3Rhc2gncyBSZWFjdCBjb250ZXh0IChpbnRsLCBjb25maWd1cmF0aW9uLCBBcG9sbG8sIHRvYXN0cyksIHNvIGl0IGNhbid0IGJlXHJcbi8vIHJlbmRlcmVkIHN0YW5kYWxvbmUuIEluc3RlYWQgYSBzbWFsbCBicmlkZ2UgY29tcG9uZW50IGlzIHBhdGNoZWQgaW50byBTdGFzaCdzIG5hdmJhciAoYWx3YXlzXHJcbi8vIG1vdW50ZWQpIGFuZCBvcGVucyB0aGUgZGlhbG9nIHdoZW4gQmF0dGxlIGFza3MgZm9yIGl0LiByZWFjdC1ib290c3RyYXAgcG9ydGFscyB0aGUgbW9kYWwgdG9cclxuLy8gPGJvZHk+OyBDU1MgbGlmdHMgaXQgYWJvdmUgdGhlIGJhdHRsZSBtb2RhbCB3aGlsZSBCYXR0bGUgaXMgb3Blbi5cclxuXHJcbmltcG9ydCB7IGdyYXBocWxRdWVyeSB9IGZyb20gXCIuLi9ncmFwaHFsXCI7XHJcbmltcG9ydCB0eXBlIHsgUmVhY3ROb2RlIH0gZnJvbSBcIi4uL3BsdWdpbkFwaVwiO1xyXG5pbXBvcnQgdHlwZSB7IFNjZW5lIH0gZnJvbSBcIi4uL3R5cGVzXCI7XHJcblxyXG4vKiogU2NlbmUgZmllbGRzIERlbGV0ZVNjZW5lc0RpYWxvZyByZWFkcyAoZmlsZSBsaXN0LCBmdW5zY3JpcHQsIG11dGF0aW9uIGlkcykuICovXHJcbmludGVyZmFjZSBEZWxldGFibGVTY2VuZSB7XHJcbiAgaWQ6IHN0cmluZztcclxuICB0aXRsZTogc3RyaW5nIHwgbnVsbDtcclxuICBpbnRlcmFjdGl2ZTogYm9vbGVhbjtcclxuICBmaWxlczogeyBwYXRoOiBzdHJpbmcgfVtdO1xyXG59XHJcblxyXG5jb25zdCBPUEVOX0VWRU5UID0gXCJzdGFzaC1iYXR0bGU6b3Blbi1kZWxldGUtZGlhbG9nXCI7XHJcbmNvbnN0IENMT1NFX0VWRU5UID0gXCJzdGFzaC1iYXR0bGU6Y2xvc2UtZGVsZXRlLWRpYWxvZ1wiO1xyXG5cclxubGV0IGJyaWRnZVJlZ2lzdGVyZWQgPSBmYWxzZTtcclxubGV0IHBlbmRpbmdSZXN1bHQ6ICgoZGVsZXRlZDogYm9vbGVhbikgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcclxuLyoqIFN0YXNoJ3MgRGVsZXRlU2NlbmVzRGlhbG9nIGNvbXBvbmVudCwgb25jZSBpdHMgY2h1bmsgaGFzIGxvYWRlZC4gKi9cclxubGV0IERlbGV0ZVNjZW5lc0RpYWxvZzogdW5rbm93biA9IG51bGw7XHJcbmxldCBkaWFsb2dMb2FkZWQ6IFByb21pc2U8dm9pZD4gPSBQcm9taXNlLnJlc29sdmUoKTtcclxuXHJcbmZ1bmN0aW9uIHNldHRsZShkZWxldGVkOiBib29sZWFuKTogdm9pZCB7XHJcbiAgY29uc3QgcmVzb2x2ZSA9IHBlbmRpbmdSZXN1bHQ7XHJcbiAgcGVuZGluZ1Jlc3VsdCA9IG51bGw7XHJcbiAgcmVzb2x2ZT8uKGRlbGV0ZWQpO1xyXG59XHJcblxyXG4vKiogVHJ1ZSB3aGVuIHRoaXMgU3Rhc2ggZXhwb3NlcyBpdHMgZGVsZXRlIGRpYWxvZyB0byBwbHVnaW5zIChDbGVhbiBtb2RlIGRlcGVuZHMgb24gaXQpLiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gaXNTdGFzaERlbGV0ZURpYWxvZ0F2YWlsYWJsZSgpOiBib29sZWFuIHtcclxuICByZXR1cm4gYnJpZGdlUmVnaXN0ZXJlZDtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGlzRGVsZXRlRGlhbG9nT3BlbigpOiBib29sZWFuIHtcclxuICByZXR1cm4gcGVuZGluZ1Jlc3VsdCAhPT0gbnVsbDtcclxufVxyXG5cclxuLyoqIENsb3NlIHRoZSBkaWFsb2cgd2l0aG91dCBkZWxldGluZyAoZS5nLiB3aGVuIHRoZSBiYXR0bGUgbW9kYWwgY2xvc2VzKS4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGNhbmNlbERlbGV0ZURpYWxvZygpOiB2b2lkIHtcclxuICBpZiAoIXBlbmRpbmdSZXN1bHQpIHJldHVybjtcclxuICB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgQ3VzdG9tRXZlbnQoQ0xPU0VfRVZFTlQpKTtcclxuICBzZXR0bGUoZmFsc2UpO1xyXG59XHJcblxyXG4vKiogUGF0Y2ggdGhlIGJyaWRnZSBpbnRvIFN0YXNoJ3MgbmF2YmFyLiBDYWxsIG9uY2UgYXQgc3RhcnR1cCwgYmVmb3JlIHRoZSBuYXZiYXIgcmVuZGVycy4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdGVyRGVsZXRlRGlhbG9nQnJpZGdlKCk6IHZvaWQge1xyXG4gIGNvbnN0IGFwaSA9IHdpbmRvdy5QbHVnaW5BcGk7XHJcbiAgaWYgKGJyaWRnZVJlZ2lzdGVyZWQgfHwgIWFwaT8ubG9hZGFibGVDb21wb25lbnRzPy5EZWxldGVTY2VuZXNEaWFsb2cpIHtcclxuICAgIGlmICghYXBpPy5sb2FkYWJsZUNvbXBvbmVudHM/LkRlbGV0ZVNjZW5lc0RpYWxvZykge1xyXG4gICAgICBjb25zb2xlLndhcm4oXCJbU3Rhc2ggQmF0dGxlXSBTdGFzaCdzIGRlbGV0ZSBkaWFsb2cgaXNuJ3QgYXZhaWxhYmxlIHRvIHBsdWdpbnM7IENsZWFuIG1vZGUgaXMgZGlzYWJsZWRcIik7XHJcbiAgICB9XHJcbiAgICByZXR1cm47XHJcbiAgfVxyXG4gIGJyaWRnZVJlZ2lzdGVyZWQgPSB0cnVlO1xyXG4gIGNvbnN0IHsgUmVhY3QgfSA9IGFwaTtcclxuXHJcbiAgLy8gTG9hZCB0aGUgZGlhbG9nJ3MgY2h1bmsgdXAgZnJvbnQgc28gaXQgb3BlbnMgaW5zdGFudGx5XHJcbiAgZGlhbG9nTG9hZGVkID0gYXBpLmxvYWRhYmxlQ29tcG9uZW50c1xyXG4gICAgLkRlbGV0ZVNjZW5lc0RpYWxvZygpXHJcbiAgICAudGhlbigobW9kKSA9PiB7XHJcbiAgICAgIERlbGV0ZVNjZW5lc0RpYWxvZyA9IG1vZC5EZWxldGVTY2VuZXNEaWFsb2cgPz8gbW9kLmRlZmF1bHQgPz8gbnVsbDtcclxuICAgIH0pXHJcbiAgICAuY2F0Y2goKGUpID0+IGNvbnNvbGUuZXJyb3IoXCJbU3Rhc2ggQmF0dGxlXSBGYWlsZWQgdG8gbG9hZCBTdGFzaCdzIGRlbGV0ZSBkaWFsb2c6XCIsIGUpKTtcclxuXHJcbiAgZnVuY3Rpb24gRGVsZXRlQnJpZGdlKCk6IFJlYWN0Tm9kZSB7XHJcbiAgICBjb25zdCBbc2NlbmUsIHNldFNjZW5lXSA9IFJlYWN0LnVzZVN0YXRlPERlbGV0YWJsZVNjZW5lIHwgbnVsbD4obnVsbCk7XHJcblxyXG4gICAgUmVhY3QudXNlRWZmZWN0KCgpID0+IHtcclxuICAgICAgY29uc3Qgb3BlbiA9IChlOiBFdmVudCk6IHZvaWQgPT4ge1xyXG4gICAgICAgIC8vIFRoZSBuYXZiYXIgY2FuIHJlbmRlciBtb3JlIHRoYW4gb25jZTsgdGhlIGZpcnN0IGJyaWRnZSB0byBoZWFyIHRoZSBldmVudCBoYW5kbGVzIGl0LlxyXG4gICAgICAgIC8vIHByZXZlbnREZWZhdWx0IHRlbGxzIGNvbmZpcm1EZWxldGVTY2VuZSB0aGUgcmVxdWVzdCB3YXMgcGlja2VkIHVwLlxyXG4gICAgICAgIGUuc3RvcEltbWVkaWF0ZVByb3BhZ2F0aW9uKCk7XHJcbiAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xyXG4gICAgICAgIHNldFNjZW5lKChlIGFzIEN1c3RvbUV2ZW50PERlbGV0YWJsZVNjZW5lPikuZGV0YWlsKTtcclxuICAgICAgfTtcclxuICAgICAgY29uc3QgY2xvc2UgPSAoKTogdm9pZCA9PiBzZXRTY2VuZShudWxsKTtcclxuICAgICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoT1BFTl9FVkVOVCwgb3Blbik7XHJcbiAgICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKENMT1NFX0VWRU5ULCBjbG9zZSk7XHJcbiAgICAgIHJldHVybiAoKSA9PiB7XHJcbiAgICAgICAgd2luZG93LnJlbW92ZUV2ZW50TGlzdGVuZXIoT1BFTl9FVkVOVCwgb3Blbik7XHJcbiAgICAgICAgd2luZG93LnJlbW92ZUV2ZW50TGlzdGVuZXIoQ0xPU0VfRVZFTlQsIGNsb3NlKTtcclxuICAgICAgfTtcclxuICAgIH0sIFtdKTtcclxuXHJcbiAgICBpZiAoIXNjZW5lIHx8ICFEZWxldGVTY2VuZXNEaWFsb2cpIHJldHVybiBudWxsO1xyXG4gICAgcmV0dXJuIFJlYWN0LmNyZWF0ZUVsZW1lbnQoRGVsZXRlU2NlbmVzRGlhbG9nLCB7XHJcbiAgICAgIHNlbGVjdGVkOiBbc2NlbmVdLFxyXG4gICAgICBvbkNsb3NlOiAoZGVsZXRlZDogYm9vbGVhbikgPT4ge1xyXG4gICAgICAgIHNldFNjZW5lKG51bGwpO1xyXG4gICAgICAgIHNldHRsZShkZWxldGVkKTtcclxuICAgICAgfSxcclxuICAgIH0pO1xyXG4gIH1cclxuXHJcbiAgLy8gU3Rhc2ggYXBwZW5kcyB0aGUgcmVuZGVyZWQgcmVzdWx0IGFmdGVyIHRoZSBjYWxsJ3MgYXJncywgYW5kIGFub3RoZXIgcGx1Z2luJ3MgYGJlZm9yZWAgcGF0Y2hcclxuICAvLyBjYW4gY2hhbmdlIGhvdyBtYW55IGFyZ3MgdGhlcmUgYXJlLCBzbyB0aGUgcmVzdWx0IGlzIGFsd2F5cyB0aGUgbGFzdCBvbmUsIG5vdCBhIGZpeGVkIHNsb3QuXHJcbiAgYXBpLnBhdGNoLmFmdGVyKFwiTWFpbk5hdkJhci5VdGlsaXR5SXRlbXNcIiwgKC4uLmFyZ3M6IHVua25vd25bXSkgPT5cclxuICAgIFJlYWN0LmNyZWF0ZUVsZW1lbnQoXHJcbiAgICAgIFJlYWN0LkZyYWdtZW50LFxyXG4gICAgICBudWxsLFxyXG4gICAgICBhcmdzW2FyZ3MubGVuZ3RoIC0gMV0gYXMgUmVhY3ROb2RlLFxyXG4gICAgICBSZWFjdC5jcmVhdGVFbGVtZW50KERlbGV0ZUJyaWRnZSksXHJcbiAgICApLFxyXG4gICk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBPcGVuIFN0YXNoJ3MgZGVsZXRlIGRpYWxvZyBmb3IgYHNjZW5lYC4gUmVzb2x2ZXMgdHJ1ZSBvbmNlIFN0YXNoIGhhcyBkZWxldGVkIGl0LCBmYWxzZSBpZiB0aGVcclxuICogdXNlciBjYW5jZWxsZWQgKG9yIHRoZSBkZWxldGUgZmFpbGVkIOKAlCBTdGFzaCBzaG93cyBpdHMgb3duIGVycm9yIHRvYXN0KS5cclxuICovXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjb25maXJtRGVsZXRlU2NlbmUoc2NlbmU6IFNjZW5lKTogUHJvbWlzZTxib29sZWFuPiB7XHJcbiAgaWYgKCFicmlkZ2VSZWdpc3RlcmVkKSByZXR1cm4gZmFsc2U7XHJcbiAgY2FuY2VsRGVsZXRlRGlhbG9nKCk7XHJcbiAgYXdhaXQgZGlhbG9nTG9hZGVkO1xyXG4gIGlmICghRGVsZXRlU2NlbmVzRGlhbG9nKSByZXR1cm4gZmFsc2U7XHJcblxyXG4gIGNvbnN0IHsgZmluZFNjZW5lIH0gPSBhd2FpdCBncmFwaHFsUXVlcnk8eyBmaW5kU2NlbmU6IERlbGV0YWJsZVNjZW5lIHwgbnVsbCB9PihcclxuICAgIGBxdWVyeSBCYXR0bGVEZWxldGFibGVTY2VuZSgkaWQ6IElEISkgeyBmaW5kU2NlbmUoaWQ6ICRpZCkgeyBpZCB0aXRsZSBpbnRlcmFjdGl2ZSBmaWxlcyB7IHBhdGggfSB9IH1gLFxyXG4gICAgeyBpZDogc2NlbmUuaWQgfSxcclxuICApO1xyXG4gIGlmICghZmluZFNjZW5lKSByZXR1cm4gZmFsc2U7XHJcblxyXG4gIGNvbnN0IHJlc3VsdCA9IG5ldyBQcm9taXNlPGJvb2xlYW4+KChyZXNvbHZlKSA9PiB7XHJcbiAgICBwZW5kaW5nUmVzdWx0ID0gcmVzb2x2ZTtcclxuICB9KTtcclxuXHJcbiAgLy8gU3Rhc2ggcmVuZGVycyB0aGUgbmF2YmFyIGFmdGVyIHBsdWdpbnMgbG9hZCwgc28gdGhlIGJyaWRnZSBpcyBtb3VudGVkIHdlbGwgYmVmb3JlIGFueW9uZSBjYW5cclxuICAvLyBjbGljayBhIGRlbGV0ZSBidXR0b247IGlmIGl0IHNvbWVob3cgaXNuJ3QsIHNheSBzbyByYXRoZXIgdGhhbiBmYWtpbmcgYSBuYXZpZ2F0aW9uXHJcbiAgaWYgKCFyZXF1ZXN0RGlhbG9nKGZpbmRTY2VuZSkpIHtcclxuICAgIGNvbnNvbGUud2FybihcIltTdGFzaCBCYXR0bGVdIFN0YXNoJ3MgZGVsZXRlIGRpYWxvZyBicmlkZ2UgaXNuJ3QgbW91bnRlZFwiKTtcclxuICAgIHNldHRsZShmYWxzZSk7XHJcbiAgICB3aW5kb3cuYWxlcnQoXCJDb3VsZG4ndCBvcGVuIFN0YXNoJ3MgZGVsZXRlIGRpYWxvZy4gUmVsb2FkIHRoZSBwYWdlIGFuZCB0cnkgYWdhaW4uXCIpO1xyXG4gIH1cclxuICByZXR1cm4gcmVzdWx0O1xyXG59XHJcblxyXG4vKiogQXNrIHRoZSBicmlkZ2UgdG8gb3BlbiB0aGUgZGlhbG9nOyBmYWxzZSBpZiBubyBicmlkZ2UgaXMgbW91bnRlZCB0byBwaWNrIGl0IHVwLiAqL1xyXG5mdW5jdGlvbiByZXF1ZXN0RGlhbG9nKHNjZW5lOiBEZWxldGFibGVTY2VuZSk6IGJvb2xlYW4ge1xyXG4gIGNvbnN0IHJlcXVlc3QgPSBuZXcgQ3VzdG9tRXZlbnQoT1BFTl9FVkVOVCwgeyBkZXRhaWw6IHNjZW5lLCBjYW5jZWxhYmxlOiB0cnVlIH0pO1xyXG4gIHJldHVybiAhd2luZG93LmRpc3BhdGNoRXZlbnQocmVxdWVzdCk7XHJcbn1cclxuIiwgIi8vIFVSTCBmaWx0ZXIgcGFyc2luZyBmb3IgU3Rhc2ggbGlzdCDihpIgR3JhcGhRTCBzY2VuZSBxdWVyaWVzLlxuXG5pbXBvcnQgdHlwZSB7IEZpbmRGaWx0ZXJUeXBlLCBTY2VuZUZpbHRlclR5cGUgfSBmcm9tIFwiLi90eXBlc1wiO1xuXG4vKipcbiAqIFRoZSBTY2VuZXMgcGFnZSdzIGZpbHRlciBxdWVyeSAoXCI/Yz0uLi4mcT0uLi5cIiksIG9yIFwiXCIgYW55d2hlcmUgZWxzZTogU3Rhc2ggQmF0dGxlIG9wZW5zIGZyb21cbiAqIGV2ZXJ5IHBhZ2UsIGFuZCBvdGhlciBwYWdlcycgcXVlcmllcyBmaWx0ZXIgdGhlaXIgb3duIGxpc3RzIChhIHBlcmZvcm1lciBzZWFyY2gsIHNheSkuIFNjZW5lXG4gKiBwYWdlcyBrZWVwIHRoZSBsaXN0J3MgcXVlcnksIHNvIHRoZXkgY291bnQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzY2VuZXNMaXN0UXVlcnkoKTogc3RyaW5nIHtcbiAgY29uc3QgcGF0aCA9IHdpbmRvdy5sb2NhdGlvbi5wYXRobmFtZTtcbiAgcmV0dXJuIHBhdGggPT09IFwiL3NjZW5lc1wiIHx8IHBhdGguc3RhcnRzV2l0aChcIi9zY2VuZXMvXCIpID8gd2luZG93LmxvY2F0aW9uLnNlYXJjaCA6IFwiXCI7XG59XG5cbi8vIEdldCB0aGUgU2NlbmVzIHBhZ2UncyBVUkwgc2VhcmNoIHBhcmFtcyAoZW1wdHkgb24gb3RoZXIgcGFnZXMpXG5leHBvcnQgZnVuY3Rpb24gZ2V0U2VhcmNoUGFyYW1zKCk6IFVSTFNlYXJjaFBhcmFtcyB7XG4gIHJldHVybiBuZXcgVVJMU2VhcmNoUGFyYW1zKHNjZW5lc0xpc3RRdWVyeSgpKTtcbn1cblxuLy8gQnVpbGQgRmluZEZpbHRlclR5cGUgZnJvbSBjdXJyZW50IFVSTCBzZWFyY2ggcGFyYW1zIChvciBhbiBleHBsaWNpdCBwYXJhbXMgb2JqZWN0KS5cbmV4cG9ydCBmdW5jdGlvbiBnZXRGaW5kRmlsdGVyKFxuICBvdmVycmlkZXM6IFBhcnRpYWw8RmluZEZpbHRlclR5cGU+ID0ge30sXG4gIHNlYXJjaFBhcmFtczogVVJMU2VhcmNoUGFyYW1zID0gZ2V0U2VhcmNoUGFyYW1zKCksXG4pOiBGaW5kRmlsdGVyVHlwZSB7XG4gIGNvbnN0IGZpbHRlcjogRmluZEZpbHRlclR5cGUgPSB7XG4gICAgcGVyX3BhZ2U6IG92ZXJyaWRlcy5wZXJfcGFnZSA/PyAtMSxcbiAgICBzb3J0OiBvdmVycmlkZXMuc29ydCA/PyAoc2VhcmNoUGFyYW1zLmdldChcInNvcnRieVwiKSB8fCBcInJhdGluZ1wiKSxcbiAgICBkaXJlY3Rpb246IG92ZXJyaWRlcy5kaXJlY3Rpb24gPz8gKHNlYXJjaFBhcmFtcy5nZXQoXCJzb3J0ZGlyXCIpPy50b1VwcGVyQ2FzZSgpIHx8IFwiREVTQ1wiKSxcbiAgICAuLi5vdmVycmlkZXMsXG4gIH07XG5cbiAgLy8gSW5jbHVkZSBzZWFyY2ggcXVlcnkgaWYgcHJlc2VudFxuICBjb25zdCBxdWVyeSA9IHNlYXJjaFBhcmFtcy5nZXQoXCJxXCIpO1xuICBpZiAocXVlcnkpIHtcbiAgICBmaWx0ZXIucSA9IHF1ZXJ5O1xuICB9XG5cbiAgcmV0dXJuIGZpbHRlcjtcbn1cblxuLy8gVHJhbnNsYXRlIEpTT04gc3RyaW5nIGJldHdlZW4gVVJMIGZvcm1hdCAocGFyZW50aGVzZXMpIGFuZCBzdGFuZGFyZCBKU09OIChicmFjZXMpXG4vLyBQb3J0ZWQgZnJvbSBTdGFzaCdzIExpc3RGaWx0ZXJNb2RlbC50cmFuc2xhdGVKU09OXG4vLyBUaGlzIHNhZmVseSBoYW5kbGVzIHBhcmVudGhlc2VzIGluc2lkZSBxdW90ZWQgc3RyaW5nc1xuZXhwb3J0IGZ1bmN0aW9uIHRyYW5zbGF0ZUpTT04oanNvblN0cmluZzogc3RyaW5nLCBkZWNvZGluZzogYm9vbGVhbik6IHN0cmluZyB7XG4gIGxldCBpblN0cmluZyA9IGZhbHNlO1xuICBsZXQgZXNjYXBlID0gZmFsc2U7XG4gIHJldHVybiBbLi4uanNvblN0cmluZ11cbiAgICAubWFwKChjKSA9PiB7XG4gICAgICBpZiAoZXNjYXBlKSB7XG4gICAgICAgIGVzY2FwZSA9IGZhbHNlO1xuICAgICAgICByZXR1cm4gYztcbiAgICAgIH1cbiAgICAgIHN3aXRjaCAoYykge1xuICAgICAgICBjYXNlIFwiXFxcXFwiOlxuICAgICAgICAgIGlmIChpblN0cmluZykgZXNjYXBlID0gdHJ1ZTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSAnXCInOlxuICAgICAgICAgIGluU3RyaW5nID0gIWluU3RyaW5nO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlIFwiKFwiOlxuICAgICAgICAgIGlmIChkZWNvZGluZyAmJiAhaW5TdHJpbmcpIHJldHVybiBcIntcIjtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSBcIilcIjpcbiAgICAgICAgICBpZiAoZGVjb2RpbmcgJiYgIWluU3RyaW5nKSByZXR1cm4gXCJ9XCI7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICByZXR1cm4gYztcbiAgICB9KVxuICAgIC5qb2luKFwiXCIpO1xufVxuXG4vLyBDcml0ZXJpb24gY2F0ZWdvcnkgbWFwcGluZ3MgZm9yIFVSTCAtPiBHcmFwaFFMIHRyYW5zZm9ybWF0aW9uXG4vLyBFYWNoIGNhdGVnb3J5IHJlcXVpcmVzIGRpZmZlcmVudCB0cmFuc2Zvcm1hdGlvbiBsb2dpY1xuY29uc3QgQ1JJVEVSSU9OX0NBVEVHT1JJRVMgPSB7XG4gIC8vIEJvb2xlYW46IG5vIG1vZGlmaWVyLCB2YWx1ZSBpcyBcInRydWVcIi9cImZhbHNlXCIgc3RyaW5nIC0+IGNvbnZlcnQgdG8gYm9vbGVhblxuICBib29sZWFuOiBuZXcgU2V0KFtcIm9yZ2FuaXplZFwiLCBcImludGVyYWN0aXZlXCIsIFwicGVyZm9ybWVyX2Zhdm9yaXRlXCJdKSxcbiAgLy8gU3RyaW5nRW51bTogVVJMIGhhcyBtb2RpZmllciBidXQgR3JhcGhRTCBqdXN0IGV4cGVjdHMgdGhlIHN0cmluZyB2YWx1ZSBkaXJlY3RseVxuICBzdHJpbmdFbnVtOiBuZXcgU2V0KFtcImlzX21pc3NpbmdcIiwgXCJoYXNfbWFya2Vyc1wiXSksXG4gIC8vIE11bHRpOiB2YWx1ZSBpcyBhcnJheSBvZiB7aWQsIGxhYmVsfSAtPiBleHRyYWN0IElEcyBvbmx5XG4gIG11bHRpOiBuZXcgU2V0KFtcInBlcmZvcm1lcnNcIiwgXCJncm91cHNcIiwgXCJtb3ZpZXNcIiwgXCJnYWxsZXJpZXNcIl0pLFxuICAvLyBIaWVyYXJjaGljYWxNdWx0aTogdmFsdWUgaGFzIHtpdGVtcywgZXhjbHVkZWQsIGRlcHRofSAtPiByZW5hbWUgdG8ge3ZhbHVlLCBleGNsdWRlcywgZGVwdGh9IGFuZCBleHRyYWN0IElEc1xuICBoaWVyYXJjaGljYWxNdWx0aTogbmV3IFNldChbXCJ0YWdzXCIsIFwic3R1ZGlvc1wiLCBcInBlcmZvcm1lcl90YWdzXCJdKSxcbn07XG5cbi8vIFJlc29sdXRpb24gc3RyaW5nIHRvIEdyYXBoUUwgZW51bSBtYXBwaW5nXG4vLyBVUkwgdXNlcyBodW1hbi1yZWFkYWJsZSBzdHJpbmdzLCBHcmFwaFFMIGV4cGVjdHMgUmVzb2x1dGlvbkVudW0gdmFsdWVzXG5jb25zdCBSRVNPTFVUSU9OX01BUDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgXCIxNDRwXCI6IFwiVkVSWV9MT1dcIixcbiAgXCIyNDBwXCI6IFwiTE9XXCIsXG4gIFwiMzYwcFwiOiBcIlIzNjBQXCIsXG4gIFwiNDgwcFwiOiBcIlNUQU5EQVJEXCIsXG4gIFwiNTQwcFwiOiBcIldFQl9IRFwiLFxuICBcIjcyMHBcIjogXCJTVEFOREFSRF9IRFwiLFxuICBcIjEwODBwXCI6IFwiRlVMTF9IRFwiLFxuICBcIjE0NDBwXCI6IFwiUVVBRF9IRFwiLFxuICBcIjRrXCI6IFwiRk9VUl9LXCIsXG4gIFwiNWtcIjogXCJGSVZFX0tcIixcbiAgXCI2a1wiOiBcIlNJWF9LXCIsXG4gIFwiN2tcIjogXCJTRVZFTl9LXCIsXG4gIFwiOGtcIjogXCJFSUdIVF9LXCIsXG4gIEh1Z2U6IFwiSFVHRVwiLFxufTtcblxuLy8gT3JpZW50YXRpb24gc3RyaW5nIHRvIEdyYXBoUUwgZW51bSBtYXBwaW5nXG5jb25zdCBPUklFTlRBVElPTl9NQVA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gIExhbmRzY2FwZTogXCJMQU5EU0NBUEVcIixcbiAgUG9ydHJhaXQ6IFwiUE9SVFJBSVRcIixcbiAgU3F1YXJlOiBcIlNRVUFSRVwiLFxufTtcblxuY29uc3QgaWRPZiA9ICh2OiBhbnkpOiB1bmtub3duID0+ICh0eXBlb2YgdiA9PT0gXCJvYmplY3RcIiAmJiB2ICYmIHYuaWQgPyB2LmlkIDogdik7XG5cbi8vIEJ1aWxkIFNjZW5lRmlsdGVyVHlwZSBmcm9tIFVSTCAnYycgcGFyYW1zIChkZWZhdWx0cyB0byBjdXJyZW50IHBhZ2UgVVJMKS5cbmV4cG9ydCBmdW5jdGlvbiBnZXRTY2VuZUZpbHRlcihcbiAgc2VhcmNoUGFyYW1zOiBVUkxTZWFyY2hQYXJhbXMgPSBnZXRTZWFyY2hQYXJhbXMoKSxcbik6IFNjZW5lRmlsdGVyVHlwZSB8IG51bGwge1xuICBjb25zdCBzY2VuZUZpbHRlcjogU2NlbmVGaWx0ZXJUeXBlID0ge307XG5cbiAgaWYgKCFzZWFyY2hQYXJhbXMuaGFzKFwiY1wiKSkgcmV0dXJuIG51bGw7XG5cbiAgZm9yIChjb25zdCBjU3RyIG9mIHNlYXJjaFBhcmFtcy5nZXRBbGwoXCJjXCIpKSB7XG4gICAgdHJ5IHtcbiAgICAgIC8vIERlY29kZSBVUkwgZm9ybWF0OiAoKSAtPiB7fSAoc2FmZWx5IHByZXNlcnZpbmcgc3RyaW5ncylcbiAgICAgIGNvbnN0IGRlY29kZWQgPSB0cmFuc2xhdGVKU09OKGNTdHIsIHRydWUpO1xuICAgICAgY29uc3QgY09iajogYW55ID0gSlNPTi5wYXJzZShkZWNvZGVkKTtcblxuICAgICAgY29uc3QgZmlsdGVyVHlwZTogc3RyaW5nIHwgdW5kZWZpbmVkID0gY09iai50eXBlO1xuICAgICAgaWYgKCFmaWx0ZXJUeXBlKSB7XG4gICAgICAgIGNvbnNvbGUud2FybihcIltTdGFzaCBCYXR0bGVdIEZpbHRlciBtaXNzaW5nIHR5cGU6XCIsIGNPYmopO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgLy8gUmVtb3ZlIHR5cGUgZnJvbSB0aGUgb2JqZWN0IC0gaXQgYmVjb21lcyB0aGUga2V5XG4gICAgICBjb25zdCB7IHR5cGU6IF90eXBlLCAuLi5yZXN0IH0gPSBjT2JqO1xuXG4gICAgICAvLyBDYXRlZ29yeTogQm9vbGVhbiAob3JnYW5pemVkLCBpbnRlcmFjdGl2ZSwgcGVyZm9ybWVyX2Zhdm9yaXRlKVxuICAgICAgaWYgKENSSVRFUklPTl9DQVRFR09SSUVTLmJvb2xlYW4uaGFzKGZpbHRlclR5cGUpKSB7XG4gICAgICAgIHNjZW5lRmlsdGVyW2ZpbHRlclR5cGVdID0gcmVzdC52YWx1ZSA9PT0gXCJ0cnVlXCIgfHwgcmVzdC52YWx1ZSA9PT0gdHJ1ZTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIC8vIENhdGVnb3J5OiBTdHJpbmdFbnVtIChzY2VuZUlzTWlzc2luZywgaGFzTWFya2VycylcbiAgICAgIGlmIChDUklURVJJT05fQ0FURUdPUklFUy5zdHJpbmdFbnVtLmhhcyhmaWx0ZXJUeXBlKSkge1xuICAgICAgICBzY2VuZUZpbHRlcltmaWx0ZXJUeXBlXSA9IHJlc3QudmFsdWU7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICAvLyBDYXRlZ29yeTogTXVsdGkgKHBlcmZvcm1lcnMsIGdyb3VwcywgbW92aWVzLCBnYWxsZXJpZXMpXG4gICAgICBpZiAoQ1JJVEVSSU9OX0NBVEVHT1JJRVMubXVsdGkuaGFzKGZpbHRlclR5cGUpKSB7XG4gICAgICAgIGNvbnN0IHJlc3VsdDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7IG1vZGlmaWVyOiByZXN0Lm1vZGlmaWVyIH07XG4gICAgICAgIGNvbnN0IHZhbCA9IHJlc3QudmFsdWUgfHwge307XG5cbiAgICAgICAgaWYgKHZhbC5pdGVtcyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgY29uc3QgaXRlbXM6IGFueVtdID0gdmFsLml0ZW1zIHx8IFtdO1xuICAgICAgICAgIGNvbnN0IGV4Y2x1ZGVkOiBhbnlbXSA9IHZhbC5leGNsdWRlZCB8fCBbXTtcbiAgICAgICAgICByZXN1bHQudmFsdWUgPSBpdGVtcy5tYXAoaWRPZik7XG4gICAgICAgICAgaWYgKGV4Y2x1ZGVkLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIHJlc3VsdC5leGNsdWRlcyA9IGV4Y2x1ZGVkLm1hcChpZE9mKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSBpZiAoQXJyYXkuaXNBcnJheShyZXN0LnZhbHVlKSkge1xuICAgICAgICAgIHJlc3VsdC52YWx1ZSA9IHJlc3QudmFsdWUubWFwKGlkT2YpO1xuICAgICAgICB9IGVsc2UgaWYgKHJlc3QubW9kaWZpZXIgPT09IFwiSVNfTlVMTFwiIHx8IHJlc3QubW9kaWZpZXIgPT09IFwiTk9UX05VTExcIikge1xuICAgICAgICAgIHJlc3VsdC52YWx1ZSA9IFtdO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHJlc3VsdC52YWx1ZSA9IHJlc3QudmFsdWU7XG4gICAgICAgIH1cblxuICAgICAgICBzY2VuZUZpbHRlcltmaWx0ZXJUeXBlXSA9IHJlc3VsdDtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIC8vIENhdGVnb3J5OiBIaWVyYXJjaGljYWxNdWx0aSAodGFncywgc3R1ZGlvcywgcGVyZm9ybWVyX3RhZ3MpXG4gICAgICBpZiAoQ1JJVEVSSU9OX0NBVEVHT1JJRVMuaGllcmFyY2hpY2FsTXVsdGkuaGFzKGZpbHRlclR5cGUpKSB7XG4gICAgICAgIGNvbnN0IHZhbCA9IHJlc3QudmFsdWUgfHwge307XG4gICAgICAgIGNvbnN0IGl0ZW1zOiBhbnlbXSA9IHZhbC5pdGVtcyB8fCBbXTtcbiAgICAgICAgY29uc3QgZXhjbHVkZWQ6IGFueVtdID0gdmFsLmV4Y2x1ZGVkIHx8IFtdO1xuICAgICAgICBzY2VuZUZpbHRlcltmaWx0ZXJUeXBlXSA9IHtcbiAgICAgICAgICBtb2RpZmllcjogcmVzdC5tb2RpZmllcixcbiAgICAgICAgICB2YWx1ZTogaXRlbXMubWFwKGlkT2YpLFxuICAgICAgICAgIGV4Y2x1ZGVzOiBleGNsdWRlZC5tYXAoaWRPZiksXG4gICAgICAgICAgZGVwdGg6IHZhbC5kZXB0aCA/PyAwLFxuICAgICAgICB9O1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgLy8gQ2F0ZWdvcnk6IFJlc29sdXRpb24gKG5lZWRzIHN0cmluZyAtPiBlbnVtIGNvbnZlcnNpb24pXG4gICAgICBpZiAoZmlsdGVyVHlwZSA9PT0gXCJyZXNvbHV0aW9uXCIpIHtcbiAgICAgICAgc2NlbmVGaWx0ZXJbZmlsdGVyVHlwZV0gPSB7XG4gICAgICAgICAgbW9kaWZpZXI6IHJlc3QubW9kaWZpZXIsXG4gICAgICAgICAgdmFsdWU6IFJFU09MVVRJT05fTUFQW3Jlc3QudmFsdWVdIHx8IHJlc3QudmFsdWUsXG4gICAgICAgIH07XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICAvLyBDYXRlZ29yeTogT3JpZW50YXRpb24gKG11bHRpLXNlbGVjdCBlbnVtLCBubyBtb2RpZmllcilcbiAgICAgIGlmIChmaWx0ZXJUeXBlID09PSBcIm9yaWVudGF0aW9uXCIpIHtcbiAgICAgICAgY29uc3QgdmFsdWVzOiBhbnlbXSA9IEFycmF5LmlzQXJyYXkocmVzdC52YWx1ZSkgPyByZXN0LnZhbHVlIDogW3Jlc3QudmFsdWVdO1xuICAgICAgICBzY2VuZUZpbHRlcltmaWx0ZXJUeXBlXSA9IHtcbiAgICAgICAgICB2YWx1ZTogdmFsdWVzLm1hcCgodikgPT4gT1JJRU5UQVRJT05fTUFQW3ZdIHx8IHYpLmZpbHRlcihCb29sZWFuKSxcbiAgICAgICAgfTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIC8vIENhdGVnb3J5OiBEdXBsaWNhdGVkIChwaGFzaCBkdXBsaWNhdGUgZmlsdGVyIC0gZGlmZmVyZW50IHN0cnVjdHVyZSlcbiAgICAgIGlmIChmaWx0ZXJUeXBlID09PSBcImR1cGxpY2F0ZWRcIikge1xuICAgICAgICBzY2VuZUZpbHRlcltmaWx0ZXJUeXBlXSA9IHtcbiAgICAgICAgICBkdXBsaWNhdGVkOiByZXN0LnZhbHVlID09PSBcInRydWVcIiB8fCByZXN0LnZhbHVlID09PSB0cnVlLFxuICAgICAgICB9O1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgLy8gQ2F0ZWdvcnk6IFN0YW5kYXJkIChudW1iZXIsIHN0cmluZywgZGF0ZSwgdGltZXN0YW1wLCBkdXJhdGlvbiwgc3BlY2lhbClcbiAgICAgIGlmIChcbiAgICAgICAgcmVzdC52YWx1ZSAmJlxuICAgICAgICB0eXBlb2YgcmVzdC52YWx1ZSA9PT0gXCJvYmplY3RcIiAmJlxuICAgICAgICAhQXJyYXkuaXNBcnJheShyZXN0LnZhbHVlKSAmJlxuICAgICAgICBcInZhbHVlXCIgaW4gcmVzdC52YWx1ZVxuICAgICAgKSB7XG4gICAgICAgIC8vIEZsYXR0ZW46IHsgbW9kaWZpZXIsIHZhbHVlOiB7IHZhbHVlOiBYLCB2YWx1ZTI6IFkgfSB9IC0+IHsgbW9kaWZpZXIsIHZhbHVlOiBYLCB2YWx1ZTI6IFkgfVxuICAgICAgICBzY2VuZUZpbHRlcltmaWx0ZXJUeXBlXSA9IHtcbiAgICAgICAgICBtb2RpZmllcjogcmVzdC5tb2RpZmllcixcbiAgICAgICAgICB2YWx1ZTogcmVzdC52YWx1ZS52YWx1ZSxcbiAgICAgICAgICAuLi4ocmVzdC52YWx1ZS52YWx1ZTIgIT09IHVuZGVmaW5lZCAmJiB7IHZhbHVlMjogcmVzdC52YWx1ZS52YWx1ZTIgfSksXG4gICAgICAgIH07XG4gICAgICB9IGVsc2UgaWYgKHJlc3QubW9kaWZpZXIgPT09IFwiSVNfTlVMTFwiIHx8IHJlc3QubW9kaWZpZXIgPT09IFwiTk9UX05VTExcIikge1xuICAgICAgICAvLyBJU19OVUxML05PVF9OVUxMIGRvbid0IHVzZSB0aGUgdmFsdWUsIGJ1dCB0aGUgc2NoZW1hIHN0aWxsIHJlcXVpcmVzIGl0XG4gICAgICAgIHNjZW5lRmlsdGVyW2ZpbHRlclR5cGVdID0ge1xuICAgICAgICAgIG1vZGlmaWVyOiByZXN0Lm1vZGlmaWVyLFxuICAgICAgICAgIHZhbHVlOiAwLFxuICAgICAgICB9O1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gUGFzcyB0aHJvdWdoIGFzLWlzIChzdHJpbmcgY3JpdGVyaWEsIHNwZWNpYWwgY3JpdGVyaWEgbGlrZSBwaGFzaCwgc3Rhc2hfaWQsIGV0Yy4pXG4gICAgICAgIHNjZW5lRmlsdGVyW2ZpbHRlclR5cGVdID0gcmVzdDtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0gRmFpbGVkIHRvIHBhcnNlIGZpbHRlcjpcIiwgY1N0ciwgZSk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIE9iamVjdC5rZXlzKHNjZW5lRmlsdGVyKS5sZW5ndGggPiAwID8gc2NlbmVGaWx0ZXIgOiBudWxsO1xufVxuXG4vKiogUGFyc2VkIGZpbHRlciBzdGF0ZSBmb3IgdGhlIGN1cnJlbnQgU3Rhc2ggbGlzdCBVUkwuICovXG5leHBvcnQgaW50ZXJmYWNlIExpc3RGaWx0ZXJzIHtcbiAgZmlsdGVyS2V5OiBzdHJpbmc7XG4gIHNjZW5lRmlsdGVyOiBTY2VuZUZpbHRlclR5cGUgfCBudWxsO1xuICBmaWx0ZXJBY3RpdmU6IGJvb2xlYW47XG59XG5cbi8qKiBSZWFkIFVSTCBmaWx0ZXIgc3RhdGUgb25jZSAoY2FjaGUga2V5LCBHcmFwaFFMIHNjZW5lX2ZpbHRlciwgYWN0aXZlIGZsYWcpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlYWRGaWx0ZXJzKCk6IExpc3RGaWx0ZXJzIHtcbiAgY29uc3Qgc2VhcmNoUGFyYW1zID0gZ2V0U2VhcmNoUGFyYW1zKCk7XG4gIGNvbnN0IHNjZW5lRmlsdGVyID0gZ2V0U2NlbmVGaWx0ZXIoc2VhcmNoUGFyYW1zKTtcbiAgY29uc3QgcSA9IHNlYXJjaFBhcmFtcy5nZXQoXCJxXCIpIHx8IFwiXCI7XG4gIHJldHVybiB7XG4gICAgZmlsdGVyS2V5OiBKU09OLnN0cmluZ2lmeSh7IHEsIGZpbHRlcjogc2NlbmVGaWx0ZXIgfHwge30gfSksXG4gICAgc2NlbmVGaWx0ZXIsXG4gICAgZmlsdGVyQWN0aXZlOiBCb29sZWFuKHNjZW5lRmlsdGVyIHx8IHNlYXJjaFBhcmFtcy5oYXMoXCJjXCIpIHx8IHNlYXJjaFBhcmFtcy5nZXQoXCJxXCIpKSxcbiAgfTtcbn1cblxuLy8gQ2FjaGUga2V5IGZvciB0aGUgY3VycmVudCBsaXN0IFVSTCAoY3JpdGVyaWEgKyB0ZXh0IHNlYXJjaCkuXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRGaWx0ZXJLZXkoKTogc3RyaW5nIHtcbiAgcmV0dXJuIHJlYWRGaWx0ZXJzKCkuZmlsdGVyS2V5O1xufVxuXG4vKiogVHJ1ZSB3aGVuIHRoZSBjdXJyZW50IFN0YXNoIGxpc3QgVVJMIGhhcyBhY3RpdmUgZmlsdGVycyAoY3JpdGVyaWEgYW5kL29yIHRleHQgc2VhcmNoKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjaGVja0ZvckZpbHRlcnMoKTogYm9vbGVhbiB7XG4gIHJldHVybiByZWFkRmlsdGVycygpLmZpbHRlckFjdGl2ZTtcbn1cbiIsICIvLyBMaWJyYXJ5LXdpZGUgbnVtYmVycyB3b3JrZWQgb3V0IGZyb20gdGhlIHNjZW5lczogdGllcnMsIGFuZCB0aGUgU3RhdHMgdGFiJ3Mgb3ZlcnZpZXcsIEVMT1xyXG4vLyBkaXN0cmlidXRpb24sIGhpZGRlbiBnZW1zIGFuZCBob3cgc2V0dGxlZCB0aGUgcmFua2luZ3MgYXJlLiBQdXJlIGZ1bmN0aW9uczogbm8gc3RhdGUsIG5vIEkvTy5cclxuXHJcbmltcG9ydCB7IEVMT19LX1RJRVJTLCBUSUVSUyB9IGZyb20gXCIuL2NvbnN0YW50c1wiO1xyXG5pbXBvcnQgeyBiYXR0bGVzLCBlbG8sIGlzUHJvdmlzaW9uYWwsIHBlcmNlbnRpbGVSYXRpbmdzLCBzY2VuZVJlY29yZCwgc2VlZCB9IGZyb20gXCIuL3Njb3JlXCI7XHJcbmltcG9ydCB0eXBlIHsgU2NlbmUsIFNjZW5lUmVjb3JkLCBTdGFzaFJhdGluZ3NNb2RlLCBUaWVyIH0gZnJvbSBcIi4vdHlwZXNcIjtcclxuXHJcbi8qKiBSYXRlZCBzY2VuZXMgd2l0aCB0aGVpciBFTE8gKHVucmF0ZWQgb25lcyBkcm9wcGVkKS4gKi9cclxuZnVuY3Rpb24gcmF0ZWRFbG9zKHNjZW5lczogU2NlbmVbXSk6IHsgc2NlbmU6IFNjZW5lOyBlbG86IG51bWJlciB9W10ge1xyXG4gIHJldHVybiBzY2VuZXNcclxuICAgIC5tYXAoKHNjZW5lKSA9PiAoeyBzY2VuZSwgZWxvOiBlbG8oc2NlbmUpIH0pKVxyXG4gICAgLmZpbHRlcigocyk6IHMgaXMgeyBzY2VuZTogU2NlbmU7IGVsbzogbnVtYmVyIH0gPT4gcy5lbG8gIT09IG51bGwpO1xyXG59XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIE92ZXJ2aWV3IHtcclxuICByYXRlZDogbnVtYmVyO1xyXG4gIHVucmF0ZWQ6IG51bWJlcjtcclxuICBwcm92aXNpb25hbDogbnVtYmVyO1xyXG4gIC8qKiBTdW0gb2YgZXZlcnkgc2NlbmUncyBiYXR0bGVzOiBhIGJhdHRsZSBjb3VudHMgb25jZSBmb3IgZWFjaCBzY2VuZSBpbiBpdC4gKi9cclxuICBiYXR0bGVzOiBudW1iZXI7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBvdmVydmlldyhzY2VuZXM6IFNjZW5lW10pOiBPdmVydmlldyB7XHJcbiAgY29uc3QgcmF0ZWQgPSByYXRlZEVsb3Moc2NlbmVzKTtcclxuICByZXR1cm4ge1xyXG4gICAgcmF0ZWQ6IHJhdGVkLmxlbmd0aCxcclxuICAgIHVucmF0ZWQ6IHNjZW5lcy5sZW5ndGggLSByYXRlZC5sZW5ndGgsXHJcbiAgICBwcm92aXNpb25hbDogc2NlbmVzLmZpbHRlcihpc1Byb3Zpc2lvbmFsKS5sZW5ndGgsXHJcbiAgICBiYXR0bGVzOiByYXRlZC5yZWR1Y2UoKHN1bSwgcykgPT4gc3VtICsgYmF0dGxlcyhzLnNjZW5lKSwgMCksXHJcbiAgfTtcclxufVxyXG5cclxuZXhwb3J0IGludGVyZmFjZSBIaXN0b2dyYW1CdWNrZXQge1xyXG4gIC8qKiBUaGUgYnVja2V0IGNvdmVycyBmcm9tLi5mcm9tICsgc2l6ZSAoZXhjbHVzaXZlKS4gKi9cclxuICBmcm9tOiBudW1iZXI7XHJcbiAgY291bnQ6IG51bWJlcjtcclxufVxyXG5cclxuLyoqIFJhdGVkIHNjZW5lcyBjb3VudGVkIGluIGBzaXplYC1FTE8gYnVja2V0cywgbG93ZXN0IHRvIGhpZ2hlc3QsIGVtcHR5IGJ1Y2tldHMgaW4gYmV0d2VlbiBpbmNsdWRlZC4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGVsb0hpc3RvZ3JhbShzY2VuZXM6IFNjZW5lW10sIHNpemUgPSAyNSk6IEhpc3RvZ3JhbUJ1Y2tldFtdIHtcclxuICBjb25zdCByYXRlZCA9IHJhdGVkRWxvcyhzY2VuZXMpO1xyXG4gIGlmIChyYXRlZC5sZW5ndGggPT09IDApIHJldHVybiBbXTtcclxuICBjb25zdCBidWNrZXRPZiA9ICh2YWx1ZTogbnVtYmVyKTogbnVtYmVyID0+IE1hdGguZmxvb3IodmFsdWUgLyBzaXplKSAqIHNpemU7XHJcbiAgY29uc3QgY291bnRzID0gbmV3IE1hcDxudW1iZXIsIG51bWJlcj4oKTtcclxuICBmb3IgKGNvbnN0IHsgZWxvOiB2YWx1ZSB9IG9mIHJhdGVkKSBjb3VudHMuc2V0KGJ1Y2tldE9mKHZhbHVlKSwgKGNvdW50cy5nZXQoYnVja2V0T2YodmFsdWUpKSA/PyAwKSArIDEpO1xyXG4gIGNvbnN0IGxvd2VzdCA9IE1hdGgubWluKC4uLmNvdW50cy5rZXlzKCkpO1xyXG4gIGNvbnN0IGhpZ2hlc3QgPSBNYXRoLm1heCguLi5jb3VudHMua2V5cygpKTtcclxuICBjb25zdCBidWNrZXRzOiBIaXN0b2dyYW1CdWNrZXRbXSA9IFtdO1xyXG4gIGZvciAobGV0IGZyb20gPSBsb3dlc3Q7IGZyb20gPD0gaGlnaGVzdDsgZnJvbSArPSBzaXplKSBidWNrZXRzLnB1c2goeyBmcm9tLCBjb3VudDogY291bnRzLmdldChmcm9tKSA/PyAwIH0pO1xyXG4gIHJldHVybiBidWNrZXRzO1xyXG59XHJcblxyXG4vKiogVGhlIGJpZ2dlc3QgZ3JvdXAgb2Ygc2NlbmVzIHNoYXJpbmcgb25lIEVMTyAobnVsbCB3aGVuIG5vIHR3byBzY2VuZXMgc2hhcmUgb25lKS4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGxhcmdlc3RUaWUoc2NlbmVzOiBTY2VuZVtdKTogeyBlbG86IG51bWJlcjsgY291bnQ6IG51bWJlciB9IHwgbnVsbCB7XHJcbiAgY29uc3QgY291bnRzID0gbmV3IE1hcDxudW1iZXIsIG51bWJlcj4oKTtcclxuICBmb3IgKGNvbnN0IHsgZWxvOiB2YWx1ZSB9IG9mIHJhdGVkRWxvcyhzY2VuZXMpKSBjb3VudHMuc2V0KHZhbHVlLCAoY291bnRzLmdldCh2YWx1ZSkgPz8gMCkgKyAxKTtcclxuICBsZXQgYmVzdDogeyBlbG86IG51bWJlcjsgY291bnQ6IG51bWJlciB9IHwgbnVsbCA9IG51bGw7XHJcbiAgZm9yIChjb25zdCBbdmFsdWUsIGNvdW50XSBvZiBjb3VudHMpIHtcclxuICAgIGlmIChjb3VudCA+PSAyICYmICghYmVzdCB8fCBjb3VudCA+IGJlc3QuY291bnQgfHwgKGNvdW50ID09PSBiZXN0LmNvdW50ICYmIHZhbHVlID4gYmVzdC5lbG8pKSkge1xyXG4gICAgICBiZXN0ID0geyBlbG86IHZhbHVlLCBjb3VudCB9O1xyXG4gICAgfVxyXG4gIH1cclxuICByZXR1cm4gYmVzdDtcclxufVxyXG5cclxuZXhwb3J0IGludGVyZmFjZSBTY2FsZVRpY2sge1xyXG4gIGVsbzogbnVtYmVyO1xyXG4gIHJhdGluZzogbnVtYmVyO1xyXG59XHJcblxyXG5cclxuLyoqXHJcbiAqIFdoZXJlIFN0YXNoIHJhdGluZ3Mgc2l0IG9uIHRoZSBFTE8gYXhpcyB1bmRlciB0aGUgdXBkYXRlIG1vZGU6IFN0cmFpZ2h0LWxpbmUgaXMgZml4ZWQgKDEgYXRcclxuICogMTAxMCwgNTAgYXQgMTUwMCwgMTAwIGF0IDIwMDApOyBQZXJjZW50aWxlIGRlcGVuZHMgb24gdGhlIGxpYnJhcnkgKGVhY2ggbWFyayBhdCB0aGUgRUxPIG9mIHRoZVxyXG4gKiBzY2VuZSB3aG9zZSByYXRpbmcgaXMgY2xvc2VzdCB0byBpdCkuIE5vbmUgZm9yIFwib2ZmXCIuXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gcmF0aW5nU2NhbGVUaWNrcyhzY2VuZXM6IFNjZW5lW10sIG1vZGU6IFN0YXNoUmF0aW5nc01vZGUsIG1hcmtzOiByZWFkb25seSBudW1iZXJbXSA9IFsxLCAyNSwgNTAsIDc1LCAxMDBdKTogU2NhbGVUaWNrW10ge1xyXG4gIGlmIChtb2RlID09PSBcImxpbmVhclwiKSByZXR1cm4gbWFya3MubWFwKChyYXRpbmcpID0+ICh7IGVsbzogc2VlZChyYXRpbmcpLCByYXRpbmcgfSkpO1xyXG4gIGlmIChtb2RlICE9PSBcInBlcmNlbnRpbGVcIikgcmV0dXJuIFtdO1xyXG4gIGNvbnN0IHJhdGluZ3MgPSBwZXJjZW50aWxlUmF0aW5ncyhzY2VuZXMpO1xyXG4gIGNvbnN0IHJhdGVkID0gcmF0ZWRFbG9zKHNjZW5lcykuZmlsdGVyKChzKSA9PiByYXRpbmdzLmhhcyhzLnNjZW5lLmlkKSk7XHJcbiAgaWYgKHJhdGVkLmxlbmd0aCA9PT0gMCkgcmV0dXJuIFtdO1xyXG4gIGNvbnN0IHRpY2tzOiBTY2FsZVRpY2tbXSA9IFtdO1xyXG4gIGZvciAoY29uc3QgcmF0aW5nIG9mIG1hcmtzKSB7XHJcbiAgICBsZXQgbmVhcmVzdCA9IHJhdGVkWzBdO1xyXG4gICAgZm9yIChjb25zdCBzIG9mIHJhdGVkKSB7XHJcbiAgICAgIGNvbnN0IGdhcCA9IE1hdGguYWJzKChyYXRpbmdzLmdldChzLnNjZW5lLmlkKSBhcyBudW1iZXIpIC0gcmF0aW5nKTtcclxuICAgICAgY29uc3QgbmVhcmVzdEdhcCA9IE1hdGguYWJzKChyYXRpbmdzLmdldChuZWFyZXN0LnNjZW5lLmlkKSBhcyBudW1iZXIpIC0gcmF0aW5nKTtcclxuICAgICAgaWYgKGdhcCA8IG5lYXJlc3RHYXApIG5lYXJlc3QgPSBzO1xyXG4gICAgfVxyXG4gICAgaWYgKCF0aWNrcy5zb21lKCh0KSA9PiB0LmVsbyA9PT0gbmVhcmVzdC5lbG8pKSB0aWNrcy5wdXNoKHsgZWxvOiBuZWFyZXN0LmVsbywgcmF0aW5nIH0pO1xyXG4gIH1cclxuICByZXR1cm4gdGlja3M7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBtZWRpYW4odmFsdWVzOiBudW1iZXJbXSk6IG51bWJlciB7XHJcbiAgaWYgKHZhbHVlcy5sZW5ndGggPT09IDApIHJldHVybiAwO1xyXG4gIGNvbnN0IHNvcnRlZCA9IFsuLi52YWx1ZXNdLnNvcnQoKGEsIGIpID0+IGEgLSBiKTtcclxuICBjb25zdCBtaWQgPSBNYXRoLmZsb29yKHNvcnRlZC5sZW5ndGggLyAyKTtcclxuICByZXR1cm4gc29ydGVkLmxlbmd0aCAlIDIgPyBzb3J0ZWRbbWlkXSA6IChzb3J0ZWRbbWlkIC0gMV0gKyBzb3J0ZWRbbWlkXSkgLyAyO1xyXG59XHJcblxyXG4vKiogVGhlIGhpZGRlbiBnZW1zIGNoYXJ0J3MgcXVhZHJhbnQgbGluZXM6IHRoZSBtZWRpYW4gRUxPIGFuZCBtZWRpYW4gcGxheSBjb3VudCBvZiByYXRlZCBzY2VuZXMuICovXHJcbmV4cG9ydCBpbnRlcmZhY2UgR2Vtc1NwbGl0IHtcclxuICBlbG86IG51bWJlcjtcclxuICBwbGF5czogbnVtYmVyO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gZ2Vtc1NwbGl0KHNjZW5lczogU2NlbmVbXSk6IEdlbXNTcGxpdCB8IG51bGwge1xyXG4gIGNvbnN0IHJhdGVkID0gcmF0ZWRFbG9zKHNjZW5lcyk7XHJcbiAgaWYgKHJhdGVkLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XHJcbiAgcmV0dXJuIHsgZWxvOiBtZWRpYW4ocmF0ZWQubWFwKChzKSA9PiBzLmVsbykpLCBwbGF5czogbWVkaWFuKHJhdGVkLm1hcCgocykgPT4gcy5zY2VuZS5wbGF5X2NvdW50ID8/IDApKSB9O1xyXG59XHJcblxyXG4vKipcclxuICogXCJnZW1cIjogcmFua2VkIGFib3ZlIHRoZSBtZWRpYW4gYnV0IHBsYXllZCBsZXNzIHRoYW4gdGhlIG1lZGlhbiAoYSBoaWRkZW4gZ2VtKTsgXCJvdmVycGxheWVkXCI6XHJcbiAqIGJlbG93IHRoZSBtZWRpYW4gRUxPIGJ1dCBwbGF5ZWQgbW9yZS4gTnVsbCBmb3IgZXZlcnl0aGluZyBlbHNlLCBhbmQgZm9yIHVucmF0ZWQgc2NlbmVzLlxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGdlbXNRdWFkcmFudChzY2VuZTogU2NlbmUsIHNwbGl0OiBHZW1zU3BsaXQpOiBcImdlbVwiIHwgXCJvdmVycGxheWVkXCIgfCBudWxsIHtcclxuICBjb25zdCB2YWx1ZSA9IGVsbyhzY2VuZSk7XHJcbiAgaWYgKHZhbHVlID09PSBudWxsKSByZXR1cm4gbnVsbDtcclxuICBjb25zdCBwbGF5cyA9IHNjZW5lLnBsYXlfY291bnQgPz8gMDtcclxuICBpZiAodmFsdWUgPiBzcGxpdC5lbG8gJiYgcGxheXMgPCBzcGxpdC5wbGF5cykgcmV0dXJuIFwiZ2VtXCI7XHJcbiAgaWYgKHZhbHVlIDwgc3BsaXQuZWxvICYmIHBsYXlzID4gc3BsaXQucGxheXMpIHJldHVybiBcIm92ZXJwbGF5ZWRcIjtcclxuICByZXR1cm4gbnVsbDtcclxufVxyXG5cclxuZXhwb3J0IGludGVyZmFjZSBTZXR0bGVkQnVja2V0IHtcclxuICBtaW46IG51bWJlcjtcclxuICAvKiogSW5jbHVzaXZlOyBudWxsIGZvciB0aGUgb3Blbi1lbmRlZCBsYXN0IGJ1Y2tldC4gKi9cclxuICBtYXg6IG51bWJlciB8IG51bGw7XHJcbiAgY291bnQ6IG51bWJlcjtcclxufVxyXG5cclxuLyoqXHJcbiAqIFJhdGVkIHNjZW5lcyBieSByZWFsIGJhdHRsZXM6IG5vbmUgeWV0LCB0aGVuIHRoZSBLIHRpZXJzJyByYW5nZXMgKDEtOSwgMTAtMjksIDMwKyksIHNvIGVhY2hcclxuICogYnVja2V0IGFmdGVyIHRoZSBmaXJzdCBpcyBhIHN0YWdlIHdoZXJlIGEgYmF0dGxlIG1vdmVzIEVMTyBieSBhIGRpZmZlcmVudCBhbW91bnQuXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gc2V0dGxlZEJ1Y2tldHMoc2NlbmVzOiBTY2VuZVtdKTogU2V0dGxlZEJ1Y2tldFtdIHtcclxuICBjb25zdCBsaW1pdHMgPSBFTE9fS19USUVSUy5tYXAoKFtiZWxvd10pID0+IGJlbG93KS5maWx0ZXIoTnVtYmVyLmlzRmluaXRlKTtcclxuICBjb25zdCBlZGdlcyA9IFswLCAxLCAuLi5saW1pdHNdO1xyXG4gIGNvbnN0IGJ1Y2tldHM6IFNldHRsZWRCdWNrZXRbXSA9IGVkZ2VzLm1hcCgobWluLCBpKSA9PiAoe1xyXG4gICAgbWluLFxyXG4gICAgbWF4OiBpICsgMSA8IGVkZ2VzLmxlbmd0aCA/IGVkZ2VzW2kgKyAxXSAtIDEgOiBudWxsLFxyXG4gICAgY291bnQ6IDAsXHJcbiAgfSkpO1xyXG4gIGZvciAoY29uc3QgeyBzY2VuZSB9IG9mIHJhdGVkRWxvcyhzY2VuZXMpKSB7XHJcbiAgICBjb25zdCBuID0gYmF0dGxlcyhzY2VuZSk7XHJcbiAgICBjb25zdCBidWNrZXQgPSBbLi4uYnVja2V0c10ucmV2ZXJzZSgpLmZpbmQoKGIpID0+IG4gPj0gYi5taW4pO1xyXG4gICAgaWYgKGJ1Y2tldCkgYnVja2V0LmNvdW50Kys7XHJcbiAgfVxyXG4gIHJldHVybiBidWNrZXRzO1xyXG59XHJcblxyXG4vKipcclxuICogXCJCYXR0bGUgdGhlIGxlYXN0LXRlc3RlZFwiOiB0aGUgc2NlbmUgaW4gdGhlIHBvb2wgd2l0aCB0aGUgZmV3ZXN0IHJlYWwgYmF0dGxlcyAodW5yYXRlZCBzY2VuZXNcclxuICogaGF2ZSBub25lKSwgYXQgcmFuZG9tIGFtb25nIGVxdWFscy4gYGV4Y2x1ZGVJZGAgKHRoZSBzY2VuZSBqdXN0IHNob3duKSBpcyBza2lwcGVkIHVubGVzcyBpdCdzXHJcbiAqIHRoZSBvbmx5IG9uZS5cclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBsZWFzdFRlc3RlZChwb29sOiBTY2VuZVtdLCBleGNsdWRlSWQ6IHN0cmluZyB8IG51bGwsIHJhbmRvbTogKCkgPT4gbnVtYmVyID0gTWF0aC5yYW5kb20pOiBTY2VuZSB8IG51bGwge1xyXG4gIGNvbnN0IGNhbmRpZGF0ZXMgPSBwb29sLmxlbmd0aCA+IDEgPyBwb29sLmZpbHRlcigocykgPT4gcy5pZCAhPT0gZXhjbHVkZUlkKSA6IHBvb2w7XHJcbiAgaWYgKGNhbmRpZGF0ZXMubGVuZ3RoID09PSAwKSByZXR1cm4gbnVsbDtcclxuICBjb25zdCBmZXdlc3QgPSBNYXRoLm1pbiguLi5jYW5kaWRhdGVzLm1hcChiYXR0bGVzKSk7XHJcbiAgY29uc3QgdGllZCA9IGNhbmRpZGF0ZXMuZmlsdGVyKChzKSA9PiBiYXR0bGVzKHMpID09PSBmZXdlc3QpO1xyXG4gIHJldHVybiB0aWVkW01hdGgubWluKHRpZWQubGVuZ3RoIC0gMSwgTWF0aC5mbG9vcihyYW5kb20oKSAqIHRpZWQubGVuZ3RoKSldO1xyXG59XHJcblxyXG4vKipcclxuICogVGllciBmb3IgZXZlcnkgc2V0dGxlZCBzY2VuZSAocmF0ZWQgYW5kIG5vdCBwcm92aXNpb25hbCksIGJ5IHJhbmsgYW1vbmcgdGhlbTogYSBzY2VuZSB3aG9zZVxyXG4gKiByYW5rIGlzIHdpdGhpbiB0aGUgdG9wIGB0aWVyLnRvcGAgc2hhcmUgZ2V0cyB0aGF0IHRpZXIuIFRpZWQgc2NlbmVzIHNoYXJlIHRoZSBtaWRkbGUgcG9zaXRpb25cclxuICogb2YgdGhlaXIgdGllIGdyb3VwLCBhcyBpbiBwZXJjZW50aWxlUmF0aW5ncywgc28gdGhleSBhbHdheXMgc2hhcmUgYSB0aWVyLiBQcm92aXNpb25hbCBhbmRcclxuICogdW5yYXRlZCBzY2VuZXMgZ2V0IG5vbmUsIGxpa2UgXCJ1bnJhbmtlZFwiIHVudGlsIHBsYWNlbWVudCBtYXRjaGVzIGFyZSBkb25lLlxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHRpZXJNYXAoc2NlbmVzOiBTY2VuZVtdKTogTWFwPHN0cmluZywgVGllcj4ge1xyXG4gIGNvbnN0IHNldHRsZWQgPSBzY2VuZXNcclxuICAgIC5maWx0ZXIoKHNjZW5lKSA9PiAhaXNQcm92aXNpb25hbChzY2VuZSkpXHJcbiAgICAubWFwKChzY2VuZSkgPT4gKHsgaWQ6IHNjZW5lLmlkLCBlbG86IGVsbyhzY2VuZSkgfSkpXHJcbiAgICAuZmlsdGVyKChzKTogcyBpcyB7IGlkOiBzdHJpbmc7IGVsbzogbnVtYmVyIH0gPT4gcy5lbG8gIT09IG51bGwpXHJcbiAgICAuc29ydCgoYSwgYikgPT4gYi5lbG8gLSBhLmVsbyk7XHJcblxyXG4gIGNvbnN0IHRpZXJzID0gbmV3IE1hcDxzdHJpbmcsIFRpZXI+KCk7XHJcbiAgY29uc3QgbiA9IHNldHRsZWQubGVuZ3RoO1xyXG4gIGxldCBzdGFydCA9IDA7XHJcbiAgd2hpbGUgKHN0YXJ0IDwgbikge1xyXG4gICAgbGV0IGVuZCA9IHN0YXJ0O1xyXG4gICAgd2hpbGUgKGVuZCArIDEgPCBuICYmIHNldHRsZWRbZW5kICsgMV0uZWxvID09PSBzZXR0bGVkW3N0YXJ0XS5lbG8pIGVuZCsrO1xyXG4gICAgLy8gU2hhcmUgb2Ygc2V0dGxlZCBzY2VuZXMgcmFua2VkIGFib3ZlIHRoaXMgdGllIGdyb3VwJ3MgbWlkZGxlICgwIGZvciB0aGUgdG9wIHNjZW5lKVxyXG4gICAgY29uc3QgYWJvdmUgPSAoc3RhcnQgKyBlbmQpIC8gMiAvIG47XHJcbiAgICBjb25zdCB0aWVyID0gVElFUlMuZmluZCgodCkgPT4gYWJvdmUgPCB0LnRvcCkgPz8gVElFUlNbVElFUlMubGVuZ3RoIC0gMV07XHJcbiAgICBmb3IgKGxldCBpID0gc3RhcnQ7IGkgPD0gZW5kOyBpKyspIHRpZXJzLnNldChzZXR0bGVkW2ldLmlkLCB0aWVyKTtcclxuICAgIHN0YXJ0ID0gZW5kICsgMTtcclxuICB9XHJcbiAgcmV0dXJuIHRpZXJzO1xyXG59XHJcblxyXG5sZXQgdGllckNhY2hlOiB7IHNjZW5lczogU2NlbmVbXTsga2V5OiBzdHJpbmc7IHRpZXJzOiBNYXA8c3RyaW5nLCBUaWVyPiB9IHwgbnVsbCA9IG51bGw7XHJcblxyXG4vKipcclxuICogdGllck1hcCBmb3IgdGhlIGFsbC1zY2VuZXMgY2FjaGUsIHdvcmtlZCBvdXQgYWdhaW4gb25seSB3aGVuIGl0IGNoYW5nZXM6IGEgZGlmZmVyZW50IGFycmF5LCBvclxyXG4gKiBhbnkgc2NlbmUncyBFTE8gb3IgYmF0dGxlcyAoYmF0dGxlcyBjaGFuZ2UgdGhlbSBpbiBwbGFjZSkuIFRoZSBrZXkgaXMgb25lIGNoZWFwIHBhc3M7IHRoZSBzb3J0XHJcbiAqIGlzIHNraXBwZWQuXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gY2FjaGVkVGllck1hcChzY2VuZXM6IFNjZW5lW10pOiBNYXA8c3RyaW5nLCBUaWVyPiB7XHJcbiAgY29uc3Qga2V5ID0gc2NlbmVzLm1hcCgocykgPT4gYCR7ZWxvKHMpID8/IFwiXCJ9LyR7YmF0dGxlcyhzKX1gKS5qb2luKFwiLFwiKTtcclxuICBpZiAodGllckNhY2hlPy5zY2VuZXMgIT09IHNjZW5lcyB8fCB0aWVyQ2FjaGUua2V5ICE9PSBrZXkpIHRpZXJDYWNoZSA9IHsgc2NlbmVzLCBrZXksIHRpZXJzOiB0aWVyTWFwKHNjZW5lcykgfTtcclxuICByZXR1cm4gdGllckNhY2hlLnRpZXJzO1xyXG59XHJcblxyXG4vKiogVG9vbHRpcCBmb3IgYSB0aWVyOiBcIkdvbGQ6IGluIHRoZSB0b3AgMzUlIG9mIHlvdXIgc2NlbmVzIHdpdGggYSBzZXR0bGVkIEVMT1wiLiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gdGllckRlc2NyaXB0aW9uKHRpZXI6IFRpZXIpOiBzdHJpbmcge1xyXG4gIGNvbnN0IGluZGV4ID0gVElFUlMuZmluZEluZGV4KCh0KSA9PiB0LmlkID09PSB0aWVyLmlkKTtcclxuICBjb25zdCBwZXJjZW50ID0gKHNoYXJlOiBudW1iZXIpOiBzdHJpbmcgPT4gYCR7TWF0aC5yb3VuZChzaGFyZSAqIDEwMCl9JWA7XHJcbiAgY29uc3Qgd2hlcmUgPVxyXG4gICAgaW5kZXggPT09IFRJRVJTLmxlbmd0aCAtIDEgJiYgaW5kZXggPiAwXHJcbiAgICAgID8gYGJlbG93IHRoZSB0b3AgJHtwZXJjZW50KFRJRVJTW2luZGV4IC0gMV0udG9wKX1gXHJcbiAgICAgIDogYGluIHRoZSB0b3AgJHtwZXJjZW50KHRpZXIudG9wKX1gO1xyXG4gIHJldHVybiBgJHt0aWVyLm5hbWV9OiAke3doZXJlfSBvZiB5b3VyIHNjZW5lcyB3aXRoIGEgc2V0dGxlZCBFTE9gO1xyXG59XHJcblxyXG4vKiogVXAgdG8gYG5gIHNjZW5lcyB3aXRoIGEgcmVjb3JkLCBoaWdoZXN0IGBrZXlgIGZpcnN0ICh0aWVzIGtlZXAgdGhlIGxpYnJhcnkncyBFTE8gb3JkZXIpLiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gdG9wQnlSZWNvcmQoc2NlbmVzOiBTY2VuZVtdLCBrZXk6IChyOiBTY2VuZVJlY29yZCkgPT4gbnVtYmVyLCBuOiBudW1iZXIpOiB7IHNjZW5lOiBTY2VuZTsgcmVjb3JkOiBTY2VuZVJlY29yZCB9W10ge1xyXG4gIHJldHVybiBzY2VuZXNcclxuICAgIC5tYXAoKHNjZW5lKSA9PiAoeyBzY2VuZSwgcmVjb3JkOiBzY2VuZVJlY29yZChzY2VuZSkgfSkpXHJcbiAgICAuZmlsdGVyKChzKTogcyBpcyB7IHNjZW5lOiBTY2VuZTsgcmVjb3JkOiBTY2VuZVJlY29yZCB9ID0+IHMucmVjb3JkICE9PSBudWxsICYmIGtleShzLnJlY29yZCkgPiAwKVxyXG4gICAgLnNvcnQoKGEsIGIpID0+IGtleShiLnJlY29yZCkgLSBrZXkoYS5yZWNvcmQpKVxyXG4gICAgLnNsaWNlKDAsIG4pO1xyXG59XHJcblxyXG4vKipcclxuICogVGhlIGxlYXN0LXRlc3RlZCBwb29sOiBob3cgbWFueSBzY2VuZXMgc2hhcmUgdGhlIGZld2VzdCByZWFsIGJhdHRsZXMgKGBjb3VudGApLCB0aGF0IG51bWJlcixcclxuICogYW5kIGhvdyBtYW55IG9mIHRoZW0gYXJlIHVucmF0ZWQgKHRoZXkgaGF2ZSBubyBiYXR0bGVzLCBzbyB0aGV5J3JlIGluIGl0IHdoZW5ldmVyIGl0J3MgMCkuXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gbGVhc3RUZXN0ZWRQb29sKHNjZW5lczogU2NlbmVbXSk6IHsgYmF0dGxlczogbnVtYmVyOyBjb3VudDogbnVtYmVyOyB1bnJhdGVkOiBudW1iZXIgfSB8IG51bGwge1xyXG4gIGlmIChzY2VuZXMubGVuZ3RoID09PSAwKSByZXR1cm4gbnVsbDtcclxuICBjb25zdCBmZXdlc3QgPSBNYXRoLm1pbiguLi5zY2VuZXMubWFwKGJhdHRsZXMpKTtcclxuICBjb25zdCBwb29sID0gc2NlbmVzLmZpbHRlcigocykgPT4gYmF0dGxlcyhzKSA9PT0gZmV3ZXN0KTtcclxuICByZXR1cm4geyBiYXR0bGVzOiBmZXdlc3QsIGNvdW50OiBwb29sLmxlbmd0aCwgdW5yYXRlZDogcG9vbC5maWx0ZXIoKHMpID0+IGVsbyhzKSA9PT0gbnVsbCkubGVuZ3RoIH07XHJcbn1cclxuIiwgIi8vIFRoZSBFeHBsb3JlIHRhYidzIHNlYXJjaCwgZmlsdGVycyBhbmQgc29ydGluZyBvdmVyIHRoZSBsaWJyYXJ5LiBQdXJlIGZ1bmN0aW9uczogbm8gc3RhdGUsIG5vIEkvTy5cclxuXHJcbmltcG9ydCB7IGJhdHRsZXMsIGVsbywgaXNQcm92aXNpb25hbCwgc2NlbmVSZWNvcmQgfSBmcm9tIFwiLi9zY29yZVwiO1xyXG5pbXBvcnQgeyBjYWNoZWRUaWVyTWFwIH0gZnJvbSBcIi4vc3RhdHNcIjtcclxuaW1wb3J0IHR5cGUgeyBTY2VuZSwgU2NlbmVSZWNvcmQsIFRpZXIgfSBmcm9tIFwiLi90eXBlc1wiO1xyXG5cclxuLyoqIEEgbGlicmFyeSBzY2VuZSB3aXRoIHdoYXQgRXhwbG9yZSBzaG93cyBhbmQgZmlsdGVycyBvbi4gKi9cclxuZXhwb3J0IGludGVyZmFjZSBFeHBsb3JlRW50cnkge1xyXG4gIHNjZW5lOiBTY2VuZTtcclxuICAvKiogUmFuayBhbW9uZyByYXRlZCBzY2VuZXMgKDEgPSB0b3ApLCBudWxsIHdoZW4gdW5yYXRlZC4gKi9cclxuICByYW5rOiBudW1iZXIgfCBudWxsO1xyXG4gIHRpZXI6IFRpZXIgfCBudWxsO1xyXG4gIC8qKiBMb3dlci1jYXNlZCB0aXRsZSwgc3R1ZGlvIGFuZCBwZXJmb3JtZXJzLCBmb3Igc2VhcmNoLiAqL1xyXG4gIHRleHQ6IHN0cmluZztcclxufVxyXG5cclxuLyoqIEEgdGllciBpZCwgb3IgXCJwcm92aXNpb25hbFwiIC8gXCJ1bnJhdGVkXCI7IG51bGwgc2hvd3MgZXZlcnlvbmUuICovXHJcbmV4cG9ydCB0eXBlIEV4cGxvcmVHcm91cCA9IHN0cmluZyB8IG51bGw7XHJcblxyXG5leHBvcnQgdHlwZSBFeHBsb3JlU29ydCA9XHJcbiAgfCBcImVsby1kZXNjXCJcclxuICB8IFwiZWxvLWFzY1wiXHJcbiAgfCBcInBsYXlzLWRlc2NcIlxyXG4gIHwgXCJwbGF5cy1hc2NcIlxyXG4gIHwgXCJiYXR0bGVzLWRlc2NcIlxyXG4gIHwgXCJiYXR0bGVzLWFzY1wiXHJcbiAgfCBcInJlY29yZC1kZXNjXCJcclxuICB8IFwicGVhay1kZXNjXCJcclxuICB8IFwic3RyZWFrLWRlc2NcIjtcclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgRXhwbG9yZUZpbHRlcnMge1xyXG4gIHF1ZXJ5OiBzdHJpbmc7XHJcbiAgZ3JvdXA6IEV4cGxvcmVHcm91cDtcclxuICAvKiogSW5jbHVzaXZlIEVMTyByYW5nZTsgbnVsbCBmb3Igbm8gbGltaXQuIEEgcmFuZ2UgbGVhdmVzIHVucmF0ZWQgc2NlbmVzIG91dC4gKi9cclxuICBlbG9NaW46IG51bWJlciB8IG51bGw7XHJcbiAgZWxvTWF4OiBudW1iZXIgfCBudWxsO1xyXG4gIHNvcnQ6IEV4cGxvcmVTb3J0O1xyXG59XHJcblxyXG5leHBvcnQgY29uc3QgREVGQVVMVF9FWFBMT1JFX0ZJTFRFUlM6IEV4cGxvcmVGaWx0ZXJzID0ge1xyXG4gIHF1ZXJ5OiBcIlwiLFxyXG4gIGdyb3VwOiBudWxsLFxyXG4gIGVsb01pbjogbnVsbCxcclxuICBlbG9NYXg6IG51bGwsXHJcbiAgc29ydDogXCJlbG8tZGVzY1wiLFxyXG59O1xyXG5cclxuLyoqXHJcbiAqIEVudHJpZXMgZm9yIGFuIEVMTy1zb3J0ZWQgbGlicmFyeSAodW5yYXRlZCBzY2VuZXMgbGFzdCwgYXMgdGhlIGFsbC1zY2VuZXMgY2FjaGUga2VlcHMgaXQpOlxyXG4gKiB0aGUgaW5kZXggaXMgdGhlIHJhbmsuIGB0aXRsZWAgbmFtZXMgYSBzY2VuZSAoaXRzIHRpdGxlIG9yIGZpbGUgbmFtZSkuXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gZXhwbG9yZUVudHJpZXMoXHJcbiAgc2NlbmVzOiBTY2VuZVtdLFxyXG4gIHRpZXJzOiBNYXA8c3RyaW5nLCBUaWVyPixcclxuICB0aXRsZTogKHNjZW5lOiBTY2VuZSkgPT4gc3RyaW5nLFxyXG4pOiBFeHBsb3JlRW50cnlbXSB7XHJcbiAgcmV0dXJuIHNjZW5lcy5tYXAoKHNjZW5lLCBpbmRleCkgPT4gKHtcclxuICAgIHNjZW5lLFxyXG4gICAgcmFuazogZWxvKHNjZW5lKSA9PT0gbnVsbCA/IG51bGwgOiBpbmRleCArIDEsXHJcbiAgICB0aWVyOiB0aWVycy5nZXQoc2NlbmUuaWQpID8/IG51bGwsXHJcbiAgICB0ZXh0OiBbdGl0bGUoc2NlbmUpLCBzY2VuZS5zdHVkaW8/Lm5hbWUgPz8gXCJcIiwgLi4uKHNjZW5lLnBlcmZvcm1lcnMgPz8gW10pLm1hcCgocCkgPT4gcC5uYW1lKV0uam9pbihcIiBcIikudG9Mb3dlckNhc2UoKSxcclxuICB9KSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGluR3JvdXAoZW50cnk6IEV4cGxvcmVFbnRyeSwgZ3JvdXA6IEV4cGxvcmVHcm91cCk6IGJvb2xlYW4ge1xyXG4gIGlmIChncm91cCA9PT0gbnVsbCkgcmV0dXJuIHRydWU7XHJcbiAgaWYgKGdyb3VwID09PSBcInVucmF0ZWRcIikgcmV0dXJuIGVsbyhlbnRyeS5zY2VuZSkgPT09IG51bGw7XHJcbiAgaWYgKGdyb3VwID09PSBcInByb3Zpc2lvbmFsXCIpIHJldHVybiBpc1Byb3Zpc2lvbmFsKGVudHJ5LnNjZW5lKTtcclxuICByZXR1cm4gZW50cnkudGllcj8uaWQgPT09IGdyb3VwO1xyXG59XHJcblxyXG4vKiogRW50cmllcyBtYXRjaGluZyB0aGUgZmlsdGVycywgaW4gdGhlIGNob3NlbiBvcmRlci4gRXZlcnkgd29yZCBvZiB0aGUgcXVlcnkgbXVzdCBtYXRjaC4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGZpbHRlckV4cGxvcmUoZW50cmllczogRXhwbG9yZUVudHJ5W10sIGZpbHRlcnM6IEV4cGxvcmVGaWx0ZXJzKTogRXhwbG9yZUVudHJ5W10ge1xyXG4gIGNvbnN0IHdvcmRzID0gZmlsdGVycy5xdWVyeS50b0xvd2VyQ2FzZSgpLnNwbGl0KC9cXHMrLykuZmlsdGVyKEJvb2xlYW4pO1xyXG4gIGNvbnN0IHJhbmdlZCA9IGZpbHRlcnMuZWxvTWluICE9PSBudWxsIHx8IGZpbHRlcnMuZWxvTWF4ICE9PSBudWxsO1xyXG4gIGNvbnN0IG1hdGNoZXMgPSBlbnRyaWVzLmZpbHRlcigoZW50cnkpID0+IHtcclxuICAgIGlmICghaW5Hcm91cChlbnRyeSwgZmlsdGVycy5ncm91cCkpIHJldHVybiBmYWxzZTtcclxuICAgIGlmICh3b3Jkcy5zb21lKCh3b3JkKSA9PiAhZW50cnkudGV4dC5pbmNsdWRlcyh3b3JkKSkpIHJldHVybiBmYWxzZTtcclxuICAgIGlmIChyYW5nZWQpIHtcclxuICAgICAgY29uc3QgdmFsdWUgPSBlbG8oZW50cnkuc2NlbmUpO1xyXG4gICAgICBpZiAodmFsdWUgPT09IG51bGwpIHJldHVybiBmYWxzZTtcclxuICAgICAgaWYgKGZpbHRlcnMuZWxvTWluICE9PSBudWxsICYmIHZhbHVlIDwgZmlsdGVycy5lbG9NaW4pIHJldHVybiBmYWxzZTtcclxuICAgICAgaWYgKGZpbHRlcnMuZWxvTWF4ICE9PSBudWxsICYmIHZhbHVlID4gZmlsdGVycy5lbG9NYXgpIHJldHVybiBmYWxzZTtcclxuICAgIH1cclxuICAgIHJldHVybiB0cnVlO1xyXG4gIH0pO1xyXG4gIHJldHVybiBzb3J0RXhwbG9yZShtYXRjaGVzLCBmaWx0ZXJzLnNvcnQpO1xyXG59XHJcblxyXG4vKipcclxuICogSGlnaGVzdCBmaXJzdCBieSBlYWNoIGtleSBpbiB0dXJuICh3aW5zIOKIkiBsb3NzZXMsIHRoZW4gd2lucywgc2F5KTsgc2NlbmVzIHdpdGhvdXQgYSByZWNvcmQgZ29cclxuICogbGFzdC4gMCB3aGVuIGVxdWFsLlxyXG4gKi9cclxuZnVuY3Rpb24gYnlSZWNvcmQoYTogRXhwbG9yZUVudHJ5LCBiOiBFeHBsb3JlRW50cnksIC4uLmtleXM6ICgocjogU2NlbmVSZWNvcmQpID0+IG51bWJlcilbXSk6IG51bWJlciB7XHJcbiAgY29uc3QgcmEgPSBzY2VuZVJlY29yZChhLnNjZW5lKTtcclxuICBjb25zdCByYiA9IHNjZW5lUmVjb3JkKGIuc2NlbmUpO1xyXG4gIGlmICghcmEgfHwgIXJiKSByZXR1cm4gKHJhID8gMCA6IDEpIC0gKHJiID8gMCA6IDEpO1xyXG4gIGZvciAoY29uc3Qga2V5IG9mIGtleXMpIHtcclxuICAgIGNvbnN0IGRpZmYgPSBrZXkocmIpIC0ga2V5KHJhKTtcclxuICAgIGlmIChkaWZmKSByZXR1cm4gZGlmZjtcclxuICB9XHJcbiAgcmV0dXJuIDA7XHJcbn1cclxuXHJcbi8qKiBTb3J0ZWQgY29weS4gRUxPIHNvcnRzIGtlZXAgdW5yYXRlZCBzY2VuZXMgbGFzdCBlaXRoZXIgd2F5OyB0aWVzIGtlZXAgdGhlIGxpYnJhcnkgKEVMTykgb3JkZXIuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBzb3J0RXhwbG9yZShlbnRyaWVzOiBFeHBsb3JlRW50cnlbXSwgc29ydDogRXhwbG9yZVNvcnQpOiBFeHBsb3JlRW50cnlbXSB7XHJcbiAgY29uc3QgYnlSYW5rID0gKGE6IEV4cGxvcmVFbnRyeSwgYjogRXhwbG9yZUVudHJ5KTogbnVtYmVyID0+IChhLnJhbmsgPz8gSW5maW5pdHkpIC0gKGIucmFuayA/PyBJbmZpbml0eSk7XHJcbiAgY29uc3QgcGxheXMgPSAoZTogRXhwbG9yZUVudHJ5KTogbnVtYmVyID0+IGUuc2NlbmUucGxheV9jb3VudCA/PyAwO1xyXG4gIGNvbnN0IGNvbXBhcmU6IFJlY29yZDxFeHBsb3JlU29ydCwgKGE6IEV4cGxvcmVFbnRyeSwgYjogRXhwbG9yZUVudHJ5KSA9PiBudW1iZXI+ID0ge1xyXG4gICAgXCJlbG8tZGVzY1wiOiBieVJhbmssXHJcbiAgICBcImVsby1hc2NcIjogKGEsIGIpID0+IChhLnJhbmsgPT09IG51bGwgfHwgYi5yYW5rID09PSBudWxsID8gYnlSYW5rKGEsIGIpIDogYi5yYW5rIC0gYS5yYW5rKSxcclxuICAgIFwicGxheXMtZGVzY1wiOiAoYSwgYikgPT4gcGxheXMoYikgLSBwbGF5cyhhKSB8fCBieVJhbmsoYSwgYiksXHJcbiAgICBcInBsYXlzLWFzY1wiOiAoYSwgYikgPT4gcGxheXMoYSkgLSBwbGF5cyhiKSB8fCBieVJhbmsoYSwgYiksXHJcbiAgICBcImJhdHRsZXMtZGVzY1wiOiAoYSwgYikgPT4gYmF0dGxlcyhiLnNjZW5lKSAtIGJhdHRsZXMoYS5zY2VuZSkgfHwgYnlSYW5rKGEsIGIpLFxyXG4gICAgXCJiYXR0bGVzLWFzY1wiOiAoYSwgYikgPT4gYmF0dGxlcyhhLnNjZW5lKSAtIGJhdHRsZXMoYi5zY2VuZSkgfHwgYnlSYW5rKGEsIGIpLFxyXG4gICAgLy8gUmVjb3JkIHNvcnRzIHB1dCBzY2VuZXMgd2l0aG91dCBhIHJlY29yZCBsYXN0XHJcbiAgICBcInJlY29yZC1kZXNjXCI6IChhLCBiKSA9PiBieVJlY29yZChhLCBiLCAocikgPT4gci53aW5zIC0gci5sb3NzZXMsIChyKSA9PiByLndpbnMpIHx8IGJ5UmFuayhhLCBiKSxcclxuICAgIFwicGVhay1kZXNjXCI6IChhLCBiKSA9PiBieVJlY29yZChhLCBiLCAocikgPT4gci5wZWFrKSB8fCBieVJhbmsoYSwgYiksXHJcbiAgICBcInN0cmVhay1kZXNjXCI6IChhLCBiKSA9PiBieVJlY29yZChhLCBiLCAocikgPT4gci5iZXN0U3RyZWFrKSB8fCBieVJhbmsoYSwgYiksXHJcbiAgfTtcclxuICByZXR1cm4gWy4uLmVudHJpZXNdLnNvcnQoY29tcGFyZVtzb3J0XSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBCYXR0bGluZyBhbiBFeHBsb3JlIGZpbHRlcjogZG8gYm90aCBzaWRlcyBjb21lIGZyb20gdGhlIGZpbHRlcj8gTGlrZSB0aGUgU2NlbmVzIHBhZ2UgZmlsdGVyLFxyXG4gKiBvbmx5IHdpdGggXCJVc2UgZmlsdGVyZWQgc2NlbmVzIGZvciBib3RoIHNpZGVzXCIgKGBib3RoU2lkZXNgKS4gTmV2ZXIgZm9yIHVucmF0ZWQgc2NlbmVzOiB0aGV5J3JlXHJcbiAqIHBsYWNlZCwgYW5kIHBsYWNpbmcgYSBzY2VuZSBhbW9uZyBvdGhlciB1bnJhdGVkIG9uZXMgKG5vbmUgaGFzIGFuIEVMTykgd291bGQgbGFuZCB0aGVtIGFsbCBhdFxyXG4gKiAxNTAwLlxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGZpbHRlckJhdHRsZXNXaXRoaW4oZmlsdGVyczogRXhwbG9yZUZpbHRlcnMsIGJvdGhTaWRlczogYm9vbGVhbik6IGJvb2xlYW4ge1xyXG4gIHJldHVybiBib3RoU2lkZXMgJiYgZmlsdGVycy5ncm91cCAhPT0gXCJ1bnJhdGVkXCI7XHJcbn1cclxuXHJcbi8qKiBUaGUgc2NlbmVzIGFuIEV4cGxvcmUgZmlsdGVyIHBpY2tzIGZyb20gYW4gRUxPLXNvcnRlZCBsaWJyYXJ5LCBpbiBFTE8gb3JkZXIuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBleHBsb3JlUG9vbFNjZW5lcyhzY2VuZXM6IFNjZW5lW10sIGZpbHRlcnM6IEV4cGxvcmVGaWx0ZXJzLCB0aXRsZTogKHNjZW5lOiBTY2VuZSkgPT4gc3RyaW5nKTogU2NlbmVbXSB7XHJcbiAgLy8gUnVuIG9uIGV2ZXJ5IHBpY2s6IHNlYXJjaCB0ZXh0IGlzIG9ubHkgYnVpbHQgd2hlbiB0aGVyZSdzIGEgcXVlcnkgdG8gbWF0Y2hcclxuICBjb25zdCB0ZXh0ID0gZmlsdGVycy5xdWVyeS50cmltKCkgPyB0aXRsZSA6ICgpOiBzdHJpbmcgPT4gXCJcIjtcclxuICByZXR1cm4gZmlsdGVyRXhwbG9yZShleHBsb3JlRW50cmllcyhzY2VuZXMsIGNhY2hlZFRpZXJNYXAoc2NlbmVzKSwgdGV4dCksIHsgLi4uZmlsdGVycywgc29ydDogXCJlbG8tZGVzY1wiIH0pLm1hcCgoZSkgPT4gZS5zY2VuZSk7XHJcbn1cclxuIiwgIi8vIENlbnRyYWwgbXV0YWJsZSBydW50aW1lIHN0YXRlLlxuLy9cbi8vIFRoZSBvcmlnaW5hbCBwbHVnaW4gdXNlZCBtb2R1bGUtbGV2ZWwgYGxldGAgYmluZGluZ3Mgc2hhcmVkIGFjcm9zcyBtYW55IGZ1bmN0aW9ucy5cbi8vIEVTIG1vZHVsZXMgY2Fubm90IHJlYXNzaWduIGFuIGltcG9ydGVkIGJpbmRpbmcgZnJvbSBhbm90aGVyIG1vZHVsZSwgc28gYWxsIHNoYXJlZFxuLy8gbXV0YWJsZSB2YWx1ZXMgbGl2ZSBvbiB0aGlzIHNpbmdsZSBgc3RhdGVgIG9iamVjdCB0aGF0IGV2ZXJ5IG1vZHVsZSBpbXBvcnRzLlxuXG5pbXBvcnQgeyBERUZBVUxUX1NFVFRJTkdTIH0gZnJvbSBcIi4vY29uc3RhbnRzXCI7XG5pbXBvcnQgeyBERUZBVUxUX0VYUExPUkVfRklMVEVSUywgZmlsdGVyQmF0dGxlc1dpdGhpbiwgdHlwZSBFeHBsb3JlRmlsdGVycyB9IGZyb20gXCIuL2V4cGxvcmVcIjtcbmltcG9ydCB0eXBlIHsgTW9kZSwgUGFpciwgUGxhY2VtZW50UnVuLCBSYW5rcywgU2NlbmUsIFNldHRpbmdzIH0gZnJvbSBcIi4vdHlwZXNcIjtcblxuLyoqXG4gKiBXaGF0J3MgYmF0dGxlZCB1bnRpbCBTdG9wIGluIHBsYWNlIG9mIHRoZSBTY2VuZXMgcGFnZSBmaWx0ZXI6IGFuIEV4cGxvcmUgZmlsdGVyIChzZWVcbiAqIGZpbHRlckJhdHRsZXNXaXRoaW4gZm9yIHdobyBiYXR0bGVzIHdob20pLCBvciBvbmUgc2NlbmUgKGl0cyDimpTvuI8sIG9yIG9wZW5lZCBmcm9tIGl0cyBwYWdlKS5cbiAqL1xuZXhwb3J0IGludGVyZmFjZSBFeHBsb3JlUG9vbCB7XG4gIGZpbHRlcnM6IEV4cGxvcmVGaWx0ZXJzO1xuICAvKiogXCLwn5GRIExlZ2VuZGFyeSDCtyBFTE8gMTYwMOKAkzE3MDBcIiwgZm9yIHRoZSBub3RlIGFib3ZlIHRoZSBjYXJkcy4gKi9cbiAgbGFiZWw6IHN0cmluZztcbiAgLyoqIFNldCB3aGVuIGJhdHRsaW5nIG9uZSBzY2VuZTogaXQncyB0aGUgd2hvbGUgcG9vbCwgYWdhaW5zdCB5b3VyIHdob2xlIGxpYnJhcnkgKGBmaWx0ZXJzYCB1bnVzZWQpLiAqL1xuICBzY2VuZUlkPzogc3RyaW5nO1xufVxuXG4vKiogT25lIHNjZW5lLCBiYXR0bGVkIHVudGlsIFN0b3AgKGl0IGtlZXBzIGNvbWluZyBiYWNrIG9uIHRoZSBsZWZ0KS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBvbmVTY2VuZVBvb2woc2NlbmVJZDogc3RyaW5nKTogRXhwbG9yZVBvb2wge1xuICByZXR1cm4geyBmaWx0ZXJzOiB7IC4uLkRFRkFVTFRfRVhQTE9SRV9GSUxURVJTIH0sIGxhYmVsOiBcIlwiLCBzY2VuZUlkIH07XG59XG5cbi8qKiBUaGUgYmF0dGxlZCBFeHBsb3JlIGZpbHRlcidzIHNjZW5lcyBhcmUgb24gYm90aCBzaWRlcyAocmVhZCBlYWNoIHBpY2ssIHNvIHRoZSBzZXR0aW5nIGFwcGxpZXMgYXQgb25jZSkuICovXG5leHBvcnQgZnVuY3Rpb24gZXhwbG9yZVBvb2xXaXRoaW4oKTogYm9vbGVhbiB7XG4gIGNvbnN0IHBvb2wgPSBzdGF0ZS5leHBsb3JlUG9vbDtcbiAgcmV0dXJuIHBvb2wgIT09IG51bGwgJiYgIXBvb2wuc2NlbmVJZCAmJiBmaWx0ZXJCYXR0bGVzV2l0aGluKHBvb2wuZmlsdGVycywgc3RhdGUuc2V0dGluZ3MuZmlsdGVyT3Bwb25lbnRzKTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBNZW1vcnlDYWNoZSB7XG4gIGFsbFNjZW5lczogU2NlbmVbXSB8IG51bGw7IC8vIEFsbCBzY2VuZXMgKG5vIGZpbHRlcilcbiAgZmlsdGVyZWRTY2VuZXM6IFNjZW5lW10gfCBudWxsOyAvLyBTY2VuZXMgbWF0Y2hpbmcgY3VycmVudCBmaWx0ZXJcbiAgZmlsdGVyS2V5OiBzdHJpbmcgfCBudWxsOyAvLyBDdXJyZW50IGZpbHRlciBwYXJhbXMgZm9yIGNhY2hlIHZhbGlkYXRpb25cbiAgdGltZXN0YW1wOiBudW1iZXIgfCBudWxsOyAvLyBXaGVuIGNhY2hlIHdhcyBwb3B1bGF0ZWRcbn1cblxuZXhwb3J0IGludGVyZmFjZSBCYXR0bGVTdGF0ZSB7XG4gIC8vIEN1cnJlbnQgY29tcGFyaXNvbiBwYWlyIGFuZCBtb2RlXG4gIGN1cnJlbnRQYWlyOiBQYWlyO1xuICBjdXJyZW50UmFua3M6IFJhbmtzO1xuICBjdXJyZW50TW9kZTogTW9kZTtcbiAgLy8gQ2hhbXBpb24gcnVuIHRyYWNraW5nXG4gIGNoYW1waW9uU2NlbmU6IFNjZW5lIHwgbnVsbDsgLy8gVGhlIHNjZW5lIGRlZmVuZGluZyAod2lubmVyIHN0YXlzIG9uKVxuICBjaGFtcGlvbldpbnM6IG51bWJlcjsgLy8gSXRzIGN1cnJlbnQgd2luIHN0cmVha1xuICBjaGFtcGlvbkRlZmVhdGVkOiBzdHJpbmdbXTsgLy8gSURzIG9mIHNjZW5lcyBpdCBoYXMgYmVhdGVuIGluIHRoaXMgcnVuXG4gIC8vIFBsYWNlbWVudCBydW4gdHJhY2tpbmdcbiAgcGxhY2VtZW50OiBQbGFjZW1lbnRSdW4gfCBudWxsO1xuICB0b3RhbFNjZW5lc0NvdW50OiBudW1iZXI7IC8vIFRvdGFsIHNjZW5lcyBmb3IgcG9zaXRpb24gZGlzcGxheVxuICBsZWZ0UG9vbFNpemU6IG51bWJlciB8IG51bGw7IC8vIFNjZW5lcyBvbiB0aGUgXCJ0byByYXRlXCIgc2lkZSAoZmlsdGVyIG9yIHdob2xlIGxpYnJhcnkpOyBudWxsIHVudGlsIGxvYWRlZFxuICBkaXNhYmxlQ2hvaWNlOiBib29sZWFuOyAvLyBQcmV2ZW50cyBtdWx0aXBsZSByYXBpZCBjaG9pY2UgZXZlbnRzXG4gIHNhdmVkRmlsdGVyUGFyYW1zOiBzdHJpbmc7IC8vIFN0b3JlZCBVUkwgZmlsdGVyIHBhcmFtcyB0byBkZXRlY3QgY2hhbmdlc1xuICAvLyBVc2VyIHNldHRpbmdzIChkZWZhdWx0cyB1bnRpbCBsb2FkU2V0dGluZ3MoKSByZXNvbHZlcylcbiAgc2V0dGluZ3M6IFNldHRpbmdzO1xuICByZXNldHRpbmdFbG86IGJvb2xlYW47IC8vIFJlc2V0IEVMTydzIHNldHVwIHNjcmVlbiBpcyBzaG93aW5nIChiYXR0bGVzIHdhaXQsIGxpa2UgYSBmaXJzdCBzZXR1cClcbiAgbGVhc3RUZXN0ZWQ6IGJvb2xlYW47IC8vIFN0YXRzIOKGkiBcIkJhdHRsZSB0aGUgbGVhc3QtdGVzdGVkXCI6IFN3aXNzIHRha2VzIHRoZSBmZXdlc3QtYmF0dGxlZCBzY2VuZSBvbiB0aGUgbGVmdFxuICBleHBsb3JlUG9vbDogRXhwbG9yZVBvb2wgfCBudWxsOyAvLyBFeHBsb3JlIOKGkiBcIkJhdHRsZSB0aGVzZVwiLCBvciBvbmUgc2NlbmU6IHJlcGxhY2VzIHRoZSBTY2VuZXMgcGFnZSBmaWx0ZXJcbiAgLy8gU2h1ZmZsZSBzdGF0ZSBmb3IgdGhlIGxlZnQtc2lkZSBwb29sIChwcmV2ZW50cyByZXBlYXRzIHdoZW4gc2tpcHBpbmcpXG4gIHNodWZmbGVkRmlsdGVyZWRTY2VuZXM6IFNjZW5lW107XG4gIHNodWZmbGVJbmRleDogbnVtYmVyO1xuICBzaHVmZmxlRmlsdGVyS2V5OiBzdHJpbmcgfCBudWxsO1xuICAvLyBTY2VuZSBjYWNoZSAobWVtb3J5IHRpZXIpXG4gIG1lbW9yeUNhY2hlOiBNZW1vcnlDYWNoZTtcbn1cblxuZXhwb3J0IGNvbnN0IHN0YXRlOiBCYXR0bGVTdGF0ZSA9IHtcbiAgY3VycmVudFBhaXI6IHsgbGVmdDogbnVsbCwgcmlnaHQ6IG51bGwgfSxcbiAgY3VycmVudFJhbmtzOiB7IGxlZnQ6IG51bGwsIHJpZ2h0OiBudWxsIH0sXG4gIGN1cnJlbnRNb2RlOiBcInN3aXNzXCIsXG4gIGNoYW1waW9uU2NlbmU6IG51bGwsXG4gIGNoYW1waW9uV2luczogMCxcbiAgY2hhbXBpb25EZWZlYXRlZDogW10sXG4gIHBsYWNlbWVudDogbnVsbCxcbiAgdG90YWxTY2VuZXNDb3VudDogMCxcbiAgbGVmdFBvb2xTaXplOiBudWxsLFxuICBkaXNhYmxlQ2hvaWNlOiBmYWxzZSxcbiAgc2F2ZWRGaWx0ZXJQYXJhbXM6IFwiXCIsXG4gIHNldHRpbmdzOiB7IC4uLkRFRkFVTFRfU0VUVElOR1MgfSxcbiAgcmVzZXR0aW5nRWxvOiBmYWxzZSxcbiAgbGVhc3RUZXN0ZWQ6IGZhbHNlLFxuICBleHBsb3JlUG9vbDogbnVsbCxcbiAgc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lczogW10sXG4gIHNodWZmbGVJbmRleDogMCxcbiAgc2h1ZmZsZUZpbHRlcktleTogbnVsbCxcbiAgbWVtb3J5Q2FjaGU6IHtcbiAgICBhbGxTY2VuZXM6IG51bGwsXG4gICAgZmlsdGVyZWRTY2VuZXM6IG51bGwsXG4gICAgZmlsdGVyS2V5OiBudWxsLFxuICAgIHRpbWVzdGFtcDogbnVsbCxcbiAgfSxcbn07XG5cbi8qKiBDbGVhciBhbnkgQ2hhbXBpb24gLyBQbGFjZW1lbnQgcnVuIGluIHByb2dyZXNzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc2V0UnVuU3RhdGUoKTogdm9pZCB7XG4gIHN0YXRlLmNoYW1waW9uU2NlbmUgPSBudWxsO1xuICBzdGF0ZS5jaGFtcGlvbldpbnMgPSAwO1xuICBzdGF0ZS5jaGFtcGlvbkRlZmVhdGVkID0gW107XG4gIHN0YXRlLnBsYWNlbWVudCA9IG51bGw7XG59XG5cbi8qKiBGb3JnZXQgdGhlIGxlZnQtc2lkZSBzaHVmZmxlIHNvIHRoZSBuZXh0IHBpY2sgcmVzaHVmZmxlcyBmcm9tIGEgZnJlc2ggcG9vbC4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNldFNodWZmbGUoKTogdm9pZCB7XG4gIHN0YXRlLnNodWZmbGVkRmlsdGVyZWRTY2VuZXMgPSBbXTtcbiAgc3RhdGUuc2h1ZmZsZUluZGV4ID0gMDtcbiAgc3RhdGUuc2h1ZmZsZUZpbHRlcktleSA9IG51bGw7XG59XG5cbi8qKiBUcnVlIHdoaWxlIGEgQ2hhbXBpb24gLyBQbGFjZW1lbnQgcnVuIGlzIHVuZGVyIHdheSAoc2tpcCBpcyBkaXNhYmxlZCkuICovXG5leHBvcnQgZnVuY3Rpb24gaXNSdW5BY3RpdmUoKTogYm9vbGVhbiB7XG4gIHN3aXRjaCAoc3RhdGUuY3VycmVudE1vZGUpIHtcbiAgICBjYXNlIFwiY2hhbXBpb25cIjpcbiAgICAgIHJldHVybiBzdGF0ZS5jaGFtcGlvblNjZW5lICE9PSBudWxsO1xuICAgIGNhc2UgXCJwbGFjZW1lbnRcIjpcbiAgICAgIHJldHVybiAoc3RhdGUucGxhY2VtZW50Py5iYXR0bGVzID8/IDApID4gMDtcbiAgICBkZWZhdWx0OlxuICAgICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbi8qKiBFTE8gc2V0dXAgaGFzbid0IGZpbmlzaGVkIChvciBSZXNldCBFTE8gaXMgc2hvd2luZyBpdCksIHNvIGl0IHNob3dzIGluc3RlYWQgb2YgbG9hZGluZyBwYWlycy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc0Vsb1NldHVwUGVuZGluZygpOiBib29sZWFuIHtcbiAgcmV0dXJuICFzdGF0ZS5zZXR0aW5ncy5lbG9TZXR1cEF0IHx8IHN0YXRlLnJlc2V0dGluZ0Vsbztcbn1cbiIsICIvLyBTY2VuZSBjYWNoZTogSW5kZXhlZERCIChkdXJhYmxlKSArIGluLW1lbW9yeSAocGVyIHNlc3Npb24pLCBzdGFsZS13aGlsZS1yZXZhbGlkYXRlLlxyXG5cclxuaW1wb3J0IHtcclxuICBDQUNIRV9EQl9OQU1FLFxyXG4gIENBQ0hFX0RCX1ZFUlNJT04sXHJcbiAgQ0FDSEVfTUFYX0FHRV9NUyxcclxuICBDQUNIRV9TVE9SRV9OQU1FLFxyXG59IGZyb20gXCIuL2NvbnN0YW50c1wiO1xyXG5pbXBvcnQgeyBnZXRGaW5kRmlsdGVyLCB0eXBlIExpc3RGaWx0ZXJzIH0gZnJvbSBcIi4vZmlsdGVyc1wiO1xyXG5pbXBvcnQgeyBGSU5EX1NDRU5FU19RVUVSWSwgZ3JhcGhxbFF1ZXJ5IH0gZnJvbSBcIi4vZ3JhcGhxbFwiO1xyXG5pbXBvcnQgeyBlbG9GaWVsZHMsIGVsb0luc2VydGlvbkluZGV4LCBzb3J0QnlFbG8sIHdpdGhFbG9GaWVsZHMgfSBmcm9tIFwiLi9zY29yZVwiO1xyXG5pbXBvcnQgeyBzdGF0ZSB9IGZyb20gXCIuL3N0YXRlXCI7XHJcbmltcG9ydCB0eXBlIHsgQ2FjaGVFbnRyeSwgRWxvRmllbGRzLCBGaW5kU2NlbmVzUmVzdWx0LCBTY2VuZSB9IGZyb20gXCIuL3R5cGVzXCI7XHJcblxyXG4vLyBPcGVuIEluZGV4ZWREQiBkYXRhYmFzZVxyXG5mdW5jdGlvbiBvcGVuQ2FjaGVEQigpOiBQcm9taXNlPElEQkRhdGFiYXNlPiB7XHJcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcclxuICAgIGNvbnN0IHJlcXVlc3QgPSBpbmRleGVkREIub3BlbihDQUNIRV9EQl9OQU1FLCBDQUNIRV9EQl9WRVJTSU9OKTtcclxuXHJcbiAgICByZXF1ZXN0Lm9uZXJyb3IgPSAoKSA9PiB7XHJcbiAgICAgIGNvbnNvbGUuZXJyb3IoXCJbU3Rhc2ggQmF0dGxlXSBJbmRleGVkREIgZXJyb3I6XCIsIHJlcXVlc3QuZXJyb3IpO1xyXG4gICAgICByZWplY3QocmVxdWVzdC5lcnJvcik7XHJcbiAgICB9O1xyXG5cclxuICAgIHJlcXVlc3Qub25zdWNjZXNzID0gKCkgPT4ge1xyXG4gICAgICByZXNvbHZlKHJlcXVlc3QucmVzdWx0KTtcclxuICAgIH07XHJcblxyXG4gICAgcmVxdWVzdC5vbnVwZ3JhZGVuZWVkZWQgPSAoZXZlbnQpID0+IHtcclxuICAgICAgY29uc3QgZGIgPSAoZXZlbnQudGFyZ2V0IGFzIElEQk9wZW5EQlJlcXVlc3QpLnJlc3VsdDtcclxuICAgICAgLy8gQW55IG9sZGVyIHN0b3JlIGhvbGRzIHNjZW5lcyB3aXRob3V0IEVMTyAob3IgaW4gcmF0aW5nIG9yZGVyKTogc3RhcnQgaXQgb3ZlclxyXG4gICAgICBpZiAoZGIub2JqZWN0U3RvcmVOYW1lcy5jb250YWlucyhDQUNIRV9TVE9SRV9OQU1FKSkgZGIuZGVsZXRlT2JqZWN0U3RvcmUoQ0FDSEVfU1RPUkVfTkFNRSk7XHJcbiAgICAgIGRiLmNyZWF0ZU9iamVjdFN0b3JlKENBQ0hFX1NUT1JFX05BTUUsIHsga2V5UGF0aDogXCJjYWNoZUtleVwiIH0pO1xyXG4gICAgfTtcclxuICB9KTtcclxufVxyXG5cclxuLy8gR2V0IGNhY2hlZCBzY2VuZXMgZnJvbSBJbmRleGVkREJcclxuYXN5bmMgZnVuY3Rpb24gZ2V0Q2FjaGVkU2NlbmVzKGNhY2hlS2V5OiBzdHJpbmcpOiBQcm9taXNlPENhY2hlRW50cnkgfCBudWxsPiB7XHJcbiAgdHJ5IHtcclxuICAgIGNvbnN0IGRiID0gYXdhaXQgb3BlbkNhY2hlREIoKTtcclxuICAgIHJldHVybiBuZXcgUHJvbWlzZTxDYWNoZUVudHJ5IHwgbnVsbD4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xyXG4gICAgICBjb25zdCB0cmFuc2FjdGlvbiA9IGRiLnRyYW5zYWN0aW9uKENBQ0hFX1NUT1JFX05BTUUsIFwicmVhZG9ubHlcIik7XHJcbiAgICAgIGNvbnN0IHN0b3JlID0gdHJhbnNhY3Rpb24ub2JqZWN0U3RvcmUoQ0FDSEVfU1RPUkVfTkFNRSk7XHJcbiAgICAgIGNvbnN0IHJlcXVlc3QgPSBzdG9yZS5nZXQoY2FjaGVLZXkpO1xyXG5cclxuICAgICAgcmVxdWVzdC5vbnN1Y2Nlc3MgPSAoKSA9PiB7XHJcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gcmVxdWVzdC5yZXN1bHQgYXMgQ2FjaGVFbnRyeSB8IHVuZGVmaW5lZDtcclxuICAgICAgICBpZiAocmVzdWx0ICYmIERhdGUubm93KCkgLSByZXN1bHQudGltZXN0YW1wIDwgQ0FDSEVfTUFYX0FHRV9NUykge1xyXG4gICAgICAgICAgcmVzb2x2ZShyZXN1bHQpO1xyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICByZXNvbHZlKG51bGwpOyAvLyBDYWNoZSBtaXNzIG9yIGV4cGlyZWRcclxuICAgICAgICB9XHJcbiAgICAgIH07XHJcblxyXG4gICAgICByZXF1ZXN0Lm9uZXJyb3IgPSAoKSA9PiByZWplY3QocmVxdWVzdC5lcnJvcik7XHJcbiAgICAgIHRyYW5zYWN0aW9uLm9uY29tcGxldGUgPSAoKSA9PiBkYi5jbG9zZSgpO1xyXG4gICAgfSk7XHJcbiAgfSBjYXRjaCAoZSkge1xyXG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIENhY2hlIHJlYWQgZXJyb3I6XCIsIGUpO1xyXG4gICAgcmV0dXJuIG51bGw7XHJcbiAgfVxyXG59XHJcblxyXG4vLyBTdG9yZSBzY2VuZXMgaW4gSW5kZXhlZERCXHJcbmFzeW5jIGZ1bmN0aW9uIHNldENhY2hlZFNjZW5lcyhcclxuICBjYWNoZUtleTogc3RyaW5nLFxyXG4gIHNjZW5lczogU2NlbmVbXSxcclxuICBjb3VudDogbnVtYmVyLFxyXG4gIGZpbHRlcktleT86IHN0cmluZyxcclxuICB0aW1lc3RhbXA6IG51bWJlciA9IERhdGUubm93KCksXHJcbik6IFByb21pc2U8dm9pZD4ge1xyXG4gIHRyeSB7XHJcbiAgICBjb25zdCBkYiA9IGF3YWl0IG9wZW5DYWNoZURCKCk7XHJcbiAgICByZXR1cm4gbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xyXG4gICAgICBjb25zdCB0cmFuc2FjdGlvbiA9IGRiLnRyYW5zYWN0aW9uKENBQ0hFX1NUT1JFX05BTUUsIFwicmVhZHdyaXRlXCIpO1xyXG4gICAgICBjb25zdCBzdG9yZSA9IHRyYW5zYWN0aW9uLm9iamVjdFN0b3JlKENBQ0hFX1NUT1JFX05BTUUpO1xyXG5cclxuICAgICAgY29uc3QgZGF0YTogQ2FjaGVFbnRyeSA9IHtcclxuICAgICAgICBjYWNoZUtleSxcclxuICAgICAgICBzY2VuZXMsXHJcbiAgICAgICAgY291bnQsXHJcbiAgICAgICAgdGltZXN0YW1wLFxyXG4gICAgICAgIC4uLihmaWx0ZXJLZXkgIT09IHVuZGVmaW5lZCAmJiB7IGZpbHRlcktleSB9KSxcclxuICAgICAgfTtcclxuXHJcbiAgICAgIGNvbnN0IHJlcXVlc3QgPSBzdG9yZS5wdXQoZGF0YSk7XHJcbiAgICAgIHJlcXVlc3Qub25zdWNjZXNzID0gKCkgPT4gcmVzb2x2ZSgpO1xyXG4gICAgICByZXF1ZXN0Lm9uZXJyb3IgPSAoKSA9PiByZWplY3QocmVxdWVzdC5lcnJvcik7XHJcbiAgICAgIHRyYW5zYWN0aW9uLm9uY29tcGxldGUgPSAoKSA9PiBkYi5jbG9zZSgpO1xyXG4gICAgfSk7XHJcbiAgfSBjYXRjaCAoZSkge1xyXG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIENhY2hlIHdyaXRlIGVycm9yOlwiLCBlKTtcclxuICB9XHJcbn1cclxuXHJcbi8vIENsZWFyIGFsbCBjYWNoZWQgc2NlbmVzIChmb3IgbWFudWFsIHJlZnJlc2gpXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjbGVhclNjZW5lQ2FjaGUoKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgdHJ5IHtcclxuICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+Xke+4jyBDbGVhcmluZyBhbGwgc2NlbmUgY2FjaGVzLi4uXCIpO1xyXG4gICAgY29uc3QgZGIgPSBhd2FpdCBvcGVuQ2FjaGVEQigpO1xyXG4gICAgcmV0dXJuIG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcclxuICAgICAgY29uc3QgdHJhbnNhY3Rpb24gPSBkYi50cmFuc2FjdGlvbihDQUNIRV9TVE9SRV9OQU1FLCBcInJlYWR3cml0ZVwiKTtcclxuICAgICAgY29uc3Qgc3RvcmUgPSB0cmFuc2FjdGlvbi5vYmplY3RTdG9yZShDQUNIRV9TVE9SRV9OQU1FKTtcclxuICAgICAgY29uc3QgcmVxdWVzdCA9IHN0b3JlLmNsZWFyKCk7XHJcblxyXG4gICAgICByZXF1ZXN0Lm9uc3VjY2VzcyA9ICgpID0+IHtcclxuICAgICAgICBzdGF0ZS5tZW1vcnlDYWNoZSA9IHsgYWxsU2NlbmVzOiBudWxsLCBmaWx0ZXJlZFNjZW5lczogbnVsbCwgZmlsdGVyS2V5OiBudWxsLCB0aW1lc3RhbXA6IG51bGwgfTtcclxuICAgICAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIOKchSBBbGwgY2FjaGVzIGNsZWFyZWQgKG1lbW9yeSArIEluZGV4ZWREQilcIik7XHJcbiAgICAgICAgcmVzb2x2ZSgpO1xyXG4gICAgICB9O1xyXG4gICAgICByZXF1ZXN0Lm9uZXJyb3IgPSAoKSA9PiByZWplY3QocmVxdWVzdC5lcnJvcik7XHJcbiAgICAgIHRyYW5zYWN0aW9uLm9uY29tcGxldGUgPSAoKSA9PiBkYi5jbG9zZSgpO1xyXG4gICAgfSk7XHJcbiAgfSBjYXRjaCAoZSkge1xyXG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIOKdjCBDYWNoZSBjbGVhciBlcnJvcjpcIiwgZSk7XHJcbiAgfVxyXG59XHJcblxyXG4vLyBDbGVhciBqdXN0IHRoZSBmaWx0ZXJlZCBzY2VuZXMgY2FjaGUgKGZvciBhdXRvLXJlZnJlc2ggYWZ0ZXIgcG9vbCBleGhhdXN0aW9uKVxyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY2xlYXJGaWx0ZXJlZENhY2hlKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gIHRyeSB7XHJcbiAgICBjb25zdCBkYiA9IGF3YWl0IG9wZW5DYWNoZURCKCk7XHJcbiAgICByZXR1cm4gbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xyXG4gICAgICBjb25zdCB0cmFuc2FjdGlvbiA9IGRiLnRyYW5zYWN0aW9uKENBQ0hFX1NUT1JFX05BTUUsIFwicmVhZHdyaXRlXCIpO1xyXG4gICAgICBjb25zdCBzdG9yZSA9IHRyYW5zYWN0aW9uLm9iamVjdFN0b3JlKENBQ0hFX1NUT1JFX05BTUUpO1xyXG4gICAgICBjb25zdCByZXF1ZXN0ID0gc3RvcmUuZGVsZXRlKFwiZmlsdGVyZWQtc2NlbmVzXCIpO1xyXG5cclxuICAgICAgcmVxdWVzdC5vbnN1Y2Nlc3MgPSAoKSA9PiB7XHJcbiAgICAgICAgc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXMgPSBudWxsO1xyXG4gICAgICAgIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcktleSA9IG51bGw7XHJcbiAgICAgICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5eR77iPIEZpbHRlcmVkIGNhY2hlIGNsZWFyZWQgKG1lbW9yeSArIEluZGV4ZWREQilcIik7XHJcbiAgICAgICAgcmVzb2x2ZSgpO1xyXG4gICAgICB9O1xyXG4gICAgICByZXF1ZXN0Lm9uZXJyb3IgPSAoKSA9PiByZWplY3QocmVxdWVzdC5lcnJvcik7XHJcbiAgICAgIHRyYW5zYWN0aW9uLm9uY29tcGxldGUgPSAoKSA9PiBkYi5jbG9zZSgpO1xyXG4gICAgfSk7XHJcbiAgfSBjYXRjaCAoZSkge1xyXG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIOKdjCBGaWx0ZXJlZCBjYWNoZSBjbGVhciBlcnJvcjpcIiwgZSk7XHJcbiAgICAvLyBTdGlsbCBjbGVhciBtZW1vcnkgY2FjaGUgZXZlbiBpZiBJbmRleGVkREIgZmFpbHNcclxuICAgIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzID0gbnVsbDtcclxuICAgIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcktleSA9IG51bGw7XHJcbiAgfVxyXG59XHJcblxyXG4vLyBCYWNrZ3JvdW5kIHJlZnJlc2ggLSBmZXRjaCBmcm9tIG5ldHdvcmsgYW5kIHVwZGF0ZSBjYWNoZXMgc2lsZW50bHlcclxuYXN5bmMgZnVuY3Rpb24gYmFja2dyb3VuZFJlZnJlc2hBbGxTY2VuZXMoKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgY29uc3QgY2FjaGVLZXkgPSBcImFsbC1zY2VuZXNcIjtcclxuXHJcbiAgdHJ5IHtcclxuICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+UhCBCYWNrZ3JvdW5kIHJlZnJlc2ggc3RhcnRlZCAoYWxsIHNjZW5lcykuLi5cIik7XHJcbiAgICBjb25zdCBzdGFydFRpbWUgPSBEYXRlLm5vdygpO1xyXG5cclxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGdyYXBocWxRdWVyeTxGaW5kU2NlbmVzUmVzdWx0PihGSU5EX1NDRU5FU19RVUVSWSwge1xyXG4gICAgICBmaWx0ZXI6IHtcclxuICAgICAgICBwZXJfcGFnZTogLTEsXHJcbiAgICAgICAgc29ydDogXCJyYXRpbmdcIixcclxuICAgICAgICBkaXJlY3Rpb246IFwiREVTQ1wiLFxyXG4gICAgICB9LFxyXG4gICAgICBzY2VuZV9maWx0ZXI6IG51bGwsXHJcbiAgICB9KTtcclxuXHJcbiAgICBjb25zdCBzY2VuZXMgPSBzb3J0QnlFbG8ocmVzdWx0LmZpbmRTY2VuZXMuc2NlbmVzIHx8IFtdKTtcclxuICAgIGNvbnN0IGNvdW50ID0gcmVzdWx0LmZpbmRTY2VuZXMuY291bnQgfHwgc2NlbmVzLmxlbmd0aDtcclxuICAgIGNvbnN0IGZldGNoVGltZSA9IERhdGUubm93KCkgLSBzdGFydFRpbWU7XHJcblxyXG4gICAgY29uc3Qgb2xkQ291bnQgPSBzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXMgPyBzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXMubGVuZ3RoIDogMDtcclxuICAgIGlmIChjb3VudCAhPT0gb2xkQ291bnQpIHtcclxuICAgICAgY29uc29sZS5sb2coXHJcbiAgICAgICAgYFtTdGFzaCBCYXR0bGVdIPCfk4ogU2NlbmUgY291bnQgY2hhbmdlZDogJHtvbGRDb3VudH0g4oaSICR7Y291bnR9ICgke2NvdW50ID4gb2xkQ291bnQgPyBcIitcIiA6IFwiXCJ9JHtjb3VudCAtIG9sZENvdW50fSlgLFxyXG4gICAgICApO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIPCfk4ogU2NlbmUgY291bnQgdW5jaGFuZ2VkOiAke2NvdW50fWApO1xyXG4gICAgfVxyXG5cclxuICAgIHN0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcyA9IHNjZW5lcztcclxuICAgIHN0YXRlLm1lbW9yeUNhY2hlLnRpbWVzdGFtcCA9IERhdGUubm93KCk7XHJcbiAgICBhd2FpdCBzZXRDYWNoZWRTY2VuZXMoY2FjaGVLZXksIHNjZW5lcywgY291bnQpO1xyXG5cclxuICAgIGNvbnNvbGUubG9nKGBbU3Rhc2ggQmF0dGxlXSDinIUgQmFja2dyb3VuZCByZWZyZXNoIGNvbXBsZXRlOiAke3NjZW5lcy5sZW5ndGh9IHNjZW5lcyBpbiAke2ZldGNoVGltZX1tc2ApO1xyXG4gIH0gY2F0Y2ggKGUpIHtcclxuICAgIGNvbnNvbGUuZXJyb3IoXCJbU3Rhc2ggQmF0dGxlXSDinYwgQmFja2dyb3VuZCByZWZyZXNoIGZhaWxlZDpcIiwgZSk7XHJcbiAgfVxyXG59XHJcblxyXG4vLyBHZXQgYWxsIHNjZW5lcyAodXNlcyBjYWNoZSB3aXRoIHN0YWxlLXdoaWxlLXJldmFsaWRhdGUpXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXRBbGxTY2VuZXNDYWNoZWQoKTogUHJvbWlzZTx7IHNjZW5lczogU2NlbmVbXTsgY291bnQ6IG51bWJlciB9PiB7XHJcbiAgY29uc3QgY2FjaGVLZXkgPSBcImFsbC1zY2VuZXNcIjtcclxuXHJcbiAgLy8gQ2hlY2sgbWVtb3J5IGNhY2hlIGZpcnN0IC0gcmV0dXJuIGltbWVkaWF0ZWx5IGlmIGF2YWlsYWJsZVxyXG4gIGlmIChzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXMpIHtcclxuICAgIGNvbnN0IGNhY2hlQWdlID0gTWF0aC5yb3VuZCgoRGF0ZS5ub3coKSAtIChzdGF0ZS5tZW1vcnlDYWNoZS50aW1lc3RhbXAgPz8gMCkpIC8gMTAwMCk7XHJcbiAgICBjb25zdCBpc1N0YWxlID0gRGF0ZS5ub3coKSAtIChzdGF0ZS5tZW1vcnlDYWNoZS50aW1lc3RhbXAgPz8gMCkgPj0gQ0FDSEVfTUFYX0FHRV9NUztcclxuXHJcbiAgICBjb25zb2xlLmxvZyhcclxuICAgICAgYFtTdGFzaCBCYXR0bGVdIPCfkr4gTWVtb3J5IGNhY2hlIGhpdCAoYWxsIHNjZW5lcyk6ICR7c3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzLmxlbmd0aH0gc2NlbmVzLCBhZ2U6ICR7Y2FjaGVBZ2V9cyR7aXNTdGFsZSA/IFwiIFtTVEFMRV1cIiA6IFwiXCJ9YCxcclxuICAgICk7XHJcblxyXG4gICAgaWYgKGlzU3RhbGUpIHtcclxuICAgICAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIOKPsCBDYWNoZSBzdGFsZSAoPiR7Q0FDSEVfTUFYX0FHRV9NUyAvIDEwMDB9cyksIHRyaWdnZXJpbmcgYmFja2dyb3VuZCByZWZyZXNoLi4uYCk7XHJcbiAgICAgIGJhY2tncm91bmRSZWZyZXNoQWxsU2NlbmVzKCk7IC8vIERvbid0IGF3YWl0IC0gcnVucyBpbiBiYWNrZ3JvdW5kXHJcbiAgICB9XHJcbiAgICByZXR1cm4geyBzY2VuZXM6IHN0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcywgY291bnQ6IHN0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcy5sZW5ndGggfTtcclxuICB9XHJcblxyXG4gIC8vIENoZWNrIEluZGV4ZWREQiBjYWNoZSAtIHJldHVybiBpbW1lZGlhdGVseSBpZiBhdmFpbGFibGVcclxuICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCflI0gTWVtb3J5IGNhY2hlIG1pc3MsIGNoZWNraW5nIEluZGV4ZWREQi4uLlwiKTtcclxuICBjb25zdCBjYWNoZWQgPSBhd2FpdCBnZXRDYWNoZWRTY2VuZXMoY2FjaGVLZXkpO1xyXG4gIGlmIChjYWNoZWQpIHtcclxuICAgIGNvbnN0IGNhY2hlQWdlID0gTWF0aC5yb3VuZCgoRGF0ZS5ub3coKSAtIGNhY2hlZC50aW1lc3RhbXApIC8gMTAwMCk7XHJcbiAgICBjb25zdCBpc1N0YWxlID0gRGF0ZS5ub3coKSAtIGNhY2hlZC50aW1lc3RhbXAgPj0gQ0FDSEVfTUFYX0FHRV9NUztcclxuXHJcbiAgICBjb25zb2xlLmxvZyhcclxuICAgICAgYFtTdGFzaCBCYXR0bGVdIPCfkr8gSW5kZXhlZERCIGNhY2hlIGhpdCAoYWxsIHNjZW5lcyk6ICR7Y2FjaGVkLnNjZW5lcy5sZW5ndGh9IHNjZW5lcywgYWdlOiAke2NhY2hlQWdlfXMke2lzU3RhbGUgPyBcIiBbU1RBTEVdXCIgOiBcIlwifWAsXHJcbiAgICApO1xyXG5cclxuICAgIHN0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcyA9IGNhY2hlZC5zY2VuZXM7XHJcbiAgICBzdGF0ZS5tZW1vcnlDYWNoZS50aW1lc3RhbXAgPSBjYWNoZWQudGltZXN0YW1wO1xyXG5cclxuICAgIGlmIChpc1N0YWxlKSB7XHJcbiAgICAgIGNvbnNvbGUubG9nKGBbU3Rhc2ggQmF0dGxlXSDij7AgQ2FjaGUgc3RhbGUgKD4ke0NBQ0hFX01BWF9BR0VfTVMgLyAxMDAwfXMpLCB0cmlnZ2VyaW5nIGJhY2tncm91bmQgcmVmcmVzaC4uLmApO1xyXG4gICAgICBiYWNrZ3JvdW5kUmVmcmVzaEFsbFNjZW5lcygpOyAvLyBEb24ndCBhd2FpdCAtIHJ1bnMgaW4gYmFja2dyb3VuZFxyXG4gICAgfVxyXG4gICAgcmV0dXJuIHsgc2NlbmVzOiBjYWNoZWQuc2NlbmVzLCBjb3VudDogY2FjaGVkLmNvdW50IH07XHJcbiAgfVxyXG5cclxuICAvLyBObyBjYWNoZSBhdCBhbGwgLSBtdXN0IGZldGNoIGZyb20gbmV0d29yayAoYmxvY2tpbmcpXHJcbiAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn4yQIE5vIGNhY2hlIGZvdW5kLCBmZXRjaGluZyBhbGwgc2NlbmVzIGZyb20gbmV0d29yayAoZmlyc3QgbG9hZCkuLi5cIik7XHJcbiAgY29uc3Qgc3RhcnRUaW1lID0gRGF0ZS5ub3coKTtcclxuXHJcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZ3JhcGhxbFF1ZXJ5PEZpbmRTY2VuZXNSZXN1bHQ+KEZJTkRfU0NFTkVTX1FVRVJZLCB7XHJcbiAgICBmaWx0ZXI6IHtcclxuICAgICAgcGVyX3BhZ2U6IC0xLFxyXG4gICAgICBzb3J0OiBcInJhdGluZ1wiLFxyXG4gICAgICBkaXJlY3Rpb246IFwiREVTQ1wiLFxyXG4gICAgfSxcclxuICAgIHNjZW5lX2ZpbHRlcjogbnVsbCxcclxuICB9KTtcclxuXHJcbiAgY29uc3Qgc2NlbmVzID0gc29ydEJ5RWxvKHJlc3VsdC5maW5kU2NlbmVzLnNjZW5lcyB8fCBbXSk7XHJcbiAgY29uc3QgY291bnQgPSByZXN1bHQuZmluZFNjZW5lcy5jb3VudCB8fCBzY2VuZXMubGVuZ3RoO1xyXG4gIGNvbnN0IGZldGNoVGltZSA9IERhdGUubm93KCkgLSBzdGFydFRpbWU7XHJcblxyXG4gIHN0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcyA9IHNjZW5lcztcclxuICBzdGF0ZS5tZW1vcnlDYWNoZS50aW1lc3RhbXAgPSBEYXRlLm5vdygpO1xyXG4gIGF3YWl0IHNldENhY2hlZFNjZW5lcyhjYWNoZUtleSwgc2NlbmVzLCBjb3VudCk7XHJcblxyXG4gIGNvbnNvbGUubG9nKGBbU3Rhc2ggQmF0dGxlXSDinIUgRmV0Y2hlZCBhbmQgY2FjaGVkICR7c2NlbmVzLmxlbmd0aH0gc2NlbmVzIGluICR7ZmV0Y2hUaW1lfW1zYCk7XHJcbiAgcmV0dXJuIHsgc2NlbmVzLCBjb3VudCB9O1xyXG59XHJcblxyXG4vLyBCYWNrZ3JvdW5kIHJlZnJlc2ggZm9yIGZpbHRlcmVkIHNjZW5lc1xyXG5hc3luYyBmdW5jdGlvbiBiYWNrZ3JvdW5kUmVmcmVzaEZpbHRlcmVkU2NlbmVzKGZpbHRlcnM6IExpc3RGaWx0ZXJzKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgY29uc3QgY2FjaGVLZXkgPSBcImZpbHRlcmVkLXNjZW5lc1wiO1xyXG5cclxuICB0cnkge1xyXG4gICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5SEIEJhY2tncm91bmQgcmVmcmVzaCBzdGFydGVkIChmaWx0ZXJlZCBzY2VuZXMpLi4uXCIpO1xyXG4gICAgY29uc3Qgc3RhcnRUaW1lID0gRGF0ZS5ub3coKTtcclxuXHJcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBncmFwaHFsUXVlcnk8RmluZFNjZW5lc1Jlc3VsdD4oRklORF9TQ0VORVNfUVVFUlksIHtcclxuICAgICAgZmlsdGVyOiBnZXRGaW5kRmlsdGVyKHtcclxuICAgICAgICBwZXJfcGFnZTogLTEsXHJcbiAgICAgICAgc29ydDogXCJyYXRpbmdcIixcclxuICAgICAgICBkaXJlY3Rpb246IFwiREVTQ1wiLFxyXG4gICAgICB9KSxcclxuICAgICAgc2NlbmVfZmlsdGVyOiBmaWx0ZXJzLnNjZW5lRmlsdGVyLFxyXG4gICAgfSk7XHJcblxyXG4gICAgY29uc3Qgc2NlbmVzID0gc29ydEJ5RWxvKHJlc3VsdC5maW5kU2NlbmVzLnNjZW5lcyB8fCBbXSk7XHJcbiAgICBjb25zdCBjb3VudCA9IHJlc3VsdC5maW5kU2NlbmVzLmNvdW50IHx8IHNjZW5lcy5sZW5ndGg7XHJcbiAgICBjb25zdCBmZXRjaFRpbWUgPSBEYXRlLm5vdygpIC0gc3RhcnRUaW1lO1xyXG5cclxuICAgIC8vIE9ubHkgdXBkYXRlIGlmIHN0aWxsIG9uIHNhbWUgZmlsdGVyXHJcbiAgICBpZiAoc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyS2V5ID09PSBmaWx0ZXJzLmZpbHRlcktleSkge1xyXG4gICAgICBjb25zdCBvbGRDb3VudCA9IHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzID8gc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXMubGVuZ3RoIDogMDtcclxuICAgICAgaWYgKGNvdW50ICE9PSBvbGRDb3VudCkge1xyXG4gICAgICAgIGNvbnNvbGUubG9nKFxyXG4gICAgICAgICAgYFtTdGFzaCBCYXR0bGVdIPCfk4ogRmlsdGVyZWQgY291bnQgY2hhbmdlZDogJHtvbGRDb3VudH0g4oaSICR7Y291bnR9ICgke2NvdW50ID4gb2xkQ291bnQgPyBcIitcIiA6IFwiXCJ9JHtjb3VudCAtIG9sZENvdW50fSlgLFxyXG4gICAgICAgICk7XHJcbiAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIPCfk4ogRmlsdGVyZWQgY291bnQgdW5jaGFuZ2VkOiAke2NvdW50fWApO1xyXG4gICAgICB9XHJcblxyXG4gICAgICBzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJlZFNjZW5lcyA9IHNjZW5lcztcclxuICAgICAgc3RhdGUubWVtb3J5Q2FjaGUudGltZXN0YW1wID0gRGF0ZS5ub3coKTtcclxuICAgICAgYXdhaXQgc2V0Q2FjaGVkU2NlbmVzKGNhY2hlS2V5LCBzY2VuZXMsIGNvdW50LCBmaWx0ZXJzLmZpbHRlcktleSk7XHJcblxyXG4gICAgICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g4pyFIEJhY2tncm91bmQgcmVmcmVzaCBjb21wbGV0ZTogJHtzY2VuZXMubGVuZ3RofSBmaWx0ZXJlZCBzY2VuZXMgaW4gJHtmZXRjaFRpbWV9bXNgKTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g4pqg77iPIEZpbHRlciBjaGFuZ2VkIGR1cmluZyByZWZyZXNoLCBkaXNjYXJkaW5nIHJlc3VsdHNcIik7XHJcbiAgICB9XHJcbiAgfSBjYXRjaCAoZSkge1xyXG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIOKdjCBCYWNrZ3JvdW5kIHJlZnJlc2ggKGZpbHRlcmVkKSBmYWlsZWQ6XCIsIGUpO1xyXG4gIH1cclxufVxyXG5cclxuLy8gR2V0IGZpbHRlcmVkIHNjZW5lcyAodXNlcyBjYWNoZSB3aXRoIHN0YWxlLXdoaWxlLXJldmFsaWRhdGUpXHJcbi8vIE5PVEU6IE9ubHkgT05FIGZpbHRlcmVkIGNhY2hlIGlzIGtlcHQgKG92ZXJ3cml0ZXMgcHJldmlvdXMgZmlsdGVyIGNhY2hlIHRvIHByZXZlbnQgSW5kZXhlZERCIGJsb2F0KVxyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ2V0RmlsdGVyZWRTY2VuZXNDYWNoZWQoXHJcbiAgZmlsdGVyczogTGlzdEZpbHRlcnMsXHJcbik6IFByb21pc2U8eyBzY2VuZXM6IFNjZW5lW107IGNvdW50OiBudW1iZXIgfT4ge1xyXG4gIGNvbnN0IHsgZmlsdGVyS2V5LCBzY2VuZUZpbHRlciB9ID0gZmlsdGVycztcclxuICBjb25zdCBjYWNoZUtleSA9IFwiZmlsdGVyZWQtc2NlbmVzXCI7IC8vIFNpbmdsZSBrZXkgLSBvdmVyd3JpdGVzIHByZXZpb3VzIGZpbHRlciBjYWNoZVxyXG5cclxuICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCflI4gRmlsdGVyIGFjdGl2ZSwgY2hlY2tpbmcgZmlsdGVyZWQgY2FjaGUuLi5cIik7XHJcblxyXG4gIC8vIENoZWNrIG1lbW9yeSBjYWNoZSBmaXJzdCAtIHJldHVybiBpbW1lZGlhdGVseSBpZiBhdmFpbGFibGUgYW5kIHNhbWUgZmlsdGVyXHJcbiAgaWYgKHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzICYmIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcktleSA9PT0gZmlsdGVyS2V5KSB7XHJcbiAgICBjb25zdCBjYWNoZUFnZSA9IE1hdGgucm91bmQoKERhdGUubm93KCkgLSAoc3RhdGUubWVtb3J5Q2FjaGUudGltZXN0YW1wID8/IDApKSAvIDEwMDApO1xyXG4gICAgY29uc3QgaXNTdGFsZSA9IERhdGUubm93KCkgLSAoc3RhdGUubWVtb3J5Q2FjaGUudGltZXN0YW1wID8/IDApID49IENBQ0hFX01BWF9BR0VfTVM7XHJcblxyXG4gICAgY29uc29sZS5sb2coXHJcbiAgICAgIGBbU3Rhc2ggQmF0dGxlXSDwn5K+IE1lbW9yeSBjYWNoZSBoaXQgKGZpbHRlcmVkKTogJHtzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJlZFNjZW5lcy5sZW5ndGh9IHNjZW5lcywgYWdlOiAke2NhY2hlQWdlfXMke2lzU3RhbGUgPyBcIiBbU1RBTEVdXCIgOiBcIlwifWAsXHJcbiAgICApO1xyXG5cclxuICAgIGlmIChpc1N0YWxlKSB7XHJcbiAgICAgIGNvbnNvbGUubG9nKGBbU3Rhc2ggQmF0dGxlXSDij7AgQ2FjaGUgc3RhbGUgKD4ke0NBQ0hFX01BWF9BR0VfTVMgLyAxMDAwfXMpLCB0cmlnZ2VyaW5nIGJhY2tncm91bmQgcmVmcmVzaC4uLmApO1xyXG4gICAgICBiYWNrZ3JvdW5kUmVmcmVzaEZpbHRlcmVkU2NlbmVzKGZpbHRlcnMpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHsgc2NlbmVzOiBzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJlZFNjZW5lcywgY291bnQ6IHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzLmxlbmd0aCB9O1xyXG4gIH1cclxuXHJcbiAgLy8gQ2hlY2sgSW5kZXhlZERCIGNhY2hlIChvbmx5IGlmIGZpbHRlciBrZXkgbWF0Y2hlcylcclxuICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCflI0gTWVtb3J5IGNhY2hlIG1pc3MgKGZpbHRlcmVkKSwgY2hlY2tpbmcgSW5kZXhlZERCLi4uXCIpO1xyXG4gIGNvbnN0IGNhY2hlZCA9IGF3YWl0IGdldENhY2hlZFNjZW5lcyhjYWNoZUtleSk7XHJcbiAgaWYgKGNhY2hlZCAmJiBjYWNoZWQuZmlsdGVyS2V5ID09PSBmaWx0ZXJLZXkpIHtcclxuICAgIGNvbnN0IGNhY2hlQWdlID0gTWF0aC5yb3VuZCgoRGF0ZS5ub3coKSAtIGNhY2hlZC50aW1lc3RhbXApIC8gMTAwMCk7XHJcbiAgICBjb25zdCBpc1N0YWxlID0gRGF0ZS5ub3coKSAtIGNhY2hlZC50aW1lc3RhbXAgPj0gQ0FDSEVfTUFYX0FHRV9NUztcclxuXHJcbiAgICBjb25zb2xlLmxvZyhcclxuICAgICAgYFtTdGFzaCBCYXR0bGVdIPCfkr8gSW5kZXhlZERCIGNhY2hlIGhpdCAoZmlsdGVyZWQpOiAke2NhY2hlZC5zY2VuZXMubGVuZ3RofSBzY2VuZXMsIGFnZTogJHtjYWNoZUFnZX1zJHtpc1N0YWxlID8gXCIgW1NUQUxFXVwiIDogXCJcIn1gLFxyXG4gICAgKTtcclxuXHJcbiAgICBzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJlZFNjZW5lcyA9IGNhY2hlZC5zY2VuZXM7XHJcbiAgICBzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJLZXkgPSBmaWx0ZXJLZXk7XHJcbiAgICBzdGF0ZS5tZW1vcnlDYWNoZS50aW1lc3RhbXAgPSBjYWNoZWQudGltZXN0YW1wO1xyXG5cclxuICAgIGlmIChpc1N0YWxlKSB7XHJcbiAgICAgIGNvbnNvbGUubG9nKGBbU3Rhc2ggQmF0dGxlXSDij7AgQ2FjaGUgc3RhbGUgKD4ke0NBQ0hFX01BWF9BR0VfTVMgLyAxMDAwfXMpLCB0cmlnZ2VyaW5nIGJhY2tncm91bmQgcmVmcmVzaC4uLmApO1xyXG4gICAgICBiYWNrZ3JvdW5kUmVmcmVzaEZpbHRlcmVkU2NlbmVzKGZpbHRlcnMpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHsgc2NlbmVzOiBjYWNoZWQuc2NlbmVzLCBjb3VudDogY2FjaGVkLmNvdW50IH07XHJcbiAgfVxyXG5cclxuICBpZiAoY2FjaGVkKSB7XHJcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCfkr8gSW5kZXhlZERCIGNhY2hlIGV4aXN0cyBidXQgZmlsdGVyIGNoYW5nZWQsIGZldGNoaW5nIG5ldyBkYXRhLi4uXCIpO1xyXG4gIH0gZWxzZSB7XHJcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCfkr8gSW5kZXhlZERCIGNhY2hlIG1pc3MgKGZpbHRlcmVkKVwiKTtcclxuICB9XHJcblxyXG4gIC8vIE5vIG1hdGNoaW5nIGNhY2hlIC0gbXVzdCBmZXRjaCBmcm9tIG5ldHdvcmsgKGJsb2NraW5nKVxyXG4gIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+MkCBGZXRjaGluZyBmaWx0ZXJlZCBzY2VuZXMgZnJvbSBuZXR3b3JrLi4uXCIpO1xyXG4gIGNvbnN0IHN0YXJ0VGltZSA9IERhdGUubm93KCk7XHJcblxyXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGdyYXBocWxRdWVyeTxGaW5kU2NlbmVzUmVzdWx0PihGSU5EX1NDRU5FU19RVUVSWSwge1xyXG4gICAgZmlsdGVyOiBnZXRGaW5kRmlsdGVyKHtcclxuICAgICAgcGVyX3BhZ2U6IC0xLFxyXG4gICAgICBzb3J0OiBcInJhdGluZ1wiLFxyXG4gICAgICBkaXJlY3Rpb246IFwiREVTQ1wiLFxyXG4gICAgfSksXHJcbiAgICBzY2VuZV9maWx0ZXI6IHNjZW5lRmlsdGVyLFxyXG4gIH0pO1xyXG5cclxuICBjb25zdCBzY2VuZXMgPSBzb3J0QnlFbG8ocmVzdWx0LmZpbmRTY2VuZXMuc2NlbmVzIHx8IFtdKTtcclxuICBjb25zdCBjb3VudCA9IHJlc3VsdC5maW5kU2NlbmVzLmNvdW50IHx8IHNjZW5lcy5sZW5ndGg7XHJcbiAgY29uc3QgZmV0Y2hUaW1lID0gRGF0ZS5ub3coKSAtIHN0YXJ0VGltZTtcclxuXHJcbiAgc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXMgPSBzY2VuZXM7XHJcbiAgc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyS2V5ID0gZmlsdGVyS2V5O1xyXG4gIHN0YXRlLm1lbW9yeUNhY2hlLnRpbWVzdGFtcCA9IERhdGUubm93KCk7XHJcbiAgYXdhaXQgc2V0Q2FjaGVkU2NlbmVzKGNhY2hlS2V5LCBzY2VuZXMsIGNvdW50LCBmaWx0ZXJLZXkpO1xyXG5cclxuICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g4pyFIEZldGNoZWQgYW5kIGNhY2hlZCAke3NjZW5lcy5sZW5ndGh9IGZpbHRlcmVkIHNjZW5lcyBpbiAke2ZldGNoVGltZX1tc2ApO1xyXG4gIHJldHVybiB7IHNjZW5lcywgY291bnQgfTtcclxufVxyXG5cclxuLyoqIFNldCAob3Igd2l0aCBudWxsLCByZW1vdmUpIHRoZSBFTE8gZmllbGRzIG9uIG9uZSBzY2VuZSBvYmplY3QuICovXHJcbmZ1bmN0aW9uIGFwcGx5RWxvKHNjZW5lOiBTY2VuZSwgdmFsdWU6IEVsb0ZpZWxkcyB8IG51bGwpOiB2b2lkIHtcclxuICBzY2VuZS5jdXN0b21fZmllbGRzID0gd2l0aEVsb0ZpZWxkcyhzY2VuZS5jdXN0b21fZmllbGRzLCB2YWx1ZSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBUaGUgY2FjaGVkIGNvcHkgb2YgYSBzY2VuZSAoYWxsIHNjZW5lcyBmaXJzdCwgdGhlbiB0aGUgZmlsdGVyZWQgb25lcyksIG9yIHRoZSBzY2VuZSBpdHNlbGYgaWZcclxuICogbmVpdGhlciBoYXMgaXQuIFNjZW5lIG9iamVjdHMgaGVsZCBhY3Jvc3MgYmF0dGxlcyAodGhlIHNodWZmbGUsIGEgc2F2ZWQgcGFpciwgYSBDaGFtcGlvbiBvclxyXG4gKiBQbGFjZW1lbnQgcnVuKSBnbyBzdGFsZSBvbmNlIGEgYmFja2dyb3VuZCByZWZyZXNoIHN3YXBzIGluIG5ldyBjb3BpZXMsIHNvIGJhdHRsZSBtYXRoIHJlYWRzXHJcbiAqIEVMTyBhbmQgYmF0dGxlcyBmcm9tIHRoaXMgaW5zdGVhZC5cclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBsYXRlc3RTY2VuZShzY2VuZTogU2NlbmUpOiBTY2VuZSB7XHJcbiAgcmV0dXJuIChcclxuICAgIHN0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcz8uZmluZCgocykgPT4gcy5pZCA9PT0gc2NlbmUuaWQpID8/XHJcbiAgICBzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJlZFNjZW5lcz8uZmluZCgocykgPT4gcy5pZCA9PT0gc2NlbmUuaWQpID8/XHJcbiAgICBzY2VuZVxyXG4gICk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBTZXQgKG9yIHdpdGggbnVsbCwgcmVtb3ZlKSBhIHNjZW5lJ3MgRUxPIG9uIGBzY2VuZWAgaXRzZWxmIGFuZCBvbiBpdHMgY2FjaGVkIGNvcGllcywgYW5kIG1vdmVcclxuICogdGhlIGNhY2hlZCBjb3BpZXMgdG8gdGhlaXIgbmV3IHBsYWNlIGluIHRoZSBFTE8gb3JkZXIgc28gcmFua3Mgc3RheSByaWdodC5cclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBzZXRFbG9JbkNhY2hlKHNjZW5lOiBTY2VuZSwgdmFsdWU6IEVsb0ZpZWxkcyB8IG51bGwpOiB2b2lkIHtcclxuICBhcHBseUVsbyhzY2VuZSwgdmFsdWUpO1xyXG4gIGZvciAoY29uc3QgcG9vbCBvZiBbc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzLCBzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJlZFNjZW5lc10pIHtcclxuICAgIGNvbnN0IGlkeCA9IHBvb2wgPyBwb29sLmZpbmRJbmRleCgocykgPT4gcy5pZCA9PT0gc2NlbmUuaWQpIDogLTE7XHJcbiAgICBpZiAoIXBvb2wgfHwgaWR4ID09PSAtMSkgY29udGludWU7XHJcbiAgICBjb25zdCBbY2FjaGVkXSA9IHBvb2wuc3BsaWNlKGlkeCwgMSk7XHJcbiAgICBpZiAoY2FjaGVkICE9PSBzY2VuZSkgYXBwbHlFbG8oY2FjaGVkLCB2YWx1ZSk7XHJcbiAgICBwb29sLnNwbGljZSh2YWx1ZSA/IGVsb0luc2VydGlvbkluZGV4KHBvb2wsIHZhbHVlLmVsbykgOiBwb29sLmxlbmd0aCwgMCwgY2FjaGVkKTtcclxuICB9XHJcbiAgcGVyc2lzdENhY2hlU29vbigpO1xyXG59XHJcblxyXG4vKiogU2V0IHRoZSBTdGFzaCByYXRpbmcgb24gY2FjaGVkIHNjZW5lcyAoYWZ0ZXIgU3Rhc2ggQmF0dGxlIHdyb3RlIHRoZW0pLiBPcmRlciBpcyBFTE8sIHNvIHVuY2hhbmdlZC4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHNldFJhdGluZ3NJbkNhY2hlKHJhdGluZ3M6IE1hcDxzdHJpbmcsIG51bWJlciB8IG51bGw+KTogdm9pZCB7XHJcbiAgZm9yIChjb25zdCBwb29sIG9mIFtzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXMsIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzXSkge1xyXG4gICAgZm9yIChjb25zdCBzY2VuZSBvZiBwb29sID8/IFtdKSB7XHJcbiAgICAgIGNvbnN0IHJhdGluZyA9IHJhdGluZ3MuZ2V0KHNjZW5lLmlkKTtcclxuICAgICAgaWYgKHJhdGluZyAhPT0gdW5kZWZpbmVkKSBzY2VuZS5yYXRpbmcxMDAgPSByYXRpbmc7XHJcbiAgICB9XHJcbiAgfVxyXG4gIHBlcnNpc3RDYWNoZVNvb24oKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIEJyaW5nIGEgc2NlbmUncyBjYWNoZWQgY29waWVzIGluIGxpbmUgd2l0aCBmcmVzaCB2YWx1ZXMgZnJvbSBTdGFzaCAoaXRzIEVMTyBmaWVsZHMgYW5kIFN0YXNoXHJcbiAqIHJhdGluZyksIG1vdmluZyB0aGVtIHRvIHRoZWlyIHBsYWNlIGluIHRoZSBFTE8gb3JkZXIuIEZvciBzY2VuZXMgZmV0Y2hlZCBvbiB0aGVpciBvd24gKGFcclxuICogcmVzdG9yZWQgcGFpciwgYSBzY2VuZSBwYWdlIGJhdHRsZSksIHdoaWNoIG1heSBiZSBuZXdlciB0aGFuIHRoZSBjYWNoZTogY2hhbmdlZCBpbiBhbm90aGVyXHJcbiAqIHRhYiwgc2F5LlxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHJlZnJlc2hTY2VuZUluQ2FjaGUoZnJlc2g6IFNjZW5lKTogdm9pZCB7XHJcbiAgLy8gVGVzdCBtb2RlOiB0aGUgY2FjaGUgaG9sZHMgdGhpcyB0YWIncyB1bnNhdmVkIEVMTywgbmV3ZXIgdGhhbiB3aGF0IFN0YXNoIGhhc1xyXG4gIGlmIChzdGF0ZS5zZXR0aW5ncy50ZXN0TW9kZSAmJiBzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXM/LnNvbWUoKHMpID0+IHMuaWQgPT09IGZyZXNoLmlkKSkgcmV0dXJuO1xyXG4gIGZvciAoY29uc3QgcG9vbCBvZiBbc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzLCBzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJlZFNjZW5lc10pIHtcclxuICAgIGNvbnN0IGNhY2hlZCA9IHBvb2w/LmZpbmQoKHMpID0+IHMuaWQgPT09IGZyZXNoLmlkKTtcclxuICAgIGlmIChjYWNoZWQpIGNhY2hlZC5yYXRpbmcxMDAgPSBmcmVzaC5yYXRpbmcxMDAgPz8gbnVsbDtcclxuICB9XHJcbiAgc2V0RWxvSW5DYWNoZShmcmVzaCwgZWxvRmllbGRzKGZyZXNoKSk7XHJcbn1cclxuXHJcbi8qKiBXcml0ZSB0aGUgaW4tbWVtb3J5IHNjZW5lIGxpc3RzIGJhY2sgdG8gSW5kZXhlZERCIHRoaXMgbG9uZyBhZnRlciB0aGUgbGFzdCBjaGFuZ2UuICovXHJcbmNvbnN0IFBFUlNJU1RfREVCT1VOQ0VfTVMgPSAxMDAwO1xyXG5sZXQgcGVyc2lzdFRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xyXG5cclxuLyoqXHJcbiAqIEJhdHRsZXMgY2hhbmdlIHRoZSBpbi1tZW1vcnkgbGlzdHMgb25seTsgd2l0aG91dCB0aGlzLCBhIHJlbG9hZCB3aXRoaW4gQ0FDSEVfTUFYX0FHRV9NUyB3b3VsZFxyXG4gKiByZWFkIHRoZSBJbmRleGVkREIgY29weSBmcm9tIGJlZm9yZSB0aGVtIChvbGQgRUxPLCBvbGQgb3JkZXIpLiBEZWJvdW5jZWQsIHNvIGEgcGljaydzIHdyaXRlc1xyXG4gKiBhbmQgaXRzIFN0YXNoIHJhdGluZyBzeW5jIGFyZSBzYXZlZCB0b2dldGhlci5cclxuICovXHJcbmZ1bmN0aW9uIHBlcnNpc3RDYWNoZVNvb24oKTogdm9pZCB7XHJcbiAgLy8gVGVzdCBtb2RlJ3MgRUxPIGlzIG1hZGUgdXA6IGEgcmVsb2FkIGdvZXMgYmFjayB0byB3aGF0J3Mgc2F2ZWRcclxuICBpZiAodHlwZW9mIGluZGV4ZWREQiA9PT0gXCJ1bmRlZmluZWRcIiB8fCBzdGF0ZS5zZXR0aW5ncy50ZXN0TW9kZSkgcmV0dXJuO1xyXG4gIGlmIChwZXJzaXN0VGltZXIpIGNsZWFyVGltZW91dChwZXJzaXN0VGltZXIpO1xyXG4gIHBlcnNpc3RUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xyXG4gICAgcGVyc2lzdFRpbWVyID0gbnVsbDtcclxuICAgIHZvaWQgcGVyc2lzdENhY2hlKCk7XHJcbiAgfSwgUEVSU0lTVF9ERUJPVU5DRV9NUyk7XHJcbn1cclxuXHJcbi8qKiBTYXZlIHRoZSBpbi1tZW1vcnkgbGlzdHMgb3ZlciB0aGVpciBJbmRleGVkREIgZW50cmllcywga2VlcGluZyBlYWNoIGVudHJ5J3MgdGltZXN0YW1wLiAqL1xyXG5hc3luYyBmdW5jdGlvbiBwZXJzaXN0Q2FjaGUoKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgY29uc3QgbGlzdHM6IFtzdHJpbmcsIFNjZW5lW10gfCBudWxsXVtdID0gW1xyXG4gICAgW1wiYWxsLXNjZW5lc1wiLCBzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXNdLFxyXG4gICAgW1wiZmlsdGVyZWQtc2NlbmVzXCIsIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzXSxcclxuICBdO1xyXG4gIGZvciAoY29uc3QgW2NhY2hlS2V5LCBzY2VuZXNdIG9mIGxpc3RzKSB7XHJcbiAgICBpZiAoIXNjZW5lcykgY29udGludWU7XHJcbiAgICBjb25zdCBjYWNoZWQgPSBhd2FpdCBnZXRDYWNoZWRTY2VuZXMoY2FjaGVLZXkpO1xyXG4gICAgLy8gTWlzc2luZyBvciBleHBpcmVkOiB0aGUgbmV4dCBsb2FkIGZldGNoZXMgZnJlc2ggYW55d2F5LiBBIGRpZmZlcmVudCBmaWx0ZXI6IG5vdCB0aGlzIGxpc3QuXHJcbiAgICBpZiAoIWNhY2hlZCkgY29udGludWU7XHJcbiAgICBpZiAoY2FjaGVLZXkgPT09IFwiZmlsdGVyZWQtc2NlbmVzXCIgJiYgY2FjaGVkLmZpbHRlcktleSAhPT0gc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyS2V5KSBjb250aW51ZTtcclxuICAgIGF3YWl0IHNldENhY2hlZFNjZW5lcyhjYWNoZUtleSwgc2NlbmVzLCBzY2VuZXMubGVuZ3RoLCBjYWNoZWQuZmlsdGVyS2V5LCBjYWNoZWQudGltZXN0YW1wKTtcclxuICB9XHJcbn1cclxuXHJcbi8vIERyb3AgYSBkZWxldGVkIHNjZW5lIGZyb20gZXZlcnkgY2FjaGUgdGllciBhbmQgdGhlIGxlZnQtc2lkZSBzaHVmZmxlXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZW1vdmVTY2VuZUV2ZXJ5d2hlcmUoc2NlbmVJZDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgY29uc3Qgd2l0aG91dCA9IChzY2VuZXM6IFNjZW5lW10gfCBudWxsKTogU2NlbmVbXSB8IG51bGwgPT5cclxuICAgIHNjZW5lcyA/IHNjZW5lcy5maWx0ZXIoKHMpID0+IHMuaWQgIT09IHNjZW5lSWQpIDogc2NlbmVzO1xyXG5cclxuICBzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXMgPSB3aXRob3V0KHN0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcyk7XHJcbiAgc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXMgPSB3aXRob3V0KHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzKTtcclxuXHJcbiAgY29uc3Qgc2h1ZmZsZUlkeCA9IHN0YXRlLnNodWZmbGVkRmlsdGVyZWRTY2VuZXMuZmluZEluZGV4KChzKSA9PiBzLmlkID09PSBzY2VuZUlkKTtcclxuICBpZiAoc2h1ZmZsZUlkeCAhPT0gLTEpIHtcclxuICAgIHN0YXRlLnNodWZmbGVkRmlsdGVyZWRTY2VuZXMuc3BsaWNlKHNodWZmbGVJZHgsIDEpO1xyXG4gICAgaWYgKHNodWZmbGVJZHggPCBzdGF0ZS5zaHVmZmxlSW5kZXgpIHN0YXRlLnNodWZmbGVJbmRleC0tO1xyXG4gIH1cclxuXHJcbiAgZm9yIChjb25zdCBjYWNoZUtleSBvZiBbXCJhbGwtc2NlbmVzXCIsIFwiZmlsdGVyZWQtc2NlbmVzXCJdKSB7XHJcbiAgICBjb25zdCBjYWNoZWQgPSBhd2FpdCBnZXRDYWNoZWRTY2VuZXMoY2FjaGVLZXkpO1xyXG4gICAgaWYgKGNhY2hlZCAmJiBjYWNoZWQuc2NlbmVzLnNvbWUoKHMpID0+IHMuaWQgPT09IHNjZW5lSWQpKSB7XHJcbiAgICAgIGNvbnN0IHNjZW5lcyA9IGNhY2hlZC5zY2VuZXMuZmlsdGVyKChzKSA9PiBzLmlkICE9PSBzY2VuZUlkKTtcclxuICAgICAgLy8gS2VlcCB0aGUgb3JpZ2luYWwgdGltZXN0YW1wOiByZW1vdmluZyBvbmUgc2NlbmUgZG9lc24ndCBtYWtlIHRoZSByZXN0IGFueSBmcmVzaGVyXHJcbiAgICAgIGF3YWl0IHNldENhY2hlZFNjZW5lcyhjYWNoZUtleSwgc2NlbmVzLCBzY2VuZXMubGVuZ3RoLCBjYWNoZWQuZmlsdGVyS2V5LCBjYWNoZWQudGltZXN0YW1wKTtcclxuICAgIH1cclxuICB9XHJcbiAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIPCfl5HvuI8gUmVtb3ZlZCBzY2VuZSAke3NjZW5lSWR9IGZyb20gY2FjaGVzYCk7XHJcbn1cclxuIiwgIi8vIFNjZW5lIGxvb2t1cHMgZm9yIGRldGVjdGluZyBzY2VuZXMgZGVsZXRlZCB3aGlsZSB0aGV5IHdlcmUgaW4gYSBiYXR0bGUsIGFuZCBmb3IgYnJpbmdpbmcgYVxyXG4vLyBzYXZlZCBwYWlyJ3MgRUxPIGFuZCBTdGFzaCByYXRpbmcgdXAgdG8gZGF0ZS5cclxuXHJcbmltcG9ydCB7IGdyYXBocWxRdWVyeSB9IGZyb20gXCIuL2dyYXBocWxcIjtcclxuaW1wb3J0IHR5cGUgeyBTY2VuZSB9IGZyb20gXCIuL3R5cGVzXCI7XHJcblxyXG5leHBvcnQgdHlwZSBTY2VuZUZpZWxkcyA9IFBpY2s8U2NlbmUsIFwiaWRcIiB8IFwicmF0aW5nMTAwXCIgfCBcImN1c3RvbV9maWVsZHNcIj47XHJcblxyXG4vKipcclxuICogVGhlIGN1cnJlbnQgU3Rhc2ggcmF0aW5nIGFuZCBjdXN0b20gZmllbGRzIG9mIHRoZXNlIHNjZW5lcywgYnkgaWQ7IGlkcyB0aGF0IG5vIGxvbmdlciBleGlzdFxyXG4gKiBhcmUgbWlzc2luZy4gKGZpbmRTY2VuZXMoaWRzKSBlcnJvcnMgb24gYW55IG1pc3NpbmcgaWQsIHNvIGl0J3MgYWxpYXNlZCBmaW5kU2NlbmUgbG9va3Vwcy4pXHJcbiAqL1xyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmV0Y2hTY2VuZUZpZWxkcyhpZHM6IHN0cmluZ1tdKTogUHJvbWlzZTxNYXA8c3RyaW5nLCBTY2VuZUZpZWxkcz4+IHtcclxuICBjb25zdCBhbGlhc2VzID0gaWRzXHJcbiAgICAubWFwKChpZCwgaSkgPT4gYHMke2l9OiBmaW5kU2NlbmUoaWQ6ICR7SlNPTi5zdHJpbmdpZnkoaWQpfSkgeyBpZCByYXRpbmcxMDAgY3VzdG9tX2ZpZWxkcyB9YClcclxuICAgIC5qb2luKFwiXFxuXCIpO1xyXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGdyYXBocWxRdWVyeTxSZWNvcmQ8c3RyaW5nLCBTY2VuZUZpZWxkcyB8IG51bGw+PihgeyAke2FsaWFzZXN9IH1gKTtcclxuICByZXR1cm4gbmV3IE1hcChPYmplY3QudmFsdWVzKHJlc3VsdCkuZmxhdE1hcCgocykgPT4gKHMgPyBbW3MuaWQsIHNdIGFzIGNvbnN0XSA6IFtdKSkpO1xyXG59XHJcblxyXG4vKiogVHJ1ZSBmb3IgR3JhcGhRTCBlcnJvcnMgU3Rhc2ggcmFpc2VzIHdoZW4gYSBzY2VuZSBpZCBubyBsb25nZXIgZXhpc3RzLiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gaXNTY2VuZU5vdEZvdW5kRXJyb3IoZXJyb3I6IHVua25vd24pOiBib29sZWFuIHtcclxuICByZXR1cm4gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciAmJiAvbm90IGZvdW5kL2kudGVzdChlcnJvci5tZXNzYWdlKTtcclxufVxyXG4iLCAiLy8gSG93IHRoZSB1c2VyJ3MgU3Rhc2ggc2hvd3MgcmF0aW5ncyAoU2V0dGluZ3Mg4oaSIEludGVyZmFjZSDihpIgUmF0aW5nIHN5c3RlbSk6IHN0YXJzLCB3aXRoIGFcbi8vIHByZWNpc2lvbiwgb3IgYSAwLTEwIGRlY2ltYWwuIFN0YXNoIHN0b3JlcyAxLTEwMCBlaXRoZXIgd2F5OyBTdGFzaCBCYXR0bGUgc2hvd3MgcmF0aW5ncyB0aGVcbi8vIHdheSBTdGFzaCBkb2VzLCBzbyBhIDc0IHJlYWRzIFwiNy40XCIgb3IgXCIzLjXimIVcIiwgbmV2ZXIgXCI3NC8xMDBcIi5cblxuZXhwb3J0IGludGVyZmFjZSBSYXRpbmdTeXN0ZW0ge1xuICB0eXBlOiBcInN0YXJzXCIgfCBcImRlY2ltYWxcIjtcbiAgLyoqIFRoZSBzbWFsbGVzdCBzdGFyIHN0ZXA6IDEgKGZ1bGwpLCAwLjUsIDAuMjUgb3IgMC4xLiBVbnVzZWQgZm9yIGRlY2ltYWwuICovXG4gIHN0YXJTdGVwOiBudW1iZXI7XG59XG5cbmNvbnN0IFNUQVJfU1RFUFM6IFJlY29yZDxzdHJpbmcsIG51bWJlcj4gPSB7IGZ1bGw6IDEsIGhhbGY6IDAuNSwgcXVhcnRlcjogMC4yNSwgdGVudGg6IDAuMSB9O1xuXG4vKiogU3Rhc2gncyBvd24gZGVmYXVsdCB3aGVuIG5vdGhpbmcgaXMgc2F2ZWQ6IHdob2xlIHN0YXJzLiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfUkFUSU5HX1NZU1RFTTogUmF0aW5nU3lzdGVtID0geyB0eXBlOiBcInN0YXJzXCIsIHN0YXJTdGVwOiAxIH07XG5cbmxldCBjdXJyZW50OiBSYXRpbmdTeXN0ZW0gPSBERUZBVUxUX1JBVElOR19TWVNURU07XG5cbi8qKiBSZWFkIFN0YXNoJ3MgYGNvbmZpZ3VyYXRpb24udWlgIChpdHMgcmF0aW5nU3lzdGVtT3B0aW9ucykuIEFueXRoaW5nIHVucmVhZGFibGUgbWVhbnMgdGhlIGRlZmF1bHQuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VSYXRpbmdTeXN0ZW0odWk6IHVua25vd24pOiBSYXRpbmdTeXN0ZW0ge1xuICBjb25zdCBvcHRpb25zID0gKHVpIGFzIHsgcmF0aW5nU3lzdGVtT3B0aW9ucz86IHsgdHlwZT86IHVua25vd247IHN0YXJQcmVjaXNpb24/OiB1bmtub3duIH0gfSB8IG51bGwgfCB1bmRlZmluZWQpPy5yYXRpbmdTeXN0ZW1PcHRpb25zO1xuICByZXR1cm4ge1xuICAgIHR5cGU6IG9wdGlvbnM/LnR5cGUgPT09IFwiZGVjaW1hbFwiID8gXCJkZWNpbWFsXCIgOiBcInN0YXJzXCIsXG4gICAgc3RhclN0ZXA6IFNUQVJfU1RFUFNbU3RyaW5nKG9wdGlvbnM/LnN0YXJQcmVjaXNpb24pXSA/PyAxLFxuICB9O1xufVxuXG4vKiogUmVtZW1iZXIgdGhlIHJhdGluZyBzeXN0ZW0gZnJvbSBTdGFzaCdzIGBjb25maWd1cmF0aW9uLnVpYCAobG9hZGVkIHdpdGggdGhlIHNldHRpbmdzKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZXRSYXRpbmdTeXN0ZW0odWk6IHVua25vd24pOiB2b2lkIHtcbiAgY3VycmVudCA9IHBhcnNlUmF0aW5nU3lzdGVtKHVpKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGdldFJhdGluZ1N5c3RlbSgpOiBSYXRpbmdTeXN0ZW0ge1xuICByZXR1cm4gY3VycmVudDtcbn1cblxuLyoqIFRoZSBudW1iZXIgU3Rhc2ggc2hvd3MgZm9yIGEgMS0xMDAgcmF0aW5nOiA3NCDihpIgXCI3LjRcIiAoZGVjaW1hbCksIFwiMy41XCIgb3IgXCI0XCIgKHN0YXJzKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiByYXRpbmdWYWx1ZShyYXRpbmcxMDA6IG51bWJlciwgc3lzdGVtOiBSYXRpbmdTeXN0ZW0gPSBjdXJyZW50KTogc3RyaW5nIHtcbiAgaWYgKHN5c3RlbS50eXBlID09PSBcImRlY2ltYWxcIikgcmV0dXJuIChNYXRoLnJvdW5kKHJhdGluZzEwMCkgLyAxMCkudG9GaXhlZCgxKTtcbiAgLy8gTmV2ZXIgMCBzdGFycyBmb3IgYSByYXRpbmcgdGhhdCdzIHNldDogdGhlIGxvd2VzdCBpcyBvbmUgc3RlcFxuICBjb25zdCBzdGFycyA9IE1hdGgubWF4KHN5c3RlbS5zdGFyU3RlcCwgTWF0aC5yb3VuZChyYXRpbmcxMDAgLyAyMCAvIHN5c3RlbS5zdGFyU3RlcCkgKiBzeXN0ZW0uc3RhclN0ZXApO1xuICByZXR1cm4gU3RyaW5nKE51bWJlcihzdGFycy50b0ZpeGVkKDIpKSk7XG59XG5cbi8qKiBBIHJhdGluZyBhcyBTdGFzaCBzaG93cyBpdDogXCI3LjRcIiBvciBcIjMuNeKYhVwiOyBgbG9uZ2Agc3BlbGxzIHN0YXJzIG91dCAoXCIzLjUgc3RhcnNcIikuICovXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0UmF0aW5nKHJhdGluZzEwMDogbnVtYmVyLCBsb25nID0gZmFsc2UsIHN5c3RlbTogUmF0aW5nU3lzdGVtID0gY3VycmVudCk6IHN0cmluZyB7XG4gIGNvbnN0IHZhbHVlID0gcmF0aW5nVmFsdWUocmF0aW5nMTAwLCBzeXN0ZW0pO1xuICBpZiAoc3lzdGVtLnR5cGUgPT09IFwiZGVjaW1hbFwiKSByZXR1cm4gdmFsdWU7XG4gIHJldHVybiBsb25nID8gYCR7dmFsdWV9IHN0YXIke3ZhbHVlID09PSBcIjFcIiA/IFwiXCIgOiBcInNcIn1gIDogYCR7dmFsdWV94piFYDtcbn1cblxuLyoqIFwiYSA1LjAgc3RhcnRzXCIgLyBcIjIuNSBzdGFycyBzdGFydFwiOiBhIHJhdGluZyBhcyB0aGUgc3ViamVjdCBvZiBhIHNlbnRlbmNlLCB3aXRoIGl0cyB2ZXJiLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJhdGluZ1N0YXJ0cyhyYXRpbmcxMDA6IG51bWJlciwgc3lzdGVtOiBSYXRpbmdTeXN0ZW0gPSBjdXJyZW50KTogc3RyaW5nIHtcbiAgaWYgKHN5c3RlbS50eXBlID09PSBcImRlY2ltYWxcIikgcmV0dXJuIGBhICR7cmF0aW5nVmFsdWUocmF0aW5nMTAwLCBzeXN0ZW0pfSBzdGFydHNgO1xuICBjb25zdCB0ZXh0ID0gZm9ybWF0UmF0aW5nKHJhdGluZzEwMCwgdHJ1ZSwgc3lzdGVtKTtcbiAgcmV0dXJuIGAke3RleHR9ICR7dGV4dC5lbmRzV2l0aChcInN0YXJzXCIpID8gXCJzdGFydFwiIDogXCJzdGFydHNcIn1gO1xufVxuXG4vKiogV2hlcmUgdGhlIFN0YXRzIGNoYXJ0IG1hcmtzIFN0YXNoIHJhdGluZ3M6IDAuMSAvIDIuNSAvIDUuMCAvIDcuNSAvIDEwLjAsIG9yIDEtNSBzdGFycy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzY2FsZU1hcmtzKHN5c3RlbTogUmF0aW5nU3lzdGVtID0gY3VycmVudCk6IG51bWJlcltdIHtcbiAgcmV0dXJuIHN5c3RlbS50eXBlID09PSBcImRlY2ltYWxcIiA/IFsxLCAyNSwgNTAsIDc1LCAxMDBdIDogWzEsIDQwLCA2MCwgODAsIDEwMF07XG59XG5cbi8qKlxuICogQSAxLTEwMCByYXRpbmcgbmVhciBgcmF0aW5nMTAwYCAoYXQgb3IgYmVsb3cgaXQpIHRoYXQgdGhpcyBzeXN0ZW0gY2FuIHNob3cgZXhhY3RseSwgZm9yXG4gKiBleGFtcGxlcyBpbiBkZXNjcmlwdGlvbnM6IG9uIHdob2xlIHN0YXJzIGEgNTAgKDIuNSBzdGFycykgZG9lc24ndCBleGlzdCwgc28gaXQncyA0MCAoMiBzdGFycykuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBleGFtcGxlUmF0aW5nKHJhdGluZzEwMDogbnVtYmVyLCBzeXN0ZW06IFJhdGluZ1N5c3RlbSA9IGN1cnJlbnQpOiBudW1iZXIge1xuICBpZiAoc3lzdGVtLnR5cGUgPT09IFwiZGVjaW1hbFwiKSByZXR1cm4gcmF0aW5nMTAwO1xuICBjb25zdCBncmlkID0gMjAgKiBzeXN0ZW0uc3RhclN0ZXA7XG4gIHJldHVybiBNYXRoLm1heChncmlkLCBNYXRoLmZsb29yKHJhdGluZzEwMCAvIGdyaWQpICogZ3JpZCk7XG59XG4iLCAiLy8gVXNlciBzZXR0aW5ncyBzdG9yZWQgaW4gU3Rhc2gncyBwbHVnaW4gY29uZmlndXJhdGlvbiAoY29uZmlndXJhdGlvbi5wbHVnaW5zW1wic3Rhc2gtYmF0dGxlXCJdKSxcclxuLy8gc28gdGhleSBmb2xsb3cgdGhlIHVzZXIgYWNyb3NzIGJyb3dzZXJzLiBBbHNvIGVkaXRhYmxlIGluIFN0YXNoIOKGkiBTZXR0aW5ncyDihpIgUGx1Z2lucy5cclxuXHJcbmltcG9ydCB7XHJcbiAgREVGQVVMVF9TRVRUSU5HUyxcclxuICBFWFBMT1JFX1BBR0VfU0laRVMsXHJcbiAgTEVHQUNZX0ZJTFRFUl9PUFBPTkVOVFNfS0VZLFxyXG4gIExFR0FDWV9NVVRFX1BSRVZJRVdTX0tFWSxcclxuICBQTFVHSU5fSUQsXHJcbn0gZnJvbSBcIi4vY29uc3RhbnRzXCI7XHJcbmltcG9ydCB7IGdyYXBocWxRdWVyeSB9IGZyb20gXCIuL2dyYXBocWxcIjtcclxuaW1wb3J0IHsgc2V0UmF0aW5nU3lzdGVtIH0gZnJvbSBcIi4vcmF0aW5nRGlzcGxheVwiO1xyXG5pbXBvcnQgeyBzdGF0ZSB9IGZyb20gXCIuL3N0YXRlXCI7XHJcbmltcG9ydCB0eXBlIHsgRWxvU3RhcnQsIFNldHRpbmdzLCBTdGFzaFJhdGluZ3NNb2RlIH0gZnJvbSBcIi4vdHlwZXNcIjtcclxuXHJcbmNvbnN0IENPTkZJR19RVUVSWSA9IGB7IGNvbmZpZ3VyYXRpb24geyBwbHVnaW5zIH0gfWA7XHJcbi8qKiBPbiBsb2FkLCBhbHNvIFN0YXNoJ3MgaW50ZXJmYWNlIHNldHRpbmdzOiBob3cgaXQgc2hvd3MgcmF0aW5ncyAoc3RhcnMgb3IgZGVjaW1hbCkuICovXHJcbmNvbnN0IExPQURfUVVFUlkgPSBgeyBjb25maWd1cmF0aW9uIHsgcGx1Z2lucyB1aSB9IH1gO1xyXG5cclxuY29uc3QgQ09ORklHVVJFX1BMVUdJTl9NVVRBVElPTiA9IGBcclxuICAgICAgbXV0YXRpb24gQ29uZmlndXJlUGx1Z2luKCRwbHVnaW5faWQ6IElEISwgJGlucHV0OiBNYXAhKSB7XHJcbiAgICAgICAgY29uZmlndXJlUGx1Z2luKHBsdWdpbl9pZDogJHBsdWdpbl9pZCwgaW5wdXQ6ICRpbnB1dClcclxuICAgICAgfVxyXG4gICAgYDtcclxuXHJcbmNvbnN0IFNBVkVfREVCT1VOQ0VfTVMgPSA0MDA7XHJcbmxldCBzYXZlVGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XHJcblxyXG4vKiogUHJlLTMuMCBmdW4gbW9kZSB3YXMgb24gaW4gdGhlIHN0b3JlZCBjb25maWcgKHNvIEJhdHRsZSB3YXNuJ3QgY2hhbmdpbmcgU3Rhc2ggcmF0aW5ncykuICovXHJcbmxldCBsZWdhY3lGdW5Nb2RlID0gZmFsc2U7XHJcblxyXG5jb25zdCBTVEFTSF9SQVRJTkdTX01PREVTOiByZWFkb25seSBTdGFzaFJhdGluZ3NNb2RlW10gPSBbXCJvZmZcIiwgXCJwZXJjZW50aWxlXCIsIFwibGluZWFyXCJdO1xyXG5jb25zdCBFTE9fU1RBUlRTOiByZWFkb25seSBFbG9TdGFydFtdID0gW1wicmF0aW5nc1wiLCBcImZyZXNoXCJdO1xyXG5cclxuZnVuY3Rpb24gb25lT2Y8VCBleHRlbmRzIHN0cmluZz4odmFsdWU6IHVua25vd24sIGFsbG93ZWQ6IHJlYWRvbmx5IFRbXSwgZmFsbGJhY2s6IFQpOiBUIHtcclxuICByZXR1cm4gYWxsb3dlZC5pbmNsdWRlcyh2YWx1ZSBhcyBUKSA/ICh2YWx1ZSBhcyBUKSA6IGZhbGxiYWNrO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjbGFtcFBlcmNlbnQodmFsdWU6IHVua25vd24sIGZhbGxiYWNrOiBudW1iZXIpOiBudW1iZXIge1xyXG4gIGNvbnN0IG4gPSBOdW1iZXIodmFsdWUpO1xyXG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobikgPyBNYXRoLm1pbigxMDAsIE1hdGgubWF4KDAsIE1hdGgucm91bmQobikpKSA6IGZhbGxiYWNrO1xyXG59XHJcblxyXG4vKiogQ29lcmNlIGEgc3RvcmVkIGNvbmZpZyBtYXAgaW50byBTZXR0aW5ncyAoU3Rhc2ggbWF5IG9taXQga2V5cyBvciBzdG9yZSBudW1iZXJzIGFzIHN0cmluZ3MpLiAqL1xyXG5mdW5jdGlvbiBub3JtYWxpemUocmF3OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiwgYmFzZTogU2V0dGluZ3MpOiBTZXR0aW5ncyB7XHJcbiAgY29uc3QgYm9vbCA9IChrZXk6IGtleW9mIFNldHRpbmdzKTogYm9vbGVhbiA9PlxyXG4gICAgdHlwZW9mIHJhd1trZXldID09PSBcImJvb2xlYW5cIiA/IChyYXdba2V5XSBhcyBib29sZWFuKSA6IChiYXNlW2tleV0gYXMgYm9vbGVhbik7XHJcbiAgcmV0dXJuIHtcclxuICAgIC8vIEEgbWlzc2luZyBvciB1bmtub3duIHZhbHVlIGlzIFwib2ZmXCIuIChSZW1vdmVkIGtleXMsIHNlZSBSRU1PVkVEX0tFWVMsIGFyZSBkcm9wcGVkLilcclxuICAgIHN0YXNoUmF0aW5nczogb25lT2YocmF3LnN0YXNoUmF0aW5ncywgU1RBU0hfUkFUSU5HU19NT0RFUywgXCJvZmZcIiksXHJcbiAgICAvLyBTZXR1cCBmbGFncyBoYXZlIG5vIGZhbGxiYWNrOiByYXcgYWx3YXlzIGNhcnJpZXMgdGhlbSAoc3RvcmVkIGNvbmZpZywgb3IgY3VycmVudCArIHBhdGNoKVxyXG4gICAgZWxvU2V0dXBBdDogdHlwZW9mIHJhdy5lbG9TZXR1cEF0ID09PSBcInN0cmluZ1wiICYmIHJhdy5lbG9TZXR1cEF0ID8gcmF3LmVsb1NldHVwQXQgOiBudWxsLFxyXG4gICAgZWxvU2V0dXBNb2RlOiBFTE9fU1RBUlRTLmluY2x1ZGVzKHJhdy5lbG9TZXR1cE1vZGUgYXMgRWxvU3RhcnQpID8gKHJhdy5lbG9TZXR1cE1vZGUgYXMgRWxvU3RhcnQpIDogbnVsbCxcclxuICAgIG9wZW5Jbk5ld1RhYjogYm9vbChcIm9wZW5Jbk5ld1RhYlwiKSxcclxuICAgIGF1dG9wbGF5UHJldmlld3M6IGJvb2woXCJhdXRvcGxheVByZXZpZXdzXCIpLFxyXG4gICAgZmlsdGVyT3Bwb25lbnRzOiBib29sKFwiZmlsdGVyT3Bwb25lbnRzXCIpLFxyXG4gICAgY2xlYW5Nb2RlOiBib29sKFwiY2xlYW5Nb2RlXCIpLFxyXG4gICAgcGF1c2VNZWRpYU9uT3BlbjogYm9vbChcInBhdXNlTWVkaWFPbk9wZW5cIiksXHJcbiAgICBwbGFjZW1lbnRGcm9tQm90dG9tOiBib29sKFwicGxhY2VtZW50RnJvbUJvdHRvbVwiKSxcclxuICAgIHRpZXJCb3JkZXJzOiBib29sKFwidGllckJvcmRlcnNcIiksXHJcbiAgICB0ZXN0TW9kZTogYm9vbChcInRlc3RNb2RlXCIpLFxyXG4gICAgcHJldmlld1ZvbHVtZTogY2xhbXBQZXJjZW50KHJhdy5wcmV2aWV3Vm9sdW1lID8/IGJhc2UucHJldmlld1ZvbHVtZSwgYmFzZS5wcmV2aWV3Vm9sdW1lKSxcclxuICAgIGV4cGxvcmVQYWdlU2l6ZTogRVhQTE9SRV9QQUdFX1NJWkVTLmluY2x1ZGVzKE51bWJlcihyYXcuZXhwbG9yZVBhZ2VTaXplKSkgPyBOdW1iZXIocmF3LmV4cGxvcmVQYWdlU2l6ZSkgOiBiYXNlLmV4cGxvcmVQYWdlU2l6ZSxcclxuICB9O1xyXG59XHJcblxyXG4vKiogRGVmYXVsdHMgb3ZlcmxhaWQgd2l0aCB0aGUgcHJlLTIuNyBsb2NhbFN0b3JhZ2UgdG9nZ2xlcywgZm9yIHVzZXJzIHdobyBuZXZlciBzYXZlZCBzZXR0aW5ncy4gKi9cclxuZnVuY3Rpb24gbGVnYWN5RGVmYXVsdHMoKTogU2V0dGluZ3Mge1xyXG4gIGNvbnN0IHNldHRpbmdzID0geyAuLi5ERUZBVUxUX1NFVFRJTkdTIH07XHJcbiAgdHJ5IHtcclxuICAgIGlmIChsb2NhbFN0b3JhZ2UuZ2V0SXRlbShMRUdBQ1lfRklMVEVSX09QUE9ORU5UU19LRVkpID09PSBcIjFcIikgc2V0dGluZ3MuZmlsdGVyT3Bwb25lbnRzID0gdHJ1ZTtcclxuICAgIGlmIChsb2NhbFN0b3JhZ2UuZ2V0SXRlbShMRUdBQ1lfTVVURV9QUkVWSUVXU19LRVkpID09PSBcIjFcIikgc2V0dGluZ3MucHJldmlld1ZvbHVtZSA9IDA7XHJcbiAgfSBjYXRjaCB7XHJcbiAgICAvKiBpZ25vcmUgKi9cclxuICB9XHJcbiAgcmV0dXJuIHNldHRpbmdzO1xyXG59XHJcblxyXG4vKipcclxuICogRmV0Y2ggc2V0dGluZ3MgZnJvbSBTdGFzaCBpbnRvIHN0YXRlLnNldHRpbmdzLiBPbiBmYWlsdXJlLCBrZWVwcyB0aGUgY3VycmVudCB2YWx1ZXMgYW5kXHJcbiAqIHJldHVybnMgZmFsc2UuXHJcbiAqL1xyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbG9hZFNldHRpbmdzKCk6IFByb21pc2U8Ym9vbGVhbj4ge1xyXG4gIHRyeSB7XHJcbiAgICBjb25zdCBkYXRhID0gYXdhaXQgZ3JhcGhxbFF1ZXJ5PHsgY29uZmlndXJhdGlvbjogeyBwbHVnaW5zOiBSZWNvcmQ8c3RyaW5nLCBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj47IHVpOiB1bmtub3duIH0gfT4oTE9BRF9RVUVSWSk7XHJcbiAgICBzZXRSYXRpbmdTeXN0ZW0oZGF0YS5jb25maWd1cmF0aW9uLnVpKTtcclxuICAgIGNvbnN0IHN0b3JlZCA9IGRhdGEuY29uZmlndXJhdGlvbi5wbHVnaW5zPy5bUExVR0lOX0lEXTtcclxuICAgIC8vIFRlc3QgbW9kZSBrZWVwcyB0aGlzIHRhYidzIHNldHRpbmdzIGFuZCBoYWxsIG9mIGZhbWUgKGNoYW5nZWQsIGJ1dCBub3Qgc2F2ZWQpIHdoaWxlIGl0J3Mgb25cclxuICAgIGlmIChzdGF0ZS5zZXR0aW5ncy50ZXN0TW9kZSAmJiBzdG9yZWQ/LnRlc3RNb2RlID09PSB0cnVlKSByZXR1cm4gdHJ1ZTtcclxuICAgIGxlZ2FjeUZ1bk1vZGUgPSBzdG9yZWQ/LmZ1bk1vZGUgPT09IHRydWU7XHJcbiAgICBoYWxsT2ZGYW1lID0gbWVyZ2VIYWxsT2ZGYW1lKHBhcnNlSGFsbE9mRmFtZShzdG9yZWQ/LltIQUxMX09GX0ZBTUVfS0VZXSksIFtdKTtcclxuICAgIHN0YXRlLnNldHRpbmdzID0gc3RvcmVkID8gbm9ybWFsaXplKHN0b3JlZCwgREVGQVVMVF9TRVRUSU5HUykgOiBsZWdhY3lEZWZhdWx0cygpO1xyXG4gICAgcmV0dXJuIHRydWU7XHJcbiAgfSBjYXRjaCAoZSkge1xyXG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIEZhaWxlZCB0byBsb2FkIHNldHRpbmdzLCB1c2luZyBjdXJyZW50IHZhbHVlczpcIiwgZSk7XHJcbiAgICByZXR1cm4gZmFsc2U7XHJcbiAgfVxyXG59XHJcblxyXG4vKiogVHJ1ZSBpZiB0aGUgc3RvcmVkIGNvbmZpZyBzdGlsbCBoYXMgcHJlLTMuMCBmdW4gbW9kZSBzd2l0Y2hlZCBvbi4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGhhZEZ1bk1vZGUoKTogYm9vbGVhbiB7XHJcbiAgcmV0dXJuIGxlZ2FjeUZ1bk1vZGU7XHJcbn1cclxuXHJcbi8qKiBTZXR0aW5ncyBjaGFuZ2VkIGluIHRoaXMgdGFiIGFuZCBub3Qgc2F2ZWQgeWV0LiAqL1xyXG5jb25zdCB1bnNhdmVkID0gbmV3IFNldDxrZXlvZiBTZXR0aW5ncz4oKTtcclxuXHJcbi8qKiBUaGUgc3RvcmVkIGNvbmZpZyBtYXAsIGZyZXNoIGZyb20gU3Rhc2ggKHVuZGVmaW5lZCBpZiBTdGFzaCBCYXR0bGUgbmV2ZXIgc2F2ZWQgb25lKS4gKi9cclxuYXN5bmMgZnVuY3Rpb24gZmV0Y2hTdG9yZWRDb25maWcoKTogUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZD4ge1xyXG4gIGNvbnN0IGRhdGEgPSBhd2FpdCBncmFwaHFsUXVlcnk8eyBjb25maWd1cmF0aW9uOiB7IHBsdWdpbnM6IFJlY29yZDxzdHJpbmcsIFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB9IH0+KFxyXG4gICAgQ09ORklHX1FVRVJZLFxyXG4gICk7XHJcbiAgcmV0dXJuIGRhdGEuY29uZmlndXJhdGlvbi5wbHVnaW5zPy5bUExVR0lOX0lEXTtcclxufVxyXG5cclxuLyoqIEtleXMgZWFybGllciB2ZXJzaW9ucyBzdG9yZWQgYW5kIHRoaXMgb25lIGRyb3BzIGZyb20gdGhlIGNvbmZpZyBvbiBpdHMgbmV4dCBzYXZlLiAqL1xyXG5jb25zdCBSRU1PVkVEX0tFWVMgPSBbXCJmdW5Nb2RlXCIsIFwidW5yYXRlZFJhdGluZ1wiLCBcInNob3dUaWVyc1wiXTtcclxuXHJcbi8qKlxyXG4gKiBUaGUgY29uZmlnIG1hcCB0byBzYXZlLiBjb25maWd1cmVQbHVnaW4gcmVwbGFjZXMgdGhlIHdob2xlIG1hcCwgc28gaXQgc3RhcnRzIGZyb20gdGhlIHN0b3JlZFxyXG4gKiBvbmUsIG5vdCB0aGlzIHRhYidzIGNvcHkgKGFub3RoZXIgdGFiIG1heSBoYXZlIHNhdmVkIHNpbmNlIHRoaXMgb25lIGxvYWRlZDogZmluaXNoZWQgdGhlIEVMT1xyXG4gKiBzZXR1cCwgc2F5KSwgd2l0aCB0aGlzIHRhYidzIHVuc2F2ZWQgc2V0dGluZ3Mgb24gdG9wLiBLZXlzIHRoYXQgYXJlbid0IHNldHRpbmdzICh0aGUgaGFsbCBvZlxyXG4gKiBmYW1lKSBhcmUga2VwdDsgcmVtb3ZlZCBvbmVzIGFuZCB1bnNldCB2YWx1ZXMgYXJlIGxlZnQgb3V0LiBgZXh0cmFgIGFkZHMgb3IgcmVwbGFjZXMgc3VjaCBrZXlzLlxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIG1lcmdlQ29uZmlnKFxyXG4gIHN0b3JlZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQsXHJcbiAgY3VycmVudDogU2V0dGluZ3MsXHJcbiAgdW5zYXZlZEtleXM6IHJlYWRvbmx5IChrZXlvZiBTZXR0aW5ncylbXSxcclxuICBleHRyYTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fSxcclxuKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xyXG4gIGNvbnN0IG1lcmdlZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSBzdG9yZWQgPyB7IC4uLnN0b3JlZCwgLi4ubm9ybWFsaXplKHN0b3JlZCwgY3VycmVudCkgfSA6IHsgLi4uY3VycmVudCB9O1xyXG4gIGZvciAoY29uc3Qga2V5IG9mIHVuc2F2ZWRLZXlzKSBtZXJnZWRba2V5XSA9IGN1cnJlbnRba2V5XTtcclxuICBPYmplY3QuYXNzaWduKG1lcmdlZCwgZXh0cmEpO1xyXG4gIGZvciAoY29uc3Qga2V5IG9mIFJFTU9WRURfS0VZUykgZGVsZXRlIG1lcmdlZFtrZXldO1xyXG4gIHJldHVybiBPYmplY3QuZnJvbUVudHJpZXMoT2JqZWN0LmVudHJpZXMobWVyZ2VkKS5maWx0ZXIoKFssIHZhbHVlXSkgPT4gdmFsdWUgIT09IG51bGwgJiYgdmFsdWUgIT09IHVuZGVmaW5lZCkpO1xyXG59XHJcblxyXG4vKiogVGhlIGNvbmZpZyB3cml0ZSBpbiBwcm9ncmVzcyAob3IgdGhlIGxhc3Qgb25lKSwgc28gdGhlIG5leHQgc3RhcnRzIGZyb20gd2hhdCBpdCBzYXZlZC4gKi9cclxubGV0IGNvbmZpZ1dyaXRlczogUHJvbWlzZTx1bmtub3duPiA9IFByb21pc2UucmVzb2x2ZSgpO1xyXG5cclxuLyoqXHJcbiAqIFNhdmUgdGhpcyB0YWIncyB1bnNhdmVkIHNldHRpbmdzIHBsdXMgYGV4dHJhYCBrZXlzLCBhZnRlciBhbnkgY29uZmlnIHdyaXRlIGluIHByb2dyZXNzLiBgZXh0cmFgXHJcbiAqIGNhbiBiZSB3b3JrZWQgb3V0IGZyb20gdGhlIHN0b3JlZCBjb25maWcgKHRvIG1lcmdlIHdpdGggd2hhdCBhbm90aGVyIHRhYiBzYXZlZCkuXHJcbiAqL1xyXG5mdW5jdGlvbiBzYXZlQ29uZmlnKFxyXG4gIGV4dHJhOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8ICgoc3RvcmVkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZCkgPT4gUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0ge30sXHJcbik6IFByb21pc2U8Ym9vbGVhbj4ge1xyXG4gIGNvbnN0IHJ1biA9IGNvbmZpZ1dyaXRlcy50aGVuKGFzeW5jICgpID0+IHtcclxuICAgIGNvbnN0IGtleXMgPSBbLi4udW5zYXZlZF07XHJcbiAgICB1bnNhdmVkLmNsZWFyKCk7XHJcbiAgICAvLyBUZXN0IG1vZGU6IHNldHRpbmdzIGFuZCB0aGUgaGFsbCBvZiBmYW1lIGNoYW5nZSBpbiB0aGlzIHRhYiBvbmx5IChzZXRUZXN0TW9kZSBzYXZlcyB0aGUgc3dpdGNoKVxyXG4gICAgaWYgKHN0YXRlLnNldHRpbmdzLnRlc3RNb2RlICYmICFrZXlzLmluY2x1ZGVzKFwidGVzdE1vZGVcIikpIHJldHVybiB0cnVlO1xyXG4gICAgdHJ5IHtcclxuICAgICAgY29uc3Qgc3RvcmVkID0gYXdhaXQgZmV0Y2hTdG9yZWRDb25maWcoKTtcclxuICAgICAgY29uc3QgaW5wdXQgPSBtZXJnZUNvbmZpZyhzdG9yZWQsIHN0YXRlLnNldHRpbmdzLCBrZXlzLCB0eXBlb2YgZXh0cmEgPT09IFwiZnVuY3Rpb25cIiA/IGV4dHJhKHN0b3JlZCkgOiBleHRyYSk7XHJcbiAgICAgIGF3YWl0IGdyYXBocWxRdWVyeShDT05GSUdVUkVfUExVR0lOX01VVEFUSU9OLCB7IHBsdWdpbl9pZDogUExVR0lOX0lELCBpbnB1dCB9KTtcclxuICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICB9IGNhdGNoIChlKSB7XHJcbiAgICAgIGNvbnNvbGUuZXJyb3IoXCJbU3Rhc2ggQmF0dGxlXSBGYWlsZWQgdG8gc2F2ZSBzZXR0aW5nczpcIiwgZSk7XHJcbiAgICAgIGZvciAoY29uc3Qga2V5IG9mIGtleXMpIHVuc2F2ZWQuYWRkKGtleSk7XHJcbiAgICAgIHJldHVybiBmYWxzZTtcclxuICAgIH1cclxuICB9KTtcclxuICBjb25maWdXcml0ZXMgPSBydW47XHJcbiAgcmV0dXJuIHJ1bjtcclxufVxyXG5cclxuZnVuY3Rpb24gcGVyc2lzdFNldHRpbmdzKCk6IFByb21pc2U8Ym9vbGVhbj4ge1xyXG4gIHJldHVybiBzYXZlQ29uZmlnKCk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBUdXJuIHRlc3QgbW9kZSBvbiBvciBvZmYuIFdoaWxlIGl0J3Mgb24gbm90aGluZyBTdGFzaCBCYXR0bGUgZG9lcyBpcyB3cml0dGVuIHRvIFN0YXNoOiBFTE8sXHJcbiAqIHJlY29yZHMgYW5kIFN0YXNoIHJhdGluZ3MgY2hhbmdlIGluIHRoaXMgdGFiJ3Mgc2NlbmUgY2FjaGUgb25seSAocmF0aW5nLnRzKSwgYW5kIHNldHRpbmdzIGFuZFxyXG4gKiB0aGUgaGFsbCBvZiBmYW1lIGluIHRoaXMgdGFiJ3MgY29waWVzIChzYXZlQ29uZmlnKS4gT25seSB0aGUgc3dpdGNoIGl0c2VsZiBpcyBzYXZlZCwgc28gaXRcclxuICogc3RheXMgb24gYWZ0ZXIgYSByZWxvYWQuIFR1cm5pbmcgaXQgb24gZmlyc3Qgc2F2ZXMgc2V0dGluZ3MgY2hhbmdlZCBiZWZvcmUgaXQ7IHR1cm5pbmcgaXQgb2ZmXHJcbiAqIHNhdmVzIHRoZSBzd2l0Y2ggYWxvbmUgYW5kIHJlbG9hZHMgc2V0dGluZ3MgYW5kIHRoZSBoYWxsIG9mIGZhbWUgZnJvbSBTdGFzaC4gKFRoZSBjYWxsZXIgZHJvcHNcclxuICogdGhlIHNjZW5lIGNhY2hlLCBzbyB0aGUgbWFkZS11cCBFTE8gZ29lcyB0b28uKSBSZXNvbHZlcyBmYWxzZSBpZiBzYXZpbmcgZmFpbGVkLlxyXG4gKi9cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNldFRlc3RNb2RlKG9uOiBib29sZWFuKTogUHJvbWlzZTxib29sZWFuPiB7XHJcbiAgaWYgKHNhdmVUaW1lcikge1xyXG4gICAgY2xlYXJUaW1lb3V0KHNhdmVUaW1lcik7XHJcbiAgICBzYXZlVGltZXIgPSBudWxsO1xyXG4gIH1cclxuICBpZiAoIW9uKSB1bnNhdmVkLmNsZWFyKCk7XHJcbiAgc3RhdGUuc2V0dGluZ3MgPSB7IC4uLnN0YXRlLnNldHRpbmdzLCB0ZXN0TW9kZTogb24gfTtcclxuICB1bnNhdmVkLmFkZChcInRlc3RNb2RlXCIpO1xyXG4gIGNvbnN0IHNhdmVkID0gYXdhaXQgc2F2ZUNvbmZpZygpO1xyXG4gIGlmICghb24pIGF3YWl0IGxvYWRTZXR0aW5ncygpO1xyXG4gIHJldHVybiBzYXZlZDtcclxufVxyXG5cclxuLy8gLS0tLS0tLS0tLSBIYWxsIG9mIGZhbWUgKFN0YXRzIOKGkiBSZWNvcmRzKSAtLS0tLS0tLS0tXHJcblxyXG4vKiogUGx1Z2luIGNvbmZpZyBrZXk6IGV2ZXJ5IHNjZW5lIHRoYXQgaGFzIGV2ZXIgYmVlbiAjMSwgd2l0aCB0aGUgZGF0ZSBpdCBmaXJzdCBnb3QgdGhlcmUuICovXHJcbmNvbnN0IEhBTExfT0ZfRkFNRV9LRVkgPSBcInN0YXRzSGFsbE9mRmFtZVwiO1xyXG5cclxuZXhwb3J0IGludGVyZmFjZSBIYWxsT2ZGYW1lRW50cnkge1xyXG4gIGlkOiBzdHJpbmc7XHJcbiAgLyoqIFdoZW4gaXQgZmlyc3QgcmVhY2hlZCAjMSAoSVNPIHRpbWUpLiAqL1xyXG4gIGRhdGU6IHN0cmluZztcclxufVxyXG5cclxubGV0IGhhbGxPZkZhbWU6IEhhbGxPZkZhbWVFbnRyeVtdID0gW107XHJcblxyXG4vKiogVGhlIHN0b3JlZCBsaXN0IChhIEpTT04gc3RyaW5nIGluIHRoZSBjb25maWcpOyBhbnl0aGluZyB1bnJlYWRhYmxlIGNvdW50cyBhcyBlbXB0eS4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlSGFsbE9mRmFtZSh2YWx1ZTogdW5rbm93bik6IEhhbGxPZkZhbWVFbnRyeVtdIHtcclxuICBpZiAodHlwZW9mIHZhbHVlICE9PSBcInN0cmluZ1wiIHx8ICF2YWx1ZSkgcmV0dXJuIFtdO1xyXG4gIHRyeSB7XHJcbiAgICBjb25zdCBsaXN0OiB1bmtub3duID0gSlNPTi5wYXJzZSh2YWx1ZSk7XHJcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkobGlzdCkpIHJldHVybiBbXTtcclxuICAgIHJldHVybiBsaXN0LmZpbHRlcihcclxuICAgICAgKGUpOiBlIGlzIEhhbGxPZkZhbWVFbnRyeSA9PlxyXG4gICAgICAgIHR5cGVvZiBlPy5pZCA9PT0gXCJzdHJpbmdcIiAmJiB0eXBlb2YgZT8uZGF0ZSA9PT0gXCJzdHJpbmdcIiAmJiAhTnVtYmVyLmlzTmFOKERhdGUucGFyc2UoZS5kYXRlKSksXHJcbiAgICApO1xyXG4gIH0gY2F0Y2gge1xyXG4gICAgcmV0dXJuIFtdO1xyXG4gIH1cclxufVxyXG5cclxuLyoqXHJcbiAqIFR3byBsaXN0cyBhcyBvbmU6IGVhY2ggc2NlbmUgb25jZSwgd2l0aCBpdHMgZWFybGllc3QgdGltZSwgb2xkZXN0IGZpcnN0IChieSB0aGUgc3RvcmVkIHRpbWUsIG5vdFxyXG4gKiB0aGUgZGF5OiBzZXZlcmFsIHNjZW5lcyBjYW4gcmVhY2ggIzEgb24gdGhlIHNhbWUgZGF5KS5cclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBtZXJnZUhhbGxPZkZhbWUoYTogcmVhZG9ubHkgSGFsbE9mRmFtZUVudHJ5W10sIGI6IHJlYWRvbmx5IEhhbGxPZkZhbWVFbnRyeVtdKTogSGFsbE9mRmFtZUVudHJ5W10ge1xyXG4gIGNvbnN0IGVhcmxpZXN0ID0gbmV3IE1hcDxzdHJpbmcsIEhhbGxPZkZhbWVFbnRyeT4oKTtcclxuICBmb3IgKGNvbnN0IGVudHJ5IG9mIFsuLi5hLCAuLi5iXSkge1xyXG4gICAgY29uc3Qga25vd24gPSBlYXJsaWVzdC5nZXQoZW50cnkuaWQpO1xyXG4gICAgaWYgKCFrbm93biB8fCBEYXRlLnBhcnNlKGVudHJ5LmRhdGUpIDwgRGF0ZS5wYXJzZShrbm93bi5kYXRlKSkgZWFybGllc3Quc2V0KGVudHJ5LmlkLCBlbnRyeSk7XHJcbiAgfVxyXG4gIHJldHVybiBbLi4uZWFybGllc3QudmFsdWVzKCldLnNvcnQoKHgsIHkpID0+IERhdGUucGFyc2UoeC5kYXRlKSAtIERhdGUucGFyc2UoeS5kYXRlKSk7XHJcbn1cclxuXHJcbi8qKiBUaGUgaGFsbCBvZiBmYW1lLCBvbGRlc3QgZmlyc3QgKGJ5IHRoZSB0aW1lIGVhY2ggc2NlbmUgZmlyc3QgcmVhY2hlZCAjMSkuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBnZXRIYWxsT2ZGYW1lKCk6IHJlYWRvbmx5IEhhbGxPZkZhbWVFbnRyeVtdIHtcclxuICByZXR1cm4gaGFsbE9mRmFtZTtcclxufVxyXG5cclxuLyoqXHJcbiAqIEFkZCBhIHNjZW5lIHRoYXQgaGFzIGp1c3QgcmVhY2hlZCAjMSAob25jZTogaXRzIGZpcnN0IHRpbWUgaXMga2VwdCkgYW5kIHNhdmUgdGhlIGxpc3QsIG1lcmdlZFxyXG4gKiB3aXRoIHRoZSBzdG9yZWQgb25lLCBzbyBhbm90aGVyIHRhYidzIGFkZGl0aW9ucyBhcmVuJ3QgbG9zdC5cclxuICovXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBhZGRUb0hhbGxPZkZhbWUoc2NlbmVJZDogc3RyaW5nLCBkYXRlID0gbmV3IERhdGUoKS50b0lTT1N0cmluZygpKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgaWYgKGhhbGxPZkZhbWUuc29tZSgoZSkgPT4gZS5pZCA9PT0gc2NlbmVJZCkpIHJldHVybjtcclxuICBoYWxsT2ZGYW1lID0gbWVyZ2VIYWxsT2ZGYW1lKGhhbGxPZkZhbWUsIFt7IGlkOiBzY2VuZUlkLCBkYXRlIH1dKTtcclxuICBhd2FpdCBzYXZlQ29uZmlnKChzdG9yZWQpID0+IHtcclxuICAgIGhhbGxPZkZhbWUgPSBtZXJnZUhhbGxPZkZhbWUocGFyc2VIYWxsT2ZGYW1lKHN0b3JlZD8uW0hBTExfT0ZfRkFNRV9LRVldKSwgaGFsbE9mRmFtZSk7XHJcbiAgICByZXR1cm4geyBbSEFMTF9PRl9GQU1FX0tFWV06IEpTT04uc3RyaW5naWZ5KGhhbGxPZkZhbWUpIH07XHJcbiAgfSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBVbmRvOiB0YWtlIG91dCB0aGUgZW50cmllcyBmb3Igc2NlbmVzIG5vdCBpbiBga2VlcElkc2AgKGFkZGVkIGJ5IHRoZSBwaWNrIGJlaW5nIHVuZG9uZSksIGZyb21cclxuICogdGhpcyB0YWIncyBsaXN0IGFuZCB0aGUgc3RvcmVkIG9uZS5cclxuICovXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBrZWVwT25seUhhbGxPZkZhbWUoa2VlcElkczogcmVhZG9ubHkgc3RyaW5nW10pOiBQcm9taXNlPHZvaWQ+IHtcclxuICBjb25zdCBrZWVwID0gbmV3IFNldChrZWVwSWRzKTtcclxuICBpZiAoaGFsbE9mRmFtZS5ldmVyeSgoZSkgPT4ga2VlcC5oYXMoZS5pZCkpKSByZXR1cm47XHJcbiAgY29uc3QgZHJvcCA9IG5ldyBTZXQoaGFsbE9mRmFtZS5maWx0ZXIoKGUpID0+ICFrZWVwLmhhcyhlLmlkKSkubWFwKChlKSA9PiBlLmlkKSk7XHJcbiAgaGFsbE9mRmFtZSA9IGhhbGxPZkZhbWUuZmlsdGVyKChlKSA9PiAhZHJvcC5oYXMoZS5pZCkpO1xyXG4gIGF3YWl0IHNhdmVDb25maWcoKHN0b3JlZCkgPT4ge1xyXG4gICAgaGFsbE9mRmFtZSA9IG1lcmdlSGFsbE9mRmFtZShwYXJzZUhhbGxPZkZhbWUoc3RvcmVkPy5bSEFMTF9PRl9GQU1FX0tFWV0pLCBoYWxsT2ZGYW1lKS5maWx0ZXIoKGUpID0+ICFkcm9wLmhhcyhlLmlkKSk7XHJcbiAgICByZXR1cm4geyBbSEFMTF9PRl9GQU1FX0tFWV06IEpTT04uc3RyaW5naWZ5KGhhbGxPZkZhbWUpIH07XHJcbiAgfSk7XHJcbn1cclxuXHJcbi8qKiBFbXB0eSB0aGUgbGlzdCAoc2V0dXAsIFJlc2V0IEVMTywgU2V0dGluZ3Mg4oaSIENsZWFyIGhhbGwgb2YgZmFtZSkuIFJlc29sdmVzIGZhbHNlIGlmIHNhdmluZyBmYWlsZWQuICovXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjbGVhckhhbGxPZkZhbWUoKTogUHJvbWlzZTxib29sZWFuPiB7XHJcbiAgaGFsbE9mRmFtZSA9IFtdO1xyXG4gIHJldHVybiBzYXZlQ29uZmlnKHsgW0hBTExfT0ZfRkFNRV9LRVldOiBudWxsIH0pO1xyXG59XHJcblxyXG4vKiogVXBkYXRlIHNldHRpbmdzIGxvY2FsbHkgcmlnaHQgYXdheSBhbmQgcGVyc2lzdCB0byBTdGFzaCAoZGVib3VuY2VkLCBmb3Igc2xpZGVycykuICovXHJcbmV4cG9ydCBmdW5jdGlvbiB1cGRhdGVTZXR0aW5ncyhwYXRjaDogUGFydGlhbDxTZXR0aW5ncz4pOiB2b2lkIHtcclxuICBzdGF0ZS5zZXR0aW5ncyA9IG5vcm1hbGl6ZSh7IC4uLnN0YXRlLnNldHRpbmdzLCAuLi5wYXRjaCB9LCBzdGF0ZS5zZXR0aW5ncyk7XHJcbiAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXMocGF0Y2gpIGFzIChrZXlvZiBTZXR0aW5ncylbXSkgdW5zYXZlZC5hZGQoa2V5KTtcclxuICBpZiAoc2F2ZVRpbWVyKSBjbGVhclRpbWVvdXQoc2F2ZVRpbWVyKTtcclxuICBzYXZlVGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHtcclxuICAgIHNhdmVUaW1lciA9IG51bGw7XHJcbiAgICB2b2lkIHBlcnNpc3RTZXR0aW5ncygpO1xyXG4gIH0sIFNBVkVfREVCT1VOQ0VfTVMpO1xyXG59XHJcblxyXG4vKiogVXBkYXRlIHNldHRpbmdzIGFuZCBzYXZlIHRvIFN0YXNoIHJpZ2h0IGF3YXkgKG5vIGRlYm91bmNlKS4gUmVzb2x2ZXMgZmFsc2UgaWYgc2F2aW5nIGZhaWxlZC4gKi9cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHVwZGF0ZVNldHRpbmdzTm93KHBhdGNoOiBQYXJ0aWFsPFNldHRpbmdzPik6IFByb21pc2U8Ym9vbGVhbj4ge1xyXG4gIHN0YXRlLnNldHRpbmdzID0gbm9ybWFsaXplKHsgLi4uc3RhdGUuc2V0dGluZ3MsIC4uLnBhdGNoIH0sIHN0YXRlLnNldHRpbmdzKTtcclxuICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhwYXRjaCkgYXMgKGtleW9mIFNldHRpbmdzKVtdKSB1bnNhdmVkLmFkZChrZXkpO1xyXG4gIGlmIChzYXZlVGltZXIpIHtcclxuICAgIGNsZWFyVGltZW91dChzYXZlVGltZXIpO1xyXG4gICAgc2F2ZVRpbWVyID0gbnVsbDtcclxuICB9XHJcbiAgcmV0dXJuIHBlcnNpc3RTZXR0aW5ncygpO1xyXG59XHJcbiIsICIvLyBQZXJzaXN0IEVMTyAoYW5kIFN0YXNoIHJhdGluZ3MpIHRvIFN0YXNoIGFuZCBrZWVwIHRoZSBsb2NhbCBjYWNoZSBpbiBzeW5jLlxyXG5cclxuaW1wb3J0IHsgbGF0ZXN0U2NlbmUsIHNldEVsb0luQ2FjaGUsIHNldFJhdGluZ3NJbkNhY2hlIH0gZnJvbSBcIi4vY2FjaGVcIjtcclxuaW1wb3J0IHsgRUxPX0ZJRUxEX0tFWVMsIFJFQ09SRF9GSUVMRF9LRVlTIH0gZnJvbSBcIi4vY29uc3RhbnRzXCI7XHJcbmltcG9ydCB7IGdyYXBocWxRdWVyeSwgcmVmcmVzaFN0YXNoQ2FjaGUgfSBmcm9tIFwiLi9ncmFwaHFsXCI7XHJcbmltcG9ydCB7IGlzU2NlbmVOb3RGb3VuZEVycm9yIH0gZnJvbSBcIi4vc2NlbmVBY3Rpb25zXCI7XHJcbmltcG9ydCB7IGVsbyBhcyBlbG9PZiwgZWxvQ3VzdG9tRmllbGRzLCBlbG9GaWVsZHMsIGlzUmF0ZWQsIGlzU2VlZGVkLCByZWNvcmRBZnRlciwgc2NlbmVSZWNvcmQsIHN0YXNoUmF0aW5nQ2hhbmdlcyB9IGZyb20gXCIuL3Njb3JlXCI7XHJcbmltcG9ydCB7IGFkZFRvSGFsbE9mRmFtZSwgZ2V0SGFsbE9mRmFtZSB9IGZyb20gXCIuL3NldHRpbmdzXCI7XHJcbmltcG9ydCB7IHN0YXRlIH0gZnJvbSBcIi4vc3RhdGVcIjtcclxuaW1wb3J0IHR5cGUgeyBFbG9GaWVsZHMsIFNjZW5lIH0gZnJvbSBcIi4vdHlwZXNcIjtcclxuXHJcbi8qKiBXaW5kb3cgZXZlbnQgZmlyZWQgd2hlbiBhIHJhdGluZyB3cml0ZSBmaW5kcyB0aGUgc2NlbmUgd2FzIGRlbGV0ZWQgZWxzZXdoZXJlIChkZXRhaWwgPSBzY2VuZSBpZCkuICovXHJcbmV4cG9ydCBjb25zdCBTQ0VORV9NSVNTSU5HX0VWRU5UID0gXCJzdGFzaC1iYXR0bGU6c2NlbmUtbWlzc2luZ1wiO1xyXG5cclxuY29uc3QgU0NFTkVfVVBEQVRFX01VVEFUSU9OID0gYFxyXG4gICAgICBtdXRhdGlvbiBTY2VuZVVwZGF0ZSgkaW5wdXQ6IFNjZW5lVXBkYXRlSW5wdXQhKSB7XHJcbiAgICAgICAgc2NlbmVVcGRhdGUoaW5wdXQ6ICRpbnB1dCkge1xyXG4gICAgICAgICAgaWRcclxuICAgICAgICB9XHJcbiAgICAgIH1cclxuICAgIGA7XHJcblxyXG5mdW5jdGlvbiByZXBvcnRXcml0ZUVycm9yKHNjZW5lSWQ6IHN0cmluZywgd2hhdDogc3RyaW5nLCBlOiB1bmtub3duKTogdm9pZCB7XHJcbiAgY29uc29sZS5lcnJvcihgW1N0YXNoIEJhdHRsZV0gRmFpbGVkIHRvICR7d2hhdH0gZm9yIHNjZW5lICR7c2NlbmVJZH06YCwgZSk7XHJcbiAgaWYgKGlzU2NlbmVOb3RGb3VuZEVycm9yKGUpKSB7XHJcbiAgICB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgQ3VzdG9tRXZlbnQoU0NFTkVfTUlTU0lOR19FVkVOVCwgeyBkZXRhaWw6IHNjZW5lSWQgfSkpO1xyXG4gIH1cclxufVxyXG5cclxuLyoqIFRydWUgd2hlbiBib3RoIGFyZSB1bnJhdGVkLCBvciBob2xkIHRoZSBzYW1lIEVMTyBmaWVsZHMgKHJlY29yZCBpbmNsdWRlZCkuICovXHJcbmZ1bmN0aW9uIHNhbWVFbG8oYTogRWxvRmllbGRzIHwgbnVsbCwgYjogRWxvRmllbGRzIHwgbnVsbCk6IGJvb2xlYW4ge1xyXG4gIGlmIChhID09PSBudWxsIHx8IGIgPT09IG51bGwpIHJldHVybiBhID09PSBiO1xyXG4gIHJldHVybiBKU09OLnN0cmluZ2lmeShlbG9DdXN0b21GaWVsZHMoYSkpID09PSBKU09OLnN0cmluZ2lmeShlbG9DdXN0b21GaWVsZHMoYikpO1xyXG59XHJcblxyXG4vKipcclxuICogVXBkYXRlIHRoZSBzY2VuZSBvYmplY3QsIHRoZSBjYWNoZSBhbmQgU3Rhc2gncyBwYWdlIGNhY2hlIHN0cmFpZ2h0IGF3YXkgKHNvIHRoZSBuZXh0IHBhaXJcclxuICogYWxyZWFkeSBzZWVzIHRoZSBjaGFuZ2UpLCB0aGVuIHdyaXRlIHRvIFN0YXNoLiBJZiB0aGUgd3JpdGUgZmFpbHMsIHB1dCB0aGUgb2xkIHZhbHVlIGJhY2ssXHJcbiAqIHVubGVzcyBhIGxhdGVyIHdyaXRlIGhhcyByZXBsYWNlZCBpdCBzaW5jZS4gU3Rhc2ggcmF0aW5ncyBzeW5jIG9ubHkgYWZ0ZXIgYSBzdWNjZXNzZnVsIHdyaXRlLlxyXG4gKiBJbiB0ZXN0IG1vZGUgb25seSBTdGFzaCBCYXR0bGUncyBjYWNoZSBjaGFuZ2VzOiBub3RoaW5nIGlzIHdyaXR0ZW4sIGFuZCBTdGFzaCdzIG93biBwYWdlcyBrZWVwXHJcbiAqIHNob3dpbmcgd2hhdCdzIHNhdmVkLlxyXG4gKi9cclxuYXN5bmMgZnVuY3Rpb24gc2F2ZUVsb0ZpZWxkcyhcclxuICBzY2VuZTogU2NlbmUsXHJcbiAgdmFsdWU6IEVsb0ZpZWxkcyB8IG51bGwsXHJcbiAgY3VzdG9tRmllbGRzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcclxuICB3aGF0OiBzdHJpbmcsXHJcbiAgcmF0aW5nMTAwPzogbnVtYmVyIHwgbnVsbCxcclxuKTogUHJvbWlzZTxib29sZWFuPiB7XHJcbiAgY29uc3QgcHJldmlvdXMgPSBlbG9GaWVsZHMobGF0ZXN0U2NlbmUoc2NlbmUpKTtcclxuICBjb25zdCB0ZXN0aW5nID0gc3RhdGUuc2V0dGluZ3MudGVzdE1vZGU7XHJcbiAgc2V0RWxvSW5DYWNoZShzY2VuZSwgdmFsdWUpO1xyXG4gIGlmICghdGVzdGluZykgcmVmcmVzaFN0YXNoQ2FjaGUoW3sgaWQ6IHNjZW5lLmlkLCBlbG86IHZhbHVlIH1dLCBmYWxzZSk7XHJcbiAgdHJ5IHtcclxuICAgIGNvbnN0IGlucHV0ID0geyBpZDogc2NlbmUuaWQsIGN1c3RvbV9maWVsZHM6IGN1c3RvbUZpZWxkcywgLi4uKHJhdGluZzEwMCAhPT0gdW5kZWZpbmVkID8geyByYXRpbmcxMDAgfSA6IHt9KSB9O1xyXG4gICAgaWYgKHRlc3RpbmcpIGNvbnNvbGUubG9nKGBbU3Rhc2ggQmF0dGxlXSDwn6eqIFRlc3QgbW9kZTogbm90IHNhdmluZyBzY2VuZSAke3NjZW5lLmlkfSAoJHt3aGF0fSlgKTtcclxuICAgIGVsc2UgYXdhaXQgZ3JhcGhxbFF1ZXJ5KFNDRU5FX1VQREFURV9NVVRBVElPTiwgeyBpbnB1dCB9KTtcclxuICB9IGNhdGNoIChlKSB7XHJcbiAgICByZXBvcnRXcml0ZUVycm9yKHNjZW5lLmlkLCB3aGF0LCBlKTtcclxuICAgIGlmIChzYW1lRWxvKGVsb0ZpZWxkcyhsYXRlc3RTY2VuZShzY2VuZSkpLCB2YWx1ZSkpIHtcclxuICAgICAgc2V0RWxvSW5DYWNoZShzY2VuZSwgcHJldmlvdXMpO1xyXG4gICAgICByZWZyZXNoU3Rhc2hDYWNoZShbeyBpZDogc2NlbmUuaWQsIGVsbzogcHJldmlvdXMgfV0sIGZhbHNlKTtcclxuICAgIH1cclxuICAgIHJldHVybiBmYWxzZTtcclxuICB9XHJcbiAgaWYgKHJhdGluZzEwMCAhPT0gdW5kZWZpbmVkKSB7XHJcbiAgICBzZXRSYXRpbmdzSW5DYWNoZShuZXcgTWFwKFtbc2NlbmUuaWQsIHJhdGluZzEwMF1dKSk7XHJcbiAgICBpZiAoIXRlc3RpbmcpIHJlZnJlc2hTdGFzaENhY2hlKFt7IGlkOiBzY2VuZS5pZCwgcmF0aW5nMTAwIH1dLCB0cnVlKTtcclxuICB9XHJcbiAgc2NoZWR1bGVTdGFzaFJhdGluZ1N5bmMoKTtcclxuICByZXR1cm4gdHJ1ZTtcclxufVxyXG5cclxuLyoqXHJcbiAqIFNhdmUgYSBzY2VuZSdzIEVMTyBhbmQgYmF0dGxlIGNvdW50LCBhbmQgaXRzIHJlY29yZCB3aXRoIGByZXN1bHRzYCBhZGRlZCAoZWFjaCBwaWNrIGluIG9yZGVyLFxyXG4gKiB0cnVlID0gd29uKSwgaW4gb25lIHdyaXRlIChjdXN0b20gZmllbGRzIG9ubHk7IGBwYXJ0aWFsYCBsZWF2ZXMgb3RoZXIgcGx1Z2lucycgZmllbGRzIGFsb25lKS5cclxuICogV2hldGhlciBpdCB3YXMgc2VlZGVkIHN0YXlzIGFzIGl0IHdhcy5cclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiB3cml0ZUVsbyhzY2VuZTogU2NlbmUsIGVsbzogbnVtYmVyLCBiYXR0bGVzOiBudW1iZXIsIHJlc3VsdHM6IGJvb2xlYW5bXSk6IFByb21pc2U8dm9pZD4ge1xyXG4gIGNvbnN0IHdyaXRlID0gc2F2ZUVsbyhzY2VuZSwgZWxvLCBiYXR0bGVzLCByZXN1bHRzKTtcclxuICBwZW5kaW5nV3JpdGVzLmFkZCh3cml0ZSk7XHJcbiAgdm9pZCB3cml0ZS5maW5hbGx5KCgpID0+IHBlbmRpbmdXcml0ZXMuZGVsZXRlKHdyaXRlKSk7XHJcbiAgcmV0dXJuIHdyaXRlO1xyXG59XHJcblxyXG4vKiogRUxPIHdyaXRlcyBzdGlsbCBvbiB0aGVpciB3YXkgdG8gU3Rhc2ggKHVuZG8gd2FpdHMgZm9yIHRoZW0gYmVmb3JlIHB1dHRpbmcgdmFsdWVzIGJhY2spLiAqL1xyXG5jb25zdCBwZW5kaW5nV3JpdGVzID0gbmV3IFNldDxQcm9taXNlPHZvaWQ+PigpO1xyXG5cclxuLyoqIFJlc29sdmVzIG9uY2UgZXZlcnkgRUxPIHdyaXRlIHN0YXJ0ZWQgc28gZmFyIGhhcyBmaW5pc2hlZC4gKi9cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGVsb1dyaXRlc1NldHRsZWQoKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgYXdhaXQgUHJvbWlzZS5hbGxTZXR0bGVkKFsuLi5wZW5kaW5nV3JpdGVzXSk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIHNhdmVFbG8oc2NlbmU6IFNjZW5lLCBlbG86IG51bWJlciwgYmF0dGxlczogbnVtYmVyLCByZXN1bHRzOiBib29sZWFuW10pOiBQcm9taXNlPHZvaWQ+IHtcclxuICBjb25zdCBjdXJyZW50ID0gbGF0ZXN0U2NlbmUoc2NlbmUpO1xyXG4gIGNvbnN0IHJlY29yZCA9IHJlY29yZEFmdGVyKHNjZW5lUmVjb3JkKGN1cnJlbnQpLCByZXN1bHRzLCBlbG9PZihjdXJyZW50KSA/PyBlbG8sIGVsbyk7XHJcbiAgY29uc3QgdmFsdWU6IEVsb0ZpZWxkcyA9IHsgZWxvLCBiYXR0bGVzLCBzZWVkZWQ6IGlzU2VlZGVkKHNjZW5lKSwgcmVjb3JkIH07XHJcbiAgaWYgKGF3YWl0IHNhdmVFbG9GaWVsZHMoc2NlbmUsIHZhbHVlLCB7IHBhcnRpYWw6IGVsb0N1c3RvbUZpZWxkcyh2YWx1ZSkgfSwgXCJzYXZlIEVMT1wiKSkge1xyXG4gICAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIPCfk50gU2F2ZWQgc2NlbmUgJHtzY2VuZS5pZH0gRUxPICR7ZWxvfSAoJHtiYXR0bGVzfSBiYXR0bGVzKWApO1xyXG4gICAgbm90ZVRvcFNjZW5lKCk7XHJcbiAgfVxyXG59XHJcblxyXG4vKiogVGhlIGxpYnJhcnkncyAjMSAodGhlIGFsbC1zY2VuZXMgY2FjaGUgaXMgRUxPLXNvcnRlZCkgam9pbnMgdGhlIGhhbGwgb2YgZmFtZSBpZiBpdCdzIG5ldyB0aGVyZS4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIG5vdGVUb3BTY2VuZSgpOiB2b2lkIHtcclxuICBjb25zdCB0b3AgPSBzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXM/LlswXTtcclxuICBpZiAodG9wICYmIGlzUmF0ZWQodG9wKSAmJiAhZ2V0SGFsbE9mRmFtZSgpLnNvbWUoKGUpID0+IGUuaWQgPT09IHRvcC5pZCkpIHZvaWQgYWRkVG9IYWxsT2ZGYW1lKHRvcC5pZCk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBQdXQgYSBzY2VuZSdzIEVMTyBmaWVsZHMgYmFjayBleGFjdGx5IGFzIGB2YWx1ZWAgKHVuZG8pOiBhIHNjZW5lIHRoYXQgaGFkIG5vIHJlY29yZCBsb3NlcyB0aGVcclxuICogcmVjb3JkIGZpZWxkcyBpdHMgcGljayBjcmVhdGVkLCBhbmQgb25lIHRoYXQgd2FzIHVucmF0ZWQgbG9zZXMgaXRzIEVMTyBhZ2Fpbi4gTm90aGluZyBpc1xyXG4gKiB3cml0dGVuIHdoZW4gdGhleSBhbHJlYWR5IG1hdGNoLlxyXG4gKlxyXG4gKiBBIHNjZW5lIGdvaW5nIGJhY2sgdG8gdW5yYXRlZCBhbHNvIGdldHMgaXRzIFN0YXNoIHJhdGluZyBmcm9tIGJlZm9yZSAoYHJhdGluZzEwMGApIGluIHRoZSBzYW1lXHJcbiAqIHdyaXRlOiB0aGUgc3luYyBnYXZlIGl0IG9uZSBmcm9tIGl0cyBuZXcgRUxPLCBhbmQgdGhlIHN5bmMgb25seSB3cml0ZXMgc2NlbmVzIHRoYXQgaGF2ZSBhbiBFTE8sXHJcbiAqIHNvIGl0IHdvdWxkIG5ldmVyIHVuZG8gdGhhdCBpdHNlbGYuIFJhdGVkIHNjZW5lcycgcmF0aW5ncyBmb2xsb3cgdGhlaXIgcmVzdG9yZWQgRUxPIG9uIHRoZVxyXG4gKiBuZXh0IHN5bmMuXHJcbiAqL1xyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVzdG9yZUVsbyhzY2VuZTogU2NlbmUsIHZhbHVlOiBFbG9GaWVsZHMgfCBudWxsLCByYXRpbmcxMDA6IG51bWJlciB8IG51bGwgPSBudWxsKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgY29uc3QgY3VycmVudCA9IGxhdGVzdFNjZW5lKHNjZW5lKTtcclxuICBpZiAoc2FtZUVsbyhlbG9GaWVsZHMoY3VycmVudCksIHZhbHVlKSkgcmV0dXJuO1xyXG4gIGNvbnN0IGN1c3RvbUZpZWxkcyA9IHZhbHVlXHJcbiAgICA/IHsgcGFydGlhbDogZWxvQ3VzdG9tRmllbGRzKHZhbHVlKSwgLi4uKHZhbHVlLnJlY29yZCA/IHt9IDogeyByZW1vdmU6IFJFQ09SRF9GSUVMRF9LRVlTIH0pIH1cclxuICAgIDogeyByZW1vdmU6IEVMT19GSUVMRF9LRVlTIH07XHJcbiAgY29uc3QgcmF0aW5nQmFjayA9IHZhbHVlID09PSBudWxsICYmIChjdXJyZW50LnJhdGluZzEwMCA/PyBudWxsKSAhPT0gcmF0aW5nMTAwID8gcmF0aW5nMTAwIDogdW5kZWZpbmVkO1xyXG4gIGlmIChhd2FpdCBzYXZlRWxvRmllbGRzKHNjZW5lLCB2YWx1ZSwgY3VzdG9tRmllbGRzLCBcInVuZG8gRUxPXCIsIHJhdGluZ0JhY2spKSB7XHJcbiAgICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g4oa2IFJlc3RvcmVkIHNjZW5lICR7c2NlbmUuaWR9IEVMTyAke3ZhbHVlID8gdmFsdWUuZWxvIDogXCIodW5yYXRlZClcIn1gKTtcclxuICB9XHJcbn1cclxuXHJcbi8qKiBSZW1vdmUgYSBzY2VuZSdzIEVMTyBmaWVsZHMsIG1ha2luZyBpdCB1bnJhdGVkIGFnYWluLiAqL1xyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY2xlYXJFbG8oc2NlbmU6IFNjZW5lKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgaWYgKGF3YWl0IHNhdmVFbG9GaWVsZHMoc2NlbmUsIG51bGwsIHsgcmVtb3ZlOiBFTE9fRklFTERfS0VZUyB9LCBcImNsZWFyIEVMT1wiKSkge1xyXG4gICAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIPCfk50gQ2xlYXJlZCBzY2VuZSAke3NjZW5lLmlkfSBFTE9gKTtcclxuICB9XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBXcml0ZSBTdGFzaCByYXRpbmdzIChzY2VuZSBpZCB0byAxLTEwMCkgaW4gb25lIEdyYXBoUUwgcmVxdWVzdDogb25lIGFsaWFzZWQgYnVsa1NjZW5lVXBkYXRlXHJcbiAqIHBlciBkaXN0aW5jdCB2YWx1ZS4gVGhyb3dzIG9uIGZhaWx1cmU7IGRvZXNuJ3QgdG91Y2ggdGhlIGNhY2hlLiBXcml0ZXMgbm90aGluZyBpbiB0ZXN0IG1vZGUuXHJcbiAqL1xyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gd3JpdGVTdGFzaFJhdGluZ3MocmF0aW5nczogTWFwPHN0cmluZywgbnVtYmVyPik6IFByb21pc2U8dm9pZD4ge1xyXG4gIGlmIChzdGF0ZS5zZXR0aW5ncy50ZXN0TW9kZSkge1xyXG4gICAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIPCfp6ogVGVzdCBtb2RlOiBub3Qgc2F2aW5nICR7cmF0aW5ncy5zaXplfSBTdGFzaCByYXRpbmdzYCk7XHJcbiAgICByZXR1cm47XHJcbiAgfVxyXG4gIGNvbnN0IGlkc0J5UmF0aW5nID0gbmV3IE1hcDxudW1iZXIsIHN0cmluZ1tdPigpO1xyXG4gIGZvciAoY29uc3QgW2lkLCByYXRpbmddIG9mIHJhdGluZ3MpIHtcclxuICAgIGNvbnN0IGlkcyA9IGlkc0J5UmF0aW5nLmdldChyYXRpbmcpID8/IFtdO1xyXG4gICAgaWRzLnB1c2goaWQpO1xyXG4gICAgaWRzQnlSYXRpbmcuc2V0KHJhdGluZywgaWRzKTtcclxuICB9XHJcbiAgaWYgKGlkc0J5UmF0aW5nLnNpemUgPT09IDApIHJldHVybjtcclxuXHJcbiAgY29uc3QgdmFsdWVzID0gWy4uLmlkc0J5UmF0aW5nLmtleXMoKV07XHJcbiAgY29uc3QgbXV0YXRpb24gPSBgXHJcbiAgICAgIG11dGF0aW9uIFN5bmNTdGFzaFJhdGluZ3MoJHt2YWx1ZXMubWFwKChyKSA9PiBgJHIke3J9OiBCdWxrU2NlbmVVcGRhdGVJbnB1dCFgKS5qb2luKFwiLCBcIil9KSB7XHJcbiAgICAgICAgJHt2YWx1ZXMubWFwKChyKSA9PiBgciR7cn06IGJ1bGtTY2VuZVVwZGF0ZShpbnB1dDogJHIke3J9KSB7IGlkIH1gKS5qb2luKFwiXFxuICAgICAgICBcIil9XHJcbiAgICAgIH1cclxuICAgIGA7XHJcbiAgY29uc3QgdmFyaWFibGVzID0gT2JqZWN0LmZyb21FbnRyaWVzKFxyXG4gICAgdmFsdWVzLm1hcCgocikgPT4gW2ByJHtyfWAsIHsgaWRzOiBpZHNCeVJhdGluZy5nZXQociksIHJhdGluZzEwMDogciB9XSksXHJcbiAgKTtcclxuICBhd2FpdCBncmFwaHFsUXVlcnkobXV0YXRpb24sIHZhcmlhYmxlcyk7XHJcbiAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIPCfk50gV3JvdGUgJHtyYXRpbmdzLnNpemV9IFN0YXNoIHJhdGluZ3MgKCR7dmFsdWVzLmxlbmd0aH0gZGlzdGluY3QgdmFsdWVzKWApO1xyXG59XHJcblxyXG4vKiogQWZ0ZXIgU3Rhc2ggcmF0aW5ncyB3ZXJlIHdyaXR0ZW46IHVwZGF0ZSB0aGUgY2FjaGVkIHNjZW5lcyBhbmQgU3Rhc2gncyBvd24gcGFnZSBjYWNoZS4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGFwcGx5U3Rhc2hSYXRpbmdzKHJhdGluZ3M6IE1hcDxzdHJpbmcsIG51bWJlcj4pOiB2b2lkIHtcclxuICBzZXRSYXRpbmdzSW5DYWNoZShyYXRpbmdzKTtcclxuICAvLyBUZXN0IG1vZGUgd3JvdGUgbm90aGluZzogU3Rhc2gncyBwYWdlcyBrZWVwIHdoYXQncyBzYXZlZFxyXG4gIGlmIChzdGF0ZS5zZXR0aW5ncy50ZXN0TW9kZSkgcmV0dXJuO1xyXG4gIHJlZnJlc2hTdGFzaENhY2hlKFxyXG4gICAgWy4uLnJhdGluZ3NdLm1hcCgoW2lkLCByYXRpbmcxMDBdKSA9PiAoeyBpZCwgcmF0aW5nMTAwIH0pKSxcclxuICAgIHJhdGluZ3Muc2l6ZSA+IDAsXHJcbiAgKTtcclxufVxyXG5cclxuLyoqIFdhaXQgdGhpcyBsb25nIGFmdGVyIHRoZSBsYXN0IEVMTyB3cml0ZSwgc28gYm90aCBzY2VuZXMgb2YgYSBwaWNrIHN5bmMgaW4gb25lIHJlcXVlc3QuICovXHJcbmNvbnN0IFNZTkNfREVCT1VOQ0VfTVMgPSA1MDA7XHJcbmxldCBzeW5jVGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XHJcblxyXG4vKiogU3luYyBTdGFzaCByYXRpbmdzIHNvb24gKGRlYm91bmNlZCksIHVubGVzcyB0aGUgXCJTdGFzaCByYXRpbmdzXCIgc2V0dGluZyBpcyBcIm9mZlwiLiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gc2NoZWR1bGVTdGFzaFJhdGluZ1N5bmMoKTogdm9pZCB7XHJcbiAgaWYgKHN0YXRlLnNldHRpbmdzLnN0YXNoUmF0aW5ncyA9PT0gXCJvZmZcIikgcmV0dXJuO1xyXG4gIGlmIChzeW5jVGltZXIpIGNsZWFyVGltZW91dChzeW5jVGltZXIpO1xyXG4gIHN5bmNUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xyXG4gICAgc3luY1RpbWVyID0gbnVsbDtcclxuICAgIHZvaWQgc3luY1N0YXNoUmF0aW5ncygpO1xyXG4gIH0sIFNZTkNfREVCT1VOQ0VfTVMpO1xyXG59XHJcblxyXG4vKiogVGhlIFN0YXNoIHJhdGluZyB3cml0ZSBpbiBwcm9ncmVzcyAob3IgdGhlIGxhc3Qgb25lKSwgc28gdGhlIG5leHQgd2FpdHMgZm9yIGl0LiAqL1xyXG5sZXQgcmF0aW5nV3JpdGVzOiBQcm9taXNlPHVua25vd24+ID0gUHJvbWlzZS5yZXNvbHZlKCk7XHJcblxyXG4vKipcclxuICogUnVuIGEgU3Rhc2ggcmF0aW5ncyB3cml0ZSBhZnRlciBhbnkgaW4gcHJvZ3Jlc3MsIHNvIGVhY2ggb25lIHN0YXJ0cyBmcm9tIHRoZSByYXRpbmdzIHRoZVxyXG4gKiBwcmV2aW91cyBvbmUgd3JvdGUgKG92ZXJsYXBwaW5nIHdyaXRlcyBjb3VsZCByZXBlYXQgd29yayBvciBmaW5pc2ggb3V0IG9mIG9yZGVyKS5cclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBxdWV1ZVJhdGluZ1dyaXRlPFQ+KHRhc2s6ICgpID0+IFByb21pc2U8VD4pOiBQcm9taXNlPFQ+IHtcclxuICBjb25zdCBydW4gPSByYXRpbmdXcml0ZXMudGhlbih0YXNrKTtcclxuICByYXRpbmdXcml0ZXMgPSBydW4uY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcclxuICByZXR1cm4gcnVuO1xyXG59XHJcblxyXG4vKipcclxuICogQnJpbmcgU3Rhc2ggcmF0aW5ncyBpbiBsaW5lIHdpdGggRUxPIGZvciB0aGUgd2hvbGUgbGlicmFyeSAodGhlIGFsbC1zY2VuZXMgY2FjaGUpOiB3b3JrIG91dFxyXG4gKiBldmVyeSBzY2VuZSdzIHRhcmdldCB1bmRlciB0aGUgY3VycmVudCBzZXR0aW5nLCBhbmQgd3JpdGUgb25seSB0aGUgb25lcyB0aGF0IGRpZmZlciBmcm9tIHRoZVxyXG4gKiBjYWNoZWQgcmF0aW5nLCBpbiBvbmUgcmVxdWVzdC4gUXVldWVkIGJlaGluZCBhbnkgd3JpdGUgaW4gcHJvZ3Jlc3MuIFJldHVybnMgaG93IG1hbnkgd2VyZSB3cml0dGVuLlxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHN5bmNTdGFzaFJhdGluZ3MoKTogUHJvbWlzZTxudW1iZXI+IHtcclxuICByZXR1cm4gcXVldWVSYXRpbmdXcml0ZShhc3luYyAoKSA9PiB7XHJcbiAgICBjb25zdCBtb2RlID0gc3RhdGUuc2V0dGluZ3Muc3Rhc2hSYXRpbmdzO1xyXG4gICAgY29uc3Qgc2NlbmVzID0gc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzO1xyXG4gICAgaWYgKG1vZGUgPT09IFwib2ZmXCIgfHwgIXNjZW5lcykgcmV0dXJuIDA7XHJcbiAgICBjb25zdCBjaGFuZ2VzID0gc3Rhc2hSYXRpbmdDaGFuZ2VzKHNjZW5lcywgbW9kZSk7XHJcbiAgICBpZiAoY2hhbmdlcy5zaXplID09PSAwKSByZXR1cm4gMDtcclxuICAgIHRyeSB7XHJcbiAgICAgIGF3YWl0IHdyaXRlU3Rhc2hSYXRpbmdzKGNoYW5nZXMpO1xyXG4gICAgICBhcHBseVN0YXNoUmF0aW5ncyhjaGFuZ2VzKTtcclxuICAgICAgcmV0dXJuIGNoYW5nZXMuc2l6ZTtcclxuICAgIH0gY2F0Y2ggKGUpIHtcclxuICAgICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIEZhaWxlZCB0byBzeW5jIFN0YXNoIHJhdGluZ3M6XCIsIGUpO1xyXG4gICAgICByZXR1cm4gMDtcclxuICAgIH1cclxuICB9KTtcclxufVxyXG4iLCAiLy8gT25lLXRpbWUgRUxPIHNldHVwOiBnaXZlIGV2ZXJ5IHNjZW5lIGEgc3RhcnRpbmcgRUxPIChmcm9tIGl0cyBTdGFzaCByYXRpbmcsIG9yIDE1MDAgZm9yIGFsbCksXHJcbi8vIHRoZW4gb3B0aW9uYWxseSBzeW5jIFN0YXNoIHJhdGluZ3MgZnJvbSB0aGUgbmV3IEVMTy4gUmUtcnVubmluZyBpdCBvdmVyd3JpdGVzLCBzbyBhblxyXG4vLyBpbnRlcnJ1cHRlZCBzZXR1cCBpcyBzYWZlIHRvIHJlcGVhdC5cclxuXHJcbmltcG9ydCB7IEVMT19GSUVMRF9LRVlTLCBFTE9fU1RBUlQsIFJFQ09SRF9GSUVMRF9LRVlTIH0gZnJvbSBcIi4vY29uc3RhbnRzXCI7XHJcbmltcG9ydCB7IGdyYXBocWxRdWVyeSwgcmVmcmVzaFN0YXNoQ2FjaGUgfSBmcm9tIFwiLi9ncmFwaHFsXCI7XHJcbmltcG9ydCB7IHdyaXRlU3Rhc2hSYXRpbmdzIH0gZnJvbSBcIi4vcmF0aW5nXCI7XHJcbmltcG9ydCB7IGNsZWFySGFsbE9mRmFtZSB9IGZyb20gXCIuL3NldHRpbmdzXCI7XHJcbmltcG9ydCB7IGFmdGVyU2V0dXAsIGVsb0N1c3RvbUZpZWxkcywgaXNSYXRlZCwgc2VlZCwgc3RhcnRpbmdFbG8sIHN0YXNoUmF0aW5nQ2hhbmdlcyB9IGZyb20gXCIuL3Njb3JlXCI7XHJcbmltcG9ydCB7IHN0YXRlIH0gZnJvbSBcIi4vc3RhdGVcIjtcclxuaW1wb3J0IHR5cGUgeyBFbG9TdGFydCwgU2NlbmUsIFN0YXNoUmF0aW5nc01vZGUgfSBmcm9tIFwiLi90eXBlc1wiO1xyXG5cclxuZXhwb3J0IHR5cGUgU2V0dXBQaGFzZSA9IFwiZWxvXCIgfCBcInJhdGluZ3NcIjtcclxuXHJcbi8qKiBQcm9ncmVzcyBjYWxsYmFjazogYGRvbmVgIG9mIGB0b3RhbGAgc2NlbmVzIGZpbmlzaGVkIGluIHRoaXMgcGhhc2UuICovXHJcbmV4cG9ydCB0eXBlIFNldHVwUHJvZ3Jlc3MgPSAocGhhc2U6IFNldHVwUGhhc2UsIGRvbmU6IG51bWJlciwgdG90YWw6IG51bWJlcikgPT4gdm9pZDtcclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgU2V0dXBTdW1tYXJ5IHtcclxuICBlbG9Xcml0dGVuOiBudW1iZXI7IC8vIFNjZW5lcyBnaXZlbiBhIHN0YXJ0aW5nIEVMT1xyXG4gIGVsb0NsZWFyZWQ6IG51bWJlcjsgLy8gU2NlbmVzIHdob3NlIG9sZCBFTE8gd2FzIHJlbW92ZWQgKHJlLXJ1biB3aXRoIFwiVXNlIG15IHJhdGluZ3NcIilcclxuICByYXRpbmdzV3JpdHRlbjogbnVtYmVyOyAvLyBTdGFzaCByYXRpbmdzIGNoYW5nZWRcclxufVxyXG5cclxuY29uc3QgU0VUVVBfU0NFTkVTX1FVRVJZID0gYFxyXG4gICAgICBxdWVyeSBGaW5kU2NlbmVzRm9yRWxvU2V0dXAge1xyXG4gICAgICAgIGZpbmRTY2VuZXMoZmlsdGVyOiB7IHBlcl9wYWdlOiAtMSB9KSB7XHJcbiAgICAgICAgICBzY2VuZXMge1xyXG4gICAgICAgICAgICBpZFxyXG4gICAgICAgICAgICByYXRpbmcxMDBcclxuICAgICAgICAgICAgY3VzdG9tX2ZpZWxkc1xyXG4gICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgICAgfVxyXG4gICAgYDtcclxuXHJcbi8qKiBFdmVyeSBzY2VuZSdzIGlkLCBTdGFzaCByYXRpbmcgYW5kIGN1c3RvbSBmaWVsZHMsIGZyZXNoIGZyb20gU3Rhc2ggKG5vdCB0aGUgNS1taW51dGUgY2FjaGUpLiAqL1xyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmV0Y2hTZXR1cFNjZW5lcygpOiBQcm9taXNlPFNjZW5lW10+IHtcclxuICBjb25zdCBkYXRhID0gYXdhaXQgZ3JhcGhxbFF1ZXJ5PHsgZmluZFNjZW5lczogeyBzY2VuZXM6IFNjZW5lW10gfSB9PihTRVRVUF9TQ0VORVNfUVVFUlkpO1xyXG4gIHJldHVybiBkYXRhLmZpbmRTY2VuZXMuc2NlbmVzID8/IFtdO1xyXG59XHJcblxyXG4vKiogVGhlIFN0YXNoIHJhdGluZ3MgdGhlIHNldHVwIHdvdWxkIGNoYW5nZTogc2NlbmUgaWQgdG8gbmV3IHJhdGluZyAobm9uZSBmb3IgXCJvZmZcIikuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBzZXR1cFJhdGluZ0NoYW5nZXMoc2NlbmVzOiBTY2VuZVtdLCBzdGFydDogRWxvU3RhcnQsIHN0YXNoUmF0aW5nczogU3Rhc2hSYXRpbmdzTW9kZSk6IE1hcDxzdHJpbmcsIG51bWJlcj4ge1xyXG4gIHJldHVybiBzdGFzaFJhdGluZ0NoYW5nZXMoXHJcbiAgICBzY2VuZXMubWFwKChzY2VuZSkgPT4gYWZ0ZXJTZXR1cChzY2VuZSwgc3RhcnQpKSxcclxuICAgIHN0YXNoUmF0aW5ncyxcclxuICApO1xyXG59XHJcblxyXG5jb25zdCBCVUxLX1VQREFURV9NVVRBVElPTiA9IGBcclxuICAgICAgbXV0YXRpb24gQnVsa1NjZW5lVXBkYXRlKCRpbnB1dDogQnVsa1NjZW5lVXBkYXRlSW5wdXQhKSB7XHJcbiAgICAgICAgYnVsa1NjZW5lVXBkYXRlKGlucHV0OiAkaW5wdXQpIHtcclxuICAgICAgICAgIGlkXHJcbiAgICAgICAgfVxyXG4gICAgICB9XHJcbiAgICBgO1xyXG5cclxuLyoqXHJcbiAqIFNlZWQgZWFjaCByYXRlZCBzY2VuZSBmcm9tIGl0cyBvd24gcmF0aW5nLiBTY2VuZXMgd2l0aCB0aGUgc2FtZSBTdGFzaCByYXRpbmcgZ2V0IHRoZSBzYW1lXHJcbiAqIHN0YXJ0aW5nIGZpZWxkcywgc28gaXQncyBvbmUgYWxpYXNlZCBidWxrU2NlbmVVcGRhdGUgcGVyIGRpc3RpbmN0IHJhdGluZywgYWxsIGluIG9uZSByZXF1ZXN0LlxyXG4gKi9cclxuYXN5bmMgZnVuY3Rpb24gc2VlZEZyb21SYXRpbmdzKHJhdGVkOiBTY2VuZVtdKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgY29uc3QgaWRzQnlSYXRpbmcgPSBuZXcgTWFwPG51bWJlciwgc3RyaW5nW10+KCk7XHJcbiAgZm9yIChjb25zdCBzY2VuZSBvZiByYXRlZCkge1xyXG4gICAgY29uc3QgcmF0aW5nID0gc2NlbmUucmF0aW5nMTAwIGFzIG51bWJlcjtcclxuICAgIGNvbnN0IGlkcyA9IGlkc0J5UmF0aW5nLmdldChyYXRpbmcpID8/IFtdO1xyXG4gICAgaWRzLnB1c2goc2NlbmUuaWQpO1xyXG4gICAgaWRzQnlSYXRpbmcuc2V0KHJhdGluZywgaWRzKTtcclxuICB9XHJcbiAgaWYgKGlkc0J5UmF0aW5nLnNpemUgPT09IDApIHJldHVybjtcclxuXHJcbiAgY29uc3QgdmFsdWVzID0gWy4uLmlkc0J5UmF0aW5nLmtleXMoKV07XHJcbiAgY29uc3QgbXV0YXRpb24gPSBgXHJcbiAgICAgIG11dGF0aW9uIFNlZWRFbG8oJHt2YWx1ZXMubWFwKChyKSA9PiBgJHMke3J9OiBCdWxrU2NlbmVVcGRhdGVJbnB1dCFgKS5qb2luKFwiLCBcIil9KSB7XHJcbiAgICAgICAgJHt2YWx1ZXMubWFwKChyKSA9PiBgcyR7cn06IGJ1bGtTY2VuZVVwZGF0ZShpbnB1dDogJHMke3J9KSB7IGlkIH1gKS5qb2luKFwiXFxuICAgICAgICBcIil9XHJcbiAgICAgIH1cclxuICAgIGA7XHJcbiAgY29uc3QgdmFyaWFibGVzID0gT2JqZWN0LmZyb21FbnRyaWVzKFxyXG4gICAgdmFsdWVzLm1hcCgocikgPT4ge1xyXG4gICAgICBjb25zdCBwYXJ0aWFsID0gZWxvQ3VzdG9tRmllbGRzKHsgZWxvOiBzZWVkKHIpLCBiYXR0bGVzOiAwLCBzZWVkZWQ6IHRydWUgfSk7XHJcbiAgICAgIC8vIFJlY29yZHMgc3RhcnQgb3ZlciB0b28gKHNldHVwIGFuZCBSZXNldCBFTE8pXHJcbiAgICAgIHJldHVybiBbYHMke3J9YCwgeyBpZHM6IGlkc0J5UmF0aW5nLmdldChyKSwgY3VzdG9tX2ZpZWxkczogeyBwYXJ0aWFsLCByZW1vdmU6IFJFQ09SRF9GSUVMRF9LRVlTIH0gfV07XHJcbiAgICB9KSxcclxuICApO1xyXG4gIGF3YWl0IGdyYXBocWxRdWVyeShtdXRhdGlvbiwgdmFyaWFibGVzKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIFJ1biB0aGUgc2V0dXAgb24gYHNjZW5lc2AgKGZyb20gZmV0Y2hTZXR1cFNjZW5lcyk6IHdyaXRlIHRoZSBzdGFydGluZyBFTE8sIHRoZW4sIHVubGVzc1xyXG4gKiBzdGFzaFJhdGluZ3MgaXMgXCJvZmZcIiwgdGhlIFN0YXNoIHJhdGluZ3MgdGhhdCBjaGFuZ2UuIFRocm93cyBpZiBhIHJlcXVlc3QgZmFpbHM7IHdoYXRldmVyXHJcbiAqIHdhcyB3cml0dGVuIGJ5IHRoZW4gc3RheXMsIGFuZCBydW5uaW5nIGl0IGFnYWluIG92ZXJ3cml0ZXMgaXQuXHJcbiAqL1xyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcnVuRWxvU2V0dXAoXHJcbiAgc2NlbmVzOiBTY2VuZVtdLFxyXG4gIHN0YXJ0OiBFbG9TdGFydCxcclxuICBzdGFzaFJhdGluZ3M6IFN0YXNoUmF0aW5nc01vZGUsXHJcbiAgb25Qcm9ncmVzczogU2V0dXBQcm9ncmVzcyxcclxuKTogUHJvbWlzZTxTZXR1cFN1bW1hcnk+IHtcclxuICAvLyBJdCByZXdyaXRlcyB0aGUgd2hvbGUgbGlicmFyeSwgd2hpY2ggdGVzdCBtb2RlIGNhbid0IGtlZXAgaW4gdGhpcyB0YWIgb25seVxyXG4gIGlmIChzdGF0ZS5zZXR0aW5ncy50ZXN0TW9kZSkgdGhyb3cgbmV3IEVycm9yKFwiVGVzdCBtb2RlIGlzIG9uOiB0dXJuIGl0IG9mZiBpbiBTZXR0aW5ncyB0byBzZXQgdXAgRUxPLlwiKTtcclxuICBjb25zdCBzdW1tYXJ5OiBTZXR1cFN1bW1hcnkgPSB7IGVsb1dyaXR0ZW46IDAsIGVsb0NsZWFyZWQ6IDAsIHJhdGluZ3NXcml0dGVuOiAwIH07XHJcblxyXG4gIGlmIChzdGFydCA9PT0gXCJyYXRpbmdzXCIpIHtcclxuICAgIGNvbnN0IHJhdGVkID0gc2NlbmVzLmZpbHRlcigoc2NlbmUpID0+IHNjZW5lLnJhdGluZzEwMCAhPSBudWxsKTtcclxuICAgIG9uUHJvZ3Jlc3MoXCJlbG9cIiwgMCwgcmF0ZWQubGVuZ3RoKTtcclxuICAgIGF3YWl0IHNlZWRGcm9tUmF0aW5ncyhyYXRlZCk7XHJcbiAgICBvblByb2dyZXNzKFwiZWxvXCIsIHJhdGVkLmxlbmd0aCwgcmF0ZWQubGVuZ3RoKTtcclxuICAgIHN1bW1hcnkuZWxvV3JpdHRlbiA9IHJhdGVkLmxlbmd0aDtcclxuXHJcbiAgICAvLyBPbmx5IG1hdHRlcnMgb24gYSByZS1ydW46IHNjZW5lcyB3aXRoIGFuIEVMTyBidXQgbm8gU3Rhc2ggcmF0aW5nIGJlY29tZSB1bnJhdGVkIGFnYWluXHJcbiAgICBjb25zdCBzdGFsZSA9IHNjZW5lcy5maWx0ZXIoKHNjZW5lKSA9PiBzY2VuZS5yYXRpbmcxMDAgPT0gbnVsbCAmJiBpc1JhdGVkKHNjZW5lKSkubWFwKChzY2VuZSkgPT4gc2NlbmUuaWQpO1xyXG4gICAgaWYgKHN0YWxlLmxlbmd0aCA+IDApIHtcclxuICAgICAgYXdhaXQgZ3JhcGhxbFF1ZXJ5KEJVTEtfVVBEQVRFX01VVEFUSU9OLCB7XHJcbiAgICAgICAgaW5wdXQ6IHsgaWRzOiBzdGFsZSwgY3VzdG9tX2ZpZWxkczogeyByZW1vdmU6IEVMT19GSUVMRF9LRVlTIH0gfSxcclxuICAgICAgfSk7XHJcbiAgICAgIHN1bW1hcnkuZWxvQ2xlYXJlZCA9IHN0YWxlLmxlbmd0aDtcclxuICAgIH1cclxuICB9IGVsc2Uge1xyXG4gICAgY29uc3QgaWRzID0gc2NlbmVzLm1hcCgoc2NlbmUpID0+IHNjZW5lLmlkKTtcclxuICAgIG9uUHJvZ3Jlc3MoXCJlbG9cIiwgMCwgaWRzLmxlbmd0aCk7XHJcbiAgICBpZiAoaWRzLmxlbmd0aCA+IDApIHtcclxuICAgICAgYXdhaXQgZ3JhcGhxbFF1ZXJ5KEJVTEtfVVBEQVRFX01VVEFUSU9OLCB7XHJcbiAgICAgICAgaW5wdXQ6IHtcclxuICAgICAgICAgIGlkcyxcclxuICAgICAgICAgIGN1c3RvbV9maWVsZHM6IHsgcGFydGlhbDogZWxvQ3VzdG9tRmllbGRzKHsgZWxvOiBFTE9fU1RBUlQsIGJhdHRsZXM6IDAsIHNlZWRlZDogZmFsc2UgfSksIHJlbW92ZTogUkVDT1JEX0ZJRUxEX0tFWVMgfSxcclxuICAgICAgICB9LFxyXG4gICAgICB9KTtcclxuICAgIH1cclxuICAgIG9uUHJvZ3Jlc3MoXCJlbG9cIiwgaWRzLmxlbmd0aCwgaWRzLmxlbmd0aCk7XHJcbiAgICBzdW1tYXJ5LmVsb1dyaXR0ZW4gPSBpZHMubGVuZ3RoO1xyXG4gIH1cclxuXHJcbiAgLy8gUmVjb3JkcyBzdGFydCBvdmVyIHdpdGggdGhlIEVMTywgdGhlIGhhbGwgb2YgZmFtZSB0b29cclxuICB0cnkge1xyXG4gICAgYXdhaXQgY2xlYXJIYWxsT2ZGYW1lKCk7XHJcbiAgfSBjYXRjaCAoZSkge1xyXG4gICAgY29uc29sZS53YXJuKFwiW1N0YXNoIEJhdHRsZV0gQ291bGRuJ3QgY2xlYXIgdGhlIGhhbGwgb2YgZmFtZTpcIiwgZSk7XHJcbiAgfVxyXG5cclxuICBjb25zdCBjaGFuZ2VzID0gc2V0dXBSYXRpbmdDaGFuZ2VzKHNjZW5lcywgc3RhcnQsIHN0YXNoUmF0aW5ncyk7XHJcbiAgaWYgKGNoYW5nZXMuc2l6ZSA+IDApIHtcclxuICAgIG9uUHJvZ3Jlc3MoXCJyYXRpbmdzXCIsIDAsIGNoYW5nZXMuc2l6ZSk7XHJcbiAgICBhd2FpdCB3cml0ZVN0YXNoUmF0aW5ncyhjaGFuZ2VzKTtcclxuICAgIG9uUHJvZ3Jlc3MoXCJyYXRpbmdzXCIsIGNoYW5nZXMuc2l6ZSwgY2hhbmdlcy5zaXplKTtcclxuICAgIHN1bW1hcnkucmF0aW5nc1dyaXR0ZW4gPSBjaGFuZ2VzLnNpemU7XHJcbiAgfVxyXG5cclxuICAvLyBTdGFzaCdzIG93biBwYWdlczogZXZlcnkgc2NlbmUncyBFTE8gKG9yIGl0cyByZW1vdmFsKSBhbmQgYW55IGNoYW5nZWQgcmF0aW5nXHJcbiAgcmVmcmVzaFN0YXNoQ2FjaGUoXHJcbiAgICBzY2VuZXMubWFwKChzY2VuZSkgPT4gKHsgaWQ6IHNjZW5lLmlkLCBlbG86IHN0YXJ0aW5nRWxvKHNjZW5lLCBzdGFydCksIHJhdGluZzEwMDogY2hhbmdlcy5nZXQoc2NlbmUuaWQpIH0pKSxcclxuICAgIGNoYW5nZXMuc2l6ZSA+IDAsXHJcbiAgKTtcclxuXHJcbiAgY29uc29sZS5sb2coXHJcbiAgICBgW1N0YXNoIEJhdHRsZV0g4pyFIEVMTyBzZXR1cCAoJHtzdGFydH0sIFN0YXNoIHJhdGluZ3MgJHtzdGFzaFJhdGluZ3N9KTogJHtzdW1tYXJ5LmVsb1dyaXR0ZW59IEVMTyB3cml0dGVuLCAke3N1bW1hcnkuZWxvQ2xlYXJlZH0gY2xlYXJlZCwgJHtzdW1tYXJ5LnJhdGluZ3NXcml0dGVufSBTdGFzaCByYXRpbmdzIHdyaXR0ZW5gLFxyXG4gICk7XHJcbiAgcmV0dXJuIHN1bW1hcnk7XHJcbn1cclxuIiwgIi8vIFBlcnNpc3QvcmVzdG9yZSB0aGUgYmF0dGxlIHNlc3Npb24gdG8gbG9jYWxTdG9yYWdlLlxuXG5pbXBvcnQgeyBTVE9SQUdFX0tFWSB9IGZyb20gXCIuL2NvbnN0YW50c1wiO1xuaW1wb3J0IHsgc2NlbmVzTGlzdFF1ZXJ5IH0gZnJvbSBcIi4vZmlsdGVyc1wiO1xuaW1wb3J0IHsgc3RhdGUgfSBmcm9tIFwiLi9zdGF0ZVwiO1xuaW1wb3J0IHR5cGUgeyBNb2RlLCBQYWlyLCBQbGFjZW1lbnRSdW4sIFJhbmtzLCBTY2VuZSB9IGZyb20gXCIuL3R5cGVzXCI7XG5cbi8qKlxuICogQnVtcGVkIHdoZW4gc2F2ZWQgc2Vzc2lvbnMgY2FuJ3QgYmUgcmVzdG9yZWQgYXMgdGhleSBhcmUuIDMgKDMuMCk6IHNjZW5lcyBhcmUgcmFua2VkIGJ5IEVMT1xuICogZnJvbSBjdXN0b20gZmllbGRzLCB3aGljaCBvbGRlciBzYXZlZCBzY2VuZXMgbGFjaywgYW5kIEdhdW50bGV0IHJ1bnMgbm8gbG9uZ2VyIGV4aXN0LlxuICovXG5jb25zdCBTVEFURV9WRVJTSU9OID0gMztcblxuY29uc3QgTU9ERVM6IHJlYWRvbmx5IE1vZGVbXSA9IFtcInN3aXNzXCIsIFwicGxhY2VtZW50XCIsIFwiY2hhbXBpb25cIl07XG5cbmludGVyZmFjZSBQZXJzaXN0ZWRTdGF0ZSB7XG4gIHZlcnNpb24/OiBudW1iZXI7XG4gIGN1cnJlbnRQYWlyPzogUGFpcjtcbiAgY3VycmVudFJhbmtzPzogUmFua3M7XG4gIGN1cnJlbnRNb2RlPzogc3RyaW5nO1xuICBjaGFtcGlvblNjZW5lPzogU2NlbmUgfCBudWxsO1xuICBjaGFtcGlvbldpbnM/OiBudW1iZXI7XG4gIGNoYW1waW9uRGVmZWF0ZWQ/OiBzdHJpbmdbXTtcbiAgcGxhY2VtZW50PzogUGxhY2VtZW50UnVuIHwgbnVsbDtcbiAgdG90YWxTY2VuZXNDb3VudD86IG51bWJlcjtcbiAgc2F2ZWRGaWx0ZXJQYXJhbXM/OiBzdHJpbmc7XG59XG5cbi8qKiBBIHNhdmVkIG1vZGUgbmFtZSBhcyBhIGN1cnJlbnQgbW9kZTogR2F1bnRsZXQgYmVjYW1lIFBsYWNlbWVudCdzIFwiU3RhcnQgZnJvbSB0aGUgYm90dG9tXCIuICovXG5mdW5jdGlvbiByZXN0b3JlTW9kZShzYXZlZDogc3RyaW5nIHwgdW5kZWZpbmVkKTogTW9kZSB7XG4gIGlmIChzYXZlZCA9PT0gXCJnYXVudGxldFwiKSByZXR1cm4gXCJwbGFjZW1lbnRcIjtcbiAgcmV0dXJuIE1PREVTLmluY2x1ZGVzKHNhdmVkIGFzIE1vZGUpID8gKHNhdmVkIGFzIE1vZGUpIDogXCJzd2lzc1wiO1xufVxuXG4vKiogU2F2ZXMgdGhlIGN1cnJlbnQgYmF0dGxlIHNlc3Npb24gdG8gbG9jYWxTdG9yYWdlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNhdmVTdGF0ZSgpOiB2b2lkIHtcbiAgY29uc3Qgc25hcHNob3Q6IFBlcnNpc3RlZFN0YXRlID0ge1xuICAgIHZlcnNpb246IFNUQVRFX1ZFUlNJT04sXG4gICAgY3VycmVudFBhaXI6IHN0YXRlLmN1cnJlbnRQYWlyLFxuICAgIGN1cnJlbnRSYW5rczogc3RhdGUuY3VycmVudFJhbmtzLFxuICAgIGN1cnJlbnRNb2RlOiBzdGF0ZS5jdXJyZW50TW9kZSxcbiAgICBjaGFtcGlvblNjZW5lOiBzdGF0ZS5jaGFtcGlvblNjZW5lLFxuICAgIGNoYW1waW9uV2luczogc3RhdGUuY2hhbXBpb25XaW5zLFxuICAgIGNoYW1waW9uRGVmZWF0ZWQ6IHN0YXRlLmNoYW1waW9uRGVmZWF0ZWQsXG4gICAgcGxhY2VtZW50OiBzdGF0ZS5wbGFjZW1lbnQsXG4gICAgdG90YWxTY2VuZXNDb3VudDogc3RhdGUudG90YWxTY2VuZXNDb3VudCxcbiAgICBzYXZlZEZpbHRlclBhcmFtczogc2NlbmVzTGlzdFF1ZXJ5KCksXG4gIH07XG4gIHRyeSB7XG4gICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oU1RPUkFHRV9LRVksIEpTT04uc3RyaW5naWZ5KHNuYXBzaG90KSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0gRmFpbGVkIHRvIHNhdmUgc3RhdGU6XCIsIGUpO1xuICB9XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBsb2FkU3RhdGUoKTogYm9vbGVhbiB7XG4gIHRyeSB7XG4gICAgY29uc3Qgc2F2ZWQgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbShTVE9SQUdFX0tFWSk7XG4gICAgaWYgKHNhdmVkKSB7XG4gICAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHNhdmVkKSBhcyBQZXJzaXN0ZWRTdGF0ZTtcbiAgICAgIHN0YXRlLmN1cnJlbnRNb2RlID0gcmVzdG9yZU1vZGUocGFyc2VkLmN1cnJlbnRNb2RlKTtcbiAgICAgIHN0YXRlLnNhdmVkRmlsdGVyUGFyYW1zID0gcGFyc2VkLnNhdmVkRmlsdGVyUGFyYW1zIHx8IFwiXCI7XG4gICAgICBpZiAocGFyc2VkLnZlcnNpb24gIT09IFNUQVRFX1ZFUlNJT04pIHtcbiAgICAgICAgLy8gT2xkZXIgc2Vzc2lvbnMgaG9sZCBzY2VuZXMgd2l0aG91dCBFTE86IGtlZXAgdGhlIG1vZGUsIHN0YXJ0IGEgZnJlc2ggcGFpciBhbmQgcnVuXG4gICAgICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+TiyBTYXZlZCBzZXNzaW9uIGlzIGZyb20gYW4gb2xkZXIgdmVyc2lvbiwgc3RhcnRpbmcgZnJlc2hcIik7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfVxuICAgICAgc3RhdGUuY3VycmVudFBhaXIgPSBwYXJzZWQuY3VycmVudFBhaXIgfHwgeyBsZWZ0OiBudWxsLCByaWdodDogbnVsbCB9O1xuICAgICAgc3RhdGUuY3VycmVudFJhbmtzID0gcGFyc2VkLmN1cnJlbnRSYW5rcyB8fCB7IGxlZnQ6IG51bGwsIHJpZ2h0OiBudWxsIH07XG4gICAgICBzdGF0ZS5jaGFtcGlvblNjZW5lID0gcGFyc2VkLmNoYW1waW9uU2NlbmUgPz8gbnVsbDtcbiAgICAgIHN0YXRlLmNoYW1waW9uV2lucyA9IHBhcnNlZC5jaGFtcGlvbldpbnMgfHwgMDtcbiAgICAgIHN0YXRlLmNoYW1waW9uRGVmZWF0ZWQgPSBwYXJzZWQuY2hhbXBpb25EZWZlYXRlZCB8fCBbXTtcbiAgICAgIHN0YXRlLnBsYWNlbWVudCA9IHBhcnNlZC5wbGFjZW1lbnQgfHwgbnVsbDtcbiAgICAgIHN0YXRlLnRvdGFsU2NlbmVzQ291bnQgPSBwYXJzZWQudG90YWxTY2VuZXNDb3VudCB8fCAwO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIEZhaWxlZCB0byBsb2FkIHN0YXRlOlwiLCBlKTtcbiAgfVxuICByZXR1cm4gZmFsc2U7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjbGVhclN0YXRlKCk6IHZvaWQge1xuICB0cnkge1xuICAgIGxvY2FsU3RvcmFnZS5yZW1vdmVJdGVtKFNUT1JBR0VfS0VZKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnNvbGUuZXJyb3IoXCJbU3Rhc2ggQmF0dGxlXSBGYWlsZWQgdG8gY2xlYXIgc3RhdGU6XCIsIGUpO1xuICB9XG59XG4iLCAiLy8gQSBzbWFsbCBjb25maXJtYXRpb24gZGlhbG9nIGluc2lkZSB0aGUgU3Rhc2ggQmF0dGxlIG1vZGFsIChzd2l0Y2hpbmcgU3Rhc2ggcmF0aW5ncywgUmVzZXQgRUxPKS5cbi8vIFRoZSBjb25maXJtIGJ1dHRvbiBjYW4gcnVuIGFuIGFzeW5jIGFjdGlvbjogdGhlIGRpYWxvZyBzdGF5cyBvcGVuIHdoaWxlIGl0IHJ1bnMsIGNsb3NlcyB3aGVuXG4vLyBpdCBzdWNjZWVkcywgYW5kIHNob3dzIHRoZSBlcnJvciBpZiBpdCBmYWlscy5cblxuZXhwb3J0IGludGVyZmFjZSBDb25maXJtRGlhbG9nT3B0aW9ucyB7XG4gIHRpdGxlOiBzdHJpbmc7XG4gIC8qKiBIVE1MIGJvZHkuICovXG4gIGJvZHk6IHN0cmluZztcbiAgY29uZmlybUxhYmVsOiBzdHJpbmc7XG4gIC8qKiBMYWJlbCBvbiB0aGUgY29uZmlybSBidXR0b24gd2hpbGUgYGFjdGlvbmAgcnVucy4gKi9cbiAgd29ya2luZ0xhYmVsPzogc3RyaW5nO1xuICAvKiogUnVucyBvbiBjb25maXJtOyB0aGUgZGlhbG9nIHJlc29sdmVzIHRydWUgb25seSBvbmNlIGl0IHN1Y2NlZWRzLiAqL1xuICBhY3Rpb24/OiAoKSA9PiBQcm9taXNlPHZvaWQ+O1xufVxuXG5sZXQgY2FuY2VsT3BlbjogKCgpID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0NvbmZpcm1EaWFsb2dPcGVuKCk6IGJvb2xlYW4ge1xuICByZXR1cm4gY2FuY2VsT3BlbiAhPT0gbnVsbDtcbn1cblxuLyoqIENhbmNlbCB0aGUgb3BlbiBkaWFsb2cgKEVzY2FwZSksIHVubGVzcyBpdHMgYWN0aW9uIGlzIHJ1bm5pbmcuICovXG5leHBvcnQgZnVuY3Rpb24gY2FuY2VsQ29uZmlybURpYWxvZygpOiB2b2lkIHtcbiAgY2FuY2VsT3Blbj8uKCk7XG59XG5cbi8qKiBTaG93IHRoZSBkaWFsb2c7IHJlc29sdmVzIHRydWUgd2hlbiBjb25maXJtZWQgKGFuZCBpdHMgYWN0aW9uIHN1Y2NlZWRlZCksIGZhbHNlIHdoZW4gY2FuY2VsbGVkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNvbmZpcm1EaWFsb2cob3B0czogQ29uZmlybURpYWxvZ09wdGlvbnMpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgY2FuY2VsT3Blbj8uKCk7XG4gIGNvbnN0IGhvc3QgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInNiLW1vZGFsXCIpO1xuICBpZiAoIWhvc3QpIHJldHVybiBQcm9taXNlLnJlc29sdmUoZmFsc2UpO1xuXG4gIGNvbnN0IG92ZXJsYXkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBvdmVybGF5LmNsYXNzTmFtZSA9IFwic2ItZGlhbG9nLWJhY2tkcm9wXCI7XG4gIG92ZXJsYXkuaW5uZXJIVE1MID0gYFxuICAgICAgPGRpdiBjbGFzcz1cInNiLWRpYWxvZ1wiIHJvbGU9XCJkaWFsb2dcIiBhcmlhLW1vZGFsPVwidHJ1ZVwiIGFyaWEtbGFiZWxsZWRieT1cInNiLWRpYWxvZy10aXRsZVwiPlxuICAgICAgICA8aDMgaWQ9XCJzYi1kaWFsb2ctdGl0bGVcIiBjbGFzcz1cInNiLWRpYWxvZy10aXRsZVwiPiR7b3B0cy50aXRsZX08L2gzPlxuICAgICAgICA8ZGl2IGNsYXNzPVwic2ItZGlhbG9nLWJvZHlcIj4ke29wdHMuYm9keX08L2Rpdj5cbiAgICAgICAgPHAgY2xhc3M9XCJzYi1kaWFsb2ctZXJyb3JcIiBoaWRkZW4+PC9wPlxuICAgICAgICA8ZGl2IGNsYXNzPVwic2ItZGlhbG9nLWFjdGlvbnNcIj5cbiAgICAgICAgICA8YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cImJ0biBidG4tc2Vjb25kYXJ5XCIgZGF0YS1yb2xlPVwiY2FuY2VsXCI+Q2FuY2VsPC9idXR0b24+XG4gICAgICAgICAgPGJ1dHRvbiB0eXBlPVwiYnV0dG9uXCIgY2xhc3M9XCJidG4gYnRuLXByaW1hcnlcIiBkYXRhLXJvbGU9XCJjb25maXJtXCI+JHtvcHRzLmNvbmZpcm1MYWJlbH08L2J1dHRvbj5cbiAgICAgICAgPC9kaXY+XG4gICAgICA8L2Rpdj5gO1xuICBob3N0LmFwcGVuZENoaWxkKG92ZXJsYXkpO1xuXG4gIGNvbnN0IGNvbmZpcm1CdG4gPSBvdmVybGF5LnF1ZXJ5U2VsZWN0b3I8SFRNTEJ1dHRvbkVsZW1lbnQ+KCdbZGF0YS1yb2xlPVwiY29uZmlybVwiXScpIGFzIEhUTUxCdXR0b25FbGVtZW50O1xuICBjb25zdCBjYW5jZWxCdG4gPSBvdmVybGF5LnF1ZXJ5U2VsZWN0b3I8SFRNTEJ1dHRvbkVsZW1lbnQ+KCdbZGF0YS1yb2xlPVwiY2FuY2VsXCJdJykgYXMgSFRNTEJ1dHRvbkVsZW1lbnQ7XG4gIGNvbnN0IGVycm9yID0gb3ZlcmxheS5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIi5zYi1kaWFsb2ctZXJyb3JcIikgYXMgSFRNTEVsZW1lbnQ7XG4gIGNvbmZpcm1CdG4uZm9jdXMoKTtcblxuICByZXR1cm4gbmV3IFByb21pc2U8Ym9vbGVhbj4oKHJlc29sdmUpID0+IHtcbiAgICBsZXQgYnVzeSA9IGZhbHNlO1xuICAgIGNvbnN0IGNsb3NlID0gKHJlc3VsdDogYm9vbGVhbik6IHZvaWQgPT4ge1xuICAgICAgb3ZlcmxheS5yZW1vdmUoKTtcbiAgICAgIGNhbmNlbE9wZW4gPSBudWxsO1xuICAgICAgcmVzb2x2ZShyZXN1bHQpO1xuICAgIH07XG4gICAgY2FuY2VsT3BlbiA9ICgpID0+IHtcbiAgICAgIGlmICghYnVzeSkgY2xvc2UoZmFsc2UpO1xuICAgIH07XG5cbiAgICBjYW5jZWxCdG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IGNhbmNlbE9wZW4/LigpKTtcbiAgICBvdmVybGF5LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZSkgPT4ge1xuICAgICAgaWYgKGUudGFyZ2V0ID09PSBvdmVybGF5KSBjYW5jZWxPcGVuPy4oKTtcbiAgICB9KTtcbiAgICBjb25maXJtQnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBhc3luYyAoKSA9PiB7XG4gICAgICBpZiAoIW9wdHMuYWN0aW9uKSB7XG4gICAgICAgIGNsb3NlKHRydWUpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBidXN5ID0gdHJ1ZTtcbiAgICAgIGVycm9yLmhpZGRlbiA9IHRydWU7XG4gICAgICBjb25maXJtQnRuLmRpc2FibGVkID0gY2FuY2VsQnRuLmRpc2FibGVkID0gdHJ1ZTtcbiAgICAgIGNvbmZpcm1CdG4udGV4dENvbnRlbnQgPSBvcHRzLndvcmtpbmdMYWJlbCA/PyBcIldvcmtpbmcuLi5cIjtcbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IG9wdHMuYWN0aW9uKCk7XG4gICAgICAgIGNsb3NlKHRydWUpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBidXN5ID0gZmFsc2U7XG4gICAgICAgIGNvbmZpcm1CdG4uZGlzYWJsZWQgPSBjYW5jZWxCdG4uZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAgICAgY29uZmlybUJ0bi50ZXh0Q29udGVudCA9IG9wdHMuY29uZmlybUxhYmVsO1xuICAgICAgICBlcnJvci50ZXh0Q29udGVudCA9IGBUaGF0IGRpZG4ndCB3b3JrOiAke2UgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKX0uIFlvdSBjYW4gdHJ5IGFnYWluLmA7XG4gICAgICAgIGVycm9yLmhpZGRlbiA9IGZhbHNlO1xuICAgICAgfVxuICAgIH0pO1xuICB9KTtcbn1cbiIsICIvLyBTUEEgbmF2aWdhdGlvbiBoZWxwZXJzLlxyXG5cclxuaW1wb3J0IHsgY2xvc2VNb2RhbCB9IGZyb20gXCIuL3VpL21vZGFsXCI7XHJcblxyXG4vLyBOYXZpZ2F0ZSB1c2luZyBSZWFjdCBSb3V0ZXIgKHByZXNlcnZlcyBKUyBzdGF0ZSlcclxuZXhwb3J0IGZ1bmN0aW9uIG5hdmlnYXRlVG9VcmwodXJsOiBzdHJpbmcpOiB2b2lkIHtcclxuICBjbG9zZU1vZGFsKCk7XHJcblxyXG4gIC8vIFVzZSBIaXN0b3J5IEFQSSArIHBvcHN0YXRlIGV2ZW50IHRvIHRyaWdnZXIgUmVhY3QgUm91dGVyIG5hdmlnYXRpb25cclxuICBjb25zdCBwYXRoID0gdXJsLnN0YXJ0c1dpdGgoXCIvXCIpID8gdXJsIDogbmV3IFVSTCh1cmwpLnBhdGhuYW1lICsgbmV3IFVSTCh1cmwpLnNlYXJjaDtcclxuICB3aW5kb3cuaGlzdG9yeS5wdXNoU3RhdGUoe30sIFwiXCIsIHBhdGgpO1xyXG4gIHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBQb3BTdGF0ZUV2ZW50KFwicG9wc3RhdGVcIiwgeyBzdGF0ZToge30gfSkpO1xyXG59XHJcbiIsICIvLyBQbGFjZW1lbnQgc2VhcmNoLCBrZXB0IHB1cmUgKG5vIHN0YXRlIG9yIEkvTykgc28gd2hvbGUgcnVucyBjYW4gYmUgc2ltdWxhdGVkIGluIHRlc3RzLlxuLy9cbi8vIFRoZSBzY2VuZSdzIHNsb3QgbGllcyBpbiBbbG8sIGhpKSBvZiB0aGUgRUxPLXNvcnRlZCBvcHBvbmVudCBwb29sLiBBIHdpbiBhZ2FpbnN0IGluZGV4IGlcbi8vIG1lYW5zIHRoZSBzbG90IGlzIGFib3ZlIGkgKGhpID0gaSk7IGEgbG9zcyBtZWFucyBpdCdzIGJlbG93IChsbyA9IGkgKyAxKS4gQSByYXRlZCBzY2VuZSBzdGFydHNcbi8vIG5leHQgdG8gaXRzIGN1cnJlbnQgRUxPIGFuZCBnYWxsb3BzIChzdGVwcyAxLCAyLCA0LCA4Li4uKSB3aGlsZSByZXN1bHRzIGtlZXAgZ29pbmcgdGhlIHNhbWVcbi8vIHdheTsgdGhlIGZpcnN0IHJldmVyc2FsIChvciBhbiB1bnJhdGVkIHNjZW5lKSBzd2l0Y2hlcyB0byBoYWx2aW5nIHRoZSByZW1haW5pbmcgcmFuZ2UuXG4vLyBcIlN0YXJ0IGZyb20gdGhlIGJvdHRvbVwiIHJ1bnMgaWdub3JlIHRoZSBzY2VuZSdzIEVMTzogdGhleSBzdGFydCBhZ2FpbnN0IHRoZSBib3R0b20gc2NlbmUgYW5kXG4vLyBnYWxsb3AgdXB3YXJkLCBzbyBlYWNoIHdpbiBkb3VibGVzIHRoZSBqdW1wIHVudGlsIHRoZSBmaXJzdCBsb3NzLlxuXG5pbXBvcnQgeyBQTEFDRU1FTlRfTUFYX0pVTVBfU0hBUkUsIFBMQUNFTUVOVF9NSU5fTUFYX0pVTVAgfSBmcm9tIFwiLi9jb25zdGFudHNcIjtcbmltcG9ydCB7IGVsbywgZWxvSW5zZXJ0aW9uSW5kZXgsIHBsYWNlbWVudEVsbyB9IGZyb20gXCIuL3Njb3JlXCI7XG5pbXBvcnQgdHlwZSB7IFBsYWNlbWVudFJ1biwgU2NlbmUgfSBmcm9tIFwiLi90eXBlc1wiO1xuXG5leHBvcnQgZnVuY3Rpb24gbmV3UGxhY2VtZW50UnVuKHNjZW5lOiBTY2VuZSwgZnJvbUJvdHRvbTogYm9vbGVhbik6IFBsYWNlbWVudFJ1biB7XG4gIHJldHVybiB7XG4gICAgc2NlbmUsXG4gICAgZnJvbUJvdHRvbSxcbiAgICBhYm92ZUlkOiBudWxsLFxuICAgIGJlbG93SWQ6IG51bGwsXG4gICAgbGFzdE9wcG9uZW50SWQ6IG51bGwsXG4gICAgbGFzdFdvbjogbnVsbCxcbiAgICBnYWxsb3Bpbmc6IGZyb21Cb3R0b20gfHwgZWxvKHNjZW5lKSAhPT0gbnVsbCxcbiAgICBzdGVwOiAxLFxuICAgIGJhdHRsZXM6IDAsXG4gICAgc3RyZWFrOiAwLFxuICAgIHJlc3VsdHM6IFtdLFxuICAgIHJhbmdlTG86IDAsXG4gICAgcmFuZ2VIaTogMCxcbiAgfTtcbn1cblxuLyoqIEluZGV4IG9mIHRoZSBlbmQgb2YgcG9vbFtpZHhdJ3MgdGllIGdyb3VwIChzY2VuZXMgd2l0aCB0aGUgc2FtZSBFTE8pIGluIGRpcmVjdGlvbiBgZGlyYC4gKi9cbmZ1bmN0aW9uIHRpZUdyb3VwRWRnZShwb29sOiBTY2VuZVtdLCBpZHg6IG51bWJlciwgZGlyOiAxIHwgLTEpOiBudW1iZXIge1xuICBjb25zdCB2YWx1ZSA9IGVsbyhwb29sW2lkeF0pO1xuICBsZXQgZWRnZSA9IGlkeDtcbiAgd2hpbGUgKGVkZ2UgKyBkaXIgPj0gMCAmJiBlZGdlICsgZGlyIDwgcG9vbC5sZW5ndGggJiYgZWxvKHBvb2xbZWRnZSArIGRpcl0pID09PSB2YWx1ZSkgZWRnZSArPSBkaXI7XG4gIHJldHVybiBlZGdlO1xufVxuXG4vKipcbiAqIEN1cnJlbnQgW2xvLCBoaSkgc2xvdCBib3VuZHMsIHJlc29sdmVkIGZyb20gdGhlIGJvdW5kaW5nIG9wcG9uZW50cycgaWRzLiBBIHJlc3VsdCBjb3VudHMgZm9yXG4gKiB0aGUgb3Bwb25lbnQncyB3aG9sZSB0aWUgZ3JvdXA6IGEgc2NlbmUgY2FuIG9ubHkgZ2V0IGFuIEVMTyBhYm92ZSBvciBiZWxvdyBhIGdyb3VwIG9mIGVxdWFsXG4gKiBFTE9zLCBub3QgaW5zaWRlIGl0LCBzbyB0aGUgc2xvdCBhbHdheXMgZW5kcyBhdCBhIGdyb3VwJ3MgZWRnZSBhbmQgdGhlIGxhbmRpbmcgRUxPIGtlZXBzIGl0IHRoZXJlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGxhY2VtZW50Qm91bmRzKHJ1bjogUGxhY2VtZW50UnVuLCBwb29sOiBTY2VuZVtdKTogeyBsbzogbnVtYmVyOyBoaTogbnVtYmVyIH0ge1xuICBjb25zdCBhYm92ZUlkeCA9IHJ1bi5hYm92ZUlkID8gcG9vbC5maW5kSW5kZXgoKHMpID0+IHMuaWQgPT09IHJ1bi5hYm92ZUlkKSA6IC0xO1xuICBjb25zdCBiZWxvd0lkeCA9IHJ1bi5iZWxvd0lkID8gcG9vbC5maW5kSW5kZXgoKHMpID0+IHMuaWQgPT09IHJ1bi5iZWxvd0lkKSA6IC0xO1xuICByZXR1cm4ge1xuICAgIGxvOiBhYm92ZUlkeCA+PSAwID8gdGllR3JvdXBFZGdlKHBvb2wsIGFib3ZlSWR4LCAxKSArIDEgOiAwLFxuICAgIGhpOiBiZWxvd0lkeCA+PSAwID8gdGllR3JvdXBFZGdlKHBvb2wsIGJlbG93SWR4LCAtMSkgOiBwb29sLmxlbmd0aCxcbiAgfTtcbn1cblxuLyoqIFRoZSBwb29sJ3MgbG93ZXN0IHNjZW5lIHdpdGggYW4gRUxPICh1bnJhdGVkIG9uZXMgc29ydCBsYXN0KSwgb3IgaXRzIGxhc3Qgc2NlbmUgaWYgbm9uZSBoYXMgb25lLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJvdHRvbUluZGV4KHBvb2w6IFNjZW5lW10pOiBudW1iZXIge1xuICBmb3IgKGxldCBpID0gcG9vbC5sZW5ndGggLSAxOyBpID49IDA7IGktLSkge1xuICAgIGlmIChlbG8ocG9vbFtpXSkgIT09IG51bGwpIHJldHVybiBpO1xuICB9XG4gIHJldHVybiBwb29sLmxlbmd0aCAtIDE7XG59XG5cbi8qKiBMYXJnZXN0IGp1bXAgYSBnYWxsb3BpbmcgcnVuIG1ha2VzIGluIHRoaXMgcG9vbCAoc2VlIFBMQUNFTUVOVF9NQVhfSlVNUF9TSEFSRSkuICovXG5leHBvcnQgZnVuY3Rpb24gbWF4UGxhY2VtZW50SnVtcChwb29sU2l6ZTogbnVtYmVyKTogbnVtYmVyIHtcbiAgcmV0dXJuIE1hdGgubWF4KFBMQUNFTUVOVF9NSU5fTUFYX0pVTVAsIE1hdGgucm91bmQocG9vbFNpemUgKiBQTEFDRU1FTlRfTUFYX0pVTVBfU0hBUkUpKTtcbn1cblxuLyoqIFdoZXJlIHRoZSBuZXh0IG9wcG9uZW50IHNob3VsZCBjb21lIGZyb20gKGJlZm9yZSBjbGFtcGluZyBpbnRvIFtsbywgaGkpKS4gKi9cbmZ1bmN0aW9uIG5leHRQbGFjZW1lbnRJbmRleChydW46IFBsYWNlbWVudFJ1biwgcG9vbDogU2NlbmVbXSwgbG86IG51bWJlciwgaGk6IG51bWJlcik6IG51bWJlciB7XG4gIGlmIChydW4uZ2FsbG9waW5nKSB7XG4gICAgaWYgKHJ1bi5sYXN0T3Bwb25lbnRJZCA9PT0gbnVsbCkge1xuICAgICAgaWYgKHJ1bi5mcm9tQm90dG9tKSByZXR1cm4gYm90dG9tSW5kZXgocG9vbCk7XG4gICAgICAvLyBTdGFydCBqdXN0IGJlbG93IHRoZSBzY2VuZSdzIGN1cnJlbnQgRUxPOiBhIGNvcnJlY3RseSByYXRlZCBzY2VuZSBjb25maXJtcyBpbiB+MiBiYXR0bGVzXG4gICAgICByZXR1cm4gZWxvSW5zZXJ0aW9uSW5kZXgocG9vbCwgZWxvKHJ1bi5zY2VuZSkgPz8gMCk7XG4gICAgfVxuICAgIGNvbnN0IGxhc3RJZHggPSBwb29sLmZpbmRJbmRleCgocykgPT4gcy5pZCA9PT0gcnVuLmxhc3RPcHBvbmVudElkKTtcbiAgICBpZiAobGFzdElkeCA+PSAwKSB7XG4gICAgICAvLyBTdGVwIGZyb20gdGhlIGZhciBlZGdlIG9mIHRoZSBsYXN0IG9wcG9uZW50J3MgdGllIGdyb3VwOiBhbm90aGVyIGVxdWFsIEVMTyB0ZWFjaGVzIG5vdGhpbmdcbiAgICAgIGNvbnN0IGRpciA9IHJ1bi5sYXN0V29uID8gLTEgOiAxO1xuICAgICAgY29uc3QgdGFyZ2V0ID0gdGllR3JvdXBFZGdlKHBvb2wsIGxhc3RJZHgsIGRpcikgKyBkaXIgKiBNYXRoLm1pbihydW4uc3RlcCwgbWF4UGxhY2VtZW50SnVtcChwb29sLmxlbmd0aCkpO1xuICAgICAgLy8gQSBqdW1wIHBhc3QgdGhlIHNlYXJjaCByYW5nZSB3b3VsZCBsYW5kIG9uIGl0cyBlbmQgKHN0cmFpZ2h0IHRvICMxLCBzYXkpOiBoYWx2ZSBpbnN0ZWFkXG4gICAgICBpZiAodGFyZ2V0ID49IGxvICYmIHRhcmdldCA8IGhpKSByZXR1cm4gdGFyZ2V0O1xuICAgIH1cbiAgfVxuICByZXR1cm4gbG8gKyBNYXRoLmZsb29yKChoaSAtIGxvKSAvIDIpO1xufVxuXG5leHBvcnQgdHlwZSBQbGFjZW1lbnRTdGVwID1cbiAgfCB7IGRvbmU6IHRydWU7IHNsb3Q6IG51bWJlcjsgbG86IG51bWJlcjsgaGk6IG51bWJlciB9XG4gIHwgeyBkb25lOiBmYWxzZTsgaW5kZXg6IG51bWJlcjsgbG86IG51bWJlcjsgaGk6IG51bWJlciB9O1xuXG4vKiogVGhlIHJ1bidzIG5leHQgc3RlcCBvbiB0aGlzIHBvb2w6IHRoZSBvcHBvbmVudCBpbmRleCB0byBiYXR0bGUsIG9yIHRoZSBzbG90IGl0IGhhcyBsYW5kZWQgaW4uICovXG5leHBvcnQgZnVuY3Rpb24gcGxhY2VtZW50U3RlcChydW46IFBsYWNlbWVudFJ1biwgcG9vbDogU2NlbmVbXSk6IFBsYWNlbWVudFN0ZXAge1xuICBjb25zdCB7IGxvLCBoaSB9ID0gcGxhY2VtZW50Qm91bmRzKHJ1biwgcG9vbCk7XG4gIGlmIChsbyA+PSBoaSkgcmV0dXJuIHsgZG9uZTogdHJ1ZSwgc2xvdDogTWF0aC5taW4obG8sIGhpKSwgbG8sIGhpIH07XG4gIGNvbnN0IGluZGV4ID0gTWF0aC5tYXgobG8sIE1hdGgubWluKGhpIC0gMSwgbmV4dFBsYWNlbWVudEluZGV4KHJ1biwgcG9vbCwgbG8sIGhpKSkpO1xuICByZXR1cm4geyBkb25lOiBmYWxzZSwgaW5kZXgsIGxvLCBoaSB9O1xufVxuXG4vKiogUmVjb3JkIGEgcGxhY2VtZW50IGJhdHRsZSByZXN1bHQgYW5kIHVwZGF0ZSB0aGUgbW9tZW50dW0gYW5kIHRoZSB3aW4gc3RyZWFrLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlY29yZFBsYWNlbWVudFJlc3VsdChydW46IFBsYWNlbWVudFJ1biwgd29uOiBib29sZWFuLCBvcHBvbmVudElkOiBzdHJpbmcpOiB2b2lkIHtcbiAgaWYgKHJ1bi5sYXN0V29uICE9PSBudWxsKSB7XG4gICAgaWYgKHJ1bi5sYXN0V29uID09PSB3b24pIHJ1bi5zdGVwICo9IDI7XG4gICAgZWxzZSBydW4uZ2FsbG9waW5nID0gZmFsc2U7XG4gIH1cbiAgaWYgKHdvbikgcnVuLmJlbG93SWQgPSBvcHBvbmVudElkO1xuICBlbHNlIHJ1bi5hYm92ZUlkID0gb3Bwb25lbnRJZDtcblxuICAvLyBUaGUgc3RyZWFrIGNvdW50cyB3aW5zIHVudGlsIHRoZSBmaXJzdCBsb3NzLCBzbyBpdCBvbmx5IGdyb3dzIHdoaWxlIGV2ZXJ5IGJhdHRsZSB3YXMgYSB3aW5cbiAgaWYgKHdvbiAmJiBydW4uc3RyZWFrID09PSBydW4uYmF0dGxlcykgcnVuLnN0cmVhaysrO1xuICBydW4ubGFzdE9wcG9uZW50SWQgPSBvcHBvbmVudElkO1xuICBydW4ubGFzdFdvbiA9IHdvbjtcbiAgcnVuLmJhdHRsZXMrKztcbiAgcnVuLnJlc3VsdHMgPSBbLi4uKHJ1bi5yZXN1bHRzID8/IFtdKSwgd29uXTtcbn1cblxuLyoqXG4gKiBFTE8gZm9yIGEgc2NlbmUgbGFuZGluZyBhdCBgc2xvdGAgb2YgdGhlIHBvb2w6IGJldHdlZW4gdGhlIG5lYXJlc3QgbmVpZ2hib3VycyB0aGF0IGhhdmUgYW4gRUxPXG4gKiAodW5yYXRlZCBvcHBvbmVudHMsIHBvc3NpYmxlIGluIGEgZmlsdGVyZWQgcG9vbCwgc2F5IG5vdGhpbmcgYWJvdXQgaXQpLiBTZWUgcGxhY2VtZW50RWxvLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbGFuZGluZ0Vsbyhwb29sOiBTY2VuZVtdLCBzbG90OiBudW1iZXIpOiBudW1iZXIge1xuICBsZXQgYWJvdmU6IG51bWJlciB8IG51bGwgPSBudWxsO1xuICBmb3IgKGxldCBpID0gc2xvdCAtIDE7IGkgPj0gMCAmJiBhYm92ZSA9PT0gbnVsbDsgaS0tKSBhYm92ZSA9IGVsbyhwb29sW2ldKTtcbiAgbGV0IGJlbG93OiBudW1iZXIgfCBudWxsID0gbnVsbDtcbiAgZm9yIChsZXQgaSA9IHNsb3Q7IGkgPCBwb29sLmxlbmd0aCAmJiBiZWxvdyA9PT0gbnVsbDsgaSsrKSBiZWxvdyA9IGVsbyhwb29sW2ldKTtcbiAgcmV0dXJuIHBsYWNlbWVudEVsbyhhYm92ZSwgYmVsb3cpO1xufVxuIiwgImltcG9ydCB0eXBlIHsgU2NlbmUgfSBmcm9tIFwiLi90eXBlc1wiO1xyXG5cclxuLyoqIFNjZW5lIHRpdGxlIGZyb20gbWV0YWRhdGEsIG9yIHRoZSBmaWxlbmFtZSAod2l0aG91dCBleHRlbnNpb24pIGZyb20gdGhlIGZpbGUgcGF0aC4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVTY2VuZVRpdGxlKHNjZW5lOiBTY2VuZSk6IHN0cmluZyB7XHJcbiAgaWYgKHNjZW5lLnRpdGxlKSByZXR1cm4gc2NlbmUudGl0bGU7XHJcblxyXG4gIGNvbnN0IHBhdGggPSBzY2VuZS5maWxlcz8uWzBdPy5wYXRoO1xyXG4gIGlmIChwYXRoKSB7XHJcbiAgICBjb25zdCBwYXRoUGFydHMgPSBwYXRoLnNwbGl0KC9bL1xcXFxdLyk7XHJcbiAgICByZXR1cm4gcGF0aFBhcnRzW3BhdGhQYXJ0cy5sZW5ndGggLSAxXS5yZXBsYWNlKC9cXC5bXi8uXSskLywgXCJcIik7XHJcbiAgfVxyXG5cclxuICByZXR1cm4gXCJcIjtcclxufVxyXG4iLCAiLy8gTWF0Y2htYWtpbmc6IGJ1aWxkIHRoZSBzY2VuZSBwYWlycyBmb3IgZWFjaCBjb21wYXJpc29uIG1vZGUuXG5cbmltcG9ydCB7IGNsZWFyRmlsdGVyZWRDYWNoZSwgZ2V0QWxsU2NlbmVzQ2FjaGVkLCBnZXRGaWx0ZXJlZFNjZW5lc0NhY2hlZCwgbGF0ZXN0U2NlbmUgfSBmcm9tIFwiLi9jYWNoZVwiO1xuaW1wb3J0IHtcbiAgQ0hBTVBJT05fVU5SQVRFRF9FTE8sXG4gIENMSU1CX09QUE9ORU5UX1BJQ0tfV0lORE9XLFxuICBTV0lTU19PUFBPTkVOVF9FTE9fV0lORE9XLFxuICBTV0lTU19PUFBPTkVOVF9NSU5fQ0FORElEQVRFUyxcbn0gZnJvbSBcIi4vY29uc3RhbnRzXCI7XG5pbXBvcnQgeyBleHBsb3JlUG9vbFNjZW5lcyB9IGZyb20gXCIuL2V4cGxvcmVcIjtcbmltcG9ydCB7IHJlYWRGaWx0ZXJzLCB0eXBlIExpc3RGaWx0ZXJzIH0gZnJvbSBcIi4vZmlsdGVyc1wiO1xuaW1wb3J0IHsgbGFuZGluZ0VsbywgbmV3UGxhY2VtZW50UnVuLCBwbGFjZW1lbnRTdGVwIH0gZnJvbSBcIi4vcGxhY2VtZW50XCI7XG5pbXBvcnQgeyB3cml0ZUVsbyB9IGZyb20gXCIuL3JhdGluZ1wiO1xuaW1wb3J0IHsgYmF0dGxlcywgZWZmZWN0aXZlRWxvLCBlbG8sIGlzUmF0ZWQsIHN3aXNzT3Bwb25lbnRJbmRleGVzIH0gZnJvbSBcIi4vc2NvcmVcIjtcbmltcG9ydCB7IGV4cGxvcmVQb29sV2l0aGluLCBzdGF0ZSB9IGZyb20gXCIuL3N0YXRlXCI7XG5pbXBvcnQgeyByZXNvbHZlU2NlbmVUaXRsZSB9IGZyb20gXCIuL3NjZW5lVGl0bGVcIjtcbmltcG9ydCB7IGxlYXN0VGVzdGVkIH0gZnJvbSBcIi4vc3RhdHNcIjtcbmltcG9ydCB0eXBlIHsgQ2hhbXBpb25QYWlyUmVzdWx0LCBQbGFjZW1lbnRQYWlyUmVzdWx0LCBSYW5rLCBTY2VuZSwgU3dpc3NQYWlyUmVzdWx0IH0gZnJvbSBcIi4vdHlwZXNcIjtcblxuZnVuY3Rpb24gc2h1ZmZsZUFycmF5PFQ+KGFycmF5OiBUW10pOiBUW10ge1xuICBjb25zdCBzaHVmZmxlZCA9IFsuLi5hcnJheV07XG4gIGZvciAobGV0IGkgPSBzaHVmZmxlZC5sZW5ndGggLSAxOyBpID4gMDsgaS0tKSB7XG4gICAgY29uc3QgaiA9IE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSAqIChpICsgMSkpO1xuICAgIFtzaHVmZmxlZFtpXSwgc2h1ZmZsZWRbal1dID0gW3NodWZmbGVkW2pdLCBzaHVmZmxlZFtpXV07XG4gIH1cbiAgcmV0dXJuIHNodWZmbGVkO1xufVxuXG4vLyBUcmFjayBsYXN0IHNjZW5lIHRvIGF2b2lkIGltbWVkaWF0ZSByZXBlYXQgYWZ0ZXIgcmVzaHVmZmxlXG5sZXQgbGFzdFNob3duU2NlbmVJZDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cbi8qKiBUcnVlIG9uY2UgZXZlcnkgc2NlbmUgaW4gdGhlIGN1cnJlbnQgc2h1ZmZsZSBoYXMgYmVlbiBzaG93biAodGltZSB0byByZS1xdWVyeSB0aGUgZmlsdGVyKS4gKi9cbmZ1bmN0aW9uIGlzU2h1ZmZsZUN5Y2xlQ29tcGxldGUoZmlsdGVyS2V5OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIChcbiAgICBzdGF0ZS5zaHVmZmxlRmlsdGVyS2V5ID09PSBmaWx0ZXJLZXkgJiZcbiAgICBzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzLmxlbmd0aCA+IDAgJiZcbiAgICBzdGF0ZS5zaHVmZmxlSW5kZXggPj0gc3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lcy5sZW5ndGhcbiAgKTtcbn1cblxuLyoqIFJlc2h1ZmZsZSB0aGUgbGVmdCBwb29sIGZvciBhIG5ldyBwYXNzLCB3aXRob3V0IHNob3dpbmcgdGhlIHByZXZpb3VzIHBhc3MncyBsYXN0IHNjZW5lIGZpcnN0LiAqL1xuZnVuY3Rpb24gc3RhcnROZXdQYXNzKGxlZnRQb29sOiBTY2VuZVtdKTogdm9pZCB7XG4gIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+UgCBSZXNodWZmbGluZyAoY29tcGxldGVkIGZ1bGwgY3ljbGUpXCIpO1xuICBzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzID0gc2h1ZmZsZUFycmF5KGxlZnRQb29sKTtcbiAgc3RhdGUuc2h1ZmZsZUluZGV4ID0gMDtcblxuICBpZiAoXG4gICAgbGFzdFNob3duU2NlbmVJZCAmJlxuICAgIHN0YXRlLnNodWZmbGVkRmlsdGVyZWRTY2VuZXMubGVuZ3RoID4gMSAmJlxuICAgIHN0YXRlLnNodWZmbGVkRmlsdGVyZWRTY2VuZXNbMF0uaWQgPT09IGxhc3RTaG93blNjZW5lSWRcbiAgKSB7XG4gICAgY29uc3Qgc3dhcElkeCA9IDEgKyBNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkgKiAoc3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lcy5sZW5ndGggLSAxKSk7XG4gICAgW3N0YXRlLnNodWZmbGVkRmlsdGVyZWRTY2VuZXNbMF0sIHN0YXRlLnNodWZmbGVkRmlsdGVyZWRTY2VuZXNbc3dhcElkeF1dID0gW1xuICAgICAgc3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lc1tzd2FwSWR4XSxcbiAgICAgIHN0YXRlLnNodWZmbGVkRmlsdGVyZWRTY2VuZXNbMF0sXG4gICAgXTtcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCflIQgU3dhcHBlZCBmaXJzdCBzY2VuZSB0byBhdm9pZCByZXBlYXRcIik7XG4gIH1cbn1cblxuLyoqIE5leHQgbGVmdC1zaWRlIHNjZW5lIGZyb20gdGhlIHNodWZmbGVkIGxlZnQgcG9vbCAobm8gbmV0d29yayBmZXRjaCkuIFNjZW5lcyBzdGF5IGluIHRoZSBwb29sLiAqL1xuZnVuY3Rpb24gZ2V0TmV4dEZpbHRlcmVkU2NlbmUobGVmdFBvb2w6IFNjZW5lW10sIGZpbHRlcktleTogc3RyaW5nKTogU2NlbmUgfCBudWxsIHtcbiAgaWYgKGxlZnRQb29sLmxlbmd0aCA9PT0gMCkge1xuICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+PgSBGaWx0ZXJlZCBwb29sIGlzIGVtcHR5XCIpO1xuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgaWYgKGZpbHRlcktleSAhPT0gc3RhdGUuc2h1ZmZsZUZpbHRlcktleSB8fCBzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzLmxlbmd0aCA9PT0gMCkge1xuICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+UgCBTaHVmZmxpbmcgZmlsdGVyZWQgc2NlbmVzIChmaWx0ZXIgY2hhbmdlZCBvciBmaXJzdCBsb2FkKVwiKTtcbiAgICBzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzID0gc2h1ZmZsZUFycmF5KGxlZnRQb29sKTtcbiAgICBzdGF0ZS5zaHVmZmxlSW5kZXggPSAwO1xuICAgIHN0YXRlLnNodWZmbGVGaWx0ZXJLZXkgPSBmaWx0ZXJLZXk7XG4gICAgbGFzdFNob3duU2NlbmVJZCA9IG51bGw7XG4gIH1cblxuICAvLyBUaGUgc2h1ZmZsZSBrZWVwcyBpdHMgcGFzcydzIHNjZW5lIG9iamVjdHM7IGEgYmFja2dyb3VuZCByZWZyZXNoIG1heSBoYXZlIHJlcGxhY2VkIHRoZW0gc2luY2UsXG4gIC8vIGFuZCBzY2VuZXMgdGhhdCBoYXZlIGxlZnQgdGhlIHBvb2wgKHBsYWNlZCBvdXQgb2YgYW4gXCJVbnJhdGVkXCIgcG9vbCwgc2F5KSBhcmUgc2tpcHBlZFxuICBjb25zdCBpblBvb2wgPSBuZXcgTWFwKGxlZnRQb29sLm1hcCgocykgPT4gW3MuaWQsIHNdKSk7XG4gIGxldCBzY2VuZTogU2NlbmUgfCB1bmRlZmluZWQ7XG4gIGZvciAobGV0IHRyaWVzID0gMDsgIXNjZW5lICYmIHRyaWVzIDwgMjsgdHJpZXMrKykge1xuICAgIGlmIChzdGF0ZS5zaHVmZmxlSW5kZXggPj0gc3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lcy5sZW5ndGgpIHN0YXJ0TmV3UGFzcyhsZWZ0UG9vbCk7XG4gICAgd2hpbGUgKCFzY2VuZSAmJiBzdGF0ZS5zaHVmZmxlSW5kZXggPCBzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzLmxlbmd0aCkge1xuICAgICAgc2NlbmUgPSBpblBvb2wuZ2V0KHN0YXRlLnNodWZmbGVkRmlsdGVyZWRTY2VuZXNbc3RhdGUuc2h1ZmZsZUluZGV4XS5pZCk7XG4gICAgICBzdGF0ZS5zaHVmZmxlSW5kZXgrKztcbiAgICB9XG4gIH1cbiAgaWYgKCFzY2VuZSkgcmV0dXJuIG51bGw7XG4gIGxhc3RTaG93blNjZW5lSWQgPSBzY2VuZS5pZDtcbiAgY29uc29sZS5sb2coXG4gICAgYFtTdGFzaCBCYXR0bGVdIPCfk40gUGlja2VkIHNjZW5lICR7c2NlbmUuaWR9ICgke3N0YXRlLnNodWZmbGVkRmlsdGVyZWRTY2VuZXMubGVuZ3RoIC0gc3RhdGUuc2h1ZmZsZUluZGV4fSBsZWZ0IGluIHRoaXMgcGFzcylgLFxuICApO1xuICByZXR1cm4gc2NlbmU7XG59XG5cbi8qKlxuICogT3Bwb25lbnRzIChyaWdodCBzaWRlKSwgc29ydGVkIGJ5IEVMTzogc2NlbmVzIHdpdGggYW4gRUxPLCBvciB0aGUgZmlsdGVyZWQgc2NlbmVzIHdoZW4gXCJ1c2VcbiAqIGZpbHRlcmVkIHNjZW5lcyBmb3IgYm90aCBzaWRlc1wiIGlzIG9uICh1bnJhdGVkIG9uZXMgdGhlbiBzb3J0IGxhc3QpLlxuICovXG5mdW5jdGlvbiBidWlsZE9wcG9uZW50UG9vbChhbGxTY2VuZXM6IFNjZW5lW10sIGxlZnRQb29sOiBTY2VuZVtdLCBmaWx0ZXJzOiBMaXN0RmlsdGVycyk6IFNjZW5lW10ge1xuICBpZiAoc3RhdGUuZXhwbG9yZVBvb2wgPyBleHBsb3JlUG9vbFdpdGhpbigpIDogc3RhdGUuc2V0dGluZ3MuZmlsdGVyT3Bwb25lbnRzICYmIGZpbHRlcnMuZmlsdGVyQWN0aXZlKSB7XG4gICAgcmV0dXJuIGxlZnRQb29sO1xuICB9XG4gIGNvbnN0IHJhdGVkID0gYWxsU2NlbmVzLmZpbHRlcihpc1JhdGVkKTtcbiAgcmV0dXJuIHJhdGVkLmxlbmd0aCA+PSAxID8gcmF0ZWQgOiBhbGxTY2VuZXM7XG59XG5cbi8qKiBMb2FkIHRoZSBsZWZ0IChcInRvIHJhdGVcIikgYW5kIGZ1bGwgcG9vbHMuIEJvdGggY29tZSBmcm9tIHRoZSBjYWNoZSwgc29ydGVkIGJ5IEVMTy4gKi9cbmFzeW5jIGZ1bmN0aW9uIGxvYWRTY2VuZVBvb2xzKFxuICBmaWx0ZXJzOiBMaXN0RmlsdGVycyxcbik6IFByb21pc2U8eyBsZWZ0UG9vbDogU2NlbmVbXTsgYWxsU2NlbmVzOiBTY2VuZVtdIH0+IHtcbiAgbGV0IGxlZnRQb29sOiBTY2VuZVtdO1xuICBsZXQgYWxsU2NlbmVzOiBTY2VuZVtdO1xuXG4gIGlmIChzdGF0ZS5leHBsb3JlUG9vbCkge1xuICAgIC8vIE9uZSBzY2VuZSwgb3IgYW4gRXhwbG9yZSBmaWx0ZXIgd29ya2VkIG91dCBhZ2FpbiBlYWNoIHRpbWUgKHNjZW5lcyBqb2luIGFuZCBsZWF2ZSBpdCBhcyBFTE8gY2hhbmdlcylcbiAgICBhbGxTY2VuZXMgPSAoYXdhaXQgZ2V0QWxsU2NlbmVzQ2FjaGVkKCkpLnNjZW5lcyB8fCBbXTtcbiAgICBjb25zdCB7IHNjZW5lSWQsIGZpbHRlcnM6IHBvb2xGaWx0ZXJzIH0gPSBzdGF0ZS5leHBsb3JlUG9vbDtcbiAgICBsZWZ0UG9vbCA9IHNjZW5lSWRcbiAgICAgID8gYWxsU2NlbmVzLmZpbHRlcigocykgPT4gcy5pZCA9PT0gc2NlbmVJZClcbiAgICAgIDogZXhwbG9yZVBvb2xTY2VuZXMoYWxsU2NlbmVzLCBwb29sRmlsdGVycywgcmVzb2x2ZVNjZW5lVGl0bGUpO1xuICB9IGVsc2UgaWYgKGZpbHRlcnMuZmlsdGVyQWN0aXZlKSB7XG4gICAgLy8gUmUtcXVlcnkgdGhlIGZpbHRlciBhZnRlciBlYWNoIGZ1bGwgcGFzcyBzbyBmaWx0ZXJzIGxpa2UgXCJ1bnJhdGVkXCIgc2hyaW5rIGFzIHNjZW5lcyBnZXQgcmF0ZWRcbiAgICBjb25zdCBwYXNzQ29tcGxldGUgPSBpc1NodWZmbGVDeWNsZUNvbXBsZXRlKGZpbHRlcnMuZmlsdGVyS2V5KTtcbiAgICBpZiAocGFzc0NvbXBsZXRlKSB7XG4gICAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCflIEgUGFzcyBjb21wbGV0ZSwgcmUtZmV0Y2hpbmcgZmlsdGVyZWQgc2NlbmVzXCIpO1xuICAgICAgYXdhaXQgY2xlYXJGaWx0ZXJlZENhY2hlKCk7XG4gICAgfVxuICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+TiyBGaWx0ZXIgYWN0aXZlLCBmZXRjaGluZyBmaWx0ZXJlZCArIGFsbCBzY2VuZXNcIik7XG4gICAgY29uc3QgW2ZpbHRlcmVkUmVzdWx0LCBhbGxSZXN1bHRdID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xuICAgICAgZ2V0RmlsdGVyZWRTY2VuZXNDYWNoZWQoZmlsdGVycyksXG4gICAgICBnZXRBbGxTY2VuZXNDYWNoZWQoKSxcbiAgICBdKTtcbiAgICBsZWZ0UG9vbCA9IGZpbHRlcmVkUmVzdWx0LnNjZW5lcyB8fCBbXTtcbiAgICBhbGxTY2VuZXMgPSBhbGxSZXN1bHQuc2NlbmVzIHx8IFtdO1xuICAgIC8vIFN0YXJ0IHRoZSBuZXh0IHBhc3Mgbm93LCBzbyBsYXRlciBsb2FkcyBpbiBhIHJ1biAod2hpY2ggcGljayBubyBuZXcgbGVmdCBzY2VuZSkgZG9uJ3RcbiAgICAvLyBzZWUgdGhlIHBhc3MgYXMgY29tcGxldGUgYW5kIHJlLWZldGNoIHRoZSBmaWx0ZXIgZXZlcnkgdGltZVxuICAgIGlmIChwYXNzQ29tcGxldGUpIHN0YXJ0TmV3UGFzcyhsZWZ0UG9vbCk7XG4gIH0gZWxzZSB7XG4gICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5OLIE5vIGZpbHRlciBhY3RpdmUsIHVzaW5nIGFsbCBzY2VuZXNcIik7XG4gICAgYWxsU2NlbmVzID0gKGF3YWl0IGdldEFsbFNjZW5lc0NhY2hlZCgpKS5zY2VuZXMgfHwgW107XG4gICAgbGVmdFBvb2wgPSBhbGxTY2VuZXM7XG4gIH1cblxuICBzdGF0ZS5sZWZ0UG9vbFNpemUgPSBsZWZ0UG9vbC5sZW5ndGg7XG4gIHJldHVybiB7IGxlZnRQb29sLCBhbGxTY2VuZXMgfTtcbn1cblxuLyoqXG4gKiBSYW5rcyBmb3IgYSByZXN0b3JlZCBwYWlyIGZyb20gdGhlIGN1cnJlbnQgcG9vbHMgKGFsc28gcmVjb3JkaW5nIHRoZSBsZWZ0IHBvb2wncyBzaXplKSwgdGhlIHdheVxuICogdGhlIHBhaXIgZmV0Y2hlcnMgd29yayB0aGVtIG91dDogdGhlIHBsYWNlIGluIHRoZSBvcHBvbmVudCBwb29sLCBhbmQgaW4gUGxhY2VtZW50LCBub25lIGZvciB0aGVcbiAqIHNjZW5lIGJlaW5nIHBsYWNlZCBhbmQgdGhlIG9wcG9uZW50J3MgcGxhY2UgaW4gdGhlIHBvb2wgd2l0aG91dCBpdC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHBhaXJSYW5rcyhsZWZ0OiBTY2VuZSwgcmlnaHQ6IFNjZW5lKTogUHJvbWlzZTxbUmFuaywgUmFua10+IHtcbiAgY29uc3QgZmlsdGVycyA9IGN1cnJlbnRGaWx0ZXJzKCk7XG4gIGNvbnN0IHsgbGVmdFBvb2wsIGFsbFNjZW5lcyB9ID0gYXdhaXQgbG9hZFNjZW5lUG9vbHMoZmlsdGVycyk7XG4gIGxldCBwb29sID0gYnVpbGRPcHBvbmVudFBvb2woYWxsU2NlbmVzLCBsZWZ0UG9vbCwgZmlsdGVycyk7XG4gIGNvbnN0IHJhbmsgPSAoc2NlbmU6IFNjZW5lKTogUmFuayA9PiB7XG4gICAgY29uc3QgaWR4ID0gcG9vbC5maW5kSW5kZXgoKHMpID0+IHMuaWQgPT09IHNjZW5lLmlkKTtcbiAgICByZXR1cm4gaWR4ID49IDAgPyBpZHggKyAxIDogbnVsbDtcbiAgfTtcbiAgaWYgKHN0YXRlLmN1cnJlbnRNb2RlID09PSBcInBsYWNlbWVudFwiKSB7XG4gICAgcG9vbCA9IHBvb2wuZmlsdGVyKChzKSA9PiBzLmlkICE9PSBsZWZ0LmlkKTtcbiAgICByZXR1cm4gW251bGwsIHJhbmsocmlnaHQpXTtcbiAgfVxuICByZXR1cm4gW3JhbmsobGVmdCksIHJhbmsocmlnaHQpXTtcbn1cblxuLyoqXG4gKiBUaGUgc2NlbmVzIFwiQmF0dGxlIHRoZSBsZWFzdC10ZXN0ZWRcIiBwaWNrcyBmcm9tOiB0aGUgU2NlbmVzIHBhZ2UgZmlsdGVyJ3MsIG9yIHRoZSB3aG9sZSBsaWJyYXJ5XG4gKiAoaXQgdHVybnMgb2ZmIGEgYmF0dGxlZCBFeHBsb3JlIGZpbHRlcikuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBsZWFzdFRlc3RlZFNvdXJjZSgpOiBQcm9taXNlPHsgc2NlbmVzOiBTY2VuZVtdOyBmaWx0ZXJlZDogYm9vbGVhbiB9PiB7XG4gIGNvbnN0IGZpbHRlcnMgPSByZWFkRmlsdGVycygpO1xuICBpZiAoIWZpbHRlcnMuZmlsdGVyQWN0aXZlKSByZXR1cm4geyBzY2VuZXM6IChhd2FpdCBnZXRBbGxTY2VuZXNDYWNoZWQoKSkuc2NlbmVzIHx8IFtdLCBmaWx0ZXJlZDogZmFsc2UgfTtcbiAgcmV0dXJuIHsgc2NlbmVzOiAoYXdhaXQgZ2V0RmlsdGVyZWRTY2VuZXNDYWNoZWQoZmlsdGVycykpLnNjZW5lcyB8fCBbXSwgZmlsdGVyZWQ6IHRydWUgfTtcbn1cblxuLyoqIFRoZSBhY3RpdmUgZmlsdGVyOiBvbmUgc2NlbmUgb3IgYW4gRXhwbG9yZSBmaWx0ZXIgYmVpbmcgYmF0dGxlZCwgb3IgZWxzZSB0aGUgU2NlbmVzIHBhZ2UncyAoVVJMKSBmaWx0ZXIuICovXG5leHBvcnQgZnVuY3Rpb24gY3VycmVudEZpbHRlcnMoKTogTGlzdEZpbHRlcnMge1xuICBjb25zdCBwb29sID0gc3RhdGUuZXhwbG9yZVBvb2w7XG4gIGlmIChwb29sKSB7XG4gICAgY29uc3QgZmlsdGVyS2V5ID0gcG9vbC5zY2VuZUlkID8gYHNjZW5lOiR7cG9vbC5zY2VuZUlkfWAgOiBgZXhwbG9yZToke0pTT04uc3RyaW5naWZ5KHBvb2wuZmlsdGVycyl9YDtcbiAgICByZXR1cm4geyBmaWx0ZXJLZXksIHNjZW5lRmlsdGVyOiBudWxsLCBmaWx0ZXJBY3RpdmU6IHRydWUgfTtcbiAgfVxuICByZXR1cm4gcmVhZEZpbHRlcnMoKTtcbn1cblxuLyoqIExvYWQgbGVmdCAoc2NlbmUgdG8gcmF0ZSkgYW5kIHJpZ2h0IChvcHBvbmVudCkgcG9vbHMgZm9yIFN3aXNzLiAqL1xuYXN5bmMgZnVuY3Rpb24gYnVpbGRTd2lzc1Bvb2xzKCk6IFByb21pc2U8e1xuICBsZWZ0UG9vbDogU2NlbmVbXTtcbiAgcmlnaHRQb29sOiBTY2VuZVtdO1xuICBmaWx0ZXJLZXk6IHN0cmluZztcbn0+IHtcbiAgY29uc3QgZmlsdGVycyA9IGN1cnJlbnRGaWx0ZXJzKCk7XG4gIGNvbnN0IHsgbGVmdFBvb2wsIGFsbFNjZW5lcyB9ID0gYXdhaXQgbG9hZFNjZW5lUG9vbHMoZmlsdGVycyk7XG5cbiAgaWYgKGFsbFNjZW5lcy5sZW5ndGggPCAyKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiTm90IGVub3VnaCBzY2VuZXMgZm9yIGNvbXBhcmlzb24uXCIpO1xuICB9XG5cbiAgY29uc3QgcmlnaHRQb29sID0gYnVpbGRPcHBvbmVudFBvb2woYWxsU2NlbmVzLCBsZWZ0UG9vbCwgZmlsdGVycyk7XG4gIGlmIChleHBsb3JlUG9vbFdpdGhpbigpICYmIHJpZ2h0UG9vbC5sZW5ndGggPCAyKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiTm90IGVub3VnaCBzY2VuZXMgaW4gdGhpcyBFeHBsb3JlIGZpbHRlciBmb3IgYSBtYXRjaC4gWW91IG5lZWQgYXQgbGVhc3QgMiBzY2VuZXMuXCIpO1xuICB9XG4gIGlmICghc3RhdGUuZXhwbG9yZVBvb2wgJiYgc3RhdGUuc2V0dGluZ3MuZmlsdGVyT3Bwb25lbnRzICYmIGZpbHRlcnMuZmlsdGVyQWN0aXZlICYmIHJpZ2h0UG9vbC5sZW5ndGggPCAyKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiTm90IGVub3VnaCBzY2VuZXMgaW4geW91ciBmaWx0ZXIgZm9yIGEgbWF0Y2guIFlvdSBuZWVkIGF0IGxlYXN0IDIgc2NlbmVzLlwiKTtcbiAgfVxuXG4gIHJldHVybiB7IGxlZnRQb29sLCByaWdodFBvb2wsIGZpbHRlcktleTogZmlsdGVycy5maWx0ZXJLZXkgfTtcbn1cblxuLy8gU3dpc3MgbW9kZTogbGVmdCA9IHNjZW5lIHRvIHJhdGUgKGZpbHRlcmVkIHBvb2wpLCByaWdodCA9IHNpbWlsYXItc3RyZW5ndGggb3Bwb25lbnRcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBmZXRjaFN3aXNzUGFpcihmb3JjZWRMZWZ0U2NlbmU6IFNjZW5lIHwgbnVsbCA9IG51bGwpOiBQcm9taXNlPFN3aXNzUGFpclJlc3VsdD4ge1xuICBjb25zdCB7IGxlZnRQb29sLCByaWdodFBvb2wsIGZpbHRlcktleSB9ID0gYXdhaXQgYnVpbGRTd2lzc1Bvb2xzKCk7XG5cbiAgLy8gXCJCYXR0bGUgdGhlIGxlYXN0LXRlc3RlZFwiIChTdGF0cyB0YWIpIHRha2VzIHRoZSBmZXdlc3QtYmF0dGxlZCBzY2VuZSBpbnN0ZWFkIG9mIHRoZSBzaHVmZmxlXG4gIGNvbnN0IHNjZW5lMSA9XG4gICAgZm9yY2VkTGVmdFNjZW5lIHx8XG4gICAgKHN0YXRlLmxlYXN0VGVzdGVkID8gbGVhc3RUZXN0ZWQobGVmdFBvb2wsIHN0YXRlLmN1cnJlbnRQYWlyLmxlZnQ/LmlkID8/IG51bGwpIDogZ2V0TmV4dEZpbHRlcmVkU2NlbmUobGVmdFBvb2wsIGZpbHRlcktleSkpO1xuICBpZiAoIXNjZW5lMSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIk5vIHNjZW5lcyBtYXRjaCB5b3VyIGZpbHRlciBjcml0ZXJpYS5cIik7XG4gIH1cblxuICBjb25zdCB7IHNjZW5lMiwgcmFua3MgfSA9IHBpY2tTd2lzc09wcG9uZW50KHNjZW5lMSwgcmlnaHRQb29sKTtcbiAgcmV0dXJuIHsgc2NlbmVzOiBbc2NlbmUxLCBzY2VuZTJdLCByYW5rcyB9O1xufVxuXG4vKipcbiAqIFBpY2sgYSByYW5kb20gb3Bwb25lbnQgd2l0aGluIMKxU1dJU1NfT1BQT05FTlRfRUxPX1dJTkRPVyBvZiBzY2VuZTEncyBFTE8gaW4gdGhlIEVMTy1zb3J0ZWQgcmlnaHRcbiAqIHBvb2wgKHVucmF0ZWQgc2NlbmVzIGNvdW50IGFzIDE1MDApLCBvciBhbW9uZyB0aGUgbmVhcmVzdCBmZXcgd2hlbiB0aGUgd2luZG93IGhhcyB0b28gZmV3LlxuICovXG5mdW5jdGlvbiBwaWNrU3dpc3NPcHBvbmVudChcbiAgc2NlbmUxOiBTY2VuZSxcbiAgcmlnaHRQb29sOiBTY2VuZVtdLFxuKTogeyBzY2VuZTI6IFNjZW5lOyByYW5rczogW1JhbmssIFJhbmtdIH0ge1xuICBjb25zdCBzY2VuZTFJZHhJblBvb2wgPSByaWdodFBvb2wuZmluZEluZGV4KChzKSA9PiBzLmlkID09PSBzY2VuZTEuaWQpO1xuICBjb25zdCBzY2VuZTFSYW5rSW5Qb29sID0gc2NlbmUxSWR4SW5Qb29sID49IDAgPyBzY2VuZTFJZHhJblBvb2wgKyAxIDogbnVsbDtcblxuICBjb25zdCBjYW5kaWRhdGVzID0gc3dpc3NPcHBvbmVudEluZGV4ZXMoXG4gICAgcmlnaHRQb29sLFxuICAgIGVmZmVjdGl2ZUVsbyhsYXRlc3RTY2VuZShzY2VuZTEpKSxcbiAgICBzY2VuZTEuaWQsXG4gICAgU1dJU1NfT1BQT05FTlRfRUxPX1dJTkRPVyxcbiAgICBTV0lTU19PUFBPTkVOVF9NSU5fQ0FORElEQVRFUyxcbiAgKTtcbiAgaWYgKGNhbmRpZGF0ZXMubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiTm90IGVub3VnaCBzY2VuZXMgZm9yIGNvbXBhcmlzb24uIFlvdSBuZWVkIGF0IGxlYXN0IDIgc2NlbmVzLlwiKTtcbiAgfVxuXG4gIGNvbnN0IGlkeCA9IGNhbmRpZGF0ZXNbTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogY2FuZGlkYXRlcy5sZW5ndGgpXTtcbiAgcmV0dXJuIHtcbiAgICBzY2VuZTI6IHJpZ2h0UG9vbFtpZHhdLFxuICAgIHJhbmtzOiBbc2NlbmUxUmFua0luUG9vbCwgaWR4ICsgMV0sXG4gIH07XG59XG5cbi8qKiBSYW5kb20gcGljayBmcm9tIHRoZSBOIHVuYmVhdGVuIG9wcG9uZW50cyBjbG9zZXN0IGFib3ZlIHRoZSBjaGFtcGlvbiAobGlzdCBpcyBFTE8tc29ydGVkKS4gKi9cbmZ1bmN0aW9uIHBpY2tDbG9zZXN0Q2hhbXBpb25PcHBvbmVudChyZW1haW5pbmdPcHBvbmVudHM6IFNjZW5lW10pOiBTY2VuZSB7XG4gIGNvbnN0IGNsb3Nlc3QgPSByZW1haW5pbmdPcHBvbmVudHMuc2xpY2UoLUNMSU1CX09QUE9ORU5UX1BJQ0tfV0lORE9XKTtcbiAgcmV0dXJuIGNsb3Nlc3RbTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogY2xvc2VzdC5sZW5ndGgpXTtcbn1cblxuLyoqIE9wcG9uZW50cyBhYm92ZSB0aGUgY2hhbXBpb24gaW4gdGhlIEVMTy1zb3J0ZWQgcG9vbCB0aGF0IGl0IGhhc24ndCBiZWF0ZW4gaW4gdGhpcyBydW4uICovXG5mdW5jdGlvbiBnZXRSZW1haW5pbmdDaGFtcGlvbk9wcG9uZW50cyhjaGFtcGlvbjogU2NlbmUsIHJpZ2h0UG9vbDogU2NlbmVbXSwgY2hhbXBpb25JbmRleDogbnVtYmVyKTogU2NlbmVbXSB7XG4gIGNvbnN0IGNoYW1waW9uRWxvID0gZWZmZWN0aXZlRWxvKGNoYW1waW9uLCBDSEFNUElPTl9VTlJBVEVEX0VMTyk7XG4gIHJldHVybiByaWdodFBvb2wuZmlsdGVyKChzLCBpZHgpID0+IHtcbiAgICBpZiAocy5pZCA9PT0gY2hhbXBpb24uaWQgfHwgc3RhdGUuY2hhbXBpb25EZWZlYXRlZC5pbmNsdWRlcyhzLmlkKSkgcmV0dXJuIGZhbHNlO1xuICAgIHJldHVybiBpZHggPCBjaGFtcGlvbkluZGV4IHx8IChlbG8ocykgPz8gLUluZmluaXR5KSA+PSBjaGFtcGlvbkVsbztcbiAgfSk7XG59XG5cbi8qKiBMb3dlc3Qgc2NlbmUgd2l0aCBhbiBFTE8gaW4gdGhlIHBvb2wgKGV4Y2x1ZGluZyBvbmUgc2NlbmUpLCBvciBhbnkgb3RoZXIgc2NlbmUgaWYgbm9uZSBoYXMgb25lLiAqL1xuZnVuY3Rpb24gZmluZExvd2VzdFJhdGVkKHNjZW5lczogU2NlbmVbXSwgZXhjbHVkZUlkOiBzdHJpbmcpOiB7IHNjZW5lOiBTY2VuZSB8IHVuZGVmaW5lZDsgaW5kZXg6IG51bWJlciB9IHtcbiAgZm9yIChsZXQgaSA9IHNjZW5lcy5sZW5ndGggLSAxOyBpID49IDA7IGktLSkge1xuICAgIGNvbnN0IHMgPSBzY2VuZXNbaV07XG4gICAgaWYgKHMuaWQgIT09IGV4Y2x1ZGVJZCAmJiBpc1JhdGVkKHMpKSB7XG4gICAgICByZXR1cm4geyBzY2VuZTogcywgaW5kZXg6IGkgfTtcbiAgICB9XG4gIH1cbiAgY29uc3QgZmFsbGJhY2tJbmRleCA9IHNjZW5lcy5maW5kSW5kZXgoKHMpID0+IHMuaWQgIT09IGV4Y2x1ZGVJZCk7XG4gIHJldHVybiB7IHNjZW5lOiBzY2VuZXNbZmFsbGJhY2tJbmRleF0sIGluZGV4OiBmYWxsYmFja0luZGV4IH07XG59XG5cbi8vIENoYW1waW9uIG1vZGU6IHdpbm5lciBzdGF5cyBvbiwgc3RhcnRpbmcgYWdhaW5zdCB0aGUgbG93ZXN0LXJhdGVkIHNjZW5lXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmV0Y2hDaGFtcGlvblBhaXIoXG4gIGZvcmNlZExlZnRTY2VuZTogU2NlbmUgfCBudWxsID0gbnVsbCxcbik6IFByb21pc2U8Q2hhbXBpb25QYWlyUmVzdWx0PiB7XG4gIGNvbnN0IGZpbHRlcnMgPSBjdXJyZW50RmlsdGVycygpO1xuXG4gIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+TiyBGZXRjaGluZyBzY2VuZXMgZm9yIGNoYW1waW9uLi4uXCIpO1xuICBjb25zdCB7IGxlZnRQb29sLCBhbGxTY2VuZXMgfSA9IGF3YWl0IGxvYWRTY2VuZVBvb2xzKGZpbHRlcnMpO1xuXG4gIGNvbnN0IHJpZ2h0UG9vbCA9IGJ1aWxkT3Bwb25lbnRQb29sKGFsbFNjZW5lcywgbGVmdFBvb2wsIGZpbHRlcnMpO1xuICBzdGF0ZS50b3RhbFNjZW5lc0NvdW50ID0gcmlnaHRQb29sLmxlbmd0aDtcblxuICBpZiAoYWxsU2NlbmVzLmxlbmd0aCA8IDIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJOb3QgZW5vdWdoIHNjZW5lcyBmb3IgY29tcGFyaXNvbi5cIik7XG4gIH1cblxuICAvLyBObyBjaGFtcGlvbiB5ZXQ6IHRoZSBjaGFsbGVuZ2VyIGZyb20gdGhlIGxlZnQgcG9vbCBzdGFydHMgYWdhaW5zdCB0aGUgbG93ZXN0LXJhdGVkIHNjZW5lXG4gIGlmICghc3RhdGUuY2hhbXBpb25TY2VuZSkge1xuICAgIHN0YXRlLmNoYW1waW9uRGVmZWF0ZWQgPSBbXTtcblxuICAgIGNvbnN0IGNoYWxsZW5nZXIgPSBmb3JjZWRMZWZ0U2NlbmUgfHwgZ2V0TmV4dEZpbHRlcmVkU2NlbmUobGVmdFBvb2wsIGZpbHRlcnMuZmlsdGVyS2V5KTtcbiAgICBpZiAoIWNoYWxsZW5nZXIpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIk5vIHNjZW5lcyBtYXRjaCB5b3VyIGZpbHRlciBjcml0ZXJpYS5cIik7XG4gICAgfVxuXG4gICAgY29uc3QgY2hhbGxlbmdlckluZGV4ID0gcmlnaHRQb29sLmZpbmRJbmRleCgocykgPT4gcy5pZCA9PT0gY2hhbGxlbmdlci5pZCk7XG4gICAgY29uc3QgeyBzY2VuZTogbG93ZXN0UmF0ZWQsIGluZGV4OiBsb3dlc3RJbmRleCB9ID0gZmluZExvd2VzdFJhdGVkKHJpZ2h0UG9vbCwgY2hhbGxlbmdlci5pZCk7XG4gICAgaWYgKCFsb3dlc3RSYXRlZCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiTm90IGVub3VnaCBzY2VuZXMgZm9yIGNvbXBhcmlzb24uIFlvdSBuZWVkIGF0IGxlYXN0IDIgc2NlbmVzLlwiKTtcbiAgICB9XG5cbiAgICByZXR1cm4ge1xuICAgICAgc2NlbmVzOiBbY2hhbGxlbmdlciwgbG93ZXN0UmF0ZWRdLFxuICAgICAgcmFua3M6IFtjaGFsbGVuZ2VySW5kZXggPj0gMCA/IGNoYWxsZW5nZXJJbmRleCArIDEgOiBudWxsLCBsb3dlc3RJbmRleCArIDFdLFxuICAgICAgaXNWaWN0b3J5OiBmYWxzZSxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgY2hhbXBpb24gPSBzdGF0ZS5jaGFtcGlvblNjZW5lO1xuICBjb25zdCBjaGFtcGlvbkluZGV4ID0gcmlnaHRQb29sLmZpbmRJbmRleCgocykgPT4gcy5pZCA9PT0gY2hhbXBpb24uaWQpO1xuICBjb25zdCByZW1haW5pbmdPcHBvbmVudHMgPSBnZXRSZW1haW5pbmdDaGFtcGlvbk9wcG9uZW50cyhjaGFtcGlvbiwgcmlnaHRQb29sLCBjaGFtcGlvbkluZGV4KTtcblxuICAvLyBObyBvcHBvbmVudHMgbGVmdDogdGhlIGNoYW1waW9uIGhhcyBiZWF0ZW4gZXZlcnlvbmUgYWJvdmUgaXRcbiAgaWYgKHJlbWFpbmluZ09wcG9uZW50cy5sZW5ndGggPT09IDApIHtcbiAgICByZXR1cm4geyBzY2VuZXM6IFtjaGFtcGlvbl0sIHJhbmtzOiBbMV0sIGlzVmljdG9yeTogdHJ1ZSB9O1xuICB9XG5cbiAgY29uc3QgbmV4dE9wcG9uZW50ID0gcGlja0Nsb3Nlc3RDaGFtcGlvbk9wcG9uZW50KHJlbWFpbmluZ09wcG9uZW50cyk7XG4gIGNvbnN0IG5leHRPcHBvbmVudEluZGV4ID0gcmlnaHRQb29sLmZpbmRJbmRleCgocykgPT4gcy5pZCA9PT0gbmV4dE9wcG9uZW50LmlkKTtcblxuICByZXR1cm4ge1xuICAgIHNjZW5lczogW2NoYW1waW9uLCBuZXh0T3Bwb25lbnRdLFxuICAgIHJhbmtzOiBbY2hhbXBpb25JbmRleCA+PSAwID8gY2hhbXBpb25JbmRleCArIDEgOiBudWxsLCBuZXh0T3Bwb25lbnRJbmRleCArIDFdLFxuICAgIGlzVmljdG9yeTogZmFsc2UsXG4gIH07XG59XG5cbi8vIC0tLSBQbGFjZW1lbnQgbW9kZSAodGhlIHNlYXJjaCBpdHNlbGYgaXMgaW4gcGxhY2VtZW50LnRzKSAtLS1cblxuLyoqIFJhbmRvbSBwaWNrIGFtb25nIHNjZW5lcyBpbiBbbG8sIGhpKSB0aGF0IHNoYXJlIHBvb2xbaWR4XSdzIEVMTyAodGhlaXIgb3JkZXIgaXMgYXJiaXRyYXJ5KS4gKi9cbmZ1bmN0aW9uIHBpY2tBbW9uZ1RpZXMocG9vbDogU2NlbmVbXSwgaWR4OiBudW1iZXIsIGxvOiBudW1iZXIsIGhpOiBudW1iZXIpOiBudW1iZXIge1xuICBjb25zdCB0YXJnZXQgPSBlbG8ocG9vbFtpZHhdKTtcbiAgY29uc3QgdGllczogbnVtYmVyW10gPSBbXTtcbiAgZm9yIChsZXQgaSA9IGxvOyBpIDwgaGk7IGkrKykge1xuICAgIGlmIChlbG8ocG9vbFtpXSkgPT09IHRhcmdldCkgdGllcy5wdXNoKGkpO1xuICB9XG4gIHJldHVybiB0aWVzW01hdGguZmxvb3IoTWF0aC5yYW5kb20oKSAqIHRpZXMubGVuZ3RoKV07XG59XG5cbi8vIFBsYWNlbWVudCBtb2RlOiBsZWZ0ID0gc2NlbmUgYmVpbmcgcGxhY2VkLCByaWdodCA9IHRoZSBuZXh0IG9wcG9uZW50IGluIGl0cyBzZWFyY2ggcmFuZ2VcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBmZXRjaFBsYWNlbWVudFBhaXIoXG4gIGZvcmNlZExlZnRTY2VuZTogU2NlbmUgfCBudWxsID0gbnVsbCxcbik6IFByb21pc2U8UGxhY2VtZW50UGFpclJlc3VsdD4ge1xuICBjb25zdCBmaWx0ZXJzID0gY3VycmVudEZpbHRlcnMoKTtcbiAgY29uc3QgeyBsZWZ0UG9vbCwgYWxsU2NlbmVzIH0gPSBhd2FpdCBsb2FkU2NlbmVQb29scyhmaWx0ZXJzKTtcblxuICBpZiAoYWxsU2NlbmVzLmxlbmd0aCA8IDIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJOb3QgZW5vdWdoIHNjZW5lcyBmb3IgY29tcGFyaXNvbi5cIik7XG4gIH1cblxuICBpZiAoIXN0YXRlLnBsYWNlbWVudCkge1xuICAgIGNvbnN0IHNjZW5lID0gZm9yY2VkTGVmdFNjZW5lIHx8IGdldE5leHRGaWx0ZXJlZFNjZW5lKGxlZnRQb29sLCBmaWx0ZXJzLmZpbHRlcktleSk7XG4gICAgaWYgKCFzY2VuZSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiTm8gc2NlbmVzIG1hdGNoIHlvdXIgZmlsdGVyIGNyaXRlcmlhLlwiKTtcbiAgICB9XG4gICAgc3RhdGUucGxhY2VtZW50ID0gbmV3UGxhY2VtZW50UnVuKHNjZW5lLCBzdGF0ZS5zZXR0aW5ncy5wbGFjZW1lbnRGcm9tQm90dG9tKTtcbiAgfVxuICBjb25zdCBydW4gPSBzdGF0ZS5wbGFjZW1lbnQ7XG5cbiAgY29uc3QgcG9vbCA9IGJ1aWxkT3Bwb25lbnRQb29sKGFsbFNjZW5lcywgbGVmdFBvb2wsIGZpbHRlcnMpLmZpbHRlcigocykgPT4gcy5pZCAhPT0gcnVuLnNjZW5lLmlkKTtcbiAgaWYgKHBvb2wubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiTm90IGVub3VnaCBzY2VuZXMgZm9yIGNvbXBhcmlzb24uIFlvdSBuZWVkIGF0IGxlYXN0IDIgc2NlbmVzLlwiKTtcbiAgfVxuICBzdGF0ZS50b3RhbFNjZW5lc0NvdW50ID0gcG9vbC5sZW5ndGggKyAxO1xuXG4gIGNvbnN0IHN0ZXAgPSBwbGFjZW1lbnRTdGVwKHJ1biwgcG9vbCk7XG4gIHJ1bi5yYW5nZUxvID0gTWF0aC5taW4oc3RlcC5sbywgc3RlcC5oaSk7XG4gIHJ1bi5yYW5nZUhpID0gc3RlcC5oaTtcblxuICBpZiAoc3RlcC5kb25lKSB7XG4gICAgLy8gT25seSB0aGUgcGxhY2VkIHNjZW5lJ3MgRUxPIGNoYW5nZXM7IGl0J3MgY3JlZGl0ZWQgd2l0aCB0aGUgYmF0dGxlcyB0aGlzIHJ1biB0b29rXG4gICAgY29uc3QgbmV3RWxvID0gbGFuZGluZ0Vsbyhwb29sLCBzdGVwLnNsb3QpO1xuICAgIGNvbnN0IG5ld0JhdHRsZXMgPSBiYXR0bGVzKGxhdGVzdFNjZW5lKHJ1bi5zY2VuZSkpICsgcnVuLmJhdHRsZXM7XG4gICAgY29uc29sZS5sb2coXG4gICAgICBgW1N0YXNoIEJhdHRsZV0g8J+TjSBQbGFjZW1lbnQ6IHNjZW5lICR7cnVuLnNjZW5lLmlkfSBwbGFjZWQgYXQgIyR7c3RlcC5zbG90ICsgMX0gYWZ0ZXIgJHtydW4uYmF0dGxlc30gYmF0dGxlcywgRUxPICR7bmV3RWxvfWAsXG4gICAgKTtcbiAgICBhd2FpdCB3cml0ZUVsbyhydW4uc2NlbmUsIG5ld0VsbywgbmV3QmF0dGxlcywgcnVuLnJlc3VsdHMgPz8gW10pO1xuICAgIHJldHVybiB7XG4gICAgICBkb25lOiB0cnVlLFxuICAgICAgc2NlbmU6IHJ1bi5zY2VuZSxcbiAgICAgIHJhbms6IHN0ZXAuc2xvdCArIDEsXG4gICAgICBlbG86IG5ld0VsbyxcbiAgICAgIGJhdHRsZXM6IHJ1bi5iYXR0bGVzLFxuICAgICAgc3RyZWFrOiBydW4uc3RyZWFrLFxuICAgICAgZnJvbUJvdHRvbTogcnVuLmZyb21Cb3R0b20sXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IGlkeCA9IHBpY2tBbW9uZ1RpZXMocG9vbCwgc3RlcC5pbmRleCwgc3RlcC5sbywgc3RlcC5oaSk7XG4gIHJldHVybiB7IGRvbmU6IGZhbHNlLCBzY2VuZXM6IFtydW4uc2NlbmUsIHBvb2xbaWR4XV0sIHJhbmtzOiBbbnVsbCwgaWR4ICsgMV0gfTtcbn1cbiIsICIvLyBSZW5kZXJzIGFuIGluZGl2aWR1YWwgc2NlbmUgY2FyZCAocmV0dXJucyBhbiBIVE1MIHN0cmluZykuXG5cbmltcG9ydCB7IENIQU1QSU9OX1VOUkFURURfRUxPLCBFTE9fS19USUVSUywgRUxPX1NUQVJUIH0gZnJvbSBcIi4uL2NvbnN0YW50c1wiO1xuaW1wb3J0IHsgc2NlbmVzTGlzdFF1ZXJ5IH0gZnJvbSBcIi4uL2ZpbHRlcnNcIjtcbmltcG9ydCB7IGZvcm1hdFJhdGluZyB9IGZyb20gXCIuLi9yYXRpbmdEaXNwbGF5XCI7XG5pbXBvcnQgeyBiYXR0bGVzLCBlbG8sIGlzUHJvdmlzaW9uYWwsIHJlY29yZFRleHQgfSBmcm9tIFwiLi4vc2NvcmVcIjtcbmltcG9ydCB7IHN0YXRlIH0gZnJvbSBcIi4uL3N0YXRlXCI7XG5pbXBvcnQgeyB0aWVyRGVzY3JpcHRpb24gfSBmcm9tIFwiLi4vc3RhdHNcIjtcbmltcG9ydCB7IGlzU3Rhc2hEZWxldGVEaWFsb2dBdmFpbGFibGUgfSBmcm9tIFwiLi9kZWxldGVEaWFsb2dcIjtcbmltcG9ydCB0eXBlIHsgUmFuaywgU2NlbmUsIFRpZXIgfSBmcm9tIFwiLi4vdHlwZXNcIjtcbmltcG9ydCB7IHJlc29sdmVTY2VuZVRpdGxlIH0gZnJvbSBcIi4uL3NjZW5lVGl0bGVcIjtcblxuLyoqIFRvb2x0aXAgZm9yIGEgcHJvdmlzaW9uYWwgRUxPICh0aGUgXCI/XCIgYWZ0ZXIgaXQpLiAqL1xuZXhwb3J0IGNvbnN0IFBST1ZJU0lPTkFMX1RJUCA9IGBQcm92aXNpb25hbDogZmV3ZXIgdGhhbiAke0VMT19LX1RJRVJTWzBdWzBdfSBiYXR0bGVzLCBzbyB0aGlzIEVMTyBpcyBzdGlsbCBzZXR0bGluZ2A7XG5cbi8qKiBTbWFsbCBwaWxsIHdpdGggdGhlIHRpZXIncyBlbW9qaSBhbmQgbmFtZSAodGhlIG5hbWUgaGlkZXMgb24gcGhvbmVzKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0aWVyUGlsbCh0aWVyOiBUaWVyKTogc3RyaW5nIHtcbiAgcmV0dXJuIGA8c3BhbiBjbGFzcz1cInNiLXRpZXIgc2ItdGllci0ke3RpZXIuaWR9XCIgdGl0bGU9XCIke3RpZXJEZXNjcmlwdGlvbih0aWVyKX1cIj4ke3RpZXIuZW1vaml9PHNwYW4gY2xhc3M9XCJzYi10aWVyLW5hbWVcIj4gJHt0aWVyLm5hbWV9PC9zcGFuPjwvc3Bhbj5gO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0RHVyYXRpb24oc2Vjb25kczogbnVtYmVyIHwgbnVsbCB8IHVuZGVmaW5lZCk6IHN0cmluZyB7XG4gIGlmICghc2Vjb25kcykgcmV0dXJuIFwiTi9BXCI7XG4gIGNvbnN0IGggPSBNYXRoLmZsb29yKHNlY29uZHMgLyAzNjAwKTtcbiAgY29uc3QgbSA9IE1hdGguZmxvb3IoKHNlY29uZHMgJSAzNjAwKSAvIDYwKTtcbiAgY29uc3QgcyA9IE1hdGguZmxvb3Ioc2Vjb25kcyAlIDYwKTtcbiAgaWYgKGggPiAwKSB7XG4gICAgcmV0dXJuIGAke2h9OiR7bS50b1N0cmluZygpLnBhZFN0YXJ0KDIsIFwiMFwiKX06JHtzLnRvU3RyaW5nKCkucGFkU3RhcnQoMiwgXCIwXCIpfWA7XG4gIH1cbiAgcmV0dXJuIGAke219OiR7cy50b1N0cmluZygpLnBhZFN0YXJ0KDIsIFwiMFwiKX1gO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlU2NlbmVDYXJkKFxuICBzY2VuZTogU2NlbmUsXG4gIHNpZGU6IFwibGVmdFwiIHwgXCJyaWdodFwiLFxuICByYW5rOiBSYW5rID0gbnVsbCxcbiAgc3RhdHVzQmFkZ2U6IG51bWJlciB8IHN0cmluZyB8IG51bGwgPSBudWxsLFxuICB0aWVyOiBUaWVyIHwgbnVsbCA9IG51bGwsXG4pOiBzdHJpbmcge1xuICBjb25zdCBmaWxlID0gc2NlbmUuZmlsZXMgJiYgc2NlbmUuZmlsZXNbMF0gPyBzY2VuZS5maWxlc1swXSA6IHt9O1xuICBjb25zdCBkdXJhdGlvbiA9IGZpbGUuZHVyYXRpb247XG4gIGNvbnN0IHBlcmZvcm1lcnMgPVxuICAgIHNjZW5lLnBlcmZvcm1lcnMgJiYgc2NlbmUucGVyZm9ybWVycy5sZW5ndGggPiAwXG4gICAgICA/IHNjZW5lLnBlcmZvcm1lcnMubWFwKChwKSA9PiBwLm5hbWUpLmpvaW4oXCIsIFwiKVxuICAgICAgOiBcIk5vIHBlcmZvcm1lcnNcIjtcbiAgY29uc3Qgc3R1ZGlvID0gc2NlbmUuc3R1ZGlvID8gc2NlbmUuc3R1ZGlvLm5hbWUgOiBcIk5vIHN0dWRpb1wiO1xuICBjb25zdCB0YWdzID0gc2NlbmUudGFncyA/IHNjZW5lLnRhZ3Muc2xpY2UoMCwgNSkubWFwKCh0KSA9PiB0Lm5hbWUpIDogW107XG4gIC8vIFBob25lcyBoYXZlIHJvb20gZm9yIG9uZSBkZXRhaWwgYmVzaWRlIHRoZSByYXRpbmc6IHRoZSBmaXJzdCB0aGUgc2NlbmUgaGFzIChzdHVkaW8sIHRoZW5cbiAgLy8gcGVyZm9ybWVycywgdGhlbiB0YWdzKSwgb3Igbm9uZVxuICBjb25zdCBjb21wYWN0RGV0YWlsID0gc2NlbmUuc3R1ZGlvPy5uYW1lIHx8IChzY2VuZS5wZXJmb3JtZXJzPy5sZW5ndGggPyBwZXJmb3JtZXJzIDogXCJcIikgfHwgdGFncy5qb2luKFwiLCBcIik7XG5cbiAgY29uc3QgdGl0bGUgPSByZXNvbHZlU2NlbmVUaXRsZShzY2VuZSk7XG5cbiAgY29uc3Qgc2NyZWVuc2hvdFBhdGggPSBzY2VuZS5wYXRocyA/IHNjZW5lLnBhdGhzLnNjcmVlbnNob3QgOiBudWxsO1xuICBjb25zdCBwcmV2aWV3UGF0aCA9IHNjZW5lLnBhdGhzID8gc2NlbmUucGF0aHMucHJldmlldyA6IG51bGw7XG4gIGNvbnN0IHsgb3BlbkluTmV3VGFiLCBjbGVhbk1vZGUgfSA9IHN0YXRlLnNldHRpbmdzO1xuICBjb25zdCBzdGFzaFJhdGluZyA9IHNjZW5lLnJhdGluZzEwMCA/IGZvcm1hdFJhdGluZyhzY2VuZS5yYXRpbmcxMDApIDogXCJOb25lXCI7XG5cbiAgLy8gRUxPIGJhZGdlOiBcIkVMTyAxNzQwIMK3ICM1MFwiIHdoZW4gcmF0ZWQgKHJhbmsgd2hlbiBrbm93biksIHdpdGggYSBcIj9cIiB3aGlsZSBpdCdzIHByb3Zpc2lvbmFsLlxuICAvLyBVbnJhdGVkIHNjZW5lcyBzaG93IHRoZSBFTE8gdGhleSBjb3VudCBhcyBpbiB0aGlzIG1vZGUgaW4gdGhlIHNhbWUgb3JkZXIsIFwiRUxPIDE1MDAgwrdcbiAgLy8gVW5yYXRlZFwiIChQbGFjZW1lbnQgaGFzIG5vbmU6IFwiVW5yYXRlZFwiKS5cbiAgY29uc3QgZWxvVmFsdWUgPSBlbG8oc2NlbmUpO1xuICBjb25zdCB1bnJhdGVkQXMgPVxuICAgIHN0YXRlLmN1cnJlbnRNb2RlID09PSBcInN3aXNzXCIgPyBFTE9fU1RBUlQgOiBzdGF0ZS5jdXJyZW50TW9kZSA9PT0gXCJjaGFtcGlvblwiID8gQ0hBTVBJT05fVU5SQVRFRF9FTE8gOiBudWxsO1xuICBjb25zdCBwcm92aXNpb25hbCA9IGlzUHJvdmlzaW9uYWwoc2NlbmUpO1xuICBsZXQgZWxvTGFiZWw6IHN0cmluZztcbiAgaWYgKGVsb1ZhbHVlICE9PSBudWxsKSB7XG4gICAgZWxvTGFiZWwgPSBgRUxPICR7TWF0aC5yb3VuZChlbG9WYWx1ZSl9JHtwcm92aXNpb25hbCA/IFwiP1wiIDogXCJcIn0ke3JhbmsgIT09IG51bGwgJiYgcmFuayAhPT0gdW5kZWZpbmVkID8gYCDCtyAjJHtyYW5rfWAgOiBcIlwifWA7XG4gIH0gZWxzZSB7XG4gICAgZWxvTGFiZWwgPSB1bnJhdGVkQXMgIT09IG51bGwgPyBgRUxPICR7dW5yYXRlZEFzfSDCtyBVbnJhdGVkYCA6IFwiVW5yYXRlZFwiO1xuICB9XG4gIC8vIFwiVGllciBjb2xvdXJzIG9uIGNhcmQgYm9yZGVyc1wiOiB0aGUgYm9yZGVyIHRha2VzIHRoZSB0aWVyJ3MgY29sb3VyICh0aGUgcGlsbCBhbHdheXMgc2hvd3MpXG4gIGNvbnN0IGJvcmRlciA9IHRpZXIgIT09IG51bGwgJiYgc3RhdGUuc2V0dGluZ3MudGllckJvcmRlcnM7XG4gIGNvbnN0IHJhbmtUaXRsZSA9IHByb3Zpc2lvbmFsID8gYCB0aXRsZT1cIiR7UFJPVklTSU9OQUxfVElQfVwiYCA6IFwiXCI7XG4gIC8vIFwiUmVjb3JkOiAxMuKAkzVcIjsgYmF0dGxlcyBmcm9tIGJlZm9yZSByZWNvcmRzIGJlZ2FuIHNob3cgYXMgXCJCYXR0bGVzOiBOXCJcbiAgY29uc3QgcmVjb3JkID0gcmVjb3JkVGV4dChzY2VuZSk7XG4gIGNvbnN0IHJhbmtEaXNwbGF5ID0gYCR7dGllciA/IHRpZXJQaWxsKHRpZXIpIDogXCJcIn08c3BhbiBjbGFzcz1cInNiLXNjZW5lLXJhbmtcIiR7cmFua1RpdGxlfT4ke2Vsb0xhYmVsfTwvc3Bhbj5gO1xuXG4gIC8vIFN0YXR1cyBiYWRnZTogd2luLXN0cmVhayBjb3VudCAoZm9ybWF0dGVkKSBvciBjdXN0b20gbGFiZWwgKGUuZy4gZmFsbGluZyBtb2RlKVxuICBsZXQgc3RhdHVzQmFkZ2VIdG1sID0gXCJcIjtcbiAgaWYgKHR5cGVvZiBzdGF0dXNCYWRnZSA9PT0gXCJzdHJpbmdcIikge1xuICAgIHN0YXR1c0JhZGdlSHRtbCA9IGA8ZGl2IGNsYXNzPVwic2Itc3RyZWFrLWJhZGdlXCI+JHtzdGF0dXNCYWRnZX08L2Rpdj5gO1xuICB9IGVsc2UgaWYgKHN0YXR1c0JhZGdlICE9PSBudWxsICYmIHN0YXR1c0JhZGdlID4gMCkge1xuICAgIHN0YXR1c0JhZGdlSHRtbCA9IGA8ZGl2IGNsYXNzPVwic2Itc3RyZWFrLWJhZGdlXCI+8J+UpSAke3N0YXR1c0JhZGdlfSB3aW4ke3N0YXR1c0JhZGdlID4gMSA/IFwic1wiIDogXCJcIn08L2Rpdj5gO1xuICB9XG5cbiAgLy8gS2VlcCB0aGUgU2NlbmVzIHBhZ2UncyBmaWx0ZXIgaW4gdGhlIFVSTCB3aGVuIG9wZW5pbmcgdGhlIHNjZW5lXG4gIGNvbnN0IGN1cnJlbnRQYXJhbXMgPSBzY2VuZXNMaXN0UXVlcnkoKTtcbiAgY29uc3Qgc2NlbmVVcmwgPSBgL3NjZW5lcy8ke3NjZW5lLmlkfSR7Y3VycmVudFBhcmFtc31gO1xuICBjb25zdCBsaW5rVGFyZ2V0ID0gb3BlbkluTmV3VGFiID8gYCB0YXJnZXQ9XCJfYmxhbmtcIiByZWw9XCJub29wZW5lclwiYCA6IFwiXCI7XG5cbiAgLy8gcHdyLSogY2xhc3NlcyBhcmUgdGhlIHBsdWdpbidzIHByZS0yLjAgbmFtZXM7IFNGVyBTd2l0Y2ggc3RpbGwgdGFyZ2V0cyB0aGVtIHRvIGJsdXIgU3Rhc2ggQmF0dGxlLlxuICAvLyBCYWRnZXMgc2l0IG91dHNpZGUgdGhlIChibHVycmVkKSBpbWFnZSBjb250YWluZXIgc28gdGhleSBzdGF5IHJlYWRhYmxlIGluIFNGVyBtb2RlLlxuICByZXR1cm4gYFxuICAgICAgPGRpdiBjbGFzcz1cInNiLXNjZW5lLWNhcmQke2JvcmRlciA/IGAgc2ItdGllci0ke3RpZXI/LmlkfWAgOiBcIlwifVwiIGRhdGEtc2lkZT1cIiR7c2lkZX1cIiR7Ym9yZGVyID8gYCBkYXRhLXRpZXI9XCIke3RpZXI/LmlkfVwiYCA6IFwiXCJ9PlxuICAgICAgICA8ZGl2IGNsYXNzPVwic2Itc2NlbmUtbWVkaWFcIj5cbiAgICAgICAgICA8YSBjbGFzcz1cInNiLXNjZW5lLWltYWdlLWNvbnRhaW5lciBwd3Itc2NlbmUtaW1hZ2UtY29udGFpbmVyXCIgaHJlZj1cIiR7c2NlbmVVcmx9XCIke2xpbmtUYXJnZXR9PlxuICAgICAgICAgICAgJHtcbiAgICAgICAgICAgICAgc2NyZWVuc2hvdFBhdGhcbiAgICAgICAgICAgICAgICA/IGA8aW1nIGNsYXNzPVwic2Itc2NlbmUtaW1hZ2UgcHdyLXNjZW5lLWltYWdlXCIgc3JjPVwiJHtzY3JlZW5zaG90UGF0aH1cIiBhbHQ9XCIke3RpdGxlfVwiIGxvYWRpbmc9XCJsYXp5XCIgLz5gXG4gICAgICAgICAgICAgICAgOiBgPGRpdiBjbGFzcz1cInNiLXNjZW5lLWltYWdlIHNiLW5vLWltYWdlXCI+Tm8gU2NyZWVuc2hvdDwvZGl2PmBcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgICR7cHJldmlld1BhdGggPyBgPHZpZGVvIGNsYXNzPVwic2ItaG92ZXItcHJldmlldyBwd3ItaG92ZXItcHJldmlld1wiIHNyYz1cIiR7cHJldmlld1BhdGh9XCIgbG9vcCBtdXRlZCBwbGF5c2lubGluZT48L3ZpZGVvPmAgOiBcIlwifVxuICAgICAgICAgIDwvYT5cbiAgICAgICAgICA8ZGl2IGNsYXNzPVwic2Itc2NlbmUtZHVyYXRpb25cIj4ke2Zvcm1hdER1cmF0aW9uKGR1cmF0aW9uKX08L2Rpdj5cbiAgICAgICAgICA8YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cInNiLWNhcmQtbXV0ZVwiIGFyaWEtbGFiZWw9XCJQbGF5IHRoaXMgcHJldmlldyB3aXRoIHNvdW5kXCI+8J+UhzwvYnV0dG9uPlxuICAgICAgICAgICR7c3RhdHVzQmFkZ2VIdG1sfVxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1jbGljay1oaW50XCI+JHtvcGVuSW5OZXdUYWIgPyBcIkNsaWNrIHRvIG9wZW4gaW4gbmV3IHRhYlwiIDogXCJDbGljayB0byBvcGVuIHNjZW5lXCJ9PC9kaXY+XG4gICAgICAgICAgPGEgY2xhc3M9XCJzYi1vcGVuLWxpbmtcIiBocmVmPVwiJHtzY2VuZVVybH1cIiB0YXJnZXQ9XCJfYmxhbmtcIiByZWw9XCJub29wZW5lclwiIHRpdGxlPVwiT3BlbiBzY2VuZSBpbiBuZXcgdGFiXCI+4oaXPC9hPlxuICAgICAgICAgICR7Y2xlYW5Nb2RlICYmIGlzU3Rhc2hEZWxldGVEaWFsb2dBdmFpbGFibGUoKSA/IGA8YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cInNiLWRlbGV0ZS1idG5cIiB0aXRsZT1cIkRlbGV0ZSB0aGlzIHNjZW5lIGZyb20gU3Rhc2hcIj7wn5eRPC9idXR0b24+YCA6IFwiXCJ9XG4gICAgICAgIDwvZGl2PlxuXG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi1zY2VuZS1ib2R5XCIgZGF0YS13aW5uZXI9XCIke3NjZW5lLmlkfVwiPlxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1zY2VuZS1pbmZvIHB3ci1zY2VuZS1pbmZvXCI+XG4gICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2Itc2NlbmUtdGl0bGUtcm93XCI+XG4gICAgICAgICAgICAgIDxoMyBjbGFzcz1cInNiLXNjZW5lLXRpdGxlXCI+JHt0aXRsZX08L2gzPlxuICAgICAgICAgICAgICAke3JhbmtEaXNwbGF5fVxuICAgICAgICAgICAgPC9kaXY+XG5cbiAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1zY2VuZS1tZXRhXCI+XG4gICAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1tZXRhLWl0ZW0gc2ItbWV0YS1wbGF5c1wiPjxzdHJvbmc+UGxheSBDb3VudDo8L3N0cm9uZz4gJHtzY2VuZS5wbGF5X2NvdW50IHx8IDB9PC9kaXY+XG4gICAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1tZXRhLWl0ZW0gc2ItbWV0YS1iYXR0bGVzXCI+JHtyZWNvcmQgIT09IG51bGwgPyBgPHN0cm9uZz5SZWNvcmQ6PC9zdHJvbmc+ICR7cmVjb3JkfWAgOiBgPHN0cm9uZz5CYXR0bGVzOjwvc3Ryb25nPiAke2JhdHRsZXMoc2NlbmUpfWB9PC9kaXY+XG4gICAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1tZXRhLWl0ZW0gc2ItbWV0YS1yYXRpbmdcIj48c3Ryb25nPlN0YXNoIFJhdGluZzo8L3N0cm9uZz4gJHtzdGFzaFJhdGluZ308c3BhbiBjbGFzcz1cInNiLW1ldGEtcmVjb3JkLWlubGluZVwiPiDCtyAke3JlY29yZCAhPT0gbnVsbCA/IGA8c3Ryb25nPlJlY29yZDo8L3N0cm9uZz4gJHtyZWNvcmR9YCA6IGAke2JhdHRsZXMoc2NlbmUpfSBiYXR0bGUke2JhdHRsZXMoc2NlbmUpID09PSAxID8gXCJcIiA6IFwic1wifWB9PC9zcGFuPjwvZGl2PlxuICAgICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItbWV0YS1pdGVtIHNiLW1ldGEtY29tcGFjdFwiPiR7Y29tcGFjdERldGFpbH08L2Rpdj5cbiAgICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNiLW1ldGEtaXRlbSBzYi1tZXRhLXN0dWRpb1wiPjxzdHJvbmc+U3R1ZGlvOjwvc3Ryb25nPiAke3N0dWRpb308L2Rpdj5cbiAgICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNiLW1ldGEtaXRlbSBzYi1tZXRhLXBlcmZvcm1lcnNcIj48c3Ryb25nPlBlcmZvcm1lcnM6PC9zdHJvbmc+ICR7cGVyZm9ybWVyc308L2Rpdj5cbiAgICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNiLW1ldGEtaXRlbSBzYi10YWdzLXJvd1wiPjxzdHJvbmc+VGFnczo8L3N0cm9uZz4gJHt0YWdzLmxlbmd0aCA+IDAgPyB0YWdzLm1hcCgodGFnKSA9PiBgPHNwYW4gY2xhc3M9XCJzYi10YWdcIj4ke3RhZ308L3NwYW4+YCkuam9pbihcIlwiKSA6ICc8c3BhbiBjbGFzcz1cInNiLW5vbmVcIj5Ob25lPC9zcGFuPid9PC9kaXY+XG4gICAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgICA8L2Rpdj5cblxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1jaG9vc2UtYnRuXCI+XG4gICAgICAgICAgICDinJMgQ2hvb3NlPHNwYW4gY2xhc3M9XCJzYi1jaG9vc2UtbG9uZ1wiPiBUaGlzIFNjZW5lPC9zcGFuPlxuICAgICAgICAgIDwvZGl2PlxuICAgICAgICA8L2Rpdj5cbiAgICAgIDwvZGl2PlxuICAgIGA7XG59XG4iLCAiLy8gQSBzbWFsbCBzY2VuZSBjYXJkIChFeHBsb3JlIHRhYiwgYW5kIHRoZSBob3ZlciBjYXJkIG9uIHRoZSBTdGF0cyB0YWIncyBoaWRkZW4gZ2VtcyBjaGFydCk6XHJcbi8vIHRodW1ibmFpbCwgdGl0bGUsIHRpZXIgYW5kIFwiRUxPIDE4MjAgwrcgIzk3XCIsIHBsYXlzIGFuZCBiYXR0bGVzLiBSZXR1cm5zIGFuIEhUTUwgc3RyaW5nLlxyXG4vLyBUaGUgdGh1bWJuYWlsLCBpbWFnZSBhbmQgaW5mbyBjYXJyeSB0aGUgcHJlLTIuMCBwd3ItKiBjbGFzcyBuYW1lcyB0b28sIHNvIFNGVyBTd2l0Y2ggYmx1cnMgdGhlbVxyXG4vLyBhcyBpdCBkb2VzIHRoZSBiYXR0bGUgY2FyZHMuXHJcblxyXG5pbXBvcnQgdHlwZSB7IEV4cGxvcmVFbnRyeSB9IGZyb20gXCIuLi9leHBsb3JlXCI7XHJcbmltcG9ydCB7IHNjZW5lc0xpc3RRdWVyeSB9IGZyb20gXCIuLi9maWx0ZXJzXCI7XHJcbmltcG9ydCB7IGJhdHRsZXMsIGVsbywgaXNQcm92aXNpb25hbCwgcmVjb3JkVGV4dCB9IGZyb20gXCIuLi9zY29yZVwiO1xyXG5pbXBvcnQgeyBzdGF0ZSB9IGZyb20gXCIuLi9zdGF0ZVwiO1xyXG5pbXBvcnQgeyBpc1RvdWNoRGV2aWNlLCBzbGlkZXJUb1ZvbHVtZSB9IGZyb20gXCIuL21haW5VSVwiO1xyXG5pbXBvcnQgeyB0aWVyUGlsbCwgUFJPVklTSU9OQUxfVElQIH0gZnJvbSBcIi4vc2NlbmVDYXJkXCI7XHJcbmltcG9ydCB7IHJlc29sdmVTY2VuZVRpdGxlIH0gZnJvbSBcIi4uL3NjZW5lVGl0bGVcIjtcclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBlc2NhcGVIdG1sKHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgcmV0dXJuIHRleHQucmVwbGFjZSgvWyY8PlwiXS9nLCAoYykgPT4gKHsgXCImXCI6IFwiJmFtcDtcIiwgXCI8XCI6IFwiJmx0O1wiLCBcIj5cIjogXCImZ3Q7XCIsICdcIic6IFwiJnF1b3Q7XCIgfSlbY10gYXMgc3RyaW5nKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHBsdXJhbChuOiBudW1iZXIsIHdvcmQ6IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgcmV0dXJuIGAke259ICR7d29yZH0ke24gPT09IDEgPyBcIlwiIDogXCJzXCJ9YDtcclxufVxyXG5cclxuLyoqIFRoZSBzY2VuZSdzIHBhZ2UsIGtlZXBpbmcgdGhlIGN1cnJlbnQgU2NlbmVzIGZpbHRlciBpbiB0aGUgVVJMIChsaWtlIHRoZSBiYXR0bGUgY2FyZHMpLiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gc2NlbmVVcmwoc2NlbmVJZDogc3RyaW5nKTogc3RyaW5nIHtcclxuICByZXR1cm4gYC9zY2VuZXMvJHtzY2VuZUlkfSR7c2NlbmVzTGlzdFF1ZXJ5KCl9YDtcclxufVxyXG5cclxuLyoqXHJcbiAqIGBsaW5rYDogdGhlIHRodW1ibmFpbCBhbmQgdGV4dCBhcmUgYSBsaW5rIHRvIHRoZSBzY2VuZSdzIHBhZ2UsIGFuZCBhIOKalO+4jyBidXR0b24gYmF0dGxlcyBpdC5cclxuICogV2l0aG91dCBpdCAodGhlIGhvdmVyIGNhcmQpIGl0J3MgZGlzcGxheSBvbmx5LlxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIG1pbmlDYXJkSHRtbChlbnRyeTogRXhwbG9yZUVudHJ5LCBsaW5rID0gdHJ1ZSk6IHN0cmluZyB7XHJcbiAgY29uc3QgeyBzY2VuZSwgcmFuaywgdGllciB9ID0gZW50cnk7XHJcbiAgY29uc3QgdGl0bGUgPSBlc2NhcGVIdG1sKHJlc29sdmVTY2VuZVRpdGxlKHNjZW5lKSB8fCBgU2NlbmUgJHtzY2VuZS5pZH1gKTtcclxuICBjb25zdCB2YWx1ZSA9IGVsbyhzY2VuZSk7XHJcbiAgY29uc3QgcHJvdmlzaW9uYWwgPSBpc1Byb3Zpc2lvbmFsKHNjZW5lKTtcclxuICBjb25zdCBlbG9UZXh0ID1cclxuICAgIHZhbHVlID09PSBudWxsID8gXCJVbnJhdGVkXCIgOiBgRUxPICR7TWF0aC5yb3VuZCh2YWx1ZSl9JHtwcm92aXNpb25hbCA/IFwiP1wiIDogXCJcIn0ke3JhbmsgIT09IG51bGwgPyBgIMK3ICMke3Jhbmt9YCA6IFwiXCJ9YDtcclxuICBjb25zdCBzY3JlZW5zaG90ID0gc2NlbmUucGF0aHM/LnNjcmVlbnNob3Q7XHJcbiAgY29uc3QgdGh1bWIgPSBzY3JlZW5zaG90XHJcbiAgICA/IGA8aW1nIGNsYXNzPVwic2ItbWluaS1pbWcgcHdyLXNjZW5lLWltYWdlXCIgc3JjPVwiJHtzY3JlZW5zaG90fVwiIGFsdD1cIlwiIGxvYWRpbmc9XCJsYXp5XCIgLz5gXHJcbiAgICA6IGA8ZGl2IGNsYXNzPVwic2ItbWluaS1pbWcgc2Itbm8taW1hZ2VcIj5ObyBTY3JlZW5zaG90PC9kaXY+YDtcclxuICBjb25zdCBwbGF5cyA9IHNjZW5lLnBsYXlfY291bnQgPz8gMDtcclxuICBjb25zdCBib2R5ID0gYFxyXG4gICAgICAgICAgPGRpdiBjbGFzcz1cInNiLW1pbmktdGh1bWIgcHdyLXNjZW5lLWltYWdlLWNvbnRhaW5lclwiPiR7dGh1bWJ9PC9kaXY+XHJcbiAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItbWluaS1ib2R5IHB3ci1zY2VuZS1pbmZvXCI+XHJcbiAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1taW5pLXRpdGxlXCIgdGl0bGU9XCIke3RpdGxlfVwiPiR7dGl0bGV9PC9kaXY+XHJcbiAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1taW5pLWVsb1wiPiR7dGllciA/IHRpZXJQaWxsKHRpZXIpIDogXCJcIn08c3BhbiBjbGFzcz1cInNiLW1pbmktcmFua1wiJHtwcm92aXNpb25hbCA/IGAgdGl0bGU9XCIke1BST1ZJU0lPTkFMX1RJUH1cImAgOiBcIlwifT4ke2Vsb1RleHR9PC9zcGFuPjwvZGl2PlxyXG4gICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItbWluaS1tZXRhXCI+JHtwbHVyYWwocGxheXMsIFwicGxheVwiKX0gwrcgJHtyZWNvcmRUZXh0KHNjZW5lKSA/PyBwbHVyYWwoYmF0dGxlcyhzY2VuZSksIFwiYmF0dGxlXCIpfTwvZGl2PlxyXG4gICAgICAgICAgPC9kaXY+YDtcclxuICBjb25zdCB0aWVyQXR0cnMgPSB0aWVyID8gYCBzYi10aWVyLSR7dGllci5pZH1cIiBkYXRhLXRpZXI9XCIke3RpZXIuaWR9YCA6IFwiXCI7XHJcbiAgY29uc3QgcHJldmlldyA9IHNjZW5lLnBhdGhzPy5wcmV2aWV3ID8gYCBkYXRhLXByZXZpZXc9XCIke3NjZW5lLnBhdGhzLnByZXZpZXd9XCJgIDogXCJcIjtcclxuICBpZiAoIWxpbmspIHJldHVybiBgPGRpdiBjbGFzcz1cInNiLW1pbmktY2FyZCBzYi1taW5pLXN0YXRpYyR7dGllckF0dHJzfVwiPiR7Ym9keX08L2Rpdj5gO1xyXG4gIGNvbnN0IHRhcmdldCA9IHN0YXRlLnNldHRpbmdzLm9wZW5Jbk5ld1RhYiA/IGAgdGFyZ2V0PVwiX2JsYW5rXCIgcmVsPVwibm9vcGVuZXJcImAgOiBcIlwiO1xyXG4gIHJldHVybiBgXHJcbiAgICAgICAgPGRpdiBjbGFzcz1cInNiLW1pbmktY2FyZCR7dGllckF0dHJzfVwiIGRhdGEtc2NlbmUtaWQ9XCIke3NjZW5lLmlkfVwiJHtwcmV2aWV3fT5cclxuICAgICAgICAgIDxhIGNsYXNzPVwic2ItbWluaS1saW5rXCIgaHJlZj1cIiR7c2NlbmVVcmwoc2NlbmUuaWQpfVwiJHt0YXJnZXR9PiR7Ym9keX08L2E+JHtcclxuICAgICAgICAgICAgc2NlbmUucGF0aHM/LnByZXZpZXdcclxuICAgICAgICAgICAgICA/IGA8ZGl2IGNsYXNzPVwic2ItbWluaS1vdmVybGF5XCI+PGJ1dHRvbiB0eXBlPVwiYnV0dG9uXCIgY2xhc3M9XCJzYi1jYXJkLW11dGUgc2ItbWluaS1tdXRlXCIgYXJpYS1sYWJlbD1cIlBsYXkgdGhpcyBwcmV2aWV3IHdpdGggc291bmRcIj7wn5SHPC9idXR0b24+PC9kaXY+YFxyXG4gICAgICAgICAgICAgIDogXCJcIlxyXG4gICAgICAgICAgfVxyXG4gICAgICAgICAgPGJ1dHRvbiB0eXBlPVwiYnV0dG9uXCIgY2xhc3M9XCJzYi1taW5pLWJhdHRsZVwiIGRhdGEtYmF0dGxlPVwiJHtzY2VuZS5pZH1cIiB0aXRsZT1cIkJhdHRsZSB0aGlzIHNjZW5lXCI+4pqU77iPPC9idXR0b24+XHJcbiAgICAgICAgPC9kaXY+YDtcclxufVxyXG5cclxuLy8gLS0tLS0tLS0tLSBQcmV2aWV3IChvbmUgc21hbGwgY2FyZCBhdCBhIHRpbWUsIGFueXdoZXJlKSAtLS0tLS0tLS0tXHJcblxyXG5sZXQgcHJldmlld0NhcmQ6IEhUTUxFbGVtZW50IHwgbnVsbCA9IG51bGw7XHJcblxyXG4vKipcclxuICogUGxheSBhIHNtYWxsIGNhcmQncyBwcmV2aWV3IG92ZXIgaXRzIHRodW1ibmFpbCwgaGVhcmQgYXQgdGhlIHByZXZpZXcgdm9sdW1lIGxpa2UgYSBob3ZlcmVkXHJcbiAqIGJhdHRsZSBjYXJkICgwIG11dGVzIGl0KS4gT25seSBvbmUgcGxheXMgYXQgYSB0aW1lOiBzdGFydGluZyBhbm90aGVyIHN0b3BzIHRoZSBsYXN0LlxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHN0YXJ0TWluaVByZXZpZXcoY2FyZDogSFRNTEVsZW1lbnQpOiB2b2lkIHtcclxuICBpZiAoY2FyZCA9PT0gcHJldmlld0NhcmQpIHJldHVybjtcclxuICBzdG9wTWluaVByZXZpZXcoKTtcclxuICBjb25zdCBzcmMgPSBjYXJkLmRhdGFzZXQucHJldmlldztcclxuICBjb25zdCB0aHVtYiA9IGNhcmQucXVlcnlTZWxlY3RvcihcIi5zYi1taW5pLXRodW1iXCIpO1xyXG4gIGlmICghc3JjIHx8ICF0aHVtYikgcmV0dXJuO1xyXG4gIHByZXZpZXdDYXJkID0gY2FyZDtcclxuICBjb25zdCB2aWRlbyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJ2aWRlb1wiKTtcclxuICB2aWRlby5jbGFzc05hbWUgPSBcInNiLW1pbmktdmlkZW8gcHdyLWhvdmVyLXByZXZpZXdcIjtcclxuICB2aWRlby5zcmMgPSBzcmM7XHJcbiAgdmlkZW8udm9sdW1lID0gc2xpZGVyVG9Wb2x1bWUoc3RhdGUuc2V0dGluZ3MucHJldmlld1ZvbHVtZSk7XHJcbiAgdmlkZW8ubXV0ZWQgPSBzdGF0ZS5zZXR0aW5ncy5wcmV2aWV3Vm9sdW1lID09PSAwO1xyXG4gIHZpZGVvLmxvb3AgPSB0cnVlO1xyXG4gIHZpZGVvLnBsYXlzSW5saW5lID0gdHJ1ZTtcclxuICB0aHVtYi5hcHBlbmRDaGlsZCh2aWRlbyk7XHJcbiAgdmlkZW8ucGxheSgpLmNhdGNoKCgpID0+IHt9KTtcclxuICB1cGRhdGVNaW5pTXV0ZUljb25zKCk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBzdG9wTWluaVByZXZpZXcoKTogdm9pZCB7XHJcbiAgcHJldmlld0NhcmQ/LnF1ZXJ5U2VsZWN0b3IoXCIuc2ItbWluaS12aWRlb1wiKT8ucmVtb3ZlKCk7XHJcbiAgcHJldmlld0NhcmQgPSBudWxsO1xyXG4gIHVwZGF0ZU1pbmlNdXRlSWNvbnMoKTtcclxufVxyXG5cclxuLyoqIEVhY2ggc21hbGwgY2FyZCdzIG11dGUgYnV0dG9uICh0b3VjaCkgc2hvd3Mgd2hldGhlciBpdHMgcHJldmlldyBpcyBoZWFyZCByaWdodCBub3cuICovXHJcbmZ1bmN0aW9uIHVwZGF0ZU1pbmlNdXRlSWNvbnMoKTogdm9pZCB7XHJcbiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oXCIuc2ItbWluaS1tdXRlXCIpLmZvckVhY2goKGJ1dHRvbikgPT4ge1xyXG4gICAgY29uc3QgY2FyZCA9IGJ1dHRvbi5jbG9zZXN0KFwiLnNiLW1pbmktY2FyZFwiKTtcclxuICAgIGNvbnN0IHZpZGVvID0gY2FyZCAmJiBjYXJkID09PSBwcmV2aWV3Q2FyZCA/IGNhcmQucXVlcnlTZWxlY3RvcjxIVE1MVmlkZW9FbGVtZW50PihcIi5zYi1taW5pLXZpZGVvXCIpIDogbnVsbDtcclxuICAgIGNvbnN0IGhlYXJkID0gdmlkZW8gIT09IG51bGwgJiYgIXZpZGVvLm11dGVkO1xyXG4gICAgYnV0dG9uLnRleHRDb250ZW50ID0gaGVhcmQgPyBcIvCflIpcIiA6IFwi8J+Uh1wiO1xyXG4gICAgYnV0dG9uLnNldEF0dHJpYnV0ZShcImFyaWEtbGFiZWxcIiwgaGVhcmQgPyBcIk11dGUgdGhpcyBwcmV2aWV3XCIgOiBcIlBsYXkgdGhpcyBwcmV2aWV3IHdpdGggc291bmRcIik7XHJcbiAgfSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBUb3VjaDogYSBzbWFsbCBjYXJkJ3MgbXV0ZSBidXR0b24uIEhlYXJkIOKGkiBtdXRlZCAodGhlIHByZXZpZXcga2VlcHMgcGxheWluZykuIE5vdCBoZWFyZCDihpIgaXRzXHJcbiAqIHByZXZpZXcgcGxheXMgd2l0aCBzb3VuZCAoc3RhcnRpbmcgaXQsIGFuZCB0dXJuaW5nIHRoZSBwcmV2aWV3IHZvbHVtZSBiYWNrIG9uIGlmIGl0IHdhcyBhdCAwKS5cclxuICogUmV0dXJucyB0cnVlIHdoZW4gaXQgaGFuZGxlZCB0aGUgdGFwLlxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGhhbmRsZU1pbmlNdXRlVGFwKGU6IEV2ZW50KTogYm9vbGVhbiB7XHJcbiAgY29uc3QgYnV0dG9uID0gKGUudGFyZ2V0IGFzIEVsZW1lbnQpLmNsb3Nlc3QoXCIuc2ItbWluaS1tdXRlXCIpO1xyXG4gIGlmICghYnV0dG9uKSByZXR1cm4gZmFsc2U7XHJcbiAgZS5wcmV2ZW50RGVmYXVsdCgpO1xyXG4gIGNvbnN0IGNhcmQgPSBidXR0b24uY2xvc2VzdDxIVE1MRWxlbWVudD4oXCIuc2ItbWluaS1jYXJkW2RhdGEtcHJldmlld11cIik7XHJcbiAgaWYgKCFjYXJkKSByZXR1cm4gdHJ1ZTtcclxuICBjb25zdCB2aWRlbyA9IGNhcmQgPT09IHByZXZpZXdDYXJkID8gY2FyZC5xdWVyeVNlbGVjdG9yPEhUTUxWaWRlb0VsZW1lbnQ+KFwiLnNiLW1pbmktdmlkZW9cIikgOiBudWxsO1xyXG4gIGlmICh2aWRlbyAmJiAhdmlkZW8ubXV0ZWQpIHtcclxuICAgIHZpZGVvLm11dGVkID0gdHJ1ZTtcclxuICB9IGVsc2Uge1xyXG4gICAgLy8gVGhlIHRhYiBiYXIncyBzcGVha2VyIHJlc3RvcmVzIHRoZSB2b2x1bWUgZnJvbSBiZWZvcmUgbXV0aW5nXHJcbiAgICBpZiAoc3RhdGUuc2V0dGluZ3MucHJldmlld1ZvbHVtZSA9PT0gMCkgZG9jdW1lbnQucXVlcnlTZWxlY3RvcjxIVE1MQnV0dG9uRWxlbWVudD4oXCIuc2Itdm9sdW1lLWljb25cIik/LmNsaWNrKCk7XHJcbiAgICBpZiAodmlkZW8pIHtcclxuICAgICAgdmlkZW8udm9sdW1lID0gc2xpZGVyVG9Wb2x1bWUoc3RhdGUuc2V0dGluZ3MucHJldmlld1ZvbHVtZSk7XHJcbiAgICAgIHZpZGVvLm11dGVkID0gZmFsc2U7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICBzdGFydE1pbmlQcmV2aWV3KGNhcmQpO1xyXG4gICAgfVxyXG4gIH1cclxuICB1cGRhdGVNaW5pTXV0ZUljb25zKCk7XHJcbiAgcmV0dXJuIHRydWU7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBUb3VjaCBzY3JlZW5zLCBsaWtlIHRoZSBiYXR0bGUgY2FyZHM6IGEgdGFwIG9uIGEgc21hbGwgY2FyZCdzIHRodW1ibmFpbCBwbGF5cyBpdHMgcHJldmlldyAod2l0aFxyXG4gKiBzb3VuZCkgb3Igc3RvcHMgaXQsIGluc3RlYWQgb2YgZm9sbG93aW5nIHRoZSBjYXJkJ3MgbGluazsgdGhlIGluZm8gYmVsb3cgb3BlbnMgdGhlIHNjZW5lLlxyXG4gKiBSZXR1cm5zIHRydWUgd2hlbiBpdCBoYW5kbGVkIHRoZSB0YXAuXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gaGFuZGxlTWluaVRodW1iVGFwKGU6IEV2ZW50KTogYm9vbGVhbiB7XHJcbiAgaWYgKCFpc1RvdWNoRGV2aWNlKCkpIHJldHVybiBmYWxzZTtcclxuICBjb25zdCB0aHVtYiA9IChlLnRhcmdldCBhcyBFbGVtZW50KS5jbG9zZXN0KFwiLnNiLW1pbmktdGh1bWJcIik7XHJcbiAgY29uc3QgY2FyZCA9IHRodW1iPy5jbG9zZXN0PEhUTUxFbGVtZW50PihcIi5zYi1taW5pLWNhcmRbZGF0YS1wcmV2aWV3XVwiKTtcclxuICBpZiAoIWNhcmQpIHJldHVybiBmYWxzZTtcclxuICBlLnByZXZlbnREZWZhdWx0KCk7XHJcbiAgaWYgKHByZXZpZXdDYXJkID09PSBjYXJkKSBzdG9wTWluaVByZXZpZXcoKTtcclxuICBlbHNlIHN0YXJ0TWluaVByZXZpZXcoY2FyZCk7XHJcbiAgcmV0dXJuIHRydWU7XHJcbn1cclxuXHJcbi8qKiBUaGUgc21hbGwgY2FyZCB3aG9zZSBwcmV2aWV3IGlzIHBsYXlpbmcsIGlmIGFueS4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIG1pbmlQcmV2aWV3Q2FyZCgpOiBIVE1MRWxlbWVudCB8IG51bGwge1xyXG4gIHJldHVybiBwcmV2aWV3Q2FyZDtcclxufVxyXG4iLCAiLy8gVmljdG9yeSBhbmQgcGxhY2VtZW50IGVuZC1zY3JlZW5zIGZvciBDaGFtcGlvbiBhbmQgUGxhY2VtZW50IHJ1bnMuXG5cbmltcG9ydCB7IGxhdGVzdFNjZW5lIH0gZnJvbSBcIi4uL2NhY2hlXCI7XG5pbXBvcnQgeyBmb3JtYXRSYXRpbmcgfSBmcm9tIFwiLi4vcmF0aW5nRGlzcGxheVwiO1xuaW1wb3J0IHsgZWxvLCBzdGFzaFJhdGluZ1RhcmdldHMgfSBmcm9tIFwiLi4vc2NvcmVcIjtcbmltcG9ydCB7IHJlc2V0UnVuU3RhdGUsIHN0YXRlIH0gZnJvbSBcIi4uL3N0YXRlXCI7XG5pbXBvcnQgeyBzYXZlU3RhdGUgfSBmcm9tIFwiLi4vc3RvcmFnZVwiO1xuaW1wb3J0IHR5cGUgeyBQbGFjZW1lbnRQYWlyUmVzdWx0LCBTY2VuZSB9IGZyb20gXCIuLi90eXBlc1wiO1xuaW1wb3J0IHsgY2FuVW5kbywgbG9hZE5ld1BhaXIsIHNldEFjdGlvbnNWaXNpYmxlLCB1bmRvTGFzdFBpY2sgfSBmcm9tIFwiLi9tYWluVUlcIjtcbmltcG9ydCB7IHJlc29sdmVTY2VuZVRpdGxlIH0gZnJvbSBcIi4uL3NjZW5lVGl0bGVcIjtcblxuZnVuY3Rpb24gYnVpbGRFbmRTY3JlZW5IdG1sKFxuICBzY2VuZTogU2NlbmUsXG4gIGNyb3duOiBzdHJpbmcsXG4gIGhlYWRsaW5lOiBzdHJpbmcsXG4gIHN0YXRzSHRtbDogc3RyaW5nLFxuICBidXR0b25MYWJlbDogc3RyaW5nLFxuKTogc3RyaW5nIHtcbiAgY29uc3QgdGl0bGUgPSByZXNvbHZlU2NlbmVUaXRsZShzY2VuZSk7XG4gIGNvbnN0IHNjcmVlbnNob3RQYXRoID0gc2NlbmUucGF0aHM/LnNjcmVlbnNob3QgPz8gbnVsbDtcblxuICByZXR1cm4gYFxuICAgICAgPGRpdiBjbGFzcz1cInNiLWVuZC1zY3JlZW5cIj5cbiAgICAgICAgPGRpdiBjbGFzcz1cInNiLWVuZC1zY3JlZW4taWNvblwiPiR7Y3Jvd259PC9kaXY+XG4gICAgICAgIDxoMiBjbGFzcz1cInNiLWVuZC1zY3JlZW4taGVhZGxpbmVcIj4ke2hlYWRsaW5lfTwvaDI+XG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi1lbmQtc2NyZWVuLXNjZW5lIHB3ci1zY2VuZS1pbWFnZS1jb250YWluZXJcIj5cbiAgICAgICAgICAke1xuICAgICAgICAgICAgc2NyZWVuc2hvdFBhdGhcbiAgICAgICAgICAgICAgPyBgPGltZyBjbGFzcz1cInNiLWVuZC1zY3JlZW4taW1hZ2UgcHdyLXNjZW5lLWltYWdlXCIgc3JjPVwiJHtzY3JlZW5zaG90UGF0aH1cIiBhbHQ9XCIke3RpdGxlfVwiIC8+YFxuICAgICAgICAgICAgICA6IGA8ZGl2IGNsYXNzPVwic2ItZW5kLXNjcmVlbi1pbWFnZSBzYi1uby1pbWFnZVwiPk5vIFNjcmVlbnNob3Q8L2Rpdj5gXG4gICAgICAgICAgfVxuICAgICAgICA8L2Rpdj5cbiAgICAgICAgPGgzIGNsYXNzPVwic2ItZW5kLXNjcmVlbi1uYW1lXCI+JHt0aXRsZX08L2gzPlxuICAgICAgICA8cCBjbGFzcz1cInNiLWVuZC1zY3JlZW4tc3RhdHNcIj4ke3N0YXRzSHRtbH08L3A+XG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi1lbmQtYWN0aW9uc1wiPlxuICAgICAgICAgIDxidXR0b24gaWQ9XCJzYi1uZXctcnVuXCIgY2xhc3M9XCJidG4gYnRuLXByaW1hcnlcIj4ke2J1dHRvbkxhYmVsfTwvYnV0dG9uPlxuICAgICAgICA8L2Rpdj5cbiAgICAgIDwvZGl2PlxuICAgIGA7XG59XG5cbi8qKiBSZW5kZXIgYW4gZW5kIHNjcmVlbiwgaGlkZSBiYXR0bGUgY29udHJvbHMsIGFuZCB3aXJlIHRoZSBuZXctcnVuIGJ1dHRvbi4gKi9cbmZ1bmN0aW9uIHNob3dFbmRTY3JlZW4oaHRtbDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IGNvbXBhcmlzb25BcmVhID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzYi1jb21wYXJpc29uLWFyZWFcIik7XG4gIGlmICghY29tcGFyaXNvbkFyZWEpIHJldHVybjtcblxuICBjb21wYXJpc29uQXJlYS5pbm5lckhUTUwgPSBodG1sO1xuICBzZXRBY3Rpb25zVmlzaWJsZShmYWxzZSk7XG5cbiAgY29tcGFyaXNvbkFyZWEucXVlcnlTZWxlY3RvcihcIiNzYi1uZXctcnVuXCIpPy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4ge1xuICAgIGxvYWROZXdQYWlyKCk7XG4gIH0pO1xuICAvLyBUaGUgcGljayB0aGF0IGVuZGVkIHRoZSBydW4gY2FuIGJlIHRha2VuIGJhY2sgZnJvbSBoZXJlIHRvbyAodGhlIFVuZG8gYmFyIGlzIGhpZGRlbilcbiAgY29uc3QgbmV3UnVuID0gY29tcGFyaXNvbkFyZWEucXVlcnlTZWxlY3RvcihcIiNzYi1uZXctcnVuXCIpO1xuICBpZiAobmV3UnVuICYmIGNhblVuZG8oKSkge1xuICAgIG5ld1J1bi5pbnNlcnRBZGphY2VudEhUTUwoXCJhZnRlcmVuZFwiLCBgPGJ1dHRvbiBpZD1cInNiLWVuZC11bmRvXCIgY2xhc3M9XCJidG4gYnRuLXNlY29uZGFyeVwiIHRpdGxlPVwiVW5kbyB5b3VyIGxhc3QgcGljayAoQmFja3NwYWNlKVwiPuKGtiBVbmRvPC9idXR0b24+YCk7XG4gICAgY29tcGFyaXNvbkFyZWEucXVlcnlTZWxlY3RvcihcIiNzYi1lbmQtdW5kb1wiKT8uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHZvaWQgdW5kb0xhc3RQaWNrKCkpO1xuICB9XG59XG5cbi8qKiBDYXB0dXJlIGRpc3BsYXkgdmFsdWVzLCBjbGVhciBydW4gc3RhdGUsIHRoZW4gc2hvdyB0aGUgZW5kIHNjcmVlbi4gKi9cbmZ1bmN0aW9uIGZpbmlzaFJ1blNob3dFbmRTY3JlZW4oaHRtbDogc3RyaW5nKTogdm9pZCB7XG4gIHJlc2V0UnVuU3RhdGUoKTtcbiAgLy8gVGhlIGxhc3QgcGFpciBiZWxvbmdzIHRvIHRoZSBmaW5pc2hlZCBydW46IGEgcmVsb2FkIG11c3RuJ3QgcmVzdG9yZSBpdCB3aXRob3V0IGl0cyBydW5cbiAgc3RhdGUuY3VycmVudFBhaXIgPSB7IGxlZnQ6IG51bGwsIHJpZ2h0OiBudWxsIH07XG4gIHN0YXRlLmN1cnJlbnRSYW5rcyA9IHsgbGVmdDogbnVsbCwgcmlnaHQ6IG51bGwgfTtcbiAgc2F2ZVN0YXRlKCk7XG4gIHNob3dFbmRTY3JlZW4oaHRtbCk7XG59XG5cbi8qKlxuICogXCJFTE86IDE3NDBcIiwgcGx1cyBcIsK3IFN0YXNoIFJhdGluZzogNzRcIiB3aGlsZSBhbiB1cGRhdGUgbW9kZSBpcyBvbi4gVGhlIHJhdGluZyBpcyB3b3JrZWQgb3V0XG4gKiB0aGUgd2F5IHRoZSBzeW5jIGRvZXMgaXQgKGl0IG1heSBzdGlsbCBiZSBvbiBpdHMgd2F5IHRvIFN0YXNoKSwgc28gaXQncyB3aGF0IFN0YXNoIHdpbGwgc2hvdy5cbiAqL1xuZnVuY3Rpb24gZWxvTGluZShzY2VuZTogU2NlbmUsIHZhbHVlOiBudW1iZXIgfCBudWxsKTogc3RyaW5nIHtcbiAgaWYgKHZhbHVlID09PSBudWxsKSByZXR1cm4gXCJcIjtcbiAgbGV0IGxpbmUgPSBgPGJyPkVMTzogPHN0cm9uZz4ke01hdGgucm91bmQodmFsdWUpfTwvc3Ryb25nPmA7XG4gIGNvbnN0IG1vZGUgPSBzdGF0ZS5zZXR0aW5ncy5zdGFzaFJhdGluZ3M7XG4gIGNvbnN0IHNjZW5lcyA9IHN0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcztcbiAgaWYgKG1vZGUgIT09IFwib2ZmXCIgJiYgc2NlbmVzKSB7XG4gICAgY29uc3QgcmF0aW5nID0gc3Rhc2hSYXRpbmdUYXJnZXRzKHNjZW5lcywgbW9kZSkuZ2V0KHNjZW5lLmlkKTtcbiAgICBpZiAocmF0aW5nICE9PSB1bmRlZmluZWQpIGxpbmUgKz0gYCDCtyBTdGFzaCBSYXRpbmc6IDxzdHJvbmc+JHtmb3JtYXRSYXRpbmcocmF0aW5nKX08L3N0cm9uZz5gO1xuICB9XG4gIHJldHVybiBsaW5lO1xufVxuXG4vKiogQ2hhbXBpb24gYmVhdCBldmVyeSBzY2VuZSBhYm92ZSBpdCwgb3IgYSBjbGltYiBmcm9tIHRoZSBib3R0b20gbmV2ZXIgbG9zdDogaXQncyAjMS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzaG93VmljdG9yeVNjcmVlbihjaGFtcGlvbjogU2NlbmUsIHdpblN0cmVhazogbnVtYmVyKTogdm9pZCB7XG4gIGNvbnN0IGh0bWwgPSBidWlsZEVuZFNjcmVlbkh0bWwoXG4gICAgY2hhbXBpb24sXG4gICAgXCLwn5GRXCIsXG4gICAgXCJDSEFNUElPTiFcIixcbiAgICBgUmVhY2hlZCB0aGUgdG9wOiAke3dpblN0cmVha30gd2luJHt3aW5TdHJlYWsgPT09IDEgPyBcIlwiIDogXCJzXCJ9IGluIGEgcm93ISR7ZWxvTGluZShjaGFtcGlvbiwgZWxvKGxhdGVzdFNjZW5lKGNoYW1waW9uKSkpfWAsXG4gICAgXCJTdGFydCBOZXcgUnVuXCIsXG4gICk7XG5cbiAgZmluaXNoUnVuU2hvd0VuZFNjcmVlbihodG1sKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNob3dQbGFjZW1lbnRTY3JlZW4ocmVzdWx0OiBFeHRyYWN0PFBsYWNlbWVudFBhaXJSZXN1bHQsIHsgZG9uZTogdHJ1ZSB9Pik6IHZvaWQge1xuICBjb25zdCB7IHNjZW5lLCByYW5rLCBiYXR0bGVzLCBzdHJlYWssIGZyb21Cb3R0b20gfSA9IHJlc3VsdDtcbiAgY29uc3Qgc3RyZWFrVGV4dCA9IGZyb21Cb3R0b20gJiYgc3RyZWFrID4gMCA/IGDwn5SlICR7c3RyZWFrfSB3aW4gc3RyZWFrIMK3IGAgOiBcIlwiO1xuICBjb25zdCBiYXR0bGVzVGV4dCA9IGJhdHRsZXMgPyBgIMK3ICR7YmF0dGxlc30gYmF0dGxlJHtiYXR0bGVzID09PSAxID8gXCJcIiA6IFwic1wifWAgOiBcIlwiO1xuICBjb25zdCBodG1sID0gYnVpbGRFbmRTY3JlZW5IdG1sKFxuICAgIHNjZW5lLFxuICAgIFwi8J+TjVwiLFxuICAgIFwiUExBQ0VEIVwiLFxuICAgIGAke3N0cmVha1RleHR9UmFuayA8c3Ryb25nPiMke3Jhbmt9PC9zdHJvbmc+IG9mICR7c3RhdGUudG90YWxTY2VuZXNDb3VudH0ke2JhdHRsZXNUZXh0fSR7ZWxvTGluZShzY2VuZSwgcmVzdWx0LmVsbyl9YCxcbiAgICBcIlN0YXJ0IE5ldyBSdW5cIixcbiAgKTtcblxuICBmaW5pc2hSdW5TaG93RW5kU2NyZWVuKGh0bWwpO1xufVxuIiwgIi8vIFdoYXQgZWFjaCBcIlN0YXNoIHJhdGluZ3NcIiBvcHRpb24gZG9lcywgc2hhcmVkIGJ5IHRoZSBzZXR1cCBzY3JlZW4gYW5kIHRoZSBTZXR0aW5ncyBkcm9wZG93bi5cblxuaW1wb3J0IHsgZXhhbXBsZVJhdGluZywgZm9ybWF0UmF0aW5nIH0gZnJvbSBcIi4uL3JhdGluZ0Rpc3BsYXlcIjtcbmltcG9ydCB7IHNlZWQgfSBmcm9tIFwiLi4vc2NvcmVcIjtcbmltcG9ydCB0eXBlIHsgU3Rhc2hSYXRpbmdzTW9kZSB9IGZyb20gXCIuLi90eXBlc1wiO1xuXG4vLyBEZXNjcmlwdGlvbnMgYXJlIGdldHRlcnM6IHRoZWlyIGV4YW1wbGUgcmF0aW5ncyBmb2xsb3cgaG93IHRoaXMgU3Rhc2ggc2hvd3MgcmF0aW5ncyAoc3RhcnMgb3Jcbi8vIGRlY2ltYWwpLCB3aGljaCBpcyBvbmx5IGtub3duIG9uY2UgdGhlIHNldHRpbmdzIGhhdmUgbG9hZGVkLlxuZXhwb3J0IGNvbnN0IFNUQVNIX1JBVElOR1NfT1BUSU9OUzogcmVhZG9ubHkgeyB2YWx1ZTogU3Rhc2hSYXRpbmdzTW9kZTsgbGFiZWw6IHN0cmluZzsgcmVhZG9ubHkgZGVzYzogc3RyaW5nIH1bXSA9IFtcbiAgeyB2YWx1ZTogXCJvZmZcIiwgbGFiZWw6IFwiRG9uJ3QgdXBkYXRlXCIsIGRlc2M6IFwiRUxPIGlzIHNhdmVkOyB5b3VyIFN0YXNoIHJhdGluZ3Mgc3RheSBhcyB0aGV5IGFyZS5cIiB9LFxuICB7XG4gICAgdmFsdWU6IFwibGluZWFyXCIsXG4gICAgbGFiZWw6IFwiU3RyYWlnaHQtbGluZVwiLFxuICAgIGdldCBkZXNjKCk6IHN0cmluZyB7XG4gICAgICBjb25zdCBleCA9IGV4YW1wbGVSYXRpbmcoNTApO1xuICAgICAgcmV0dXJuIGBSYXRpbmcgPSBFTE8gY29udmVydGVkIGJhY2sgKCR7c2VlZChleCl9ID0gJHtmb3JtYXRSYXRpbmcoZXgsIHRydWUpfSkuIFZlcnkgaGlnaCBvciBsb3cgc2NlbmVzIHN0b3AgYXQgdGhlIHRvcCBvciBib3R0b20gb2YgdGhlIHNjYWxlLmA7XG4gICAgfSxcbiAgfSxcbiAge1xuICAgIHZhbHVlOiBcInBlcmNlbnRpbGVcIixcbiAgICBsYWJlbDogXCJQZXJjZW50aWxlXCIsXG4gICAgZ2V0IGRlc2MoKTogc3RyaW5nIHtcbiAgICAgIGNvbnN0IGV4ID0gZXhhbXBsZVJhdGluZyg5MCk7XG4gICAgICByZXR1cm4gYFJhdGluZyA9IHBlcmNlbnRpbGUgaW4geW91ciBsaWJyYXJ5OiAke2Zvcm1hdFJhdGluZyhleCwgdHJ1ZSl9IG1lYW5zIHRoZSBzY2VuZSByYW5rcyBhYm92ZSBhYm91dCAke2V4fSUgb2YgeW91ciBzY2VuZXMuIFRoZSB0b3Agc2NlbmUgZ2V0cyB0aGUgdG9wIHJhdGluZywgdGhlIGJvdHRvbSBzY2VuZSB0aGUgbG93ZXN0LmA7XG4gICAgfSxcbiAgfSxcbl07XG5cbmV4cG9ydCBmdW5jdGlvbiBzdGFzaFJhdGluZ3NPcHRpb24odmFsdWU6IFN0YXNoUmF0aW5nc01vZGUpOiAodHlwZW9mIFNUQVNIX1JBVElOR1NfT1BUSU9OUylbbnVtYmVyXSB7XG4gIHJldHVybiBTVEFTSF9SQVRJTkdTX09QVElPTlMuZmluZCgob3B0aW9uKSA9PiBvcHRpb24udmFsdWUgPT09IHZhbHVlKSA/PyBTVEFTSF9SQVRJTkdTX09QVElPTlNbMF07XG59XG4iLCAiLy8gQmF0dGxlIC8gU2V0dGluZ3MgdGFicyAoU3Rhc2gncyBvd24gbmF2LXRhYnMgKyAuc2V0dGluZyByb3dzLCBsaWtlIFN0YXNoLVRDb2RlKSwgcGx1cyB0aGVcclxuLy8gcHJldmlldyB2b2x1bWUgY29udHJvbCB0aGF0IHNpdHMgb24gdGhlIHRhYiBiYXIuIEV2ZXJ5IGNvbnRyb2wgY2FycmllcyBkYXRhLXNldHRpbmc9XCI8a2V5PlwiO1xyXG4vLyB2YWx1ZXMgcGVyc2lzdCB2aWEgdXBkYXRlU2V0dGluZ3MoKS4gQWN0aW9uIHJvd3MgKFJlc2V0IEVMTykgY2FycnkgZGF0YS1hY3Rpb24gaW5zdGVhZC5cclxuXHJcbmltcG9ydCB7IHNldFRlc3RNb2RlLCB1cGRhdGVTZXR0aW5ncyB9IGZyb20gXCIuLi9zZXR0aW5nc1wiO1xyXG5pbXBvcnQgeyBzdGF0ZSB9IGZyb20gXCIuLi9zdGF0ZVwiO1xyXG5pbXBvcnQgdHlwZSB7IFNldHRpbmdzLCBTdGFzaFJhdGluZ3NNb2RlIH0gZnJvbSBcIi4uL3R5cGVzXCI7XHJcbmltcG9ydCB7IFNUQVNIX1JBVElOR1NfT1BUSU9OUywgc3Rhc2hSYXRpbmdzT3B0aW9uIH0gZnJvbSBcIi4vc3Rhc2hSYXRpbmdzVGV4dFwiO1xyXG5cclxudHlwZSBCb29sS2V5ID0geyBbSyBpbiBrZXlvZiBTZXR0aW5nc106IFNldHRpbmdzW0tdIGV4dGVuZHMgYm9vbGVhbiA/IEsgOiBuZXZlciB9W2tleW9mIFNldHRpbmdzXTtcclxuZXhwb3J0IHR5cGUgVGFiSWQgPSBcImJhdHRsZVwiIHwgXCJleHBsb3JlXCIgfCBcInN0YXRzXCIgfCBcInJlY29yZHNcIiB8IFwic2V0dGluZ3NcIjtcclxuXHJcbnR5cGUgU2V0dGluZ1JvdyA9XHJcbiAgfCB7IGtleToga2V5b2YgU2V0dGluZ3M7IHRpdGxlOiBzdHJpbmc7IGhpbnQ6IHN0cmluZzsgY2xhc3NOYW1lPzogc3RyaW5nIH1cclxuICB8IHsgYWN0aW9uOiBcInJlc2V0LWVsb1wiIHwgXCJjbGVhci1oYWxsLW9mLWZhbWVcIjsgdGl0bGU6IHN0cmluZzsgaGludDogc3RyaW5nOyBidXR0b246IHN0cmluZyB9O1xyXG5cclxuY29uc3QgU0VDVElPTlM6IHsgdGl0bGU6IHN0cmluZzsgcm93czogU2V0dGluZ1Jvd1tdIH1bXSA9IFtcclxuICB7XHJcbiAgICB0aXRsZTogXCJFTE9cIixcclxuICAgIHJvd3M6IFtcclxuICAgICAgLy8gVGhlIGhpbnQgaXMgdGhlIHNlbGVjdGVkIG9wdGlvbidzIGRlc2NyaXB0aW9uIChrZXB0IGN1cnJlbnQgYnkgc3luY1NldHRpbmdzQ29udHJvbHMpXHJcbiAgICAgIHsga2V5OiBcInN0YXNoUmF0aW5nc1wiLCB0aXRsZTogXCJTdGFzaCByYXRpbmdzIHVwZGF0ZSBtb2RlXCIsIGhpbnQ6IFwiXCIgfSxcclxuICAgICAge1xyXG4gICAgICAgIGFjdGlvbjogXCJyZXNldC1lbG9cIixcclxuICAgICAgICB0aXRsZTogXCJSZXNldCBFTE9cIixcclxuICAgICAgICBoaW50OiBcIlN0YXJ0IGV2ZXJ5IHNjZW5lJ3MgRUxPIG92ZXIsIGZyb20gaXRzIFN0YXNoIHJhdGluZyBvciBhdCAxNTAwXCIsXHJcbiAgICAgICAgYnV0dG9uOiBcIlJlc2V0IEVMT+KAplwiLFxyXG4gICAgICB9LFxyXG4gICAgICB7XHJcbiAgICAgICAgYWN0aW9uOiBcImNsZWFyLWhhbGwtb2YtZmFtZVwiLFxyXG4gICAgICAgIHRpdGxlOiBcIkNsZWFyIGhhbGwgb2YgZmFtZVwiLFxyXG4gICAgICAgIGhpbnQ6IFwiRW1wdHkgdGhlIFJlY29yZHMgdGFiJ3MgbGlzdCBvZiBzY2VuZXMgdGhhdCBoYXZlIGJlZW4gIzEuIEl0J3Mga2VwdCBpbiBTdGFzaCdzIHBsdWdpbiBzZXR0aW5ncywgc28gcmVzdG9yaW5nIFN0YXNoJ3MgZGF0YWJhc2UgZG9lc24ndCBjaGFuZ2UgaXRcIixcclxuICAgICAgICBidXR0b246IFwiQ2xlYXLigKZcIixcclxuICAgICAgfSxcclxuICAgIF0sXHJcbiAgfSxcclxuICB7XHJcbiAgICB0aXRsZTogXCJCYXR0bGVzXCIsXHJcbiAgICByb3dzOiBbXHJcbiAgICAgIHsga2V5OiBcImZpbHRlck9wcG9uZW50c1wiLCB0aXRsZTogXCJVc2UgZmlsdGVyZWQgc2NlbmVzIGZvciBib3RoIHNpZGVzXCIsIGhpbnQ6IFwiT3Bwb25lbnRzIGFsc28gY29tZSBmcm9tIHRoZSBjdXJyZW50IHNjZW5lIGxpc3QgZmlsdGVyIGluc3RlYWQgb2YgeW91ciB3aG9sZSByYXRlZCBsaWJyYXJ5XCIgfSxcclxuICAgICAgeyBrZXk6IFwicGxhY2VtZW50RnJvbUJvdHRvbVwiLCB0aXRsZTogXCJQbGFjZW1lbnQ6IHN0YXJ0IGZyb20gdGhlIGJvdHRvbVwiLCBoaW50OiBcIlBsYWNlbWVudCBpZ25vcmVzIHRoZSBzY2VuZSdzIGN1cnJlbnQgRUxPOiBpdCBzdGFydHMgYWdhaW5zdCB0aGUgYm90dG9tIHNjZW5lIGFuZCBjbGltYnMsIGp1bXBpbmcgZnVydGhlciB3aXRoIGVhY2ggd2luICh0aGlzIHJlcGxhY2VzIEdhdW50bGV0KVwiIH0sXHJcbiAgICBdLFxyXG4gIH0sXHJcbiAge1xyXG4gICAgdGl0bGU6IFwiU2NlbmVzXCIsXHJcbiAgICByb3dzOiBbXHJcbiAgICAgIC8vIE5hcnJvdyBwaG9uZXMgaGlkZSB0aGUgdGFiIGJhcidzIHNsaWRlciAob25seSBpdHMgbXV0ZSBidXR0b24gZml0cyksIHNvIGl0J3MgaGVyZSBpbnN0ZWFkXHJcbiAgICAgIHsga2V5OiBcInByZXZpZXdWb2x1bWVcIiwgdGl0bGU6IFwiUHJldmlldyB2b2x1bWVcIiwgaGludDogXCJIb3cgbG91ZCB0aGUgaG92ZXJlZCBvciB0YXBwZWQgY2FyZCdzIHByZXZpZXcgcGxheXMuIDAgbXV0ZXMgaXRcIiwgY2xhc3NOYW1lOiBcInNiLXNldHRpbmctcGhvbmUtb25seVwiIH0sXHJcbiAgICAgIHsga2V5OiBcImF1dG9wbGF5UHJldmlld3NcIiwgdGl0bGU6IFwiQXV0b3BsYXkgcHJldmlld3NcIiwgaGludDogXCJMb29wIGJvdGggcHJldmlld3Mgc2lsZW50bHk7IGhvdmVyIGEgY2FyZCB0byBoZWFyIGl0XCIgfSxcclxuICAgICAgeyBrZXk6IFwicGF1c2VNZWRpYU9uT3BlblwiLCB0aXRsZTogXCJQYXVzZSBwbGF5aW5nIHZpZGVvIHdoZW4gU3Rhc2ggQmF0dGxlIG9wZW5zXCIsIGhpbnQ6IFwiU3RvcHMgdGhlIHNjZW5lIHlvdSdyZSB3YXRjaGluZyBzbyBpdHMgYXVkaW8gZG9lc24ndCBvdmVybGFwIHRoZSBiYXR0bGUgcHJldmlld3NcIiB9LFxyXG4gICAgICB7IGtleTogXCJ0aWVyQm9yZGVyc1wiLCB0aXRsZTogXCJUaWVyIGNvbG91cnMgb24gY2FyZCBib3JkZXJzXCIsIGhpbnQ6IFwiRWFjaCBiYXR0bGUgY2FyZCdzIGJvcmRlciB0YWtlcyB0aGUgY29sb3VyIG9mIGl0cyB0aWVyICjwn5GRIExlZ2VuZGFyeSBkb3duIHRvIPCfpYkgQnJvbnplKSwgYXMgb24gdGhlIEV4cGxvcmUgY2FyZHNcIiB9LFxyXG4gICAgICB7IGtleTogXCJvcGVuSW5OZXdUYWJcIiwgdGl0bGU6IFwiT3BlbiBzY2VuZXMgaW4gYSBuZXcgdGFiXCIsIGhpbnQ6IFwiQ2xpY2tpbmcgYSB0aHVtYm5haWwgb3BlbnMgdGhlIHNjZW5lIGluIGEgbmV3IGJyb3dzZXIgdGFiXCIgfSxcclxuICAgICAgeyBrZXk6IFwiY2xlYW5Nb2RlXCIsIHRpdGxlOiBcIkNsZWFuIG1vZGVcIiwgaGludDogXCJTaG93IGEg8J+XkSBidXR0b24gb24gZWFjaCBjYXJkIHRvIGRlbGV0ZSB0aGUgc2NlbmUgZnJvbSBTdGFzaFwiIH0sXHJcbiAgICBdLFxyXG4gIH0sXHJcbiAge1xyXG4gICAgdGl0bGU6IFwiVGVzdGluZ1wiLFxyXG4gICAgcm93czogW1xyXG4gICAgICB7XHJcbiAgICAgICAga2V5OiBcInRlc3RNb2RlXCIsXHJcbiAgICAgICAgdGl0bGU6IFwi8J+nqiBUZXN0IG1vZGVcIixcclxuICAgICAgICBoaW50OiBcIlRyeSB0aGluZ3Mgd2l0aG91dCBzYXZpbmcgYW55dGhpbmcgdG8gU3Rhc2g6IEVMTywgcmVjb3JkcywgU3Rhc2ggcmF0aW5ncywgdGhlIGhhbGwgb2YgZmFtZSBhbmQgc2V0dGluZ3MgY2hhbmdlcyBvbmx5IGxhc3QgdW50aWwgeW91IHR1cm4gaXQgb2ZmIG9yIHJlbG9hZCB0aGUgcGFnZS4gQ2xlYW4gbW9kZSdzIGRlbGV0ZXMgYXJlIHN0aWxsIHJlYWxcIixcclxuICAgICAgfSxcclxuICAgIF0sXHJcbiAgfSxcclxuXTtcclxuXHJcbi8qKiBWb2x1bWUgcmVzdG9yZWQgd2hlbiB1bm11dGluZyBmcm9tIDAgd2l0aCBubyBlYXJsaWVyIGxldmVsIHRoaXMgc2Vzc2lvbi4gKi9cclxuY29uc3QgREVGQVVMVF9VTk1VVEVfVk9MVU1FID0gNTA7XHJcbmxldCB2b2x1bWVCZWZvcmVNdXRlOiBudW1iZXIgfCBudWxsID0gbnVsbDtcclxuXHJcbmxldCBhY3RpdmVUYWI6IFRhYklkID0gXCJiYXR0bGVcIjtcclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBnZXRBY3RpdmVUYWIoKTogVGFiSWQge1xyXG4gIHJldHVybiBhY3RpdmVUYWI7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHZvbHVtZUljb24odm9sdW1lOiBudW1iZXIpOiBzdHJpbmcge1xyXG4gIGlmICh2b2x1bWUgPT09IDApIHJldHVybiBcIvCflIdcIjtcclxuICByZXR1cm4gdm9sdW1lIDwgNTAgPyBcIvCflIlcIiA6IFwi8J+UilwiO1xyXG59XHJcblxyXG5mdW5jdGlvbiBzZXR0aW5nQ29udHJvbChrZXk6IGtleW9mIFNldHRpbmdzKTogc3RyaW5nIHtcclxuICBpZiAoa2V5ID09PSBcInByZXZpZXdWb2x1bWVcIikge1xyXG4gICAgY29uc3Qgdm9sdW1lID0gc3RhdGUuc2V0dGluZ3MucHJldmlld1ZvbHVtZTtcclxuICAgIHJldHVybiBgPGRpdiBjbGFzcz1cInNiLXNldHRpbmctdm9sdW1lXCI+PGlucHV0IHR5cGU9XCJyYW5nZVwiIG1pbj1cIjBcIiBtYXg9XCIxMDBcIiBzdGVwPVwiMVwiIGRhdGEtc2V0dGluZz1cInByZXZpZXdWb2x1bWVcIiB2YWx1ZT1cIiR7dm9sdW1lfVwiIGFyaWEtbGFiZWw9XCJQcmV2aWV3IHZvbHVtZVwiPjxzcGFuIGNsYXNzPVwic2Itdm9sdW1lLXZhbHVlXCI+JHt2b2x1bWV9PC9zcGFuPjwvZGl2PmA7XHJcbiAgfVxyXG4gIGlmIChrZXkgPT09IFwic3Rhc2hSYXRpbmdzXCIpIHtcclxuICAgIGNvbnN0IG9wdGlvbnMgPSBTVEFTSF9SQVRJTkdTX09QVElPTlMubWFwKFxyXG4gICAgICAoeyB2YWx1ZSwgbGFiZWwgfSkgPT5cclxuICAgICAgICBgPG9wdGlvbiB2YWx1ZT1cIiR7dmFsdWV9XCIgJHt2YWx1ZSA9PT0gc3RhdGUuc2V0dGluZ3Muc3Rhc2hSYXRpbmdzID8gXCJzZWxlY3RlZFwiIDogXCJcIn0+JHtsYWJlbH08L29wdGlvbj5gLFxyXG4gICAgKS5qb2luKFwiXCIpO1xyXG4gICAgcmV0dXJuIGA8c2VsZWN0IGRhdGEtc2V0dGluZz1cIiR7a2V5fVwiIGNsYXNzPVwiZm9ybS1jb250cm9sIGZvcm0tY29udHJvbC1zbSBzYi1zZXR0aW5nLXNlbGVjdFwiIGFyaWEtbGFiZWw9XCJTdGFzaCByYXRpbmdzIHVwZGF0ZSBtb2RlXCI+JHtvcHRpb25zfTwvc2VsZWN0PmA7XHJcbiAgfVxyXG4gIGNvbnN0IGlkID0gYHNiLXNldHRpbmctJHtrZXl9YDtcclxuICByZXR1cm4gYFxyXG4gICAgICAgICAgPGRpdiBjbGFzcz1cImN1c3RvbS1jb250cm9sIGN1c3RvbS1zd2l0Y2hcIj5cclxuICAgICAgICAgICAgPGlucHV0IHR5cGU9XCJjaGVja2JveFwiIGNsYXNzPVwiY3VzdG9tLWNvbnRyb2wtaW5wdXRcIiBpZD1cIiR7aWR9XCIgZGF0YS1zZXR0aW5nPVwiJHtrZXl9XCIgJHtzdGF0ZS5zZXR0aW5nc1trZXkgYXMgQm9vbEtleV0gPyBcImNoZWNrZWRcIiA6IFwiXCJ9PlxyXG4gICAgICAgICAgICA8bGFiZWwgY2xhc3M9XCJjdXN0b20tY29udHJvbC1sYWJlbFwiIGZvcj1cIiR7aWR9XCI+PC9sYWJlbD5cclxuICAgICAgICAgIDwvZGl2PmA7XHJcbn1cclxuXHJcbi8qKiBUaGUgdGFicywgaW4gb3JkZXIuIE9uIG5hcnJvdyBwaG9uZXMgdGhlIHRhYnMgeW91J3JlIG5vdCBvbiBzaG93IG9ubHkgdGhlaXIgZW1vamkuICovXHJcbmNvbnN0IFRBQlM6IHsgaWQ6IFRhYklkOyBlbW9qaTogc3RyaW5nOyBuYW1lOiBzdHJpbmcgfVtdID0gW1xyXG4gIHsgaWQ6IFwiYmF0dGxlXCIsIGVtb2ppOiBcIuKalO+4j1wiLCBuYW1lOiBcIkJhdHRsZVwiIH0sXHJcbiAgeyBpZDogXCJleHBsb3JlXCIsIGVtb2ppOiBcIvCflI5cIiwgbmFtZTogXCJFeHBsb3JlXCIgfSxcclxuICB7IGlkOiBcInN0YXRzXCIsIGVtb2ppOiBcIvCfk4pcIiwgbmFtZTogXCJTdGF0c1wiIH0sXHJcbiAgeyBpZDogXCJyZWNvcmRzXCIsIGVtb2ppOiBcIvCfj4ZcIiwgbmFtZTogXCJSZWNvcmRzXCIgfSxcclxuICB7IGlkOiBcInNldHRpbmdzXCIsIGVtb2ppOiBcIuKamVwiLCBuYW1lOiBcIlNldHRpbmdzXCIgfSxcclxuXTtcclxuXHJcbi8qKiBUYWIgYmFyOiB0aGUgdGFicyBvbiB0aGUgbGVmdCwgcHJldmlldyB2b2x1bWUgb24gdGhlIHJpZ2h0LiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlVGFiQmFyKCk6IHN0cmluZyB7XHJcbiAgY29uc3QgeyBwcmV2aWV3Vm9sdW1lIH0gPSBzdGF0ZS5zZXR0aW5ncztcclxuICByZXR1cm4gYFxyXG4gICAgICA8ZGl2IGNsYXNzPVwic2ItdGFiLWJhclwiPlxyXG4gICAgICAgIDxuYXYgY2xhc3M9XCJuYXYgbmF2LXRhYnMgc2ItdGFic1wiIHJvbGU9XCJ0YWJsaXN0XCI+XHJcbiAgICAgICAgICAke1RBQlMubWFwKFxyXG4gICAgICAgICAgICAoeyBpZCwgZW1vamksIG5hbWUgfSkgPT5cclxuICAgICAgICAgICAgICBgPGEgY2xhc3M9XCJuYXYtaXRlbSBuYXYtbGluayR7aWQgPT09IFwiYmF0dGxlXCIgPyBcIiBhY3RpdmVcIiA6IFwiXCJ9XCIgcm9sZT1cInRhYlwiIGRhdGEtdGFiPVwiJHtpZH1cIiBhcmlhLXNlbGVjdGVkPVwiJHtpZCA9PT0gXCJiYXR0bGVcIn1cIiBhcmlhLWxhYmVsPVwiJHtuYW1lfVwiIHRpdGxlPVwiJHtuYW1lfVwiPjxzcGFuIGNsYXNzPVwic2ItdGFiLWVtb2ppXCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+JHtlbW9qaX08L3NwYW4+PHNwYW4gY2xhc3M9XCJzYi10YWItbmFtZVwiPiAke25hbWV9PC9zcGFuPjwvYT5gLFxyXG4gICAgICAgICAgKS5qb2luKFwiXCIpfVxyXG4gICAgICAgIDwvbmF2PlxyXG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi12b2x1bWVcIiB0aXRsZT1cIlByZXZpZXcgdm9sdW1lXCI+XHJcbiAgICAgICAgICA8YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cInNiLXZvbHVtZS1pY29uXCIgYXJpYS1sYWJlbD1cIk11dGUgcHJldmlld3NcIj4ke3ZvbHVtZUljb24ocHJldmlld1ZvbHVtZSl9PC9idXR0b24+XHJcbiAgICAgICAgICA8aW5wdXQgdHlwZT1cInJhbmdlXCIgbWluPVwiMFwiIG1heD1cIjEwMFwiIHN0ZXA9XCIxXCIgZGF0YS1zZXR0aW5nPVwicHJldmlld1ZvbHVtZVwiIHZhbHVlPVwiJHtwcmV2aWV3Vm9sdW1lfVwiIGFyaWEtbGFiZWw9XCJQcmV2aWV3IHZvbHVtZVwiPlxyXG4gICAgICAgICAgPHNwYW4gY2xhc3M9XCJzYi12b2x1bWUtdmFsdWVcIj4ke3ByZXZpZXdWb2x1bWV9PC9zcGFuPlxyXG4gICAgICAgIDwvZGl2PlxyXG4gICAgICA8L2Rpdj5cclxuICAgIGA7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNldHRpbmdSb3dIdG1sKHJvdzogU2V0dGluZ1Jvdyk6IHN0cmluZyB7XHJcbiAgY29uc3QgaGludCA9IFwia2V5XCIgaW4gcm93ICYmIHJvdy5rZXkgPT09IFwic3Rhc2hSYXRpbmdzXCIgPyBzdGFzaFJhdGluZ3NPcHRpb24oc3RhdGUuc2V0dGluZ3Muc3Rhc2hSYXRpbmdzKS5kZXNjIDogcm93LmhpbnQ7XHJcbiAgY29uc3QgaGludEZvciA9IFwia2V5XCIgaW4gcm93ID8gYCBkYXRhLWhpbnQtZm9yPVwiJHtyb3cua2V5fVwiYCA6IFwiXCI7XHJcbiAgY29uc3QgY29udHJvbCA9XHJcbiAgICBcImtleVwiIGluIHJvd1xyXG4gICAgICA/IHNldHRpbmdDb250cm9sKHJvdy5rZXkpXHJcbiAgICAgIDogYDxidXR0b24gdHlwZT1cImJ1dHRvblwiIGNsYXNzPVwiYnRuIGJ0bi1zZWNvbmRhcnkgYnRuLXNtXCIgZGF0YS1hY3Rpb249XCIke3Jvdy5hY3Rpb259XCI+JHtyb3cuYnV0dG9ufTwvYnV0dG9uPmA7XHJcbiAgY29uc3Qgcm93Q2xhc3MgPSBcImtleVwiIGluIHJvdyAmJiByb3cuY2xhc3NOYW1lID8gYCAke3Jvdy5jbGFzc05hbWV9YCA6IFwiXCI7XHJcbiAgcmV0dXJuIGBcclxuICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNldHRpbmcke3Jvd0NsYXNzfVwiPlxyXG4gICAgICAgICAgICAgIDxkaXY+XHJcbiAgICAgICAgICAgICAgICA8aDM+JHtyb3cudGl0bGV9PC9oMz5cclxuICAgICAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzdWItaGVhZGluZ1wiJHtoaW50Rm9yfT4ke2hpbnR9PC9kaXY+XHJcbiAgICAgICAgICAgICAgPC9kaXY+XHJcbiAgICAgICAgICAgICAgPGRpdj4ke2NvbnRyb2x9PC9kaXY+XHJcbiAgICAgICAgICAgIDwvZGl2PmA7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVTZXR0aW5nc1RhYigpOiBzdHJpbmcge1xyXG4gIGNvbnN0IHNlY3Rpb25zID0gU0VDVElPTlMubWFwKFxyXG4gICAgKHsgdGl0bGUsIHJvd3MgfSkgPT4gYFxyXG4gICAgICAgIDxkaXYgY2xhc3M9XCJzZXR0aW5nLXNlY3Rpb25cIj5cclxuICAgICAgICAgIDxoMT4ke3RpdGxlfTwvaDE+XHJcbiAgICAgICAgICA8ZGl2IGNsYXNzPVwiY2FyZFwiPlxyXG4gICAgICAgICAgICAke3Jvd3MubWFwKHNldHRpbmdSb3dIdG1sKS5qb2luKFwiXCIpfVxyXG4gICAgICAgICAgPC9kaXY+XHJcbiAgICAgICAgPC9kaXY+YCxcclxuICApLmpvaW4oXCJcIik7XHJcblxyXG4gIHJldHVybiBgXHJcbiAgICAgIDxkaXYgY2xhc3M9XCJzYi10YWItcGFuZWwgc2Itc2V0dGluZ3MtdGFiXCIgZGF0YS1wYW5lbD1cInNldHRpbmdzXCIgaGlkZGVuPlxyXG4gICAgICAgICR7c2VjdGlvbnN9XHJcbiAgICAgICAgPHAgY2xhc3M9XCJzYi1zZXR0aW5ncy1ub3RlXCI+U2F2ZXMgdG8gU3Rhc2gsIGFsc28gdW5kZXIgU2V0dGluZ3Mg4oaSIFBsdWdpbnMuPC9wPlxyXG4gICAgICA8L2Rpdj5cclxuICAgIGA7XHJcbn1cclxuXHJcbi8qKiBQdXNoIHN0YXRlLnNldHRpbmdzIGludG8gdGhlIHJlbmRlcmVkIGNvbnRyb2xzIChlLmcuIGFmdGVyIHJlLWZldGNoaW5nIHNldHRpbmdzIG9uIHJlb3BlbikuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBzeW5jU2V0dGluZ3NDb250cm9scyhyb290OiBQYXJlbnROb2RlKTogdm9pZCB7XHJcbiAgcm9vdC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxJbnB1dEVsZW1lbnQ+KFwiaW5wdXRbZGF0YS1zZXR0aW5nXVwiKS5mb3JFYWNoKChpbnB1dCkgPT4ge1xyXG4gICAgY29uc3Qga2V5ID0gaW5wdXQuZGF0YXNldC5zZXR0aW5nIGFzIGtleW9mIFNldHRpbmdzO1xyXG4gICAgY29uc3QgdmFsdWUgPSBzdGF0ZS5zZXR0aW5nc1trZXldO1xyXG4gICAgaWYgKGlucHV0LnR5cGUgPT09IFwiY2hlY2tib3hcIikgaW5wdXQuY2hlY2tlZCA9IEJvb2xlYW4odmFsdWUpO1xyXG4gICAgZWxzZSBpbnB1dC52YWx1ZSA9IFN0cmluZyh2YWx1ZSk7XHJcbiAgfSk7XHJcbiAgcm9vdC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxTZWxlY3RFbGVtZW50PihcInNlbGVjdFtkYXRhLXNldHRpbmddXCIpLmZvckVhY2goKHNlbGVjdCkgPT4ge1xyXG4gICAgc2VsZWN0LnZhbHVlID0gU3RyaW5nKHN0YXRlLnNldHRpbmdzW3NlbGVjdC5kYXRhc2V0LnNldHRpbmcgYXMga2V5b2YgU2V0dGluZ3NdKTtcclxuICB9KTtcclxuICByb290LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KCdbZGF0YS1oaW50LWZvcj1cInN0YXNoUmF0aW5nc1wiXScpLmZvckVhY2goKGhpbnQpID0+IHtcclxuICAgIGhpbnQudGV4dENvbnRlbnQgPSBzdGFzaFJhdGluZ3NPcHRpb24oc3RhdGUuc2V0dGluZ3Muc3Rhc2hSYXRpbmdzKS5kZXNjO1xyXG4gIH0pO1xyXG4gIGNvbnN0IHZvbHVtZSA9IHN0YXRlLnNldHRpbmdzLnByZXZpZXdWb2x1bWU7XHJcbiAgcm9vdC5xdWVyeVNlbGVjdG9yQWxsKFwiLnNiLXZvbHVtZS1pY29uXCIpLmZvckVhY2goKGVsKSA9PiB7XHJcbiAgICBlbC50ZXh0Q29udGVudCA9IHZvbHVtZUljb24odm9sdW1lKTtcclxuICAgIGVsLnNldEF0dHJpYnV0ZShcImFyaWEtbGFiZWxcIiwgdm9sdW1lID09PSAwID8gXCJVbm11dGUgcHJldmlld3NcIiA6IFwiTXV0ZSBwcmV2aWV3c1wiKTtcclxuICB9KTtcclxuICByb290LnF1ZXJ5U2VsZWN0b3JBbGwoXCIuc2Itdm9sdW1lLXZhbHVlXCIpLmZvckVhY2goKGVsKSA9PiAoZWwudGV4dENvbnRlbnQgPSBTdHJpbmcodm9sdW1lKSkpO1xyXG59XHJcblxyXG4vKiogU2hvdyBhIHRhYi4gUGFuZWxzIGFyZSBzd2FwcGVkIGluIHBsYWNlLCBzbyBub3RoaW5nIGFib3ZlIHRoZSB0YWIgYmFyIG1vdmVzLiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gc2hvd1RhYihyb290OiBQYXJlbnROb2RlLCB0YWI6IFRhYklkKTogdm9pZCB7XHJcbiAgYWN0aXZlVGFiID0gdGFiO1xyXG4gIHJvb3QucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oXCIuc2ItdGFicyAubmF2LWxpbmtcIikuZm9yRWFjaCgobGluaykgPT4ge1xyXG4gICAgY29uc3Qgb24gPSBsaW5rLmRhdGFzZXQudGFiID09PSB0YWI7XHJcbiAgICBsaW5rLmNsYXNzTGlzdC50b2dnbGUoXCJhY3RpdmVcIiwgb24pO1xyXG4gICAgbGluay5zZXRBdHRyaWJ1dGUoXCJhcmlhLXNlbGVjdGVkXCIsIFN0cmluZyhvbikpO1xyXG4gIH0pO1xyXG4gIHJvb3QucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oXCIuc2ItdGFiLXBhbmVsXCIpLmZvckVhY2goKHBhbmVsKSA9PiB7XHJcbiAgICBwYW5lbC5oaWRkZW4gPSBwYW5lbC5kYXRhc2V0LnBhbmVsICE9PSB0YWI7XHJcbiAgfSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBXaXJlIGV2ZXJ5IGRhdGEtc2V0dGluZyBjb250cm9sLCB0aGUgdGFicyBhbmQgdGhlIG11dGUgYnV0dG9uLlxyXG4gKiBvbkNoYW5nZSBydW5zIGFmdGVyIGEgdmFsdWUgaXMgc3RvcmVkOyBvblRhYkNoYW5nZSBhZnRlciBhIHRhYiBzd2l0Y2guIEEgZHJvcGRvd24gY2hhbmdlXHJcbiAqIGZpcnN0IGF3YWl0cyBiZWZvcmVDaGFuZ2UgKGEgd2FybmluZywgc2F5KTogZmFsc2UgcHV0cyB0aGUgZHJvcGRvd24gYmFjayBhbmQgc3RvcmVzIG5vdGhpbmcuXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gYmluZFNldHRpbmdzQ29udHJvbHMoXHJcbiAgcm9vdDogUGFyZW50Tm9kZSxcclxuICBvbkNoYW5nZTogKGtleToga2V5b2YgU2V0dGluZ3MpID0+IHZvaWQsXHJcbiAgb25UYWJDaGFuZ2U6ICh0YWI6IFRhYklkKSA9PiB2b2lkLFxyXG4gIGJlZm9yZUNoYW5nZTogKGtleToga2V5b2YgU2V0dGluZ3MsIHZhbHVlOiBzdHJpbmcpID0+IFByb21pc2U8Ym9vbGVhbj4gPSBhc3luYyAoKSA9PiB0cnVlLFxyXG4pOiB2b2lkIHtcclxuICBjb25zdCBhcHBseSA9IChwYXRjaDogUGFydGlhbDxTZXR0aW5ncz4sIGtleToga2V5b2YgU2V0dGluZ3MpOiB2b2lkID0+IHtcclxuICAgIHVwZGF0ZVNldHRpbmdzKHBhdGNoKTtcclxuICAgIHN5bmNTZXR0aW5nc0NvbnRyb2xzKHJvb3QpO1xyXG4gICAgb25DaGFuZ2Uoa2V5KTtcclxuICB9O1xyXG5cclxuICByb290LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTElucHV0RWxlbWVudD4oXCJpbnB1dFtkYXRhLXNldHRpbmddXCIpLmZvckVhY2goKGlucHV0KSA9PiB7XHJcbiAgICBjb25zdCBrZXkgPSBpbnB1dC5kYXRhc2V0LnNldHRpbmcgYXMga2V5b2YgU2V0dGluZ3M7XHJcbiAgICAvLyBSYW5nZSB1cGRhdGVzIGxpdmUgd2hpbGUgZHJhZ2dpbmc7IG90aGVycyBvbiBjb21taXRcclxuICAgIGNvbnN0IGV2ZW50TmFtZSA9IGlucHV0LnR5cGUgPT09IFwicmFuZ2VcIiA/IFwiaW5wdXRcIiA6IFwiY2hhbmdlXCI7XHJcbiAgICBpbnB1dC5hZGRFdmVudExpc3RlbmVyKGV2ZW50TmFtZSwgKCkgPT4ge1xyXG4gICAgICBjb25zdCB2YWx1ZSA9IGlucHV0LnR5cGUgPT09IFwiY2hlY2tib3hcIiA/IGlucHV0LmNoZWNrZWQgOiBOdW1iZXIoaW5wdXQudmFsdWUpO1xyXG4gICAgICAvLyBTYXZlZCBvbiBpdHMgb3duLCBldmVuIHdoaWxlIHRlc3QgbW9kZSBob2xkcyBvdGhlciBzZXR0aW5ncyBiYWNrXHJcbiAgICAgIGlmIChrZXkgPT09IFwidGVzdE1vZGVcIikge1xyXG4gICAgICAgIGlucHV0LmRpc2FibGVkID0gdHJ1ZTtcclxuICAgICAgICB2b2lkIHNldFRlc3RNb2RlKGlucHV0LmNoZWNrZWQpLmZpbmFsbHkoKCkgPT4ge1xyXG4gICAgICAgICAgaW5wdXQuZGlzYWJsZWQgPSBmYWxzZTtcclxuICAgICAgICAgIHN5bmNTZXR0aW5nc0NvbnRyb2xzKHJvb3QpO1xyXG4gICAgICAgICAgb25DaGFuZ2Uoa2V5KTtcclxuICAgICAgICB9KTtcclxuICAgICAgICByZXR1cm47XHJcbiAgICAgIH1cclxuICAgICAgYXBwbHkoeyBba2V5XTogdmFsdWUgfSBhcyBQYXJ0aWFsPFNldHRpbmdzPiwga2V5KTtcclxuICAgIH0pO1xyXG4gIH0pO1xyXG5cclxuICByb290LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTFNlbGVjdEVsZW1lbnQ+KFwic2VsZWN0W2RhdGEtc2V0dGluZ11cIikuZm9yRWFjaCgoc2VsZWN0KSA9PiB7XHJcbiAgICBjb25zdCBrZXkgPSBzZWxlY3QuZGF0YXNldC5zZXR0aW5nIGFzIGtleW9mIFNldHRpbmdzO1xyXG4gICAgc2VsZWN0LmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgYXN5bmMgKCkgPT4ge1xyXG4gICAgICBjb25zdCB2YWx1ZSA9IHNlbGVjdC52YWx1ZTtcclxuICAgICAgc2VsZWN0LmRpc2FibGVkID0gdHJ1ZTtcclxuICAgICAgdHJ5IHtcclxuICAgICAgICBpZiAoYXdhaXQgYmVmb3JlQ2hhbmdlKGtleSwgdmFsdWUpKSBhcHBseSh7IFtrZXldOiB2YWx1ZSBhcyBTdGFzaFJhdGluZ3NNb2RlIH0gYXMgUGFydGlhbDxTZXR0aW5ncz4sIGtleSk7XHJcbiAgICAgICAgZWxzZSBzeW5jU2V0dGluZ3NDb250cm9scyhyb290KTtcclxuICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICBzZWxlY3QuZGlzYWJsZWQgPSBmYWxzZTtcclxuICAgICAgfVxyXG4gICAgfSk7XHJcbiAgfSk7XHJcblxyXG4gIC8vIFNwZWFrZXIgaWNvbjogbXV0ZSwgb3IgcmVzdG9yZSB0aGUgbGV2ZWwgZnJvbSBiZWZvcmUgbXV0aW5nXHJcbiAgcm9vdC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxCdXR0b25FbGVtZW50PihcIi5zYi12b2x1bWUtaWNvblwiKS5mb3JFYWNoKChidG4pID0+IHtcclxuICAgIGJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4ge1xyXG4gICAgICBjb25zdCBjdXJyZW50ID0gc3RhdGUuc2V0dGluZ3MucHJldmlld1ZvbHVtZTtcclxuICAgICAgaWYgKGN1cnJlbnQgPiAwKSB7XHJcbiAgICAgICAgdm9sdW1lQmVmb3JlTXV0ZSA9IGN1cnJlbnQ7XHJcbiAgICAgICAgYXBwbHkoeyBwcmV2aWV3Vm9sdW1lOiAwIH0sIFwicHJldmlld1ZvbHVtZVwiKTtcclxuICAgICAgfSBlbHNlIHtcclxuICAgICAgICBhcHBseSh7IHByZXZpZXdWb2x1bWU6IHZvbHVtZUJlZm9yZU11dGUgPz8gREVGQVVMVF9VTk1VVEVfVk9MVU1FIH0sIFwicHJldmlld1ZvbHVtZVwiKTtcclxuICAgICAgfVxyXG4gICAgfSk7XHJcbiAgfSk7XHJcblxyXG4gIHJvb3QucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oXCIuc2ItdGFicyAubmF2LWxpbmtcIikuZm9yRWFjaCgobGluaykgPT4ge1xyXG4gICAgbGluay5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4ge1xyXG4gICAgICBjb25zdCB0YWIgPSBsaW5rLmRhdGFzZXQudGFiIGFzIFRhYklkO1xyXG4gICAgICBpZiAodGFiID09PSBhY3RpdmVUYWIpIHJldHVybjtcclxuICAgICAgc2hvd1RhYihyb290LCB0YWIpO1xyXG4gICAgICBvblRhYkNoYW5nZSh0YWIpO1xyXG4gICAgfSk7XHJcbiAgfSk7XHJcbn1cclxuIiwgIi8vIFRoZSDwn5SOIEV4cGxvcmUgdGFiOiB0aGUgd2hvbGUgbGlicmFyeSBhcyBzbWFsbCBjYXJkcywgcmFua2VkIGJ5IEVMTywgd2l0aCBzZWFyY2ggKHRpdGxlLCBzdHVkaW8sXG4vLyBwZXJmb3JtZXJzKSwgdGllciAvIHByb3Zpc2lvbmFsIC8gdW5yYXRlZCBmaWx0ZXJzLCBhbiBFTE8gcmFuZ2UgYW5kIHNvcnRpbmcuIENsaWNraW5nIGEgY2FyZFxuLy8gb3BlbnMgdGhlIHNjZW5lJ3MgcGFnZTsgaXRzIOKalO+4jyBidXR0b24gYmF0dGxlcyBpdDsgaG92ZXJpbmcgKG9uIHRvdWNoLCB0YXBwaW5nIHRoZSB0aHVtYm5haWwpXG4vLyBwbGF5cyBpdHMgcHJldmlldyAoYXQgdGhlIHByZXZpZXcgdm9sdW1lLCBsaWtlIHRoZSBiYXR0bGUgY2FyZHMpLiBcIkJhdHRsZSB0aGVzZVwiIGJhdHRsZXMgdGhlIGZpbHRlcidzIHNjZW5lcy4gQnVpbHRcbi8vIGZyb20gU3Rhc2ggQmF0dGxlJ3MgYWxsLXNjZW5lcyBjYWNoZSBlYWNoIHRpbWUgdGhlIHRhYiBvcGVucywgYW5kIHNob3duIGEgcGFnZSBhdCBhIHRpbWUsIHNvIGFcbi8vIGJpZyBsaWJyYXJ5IG5ldmVyIHB1dHMgdGhvdXNhbmRzIG9mIGNhcmRzIG9uIHRoZSBwYWdlLlxuXG5pbXBvcnQgeyBnZXRBbGxTY2VuZXNDYWNoZWQgfSBmcm9tIFwiLi4vY2FjaGVcIjtcbmltcG9ydCB7IEVYUExPUkVfUEFHRV9TSVpFUywgVElFUlMgfSBmcm9tIFwiLi4vY29uc3RhbnRzXCI7XG5pbXBvcnQge1xuICBERUZBVUxUX0VYUExPUkVfRklMVEVSUyxcbiAgZXhwbG9yZUVudHJpZXMsXG4gIGZpbHRlckJhdHRsZXNXaXRoaW4sXG4gIGZpbHRlckV4cGxvcmUsXG4gIHR5cGUgRXhwbG9yZUVudHJ5LFxuICB0eXBlIEV4cGxvcmVGaWx0ZXJzLFxuICB0eXBlIEV4cGxvcmVTb3J0LFxufSBmcm9tIFwiLi4vZXhwbG9yZVwiO1xuaW1wb3J0IHsgdXBkYXRlU2V0dGluZ3MgfSBmcm9tIFwiLi4vc2V0dGluZ3NcIjtcbmltcG9ydCB7IGlzRWxvU2V0dXBQZW5kaW5nLCBzdGF0ZSB9IGZyb20gXCIuLi9zdGF0ZVwiO1xuaW1wb3J0IHsgdGllckRlc2NyaXB0aW9uLCB0aWVyTWFwIH0gZnJvbSBcIi4uL3N0YXRzXCI7XG5pbXBvcnQgeyBoYW5kbGVTY2VuZUxpbmtDbGljaywgaXNUb3VjaERldmljZSB9IGZyb20gXCIuL21haW5VSVwiO1xuaW1wb3J0IHsgUFJPVklTSU9OQUxfVElQIH0gZnJvbSBcIi4vc2NlbmVDYXJkXCI7XG5pbXBvcnQgeyBlc2NhcGVIdG1sLCBoYW5kbGVNaW5pTXV0ZVRhcCwgaGFuZGxlTWluaVRodW1iVGFwLCBtaW5pQ2FyZEh0bWwsIG1pbmlQcmV2aWV3Q2FyZCwgc3RhcnRNaW5pUHJldmlldywgc3RvcE1pbmlQcmV2aWV3IH0gZnJvbSBcIi4vbWluaUNhcmRcIjtcbmltcG9ydCB7IHJlc29sdmVTY2VuZVRpdGxlIH0gZnJvbSBcIi4uL3NjZW5lVGl0bGVcIjtcbmltcG9ydCB0eXBlIHsgU3RhdHNBY3Rpb25zIH0gZnJvbSBcIi4vc3RhdHNUYWJcIjtcblxuY29uc3QgU0VBUkNIX0RFQk9VTkNFX01TID0gMTUwO1xuLyoqXG4gKiBBZnRlciBhIHBhZ2UgY2hhbmdlLCBjYXJkIGNsaWNrcyB3YWl0IHRoaXMgbG9uZzogdGhlIGxpc3QganVtcHMgdW5kZXIgdGhlIHBvaW50ZXIsIGFuZCBhIHF1aWNrXG4gKiBzZWNvbmQgY2xpY2sgb24gTmV4dCB3b3VsZCBvdGhlcndpc2Ugb3BlbiB3aGljaGV2ZXIgc2NlbmUgbGFuZGVkIHRoZXJlLlxuICovXG5jb25zdCBQQUdFX0NMSUNLX0dVQVJEX01TID0gNzAwO1xuXG5jb25zdCBTT1JUUzogeyB2YWx1ZTogRXhwbG9yZVNvcnQ7IGxhYmVsOiBzdHJpbmcgfVtdID0gW1xuICB7IHZhbHVlOiBcImVsby1kZXNjXCIsIGxhYmVsOiBcIkVMTzogaGlnaGVzdCBmaXJzdFwiIH0sXG4gIHsgdmFsdWU6IFwiZWxvLWFzY1wiLCBsYWJlbDogXCJFTE86IGxvd2VzdCBmaXJzdFwiIH0sXG4gIHsgdmFsdWU6IFwicGxheXMtZGVzY1wiLCBsYWJlbDogXCJNb3N0IHBsYXllZFwiIH0sXG4gIHsgdmFsdWU6IFwicGxheXMtYXNjXCIsIGxhYmVsOiBcIkxlYXN0IHBsYXllZFwiIH0sXG4gIHsgdmFsdWU6IFwiYmF0dGxlcy1kZXNjXCIsIGxhYmVsOiBcIk1vc3QgYmF0dGxlc1wiIH0sXG4gIHsgdmFsdWU6IFwiYmF0dGxlcy1hc2NcIiwgbGFiZWw6IFwiRmV3ZXN0IGJhdHRsZXNcIiB9LFxuICB7IHZhbHVlOiBcInJlY29yZC1kZXNjXCIsIGxhYmVsOiBcIkJlc3QgcmVjb3JkXCIgfSxcbiAgeyB2YWx1ZTogXCJwZWFrLWRlc2NcIiwgbGFiZWw6IFwiSGlnaGVzdCBwZWFrIEVMT1wiIH0sXG4gIHsgdmFsdWU6IFwic3RyZWFrLWRlc2NcIiwgbGFiZWw6IFwiTG9uZ2VzdCB3aW4gc3RyZWFrXCIgfSxcbl07XG5cbmxldCBmaWx0ZXJzOiBFeHBsb3JlRmlsdGVycyA9IHsgLi4uREVGQVVMVF9FWFBMT1JFX0ZJTFRFUlMgfTtcbmxldCBlbnRyaWVzOiBFeHBsb3JlRW50cnlbXSA9IFtdO1xubGV0IHJlc3VsdHM6IEV4cGxvcmVFbnRyeVtdID0gW107XG5sZXQgcGFnZSA9IDA7XG5sZXQgaWdub3JlQ2FyZENsaWNrc1VudGlsID0gMDtcbmxldCBhY3Rpb25zOiBTdGF0c0FjdGlvbnMgfCBudWxsID0gbnVsbDtcblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZUV4cGxvcmVUYWIoKTogc3RyaW5nIHtcbiAgcmV0dXJuIGBcbiAgICAgIDxkaXYgY2xhc3M9XCJzYi10YWItcGFuZWwgc2ItZXhwbG9yZS10YWJcIiBkYXRhLXBhbmVsPVwiZXhwbG9yZVwiIGhpZGRlbj5cbiAgICAgICAgPGRpdiBpZD1cInNiLWV4cGxvcmUtY29udGVudFwiPjwvZGl2PlxuICAgICAgPC9kaXY+XG4gICAgYDtcbn1cblxuLyoqIFN0YXJ0IEV4cGxvcmUgb24gdGhlc2UgZmlsdGVycyAoZS5nLiBhbiBFTE8gcmFuZ2UgZnJvbSB0aGUgU3RhdHMgdGFiKTsgdGhlIHJlc3QgcmVzZXQuICovXG5leHBvcnQgZnVuY3Rpb24gc2V0RXhwbG9yZUZpbHRlcnMocGF0Y2g6IFBhcnRpYWw8RXhwbG9yZUZpbHRlcnM+KTogdm9pZCB7XG4gIGZpbHRlcnMgPSB7IC4uLkRFRkFVTFRfRVhQTE9SRV9GSUxURVJTLCAuLi5wYXRjaCB9O1xuICBwYWdlID0gMDtcbn1cblxuZnVuY3Rpb24gaXNGaWx0ZXJlZCgpOiBib29sZWFuIHtcbiAgcmV0dXJuIGZpbHRlcnMucXVlcnkudHJpbSgpICE9PSBcIlwiIHx8IGZpbHRlcnMuZ3JvdXAgIT09IG51bGwgfHwgZmlsdGVycy5lbG9NaW4gIT09IG51bGwgfHwgZmlsdGVycy5lbG9NYXggIT09IG51bGw7XG59XG5cbi8qKiBDYXJkcyBwZXIgcGFnZSAoXCJBbGxcIiBwdXRzIGV2ZXJ5IHJlc3VsdCBvbiBvbmUgcGFnZSkuICovXG5mdW5jdGlvbiBwYWdlU2l6ZSgpOiBudW1iZXIge1xuICByZXR1cm4gc3RhdGUuc2V0dGluZ3MuZXhwbG9yZVBhZ2VTaXplIHx8IE1hdGgubWF4KDEsIHJlc3VsdHMubGVuZ3RoKTtcbn1cblxuZnVuY3Rpb24gcGFnZUNvdW50KCk6IG51bWJlciB7XG4gIHJldHVybiBNYXRoLm1heCgxLCBNYXRoLmNlaWwocmVzdWx0cy5sZW5ndGggLyBwYWdlU2l6ZSgpKSk7XG59XG5cbmZ1bmN0aW9uIGNvbnRyb2xzSHRtbCgpOiBzdHJpbmcge1xuICAvLyBFYWNoIGNoaXAncyB0b29sdGlwIGlzIHRoZSBvbmUgaXRzIGNhcmRzJyBwaWxscyBoYXZlXG4gIGNvbnN0IGdyb3VwczogeyB2YWx1ZTogc3RyaW5nOyBsYWJlbDogc3RyaW5nOyB0aXA6IHN0cmluZyB9W10gPSBbXG4gICAgLi4uVElFUlMubWFwKCh0KSA9PiAoeyB2YWx1ZTogdC5pZCwgbGFiZWw6IGAke3QuZW1vaml9ICR7dC5uYW1lfWAsIHRpcDogdGllckRlc2NyaXB0aW9uKHQpIH0pKSxcbiAgICB7IHZhbHVlOiBcInByb3Zpc2lvbmFsXCIsIGxhYmVsOiBcIlByb3Zpc2lvbmFsXCIsIHRpcDogUFJPVklTSU9OQUxfVElQIH0sXG4gICAgeyB2YWx1ZTogXCJ1bnJhdGVkXCIsIGxhYmVsOiBcIlVucmF0ZWRcIiwgdGlwOiBcIk5vIEVMTyB5ZXRcIiB9LFxuICBdO1xuICBjb25zdCBjaGlwID0gKHZhbHVlOiBzdHJpbmcgfCBudWxsLCBsYWJlbDogc3RyaW5nLCB0aXAgPSBcIlwiKTogc3RyaW5nID0+XG4gICAgYDxidXR0b24gdHlwZT1cImJ1dHRvblwiIGNsYXNzPVwic2ItY2hpcCR7ZmlsdGVycy5ncm91cCA9PT0gdmFsdWUgPyBcIiBhY3RpdmVcIiA6IFwiXCJ9XCIgZGF0YS1ncm91cD1cIiR7dmFsdWUgPz8gXCJcIn1cIiR7dGlwID8gYCB0aXRsZT1cIiR7dGlwfVwiYCA6IFwiXCJ9PiR7bGFiZWx9PC9idXR0b24+YDtcbiAgY29uc3QgbnVtYmVyID0gKHZhbHVlOiBudW1iZXIgfCBudWxsKTogc3RyaW5nID0+ICh2YWx1ZSA9PT0gbnVsbCA/IFwiXCIgOiBTdHJpbmcodmFsdWUpKTtcbiAgcmV0dXJuIGBcbiAgICAgICAgPGRpdiBjbGFzcz1cInNiLWV4cGxvcmUtY29udHJvbHNcIj5cbiAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItZXhwbG9yZS1yb3dcIj5cbiAgICAgICAgICAgIDxpbnB1dCB0eXBlPVwic2VhcmNoXCIgY2xhc3M9XCJzYi1leHBsb3JlLWlucHV0IHNiLWV4cGxvcmUtc2VhcmNoXCIgcGxhY2Vob2xkZXI9XCLwn5SNICBTZWFyY2ggdGl0bGVzLCBzdHVkaW9zLCBwZXJmb3JtZXJzXCIgdmFsdWU9XCIke2VzY2FwZUh0bWwoZmlsdGVycy5xdWVyeSl9XCIgYXJpYS1sYWJlbD1cIlNlYXJjaCBzY2VuZXNcIj5cbiAgICAgICAgICAgIDxzZWxlY3QgY2xhc3M9XCJzYi1leHBsb3JlLWlucHV0IHNiLWV4cGxvcmUtc2VsZWN0IHNiLWV4cGxvcmUtc29ydFwiIGFyaWEtbGFiZWw9XCJTb3J0XCI+XG4gICAgICAgICAgICAgICR7U09SVFMubWFwKChzKSA9PiBgPG9wdGlvbiB2YWx1ZT1cIiR7cy52YWx1ZX1cIiR7cy52YWx1ZSA9PT0gZmlsdGVycy5zb3J0ID8gXCIgc2VsZWN0ZWRcIiA6IFwiXCJ9PiR7cy5sYWJlbH08L29wdGlvbj5gKS5qb2luKFwiXCIpfVxuICAgICAgICAgICAgPC9zZWxlY3Q+XG4gICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgPGRpdiBjbGFzcz1cInNiLWV4cGxvcmUtcm93IHNiLWV4cGxvcmUtcm93LXdyYXBcIj5cbiAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1jaGlwc1wiPiR7Y2hpcChudWxsLCBcIkFsbFwiKX0ke2dyb3Vwcy5tYXAoKGcpID0+IGNoaXAoZy52YWx1ZSwgZy5sYWJlbCwgZy50aXApKS5qb2luKFwiXCIpfTwvZGl2PlxuICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNiLWV4cGxvcmUtcmFuZ2VcIj5cbiAgICAgICAgICAgICAgPHNwYW4+RUxPPC9zcGFuPlxuICAgICAgICAgICAgICA8aW5wdXQgdHlwZT1cIm51bWJlclwiIGNsYXNzPVwic2ItZXhwbG9yZS1pbnB1dCBzYi1leHBsb3JlLWVsb1wiIGRhdGEtYm91bmQ9XCJtaW5cIiBwbGFjZWhvbGRlcj1cImZyb21cIiB2YWx1ZT1cIiR7bnVtYmVyKGZpbHRlcnMuZWxvTWluKX1cIiBhcmlhLWxhYmVsPVwiTG93ZXN0IEVMT1wiPlxuICAgICAgICAgICAgICA8c3Bhbj7igJM8L3NwYW4+XG4gICAgICAgICAgICAgIDxpbnB1dCB0eXBlPVwibnVtYmVyXCIgY2xhc3M9XCJzYi1leHBsb3JlLWlucHV0IHNiLWV4cGxvcmUtZWxvXCIgZGF0YS1ib3VuZD1cIm1heFwiIHBsYWNlaG9sZGVyPVwidG9cIiB2YWx1ZT1cIiR7bnVtYmVyKGZpbHRlcnMuZWxvTWF4KX1cIiBhcmlhLWxhYmVsPVwiSGlnaGVzdCBFTE9cIj5cbiAgICAgICAgICAgIDwvZGl2PlxuICAgICAgICAgIDwvZGl2PlxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1leHBsb3JlLXN0YXR1cy1yb3dcIj5cbiAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1leHBsb3JlLXN0YXR1c1wiPjwvZGl2PlxuICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNiLWV4cGxvcmUtcGFnaW5nXCI+XG4gICAgICAgICAgICAgIDxzZWxlY3QgY2xhc3M9XCJzYi1leHBsb3JlLWlucHV0IHNiLWV4cGxvcmUtc2VsZWN0IHNiLXBhZ2VyLXNlbGVjdCBzYi1leHBsb3JlLXBlci1wYWdlXCIgYXJpYS1sYWJlbD1cIlNjZW5lcyBwZXIgcGFnZVwiPlxuICAgICAgICAgICAgICAgICR7RVhQTE9SRV9QQUdFX1NJWkVTLm1hcCgobikgPT4gYDxvcHRpb24gdmFsdWU9XCIke259XCIke24gPT09IHN0YXRlLnNldHRpbmdzLmV4cGxvcmVQYWdlU2l6ZSA/IFwiIHNlbGVjdGVkXCIgOiBcIlwifT4ke24gPyBgJHtufSBwZXIgcGFnZWAgOiBcIkFsbCBvbiBvbmUgcGFnZVwifTwvb3B0aW9uPmApLmpvaW4oXCJcIil9XG4gICAgICAgICAgICAgIDwvc2VsZWN0PlxuICAgICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItZXhwbG9yZS1wYWdlclwiPjwvZGl2PlxuICAgICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgPC9kaXY+XG4gICAgICAgIDwvZGl2PlxuICAgICAgICA8ZGl2IGNsYXNzPVwic2ItZXhwbG9yZS1ncmlkXCI+PC9kaXY+XG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi1leHBsb3JlLXBhZ2VyIHNiLWV4cGxvcmUtcGFnZXItYm90dG9tXCI+PC9kaXY+YDtcbn1cblxuLyoqIOKAuSBbUGFnZSAzIG9mIDM0XSDigLog4oCUIHRoZSBwYWdlIG51bWJlciBpcyBhIGRyb3Bkb3duLCB0byBqdW1wIHN0cmFpZ2h0IHRvIGEgcGFnZS4gKi9cbmZ1bmN0aW9uIHBhZ2VySHRtbCgpOiBzdHJpbmcge1xuICBjb25zdCBwYWdlcyA9IHBhZ2VDb3VudCgpO1xuICBpZiAocGFnZXMgPD0gMSkgcmV0dXJuIFwiXCI7XG4gIGNvbnN0IG9wdGlvbnMgPSBBcnJheS5mcm9tKFxuICAgIHsgbGVuZ3RoOiBwYWdlcyB9LFxuICAgIChfLCBpKSA9PiBgPG9wdGlvbiB2YWx1ZT1cIiR7aX1cIiR7aSA9PT0gcGFnZSA/IFwiIHNlbGVjdGVkXCIgOiBcIlwifT5QYWdlICR7aSArIDF9IG9mICR7cGFnZXN9PC9vcHRpb24+YCxcbiAgKS5qb2luKFwiXCIpO1xuICByZXR1cm4gYFxuICAgICAgICAgIDxidXR0b24gdHlwZT1cImJ1dHRvblwiIGNsYXNzPVwic2ItcGFnZXItYnRuXCIgZGF0YS1wYWdlLXN0ZXA9XCItMVwiJHtwYWdlID09PSAwID8gXCIgZGlzYWJsZWRcIiA6IFwiXCJ9IGFyaWEtbGFiZWw9XCJQcmV2aW91cyBwYWdlXCI+4oC5PC9idXR0b24+XG4gICAgICAgICAgPHNlbGVjdCBjbGFzcz1cInNiLWV4cGxvcmUtaW5wdXQgc2ItZXhwbG9yZS1zZWxlY3Qgc2ItcGFnZXItc2VsZWN0XCIgYXJpYS1sYWJlbD1cIlBhZ2VcIj4ke29wdGlvbnN9PC9zZWxlY3Q+XG4gICAgICAgICAgPGJ1dHRvbiB0eXBlPVwiYnV0dG9uXCIgY2xhc3M9XCJzYi1wYWdlci1idG5cIiBkYXRhLXBhZ2Utc3RlcD1cIjFcIiR7cGFnZSA+PSBwYWdlcyAtIDEgPyBcIiBkaXNhYmxlZFwiIDogXCJcIn0gYXJpYS1sYWJlbD1cIk5leHQgcGFnZVwiPuKAujwvYnV0dG9uPmA7XG59XG5cbi8qKiBEcmF3IHRoZSBjdXJyZW50IHBhZ2Ugb2YgY2FyZHMgYW5kIHRoZSBwYWdlcnMuICovXG5mdW5jdGlvbiBzaG93UGFnZShjb250ZW50OiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICBzdG9wTWluaVByZXZpZXcoKTtcbiAgcGFnZSA9IE1hdGgubWluKE1hdGgubWF4KDAsIHBhZ2UpLCBwYWdlQ291bnQoKSAtIDEpO1xuICBjb25zdCBncmlkID0gY29udGVudC5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIi5zYi1leHBsb3JlLWdyaWRcIik7XG4gIGlmIChncmlkKSB7XG4gICAgZ3JpZC5pbm5lckhUTUwgPSByZXN1bHRzLmxlbmd0aFxuICAgICAgPyByZXN1bHRzLnNsaWNlKHBhZ2UgKiBwYWdlU2l6ZSgpLCAocGFnZSArIDEpICogcGFnZVNpemUoKSkubWFwKChlbnRyeSkgPT4gbWluaUNhcmRIdG1sKGVudHJ5KSkuam9pbihcIlwiKVxuICAgICAgOiBgPHAgY2xhc3M9XCJzYi1zdGF0cy1lbXB0eVwiPk5vIHNjZW5lcyBtYXRjaC48L3A+YDtcbiAgfVxuICBjb250ZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KFwiLnNiLWV4cGxvcmUtcGFnZXJcIikuZm9yRWFjaCgocGFnZXIpID0+IChwYWdlci5pbm5lckhUTUwgPSBwYWdlckh0bWwoKSkpO1xufVxuXG4vKiogVGhlIGZpbHRlciBpbiB3b3JkcywgZm9yIHRoZSBub3RlIGFib3ZlIHRoZSBjYXJkczogXCLwn5GRIExlZ2VuZGFyeSDCtyBFTE8gMTYwMOKAkzE3MDAgwrcg4oCcamFuZeKAnVwiLiAqL1xuZnVuY3Rpb24gZmlsdGVyTGFiZWwoKTogc3RyaW5nIHtcbiAgY29uc3QgcGFydHM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IHRpZXIgPSBUSUVSUy5maW5kKCh0KSA9PiB0LmlkID09PSBmaWx0ZXJzLmdyb3VwKTtcbiAgaWYgKHRpZXIpIHBhcnRzLnB1c2goYCR7dGllci5lbW9qaX0gJHt0aWVyLm5hbWV9YCk7XG4gIGVsc2UgaWYgKGZpbHRlcnMuZ3JvdXAgPT09IFwicHJvdmlzaW9uYWxcIikgcGFydHMucHVzaChcIlByb3Zpc2lvbmFsXCIpO1xuICBlbHNlIGlmIChmaWx0ZXJzLmdyb3VwID09PSBcInVucmF0ZWRcIikgcGFydHMucHVzaChcIlVucmF0ZWRcIik7XG4gIGlmIChmaWx0ZXJzLmVsb01pbiAhPT0gbnVsbCB8fCBmaWx0ZXJzLmVsb01heCAhPT0gbnVsbCkge1xuICAgIHBhcnRzLnB1c2goYEVMTyAke2ZpbHRlcnMuZWxvTWluID8/IFwi4oCmXCJ94oCTJHtmaWx0ZXJzLmVsb01heCA/PyBcIuKAplwifWApO1xuICB9XG4gIGlmIChmaWx0ZXJzLnF1ZXJ5LnRyaW0oKSkgcGFydHMucHVzaChg4oCcJHtlc2NhcGVIdG1sKGZpbHRlcnMucXVlcnkudHJpbSgpKX3igJ1gKTtcbiAgcmV0dXJuIHBhcnRzLmpvaW4oXCIgwrcgXCIpO1xufVxuXG4vKiogXCJCYXR0bGUgdGhlc2VcIjogUGxhY2VtZW50IGZvciB1bnJhdGVkIHNjZW5lcywgb3RoZXJ3aXNlIFN3aXNzICh2cyBldmVyeW9uZSwgb3Igd2l0aGluIHRoZSBmaWx0ZXIpLiAqL1xuZnVuY3Rpb24gYmF0dGxlQnV0dG9uSHRtbCgpOiBzdHJpbmcge1xuICBpZiAoIWlzRmlsdGVyZWQoKSB8fCByZXN1bHRzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIFwiXCI7XG4gIGNvbnN0IHdpdGhpbiA9IGZpbHRlckJhdHRsZXNXaXRoaW4oZmlsdGVycywgc3RhdGUuc2V0dGluZ3MuZmlsdGVyT3Bwb25lbnRzKTtcbiAgY29uc3QgbiA9IHJlc3VsdHMubGVuZ3RoO1xuICBjb25zdCBzY2VuZXMgPSBgJHtufSBzY2VuZSR7biA9PT0gMSA/IFwiXCIgOiBcInNcIn1gO1xuICBjb25zdCBsYWJlbCA9XG4gICAgZmlsdGVycy5ncm91cCA9PT0gXCJ1bnJhdGVkXCJcbiAgICAgID8gYPCfk40gUGxhY2UgdGhlc2UgJHtzY2VuZXN9YFxuICAgICAgOiBmaWx0ZXJzLmdyb3VwID09PSBcInByb3Zpc2lvbmFsXCJcbiAgICAgICAgPyBg8J+UgSBLZWVwIHRlc3RpbmcgdGhlc2UgJHtzY2VuZXN9YFxuICAgICAgICA6IGDimpTvuI8gQmF0dGxlIHRoZXNlICR7c2NlbmVzfWA7XG4gIGNvbnN0IHRpcCA9XG4gICAgZmlsdGVycy5ncm91cCA9PT0gXCJ1bnJhdGVkXCJcbiAgICAgID8gXCJQbGFjZW1lbnQsIG9uZSBzY2VuZSBhdCBhIHRpbWUsIGFnYWluc3QgeW91ciB3aG9sZSBsaWJyYXJ5XCJcbiAgICAgIDogd2l0aGluXG4gICAgICAgID8gXCJTd2lzcywgd2l0aCBib3RoIHNpZGVzIGZyb20gdGhlc2Ugc2NlbmVzICjigJxVc2UgZmlsdGVyZWQgc2NlbmVzIGZvciBib3RoIHNpZGVz4oCdIGlzIG9uKVwiXG4gICAgICAgIDogXCJTd2lzcywgdGhlc2Ugc2NlbmVzIGFnYWluc3QgeW91ciB3aG9sZSBsaWJyYXJ5ICh0dXJuIG9uIOKAnFVzZSBmaWx0ZXJlZCBzY2VuZXMgZm9yIGJvdGggc2lkZXPigJ0gaW4gU2V0dGluZ3MgdG8ga2VlcCBib3RoIHNpZGVzIGluIHRoZSBmaWx0ZXIpXCI7XG4gIGNvbnN0IGRpc2FibGVkID0gd2l0aGluICYmIG4gPCAyID8gXCIgZGlzYWJsZWRcIiA6IFwiXCI7XG4gIHJldHVybiBgPGJ1dHRvbiB0eXBlPVwiYnV0dG9uXCIgY2xhc3M9XCJidG4gYnRuLXByaW1hcnkgYnRuLXNtIHNiLWV4cGxvcmUtYmF0dGxlXCIgZGF0YS1leHBsb3JlLWJhdHRsZSB0aXRsZT1cIiR7dGlwfVwiJHtkaXNhYmxlZH0+JHtsYWJlbH08L2J1dHRvbj5gO1xufVxuXG4vKiogUmUtcnVuIHRoZSBmaWx0ZXJzIGFuZCBnbyBiYWNrIHRvIHRoZSBmaXJzdCBwYWdlLiAqL1xuZnVuY3Rpb24gYXBwbHlGaWx0ZXJzKGNvbnRlbnQ6IEhUTUxFbGVtZW50LCBrZWVwUGFnZSA9IGZhbHNlKTogdm9pZCB7XG4gIHJlc3VsdHMgPSBmaWx0ZXJFeHBsb3JlKGVudHJpZXMsIGZpbHRlcnMpO1xuICBpZiAoIWtlZXBQYWdlKSBwYWdlID0gMDtcbiAgY29uc3Qgc3RhdHVzID0gY29udGVudC5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIi5zYi1leHBsb3JlLXN0YXR1c1wiKTtcbiAgaWYgKHN0YXR1cykge1xuICAgIHN0YXR1cy5pbm5lckhUTUwgPSBgPHNwYW4+JHtyZXN1bHRzLmxlbmd0aCA9PT0gZW50cmllcy5sZW5ndGggPyBgJHtlbnRyaWVzLmxlbmd0aH0gc2NlbmVzYCA6IGAke3Jlc3VsdHMubGVuZ3RofSBvZiAke2VudHJpZXMubGVuZ3RofSBzY2VuZXNgfSR7XG4gICAgICBpc0ZpbHRlcmVkKCkgPyBgIMK3IDxhIGhyZWY9XCIjXCIgZGF0YS1leHBsb3JlLWNsZWFyPkNsZWFyIGZpbHRlcnM8L2E+YCA6IFwiXCJcbiAgICB9PC9zcGFuPiR7YmF0dGxlQnV0dG9uSHRtbCgpfWA7XG4gIH1cbiAgc2hvd1BhZ2UoY29udGVudCk7XG59XG5cbi8qKiBDaGFuZ2UgcGFnZTsgZnJvbSB0aGUgYm90dG9tIHBhZ2VyLCBicmluZyB0aGUgdG9wIG9mIHRoZSBsaXN0IGJhY2sgaW50byB2aWV3LiAqL1xuZnVuY3Rpb24gZ29Ub1BhZ2UoY29udGVudDogSFRNTEVsZW1lbnQsIHNjcm9sbFJvb3Q6IEhUTUxFbGVtZW50IHwgbnVsbCwgbmV4dDogbnVtYmVyKTogdm9pZCB7XG4gIHBhZ2UgPSBuZXh0O1xuICBzaG93UGFnZShjb250ZW50KTtcbiAgaWdub3JlQ2FyZENsaWNrc1VudGlsID0gRGF0ZS5ub3coKSArIFBBR0VfQ0xJQ0tfR1VBUkRfTVM7XG4gIGNvbnN0IGNvbnRyb2xzID0gY29udGVudC5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIi5zYi1leHBsb3JlLWNvbnRyb2xzXCIpO1xuICBpZiAoIXNjcm9sbFJvb3QgfHwgIWNvbnRyb2xzKSByZXR1cm47XG4gIGNvbnN0IG9mZnNldCA9IGNvbnRyb2xzLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpLnRvcCAtIHNjcm9sbFJvb3QuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCkudG9wO1xuICBpZiAob2Zmc2V0IDwgMCkgc2Nyb2xsUm9vdC5zY3JvbGxUb3AgKz0gb2Zmc2V0O1xufVxuXG4vLyAtLS0tLS0tLS0tIEV2ZW50cyAtLS0tLS0tLS0tXG5cbmZ1bmN0aW9uIGJpbmRDb250cm9scyhjb250ZW50OiBIVE1MRWxlbWVudCwgc2Nyb2xsUm9vdDogSFRNTEVsZW1lbnQgfCBudWxsKTogdm9pZCB7XG4gIGxldCBzZWFyY2hUaW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCBudWxsID0gbnVsbDtcbiAgY29udGVudC5xdWVyeVNlbGVjdG9yPEhUTUxJbnB1dEVsZW1lbnQ+KFwiLnNiLWV4cGxvcmUtc2VhcmNoXCIpPy5hZGRFdmVudExpc3RlbmVyKFwiaW5wdXRcIiwgKGUpID0+IHtcbiAgICBmaWx0ZXJzLnF1ZXJ5ID0gKGUudGFyZ2V0IGFzIEhUTUxJbnB1dEVsZW1lbnQpLnZhbHVlO1xuICAgIGlmIChzZWFyY2hUaW1lcikgY2xlYXJUaW1lb3V0KHNlYXJjaFRpbWVyKTtcbiAgICBzZWFyY2hUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4gYXBwbHlGaWx0ZXJzKGNvbnRlbnQpLCBTRUFSQ0hfREVCT1VOQ0VfTVMpO1xuICB9KTtcbiAgY29udGVudC5xdWVyeVNlbGVjdG9yPEhUTUxTZWxlY3RFbGVtZW50PihcIi5zYi1leHBsb3JlLXNvcnRcIik/LmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKGUpID0+IHtcbiAgICBmaWx0ZXJzLnNvcnQgPSAoZS50YXJnZXQgYXMgSFRNTFNlbGVjdEVsZW1lbnQpLnZhbHVlIGFzIEV4cGxvcmVTb3J0O1xuICAgIGFwcGx5RmlsdGVycyhjb250ZW50KTtcbiAgfSk7XG4gIGNvbnRlbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MSW5wdXRFbGVtZW50PihcIi5zYi1leHBsb3JlLWVsb1wiKS5mb3JFYWNoKChpbnB1dCkgPT4ge1xuICAgIGlucHV0LmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4ge1xuICAgICAgY29uc3QgdmFsdWUgPSBpbnB1dC52YWx1ZS50cmltKCkgPT09IFwiXCIgPyBudWxsIDogTnVtYmVyKGlucHV0LnZhbHVlKTtcbiAgICAgIGNvbnN0IGJvdW5kID0gTnVtYmVyLmlzRmluaXRlKHZhbHVlKSA/IHZhbHVlIDogbnVsbDtcbiAgICAgIGlmIChpbnB1dC5kYXRhc2V0LmJvdW5kID09PSBcIm1pblwiKSBmaWx0ZXJzLmVsb01pbiA9IGJvdW5kO1xuICAgICAgZWxzZSBmaWx0ZXJzLmVsb01heCA9IGJvdW5kO1xuICAgICAgYXBwbHlGaWx0ZXJzKGNvbnRlbnQpO1xuICAgIH0pO1xuICB9KTtcblxuICAvLyBUaGUgY29udGVudCBlbGVtZW50IG91dGxpdmVzIGVhY2ggcmVuZGVyLCBzbyB0aGVzZSBiaW5kIG9uY2VcbiAgaWYgKGNvbnRlbnQuZGF0YXNldC5ib3VuZCA9PT0gXCIxXCIpIHJldHVybjtcbiAgY29udGVudC5kYXRhc2V0LmJvdW5kID0gXCIxXCI7XG4gIGNvbnRlbnQuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiBvbkNvbnRlbnRDbGljayhlLCBjb250ZW50LCBzY3JvbGxSb290KSk7XG4gIGNvbnRlbnQuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoZSkgPT4ge1xuICAgIGNvbnN0IHNlbGVjdCA9IGUudGFyZ2V0IGFzIEhUTUxTZWxlY3RFbGVtZW50O1xuICAgIGlmIChzZWxlY3QuY2xhc3NMaXN0LmNvbnRhaW5zKFwic2ItZXhwbG9yZS1wZXItcGFnZVwiKSkge1xuICAgICAgdXBkYXRlU2V0dGluZ3MoeyBleHBsb3JlUGFnZVNpemU6IE51bWJlcihzZWxlY3QudmFsdWUpIH0pO1xuICAgICAgZ29Ub1BhZ2UoY29udGVudCwgc2Nyb2xsUm9vdCwgMCk7XG4gICAgfSBlbHNlIGlmIChzZWxlY3QuY2xhc3NMaXN0LmNvbnRhaW5zKFwic2ItcGFnZXItc2VsZWN0XCIpKSB7XG4gICAgICBnb1RvUGFnZShjb250ZW50LCBzY3JvbGxSb290LCBOdW1iZXIoc2VsZWN0LnZhbHVlKSk7XG4gICAgfVxuICB9KTtcbiAgLy8gUHJldmlld3MgZm9sbG93IHRoZSBtb3VzZSBvbmx5ICh0b3VjaCBzY3JlZW5zIGhhdmUgbm8gaG92ZXIpXG4gIGNvbnRlbnQuYWRkRXZlbnRMaXN0ZW5lcihcIm1vdXNlb3ZlclwiLCAoZSkgPT4ge1xuICAgIGlmIChpc1RvdWNoRGV2aWNlKCkpIHJldHVybjtcbiAgICBjb25zdCBjYXJkID0gKGUudGFyZ2V0IGFzIEVsZW1lbnQpLmNsb3Nlc3Q8SFRNTEVsZW1lbnQ+KFwiLnNiLW1pbmktY2FyZFtkYXRhLXByZXZpZXddXCIpO1xuICAgIGlmIChjYXJkKSBzdGFydE1pbmlQcmV2aWV3KGNhcmQpO1xuICB9KTtcbiAgY29udGVudC5hZGRFdmVudExpc3RlbmVyKFwibW91c2VvdXRcIiwgKGUpID0+IHtcbiAgICBjb25zdCBwbGF5aW5nID0gbWluaVByZXZpZXdDYXJkKCk7XG4gICAgaWYgKHBsYXlpbmcgJiYgY29udGVudC5jb250YWlucyhwbGF5aW5nKSAmJiAhcGxheWluZy5jb250YWlucyhlLnJlbGF0ZWRUYXJnZXQgYXMgTm9kZSB8IG51bGwpKSBzdG9wTWluaVByZXZpZXcoKTtcbiAgfSk7XG59XG5cbi8qKiBDaGlwcywgQ2xlYXIgZmlsdGVycywgcGFnZSBidXR0b25zLCDimpTvuI8gYW5kIGNhcmQgbGlua3MuICovXG5mdW5jdGlvbiBvbkNvbnRlbnRDbGljayhlOiBFdmVudCwgY29udGVudDogSFRNTEVsZW1lbnQsIHNjcm9sbFJvb3Q6IEhUTUxFbGVtZW50IHwgbnVsbCk6IHZvaWQge1xuICBjb25zdCB0YXJnZXQgPSBlLnRhcmdldCBhcyBFbGVtZW50O1xuICBjb25zdCBjaGlwID0gdGFyZ2V0LmNsb3Nlc3Q8SFRNTEVsZW1lbnQ+KFwiLnNiLWNoaXBcIik7XG4gIGlmIChjaGlwKSB7XG4gICAgZmlsdGVycy5ncm91cCA9IGNoaXAuZGF0YXNldC5ncm91cCB8fCBudWxsO1xuICAgIGNvbnRlbnQucXVlcnlTZWxlY3RvckFsbChcIi5zYi1jaGlwXCIpLmZvckVhY2goKGMpID0+IGMuY2xhc3NMaXN0LnRvZ2dsZShcImFjdGl2ZVwiLCBjID09PSBjaGlwKSk7XG4gICAgYXBwbHlGaWx0ZXJzKGNvbnRlbnQpO1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAodGFyZ2V0LmNsb3Nlc3QoXCJbZGF0YS1leHBsb3JlLWNsZWFyXVwiKSkge1xuICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICBmaWx0ZXJzID0geyAuLi5ERUZBVUxUX0VYUExPUkVfRklMVEVSUywgc29ydDogZmlsdGVycy5zb3J0IH07XG4gICAgcmVuZGVyKGNvbnRlbnQsIHNjcm9sbFJvb3QpO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBzdGVwID0gdGFyZ2V0LmNsb3Nlc3Q8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiW2RhdGEtcGFnZS1zdGVwXVwiKTtcbiAgaWYgKHN0ZXApIHtcbiAgICBnb1RvUGFnZShjb250ZW50LCBzY3JvbGxSb290LCBwYWdlICsgTnVtYmVyKHN0ZXAuZGF0YXNldC5wYWdlU3RlcCkpO1xuICAgIHJldHVybjtcbiAgfVxuICAvLyBKdXN0IGFmdGVyIGEgcGFnZSBjaGFuZ2UsIGEgY2xpY2sgb24gYSBjYXJkIGlzIG1vc3QgbGlrZWx5IGEgZG91YmxlIGNsaWNrIG9uIE5leHRcbiAgaWYgKERhdGUubm93KCkgPCBpZ25vcmVDYXJkQ2xpY2tzVW50aWwgJiYgdGFyZ2V0LmNsb3Nlc3QoXCIuc2ItbWluaS1jYXJkXCIpKSB7XG4gICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIHJldHVybjtcbiAgfVxuICBpZiAodGFyZ2V0LmNsb3Nlc3QoXCJbZGF0YS1leHBsb3JlLWJhdHRsZV1cIikpIHtcbiAgICBzdG9wTWluaVByZXZpZXcoKTtcbiAgICBhY3Rpb25zPy5iYXR0bGVGaWx0ZXIoZmlsdGVycywgZmlsdGVyTGFiZWwoKSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGlmIChoYW5kbGVNaW5pTXV0ZVRhcChlKSB8fCBoYW5kbGVNaW5pVGh1bWJUYXAoZSkpIHJldHVybjtcbiAgY29uc3QgYmF0dGxlID0gdGFyZ2V0LmNsb3Nlc3Q8SFRNTEVsZW1lbnQ+KFwiW2RhdGEtYmF0dGxlXVwiKTtcbiAgaWYgKGJhdHRsZT8uZGF0YXNldC5iYXR0bGUpIHtcbiAgICBzdG9wTWluaVByZXZpZXcoKTtcbiAgICBhY3Rpb25zPy5iYXR0bGVTY2VuZShiYXR0bGUuZGF0YXNldC5iYXR0bGUpO1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBsaW5rID0gdGFyZ2V0LmNsb3Nlc3Q8SFRNTEFuY2hvckVsZW1lbnQ+KFwiLnNiLW1pbmktbGlua1wiKTtcbiAgaWYgKGxpbmspIHtcbiAgICBzdG9wTWluaVByZXZpZXcoKTtcbiAgICBoYW5kbGVTY2VuZUxpbmtDbGljayhlIGFzIE1vdXNlRXZlbnQsIGxpbmspO1xuICB9XG59XG5cbmZ1bmN0aW9uIHJlbmRlcihjb250ZW50OiBIVE1MRWxlbWVudCwgc2Nyb2xsUm9vdDogSFRNTEVsZW1lbnQgfCBudWxsKTogdm9pZCB7XG4gIGNvbnRlbnQuaW5uZXJIVE1MID0gY29udHJvbHNIdG1sKCk7XG4gIGJpbmRDb250cm9scyhjb250ZW50LCBzY3JvbGxSb290KTtcbiAgLy8gUmVvcGVuaW5nIEV4cGxvcmUgKGJhY2sgZnJvbSBhIHNjZW5lIHBhZ2UsIHNheSkgc3RheXMgb24gdGhlIHNhbWUgcGFnZTsgc2hvd1BhZ2UgY2xhbXBzIGl0XG4gIGFwcGx5RmlsdGVycyhjb250ZW50LCB0cnVlKTtcbn1cblxuXG4vKiogRmlsbCB0aGUgRXhwbG9yZSB0YWIgZnJvbSB0aGUgYWxsLXNjZW5lcyBjYWNoZSAoY2FsbCBlYWNoIHRpbWUgdGhlIHRhYiBvcGVucykuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVuZGVyRXhwbG9yZVRhYihtb2RhbDogSFRNTEVsZW1lbnQsIHRhYkFjdGlvbnM6IFN0YXRzQWN0aW9ucyk6IFByb21pc2U8dm9pZD4ge1xuICBhY3Rpb25zID0gdGFiQWN0aW9ucztcbiAgY29uc3QgY29udGVudCA9IG1vZGFsLnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiI3NiLWV4cGxvcmUtY29udGVudFwiKTtcbiAgaWYgKCFjb250ZW50KSByZXR1cm47XG4gIGlmIChpc0Vsb1NldHVwUGVuZGluZygpKSB7XG4gICAgY29udGVudC5pbm5lckhUTUwgPSBgPHAgY2xhc3M9XCJzYi1zdGF0cy1lbXB0eVwiPkV4cGxvcmUgb3BlbnMgb25jZSB0aGUgRUxPIHNldHVwIG9uIHRoZSBCYXR0bGUgdGFiIGlzIGRvbmUuPC9wPmA7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnRlbnQuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9XCJzYi1sb2FkaW5nXCI+TG9hZGluZyBzY2VuZXMuLi48L2Rpdj5gO1xuICBsZXQgc2NlbmVzO1xuICB0cnkge1xuICAgIHNjZW5lcyA9IChhd2FpdCBnZXRBbGxTY2VuZXNDYWNoZWQoKSkuc2NlbmVzID8/IFtdO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIENvdWxkbid0IGxvYWQgc2NlbmVzIGZvciBFeHBsb3JlOlwiLCBlKTtcbiAgICBjb250ZW50LmlubmVySFRNTCA9IGA8cCBjbGFzcz1cInNiLXN0YXRzLWVtcHR5XCI+Q291bGRuJ3QgbG9hZCB5b3VyIHNjZW5lcy4gU3dpdGNoIHRhYnMgdG8gdHJ5IGFnYWluLjwvcD5gO1xuICAgIHJldHVybjtcbiAgfVxuICBlbnRyaWVzID0gZXhwbG9yZUVudHJpZXMoc2NlbmVzLCB0aWVyTWFwKHNjZW5lcyksIHJlc29sdmVTY2VuZVRpdGxlKTtcbiAgcmVuZGVyKGNvbnRlbnQsIG1vZGFsLnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiLnNiLW1vZGFsLWNvbnRlbnRcIikpO1xufVxuIiwgIi8vIFRoZSDwn4+GIFJlY29yZHMgdGFiOiB0aGUgaGFsbCBvZiBmYW1lIChldmVyeSBzY2VuZSB0aGF0IGhhcyBiZWVuICMxLCBuZXdlc3QgZmlyc3QpLCBhbmQgdGhlXHJcbi8vIGxvbmdlc3Qgd2luIHN0cmVha3MgYW5kIGhpZ2hlc3QgcGVhayBFTE9zLCBhcyBzbWFsbCBjYXJkcy4gQnVpbHQgZnJvbSBTdGFzaCBCYXR0bGUnc1xyXG4vLyBhbGwtc2NlbmVzIGNhY2hlIGVhY2ggdGltZSB0aGUgdGFiIG9wZW5zLiBDYXJkcyBvcGVuIHRoZSBzY2VuZSdzIHBhZ2UsIHRoZWlyIOKalO+4jyBiYXR0bGVzIGl0LCBhbmRcclxuLy8gaG92ZXJpbmcgKG9uIHRvdWNoLCB0YXBwaW5nIHRoZSB0aHVtYm5haWwpIHBsYXlzIHRoZSBwcmV2aWV3LCBhcyBvbiBFeHBsb3JlLlxyXG5cclxuaW1wb3J0IHsgZ2V0QWxsU2NlbmVzQ2FjaGVkIH0gZnJvbSBcIi4uL2NhY2hlXCI7XHJcbmltcG9ydCB7IGV4cGxvcmVFbnRyaWVzLCB0eXBlIEV4cGxvcmVFbnRyeSB9IGZyb20gXCIuLi9leHBsb3JlXCI7XHJcbmltcG9ydCB7IG5vdGVUb3BTY2VuZSB9IGZyb20gXCIuLi9yYXRpbmdcIjtcclxuaW1wb3J0IHsgcmVzb2x2ZVNjZW5lVGl0bGUgfSBmcm9tIFwiLi4vc2NlbmVUaXRsZVwiO1xyXG5pbXBvcnQgeyBnZXRIYWxsT2ZGYW1lIH0gZnJvbSBcIi4uL3NldHRpbmdzXCI7XHJcbmltcG9ydCB7IGlzRWxvU2V0dXBQZW5kaW5nIH0gZnJvbSBcIi4uL3N0YXRlXCI7XHJcbmltcG9ydCB7IGNhY2hlZFRpZXJNYXAsIHRvcEJ5UmVjb3JkIH0gZnJvbSBcIi4uL3N0YXRzXCI7XHJcbmltcG9ydCB0eXBlIHsgU2NlbmUgfSBmcm9tIFwiLi4vdHlwZXNcIjtcclxuaW1wb3J0IHsgaGFuZGxlU2NlbmVMaW5rQ2xpY2ssIGlzVG91Y2hEZXZpY2UgfSBmcm9tIFwiLi9tYWluVUlcIjtcclxuaW1wb3J0IHsgaGFuZGxlTWluaU11dGVUYXAsIGhhbmRsZU1pbmlUaHVtYlRhcCwgbWluaUNhcmRIdG1sLCBtaW5pUHJldmlld0NhcmQsIHBsdXJhbCwgc3RhcnRNaW5pUHJldmlldywgc3RvcE1pbmlQcmV2aWV3IH0gZnJvbSBcIi4vbWluaUNhcmRcIjtcclxuXHJcbi8qKiBTY2VuZXMgbGlzdGVkIGluIHRoZSBzdHJlYWsgYW5kIHBlYWsgcm93cy4gKi9cclxuY29uc3QgUkVDT1JEU19UT1AgPSA1O1xyXG4vKiogSGFsbCBvZiBmYW1lIGNhcmRzIHNob3duIGJlZm9yZSBcIlNob3cgYWxsIChOKVwiICh0aGUgc3RvcmVkIGxpc3QgaXRzZWxmIGlzbid0IGNhcHBlZCkuICovXHJcbmNvbnN0IEhBTExfT0ZfRkFNRV9TSE9XTiA9IDEwO1xyXG5cclxubGV0IGVudHJpZXNCeUlkID0gbmV3IE1hcDxzdHJpbmcsIEV4cGxvcmVFbnRyeT4oKTtcclxubGV0IGJhdHRsZVNjZW5lOiAoc2NlbmVJZDogc3RyaW5nKSA9PiB2b2lkID0gKCkgPT4ge307XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlUmVjb3Jkc1RhYigpOiBzdHJpbmcge1xyXG4gIHJldHVybiBgXHJcbiAgICAgIDxkaXYgY2xhc3M9XCJzYi10YWItcGFuZWwgc2ItcmVjb3Jkcy10YWJcIiBkYXRhLXBhbmVsPVwicmVjb3Jkc1wiIGhpZGRlbj5cclxuICAgICAgICA8ZGl2IGlkPVwic2ItcmVjb3Jkcy1jb250ZW50XCI+PC9kaXY+XHJcbiAgICAgIDwvZGl2PlxyXG4gICAgYDtcclxufVxyXG5cclxuZnVuY3Rpb24gc2hvcnREYXRlKGlzbzogc3RyaW5nKTogc3RyaW5nIHtcclxuICBjb25zdCBkYXRlID0gbmV3IERhdGUoaXNvKTtcclxuICByZXR1cm4gTnVtYmVyLmlzTmFOKGRhdGUuZ2V0VGltZSgpKSA/IFwiXCIgOiBkYXRlLnRvTG9jYWxlRGF0ZVN0cmluZyh1bmRlZmluZWQsIHsgeWVhcjogXCJudW1lcmljXCIsIG1vbnRoOiBcInNob3J0XCIsIGRheTogXCJudW1lcmljXCIgfSk7XHJcbn1cclxuXHJcbi8qKiBUaGUgZnVsbCBkYXRlIGFuZCB0aW1lLCBmb3IgdGhlIGNhcHRpb24ncyB0b29sdGlwLiAqL1xyXG5mdW5jdGlvbiBmdWxsRGF0ZShpc286IHN0cmluZyk6IHN0cmluZyB7XHJcbiAgY29uc3QgZGF0ZSA9IG5ldyBEYXRlKGlzbyk7XHJcbiAgcmV0dXJuIE51bWJlci5pc05hTihkYXRlLmdldFRpbWUoKSkgPyBcIlwiIDogZGF0ZS50b0xvY2FsZVN0cmluZyh1bmRlZmluZWQsIHsgZGF0ZVN0eWxlOiBcIm1lZGl1bVwiLCB0aW1lU3R5bGU6IFwic2hvcnRcIiB9KTtcclxufVxyXG5cclxuLyoqXHJcbiAqIEEgcm93IG9mIHNtYWxsIGNhcmRzLCBlYWNoIHdpdGggYSBjYXB0aW9uIGFib3ZlIGl0IChcIiMxIHNpbmNlIE9jdCAyNCwgMjAyNlwiKS4gV2l0aCBgc2hvd25gLCB0aGVcclxuICogY2FyZHMgcGFzdCBpdCBzdGFydCBoaWRkZW4gYmVoaW5kIGEgXCJTaG93IGFsbCAoTilcIiBsaW5rLlxyXG4gKi9cclxuZnVuY3Rpb24gcmVjb3JkUm93KHRpdGxlOiBzdHJpbmcsIGl0ZW1zOiB7IHNjZW5lOiBTY2VuZTsgY2FwdGlvbjogc3RyaW5nOyB0aXA/OiBzdHJpbmcgfVtdLCBlbXB0eTogc3RyaW5nLCBzaG93biA9IEluZmluaXR5KTogc3RyaW5nIHtcclxuICBjb25zdCBjYXJkcyA9IGl0ZW1zXHJcbiAgICAuZmlsdGVyKCh7IHNjZW5lIH0pID0+IGVudHJpZXNCeUlkLmhhcyhzY2VuZS5pZCkpXHJcbiAgICAubWFwKCh7IHNjZW5lLCBjYXB0aW9uLCB0aXAgfSwgaSkgPT4ge1xyXG4gICAgICBjb25zdCBleHRyYSA9IGkgPj0gc2hvd24gPyBcIiBzYi1yZWNvcmQtZXh0cmFcIiA6IFwiXCI7XHJcbiAgICAgIHJldHVybiBgPGRpdiBjbGFzcz1cInNiLXJlY29yZC1pdGVtJHtleHRyYX1cIiR7ZXh0cmEgPyBcIiBoaWRkZW5cIiA6IFwiXCJ9PjxkaXYgY2xhc3M9XCJzYi1yZWNvcmQtY2FwdGlvblwiJHt0aXAgPyBgIHRpdGxlPVwiJHt0aXB9XCJgIDogXCJcIn0+JHtjYXB0aW9ufTwvZGl2PiR7bWluaUNhcmRIdG1sKGVudHJpZXNCeUlkLmdldChzY2VuZS5pZCkgYXMgRXhwbG9yZUVudHJ5KX08L2Rpdj5gO1xyXG4gICAgfSk7XHJcbiAgY29uc3QgbW9yZSA9IGNhcmRzLmxlbmd0aCA+IHNob3duID8gYCA8YSBocmVmPVwiI1wiIGNsYXNzPVwic2ItcmVjb3JkLW1vcmVcIiBkYXRhLXJlY29yZHMtbW9yZT5TaG93IGFsbCAoJHtjYXJkcy5sZW5ndGh9KTwvYT5gIDogXCJcIjtcclxuICByZXR1cm4gYFxyXG4gICAgICAgIDxkaXYgY2xhc3M9XCJzZXR0aW5nLXNlY3Rpb24gc2Itc3RhdHMtc2VjdGlvblwiPlxyXG4gICAgICAgICAgPGgxPiR7dGl0bGV9JHttb3JlfTwvaDE+XHJcbiAgICAgICAgICA8ZGl2IGNsYXNzPVwiY2FyZFwiPlxyXG4gICAgICAgICAgICAke2NhcmRzLmxlbmd0aCA/IGA8ZGl2IGNsYXNzPVwic2ItcmVjb3JkLWNhcmRzXCI+JHtjYXJkcy5qb2luKFwiXCIpfTwvZGl2PmAgOiBgPHAgY2xhc3M9XCJzYi1zdGF0cy1tdXRlZFwiPiR7ZW1wdHl9PC9wPmB9XHJcbiAgICAgICAgICA8L2Rpdj5cclxuICAgICAgICA8L2Rpdj5gO1xyXG59XHJcblxyXG4vKiogSGFsbCBvZiBmYW1lIChuZXdlc3QgIzEgZmlyc3QpLCBhbmQgdGhlIHRvcCBzY2VuZXMgYnkgYmVzdCB3aW4gc3RyZWFrIGFuZCBieSBwZWFrIEVMTy4gKi9cclxuZnVuY3Rpb24gcmVjb3Jkc0h0bWwoc2NlbmVzOiBTY2VuZVtdKTogc3RyaW5nIHtcclxuICBjb25zdCBieUlkID0gbmV3IE1hcChzY2VuZXMubWFwKChzKSA9PiBbcy5pZCwgc10pKTtcclxuICAvLyBOZXdlc3QgZmlyc3QsIGJ5IHRoZSB0aW1lIGVhY2ggcmVhY2hlZCAjMSAoc2V2ZXJhbCBjYW4gb24gdGhlIHNhbWUgZGF5KVxyXG4gIGNvbnN0IGhhbGwgPSBbLi4uZ2V0SGFsbE9mRmFtZSgpXVxyXG4gICAgLnNvcnQoKGEsIGIpID0+IERhdGUucGFyc2UoYi5kYXRlKSAtIERhdGUucGFyc2UoYS5kYXRlKSlcclxuICAgIC5tYXAoKGUpID0+ICh7IHNjZW5lOiBieUlkLmdldChlLmlkKSwgZGF0ZTogZS5kYXRlIH0pKVxyXG4gICAgLmZpbHRlcigoZSk6IGUgaXMgeyBzY2VuZTogU2NlbmU7IGRhdGU6IHN0cmluZyB9ID0+IGUuc2NlbmUgIT09IHVuZGVmaW5lZClcclxuICAgIC5tYXAoKHsgc2NlbmUsIGRhdGUgfSkgPT4gKHsgc2NlbmUsIGNhcHRpb246IGDwn5GRICMxIHNpbmNlICR7c2hvcnREYXRlKGRhdGUpfWAsIHRpcDogYEZpcnN0IHJlYWNoZWQgIzEgb24gJHtmdWxsRGF0ZShkYXRlKX1gIH0pKTtcclxuICBjb25zdCBzdHJlYWtzID0gdG9wQnlSZWNvcmQoc2NlbmVzLCAocikgPT4gci5iZXN0U3RyZWFrLCBSRUNPUkRTX1RPUCkubWFwKCh7IHNjZW5lLCByZWNvcmQgfSkgPT4gKHtcclxuICAgIHNjZW5lLFxyXG4gICAgY2FwdGlvbjogYPCflKUgJHtwbHVyYWwocmVjb3JkLmJlc3RTdHJlYWssIFwid2luXCIpfSBpbiBhIHJvd2AsXHJcbiAgfSkpO1xyXG4gIGNvbnN0IHBlYWtzID0gdG9wQnlSZWNvcmQoc2NlbmVzLCAocikgPT4gci5wZWFrLCBSRUNPUkRTX1RPUCkubWFwKCh7IHNjZW5lLCByZWNvcmQgfSkgPT4gKHtcclxuICAgIHNjZW5lLFxyXG4gICAgY2FwdGlvbjogYPCfk4ggUGVhayBFTE8gJHtNYXRoLnJvdW5kKHJlY29yZC5wZWFrKX1gLFxyXG4gIH0pKTtcclxuICByZXR1cm4gYFxyXG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi1yZWNvcmRzXCI+XHJcbiAgICAgICAgICAke3JlY29yZFJvdyhcIvCfkZEgSGFsbCBvZiBmYW1lXCIsIGhhbGwsIFwiTm8gc2NlbmUgaGFzIGJlZW4gIzEgeWV0LlwiLCBIQUxMX09GX0ZBTUVfU0hPV04pfVxyXG4gICAgICAgICAgJHtyZWNvcmRSb3coXCLwn5SlIExvbmdlc3Qgd2luIHN0cmVha3NcIiwgc3RyZWFrcywgXCJObyB3aW4gc3RyZWFrcyB5ZXQ6IHJlY29yZHMgc3RhcnQgY291bnRpbmcgd2l0aCB5b3VyIG5leHQgYmF0dGxlLlwiKX1cclxuICAgICAgICAgICR7cmVjb3JkUm93KFwi8J+TiCBIaWdoZXN0IHBlYWsgRUxPXCIsIHBlYWtzLCBcIk5vIHBlYWtzIHlldDogcmVjb3JkcyBzdGFydCBjb3VudGluZyB3aXRoIHlvdXIgbmV4dCBiYXR0bGUuXCIpfVxyXG4gICAgICAgICAgPHAgY2xhc3M9XCJzYi1zdGF0cy1ub3RlXCI+UmVjb3JkcyBjb3VudCBiYXR0bGVzIHNpbmNlIHRoZXkgYmVnYW47IGVhcmxpZXIgYmF0dGxlcyBvbmx5IGFkZCB0byBhIHNjZW5lJ3MgYmF0dGxlIGNvdW50LjwvcD5cclxuICAgICAgICA8L2Rpdj5gO1xyXG59XHJcblxyXG4vKiogQ2FyZHM6IOKalO+4jyBiYXR0bGVzIHRoZSBzY2VuZSwgdGhlIHJlc3Qgb3BlbnMgaXRzIHBhZ2U7IFwiU2hvdyBhbGxcIiByZXZlYWxzIHRoZSBoaWRkZW4gY2FyZHMuICovXHJcbmZ1bmN0aW9uIG9uQ2xpY2soZTogTW91c2VFdmVudCk6IHZvaWQge1xyXG4gIGNvbnN0IHRhcmdldCA9IGUudGFyZ2V0IGFzIEVsZW1lbnQ7XHJcbiAgY29uc3QgbW9yZSA9IHRhcmdldC5jbG9zZXN0PEhUTUxFbGVtZW50PihcIltkYXRhLXJlY29yZHMtbW9yZV1cIik7XHJcbiAgaWYgKG1vcmUpIHtcclxuICAgIGUucHJldmVudERlZmF1bHQoKTtcclxuICAgIG1vcmUuY2xvc2VzdChcIi5zYi1zdGF0cy1zZWN0aW9uXCIpPy5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PihcIi5zYi1yZWNvcmQtZXh0cmFcIikuZm9yRWFjaCgoY2FyZCkgPT4gKGNhcmQuaGlkZGVuID0gZmFsc2UpKTtcclxuICAgIG1vcmUucmVtb3ZlKCk7XHJcbiAgICByZXR1cm47XHJcbiAgfVxyXG4gIGlmIChoYW5kbGVNaW5pTXV0ZVRhcChlKSB8fCBoYW5kbGVNaW5pVGh1bWJUYXAoZSkpIHJldHVybjtcclxuICBjb25zdCBiYXR0bGUgPSB0YXJnZXQuY2xvc2VzdDxIVE1MRWxlbWVudD4oXCJbZGF0YS1iYXR0bGVdXCIpO1xyXG4gIGlmIChiYXR0bGU/LmRhdGFzZXQuYmF0dGxlKSB7XHJcbiAgICBzdG9wTWluaVByZXZpZXcoKTtcclxuICAgIGJhdHRsZVNjZW5lKGJhdHRsZS5kYXRhc2V0LmJhdHRsZSk7XHJcbiAgICByZXR1cm47XHJcbiAgfVxyXG4gIGNvbnN0IGxpbmsgPSB0YXJnZXQuY2xvc2VzdDxIVE1MQW5jaG9yRWxlbWVudD4oXCIuc2ItbWluaS1saW5rXCIpO1xyXG4gIGlmIChsaW5rKSB7XHJcbiAgICBzdG9wTWluaVByZXZpZXcoKTtcclxuICAgIGhhbmRsZVNjZW5lTGlua0NsaWNrKGUsIGxpbmspO1xyXG4gIH1cclxufVxyXG5cclxuLyoqIFRoZSBjb250ZW50IGVsZW1lbnQgb3V0bGl2ZXMgZWFjaCByZW5kZXIsIHNvIGl0cyBoYW5kbGVycyBhcmUgYm91bmQgb25jZS4gKi9cclxuZnVuY3Rpb24gYmluZEV2ZW50cyhjb250ZW50OiBIVE1MRWxlbWVudCk6IHZvaWQge1xyXG4gIGlmIChjb250ZW50LmRhdGFzZXQuYm91bmQgPT09IFwiMVwiKSByZXR1cm47XHJcbiAgY29udGVudC5kYXRhc2V0LmJvdW5kID0gXCIxXCI7XHJcbiAgY29udGVudC5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgb25DbGljayk7XHJcbiAgLy8gUHJldmlld3MgcGxheSBvbiBob3ZlciwgYXMgb24gRXhwbG9yZSAodG91Y2ggc2NyZWVucyBoYXZlIG5vIGhvdmVyKVxyXG4gIGNvbnRlbnQuYWRkRXZlbnRMaXN0ZW5lcihcIm1vdXNlb3ZlclwiLCAoZSkgPT4ge1xyXG4gICAgaWYgKGlzVG91Y2hEZXZpY2UoKSkgcmV0dXJuO1xyXG4gICAgY29uc3QgY2FyZCA9IChlLnRhcmdldCBhcyBFbGVtZW50KS5jbG9zZXN0PEhUTUxFbGVtZW50PihcIi5zYi1taW5pLWNhcmRbZGF0YS1wcmV2aWV3XVwiKTtcclxuICAgIGlmIChjYXJkKSBzdGFydE1pbmlQcmV2aWV3KGNhcmQpO1xyXG4gIH0pO1xyXG4gIGNvbnRlbnQuYWRkRXZlbnRMaXN0ZW5lcihcIm1vdXNlb3V0XCIsIChlKSA9PiB7XHJcbiAgICBjb25zdCBwbGF5aW5nID0gbWluaVByZXZpZXdDYXJkKCk7XHJcbiAgICBpZiAocGxheWluZyAmJiBjb250ZW50LmNvbnRhaW5zKHBsYXlpbmcpICYmICFwbGF5aW5nLmNvbnRhaW5zKGUucmVsYXRlZFRhcmdldCBhcyBOb2RlIHwgbnVsbCkpIHN0b3BNaW5pUHJldmlldygpO1xyXG4gIH0pO1xyXG59XHJcblxyXG4vKiogRmlsbCB0aGUgUmVjb3JkcyB0YWIgZnJvbSB0aGUgYWxsLXNjZW5lcyBjYWNoZSAoY2FsbCBlYWNoIHRpbWUgdGhlIHRhYiBvcGVucykuICovXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZW5kZXJSZWNvcmRzVGFiKG1vZGFsOiBIVE1MRWxlbWVudCwgb25CYXR0bGVTY2VuZTogKHNjZW5lSWQ6IHN0cmluZykgPT4gdm9pZCk6IFByb21pc2U8dm9pZD4ge1xyXG4gIGJhdHRsZVNjZW5lID0gb25CYXR0bGVTY2VuZTtcclxuICBjb25zdCBjb250ZW50ID0gbW9kYWwucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCIjc2ItcmVjb3Jkcy1jb250ZW50XCIpO1xyXG4gIGlmICghY29udGVudCkgcmV0dXJuO1xyXG4gIGlmIChpc0Vsb1NldHVwUGVuZGluZygpKSB7XHJcbiAgICBjb250ZW50LmlubmVySFRNTCA9IGA8cCBjbGFzcz1cInNiLXN0YXRzLWVtcHR5XCI+UmVjb3JkcyBzaG93IG9uY2UgdGhlIEVMTyBzZXR1cCBvbiB0aGUgQmF0dGxlIHRhYiBpcyBkb25lLjwvcD5gO1xyXG4gICAgcmV0dXJuO1xyXG4gIH1cclxuICBpZiAoIWNvbnRlbnQucXVlcnlTZWxlY3RvcihcIi5zYi1yZWNvcmRzXCIpKSBjb250ZW50LmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPVwic2ItbG9hZGluZ1wiPkxvYWRpbmcgcmVjb3Jkcy4uLjwvZGl2PmA7XHJcbiAgbGV0IHNjZW5lczogU2NlbmVbXTtcclxuICB0cnkge1xyXG4gICAgc2NlbmVzID0gKGF3YWl0IGdldEFsbFNjZW5lc0NhY2hlZCgpKS5zY2VuZXMgPz8gW107XHJcbiAgfSBjYXRjaCAoZSkge1xyXG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIENvdWxkbid0IGxvYWQgc2NlbmVzIGZvciByZWNvcmRzOlwiLCBlKTtcclxuICAgIGNvbnRlbnQuaW5uZXJIVE1MID0gYDxwIGNsYXNzPVwic2Itc3RhdHMtZW1wdHlcIj5Db3VsZG4ndCBsb2FkIHlvdXIgc2NlbmVzLiBTd2l0Y2ggdGFicyB0byB0cnkgYWdhaW4uPC9wPmA7XHJcbiAgICByZXR1cm47XHJcbiAgfVxyXG4gIC8vIFRoZSBjdXJyZW50ICMxIGpvaW5zIHRoZSBoYWxsIG9mIGZhbWUgaWYgaXQgaXNuJ3QgdGhlcmUgeWV0IChhcyBhZnRlciBhIGJhdHRsZSlcclxuICBub3RlVG9wU2NlbmUoKTtcclxuICBlbnRyaWVzQnlJZCA9IG5ldyBNYXAoZXhwbG9yZUVudHJpZXMoc2NlbmVzLCBjYWNoZWRUaWVyTWFwKHNjZW5lcyksIHJlc29sdmVTY2VuZVRpdGxlKS5tYXAoKGVudHJ5KSA9PiBbZW50cnkuc2NlbmUuaWQsIGVudHJ5XSkpO1xyXG4gIGNvbnRlbnQuaW5uZXJIVE1MID0gcmVjb3Jkc0h0bWwoc2NlbmVzKTtcclxuICBiaW5kRXZlbnRzKGNvbnRlbnQpO1xyXG59XHJcbiIsICIvLyBUaGUg8J+TiiBTdGF0cyB0YWI6IG92ZXJ2aWV3IG51bWJlcnMsIHRoZSBFTE8gZGlzdHJpYnV0aW9uICh3aXRoIHRoZSBTdGFzaCByYXRpbmcgc2NhbGUgdW5kZXIgaXQpLFxyXG4vLyBoaWRkZW4gZ2VtcyAvIG92ZXJwbGF5ZWQsIGFuZCBob3cgc2V0dGxlZCB0aGUgcmFua2luZ3MgYXJlLiBXb3JrZWQgb3V0IGZyb20gU3Rhc2ggQmF0dGxlJ3NcclxuLy8gYWxsLXNjZW5lcyBjYWNoZSBlYWNoIHRpbWUgdGhlIHRhYiBvcGVuczsgbm8gZXh0cmEgcmVxdWVzdHMuIENoYXJ0cyBhcmUgaGFuZC1kcmF3biBTVkcgc2l6ZWQgdG9cclxuLy8gdGhlIHBhbmVsIChyZWRyYXduIHdoZW4gdGhlIHdpbmRvdyByZXNpemVzKS4gQ2xpY2tpbmcgYSBoaXN0b2dyYW0gYmFyIG9wZW5zIEV4cGxvcmUgYXQgaXRzIEVMT1xyXG4vLyByYW5nZTsgaG92ZXJpbmcgYSBoaWRkZW4gZ2VtcyBkb3Qgc2hvd3MgdGhlIHNjZW5lJ3Mgc21hbGwgY2FyZCwgYW5kIGNsaWNraW5nIG9wZW5zIGl0cyBwYWdlLlxyXG5cclxuaW1wb3J0IHsgZ2V0QWxsU2NlbmVzQ2FjaGVkIH0gZnJvbSBcIi4uL2NhY2hlXCI7XHJcbmltcG9ydCB7IEVMT19LX1RJRVJTIH0gZnJvbSBcIi4uL2NvbnN0YW50c1wiO1xyXG5pbXBvcnQgeyBleHBsb3JlRW50cmllcywgdHlwZSBFeHBsb3JlRW50cnksIHR5cGUgRXhwbG9yZUZpbHRlcnMgfSBmcm9tIFwiLi4vZXhwbG9yZVwiO1xyXG5pbXBvcnQgeyBuYXZpZ2F0ZVRvVXJsIH0gZnJvbSBcIi4uL25hdmlnYXRpb25cIjtcclxuaW1wb3J0IHsgbGVhc3RUZXN0ZWRTb3VyY2UgfSBmcm9tIFwiLi4vcGFpcnNcIjtcclxuaW1wb3J0IHsgZm9ybWF0UmF0aW5nLCBzY2FsZU1hcmtzIH0gZnJvbSBcIi4uL3JhdGluZ0Rpc3BsYXlcIjtcclxuaW1wb3J0IHsgZWxvIH0gZnJvbSBcIi4uL3Njb3JlXCI7XHJcbmltcG9ydCB7IGlzRWxvU2V0dXBQZW5kaW5nLCBzdGF0ZSB9IGZyb20gXCIuLi9zdGF0ZVwiO1xyXG5pbXBvcnQge1xyXG4gIGVsb0hpc3RvZ3JhbSxcclxuICBnZW1zU3BsaXQsXHJcbiAgbGFyZ2VzdFRpZSxcclxuICBsZWFzdFRlc3RlZFBvb2wsXHJcbiAgb3ZlcnZpZXcsXHJcbiAgcmF0aW5nU2NhbGVUaWNrcyxcclxuICBzZXR0bGVkQnVja2V0cyxcclxuICB0aWVyTWFwLFxyXG4gIHR5cGUgR2Vtc1NwbGl0LFxyXG59IGZyb20gXCIuLi9zdGF0c1wiO1xyXG5pbXBvcnQgdHlwZSB7IFNjZW5lIH0gZnJvbSBcIi4uL3R5cGVzXCI7XHJcbmltcG9ydCB7IGhhbmRsZVNjZW5lTGlua0NsaWNrLCBpc1RvdWNoRGV2aWNlIH0gZnJvbSBcIi4vbWFpblVJXCI7XHJcbmltcG9ydCB7IG1pbmlDYXJkSHRtbCwgcGx1cmFsLCBzY2VuZVVybCB9IGZyb20gXCIuL21pbmlDYXJkXCI7XHJcbmltcG9ydCB7IHJlc29sdmVTY2VuZVRpdGxlIH0gZnJvbSBcIi4uL3NjZW5lVGl0bGVcIjtcclxuaW1wb3J0IHsgc3Rhc2hSYXRpbmdzT3B0aW9uIH0gZnJvbSBcIi4vc3Rhc2hSYXRpbmdzVGV4dFwiO1xyXG5cclxuLyoqIFdoYXQgdGhlIHRhYidzIGJ1dHRvbnMgZG8gKHRoZSBtb2RhbCBvd25zIG1vZGVzLCB0YWJzIGFuZCBwYWlycykuICovXHJcbmV4cG9ydCBpbnRlcmZhY2UgU3RhdHNBY3Rpb25zIHtcclxuICBiYXR0bGVTY2VuZTogKHNjZW5lSWQ6IHN0cmluZykgPT4gdm9pZDtcclxuICBiYXR0bGVMZWFzdFRlc3RlZDogKCkgPT4gdm9pZDtcclxuICBleHBsb3JlUmFuZ2U6IChlbG9NaW46IG51bWJlciwgZWxvTWF4OiBudW1iZXIpID0+IHZvaWQ7XHJcbiAgLyoqIEJhdHRsZSBhbiBFeHBsb3JlIGZpbHRlcidzIHNjZW5lcyAoYGxhYmVsYCBuYW1lcyBpdCBpbiB0aGUgbm90ZSBhYm92ZSB0aGUgY2FyZHMpLiAqL1xyXG4gIGJhdHRsZUZpbHRlcjogKGZpbHRlcnM6IEV4cGxvcmVGaWx0ZXJzLCBsYWJlbDogc3RyaW5nKSA9PiB2b2lkO1xyXG59XHJcblxyXG4vKiogRUxPIHBlciBoaXN0b2dyYW0gYmFyOyBuYXJyb3cgc2NyZWVucyBnZXQgd2lkZXIgYmFycyAoZWFzaWVyIHRvIHRhcCkuICovXHJcbmNvbnN0IEJVQ0tFVF9TSVpFID0gMjU7XHJcbmNvbnN0IE5BUlJPV19CVUNLRVRfU0laRSA9IDUwO1xyXG5jb25zdCBOQVJST1dfQ0hBUlRfUFggPSA1MDA7XHJcbi8qKiBBIHRpZSBhdCBsZWFzdCB0aGlzIGJpZyBnZXRzIGEgbm90ZSB1bmRlciB0aGUgZGlzdHJpYnV0aW9uLiAqL1xyXG5jb25zdCBUSUVfTk9URV9NSU4gPSAxMDtcclxuLyoqIFBsYXkgY291bnRzIG1hcmtlZCBvbiB0aGUgaGlkZGVuIGdlbXMgY2hhcnQncyBzcXVhcmUtcm9vdCBheGlzICh0aG9zZSB1cCB0byB0aGUgbWF4aW11bSkuICovXHJcbmNvbnN0IFBMQVlfVElDS1MgPSBbMCwgMSwgMiwgNSwgMTAsIDIwLCA1MCwgMTAwLCAyMDAsIDUwMCwgMTAwMF07XHJcblxyXG5sZXQgc2NlbmVzOiBTY2VuZVtdID0gW107XHJcbi8qKiBTY2VuZSBpZCB0byBpdHMgc21hbGwtY2FyZCBlbnRyeSAocmFuaywgdGllciksIGZvciB0aGUgaG92ZXIgY2FyZHMuICovXHJcbmxldCBlbnRyaWVzQnlJZCA9IG5ldyBNYXA8c3RyaW5nLCBFeHBsb3JlRW50cnk+KCk7XHJcbmxldCBhY3Rpb25zOiBTdGF0c0FjdGlvbnMgfCBudWxsID0gbnVsbDtcclxubGV0IHJlc2l6ZUJvdW5kID0gZmFsc2U7XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlU3RhdHNUYWIoKTogc3RyaW5nIHtcclxuICByZXR1cm4gYFxyXG4gICAgICA8ZGl2IGNsYXNzPVwic2ItdGFiLXBhbmVsIHNiLXN0YXRzLXRhYlwiIGRhdGEtcGFuZWw9XCJzdGF0c1wiIGhpZGRlbj5cclxuICAgICAgICA8ZGl2IGlkPVwic2Itc3RhdHMtY29udGVudFwiPjwvZGl2PlxyXG4gICAgICA8L2Rpdj5cclxuICAgIGA7XHJcbn1cclxuXHJcbi8qKiAxLCAyIG9yIDUgdGltZXMgYSBwb3dlciBvZiB0ZW4sIGF0IGxlYXN0IGByb3VnaGAuICovXHJcbmZ1bmN0aW9uIG5pY2VTdGVwKHJvdWdoOiBudW1iZXIpOiBudW1iZXIge1xyXG4gIGNvbnN0IHBvd2VyID0gTWF0aC5wb3coMTAsIE1hdGguZmxvb3IoTWF0aC5sb2cxMChNYXRoLm1heChyb3VnaCwgMSkpKSk7XHJcbiAgZm9yIChjb25zdCBtIG9mIFsxLCAyLCA1LCAxMF0pIGlmIChtICogcG93ZXIgPj0gcm91Z2gpIHJldHVybiBtICogcG93ZXI7XHJcbiAgcmV0dXJuIDEwICogcG93ZXI7XHJcbn1cclxuXHJcbi8qKiBBIGJhciB3aXRoIHJvdW5kZWQgdG9wIGNvcm5lcnMsIGFuY2hvcmVkIHRvIHRoZSBiYXNlbGluZS4gKi9cclxuZnVuY3Rpb24gYmFyUGF0aCh4OiBudW1iZXIsIHk6IG51bWJlciwgdzogbnVtYmVyLCBoOiBudW1iZXIpOiBzdHJpbmcge1xyXG4gIGNvbnN0IHIgPSBNYXRoLm1pbigzLCB3IC8gMiwgaCk7XHJcbiAgcmV0dXJuIGBNJHt4fSwke3kgKyBofVYke3kgKyByfVEke3h9LCR7eX0gJHt4ICsgcn0sJHt5fUgke3ggKyB3IC0gcn1RJHt4ICsgd30sJHt5fSAke3ggKyB3fSwke3kgKyByfVYke3kgKyBofVpgO1xyXG59XHJcblxyXG5mdW5jdGlvbiBzZWN0aW9uKHRpdGxlOiBzdHJpbmcsIGJvZHk6IHN0cmluZywgaWQgPSBcIlwiKTogc3RyaW5nIHtcclxuICByZXR1cm4gYFxyXG4gICAgICAgIDxkaXYgY2xhc3M9XCJzZXR0aW5nLXNlY3Rpb24gc2Itc3RhdHMtc2VjdGlvblwiJHtpZCA/IGAgaWQ9XCIke2lkfVwiYCA6IFwiXCJ9PlxyXG4gICAgICAgICAgPGgxPiR7dGl0bGV9PC9oMT5cclxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJjYXJkXCI+JHtib2R5fTwvZGl2PlxyXG4gICAgICAgIDwvZGl2PmA7XHJcbn1cclxuXHJcbi8vIC0tLS0tLS0tLS0gT3ZlcnZpZXcgLS0tLS0tLS0tLVxyXG5cclxuZnVuY3Rpb24gb3ZlcnZpZXdIdG1sKCk6IHN0cmluZyB7XHJcbiAgY29uc3QgbyA9IG92ZXJ2aWV3KHNjZW5lcyk7XHJcbiAgY29uc3QgdGlsZSA9ICh2YWx1ZTogbnVtYmVyLCBsYWJlbDogc3RyaW5nLCB0aXA6IHN0cmluZyk6IHN0cmluZyA9PlxyXG4gICAgYDxkaXYgY2xhc3M9XCJzYi1zdGF0LXRpbGVcIiB0aXRsZT1cIiR7dGlwfVwiPjxkaXYgY2xhc3M9XCJzYi1zdGF0LXZhbHVlXCI+JHt2YWx1ZS50b0xvY2FsZVN0cmluZygpfTwvZGl2PjxkaXYgY2xhc3M9XCJzYi1zdGF0LWxhYmVsXCI+JHtsYWJlbH08L2Rpdj48L2Rpdj5gO1xyXG4gIHJldHVybiBgPGRpdiBjbGFzcz1cInNiLXN0YXQtdGlsZXNcIj5cclxuICAgICAgICAgICR7dGlsZShvLnJhdGVkLCBcIlNjZW5lcyB3aXRoIGFuIEVMT1wiLCBcIlNjZW5lcyBTdGFzaCBCYXR0bGUgaGFzIGFuIEVMTyBmb3JcIil9XHJcbiAgICAgICAgICAke3RpbGUoby51bnJhdGVkLCBcIlVucmF0ZWRcIiwgXCJTY2VuZXMgd2l0aCBubyBFTE8geWV0OiB0aGV5IGdldCBvbmUgYWZ0ZXIgdGhlaXIgZmlyc3QgYmF0dGxlLCBvciBmcm9tIFBsYWNlbWVudFwiKX1cclxuICAgICAgICAgICR7dGlsZShvLnByb3Zpc2lvbmFsLCBcIlByb3Zpc2lvbmFsXCIsIGBGZXdlciB0aGFuICR7RUxPX0tfVElFUlNbMF1bMF19IGJhdHRsZXMsIHNvIHRoZWlyIEVMTyBpcyBzdGlsbCBzZXR0bGluZyAoc2hvd24gd2l0aCBhIOKAnD/igJ0pYCl9XHJcbiAgICAgICAgICAke3RpbGUoby5iYXR0bGVzLCBcIkJhdHRsZXNcIiwgXCJFdmVyeSBzY2VuZSdzIGJhdHRsZSBjb3VudCBhZGRlZCB1cCwgc28gYSBiYXR0bGUgY291bnRzIG9uY2UgZm9yIGVhY2ggc2NlbmUgaW4gaXRcIil9XHJcbiAgICAgICAgPC9kaXY+YDtcclxufVxyXG5cclxuLy8gLS0tLS0tLS0tLSBFTE8gZGlzdHJpYnV0aW9uIC0tLS0tLS0tLS1cclxuXHJcbmZ1bmN0aW9uIGhpc3RvZ3JhbVN2Zyh3aWR0aDogbnVtYmVyKTogc3RyaW5nIHtcclxuICBjb25zdCBzaXplID0gd2lkdGggPCBOQVJST1dfQ0hBUlRfUFggPyBOQVJST1dfQlVDS0VUX1NJWkUgOiBCVUNLRVRfU0laRTtcclxuICBjb25zdCBidWNrZXRzID0gZWxvSGlzdG9ncmFtKHNjZW5lcywgc2l6ZSk7XHJcbiAgaWYgKGJ1Y2tldHMubGVuZ3RoID09PSAwKSByZXR1cm4gXCJcIjtcclxuICBjb25zdCBtb2RlID0gc3RhdGUuc2V0dGluZ3Muc3Rhc2hSYXRpbmdzO1xyXG4gIGNvbnN0IHRpY2tzID0gcmF0aW5nU2NhbGVUaWNrcyhzY2VuZXMsIG1vZGUsIHNjYWxlTWFya3MoKSk7XHJcblxyXG4gIGxldCBsbyA9IGJ1Y2tldHNbMF0uZnJvbTtcclxuICBsZXQgaGkgPSBidWNrZXRzW2J1Y2tldHMubGVuZ3RoIC0gMV0uZnJvbSArIHNpemU7XHJcbiAgZm9yIChjb25zdCB0IG9mIHRpY2tzKSB7XHJcbiAgICBsbyA9IE1hdGgubWluKGxvLCBNYXRoLmZsb29yKHQuZWxvIC8gc2l6ZSkgKiBzaXplKTtcclxuICAgIGhpID0gTWF0aC5tYXgoaGksIE1hdGguY2VpbCgodC5lbG8gKyAxKSAvIHNpemUpICogc2l6ZSk7XHJcbiAgfVxyXG5cclxuICBjb25zdCBtID0geyBsZWZ0OiA0MCwgcmlnaHQ6IDEyLCB0b3A6IDEwIH07XHJcbiAgY29uc3QgcGxvdFcgPSB3aWR0aCAtIG0ubGVmdCAtIG0ucmlnaHQ7XHJcbiAgY29uc3QgcGxvdEggPSB3aWR0aCA8IDUwMCA/IDEyMCA6IDE3MDtcclxuICBjb25zdCBheGlzSCA9IDIyO1xyXG4gIGNvbnN0IHNjYWxlSCA9IHRpY2tzLmxlbmd0aCA+IDAgPyA0NiA6IDA7XHJcbiAgY29uc3QgaGVpZ2h0ID0gbS50b3AgKyBwbG90SCArIGF4aXNIICsgc2NhbGVIO1xyXG4gIGNvbnN0IHggPSAodmFsdWU6IG51bWJlcik6IG51bWJlciA9PiBtLmxlZnQgKyAoKHZhbHVlIC0gbG8pIC8gKGhpIC0gbG8pKSAqIHBsb3RXO1xyXG4gIGNvbnN0IG1heENvdW50ID0gTWF0aC5tYXgoLi4uYnVja2V0cy5tYXAoKGIpID0+IGIuY291bnQpKTtcclxuICBjb25zdCBzdGVwID0gbmljZVN0ZXAobWF4Q291bnQgLyAzKTtcclxuICBjb25zdCB5TWF4ID0gTWF0aC5tYXgoc3RlcCwgTWF0aC5jZWlsKG1heENvdW50IC8gc3RlcCkgKiBzdGVwKTtcclxuICBjb25zdCB5ID0gKGNvdW50OiBudW1iZXIpOiBudW1iZXIgPT4gbS50b3AgKyBwbG90SCAtIChjb3VudCAvIHlNYXgpICogcGxvdEg7XHJcbiAgY29uc3QgYmFzZSA9IG0udG9wICsgcGxvdEg7XHJcblxyXG4gIGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtdO1xyXG5cclxuICAvLyBTdHJhaWdodC1saW5lIGNsYW1wczogZXZlcnl0aGluZyBiZWxvdyAxMDEwIGlzIGEgMSwgZXZlcnl0aGluZyBhYm92ZSAyMDAwIGEgMTAwXHJcbiAgaWYgKG1vZGUgPT09IFwibGluZWFyXCIgJiYgdGlja3MubGVuZ3RoID4gMCkge1xyXG4gICAgY29uc3QgZmlyc3QgPSB0aWNrc1swXTtcclxuICAgIGNvbnN0IGxhc3QgPSB0aWNrc1t0aWNrcy5sZW5ndGggLSAxXTtcclxuICAgIGlmIChsbyA8IGZpcnN0LmVsbykge1xyXG4gICAgICBwYXJ0cy5wdXNoKFxyXG4gICAgICAgIGA8cmVjdCBjbGFzcz1cInNiLWNoYXJ0LWNsYW1wXCIgeD1cIiR7eChsbyl9XCIgeT1cIiR7bS50b3B9XCIgd2lkdGg9XCIke3goZmlyc3QuZWxvKSAtIHgobG8pfVwiIGhlaWdodD1cIiR7cGxvdEh9XCIgZGF0YS10aXA9XCJCZWxvdyAke2ZpcnN0LmVsb30sIGV2ZXJ5IEVMTyBpcyBhIFN0YXNoIHJhdGluZyBvZiAke2Zvcm1hdFJhdGluZyhmaXJzdC5yYXRpbmcsIHRydWUpfVwiLz5gLFxyXG4gICAgICApO1xyXG4gICAgfVxyXG4gICAgaWYgKGhpID4gbGFzdC5lbG8pIHtcclxuICAgICAgcGFydHMucHVzaChcclxuICAgICAgICBgPHJlY3QgY2xhc3M9XCJzYi1jaGFydC1jbGFtcFwiIHg9XCIke3gobGFzdC5lbG8pfVwiIHk9XCIke20udG9wfVwiIHdpZHRoPVwiJHt4KGhpKSAtIHgobGFzdC5lbG8pfVwiIGhlaWdodD1cIiR7cGxvdEh9XCIgZGF0YS10aXA9XCJBYm92ZSAke2xhc3QuZWxvfSwgZXZlcnkgRUxPIGlzIGEgU3Rhc2ggcmF0aW5nIG9mICR7Zm9ybWF0UmF0aW5nKGxhc3QucmF0aW5nLCB0cnVlKX1cIi8+YCxcclxuICAgICAgKTtcclxuICAgIH1cclxuICB9XHJcblxyXG4gIGZvciAobGV0IHYgPSAwOyB2IDw9IHlNYXg7IHYgKz0gc3RlcCkge1xyXG4gICAgcGFydHMucHVzaChgPGxpbmUgY2xhc3M9XCJzYi1jaGFydC1ncmlkXCIgeDE9XCIke20ubGVmdH1cIiB4Mj1cIiR7d2lkdGggLSBtLnJpZ2h0fVwiIHkxPVwiJHt5KHYpfVwiIHkyPVwiJHt5KHYpfVwiLz5gKTtcclxuICAgIHBhcnRzLnB1c2goYDx0ZXh0IGNsYXNzPVwic2ItY2hhcnQtbGFiZWxcIiB4PVwiJHttLmxlZnQgLSA2fVwiIHk9XCIke3kodikgKyA0fVwiIHRleHQtYW5jaG9yPVwiZW5kXCI+JHt2fTwvdGV4dD5gKTtcclxuICB9XHJcblxyXG4gIGZvciAoY29uc3QgYiBvZiBidWNrZXRzKSB7XHJcbiAgICBjb25zdCB4MCA9IHgoYi5mcm9tKTtcclxuICAgIGNvbnN0IHcgPSB4KGIuZnJvbSArIHNpemUpIC0geDA7XHJcbiAgICBjb25zdCB0aXAgPSBgRUxPICR7Yi5mcm9tfeKAkyR7Yi5mcm9tICsgc2l6ZSAtIDF9OiAke3BsdXJhbChiLmNvdW50LCBcInNjZW5lXCIpfWA7XHJcbiAgICBjb25zdCBiYXIgPSBiLmNvdW50ID4gMCA/IGA8cGF0aCBjbGFzcz1cInNiLWNoYXJ0LWJhclwiIGQ9XCIke2JhclBhdGgoeDAgKyAxLCB5KGIuY291bnQpLCBNYXRoLm1heCgxLCB3IC0gMiksIGJhc2UgLSB5KGIuY291bnQpKX1cIi8+YCA6IFwiXCI7XHJcbiAgICBwYXJ0cy5wdXNoKGA8ZyBjbGFzcz1cInNiLWNoYXJ0LWhpdFwiIGRhdGEtdGlwPVwiJHt0aXB9JHtiLmNvdW50ID8gXCIgwrcgY2xpY2sgdG8gc2VlIHRoZW1cIiA6IFwiXCJ9XCIgZGF0YS1mcm9tPVwiJHtiLmZyb219XCIgZGF0YS10bz1cIiR7Yi5mcm9tICsgc2l6ZSAtIDAuMX1cIj48cmVjdCB4PVwiJHt4MH1cIiB5PVwiJHttLnRvcH1cIiB3aWR0aD1cIiR7d31cIiBoZWlnaHQ9XCIke3Bsb3RIfVwiIGZpbGw9XCJ0cmFuc3BhcmVudFwiLz4ke2Jhcn08L2c+YCk7XHJcbiAgfVxyXG4gIHBhcnRzLnB1c2goYDxsaW5lIGNsYXNzPVwic2ItY2hhcnQtYXhpc1wiIHgxPVwiJHttLmxlZnR9XCIgeDI9XCIke3dpZHRoIC0gbS5yaWdodH1cIiB5MT1cIiR7YmFzZX1cIiB5Mj1cIiR7YmFzZX1cIi8+YCk7XHJcblxyXG4gIGNvbnN0IGxhYmVsU3RlcCA9IHBsb3RXIC8gKChoaSAtIGxvKSAvIDEwMCkgPj0gNDQgPyAxMDAgOiAyMDA7XHJcbiAgZm9yIChsZXQgdiA9IE1hdGguY2VpbChsbyAvIGxhYmVsU3RlcCkgKiBsYWJlbFN0ZXA7IHYgPD0gaGk7IHYgKz0gbGFiZWxTdGVwKSB7XHJcbiAgICBwYXJ0cy5wdXNoKGA8dGV4dCBjbGFzcz1cInNiLWNoYXJ0LWxhYmVsXCIgeD1cIiR7eCh2KX1cIiB5PVwiJHtiYXNlICsgMTZ9XCIgdGV4dC1hbmNob3I9XCJtaWRkbGVcIj4ke3Z9PC90ZXh0PmApO1xyXG4gIH1cclxuXHJcbiAgaWYgKHRpY2tzLmxlbmd0aCA+IDApIHtcclxuICAgIGNvbnN0IHRvcCA9IGJhc2UgKyBheGlzSDtcclxuICAgIGNvbnN0IGxpbmVZID0gdG9wICsgMjA7XHJcbiAgICBwYXJ0cy5wdXNoKGA8dGV4dCBjbGFzcz1cInNiLWNoYXJ0LWNhcHRpb25cIiB4PVwiJHttLmxlZnR9XCIgeT1cIiR7dG9wICsgMTB9XCI+U3Rhc2ggcmF0aW5nICgke3N0YXNoUmF0aW5nc09wdGlvbihtb2RlKS5sYWJlbH0pPC90ZXh0PmApO1xyXG4gICAgcGFydHMucHVzaChgPGxpbmUgY2xhc3M9XCJzYi1jaGFydC1zY2FsZVwiIHgxPVwiJHt4KHRpY2tzWzBdLmVsbyl9XCIgeDI9XCIke3godGlja3NbdGlja3MubGVuZ3RoIC0gMV0uZWxvKX1cIiB5MT1cIiR7bGluZVl9XCIgeTI9XCIke2xpbmVZfVwiLz5gKTtcclxuICAgIGZvciAoY29uc3QgdCBvZiB0aWNrcykge1xyXG4gICAgICBwYXJ0cy5wdXNoKGA8bGluZSBjbGFzcz1cInNiLWNoYXJ0LXNjYWxlXCIgeDE9XCIke3godC5lbG8pfVwiIHgyPVwiJHt4KHQuZWxvKX1cIiB5MT1cIiR7bGluZVkgLSA0fVwiIHkyPVwiJHtsaW5lWSArIDR9XCIvPmApO1xyXG4gICAgICBwYXJ0cy5wdXNoKFxyXG4gICAgICAgIGA8dGV4dCBjbGFzcz1cInNiLWNoYXJ0LWxhYmVsIHNiLWNoYXJ0LXNjYWxlLWxhYmVsXCIgeD1cIiR7eCh0LmVsbyl9XCIgeT1cIiR7bGluZVkgKyAxOH1cIiB0ZXh0LWFuY2hvcj1cIm1pZGRsZVwiIGRhdGEtdGlwPVwiU3Rhc2ggcmF0aW5nICR7Zm9ybWF0UmF0aW5nKHQucmF0aW5nLCB0cnVlKX0gYXQgRUxPICR7TWF0aC5yb3VuZCh0LmVsbyl9XCI+JHtmb3JtYXRSYXRpbmcodC5yYXRpbmcpfTwvdGV4dD5gLFxyXG4gICAgICApO1xyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgcmV0dXJuIGA8c3ZnIGNsYXNzPVwic2ItY2hhcnQtc3ZnXCIgd2lkdGg9XCIke3dpZHRofVwiIGhlaWdodD1cIiR7aGVpZ2h0fVwiIHZpZXdCb3g9XCIwIDAgJHt3aWR0aH0gJHtoZWlnaHR9XCIgcm9sZT1cImltZ1wiIGFyaWEtbGFiZWw9XCJIb3cgbWFueSBzY2VuZXMgaGF2ZSBlYWNoIEVMT1wiPiR7cGFydHMuam9pbihcIlwiKX08L3N2Zz5gO1xyXG59XHJcblxyXG5mdW5jdGlvbiBkaXN0cmlidXRpb25Ob3RlKCk6IHN0cmluZyB7XHJcbiAgY29uc3Qgbm90ZXM6IHN0cmluZ1tdID0gW107XHJcbiAgY29uc3QgdGllID0gbGFyZ2VzdFRpZShzY2VuZXMpO1xyXG4gIGlmICh0aWUgJiYgdGllLmNvdW50ID49IFRJRV9OT1RFX01JTikge1xyXG4gICAgbm90ZXMucHVzaChgJHt0aWUuY291bnR9IHNjZW5lcyBhcmUgc3RpbGwgdGllZCBhdCBFTE8gJHtNYXRoLnJvdW5kKHRpZS5lbG8pfS5gKTtcclxuICB9XHJcbiAgaWYgKHN0YXRlLnNldHRpbmdzLnN0YXNoUmF0aW5ncyA9PT0gXCJvZmZcIikge1xyXG4gICAgbm90ZXMucHVzaChcIlN0YXNoIHJhdGluZ3MgYXJlbid0IGJlaW5nIHVwZGF0ZWQsIHNvIHRoZXJlJ3Mgbm8gcmF0aW5nIHNjYWxlIHVuZGVyIHRoZSBjaGFydC5cIik7XHJcbiAgfSBlbHNlIGlmIChzdGF0ZS5zZXR0aW5ncy5zdGFzaFJhdGluZ3MgPT09IFwicGVyY2VudGlsZVwiKSB7XHJcbiAgICBub3Rlcy5wdXNoKFwiUGVyY2VudGlsZSBzcHJlYWRzIHJhdGluZ3MgYWNyb3NzIHRoZSB3aG9sZSBzY2FsZSBieSByYW5rLCBzbyB0aGUgc2NhbGUgZm9sbG93cyB5b3VyIGxpYnJhcnkuXCIpO1xyXG4gIH1cclxuICByZXR1cm4gbm90ZXMubGVuZ3RoID8gYDxwIGNsYXNzPVwic2Itc3RhdHMtbm90ZVwiPiR7bm90ZXMuam9pbihcIiBcIil9PC9wPmAgOiBcIlwiO1xyXG59XHJcblxyXG4vLyAtLS0tLS0tLS0tIEhpZGRlbiBnZW1zIC8gb3ZlcnBsYXllZCAtLS0tLS0tLS0tXHJcblxyXG4vKiogU21hbGwgZml4ZWQgb2Zmc2V0IHBlciBzY2VuZSwgc28gc2NlbmVzIHdpdGggdGhlIHNhbWUgRUxPIGFuZCBwbGF5IGNvdW50IGRvbid0IGhpZGUgZWFjaCBvdGhlci4gKi9cclxuZnVuY3Rpb24gaml0dGVyKGlkOiBzdHJpbmcsIHJhbmdlOiBudW1iZXIpOiBudW1iZXIge1xyXG4gIGxldCBoYXNoID0gMDtcclxuICBmb3IgKGxldCBpID0gMDsgaSA8IGlkLmxlbmd0aDsgaSsrKSBoYXNoID0gKGhhc2ggKiAzMSArIGlkLmNoYXJDb2RlQXQoaSkpIHwgMDtcclxuICByZXR1cm4gKChNYXRoLmFicyhoYXNoKSAlIDEwMDApIC8gMTAwMCAtIDAuNSkgKiAyICogcmFuZ2U7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNjYXR0ZXJTdmcod2lkdGg6IG51bWJlciwgc3BsaXQ6IEdlbXNTcGxpdCk6IHN0cmluZyB7XHJcbiAgY29uc3QgcmF0ZWQgPSBzY2VuZXNcclxuICAgIC5tYXAoKHNjZW5lKSA9PiAoeyBzY2VuZSwgZWxvOiBlbG8oc2NlbmUpIH0pKVxyXG4gICAgLmZpbHRlcigocyk6IHMgaXMgeyBzY2VuZTogU2NlbmU7IGVsbzogbnVtYmVyIH0gPT4gcy5lbG8gIT09IG51bGwpO1xyXG4gIGlmIChyYXRlZC5sZW5ndGggPCAyKSByZXR1cm4gXCJcIjtcclxuXHJcbiAgY29uc3QgbSA9IHsgbGVmdDogNDQsIHJpZ2h0OiAxNCwgdG9wOiAxMiwgYm90dG9tOiAzNCB9O1xyXG4gIGNvbnN0IGhlaWdodCA9IHdpZHRoIDwgNTAwID8gMjYwIDogMzQwO1xyXG4gIGNvbnN0IHBsb3RXID0gd2lkdGggLSBtLmxlZnQgLSBtLnJpZ2h0O1xyXG4gIGNvbnN0IHBsb3RIID0gaGVpZ2h0IC0gbS50b3AgLSBtLmJvdHRvbTtcclxuICBjb25zdCBtYXhQbGF5cyA9IE1hdGgubWF4KDEsIC4uLnJhdGVkLm1hcCgocykgPT4gcy5zY2VuZS5wbGF5X2NvdW50ID8/IDApKTtcclxuICBjb25zdCBlbG9zID0gcmF0ZWQubWFwKChzKSA9PiBzLmVsbyk7XHJcbiAgY29uc3QgbG8gPSBNYXRoLmZsb29yKChNYXRoLm1pbiguLi5lbG9zKSAtIDEpIC8gMTAwKSAqIDEwMDtcclxuICBjb25zdCBoaSA9IE1hdGguY2VpbCgoTWF0aC5tYXgoLi4uZWxvcykgKyAxKSAvIDEwMCkgKiAxMDA7XHJcbiAgY29uc3QgeCA9IChwbGF5czogbnVtYmVyKTogbnVtYmVyID0+IG0ubGVmdCArIChNYXRoLnNxcnQocGxheXMpIC8gTWF0aC5zcXJ0KG1heFBsYXlzKSkgKiBwbG90VztcclxuICBjb25zdCB5ID0gKHZhbHVlOiBudW1iZXIpOiBudW1iZXIgPT4gbS50b3AgKyAoKGhpIC0gdmFsdWUpIC8gKGhpIC0gbG8pKSAqIHBsb3RIO1xyXG4gIGNvbnN0IGJhc2UgPSBtLnRvcCArIHBsb3RIO1xyXG5cclxuICBjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbXTtcclxuICBjb25zdCBlbG9TdGVwID0gcGxvdEggLyAoKGhpIC0gbG8pIC8gMTAwKSA+PSAyNiA/IDEwMCA6IDIwMDtcclxuICBmb3IgKGxldCB2ID0gTWF0aC5jZWlsKGxvIC8gZWxvU3RlcCkgKiBlbG9TdGVwOyB2IDw9IGhpOyB2ICs9IGVsb1N0ZXApIHtcclxuICAgIHBhcnRzLnB1c2goYDxsaW5lIGNsYXNzPVwic2ItY2hhcnQtZ3JpZFwiIHgxPVwiJHttLmxlZnR9XCIgeDI9XCIke3dpZHRoIC0gbS5yaWdodH1cIiB5MT1cIiR7eSh2KX1cIiB5Mj1cIiR7eSh2KX1cIi8+YCk7XHJcbiAgICBwYXJ0cy5wdXNoKGA8dGV4dCBjbGFzcz1cInNiLWNoYXJ0LWxhYmVsXCIgeD1cIiR7bS5sZWZ0IC0gNn1cIiB5PVwiJHt5KHYpICsgNH1cIiB0ZXh0LWFuY2hvcj1cImVuZFwiPiR7dn08L3RleHQ+YCk7XHJcbiAgfVxyXG4gIGxldCBsYXN0VGlja1ggPSAtSW5maW5pdHk7XHJcbiAgZm9yIChjb25zdCBwbGF5cyBvZiBQTEFZX1RJQ0tTLmZpbHRlcigocCkgPT4gcCA8PSBtYXhQbGF5cykpIHtcclxuICAgIGlmICh4KHBsYXlzKSAtIGxhc3RUaWNrWCA8IDMwKSBjb250aW51ZTtcclxuICAgIGxhc3RUaWNrWCA9IHgocGxheXMpO1xyXG4gICAgcGFydHMucHVzaChgPHRleHQgY2xhc3M9XCJzYi1jaGFydC1sYWJlbFwiIHg9XCIke3gocGxheXMpfVwiIHk9XCIke2Jhc2UgKyAxNn1cIiB0ZXh0LWFuY2hvcj1cIm1pZGRsZVwiPiR7cGxheXN9PC90ZXh0PmApO1xyXG4gIH1cclxuICBwYXJ0cy5wdXNoKGA8bGluZSBjbGFzcz1cInNiLWNoYXJ0LWF4aXNcIiB4MT1cIiR7bS5sZWZ0fVwiIHgyPVwiJHt3aWR0aCAtIG0ucmlnaHR9XCIgeTE9XCIke2Jhc2V9XCIgeTI9XCIke2Jhc2V9XCIvPmApO1xyXG4gIHBhcnRzLnB1c2goYDx0ZXh0IGNsYXNzPVwic2ItY2hhcnQtY2FwdGlvblwiIHg9XCIke3dpZHRoIC0gbS5yaWdodH1cIiB5PVwiJHtiYXNlICsgMzB9XCIgdGV4dC1hbmNob3I9XCJlbmRcIj5QbGF5IGNvdW50IOKGkjwvdGV4dD5gKTtcclxuICBwYXJ0cy5wdXNoKGA8dGV4dCBjbGFzcz1cInNiLWNoYXJ0LWNhcHRpb25cIiB4PVwiJHttLmxlZnQgKyA2fVwiIHk9XCIke20udG9wICsgcGxvdEggLyAyfVwiIHRyYW5zZm9ybT1cInJvdGF0ZSgtOTAgJHttLmxlZnQgLSAzMn0gJHttLnRvcCArIHBsb3RIIC8gMn0pXCIgdGV4dC1hbmNob3I9XCJtaWRkbGVcIiBkeD1cIi0zOFwiPkVMTzwvdGV4dD5gKTtcclxuXHJcbiAgLy8gUXVhZHJhbnQgbGluZXMgYXQgdGhlIG1lZGlhbnMsIGFuZCB0aGUgdHdvIHF1YWRyYW50cyB0aGF0IG1lYW4gc29tZXRoaW5nXHJcbiAgcGFydHMucHVzaChgPGxpbmUgY2xhc3M9XCJzYi1jaGFydC1zcGxpdFwiIHgxPVwiJHt4KHNwbGl0LnBsYXlzKX1cIiB4Mj1cIiR7eChzcGxpdC5wbGF5cyl9XCIgeTE9XCIke20udG9wfVwiIHkyPVwiJHtiYXNlfVwiLz5gKTtcclxuICBwYXJ0cy5wdXNoKGA8bGluZSBjbGFzcz1cInNiLWNoYXJ0LXNwbGl0XCIgeDE9XCIke20ubGVmdH1cIiB4Mj1cIiR7d2lkdGggLSBtLnJpZ2h0fVwiIHkxPVwiJHt5KHNwbGl0LmVsbyl9XCIgeTI9XCIke3koc3BsaXQuZWxvKX1cIi8+YCk7XHJcblxyXG4gIGZvciAoY29uc3QgeyBzY2VuZSwgZWxvOiB2YWx1ZSB9IG9mIHJhdGVkKSB7XHJcbiAgICBjb25zdCBwbGF5cyA9IHNjZW5lLnBsYXlfY291bnQgPz8gMDtcclxuICAgIC8vIFBsYXkgY291bnRzIGFyZSB3aG9sZSBudW1iZXJzOiBzcHJlYWQgZWFjaCBjb2x1bW4gb3ZlciBwYXJ0IG9mIHRoZSBnYXAgdG8gdGhlIG5leHQgb25lXHJcbiAgICAvLyAob25seSByaWdodHdhcmRzIGF0IDAsIHdoaWNoIHNpdHMgb24gdGhlIGF4aXMpXHJcbiAgICBjb25zdCBzcHJlYWQgPSBNYXRoLm1heCgzLCAoeChwbGF5cyArIDEpIC0geChwbGF5cykpICogMC4zKTtcclxuICAgIGNvbnN0IG9mZnNldCA9IHBsYXlzID09PSAwID8gTWF0aC5hYnMoaml0dGVyKHNjZW5lLmlkLCBzcHJlYWQpKSA6IGppdHRlcihzY2VuZS5pZCwgc3ByZWFkKTtcclxuICAgIGNvbnN0IGN4ID0gTWF0aC5taW4od2lkdGggLSBtLnJpZ2h0LCB4KHBsYXlzKSArIG9mZnNldCk7XHJcbiAgICBjb25zdCBjeSA9IHkodmFsdWUpICsgaml0dGVyKGAke3NjZW5lLmlkfXlgLCAyKTtcclxuICAgIHBhcnRzLnB1c2goYDxjaXJjbGUgY2xhc3M9XCJzYi1kb3RcIiBjeD1cIiR7Y3h9XCIgY3k9XCIke2N5fVwiIHI9XCI0XCIgZGF0YS1pZD1cIiR7c2NlbmUuaWR9XCIvPmApO1xyXG4gIH1cclxuICAvLyBMYWJlbHMgbGFzdCwgb24gdG9wIG9mIHRoZSBkb3RzXHJcbiAgcGFydHMucHVzaChgPHRleHQgY2xhc3M9XCJzYi1jaGFydC1xdWFkcmFudFwiIHg9XCIke20ubGVmdCArIDh9XCIgeT1cIiR7bS50b3AgKyAxNn1cIj7wn5KOIEhpZGRlbiBnZW1zPC90ZXh0PmApO1xyXG4gIHBhcnRzLnB1c2goYDx0ZXh0IGNsYXNzPVwic2ItY2hhcnQtcXVhZHJhbnRcIiB4PVwiJHt3aWR0aCAtIG0ucmlnaHQgLSA4fVwiIHk9XCIke2Jhc2UgLSAxMH1cIiB0ZXh0LWFuY2hvcj1cImVuZFwiPk92ZXJwbGF5ZWQ8L3RleHQ+YCk7XHJcblxyXG4gIHJldHVybiBgPHN2ZyBjbGFzcz1cInNiLWNoYXJ0LXN2Z1wiIHdpZHRoPVwiJHt3aWR0aH1cIiBoZWlnaHQ9XCIke2hlaWdodH1cIiB2aWV3Qm94PVwiMCAwICR7d2lkdGh9ICR7aGVpZ2h0fVwiIHJvbGU9XCJpbWdcIiBhcmlhLWxhYmVsPVwiRUxPIGFnYWluc3QgcGxheSBjb3VudFwiPiR7cGFydHMuam9pbihcIlwiKX08L3N2Zz5gO1xyXG59XHJcblxyXG4vLyAtLS0tLS0tLS0tIEhvdyBzZXR0bGVkIC0tLS0tLS0tLS1cclxuXHJcbi8qKiBUaGUgbGVhc3QtdGVzdGVkIHBvb2wncyBzY2VuZXMgKHRoZSBTY2VuZXMgcGFnZSBmaWx0ZXIncywgb3IgdGhlIHdob2xlIGxpYnJhcnkpLCBzZXQgb24gcmVuZGVyLiAqL1xyXG5sZXQgbGVhc3RUZXN0ZWRTY2VuZXM6IFNjZW5lW10gPSBbXTtcclxubGV0IGxlYXN0VGVzdGVkRmlsdGVyZWQgPSBmYWxzZTtcclxuXHJcbi8qKiBXaGF0IFwibGVhc3QgdGVzdGVkXCIgbWVhbnMgYW5kIHdobydzIGluIGl0IG5vdyAodGhlIGJ1dHRvbiBjYXJyaWVzIHRoZSB0b3RhbCkuICovXHJcbmZ1bmN0aW9uIGxlYXN0VGVzdGVkVGV4dCgpOiBzdHJpbmcge1xyXG4gIGNvbnN0IHBvb2wgPSBsZWFzdFRlc3RlZFBvb2wobGVhc3RUZXN0ZWRTY2VuZXMpO1xyXG4gIGlmICghcG9vbCkgcmV0dXJuIFwiXCI7XHJcbiAgY29uc3QgcmF0ZWQgPSBwb29sLmNvdW50IC0gcG9vbC51bnJhdGVkO1xyXG4gIGNvbnN0IHdobyA9XHJcbiAgICBwb29sLmJhdHRsZXMgPT09IDBcclxuICAgICAgPyBgJHtyYXRlZH0gd2l0aCBhbiBFTE8gKHRoZSDigJxObyBiYXR0bGVzIHlldOKAnSBiYXIpJHtwb29sLnVucmF0ZWQgPiAwID8gYCBhbmQgJHtwb29sLnVucmF0ZWR9IHVucmF0ZWRgIDogXCJcIn0uYFxyXG4gICAgICA6IGBUaGUgZmV3ZXN0IGJhdHRsZXMgYW55IHNjZW5lIGhhcyBpcyAke3Bvb2wuYmF0dGxlc30sIGFuZCAke3BsdXJhbChwb29sLmNvdW50LCBcInNjZW5lXCIpfSBoYXZlIHRoYXQgbWFueS5gO1xyXG4gIHJldHVybiBsZWFzdFRlc3RlZEZpbHRlcmVkID8gYCR7d2hvfSBGcm9tIHlvdXIgU2NlbmVzIHBhZ2UgZmlsdGVyLmAgOiB3aG87XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNldHRsZWRIdG1sKCk6IHN0cmluZyB7XHJcbiAgY29uc3QgYnVja2V0cyA9IHNldHRsZWRCdWNrZXRzKHNjZW5lcyk7XHJcbiAgY29uc3QgbWF4ID0gTWF0aC5tYXgoMSwgLi4uYnVja2V0cy5tYXAoKGIpID0+IGIuY291bnQpKTtcclxuICBjb25zdCBsYWJlbCA9IChtaW46IG51bWJlciwgbWF4OiBudW1iZXIgfCBudWxsKTogc3RyaW5nID0+IHtcclxuICAgIGlmIChtYXggPT09IDApIHJldHVybiBcIk5vIGJhdHRsZXMgeWV0XCI7XHJcbiAgICBpZiAobWF4ID09PSBudWxsKSByZXR1cm4gYCR7bWlufSsgYmF0dGxlc2A7XHJcbiAgICByZXR1cm4gYCR7bWlufeKAkyR7bWF4fSBiYXR0bGVzYDtcclxuICB9O1xyXG4gIGNvbnN0IHJvd3MgPSBidWNrZXRzXHJcbiAgICAubWFwKFxyXG4gICAgICAoYikgPT4gYFxyXG4gICAgICAgICAgPGRpdiBjbGFzcz1cInNiLXNldHRsZWQtcm93XCIgdGl0bGU9XCIke3BsdXJhbChiLmNvdW50LCBcInNjZW5lXCIpfSB3aXRoICR7bGFiZWwoYi5taW4sIGIubWF4KS50b0xvd2VyQ2FzZSgpfVwiPlxyXG4gICAgICAgICAgICA8c3BhbiBjbGFzcz1cInNiLXNldHRsZWQtbGFiZWxcIj4ke2xhYmVsKGIubWluLCBiLm1heCl9PC9zcGFuPlxyXG4gICAgICAgICAgICA8c3BhbiBjbGFzcz1cInNiLXNldHRsZWQtdHJhY2tcIj48c3BhbiBjbGFzcz1cInNiLXNldHRsZWQtYmFyXCIgc3R5bGU9XCJ3aWR0aDogJHsoYi5jb3VudCAvIG1heCkgKiAxMDB9JVwiPjwvc3Bhbj48L3NwYW4+XHJcbiAgICAgICAgICAgIDxzcGFuIGNsYXNzPVwic2Itc2V0dGxlZC1jb3VudFwiPiR7Yi5jb3VudH08L3NwYW4+XHJcbiAgICAgICAgICA8L2Rpdj5gLFxyXG4gICAgKVxyXG4gICAgLmpvaW4oXCJcIik7XHJcbiAgY29uc3QgeyBwcm92aXNpb25hbCB9ID0gb3ZlcnZpZXcoc2NlbmVzKTtcclxuICBjb25zdCBwcm92aXNpb25hbFRleHQgPVxyXG4gICAgcHJvdmlzaW9uYWwgPiAwXHJcbiAgICAgID8gYDxzdHJvbmc+JHtwbHVyYWwocHJvdmlzaW9uYWwsIFwic2NlbmVcIil9PC9zdHJvbmc+ICR7cHJvdmlzaW9uYWwgPT09IDEgPyBcImlzXCIgOiBcImFyZVwifSBzdGlsbCBwcm92aXNpb25hbDogZmV3ZXIgdGhhbiAke0VMT19LX1RJRVJTWzBdWzBdfSBiYXR0bGVzLCBzbyAke3Byb3Zpc2lvbmFsID09PSAxID8gXCJpdHNcIiA6IFwidGhlaXJcIn0gRUxPIHN0aWxsIG1vdmVzIGEgbG90IHdpdGggZWFjaCBiYXR0bGUuYFxyXG4gICAgICA6IGBObyBzY2VuZSBpcyBwcm92aXNpb25hbC4gU2NlbmVzIHNlZWRlZCBmcm9tIHlvdXIgc3RhciByYXRpbmdzIHN0YXJ0IHdpdGggYSAke0VMT19LX1RJRVJTWzBdWzBdfS1iYXR0bGUgaGVhZCBzdGFydCwgc28gb25seSBzY2VuZXMgdGhhdCBzdGFydGVkIHdpdGhvdXQgb25lIGNhbiBiZS5gO1xyXG4gIHJldHVybiBgXHJcbiAgICAgICAgICA8ZGl2IGNsYXNzPVwic2Itc2V0dGxlZFwiPiR7cm93c308L2Rpdj5cclxuICAgICAgICAgIDxwIGNsYXNzPVwic2Itc3RhdHMtbm90ZVwiPiR7cHJvdmlzaW9uYWxUZXh0fTwvcD5cclxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1zdGF0cy1hY3Rpb25zXCI+XHJcbiAgICAgICAgICAgIDxidXR0b24gdHlwZT1cImJ1dHRvblwiIGNsYXNzPVwiYnRuIGJ0bi1zZWNvbmRhcnkgYnRuLXNtXCIgZGF0YS1zdGF0cy1hY3Rpb249XCJsZWFzdC10ZXN0ZWRcIj5CYXR0bGUgdGhlIGxlYXN0LXRlc3RlZCAoJHtwbHVyYWwobGVhc3RUZXN0ZWRQb29sKGxlYXN0VGVzdGVkU2NlbmVzKT8uY291bnQgPz8gMCwgXCJzY2VuZVwiKX0pPC9idXR0b24+XHJcbiAgICAgICAgICAgIDxzcGFuIGNsYXNzPVwic2Itc3RhdHMtbXV0ZWRcIj4ke2xlYXN0VGVzdGVkVGV4dCgpfTwvc3Bhbj5cclxuICAgICAgICAgIDwvZGl2PmA7XHJcbn1cclxuXHJcbi8vIC0tLS0tLS0tLS0gUmVuZGVyaW5nIGFuZCBldmVudHMgLS0tLS0tLS0tLVxyXG5cclxuZnVuY3Rpb24gZHJhd0NoYXJ0cyhyb290OiBIVE1MRWxlbWVudCk6IHZvaWQge1xyXG4gIGNvbnN0IGhpc3RvZ3JhbSA9IHJvb3QucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCIjc2Itc3RhdHMtaGlzdG9ncmFtXCIpO1xyXG4gIGlmIChoaXN0b2dyYW0pIGhpc3RvZ3JhbS5pbm5lckhUTUwgPSBoaXN0b2dyYW1TdmcoaGlzdG9ncmFtLmNsaWVudFdpZHRoKSArICc8ZGl2IGNsYXNzPVwic2ItY2hhcnQtdGlwXCIgaGlkZGVuPjwvZGl2Pic7XHJcbiAgY29uc3Qgc2NhdHRlciA9IHJvb3QucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCIjc2Itc3RhdHMtc2NhdHRlclwiKTtcclxuICBjb25zdCBzcGxpdCA9IGdlbXNTcGxpdChzY2VuZXMpO1xyXG4gIGlmIChzY2F0dGVyICYmIHNwbGl0KSBzY2F0dGVyLmlubmVySFRNTCA9IHNjYXR0ZXJTdmcoc2NhdHRlci5jbGllbnRXaWR0aCwgc3BsaXQpICsgJzxkaXYgY2xhc3M9XCJzYi1jaGFydC10aXBcIiBoaWRkZW4+PC9kaXY+JztcclxufVxyXG5cclxuLyoqXHJcbiAqIFdoZXJlIGEgY2hhcnQgdG9vbHRpcCBnb2VzLCBrZXB0IGluc2lkZSB0aGUgY2hhcnQ6IGEgdGV4dCB0aXAgYWJvdmUgdGhlIHBvaW50ZXI7IGEgaG92ZXIgY2FyZFxyXG4gKiBiZXNpZGUgaXQgKHJpZ2h0LCBvciBsZWZ0IG5lYXIgdGhlIHJpZ2h0IGVkZ2UpLCBsZXZlbCB3aXRoIHRoZSBwb2ludGVyLCBzbyBpdCBuZXZlciBoYW5ncyBiZWxvd1xyXG4gKiB0aGUgY2hhcnQgb3IgY292ZXJzIHRoZSBkb3QuXHJcbiAqL1xyXG5mdW5jdGlvbiBwbGFjZVRpcChjaGFydDogSFRNTEVsZW1lbnQsIHRpcDogSFRNTEVsZW1lbnQsIGF0OiB7IGNsaWVudFg6IG51bWJlcjsgY2xpZW50WTogbnVtYmVyIH0sIGNhcmQ6IGJvb2xlYW4pOiB2b2lkIHtcclxuICBjb25zdCBib3ggPSBjaGFydC5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTtcclxuICBjb25zdCB4ID0gYXQuY2xpZW50WCAtIGJveC5sZWZ0O1xyXG4gIGNvbnN0IHkgPSBhdC5jbGllbnRZIC0gYm94LnRvcDtcclxuICBjb25zdCB3ID0gdGlwLm9mZnNldFdpZHRoO1xyXG4gIGNvbnN0IGggPSB0aXAub2Zmc2V0SGVpZ2h0O1xyXG4gIGNvbnN0IGNsYW1wID0gKHZhbHVlOiBudW1iZXIsIG1heDogbnVtYmVyKTogbnVtYmVyID0+IE1hdGgubWF4KDAsIE1hdGgubWluKHZhbHVlLCBtYXgpKTtcclxuICBpZiAoY2FyZCkge1xyXG4gICAgY29uc3QgbGVmdCA9IHggKyAxNiArIHcgPD0gYm94LndpZHRoID8geCArIDE2IDogeCAtIDE2IC0gdztcclxuICAgIHRpcC5zdHlsZS5sZWZ0ID0gYCR7Y2xhbXAobGVmdCwgYm94LndpZHRoIC0gdyl9cHhgO1xyXG4gICAgdGlwLnN0eWxlLnRvcCA9IGAke2NsYW1wKHkgLSBoIC8gMiwgYm94LmhlaWdodCAtIGgpfXB4YDtcclxuICAgIHJldHVybjtcclxuICB9XHJcbiAgY29uc3QgYWJvdmUgPSB5IC0gaCAtIDEyO1xyXG4gIHRpcC5zdHlsZS5sZWZ0ID0gYCR7Y2xhbXAoeCArIDE0LCBib3gud2lkdGggLSB3IC0gNCl9cHhgO1xyXG4gIHRpcC5zdHlsZS50b3AgPSBgJHthYm92ZSA+PSAwID8gYWJvdmUgOiB5ICsgMTh9cHhgO1xyXG59XHJcblxyXG5cclxuLyoqXHJcbiAqIEhvdmVyIHRvb2x0aXBzIGluc2lkZSBhIGNoYXJ0OiB0aGUgdGV4dCBvZiBhbiBlbGVtZW50J3MgZGF0YS10aXAsIG9yLCBvdmVyIGEgaGlkZGVuIGdlbXMgZG90LFxyXG4gKiB0aGUgc2NlbmUncyBzbWFsbCBjYXJkLlxyXG4gKi9cclxuZnVuY3Rpb24gYmluZFRvb2x0aXBzKGNoYXJ0OiBIVE1MRWxlbWVudCk6IHZvaWQge1xyXG4gIGNvbnN0IHNob3cgPSAoZTogUG9pbnRlckV2ZW50KTogdm9pZCA9PiB7XHJcbiAgICBjb25zdCB0aXAgPSBjaGFydC5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIi5zYi1jaGFydC10aXBcIik7XHJcbiAgICBpZiAoIXRpcCB8fCBpc1RvdWNoRGV2aWNlKCkpIHJldHVybjtcclxuICAgIGNvbnN0IHRhcmdldCA9IGUudGFyZ2V0IGFzIEVsZW1lbnQ7XHJcbiAgICBjb25zdCBkb3QgPSB0YXJnZXQuY2xvc2VzdDxTVkdFbGVtZW50PihcIi5zYi1kb3RcIik7XHJcbiAgICBjb25zdCBlbnRyeSA9IGRvdD8uZGF0YXNldC5pZCA/IGVudHJpZXNCeUlkLmdldChkb3QuZGF0YXNldC5pZCkgOiB1bmRlZmluZWQ7XHJcbiAgICBpZiAoZW50cnkpIHtcclxuICAgICAgLy8gS2VwdCBvbiB0aGUgdGlwIGl0c2VsZjogYSByZWRyYXcgKHJlc2l6ZSkgcmVwbGFjZXMgdGhlIHRpcCB3aXRoIGFuIGVtcHR5IG9uZVxyXG4gICAgICBpZiAodGlwLmRhdGFzZXQuY2FyZEZvciAhPT0gZW50cnkuc2NlbmUuaWQpIHtcclxuICAgICAgICB0aXAuZGF0YXNldC5jYXJkRm9yID0gZW50cnkuc2NlbmUuaWQ7XHJcbiAgICAgICAgdGlwLmlubmVySFRNTCA9IG1pbmlDYXJkSHRtbChlbnRyeSwgZmFsc2UpO1xyXG4gICAgICB9XHJcbiAgICAgIHRpcC5jbGFzc0xpc3QuYWRkKFwic2ItY2hhcnQtdGlwLWNhcmRcIik7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICBjb25zdCB0ZXh0ID0gdGFyZ2V0LmNsb3Nlc3QoXCJbZGF0YS10aXBdXCIpPy5nZXRBdHRyaWJ1dGUoXCJkYXRhLXRpcFwiKTtcclxuICAgICAgaWYgKCF0ZXh0KSB7XHJcbiAgICAgICAgZGVsZXRlIHRpcC5kYXRhc2V0LmNhcmRGb3I7XHJcbiAgICAgICAgdGlwLmhpZGRlbiA9IHRydWU7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgICB9XHJcbiAgICAgIGRlbGV0ZSB0aXAuZGF0YXNldC5jYXJkRm9yO1xyXG4gICAgICB0aXAuY2xhc3NMaXN0LnJlbW92ZShcInNiLWNoYXJ0LXRpcC1jYXJkXCIpO1xyXG4gICAgICB0aXAudGV4dENvbnRlbnQgPSB0ZXh0O1xyXG4gICAgfVxyXG4gICAgdGlwLmhpZGRlbiA9IGZhbHNlO1xyXG4gICAgcGxhY2VUaXAoY2hhcnQsIHRpcCwgZSwgQm9vbGVhbihlbnRyeSkpO1xyXG4gIH07XHJcbiAgY2hhcnQuYWRkRXZlbnRMaXN0ZW5lcihcInBvaW50ZXJtb3ZlXCIsIHNob3cpO1xyXG4gIC8vIChBIHRhcCBvbiBhIHBob25lIGFsc28gZW5kcyBpbiBcInBvaW50ZXJsZWF2ZVwiOyBhIHBpbm5lZCBjYXJkIHN0YXlzIHVudGlsIGFub3RoZXIgdGFwKVxyXG4gIGNoYXJ0LmFkZEV2ZW50TGlzdGVuZXIoXCJwb2ludGVybGVhdmVcIiwgKCkgPT4ge1xyXG4gICAgY29uc3QgdGlwID0gY2hhcnQucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCIuc2ItY2hhcnQtdGlwXCIpO1xyXG4gICAgaWYgKCF0aXAgfHwgdGlwLmNsYXNzTGlzdC5jb250YWlucyhcInNiLWNoYXJ0LXRpcC1waW5uZWRcIikpIHJldHVybjtcclxuICAgIHRpcC5oaWRkZW4gPSB0cnVlO1xyXG4gICAgZGVsZXRlIHRpcC5kYXRhc2V0LmNhcmRGb3I7XHJcbiAgfSk7XHJcbn1cclxuXHJcbi8qKiBPcGVuIGEgc2NlbmUncyBwYWdlIChpbiBhIG5ldyB0YWIgd2l0aCBcIk9wZW4gc2NlbmVzIGluIGEgbmV3IHRhYlwiLCBsaWtlIHRoZSBiYXR0bGUgY2FyZHMpLiAqL1xyXG5mdW5jdGlvbiBvcGVuU2NlbmUoc2NlbmVJZDogc3RyaW5nLCBlOiBNb3VzZUV2ZW50KTogdm9pZCB7XHJcbiAgY29uc3QgdXJsID0gc2NlbmVVcmwoc2NlbmVJZCk7XHJcbiAgaWYgKHN0YXRlLnNldHRpbmdzLm9wZW5Jbk5ld1RhYiB8fCBlLmN0cmxLZXkgfHwgZS5tZXRhS2V5IHx8IGUuc2hpZnRLZXkpIHdpbmRvdy5vcGVuKHVybCwgXCJfYmxhbmtcIiwgXCJub29wZW5lclwiKTtcclxuICBlbHNlIG5hdmlnYXRlVG9VcmwodXJsKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIFRvdWNoOiBhIHRhcHBlZCBkb3QncyBjYXJkLCBwaW5uZWQgYmVzaWRlIGl0LCB3aXRoIGEgbGluayB0byB0aGUgc2NlbmUgYW5kIGEg4pqU77iPIGJ1dHRvbi4gQSB0YXBcclxuICogYW55d2hlcmUgZWxzZSBpbiB0aGUgY2hhcnQgY2xvc2VzIGl0LlxyXG4gKi9cclxuZnVuY3Rpb24gcGluQ2FyZChkb3Q6IFNWR0VsZW1lbnQsIGVudHJ5OiBFeHBsb3JlRW50cnkpOiB2b2lkIHtcclxuICBwaW5UaXAoZG90LCBtaW5pQ2FyZEh0bWwoZW50cnkpLCB0cnVlKTtcclxufVxyXG5cclxuLyoqIFBpbiBgaHRtbGAgaW4gdGhlIGNoYXJ0J3MgdG9vbHRpcCBuZXh0IHRvIGBhbmNob3JgIChhIHRhcHBlZCBkb3Qgb3IgYmFyKSwgdW50aWwgYW5vdGhlciB0YXAuICovXHJcbmZ1bmN0aW9uIHBpblRpcChhbmNob3I6IEVsZW1lbnQsIGh0bWw6IHN0cmluZywgY2FyZDogYm9vbGVhbik6IHZvaWQge1xyXG4gIGNvbnN0IGNoYXJ0ID0gYW5jaG9yLmNsb3Nlc3Q8SFRNTEVsZW1lbnQ+KFwiLnNiLWNoYXJ0XCIpO1xyXG4gIGNvbnN0IHRpcCA9IGNoYXJ0Py5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIi5zYi1jaGFydC10aXBcIik7XHJcbiAgaWYgKCFjaGFydCB8fCAhdGlwKSByZXR1cm47XHJcbiAgdGlwLmlubmVySFRNTCA9IGh0bWw7XHJcbiAgdGlwLmNsYXNzTGlzdC50b2dnbGUoXCJzYi1jaGFydC10aXAtY2FyZFwiLCBjYXJkKTtcclxuICB0aXAuY2xhc3NMaXN0LmFkZChcInNiLWNoYXJ0LXRpcC1waW5uZWRcIik7XHJcbiAgdGlwLmhpZGRlbiA9IGZhbHNlO1xyXG4gIGNvbnN0IHIgPSBhbmNob3IuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7XHJcbiAgcGxhY2VUaXAoY2hhcnQsIHRpcCwgeyBjbGllbnRYOiByLmxlZnQgKyByLndpZHRoIC8gMiwgY2xpZW50WTogci50b3AgKyBNYXRoLm1pbihyLmhlaWdodCAvIDIsIDQwKSB9LCBjYXJkKTtcclxufVxyXG5cclxuZnVuY3Rpb24gdW5waW5DYXJkKHJvb3Q6IEhUTUxFbGVtZW50KTogdm9pZCB7XHJcbiAgcm9vdC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PihcIi5zYi1jaGFydC10aXAtcGlubmVkXCIpLmZvckVhY2goKHRpcCkgPT4ge1xyXG4gICAgdGlwLmNsYXNzTGlzdC5yZW1vdmUoXCJzYi1jaGFydC10aXAtcGlubmVkXCIpO1xyXG4gICAgdGlwLmhpZGRlbiA9IHRydWU7XHJcbiAgfSk7XHJcbn1cclxuXHJcbi8qKiBDbGlja3MgaW4gdGhlIHRhYjogaGlzdG9ncmFtIGJhcnMsIGhpZGRlbiBnZW1zIGRvdHMgKGFuZCB0aGVpciBwaW5uZWQgY2FyZHMpIGFuZCB0aGUgYnV0dG9ucy4gKi9cclxuZnVuY3Rpb24gb25Db250ZW50Q2xpY2soZTogTW91c2VFdmVudCk6IHZvaWQge1xyXG4gIGNvbnN0IHRhcmdldCA9IGUudGFyZ2V0IGFzIEVsZW1lbnQ7XHJcbiAgY29uc3Qgcm9vdCA9IGUuY3VycmVudFRhcmdldCBhcyBIVE1MRWxlbWVudDtcclxuICBpZiAoIWFjdGlvbnMpIHJldHVybjtcclxuICAvLyBBIHBpbm5lZCB0aXAgKHRvdWNoKTogYSBjYXJkJ3Mg4pqU77iPIGJhdHRsZXMgdGhlIHNjZW5lIGFuZCB0aGUgcmVzdCBvcGVucyB0aGUgc2NlbmUncyBwYWdlOyBhXHJcbiAgLy8gYmFyJ3MgYnV0dG9uIG9wZW5zIEV4cGxvcmUgYXQgaXRzIHJhbmdlXHJcbiAgaWYgKHRhcmdldC5jbG9zZXN0KFwiLnNiLWNoYXJ0LXRpcC1waW5uZWRcIikpIHtcclxuICAgIGNvbnN0IGJhdHRsZSA9IHRhcmdldC5jbG9zZXN0PEhUTUxFbGVtZW50PihcIltkYXRhLWJhdHRsZV1cIik7XHJcbiAgICBjb25zdCBsaW5rID0gdGFyZ2V0LmNsb3Nlc3Q8SFRNTEFuY2hvckVsZW1lbnQ+KFwiLnNiLW1pbmktbGlua1wiKTtcclxuICAgIGNvbnN0IGV4cGxvcmUgPSB0YXJnZXQuY2xvc2VzdDxIVE1MRWxlbWVudD4oXCJbZGF0YS1leHBsb3JlLWZyb21dXCIpO1xyXG4gICAgaWYgKGJhdHRsZT8uZGF0YXNldC5iYXR0bGUpIGFjdGlvbnMuYmF0dGxlU2NlbmUoYmF0dGxlLmRhdGFzZXQuYmF0dGxlKTtcclxuICAgIGVsc2UgaWYgKGxpbmspIGhhbmRsZVNjZW5lTGlua0NsaWNrKGUsIGxpbmspO1xyXG4gICAgZWxzZSBpZiAoZXhwbG9yZSkgYWN0aW9ucy5leHBsb3JlUmFuZ2UoTnVtYmVyKGV4cGxvcmUuZGF0YXNldC5leHBsb3JlRnJvbSksIE51bWJlcihleHBsb3JlLmRhdGFzZXQuZXhwbG9yZVRvKSk7XHJcbiAgICByZXR1cm47XHJcbiAgfVxyXG4gIGNvbnN0IGJhciA9IHRhcmdldC5jbG9zZXN0PFNWR0VsZW1lbnQ+KFwiW2RhdGEtZnJvbV1cIik7XHJcbiAgaWYgKGJhcj8uZGF0YXNldC5mcm9tICYmIGJhci5xdWVyeVNlbGVjdG9yKFwiLnNiLWNoYXJ0LWJhclwiKSkge1xyXG4gICAgLy8gZGF0YS10byBlbmRzIGEgdGVudGggYmVsb3cgdGhlIG5leHQgYmFyIChFTE8gaXMgc3RvcmVkIHRvIG9uZSBkZWNpbWFsKSwgc28gaXQgY292ZXJzIHRoZSBiYXJcclxuICAgIGNvbnN0IGZyb20gPSBOdW1iZXIoYmFyLmRhdGFzZXQuZnJvbSk7XHJcbiAgICBjb25zdCB0byA9IE51bWJlcihiYXIuZGF0YXNldC50byk7XHJcbiAgICBpZiAoaXNUb3VjaERldmljZSgpKSB7XHJcbiAgICAgIC8vIEJhcnMgYXJlIHRoaW4gb24gYSBwaG9uZTogc2F5IHdoYXQgd2FzIHRhcHBlZCwgYW5kIGV4cGxvcmUgZnJvbSBhIHByb3BlciBidXR0b25cclxuICAgICAgY29uc3QgdGV4dCA9IChiYXIuZGF0YXNldC50aXAgPz8gXCJcIikucmVwbGFjZSgvIMK3IGNsaWNrIHRvIHNlZSB0aGVtJC8sIFwiXCIpO1xyXG4gICAgICBwaW5UaXAoYmFyLCBgPGRpdiBjbGFzcz1cInNiLWNoYXJ0LXRpcC10ZXh0XCI+JHt0ZXh0fTwvZGl2PjxidXR0b24gdHlwZT1cImJ1dHRvblwiIGNsYXNzPVwiYnRuIGJ0bi1wcmltYXJ5IGJ0bi1zbVwiIGRhdGEtZXhwbG9yZS1mcm9tPVwiJHtmcm9tfVwiIGRhdGEtZXhwbG9yZS10bz1cIiR7dG99XCI+8J+UjiBTZWUgdGhlbSBpbiBFeHBsb3JlPC9idXR0b24+YCwgZmFsc2UpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICB1bnBpbkNhcmQocm9vdCk7XHJcbiAgICBhY3Rpb25zLmV4cGxvcmVSYW5nZShmcm9tLCB0byk7XHJcbiAgICByZXR1cm47XHJcbiAgfVxyXG4gIGNvbnN0IGRvdCA9IHRhcmdldC5jbG9zZXN0PFNWR0VsZW1lbnQ+KFwiLnNiLWRvdFwiKTtcclxuICBjb25zdCBlbnRyeSA9IGRvdD8uZGF0YXNldC5pZCA/IGVudHJpZXNCeUlkLmdldChkb3QuZGF0YXNldC5pZCkgOiB1bmRlZmluZWQ7XHJcbiAgaWYgKGRvdCAmJiBlbnRyeSAmJiBpc1RvdWNoRGV2aWNlKCkpIHtcclxuICAgIHBpbkNhcmQoZG90LCBlbnRyeSk7XHJcbiAgICByZXR1cm47XHJcbiAgfVxyXG4gIHVucGluQ2FyZChyb290KTtcclxuICBpZiAoZG90Py5kYXRhc2V0LmlkKSB7XHJcbiAgICBvcGVuU2NlbmUoZG90LmRhdGFzZXQuaWQsIGUpO1xyXG4gICAgcmV0dXJuO1xyXG4gIH1cclxuICBpZiAodGFyZ2V0LmNsb3Nlc3QoXCJbZGF0YS1zdGF0cy1hY3Rpb249J2xlYXN0LXRlc3RlZCddXCIpKSBhY3Rpb25zLmJhdHRsZUxlYXN0VGVzdGVkKCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGJpbmRFdmVudHMocm9vdDogSFRNTEVsZW1lbnQpOiB2b2lkIHtcclxuICByb290LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KFwiLnNiLWNoYXJ0XCIpLmZvckVhY2goYmluZFRvb2x0aXBzKTtcclxuXHJcbiAgLy8gVGhlIGNvbnRlbnQgZWxlbWVudCBvdXRsaXZlcyBlYWNoIHJlbmRlciwgc28gaXRzIGNsaWNrIGhhbmRsZXIgaXMgYm91bmQgb25jZVxyXG4gIGlmIChyb290LmRhdGFzZXQuYm91bmQgIT09IFwiMVwiKSB7XHJcbiAgICByb290LmRhdGFzZXQuYm91bmQgPSBcIjFcIjtcclxuICAgIHJvb3QuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIG9uQ29udGVudENsaWNrKTtcclxuICB9XHJcblxyXG4gIGlmICghcmVzaXplQm91bmQpIHtcclxuICAgIHJlc2l6ZUJvdW5kID0gdHJ1ZTtcclxuICAgIGxldCB0aW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCBudWxsID0gbnVsbDtcclxuICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFwicmVzaXplXCIsICgpID0+IHtcclxuICAgICAgaWYgKHRpbWVyKSBjbGVhclRpbWVvdXQodGltZXIpO1xyXG4gICAgICB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xyXG4gICAgICAgIGNvbnN0IHBhbmVsID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oJyNzYi1tb2RhbCAuc2Itc3RhdHMtdGFiOm5vdChbaGlkZGVuXSknKTtcclxuICAgICAgICBpZiAocGFuZWwgJiYgc2NlbmVzLmxlbmd0aCA+IDApIGRyYXdDaGFydHMocGFuZWwpO1xyXG4gICAgICB9LCAxNTApO1xyXG4gICAgfSk7XHJcbiAgfVxyXG59XHJcblxyXG4vKiogRmlsbCB0aGUgU3RhdHMgdGFiIGZyb20gdGhlIGFsbC1zY2VuZXMgY2FjaGUgKGNhbGwgZWFjaCB0aW1lIHRoZSB0YWIgb3BlbnMpLiAqL1xyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVuZGVyU3RhdHNUYWIobW9kYWw6IEhUTUxFbGVtZW50LCBzdGF0c0FjdGlvbnM6IFN0YXRzQWN0aW9ucyk6IFByb21pc2U8dm9pZD4ge1xyXG4gIGFjdGlvbnMgPSBzdGF0c0FjdGlvbnM7XHJcbiAgY29uc3QgcGFuZWwgPSBtb2RhbC5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIi5zYi1zdGF0cy10YWJcIik7XHJcbiAgY29uc3QgY29udGVudCA9IG1vZGFsLnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiI3NiLXN0YXRzLWNvbnRlbnRcIik7XHJcbiAgaWYgKCFwYW5lbCB8fCAhY29udGVudCkgcmV0dXJuO1xyXG5cclxuICBpZiAoaXNFbG9TZXR1cFBlbmRpbmcoKSkge1xyXG4gICAgY29udGVudC5pbm5lckhUTUwgPSBgPHAgY2xhc3M9XCJzYi1zdGF0cy1lbXB0eVwiPlN0YXRzIHNob3cgb25jZSB0aGUgRUxPIHNldHVwIG9uIHRoZSBCYXR0bGUgdGFiIGlzIGRvbmUuPC9wPmA7XHJcbiAgICByZXR1cm47XHJcbiAgfVxyXG4gIGlmICghY29udGVudC5xdWVyeVNlbGVjdG9yKFwiLnNiLXN0YXRzLXNlY3Rpb25cIikpIGNvbnRlbnQuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9XCJzYi1sb2FkaW5nXCI+TG9hZGluZyBzdGF0cy4uLjwvZGl2PmA7XHJcblxyXG4gIHRyeSB7XHJcbiAgICBzY2VuZXMgPSAoYXdhaXQgZ2V0QWxsU2NlbmVzQ2FjaGVkKCkpLnNjZW5lcyA/PyBbXTtcclxuICB9IGNhdGNoIChlKSB7XHJcbiAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0gQ291bGRuJ3QgbG9hZCBzY2VuZXMgZm9yIHN0YXRzOlwiLCBlKTtcclxuICAgIGNvbnRlbnQuaW5uZXJIVE1MID0gYDxwIGNsYXNzPVwic2Itc3RhdHMtZW1wdHlcIj5Db3VsZG4ndCBsb2FkIHlvdXIgc2NlbmVzLiBTd2l0Y2ggdGFicyB0byB0cnkgYWdhaW4uPC9wPmA7XHJcbiAgICByZXR1cm47XHJcbiAgfVxyXG4gIHRyeSB7XHJcbiAgICAoeyBzY2VuZXM6IGxlYXN0VGVzdGVkU2NlbmVzLCBmaWx0ZXJlZDogbGVhc3RUZXN0ZWRGaWx0ZXJlZCB9ID0gYXdhaXQgbGVhc3RUZXN0ZWRTb3VyY2UoKSk7XHJcbiAgfSBjYXRjaCB7XHJcbiAgICBsZWFzdFRlc3RlZFNjZW5lcyA9IHNjZW5lcztcclxuICAgIGxlYXN0VGVzdGVkRmlsdGVyZWQgPSBmYWxzZTtcclxuICB9XHJcbiAgaWYgKCFzY2VuZXMuc29tZSgocykgPT4gZWxvKHMpICE9PSBudWxsKSkge1xyXG4gICAgY29udGVudC5pbm5lckhUTUwgPSBgPHAgY2xhc3M9XCJzYi1zdGF0cy1lbXB0eVwiPk5vIHNjZW5lIGhhcyBhbiBFTE8geWV0LjwvcD5gO1xyXG4gICAgcmV0dXJuO1xyXG4gIH1cclxuICBjb25zdCB0aWVycyA9IHRpZXJNYXAoc2NlbmVzKTtcclxuICBlbnRyaWVzQnlJZCA9IG5ldyBNYXAoZXhwbG9yZUVudHJpZXMoc2NlbmVzLCB0aWVycywgcmVzb2x2ZVNjZW5lVGl0bGUpLm1hcCgoZW50cnkpID0+IFtlbnRyeS5zY2VuZS5pZCwgZW50cnldKSk7XHJcblxyXG4gIGNvbnRlbnQuaW5uZXJIVE1MID0gW1xyXG4gICAgc2VjdGlvbihcIk92ZXJ2aWV3XCIsIG92ZXJ2aWV3SHRtbCgpKSxcclxuICAgIHNlY3Rpb24oXCJIb3cgc2V0dGxlZCB0aGUgcmFua2luZ3MgYXJlXCIsIHNldHRsZWRIdG1sKCkpLFxyXG4gICAgc2VjdGlvbihcclxuICAgICAgXCJFTE8gZGlzdHJpYnV0aW9uXCIsXHJcbiAgICAgIGA8ZGl2IGNsYXNzPVwic2ItY2hhcnRcIiBpZD1cInNiLXN0YXRzLWhpc3RvZ3JhbVwiPjwvZGl2PiR7ZGlzdHJpYnV0aW9uTm90ZSgpfTxwIGNsYXNzPVwic2Itc3RhdHMtbm90ZVwiPkNsaWNrIGEgYmFyIHRvIHNlZSBpdHMgc2NlbmVzIGluIEV4cGxvcmUuPC9wPmAsXHJcbiAgICApLFxyXG4gICAgc2VjdGlvbihcclxuICAgICAgXCJIaWRkZW4gZ2VtcyBhbmQgb3ZlcnBsYXllZFwiLFxyXG4gICAgICBgPHAgY2xhc3M9XCJzYi1zdGF0cy1ub3RlIHNiLXN0YXRzLWludHJvXCI+RWFjaCBkb3QgaXMgYSBzY2VuZTogaGlnaGVyIGlzIGEgYmV0dGVyIEVMTywgZnVydGhlciByaWdodCBpcyBwbGF5ZWQgbW9yZS4gVGhlIGRhc2hlZCBsaW5lcyBhcmUgdGhlIG1pZGRsZSBvZiB5b3VyIGxpYnJhcnkuIEhvdmVyIGEgZG90IHRvIHNlZSB0aGUgc2NlbmU7IGNsaWNrIGl0IHRvIG9wZW4gaXQuPC9wPlxyXG4gICAgICAgICAgPGRpdiBjbGFzcz1cInNiLWNoYXJ0XCIgaWQ9XCJzYi1zdGF0cy1zY2F0dGVyXCI+PC9kaXY+YCxcclxuICAgICksXHJcbiAgXS5qb2luKFwiXCIpO1xyXG4gIGRyYXdDaGFydHMocGFuZWwpO1xyXG4gIGJpbmRFdmVudHMoY29udGVudCk7XHJcbn1cclxuIiwgIi8vIENvcmUgY29tcGFyaXNvbiBVSTogbGF5b3V0LCBwYWlyIHJlbmRlcmluZywgY2hvaWNlIGhhbmRsaW5nLCBhbmltYXRpb25zLlxyXG5cclxuaW1wb3J0IHsgY2xlYXJGaWx0ZXJlZENhY2hlLCBsYXRlc3RTY2VuZSwgcmVmcmVzaFNjZW5lSW5DYWNoZSwgcmVtb3ZlU2NlbmVFdmVyeXdoZXJlIH0gZnJvbSBcIi4uL2NhY2hlXCI7XHJcbmltcG9ydCB7IENIQU1QSU9OX1VOUkFURURfRUxPLCBDTElNQl9TTUFMTF9QT09MX1dBUk5fQVQsIFVQU0VUX01BWF9DSEFOQ0UgfSBmcm9tIFwiLi4vY29uc3RhbnRzXCI7XHJcbmltcG9ydCB7IGVsb1Jlc3VsdCwgd2luQ2hhbmNlcyB9IGZyb20gXCIuLi9lbG9cIjtcclxuaW1wb3J0IHsgcmVhZEZpbHRlcnMgfSBmcm9tIFwiLi4vZmlsdGVyc1wiO1xyXG5pbXBvcnQgeyBmZXRjaFNjZW5lQnlJZCB9IGZyb20gXCIuLi9ncmFwaHFsXCI7XHJcbmltcG9ydCB7IG5hdmlnYXRlVG9VcmwgfSBmcm9tIFwiLi4vbmF2aWdhdGlvblwiO1xyXG5pbXBvcnQge1xyXG4gIGZldGNoQ2hhbXBpb25QYWlyLFxyXG4gIGZldGNoUGxhY2VtZW50UGFpcixcclxuICBjdXJyZW50RmlsdGVycyxcclxuICBmZXRjaFN3aXNzUGFpcixcclxuICBwYWlyUmFua3MsXHJcbn0gZnJvbSBcIi4uL3BhaXJzXCI7XHJcbmltcG9ydCB7IHJlY29yZFBsYWNlbWVudFJlc3VsdCB9IGZyb20gXCIuLi9wbGFjZW1lbnRcIjtcclxuaW1wb3J0IHsgZWxvV3JpdGVzU2V0dGxlZCwgcmVzdG9yZUVsbywgd3JpdGVFbG8gfSBmcm9tIFwiLi4vcmF0aW5nXCI7XHJcbmltcG9ydCB7IGZldGNoU2NlbmVGaWVsZHMgfSBmcm9tIFwiLi4vc2NlbmVBY3Rpb25zXCI7XHJcbmltcG9ydCB7IGJhdHRsZXMsIGVmZmVjdGl2ZUVsbywgZWxvRmllbGRzLCBrR2FtZXMgfSBmcm9tIFwiLi4vc2NvcmVcIjtcclxuaW1wb3J0IHsgZ2V0SGFsbE9mRmFtZSwga2VlcE9ubHlIYWxsT2ZGYW1lIH0gZnJvbSBcIi4uL3NldHRpbmdzXCI7XHJcbmltcG9ydCB7IGV4cGxvcmVQb29sV2l0aGluLCBpc0Vsb1NldHVwUGVuZGluZywgaXNSdW5BY3RpdmUsIHJlc2V0UnVuU3RhdGUsIHJlc2V0U2h1ZmZsZSwgc3RhdGUgfSBmcm9tIFwiLi4vc3RhdGVcIjtcclxuaW1wb3J0IHsgY2FjaGVkVGllck1hcCB9IGZyb20gXCIuLi9zdGF0c1wiO1xyXG5pbXBvcnQgeyByZXNvbHZlU2NlbmVUaXRsZSB9IGZyb20gXCIuLi9zY2VuZVRpdGxlXCI7XHJcbmltcG9ydCB7IHNhdmVTdGF0ZSB9IGZyb20gXCIuLi9zdG9yYWdlXCI7XHJcbmltcG9ydCB0eXBlIHsgRWxvRmllbGRzLCBNb2RlLCBQbGFjZW1lbnRSdW4sIFJhbmssIFNjZW5lLCBUaWVyIH0gZnJvbSBcIi4uL3R5cGVzXCI7XHJcbmltcG9ydCB7IGNvbmZpcm1EZWxldGVTY2VuZSB9IGZyb20gXCIuL2RlbGV0ZURpYWxvZ1wiO1xyXG5pbXBvcnQgeyBlc2NhcGVIdG1sIH0gZnJvbSBcIi4vbWluaUNhcmRcIjtcclxuaW1wb3J0IHsgY3JlYXRlU2NlbmVDYXJkIH0gZnJvbSBcIi4vc2NlbmVDYXJkXCI7XHJcbmltcG9ydCB7IHNob3dQbGFjZW1lbnRTY3JlZW4sIHNob3dWaWN0b3J5U2NyZWVuIH0gZnJvbSBcIi4vc2NyZWVuc1wiO1xyXG5pbXBvcnQgeyBjcmVhdGVTZXR0aW5nc1RhYiwgY3JlYXRlVGFiQmFyLCBnZXRBY3RpdmVUYWIgfSBmcm9tIFwiLi9zZXR0aW5nc1BhbmVsXCI7XHJcbmltcG9ydCB7IGNyZWF0ZUV4cGxvcmVUYWIgfSBmcm9tIFwiLi9leHBsb3JlVGFiXCI7XHJcbmltcG9ydCB7IGNyZWF0ZVJlY29yZHNUYWIgfSBmcm9tIFwiLi9yZWNvcmRzVGFiXCI7XHJcbmltcG9ydCB7IGNyZWF0ZVN0YXRzVGFiIH0gZnJvbSBcIi4vc3RhdHNUYWJcIjtcclxuXHJcbmNvbnN0IE1PREVTOiB7IG1vZGU6IE1vZGU7IGljb246IHN0cmluZzsgdGl0bGU6IHN0cmluZzsgZGVzYzogc3RyaW5nOyB0aXA6IHN0cmluZyB9W10gPSBbXHJcbiAge1xyXG4gICAgbW9kZTogXCJzd2lzc1wiLFxyXG4gICAgaWNvbjogXCLimpbvuI9cIixcclxuICAgIHRpdGxlOiBcIlN3aXNzXCIsXHJcbiAgICBkZXNjOiBcIkZhaXIgbWF0Y2h1cHNcIixcclxuICAgIHRpcDogXCJFYWNoIHNjZW5lIGZhY2VzIGFuIG9wcG9uZW50IHdpdGggYSBzaW1pbGFyIEVMTy4gQm90aCBzY2VuZXMnIEVMTyBjaGFuZ2VzIGFmdGVyIGV2ZXJ5IHBpY2ssIGFuZCBldmVyeSBzY2VuZSBzdGF5cyBpbiB0aGUgcm90YXRpb24uXCIsXHJcbiAgfSxcclxuICB7XHJcbiAgICBtb2RlOiBcInBsYWNlbWVudFwiLFxyXG4gICAgaWNvbjogXCLwn5ONXCIsXHJcbiAgICB0aXRsZTogXCJQbGFjZW1lbnRcIixcclxuICAgIGRlc2M6IFwiUGxhY2UgYSBzY2VuZVwiLFxyXG4gICAgdGlwOiBcIkZpbmRzIHdoZXJlIG9uZSBzY2VuZSBiZWxvbmdzLiBFYWNoIHBpY2sgbmFycm93cyB0aGUgcmFuZ2Ugb2YgcmFua3MgaXQgY291bGQgbGFuZCBpbiAoc2hvd24gb24gaXRzIGNhcmQpIHVudGlsIGl0cyBzcG90IGlzIGZvdW5kLCBhYm91dCAxMCBwaWNrcyBmb3IgYW4gdW5yYXRlZCBzY2VuZS5cXG5cXG5Mb29raW5nIGZvciBHYXVudGxldD8gVHVybiBvbiDigJxQbGFjZW1lbnQ6IHN0YXJ0IGZyb20gdGhlIGJvdHRvbeKAnSBpbiBTZXR0aW5ncyB0byBtYWtlIGEgc2NlbmUgY2xpbWIgdGhlIGxhZGRlciBmcm9tIHRoZSBib3R0b20uXCIsXHJcbiAgfSxcclxuICB7XHJcbiAgICBtb2RlOiBcImNoYW1waW9uXCIsXHJcbiAgICBpY29uOiBcIvCfj4ZcIixcclxuICAgIHRpdGxlOiBcIkNoYW1waW9uXCIsXHJcbiAgICBkZXNjOiBcIldpbm5lciBzdGF5cyBvblwiLFxyXG4gICAgdGlwOiBcIldpbm5lciBzdGF5cyBvbjogdGhlIHNjZW5lIHlvdSBwaWNrIGtlZXBzIGRlZmVuZGluZyBhZ2FpbnN0IG5ldyBjaGFsbGVuZ2VycyB1bnRpbCBpdCdzIGJlYXRlbiwgdGhlbiB0aGUgd2lubmVyIHRha2VzIG92ZXIuIEJvdGggc2NlbmVzJyBFTE8gY2hhbmdlcyBhZnRlciBldmVyeSBwaWNrLlwiLFxyXG4gIH0sXHJcbl07XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlTWFpblVJKCk6IHN0cmluZyB7XHJcbiAgY29uc3QgbW9kZUJ1dHRvbnMgPSBNT0RFUy5tYXAoXHJcbiAgICAoeyBtb2RlLCBpY29uLCB0aXRsZSwgZGVzYywgdGlwIH0pID0+IGBcclxuICAgICAgICAgICAgPGJ1dHRvbiBjbGFzcz1cInNiLW1vZGUtYnRuICR7c3RhdGUuY3VycmVudE1vZGUgPT09IG1vZGUgPyBcImFjdGl2ZVwiIDogXCJcIn1cIiBkYXRhLW1vZGU9XCIke21vZGV9XCIgZGF0YS10aXA9XCIke3RpcH1cIiBhcmlhLWRlc2NyaXB0aW9uPVwiJHt0aXB9XCI+XHJcbiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9XCJzYi1tb2RlLWljb25cIj4ke2ljb259PC9zcGFuPlxyXG4gICAgICAgICAgICAgIDxzcGFuIGNsYXNzPVwic2ItbW9kZS10aXRsZVwiPiR7dGl0bGV9PC9zcGFuPlxyXG4gICAgICAgICAgICAgIDxzcGFuIGNsYXNzPVwic2ItbW9kZS1kZXNjXCI+JHtkZXNjfTwvc3Bhbj5cclxuICAgICAgICAgICAgPC9idXR0b24+YCxcclxuICApLmpvaW4oXCJcIik7XHJcblxyXG4gIHJldHVybiBgXHJcbiAgICAgIDxkaXYgaWQ9XCJzdGFzaC1iYXR0bGUtY29udGFpbmVyXCIgY2xhc3M9XCJzYi1jb250YWluZXJcIj5cclxuICAgICAgICA8ZGl2IGNsYXNzPVwic2ItaGVhZGVyXCI+XHJcbiAgICAgICAgICA8aDEgY2xhc3M9XCJzYi10aXRsZVwiPuKalO+4jyBTdGFzaCBCYXR0bGU8L2gxPlxyXG4gICAgICAgICAgJHtjcmVhdGVUYWJCYXIoKX1cclxuICAgICAgICA8L2Rpdj5cclxuICAgICAgICA8cCBpZD1cInNiLXRlc3Qtbm90ZVwiIGNsYXNzPVwic2ItcG9vbC1zdGF0dXMgc2ItdGVzdC1ub3RlXCIgaGlkZGVuPlxyXG4gICAgICAgICAg8J+nqiA8c3Ryb25nPlRlc3QgbW9kZTwvc3Ryb25nPjogbm90aGluZyBpcyBzYXZlZCB0byBTdGFzaCDCtyA8YSBocmVmPVwiI1wiIGRhdGEtYWN0aW9uPVwib3Blbi1zZXR0aW5nc1wiPnR1cm4gb2ZmIGluIFNldHRpbmdzPC9hPlxyXG4gICAgICAgIDwvcD5cclxuXHJcbiAgICAgICAgPGRpdiBjbGFzcz1cInNiLXRhYi1wYW5lbFwiIGRhdGEtcGFuZWw9XCJiYXR0bGVcIj5cclxuICAgICAgICAgIDxkaXYgaWQ9XCJzYi1zZXR1cC1hcmVhXCIgY2xhc3M9XCJzYi1zZXR1cC1hcmVhXCIgaGlkZGVuPjwvZGl2PlxyXG4gICAgICAgICAgPGRpdiBjbGFzcz1cInNiLW1vZGUtcm93XCI+XHJcbiAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1tb2RlLXRvZ2dsZVwiPiR7bW9kZUJ1dHRvbnN9XHJcbiAgICAgICAgICAgIDwvZGl2PlxyXG4gICAgICAgICAgICA8YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cInNiLW1vZGUtaW5mby1idG5cIiBhcmlhLWNvbnRyb2xzPVwic2ItbW9kZS1pbmZvXCIgYXJpYS1leHBhbmRlZD1cImZhbHNlXCIgYXJpYS1sYWJlbD1cIldoYXQgZG9lcyB0aGlzIG1vZGUgZG8/XCI+4pOYPC9idXR0b24+XHJcbiAgICAgICAgICA8L2Rpdj5cclxuICAgICAgICAgIDxwIGlkPVwic2ItbW9kZS1pbmZvXCIgY2xhc3M9XCJzYi1tb2RlLWluZm9cIiBoaWRkZW4+PC9wPlxyXG5cclxuICAgICAgICAgIDxwIGlkPVwic2ItY2xpbWItcG9vbC13YXJuaW5nXCIgY2xhc3M9XCJzYi1jbGltYi13YXJuaW5nXCIgaGlkZGVuPlxyXG4gICAgICAgICAgICBDaGFtcGlvbiBjYW4gYmVoYXZlIG9kZGx5IHdpdGggc21hbGwgZmlsdGVyZWQgcG9vbHMgd2hlbiBib3RoIHNpZGVzIHVzZSB0aGUgZmlsdGVyXHJcbiAgICAgICAgICAgIChmZXdlciB0aGFuICR7Q0xJTUJfU01BTExfUE9PTF9XQVJOX0FUfSBzY2VuZXMpLiBVc2UgYSBsYXJnZXIgZmlsdGVyLCBvciB0dXJuIG9mZlxyXG4gICAgICAgICAgICBcIlVzZSBmaWx0ZXJlZCBzY2VuZXMgZm9yIGJvdGggc2lkZXNcIiBpbiBTZXR0aW5ncy5cclxuICAgICAgICAgIDwvcD5cclxuXHJcbiAgICAgICAgICA8cCBpZD1cInNiLXBvb2wtc3RhdHVzXCIgY2xhc3M9XCJzYi1wb29sLXN0YXR1c1wiIGhpZGRlbj48L3A+XHJcbiAgICAgICAgICA8cCBpZD1cInNiLXJhdGluZ3Mtbm90ZVwiIGNsYXNzPVwic2ItcG9vbC1zdGF0dXMgc2ItcmF0aW5ncy1ub3RlXCIgaGlkZGVuPlxyXG4gICAgICAgICAgICBTdGFzaCByYXRpbmdzIGFyZW4ndCBiZWluZyBjaGFuZ2VkIMK3IDxhIGhyZWY9XCIjXCIgZGF0YS1hY3Rpb249XCJvcGVuLXNldHRpbmdzXCI+Y2hhbmdlIGluIFNldHRpbmdzPC9hPlxyXG4gICAgICAgICAgPC9wPlxyXG5cclxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1jb250ZW50XCI+XHJcbiAgICAgICAgICAgIDxkaXYgaWQ9XCJzYi1jb21wYXJpc29uLWFyZWFcIiBjbGFzcz1cInNiLWNvbXBhcmlzb24tYXJlYVwiPlxyXG4gICAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1sb2FkaW5nXCI+TG9hZGluZyBzY2VuZXMuLi48L2Rpdj5cclxuICAgICAgICAgICAgPC9kaXY+XHJcbiAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1hY3Rpb25zXCI+XHJcbiAgICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNiLWFjdGlvbi1idXR0b25zXCI+XHJcbiAgICAgICAgICAgICAgICA8YnV0dG9uIGlkPVwic2ItdW5kby1idG5cIiBjbGFzcz1cImJ0biBidG4tc2Vjb25kYXJ5XCIgdGl0bGU9XCJVbmRvIHlvdXIgbGFzdCBwaWNrIChCYWNrc3BhY2UpXCIgZGlzYWJsZWQ+4oa2IFVuZG88L2J1dHRvbj5cclxuICAgICAgICAgICAgICAgIDxidXR0b24gaWQ9XCJzYi1za2lwLWJ0blwiIGNsYXNzPVwiYnRuIGJ0bi1zZWNvbmRhcnlcIj5Ta2lwPC9idXR0b24+XHJcbiAgICAgICAgICAgICAgICA8YnV0dG9uIGlkPVwic2ItcmVmcmVzaC1jYWNoZS1idG5cIiBjbGFzcz1cImJ0biBidG4tc2Vjb25kYXJ5XCIgdGl0bGU9XCJSZWZyZXNoIHNjZW5lIGxpc3QgZnJvbSBzZXJ2ZXIgKHVzZSBpZiB5b3UndmUgYWRkZWQgbmV3IHNjZW5lcylcIj7wn5SEIFJlZnJlc2g8L2J1dHRvbj5cclxuICAgICAgICAgICAgICA8L2Rpdj5cclxuICAgICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2Ita2V5Ym9hcmQtaGludFwiPlxyXG4gICAgICAgICAgICAgICAgPHNwYW4+4oaQPC9zcGFuPiBjaG9vc2UgbGVmdCDCt1xyXG4gICAgICAgICAgICAgICAgPHNwYW4+4oaSPC9zcGFuPiBjaG9vc2UgcmlnaHQgwrdcclxuICAgICAgICAgICAgICAgIDxzcGFuPlNwYWNlPC9zcGFuPiBza2lwIMK3XHJcbiAgICAgICAgICAgICAgICA8c3Bhbj7ijKs8L3NwYW4+IHVuZG9cclxuICAgICAgICAgICAgICA8L2Rpdj5cclxuICAgICAgICAgICAgPC9kaXY+XHJcbiAgICAgICAgICA8L2Rpdj5cclxuICAgICAgICA8L2Rpdj5cclxuXHJcbiAgICAgICAgJHtjcmVhdGVFeHBsb3JlVGFiKCl9XHJcbiAgICAgICAgJHtjcmVhdGVTdGF0c1RhYigpfVxyXG4gICAgICAgICR7Y3JlYXRlUmVjb3Jkc1RhYigpfVxyXG4gICAgICAgICR7Y3JlYXRlU2V0dGluZ3NUYWIoKX1cclxuICAgICAgPC9kaXY+XHJcbiAgICBgO1xyXG59XHJcblxyXG4vKiogVG91Y2ggc2NyZWVucyBoYXZlIG5vIGhvdmVyIHRvb2x0aXBzOiB0aGUg4pOYIGJ1dHRvbiBzaG93cyB0aGUgY3VycmVudCBtb2RlJ3MgZXhwbGFuYXRpb24gaGVyZS4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHVwZGF0ZU1vZGVJbmZvKCk6IHZvaWQge1xyXG4gIGNvbnN0IGluZm8gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInNiLW1vZGUtaW5mb1wiKTtcclxuICBjb25zdCBtb2RlID0gTU9ERVMuZmluZCgobSkgPT4gbS5tb2RlID09PSBzdGF0ZS5jdXJyZW50TW9kZSk7XHJcbiAgaWYgKGluZm8gJiYgbW9kZSkgaW5mby5pbm5lckhUTUwgPSBgPHN0cm9uZz4ke21vZGUuaWNvbn0gJHttb2RlLnRpdGxlfTo8L3N0cm9uZz4gJHttb2RlLnRpcC5yZXBsYWNlKC9cXG4vZywgXCI8YnI+XCIpfWA7XHJcbn1cclxuXHJcbi8qKiBCYXR0bGUgdGFiIG5vdGUgd2hpbGUgdGhlIFwiU3Rhc2ggcmF0aW5nc1wiIHNldHRpbmcgaXMgXCJEb24ndCB1cGRhdGVcIiwgYW5kIG9uIGV2ZXJ5IHRhYiwgdGVzdCBtb2RlJ3MuICovXHJcbmV4cG9ydCBmdW5jdGlvbiB1cGRhdGVSYXRpbmdzTm90ZSgpOiB2b2lkIHtcclxuICBjb25zdCBub3RlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzYi1yYXRpbmdzLW5vdGVcIik7XHJcbiAgaWYgKG5vdGUpIG5vdGUuaGlkZGVuID0gc3RhdGUuc2V0dGluZ3Muc3Rhc2hSYXRpbmdzICE9PSBcIm9mZlwiO1xyXG4gIGNvbnN0IHRlc3QgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInNiLXRlc3Qtbm90ZVwiKTtcclxuICBpZiAodGVzdCkgdGVzdC5oaWRkZW4gPSAhc3RhdGUuc2V0dGluZ3MudGVzdE1vZGU7XHJcbn1cclxuXHJcbi8qKiBXaG8gYSBTY2VuZXMgcGFnZSBmaWx0ZXIncyBzY2VuZXMgYmF0dGxlLCB3b3JkZWQgYXMgZm9yIGEgYmF0dGxlZCBFeHBsb3JlIGZpbHRlci4gKi9cclxuZnVuY3Rpb24gZmlsdGVyT3Bwb25lbnRzVGV4dCgpOiBzdHJpbmcge1xyXG4gIHJldHVybiBzdGF0ZS5zZXR0aW5ncy5maWx0ZXJPcHBvbmVudHMgPyBcIiDCtyBhZ2FpbnN0IGVhY2ggb3RoZXJcIiA6IFwiIMK3IGFnYWluc3QgeW91ciB3aG9sZSBsaWJyYXJ5XCI7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBcIldoaWNoIHNjZW5lcyBhbSBJIHJhdGluZz9cIiBsaW5lIGFib3ZlIHRoZSBjYXJkczogYSBiYXR0bGVkIEV4cGxvcmUgZmlsdGVyLCB0aGUgbGVhc3QtdGVzdGVkXHJcbiAqIChTdGF0cyksIHRoZSBTY2VuZXMgcGFnZSBmaWx0ZXIsIG9yIHRoZSB3aG9sZSBsaWJyYXJ5LiBPbmUgbGluZSwgd2hpY2hldmVyIGFwcGxpZXMuXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gdXBkYXRlUG9vbFN0YXR1cygpOiB2b2lkIHtcclxuICBjb25zdCBzdGF0dXMgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInNiLXBvb2wtc3RhdHVzXCIpO1xyXG4gIGlmICghc3RhdHVzKSByZXR1cm47XHJcbiAgY29uc3QgY291bnQgPSBzdGF0ZS5sZWZ0UG9vbFNpemU7XHJcbiAgY29uc3QgY291bnRIdG1sID1cclxuICAgIGNvdW50ID09PSBudWxsID8gXCJcIiA6IGAgwrcgPHN0cm9uZz4ke2NvdW50fSBzY2VuZSR7Y291bnQgPT09IDEgPyBcIlwiIDogXCJzXCJ9PC9zdHJvbmc+YDtcclxuXHJcbiAgY29uc3QgcG9vbCA9IHN0YXRlLmV4cGxvcmVQb29sO1xyXG4gIGlmIChwb29sPy5zY2VuZUlkKSB7XHJcbiAgICBjb25zdCBzY2VuZSA9IHN0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcz8uZmluZCgocykgPT4gcy5pZCA9PT0gcG9vbC5zY2VuZUlkKTtcclxuICAgIGNvbnN0IG5hbWUgPSBzY2VuZSA/IGA6IDxzdHJvbmc+JHtlc2NhcGVIdG1sKHJlc29sdmVTY2VuZVRpdGxlKHNjZW5lKSl9PC9zdHJvbmc+YCA6IFwiXCI7XHJcbiAgICBzdGF0dXMuaW5uZXJIVE1MID0gYEJhdHRsaW5nIG9uZSBzY2VuZSR7bmFtZX0gwrcgYWdhaW5zdCB5b3VyIHdob2xlIGxpYnJhcnkgwrcgPGEgaHJlZj1cIiNcIiBkYXRhLWFjdGlvbj1cInN0b3AtZXhwbG9yZS1wb29sXCI+U3RvcDwvYT5gO1xyXG4gIH0gZWxzZSBpZiAocG9vbCkge1xyXG4gICAgY29uc3QgYWdhaW5zdCA9IGV4cGxvcmVQb29sV2l0aGluKCkgPyBcImFnYWluc3QgZWFjaCBvdGhlclwiIDogXCJhZ2FpbnN0IHlvdXIgd2hvbGUgbGlicmFyeVwiO1xyXG4gICAgc3RhdHVzLmlubmVySFRNTCA9IGBCYXR0bGluZyBmcm9tIEV4cGxvcmU6IDxzdHJvbmc+JHtwb29sLmxhYmVsfTwvc3Ryb25nPiR7Y291bnRIdG1sfSDCtyAke2FnYWluc3R9IMK3IDxhIGhyZWY9XCIjXCIgZGF0YS1hY3Rpb249XCJzdG9wLWV4cGxvcmUtcG9vbFwiPlN0b3A8L2E+YDtcclxuICB9IGVsc2UgaWYgKHN0YXRlLmxlYXN0VGVzdGVkKSB7XHJcbiAgICBjb25zdCBmaWx0ZXJlZCA9IHJlYWRGaWx0ZXJzKCkuZmlsdGVyQWN0aXZlO1xyXG4gICAgY29uc3QgZnJvbSA9IGZpbHRlcmVkID8gYHlvdXIgU2NlbmVzIHBhZ2UgZmlsdGVyJHtjb3VudEh0bWx9JHtmaWx0ZXJPcHBvbmVudHNUZXh0KCl9YCA6IGB5b3VyIHdob2xlIGxpYnJhcnkke2NvdW50SHRtbH1gO1xyXG4gICAgc3RhdHVzLmlubmVySFRNTCA9IGBCYXR0bGluZyB5b3VyIGxlYXN0LXRlc3RlZCBzY2VuZXMgZmlyc3QsIGZyb20gJHtmcm9tfSDCtyA8YSBocmVmPVwiI1wiIGRhdGEtYWN0aW9uPVwic3RvcC1sZWFzdC10ZXN0ZWRcIj5TdG9wPC9hPmA7XHJcbiAgfSBlbHNlIGlmIChyZWFkRmlsdGVycygpLmZpbHRlckFjdGl2ZSkge1xyXG4gICAgc3RhdHVzLmlubmVySFRNTCA9IGBSYXRpbmcgc2NlbmVzIGZyb20geW91ciBTY2VuZXMgcGFnZSBmaWx0ZXIke2NvdW50SHRtbH0ke2ZpbHRlck9wcG9uZW50c1RleHQoKX1gO1xyXG4gIH0gZWxzZSB7XHJcbiAgICBzdGF0dXMuaW5uZXJIVE1MID0gYFJhdGluZyBzY2VuZXMgZnJvbSB5b3VyIHdob2xlIGxpYnJhcnkke2NvdW50SHRtbH08c3BhbiBjbGFzcz1cInNiLXBvb2wtaGludFwiPiDCtyBmaWx0ZXIgdGhlIFNjZW5lcyBwYWdlIHRvIG5hcnJvdyBpdCBkb3duPC9zcGFuPmA7XHJcbiAgfVxyXG4gIHN0YXR1cy5oaWRkZW4gPSBmYWxzZTtcclxufVxyXG5cclxuLyoqIENhcmQgYmFkZ2U6IHRoZSB3aW4gc3RyZWFrIHdoaWxlIGNsaW1iaW5nIG9yIGRlZmVuZGluZywgb3IgUGxhY2VtZW50J3MgbmFycm93aW5nIHJhbmdlLiAqL1xyXG5mdW5jdGlvbiBjbGltYlN0YXR1c0JhZGdlKHNjZW5lOiBTY2VuZSk6IG51bWJlciB8IHN0cmluZyB8IG51bGwge1xyXG4gIGlmIChzdGF0ZS5jdXJyZW50TW9kZSA9PT0gXCJwbGFjZW1lbnRcIikge1xyXG4gICAgY29uc3QgcnVuID0gc3RhdGUucGxhY2VtZW50O1xyXG4gICAgaWYgKHJ1bj8uc2NlbmUuaWQgIT09IHNjZW5lLmlkKSByZXR1cm4gbnVsbDtcclxuICAgIC8vIFwiU3RhcnQgZnJvbSB0aGUgYm90dG9tXCIgcnVucyBzaG93IHRoZSBzdHJlYWsgdW50aWwgdGhlIGZpcnN0IGxvc3NcclxuICAgIGlmIChydW4uZnJvbUJvdHRvbSAmJiBydW4uYmF0dGxlcyA+IDAgJiYgcnVuLnN0cmVhayA9PT0gcnVuLmJhdHRsZXMpIHJldHVybiBydW4uc3RyZWFrO1xyXG4gICAgaWYgKHJ1bi5yYW5nZUhpID09PSBydW4ucmFuZ2VMbykgcmV0dXJuIG51bGw7XHJcbiAgICByZXR1cm4gYPCfk40gTmFycm93aW5nIGJldHdlZW4gIyR7cnVuLnJhbmdlTG8gKyAxfSBhbmQgIyR7cnVuLnJhbmdlSGkgKyAxfWA7XHJcbiAgfVxyXG4gIGlmIChzdGF0ZS5jdXJyZW50TW9kZSA9PT0gXCJjaGFtcGlvblwiICYmIHN0YXRlLmNoYW1waW9uU2NlbmU/LmlkID09PSBzY2VuZS5pZCkge1xyXG4gICAgcmV0dXJuIHN0YXRlLmNoYW1waW9uV2lucztcclxuICB9XHJcbiAgcmV0dXJuIG51bGw7XHJcbn1cclxuXHJcbi8qKiBQcmVjb21wdXRlZCB3aW5uZXIvbG9zZXIgY29udGV4dCB3aXJlZCBhdCByZW5kZXIgdGltZSBmb3IgZWFjaCBjaG9vc2UgYnV0dG9uLiAqL1xyXG5pbnRlcmZhY2UgU2NlbmVDaG9pY2Uge1xyXG4gIHdpbm5lcjogU2NlbmU7XHJcbiAgbG9zZXI6IFNjZW5lO1xyXG4gIGxlZnQ6IFNjZW5lO1xyXG4gIHJpZ2h0OiBTY2VuZTtcclxuICB3aW5uZXJDYXJkOiBIVE1MRWxlbWVudDtcclxuICBsb3NlckNhcmQ6IEhUTUxFbGVtZW50O1xyXG4gIHdpbm5lclJhbms6IFJhbms7XHJcbiAgbG9zZXJSYW5rOiBSYW5rO1xyXG59XHJcblxyXG5mdW5jdGlvbiBiaW5kU2NlbmVDaG9pY2UoYm9keTogSFRNTEVsZW1lbnQsIGNob2ljZTogU2NlbmVDaG9pY2UpOiB2b2lkIHtcclxuICBib2R5LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiBoYW5kbGVTY2VuZUNob2ljZShjaG9pY2UpKTtcclxufVxyXG5cclxuXHJcbi8qKiBTaG93IG9yIGhpZGUgdGhlIFNraXAgLyBSZWZyZXNoIGJhci4gT25seSBlbmQgc2NyZWVucyBoaWRlIGl0OyBldmVyeSByZW5kZXJlZCBwYWlyIHNob3dzIGl0LiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gc2V0QWN0aW9uc1Zpc2libGUodmlzaWJsZTogYm9vbGVhbik6IHZvaWQge1xyXG4gIGNvbnN0IGFjdGlvbnNFbCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiLnNiLWFjdGlvbnNcIik7XHJcbiAgaWYgKGFjdGlvbnNFbCkgYWN0aW9uc0VsLnN0eWxlLmRpc3BsYXkgPSB2aXNpYmxlID8gXCJcIiA6IFwibm9uZVwiO1xyXG59XHJcblxyXG4vKiogVG91Y2ggZGV2aWNlcyBoYXZlIG5vIGhvdmVyOiB0aHVtYm5haWxzIHRvZ2dsZSB0aGUgcHJldmlldyBpbnN0ZWFkIG9mIG9wZW5pbmcgdGhlIHNjZW5lLiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gaXNUb3VjaERldmljZSgpOiBib29sZWFuIHtcclxuICByZXR1cm4gd2luZG93Lm1hdGNoTWVkaWEoXCIoaG92ZXI6IG5vbmUpXCIpLm1hdGNoZXM7XHJcbn1cclxuXHJcbi8qKiBUaHVtYm5haWwgLyDihpcgbGluayBjbGljazogbmF0aXZlIGxpbmsgZm9yIG5ldyB0YWIgb3IgbW9kaWZpZXIgY2xpY2tzLCBTUEEgbmF2aWdhdGlvbiBvdGhlcndpc2UuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBoYW5kbGVTY2VuZUxpbmtDbGljayhlOiBNb3VzZUV2ZW50LCBsaW5rOiBIVE1MQW5jaG9yRWxlbWVudCk6IHZvaWQge1xyXG4gIGNvbnN0IG5hdGl2ZU5ld1RhYiA9IGxpbmsudGFyZ2V0ID09PSBcIl9ibGFua1wiICYmIHN0YXRlLnNldHRpbmdzLm9wZW5Jbk5ld1RhYjtcclxuICBpZiAobmF0aXZlTmV3VGFiIHx8IGUuY3RybEtleSB8fCBlLm1ldGFLZXkgfHwgZS5zaGlmdEtleSB8fCBlLmJ1dHRvbiAhPT0gMCkgcmV0dXJuO1xyXG4gIGUucHJldmVudERlZmF1bHQoKTtcclxuICBuYXZpZ2F0ZVRvVXJsKGxpbmsuZ2V0QXR0cmlidXRlKFwiaHJlZlwiKSB8fCBcIlwiKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIFNsaWRlciAoMC0xMDApIHRvIG1lZGlhIHZvbHVtZSBvbiBhIGN1YmljIGN1cnZlLCBzbyB0aGUgc2xpZGVyIHRyYWNrcyBwZXJjZWl2ZWQgbG91ZG5lc3MuXHJcbiAqIChTdGFzaCdzIHBsYXllciBpcyBsaW5lYXIsIGJ1dCBnZW5lcmF0ZWQgcHJldmlldyBjbGlwcyBhcmUgbXVjaCBsb3VkZXIgdGhhbiB0aGUgc291cmNlLilcclxuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBzbGlkZXJUb1ZvbHVtZShzbGlkZXI6IG51bWJlcik6IG51bWJlciB7XHJcbiAgcmV0dXJuIE1hdGgucG93KHNsaWRlciAvIDEwMCwgMyk7XHJcbn1cclxuXHJcbi8qKiBBcHBseSB2b2x1bWUvYXV0b3BsYXkgc2V0dGluZ3MgdG8gdGhlIHJlbmRlcmVkIHByZXZpZXcgdmlkZW9zIChob3ZlcmVkIGNhcmQgaXMgYXVkaWJsZSkuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBhcHBseVByZXZpZXdTZXR0aW5ncygpOiB2b2lkIHtcclxuICBjb25zdCB7IHByZXZpZXdWb2x1bWUsIGF1dG9wbGF5UHJldmlld3MgfSA9IHN0YXRlLnNldHRpbmdzO1xyXG4gIGNvbnN0IGJhdHRsZVZpc2libGUgPSBnZXRBY3RpdmVUYWIoKSA9PT0gXCJiYXR0bGVcIjtcclxuICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKFwiLnNiLXZzLWNvbnRhaW5lclwiKT8uY2xhc3NMaXN0LnRvZ2dsZShcInNiLWF1dG9wbGF5XCIsIGF1dG9wbGF5UHJldmlld3MpO1xyXG5cclxuICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PihcIiNzYi1jb21wYXJpc29uLWFyZWEgLnNiLXNjZW5lLWNhcmRcIikuZm9yRWFjaCgoY2FyZCkgPT4ge1xyXG4gICAgY29uc3QgdmlkZW8gPSBjYXJkLnF1ZXJ5U2VsZWN0b3I8SFRNTFZpZGVvRWxlbWVudD4oXCIuc2ItaG92ZXItcHJldmlld1wiKTtcclxuICAgIGlmICghdmlkZW8pIHJldHVybjtcclxuICAgIC8vIFRvdWNoIHNjcmVlbnMga2VlcCBhIHRhcHBlZCBjYXJkIFwiOmhvdmVyXCIgYWZ0ZXJ3YXJkcywgc28gdGhlcmUgb25seSB0aGUgdGFwIHN0YXRlIGNvdW50c1xyXG4gICAgLy8gKG90aGVyd2lzZSB0aGUgc2Vjb25kIHRhcCBjb3VsZG4ndCBtdXRlIHRoZSBwcmV2aWV3KVxyXG4gICAgY29uc3QgaG92ZXJlZCA9ICFpc1RvdWNoRGV2aWNlKCkgJiYgY2FyZC5tYXRjaGVzKFwiOmhvdmVyXCIpO1xyXG4gICAgY29uc3QgYWN0aXZlID0gaG92ZXJlZCB8fCBjYXJkLmNsYXNzTGlzdC5jb250YWlucyhcInNiLXByZXZpZXdpbmdcIik7XHJcbiAgICAvLyBzYi1jYXJkLW11dGVkOiBtdXRlZCBmcm9tIHRoZSBjYXJkJ3Mgb3duIGJ1dHRvbiAodG91Y2gpLCB0aGUgcHJldmlldyBrZWVwcyBwbGF5aW5nXHJcbiAgICBjb25zdCBtdXRlZCA9ICFhY3RpdmUgfHwgcHJldmlld1ZvbHVtZSA9PT0gMCB8fCBjYXJkLmNsYXNzTGlzdC5jb250YWlucyhcInNiLWNhcmQtbXV0ZWRcIik7XHJcbiAgICB2aWRlby52b2x1bWUgPSBzbGlkZXJUb1ZvbHVtZShwcmV2aWV3Vm9sdW1lKTtcclxuICAgIHZpZGVvLm11dGVkID0gbXV0ZWQ7XHJcbiAgICAvLyBUaGUgdG91Y2ggbXV0ZSBidXR0b24gc2hvd3Mgd2hldGhlciB0aGlzIGNhcmQncyBwcmV2aWV3IGlzIGhlYXJkIHJpZ2h0IG5vd1xyXG4gICAgY29uc3QgYnV0dG9uID0gY2FyZC5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIi5zYi1jYXJkLW11dGVcIik7XHJcbiAgICBpZiAoYnV0dG9uKSB7XHJcbiAgICAgIGJ1dHRvbi50ZXh0Q29udGVudCA9IG11dGVkID8gXCLwn5SHXCIgOiBcIvCflIpcIjtcclxuICAgICAgYnV0dG9uLnNldEF0dHJpYnV0ZShcImFyaWEtbGFiZWxcIiwgbXV0ZWQgPyBcIlBsYXkgdGhpcyBwcmV2aWV3IHdpdGggc291bmRcIiA6IFwiTXV0ZSB0aGlzIHByZXZpZXdcIik7XHJcbiAgICB9XHJcbiAgICBpZiAoYmF0dGxlVmlzaWJsZSAmJiAoYXV0b3BsYXlQcmV2aWV3cyB8fCBhY3RpdmUpKSB7XHJcbiAgICAgIGlmICh2aWRlby5wYXVzZWQpIHZpZGVvLnBsYXkoKS5jYXRjaCgoKSA9PiB7fSk7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICB2aWRlby5wYXVzZSgpO1xyXG4gICAgICB2aWRlby5jdXJyZW50VGltZSA9IDA7XHJcbiAgICB9XHJcbiAgfSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGJpbmRQcmV2aWV3KGNhcmQ6IEhUTUxFbGVtZW50KTogdm9pZCB7XHJcbiAgY29uc3QgdmlkZW8gPSBjYXJkLnF1ZXJ5U2VsZWN0b3I8SFRNTFZpZGVvRWxlbWVudD4oXCIuc2ItaG92ZXItcHJldmlld1wiKTtcclxuICBpZiAoIXZpZGVvKSByZXR1cm47XHJcblxyXG4gIGNhcmQuYWRkRXZlbnRMaXN0ZW5lcihcIm1vdXNlZW50ZXJcIiwgKCkgPT4ge1xyXG4gICAgaWYgKGlzVG91Y2hEZXZpY2UoKSkgcmV0dXJuO1xyXG4gICAgaWYgKCFzdGF0ZS5zZXR0aW5ncy5hdXRvcGxheVByZXZpZXdzKSB2aWRlby5jdXJyZW50VGltZSA9IDA7XHJcbiAgICB2aWRlby52b2x1bWUgPSBzbGlkZXJUb1ZvbHVtZShzdGF0ZS5zZXR0aW5ncy5wcmV2aWV3Vm9sdW1lKTtcclxuICAgIHZpZGVvLm11dGVkID0gc3RhdGUuc2V0dGluZ3MucHJldmlld1ZvbHVtZSA9PT0gMDtcclxuICAgIHZpZGVvLnBsYXkoKS5jYXRjaCgoKSA9PiB7fSk7XHJcbiAgfSk7XHJcblxyXG4gIGNhcmQuYWRkRXZlbnRMaXN0ZW5lcihcIm1vdXNlbGVhdmVcIiwgKCkgPT4ge1xyXG4gICAgaWYgKGlzVG91Y2hEZXZpY2UoKSkgcmV0dXJuO1xyXG4gICAgaWYgKHN0YXRlLnNldHRpbmdzLmF1dG9wbGF5UHJldmlld3MpIHtcclxuICAgICAgdmlkZW8ubXV0ZWQgPSB0cnVlO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICB2aWRlby5wYXVzZSgpO1xyXG4gICAgdmlkZW8uY3VycmVudFRpbWUgPSAwO1xyXG4gIH0pO1xyXG59XHJcblxyXG4vKiogVG91Y2g6IHRhcCB0aGUgdGh1bWJuYWlsIHRvIHBsYXkvc3RvcCBpdHMgcHJldmlldyB3aXRoIHNvdW5kICh0aGUg4oaXIG9wZW5zIHRoZSBzY2VuZSkuICovXHJcbmZ1bmN0aW9uIHRvZ2dsZVByZXZpZXcoY2FyZDogSFRNTEVsZW1lbnQpOiB2b2lkIHtcclxuICBjb25zdCBwcmV2aWV3aW5nID0gIWNhcmQuY2xhc3NMaXN0LmNvbnRhaW5zKFwic2ItcHJldmlld2luZ1wiKTtcclxuICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKFwiLnNiLXNjZW5lLWNhcmQuc2ItcHJldmlld2luZ1wiKS5mb3JFYWNoKChjKSA9PiBjLmNsYXNzTGlzdC5yZW1vdmUoXCJzYi1wcmV2aWV3aW5nXCIpKTtcclxuICBjYXJkLmNsYXNzTGlzdC50b2dnbGUoXCJzYi1wcmV2aWV3aW5nXCIsIHByZXZpZXdpbmcpO1xyXG4gIGNhcmQuY2xhc3NMaXN0LnJlbW92ZShcInNiLWNhcmQtbXV0ZWRcIik7XHJcbiAgYXBwbHlQcmV2aWV3U2V0dGluZ3MoKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIFRvdWNoOiB0aGUgY2FyZCdzIG11dGUgYnV0dG9uLiBIZWFyZCDihpIgbXV0ZWQgKHRoZSBwcmV2aWV3IGtlZXBzIHBsYXlpbmcpLiBOb3QgaGVhcmQg4oaSIHRoaXNcclxuICogY2FyZCdzIHByZXZpZXcgcGxheXMgd2l0aCBzb3VuZCAodHVybmluZyB0aGUgcHJldmlldyB2b2x1bWUgYmFjayBvbiBpZiBpdCB3YXMgYXQgMCkuXHJcbiAqL1xyXG5mdW5jdGlvbiB0b2dnbGVDYXJkU291bmQoY2FyZDogSFRNTEVsZW1lbnQpOiB2b2lkIHtcclxuICBjb25zdCB2aWRlbyA9IGNhcmQucXVlcnlTZWxlY3RvcjxIVE1MVmlkZW9FbGVtZW50PihcIi5zYi1ob3Zlci1wcmV2aWV3XCIpO1xyXG4gIGlmICh2aWRlbyAmJiAhdmlkZW8ubXV0ZWQpIHtcclxuICAgIGNhcmQuY2xhc3NMaXN0LmFkZChcInNiLWNhcmQtbXV0ZWRcIik7XHJcbiAgICBhcHBseVByZXZpZXdTZXR0aW5ncygpO1xyXG4gICAgcmV0dXJuO1xyXG4gIH1cclxuICAvLyBUaGUgdGFiIGJhcidzIHNwZWFrZXIgcmVzdG9yZXMgdGhlIHZvbHVtZSBmcm9tIGJlZm9yZSBtdXRpbmdcclxuICBpZiAoc3RhdGUuc2V0dGluZ3MucHJldmlld1ZvbHVtZSA9PT0gMCkgZG9jdW1lbnQucXVlcnlTZWxlY3RvcjxIVE1MQnV0dG9uRWxlbWVudD4oXCIuc2Itdm9sdW1lLWljb25cIik/LmNsaWNrKCk7XHJcbiAgaWYgKGNhcmQuY2xhc3NMaXN0LmNvbnRhaW5zKFwic2ItcHJldmlld2luZ1wiKSkge1xyXG4gICAgY2FyZC5jbGFzc0xpc3QucmVtb3ZlKFwic2ItY2FyZC1tdXRlZFwiKTtcclxuICAgIGFwcGx5UHJldmlld1NldHRpbmdzKCk7XHJcbiAgfSBlbHNlIHtcclxuICAgIHRvZ2dsZVByZXZpZXcoY2FyZCk7XHJcbiAgfVxyXG59XHJcblxyXG4vKipcclxuICogVGhlIFZTIGJldHdlZW4gdGhlIGNhcmRzLCB3aXRoIGVhY2ggc2lkZSdzIHdpbiBjaGFuY2UgdW5kZXIgaXQgKGEgXCJ3aG8ncyBmYXZvdXJlZFwiIGJhcikuXHJcbiAqIFBsYWNlbWVudCBoYXMgbm9uZTogaXRzIHNjZW5lJ3MgRUxPIGRvZXNuJ3QgY2hhbmdlIHBlciBwaWNrLCBhbmQgYW4gdW5yYXRlZCBvbmUgaGFzIG5vIEVMTy5cclxuICovXHJcbmZ1bmN0aW9uIHZzRGl2aWRlcihsZWZ0OiBTY2VuZSwgcmlnaHQ6IFNjZW5lKTogc3RyaW5nIHtcclxuICBpZiAoc3RhdGUuY3VycmVudE1vZGUgPT09IFwicGxhY2VtZW50XCIpIHtcclxuICAgIHJldHVybiBgPGRpdiBjbGFzcz1cInNiLXZzLWRpdmlkZXJcIj48c3BhbiBjbGFzcz1cInNiLXZzLXRleHRcIj5WUzwvc3Bhbj48L2Rpdj5gO1xyXG4gIH1cclxuICBjb25zdCBbbGVmdENoYW5jZSwgcmlnaHRDaGFuY2VdID0gd2luQ2hhbmNlcyhiYXR0bGVFbG8obGF0ZXN0U2NlbmUobGVmdCkpLCBiYXR0bGVFbG8obGF0ZXN0U2NlbmUocmlnaHQpKSk7XHJcbiAgY29uc3QgZmF2b3VyZWQgPSAoY2hhbmNlOiBudW1iZXIpOiBzdHJpbmcgPT4gKGNoYW5jZSA+IDUwID8gXCIgc2ItZmF2b3VyZWRcIiA6IFwiXCIpO1xyXG4gIGNvbnN0IHRpcCA9IGBDaGFuY2UgZWFjaCBzY2VuZSB3aW5zLCBmcm9tIHRoZWlyIEVMTzogbGVmdCAke2xlZnRDaGFuY2V9JSwgcmlnaHQgJHtyaWdodENoYW5jZX0lYDtcclxuICByZXR1cm4gYFxyXG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi12cy1kaXZpZGVyXCI+XHJcbiAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItdnMtc3RhY2tcIiB0aXRsZT1cIiR7dGlwfVwiPlxyXG4gICAgICAgICAgICA8c3BhbiBjbGFzcz1cInNiLXdpbi1jaGFuY2Ugc2Itd2luLWNoYW5jZS1sZWZ0JHtmYXZvdXJlZChsZWZ0Q2hhbmNlKX1cIj4ke2xlZnRDaGFuY2V9JTwvc3Bhbj5cclxuICAgICAgICAgICAgPHNwYW4gY2xhc3M9XCJzYi12cy10ZXh0XCI+VlM8L3NwYW4+XHJcbiAgICAgICAgICAgIDxzcGFuIGNsYXNzPVwic2Itd2luLWNoYW5jZSBzYi13aW4tY2hhbmNlLXJpZ2h0JHtmYXZvdXJlZChyaWdodENoYW5jZSl9XCI+JHtyaWdodENoYW5jZX0lPC9zcGFuPlxyXG4gICAgICAgICAgICA8c3BhbiBjbGFzcz1cInNiLXdpbi1iYXJcIiBhcmlhLWhpZGRlbj1cInRydWVcIj48c3BhbiBzdHlsZT1cIndpZHRoOiAke2xlZnRDaGFuY2V9JVwiPjwvc3Bhbj48L3NwYW4+XHJcbiAgICAgICAgICA8L2Rpdj5cclxuICAgICAgICA8L2Rpdj5gO1xyXG59XHJcblxyXG4vKiogRWFjaCBzY2VuZSdzIHRpZXIgKGZyb20gdGhlIHdob2xlIGxpYnJhcnkncyBFTE8gb3JkZXIpLiAqL1xyXG5mdW5jdGlvbiBwYWlyVGllcnMoc2NlbmVzOiBTY2VuZVtdKTogKFRpZXIgfCBudWxsKVtdIHtcclxuICBjb25zdCBsaWJyYXJ5ID0gc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzO1xyXG4gIGlmICghbGlicmFyeSkgcmV0dXJuIHNjZW5lcy5tYXAoKCkgPT4gbnVsbCk7XHJcbiAgY29uc3QgdGllcnMgPSBjYWNoZWRUaWVyTWFwKGxpYnJhcnkpO1xyXG4gIHJldHVybiBzY2VuZXMubWFwKChzY2VuZSkgPT4gdGllcnMuZ2V0KHNjZW5lLmlkKSA/PyBudWxsKTtcclxufVxyXG5cclxuLy8gU2hhcmVkIHJlbmRlcmluZyBsb2dpYyBmb3IgZGlzcGxheWluZyBhIHBhaXIgb2Ygc2NlbmVzXHJcbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJQYWlyKHNjZW5lczogU2NlbmVbXSwgcmFua3M6IFJhbmtbXSk6IHZvaWQge1xyXG4gIGNvbnN0IGNvbXBhcmlzb25BcmVhID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzYi1jb21wYXJpc29uLWFyZWFcIik7XHJcbiAgaWYgKCFjb21wYXJpc29uQXJlYSkgcmV0dXJuO1xyXG5cclxuICBjb25zdCBzdGF0dXNCYWRnZXMgPSBzY2VuZXMubWFwKGNsaW1iU3RhdHVzQmFkZ2UpO1xyXG4gIGNvbnN0IHRpZXJzID0gcGFpclRpZXJzKHNjZW5lcyk7XHJcblxyXG4gIGNvbXBhcmlzb25BcmVhLmlubmVySFRNTCA9IGBcclxuICAgICAgPGRpdiBjbGFzcz1cInNiLXZzLWNvbnRhaW5lclwiPlxyXG4gICAgICAgICR7Y3JlYXRlU2NlbmVDYXJkKHNjZW5lc1swXSwgXCJsZWZ0XCIsIHJhbmtzWzBdLCBzdGF0dXNCYWRnZXNbMF0sIHRpZXJzWzBdKX1cclxuICAgICAgICAke3ZzRGl2aWRlcihzY2VuZXNbMF0sIHNjZW5lc1sxXSl9XHJcbiAgICAgICAgJHtjcmVhdGVTY2VuZUNhcmQoc2NlbmVzWzFdLCBcInJpZ2h0XCIsIHJhbmtzWzFdLCBzdGF0dXNCYWRnZXNbMV0sIHRpZXJzWzFdKX1cclxuICAgICAgPC9kaXY+XHJcbiAgICBgO1xyXG5cclxuICBjb25zdCBsZWZ0ID0gc2NlbmVzWzBdO1xyXG4gIGNvbnN0IHJpZ2h0ID0gc2NlbmVzWzFdO1xyXG4gIGNvbnN0IGxlZnRDYXJkID0gY29tcGFyaXNvbkFyZWEucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oJy5zYi1zY2VuZS1jYXJkW2RhdGEtc2lkZT1cImxlZnRcIl0nKTtcclxuICBjb25zdCByaWdodENhcmQgPSBjb21wYXJpc29uQXJlYS5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PignLnNiLXNjZW5lLWNhcmRbZGF0YS1zaWRlPVwicmlnaHRcIl0nKTtcclxuICBjb25zdCBsZWZ0Qm9keSA9IGxlZnRDYXJkPy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIi5zYi1zY2VuZS1ib2R5XCIpO1xyXG4gIGNvbnN0IHJpZ2h0Qm9keSA9IHJpZ2h0Q2FyZD8ucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCIuc2Itc2NlbmUtYm9keVwiKTtcclxuXHJcbiAgaWYgKGxlZnQgJiYgcmlnaHQgJiYgbGVmdENhcmQgJiYgcmlnaHRDYXJkICYmIGxlZnRCb2R5ICYmIHJpZ2h0Qm9keSkge1xyXG4gICAgYmluZFNjZW5lQ2hvaWNlKGxlZnRCb2R5LCB7XHJcbiAgICAgIHdpbm5lcjogbGVmdCxcclxuICAgICAgbG9zZXI6IHJpZ2h0LFxyXG4gICAgICBsZWZ0LFxyXG4gICAgICByaWdodCxcclxuICAgICAgd2lubmVyQ2FyZDogbGVmdENhcmQsXHJcbiAgICAgIGxvc2VyQ2FyZDogcmlnaHRDYXJkLFxyXG4gICAgICB3aW5uZXJSYW5rOiByYW5rc1swXSxcclxuICAgICAgbG9zZXJSYW5rOiByYW5rc1sxXSxcclxuICAgIH0pO1xyXG4gICAgYmluZFNjZW5lQ2hvaWNlKHJpZ2h0Qm9keSwge1xyXG4gICAgICB3aW5uZXI6IHJpZ2h0LFxyXG4gICAgICBsb3NlcjogbGVmdCxcclxuICAgICAgbGVmdCxcclxuICAgICAgcmlnaHQsXHJcbiAgICAgIHdpbm5lckNhcmQ6IHJpZ2h0Q2FyZCxcclxuICAgICAgbG9zZXJDYXJkOiBsZWZ0Q2FyZCxcclxuICAgICAgd2lubmVyUmFuazogcmFua3NbMV0sXHJcbiAgICAgIGxvc2VyUmFuazogcmFua3NbMF0sXHJcbiAgICB9KTtcclxuXHJcbiAgICBsZWZ0Q2FyZC5xdWVyeVNlbGVjdG9yKFwiLnNiLWRlbGV0ZS1idG5cIik/LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiB2b2lkIGRlbGV0ZUZyb21CYXR0bGUobGVmdCkpO1xyXG4gICAgcmlnaHRDYXJkLnF1ZXJ5U2VsZWN0b3IoXCIuc2ItZGVsZXRlLWJ0blwiKT8uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHZvaWQgZGVsZXRlRnJvbUJhdHRsZShyaWdodCkpO1xyXG4gIH1cclxuXHJcbiAgY29tcGFyaXNvbkFyZWEucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oXCIuc2Itc2NlbmUtY2FyZFwiKS5mb3JFYWNoKChjYXJkKSA9PiB7XHJcbiAgICBjb25zdCB0aHVtYiA9IGNhcmQucXVlcnlTZWxlY3RvcjxIVE1MQW5jaG9yRWxlbWVudD4oXCIuc2Itc2NlbmUtaW1hZ2UtY29udGFpbmVyXCIpO1xyXG4gICAgdGh1bWI/LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZSkgPT4ge1xyXG4gICAgICBpZiAoaXNUb3VjaERldmljZSgpKSB7XHJcbiAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xyXG4gICAgICAgIHRvZ2dsZVByZXZpZXcoY2FyZCk7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgICB9XHJcbiAgICAgIGhhbmRsZVNjZW5lTGlua0NsaWNrKGUsIHRodW1iKTtcclxuICAgIH0pO1xyXG4gICAgY2FyZC5xdWVyeVNlbGVjdG9yKFwiLnNiLWNhcmQtbXV0ZVwiKT8uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XHJcbiAgICAgIGUucHJldmVudERlZmF1bHQoKTtcclxuICAgICAgdG9nZ2xlQ2FyZFNvdW5kKGNhcmQpO1xyXG4gICAgfSk7XHJcbiAgICBjb25zdCBvcGVuTGluayA9IGNhcmQucXVlcnlTZWxlY3RvcjxIVE1MQW5jaG9yRWxlbWVudD4oXCIuc2Itb3Blbi1saW5rXCIpO1xyXG4gICAgb3Blbkxpbms/LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZSkgPT4ge1xyXG4gICAgICBpZiAoIXN0YXRlLnNldHRpbmdzLm9wZW5Jbk5ld1RhYikgaGFuZGxlU2NlbmVMaW5rQ2xpY2soZSwgb3BlbkxpbmspO1xyXG4gICAgfSk7XHJcbiAgICBiaW5kUHJldmlldyhjYXJkKTtcclxuICB9KTtcclxuICBhcHBseVByZXZpZXdTZXR0aW5ncygpO1xyXG5cclxuICBzZXRBY3Rpb25zVmlzaWJsZSh0cnVlKTtcclxuXHJcbiAgLy8gVXBkYXRlIHNraXAgYnV0dG9uIHN0YXRlXHJcbiAgY29uc3Qgc2tpcEJ0biA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3I8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiI3NiLXNraXAtYnRuXCIpO1xyXG4gIGlmIChza2lwQnRuKSBza2lwQnRuLmRpc2FibGVkID0gaXNSdW5BY3RpdmUoKTtcclxuICB1cGRhdGVVbmRvQnV0dG9uKCk7XHJcbn1cclxuXHJcbi8qKiBTa2lwIHRoZSBjdXJyZW50IHBhaXIgKG5vdCBhbGxvd2VkIG1pZC1ydW4pLiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gc2tpcFBhaXIoKTogdm9pZCB7XHJcbiAgaWYgKGlzUnVuQWN0aXZlKCkgfHwgc3RhdGUuZGlzYWJsZUNob2ljZSkgcmV0dXJuO1xyXG4gIHN0YXRlLmRpc2FibGVDaG9pY2UgPSB0cnVlO1xyXG4gIGlmIChzdGF0ZS5jdXJyZW50TW9kZSAhPT0gXCJzd2lzc1wiKSB7XHJcbiAgICByZXNldFJ1blN0YXRlKCk7XHJcbiAgICBzYXZlU3RhdGUoKTtcclxuICB9XHJcbiAgbG9hZE5ld1BhaXIoKTtcclxufVxyXG5cclxuLyoqIENvdW50cyBwYWlyIGxvYWRzOiBhIGxvYWQgb25seSBzaG93cyBpdHMgcmVzdWx0IGlmIG5vdGhpbmcgbmV3ZXIgKGEgbG9hZCwgYW4gdW5kbykgc3RhcnRlZCBzaW5jZS4gKi9cclxubGV0IHBhaXJMb2FkcyA9IDA7XHJcblxyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbG9hZE5ld1BhaXIoZm9yY2VkTGVmdFNjZW5lSWQ6IHN0cmluZyB8IG51bGwgPSBudWxsKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgLy8gTm8gcG9vbCBsb2FkcyBiZWZvcmUgdGhlIG9uZS10aW1lIEVMTyBzZXR1cCBoYXMgcnVuIChpdCBzaG93cyBpbiBwbGFjZSBvZiB0aGUgYmF0dGxlKVxyXG4gIGlmIChpc0Vsb1NldHVwUGVuZGluZygpKSByZXR1cm47XHJcbiAgc3RhdGUuZGlzYWJsZUNob2ljZSA9IGZhbHNlO1xyXG4gIGNvbnN0IGNvbXBhcmlzb25BcmVhID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzYi1jb21wYXJpc29uLWFyZWFcIik7XHJcbiAgaWYgKCFjb21wYXJpc29uQXJlYSkgcmV0dXJuO1xyXG4gIGNvbnN0IGxvYWQgPSArK3BhaXJMb2FkcztcclxuICBjb25zdCBzdXBlcnNlZGVkID0gKCk6IGJvb2xlYW4gPT4gbG9hZCAhPT0gcGFpckxvYWRzO1xyXG5cclxuICBjb25zb2xlLmxvZyhcclxuICAgIGBbU3Rhc2ggQmF0dGxlXSDwn46uIExvYWRpbmcgbmV3IHBhaXIgKG1vZGU6ICR7c3RhdGUuY3VycmVudE1vZGV9KSR7Zm9yY2VkTGVmdFNjZW5lSWQgPyBgIHdpdGggZm9yY2VkIHNjZW5lICR7Zm9yY2VkTGVmdFNjZW5lSWR9YCA6IFwiXCJ9Li4uYCxcclxuICApO1xyXG4gIGNvbnN0IHN0YXJ0VGltZSA9IERhdGUubm93KCk7XHJcblxyXG4gIC8vIE9ubHkgc2hvdyBsb2FkaW5nIG9uIGZpcnN0IGxvYWQgKHdoZW4gZW1wdHkgb3IgYWxyZWFkeSBzaG93aW5nIGxvYWRpbmcpXHJcbiAgaWYgKCFjb21wYXJpc29uQXJlYS5xdWVyeVNlbGVjdG9yKFwiLnNiLXZzLWNvbnRhaW5lclwiKSkge1xyXG4gICAgY29uc3QgaGFzQ2FjaGUgPSBzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXMgIT09IG51bGw7XHJcbiAgICBjb21wYXJpc29uQXJlYS5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz1cInNiLWxvYWRpbmdcIj4ke2hhc0NhY2hlID8gXCJMb2FkaW5nIHNjZW5lcy4uLlwiIDogXCJMb2FkaW5nIGFuZCBjYWNoaW5nIHNjZW5lcyAoZmlyc3QgbG9hZCBtYXkgdGFrZSBhIG1vbWVudCkuLi5cIn08L2Rpdj5gO1xyXG4gIH1cclxuXHJcbiAgdHJ5IHtcclxuICAgIC8vIEZldGNoIGZvcmNlZCBzY2VuZSBkYXRhIGlmIGEgc2NlbmUgSUQgd2FzIHByb3ZpZGVkXHJcbiAgICBsZXQgZm9yY2VkTGVmdFNjZW5lOiBTY2VuZSB8IG51bGwgPSBudWxsO1xyXG4gICAgaWYgKGZvcmNlZExlZnRTY2VuZUlkKSB7XHJcbiAgICAgIGZvcmNlZExlZnRTY2VuZSA9IGF3YWl0IGZldGNoU2NlbmVCeUlkKGZvcmNlZExlZnRTY2VuZUlkKTtcclxuICAgICAgaWYgKHN1cGVyc2VkZWQoKSkgcmV0dXJuO1xyXG4gICAgICAvLyBGcmVzaCBmcm9tIFN0YXNoOiB0aGUgY2FjaGUgbWF5IGJlIG9sZGVyIChhbm90aGVyIHRhYiksIGFuZCByYW5rcyBhbmQgYmF0dGxlIG1hdGggcmVhZCBpdFxyXG4gICAgICBpZiAoZm9yY2VkTGVmdFNjZW5lKSByZWZyZXNoU2NlbmVJbkNhY2hlKGZvcmNlZExlZnRTY2VuZSk7XHJcbiAgICAgIGlmICghZm9yY2VkTGVmdFNjZW5lKSB7XHJcbiAgICAgICAgY29uc29sZS53YXJuKFwiW1N0YXNoIEJhdHRsZV0gQ291bGQgbm90IGZldGNoIHNjZW5lIGZyb20gVVJMLCBmYWxsaW5nIGJhY2sgdG8gbm9ybWFsIHBhaXJpbmdcIik7XHJcbiAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICBsZXQgc2NlbmVzOiBTY2VuZVtdID0gW107XHJcbiAgICBsZXQgcmFua3M6IFJhbmtbXSA9IFtudWxsLCBudWxsXTtcclxuXHJcbiAgICBpZiAoc3RhdGUuY3VycmVudE1vZGUgPT09IFwicGxhY2VtZW50XCIpIHtcclxuICAgICAgY29uc3QgcGxhY2VtZW50UmVzdWx0ID0gYXdhaXQgZmV0Y2hQbGFjZW1lbnRQYWlyKGZvcmNlZExlZnRTY2VuZSk7XHJcbiAgICAgIGlmIChzdXBlcnNlZGVkKCkpIHJldHVybjtcclxuXHJcbiAgICAgIGlmIChwbGFjZW1lbnRSZXN1bHQuZG9uZSkge1xyXG4gICAgICAgIC8vIEEgY2xpbWIgZnJvbSB0aGUgYm90dG9tIHRoYXQgbmV2ZXIgbG9zdCBoYXMgYmVhdGVuIHRoZSB0b3Agc2NlbmVcclxuICAgICAgICBpZiAocGxhY2VtZW50UmVzdWx0LmZyb21Cb3R0b20gJiYgcGxhY2VtZW50UmVzdWx0LnJhbmsgPT09IDEpIHtcclxuICAgICAgICAgIHNob3dWaWN0b3J5U2NyZWVuKHBsYWNlbWVudFJlc3VsdC5zY2VuZSwgcGxhY2VtZW50UmVzdWx0LnN0cmVhayk7XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgIHNob3dQbGFjZW1lbnRTY3JlZW4ocGxhY2VtZW50UmVzdWx0KTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgICB9XHJcblxyXG4gICAgICBzY2VuZXMgPSBwbGFjZW1lbnRSZXN1bHQuc2NlbmVzO1xyXG4gICAgICByYW5rcyA9IHBsYWNlbWVudFJlc3VsdC5yYW5rcztcclxuICAgIH0gZWxzZSBpZiAoc3RhdGUuY3VycmVudE1vZGUgPT09IFwiY2hhbXBpb25cIikge1xyXG4gICAgICBjb25zdCBjaGFtcGlvblJlc3VsdCA9IGF3YWl0IGZldGNoQ2hhbXBpb25QYWlyKGZvcmNlZExlZnRTY2VuZSk7XHJcbiAgICAgIGlmIChzdXBlcnNlZGVkKCkpIHJldHVybjtcclxuXHJcbiAgICAgIC8vIENoZWNrIGZvciB2aWN0b3J5IChjaGFtcGlvbiBiZWF0IGV2ZXJ5b25lKVxyXG4gICAgICBpZiAoY2hhbXBpb25SZXN1bHQuaXNWaWN0b3J5KSB7XHJcbiAgICAgICAgc2hvd1ZpY3RvcnlTY3JlZW4oY2hhbXBpb25SZXN1bHQuc2NlbmVzWzBdLCBzdGF0ZS5jaGFtcGlvbldpbnMpO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgICAgfVxyXG5cclxuICAgICAgc2NlbmVzID0gY2hhbXBpb25SZXN1bHQuc2NlbmVzO1xyXG4gICAgICByYW5rcyA9IGNoYW1waW9uUmVzdWx0LnJhbmtzO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgY29uc3Qgc3dpc3NSZXN1bHQgPSBhd2FpdCBmZXRjaFN3aXNzUGFpcihmb3JjZWRMZWZ0U2NlbmUpO1xyXG4gICAgICBpZiAoc3VwZXJzZWRlZCgpKSByZXR1cm47XHJcblxyXG4gICAgICBzY2VuZXMgPSBzd2lzc1Jlc3VsdC5zY2VuZXM7XHJcbiAgICAgIHJhbmtzID0gc3dpc3NSZXN1bHQucmFua3M7XHJcbiAgICB9XHJcblxyXG4gICAgaWYgKHNjZW5lcy5sZW5ndGggPCAyKSB7XHJcbiAgICAgIGNvbXBhcmlzb25BcmVhLmlubmVySFRNTCA9ICc8ZGl2IGNsYXNzPVwic2ItZXJyb3JcIj5Ob3QgZW5vdWdoIHNjZW5lcyBhdmFpbGFibGUgZm9yIGNvbXBhcmlzb24uPC9kaXY+JztcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG5cclxuICAgIHN0YXRlLmN1cnJlbnRQYWlyLmxlZnQgPSBzY2VuZXNbMF07XHJcbiAgICBzdGF0ZS5jdXJyZW50UGFpci5yaWdodCA9IHNjZW5lc1sxXTtcclxuICAgIHN0YXRlLmN1cnJlbnRSYW5rcy5sZWZ0ID0gcmFua3NbMF07XHJcbiAgICBzdGF0ZS5jdXJyZW50UmFua3MucmlnaHQgPSByYW5rc1sxXTtcclxuXHJcbiAgICBjb25zdCBsb2FkVGltZSA9IERhdGUubm93KCkgLSBzdGFydFRpbWU7XHJcbiAgICBjb25zb2xlLmxvZyhcclxuICAgICAgYFtTdGFzaCBCYXR0bGVdIOKchSBQYWlyIGxvYWRlZCBpbiAke2xvYWRUaW1lfW1zOiBTY2VuZSAke3NjZW5lc1swXS5pZH0gKHJhbmsgIyR7cmFua3NbMF19KSB2cyBTY2VuZSAke3NjZW5lc1sxXS5pZH0gKHJhbmsgIyR7cmFua3NbMV19KWAsXHJcbiAgICApO1xyXG5cclxuICAgIHJlbmRlclBhaXIoc2NlbmVzLCByYW5rcyk7XHJcbiAgICB1cGRhdGVQb29sU3RhdHVzKCk7XHJcbiAgICB1cGRhdGVDbGltYlBvb2xXYXJuaW5nKCk7XHJcbiAgICBzYXZlU3RhdGUoKTtcclxuICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIEVycm9yIGxvYWRpbmcgc2NlbmVzOlwiLCBlcnJvcik7XHJcbiAgICBjb25zdCBtZXNzYWdlID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xyXG4gICAgY29uc3QgaXNOb1NjZW5lcyA9IG1lc3NhZ2UuaW5jbHVkZXMoXCJObyBzY2VuZXNcIikgfHwgbWVzc2FnZS5pbmNsdWRlcyhcIk5vdCBlbm91Z2hcIik7XHJcbiAgICBjb21wYXJpc29uQXJlYS5pbm5lckhUTUwgPSBgXHJcbiAgICAgICAgPGRpdiBjbGFzcz1cInNiLWVycm9yLXNjcmVlblwiPlxyXG4gICAgICAgICAgPGRpdiBjbGFzcz1cInNiLWVycm9yLWljb25cIj7imqDvuI88L2Rpdj5cclxuICAgICAgICAgIDxwIGNsYXNzPVwic2ItZXJyb3ItbWVzc2FnZVwiPiR7bWVzc2FnZX08L3A+XHJcbiAgICAgICAgICA8YnV0dG9uIGlkPVwic2ItZXJyb3ItcmV0cnlcIiBjbGFzcz1cImJ0biBidG4tcHJpbWFyeVwiPlJldHJ5PC9idXR0b24+XHJcbiAgICAgICAgPC9kaXY+XHJcbiAgICAgIGA7XHJcbiAgICBzZXRBY3Rpb25zVmlzaWJsZSh0cnVlKTtcclxuXHJcbiAgICAvLyBBdHRhY2ggcmV0cnkgaGFuZGxlclxyXG4gICAgY29uc3QgcmV0cnlCdG4gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInNiLWVycm9yLXJldHJ5XCIpIGFzIEhUTUxCdXR0b25FbGVtZW50IHwgbnVsbDtcclxuICAgIGlmIChyZXRyeUJ0bikge1xyXG4gICAgICByZXRyeUJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgYXN5bmMgKCkgPT4ge1xyXG4gICAgICAgIHJldHJ5QnRuLmRpc2FibGVkID0gdHJ1ZTtcclxuICAgICAgICByZXRyeUJ0bi50ZXh0Q29udGVudCA9IFwiTG9hZGluZy4uLlwiO1xyXG5cclxuICAgICAgICBpZiAoaXNOb1NjZW5lcykge1xyXG4gICAgICAgICAgLy8gXCJObyBzY2VuZXNcIiBlcnJvcjogY2xlYXIgZXZlcnl0aGluZyBhbmQgc3RhcnQgZnJlc2hcclxuICAgICAgICAgIGF3YWl0IGNsZWFyRmlsdGVyZWRDYWNoZSgpO1xyXG4gICAgICAgICAgcmVzZXRTaHVmZmxlKCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIC8vIE5ldHdvcmsvb3RoZXIgZXJyb3JzOiBqdXN0IHJldHJ5IHdpdGhvdXQgY2xlYXJpbmcgc2Vzc2lvbiBzdGF0ZVxyXG5cclxuICAgICAgICBhd2FpdCBsb2FkTmV3UGFpcigpO1xyXG4gICAgICB9KTtcclxuICAgIH1cclxuICB9XHJcbn1cclxuXHJcbi8qKiBSZW5kZXIgdGhlIHNhdmVkIHBhaXIsIHVubGVzcyBvbmUgb2YgaXRzIHNjZW5lcyB3YXMgZGVsZXRlZCBpbiBTdGFzaCBtZWFud2hpbGUuICovXHJcbi8qKlxyXG4gKiBXaGV0aGVyIHRoZSBzYXZlZCBwYWlyIGJlbG9uZ3MgdG8gdGhlIGN1cnJlbnQgcnVuLiBBIFBsYWNlbWVudCBwYWlyIGlzIGl0cyBydW4ncyBzY2VuZSBhZ2FpbnN0XHJcbiAqIGFuIG9wcG9uZW50LCBhbmQgYSBDaGFtcGlvbiBwYWlyIGluY2x1ZGVzIHRoZSBjaGFtcGlvbjsgd2l0aG91dCB0aGF0LCBwaWNrcyBoYXZlIG5vdGhpbmcgdG9cclxuICogYWN0IG9uIChhIHJ1biB0aGF0IGVuZGVkLCBzYXkpLlxyXG4gKi9cclxuZnVuY3Rpb24gcGFpck1hdGNoZXNSdW4obGVmdDogU2NlbmUsIHJpZ2h0OiBTY2VuZSk6IGJvb2xlYW4ge1xyXG4gIGlmIChzdGF0ZS5jdXJyZW50TW9kZSA9PT0gXCJwbGFjZW1lbnRcIikgcmV0dXJuIHN0YXRlLnBsYWNlbWVudD8uc2NlbmUuaWQgPT09IGxlZnQuaWQ7XHJcbiAgaWYgKHN0YXRlLmN1cnJlbnRNb2RlID09PSBcImNoYW1waW9uXCIgJiYgc3RhdGUuY2hhbXBpb25TY2VuZSkge1xyXG4gICAgcmV0dXJuIHN0YXRlLmNoYW1waW9uU2NlbmUuaWQgPT09IGxlZnQuaWQgfHwgc3RhdGUuY2hhbXBpb25TY2VuZS5pZCA9PT0gcmlnaHQuaWQ7XHJcbiAgfVxyXG4gIHJldHVybiB0cnVlO1xyXG59XHJcblxyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVzdG9yZUN1cnJlbnRQYWlyKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gIGlmIChpc0Vsb1NldHVwUGVuZGluZygpKSByZXR1cm47XHJcbiAgY29uc3QgbGVmdCA9IHN0YXRlLmN1cnJlbnRQYWlyLmxlZnQgYXMgU2NlbmU7XHJcbiAgY29uc3QgcmlnaHQgPSBzdGF0ZS5jdXJyZW50UGFpci5yaWdodCBhcyBTY2VuZTtcclxuICBpZiAoIXBhaXJNYXRjaGVzUnVuKGxlZnQsIHJpZ2h0KSkge1xyXG4gICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5OCIFNhdmVkIHBhaXIgZG9lc24ndCBiZWxvbmcgdG8gdGhlIGN1cnJlbnQgcnVuLCBsb2FkaW5nIGEgbmV3IHBhaXJcIik7XHJcbiAgICBhd2FpdCBsb2FkTmV3UGFpcigpO1xyXG4gICAgcmV0dXJuO1xyXG4gIH1cclxuICBzdGF0ZS5kaXNhYmxlQ2hvaWNlID0gZmFsc2U7XHJcblxyXG4gIC8vIEFsc28gYnJpbmdzIHRoZSBwYWlyJ3MgRUxPIGFuZCBTdGFzaCByYXRpbmcgdXAgdG8gZGF0ZSAodGhleSBtYXkgaGF2ZSBjaGFuZ2VkIHNpbmNlIGl0IHdhcyBzYXZlZClcclxuICBpZiAoIShhd2FpdCB2ZXJpZnlDdXJyZW50UGFpcigpKSkgcmV0dXJuO1xyXG5cclxuICAvLyBSYW5rcyBmcm9tIHRoZSBjdXJyZW50IHBvb2xzLCBub3QgdGhlIHNhdmVkIG9uZXM6IGJhdHRsZXMgc2luY2UgbWF5IGhhdmUgbW92ZWQgdGhlbS4gTG9hZGluZ1xyXG4gIC8vIHRoZSBwb29scyBhbHNvIHByZS13YXJtcyB0aGVtIGZvciB0aGUgbmV4dCBjaG9pY2UgYW5kIGZpbGxzIGluIHRoZSBzdGF0dXMgbGluZSdzIHBvb2wgc2l6ZS5cclxuICBsZXQgcmFua3M6IFtSYW5rLCBSYW5rXSA9IFtzdGF0ZS5jdXJyZW50UmFua3MubGVmdCwgc3RhdGUuY3VycmVudFJhbmtzLnJpZ2h0XTtcclxuICB0cnkge1xyXG4gICAgcmFua3MgPSBhd2FpdCBwYWlyUmFua3MobGVmdCwgcmlnaHQpO1xyXG4gICAgc3RhdGUuY3VycmVudFJhbmtzID0geyBsZWZ0OiByYW5rc1swXSwgcmlnaHQ6IHJhbmtzWzFdIH07XHJcbiAgfSBjYXRjaCAoZSkge1xyXG4gICAgY29uc29sZS53YXJuKFwiW1N0YXNoIEJhdHRsZV0gQ291bGQgbm90IGxvYWQgc2NlbmUgcG9vbHMgZm9yIHRoZSBzYXZlZCBwYWlyJ3MgcmFua3M6XCIsIGUpO1xyXG4gIH1cclxuXHJcbiAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5OCIFJlbmRlcmluZyBzYXZlZCBwYWlyXCIpO1xyXG4gIHJlbmRlclBhaXIoW2xlZnQsIHJpZ2h0XSwgcmFua3MpO1xyXG4gIHVwZGF0ZVBvb2xTdGF0dXMoKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIENoZWNrIHRoZSBjdXJyZW50IHBhaXIgc3RpbGwgZXhpc3RzIGluIFN0YXNoIChzY2VuZXMgbWF5IGJlIGRlbGV0ZWQgZWxzZXdoZXJlKS4gSWYgb25lIGlzIGdvbmUsXHJcbiAqIGNvbnRpbnVlIHdpdGhvdXQgaXQgYW5kIHJldHVybiBmYWxzZS4gT3RoZXJ3aXNlIHRoZSBwYWlyJ3MgRUxPIGFuZCBTdGFzaCByYXRpbmcgYXJlIGJyb3VnaHQgdXBcclxuICogdG8gZGF0ZSBmcm9tIFN0YXNoLCBpbiBpdHMgb2JqZWN0cyBhbmQgdGhlIGNhY2hlLiBOZXR3b3JrIGVycm9ycyBjb3VudCBhcyBcInN0aWxsIHRoZXJlXCIuXHJcbiAqL1xyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdmVyaWZ5Q3VycmVudFBhaXIoKTogUHJvbWlzZTxib29sZWFuPiB7XHJcbiAgY29uc3QgeyBsZWZ0LCByaWdodCB9ID0gc3RhdGUuY3VycmVudFBhaXI7XHJcbiAgaWYgKCFsZWZ0IHx8ICFyaWdodCkgcmV0dXJuIHRydWU7XHJcbiAgdHJ5IHtcclxuICAgIGNvbnN0IGZyZXNoID0gYXdhaXQgZmV0Y2hTY2VuZUZpZWxkcyhbbGVmdC5pZCwgcmlnaHQuaWRdKTtcclxuICAgIGNvbnN0IGdvbmUgPSBbbGVmdCwgcmlnaHRdLmZpbmQoKHMpID0+ICFmcmVzaC5oYXMocy5pZCkpO1xyXG4gICAgaWYgKGdvbmUpIHtcclxuICAgICAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIPCfkbsgU2NlbmUgJHtnb25lLmlkfSBpbiB0aGUgY3VycmVudCBwYWlyIG5vIGxvbmdlciBleGlzdHNgKTtcclxuICAgICAgYXdhaXQgaGFuZGxlU2NlbmVHb25lKGdvbmUuaWQpO1xyXG4gICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9XHJcbiAgICBmb3IgKGNvbnN0IHNjZW5lIG9mIFtsZWZ0LCByaWdodF0pIHtcclxuICAgICAgY29uc3QgZmllbGRzID0gZnJlc2guZ2V0KHNjZW5lLmlkKTtcclxuICAgICAgaWYgKCFmaWVsZHMpIGNvbnRpbnVlO1xyXG4gICAgICBzY2VuZS5yYXRpbmcxMDAgPSBmaWVsZHMucmF0aW5nMTAwID8/IG51bGw7XHJcbiAgICAgIHNjZW5lLmN1c3RvbV9maWVsZHMgPSBmaWVsZHMuY3VzdG9tX2ZpZWxkcyA/PyB7fTtcclxuICAgICAgcmVmcmVzaFNjZW5lSW5DYWNoZShzY2VuZSk7XHJcbiAgICB9XHJcbiAgfSBjYXRjaCAoZSkge1xyXG4gICAgY29uc29sZS53YXJuKFwiW1N0YXNoIEJhdHRsZV0gQ291bGQgbm90IHZlcmlmeSBjdXJyZW50IHBhaXI6XCIsIGUpO1xyXG4gIH1cclxuICByZXR1cm4gdHJ1ZTtcclxufVxyXG5cclxuLyoqIEZvcmdldCBhIHNjZW5lIGlkIHJlZmVyZW5jZWQgYnkgdGhlIGN1cnJlbnQgcnVuIChpdCBubyBsb25nZXIgZXhpc3RzKS4gKi9cclxuZnVuY3Rpb24gZHJvcEZyb21SdW4oc2NlbmVJZDogc3RyaW5nKTogdm9pZCB7XHJcbiAgc3RhdGUuY2hhbXBpb25EZWZlYXRlZCA9IHN0YXRlLmNoYW1waW9uRGVmZWF0ZWQuZmlsdGVyKChpZCkgPT4gaWQgIT09IHNjZW5lSWQpO1xyXG4gIGNvbnN0IHJ1biA9IHN0YXRlLnBsYWNlbWVudDtcclxuICBpZiAoIXJ1bikgcmV0dXJuO1xyXG4gIGlmIChydW4uYWJvdmVJZCA9PT0gc2NlbmVJZCkgcnVuLmFib3ZlSWQgPSBudWxsO1xyXG4gIGlmIChydW4uYmVsb3dJZCA9PT0gc2NlbmVJZCkgcnVuLmJlbG93SWQgPSBudWxsO1xyXG4gIGlmIChydW4ubGFzdE9wcG9uZW50SWQgPT09IHNjZW5lSWQpIHtcclxuICAgIHJ1bi5sYXN0T3Bwb25lbnRJZCA9IG51bGw7XHJcbiAgICBydW4uZ2FsbG9waW5nID0gZmFsc2U7XHJcbiAgfVxyXG59XHJcblxyXG4vKipcclxuICogQSBzY2VuZSBpbiBwbGF5IG5vIGxvbmdlciBleGlzdHMuIElmIGl0IHdhcyB0aGUgc2NlbmUgYmVpbmcgcmF0ZWQvcGxhY2VkL2NsaW1iaW5nLCBzdGFydCBvdmVyO1xyXG4gKiBvdGhlcndpc2Uga2VlcCB0aGUgb3RoZXIgc2NlbmUgYW5kIGZpbmQgaXQgYSBuZXcgb3Bwb25lbnQuXHJcbiAqL1xyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlU2NlbmVHb25lKHNjZW5lSWQ6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gIGF3YWl0IHJlbW92ZVNjZW5lRXZlcnl3aGVyZShzY2VuZUlkKTtcclxuXHJcbiAgY29uc3QgeyBsZWZ0LCByaWdodCB9ID0gc3RhdGUuY3VycmVudFBhaXI7XHJcbiAgY29uc3QgcnVuU2NlbmVJZHMgPSBbbGVmdD8uaWQsIHN0YXRlLnBsYWNlbWVudD8uc2NlbmUuaWQsIHN0YXRlLmNoYW1waW9uU2NlbmU/LmlkXTtcclxuXHJcbiAgaWYgKHJ1blNjZW5lSWRzLmluY2x1ZGVzKHNjZW5lSWQpKSB7XHJcbiAgICByZXNldFJ1blN0YXRlKCk7XHJcbiAgICBzYXZlU3RhdGUoKTtcclxuICAgIGF3YWl0IGxvYWROZXdQYWlyKCk7XHJcbiAgICByZXR1cm47XHJcbiAgfVxyXG5cclxuICBkcm9wRnJvbVJ1bihzY2VuZUlkKTtcclxuICBzYXZlU3RhdGUoKTtcclxuICAvLyBGb3JjZWQgbGVmdCBvbmx5IGFwcGxpZXMgd2hlbiBubyBydW4gaXMgdW5kZXIgd2F5IChTd2lzcywgb3IgYmVmb3JlIGEgQ2hhbXBpb24gcnVuIHN0YXJ0cylcclxuICBjb25zdCBrZWVwSWQgPSByaWdodD8uaWQgPT09IHNjZW5lSWQgPyBsZWZ0Py5pZCA6IG51bGw7XHJcbiAgYXdhaXQgbG9hZE5ld1BhaXIoa2VlcElkID8/IG51bGwpO1xyXG59XHJcblxyXG4vKiogQ2xlYW4gbW9kZTogU3Rhc2gncyBvd24gZGVsZXRlIGRpYWxvZyBkb2VzIHRoZSBkZWxldGluZzsgdGhlbiBjb250aW51ZSB0aGUgYmF0dGxlIHdpdGhvdXQgaXQuICovXHJcbmFzeW5jIGZ1bmN0aW9uIGRlbGV0ZUZyb21CYXR0bGUoc2NlbmU6IFNjZW5lKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgaWYgKHN0YXRlLmRpc2FibGVDaG9pY2UpIHJldHVybjtcclxuICBjb25zdCBkZWxldGVkID0gYXdhaXQgY29uZmlybURlbGV0ZVNjZW5lKHNjZW5lKTtcclxuICBpZiAoIWRlbGV0ZWQpIHJldHVybjtcclxuXHJcbiAgc3RhdGUuZGlzYWJsZUNob2ljZSA9IHRydWU7XHJcbiAgYXdhaXQgaGFuZGxlU2NlbmVHb25lKHNjZW5lLmlkKTtcclxufVxyXG5cclxuLyoqIEVMTyB1c2VkIGluIGJhdHRsZSBtYXRoOiB1bnJhdGVkIHNjZW5lcyBjb3VudCBhcyBFTE9fU1RBUlQgKDE1MDApIGluIFN3aXNzLCBDSEFNUElPTl9VTlJBVEVEX0VMTyBpbiBDaGFtcGlvbi4gKi9cclxuZnVuY3Rpb24gYmF0dGxlRWxvKHNjZW5lOiBTY2VuZSk6IG51bWJlciB7XHJcbiAgcmV0dXJuIHN0YXRlLmN1cnJlbnRNb2RlID09PSBcImNoYW1waW9uXCIgPyBlZmZlY3RpdmVFbG8oc2NlbmUsIENIQU1QSU9OX1VOUkFURURfRUxPKSA6IGVmZmVjdGl2ZUVsbyhzY2VuZSk7XHJcbn1cclxuXHJcbmludGVyZmFjZSBFbG9DaGFuZ2Uge1xyXG4gIGZyb206IG51bWJlcjtcclxuICB0bzogbnVtYmVyO1xyXG59XHJcblxyXG4vKipcclxuICogVHdvLXNpZGVkIEVMTyBmb3IgYSBwaWNrIChTd2lzcyBhbmQgQ2hhbXBpb24pOiBib3RoIHNjZW5lcycgRUxPIGFuZCBiYXR0bGVzIGNoYW5nZSBhbmQgYXJlXHJcbiAqIHNhdmVkLiBgdXBzZXRgIGlzIHRydWUgd2hlbiB0aGUgd2lubmVyIHdhcyBhIHJlYWwgdW5kZXJkb2cgKHNlZSBVUFNFVF9NQVhfQ0hBTkNFKS5cclxuICovXHJcbmZ1bmN0aW9uIHJlc29sdmVDb21wYXJpc29uKHdpbm5lcjogU2NlbmUsIGxvc2VyOiBTY2VuZSk6IHsgd2lubmVyOiBFbG9DaGFuZ2U7IGxvc2VyOiBFbG9DaGFuZ2U7IHVwc2V0OiBib29sZWFuIH0ge1xyXG4gIC8vIFRoZSBtYXRoIHJlYWRzIHRoZSBjYWNoZWQgY29waWVzOiB0aGUgcGFpcidzIG93biBvYmplY3RzIG1heSBwcmVkYXRlIGEgYmFja2dyb3VuZCByZWZyZXNoXHJcbiAgY29uc3QgbGF0ZXN0V2lubmVyID0gbGF0ZXN0U2NlbmUod2lubmVyKTtcclxuICBjb25zdCBsYXRlc3RMb3NlciA9IGxhdGVzdFNjZW5lKGxvc2VyKTtcclxuICBjb25zdCB3aW5uZXJTaWRlID0geyBlbG86IGJhdHRsZUVsbyhsYXRlc3RXaW5uZXIpLCBrR2FtZXM6IGtHYW1lcyhsYXRlc3RXaW5uZXIpIH07XHJcbiAgY29uc3QgbG9zZXJTaWRlID0geyBlbG86IGJhdHRsZUVsbyhsYXRlc3RMb3NlciksIGtHYW1lczoga0dhbWVzKGxhdGVzdExvc2VyKSB9O1xyXG4gIGNvbnN0IHJlc3VsdCA9IGVsb1Jlc3VsdCh3aW5uZXJTaWRlLCBsb3NlclNpZGUpO1xyXG5cclxuICB2b2lkIHdyaXRlRWxvKHdpbm5lciwgcmVzdWx0Lndpbm5lciwgYmF0dGxlcyhsYXRlc3RXaW5uZXIpICsgMSwgW3RydWVdKTtcclxuICB2b2lkIHdyaXRlRWxvKGxvc2VyLCByZXN1bHQubG9zZXIsIGJhdHRsZXMobGF0ZXN0TG9zZXIpICsgMSwgW2ZhbHNlXSk7XHJcblxyXG4gIHJldHVybiB7XHJcbiAgICB3aW5uZXI6IHsgZnJvbTogd2lubmVyU2lkZS5lbG8sIHRvOiByZXN1bHQud2lubmVyIH0sXHJcbiAgICBsb3NlcjogeyBmcm9tOiBsb3NlclNpZGUuZWxvLCB0bzogcmVzdWx0Lmxvc2VyIH0sXHJcbiAgICB1cHNldDogd2luQ2hhbmNlcyh3aW5uZXJTaWRlLmVsbywgbG9zZXJTaWRlLmVsbylbMF0gPD0gVVBTRVRfTUFYX0NIQU5DRSxcclxuICB9O1xyXG59XHJcblxyXG4vKiogU2hvdyB3aGVuIENoYW1waW9uICsgZmlsdGVyIG9wcG9uZW50cyArIHNtYWxsIGZpbHRlcmVkIHBvb2wuICovXHJcbmV4cG9ydCBmdW5jdGlvbiB1cGRhdGVDbGltYlBvb2xXYXJuaW5nKCk6IHZvaWQge1xyXG4gIGNvbnN0IHdhcm5pbmcgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInNiLWNsaW1iLXBvb2wtd2FybmluZ1wiKTtcclxuICBpZiAoIXdhcm5pbmcpIHJldHVybjtcclxuXHJcbiAgY29uc3QgaXNDbGltYiA9IHN0YXRlLmN1cnJlbnRNb2RlID09PSBcImNoYW1waW9uXCI7XHJcbiAgY29uc3QgZmlsdGVycyA9IGN1cnJlbnRGaWx0ZXJzKCk7XHJcbiAgY29uc3Qgc21hbGxQb29sID1cclxuICAgIHN0YXRlLnRvdGFsU2NlbmVzQ291bnQgPiAwICYmIHN0YXRlLnRvdGFsU2NlbmVzQ291bnQgPCBDTElNQl9TTUFMTF9QT09MX1dBUk5fQVQ7XHJcblxyXG4gIHdhcm5pbmcuaGlkZGVuID0gIShcclxuICAgIGlzQ2xpbWIgJiZcclxuICAgIHN0YXRlLnNldHRpbmdzLmZpbHRlck9wcG9uZW50cyAmJlxyXG4gICAgZmlsdGVycy5maWx0ZXJBY3RpdmUgJiZcclxuICAgIHNtYWxsUG9vbFxyXG4gICk7XHJcbn1cclxuXHJcbi8qKiBQbGFjZW1lbnQ6IHJlY29yZCB0aGUgcmVzdWx0OyB0aGUgbmV4dCBwYWlyIChvciB0aGUgZmluYWwgcGxhY2VtZW50KSBjb21lcyBmcm9tIHRoZSBmZXRjaC4gKi9cclxuZnVuY3Rpb24gaGFuZGxlUGxhY2VtZW50Q2hvaWNlKGNob2ljZTogU2NlbmVDaG9pY2UpOiB2b2lkIHtcclxuICBjb25zdCBydW4gPSBzdGF0ZS5wbGFjZW1lbnQ7XHJcbiAgaWYgKCFydW4pIHtcclxuICAgIHN0YXRlLmRpc2FibGVDaG9pY2UgPSBmYWxzZTtcclxuICAgIHJldHVybjtcclxuICB9XHJcblxyXG4gIGNvbnN0IHdvbiA9IGNob2ljZS53aW5uZXIuaWQgPT09IHJ1bi5zY2VuZS5pZDtcclxuICByZWNvcmRQbGFjZW1lbnRSZXN1bHQocnVuLCB3b24sIHdvbiA/IGNob2ljZS5sb3Nlci5pZCA6IGNob2ljZS53aW5uZXIuaWQpO1xyXG4gIHNhdmVTdGF0ZSgpO1xyXG5cclxuICBjaG9pY2Uud2lubmVyQ2FyZC5jbGFzc0xpc3QuYWRkKFwic2Itd2lubmVyXCIpO1xyXG4gIGNob2ljZS5sb3NlckNhcmQuY2xhc3NMaXN0LmFkZChcInNiLWxvc2VyXCIpO1xyXG4gIHNjaGVkdWxlTmV4dFBhaXIoNjAwKTtcclxufVxyXG5cclxuLyoqIENoYW1waW9uOiB0d28tc2lkZWQgRUxPIGV2ZXJ5IHBpY2s7IHRoZSB3aW5uZXIgZGVmZW5kcyBuZXh0IChhIG5ldyB3aW5uZXIgdGFrZXMgb3ZlcikuICovXHJcbmZ1bmN0aW9uIGhhbmRsZUNoYW1waW9uQ2hvaWNlKGNob2ljZTogU2NlbmVDaG9pY2UpOiB2b2lkIHtcclxuICBjb25zdCB7IHdpbm5lcjogd2lubmVyU2NlbmUsIGxvc2VyOiBsb3NlclNjZW5lLCBsZWZ0LCB3aW5uZXJDYXJkLCBsb3NlckNhcmQgfSA9IGNob2ljZTtcclxuXHJcbiAgaWYgKCFzdGF0ZS5jaGFtcGlvblNjZW5lKSBzdGF0ZS5jaGFtcGlvblNjZW5lID0gbGVmdDtcclxuICBjb25zdCBjaGFuZ2UgPSByZXNvbHZlQ29tcGFyaXNvbih3aW5uZXJTY2VuZSwgbG9zZXJTY2VuZSk7XHJcblxyXG4gIGlmICh3aW5uZXJTY2VuZS5pZCA9PT0gc3RhdGUuY2hhbXBpb25TY2VuZS5pZCkge1xyXG4gICAgc3RhdGUuY2hhbXBpb25EZWZlYXRlZC5wdXNoKGxvc2VyU2NlbmUuaWQpO1xyXG4gICAgc3RhdGUuY2hhbXBpb25XaW5zKys7XHJcbiAgfSBlbHNlIHtcclxuICAgIHN0YXRlLmNoYW1waW9uU2NlbmUgPSB3aW5uZXJTY2VuZTtcclxuICAgIHN0YXRlLmNoYW1waW9uRGVmZWF0ZWQgPSBbbG9zZXJTY2VuZS5pZF07XHJcbiAgICBzdGF0ZS5jaGFtcGlvbldpbnMgPSAxO1xyXG4gIH1cclxuXHJcbiAgc2F2ZVN0YXRlKCk7XHJcblxyXG4gIHNob3dQaWNrUmVzdWx0KHdpbm5lckNhcmQsIGxvc2VyQ2FyZCwgY2hhbmdlKTtcclxufVxyXG5cclxuLyoqIFdpbm5lci9sb3NlciBjYXJkIHN0eWxlcyBhbmQgYm90aCBFTE8gYW5pbWF0aW9ucywgdGhlbiB0aGUgbmV4dCBwYWlyLiAqL1xyXG5mdW5jdGlvbiBzaG93UGlja1Jlc3VsdChcclxuICB3aW5uZXJDYXJkOiBIVE1MRWxlbWVudCxcclxuICBsb3NlckNhcmQ6IEhUTUxFbGVtZW50LFxyXG4gIGNoYW5nZTogeyB3aW5uZXI6IEVsb0NoYW5nZTsgbG9zZXI6IEVsb0NoYW5nZTsgdXBzZXQ6IGJvb2xlYW4gfSxcclxuKTogdm9pZCB7XHJcbiAgd2lubmVyQ2FyZC5jbGFzc0xpc3QuYWRkKFwic2Itd2lubmVyXCIpO1xyXG4gIGxvc2VyQ2FyZC5jbGFzc0xpc3QuYWRkKFwic2ItbG9zZXJcIik7XHJcbiAgc2hvd1JhdGluZ0FuaW1hdGlvbih3aW5uZXJDYXJkLCBjaGFuZ2Uud2lubmVyLmZyb20sIGNoYW5nZS53aW5uZXIudG8sIHRydWUsIGNoYW5nZS51cHNldCk7XHJcbiAgc2hvd1JhdGluZ0FuaW1hdGlvbihsb3NlckNhcmQsIGNoYW5nZS5sb3Nlci5mcm9tLCBjaGFuZ2UubG9zZXIudG8sIGZhbHNlKTtcclxuICBzY2hlZHVsZU5leHRQYWlyQWZ0ZXJBbmltYXRpb25zKCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGhhbmRsZVNjZW5lQ2hvaWNlKGNob2ljZTogU2NlbmVDaG9pY2UpOiB2b2lkIHtcclxuICBpZiAoc3RhdGUuZGlzYWJsZUNob2ljZSkgcmV0dXJuO1xyXG4gIHN0YXRlLmRpc2FibGVDaG9pY2UgPSB0cnVlO1xyXG4gIGxhc3RQaWNrID0gdGFrZVBpY2tTbmFwc2hvdChjaG9pY2UpO1xyXG4gIHVwZGF0ZVVuZG9CdXR0b24oKTtcclxuXHJcbiAgY29uc3QgeyB3aW5uZXI6IHdpbm5lclNjZW5lLCBsb3NlcjogbG9zZXJTY2VuZSwgd2lubmVyQ2FyZCwgbG9zZXJDYXJkIH0gPSBjaG9pY2U7XHJcblxyXG4gIGlmIChzdGF0ZS5jdXJyZW50TW9kZSA9PT0gXCJwbGFjZW1lbnRcIikge1xyXG4gICAgaGFuZGxlUGxhY2VtZW50Q2hvaWNlKGNob2ljZSk7XHJcbiAgICByZXR1cm47XHJcbiAgfVxyXG5cclxuICBpZiAoc3RhdGUuY3VycmVudE1vZGUgPT09IFwiY2hhbXBpb25cIikge1xyXG4gICAgaGFuZGxlQ2hhbXBpb25DaG9pY2UoY2hvaWNlKTtcclxuICAgIHJldHVybjtcclxuICB9XHJcblxyXG4gIC8vIFN3aXNzOiBib3RoIHNjZW5lcycgRUxPIGNoYW5nZXMgKGJvdGggc3RheSBpbiB0aGUgcG9vbClcclxuICBjb25zdCBjaGFuZ2UgPSByZXNvbHZlQ29tcGFyaXNvbih3aW5uZXJTY2VuZSwgbG9zZXJTY2VuZSk7XHJcblxyXG4gIHNhdmVTdGF0ZSgpO1xyXG5cclxuICBzaG93UGlja1Jlc3VsdCh3aW5uZXJDYXJkLCBsb3NlckNhcmQsIGNoYW5nZSk7XHJcbn1cclxuXHJcbmNvbnN0IFJBVElOR19BTklNX01BWF9UT1RBTF9NUyA9IDE0MDA7XHJcbmNvbnN0IFJBVElOR19BTklNX0hPTERfTVMgPSAzMDA7XHJcbmNvbnN0IFJBVElOR19BTklNX0NPVU5UX0JVREdFVF9NUyA9IFJBVElOR19BTklNX01BWF9UT1RBTF9NUyAtIFJBVElOR19BTklNX0hPTERfTVM7XHJcbmNvbnN0IFJBVElOR19BTklNX0RFRkFVTFRfU1RFUF9NUyA9IDUwO1xyXG5jb25zdCBSQVRJTkdfQU5JTV9NSU5fU1RFUF9NUyA9IDg7XHJcblxyXG5mdW5jdGlvbiBzY2hlZHVsZU5leHRQYWlyQWZ0ZXJBbmltYXRpb25zKCk6IHZvaWQge1xyXG4gIHNjaGVkdWxlTmV4dFBhaXIoMTUwMCk7XHJcbn1cclxuXHJcbi8qKiBUaGUgbmV4dCBwYWlyIGFmdGVyIGEgcGljaydzIGFuaW1hdGlvbiAoYW4gdW5kbyBpbiB0aGUgbWVhbnRpbWUgY2FuY2VscyBpdCkuICovXHJcbmxldCBuZXh0UGFpclRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xyXG5cclxuZnVuY3Rpb24gc2NoZWR1bGVOZXh0UGFpcihtczogbnVtYmVyKTogdm9pZCB7XHJcbiAgaWYgKG5leHRQYWlyVGltZXIpIGNsZWFyVGltZW91dChuZXh0UGFpclRpbWVyKTtcclxuICBuZXh0UGFpclRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XHJcbiAgICBuZXh0UGFpclRpbWVyID0gbnVsbDtcclxuICAgIHZvaWQgbG9hZE5ld1BhaXIoKTtcclxuICB9LCBtcyk7XHJcbn1cclxuXHJcbi8vIC0tLS0tLS0tLS0gVW5kbyB0aGUgbGFzdCBwaWNrIC0tLS0tLS0tLS1cclxuXHJcbi8qKiBXaGF0IHRoZSBsYXN0IHBpY2sgY2hhbmdlZCwgYXMgaXQgd2FzIGp1c3QgYmVmb3JlIChvbmUgbGV2ZWwgb2YgdW5kbykuICovXHJcbmludGVyZmFjZSBQaWNrU25hcHNob3Qge1xyXG4gIG1vZGU6IE1vZGU7XHJcbiAgbGVmdDogU2NlbmU7XHJcbiAgcmlnaHQ6IFNjZW5lO1xyXG4gIHJhbmtzOiBbUmFuaywgUmFua107XHJcbiAgLyoqIFRoZSBzY2VuZXMgdGhlIHBpY2sgd3JpdGVzIChQbGFjZW1lbnQncyBzY2VuZSBpcyB3cml0dGVuIHdoZW4gaXQgbGFuZHMpLCB3aXRoIHRoZWlyIGZpZWxkcyBiZWZvcmUuICovXHJcbiAgZmllbGRzOiB7IHNjZW5lOiBTY2VuZTsgdmFsdWU6IEVsb0ZpZWxkcyB8IG51bGw7IHJhdGluZzEwMDogbnVtYmVyIHwgbnVsbCB9W107XHJcbiAgY2hhbXBpb25TY2VuZTogU2NlbmUgfCBudWxsO1xyXG4gIGNoYW1waW9uV2luczogbnVtYmVyO1xyXG4gIGNoYW1waW9uRGVmZWF0ZWQ6IHN0cmluZ1tdO1xyXG4gIHBsYWNlbWVudDogUGxhY2VtZW50UnVuIHwgbnVsbDtcclxuICAvKiogVGhlIGhhbGwgb2YgZmFtZSdzIHNjZW5lcyBiZWZvcmUgKGEgcGljayBjYW4gYWRkIGEgbmV3ICMxKS4gKi9cclxuICBoYWxsSWRzOiBzdHJpbmdbXTtcclxufVxyXG5cclxubGV0IGxhc3RQaWNrOiBQaWNrU25hcHNob3QgfCBudWxsID0gbnVsbDtcclxubGV0IHVuZG9pbmcgPSBmYWxzZTtcclxuXHJcbmZ1bmN0aW9uIHRha2VQaWNrU25hcHNob3QoY2hvaWNlOiBTY2VuZUNob2ljZSk6IFBpY2tTbmFwc2hvdCB7XHJcbiAgY29uc3QgcnVuID0gc3RhdGUucGxhY2VtZW50O1xyXG4gIGNvbnN0IHdyaXR0ZW4gPSBzdGF0ZS5jdXJyZW50TW9kZSA9PT0gXCJwbGFjZW1lbnRcIiA/IChydW4gPyBbcnVuLnNjZW5lXSA6IFtdKSA6IFtjaG9pY2UubGVmdCwgY2hvaWNlLnJpZ2h0XTtcclxuICByZXR1cm4ge1xyXG4gICAgbW9kZTogc3RhdGUuY3VycmVudE1vZGUsXHJcbiAgICBsZWZ0OiBjaG9pY2UubGVmdCxcclxuICAgIHJpZ2h0OiBjaG9pY2UucmlnaHQsXHJcbiAgICByYW5rczogW3N0YXRlLmN1cnJlbnRSYW5rcy5sZWZ0LCBzdGF0ZS5jdXJyZW50UmFua3MucmlnaHRdLFxyXG4gICAgZmllbGRzOiB3cml0dGVuLm1hcCgoc2NlbmUpID0+ICh7IHNjZW5lLCB2YWx1ZTogZWxvRmllbGRzKGxhdGVzdFNjZW5lKHNjZW5lKSksIHJhdGluZzEwMDogbGF0ZXN0U2NlbmUoc2NlbmUpLnJhdGluZzEwMCA/PyBudWxsIH0pKSxcclxuICAgIGNoYW1waW9uU2NlbmU6IHN0YXRlLmNoYW1waW9uU2NlbmUsXHJcbiAgICBjaGFtcGlvbldpbnM6IHN0YXRlLmNoYW1waW9uV2lucyxcclxuICAgIGNoYW1waW9uRGVmZWF0ZWQ6IFsuLi5zdGF0ZS5jaGFtcGlvbkRlZmVhdGVkXSxcclxuICAgIC8vIEEgY29weTogdGhlIHJ1biBvYmplY3QgaXRzZWxmIGNoYW5nZXMgd2l0aCBldmVyeSBwaWNrXHJcbiAgICBwbGFjZW1lbnQ6IHJ1biA/IHsgLi4ucnVuLCByZXN1bHRzOiBbLi4uKHJ1bi5yZXN1bHRzID8/IFtdKV0gfSA6IG51bGwsXHJcbiAgICBoYWxsSWRzOiBnZXRIYWxsT2ZGYW1lKCkubWFwKChlKSA9PiBlLmlkKSxcclxuICB9O1xyXG59XHJcblxyXG4vKiogVGhlcmUncyBhIHBpY2sgdG8gdW5kby4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGNhblVuZG8oKTogYm9vbGVhbiB7XHJcbiAgcmV0dXJuIGxhc3RQaWNrICE9PSBudWxsICYmICF1bmRvaW5nO1xyXG59XHJcblxyXG4vKiogRm9yZ2V0IHRoZSBsYXN0IHBpY2sgKGFmdGVyIGEgUmVzZXQgRUxPLCBzYXk6IGl0cyB2YWx1ZXMgbm8gbG9uZ2VyIGFwcGx5KS4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGNsZWFyVW5kbygpOiB2b2lkIHtcclxuICBsYXN0UGljayA9IG51bGw7XHJcbiAgdXBkYXRlVW5kb0J1dHRvbigpO1xyXG59XHJcblxyXG5mdW5jdGlvbiB1cGRhdGVVbmRvQnV0dG9uKCk6IHZvaWQge1xyXG4gIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiI3NiLXVuZG8tYnRuLCAjc2ItZW5kLXVuZG9cIikuZm9yRWFjaCgoYnRuKSA9PiAoYnRuLmRpc2FibGVkID0gIWNhblVuZG8oKSkpO1xyXG59XHJcblxyXG4vKipcclxuICogVGFrZSBiYWNrIHRoZSBsYXN0IHBpY2s6IGl0cyBzY2VuZXMnIEVMTywgYmF0dGxlcyBhbmQgcmVjb3JkcyBhcyB0aGV5IHdlcmUgKHdyaXR0ZW4gYmFjayxcclxuICogYWZ0ZXIgYW55IHdyaXRlIHN0aWxsIG9uIGl0cyB3YXkpLCB0aGUgbW9kZSdzIHJ1biAoQ2hhbXBpb24ncyBzdHJlYWssIFBsYWNlbWVudCdzIHNlYXJjaCksIGFueVxyXG4gKiBoYWxsIG9mIGZhbWUgZW50cnkgaXQgYWRkZWQsIGFuZCB0aGUgc2FtZSBwYWlyIG9uIHNjcmVlbiB0byBwaWNrIGFnYWluLiBTdGFzaCByYXRpbmdzIGZvbGxvd1xyXG4gKiB0aGUgcmVzdG9yZWQgRUxPIG9uIHRoZWlyIG93biAodGhlIG5leHQgc3luYykuXHJcbiAqL1xyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdW5kb0xhc3RQaWNrKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gIGNvbnN0IHBpY2sgPSBsYXN0UGljaztcclxuICBpZiAoIXBpY2sgfHwgdW5kb2luZykgcmV0dXJuO1xyXG4gIHVuZG9pbmcgPSB0cnVlO1xyXG4gIGxhc3RQaWNrID0gbnVsbDtcclxuICB1cGRhdGVVbmRvQnV0dG9uKCk7XHJcbiAgaWYgKG5leHRQYWlyVGltZXIpIHtcclxuICAgIGNsZWFyVGltZW91dChuZXh0UGFpclRpbWVyKTtcclxuICAgIG5leHRQYWlyVGltZXIgPSBudWxsO1xyXG4gIH1cclxuICAvLyBBIG5leHQgcGFpciBhbHJlYWR5IGxvYWRpbmcgKG9yIFBsYWNlbWVudCdzIGxhbmRpbmcpIG11c3Qgbm90IHNob3cgdXAgb3ZlciB0aGUgdW5kb25lIHBpY2tcclxuICBwYWlyTG9hZHMrKztcclxuICBzdGF0ZS5kaXNhYmxlQ2hvaWNlID0gdHJ1ZTtcclxuICB0cnkge1xyXG4gICAgYXdhaXQgZWxvV3JpdGVzU2V0dGxlZCgpO1xyXG4gICAgYXdhaXQgUHJvbWlzZS5hbGwocGljay5maWVsZHMubWFwKCh7IHNjZW5lLCB2YWx1ZSwgcmF0aW5nMTAwIH0pID0+IHJlc3RvcmVFbG8oc2NlbmUsIHZhbHVlLCByYXRpbmcxMDApKSk7XHJcbiAgICBhd2FpdCBrZWVwT25seUhhbGxPZkZhbWUocGljay5oYWxsSWRzKTtcclxuICB9IGNhdGNoIChlKSB7XHJcbiAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0gVW5kbyBjb3VsZG4ndCBwdXQgZXZlcnl0aGluZyBiYWNrOlwiLCBlKTtcclxuICB9XHJcblxyXG4gIGlmIChzdGF0ZS5jdXJyZW50TW9kZSAhPT0gcGljay5tb2RlKSB7XHJcbiAgICBzdGF0ZS5jdXJyZW50TW9kZSA9IHBpY2subW9kZTtcclxuICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KFwiLnNiLW1vZGUtYnRuXCIpLmZvckVhY2goKGIpID0+IGIuY2xhc3NMaXN0LnRvZ2dsZShcImFjdGl2ZVwiLCBiLmRhdGFzZXQubW9kZSA9PT0gcGljay5tb2RlKSk7XHJcbiAgICB1cGRhdGVNb2RlSW5mbygpO1xyXG4gICAgdXBkYXRlQ2xpbWJQb29sV2FybmluZygpO1xyXG4gIH1cclxuICBzdGF0ZS5jaGFtcGlvblNjZW5lID0gcGljay5jaGFtcGlvblNjZW5lO1xyXG4gIHN0YXRlLmNoYW1waW9uV2lucyA9IHBpY2suY2hhbXBpb25XaW5zO1xyXG4gIHN0YXRlLmNoYW1waW9uRGVmZWF0ZWQgPSBwaWNrLmNoYW1waW9uRGVmZWF0ZWQ7XHJcbiAgc3RhdGUucGxhY2VtZW50ID0gcGljay5wbGFjZW1lbnQ7XHJcbiAgc3RhdGUuY3VycmVudFBhaXIgPSB7IGxlZnQ6IHBpY2subGVmdCwgcmlnaHQ6IHBpY2sucmlnaHQgfTtcclxuICBzdGF0ZS5jdXJyZW50UmFua3MgPSB7IGxlZnQ6IHBpY2sucmFua3NbMF0sIHJpZ2h0OiBwaWNrLnJhbmtzWzFdIH07XHJcbiAgc3RhdGUuZGlzYWJsZUNob2ljZSA9IGZhbHNlO1xyXG4gIHVuZG9pbmcgPSBmYWxzZTtcclxuICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g4oa2IFVuZGlkIHRoZSBsYXN0IHBpY2sgKHNjZW5lICR7cGljay5sZWZ0LmlkfSB2cyAke3BpY2sucmlnaHQuaWR9KWApO1xyXG4gIHJlbmRlclBhaXIoW3BpY2subGVmdCwgcGljay5yaWdodF0sIHBpY2sucmFua3MpO1xyXG4gIHVwZGF0ZVBvb2xTdGF0dXMoKTtcclxuICBzYXZlU3RhdGUoKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIEVMTyBjb3VudC11cC9kb3duIG92ZXJsYXkgKHdob2xlIG51bWJlcnMpOyBsYXJnZSBqdW1wcyBzcGVlZCB1cCBzbyB0aGUgY291bnQgZml0cyB3aXRoaW4gMTQwMG1zLlxyXG4gKiBgdXBzZXRgIGFkZHMgYSBzbWFsbCBcIlVwc2V0IVwiIHVuZGVyIHRoZSBjaGFuZ2UuXHJcbiAqL1xyXG5mdW5jdGlvbiBzaG93UmF0aW5nQW5pbWF0aW9uKFxyXG4gIGNhcmQ6IEhUTUxFbGVtZW50LFxyXG4gIG9sZEVsbzogbnVtYmVyLFxyXG4gIG5ld0VsbzogbnVtYmVyLFxyXG4gIGlzV2lubmVyOiBib29sZWFuLFxyXG4gIHVwc2V0ID0gZmFsc2UsXHJcbik6IHZvaWQge1xyXG4gIGNvbnN0IG9sZFJhdGluZyA9IE1hdGgucm91bmQob2xkRWxvKTtcclxuICBjb25zdCBuZXdSYXRpbmcgPSBNYXRoLnJvdW5kKG5ld0Vsbyk7XHJcbiAgY29uc3QgY2hhbmdlID0gbmV3UmF0aW5nIC0gb2xkUmF0aW5nO1xyXG4gIC8vIENyZWF0ZSBvdmVybGF5XHJcbiAgY29uc3Qgb3ZlcmxheSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XHJcbiAgb3ZlcmxheS5jbGFzc05hbWUgPSBgc2ItcmF0aW5nLW92ZXJsYXkgJHtpc1dpbm5lciA/IFwic2ItcmF0aW5nLXdpbm5lclwiIDogXCJzYi1yYXRpbmctbG9zZXJcIn1gO1xyXG5cclxuICBjb25zdCByYXRpbmdEaXNwbGF5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcclxuICByYXRpbmdEaXNwbGF5LmNsYXNzTmFtZSA9IFwic2ItcmF0aW5nLWRpc3BsYXlcIjtcclxuICByYXRpbmdEaXNwbGF5LnRleHRDb250ZW50ID0gU3RyaW5nKG9sZFJhdGluZyk7XHJcblxyXG4gIGNvbnN0IGNoYW5nZURpc3BsYXkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xyXG4gIGNoYW5nZURpc3BsYXkuY2xhc3NOYW1lID0gXCJzYi1yYXRpbmctY2hhbmdlXCI7XHJcbiAgY2hhbmdlRGlzcGxheS50ZXh0Q29udGVudCA9IGNoYW5nZSA+IDAgPyBgKyR7Y2hhbmdlfWAgOiBTdHJpbmcoY2hhbmdlKTtcclxuXHJcbiAgb3ZlcmxheS5hcHBlbmRDaGlsZChyYXRpbmdEaXNwbGF5KTtcclxuICBvdmVybGF5LmFwcGVuZENoaWxkKGNoYW5nZURpc3BsYXkpO1xyXG4gIGlmICh1cHNldCkge1xyXG4gICAgY29uc3QgdXBzZXREaXNwbGF5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcclxuICAgIHVwc2V0RGlzcGxheS5jbGFzc05hbWUgPSBcInNiLXJhdGluZy11cHNldFwiO1xyXG4gICAgdXBzZXREaXNwbGF5LnRleHRDb250ZW50ID0gXCJVcHNldCFcIjtcclxuICAgIG92ZXJsYXkuYXBwZW5kQ2hpbGQodXBzZXREaXNwbGF5KTtcclxuICB9XHJcbiAgY2FyZC5hcHBlbmRDaGlsZChvdmVybGF5KTtcclxuXHJcbiAgY29uc3QgdG90YWxTdGVwcyA9IE1hdGguYWJzKGNoYW5nZSk7XHJcbiAgaWYgKHRvdGFsU3RlcHMgPT09IDApIHtcclxuICAgIHJhdGluZ0Rpc3BsYXkudGV4dENvbnRlbnQgPSBTdHJpbmcobmV3UmF0aW5nKTtcclxuICAgIHNldFRpbWVvdXQoKCkgPT4gb3ZlcmxheS5yZW1vdmUoKSwgUkFUSU5HX0FOSU1fTUFYX1RPVEFMX01TKTtcclxuICAgIHJldHVybjtcclxuICB9XHJcblxyXG4gIGNvbnN0IHN0ZXBNcyA9IE1hdGgubWluKFxyXG4gICAgUkFUSU5HX0FOSU1fREVGQVVMVF9TVEVQX01TLFxyXG4gICAgTWF0aC5tYXgoUkFUSU5HX0FOSU1fTUlOX1NURVBfTVMsIE1hdGgucm91bmQoUkFUSU5HX0FOSU1fQ09VTlRfQlVER0VUX01TIC8gdG90YWxTdGVwcykpLFxyXG4gICk7XHJcblxyXG4gIGxldCBjdXJyZW50RGlzcGxheSA9IG9sZFJhdGluZztcclxuICBjb25zdCBzdGVwID0gY2hhbmdlID4gMCA/IDEgOiAtMTtcclxuICBsZXQgc3RlcENvdW50ID0gMDtcclxuXHJcbiAgY29uc3QgaW50ZXJ2YWwgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XHJcbiAgICBzdGVwQ291bnQrKztcclxuICAgIGN1cnJlbnREaXNwbGF5ICs9IHN0ZXA7XHJcbiAgICByYXRpbmdEaXNwbGF5LnRleHRDb250ZW50ID0gU3RyaW5nKGN1cnJlbnREaXNwbGF5KTtcclxuXHJcbiAgICBpZiAoc3RlcENvdW50ID49IHRvdGFsU3RlcHMpIHtcclxuICAgICAgY2xlYXJJbnRlcnZhbChpbnRlcnZhbCk7XHJcbiAgICAgIHJhdGluZ0Rpc3BsYXkudGV4dENvbnRlbnQgPSBTdHJpbmcobmV3UmF0aW5nKTtcclxuICAgIH1cclxuICB9LCBzdGVwTXMpO1xyXG5cclxuICBzZXRUaW1lb3V0KCgpID0+IG92ZXJsYXkucmVtb3ZlKCksIFJBVElOR19BTklNX01BWF9UT1RBTF9NUyk7XHJcbn1cclxuIiwgIi8vIFNoYXJlZCBpY29ucy5cblxuLyoqIFRoZSBjcm9zc2VkIHN3b3JkcyAoMzZ4MzYsIGZpbGxlZCB3aXRoIGN1cnJlbnRDb2xvcik6IHRoZSBuYXZiYXIgYnV0dG9uIGFuZCB0aGUgc2NlbmUgcGFnZSdzIEVMTy4gKi9cbmV4cG9ydCBjb25zdCBTV09SRFNfUEFUSFMgPSBgXG4gIDxwYXRoIGZpbGw9XCJjdXJyZW50Q29sb3JcIiBkPVwibTI0IDI5IDUtNUw2IDFIMXY1elwiLz5cbiAgPHBhdGggZmlsbD1cImN1cnJlbnRDb2xvclwiIGQ9XCJNMSAxdjVsMjMgMjMgMi41LTIuNXpcIi8+XG4gIDxwYXRoIGZpbGw9XCJjdXJyZW50Q29sb3JcIiBkPVwiTTMzLjQyNCAzMi44MDhjLjI4NC0uMjg0LjQ1OC0uNjI2LjUzMS0uOTY4bC01LjI0Mi02LjE5NS0uNy0uNzAyYy0uNTY1LS41NjQtMS41Ny0uNDczLTIuMjQ5LjIwNWwtLjYxNC42MTJjLS42NzcuNjc3LS43NjggMS42ODMtLjIwNCAyLjI0N2wuNzQxLjc0MSA2LjE1IDUuMjA1Yy4zNDUtLjA3Mi42ODgtLjI0Ny45NzQtLjUzMnpcIi8+XG4gIDxwYXRoIGZpbGw9XCJjdXJyZW50Q29sb3JcIiBkPVwiTTMzLjQyNCAzMi44MDhjLjI4NC0uMjg0LjQ1OC0uNjI2LjUzMS0uOTY4bC0xLjM0Mi0xLjU4Ni0uNzM3IDMuNjg0Yy4zMzEtLjA3Ny42NjEtLjI0My45MzUtLjUxOHptLTMuMzEtNS41MDYtLjg4OCA0LjQ0IDEuMjYgMS4wNjcuODItNC4xem0tMS40LTEuNjU3LS43MDItLjcwMmExLjIgMS4yIDAgMCAwLS4zMjYtLjIyNGwtLjk3OCA0Ljg5MiAxLjI2IDEuMDY2Ljk1Ny00Ljc4M3ptLTIuNDAyLS44ODhhMiAyIDAgMCAwLS41NDguMzkybC0uNjE0LjYxYTIgMiAwIDAgMC0uNTEuODZjLS4xNDMuNTEtLjA0NyAxLjAzNi4zMDYgMS4zODhsLjU5Ni41OTZ6bTAgMHEwLS4wMDMgMCAwXCIvPlxuICA8cGF0aCBmaWxsPVwiY3VycmVudENvbG9yXCIgZD1cIk0zMy4yNSAzNmEyLjc1IDIuNzUgMCAxIDAgMC01LjUgMi43NSAyLjc1IDAgMCAwIDAgNS41TTI5LjYyNiAyMi4zMjRhMS4wMzQgMS4wMzQgMCAwIDEgMCAxLjQ2MmwtNi4wOTIgNi4wOTJhMS4wMzIgMS4wMzIgMCAwIDEtMS42ODYtLjMzNiAxLjAzIDEuMDMgMCAwIDEgLjIyNC0xLjEyNmw2LjA5Mi02LjA5MmExLjAzMyAxLjAzMyAwIDAgMSAxLjQ2MiAwXCIvPlxuICA8cGF0aCBmaWxsPVwiY3VycmVudENvbG9yXCIgZD1cIk0yMi4wNzIgMzEuNjI3YTEuNzUgMS43NSAwIDEgMCAwLTMuNSAxLjc1IDEuNzUgMCAwIDAgMCAzLjVNMjkuNjI2IDI0LjA3M2ExLjc1IDEuNzUgMCAxIDAgMC0zLjUgMS43NSAxLjc1IDAgMCAwIDAgMy41XCIvPlxuICA8cGF0aCBmaWxsPVwiY3VycmVudENvbG9yXCIgZD1cIk0yMi4wNzIgMzAuODc3YTEgMSAwIDEgMCAwLTIgMSAxIDAgMCAwIDAgMk0yOS42MjYgMjMuMzIzYTEgMSAwIDEgMCAwLTIgMSAxIDAgMCAwIDAgMk0zMy45MDMgMjkuMzQyYS43Ni43NiAwIDAgMSAwIDEuMDc4bC0zLjQ3NiAzLjQ3NWEuNzYyLjc2MiAwIDAgMS0xLjA3OC0xLjA3OGwzLjQ3Ni0zLjQ3NWEuNzYuNzYgMCAwIDEgMS4wNzggME0xMiAyOWwtNS01TDMwIDFoNXY1elwiLz5cbiAgPHBhdGggZmlsbD1cImN1cnJlbnRDb2xvclwiIGQ9XCJNMzUgMXY1TDEyIDI5bC0yLjUtMi41elwiLz5cbiAgPHBhdGggZmlsbD1cImN1cnJlbnRDb2xvclwiIGQ9XCJNMi41NzYgMzIuODA4YTEuOTUgMS45NSAwIDAgMS0uNTMxLS45NjhsNS4yNDItNi4xOTUuNy0uNzAyYy41NjUtLjU2NCAxLjU3LS40NzMgMi4yNDkuMjA1bC42MTMuNjEyYy42NzcuNjc3Ljc2OCAxLjY4My4yMDQgMi4yNDdsLS43NDEuNzQxLTYuMTUgNS4yMDVhMS45NSAxLjk1IDAgMCAxLS45NzQtLjUzMnpcIi8+XG4gIDxwYXRoIGZpbGw9XCJjdXJyZW50Q29sb3JcIiBkPVwiTTIuNTc2IDMyLjgwOGExLjk1IDEuOTUgMCAwIDEtLjUzMS0uOTY4bDEuMzQyLTEuNTg2LjczNyAzLjY4NGExLjkzIDEuOTMgMCAwIDEtLjkzNS0uNTE4em0zLjMxLTUuNTA2Ljg4OCA0LjQ0LTEuMjYgMS4wNjctLjgyLTQuMXptMS40LTEuNjU3LjcwMi0uNzAyYTEuMiAxLjIgMCAwIDEgLjMyNi0uMjI0bC45NzggNC44OTItMS4yNiAxLjA2Ni0uOTU3LTQuNzgzem0yLjQwMi0uODg4Yy4xOTUuMDk1LjM4Mi4yMjUuNTQ4LjM5MmwuNjEzLjYxMmMuMjU0LjI1NC40MjUuNTU0LjUxLjg2LjE0My41MS4wNDcgMS4wMzUtLjMwNiAxLjM4N2wtLjU5Ni41OTZ6bTAgMHEwLS4wMDMgMCAwXCIvPlxuICA8cGF0aCBmaWxsPVwiY3VycmVudENvbG9yXCIgZD1cIk0yLjc1IDM2YTIuNzUgMi43NSAwIDEgMCAwLTUuNSAyLjc1IDIuNzUgMCAwIDAgMCA1LjVNNi4zNzQgMjIuMzI0YTEuMDM0IDEuMDM0IDAgMCAwIDAgMS40NjJsNi4wOTIgNi4wOTJhMS4wMzMgMS4wMzMgMCAxIDAgMS40NjItMS40NjJsLTYuMDkyLTYuMDkyYTEuMDMzIDEuMDMzIDAgMCAwLTEuNDYyIDBcIi8+XG4gIDxwYXRoIGZpbGw9XCJjdXJyZW50Q29sb3JcIiBkPVwiTTEzLjkyOCAzMS42MjdhMS43NSAxLjc1IDAgMSAwIDAtMy41IDEuNzUgMS43NSAwIDAgMCAwIDMuNU02LjM3NCAyNC4wNzNhMS43NSAxLjc1IDAgMSAwIDAtMy41IDEuNzUgMS43NSAwIDAgMCAwIDMuNVwiLz5cbiAgPHBhdGggZmlsbD1cImN1cnJlbnRDb2xvclwiIGQ9XCJNMTMuOTI4IDMwLjg3N2ExIDEgMCAxIDAgMC0yIDEgMSAwIDAgMCAwIDJNNi4zNzQgMjMuMzIzYTEgMSAwIDEgMCAwLTIgMSAxIDAgMCAwIDAgMk0yLjA5NyAyOS4zNDJhLjc2Ljc2IDAgMCAwIDAgMS4wNzhsMy40NzYgMy40NzVhLjc2My43NjMgMCAwIDAgMS4wNzgtMS4wNzhsLTMuNDc2LTMuNDc1YS43Ni43NiAwIDAgMC0xLjA3OCAwXCIvPlxuYDtcbiIsICIvLyBUaGUgc2NlbmUncyBFTE8gYW5kIHJhbmsgb24gU3Rhc2gncyBvd24gc2NlbmUgcGFnZSwgYXMgb25lIG1vcmUgaXRlbSBpbiB0aGUgdG9vbGJhciBuZXh0IHRvXHJcbi8vIFBsYXkgQ291bnQgYW5kIE8gQ291bnQ6IGEgc2luZ2xlIFN0YXNoIFwibWluaW1hbFwiIGJ1dHRvbiAoaWNvbiBhbmQgdGV4dCBoaWdobGlnaHQgdG9nZXRoZXIpLlxyXG4vLyBXaXRoIGEgdGllciwgdGhlIGJ1dHRvbidzIGljb24gaXMgdGhlIHRpZXIncyBlbW9qaSAo8J+SjikgaW5zdGVhZCBvZiB0aGUgc3dvcmRzLiBPbiBwaG9uZXMgdGhlXHJcbi8vIHRvb2xiYXIgaGFzIG5vIHJvb20gZm9yIGl0IChpdCBtYWRlIHRoZSBwYWdlIHNjcm9sbCBzaWRld2F5cyksIHNvIGl0IGxlYWRzIHRoZSBzdWJoZWFkZXIgbGluZVxyXG4vLyBpbnN0ZWFkOiBcIvCfko4gRUxPIDE5OTAgwrcgIzI1IHwgNjAgZnBzIHwgNEtcIi5cclxuLy9cclxuLy8gU3Rhc2gncyBTY2VuZVBhZ2UgaXNuJ3QgYSBwYXRjaGFibGUgY29tcG9uZW50LCBzbyB0aGUgaXRlbSBpcyBhZGRlZCB0byB0aGUgRE9NIGFuZCByZS1hZGRlZFxyXG4vLyB3aGVuZXZlciBSZWFjdCByZS1yZW5kZXJzIHRoZSB0b29sYmFyLiBUaGUgcmFuayBjb21lcyBmcm9tIFN0YXNoIEJhdHRsZSdzIGFsbC1zY2VuZXMgY2FjaGUsIHRoZVxyXG4vLyBzYW1lIHBsYWNlIHRoZSBiYXR0bGUgY2FyZHMgZ2V0IHRoZWlycyAoU3Rhc2ggY2FuJ3QgY291bnQgc2NlbmVzIGJ5IGEgbnVtZXJpYyBjdXN0b20gZmllbGQpLlxyXG5cclxuaW1wb3J0IHsgZ2V0QWxsU2NlbmVzQ2FjaGVkIH0gZnJvbSBcIi4uL2NhY2hlXCI7XHJcbmltcG9ydCB7IGZldGNoU2NlbmVCeUlkLCBnZXRTY2VuZUlkRnJvbVVybCwgc2NlbmVDdXN0b21GaWVsZHNTdXBwb3J0ZWQgfSBmcm9tIFwiLi4vZ3JhcGhxbFwiO1xyXG5pbXBvcnQgeyBlbG8sIGlzUHJvdmlzaW9uYWwsIGlzUmF0ZWQgfSBmcm9tIFwiLi4vc2NvcmVcIjtcclxuaW1wb3J0IHsgY2FjaGVkVGllck1hcCwgdGllckRlc2NyaXB0aW9uIH0gZnJvbSBcIi4uL3N0YXRzXCI7XHJcbmltcG9ydCB0eXBlIHsgU2NlbmUsIFRpZXIgfSBmcm9tIFwiLi4vdHlwZXNcIjtcclxuaW1wb3J0IHsgU1dPUkRTX1BBVEhTIH0gZnJvbSBcIi4vaWNvbnNcIjtcclxuaW1wb3J0IHsgUFJPVklTSU9OQUxfVElQIH0gZnJvbSBcIi4vc2NlbmVDYXJkXCI7XHJcblxyXG5jb25zdCBJVEVNX0NMQVNTID0gXCJzYi1zY2VuZS1lbG9cIjtcclxuLyoqIEJlbG93IHRoaXMgd2lkdGggdGhlIGl0ZW0gZ29lcyBpbiB0aGUgc3ViaGVhZGVyIGxpbmUgaW5zdGVhZCBvZiB0aGUgdG9vbGJhci4gKi9cclxuY29uc3QgTkFSUk9XX1FVRVJZID0gXCIobWF4LXdpZHRoOiA1NzZweClcIjtcclxuY29uc3QgVElUTEUgPSBcIlN0YXNoIEJhdHRsZSBFTE8sIGFuZCByYW5rIGluIHlvdXIgbGlicmFyeS4gQ2xpY2sgdG8gYmF0dGxlIHRoaXMgc2NlbmUuXCI7XHJcblxyXG4vKiogXCJFTE8gMTc0MCDCtyAjNTBcIiAoYSBcIj9cIiBhZnRlciBhIHByb3Zpc2lvbmFsIEVMTyksIG9yIFwiRUxPIMK3IFVucmF0ZWRcIiBmb3IgYSBzY2VuZSB3aXRoIG5vIEVMTyB5ZXQuICovXHJcbmZ1bmN0aW9uIGxhYmVsVGV4dChzY2VuZTogU2NlbmUsIHJhbms6IG51bWJlciB8IG51bGwpOiBzdHJpbmcge1xyXG4gIGNvbnN0IHZhbHVlID0gZWxvKHNjZW5lKTtcclxuICBpZiAodmFsdWUgPT09IG51bGwpIHJldHVybiBcIkVMTyDCtyBVbnJhdGVkXCI7XHJcbiAgcmV0dXJuIGBFTE8gJHtNYXRoLnJvdW5kKHZhbHVlKX0ke2lzUHJvdmlzaW9uYWwoc2NlbmUpID8gXCI/XCIgOiBcIlwifSR7cmFuayAhPT0gbnVsbCA/IGAgwrcgIyR7cmFua31gIDogXCJcIn1gO1xyXG59XHJcblxyXG4vKiogVGhlIGJ1dHRvbidzIHRvb2x0aXAsIHdpdGggdGhlIHByb3Zpc2lvbmFsIG5vdGUgYW5kIHRoZSB0aWVyIGFkZGVkLiAqL1xyXG5mdW5jdGlvbiB0aXRsZVRleHQoc2NlbmU6IFNjZW5lLCB0aWVyOiBUaWVyIHwgbnVsbCk6IHN0cmluZyB7XHJcbiAgY29uc3QgbGluZXMgPSBbVElUTEVdO1xyXG4gIGlmIChpc1Byb3Zpc2lvbmFsKHNjZW5lKSkgbGluZXMucHVzaChQUk9WSVNJT05BTF9USVApO1xyXG4gIGlmICh0aWVyKSBsaW5lcy5wdXNoKGAke3RpZXIuZW1vaml9ICR7dGllckRlc2NyaXB0aW9uKHRpZXIpfWApO1xyXG4gIHJldHVybiBsaW5lcy5qb2luKFwiXFxuXCIpO1xyXG59XHJcblxyXG4vKipcclxuICogVGhlIHNjZW5lIChmcm9tIHRoZSBjYWNoZSwgb3IgZmV0Y2hlZCBpZiBpdCdzIG5ld2VyIHRoYW4gdGhlIGNhY2hlKSwgaXRzIHJhbmsgYW1vbmcgcmF0ZWRcclxuICogc2NlbmVzIGFuZCBpdHMgdGllci5cclxuICovXHJcbmFzeW5jIGZ1bmN0aW9uIHNjZW5lQW5kUmFuayhzY2VuZUlkOiBzdHJpbmcpOiBQcm9taXNlPHsgc2NlbmU6IFNjZW5lOyByYW5rOiBudW1iZXIgfCBudWxsOyB0aWVyOiBUaWVyIHwgbnVsbCB9IHwgbnVsbD4ge1xyXG4gIGNvbnN0IHsgc2NlbmVzIH0gPSBhd2FpdCBnZXRBbGxTY2VuZXNDYWNoZWQoKTtcclxuICAvLyBUaGUgY2FjaGUgaXMgc29ydGVkIGJ5IEVMTyB3aXRoIHVucmF0ZWQgc2NlbmVzIGxhc3QsIHNvIGEgcmF0ZWQgc2NlbmUncyBpbmRleCBpcyBpdHMgcmFua1xyXG4gIGNvbnN0IGluZGV4ID0gc2NlbmVzLmZpbmRJbmRleCgocykgPT4gcy5pZCA9PT0gc2NlbmVJZCk7XHJcbiAgaWYgKGluZGV4ID49IDApIHtcclxuICAgIGNvbnN0IHNjZW5lID0gc2NlbmVzW2luZGV4XTtcclxuICAgIHJldHVybiB7IHNjZW5lLCByYW5rOiBpc1JhdGVkKHNjZW5lKSA/IGluZGV4ICsgMSA6IG51bGwsIHRpZXI6IGNhY2hlZFRpZXJNYXAoc2NlbmVzKS5nZXQoc2NlbmVJZCkgPz8gbnVsbCB9O1xyXG4gIH1cclxuICBjb25zdCBzY2VuZSA9IGF3YWl0IGZldGNoU2NlbmVCeUlkKHNjZW5lSWQpO1xyXG4gIHJldHVybiBzY2VuZSA/IHsgc2NlbmUsIHJhbms6IG51bGwsIHRpZXI6IG51bGwgfSA6IG51bGw7XHJcbn1cclxuXHJcbi8qKiBPcGVucyBTdGFzaCBCYXR0bGUgKG9uIGEgc2NlbmUgcGFnZSwgd2l0aCB0aGlzIHNjZW5lIGluIHRoZSBiYXR0bGUpLiBTZXQgYnkgcmVnaXN0ZXJTY2VuZUVsby4gKi9cclxubGV0IG9wZW5CYXR0bGU6ICgpID0+IHZvaWQgPSAoKSA9PiB7fTtcclxuXHJcbmNvbnN0IFNXT1JEU19JQ09OID0gYDxzdmcgY2xhc3M9XCJzdmctaW5saW5lLS1mYSBmYS1pY29uXCIgYXJpYS1oaWRkZW49XCJ0cnVlXCIgZm9jdXNhYmxlPVwiZmFsc2VcIiB2aWV3Qm94PVwiMCAwIDM2IDM2XCIgd2lkdGg9XCIxZW1cIiBoZWlnaHQ9XCIxZW1cIj4ke1NXT1JEU19QQVRIU308L3N2Zz5gO1xyXG5cclxuLyoqIFRoZSBidXR0b24ncyBpY29uOiB0aGUgdGllcidzIGVtb2ppLCBvciB0aGUgc3dvcmRzIGZvciBhIHNjZW5lIHdpdGhvdXQgb25lIChwcm92aXNpb25hbCBvciB1bnJhdGVkKS4gKi9cclxuZnVuY3Rpb24gaWNvbkh0bWwodGllcjogVGllciB8IG51bGwpOiBzdHJpbmcge1xyXG4gIHJldHVybiB0aWVyID8gYDxzcGFuIGNsYXNzPVwic2Itc2NlbmUtZWxvLWVtb2ppXCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+JHt0aWVyLmVtb2ppfTwvc3Bhbj5gIDogU1dPUkRTX0lDT047XHJcbn1cclxuXHJcbi8qKiBPbmUgU3Rhc2ggXCJtaW5pbWFsXCIgYnV0dG9uIHdpdGggYW4gaWNvbiBhbmQgdGhlIEVMTywgc28gaXQgaG92ZXJzIGFzIGEgd2hvbGUuICovXHJcbmZ1bmN0aW9uIGNyZWF0ZUl0ZW0oKTogSFRNTEVsZW1lbnQge1xyXG4gIGNvbnN0IGl0ZW0gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcclxuICBpdGVtLmNsYXNzTmFtZSA9IElURU1fQ0xBU1M7XHJcbiAgaXRlbS5pbm5lckhUTUwgPSBgXHJcbiAgICAgIDxidXR0b24gdHlwZT1cImJ1dHRvblwiIGNsYXNzPVwibWluaW1hbCBidG4gYnRuLXNlY29uZGFyeSBzYi1zY2VuZS1lbG8tYnV0dG9uXCIgdGl0bGU9XCIke1RJVExFfVwiPlxyXG4gICAgICAgIDxzcGFuIGNsYXNzPVwic2Itc2NlbmUtZWxvLWljb25cIj4ke1NXT1JEU19JQ09OfTwvc3Bhbj5cclxuICAgICAgICA8c3BhbiBjbGFzcz1cInNiLXNjZW5lLWVsby12YWx1ZVwiPjwvc3Bhbj5cclxuICAgICAgPC9idXR0b24+YDtcclxuICBpdGVtLnF1ZXJ5U2VsZWN0b3IoXCJidXR0b25cIik/LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiBvcGVuQmF0dGxlKCkpO1xyXG4gIHJldHVybiBpdGVtO1xyXG59XHJcblxyXG4vKipcclxuICogV2hlcmUgdGhlIGl0ZW0gZ29lczogb24gcGhvbmVzLCBmaXJzdCBpbiB0aGUgc3ViaGVhZGVyIChkYXRlLCBmcmFtZSByYXRlLCByZXNvbHV0aW9uKTsgb3RoZXJ3aXNlXHJcbiAqIGluIGZyb250IG9mIFBsYXkgQ291bnQgaW4gdGhlIHRvb2xiYXIuIFJldHVybnMgZmFsc2Ugd2hlbiB0aGF0IHBhcnQgb2YgdGhlIHBhZ2UgaXNuJ3QgdGhlcmUgeWV0LlxyXG4gKi9cclxuZnVuY3Rpb24gcGxhY2VJdGVtKGl0ZW06IEhUTUxFbGVtZW50KTogYm9vbGVhbiB7XHJcbiAgaWYgKHdpbmRvdy5tYXRjaE1lZGlhKE5BUlJPV19RVUVSWSkubWF0Y2hlcykge1xyXG4gICAgY29uc3Qgc3ViaGVhZGVyID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihcIi5zY2VuZS1zdWJoZWFkZXJcIik7XHJcbiAgICBpZiAoIXN1YmhlYWRlcikgcmV0dXJuIGZhbHNlO1xyXG4gICAgaWYgKHN1YmhlYWRlci5maXJzdEVsZW1lbnRDaGlsZCAhPT0gaXRlbSkgc3ViaGVhZGVyLnByZXBlbmQoaXRlbSk7XHJcbiAgICBpdGVtLmNsYXNzTGlzdC5hZGQoXCJzYi1zY2VuZS1lbG8tc3ViXCIpO1xyXG4gICAgcmV0dXJuIHRydWU7XHJcbiAgfVxyXG4gIGl0ZW0uY2xhc3NMaXN0LnJlbW92ZShcInNiLXNjZW5lLWVsby1zdWJcIik7XHJcbiAgY29uc3QgdG9vbGJhciA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoXCIuc2NlbmUtdG9vbGJhclwiKTtcclxuICBpZiAoIXRvb2xiYXIpIHJldHVybiBmYWxzZTtcclxuICBpZiAodG9vbGJhci5jb250YWlucyhpdGVtKSkgcmV0dXJuIHRydWU7XHJcbiAgY29uc3QgcGxheUNvdW50ID0gdG9vbGJhci5xdWVyeVNlbGVjdG9yKCdidXR0b25bdGl0bGU9XCJQbGF5IENvdW50XCJdJyk/LmNsb3Nlc3QoXCIuc2NlbmUtdG9vbGJhci1ncm91cCA+ICpcIik7XHJcbiAgaWYgKHBsYXlDb3VudCkge1xyXG4gICAgcGxheUNvdW50LmJlZm9yZShpdGVtKTtcclxuICAgIHJldHVybiB0cnVlO1xyXG4gIH1cclxuICBjb25zdCBncm91cCA9IHRvb2xiYXIucXVlcnlTZWxlY3RvcihcIi5zY2VuZS10b29sYmFyLWdyb3VwOmxhc3QtY2hpbGRcIik7XHJcbiAgaWYgKCFncm91cCkgcmV0dXJuIGZhbHNlO1xyXG4gIGdyb3VwLnByZXBlbmQoaXRlbSk7XHJcbiAgcmV0dXJuIHRydWU7XHJcbn1cclxuXHJcbi8qKiBUaGUgaXRlbSBpcyBvbiB0aGUgcGFnZSBmb3IgdGhpcyBzY2VuZSwgaW4gdGhlIHJpZ2h0IHBsYWNlIGZvciB0aGUgc2NyZWVuIHdpZHRoLiAqL1xyXG5mdW5jdGlvbiBpc1BsYWNlZChpdGVtOiBIVE1MRWxlbWVudCB8IG51bGwsIHNjZW5lSWQ6IHN0cmluZyk6IGJvb2xlYW4ge1xyXG4gIGlmIChpdGVtPy5kYXRhc2V0LnNjZW5lSWQgIT09IHNjZW5lSWQpIHJldHVybiBmYWxzZTtcclxuICByZXR1cm4gd2luZG93Lm1hdGNoTWVkaWEoTkFSUk9XX1FVRVJZKS5tYXRjaGVzID8gQm9vbGVhbihpdGVtLmNsb3Nlc3QoXCIuc2NlbmUtc3ViaGVhZGVyXCIpKSA6IEJvb2xlYW4oaXRlbS5jbG9zZXN0KFwiLnNjZW5lLXRvb2xiYXJcIikpO1xyXG59XHJcblxyXG5sZXQgcmVuZGVyaW5nOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcclxuLyoqIFRoZSBsYXN0IHNjZW5lIGxvYWRlZCwga2VwdCB3aGlsZSBpdHMgc2xvdCBvbiB0aGUgcGFnZSAodG9vbGJhciAvIHN1YmhlYWRlcikgaXNuJ3QgdGhlcmUgeWV0LiAqL1xyXG5sZXQgbG9hZGVkOiB7IHNjZW5lSWQ6IHN0cmluZzsgcmVzdWx0OiBOb25OdWxsYWJsZTxBd2FpdGVkPFJldHVyblR5cGU8dHlwZW9mIHNjZW5lQW5kUmFuaz4+PiB9IHwgbnVsbCA9IG51bGw7XHJcblxyXG4vKiogQWRkIChvciB1cGRhdGUpIHRoZSBpdGVtIG9uIHRoZSBjdXJyZW50IHNjZW5lIHBhZ2UuIFNhZmUgdG8gY2FsbCBvZnRlbi4gKi9cclxuYXN5bmMgZnVuY3Rpb24gcmVuZGVyU2NlbmVFbG8oZm9yY2UgPSBmYWxzZSk6IFByb21pc2U8dm9pZD4ge1xyXG4gIGNvbnN0IHNjZW5lSWQgPSBnZXRTY2VuZUlkRnJvbVVybCgpO1xyXG4gIGlmICghc2NlbmVJZCB8fCAhZG9jdW1lbnQucXVlcnlTZWxlY3RvcihcIi5zY2VuZS10b29sYmFyLCAuc2NlbmUtc3ViaGVhZGVyXCIpKSByZXR1cm47XHJcbiAgaWYgKCFmb3JjZSAmJiBpc1BsYWNlZChkb2N1bWVudC5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihgLiR7SVRFTV9DTEFTU31gKSwgc2NlbmVJZCkpIHJldHVybjtcclxuICBpZiAocmVuZGVyaW5nID09PSBzY2VuZUlkKSByZXR1cm47XHJcblxyXG4gIHJlbmRlcmluZyA9IHNjZW5lSWQ7XHJcbiAgdHJ5IHtcclxuICAgIGlmICghKGF3YWl0IHNjZW5lQ3VzdG9tRmllbGRzU3VwcG9ydGVkKCkpKSByZXR1cm47XHJcbiAgICBjb25zdCByZXN1bHQgPSAhZm9yY2UgJiYgbG9hZGVkPy5zY2VuZUlkID09PSBzY2VuZUlkID8gbG9hZGVkLnJlc3VsdCA6IGF3YWl0IHNjZW5lQW5kUmFuayhzY2VuZUlkKTtcclxuICAgIGlmIChyZXN1bHQpIGxvYWRlZCA9IHsgc2NlbmVJZCwgcmVzdWx0IH07XHJcbiAgICAvLyBUaGUgcGFnZSBtYXkgaGF2ZSBtb3ZlZCBvbiAoYW5vdGhlciBzY2VuZSwgb3IgdGhlIHRvb2xiYXIgcmUtcmVuZGVyZWQpIHdoaWxlIHRoaXMgbG9hZGVkXHJcbiAgICBpZiAoIXJlc3VsdCB8fCBnZXRTY2VuZUlkRnJvbVVybCgpICE9PSBzY2VuZUlkKSByZXR1cm47XHJcblxyXG4gICAgY29uc3QgaXRlbSA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KGAuJHtJVEVNX0NMQVNTfWApID8/IGNyZWF0ZUl0ZW0oKTtcclxuICAgIGlmICghcGxhY2VJdGVtKGl0ZW0pKSByZXR1cm47XHJcbiAgICBpdGVtLmRhdGFzZXQuc2NlbmVJZCA9IHNjZW5lSWQ7XHJcbiAgICBjb25zdCB2YWx1ZSA9IGl0ZW0ucXVlcnlTZWxlY3RvcihcIi5zYi1zY2VuZS1lbG8tdmFsdWVcIik7XHJcbiAgICBpZiAodmFsdWUpIHZhbHVlLnRleHRDb250ZW50ID0gbGFiZWxUZXh0KHJlc3VsdC5zY2VuZSwgcmVzdWx0LnJhbmspO1xyXG4gICAgaXRlbS5xdWVyeVNlbGVjdG9yKFwiYnV0dG9uXCIpPy5zZXRBdHRyaWJ1dGUoXCJ0aXRsZVwiLCB0aXRsZVRleHQocmVzdWx0LnNjZW5lLCByZXN1bHQudGllcikpO1xyXG4gICAgY29uc3QgaWNvbiA9IGl0ZW0ucXVlcnlTZWxlY3RvcihcIi5zYi1zY2VuZS1lbG8taWNvblwiKTtcclxuICAgIGlmIChpY29uKSBpY29uLmlubmVySFRNTCA9IGljb25IdG1sKHJlc3VsdC50aWVyKTtcclxuICB9IGNhdGNoIChlKSB7XHJcbiAgICBjb25zb2xlLndhcm4oXCJbU3Rhc2ggQmF0dGxlXSBDb3VsZG4ndCBzaG93IHRoZSBzY2VuZSdzIEVMTzpcIiwgZSk7XHJcbiAgfSBmaW5hbGx5IHtcclxuICAgIHJlbmRlcmluZyA9IG51bGw7XHJcbiAgfVxyXG59XHJcblxyXG4vKiogUmVmcmVzaCB0aGUgaXRlbSBmcm9tIHRoZSBjYWNoZSAoYWZ0ZXIgYmF0dGxlcyBjaGFuZ2UgRUxPKS4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHJlZnJlc2hTY2VuZUVsbygpOiB2b2lkIHtcclxuICB2b2lkIHJlbmRlclNjZW5lRWxvKHRydWUpO1xyXG59XHJcblxyXG4vKipcclxuICogU2hvdyB0aGUgRUxPIGl0ZW0gb24gc2NlbmUgcGFnZXMsIHJlLWFkZGluZyBpdCBhcyBTdGFzaCBuYXZpZ2F0ZXMgYW5kIHJlLXJlbmRlcnM7IGNsaWNraW5nIGl0XHJcbiAqIGNhbGxzIGBvbkNsaWNrYCAob3BlbnMgU3Rhc2ggQmF0dGxlKS4gQ2FsbCBvbmNlIGF0IHN0YXJ0dXAuXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gcmVnaXN0ZXJTY2VuZUVsbyhvbkNsaWNrOiAoKSA9PiB2b2lkKTogdm9pZCB7XHJcbiAgb3BlbkJhdHRsZSA9IG9uQ2xpY2s7XHJcbiAgbGV0IHF1ZXVlZCA9IGZhbHNlO1xyXG4gIGNvbnN0IGNoZWNrID0gKCk6IHZvaWQgPT4ge1xyXG4gICAgcXVldWVkID0gZmFsc2U7XHJcbiAgICBpZiAoZ2V0U2NlbmVJZEZyb21VcmwoKSkgdm9pZCByZW5kZXJTY2VuZUVsbygpO1xyXG4gIH07XHJcbiAgLy8gQmF0Y2hlZCB3aXRoIGEgdGltZXIsIG5vdCBhbiBhbmltYXRpb24gZnJhbWU6IGZyYW1lcyBkb24ndCBydW4gaW4gYSBiYWNrZ3JvdW5kIHRhYlxyXG4gIG5ldyBNdXRhdGlvbk9ic2VydmVyKCgpID0+IHtcclxuICAgIGlmIChxdWV1ZWQpIHJldHVybjtcclxuICAgIHF1ZXVlZCA9IHRydWU7XHJcbiAgICBzZXRUaW1lb3V0KGNoZWNrLCA1MCk7XHJcbiAgfSkub2JzZXJ2ZShkb2N1bWVudC5ib2R5LCB7IGNoaWxkTGlzdDogdHJ1ZSwgc3VidHJlZTogdHJ1ZSB9KTtcclxuICAvLyBDcm9zc2luZyB0aGUgcGhvbmUgd2lkdGggbW92ZXMgdGhlIGl0ZW0gYmV0d2VlbiB0aGUgdG9vbGJhciBhbmQgdGhlIHN1YmhlYWRlclxyXG4gIHdpbmRvdy5tYXRjaE1lZGlhKE5BUlJPV19RVUVSWSkuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCBjaGVjayk7XHJcbiAgY2hlY2soKTtcclxufVxyXG4iLCAiLy8gU2V0dXAgcHJldmlldzogdGVuIGV4YW1wbGUgc2NlbmVzIGluIHRocmVlIHJvd3MgKG5vdyBpbiBTdGFzaCAvIGFmdGVyIHNldHVwIC8gYWZ0ZXIgbG90cyBvZlxuLy8gYmF0dGxlcykuIEV2ZXJ5IG51bWJlciBjb21lcyBmcm9tIHRoZSByZWFsIHNjb3JlLnRzIGZ1bmN0aW9ucywgc28gdGhlIHByZXZpZXcgY2FuJ3QgZHJpZnRcbi8vIGZyb20gd2hhdCBzZXR1cCBhbmQgdGhlIFN0YXNoIHJhdGluZ3Mgb3B0aW9ucyBhY3R1YWxseSBkby5cblxuaW1wb3J0IHsgRUxPX0ZJRUxEIH0gZnJvbSBcIi4uL2NvbnN0YW50c1wiO1xuaW1wb3J0IHsgZ2V0UmF0aW5nU3lzdGVtLCBmb3JtYXRSYXRpbmcsIHJhdGluZ1ZhbHVlIH0gZnJvbSBcIi4uL3JhdGluZ0Rpc3BsYXlcIjtcbmltcG9ydCB7IGFmdGVyU2V0dXAsIGVsbywgc3Rhc2hSYXRpbmdUYXJnZXRzIH0gZnJvbSBcIi4uL3Njb3JlXCI7XG5pbXBvcnQgdHlwZSB7IEVsb1N0YXJ0LCBTY2VuZSwgU3Rhc2hSYXRpbmdzTW9kZSB9IGZyb20gXCIuLi90eXBlc1wiO1xuXG4vKiogRXhhbXBsZSBTdGFzaCByYXRpbmdzIHRvZGF5OiB0aGUgdGllIGF0IDEwMCBzaG93cyBob3cgcmF0aW5ncyBidW5jaCB1cCBhdCB0aGUgdG9wLiAqL1xuY29uc3QgTk9XX1JBVElOR1M6IChudW1iZXIgfCBudWxsKVtdID0gWzEwMCwgMTAwLCA5NiwgODUsIDc0LCA3MCwgNjIsIDQ1LCAyMCwgbnVsbF07XG5cbi8qKiBFeGFtcGxlIEVMTyBvbmNlIGJhdHRsZXMgaGF2ZSBzcHJlYWQgdGhlIHNjZW5lcyBvdXQgKHRoZSBzYW1lIGZvciBib3RoIHN0YXJ0IGNob2ljZXMpLiAqL1xuY29uc3QgQkFUVExFRF9FTE8gPSBbMjE1MCwgMTk4MCwgMTcwMCwgMTY1MCwgMTYwMCwgMTU1MCwgMTUwMCwgMTQwMCwgMTI1MCwgMTEwMF07XG5cbmludGVyZmFjZSBTcXVhcmUge1xuICBlbG86IG51bWJlciB8IG51bGw7XG4gIHJhdGluZzogbnVtYmVyIHwgbnVsbDtcbiAgY2hhbmdlZDogYm9vbGVhbjtcbn1cblxuZnVuY3Rpb24gZXhhbXBsZVNjZW5lcygpOiBTY2VuZVtdIHtcbiAgcmV0dXJuIE5PV19SQVRJTkdTLm1hcCgocmF0aW5nMTAwLCBpKSA9PiAoeyBpZDogYGV4YW1wbGUtJHtpfWAsIHJhdGluZzEwMCwgY3VzdG9tX2ZpZWxkczoge30gfSkpO1xufVxuXG4vKiogRWFjaCBzY2VuZSdzIFN0YXNoIHJhdGluZyB1bmRlciB0aGUgbW9kZTogd3JpdHRlbiBvbmVzIGdldCB0aGVpciB0YXJnZXQsIG90aGVycyBzdGF5IGFzIG5vdy4gKi9cbmZ1bmN0aW9uIHNxdWFyZXMoc2NlbmVzOiBTY2VuZVtdLCBtb2RlOiBTdGFzaFJhdGluZ3NNb2RlKTogU3F1YXJlW10ge1xuICBjb25zdCB0YXJnZXRzID0gc3Rhc2hSYXRpbmdUYXJnZXRzKHNjZW5lcywgbW9kZSk7XG4gIHJldHVybiBzY2VuZXMubWFwKChzY2VuZSkgPT4ge1xuICAgIGNvbnN0IHJhdGluZyA9IHRhcmdldHMuZ2V0KHNjZW5lLmlkKSA/PyBzY2VuZS5yYXRpbmcxMDAgPz8gbnVsbDtcbiAgICByZXR1cm4geyBlbG86IGVsbyhzY2VuZSksIHJhdGluZywgY2hhbmdlZDogcmF0aW5nICE9PSAoc2NlbmUucmF0aW5nMTAwID8/IG51bGwpIH07XG4gIH0pO1xufVxuXG5mdW5jdGlvbiBzcXVhcmVIdG1sKHsgZWxvOiBlbG9WYWx1ZSwgcmF0aW5nLCBjaGFuZ2VkIH06IFNxdWFyZSwgc2hvd0NoYW5nZTogYm9vbGVhbik6IHN0cmluZyB7XG4gIGNvbnN0IGNsYXNzZXMgPSBbXCJzYi1wdi1zcXVhcmVcIl07XG4gIGlmIChyYXRpbmcgPT09IG51bGwpIGNsYXNzZXMucHVzaChcInNiLXB2LXVucmF0ZWRcIik7XG4gIGlmIChyYXRpbmcgIT09IG51bGwgJiYgcmF0aW5nID4gNTUpIGNsYXNzZXMucHVzaChcInNiLXB2LXN0cm9uZ1wiKTtcbiAgaWYgKHNob3dDaGFuZ2UgJiYgY2hhbmdlZCkgY2xhc3Nlcy5wdXNoKFwic2ItcHYtY2hhbmdlZFwiKTtcbiAgY29uc3QgZmlsbCA9IHJhdGluZyA9PT0gbnVsbCA/IFwiXCIgOiBgIHN0eWxlPVwiLS1zYi1wdi1maWxsOiAke3JhdGluZ30lXCJgO1xuICByZXR1cm4gYFxuICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNiLXB2LWNlbGxcIj5cbiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9XCJzYi1wdi1lbG9cIj4ke2Vsb1ZhbHVlID09PSBudWxsID8gXCJcIiA6IE1hdGgucm91bmQoZWxvVmFsdWUpfTwvc3Bhbj5cbiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9XCIke2NsYXNzZXMuam9pbihcIiBcIil9XCIke2ZpbGx9PiR7cmF0aW5nID09PSBudWxsID8gXCLigJNcIiA6IHJhdGluZ1ZhbHVlKHJhdGluZyl9PC9zcGFuPlxuICAgICAgICAgICAgPC9kaXY+YDtcbn1cblxuZnVuY3Rpb24gcm93SHRtbChsYWJlbDogc3RyaW5nLCBjZWxsczogU3F1YXJlW10sIG5vdGU6IHN0cmluZywgb3B0aW9uczogeyBtdXRlZD86IGJvb2xlYW47IHNob3dDaGFuZ2U/OiBib29sZWFuIH0gPSB7fSk6IHN0cmluZyB7XG4gIHJldHVybiBgXG4gICAgICAgICAgPGRpdiBjbGFzcz1cInNiLXB2LXJvdyR7b3B0aW9ucy5tdXRlZCA/IFwiIHNiLXB2LW11dGVkXCIgOiBcIlwifVwiPlxuICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNiLXB2LWxhYmVsXCI+JHtsYWJlbH08L2Rpdj5cbiAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1wdi1zcXVhcmVzXCI+JHtjZWxscy5tYXAoKGNlbGwpID0+IHNxdWFyZUh0bWwoY2VsbCwgb3B0aW9ucy5zaG93Q2hhbmdlID8/IGZhbHNlKSkuam9pbihcIlwiKX1cbiAgICAgICAgICAgIDwvZGl2PlxuICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNiLXB2LW5vdGVcIj4ke25vdGV9PC9kaXY+XG4gICAgICAgICAgPC9kaXY+YDtcbn1cblxuLyoqIEhvdyBsb25nIGEgbnVtYmVyIGNvdW50cyBmcm9tIGl0cyBvbGQgdmFsdWUgdG8gaXRzIG5ldyBvbmUgKGNvbG91cnMgZmFkZSBvdmVyIHRoZSBzYW1lIHRpbWUgaW4gQ1NTKS4gKi9cbmNvbnN0IFRXRUVOX01TID0gNDAwO1xuXG4vKiogUnVubmluZyBjb3VudCBwZXIgZWxlbWVudDogaXRzIGFuaW1hdGlvbiBmcmFtZSwgYW5kIGEgdGltZXIgdGhhdCBsYW5kcyBpdCBpZiBmcmFtZXMgc3RhbGwuICovXG5jb25zdCB0d2VlbnMgPSBuZXcgV2Vha01hcDxFbGVtZW50LCB7IGZyYW1lOiBudW1iZXI7IHRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB9PigpO1xuXG4vKiogQ291bnQgYW4gZWxlbWVudCdzIG51bWJlciBmcm9tIHdoYXQgaXQgc2hvd3Mgbm93IHRvIGB0YXJnZXRgOyBub24tbnVtYmVycyAo4oCTLCBibGFuaykganVzdCBzd2FwLiAqL1xuZnVuY3Rpb24gdHdlZW5UZXh0KGVsOiBFbGVtZW50LCB0YXJnZXQ6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBydW5uaW5nID0gdHdlZW5zLmdldChlbCk7XG4gIGlmIChydW5uaW5nKSB7XG4gICAgY2FuY2VsQW5pbWF0aW9uRnJhbWUocnVubmluZy5mcmFtZSk7XG4gICAgY2xlYXJUaW1lb3V0KHJ1bm5pbmcudGltZXIpO1xuICAgIHR3ZWVucy5kZWxldGUoZWwpO1xuICB9XG4gIGNvbnN0IGZyb20gPSBOdW1iZXIoZWwudGV4dENvbnRlbnQpO1xuICBjb25zdCB0byA9IE51bWJlcih0YXJnZXQpO1xuICAvLyBDb3VudCBpbiB0aGUgdGFyZ2V0J3Mgc3RlcHM6IHdob2xlIG51bWJlcnMsIG9yIHRlbnRocyBmb3IgXCI3LjRcIlxuICBjb25zdCBkZWNpbWFscyA9IHRhcmdldC5pbmNsdWRlcyhcIi5cIikgPyB0YXJnZXQuc3BsaXQoXCIuXCIpWzFdLmxlbmd0aCA6IDA7XG4gIGlmIChlbC50ZXh0Q29udGVudCA9PT0gXCJcIiB8fCB0YXJnZXQgPT09IFwiXCIgfHwgIU51bWJlci5pc0Zpbml0ZShmcm9tKSB8fCAhTnVtYmVyLmlzRmluaXRlKHRvKSB8fCBmcm9tID09PSB0bykge1xuICAgIGVsLnRleHRDb250ZW50ID0gdGFyZ2V0O1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBzdGFydFRpbWUgPSBwZXJmb3JtYW5jZS5ub3coKTtcbiAgLy8gQmFja2dyb3VuZCB0YWJzIGdldCBubyBhbmltYXRpb24gZnJhbWVzOiBsYW5kIG9uIHRoZSBmaW5hbCBudW1iZXIgcmVnYXJkbGVzc1xuICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgIGNvbnN0IGN1cnJlbnQgPSB0d2VlbnMuZ2V0KGVsKTtcbiAgICBpZiAoY3VycmVudCkgY2FuY2VsQW5pbWF0aW9uRnJhbWUoY3VycmVudC5mcmFtZSk7XG4gICAgdHdlZW5zLmRlbGV0ZShlbCk7XG4gICAgZWwudGV4dENvbnRlbnQgPSB0YXJnZXQ7XG4gIH0sIFRXRUVOX01TICsgNTApO1xuICBjb25zdCBzdGVwID0gKG5vdzogbnVtYmVyKTogdm9pZCA9PiB7XG4gICAgY29uc3QgdCA9IE1hdGgubWluKDEsIChub3cgLSBzdGFydFRpbWUpIC8gVFdFRU5fTVMpO1xuICAgIGNvbnN0IGVhc2VkID0gMSAtIE1hdGgucG93KDEgLSB0LCAzKTtcbiAgICBlbC50ZXh0Q29udGVudCA9IChmcm9tICsgKHRvIC0gZnJvbSkgKiBlYXNlZCkudG9GaXhlZChkZWNpbWFscyk7XG4gICAgaWYgKHQgPCAxKSB0d2VlbnMuc2V0KGVsLCB7IGZyYW1lOiByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoc3RlcCksIHRpbWVyIH0pO1xuICB9O1xuICB0d2VlbnMuc2V0KGVsLCB7IGZyYW1lOiByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoc3RlcCksIHRpbWVyIH0pO1xufVxuXG4vKipcbiAqIFNob3cgdGhlIHByZXZpZXcgaW4gYGNvbnRhaW5lcmAuIFdoZW4gb25lIGlzIGFscmVhZHkgdGhlcmUsIGl0J3MgdXBkYXRlZCBpbiBwbGFjZSBzbyB0aGVcbiAqIG51bWJlcnMgY291bnQgdG8gdGhlaXIgbmV3IHZhbHVlcyBhbmQgdGhlIGNvbG91cnMgZmFkZSAoQ1NTIHRyYW5zaXRpb25zKSBpbnN0ZWFkIG9mIGp1bXBpbmcuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzaG93UmF0aW5nUHJldmlldyhjb250YWluZXI6IEhUTUxFbGVtZW50LCBzdGFydDogRWxvU3RhcnQsIHN0YXNoUmF0aW5nczogU3Rhc2hSYXRpbmdzTW9kZSk6IHZvaWQge1xuICBjb25zdCBuZXh0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbmV4dC5pbm5lckhUTUwgPSByZW5kZXJSYXRpbmdQcmV2aWV3KHN0YXJ0LCBzdGFzaFJhdGluZ3MpO1xuICBjb25zdCBjdXJyZW50ID0gY29udGFpbmVyLnF1ZXJ5U2VsZWN0b3IoXCIuc2ItcmF0aW5nLXByZXZpZXdcIik7XG4gIGNvbnN0IHJlZHVjZWRNb3Rpb24gPSB3aW5kb3cubWF0Y2hNZWRpYShcIihwcmVmZXJzLXJlZHVjZWQtbW90aW9uOiByZWR1Y2UpXCIpLm1hdGNoZXM7XG4gIGlmICghY3VycmVudCB8fCByZWR1Y2VkTW90aW9uKSB7XG4gICAgY29udGFpbmVyLnJlcGxhY2VDaGlsZHJlbiguLi5uZXh0LmNoaWxkTm9kZXMpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IGZyZXNoID0gbmV4dC5xdWVyeVNlbGVjdG9yKFwiLnNiLXJhdGluZy1wcmV2aWV3XCIpIGFzIEVsZW1lbnQ7XG4gIGNvbnN0IHBhaXJzID0gKHNlbGVjdG9yOiBzdHJpbmcpOiBbRWxlbWVudCwgRWxlbWVudF1bXSA9PiB7XG4gICAgY29uc3Qgbm93ID0gY3VycmVudC5xdWVyeVNlbGVjdG9yQWxsKHNlbGVjdG9yKTtcbiAgICByZXR1cm4gWy4uLmZyZXNoLnF1ZXJ5U2VsZWN0b3JBbGwoc2VsZWN0b3IpXS5tYXAoKGVsLCBpKSA9PiBbbm93W2ldLCBlbF0pO1xuICB9O1xuICBmb3IgKGNvbnN0IFtlbCwgdG9dIG9mIHBhaXJzKFwiLnNiLXB2LXJvd1wiKSkgZWwuY2xhc3NOYW1lID0gdG8uY2xhc3NOYW1lO1xuICBmb3IgKGNvbnN0IFtlbCwgdG9dIG9mIHBhaXJzKFwiLnNiLXB2LW5vdGVcIikpIGVsLnRleHRDb250ZW50ID0gdG8udGV4dENvbnRlbnQ7XG4gIGZvciAoY29uc3QgW2VsLCB0b10gb2YgcGFpcnMoXCIuc2ItcHYtZWxvXCIpKSB0d2VlblRleHQoZWwsIHRvLnRleHRDb250ZW50ID8/IFwiXCIpO1xuICBmb3IgKGNvbnN0IFtlbCwgdG9dIG9mIHBhaXJzKFwiLnNiLXB2LXNxdWFyZVwiKSkge1xuICAgIGVsLmNsYXNzTmFtZSA9IHRvLmNsYXNzTmFtZTtcbiAgICBlbC5zZXRBdHRyaWJ1dGUoXCJzdHlsZVwiLCB0by5nZXRBdHRyaWJ1dGUoXCJzdHlsZVwiKSA/PyBcIlwiKTtcbiAgICB0d2VlblRleHQoZWwsIHRvLnRleHRDb250ZW50ID8/IFwiXCIpO1xuICB9XG59XG5cbi8qKiBUaGUgcHJldmlldyBmb3Igb25lIHBhaXIgb2Ygc2V0dXAgYW5zd2VycywgYXMgYW4gSFRNTCBzdHJpbmcuICovXG5leHBvcnQgZnVuY3Rpb24gcmVuZGVyUmF0aW5nUHJldmlldyhzdGFydDogRWxvU3RhcnQsIHN0YXNoUmF0aW5nczogU3Rhc2hSYXRpbmdzTW9kZSk6IHN0cmluZyB7XG4gIGNvbnN0IG9mZiA9IHN0YXNoUmF0aW5ncyA9PT0gXCJvZmZcIjtcbiAgY29uc3Qgbm93ID0gc3F1YXJlcyhleGFtcGxlU2NlbmVzKCksIFwib2ZmXCIpO1xuXG4gIGNvbnN0IHNldFVwID0gc3F1YXJlcyhleGFtcGxlU2NlbmVzKCkubWFwKChzY2VuZSkgPT4gYWZ0ZXJTZXR1cChzY2VuZSwgc3RhcnQpKSwgc3Rhc2hSYXRpbmdzKTtcbiAgY29uc3QgY2hhbmdlZENvdW50ID0gc2V0VXAuZmlsdGVyKChjZWxsKSA9PiBjZWxsLmNoYW5nZWQpLmxlbmd0aDtcblxuICBjb25zdCBiYXR0bGVkID0gZXhhbXBsZVNjZW5lcygpLm1hcCgoc2NlbmUsIGkpID0+ICh7IC4uLnNjZW5lLCBjdXN0b21fZmllbGRzOiB7IFtFTE9fRklFTERdOiBCQVRUTEVEX0VMT1tpXSB9IH0pKTtcbiAgY29uc3QgbGF0ZXIgPSBzcXVhcmVzKGJhdHRsZWQsIHN0YXNoUmF0aW5ncyk7XG5cbiAgY29uc3QgdW5jaGFuZ2VkTm90ZSA9IFwiU3Rhc2ggcmF0aW5ncyBzdGF5IGFzIHRoZXkgYXJlXCI7XG4gIGNvbnN0IGxhdGVyTm90ZSA9IG9mZlxuICAgID8gdW5jaGFuZ2VkTm90ZVxuICAgIDogc3Rhc2hSYXRpbmdzID09PSBcInBlcmNlbnRpbGVcIlxuICAgICAgPyBcIkV2ZW5seSBzcGFjZWQgYnkgcmFuaywgd2hhdGV2ZXIgdGhlIGdhcHNcIlxuICAgICAgOiBgR2FwcyBzaG93LCBidXQgMjE1MCBpcyBzdHVjayBhdCAke2Zvcm1hdFJhdGluZygxMDAsIHRydWUpfWA7XG5cbiAgcmV0dXJuIGBcbiAgICAgICAgPGRpdiBjbGFzcz1cInNiLXJhdGluZy1wcmV2aWV3XCI+XG4gICAgICAgICAgPHAgY2xhc3M9XCJzYi1wdi1sZWdlbmRcIj5FYWNoIHNxdWFyZSBiZWxvdyBpcyBhbiBleGFtcGxlIHNjZW5lOiBpdHMgRUxPIGFib3ZlLCBpdHMgU3Rhc2ggcmF0aW5nJHtnZXRSYXRpbmdTeXN0ZW0oKS50eXBlID09PSBcInN0YXJzXCIgPyBcIiBpbiBzdGFyc1wiIDogXCJcIn0gaW5zaWRlLjwvcD5cbiAgICAgICAgICAke3Jvd0h0bWwoXCJOb3cgaW4gU3Rhc2hcIiwgbm93LCBcIlwiKX1cbiAgICAgICAgICAke3Jvd0h0bWwoXCJBZnRlciBzZXR1cFwiLCBzZXRVcCwgb2ZmID8gdW5jaGFuZ2VkTm90ZSA6IGAke2NoYW5nZWRDb3VudH0gb2YgMTAgY2hhbmdlYCwgeyBtdXRlZDogb2ZmLCBzaG93Q2hhbmdlOiAhb2ZmIH0pfVxuICAgICAgICAgICR7cm93SHRtbChcIkFmdGVyIGxvdHMgb2YgYmF0dGxlc1wiLCBsYXRlciwgbGF0ZXJOb3RlLCB7IG11dGVkOiBvZmYgfSl9XG4gICAgICAgIDwvZGl2PmA7XG59XG4iLCAiLy8gT25lLXRpbWUgRUxPIHNldHVwIHNjcmVlbiwgc2hvd24gaW4gdGhlIEJhdHRsZSB0YWIgaW4gcGxhY2Ugb2YgdGhlIGJhdHRsZSB1bnRpbCBpdCdzIGRvbmUuXG4vLyBUd28gcXVlc3Rpb25zIHNpZGUgYnkgc2lkZSAoaG93IEVMTyBzdGFydHMsIHdoZXRoZXIgU3Rhc2ggQmF0dGxlIHdyaXRlcyBTdGFzaCByYXRpbmdzKSBhYm92ZVxuLy8gYSBzaGFyZWQgcHJldmlldywgdGhlbiBhIHByb2dyZXNzIHZpZXcgd2hpbGUgZWxvU2V0dXAudHMgd3JpdGVzLCB0aGVuIGEgc3VtbWFyeS4gUmVzZXQgRUxPXG4vLyAoU2V0dGluZ3MpIHNob3dzIHRoZSBzYW1lIHNjcmVlbiBpbiByZXNldCBtb2RlLCB3aXRoIGEgQ2FuY2VsIGJ1dHRvbi5cblxuaW1wb3J0IHsgY2xlYXJTY2VuZUNhY2hlIH0gZnJvbSBcIi4uL2NhY2hlXCI7XG5pbXBvcnQgeyBmZXRjaFNldHVwU2NlbmVzLCBydW5FbG9TZXR1cCwgc2V0dXBSYXRpbmdDaGFuZ2VzLCB0eXBlIFNldHVwUGhhc2UsIHR5cGUgU2V0dXBTdW1tYXJ5IH0gZnJvbSBcIi4uL2Vsb1NldHVwXCI7XG5pbXBvcnQgeyBleGFtcGxlUmF0aW5nLCBmb3JtYXRSYXRpbmcsIHJhdGluZ1N0YXJ0cyB9IGZyb20gXCIuLi9yYXRpbmdEaXNwbGF5XCI7XG5pbXBvcnQgeyBpc1JhdGVkLCBzZWVkIH0gZnJvbSBcIi4uL3Njb3JlXCI7XG5pbXBvcnQgeyBoYWRGdW5Nb2RlLCB1cGRhdGVTZXR0aW5nc05vdyB9IGZyb20gXCIuLi9zZXR0aW5nc1wiO1xuaW1wb3J0IHsgcmVzZXRSdW5TdGF0ZSwgcmVzZXRTaHVmZmxlLCBzdGF0ZSB9IGZyb20gXCIuLi9zdGF0ZVwiO1xuaW1wb3J0IHsgc2F2ZVN0YXRlIH0gZnJvbSBcIi4uL3N0b3JhZ2VcIjtcbmltcG9ydCB0eXBlIHsgRWxvU3RhcnQsIFNjZW5lLCBTdGFzaFJhdGluZ3NNb2RlIH0gZnJvbSBcIi4uL3R5cGVzXCI7XG5pbXBvcnQgeyBzaG93UmF0aW5nUHJldmlldyB9IGZyb20gXCIuL3JhdGluZ1ByZXZpZXdcIjtcbmltcG9ydCB7IFNUQVNIX1JBVElOR1NfT1BUSU9OUyB9IGZyb20gXCIuL3N0YXNoUmF0aW5nc1RleHRcIjtcblxuLyoqIE9uIHRoZSBCYXR0bGUgcGFuZWwgd2hpbGUgc2V0dXAgc2hvd3M7IENTUyBoaWRlcyB0aGUgYmF0dGxlIFVJIChtb2RlcywgY2FyZHMsIGFjdGlvbnMpLiAqL1xuY29uc3QgU0VUVVBfQUNUSVZFX0NMQVNTID0gXCJzYi1zZXR1cC1hY3RpdmVcIjtcblxuLyoqIFRydWUgZnJvbSBTdGFydCB1bnRpbCB0aGUgd3JpdGVzIGZpbmlzaCBvciBmYWlsOyByZW9wZW5pbmcgQmF0dGxlIG1lYW53aGlsZSBrZWVwcyB0aGUgcHJvZ3Jlc3MuICovXG5sZXQgcnVubmluZyA9IGZhbHNlO1xuXG5leHBvcnQgaW50ZXJmYWNlIFNldHVwU2NyZWVuT3B0aW9ucyB7XG4gIC8qKiBSZXNldCBFTE86IGV2ZXJ5dGhpbmcgYWxyZWFkeSBoYXMgYW4gRUxPOyB0aGUgY3VycmVudCBTdGFzaCByYXRpbmdzIG9wdGlvbiBpcyBwcmVzZWxlY3RlZC4gKi9cbiAgcmVzZXQ/OiBib29sZWFuO1xuICAvKiogUmVzZXQgbW9kZSdzIENhbmNlbCBidXR0b24gKGJlZm9yZSBhbnl0aGluZyBpcyB3cml0dGVuKS4gKi9cbiAgb25DYW5jZWw/OiAoKSA9PiB2b2lkO1xufVxuXG5sZXQgb3B0aW9uczogU2V0dXBTY3JlZW5PcHRpb25zID0ge307XG5cbmludGVyZmFjZSBDaG9pY2Uge1xuICBzdGFydDogRWxvU3RhcnQ7XG4gIHN0YXNoUmF0aW5nczogU3Rhc2hSYXRpbmdzTW9kZTtcbn1cblxuY29uc3QgcGx1cmFsID0gKG46IG51bWJlciwgd29yZDogc3RyaW5nKTogc3RyaW5nID0+IGAke259ICR7d29yZH0ke24gPT09IDEgPyBcIlwiIDogXCJzXCJ9YDtcblxuZnVuY3Rpb24gc2V0dXBBcmVhKHJvb3Q6IFBhcmVudE5vZGUpOiBIVE1MRWxlbWVudCB8IG51bGwge1xuICByZXR1cm4gcm9vdC5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIiNzYi1zZXR1cC1hcmVhXCIpO1xufVxuXG4vKiogVHJ1ZSB3aGlsZSBzZXR1cCBpcyB3cml0aW5nIChTdGFydCBwcmVzc2VkLCBub3QgZmluaXNoZWQgb3IgZmFpbGVkIHlldCkuICovXG5leHBvcnQgZnVuY3Rpb24gaXNTZXR1cFJ1bm5pbmcoKTogYm9vbGVhbiB7XG4gIHJldHVybiBydW5uaW5nO1xufVxuXG4vKiogU2hvdyB0aGUgc2V0dXAgaW4gdGhlIEJhdHRsZSB0YWIuIGBvbkRvbmVgIHJ1bnMgb25jZSBzZXR1cCBoYXMgZmluaXNoZWQgYW5kIGJlZW4gc2F2ZWQuICovXG5leHBvcnQgZnVuY3Rpb24gc2hvd1NldHVwU2NyZWVuKHJvb3Q6IFBhcmVudE5vZGUsIG9uRG9uZTogKCkgPT4gdm9pZCwgc2NyZWVuT3B0aW9uczogU2V0dXBTY3JlZW5PcHRpb25zID0ge30pOiB2b2lkIHtcbiAgY29uc3QgYXJlYSA9IHNldHVwQXJlYShyb290KTtcbiAgaWYgKCFhcmVhKSByZXR1cm47XG4gIGFyZWEuY2xvc2VzdChcIi5zYi10YWItcGFuZWxcIik/LmNsYXNzTGlzdC5hZGQoU0VUVVBfQUNUSVZFX0NMQVNTKTtcbiAgYXJlYS5oaWRkZW4gPSBmYWxzZTtcbiAgaWYgKHJ1bm5pbmcpIHJldHVybjtcbiAgb3B0aW9ucyA9IHNjcmVlbk9wdGlvbnM7XG4gIHZvaWQgbG9hZENob2ljZXMoYXJlYSwgb25Eb25lKTtcbn1cblxuLyoqIFB1dCB0aGUgYmF0dGxlIFVJIGJhY2sgKHNldHVwIGZpbmlzaGVkLCBwb3NzaWJseSBlbHNld2hlcmUpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhpZGVTZXR1cFNjcmVlbihyb290OiBQYXJlbnROb2RlKTogdm9pZCB7XG4gIGNvbnN0IGFyZWEgPSBzZXR1cEFyZWEocm9vdCk7XG4gIGlmICghYXJlYSB8fCBydW5uaW5nKSByZXR1cm47XG4gIGFyZWEuY2xvc2VzdChcIi5zYi10YWItcGFuZWxcIik/LmNsYXNzTGlzdC5yZW1vdmUoU0VUVVBfQUNUSVZFX0NMQVNTKTtcbiAgYXJlYS5oaWRkZW4gPSB0cnVlO1xuICBhcmVhLmlubmVySFRNTCA9IFwiXCI7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGxvYWRDaG9pY2VzKGFyZWE6IEhUTUxFbGVtZW50LCBvbkRvbmU6ICgpID0+IHZvaWQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgYXJlYS5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz1cInNiLWxvYWRpbmdcIj5Mb2FkaW5nIHlvdXIgbGlicmFyeS4uLjwvZGl2PmA7XG4gIGxldCBzY2VuZXM6IFNjZW5lW107XG4gIHRyeSB7XG4gICAgc2NlbmVzID0gYXdhaXQgZmV0Y2hTZXR1cFNjZW5lcygpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIEVMTyBzZXR1cDogY291bGQgbm90IGxvYWQgc2NlbmVzOlwiLCBlKTtcbiAgICBzaG93RXJyb3IoYXJlYSwgXCJDb3VsZG4ndCBsb2FkIHlvdXIgc2NlbmVzIGZyb20gU3Rhc2guXCIsICgpID0+IHZvaWQgbG9hZENob2ljZXMoYXJlYSwgb25Eb25lKSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIHJlbmRlckNob2ljZXMoYXJlYSwgc2NlbmVzLCBvbkRvbmUpO1xufVxuXG5mdW5jdGlvbiByYWRpbyhuYW1lOiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcsIGxhYmVsOiBzdHJpbmcsIGRlc2M6IHN0cmluZywgY2hlY2tlZDogYm9vbGVhbik6IHN0cmluZyB7XG4gIGNvbnN0IGlkID0gYHNiLXNldHVwLSR7bmFtZX0tJHt2YWx1ZX1gO1xuICByZXR1cm4gYFxuICAgICAgICAgICAgICA8ZGl2IGNsYXNzPVwiY3VzdG9tLWNvbnRyb2wgY3VzdG9tLXJhZGlvIHNiLXNldHVwLW9wdGlvblwiPlxuICAgICAgICAgICAgICAgIDxpbnB1dCB0eXBlPVwicmFkaW9cIiBjbGFzcz1cImN1c3RvbS1jb250cm9sLWlucHV0XCIgaWQ9XCIke2lkfVwiIG5hbWU9XCIke25hbWV9XCIgdmFsdWU9XCIke3ZhbHVlfVwiICR7Y2hlY2tlZCA/IFwiY2hlY2tlZFwiIDogXCJcIn0+XG4gICAgICAgICAgICAgICAgPGxhYmVsIGNsYXNzPVwiY3VzdG9tLWNvbnRyb2wtbGFiZWxcIiBmb3I9XCIke2lkfVwiPlxuICAgICAgICAgICAgICAgICAgPHN0cm9uZz4ke2xhYmVsfTwvc3Ryb25nPlxuICAgICAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9XCJzYi1zZXR1cC1kZXNjXCI+JHtkZXNjfTwvc3Bhbj5cbiAgICAgICAgICAgICAgICA8L2xhYmVsPlxuICAgICAgICAgICAgICA8L2Rpdj5gO1xufVxuXG4vKiogV2hhdCB0aGUgc2Vjb25kIGFuc3dlciBkb2VzIHRvIFN0YXNoIHJhdGluZ3Mgbm93OiBhIHdhcm5pbmcgd2hlbiByYXRpbmdzIGNoYW5nZSwgZWxzZSBhIGNhbG0gbGluZS4gKi9cbmZ1bmN0aW9uIHJhdGluZ3NNZXNzYWdlKHN0YXJ0OiBFbG9TdGFydCwgbW9kZTogU3Rhc2hSYXRpbmdzTW9kZSwgY2hhbmdlczogbnVtYmVyKTogc3RyaW5nIHtcbiAgY29uc3QgYmFja3VwID0gXCJUYWtlIGEgU3Rhc2ggYmFja3VwIGZpcnN0IChTZXR0aW5ncyDihpIgVGFza3Mg4oaSIEJhY2t1cCkuXCI7XG4gIGxldCB0ZXh0OiBzdHJpbmc7XG4gIGxldCB3YXJuID0gdHJ1ZTtcbiAgaWYgKG1vZGUgPT09IFwib2ZmXCIpIHtcbiAgICB0ZXh0ID0gXCJTdGFzaCByYXRpbmdzIHdvbid0IGNoYW5nZS5cIjtcbiAgICB3YXJuID0gZmFsc2U7XG4gIH0gZWxzZSBpZiAoY2hhbmdlcyA9PT0gMCkge1xuICAgIHRleHQgPSBcIk5vIFN0YXNoIHJhdGluZ3MgY2hhbmdlIG5vdzogZXZlcnkgc2NlbmUgY29udmVydHMgYmFjayB0byBpdHMgY3VycmVudCByYXRpbmcuXCI7XG4gICAgd2FybiA9IGZhbHNlO1xuICB9IGVsc2UgaWYgKHN0YXJ0ID09PSBcImZyZXNoXCIpIHtcbiAgICB0ZXh0ID0gYOKaoO+4jyBFdmVyeSBzY2VuZSBzdGFydHMgYXQgMTUwMCBFTE8sIHNvIDxzdHJvbmc+ZXZlcnkgU3Rhc2ggcmF0aW5nIGJlY29tZXMgJHtmb3JtYXRSYXRpbmcoNTAsIHRydWUpfTwvc3Ryb25nPjogJHtwbHVyYWwoY2hhbmdlcywgXCJyYXRpbmdcIil9IGNoYW5nZSwgdW5yYXRlZCBzY2VuZXMgaW5jbHVkZWQuICR7YmFja3VwfWA7XG4gIH0gZWxzZSB7XG4gICAgdGV4dCA9IGDimqDvuI8gPHN0cm9uZz4ke3BsdXJhbChjaGFuZ2VzLCBcIlN0YXNoIHJhdGluZ1wiKX0gY2hhbmdlPC9zdHJvbmc+IG5vdywgc3ByZWFkIGV2ZW5seSBieSByYW5rLiBBIHNjZW5lIHlvdSByYXRlZCAke2Zvcm1hdFJhdGluZygxMDAsIHRydWUpfSBieSBoYW5kIG1heSBlbmQgdXAgbG93ZXIuICR7YmFja3VwfWA7XG4gIH1cbiAgcmV0dXJuIGA8cCBjbGFzcz1cInNiLXNldHVwLW1lc3NhZ2Uke3dhcm4gPyBcIiBzYi1zZXR1cC13YXJuaW5nXCIgOiBcIlwifVwiPiR7dGV4dH08L3A+YDtcbn1cblxuZnVuY3Rpb24gcmVuZGVyQ2hvaWNlcyhhcmVhOiBIVE1MRWxlbWVudCwgc2NlbmVzOiBTY2VuZVtdLCBvbkRvbmU6ICgpID0+IHZvaWQpOiB2b2lkIHtcbiAgY29uc3QgdG90YWwgPSBzY2VuZXMubGVuZ3RoO1xuICBjb25zdCByYXRlZCA9IHNjZW5lcy5maWx0ZXIoKHNjZW5lKSA9PiBzY2VuZS5yYXRpbmcxMDAgIT0gbnVsbCkubGVuZ3RoO1xuICBjb25zdCB1bnJhdGVkID0gdG90YWwgLSByYXRlZDtcbiAgY29uc3Qgd2l0aEVsbyA9IHNjZW5lcy5maWx0ZXIoaXNSYXRlZCkubGVuZ3RoO1xuICAvLyBSZS1ydW5zIChSZXNldCBFTE8sIFN0YWdlIDQpIGFuZCBwcmUtMy4wIGZ1biBtb2RlIHVzZXJzIGhhZCBubyByYXRpbmcgdXBkYXRlcyB0byBsb3NlXG4gIGNvbnN0IHVwZ3JhZGVOb3RlID1cbiAgICAhc3RhdGUuc2V0dGluZ3MuZWxvU2V0dXBBdCAmJiAhaGFkRnVuTW9kZSgpXG4gICAgICA/IFwiIEJlZm9yZSAzLjAsIHJhdGluZ3MgY2hhbmdlZCBhZnRlciBldmVyeSBiYXR0bGU7IFN0cmFpZ2h0LWxpbmUgd2l0aCBVc2UgbXkgcmF0aW5ncyBpcyBjbG9zZXN0IHRvIHRoYXQuXCJcbiAgICAgIDogXCJcIjtcblxuICBjb25zdCByZXNldCA9IG9wdGlvbnMucmVzZXQgPT09IHRydWU7XG4gIGNvbnN0IGNob2ljZTogQ2hvaWNlID0geyBzdGFydDogXCJyYXRpbmdzXCIsIHN0YXNoUmF0aW5nczogcmVzZXQgPyBzdGF0ZS5zZXR0aW5ncy5zdGFzaFJhdGluZ3MgOiBcIm9mZlwiIH07XG5cbiAgYXJlYS5pbm5lckhUTUwgPSBgXG4gICAgICA8ZGl2IGNsYXNzPVwic2Itc2V0dXBcIj5cbiAgICAgICAgPGgyIGNsYXNzPVwic2Itc2V0dXAtdGl0bGVcIj4ke3Jlc2V0ID8gXCJSZXNldCBFTE9cIiA6IFwiU2V0IHVwIEVMT1wifTwvaDI+XG4gICAgICAgIDxwIGNsYXNzPVwic2Itc2V0dXAtaW50cm9cIj5cbiAgICAgICAgICAke1xuICAgICAgICAgICAgcmVzZXRcbiAgICAgICAgICAgICAgPyBcIkNob29zZSBob3cgRUxPIHN0YXJ0cyBhZ2Fpbi4gVGhpcyBvdmVyd3JpdGVzIGV2ZXJ5IHNjZW5lJ3MgRUxPIGFuZCBiYXR0bGUgY291bnQuXCJcbiAgICAgICAgICAgICAgOiBcIlN0YXNoIEJhdHRsZSBub3cgZ2l2ZXMgZWFjaCBzY2VuZSBhbiBFTE8gc2NvcmUsIHNhdmVkIGluIGl0cyBjdXN0b20gZmllbGRzLiBXaW5zIHJhaXNlIGl0LCBsb3NzZXMgbG93ZXIgaXQuIENob29zZSBob3cgaXQgc3RhcnRzLiBUaGlzIHJ1bnMgb25jZS5cIlxuICAgICAgICAgIH1cbiAgICAgICAgPC9wPlxuICAgICAgICAke1xuICAgICAgICAgIHdpdGhFbG8gPiAwICYmICFyZXNldFxuICAgICAgICAgICAgPyBgPHAgY2xhc3M9XCJzYi1zZXR1cC13YXJuaW5nXCI+JHtwbHVyYWwod2l0aEVsbywgXCJzY2VuZVwiKX0gYWxyZWFkeSAke3dpdGhFbG8gPT09IDEgPyBcImhhc1wiIDogXCJoYXZlXCJ9IGFuIEVMTyBmcm9tIGFuIGVhcmxpZXIgc2V0dXAgdGhhdCBkaWRuJ3QgZmluaXNoLiBTZXR0aW5nIHVwIGFnYWluIG92ZXJ3cml0ZXMgJHt3aXRoRWxvID09PSAxID8gXCJpdFwiIDogXCJ0aGVtXCJ9LjwvcD5gXG4gICAgICAgICAgICA6IFwiXCJcbiAgICAgICAgfVxuICAgICAgICA8ZGl2IGNsYXNzPVwic2Itc2V0dXAtcXVlc3Rpb25zXCI+XG4gICAgICAgICAgPGZpZWxkc2V0IGNsYXNzPVwic2Itc2V0dXAtcXVlc3Rpb25cIj5cbiAgICAgICAgICAgIDxsZWdlbmQ+SG93IHNob3VsZCBFTE8gc3RhcnQ/PC9sZWdlbmQ+XG4gICAgICAgICAgICAke3JhZGlvKFxuICAgICAgICAgICAgICBcInN0YXJ0XCIsXG4gICAgICAgICAgICAgIFwicmF0aW5nc1wiLFxuICAgICAgICAgICAgICBcIlVzZSBteSByYXRpbmdzXCIsXG4gICAgICAgICAgICAgIGBZb3VyICR7cGx1cmFsKHJhdGVkLCBcInJhdGVkIHNjZW5lXCIpfSBzdGFydCBmcm9tIHRoZWlyIHJhdGluZzogJHtyYXRpbmdTdGFydHMoZXhhbXBsZVJhdGluZyg1MCkpfSBhdCAke3NlZWQoZXhhbXBsZVJhdGluZyg1MCkpfSBFTE8uJHt1bnJhdGVkID4gMCA/IGAgVGhlICR7dW5yYXRlZH0gdW5yYXRlZCAke3VucmF0ZWQgPT09IDEgPyBcIm9uZSBzdGF5c1wiIDogXCJvbmVzIHN0YXlcIn0gdW5yYXRlZC5gIDogXCJcIn1gLFxuICAgICAgICAgICAgICB0cnVlLFxuICAgICAgICAgICAgKX1cbiAgICAgICAgICAgICR7cmFkaW8oXG4gICAgICAgICAgICAgIFwic3RhcnRcIixcbiAgICAgICAgICAgICAgXCJmcmVzaFwiLFxuICAgICAgICAgICAgICBcIlN0YXJ0IGV2ZXJ5b25lIGF0IDE1MDBcIixcbiAgICAgICAgICAgICAgYEFsbCAke3BsdXJhbCh0b3RhbCwgXCJzY2VuZVwiKX0gc3RhcnQgZXF1YWwuYCxcbiAgICAgICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgICApfVxuICAgICAgICAgIDwvZmllbGRzZXQ+XG4gICAgICAgICAgPGZpZWxkc2V0IGNsYXNzPVwic2Itc2V0dXAtcXVlc3Rpb25cIj5cbiAgICAgICAgICAgIDxsZWdlbmQ+U2hvdWxkIFN0YXNoIEJhdHRsZSBjaGFuZ2UgeW91ciBTdGFzaCByYXRpbmdzPzwvbGVnZW5kPlxuICAgICAgICAgICAgJHtTVEFTSF9SQVRJTkdTX09QVElPTlMubWFwKCh7IHZhbHVlLCBsYWJlbCwgZGVzYyB9KSA9PlxuICAgICAgICAgICAgICByYWRpbyhcInN0YXNoUmF0aW5nc1wiLCB2YWx1ZSwgbGFiZWwsIGRlc2MsIHZhbHVlID09PSBjaG9pY2Uuc3Rhc2hSYXRpbmdzKSxcbiAgICAgICAgICAgICkuam9pbihcIlwiKX1cbiAgICAgICAgICAgIDxwIGNsYXNzPVwic2Itc2V0dXAtbm90ZVwiPllvdSBjYW4gY2hhbmdlIHRoaXMgbGF0ZXIgaW4gU2V0dGluZ3MuJHt1cGdyYWRlTm90ZX08L3A+XG4gICAgICAgICAgPC9maWVsZHNldD5cbiAgICAgICAgPC9kaXY+XG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi1zZXR1cC1tZXNzYWdlLXNsb3RcIiBkYXRhLXJvbGU9XCJyYXRpbmdzLXdhcm5pbmdcIj48L2Rpdj5cbiAgICAgICAgPGgzIGNsYXNzPVwic2Itc2V0dXAtc3VidGl0bGVcIj5QcmV2aWV3PC9oMz5cbiAgICAgICAgPGRpdiBkYXRhLXJvbGU9XCJwcmV2aWV3XCI+PC9kaXY+XG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi1zZXR1cC1hY3Rpb25zXCI+XG4gICAgICAgICAgJHtyZXNldCA/IGA8YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cImJ0biBidG4tc2Vjb25kYXJ5XCIgZGF0YS1yb2xlPVwiY2FuY2VsXCI+Q2FuY2VsPC9idXR0b24+YCA6IFwiXCJ9XG4gICAgICAgICAgPGJ1dHRvbiB0eXBlPVwiYnV0dG9uXCIgY2xhc3M9XCJidG4gYnRuLXByaW1hcnlcIiBkYXRhLXJvbGU9XCJzdGFydFwiPlN0YXJ0IEVMTzwvYnV0dG9uPlxuICAgICAgICA8L2Rpdj5cbiAgICAgIDwvZGl2PmA7XG5cbiAgYXJlYS5xdWVyeVNlbGVjdG9yKCdbZGF0YS1yb2xlPVwiY2FuY2VsXCJdJyk/LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiBvcHRpb25zLm9uQ2FuY2VsPy4oKSk7XG5cbiAgY29uc3Qgc2xvdCA9IGFyZWEucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oJ1tkYXRhLXJvbGU9XCJyYXRpbmdzLXdhcm5pbmdcIl0nKSBhcyBIVE1MRWxlbWVudDtcbiAgY29uc3QgcHJldmlldyA9IGFyZWEucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oJ1tkYXRhLXJvbGU9XCJwcmV2aWV3XCJdJykgYXMgSFRNTEVsZW1lbnQ7XG4gIGNvbnN0IHN0YXJ0QnRuID0gYXJlYS5xdWVyeVNlbGVjdG9yPEhUTUxCdXR0b25FbGVtZW50PignW2RhdGEtcm9sZT1cInN0YXJ0XCJdJykgYXMgSFRNTEJ1dHRvbkVsZW1lbnQ7XG5cbiAgLy8gRXZlcnkgYW5zd2VyJ3MgbWVzc2FnZSBzaXRzIGluIHRoZSBzbG90IGF0IG9uY2UsIHN0YWNrZWQgaW4gb25lIGdyaWQgY2VsbCwgc28gdGhlIHNsb3QgaXNcbiAgLy8gYWx3YXlzIGFzIHRhbGwgYXMgdGhlIGxvbmdlc3QgYW5kIHN3aXRjaGluZyBhbnN3ZXJzIG5ldmVyIG1vdmVzIHRoZSBsYXlvdXQgYmVsb3cgaXQuXG4gIC8vIEFuc3dlcnMgd2l0aCB0aGUgc2FtZSBtZXNzYWdlIHNoYXJlIG9uZSBlbGVtZW50LCBzbyBzd2l0Y2hpbmcgYmV0d2VlbiB0aGVtIGRvZXNuJ3QgZmFkZS5cbiAgY29uc3QgY2hhbmdlQ291bnRzID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgY29uc3QgbWVzc2FnZUZvciA9IG5ldyBNYXA8c3RyaW5nLCBFbGVtZW50PigpO1xuICBjb25zdCBtZXNzYWdlQnlIdG1sID0gbmV3IE1hcDxzdHJpbmcsIEVsZW1lbnQ+KCk7XG4gIGZvciAoY29uc3Qgc3RhcnQgb2YgW1wicmF0aW5nc1wiLCBcImZyZXNoXCJdIGFzIGNvbnN0KSB7XG4gICAgZm9yIChjb25zdCBtb2RlIG9mIFtcIm9mZlwiLCBcImxpbmVhclwiLCBcInBlcmNlbnRpbGVcIl0gYXMgY29uc3QpIHtcbiAgICAgIGNvbnN0IGNoYW5nZXMgPSBzZXR1cFJhdGluZ0NoYW5nZXMoc2NlbmVzLCBzdGFydCwgbW9kZSkuc2l6ZTtcbiAgICAgIGNvbnN0IGh0bWwgPSByYXRpbmdzTWVzc2FnZShzdGFydCwgbW9kZSwgY2hhbmdlcyk7XG4gICAgICBsZXQgbWVzc2FnZSA9IG1lc3NhZ2VCeUh0bWwuZ2V0KGh0bWwpO1xuICAgICAgaWYgKCFtZXNzYWdlKSB7XG4gICAgICAgIHNsb3QuaW5zZXJ0QWRqYWNlbnRIVE1MKFwiYmVmb3JlZW5kXCIsIGh0bWwpO1xuICAgICAgICBtZXNzYWdlID0gc2xvdC5sYXN0RWxlbWVudENoaWxkIGFzIEVsZW1lbnQ7XG4gICAgICAgIG1lc3NhZ2VCeUh0bWwuc2V0KGh0bWwsIG1lc3NhZ2UpO1xuICAgICAgfVxuICAgICAgY2hhbmdlQ291bnRzLnNldChgJHtzdGFydH06JHttb2RlfWAsIGNoYW5nZXMpO1xuICAgICAgbWVzc2FnZUZvci5zZXQoYCR7c3RhcnR9OiR7bW9kZX1gLCBtZXNzYWdlKTtcbiAgICB9XG4gIH1cblxuICBjb25zdCB1cGRhdGUgPSAoKTogdm9pZCA9PiB7XG4gICAgc2hvd1JhdGluZ1ByZXZpZXcocHJldmlldywgY2hvaWNlLnN0YXJ0LCBjaG9pY2Uuc3Rhc2hSYXRpbmdzKTtcbiAgICBjb25zdCBrZXkgPSBgJHtjaG9pY2Uuc3RhcnR9OiR7Y2hvaWNlLnN0YXNoUmF0aW5nc31gO1xuICAgIGNvbnN0IHNob3duID0gbWVzc2FnZUZvci5nZXQoa2V5KTtcbiAgICBmb3IgKGNvbnN0IG1lc3NhZ2Ugb2Ygc2xvdC5jaGlsZHJlbikgbWVzc2FnZS5jbGFzc0xpc3QudG9nZ2xlKFwic2Itc2hvd25cIiwgbWVzc2FnZSA9PT0gc2hvd24pO1xuICAgIGNvbnN0IGNoYW5nZXMgPSBjaGFuZ2VDb3VudHMuZ2V0KGtleSkgPz8gMDtcbiAgICBzdGFydEJ0bi50ZXh0Q29udGVudCA9IGNoYW5nZXMgPiAwID8gYFN0YXJ0IEVMTyBhbmQgY2hhbmdlICR7cGx1cmFsKGNoYW5nZXMsIFwicmF0aW5nXCIpfWAgOiBcIlN0YXJ0IEVMT1wiO1xuICB9O1xuXG4gIGFyZWEucXVlcnlTZWxlY3RvckFsbDxIVE1MSW5wdXRFbGVtZW50PignaW5wdXRbdHlwZT1cInJhZGlvXCJdJykuZm9yRWFjaCgoaW5wdXQpID0+IHtcbiAgICBpbnB1dC5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHtcbiAgICAgIGlmIChpbnB1dC5uYW1lID09PSBcInN0YXJ0XCIpIGNob2ljZS5zdGFydCA9IGlucHV0LnZhbHVlIGFzIEVsb1N0YXJ0O1xuICAgICAgZWxzZSBjaG9pY2Uuc3Rhc2hSYXRpbmdzID0gaW5wdXQudmFsdWUgYXMgU3Rhc2hSYXRpbmdzTW9kZTtcbiAgICAgIHVwZGF0ZSgpO1xuICAgIH0pO1xuICB9KTtcbiAgc3RhcnRCdG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHZvaWQgcnVuU2V0dXAoYXJlYSwgc2NlbmVzLCBjaG9pY2UsIG9uRG9uZSkpO1xuICB1cGRhdGUoKTtcbn1cblxuZnVuY3Rpb24gcHJvZ3Jlc3NIdG1sKHBoYXNlOiBTZXR1cFBoYXNlLCBkb25lOiBudW1iZXIsIHRvdGFsOiBudW1iZXIpOiBzdHJpbmcge1xuICBjb25zdCBwZXJjZW50ID0gdG90YWwgPiAwID8gTWF0aC5yb3VuZCgoZG9uZSAvIHRvdGFsKSAqIDEwMCkgOiAxMDA7XG4gIGNvbnN0IGxhYmVsID1cbiAgICBwaGFzZSA9PT0gXCJlbG9cIlxuICAgICAgPyBgU2F2aW5nIHN0YXJ0aW5nIEVMTzogJHtkb25lfSBvZiAke3BsdXJhbCh0b3RhbCwgXCJzY2VuZVwiKX1gXG4gICAgICA6IGBVcGRhdGluZyBTdGFzaCByYXRpbmdzOiAke3BsdXJhbCh0b3RhbCwgXCJzY2VuZVwiKX1gO1xuICByZXR1cm4gYFxuICAgICAgPGRpdiBjbGFzcz1cInNiLXNldHVwIHNiLXNldHVwLXByb2dyZXNzXCI+XG4gICAgICAgIDxoMiBjbGFzcz1cInNiLXNldHVwLXRpdGxlXCI+U2V0dGluZyB1cCBFTE8uLi48L2gyPlxuICAgICAgICA8ZGl2IGNsYXNzPVwicHJvZ3Jlc3NcIj48ZGl2IGNsYXNzPVwicHJvZ3Jlc3MtYmFyXCIgcm9sZT1cInByb2dyZXNzYmFyXCIgc3R5bGU9XCJ3aWR0aDogJHtwZXJjZW50fSVcIiBhcmlhLXZhbHVlbm93PVwiJHtwZXJjZW50fVwiIGFyaWEtdmFsdWVtaW49XCIwXCIgYXJpYS12YWx1ZW1heD1cIjEwMFwiPjwvZGl2PjwvZGl2PlxuICAgICAgICA8cCBjbGFzcz1cInNiLXNldHVwLXByb2dyZXNzLWxhYmVsXCI+JHtsYWJlbH08L3A+XG4gICAgICAgIDxwIGNsYXNzPVwic2Itc2V0dXAtbm90ZVwiPllvdSBjYW4gY2xvc2UgU3Rhc2ggQmF0dGxlOyBzZXR1cCBrZWVwcyBnb2luZyB3aGlsZSB0aGlzIFN0YXNoIHRhYiBzdGF5cyBvcGVuLiBJZiB0aGUgdGFiIGNsb3NlcyBmaXJzdCwgU3Rhc2ggQmF0dGxlIGFza3MgYWdhaW4gbmV4dCB0aW1lLCBhbmQgcnVubmluZyBpdCBhZ2FpbiBpcyBzYWZlLjwvcD5cbiAgICAgIDwvZGl2PmA7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJ1blNldHVwKGFyZWE6IEhUTUxFbGVtZW50LCBzY2VuZXM6IFNjZW5lW10sIGNob2ljZTogQ2hvaWNlLCBvbkRvbmU6ICgpID0+IHZvaWQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgcnVubmluZyA9IHRydWU7XG4gIGFyZWEuaW5uZXJIVE1MID0gcHJvZ3Jlc3NIdG1sKFwiZWxvXCIsIDAsIDApO1xuICAvLyBBIHJlc2V0IGNsZWFycyB0aGUgXCJzZXR1cCBmaW5pc2hlZFwiIGZsYWcgZmlyc3QsIHNvIGlmIGl0J3MgaW50ZXJydXB0ZWQgU3Rhc2ggQmF0dGxlIGFza3MgYWdhaW5cbiAgaWYgKHN0YXRlLnNldHRpbmdzLmVsb1NldHVwQXQgJiYgIShhd2FpdCB1cGRhdGVTZXR0aW5nc05vdyh7IGVsb1NldHVwQXQ6IG51bGwsIGVsb1NldHVwTW9kZTogbnVsbCB9KSkpIHtcbiAgICBjb25zb2xlLndhcm4oXCJbU3Rhc2ggQmF0dGxlXSBDb3VsZG4ndCBjbGVhciB0aGUgc2V0dXAgZmxhZyBiZWZvcmUgcmVzZXR0aW5nIEVMTzsgY29udGludWluZ1wiKTtcbiAgfVxuICBsZXQgc3VtbWFyeTogU2V0dXBTdW1tYXJ5O1xuICB0cnkge1xuICAgIHN1bW1hcnkgPSBhd2FpdCBydW5FbG9TZXR1cChzY2VuZXMsIGNob2ljZS5zdGFydCwgY2hvaWNlLnN0YXNoUmF0aW5ncywgKHBoYXNlLCBkb25lLCB0b3RhbCkgPT4ge1xuICAgICAgYXJlYS5pbm5lckhUTUwgPSBwcm9ncmVzc0h0bWwocGhhc2UsIGRvbmUsIHRvdGFsKTtcbiAgICB9KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHJ1bm5pbmcgPSBmYWxzZTtcbiAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0gRUxPIHNldHVwIGZhaWxlZDpcIiwgZSk7XG4gICAgc2hvd0Vycm9yKFxuICAgICAgYXJlYSxcbiAgICAgIGBTZXR1cCBzdG9wcGVkIHBhcnR3YXk6ICR7ZXNjYXBlSHRtbChlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSkpfS4gUnVubmluZyBpdCBhZ2FpbiBpcyBzYWZlOyBpdCBvdmVyd3JpdGVzIHdoYXQgd2FzIHdyaXR0ZW4uYCxcbiAgICAgICgpID0+IHZvaWQgbG9hZENob2ljZXMoYXJlYSwgb25Eb25lKSxcbiAgICApO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIENhY2hlZCBzY2VuZXMgYW5kIGFueSBzYXZlZCBwYWlyIHByZWRhdGUgdGhlIG5ldyBFTE8gKGFuZCBwb3NzaWJseSB0aGUgbmV3IHJhdGluZ3MpXG4gIGF3YWl0IGNsZWFyU2NlbmVDYWNoZSgpO1xuICByZXNldFNodWZmbGUoKTtcbiAgcmVzZXRSdW5TdGF0ZSgpO1xuICBzdGF0ZS5jdXJyZW50UGFpciA9IHsgbGVmdDogbnVsbCwgcmlnaHQ6IG51bGwgfTtcbiAgc3RhdGUuY3VycmVudFJhbmtzID0geyBsZWZ0OiBudWxsLCByaWdodDogbnVsbCB9O1xuICBzYXZlU3RhdGUoKTtcblxuICBhd2FpdCBmaW5pc2hTZXR1cChhcmVhLCBzdW1tYXJ5LCBjaG9pY2UsIG9uRG9uZSk7XG59XG5cbi8qKiBTYXZlIHRoZSBjb21wbGV0aW9uIGZsYWdzIChyZXRyeWluZyBvbiByZXF1ZXN0KSwgdGhlbiBzaG93IHRoZSBzdW1tYXJ5LiAqL1xuYXN5bmMgZnVuY3Rpb24gZmluaXNoU2V0dXAoYXJlYTogSFRNTEVsZW1lbnQsIHN1bW1hcnk6IFNldHVwU3VtbWFyeSwgY2hvaWNlOiBDaG9pY2UsIG9uRG9uZTogKCkgPT4gdm9pZCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBzYXZlZCA9IGF3YWl0IHVwZGF0ZVNldHRpbmdzTm93KHtcbiAgICBlbG9TZXR1cEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgZWxvU2V0dXBNb2RlOiBjaG9pY2Uuc3RhcnQsXG4gICAgc3Rhc2hSYXRpbmdzOiBjaG9pY2Uuc3Rhc2hSYXRpbmdzLFxuICB9KTtcbiAgaWYgKCFzYXZlZCkge1xuICAgIC8vIFdpdGhvdXQgdGhlIGZsYWcsIHNldHVwIHdvdWxkIHNob3cgYWdhaW4gb24gdGhlIG5leHQgb3Blbjoga2VlcCBpdCBwZW5kaW5nIGhlcmUgdG9vXG4gICAgc3RhdGUuc2V0dGluZ3MgPSB7IC4uLnN0YXRlLnNldHRpbmdzLCBlbG9TZXR1cEF0OiBudWxsIH07XG4gICAgc2hvd0Vycm9yKFxuICAgICAgYXJlYSxcbiAgICAgIFwiWW91ciBFTE8gaXMgc2F2ZWQsIGJ1dCBTdGFzaCBCYXR0bGUgY291bGRuJ3QgcmVjb3JkIGluIFN0YXNoIHRoYXQgc2V0dXAgZmluaXNoZWQuXCIsXG4gICAgICAoKSA9PiB2b2lkIGZpbmlzaFNldHVwKGFyZWEsIHN1bW1hcnksIGNob2ljZSwgb25Eb25lKSxcbiAgICApO1xuICAgIHJldHVybjtcbiAgfVxuICBydW5uaW5nID0gZmFsc2U7XG5cbiAgY29uc3QgZWxvTGluZSA9XG4gICAgY2hvaWNlLnN0YXJ0ID09PSBcInJhdGluZ3NcIlxuICAgICAgPyBgJHtwbHVyYWwoc3VtbWFyeS5lbG9Xcml0dGVuLCBcInNjZW5lXCIpfSBnb3QgYSBzdGFydGluZyBFTE8gZnJvbSAke3N1bW1hcnkuZWxvV3JpdHRlbiA9PT0gMSA/IFwiaXRzXCIgOiBcInRoZWlyXCJ9IHJhdGluZy4gVW5yYXRlZCBzY2VuZXMgc3RheSB1bnJhdGVkIHVudGlsIHRoZXkgYmF0dGxlLmBcbiAgICAgIDogYCR7cGx1cmFsKHN1bW1hcnkuZWxvV3JpdHRlbiwgXCJzY2VuZVwiKX0gc3RhcnQgYXQgMTUwMCBFTE8uYDtcbiAgY29uc3QgY2xlYXJlZExpbmUgPVxuICAgIHN1bW1hcnkuZWxvQ2xlYXJlZCA+IDAgPyBgPGxpPiR7cGx1cmFsKHN1bW1hcnkuZWxvQ2xlYXJlZCwgXCJzY2VuZVwiKX0gd2l0aG91dCBhIFN0YXNoIHJhdGluZyBoYWQgYW4gb2xkIEVMTyByZW1vdmVkLjwvbGk+YCA6IFwiXCI7XG4gIGNvbnN0IG9wdGlvbkxhYmVsID0gY2hvaWNlLnN0YXNoUmF0aW5ncyA9PT0gXCJwZXJjZW50aWxlXCIgPyBcIlBlcmNlbnRpbGVcIiA6IFwiU3RyYWlnaHQtbGluZVwiO1xuICBjb25zdCByYXRpbmdzTGluZSA9XG4gICAgY2hvaWNlLnN0YXNoUmF0aW5ncyA9PT0gXCJvZmZcIlxuICAgICAgPyBcIlN0YXNoIHJhdGluZ3Mgd2VyZW4ndCBjaGFuZ2VkLCBhbmQgYmF0dGxlcyB3b24ndCBjaGFuZ2UgdGhlbS5cIlxuICAgICAgOiBzdW1tYXJ5LnJhdGluZ3NXcml0dGVuID09PSAwXG4gICAgICAgID8gYFN0YXNoIHJhdGluZ3MgYWxyZWFkeSBtYXRjaGVkICgke29wdGlvbkxhYmVsfSksIHNvIG5vbmUgY2hhbmdlZC4gQmF0dGxlcyBrZWVwIHRoZW0gaW4gc3RlcCBmcm9tIG5vdyBvbi5gXG4gICAgICAgIDogYCR7cGx1cmFsKHN1bW1hcnkucmF0aW5nc1dyaXR0ZW4sIFwiU3Rhc2ggcmF0aW5nXCIpfSB1cGRhdGVkICgke29wdGlvbkxhYmVsfSkuIEJhdHRsZXMga2VlcCB0aGVtIGluIHN0ZXAgZnJvbSBub3cgb24uYDtcblxuICBhcmVhLmlubmVySFRNTCA9IGBcbiAgICAgIDxkaXYgY2xhc3M9XCJzYi1zZXR1cCBzYi1zZXR1cC1kb25lXCI+XG4gICAgICAgIDxoMiBjbGFzcz1cInNiLXNldHVwLXRpdGxlXCI+4pyFIEVMTyBpcyByZWFkeTwvaDI+XG4gICAgICAgIDx1bCBjbGFzcz1cInNiLXNldHVwLXN1bW1hcnlcIj5cbiAgICAgICAgICA8bGk+JHtlbG9MaW5lfTwvbGk+XG4gICAgICAgICAgJHtjbGVhcmVkTGluZX1cbiAgICAgICAgICA8bGk+JHtyYXRpbmdzTGluZX08L2xpPlxuICAgICAgICA8L3VsPlxuICAgICAgICA8ZGl2IGNsYXNzPVwic2Itc2V0dXAtYWN0aW9uc1wiPlxuICAgICAgICAgIDxidXR0b24gdHlwZT1cImJ1dHRvblwiIGNsYXNzPVwiYnRuIGJ0bi1wcmltYXJ5XCIgZGF0YS1yb2xlPVwiZG9uZVwiPlN0YXJ0IGJhdHRsaW5nPC9idXR0b24+XG4gICAgICAgIDwvZGl2PlxuICAgICAgPC9kaXY+YDtcbiAgYXJlYS5xdWVyeVNlbGVjdG9yKCdbZGF0YS1yb2xlPVwiZG9uZVwiXScpPy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4ge1xuICAgIGhpZGVTZXR1cFNjcmVlbihhcmVhLm93bmVyRG9jdW1lbnQpO1xuICAgIG9uRG9uZSgpO1xuICB9KTtcbn1cblxuZnVuY3Rpb24gZXNjYXBlSHRtbCh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gdGV4dC5yZXBsYWNlKC9bJjw+XCJdL2csIChjKSA9PiAoeyBcIiZcIjogXCImYW1wO1wiLCBcIjxcIjogXCImbHQ7XCIsIFwiPlwiOiBcIiZndDtcIiwgJ1wiJzogXCImcXVvdDtcIiB9KVtjXSBhcyBzdHJpbmcpO1xufVxuXG5mdW5jdGlvbiBzaG93RXJyb3IoYXJlYTogSFRNTEVsZW1lbnQsIG1lc3NhZ2U6IHN0cmluZywgcmV0cnk6ICgpID0+IHZvaWQpOiB2b2lkIHtcbiAgYXJlYS5pbm5lckhUTUwgPSBgXG4gICAgICA8ZGl2IGNsYXNzPVwic2Itc2V0dXAgc2ItZXJyb3Itc2NyZWVuXCI+XG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi1lcnJvci1pY29uXCI+4pqg77iPPC9kaXY+XG4gICAgICAgIDxwIGNsYXNzPVwic2ItZXJyb3ItbWVzc2FnZVwiPiR7bWVzc2FnZX08L3A+XG4gICAgICAgIDxidXR0b24gdHlwZT1cImJ1dHRvblwiIGNsYXNzPVwiYnRuIGJ0bi1wcmltYXJ5XCIgZGF0YS1yb2xlPVwicmV0cnlcIj5UcnkgYWdhaW48L2J1dHRvbj5cbiAgICAgIDwvZGl2PmA7XG4gIGFyZWEucXVlcnlTZWxlY3RvcignW2RhdGEtcm9sZT1cInJldHJ5XCJdJyk/LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCByZXRyeSk7XG59XG4iLCAiLy8gVGhlIGJhdHRsZSBtb2RhbDogb3BlbnMvY2xvc2VzLCB3aXJlcyBjb250cm9scyBhbmQga2V5Ym9hcmQgc2hvcnRjdXRzLlxyXG5cclxuaW1wb3J0IHsgY2xlYXJTY2VuZUNhY2hlIH0gZnJvbSBcIi4uL2NhY2hlXCI7XHJcbmltcG9ydCB7IGZldGNoU2V0dXBTY2VuZXMgfSBmcm9tIFwiLi4vZWxvU2V0dXBcIjtcclxuaW1wb3J0IHsgc2NlbmVzTGlzdFF1ZXJ5IH0gZnJvbSBcIi4uL2ZpbHRlcnNcIjtcclxuaW1wb3J0IHsgZ2V0U2NlbmVJZEZyb21VcmwsIGhvbGRTdGFzaExpc3RSZWZyZXNoLCBzY2VuZUN1c3RvbUZpZWxkc1N1cHBvcnRlZCB9IGZyb20gXCIuLi9ncmFwaHFsXCI7XHJcbmltcG9ydCB7IGFwcGx5U3Rhc2hSYXRpbmdzLCBxdWV1ZVJhdGluZ1dyaXRlLCBTQ0VORV9NSVNTSU5HX0VWRU5ULCBzY2hlZHVsZVN0YXNoUmF0aW5nU3luYywgd3JpdGVTdGFzaFJhdGluZ3MgfSBmcm9tIFwiLi4vcmF0aW5nXCI7XHJcbmltcG9ydCB7IHN0YXNoUmF0aW5nQ2hhbmdlcyB9IGZyb20gXCIuLi9zY29yZVwiO1xyXG5pbXBvcnQgeyBjbGVhckhhbGxPZkZhbWUsIGdldEhhbGxPZkZhbWUsIGxvYWRTZXR0aW5ncyB9IGZyb20gXCIuLi9zZXR0aW5nc1wiO1xyXG5pbXBvcnQgeyBpc0Vsb1NldHVwUGVuZGluZywgb25lU2NlbmVQb29sLCByZXNldFJ1blN0YXRlLCByZXNldFNodWZmbGUsIHN0YXRlIH0gZnJvbSBcIi4uL3N0YXRlXCI7XHJcbmltcG9ydCB7IGxvYWRTdGF0ZSwgc2F2ZVN0YXRlIH0gZnJvbSBcIi4uL3N0b3JhZ2VcIjtcclxuaW1wb3J0IHR5cGUgeyBNb2RlLCBTZXR0aW5ncywgU3Rhc2hSYXRpbmdzTW9kZSB9IGZyb20gXCIuLi90eXBlc1wiO1xyXG5pbXBvcnQgeyBjYW5jZWxDb25maXJtRGlhbG9nLCBjb25maXJtRGlhbG9nLCBpc0NvbmZpcm1EaWFsb2dPcGVuIH0gZnJvbSBcIi4vY29uZmlybURpYWxvZ1wiO1xyXG5pbXBvcnQgeyBjYW5jZWxEZWxldGVEaWFsb2csIGlzRGVsZXRlRGlhbG9nT3BlbiB9IGZyb20gXCIuL2RlbGV0ZURpYWxvZ1wiO1xyXG5pbXBvcnQge1xyXG4gIGFwcGx5UHJldmlld1NldHRpbmdzLFxyXG4gIGNsZWFyVW5kbyxcclxuICBjcmVhdGVNYWluVUksXHJcbiAgaGFuZGxlU2NlbmVHb25lLFxyXG4gIGxvYWROZXdQYWlyLFxyXG4gIHJlbmRlclBhaXIsXHJcbiAgcmVzdG9yZUN1cnJlbnRQYWlyLFxyXG4gIHNraXBQYWlyLFxyXG4gIHVuZG9MYXN0UGljayxcclxuICB1cGRhdGVDbGltYlBvb2xXYXJuaW5nLFxyXG4gIHVwZGF0ZU1vZGVJbmZvLFxyXG4gIHVwZGF0ZVBvb2xTdGF0dXMsXHJcbiAgdXBkYXRlUmF0aW5nc05vdGUsXHJcbiAgdmVyaWZ5Q3VycmVudFBhaXIsXHJcbn0gZnJvbSBcIi4vbWFpblVJXCI7XHJcbmltcG9ydCB7IHJlbmRlckV4cGxvcmVUYWIsIHNldEV4cGxvcmVGaWx0ZXJzIH0gZnJvbSBcIi4vZXhwbG9yZVRhYlwiO1xyXG5pbXBvcnQgeyBwbHVyYWwsIHN0b3BNaW5pUHJldmlldyB9IGZyb20gXCIuL21pbmlDYXJkXCI7XHJcbmltcG9ydCB7IHJlbmRlclJlY29yZHNUYWIgfSBmcm9tIFwiLi9yZWNvcmRzVGFiXCI7XHJcbmltcG9ydCB7IHJlbmRlclN0YXRzVGFiLCB0eXBlIFN0YXRzQWN0aW9ucyB9IGZyb20gXCIuL3N0YXRzVGFiXCI7XHJcbmltcG9ydCB7IGJpbmRTZXR0aW5nc0NvbnRyb2xzLCBnZXRBY3RpdmVUYWIsIHNob3dUYWIsIHN5bmNTZXR0aW5nc0NvbnRyb2xzIH0gZnJvbSBcIi4vc2V0dGluZ3NQYW5lbFwiO1xyXG5pbXBvcnQgeyByZWZyZXNoU2NlbmVFbG8gfSBmcm9tIFwiLi9zY2VuZUVsb1wiO1xyXG5pbXBvcnQgeyBoaWRlU2V0dXBTY3JlZW4sIGlzU2V0dXBSdW5uaW5nLCBzaG93U2V0dXBTY3JlZW4gfSBmcm9tIFwiLi9zZXR1cFNjcmVlblwiO1xyXG5pbXBvcnQgeyBzdGFzaFJhdGluZ3NPcHRpb24gfSBmcm9tIFwiLi9zdGFzaFJhdGluZ3NUZXh0XCI7XHJcblxyXG4vLyBUcmFjayBrZXlib2FyZCBoYW5kbGVyIHNvIHdlIGNhbiByZW1vdmUgaXQgb24gY2xvc2VcclxubGV0IG1vZGFsS2V5SGFuZGxlcjogKChlOiBLZXlib2FyZEV2ZW50KSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xyXG5sZXQgc2NlbmVNaXNzaW5nTGlzdGVuZXJBZGRlZCA9IGZhbHNlO1xyXG5cclxuLyoqIE9uIDxib2R5PiB3aGlsZSBCYXR0bGUgaXMgb3BlbjsgQ1NTIHVzZXMgaXQgdG8gbGlmdCBTdGFzaCdzIG93biBtb2RhbHMgYWJvdmUgb3Vycy4gKi9cclxuY29uc3QgQkFUVExFX09QRU5fQ0xBU1MgPSBcInNiLWJhdHRsZS1vcGVuXCI7XHJcblxyXG4vKiogUmUtcmVuZGVyIHRoZSBwYWlyIG9uIHNjcmVlbiBzbyBjYXJkIG1hcmt1cCBwaWNrcyB1cCBhIGNoYW5nZWQgc2V0dGluZy4gKi9cclxuZnVuY3Rpb24gcmVyZW5kZXJDdXJyZW50UGFpcigpOiB2b2lkIHtcclxuICBjb25zdCB7IGxlZnQsIHJpZ2h0IH0gPSBzdGF0ZS5jdXJyZW50UGFpcjtcclxuICBpZiAoIWxlZnQgfHwgIXJpZ2h0IHx8IHN0YXRlLmRpc2FibGVDaG9pY2UgfHwgIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoXCIjc2ItY29tcGFyaXNvbi1hcmVhIC5zYi12cy1jb250YWluZXJcIikpIHtcclxuICAgIHJldHVybjtcclxuICB9XHJcbiAgcmVuZGVyUGFpcihbbGVmdCwgcmlnaHRdLCBbc3RhdGUuY3VycmVudFJhbmtzLmxlZnQsIHN0YXRlLmN1cnJlbnRSYW5rcy5yaWdodF0pO1xyXG59XHJcblxyXG4vKipcclxuICogQmVmb3JlIHRoZSBcIlN0YXNoIHJhdGluZ3NcIiBkcm9wZG93biBjaGFuZ2VzOiBzd2l0Y2hpbmcgdG8gUGVyY2VudGlsZSBvciBTdHJhaWdodC1saW5lIHdhcm5zIGhvd1xyXG4gKiBtYW55IFN0YXNoIHJhdGluZ3MgY2hhbmdlIGFuZCBzeW5jcyB0aGVtIGFsbCBvbiBjb25maXJtIChmYWxzZSBwdXRzIHRoZSBkcm9wZG93biBiYWNrKS5cclxuICogU3dpdGNoaW5nIHRvIERvbid0IHVwZGF0ZSwgb3IgYSBzd2l0Y2ggdGhhdCBjaGFuZ2VzIG5vdGhpbmcsIG5lZWRzIG5vIHdhcm5pbmcuXHJcbiAqL1xyXG5hc3luYyBmdW5jdGlvbiBjb25maXJtU2V0dGluZ0NoYW5nZShrZXk6IGtleW9mIFNldHRpbmdzLCB2YWx1ZTogc3RyaW5nKTogUHJvbWlzZTxib29sZWFuPiB7XHJcbiAgaWYgKGtleSAhPT0gXCJzdGFzaFJhdGluZ3NcIikgcmV0dXJuIHRydWU7XHJcbiAgY29uc3QgbmV4dCA9IHZhbHVlIGFzIFN0YXNoUmF0aW5nc01vZGU7XHJcbiAgaWYgKG5leHQgPT09IFwib2ZmXCIgfHwgbmV4dCA9PT0gc3RhdGUuc2V0dGluZ3Muc3Rhc2hSYXRpbmdzKSByZXR1cm4gdHJ1ZTtcclxuXHJcbiAgbGV0IGNoYW5nZXM6IE1hcDxzdHJpbmcsIG51bWJlcj47XHJcbiAgdHJ5IHtcclxuICAgIGNoYW5nZXMgPSBzdGFzaFJhdGluZ0NoYW5nZXMoYXdhaXQgZmV0Y2hTZXR1cFNjZW5lcygpLCBuZXh0KTtcclxuICB9IGNhdGNoIChlKSB7XHJcbiAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0gQ291bGRuJ3QgbG9hZCBzY2VuZXMgdG8gc3dpdGNoIFN0YXNoIHJhdGluZ3M6XCIsIGUpO1xyXG4gICAgYXdhaXQgY29uZmlybURpYWxvZyh7XHJcbiAgICAgIHRpdGxlOiBcIkNvdWxkbid0IGxvYWQgeW91ciBzY2VuZXNcIixcclxuICAgICAgYm9keTogXCI8cD5TdGFzaCBCYXR0bGUgbmVlZHMgeW91ciB3aG9sZSBsaWJyYXJ5IHRvIHdvcmsgb3V0IHRoZSBuZXcgU3Rhc2ggcmF0aW5ncy4gTm90aGluZyB3YXMgY2hhbmdlZDsgdHJ5IGFnYWluLjwvcD5cIixcclxuICAgICAgY29uZmlybUxhYmVsOiBcIk9LXCIsXHJcbiAgICB9KTtcclxuICAgIHJldHVybiBmYWxzZTtcclxuICB9XHJcbiAgaWYgKGNoYW5nZXMuc2l6ZSA9PT0gMCkgcmV0dXJuIHRydWU7XHJcblxyXG4gIGNvbnN0IHsgbGFiZWwsIGRlc2MgfSA9IHN0YXNoUmF0aW5nc09wdGlvbihuZXh0KTtcclxuICBjb25zdCBjb3VudCA9IGAke2NoYW5nZXMuc2l6ZX0gU3Rhc2ggcmF0aW5nJHtjaGFuZ2VzLnNpemUgPT09IDEgPyBcIlwiIDogXCJzXCJ9YDtcclxuICByZXR1cm4gY29uZmlybURpYWxvZyh7XHJcbiAgICB0aXRsZTogYFN3aXRjaCBTdGFzaCByYXRpbmdzIHVwZGF0ZSBtb2RlIHRvICR7bGFiZWx9P2AsXHJcbiAgICBib2R5OiBgXHJcbiAgICAgICAgPHA+JHtkZXNjfTwvcD5cclxuICAgICAgICA8cD48c3Ryb25nPiR7Y291bnR9IGNoYW5nZSBub3cuPC9zdHJvbmc+IEFmdGVyIHRoYXQsIGJhdHRsZXMga2VlcCBTdGFzaCByYXRpbmdzIGluIHN0ZXAgd2l0aFxyXG4gICAgICAgIEVMTywgYW5kIGEgc3RhciByYXRpbmcgeW91IGNoYW5nZSBieSBoYW5kIGluIFN0YXNoIGlzIG92ZXJ3cml0dGVuIHRoZSBuZXh0IHRpbWUgU3Rhc2ggQmF0dGxlXHJcbiAgICAgICAgd3JpdGVzIHRoYXQgc2NlbmUuPC9wPlxyXG4gICAgICAgIDxwPlRha2UgYSBTdGFzaCBiYWNrdXAgZmlyc3QgKFNldHRpbmdzIOKGkiBUYXNrcyDihpIgQmFja3VwKS48L3A+YCxcclxuICAgIGNvbmZpcm1MYWJlbDogYFVwZGF0ZSAke2NvdW50fWAsXHJcbiAgICB3b3JraW5nTGFiZWw6IFwiVXBkYXRpbmcuLi5cIixcclxuICAgIGFjdGlvbjogKCkgPT5cclxuICAgICAgcXVldWVSYXRpbmdXcml0ZShhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgYXdhaXQgd3JpdGVTdGFzaFJhdGluZ3MoY2hhbmdlcyk7XHJcbiAgICAgICAgYXBwbHlTdGFzaFJhdGluZ3MoY2hhbmdlcyk7XHJcbiAgICAgIH0pLFxyXG4gIH0pO1xyXG59XHJcblxyXG4vKiogU2V0dGluZ3Mg4oaSIFJlc2V0IEVMTzogY29uZmlybSwgdGhlbiBzaG93IHRoZSBzZXR1cCBjaG9pY2VzIGFnYWluIChDYW5jZWwgZ29lcyBiYWNrKS4gKi9cclxuLyoqIFNldHRpbmdzIOKGkiBDbGVhciBoYWxsIG9mIGZhbWU6IGFmdGVyIGEgY29uZmlybWF0aW9uLCBlbXB0eSB0aGUgbGlzdCAodG9kYXkncyAjMSBzdGFydHMgaXQgYWdhaW4pLiAqL1xyXG5hc3luYyBmdW5jdGlvbiBjb25maXJtQ2xlYXJIYWxsT2ZGYW1lKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gIGNvbnN0IGNvdW50ID0gZ2V0SGFsbE9mRmFtZSgpLmxlbmd0aDtcclxuICBhd2FpdCBjb25maXJtRGlhbG9nKHtcclxuICAgIHRpdGxlOiBcIkNsZWFyIHRoZSBoYWxsIG9mIGZhbWU/XCIsXHJcbiAgICBib2R5OiBgXHJcbiAgICAgICAgPHA+JHtjb3VudCA9PT0gMCA/IFwiVGhlIGhhbGwgb2YgZmFtZSBpcyBhbHJlYWR5IGVtcHR5LlwiIDogYFRoZSAke3BsdXJhbChjb3VudCwgXCJzY2VuZVwiKX0gdGhhdCAke2NvdW50ID09PSAxID8gXCJoYXNcIiA6IFwiaGF2ZVwifSBiZWVuICMxIHdpbGwgYmUgdGFrZW4gb2ZmIHRoZSBsaXN0LmB9XHJcbiAgICAgICAgWW91ciBjdXJyZW50ICMxIGpvaW5zIGl0IGFnYWluLCBmcm9tIHRvZGF5LCB0aGUgbmV4dCB0aW1lIHlvdSBiYXR0bGUgb3Igb3BlbiBSZWNvcmRzLjwvcD5cclxuICAgICAgICA8cD5FTE8gYW5kIHJlY29yZHMgYXJlbid0IHRvdWNoZWQuPC9wPmAsXHJcbiAgICBjb25maXJtTGFiZWw6IFwiQ2xlYXIgaGFsbCBvZiBmYW1lXCIsXHJcbiAgICB3b3JraW5nTGFiZWw6IFwiQ2xlYXJpbmfigKZcIixcclxuICAgIGFjdGlvbjogYXN5bmMgKCkgPT4ge1xyXG4gICAgICBpZiAoIShhd2FpdCBjbGVhckhhbGxPZkZhbWUoKSkpIHRocm93IG5ldyBFcnJvcihcIkNvdWxkbid0IHNhdmUgdG8gU3Rhc2guIFRyeSBhZ2Fpbi5cIik7XHJcbiAgICB9LFxyXG4gIH0pO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBzdGFydFJlc2V0RWxvKG1vZGFsOiBIVE1MRWxlbWVudCk6IFByb21pc2U8dm9pZD4ge1xyXG4gIGlmIChzdGF0ZS5zZXR0aW5ncy50ZXN0TW9kZSkge1xyXG4gICAgYXdhaXQgY29uZmlybURpYWxvZyh7XHJcbiAgICAgIHRpdGxlOiBcIlR1cm4gb2ZmIHRlc3QgbW9kZSBmaXJzdFwiLFxyXG4gICAgICBib2R5OiBcIjxwPlJlc2V0IEVMTyByZXdyaXRlcyBldmVyeSBzY2VuZSBpbiB5b3VyIGxpYnJhcnksIHdoaWNoIHRlc3QgbW9kZSBjYW4ndCBob2xkIGJhY2suIFR1cm4gb2ZmIHRlc3QgbW9kZSBpbiBTZXR0aW5ncywgdGhlbiByZXNldC48L3A+XCIsXHJcbiAgICAgIGNvbmZpcm1MYWJlbDogXCJPS1wiLFxyXG4gICAgfSk7XHJcbiAgICByZXR1cm47XHJcbiAgfVxyXG4gIGNvbnN0IHJhdGluZ3NPbiA9IHN0YXRlLnNldHRpbmdzLnN0YXNoUmF0aW5ncyAhPT0gXCJvZmZcIjtcclxuICBjb25zdCBvayA9IGF3YWl0IGNvbmZpcm1EaWFsb2coe1xyXG4gICAgdGl0bGU6IFwiUmVzZXQgRUxPP1wiLFxyXG4gICAgYm9keTogYFxyXG4gICAgICAgIDxwPkV2ZXJ5IHNjZW5lJ3MgRUxPIGFuZCBiYXR0bGUgY291bnQgd2lsbCBiZSBvdmVyd3JpdHRlbi4gTmV4dCB5b3UgY2hvb3NlIGhvdyBFTE8gc3RhcnRzXHJcbiAgICAgICAgYWdhaW46IGZyb20geW91ciBTdGFzaCByYXRpbmdzLCBvciAxNTAwIGZvciBldmVyeW9uZS4ke3JhdGluZ3NPbiA/IFwiIFN0YXNoIHJhdGluZ3MgYXJlIHRoZW4gdXBkYXRlZCBmcm9tIHRoZSBuZXcgRUxPLlwiIDogXCJcIn08L3A+XHJcbiAgICAgICAgPHA+Tm90aGluZyBjaGFuZ2VzIHVudGlsIHlvdSBwcmVzcyBTdGFydCBvbiB0aGUgbmV4dCBzY3JlZW4uPC9wPmAsXHJcbiAgICBjb25maXJtTGFiZWw6IFwiQ29udGludWVcIixcclxuICB9KTtcclxuICBpZiAoIW9rKSByZXR1cm47XHJcblxyXG4gIHN0YXRlLnJlc2V0dGluZ0VsbyA9IHRydWU7XHJcbiAgc2hvd1RhYihtb2RhbCwgXCJiYXR0bGVcIik7XHJcbiAgbW9kYWwucXVlcnlTZWxlY3RvckFsbDxIVE1MVmlkZW9FbGVtZW50PihcIi5zYi1ob3Zlci1wcmV2aWV3XCIpLmZvckVhY2goKHYpID0+IHYucGF1c2UoKSk7XHJcbiAgc2hvd1NldHVwU2NyZWVuKG1vZGFsLCAoKSA9PiBhZnRlclNldHVwKG1vZGFsKSwge1xyXG4gICAgcmVzZXQ6IHRydWUsXHJcbiAgICBvbkNhbmNlbDogKCkgPT4ge1xyXG4gICAgICBzdGF0ZS5yZXNldHRpbmdFbG8gPSBmYWxzZTtcclxuICAgICAgaGlkZVNldHVwU2NyZWVuKG1vZGFsKTtcclxuICAgICAgaWYgKHN0YXRlLmN1cnJlbnRQYWlyLmxlZnQgJiYgc3RhdGUuY3VycmVudFBhaXIucmlnaHQpIHZvaWQgcmVzdG9yZUN1cnJlbnRQYWlyKCk7XHJcbiAgICAgIGVsc2Ugdm9pZCBsb2FkTmV3UGFpcigpO1xyXG4gICAgfSxcclxuICB9KTtcclxufVxyXG5cclxuLyoqIFNldHVwIChmaXJzdCB0aW1lIG9yIFJlc2V0IEVMTykgZmluaXNoZWQ6IHNldHRpbmdzIGl0IHNhdmVkIHNob3csIHRoZW4gYmF0dGxlcyBzdGFydC4gKi9cclxuZnVuY3Rpb24gYWZ0ZXJTZXR1cChtb2RhbDogSFRNTEVsZW1lbnQpOiB2b2lkIHtcclxuICBzdGF0ZS5yZXNldHRpbmdFbG8gPSBmYWxzZTtcclxuICAvLyBUaGUgbGFzdCBwaWNrJ3MgdmFsdWVzIGJlbG9uZyB0byB0aGUgb2xkIEVMT1xyXG4gIGNsZWFyVW5kbygpO1xyXG4gIHN5bmNTZXR0aW5nc0NvbnRyb2xzKG1vZGFsKTtcclxuICB1cGRhdGVSYXRpbmdzTm90ZSgpO1xyXG4gIHZvaWQgbG9hZE5ld1BhaXIoZ2V0U2NlbmVJZEZyb21VcmwoKSk7XHJcbn1cclxuXHJcbi8qKiBDaGFuZ2UgbW9kZTogdGhlIHJ1biwgc2h1ZmZsZSBwb3NpdGlvbiBhbmQgXCJCYXR0bGUgdGhlIGxlYXN0LXRlc3RlZFwiIHN0YXJ0IG92ZXIuICovXHJcbmZ1bmN0aW9uIHN3aXRjaE1vZGUobW9kYWw6IEhUTUxFbGVtZW50LCBtb2RlOiBNb2RlKTogdm9pZCB7XHJcbiAgc3RhdGUuY3VycmVudE1vZGUgPSBtb2RlO1xyXG4gIHJlc2V0UnVuU3RhdGUoKTtcclxuICBzdGF0ZS5zaHVmZmxlSW5kZXggPSAwO1xyXG4gIHN0YXRlLmxlYXN0VGVzdGVkID0gZmFsc2U7XHJcbiAgbW9kYWwucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oXCIuc2ItbW9kZS1idG5cIikuZm9yRWFjaCgoYikgPT4ge1xyXG4gICAgYi5jbGFzc0xpc3QudG9nZ2xlKFwiYWN0aXZlXCIsIGIuZGF0YXNldC5tb2RlID09PSBzdGF0ZS5jdXJyZW50TW9kZSk7XHJcbiAgfSk7XHJcbiAgdXBkYXRlTW9kZUluZm8oKTtcclxuICB1cGRhdGVDbGltYlBvb2xXYXJuaW5nKCk7XHJcbiAgdXBkYXRlUG9vbFN0YXR1cygpO1xyXG59XHJcblxyXG4vKiogVGhlIFN0YXRzIGFuZCBFeHBsb3JlIHRhYnMnIGFjdGlvbnM6IGJhdHRsZSBhIHNjZW5lLCBiYXR0bGUgdGhlIGxlYXN0LXRlc3RlZCwgb3IgZXhwbG9yZSBhbiBFTE8gcmFuZ2UuICovXHJcbmZ1bmN0aW9uIHN0YXRzQWN0aW9ucyhtb2RhbDogSFRNTEVsZW1lbnQpOiBTdGF0c0FjdGlvbnMge1xyXG4gIGNvbnN0IHRvQmF0dGxlID0gKCk6IHZvaWQgPT4ge1xyXG4gICAgcmVzZXRSdW5TdGF0ZSgpO1xyXG4gICAgc3RhdGUuY3VycmVudFBhaXIgPSB7IGxlZnQ6IG51bGwsIHJpZ2h0OiBudWxsIH07XHJcbiAgICBzdGF0ZS5jdXJyZW50UmFua3MgPSB7IGxlZnQ6IG51bGwsIHJpZ2h0OiBudWxsIH07XHJcbiAgICB1cGRhdGVQb29sU3RhdHVzKCk7XHJcbiAgICBzaG93VGFiKG1vZGFsLCBcImJhdHRsZVwiKTtcclxuICAgIGFwcGx5UHJldmlld1NldHRpbmdzKCk7XHJcbiAgfTtcclxuICByZXR1cm4ge1xyXG4gICAgLy8gTGlrZSBvcGVuaW5nIFN0YXNoIEJhdHRsZSBmcm9tIHRoZSBzY2VuZSdzIHBhZ2U6IHRoZSBzY2VuZSBiYXR0bGVzLCBpbiB0aGUgY3VycmVudCBtb2RlLFxyXG4gICAgLy8gdW50aWwgc3RvcHBlZFxyXG4gICAgYmF0dGxlU2NlbmU6IChzY2VuZUlkKSA9PiB7XHJcbiAgICAgIHN0YXRlLmxlYXN0VGVzdGVkID0gZmFsc2U7XHJcbiAgICAgIHN0YXRlLmV4cGxvcmVQb29sID0gb25lU2NlbmVQb29sKHNjZW5lSWQpO1xyXG4gICAgICByZXNldFNodWZmbGUoKTtcclxuICAgICAgdG9CYXR0bGUoKTtcclxuICAgICAgdm9pZCBsb2FkTmV3UGFpcihzY2VuZUlkKTtcclxuICAgIH0sXHJcbiAgICAvLyBFeHBsb3JlIGF0IHRoaXMgRUxPIHJhbmdlIChhIGhpc3RvZ3JhbSBiYXIpXHJcbiAgICBleHBsb3JlUmFuZ2U6IChlbG9NaW4sIGVsb01heCkgPT4ge1xyXG4gICAgICBzZXRFeHBsb3JlRmlsdGVycyh7IGVsb01pbiwgZWxvTWF4IH0pO1xyXG4gICAgICBzaG93VGFiKG1vZGFsLCBcImV4cGxvcmVcIik7XHJcbiAgICAgIC8vIENvbWluZyBmcm9tIHRoZSBib3R0b20gb2YgU3RhdHM6IHNjcm9sbCBzbyB0aGUgZmlyc3Qgcm93IG9mIGNhcmRzIHN0YXJ0cyBqdXN0IGJlbG93IHRoZVxyXG4gICAgICAvLyB0b3AsIHdpdGggdGhlIHNjZW5lIGNvdW50IGFuZCBcIkJhdHRsZSB0aGVzZVwiIGxpbmUgYWJvdmUgaXRcclxuICAgICAgY29uc3Qgc2Nyb2xsVG9DYXJkcyA9ICgpOiB2b2lkID0+IHtcclxuICAgICAgICBjb25zdCBzY3JvbGxlciA9IG1vZGFsLnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiLnNiLW1vZGFsLWNvbnRlbnRcIik7XHJcbiAgICAgICAgY29uc3Qgc3RhdHVzID0gbW9kYWwucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCIuc2ItZXhwbG9yZS1zdGF0dXMtcm93XCIpO1xyXG4gICAgICAgIGlmICghc2Nyb2xsZXIpIHJldHVybjtcclxuICAgICAgICBzY3JvbGxlci5zY3JvbGxUb3AgPSAwO1xyXG4gICAgICAgIGlmIChzdGF0dXMpIHNjcm9sbGVyLnNjcm9sbFRvcCA9IHN0YXR1cy5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKS50b3AgLSBzY3JvbGxlci5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKS50b3AgLSA4O1xyXG4gICAgICB9O1xyXG4gICAgICB2b2lkIHJlbmRlckV4cGxvcmVUYWIobW9kYWwsIHN0YXRzQWN0aW9ucyhtb2RhbCkpLnRoZW4oc2Nyb2xsVG9DYXJkcyk7XHJcbiAgICB9LFxyXG4gICAgLy8gU3dpc3Mgd2l0aCB0aGUgZmV3ZXN0LWJhdHRsZWQgc2NlbmVzIG9uIHRoZSBsZWZ0LCB1bnRpbCBzdG9wcGVkIG9yIHRoZSBtb2RlIGNoYW5nZXNcclxuICAgIGJhdHRsZUxlYXN0VGVzdGVkOiAoKSA9PiB7XHJcbiAgICAgIGlmIChzdGF0ZS5jdXJyZW50TW9kZSAhPT0gXCJzd2lzc1wiKSBzd2l0Y2hNb2RlKG1vZGFsLCBcInN3aXNzXCIpO1xyXG4gICAgICBzdGF0ZS5leHBsb3JlUG9vbCA9IG51bGw7XHJcbiAgICAgIHN0YXRlLmxlYXN0VGVzdGVkID0gdHJ1ZTtcclxuICAgICAgdG9CYXR0bGUoKTtcclxuICAgICAgdm9pZCBsb2FkTmV3UGFpcigpO1xyXG4gICAgfSxcclxuICAgIC8vIEJhdHRsZSBhbiBFeHBsb3JlIGZpbHRlciB1bnRpbCBzdG9wcGVkOiB1bnJhdGVkIHNjZW5lcyBnbyB0byBQbGFjZW1lbnQ7IG90aGVyIGZpbHRlcnMgdXNlXHJcbiAgICAvLyBTd2lzcyAodGhlIG1vZGUgY2FuIGJlIGNoYW5nZWQgYWZ0ZXIpXHJcbiAgICBiYXR0bGVGaWx0ZXI6IChmaWx0ZXJzLCBsYWJlbCkgPT4ge1xyXG4gICAgICBzdGF0ZS5sZWFzdFRlc3RlZCA9IGZhbHNlO1xyXG4gICAgICBzdGF0ZS5leHBsb3JlUG9vbCA9IHsgZmlsdGVyczogeyAuLi5maWx0ZXJzIH0sIGxhYmVsIH07XHJcbiAgICAgIHJlc2V0U2h1ZmZsZSgpO1xyXG4gICAgICBjb25zdCBtb2RlOiBNb2RlID0gZmlsdGVycy5ncm91cCA9PT0gXCJ1bnJhdGVkXCIgPyBcInBsYWNlbWVudFwiIDogXCJzd2lzc1wiO1xyXG4gICAgICBpZiAoc3RhdGUuY3VycmVudE1vZGUgIT09IG1vZGUpIHN3aXRjaE1vZGUobW9kYWwsIG1vZGUpO1xyXG4gICAgICB0b0JhdHRsZSgpO1xyXG4gICAgICB2b2lkIGxvYWROZXdQYWlyKCk7XHJcbiAgICAgIHNhdmVTdGF0ZSgpO1xyXG4gICAgfSxcclxuICB9O1xyXG59XHJcblxyXG4vKiogU3RvcCBsaW5rIGZvciBhIGJhdHRsZWQgRXhwbG9yZSBmaWx0ZXIgb3Igc2NlbmU6IGJhY2sgdG8gdGhlIFNjZW5lcyBwYWdlIGZpbHRlciAob3IgdGhlIHdob2xlIGxpYnJhcnkpLiAqL1xyXG5mdW5jdGlvbiBzdG9wRXhwbG9yZVBvb2woKTogdm9pZCB7XHJcbiAgc3RhdGUuZXhwbG9yZVBvb2wgPSBudWxsO1xyXG4gIHJlc2V0U2h1ZmZsZSgpO1xyXG4gIHJlc2V0UnVuU3RhdGUoKTtcclxuICBzYXZlU3RhdGUoKTtcclxuICB2b2lkIGxvYWROZXdQYWlyKCk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBUZXN0IG1vZGUgZW5kZWQ6IHRoZSBzY2VuZSBjYWNoZSwgdGhlIHBhaXIgb24gc2NyZWVuIGFuZCB0aGUgbGFzdCBwaWNrIGhvbGQgdW5zYXZlZCBFTE8sIHNvXHJcbiAqIHN0YXJ0IGFnYWluIGZyb20gd2hhdCBTdGFzaCBoYXMuXHJcbiAqL1xyXG5hc3luYyBmdW5jdGlvbiBmb3JnZXRUZXN0Q2hhbmdlcygpOiBQcm9taXNlPHZvaWQ+IHtcclxuICBjbGVhclVuZG8oKTtcclxuICByZXNldFJ1blN0YXRlKCk7XHJcbiAgcmVzZXRTaHVmZmxlKCk7XHJcbiAgc3RhdGUuY3VycmVudFBhaXIgPSB7IGxlZnQ6IG51bGwsIHJpZ2h0OiBudWxsIH07XHJcbiAgc3RhdGUuY3VycmVudFJhbmtzID0geyBsZWZ0OiBudWxsLCByaWdodDogbnVsbCB9O1xyXG4gIHNhdmVTdGF0ZSgpO1xyXG4gIGF3YWl0IGNsZWFyU2NlbmVDYWNoZSgpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBvblNldHRpbmdDaGFuZ2VkKGtleToga2V5b2YgU2V0dGluZ3MpOiB2b2lkIHtcclxuICBzd2l0Y2ggKGtleSkge1xyXG4gICAgY2FzZSBcInRlc3RNb2RlXCI6IHtcclxuICAgICAgdXBkYXRlUmF0aW5nc05vdGUoKTtcclxuICAgICAgY29uc3QgbW9kYWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInNiLW1vZGFsXCIpO1xyXG4gICAgICBpZiAobW9kYWwpIHN5bmNTZXR0aW5nc0NvbnRyb2xzKG1vZGFsKTtcclxuICAgICAgLy8gQSBwaWNrIGZyb20gYmVmb3JlIGl0IHdhcyBvbiBjYW4ndCBiZSB1bmRvbmUgaW4gU3Rhc2ggd2hpbGUgaXQncyBvblxyXG4gICAgICBpZiAoc3RhdGUuc2V0dGluZ3MudGVzdE1vZGUpIGNsZWFyVW5kbygpO1xyXG4gICAgICBlbHNlIHZvaWQgZm9yZ2V0VGVzdENoYW5nZXMoKS50aGVuKCgpID0+IGxvYWROZXdQYWlyKCkpO1xyXG4gICAgICBicmVhaztcclxuICAgIH1cclxuICAgIGNhc2UgXCJzdGFzaFJhdGluZ3NcIjpcclxuICAgICAgdXBkYXRlUmF0aW5nc05vdGUoKTtcclxuICAgICAgLy8gQ2F0Y2ggYW55dGhpbmcgYSBwZXItYmF0dGxlIHN5bmMgdW5kZXIgdGhlIG9sZCBtb2RlIGNoYW5nZWQgYWZ0ZXIgdGhlIHN3aXRjaCB3YXMgY291bnRlZFxyXG4gICAgICBzY2hlZHVsZVN0YXNoUmF0aW5nU3luYygpO1xyXG4gICAgICBicmVhaztcclxuICAgIGNhc2UgXCJmaWx0ZXJPcHBvbmVudHNcIjpcclxuICAgICAgLy8gc3dpdGNoaW5nIHRoZSB0b2dnbGUgY291bnRzIGFzIGNoYW5naW5nIGZpbHRlcnM6IHJlc2V0IGFueSBydW5cclxuICAgICAgaWYgKHN0YXRlLmN1cnJlbnRNb2RlICE9PSBcInN3aXNzXCIpIHJlc2V0UnVuU3RhdGUoKTtcclxuICAgICAgc2F2ZVN0YXRlKCk7XHJcbiAgICAgIGxvYWROZXdQYWlyKCk7XHJcbiAgICAgIHVwZGF0ZUNsaW1iUG9vbFdhcm5pbmcoKTtcclxuICAgICAgYnJlYWs7XHJcbiAgICBjYXNlIFwicGxhY2VtZW50RnJvbUJvdHRvbVwiOiB7XHJcbiAgICAgIC8vIFJlc3RhcnQgdGhlIHNjZW5lJ3MgcnVuIGZyb20gdGhlIG5ldyBzdGFydCBwb2ludCAobm90aGluZyBpcyB3cml0dGVuIHVudGlsIGl0IGxhbmRzKVxyXG4gICAgICBjb25zdCBzY2VuZUlkID0gc3RhdGUuY3VycmVudE1vZGUgPT09IFwicGxhY2VtZW50XCIgPyBzdGF0ZS5wbGFjZW1lbnQ/LnNjZW5lLmlkIDogdW5kZWZpbmVkO1xyXG4gICAgICBpZiAoc2NlbmVJZCkge1xyXG4gICAgICAgIHJlc2V0UnVuU3RhdGUoKTtcclxuICAgICAgICBzYXZlU3RhdGUoKTtcclxuICAgICAgICB2b2lkIGxvYWROZXdQYWlyKHNjZW5lSWQpO1xyXG4gICAgICB9XHJcbiAgICAgIGJyZWFrO1xyXG4gICAgfVxyXG4gICAgY2FzZSBcInByZXZpZXdWb2x1bWVcIjpcclxuICAgIGNhc2UgXCJhdXRvcGxheVByZXZpZXdzXCI6XHJcbiAgICAgIGFwcGx5UHJldmlld1NldHRpbmdzKCk7XHJcbiAgICAgIGJyZWFrO1xyXG4gICAgY2FzZSBcIm9wZW5Jbk5ld1RhYlwiOlxyXG4gICAgY2FzZSBcImNsZWFuTW9kZVwiOlxyXG4gICAgY2FzZSBcInRpZXJCb3JkZXJzXCI6XHJcbiAgICAgIHJlcmVuZGVyQ3VycmVudFBhaXIoKTtcclxuICAgICAgYnJlYWs7XHJcbiAgfVxyXG59XHJcblxyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gb3Blbk1vZGFsKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+OryBPcGVuaW5nIG1vZGFsLi4uXCIpO1xyXG5cclxuICBjb25zdCB3YXNUZXN0aW5nID0gc3RhdGUuc2V0dGluZ3MudGVzdE1vZGU7XHJcbiAgY29uc3QgW3NldHRpbmdzT2ssIGN1c3RvbUZpZWxkc09rXSA9IGF3YWl0IFByb21pc2UuYWxsKFtsb2FkU2V0dGluZ3MoKSwgc2NlbmVDdXN0b21GaWVsZHNTdXBwb3J0ZWQoKV0pO1xyXG4gIC8vIFR1cm5lZCBvZmYgaW4gYW5vdGhlciB0YWIgbWVhbndoaWxlXHJcbiAgaWYgKHdhc1Rlc3RpbmcgJiYgIXN0YXRlLnNldHRpbmdzLnRlc3RNb2RlKSBhd2FpdCBmb3JnZXRUZXN0Q2hhbmdlcygpO1xyXG4gIGlmICghY3VzdG9tRmllbGRzT2spIHtcclxuICAgIHNob3dNZXNzYWdlTW9kYWwoXHJcbiAgICAgIFwiU3Rhc2ggQmF0dGxlIG5lZWRzIGEgbmV3ZXIgdmVyc2lvbiBvZiBTdGFzaDogaXQgc3RvcmVzIGVhY2ggc2NlbmUncyBFTE8gaW4gc2NlbmUgY3VzdG9tIGZpZWxkcywgd2hpY2ggdGhpcyBTdGFzaCBkb2Vzbid0IGhhdmUuIFVwZGF0ZSBTdGFzaCB0byB1c2UgU3Rhc2ggQmF0dGxlLlwiLFxyXG4gICAgKTtcclxuICAgIHJldHVybjtcclxuICB9XHJcbiAgLy8gV2l0aG91dCBzZXR0aW5ncywgQmF0dGxlIGNhbid0IHRlbGwgd2hldGhlciB0aGUgb25lLXRpbWUgRUxPIHNldHVwIGFscmVhZHkgcmFuIChhbmQgcnVubmluZ1xyXG4gIC8vIGl0IGFnYWluIHdvdWxkIG92ZXJ3cml0ZSBldmVyeSBzY2VuZSdzIEVMTylcclxuICBpZiAoIXNldHRpbmdzT2sgJiYgaXNFbG9TZXR1cFBlbmRpbmcoKSkge1xyXG4gICAgc2hvd01lc3NhZ2VNb2RhbChcIlN0YXNoIEJhdHRsZSBjb3VsZG4ndCBsb2FkIGl0cyBzZXR0aW5ncyBmcm9tIFN0YXNoLiBDbG9zZSBTdGFzaCBCYXR0bGUgYW5kIHRyeSBhZ2Fpbi5cIik7XHJcbiAgICByZXR1cm47XHJcbiAgfVxyXG4gIGFkZEtleVN3YWxsb3dlcnMoKTtcclxuICBob2xkU3Rhc2hMaXN0UmVmcmVzaCh0cnVlKTtcclxuXHJcbiAgLy8gT3B0aW9uYWxseSBwYXVzZSB3aGF0ZXZlciBTdGFzaCBpcyBwbGF5aW5nIHNvIGl0IGRvZXNuJ3Qgb3ZlcmxhcCB0aGUgYmF0dGxlIHByZXZpZXdzXHJcbiAgaWYgKHN0YXRlLnNldHRpbmdzLnBhdXNlTWVkaWFPbk9wZW4pIHtcclxuICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTE1lZGlhRWxlbWVudD4oXCJ2aWRlbywgYXVkaW9cIikuZm9yRWFjaCgodikgPT4gdi5wYXVzZSgpKTtcclxuICB9XHJcblxyXG4gIGlmICghc2NlbmVNaXNzaW5nTGlzdGVuZXJBZGRlZCkge1xyXG4gICAgc2NlbmVNaXNzaW5nTGlzdGVuZXJBZGRlZCA9IHRydWU7XHJcbiAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcihTQ0VORV9NSVNTSU5HX0VWRU5ULCAoZSkgPT4ge1xyXG4gICAgICB2b2lkIGhhbmRsZVNjZW5lR29uZSgoZSBhcyBDdXN0b21FdmVudDxzdHJpbmc+KS5kZXRhaWwpO1xyXG4gICAgfSk7XHJcbiAgfVxyXG5cclxuICAvLyBUcnkgdG8gbG9hZCBzYXZlZCBzdGF0ZVxyXG4gIGNvbnN0IGhhc1N0YXRlID0gbG9hZFN0YXRlKCk7XHJcbiAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIPCfk4sgTG9jYWxTdG9yYWdlIHN0YXRlOiAke2hhc1N0YXRlID8gXCJmb3VuZFwiIDogXCJub25lXCJ9YCk7XHJcblxyXG4gIC8vIENoZWNrIGlmIFVSTCBmaWx0ZXIgcGFyYW1zIGhhdmUgY2hhbmdlZCAtIGlmIHNvLCByZXNldCBzdGF0ZVxyXG4gIGNvbnN0IGN1cnJlbnRGaWx0ZXJQYXJhbXMgPSBzY2VuZXNMaXN0UXVlcnkoKTtcclxuICBjb25zdCBmaWx0ZXJzQ2hhbmdlZCA9IGhhc1N0YXRlICYmIHN0YXRlLnNhdmVkRmlsdGVyUGFyYW1zICE9PSBjdXJyZW50RmlsdGVyUGFyYW1zO1xyXG5cclxuICBpZiAoZmlsdGVyc0NoYW5nZWQpIHtcclxuICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0gRmlsdGVyIHBhcmFtcyBjaGFuZ2VkLCByZXNldHRpbmcgcnVuIHN0YXRlIGFuZCBmaWx0ZXJlZCBjYWNoZVwiKTtcclxuICAgIHN0YXRlLmN1cnJlbnRQYWlyID0geyBsZWZ0OiBudWxsLCByaWdodDogbnVsbCB9O1xyXG4gICAgc3RhdGUuY3VycmVudFJhbmtzID0geyBsZWZ0OiBudWxsLCByaWdodDogbnVsbCB9O1xyXG4gICAgcmVzZXRSdW5TdGF0ZSgpO1xyXG4gICAgc3RhdGUuc2F2ZWRGaWx0ZXJQYXJhbXMgPSBjdXJyZW50RmlsdGVyUGFyYW1zO1xyXG5cclxuICAgIC8vIENsZWFyIGZpbHRlcmVkIHNjZW5lcyBjYWNoZSAoYnV0IGtlZXAgYWxsIHNjZW5lcyBjYWNoZSlcclxuICAgIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzID0gbnVsbDtcclxuICAgIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcktleSA9IG51bGw7XHJcblxyXG4gICAgLy8gUmVzZXQgc2h1ZmZsZSBmb3IgbmV3IGZpbHRlclxyXG4gICAgcmVzZXRTaHVmZmxlKCk7XHJcbiAgfVxyXG5cclxuICAvLyBEZXRlY3QgaWYgb3BlbmVkIGZyb20gYW4gaW5kaXZpZHVhbCBzY2VuZSBwYWdlIChlLmcuIC9zY2VuZXMvMTIzKVxyXG4gIGNvbnN0IHNjZW5lUGFnZUlkID0gZ2V0U2NlbmVJZEZyb21VcmwoKTtcclxuICBjb25zdCBzY2VuZUFscmVhZHlJblBhaXIgPVxyXG4gICAgc2NlbmVQYWdlSWQgJiZcclxuICAgIHN0YXRlLmN1cnJlbnRQYWlyLmxlZnQgJiZcclxuICAgIHN0YXRlLmN1cnJlbnRQYWlyLnJpZ2h0ICYmXHJcbiAgICAoU3RyaW5nKHN0YXRlLmN1cnJlbnRQYWlyLmxlZnQuaWQpID09PSBzY2VuZVBhZ2VJZCB8fFxyXG4gICAgICBTdHJpbmcoc3RhdGUuY3VycmVudFBhaXIucmlnaHQuaWQpID09PSBzY2VuZVBhZ2VJZCk7XHJcbiAgY29uc3QgZm9yY2VTY2VuZUJhdHRsZSA9IHNjZW5lUGFnZUlkICYmICFzY2VuZUFscmVhZHlJblBhaXI7XHJcblxyXG4gIGlmIChmb3JjZVNjZW5lQmF0dGxlKSB7XHJcbiAgICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g8J+OryBPcGVuZWQgZnJvbSBzY2VuZSBwYWdlICR7c2NlbmVQYWdlSWR9LCBzdGFydGluZyBuZXcgYmF0dGxlIHdpdGggdGhpcyBzY2VuZWApO1xyXG4gICAgcmVzZXRSdW5TdGF0ZSgpO1xyXG4gICAgc3RhdGUuY3VycmVudFBhaXIgPSB7IGxlZnQ6IG51bGwsIHJpZ2h0OiBudWxsIH07XHJcbiAgICBzdGF0ZS5jdXJyZW50UmFua3MgPSB7IGxlZnQ6IG51bGwsIHJpZ2h0OiBudWxsIH07XHJcbiAgfVxyXG4gIC8vIE9wZW5lZCBmcm9tIGEgc2NlbmUgcGFnZTogdGhhdCBzY2VuZSBrZWVwcyBiYXR0bGluZyB1bnRpbCBTdG9wLiBOb3Qgd2hlbiBpdCdzIGFscmVhZHkgaW4gdGhlXHJcbiAgLy8gcGFpciAoaXRzIG9wcG9uZW50J3MgcGFnZSwgc2F5LCBvcGVuZWQgdG8gbG9vayBhdCB0aGUgYmF0dGxlKTogdGhlbiB0aGUgcGFpciBhbmQgcG9vbCBzdGF5XHJcbiAgaWYgKGZvcmNlU2NlbmVCYXR0bGUgJiYgc3RhdGUuZXhwbG9yZVBvb2w/LnNjZW5lSWQgIT09IHNjZW5lUGFnZUlkKSB7XHJcbiAgICBzdGF0ZS5sZWFzdFRlc3RlZCA9IGZhbHNlO1xyXG4gICAgc3RhdGUuZXhwbG9yZVBvb2wgPSBvbmVTY2VuZVBvb2woc2NlbmVQYWdlSWQpO1xyXG4gICAgcmVzZXRTaHVmZmxlKCk7XHJcbiAgfVxyXG5cclxuICAvLyBDaGVjayBmb3IgZXhpc3RpbmcgaGlkZGVuIG1vZGFsIC0gcmV1c2UgaXQgKHVubGVzcyBpdCdzIGEgbWVzc2FnZSBtb2RhbCwgc2VlIHNob3dNZXNzYWdlTW9kYWwpXHJcbiAgY29uc3QgZXhpc3RpbmdNb2RhbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic2ItbW9kYWxcIik7XHJcbiAgaWYgKFxyXG4gICAgZXhpc3RpbmdNb2RhbCAmJlxyXG4gICAgZXhpc3RpbmdNb2RhbC5jbGFzc0xpc3QuY29udGFpbnMoXCJzYi1tb2RhbC1oaWRkZW5cIikgJiZcclxuICAgIGV4aXN0aW5nTW9kYWwucXVlcnlTZWxlY3RvcihcIiNzdGFzaC1iYXR0bGUtY29udGFpbmVyXCIpXHJcbiAgKSB7XHJcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIOKZu++4jyBSZXVzaW5nIGV4aXN0aW5nIG1vZGFsXCIpO1xyXG4gICAgZXhpc3RpbmdNb2RhbC5jbGFzc0xpc3QucmVtb3ZlKFwic2ItbW9kYWwtaGlkZGVuXCIsIFwic2ItbW9kYWwtY2xvc2luZ1wiKTtcclxuICAgIGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LmFkZChCQVRUTEVfT1BFTl9DTEFTUyk7XHJcblxyXG4gICAgLy8gQWx3YXlzIHJlb3BlbiBvbiB0aGUgQmF0dGxlIHRhYjsgc2V0dGluZ3MgbWF5IGhhdmUgY2hhbmdlZCBlbHNld2hlcmUgbWVhbndoaWxlXHJcbiAgICBzaG93VGFiKGV4aXN0aW5nTW9kYWwsIFwiYmF0dGxlXCIpO1xyXG4gICAgc3luY1NldHRpbmdzQ29udHJvbHMoZXhpc3RpbmdNb2RhbCk7XHJcbiAgICB1cGRhdGVSYXRpbmdzTm90ZSgpO1xyXG5cclxuICAgIC8vIFJlLXJlZ2lzdGVyIGtleWJvYXJkIGhhbmRsZXJcclxuICAgIGlmIChtb2RhbEtleUhhbmRsZXIpIHtcclxuICAgICAgZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImtleWRvd25cIiwgbW9kYWxLZXlIYW5kbGVyLCB0cnVlKTtcclxuICAgICAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcImtleWRvd25cIiwgbW9kYWxLZXlIYW5kbGVyLCB0cnVlKTtcclxuICAgIH1cclxuXHJcbiAgICAvLyBGb2N1cyBtb2RhbCBjb250ZW50XHJcbiAgICBjb25zdCBtb2RhbENvbnRlbnQgPSBleGlzdGluZ01vZGFsLnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiLnNiLW1vZGFsLWNvbnRlbnRcIik7XHJcbiAgICBpZiAobW9kYWxDb250ZW50KSBtb2RhbENvbnRlbnQuZm9jdXMoKTtcclxuXHJcbiAgICAvLyBUaGUgb25lLXRpbWUgRUxPIHNldHVwIHNob3dzIGluIHBsYWNlIG9mIHRoZSBiYXR0bGUgdW50aWwgaXQncyBkb25lXHJcbiAgICBpZiAoaXNFbG9TZXR1cFBlbmRpbmcoKSkge1xyXG4gICAgICBzaG93U2V0dXBTY3JlZW4oZXhpc3RpbmdNb2RhbCwgKCkgPT4gYWZ0ZXJTZXR1cChleGlzdGluZ01vZGFsKSk7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGhpZGVTZXR1cFNjcmVlbihleGlzdGluZ01vZGFsKTtcclxuICAgIC8vIEEgc2NlbmUgcGFnZSBtYXkgaGF2ZSBzdGFydGVkIGJhdHRsaW5nIGl0cyBzY2VuZSwgZXZlbiBpZiB0aGUgcGFpciBvbiBzY3JlZW4gc3RheXNcclxuICAgIHVwZGF0ZVBvb2xTdGF0dXMoKTtcclxuXHJcbiAgICAvLyBJZiBmaWx0ZXJzIGNoYW5nZWQsIG5vIHBhaXIsIG9yIGZvcmNlZCBzY2VuZSwgbG9hZCBuZXcgY29udGVudFxyXG4gICAgaWYgKGZvcmNlU2NlbmVCYXR0bGUpIHtcclxuICAgICAgbG9hZE5ld1BhaXIoc2NlbmVQYWdlSWQpO1xyXG4gICAgfSBlbHNlIGlmIChmaWx0ZXJzQ2hhbmdlZCkge1xyXG4gICAgICBsb2FkTmV3UGFpcigpO1xyXG4gICAgfSBlbHNlIGlmICghc3RhdGUuY3VycmVudFBhaXIubGVmdCB8fCAhc3RhdGUuY3VycmVudFBhaXIucmlnaHQpIHtcclxuICAgICAgLy8gQSBmaW5pc2hlZCBydW4ncyBlbmQgc2NyZWVuIHN0YXlzIHVudGlsIFwiU3RhcnQgTmV3IFJ1blwiICh0aGUgcnVuIGNsZWFyZWQgaXRzIHBhaXIpXHJcbiAgICAgIGlmICghZG9jdW1lbnQucXVlcnlTZWxlY3RvcihcIiNzYi1jb21wYXJpc29uLWFyZWEgLnNiLWVuZC1zY3JlZW5cIikpIGxvYWROZXdQYWlyKCk7XHJcbiAgICB9IGVsc2UgaWYgKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoXCIjc2ItY29tcGFyaXNvbi1hcmVhIC5zYi12cy1jb250YWluZXJcIikpIHtcclxuICAgICAgLy8gRXhpc3RpbmcgcGFpciBpcyBzdGlsbCB2YWxpZCB1bmxlc3MgYSBzY2VuZSB3YXMgZGVsZXRlZCBlbHNld2hlcmUgbWVhbndoaWxlXHJcbiAgICAgIGFwcGx5UHJldmlld1NldHRpbmdzKCk7XHJcbiAgICAgIHZvaWQgdmVyaWZ5Q3VycmVudFBhaXIoKTtcclxuICAgIH1cclxuXHJcbiAgICByZXR1cm47XHJcbiAgfVxyXG5cclxuICAvLyBSZW1vdmUgYW55IG90aGVyIGV4aXN0aW5nIG1vZGFsIChhIG1lc3NhZ2UgbW9kYWwsIG9yIGEgdmlzaWJsZSBvbmUsIHdoaWNoIHNob3VsZG4ndCBoYXBwZW4pXHJcbiAgaWYgKGV4aXN0aW5nTW9kYWwpIGV4aXN0aW5nTW9kYWwucmVtb3ZlKCk7XHJcblxyXG4gIC8vIEluaXRpYWxpemUgZmlsdGVyIHBhcmFtcyB0cmFja2luZ1xyXG4gIGlmICghc3RhdGUuc2F2ZWRGaWx0ZXJQYXJhbXMpIHtcclxuICAgIHN0YXRlLnNhdmVkRmlsdGVyUGFyYW1zID0gY3VycmVudEZpbHRlclBhcmFtcztcclxuICB9XHJcblxyXG4gIGNvbnN0IG1vZGFsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcclxuICBtb2RhbC5pZCA9IFwic2ItbW9kYWxcIjtcclxuICBtb2RhbC5pbm5lckhUTUwgPSBgXHJcbiAgICAgIDxkaXYgY2xhc3M9XCJzYi1tb2RhbC1iYWNrZHJvcFwiPjwvZGl2PlxyXG4gICAgICA8ZGl2IGNsYXNzPVwic2ItbW9kYWwtY29udGVudFwiPlxyXG4gICAgICAgIDxidXR0b24gY2xhc3M9XCJzYi1tb2RhbC1jbG9zZVwiIGFyaWEtbGFiZWw9XCJDbG9zZVwiPuKclTwvYnV0dG9uPlxyXG4gICAgICAgICR7Y3JlYXRlTWFpblVJKCl9XHJcbiAgICAgIDwvZGl2PlxyXG4gICAgYDtcclxuXHJcbiAgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZChtb2RhbCk7XHJcbiAgZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QuYWRkKEJBVFRMRV9PUEVOX0NMQVNTKTtcclxuXHJcbiAgLy8gRm9jdXMgdGhlIG1vZGFsIGNvbnRlbnQgc28ga2V5Ym9hcmQgc2hvcnRjdXRzIHdvcmsgaW1tZWRpYXRlbHlcclxuICBjb25zdCBtb2RhbENvbnRlbnQgPSBtb2RhbC5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIi5zYi1tb2RhbC1jb250ZW50XCIpO1xyXG4gIGlmIChtb2RhbENvbnRlbnQpIHtcclxuICAgIG1vZGFsQ29udGVudC5zZXRBdHRyaWJ1dGUoXCJ0YWJpbmRleFwiLCBcIi0xXCIpO1xyXG4gICAgbW9kYWxDb250ZW50LnN0eWxlLm91dGxpbmUgPSBcIm5vbmVcIjtcclxuICAgIG1vZGFsQ29udGVudC5mb2N1cygpO1xyXG4gICAgLy8gTm90aGluZyBpbiBTdGFzaCBCYXR0bGUgc2Nyb2xscyBzaWRld2F5cywgYnV0IGZvY3VzaW5nIG9yIHNjcm9sbGluZyB0byBhbiBlbGVtZW50IGNhbiBzdGlsbFxyXG4gICAgLy8gc2hpZnQgYW4gb3ZlcmZsb3cteDogaGlkZGVuIGJveCBzaWRld2F5cyAob24gcGhvbmVzLCBldmVyeXRoaW5nIHRoZW4gbG9va2VkIGN1dCBvZmYpXHJcbiAgICBtb2RhbENvbnRlbnQuYWRkRXZlbnRMaXN0ZW5lcihcclxuICAgICAgXCJzY3JvbGxcIixcclxuICAgICAgKCkgPT4ge1xyXG4gICAgICAgIGlmIChtb2RhbENvbnRlbnQuc2Nyb2xsTGVmdCAhPT0gMCkgbW9kYWxDb250ZW50LnNjcm9sbExlZnQgPSAwO1xyXG4gICAgICB9LFxyXG4gICAgICB7IHBhc3NpdmU6IHRydWUgfSxcclxuICAgICk7XHJcbiAgfVxyXG5cclxuICAvLyBNb2RlIHRvZ2dsZSBidXR0b25zXHJcbiAgbW9kYWwucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oXCIuc2ItbW9kZS1idG5cIikuZm9yRWFjaCgoYnRuKSA9PiB7XHJcbiAgICBidG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHtcclxuICAgICAgY29uc3QgbmV3TW9kZSA9IGJ0bi5kYXRhc2V0Lm1vZGUgYXMgTW9kZTtcclxuICAgICAgaWYgKG5ld01vZGUgIT09IHN0YXRlLmN1cnJlbnRNb2RlKSB7XHJcbiAgICAgICAgc3dpdGNoTW9kZShtb2RhbCwgbmV3TW9kZSk7XHJcbiAgICAgICAgLy8gTG9hZCBuZXcgcGFpciBpbiBuZXcgbW9kZSwgcHJlc2VydmluZyBzY2VuZSBwYWdlIGNvbnRleHRcclxuICAgICAgICBsb2FkTmV3UGFpcihnZXRTY2VuZUlkRnJvbVVybCgpKTtcclxuICAgICAgICBzYXZlU3RhdGUoKTtcclxuICAgICAgfVxyXG4gICAgfSk7XHJcbiAgfSk7XHJcblxyXG4gIC8vIFRvdWNoLW9ubHkg4pOYOiBzaG93L2hpZGUgdGhlIGN1cnJlbnQgbW9kZSdzIGV4cGxhbmF0aW9uXHJcbiAgY29uc3QgbW9kZUluZm9CdG4gPSBtb2RhbC5xdWVyeVNlbGVjdG9yPEhUTUxCdXR0b25FbGVtZW50PihcIi5zYi1tb2RlLWluZm8tYnRuXCIpO1xyXG4gIGNvbnN0IG1vZGVJbmZvID0gbW9kYWwucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCIjc2ItbW9kZS1pbmZvXCIpO1xyXG4gIG1vZGVJbmZvQnRuPy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4ge1xyXG4gICAgaWYgKCFtb2RlSW5mbykgcmV0dXJuO1xyXG4gICAgdXBkYXRlTW9kZUluZm8oKTtcclxuICAgIG1vZGVJbmZvLmhpZGRlbiA9ICFtb2RlSW5mby5oaWRkZW47XHJcbiAgICBtb2RlSW5mb0J0bi5zZXRBdHRyaWJ1dGUoXCJhcmlhLWV4cGFuZGVkXCIsIFN0cmluZyghbW9kZUluZm8uaGlkZGVuKSk7XHJcbiAgfSk7XHJcblxyXG4gIC8vIEJhdHRsZSAvIFNldHRpbmdzIC8gU3RhdHMgdGFicywgc2V0dGluZ3MgY29udHJvbHMsIHZvbHVtZVxyXG4gIHNob3dUYWIobW9kYWwsIFwiYmF0dGxlXCIpO1xyXG4gIGJpbmRTZXR0aW5nc0NvbnRyb2xzKFxyXG4gICAgbW9kYWwsXHJcbiAgICBvblNldHRpbmdDaGFuZ2VkLFxyXG4gICAgKHRhYikgPT4ge1xyXG4gICAgICBhcHBseVByZXZpZXdTZXR0aW5ncygpO1xyXG4gICAgICAvLyBBIHNtYWxsIGNhcmQncyBwcmV2aWV3IChFeHBsb3JlLCBvciBhIGhpZGRlbiBnZW1zIGNhcmQpIG5ldmVyIGtlZXBzIHBsYXlpbmcgb24gYW5vdGhlciB0YWJcclxuICAgICAgc3RvcE1pbmlQcmV2aWV3KCk7XHJcbiAgICAgIGlmICh0YWIgPT09IFwic3RhdHNcIikgdm9pZCByZW5kZXJTdGF0c1RhYihtb2RhbCwgc3RhdHNBY3Rpb25zKG1vZGFsKSk7XHJcbiAgICAgIGlmICh0YWIgPT09IFwicmVjb3Jkc1wiKSB2b2lkIHJlbmRlclJlY29yZHNUYWIobW9kYWwsIHN0YXRzQWN0aW9ucyhtb2RhbCkuYmF0dGxlU2NlbmUpO1xyXG4gICAgICBpZiAodGFiID09PSBcImV4cGxvcmVcIikgdm9pZCByZW5kZXJFeHBsb3JlVGFiKG1vZGFsLCBzdGF0c0FjdGlvbnMobW9kYWwpKTtcclxuICAgIH0sXHJcbiAgICBjb25maXJtU2V0dGluZ0NoYW5nZSxcclxuICApO1xyXG4gIHVwZGF0ZVJhdGluZ3NOb3RlKCk7XHJcbiAgdXBkYXRlUG9vbFN0YXR1cygpO1xyXG4gIC8vIFRoZSBwb29sIGxpbmUgaXMgcmVkcmF3biBvZnRlbiwgc28gaXRzIFN0b3AgbGlua3MgYXJlIGhhbmRsZWQgb24gdGhlIGxpbmUgaXRzZWxmXHJcbiAgbW9kYWwucXVlcnlTZWxlY3RvcihcIiNzYi1wb29sLXN0YXR1c1wiKT8uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XHJcbiAgICBjb25zdCB0YXJnZXQgPSBlLnRhcmdldCBhcyBFbGVtZW50O1xyXG4gICAgaWYgKHRhcmdldC5jbG9zZXN0KCdbZGF0YS1hY3Rpb249XCJzdG9wLWV4cGxvcmUtcG9vbFwiXScpKSB7XHJcbiAgICAgIGUucHJldmVudERlZmF1bHQoKTtcclxuICAgICAgc3RvcEV4cGxvcmVQb29sKCk7XHJcbiAgICB9IGVsc2UgaWYgKHRhcmdldC5jbG9zZXN0KCdbZGF0YS1hY3Rpb249XCJzdG9wLWxlYXN0LXRlc3RlZFwiXScpKSB7XHJcbiAgICAgIGUucHJldmVudERlZmF1bHQoKTtcclxuICAgICAgc3RhdGUubGVhc3RUZXN0ZWQgPSBmYWxzZTtcclxuICAgICAgdXBkYXRlUG9vbFN0YXR1cygpO1xyXG4gICAgfVxyXG4gIH0pO1xyXG5cclxuICBtb2RhbC5xdWVyeVNlbGVjdG9yKCdbZGF0YS1hY3Rpb249XCJyZXNldC1lbG9cIl0nKT8uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHZvaWQgc3RhcnRSZXNldEVsbyhtb2RhbCkpO1xyXG4gIG1vZGFsLnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLWFjdGlvbj1cImNsZWFyLWhhbGwtb2YtZmFtZVwiXScpPy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4gdm9pZCBjb25maXJtQ2xlYXJIYWxsT2ZGYW1lKCkpO1xyXG4gIC8vIFRoZSBub3RlcycgXCJjaGFuZ2UgaW4gU2V0dGluZ3NcIiAvIFwidHVybiBvZmYgaW4gU2V0dGluZ3NcIiBsaW5rc1xyXG4gIG1vZGFsLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWFjdGlvbj1cIm9wZW4tc2V0dGluZ3NcIl0nKS5mb3JFYWNoKChsaW5rKSA9PlxyXG4gICAgbGluay5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcclxuICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xyXG4gICAgICBzaG93VGFiKG1vZGFsLCBcInNldHRpbmdzXCIpO1xyXG4gICAgICBhcHBseVByZXZpZXdTZXR0aW5ncygpO1xyXG4gICAgfSksXHJcbiAgKTtcclxuXHJcbiAgLy8gU2tpcCBhbmQgVW5kbyBidXR0b25zXHJcbiAgbW9kYWwucXVlcnlTZWxlY3RvcihcIiNzYi1za2lwLWJ0blwiKT8uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIHNraXBQYWlyKTtcclxuICBtb2RhbC5xdWVyeVNlbGVjdG9yKFwiI3NiLXVuZG8tYnRuXCIpPy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4gdm9pZCB1bmRvTGFzdFBpY2soKSk7XHJcblxyXG4gIC8vIFJlZnJlc2ggY2FjaGUgYnV0dG9uXHJcbiAgY29uc3QgcmVmcmVzaENhY2hlQnRuID0gbW9kYWwucXVlcnlTZWxlY3RvcjxIVE1MQnV0dG9uRWxlbWVudD4oXCIjc2ItcmVmcmVzaC1jYWNoZS1idG5cIik7XHJcbiAgaWYgKHJlZnJlc2hDYWNoZUJ0bikge1xyXG4gICAgcmVmcmVzaENhY2hlQnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgIGlmIChzdGF0ZS5kaXNhYmxlQ2hvaWNlKSByZXR1cm47XHJcblxyXG4gICAgICBjb25zdCBsYWJlbCA9IHJlZnJlc2hDYWNoZUJ0bi50ZXh0Q29udGVudDtcclxuICAgICAgcmVmcmVzaENhY2hlQnRuLmRpc2FibGVkID0gdHJ1ZTtcclxuICAgICAgcmVmcmVzaENhY2hlQnRuLnRleHRDb250ZW50ID0gXCLwn5SEIFJlZnJlc2hpbmcuLi5cIjtcclxuXHJcbiAgICAgIHRyeSB7XHJcbiAgICAgICAgYXdhaXQgY2xlYXJTY2VuZUNhY2hlKCk7XHJcblxyXG4gICAgICAgIC8vIFJlc2V0IHNodWZmbGUgc3RhdGUgc2luY2Ugc2NlbmUgbGlzdCBpcyBiZWluZyByZWZyZXNoZWRcclxuICAgICAgICByZXNldFNodWZmbGUoKTtcclxuXHJcbiAgICAgICAgLy8gUmVzZXQgcnVuIHN0YXRlIHNpbmNlIHJhbmtpbmdzIG1heSBoYXZlIGNoYW5nZWRcclxuICAgICAgICByZXNldFJ1blN0YXRlKCk7XHJcbiAgICAgICAgc2F2ZVN0YXRlKCk7XHJcblxyXG4gICAgICAgIGF3YWl0IGxvYWROZXdQYWlyKCk7XHJcbiAgICAgIH0gY2F0Y2ggKGUpIHtcclxuICAgICAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0gUmVmcmVzaCBmYWlsZWQ6XCIsIGUpO1xyXG4gICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgIHJlZnJlc2hDYWNoZUJ0bi5kaXNhYmxlZCA9IGZhbHNlO1xyXG4gICAgICAgIHJlZnJlc2hDYWNoZUJ0bi50ZXh0Q29udGVudCA9IGxhYmVsO1xyXG4gICAgICB9XHJcbiAgICB9KTtcclxuICB9XHJcblxyXG4gIC8vIExvYWQgaW5pdGlhbCBjb21wYXJpc29uIG9yIHJlc3RvcmUgc2F2ZWQgcGFpciwgYWZ0ZXIgdGhlIG9uZS10aW1lIEVMTyBzZXR1cCBpZiBpdCdzIHBlbmRpbmdcclxuICBpZiAoaXNFbG9TZXR1cFBlbmRpbmcoKSkge1xyXG4gICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn6etIEVMTyBzZXR1cCBub3QgZG9uZSB5ZXQsIHNob3dpbmcgc2V0dXBcIik7XHJcbiAgICBzaG93U2V0dXBTY3JlZW4obW9kYWwsICgpID0+IGFmdGVyU2V0dXAobW9kYWwpKTtcclxuICB9IGVsc2UgaWYgKGZvcmNlU2NlbmVCYXR0bGUpIHtcclxuICAgIGNvbnNvbGUubG9nKGBbU3Rhc2ggQmF0dGxlXSDwn46vIFN0YXJ0aW5nIGJhdHRsZSB3aXRoIHNjZW5lICR7c2NlbmVQYWdlSWR9IGZyb20gc2NlbmUgcGFnZWApO1xyXG4gICAgbG9hZE5ld1BhaXIoc2NlbmVQYWdlSWQpO1xyXG4gIH0gZWxzZSBpZiAoaGFzU3RhdGUgJiYgc3RhdGUuY3VycmVudFBhaXIubGVmdCAmJiBzdGF0ZS5jdXJyZW50UGFpci5yaWdodCAmJiAhZmlsdGVyc0NoYW5nZWQpIHtcclxuICAgIGNvbnNvbGUubG9nKFxyXG4gICAgICBgW1N0YXNoIEJhdHRsZV0g8J+TgiBSZXN0b3Jpbmcgc2F2ZWQgcGFpciBmcm9tIGxvY2FsU3RvcmFnZSAoU2NlbmUgJHtzdGF0ZS5jdXJyZW50UGFpci5sZWZ0LmlkfSB2cyBTY2VuZSAke3N0YXRlLmN1cnJlbnRQYWlyLnJpZ2h0LmlkfSlgLFxyXG4gICAgKTtcclxuICAgIHZvaWQgcmVzdG9yZUN1cnJlbnRQYWlyKCk7XHJcbiAgfSBlbHNlIHtcclxuICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+GlSBObyBzYXZlZCBwYWlyIG9yIGZpbHRlcnMgY2hhbmdlZCwgbG9hZGluZyBuZXcgcGFpci4uLlwiKTtcclxuICAgIGxvYWROZXdQYWlyKCk7XHJcbiAgfVxyXG5cclxuICAvLyBDbG9zZSBoYW5kbGVyc1xyXG4gIG1vZGFsLnF1ZXJ5U2VsZWN0b3IoXCIuc2ItbW9kYWwtYmFja2Ryb3BcIik/LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBjbG9zZU1vZGFsKTtcclxuICBtb2RhbC5xdWVyeVNlbGVjdG9yKFwiLnNiLW1vZGFsLWNsb3NlXCIpPy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgY2xvc2VNb2RhbCk7XHJcblxyXG4gIC8vIFJlbW92ZSBhbnkgZXhpc3Rpbmcga2V5Ym9hcmQgaGFuZGxlcnMgYmVmb3JlIGFkZGluZyBuZXcgb25lc1xyXG4gIGlmIChtb2RhbEtleUhhbmRsZXIpIHtcclxuICAgIGRvY3VtZW50LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJrZXlkb3duXCIsIG1vZGFsS2V5SGFuZGxlciwgdHJ1ZSk7XHJcbiAgfVxyXG5cclxuICAvLyBTaW5nbGUga2V5Ym9hcmQgaGFuZGxlciBmb3IgYWxsIG1vZGFsIHNob3J0Y3V0c1xyXG4gIG1vZGFsS2V5SGFuZGxlciA9IGZ1bmN0aW9uIChlOiBLZXlib2FyZEV2ZW50KSB7XHJcbiAgICBjb25zdCBhY3RpdmVNb2RhbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic2ItbW9kYWxcIik7XHJcbiAgICBpZiAoIWFjdGl2ZU1vZGFsKSB7XHJcbiAgICAgIGlmIChtb2RhbEtleUhhbmRsZXIpIGRvY3VtZW50LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJrZXlkb3duXCIsIG1vZGFsS2V5SGFuZGxlciwgdHJ1ZSk7XHJcbiAgICAgIG1vZGFsS2V5SGFuZGxlciA9IG51bGw7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuXHJcbiAgICAvLyBTdGFzaCdzIG93biBkZWxldGUgZGlhbG9nIChDbGVhbiBtb2RlKSBpcyBvbiB0b3A6IGxldCBpdCBoYXZlIHRoZSBrZXlzIChFc2NhcGUsIEVudGVyKVxyXG4gICAgaWYgKGlzRGVsZXRlRGlhbG9nT3BlbigpKSByZXR1cm47XHJcblxyXG4gICAgLy8gTm90aGluZyB0eXBlZCB3aGlsZSBCYXR0bGUgaXMgb3BlbiBtYXkgcmVhY2ggU3Rhc2gncyBvd24gaG90a2V5cyAocGFnZSBhcnJvd3MsIGxldHRlclxyXG4gICAgLy8gc2hvcnRjdXRzKSwgb3IgaXQgYWN0cyBvbiB0aGUgcGFnZSBiZWhpbmQgdGhlIG1vZGFsLiBEZWZhdWx0IGFjdGlvbnMgKHR5cGluZyBpbiBpbnB1dHMsXHJcbiAgICAvLyBzbGlkZXIgYXJyb3dzLCBjaGVja2JveCBTcGFjZSkgc3RpbGwgaGFwcGVuIHNpbmNlIG9ubHkgcHJvcGFnYXRpb24gaXMgc3RvcHBlZCBoZXJlLlxyXG4gICAgZS5zdG9wSW1tZWRpYXRlUHJvcGFnYXRpb24oKTtcclxuXHJcbiAgICAvLyBBIGNvbmZpcm1hdGlvbiBkaWFsb2cgaXMgb3BlbjogRXNjYXBlIGNhbmNlbHMgaXQsIG90aGVyIGtleXMgYXJlIGl0cyBvd24gKFRhYiwgRW50ZXIpXHJcbiAgICBpZiAoaXNDb25maXJtRGlhbG9nT3BlbigpKSB7XHJcbiAgICAgIGlmIChlLmtleSA9PT0gXCJFc2NhcGVcIikge1xyXG4gICAgICAgIGUucHJldmVudERlZmF1bHQoKTtcclxuICAgICAgICBjYW5jZWxDb25maXJtRGlhbG9nKCk7XHJcbiAgICAgIH1cclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG5cclxuICAgIC8vIEVzY2FwZSB0byBjbG9zZVxyXG4gICAgaWYgKGUua2V5ID09PSBcIkVzY2FwZVwiKSB7XHJcbiAgICAgIGUucHJldmVudERlZmF1bHQoKTtcclxuICAgICAgY2xvc2VNb2RhbCgpO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcblxyXG4gICAgLy8gQmF0dGxlIHNob3J0Y3V0cyBvbmx5IGFwcGx5IG9uIHRoZSBCYXR0bGUgdGFiLCBvbmNlIEVMTyBzZXR1cCBpcyBkb25lXHJcbiAgICBpZiAoZ2V0QWN0aXZlVGFiKCkgIT09IFwiYmF0dGxlXCIgfHwgaXNFbG9TZXR1cFBlbmRpbmcoKSkgcmV0dXJuO1xyXG5cclxuICAgIC8vIExldCB0aGUgdm9sdW1lIHNsaWRlciAvIG51bWJlciBpbnB1dCBrZWVwIHRoZWlyIG93biBhcnJvdyBrZXlzIChjaGVja2JveGVzIGRvbid0IG5lZWQgdGhlbSlcclxuICAgIGNvbnN0IGFjdGl2ZSA9IGRvY3VtZW50LmFjdGl2ZUVsZW1lbnQgYXMgSFRNTElucHV0RWxlbWVudCB8IG51bGw7XHJcbiAgICBjb25zdCB0YWcgPSBhY3RpdmU/LnRhZ05hbWU7XHJcbiAgICBjb25zdCBpc1RvZ2dsZSA9IHRhZyA9PT0gXCJJTlBVVFwiICYmIChhY3RpdmU/LnR5cGUgPT09IFwiY2hlY2tib3hcIiB8fCBhY3RpdmU/LnR5cGUgPT09IFwicmFkaW9cIik7XHJcbiAgICBpZiAoKHRhZyA9PT0gXCJJTlBVVFwiICYmICFpc1RvZ2dsZSkgfHwgdGFnID09PSBcIlRFWFRBUkVBXCIgfHwgdGFnID09PSBcIlNFTEVDVFwiKSByZXR1cm47XHJcblxyXG4gICAgLy8gQXJyb3cga2V5cyB0byBjaG9vc2VcclxuICAgIGlmIChlLmtleSA9PT0gXCJBcnJvd0xlZnRcIiAmJiBzdGF0ZS5jdXJyZW50UGFpci5sZWZ0KSB7XHJcbiAgICAgIGUucHJldmVudERlZmF1bHQoKTtcclxuICAgICAgLy8gVGhlIENob29zZSBidXR0b24sIGFzIGEgY2xpY2sgb24gaXQgd291bGRcclxuICAgICAgY29uc3QgbGVmdENob29zZSA9IGFjdGl2ZU1vZGFsLnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KCcuc2Itc2NlbmUtY2FyZFtkYXRhLXNpZGU9XCJsZWZ0XCJdIC5zYi1jaG9vc2UtYnRuJyk7XHJcbiAgICAgIGlmIChsZWZ0Q2hvb3NlKSBsZWZ0Q2hvb3NlLmNsaWNrKCk7XHJcbiAgICB9XHJcbiAgICBpZiAoZS5rZXkgPT09IFwiQXJyb3dSaWdodFwiICYmIHN0YXRlLmN1cnJlbnRQYWlyLnJpZ2h0KSB7XHJcbiAgICAgIGUucHJldmVudERlZmF1bHQoKTtcclxuICAgICAgY29uc3QgcmlnaHRDaG9vc2UgPSBhY3RpdmVNb2RhbC5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PignLnNiLXNjZW5lLWNhcmRbZGF0YS1zaWRlPVwicmlnaHRcIl0gLnNiLWNob29zZS1idG4nKTtcclxuICAgICAgaWYgKHJpZ2h0Q2hvb3NlKSByaWdodENob29zZS5jbGljaygpO1xyXG4gICAgfVxyXG5cclxuICAgIC8vIEJhY2tzcGFjZSB1bmRvZXMgdGhlIGxhc3QgcGlja1xyXG4gICAgaWYgKGUua2V5ID09PSBcIkJhY2tzcGFjZVwiKSB7XHJcbiAgICAgIGUucHJldmVudERlZmF1bHQoKTtcclxuICAgICAgdm9pZCB1bmRvTGFzdFBpY2soKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG5cclxuICAgIC8vIFNwYWNlYmFyIHRvIHNraXBcclxuICAgIGlmIChlLmtleSA9PT0gXCIgXCIgfHwgZS5jb2RlID09PSBcIlNwYWNlXCIpIHtcclxuICAgICAgLy8gTGV0IGEgZm9jdXNlZCBidXR0b24gb3IgY2hlY2tib3ggaGFuZGxlIGl0cyBvd24gU3BhY2VcclxuICAgICAgaWYgKHRhZyA9PT0gXCJCVVRUT05cIiB8fCBpc1RvZ2dsZSkgcmV0dXJuO1xyXG4gICAgICBlLnByZXZlbnREZWZhdWx0KCk7XHJcbiAgICAgIHNraXBQYWlyKCk7XHJcbiAgICB9XHJcbiAgfTtcclxuXHJcbiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcImtleWRvd25cIiwgbW9kYWxLZXlIYW5kbGVyLCB0cnVlKTtcclxufVxyXG5cclxuLyoqIEEgbW9kYWwgd2l0aCBqdXN0IGEgbWVzc2FnZSwgc2hvd24gaW5zdGVhZCBvZiBCYXR0bGUgKGUuZy4gdGhpcyBTdGFzaCBsYWNrcyBjdXN0b20gZmllbGRzKS4gKi9cclxuZnVuY3Rpb24gc2hvd01lc3NhZ2VNb2RhbChtZXNzYWdlOiBzdHJpbmcpOiB2b2lkIHtcclxuICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInNiLW1vZGFsXCIpPy5yZW1vdmUoKTtcclxuICBjb25zdCBtb2RhbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XHJcbiAgbW9kYWwuaWQgPSBcInNiLW1vZGFsXCI7XHJcbiAgbW9kYWwuaW5uZXJIVE1MID0gYFxyXG4gICAgICA8ZGl2IGNsYXNzPVwic2ItbW9kYWwtYmFja2Ryb3BcIj48L2Rpdj5cclxuICAgICAgPGRpdiBjbGFzcz1cInNiLW1vZGFsLWNvbnRlbnRcIj5cclxuICAgICAgICA8YnV0dG9uIGNsYXNzPVwic2ItbW9kYWwtY2xvc2VcIiBhcmlhLWxhYmVsPVwiQ2xvc2VcIj7inJU8L2J1dHRvbj5cclxuICAgICAgICA8ZGl2IGNsYXNzPVwic2ItZXJyb3Itc2NyZWVuXCI+XHJcbiAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItZXJyb3ItaWNvblwiPuKaoO+4jzwvZGl2PlxyXG4gICAgICAgICAgPHAgY2xhc3M9XCJzYi1lcnJvci1tZXNzYWdlXCI+JHttZXNzYWdlfTwvcD5cclxuICAgICAgICA8L2Rpdj5cclxuICAgICAgPC9kaXY+XHJcbiAgICBgO1xyXG4gIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQobW9kYWwpO1xyXG4gIGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LmFkZChCQVRUTEVfT1BFTl9DTEFTUyk7XHJcbiAgbW9kYWwucXVlcnlTZWxlY3RvcihcIi5zYi1tb2RhbC1iYWNrZHJvcFwiKT8uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIGNsb3NlTW9kYWwpO1xyXG4gIG1vZGFsLnF1ZXJ5U2VsZWN0b3IoXCIuc2ItbW9kYWwtY2xvc2VcIik/LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBjbG9zZU1vZGFsKTtcclxufVxyXG5cclxuLyoqIFRydWUgd2hpbGUgdGhlIGJhdHRsZSBtb2RhbCBpcyBvbiBzY3JlZW4gKGl0IHN0YXlzIGluIHRoZSBET00sIGhpZGRlbiwgYWZ0ZXIgY2xvc2luZykuICovXHJcbmZ1bmN0aW9uIGlzTW9kYWxWaXNpYmxlKCk6IGJvb2xlYW4ge1xyXG4gIGNvbnN0IG1vZGFsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzYi1tb2RhbFwiKTtcclxuICByZXR1cm4gbW9kYWwgIT09IG51bGwgJiYgIW1vZGFsLmNsYXNzTGlzdC5jb250YWlucyhcInNiLW1vZGFsLWhpZGRlblwiKTtcclxufVxyXG5cclxuLy8gU3Rhc2gncyBob3RrZXlzIChNb3VzZXRyYXApIGFsc28gbGlzdGVuIGZvciBrZXlwcmVzcy9rZXl1cCBvbiBkb2N1bWVudDsga2V5ZG93biBpcyBoYW5kbGVkXHJcbi8vIGJ5IG1vZGFsS2V5SGFuZGxlci4gUmVnaXN0ZXJlZCBvbmNlLCBpbiB0aGUgY2FwdHVyZSBwaGFzZSwgYW5kIGluZXJ0IHdoaWxlIHRoZSBtb2RhbCBpcyBoaWRkZW4uXHJcbmxldCBrZXlTd2FsbG93ZXJzQWRkZWQgPSBmYWxzZTtcclxuZnVuY3Rpb24gYWRkS2V5U3dhbGxvd2VycygpOiB2b2lkIHtcclxuICBpZiAoa2V5U3dhbGxvd2Vyc0FkZGVkKSByZXR1cm47XHJcbiAga2V5U3dhbGxvd2Vyc0FkZGVkID0gdHJ1ZTtcclxuICBjb25zdCBzd2FsbG93ID0gKGU6IEtleWJvYXJkRXZlbnQpOiB2b2lkID0+IHtcclxuICAgIGlmIChpc01vZGFsVmlzaWJsZSgpICYmICFpc0RlbGV0ZURpYWxvZ09wZW4oKSkgZS5zdG9wSW1tZWRpYXRlUHJvcGFnYXRpb24oKTtcclxuICB9O1xyXG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJrZXlwcmVzc1wiLCBzd2FsbG93LCB0cnVlKTtcclxuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwia2V5dXBcIiwgc3dhbGxvdywgdHJ1ZSk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBjbG9zZU1vZGFsKCk6IHZvaWQge1xyXG4gIGNvbnN0IG1vZGFsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzYi1tb2RhbFwiKTtcclxuICBpZiAoIW1vZGFsIHx8IG1vZGFsLmNsYXNzTGlzdC5jb250YWlucyhcInNiLW1vZGFsLWhpZGRlblwiKSkgcmV0dXJuO1xyXG5cclxuICBjYW5jZWxEZWxldGVEaWFsb2coKTtcclxuICBjYW5jZWxDb25maXJtRGlhbG9nKCk7XHJcbiAgLy8gXCJCYXR0bGUgdGhlIGxlYXN0LXRlc3RlZFwiIGFuZCBhIGJhdHRsZWQgRXhwbG9yZSBmaWx0ZXIgc3RheSBvbiAodW50aWwgU3RvcCk6IGNsb3NpbmcgU3Rhc2hcclxuICAvLyBCYXR0bGUgdG8gd2F0Y2ggYSBzY2VuZSBhbmQgY29taW5nIGJhY2sgY2FycmllcyBvbiB3aGVyZSBpdCB3YXNcclxuICBzdG9wTWluaVByZXZpZXcoKTtcclxuICAvLyBTdGFzaCdzIHNjZW5lIGxpc3RzIHNob3cgdGhlIHJhdGluZ3Mgd3JpdHRlbiB3aGlsZSBTdGFzaCBCYXR0bGUgd2FzIG9wZW4sIGFuZCBhIHNjZW5lIHBhZ2UgaXRzIEVMT1xyXG4gIGhvbGRTdGFzaExpc3RSZWZyZXNoKGZhbHNlKTtcclxuICByZWZyZXNoU2NlbmVFbG8oKTtcclxuICAvLyBDbG9zaW5nIFN0YXNoIEJhdHRsZSBvbiBSZXNldCBFTE8ncyBjaG9pY2VzIChiZWZvcmUgU3RhcnQpIGNhbmNlbHMgdGhlIHJlc2V0XHJcbiAgaWYgKHN0YXRlLnJlc2V0dGluZ0VsbyAmJiAhaXNTZXR1cFJ1bm5pbmcoKSkge1xyXG4gICAgc3RhdGUucmVzZXR0aW5nRWxvID0gZmFsc2U7XHJcbiAgICBoaWRlU2V0dXBTY3JlZW4obW9kYWwpO1xyXG4gIH1cclxuXHJcbiAgLy8gU3RvcCBwcmV2aWV3cyAoYXV0b3BsYXkga2VlcHMgdGhlbSBydW5uaW5nIG90aGVyd2lzZSlcclxuICBtb2RhbC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxWaWRlb0VsZW1lbnQ+KFwiLnNiLWhvdmVyLXByZXZpZXdcIikuZm9yRWFjaCgodikgPT4gdi5wYXVzZSgpKTtcclxuXHJcbiAgLy8gQWRkIGNsb3NpbmcgY2xhc3MgdG8gdHJpZ2dlciBmYWRlLW91dCBhbmltYXRpb25cclxuICBtb2RhbC5jbGFzc0xpc3QuYWRkKFwic2ItbW9kYWwtY2xvc2luZ1wiKTtcclxuXHJcbiAgLy8gQWZ0ZXIgYW5pbWF0aW9uIGNvbXBsZXRlcywgaGlkZSB0aGUgbW9kYWwgKGtlZXAgaW4gRE9NIGZvciByZXVzZSlcclxuICBzZXRUaW1lb3V0KCgpID0+IHtcclxuICAgIG1vZGFsLmNsYXNzTGlzdC5hZGQoXCJzYi1tb2RhbC1oaWRkZW5cIik7XHJcbiAgICBkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5yZW1vdmUoQkFUVExFX09QRU5fQ0xBU1MpO1xyXG4gICAgbW9kYWwuY2xhc3NMaXN0LnJlbW92ZShcInNiLW1vZGFsLWNsb3NpbmdcIik7XHJcbiAgfSwgMjAwKTsgLy8gTWF0Y2ggQ1NTIGFuaW1hdGlvbiBkdXJhdGlvblxyXG5cclxuICAvLyBDbGVhbiB1cCBrZXlib2FyZCBoYW5kbGVyXHJcbiAgaWYgKG1vZGFsS2V5SGFuZGxlcikge1xyXG4gICAgZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImtleWRvd25cIiwgbW9kYWxLZXlIYW5kbGVyLCB0cnVlKTtcclxuICB9XHJcbn1cclxuXHJcbiIsICIvLyBUaGUgbmF2YmFyIFwiQmF0dGxlXCIgYnV0dG9uIHRoYXQgb3BlbnMgdGhlIGNvbXBhcmlzb24gbW9kYWwsIG9uIGV2ZXJ5IHBhZ2Ugb2YgU3Rhc2guXG4vL1xuLy8gV2hlcmUgU3Rhc2ggaGFzIHRoZSBwbHVnaW4gcGF0Y2ggQVBJLCB0aGUgYnV0dG9uIGlzIHBhdGNoZWQgaW50byBNYWluTmF2QmFyLk1lbnVJdGVtcyAoYWZ0ZXJcbi8vIFN0YXNoJ3Mgb3duIHBhZ2UgbGlua3MpLCBzbyBSZWFjdCByZW5kZXJzIGl0IHdpdGggdGhlIHJlc3Qgb2YgdGhlIG5hdmJhci4gT3RoZXJ3aXNlIGl0J3MgYWRkZWRcbi8vIHRvIHRoZSBET00gZGlyZWN0bHkgYW5kIHJlLWFkZGVkIHdoZW5ldmVyIHRoZSBwYWdlIGNoYW5nZXMuXG4vL1xuLy8gV2hpbGUgU3Rhc2ggZm9sZHMgaXRzIGxpbmtzIGludG8gdGhlIOKYsCBtZW51IChiZWxvdyAxMjAwcHg6IHBob25lcyBhbmQgdGFibGV0cyksIGEgc3dvcmRzIGljb25cbi8vIGFsc28gc2l0cyBpbiB0aGUgdG9wIGJhcidzIGJ1dHRvbnMsIG5leHQgdG8gU0ZXIFN3aXRjaCBhbmQgVENvZGUsIHNvIFN0YXNoIEJhdHRsZSBpcyBvbmUgdGFwXG4vLyBhd2F5LiAoU3Rhc2gncyBvd24gTWFpbk5hdkJhci5VdGlsaXR5SXRlbXMgc2xvdCBpcyBoaWRkZW4gdGhlcmUsIHNvIGl0J3MgYWRkZWQgdG8gdGhlIERPTSwgYXNcbi8vIHRob3NlIHBsdWdpbnMgZG8uKVxuXG5pbXBvcnQgdHlwZSB7IFBsdWdpbkFwaUxpa2UsIFJlYWN0Tm9kZSB9IGZyb20gXCIuLi9wbHVnaW5BcGlcIjtcbmltcG9ydCB7IFNXT1JEU19QQVRIUyB9IGZyb20gXCIuL2ljb25zXCI7XG5pbXBvcnQgeyBvcGVuTW9kYWwgfSBmcm9tIFwiLi9tb2RhbFwiO1xuXG5jb25zdCBCVVRUT05fSUQgPSBcInBsdWdpbl9zYlwiO1xuY29uc3QgSUNPTl9JRCA9IFwicGx1Z2luX3NiX2ljb25cIjtcbmNvbnN0IE5BVl9JVEVNX0NMQVNTID0gXCJjb2wtNCBjb2wtc20tMyBjb2wtbWQtMiBjb2wtbGctYXV0byBuYXYtbGlua1wiO1xuY29uc3QgTElOS19DTEFTUyA9XG4gIFwibWluaW1hbCBwLTQgcC14bC0yIGQtZmxleCBkLXhsLWlubGluZS1ibG9jayBmbGV4LWNvbHVtbiBqdXN0aWZ5LWNvbnRlbnQtYmV0d2VlbiBhbGlnbi1pdGVtcy1jZW50ZXIgYnRuIGJ0bi1wcmltYXJ5XCI7XG4vLyBObyB3aGl0ZXNwYWNlIGJldHdlZW4gdGhlIGljb24gYW5kIHRoZSBsYWJlbDogb24gd2lkZSBzY3JlZW5zIHRoZSBpY29uIGlzIGlubGluZSwgYW5kIGEgc3BhY2Vcbi8vIHdvdWxkIHNpdCBiZXR3ZWVuIHRoZW0gdGhhdCBTdGFzaCdzIG93biBsaW5rcyBkb24ndCBoYXZlXG5jb25zdCBMSU5LX0hUTUwgPVxuICBgPHN2ZyBhcmlhLWhpZGRlbj1cInRydWVcIiBmb2N1c2FibGU9XCJmYWxzZVwiIGNsYXNzPVwic3ZnLWlubGluZS0tZmEgZmEtaWNvbiBuYXYtbWVudS1pY29uIGQtYmxvY2sgZC14bC1pbmxpbmUgbWItMiBtYi14bC0wXCIgcm9sZT1cImltZ1wiIHhtbG5zPVwiaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmdcIiB2aWV3Qm94PVwiMCAwIDM2IDM2XCI+JHtTV09SRFNfUEFUSFN9PC9zdmc+YCArXG4gIGA8c3Bhbj5CYXR0bGU8L3NwYW4+YDtcblxuZnVuY3Rpb24gb25CdXR0b25DbGljayhlOiB7IHByZXZlbnREZWZhdWx0KCk6IHZvaWQgfSk6IHZvaWQge1xuICBlLnByZXZlbnREZWZhdWx0KCk7XG4gIHZvaWQgb3Blbk1vZGFsKCk7XG59XG5cbi8qKlxuICogVGhlIHRvcC1iYXIgaWNvbiAoc2VlIHRoZSB0b3Agb2YgdGhpcyBmaWxlKTogYWRkZWQgdG8gdGhlIG5hdmJhcidzIGJ1dHRvbnMgYWZ0ZXIgVENvZGUncyBvciBTRldcbiAqIFN3aXRjaCdzIHdoZW4gdGhleSdyZSB0aGVyZS4gU2FmZSB0byBjYWxsIG9mdGVuLlxuICovXG5mdW5jdGlvbiBwbGFjZU5hdkljb24oKTogdm9pZCB7XG4gIGNvbnN0IGV4aXN0aW5nID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoSUNPTl9JRCk7XG4gIGNvbnN0IGJ1dHRvbnMgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKFwiLm5hdmJhci1idXR0b25zXCIpO1xuICBpZiAoIWJ1dHRvbnMpIHJldHVybjtcbiAgaWYgKGV4aXN0aW5nICYmIGJ1dHRvbnMuY29udGFpbnMoZXhpc3RpbmcpKSB7XG4gICAgZml0TmF2SWNvbihleGlzdGluZyk7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IGl0ZW0gPSBleGlzdGluZyA/PyBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYVwiKTtcbiAgaXRlbS5pZCA9IElDT05fSUQ7XG4gIGl0ZW0uY2xhc3NOYW1lID0gXCJtci0yIHNiLW5hdi1pY29uXCI7XG4gIGl0ZW0uaW5uZXJIVE1MID0gYFxuICAgICAgICA8YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cIm1pbmltYWwgZC1mbGV4IGFsaWduLWl0ZW1zLWNlbnRlciBoLTEwMCBidG4gYnRuLXByaW1hcnlcIiB0aXRsZT1cIlN0YXNoIEJhdHRsZVwiIGFyaWEtbGFiZWw9XCJTdGFzaCBCYXR0bGVcIj5cbiAgICAgICAgICA8c3ZnIGFyaWEtaGlkZGVuPVwidHJ1ZVwiIGZvY3VzYWJsZT1cImZhbHNlXCIgY2xhc3M9XCJzdmctaW5saW5lLS1mYSBmYS1pY29uXCIgdmlld0JveD1cIjAgMCAzNiAzNlwiPiR7U1dPUkRTX1BBVEhTfTwvc3ZnPlxuICAgICAgICA8L2J1dHRvbj5gO1xuICBpdGVtLnF1ZXJ5U2VsZWN0b3IoXCJidXR0b25cIik/LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBvbkJ1dHRvbkNsaWNrKTtcbiAgY29uc3QgYWZ0ZXIgPSBidXR0b25zLnF1ZXJ5U2VsZWN0b3IoXCIjdGNvZGUtbmF2LWJ0blwiKSA/PyBidXR0b25zLnF1ZXJ5U2VsZWN0b3IoXCIjcGx1Z2luX3Nmd1wiKT8uY2xvc2VzdChcIi5uYXZiYXItYnV0dG9ucyA+ICpcIik7XG4gIGlmIChhZnRlcikgYWZ0ZXIuYWZ0ZXIoaXRlbSk7XG4gIGVsc2UgYnV0dG9ucy5wcmVwZW5kKGl0ZW0pO1xuICBmaXROYXZJY29uKGl0ZW0sIHRydWUpO1xufVxuXG4vKipcbiAqIEhpZGUgdGhlIGljb24gd2hlbiBpdCB3b3VsZCB3cmFwIFN0YXNoJ3MgYmFyIG9udG8gYSBzZWNvbmQgcm93IChuYXJyb3cgcGhvbmVzLCBvciB3aWRlIGJ1dHRvbnNcbiAqIGZyb20gb3RoZXIgcGx1Z2lucyk7IEJhdHRsZSBpcyBzdGlsbCBpbiB0aGUg4piwIG1lbnUgdGhlbi4gQ2hlY2tlZCBhZ2FpbiB3aGVuZXZlciB0aGUgYmFyIGNoYW5nZXNcbiAqIG9yIHRoZSB3aW5kb3cgcmVzaXplcy5cbiAqL1xuZnVuY3Rpb24gZml0TmF2SWNvbihpdGVtOiBIVE1MRWxlbWVudCwgZm9yY2UgPSBmYWxzZSk6IHZvaWQge1xuICAvLyBNZWFzdXJpbmcgZm9yY2VzIGEgbGF5b3V0LCBzbyBvbmx5IHdoZW4gdGhlIHdpZHRoIG9yIHRoZSBiYXIncyBidXR0b25zIGNoYW5nZWRcbiAgY29uc3Qga2V5ID0gYCR7d2luZG93LmlubmVyV2lkdGh9OiR7aXRlbS5wYXJlbnRFbGVtZW50Py5jaGlsZEVsZW1lbnRDb3VudCA/PyAwfWA7XG4gIGlmICghZm9yY2UgJiYga2V5ID09PSBmaXR0ZWRGb3IpIHJldHVybjtcbiAgaXRlbS5zdHlsZS5yZW1vdmVQcm9wZXJ0eShcImRpc3BsYXlcIik7XG4gIGlmIChnZXRDb21wdXRlZFN0eWxlKGl0ZW0pLmRpc3BsYXkgPT09IFwibm9uZVwiKSB7XG4gICAgZml0dGVkRm9yID0ga2V5OyAvLyBhIHdpZGUgc2NyZWVuOiB0aGUgbWVudSBsaW5rIHNob3dzXG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IGJyYW5kID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihcIi5uYXZiYXItYnJhbmRcIik/LmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpO1xuICAvLyBOb3QgbGFpZCBvdXQgKGEgYmFja2dyb3VuZCB0YWIpOiBtZWFzdXJlIG9uY2UgaXQncyBzaG93blxuICBpZiAoIWJyYW5kIHx8IGJyYW5kLmhlaWdodCA9PT0gMCkgcmV0dXJuO1xuICBmaXR0ZWRGb3IgPSBrZXk7XG4gIGlmIChpdGVtLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpLnRvcCA+PSBicmFuZC5ib3R0b20gLSAxKSBpdGVtLnN0eWxlLmRpc3BsYXkgPSBcIm5vbmVcIjtcbn1cblxuLyoqIFdoYXQgZml0TmF2SWNvbiBsYXN0IG1lYXN1cmVkIGZvciAod2lkdGggOiBudW1iZXIgb2YgYnV0dG9ucyBpbiB0aGUgYmFyKS4gKi9cbmxldCBmaXR0ZWRGb3IgPSBcIlwiO1xuXG4vKiogS2VlcCB0aGUgdG9wLWJhciBpY29uIGluIHBsYWNlIGFzIFN0YXNoIG5hdmlnYXRlcyBhbmQgcmVkcmF3cyB0aGUgbmF2YmFyLiAqL1xuZnVuY3Rpb24gcmVnaXN0ZXJOYXZJY29uKCk6IHZvaWQge1xuICBsZXQgcXVldWVkID0gZmFsc2U7XG4gIC8vIEJhdGNoZWQgd2l0aCBhIHRpbWVyLCBub3QgYW4gYW5pbWF0aW9uIGZyYW1lOiBmcmFtZXMgZG9uJ3QgcnVuIGluIGEgYmFja2dyb3VuZCB0YWJcbiAgbmV3IE11dGF0aW9uT2JzZXJ2ZXIoKCkgPT4ge1xuICAgIGlmIChxdWV1ZWQpIHJldHVybjtcbiAgICBxdWV1ZWQgPSB0cnVlO1xuICAgIHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgcXVldWVkID0gZmFsc2U7XG4gICAgICBwbGFjZU5hdkljb24oKTtcbiAgICB9LCA1MCk7XG4gIH0pLm9ic2VydmUoZG9jdW1lbnQuYm9keSwgeyBjaGlsZExpc3Q6IHRydWUsIHN1YnRyZWU6IHRydWUgfSk7XG4gIGxldCByZXNpemVUaW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCBudWxsID0gbnVsbDtcbiAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoXCJyZXNpemVcIiwgKCkgPT4ge1xuICAgIGlmIChyZXNpemVUaW1lcikgY2xlYXJUaW1lb3V0KHJlc2l6ZVRpbWVyKTtcbiAgICByZXNpemVUaW1lciA9IHNldFRpbWVvdXQocGxhY2VOYXZJY29uLCAxMDApO1xuICB9KTtcbiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcInZpc2liaWxpdHljaGFuZ2VcIiwgKCkgPT4ge1xuICAgIGNvbnN0IGljb24gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChJQ09OX0lEKTtcbiAgICBpZiAoaWNvbiAmJiAhZG9jdW1lbnQuaGlkZGVuKSBmaXROYXZJY29uKGljb24sIHRydWUpO1xuICB9KTtcbiAgcGxhY2VOYXZJY29uKCk7XG59XG5cbi8qKiBBZGQgdGhlIEJhdHRsZSBuYXYgaXRlbSB0byBTdGFzaCdzIG5hdmJhciAoZXZlcnkgcGFnZSkuIENhbGwgb25jZSBhdCBzdGFydHVwLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdGVyTmF2QnV0dG9uKCk6IHZvaWQge1xuICByZWdpc3Rlck5hdkljb24oKTtcbiAgY29uc3QgYXBpID0gd2luZG93LlBsdWdpbkFwaTtcbiAgaWYgKGFwaT8uY29tcG9uZW50cz8uW1wiTWFpbk5hdkJhci5NZW51SXRlbXNcIl0gJiYgdHlwZW9mIGFwaS5wYXRjaD8uYmVmb3JlID09PSBcImZ1bmN0aW9uXCIpIHtcbiAgICBwYXRjaE5hdkJ1dHRvbihhcGkpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGluamVjdE5hdkJ1dHRvbigpO1xuXG4gIC8vIFJlLWluamVjdCBuYXYgYnV0dG9uIGFmdGVyIFN0YXNoIFNQQSBuYXZpZ2F0aW9uIHJlYnVpbGRzIHRoZSBuYXZiYXJcbiAgY29uc3Qgb2JzZXJ2ZXIgPSBuZXcgTXV0YXRpb25PYnNlcnZlcigoKSA9PiB7XG4gICAgaW5qZWN0TmF2QnV0dG9uKCk7XG4gIH0pO1xuXG4gIG9ic2VydmVyLm9ic2VydmUoZG9jdW1lbnQuYm9keSwge1xuICAgIGNoaWxkTGlzdDogdHJ1ZSxcbiAgICBzdWJ0cmVlOiB0cnVlLFxuICB9KTtcbn1cblxuZnVuY3Rpb24gcGF0Y2hOYXZCdXR0b24oYXBpOiBQbHVnaW5BcGlMaWtlKTogdm9pZCB7XG4gIGNvbnN0IHsgUmVhY3QgfSA9IGFwaTtcblxuICBmdW5jdGlvbiBCYXR0bGVOYXZJdGVtKCk6IFJlYWN0Tm9kZSB7XG4gICAgcmV0dXJuIFJlYWN0LmNyZWF0ZUVsZW1lbnQoXG4gICAgICBcImRpdlwiLFxuICAgICAgeyBpZDogQlVUVE9OX0lELCBjbGFzc05hbWU6IE5BVl9JVEVNX0NMQVNTIH0sXG4gICAgICBSZWFjdC5jcmVhdGVFbGVtZW50KFwiYVwiLCB7XG4gICAgICAgIGhyZWY6IFwiI1wiLFxuICAgICAgICBjbGFzc05hbWU6IExJTktfQ0xBU1MsXG4gICAgICAgIG9uQ2xpY2s6IG9uQnV0dG9uQ2xpY2ssXG4gICAgICAgIGRhbmdlcm91c2x5U2V0SW5uZXJIVE1MOiB7IF9faHRtbDogTElOS19IVE1MIH0sXG4gICAgICB9KSxcbiAgICApO1xuICB9XG5cbiAgLy8gQXBwZW5kIHRvIHRoZSBjaGlsZHJlbiBNZW51SXRlbXMgcmVuZGVycyBpbiBpdHMgTmF2LiBFdmVyeSBvdGhlciBhcmcgaXMgcGFzc2VkIHRocm91Z2ggYXMgaXM6XG4gIC8vIGFuIGBhZnRlcmAgcGF0Y2ggZmluZHMgdGhlIHJlbmRlcmVkIHJlc3VsdCBieSBwb3NpdGlvbiwgc28gdGhlIGFyZyBjb3VudCBtdXN0IG5vdCBjaGFuZ2UuXG4gIGFwaS5wYXRjaC5iZWZvcmUoXCJNYWluTmF2QmFyLk1lbnVJdGVtc1wiLCAocHJvcHMsIC4uLnJlc3QpID0+IFtcbiAgICB7XG4gICAgICAuLi4ocHJvcHMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pLFxuICAgICAgY2hpbGRyZW46IFsocHJvcHMgYXMgeyBjaGlsZHJlbj86IFJlYWN0Tm9kZSB9KS5jaGlsZHJlbiwgUmVhY3QuY3JlYXRlRWxlbWVudChCYXR0bGVOYXZJdGVtLCB7IGtleTogQlVUVE9OX0lEIH0pXSxcbiAgICB9LFxuICAgIC4uLnJlc3QsXG4gIF0pO1xufVxuXG4vKiogSW5qZWN0IHRoZSBCYXR0bGUgbmF2IGl0ZW0gaWYgdGhlIG5hdmJhciB3YXMgcmVidWlsdCB3aXRob3V0IGl0LiBTYWZlIHRvIGNhbGwgcmVwZWF0ZWRseS4gKi9cbmZ1bmN0aW9uIGluamVjdE5hdkJ1dHRvbigpOiB2b2lkIHtcbiAgaWYgKGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKEJVVFRPTl9JRCkpIHJldHVybjtcblxuICBjb25zdCBuYXZJdGVtID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbmF2SXRlbS5jbGFzc05hbWUgPSBOQVZfSVRFTV9DTEFTUztcbiAgbmF2SXRlbS5pZCA9IEJVVFRPTl9JRDtcblxuICBjb25zdCBsaW5rID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImFcIik7XG4gIGxpbmsuaHJlZiA9IFwiI1wiO1xuICBsaW5rLmNsYXNzTmFtZSA9IExJTktfQ0xBU1M7XG4gIGxpbmsuaW5uZXJIVE1MID0gTElOS19IVE1MO1xuICBsaW5rLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBvbkJ1dHRvbkNsaWNrKTtcbiAgbmF2SXRlbS5hcHBlbmRDaGlsZChsaW5rKTtcblxuICBjb25zdCBuYXZUYXJnZXQgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKFwiLm5hdmJhci1uYXZcIik7XG4gIGlmIChuYXZUYXJnZXQpIHtcbiAgICBuYXZUYXJnZXQuYXBwZW5kQ2hpbGQobmF2SXRlbSk7XG4gIH1cbn1cbiIsICIvLyBTdGFzaCBCYXR0bGUgLSBlbnRyeSBwb2ludC5cbi8vIEJ1bmRsZWQgYnkgZXNidWlsZCBpbnRvIHBsdWdpbnMvc3Rhc2gtYmF0dGxlL3N0YXNoLWJhdHRsZS5qcyAoSUlGRSkuXG5cbmltcG9ydCB7IHJlZ2lzdGVyRGVsZXRlRGlhbG9nQnJpZGdlIH0gZnJvbSBcIi4vdWkvZGVsZXRlRGlhbG9nXCI7XG5pbXBvcnQgeyBvcGVuTW9kYWwgfSBmcm9tIFwiLi91aS9tb2RhbFwiO1xuaW1wb3J0IHsgcmVnaXN0ZXJOYXZCdXR0b24gfSBmcm9tIFwiLi91aS9uYXZCdXR0b25cIjtcbmltcG9ydCB7IHJlZ2lzdGVyU2NlbmVFbG8gfSBmcm9tIFwiLi91aS9zY2VuZUVsb1wiO1xuXG5mdW5jdGlvbiBpbml0KCk6IHZvaWQge1xuICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIEluaXRpYWxpemVkXCIpO1xuXG4gIHJlZ2lzdGVyRGVsZXRlRGlhbG9nQnJpZGdlKCk7XG4gIHJlZ2lzdGVyTmF2QnV0dG9uKCk7XG4gIHJlZ2lzdGVyU2NlbmVFbG8oKCkgPT4gdm9pZCBvcGVuTW9kYWwoKSk7XG59XG5cbmlmIChkb2N1bWVudC5yZWFkeVN0YXRlID09PSBcImxvYWRpbmdcIikge1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwiRE9NQ29udGVudExvYWRlZFwiLCBpbml0KTtcbn0gZWxzZSB7XG4gIGluaXQoKTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICI7OztBQUVPLE1BQU0sY0FBYztBQUNwQixNQUFNLGdCQUFnQjtBQUV0QixNQUFNLG1CQUFtQjtBQUN6QixNQUFNLG1CQUFtQjtBQUN6QixNQUFNLG1CQUFtQixJQUFJLEtBQUs7QUFLbEMsTUFBTSxxQkFBd0MsQ0FBQyxJQUFJLElBQUksS0FBSyxLQUFLLENBQUM7QUFHbEUsTUFBTSxZQUFZO0FBRWxCLE1BQU0sbUJBQTZCO0FBQUEsSUFDeEMsY0FBYztBQUFBLElBQ2QsWUFBWTtBQUFBLElBQ1osY0FBYztBQUFBLElBQ2QsY0FBYztBQUFBLElBQ2QscUJBQXFCO0FBQUEsSUFDckIsYUFBYTtBQUFBLElBQ2IsZUFBZTtBQUFBLElBQ2YsaUJBQWlCO0FBQUEsSUFDakIsa0JBQWtCO0FBQUEsSUFDbEIsaUJBQWlCO0FBQUEsSUFDakIsV0FBVztBQUFBLElBQ1gsa0JBQWtCO0FBQUEsSUFDbEIsVUFBVTtBQUFBLEVBQ1o7QUFHTyxNQUFNLDhCQUE4QjtBQUNwQyxNQUFNLDJCQUEyQjtBQVFqQyxNQUFNLDRCQUE0QjtBQUVsQyxNQUFNLGdDQUFnQztBQUd0QyxNQUFNLDZCQUE2QjtBQU1uQyxNQUFNLHVCQUF1QjtBQU03QixNQUFNLG1CQUFtQjtBQUd6QixNQUFNLDJCQUEyQjtB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QVk7QUFDcEIsWUFBUSxLQUFLO0FBRWIsVUFBTSxPQUFPLFNBQVMsY0FBYyxHQUFHO0FBQ3ZDLFNBQUssT0FBTztBQUNaLFNBQUssWUFBWTtBQUNqQixTQUFLLFlBQVk7QUFDakIsU0FBSyxpQkFBaUIsU0FBUyxhQUFhO0FBQzVDLFlBQVEsWUFBWSxJQUFJO0FBRXhCLFVBQU0sWUFBWSxTQUFTLGNBQWMsYUFBYTtBQUN0RCxRQUFJLFdBQVc7QUFDYixnQkFBVSxZQUFZLE9BQU87QUFBQSxJQUMvQjtBQUFBLEVBQ0Y7OztBQ3JLQSxXQUFTLE9BQWE7QUFDcEIsWUFBUSxJQUFJLDRCQUE0QjtBQUV4QywrQkFBMkI7QUFDM0Isc0JBQWtCO0FBQ2xCLHFCQUFpQixNQUFNLEtBQUssVUFBVSxDQUFDO0FBQUEsRUFDekM7QUFFQSxNQUFJLFNBQVMsZUFBZSxXQUFXO0FBQ3JDLGFBQVMsaUJBQWlCLG9CQUFvQixJQUFJO0FBQUEsRUFDcEQsT0FBTztBQUNMLFNBQUs7QUFBQSxFQUNQOyIsCiAgIm5hbWVzIjogWyJrR2FtZXMiLCAiZWxvIiwgInJlc3VsdHMiLCAic2NlbmVzIiwgImN1cnJlbnQiLCAid2luZG93IiwgInNjZW5lcyIsICJzY2VuZXMiLCAic2NlbmVzIiwgImVudHJpZXMiLCAiZmlsdGVycyIsICJzY2VuZXMiLCAiZmlsdGVycyIsICJvcHRpb25zIiwgImN1cnJlbnQiLCAiZWxvIiwgImJhdHRsZXMiLCAicmVzdWx0cyIsICJjdXJyZW50IiwgInNjZW5lcyIsICJzY2VuZXMiLCAiZmlsdGVycyIsICJzY2VuZXMiLCAic2NlbmVVcmwiLCAic2NlbmVzIiwgImJhdHRsZXMiLCAib3B0aW9ucyIsICJjdXJyZW50IiwgIm9wdGlvbnMiLCAic2NlbmVzIiwgInNjZW5lcyIsICJlbnRyaWVzQnlJZCIsICJhY3Rpb25zIiwgIm1heCIsICJvbkNvbnRlbnRDbGljayIsICJiaW5kRXZlbnRzIiwgInN0YXRzQWN0aW9ucyIsICJNT0RFUyIsICJzY2VuZXMiLCAiZmlsdGVycyIsICJzY2VuZXMiLCAic2NlbmUiLCAib25DbGljayIsICJzY2VuZXMiLCAib3B0aW9ucyIsICJydW5uaW5nIiwgImN1cnJlbnQiLCAicGx1cmFsIiwgInNjZW5lcyIsICJlc2NhcGVIdG1sIiwgImVsb0xpbmUiLCAiYWZ0ZXJTZXR1cCIsICJmaWx0ZXJzIiwgIm1vZGFsQ29udGVudCJdCn0K
