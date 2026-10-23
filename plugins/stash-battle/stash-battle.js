"use strict";
(() => {
  // src/constants.ts
  var STORAGE_KEY = "stash-battle-state";
  var CACHE_DB_NAME = "stash-battle-cache";
  var CACHE_DB_VERSION = 2;
  var CACHE_STORE_NAME = "scenes";
  var CACHE_MAX_AGE_MS = 5 * 60 * 1e3;
  var PLUGIN_ID = "stash-battle";
  var DEFAULT_SETTINGS = {
    stashRatings: "off",
    eloSetupAt: null,
    eloSetupMode: null,
    openInNewTab: false,
    placementFromBottom: false,
    showTiers: true,
    previewVolume: 50,
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
  var ELO_FIELD_KEYS = [ELO_FIELD, BATTLES_FIELD, SEEDED_FIELD];
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
  function eloCustomFields(value) {
    return { [ELO_FIELD]: value.elo, [BATTLES_FIELD]: value.battles, [SEEDED_FIELD]: value.seeded };
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
  function percentileRatings(scenes) {
    const rated = scenes.map((scene) => ({ id: scene.id, elo: elo(scene) })).filter((s) => s.elo !== null).sort((a, b) => b.elo - a.elo);
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
  function stashRatingTargets(scenes, mode) {
    if (mode === "percentile") return percentileRatings(scenes);
    const targets = /* @__PURE__ */ new Map();
    if (mode === "linear") {
      for (const scene of scenes) {
        const value = elo(scene);
        if (value !== null) targets.set(scene.id, linearRating(value));
      }
    }
    return targets;
  }
  function stashRatingChanges(scenes, mode) {
    const current = new Map(scenes.map((scene) => [scene.id, scene.rating100 ?? null]));
    const changes = /* @__PURE__ */ new Map();
    for (const [id, rating] of stashRatingTargets(scenes, mode)) {
      if (current.get(id) !== rating) changes.set(id, rating);
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
    return value === null ? null : { elo: value, battles: battles(scene), seeded: isSeeded(scene) };
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
  function sortByElo(scenes) {
    return scenes.sort(compareByElo);
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
  function getSearchParams() {
    return new URLSearchParams(window.location.search);
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

  // src/state.ts
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
  async function setCachedScenes(cacheKey, scenes, count, filterKey, timestamp = Date.now()) {
    try {
      const db = await openCacheDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(CACHE_STORE_NAME, "readwrite");
        const store = transaction.objectStore(CACHE_STORE_NAME);
        const data = {
          cacheKey,
          scenes,
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
      const scenes = sortByElo(result.findScenes.scenes || []);
      const count = result.findScenes.count || scenes.length;
      const fetchTime = Date.now() - startTime;
      const oldCount = state.memoryCache.allScenes ? state.memoryCache.allScenes.length : 0;
      if (count !== oldCount) {
        console.log(
          `[Stash Battle] 📊 Scene count changed: ${oldCount} → ${count} (${count > oldCount ? "+" : ""}${count - oldCount})`
        );
      } else {
        console.log(`[Stash Battle] 📊 Scene count unchanged: ${count}`);
      }
      state.memoryCache.allScenes = scenes;
      state.memoryCache.timestamp = Date.now();
      await setCachedScenes(cacheKey, scenes, count);
      console.log(`[Stash Battle] ✅ Background refresh complete: ${scenes.length} scenes in ${fetchTime}ms`);
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
    const scenes = sortByElo(result.findScenes.scenes || []);
    const count = result.findScenes.count || scenes.length;
    const fetchTime = Date.now() - startTime;
    state.memoryCache.allScenes = scenes;
    state.memoryCache.timestamp = Date.now();
    await setCachedScenes(cacheKey, scenes, count);
    console.log(`[Stash Battle] ✅ Fetched and cached ${scenes.length} scenes in ${fetchTime}ms`);
    return { scenes, count };
  }
  async function backgroundRefreshFilteredScenes(filters) {
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
        scene_filter: filters.sceneFilter
      });
      const scenes = sortByElo(result.findScenes.scenes || []);
      const count = result.findScenes.count || scenes.length;
      const fetchTime = Date.now() - startTime;
      if (state.memoryCache.filterKey === filters.filterKey) {
        const oldCount = state.memoryCache.filteredScenes ? state.memoryCache.filteredScenes.length : 0;
        if (count !== oldCount) {
          console.log(
            `[Stash Battle] 📊 Filtered count changed: ${oldCount} → ${count} (${count > oldCount ? "+" : ""}${count - oldCount})`
          );
        } else {
          console.log(`[Stash Battle] 📊 Filtered count unchanged: ${count}`);
        }
        state.memoryCache.filteredScenes = scenes;
        state.memoryCache.timestamp = Date.now();
        await setCachedScenes(cacheKey, scenes, count, filters.filterKey);
        console.log(`[Stash Battle] ✅ Background refresh complete: ${scenes.length} filtered scenes in ${fetchTime}ms`);
      } else {
        console.log("[Stash Battle] ⚠️ Filter changed during refresh, discarding results");
      }
    } catch (e) {
      console.error("[Stash Battle] ❌ Background refresh (filtered) failed:", e);
    }
  }
  async function getFilteredScenesCached(filters) {
    const { filterKey, sceneFilter } = filters;
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
        backgroundRefreshFilteredScenes(filters);
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
        backgroundRefreshFilteredScenes(filters);
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
    const scenes = sortByElo(result.findScenes.scenes || []);
    const count = result.findScenes.count || scenes.length;
    const fetchTime = Date.now() - startTime;
    state.memoryCache.filteredScenes = scenes;
    state.memoryCache.filterKey = filterKey;
    state.memoryCache.timestamp = Date.now();
    await setCachedScenes(cacheKey, scenes, count, filterKey);
    console.log(`[Stash Battle] ✅ Fetched and cached ${scenes.length} filtered scenes in ${fetchTime}ms`);
    return { scenes, count };
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
    for (const [cacheKey, scenes] of lists) {
      if (!scenes) continue;
      const cached = await getCachedScenes(cacheKey);
      if (!cached) continue;
      if (cacheKey === "filtered-scenes" && cached.filterKey !== state.memoryCache.filterKey) continue;
      await setCachedScenes(cacheKey, scenes, scenes.length, cached.filterKey, cached.timestamp);
    }
  }
  async function removeSceneEverywhere(sceneId) {
    const without = (scenes) => scenes ? scenes.filter((s) => s.id !== sceneId) : scenes;
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
        const scenes = cached.scenes.filter((s) => s.id !== sceneId);
        await setCachedScenes(cacheKey, scenes, scenes.length, cached.filterKey, cached.timestamp);
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
    return a.elo === b.elo && a.battles === b.battles && a.seeded === b.seeded;
  }
  async function saveEloFields(scene, value, customFields, what) {
    const previous = eloFields(latestScene(scene));
    setEloInCache(scene, value);
    refreshStashCache([{ id: scene.id, elo: value }], false);
    try {
      await graphqlQuery(SCENE_UPDATE_MUTATION, { input: { id: scene.id, custom_fields: customFields } });
    } catch (e) {
      reportWriteError(scene.id, what, e);
      if (sameElo(eloFields(latestScene(scene)), value)) {
        setEloInCache(scene, previous);
        refreshStashCache([{ id: scene.id, elo: previous }], false);
      }
      return false;
    }
    scheduleStashRatingSync();
    return true;
  }
  async function writeElo(scene, elo2, battles2) {
    const value = { elo: elo2, battles: battles2, seeded: isSeeded(scene) };
    if (await saveEloFields(scene, value, { partial: eloCustomFields(value) }, "save ELO")) {
      console.log(`[Stash Battle] 📝 Saved scene ${scene.id} ELO ${elo2} (${battles2} battles)`);
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
      const scenes = state.memoryCache.allScenes;
      if (mode === "off" || !scenes) return 0;
      const changes = stashRatingChanges(scenes, mode);
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
  function setupRatingChanges(scenes, start, stashRatings) {
    return stashRatingChanges(
      scenes.map((scene) => afterSetup(scene, start)),
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
        return [`s${r}`, { ids: idsByRating.get(r), custom_fields: { partial } }];
      })
    );
    await graphqlQuery(mutation, variables);
  }
  async function runEloSetup(scenes, start, stashRatings, onProgress) {
    const summary = { eloWritten: 0, eloCleared: 0, ratingsWritten: 0 };
    if (start === "ratings") {
      const rated = scenes.filter((scene) => scene.rating100 != null);
      onProgress("elo", 0, rated.length);
      await seedFromRatings(rated);
      onProgress("elo", rated.length, rated.length);
      summary.eloWritten = rated.length;
      const stale = scenes.filter((scene) => scene.rating100 == null && isRated(scene)).map((scene) => scene.id);
      if (stale.length > 0) {
        await graphqlQuery(BULK_UPDATE_MUTATION, {
          input: { ids: stale, custom_fields: { remove: ELO_FIELD_KEYS } }
        });
        summary.eloCleared = stale.length;
      }
    } else {
      const ids = scenes.map((scene) => scene.id);
      onProgress("elo", 0, ids.length);
      if (ids.length > 0) {
        await graphqlQuery(BULK_UPDATE_MUTATION, {
          input: { ids, custom_fields: { partial: eloCustomFields({ elo: ELO_START, battles: 0, seeded: false }) } }
        });
      }
      onProgress("elo", ids.length, ids.length);
      summary.eloWritten = ids.length;
    }
    const changes = setupRatingChanges(scenes, start, stashRatings);
    if (changes.size > 0) {
      onProgress("ratings", 0, changes.size);
      await writeStashRatings(changes);
      onProgress("ratings", changes.size, changes.size);
      summary.ratingsWritten = changes.size;
    }
    refreshStashCache(
      scenes.map((scene) => ({ id: scene.id, elo: startingElo(scene, start), rating100: changes.get(scene.id) })),
      changes.size > 0
    );
    console.log(
      `[Stash Battle] ✅ ELO setup (${start}, Stash ratings ${stashRatings}): ${summary.eloWritten} ELO written, ${summary.eloCleared} cleared, ${summary.ratingsWritten} Stash ratings written`
    );
    return summary;
  }

  // src/settings.ts
  var CONFIG_QUERY = `{ configuration { plugins } }`;
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
      // A missing or unknown value is "off". (Removed keys, funMode and unratedRating, are dropped.)
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
      showTiers: bool("showTiers"),
      previewVolume: clampPercent(raw.previewVolume ?? base.previewVolume, base.previewVolume)
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
      const stored = await fetchStoredConfig();
      legacyFunMode = stored?.funMode === true;
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
  async function persistSettings() {
    const keys = [...unsaved];
    unsaved.clear();
    try {
      const stored = await fetchStoredConfig();
      const merged = stored ? { ...normalize(stored, state.settings) } : { ...state.settings };
      for (const key of keys) merged[key] = state.settings[key];
      const input = Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== null));
      await graphqlQuery(CONFIGURE_PLUGIN_MUTATION, { plugin_id: PLUGIN_ID, input });
      return true;
    } catch (e) {
      console.error("[Stash Battle] Failed to save settings:", e);
      for (const key of keys) unsaved.add(key);
      return false;
    }
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
      savedFilterParams: window.location.search
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
  }
  function landingElo(pool, slot) {
    let above = null;
    for (let i = slot - 1; i >= 0 && above === null; i--) above = elo(pool[i]);
    let below = null;
    for (let i = slot; i < pool.length && below === null; i++) below = elo(pool[i]);
    return placementElo(above, below);
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
    if (state.shuffleIndex >= state.shuffledFilteredScenes.length) {
      startNewPass(leftPool);
    }
    const shuffled = state.shuffledFilteredScenes[state.shuffleIndex];
    const scene = leftPool.find((s) => s.id === shuffled.id) ?? shuffled;
    state.shuffleIndex++;
    lastShownSceneId = scene.id;
    console.log(
      `[Stash Battle] 📍 Picked scene ${scene.id} (${state.shuffledFilteredScenes.length - state.shuffleIndex} left in this pass)`
    );
    return scene;
  }
  function buildOpponentPool(allScenes, leftPool, filters) {
    if (state.settings.filterOpponents && filters.filterActive) {
      return leftPool;
    }
    const rated = allScenes.filter(isRated);
    return rated.length >= 1 ? rated : allScenes;
  }
  async function loadScenePools(filters) {
    let leftPool;
    let allScenes;
    if (filters.filterActive) {
      const passComplete = isShuffleCycleComplete(filters.filterKey);
      if (passComplete) {
        console.log("[Stash Battle] 🔁 Pass complete, re-fetching filtered scenes");
        await clearFilteredCache();
      }
      console.log("[Stash Battle] 📋 Filter active, fetching filtered + all scenes");
      const [filteredResult, allResult] = await Promise.all([
        getFilteredScenesCached(filters),
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
    const filters = readFilters();
    const { leftPool, allScenes } = await loadScenePools(filters);
    let pool = buildOpponentPool(allScenes, leftPool, filters);
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
  async function buildSwissPools() {
    const filters = readFilters();
    const { leftPool, allScenes } = await loadScenePools(filters);
    if (allScenes.length < 2) {
      throw new Error("Not enough scenes for comparison.");
    }
    const rightPool = buildOpponentPool(allScenes, leftPool, filters);
    if (state.settings.filterOpponents && filters.filterActive && rightPool.length < 2) {
      throw new Error("Not enough scenes in your filter for a match. You need at least 2 scenes.");
    }
    return { leftPool, rightPool, filterKey: filters.filterKey };
  }
  async function fetchSwissPair(forcedLeftScene = null) {
    const { leftPool, rightPool, filterKey } = await buildSwissPools();
    const scene1 = forcedLeftScene || getNextFilteredScene(leftPool, filterKey);
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
  function findLowestRated(scenes, excludeId) {
    for (let i = scenes.length - 1; i >= 0; i--) {
      const s = scenes[i];
      if (s.id !== excludeId && isRated(s)) {
        return { scene: s, index: i };
      }
    }
    const fallbackIndex = scenes.findIndex((s) => s.id !== excludeId);
    return { scene: scenes[fallbackIndex], index: fallbackIndex };
  }
  async function fetchChampionPair(forcedLeftScene = null) {
    const filters = readFilters();
    console.log("[Stash Battle] 📋 Fetching scenes for champion...");
    const { leftPool, allScenes } = await loadScenePools(filters);
    const rightPool = buildOpponentPool(allScenes, leftPool, filters);
    state.totalScenesCount = rightPool.length;
    if (allScenes.length < 2) {
      throw new Error("Not enough scenes for comparison.");
    }
    if (!state.championScene) {
      state.championDefeated = [];
      const challenger = forcedLeftScene || getNextFilteredScene(leftPool, filters.filterKey);
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
    const filters = readFilters();
    const { leftPool, allScenes } = await loadScenePools(filters);
    if (allScenes.length < 2) {
      throw new Error("Not enough scenes for comparison.");
    }
    if (!state.placement) {
      const scene = forcedLeftScene || getNextFilteredScene(leftPool, filters.filterKey);
      if (!scene) {
        throw new Error("No scenes match your filter criteria.");
      }
      state.placement = newPlacementRun(scene, state.settings.placementFromBottom);
    }
    const run = state.placement;
    const pool = buildOpponentPool(allScenes, leftPool, filters).filter((s) => s.id !== run.scene.id);
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
      await writeElo(run.scene, newElo, newBattles);
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

  // src/stats.ts
  function tierMap(scenes) {
    const settled = scenes.filter((scene) => !isProvisional(scene)).map((scene) => ({ id: scene.id, elo: elo(scene) })).filter((s) => s.elo !== null).sort((a, b) => b.elo - a.elo);
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
  function tierDescription(tier) {
    const index = TIERS.findIndex((t) => t.id === tier.id);
    const percent = (share) => `${Math.round(share * 100)}%`;
    const where = index === TIERS.length - 1 && index > 0 ? `below the top ${percent(TIERS[index - 1].top)}` : `in the top ${percent(tier.top)}`;
    return `${tier.name}: ${where} of your scenes with a settled ELO`;
  }

  // src/ui/sceneTitle.ts
  function resolveSceneTitle(scene) {
    if (scene.title) return scene.title;
    const path = scene.files?.[0]?.path;
    if (path) {
      const pathParts = path.split(/[/\\]/);
      return pathParts[pathParts.length - 1].replace(/\.[^/.]+$/, "");
    }
    return "";
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
    const title = resolveSceneTitle(scene);
    const screenshotPath = scene.paths ? scene.paths.screenshot : null;
    const previewPath = scene.paths ? scene.paths.preview : null;
    const { openInNewTab, cleanMode } = state.settings;
    const stashRating = scene.rating100 ? `${scene.rating100}/100` : "None";
    const eloValue = elo(scene);
    const unratedAs = state.currentMode === "swiss" ? ELO_START : state.currentMode === "champion" ? CHAMPION_UNRATED_ELO : null;
    const provisional = isProvisional(scene);
    let eloLabel;
    if (eloValue !== null) {
      eloLabel = `ELO ${Math.round(eloValue)}${provisional ? "?" : ""}${rank !== null && rank !== void 0 ? ` · #${rank}` : ""}`;
    } else {
      eloLabel = unratedAs !== null ? `ELO ${unratedAs} · Unrated` : "Unrated";
    }
    const rankTitle = provisional ? ` title="${PROVISIONAL_TIP}"` : "";
    const rankDisplay = `${tier ? tierPill(tier) : ""}<span class="sb-scene-rank"${rankTitle}>${eloLabel}</span>`;
    let statusBadgeHtml = "";
    if (typeof statusBadge === "string") {
      statusBadgeHtml = `<div class="sb-streak-badge">${statusBadge}</div>`;
    } else if (statusBadge !== null && statusBadge > 0) {
      statusBadgeHtml = `<div class="sb-streak-badge">🔥 ${statusBadge} win${statusBadge > 1 ? "s" : ""}</div>`;
    }
    const currentParams = window.location.search;
    const sceneUrl = `/scenes/${scene.id}${currentParams}`;
    const linkTarget = openInNewTab ? ` target="_blank" rel="noopener"` : "";
    return `
      <div class="sb-scene-card" data-side="${side}">
        <div class="sb-scene-media">
          <a class="sb-scene-image-container pwr-scene-image-container" href="${sceneUrl}"${linkTarget}>
            ${screenshotPath ? `<img class="sb-scene-image pwr-scene-image" src="${screenshotPath}" alt="${title}" loading="lazy" />` : `<div class="sb-scene-image sb-no-image">No Screenshot</div>`}
            ${previewPath ? `<video class="sb-hover-preview pwr-hover-preview" src="${previewPath}" loop muted playsinline></video>` : ""}
          </a>
          <div class="sb-scene-duration">${formatDuration(duration)}</div>
          ${statusBadgeHtml}
          <div class="sb-click-hint">${openInNewTab ? "Click to open in new tab" : "Click to open scene"}</div>
          <a class="sb-open-link" href="${sceneUrl}" target="_blank" rel="noopener" title="Open scene in new tab">↗</a>
          ${cleanMode && isStashDeleteDialogAvailable() ? `<button type="button" class="sb-delete-btn" title="Delete this scene from Stash">🗑</button>` : ""}
        </div>

        <div class="sb-scene-body" data-winner="${scene.id}">
          <div class="sb-scene-info pwr-scene-info">
            <div class="sb-scene-title-row">
              <h3 class="sb-scene-title">${title}</h3>
              ${rankDisplay}
            </div>

            <div class="sb-scene-meta">
              <div class="sb-meta-item sb-meta-studio"><strong>Studio:</strong> ${studio}</div>
              <div class="sb-meta-item sb-meta-performers"><strong>Performers:</strong> ${performers}</div>
              <div class="sb-meta-item sb-meta-plays"><strong>Play Count:</strong> ${scene.play_count || 0}</div>
              <div class="sb-meta-item sb-meta-battles"><strong>Battles:</strong> ${battles(scene)}</div>
              <div class="sb-meta-item sb-meta-rating"><strong>Stash Rating:</strong> ${stashRating}</div>
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
        <button id="sb-new-run" class="btn btn-primary">${buttonLabel}</button>
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
    const scenes = state.memoryCache.allScenes;
    if (mode !== "off" && scenes) {
      const rating = stashRatingTargets(scenes, mode).get(scene.id);
      if (rating !== void 0) line += ` · Stash Rating: <strong>${rating}</strong>`;
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
      desc: "Rating = ELO converted back (1500 = 50, 10 ELO per point). Very high or low scenes stop at 100 or 1."
    },
    {
      value: "percentile",
      label: "Percentile",
      desc: "Rating = percentile in your library: 90 means the scene ranks above about 90% of your scenes. Top scene 100, bottom 1."
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
        { key: "autoplayPreviews", title: "Autoplay previews", hint: "Loop both previews silently; hover a card to hear it" },
        { key: "pauseMediaOnOpen", title: "Pause playing video when Stash Battle opens", hint: "Stops the scene you're watching so its audio doesn't overlap the battle previews" },
        { key: "showTiers", title: "Show tiers on cards", hint: "A tier next to each scene's ELO, from 👑 Legendary (top 1%) down to 🥉 Bronze, by its rank among your scenes with a settled ELO" },
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
  function createTabBar() {
    const { previewVolume } = state.settings;
    return `
      <div class="sb-tab-bar">
        <nav class="nav nav-tabs sb-tabs" role="tablist">
          <a class="nav-item nav-link active" role="tab" data-tab="battle" aria-selected="true">⚔️ Battle</a>
          <a class="nav-item nav-link" role="tab" data-tab="settings" aria-selected="false">⚙ Settings</a>
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
    return `
            <div class="setting">
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
        const current = state.settings.previewVolume;
        if (current > 0) {
          volumeBeforeMute = current;
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
                <button id="sb-skip-btn" class="btn btn-secondary">Skip</button>
                <button id="sb-refresh-cache-btn" class="btn btn-secondary" title="Refresh scene list from server (use if you've added new scenes)">🔄 Refresh</button>
              </div>
              <div class="sb-keyboard-hint">
                <span>←</span> choose left ·
                <span>→</span> choose right ·
                <span>Space</span> skip
              </div>
            </div>
          </div>
        </div>

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
  function updatePoolStatus() {
    const status = document.getElementById("sb-pool-status");
    if (!status) return;
    const count = state.leftPoolSize;
    const countHtml = count === null ? "" : ` · <strong>${count} scene${count === 1 ? "" : "s"}</strong>`;
    if (readFilters().filterActive) {
      const opponents = state.settings.filterOpponents ? " · opponents from the filter too" : "";
      status.innerHTML = `Rating scenes from your Scenes page filter${countHtml}${opponents}`;
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
      const active = card.matches(":hover") || card.classList.contains("sb-previewing");
      video.volume = sliderToVolume(previewVolume);
      video.muted = !active || previewVolume === 0;
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
    applyPreviewSettings();
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
  function pairTiers(scenes) {
    const library = state.memoryCache.allScenes;
    if (!state.settings.showTiers || !library) return scenes.map(() => null);
    const tiers = tierMap(library);
    return scenes.map((scene) => tiers.get(scene.id) ?? null);
  }
  function renderPair(scenes, ranks) {
    const comparisonArea = document.getElementById("sb-comparison-area");
    if (!comparisonArea) return;
    const statusBadges = scenes.map(climbStatusBadge);
    const tiers = pairTiers(scenes);
    comparisonArea.innerHTML = `
      <div class="sb-vs-container">
        ${createSceneCard(scenes[0], "left", ranks[0], statusBadges[0], tiers[0])}
        ${vsDivider(scenes[0], scenes[1])}
        ${createSceneCard(scenes[1], "right", ranks[1], statusBadges[1], tiers[1])}
      </div>
    `;
    const left = scenes[0];
    const right = scenes[1];
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
  async function loadNewPair(forcedLeftSceneId = null) {
    if (isEloSetupPending()) return;
    state.disableChoice = false;
    const comparisonArea = document.getElementById("sb-comparison-area");
    if (!comparisonArea) return;
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
        if (forcedLeftScene) refreshSceneInCache(forcedLeftScene);
        if (!forcedLeftScene) {
          console.warn("[Stash Battle] Could not fetch scene from URL, falling back to normal pairing");
        }
      }
      let scenes = [];
      let ranks = [null, null];
      if (state.currentMode === "placement") {
        const placementResult = await fetchPlacementPair(forcedLeftScene);
        if (placementResult.done) {
          if (placementResult.fromBottom && placementResult.rank === 1) {
            showVictoryScreen(placementResult.scene, placementResult.streak);
          } else {
            showPlacementScreen(placementResult);
          }
          return;
        }
        scenes = placementResult.scenes;
        ranks = placementResult.ranks;
      } else if (state.currentMode === "champion") {
        const championResult = await fetchChampionPair(forcedLeftScene);
        if (championResult.isVictory) {
          showVictoryScreen(championResult.scenes[0], state.championWins);
          return;
        }
        scenes = championResult.scenes;
        ranks = championResult.ranks;
      } else {
        const swissResult = await fetchSwissPair(forcedLeftScene);
        scenes = swissResult.scenes;
        ranks = swissResult.ranks;
      }
      if (scenes.length < 2) {
        comparisonArea.innerHTML = '<div class="sb-error">Not enough scenes available for comparison.</div>';
        return;
      }
      state.currentPair.left = scenes[0];
      state.currentPair.right = scenes[1];
      state.currentRanks.left = ranks[0];
      state.currentRanks.right = ranks[1];
      const loadTime = Date.now() - startTime;
      console.log(
        `[Stash Battle] ✅ Pair loaded in ${loadTime}ms: Scene ${scenes[0].id} (rank #${ranks[0]}) vs Scene ${scenes[1].id} (rank #${ranks[1]})`
      );
      renderPair(scenes, ranks);
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
    void writeElo(winner, result.winner, battles(latestWinner) + 1);
    void writeElo(loser, result.loser, battles(latestLoser) + 1);
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
    const filters = readFilters();
    const smallPool = state.totalScenesCount > 0 && state.totalScenesCount < CLIMB_SMALL_POOL_WARN_AT;
    warning.hidden = !(isClimb && state.settings.filterOpponents && filters.filterActive && smallPool);
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
    setTimeout(() => loadNewPair(), 600);
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
    setTimeout(() => loadNewPair(), 1500);
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
  var TITLE = "Stash Battle ELO, and rank in your library. Click to battle this scene.";
  function labelText(scene, rank) {
    const value = elo(scene);
    if (value === null) return "ELO · Unrated";
    return `ELO ${Math.round(value)}${isProvisional(scene) ? "?" : ""}${rank !== null ? ` · #${rank}` : ""}`;
  }
  function titleText(scene, tier) {
    const lines = [TITLE];
    if (isProvisional(scene)) lines.push(PROVISIONAL_TIP);
    if (tier && state.settings.showTiers) lines.push(`${tier.emoji} ${tierDescription(tier)}`);
    return lines.join("\n");
  }
  async function sceneAndRank(sceneId) {
    const { scenes } = await getAllScenesCached();
    const index = scenes.findIndex((s) => s.id === sceneId);
    if (index >= 0) {
      const scene2 = scenes[index];
      return { scene: scene2, rank: isRated(scene2) ? index + 1 : null, tier: tierMap(scenes).get(sceneId) ?? null };
    }
    const scene = await fetchSceneById(sceneId);
    return scene ? { scene, rank: null, tier: null } : null;
  }
  var settingsLoad = null;
  var openBattle = () => {
  };
  function createItem() {
    const item = document.createElement("span");
    item.className = ITEM_CLASS;
    item.innerHTML = `
      <button type="button" class="minimal btn btn-secondary sb-scene-elo-button" title="${TITLE}">
        <svg class="svg-inline--fa fa-icon" aria-hidden="true" focusable="false" viewBox="0 0 36 36" width="1em" height="1em">${SWORDS_PATHS}</svg>
        <span class="sb-scene-elo-value"></span>
      </button>`;
    item.querySelector("button")?.addEventListener("click", () => openBattle());
    return item;
  }
  function placeItem(toolbar, item) {
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
  var rendering = null;
  async function renderSceneElo(force = false) {
    const sceneId = getSceneIdFromUrl();
    const toolbar = document.querySelector(".scene-toolbar");
    if (!sceneId || !toolbar) return;
    const existing = toolbar.querySelector(`.${ITEM_CLASS}`);
    if (!force && existing?.dataset.sceneId === sceneId) return;
    if (rendering === sceneId) return;
    rendering = sceneId;
    try {
      if (!await sceneCustomFieldsSupported()) return;
      settingsLoad ?? (settingsLoad = loadSettings());
      const [result] = await Promise.all([sceneAndRank(sceneId), settingsLoad]);
      if (!result || getSceneIdFromUrl() !== sceneId) return;
      const target = document.querySelector(".scene-toolbar");
      if (!target) return;
      let item = target.querySelector(`.${ITEM_CLASS}`);
      if (!item) {
        item = createItem();
        if (!placeItem(target, item)) return;
      }
      item.dataset.sceneId = sceneId;
      const value = item.querySelector(".sb-scene-elo-value");
      if (value) value.textContent = labelText(result.scene, result.rank);
      item.querySelector("button")?.setAttribute("title", titleText(result.scene, result.tier));
    } catch (e) {
      console.warn("[Stash Battle] Couldn't show the scene's ELO:", e);
    } finally {
      rendering = null;
    }
  }
  function refreshSceneElo() {
    void renderSceneElo(true);
  }
  function registerSceneElo(onClick) {
    openBattle = onClick;
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
    check();
  }

  // src/ui/ratingPreview.ts
  var NOW_RATINGS = [100, 100, 96, 85, 74, 70, 62, 45, 20, null];
  var BATTLED_ELO = [2150, 1980, 1700, 1650, 1600, 1550, 1500, 1400, 1250, 1100];
  function exampleScenes() {
    return NOW_RATINGS.map((rating100, i) => ({ id: `example-${i}`, rating100, custom_fields: {} }));
  }
  function squares(scenes, mode) {
    const targets = stashRatingTargets(scenes, mode);
    return scenes.map((scene) => {
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
              <span class="${classes.join(" ")}"${fill}>${rating ?? "–"}</span>
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
    if (el.textContent === "" || target === "" || !Number.isFinite(from) || !Number.isFinite(to) || from === to) {
      el.textContent = target;
      return;
    }
    const startTime = performance.now();
    const timer = setTimeout(() => {
      const current = tweens.get(el);
      if (current) cancelAnimationFrame(current.frame);
      tweens.delete(el);
      el.textContent = target;
    }, TWEEN_MS + 50);
    const step = (now) => {
      const t = Math.min(1, (now - startTime) / TWEEN_MS);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = String(Math.round(from + (to - from) * eased));
      if (t < 1) tweens.set(el, { frame: requestAnimationFrame(step), timer });
    };
    tweens.set(el, { frame: requestAnimationFrame(step), timer });
  }
  function showRatingPreview(container, start, stashRatings) {
    const next = document.createElement("div");
    next.innerHTML = renderRatingPreview(start, stashRatings);
    const current = container.querySelector(".sb-rating-preview");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!current || reducedMotion) {
      container.replaceChildren(...next.childNodes);
      return;
    }
    const fresh = next.querySelector(".sb-rating-preview");
    const pairs = (selector) => {
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
  function renderRatingPreview(start, stashRatings) {
    const off = stashRatings === "off";
    const now = squares(exampleScenes(), "off");
    const setUp = squares(exampleScenes().map((scene) => afterSetup(scene, start)), stashRatings);
    const changedCount = setUp.filter((cell) => cell.changed).length;
    const battled = exampleScenes().map((scene, i) => ({ ...scene, custom_fields: { [ELO_FIELD]: BATTLED_ELO[i] } }));
    const later = squares(battled, stashRatings);
    const unchangedNote = "Stash ratings stay as they are";
    const laterNote = off ? unchangedNote : stashRatings === "percentile" ? "Evenly spaced by rank, whatever the gaps" : "Gaps show, but 2150 is stuck at 100";
    return `
        <div class="sb-rating-preview">
          <p class="sb-pv-legend">Each square below is an example scene: its ELO above, its Stash rating inside.</p>
          ${rowHtml("Now in Stash", now, "")}
          ${rowHtml("After setup", setUp, off ? unchangedNote : `${changedCount} of 10 change`, { muted: off, showChange: !off })}
          ${rowHtml("After lots of battles", later, laterNote, { muted: off })}
        </div>`;
  }

  // src/ui/setupScreen.ts
  var SETUP_ACTIVE_CLASS = "sb-setup-active";
  var running = false;
  var options = {};
  var plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
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
    let scenes;
    try {
      scenes = await fetchSetupScenes();
    } catch (e) {
      console.error("[Stash Battle] ELO setup: could not load scenes:", e);
      showError(area, "Couldn't load your scenes from Stash.", () => void loadChoices(area, onDone));
      return;
    }
    renderChoices(area, scenes, onDone);
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
      text = `⚠️ Every scene starts at 1500 ELO, so <strong>every Stash rating becomes 50</strong>: ${plural(changes, "rating")} change, unrated scenes included. ${backup}`;
    } else {
      text = `⚠️ <strong>${plural(changes, "Stash rating")} change</strong> now, spread evenly by rank. A scene you rated 100 by hand may end up lower. ${backup}`;
    }
    return `<p class="sb-setup-message${warn ? " sb-setup-warning" : ""}">${text}</p>`;
  }
  function renderChoices(area, scenes, onDone) {
    const total = scenes.length;
    const rated = scenes.filter((scene) => scene.rating100 != null).length;
    const unrated = total - rated;
    const withElo = scenes.filter(isRated).length;
    const upgradeNote = !state.settings.eloSetupAt && !hadFunMode() ? " Before 3.0, ratings changed after every battle; Straight-line with Use my ratings is closest to that." : "";
    const reset = options.reset === true;
    const choice = { start: "ratings", stashRatings: reset ? state.settings.stashRatings : "off" };
    area.innerHTML = `
      <div class="sb-setup">
        <h2 class="sb-setup-title">${reset ? "Reset ELO" : "Set up ELO"}</h2>
        <p class="sb-setup-intro">
          ${reset ? "Choose how ELO starts again. This overwrites every scene's ELO and battle count." : "Stash Battle now gives each scene an ELO score, saved in its custom fields. Wins raise it, losses lower it. Choose how it starts. This runs once."}
        </p>
        ${withElo > 0 && !reset ? `<p class="sb-setup-warning">${plural(withElo, "scene")} already ${withElo === 1 ? "has" : "have"} an ELO from an earlier setup that didn't finish. Setting up again overwrites ${withElo === 1 ? "it" : "them"}.</p>` : ""}
        <div class="sb-setup-questions">
          <fieldset class="sb-setup-question">
            <legend>How should ELO start?</legend>
            ${radio(
      "start",
      "ratings",
      "Use my ratings",
      `Your ${plural(rated, "rated scene")} start from their rating (50 = 1500 ELO, 10 ELO per point).${unrated > 0 ? ` The ${unrated} unrated ${unrated === 1 ? "one stays" : "ones stay"} unrated.` : ""}`,
      true
    )}
            ${radio(
      "start",
      "fresh",
      "Start everyone at 1500",
      `All ${plural(total, "scene")} start equal.`,
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
        const changes = setupRatingChanges(scenes, start, mode).size;
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
      startBtn.textContent = changes > 0 ? `Start ELO and change ${plural(changes, "rating")}` : "Start ELO";
    };
    area.querySelectorAll('input[type="radio"]').forEach((input) => {
      input.addEventListener("change", () => {
        if (input.name === "start") choice.start = input.value;
        else choice.stashRatings = input.value;
        update();
      });
    });
    startBtn.addEventListener("click", () => void runSetup(area, scenes, choice, onDone));
    update();
  }
  function progressHtml(phase, done, total) {
    const percent = total > 0 ? Math.round(done / total * 100) : 100;
    const label = phase === "elo" ? `Saving starting ELO: ${done} of ${plural(total, "scene")}` : `Updating Stash ratings: ${plural(total, "scene")}`;
    return `
      <div class="sb-setup sb-setup-progress">
        <h2 class="sb-setup-title">Setting up ELO...</h2>
        <div class="progress"><div class="progress-bar" role="progressbar" style="width: ${percent}%" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100"></div></div>
        <p class="sb-setup-progress-label">${label}</p>
        <p class="sb-setup-note">You can close Stash Battle; setup keeps going while this Stash tab stays open. If the tab closes first, Stash Battle asks again next time, and running it again is safe.</p>
      </div>`;
  }
  async function runSetup(area, scenes, choice, onDone) {
    running = true;
    area.innerHTML = progressHtml("elo", 0, 0);
    if (state.settings.eloSetupAt && !await updateSettingsNow({ eloSetupAt: null, eloSetupMode: null })) {
      console.warn("[Stash Battle] Couldn't clear the setup flag before resetting ELO; continuing");
    }
    let summary;
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
    const eloLine2 = choice.start === "ratings" ? `${plural(summary.eloWritten, "scene")} got a starting ELO from ${summary.eloWritten === 1 ? "its" : "their"} rating. Unrated scenes stay unrated until they battle.` : `${plural(summary.eloWritten, "scene")} start at 1500 ELO.`;
    const clearedLine = summary.eloCleared > 0 ? `<li>${plural(summary.eloCleared, "scene")} without a Stash rating had an old ELO removed.</li>` : "";
    const optionLabel = choice.stashRatings === "percentile" ? "Percentile" : "Straight-line";
    const ratingsLine = choice.stashRatings === "off" ? "Stash ratings weren't changed, and battles won't change them." : summary.ratingsWritten === 0 ? `Stash ratings already matched (${optionLabel}), so none changed. Battles keep them in step from now on.` : `${plural(summary.ratingsWritten, "Stash rating")} updated (${optionLabel}). Battles keep them in step from now on.`;
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
  function escapeHtml(text) {
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
    syncSettingsControls(modal);
    updateRatingsNote();
    void loadNewPair(getSceneIdFromUrl());
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
      case "showTiers":
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
    const currentFilterParams = window.location.search;
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
    }
    modal.querySelectorAll(".sb-mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const newMode = btn.dataset.mode;
        if (newMode !== state.currentMode) {
          state.currentMode = newMode;
          resetRunState();
          state.shuffleIndex = 0;
          modal.querySelectorAll(".sb-mode-btn").forEach((b) => {
            b.classList.toggle("active", b.dataset.mode === state.currentMode);
          });
          updateModeInfo();
          loadNewPair(getSceneIdFromUrl());
          updateClimbPoolWarning();
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
    bindSettingsControls(modal, onSettingChanged, () => applyPreviewSettings(), confirmSettingChange);
    updateRatingsNote();
    modal.querySelector('[data-action="reset-elo"]')?.addEventListener("click", () => void startResetElo(modal));
    modal.querySelector('[data-action="open-settings"]')?.addEventListener("click", (e) => {
      e.preventDefault();
      showTab(modal, "settings");
      applyPreviewSettings();
    });
    modal.querySelector("#sb-skip-btn")?.addEventListener("click", skipPair);
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
        const leftBody = activeModal.querySelector('.sb-scene-card[data-side="left"] .sb-scene-body');
        if (leftBody) leftBody.click();
      }
      if (e.key === "ArrowRight" && state.currentPair.right) {
        e.preventDefault();
        const rightBody = activeModal.querySelector('.sb-scene-card[data-side="right"] .sb-scene-body');
        if (rightBody) rightBody.click();
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
  var NAV_ITEM_CLASS = "col-4 col-sm-3 col-md-2 col-lg-auto nav-link";
  var LINK_CLASS = "minimal p-4 p-xl-2 d-flex d-xl-inline-block flex-column justify-content-between align-items-center btn btn-primary";
  var LINK_HTML = `
            <svg aria-hidden="true" focusable="false" class="svg-inline--fa fa-icon nav-menu-icon d-block d-xl-inline mb-2 mb-xl-0" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36">${SWORDS_PATHS}</svg>
            <span>Battle</span>
        `;
  function shouldShowNavButton() {
    const path = window.location.pathname;
    return path === "/" || path === "/scenes" || path === "/scenes/" || path.startsWith("/scenes/");
  }
  function onButtonClick(e) {
    e.preventDefault();
    void openModal();
  }
  function registerNavButton() {
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
    const events = api.Event;
    function BattleNavItem() {
      const [, setPath] = React.useState(window.location.pathname);
      React.useEffect(() => {
        if (!events) return;
        const update = () => setPath(window.location.pathname);
        update();
        events.addEventListener("stash:location", update);
        return () => events.removeEventListener("stash:location", update);
      }, []);
      if (!shouldShowNavButton()) return null;
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
    if (!shouldShowNavButton()) {
      const existing = document.getElementById(BUTTON_ID);
      if (existing) {
        existing.closest(".nav-link")?.remove();
      }
      return;
    }
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL2NvbnN0YW50cy50cyIsICIuLi8uLi9zcmMvZWxvLnRzIiwgIi4uLy4uL3NyYy9zY29yZS50cyIsICIuLi8uLi9zcmMvZ3JhcGhxbC50cyIsICIuLi8uLi9zcmMvdWkvZGVsZXRlRGlhbG9nLnRzIiwgIi4uLy4uL3NyYy9maWx0ZXJzLnRzIiwgIi4uLy4uL3NyYy9zdGF0ZS50cyIsICIuLi8uLi9zcmMvY2FjaGUudHMiLCAiLi4vLi4vc3JjL3NjZW5lQWN0aW9ucy50cyIsICIuLi8uLi9zcmMvcmF0aW5nLnRzIiwgIi4uLy4uL3NyYy9lbG9TZXR1cC50cyIsICIuLi8uLi9zcmMvc2V0dGluZ3MudHMiLCAiLi4vLi4vc3JjL3N0b3JhZ2UudHMiLCAiLi4vLi4vc3JjL3VpL2NvbmZpcm1EaWFsb2cudHMiLCAiLi4vLi4vc3JjL25hdmlnYXRpb24udHMiLCAiLi4vLi4vc3JjL3BsYWNlbWVudC50cyIsICIuLi8uLi9zcmMvcGFpcnMudHMiLCAiLi4vLi4vc3JjL3N0YXRzLnRzIiwgIi4uLy4uL3NyYy91aS9zY2VuZVRpdGxlLnRzIiwgIi4uLy4uL3NyYy91aS9zY2VuZUNhcmQudHMiLCAiLi4vLi4vc3JjL3VpL3NjcmVlbnMudHMiLCAiLi4vLi4vc3JjL3VpL3N0YXNoUmF0aW5nc1RleHQudHMiLCAiLi4vLi4vc3JjL3VpL3NldHRpbmdzUGFuZWwudHMiLCAiLi4vLi4vc3JjL3VpL21haW5VSS50cyIsICIuLi8uLi9zcmMvdWkvaWNvbnMudHMiLCAiLi4vLi4vc3JjL3VpL3NjZW5lRWxvLnRzIiwgIi4uLy4uL3NyYy91aS9yYXRpbmdQcmV2aWV3LnRzIiwgIi4uLy4uL3NyYy91aS9zZXR1cFNjcmVlbi50cyIsICIuLi8uLi9zcmMvdWkvbW9kYWwudHMiLCAiLi4vLi4vc3JjL3VpL25hdkJ1dHRvbi50cyIsICIuLi8uLi9zcmMvbWFpbi50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUGx1Z2luLXdpZGUgY29uc3RhbnRzLlxuXG5leHBvcnQgY29uc3QgU1RPUkFHRV9LRVkgPSBcInN0YXNoLWJhdHRsZS1zdGF0ZVwiO1xuZXhwb3J0IGNvbnN0IENBQ0hFX0RCX05BTUUgPSBcInN0YXNoLWJhdHRsZS1jYWNoZVwiO1xuLyoqIDIgKDMuMCk6IGNhY2hlZCBzY2VuZXMgZnJvbSBiZWZvcmUgbmVlZCBjdXN0b21fZmllbGRzIGFuZCBFTE8gb3JkZXIsIHNvIHRoZSBzdG9yZSBpcyBjbGVhcmVkLiAqL1xuZXhwb3J0IGNvbnN0IENBQ0hFX0RCX1ZFUlNJT04gPSAyO1xuZXhwb3J0IGNvbnN0IENBQ0hFX1NUT1JFX05BTUUgPSBcInNjZW5lc1wiO1xuZXhwb3J0IGNvbnN0IENBQ0hFX01BWF9BR0VfTVMgPSA1ICogNjAgKiAxMDAwOyAvLyA1IG1pbnV0ZXMgY2FjaGUgZXhwaXJ5XG5cbmltcG9ydCB0eXBlIHsgU2V0dGluZ3MsIFRpZXIgfSBmcm9tIFwiLi90eXBlc1wiO1xuXG4vKiogUGx1Z2luIGlkIChmb2xkZXIgbmFtZSkg4oCUIGtleSBmb3IgdGhpcyBwbHVnaW4ncyBzZXR0aW5ncyBpbiBTdGFzaCdzIGNvbmZpZ3VyYXRpb24uICovXG5leHBvcnQgY29uc3QgUExVR0lOX0lEID0gXCJzdGFzaC1iYXR0bGVcIjtcblxuZXhwb3J0IGNvbnN0IERFRkFVTFRfU0VUVElOR1M6IFNldHRpbmdzID0ge1xuICBzdGFzaFJhdGluZ3M6IFwib2ZmXCIsXG4gIGVsb1NldHVwQXQ6IG51bGwsXG4gIGVsb1NldHVwTW9kZTogbnVsbCxcbiAgb3BlbkluTmV3VGFiOiBmYWxzZSxcbiAgcGxhY2VtZW50RnJvbUJvdHRvbTogZmFsc2UsXG4gIHNob3dUaWVyczogdHJ1ZSxcbiAgcHJldmlld1ZvbHVtZTogNTAsXG4gIGF1dG9wbGF5UHJldmlld3M6IHRydWUsXG4gIGZpbHRlck9wcG9uZW50czogZmFsc2UsXG4gIGNsZWFuTW9kZTogZmFsc2UsXG4gIHBhdXNlTWVkaWFPbk9wZW46IHRydWUsXG59O1xuXG4vLyBQcmUtMi43IGxvY2FsU3RvcmFnZSBwcmVmZXJlbmNlIGtleXMgKG1pZ3JhdGVkIGludG8gcGx1Z2luIHNldHRpbmdzKS5cbmV4cG9ydCBjb25zdCBMRUdBQ1lfRklMVEVSX09QUE9ORU5UU19LRVkgPSBcInNiX2ZpbHRlck9wcG9uZW50c1wiO1xuZXhwb3J0IGNvbnN0IExFR0FDWV9NVVRFX1BSRVZJRVdTX0tFWSA9IFwic2JfbXV0ZVByZXZpZXdzXCI7XG5cbi8qKlxuICogU3dpc3M6IHRoZSBvcHBvbmVudCBpcyBwaWNrZWQgYXQgcmFuZG9tIGZyb20gZXZlcnkgc2NlbmUgd2l0aGluIMKxdGhpcyBFTE8gKHdpbiBjaGFuY2VzIGJldHdlZW5cbiAqIDM2JSBhbmQgNjQlKS4gQSBwaWNrIHRoYXQgY2xvc2Ugc3RpbGwgdGVsbHMgb3ZlciA5MCUgb2Ygd2hhdCBhIDUwLzUwIG9uZSBkb2VzLCBhbmQgYSBzY2VuZSBtZWV0c1xuICogZmFyIG1vcmUgdmFyaWVkIG9wcG9uZW50cyB0aGFuIGEgd2luZG93IG9mIG5lYXJieSByYW5rcywgd2hpY2ggb24gYSBzZWVkZWQgbGlicmFyeSBpcyBtb3N0bHlcbiAqIHRpZXMuXG4gKi9cbmV4cG9ydCBjb25zdCBTV0lTU19PUFBPTkVOVF9FTE9fV0lORE9XID0gMTAwO1xuLyoqIFN3aXNzOiB3aGVuIGZld2VyIHNjZW5lcyB0aGFuIHRoaXMgYXJlIGluIHRoZSB3aW5kb3cgKHRvcCwgYm90dG9tLCBzbWFsbCBwb29scyksIHRha2UgdGhpcyBtYW55IG5lYXJlc3QuICovXG5leHBvcnQgY29uc3QgU1dJU1NfT1BQT05FTlRfTUlOX0NBTkRJREFURVMgPSAxMDtcblxuLy8gQ2hhbXBpb246IHJhbmRvbSBwaWNrIGFtb25nIHRoZSBOIGNsb3Nlc3QgdW5kZWZlYXRlZCBvcHBvbmVudHMgYWJvdmUgdGhlIGNoYW1waW9uLlxuZXhwb3J0IGNvbnN0IENMSU1CX09QUE9ORU5UX1BJQ0tfV0lORE9XID0gNTtcblxuLyoqXG4gKiBFTE8gYW4gdW5yYXRlZCBzY2VuZSBjb3VudHMgYXMgaW4gQ2hhbXBpb246IDEwMDAsIHRoZSBib3R0b20gKHdoYXQgYSAwIHJhdGluZyBzZWVkcyB0byksIHNvIGFcbiAqIG5ld2NvbWVyIGNsaW1icyBmcm9tIHRoZXJlIGFzIGJlZm9yZS4gU3dpc3MgY291bnRzIHVucmF0ZWQgc2NlbmVzIGFzIEVMT19TVEFSVCAoMTUwMCkuXG4gKi9cbmV4cG9ydCBjb25zdCBDSEFNUElPTl9VTlJBVEVEX0VMTyA9IDEwMDA7XG5cbi8qKlxuICogQSBwaWNrIGlzIGFuIFwiVXBzZXQhXCIgd2hlbiB0aGUgd2lubmVyJ3Mgd2luIGNoYW5jZSAoYXMgc2hvd24sIGluICUpIHdhcyBhdCBtb3N0IHRoaXM6IGFib3V0IDcwXG4gKiBFTE8gYmVsb3cgaXRzIG9wcG9uZW50LiBTd2lzcyBvcHBvbmVudHMgYXJlIHdpdGhpbiDCsTEwMCwgc28gYWJvdXQgMSBwaWNrIGluIDcgaWYgRUxPIGlzIHJpZ2h0LlxuICovXG5leHBvcnQgY29uc3QgVVBTRVRfTUFYX0NIQU5DRSA9IDQwO1xuXG4vKiogU2hvdyBhIFVJIHdhcm5pbmcgd2hlbiBDaGFtcGlvbidzIG9wcG9uZW50IHBvb2wgaXMgc21hbGxlciB0aGFuIHRoaXMgKGZpbHRlciBvcHBvbmVudHMgb24pLiAqL1xuZXhwb3J0IGNvbnN0IENMSU1CX1NNQUxMX1BPT0xfV0FSTl9BVCA9IDEwO1xuXG4vLyAtLS0gVHJ1ZSBFTE8gKHN0b3JlZCBpbiBzY2VuZSBjdXN0b20gZmllbGRzKSAtLS1cblxuLyoqIFNjZW5lIGN1c3RvbSBmaWVsZCBrZXlzLiBXcml0ZXMgdXNlIGBwYXJ0aWFsYCwgc28gb3RoZXIgcGx1Z2lucycgZmllbGRzIGFyZSBuZXZlciB0b3VjaGVkLiAqL1xuZXhwb3J0IGNvbnN0IEVMT19GSUVMRCA9IFwic3Rhc2hfYmF0dGxlX2Vsb1wiO1xuLyoqIFJlYWwgYmF0dGxlcyB0aGF0IG1vdmVkIHRoaXMgc2NlbmUncyBFTE8gKFBsYWNlbWVudCBhZGRzIGl0cyBydW4ncyBiYXR0bGVzIHdoZW4gdGhlIHNjZW5lIGxhbmRzKS4gKi9cbmV4cG9ydCBjb25zdCBCQVRUTEVTX0ZJRUxEID0gXCJzdGFzaF9iYXR0bGVfYmF0dGxlc1wiO1xuLyoqIFRydWUgd2hlbiB0aGUgc2NlbmUncyBzdGFydGluZyBFTE8gY2FtZSBmcm9tIGl0cyBTdGFzaCByYXRpbmcgKHNldHVwJ3MgXCJVc2UgbXkgcmF0aW5nc1wiKS4gKi9cbmV4cG9ydCBjb25zdCBTRUVERURfRklFTEQgPSBcInN0YXNoX2JhdHRsZV9zZWVkZWRcIjtcbi8qKiBBbGwgb2YgU3Rhc2ggQmF0dGxlJ3MgcGVyLXNjZW5lIGZpZWxkcyAocmVtb3ZlZCB0b2dldGhlciB3aGVuIGEgc2NlbmUgYmVjb21lcyB1bnJhdGVkKS4gKi9cbmV4cG9ydCBjb25zdCBFTE9fRklFTERfS0VZUyA9IFtFTE9fRklFTEQsIEJBVFRMRVNfRklFTEQsIFNFRURFRF9GSUVMRF07XG5cbmV4cG9ydCBjb25zdCBFTE9fU1RBUlQgPSAxNTAwO1xuZXhwb3J0IGNvbnN0IEVMT19ESVZJU09SID0gNDAwO1xuXG4vKiogSyBieSBLLWdhbWVzIChiYXR0bGVzLCBwbHVzIHRoZSBoZWFkIHN0YXJ0IGlmIHNlZWRlZCk6IFtiZWxvdyB0aGlzIGNvdW50LCBLXTsgdGhlIGxhc3QgaGFzIG5vIGxpbWl0LiAqL1xuZXhwb3J0IGNvbnN0IEVMT19LX1RJRVJTOiByZWFkb25seSAocmVhZG9ubHkgW251bWJlciwgbnVtYmVyXSlbXSA9IFtcbiAgWzEwLCA0MF0sXG4gIFszMCwgMjRdLFxuICBbSW5maW5pdHksIDE2XSxcbl07XG5cbi8qKlxuICogVGllcnMgKFwiU2hvdyB0aWVycyBvbiBjYXJkc1wiKSwgYmVzdCBmaXJzdCwgYnkgcmFuayBhbW9uZyB0aGUgbGlicmFyeSdzIHNldHRsZWQgc2NlbmVzOiBhIHNjZW5lXG4gKiB3aG9zZSByYW5rIGlzIHdpdGhpbiB0aGUgdG9wIGB0b3BgIHNoYXJlIGdldHMgdGhlIGZpcnN0IHRpZXIgdGhhdCBmaXRzLiBFdmVyeSB0aWVyIGFsd2F5cyBoYXNcbiAqIHNjZW5lcyBpbiBpdCwgd2hhdGV2ZXIgdGhlIGxpYnJhcnkncyBFTE8gc3ByZWFkLiBUaGUgbGFzdCB0aWVyIHRha2VzIGV2ZXJ5b25lIGVsc2UuXG4gKi9cbmV4cG9ydCBjb25zdCBUSUVSUzogcmVhZG9ubHkgVGllcltdID0gW1xuICB7IGlkOiBcImxlZ2VuZGFyeVwiLCBuYW1lOiBcIkxlZ2VuZGFyeVwiLCBlbW9qaTogXCLwn5GRXCIsIHRvcDogMC4wMSB9LFxuICB7IGlkOiBcImRpYW1vbmRcIiwgbmFtZTogXCJEaWFtb25kXCIsIGVtb2ppOiBcIvCfko5cIiwgdG9wOiAwLjA1IH0sXG4gIHsgaWQ6IFwicGxhdGludW1cIiwgbmFtZTogXCJQbGF0aW51bVwiLCBlbW9qaTogXCLwn5S3XCIsIHRvcDogMC4xNSB9LFxuICB7IGlkOiBcImdvbGRcIiwgbmFtZTogXCJHb2xkXCIsIGVtb2ppOiBcIvCfpYdcIiwgdG9wOiAwLjM1IH0sXG4gIHsgaWQ6IFwic2lsdmVyXCIsIG5hbWU6IFwiU2lsdmVyXCIsIGVtb2ppOiBcIvCfpYhcIiwgdG9wOiAwLjY1IH0sXG4gIHsgaWQ6IFwiYnJvbnplXCIsIG5hbWU6IFwiQnJvbnplXCIsIGVtb2ppOiBcIvCfpYlcIiwgdG9wOiAxIH0sXG5dO1xuXG4vKipcbiAqIEVMTyBwb2ludHMgcGVyIDEtMTAwIHJhdGluZyBwb2ludC4gVGhlIHByZS0zLjAgbWF0aCBkaXZpZGVkIGJ5IDQwIG9uIHRoZSAxLTEwMCBzY2FsZSwgc28gb25lXG4gKiByYXRpbmcgcG9pbnQgYWxyZWFkeSBtZWFudCBleGFjdGx5IDEwIHN0YW5kYXJkIChkaXZpc29yIDQwMCkgRUxPIHBvaW50cy5cbiAqL1xuZXhwb3J0IGNvbnN0IEVMT19QRVJfUkFUSU5HX1BPSU5UID0gMTA7XG5cbi8qKlxuICogSGVhZCBzdGFydCAoY291bnRlZCBhcyBiYXR0bGVzIGZvciBLIG9ubHkpIGZvciBzY2VuZXMgc2VlZGVkIGZyb20gdGhlaXIgU3Rhc2ggcmF0aW5nOiB0aGVpclxuICogcmF0aW5nIGFscmVhZHkgc2F5cyBzb21ldGhpbmcsIHNvIHRoZXkgc2tpcCB0aGUgYmlnZ2VzdCBzd2luZ3MuIENoYW5naW5nIGl0IGFwcGxpZXMgdG8gZXZlcnlcbiAqIHNlZWRlZCBzY2VuZSBhdCBvbmNlLCBiZWNhdXNlIGl0IGlzbid0IHN0b3JlZC5cbiAqL1xuZXhwb3J0IGNvbnN0IFNFRURFRF9IRUFEX1NUQVJUID0gMTA7XG5cbi8qKiBFTE8gZ2FwIGFib3ZlIHRoZSB0b3AgLyBiZWxvdyB0aGUgYm90dG9tIHNjZW5lIHdoZW4gUGxhY2VtZW50IGxhbmRzIGEgc2NlbmUgYXQgYW4gZWRnZS4gKi9cbmV4cG9ydCBjb25zdCBQTEFDRU1FTlRfRURHRV9HQVAgPSAyNTtcblxuLyoqXG4gKiBQbGFjZW1lbnQncyBkb3VibGluZyBqdW1wcyBhcmUgY2FwcGVkIGF0IHRoaXMgc2hhcmUgb2YgdGhlIHBvb2wgKGJ1dCBhdCBsZWFzdFxuICogUExBQ0VNRU5UX01JTl9NQVhfSlVNUCByYW5rcyksIHNvIGEgd2lubmluZyBzdHJlYWsgY2xpbWJzIGluc3RlYWQgb2YgbGVhcGluZyB0byAjMS4gSW4gYVxuICogNjAwLXNjZW5lIGxpYnJhcnk6IGF0IG1vc3QgNjAgcmFua3MgcGVyIGp1bXAsIGFib3V0IG9uZSBleHRyYSBiYXR0bGUgb24gYXZlcmFnZS5cbiAqL1xuZXhwb3J0IGNvbnN0IFBMQUNFTUVOVF9NQVhfSlVNUF9TSEFSRSA9IDAuMTtcbmV4cG9ydCBjb25zdCBQTEFDRU1FTlRfTUlOX01BWF9KVU1QID0gNDtcbiIsICIvLyBFTE8gbWF0aCAocHVyZSBjYWxjdWxhdGlvbnM6IGNhbGxlcnMgYXBwbHkgdGhlIHJlc3VsdHMgYW5kIHBlcnNpc3QgdGhlbSkuXG5cbmltcG9ydCB7IEVMT19ESVZJU09SLCBFTE9fS19USUVSUyB9IGZyb20gXCIuL2NvbnN0YW50c1wiO1xuXG4vKiogSyBmb3IgYSBzY2VuZSB3aXRoIHRoaXMgbWFueSBLLWdhbWVzIChzZWUga0dhbWVzKTogbmV3IHNjZW5lcyBtb3ZlIGEgbG90LCBlc3RhYmxpc2hlZCBvbmVzIGxpdHRsZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlbG9LRmFjdG9yKGtHYW1lczogbnVtYmVyKTogbnVtYmVyIHtcbiAgZm9yIChjb25zdCBbYmVsb3csIGtdIG9mIEVMT19LX1RJRVJTKSB7XG4gICAgaWYgKGtHYW1lcyA8IGJlbG93KSByZXR1cm4gaztcbiAgfVxuICByZXR1cm4gRUxPX0tfVElFUlNbRUxPX0tfVElFUlMubGVuZ3RoIC0gMV1bMV07XG59XG5cbi8qKiBQcm9iYWJpbGl0eSB0aGF0IGEgc2NlbmUgcmF0ZWQgYGVsb2AgYmVhdHMgb25lIHJhdGVkIGBvcHBvbmVudEVsb2AuICovXG5leHBvcnQgZnVuY3Rpb24gZWxvRXhwZWN0ZWQoZWxvOiBudW1iZXIsIG9wcG9uZW50RWxvOiBudW1iZXIpOiBudW1iZXIge1xuICByZXR1cm4gMSAvICgxICsgTWF0aC5wb3coMTAsIChvcHBvbmVudEVsbyAtIGVsbykgLyBFTE9fRElWSVNPUikpO1xufVxuXG4vKipcbiAqIEJvdGggc2lkZXMnIHdpbiBjaGFuY2VzIGFzIHdob2xlIHBlcmNlbnRhZ2VzIHRoYXQgYWx3YXlzIGFkZCB1cCB0byAxMDAsIGtlcHQgd2l0aGluIDEtOTkgKGFcbiAqIFwiMTAwJVwiIHdvdWxkIHJlYWQgYXMgYSBzdXJlIHRoaW5nLCBhbmQgRUxPIG5ldmVyIGlzKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdpbkNoYW5jZXMoZWxvOiBudW1iZXIsIG9wcG9uZW50RWxvOiBudW1iZXIpOiBbbnVtYmVyLCBudW1iZXJdIHtcbiAgY29uc3QgZmlyc3QgPSBNYXRoLm1pbig5OSwgTWF0aC5tYXgoMSwgTWF0aC5yb3VuZChlbG9FeHBlY3RlZChlbG8sIG9wcG9uZW50RWxvKSAqIDEwMCkpKTtcbiAgcmV0dXJuIFtmaXJzdCwgMTAwIC0gZmlyc3RdO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEVsb1NpZGUge1xuICBlbG86IG51bWJlcjtcbiAgLyoqIEJhdHRsZXMgcGx1cyBhbnkgc2VlZGVkIGhlYWQgc3RhcnQgKHNjb3JlLnRzIGtHYW1lcyk6IHNldHMgdGhpcyBzaWRlJ3MgSy4gKi9cbiAga0dhbWVzOiBudW1iZXI7XG59XG5cbi8qKiBTdG9yZWQgRUxPIHByZWNpc2lvbiAob25lIGRlY2ltYWwpLCBzbyBzbWFsbCBsYXRlLWNhcmVlciBjaGFuZ2VzIGFyZW4ndCByb3VuZGVkIGF3YXkuICovXG5leHBvcnQgZnVuY3Rpb24gcm91bmRFbG8oZWxvOiBudW1iZXIpOiBudW1iZXIge1xuICByZXR1cm4gTWF0aC5yb3VuZChlbG8gKiAxMCkgLyAxMDtcbn1cblxuLyoqXG4gKiBUd28tc2lkZWQgRUxPIGZvciBhIGhlYWQtdG8taGVhZCB3aW47IGVhY2ggc2lkZSB1c2VzIGl0cyBvd24gSy4gUmV0dXJucyB0aGUgbmV3IEVMT3MuXG4gKiBFYWNoIHNpZGUgbW92ZXMgYnkgSyDDlyAoYWN0dWFsIOKIkiBleHBlY3RlZCk6IHRoZSB3aW5uZXIgYnkgSyDDlyAoMSDiiJIgaXRzIHdpbiBjaGFuY2UpLCB0aGUgbG9zZXJcbiAqIGJ5IEsgw5cgKDAg4oiSIGl0cyBvd24gd2luIGNoYW5jZSksIHdoaWNoIGlzIHRoZSBzYW1lIDEg4oiSIHdpbm5lcidzIGNoYW5jZS4gV2l0aCBlcXVhbCBLIHRoZVxuICogcG9pbnRzIGFyZSBleGFjdGx5IHplcm8tc3VtLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZWxvUmVzdWx0KHdpbm5lcjogRWxvU2lkZSwgbG9zZXI6IEVsb1NpZGUpOiB7IHdpbm5lcjogbnVtYmVyOyBsb3NlcjogbnVtYmVyIH0ge1xuICBjb25zdCBzdXJwcmlzZSA9IDEgLSBlbG9FeHBlY3RlZCh3aW5uZXIuZWxvLCBsb3Nlci5lbG8pO1xuICByZXR1cm4ge1xuICAgIHdpbm5lcjogcm91bmRFbG8od2lubmVyLmVsbyArIGVsb0tGYWN0b3Iod2lubmVyLmtHYW1lcykgKiBzdXJwcmlzZSksXG4gICAgbG9zZXI6IHJvdW5kRWxvKGxvc2VyLmVsbyAtIGVsb0tGYWN0b3IobG9zZXIua0dhbWVzKSAqIHN1cnByaXNlKSxcbiAgfTtcbn1cbiIsICIvLyBBIHNjZW5lJ3MgRUxPIChyZWFkIGZyb20gaXRzIGN1c3RvbSBmaWVsZHMpLCBFTE8gb3JkZXJpbmcsIGFuZCBjb252ZXJzaW9ucyBiZXR3ZWVuIEVMTyBhbmRcbi8vIFN0YXNoJ3MgMS0xMDAgcmF0aW5nLiBQdXJlIGZ1bmN0aW9uczogbm8gc3RhdGUsIG5vIEkvTy5cblxuaW1wb3J0IHtcbiAgQkFUVExFU19GSUVMRCxcbiAgRUxPX0ZJRUxELFxuICBFTE9fRklFTERfS0VZUyxcbiAgRUxPX0tfVElFUlMsXG4gIEVMT19QRVJfUkFUSU5HX1BPSU5ULFxuICBFTE9fU1RBUlQsXG4gIFBMQUNFTUVOVF9FREdFX0dBUCxcbiAgU0VFREVEX0ZJRUxELFxuICBTRUVERURfSEVBRF9TVEFSVCxcbn0gZnJvbSBcIi4vY29uc3RhbnRzXCI7XG5pbXBvcnQgeyByb3VuZEVsbyB9IGZyb20gXCIuL2Vsb1wiO1xuaW1wb3J0IHR5cGUgeyBFbG9GaWVsZHMsIEVsb1N0YXJ0LCBTY2VuZSwgU3Rhc2hSYXRpbmdzTW9kZSB9IGZyb20gXCIuL3R5cGVzXCI7XG5cbi8qKiBDdXN0b20gZmllbGQgdmFsdWVzIHNob3VsZCBjb21lIGJhY2sgYXMgbnVtYmVyczsgbnVtZXJpYyBzdHJpbmdzIGFyZSBhY2NlcHRlZCB0b28uICovXG5mdW5jdGlvbiByZWFkTnVtYmVyKHZhbHVlOiB1bmtub3duKTogbnVtYmVyIHwgbnVsbCB7XG4gIGlmICh0eXBlb2YgdmFsdWUgPT09IFwibnVtYmVyXCIpIHJldHVybiBOdW1iZXIuaXNGaW5pdGUodmFsdWUpID8gdmFsdWUgOiBudWxsO1xuICBpZiAodHlwZW9mIHZhbHVlID09PSBcInN0cmluZ1wiICYmIHZhbHVlLnRyaW0oKSAhPT0gXCJcIikge1xuICAgIGNvbnN0IG4gPSBOdW1iZXIodmFsdWUpO1xuICAgIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobikgPyBuIDogbnVsbDtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqIFRoZSBzY2VuZSdzIHN0b3JlZCBFTE8sIG9yIG51bGwgd2hlbiBpdCBoYXMgbm9uZSAodW5yYXRlZCkuICovXG5leHBvcnQgZnVuY3Rpb24gZWxvKHNjZW5lOiBTY2VuZSk6IG51bWJlciB8IG51bGwge1xuICByZXR1cm4gcmVhZE51bWJlcihzY2VuZS5jdXN0b21fZmllbGRzPy5bRUxPX0ZJRUxEXSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpc1JhdGVkKHNjZW5lOiBTY2VuZSk6IGJvb2xlYW4ge1xuICByZXR1cm4gZWxvKHNjZW5lKSAhPT0gbnVsbDtcbn1cblxuLyoqIFJlYWwgYmF0dGxlcyB0aGF0IG1vdmVkIHRoZSBzY2VuZSdzIEVMTy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBiYXR0bGVzKHNjZW5lOiBTY2VuZSk6IG51bWJlciB7XG4gIGNvbnN0IG4gPSByZWFkTnVtYmVyKHNjZW5lLmN1c3RvbV9maWVsZHM/LltCQVRUTEVTX0ZJRUxEXSk7XG4gIHJldHVybiBuICE9PSBudWxsICYmIG4gPiAwID8gTWF0aC5mbG9vcihuKSA6IDA7XG59XG5cbi8qKiBUaGUgc2NlbmUncyBzdGFydGluZyBFTE8gY2FtZSBmcm9tIGl0cyBTdGFzaCByYXRpbmcuIChTdGFzaCBzdG9yZXMgYHRydWVgIGFzIDEuKSAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzU2VlZGVkKHNjZW5lOiBTY2VuZSk6IGJvb2xlYW4ge1xuICBjb25zdCB2YWx1ZSA9IHNjZW5lLmN1c3RvbV9maWVsZHM/LltTRUVERURfRklFTERdO1xuICByZXR1cm4gdmFsdWUgPT09IHRydWUgfHwgdmFsdWUgPT09IDEgfHwgdmFsdWUgPT09IFwidHJ1ZVwiIHx8IHZhbHVlID09PSBcIjFcIjtcbn1cblxuLyoqIFRoZSBjb3VudCBLIGlzIGJhc2VkIG9uOiByZWFsIGJhdHRsZXMsIHBsdXMgdGhlIGhlYWQgc3RhcnQgZm9yIHNlZWRlZCBzY2VuZXMuICovXG5leHBvcnQgZnVuY3Rpb24ga0dhbWVzKHNjZW5lOiBTY2VuZSk6IG51bWJlciB7XG4gIHJldHVybiBiYXR0bGVzKHNjZW5lKSArIChpc1NlZWRlZChzY2VuZSkgPyBTRUVERURfSEVBRF9TVEFSVCA6IDApO1xufVxuXG4vKipcbiAqIFRoZSBzY2VuZSdzIEVMTyBpcyBzdGlsbCBzZXR0bGluZzogaXQgaGFzIGZld2VyIEstZ2FtZXMgdGhhbiB0aGUgZmlyc3QgSyB0aWVyJ3MgbGltaXQgKDEwKSwgdGhlXG4gKiBzdGFnZSB3aGVyZSBlYWNoIGJhdHRsZSBtb3ZlcyBpdCB0aGUgbW9zdC4gU2VlZGVkIHNjZW5lcyBzdGFydCBwYXN0IGl0OyB1bnJhdGVkIG9uZXMgYXJlbid0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNQcm92aXNpb25hbChzY2VuZTogU2NlbmUpOiBib29sZWFuIHtcbiAgcmV0dXJuIGlzUmF0ZWQoc2NlbmUpICYmIGtHYW1lcyhzY2VuZSkgPCBFTE9fS19USUVSU1swXVswXTtcbn1cblxuLyoqIEVsb0ZpZWxkcyBhcyB0aGUgY3VzdG9tIGZpZWxkcyBtYXAgU3Rhc2ggc3RvcmVzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVsb0N1c3RvbUZpZWxkcyh2YWx1ZTogRWxvRmllbGRzKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICByZXR1cm4geyBbRUxPX0ZJRUxEXTogdmFsdWUuZWxvLCBbQkFUVExFU19GSUVMRF06IHZhbHVlLmJhdHRsZXMsIFtTRUVERURfRklFTERdOiB2YWx1ZS5zZWVkZWQgfTtcbn1cblxuLyoqIFN0YXJ0aW5nIEVMTyBmb3IgYSAxLTEwMCBTdGFzaCByYXRpbmc6IDUwIGlzIDE1MDAsIHNvIDEtMTAwIG1hcHMgb250byAxMDEwLTIwMDAuICovXG5leHBvcnQgZnVuY3Rpb24gc2VlZChyYXRpbmcxMDA6IG51bWJlcik6IG51bWJlciB7XG4gIHJldHVybiBFTE9fU1RBUlQgKyAocmF0aW5nMTAwIC0gNTApICogRUxPX1BFUl9SQVRJTkdfUE9JTlQ7XG59XG5cbi8qKiBFTE8gdXNlZCBpbiBiYXR0bGUgbWF0aDogdGhlIHN0b3JlZCBFTE8sIG9yIGB1bnJhdGVkRWxvYCBmb3IgdW5yYXRlZCBzY2VuZXMgKDE1MDAgYnkgZGVmYXVsdCkuICovXG5leHBvcnQgZnVuY3Rpb24gZWZmZWN0aXZlRWxvKHNjZW5lOiBTY2VuZSwgdW5yYXRlZEVsbzogbnVtYmVyID0gRUxPX1NUQVJUKTogbnVtYmVyIHtcbiAgcmV0dXJuIGVsbyhzY2VuZSkgPz8gdW5yYXRlZEVsbztcbn1cblxuLyoqIFN0cmFpZ2h0LWxpbmUgU3Rhc2ggcmF0aW5nOiB0aGUgaW52ZXJzZSBvZiBzZWVkKCksIGNsYW1wZWQgdG8gMS0xMDAuICovXG5leHBvcnQgZnVuY3Rpb24gbGluZWFyUmF0aW5nKGVsb1ZhbHVlOiBudW1iZXIpOiBudW1iZXIge1xuICBjb25zdCByYXRpbmcgPSBNYXRoLnJvdW5kKDUwICsgKGVsb1ZhbHVlIC0gRUxPX1NUQVJUKSAvIEVMT19QRVJfUkFUSU5HX1BPSU5UKTtcbiAgcmV0dXJuIE1hdGgubWluKDEwMCwgTWF0aC5tYXgoMSwgcmF0aW5nKSk7XG59XG5cbi8qKlxuICogUGVyY2VudGlsZSBTdGFzaCByYXRpbmdzIGZvciBldmVyeSBzY2VuZSB3aXRoIGFuIEVMTzogdGhlIHRvcCBzY2VuZSBpcyAxMDAsIHRoZSBib3R0b20gMSxcbiAqIGV2ZW5seSBzcGFjZWQgYnkgcmFuay4gVGllZCBzY2VuZXMgc2hhcmUgdGhlIG1pZGRsZSBwb3NpdGlvbiBvZiB0aGVpciB0aWUgZ3JvdXAsIHNvIGEgZnVsbHlcbiAqIHRpZWQgbGlicmFyeSBpcyA1MCBldmVyeXdoZXJlLiBVbnJhdGVkIHNjZW5lcyBhcmUgbGVmdCBvdXQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwZXJjZW50aWxlUmF0aW5ncyhzY2VuZXM6IFNjZW5lW10pOiBNYXA8c3RyaW5nLCBudW1iZXI+IHtcbiAgY29uc3QgcmF0ZWQgPSBzY2VuZXNcbiAgICAubWFwKChzY2VuZSkgPT4gKHsgaWQ6IHNjZW5lLmlkLCBlbG86IGVsbyhzY2VuZSkgfSkpXG4gICAgLmZpbHRlcigocyk6IHMgaXMgeyBpZDogc3RyaW5nOyBlbG86IG51bWJlciB9ID0+IHMuZWxvICE9PSBudWxsKVxuICAgIC5zb3J0KChhLCBiKSA9PiBiLmVsbyAtIGEuZWxvKTtcblxuICBjb25zdCByYXRpbmdzID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgY29uc3QgbiA9IHJhdGVkLmxlbmd0aDtcbiAgaWYgKG4gPT09IDEpIHtcbiAgICByYXRpbmdzLnNldChyYXRlZFswXS5pZCwgNTApO1xuICAgIHJldHVybiByYXRpbmdzO1xuICB9XG5cbiAgbGV0IHN0YXJ0ID0gMDtcbiAgd2hpbGUgKHN0YXJ0IDwgbikge1xuICAgIGxldCBlbmQgPSBzdGFydDtcbiAgICB3aGlsZSAoZW5kICsgMSA8IG4gJiYgcmF0ZWRbZW5kICsgMV0uZWxvID09PSByYXRlZFtzdGFydF0uZWxvKSBlbmQrKztcbiAgICAvLyBSb3VuZGluZyBpbnNpZGUga2VlcHMgYSB0aWUgYXQgdGhlIGV4YWN0IG1pZGRsZSBvbiA1MCByYXRoZXIgdGhhbiA1MVxuICAgIGNvbnN0IHJhdGluZyA9IDEwMCAtIE1hdGgucm91bmQoKDk5ICogKChzdGFydCArIGVuZCkgLyAyKSkgLyAobiAtIDEpKTtcbiAgICBmb3IgKGxldCBpID0gc3RhcnQ7IGkgPD0gZW5kOyBpKyspIHJhdGluZ3Muc2V0KHJhdGVkW2ldLmlkLCByYXRpbmcpO1xuICAgIHN0YXJ0ID0gZW5kICsgMTtcbiAgfVxuICByZXR1cm4gcmF0aW5ncztcbn1cblxuLyoqIFRhcmdldCBTdGFzaCByYXRpbmcgZm9yIGV2ZXJ5IHNjZW5lIHdpdGggYW4gRUxPLCB1bmRlciB0aGUgZ2l2ZW4gbW9kZSAobm9uZSBmb3IgXCJvZmZcIikuICovXG5leHBvcnQgZnVuY3Rpb24gc3Rhc2hSYXRpbmdUYXJnZXRzKHNjZW5lczogU2NlbmVbXSwgbW9kZTogU3Rhc2hSYXRpbmdzTW9kZSk6IE1hcDxzdHJpbmcsIG51bWJlcj4ge1xuICBpZiAobW9kZSA9PT0gXCJwZXJjZW50aWxlXCIpIHJldHVybiBwZXJjZW50aWxlUmF0aW5ncyhzY2VuZXMpO1xuICBjb25zdCB0YXJnZXRzID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgaWYgKG1vZGUgPT09IFwibGluZWFyXCIpIHtcbiAgICBmb3IgKGNvbnN0IHNjZW5lIG9mIHNjZW5lcykge1xuICAgICAgY29uc3QgdmFsdWUgPSBlbG8oc2NlbmUpO1xuICAgICAgaWYgKHZhbHVlICE9PSBudWxsKSB0YXJnZXRzLnNldChzY2VuZS5pZCwgbGluZWFyUmF0aW5nKHZhbHVlKSk7XG4gICAgfVxuICB9XG4gIHJldHVybiB0YXJnZXRzO1xufVxuXG4vKiogVGhlIFN0YXNoIHJhdGluZ3MgYSBzeW5jIHdvdWxkIHdyaXRlOiBzY2VuZSBpZCB0byBuZXcgcmF0aW5nLCBvbmx5IHdoZXJlIGl0IGRpZmZlcnMgZnJvbSBub3cuICovXG5leHBvcnQgZnVuY3Rpb24gc3Rhc2hSYXRpbmdDaGFuZ2VzKHNjZW5lczogU2NlbmVbXSwgbW9kZTogU3Rhc2hSYXRpbmdzTW9kZSk6IE1hcDxzdHJpbmcsIG51bWJlcj4ge1xuICBjb25zdCBjdXJyZW50ID0gbmV3IE1hcChzY2VuZXMubWFwKChzY2VuZSkgPT4gW3NjZW5lLmlkLCBzY2VuZS5yYXRpbmcxMDAgPz8gbnVsbF0pKTtcbiAgY29uc3QgY2hhbmdlcyA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG4gIGZvciAoY29uc3QgW2lkLCByYXRpbmddIG9mIHN0YXNoUmF0aW5nVGFyZ2V0cyhzY2VuZXMsIG1vZGUpKSB7XG4gICAgaWYgKGN1cnJlbnQuZ2V0KGlkKSAhPT0gcmF0aW5nKSBjaGFuZ2VzLnNldChpZCwgcmF0aW5nKTtcbiAgfVxuICByZXR1cm4gY2hhbmdlcztcbn1cblxuLyoqXG4gKiBFTE8gYW5kIGdhbWVzIGEgc2NlbmUgZ2V0cyBmcm9tIHRoZSBvbmUtdGltZSBzZXR1cCwgb3IgbnVsbCB3aGVuIGl0IHN0YXJ0cyB1bnJhdGVkLlxuICogXCJyYXRpbmdzXCIgc2VlZHMgcmF0ZWQgc2NlbmVzIGZyb20gdGhlaXIgU3Rhc2ggcmF0aW5nOyBcImZyZXNoXCIgc3RhcnRzIGV2ZXJ5IHNjZW5lIGF0IDE1MDAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzdGFydGluZ0VsbyhzY2VuZTogU2NlbmUsIHN0YXJ0OiBFbG9TdGFydCk6IEVsb0ZpZWxkcyB8IG51bGwge1xuICBpZiAoc3RhcnQgPT09IFwiZnJlc2hcIikgcmV0dXJuIHsgZWxvOiBFTE9fU1RBUlQsIGJhdHRsZXM6IDAsIHNlZWRlZDogZmFsc2UgfTtcbiAgcmV0dXJuIHNjZW5lLnJhdGluZzEwMCAhPSBudWxsID8geyBlbG86IHNlZWQoc2NlbmUucmF0aW5nMTAwKSwgYmF0dGxlczogMCwgc2VlZGVkOiB0cnVlIH0gOiBudWxsO1xufVxuXG4vKiogQSBjb3B5IG9mIGEgY3VzdG9tIGZpZWxkcyBtYXAgd2l0aCB0aGUgRUxPIGZpZWxkcyBzZXQgdG8gYHZhbHVlYCAob3IsIHdpdGggbnVsbCwgcmVtb3ZlZCkuICovXG5leHBvcnQgZnVuY3Rpb24gd2l0aEVsb0ZpZWxkcyhjdXN0b21GaWVsZHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbCB8IHVuZGVmaW5lZCwgdmFsdWU6IEVsb0ZpZWxkcyB8IG51bGwpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gIGNvbnN0IGZpZWxkcyA9IHsgLi4uY3VzdG9tRmllbGRzIH07XG4gIGZvciAoY29uc3Qga2V5IG9mIEVMT19GSUVMRF9LRVlTKSBkZWxldGUgZmllbGRzW2tleV07XG4gIGlmICh2YWx1ZSkgT2JqZWN0LmFzc2lnbihmaWVsZHMsIGVsb0N1c3RvbUZpZWxkcyh2YWx1ZSkpO1xuICByZXR1cm4gZmllbGRzO1xufVxuXG4vKiogVGhlIHNjZW5lJ3MgRUxPIGZpZWxkcywgb3IgbnVsbCB3aGVuIGl0J3MgdW5yYXRlZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlbG9GaWVsZHMoc2NlbmU6IFNjZW5lKTogRWxvRmllbGRzIHwgbnVsbCB7XG4gIGNvbnN0IHZhbHVlID0gZWxvKHNjZW5lKTtcbiAgcmV0dXJuIHZhbHVlID09PSBudWxsID8gbnVsbCA6IHsgZWxvOiB2YWx1ZSwgYmF0dGxlczogYmF0dGxlcyhzY2VuZSksIHNlZWRlZDogaXNTZWVkZWQoc2NlbmUpIH07XG59XG5cbi8qKiBBIGNvcHkgb2YgdGhlIHNjZW5lIGFzIGl0IHdvdWxkIGJlIHJpZ2h0IGFmdGVyIHNldHVwIChpdHMgRUxPIGZpZWxkcyByZXBsYWNlZCkuICovXG5leHBvcnQgZnVuY3Rpb24gYWZ0ZXJTZXR1cChzY2VuZTogU2NlbmUsIHN0YXJ0OiBFbG9TdGFydCk6IFNjZW5lIHtcbiAgcmV0dXJuIHsgLi4uc2NlbmUsIGN1c3RvbV9maWVsZHM6IHdpdGhFbG9GaWVsZHMoc2NlbmUuY3VzdG9tX2ZpZWxkcywgc3RhcnRpbmdFbG8oc2NlbmUsIHN0YXJ0KSkgfTtcbn1cblxuLyoqIEhpZ2hlc3QgRUxPIGZpcnN0LCB1bnJhdGVkIHNjZW5lcyBsYXN0LiBFcXVhbCBFTE9zIGtlZXAgdGhlaXIgb3JkZXIgKEFycmF5LnNvcnQgaXMgc3RhYmxlKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb21wYXJlQnlFbG8oYTogU2NlbmUsIGI6IFNjZW5lKTogbnVtYmVyIHtcbiAgY29uc3QgZWxvQSA9IGVsbyhhKTtcbiAgY29uc3QgZWxvQiA9IGVsbyhiKTtcbiAgaWYgKGVsb0EgPT09IG51bGwpIHJldHVybiBlbG9CID09PSBudWxsID8gMCA6IDE7XG4gIGlmIChlbG9CID09PSBudWxsKSByZXR1cm4gLTE7XG4gIHJldHVybiBlbG9CIC0gZWxvQTtcbn1cblxuLyoqIFNvcnQgc2NlbmVzIGluIHBsYWNlIGJ5IEVMTyAoc2VlIGNvbXBhcmVCeUVsbykgYW5kIHJldHVybiB0aGUgc2FtZSBhcnJheS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzb3J0QnlFbG8oc2NlbmVzOiBTY2VuZVtdKTogU2NlbmVbXSB7XG4gIHJldHVybiBzY2VuZXMuc29ydChjb21wYXJlQnlFbG8pO1xufVxuXG4vKiogSW5kZXggd2hlcmUgYSBzY2VuZSB3aXRoIHRoaXMgRUxPIHdvdWxkIHNpdCBpbiBhbiBFTE8tc29ydGVkIHBvb2w6IGJlbG93IGV2ZXJ5IGVxdWFsIG9yIGhpZ2hlciBvbmUuICovXG5leHBvcnQgZnVuY3Rpb24gZWxvSW5zZXJ0aW9uSW5kZXgocG9vbDogU2NlbmVbXSwgZWxvVmFsdWU6IG51bWJlcik6IG51bWJlciB7XG4gIGNvbnN0IGlkeCA9IHBvb2wuZmluZEluZGV4KChzKSA9PiB7XG4gICAgY29uc3Qgb3RoZXIgPSBlbG8ocyk7XG4gICAgcmV0dXJuIG90aGVyID09PSBudWxsIHx8IG90aGVyIDwgZWxvVmFsdWU7XG4gIH0pO1xuICByZXR1cm4gaWR4ID09PSAtMSA/IHBvb2wubGVuZ3RoIDogaWR4O1xufVxuXG4vKipcbiAqIEluZGV4ZXMgb2YgdGhlIFN3aXNzIG9wcG9uZW50cyBmb3IgYSBzY2VuZSBhdCBgZWxvVmFsdWVgOiBldmVyeSBzY2VuZSBpbiB0aGUgcG9vbCB3aXRoaW5cbiAqIMKxYHdpbmRvd2AgRUxPICh1bnJhdGVkIG9uZXMgY291bnQgYXMgRUxPX1NUQVJULCBhcyBpbiBTd2lzcyBiYXR0bGVzKSwgb3IsIHdoZW4gdGhhdCdzIGZld2VyIHRoYW5cbiAqIGBtaW5Db3VudGAsIHRoZSBgbWluQ291bnRgIG5lYXJlc3QgYnkgRUxPIChwbHVzIGFueSB0aWVkIHdpdGggdGhlIGxhc3Qgb2YgdGhlbSkuIFRoZSBzY2VuZVxuICogaXRzZWxmIChgZXhjbHVkZUlkYCkgaXMgbmV2ZXIgb25lLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc3dpc3NPcHBvbmVudEluZGV4ZXMoXG4gIHBvb2w6IFNjZW5lW10sXG4gIGVsb1ZhbHVlOiBudW1iZXIsXG4gIGV4Y2x1ZGVJZDogc3RyaW5nLFxuICB3aW5kb3c6IG51bWJlcixcbiAgbWluQ291bnQ6IG51bWJlcixcbik6IG51bWJlcltdIHtcbiAgY29uc3Qgb3RoZXJzID0gcG9vbFxuICAgIC5tYXAoKHNjZW5lLCBpZHgpID0+ICh7IGlkeCwgZ2FwOiBNYXRoLmFicyhlZmZlY3RpdmVFbG8oc2NlbmUpIC0gZWxvVmFsdWUpLCBpZDogc2NlbmUuaWQgfSkpXG4gICAgLmZpbHRlcigocykgPT4gcy5pZCAhPT0gZXhjbHVkZUlkKTtcbiAgY29uc3QgaW5XaW5kb3cgPSBvdGhlcnMuZmlsdGVyKChzKSA9PiBzLmdhcCA8PSB3aW5kb3cpO1xuICBpZiAoaW5XaW5kb3cubGVuZ3RoID49IG1pbkNvdW50IHx8IGluV2luZG93Lmxlbmd0aCA9PT0gb3RoZXJzLmxlbmd0aCkgcmV0dXJuIGluV2luZG93Lm1hcCgocykgPT4gcy5pZHgpO1xuICBjb25zdCBieUdhcCA9IFsuLi5vdGhlcnNdLnNvcnQoKGEsIGIpID0+IGEuZ2FwIC0gYi5nYXApO1xuICBjb25zdCBjdXRvZmYgPSBieUdhcFtNYXRoLm1pbihtaW5Db3VudCwgYnlHYXAubGVuZ3RoKSAtIDFdLmdhcDtcbiAgcmV0dXJuIGJ5R2FwLmZpbHRlcigocykgPT4gcy5nYXAgPD0gY3V0b2ZmKS5tYXAoKHMpID0+IHMuaWR4KS5zb3J0KChhLCBiKSA9PiBhIC0gYik7XG59XG5cbi8qKlxuICogRUxPIGZvciBhIHNjZW5lIFBsYWNlbWVudCBsYW5kcyBiZXR3ZWVuIHR3byBuZWlnaGJvdXJzIChudWxsIHdoZXJlIHRoZXJlJ3Mgbm9uZSwgb3IgdGhlXG4gKiBuZWlnaGJvdXIgaXMgdW5yYXRlZCk6IHRoZWlyIG1pZHBvaW50LCBvciBQTEFDRU1FTlRfRURHRV9HQVAgYmV5b25kIHRoZSBvbmx5IG9uZSBhdCBhbiBlZGdlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGxhY2VtZW50RWxvKGFib3ZlRWxvOiBudW1iZXIgfCBudWxsLCBiZWxvd0VsbzogbnVtYmVyIHwgbnVsbCk6IG51bWJlciB7XG4gIGlmIChhYm92ZUVsbyA9PT0gbnVsbCAmJiBiZWxvd0VsbyA9PT0gbnVsbCkgcmV0dXJuIEVMT19TVEFSVDtcbiAgaWYgKGFib3ZlRWxvID09PSBudWxsKSByZXR1cm4gcm91bmRFbG8oKGJlbG93RWxvIGFzIG51bWJlcikgKyBQTEFDRU1FTlRfRURHRV9HQVApO1xuICBpZiAoYmVsb3dFbG8gPT09IG51bGwpIHJldHVybiByb3VuZEVsbyhhYm92ZUVsbyAtIFBMQUNFTUVOVF9FREdFX0dBUCk7XG4gIC8vIE5laWdoYm91cnMgMC4xIGFwYXJ0IChvciB0aWVkKSBoYXZlIG5vIHJvb20gYmV0d2VlbiB0aGVtOiB0YWtlIHRoZSB1cHBlciBvbmUncyBFTE8sIHdoaWNoXG4gIC8vIHN0aWxsIHNvcnRzIHRoZSBzY2VuZSBiZWxvdyBpdCAoZXF1YWwgRUxPcyBnbyBiZWxvdykgYW5kIHNvIGluIHRoZSBzYW1lIHNsb3RcbiAgY29uc3QgbWlkID0gcm91bmRFbG8oKGFib3ZlRWxvICsgYmVsb3dFbG8pIC8gMik7XG4gIHJldHVybiBtaWQgPiBiZWxvd0VsbyA/IG1pZCA6IGFib3ZlRWxvO1xufVxuIiwgIi8vIEdyYXBoUUwgYWNjZXNzIGFnYWluc3QgdGhlIFN0YXNoIGJhY2tlbmQuXG5cbmltcG9ydCB0eXBlIHsgQXBvbGxvQ2FjaGVMaWtlIH0gZnJvbSBcIi4vcGx1Z2luQXBpXCI7XG5pbXBvcnQgeyB3aXRoRWxvRmllbGRzIH0gZnJvbSBcIi4vc2NvcmVcIjtcbmltcG9ydCB0eXBlIHsgRWxvRmllbGRzLCBGaW5kU2NlbmVSZXN1bHQsIFNjZW5lIH0gZnJvbSBcIi4vdHlwZXNcIjtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdyYXBocWxRdWVyeTxUID0gdW5rbm93bj4oXG4gIHF1ZXJ5OiBzdHJpbmcsXG4gIHZhcmlhYmxlczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fSxcbik6IFByb21pc2U8VD4ge1xuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKFwiL2dyYXBocWxcIiwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgaGVhZGVyczoge1xuICAgICAgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIsXG4gICAgfSxcbiAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IHF1ZXJ5LCB2YXJpYWJsZXMgfSksXG4gIH0pO1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXNwb25zZS5qc29uKCk7XG4gIGlmIChyZXN1bHQuZXJyb3JzKSB7XG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIEdyYXBoUUwgZXJyb3I6XCIsIHJlc3VsdC5lcnJvcnMpO1xuICAgIHRocm93IG5ldyBFcnJvcihyZXN1bHQuZXJyb3JzWzBdLm1lc3NhZ2UpO1xuICB9XG4gIHJldHVybiByZXN1bHQuZGF0YSBhcyBUO1xufVxuXG5leHBvcnQgY29uc3QgU0NFTkVfRlJBR01FTlQgPSBgXG4gICAgaWRcbiAgICB0aXRsZVxuICAgIGRhdGVcbiAgICByYXRpbmcxMDBcbiAgICBwbGF5X2NvdW50XG4gICAgY3VzdG9tX2ZpZWxkc1xuICAgIHBhdGhzIHtcbiAgICAgIHNjcmVlbnNob3RcbiAgICAgIHByZXZpZXdcbiAgICB9XG4gICAgZmlsZXMge1xuICAgICAgZHVyYXRpb25cbiAgICAgIHBhdGhcbiAgICB9XG4gICAgc3R1ZGlvIHtcbiAgICAgIG5hbWVcbiAgICB9XG4gICAgcGVyZm9ybWVycyB7XG4gICAgICBuYW1lXG4gICAgfVxuICAgIHRhZ3Mge1xuICAgICAgbmFtZVxuICAgIH1cbiAgYDtcblxuZXhwb3J0IGNvbnN0IEZJTkRfU0NFTkVTX1FVRVJZID0gYFxuICAgICAgcXVlcnkgRmluZFNjZW5lc0J5UmF0aW5nKCRmaWx0ZXI6IEZpbmRGaWx0ZXJUeXBlLCAkc2NlbmVfZmlsdGVyOiBTY2VuZUZpbHRlclR5cGUpIHtcbiAgICAgICAgZmluZFNjZW5lcyhmaWx0ZXI6ICRmaWx0ZXIsIHNjZW5lX2ZpbHRlcjogJHNjZW5lX2ZpbHRlcikge1xuICAgICAgICAgIGNvdW50XG4gICAgICAgICAgc2NlbmVzIHtcbiAgICAgICAgICAgICR7U0NFTkVfRlJBR01FTlR9XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgYDtcblxubGV0IGN1c3RvbUZpZWxkc1N1cHBvcnQ6IFByb21pc2U8Ym9vbGVhbj4gfCBudWxsID0gbnVsbDtcblxuLyoqXG4gKiBXaGV0aGVyIHRoaXMgU3Rhc2ggaGFzIHNjZW5lIGN1c3RvbSBmaWVsZHMgKG5lZWRlZCBmb3IgRUxPIHN0b3JhZ2UpLiBDaGVja2VkIG9uY2UgcGVyIHBhZ2VcbiAqIGxvYWQgdmlhIGludHJvc3BlY3Rpb247IGlmIGludHJvc3BlY3Rpb24gaXRzZWxmIGZhaWxzLCBhc3N1bWUgeWVzIGFuZCBsZXQgcmVhbCBxdWVyaWVzIHJlcG9ydC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNjZW5lQ3VzdG9tRmllbGRzU3VwcG9ydGVkKCk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBjdXN0b21GaWVsZHNTdXBwb3J0ID8/PSBncmFwaHFsUXVlcnk8eyBfX3R5cGU6IHsgZmllbGRzOiB7IG5hbWU6IHN0cmluZyB9W10gfSB8IG51bGwgfT4oXG4gICAgYHF1ZXJ5IHsgX190eXBlKG5hbWU6IFwiU2NlbmVcIikgeyBmaWVsZHMgeyBuYW1lIH0gfSB9YCxcbiAgKVxuICAgIC50aGVuKChkYXRhKSA9PiBkYXRhLl9fdHlwZT8uZmllbGRzLnNvbWUoKGYpID0+IGYubmFtZSA9PT0gXCJjdXN0b21fZmllbGRzXCIpID8/IHRydWUpXG4gICAgLmNhdGNoKChlKSA9PiB7XG4gICAgICBjb25zb2xlLndhcm4oXCJbU3Rhc2ggQmF0dGxlXSBDb3VsZCBub3QgY2hlY2sgZm9yIHNjZW5lIGN1c3RvbSBmaWVsZHM6XCIsIGUpO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfSk7XG4gIHJldHVybiBjdXN0b21GaWVsZHNTdXBwb3J0O1xufVxuXG4vKiogQSBjaGFuZ2UgU3Rhc2ggQmF0dGxlIHdyb3RlIHRvIGEgc2NlbmUsIHRvIG1pcnJvciBpbnRvIFN0YXNoJ3Mgb3duIHBhZ2UgY2FjaGUuICovXG5leHBvcnQgaW50ZXJmYWNlIFN0YXNoQ2FjaGVVcGRhdGUge1xuICBpZDogc3RyaW5nO1xuICByYXRpbmcxMDA/OiBudW1iZXI7XG4gIC8qKiBOZXcgRUxPIGZpZWxkcywgb3IgbnVsbCB3aGVuIHRoZXkgd2VyZSByZW1vdmVkLiAqL1xuICBlbG8/OiBFbG9GaWVsZHMgfCBudWxsO1xufVxuXG5mdW5jdGlvbiBzdGFzaEFwb2xsb0NhY2hlKCk6IEFwb2xsb0NhY2hlTGlrZSB8IHVuZGVmaW5lZCB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIHdpbmRvdy5QbHVnaW5BcGk/LnV0aWxzPy5TdGFzaFNlcnZpY2U/LmdldENsaWVudD8uKCk/LmNhY2hlO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG59XG5cbi8qKiBXaGlsZSBTdGFzaCBCYXR0bGUgaXMgb3BlbiwgU3Rhc2gncyBjYWNoZWQgc2NlbmUgbGlzdHMgYXJlIGRyb3BwZWQgb25jZSBvbiBjbG9zZSwgbm90IGV2ZXJ5IGJhdHRsZS4gKi9cbmxldCBob2xkTGlzdFJlZnJlc2ggPSBmYWxzZTtcbmxldCBsaXN0c1N0YWxlID0gZmFsc2U7XG5cbi8qKiBEcm9wIFN0YXNoJ3MgY2FjaGVkIHNjZW5lIGxpc3RzICh0aGV5IHJlZmV0Y2gpLCBzbyByYXRpbmctc29ydGVkIGxpc3RzIHJlLXNvcnQuICovXG5mdW5jdGlvbiBkcm9wU3Rhc2hMaXN0cyhjYWNoZTogQXBvbGxvQ2FjaGVMaWtlIHwgdW5kZWZpbmVkID0gc3Rhc2hBcG9sbG9DYWNoZSgpKTogdm9pZCB7XG4gIGxpc3RzU3RhbGUgPSBmYWxzZTtcbiAgaWYgKCFjYWNoZSkgcmV0dXJuO1xuICB0cnkge1xuICAgIGNhY2hlLmV2aWN0KHsgaWQ6IFwiUk9PVF9RVUVSWVwiLCBmaWVsZE5hbWU6IFwiZmluZFNjZW5lc1wiIH0pO1xuICAgIGNhY2hlLmdjKCk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zb2xlLndhcm4oXCJbU3Rhc2ggQmF0dGxlXSBDb3VsZCBub3QgcmVmcmVzaCBTdGFzaCdzIHNjZW5lIGxpc3RzOlwiLCBlKTtcbiAgfVxufVxuXG4vKipcbiAqIEhvbGQgYmFjayBkcm9wcGluZyBTdGFzaCdzIHNjZW5lIGxpc3RzIHdoaWxlIFN0YXNoIEJhdHRsZSBpcyBvcGVuICh0cnVlKTsgcmVsZWFzaW5nIGl0IChmYWxzZSlcbiAqIGRyb3BzIHRoZW0gb25jZSBpZiByYXRpbmdzIGNoYW5nZWQgbWVhbndoaWxlLiBUaGUgcGFnZXMgYmVoaW5kIHRoZSBtb2RhbCBjYW4gd2FpdCwgYW5kIGEgZHJvcFxuICogcGVyIGJhdHRsZSB3b3VsZCByZWZldGNoIGV2ZXJ5IGxpc3QgZWFjaCBwaWNrLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaG9sZFN0YXNoTGlzdFJlZnJlc2goaG9sZDogYm9vbGVhbik6IHZvaWQge1xuICBob2xkTGlzdFJlZnJlc2ggPSBob2xkO1xuICBpZiAoIWhvbGQgJiYgbGlzdHNTdGFsZSkgZHJvcFN0YXNoTGlzdHMoKTtcbn1cblxuLyoqXG4gKiBTdGFzaCBCYXR0bGUgd3JpdGVzIHdpdGggcGxhaW4gZmV0Y2gsIHNvIFN0YXNoJ3Mgb3duIHBhZ2VzIChBcG9sbG8pIG5ldmVyIHNlZSB0aGUgY2hhbmdlcyBhbmRcbiAqIGtlZXAgc2hvd2luZyBvbGQgcmF0aW5ncyB1bnRpbCByZWZyZXNoZWQuIE1pcnJvciB0aGUgY2hhbmdlcyBpbnRvIEFwb2xsbydzIGNhY2hlZCBzY2VuZXMsIGFuZFxuICogd2hlbiByYXRpbmdzIGNoYW5nZWQsIGRyb3AgY2FjaGVkIHNjZW5lIGxpc3RzIHNvIHJhdGluZy1zb3J0ZWQgbGlzdHMgcmUtc29ydCAoaGVsZCBiYWNrIHdoaWxlXG4gKiBTdGFzaCBCYXR0bGUgaXMgb3Blbiwgc2VlIGhvbGRTdGFzaExpc3RSZWZyZXNoKS4gRG9lcyBub3RoaW5nIGlmIFN0YXNoIGRvZXNuJ3QgZXhwb3NlIGl0cyBjbGllbnQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWZyZXNoU3Rhc2hDYWNoZSh1cGRhdGVzOiBTdGFzaENhY2hlVXBkYXRlW10sIHJhdGluZ3NDaGFuZ2VkOiBib29sZWFuKTogdm9pZCB7XG4gIGNvbnN0IGNhY2hlID0gc3Rhc2hBcG9sbG9DYWNoZSgpO1xuICBpZiAoIWNhY2hlKSByZXR1cm47XG4gIHRyeSB7XG4gICAgZm9yIChjb25zdCB1cGRhdGUgb2YgdXBkYXRlcykge1xuICAgICAgY29uc3QgaWQgPSBjYWNoZS5pZGVudGlmeSh7IF9fdHlwZW5hbWU6IFwiU2NlbmVcIiwgaWQ6IHVwZGF0ZS5pZCB9KTtcbiAgICAgIGlmICghaWQpIGNvbnRpbnVlO1xuICAgICAgY29uc3QgZmllbGRzOiBSZWNvcmQ8c3RyaW5nLCAoZXhpc3Rpbmc6IHVua25vd24pID0+IHVua25vd24+ID0ge307XG4gICAgICBpZiAodXBkYXRlLnJhdGluZzEwMCAhPT0gdW5kZWZpbmVkKSBmaWVsZHMucmF0aW5nMTAwID0gKCkgPT4gdXBkYXRlLnJhdGluZzEwMDtcbiAgICAgIGlmICh1cGRhdGUuZWxvICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgY29uc3QgdmFsdWUgPSB1cGRhdGUuZWxvO1xuICAgICAgICBmaWVsZHMuY3VzdG9tX2ZpZWxkcyA9IChleGlzdGluZykgPT4gd2l0aEVsb0ZpZWxkcyhleGlzdGluZyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IG51bGwsIHZhbHVlKTtcbiAgICAgIH1cbiAgICAgIC8vIEFwb2xsbyBvbmx5IGNhbGxzIG1vZGlmaWVycyBmb3IgZmllbGRzIGl0IGhhcyBjYWNoZWQsIHNvIG1pc3Npbmcgb25lcyBhcmUgc2tpcHBlZFxuICAgICAgY2FjaGUubW9kaWZ5KHsgaWQsIGZpZWxkcyB9KTtcbiAgICB9XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zb2xlLndhcm4oXCJbU3Rhc2ggQmF0dGxlXSBDb3VsZCBub3QgdXBkYXRlIFN0YXNoJ3MgcGFnZSBjYWNoZTpcIiwgZSk7XG4gIH1cbiAgaWYgKHJhdGluZ3NDaGFuZ2VkKSB7XG4gICAgbGlzdHNTdGFsZSA9IHRydWU7XG4gICAgaWYgKCFob2xkTGlzdFJlZnJlc2gpIGRyb3BTdGFzaExpc3RzKGNhY2hlKTtcbiAgfVxufVxuXG4vLyBFeHRyYWN0IHNjZW5lIElEIGZyb20gaW5kaXZpZHVhbCBzY2VuZSBwYWdlcyBsaWtlIC9zY2VuZXMvMTIzXG5leHBvcnQgZnVuY3Rpb24gZ2V0U2NlbmVJZEZyb21VcmwoKTogc3RyaW5nIHwgbnVsbCB7XG4gIGNvbnN0IG1hdGNoID0gd2luZG93LmxvY2F0aW9uLnBhdGhuYW1lLm1hdGNoKC9eXFwvc2NlbmVzXFwvKFxcZCspJC8pO1xuICByZXR1cm4gbWF0Y2ggPyBtYXRjaFsxXSA6IG51bGw7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBmZXRjaFNjZW5lQnlJZChzY2VuZUlkOiBzdHJpbmcpOiBQcm9taXNlPFNjZW5lIHwgbnVsbD4ge1xuICBjb25zdCBxdWVyeSA9IGBcbiAgICAgIHF1ZXJ5IEZpbmRTY2VuZSgkaWQ6IElEISkge1xuICAgICAgICBmaW5kU2NlbmUoaWQ6ICRpZCkge1xuICAgICAgICAgICR7U0NFTkVfRlJBR01FTlR9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICBgO1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCBncmFwaHFsUXVlcnk8RmluZFNjZW5lUmVzdWx0PihxdWVyeSwgeyBpZDogc2NlbmVJZCB9KTtcbiAgcmV0dXJuIHJlc3VsdC5maW5kU2NlbmU7XG59XG4iLCAiLy8gQ2xlYW4gbW9kZTogb3BlbiBTdGFzaCdzIG93biBEZWxldGVTY2VuZXNEaWFsb2csIHNvIGRlbGV0aW5nIGZyb20gYSBiYXR0bGUgYmVoYXZlcyBleGFjdGx5IGxpa2VcclxuLy8gZGVsZXRpbmcgaW4gU3Rhc2ggKHNhbWUgb3B0aW9ucyBhbmQgZGVmYXVsdHMsIGZpbGUgbGlzdCwgZGVsZXRlIGNhbGwgYW5kIHRvYXN0KS5cclxuLy9cclxuLy8gVGhlIGRpYWxvZyBuZWVkcyBTdGFzaCdzIFJlYWN0IGNvbnRleHQgKGludGwsIGNvbmZpZ3VyYXRpb24sIEFwb2xsbywgdG9hc3RzKSwgc28gaXQgY2FuJ3QgYmVcclxuLy8gcmVuZGVyZWQgc3RhbmRhbG9uZS4gSW5zdGVhZCBhIHNtYWxsIGJyaWRnZSBjb21wb25lbnQgaXMgcGF0Y2hlZCBpbnRvIFN0YXNoJ3MgbmF2YmFyIChhbHdheXNcclxuLy8gbW91bnRlZCkgYW5kIG9wZW5zIHRoZSBkaWFsb2cgd2hlbiBCYXR0bGUgYXNrcyBmb3IgaXQuIHJlYWN0LWJvb3RzdHJhcCBwb3J0YWxzIHRoZSBtb2RhbCB0b1xyXG4vLyA8Ym9keT47IENTUyBsaWZ0cyBpdCBhYm92ZSB0aGUgYmF0dGxlIG1vZGFsIHdoaWxlIEJhdHRsZSBpcyBvcGVuLlxyXG5cclxuaW1wb3J0IHsgZ3JhcGhxbFF1ZXJ5IH0gZnJvbSBcIi4uL2dyYXBocWxcIjtcclxuaW1wb3J0IHR5cGUgeyBSZWFjdE5vZGUgfSBmcm9tIFwiLi4vcGx1Z2luQXBpXCI7XHJcbmltcG9ydCB0eXBlIHsgU2NlbmUgfSBmcm9tIFwiLi4vdHlwZXNcIjtcclxuXHJcbi8qKiBTY2VuZSBmaWVsZHMgRGVsZXRlU2NlbmVzRGlhbG9nIHJlYWRzIChmaWxlIGxpc3QsIGZ1bnNjcmlwdCwgbXV0YXRpb24gaWRzKS4gKi9cclxuaW50ZXJmYWNlIERlbGV0YWJsZVNjZW5lIHtcclxuICBpZDogc3RyaW5nO1xyXG4gIHRpdGxlOiBzdHJpbmcgfCBudWxsO1xyXG4gIGludGVyYWN0aXZlOiBib29sZWFuO1xyXG4gIGZpbGVzOiB7IHBhdGg6IHN0cmluZyB9W107XHJcbn1cclxuXHJcbmNvbnN0IE9QRU5fRVZFTlQgPSBcInN0YXNoLWJhdHRsZTpvcGVuLWRlbGV0ZS1kaWFsb2dcIjtcclxuY29uc3QgQ0xPU0VfRVZFTlQgPSBcInN0YXNoLWJhdHRsZTpjbG9zZS1kZWxldGUtZGlhbG9nXCI7XHJcblxyXG5sZXQgYnJpZGdlUmVnaXN0ZXJlZCA9IGZhbHNlO1xyXG5sZXQgcGVuZGluZ1Jlc3VsdDogKChkZWxldGVkOiBib29sZWFuKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xyXG4vKiogU3Rhc2gncyBEZWxldGVTY2VuZXNEaWFsb2cgY29tcG9uZW50LCBvbmNlIGl0cyBjaHVuayBoYXMgbG9hZGVkLiAqL1xyXG5sZXQgRGVsZXRlU2NlbmVzRGlhbG9nOiB1bmtub3duID0gbnVsbDtcclxubGV0IGRpYWxvZ0xvYWRlZDogUHJvbWlzZTx2b2lkPiA9IFByb21pc2UucmVzb2x2ZSgpO1xyXG5cclxuZnVuY3Rpb24gc2V0dGxlKGRlbGV0ZWQ6IGJvb2xlYW4pOiB2b2lkIHtcclxuICBjb25zdCByZXNvbHZlID0gcGVuZGluZ1Jlc3VsdDtcclxuICBwZW5kaW5nUmVzdWx0ID0gbnVsbDtcclxuICByZXNvbHZlPy4oZGVsZXRlZCk7XHJcbn1cclxuXHJcbi8qKiBUcnVlIHdoZW4gdGhpcyBTdGFzaCBleHBvc2VzIGl0cyBkZWxldGUgZGlhbG9nIHRvIHBsdWdpbnMgKENsZWFuIG1vZGUgZGVwZW5kcyBvbiBpdCkuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBpc1N0YXNoRGVsZXRlRGlhbG9nQXZhaWxhYmxlKCk6IGJvb2xlYW4ge1xyXG4gIHJldHVybiBicmlkZ2VSZWdpc3RlcmVkO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gaXNEZWxldGVEaWFsb2dPcGVuKCk6IGJvb2xlYW4ge1xyXG4gIHJldHVybiBwZW5kaW5nUmVzdWx0ICE9PSBudWxsO1xyXG59XHJcblxyXG4vKiogQ2xvc2UgdGhlIGRpYWxvZyB3aXRob3V0IGRlbGV0aW5nIChlLmcuIHdoZW4gdGhlIGJhdHRsZSBtb2RhbCBjbG9zZXMpLiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gY2FuY2VsRGVsZXRlRGlhbG9nKCk6IHZvaWQge1xyXG4gIGlmICghcGVuZGluZ1Jlc3VsdCkgcmV0dXJuO1xyXG4gIHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBDdXN0b21FdmVudChDTE9TRV9FVkVOVCkpO1xyXG4gIHNldHRsZShmYWxzZSk7XHJcbn1cclxuXHJcbi8qKiBQYXRjaCB0aGUgYnJpZGdlIGludG8gU3Rhc2gncyBuYXZiYXIuIENhbGwgb25jZSBhdCBzdGFydHVwLCBiZWZvcmUgdGhlIG5hdmJhciByZW5kZXJzLiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gcmVnaXN0ZXJEZWxldGVEaWFsb2dCcmlkZ2UoKTogdm9pZCB7XHJcbiAgY29uc3QgYXBpID0gd2luZG93LlBsdWdpbkFwaTtcclxuICBpZiAoYnJpZGdlUmVnaXN0ZXJlZCB8fCAhYXBpPy5sb2FkYWJsZUNvbXBvbmVudHM/LkRlbGV0ZVNjZW5lc0RpYWxvZykge1xyXG4gICAgaWYgKCFhcGk/LmxvYWRhYmxlQ29tcG9uZW50cz8uRGVsZXRlU2NlbmVzRGlhbG9nKSB7XHJcbiAgICAgIGNvbnNvbGUud2FybihcIltTdGFzaCBCYXR0bGVdIFN0YXNoJ3MgZGVsZXRlIGRpYWxvZyBpc24ndCBhdmFpbGFibGUgdG8gcGx1Z2luczsgQ2xlYW4gbW9kZSBpcyBkaXNhYmxlZFwiKTtcclxuICAgIH1cclxuICAgIHJldHVybjtcclxuICB9XHJcbiAgYnJpZGdlUmVnaXN0ZXJlZCA9IHRydWU7XHJcbiAgY29uc3QgeyBSZWFjdCB9ID0gYXBpO1xyXG5cclxuICAvLyBMb2FkIHRoZSBkaWFsb2cncyBjaHVuayB1cCBmcm9udCBzbyBpdCBvcGVucyBpbnN0YW50bHlcclxuICBkaWFsb2dMb2FkZWQgPSBhcGkubG9hZGFibGVDb21wb25lbnRzXHJcbiAgICAuRGVsZXRlU2NlbmVzRGlhbG9nKClcclxuICAgIC50aGVuKChtb2QpID0+IHtcclxuICAgICAgRGVsZXRlU2NlbmVzRGlhbG9nID0gbW9kLkRlbGV0ZVNjZW5lc0RpYWxvZyA/PyBtb2QuZGVmYXVsdCA/PyBudWxsO1xyXG4gICAgfSlcclxuICAgIC5jYXRjaCgoZSkgPT4gY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIEZhaWxlZCB0byBsb2FkIFN0YXNoJ3MgZGVsZXRlIGRpYWxvZzpcIiwgZSkpO1xyXG5cclxuICBmdW5jdGlvbiBEZWxldGVCcmlkZ2UoKTogUmVhY3ROb2RlIHtcclxuICAgIGNvbnN0IFtzY2VuZSwgc2V0U2NlbmVdID0gUmVhY3QudXNlU3RhdGU8RGVsZXRhYmxlU2NlbmUgfCBudWxsPihudWxsKTtcclxuXHJcbiAgICBSZWFjdC51c2VFZmZlY3QoKCkgPT4ge1xyXG4gICAgICBjb25zdCBvcGVuID0gKGU6IEV2ZW50KTogdm9pZCA9PiB7XHJcbiAgICAgICAgLy8gVGhlIG5hdmJhciBjYW4gcmVuZGVyIG1vcmUgdGhhbiBvbmNlOyB0aGUgZmlyc3QgYnJpZGdlIHRvIGhlYXIgdGhlIGV2ZW50IGhhbmRsZXMgaXQuXHJcbiAgICAgICAgLy8gcHJldmVudERlZmF1bHQgdGVsbHMgY29uZmlybURlbGV0ZVNjZW5lIHRoZSByZXF1ZXN0IHdhcyBwaWNrZWQgdXAuXHJcbiAgICAgICAgZS5zdG9wSW1tZWRpYXRlUHJvcGFnYXRpb24oKTtcclxuICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7XHJcbiAgICAgICAgc2V0U2NlbmUoKGUgYXMgQ3VzdG9tRXZlbnQ8RGVsZXRhYmxlU2NlbmU+KS5kZXRhaWwpO1xyXG4gICAgICB9O1xyXG4gICAgICBjb25zdCBjbG9zZSA9ICgpOiB2b2lkID0+IHNldFNjZW5lKG51bGwpO1xyXG4gICAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcihPUEVOX0VWRU5ULCBvcGVuKTtcclxuICAgICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoQ0xPU0VfRVZFTlQsIGNsb3NlKTtcclxuICAgICAgcmV0dXJuICgpID0+IHtcclxuICAgICAgICB3aW5kb3cucmVtb3ZlRXZlbnRMaXN0ZW5lcihPUEVOX0VWRU5ULCBvcGVuKTtcclxuICAgICAgICB3aW5kb3cucmVtb3ZlRXZlbnRMaXN0ZW5lcihDTE9TRV9FVkVOVCwgY2xvc2UpO1xyXG4gICAgICB9O1xyXG4gICAgfSwgW10pO1xyXG5cclxuICAgIGlmICghc2NlbmUgfHwgIURlbGV0ZVNjZW5lc0RpYWxvZykgcmV0dXJuIG51bGw7XHJcbiAgICByZXR1cm4gUmVhY3QuY3JlYXRlRWxlbWVudChEZWxldGVTY2VuZXNEaWFsb2csIHtcclxuICAgICAgc2VsZWN0ZWQ6IFtzY2VuZV0sXHJcbiAgICAgIG9uQ2xvc2U6IChkZWxldGVkOiBib29sZWFuKSA9PiB7XHJcbiAgICAgICAgc2V0U2NlbmUobnVsbCk7XHJcbiAgICAgICAgc2V0dGxlKGRlbGV0ZWQpO1xyXG4gICAgICB9LFxyXG4gICAgfSk7XHJcbiAgfVxyXG5cclxuICAvLyBTdGFzaCBhcHBlbmRzIHRoZSByZW5kZXJlZCByZXN1bHQgYWZ0ZXIgdGhlIGNhbGwncyBhcmdzLCBhbmQgYW5vdGhlciBwbHVnaW4ncyBgYmVmb3JlYCBwYXRjaFxyXG4gIC8vIGNhbiBjaGFuZ2UgaG93IG1hbnkgYXJncyB0aGVyZSBhcmUsIHNvIHRoZSByZXN1bHQgaXMgYWx3YXlzIHRoZSBsYXN0IG9uZSwgbm90IGEgZml4ZWQgc2xvdC5cclxuICBhcGkucGF0Y2guYWZ0ZXIoXCJNYWluTmF2QmFyLlV0aWxpdHlJdGVtc1wiLCAoLi4uYXJnczogdW5rbm93bltdKSA9PlxyXG4gICAgUmVhY3QuY3JlYXRlRWxlbWVudChcclxuICAgICAgUmVhY3QuRnJhZ21lbnQsXHJcbiAgICAgIG51bGwsXHJcbiAgICAgIGFyZ3NbYXJncy5sZW5ndGggLSAxXSBhcyBSZWFjdE5vZGUsXHJcbiAgICAgIFJlYWN0LmNyZWF0ZUVsZW1lbnQoRGVsZXRlQnJpZGdlKSxcclxuICAgICksXHJcbiAgKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIE9wZW4gU3Rhc2gncyBkZWxldGUgZGlhbG9nIGZvciBgc2NlbmVgLiBSZXNvbHZlcyB0cnVlIG9uY2UgU3Rhc2ggaGFzIGRlbGV0ZWQgaXQsIGZhbHNlIGlmIHRoZVxyXG4gKiB1c2VyIGNhbmNlbGxlZCAob3IgdGhlIGRlbGV0ZSBmYWlsZWQg4oCUIFN0YXNoIHNob3dzIGl0cyBvd24gZXJyb3IgdG9hc3QpLlxyXG4gKi9cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNvbmZpcm1EZWxldGVTY2VuZShzY2VuZTogU2NlbmUpOiBQcm9taXNlPGJvb2xlYW4+IHtcclxuICBpZiAoIWJyaWRnZVJlZ2lzdGVyZWQpIHJldHVybiBmYWxzZTtcclxuICBjYW5jZWxEZWxldGVEaWFsb2coKTtcclxuICBhd2FpdCBkaWFsb2dMb2FkZWQ7XHJcbiAgaWYgKCFEZWxldGVTY2VuZXNEaWFsb2cpIHJldHVybiBmYWxzZTtcclxuXHJcbiAgY29uc3QgeyBmaW5kU2NlbmUgfSA9IGF3YWl0IGdyYXBocWxRdWVyeTx7IGZpbmRTY2VuZTogRGVsZXRhYmxlU2NlbmUgfCBudWxsIH0+KFxyXG4gICAgYHF1ZXJ5IEJhdHRsZURlbGV0YWJsZVNjZW5lKCRpZDogSUQhKSB7IGZpbmRTY2VuZShpZDogJGlkKSB7IGlkIHRpdGxlIGludGVyYWN0aXZlIGZpbGVzIHsgcGF0aCB9IH0gfWAsXHJcbiAgICB7IGlkOiBzY2VuZS5pZCB9LFxyXG4gICk7XHJcbiAgaWYgKCFmaW5kU2NlbmUpIHJldHVybiBmYWxzZTtcclxuXHJcbiAgY29uc3QgcmVzdWx0ID0gbmV3IFByb21pc2U8Ym9vbGVhbj4oKHJlc29sdmUpID0+IHtcclxuICAgIHBlbmRpbmdSZXN1bHQgPSByZXNvbHZlO1xyXG4gIH0pO1xyXG5cclxuICAvLyBTdGFzaCByZW5kZXJzIHRoZSBuYXZiYXIgYWZ0ZXIgcGx1Z2lucyBsb2FkLCBzbyB0aGUgYnJpZGdlIGlzIG1vdW50ZWQgd2VsbCBiZWZvcmUgYW55b25lIGNhblxyXG4gIC8vIGNsaWNrIGEgZGVsZXRlIGJ1dHRvbjsgaWYgaXQgc29tZWhvdyBpc24ndCwgc2F5IHNvIHJhdGhlciB0aGFuIGZha2luZyBhIG5hdmlnYXRpb25cclxuICBpZiAoIXJlcXVlc3REaWFsb2coZmluZFNjZW5lKSkge1xyXG4gICAgY29uc29sZS53YXJuKFwiW1N0YXNoIEJhdHRsZV0gU3Rhc2gncyBkZWxldGUgZGlhbG9nIGJyaWRnZSBpc24ndCBtb3VudGVkXCIpO1xyXG4gICAgc2V0dGxlKGZhbHNlKTtcclxuICAgIHdpbmRvdy5hbGVydChcIkNvdWxkbid0IG9wZW4gU3Rhc2gncyBkZWxldGUgZGlhbG9nLiBSZWxvYWQgdGhlIHBhZ2UgYW5kIHRyeSBhZ2Fpbi5cIik7XHJcbiAgfVxyXG4gIHJldHVybiByZXN1bHQ7XHJcbn1cclxuXHJcbi8qKiBBc2sgdGhlIGJyaWRnZSB0byBvcGVuIHRoZSBkaWFsb2c7IGZhbHNlIGlmIG5vIGJyaWRnZSBpcyBtb3VudGVkIHRvIHBpY2sgaXQgdXAuICovXHJcbmZ1bmN0aW9uIHJlcXVlc3REaWFsb2coc2NlbmU6IERlbGV0YWJsZVNjZW5lKTogYm9vbGVhbiB7XHJcbiAgY29uc3QgcmVxdWVzdCA9IG5ldyBDdXN0b21FdmVudChPUEVOX0VWRU5ULCB7IGRldGFpbDogc2NlbmUsIGNhbmNlbGFibGU6IHRydWUgfSk7XHJcbiAgcmV0dXJuICF3aW5kb3cuZGlzcGF0Y2hFdmVudChyZXF1ZXN0KTtcclxufVxyXG4iLCAiLy8gVVJMIGZpbHRlciBwYXJzaW5nIGZvciBTdGFzaCBsaXN0IOKGkiBHcmFwaFFMIHNjZW5lIHF1ZXJpZXMuXG5cbmltcG9ydCB0eXBlIHsgRmluZEZpbHRlclR5cGUsIFNjZW5lRmlsdGVyVHlwZSB9IGZyb20gXCIuL3R5cGVzXCI7XG5cbi8vIEdldCBjdXJyZW50IFVSTCBzZWFyY2ggcGFyYW1zXG5leHBvcnQgZnVuY3Rpb24gZ2V0U2VhcmNoUGFyYW1zKCk6IFVSTFNlYXJjaFBhcmFtcyB7XG4gIHJldHVybiBuZXcgVVJMU2VhcmNoUGFyYW1zKHdpbmRvdy5sb2NhdGlvbi5zZWFyY2gpO1xufVxuXG4vLyBCdWlsZCBGaW5kRmlsdGVyVHlwZSBmcm9tIGN1cnJlbnQgVVJMIHNlYXJjaCBwYXJhbXMgKG9yIGFuIGV4cGxpY2l0IHBhcmFtcyBvYmplY3QpLlxuZXhwb3J0IGZ1bmN0aW9uIGdldEZpbmRGaWx0ZXIoXG4gIG92ZXJyaWRlczogUGFydGlhbDxGaW5kRmlsdGVyVHlwZT4gPSB7fSxcbiAgc2VhcmNoUGFyYW1zOiBVUkxTZWFyY2hQYXJhbXMgPSBnZXRTZWFyY2hQYXJhbXMoKSxcbik6IEZpbmRGaWx0ZXJUeXBlIHtcbiAgY29uc3QgZmlsdGVyOiBGaW5kRmlsdGVyVHlwZSA9IHtcbiAgICBwZXJfcGFnZTogb3ZlcnJpZGVzLnBlcl9wYWdlID8/IC0xLFxuICAgIHNvcnQ6IG92ZXJyaWRlcy5zb3J0ID8/IChzZWFyY2hQYXJhbXMuZ2V0KFwic29ydGJ5XCIpIHx8IFwicmF0aW5nXCIpLFxuICAgIGRpcmVjdGlvbjogb3ZlcnJpZGVzLmRpcmVjdGlvbiA/PyAoc2VhcmNoUGFyYW1zLmdldChcInNvcnRkaXJcIik/LnRvVXBwZXJDYXNlKCkgfHwgXCJERVNDXCIpLFxuICAgIC4uLm92ZXJyaWRlcyxcbiAgfTtcblxuICAvLyBJbmNsdWRlIHNlYXJjaCBxdWVyeSBpZiBwcmVzZW50XG4gIGNvbnN0IHF1ZXJ5ID0gc2VhcmNoUGFyYW1zLmdldChcInFcIik7XG4gIGlmIChxdWVyeSkge1xuICAgIGZpbHRlci5xID0gcXVlcnk7XG4gIH1cblxuICByZXR1cm4gZmlsdGVyO1xufVxuXG4vLyBUcmFuc2xhdGUgSlNPTiBzdHJpbmcgYmV0d2VlbiBVUkwgZm9ybWF0IChwYXJlbnRoZXNlcykgYW5kIHN0YW5kYXJkIEpTT04gKGJyYWNlcylcbi8vIFBvcnRlZCBmcm9tIFN0YXNoJ3MgTGlzdEZpbHRlck1vZGVsLnRyYW5zbGF0ZUpTT05cbi8vIFRoaXMgc2FmZWx5IGhhbmRsZXMgcGFyZW50aGVzZXMgaW5zaWRlIHF1b3RlZCBzdHJpbmdzXG5leHBvcnQgZnVuY3Rpb24gdHJhbnNsYXRlSlNPTihqc29uU3RyaW5nOiBzdHJpbmcsIGRlY29kaW5nOiBib29sZWFuKTogc3RyaW5nIHtcbiAgbGV0IGluU3RyaW5nID0gZmFsc2U7XG4gIGxldCBlc2NhcGUgPSBmYWxzZTtcbiAgcmV0dXJuIFsuLi5qc29uU3RyaW5nXVxuICAgIC5tYXAoKGMpID0+IHtcbiAgICAgIGlmIChlc2NhcGUpIHtcbiAgICAgICAgZXNjYXBlID0gZmFsc2U7XG4gICAgICAgIHJldHVybiBjO1xuICAgICAgfVxuICAgICAgc3dpdGNoIChjKSB7XG4gICAgICAgIGNhc2UgXCJcXFxcXCI6XG4gICAgICAgICAgaWYgKGluU3RyaW5nKSBlc2NhcGUgPSB0cnVlO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlICdcIic6XG4gICAgICAgICAgaW5TdHJpbmcgPSAhaW5TdHJpbmc7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgXCIoXCI6XG4gICAgICAgICAgaWYgKGRlY29kaW5nICYmICFpblN0cmluZykgcmV0dXJuIFwie1wiO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlIFwiKVwiOlxuICAgICAgICAgIGlmIChkZWNvZGluZyAmJiAhaW5TdHJpbmcpIHJldHVybiBcIn1cIjtcbiAgICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIHJldHVybiBjO1xuICAgIH0pXG4gICAgLmpvaW4oXCJcIik7XG59XG5cbi8vIENyaXRlcmlvbiBjYXRlZ29yeSBtYXBwaW5ncyBmb3IgVVJMIC0+IEdyYXBoUUwgdHJhbnNmb3JtYXRpb25cbi8vIEVhY2ggY2F0ZWdvcnkgcmVxdWlyZXMgZGlmZmVyZW50IHRyYW5zZm9ybWF0aW9uIGxvZ2ljXG5jb25zdCBDUklURVJJT05fQ0FURUdPUklFUyA9IHtcbiAgLy8gQm9vbGVhbjogbm8gbW9kaWZpZXIsIHZhbHVlIGlzIFwidHJ1ZVwiL1wiZmFsc2VcIiBzdHJpbmcgLT4gY29udmVydCB0byBib29sZWFuXG4gIGJvb2xlYW46IG5ldyBTZXQoW1wib3JnYW5pemVkXCIsIFwiaW50ZXJhY3RpdmVcIiwgXCJwZXJmb3JtZXJfZmF2b3JpdGVcIl0pLFxuICAvLyBTdHJpbmdFbnVtOiBVUkwgaGFzIG1vZGlmaWVyIGJ1dCBHcmFwaFFMIGp1c3QgZXhwZWN0cyB0aGUgc3RyaW5nIHZhbHVlIGRpcmVjdGx5XG4gIHN0cmluZ0VudW06IG5ldyBTZXQoW1wiaXNfbWlzc2luZ1wiLCBcImhhc19tYXJrZXJzXCJdKSxcbiAgLy8gTXVsdGk6IHZhbHVlIGlzIGFycmF5IG9mIHtpZCwgbGFiZWx9IC0+IGV4dHJhY3QgSURzIG9ubHlcbiAgbXVsdGk6IG5ldyBTZXQoW1wicGVyZm9ybWVyc1wiLCBcImdyb3Vwc1wiLCBcIm1vdmllc1wiLCBcImdhbGxlcmllc1wiXSksXG4gIC8vIEhpZXJhcmNoaWNhbE11bHRpOiB2YWx1ZSBoYXMge2l0ZW1zLCBleGNsdWRlZCwgZGVwdGh9IC0+IHJlbmFtZSB0byB7dmFsdWUsIGV4Y2x1ZGVzLCBkZXB0aH0gYW5kIGV4dHJhY3QgSURzXG4gIGhpZXJhcmNoaWNhbE11bHRpOiBuZXcgU2V0KFtcInRhZ3NcIiwgXCJzdHVkaW9zXCIsIFwicGVyZm9ybWVyX3RhZ3NcIl0pLFxufTtcblxuLy8gUmVzb2x1dGlvbiBzdHJpbmcgdG8gR3JhcGhRTCBlbnVtIG1hcHBpbmdcbi8vIFVSTCB1c2VzIGh1bWFuLXJlYWRhYmxlIHN0cmluZ3MsIEdyYXBoUUwgZXhwZWN0cyBSZXNvbHV0aW9uRW51bSB2YWx1ZXNcbmNvbnN0IFJFU09MVVRJT05fTUFQOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICBcIjE0NHBcIjogXCJWRVJZX0xPV1wiLFxuICBcIjI0MHBcIjogXCJMT1dcIixcbiAgXCIzNjBwXCI6IFwiUjM2MFBcIixcbiAgXCI0ODBwXCI6IFwiU1RBTkRBUkRcIixcbiAgXCI1NDBwXCI6IFwiV0VCX0hEXCIsXG4gIFwiNzIwcFwiOiBcIlNUQU5EQVJEX0hEXCIsXG4gIFwiMTA4MHBcIjogXCJGVUxMX0hEXCIsXG4gIFwiMTQ0MHBcIjogXCJRVUFEX0hEXCIsXG4gIFwiNGtcIjogXCJGT1VSX0tcIixcbiAgXCI1a1wiOiBcIkZJVkVfS1wiLFxuICBcIjZrXCI6IFwiU0lYX0tcIixcbiAgXCI3a1wiOiBcIlNFVkVOX0tcIixcbiAgXCI4a1wiOiBcIkVJR0hUX0tcIixcbiAgSHVnZTogXCJIVUdFXCIsXG59O1xuXG4vLyBPcmllbnRhdGlvbiBzdHJpbmcgdG8gR3JhcGhRTCBlbnVtIG1hcHBpbmdcbmNvbnN0IE9SSUVOVEFUSU9OX01BUDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgTGFuZHNjYXBlOiBcIkxBTkRTQ0FQRVwiLFxuICBQb3J0cmFpdDogXCJQT1JUUkFJVFwiLFxuICBTcXVhcmU6IFwiU1FVQVJFXCIsXG59O1xuXG5jb25zdCBpZE9mID0gKHY6IGFueSk6IHVua25vd24gPT4gKHR5cGVvZiB2ID09PSBcIm9iamVjdFwiICYmIHYgJiYgdi5pZCA/IHYuaWQgOiB2KTtcblxuLy8gQnVpbGQgU2NlbmVGaWx0ZXJUeXBlIGZyb20gVVJMICdjJyBwYXJhbXMgKGRlZmF1bHRzIHRvIGN1cnJlbnQgcGFnZSBVUkwpLlxuZXhwb3J0IGZ1bmN0aW9uIGdldFNjZW5lRmlsdGVyKFxuICBzZWFyY2hQYXJhbXM6IFVSTFNlYXJjaFBhcmFtcyA9IGdldFNlYXJjaFBhcmFtcygpLFxuKTogU2NlbmVGaWx0ZXJUeXBlIHwgbnVsbCB7XG4gIGNvbnN0IHNjZW5lRmlsdGVyOiBTY2VuZUZpbHRlclR5cGUgPSB7fTtcblxuICBpZiAoIXNlYXJjaFBhcmFtcy5oYXMoXCJjXCIpKSByZXR1cm4gbnVsbDtcblxuICBmb3IgKGNvbnN0IGNTdHIgb2Ygc2VhcmNoUGFyYW1zLmdldEFsbChcImNcIikpIHtcbiAgICB0cnkge1xuICAgICAgLy8gRGVjb2RlIFVSTCBmb3JtYXQ6ICgpIC0+IHt9IChzYWZlbHkgcHJlc2VydmluZyBzdHJpbmdzKVxuICAgICAgY29uc3QgZGVjb2RlZCA9IHRyYW5zbGF0ZUpTT04oY1N0ciwgdHJ1ZSk7XG4gICAgICBjb25zdCBjT2JqOiBhbnkgPSBKU09OLnBhcnNlKGRlY29kZWQpO1xuXG4gICAgICBjb25zdCBmaWx0ZXJUeXBlOiBzdHJpbmcgfCB1bmRlZmluZWQgPSBjT2JqLnR5cGU7XG4gICAgICBpZiAoIWZpbHRlclR5cGUpIHtcbiAgICAgICAgY29uc29sZS53YXJuKFwiW1N0YXNoIEJhdHRsZV0gRmlsdGVyIG1pc3NpbmcgdHlwZTpcIiwgY09iaik7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICAvLyBSZW1vdmUgdHlwZSBmcm9tIHRoZSBvYmplY3QgLSBpdCBiZWNvbWVzIHRoZSBrZXlcbiAgICAgIGNvbnN0IHsgdHlwZTogX3R5cGUsIC4uLnJlc3QgfSA9IGNPYmo7XG5cbiAgICAgIC8vIENhdGVnb3J5OiBCb29sZWFuIChvcmdhbml6ZWQsIGludGVyYWN0aXZlLCBwZXJmb3JtZXJfZmF2b3JpdGUpXG4gICAgICBpZiAoQ1JJVEVSSU9OX0NBVEVHT1JJRVMuYm9vbGVhbi5oYXMoZmlsdGVyVHlwZSkpIHtcbiAgICAgICAgc2NlbmVGaWx0ZXJbZmlsdGVyVHlwZV0gPSByZXN0LnZhbHVlID09PSBcInRydWVcIiB8fCByZXN0LnZhbHVlID09PSB0cnVlO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgLy8gQ2F0ZWdvcnk6IFN0cmluZ0VudW0gKHNjZW5lSXNNaXNzaW5nLCBoYXNNYXJrZXJzKVxuICAgICAgaWYgKENSSVRFUklPTl9DQVRFR09SSUVTLnN0cmluZ0VudW0uaGFzKGZpbHRlclR5cGUpKSB7XG4gICAgICAgIHNjZW5lRmlsdGVyW2ZpbHRlclR5cGVdID0gcmVzdC52YWx1ZTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIC8vIENhdGVnb3J5OiBNdWx0aSAocGVyZm9ybWVycywgZ3JvdXBzLCBtb3ZpZXMsIGdhbGxlcmllcylcbiAgICAgIGlmIChDUklURVJJT05fQ0FURUdPUklFUy5tdWx0aS5oYXMoZmlsdGVyVHlwZSkpIHtcbiAgICAgICAgY29uc3QgcmVzdWx0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgbW9kaWZpZXI6IHJlc3QubW9kaWZpZXIgfTtcbiAgICAgICAgY29uc3QgdmFsID0gcmVzdC52YWx1ZSB8fCB7fTtcblxuICAgICAgICBpZiAodmFsLml0ZW1zICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICBjb25zdCBpdGVtczogYW55W10gPSB2YWwuaXRlbXMgfHwgW107XG4gICAgICAgICAgY29uc3QgZXhjbHVkZWQ6IGFueVtdID0gdmFsLmV4Y2x1ZGVkIHx8IFtdO1xuICAgICAgICAgIHJlc3VsdC52YWx1ZSA9IGl0ZW1zLm1hcChpZE9mKTtcbiAgICAgICAgICBpZiAoZXhjbHVkZWQubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgcmVzdWx0LmV4Y2x1ZGVzID0gZXhjbHVkZWQubWFwKGlkT2YpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIGlmIChBcnJheS5pc0FycmF5KHJlc3QudmFsdWUpKSB7XG4gICAgICAgICAgcmVzdWx0LnZhbHVlID0gcmVzdC52YWx1ZS5tYXAoaWRPZik7XG4gICAgICAgIH0gZWxzZSBpZiAocmVzdC5tb2RpZmllciA9PT0gXCJJU19OVUxMXCIgfHwgcmVzdC5tb2RpZmllciA9PT0gXCJOT1RfTlVMTFwiKSB7XG4gICAgICAgICAgcmVzdWx0LnZhbHVlID0gW107XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgcmVzdWx0LnZhbHVlID0gcmVzdC52YWx1ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIHNjZW5lRmlsdGVyW2ZpbHRlclR5cGVdID0gcmVzdWx0O1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgLy8gQ2F0ZWdvcnk6IEhpZXJhcmNoaWNhbE11bHRpICh0YWdzLCBzdHVkaW9zLCBwZXJmb3JtZXJfdGFncylcbiAgICAgIGlmIChDUklURVJJT05fQ0FURUdPUklFUy5oaWVyYXJjaGljYWxNdWx0aS5oYXMoZmlsdGVyVHlwZSkpIHtcbiAgICAgICAgY29uc3QgdmFsID0gcmVzdC52YWx1ZSB8fCB7fTtcbiAgICAgICAgY29uc3QgaXRlbXM6IGFueVtdID0gdmFsLml0ZW1zIHx8IFtdO1xuICAgICAgICBjb25zdCBleGNsdWRlZDogYW55W10gPSB2YWwuZXhjbHVkZWQgfHwgW107XG4gICAgICAgIHNjZW5lRmlsdGVyW2ZpbHRlclR5cGVdID0ge1xuICAgICAgICAgIG1vZGlmaWVyOiByZXN0Lm1vZGlmaWVyLFxuICAgICAgICAgIHZhbHVlOiBpdGVtcy5tYXAoaWRPZiksXG4gICAgICAgICAgZXhjbHVkZXM6IGV4Y2x1ZGVkLm1hcChpZE9mKSxcbiAgICAgICAgICBkZXB0aDogdmFsLmRlcHRoID8/IDAsXG4gICAgICAgIH07XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICAvLyBDYXRlZ29yeTogUmVzb2x1dGlvbiAobmVlZHMgc3RyaW5nIC0+IGVudW0gY29udmVyc2lvbilcbiAgICAgIGlmIChmaWx0ZXJUeXBlID09PSBcInJlc29sdXRpb25cIikge1xuICAgICAgICBzY2VuZUZpbHRlcltmaWx0ZXJUeXBlXSA9IHtcbiAgICAgICAgICBtb2RpZmllcjogcmVzdC5tb2RpZmllcixcbiAgICAgICAgICB2YWx1ZTogUkVTT0xVVElPTl9NQVBbcmVzdC52YWx1ZV0gfHwgcmVzdC52YWx1ZSxcbiAgICAgICAgfTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIC8vIENhdGVnb3J5OiBPcmllbnRhdGlvbiAobXVsdGktc2VsZWN0IGVudW0sIG5vIG1vZGlmaWVyKVxuICAgICAgaWYgKGZpbHRlclR5cGUgPT09IFwib3JpZW50YXRpb25cIikge1xuICAgICAgICBjb25zdCB2YWx1ZXM6IGFueVtdID0gQXJyYXkuaXNBcnJheShyZXN0LnZhbHVlKSA/IHJlc3QudmFsdWUgOiBbcmVzdC52YWx1ZV07XG4gICAgICAgIHNjZW5lRmlsdGVyW2ZpbHRlclR5cGVdID0ge1xuICAgICAgICAgIHZhbHVlOiB2YWx1ZXMubWFwKCh2KSA9PiBPUklFTlRBVElPTl9NQVBbdl0gfHwgdikuZmlsdGVyKEJvb2xlYW4pLFxuICAgICAgICB9O1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgLy8gQ2F0ZWdvcnk6IER1cGxpY2F0ZWQgKHBoYXNoIGR1cGxpY2F0ZSBmaWx0ZXIgLSBkaWZmZXJlbnQgc3RydWN0dXJlKVxuICAgICAgaWYgKGZpbHRlclR5cGUgPT09IFwiZHVwbGljYXRlZFwiKSB7XG4gICAgICAgIHNjZW5lRmlsdGVyW2ZpbHRlclR5cGVdID0ge1xuICAgICAgICAgIGR1cGxpY2F0ZWQ6IHJlc3QudmFsdWUgPT09IFwidHJ1ZVwiIHx8IHJlc3QudmFsdWUgPT09IHRydWUsXG4gICAgICAgIH07XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICAvLyBDYXRlZ29yeTogU3RhbmRhcmQgKG51bWJlciwgc3RyaW5nLCBkYXRlLCB0aW1lc3RhbXAsIGR1cmF0aW9uLCBzcGVjaWFsKVxuICAgICAgaWYgKFxuICAgICAgICByZXN0LnZhbHVlICYmXG4gICAgICAgIHR5cGVvZiByZXN0LnZhbHVlID09PSBcIm9iamVjdFwiICYmXG4gICAgICAgICFBcnJheS5pc0FycmF5KHJlc3QudmFsdWUpICYmXG4gICAgICAgIFwidmFsdWVcIiBpbiByZXN0LnZhbHVlXG4gICAgICApIHtcbiAgICAgICAgLy8gRmxhdHRlbjogeyBtb2RpZmllciwgdmFsdWU6IHsgdmFsdWU6IFgsIHZhbHVlMjogWSB9IH0gLT4geyBtb2RpZmllciwgdmFsdWU6IFgsIHZhbHVlMjogWSB9XG4gICAgICAgIHNjZW5lRmlsdGVyW2ZpbHRlclR5cGVdID0ge1xuICAgICAgICAgIG1vZGlmaWVyOiByZXN0Lm1vZGlmaWVyLFxuICAgICAgICAgIHZhbHVlOiByZXN0LnZhbHVlLnZhbHVlLFxuICAgICAgICAgIC4uLihyZXN0LnZhbHVlLnZhbHVlMiAhPT0gdW5kZWZpbmVkICYmIHsgdmFsdWUyOiByZXN0LnZhbHVlLnZhbHVlMiB9KSxcbiAgICAgICAgfTtcbiAgICAgIH0gZWxzZSBpZiAocmVzdC5tb2RpZmllciA9PT0gXCJJU19OVUxMXCIgfHwgcmVzdC5tb2RpZmllciA9PT0gXCJOT1RfTlVMTFwiKSB7XG4gICAgICAgIC8vIElTX05VTEwvTk9UX05VTEwgZG9uJ3QgdXNlIHRoZSB2YWx1ZSwgYnV0IHRoZSBzY2hlbWEgc3RpbGwgcmVxdWlyZXMgaXRcbiAgICAgICAgc2NlbmVGaWx0ZXJbZmlsdGVyVHlwZV0gPSB7XG4gICAgICAgICAgbW9kaWZpZXI6IHJlc3QubW9kaWZpZXIsXG4gICAgICAgICAgdmFsdWU6IDAsXG4gICAgICAgIH07XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBQYXNzIHRocm91Z2ggYXMtaXMgKHN0cmluZyBjcml0ZXJpYSwgc3BlY2lhbCBjcml0ZXJpYSBsaWtlIHBoYXNoLCBzdGFzaF9pZCwgZXRjLilcbiAgICAgICAgc2NlbmVGaWx0ZXJbZmlsdGVyVHlwZV0gPSByZXN0O1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoXCJbU3Rhc2ggQmF0dGxlXSBGYWlsZWQgdG8gcGFyc2UgZmlsdGVyOlwiLCBjU3RyLCBlKTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gT2JqZWN0LmtleXMoc2NlbmVGaWx0ZXIpLmxlbmd0aCA+IDAgPyBzY2VuZUZpbHRlciA6IG51bGw7XG59XG5cbi8qKiBQYXJzZWQgZmlsdGVyIHN0YXRlIGZvciB0aGUgY3VycmVudCBTdGFzaCBsaXN0IFVSTC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgTGlzdEZpbHRlcnMge1xuICBmaWx0ZXJLZXk6IHN0cmluZztcbiAgc2NlbmVGaWx0ZXI6IFNjZW5lRmlsdGVyVHlwZSB8IG51bGw7XG4gIGZpbHRlckFjdGl2ZTogYm9vbGVhbjtcbn1cblxuLyoqIFJlYWQgVVJMIGZpbHRlciBzdGF0ZSBvbmNlIChjYWNoZSBrZXksIEdyYXBoUUwgc2NlbmVfZmlsdGVyLCBhY3RpdmUgZmxhZykuICovXG5leHBvcnQgZnVuY3Rpb24gcmVhZEZpbHRlcnMoKTogTGlzdEZpbHRlcnMge1xuICBjb25zdCBzZWFyY2hQYXJhbXMgPSBnZXRTZWFyY2hQYXJhbXMoKTtcbiAgY29uc3Qgc2NlbmVGaWx0ZXIgPSBnZXRTY2VuZUZpbHRlcihzZWFyY2hQYXJhbXMpO1xuICBjb25zdCBxID0gc2VhcmNoUGFyYW1zLmdldChcInFcIikgfHwgXCJcIjtcbiAgcmV0dXJuIHtcbiAgICBmaWx0ZXJLZXk6IEpTT04uc3RyaW5naWZ5KHsgcSwgZmlsdGVyOiBzY2VuZUZpbHRlciB8fCB7fSB9KSxcbiAgICBzY2VuZUZpbHRlcixcbiAgICBmaWx0ZXJBY3RpdmU6IEJvb2xlYW4oc2NlbmVGaWx0ZXIgfHwgc2VhcmNoUGFyYW1zLmhhcyhcImNcIikgfHwgc2VhcmNoUGFyYW1zLmdldChcInFcIikpLFxuICB9O1xufVxuXG4vLyBDYWNoZSBrZXkgZm9yIHRoZSBjdXJyZW50IGxpc3QgVVJMIChjcml0ZXJpYSArIHRleHQgc2VhcmNoKS5cbmV4cG9ydCBmdW5jdGlvbiBidWlsZEZpbHRlcktleSgpOiBzdHJpbmcge1xuICByZXR1cm4gcmVhZEZpbHRlcnMoKS5maWx0ZXJLZXk7XG59XG5cbi8qKiBUcnVlIHdoZW4gdGhlIGN1cnJlbnQgU3Rhc2ggbGlzdCBVUkwgaGFzIGFjdGl2ZSBmaWx0ZXJzIChjcml0ZXJpYSBhbmQvb3IgdGV4dCBzZWFyY2gpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNoZWNrRm9yRmlsdGVycygpOiBib29sZWFuIHtcbiAgcmV0dXJuIHJlYWRGaWx0ZXJzKCkuZmlsdGVyQWN0aXZlO1xufVxuIiwgIi8vIENlbnRyYWwgbXV0YWJsZSBydW50aW1lIHN0YXRlLlxuLy9cbi8vIFRoZSBvcmlnaW5hbCBwbHVnaW4gdXNlZCBtb2R1bGUtbGV2ZWwgYGxldGAgYmluZGluZ3Mgc2hhcmVkIGFjcm9zcyBtYW55IGZ1bmN0aW9ucy5cbi8vIEVTIG1vZHVsZXMgY2Fubm90IHJlYXNzaWduIGFuIGltcG9ydGVkIGJpbmRpbmcgZnJvbSBhbm90aGVyIG1vZHVsZSwgc28gYWxsIHNoYXJlZFxuLy8gbXV0YWJsZSB2YWx1ZXMgbGl2ZSBvbiB0aGlzIHNpbmdsZSBgc3RhdGVgIG9iamVjdCB0aGF0IGV2ZXJ5IG1vZHVsZSBpbXBvcnRzLlxuXG5pbXBvcnQgeyBERUZBVUxUX1NFVFRJTkdTIH0gZnJvbSBcIi4vY29uc3RhbnRzXCI7XG5pbXBvcnQgdHlwZSB7IE1vZGUsIFBhaXIsIFBsYWNlbWVudFJ1biwgUmFua3MsIFNjZW5lLCBTZXR0aW5ncyB9IGZyb20gXCIuL3R5cGVzXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgTWVtb3J5Q2FjaGUge1xuICBhbGxTY2VuZXM6IFNjZW5lW10gfCBudWxsOyAvLyBBbGwgc2NlbmVzIChubyBmaWx0ZXIpXG4gIGZpbHRlcmVkU2NlbmVzOiBTY2VuZVtdIHwgbnVsbDsgLy8gU2NlbmVzIG1hdGNoaW5nIGN1cnJlbnQgZmlsdGVyXG4gIGZpbHRlcktleTogc3RyaW5nIHwgbnVsbDsgLy8gQ3VycmVudCBmaWx0ZXIgcGFyYW1zIGZvciBjYWNoZSB2YWxpZGF0aW9uXG4gIHRpbWVzdGFtcDogbnVtYmVyIHwgbnVsbDsgLy8gV2hlbiBjYWNoZSB3YXMgcG9wdWxhdGVkXG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQmF0dGxlU3RhdGUge1xuICAvLyBDdXJyZW50IGNvbXBhcmlzb24gcGFpciBhbmQgbW9kZVxuICBjdXJyZW50UGFpcjogUGFpcjtcbiAgY3VycmVudFJhbmtzOiBSYW5rcztcbiAgY3VycmVudE1vZGU6IE1vZGU7XG4gIC8vIENoYW1waW9uIHJ1biB0cmFja2luZ1xuICBjaGFtcGlvblNjZW5lOiBTY2VuZSB8IG51bGw7IC8vIFRoZSBzY2VuZSBkZWZlbmRpbmcgKHdpbm5lciBzdGF5cyBvbilcbiAgY2hhbXBpb25XaW5zOiBudW1iZXI7IC8vIEl0cyBjdXJyZW50IHdpbiBzdHJlYWtcbiAgY2hhbXBpb25EZWZlYXRlZDogc3RyaW5nW107IC8vIElEcyBvZiBzY2VuZXMgaXQgaGFzIGJlYXRlbiBpbiB0aGlzIHJ1blxuICAvLyBQbGFjZW1lbnQgcnVuIHRyYWNraW5nXG4gIHBsYWNlbWVudDogUGxhY2VtZW50UnVuIHwgbnVsbDtcbiAgdG90YWxTY2VuZXNDb3VudDogbnVtYmVyOyAvLyBUb3RhbCBzY2VuZXMgZm9yIHBvc2l0aW9uIGRpc3BsYXlcbiAgbGVmdFBvb2xTaXplOiBudW1iZXIgfCBudWxsOyAvLyBTY2VuZXMgb24gdGhlIFwidG8gcmF0ZVwiIHNpZGUgKGZpbHRlciBvciB3aG9sZSBsaWJyYXJ5KTsgbnVsbCB1bnRpbCBsb2FkZWRcbiAgZGlzYWJsZUNob2ljZTogYm9vbGVhbjsgLy8gUHJldmVudHMgbXVsdGlwbGUgcmFwaWQgY2hvaWNlIGV2ZW50c1xuICBzYXZlZEZpbHRlclBhcmFtczogc3RyaW5nOyAvLyBTdG9yZWQgVVJMIGZpbHRlciBwYXJhbXMgdG8gZGV0ZWN0IGNoYW5nZXNcbiAgLy8gVXNlciBzZXR0aW5ncyAoZGVmYXVsdHMgdW50aWwgbG9hZFNldHRpbmdzKCkgcmVzb2x2ZXMpXG4gIHNldHRpbmdzOiBTZXR0aW5ncztcbiAgcmVzZXR0aW5nRWxvOiBib29sZWFuOyAvLyBSZXNldCBFTE8ncyBzZXR1cCBzY3JlZW4gaXMgc2hvd2luZyAoYmF0dGxlcyB3YWl0LCBsaWtlIGEgZmlyc3Qgc2V0dXApXG4gIC8vIFNodWZmbGUgc3RhdGUgZm9yIHRoZSBsZWZ0LXNpZGUgcG9vbCAocHJldmVudHMgcmVwZWF0cyB3aGVuIHNraXBwaW5nKVxuICBzaHVmZmxlZEZpbHRlcmVkU2NlbmVzOiBTY2VuZVtdO1xuICBzaHVmZmxlSW5kZXg6IG51bWJlcjtcbiAgc2h1ZmZsZUZpbHRlcktleTogc3RyaW5nIHwgbnVsbDtcbiAgLy8gU2NlbmUgY2FjaGUgKG1lbW9yeSB0aWVyKVxuICBtZW1vcnlDYWNoZTogTWVtb3J5Q2FjaGU7XG59XG5cbmV4cG9ydCBjb25zdCBzdGF0ZTogQmF0dGxlU3RhdGUgPSB7XG4gIGN1cnJlbnRQYWlyOiB7IGxlZnQ6IG51bGwsIHJpZ2h0OiBudWxsIH0sXG4gIGN1cnJlbnRSYW5rczogeyBsZWZ0OiBudWxsLCByaWdodDogbnVsbCB9LFxuICBjdXJyZW50TW9kZTogXCJzd2lzc1wiLFxuICBjaGFtcGlvblNjZW5lOiBudWxsLFxuICBjaGFtcGlvbldpbnM6IDAsXG4gIGNoYW1waW9uRGVmZWF0ZWQ6IFtdLFxuICBwbGFjZW1lbnQ6IG51bGwsXG4gIHRvdGFsU2NlbmVzQ291bnQ6IDAsXG4gIGxlZnRQb29sU2l6ZTogbnVsbCxcbiAgZGlzYWJsZUNob2ljZTogZmFsc2UsXG4gIHNhdmVkRmlsdGVyUGFyYW1zOiBcIlwiLFxuICBzZXR0aW5nczogeyAuLi5ERUZBVUxUX1NFVFRJTkdTIH0sXG4gIHJlc2V0dGluZ0VsbzogZmFsc2UsXG4gIHNodWZmbGVkRmlsdGVyZWRTY2VuZXM6IFtdLFxuICBzaHVmZmxlSW5kZXg6IDAsXG4gIHNodWZmbGVGaWx0ZXJLZXk6IG51bGwsXG4gIG1lbW9yeUNhY2hlOiB7XG4gICAgYWxsU2NlbmVzOiBudWxsLFxuICAgIGZpbHRlcmVkU2NlbmVzOiBudWxsLFxuICAgIGZpbHRlcktleTogbnVsbCxcbiAgICB0aW1lc3RhbXA6IG51bGwsXG4gIH0sXG59O1xuXG4vKiogQ2xlYXIgYW55IENoYW1waW9uIC8gUGxhY2VtZW50IHJ1biBpbiBwcm9ncmVzcy4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNldFJ1blN0YXRlKCk6IHZvaWQge1xuICBzdGF0ZS5jaGFtcGlvblNjZW5lID0gbnVsbDtcbiAgc3RhdGUuY2hhbXBpb25XaW5zID0gMDtcbiAgc3RhdGUuY2hhbXBpb25EZWZlYXRlZCA9IFtdO1xuICBzdGF0ZS5wbGFjZW1lbnQgPSBudWxsO1xufVxuXG4vKiogRm9yZ2V0IHRoZSBsZWZ0LXNpZGUgc2h1ZmZsZSBzbyB0aGUgbmV4dCBwaWNrIHJlc2h1ZmZsZXMgZnJvbSBhIGZyZXNoIHBvb2wuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzZXRTaHVmZmxlKCk6IHZvaWQge1xuICBzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzID0gW107XG4gIHN0YXRlLnNodWZmbGVJbmRleCA9IDA7XG4gIHN0YXRlLnNodWZmbGVGaWx0ZXJLZXkgPSBudWxsO1xufVxuXG4vKiogVHJ1ZSB3aGlsZSBhIENoYW1waW9uIC8gUGxhY2VtZW50IHJ1biBpcyB1bmRlciB3YXkgKHNraXAgaXMgZGlzYWJsZWQpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzUnVuQWN0aXZlKCk6IGJvb2xlYW4ge1xuICBzd2l0Y2ggKHN0YXRlLmN1cnJlbnRNb2RlKSB7XG4gICAgY2FzZSBcImNoYW1waW9uXCI6XG4gICAgICByZXR1cm4gc3RhdGUuY2hhbXBpb25TY2VuZSAhPT0gbnVsbDtcbiAgICBjYXNlIFwicGxhY2VtZW50XCI6XG4gICAgICByZXR1cm4gKHN0YXRlLnBsYWNlbWVudD8uYmF0dGxlcyA/PyAwKSA+IDA7XG4gICAgZGVmYXVsdDpcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuXG4vKiogRUxPIHNldHVwIGhhc24ndCBmaW5pc2hlZCAob3IgUmVzZXQgRUxPIGlzIHNob3dpbmcgaXQpLCBzbyBpdCBzaG93cyBpbnN0ZWFkIG9mIGxvYWRpbmcgcGFpcnMuICovXG5leHBvcnQgZnVuY3Rpb24gaXNFbG9TZXR1cFBlbmRpbmcoKTogYm9vbGVhbiB7XG4gIHJldHVybiAhc3RhdGUuc2V0dGluZ3MuZWxvU2V0dXBBdCB8fCBzdGF0ZS5yZXNldHRpbmdFbG87XG59XG4iLCAiLy8gU2NlbmUgY2FjaGU6IEluZGV4ZWREQiAoZHVyYWJsZSkgKyBpbi1tZW1vcnkgKHBlciBzZXNzaW9uKSwgc3RhbGUtd2hpbGUtcmV2YWxpZGF0ZS5cblxuaW1wb3J0IHtcbiAgQ0FDSEVfREJfTkFNRSxcbiAgQ0FDSEVfREJfVkVSU0lPTixcbiAgQ0FDSEVfTUFYX0FHRV9NUyxcbiAgQ0FDSEVfU1RPUkVfTkFNRSxcbn0gZnJvbSBcIi4vY29uc3RhbnRzXCI7XG5pbXBvcnQgeyBnZXRGaW5kRmlsdGVyLCB0eXBlIExpc3RGaWx0ZXJzIH0gZnJvbSBcIi4vZmlsdGVyc1wiO1xuaW1wb3J0IHsgRklORF9TQ0VORVNfUVVFUlksIGdyYXBocWxRdWVyeSB9IGZyb20gXCIuL2dyYXBocWxcIjtcbmltcG9ydCB7IGVsb0ZpZWxkcywgZWxvSW5zZXJ0aW9uSW5kZXgsIHNvcnRCeUVsbywgd2l0aEVsb0ZpZWxkcyB9IGZyb20gXCIuL3Njb3JlXCI7XG5pbXBvcnQgeyBzdGF0ZSB9IGZyb20gXCIuL3N0YXRlXCI7XG5pbXBvcnQgdHlwZSB7IENhY2hlRW50cnksIEVsb0ZpZWxkcywgRmluZFNjZW5lc1Jlc3VsdCwgU2NlbmUgfSBmcm9tIFwiLi90eXBlc1wiO1xuXG4vLyBPcGVuIEluZGV4ZWREQiBkYXRhYmFzZVxuZnVuY3Rpb24gb3BlbkNhY2hlREIoKTogUHJvbWlzZTxJREJEYXRhYmFzZT4ge1xuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgIGNvbnN0IHJlcXVlc3QgPSBpbmRleGVkREIub3BlbihDQUNIRV9EQl9OQU1FLCBDQUNIRV9EQl9WRVJTSU9OKTtcblxuICAgIHJlcXVlc3Qub25lcnJvciA9ICgpID0+IHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoXCJbU3Rhc2ggQmF0dGxlXSBJbmRleGVkREIgZXJyb3I6XCIsIHJlcXVlc3QuZXJyb3IpO1xuICAgICAgcmVqZWN0KHJlcXVlc3QuZXJyb3IpO1xuICAgIH07XG5cbiAgICByZXF1ZXN0Lm9uc3VjY2VzcyA9ICgpID0+IHtcbiAgICAgIHJlc29sdmUocmVxdWVzdC5yZXN1bHQpO1xuICAgIH07XG5cbiAgICByZXF1ZXN0Lm9udXBncmFkZW5lZWRlZCA9IChldmVudCkgPT4ge1xuICAgICAgY29uc3QgZGIgPSAoZXZlbnQudGFyZ2V0IGFzIElEQk9wZW5EQlJlcXVlc3QpLnJlc3VsdDtcbiAgICAgIC8vIEFueSBvbGRlciBzdG9yZSBob2xkcyBzY2VuZXMgd2l0aG91dCBFTE8gKG9yIGluIHJhdGluZyBvcmRlcik6IHN0YXJ0IGl0IG92ZXJcbiAgICAgIGlmIChkYi5vYmplY3RTdG9yZU5hbWVzLmNvbnRhaW5zKENBQ0hFX1NUT1JFX05BTUUpKSBkYi5kZWxldGVPYmplY3RTdG9yZShDQUNIRV9TVE9SRV9OQU1FKTtcbiAgICAgIGRiLmNyZWF0ZU9iamVjdFN0b3JlKENBQ0hFX1NUT1JFX05BTUUsIHsga2V5UGF0aDogXCJjYWNoZUtleVwiIH0pO1xuICAgIH07XG4gIH0pO1xufVxuXG4vLyBHZXQgY2FjaGVkIHNjZW5lcyBmcm9tIEluZGV4ZWREQlxuYXN5bmMgZnVuY3Rpb24gZ2V0Q2FjaGVkU2NlbmVzKGNhY2hlS2V5OiBzdHJpbmcpOiBQcm9taXNlPENhY2hlRW50cnkgfCBudWxsPiB7XG4gIHRyeSB7XG4gICAgY29uc3QgZGIgPSBhd2FpdCBvcGVuQ2FjaGVEQigpO1xuICAgIHJldHVybiBuZXcgUHJvbWlzZTxDYWNoZUVudHJ5IHwgbnVsbD4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgY29uc3QgdHJhbnNhY3Rpb24gPSBkYi50cmFuc2FjdGlvbihDQUNIRV9TVE9SRV9OQU1FLCBcInJlYWRvbmx5XCIpO1xuICAgICAgY29uc3Qgc3RvcmUgPSB0cmFuc2FjdGlvbi5vYmplY3RTdG9yZShDQUNIRV9TVE9SRV9OQU1FKTtcbiAgICAgIGNvbnN0IHJlcXVlc3QgPSBzdG9yZS5nZXQoY2FjaGVLZXkpO1xuXG4gICAgICByZXF1ZXN0Lm9uc3VjY2VzcyA9ICgpID0+IHtcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gcmVxdWVzdC5yZXN1bHQgYXMgQ2FjaGVFbnRyeSB8IHVuZGVmaW5lZDtcbiAgICAgICAgaWYgKHJlc3VsdCAmJiBEYXRlLm5vdygpIC0gcmVzdWx0LnRpbWVzdGFtcCA8IENBQ0hFX01BWF9BR0VfTVMpIHtcbiAgICAgICAgICByZXNvbHZlKHJlc3VsdCk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgcmVzb2x2ZShudWxsKTsgLy8gQ2FjaGUgbWlzcyBvciBleHBpcmVkXG4gICAgICAgIH1cbiAgICAgIH07XG5cbiAgICAgIHJlcXVlc3Qub25lcnJvciA9ICgpID0+IHJlamVjdChyZXF1ZXN0LmVycm9yKTtcbiAgICAgIHRyYW5zYWN0aW9uLm9uY29tcGxldGUgPSAoKSA9PiBkYi5jbG9zZSgpO1xuICAgIH0pO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIENhY2hlIHJlYWQgZXJyb3I6XCIsIGUpO1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8vIFN0b3JlIHNjZW5lcyBpbiBJbmRleGVkREJcbmFzeW5jIGZ1bmN0aW9uIHNldENhY2hlZFNjZW5lcyhcbiAgY2FjaGVLZXk6IHN0cmluZyxcbiAgc2NlbmVzOiBTY2VuZVtdLFxuICBjb3VudDogbnVtYmVyLFxuICBmaWx0ZXJLZXk/OiBzdHJpbmcsXG4gIHRpbWVzdGFtcDogbnVtYmVyID0gRGF0ZS5ub3coKSxcbik6IFByb21pc2U8dm9pZD4ge1xuICB0cnkge1xuICAgIGNvbnN0IGRiID0gYXdhaXQgb3BlbkNhY2hlREIoKTtcbiAgICByZXR1cm4gbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgY29uc3QgdHJhbnNhY3Rpb24gPSBkYi50cmFuc2FjdGlvbihDQUNIRV9TVE9SRV9OQU1FLCBcInJlYWR3cml0ZVwiKTtcbiAgICAgIGNvbnN0IHN0b3JlID0gdHJhbnNhY3Rpb24ub2JqZWN0U3RvcmUoQ0FDSEVfU1RPUkVfTkFNRSk7XG5cbiAgICAgIGNvbnN0IGRhdGE6IENhY2hlRW50cnkgPSB7XG4gICAgICAgIGNhY2hlS2V5LFxuICAgICAgICBzY2VuZXMsXG4gICAgICAgIGNvdW50LFxuICAgICAgICB0aW1lc3RhbXAsXG4gICAgICAgIC4uLihmaWx0ZXJLZXkgIT09IHVuZGVmaW5lZCAmJiB7IGZpbHRlcktleSB9KSxcbiAgICAgIH07XG5cbiAgICAgIGNvbnN0IHJlcXVlc3QgPSBzdG9yZS5wdXQoZGF0YSk7XG4gICAgICByZXF1ZXN0Lm9uc3VjY2VzcyA9ICgpID0+IHJlc29sdmUoKTtcbiAgICAgIHJlcXVlc3Qub25lcnJvciA9ICgpID0+IHJlamVjdChyZXF1ZXN0LmVycm9yKTtcbiAgICAgIHRyYW5zYWN0aW9uLm9uY29tcGxldGUgPSAoKSA9PiBkYi5jbG9zZSgpO1xuICAgIH0pO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIENhY2hlIHdyaXRlIGVycm9yOlwiLCBlKTtcbiAgfVxufVxuXG4vLyBDbGVhciBhbGwgY2FjaGVkIHNjZW5lcyAoZm9yIG1hbnVhbCByZWZyZXNoKVxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNsZWFyU2NlbmVDYWNoZSgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgdHJ5IHtcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCfl5HvuI8gQ2xlYXJpbmcgYWxsIHNjZW5lIGNhY2hlcy4uLlwiKTtcbiAgICBjb25zdCBkYiA9IGF3YWl0IG9wZW5DYWNoZURCKCk7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgIGNvbnN0IHRyYW5zYWN0aW9uID0gZGIudHJhbnNhY3Rpb24oQ0FDSEVfU1RPUkVfTkFNRSwgXCJyZWFkd3JpdGVcIik7XG4gICAgICBjb25zdCBzdG9yZSA9IHRyYW5zYWN0aW9uLm9iamVjdFN0b3JlKENBQ0hFX1NUT1JFX05BTUUpO1xuICAgICAgY29uc3QgcmVxdWVzdCA9IHN0b3JlLmNsZWFyKCk7XG5cbiAgICAgIHJlcXVlc3Qub25zdWNjZXNzID0gKCkgPT4ge1xuICAgICAgICBzdGF0ZS5tZW1vcnlDYWNoZSA9IHsgYWxsU2NlbmVzOiBudWxsLCBmaWx0ZXJlZFNjZW5lczogbnVsbCwgZmlsdGVyS2V5OiBudWxsLCB0aW1lc3RhbXA6IG51bGwgfTtcbiAgICAgICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDinIUgQWxsIGNhY2hlcyBjbGVhcmVkIChtZW1vcnkgKyBJbmRleGVkREIpXCIpO1xuICAgICAgICByZXNvbHZlKCk7XG4gICAgICB9O1xuICAgICAgcmVxdWVzdC5vbmVycm9yID0gKCkgPT4gcmVqZWN0KHJlcXVlc3QuZXJyb3IpO1xuICAgICAgdHJhbnNhY3Rpb24ub25jb21wbGV0ZSA9ICgpID0+IGRiLmNsb3NlKCk7XG4gICAgfSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0g4p2MIENhY2hlIGNsZWFyIGVycm9yOlwiLCBlKTtcbiAgfVxufVxuXG4vLyBDbGVhciBqdXN0IHRoZSBmaWx0ZXJlZCBzY2VuZXMgY2FjaGUgKGZvciBhdXRvLXJlZnJlc2ggYWZ0ZXIgcG9vbCBleGhhdXN0aW9uKVxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNsZWFyRmlsdGVyZWRDYWNoZSgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBkYiA9IGF3YWl0IG9wZW5DYWNoZURCKCk7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgIGNvbnN0IHRyYW5zYWN0aW9uID0gZGIudHJhbnNhY3Rpb24oQ0FDSEVfU1RPUkVfTkFNRSwgXCJyZWFkd3JpdGVcIik7XG4gICAgICBjb25zdCBzdG9yZSA9IHRyYW5zYWN0aW9uLm9iamVjdFN0b3JlKENBQ0hFX1NUT1JFX05BTUUpO1xuICAgICAgY29uc3QgcmVxdWVzdCA9IHN0b3JlLmRlbGV0ZShcImZpbHRlcmVkLXNjZW5lc1wiKTtcblxuICAgICAgcmVxdWVzdC5vbnN1Y2Nlc3MgPSAoKSA9PiB7XG4gICAgICAgIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzID0gbnVsbDtcbiAgICAgICAgc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyS2V5ID0gbnVsbDtcbiAgICAgICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5eR77iPIEZpbHRlcmVkIGNhY2hlIGNsZWFyZWQgKG1lbW9yeSArIEluZGV4ZWREQilcIik7XG4gICAgICAgIHJlc29sdmUoKTtcbiAgICAgIH07XG4gICAgICByZXF1ZXN0Lm9uZXJyb3IgPSAoKSA9PiByZWplY3QocmVxdWVzdC5lcnJvcik7XG4gICAgICB0cmFuc2FjdGlvbi5vbmNvbXBsZXRlID0gKCkgPT4gZGIuY2xvc2UoKTtcbiAgICB9KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnNvbGUuZXJyb3IoXCJbU3Rhc2ggQmF0dGxlXSDinYwgRmlsdGVyZWQgY2FjaGUgY2xlYXIgZXJyb3I6XCIsIGUpO1xuICAgIC8vIFN0aWxsIGNsZWFyIG1lbW9yeSBjYWNoZSBldmVuIGlmIEluZGV4ZWREQiBmYWlsc1xuICAgIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzID0gbnVsbDtcbiAgICBzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJLZXkgPSBudWxsO1xuICB9XG59XG5cbi8vIEJhY2tncm91bmQgcmVmcmVzaCAtIGZldGNoIGZyb20gbmV0d29yayBhbmQgdXBkYXRlIGNhY2hlcyBzaWxlbnRseVxuYXN5bmMgZnVuY3Rpb24gYmFja2dyb3VuZFJlZnJlc2hBbGxTY2VuZXMoKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGNhY2hlS2V5ID0gXCJhbGwtc2NlbmVzXCI7XG5cbiAgdHJ5IHtcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCflIQgQmFja2dyb3VuZCByZWZyZXNoIHN0YXJ0ZWQgKGFsbCBzY2VuZXMpLi4uXCIpO1xuICAgIGNvbnN0IHN0YXJ0VGltZSA9IERhdGUubm93KCk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBncmFwaHFsUXVlcnk8RmluZFNjZW5lc1Jlc3VsdD4oRklORF9TQ0VORVNfUVVFUlksIHtcbiAgICAgIGZpbHRlcjoge1xuICAgICAgICBwZXJfcGFnZTogLTEsXG4gICAgICAgIHNvcnQ6IFwicmF0aW5nXCIsXG4gICAgICAgIGRpcmVjdGlvbjogXCJERVNDXCIsXG4gICAgICB9LFxuICAgICAgc2NlbmVfZmlsdGVyOiBudWxsLFxuICAgIH0pO1xuXG4gICAgY29uc3Qgc2NlbmVzID0gc29ydEJ5RWxvKHJlc3VsdC5maW5kU2NlbmVzLnNjZW5lcyB8fCBbXSk7XG4gICAgY29uc3QgY291bnQgPSByZXN1bHQuZmluZFNjZW5lcy5jb3VudCB8fCBzY2VuZXMubGVuZ3RoO1xuICAgIGNvbnN0IGZldGNoVGltZSA9IERhdGUubm93KCkgLSBzdGFydFRpbWU7XG5cbiAgICBjb25zdCBvbGRDb3VudCA9IHN0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcyA/IHN0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcy5sZW5ndGggOiAwO1xuICAgIGlmIChjb3VudCAhPT0gb2xkQ291bnQpIHtcbiAgICAgIGNvbnNvbGUubG9nKFxuICAgICAgICBgW1N0YXNoIEJhdHRsZV0g8J+TiiBTY2VuZSBjb3VudCBjaGFuZ2VkOiAke29sZENvdW50fSDihpIgJHtjb3VudH0gKCR7Y291bnQgPiBvbGRDb3VudCA/IFwiK1wiIDogXCJcIn0ke2NvdW50IC0gb2xkQ291bnR9KWAsXG4gICAgICApO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g8J+TiiBTY2VuZSBjb3VudCB1bmNoYW5nZWQ6ICR7Y291bnR9YCk7XG4gICAgfVxuXG4gICAgc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzID0gc2NlbmVzO1xuICAgIHN0YXRlLm1lbW9yeUNhY2hlLnRpbWVzdGFtcCA9IERhdGUubm93KCk7XG4gICAgYXdhaXQgc2V0Q2FjaGVkU2NlbmVzKGNhY2hlS2V5LCBzY2VuZXMsIGNvdW50KTtcblxuICAgIGNvbnNvbGUubG9nKGBbU3Rhc2ggQmF0dGxlXSDinIUgQmFja2dyb3VuZCByZWZyZXNoIGNvbXBsZXRlOiAke3NjZW5lcy5sZW5ndGh9IHNjZW5lcyBpbiAke2ZldGNoVGltZX1tc2ApO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIOKdjCBCYWNrZ3JvdW5kIHJlZnJlc2ggZmFpbGVkOlwiLCBlKTtcbiAgfVxufVxuXG4vLyBHZXQgYWxsIHNjZW5lcyAodXNlcyBjYWNoZSB3aXRoIHN0YWxlLXdoaWxlLXJldmFsaWRhdGUpXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ2V0QWxsU2NlbmVzQ2FjaGVkKCk6IFByb21pc2U8eyBzY2VuZXM6IFNjZW5lW107IGNvdW50OiBudW1iZXIgfT4ge1xuICBjb25zdCBjYWNoZUtleSA9IFwiYWxsLXNjZW5lc1wiO1xuXG4gIC8vIENoZWNrIG1lbW9yeSBjYWNoZSBmaXJzdCAtIHJldHVybiBpbW1lZGlhdGVseSBpZiBhdmFpbGFibGVcbiAgaWYgKHN0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcykge1xuICAgIGNvbnN0IGNhY2hlQWdlID0gTWF0aC5yb3VuZCgoRGF0ZS5ub3coKSAtIChzdGF0ZS5tZW1vcnlDYWNoZS50aW1lc3RhbXAgPz8gMCkpIC8gMTAwMCk7XG4gICAgY29uc3QgaXNTdGFsZSA9IERhdGUubm93KCkgLSAoc3RhdGUubWVtb3J5Q2FjaGUudGltZXN0YW1wID8/IDApID49IENBQ0hFX01BWF9BR0VfTVM7XG5cbiAgICBjb25zb2xlLmxvZyhcbiAgICAgIGBbU3Rhc2ggQmF0dGxlXSDwn5K+IE1lbW9yeSBjYWNoZSBoaXQgKGFsbCBzY2VuZXMpOiAke3N0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcy5sZW5ndGh9IHNjZW5lcywgYWdlOiAke2NhY2hlQWdlfXMke2lzU3RhbGUgPyBcIiBbU1RBTEVdXCIgOiBcIlwifWAsXG4gICAgKTtcblxuICAgIGlmIChpc1N0YWxlKSB7XG4gICAgICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g4o+wIENhY2hlIHN0YWxlICg+JHtDQUNIRV9NQVhfQUdFX01TIC8gMTAwMH1zKSwgdHJpZ2dlcmluZyBiYWNrZ3JvdW5kIHJlZnJlc2guLi5gKTtcbiAgICAgIGJhY2tncm91bmRSZWZyZXNoQWxsU2NlbmVzKCk7IC8vIERvbid0IGF3YWl0IC0gcnVucyBpbiBiYWNrZ3JvdW5kXG4gICAgfVxuICAgIHJldHVybiB7IHNjZW5lczogc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzLCBjb3VudDogc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzLmxlbmd0aCB9O1xuICB9XG5cbiAgLy8gQ2hlY2sgSW5kZXhlZERCIGNhY2hlIC0gcmV0dXJuIGltbWVkaWF0ZWx5IGlmIGF2YWlsYWJsZVxuICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCflI0gTWVtb3J5IGNhY2hlIG1pc3MsIGNoZWNraW5nIEluZGV4ZWREQi4uLlwiKTtcbiAgY29uc3QgY2FjaGVkID0gYXdhaXQgZ2V0Q2FjaGVkU2NlbmVzKGNhY2hlS2V5KTtcbiAgaWYgKGNhY2hlZCkge1xuICAgIGNvbnN0IGNhY2hlQWdlID0gTWF0aC5yb3VuZCgoRGF0ZS5ub3coKSAtIGNhY2hlZC50aW1lc3RhbXApIC8gMTAwMCk7XG4gICAgY29uc3QgaXNTdGFsZSA9IERhdGUubm93KCkgLSBjYWNoZWQudGltZXN0YW1wID49IENBQ0hFX01BWF9BR0VfTVM7XG5cbiAgICBjb25zb2xlLmxvZyhcbiAgICAgIGBbU3Rhc2ggQmF0dGxlXSDwn5K/IEluZGV4ZWREQiBjYWNoZSBoaXQgKGFsbCBzY2VuZXMpOiAke2NhY2hlZC5zY2VuZXMubGVuZ3RofSBzY2VuZXMsIGFnZTogJHtjYWNoZUFnZX1zJHtpc1N0YWxlID8gXCIgW1NUQUxFXVwiIDogXCJcIn1gLFxuICAgICk7XG5cbiAgICBzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXMgPSBjYWNoZWQuc2NlbmVzO1xuICAgIHN0YXRlLm1lbW9yeUNhY2hlLnRpbWVzdGFtcCA9IGNhY2hlZC50aW1lc3RhbXA7XG5cbiAgICBpZiAoaXNTdGFsZSkge1xuICAgICAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIOKPsCBDYWNoZSBzdGFsZSAoPiR7Q0FDSEVfTUFYX0FHRV9NUyAvIDEwMDB9cyksIHRyaWdnZXJpbmcgYmFja2dyb3VuZCByZWZyZXNoLi4uYCk7XG4gICAgICBiYWNrZ3JvdW5kUmVmcmVzaEFsbFNjZW5lcygpOyAvLyBEb24ndCBhd2FpdCAtIHJ1bnMgaW4gYmFja2dyb3VuZFxuICAgIH1cbiAgICByZXR1cm4geyBzY2VuZXM6IGNhY2hlZC5zY2VuZXMsIGNvdW50OiBjYWNoZWQuY291bnQgfTtcbiAgfVxuXG4gIC8vIE5vIGNhY2hlIGF0IGFsbCAtIG11c3QgZmV0Y2ggZnJvbSBuZXR3b3JrIChibG9ja2luZylcbiAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn4yQIE5vIGNhY2hlIGZvdW5kLCBmZXRjaGluZyBhbGwgc2NlbmVzIGZyb20gbmV0d29yayAoZmlyc3QgbG9hZCkuLi5cIik7XG4gIGNvbnN0IHN0YXJ0VGltZSA9IERhdGUubm93KCk7XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZ3JhcGhxbFF1ZXJ5PEZpbmRTY2VuZXNSZXN1bHQ+KEZJTkRfU0NFTkVTX1FVRVJZLCB7XG4gICAgZmlsdGVyOiB7XG4gICAgICBwZXJfcGFnZTogLTEsXG4gICAgICBzb3J0OiBcInJhdGluZ1wiLFxuICAgICAgZGlyZWN0aW9uOiBcIkRFU0NcIixcbiAgICB9LFxuICAgIHNjZW5lX2ZpbHRlcjogbnVsbCxcbiAgfSk7XG5cbiAgY29uc3Qgc2NlbmVzID0gc29ydEJ5RWxvKHJlc3VsdC5maW5kU2NlbmVzLnNjZW5lcyB8fCBbXSk7XG4gIGNvbnN0IGNvdW50ID0gcmVzdWx0LmZpbmRTY2VuZXMuY291bnQgfHwgc2NlbmVzLmxlbmd0aDtcbiAgY29uc3QgZmV0Y2hUaW1lID0gRGF0ZS5ub3coKSAtIHN0YXJ0VGltZTtcblxuICBzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXMgPSBzY2VuZXM7XG4gIHN0YXRlLm1lbW9yeUNhY2hlLnRpbWVzdGFtcCA9IERhdGUubm93KCk7XG4gIGF3YWl0IHNldENhY2hlZFNjZW5lcyhjYWNoZUtleSwgc2NlbmVzLCBjb3VudCk7XG5cbiAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIOKchSBGZXRjaGVkIGFuZCBjYWNoZWQgJHtzY2VuZXMubGVuZ3RofSBzY2VuZXMgaW4gJHtmZXRjaFRpbWV9bXNgKTtcbiAgcmV0dXJuIHsgc2NlbmVzLCBjb3VudCB9O1xufVxuXG4vLyBCYWNrZ3JvdW5kIHJlZnJlc2ggZm9yIGZpbHRlcmVkIHNjZW5lc1xuYXN5bmMgZnVuY3Rpb24gYmFja2dyb3VuZFJlZnJlc2hGaWx0ZXJlZFNjZW5lcyhmaWx0ZXJzOiBMaXN0RmlsdGVycyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBjYWNoZUtleSA9IFwiZmlsdGVyZWQtc2NlbmVzXCI7XG5cbiAgdHJ5IHtcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCflIQgQmFja2dyb3VuZCByZWZyZXNoIHN0YXJ0ZWQgKGZpbHRlcmVkIHNjZW5lcykuLi5cIik7XG4gICAgY29uc3Qgc3RhcnRUaW1lID0gRGF0ZS5ub3coKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGdyYXBocWxRdWVyeTxGaW5kU2NlbmVzUmVzdWx0PihGSU5EX1NDRU5FU19RVUVSWSwge1xuICAgICAgZmlsdGVyOiBnZXRGaW5kRmlsdGVyKHtcbiAgICAgICAgcGVyX3BhZ2U6IC0xLFxuICAgICAgICBzb3J0OiBcInJhdGluZ1wiLFxuICAgICAgICBkaXJlY3Rpb246IFwiREVTQ1wiLFxuICAgICAgfSksXG4gICAgICBzY2VuZV9maWx0ZXI6IGZpbHRlcnMuc2NlbmVGaWx0ZXIsXG4gICAgfSk7XG5cbiAgICBjb25zdCBzY2VuZXMgPSBzb3J0QnlFbG8ocmVzdWx0LmZpbmRTY2VuZXMuc2NlbmVzIHx8IFtdKTtcbiAgICBjb25zdCBjb3VudCA9IHJlc3VsdC5maW5kU2NlbmVzLmNvdW50IHx8IHNjZW5lcy5sZW5ndGg7XG4gICAgY29uc3QgZmV0Y2hUaW1lID0gRGF0ZS5ub3coKSAtIHN0YXJ0VGltZTtcblxuICAgIC8vIE9ubHkgdXBkYXRlIGlmIHN0aWxsIG9uIHNhbWUgZmlsdGVyXG4gICAgaWYgKHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcktleSA9PT0gZmlsdGVycy5maWx0ZXJLZXkpIHtcbiAgICAgIGNvbnN0IG9sZENvdW50ID0gc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXMgPyBzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJlZFNjZW5lcy5sZW5ndGggOiAwO1xuICAgICAgaWYgKGNvdW50ICE9PSBvbGRDb3VudCkge1xuICAgICAgICBjb25zb2xlLmxvZyhcbiAgICAgICAgICBgW1N0YXNoIEJhdHRsZV0g8J+TiiBGaWx0ZXJlZCBjb3VudCBjaGFuZ2VkOiAke29sZENvdW50fSDihpIgJHtjb3VudH0gKCR7Y291bnQgPiBvbGRDb3VudCA/IFwiK1wiIDogXCJcIn0ke2NvdW50IC0gb2xkQ291bnR9KWAsXG4gICAgICAgICk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g8J+TiiBGaWx0ZXJlZCBjb3VudCB1bmNoYW5nZWQ6ICR7Y291bnR9YCk7XG4gICAgICB9XG5cbiAgICAgIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzID0gc2NlbmVzO1xuICAgICAgc3RhdGUubWVtb3J5Q2FjaGUudGltZXN0YW1wID0gRGF0ZS5ub3coKTtcbiAgICAgIGF3YWl0IHNldENhY2hlZFNjZW5lcyhjYWNoZUtleSwgc2NlbmVzLCBjb3VudCwgZmlsdGVycy5maWx0ZXJLZXkpO1xuXG4gICAgICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g4pyFIEJhY2tncm91bmQgcmVmcmVzaCBjb21wbGV0ZTogJHtzY2VuZXMubGVuZ3RofSBmaWx0ZXJlZCBzY2VuZXMgaW4gJHtmZXRjaFRpbWV9bXNgKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDimqDvuI8gRmlsdGVyIGNoYW5nZWQgZHVyaW5nIHJlZnJlc2gsIGRpc2NhcmRpbmcgcmVzdWx0c1wiKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0g4p2MIEJhY2tncm91bmQgcmVmcmVzaCAoZmlsdGVyZWQpIGZhaWxlZDpcIiwgZSk7XG4gIH1cbn1cblxuLy8gR2V0IGZpbHRlcmVkIHNjZW5lcyAodXNlcyBjYWNoZSB3aXRoIHN0YWxlLXdoaWxlLXJldmFsaWRhdGUpXG4vLyBOT1RFOiBPbmx5IE9ORSBmaWx0ZXJlZCBjYWNoZSBpcyBrZXB0IChvdmVyd3JpdGVzIHByZXZpb3VzIGZpbHRlciBjYWNoZSB0byBwcmV2ZW50IEluZGV4ZWREQiBibG9hdClcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXRGaWx0ZXJlZFNjZW5lc0NhY2hlZChcbiAgZmlsdGVyczogTGlzdEZpbHRlcnMsXG4pOiBQcm9taXNlPHsgc2NlbmVzOiBTY2VuZVtdOyBjb3VudDogbnVtYmVyIH0+IHtcbiAgY29uc3QgeyBmaWx0ZXJLZXksIHNjZW5lRmlsdGVyIH0gPSBmaWx0ZXJzO1xuICBjb25zdCBjYWNoZUtleSA9IFwiZmlsdGVyZWQtc2NlbmVzXCI7IC8vIFNpbmdsZSBrZXkgLSBvdmVyd3JpdGVzIHByZXZpb3VzIGZpbHRlciBjYWNoZVxuXG4gIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+UjiBGaWx0ZXIgYWN0aXZlLCBjaGVja2luZyBmaWx0ZXJlZCBjYWNoZS4uLlwiKTtcblxuICAvLyBDaGVjayBtZW1vcnkgY2FjaGUgZmlyc3QgLSByZXR1cm4gaW1tZWRpYXRlbHkgaWYgYXZhaWxhYmxlIGFuZCBzYW1lIGZpbHRlclxuICBpZiAoc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXMgJiYgc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyS2V5ID09PSBmaWx0ZXJLZXkpIHtcbiAgICBjb25zdCBjYWNoZUFnZSA9IE1hdGgucm91bmQoKERhdGUubm93KCkgLSAoc3RhdGUubWVtb3J5Q2FjaGUudGltZXN0YW1wID8/IDApKSAvIDEwMDApO1xuICAgIGNvbnN0IGlzU3RhbGUgPSBEYXRlLm5vdygpIC0gKHN0YXRlLm1lbW9yeUNhY2hlLnRpbWVzdGFtcCA/PyAwKSA+PSBDQUNIRV9NQVhfQUdFX01TO1xuXG4gICAgY29uc29sZS5sb2coXG4gICAgICBgW1N0YXNoIEJhdHRsZV0g8J+SviBNZW1vcnkgY2FjaGUgaGl0IChmaWx0ZXJlZCk6ICR7c3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXMubGVuZ3RofSBzY2VuZXMsIGFnZTogJHtjYWNoZUFnZX1zJHtpc1N0YWxlID8gXCIgW1NUQUxFXVwiIDogXCJcIn1gLFxuICAgICk7XG5cbiAgICBpZiAoaXNTdGFsZSkge1xuICAgICAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIOKPsCBDYWNoZSBzdGFsZSAoPiR7Q0FDSEVfTUFYX0FHRV9NUyAvIDEwMDB9cyksIHRyaWdnZXJpbmcgYmFja2dyb3VuZCByZWZyZXNoLi4uYCk7XG4gICAgICBiYWNrZ3JvdW5kUmVmcmVzaEZpbHRlcmVkU2NlbmVzKGZpbHRlcnMpO1xuICAgIH1cbiAgICByZXR1cm4geyBzY2VuZXM6IHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzLCBjb3VudDogc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXMubGVuZ3RoIH07XG4gIH1cblxuICAvLyBDaGVjayBJbmRleGVkREIgY2FjaGUgKG9ubHkgaWYgZmlsdGVyIGtleSBtYXRjaGVzKVxuICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCflI0gTWVtb3J5IGNhY2hlIG1pc3MgKGZpbHRlcmVkKSwgY2hlY2tpbmcgSW5kZXhlZERCLi4uXCIpO1xuICBjb25zdCBjYWNoZWQgPSBhd2FpdCBnZXRDYWNoZWRTY2VuZXMoY2FjaGVLZXkpO1xuICBpZiAoY2FjaGVkICYmIGNhY2hlZC5maWx0ZXJLZXkgPT09IGZpbHRlcktleSkge1xuICAgIGNvbnN0IGNhY2hlQWdlID0gTWF0aC5yb3VuZCgoRGF0ZS5ub3coKSAtIGNhY2hlZC50aW1lc3RhbXApIC8gMTAwMCk7XG4gICAgY29uc3QgaXNTdGFsZSA9IERhdGUubm93KCkgLSBjYWNoZWQudGltZXN0YW1wID49IENBQ0hFX01BWF9BR0VfTVM7XG5cbiAgICBjb25zb2xlLmxvZyhcbiAgICAgIGBbU3Rhc2ggQmF0dGxlXSDwn5K/IEluZGV4ZWREQiBjYWNoZSBoaXQgKGZpbHRlcmVkKTogJHtjYWNoZWQuc2NlbmVzLmxlbmd0aH0gc2NlbmVzLCBhZ2U6ICR7Y2FjaGVBZ2V9cyR7aXNTdGFsZSA/IFwiIFtTVEFMRV1cIiA6IFwiXCJ9YCxcbiAgICApO1xuXG4gICAgc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXMgPSBjYWNoZWQuc2NlbmVzO1xuICAgIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcktleSA9IGZpbHRlcktleTtcbiAgICBzdGF0ZS5tZW1vcnlDYWNoZS50aW1lc3RhbXAgPSBjYWNoZWQudGltZXN0YW1wO1xuXG4gICAgaWYgKGlzU3RhbGUpIHtcbiAgICAgIGNvbnNvbGUubG9nKGBbU3Rhc2ggQmF0dGxlXSDij7AgQ2FjaGUgc3RhbGUgKD4ke0NBQ0hFX01BWF9BR0VfTVMgLyAxMDAwfXMpLCB0cmlnZ2VyaW5nIGJhY2tncm91bmQgcmVmcmVzaC4uLmApO1xuICAgICAgYmFja2dyb3VuZFJlZnJlc2hGaWx0ZXJlZFNjZW5lcyhmaWx0ZXJzKTtcbiAgICB9XG4gICAgcmV0dXJuIHsgc2NlbmVzOiBjYWNoZWQuc2NlbmVzLCBjb3VudDogY2FjaGVkLmNvdW50IH07XG4gIH1cblxuICBpZiAoY2FjaGVkKSB7XG4gICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5K/IEluZGV4ZWREQiBjYWNoZSBleGlzdHMgYnV0IGZpbHRlciBjaGFuZ2VkLCBmZXRjaGluZyBuZXcgZGF0YS4uLlwiKTtcbiAgfSBlbHNlIHtcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCfkr8gSW5kZXhlZERCIGNhY2hlIG1pc3MgKGZpbHRlcmVkKVwiKTtcbiAgfVxuXG4gIC8vIE5vIG1hdGNoaW5nIGNhY2hlIC0gbXVzdCBmZXRjaCBmcm9tIG5ldHdvcmsgKGJsb2NraW5nKVxuICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCfjJAgRmV0Y2hpbmcgZmlsdGVyZWQgc2NlbmVzIGZyb20gbmV0d29yay4uLlwiKTtcbiAgY29uc3Qgc3RhcnRUaW1lID0gRGF0ZS5ub3coKTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBncmFwaHFsUXVlcnk8RmluZFNjZW5lc1Jlc3VsdD4oRklORF9TQ0VORVNfUVVFUlksIHtcbiAgICBmaWx0ZXI6IGdldEZpbmRGaWx0ZXIoe1xuICAgICAgcGVyX3BhZ2U6IC0xLFxuICAgICAgc29ydDogXCJyYXRpbmdcIixcbiAgICAgIGRpcmVjdGlvbjogXCJERVNDXCIsXG4gICAgfSksXG4gICAgc2NlbmVfZmlsdGVyOiBzY2VuZUZpbHRlcixcbiAgfSk7XG5cbiAgY29uc3Qgc2NlbmVzID0gc29ydEJ5RWxvKHJlc3VsdC5maW5kU2NlbmVzLnNjZW5lcyB8fCBbXSk7XG4gIGNvbnN0IGNvdW50ID0gcmVzdWx0LmZpbmRTY2VuZXMuY291bnQgfHwgc2NlbmVzLmxlbmd0aDtcbiAgY29uc3QgZmV0Y2hUaW1lID0gRGF0ZS5ub3coKSAtIHN0YXJ0VGltZTtcblxuICBzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJlZFNjZW5lcyA9IHNjZW5lcztcbiAgc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyS2V5ID0gZmlsdGVyS2V5O1xuICBzdGF0ZS5tZW1vcnlDYWNoZS50aW1lc3RhbXAgPSBEYXRlLm5vdygpO1xuICBhd2FpdCBzZXRDYWNoZWRTY2VuZXMoY2FjaGVLZXksIHNjZW5lcywgY291bnQsIGZpbHRlcktleSk7XG5cbiAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIOKchSBGZXRjaGVkIGFuZCBjYWNoZWQgJHtzY2VuZXMubGVuZ3RofSBmaWx0ZXJlZCBzY2VuZXMgaW4gJHtmZXRjaFRpbWV9bXNgKTtcbiAgcmV0dXJuIHsgc2NlbmVzLCBjb3VudCB9O1xufVxuXG4vKiogU2V0IChvciB3aXRoIG51bGwsIHJlbW92ZSkgdGhlIEVMTyBmaWVsZHMgb24gb25lIHNjZW5lIG9iamVjdC4gKi9cbmZ1bmN0aW9uIGFwcGx5RWxvKHNjZW5lOiBTY2VuZSwgdmFsdWU6IEVsb0ZpZWxkcyB8IG51bGwpOiB2b2lkIHtcbiAgc2NlbmUuY3VzdG9tX2ZpZWxkcyA9IHdpdGhFbG9GaWVsZHMoc2NlbmUuY3VzdG9tX2ZpZWxkcywgdmFsdWUpO1xufVxuXG4vKipcbiAqIFRoZSBjYWNoZWQgY29weSBvZiBhIHNjZW5lIChhbGwgc2NlbmVzIGZpcnN0LCB0aGVuIHRoZSBmaWx0ZXJlZCBvbmVzKSwgb3IgdGhlIHNjZW5lIGl0c2VsZiBpZlxuICogbmVpdGhlciBoYXMgaXQuIFNjZW5lIG9iamVjdHMgaGVsZCBhY3Jvc3MgYmF0dGxlcyAodGhlIHNodWZmbGUsIGEgc2F2ZWQgcGFpciwgYSBDaGFtcGlvbiBvclxuICogUGxhY2VtZW50IHJ1bikgZ28gc3RhbGUgb25jZSBhIGJhY2tncm91bmQgcmVmcmVzaCBzd2FwcyBpbiBuZXcgY29waWVzLCBzbyBiYXR0bGUgbWF0aCByZWFkc1xuICogRUxPIGFuZCBiYXR0bGVzIGZyb20gdGhpcyBpbnN0ZWFkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbGF0ZXN0U2NlbmUoc2NlbmU6IFNjZW5lKTogU2NlbmUge1xuICByZXR1cm4gKFxuICAgIHN0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcz8uZmluZCgocykgPT4gcy5pZCA9PT0gc2NlbmUuaWQpID8/XG4gICAgc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXM/LmZpbmQoKHMpID0+IHMuaWQgPT09IHNjZW5lLmlkKSA/P1xuICAgIHNjZW5lXG4gICk7XG59XG5cbi8qKlxuICogU2V0IChvciB3aXRoIG51bGwsIHJlbW92ZSkgYSBzY2VuZSdzIEVMTyBvbiBgc2NlbmVgIGl0c2VsZiBhbmQgb24gaXRzIGNhY2hlZCBjb3BpZXMsIGFuZCBtb3ZlXG4gKiB0aGUgY2FjaGVkIGNvcGllcyB0byB0aGVpciBuZXcgcGxhY2UgaW4gdGhlIEVMTyBvcmRlciBzbyByYW5rcyBzdGF5IHJpZ2h0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2V0RWxvSW5DYWNoZShzY2VuZTogU2NlbmUsIHZhbHVlOiBFbG9GaWVsZHMgfCBudWxsKTogdm9pZCB7XG4gIGFwcGx5RWxvKHNjZW5lLCB2YWx1ZSk7XG4gIGZvciAoY29uc3QgcG9vbCBvZiBbc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzLCBzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJlZFNjZW5lc10pIHtcbiAgICBjb25zdCBpZHggPSBwb29sID8gcG9vbC5maW5kSW5kZXgoKHMpID0+IHMuaWQgPT09IHNjZW5lLmlkKSA6IC0xO1xuICAgIGlmICghcG9vbCB8fCBpZHggPT09IC0xKSBjb250aW51ZTtcbiAgICBjb25zdCBbY2FjaGVkXSA9IHBvb2wuc3BsaWNlKGlkeCwgMSk7XG4gICAgaWYgKGNhY2hlZCAhPT0gc2NlbmUpIGFwcGx5RWxvKGNhY2hlZCwgdmFsdWUpO1xuICAgIHBvb2wuc3BsaWNlKHZhbHVlID8gZWxvSW5zZXJ0aW9uSW5kZXgocG9vbCwgdmFsdWUuZWxvKSA6IHBvb2wubGVuZ3RoLCAwLCBjYWNoZWQpO1xuICB9XG4gIHBlcnNpc3RDYWNoZVNvb24oKTtcbn1cblxuLyoqIFNldCB0aGUgU3Rhc2ggcmF0aW5nIG9uIGNhY2hlZCBzY2VuZXMgKGFmdGVyIFN0YXNoIEJhdHRsZSB3cm90ZSB0aGVtKS4gT3JkZXIgaXMgRUxPLCBzbyB1bmNoYW5nZWQuICovXG5leHBvcnQgZnVuY3Rpb24gc2V0UmF0aW5nc0luQ2FjaGUocmF0aW5nczogTWFwPHN0cmluZywgbnVtYmVyPik6IHZvaWQge1xuICBmb3IgKGNvbnN0IHBvb2wgb2YgW3N0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcywgc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXNdKSB7XG4gICAgZm9yIChjb25zdCBzY2VuZSBvZiBwb29sID8/IFtdKSB7XG4gICAgICBjb25zdCByYXRpbmcgPSByYXRpbmdzLmdldChzY2VuZS5pZCk7XG4gICAgICBpZiAocmF0aW5nICE9PSB1bmRlZmluZWQpIHNjZW5lLnJhdGluZzEwMCA9IHJhdGluZztcbiAgICB9XG4gIH1cbiAgcGVyc2lzdENhY2hlU29vbigpO1xufVxuXG4vKipcbiAqIEJyaW5nIGEgc2NlbmUncyBjYWNoZWQgY29waWVzIGluIGxpbmUgd2l0aCBmcmVzaCB2YWx1ZXMgZnJvbSBTdGFzaCAoaXRzIEVMTyBmaWVsZHMgYW5kIFN0YXNoXG4gKiByYXRpbmcpLCBtb3ZpbmcgdGhlbSB0byB0aGVpciBwbGFjZSBpbiB0aGUgRUxPIG9yZGVyLiBGb3Igc2NlbmVzIGZldGNoZWQgb24gdGhlaXIgb3duIChhXG4gKiByZXN0b3JlZCBwYWlyLCBhIHNjZW5lIHBhZ2UgYmF0dGxlKSwgd2hpY2ggbWF5IGJlIG5ld2VyIHRoYW4gdGhlIGNhY2hlOiBjaGFuZ2VkIGluIGFub3RoZXJcbiAqIHRhYiwgc2F5LlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVmcmVzaFNjZW5lSW5DYWNoZShmcmVzaDogU2NlbmUpOiB2b2lkIHtcbiAgZm9yIChjb25zdCBwb29sIG9mIFtzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXMsIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzXSkge1xuICAgIGNvbnN0IGNhY2hlZCA9IHBvb2w/LmZpbmQoKHMpID0+IHMuaWQgPT09IGZyZXNoLmlkKTtcbiAgICBpZiAoY2FjaGVkKSBjYWNoZWQucmF0aW5nMTAwID0gZnJlc2gucmF0aW5nMTAwID8/IG51bGw7XG4gIH1cbiAgc2V0RWxvSW5DYWNoZShmcmVzaCwgZWxvRmllbGRzKGZyZXNoKSk7XG59XG5cbi8qKiBXcml0ZSB0aGUgaW4tbWVtb3J5IHNjZW5lIGxpc3RzIGJhY2sgdG8gSW5kZXhlZERCIHRoaXMgbG9uZyBhZnRlciB0aGUgbGFzdCBjaGFuZ2UuICovXG5jb25zdCBQRVJTSVNUX0RFQk9VTkNFX01TID0gMTAwMDtcbmxldCBwZXJzaXN0VGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XG5cbi8qKlxuICogQmF0dGxlcyBjaGFuZ2UgdGhlIGluLW1lbW9yeSBsaXN0cyBvbmx5OyB3aXRob3V0IHRoaXMsIGEgcmVsb2FkIHdpdGhpbiBDQUNIRV9NQVhfQUdFX01TIHdvdWxkXG4gKiByZWFkIHRoZSBJbmRleGVkREIgY29weSBmcm9tIGJlZm9yZSB0aGVtIChvbGQgRUxPLCBvbGQgb3JkZXIpLiBEZWJvdW5jZWQsIHNvIGEgcGljaydzIHdyaXRlc1xuICogYW5kIGl0cyBTdGFzaCByYXRpbmcgc3luYyBhcmUgc2F2ZWQgdG9nZXRoZXIuXG4gKi9cbmZ1bmN0aW9uIHBlcnNpc3RDYWNoZVNvb24oKTogdm9pZCB7XG4gIGlmICh0eXBlb2YgaW5kZXhlZERCID09PSBcInVuZGVmaW5lZFwiKSByZXR1cm47XG4gIGlmIChwZXJzaXN0VGltZXIpIGNsZWFyVGltZW91dChwZXJzaXN0VGltZXIpO1xuICBwZXJzaXN0VGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICBwZXJzaXN0VGltZXIgPSBudWxsO1xuICAgIHZvaWQgcGVyc2lzdENhY2hlKCk7XG4gIH0sIFBFUlNJU1RfREVCT1VOQ0VfTVMpO1xufVxuXG4vKiogU2F2ZSB0aGUgaW4tbWVtb3J5IGxpc3RzIG92ZXIgdGhlaXIgSW5kZXhlZERCIGVudHJpZXMsIGtlZXBpbmcgZWFjaCBlbnRyeSdzIHRpbWVzdGFtcC4gKi9cbmFzeW5jIGZ1bmN0aW9uIHBlcnNpc3RDYWNoZSgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgbGlzdHM6IFtzdHJpbmcsIFNjZW5lW10gfCBudWxsXVtdID0gW1xuICAgIFtcImFsbC1zY2VuZXNcIiwgc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzXSxcbiAgICBbXCJmaWx0ZXJlZC1zY2VuZXNcIiwgc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXNdLFxuICBdO1xuICBmb3IgKGNvbnN0IFtjYWNoZUtleSwgc2NlbmVzXSBvZiBsaXN0cykge1xuICAgIGlmICghc2NlbmVzKSBjb250aW51ZTtcbiAgICBjb25zdCBjYWNoZWQgPSBhd2FpdCBnZXRDYWNoZWRTY2VuZXMoY2FjaGVLZXkpO1xuICAgIC8vIE1pc3Npbmcgb3IgZXhwaXJlZDogdGhlIG5leHQgbG9hZCBmZXRjaGVzIGZyZXNoIGFueXdheS4gQSBkaWZmZXJlbnQgZmlsdGVyOiBub3QgdGhpcyBsaXN0LlxuICAgIGlmICghY2FjaGVkKSBjb250aW51ZTtcbiAgICBpZiAoY2FjaGVLZXkgPT09IFwiZmlsdGVyZWQtc2NlbmVzXCIgJiYgY2FjaGVkLmZpbHRlcktleSAhPT0gc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyS2V5KSBjb250aW51ZTtcbiAgICBhd2FpdCBzZXRDYWNoZWRTY2VuZXMoY2FjaGVLZXksIHNjZW5lcywgc2NlbmVzLmxlbmd0aCwgY2FjaGVkLmZpbHRlcktleSwgY2FjaGVkLnRpbWVzdGFtcCk7XG4gIH1cbn1cblxuLy8gRHJvcCBhIGRlbGV0ZWQgc2NlbmUgZnJvbSBldmVyeSBjYWNoZSB0aWVyIGFuZCB0aGUgbGVmdC1zaWRlIHNodWZmbGVcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZW1vdmVTY2VuZUV2ZXJ5d2hlcmUoc2NlbmVJZDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHdpdGhvdXQgPSAoc2NlbmVzOiBTY2VuZVtdIHwgbnVsbCk6IFNjZW5lW10gfCBudWxsID0+XG4gICAgc2NlbmVzID8gc2NlbmVzLmZpbHRlcigocykgPT4gcy5pZCAhPT0gc2NlbmVJZCkgOiBzY2VuZXM7XG5cbiAgc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzID0gd2l0aG91dChzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXMpO1xuICBzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJlZFNjZW5lcyA9IHdpdGhvdXQoc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXMpO1xuXG4gIGNvbnN0IHNodWZmbGVJZHggPSBzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzLmZpbmRJbmRleCgocykgPT4gcy5pZCA9PT0gc2NlbmVJZCk7XG4gIGlmIChzaHVmZmxlSWR4ICE9PSAtMSkge1xuICAgIHN0YXRlLnNodWZmbGVkRmlsdGVyZWRTY2VuZXMuc3BsaWNlKHNodWZmbGVJZHgsIDEpO1xuICAgIGlmIChzaHVmZmxlSWR4IDwgc3RhdGUuc2h1ZmZsZUluZGV4KSBzdGF0ZS5zaHVmZmxlSW5kZXgtLTtcbiAgfVxuXG4gIGZvciAoY29uc3QgY2FjaGVLZXkgb2YgW1wiYWxsLXNjZW5lc1wiLCBcImZpbHRlcmVkLXNjZW5lc1wiXSkge1xuICAgIGNvbnN0IGNhY2hlZCA9IGF3YWl0IGdldENhY2hlZFNjZW5lcyhjYWNoZUtleSk7XG4gICAgaWYgKGNhY2hlZCAmJiBjYWNoZWQuc2NlbmVzLnNvbWUoKHMpID0+IHMuaWQgPT09IHNjZW5lSWQpKSB7XG4gICAgICBjb25zdCBzY2VuZXMgPSBjYWNoZWQuc2NlbmVzLmZpbHRlcigocykgPT4gcy5pZCAhPT0gc2NlbmVJZCk7XG4gICAgICAvLyBLZWVwIHRoZSBvcmlnaW5hbCB0aW1lc3RhbXA6IHJlbW92aW5nIG9uZSBzY2VuZSBkb2Vzbid0IG1ha2UgdGhlIHJlc3QgYW55IGZyZXNoZXJcbiAgICAgIGF3YWl0IHNldENhY2hlZFNjZW5lcyhjYWNoZUtleSwgc2NlbmVzLCBzY2VuZXMubGVuZ3RoLCBjYWNoZWQuZmlsdGVyS2V5LCBjYWNoZWQudGltZXN0YW1wKTtcbiAgICB9XG4gIH1cbiAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIPCfl5HvuI8gUmVtb3ZlZCBzY2VuZSAke3NjZW5lSWR9IGZyb20gY2FjaGVzYCk7XG59XG4iLCAiLy8gU2NlbmUgbG9va3VwcyBmb3IgZGV0ZWN0aW5nIHNjZW5lcyBkZWxldGVkIHdoaWxlIHRoZXkgd2VyZSBpbiBhIGJhdHRsZSwgYW5kIGZvciBicmluZ2luZyBhXHJcbi8vIHNhdmVkIHBhaXIncyBFTE8gYW5kIFN0YXNoIHJhdGluZyB1cCB0byBkYXRlLlxyXG5cclxuaW1wb3J0IHsgZ3JhcGhxbFF1ZXJ5IH0gZnJvbSBcIi4vZ3JhcGhxbFwiO1xyXG5pbXBvcnQgdHlwZSB7IFNjZW5lIH0gZnJvbSBcIi4vdHlwZXNcIjtcclxuXHJcbmV4cG9ydCB0eXBlIFNjZW5lRmllbGRzID0gUGljazxTY2VuZSwgXCJpZFwiIHwgXCJyYXRpbmcxMDBcIiB8IFwiY3VzdG9tX2ZpZWxkc1wiPjtcclxuXHJcbi8qKlxyXG4gKiBUaGUgY3VycmVudCBTdGFzaCByYXRpbmcgYW5kIGN1c3RvbSBmaWVsZHMgb2YgdGhlc2Ugc2NlbmVzLCBieSBpZDsgaWRzIHRoYXQgbm8gbG9uZ2VyIGV4aXN0XHJcbiAqIGFyZSBtaXNzaW5nLiAoZmluZFNjZW5lcyhpZHMpIGVycm9ycyBvbiBhbnkgbWlzc2luZyBpZCwgc28gaXQncyBhbGlhc2VkIGZpbmRTY2VuZSBsb29rdXBzLilcclxuICovXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBmZXRjaFNjZW5lRmllbGRzKGlkczogc3RyaW5nW10pOiBQcm9taXNlPE1hcDxzdHJpbmcsIFNjZW5lRmllbGRzPj4ge1xyXG4gIGNvbnN0IGFsaWFzZXMgPSBpZHNcclxuICAgIC5tYXAoKGlkLCBpKSA9PiBgcyR7aX06IGZpbmRTY2VuZShpZDogJHtKU09OLnN0cmluZ2lmeShpZCl9KSB7IGlkIHJhdGluZzEwMCBjdXN0b21fZmllbGRzIH1gKVxyXG4gICAgLmpvaW4oXCJcXG5cIik7XHJcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZ3JhcGhxbFF1ZXJ5PFJlY29yZDxzdHJpbmcsIFNjZW5lRmllbGRzIHwgbnVsbD4+KGB7ICR7YWxpYXNlc30gfWApO1xyXG4gIHJldHVybiBuZXcgTWFwKE9iamVjdC52YWx1ZXMocmVzdWx0KS5mbGF0TWFwKChzKSA9PiAocyA/IFtbcy5pZCwgc10gYXMgY29uc3RdIDogW10pKSk7XHJcbn1cclxuXHJcbi8qKiBUcnVlIGZvciBHcmFwaFFMIGVycm9ycyBTdGFzaCByYWlzZXMgd2hlbiBhIHNjZW5lIGlkIG5vIGxvbmdlciBleGlzdHMuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBpc1NjZW5lTm90Rm91bmRFcnJvcihlcnJvcjogdW5rbm93bik6IGJvb2xlYW4ge1xyXG4gIHJldHVybiBlcnJvciBpbnN0YW5jZW9mIEVycm9yICYmIC9ub3QgZm91bmQvaS50ZXN0KGVycm9yLm1lc3NhZ2UpO1xyXG59XHJcbiIsICIvLyBQZXJzaXN0IEVMTyAoYW5kIFN0YXNoIHJhdGluZ3MpIHRvIFN0YXNoIGFuZCBrZWVwIHRoZSBsb2NhbCBjYWNoZSBpbiBzeW5jLlxuXG5pbXBvcnQgeyBsYXRlc3RTY2VuZSwgc2V0RWxvSW5DYWNoZSwgc2V0UmF0aW5nc0luQ2FjaGUgfSBmcm9tIFwiLi9jYWNoZVwiO1xuaW1wb3J0IHsgRUxPX0ZJRUxEX0tFWVMgfSBmcm9tIFwiLi9jb25zdGFudHNcIjtcbmltcG9ydCB7IGdyYXBocWxRdWVyeSwgcmVmcmVzaFN0YXNoQ2FjaGUgfSBmcm9tIFwiLi9ncmFwaHFsXCI7XG5pbXBvcnQgeyBpc1NjZW5lTm90Rm91bmRFcnJvciB9IGZyb20gXCIuL3NjZW5lQWN0aW9uc1wiO1xuaW1wb3J0IHsgZWxvQ3VzdG9tRmllbGRzLCBlbG9GaWVsZHMsIGlzU2VlZGVkLCBzdGFzaFJhdGluZ0NoYW5nZXMgfSBmcm9tIFwiLi9zY29yZVwiO1xuaW1wb3J0IHsgc3RhdGUgfSBmcm9tIFwiLi9zdGF0ZVwiO1xuaW1wb3J0IHR5cGUgeyBFbG9GaWVsZHMsIFNjZW5lIH0gZnJvbSBcIi4vdHlwZXNcIjtcblxuLyoqIFdpbmRvdyBldmVudCBmaXJlZCB3aGVuIGEgcmF0aW5nIHdyaXRlIGZpbmRzIHRoZSBzY2VuZSB3YXMgZGVsZXRlZCBlbHNld2hlcmUgKGRldGFpbCA9IHNjZW5lIGlkKS4gKi9cbmV4cG9ydCBjb25zdCBTQ0VORV9NSVNTSU5HX0VWRU5UID0gXCJzdGFzaC1iYXR0bGU6c2NlbmUtbWlzc2luZ1wiO1xuXG5jb25zdCBTQ0VORV9VUERBVEVfTVVUQVRJT04gPSBgXG4gICAgICBtdXRhdGlvbiBTY2VuZVVwZGF0ZSgkaW5wdXQ6IFNjZW5lVXBkYXRlSW5wdXQhKSB7XG4gICAgICAgIHNjZW5lVXBkYXRlKGlucHV0OiAkaW5wdXQpIHtcbiAgICAgICAgICBpZFxuICAgICAgICB9XG4gICAgICB9XG4gICAgYDtcblxuZnVuY3Rpb24gcmVwb3J0V3JpdGVFcnJvcihzY2VuZUlkOiBzdHJpbmcsIHdoYXQ6IHN0cmluZywgZTogdW5rbm93bik6IHZvaWQge1xuICBjb25zb2xlLmVycm9yKGBbU3Rhc2ggQmF0dGxlXSBGYWlsZWQgdG8gJHt3aGF0fSBmb3Igc2NlbmUgJHtzY2VuZUlkfTpgLCBlKTtcbiAgaWYgKGlzU2NlbmVOb3RGb3VuZEVycm9yKGUpKSB7XG4gICAgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEN1c3RvbUV2ZW50KFNDRU5FX01JU1NJTkdfRVZFTlQsIHsgZGV0YWlsOiBzY2VuZUlkIH0pKTtcbiAgfVxufVxuXG4vKiogVHJ1ZSB3aGVuIGJvdGggYXJlIHVucmF0ZWQsIG9yIGhvbGQgdGhlIHNhbWUgRUxPIGZpZWxkcy4gKi9cbmZ1bmN0aW9uIHNhbWVFbG8oYTogRWxvRmllbGRzIHwgbnVsbCwgYjogRWxvRmllbGRzIHwgbnVsbCk6IGJvb2xlYW4ge1xuICBpZiAoYSA9PT0gbnVsbCB8fCBiID09PSBudWxsKSByZXR1cm4gYSA9PT0gYjtcbiAgcmV0dXJuIGEuZWxvID09PSBiLmVsbyAmJiBhLmJhdHRsZXMgPT09IGIuYmF0dGxlcyAmJiBhLnNlZWRlZCA9PT0gYi5zZWVkZWQ7XG59XG5cbi8qKlxuICogVXBkYXRlIHRoZSBzY2VuZSBvYmplY3QsIHRoZSBjYWNoZSBhbmQgU3Rhc2gncyBwYWdlIGNhY2hlIHN0cmFpZ2h0IGF3YXkgKHNvIHRoZSBuZXh0IHBhaXJcbiAqIGFscmVhZHkgc2VlcyB0aGUgY2hhbmdlKSwgdGhlbiB3cml0ZSB0byBTdGFzaC4gSWYgdGhlIHdyaXRlIGZhaWxzLCBwdXQgdGhlIG9sZCB2YWx1ZSBiYWNrLFxuICogdW5sZXNzIGEgbGF0ZXIgd3JpdGUgaGFzIHJlcGxhY2VkIGl0IHNpbmNlLiBTdGFzaCByYXRpbmdzIHN5bmMgb25seSBhZnRlciBhIHN1Y2Nlc3NmdWwgd3JpdGUuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHNhdmVFbG9GaWVsZHMoc2NlbmU6IFNjZW5lLCB2YWx1ZTogRWxvRmllbGRzIHwgbnVsbCwgY3VzdG9tRmllbGRzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiwgd2hhdDogc3RyaW5nKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGNvbnN0IHByZXZpb3VzID0gZWxvRmllbGRzKGxhdGVzdFNjZW5lKHNjZW5lKSk7XG4gIHNldEVsb0luQ2FjaGUoc2NlbmUsIHZhbHVlKTtcbiAgcmVmcmVzaFN0YXNoQ2FjaGUoW3sgaWQ6IHNjZW5lLmlkLCBlbG86IHZhbHVlIH1dLCBmYWxzZSk7XG4gIHRyeSB7XG4gICAgYXdhaXQgZ3JhcGhxbFF1ZXJ5KFNDRU5FX1VQREFURV9NVVRBVElPTiwgeyBpbnB1dDogeyBpZDogc2NlbmUuaWQsIGN1c3RvbV9maWVsZHM6IGN1c3RvbUZpZWxkcyB9IH0pO1xuICB9IGNhdGNoIChlKSB7XG4gICAgcmVwb3J0V3JpdGVFcnJvcihzY2VuZS5pZCwgd2hhdCwgZSk7XG4gICAgaWYgKHNhbWVFbG8oZWxvRmllbGRzKGxhdGVzdFNjZW5lKHNjZW5lKSksIHZhbHVlKSkge1xuICAgICAgc2V0RWxvSW5DYWNoZShzY2VuZSwgcHJldmlvdXMpO1xuICAgICAgcmVmcmVzaFN0YXNoQ2FjaGUoW3sgaWQ6IHNjZW5lLmlkLCBlbG86IHByZXZpb3VzIH1dLCBmYWxzZSk7XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICBzY2hlZHVsZVN0YXNoUmF0aW5nU3luYygpO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuLyoqXG4gKiBTYXZlIGEgc2NlbmUncyBFTE8gYW5kIGJhdHRsZSBjb3VudCAoY3VzdG9tIGZpZWxkcyBvbmx5OyBgcGFydGlhbGAgbGVhdmVzIG90aGVyIHBsdWdpbnMnXG4gKiBmaWVsZHMgYWxvbmUpLiBXaGV0aGVyIGl0IHdhcyBzZWVkZWQgc3RheXMgYXMgaXQgd2FzLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gd3JpdGVFbG8oc2NlbmU6IFNjZW5lLCBlbG86IG51bWJlciwgYmF0dGxlczogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHZhbHVlID0geyBlbG8sIGJhdHRsZXMsIHNlZWRlZDogaXNTZWVkZWQoc2NlbmUpIH07XG4gIGlmIChhd2FpdCBzYXZlRWxvRmllbGRzKHNjZW5lLCB2YWx1ZSwgeyBwYXJ0aWFsOiBlbG9DdXN0b21GaWVsZHModmFsdWUpIH0sIFwic2F2ZSBFTE9cIikpIHtcbiAgICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g8J+TnSBTYXZlZCBzY2VuZSAke3NjZW5lLmlkfSBFTE8gJHtlbG99ICgke2JhdHRsZXN9IGJhdHRsZXMpYCk7XG4gIH1cbn1cblxuLyoqIFJlbW92ZSBhIHNjZW5lJ3MgRUxPIGZpZWxkcywgbWFraW5nIGl0IHVucmF0ZWQgYWdhaW4uICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY2xlYXJFbG8oc2NlbmU6IFNjZW5lKTogUHJvbWlzZTx2b2lkPiB7XG4gIGlmIChhd2FpdCBzYXZlRWxvRmllbGRzKHNjZW5lLCBudWxsLCB7IHJlbW92ZTogRUxPX0ZJRUxEX0tFWVMgfSwgXCJjbGVhciBFTE9cIikpIHtcbiAgICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g8J+TnSBDbGVhcmVkIHNjZW5lICR7c2NlbmUuaWR9IEVMT2ApO1xuICB9XG59XG5cbi8qKlxuICogV3JpdGUgU3Rhc2ggcmF0aW5ncyAoc2NlbmUgaWQgdG8gMS0xMDApIGluIG9uZSBHcmFwaFFMIHJlcXVlc3Q6IG9uZSBhbGlhc2VkIGJ1bGtTY2VuZVVwZGF0ZVxuICogcGVyIGRpc3RpbmN0IHZhbHVlLiBUaHJvd3Mgb24gZmFpbHVyZTsgZG9lc24ndCB0b3VjaCB0aGUgY2FjaGUuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB3cml0ZVN0YXNoUmF0aW5ncyhyYXRpbmdzOiBNYXA8c3RyaW5nLCBudW1iZXI+KTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGlkc0J5UmF0aW5nID0gbmV3IE1hcDxudW1iZXIsIHN0cmluZ1tdPigpO1xuICBmb3IgKGNvbnN0IFtpZCwgcmF0aW5nXSBvZiByYXRpbmdzKSB7XG4gICAgY29uc3QgaWRzID0gaWRzQnlSYXRpbmcuZ2V0KHJhdGluZykgPz8gW107XG4gICAgaWRzLnB1c2goaWQpO1xuICAgIGlkc0J5UmF0aW5nLnNldChyYXRpbmcsIGlkcyk7XG4gIH1cbiAgaWYgKGlkc0J5UmF0aW5nLnNpemUgPT09IDApIHJldHVybjtcblxuICBjb25zdCB2YWx1ZXMgPSBbLi4uaWRzQnlSYXRpbmcua2V5cygpXTtcbiAgY29uc3QgbXV0YXRpb24gPSBgXG4gICAgICBtdXRhdGlvbiBTeW5jU3Rhc2hSYXRpbmdzKCR7dmFsdWVzLm1hcCgocikgPT4gYCRyJHtyfTogQnVsa1NjZW5lVXBkYXRlSW5wdXQhYCkuam9pbihcIiwgXCIpfSkge1xuICAgICAgICAke3ZhbHVlcy5tYXAoKHIpID0+IGByJHtyfTogYnVsa1NjZW5lVXBkYXRlKGlucHV0OiAkciR7cn0pIHsgaWQgfWApLmpvaW4oXCJcXG4gICAgICAgIFwiKX1cbiAgICAgIH1cbiAgICBgO1xuICBjb25zdCB2YXJpYWJsZXMgPSBPYmplY3QuZnJvbUVudHJpZXMoXG4gICAgdmFsdWVzLm1hcCgocikgPT4gW2ByJHtyfWAsIHsgaWRzOiBpZHNCeVJhdGluZy5nZXQociksIHJhdGluZzEwMDogciB9XSksXG4gICk7XG4gIGF3YWl0IGdyYXBocWxRdWVyeShtdXRhdGlvbiwgdmFyaWFibGVzKTtcbiAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIPCfk50gV3JvdGUgJHtyYXRpbmdzLnNpemV9IFN0YXNoIHJhdGluZ3MgKCR7dmFsdWVzLmxlbmd0aH0gZGlzdGluY3QgdmFsdWVzKWApO1xufVxuXG4vKiogQWZ0ZXIgU3Rhc2ggcmF0aW5ncyB3ZXJlIHdyaXR0ZW46IHVwZGF0ZSB0aGUgY2FjaGVkIHNjZW5lcyBhbmQgU3Rhc2gncyBvd24gcGFnZSBjYWNoZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhcHBseVN0YXNoUmF0aW5ncyhyYXRpbmdzOiBNYXA8c3RyaW5nLCBudW1iZXI+KTogdm9pZCB7XG4gIHNldFJhdGluZ3NJbkNhY2hlKHJhdGluZ3MpO1xuICByZWZyZXNoU3Rhc2hDYWNoZShcbiAgICBbLi4ucmF0aW5nc10ubWFwKChbaWQsIHJhdGluZzEwMF0pID0+ICh7IGlkLCByYXRpbmcxMDAgfSkpLFxuICAgIHJhdGluZ3Muc2l6ZSA+IDAsXG4gICk7XG59XG5cbi8qKiBXYWl0IHRoaXMgbG9uZyBhZnRlciB0aGUgbGFzdCBFTE8gd3JpdGUsIHNvIGJvdGggc2NlbmVzIG9mIGEgcGljayBzeW5jIGluIG9uZSByZXF1ZXN0LiAqL1xuY29uc3QgU1lOQ19ERUJPVU5DRV9NUyA9IDUwMDtcbmxldCBzeW5jVGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XG5cbi8qKiBTeW5jIFN0YXNoIHJhdGluZ3Mgc29vbiAoZGVib3VuY2VkKSwgdW5sZXNzIHRoZSBcIlN0YXNoIHJhdGluZ3NcIiBzZXR0aW5nIGlzIFwib2ZmXCIuICovXG5leHBvcnQgZnVuY3Rpb24gc2NoZWR1bGVTdGFzaFJhdGluZ1N5bmMoKTogdm9pZCB7XG4gIGlmIChzdGF0ZS5zZXR0aW5ncy5zdGFzaFJhdGluZ3MgPT09IFwib2ZmXCIpIHJldHVybjtcbiAgaWYgKHN5bmNUaW1lcikgY2xlYXJUaW1lb3V0KHN5bmNUaW1lcik7XG4gIHN5bmNUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgIHN5bmNUaW1lciA9IG51bGw7XG4gICAgdm9pZCBzeW5jU3Rhc2hSYXRpbmdzKCk7XG4gIH0sIFNZTkNfREVCT1VOQ0VfTVMpO1xufVxuXG4vKiogVGhlIFN0YXNoIHJhdGluZyB3cml0ZSBpbiBwcm9ncmVzcyAob3IgdGhlIGxhc3Qgb25lKSwgc28gdGhlIG5leHQgd2FpdHMgZm9yIGl0LiAqL1xubGV0IHJhdGluZ1dyaXRlczogUHJvbWlzZTx1bmtub3duPiA9IFByb21pc2UucmVzb2x2ZSgpO1xuXG4vKipcbiAqIFJ1biBhIFN0YXNoIHJhdGluZ3Mgd3JpdGUgYWZ0ZXIgYW55IGluIHByb2dyZXNzLCBzbyBlYWNoIG9uZSBzdGFydHMgZnJvbSB0aGUgcmF0aW5ncyB0aGVcbiAqIHByZXZpb3VzIG9uZSB3cm90ZSAob3ZlcmxhcHBpbmcgd3JpdGVzIGNvdWxkIHJlcGVhdCB3b3JrIG9yIGZpbmlzaCBvdXQgb2Ygb3JkZXIpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcXVldWVSYXRpbmdXcml0ZTxUPih0YXNrOiAoKSA9PiBQcm9taXNlPFQ+KTogUHJvbWlzZTxUPiB7XG4gIGNvbnN0IHJ1biA9IHJhdGluZ1dyaXRlcy50aGVuKHRhc2spO1xuICByYXRpbmdXcml0ZXMgPSBydW4uY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcbiAgcmV0dXJuIHJ1bjtcbn1cblxuLyoqXG4gKiBCcmluZyBTdGFzaCByYXRpbmdzIGluIGxpbmUgd2l0aCBFTE8gZm9yIHRoZSB3aG9sZSBsaWJyYXJ5ICh0aGUgYWxsLXNjZW5lcyBjYWNoZSk6IHdvcmsgb3V0XG4gKiBldmVyeSBzY2VuZSdzIHRhcmdldCB1bmRlciB0aGUgY3VycmVudCBzZXR0aW5nLCBhbmQgd3JpdGUgb25seSB0aGUgb25lcyB0aGF0IGRpZmZlciBmcm9tIHRoZVxuICogY2FjaGVkIHJhdGluZywgaW4gb25lIHJlcXVlc3QuIFF1ZXVlZCBiZWhpbmQgYW55IHdyaXRlIGluIHByb2dyZXNzLiBSZXR1cm5zIGhvdyBtYW55IHdlcmUgd3JpdHRlbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN5bmNTdGFzaFJhdGluZ3MoKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgcmV0dXJuIHF1ZXVlUmF0aW5nV3JpdGUoYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IG1vZGUgPSBzdGF0ZS5zZXR0aW5ncy5zdGFzaFJhdGluZ3M7XG4gICAgY29uc3Qgc2NlbmVzID0gc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzO1xuICAgIGlmIChtb2RlID09PSBcIm9mZlwiIHx8ICFzY2VuZXMpIHJldHVybiAwO1xuICAgIGNvbnN0IGNoYW5nZXMgPSBzdGFzaFJhdGluZ0NoYW5nZXMoc2NlbmVzLCBtb2RlKTtcbiAgICBpZiAoY2hhbmdlcy5zaXplID09PSAwKSByZXR1cm4gMDtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgd3JpdGVTdGFzaFJhdGluZ3MoY2hhbmdlcyk7XG4gICAgICBhcHBseVN0YXNoUmF0aW5ncyhjaGFuZ2VzKTtcbiAgICAgIHJldHVybiBjaGFuZ2VzLnNpemU7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIEZhaWxlZCB0byBzeW5jIFN0YXNoIHJhdGluZ3M6XCIsIGUpO1xuICAgICAgcmV0dXJuIDA7XG4gICAgfVxuICB9KTtcbn1cbiIsICIvLyBPbmUtdGltZSBFTE8gc2V0dXA6IGdpdmUgZXZlcnkgc2NlbmUgYSBzdGFydGluZyBFTE8gKGZyb20gaXRzIFN0YXNoIHJhdGluZywgb3IgMTUwMCBmb3IgYWxsKSxcbi8vIHRoZW4gb3B0aW9uYWxseSBzeW5jIFN0YXNoIHJhdGluZ3MgZnJvbSB0aGUgbmV3IEVMTy4gUmUtcnVubmluZyBpdCBvdmVyd3JpdGVzLCBzbyBhblxuLy8gaW50ZXJydXB0ZWQgc2V0dXAgaXMgc2FmZSB0byByZXBlYXQuXG5cbmltcG9ydCB7IEVMT19GSUVMRF9LRVlTLCBFTE9fU1RBUlQgfSBmcm9tIFwiLi9jb25zdGFudHNcIjtcbmltcG9ydCB7IGdyYXBocWxRdWVyeSwgcmVmcmVzaFN0YXNoQ2FjaGUgfSBmcm9tIFwiLi9ncmFwaHFsXCI7XG5pbXBvcnQgeyB3cml0ZVN0YXNoUmF0aW5ncyB9IGZyb20gXCIuL3JhdGluZ1wiO1xuaW1wb3J0IHsgYWZ0ZXJTZXR1cCwgZWxvQ3VzdG9tRmllbGRzLCBpc1JhdGVkLCBzZWVkLCBzdGFydGluZ0Vsbywgc3Rhc2hSYXRpbmdDaGFuZ2VzIH0gZnJvbSBcIi4vc2NvcmVcIjtcbmltcG9ydCB0eXBlIHsgRWxvU3RhcnQsIFNjZW5lLCBTdGFzaFJhdGluZ3NNb2RlIH0gZnJvbSBcIi4vdHlwZXNcIjtcblxuZXhwb3J0IHR5cGUgU2V0dXBQaGFzZSA9IFwiZWxvXCIgfCBcInJhdGluZ3NcIjtcblxuLyoqIFByb2dyZXNzIGNhbGxiYWNrOiBgZG9uZWAgb2YgYHRvdGFsYCBzY2VuZXMgZmluaXNoZWQgaW4gdGhpcyBwaGFzZS4gKi9cbmV4cG9ydCB0eXBlIFNldHVwUHJvZ3Jlc3MgPSAocGhhc2U6IFNldHVwUGhhc2UsIGRvbmU6IG51bWJlciwgdG90YWw6IG51bWJlcikgPT4gdm9pZDtcblxuZXhwb3J0IGludGVyZmFjZSBTZXR1cFN1bW1hcnkge1xuICBlbG9Xcml0dGVuOiBudW1iZXI7IC8vIFNjZW5lcyBnaXZlbiBhIHN0YXJ0aW5nIEVMT1xuICBlbG9DbGVhcmVkOiBudW1iZXI7IC8vIFNjZW5lcyB3aG9zZSBvbGQgRUxPIHdhcyByZW1vdmVkIChyZS1ydW4gd2l0aCBcIlVzZSBteSByYXRpbmdzXCIpXG4gIHJhdGluZ3NXcml0dGVuOiBudW1iZXI7IC8vIFN0YXNoIHJhdGluZ3MgY2hhbmdlZFxufVxuXG5jb25zdCBTRVRVUF9TQ0VORVNfUVVFUlkgPSBgXG4gICAgICBxdWVyeSBGaW5kU2NlbmVzRm9yRWxvU2V0dXAge1xuICAgICAgICBmaW5kU2NlbmVzKGZpbHRlcjogeyBwZXJfcGFnZTogLTEgfSkge1xuICAgICAgICAgIHNjZW5lcyB7XG4gICAgICAgICAgICBpZFxuICAgICAgICAgICAgcmF0aW5nMTAwXG4gICAgICAgICAgICBjdXN0b21fZmllbGRzXG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgYDtcblxuLyoqIEV2ZXJ5IHNjZW5lJ3MgaWQsIFN0YXNoIHJhdGluZyBhbmQgY3VzdG9tIGZpZWxkcywgZnJlc2ggZnJvbSBTdGFzaCAobm90IHRoZSA1LW1pbnV0ZSBjYWNoZSkuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmV0Y2hTZXR1cFNjZW5lcygpOiBQcm9taXNlPFNjZW5lW10+IHtcbiAgY29uc3QgZGF0YSA9IGF3YWl0IGdyYXBocWxRdWVyeTx7IGZpbmRTY2VuZXM6IHsgc2NlbmVzOiBTY2VuZVtdIH0gfT4oU0VUVVBfU0NFTkVTX1FVRVJZKTtcbiAgcmV0dXJuIGRhdGEuZmluZFNjZW5lcy5zY2VuZXMgPz8gW107XG59XG5cbi8qKiBUaGUgU3Rhc2ggcmF0aW5ncyB0aGUgc2V0dXAgd291bGQgY2hhbmdlOiBzY2VuZSBpZCB0byBuZXcgcmF0aW5nIChub25lIGZvciBcIm9mZlwiKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZXR1cFJhdGluZ0NoYW5nZXMoc2NlbmVzOiBTY2VuZVtdLCBzdGFydDogRWxvU3RhcnQsIHN0YXNoUmF0aW5nczogU3Rhc2hSYXRpbmdzTW9kZSk6IE1hcDxzdHJpbmcsIG51bWJlcj4ge1xuICByZXR1cm4gc3Rhc2hSYXRpbmdDaGFuZ2VzKFxuICAgIHNjZW5lcy5tYXAoKHNjZW5lKSA9PiBhZnRlclNldHVwKHNjZW5lLCBzdGFydCkpLFxuICAgIHN0YXNoUmF0aW5ncyxcbiAgKTtcbn1cblxuY29uc3QgQlVMS19VUERBVEVfTVVUQVRJT04gPSBgXG4gICAgICBtdXRhdGlvbiBCdWxrU2NlbmVVcGRhdGUoJGlucHV0OiBCdWxrU2NlbmVVcGRhdGVJbnB1dCEpIHtcbiAgICAgICAgYnVsa1NjZW5lVXBkYXRlKGlucHV0OiAkaW5wdXQpIHtcbiAgICAgICAgICBpZFxuICAgICAgICB9XG4gICAgICB9XG4gICAgYDtcblxuLyoqXG4gKiBTZWVkIGVhY2ggcmF0ZWQgc2NlbmUgZnJvbSBpdHMgb3duIHJhdGluZy4gU2NlbmVzIHdpdGggdGhlIHNhbWUgU3Rhc2ggcmF0aW5nIGdldCB0aGUgc2FtZVxuICogc3RhcnRpbmcgZmllbGRzLCBzbyBpdCdzIG9uZSBhbGlhc2VkIGJ1bGtTY2VuZVVwZGF0ZSBwZXIgZGlzdGluY3QgcmF0aW5nLCBhbGwgaW4gb25lIHJlcXVlc3QuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHNlZWRGcm9tUmF0aW5ncyhyYXRlZDogU2NlbmVbXSk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBpZHNCeVJhdGluZyA9IG5ldyBNYXA8bnVtYmVyLCBzdHJpbmdbXT4oKTtcbiAgZm9yIChjb25zdCBzY2VuZSBvZiByYXRlZCkge1xuICAgIGNvbnN0IHJhdGluZyA9IHNjZW5lLnJhdGluZzEwMCBhcyBudW1iZXI7XG4gICAgY29uc3QgaWRzID0gaWRzQnlSYXRpbmcuZ2V0KHJhdGluZykgPz8gW107XG4gICAgaWRzLnB1c2goc2NlbmUuaWQpO1xuICAgIGlkc0J5UmF0aW5nLnNldChyYXRpbmcsIGlkcyk7XG4gIH1cbiAgaWYgKGlkc0J5UmF0aW5nLnNpemUgPT09IDApIHJldHVybjtcblxuICBjb25zdCB2YWx1ZXMgPSBbLi4uaWRzQnlSYXRpbmcua2V5cygpXTtcbiAgY29uc3QgbXV0YXRpb24gPSBgXG4gICAgICBtdXRhdGlvbiBTZWVkRWxvKCR7dmFsdWVzLm1hcCgocikgPT4gYCRzJHtyfTogQnVsa1NjZW5lVXBkYXRlSW5wdXQhYCkuam9pbihcIiwgXCIpfSkge1xuICAgICAgICAke3ZhbHVlcy5tYXAoKHIpID0+IGBzJHtyfTogYnVsa1NjZW5lVXBkYXRlKGlucHV0OiAkcyR7cn0pIHsgaWQgfWApLmpvaW4oXCJcXG4gICAgICAgIFwiKX1cbiAgICAgIH1cbiAgICBgO1xuICBjb25zdCB2YXJpYWJsZXMgPSBPYmplY3QuZnJvbUVudHJpZXMoXG4gICAgdmFsdWVzLm1hcCgocikgPT4ge1xuICAgICAgY29uc3QgcGFydGlhbCA9IGVsb0N1c3RvbUZpZWxkcyh7IGVsbzogc2VlZChyKSwgYmF0dGxlczogMCwgc2VlZGVkOiB0cnVlIH0pO1xuICAgICAgcmV0dXJuIFtgcyR7cn1gLCB7IGlkczogaWRzQnlSYXRpbmcuZ2V0KHIpLCBjdXN0b21fZmllbGRzOiB7IHBhcnRpYWwgfSB9XTtcbiAgICB9KSxcbiAgKTtcbiAgYXdhaXQgZ3JhcGhxbFF1ZXJ5KG11dGF0aW9uLCB2YXJpYWJsZXMpO1xufVxuXG4vKipcbiAqIFJ1biB0aGUgc2V0dXAgb24gYHNjZW5lc2AgKGZyb20gZmV0Y2hTZXR1cFNjZW5lcyk6IHdyaXRlIHRoZSBzdGFydGluZyBFTE8sIHRoZW4sIHVubGVzc1xuICogc3Rhc2hSYXRpbmdzIGlzIFwib2ZmXCIsIHRoZSBTdGFzaCByYXRpbmdzIHRoYXQgY2hhbmdlLiBUaHJvd3MgaWYgYSByZXF1ZXN0IGZhaWxzOyB3aGF0ZXZlclxuICogd2FzIHdyaXR0ZW4gYnkgdGhlbiBzdGF5cywgYW5kIHJ1bm5pbmcgaXQgYWdhaW4gb3ZlcndyaXRlcyBpdC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bkVsb1NldHVwKFxuICBzY2VuZXM6IFNjZW5lW10sXG4gIHN0YXJ0OiBFbG9TdGFydCxcbiAgc3Rhc2hSYXRpbmdzOiBTdGFzaFJhdGluZ3NNb2RlLFxuICBvblByb2dyZXNzOiBTZXR1cFByb2dyZXNzLFxuKTogUHJvbWlzZTxTZXR1cFN1bW1hcnk+IHtcbiAgY29uc3Qgc3VtbWFyeTogU2V0dXBTdW1tYXJ5ID0geyBlbG9Xcml0dGVuOiAwLCBlbG9DbGVhcmVkOiAwLCByYXRpbmdzV3JpdHRlbjogMCB9O1xuXG4gIGlmIChzdGFydCA9PT0gXCJyYXRpbmdzXCIpIHtcbiAgICBjb25zdCByYXRlZCA9IHNjZW5lcy5maWx0ZXIoKHNjZW5lKSA9PiBzY2VuZS5yYXRpbmcxMDAgIT0gbnVsbCk7XG4gICAgb25Qcm9ncmVzcyhcImVsb1wiLCAwLCByYXRlZC5sZW5ndGgpO1xuICAgIGF3YWl0IHNlZWRGcm9tUmF0aW5ncyhyYXRlZCk7XG4gICAgb25Qcm9ncmVzcyhcImVsb1wiLCByYXRlZC5sZW5ndGgsIHJhdGVkLmxlbmd0aCk7XG4gICAgc3VtbWFyeS5lbG9Xcml0dGVuID0gcmF0ZWQubGVuZ3RoO1xuXG4gICAgLy8gT25seSBtYXR0ZXJzIG9uIGEgcmUtcnVuOiBzY2VuZXMgd2l0aCBhbiBFTE8gYnV0IG5vIFN0YXNoIHJhdGluZyBiZWNvbWUgdW5yYXRlZCBhZ2FpblxuICAgIGNvbnN0IHN0YWxlID0gc2NlbmVzLmZpbHRlcigoc2NlbmUpID0+IHNjZW5lLnJhdGluZzEwMCA9PSBudWxsICYmIGlzUmF0ZWQoc2NlbmUpKS5tYXAoKHNjZW5lKSA9PiBzY2VuZS5pZCk7XG4gICAgaWYgKHN0YWxlLmxlbmd0aCA+IDApIHtcbiAgICAgIGF3YWl0IGdyYXBocWxRdWVyeShCVUxLX1VQREFURV9NVVRBVElPTiwge1xuICAgICAgICBpbnB1dDogeyBpZHM6IHN0YWxlLCBjdXN0b21fZmllbGRzOiB7IHJlbW92ZTogRUxPX0ZJRUxEX0tFWVMgfSB9LFxuICAgICAgfSk7XG4gICAgICBzdW1tYXJ5LmVsb0NsZWFyZWQgPSBzdGFsZS5sZW5ndGg7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIGNvbnN0IGlkcyA9IHNjZW5lcy5tYXAoKHNjZW5lKSA9PiBzY2VuZS5pZCk7XG4gICAgb25Qcm9ncmVzcyhcImVsb1wiLCAwLCBpZHMubGVuZ3RoKTtcbiAgICBpZiAoaWRzLmxlbmd0aCA+IDApIHtcbiAgICAgIGF3YWl0IGdyYXBocWxRdWVyeShCVUxLX1VQREFURV9NVVRBVElPTiwge1xuICAgICAgICBpbnB1dDogeyBpZHMsIGN1c3RvbV9maWVsZHM6IHsgcGFydGlhbDogZWxvQ3VzdG9tRmllbGRzKHsgZWxvOiBFTE9fU1RBUlQsIGJhdHRsZXM6IDAsIHNlZWRlZDogZmFsc2UgfSkgfSB9LFxuICAgICAgfSk7XG4gICAgfVxuICAgIG9uUHJvZ3Jlc3MoXCJlbG9cIiwgaWRzLmxlbmd0aCwgaWRzLmxlbmd0aCk7XG4gICAgc3VtbWFyeS5lbG9Xcml0dGVuID0gaWRzLmxlbmd0aDtcbiAgfVxuXG4gIGNvbnN0IGNoYW5nZXMgPSBzZXR1cFJhdGluZ0NoYW5nZXMoc2NlbmVzLCBzdGFydCwgc3Rhc2hSYXRpbmdzKTtcbiAgaWYgKGNoYW5nZXMuc2l6ZSA+IDApIHtcbiAgICBvblByb2dyZXNzKFwicmF0aW5nc1wiLCAwLCBjaGFuZ2VzLnNpemUpO1xuICAgIGF3YWl0IHdyaXRlU3Rhc2hSYXRpbmdzKGNoYW5nZXMpO1xuICAgIG9uUHJvZ3Jlc3MoXCJyYXRpbmdzXCIsIGNoYW5nZXMuc2l6ZSwgY2hhbmdlcy5zaXplKTtcbiAgICBzdW1tYXJ5LnJhdGluZ3NXcml0dGVuID0gY2hhbmdlcy5zaXplO1xuICB9XG5cbiAgLy8gU3Rhc2gncyBvd24gcGFnZXM6IGV2ZXJ5IHNjZW5lJ3MgRUxPIChvciBpdHMgcmVtb3ZhbCkgYW5kIGFueSBjaGFuZ2VkIHJhdGluZ1xuICByZWZyZXNoU3Rhc2hDYWNoZShcbiAgICBzY2VuZXMubWFwKChzY2VuZSkgPT4gKHsgaWQ6IHNjZW5lLmlkLCBlbG86IHN0YXJ0aW5nRWxvKHNjZW5lLCBzdGFydCksIHJhdGluZzEwMDogY2hhbmdlcy5nZXQoc2NlbmUuaWQpIH0pKSxcbiAgICBjaGFuZ2VzLnNpemUgPiAwLFxuICApO1xuXG4gIGNvbnNvbGUubG9nKFxuICAgIGBbU3Rhc2ggQmF0dGxlXSDinIUgRUxPIHNldHVwICgke3N0YXJ0fSwgU3Rhc2ggcmF0aW5ncyAke3N0YXNoUmF0aW5nc30pOiAke3N1bW1hcnkuZWxvV3JpdHRlbn0gRUxPIHdyaXR0ZW4sICR7c3VtbWFyeS5lbG9DbGVhcmVkfSBjbGVhcmVkLCAke3N1bW1hcnkucmF0aW5nc1dyaXR0ZW59IFN0YXNoIHJhdGluZ3Mgd3JpdHRlbmAsXG4gICk7XG4gIHJldHVybiBzdW1tYXJ5O1xufVxuIiwgIi8vIFVzZXIgc2V0dGluZ3Mgc3RvcmVkIGluIFN0YXNoJ3MgcGx1Z2luIGNvbmZpZ3VyYXRpb24gKGNvbmZpZ3VyYXRpb24ucGx1Z2luc1tcInN0YXNoLWJhdHRsZVwiXSksXG4vLyBzbyB0aGV5IGZvbGxvdyB0aGUgdXNlciBhY3Jvc3MgYnJvd3NlcnMuIEFsc28gZWRpdGFibGUgaW4gU3Rhc2gg4oaSIFNldHRpbmdzIOKGkiBQbHVnaW5zLlxuXG5pbXBvcnQge1xuICBERUZBVUxUX1NFVFRJTkdTLFxuICBMRUdBQ1lfRklMVEVSX09QUE9ORU5UU19LRVksXG4gIExFR0FDWV9NVVRFX1BSRVZJRVdTX0tFWSxcbiAgUExVR0lOX0lELFxufSBmcm9tIFwiLi9jb25zdGFudHNcIjtcbmltcG9ydCB7IGdyYXBocWxRdWVyeSB9IGZyb20gXCIuL2dyYXBocWxcIjtcbmltcG9ydCB7IHN0YXRlIH0gZnJvbSBcIi4vc3RhdGVcIjtcbmltcG9ydCB0eXBlIHsgRWxvU3RhcnQsIFNldHRpbmdzLCBTdGFzaFJhdGluZ3NNb2RlIH0gZnJvbSBcIi4vdHlwZXNcIjtcblxuY29uc3QgQ09ORklHX1FVRVJZID0gYHsgY29uZmlndXJhdGlvbiB7IHBsdWdpbnMgfSB9YDtcblxuY29uc3QgQ09ORklHVVJFX1BMVUdJTl9NVVRBVElPTiA9IGBcbiAgICAgIG11dGF0aW9uIENvbmZpZ3VyZVBsdWdpbigkcGx1Z2luX2lkOiBJRCEsICRpbnB1dDogTWFwISkge1xuICAgICAgICBjb25maWd1cmVQbHVnaW4ocGx1Z2luX2lkOiAkcGx1Z2luX2lkLCBpbnB1dDogJGlucHV0KVxuICAgICAgfVxuICAgIGA7XG5cbmNvbnN0IFNBVkVfREVCT1VOQ0VfTVMgPSA0MDA7XG5sZXQgc2F2ZVRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xuXG4vKiogUHJlLTMuMCBmdW4gbW9kZSB3YXMgb24gaW4gdGhlIHN0b3JlZCBjb25maWcgKHNvIEJhdHRsZSB3YXNuJ3QgY2hhbmdpbmcgU3Rhc2ggcmF0aW5ncykuICovXG5sZXQgbGVnYWN5RnVuTW9kZSA9IGZhbHNlO1xuXG5jb25zdCBTVEFTSF9SQVRJTkdTX01PREVTOiByZWFkb25seSBTdGFzaFJhdGluZ3NNb2RlW10gPSBbXCJvZmZcIiwgXCJwZXJjZW50aWxlXCIsIFwibGluZWFyXCJdO1xuY29uc3QgRUxPX1NUQVJUUzogcmVhZG9ubHkgRWxvU3RhcnRbXSA9IFtcInJhdGluZ3NcIiwgXCJmcmVzaFwiXTtcblxuZnVuY3Rpb24gb25lT2Y8VCBleHRlbmRzIHN0cmluZz4odmFsdWU6IHVua25vd24sIGFsbG93ZWQ6IHJlYWRvbmx5IFRbXSwgZmFsbGJhY2s6IFQpOiBUIHtcbiAgcmV0dXJuIGFsbG93ZWQuaW5jbHVkZXModmFsdWUgYXMgVCkgPyAodmFsdWUgYXMgVCkgOiBmYWxsYmFjaztcbn1cblxuZnVuY3Rpb24gY2xhbXBQZXJjZW50KHZhbHVlOiB1bmtub3duLCBmYWxsYmFjazogbnVtYmVyKTogbnVtYmVyIHtcbiAgY29uc3QgbiA9IE51bWJlcih2YWx1ZSk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobikgPyBNYXRoLm1pbigxMDAsIE1hdGgubWF4KDAsIE1hdGgucm91bmQobikpKSA6IGZhbGxiYWNrO1xufVxuXG4vKiogQ29lcmNlIGEgc3RvcmVkIGNvbmZpZyBtYXAgaW50byBTZXR0aW5ncyAoU3Rhc2ggbWF5IG9taXQga2V5cyBvciBzdG9yZSBudW1iZXJzIGFzIHN0cmluZ3MpLiAqL1xuZnVuY3Rpb24gbm9ybWFsaXplKHJhdzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sIGJhc2U6IFNldHRpbmdzKTogU2V0dGluZ3Mge1xuICBjb25zdCBib29sID0gKGtleToga2V5b2YgU2V0dGluZ3MpOiBib29sZWFuID0+XG4gICAgdHlwZW9mIHJhd1trZXldID09PSBcImJvb2xlYW5cIiA/IChyYXdba2V5XSBhcyBib29sZWFuKSA6IChiYXNlW2tleV0gYXMgYm9vbGVhbik7XG4gIHJldHVybiB7XG4gICAgLy8gQSBtaXNzaW5nIG9yIHVua25vd24gdmFsdWUgaXMgXCJvZmZcIi4gKFJlbW92ZWQga2V5cywgZnVuTW9kZSBhbmQgdW5yYXRlZFJhdGluZywgYXJlIGRyb3BwZWQuKVxuICAgIHN0YXNoUmF0aW5nczogb25lT2YocmF3LnN0YXNoUmF0aW5ncywgU1RBU0hfUkFUSU5HU19NT0RFUywgXCJvZmZcIiksXG4gICAgLy8gU2V0dXAgZmxhZ3MgaGF2ZSBubyBmYWxsYmFjazogcmF3IGFsd2F5cyBjYXJyaWVzIHRoZW0gKHN0b3JlZCBjb25maWcsIG9yIGN1cnJlbnQgKyBwYXRjaClcbiAgICBlbG9TZXR1cEF0OiB0eXBlb2YgcmF3LmVsb1NldHVwQXQgPT09IFwic3RyaW5nXCIgJiYgcmF3LmVsb1NldHVwQXQgPyByYXcuZWxvU2V0dXBBdCA6IG51bGwsXG4gICAgZWxvU2V0dXBNb2RlOiBFTE9fU1RBUlRTLmluY2x1ZGVzKHJhdy5lbG9TZXR1cE1vZGUgYXMgRWxvU3RhcnQpID8gKHJhdy5lbG9TZXR1cE1vZGUgYXMgRWxvU3RhcnQpIDogbnVsbCxcbiAgICBvcGVuSW5OZXdUYWI6IGJvb2woXCJvcGVuSW5OZXdUYWJcIiksXG4gICAgYXV0b3BsYXlQcmV2aWV3czogYm9vbChcImF1dG9wbGF5UHJldmlld3NcIiksXG4gICAgZmlsdGVyT3Bwb25lbnRzOiBib29sKFwiZmlsdGVyT3Bwb25lbnRzXCIpLFxuICAgIGNsZWFuTW9kZTogYm9vbChcImNsZWFuTW9kZVwiKSxcbiAgICBwYXVzZU1lZGlhT25PcGVuOiBib29sKFwicGF1c2VNZWRpYU9uT3BlblwiKSxcbiAgICBwbGFjZW1lbnRGcm9tQm90dG9tOiBib29sKFwicGxhY2VtZW50RnJvbUJvdHRvbVwiKSxcbiAgICBzaG93VGllcnM6IGJvb2woXCJzaG93VGllcnNcIiksXG4gICAgcHJldmlld1ZvbHVtZTogY2xhbXBQZXJjZW50KHJhdy5wcmV2aWV3Vm9sdW1lID8/IGJhc2UucHJldmlld1ZvbHVtZSwgYmFzZS5wcmV2aWV3Vm9sdW1lKSxcbiAgfTtcbn1cblxuLyoqIERlZmF1bHRzIG92ZXJsYWlkIHdpdGggdGhlIHByZS0yLjcgbG9jYWxTdG9yYWdlIHRvZ2dsZXMsIGZvciB1c2VycyB3aG8gbmV2ZXIgc2F2ZWQgc2V0dGluZ3MuICovXG5mdW5jdGlvbiBsZWdhY3lEZWZhdWx0cygpOiBTZXR0aW5ncyB7XG4gIGNvbnN0IHNldHRpbmdzID0geyAuLi5ERUZBVUxUX1NFVFRJTkdTIH07XG4gIHRyeSB7XG4gICAgaWYgKGxvY2FsU3RvcmFnZS5nZXRJdGVtKExFR0FDWV9GSUxURVJfT1BQT05FTlRTX0tFWSkgPT09IFwiMVwiKSBzZXR0aW5ncy5maWx0ZXJPcHBvbmVudHMgPSB0cnVlO1xuICAgIGlmIChsb2NhbFN0b3JhZ2UuZ2V0SXRlbShMRUdBQ1lfTVVURV9QUkVWSUVXU19LRVkpID09PSBcIjFcIikgc2V0dGluZ3MucHJldmlld1ZvbHVtZSA9IDA7XG4gIH0gY2F0Y2gge1xuICAgIC8qIGlnbm9yZSAqL1xuICB9XG4gIHJldHVybiBzZXR0aW5ncztcbn1cblxuLyoqXG4gKiBGZXRjaCBzZXR0aW5ncyBmcm9tIFN0YXNoIGludG8gc3RhdGUuc2V0dGluZ3MuIE9uIGZhaWx1cmUsIGtlZXBzIHRoZSBjdXJyZW50IHZhbHVlcyBhbmRcbiAqIHJldHVybnMgZmFsc2UuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBsb2FkU2V0dGluZ3MoKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIHRyeSB7XG4gICAgY29uc3Qgc3RvcmVkID0gYXdhaXQgZmV0Y2hTdG9yZWRDb25maWcoKTtcbiAgICBsZWdhY3lGdW5Nb2RlID0gc3RvcmVkPy5mdW5Nb2RlID09PSB0cnVlO1xuICAgIHN0YXRlLnNldHRpbmdzID0gc3RvcmVkID8gbm9ybWFsaXplKHN0b3JlZCwgREVGQVVMVF9TRVRUSU5HUykgOiBsZWdhY3lEZWZhdWx0cygpO1xuICAgIHJldHVybiB0cnVlO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIEZhaWxlZCB0byBsb2FkIHNldHRpbmdzLCB1c2luZyBjdXJyZW50IHZhbHVlczpcIiwgZSk7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbi8qKiBUcnVlIGlmIHRoZSBzdG9yZWQgY29uZmlnIHN0aWxsIGhhcyBwcmUtMy4wIGZ1biBtb2RlIHN3aXRjaGVkIG9uLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhhZEZ1bk1vZGUoKTogYm9vbGVhbiB7XG4gIHJldHVybiBsZWdhY3lGdW5Nb2RlO1xufVxuXG4vKiogU2V0dGluZ3MgY2hhbmdlZCBpbiB0aGlzIHRhYiBhbmQgbm90IHNhdmVkIHlldC4gKi9cbmNvbnN0IHVuc2F2ZWQgPSBuZXcgU2V0PGtleW9mIFNldHRpbmdzPigpO1xuXG4vKiogVGhlIHN0b3JlZCBjb25maWcgbWFwLCBmcmVzaCBmcm9tIFN0YXNoICh1bmRlZmluZWQgaWYgU3Rhc2ggQmF0dGxlIG5ldmVyIHNhdmVkIG9uZSkuICovXG5hc3luYyBmdW5jdGlvbiBmZXRjaFN0b3JlZENvbmZpZygpOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkPiB7XG4gIGNvbnN0IGRhdGEgPSBhd2FpdCBncmFwaHFsUXVlcnk8eyBjb25maWd1cmF0aW9uOiB7IHBsdWdpbnM6IFJlY29yZDxzdHJpbmcsIFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB9IH0+KFxuICAgIENPTkZJR19RVUVSWSxcbiAgKTtcbiAgcmV0dXJuIGRhdGEuY29uZmlndXJhdGlvbi5wbHVnaW5zPy5bUExVR0lOX0lEXTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcGVyc2lzdFNldHRpbmdzKCk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBjb25zdCBrZXlzID0gWy4uLnVuc2F2ZWRdO1xuICB1bnNhdmVkLmNsZWFyKCk7XG4gIHRyeSB7XG4gICAgLy8gY29uZmlndXJlUGx1Z2luIHJlcGxhY2VzIHRoZSB3aG9sZSBtYXAsIHNvIHRoaXMgdGFiJ3MgdW5zYXZlZCBjaGFuZ2VzIGdvIG9uIHRvcCBvZiB0aGVcbiAgICAvLyBzdG9yZWQgY29uZmlnLCBub3QgdGhpcyB0YWIncyBjb3B5IG9mIGl0OiBhbm90aGVyIHRhYiBtYXkgaGF2ZSBzYXZlZCBzaW5jZSB0aGlzIG9uZSBsb2FkZWRcbiAgICAvLyAoZmluaXNoZWQgdGhlIEVMTyBzZXR1cCwgc2F5KSwgYW5kIGFuIG9sZGVyIGNvcHkgd291bGQgdW5kbyB0aGF0LlxuICAgIGNvbnN0IHN0b3JlZCA9IGF3YWl0IGZldGNoU3RvcmVkQ29uZmlnKCk7XG4gICAgY29uc3QgbWVyZ2VkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHN0b3JlZCA/IHsgLi4ubm9ybWFsaXplKHN0b3JlZCwgc3RhdGUuc2V0dGluZ3MpIH0gOiB7IC4uLnN0YXRlLnNldHRpbmdzIH07XG4gICAgZm9yIChjb25zdCBrZXkgb2Yga2V5cykgbWVyZ2VkW2tleV0gPSBzdGF0ZS5zZXR0aW5nc1trZXldO1xuICAgIC8vIFVuc2V0IGtleXMgYXJlIGxlZnQgb3V0XG4gICAgY29uc3QgaW5wdXQgPSBPYmplY3QuZnJvbUVudHJpZXMoT2JqZWN0LmVudHJpZXMobWVyZ2VkKS5maWx0ZXIoKFssIHZhbHVlXSkgPT4gdmFsdWUgIT09IG51bGwpKTtcbiAgICBhd2FpdCBncmFwaHFsUXVlcnkoQ09ORklHVVJFX1BMVUdJTl9NVVRBVElPTiwgeyBwbHVnaW5faWQ6IFBMVUdJTl9JRCwgaW5wdXQgfSk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0gRmFpbGVkIHRvIHNhdmUgc2V0dGluZ3M6XCIsIGUpO1xuICAgIGZvciAoY29uc3Qga2V5IG9mIGtleXMpIHVuc2F2ZWQuYWRkKGtleSk7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbi8qKiBVcGRhdGUgc2V0dGluZ3MgbG9jYWxseSByaWdodCBhd2F5IGFuZCBwZXJzaXN0IHRvIFN0YXNoIChkZWJvdW5jZWQsIGZvciBzbGlkZXJzKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiB1cGRhdGVTZXR0aW5ncyhwYXRjaDogUGFydGlhbDxTZXR0aW5ncz4pOiB2b2lkIHtcbiAgc3RhdGUuc2V0dGluZ3MgPSBub3JtYWxpemUoeyAuLi5zdGF0ZS5zZXR0aW5ncywgLi4ucGF0Y2ggfSwgc3RhdGUuc2V0dGluZ3MpO1xuICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhwYXRjaCkgYXMgKGtleW9mIFNldHRpbmdzKVtdKSB1bnNhdmVkLmFkZChrZXkpO1xuICBpZiAoc2F2ZVRpbWVyKSBjbGVhclRpbWVvdXQoc2F2ZVRpbWVyKTtcbiAgc2F2ZVRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgc2F2ZVRpbWVyID0gbnVsbDtcbiAgICB2b2lkIHBlcnNpc3RTZXR0aW5ncygpO1xuICB9LCBTQVZFX0RFQk9VTkNFX01TKTtcbn1cblxuLyoqIFVwZGF0ZSBzZXR0aW5ncyBhbmQgc2F2ZSB0byBTdGFzaCByaWdodCBhd2F5IChubyBkZWJvdW5jZSkuIFJlc29sdmVzIGZhbHNlIGlmIHNhdmluZyBmYWlsZWQuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdXBkYXRlU2V0dGluZ3NOb3cocGF0Y2g6IFBhcnRpYWw8U2V0dGluZ3M+KTogUHJvbWlzZTxib29sZWFuPiB7XG4gIHN0YXRlLnNldHRpbmdzID0gbm9ybWFsaXplKHsgLi4uc3RhdGUuc2V0dGluZ3MsIC4uLnBhdGNoIH0sIHN0YXRlLnNldHRpbmdzKTtcbiAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXMocGF0Y2gpIGFzIChrZXlvZiBTZXR0aW5ncylbXSkgdW5zYXZlZC5hZGQoa2V5KTtcbiAgaWYgKHNhdmVUaW1lcikge1xuICAgIGNsZWFyVGltZW91dChzYXZlVGltZXIpO1xuICAgIHNhdmVUaW1lciA9IG51bGw7XG4gIH1cbiAgcmV0dXJuIHBlcnNpc3RTZXR0aW5ncygpO1xufVxuIiwgIi8vIFBlcnNpc3QvcmVzdG9yZSB0aGUgYmF0dGxlIHNlc3Npb24gdG8gbG9jYWxTdG9yYWdlLlxuXG5pbXBvcnQgeyBTVE9SQUdFX0tFWSB9IGZyb20gXCIuL2NvbnN0YW50c1wiO1xuaW1wb3J0IHsgc3RhdGUgfSBmcm9tIFwiLi9zdGF0ZVwiO1xuaW1wb3J0IHR5cGUgeyBNb2RlLCBQYWlyLCBQbGFjZW1lbnRSdW4sIFJhbmtzLCBTY2VuZSB9IGZyb20gXCIuL3R5cGVzXCI7XG5cbi8qKlxuICogQnVtcGVkIHdoZW4gc2F2ZWQgc2Vzc2lvbnMgY2FuJ3QgYmUgcmVzdG9yZWQgYXMgdGhleSBhcmUuIDMgKDMuMCk6IHNjZW5lcyBhcmUgcmFua2VkIGJ5IEVMT1xuICogZnJvbSBjdXN0b20gZmllbGRzLCB3aGljaCBvbGRlciBzYXZlZCBzY2VuZXMgbGFjaywgYW5kIEdhdW50bGV0IHJ1bnMgbm8gbG9uZ2VyIGV4aXN0LlxuICovXG5jb25zdCBTVEFURV9WRVJTSU9OID0gMztcblxuY29uc3QgTU9ERVM6IHJlYWRvbmx5IE1vZGVbXSA9IFtcInN3aXNzXCIsIFwicGxhY2VtZW50XCIsIFwiY2hhbXBpb25cIl07XG5cbmludGVyZmFjZSBQZXJzaXN0ZWRTdGF0ZSB7XG4gIHZlcnNpb24/OiBudW1iZXI7XG4gIGN1cnJlbnRQYWlyPzogUGFpcjtcbiAgY3VycmVudFJhbmtzPzogUmFua3M7XG4gIGN1cnJlbnRNb2RlPzogc3RyaW5nO1xuICBjaGFtcGlvblNjZW5lPzogU2NlbmUgfCBudWxsO1xuICBjaGFtcGlvbldpbnM/OiBudW1iZXI7XG4gIGNoYW1waW9uRGVmZWF0ZWQ/OiBzdHJpbmdbXTtcbiAgcGxhY2VtZW50PzogUGxhY2VtZW50UnVuIHwgbnVsbDtcbiAgdG90YWxTY2VuZXNDb3VudD86IG51bWJlcjtcbiAgc2F2ZWRGaWx0ZXJQYXJhbXM/OiBzdHJpbmc7XG59XG5cbi8qKiBBIHNhdmVkIG1vZGUgbmFtZSBhcyBhIGN1cnJlbnQgbW9kZTogR2F1bnRsZXQgYmVjYW1lIFBsYWNlbWVudCdzIFwiU3RhcnQgZnJvbSB0aGUgYm90dG9tXCIuICovXG5mdW5jdGlvbiByZXN0b3JlTW9kZShzYXZlZDogc3RyaW5nIHwgdW5kZWZpbmVkKTogTW9kZSB7XG4gIGlmIChzYXZlZCA9PT0gXCJnYXVudGxldFwiKSByZXR1cm4gXCJwbGFjZW1lbnRcIjtcbiAgcmV0dXJuIE1PREVTLmluY2x1ZGVzKHNhdmVkIGFzIE1vZGUpID8gKHNhdmVkIGFzIE1vZGUpIDogXCJzd2lzc1wiO1xufVxuXG4vKiogU2F2ZXMgdGhlIGN1cnJlbnQgYmF0dGxlIHNlc3Npb24gdG8gbG9jYWxTdG9yYWdlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNhdmVTdGF0ZSgpOiB2b2lkIHtcbiAgY29uc3Qgc25hcHNob3Q6IFBlcnNpc3RlZFN0YXRlID0ge1xuICAgIHZlcnNpb246IFNUQVRFX1ZFUlNJT04sXG4gICAgY3VycmVudFBhaXI6IHN0YXRlLmN1cnJlbnRQYWlyLFxuICAgIGN1cnJlbnRSYW5rczogc3RhdGUuY3VycmVudFJhbmtzLFxuICAgIGN1cnJlbnRNb2RlOiBzdGF0ZS5jdXJyZW50TW9kZSxcbiAgICBjaGFtcGlvblNjZW5lOiBzdGF0ZS5jaGFtcGlvblNjZW5lLFxuICAgIGNoYW1waW9uV2luczogc3RhdGUuY2hhbXBpb25XaW5zLFxuICAgIGNoYW1waW9uRGVmZWF0ZWQ6IHN0YXRlLmNoYW1waW9uRGVmZWF0ZWQsXG4gICAgcGxhY2VtZW50OiBzdGF0ZS5wbGFjZW1lbnQsXG4gICAgdG90YWxTY2VuZXNDb3VudDogc3RhdGUudG90YWxTY2VuZXNDb3VudCxcbiAgICBzYXZlZEZpbHRlclBhcmFtczogd2luZG93LmxvY2F0aW9uLnNlYXJjaCxcbiAgfTtcbiAgdHJ5IHtcbiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShTVE9SQUdFX0tFWSwgSlNPTi5zdHJpbmdpZnkoc25hcHNob3QpKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnNvbGUuZXJyb3IoXCJbU3Rhc2ggQmF0dGxlXSBGYWlsZWQgdG8gc2F2ZSBzdGF0ZTpcIiwgZSk7XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGxvYWRTdGF0ZSgpOiBib29sZWFuIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBzYXZlZCA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFNUT1JBR0VfS0VZKTtcbiAgICBpZiAoc2F2ZWQpIHtcbiAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2Uoc2F2ZWQpIGFzIFBlcnNpc3RlZFN0YXRlO1xuICAgICAgc3RhdGUuY3VycmVudE1vZGUgPSByZXN0b3JlTW9kZShwYXJzZWQuY3VycmVudE1vZGUpO1xuICAgICAgc3RhdGUuc2F2ZWRGaWx0ZXJQYXJhbXMgPSBwYXJzZWQuc2F2ZWRGaWx0ZXJQYXJhbXMgfHwgXCJcIjtcbiAgICAgIGlmIChwYXJzZWQudmVyc2lvbiAhPT0gU1RBVEVfVkVSU0lPTikge1xuICAgICAgICAvLyBPbGRlciBzZXNzaW9ucyBob2xkIHNjZW5lcyB3aXRob3V0IEVMTzoga2VlcCB0aGUgbW9kZSwgc3RhcnQgYSBmcmVzaCBwYWlyIGFuZCBydW5cbiAgICAgICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5OLIFNhdmVkIHNlc3Npb24gaXMgZnJvbSBhbiBvbGRlciB2ZXJzaW9uLCBzdGFydGluZyBmcmVzaFwiKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9XG4gICAgICBzdGF0ZS5jdXJyZW50UGFpciA9IHBhcnNlZC5jdXJyZW50UGFpciB8fCB7IGxlZnQ6IG51bGwsIHJpZ2h0OiBudWxsIH07XG4gICAgICBzdGF0ZS5jdXJyZW50UmFua3MgPSBwYXJzZWQuY3VycmVudFJhbmtzIHx8IHsgbGVmdDogbnVsbCwgcmlnaHQ6IG51bGwgfTtcbiAgICAgIHN0YXRlLmNoYW1waW9uU2NlbmUgPSBwYXJzZWQuY2hhbXBpb25TY2VuZSA/PyBudWxsO1xuICAgICAgc3RhdGUuY2hhbXBpb25XaW5zID0gcGFyc2VkLmNoYW1waW9uV2lucyB8fCAwO1xuICAgICAgc3RhdGUuY2hhbXBpb25EZWZlYXRlZCA9IHBhcnNlZC5jaGFtcGlvbkRlZmVhdGVkIHx8IFtdO1xuICAgICAgc3RhdGUucGxhY2VtZW50ID0gcGFyc2VkLnBsYWNlbWVudCB8fCBudWxsO1xuICAgICAgc3RhdGUudG90YWxTY2VuZXNDb3VudCA9IHBhcnNlZC50b3RhbFNjZW5lc0NvdW50IHx8IDA7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0gRmFpbGVkIHRvIGxvYWQgc3RhdGU6XCIsIGUpO1xuICB9XG4gIHJldHVybiBmYWxzZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNsZWFyU3RhdGUoKTogdm9pZCB7XG4gIHRyeSB7XG4gICAgbG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oU1RPUkFHRV9LRVkpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIEZhaWxlZCB0byBjbGVhciBzdGF0ZTpcIiwgZSk7XG4gIH1cbn1cbiIsICIvLyBBIHNtYWxsIGNvbmZpcm1hdGlvbiBkaWFsb2cgaW5zaWRlIHRoZSBTdGFzaCBCYXR0bGUgbW9kYWwgKHN3aXRjaGluZyBTdGFzaCByYXRpbmdzLCBSZXNldCBFTE8pLlxuLy8gVGhlIGNvbmZpcm0gYnV0dG9uIGNhbiBydW4gYW4gYXN5bmMgYWN0aW9uOiB0aGUgZGlhbG9nIHN0YXlzIG9wZW4gd2hpbGUgaXQgcnVucywgY2xvc2VzIHdoZW5cbi8vIGl0IHN1Y2NlZWRzLCBhbmQgc2hvd3MgdGhlIGVycm9yIGlmIGl0IGZhaWxzLlxuXG5leHBvcnQgaW50ZXJmYWNlIENvbmZpcm1EaWFsb2dPcHRpb25zIHtcbiAgdGl0bGU6IHN0cmluZztcbiAgLyoqIEhUTUwgYm9keS4gKi9cbiAgYm9keTogc3RyaW5nO1xuICBjb25maXJtTGFiZWw6IHN0cmluZztcbiAgLyoqIExhYmVsIG9uIHRoZSBjb25maXJtIGJ1dHRvbiB3aGlsZSBgYWN0aW9uYCBydW5zLiAqL1xuICB3b3JraW5nTGFiZWw/OiBzdHJpbmc7XG4gIC8qKiBSdW5zIG9uIGNvbmZpcm07IHRoZSBkaWFsb2cgcmVzb2x2ZXMgdHJ1ZSBvbmx5IG9uY2UgaXQgc3VjY2VlZHMuICovXG4gIGFjdGlvbj86ICgpID0+IFByb21pc2U8dm9pZD47XG59XG5cbmxldCBjYW5jZWxPcGVuOiAoKCkgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcblxuZXhwb3J0IGZ1bmN0aW9uIGlzQ29uZmlybURpYWxvZ09wZW4oKTogYm9vbGVhbiB7XG4gIHJldHVybiBjYW5jZWxPcGVuICE9PSBudWxsO1xufVxuXG4vKiogQ2FuY2VsIHRoZSBvcGVuIGRpYWxvZyAoRXNjYXBlKSwgdW5sZXNzIGl0cyBhY3Rpb24gaXMgcnVubmluZy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjYW5jZWxDb25maXJtRGlhbG9nKCk6IHZvaWQge1xuICBjYW5jZWxPcGVuPy4oKTtcbn1cblxuLyoqIFNob3cgdGhlIGRpYWxvZzsgcmVzb2x2ZXMgdHJ1ZSB3aGVuIGNvbmZpcm1lZCAoYW5kIGl0cyBhY3Rpb24gc3VjY2VlZGVkKSwgZmFsc2Ugd2hlbiBjYW5jZWxsZWQuICovXG5leHBvcnQgZnVuY3Rpb24gY29uZmlybURpYWxvZyhvcHRzOiBDb25maXJtRGlhbG9nT3B0aW9ucyk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBjYW5jZWxPcGVuPy4oKTtcbiAgY29uc3QgaG9zdCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic2ItbW9kYWxcIik7XG4gIGlmICghaG9zdCkgcmV0dXJuIFByb21pc2UucmVzb2x2ZShmYWxzZSk7XG5cbiAgY29uc3Qgb3ZlcmxheSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIG92ZXJsYXkuY2xhc3NOYW1lID0gXCJzYi1kaWFsb2ctYmFja2Ryb3BcIjtcbiAgb3ZlcmxheS5pbm5lckhUTUwgPSBgXG4gICAgICA8ZGl2IGNsYXNzPVwic2ItZGlhbG9nXCIgcm9sZT1cImRpYWxvZ1wiIGFyaWEtbW9kYWw9XCJ0cnVlXCIgYXJpYS1sYWJlbGxlZGJ5PVwic2ItZGlhbG9nLXRpdGxlXCI+XG4gICAgICAgIDxoMyBpZD1cInNiLWRpYWxvZy10aXRsZVwiIGNsYXNzPVwic2ItZGlhbG9nLXRpdGxlXCI+JHtvcHRzLnRpdGxlfTwvaDM+XG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi1kaWFsb2ctYm9keVwiPiR7b3B0cy5ib2R5fTwvZGl2PlxuICAgICAgICA8cCBjbGFzcz1cInNiLWRpYWxvZy1lcnJvclwiIGhpZGRlbj48L3A+XG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi1kaWFsb2ctYWN0aW9uc1wiPlxuICAgICAgICAgIDxidXR0b24gdHlwZT1cImJ1dHRvblwiIGNsYXNzPVwiYnRuIGJ0bi1zZWNvbmRhcnlcIiBkYXRhLXJvbGU9XCJjYW5jZWxcIj5DYW5jZWw8L2J1dHRvbj5cbiAgICAgICAgICA8YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cImJ0biBidG4tcHJpbWFyeVwiIGRhdGEtcm9sZT1cImNvbmZpcm1cIj4ke29wdHMuY29uZmlybUxhYmVsfTwvYnV0dG9uPlxuICAgICAgICA8L2Rpdj5cbiAgICAgIDwvZGl2PmA7XG4gIGhvc3QuYXBwZW5kQ2hpbGQob3ZlcmxheSk7XG5cbiAgY29uc3QgY29uZmlybUJ0biA9IG92ZXJsYXkucXVlcnlTZWxlY3RvcjxIVE1MQnV0dG9uRWxlbWVudD4oJ1tkYXRhLXJvbGU9XCJjb25maXJtXCJdJykgYXMgSFRNTEJ1dHRvbkVsZW1lbnQ7XG4gIGNvbnN0IGNhbmNlbEJ0biA9IG92ZXJsYXkucXVlcnlTZWxlY3RvcjxIVE1MQnV0dG9uRWxlbWVudD4oJ1tkYXRhLXJvbGU9XCJjYW5jZWxcIl0nKSBhcyBIVE1MQnV0dG9uRWxlbWVudDtcbiAgY29uc3QgZXJyb3IgPSBvdmVybGF5LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiLnNiLWRpYWxvZy1lcnJvclwiKSBhcyBIVE1MRWxlbWVudDtcbiAgY29uZmlybUJ0bi5mb2N1cygpO1xuXG4gIHJldHVybiBuZXcgUHJvbWlzZTxib29sZWFuPigocmVzb2x2ZSkgPT4ge1xuICAgIGxldCBidXN5ID0gZmFsc2U7XG4gICAgY29uc3QgY2xvc2UgPSAocmVzdWx0OiBib29sZWFuKTogdm9pZCA9PiB7XG4gICAgICBvdmVybGF5LnJlbW92ZSgpO1xuICAgICAgY2FuY2VsT3BlbiA9IG51bGw7XG4gICAgICByZXNvbHZlKHJlc3VsdCk7XG4gICAgfTtcbiAgICBjYW5jZWxPcGVuID0gKCkgPT4ge1xuICAgICAgaWYgKCFidXN5KSBjbG9zZShmYWxzZSk7XG4gICAgfTtcblxuICAgIGNhbmNlbEJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4gY2FuY2VsT3Blbj8uKCkpO1xuICAgIG92ZXJsYXkuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XG4gICAgICBpZiAoZS50YXJnZXQgPT09IG92ZXJsYXkpIGNhbmNlbE9wZW4/LigpO1xuICAgIH0pO1xuICAgIGNvbmZpcm1CdG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIGFzeW5jICgpID0+IHtcbiAgICAgIGlmICghb3B0cy5hY3Rpb24pIHtcbiAgICAgICAgY2xvc2UodHJ1ZSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGJ1c3kgPSB0cnVlO1xuICAgICAgZXJyb3IuaGlkZGVuID0gdHJ1ZTtcbiAgICAgIGNvbmZpcm1CdG4uZGlzYWJsZWQgPSBjYW5jZWxCdG4uZGlzYWJsZWQgPSB0cnVlO1xuICAgICAgY29uZmlybUJ0bi50ZXh0Q29udGVudCA9IG9wdHMud29ya2luZ0xhYmVsID8/IFwiV29ya2luZy4uLlwiO1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgb3B0cy5hY3Rpb24oKTtcbiAgICAgICAgY2xvc2UodHJ1ZSk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGJ1c3kgPSBmYWxzZTtcbiAgICAgICAgY29uZmlybUJ0bi5kaXNhYmxlZCA9IGNhbmNlbEJ0bi5kaXNhYmxlZCA9IGZhbHNlO1xuICAgICAgICBjb25maXJtQnRuLnRleHRDb250ZW50ID0gb3B0cy5jb25maXJtTGFiZWw7XG4gICAgICAgIGVycm9yLnRleHRDb250ZW50ID0gYFRoYXQgZGlkbid0IHdvcms6ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfS4gWW91IGNhbiB0cnkgYWdhaW4uYDtcbiAgICAgICAgZXJyb3IuaGlkZGVuID0gZmFsc2U7XG4gICAgICB9XG4gICAgfSk7XG4gIH0pO1xufVxuIiwgIi8vIFNQQSBuYXZpZ2F0aW9uIGhlbHBlcnMuXHJcblxyXG5pbXBvcnQgeyBjbG9zZU1vZGFsIH0gZnJvbSBcIi4vdWkvbW9kYWxcIjtcclxuXHJcbi8vIE5hdmlnYXRlIHVzaW5nIFJlYWN0IFJvdXRlciAocHJlc2VydmVzIEpTIHN0YXRlKVxyXG5leHBvcnQgZnVuY3Rpb24gbmF2aWdhdGVUb1VybCh1cmw6IHN0cmluZyk6IHZvaWQge1xyXG4gIGNsb3NlTW9kYWwoKTtcclxuXHJcbiAgLy8gVXNlIEhpc3RvcnkgQVBJICsgcG9wc3RhdGUgZXZlbnQgdG8gdHJpZ2dlciBSZWFjdCBSb3V0ZXIgbmF2aWdhdGlvblxyXG4gIGNvbnN0IHBhdGggPSB1cmwuc3RhcnRzV2l0aChcIi9cIikgPyB1cmwgOiBuZXcgVVJMKHVybCkucGF0aG5hbWUgKyBuZXcgVVJMKHVybCkuc2VhcmNoO1xyXG4gIHdpbmRvdy5oaXN0b3J5LnB1c2hTdGF0ZSh7fSwgXCJcIiwgcGF0aCk7XHJcbiAgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IFBvcFN0YXRlRXZlbnQoXCJwb3BzdGF0ZVwiLCB7IHN0YXRlOiB7fSB9KSk7XHJcbn1cclxuIiwgIi8vIFBsYWNlbWVudCBzZWFyY2gsIGtlcHQgcHVyZSAobm8gc3RhdGUgb3IgSS9PKSBzbyB3aG9sZSBydW5zIGNhbiBiZSBzaW11bGF0ZWQgaW4gdGVzdHMuXG4vL1xuLy8gVGhlIHNjZW5lJ3Mgc2xvdCBsaWVzIGluIFtsbywgaGkpIG9mIHRoZSBFTE8tc29ydGVkIG9wcG9uZW50IHBvb2wuIEEgd2luIGFnYWluc3QgaW5kZXggaVxuLy8gbWVhbnMgdGhlIHNsb3QgaXMgYWJvdmUgaSAoaGkgPSBpKTsgYSBsb3NzIG1lYW5zIGl0J3MgYmVsb3cgKGxvID0gaSArIDEpLiBBIHJhdGVkIHNjZW5lIHN0YXJ0c1xuLy8gbmV4dCB0byBpdHMgY3VycmVudCBFTE8gYW5kIGdhbGxvcHMgKHN0ZXBzIDEsIDIsIDQsIDguLi4pIHdoaWxlIHJlc3VsdHMga2VlcCBnb2luZyB0aGUgc2FtZVxuLy8gd2F5OyB0aGUgZmlyc3QgcmV2ZXJzYWwgKG9yIGFuIHVucmF0ZWQgc2NlbmUpIHN3aXRjaGVzIHRvIGhhbHZpbmcgdGhlIHJlbWFpbmluZyByYW5nZS5cbi8vIFwiU3RhcnQgZnJvbSB0aGUgYm90dG9tXCIgcnVucyBpZ25vcmUgdGhlIHNjZW5lJ3MgRUxPOiB0aGV5IHN0YXJ0IGFnYWluc3QgdGhlIGJvdHRvbSBzY2VuZSBhbmRcbi8vIGdhbGxvcCB1cHdhcmQsIHNvIGVhY2ggd2luIGRvdWJsZXMgdGhlIGp1bXAgdW50aWwgdGhlIGZpcnN0IGxvc3MuXG5cbmltcG9ydCB7IFBMQUNFTUVOVF9NQVhfSlVNUF9TSEFSRSwgUExBQ0VNRU5UX01JTl9NQVhfSlVNUCB9IGZyb20gXCIuL2NvbnN0YW50c1wiO1xuaW1wb3J0IHsgZWxvLCBlbG9JbnNlcnRpb25JbmRleCwgcGxhY2VtZW50RWxvIH0gZnJvbSBcIi4vc2NvcmVcIjtcbmltcG9ydCB0eXBlIHsgUGxhY2VtZW50UnVuLCBTY2VuZSB9IGZyb20gXCIuL3R5cGVzXCI7XG5cbmV4cG9ydCBmdW5jdGlvbiBuZXdQbGFjZW1lbnRSdW4oc2NlbmU6IFNjZW5lLCBmcm9tQm90dG9tOiBib29sZWFuKTogUGxhY2VtZW50UnVuIHtcbiAgcmV0dXJuIHtcbiAgICBzY2VuZSxcbiAgICBmcm9tQm90dG9tLFxuICAgIGFib3ZlSWQ6IG51bGwsXG4gICAgYmVsb3dJZDogbnVsbCxcbiAgICBsYXN0T3Bwb25lbnRJZDogbnVsbCxcbiAgICBsYXN0V29uOiBudWxsLFxuICAgIGdhbGxvcGluZzogZnJvbUJvdHRvbSB8fCBlbG8oc2NlbmUpICE9PSBudWxsLFxuICAgIHN0ZXA6IDEsXG4gICAgYmF0dGxlczogMCxcbiAgICBzdHJlYWs6IDAsXG4gICAgcmFuZ2VMbzogMCxcbiAgICByYW5nZUhpOiAwLFxuICB9O1xufVxuXG4vKiogSW5kZXggb2YgdGhlIGVuZCBvZiBwb29sW2lkeF0ncyB0aWUgZ3JvdXAgKHNjZW5lcyB3aXRoIHRoZSBzYW1lIEVMTykgaW4gZGlyZWN0aW9uIGBkaXJgLiAqL1xuZnVuY3Rpb24gdGllR3JvdXBFZGdlKHBvb2w6IFNjZW5lW10sIGlkeDogbnVtYmVyLCBkaXI6IDEgfCAtMSk6IG51bWJlciB7XG4gIGNvbnN0IHZhbHVlID0gZWxvKHBvb2xbaWR4XSk7XG4gIGxldCBlZGdlID0gaWR4O1xuICB3aGlsZSAoZWRnZSArIGRpciA+PSAwICYmIGVkZ2UgKyBkaXIgPCBwb29sLmxlbmd0aCAmJiBlbG8ocG9vbFtlZGdlICsgZGlyXSkgPT09IHZhbHVlKSBlZGdlICs9IGRpcjtcbiAgcmV0dXJuIGVkZ2U7XG59XG5cbi8qKlxuICogQ3VycmVudCBbbG8sIGhpKSBzbG90IGJvdW5kcywgcmVzb2x2ZWQgZnJvbSB0aGUgYm91bmRpbmcgb3Bwb25lbnRzJyBpZHMuIEEgcmVzdWx0IGNvdW50cyBmb3JcbiAqIHRoZSBvcHBvbmVudCdzIHdob2xlIHRpZSBncm91cDogYSBzY2VuZSBjYW4gb25seSBnZXQgYW4gRUxPIGFib3ZlIG9yIGJlbG93IGEgZ3JvdXAgb2YgZXF1YWxcbiAqIEVMT3MsIG5vdCBpbnNpZGUgaXQsIHNvIHRoZSBzbG90IGFsd2F5cyBlbmRzIGF0IGEgZ3JvdXAncyBlZGdlIGFuZCB0aGUgbGFuZGluZyBFTE8ga2VlcHMgaXQgdGhlcmUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwbGFjZW1lbnRCb3VuZHMocnVuOiBQbGFjZW1lbnRSdW4sIHBvb2w6IFNjZW5lW10pOiB7IGxvOiBudW1iZXI7IGhpOiBudW1iZXIgfSB7XG4gIGNvbnN0IGFib3ZlSWR4ID0gcnVuLmFib3ZlSWQgPyBwb29sLmZpbmRJbmRleCgocykgPT4gcy5pZCA9PT0gcnVuLmFib3ZlSWQpIDogLTE7XG4gIGNvbnN0IGJlbG93SWR4ID0gcnVuLmJlbG93SWQgPyBwb29sLmZpbmRJbmRleCgocykgPT4gcy5pZCA9PT0gcnVuLmJlbG93SWQpIDogLTE7XG4gIHJldHVybiB7XG4gICAgbG86IGFib3ZlSWR4ID49IDAgPyB0aWVHcm91cEVkZ2UocG9vbCwgYWJvdmVJZHgsIDEpICsgMSA6IDAsXG4gICAgaGk6IGJlbG93SWR4ID49IDAgPyB0aWVHcm91cEVkZ2UocG9vbCwgYmVsb3dJZHgsIC0xKSA6IHBvb2wubGVuZ3RoLFxuICB9O1xufVxuXG4vKiogVGhlIHBvb2wncyBsb3dlc3Qgc2NlbmUgd2l0aCBhbiBFTE8gKHVucmF0ZWQgb25lcyBzb3J0IGxhc3QpLCBvciBpdHMgbGFzdCBzY2VuZSBpZiBub25lIGhhcyBvbmUuICovXG5leHBvcnQgZnVuY3Rpb24gYm90dG9tSW5kZXgocG9vbDogU2NlbmVbXSk6IG51bWJlciB7XG4gIGZvciAobGV0IGkgPSBwb29sLmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7XG4gICAgaWYgKGVsbyhwb29sW2ldKSAhPT0gbnVsbCkgcmV0dXJuIGk7XG4gIH1cbiAgcmV0dXJuIHBvb2wubGVuZ3RoIC0gMTtcbn1cblxuLyoqIExhcmdlc3QganVtcCBhIGdhbGxvcGluZyBydW4gbWFrZXMgaW4gdGhpcyBwb29sIChzZWUgUExBQ0VNRU5UX01BWF9KVU1QX1NIQVJFKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtYXhQbGFjZW1lbnRKdW1wKHBvb2xTaXplOiBudW1iZXIpOiBudW1iZXIge1xuICByZXR1cm4gTWF0aC5tYXgoUExBQ0VNRU5UX01JTl9NQVhfSlVNUCwgTWF0aC5yb3VuZChwb29sU2l6ZSAqIFBMQUNFTUVOVF9NQVhfSlVNUF9TSEFSRSkpO1xufVxuXG4vKiogV2hlcmUgdGhlIG5leHQgb3Bwb25lbnQgc2hvdWxkIGNvbWUgZnJvbSAoYmVmb3JlIGNsYW1waW5nIGludG8gW2xvLCBoaSkpLiAqL1xuZnVuY3Rpb24gbmV4dFBsYWNlbWVudEluZGV4KHJ1bjogUGxhY2VtZW50UnVuLCBwb29sOiBTY2VuZVtdLCBsbzogbnVtYmVyLCBoaTogbnVtYmVyKTogbnVtYmVyIHtcbiAgaWYgKHJ1bi5nYWxsb3BpbmcpIHtcbiAgICBpZiAocnVuLmxhc3RPcHBvbmVudElkID09PSBudWxsKSB7XG4gICAgICBpZiAocnVuLmZyb21Cb3R0b20pIHJldHVybiBib3R0b21JbmRleChwb29sKTtcbiAgICAgIC8vIFN0YXJ0IGp1c3QgYmVsb3cgdGhlIHNjZW5lJ3MgY3VycmVudCBFTE86IGEgY29ycmVjdGx5IHJhdGVkIHNjZW5lIGNvbmZpcm1zIGluIH4yIGJhdHRsZXNcbiAgICAgIHJldHVybiBlbG9JbnNlcnRpb25JbmRleChwb29sLCBlbG8ocnVuLnNjZW5lKSA/PyAwKTtcbiAgICB9XG4gICAgY29uc3QgbGFzdElkeCA9IHBvb2wuZmluZEluZGV4KChzKSA9PiBzLmlkID09PSBydW4ubGFzdE9wcG9uZW50SWQpO1xuICAgIGlmIChsYXN0SWR4ID49IDApIHtcbiAgICAgIC8vIFN0ZXAgZnJvbSB0aGUgZmFyIGVkZ2Ugb2YgdGhlIGxhc3Qgb3Bwb25lbnQncyB0aWUgZ3JvdXA6IGFub3RoZXIgZXF1YWwgRUxPIHRlYWNoZXMgbm90aGluZ1xuICAgICAgY29uc3QgZGlyID0gcnVuLmxhc3RXb24gPyAtMSA6IDE7XG4gICAgICBjb25zdCB0YXJnZXQgPSB0aWVHcm91cEVkZ2UocG9vbCwgbGFzdElkeCwgZGlyKSArIGRpciAqIE1hdGgubWluKHJ1bi5zdGVwLCBtYXhQbGFjZW1lbnRKdW1wKHBvb2wubGVuZ3RoKSk7XG4gICAgICAvLyBBIGp1bXAgcGFzdCB0aGUgc2VhcmNoIHJhbmdlIHdvdWxkIGxhbmQgb24gaXRzIGVuZCAoc3RyYWlnaHQgdG8gIzEsIHNheSk6IGhhbHZlIGluc3RlYWRcbiAgICAgIGlmICh0YXJnZXQgPj0gbG8gJiYgdGFyZ2V0IDwgaGkpIHJldHVybiB0YXJnZXQ7XG4gICAgfVxuICB9XG4gIHJldHVybiBsbyArIE1hdGguZmxvb3IoKGhpIC0gbG8pIC8gMik7XG59XG5cbmV4cG9ydCB0eXBlIFBsYWNlbWVudFN0ZXAgPVxuICB8IHsgZG9uZTogdHJ1ZTsgc2xvdDogbnVtYmVyOyBsbzogbnVtYmVyOyBoaTogbnVtYmVyIH1cbiAgfCB7IGRvbmU6IGZhbHNlOyBpbmRleDogbnVtYmVyOyBsbzogbnVtYmVyOyBoaTogbnVtYmVyIH07XG5cbi8qKiBUaGUgcnVuJ3MgbmV4dCBzdGVwIG9uIHRoaXMgcG9vbDogdGhlIG9wcG9uZW50IGluZGV4IHRvIGJhdHRsZSwgb3IgdGhlIHNsb3QgaXQgaGFzIGxhbmRlZCBpbi4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwbGFjZW1lbnRTdGVwKHJ1bjogUGxhY2VtZW50UnVuLCBwb29sOiBTY2VuZVtdKTogUGxhY2VtZW50U3RlcCB7XG4gIGNvbnN0IHsgbG8sIGhpIH0gPSBwbGFjZW1lbnRCb3VuZHMocnVuLCBwb29sKTtcbiAgaWYgKGxvID49IGhpKSByZXR1cm4geyBkb25lOiB0cnVlLCBzbG90OiBNYXRoLm1pbihsbywgaGkpLCBsbywgaGkgfTtcbiAgY29uc3QgaW5kZXggPSBNYXRoLm1heChsbywgTWF0aC5taW4oaGkgLSAxLCBuZXh0UGxhY2VtZW50SW5kZXgocnVuLCBwb29sLCBsbywgaGkpKSk7XG4gIHJldHVybiB7IGRvbmU6IGZhbHNlLCBpbmRleCwgbG8sIGhpIH07XG59XG5cbi8qKiBSZWNvcmQgYSBwbGFjZW1lbnQgYmF0dGxlIHJlc3VsdCBhbmQgdXBkYXRlIHRoZSBtb21lbnR1bSBhbmQgdGhlIHdpbiBzdHJlYWsuICovXG5leHBvcnQgZnVuY3Rpb24gcmVjb3JkUGxhY2VtZW50UmVzdWx0KHJ1bjogUGxhY2VtZW50UnVuLCB3b246IGJvb2xlYW4sIG9wcG9uZW50SWQ6IHN0cmluZyk6IHZvaWQge1xuICBpZiAocnVuLmxhc3RXb24gIT09IG51bGwpIHtcbiAgICBpZiAocnVuLmxhc3RXb24gPT09IHdvbikgcnVuLnN0ZXAgKj0gMjtcbiAgICBlbHNlIHJ1bi5nYWxsb3BpbmcgPSBmYWxzZTtcbiAgfVxuICBpZiAod29uKSBydW4uYmVsb3dJZCA9IG9wcG9uZW50SWQ7XG4gIGVsc2UgcnVuLmFib3ZlSWQgPSBvcHBvbmVudElkO1xuXG4gIC8vIFRoZSBzdHJlYWsgY291bnRzIHdpbnMgdW50aWwgdGhlIGZpcnN0IGxvc3MsIHNvIGl0IG9ubHkgZ3Jvd3Mgd2hpbGUgZXZlcnkgYmF0dGxlIHdhcyBhIHdpblxuICBpZiAod29uICYmIHJ1bi5zdHJlYWsgPT09IHJ1bi5iYXR0bGVzKSBydW4uc3RyZWFrKys7XG4gIHJ1bi5sYXN0T3Bwb25lbnRJZCA9IG9wcG9uZW50SWQ7XG4gIHJ1bi5sYXN0V29uID0gd29uO1xuICBydW4uYmF0dGxlcysrO1xufVxuXG4vKipcbiAqIEVMTyBmb3IgYSBzY2VuZSBsYW5kaW5nIGF0IGBzbG90YCBvZiB0aGUgcG9vbDogYmV0d2VlbiB0aGUgbmVhcmVzdCBuZWlnaGJvdXJzIHRoYXQgaGF2ZSBhbiBFTE9cbiAqICh1bnJhdGVkIG9wcG9uZW50cywgcG9zc2libGUgaW4gYSBmaWx0ZXJlZCBwb29sLCBzYXkgbm90aGluZyBhYm91dCBpdCkuIFNlZSBwbGFjZW1lbnRFbG8uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBsYW5kaW5nRWxvKHBvb2w6IFNjZW5lW10sIHNsb3Q6IG51bWJlcik6IG51bWJlciB7XG4gIGxldCBhYm92ZTogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG4gIGZvciAobGV0IGkgPSBzbG90IC0gMTsgaSA+PSAwICYmIGFib3ZlID09PSBudWxsOyBpLS0pIGFib3ZlID0gZWxvKHBvb2xbaV0pO1xuICBsZXQgYmVsb3c6IG51bWJlciB8IG51bGwgPSBudWxsO1xuICBmb3IgKGxldCBpID0gc2xvdDsgaSA8IHBvb2wubGVuZ3RoICYmIGJlbG93ID09PSBudWxsOyBpKyspIGJlbG93ID0gZWxvKHBvb2xbaV0pO1xuICByZXR1cm4gcGxhY2VtZW50RWxvKGFib3ZlLCBiZWxvdyk7XG59XG4iLCAiLy8gTWF0Y2htYWtpbmc6IGJ1aWxkIHRoZSBzY2VuZSBwYWlycyBmb3IgZWFjaCBjb21wYXJpc29uIG1vZGUuXG5cbmltcG9ydCB7IGNsZWFyRmlsdGVyZWRDYWNoZSwgZ2V0QWxsU2NlbmVzQ2FjaGVkLCBnZXRGaWx0ZXJlZFNjZW5lc0NhY2hlZCwgbGF0ZXN0U2NlbmUgfSBmcm9tIFwiLi9jYWNoZVwiO1xuaW1wb3J0IHtcbiAgQ0hBTVBJT05fVU5SQVRFRF9FTE8sXG4gIENMSU1CX09QUE9ORU5UX1BJQ0tfV0lORE9XLFxuICBTV0lTU19PUFBPTkVOVF9FTE9fV0lORE9XLFxuICBTV0lTU19PUFBPTkVOVF9NSU5fQ0FORElEQVRFUyxcbn0gZnJvbSBcIi4vY29uc3RhbnRzXCI7XG5pbXBvcnQgeyByZWFkRmlsdGVycywgdHlwZSBMaXN0RmlsdGVycyB9IGZyb20gXCIuL2ZpbHRlcnNcIjtcbmltcG9ydCB7IGxhbmRpbmdFbG8sIG5ld1BsYWNlbWVudFJ1biwgcGxhY2VtZW50U3RlcCB9IGZyb20gXCIuL3BsYWNlbWVudFwiO1xuaW1wb3J0IHsgd3JpdGVFbG8gfSBmcm9tIFwiLi9yYXRpbmdcIjtcbmltcG9ydCB7IGJhdHRsZXMsIGVmZmVjdGl2ZUVsbywgZWxvLCBpc1JhdGVkLCBzd2lzc09wcG9uZW50SW5kZXhlcyB9IGZyb20gXCIuL3Njb3JlXCI7XG5pbXBvcnQgeyBzdGF0ZSB9IGZyb20gXCIuL3N0YXRlXCI7XG5pbXBvcnQgdHlwZSB7IENoYW1waW9uUGFpclJlc3VsdCwgUGxhY2VtZW50UGFpclJlc3VsdCwgUmFuaywgU2NlbmUsIFN3aXNzUGFpclJlc3VsdCB9IGZyb20gXCIuL3R5cGVzXCI7XG5cbmZ1bmN0aW9uIHNodWZmbGVBcnJheTxUPihhcnJheTogVFtdKTogVFtdIHtcbiAgY29uc3Qgc2h1ZmZsZWQgPSBbLi4uYXJyYXldO1xuICBmb3IgKGxldCBpID0gc2h1ZmZsZWQubGVuZ3RoIC0gMTsgaSA+IDA7IGktLSkge1xuICAgIGNvbnN0IGogPSBNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkgKiAoaSArIDEpKTtcbiAgICBbc2h1ZmZsZWRbaV0sIHNodWZmbGVkW2pdXSA9IFtzaHVmZmxlZFtqXSwgc2h1ZmZsZWRbaV1dO1xuICB9XG4gIHJldHVybiBzaHVmZmxlZDtcbn1cblxuLy8gVHJhY2sgbGFzdCBzY2VuZSB0byBhdm9pZCBpbW1lZGlhdGUgcmVwZWF0IGFmdGVyIHJlc2h1ZmZsZVxubGV0IGxhc3RTaG93blNjZW5lSWQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG4vKiogVHJ1ZSBvbmNlIGV2ZXJ5IHNjZW5lIGluIHRoZSBjdXJyZW50IHNodWZmbGUgaGFzIGJlZW4gc2hvd24gKHRpbWUgdG8gcmUtcXVlcnkgdGhlIGZpbHRlcikuICovXG5mdW5jdGlvbiBpc1NodWZmbGVDeWNsZUNvbXBsZXRlKGZpbHRlcktleTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiAoXG4gICAgc3RhdGUuc2h1ZmZsZUZpbHRlcktleSA9PT0gZmlsdGVyS2V5ICYmXG4gICAgc3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lcy5sZW5ndGggPiAwICYmXG4gICAgc3RhdGUuc2h1ZmZsZUluZGV4ID49IHN0YXRlLnNodWZmbGVkRmlsdGVyZWRTY2VuZXMubGVuZ3RoXG4gICk7XG59XG5cbi8qKiBSZXNodWZmbGUgdGhlIGxlZnQgcG9vbCBmb3IgYSBuZXcgcGFzcywgd2l0aG91dCBzaG93aW5nIHRoZSBwcmV2aW91cyBwYXNzJ3MgbGFzdCBzY2VuZSBmaXJzdC4gKi9cbmZ1bmN0aW9uIHN0YXJ0TmV3UGFzcyhsZWZ0UG9vbDogU2NlbmVbXSk6IHZvaWQge1xuICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCflIAgUmVzaHVmZmxpbmcgKGNvbXBsZXRlZCBmdWxsIGN5Y2xlKVwiKTtcbiAgc3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lcyA9IHNodWZmbGVBcnJheShsZWZ0UG9vbCk7XG4gIHN0YXRlLnNodWZmbGVJbmRleCA9IDA7XG5cbiAgaWYgKFxuICAgIGxhc3RTaG93blNjZW5lSWQgJiZcbiAgICBzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzLmxlbmd0aCA+IDEgJiZcbiAgICBzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzWzBdLmlkID09PSBsYXN0U2hvd25TY2VuZUlkXG4gICkge1xuICAgIGNvbnN0IHN3YXBJZHggPSAxICsgTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogKHN0YXRlLnNodWZmbGVkRmlsdGVyZWRTY2VuZXMubGVuZ3RoIC0gMSkpO1xuICAgIFtzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzWzBdLCBzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzW3N3YXBJZHhdXSA9IFtcbiAgICAgIHN0YXRlLnNodWZmbGVkRmlsdGVyZWRTY2VuZXNbc3dhcElkeF0sXG4gICAgICBzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzWzBdLFxuICAgIF07XG4gICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5SEIFN3YXBwZWQgZmlyc3Qgc2NlbmUgdG8gYXZvaWQgcmVwZWF0XCIpO1xuICB9XG59XG5cbi8qKiBOZXh0IGxlZnQtc2lkZSBzY2VuZSBmcm9tIHRoZSBzaHVmZmxlZCBsZWZ0IHBvb2wgKG5vIG5ldHdvcmsgZmV0Y2gpLiBTY2VuZXMgc3RheSBpbiB0aGUgcG9vbC4gKi9cbmZ1bmN0aW9uIGdldE5leHRGaWx0ZXJlZFNjZW5lKGxlZnRQb29sOiBTY2VuZVtdLCBmaWx0ZXJLZXk6IHN0cmluZyk6IFNjZW5lIHwgbnVsbCB7XG4gIGlmIChsZWZ0UG9vbC5sZW5ndGggPT09IDApIHtcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCfj4EgRmlsdGVyZWQgcG9vbCBpcyBlbXB0eVwiKTtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIGlmIChmaWx0ZXJLZXkgIT09IHN0YXRlLnNodWZmbGVGaWx0ZXJLZXkgfHwgc3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lcy5sZW5ndGggPT09IDApIHtcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCflIAgU2h1ZmZsaW5nIGZpbHRlcmVkIHNjZW5lcyAoZmlsdGVyIGNoYW5nZWQgb3IgZmlyc3QgbG9hZClcIik7XG4gICAgc3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lcyA9IHNodWZmbGVBcnJheShsZWZ0UG9vbCk7XG4gICAgc3RhdGUuc2h1ZmZsZUluZGV4ID0gMDtcbiAgICBzdGF0ZS5zaHVmZmxlRmlsdGVyS2V5ID0gZmlsdGVyS2V5O1xuICAgIGxhc3RTaG93blNjZW5lSWQgPSBudWxsO1xuICB9XG5cbiAgaWYgKHN0YXRlLnNodWZmbGVJbmRleCA+PSBzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzLmxlbmd0aCkge1xuICAgIHN0YXJ0TmV3UGFzcyhsZWZ0UG9vbCk7XG4gIH1cblxuICBjb25zdCBzaHVmZmxlZCA9IHN0YXRlLnNodWZmbGVkRmlsdGVyZWRTY2VuZXNbc3RhdGUuc2h1ZmZsZUluZGV4XTtcbiAgLy8gVGhlIHNodWZmbGUga2VlcHMgaXRzIHBhc3MncyBzY2VuZSBvYmplY3RzOyBhIGJhY2tncm91bmQgcmVmcmVzaCBtYXkgaGF2ZSByZXBsYWNlZCB0aGVtIHNpbmNlXG4gIGNvbnN0IHNjZW5lID0gbGVmdFBvb2wuZmluZCgocykgPT4gcy5pZCA9PT0gc2h1ZmZsZWQuaWQpID8/IHNodWZmbGVkO1xuICBzdGF0ZS5zaHVmZmxlSW5kZXgrKztcbiAgbGFzdFNob3duU2NlbmVJZCA9IHNjZW5lLmlkO1xuICBjb25zb2xlLmxvZyhcbiAgICBgW1N0YXNoIEJhdHRsZV0g8J+TjSBQaWNrZWQgc2NlbmUgJHtzY2VuZS5pZH0gKCR7c3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lcy5sZW5ndGggLSBzdGF0ZS5zaHVmZmxlSW5kZXh9IGxlZnQgaW4gdGhpcyBwYXNzKWAsXG4gICk7XG4gIHJldHVybiBzY2VuZTtcbn1cblxuLyoqXG4gKiBPcHBvbmVudHMgKHJpZ2h0IHNpZGUpLCBzb3J0ZWQgYnkgRUxPOiBzY2VuZXMgd2l0aCBhbiBFTE8sIG9yIHRoZSBmaWx0ZXJlZCBzY2VuZXMgd2hlbiBcInVzZVxuICogZmlsdGVyZWQgc2NlbmVzIGZvciBib3RoIHNpZGVzXCIgaXMgb24gKHVucmF0ZWQgb25lcyB0aGVuIHNvcnQgbGFzdCkuXG4gKi9cbmZ1bmN0aW9uIGJ1aWxkT3Bwb25lbnRQb29sKGFsbFNjZW5lczogU2NlbmVbXSwgbGVmdFBvb2w6IFNjZW5lW10sIGZpbHRlcnM6IExpc3RGaWx0ZXJzKTogU2NlbmVbXSB7XG4gIGlmIChzdGF0ZS5zZXR0aW5ncy5maWx0ZXJPcHBvbmVudHMgJiYgZmlsdGVycy5maWx0ZXJBY3RpdmUpIHtcbiAgICByZXR1cm4gbGVmdFBvb2w7XG4gIH1cbiAgY29uc3QgcmF0ZWQgPSBhbGxTY2VuZXMuZmlsdGVyKGlzUmF0ZWQpO1xuICByZXR1cm4gcmF0ZWQubGVuZ3RoID49IDEgPyByYXRlZCA6IGFsbFNjZW5lcztcbn1cblxuLyoqIExvYWQgdGhlIGxlZnQgKFwidG8gcmF0ZVwiKSBhbmQgZnVsbCBwb29scy4gQm90aCBjb21lIGZyb20gdGhlIGNhY2hlLCBzb3J0ZWQgYnkgRUxPLiAqL1xuYXN5bmMgZnVuY3Rpb24gbG9hZFNjZW5lUG9vbHMoXG4gIGZpbHRlcnM6IExpc3RGaWx0ZXJzLFxuKTogUHJvbWlzZTx7IGxlZnRQb29sOiBTY2VuZVtdOyBhbGxTY2VuZXM6IFNjZW5lW10gfT4ge1xuICBsZXQgbGVmdFBvb2w6IFNjZW5lW107XG4gIGxldCBhbGxTY2VuZXM6IFNjZW5lW107XG5cbiAgaWYgKGZpbHRlcnMuZmlsdGVyQWN0aXZlKSB7XG4gICAgLy8gUmUtcXVlcnkgdGhlIGZpbHRlciBhZnRlciBlYWNoIGZ1bGwgcGFzcyBzbyBmaWx0ZXJzIGxpa2UgXCJ1bnJhdGVkXCIgc2hyaW5rIGFzIHNjZW5lcyBnZXQgcmF0ZWRcbiAgICBjb25zdCBwYXNzQ29tcGxldGUgPSBpc1NodWZmbGVDeWNsZUNvbXBsZXRlKGZpbHRlcnMuZmlsdGVyS2V5KTtcbiAgICBpZiAocGFzc0NvbXBsZXRlKSB7XG4gICAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCflIEgUGFzcyBjb21wbGV0ZSwgcmUtZmV0Y2hpbmcgZmlsdGVyZWQgc2NlbmVzXCIpO1xuICAgICAgYXdhaXQgY2xlYXJGaWx0ZXJlZENhY2hlKCk7XG4gICAgfVxuICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+TiyBGaWx0ZXIgYWN0aXZlLCBmZXRjaGluZyBmaWx0ZXJlZCArIGFsbCBzY2VuZXNcIik7XG4gICAgY29uc3QgW2ZpbHRlcmVkUmVzdWx0LCBhbGxSZXN1bHRdID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xuICAgICAgZ2V0RmlsdGVyZWRTY2VuZXNDYWNoZWQoZmlsdGVycyksXG4gICAgICBnZXRBbGxTY2VuZXNDYWNoZWQoKSxcbiAgICBdKTtcbiAgICBsZWZ0UG9vbCA9IGZpbHRlcmVkUmVzdWx0LnNjZW5lcyB8fCBbXTtcbiAgICBhbGxTY2VuZXMgPSBhbGxSZXN1bHQuc2NlbmVzIHx8IFtdO1xuICAgIC8vIFN0YXJ0IHRoZSBuZXh0IHBhc3Mgbm93LCBzbyBsYXRlciBsb2FkcyBpbiBhIHJ1biAod2hpY2ggcGljayBubyBuZXcgbGVmdCBzY2VuZSkgZG9uJ3RcbiAgICAvLyBzZWUgdGhlIHBhc3MgYXMgY29tcGxldGUgYW5kIHJlLWZldGNoIHRoZSBmaWx0ZXIgZXZlcnkgdGltZVxuICAgIGlmIChwYXNzQ29tcGxldGUpIHN0YXJ0TmV3UGFzcyhsZWZ0UG9vbCk7XG4gIH0gZWxzZSB7XG4gICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5OLIE5vIGZpbHRlciBhY3RpdmUsIHVzaW5nIGFsbCBzY2VuZXNcIik7XG4gICAgYWxsU2NlbmVzID0gKGF3YWl0IGdldEFsbFNjZW5lc0NhY2hlZCgpKS5zY2VuZXMgfHwgW107XG4gICAgbGVmdFBvb2wgPSBhbGxTY2VuZXM7XG4gIH1cblxuICBzdGF0ZS5sZWZ0UG9vbFNpemUgPSBsZWZ0UG9vbC5sZW5ndGg7XG4gIHJldHVybiB7IGxlZnRQb29sLCBhbGxTY2VuZXMgfTtcbn1cblxuLyoqXG4gKiBSYW5rcyBmb3IgYSByZXN0b3JlZCBwYWlyIGZyb20gdGhlIGN1cnJlbnQgcG9vbHMgKGFsc28gcmVjb3JkaW5nIHRoZSBsZWZ0IHBvb2wncyBzaXplKSwgdGhlIHdheVxuICogdGhlIHBhaXIgZmV0Y2hlcnMgd29yayB0aGVtIG91dDogdGhlIHBsYWNlIGluIHRoZSBvcHBvbmVudCBwb29sLCBhbmQgaW4gUGxhY2VtZW50LCBub25lIGZvciB0aGVcbiAqIHNjZW5lIGJlaW5nIHBsYWNlZCBhbmQgdGhlIG9wcG9uZW50J3MgcGxhY2UgaW4gdGhlIHBvb2wgd2l0aG91dCBpdC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHBhaXJSYW5rcyhsZWZ0OiBTY2VuZSwgcmlnaHQ6IFNjZW5lKTogUHJvbWlzZTxbUmFuaywgUmFua10+IHtcbiAgY29uc3QgZmlsdGVycyA9IHJlYWRGaWx0ZXJzKCk7XG4gIGNvbnN0IHsgbGVmdFBvb2wsIGFsbFNjZW5lcyB9ID0gYXdhaXQgbG9hZFNjZW5lUG9vbHMoZmlsdGVycyk7XG4gIGxldCBwb29sID0gYnVpbGRPcHBvbmVudFBvb2woYWxsU2NlbmVzLCBsZWZ0UG9vbCwgZmlsdGVycyk7XG4gIGNvbnN0IHJhbmsgPSAoc2NlbmU6IFNjZW5lKTogUmFuayA9PiB7XG4gICAgY29uc3QgaWR4ID0gcG9vbC5maW5kSW5kZXgoKHMpID0+IHMuaWQgPT09IHNjZW5lLmlkKTtcbiAgICByZXR1cm4gaWR4ID49IDAgPyBpZHggKyAxIDogbnVsbDtcbiAgfTtcbiAgaWYgKHN0YXRlLmN1cnJlbnRNb2RlID09PSBcInBsYWNlbWVudFwiKSB7XG4gICAgcG9vbCA9IHBvb2wuZmlsdGVyKChzKSA9PiBzLmlkICE9PSBsZWZ0LmlkKTtcbiAgICByZXR1cm4gW251bGwsIHJhbmsocmlnaHQpXTtcbiAgfVxuICByZXR1cm4gW3JhbmsobGVmdCksIHJhbmsocmlnaHQpXTtcbn1cblxuLyoqIExvYWQgbGVmdCAoc2NlbmUgdG8gcmF0ZSkgYW5kIHJpZ2h0IChvcHBvbmVudCkgcG9vbHMgZm9yIFN3aXNzLiAqL1xuYXN5bmMgZnVuY3Rpb24gYnVpbGRTd2lzc1Bvb2xzKCk6IFByb21pc2U8e1xuICBsZWZ0UG9vbDogU2NlbmVbXTtcbiAgcmlnaHRQb29sOiBTY2VuZVtdO1xuICBmaWx0ZXJLZXk6IHN0cmluZztcbn0+IHtcbiAgY29uc3QgZmlsdGVycyA9IHJlYWRGaWx0ZXJzKCk7XG4gIGNvbnN0IHsgbGVmdFBvb2wsIGFsbFNjZW5lcyB9ID0gYXdhaXQgbG9hZFNjZW5lUG9vbHMoZmlsdGVycyk7XG5cbiAgaWYgKGFsbFNjZW5lcy5sZW5ndGggPCAyKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiTm90IGVub3VnaCBzY2VuZXMgZm9yIGNvbXBhcmlzb24uXCIpO1xuICB9XG5cbiAgY29uc3QgcmlnaHRQb29sID0gYnVpbGRPcHBvbmVudFBvb2woYWxsU2NlbmVzLCBsZWZ0UG9vbCwgZmlsdGVycyk7XG4gIGlmIChzdGF0ZS5zZXR0aW5ncy5maWx0ZXJPcHBvbmVudHMgJiYgZmlsdGVycy5maWx0ZXJBY3RpdmUgJiYgcmlnaHRQb29sLmxlbmd0aCA8IDIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJOb3QgZW5vdWdoIHNjZW5lcyBpbiB5b3VyIGZpbHRlciBmb3IgYSBtYXRjaC4gWW91IG5lZWQgYXQgbGVhc3QgMiBzY2VuZXMuXCIpO1xuICB9XG5cbiAgcmV0dXJuIHsgbGVmdFBvb2wsIHJpZ2h0UG9vbCwgZmlsdGVyS2V5OiBmaWx0ZXJzLmZpbHRlcktleSB9O1xufVxuXG4vLyBTd2lzcyBtb2RlOiBsZWZ0ID0gc2NlbmUgdG8gcmF0ZSAoZmlsdGVyZWQgcG9vbCksIHJpZ2h0ID0gc2ltaWxhci1zdHJlbmd0aCBvcHBvbmVudFxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGZldGNoU3dpc3NQYWlyKGZvcmNlZExlZnRTY2VuZTogU2NlbmUgfCBudWxsID0gbnVsbCk6IFByb21pc2U8U3dpc3NQYWlyUmVzdWx0PiB7XG4gIGNvbnN0IHsgbGVmdFBvb2wsIHJpZ2h0UG9vbCwgZmlsdGVyS2V5IH0gPSBhd2FpdCBidWlsZFN3aXNzUG9vbHMoKTtcblxuICBjb25zdCBzY2VuZTEgPSBmb3JjZWRMZWZ0U2NlbmUgfHwgZ2V0TmV4dEZpbHRlcmVkU2NlbmUobGVmdFBvb2wsIGZpbHRlcktleSk7XG4gIGlmICghc2NlbmUxKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiTm8gc2NlbmVzIG1hdGNoIHlvdXIgZmlsdGVyIGNyaXRlcmlhLlwiKTtcbiAgfVxuXG4gIGNvbnN0IHsgc2NlbmUyLCByYW5rcyB9ID0gcGlja1N3aXNzT3Bwb25lbnQoc2NlbmUxLCByaWdodFBvb2wpO1xuICByZXR1cm4geyBzY2VuZXM6IFtzY2VuZTEsIHNjZW5lMl0sIHJhbmtzIH07XG59XG5cbi8qKlxuICogUGljayBhIHJhbmRvbSBvcHBvbmVudCB3aXRoaW4gwrFTV0lTU19PUFBPTkVOVF9FTE9fV0lORE9XIG9mIHNjZW5lMSdzIEVMTyBpbiB0aGUgRUxPLXNvcnRlZCByaWdodFxuICogcG9vbCAodW5yYXRlZCBzY2VuZXMgY291bnQgYXMgMTUwMCksIG9yIGFtb25nIHRoZSBuZWFyZXN0IGZldyB3aGVuIHRoZSB3aW5kb3cgaGFzIHRvbyBmZXcuXG4gKi9cbmZ1bmN0aW9uIHBpY2tTd2lzc09wcG9uZW50KFxuICBzY2VuZTE6IFNjZW5lLFxuICByaWdodFBvb2w6IFNjZW5lW10sXG4pOiB7IHNjZW5lMjogU2NlbmU7IHJhbmtzOiBbUmFuaywgUmFua10gfSB7XG4gIGNvbnN0IHNjZW5lMUlkeEluUG9vbCA9IHJpZ2h0UG9vbC5maW5kSW5kZXgoKHMpID0+IHMuaWQgPT09IHNjZW5lMS5pZCk7XG4gIGNvbnN0IHNjZW5lMVJhbmtJblBvb2wgPSBzY2VuZTFJZHhJblBvb2wgPj0gMCA/IHNjZW5lMUlkeEluUG9vbCArIDEgOiBudWxsO1xuXG4gIGNvbnN0IGNhbmRpZGF0ZXMgPSBzd2lzc09wcG9uZW50SW5kZXhlcyhcbiAgICByaWdodFBvb2wsXG4gICAgZWZmZWN0aXZlRWxvKGxhdGVzdFNjZW5lKHNjZW5lMSkpLFxuICAgIHNjZW5lMS5pZCxcbiAgICBTV0lTU19PUFBPTkVOVF9FTE9fV0lORE9XLFxuICAgIFNXSVNTX09QUE9ORU5UX01JTl9DQU5ESURBVEVTLFxuICApO1xuICBpZiAoY2FuZGlkYXRlcy5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJOb3QgZW5vdWdoIHNjZW5lcyBmb3IgY29tcGFyaXNvbi4gWW91IG5lZWQgYXQgbGVhc3QgMiBzY2VuZXMuXCIpO1xuICB9XG5cbiAgY29uc3QgaWR4ID0gY2FuZGlkYXRlc1tNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkgKiBjYW5kaWRhdGVzLmxlbmd0aCldO1xuICByZXR1cm4ge1xuICAgIHNjZW5lMjogcmlnaHRQb29sW2lkeF0sXG4gICAgcmFua3M6IFtzY2VuZTFSYW5rSW5Qb29sLCBpZHggKyAxXSxcbiAgfTtcbn1cblxuLyoqIFJhbmRvbSBwaWNrIGZyb20gdGhlIE4gdW5iZWF0ZW4gb3Bwb25lbnRzIGNsb3Nlc3QgYWJvdmUgdGhlIGNoYW1waW9uIChsaXN0IGlzIEVMTy1zb3J0ZWQpLiAqL1xuZnVuY3Rpb24gcGlja0Nsb3Nlc3RDaGFtcGlvbk9wcG9uZW50KHJlbWFpbmluZ09wcG9uZW50czogU2NlbmVbXSk6IFNjZW5lIHtcbiAgY29uc3QgY2xvc2VzdCA9IHJlbWFpbmluZ09wcG9uZW50cy5zbGljZSgtQ0xJTUJfT1BQT05FTlRfUElDS19XSU5ET1cpO1xuICByZXR1cm4gY2xvc2VzdFtNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkgKiBjbG9zZXN0Lmxlbmd0aCldO1xufVxuXG4vKiogT3Bwb25lbnRzIGFib3ZlIHRoZSBjaGFtcGlvbiBpbiB0aGUgRUxPLXNvcnRlZCBwb29sIHRoYXQgaXQgaGFzbid0IGJlYXRlbiBpbiB0aGlzIHJ1bi4gKi9cbmZ1bmN0aW9uIGdldFJlbWFpbmluZ0NoYW1waW9uT3Bwb25lbnRzKGNoYW1waW9uOiBTY2VuZSwgcmlnaHRQb29sOiBTY2VuZVtdLCBjaGFtcGlvbkluZGV4OiBudW1iZXIpOiBTY2VuZVtdIHtcbiAgY29uc3QgY2hhbXBpb25FbG8gPSBlZmZlY3RpdmVFbG8oY2hhbXBpb24sIENIQU1QSU9OX1VOUkFURURfRUxPKTtcbiAgcmV0dXJuIHJpZ2h0UG9vbC5maWx0ZXIoKHMsIGlkeCkgPT4ge1xuICAgIGlmIChzLmlkID09PSBjaGFtcGlvbi5pZCB8fCBzdGF0ZS5jaGFtcGlvbkRlZmVhdGVkLmluY2x1ZGVzKHMuaWQpKSByZXR1cm4gZmFsc2U7XG4gICAgcmV0dXJuIGlkeCA8IGNoYW1waW9uSW5kZXggfHwgKGVsbyhzKSA/PyAtSW5maW5pdHkpID49IGNoYW1waW9uRWxvO1xuICB9KTtcbn1cblxuLyoqIExvd2VzdCBzY2VuZSB3aXRoIGFuIEVMTyBpbiB0aGUgcG9vbCAoZXhjbHVkaW5nIG9uZSBzY2VuZSksIG9yIGFueSBvdGhlciBzY2VuZSBpZiBub25lIGhhcyBvbmUuICovXG5mdW5jdGlvbiBmaW5kTG93ZXN0UmF0ZWQoc2NlbmVzOiBTY2VuZVtdLCBleGNsdWRlSWQ6IHN0cmluZyk6IHsgc2NlbmU6IFNjZW5lIHwgdW5kZWZpbmVkOyBpbmRleDogbnVtYmVyIH0ge1xuICBmb3IgKGxldCBpID0gc2NlbmVzLmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7XG4gICAgY29uc3QgcyA9IHNjZW5lc1tpXTtcbiAgICBpZiAocy5pZCAhPT0gZXhjbHVkZUlkICYmIGlzUmF0ZWQocykpIHtcbiAgICAgIHJldHVybiB7IHNjZW5lOiBzLCBpbmRleDogaSB9O1xuICAgIH1cbiAgfVxuICBjb25zdCBmYWxsYmFja0luZGV4ID0gc2NlbmVzLmZpbmRJbmRleCgocykgPT4gcy5pZCAhPT0gZXhjbHVkZUlkKTtcbiAgcmV0dXJuIHsgc2NlbmU6IHNjZW5lc1tmYWxsYmFja0luZGV4XSwgaW5kZXg6IGZhbGxiYWNrSW5kZXggfTtcbn1cblxuLy8gQ2hhbXBpb24gbW9kZTogd2lubmVyIHN0YXlzIG9uLCBzdGFydGluZyBhZ2FpbnN0IHRoZSBsb3dlc3QtcmF0ZWQgc2NlbmVcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBmZXRjaENoYW1waW9uUGFpcihcbiAgZm9yY2VkTGVmdFNjZW5lOiBTY2VuZSB8IG51bGwgPSBudWxsLFxuKTogUHJvbWlzZTxDaGFtcGlvblBhaXJSZXN1bHQ+IHtcbiAgY29uc3QgZmlsdGVycyA9IHJlYWRGaWx0ZXJzKCk7XG5cbiAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5OLIEZldGNoaW5nIHNjZW5lcyBmb3IgY2hhbXBpb24uLi5cIik7XG4gIGNvbnN0IHsgbGVmdFBvb2wsIGFsbFNjZW5lcyB9ID0gYXdhaXQgbG9hZFNjZW5lUG9vbHMoZmlsdGVycyk7XG5cbiAgY29uc3QgcmlnaHRQb29sID0gYnVpbGRPcHBvbmVudFBvb2woYWxsU2NlbmVzLCBsZWZ0UG9vbCwgZmlsdGVycyk7XG4gIHN0YXRlLnRvdGFsU2NlbmVzQ291bnQgPSByaWdodFBvb2wubGVuZ3RoO1xuXG4gIGlmIChhbGxTY2VuZXMubGVuZ3RoIDwgMikge1xuICAgIHRocm93IG5ldyBFcnJvcihcIk5vdCBlbm91Z2ggc2NlbmVzIGZvciBjb21wYXJpc29uLlwiKTtcbiAgfVxuXG4gIC8vIE5vIGNoYW1waW9uIHlldDogdGhlIGNoYWxsZW5nZXIgZnJvbSB0aGUgbGVmdCBwb29sIHN0YXJ0cyBhZ2FpbnN0IHRoZSBsb3dlc3QtcmF0ZWQgc2NlbmVcbiAgaWYgKCFzdGF0ZS5jaGFtcGlvblNjZW5lKSB7XG4gICAgc3RhdGUuY2hhbXBpb25EZWZlYXRlZCA9IFtdO1xuXG4gICAgY29uc3QgY2hhbGxlbmdlciA9IGZvcmNlZExlZnRTY2VuZSB8fCBnZXROZXh0RmlsdGVyZWRTY2VuZShsZWZ0UG9vbCwgZmlsdGVycy5maWx0ZXJLZXkpO1xuICAgIGlmICghY2hhbGxlbmdlcikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiTm8gc2NlbmVzIG1hdGNoIHlvdXIgZmlsdGVyIGNyaXRlcmlhLlwiKTtcbiAgICB9XG5cbiAgICBjb25zdCBjaGFsbGVuZ2VySW5kZXggPSByaWdodFBvb2wuZmluZEluZGV4KChzKSA9PiBzLmlkID09PSBjaGFsbGVuZ2VyLmlkKTtcbiAgICBjb25zdCB7IHNjZW5lOiBsb3dlc3RSYXRlZCwgaW5kZXg6IGxvd2VzdEluZGV4IH0gPSBmaW5kTG93ZXN0UmF0ZWQocmlnaHRQb29sLCBjaGFsbGVuZ2VyLmlkKTtcbiAgICBpZiAoIWxvd2VzdFJhdGVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJOb3QgZW5vdWdoIHNjZW5lcyBmb3IgY29tcGFyaXNvbi4gWW91IG5lZWQgYXQgbGVhc3QgMiBzY2VuZXMuXCIpO1xuICAgIH1cblxuICAgIHJldHVybiB7XG4gICAgICBzY2VuZXM6IFtjaGFsbGVuZ2VyLCBsb3dlc3RSYXRlZF0sXG4gICAgICByYW5rczogW2NoYWxsZW5nZXJJbmRleCA+PSAwID8gY2hhbGxlbmdlckluZGV4ICsgMSA6IG51bGwsIGxvd2VzdEluZGV4ICsgMV0sXG4gICAgICBpc1ZpY3Rvcnk6IGZhbHNlLFxuICAgIH07XG4gIH1cblxuICBjb25zdCBjaGFtcGlvbiA9IHN0YXRlLmNoYW1waW9uU2NlbmU7XG4gIGNvbnN0IGNoYW1waW9uSW5kZXggPSByaWdodFBvb2wuZmluZEluZGV4KChzKSA9PiBzLmlkID09PSBjaGFtcGlvbi5pZCk7XG4gIGNvbnN0IHJlbWFpbmluZ09wcG9uZW50cyA9IGdldFJlbWFpbmluZ0NoYW1waW9uT3Bwb25lbnRzKGNoYW1waW9uLCByaWdodFBvb2wsIGNoYW1waW9uSW5kZXgpO1xuXG4gIC8vIE5vIG9wcG9uZW50cyBsZWZ0OiB0aGUgY2hhbXBpb24gaGFzIGJlYXRlbiBldmVyeW9uZSBhYm92ZSBpdFxuICBpZiAocmVtYWluaW5nT3Bwb25lbnRzLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiB7IHNjZW5lczogW2NoYW1waW9uXSwgcmFua3M6IFsxXSwgaXNWaWN0b3J5OiB0cnVlIH07XG4gIH1cblxuICBjb25zdCBuZXh0T3Bwb25lbnQgPSBwaWNrQ2xvc2VzdENoYW1waW9uT3Bwb25lbnQocmVtYWluaW5nT3Bwb25lbnRzKTtcbiAgY29uc3QgbmV4dE9wcG9uZW50SW5kZXggPSByaWdodFBvb2wuZmluZEluZGV4KChzKSA9PiBzLmlkID09PSBuZXh0T3Bwb25lbnQuaWQpO1xuXG4gIHJldHVybiB7XG4gICAgc2NlbmVzOiBbY2hhbXBpb24sIG5leHRPcHBvbmVudF0sXG4gICAgcmFua3M6IFtjaGFtcGlvbkluZGV4ID49IDAgPyBjaGFtcGlvbkluZGV4ICsgMSA6IG51bGwsIG5leHRPcHBvbmVudEluZGV4ICsgMV0sXG4gICAgaXNWaWN0b3J5OiBmYWxzZSxcbiAgfTtcbn1cblxuLy8gLS0tIFBsYWNlbWVudCBtb2RlICh0aGUgc2VhcmNoIGl0c2VsZiBpcyBpbiBwbGFjZW1lbnQudHMpIC0tLVxuXG4vKiogUmFuZG9tIHBpY2sgYW1vbmcgc2NlbmVzIGluIFtsbywgaGkpIHRoYXQgc2hhcmUgcG9vbFtpZHhdJ3MgRUxPICh0aGVpciBvcmRlciBpcyBhcmJpdHJhcnkpLiAqL1xuZnVuY3Rpb24gcGlja0Ftb25nVGllcyhwb29sOiBTY2VuZVtdLCBpZHg6IG51bWJlciwgbG86IG51bWJlciwgaGk6IG51bWJlcik6IG51bWJlciB7XG4gIGNvbnN0IHRhcmdldCA9IGVsbyhwb29sW2lkeF0pO1xuICBjb25zdCB0aWVzOiBudW1iZXJbXSA9IFtdO1xuICBmb3IgKGxldCBpID0gbG87IGkgPCBoaTsgaSsrKSB7XG4gICAgaWYgKGVsbyhwb29sW2ldKSA9PT0gdGFyZ2V0KSB0aWVzLnB1c2goaSk7XG4gIH1cbiAgcmV0dXJuIHRpZXNbTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogdGllcy5sZW5ndGgpXTtcbn1cblxuLy8gUGxhY2VtZW50IG1vZGU6IGxlZnQgPSBzY2VuZSBiZWluZyBwbGFjZWQsIHJpZ2h0ID0gdGhlIG5leHQgb3Bwb25lbnQgaW4gaXRzIHNlYXJjaCByYW5nZVxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGZldGNoUGxhY2VtZW50UGFpcihcbiAgZm9yY2VkTGVmdFNjZW5lOiBTY2VuZSB8IG51bGwgPSBudWxsLFxuKTogUHJvbWlzZTxQbGFjZW1lbnRQYWlyUmVzdWx0PiB7XG4gIGNvbnN0IGZpbHRlcnMgPSByZWFkRmlsdGVycygpO1xuICBjb25zdCB7IGxlZnRQb29sLCBhbGxTY2VuZXMgfSA9IGF3YWl0IGxvYWRTY2VuZVBvb2xzKGZpbHRlcnMpO1xuXG4gIGlmIChhbGxTY2VuZXMubGVuZ3RoIDwgMikge1xuICAgIHRocm93IG5ldyBFcnJvcihcIk5vdCBlbm91Z2ggc2NlbmVzIGZvciBjb21wYXJpc29uLlwiKTtcbiAgfVxuXG4gIGlmICghc3RhdGUucGxhY2VtZW50KSB7XG4gICAgY29uc3Qgc2NlbmUgPSBmb3JjZWRMZWZ0U2NlbmUgfHwgZ2V0TmV4dEZpbHRlcmVkU2NlbmUobGVmdFBvb2wsIGZpbHRlcnMuZmlsdGVyS2V5KTtcbiAgICBpZiAoIXNjZW5lKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJObyBzY2VuZXMgbWF0Y2ggeW91ciBmaWx0ZXIgY3JpdGVyaWEuXCIpO1xuICAgIH1cbiAgICBzdGF0ZS5wbGFjZW1lbnQgPSBuZXdQbGFjZW1lbnRSdW4oc2NlbmUsIHN0YXRlLnNldHRpbmdzLnBsYWNlbWVudEZyb21Cb3R0b20pO1xuICB9XG4gIGNvbnN0IHJ1biA9IHN0YXRlLnBsYWNlbWVudDtcblxuICBjb25zdCBwb29sID0gYnVpbGRPcHBvbmVudFBvb2woYWxsU2NlbmVzLCBsZWZ0UG9vbCwgZmlsdGVycykuZmlsdGVyKChzKSA9PiBzLmlkICE9PSBydW4uc2NlbmUuaWQpO1xuICBpZiAocG9vbC5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJOb3QgZW5vdWdoIHNjZW5lcyBmb3IgY29tcGFyaXNvbi4gWW91IG5lZWQgYXQgbGVhc3QgMiBzY2VuZXMuXCIpO1xuICB9XG4gIHN0YXRlLnRvdGFsU2NlbmVzQ291bnQgPSBwb29sLmxlbmd0aCArIDE7XG5cbiAgY29uc3Qgc3RlcCA9IHBsYWNlbWVudFN0ZXAocnVuLCBwb29sKTtcbiAgcnVuLnJhbmdlTG8gPSBNYXRoLm1pbihzdGVwLmxvLCBzdGVwLmhpKTtcbiAgcnVuLnJhbmdlSGkgPSBzdGVwLmhpO1xuXG4gIGlmIChzdGVwLmRvbmUpIHtcbiAgICAvLyBPbmx5IHRoZSBwbGFjZWQgc2NlbmUncyBFTE8gY2hhbmdlczsgaXQncyBjcmVkaXRlZCB3aXRoIHRoZSBiYXR0bGVzIHRoaXMgcnVuIHRvb2tcbiAgICBjb25zdCBuZXdFbG8gPSBsYW5kaW5nRWxvKHBvb2wsIHN0ZXAuc2xvdCk7XG4gICAgY29uc3QgbmV3QmF0dGxlcyA9IGJhdHRsZXMobGF0ZXN0U2NlbmUocnVuLnNjZW5lKSkgKyBydW4uYmF0dGxlcztcbiAgICBjb25zb2xlLmxvZyhcbiAgICAgIGBbU3Rhc2ggQmF0dGxlXSDwn5ONIFBsYWNlbWVudDogc2NlbmUgJHtydW4uc2NlbmUuaWR9IHBsYWNlZCBhdCAjJHtzdGVwLnNsb3QgKyAxfSBhZnRlciAke3J1bi5iYXR0bGVzfSBiYXR0bGVzLCBFTE8gJHtuZXdFbG99YCxcbiAgICApO1xuICAgIGF3YWl0IHdyaXRlRWxvKHJ1bi5zY2VuZSwgbmV3RWxvLCBuZXdCYXR0bGVzKTtcbiAgICByZXR1cm4ge1xuICAgICAgZG9uZTogdHJ1ZSxcbiAgICAgIHNjZW5lOiBydW4uc2NlbmUsXG4gICAgICByYW5rOiBzdGVwLnNsb3QgKyAxLFxuICAgICAgZWxvOiBuZXdFbG8sXG4gICAgICBiYXR0bGVzOiBydW4uYmF0dGxlcyxcbiAgICAgIHN0cmVhazogcnVuLnN0cmVhayxcbiAgICAgIGZyb21Cb3R0b206IHJ1bi5mcm9tQm90dG9tLFxuICAgIH07XG4gIH1cblxuICBjb25zdCBpZHggPSBwaWNrQW1vbmdUaWVzKHBvb2wsIHN0ZXAuaW5kZXgsIHN0ZXAubG8sIHN0ZXAuaGkpO1xuICByZXR1cm4geyBkb25lOiBmYWxzZSwgc2NlbmVzOiBbcnVuLnNjZW5lLCBwb29sW2lkeF1dLCByYW5rczogW251bGwsIGlkeCArIDFdIH07XG59XG4iLCAiLy8gTGlicmFyeS13aWRlIG51bWJlcnMgd29ya2VkIG91dCBmcm9tIHRoZSBzY2VuZXMgKHRpZXJzIHNvIGZhcikuIFB1cmUgZnVuY3Rpb25zOiBubyBzdGF0ZSwgbm8gSS9PLlxuXG5pbXBvcnQgeyBUSUVSUyB9IGZyb20gXCIuL2NvbnN0YW50c1wiO1xuaW1wb3J0IHsgZWxvLCBpc1Byb3Zpc2lvbmFsIH0gZnJvbSBcIi4vc2NvcmVcIjtcbmltcG9ydCB0eXBlIHsgU2NlbmUsIFRpZXIgfSBmcm9tIFwiLi90eXBlc1wiO1xuXG4vKipcbiAqIFRpZXIgZm9yIGV2ZXJ5IHNldHRsZWQgc2NlbmUgKHJhdGVkIGFuZCBub3QgcHJvdmlzaW9uYWwpLCBieSByYW5rIGFtb25nIHRoZW06IGEgc2NlbmUgd2hvc2VcbiAqIHJhbmsgaXMgd2l0aGluIHRoZSB0b3AgYHRpZXIudG9wYCBzaGFyZSBnZXRzIHRoYXQgdGllci4gVGllZCBzY2VuZXMgc2hhcmUgdGhlIG1pZGRsZSBwb3NpdGlvblxuICogb2YgdGhlaXIgdGllIGdyb3VwLCBhcyBpbiBwZXJjZW50aWxlUmF0aW5ncywgc28gdGhleSBhbHdheXMgc2hhcmUgYSB0aWVyLiBQcm92aXNpb25hbCBhbmRcbiAqIHVucmF0ZWQgc2NlbmVzIGdldCBub25lLCBsaWtlIFwidW5yYW5rZWRcIiB1bnRpbCBwbGFjZW1lbnQgbWF0Y2hlcyBhcmUgZG9uZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRpZXJNYXAoc2NlbmVzOiBTY2VuZVtdKTogTWFwPHN0cmluZywgVGllcj4ge1xuICBjb25zdCBzZXR0bGVkID0gc2NlbmVzXG4gICAgLmZpbHRlcigoc2NlbmUpID0+ICFpc1Byb3Zpc2lvbmFsKHNjZW5lKSlcbiAgICAubWFwKChzY2VuZSkgPT4gKHsgaWQ6IHNjZW5lLmlkLCBlbG86IGVsbyhzY2VuZSkgfSkpXG4gICAgLmZpbHRlcigocyk6IHMgaXMgeyBpZDogc3RyaW5nOyBlbG86IG51bWJlciB9ID0+IHMuZWxvICE9PSBudWxsKVxuICAgIC5zb3J0KChhLCBiKSA9PiBiLmVsbyAtIGEuZWxvKTtcblxuICBjb25zdCB0aWVycyA9IG5ldyBNYXA8c3RyaW5nLCBUaWVyPigpO1xuICBjb25zdCBuID0gc2V0dGxlZC5sZW5ndGg7XG4gIGxldCBzdGFydCA9IDA7XG4gIHdoaWxlIChzdGFydCA8IG4pIHtcbiAgICBsZXQgZW5kID0gc3RhcnQ7XG4gICAgd2hpbGUgKGVuZCArIDEgPCBuICYmIHNldHRsZWRbZW5kICsgMV0uZWxvID09PSBzZXR0bGVkW3N0YXJ0XS5lbG8pIGVuZCsrO1xuICAgIC8vIFNoYXJlIG9mIHNldHRsZWQgc2NlbmVzIHJhbmtlZCBhYm92ZSB0aGlzIHRpZSBncm91cCdzIG1pZGRsZSAoMCBmb3IgdGhlIHRvcCBzY2VuZSlcbiAgICBjb25zdCBhYm92ZSA9IChzdGFydCArIGVuZCkgLyAyIC8gbjtcbiAgICBjb25zdCB0aWVyID0gVElFUlMuZmluZCgodCkgPT4gYWJvdmUgPCB0LnRvcCkgPz8gVElFUlNbVElFUlMubGVuZ3RoIC0gMV07XG4gICAgZm9yIChsZXQgaSA9IHN0YXJ0OyBpIDw9IGVuZDsgaSsrKSB0aWVycy5zZXQoc2V0dGxlZFtpXS5pZCwgdGllcik7XG4gICAgc3RhcnQgPSBlbmQgKyAxO1xuICB9XG4gIHJldHVybiB0aWVycztcbn1cblxuLyoqIFRvb2x0aXAgZm9yIGEgdGllcjogXCJHb2xkOiBpbiB0aGUgdG9wIDM1JSBvZiB5b3VyIHNjZW5lcyB3aXRoIGEgc2V0dGxlZCBFTE9cIi4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0aWVyRGVzY3JpcHRpb24odGllcjogVGllcik6IHN0cmluZyB7XG4gIGNvbnN0IGluZGV4ID0gVElFUlMuZmluZEluZGV4KCh0KSA9PiB0LmlkID09PSB0aWVyLmlkKTtcbiAgY29uc3QgcGVyY2VudCA9IChzaGFyZTogbnVtYmVyKTogc3RyaW5nID0+IGAke01hdGgucm91bmQoc2hhcmUgKiAxMDApfSVgO1xuICBjb25zdCB3aGVyZSA9XG4gICAgaW5kZXggPT09IFRJRVJTLmxlbmd0aCAtIDEgJiYgaW5kZXggPiAwXG4gICAgICA/IGBiZWxvdyB0aGUgdG9wICR7cGVyY2VudChUSUVSU1tpbmRleCAtIDFdLnRvcCl9YFxuICAgICAgOiBgaW4gdGhlIHRvcCAke3BlcmNlbnQodGllci50b3ApfWA7XG4gIHJldHVybiBgJHt0aWVyLm5hbWV9OiAke3doZXJlfSBvZiB5b3VyIHNjZW5lcyB3aXRoIGEgc2V0dGxlZCBFTE9gO1xufVxuIiwgImltcG9ydCB0eXBlIHsgU2NlbmUgfSBmcm9tIFwiLi4vdHlwZXNcIjtcclxuXHJcbi8qKiBTY2VuZSB0aXRsZSBmcm9tIG1ldGFkYXRhLCBvciB0aGUgZmlsZW5hbWUgKHdpdGhvdXQgZXh0ZW5zaW9uKSBmcm9tIHRoZSBmaWxlIHBhdGguICovXHJcbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlU2NlbmVUaXRsZShzY2VuZTogU2NlbmUpOiBzdHJpbmcge1xyXG4gIGlmIChzY2VuZS50aXRsZSkgcmV0dXJuIHNjZW5lLnRpdGxlO1xyXG5cclxuICBjb25zdCBwYXRoID0gc2NlbmUuZmlsZXM/LlswXT8ucGF0aDtcclxuICBpZiAocGF0aCkge1xyXG4gICAgY29uc3QgcGF0aFBhcnRzID0gcGF0aC5zcGxpdCgvWy9cXFxcXS8pO1xyXG4gICAgcmV0dXJuIHBhdGhQYXJ0c1twYXRoUGFydHMubGVuZ3RoIC0gMV0ucmVwbGFjZSgvXFwuW14vLl0rJC8sIFwiXCIpO1xyXG4gIH1cclxuXHJcbiAgcmV0dXJuIFwiXCI7XHJcbn1cclxuIiwgIi8vIFJlbmRlcnMgYW4gaW5kaXZpZHVhbCBzY2VuZSBjYXJkIChyZXR1cm5zIGFuIEhUTUwgc3RyaW5nKS5cblxuaW1wb3J0IHsgQ0hBTVBJT05fVU5SQVRFRF9FTE8sIEVMT19LX1RJRVJTLCBFTE9fU1RBUlQgfSBmcm9tIFwiLi4vY29uc3RhbnRzXCI7XG5pbXBvcnQgeyBiYXR0bGVzLCBlbG8sIGlzUHJvdmlzaW9uYWwgfSBmcm9tIFwiLi4vc2NvcmVcIjtcbmltcG9ydCB7IHN0YXRlIH0gZnJvbSBcIi4uL3N0YXRlXCI7XG5pbXBvcnQgeyB0aWVyRGVzY3JpcHRpb24gfSBmcm9tIFwiLi4vc3RhdHNcIjtcbmltcG9ydCB7IGlzU3Rhc2hEZWxldGVEaWFsb2dBdmFpbGFibGUgfSBmcm9tIFwiLi9kZWxldGVEaWFsb2dcIjtcbmltcG9ydCB0eXBlIHsgUmFuaywgU2NlbmUsIFRpZXIgfSBmcm9tIFwiLi4vdHlwZXNcIjtcbmltcG9ydCB7IHJlc29sdmVTY2VuZVRpdGxlIH0gZnJvbSBcIi4vc2NlbmVUaXRsZVwiO1xuXG4vKiogVG9vbHRpcCBmb3IgYSBwcm92aXNpb25hbCBFTE8gKHRoZSBcIj9cIiBhZnRlciBpdCkuICovXG5leHBvcnQgY29uc3QgUFJPVklTSU9OQUxfVElQID0gYFByb3Zpc2lvbmFsOiBmZXdlciB0aGFuICR7RUxPX0tfVElFUlNbMF1bMF19IGJhdHRsZXMsIHNvIHRoaXMgRUxPIGlzIHN0aWxsIHNldHRsaW5nYDtcblxuLyoqIFNtYWxsIHBpbGwgd2l0aCB0aGUgdGllcidzIGVtb2ppIGFuZCBuYW1lICh0aGUgbmFtZSBoaWRlcyBvbiBwaG9uZXMpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRpZXJQaWxsKHRpZXI6IFRpZXIpOiBzdHJpbmcge1xuICByZXR1cm4gYDxzcGFuIGNsYXNzPVwic2ItdGllciBzYi10aWVyLSR7dGllci5pZH1cIiB0aXRsZT1cIiR7dGllckRlc2NyaXB0aW9uKHRpZXIpfVwiPiR7dGllci5lbW9qaX08c3BhbiBjbGFzcz1cInNiLXRpZXItbmFtZVwiPiAke3RpZXIubmFtZX08L3NwYW4+PC9zcGFuPmA7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXREdXJhdGlvbihzZWNvbmRzOiBudW1iZXIgfCBudWxsIHwgdW5kZWZpbmVkKTogc3RyaW5nIHtcbiAgaWYgKCFzZWNvbmRzKSByZXR1cm4gXCJOL0FcIjtcbiAgY29uc3QgaCA9IE1hdGguZmxvb3Ioc2Vjb25kcyAvIDM2MDApO1xuICBjb25zdCBtID0gTWF0aC5mbG9vcigoc2Vjb25kcyAlIDM2MDApIC8gNjApO1xuICBjb25zdCBzID0gTWF0aC5mbG9vcihzZWNvbmRzICUgNjApO1xuICBpZiAoaCA+IDApIHtcbiAgICByZXR1cm4gYCR7aH06JHttLnRvU3RyaW5nKCkucGFkU3RhcnQoMiwgXCIwXCIpfToke3MudG9TdHJpbmcoKS5wYWRTdGFydCgyLCBcIjBcIil9YDtcbiAgfVxuICByZXR1cm4gYCR7bX06JHtzLnRvU3RyaW5nKCkucGFkU3RhcnQoMiwgXCIwXCIpfWA7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVTY2VuZUNhcmQoXG4gIHNjZW5lOiBTY2VuZSxcbiAgc2lkZTogXCJsZWZ0XCIgfCBcInJpZ2h0XCIsXG4gIHJhbms6IFJhbmsgPSBudWxsLFxuICBzdGF0dXNCYWRnZTogbnVtYmVyIHwgc3RyaW5nIHwgbnVsbCA9IG51bGwsXG4gIHRpZXI6IFRpZXIgfCBudWxsID0gbnVsbCxcbik6IHN0cmluZyB7XG4gIGNvbnN0IGZpbGUgPSBzY2VuZS5maWxlcyAmJiBzY2VuZS5maWxlc1swXSA/IHNjZW5lLmZpbGVzWzBdIDoge307XG4gIGNvbnN0IGR1cmF0aW9uID0gZmlsZS5kdXJhdGlvbjtcbiAgY29uc3QgcGVyZm9ybWVycyA9XG4gICAgc2NlbmUucGVyZm9ybWVycyAmJiBzY2VuZS5wZXJmb3JtZXJzLmxlbmd0aCA+IDBcbiAgICAgID8gc2NlbmUucGVyZm9ybWVycy5tYXAoKHApID0+IHAubmFtZSkuam9pbihcIiwgXCIpXG4gICAgICA6IFwiTm8gcGVyZm9ybWVyc1wiO1xuICBjb25zdCBzdHVkaW8gPSBzY2VuZS5zdHVkaW8gPyBzY2VuZS5zdHVkaW8ubmFtZSA6IFwiTm8gc3R1ZGlvXCI7XG4gIGNvbnN0IHRhZ3MgPSBzY2VuZS50YWdzID8gc2NlbmUudGFncy5zbGljZSgwLCA1KS5tYXAoKHQpID0+IHQubmFtZSkgOiBbXTtcblxuICBjb25zdCB0aXRsZSA9IHJlc29sdmVTY2VuZVRpdGxlKHNjZW5lKTtcblxuICBjb25zdCBzY3JlZW5zaG90UGF0aCA9IHNjZW5lLnBhdGhzID8gc2NlbmUucGF0aHMuc2NyZWVuc2hvdCA6IG51bGw7XG4gIGNvbnN0IHByZXZpZXdQYXRoID0gc2NlbmUucGF0aHMgPyBzY2VuZS5wYXRocy5wcmV2aWV3IDogbnVsbDtcbiAgY29uc3QgeyBvcGVuSW5OZXdUYWIsIGNsZWFuTW9kZSB9ID0gc3RhdGUuc2V0dGluZ3M7XG4gIGNvbnN0IHN0YXNoUmF0aW5nID0gc2NlbmUucmF0aW5nMTAwID8gYCR7c2NlbmUucmF0aW5nMTAwfS8xMDBgIDogXCJOb25lXCI7XG5cbiAgLy8gRUxPIGJhZGdlOiBcIkVMTyAxNzQwIMK3ICM1MFwiIHdoZW4gcmF0ZWQgKHJhbmsgd2hlbiBrbm93biksIHdpdGggYSBcIj9cIiB3aGlsZSBpdCdzIHByb3Zpc2lvbmFsLlxuICAvLyBVbnJhdGVkIHNjZW5lcyBzaG93IHRoZSBFTE8gdGhleSBjb3VudCBhcyBpbiB0aGlzIG1vZGUgaW4gdGhlIHNhbWUgb3JkZXIsIFwiRUxPIDE1MDAgwrdcbiAgLy8gVW5yYXRlZFwiIChQbGFjZW1lbnQgaGFzIG5vbmU6IFwiVW5yYXRlZFwiKS5cbiAgY29uc3QgZWxvVmFsdWUgPSBlbG8oc2NlbmUpO1xuICBjb25zdCB1bnJhdGVkQXMgPVxuICAgIHN0YXRlLmN1cnJlbnRNb2RlID09PSBcInN3aXNzXCIgPyBFTE9fU1RBUlQgOiBzdGF0ZS5jdXJyZW50TW9kZSA9PT0gXCJjaGFtcGlvblwiID8gQ0hBTVBJT05fVU5SQVRFRF9FTE8gOiBudWxsO1xuICBjb25zdCBwcm92aXNpb25hbCA9IGlzUHJvdmlzaW9uYWwoc2NlbmUpO1xuICBsZXQgZWxvTGFiZWw6IHN0cmluZztcbiAgaWYgKGVsb1ZhbHVlICE9PSBudWxsKSB7XG4gICAgZWxvTGFiZWwgPSBgRUxPICR7TWF0aC5yb3VuZChlbG9WYWx1ZSl9JHtwcm92aXNpb25hbCA/IFwiP1wiIDogXCJcIn0ke3JhbmsgIT09IG51bGwgJiYgcmFuayAhPT0gdW5kZWZpbmVkID8gYCDCtyAjJHtyYW5rfWAgOiBcIlwifWA7XG4gIH0gZWxzZSB7XG4gICAgZWxvTGFiZWwgPSB1bnJhdGVkQXMgIT09IG51bGwgPyBgRUxPICR7dW5yYXRlZEFzfSDCtyBVbnJhdGVkYCA6IFwiVW5yYXRlZFwiO1xuICB9XG4gIGNvbnN0IHJhbmtUaXRsZSA9IHByb3Zpc2lvbmFsID8gYCB0aXRsZT1cIiR7UFJPVklTSU9OQUxfVElQfVwiYCA6IFwiXCI7XG4gIGNvbnN0IHJhbmtEaXNwbGF5ID0gYCR7dGllciA/IHRpZXJQaWxsKHRpZXIpIDogXCJcIn08c3BhbiBjbGFzcz1cInNiLXNjZW5lLXJhbmtcIiR7cmFua1RpdGxlfT4ke2Vsb0xhYmVsfTwvc3Bhbj5gO1xuXG4gIC8vIFN0YXR1cyBiYWRnZTogd2luLXN0cmVhayBjb3VudCAoZm9ybWF0dGVkKSBvciBjdXN0b20gbGFiZWwgKGUuZy4gZmFsbGluZyBtb2RlKVxuICBsZXQgc3RhdHVzQmFkZ2VIdG1sID0gXCJcIjtcbiAgaWYgKHR5cGVvZiBzdGF0dXNCYWRnZSA9PT0gXCJzdHJpbmdcIikge1xuICAgIHN0YXR1c0JhZGdlSHRtbCA9IGA8ZGl2IGNsYXNzPVwic2Itc3RyZWFrLWJhZGdlXCI+JHtzdGF0dXNCYWRnZX08L2Rpdj5gO1xuICB9IGVsc2UgaWYgKHN0YXR1c0JhZGdlICE9PSBudWxsICYmIHN0YXR1c0JhZGdlID4gMCkge1xuICAgIHN0YXR1c0JhZGdlSHRtbCA9IGA8ZGl2IGNsYXNzPVwic2Itc3RyZWFrLWJhZGdlXCI+8J+UpSAke3N0YXR1c0JhZGdlfSB3aW4ke3N0YXR1c0JhZGdlID4gMSA/IFwic1wiIDogXCJcIn08L2Rpdj5gO1xuICB9XG5cbiAgLy8gUHJlc2VydmUgVVJMIHNlYXJjaCBwYXJhbXMgd2hlbiBvcGVuaW5nIHNjZW5lXG4gIGNvbnN0IGN1cnJlbnRQYXJhbXMgPSB3aW5kb3cubG9jYXRpb24uc2VhcmNoO1xuICBjb25zdCBzY2VuZVVybCA9IGAvc2NlbmVzLyR7c2NlbmUuaWR9JHtjdXJyZW50UGFyYW1zfWA7XG4gIGNvbnN0IGxpbmtUYXJnZXQgPSBvcGVuSW5OZXdUYWIgPyBgIHRhcmdldD1cIl9ibGFua1wiIHJlbD1cIm5vb3BlbmVyXCJgIDogXCJcIjtcblxuICAvLyBwd3ItKiBjbGFzc2VzIGFyZSB0aGUgcGx1Z2luJ3MgcHJlLTIuMCBuYW1lczsgU0ZXIFN3aXRjaCBzdGlsbCB0YXJnZXRzIHRoZW0gdG8gYmx1ciBTdGFzaCBCYXR0bGUuXG4gIC8vIEJhZGdlcyBzaXQgb3V0c2lkZSB0aGUgKGJsdXJyZWQpIGltYWdlIGNvbnRhaW5lciBzbyB0aGV5IHN0YXkgcmVhZGFibGUgaW4gU0ZXIG1vZGUuXG4gIHJldHVybiBgXG4gICAgICA8ZGl2IGNsYXNzPVwic2Itc2NlbmUtY2FyZFwiIGRhdGEtc2lkZT1cIiR7c2lkZX1cIj5cbiAgICAgICAgPGRpdiBjbGFzcz1cInNiLXNjZW5lLW1lZGlhXCI+XG4gICAgICAgICAgPGEgY2xhc3M9XCJzYi1zY2VuZS1pbWFnZS1jb250YWluZXIgcHdyLXNjZW5lLWltYWdlLWNvbnRhaW5lclwiIGhyZWY9XCIke3NjZW5lVXJsfVwiJHtsaW5rVGFyZ2V0fT5cbiAgICAgICAgICAgICR7XG4gICAgICAgICAgICAgIHNjcmVlbnNob3RQYXRoXG4gICAgICAgICAgICAgICAgPyBgPGltZyBjbGFzcz1cInNiLXNjZW5lLWltYWdlIHB3ci1zY2VuZS1pbWFnZVwiIHNyYz1cIiR7c2NyZWVuc2hvdFBhdGh9XCIgYWx0PVwiJHt0aXRsZX1cIiBsb2FkaW5nPVwibGF6eVwiIC8+YFxuICAgICAgICAgICAgICAgIDogYDxkaXYgY2xhc3M9XCJzYi1zY2VuZS1pbWFnZSBzYi1uby1pbWFnZVwiPk5vIFNjcmVlbnNob3Q8L2Rpdj5gXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAke3ByZXZpZXdQYXRoID8gYDx2aWRlbyBjbGFzcz1cInNiLWhvdmVyLXByZXZpZXcgcHdyLWhvdmVyLXByZXZpZXdcIiBzcmM9XCIke3ByZXZpZXdQYXRofVwiIGxvb3AgbXV0ZWQgcGxheXNpbmxpbmU+PC92aWRlbz5gIDogXCJcIn1cbiAgICAgICAgICA8L2E+XG4gICAgICAgICAgPGRpdiBjbGFzcz1cInNiLXNjZW5lLWR1cmF0aW9uXCI+JHtmb3JtYXREdXJhdGlvbihkdXJhdGlvbil9PC9kaXY+XG4gICAgICAgICAgJHtzdGF0dXNCYWRnZUh0bWx9XG4gICAgICAgICAgPGRpdiBjbGFzcz1cInNiLWNsaWNrLWhpbnRcIj4ke29wZW5Jbk5ld1RhYiA/IFwiQ2xpY2sgdG8gb3BlbiBpbiBuZXcgdGFiXCIgOiBcIkNsaWNrIHRvIG9wZW4gc2NlbmVcIn08L2Rpdj5cbiAgICAgICAgICA8YSBjbGFzcz1cInNiLW9wZW4tbGlua1wiIGhyZWY9XCIke3NjZW5lVXJsfVwiIHRhcmdldD1cIl9ibGFua1wiIHJlbD1cIm5vb3BlbmVyXCIgdGl0bGU9XCJPcGVuIHNjZW5lIGluIG5ldyB0YWJcIj7ihpc8L2E+XG4gICAgICAgICAgJHtjbGVhbk1vZGUgJiYgaXNTdGFzaERlbGV0ZURpYWxvZ0F2YWlsYWJsZSgpID8gYDxidXR0b24gdHlwZT1cImJ1dHRvblwiIGNsYXNzPVwic2ItZGVsZXRlLWJ0blwiIHRpdGxlPVwiRGVsZXRlIHRoaXMgc2NlbmUgZnJvbSBTdGFzaFwiPvCfl5E8L2J1dHRvbj5gIDogXCJcIn1cbiAgICAgICAgPC9kaXY+XG5cbiAgICAgICAgPGRpdiBjbGFzcz1cInNiLXNjZW5lLWJvZHlcIiBkYXRhLXdpbm5lcj1cIiR7c2NlbmUuaWR9XCI+XG4gICAgICAgICAgPGRpdiBjbGFzcz1cInNiLXNjZW5lLWluZm8gcHdyLXNjZW5lLWluZm9cIj5cbiAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1zY2VuZS10aXRsZS1yb3dcIj5cbiAgICAgICAgICAgICAgPGgzIGNsYXNzPVwic2Itc2NlbmUtdGl0bGVcIj4ke3RpdGxlfTwvaDM+XG4gICAgICAgICAgICAgICR7cmFua0Rpc3BsYXl9XG4gICAgICAgICAgICA8L2Rpdj5cblxuICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNiLXNjZW5lLW1ldGFcIj5cbiAgICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNiLW1ldGEtaXRlbSBzYi1tZXRhLXN0dWRpb1wiPjxzdHJvbmc+U3R1ZGlvOjwvc3Ryb25nPiAke3N0dWRpb308L2Rpdj5cbiAgICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNiLW1ldGEtaXRlbSBzYi1tZXRhLXBlcmZvcm1lcnNcIj48c3Ryb25nPlBlcmZvcm1lcnM6PC9zdHJvbmc+ICR7cGVyZm9ybWVyc308L2Rpdj5cbiAgICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNiLW1ldGEtaXRlbSBzYi1tZXRhLXBsYXlzXCI+PHN0cm9uZz5QbGF5IENvdW50Ojwvc3Ryb25nPiAke3NjZW5lLnBsYXlfY291bnQgfHwgMH08L2Rpdj5cbiAgICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNiLW1ldGEtaXRlbSBzYi1tZXRhLWJhdHRsZXNcIj48c3Ryb25nPkJhdHRsZXM6PC9zdHJvbmc+ICR7YmF0dGxlcyhzY2VuZSl9PC9kaXY+XG4gICAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1tZXRhLWl0ZW0gc2ItbWV0YS1yYXRpbmdcIj48c3Ryb25nPlN0YXNoIFJhdGluZzo8L3N0cm9uZz4gJHtzdGFzaFJhdGluZ308L2Rpdj5cbiAgICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNiLW1ldGEtaXRlbSBzYi10YWdzLXJvd1wiPjxzdHJvbmc+VGFnczo8L3N0cm9uZz4gJHt0YWdzLmxlbmd0aCA+IDAgPyB0YWdzLm1hcCgodGFnKSA9PiBgPHNwYW4gY2xhc3M9XCJzYi10YWdcIj4ke3RhZ308L3NwYW4+YCkuam9pbihcIlwiKSA6ICc8c3BhbiBjbGFzcz1cInNiLW5vbmVcIj5Ob25lPC9zcGFuPid9PC9kaXY+XG4gICAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgICA8L2Rpdj5cblxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1jaG9vc2UtYnRuXCI+XG4gICAgICAgICAgICDinJMgQ2hvb3NlPHNwYW4gY2xhc3M9XCJzYi1jaG9vc2UtbG9uZ1wiPiBUaGlzIFNjZW5lPC9zcGFuPlxuICAgICAgICAgIDwvZGl2PlxuICAgICAgICA8L2Rpdj5cbiAgICAgIDwvZGl2PlxuICAgIGA7XG59XG4iLCAiLy8gVmljdG9yeSBhbmQgcGxhY2VtZW50IGVuZC1zY3JlZW5zIGZvciBDaGFtcGlvbiBhbmQgUGxhY2VtZW50IHJ1bnMuXG5cbmltcG9ydCB7IGxhdGVzdFNjZW5lIH0gZnJvbSBcIi4uL2NhY2hlXCI7XG5pbXBvcnQgeyBlbG8sIHN0YXNoUmF0aW5nVGFyZ2V0cyB9IGZyb20gXCIuLi9zY29yZVwiO1xuaW1wb3J0IHsgcmVzZXRSdW5TdGF0ZSwgc3RhdGUgfSBmcm9tIFwiLi4vc3RhdGVcIjtcbmltcG9ydCB7IHNhdmVTdGF0ZSB9IGZyb20gXCIuLi9zdG9yYWdlXCI7XG5pbXBvcnQgdHlwZSB7IFBsYWNlbWVudFBhaXJSZXN1bHQsIFNjZW5lIH0gZnJvbSBcIi4uL3R5cGVzXCI7XG5pbXBvcnQgeyBsb2FkTmV3UGFpciwgc2V0QWN0aW9uc1Zpc2libGUgfSBmcm9tIFwiLi9tYWluVUlcIjtcbmltcG9ydCB7IHJlc29sdmVTY2VuZVRpdGxlIH0gZnJvbSBcIi4vc2NlbmVUaXRsZVwiO1xuXG5mdW5jdGlvbiBidWlsZEVuZFNjcmVlbkh0bWwoXG4gIHNjZW5lOiBTY2VuZSxcbiAgY3Jvd246IHN0cmluZyxcbiAgaGVhZGxpbmU6IHN0cmluZyxcbiAgc3RhdHNIdG1sOiBzdHJpbmcsXG4gIGJ1dHRvbkxhYmVsOiBzdHJpbmcsXG4pOiBzdHJpbmcge1xuICBjb25zdCB0aXRsZSA9IHJlc29sdmVTY2VuZVRpdGxlKHNjZW5lKTtcbiAgY29uc3Qgc2NyZWVuc2hvdFBhdGggPSBzY2VuZS5wYXRocz8uc2NyZWVuc2hvdCA/PyBudWxsO1xuXG4gIHJldHVybiBgXG4gICAgICA8ZGl2IGNsYXNzPVwic2ItZW5kLXNjcmVlblwiPlxuICAgICAgICA8ZGl2IGNsYXNzPVwic2ItZW5kLXNjcmVlbi1pY29uXCI+JHtjcm93bn08L2Rpdj5cbiAgICAgICAgPGgyIGNsYXNzPVwic2ItZW5kLXNjcmVlbi1oZWFkbGluZVwiPiR7aGVhZGxpbmV9PC9oMj5cbiAgICAgICAgPGRpdiBjbGFzcz1cInNiLWVuZC1zY3JlZW4tc2NlbmUgcHdyLXNjZW5lLWltYWdlLWNvbnRhaW5lclwiPlxuICAgICAgICAgICR7XG4gICAgICAgICAgICBzY3JlZW5zaG90UGF0aFxuICAgICAgICAgICAgICA/IGA8aW1nIGNsYXNzPVwic2ItZW5kLXNjcmVlbi1pbWFnZSBwd3Itc2NlbmUtaW1hZ2VcIiBzcmM9XCIke3NjcmVlbnNob3RQYXRofVwiIGFsdD1cIiR7dGl0bGV9XCIgLz5gXG4gICAgICAgICAgICAgIDogYDxkaXYgY2xhc3M9XCJzYi1lbmQtc2NyZWVuLWltYWdlIHNiLW5vLWltYWdlXCI+Tm8gU2NyZWVuc2hvdDwvZGl2PmBcbiAgICAgICAgICB9XG4gICAgICAgIDwvZGl2PlxuICAgICAgICA8aDMgY2xhc3M9XCJzYi1lbmQtc2NyZWVuLW5hbWVcIj4ke3RpdGxlfTwvaDM+XG4gICAgICAgIDxwIGNsYXNzPVwic2ItZW5kLXNjcmVlbi1zdGF0c1wiPiR7c3RhdHNIdG1sfTwvcD5cbiAgICAgICAgPGJ1dHRvbiBpZD1cInNiLW5ldy1ydW5cIiBjbGFzcz1cImJ0biBidG4tcHJpbWFyeVwiPiR7YnV0dG9uTGFiZWx9PC9idXR0b24+XG4gICAgICA8L2Rpdj5cbiAgICBgO1xufVxuXG4vKiogUmVuZGVyIGFuIGVuZCBzY3JlZW4sIGhpZGUgYmF0dGxlIGNvbnRyb2xzLCBhbmQgd2lyZSB0aGUgbmV3LXJ1biBidXR0b24uICovXG5mdW5jdGlvbiBzaG93RW5kU2NyZWVuKGh0bWw6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBjb21wYXJpc29uQXJlYSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic2ItY29tcGFyaXNvbi1hcmVhXCIpO1xuICBpZiAoIWNvbXBhcmlzb25BcmVhKSByZXR1cm47XG5cbiAgY29tcGFyaXNvbkFyZWEuaW5uZXJIVE1MID0gaHRtbDtcbiAgc2V0QWN0aW9uc1Zpc2libGUoZmFsc2UpO1xuXG4gIGNvbXBhcmlzb25BcmVhLnF1ZXJ5U2VsZWN0b3IoXCIjc2ItbmV3LXJ1blwiKT8uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHtcbiAgICBsb2FkTmV3UGFpcigpO1xuICB9KTtcbn1cblxuLyoqIENhcHR1cmUgZGlzcGxheSB2YWx1ZXMsIGNsZWFyIHJ1biBzdGF0ZSwgdGhlbiBzaG93IHRoZSBlbmQgc2NyZWVuLiAqL1xuZnVuY3Rpb24gZmluaXNoUnVuU2hvd0VuZFNjcmVlbihodG1sOiBzdHJpbmcpOiB2b2lkIHtcbiAgcmVzZXRSdW5TdGF0ZSgpO1xuICAvLyBUaGUgbGFzdCBwYWlyIGJlbG9uZ3MgdG8gdGhlIGZpbmlzaGVkIHJ1bjogYSByZWxvYWQgbXVzdG4ndCByZXN0b3JlIGl0IHdpdGhvdXQgaXRzIHJ1blxuICBzdGF0ZS5jdXJyZW50UGFpciA9IHsgbGVmdDogbnVsbCwgcmlnaHQ6IG51bGwgfTtcbiAgc3RhdGUuY3VycmVudFJhbmtzID0geyBsZWZ0OiBudWxsLCByaWdodDogbnVsbCB9O1xuICBzYXZlU3RhdGUoKTtcbiAgc2hvd0VuZFNjcmVlbihodG1sKTtcbn1cblxuLyoqXG4gKiBcIkVMTzogMTc0MFwiLCBwbHVzIFwiwrcgU3Rhc2ggUmF0aW5nOiA3NFwiIHdoaWxlIGFuIHVwZGF0ZSBtb2RlIGlzIG9uLiBUaGUgcmF0aW5nIGlzIHdvcmtlZCBvdXRcbiAqIHRoZSB3YXkgdGhlIHN5bmMgZG9lcyBpdCAoaXQgbWF5IHN0aWxsIGJlIG9uIGl0cyB3YXkgdG8gU3Rhc2gpLCBzbyBpdCdzIHdoYXQgU3Rhc2ggd2lsbCBzaG93LlxuICovXG5mdW5jdGlvbiBlbG9MaW5lKHNjZW5lOiBTY2VuZSwgdmFsdWU6IG51bWJlciB8IG51bGwpOiBzdHJpbmcge1xuICBpZiAodmFsdWUgPT09IG51bGwpIHJldHVybiBcIlwiO1xuICBsZXQgbGluZSA9IGA8YnI+RUxPOiA8c3Ryb25nPiR7TWF0aC5yb3VuZCh2YWx1ZSl9PC9zdHJvbmc+YDtcbiAgY29uc3QgbW9kZSA9IHN0YXRlLnNldHRpbmdzLnN0YXNoUmF0aW5ncztcbiAgY29uc3Qgc2NlbmVzID0gc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzO1xuICBpZiAobW9kZSAhPT0gXCJvZmZcIiAmJiBzY2VuZXMpIHtcbiAgICBjb25zdCByYXRpbmcgPSBzdGFzaFJhdGluZ1RhcmdldHMoc2NlbmVzLCBtb2RlKS5nZXQoc2NlbmUuaWQpO1xuICAgIGlmIChyYXRpbmcgIT09IHVuZGVmaW5lZCkgbGluZSArPSBgIMK3IFN0YXNoIFJhdGluZzogPHN0cm9uZz4ke3JhdGluZ308L3N0cm9uZz5gO1xuICB9XG4gIHJldHVybiBsaW5lO1xufVxuXG4vKiogQ2hhbXBpb24gYmVhdCBldmVyeSBzY2VuZSBhYm92ZSBpdCwgb3IgYSBjbGltYiBmcm9tIHRoZSBib3R0b20gbmV2ZXIgbG9zdDogaXQncyAjMS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzaG93VmljdG9yeVNjcmVlbihjaGFtcGlvbjogU2NlbmUsIHdpblN0cmVhazogbnVtYmVyKTogdm9pZCB7XG4gIGNvbnN0IGh0bWwgPSBidWlsZEVuZFNjcmVlbkh0bWwoXG4gICAgY2hhbXBpb24sXG4gICAgXCLwn5GRXCIsXG4gICAgXCJDSEFNUElPTiFcIixcbiAgICBgUmVhY2hlZCB0aGUgdG9wOiAke3dpblN0cmVha30gd2luJHt3aW5TdHJlYWsgPT09IDEgPyBcIlwiIDogXCJzXCJ9IGluIGEgcm93ISR7ZWxvTGluZShjaGFtcGlvbiwgZWxvKGxhdGVzdFNjZW5lKGNoYW1waW9uKSkpfWAsXG4gICAgXCJTdGFydCBOZXcgUnVuXCIsXG4gICk7XG5cbiAgZmluaXNoUnVuU2hvd0VuZFNjcmVlbihodG1sKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHNob3dQbGFjZW1lbnRTY3JlZW4ocmVzdWx0OiBFeHRyYWN0PFBsYWNlbWVudFBhaXJSZXN1bHQsIHsgZG9uZTogdHJ1ZSB9Pik6IHZvaWQge1xuICBjb25zdCB7IHNjZW5lLCByYW5rLCBiYXR0bGVzLCBzdHJlYWssIGZyb21Cb3R0b20gfSA9IHJlc3VsdDtcbiAgY29uc3Qgc3RyZWFrVGV4dCA9IGZyb21Cb3R0b20gJiYgc3RyZWFrID4gMCA/IGDwn5SlICR7c3RyZWFrfSB3aW4gc3RyZWFrIMK3IGAgOiBcIlwiO1xuICBjb25zdCBiYXR0bGVzVGV4dCA9IGJhdHRsZXMgPyBgIMK3ICR7YmF0dGxlc30gYmF0dGxlJHtiYXR0bGVzID09PSAxID8gXCJcIiA6IFwic1wifWAgOiBcIlwiO1xuICBjb25zdCBodG1sID0gYnVpbGRFbmRTY3JlZW5IdG1sKFxuICAgIHNjZW5lLFxuICAgIFwi8J+TjVwiLFxuICAgIFwiUExBQ0VEIVwiLFxuICAgIGAke3N0cmVha1RleHR9UmFuayA8c3Ryb25nPiMke3Jhbmt9PC9zdHJvbmc+IG9mICR7c3RhdGUudG90YWxTY2VuZXNDb3VudH0ke2JhdHRsZXNUZXh0fSR7ZWxvTGluZShzY2VuZSwgcmVzdWx0LmVsbyl9YCxcbiAgICBcIlN0YXJ0IE5ldyBSdW5cIixcbiAgKTtcblxuICBmaW5pc2hSdW5TaG93RW5kU2NyZWVuKGh0bWwpO1xufVxuIiwgIi8vIFdoYXQgZWFjaCBcIlN0YXNoIHJhdGluZ3NcIiBvcHRpb24gZG9lcywgc2hhcmVkIGJ5IHRoZSBzZXR1cCBzY3JlZW4gYW5kIHRoZSBTZXR0aW5ncyBkcm9wZG93bi5cblxuaW1wb3J0IHR5cGUgeyBTdGFzaFJhdGluZ3NNb2RlIH0gZnJvbSBcIi4uL3R5cGVzXCI7XG5cbmV4cG9ydCBjb25zdCBTVEFTSF9SQVRJTkdTX09QVElPTlM6IHJlYWRvbmx5IHsgdmFsdWU6IFN0YXNoUmF0aW5nc01vZGU7IGxhYmVsOiBzdHJpbmc7IGRlc2M6IHN0cmluZyB9W10gPSBbXG4gIHsgdmFsdWU6IFwib2ZmXCIsIGxhYmVsOiBcIkRvbid0IHVwZGF0ZVwiLCBkZXNjOiBcIkVMTyBpcyBzYXZlZDsgeW91ciBTdGFzaCByYXRpbmdzIHN0YXkgYXMgdGhleSBhcmUuXCIgfSxcbiAge1xuICAgIHZhbHVlOiBcImxpbmVhclwiLFxuICAgIGxhYmVsOiBcIlN0cmFpZ2h0LWxpbmVcIixcbiAgICBkZXNjOiBcIlJhdGluZyA9IEVMTyBjb252ZXJ0ZWQgYmFjayAoMTUwMCA9IDUwLCAxMCBFTE8gcGVyIHBvaW50KS4gVmVyeSBoaWdoIG9yIGxvdyBzY2VuZXMgc3RvcCBhdCAxMDAgb3IgMS5cIixcbiAgfSxcbiAge1xuICAgIHZhbHVlOiBcInBlcmNlbnRpbGVcIixcbiAgICBsYWJlbDogXCJQZXJjZW50aWxlXCIsXG4gICAgZGVzYzogXCJSYXRpbmcgPSBwZXJjZW50aWxlIGluIHlvdXIgbGlicmFyeTogOTAgbWVhbnMgdGhlIHNjZW5lIHJhbmtzIGFib3ZlIGFib3V0IDkwJSBvZiB5b3VyIHNjZW5lcy4gVG9wIHNjZW5lIDEwMCwgYm90dG9tIDEuXCIsXG4gIH0sXG5dO1xuXG5leHBvcnQgZnVuY3Rpb24gc3Rhc2hSYXRpbmdzT3B0aW9uKHZhbHVlOiBTdGFzaFJhdGluZ3NNb2RlKTogKHR5cGVvZiBTVEFTSF9SQVRJTkdTX09QVElPTlMpW251bWJlcl0ge1xuICByZXR1cm4gU1RBU0hfUkFUSU5HU19PUFRJT05TLmZpbmQoKG9wdGlvbikgPT4gb3B0aW9uLnZhbHVlID09PSB2YWx1ZSkgPz8gU1RBU0hfUkFUSU5HU19PUFRJT05TWzBdO1xufVxuIiwgIi8vIEJhdHRsZSAvIFNldHRpbmdzIHRhYnMgKFN0YXNoJ3Mgb3duIG5hdi10YWJzICsgLnNldHRpbmcgcm93cywgbGlrZSBTdGFzaC1UQ29kZSksIHBsdXMgdGhlXG4vLyBwcmV2aWV3IHZvbHVtZSBjb250cm9sIHRoYXQgc2l0cyBvbiB0aGUgdGFiIGJhci4gRXZlcnkgY29udHJvbCBjYXJyaWVzIGRhdGEtc2V0dGluZz1cIjxrZXk+XCI7XG4vLyB2YWx1ZXMgcGVyc2lzdCB2aWEgdXBkYXRlU2V0dGluZ3MoKS4gQWN0aW9uIHJvd3MgKFJlc2V0IEVMTykgY2FycnkgZGF0YS1hY3Rpb24gaW5zdGVhZC5cblxuaW1wb3J0IHsgdXBkYXRlU2V0dGluZ3MgfSBmcm9tIFwiLi4vc2V0dGluZ3NcIjtcbmltcG9ydCB7IHN0YXRlIH0gZnJvbSBcIi4uL3N0YXRlXCI7XG5pbXBvcnQgdHlwZSB7IFNldHRpbmdzLCBTdGFzaFJhdGluZ3NNb2RlIH0gZnJvbSBcIi4uL3R5cGVzXCI7XG5pbXBvcnQgeyBTVEFTSF9SQVRJTkdTX09QVElPTlMsIHN0YXNoUmF0aW5nc09wdGlvbiB9IGZyb20gXCIuL3N0YXNoUmF0aW5nc1RleHRcIjtcblxudHlwZSBCb29sS2V5ID0geyBbSyBpbiBrZXlvZiBTZXR0aW5nc106IFNldHRpbmdzW0tdIGV4dGVuZHMgYm9vbGVhbiA/IEsgOiBuZXZlciB9W2tleW9mIFNldHRpbmdzXTtcbmV4cG9ydCB0eXBlIFRhYklkID0gXCJiYXR0bGVcIiB8IFwic2V0dGluZ3NcIjtcblxudHlwZSBTZXR0aW5nUm93ID1cbiAgfCB7IGtleToga2V5b2YgU2V0dGluZ3M7IHRpdGxlOiBzdHJpbmc7IGhpbnQ6IHN0cmluZyB9XG4gIHwgeyBhY3Rpb246IFwicmVzZXQtZWxvXCI7IHRpdGxlOiBzdHJpbmc7IGhpbnQ6IHN0cmluZzsgYnV0dG9uOiBzdHJpbmcgfTtcblxuY29uc3QgU0VDVElPTlM6IHsgdGl0bGU6IHN0cmluZzsgcm93czogU2V0dGluZ1Jvd1tdIH1bXSA9IFtcbiAge1xuICAgIHRpdGxlOiBcIkVMT1wiLFxuICAgIHJvd3M6IFtcbiAgICAgIC8vIFRoZSBoaW50IGlzIHRoZSBzZWxlY3RlZCBvcHRpb24ncyBkZXNjcmlwdGlvbiAoa2VwdCBjdXJyZW50IGJ5IHN5bmNTZXR0aW5nc0NvbnRyb2xzKVxuICAgICAgeyBrZXk6IFwic3Rhc2hSYXRpbmdzXCIsIHRpdGxlOiBcIlN0YXNoIHJhdGluZ3MgdXBkYXRlIG1vZGVcIiwgaGludDogXCJcIiB9LFxuICAgICAge1xuICAgICAgICBhY3Rpb246IFwicmVzZXQtZWxvXCIsXG4gICAgICAgIHRpdGxlOiBcIlJlc2V0IEVMT1wiLFxuICAgICAgICBoaW50OiBcIlN0YXJ0IGV2ZXJ5IHNjZW5lJ3MgRUxPIG92ZXIsIGZyb20gaXRzIFN0YXNoIHJhdGluZyBvciBhdCAxNTAwXCIsXG4gICAgICAgIGJ1dHRvbjogXCJSZXNldCBFTE/igKZcIixcbiAgICAgIH0sXG4gICAgXSxcbiAgfSxcbiAge1xuICAgIHRpdGxlOiBcIkJhdHRsZXNcIixcbiAgICByb3dzOiBbXG4gICAgICB7IGtleTogXCJmaWx0ZXJPcHBvbmVudHNcIiwgdGl0bGU6IFwiVXNlIGZpbHRlcmVkIHNjZW5lcyBmb3IgYm90aCBzaWRlc1wiLCBoaW50OiBcIk9wcG9uZW50cyBhbHNvIGNvbWUgZnJvbSB0aGUgY3VycmVudCBzY2VuZSBsaXN0IGZpbHRlciBpbnN0ZWFkIG9mIHlvdXIgd2hvbGUgcmF0ZWQgbGlicmFyeVwiIH0sXG4gICAgICB7IGtleTogXCJwbGFjZW1lbnRGcm9tQm90dG9tXCIsIHRpdGxlOiBcIlBsYWNlbWVudDogc3RhcnQgZnJvbSB0aGUgYm90dG9tXCIsIGhpbnQ6IFwiUGxhY2VtZW50IGlnbm9yZXMgdGhlIHNjZW5lJ3MgY3VycmVudCBFTE86IGl0IHN0YXJ0cyBhZ2FpbnN0IHRoZSBib3R0b20gc2NlbmUgYW5kIGNsaW1icywganVtcGluZyBmdXJ0aGVyIHdpdGggZWFjaCB3aW4gKHRoaXMgcmVwbGFjZXMgR2F1bnRsZXQpXCIgfSxcbiAgICBdLFxuICB9LFxuICB7XG4gICAgdGl0bGU6IFwiU2NlbmVzXCIsXG4gICAgcm93czogW1xuICAgICAgeyBrZXk6IFwiYXV0b3BsYXlQcmV2aWV3c1wiLCB0aXRsZTogXCJBdXRvcGxheSBwcmV2aWV3c1wiLCBoaW50OiBcIkxvb3AgYm90aCBwcmV2aWV3cyBzaWxlbnRseTsgaG92ZXIgYSBjYXJkIHRvIGhlYXIgaXRcIiB9LFxuICAgICAgeyBrZXk6IFwicGF1c2VNZWRpYU9uT3BlblwiLCB0aXRsZTogXCJQYXVzZSBwbGF5aW5nIHZpZGVvIHdoZW4gU3Rhc2ggQmF0dGxlIG9wZW5zXCIsIGhpbnQ6IFwiU3RvcHMgdGhlIHNjZW5lIHlvdSdyZSB3YXRjaGluZyBzbyBpdHMgYXVkaW8gZG9lc24ndCBvdmVybGFwIHRoZSBiYXR0bGUgcHJldmlld3NcIiB9LFxuICAgICAgeyBrZXk6IFwic2hvd1RpZXJzXCIsIHRpdGxlOiBcIlNob3cgdGllcnMgb24gY2FyZHNcIiwgaGludDogXCJBIHRpZXIgbmV4dCB0byBlYWNoIHNjZW5lJ3MgRUxPLCBmcm9tIPCfkZEgTGVnZW5kYXJ5ICh0b3AgMSUpIGRvd24gdG8g8J+liSBCcm9uemUsIGJ5IGl0cyByYW5rIGFtb25nIHlvdXIgc2NlbmVzIHdpdGggYSBzZXR0bGVkIEVMT1wiIH0sXG4gICAgICB7IGtleTogXCJvcGVuSW5OZXdUYWJcIiwgdGl0bGU6IFwiT3BlbiBzY2VuZXMgaW4gYSBuZXcgdGFiXCIsIGhpbnQ6IFwiQ2xpY2tpbmcgYSB0aHVtYm5haWwgb3BlbnMgdGhlIHNjZW5lIGluIGEgbmV3IGJyb3dzZXIgdGFiXCIgfSxcbiAgICAgIHsga2V5OiBcImNsZWFuTW9kZVwiLCB0aXRsZTogXCJDbGVhbiBtb2RlXCIsIGhpbnQ6IFwiU2hvdyBhIPCfl5EgYnV0dG9uIG9uIGVhY2ggY2FyZCB0byBkZWxldGUgdGhlIHNjZW5lIGZyb20gU3Rhc2hcIiB9LFxuICAgIF0sXG4gIH0sXG5dO1xuXG4vKiogVm9sdW1lIHJlc3RvcmVkIHdoZW4gdW5tdXRpbmcgZnJvbSAwIHdpdGggbm8gZWFybGllciBsZXZlbCB0aGlzIHNlc3Npb24uICovXG5jb25zdCBERUZBVUxUX1VOTVVURV9WT0xVTUUgPSA1MDtcbmxldCB2b2x1bWVCZWZvcmVNdXRlOiBudW1iZXIgfCBudWxsID0gbnVsbDtcblxubGV0IGFjdGl2ZVRhYjogVGFiSWQgPSBcImJhdHRsZVwiO1xuXG5leHBvcnQgZnVuY3Rpb24gZ2V0QWN0aXZlVGFiKCk6IFRhYklkIHtcbiAgcmV0dXJuIGFjdGl2ZVRhYjtcbn1cblxuZnVuY3Rpb24gdm9sdW1lSWNvbih2b2x1bWU6IG51bWJlcik6IHN0cmluZyB7XG4gIGlmICh2b2x1bWUgPT09IDApIHJldHVybiBcIvCflIdcIjtcbiAgcmV0dXJuIHZvbHVtZSA8IDUwID8gXCLwn5SJXCIgOiBcIvCflIpcIjtcbn1cblxuZnVuY3Rpb24gc2V0dGluZ0NvbnRyb2woa2V5OiBrZXlvZiBTZXR0aW5ncyk6IHN0cmluZyB7XG4gIGlmIChrZXkgPT09IFwic3Rhc2hSYXRpbmdzXCIpIHtcbiAgICBjb25zdCBvcHRpb25zID0gU1RBU0hfUkFUSU5HU19PUFRJT05TLm1hcChcbiAgICAgICh7IHZhbHVlLCBsYWJlbCB9KSA9PlxuICAgICAgICBgPG9wdGlvbiB2YWx1ZT1cIiR7dmFsdWV9XCIgJHt2YWx1ZSA9PT0gc3RhdGUuc2V0dGluZ3Muc3Rhc2hSYXRpbmdzID8gXCJzZWxlY3RlZFwiIDogXCJcIn0+JHtsYWJlbH08L29wdGlvbj5gLFxuICAgICkuam9pbihcIlwiKTtcbiAgICByZXR1cm4gYDxzZWxlY3QgZGF0YS1zZXR0aW5nPVwiJHtrZXl9XCIgY2xhc3M9XCJmb3JtLWNvbnRyb2wgZm9ybS1jb250cm9sLXNtIHNiLXNldHRpbmctc2VsZWN0XCIgYXJpYS1sYWJlbD1cIlN0YXNoIHJhdGluZ3MgdXBkYXRlIG1vZGVcIj4ke29wdGlvbnN9PC9zZWxlY3Q+YDtcbiAgfVxuICBjb25zdCBpZCA9IGBzYi1zZXR0aW5nLSR7a2V5fWA7XG4gIHJldHVybiBgXG4gICAgICAgICAgPGRpdiBjbGFzcz1cImN1c3RvbS1jb250cm9sIGN1c3RvbS1zd2l0Y2hcIj5cbiAgICAgICAgICAgIDxpbnB1dCB0eXBlPVwiY2hlY2tib3hcIiBjbGFzcz1cImN1c3RvbS1jb250cm9sLWlucHV0XCIgaWQ9XCIke2lkfVwiIGRhdGEtc2V0dGluZz1cIiR7a2V5fVwiICR7c3RhdGUuc2V0dGluZ3Nba2V5IGFzIEJvb2xLZXldID8gXCJjaGVja2VkXCIgOiBcIlwifT5cbiAgICAgICAgICAgIDxsYWJlbCBjbGFzcz1cImN1c3RvbS1jb250cm9sLWxhYmVsXCIgZm9yPVwiJHtpZH1cIj48L2xhYmVsPlxuICAgICAgICAgIDwvZGl2PmA7XG59XG5cbi8qKiBUYWIgYmFyOiBCYXR0bGUgLyBTZXR0aW5ncyBvbiB0aGUgbGVmdCwgcHJldmlldyB2b2x1bWUgb24gdGhlIHJpZ2h0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVRhYkJhcigpOiBzdHJpbmcge1xuICBjb25zdCB7IHByZXZpZXdWb2x1bWUgfSA9IHN0YXRlLnNldHRpbmdzO1xuICByZXR1cm4gYFxuICAgICAgPGRpdiBjbGFzcz1cInNiLXRhYi1iYXJcIj5cbiAgICAgICAgPG5hdiBjbGFzcz1cIm5hdiBuYXYtdGFicyBzYi10YWJzXCIgcm9sZT1cInRhYmxpc3RcIj5cbiAgICAgICAgICA8YSBjbGFzcz1cIm5hdi1pdGVtIG5hdi1saW5rIGFjdGl2ZVwiIHJvbGU9XCJ0YWJcIiBkYXRhLXRhYj1cImJhdHRsZVwiIGFyaWEtc2VsZWN0ZWQ9XCJ0cnVlXCI+4pqU77iPIEJhdHRsZTwvYT5cbiAgICAgICAgICA8YSBjbGFzcz1cIm5hdi1pdGVtIG5hdi1saW5rXCIgcm9sZT1cInRhYlwiIGRhdGEtdGFiPVwic2V0dGluZ3NcIiBhcmlhLXNlbGVjdGVkPVwiZmFsc2VcIj7impkgU2V0dGluZ3M8L2E+XG4gICAgICAgIDwvbmF2PlxuICAgICAgICA8ZGl2IGNsYXNzPVwic2Itdm9sdW1lXCIgdGl0bGU9XCJQcmV2aWV3IHZvbHVtZVwiPlxuICAgICAgICAgIDxidXR0b24gdHlwZT1cImJ1dHRvblwiIGNsYXNzPVwic2Itdm9sdW1lLWljb25cIiBhcmlhLWxhYmVsPVwiTXV0ZSBwcmV2aWV3c1wiPiR7dm9sdW1lSWNvbihwcmV2aWV3Vm9sdW1lKX08L2J1dHRvbj5cbiAgICAgICAgICA8aW5wdXQgdHlwZT1cInJhbmdlXCIgbWluPVwiMFwiIG1heD1cIjEwMFwiIHN0ZXA9XCIxXCIgZGF0YS1zZXR0aW5nPVwicHJldmlld1ZvbHVtZVwiIHZhbHVlPVwiJHtwcmV2aWV3Vm9sdW1lfVwiIGFyaWEtbGFiZWw9XCJQcmV2aWV3IHZvbHVtZVwiPlxuICAgICAgICAgIDxzcGFuIGNsYXNzPVwic2Itdm9sdW1lLXZhbHVlXCI+JHtwcmV2aWV3Vm9sdW1lfTwvc3Bhbj5cbiAgICAgICAgPC9kaXY+XG4gICAgICA8L2Rpdj5cbiAgICBgO1xufVxuXG5mdW5jdGlvbiBzZXR0aW5nUm93SHRtbChyb3c6IFNldHRpbmdSb3cpOiBzdHJpbmcge1xuICBjb25zdCBoaW50ID0gXCJrZXlcIiBpbiByb3cgJiYgcm93LmtleSA9PT0gXCJzdGFzaFJhdGluZ3NcIiA/IHN0YXNoUmF0aW5nc09wdGlvbihzdGF0ZS5zZXR0aW5ncy5zdGFzaFJhdGluZ3MpLmRlc2MgOiByb3cuaGludDtcbiAgY29uc3QgaGludEZvciA9IFwia2V5XCIgaW4gcm93ID8gYCBkYXRhLWhpbnQtZm9yPVwiJHtyb3cua2V5fVwiYCA6IFwiXCI7XG4gIGNvbnN0IGNvbnRyb2wgPVxuICAgIFwia2V5XCIgaW4gcm93XG4gICAgICA/IHNldHRpbmdDb250cm9sKHJvdy5rZXkpXG4gICAgICA6IGA8YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cImJ0biBidG4tc2Vjb25kYXJ5IGJ0bi1zbVwiIGRhdGEtYWN0aW9uPVwiJHtyb3cuYWN0aW9ufVwiPiR7cm93LmJ1dHRvbn08L2J1dHRvbj5gO1xuICByZXR1cm4gYFxuICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNldHRpbmdcIj5cbiAgICAgICAgICAgICAgPGRpdj5cbiAgICAgICAgICAgICAgICA8aDM+JHtyb3cudGl0bGV9PC9oMz5cbiAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzPVwic3ViLWhlYWRpbmdcIiR7aGludEZvcn0+JHtoaW50fTwvZGl2PlxuICAgICAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgICAgICAgPGRpdj4ke2NvbnRyb2x9PC9kaXY+XG4gICAgICAgICAgICA8L2Rpdj5gO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlU2V0dGluZ3NUYWIoKTogc3RyaW5nIHtcbiAgY29uc3Qgc2VjdGlvbnMgPSBTRUNUSU9OUy5tYXAoXG4gICAgKHsgdGl0bGUsIHJvd3MgfSkgPT4gYFxuICAgICAgICA8ZGl2IGNsYXNzPVwic2V0dGluZy1zZWN0aW9uXCI+XG4gICAgICAgICAgPGgxPiR7dGl0bGV9PC9oMT5cbiAgICAgICAgICA8ZGl2IGNsYXNzPVwiY2FyZFwiPlxuICAgICAgICAgICAgJHtyb3dzLm1hcChzZXR0aW5nUm93SHRtbCkuam9pbihcIlwiKX1cbiAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgPC9kaXY+YCxcbiAgKS5qb2luKFwiXCIpO1xuXG4gIHJldHVybiBgXG4gICAgICA8ZGl2IGNsYXNzPVwic2ItdGFiLXBhbmVsIHNiLXNldHRpbmdzLXRhYlwiIGRhdGEtcGFuZWw9XCJzZXR0aW5nc1wiIGhpZGRlbj5cbiAgICAgICAgJHtzZWN0aW9uc31cbiAgICAgICAgPHAgY2xhc3M9XCJzYi1zZXR0aW5ncy1ub3RlXCI+U2F2ZXMgdG8gU3Rhc2gsIGFsc28gdW5kZXIgU2V0dGluZ3Mg4oaSIFBsdWdpbnMuPC9wPlxuICAgICAgPC9kaXY+XG4gICAgYDtcbn1cblxuLyoqIFB1c2ggc3RhdGUuc2V0dGluZ3MgaW50byB0aGUgcmVuZGVyZWQgY29udHJvbHMgKGUuZy4gYWZ0ZXIgcmUtZmV0Y2hpbmcgc2V0dGluZ3Mgb24gcmVvcGVuKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzeW5jU2V0dGluZ3NDb250cm9scyhyb290OiBQYXJlbnROb2RlKTogdm9pZCB7XG4gIHJvb3QucXVlcnlTZWxlY3RvckFsbDxIVE1MSW5wdXRFbGVtZW50PihcImlucHV0W2RhdGEtc2V0dGluZ11cIikuZm9yRWFjaCgoaW5wdXQpID0+IHtcbiAgICBjb25zdCBrZXkgPSBpbnB1dC5kYXRhc2V0LnNldHRpbmcgYXMga2V5b2YgU2V0dGluZ3M7XG4gICAgY29uc3QgdmFsdWUgPSBzdGF0ZS5zZXR0aW5nc1trZXldO1xuICAgIGlmIChpbnB1dC50eXBlID09PSBcImNoZWNrYm94XCIpIGlucHV0LmNoZWNrZWQgPSBCb29sZWFuKHZhbHVlKTtcbiAgICBlbHNlIGlucHV0LnZhbHVlID0gU3RyaW5nKHZhbHVlKTtcbiAgfSk7XG4gIHJvb3QucXVlcnlTZWxlY3RvckFsbDxIVE1MU2VsZWN0RWxlbWVudD4oXCJzZWxlY3RbZGF0YS1zZXR0aW5nXVwiKS5mb3JFYWNoKChzZWxlY3QpID0+IHtcbiAgICBzZWxlY3QudmFsdWUgPSBTdHJpbmcoc3RhdGUuc2V0dGluZ3Nbc2VsZWN0LmRhdGFzZXQuc2V0dGluZyBhcyBrZXlvZiBTZXR0aW5nc10pO1xuICB9KTtcbiAgcm9vdC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PignW2RhdGEtaGludC1mb3I9XCJzdGFzaFJhdGluZ3NcIl0nKS5mb3JFYWNoKChoaW50KSA9PiB7XG4gICAgaGludC50ZXh0Q29udGVudCA9IHN0YXNoUmF0aW5nc09wdGlvbihzdGF0ZS5zZXR0aW5ncy5zdGFzaFJhdGluZ3MpLmRlc2M7XG4gIH0pO1xuICBjb25zdCB2b2x1bWUgPSBzdGF0ZS5zZXR0aW5ncy5wcmV2aWV3Vm9sdW1lO1xuICByb290LnF1ZXJ5U2VsZWN0b3JBbGwoXCIuc2Itdm9sdW1lLWljb25cIikuZm9yRWFjaCgoZWwpID0+IHtcbiAgICBlbC50ZXh0Q29udGVudCA9IHZvbHVtZUljb24odm9sdW1lKTtcbiAgICBlbC5zZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIsIHZvbHVtZSA9PT0gMCA/IFwiVW5tdXRlIHByZXZpZXdzXCIgOiBcIk11dGUgcHJldmlld3NcIik7XG4gIH0pO1xuICByb290LnF1ZXJ5U2VsZWN0b3JBbGwoXCIuc2Itdm9sdW1lLXZhbHVlXCIpLmZvckVhY2goKGVsKSA9PiAoZWwudGV4dENvbnRlbnQgPSBTdHJpbmcodm9sdW1lKSkpO1xufVxuXG4vKiogU2hvdyBhIHRhYi4gUGFuZWxzIGFyZSBzd2FwcGVkIGluIHBsYWNlLCBzbyBub3RoaW5nIGFib3ZlIHRoZSB0YWIgYmFyIG1vdmVzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNob3dUYWIocm9vdDogUGFyZW50Tm9kZSwgdGFiOiBUYWJJZCk6IHZvaWQge1xuICBhY3RpdmVUYWIgPSB0YWI7XG4gIHJvb3QucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oXCIuc2ItdGFicyAubmF2LWxpbmtcIikuZm9yRWFjaCgobGluaykgPT4ge1xuICAgIGNvbnN0IG9uID0gbGluay5kYXRhc2V0LnRhYiA9PT0gdGFiO1xuICAgIGxpbmsuY2xhc3NMaXN0LnRvZ2dsZShcImFjdGl2ZVwiLCBvbik7XG4gICAgbGluay5zZXRBdHRyaWJ1dGUoXCJhcmlhLXNlbGVjdGVkXCIsIFN0cmluZyhvbikpO1xuICB9KTtcbiAgcm9vdC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PihcIi5zYi10YWItcGFuZWxcIikuZm9yRWFjaCgocGFuZWwpID0+IHtcbiAgICBwYW5lbC5oaWRkZW4gPSBwYW5lbC5kYXRhc2V0LnBhbmVsICE9PSB0YWI7XG4gIH0pO1xufVxuXG4vKipcbiAqIFdpcmUgZXZlcnkgZGF0YS1zZXR0aW5nIGNvbnRyb2wsIHRoZSB0YWJzIGFuZCB0aGUgbXV0ZSBidXR0b24uXG4gKiBvbkNoYW5nZSBydW5zIGFmdGVyIGEgdmFsdWUgaXMgc3RvcmVkOyBvblRhYkNoYW5nZSBhZnRlciBhIHRhYiBzd2l0Y2guIEEgZHJvcGRvd24gY2hhbmdlXG4gKiBmaXJzdCBhd2FpdHMgYmVmb3JlQ2hhbmdlIChhIHdhcm5pbmcsIHNheSk6IGZhbHNlIHB1dHMgdGhlIGRyb3Bkb3duIGJhY2sgYW5kIHN0b3JlcyBub3RoaW5nLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYmluZFNldHRpbmdzQ29udHJvbHMoXG4gIHJvb3Q6IFBhcmVudE5vZGUsXG4gIG9uQ2hhbmdlOiAoa2V5OiBrZXlvZiBTZXR0aW5ncykgPT4gdm9pZCxcbiAgb25UYWJDaGFuZ2U6ICh0YWI6IFRhYklkKSA9PiB2b2lkLFxuICBiZWZvcmVDaGFuZ2U6IChrZXk6IGtleW9mIFNldHRpbmdzLCB2YWx1ZTogc3RyaW5nKSA9PiBQcm9taXNlPGJvb2xlYW4+ID0gYXN5bmMgKCkgPT4gdHJ1ZSxcbik6IHZvaWQge1xuICBjb25zdCBhcHBseSA9IChwYXRjaDogUGFydGlhbDxTZXR0aW5ncz4sIGtleToga2V5b2YgU2V0dGluZ3MpOiB2b2lkID0+IHtcbiAgICB1cGRhdGVTZXR0aW5ncyhwYXRjaCk7XG4gICAgc3luY1NldHRpbmdzQ29udHJvbHMocm9vdCk7XG4gICAgb25DaGFuZ2Uoa2V5KTtcbiAgfTtcblxuICByb290LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTElucHV0RWxlbWVudD4oXCJpbnB1dFtkYXRhLXNldHRpbmddXCIpLmZvckVhY2goKGlucHV0KSA9PiB7XG4gICAgY29uc3Qga2V5ID0gaW5wdXQuZGF0YXNldC5zZXR0aW5nIGFzIGtleW9mIFNldHRpbmdzO1xuICAgIC8vIFJhbmdlIHVwZGF0ZXMgbGl2ZSB3aGlsZSBkcmFnZ2luZzsgb3RoZXJzIG9uIGNvbW1pdFxuICAgIGNvbnN0IGV2ZW50TmFtZSA9IGlucHV0LnR5cGUgPT09IFwicmFuZ2VcIiA/IFwiaW5wdXRcIiA6IFwiY2hhbmdlXCI7XG4gICAgaW5wdXQuYWRkRXZlbnRMaXN0ZW5lcihldmVudE5hbWUsICgpID0+IHtcbiAgICAgIGNvbnN0IHZhbHVlID0gaW5wdXQudHlwZSA9PT0gXCJjaGVja2JveFwiID8gaW5wdXQuY2hlY2tlZCA6IE51bWJlcihpbnB1dC52YWx1ZSk7XG4gICAgICBhcHBseSh7IFtrZXldOiB2YWx1ZSB9IGFzIFBhcnRpYWw8U2V0dGluZ3M+LCBrZXkpO1xuICAgIH0pO1xuICB9KTtcblxuICByb290LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTFNlbGVjdEVsZW1lbnQ+KFwic2VsZWN0W2RhdGEtc2V0dGluZ11cIikuZm9yRWFjaCgoc2VsZWN0KSA9PiB7XG4gICAgY29uc3Qga2V5ID0gc2VsZWN0LmRhdGFzZXQuc2V0dGluZyBhcyBrZXlvZiBTZXR0aW5ncztcbiAgICBzZWxlY3QuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCB2YWx1ZSA9IHNlbGVjdC52YWx1ZTtcbiAgICAgIHNlbGVjdC5kaXNhYmxlZCA9IHRydWU7XG4gICAgICB0cnkge1xuICAgICAgICBpZiAoYXdhaXQgYmVmb3JlQ2hhbmdlKGtleSwgdmFsdWUpKSBhcHBseSh7IFtrZXldOiB2YWx1ZSBhcyBTdGFzaFJhdGluZ3NNb2RlIH0gYXMgUGFydGlhbDxTZXR0aW5ncz4sIGtleSk7XG4gICAgICAgIGVsc2Ugc3luY1NldHRpbmdzQ29udHJvbHMocm9vdCk7XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICBzZWxlY3QuZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfSk7XG5cbiAgLy8gU3BlYWtlciBpY29uOiBtdXRlLCBvciByZXN0b3JlIHRoZSBsZXZlbCBmcm9tIGJlZm9yZSBtdXRpbmdcbiAgcm9vdC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxCdXR0b25FbGVtZW50PihcIi5zYi12b2x1bWUtaWNvblwiKS5mb3JFYWNoKChidG4pID0+IHtcbiAgICBidG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHtcbiAgICAgIGNvbnN0IGN1cnJlbnQgPSBzdGF0ZS5zZXR0aW5ncy5wcmV2aWV3Vm9sdW1lO1xuICAgICAgaWYgKGN1cnJlbnQgPiAwKSB7XG4gICAgICAgIHZvbHVtZUJlZm9yZU11dGUgPSBjdXJyZW50O1xuICAgICAgICBhcHBseSh7IHByZXZpZXdWb2x1bWU6IDAgfSwgXCJwcmV2aWV3Vm9sdW1lXCIpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgYXBwbHkoeyBwcmV2aWV3Vm9sdW1lOiB2b2x1bWVCZWZvcmVNdXRlID8/IERFRkFVTFRfVU5NVVRFX1ZPTFVNRSB9LCBcInByZXZpZXdWb2x1bWVcIik7XG4gICAgICB9XG4gICAgfSk7XG4gIH0pO1xuXG4gIHJvb3QucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oXCIuc2ItdGFicyAubmF2LWxpbmtcIikuZm9yRWFjaCgobGluaykgPT4ge1xuICAgIGxpbmsuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHtcbiAgICAgIGNvbnN0IHRhYiA9IGxpbmsuZGF0YXNldC50YWIgYXMgVGFiSWQ7XG4gICAgICBpZiAodGFiID09PSBhY3RpdmVUYWIpIHJldHVybjtcbiAgICAgIHNob3dUYWIocm9vdCwgdGFiKTtcbiAgICAgIG9uVGFiQ2hhbmdlKHRhYik7XG4gICAgfSk7XG4gIH0pO1xufVxuIiwgIi8vIENvcmUgY29tcGFyaXNvbiBVSTogbGF5b3V0LCBwYWlyIHJlbmRlcmluZywgY2hvaWNlIGhhbmRsaW5nLCBhbmltYXRpb25zLlxuXG5pbXBvcnQgeyBjbGVhckZpbHRlcmVkQ2FjaGUsIGxhdGVzdFNjZW5lLCByZWZyZXNoU2NlbmVJbkNhY2hlLCByZW1vdmVTY2VuZUV2ZXJ5d2hlcmUgfSBmcm9tIFwiLi4vY2FjaGVcIjtcbmltcG9ydCB7IENIQU1QSU9OX1VOUkFURURfRUxPLCBDTElNQl9TTUFMTF9QT09MX1dBUk5fQVQsIFVQU0VUX01BWF9DSEFOQ0UgfSBmcm9tIFwiLi4vY29uc3RhbnRzXCI7XG5pbXBvcnQgeyBlbG9SZXN1bHQsIHdpbkNoYW5jZXMgfSBmcm9tIFwiLi4vZWxvXCI7XG5pbXBvcnQgeyByZWFkRmlsdGVycyB9IGZyb20gXCIuLi9maWx0ZXJzXCI7XG5pbXBvcnQgeyBmZXRjaFNjZW5lQnlJZCB9IGZyb20gXCIuLi9ncmFwaHFsXCI7XG5pbXBvcnQgeyBuYXZpZ2F0ZVRvVXJsIH0gZnJvbSBcIi4uL25hdmlnYXRpb25cIjtcbmltcG9ydCB7XG4gIGZldGNoQ2hhbXBpb25QYWlyLFxuICBmZXRjaFBsYWNlbWVudFBhaXIsXG4gIGZldGNoU3dpc3NQYWlyLFxuICBwYWlyUmFua3MsXG59IGZyb20gXCIuLi9wYWlyc1wiO1xuaW1wb3J0IHsgcmVjb3JkUGxhY2VtZW50UmVzdWx0IH0gZnJvbSBcIi4uL3BsYWNlbWVudFwiO1xuaW1wb3J0IHsgd3JpdGVFbG8gfSBmcm9tIFwiLi4vcmF0aW5nXCI7XG5pbXBvcnQgeyBmZXRjaFNjZW5lRmllbGRzIH0gZnJvbSBcIi4uL3NjZW5lQWN0aW9uc1wiO1xuaW1wb3J0IHsgYmF0dGxlcywgZWZmZWN0aXZlRWxvLCBrR2FtZXMgfSBmcm9tIFwiLi4vc2NvcmVcIjtcbmltcG9ydCB7IGlzRWxvU2V0dXBQZW5kaW5nLCBpc1J1bkFjdGl2ZSwgcmVzZXRSdW5TdGF0ZSwgcmVzZXRTaHVmZmxlLCBzdGF0ZSB9IGZyb20gXCIuLi9zdGF0ZVwiO1xuaW1wb3J0IHsgdGllck1hcCB9IGZyb20gXCIuLi9zdGF0c1wiO1xuaW1wb3J0IHsgc2F2ZVN0YXRlIH0gZnJvbSBcIi4uL3N0b3JhZ2VcIjtcbmltcG9ydCB0eXBlIHsgTW9kZSwgUmFuaywgU2NlbmUsIFRpZXIgfSBmcm9tIFwiLi4vdHlwZXNcIjtcbmltcG9ydCB7IGNvbmZpcm1EZWxldGVTY2VuZSB9IGZyb20gXCIuL2RlbGV0ZURpYWxvZ1wiO1xuaW1wb3J0IHsgY3JlYXRlU2NlbmVDYXJkIH0gZnJvbSBcIi4vc2NlbmVDYXJkXCI7XG5pbXBvcnQgeyBzaG93UGxhY2VtZW50U2NyZWVuLCBzaG93VmljdG9yeVNjcmVlbiB9IGZyb20gXCIuL3NjcmVlbnNcIjtcbmltcG9ydCB7IGNyZWF0ZVNldHRpbmdzVGFiLCBjcmVhdGVUYWJCYXIsIGdldEFjdGl2ZVRhYiB9IGZyb20gXCIuL3NldHRpbmdzUGFuZWxcIjtcblxuY29uc3QgTU9ERVM6IHsgbW9kZTogTW9kZTsgaWNvbjogc3RyaW5nOyB0aXRsZTogc3RyaW5nOyBkZXNjOiBzdHJpbmc7IHRpcDogc3RyaW5nIH1bXSA9IFtcbiAge1xuICAgIG1vZGU6IFwic3dpc3NcIixcbiAgICBpY29uOiBcIuKalu+4j1wiLFxuICAgIHRpdGxlOiBcIlN3aXNzXCIsXG4gICAgZGVzYzogXCJGYWlyIG1hdGNodXBzXCIsXG4gICAgdGlwOiBcIkVhY2ggc2NlbmUgZmFjZXMgYW4gb3Bwb25lbnQgd2l0aCBhIHNpbWlsYXIgRUxPLiBCb3RoIHNjZW5lcycgRUxPIGNoYW5nZXMgYWZ0ZXIgZXZlcnkgcGljaywgYW5kIGV2ZXJ5IHNjZW5lIHN0YXlzIGluIHRoZSByb3RhdGlvbi5cIixcbiAgfSxcbiAge1xuICAgIG1vZGU6IFwicGxhY2VtZW50XCIsXG4gICAgaWNvbjogXCLwn5ONXCIsXG4gICAgdGl0bGU6IFwiUGxhY2VtZW50XCIsXG4gICAgZGVzYzogXCJQbGFjZSBhIHNjZW5lXCIsXG4gICAgdGlwOiBcIkZpbmRzIHdoZXJlIG9uZSBzY2VuZSBiZWxvbmdzLiBFYWNoIHBpY2sgbmFycm93cyB0aGUgcmFuZ2Ugb2YgcmFua3MgaXQgY291bGQgbGFuZCBpbiAoc2hvd24gb24gaXRzIGNhcmQpIHVudGlsIGl0cyBzcG90IGlzIGZvdW5kLCBhYm91dCAxMCBwaWNrcyBmb3IgYW4gdW5yYXRlZCBzY2VuZS5cXG5cXG5Mb29raW5nIGZvciBHYXVudGxldD8gVHVybiBvbiDigJxQbGFjZW1lbnQ6IHN0YXJ0IGZyb20gdGhlIGJvdHRvbeKAnSBpbiBTZXR0aW5ncyB0byBtYWtlIGEgc2NlbmUgY2xpbWIgdGhlIGxhZGRlciBmcm9tIHRoZSBib3R0b20uXCIsXG4gIH0sXG4gIHtcbiAgICBtb2RlOiBcImNoYW1waW9uXCIsXG4gICAgaWNvbjogXCLwn4+GXCIsXG4gICAgdGl0bGU6IFwiQ2hhbXBpb25cIixcbiAgICBkZXNjOiBcIldpbm5lciBzdGF5cyBvblwiLFxuICAgIHRpcDogXCJXaW5uZXIgc3RheXMgb246IHRoZSBzY2VuZSB5b3UgcGljayBrZWVwcyBkZWZlbmRpbmcgYWdhaW5zdCBuZXcgY2hhbGxlbmdlcnMgdW50aWwgaXQncyBiZWF0ZW4sIHRoZW4gdGhlIHdpbm5lciB0YWtlcyBvdmVyLiBCb3RoIHNjZW5lcycgRUxPIGNoYW5nZXMgYWZ0ZXIgZXZlcnkgcGljay5cIixcbiAgfSxcbl07XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVNYWluVUkoKTogc3RyaW5nIHtcbiAgY29uc3QgbW9kZUJ1dHRvbnMgPSBNT0RFUy5tYXAoXG4gICAgKHsgbW9kZSwgaWNvbiwgdGl0bGUsIGRlc2MsIHRpcCB9KSA9PiBgXG4gICAgICAgICAgICA8YnV0dG9uIGNsYXNzPVwic2ItbW9kZS1idG4gJHtzdGF0ZS5jdXJyZW50TW9kZSA9PT0gbW9kZSA/IFwiYWN0aXZlXCIgOiBcIlwifVwiIGRhdGEtbW9kZT1cIiR7bW9kZX1cIiBkYXRhLXRpcD1cIiR7dGlwfVwiIGFyaWEtZGVzY3JpcHRpb249XCIke3RpcH1cIj5cbiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9XCJzYi1tb2RlLWljb25cIj4ke2ljb259PC9zcGFuPlxuICAgICAgICAgICAgICA8c3BhbiBjbGFzcz1cInNiLW1vZGUtdGl0bGVcIj4ke3RpdGxlfTwvc3Bhbj5cbiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9XCJzYi1tb2RlLWRlc2NcIj4ke2Rlc2N9PC9zcGFuPlxuICAgICAgICAgICAgPC9idXR0b24+YCxcbiAgKS5qb2luKFwiXCIpO1xuXG4gIHJldHVybiBgXG4gICAgICA8ZGl2IGlkPVwic3Rhc2gtYmF0dGxlLWNvbnRhaW5lclwiIGNsYXNzPVwic2ItY29udGFpbmVyXCI+XG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi1oZWFkZXJcIj5cbiAgICAgICAgICA8aDEgY2xhc3M9XCJzYi10aXRsZVwiPuKalO+4jyBTdGFzaCBCYXR0bGU8L2gxPlxuICAgICAgICAgICR7Y3JlYXRlVGFiQmFyKCl9XG4gICAgICAgIDwvZGl2PlxuXG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi10YWItcGFuZWxcIiBkYXRhLXBhbmVsPVwiYmF0dGxlXCI+XG4gICAgICAgICAgPGRpdiBpZD1cInNiLXNldHVwLWFyZWFcIiBjbGFzcz1cInNiLXNldHVwLWFyZWFcIiBoaWRkZW4+PC9kaXY+XG4gICAgICAgICAgPGRpdiBjbGFzcz1cInNiLW1vZGUtcm93XCI+XG4gICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItbW9kZS10b2dnbGVcIj4ke21vZGVCdXR0b25zfVxuICAgICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgICA8YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cInNiLW1vZGUtaW5mby1idG5cIiBhcmlhLWNvbnRyb2xzPVwic2ItbW9kZS1pbmZvXCIgYXJpYS1leHBhbmRlZD1cImZhbHNlXCIgYXJpYS1sYWJlbD1cIldoYXQgZG9lcyB0aGlzIG1vZGUgZG8/XCI+4pOYPC9idXR0b24+XG4gICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgPHAgaWQ9XCJzYi1tb2RlLWluZm9cIiBjbGFzcz1cInNiLW1vZGUtaW5mb1wiIGhpZGRlbj48L3A+XG5cbiAgICAgICAgICA8cCBpZD1cInNiLWNsaW1iLXBvb2wtd2FybmluZ1wiIGNsYXNzPVwic2ItY2xpbWItd2FybmluZ1wiIGhpZGRlbj5cbiAgICAgICAgICAgIENoYW1waW9uIGNhbiBiZWhhdmUgb2RkbHkgd2l0aCBzbWFsbCBmaWx0ZXJlZCBwb29scyB3aGVuIGJvdGggc2lkZXMgdXNlIHRoZSBmaWx0ZXJcbiAgICAgICAgICAgIChmZXdlciB0aGFuICR7Q0xJTUJfU01BTExfUE9PTF9XQVJOX0FUfSBzY2VuZXMpLiBVc2UgYSBsYXJnZXIgZmlsdGVyLCBvciB0dXJuIG9mZlxuICAgICAgICAgICAgXCJVc2UgZmlsdGVyZWQgc2NlbmVzIGZvciBib3RoIHNpZGVzXCIgaW4gU2V0dGluZ3MuXG4gICAgICAgICAgPC9wPlxuXG4gICAgICAgICAgPHAgaWQ9XCJzYi1wb29sLXN0YXR1c1wiIGNsYXNzPVwic2ItcG9vbC1zdGF0dXNcIiBoaWRkZW4+PC9wPlxuICAgICAgICAgIDxwIGlkPVwic2ItcmF0aW5ncy1ub3RlXCIgY2xhc3M9XCJzYi1wb29sLXN0YXR1cyBzYi1yYXRpbmdzLW5vdGVcIiBoaWRkZW4+XG4gICAgICAgICAgICBTdGFzaCByYXRpbmdzIGFyZW4ndCBiZWluZyBjaGFuZ2VkIMK3IDxhIGhyZWY9XCIjXCIgZGF0YS1hY3Rpb249XCJvcGVuLXNldHRpbmdzXCI+Y2hhbmdlIGluIFNldHRpbmdzPC9hPlxuICAgICAgICAgIDwvcD5cblxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1jb250ZW50XCI+XG4gICAgICAgICAgICA8ZGl2IGlkPVwic2ItY29tcGFyaXNvbi1hcmVhXCIgY2xhc3M9XCJzYi1jb21wYXJpc29uLWFyZWFcIj5cbiAgICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNiLWxvYWRpbmdcIj5Mb2FkaW5nIHNjZW5lcy4uLjwvZGl2PlxuICAgICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItYWN0aW9uc1wiPlxuICAgICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItYWN0aW9uLWJ1dHRvbnNcIj5cbiAgICAgICAgICAgICAgICA8YnV0dG9uIGlkPVwic2Itc2tpcC1idG5cIiBjbGFzcz1cImJ0biBidG4tc2Vjb25kYXJ5XCI+U2tpcDwvYnV0dG9uPlxuICAgICAgICAgICAgICAgIDxidXR0b24gaWQ9XCJzYi1yZWZyZXNoLWNhY2hlLWJ0blwiIGNsYXNzPVwiYnRuIGJ0bi1zZWNvbmRhcnlcIiB0aXRsZT1cIlJlZnJlc2ggc2NlbmUgbGlzdCBmcm9tIHNlcnZlciAodXNlIGlmIHlvdSd2ZSBhZGRlZCBuZXcgc2NlbmVzKVwiPvCflIQgUmVmcmVzaDwvYnV0dG9uPlxuICAgICAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNiLWtleWJvYXJkLWhpbnRcIj5cbiAgICAgICAgICAgICAgICA8c3Bhbj7ihpA8L3NwYW4+IGNob29zZSBsZWZ0IMK3XG4gICAgICAgICAgICAgICAgPHNwYW4+4oaSPC9zcGFuPiBjaG9vc2UgcmlnaHQgwrdcbiAgICAgICAgICAgICAgICA8c3Bhbj5TcGFjZTwvc3Bhbj4gc2tpcFxuICAgICAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgICAgIDwvZGl2PlxuICAgICAgICAgIDwvZGl2PlxuICAgICAgICA8L2Rpdj5cblxuICAgICAgICAke2NyZWF0ZVNldHRpbmdzVGFiKCl9XG4gICAgICA8L2Rpdj5cbiAgICBgO1xufVxuXG4vKiogVG91Y2ggc2NyZWVucyBoYXZlIG5vIGhvdmVyIHRvb2x0aXBzOiB0aGUg4pOYIGJ1dHRvbiBzaG93cyB0aGUgY3VycmVudCBtb2RlJ3MgZXhwbGFuYXRpb24gaGVyZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiB1cGRhdGVNb2RlSW5mbygpOiB2b2lkIHtcbiAgY29uc3QgaW5mbyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic2ItbW9kZS1pbmZvXCIpO1xuICBjb25zdCBtb2RlID0gTU9ERVMuZmluZCgobSkgPT4gbS5tb2RlID09PSBzdGF0ZS5jdXJyZW50TW9kZSk7XG4gIGlmIChpbmZvICYmIG1vZGUpIGluZm8uaW5uZXJIVE1MID0gYDxzdHJvbmc+JHttb2RlLmljb259ICR7bW9kZS50aXRsZX06PC9zdHJvbmc+ICR7bW9kZS50aXAucmVwbGFjZSgvXFxuL2csIFwiPGJyPlwiKX1gO1xufVxuXG4vKiogQmF0dGxlIHRhYiBub3RlIHdoaWxlIHRoZSBcIlN0YXNoIHJhdGluZ3NcIiBzZXR0aW5nIGlzIFwiRG9uJ3QgdXBkYXRlXCIuICovXG5leHBvcnQgZnVuY3Rpb24gdXBkYXRlUmF0aW5nc05vdGUoKTogdm9pZCB7XG4gIGNvbnN0IG5vdGUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInNiLXJhdGluZ3Mtbm90ZVwiKTtcbiAgaWYgKG5vdGUpIG5vdGUuaGlkZGVuID0gc3RhdGUuc2V0dGluZ3Muc3Rhc2hSYXRpbmdzICE9PSBcIm9mZlwiO1xufVxuXG4vKiogXCJXaGljaCBzY2VuZXMgYW0gSSByYXRpbmc/XCIgbGluZSBhYm92ZSB0aGUgY2FyZHM6IHRoZSBTY2VuZXMgcGFnZSBmaWx0ZXIgb3IgdGhlIHdob2xlIGxpYnJhcnkuICovXG5leHBvcnQgZnVuY3Rpb24gdXBkYXRlUG9vbFN0YXR1cygpOiB2b2lkIHtcbiAgY29uc3Qgc3RhdHVzID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzYi1wb29sLXN0YXR1c1wiKTtcbiAgaWYgKCFzdGF0dXMpIHJldHVybjtcbiAgY29uc3QgY291bnQgPSBzdGF0ZS5sZWZ0UG9vbFNpemU7XG4gIGNvbnN0IGNvdW50SHRtbCA9XG4gICAgY291bnQgPT09IG51bGwgPyBcIlwiIDogYCDCtyA8c3Ryb25nPiR7Y291bnR9IHNjZW5lJHtjb3VudCA9PT0gMSA/IFwiXCIgOiBcInNcIn08L3N0cm9uZz5gO1xuXG4gIGlmIChyZWFkRmlsdGVycygpLmZpbHRlckFjdGl2ZSkge1xuICAgIGNvbnN0IG9wcG9uZW50cyA9IHN0YXRlLnNldHRpbmdzLmZpbHRlck9wcG9uZW50cyA/IFwiIMK3IG9wcG9uZW50cyBmcm9tIHRoZSBmaWx0ZXIgdG9vXCIgOiBcIlwiO1xuICAgIHN0YXR1cy5pbm5lckhUTUwgPSBgUmF0aW5nIHNjZW5lcyBmcm9tIHlvdXIgU2NlbmVzIHBhZ2UgZmlsdGVyJHtjb3VudEh0bWx9JHtvcHBvbmVudHN9YDtcbiAgfSBlbHNlIHtcbiAgICBzdGF0dXMuaW5uZXJIVE1MID0gYFJhdGluZyBzY2VuZXMgZnJvbSB5b3VyIHdob2xlIGxpYnJhcnkke2NvdW50SHRtbH08c3BhbiBjbGFzcz1cInNiLXBvb2wtaGludFwiPiDCtyBmaWx0ZXIgdGhlIFNjZW5lcyBwYWdlIHRvIG5hcnJvdyBpdCBkb3duPC9zcGFuPmA7XG4gIH1cbiAgc3RhdHVzLmhpZGRlbiA9IGZhbHNlO1xufVxuXG4vKiogQ2FyZCBiYWRnZTogdGhlIHdpbiBzdHJlYWsgd2hpbGUgY2xpbWJpbmcgb3IgZGVmZW5kaW5nLCBvciBQbGFjZW1lbnQncyBuYXJyb3dpbmcgcmFuZ2UuICovXG5mdW5jdGlvbiBjbGltYlN0YXR1c0JhZGdlKHNjZW5lOiBTY2VuZSk6IG51bWJlciB8IHN0cmluZyB8IG51bGwge1xuICBpZiAoc3RhdGUuY3VycmVudE1vZGUgPT09IFwicGxhY2VtZW50XCIpIHtcbiAgICBjb25zdCBydW4gPSBzdGF0ZS5wbGFjZW1lbnQ7XG4gICAgaWYgKHJ1bj8uc2NlbmUuaWQgIT09IHNjZW5lLmlkKSByZXR1cm4gbnVsbDtcbiAgICAvLyBcIlN0YXJ0IGZyb20gdGhlIGJvdHRvbVwiIHJ1bnMgc2hvdyB0aGUgc3RyZWFrIHVudGlsIHRoZSBmaXJzdCBsb3NzXG4gICAgaWYgKHJ1bi5mcm9tQm90dG9tICYmIHJ1bi5iYXR0bGVzID4gMCAmJiBydW4uc3RyZWFrID09PSBydW4uYmF0dGxlcykgcmV0dXJuIHJ1bi5zdHJlYWs7XG4gICAgaWYgKHJ1bi5yYW5nZUhpID09PSBydW4ucmFuZ2VMbykgcmV0dXJuIG51bGw7XG4gICAgcmV0dXJuIGDwn5ONIE5hcnJvd2luZyBiZXR3ZWVuICMke3J1bi5yYW5nZUxvICsgMX0gYW5kICMke3J1bi5yYW5nZUhpICsgMX1gO1xuICB9XG4gIGlmIChzdGF0ZS5jdXJyZW50TW9kZSA9PT0gXCJjaGFtcGlvblwiICYmIHN0YXRlLmNoYW1waW9uU2NlbmU/LmlkID09PSBzY2VuZS5pZCkge1xuICAgIHJldHVybiBzdGF0ZS5jaGFtcGlvbldpbnM7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbi8qKiBQcmVjb21wdXRlZCB3aW5uZXIvbG9zZXIgY29udGV4dCB3aXJlZCBhdCByZW5kZXIgdGltZSBmb3IgZWFjaCBjaG9vc2UgYnV0dG9uLiAqL1xuaW50ZXJmYWNlIFNjZW5lQ2hvaWNlIHtcbiAgd2lubmVyOiBTY2VuZTtcbiAgbG9zZXI6IFNjZW5lO1xuICBsZWZ0OiBTY2VuZTtcbiAgcmlnaHQ6IFNjZW5lO1xuICB3aW5uZXJDYXJkOiBIVE1MRWxlbWVudDtcbiAgbG9zZXJDYXJkOiBIVE1MRWxlbWVudDtcbiAgd2lubmVyUmFuazogUmFuaztcbiAgbG9zZXJSYW5rOiBSYW5rO1xufVxuXG5mdW5jdGlvbiBiaW5kU2NlbmVDaG9pY2UoYm9keTogSFRNTEVsZW1lbnQsIGNob2ljZTogU2NlbmVDaG9pY2UpOiB2b2lkIHtcbiAgYm9keS5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4gaGFuZGxlU2NlbmVDaG9pY2UoY2hvaWNlKSk7XG59XG5cbi8qKiBTaG93IG9yIGhpZGUgdGhlIFNraXAgLyBSZWZyZXNoIGJhci4gT25seSBlbmQgc2NyZWVucyBoaWRlIGl0OyBldmVyeSByZW5kZXJlZCBwYWlyIHNob3dzIGl0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNldEFjdGlvbnNWaXNpYmxlKHZpc2libGU6IGJvb2xlYW4pOiB2b2lkIHtcbiAgY29uc3QgYWN0aW9uc0VsID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCIuc2ItYWN0aW9uc1wiKTtcbiAgaWYgKGFjdGlvbnNFbCkgYWN0aW9uc0VsLnN0eWxlLmRpc3BsYXkgPSB2aXNpYmxlID8gXCJcIiA6IFwibm9uZVwiO1xufVxuXG4vKiogVG91Y2ggZGV2aWNlcyBoYXZlIG5vIGhvdmVyOiB0aHVtYm5haWxzIHRvZ2dsZSB0aGUgcHJldmlldyBpbnN0ZWFkIG9mIG9wZW5pbmcgdGhlIHNjZW5lLiAqL1xuZnVuY3Rpb24gaXNUb3VjaERldmljZSgpOiBib29sZWFuIHtcbiAgcmV0dXJuIHdpbmRvdy5tYXRjaE1lZGlhKFwiKGhvdmVyOiBub25lKVwiKS5tYXRjaGVzO1xufVxuXG4vKiogVGh1bWJuYWlsIC8g4oaXIGxpbmsgY2xpY2s6IG5hdGl2ZSBsaW5rIGZvciBuZXcgdGFiIG9yIG1vZGlmaWVyIGNsaWNrcywgU1BBIG5hdmlnYXRpb24gb3RoZXJ3aXNlLiAqL1xuZnVuY3Rpb24gaGFuZGxlU2NlbmVMaW5rQ2xpY2soZTogTW91c2VFdmVudCwgbGluazogSFRNTEFuY2hvckVsZW1lbnQpOiB2b2lkIHtcbiAgY29uc3QgbmF0aXZlTmV3VGFiID0gbGluay50YXJnZXQgPT09IFwiX2JsYW5rXCIgJiYgc3RhdGUuc2V0dGluZ3Mub3BlbkluTmV3VGFiO1xuICBpZiAobmF0aXZlTmV3VGFiIHx8IGUuY3RybEtleSB8fCBlLm1ldGFLZXkgfHwgZS5zaGlmdEtleSB8fCBlLmJ1dHRvbiAhPT0gMCkgcmV0dXJuO1xuICBlLnByZXZlbnREZWZhdWx0KCk7XG4gIG5hdmlnYXRlVG9VcmwobGluay5nZXRBdHRyaWJ1dGUoXCJocmVmXCIpIHx8IFwiXCIpO1xufVxuXG4vKipcbiAqIFNsaWRlciAoMC0xMDApIHRvIG1lZGlhIHZvbHVtZSBvbiBhIGN1YmljIGN1cnZlLCBzbyB0aGUgc2xpZGVyIHRyYWNrcyBwZXJjZWl2ZWQgbG91ZG5lc3MuXG4gKiAoU3Rhc2gncyBwbGF5ZXIgaXMgbGluZWFyLCBidXQgZ2VuZXJhdGVkIHByZXZpZXcgY2xpcHMgYXJlIG11Y2ggbG91ZGVyIHRoYW4gdGhlIHNvdXJjZS4pXG4gKi9cbmZ1bmN0aW9uIHNsaWRlclRvVm9sdW1lKHNsaWRlcjogbnVtYmVyKTogbnVtYmVyIHtcbiAgcmV0dXJuIE1hdGgucG93KHNsaWRlciAvIDEwMCwgMyk7XG59XG5cbi8qKiBBcHBseSB2b2x1bWUvYXV0b3BsYXkgc2V0dGluZ3MgdG8gdGhlIHJlbmRlcmVkIHByZXZpZXcgdmlkZW9zIChob3ZlcmVkIGNhcmQgaXMgYXVkaWJsZSkuICovXG5leHBvcnQgZnVuY3Rpb24gYXBwbHlQcmV2aWV3U2V0dGluZ3MoKTogdm9pZCB7XG4gIGNvbnN0IHsgcHJldmlld1ZvbHVtZSwgYXV0b3BsYXlQcmV2aWV3cyB9ID0gc3RhdGUuc2V0dGluZ3M7XG4gIGNvbnN0IGJhdHRsZVZpc2libGUgPSBnZXRBY3RpdmVUYWIoKSA9PT0gXCJiYXR0bGVcIjtcbiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvcihcIi5zYi12cy1jb250YWluZXJcIik/LmNsYXNzTGlzdC50b2dnbGUoXCJzYi1hdXRvcGxheVwiLCBhdXRvcGxheVByZXZpZXdzKTtcblxuICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PihcIiNzYi1jb21wYXJpc29uLWFyZWEgLnNiLXNjZW5lLWNhcmRcIikuZm9yRWFjaCgoY2FyZCkgPT4ge1xuICAgIGNvbnN0IHZpZGVvID0gY2FyZC5xdWVyeVNlbGVjdG9yPEhUTUxWaWRlb0VsZW1lbnQ+KFwiLnNiLWhvdmVyLXByZXZpZXdcIik7XG4gICAgaWYgKCF2aWRlbykgcmV0dXJuO1xuICAgIGNvbnN0IGFjdGl2ZSA9IGNhcmQubWF0Y2hlcyhcIjpob3ZlclwiKSB8fCBjYXJkLmNsYXNzTGlzdC5jb250YWlucyhcInNiLXByZXZpZXdpbmdcIik7XG4gICAgdmlkZW8udm9sdW1lID0gc2xpZGVyVG9Wb2x1bWUocHJldmlld1ZvbHVtZSk7XG4gICAgdmlkZW8ubXV0ZWQgPSAhYWN0aXZlIHx8IHByZXZpZXdWb2x1bWUgPT09IDA7XG4gICAgaWYgKGJhdHRsZVZpc2libGUgJiYgKGF1dG9wbGF5UHJldmlld3MgfHwgYWN0aXZlKSkge1xuICAgICAgaWYgKHZpZGVvLnBhdXNlZCkgdmlkZW8ucGxheSgpLmNhdGNoKCgpID0+IHt9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgdmlkZW8ucGF1c2UoKTtcbiAgICAgIHZpZGVvLmN1cnJlbnRUaW1lID0gMDtcbiAgICB9XG4gIH0pO1xufVxuXG5mdW5jdGlvbiBiaW5kUHJldmlldyhjYXJkOiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICBjb25zdCB2aWRlbyA9IGNhcmQucXVlcnlTZWxlY3RvcjxIVE1MVmlkZW9FbGVtZW50PihcIi5zYi1ob3Zlci1wcmV2aWV3XCIpO1xuICBpZiAoIXZpZGVvKSByZXR1cm47XG5cbiAgY2FyZC5hZGRFdmVudExpc3RlbmVyKFwibW91c2VlbnRlclwiLCAoKSA9PiB7XG4gICAgaWYgKGlzVG91Y2hEZXZpY2UoKSkgcmV0dXJuO1xuICAgIGlmICghc3RhdGUuc2V0dGluZ3MuYXV0b3BsYXlQcmV2aWV3cykgdmlkZW8uY3VycmVudFRpbWUgPSAwO1xuICAgIHZpZGVvLnZvbHVtZSA9IHNsaWRlclRvVm9sdW1lKHN0YXRlLnNldHRpbmdzLnByZXZpZXdWb2x1bWUpO1xuICAgIHZpZGVvLm11dGVkID0gc3RhdGUuc2V0dGluZ3MucHJldmlld1ZvbHVtZSA9PT0gMDtcbiAgICB2aWRlby5wbGF5KCkuY2F0Y2goKCkgPT4ge30pO1xuICB9KTtcblxuICBjYXJkLmFkZEV2ZW50TGlzdGVuZXIoXCJtb3VzZWxlYXZlXCIsICgpID0+IHtcbiAgICBpZiAoaXNUb3VjaERldmljZSgpKSByZXR1cm47XG4gICAgaWYgKHN0YXRlLnNldHRpbmdzLmF1dG9wbGF5UHJldmlld3MpIHtcbiAgICAgIHZpZGVvLm11dGVkID0gdHJ1ZTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdmlkZW8ucGF1c2UoKTtcbiAgICB2aWRlby5jdXJyZW50VGltZSA9IDA7XG4gIH0pO1xufVxuXG4vKiogVG91Y2g6IHRhcCB0aGUgdGh1bWJuYWlsIHRvIHBsYXkvc3RvcCBpdHMgcHJldmlldyB3aXRoIHNvdW5kLiAqL1xuZnVuY3Rpb24gdG9nZ2xlUHJldmlldyhjYXJkOiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICBjb25zdCBwcmV2aWV3aW5nID0gIWNhcmQuY2xhc3NMaXN0LmNvbnRhaW5zKFwic2ItcHJldmlld2luZ1wiKTtcbiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbChcIi5zYi1zY2VuZS1jYXJkLnNiLXByZXZpZXdpbmdcIikuZm9yRWFjaCgoYykgPT4gYy5jbGFzc0xpc3QucmVtb3ZlKFwic2ItcHJldmlld2luZ1wiKSk7XG4gIGNhcmQuY2xhc3NMaXN0LnRvZ2dsZShcInNiLXByZXZpZXdpbmdcIiwgcHJldmlld2luZyk7XG4gIGFwcGx5UHJldmlld1NldHRpbmdzKCk7XG59XG5cbi8qKlxuICogVGhlIFZTIGJldHdlZW4gdGhlIGNhcmRzLCB3aXRoIGVhY2ggc2lkZSdzIHdpbiBjaGFuY2UgdW5kZXIgaXQgKGEgXCJ3aG8ncyBmYXZvdXJlZFwiIGJhcikuXG4gKiBQbGFjZW1lbnQgaGFzIG5vbmU6IGl0cyBzY2VuZSdzIEVMTyBkb2Vzbid0IGNoYW5nZSBwZXIgcGljaywgYW5kIGFuIHVucmF0ZWQgb25lIGhhcyBubyBFTE8uXG4gKi9cbmZ1bmN0aW9uIHZzRGl2aWRlcihsZWZ0OiBTY2VuZSwgcmlnaHQ6IFNjZW5lKTogc3RyaW5nIHtcbiAgaWYgKHN0YXRlLmN1cnJlbnRNb2RlID09PSBcInBsYWNlbWVudFwiKSB7XG4gICAgcmV0dXJuIGA8ZGl2IGNsYXNzPVwic2ItdnMtZGl2aWRlclwiPjxzcGFuIGNsYXNzPVwic2ItdnMtdGV4dFwiPlZTPC9zcGFuPjwvZGl2PmA7XG4gIH1cbiAgY29uc3QgW2xlZnRDaGFuY2UsIHJpZ2h0Q2hhbmNlXSA9IHdpbkNoYW5jZXMoYmF0dGxlRWxvKGxhdGVzdFNjZW5lKGxlZnQpKSwgYmF0dGxlRWxvKGxhdGVzdFNjZW5lKHJpZ2h0KSkpO1xuICBjb25zdCBmYXZvdXJlZCA9IChjaGFuY2U6IG51bWJlcik6IHN0cmluZyA9PiAoY2hhbmNlID4gNTAgPyBcIiBzYi1mYXZvdXJlZFwiIDogXCJcIik7XG4gIGNvbnN0IHRpcCA9IGBDaGFuY2UgZWFjaCBzY2VuZSB3aW5zLCBmcm9tIHRoZWlyIEVMTzogbGVmdCAke2xlZnRDaGFuY2V9JSwgcmlnaHQgJHtyaWdodENoYW5jZX0lYDtcbiAgcmV0dXJuIGBcbiAgICAgICAgPGRpdiBjbGFzcz1cInNiLXZzLWRpdmlkZXJcIj5cbiAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItdnMtc3RhY2tcIiB0aXRsZT1cIiR7dGlwfVwiPlxuICAgICAgICAgICAgPHNwYW4gY2xhc3M9XCJzYi13aW4tY2hhbmNlIHNiLXdpbi1jaGFuY2UtbGVmdCR7ZmF2b3VyZWQobGVmdENoYW5jZSl9XCI+JHtsZWZ0Q2hhbmNlfSU8L3NwYW4+XG4gICAgICAgICAgICA8c3BhbiBjbGFzcz1cInNiLXZzLXRleHRcIj5WUzwvc3Bhbj5cbiAgICAgICAgICAgIDxzcGFuIGNsYXNzPVwic2Itd2luLWNoYW5jZSBzYi13aW4tY2hhbmNlLXJpZ2h0JHtmYXZvdXJlZChyaWdodENoYW5jZSl9XCI+JHtyaWdodENoYW5jZX0lPC9zcGFuPlxuICAgICAgICAgICAgPHNwYW4gY2xhc3M9XCJzYi13aW4tYmFyXCIgYXJpYS1oaWRkZW49XCJ0cnVlXCI+PHNwYW4gc3R5bGU9XCJ3aWR0aDogJHtsZWZ0Q2hhbmNlfSVcIj48L3NwYW4+PC9zcGFuPlxuICAgICAgICAgIDwvZGl2PlxuICAgICAgICA8L2Rpdj5gO1xufVxuXG4vKiogRWFjaCBzY2VuZSdzIHRpZXIgd2hlbiBcIlNob3cgdGllcnMgb24gY2FyZHNcIiBpcyBvbiAoZnJvbSB0aGUgd2hvbGUgbGlicmFyeSdzIEVMTyBvcmRlcikuICovXG5mdW5jdGlvbiBwYWlyVGllcnMoc2NlbmVzOiBTY2VuZVtdKTogKFRpZXIgfCBudWxsKVtdIHtcbiAgY29uc3QgbGlicmFyeSA9IHN0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcztcbiAgaWYgKCFzdGF0ZS5zZXR0aW5ncy5zaG93VGllcnMgfHwgIWxpYnJhcnkpIHJldHVybiBzY2VuZXMubWFwKCgpID0+IG51bGwpO1xuICBjb25zdCB0aWVycyA9IHRpZXJNYXAobGlicmFyeSk7XG4gIHJldHVybiBzY2VuZXMubWFwKChzY2VuZSkgPT4gdGllcnMuZ2V0KHNjZW5lLmlkKSA/PyBudWxsKTtcbn1cblxuLy8gU2hhcmVkIHJlbmRlcmluZyBsb2dpYyBmb3IgZGlzcGxheWluZyBhIHBhaXIgb2Ygc2NlbmVzXG5leHBvcnQgZnVuY3Rpb24gcmVuZGVyUGFpcihzY2VuZXM6IFNjZW5lW10sIHJhbmtzOiBSYW5rW10pOiB2b2lkIHtcbiAgY29uc3QgY29tcGFyaXNvbkFyZWEgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInNiLWNvbXBhcmlzb24tYXJlYVwiKTtcbiAgaWYgKCFjb21wYXJpc29uQXJlYSkgcmV0dXJuO1xuXG4gIGNvbnN0IHN0YXR1c0JhZGdlcyA9IHNjZW5lcy5tYXAoY2xpbWJTdGF0dXNCYWRnZSk7XG4gIGNvbnN0IHRpZXJzID0gcGFpclRpZXJzKHNjZW5lcyk7XG5cbiAgY29tcGFyaXNvbkFyZWEuaW5uZXJIVE1MID0gYFxuICAgICAgPGRpdiBjbGFzcz1cInNiLXZzLWNvbnRhaW5lclwiPlxuICAgICAgICAke2NyZWF0ZVNjZW5lQ2FyZChzY2VuZXNbMF0sIFwibGVmdFwiLCByYW5rc1swXSwgc3RhdHVzQmFkZ2VzWzBdLCB0aWVyc1swXSl9XG4gICAgICAgICR7dnNEaXZpZGVyKHNjZW5lc1swXSwgc2NlbmVzWzFdKX1cbiAgICAgICAgJHtjcmVhdGVTY2VuZUNhcmQoc2NlbmVzWzFdLCBcInJpZ2h0XCIsIHJhbmtzWzFdLCBzdGF0dXNCYWRnZXNbMV0sIHRpZXJzWzFdKX1cbiAgICAgIDwvZGl2PlxuICAgIGA7XG5cbiAgY29uc3QgbGVmdCA9IHNjZW5lc1swXTtcbiAgY29uc3QgcmlnaHQgPSBzY2VuZXNbMV07XG4gIGNvbnN0IGxlZnRDYXJkID0gY29tcGFyaXNvbkFyZWEucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oJy5zYi1zY2VuZS1jYXJkW2RhdGEtc2lkZT1cImxlZnRcIl0nKTtcbiAgY29uc3QgcmlnaHRDYXJkID0gY29tcGFyaXNvbkFyZWEucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oJy5zYi1zY2VuZS1jYXJkW2RhdGEtc2lkZT1cInJpZ2h0XCJdJyk7XG4gIGNvbnN0IGxlZnRCb2R5ID0gbGVmdENhcmQ/LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiLnNiLXNjZW5lLWJvZHlcIik7XG4gIGNvbnN0IHJpZ2h0Qm9keSA9IHJpZ2h0Q2FyZD8ucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCIuc2Itc2NlbmUtYm9keVwiKTtcblxuICBpZiAobGVmdCAmJiByaWdodCAmJiBsZWZ0Q2FyZCAmJiByaWdodENhcmQgJiYgbGVmdEJvZHkgJiYgcmlnaHRCb2R5KSB7XG4gICAgYmluZFNjZW5lQ2hvaWNlKGxlZnRCb2R5LCB7XG4gICAgICB3aW5uZXI6IGxlZnQsXG4gICAgICBsb3NlcjogcmlnaHQsXG4gICAgICBsZWZ0LFxuICAgICAgcmlnaHQsXG4gICAgICB3aW5uZXJDYXJkOiBsZWZ0Q2FyZCxcbiAgICAgIGxvc2VyQ2FyZDogcmlnaHRDYXJkLFxuICAgICAgd2lubmVyUmFuazogcmFua3NbMF0sXG4gICAgICBsb3NlclJhbms6IHJhbmtzWzFdLFxuICAgIH0pO1xuICAgIGJpbmRTY2VuZUNob2ljZShyaWdodEJvZHksIHtcbiAgICAgIHdpbm5lcjogcmlnaHQsXG4gICAgICBsb3NlcjogbGVmdCxcbiAgICAgIGxlZnQsXG4gICAgICByaWdodCxcbiAgICAgIHdpbm5lckNhcmQ6IHJpZ2h0Q2FyZCxcbiAgICAgIGxvc2VyQ2FyZDogbGVmdENhcmQsXG4gICAgICB3aW5uZXJSYW5rOiByYW5rc1sxXSxcbiAgICAgIGxvc2VyUmFuazogcmFua3NbMF0sXG4gICAgfSk7XG5cbiAgICBsZWZ0Q2FyZC5xdWVyeVNlbGVjdG9yKFwiLnNiLWRlbGV0ZS1idG5cIik/LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiB2b2lkIGRlbGV0ZUZyb21CYXR0bGUobGVmdCkpO1xuICAgIHJpZ2h0Q2FyZC5xdWVyeVNlbGVjdG9yKFwiLnNiLWRlbGV0ZS1idG5cIik/LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiB2b2lkIGRlbGV0ZUZyb21CYXR0bGUocmlnaHQpKTtcbiAgfVxuXG4gIGNvbXBhcmlzb25BcmVhLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KFwiLnNiLXNjZW5lLWNhcmRcIikuZm9yRWFjaCgoY2FyZCkgPT4ge1xuICAgIGNvbnN0IHRodW1iID0gY2FyZC5xdWVyeVNlbGVjdG9yPEhUTUxBbmNob3JFbGVtZW50PihcIi5zYi1zY2VuZS1pbWFnZS1jb250YWluZXJcIik7XG4gICAgdGh1bWI/LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZSkgPT4ge1xuICAgICAgaWYgKGlzVG91Y2hEZXZpY2UoKSkge1xuICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgICAgIHRvZ2dsZVByZXZpZXcoY2FyZCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGhhbmRsZVNjZW5lTGlua0NsaWNrKGUsIHRodW1iKTtcbiAgICB9KTtcbiAgICBjb25zdCBvcGVuTGluayA9IGNhcmQucXVlcnlTZWxlY3RvcjxIVE1MQW5jaG9yRWxlbWVudD4oXCIuc2Itb3Blbi1saW5rXCIpO1xuICAgIG9wZW5MaW5rPy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICAgIGlmICghc3RhdGUuc2V0dGluZ3Mub3BlbkluTmV3VGFiKSBoYW5kbGVTY2VuZUxpbmtDbGljayhlLCBvcGVuTGluayk7XG4gICAgfSk7XG4gICAgYmluZFByZXZpZXcoY2FyZCk7XG4gIH0pO1xuICBhcHBseVByZXZpZXdTZXR0aW5ncygpO1xuXG4gIHNldEFjdGlvbnNWaXNpYmxlKHRydWUpO1xuXG4gIC8vIFVwZGF0ZSBza2lwIGJ1dHRvbiBzdGF0ZVxuICBjb25zdCBza2lwQnRuID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcjxIVE1MQnV0dG9uRWxlbWVudD4oXCIjc2Itc2tpcC1idG5cIik7XG4gIGlmIChza2lwQnRuKSBza2lwQnRuLmRpc2FibGVkID0gaXNSdW5BY3RpdmUoKTtcbn1cblxuLyoqIFNraXAgdGhlIGN1cnJlbnQgcGFpciAobm90IGFsbG93ZWQgbWlkLXJ1bikuICovXG5leHBvcnQgZnVuY3Rpb24gc2tpcFBhaXIoKTogdm9pZCB7XG4gIGlmIChpc1J1bkFjdGl2ZSgpIHx8IHN0YXRlLmRpc2FibGVDaG9pY2UpIHJldHVybjtcbiAgc3RhdGUuZGlzYWJsZUNob2ljZSA9IHRydWU7XG4gIGlmIChzdGF0ZS5jdXJyZW50TW9kZSAhPT0gXCJzd2lzc1wiKSB7XG4gICAgcmVzZXRSdW5TdGF0ZSgpO1xuICAgIHNhdmVTdGF0ZSgpO1xuICB9XG4gIGxvYWROZXdQYWlyKCk7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBsb2FkTmV3UGFpcihmb3JjZWRMZWZ0U2NlbmVJZDogc3RyaW5nIHwgbnVsbCA9IG51bGwpOiBQcm9taXNlPHZvaWQ+IHtcbiAgLy8gTm8gcG9vbCBsb2FkcyBiZWZvcmUgdGhlIG9uZS10aW1lIEVMTyBzZXR1cCBoYXMgcnVuIChpdCBzaG93cyBpbiBwbGFjZSBvZiB0aGUgYmF0dGxlKVxuICBpZiAoaXNFbG9TZXR1cFBlbmRpbmcoKSkgcmV0dXJuO1xuICBzdGF0ZS5kaXNhYmxlQ2hvaWNlID0gZmFsc2U7XG4gIGNvbnN0IGNvbXBhcmlzb25BcmVhID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzYi1jb21wYXJpc29uLWFyZWFcIik7XG4gIGlmICghY29tcGFyaXNvbkFyZWEpIHJldHVybjtcblxuICBjb25zb2xlLmxvZyhcbiAgICBgW1N0YXNoIEJhdHRsZV0g8J+OriBMb2FkaW5nIG5ldyBwYWlyIChtb2RlOiAke3N0YXRlLmN1cnJlbnRNb2RlfSkke2ZvcmNlZExlZnRTY2VuZUlkID8gYCB3aXRoIGZvcmNlZCBzY2VuZSAke2ZvcmNlZExlZnRTY2VuZUlkfWAgOiBcIlwifS4uLmAsXG4gICk7XG4gIGNvbnN0IHN0YXJ0VGltZSA9IERhdGUubm93KCk7XG5cbiAgLy8gT25seSBzaG93IGxvYWRpbmcgb24gZmlyc3QgbG9hZCAod2hlbiBlbXB0eSBvciBhbHJlYWR5IHNob3dpbmcgbG9hZGluZylcbiAgaWYgKCFjb21wYXJpc29uQXJlYS5xdWVyeVNlbGVjdG9yKFwiLnNiLXZzLWNvbnRhaW5lclwiKSkge1xuICAgIGNvbnN0IGhhc0NhY2hlID0gc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzICE9PSBudWxsO1xuICAgIGNvbXBhcmlzb25BcmVhLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPVwic2ItbG9hZGluZ1wiPiR7aGFzQ2FjaGUgPyBcIkxvYWRpbmcgc2NlbmVzLi4uXCIgOiBcIkxvYWRpbmcgYW5kIGNhY2hpbmcgc2NlbmVzIChmaXJzdCBsb2FkIG1heSB0YWtlIGEgbW9tZW50KS4uLlwifTwvZGl2PmA7XG4gIH1cblxuICB0cnkge1xuICAgIC8vIEZldGNoIGZvcmNlZCBzY2VuZSBkYXRhIGlmIGEgc2NlbmUgSUQgd2FzIHByb3ZpZGVkXG4gICAgbGV0IGZvcmNlZExlZnRTY2VuZTogU2NlbmUgfCBudWxsID0gbnVsbDtcbiAgICBpZiAoZm9yY2VkTGVmdFNjZW5lSWQpIHtcbiAgICAgIGZvcmNlZExlZnRTY2VuZSA9IGF3YWl0IGZldGNoU2NlbmVCeUlkKGZvcmNlZExlZnRTY2VuZUlkKTtcbiAgICAgIC8vIEZyZXNoIGZyb20gU3Rhc2g6IHRoZSBjYWNoZSBtYXkgYmUgb2xkZXIgKGFub3RoZXIgdGFiKSwgYW5kIHJhbmtzIGFuZCBiYXR0bGUgbWF0aCByZWFkIGl0XG4gICAgICBpZiAoZm9yY2VkTGVmdFNjZW5lKSByZWZyZXNoU2NlbmVJbkNhY2hlKGZvcmNlZExlZnRTY2VuZSk7XG4gICAgICBpZiAoIWZvcmNlZExlZnRTY2VuZSkge1xuICAgICAgICBjb25zb2xlLndhcm4oXCJbU3Rhc2ggQmF0dGxlXSBDb3VsZCBub3QgZmV0Y2ggc2NlbmUgZnJvbSBVUkwsIGZhbGxpbmcgYmFjayB0byBub3JtYWwgcGFpcmluZ1wiKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBsZXQgc2NlbmVzOiBTY2VuZVtdID0gW107XG4gICAgbGV0IHJhbmtzOiBSYW5rW10gPSBbbnVsbCwgbnVsbF07XG5cbiAgICBpZiAoc3RhdGUuY3VycmVudE1vZGUgPT09IFwicGxhY2VtZW50XCIpIHtcbiAgICAgIGNvbnN0IHBsYWNlbWVudFJlc3VsdCA9IGF3YWl0IGZldGNoUGxhY2VtZW50UGFpcihmb3JjZWRMZWZ0U2NlbmUpO1xuXG4gICAgICBpZiAocGxhY2VtZW50UmVzdWx0LmRvbmUpIHtcbiAgICAgICAgLy8gQSBjbGltYiBmcm9tIHRoZSBib3R0b20gdGhhdCBuZXZlciBsb3N0IGhhcyBiZWF0ZW4gdGhlIHRvcCBzY2VuZVxuICAgICAgICBpZiAocGxhY2VtZW50UmVzdWx0LmZyb21Cb3R0b20gJiYgcGxhY2VtZW50UmVzdWx0LnJhbmsgPT09IDEpIHtcbiAgICAgICAgICBzaG93VmljdG9yeVNjcmVlbihwbGFjZW1lbnRSZXN1bHQuc2NlbmUsIHBsYWNlbWVudFJlc3VsdC5zdHJlYWspO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHNob3dQbGFjZW1lbnRTY3JlZW4ocGxhY2VtZW50UmVzdWx0KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIHNjZW5lcyA9IHBsYWNlbWVudFJlc3VsdC5zY2VuZXM7XG4gICAgICByYW5rcyA9IHBsYWNlbWVudFJlc3VsdC5yYW5rcztcbiAgICB9IGVsc2UgaWYgKHN0YXRlLmN1cnJlbnRNb2RlID09PSBcImNoYW1waW9uXCIpIHtcbiAgICAgIGNvbnN0IGNoYW1waW9uUmVzdWx0ID0gYXdhaXQgZmV0Y2hDaGFtcGlvblBhaXIoZm9yY2VkTGVmdFNjZW5lKTtcblxuICAgICAgLy8gQ2hlY2sgZm9yIHZpY3RvcnkgKGNoYW1waW9uIGJlYXQgZXZlcnlvbmUpXG4gICAgICBpZiAoY2hhbXBpb25SZXN1bHQuaXNWaWN0b3J5KSB7XG4gICAgICAgIHNob3dWaWN0b3J5U2NyZWVuKGNoYW1waW9uUmVzdWx0LnNjZW5lc1swXSwgc3RhdGUuY2hhbXBpb25XaW5zKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBzY2VuZXMgPSBjaGFtcGlvblJlc3VsdC5zY2VuZXM7XG4gICAgICByYW5rcyA9IGNoYW1waW9uUmVzdWx0LnJhbmtzO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBzd2lzc1Jlc3VsdCA9IGF3YWl0IGZldGNoU3dpc3NQYWlyKGZvcmNlZExlZnRTY2VuZSk7XG5cbiAgICAgIHNjZW5lcyA9IHN3aXNzUmVzdWx0LnNjZW5lcztcbiAgICAgIHJhbmtzID0gc3dpc3NSZXN1bHQucmFua3M7XG4gICAgfVxuXG4gICAgaWYgKHNjZW5lcy5sZW5ndGggPCAyKSB7XG4gICAgICBjb21wYXJpc29uQXJlYS5pbm5lckhUTUwgPSAnPGRpdiBjbGFzcz1cInNiLWVycm9yXCI+Tm90IGVub3VnaCBzY2VuZXMgYXZhaWxhYmxlIGZvciBjb21wYXJpc29uLjwvZGl2Pic7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgc3RhdGUuY3VycmVudFBhaXIubGVmdCA9IHNjZW5lc1swXTtcbiAgICBzdGF0ZS5jdXJyZW50UGFpci5yaWdodCA9IHNjZW5lc1sxXTtcbiAgICBzdGF0ZS5jdXJyZW50UmFua3MubGVmdCA9IHJhbmtzWzBdO1xuICAgIHN0YXRlLmN1cnJlbnRSYW5rcy5yaWdodCA9IHJhbmtzWzFdO1xuXG4gICAgY29uc3QgbG9hZFRpbWUgPSBEYXRlLm5vdygpIC0gc3RhcnRUaW1lO1xuICAgIGNvbnNvbGUubG9nKFxuICAgICAgYFtTdGFzaCBCYXR0bGVdIOKchSBQYWlyIGxvYWRlZCBpbiAke2xvYWRUaW1lfW1zOiBTY2VuZSAke3NjZW5lc1swXS5pZH0gKHJhbmsgIyR7cmFua3NbMF19KSB2cyBTY2VuZSAke3NjZW5lc1sxXS5pZH0gKHJhbmsgIyR7cmFua3NbMV19KWAsXG4gICAgKTtcblxuICAgIHJlbmRlclBhaXIoc2NlbmVzLCByYW5rcyk7XG4gICAgdXBkYXRlUG9vbFN0YXR1cygpO1xuICAgIHVwZGF0ZUNsaW1iUG9vbFdhcm5pbmcoKTtcbiAgICBzYXZlU3RhdGUoKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0gRXJyb3IgbG9hZGluZyBzY2VuZXM6XCIsIGVycm9yKTtcbiAgICBjb25zdCBtZXNzYWdlID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xuICAgIGNvbnN0IGlzTm9TY2VuZXMgPSBtZXNzYWdlLmluY2x1ZGVzKFwiTm8gc2NlbmVzXCIpIHx8IG1lc3NhZ2UuaW5jbHVkZXMoXCJOb3QgZW5vdWdoXCIpO1xuICAgIGNvbXBhcmlzb25BcmVhLmlubmVySFRNTCA9IGBcbiAgICAgICAgPGRpdiBjbGFzcz1cInNiLWVycm9yLXNjcmVlblwiPlxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1lcnJvci1pY29uXCI+4pqg77iPPC9kaXY+XG4gICAgICAgICAgPHAgY2xhc3M9XCJzYi1lcnJvci1tZXNzYWdlXCI+JHttZXNzYWdlfTwvcD5cbiAgICAgICAgICA8YnV0dG9uIGlkPVwic2ItZXJyb3ItcmV0cnlcIiBjbGFzcz1cImJ0biBidG4tcHJpbWFyeVwiPlJldHJ5PC9idXR0b24+XG4gICAgICAgIDwvZGl2PlxuICAgICAgYDtcbiAgICBzZXRBY3Rpb25zVmlzaWJsZSh0cnVlKTtcblxuICAgIC8vIEF0dGFjaCByZXRyeSBoYW5kbGVyXG4gICAgY29uc3QgcmV0cnlCdG4gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInNiLWVycm9yLXJldHJ5XCIpIGFzIEhUTUxCdXR0b25FbGVtZW50IHwgbnVsbDtcbiAgICBpZiAocmV0cnlCdG4pIHtcbiAgICAgIHJldHJ5QnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBhc3luYyAoKSA9PiB7XG4gICAgICAgIHJldHJ5QnRuLmRpc2FibGVkID0gdHJ1ZTtcbiAgICAgICAgcmV0cnlCdG4udGV4dENvbnRlbnQgPSBcIkxvYWRpbmcuLi5cIjtcblxuICAgICAgICBpZiAoaXNOb1NjZW5lcykge1xuICAgICAgICAgIC8vIFwiTm8gc2NlbmVzXCIgZXJyb3I6IGNsZWFyIGV2ZXJ5dGhpbmcgYW5kIHN0YXJ0IGZyZXNoXG4gICAgICAgICAgYXdhaXQgY2xlYXJGaWx0ZXJlZENhY2hlKCk7XG4gICAgICAgICAgcmVzZXRTaHVmZmxlKCk7XG4gICAgICAgIH1cbiAgICAgICAgLy8gTmV0d29yay9vdGhlciBlcnJvcnM6IGp1c3QgcmV0cnkgd2l0aG91dCBjbGVhcmluZyBzZXNzaW9uIHN0YXRlXG5cbiAgICAgICAgYXdhaXQgbG9hZE5ld1BhaXIoKTtcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxufVxuXG4vKiogUmVuZGVyIHRoZSBzYXZlZCBwYWlyLCB1bmxlc3Mgb25lIG9mIGl0cyBzY2VuZXMgd2FzIGRlbGV0ZWQgaW4gU3Rhc2ggbWVhbndoaWxlLiAqL1xuLyoqXG4gKiBXaGV0aGVyIHRoZSBzYXZlZCBwYWlyIGJlbG9uZ3MgdG8gdGhlIGN1cnJlbnQgcnVuLiBBIFBsYWNlbWVudCBwYWlyIGlzIGl0cyBydW4ncyBzY2VuZSBhZ2FpbnN0XG4gKiBhbiBvcHBvbmVudCwgYW5kIGEgQ2hhbXBpb24gcGFpciBpbmNsdWRlcyB0aGUgY2hhbXBpb247IHdpdGhvdXQgdGhhdCwgcGlja3MgaGF2ZSBub3RoaW5nIHRvXG4gKiBhY3Qgb24gKGEgcnVuIHRoYXQgZW5kZWQsIHNheSkuXG4gKi9cbmZ1bmN0aW9uIHBhaXJNYXRjaGVzUnVuKGxlZnQ6IFNjZW5lLCByaWdodDogU2NlbmUpOiBib29sZWFuIHtcbiAgaWYgKHN0YXRlLmN1cnJlbnRNb2RlID09PSBcInBsYWNlbWVudFwiKSByZXR1cm4gc3RhdGUucGxhY2VtZW50Py5zY2VuZS5pZCA9PT0gbGVmdC5pZDtcbiAgaWYgKHN0YXRlLmN1cnJlbnRNb2RlID09PSBcImNoYW1waW9uXCIgJiYgc3RhdGUuY2hhbXBpb25TY2VuZSkge1xuICAgIHJldHVybiBzdGF0ZS5jaGFtcGlvblNjZW5lLmlkID09PSBsZWZ0LmlkIHx8IHN0YXRlLmNoYW1waW9uU2NlbmUuaWQgPT09IHJpZ2h0LmlkO1xuICB9XG4gIHJldHVybiB0cnVlO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVzdG9yZUN1cnJlbnRQYWlyKCk6IFByb21pc2U8dm9pZD4ge1xuICBpZiAoaXNFbG9TZXR1cFBlbmRpbmcoKSkgcmV0dXJuO1xuICBjb25zdCBsZWZ0ID0gc3RhdGUuY3VycmVudFBhaXIubGVmdCBhcyBTY2VuZTtcbiAgY29uc3QgcmlnaHQgPSBzdGF0ZS5jdXJyZW50UGFpci5yaWdodCBhcyBTY2VuZTtcbiAgaWYgKCFwYWlyTWF0Y2hlc1J1bihsZWZ0LCByaWdodCkpIHtcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCfk4IgU2F2ZWQgcGFpciBkb2Vzbid0IGJlbG9uZyB0byB0aGUgY3VycmVudCBydW4sIGxvYWRpbmcgYSBuZXcgcGFpclwiKTtcbiAgICBhd2FpdCBsb2FkTmV3UGFpcigpO1xuICAgIHJldHVybjtcbiAgfVxuICBzdGF0ZS5kaXNhYmxlQ2hvaWNlID0gZmFsc2U7XG5cbiAgLy8gQWxzbyBicmluZ3MgdGhlIHBhaXIncyBFTE8gYW5kIFN0YXNoIHJhdGluZyB1cCB0byBkYXRlICh0aGV5IG1heSBoYXZlIGNoYW5nZWQgc2luY2UgaXQgd2FzIHNhdmVkKVxuICBpZiAoIShhd2FpdCB2ZXJpZnlDdXJyZW50UGFpcigpKSkgcmV0dXJuO1xuXG4gIC8vIFJhbmtzIGZyb20gdGhlIGN1cnJlbnQgcG9vbHMsIG5vdCB0aGUgc2F2ZWQgb25lczogYmF0dGxlcyBzaW5jZSBtYXkgaGF2ZSBtb3ZlZCB0aGVtLiBMb2FkaW5nXG4gIC8vIHRoZSBwb29scyBhbHNvIHByZS13YXJtcyB0aGVtIGZvciB0aGUgbmV4dCBjaG9pY2UgYW5kIGZpbGxzIGluIHRoZSBzdGF0dXMgbGluZSdzIHBvb2wgc2l6ZS5cbiAgbGV0IHJhbmtzOiBbUmFuaywgUmFua10gPSBbc3RhdGUuY3VycmVudFJhbmtzLmxlZnQsIHN0YXRlLmN1cnJlbnRSYW5rcy5yaWdodF07XG4gIHRyeSB7XG4gICAgcmFua3MgPSBhd2FpdCBwYWlyUmFua3MobGVmdCwgcmlnaHQpO1xuICAgIHN0YXRlLmN1cnJlbnRSYW5rcyA9IHsgbGVmdDogcmFua3NbMF0sIHJpZ2h0OiByYW5rc1sxXSB9O1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS53YXJuKFwiW1N0YXNoIEJhdHRsZV0gQ291bGQgbm90IGxvYWQgc2NlbmUgcG9vbHMgZm9yIHRoZSBzYXZlZCBwYWlyJ3MgcmFua3M6XCIsIGUpO1xuICB9XG5cbiAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5OCIFJlbmRlcmluZyBzYXZlZCBwYWlyXCIpO1xuICByZW5kZXJQYWlyKFtsZWZ0LCByaWdodF0sIHJhbmtzKTtcbiAgdXBkYXRlUG9vbFN0YXR1cygpO1xufVxuXG4vKipcbiAqIENoZWNrIHRoZSBjdXJyZW50IHBhaXIgc3RpbGwgZXhpc3RzIGluIFN0YXNoIChzY2VuZXMgbWF5IGJlIGRlbGV0ZWQgZWxzZXdoZXJlKS4gSWYgb25lIGlzIGdvbmUsXG4gKiBjb250aW51ZSB3aXRob3V0IGl0IGFuZCByZXR1cm4gZmFsc2UuIE90aGVyd2lzZSB0aGUgcGFpcidzIEVMTyBhbmQgU3Rhc2ggcmF0aW5nIGFyZSBicm91Z2h0IHVwXG4gKiB0byBkYXRlIGZyb20gU3Rhc2gsIGluIGl0cyBvYmplY3RzIGFuZCB0aGUgY2FjaGUuIE5ldHdvcmsgZXJyb3JzIGNvdW50IGFzIFwic3RpbGwgdGhlcmVcIi5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHZlcmlmeUN1cnJlbnRQYWlyKCk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBjb25zdCB7IGxlZnQsIHJpZ2h0IH0gPSBzdGF0ZS5jdXJyZW50UGFpcjtcbiAgaWYgKCFsZWZ0IHx8ICFyaWdodCkgcmV0dXJuIHRydWU7XG4gIHRyeSB7XG4gICAgY29uc3QgZnJlc2ggPSBhd2FpdCBmZXRjaFNjZW5lRmllbGRzKFtsZWZ0LmlkLCByaWdodC5pZF0pO1xuICAgIGNvbnN0IGdvbmUgPSBbbGVmdCwgcmlnaHRdLmZpbmQoKHMpID0+ICFmcmVzaC5oYXMocy5pZCkpO1xuICAgIGlmIChnb25lKSB7XG4gICAgICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g8J+RuyBTY2VuZSAke2dvbmUuaWR9IGluIHRoZSBjdXJyZW50IHBhaXIgbm8gbG9uZ2VyIGV4aXN0c2ApO1xuICAgICAgYXdhaXQgaGFuZGxlU2NlbmVHb25lKGdvbmUuaWQpO1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICBmb3IgKGNvbnN0IHNjZW5lIG9mIFtsZWZ0LCByaWdodF0pIHtcbiAgICAgIGNvbnN0IGZpZWxkcyA9IGZyZXNoLmdldChzY2VuZS5pZCk7XG4gICAgICBpZiAoIWZpZWxkcykgY29udGludWU7XG4gICAgICBzY2VuZS5yYXRpbmcxMDAgPSBmaWVsZHMucmF0aW5nMTAwID8/IG51bGw7XG4gICAgICBzY2VuZS5jdXN0b21fZmllbGRzID0gZmllbGRzLmN1c3RvbV9maWVsZHMgPz8ge307XG4gICAgICByZWZyZXNoU2NlbmVJbkNhY2hlKHNjZW5lKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zb2xlLndhcm4oXCJbU3Rhc2ggQmF0dGxlXSBDb3VsZCBub3QgdmVyaWZ5IGN1cnJlbnQgcGFpcjpcIiwgZSk7XG4gIH1cbiAgcmV0dXJuIHRydWU7XG59XG5cbi8qKiBGb3JnZXQgYSBzY2VuZSBpZCByZWZlcmVuY2VkIGJ5IHRoZSBjdXJyZW50IHJ1biAoaXQgbm8gbG9uZ2VyIGV4aXN0cykuICovXG5mdW5jdGlvbiBkcm9wRnJvbVJ1bihzY2VuZUlkOiBzdHJpbmcpOiB2b2lkIHtcbiAgc3RhdGUuY2hhbXBpb25EZWZlYXRlZCA9IHN0YXRlLmNoYW1waW9uRGVmZWF0ZWQuZmlsdGVyKChpZCkgPT4gaWQgIT09IHNjZW5lSWQpO1xuICBjb25zdCBydW4gPSBzdGF0ZS5wbGFjZW1lbnQ7XG4gIGlmICghcnVuKSByZXR1cm47XG4gIGlmIChydW4uYWJvdmVJZCA9PT0gc2NlbmVJZCkgcnVuLmFib3ZlSWQgPSBudWxsO1xuICBpZiAocnVuLmJlbG93SWQgPT09IHNjZW5lSWQpIHJ1bi5iZWxvd0lkID0gbnVsbDtcbiAgaWYgKHJ1bi5sYXN0T3Bwb25lbnRJZCA9PT0gc2NlbmVJZCkge1xuICAgIHJ1bi5sYXN0T3Bwb25lbnRJZCA9IG51bGw7XG4gICAgcnVuLmdhbGxvcGluZyA9IGZhbHNlO1xuICB9XG59XG5cbi8qKlxuICogQSBzY2VuZSBpbiBwbGF5IG5vIGxvbmdlciBleGlzdHMuIElmIGl0IHdhcyB0aGUgc2NlbmUgYmVpbmcgcmF0ZWQvcGxhY2VkL2NsaW1iaW5nLCBzdGFydCBvdmVyO1xuICogb3RoZXJ3aXNlIGtlZXAgdGhlIG90aGVyIHNjZW5lIGFuZCBmaW5kIGl0IGEgbmV3IG9wcG9uZW50LlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlU2NlbmVHb25lKHNjZW5lSWQ6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBhd2FpdCByZW1vdmVTY2VuZUV2ZXJ5d2hlcmUoc2NlbmVJZCk7XG5cbiAgY29uc3QgeyBsZWZ0LCByaWdodCB9ID0gc3RhdGUuY3VycmVudFBhaXI7XG4gIGNvbnN0IHJ1blNjZW5lSWRzID0gW2xlZnQ/LmlkLCBzdGF0ZS5wbGFjZW1lbnQ/LnNjZW5lLmlkLCBzdGF0ZS5jaGFtcGlvblNjZW5lPy5pZF07XG5cbiAgaWYgKHJ1blNjZW5lSWRzLmluY2x1ZGVzKHNjZW5lSWQpKSB7XG4gICAgcmVzZXRSdW5TdGF0ZSgpO1xuICAgIHNhdmVTdGF0ZSgpO1xuICAgIGF3YWl0IGxvYWROZXdQYWlyKCk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgZHJvcEZyb21SdW4oc2NlbmVJZCk7XG4gIHNhdmVTdGF0ZSgpO1xuICAvLyBGb3JjZWQgbGVmdCBvbmx5IGFwcGxpZXMgd2hlbiBubyBydW4gaXMgdW5kZXIgd2F5IChTd2lzcywgb3IgYmVmb3JlIGEgQ2hhbXBpb24gcnVuIHN0YXJ0cylcbiAgY29uc3Qga2VlcElkID0gcmlnaHQ/LmlkID09PSBzY2VuZUlkID8gbGVmdD8uaWQgOiBudWxsO1xuICBhd2FpdCBsb2FkTmV3UGFpcihrZWVwSWQgPz8gbnVsbCk7XG59XG5cbi8qKiBDbGVhbiBtb2RlOiBTdGFzaCdzIG93biBkZWxldGUgZGlhbG9nIGRvZXMgdGhlIGRlbGV0aW5nOyB0aGVuIGNvbnRpbnVlIHRoZSBiYXR0bGUgd2l0aG91dCBpdC4gKi9cbmFzeW5jIGZ1bmN0aW9uIGRlbGV0ZUZyb21CYXR0bGUoc2NlbmU6IFNjZW5lKTogUHJvbWlzZTx2b2lkPiB7XG4gIGlmIChzdGF0ZS5kaXNhYmxlQ2hvaWNlKSByZXR1cm47XG4gIGNvbnN0IGRlbGV0ZWQgPSBhd2FpdCBjb25maXJtRGVsZXRlU2NlbmUoc2NlbmUpO1xuICBpZiAoIWRlbGV0ZWQpIHJldHVybjtcblxuICBzdGF0ZS5kaXNhYmxlQ2hvaWNlID0gdHJ1ZTtcbiAgYXdhaXQgaGFuZGxlU2NlbmVHb25lKHNjZW5lLmlkKTtcbn1cblxuLyoqIEVMTyB1c2VkIGluIGJhdHRsZSBtYXRoOiB1bnJhdGVkIHNjZW5lcyBjb3VudCBhcyBFTE9fU1RBUlQgKDE1MDApIGluIFN3aXNzLCBDSEFNUElPTl9VTlJBVEVEX0VMTyBpbiBDaGFtcGlvbi4gKi9cbmZ1bmN0aW9uIGJhdHRsZUVsbyhzY2VuZTogU2NlbmUpOiBudW1iZXIge1xuICByZXR1cm4gc3RhdGUuY3VycmVudE1vZGUgPT09IFwiY2hhbXBpb25cIiA/IGVmZmVjdGl2ZUVsbyhzY2VuZSwgQ0hBTVBJT05fVU5SQVRFRF9FTE8pIDogZWZmZWN0aXZlRWxvKHNjZW5lKTtcbn1cblxuaW50ZXJmYWNlIEVsb0NoYW5nZSB7XG4gIGZyb206IG51bWJlcjtcbiAgdG86IG51bWJlcjtcbn1cblxuLyoqXG4gKiBUd28tc2lkZWQgRUxPIGZvciBhIHBpY2sgKFN3aXNzIGFuZCBDaGFtcGlvbik6IGJvdGggc2NlbmVzJyBFTE8gYW5kIGJhdHRsZXMgY2hhbmdlIGFuZCBhcmVcbiAqIHNhdmVkLiBgdXBzZXRgIGlzIHRydWUgd2hlbiB0aGUgd2lubmVyIHdhcyBhIHJlYWwgdW5kZXJkb2cgKHNlZSBVUFNFVF9NQVhfQ0hBTkNFKS5cbiAqL1xuZnVuY3Rpb24gcmVzb2x2ZUNvbXBhcmlzb24od2lubmVyOiBTY2VuZSwgbG9zZXI6IFNjZW5lKTogeyB3aW5uZXI6IEVsb0NoYW5nZTsgbG9zZXI6IEVsb0NoYW5nZTsgdXBzZXQ6IGJvb2xlYW4gfSB7XG4gIC8vIFRoZSBtYXRoIHJlYWRzIHRoZSBjYWNoZWQgY29waWVzOiB0aGUgcGFpcidzIG93biBvYmplY3RzIG1heSBwcmVkYXRlIGEgYmFja2dyb3VuZCByZWZyZXNoXG4gIGNvbnN0IGxhdGVzdFdpbm5lciA9IGxhdGVzdFNjZW5lKHdpbm5lcik7XG4gIGNvbnN0IGxhdGVzdExvc2VyID0gbGF0ZXN0U2NlbmUobG9zZXIpO1xuICBjb25zdCB3aW5uZXJTaWRlID0geyBlbG86IGJhdHRsZUVsbyhsYXRlc3RXaW5uZXIpLCBrR2FtZXM6IGtHYW1lcyhsYXRlc3RXaW5uZXIpIH07XG4gIGNvbnN0IGxvc2VyU2lkZSA9IHsgZWxvOiBiYXR0bGVFbG8obGF0ZXN0TG9zZXIpLCBrR2FtZXM6IGtHYW1lcyhsYXRlc3RMb3NlcikgfTtcbiAgY29uc3QgcmVzdWx0ID0gZWxvUmVzdWx0KHdpbm5lclNpZGUsIGxvc2VyU2lkZSk7XG5cbiAgdm9pZCB3cml0ZUVsbyh3aW5uZXIsIHJlc3VsdC53aW5uZXIsIGJhdHRsZXMobGF0ZXN0V2lubmVyKSArIDEpO1xuICB2b2lkIHdyaXRlRWxvKGxvc2VyLCByZXN1bHQubG9zZXIsIGJhdHRsZXMobGF0ZXN0TG9zZXIpICsgMSk7XG5cbiAgcmV0dXJuIHtcbiAgICB3aW5uZXI6IHsgZnJvbTogd2lubmVyU2lkZS5lbG8sIHRvOiByZXN1bHQud2lubmVyIH0sXG4gICAgbG9zZXI6IHsgZnJvbTogbG9zZXJTaWRlLmVsbywgdG86IHJlc3VsdC5sb3NlciB9LFxuICAgIHVwc2V0OiB3aW5DaGFuY2VzKHdpbm5lclNpZGUuZWxvLCBsb3NlclNpZGUuZWxvKVswXSA8PSBVUFNFVF9NQVhfQ0hBTkNFLFxuICB9O1xufVxuXG4vKiogU2hvdyB3aGVuIENoYW1waW9uICsgZmlsdGVyIG9wcG9uZW50cyArIHNtYWxsIGZpbHRlcmVkIHBvb2wuICovXG5leHBvcnQgZnVuY3Rpb24gdXBkYXRlQ2xpbWJQb29sV2FybmluZygpOiB2b2lkIHtcbiAgY29uc3Qgd2FybmluZyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic2ItY2xpbWItcG9vbC13YXJuaW5nXCIpO1xuICBpZiAoIXdhcm5pbmcpIHJldHVybjtcblxuICBjb25zdCBpc0NsaW1iID0gc3RhdGUuY3VycmVudE1vZGUgPT09IFwiY2hhbXBpb25cIjtcbiAgY29uc3QgZmlsdGVycyA9IHJlYWRGaWx0ZXJzKCk7XG4gIGNvbnN0IHNtYWxsUG9vbCA9XG4gICAgc3RhdGUudG90YWxTY2VuZXNDb3VudCA+IDAgJiYgc3RhdGUudG90YWxTY2VuZXNDb3VudCA8IENMSU1CX1NNQUxMX1BPT0xfV0FSTl9BVDtcblxuICB3YXJuaW5nLmhpZGRlbiA9ICEoXG4gICAgaXNDbGltYiAmJlxuICAgIHN0YXRlLnNldHRpbmdzLmZpbHRlck9wcG9uZW50cyAmJlxuICAgIGZpbHRlcnMuZmlsdGVyQWN0aXZlICYmXG4gICAgc21hbGxQb29sXG4gICk7XG59XG5cbi8qKiBQbGFjZW1lbnQ6IHJlY29yZCB0aGUgcmVzdWx0OyB0aGUgbmV4dCBwYWlyIChvciB0aGUgZmluYWwgcGxhY2VtZW50KSBjb21lcyBmcm9tIHRoZSBmZXRjaC4gKi9cbmZ1bmN0aW9uIGhhbmRsZVBsYWNlbWVudENob2ljZShjaG9pY2U6IFNjZW5lQ2hvaWNlKTogdm9pZCB7XG4gIGNvbnN0IHJ1biA9IHN0YXRlLnBsYWNlbWVudDtcbiAgaWYgKCFydW4pIHtcbiAgICBzdGF0ZS5kaXNhYmxlQ2hvaWNlID0gZmFsc2U7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3Qgd29uID0gY2hvaWNlLndpbm5lci5pZCA9PT0gcnVuLnNjZW5lLmlkO1xuICByZWNvcmRQbGFjZW1lbnRSZXN1bHQocnVuLCB3b24sIHdvbiA/IGNob2ljZS5sb3Nlci5pZCA6IGNob2ljZS53aW5uZXIuaWQpO1xuICBzYXZlU3RhdGUoKTtcblxuICBjaG9pY2Uud2lubmVyQ2FyZC5jbGFzc0xpc3QuYWRkKFwic2Itd2lubmVyXCIpO1xuICBjaG9pY2UubG9zZXJDYXJkLmNsYXNzTGlzdC5hZGQoXCJzYi1sb3NlclwiKTtcbiAgc2V0VGltZW91dCgoKSA9PiBsb2FkTmV3UGFpcigpLCA2MDApO1xufVxuXG4vKiogQ2hhbXBpb246IHR3by1zaWRlZCBFTE8gZXZlcnkgcGljazsgdGhlIHdpbm5lciBkZWZlbmRzIG5leHQgKGEgbmV3IHdpbm5lciB0YWtlcyBvdmVyKS4gKi9cbmZ1bmN0aW9uIGhhbmRsZUNoYW1waW9uQ2hvaWNlKGNob2ljZTogU2NlbmVDaG9pY2UpOiB2b2lkIHtcbiAgY29uc3QgeyB3aW5uZXI6IHdpbm5lclNjZW5lLCBsb3NlcjogbG9zZXJTY2VuZSwgbGVmdCwgd2lubmVyQ2FyZCwgbG9zZXJDYXJkIH0gPSBjaG9pY2U7XG5cbiAgaWYgKCFzdGF0ZS5jaGFtcGlvblNjZW5lKSBzdGF0ZS5jaGFtcGlvblNjZW5lID0gbGVmdDtcbiAgY29uc3QgY2hhbmdlID0gcmVzb2x2ZUNvbXBhcmlzb24od2lubmVyU2NlbmUsIGxvc2VyU2NlbmUpO1xuXG4gIGlmICh3aW5uZXJTY2VuZS5pZCA9PT0gc3RhdGUuY2hhbXBpb25TY2VuZS5pZCkge1xuICAgIHN0YXRlLmNoYW1waW9uRGVmZWF0ZWQucHVzaChsb3NlclNjZW5lLmlkKTtcbiAgICBzdGF0ZS5jaGFtcGlvbldpbnMrKztcbiAgfSBlbHNlIHtcbiAgICBzdGF0ZS5jaGFtcGlvblNjZW5lID0gd2lubmVyU2NlbmU7XG4gICAgc3RhdGUuY2hhbXBpb25EZWZlYXRlZCA9IFtsb3NlclNjZW5lLmlkXTtcbiAgICBzdGF0ZS5jaGFtcGlvbldpbnMgPSAxO1xuICB9XG5cbiAgc2F2ZVN0YXRlKCk7XG5cbiAgc2hvd1BpY2tSZXN1bHQod2lubmVyQ2FyZCwgbG9zZXJDYXJkLCBjaGFuZ2UpO1xufVxuXG4vKiogV2lubmVyL2xvc2VyIGNhcmQgc3R5bGVzIGFuZCBib3RoIEVMTyBhbmltYXRpb25zLCB0aGVuIHRoZSBuZXh0IHBhaXIuICovXG5mdW5jdGlvbiBzaG93UGlja1Jlc3VsdChcbiAgd2lubmVyQ2FyZDogSFRNTEVsZW1lbnQsXG4gIGxvc2VyQ2FyZDogSFRNTEVsZW1lbnQsXG4gIGNoYW5nZTogeyB3aW5uZXI6IEVsb0NoYW5nZTsgbG9zZXI6IEVsb0NoYW5nZTsgdXBzZXQ6IGJvb2xlYW4gfSxcbik6IHZvaWQge1xuICB3aW5uZXJDYXJkLmNsYXNzTGlzdC5hZGQoXCJzYi13aW5uZXJcIik7XG4gIGxvc2VyQ2FyZC5jbGFzc0xpc3QuYWRkKFwic2ItbG9zZXJcIik7XG4gIHNob3dSYXRpbmdBbmltYXRpb24od2lubmVyQ2FyZCwgY2hhbmdlLndpbm5lci5mcm9tLCBjaGFuZ2Uud2lubmVyLnRvLCB0cnVlLCBjaGFuZ2UudXBzZXQpO1xuICBzaG93UmF0aW5nQW5pbWF0aW9uKGxvc2VyQ2FyZCwgY2hhbmdlLmxvc2VyLmZyb20sIGNoYW5nZS5sb3Nlci50bywgZmFsc2UpO1xuICBzY2hlZHVsZU5leHRQYWlyQWZ0ZXJBbmltYXRpb25zKCk7XG59XG5cbmZ1bmN0aW9uIGhhbmRsZVNjZW5lQ2hvaWNlKGNob2ljZTogU2NlbmVDaG9pY2UpOiB2b2lkIHtcbiAgaWYgKHN0YXRlLmRpc2FibGVDaG9pY2UpIHJldHVybjtcbiAgc3RhdGUuZGlzYWJsZUNob2ljZSA9IHRydWU7XG5cbiAgY29uc3QgeyB3aW5uZXI6IHdpbm5lclNjZW5lLCBsb3NlcjogbG9zZXJTY2VuZSwgd2lubmVyQ2FyZCwgbG9zZXJDYXJkIH0gPSBjaG9pY2U7XG5cbiAgaWYgKHN0YXRlLmN1cnJlbnRNb2RlID09PSBcInBsYWNlbWVudFwiKSB7XG4gICAgaGFuZGxlUGxhY2VtZW50Q2hvaWNlKGNob2ljZSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKHN0YXRlLmN1cnJlbnRNb2RlID09PSBcImNoYW1waW9uXCIpIHtcbiAgICBoYW5kbGVDaGFtcGlvbkNob2ljZShjaG9pY2UpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFN3aXNzOiBib3RoIHNjZW5lcycgRUxPIGNoYW5nZXMgKGJvdGggc3RheSBpbiB0aGUgcG9vbClcbiAgY29uc3QgY2hhbmdlID0gcmVzb2x2ZUNvbXBhcmlzb24od2lubmVyU2NlbmUsIGxvc2VyU2NlbmUpO1xuXG4gIHNhdmVTdGF0ZSgpO1xuXG4gIHNob3dQaWNrUmVzdWx0KHdpbm5lckNhcmQsIGxvc2VyQ2FyZCwgY2hhbmdlKTtcbn1cblxuY29uc3QgUkFUSU5HX0FOSU1fTUFYX1RPVEFMX01TID0gMTQwMDtcbmNvbnN0IFJBVElOR19BTklNX0hPTERfTVMgPSAzMDA7XG5jb25zdCBSQVRJTkdfQU5JTV9DT1VOVF9CVURHRVRfTVMgPSBSQVRJTkdfQU5JTV9NQVhfVE9UQUxfTVMgLSBSQVRJTkdfQU5JTV9IT0xEX01TO1xuY29uc3QgUkFUSU5HX0FOSU1fREVGQVVMVF9TVEVQX01TID0gNTA7XG5jb25zdCBSQVRJTkdfQU5JTV9NSU5fU1RFUF9NUyA9IDg7XG5cbmZ1bmN0aW9uIHNjaGVkdWxlTmV4dFBhaXJBZnRlckFuaW1hdGlvbnMoKTogdm9pZCB7XG4gIHNldFRpbWVvdXQoKCkgPT4gbG9hZE5ld1BhaXIoKSwgMTUwMCk7XG59XG5cbi8qKlxuICogRUxPIGNvdW50LXVwL2Rvd24gb3ZlcmxheSAod2hvbGUgbnVtYmVycyk7IGxhcmdlIGp1bXBzIHNwZWVkIHVwIHNvIHRoZSBjb3VudCBmaXRzIHdpdGhpbiAxNDAwbXMuXG4gKiBgdXBzZXRgIGFkZHMgYSBzbWFsbCBcIlVwc2V0IVwiIHVuZGVyIHRoZSBjaGFuZ2UuXG4gKi9cbmZ1bmN0aW9uIHNob3dSYXRpbmdBbmltYXRpb24oXG4gIGNhcmQ6IEhUTUxFbGVtZW50LFxuICBvbGRFbG86IG51bWJlcixcbiAgbmV3RWxvOiBudW1iZXIsXG4gIGlzV2lubmVyOiBib29sZWFuLFxuICB1cHNldCA9IGZhbHNlLFxuKTogdm9pZCB7XG4gIGNvbnN0IG9sZFJhdGluZyA9IE1hdGgucm91bmQob2xkRWxvKTtcbiAgY29uc3QgbmV3UmF0aW5nID0gTWF0aC5yb3VuZChuZXdFbG8pO1xuICBjb25zdCBjaGFuZ2UgPSBuZXdSYXRpbmcgLSBvbGRSYXRpbmc7XG4gIC8vIENyZWF0ZSBvdmVybGF5XG4gIGNvbnN0IG92ZXJsYXkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBvdmVybGF5LmNsYXNzTmFtZSA9IGBzYi1yYXRpbmctb3ZlcmxheSAke2lzV2lubmVyID8gXCJzYi1yYXRpbmctd2lubmVyXCIgOiBcInNiLXJhdGluZy1sb3NlclwifWA7XG5cbiAgY29uc3QgcmF0aW5nRGlzcGxheSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIHJhdGluZ0Rpc3BsYXkuY2xhc3NOYW1lID0gXCJzYi1yYXRpbmctZGlzcGxheVwiO1xuICByYXRpbmdEaXNwbGF5LnRleHRDb250ZW50ID0gU3RyaW5nKG9sZFJhdGluZyk7XG5cbiAgY29uc3QgY2hhbmdlRGlzcGxheSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIGNoYW5nZURpc3BsYXkuY2xhc3NOYW1lID0gXCJzYi1yYXRpbmctY2hhbmdlXCI7XG4gIGNoYW5nZURpc3BsYXkudGV4dENvbnRlbnQgPSBjaGFuZ2UgPiAwID8gYCske2NoYW5nZX1gIDogU3RyaW5nKGNoYW5nZSk7XG5cbiAgb3ZlcmxheS5hcHBlbmRDaGlsZChyYXRpbmdEaXNwbGF5KTtcbiAgb3ZlcmxheS5hcHBlbmRDaGlsZChjaGFuZ2VEaXNwbGF5KTtcbiAgaWYgKHVwc2V0KSB7XG4gICAgY29uc3QgdXBzZXREaXNwbGF5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICB1cHNldERpc3BsYXkuY2xhc3NOYW1lID0gXCJzYi1yYXRpbmctdXBzZXRcIjtcbiAgICB1cHNldERpc3BsYXkudGV4dENvbnRlbnQgPSBcIlVwc2V0IVwiO1xuICAgIG92ZXJsYXkuYXBwZW5kQ2hpbGQodXBzZXREaXNwbGF5KTtcbiAgfVxuICBjYXJkLmFwcGVuZENoaWxkKG92ZXJsYXkpO1xuXG4gIGNvbnN0IHRvdGFsU3RlcHMgPSBNYXRoLmFicyhjaGFuZ2UpO1xuICBpZiAodG90YWxTdGVwcyA9PT0gMCkge1xuICAgIHJhdGluZ0Rpc3BsYXkudGV4dENvbnRlbnQgPSBTdHJpbmcobmV3UmF0aW5nKTtcbiAgICBzZXRUaW1lb3V0KCgpID0+IG92ZXJsYXkucmVtb3ZlKCksIFJBVElOR19BTklNX01BWF9UT1RBTF9NUyk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3Qgc3RlcE1zID0gTWF0aC5taW4oXG4gICAgUkFUSU5HX0FOSU1fREVGQVVMVF9TVEVQX01TLFxuICAgIE1hdGgubWF4KFJBVElOR19BTklNX01JTl9TVEVQX01TLCBNYXRoLnJvdW5kKFJBVElOR19BTklNX0NPVU5UX0JVREdFVF9NUyAvIHRvdGFsU3RlcHMpKSxcbiAgKTtcblxuICBsZXQgY3VycmVudERpc3BsYXkgPSBvbGRSYXRpbmc7XG4gIGNvbnN0IHN0ZXAgPSBjaGFuZ2UgPiAwID8gMSA6IC0xO1xuICBsZXQgc3RlcENvdW50ID0gMDtcblxuICBjb25zdCBpbnRlcnZhbCA9IHNldEludGVydmFsKCgpID0+IHtcbiAgICBzdGVwQ291bnQrKztcbiAgICBjdXJyZW50RGlzcGxheSArPSBzdGVwO1xuICAgIHJhdGluZ0Rpc3BsYXkudGV4dENvbnRlbnQgPSBTdHJpbmcoY3VycmVudERpc3BsYXkpO1xuXG4gICAgaWYgKHN0ZXBDb3VudCA+PSB0b3RhbFN0ZXBzKSB7XG4gICAgICBjbGVhckludGVydmFsKGludGVydmFsKTtcbiAgICAgIHJhdGluZ0Rpc3BsYXkudGV4dENvbnRlbnQgPSBTdHJpbmcobmV3UmF0aW5nKTtcbiAgICB9XG4gIH0sIHN0ZXBNcyk7XG5cbiAgc2V0VGltZW91dCgoKSA9PiBvdmVybGF5LnJlbW92ZSgpLCBSQVRJTkdfQU5JTV9NQVhfVE9UQUxfTVMpO1xufVxuIiwgIi8vIFNoYXJlZCBpY29ucy5cblxuLyoqIFRoZSBjcm9zc2VkIHN3b3JkcyAoMzZ4MzYsIGZpbGxlZCB3aXRoIGN1cnJlbnRDb2xvcik6IHRoZSBuYXZiYXIgYnV0dG9uIGFuZCB0aGUgc2NlbmUgcGFnZSdzIEVMTy4gKi9cbmV4cG9ydCBjb25zdCBTV09SRFNfUEFUSFMgPSBgXG4gIDxwYXRoIGZpbGw9XCJjdXJyZW50Q29sb3JcIiBkPVwibTI0IDI5IDUtNUw2IDFIMXY1elwiLz5cbiAgPHBhdGggZmlsbD1cImN1cnJlbnRDb2xvclwiIGQ9XCJNMSAxdjVsMjMgMjMgMi41LTIuNXpcIi8+XG4gIDxwYXRoIGZpbGw9XCJjdXJyZW50Q29sb3JcIiBkPVwiTTMzLjQyNCAzMi44MDhjLjI4NC0uMjg0LjQ1OC0uNjI2LjUzMS0uOTY4bC01LjI0Mi02LjE5NS0uNy0uNzAyYy0uNTY1LS41NjQtMS41Ny0uNDczLTIuMjQ5LjIwNWwtLjYxNC42MTJjLS42NzcuNjc3LS43NjggMS42ODMtLjIwNCAyLjI0N2wuNzQxLjc0MSA2LjE1IDUuMjA1Yy4zNDUtLjA3Mi42ODgtLjI0Ny45NzQtLjUzMnpcIi8+XG4gIDxwYXRoIGZpbGw9XCJjdXJyZW50Q29sb3JcIiBkPVwiTTMzLjQyNCAzMi44MDhjLjI4NC0uMjg0LjQ1OC0uNjI2LjUzMS0uOTY4bC0xLjM0Mi0xLjU4Ni0uNzM3IDMuNjg0Yy4zMzEtLjA3Ny42NjEtLjI0My45MzUtLjUxOHptLTMuMzEtNS41MDYtLjg4OCA0LjQ0IDEuMjYgMS4wNjcuODItNC4xem0tMS40LTEuNjU3LS43MDItLjcwMmExLjIgMS4yIDAgMCAwLS4zMjYtLjIyNGwtLjk3OCA0Ljg5MiAxLjI2IDEuMDY2Ljk1Ny00Ljc4M3ptLTIuNDAyLS44ODhhMiAyIDAgMCAwLS41NDguMzkybC0uNjE0LjYxYTIgMiAwIDAgMC0uNTEuODZjLS4xNDMuNTEtLjA0NyAxLjAzNi4zMDYgMS4zODhsLjU5Ni41OTZ6bTAgMHEwLS4wMDMgMCAwXCIvPlxuICA8cGF0aCBmaWxsPVwiY3VycmVudENvbG9yXCIgZD1cIk0zMy4yNSAzNmEyLjc1IDIuNzUgMCAxIDAgMC01LjUgMi43NSAyLjc1IDAgMCAwIDAgNS41TTI5LjYyNiAyMi4zMjRhMS4wMzQgMS4wMzQgMCAwIDEgMCAxLjQ2MmwtNi4wOTIgNi4wOTJhMS4wMzIgMS4wMzIgMCAwIDEtMS42ODYtLjMzNiAxLjAzIDEuMDMgMCAwIDEgLjIyNC0xLjEyNmw2LjA5Mi02LjA5MmExLjAzMyAxLjAzMyAwIDAgMSAxLjQ2MiAwXCIvPlxuICA8cGF0aCBmaWxsPVwiY3VycmVudENvbG9yXCIgZD1cIk0yMi4wNzIgMzEuNjI3YTEuNzUgMS43NSAwIDEgMCAwLTMuNSAxLjc1IDEuNzUgMCAwIDAgMCAzLjVNMjkuNjI2IDI0LjA3M2ExLjc1IDEuNzUgMCAxIDAgMC0zLjUgMS43NSAxLjc1IDAgMCAwIDAgMy41XCIvPlxuICA8cGF0aCBmaWxsPVwiY3VycmVudENvbG9yXCIgZD1cIk0yMi4wNzIgMzAuODc3YTEgMSAwIDEgMCAwLTIgMSAxIDAgMCAwIDAgMk0yOS42MjYgMjMuMzIzYTEgMSAwIDEgMCAwLTIgMSAxIDAgMCAwIDAgMk0zMy45MDMgMjkuMzQyYS43Ni43NiAwIDAgMSAwIDEuMDc4bC0zLjQ3NiAzLjQ3NWEuNzYyLjc2MiAwIDAgMS0xLjA3OC0xLjA3OGwzLjQ3Ni0zLjQ3NWEuNzYuNzYgMCAwIDEgMS4wNzggME0xMiAyOWwtNS01TDMwIDFoNXY1elwiLz5cbiAgPHBhdGggZmlsbD1cImN1cnJlbnRDb2xvclwiIGQ9XCJNMzUgMXY1TDEyIDI5bC0yLjUtMi41elwiLz5cbiAgPHBhdGggZmlsbD1cImN1cnJlbnRDb2xvclwiIGQ9XCJNMi41NzYgMzIuODA4YTEuOTUgMS45NSAwIDAgMS0uNTMxLS45NjhsNS4yNDItNi4xOTUuNy0uNzAyYy41NjUtLjU2NCAxLjU3LS40NzMgMi4yNDkuMjA1bC42MTMuNjEyYy42NzcuNjc3Ljc2OCAxLjY4My4yMDQgMi4yNDdsLS43NDEuNzQxLTYuMTUgNS4yMDVhMS45NSAxLjk1IDAgMCAxLS45NzQtLjUzMnpcIi8+XG4gIDxwYXRoIGZpbGw9XCJjdXJyZW50Q29sb3JcIiBkPVwiTTIuNTc2IDMyLjgwOGExLjk1IDEuOTUgMCAwIDEtLjUzMS0uOTY4bDEuMzQyLTEuNTg2LjczNyAzLjY4NGExLjkzIDEuOTMgMCAwIDEtLjkzNS0uNTE4em0zLjMxLTUuNTA2Ljg4OCA0LjQ0LTEuMjYgMS4wNjctLjgyLTQuMXptMS40LTEuNjU3LjcwMi0uNzAyYTEuMiAxLjIgMCAwIDEgLjMyNi0uMjI0bC45NzggNC44OTItMS4yNiAxLjA2Ni0uOTU3LTQuNzgzem0yLjQwMi0uODg4Yy4xOTUuMDk1LjM4Mi4yMjUuNTQ4LjM5MmwuNjEzLjYxMmMuMjU0LjI1NC40MjUuNTU0LjUxLjg2LjE0My41MS4wNDcgMS4wMzUtLjMwNiAxLjM4N2wtLjU5Ni41OTZ6bTAgMHEwLS4wMDMgMCAwXCIvPlxuICA8cGF0aCBmaWxsPVwiY3VycmVudENvbG9yXCIgZD1cIk0yLjc1IDM2YTIuNzUgMi43NSAwIDEgMCAwLTUuNSAyLjc1IDIuNzUgMCAwIDAgMCA1LjVNNi4zNzQgMjIuMzI0YTEuMDM0IDEuMDM0IDAgMCAwIDAgMS40NjJsNi4wOTIgNi4wOTJhMS4wMzMgMS4wMzMgMCAxIDAgMS40NjItMS40NjJsLTYuMDkyLTYuMDkyYTEuMDMzIDEuMDMzIDAgMCAwLTEuNDYyIDBcIi8+XG4gIDxwYXRoIGZpbGw9XCJjdXJyZW50Q29sb3JcIiBkPVwiTTEzLjkyOCAzMS42MjdhMS43NSAxLjc1IDAgMSAwIDAtMy41IDEuNzUgMS43NSAwIDAgMCAwIDMuNU02LjM3NCAyNC4wNzNhMS43NSAxLjc1IDAgMSAwIDAtMy41IDEuNzUgMS43NSAwIDAgMCAwIDMuNVwiLz5cbiAgPHBhdGggZmlsbD1cImN1cnJlbnRDb2xvclwiIGQ9XCJNMTMuOTI4IDMwLjg3N2ExIDEgMCAxIDAgMC0yIDEgMSAwIDAgMCAwIDJNNi4zNzQgMjMuMzIzYTEgMSAwIDEgMCAwLTIgMSAxIDAgMCAwIDAgMk0yLjA5NyAyOS4zNDJhLjc2Ljc2IDAgMCAwIDAgMS4wNzhsMy40NzYgMy40NzVhLjc2My43NjMgMCAwIDAgMS4wNzgtMS4wNzhsLTMuNDc2LTMuNDc1YS43Ni43NiAwIDAgMC0xLjA3OCAwXCIvPlxuYDtcbiIsICIvLyBUaGUgc2NlbmUncyBFTE8gYW5kIHJhbmsgb24gU3Rhc2gncyBvd24gc2NlbmUgcGFnZSwgYXMgb25lIG1vcmUgaXRlbSBpbiB0aGUgdG9vbGJhciBuZXh0IHRvXG4vLyBQbGF5IENvdW50IGFuZCBPIENvdW50OiBhIHNpbmdsZSBTdGFzaCBcIm1pbmltYWxcIiBidXR0b24gKGljb24gYW5kIHRleHQgaGlnaGxpZ2h0IHRvZ2V0aGVyKS5cbi8vXG4vLyBTdGFzaCdzIFNjZW5lUGFnZSBpc24ndCBhIHBhdGNoYWJsZSBjb21wb25lbnQsIHNvIHRoZSBpdGVtIGlzIGFkZGVkIHRvIHRoZSBET00gYW5kIHJlLWFkZGVkXG4vLyB3aGVuZXZlciBSZWFjdCByZS1yZW5kZXJzIHRoZSB0b29sYmFyLiBUaGUgcmFuayBjb21lcyBmcm9tIFN0YXNoIEJhdHRsZSdzIGFsbC1zY2VuZXMgY2FjaGUsIHRoZVxuLy8gc2FtZSBwbGFjZSB0aGUgYmF0dGxlIGNhcmRzIGdldCB0aGVpcnMgKFN0YXNoIGNhbid0IGNvdW50IHNjZW5lcyBieSBhIG51bWVyaWMgY3VzdG9tIGZpZWxkKS5cblxuaW1wb3J0IHsgZ2V0QWxsU2NlbmVzQ2FjaGVkIH0gZnJvbSBcIi4uL2NhY2hlXCI7XG5pbXBvcnQgeyBmZXRjaFNjZW5lQnlJZCwgZ2V0U2NlbmVJZEZyb21VcmwsIHNjZW5lQ3VzdG9tRmllbGRzU3VwcG9ydGVkIH0gZnJvbSBcIi4uL2dyYXBocWxcIjtcbmltcG9ydCB7IGVsbywgaXNQcm92aXNpb25hbCwgaXNSYXRlZCB9IGZyb20gXCIuLi9zY29yZVwiO1xuaW1wb3J0IHsgbG9hZFNldHRpbmdzIH0gZnJvbSBcIi4uL3NldHRpbmdzXCI7XG5pbXBvcnQgeyBzdGF0ZSB9IGZyb20gXCIuLi9zdGF0ZVwiO1xuaW1wb3J0IHsgdGllckRlc2NyaXB0aW9uLCB0aWVyTWFwIH0gZnJvbSBcIi4uL3N0YXRzXCI7XG5pbXBvcnQgdHlwZSB7IFNjZW5lLCBUaWVyIH0gZnJvbSBcIi4uL3R5cGVzXCI7XG5pbXBvcnQgeyBTV09SRFNfUEFUSFMgfSBmcm9tIFwiLi9pY29uc1wiO1xuaW1wb3J0IHsgUFJPVklTSU9OQUxfVElQIH0gZnJvbSBcIi4vc2NlbmVDYXJkXCI7XG5cbmNvbnN0IElURU1fQ0xBU1MgPSBcInNiLXNjZW5lLWVsb1wiO1xuY29uc3QgVElUTEUgPSBcIlN0YXNoIEJhdHRsZSBFTE8sIGFuZCByYW5rIGluIHlvdXIgbGlicmFyeS4gQ2xpY2sgdG8gYmF0dGxlIHRoaXMgc2NlbmUuXCI7XG5cbi8qKiBcIkVMTyAxNzQwIMK3ICM1MFwiIChhIFwiP1wiIGFmdGVyIGEgcHJvdmlzaW9uYWwgRUxPKSwgb3IgXCJFTE8gwrcgVW5yYXRlZFwiIGZvciBhIHNjZW5lIHdpdGggbm8gRUxPIHlldC4gKi9cbmZ1bmN0aW9uIGxhYmVsVGV4dChzY2VuZTogU2NlbmUsIHJhbms6IG51bWJlciB8IG51bGwpOiBzdHJpbmcge1xuICBjb25zdCB2YWx1ZSA9IGVsbyhzY2VuZSk7XG4gIGlmICh2YWx1ZSA9PT0gbnVsbCkgcmV0dXJuIFwiRUxPIMK3IFVucmF0ZWRcIjtcbiAgcmV0dXJuIGBFTE8gJHtNYXRoLnJvdW5kKHZhbHVlKX0ke2lzUHJvdmlzaW9uYWwoc2NlbmUpID8gXCI/XCIgOiBcIlwifSR7cmFuayAhPT0gbnVsbCA/IGAgwrcgIyR7cmFua31gIDogXCJcIn1gO1xufVxuXG4vKiogVGhlIGJ1dHRvbidzIHRvb2x0aXAsIHdpdGggdGhlIHByb3Zpc2lvbmFsIG5vdGUgYW5kIHRoZSB0aWVyICh3aGVuIHRpZXJzIGFyZSBvbikgYWRkZWQuICovXG5mdW5jdGlvbiB0aXRsZVRleHQoc2NlbmU6IFNjZW5lLCB0aWVyOiBUaWVyIHwgbnVsbCk6IHN0cmluZyB7XG4gIGNvbnN0IGxpbmVzID0gW1RJVExFXTtcbiAgaWYgKGlzUHJvdmlzaW9uYWwoc2NlbmUpKSBsaW5lcy5wdXNoKFBST1ZJU0lPTkFMX1RJUCk7XG4gIGlmICh0aWVyICYmIHN0YXRlLnNldHRpbmdzLnNob3dUaWVycykgbGluZXMucHVzaChgJHt0aWVyLmVtb2ppfSAke3RpZXJEZXNjcmlwdGlvbih0aWVyKX1gKTtcbiAgcmV0dXJuIGxpbmVzLmpvaW4oXCJcXG5cIik7XG59XG5cbi8qKlxuICogVGhlIHNjZW5lIChmcm9tIHRoZSBjYWNoZSwgb3IgZmV0Y2hlZCBpZiBpdCdzIG5ld2VyIHRoYW4gdGhlIGNhY2hlKSwgaXRzIHJhbmsgYW1vbmcgcmF0ZWRcbiAqIHNjZW5lcyBhbmQgaXRzIHRpZXIuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHNjZW5lQW5kUmFuayhzY2VuZUlkOiBzdHJpbmcpOiBQcm9taXNlPHsgc2NlbmU6IFNjZW5lOyByYW5rOiBudW1iZXIgfCBudWxsOyB0aWVyOiBUaWVyIHwgbnVsbCB9IHwgbnVsbD4ge1xuICBjb25zdCB7IHNjZW5lcyB9ID0gYXdhaXQgZ2V0QWxsU2NlbmVzQ2FjaGVkKCk7XG4gIC8vIFRoZSBjYWNoZSBpcyBzb3J0ZWQgYnkgRUxPIHdpdGggdW5yYXRlZCBzY2VuZXMgbGFzdCwgc28gYSByYXRlZCBzY2VuZSdzIGluZGV4IGlzIGl0cyByYW5rXG4gIGNvbnN0IGluZGV4ID0gc2NlbmVzLmZpbmRJbmRleCgocykgPT4gcy5pZCA9PT0gc2NlbmVJZCk7XG4gIGlmIChpbmRleCA+PSAwKSB7XG4gICAgY29uc3Qgc2NlbmUgPSBzY2VuZXNbaW5kZXhdO1xuICAgIHJldHVybiB7IHNjZW5lLCByYW5rOiBpc1JhdGVkKHNjZW5lKSA/IGluZGV4ICsgMSA6IG51bGwsIHRpZXI6IHRpZXJNYXAoc2NlbmVzKS5nZXQoc2NlbmVJZCkgPz8gbnVsbCB9O1xuICB9XG4gIGNvbnN0IHNjZW5lID0gYXdhaXQgZmV0Y2hTY2VuZUJ5SWQoc2NlbmVJZCk7XG4gIHJldHVybiBzY2VuZSA/IHsgc2NlbmUsIHJhbms6IG51bGwsIHRpZXI6IG51bGwgfSA6IG51bGw7XG59XG5cbi8qKiBTZXR0aW5ncyBsb2FkIHdpdGggU3Rhc2ggQmF0dGxlOyBvbiBhIHNjZW5lIHBhZ2UgaXQgbWF5IG5vdCBoYXZlIG9wZW5lZCB5ZXQgKG9uY2UgcGVyIHBhZ2UgbG9hZCkuICovXG5sZXQgc2V0dGluZ3NMb2FkOiBQcm9taXNlPGJvb2xlYW4+IHwgbnVsbCA9IG51bGw7XG5cbi8qKiBPcGVucyBTdGFzaCBCYXR0bGUgKG9uIGEgc2NlbmUgcGFnZSwgd2l0aCB0aGlzIHNjZW5lIGluIHRoZSBiYXR0bGUpLiBTZXQgYnkgcmVnaXN0ZXJTY2VuZUVsby4gKi9cbmxldCBvcGVuQmF0dGxlOiAoKSA9PiB2b2lkID0gKCkgPT4ge307XG5cbi8qKiBPbmUgU3Rhc2ggXCJtaW5pbWFsXCIgYnV0dG9uIHdpdGggdGhlIHN3b3JkcyBhbmQgdGhlIEVMTywgc28gaXQgaG92ZXJzIGFzIGEgd2hvbGUuICovXG5mdW5jdGlvbiBjcmVhdGVJdGVtKCk6IEhUTUxFbGVtZW50IHtcbiAgY29uc3QgaXRlbSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJzcGFuXCIpO1xuICBpdGVtLmNsYXNzTmFtZSA9IElURU1fQ0xBU1M7XG4gIGl0ZW0uaW5uZXJIVE1MID0gYFxuICAgICAgPGJ1dHRvbiB0eXBlPVwiYnV0dG9uXCIgY2xhc3M9XCJtaW5pbWFsIGJ0biBidG4tc2Vjb25kYXJ5IHNiLXNjZW5lLWVsby1idXR0b25cIiB0aXRsZT1cIiR7VElUTEV9XCI+XG4gICAgICAgIDxzdmcgY2xhc3M9XCJzdmctaW5saW5lLS1mYSBmYS1pY29uXCIgYXJpYS1oaWRkZW49XCJ0cnVlXCIgZm9jdXNhYmxlPVwiZmFsc2VcIiB2aWV3Qm94PVwiMCAwIDM2IDM2XCIgd2lkdGg9XCIxZW1cIiBoZWlnaHQ9XCIxZW1cIj4ke1NXT1JEU19QQVRIU308L3N2Zz5cbiAgICAgICAgPHNwYW4gY2xhc3M9XCJzYi1zY2VuZS1lbG8tdmFsdWVcIj48L3NwYW4+XG4gICAgICA8L2J1dHRvbj5gO1xuICBpdGVtLnF1ZXJ5U2VsZWN0b3IoXCJidXR0b25cIik/LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiBvcGVuQmF0dGxlKCkpO1xuICByZXR1cm4gaXRlbTtcbn1cblxuLyoqIFRoZSB0b29sYmFyIGdyb3VwIGhvbGRpbmcgUGxheSBDb3VudCBhbmQgTyBDb3VudDsgdGhlIGl0ZW0gZ29lcyBpbiBmcm9udCBvZiBQbGF5IENvdW50LiAqL1xuZnVuY3Rpb24gcGxhY2VJdGVtKHRvb2xiYXI6IEVsZW1lbnQsIGl0ZW06IEhUTUxFbGVtZW50KTogYm9vbGVhbiB7XG4gIGNvbnN0IHBsYXlDb3VudCA9IHRvb2xiYXIucXVlcnlTZWxlY3RvcignYnV0dG9uW3RpdGxlPVwiUGxheSBDb3VudFwiXScpPy5jbG9zZXN0KFwiLnNjZW5lLXRvb2xiYXItZ3JvdXAgPiAqXCIpO1xuICBpZiAocGxheUNvdW50KSB7XG4gICAgcGxheUNvdW50LmJlZm9yZShpdGVtKTtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICBjb25zdCBncm91cCA9IHRvb2xiYXIucXVlcnlTZWxlY3RvcihcIi5zY2VuZS10b29sYmFyLWdyb3VwOmxhc3QtY2hpbGRcIik7XG4gIGlmICghZ3JvdXApIHJldHVybiBmYWxzZTtcbiAgZ3JvdXAucHJlcGVuZChpdGVtKTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbmxldCByZW5kZXJpbmc6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG4vKiogQWRkIChvciB1cGRhdGUpIHRoZSBpdGVtIG9uIHRoZSBjdXJyZW50IHNjZW5lIHBhZ2UuIFNhZmUgdG8gY2FsbCBvZnRlbi4gKi9cbmFzeW5jIGZ1bmN0aW9uIHJlbmRlclNjZW5lRWxvKGZvcmNlID0gZmFsc2UpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3Qgc2NlbmVJZCA9IGdldFNjZW5lSWRGcm9tVXJsKCk7XG4gIGNvbnN0IHRvb2xiYXIgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKFwiLnNjZW5lLXRvb2xiYXJcIik7XG4gIGlmICghc2NlbmVJZCB8fCAhdG9vbGJhcikgcmV0dXJuO1xuICBjb25zdCBleGlzdGluZyA9IHRvb2xiYXIucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oYC4ke0lURU1fQ0xBU1N9YCk7XG4gIGlmICghZm9yY2UgJiYgZXhpc3Rpbmc/LmRhdGFzZXQuc2NlbmVJZCA9PT0gc2NlbmVJZCkgcmV0dXJuO1xuICBpZiAocmVuZGVyaW5nID09PSBzY2VuZUlkKSByZXR1cm47XG5cbiAgcmVuZGVyaW5nID0gc2NlbmVJZDtcbiAgdHJ5IHtcbiAgICBpZiAoIShhd2FpdCBzY2VuZUN1c3RvbUZpZWxkc1N1cHBvcnRlZCgpKSkgcmV0dXJuO1xuICAgIHNldHRpbmdzTG9hZCA/Pz0gbG9hZFNldHRpbmdzKCk7XG4gICAgY29uc3QgW3Jlc3VsdF0gPSBhd2FpdCBQcm9taXNlLmFsbChbc2NlbmVBbmRSYW5rKHNjZW5lSWQpLCBzZXR0aW5nc0xvYWRdKTtcbiAgICAvLyBUaGUgcGFnZSBtYXkgaGF2ZSBtb3ZlZCBvbiAoYW5vdGhlciBzY2VuZSwgb3IgdGhlIHRvb2xiYXIgcmUtcmVuZGVyZWQpIHdoaWxlIHRoaXMgbG9hZGVkXG4gICAgaWYgKCFyZXN1bHQgfHwgZ2V0U2NlbmVJZEZyb21VcmwoKSAhPT0gc2NlbmVJZCkgcmV0dXJuO1xuICAgIGNvbnN0IHRhcmdldCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoXCIuc2NlbmUtdG9vbGJhclwiKTtcbiAgICBpZiAoIXRhcmdldCkgcmV0dXJuO1xuXG4gICAgbGV0IGl0ZW0gPSB0YXJnZXQucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oYC4ke0lURU1fQ0xBU1N9YCk7XG4gICAgaWYgKCFpdGVtKSB7XG4gICAgICBpdGVtID0gY3JlYXRlSXRlbSgpO1xuICAgICAgaWYgKCFwbGFjZUl0ZW0odGFyZ2V0LCBpdGVtKSkgcmV0dXJuO1xuICAgIH1cbiAgICBpdGVtLmRhdGFzZXQuc2NlbmVJZCA9IHNjZW5lSWQ7XG4gICAgY29uc3QgdmFsdWUgPSBpdGVtLnF1ZXJ5U2VsZWN0b3IoXCIuc2Itc2NlbmUtZWxvLXZhbHVlXCIpO1xuICAgIGlmICh2YWx1ZSkgdmFsdWUudGV4dENvbnRlbnQgPSBsYWJlbFRleHQocmVzdWx0LnNjZW5lLCByZXN1bHQucmFuayk7XG4gICAgaXRlbS5xdWVyeVNlbGVjdG9yKFwiYnV0dG9uXCIpPy5zZXRBdHRyaWJ1dGUoXCJ0aXRsZVwiLCB0aXRsZVRleHQocmVzdWx0LnNjZW5lLCByZXN1bHQudGllcikpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS53YXJuKFwiW1N0YXNoIEJhdHRsZV0gQ291bGRuJ3Qgc2hvdyB0aGUgc2NlbmUncyBFTE86XCIsIGUpO1xuICB9IGZpbmFsbHkge1xuICAgIHJlbmRlcmluZyA9IG51bGw7XG4gIH1cbn1cblxuLyoqIFJlZnJlc2ggdGhlIGl0ZW0gZnJvbSB0aGUgY2FjaGUgKGFmdGVyIGJhdHRsZXMgY2hhbmdlIEVMTykuICovXG5leHBvcnQgZnVuY3Rpb24gcmVmcmVzaFNjZW5lRWxvKCk6IHZvaWQge1xuICB2b2lkIHJlbmRlclNjZW5lRWxvKHRydWUpO1xufVxuXG4vKipcbiAqIFNob3cgdGhlIEVMTyBpdGVtIG9uIHNjZW5lIHBhZ2VzLCByZS1hZGRpbmcgaXQgYXMgU3Rhc2ggbmF2aWdhdGVzIGFuZCByZS1yZW5kZXJzOyBjbGlja2luZyBpdFxuICogY2FsbHMgYG9uQ2xpY2tgIChvcGVucyBTdGFzaCBCYXR0bGUpLiBDYWxsIG9uY2UgYXQgc3RhcnR1cC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdGVyU2NlbmVFbG8ob25DbGljazogKCkgPT4gdm9pZCk6IHZvaWQge1xuICBvcGVuQmF0dGxlID0gb25DbGljaztcbiAgbGV0IHF1ZXVlZCA9IGZhbHNlO1xuICBjb25zdCBjaGVjayA9ICgpOiB2b2lkID0+IHtcbiAgICBxdWV1ZWQgPSBmYWxzZTtcbiAgICBpZiAoZ2V0U2NlbmVJZEZyb21VcmwoKSkgdm9pZCByZW5kZXJTY2VuZUVsbygpO1xuICB9O1xuICAvLyBCYXRjaGVkIHdpdGggYSB0aW1lciwgbm90IGFuIGFuaW1hdGlvbiBmcmFtZTogZnJhbWVzIGRvbid0IHJ1biBpbiBhIGJhY2tncm91bmQgdGFiXG4gIG5ldyBNdXRhdGlvbk9ic2VydmVyKCgpID0+IHtcbiAgICBpZiAocXVldWVkKSByZXR1cm47XG4gICAgcXVldWVkID0gdHJ1ZTtcbiAgICBzZXRUaW1lb3V0KGNoZWNrLCA1MCk7XG4gIH0pLm9ic2VydmUoZG9jdW1lbnQuYm9keSwgeyBjaGlsZExpc3Q6IHRydWUsIHN1YnRyZWU6IHRydWUgfSk7XG4gIGNoZWNrKCk7XG59XG4iLCAiLy8gU2V0dXAgcHJldmlldzogdGVuIGV4YW1wbGUgc2NlbmVzIGluIHRocmVlIHJvd3MgKG5vdyBpbiBTdGFzaCAvIGFmdGVyIHNldHVwIC8gYWZ0ZXIgbG90cyBvZlxuLy8gYmF0dGxlcykuIEV2ZXJ5IG51bWJlciBjb21lcyBmcm9tIHRoZSByZWFsIHNjb3JlLnRzIGZ1bmN0aW9ucywgc28gdGhlIHByZXZpZXcgY2FuJ3QgZHJpZnRcbi8vIGZyb20gd2hhdCBzZXR1cCBhbmQgdGhlIFN0YXNoIHJhdGluZ3Mgb3B0aW9ucyBhY3R1YWxseSBkby5cblxuaW1wb3J0IHsgRUxPX0ZJRUxEIH0gZnJvbSBcIi4uL2NvbnN0YW50c1wiO1xuaW1wb3J0IHsgYWZ0ZXJTZXR1cCwgZWxvLCBzdGFzaFJhdGluZ1RhcmdldHMgfSBmcm9tIFwiLi4vc2NvcmVcIjtcbmltcG9ydCB0eXBlIHsgRWxvU3RhcnQsIFNjZW5lLCBTdGFzaFJhdGluZ3NNb2RlIH0gZnJvbSBcIi4uL3R5cGVzXCI7XG5cbi8qKiBFeGFtcGxlIFN0YXNoIHJhdGluZ3MgdG9kYXk6IHRoZSB0aWUgYXQgMTAwIHNob3dzIGhvdyByYXRpbmdzIGJ1bmNoIHVwIGF0IHRoZSB0b3AuICovXG5jb25zdCBOT1dfUkFUSU5HUzogKG51bWJlciB8IG51bGwpW10gPSBbMTAwLCAxMDAsIDk2LCA4NSwgNzQsIDcwLCA2MiwgNDUsIDIwLCBudWxsXTtcblxuLyoqIEV4YW1wbGUgRUxPIG9uY2UgYmF0dGxlcyBoYXZlIHNwcmVhZCB0aGUgc2NlbmVzIG91dCAodGhlIHNhbWUgZm9yIGJvdGggc3RhcnQgY2hvaWNlcykuICovXG5jb25zdCBCQVRUTEVEX0VMTyA9IFsyMTUwLCAxOTgwLCAxNzAwLCAxNjUwLCAxNjAwLCAxNTUwLCAxNTAwLCAxNDAwLCAxMjUwLCAxMTAwXTtcblxuaW50ZXJmYWNlIFNxdWFyZSB7XG4gIGVsbzogbnVtYmVyIHwgbnVsbDtcbiAgcmF0aW5nOiBudW1iZXIgfCBudWxsO1xuICBjaGFuZ2VkOiBib29sZWFuO1xufVxuXG5mdW5jdGlvbiBleGFtcGxlU2NlbmVzKCk6IFNjZW5lW10ge1xuICByZXR1cm4gTk9XX1JBVElOR1MubWFwKChyYXRpbmcxMDAsIGkpID0+ICh7IGlkOiBgZXhhbXBsZS0ke2l9YCwgcmF0aW5nMTAwLCBjdXN0b21fZmllbGRzOiB7fSB9KSk7XG59XG5cbi8qKiBFYWNoIHNjZW5lJ3MgU3Rhc2ggcmF0aW5nIHVuZGVyIHRoZSBtb2RlOiB3cml0dGVuIG9uZXMgZ2V0IHRoZWlyIHRhcmdldCwgb3RoZXJzIHN0YXkgYXMgbm93LiAqL1xuZnVuY3Rpb24gc3F1YXJlcyhzY2VuZXM6IFNjZW5lW10sIG1vZGU6IFN0YXNoUmF0aW5nc01vZGUpOiBTcXVhcmVbXSB7XG4gIGNvbnN0IHRhcmdldHMgPSBzdGFzaFJhdGluZ1RhcmdldHMoc2NlbmVzLCBtb2RlKTtcbiAgcmV0dXJuIHNjZW5lcy5tYXAoKHNjZW5lKSA9PiB7XG4gICAgY29uc3QgcmF0aW5nID0gdGFyZ2V0cy5nZXQoc2NlbmUuaWQpID8/IHNjZW5lLnJhdGluZzEwMCA/PyBudWxsO1xuICAgIHJldHVybiB7IGVsbzogZWxvKHNjZW5lKSwgcmF0aW5nLCBjaGFuZ2VkOiByYXRpbmcgIT09IChzY2VuZS5yYXRpbmcxMDAgPz8gbnVsbCkgfTtcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHNxdWFyZUh0bWwoeyBlbG86IGVsb1ZhbHVlLCByYXRpbmcsIGNoYW5nZWQgfTogU3F1YXJlLCBzaG93Q2hhbmdlOiBib29sZWFuKTogc3RyaW5nIHtcbiAgY29uc3QgY2xhc3NlcyA9IFtcInNiLXB2LXNxdWFyZVwiXTtcbiAgaWYgKHJhdGluZyA9PT0gbnVsbCkgY2xhc3Nlcy5wdXNoKFwic2ItcHYtdW5yYXRlZFwiKTtcbiAgaWYgKHJhdGluZyAhPT0gbnVsbCAmJiByYXRpbmcgPiA1NSkgY2xhc3Nlcy5wdXNoKFwic2ItcHYtc3Ryb25nXCIpO1xuICBpZiAoc2hvd0NoYW5nZSAmJiBjaGFuZ2VkKSBjbGFzc2VzLnB1c2goXCJzYi1wdi1jaGFuZ2VkXCIpO1xuICBjb25zdCBmaWxsID0gcmF0aW5nID09PSBudWxsID8gXCJcIiA6IGAgc3R5bGU9XCItLXNiLXB2LWZpbGw6ICR7cmF0aW5nfSVcImA7XG4gIHJldHVybiBgXG4gICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItcHYtY2VsbFwiPlxuICAgICAgICAgICAgICA8c3BhbiBjbGFzcz1cInNiLXB2LWVsb1wiPiR7ZWxvVmFsdWUgPT09IG51bGwgPyBcIlwiIDogTWF0aC5yb3VuZChlbG9WYWx1ZSl9PC9zcGFuPlxuICAgICAgICAgICAgICA8c3BhbiBjbGFzcz1cIiR7Y2xhc3Nlcy5qb2luKFwiIFwiKX1cIiR7ZmlsbH0+JHtyYXRpbmcgPz8gXCLigJNcIn08L3NwYW4+XG4gICAgICAgICAgICA8L2Rpdj5gO1xufVxuXG5mdW5jdGlvbiByb3dIdG1sKGxhYmVsOiBzdHJpbmcsIGNlbGxzOiBTcXVhcmVbXSwgbm90ZTogc3RyaW5nLCBvcHRpb25zOiB7IG11dGVkPzogYm9vbGVhbjsgc2hvd0NoYW5nZT86IGJvb2xlYW4gfSA9IHt9KTogc3RyaW5nIHtcbiAgcmV0dXJuIGBcbiAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItcHYtcm93JHtvcHRpb25zLm11dGVkID8gXCIgc2ItcHYtbXV0ZWRcIiA6IFwiXCJ9XCI+XG4gICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItcHYtbGFiZWxcIj4ke2xhYmVsfTwvZGl2PlxuICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNiLXB2LXNxdWFyZXNcIj4ke2NlbGxzLm1hcCgoY2VsbCkgPT4gc3F1YXJlSHRtbChjZWxsLCBvcHRpb25zLnNob3dDaGFuZ2UgPz8gZmFsc2UpKS5qb2luKFwiXCIpfVxuICAgICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItcHYtbm90ZVwiPiR7bm90ZX08L2Rpdj5cbiAgICAgICAgICA8L2Rpdj5gO1xufVxuXG4vKiogSG93IGxvbmcgYSBudW1iZXIgY291bnRzIGZyb20gaXRzIG9sZCB2YWx1ZSB0byBpdHMgbmV3IG9uZSAoY29sb3VycyBmYWRlIG92ZXIgdGhlIHNhbWUgdGltZSBpbiBDU1MpLiAqL1xuY29uc3QgVFdFRU5fTVMgPSA0MDA7XG5cbi8qKiBSdW5uaW5nIGNvdW50IHBlciBlbGVtZW50OiBpdHMgYW5pbWF0aW9uIGZyYW1lLCBhbmQgYSB0aW1lciB0aGF0IGxhbmRzIGl0IGlmIGZyYW1lcyBzdGFsbC4gKi9cbmNvbnN0IHR3ZWVucyA9IG5ldyBXZWFrTWFwPEVsZW1lbnQsIHsgZnJhbWU6IG51bWJlcjsgdGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IH0+KCk7XG5cbi8qKiBDb3VudCBhbiBlbGVtZW50J3MgbnVtYmVyIGZyb20gd2hhdCBpdCBzaG93cyBub3cgdG8gYHRhcmdldGA7IG5vbi1udW1iZXJzICjigJMsIGJsYW5rKSBqdXN0IHN3YXAuICovXG5mdW5jdGlvbiB0d2VlblRleHQoZWw6IEVsZW1lbnQsIHRhcmdldDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IHJ1bm5pbmcgPSB0d2VlbnMuZ2V0KGVsKTtcbiAgaWYgKHJ1bm5pbmcpIHtcbiAgICBjYW5jZWxBbmltYXRpb25GcmFtZShydW5uaW5nLmZyYW1lKTtcbiAgICBjbGVhclRpbWVvdXQocnVubmluZy50aW1lcik7XG4gICAgdHdlZW5zLmRlbGV0ZShlbCk7XG4gIH1cbiAgY29uc3QgZnJvbSA9IE51bWJlcihlbC50ZXh0Q29udGVudCk7XG4gIGNvbnN0IHRvID0gTnVtYmVyKHRhcmdldCk7XG4gIGlmIChlbC50ZXh0Q29udGVudCA9PT0gXCJcIiB8fCB0YXJnZXQgPT09IFwiXCIgfHwgIU51bWJlci5pc0Zpbml0ZShmcm9tKSB8fCAhTnVtYmVyLmlzRmluaXRlKHRvKSB8fCBmcm9tID09PSB0bykge1xuICAgIGVsLnRleHRDb250ZW50ID0gdGFyZ2V0O1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBzdGFydFRpbWUgPSBwZXJmb3JtYW5jZS5ub3coKTtcbiAgLy8gQmFja2dyb3VuZCB0YWJzIGdldCBubyBhbmltYXRpb24gZnJhbWVzOiBsYW5kIG9uIHRoZSBmaW5hbCBudW1iZXIgcmVnYXJkbGVzc1xuICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgIGNvbnN0IGN1cnJlbnQgPSB0d2VlbnMuZ2V0KGVsKTtcbiAgICBpZiAoY3VycmVudCkgY2FuY2VsQW5pbWF0aW9uRnJhbWUoY3VycmVudC5mcmFtZSk7XG4gICAgdHdlZW5zLmRlbGV0ZShlbCk7XG4gICAgZWwudGV4dENvbnRlbnQgPSB0YXJnZXQ7XG4gIH0sIFRXRUVOX01TICsgNTApO1xuICBjb25zdCBzdGVwID0gKG5vdzogbnVtYmVyKTogdm9pZCA9PiB7XG4gICAgY29uc3QgdCA9IE1hdGgubWluKDEsIChub3cgLSBzdGFydFRpbWUpIC8gVFdFRU5fTVMpO1xuICAgIGNvbnN0IGVhc2VkID0gMSAtIE1hdGgucG93KDEgLSB0LCAzKTtcbiAgICBlbC50ZXh0Q29udGVudCA9IFN0cmluZyhNYXRoLnJvdW5kKGZyb20gKyAodG8gLSBmcm9tKSAqIGVhc2VkKSk7XG4gICAgaWYgKHQgPCAxKSB0d2VlbnMuc2V0KGVsLCB7IGZyYW1lOiByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoc3RlcCksIHRpbWVyIH0pO1xuICB9O1xuICB0d2VlbnMuc2V0KGVsLCB7IGZyYW1lOiByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoc3RlcCksIHRpbWVyIH0pO1xufVxuXG4vKipcbiAqIFNob3cgdGhlIHByZXZpZXcgaW4gYGNvbnRhaW5lcmAuIFdoZW4gb25lIGlzIGFscmVhZHkgdGhlcmUsIGl0J3MgdXBkYXRlZCBpbiBwbGFjZSBzbyB0aGVcbiAqIG51bWJlcnMgY291bnQgdG8gdGhlaXIgbmV3IHZhbHVlcyBhbmQgdGhlIGNvbG91cnMgZmFkZSAoQ1NTIHRyYW5zaXRpb25zKSBpbnN0ZWFkIG9mIGp1bXBpbmcuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzaG93UmF0aW5nUHJldmlldyhjb250YWluZXI6IEhUTUxFbGVtZW50LCBzdGFydDogRWxvU3RhcnQsIHN0YXNoUmF0aW5nczogU3Rhc2hSYXRpbmdzTW9kZSk6IHZvaWQge1xuICBjb25zdCBuZXh0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbmV4dC5pbm5lckhUTUwgPSByZW5kZXJSYXRpbmdQcmV2aWV3KHN0YXJ0LCBzdGFzaFJhdGluZ3MpO1xuICBjb25zdCBjdXJyZW50ID0gY29udGFpbmVyLnF1ZXJ5U2VsZWN0b3IoXCIuc2ItcmF0aW5nLXByZXZpZXdcIik7XG4gIGNvbnN0IHJlZHVjZWRNb3Rpb24gPSB3aW5kb3cubWF0Y2hNZWRpYShcIihwcmVmZXJzLXJlZHVjZWQtbW90aW9uOiByZWR1Y2UpXCIpLm1hdGNoZXM7XG4gIGlmICghY3VycmVudCB8fCByZWR1Y2VkTW90aW9uKSB7XG4gICAgY29udGFpbmVyLnJlcGxhY2VDaGlsZHJlbiguLi5uZXh0LmNoaWxkTm9kZXMpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IGZyZXNoID0gbmV4dC5xdWVyeVNlbGVjdG9yKFwiLnNiLXJhdGluZy1wcmV2aWV3XCIpIGFzIEVsZW1lbnQ7XG4gIGNvbnN0IHBhaXJzID0gKHNlbGVjdG9yOiBzdHJpbmcpOiBbRWxlbWVudCwgRWxlbWVudF1bXSA9PiB7XG4gICAgY29uc3Qgbm93ID0gY3VycmVudC5xdWVyeVNlbGVjdG9yQWxsKHNlbGVjdG9yKTtcbiAgICByZXR1cm4gWy4uLmZyZXNoLnF1ZXJ5U2VsZWN0b3JBbGwoc2VsZWN0b3IpXS5tYXAoKGVsLCBpKSA9PiBbbm93W2ldLCBlbF0pO1xuICB9O1xuICBmb3IgKGNvbnN0IFtlbCwgdG9dIG9mIHBhaXJzKFwiLnNiLXB2LXJvd1wiKSkgZWwuY2xhc3NOYW1lID0gdG8uY2xhc3NOYW1lO1xuICBmb3IgKGNvbnN0IFtlbCwgdG9dIG9mIHBhaXJzKFwiLnNiLXB2LW5vdGVcIikpIGVsLnRleHRDb250ZW50ID0gdG8udGV4dENvbnRlbnQ7XG4gIGZvciAoY29uc3QgW2VsLCB0b10gb2YgcGFpcnMoXCIuc2ItcHYtZWxvXCIpKSB0d2VlblRleHQoZWwsIHRvLnRleHRDb250ZW50ID8/IFwiXCIpO1xuICBmb3IgKGNvbnN0IFtlbCwgdG9dIG9mIHBhaXJzKFwiLnNiLXB2LXNxdWFyZVwiKSkge1xuICAgIGVsLmNsYXNzTmFtZSA9IHRvLmNsYXNzTmFtZTtcbiAgICBlbC5zZXRBdHRyaWJ1dGUoXCJzdHlsZVwiLCB0by5nZXRBdHRyaWJ1dGUoXCJzdHlsZVwiKSA/PyBcIlwiKTtcbiAgICB0d2VlblRleHQoZWwsIHRvLnRleHRDb250ZW50ID8/IFwiXCIpO1xuICB9XG59XG5cbi8qKiBUaGUgcHJldmlldyBmb3Igb25lIHBhaXIgb2Ygc2V0dXAgYW5zd2VycywgYXMgYW4gSFRNTCBzdHJpbmcuICovXG5leHBvcnQgZnVuY3Rpb24gcmVuZGVyUmF0aW5nUHJldmlldyhzdGFydDogRWxvU3RhcnQsIHN0YXNoUmF0aW5nczogU3Rhc2hSYXRpbmdzTW9kZSk6IHN0cmluZyB7XG4gIGNvbnN0IG9mZiA9IHN0YXNoUmF0aW5ncyA9PT0gXCJvZmZcIjtcbiAgY29uc3Qgbm93ID0gc3F1YXJlcyhleGFtcGxlU2NlbmVzKCksIFwib2ZmXCIpO1xuXG4gIGNvbnN0IHNldFVwID0gc3F1YXJlcyhleGFtcGxlU2NlbmVzKCkubWFwKChzY2VuZSkgPT4gYWZ0ZXJTZXR1cChzY2VuZSwgc3RhcnQpKSwgc3Rhc2hSYXRpbmdzKTtcbiAgY29uc3QgY2hhbmdlZENvdW50ID0gc2V0VXAuZmlsdGVyKChjZWxsKSA9PiBjZWxsLmNoYW5nZWQpLmxlbmd0aDtcblxuICBjb25zdCBiYXR0bGVkID0gZXhhbXBsZVNjZW5lcygpLm1hcCgoc2NlbmUsIGkpID0+ICh7IC4uLnNjZW5lLCBjdXN0b21fZmllbGRzOiB7IFtFTE9fRklFTERdOiBCQVRUTEVEX0VMT1tpXSB9IH0pKTtcbiAgY29uc3QgbGF0ZXIgPSBzcXVhcmVzKGJhdHRsZWQsIHN0YXNoUmF0aW5ncyk7XG5cbiAgY29uc3QgdW5jaGFuZ2VkTm90ZSA9IFwiU3Rhc2ggcmF0aW5ncyBzdGF5IGFzIHRoZXkgYXJlXCI7XG4gIGNvbnN0IGxhdGVyTm90ZSA9IG9mZlxuICAgID8gdW5jaGFuZ2VkTm90ZVxuICAgIDogc3Rhc2hSYXRpbmdzID09PSBcInBlcmNlbnRpbGVcIlxuICAgICAgPyBcIkV2ZW5seSBzcGFjZWQgYnkgcmFuaywgd2hhdGV2ZXIgdGhlIGdhcHNcIlxuICAgICAgOiBcIkdhcHMgc2hvdywgYnV0IDIxNTAgaXMgc3R1Y2sgYXQgMTAwXCI7XG5cbiAgcmV0dXJuIGBcbiAgICAgICAgPGRpdiBjbGFzcz1cInNiLXJhdGluZy1wcmV2aWV3XCI+XG4gICAgICAgICAgPHAgY2xhc3M9XCJzYi1wdi1sZWdlbmRcIj5FYWNoIHNxdWFyZSBiZWxvdyBpcyBhbiBleGFtcGxlIHNjZW5lOiBpdHMgRUxPIGFib3ZlLCBpdHMgU3Rhc2ggcmF0aW5nIGluc2lkZS48L3A+XG4gICAgICAgICAgJHtyb3dIdG1sKFwiTm93IGluIFN0YXNoXCIsIG5vdywgXCJcIil9XG4gICAgICAgICAgJHtyb3dIdG1sKFwiQWZ0ZXIgc2V0dXBcIiwgc2V0VXAsIG9mZiA/IHVuY2hhbmdlZE5vdGUgOiBgJHtjaGFuZ2VkQ291bnR9IG9mIDEwIGNoYW5nZWAsIHsgbXV0ZWQ6IG9mZiwgc2hvd0NoYW5nZTogIW9mZiB9KX1cbiAgICAgICAgICAke3Jvd0h0bWwoXCJBZnRlciBsb3RzIG9mIGJhdHRsZXNcIiwgbGF0ZXIsIGxhdGVyTm90ZSwgeyBtdXRlZDogb2ZmIH0pfVxuICAgICAgICA8L2Rpdj5gO1xufVxuIiwgIi8vIE9uZS10aW1lIEVMTyBzZXR1cCBzY3JlZW4sIHNob3duIGluIHRoZSBCYXR0bGUgdGFiIGluIHBsYWNlIG9mIHRoZSBiYXR0bGUgdW50aWwgaXQncyBkb25lLlxuLy8gVHdvIHF1ZXN0aW9ucyBzaWRlIGJ5IHNpZGUgKGhvdyBFTE8gc3RhcnRzLCB3aGV0aGVyIFN0YXNoIEJhdHRsZSB3cml0ZXMgU3Rhc2ggcmF0aW5ncykgYWJvdmVcbi8vIGEgc2hhcmVkIHByZXZpZXcsIHRoZW4gYSBwcm9ncmVzcyB2aWV3IHdoaWxlIGVsb1NldHVwLnRzIHdyaXRlcywgdGhlbiBhIHN1bW1hcnkuIFJlc2V0IEVMT1xuLy8gKFNldHRpbmdzKSBzaG93cyB0aGUgc2FtZSBzY3JlZW4gaW4gcmVzZXQgbW9kZSwgd2l0aCBhIENhbmNlbCBidXR0b24uXG5cbmltcG9ydCB7IGNsZWFyU2NlbmVDYWNoZSB9IGZyb20gXCIuLi9jYWNoZVwiO1xuaW1wb3J0IHsgZmV0Y2hTZXR1cFNjZW5lcywgcnVuRWxvU2V0dXAsIHNldHVwUmF0aW5nQ2hhbmdlcywgdHlwZSBTZXR1cFBoYXNlLCB0eXBlIFNldHVwU3VtbWFyeSB9IGZyb20gXCIuLi9lbG9TZXR1cFwiO1xuaW1wb3J0IHsgaXNSYXRlZCB9IGZyb20gXCIuLi9zY29yZVwiO1xuaW1wb3J0IHsgaGFkRnVuTW9kZSwgdXBkYXRlU2V0dGluZ3NOb3cgfSBmcm9tIFwiLi4vc2V0dGluZ3NcIjtcbmltcG9ydCB7IHJlc2V0UnVuU3RhdGUsIHJlc2V0U2h1ZmZsZSwgc3RhdGUgfSBmcm9tIFwiLi4vc3RhdGVcIjtcbmltcG9ydCB7IHNhdmVTdGF0ZSB9IGZyb20gXCIuLi9zdG9yYWdlXCI7XG5pbXBvcnQgdHlwZSB7IEVsb1N0YXJ0LCBTY2VuZSwgU3Rhc2hSYXRpbmdzTW9kZSB9IGZyb20gXCIuLi90eXBlc1wiO1xuaW1wb3J0IHsgc2hvd1JhdGluZ1ByZXZpZXcgfSBmcm9tIFwiLi9yYXRpbmdQcmV2aWV3XCI7XG5pbXBvcnQgeyBTVEFTSF9SQVRJTkdTX09QVElPTlMgfSBmcm9tIFwiLi9zdGFzaFJhdGluZ3NUZXh0XCI7XG5cbi8qKiBPbiB0aGUgQmF0dGxlIHBhbmVsIHdoaWxlIHNldHVwIHNob3dzOyBDU1MgaGlkZXMgdGhlIGJhdHRsZSBVSSAobW9kZXMsIGNhcmRzLCBhY3Rpb25zKS4gKi9cbmNvbnN0IFNFVFVQX0FDVElWRV9DTEFTUyA9IFwic2Itc2V0dXAtYWN0aXZlXCI7XG5cbi8qKiBUcnVlIGZyb20gU3RhcnQgdW50aWwgdGhlIHdyaXRlcyBmaW5pc2ggb3IgZmFpbDsgcmVvcGVuaW5nIEJhdHRsZSBtZWFud2hpbGUga2VlcHMgdGhlIHByb2dyZXNzLiAqL1xubGV0IHJ1bm5pbmcgPSBmYWxzZTtcblxuZXhwb3J0IGludGVyZmFjZSBTZXR1cFNjcmVlbk9wdGlvbnMge1xuICAvKiogUmVzZXQgRUxPOiBldmVyeXRoaW5nIGFscmVhZHkgaGFzIGFuIEVMTzsgdGhlIGN1cnJlbnQgU3Rhc2ggcmF0aW5ncyBvcHRpb24gaXMgcHJlc2VsZWN0ZWQuICovXG4gIHJlc2V0PzogYm9vbGVhbjtcbiAgLyoqIFJlc2V0IG1vZGUncyBDYW5jZWwgYnV0dG9uIChiZWZvcmUgYW55dGhpbmcgaXMgd3JpdHRlbikuICovXG4gIG9uQ2FuY2VsPzogKCkgPT4gdm9pZDtcbn1cblxubGV0IG9wdGlvbnM6IFNldHVwU2NyZWVuT3B0aW9ucyA9IHt9O1xuXG5pbnRlcmZhY2UgQ2hvaWNlIHtcbiAgc3RhcnQ6IEVsb1N0YXJ0O1xuICBzdGFzaFJhdGluZ3M6IFN0YXNoUmF0aW5nc01vZGU7XG59XG5cbmNvbnN0IHBsdXJhbCA9IChuOiBudW1iZXIsIHdvcmQ6IHN0cmluZyk6IHN0cmluZyA9PiBgJHtufSAke3dvcmR9JHtuID09PSAxID8gXCJcIiA6IFwic1wifWA7XG5cbmZ1bmN0aW9uIHNldHVwQXJlYShyb290OiBQYXJlbnROb2RlKTogSFRNTEVsZW1lbnQgfCBudWxsIHtcbiAgcmV0dXJuIHJvb3QucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCIjc2Itc2V0dXAtYXJlYVwiKTtcbn1cblxuLyoqIFRydWUgd2hpbGUgc2V0dXAgaXMgd3JpdGluZyAoU3RhcnQgcHJlc3NlZCwgbm90IGZpbmlzaGVkIG9yIGZhaWxlZCB5ZXQpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzU2V0dXBSdW5uaW5nKCk6IGJvb2xlYW4ge1xuICByZXR1cm4gcnVubmluZztcbn1cblxuLyoqIFNob3cgdGhlIHNldHVwIGluIHRoZSBCYXR0bGUgdGFiLiBgb25Eb25lYCBydW5zIG9uY2Ugc2V0dXAgaGFzIGZpbmlzaGVkIGFuZCBiZWVuIHNhdmVkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNob3dTZXR1cFNjcmVlbihyb290OiBQYXJlbnROb2RlLCBvbkRvbmU6ICgpID0+IHZvaWQsIHNjcmVlbk9wdGlvbnM6IFNldHVwU2NyZWVuT3B0aW9ucyA9IHt9KTogdm9pZCB7XG4gIGNvbnN0IGFyZWEgPSBzZXR1cEFyZWEocm9vdCk7XG4gIGlmICghYXJlYSkgcmV0dXJuO1xuICBhcmVhLmNsb3Nlc3QoXCIuc2ItdGFiLXBhbmVsXCIpPy5jbGFzc0xpc3QuYWRkKFNFVFVQX0FDVElWRV9DTEFTUyk7XG4gIGFyZWEuaGlkZGVuID0gZmFsc2U7XG4gIGlmIChydW5uaW5nKSByZXR1cm47XG4gIG9wdGlvbnMgPSBzY3JlZW5PcHRpb25zO1xuICB2b2lkIGxvYWRDaG9pY2VzKGFyZWEsIG9uRG9uZSk7XG59XG5cbi8qKiBQdXQgdGhlIGJhdHRsZSBVSSBiYWNrIChzZXR1cCBmaW5pc2hlZCwgcG9zc2libHkgZWxzZXdoZXJlKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoaWRlU2V0dXBTY3JlZW4ocm9vdDogUGFyZW50Tm9kZSk6IHZvaWQge1xuICBjb25zdCBhcmVhID0gc2V0dXBBcmVhKHJvb3QpO1xuICBpZiAoIWFyZWEgfHwgcnVubmluZykgcmV0dXJuO1xuICBhcmVhLmNsb3Nlc3QoXCIuc2ItdGFiLXBhbmVsXCIpPy5jbGFzc0xpc3QucmVtb3ZlKFNFVFVQX0FDVElWRV9DTEFTUyk7XG4gIGFyZWEuaGlkZGVuID0gdHJ1ZTtcbiAgYXJlYS5pbm5lckhUTUwgPSBcIlwiO1xufVxuXG5hc3luYyBmdW5jdGlvbiBsb2FkQ2hvaWNlcyhhcmVhOiBIVE1MRWxlbWVudCwgb25Eb25lOiAoKSA9PiB2b2lkKTogUHJvbWlzZTx2b2lkPiB7XG4gIGFyZWEuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9XCJzYi1sb2FkaW5nXCI+TG9hZGluZyB5b3VyIGxpYnJhcnkuLi48L2Rpdj5gO1xuICBsZXQgc2NlbmVzOiBTY2VuZVtdO1xuICB0cnkge1xuICAgIHNjZW5lcyA9IGF3YWl0IGZldGNoU2V0dXBTY2VuZXMoKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnNvbGUuZXJyb3IoXCJbU3Rhc2ggQmF0dGxlXSBFTE8gc2V0dXA6IGNvdWxkIG5vdCBsb2FkIHNjZW5lczpcIiwgZSk7XG4gICAgc2hvd0Vycm9yKGFyZWEsIFwiQ291bGRuJ3QgbG9hZCB5b3VyIHNjZW5lcyBmcm9tIFN0YXNoLlwiLCAoKSA9PiB2b2lkIGxvYWRDaG9pY2VzKGFyZWEsIG9uRG9uZSkpO1xuICAgIHJldHVybjtcbiAgfVxuICByZW5kZXJDaG9pY2VzKGFyZWEsIHNjZW5lcywgb25Eb25lKTtcbn1cblxuZnVuY3Rpb24gcmFkaW8obmFtZTogc3RyaW5nLCB2YWx1ZTogc3RyaW5nLCBsYWJlbDogc3RyaW5nLCBkZXNjOiBzdHJpbmcsIGNoZWNrZWQ6IGJvb2xlYW4pOiBzdHJpbmcge1xuICBjb25zdCBpZCA9IGBzYi1zZXR1cC0ke25hbWV9LSR7dmFsdWV9YDtcbiAgcmV0dXJuIGBcbiAgICAgICAgICAgICAgPGRpdiBjbGFzcz1cImN1c3RvbS1jb250cm9sIGN1c3RvbS1yYWRpbyBzYi1zZXR1cC1vcHRpb25cIj5cbiAgICAgICAgICAgICAgICA8aW5wdXQgdHlwZT1cInJhZGlvXCIgY2xhc3M9XCJjdXN0b20tY29udHJvbC1pbnB1dFwiIGlkPVwiJHtpZH1cIiBuYW1lPVwiJHtuYW1lfVwiIHZhbHVlPVwiJHt2YWx1ZX1cIiAke2NoZWNrZWQgPyBcImNoZWNrZWRcIiA6IFwiXCJ9PlxuICAgICAgICAgICAgICAgIDxsYWJlbCBjbGFzcz1cImN1c3RvbS1jb250cm9sLWxhYmVsXCIgZm9yPVwiJHtpZH1cIj5cbiAgICAgICAgICAgICAgICAgIDxzdHJvbmc+JHtsYWJlbH08L3N0cm9uZz5cbiAgICAgICAgICAgICAgICAgIDxzcGFuIGNsYXNzPVwic2Itc2V0dXAtZGVzY1wiPiR7ZGVzY308L3NwYW4+XG4gICAgICAgICAgICAgICAgPC9sYWJlbD5cbiAgICAgICAgICAgICAgPC9kaXY+YDtcbn1cblxuLyoqIFdoYXQgdGhlIHNlY29uZCBhbnN3ZXIgZG9lcyB0byBTdGFzaCByYXRpbmdzIG5vdzogYSB3YXJuaW5nIHdoZW4gcmF0aW5ncyBjaGFuZ2UsIGVsc2UgYSBjYWxtIGxpbmUuICovXG5mdW5jdGlvbiByYXRpbmdzTWVzc2FnZShzdGFydDogRWxvU3RhcnQsIG1vZGU6IFN0YXNoUmF0aW5nc01vZGUsIGNoYW5nZXM6IG51bWJlcik6IHN0cmluZyB7XG4gIGNvbnN0IGJhY2t1cCA9IFwiVGFrZSBhIFN0YXNoIGJhY2t1cCBmaXJzdCAoU2V0dGluZ3Mg4oaSIFRhc2tzIOKGkiBCYWNrdXApLlwiO1xuICBsZXQgdGV4dDogc3RyaW5nO1xuICBsZXQgd2FybiA9IHRydWU7XG4gIGlmIChtb2RlID09PSBcIm9mZlwiKSB7XG4gICAgdGV4dCA9IFwiU3Rhc2ggcmF0aW5ncyB3b24ndCBjaGFuZ2UuXCI7XG4gICAgd2FybiA9IGZhbHNlO1xuICB9IGVsc2UgaWYgKGNoYW5nZXMgPT09IDApIHtcbiAgICB0ZXh0ID0gXCJObyBTdGFzaCByYXRpbmdzIGNoYW5nZSBub3c6IGV2ZXJ5IHNjZW5lIGNvbnZlcnRzIGJhY2sgdG8gaXRzIGN1cnJlbnQgcmF0aW5nLlwiO1xuICAgIHdhcm4gPSBmYWxzZTtcbiAgfSBlbHNlIGlmIChzdGFydCA9PT0gXCJmcmVzaFwiKSB7XG4gICAgdGV4dCA9IGDimqDvuI8gRXZlcnkgc2NlbmUgc3RhcnRzIGF0IDE1MDAgRUxPLCBzbyA8c3Ryb25nPmV2ZXJ5IFN0YXNoIHJhdGluZyBiZWNvbWVzIDUwPC9zdHJvbmc+OiAke3BsdXJhbChjaGFuZ2VzLCBcInJhdGluZ1wiKX0gY2hhbmdlLCB1bnJhdGVkIHNjZW5lcyBpbmNsdWRlZC4gJHtiYWNrdXB9YDtcbiAgfSBlbHNlIHtcbiAgICB0ZXh0ID0gYOKaoO+4jyA8c3Ryb25nPiR7cGx1cmFsKGNoYW5nZXMsIFwiU3Rhc2ggcmF0aW5nXCIpfSBjaGFuZ2U8L3N0cm9uZz4gbm93LCBzcHJlYWQgZXZlbmx5IGJ5IHJhbmsuIEEgc2NlbmUgeW91IHJhdGVkIDEwMCBieSBoYW5kIG1heSBlbmQgdXAgbG93ZXIuICR7YmFja3VwfWA7XG4gIH1cbiAgcmV0dXJuIGA8cCBjbGFzcz1cInNiLXNldHVwLW1lc3NhZ2Uke3dhcm4gPyBcIiBzYi1zZXR1cC13YXJuaW5nXCIgOiBcIlwifVwiPiR7dGV4dH08L3A+YDtcbn1cblxuZnVuY3Rpb24gcmVuZGVyQ2hvaWNlcyhhcmVhOiBIVE1MRWxlbWVudCwgc2NlbmVzOiBTY2VuZVtdLCBvbkRvbmU6ICgpID0+IHZvaWQpOiB2b2lkIHtcbiAgY29uc3QgdG90YWwgPSBzY2VuZXMubGVuZ3RoO1xuICBjb25zdCByYXRlZCA9IHNjZW5lcy5maWx0ZXIoKHNjZW5lKSA9PiBzY2VuZS5yYXRpbmcxMDAgIT0gbnVsbCkubGVuZ3RoO1xuICBjb25zdCB1bnJhdGVkID0gdG90YWwgLSByYXRlZDtcbiAgY29uc3Qgd2l0aEVsbyA9IHNjZW5lcy5maWx0ZXIoaXNSYXRlZCkubGVuZ3RoO1xuICAvLyBSZS1ydW5zIChSZXNldCBFTE8sIFN0YWdlIDQpIGFuZCBwcmUtMy4wIGZ1biBtb2RlIHVzZXJzIGhhZCBubyByYXRpbmcgdXBkYXRlcyB0byBsb3NlXG4gIGNvbnN0IHVwZ3JhZGVOb3RlID1cbiAgICAhc3RhdGUuc2V0dGluZ3MuZWxvU2V0dXBBdCAmJiAhaGFkRnVuTW9kZSgpXG4gICAgICA/IFwiIEJlZm9yZSAzLjAsIHJhdGluZ3MgY2hhbmdlZCBhZnRlciBldmVyeSBiYXR0bGU7IFN0cmFpZ2h0LWxpbmUgd2l0aCBVc2UgbXkgcmF0aW5ncyBpcyBjbG9zZXN0IHRvIHRoYXQuXCJcbiAgICAgIDogXCJcIjtcblxuICBjb25zdCByZXNldCA9IG9wdGlvbnMucmVzZXQgPT09IHRydWU7XG4gIGNvbnN0IGNob2ljZTogQ2hvaWNlID0geyBzdGFydDogXCJyYXRpbmdzXCIsIHN0YXNoUmF0aW5nczogcmVzZXQgPyBzdGF0ZS5zZXR0aW5ncy5zdGFzaFJhdGluZ3MgOiBcIm9mZlwiIH07XG5cbiAgYXJlYS5pbm5lckhUTUwgPSBgXG4gICAgICA8ZGl2IGNsYXNzPVwic2Itc2V0dXBcIj5cbiAgICAgICAgPGgyIGNsYXNzPVwic2Itc2V0dXAtdGl0bGVcIj4ke3Jlc2V0ID8gXCJSZXNldCBFTE9cIiA6IFwiU2V0IHVwIEVMT1wifTwvaDI+XG4gICAgICAgIDxwIGNsYXNzPVwic2Itc2V0dXAtaW50cm9cIj5cbiAgICAgICAgICAke1xuICAgICAgICAgICAgcmVzZXRcbiAgICAgICAgICAgICAgPyBcIkNob29zZSBob3cgRUxPIHN0YXJ0cyBhZ2Fpbi4gVGhpcyBvdmVyd3JpdGVzIGV2ZXJ5IHNjZW5lJ3MgRUxPIGFuZCBiYXR0bGUgY291bnQuXCJcbiAgICAgICAgICAgICAgOiBcIlN0YXNoIEJhdHRsZSBub3cgZ2l2ZXMgZWFjaCBzY2VuZSBhbiBFTE8gc2NvcmUsIHNhdmVkIGluIGl0cyBjdXN0b20gZmllbGRzLiBXaW5zIHJhaXNlIGl0LCBsb3NzZXMgbG93ZXIgaXQuIENob29zZSBob3cgaXQgc3RhcnRzLiBUaGlzIHJ1bnMgb25jZS5cIlxuICAgICAgICAgIH1cbiAgICAgICAgPC9wPlxuICAgICAgICAke1xuICAgICAgICAgIHdpdGhFbG8gPiAwICYmICFyZXNldFxuICAgICAgICAgICAgPyBgPHAgY2xhc3M9XCJzYi1zZXR1cC13YXJuaW5nXCI+JHtwbHVyYWwod2l0aEVsbywgXCJzY2VuZVwiKX0gYWxyZWFkeSAke3dpdGhFbG8gPT09IDEgPyBcImhhc1wiIDogXCJoYXZlXCJ9IGFuIEVMTyBmcm9tIGFuIGVhcmxpZXIgc2V0dXAgdGhhdCBkaWRuJ3QgZmluaXNoLiBTZXR0aW5nIHVwIGFnYWluIG92ZXJ3cml0ZXMgJHt3aXRoRWxvID09PSAxID8gXCJpdFwiIDogXCJ0aGVtXCJ9LjwvcD5gXG4gICAgICAgICAgICA6IFwiXCJcbiAgICAgICAgfVxuICAgICAgICA8ZGl2IGNsYXNzPVwic2Itc2V0dXAtcXVlc3Rpb25zXCI+XG4gICAgICAgICAgPGZpZWxkc2V0IGNsYXNzPVwic2Itc2V0dXAtcXVlc3Rpb25cIj5cbiAgICAgICAgICAgIDxsZWdlbmQ+SG93IHNob3VsZCBFTE8gc3RhcnQ/PC9sZWdlbmQ+XG4gICAgICAgICAgICAke3JhZGlvKFxuICAgICAgICAgICAgICBcInN0YXJ0XCIsXG4gICAgICAgICAgICAgIFwicmF0aW5nc1wiLFxuICAgICAgICAgICAgICBcIlVzZSBteSByYXRpbmdzXCIsXG4gICAgICAgICAgICAgIGBZb3VyICR7cGx1cmFsKHJhdGVkLCBcInJhdGVkIHNjZW5lXCIpfSBzdGFydCBmcm9tIHRoZWlyIHJhdGluZyAoNTAgPSAxNTAwIEVMTywgMTAgRUxPIHBlciBwb2ludCkuJHt1bnJhdGVkID4gMCA/IGAgVGhlICR7dW5yYXRlZH0gdW5yYXRlZCAke3VucmF0ZWQgPT09IDEgPyBcIm9uZSBzdGF5c1wiIDogXCJvbmVzIHN0YXlcIn0gdW5yYXRlZC5gIDogXCJcIn1gLFxuICAgICAgICAgICAgICB0cnVlLFxuICAgICAgICAgICAgKX1cbiAgICAgICAgICAgICR7cmFkaW8oXG4gICAgICAgICAgICAgIFwic3RhcnRcIixcbiAgICAgICAgICAgICAgXCJmcmVzaFwiLFxuICAgICAgICAgICAgICBcIlN0YXJ0IGV2ZXJ5b25lIGF0IDE1MDBcIixcbiAgICAgICAgICAgICAgYEFsbCAke3BsdXJhbCh0b3RhbCwgXCJzY2VuZVwiKX0gc3RhcnQgZXF1YWwuYCxcbiAgICAgICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgICApfVxuICAgICAgICAgIDwvZmllbGRzZXQ+XG4gICAgICAgICAgPGZpZWxkc2V0IGNsYXNzPVwic2Itc2V0dXAtcXVlc3Rpb25cIj5cbiAgICAgICAgICAgIDxsZWdlbmQ+U2hvdWxkIFN0YXNoIEJhdHRsZSBjaGFuZ2UgeW91ciBTdGFzaCByYXRpbmdzPzwvbGVnZW5kPlxuICAgICAgICAgICAgJHtTVEFTSF9SQVRJTkdTX09QVElPTlMubWFwKCh7IHZhbHVlLCBsYWJlbCwgZGVzYyB9KSA9PlxuICAgICAgICAgICAgICByYWRpbyhcInN0YXNoUmF0aW5nc1wiLCB2YWx1ZSwgbGFiZWwsIGRlc2MsIHZhbHVlID09PSBjaG9pY2Uuc3Rhc2hSYXRpbmdzKSxcbiAgICAgICAgICAgICkuam9pbihcIlwiKX1cbiAgICAgICAgICAgIDxwIGNsYXNzPVwic2Itc2V0dXAtbm90ZVwiPllvdSBjYW4gY2hhbmdlIHRoaXMgbGF0ZXIgaW4gU2V0dGluZ3MuJHt1cGdyYWRlTm90ZX08L3A+XG4gICAgICAgICAgPC9maWVsZHNldD5cbiAgICAgICAgPC9kaXY+XG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi1zZXR1cC1tZXNzYWdlLXNsb3RcIiBkYXRhLXJvbGU9XCJyYXRpbmdzLXdhcm5pbmdcIj48L2Rpdj5cbiAgICAgICAgPGgzIGNsYXNzPVwic2Itc2V0dXAtc3VidGl0bGVcIj5QcmV2aWV3PC9oMz5cbiAgICAgICAgPGRpdiBkYXRhLXJvbGU9XCJwcmV2aWV3XCI+PC9kaXY+XG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi1zZXR1cC1hY3Rpb25zXCI+XG4gICAgICAgICAgJHtyZXNldCA/IGA8YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cImJ0biBidG4tc2Vjb25kYXJ5XCIgZGF0YS1yb2xlPVwiY2FuY2VsXCI+Q2FuY2VsPC9idXR0b24+YCA6IFwiXCJ9XG4gICAgICAgICAgPGJ1dHRvbiB0eXBlPVwiYnV0dG9uXCIgY2xhc3M9XCJidG4gYnRuLXByaW1hcnlcIiBkYXRhLXJvbGU9XCJzdGFydFwiPlN0YXJ0IEVMTzwvYnV0dG9uPlxuICAgICAgICA8L2Rpdj5cbiAgICAgIDwvZGl2PmA7XG5cbiAgYXJlYS5xdWVyeVNlbGVjdG9yKCdbZGF0YS1yb2xlPVwiY2FuY2VsXCJdJyk/LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiBvcHRpb25zLm9uQ2FuY2VsPy4oKSk7XG5cbiAgY29uc3Qgc2xvdCA9IGFyZWEucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oJ1tkYXRhLXJvbGU9XCJyYXRpbmdzLXdhcm5pbmdcIl0nKSBhcyBIVE1MRWxlbWVudDtcbiAgY29uc3QgcHJldmlldyA9IGFyZWEucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oJ1tkYXRhLXJvbGU9XCJwcmV2aWV3XCJdJykgYXMgSFRNTEVsZW1lbnQ7XG4gIGNvbnN0IHN0YXJ0QnRuID0gYXJlYS5xdWVyeVNlbGVjdG9yPEhUTUxCdXR0b25FbGVtZW50PignW2RhdGEtcm9sZT1cInN0YXJ0XCJdJykgYXMgSFRNTEJ1dHRvbkVsZW1lbnQ7XG5cbiAgLy8gRXZlcnkgYW5zd2VyJ3MgbWVzc2FnZSBzaXRzIGluIHRoZSBzbG90IGF0IG9uY2UsIHN0YWNrZWQgaW4gb25lIGdyaWQgY2VsbCwgc28gdGhlIHNsb3QgaXNcbiAgLy8gYWx3YXlzIGFzIHRhbGwgYXMgdGhlIGxvbmdlc3QgYW5kIHN3aXRjaGluZyBhbnN3ZXJzIG5ldmVyIG1vdmVzIHRoZSBsYXlvdXQgYmVsb3cgaXQuXG4gIC8vIEFuc3dlcnMgd2l0aCB0aGUgc2FtZSBtZXNzYWdlIHNoYXJlIG9uZSBlbGVtZW50LCBzbyBzd2l0Y2hpbmcgYmV0d2VlbiB0aGVtIGRvZXNuJ3QgZmFkZS5cbiAgY29uc3QgY2hhbmdlQ291bnRzID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgY29uc3QgbWVzc2FnZUZvciA9IG5ldyBNYXA8c3RyaW5nLCBFbGVtZW50PigpO1xuICBjb25zdCBtZXNzYWdlQnlIdG1sID0gbmV3IE1hcDxzdHJpbmcsIEVsZW1lbnQ+KCk7XG4gIGZvciAoY29uc3Qgc3RhcnQgb2YgW1wicmF0aW5nc1wiLCBcImZyZXNoXCJdIGFzIGNvbnN0KSB7XG4gICAgZm9yIChjb25zdCBtb2RlIG9mIFtcIm9mZlwiLCBcImxpbmVhclwiLCBcInBlcmNlbnRpbGVcIl0gYXMgY29uc3QpIHtcbiAgICAgIGNvbnN0IGNoYW5nZXMgPSBzZXR1cFJhdGluZ0NoYW5nZXMoc2NlbmVzLCBzdGFydCwgbW9kZSkuc2l6ZTtcbiAgICAgIGNvbnN0IGh0bWwgPSByYXRpbmdzTWVzc2FnZShzdGFydCwgbW9kZSwgY2hhbmdlcyk7XG4gICAgICBsZXQgbWVzc2FnZSA9IG1lc3NhZ2VCeUh0bWwuZ2V0KGh0bWwpO1xuICAgICAgaWYgKCFtZXNzYWdlKSB7XG4gICAgICAgIHNsb3QuaW5zZXJ0QWRqYWNlbnRIVE1MKFwiYmVmb3JlZW5kXCIsIGh0bWwpO1xuICAgICAgICBtZXNzYWdlID0gc2xvdC5sYXN0RWxlbWVudENoaWxkIGFzIEVsZW1lbnQ7XG4gICAgICAgIG1lc3NhZ2VCeUh0bWwuc2V0KGh0bWwsIG1lc3NhZ2UpO1xuICAgICAgfVxuICAgICAgY2hhbmdlQ291bnRzLnNldChgJHtzdGFydH06JHttb2RlfWAsIGNoYW5nZXMpO1xuICAgICAgbWVzc2FnZUZvci5zZXQoYCR7c3RhcnR9OiR7bW9kZX1gLCBtZXNzYWdlKTtcbiAgICB9XG4gIH1cblxuICBjb25zdCB1cGRhdGUgPSAoKTogdm9pZCA9PiB7XG4gICAgc2hvd1JhdGluZ1ByZXZpZXcocHJldmlldywgY2hvaWNlLnN0YXJ0LCBjaG9pY2Uuc3Rhc2hSYXRpbmdzKTtcbiAgICBjb25zdCBrZXkgPSBgJHtjaG9pY2Uuc3RhcnR9OiR7Y2hvaWNlLnN0YXNoUmF0aW5nc31gO1xuICAgIGNvbnN0IHNob3duID0gbWVzc2FnZUZvci5nZXQoa2V5KTtcbiAgICBmb3IgKGNvbnN0IG1lc3NhZ2Ugb2Ygc2xvdC5jaGlsZHJlbikgbWVzc2FnZS5jbGFzc0xpc3QudG9nZ2xlKFwic2Itc2hvd25cIiwgbWVzc2FnZSA9PT0gc2hvd24pO1xuICAgIGNvbnN0IGNoYW5nZXMgPSBjaGFuZ2VDb3VudHMuZ2V0KGtleSkgPz8gMDtcbiAgICBzdGFydEJ0bi50ZXh0Q29udGVudCA9IGNoYW5nZXMgPiAwID8gYFN0YXJ0IEVMTyBhbmQgY2hhbmdlICR7cGx1cmFsKGNoYW5nZXMsIFwicmF0aW5nXCIpfWAgOiBcIlN0YXJ0IEVMT1wiO1xuICB9O1xuXG4gIGFyZWEucXVlcnlTZWxlY3RvckFsbDxIVE1MSW5wdXRFbGVtZW50PignaW5wdXRbdHlwZT1cInJhZGlvXCJdJykuZm9yRWFjaCgoaW5wdXQpID0+IHtcbiAgICBpbnB1dC5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHtcbiAgICAgIGlmIChpbnB1dC5uYW1lID09PSBcInN0YXJ0XCIpIGNob2ljZS5zdGFydCA9IGlucHV0LnZhbHVlIGFzIEVsb1N0YXJ0O1xuICAgICAgZWxzZSBjaG9pY2Uuc3Rhc2hSYXRpbmdzID0gaW5wdXQudmFsdWUgYXMgU3Rhc2hSYXRpbmdzTW9kZTtcbiAgICAgIHVwZGF0ZSgpO1xuICAgIH0pO1xuICB9KTtcbiAgc3RhcnRCdG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHZvaWQgcnVuU2V0dXAoYXJlYSwgc2NlbmVzLCBjaG9pY2UsIG9uRG9uZSkpO1xuICB1cGRhdGUoKTtcbn1cblxuZnVuY3Rpb24gcHJvZ3Jlc3NIdG1sKHBoYXNlOiBTZXR1cFBoYXNlLCBkb25lOiBudW1iZXIsIHRvdGFsOiBudW1iZXIpOiBzdHJpbmcge1xuICBjb25zdCBwZXJjZW50ID0gdG90YWwgPiAwID8gTWF0aC5yb3VuZCgoZG9uZSAvIHRvdGFsKSAqIDEwMCkgOiAxMDA7XG4gIGNvbnN0IGxhYmVsID1cbiAgICBwaGFzZSA9PT0gXCJlbG9cIlxuICAgICAgPyBgU2F2aW5nIHN0YXJ0aW5nIEVMTzogJHtkb25lfSBvZiAke3BsdXJhbCh0b3RhbCwgXCJzY2VuZVwiKX1gXG4gICAgICA6IGBVcGRhdGluZyBTdGFzaCByYXRpbmdzOiAke3BsdXJhbCh0b3RhbCwgXCJzY2VuZVwiKX1gO1xuICByZXR1cm4gYFxuICAgICAgPGRpdiBjbGFzcz1cInNiLXNldHVwIHNiLXNldHVwLXByb2dyZXNzXCI+XG4gICAgICAgIDxoMiBjbGFzcz1cInNiLXNldHVwLXRpdGxlXCI+U2V0dGluZyB1cCBFTE8uLi48L2gyPlxuICAgICAgICA8ZGl2IGNsYXNzPVwicHJvZ3Jlc3NcIj48ZGl2IGNsYXNzPVwicHJvZ3Jlc3MtYmFyXCIgcm9sZT1cInByb2dyZXNzYmFyXCIgc3R5bGU9XCJ3aWR0aDogJHtwZXJjZW50fSVcIiBhcmlhLXZhbHVlbm93PVwiJHtwZXJjZW50fVwiIGFyaWEtdmFsdWVtaW49XCIwXCIgYXJpYS12YWx1ZW1heD1cIjEwMFwiPjwvZGl2PjwvZGl2PlxuICAgICAgICA8cCBjbGFzcz1cInNiLXNldHVwLXByb2dyZXNzLWxhYmVsXCI+JHtsYWJlbH08L3A+XG4gICAgICAgIDxwIGNsYXNzPVwic2Itc2V0dXAtbm90ZVwiPllvdSBjYW4gY2xvc2UgU3Rhc2ggQmF0dGxlOyBzZXR1cCBrZWVwcyBnb2luZyB3aGlsZSB0aGlzIFN0YXNoIHRhYiBzdGF5cyBvcGVuLiBJZiB0aGUgdGFiIGNsb3NlcyBmaXJzdCwgU3Rhc2ggQmF0dGxlIGFza3MgYWdhaW4gbmV4dCB0aW1lLCBhbmQgcnVubmluZyBpdCBhZ2FpbiBpcyBzYWZlLjwvcD5cbiAgICAgIDwvZGl2PmA7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJ1blNldHVwKGFyZWE6IEhUTUxFbGVtZW50LCBzY2VuZXM6IFNjZW5lW10sIGNob2ljZTogQ2hvaWNlLCBvbkRvbmU6ICgpID0+IHZvaWQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgcnVubmluZyA9IHRydWU7XG4gIGFyZWEuaW5uZXJIVE1MID0gcHJvZ3Jlc3NIdG1sKFwiZWxvXCIsIDAsIDApO1xuICAvLyBBIHJlc2V0IGNsZWFycyB0aGUgXCJzZXR1cCBmaW5pc2hlZFwiIGZsYWcgZmlyc3QsIHNvIGlmIGl0J3MgaW50ZXJydXB0ZWQgU3Rhc2ggQmF0dGxlIGFza3MgYWdhaW5cbiAgaWYgKHN0YXRlLnNldHRpbmdzLmVsb1NldHVwQXQgJiYgIShhd2FpdCB1cGRhdGVTZXR0aW5nc05vdyh7IGVsb1NldHVwQXQ6IG51bGwsIGVsb1NldHVwTW9kZTogbnVsbCB9KSkpIHtcbiAgICBjb25zb2xlLndhcm4oXCJbU3Rhc2ggQmF0dGxlXSBDb3VsZG4ndCBjbGVhciB0aGUgc2V0dXAgZmxhZyBiZWZvcmUgcmVzZXR0aW5nIEVMTzsgY29udGludWluZ1wiKTtcbiAgfVxuICBsZXQgc3VtbWFyeTogU2V0dXBTdW1tYXJ5O1xuICB0cnkge1xuICAgIHN1bW1hcnkgPSBhd2FpdCBydW5FbG9TZXR1cChzY2VuZXMsIGNob2ljZS5zdGFydCwgY2hvaWNlLnN0YXNoUmF0aW5ncywgKHBoYXNlLCBkb25lLCB0b3RhbCkgPT4ge1xuICAgICAgYXJlYS5pbm5lckhUTUwgPSBwcm9ncmVzc0h0bWwocGhhc2UsIGRvbmUsIHRvdGFsKTtcbiAgICB9KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHJ1bm5pbmcgPSBmYWxzZTtcbiAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0gRUxPIHNldHVwIGZhaWxlZDpcIiwgZSk7XG4gICAgc2hvd0Vycm9yKFxuICAgICAgYXJlYSxcbiAgICAgIGBTZXR1cCBzdG9wcGVkIHBhcnR3YXk6ICR7ZXNjYXBlSHRtbChlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSkpfS4gUnVubmluZyBpdCBhZ2FpbiBpcyBzYWZlOyBpdCBvdmVyd3JpdGVzIHdoYXQgd2FzIHdyaXR0ZW4uYCxcbiAgICAgICgpID0+IHZvaWQgbG9hZENob2ljZXMoYXJlYSwgb25Eb25lKSxcbiAgICApO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIENhY2hlZCBzY2VuZXMgYW5kIGFueSBzYXZlZCBwYWlyIHByZWRhdGUgdGhlIG5ldyBFTE8gKGFuZCBwb3NzaWJseSB0aGUgbmV3IHJhdGluZ3MpXG4gIGF3YWl0IGNsZWFyU2NlbmVDYWNoZSgpO1xuICByZXNldFNodWZmbGUoKTtcbiAgcmVzZXRSdW5TdGF0ZSgpO1xuICBzdGF0ZS5jdXJyZW50UGFpciA9IHsgbGVmdDogbnVsbCwgcmlnaHQ6IG51bGwgfTtcbiAgc3RhdGUuY3VycmVudFJhbmtzID0geyBsZWZ0OiBudWxsLCByaWdodDogbnVsbCB9O1xuICBzYXZlU3RhdGUoKTtcblxuICBhd2FpdCBmaW5pc2hTZXR1cChhcmVhLCBzdW1tYXJ5LCBjaG9pY2UsIG9uRG9uZSk7XG59XG5cbi8qKiBTYXZlIHRoZSBjb21wbGV0aW9uIGZsYWdzIChyZXRyeWluZyBvbiByZXF1ZXN0KSwgdGhlbiBzaG93IHRoZSBzdW1tYXJ5LiAqL1xuYXN5bmMgZnVuY3Rpb24gZmluaXNoU2V0dXAoYXJlYTogSFRNTEVsZW1lbnQsIHN1bW1hcnk6IFNldHVwU3VtbWFyeSwgY2hvaWNlOiBDaG9pY2UsIG9uRG9uZTogKCkgPT4gdm9pZCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBzYXZlZCA9IGF3YWl0IHVwZGF0ZVNldHRpbmdzTm93KHtcbiAgICBlbG9TZXR1cEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgZWxvU2V0dXBNb2RlOiBjaG9pY2Uuc3RhcnQsXG4gICAgc3Rhc2hSYXRpbmdzOiBjaG9pY2Uuc3Rhc2hSYXRpbmdzLFxuICB9KTtcbiAgaWYgKCFzYXZlZCkge1xuICAgIC8vIFdpdGhvdXQgdGhlIGZsYWcsIHNldHVwIHdvdWxkIHNob3cgYWdhaW4gb24gdGhlIG5leHQgb3Blbjoga2VlcCBpdCBwZW5kaW5nIGhlcmUgdG9vXG4gICAgc3RhdGUuc2V0dGluZ3MgPSB7IC4uLnN0YXRlLnNldHRpbmdzLCBlbG9TZXR1cEF0OiBudWxsIH07XG4gICAgc2hvd0Vycm9yKFxuICAgICAgYXJlYSxcbiAgICAgIFwiWW91ciBFTE8gaXMgc2F2ZWQsIGJ1dCBTdGFzaCBCYXR0bGUgY291bGRuJ3QgcmVjb3JkIGluIFN0YXNoIHRoYXQgc2V0dXAgZmluaXNoZWQuXCIsXG4gICAgICAoKSA9PiB2b2lkIGZpbmlzaFNldHVwKGFyZWEsIHN1bW1hcnksIGNob2ljZSwgb25Eb25lKSxcbiAgICApO1xuICAgIHJldHVybjtcbiAgfVxuICBydW5uaW5nID0gZmFsc2U7XG5cbiAgY29uc3QgZWxvTGluZSA9XG4gICAgY2hvaWNlLnN0YXJ0ID09PSBcInJhdGluZ3NcIlxuICAgICAgPyBgJHtwbHVyYWwoc3VtbWFyeS5lbG9Xcml0dGVuLCBcInNjZW5lXCIpfSBnb3QgYSBzdGFydGluZyBFTE8gZnJvbSAke3N1bW1hcnkuZWxvV3JpdHRlbiA9PT0gMSA/IFwiaXRzXCIgOiBcInRoZWlyXCJ9IHJhdGluZy4gVW5yYXRlZCBzY2VuZXMgc3RheSB1bnJhdGVkIHVudGlsIHRoZXkgYmF0dGxlLmBcbiAgICAgIDogYCR7cGx1cmFsKHN1bW1hcnkuZWxvV3JpdHRlbiwgXCJzY2VuZVwiKX0gc3RhcnQgYXQgMTUwMCBFTE8uYDtcbiAgY29uc3QgY2xlYXJlZExpbmUgPVxuICAgIHN1bW1hcnkuZWxvQ2xlYXJlZCA+IDAgPyBgPGxpPiR7cGx1cmFsKHN1bW1hcnkuZWxvQ2xlYXJlZCwgXCJzY2VuZVwiKX0gd2l0aG91dCBhIFN0YXNoIHJhdGluZyBoYWQgYW4gb2xkIEVMTyByZW1vdmVkLjwvbGk+YCA6IFwiXCI7XG4gIGNvbnN0IG9wdGlvbkxhYmVsID0gY2hvaWNlLnN0YXNoUmF0aW5ncyA9PT0gXCJwZXJjZW50aWxlXCIgPyBcIlBlcmNlbnRpbGVcIiA6IFwiU3RyYWlnaHQtbGluZVwiO1xuICBjb25zdCByYXRpbmdzTGluZSA9XG4gICAgY2hvaWNlLnN0YXNoUmF0aW5ncyA9PT0gXCJvZmZcIlxuICAgICAgPyBcIlN0YXNoIHJhdGluZ3Mgd2VyZW4ndCBjaGFuZ2VkLCBhbmQgYmF0dGxlcyB3b24ndCBjaGFuZ2UgdGhlbS5cIlxuICAgICAgOiBzdW1tYXJ5LnJhdGluZ3NXcml0dGVuID09PSAwXG4gICAgICAgID8gYFN0YXNoIHJhdGluZ3MgYWxyZWFkeSBtYXRjaGVkICgke29wdGlvbkxhYmVsfSksIHNvIG5vbmUgY2hhbmdlZC4gQmF0dGxlcyBrZWVwIHRoZW0gaW4gc3RlcCBmcm9tIG5vdyBvbi5gXG4gICAgICAgIDogYCR7cGx1cmFsKHN1bW1hcnkucmF0aW5nc1dyaXR0ZW4sIFwiU3Rhc2ggcmF0aW5nXCIpfSB1cGRhdGVkICgke29wdGlvbkxhYmVsfSkuIEJhdHRsZXMga2VlcCB0aGVtIGluIHN0ZXAgZnJvbSBub3cgb24uYDtcblxuICBhcmVhLmlubmVySFRNTCA9IGBcbiAgICAgIDxkaXYgY2xhc3M9XCJzYi1zZXR1cCBzYi1zZXR1cC1kb25lXCI+XG4gICAgICAgIDxoMiBjbGFzcz1cInNiLXNldHVwLXRpdGxlXCI+4pyFIEVMTyBpcyByZWFkeTwvaDI+XG4gICAgICAgIDx1bCBjbGFzcz1cInNiLXNldHVwLXN1bW1hcnlcIj5cbiAgICAgICAgICA8bGk+JHtlbG9MaW5lfTwvbGk+XG4gICAgICAgICAgJHtjbGVhcmVkTGluZX1cbiAgICAgICAgICA8bGk+JHtyYXRpbmdzTGluZX08L2xpPlxuICAgICAgICA8L3VsPlxuICAgICAgICA8ZGl2IGNsYXNzPVwic2Itc2V0dXAtYWN0aW9uc1wiPlxuICAgICAgICAgIDxidXR0b24gdHlwZT1cImJ1dHRvblwiIGNsYXNzPVwiYnRuIGJ0bi1wcmltYXJ5XCIgZGF0YS1yb2xlPVwiZG9uZVwiPlN0YXJ0IGJhdHRsaW5nPC9idXR0b24+XG4gICAgICAgIDwvZGl2PlxuICAgICAgPC9kaXY+YDtcbiAgYXJlYS5xdWVyeVNlbGVjdG9yKCdbZGF0YS1yb2xlPVwiZG9uZVwiXScpPy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4ge1xuICAgIGhpZGVTZXR1cFNjcmVlbihhcmVhLm93bmVyRG9jdW1lbnQpO1xuICAgIG9uRG9uZSgpO1xuICB9KTtcbn1cblxuZnVuY3Rpb24gZXNjYXBlSHRtbCh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gdGV4dC5yZXBsYWNlKC9bJjw+XCJdL2csIChjKSA9PiAoeyBcIiZcIjogXCImYW1wO1wiLCBcIjxcIjogXCImbHQ7XCIsIFwiPlwiOiBcIiZndDtcIiwgJ1wiJzogXCImcXVvdDtcIiB9KVtjXSBhcyBzdHJpbmcpO1xufVxuXG5mdW5jdGlvbiBzaG93RXJyb3IoYXJlYTogSFRNTEVsZW1lbnQsIG1lc3NhZ2U6IHN0cmluZywgcmV0cnk6ICgpID0+IHZvaWQpOiB2b2lkIHtcbiAgYXJlYS5pbm5lckhUTUwgPSBgXG4gICAgICA8ZGl2IGNsYXNzPVwic2Itc2V0dXAgc2ItZXJyb3Itc2NyZWVuXCI+XG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi1lcnJvci1pY29uXCI+4pqg77iPPC9kaXY+XG4gICAgICAgIDxwIGNsYXNzPVwic2ItZXJyb3ItbWVzc2FnZVwiPiR7bWVzc2FnZX08L3A+XG4gICAgICAgIDxidXR0b24gdHlwZT1cImJ1dHRvblwiIGNsYXNzPVwiYnRuIGJ0bi1wcmltYXJ5XCIgZGF0YS1yb2xlPVwicmV0cnlcIj5UcnkgYWdhaW48L2J1dHRvbj5cbiAgICAgIDwvZGl2PmA7XG4gIGFyZWEucXVlcnlTZWxlY3RvcignW2RhdGEtcm9sZT1cInJldHJ5XCJdJyk/LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCByZXRyeSk7XG59XG4iLCAiLy8gVGhlIGJhdHRsZSBtb2RhbDogb3BlbnMvY2xvc2VzLCB3aXJlcyBjb250cm9scyBhbmQga2V5Ym9hcmQgc2hvcnRjdXRzLlxuXG5pbXBvcnQgeyBjbGVhclNjZW5lQ2FjaGUgfSBmcm9tIFwiLi4vY2FjaGVcIjtcbmltcG9ydCB7IGZldGNoU2V0dXBTY2VuZXMgfSBmcm9tIFwiLi4vZWxvU2V0dXBcIjtcbmltcG9ydCB7IGdldFNjZW5lSWRGcm9tVXJsLCBob2xkU3Rhc2hMaXN0UmVmcmVzaCwgc2NlbmVDdXN0b21GaWVsZHNTdXBwb3J0ZWQgfSBmcm9tIFwiLi4vZ3JhcGhxbFwiO1xuaW1wb3J0IHsgYXBwbHlTdGFzaFJhdGluZ3MsIHF1ZXVlUmF0aW5nV3JpdGUsIFNDRU5FX01JU1NJTkdfRVZFTlQsIHNjaGVkdWxlU3Rhc2hSYXRpbmdTeW5jLCB3cml0ZVN0YXNoUmF0aW5ncyB9IGZyb20gXCIuLi9yYXRpbmdcIjtcbmltcG9ydCB7IHN0YXNoUmF0aW5nQ2hhbmdlcyB9IGZyb20gXCIuLi9zY29yZVwiO1xuaW1wb3J0IHsgbG9hZFNldHRpbmdzIH0gZnJvbSBcIi4uL3NldHRpbmdzXCI7XG5pbXBvcnQgeyBpc0Vsb1NldHVwUGVuZGluZywgcmVzZXRSdW5TdGF0ZSwgcmVzZXRTaHVmZmxlLCBzdGF0ZSB9IGZyb20gXCIuLi9zdGF0ZVwiO1xuaW1wb3J0IHsgbG9hZFN0YXRlLCBzYXZlU3RhdGUgfSBmcm9tIFwiLi4vc3RvcmFnZVwiO1xuaW1wb3J0IHR5cGUgeyBNb2RlLCBTZXR0aW5ncywgU3Rhc2hSYXRpbmdzTW9kZSB9IGZyb20gXCIuLi90eXBlc1wiO1xuaW1wb3J0IHsgY2FuY2VsQ29uZmlybURpYWxvZywgY29uZmlybURpYWxvZywgaXNDb25maXJtRGlhbG9nT3BlbiB9IGZyb20gXCIuL2NvbmZpcm1EaWFsb2dcIjtcbmltcG9ydCB7IGNhbmNlbERlbGV0ZURpYWxvZywgaXNEZWxldGVEaWFsb2dPcGVuIH0gZnJvbSBcIi4vZGVsZXRlRGlhbG9nXCI7XG5pbXBvcnQge1xuICBhcHBseVByZXZpZXdTZXR0aW5ncyxcbiAgY3JlYXRlTWFpblVJLFxuICBoYW5kbGVTY2VuZUdvbmUsXG4gIGxvYWROZXdQYWlyLFxuICByZW5kZXJQYWlyLFxuICByZXN0b3JlQ3VycmVudFBhaXIsXG4gIHNraXBQYWlyLFxuICB1cGRhdGVDbGltYlBvb2xXYXJuaW5nLFxuICB1cGRhdGVNb2RlSW5mbyxcbiAgdXBkYXRlUmF0aW5nc05vdGUsXG4gIHZlcmlmeUN1cnJlbnRQYWlyLFxufSBmcm9tIFwiLi9tYWluVUlcIjtcbmltcG9ydCB7IGJpbmRTZXR0aW5nc0NvbnRyb2xzLCBnZXRBY3RpdmVUYWIsIHNob3dUYWIsIHN5bmNTZXR0aW5nc0NvbnRyb2xzIH0gZnJvbSBcIi4vc2V0dGluZ3NQYW5lbFwiO1xuaW1wb3J0IHsgcmVmcmVzaFNjZW5lRWxvIH0gZnJvbSBcIi4vc2NlbmVFbG9cIjtcbmltcG9ydCB7IGhpZGVTZXR1cFNjcmVlbiwgaXNTZXR1cFJ1bm5pbmcsIHNob3dTZXR1cFNjcmVlbiB9IGZyb20gXCIuL3NldHVwU2NyZWVuXCI7XG5pbXBvcnQgeyBzdGFzaFJhdGluZ3NPcHRpb24gfSBmcm9tIFwiLi9zdGFzaFJhdGluZ3NUZXh0XCI7XG5cbi8vIFRyYWNrIGtleWJvYXJkIGhhbmRsZXIgc28gd2UgY2FuIHJlbW92ZSBpdCBvbiBjbG9zZVxubGV0IG1vZGFsS2V5SGFuZGxlcjogKChlOiBLZXlib2FyZEV2ZW50KSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xubGV0IHNjZW5lTWlzc2luZ0xpc3RlbmVyQWRkZWQgPSBmYWxzZTtcblxuLyoqIE9uIDxib2R5PiB3aGlsZSBCYXR0bGUgaXMgb3BlbjsgQ1NTIHVzZXMgaXQgdG8gbGlmdCBTdGFzaCdzIG93biBtb2RhbHMgYWJvdmUgb3Vycy4gKi9cbmNvbnN0IEJBVFRMRV9PUEVOX0NMQVNTID0gXCJzYi1iYXR0bGUtb3BlblwiO1xuXG4vKiogUmUtcmVuZGVyIHRoZSBwYWlyIG9uIHNjcmVlbiBzbyBjYXJkIG1hcmt1cCBwaWNrcyB1cCBhIGNoYW5nZWQgc2V0dGluZy4gKi9cbmZ1bmN0aW9uIHJlcmVuZGVyQ3VycmVudFBhaXIoKTogdm9pZCB7XG4gIGNvbnN0IHsgbGVmdCwgcmlnaHQgfSA9IHN0YXRlLmN1cnJlbnRQYWlyO1xuICBpZiAoIWxlZnQgfHwgIXJpZ2h0IHx8IHN0YXRlLmRpc2FibGVDaG9pY2UgfHwgIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoXCIjc2ItY29tcGFyaXNvbi1hcmVhIC5zYi12cy1jb250YWluZXJcIikpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgcmVuZGVyUGFpcihbbGVmdCwgcmlnaHRdLCBbc3RhdGUuY3VycmVudFJhbmtzLmxlZnQsIHN0YXRlLmN1cnJlbnRSYW5rcy5yaWdodF0pO1xufVxuXG4vKipcbiAqIEJlZm9yZSB0aGUgXCJTdGFzaCByYXRpbmdzXCIgZHJvcGRvd24gY2hhbmdlczogc3dpdGNoaW5nIHRvIFBlcmNlbnRpbGUgb3IgU3RyYWlnaHQtbGluZSB3YXJucyBob3dcbiAqIG1hbnkgU3Rhc2ggcmF0aW5ncyBjaGFuZ2UgYW5kIHN5bmNzIHRoZW0gYWxsIG9uIGNvbmZpcm0gKGZhbHNlIHB1dHMgdGhlIGRyb3Bkb3duIGJhY2spLlxuICogU3dpdGNoaW5nIHRvIERvbid0IHVwZGF0ZSwgb3IgYSBzd2l0Y2ggdGhhdCBjaGFuZ2VzIG5vdGhpbmcsIG5lZWRzIG5vIHdhcm5pbmcuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGNvbmZpcm1TZXR0aW5nQ2hhbmdlKGtleToga2V5b2YgU2V0dGluZ3MsIHZhbHVlOiBzdHJpbmcpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgaWYgKGtleSAhPT0gXCJzdGFzaFJhdGluZ3NcIikgcmV0dXJuIHRydWU7XG4gIGNvbnN0IG5leHQgPSB2YWx1ZSBhcyBTdGFzaFJhdGluZ3NNb2RlO1xuICBpZiAobmV4dCA9PT0gXCJvZmZcIiB8fCBuZXh0ID09PSBzdGF0ZS5zZXR0aW5ncy5zdGFzaFJhdGluZ3MpIHJldHVybiB0cnVlO1xuXG4gIGxldCBjaGFuZ2VzOiBNYXA8c3RyaW5nLCBudW1iZXI+O1xuICB0cnkge1xuICAgIGNoYW5nZXMgPSBzdGFzaFJhdGluZ0NoYW5nZXMoYXdhaXQgZmV0Y2hTZXR1cFNjZW5lcygpLCBuZXh0KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnNvbGUuZXJyb3IoXCJbU3Rhc2ggQmF0dGxlXSBDb3VsZG4ndCBsb2FkIHNjZW5lcyB0byBzd2l0Y2ggU3Rhc2ggcmF0aW5nczpcIiwgZSk7XG4gICAgYXdhaXQgY29uZmlybURpYWxvZyh7XG4gICAgICB0aXRsZTogXCJDb3VsZG4ndCBsb2FkIHlvdXIgc2NlbmVzXCIsXG4gICAgICBib2R5OiBcIjxwPlN0YXNoIEJhdHRsZSBuZWVkcyB5b3VyIHdob2xlIGxpYnJhcnkgdG8gd29yayBvdXQgdGhlIG5ldyBTdGFzaCByYXRpbmdzLiBOb3RoaW5nIHdhcyBjaGFuZ2VkOyB0cnkgYWdhaW4uPC9wPlwiLFxuICAgICAgY29uZmlybUxhYmVsOiBcIk9LXCIsXG4gICAgfSk7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIGlmIChjaGFuZ2VzLnNpemUgPT09IDApIHJldHVybiB0cnVlO1xuXG4gIGNvbnN0IHsgbGFiZWwsIGRlc2MgfSA9IHN0YXNoUmF0aW5nc09wdGlvbihuZXh0KTtcbiAgY29uc3QgY291bnQgPSBgJHtjaGFuZ2VzLnNpemV9IFN0YXNoIHJhdGluZyR7Y2hhbmdlcy5zaXplID09PSAxID8gXCJcIiA6IFwic1wifWA7XG4gIHJldHVybiBjb25maXJtRGlhbG9nKHtcbiAgICB0aXRsZTogYFN3aXRjaCBTdGFzaCByYXRpbmdzIHVwZGF0ZSBtb2RlIHRvICR7bGFiZWx9P2AsXG4gICAgYm9keTogYFxuICAgICAgICA8cD4ke2Rlc2N9PC9wPlxuICAgICAgICA8cD48c3Ryb25nPiR7Y291bnR9IGNoYW5nZSBub3cuPC9zdHJvbmc+IEFmdGVyIHRoYXQsIGJhdHRsZXMga2VlcCBTdGFzaCByYXRpbmdzIGluIHN0ZXAgd2l0aFxuICAgICAgICBFTE8sIGFuZCBhIHN0YXIgcmF0aW5nIHlvdSBjaGFuZ2UgYnkgaGFuZCBpbiBTdGFzaCBpcyBvdmVyd3JpdHRlbiB0aGUgbmV4dCB0aW1lIFN0YXNoIEJhdHRsZVxuICAgICAgICB3cml0ZXMgdGhhdCBzY2VuZS48L3A+XG4gICAgICAgIDxwPlRha2UgYSBTdGFzaCBiYWNrdXAgZmlyc3QgKFNldHRpbmdzIOKGkiBUYXNrcyDihpIgQmFja3VwKS48L3A+YCxcbiAgICBjb25maXJtTGFiZWw6IGBVcGRhdGUgJHtjb3VudH1gLFxuICAgIHdvcmtpbmdMYWJlbDogXCJVcGRhdGluZy4uLlwiLFxuICAgIGFjdGlvbjogKCkgPT5cbiAgICAgIHF1ZXVlUmF0aW5nV3JpdGUoYXN5bmMgKCkgPT4ge1xuICAgICAgICBhd2FpdCB3cml0ZVN0YXNoUmF0aW5ncyhjaGFuZ2VzKTtcbiAgICAgICAgYXBwbHlTdGFzaFJhdGluZ3MoY2hhbmdlcyk7XG4gICAgICB9KSxcbiAgfSk7XG59XG5cbi8qKiBTZXR0aW5ncyDihpIgUmVzZXQgRUxPOiBjb25maXJtLCB0aGVuIHNob3cgdGhlIHNldHVwIGNob2ljZXMgYWdhaW4gKENhbmNlbCBnb2VzIGJhY2spLiAqL1xuYXN5bmMgZnVuY3Rpb24gc3RhcnRSZXNldEVsbyhtb2RhbDogSFRNTEVsZW1lbnQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgcmF0aW5nc09uID0gc3RhdGUuc2V0dGluZ3Muc3Rhc2hSYXRpbmdzICE9PSBcIm9mZlwiO1xuICBjb25zdCBvayA9IGF3YWl0IGNvbmZpcm1EaWFsb2coe1xuICAgIHRpdGxlOiBcIlJlc2V0IEVMTz9cIixcbiAgICBib2R5OiBgXG4gICAgICAgIDxwPkV2ZXJ5IHNjZW5lJ3MgRUxPIGFuZCBiYXR0bGUgY291bnQgd2lsbCBiZSBvdmVyd3JpdHRlbi4gTmV4dCB5b3UgY2hvb3NlIGhvdyBFTE8gc3RhcnRzXG4gICAgICAgIGFnYWluOiBmcm9tIHlvdXIgU3Rhc2ggcmF0aW5ncywgb3IgMTUwMCBmb3IgZXZlcnlvbmUuJHtyYXRpbmdzT24gPyBcIiBTdGFzaCByYXRpbmdzIGFyZSB0aGVuIHVwZGF0ZWQgZnJvbSB0aGUgbmV3IEVMTy5cIiA6IFwiXCJ9PC9wPlxuICAgICAgICA8cD5Ob3RoaW5nIGNoYW5nZXMgdW50aWwgeW91IHByZXNzIFN0YXJ0IG9uIHRoZSBuZXh0IHNjcmVlbi48L3A+YCxcbiAgICBjb25maXJtTGFiZWw6IFwiQ29udGludWVcIixcbiAgfSk7XG4gIGlmICghb2spIHJldHVybjtcblxuICBzdGF0ZS5yZXNldHRpbmdFbG8gPSB0cnVlO1xuICBzaG93VGFiKG1vZGFsLCBcImJhdHRsZVwiKTtcbiAgbW9kYWwucXVlcnlTZWxlY3RvckFsbDxIVE1MVmlkZW9FbGVtZW50PihcIi5zYi1ob3Zlci1wcmV2aWV3XCIpLmZvckVhY2goKHYpID0+IHYucGF1c2UoKSk7XG4gIHNob3dTZXR1cFNjcmVlbihtb2RhbCwgKCkgPT4gYWZ0ZXJTZXR1cChtb2RhbCksIHtcbiAgICByZXNldDogdHJ1ZSxcbiAgICBvbkNhbmNlbDogKCkgPT4ge1xuICAgICAgc3RhdGUucmVzZXR0aW5nRWxvID0gZmFsc2U7XG4gICAgICBoaWRlU2V0dXBTY3JlZW4obW9kYWwpO1xuICAgICAgaWYgKHN0YXRlLmN1cnJlbnRQYWlyLmxlZnQgJiYgc3RhdGUuY3VycmVudFBhaXIucmlnaHQpIHZvaWQgcmVzdG9yZUN1cnJlbnRQYWlyKCk7XG4gICAgICBlbHNlIHZvaWQgbG9hZE5ld1BhaXIoKTtcbiAgICB9LFxuICB9KTtcbn1cblxuLyoqIFNldHVwIChmaXJzdCB0aW1lIG9yIFJlc2V0IEVMTykgZmluaXNoZWQ6IHNldHRpbmdzIGl0IHNhdmVkIHNob3csIHRoZW4gYmF0dGxlcyBzdGFydC4gKi9cbmZ1bmN0aW9uIGFmdGVyU2V0dXAobW9kYWw6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIHN0YXRlLnJlc2V0dGluZ0VsbyA9IGZhbHNlO1xuICBzeW5jU2V0dGluZ3NDb250cm9scyhtb2RhbCk7XG4gIHVwZGF0ZVJhdGluZ3NOb3RlKCk7XG4gIHZvaWQgbG9hZE5ld1BhaXIoZ2V0U2NlbmVJZEZyb21VcmwoKSk7XG59XG5cbmZ1bmN0aW9uIG9uU2V0dGluZ0NoYW5nZWQoa2V5OiBrZXlvZiBTZXR0aW5ncyk6IHZvaWQge1xuICBzd2l0Y2ggKGtleSkge1xuICAgIGNhc2UgXCJzdGFzaFJhdGluZ3NcIjpcbiAgICAgIHVwZGF0ZVJhdGluZ3NOb3RlKCk7XG4gICAgICAvLyBDYXRjaCBhbnl0aGluZyBhIHBlci1iYXR0bGUgc3luYyB1bmRlciB0aGUgb2xkIG1vZGUgY2hhbmdlZCBhZnRlciB0aGUgc3dpdGNoIHdhcyBjb3VudGVkXG4gICAgICBzY2hlZHVsZVN0YXNoUmF0aW5nU3luYygpO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcImZpbHRlck9wcG9uZW50c1wiOlxuICAgICAgLy8gc3dpdGNoaW5nIHRoZSB0b2dnbGUgY291bnRzIGFzIGNoYW5naW5nIGZpbHRlcnM6IHJlc2V0IGFueSBydW5cbiAgICAgIGlmIChzdGF0ZS5jdXJyZW50TW9kZSAhPT0gXCJzd2lzc1wiKSByZXNldFJ1blN0YXRlKCk7XG4gICAgICBzYXZlU3RhdGUoKTtcbiAgICAgIGxvYWROZXdQYWlyKCk7XG4gICAgICB1cGRhdGVDbGltYlBvb2xXYXJuaW5nKCk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwicGxhY2VtZW50RnJvbUJvdHRvbVwiOiB7XG4gICAgICAvLyBSZXN0YXJ0IHRoZSBzY2VuZSdzIHJ1biBmcm9tIHRoZSBuZXcgc3RhcnQgcG9pbnQgKG5vdGhpbmcgaXMgd3JpdHRlbiB1bnRpbCBpdCBsYW5kcylcbiAgICAgIGNvbnN0IHNjZW5lSWQgPSBzdGF0ZS5jdXJyZW50TW9kZSA9PT0gXCJwbGFjZW1lbnRcIiA/IHN0YXRlLnBsYWNlbWVudD8uc2NlbmUuaWQgOiB1bmRlZmluZWQ7XG4gICAgICBpZiAoc2NlbmVJZCkge1xuICAgICAgICByZXNldFJ1blN0YXRlKCk7XG4gICAgICAgIHNhdmVTdGF0ZSgpO1xuICAgICAgICB2b2lkIGxvYWROZXdQYWlyKHNjZW5lSWQpO1xuICAgICAgfVxuICAgICAgYnJlYWs7XG4gICAgfVxuICAgIGNhc2UgXCJwcmV2aWV3Vm9sdW1lXCI6XG4gICAgY2FzZSBcImF1dG9wbGF5UHJldmlld3NcIjpcbiAgICAgIGFwcGx5UHJldmlld1NldHRpbmdzKCk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwib3BlbkluTmV3VGFiXCI6XG4gICAgY2FzZSBcImNsZWFuTW9kZVwiOlxuICAgIGNhc2UgXCJzaG93VGllcnNcIjpcbiAgICAgIHJlcmVuZGVyQ3VycmVudFBhaXIoKTtcbiAgICAgIGJyZWFrO1xuICB9XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBvcGVuTW9kYWwoKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+OryBPcGVuaW5nIG1vZGFsLi4uXCIpO1xuXG4gIGNvbnN0IFtzZXR0aW5nc09rLCBjdXN0b21GaWVsZHNPa10gPSBhd2FpdCBQcm9taXNlLmFsbChbbG9hZFNldHRpbmdzKCksIHNjZW5lQ3VzdG9tRmllbGRzU3VwcG9ydGVkKCldKTtcbiAgaWYgKCFjdXN0b21GaWVsZHNPaykge1xuICAgIHNob3dNZXNzYWdlTW9kYWwoXG4gICAgICBcIlN0YXNoIEJhdHRsZSBuZWVkcyBhIG5ld2VyIHZlcnNpb24gb2YgU3Rhc2g6IGl0IHN0b3JlcyBlYWNoIHNjZW5lJ3MgRUxPIGluIHNjZW5lIGN1c3RvbSBmaWVsZHMsIHdoaWNoIHRoaXMgU3Rhc2ggZG9lc24ndCBoYXZlLiBVcGRhdGUgU3Rhc2ggdG8gdXNlIFN0YXNoIEJhdHRsZS5cIixcbiAgICApO1xuICAgIHJldHVybjtcbiAgfVxuICAvLyBXaXRob3V0IHNldHRpbmdzLCBCYXR0bGUgY2FuJ3QgdGVsbCB3aGV0aGVyIHRoZSBvbmUtdGltZSBFTE8gc2V0dXAgYWxyZWFkeSByYW4gKGFuZCBydW5uaW5nXG4gIC8vIGl0IGFnYWluIHdvdWxkIG92ZXJ3cml0ZSBldmVyeSBzY2VuZSdzIEVMTylcbiAgaWYgKCFzZXR0aW5nc09rICYmIGlzRWxvU2V0dXBQZW5kaW5nKCkpIHtcbiAgICBzaG93TWVzc2FnZU1vZGFsKFwiU3Rhc2ggQmF0dGxlIGNvdWxkbid0IGxvYWQgaXRzIHNldHRpbmdzIGZyb20gU3Rhc2guIENsb3NlIFN0YXNoIEJhdHRsZSBhbmQgdHJ5IGFnYWluLlwiKTtcbiAgICByZXR1cm47XG4gIH1cbiAgYWRkS2V5U3dhbGxvd2VycygpO1xuICBob2xkU3Rhc2hMaXN0UmVmcmVzaCh0cnVlKTtcblxuICAvLyBPcHRpb25hbGx5IHBhdXNlIHdoYXRldmVyIFN0YXNoIGlzIHBsYXlpbmcgc28gaXQgZG9lc24ndCBvdmVybGFwIHRoZSBiYXR0bGUgcHJldmlld3NcbiAgaWYgKHN0YXRlLnNldHRpbmdzLnBhdXNlTWVkaWFPbk9wZW4pIHtcbiAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxNZWRpYUVsZW1lbnQ+KFwidmlkZW8sIGF1ZGlvXCIpLmZvckVhY2goKHYpID0+IHYucGF1c2UoKSk7XG4gIH1cblxuICBpZiAoIXNjZW5lTWlzc2luZ0xpc3RlbmVyQWRkZWQpIHtcbiAgICBzY2VuZU1pc3NpbmdMaXN0ZW5lckFkZGVkID0gdHJ1ZTtcbiAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcihTQ0VORV9NSVNTSU5HX0VWRU5ULCAoZSkgPT4ge1xuICAgICAgdm9pZCBoYW5kbGVTY2VuZUdvbmUoKGUgYXMgQ3VzdG9tRXZlbnQ8c3RyaW5nPikuZGV0YWlsKTtcbiAgICB9KTtcbiAgfVxuXG4gIC8vIFRyeSB0byBsb2FkIHNhdmVkIHN0YXRlXG4gIGNvbnN0IGhhc1N0YXRlID0gbG9hZFN0YXRlKCk7XG4gIGNvbnNvbGUubG9nKGBbU3Rhc2ggQmF0dGxlXSDwn5OLIExvY2FsU3RvcmFnZSBzdGF0ZTogJHtoYXNTdGF0ZSA/IFwiZm91bmRcIiA6IFwibm9uZVwifWApO1xuXG4gIC8vIENoZWNrIGlmIFVSTCBmaWx0ZXIgcGFyYW1zIGhhdmUgY2hhbmdlZCAtIGlmIHNvLCByZXNldCBzdGF0ZVxuICBjb25zdCBjdXJyZW50RmlsdGVyUGFyYW1zID0gd2luZG93LmxvY2F0aW9uLnNlYXJjaDtcbiAgY29uc3QgZmlsdGVyc0NoYW5nZWQgPSBoYXNTdGF0ZSAmJiBzdGF0ZS5zYXZlZEZpbHRlclBhcmFtcyAhPT0gY3VycmVudEZpbHRlclBhcmFtcztcblxuICBpZiAoZmlsdGVyc0NoYW5nZWQpIHtcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIEZpbHRlciBwYXJhbXMgY2hhbmdlZCwgcmVzZXR0aW5nIHJ1biBzdGF0ZSBhbmQgZmlsdGVyZWQgY2FjaGVcIik7XG4gICAgc3RhdGUuY3VycmVudFBhaXIgPSB7IGxlZnQ6IG51bGwsIHJpZ2h0OiBudWxsIH07XG4gICAgc3RhdGUuY3VycmVudFJhbmtzID0geyBsZWZ0OiBudWxsLCByaWdodDogbnVsbCB9O1xuICAgIHJlc2V0UnVuU3RhdGUoKTtcbiAgICBzdGF0ZS5zYXZlZEZpbHRlclBhcmFtcyA9IGN1cnJlbnRGaWx0ZXJQYXJhbXM7XG5cbiAgICAvLyBDbGVhciBmaWx0ZXJlZCBzY2VuZXMgY2FjaGUgKGJ1dCBrZWVwIGFsbCBzY2VuZXMgY2FjaGUpXG4gICAgc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXMgPSBudWxsO1xuICAgIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcktleSA9IG51bGw7XG5cbiAgICAvLyBSZXNldCBzaHVmZmxlIGZvciBuZXcgZmlsdGVyXG4gICAgcmVzZXRTaHVmZmxlKCk7XG4gIH1cblxuICAvLyBEZXRlY3QgaWYgb3BlbmVkIGZyb20gYW4gaW5kaXZpZHVhbCBzY2VuZSBwYWdlIChlLmcuIC9zY2VuZXMvMTIzKVxuICBjb25zdCBzY2VuZVBhZ2VJZCA9IGdldFNjZW5lSWRGcm9tVXJsKCk7XG4gIGNvbnN0IHNjZW5lQWxyZWFkeUluUGFpciA9XG4gICAgc2NlbmVQYWdlSWQgJiZcbiAgICBzdGF0ZS5jdXJyZW50UGFpci5sZWZ0ICYmXG4gICAgc3RhdGUuY3VycmVudFBhaXIucmlnaHQgJiZcbiAgICAoU3RyaW5nKHN0YXRlLmN1cnJlbnRQYWlyLmxlZnQuaWQpID09PSBzY2VuZVBhZ2VJZCB8fFxuICAgICAgU3RyaW5nKHN0YXRlLmN1cnJlbnRQYWlyLnJpZ2h0LmlkKSA9PT0gc2NlbmVQYWdlSWQpO1xuICBjb25zdCBmb3JjZVNjZW5lQmF0dGxlID0gc2NlbmVQYWdlSWQgJiYgIXNjZW5lQWxyZWFkeUluUGFpcjtcblxuICBpZiAoZm9yY2VTY2VuZUJhdHRsZSkge1xuICAgIGNvbnNvbGUubG9nKGBbU3Rhc2ggQmF0dGxlXSDwn46vIE9wZW5lZCBmcm9tIHNjZW5lIHBhZ2UgJHtzY2VuZVBhZ2VJZH0sIHN0YXJ0aW5nIG5ldyBiYXR0bGUgd2l0aCB0aGlzIHNjZW5lYCk7XG4gICAgcmVzZXRSdW5TdGF0ZSgpO1xuICAgIHN0YXRlLmN1cnJlbnRQYWlyID0geyBsZWZ0OiBudWxsLCByaWdodDogbnVsbCB9O1xuICAgIHN0YXRlLmN1cnJlbnRSYW5rcyA9IHsgbGVmdDogbnVsbCwgcmlnaHQ6IG51bGwgfTtcbiAgfVxuXG4gIC8vIENoZWNrIGZvciBleGlzdGluZyBoaWRkZW4gbW9kYWwgLSByZXVzZSBpdCAodW5sZXNzIGl0J3MgYSBtZXNzYWdlIG1vZGFsLCBzZWUgc2hvd01lc3NhZ2VNb2RhbClcbiAgY29uc3QgZXhpc3RpbmdNb2RhbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic2ItbW9kYWxcIik7XG4gIGlmIChcbiAgICBleGlzdGluZ01vZGFsICYmXG4gICAgZXhpc3RpbmdNb2RhbC5jbGFzc0xpc3QuY29udGFpbnMoXCJzYi1tb2RhbC1oaWRkZW5cIikgJiZcbiAgICBleGlzdGluZ01vZGFsLnF1ZXJ5U2VsZWN0b3IoXCIjc3Rhc2gtYmF0dGxlLWNvbnRhaW5lclwiKVxuICApIHtcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIOKZu++4jyBSZXVzaW5nIGV4aXN0aW5nIG1vZGFsXCIpO1xuICAgIGV4aXN0aW5nTW9kYWwuY2xhc3NMaXN0LnJlbW92ZShcInNiLW1vZGFsLWhpZGRlblwiLCBcInNiLW1vZGFsLWNsb3NpbmdcIik7XG4gICAgZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QuYWRkKEJBVFRMRV9PUEVOX0NMQVNTKTtcblxuICAgIC8vIEFsd2F5cyByZW9wZW4gb24gdGhlIEJhdHRsZSB0YWI7IHNldHRpbmdzIG1heSBoYXZlIGNoYW5nZWQgZWxzZXdoZXJlIG1lYW53aGlsZVxuICAgIHNob3dUYWIoZXhpc3RpbmdNb2RhbCwgXCJiYXR0bGVcIik7XG4gICAgc3luY1NldHRpbmdzQ29udHJvbHMoZXhpc3RpbmdNb2RhbCk7XG4gICAgdXBkYXRlUmF0aW5nc05vdGUoKTtcblxuICAgIC8vIFJlLXJlZ2lzdGVyIGtleWJvYXJkIGhhbmRsZXJcbiAgICBpZiAobW9kYWxLZXlIYW5kbGVyKSB7XG4gICAgICBkb2N1bWVudC5yZW1vdmVFdmVudExpc3RlbmVyKFwia2V5ZG93blwiLCBtb2RhbEtleUhhbmRsZXIsIHRydWUpO1xuICAgICAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcImtleWRvd25cIiwgbW9kYWxLZXlIYW5kbGVyLCB0cnVlKTtcbiAgICB9XG5cbiAgICAvLyBGb2N1cyBtb2RhbCBjb250ZW50XG4gICAgY29uc3QgbW9kYWxDb250ZW50ID0gZXhpc3RpbmdNb2RhbC5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIi5zYi1tb2RhbC1jb250ZW50XCIpO1xuICAgIGlmIChtb2RhbENvbnRlbnQpIG1vZGFsQ29udGVudC5mb2N1cygpO1xuXG4gICAgLy8gVGhlIG9uZS10aW1lIEVMTyBzZXR1cCBzaG93cyBpbiBwbGFjZSBvZiB0aGUgYmF0dGxlIHVudGlsIGl0J3MgZG9uZVxuICAgIGlmIChpc0Vsb1NldHVwUGVuZGluZygpKSB7XG4gICAgICBzaG93U2V0dXBTY3JlZW4oZXhpc3RpbmdNb2RhbCwgKCkgPT4gYWZ0ZXJTZXR1cChleGlzdGluZ01vZGFsKSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGhpZGVTZXR1cFNjcmVlbihleGlzdGluZ01vZGFsKTtcblxuICAgIC8vIElmIGZpbHRlcnMgY2hhbmdlZCwgbm8gcGFpciwgb3IgZm9yY2VkIHNjZW5lLCBsb2FkIG5ldyBjb250ZW50XG4gICAgaWYgKGZvcmNlU2NlbmVCYXR0bGUpIHtcbiAgICAgIGxvYWROZXdQYWlyKHNjZW5lUGFnZUlkKTtcbiAgICB9IGVsc2UgaWYgKGZpbHRlcnNDaGFuZ2VkKSB7XG4gICAgICBsb2FkTmV3UGFpcigpO1xuICAgIH0gZWxzZSBpZiAoIXN0YXRlLmN1cnJlbnRQYWlyLmxlZnQgfHwgIXN0YXRlLmN1cnJlbnRQYWlyLnJpZ2h0KSB7XG4gICAgICAvLyBBIGZpbmlzaGVkIHJ1bidzIGVuZCBzY3JlZW4gc3RheXMgdW50aWwgXCJTdGFydCBOZXcgUnVuXCIgKHRoZSBydW4gY2xlYXJlZCBpdHMgcGFpcilcbiAgICAgIGlmICghZG9jdW1lbnQucXVlcnlTZWxlY3RvcihcIiNzYi1jb21wYXJpc29uLWFyZWEgLnNiLWVuZC1zY3JlZW5cIikpIGxvYWROZXdQYWlyKCk7XG4gICAgfSBlbHNlIGlmIChkb2N1bWVudC5xdWVyeVNlbGVjdG9yKFwiI3NiLWNvbXBhcmlzb24tYXJlYSAuc2ItdnMtY29udGFpbmVyXCIpKSB7XG4gICAgICAvLyBFeGlzdGluZyBwYWlyIGlzIHN0aWxsIHZhbGlkIHVubGVzcyBhIHNjZW5lIHdhcyBkZWxldGVkIGVsc2V3aGVyZSBtZWFud2hpbGVcbiAgICAgIGFwcGx5UHJldmlld1NldHRpbmdzKCk7XG4gICAgICB2b2lkIHZlcmlmeUN1cnJlbnRQYWlyKCk7XG4gICAgfVxuXG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gUmVtb3ZlIGFueSBvdGhlciBleGlzdGluZyBtb2RhbCAoYSBtZXNzYWdlIG1vZGFsLCBvciBhIHZpc2libGUgb25lLCB3aGljaCBzaG91bGRuJ3QgaGFwcGVuKVxuICBpZiAoZXhpc3RpbmdNb2RhbCkgZXhpc3RpbmdNb2RhbC5yZW1vdmUoKTtcblxuICAvLyBJbml0aWFsaXplIGZpbHRlciBwYXJhbXMgdHJhY2tpbmdcbiAgaWYgKCFzdGF0ZS5zYXZlZEZpbHRlclBhcmFtcykge1xuICAgIHN0YXRlLnNhdmVkRmlsdGVyUGFyYW1zID0gY3VycmVudEZpbHRlclBhcmFtcztcbiAgfVxuXG4gIGNvbnN0IG1vZGFsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbW9kYWwuaWQgPSBcInNiLW1vZGFsXCI7XG4gIG1vZGFsLmlubmVySFRNTCA9IGBcbiAgICAgIDxkaXYgY2xhc3M9XCJzYi1tb2RhbC1iYWNrZHJvcFwiPjwvZGl2PlxuICAgICAgPGRpdiBjbGFzcz1cInNiLW1vZGFsLWNvbnRlbnRcIj5cbiAgICAgICAgPGJ1dHRvbiBjbGFzcz1cInNiLW1vZGFsLWNsb3NlXCIgYXJpYS1sYWJlbD1cIkNsb3NlXCI+4pyVPC9idXR0b24+XG4gICAgICAgICR7Y3JlYXRlTWFpblVJKCl9XG4gICAgICA8L2Rpdj5cbiAgICBgO1xuXG4gIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQobW9kYWwpO1xuICBkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5hZGQoQkFUVExFX09QRU5fQ0xBU1MpO1xuXG4gIC8vIEZvY3VzIHRoZSBtb2RhbCBjb250ZW50IHNvIGtleWJvYXJkIHNob3J0Y3V0cyB3b3JrIGltbWVkaWF0ZWx5XG4gIGNvbnN0IG1vZGFsQ29udGVudCA9IG1vZGFsLnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiLnNiLW1vZGFsLWNvbnRlbnRcIik7XG4gIGlmIChtb2RhbENvbnRlbnQpIHtcbiAgICBtb2RhbENvbnRlbnQuc2V0QXR0cmlidXRlKFwidGFiaW5kZXhcIiwgXCItMVwiKTtcbiAgICBtb2RhbENvbnRlbnQuc3R5bGUub3V0bGluZSA9IFwibm9uZVwiO1xuICAgIG1vZGFsQ29udGVudC5mb2N1cygpO1xuICB9XG5cbiAgLy8gTW9kZSB0b2dnbGUgYnV0dG9uc1xuICBtb2RhbC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PihcIi5zYi1tb2RlLWJ0blwiKS5mb3JFYWNoKChidG4pID0+IHtcbiAgICBidG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHtcbiAgICAgIGNvbnN0IG5ld01vZGUgPSBidG4uZGF0YXNldC5tb2RlIGFzIE1vZGU7XG4gICAgICBpZiAobmV3TW9kZSAhPT0gc3RhdGUuY3VycmVudE1vZGUpIHtcbiAgICAgICAgc3RhdGUuY3VycmVudE1vZGUgPSBuZXdNb2RlO1xuXG4gICAgICAgIHJlc2V0UnVuU3RhdGUoKTtcblxuICAgICAgICAvLyBSZXNldCBzaHVmZmxlIHRvIHN0YXJ0IGZyZXNoIHdpdGggbmV3IG1vZGVcbiAgICAgICAgc3RhdGUuc2h1ZmZsZUluZGV4ID0gMDtcblxuICAgICAgICAvLyBVcGRhdGUgYnV0dG9uIHN0YXRlc1xuICAgICAgICBtb2RhbC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PihcIi5zYi1tb2RlLWJ0blwiKS5mb3JFYWNoKChiKSA9PiB7XG4gICAgICAgICAgYi5jbGFzc0xpc3QudG9nZ2xlKFwiYWN0aXZlXCIsIGIuZGF0YXNldC5tb2RlID09PSBzdGF0ZS5jdXJyZW50TW9kZSk7XG4gICAgICAgIH0pO1xuICAgICAgICB1cGRhdGVNb2RlSW5mbygpO1xuXG4gICAgICAgIC8vIExvYWQgbmV3IHBhaXIgaW4gbmV3IG1vZGUsIHByZXNlcnZpbmcgc2NlbmUgcGFnZSBjb250ZXh0XG4gICAgICAgIGxvYWROZXdQYWlyKGdldFNjZW5lSWRGcm9tVXJsKCkpO1xuICAgICAgICB1cGRhdGVDbGltYlBvb2xXYXJuaW5nKCk7XG4gICAgICAgIHNhdmVTdGF0ZSgpO1xuICAgICAgfVxuICAgIH0pO1xuICB9KTtcblxuICAvLyBUb3VjaC1vbmx5IOKTmDogc2hvdy9oaWRlIHRoZSBjdXJyZW50IG1vZGUncyBleHBsYW5hdGlvblxuICBjb25zdCBtb2RlSW5mb0J0biA9IG1vZGFsLnF1ZXJ5U2VsZWN0b3I8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiLnNiLW1vZGUtaW5mby1idG5cIik7XG4gIGNvbnN0IG1vZGVJbmZvID0gbW9kYWwucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCIjc2ItbW9kZS1pbmZvXCIpO1xuICBtb2RlSW5mb0J0bj8uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHtcbiAgICBpZiAoIW1vZGVJbmZvKSByZXR1cm47XG4gICAgdXBkYXRlTW9kZUluZm8oKTtcbiAgICBtb2RlSW5mby5oaWRkZW4gPSAhbW9kZUluZm8uaGlkZGVuO1xuICAgIG1vZGVJbmZvQnRuLnNldEF0dHJpYnV0ZShcImFyaWEtZXhwYW5kZWRcIiwgU3RyaW5nKCFtb2RlSW5mby5oaWRkZW4pKTtcbiAgfSk7XG5cbiAgLy8gQmF0dGxlIC8gU2V0dGluZ3MgdGFicywgc2V0dGluZ3MgY29udHJvbHMsIHZvbHVtZVxuICBzaG93VGFiKG1vZGFsLCBcImJhdHRsZVwiKTtcbiAgYmluZFNldHRpbmdzQ29udHJvbHMobW9kYWwsIG9uU2V0dGluZ0NoYW5nZWQsICgpID0+IGFwcGx5UHJldmlld1NldHRpbmdzKCksIGNvbmZpcm1TZXR0aW5nQ2hhbmdlKTtcbiAgdXBkYXRlUmF0aW5nc05vdGUoKTtcblxuICBtb2RhbC5xdWVyeVNlbGVjdG9yKCdbZGF0YS1hY3Rpb249XCJyZXNldC1lbG9cIl0nKT8uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHZvaWQgc3RhcnRSZXNldEVsbyhtb2RhbCkpO1xuICAvLyBCYXR0bGUgdGFiIG5vdGUncyBcImNoYW5nZSBpbiBTZXR0aW5nc1wiIGxpbmtcbiAgbW9kYWwucXVlcnlTZWxlY3RvcignW2RhdGEtYWN0aW9uPVwib3Blbi1zZXR0aW5nc1wiXScpPy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgc2hvd1RhYihtb2RhbCwgXCJzZXR0aW5nc1wiKTtcbiAgICBhcHBseVByZXZpZXdTZXR0aW5ncygpO1xuICB9KTtcblxuICAvLyBTa2lwIGJ1dHRvblxuICBtb2RhbC5xdWVyeVNlbGVjdG9yKFwiI3NiLXNraXAtYnRuXCIpPy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgc2tpcFBhaXIpO1xuXG4gIC8vIFJlZnJlc2ggY2FjaGUgYnV0dG9uXG4gIGNvbnN0IHJlZnJlc2hDYWNoZUJ0biA9IG1vZGFsLnF1ZXJ5U2VsZWN0b3I8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiI3NiLXJlZnJlc2gtY2FjaGUtYnRuXCIpO1xuICBpZiAocmVmcmVzaENhY2hlQnRuKSB7XG4gICAgcmVmcmVzaENhY2hlQnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBhc3luYyAoKSA9PiB7XG4gICAgICBpZiAoc3RhdGUuZGlzYWJsZUNob2ljZSkgcmV0dXJuO1xuXG4gICAgICBjb25zdCBsYWJlbCA9IHJlZnJlc2hDYWNoZUJ0bi50ZXh0Q29udGVudDtcbiAgICAgIHJlZnJlc2hDYWNoZUJ0bi5kaXNhYmxlZCA9IHRydWU7XG4gICAgICByZWZyZXNoQ2FjaGVCdG4udGV4dENvbnRlbnQgPSBcIvCflIQgUmVmcmVzaGluZy4uLlwiO1xuXG4gICAgICB0cnkge1xuICAgICAgICBhd2FpdCBjbGVhclNjZW5lQ2FjaGUoKTtcblxuICAgICAgICAvLyBSZXNldCBzaHVmZmxlIHN0YXRlIHNpbmNlIHNjZW5lIGxpc3QgaXMgYmVpbmcgcmVmcmVzaGVkXG4gICAgICAgIHJlc2V0U2h1ZmZsZSgpO1xuXG4gICAgICAgIC8vIFJlc2V0IHJ1biBzdGF0ZSBzaW5jZSByYW5raW5ncyBtYXkgaGF2ZSBjaGFuZ2VkXG4gICAgICAgIHJlc2V0UnVuU3RhdGUoKTtcbiAgICAgICAgc2F2ZVN0YXRlKCk7XG5cbiAgICAgICAgYXdhaXQgbG9hZE5ld1BhaXIoKTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIFJlZnJlc2ggZmFpbGVkOlwiLCBlKTtcbiAgICAgIH0gZmluYWxseSB7XG4gICAgICAgIHJlZnJlc2hDYWNoZUJ0bi5kaXNhYmxlZCA9IGZhbHNlO1xuICAgICAgICByZWZyZXNoQ2FjaGVCdG4udGV4dENvbnRlbnQgPSBsYWJlbDtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxuXG4gIC8vIExvYWQgaW5pdGlhbCBjb21wYXJpc29uIG9yIHJlc3RvcmUgc2F2ZWQgcGFpciwgYWZ0ZXIgdGhlIG9uZS10aW1lIEVMTyBzZXR1cCBpZiBpdCdzIHBlbmRpbmdcbiAgaWYgKGlzRWxvU2V0dXBQZW5kaW5nKCkpIHtcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCfp60gRUxPIHNldHVwIG5vdCBkb25lIHlldCwgc2hvd2luZyBzZXR1cFwiKTtcbiAgICBzaG93U2V0dXBTY3JlZW4obW9kYWwsICgpID0+IGFmdGVyU2V0dXAobW9kYWwpKTtcbiAgfSBlbHNlIGlmIChmb3JjZVNjZW5lQmF0dGxlKSB7XG4gICAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIPCfjq8gU3RhcnRpbmcgYmF0dGxlIHdpdGggc2NlbmUgJHtzY2VuZVBhZ2VJZH0gZnJvbSBzY2VuZSBwYWdlYCk7XG4gICAgbG9hZE5ld1BhaXIoc2NlbmVQYWdlSWQpO1xuICB9IGVsc2UgaWYgKGhhc1N0YXRlICYmIHN0YXRlLmN1cnJlbnRQYWlyLmxlZnQgJiYgc3RhdGUuY3VycmVudFBhaXIucmlnaHQgJiYgIWZpbHRlcnNDaGFuZ2VkKSB7XG4gICAgY29uc29sZS5sb2coXG4gICAgICBgW1N0YXNoIEJhdHRsZV0g8J+TgiBSZXN0b3Jpbmcgc2F2ZWQgcGFpciBmcm9tIGxvY2FsU3RvcmFnZSAoU2NlbmUgJHtzdGF0ZS5jdXJyZW50UGFpci5sZWZ0LmlkfSB2cyBTY2VuZSAke3N0YXRlLmN1cnJlbnRQYWlyLnJpZ2h0LmlkfSlgLFxuICAgICk7XG4gICAgdm9pZCByZXN0b3JlQ3VycmVudFBhaXIoKTtcbiAgfSBlbHNlIHtcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCfhpUgTm8gc2F2ZWQgcGFpciBvciBmaWx0ZXJzIGNoYW5nZWQsIGxvYWRpbmcgbmV3IHBhaXIuLi5cIik7XG4gICAgbG9hZE5ld1BhaXIoKTtcbiAgfVxuXG4gIC8vIENsb3NlIGhhbmRsZXJzXG4gIG1vZGFsLnF1ZXJ5U2VsZWN0b3IoXCIuc2ItbW9kYWwtYmFja2Ryb3BcIik/LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBjbG9zZU1vZGFsKTtcbiAgbW9kYWwucXVlcnlTZWxlY3RvcihcIi5zYi1tb2RhbC1jbG9zZVwiKT8uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIGNsb3NlTW9kYWwpO1xuXG4gIC8vIFJlbW92ZSBhbnkgZXhpc3Rpbmcga2V5Ym9hcmQgaGFuZGxlcnMgYmVmb3JlIGFkZGluZyBuZXcgb25lc1xuICBpZiAobW9kYWxLZXlIYW5kbGVyKSB7XG4gICAgZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImtleWRvd25cIiwgbW9kYWxLZXlIYW5kbGVyLCB0cnVlKTtcbiAgfVxuXG4gIC8vIFNpbmdsZSBrZXlib2FyZCBoYW5kbGVyIGZvciBhbGwgbW9kYWwgc2hvcnRjdXRzXG4gIG1vZGFsS2V5SGFuZGxlciA9IGZ1bmN0aW9uIChlOiBLZXlib2FyZEV2ZW50KSB7XG4gICAgY29uc3QgYWN0aXZlTW9kYWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInNiLW1vZGFsXCIpO1xuICAgIGlmICghYWN0aXZlTW9kYWwpIHtcbiAgICAgIGlmIChtb2RhbEtleUhhbmRsZXIpIGRvY3VtZW50LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJrZXlkb3duXCIsIG1vZGFsS2V5SGFuZGxlciwgdHJ1ZSk7XG4gICAgICBtb2RhbEtleUhhbmRsZXIgPSBudWxsO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIFN0YXNoJ3Mgb3duIGRlbGV0ZSBkaWFsb2cgKENsZWFuIG1vZGUpIGlzIG9uIHRvcDogbGV0IGl0IGhhdmUgdGhlIGtleXMgKEVzY2FwZSwgRW50ZXIpXG4gICAgaWYgKGlzRGVsZXRlRGlhbG9nT3BlbigpKSByZXR1cm47XG5cbiAgICAvLyBOb3RoaW5nIHR5cGVkIHdoaWxlIEJhdHRsZSBpcyBvcGVuIG1heSByZWFjaCBTdGFzaCdzIG93biBob3RrZXlzIChwYWdlIGFycm93cywgbGV0dGVyXG4gICAgLy8gc2hvcnRjdXRzKSwgb3IgaXQgYWN0cyBvbiB0aGUgcGFnZSBiZWhpbmQgdGhlIG1vZGFsLiBEZWZhdWx0IGFjdGlvbnMgKHR5cGluZyBpbiBpbnB1dHMsXG4gICAgLy8gc2xpZGVyIGFycm93cywgY2hlY2tib3ggU3BhY2UpIHN0aWxsIGhhcHBlbiBzaW5jZSBvbmx5IHByb3BhZ2F0aW9uIGlzIHN0b3BwZWQgaGVyZS5cbiAgICBlLnN0b3BJbW1lZGlhdGVQcm9wYWdhdGlvbigpO1xuXG4gICAgLy8gQSBjb25maXJtYXRpb24gZGlhbG9nIGlzIG9wZW46IEVzY2FwZSBjYW5jZWxzIGl0LCBvdGhlciBrZXlzIGFyZSBpdHMgb3duIChUYWIsIEVudGVyKVxuICAgIGlmIChpc0NvbmZpcm1EaWFsb2dPcGVuKCkpIHtcbiAgICAgIGlmIChlLmtleSA9PT0gXCJFc2NhcGVcIikge1xuICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgICAgIGNhbmNlbENvbmZpcm1EaWFsb2coKTtcbiAgICAgIH1cbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBFc2NhcGUgdG8gY2xvc2VcbiAgICBpZiAoZS5rZXkgPT09IFwiRXNjYXBlXCIpIHtcbiAgICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICAgIGNsb3NlTW9kYWwoKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBCYXR0bGUgc2hvcnRjdXRzIG9ubHkgYXBwbHkgb24gdGhlIEJhdHRsZSB0YWIsIG9uY2UgRUxPIHNldHVwIGlzIGRvbmVcbiAgICBpZiAoZ2V0QWN0aXZlVGFiKCkgIT09IFwiYmF0dGxlXCIgfHwgaXNFbG9TZXR1cFBlbmRpbmcoKSkgcmV0dXJuO1xuXG4gICAgLy8gTGV0IHRoZSB2b2x1bWUgc2xpZGVyIC8gbnVtYmVyIGlucHV0IGtlZXAgdGhlaXIgb3duIGFycm93IGtleXMgKGNoZWNrYm94ZXMgZG9uJ3QgbmVlZCB0aGVtKVxuICAgIGNvbnN0IGFjdGl2ZSA9IGRvY3VtZW50LmFjdGl2ZUVsZW1lbnQgYXMgSFRNTElucHV0RWxlbWVudCB8IG51bGw7XG4gICAgY29uc3QgdGFnID0gYWN0aXZlPy50YWdOYW1lO1xuICAgIGNvbnN0IGlzVG9nZ2xlID0gdGFnID09PSBcIklOUFVUXCIgJiYgKGFjdGl2ZT8udHlwZSA9PT0gXCJjaGVja2JveFwiIHx8IGFjdGl2ZT8udHlwZSA9PT0gXCJyYWRpb1wiKTtcbiAgICBpZiAoKHRhZyA9PT0gXCJJTlBVVFwiICYmICFpc1RvZ2dsZSkgfHwgdGFnID09PSBcIlRFWFRBUkVBXCIgfHwgdGFnID09PSBcIlNFTEVDVFwiKSByZXR1cm47XG5cbiAgICAvLyBBcnJvdyBrZXlzIHRvIGNob29zZVxuICAgIGlmIChlLmtleSA9PT0gXCJBcnJvd0xlZnRcIiAmJiBzdGF0ZS5jdXJyZW50UGFpci5sZWZ0KSB7XG4gICAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgICBjb25zdCBsZWZ0Qm9keSA9IGFjdGl2ZU1vZGFsLnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KCcuc2Itc2NlbmUtY2FyZFtkYXRhLXNpZGU9XCJsZWZ0XCJdIC5zYi1zY2VuZS1ib2R5Jyk7XG4gICAgICBpZiAobGVmdEJvZHkpIGxlZnRCb2R5LmNsaWNrKCk7XG4gICAgfVxuICAgIGlmIChlLmtleSA9PT0gXCJBcnJvd1JpZ2h0XCIgJiYgc3RhdGUuY3VycmVudFBhaXIucmlnaHQpIHtcbiAgICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICAgIGNvbnN0IHJpZ2h0Qm9keSA9IGFjdGl2ZU1vZGFsLnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KCcuc2Itc2NlbmUtY2FyZFtkYXRhLXNpZGU9XCJyaWdodFwiXSAuc2Itc2NlbmUtYm9keScpO1xuICAgICAgaWYgKHJpZ2h0Qm9keSkgcmlnaHRCb2R5LmNsaWNrKCk7XG4gICAgfVxuXG4gICAgLy8gU3BhY2ViYXIgdG8gc2tpcFxuICAgIGlmIChlLmtleSA9PT0gXCIgXCIgfHwgZS5jb2RlID09PSBcIlNwYWNlXCIpIHtcbiAgICAgIC8vIExldCBhIGZvY3VzZWQgYnV0dG9uIG9yIGNoZWNrYm94IGhhbmRsZSBpdHMgb3duIFNwYWNlXG4gICAgICBpZiAodGFnID09PSBcIkJVVFRPTlwiIHx8IGlzVG9nZ2xlKSByZXR1cm47XG4gICAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgICBza2lwUGFpcigpO1xuICAgIH1cbiAgfTtcblxuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwia2V5ZG93blwiLCBtb2RhbEtleUhhbmRsZXIsIHRydWUpO1xufVxuXG4vKiogQSBtb2RhbCB3aXRoIGp1c3QgYSBtZXNzYWdlLCBzaG93biBpbnN0ZWFkIG9mIEJhdHRsZSAoZS5nLiB0aGlzIFN0YXNoIGxhY2tzIGN1c3RvbSBmaWVsZHMpLiAqL1xuZnVuY3Rpb24gc2hvd01lc3NhZ2VNb2RhbChtZXNzYWdlOiBzdHJpbmcpOiB2b2lkIHtcbiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzYi1tb2RhbFwiKT8ucmVtb3ZlKCk7XG4gIGNvbnN0IG1vZGFsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbW9kYWwuaWQgPSBcInNiLW1vZGFsXCI7XG4gIG1vZGFsLmlubmVySFRNTCA9IGBcbiAgICAgIDxkaXYgY2xhc3M9XCJzYi1tb2RhbC1iYWNrZHJvcFwiPjwvZGl2PlxuICAgICAgPGRpdiBjbGFzcz1cInNiLW1vZGFsLWNvbnRlbnRcIj5cbiAgICAgICAgPGJ1dHRvbiBjbGFzcz1cInNiLW1vZGFsLWNsb3NlXCIgYXJpYS1sYWJlbD1cIkNsb3NlXCI+4pyVPC9idXR0b24+XG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi1lcnJvci1zY3JlZW5cIj5cbiAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItZXJyb3ItaWNvblwiPuKaoO+4jzwvZGl2PlxuICAgICAgICAgIDxwIGNsYXNzPVwic2ItZXJyb3ItbWVzc2FnZVwiPiR7bWVzc2FnZX08L3A+XG4gICAgICAgIDwvZGl2PlxuICAgICAgPC9kaXY+XG4gICAgYDtcbiAgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZChtb2RhbCk7XG4gIGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LmFkZChCQVRUTEVfT1BFTl9DTEFTUyk7XG4gIG1vZGFsLnF1ZXJ5U2VsZWN0b3IoXCIuc2ItbW9kYWwtYmFja2Ryb3BcIik/LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBjbG9zZU1vZGFsKTtcbiAgbW9kYWwucXVlcnlTZWxlY3RvcihcIi5zYi1tb2RhbC1jbG9zZVwiKT8uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIGNsb3NlTW9kYWwpO1xufVxuXG4vKiogVHJ1ZSB3aGlsZSB0aGUgYmF0dGxlIG1vZGFsIGlzIG9uIHNjcmVlbiAoaXQgc3RheXMgaW4gdGhlIERPTSwgaGlkZGVuLCBhZnRlciBjbG9zaW5nKS4gKi9cbmZ1bmN0aW9uIGlzTW9kYWxWaXNpYmxlKCk6IGJvb2xlYW4ge1xuICBjb25zdCBtb2RhbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic2ItbW9kYWxcIik7XG4gIHJldHVybiBtb2RhbCAhPT0gbnVsbCAmJiAhbW9kYWwuY2xhc3NMaXN0LmNvbnRhaW5zKFwic2ItbW9kYWwtaGlkZGVuXCIpO1xufVxuXG4vLyBTdGFzaCdzIGhvdGtleXMgKE1vdXNldHJhcCkgYWxzbyBsaXN0ZW4gZm9yIGtleXByZXNzL2tleXVwIG9uIGRvY3VtZW50OyBrZXlkb3duIGlzIGhhbmRsZWRcbi8vIGJ5IG1vZGFsS2V5SGFuZGxlci4gUmVnaXN0ZXJlZCBvbmNlLCBpbiB0aGUgY2FwdHVyZSBwaGFzZSwgYW5kIGluZXJ0IHdoaWxlIHRoZSBtb2RhbCBpcyBoaWRkZW4uXG5sZXQga2V5U3dhbGxvd2Vyc0FkZGVkID0gZmFsc2U7XG5mdW5jdGlvbiBhZGRLZXlTd2FsbG93ZXJzKCk6IHZvaWQge1xuICBpZiAoa2V5U3dhbGxvd2Vyc0FkZGVkKSByZXR1cm47XG4gIGtleVN3YWxsb3dlcnNBZGRlZCA9IHRydWU7XG4gIGNvbnN0IHN3YWxsb3cgPSAoZTogS2V5Ym9hcmRFdmVudCk6IHZvaWQgPT4ge1xuICAgIGlmIChpc01vZGFsVmlzaWJsZSgpICYmICFpc0RlbGV0ZURpYWxvZ09wZW4oKSkgZS5zdG9wSW1tZWRpYXRlUHJvcGFnYXRpb24oKTtcbiAgfTtcbiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcImtleXByZXNzXCIsIHN3YWxsb3csIHRydWUpO1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwia2V5dXBcIiwgc3dhbGxvdywgdHJ1ZSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjbG9zZU1vZGFsKCk6IHZvaWQge1xuICBjb25zdCBtb2RhbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic2ItbW9kYWxcIik7XG4gIGlmICghbW9kYWwgfHwgbW9kYWwuY2xhc3NMaXN0LmNvbnRhaW5zKFwic2ItbW9kYWwtaGlkZGVuXCIpKSByZXR1cm47XG5cbiAgY2FuY2VsRGVsZXRlRGlhbG9nKCk7XG4gIGNhbmNlbENvbmZpcm1EaWFsb2coKTtcbiAgLy8gU3Rhc2gncyBzY2VuZSBsaXN0cyBzaG93IHRoZSByYXRpbmdzIHdyaXR0ZW4gd2hpbGUgU3Rhc2ggQmF0dGxlIHdhcyBvcGVuLCBhbmQgYSBzY2VuZSBwYWdlIGl0cyBFTE9cbiAgaG9sZFN0YXNoTGlzdFJlZnJlc2goZmFsc2UpO1xuICByZWZyZXNoU2NlbmVFbG8oKTtcbiAgLy8gQ2xvc2luZyBTdGFzaCBCYXR0bGUgb24gUmVzZXQgRUxPJ3MgY2hvaWNlcyAoYmVmb3JlIFN0YXJ0KSBjYW5jZWxzIHRoZSByZXNldFxuICBpZiAoc3RhdGUucmVzZXR0aW5nRWxvICYmICFpc1NldHVwUnVubmluZygpKSB7XG4gICAgc3RhdGUucmVzZXR0aW5nRWxvID0gZmFsc2U7XG4gICAgaGlkZVNldHVwU2NyZWVuKG1vZGFsKTtcbiAgfVxuXG4gIC8vIFN0b3AgcHJldmlld3MgKGF1dG9wbGF5IGtlZXBzIHRoZW0gcnVubmluZyBvdGhlcndpc2UpXG4gIG1vZGFsLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTFZpZGVvRWxlbWVudD4oXCIuc2ItaG92ZXItcHJldmlld1wiKS5mb3JFYWNoKCh2KSA9PiB2LnBhdXNlKCkpO1xuXG4gIC8vIEFkZCBjbG9zaW5nIGNsYXNzIHRvIHRyaWdnZXIgZmFkZS1vdXQgYW5pbWF0aW9uXG4gIG1vZGFsLmNsYXNzTGlzdC5hZGQoXCJzYi1tb2RhbC1jbG9zaW5nXCIpO1xuXG4gIC8vIEFmdGVyIGFuaW1hdGlvbiBjb21wbGV0ZXMsIGhpZGUgdGhlIG1vZGFsIChrZWVwIGluIERPTSBmb3IgcmV1c2UpXG4gIHNldFRpbWVvdXQoKCkgPT4ge1xuICAgIG1vZGFsLmNsYXNzTGlzdC5hZGQoXCJzYi1tb2RhbC1oaWRkZW5cIik7XG4gICAgZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QucmVtb3ZlKEJBVFRMRV9PUEVOX0NMQVNTKTtcbiAgICBtb2RhbC5jbGFzc0xpc3QucmVtb3ZlKFwic2ItbW9kYWwtY2xvc2luZ1wiKTtcbiAgfSwgMjAwKTsgLy8gTWF0Y2ggQ1NTIGFuaW1hdGlvbiBkdXJhdGlvblxuXG4gIC8vIENsZWFuIHVwIGtleWJvYXJkIGhhbmRsZXJcbiAgaWYgKG1vZGFsS2V5SGFuZGxlcikge1xuICAgIGRvY3VtZW50LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJrZXlkb3duXCIsIG1vZGFsS2V5SGFuZGxlciwgdHJ1ZSk7XG4gIH1cbn1cblxuIiwgIi8vIFRoZSBuYXZiYXIgXCJCYXR0bGVcIiBidXR0b24gdGhhdCBvcGVucyB0aGUgY29tcGFyaXNvbiBtb2RhbC5cbi8vXG4vLyBXaGVyZSBTdGFzaCBoYXMgdGhlIHBsdWdpbiBwYXRjaCBBUEksIHRoZSBidXR0b24gaXMgcGF0Y2hlZCBpbnRvIE1haW5OYXZCYXIuTWVudUl0ZW1zIChhZnRlclxuLy8gU3Rhc2gncyBvd24gcGFnZSBsaW5rcyksIHNvIFJlYWN0IHJlbmRlcnMgaXQgd2l0aCB0aGUgcmVzdCBvZiB0aGUgbmF2YmFyLiBPdGhlcndpc2UgaXQncyBhZGRlZFxuLy8gdG8gdGhlIERPTSBkaXJlY3RseSBhbmQgcmUtYWRkZWQgd2hlbmV2ZXIgdGhlIHBhZ2UgY2hhbmdlcy5cblxuaW1wb3J0IHR5cGUgeyBQbHVnaW5BcGlMaWtlLCBSZWFjdE5vZGUgfSBmcm9tIFwiLi4vcGx1Z2luQXBpXCI7XG5pbXBvcnQgeyBTV09SRFNfUEFUSFMgfSBmcm9tIFwiLi9pY29uc1wiO1xuaW1wb3J0IHsgb3Blbk1vZGFsIH0gZnJvbSBcIi4vbW9kYWxcIjtcblxuY29uc3QgQlVUVE9OX0lEID0gXCJwbHVnaW5fc2JcIjtcbmNvbnN0IE5BVl9JVEVNX0NMQVNTID0gXCJjb2wtNCBjb2wtc20tMyBjb2wtbWQtMiBjb2wtbGctYXV0byBuYXYtbGlua1wiO1xuY29uc3QgTElOS19DTEFTUyA9XG4gIFwibWluaW1hbCBwLTQgcC14bC0yIGQtZmxleCBkLXhsLWlubGluZS1ibG9jayBmbGV4LWNvbHVtbiBqdXN0aWZ5LWNvbnRlbnQtYmV0d2VlbiBhbGlnbi1pdGVtcy1jZW50ZXIgYnRuIGJ0bi1wcmltYXJ5XCI7XG5jb25zdCBMSU5LX0hUTUwgPSBgXG4gICAgICAgICAgICA8c3ZnIGFyaWEtaGlkZGVuPVwidHJ1ZVwiIGZvY3VzYWJsZT1cImZhbHNlXCIgY2xhc3M9XCJzdmctaW5saW5lLS1mYSBmYS1pY29uIG5hdi1tZW51LWljb24gZC1ibG9jayBkLXhsLWlubGluZSBtYi0yIG1iLXhsLTBcIiByb2xlPVwiaW1nXCIgeG1sbnM9XCJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2Z1wiIHZpZXdCb3g9XCIwIDAgMzYgMzZcIj4ke1NXT1JEU19QQVRIU308L3N2Zz5cbiAgICAgICAgICAgIDxzcGFuPkJhdHRsZTwvc3Bhbj5cbiAgICAgICAgYDtcblxuZXhwb3J0IGZ1bmN0aW9uIHNob3VsZFNob3dOYXZCdXR0b24oKTogYm9vbGVhbiB7XG4gIGNvbnN0IHBhdGggPSB3aW5kb3cubG9jYXRpb24ucGF0aG5hbWU7XG4gIHJldHVybiAoXG4gICAgcGF0aCA9PT0gXCIvXCIgfHxcbiAgICBwYXRoID09PSBcIi9zY2VuZXNcIiB8fFxuICAgIHBhdGggPT09IFwiL3NjZW5lcy9cIiB8fFxuICAgIHBhdGguc3RhcnRzV2l0aChcIi9zY2VuZXMvXCIpXG4gICk7XG59XG5cbmZ1bmN0aW9uIG9uQnV0dG9uQ2xpY2soZTogeyBwcmV2ZW50RGVmYXVsdCgpOiB2b2lkIH0pOiB2b2lkIHtcbiAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICB2b2lkIG9wZW5Nb2RhbCgpO1xufVxuXG4vKiogQWRkIHRoZSBCYXR0bGUgbmF2IGl0ZW0gdG8gU3Rhc2gncyBuYXZiYXIsIHNob3duIG9ubHkgb24gdGhlIHJvdXRlcyB3aGVyZSBpdCBhcHBsaWVzLiBDYWxsIG9uY2UgYXQgc3RhcnR1cC4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWdpc3Rlck5hdkJ1dHRvbigpOiB2b2lkIHtcbiAgY29uc3QgYXBpID0gd2luZG93LlBsdWdpbkFwaTtcbiAgaWYgKGFwaT8uY29tcG9uZW50cz8uW1wiTWFpbk5hdkJhci5NZW51SXRlbXNcIl0gJiYgdHlwZW9mIGFwaS5wYXRjaD8uYmVmb3JlID09PSBcImZ1bmN0aW9uXCIpIHtcbiAgICBwYXRjaE5hdkJ1dHRvbihhcGkpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGluamVjdE5hdkJ1dHRvbigpO1xuXG4gIC8vIFJlLWluamVjdCBuYXYgYnV0dG9uIGFmdGVyIFN0YXNoIFNQQSBuYXZpZ2F0aW9uIHJlYnVpbGRzIHRoZSBuYXZiYXJcbiAgY29uc3Qgb2JzZXJ2ZXIgPSBuZXcgTXV0YXRpb25PYnNlcnZlcigoKSA9PiB7XG4gICAgaW5qZWN0TmF2QnV0dG9uKCk7XG4gIH0pO1xuXG4gIG9ic2VydmVyLm9ic2VydmUoZG9jdW1lbnQuYm9keSwge1xuICAgIGNoaWxkTGlzdDogdHJ1ZSxcbiAgICBzdWJ0cmVlOiB0cnVlLFxuICB9KTtcbn1cblxuZnVuY3Rpb24gcGF0Y2hOYXZCdXR0b24oYXBpOiBQbHVnaW5BcGlMaWtlKTogdm9pZCB7XG4gIGNvbnN0IHsgUmVhY3QgfSA9IGFwaTtcbiAgY29uc3QgZXZlbnRzID0gYXBpLkV2ZW50O1xuXG4gIGZ1bmN0aW9uIEJhdHRsZU5hdkl0ZW0oKTogUmVhY3ROb2RlIHtcbiAgICAvLyBUaGUgcm91dGUgaXMgcmVhZCBvbiBldmVyeSByZW5kZXI7IHRoZSBzdGF0ZSBvbmx5IG1ha2VzIFN0YXNoJ3MgbmF2aWdhdGlvbiBldmVudHMgcmUtcmVuZGVyXG4gICAgY29uc3QgWywgc2V0UGF0aF0gPSBSZWFjdC51c2VTdGF0ZSh3aW5kb3cubG9jYXRpb24ucGF0aG5hbWUpO1xuXG4gICAgUmVhY3QudXNlRWZmZWN0KCgpID0+IHtcbiAgICAgIGlmICghZXZlbnRzKSByZXR1cm47XG4gICAgICBjb25zdCB1cGRhdGUgPSAoKTogdm9pZCA9PiBzZXRQYXRoKHdpbmRvdy5sb2NhdGlvbi5wYXRobmFtZSk7XG4gICAgICB1cGRhdGUoKTtcbiAgICAgIGV2ZW50cy5hZGRFdmVudExpc3RlbmVyKFwic3Rhc2g6bG9jYXRpb25cIiwgdXBkYXRlKTtcbiAgICAgIHJldHVybiAoKSA9PiBldmVudHMucmVtb3ZlRXZlbnRMaXN0ZW5lcihcInN0YXNoOmxvY2F0aW9uXCIsIHVwZGF0ZSk7XG4gICAgfSwgW10pO1xuXG4gICAgaWYgKCFzaG91bGRTaG93TmF2QnV0dG9uKCkpIHJldHVybiBudWxsO1xuICAgIHJldHVybiBSZWFjdC5jcmVhdGVFbGVtZW50KFxuICAgICAgXCJkaXZcIixcbiAgICAgIHsgaWQ6IEJVVFRPTl9JRCwgY2xhc3NOYW1lOiBOQVZfSVRFTV9DTEFTUyB9LFxuICAgICAgUmVhY3QuY3JlYXRlRWxlbWVudChcImFcIiwge1xuICAgICAgICBocmVmOiBcIiNcIixcbiAgICAgICAgY2xhc3NOYW1lOiBMSU5LX0NMQVNTLFxuICAgICAgICBvbkNsaWNrOiBvbkJ1dHRvbkNsaWNrLFxuICAgICAgICBkYW5nZXJvdXNseVNldElubmVySFRNTDogeyBfX2h0bWw6IExJTktfSFRNTCB9LFxuICAgICAgfSksXG4gICAgKTtcbiAgfVxuXG4gIC8vIEFwcGVuZCB0byB0aGUgY2hpbGRyZW4gTWVudUl0ZW1zIHJlbmRlcnMgaW4gaXRzIE5hdi4gRXZlcnkgb3RoZXIgYXJnIGlzIHBhc3NlZCB0aHJvdWdoIGFzIGlzOlxuICAvLyBhbiBgYWZ0ZXJgIHBhdGNoIGZpbmRzIHRoZSByZW5kZXJlZCByZXN1bHQgYnkgcG9zaXRpb24sIHNvIHRoZSBhcmcgY291bnQgbXVzdCBub3QgY2hhbmdlLlxuICBhcGkucGF0Y2guYmVmb3JlKFwiTWFpbk5hdkJhci5NZW51SXRlbXNcIiwgKHByb3BzLCAuLi5yZXN0KSA9PiBbXG4gICAge1xuICAgICAgLi4uKHByb3BzIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSxcbiAgICAgIGNoaWxkcmVuOiBbKHByb3BzIGFzIHsgY2hpbGRyZW4/OiBSZWFjdE5vZGUgfSkuY2hpbGRyZW4sIFJlYWN0LmNyZWF0ZUVsZW1lbnQoQmF0dGxlTmF2SXRlbSwgeyBrZXk6IEJVVFRPTl9JRCB9KV0sXG4gICAgfSxcbiAgICAuLi5yZXN0LFxuICBdKTtcbn1cblxuLyoqIEluamVjdCBvciByZW1vdmUgdGhlIEJhdHRsZSBuYXYgaXRlbSBiYXNlZCBvbiB0aGUgY3VycmVudCByb3V0ZS4gU2FmZSB0byBjYWxsIHJlcGVhdGVkbHkuICovXG5mdW5jdGlvbiBpbmplY3ROYXZCdXR0b24oKTogdm9pZCB7XG4gIGlmICghc2hvdWxkU2hvd05hdkJ1dHRvbigpKSB7XG4gICAgY29uc3QgZXhpc3RpbmcgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChCVVRUT05fSUQpO1xuICAgIGlmIChleGlzdGluZykge1xuICAgICAgZXhpc3RpbmcuY2xvc2VzdChcIi5uYXYtbGlua1wiKT8ucmVtb3ZlKCk7XG4gICAgfVxuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmIChkb2N1bWVudC5nZXRFbGVtZW50QnlJZChCVVRUT05fSUQpKSByZXR1cm47XG5cbiAgY29uc3QgbmF2SXRlbSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIG5hdkl0ZW0uY2xhc3NOYW1lID0gTkFWX0lURU1fQ0xBU1M7XG4gIG5hdkl0ZW0uaWQgPSBCVVRUT05fSUQ7XG5cbiAgY29uc3QgbGluayA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJhXCIpO1xuICBsaW5rLmhyZWYgPSBcIiNcIjtcbiAgbGluay5jbGFzc05hbWUgPSBMSU5LX0NMQVNTO1xuICBsaW5rLmlubmVySFRNTCA9IExJTktfSFRNTDtcbiAgbGluay5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgb25CdXR0b25DbGljayk7XG4gIG5hdkl0ZW0uYXBwZW5kQ2hpbGQobGluayk7XG5cbiAgY29uc3QgbmF2VGFyZ2V0ID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihcIi5uYXZiYXItbmF2XCIpO1xuICBpZiAobmF2VGFyZ2V0KSB7XG4gICAgbmF2VGFyZ2V0LmFwcGVuZENoaWxkKG5hdkl0ZW0pO1xuICB9XG59XG4iLCAiLy8gU3Rhc2ggQmF0dGxlIC0gZW50cnkgcG9pbnQuXG4vLyBCdW5kbGVkIGJ5IGVzYnVpbGQgaW50byBwbHVnaW5zL3N0YXNoLWJhdHRsZS9zdGFzaC1iYXR0bGUuanMgKElJRkUpLlxuXG5pbXBvcnQgeyByZWdpc3RlckRlbGV0ZURpYWxvZ0JyaWRnZSB9IGZyb20gXCIuL3VpL2RlbGV0ZURpYWxvZ1wiO1xuaW1wb3J0IHsgb3Blbk1vZGFsIH0gZnJvbSBcIi4vdWkvbW9kYWxcIjtcbmltcG9ydCB7IHJlZ2lzdGVyTmF2QnV0dG9uIH0gZnJvbSBcIi4vdWkvbmF2QnV0dG9uXCI7XG5pbXBvcnQgeyByZWdpc3RlclNjZW5lRWxvIH0gZnJvbSBcIi4vdWkvc2NlbmVFbG9cIjtcblxuZnVuY3Rpb24gaW5pdCgpOiB2b2lkIHtcbiAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSBJbml0aWFsaXplZFwiKTtcblxuICByZWdpc3RlckRlbGV0ZURpYWxvZ0JyaWRnZSgpO1xuICByZWdpc3Rlck5hdkJ1dHRvbigpO1xuICByZWdpc3RlclNjZW5lRWxvKCgpID0+IHZvaWQgb3Blbk1vZGFsKCkpO1xufVxuXG5pZiAoZG9jdW1lbnQucmVhZHlTdGF0ZSA9PT0gXCJsb2FkaW5nXCIpIHtcbiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcIkRPTUNvbnRlbnRMb2FkZWRcIiwgaW5pdCk7XG59IGVsc2Uge1xuICBpbml0KCk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiOzs7QUFFTyxNQUFNLGNBQWM7QUFDcEIsTUFBTSxnQkFBZ0I7QUFFdEIsTUFBTSxtQkFBbUI7QUFDekIsTUFBTSxtQkFBbUI7QUFDekIsTUFBTSxtQkFBbUIsSUFBSSxLQUFLO0FBS2xDLE1BQU0sWUFBWTtBQUVsQixNQUFNLG1CQUE2QjtBQUFBLElBQ3hDLGNBQWM7QUFBQSxJQUNkLFlBQVk7QUFBQSxJQUNaLGNBQWM7QUFBQSxJQUNkLGNBQWM7QUFBQSxJQUNkLHFCQUFxQjtBQUFBLElBQ3JCLFdBQVc7QUFBQSxJQUNYLGVBQWU7QUFBQSxJQUNmLGtCQUFrQjtBQUFBLElBQ2xCLGlCQUFpQjtBQUFBLElBQ2pCLFdBQVc7QUFBQSxJQUNYLGtCQUFrQjtBQUFBLEVBQ3BCO0FBR08sTUFBTSw4QkFBOEI7QUFDcEMsTUFBTSwyQkFBMkI7QUFRakMsTUFBTSw0QkFBNEI7QUFFbEMsTUFBTSxnQ0FBZ0M7QUFHdEMsTUFBTSw2QkFBNkI7QUFNbkMsTUFBTSx1QkFBdUI7QUFNN0IsTUFBTSxtQkFBbUI7QUFHekIsTUFBTSwyQkFBMkI7QUFLakMsTUFBTSxZQUFZO0FBRWxCLE1BQU0sZ0JBQWdCO0FBRXRCLE1BQU0sZUFBZTtBQUVyQixNQUFNLGlCQUFpQixDQUFDLFdBQVcsZUFBZSxZQUFZO0FBRTlELE1BQU0sWUFBWTtBQUNsQixNQUFNLGNBQWM7QUFHcEIsTUFBTSxjQUFz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
