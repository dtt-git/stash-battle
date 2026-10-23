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
    previewVolume: 50,
    autoplayPreviews: true,
    filterOpponents: false,
    cleanMode: false,
    pauseMediaOnOpen: true
  };
  var LEGACY_FILTER_OPPONENTS_KEY = "sb_filterOpponents";
  var LEGACY_MUTE_PREVIEWS_KEY = "sb_mutePreviews";
  var SWISS_OPPONENT_REACH_INITIAL = 10;
  var SWISS_OPPONENT_REACH_MULTIPLIER = 2;
  var CLIMB_OPPONENT_PICK_WINDOW = 5;
  var CHAMPION_UNRATED_ELO = 1e3;
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
    const effectiveScene1Idx = isRated(scene1) && scene1IdxInPool >= 0 ? scene1IdxInPool : eloInsertionIndex(rightPool, effectiveElo(scene1));
    const scene1RankInPool = scene1IdxInPool >= 0 ? scene1IdxInPool + 1 : null;
    const candidates = [];
    for (let reach = Math.min(SWISS_OPPONENT_REACH_INITIAL, rightPool.length); candidates.length === 0 && reach <= rightPool.length; reach = Math.min(reach * SWISS_OPPONENT_REACH_MULTIPLIER, rightPool.length)) {
      for (let i = effectiveScene1Idx - reach; i <= effectiveScene1Idx + reach; i++) {
        if (i >= 0 && i < rightPool.length && i !== scene1IdxInPool) {
          candidates.push({ scene: rightPool[i], idx: i });
        }
      }
      if (reach === rightPool.length) break;
    }
    if (candidates.length === 0) {
      throw new Error("Not enough scenes for comparison. You need at least 2 scenes.");
    }
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    return {
      scene2: pick.scene,
      ranks: [scene1RankInPool, pick.idx + 1]
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
  function createSceneCard(scene, side, rank = null, statusBadge = null) {
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
    let eloLabel;
    if (eloValue !== null) {
      eloLabel = `ELO ${Math.round(eloValue)}${rank !== null && rank !== void 0 ? ` · #${rank}` : ""}`;
    } else {
      eloLabel = unratedAs !== null ? `ELO ${unratedAs} · Unrated` : "Unrated";
    }
    const rankDisplay = `<span class="sb-scene-rank">${eloLabel}</span>`;
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
  function renderPair(scenes, ranks) {
    const comparisonArea = document.getElementById("sb-comparison-area");
    if (!comparisonArea) return;
    const statusBadges = scenes.map(climbStatusBadge);
    comparisonArea.innerHTML = `
      <div class="sb-vs-container">
        ${createSceneCard(scenes[0], "left", ranks[0], statusBadges[0])}
        <div class="sb-vs-divider">
          <span class="sb-vs-text">VS</span>
        </div>
        ${createSceneCard(scenes[1], "right", ranks[1], statusBadges[1])}
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
      loser: { from: loserSide.elo, to: result.loser }
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
    winnerCard.classList.add("sb-winner");
    loserCard.classList.add("sb-loser");
    showRatingAnimation(winnerCard, change.winner.from, change.winner.to, true);
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
    winnerCard.classList.add("sb-winner");
    loserCard.classList.add("sb-loser");
    showRatingAnimation(winnerCard, change.winner.from, change.winner.to, true);
    showRatingAnimation(loserCard, change.loser.from, change.loser.to, false);
    scheduleNextPairAfterAnimations();
  }
  var RATING_ANIM_MAX_TOTAL_MS = 1400;
  var RATING_ANIM_HOLD_MS = 300;
  var RATING_ANIM_COUNT_BUDGET_MS = RATING_ANIM_MAX_TOTAL_MS - RATING_ANIM_HOLD_MS;
  var RATING_ANIM_DEFAULT_STEP_MS = 50;
  var RATING_ANIM_MIN_STEP_MS = 8;
  function scheduleNextPairAfterAnimations() {
    setTimeout(() => loadNewPair(), 1500);
  }
  function showRatingAnimation(card, oldElo, newElo, isWinner) {
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
    return `ELO ${Math.round(value)}${rank !== null ? ` · #${rank}` : ""}`;
  }
  async function sceneAndRank(sceneId) {
    const { scenes } = await getAllScenesCached();
    const index = scenes.findIndex((s) => s.id === sceneId);
    if (index >= 0) return { scene: scenes[index], rank: isRated(scenes[index]) ? index + 1 : null };
    const scene = await fetchSceneById(sceneId);
    return scene ? { scene, rank: null } : null;
  }
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
      const result = await sceneAndRank(sceneId);
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL2NvbnN0YW50cy50cyIsICIuLi8uLi9zcmMvZWxvLnRzIiwgIi4uLy4uL3NyYy9zY29yZS50cyIsICIuLi8uLi9zcmMvZ3JhcGhxbC50cyIsICIuLi8uLi9zcmMvdWkvZGVsZXRlRGlhbG9nLnRzIiwgIi4uLy4uL3NyYy9maWx0ZXJzLnRzIiwgIi4uLy4uL3NyYy9zdGF0ZS50cyIsICIuLi8uLi9zcmMvY2FjaGUudHMiLCAiLi4vLi4vc3JjL3NjZW5lQWN0aW9ucy50cyIsICIuLi8uLi9zcmMvcmF0aW5nLnRzIiwgIi4uLy4uL3NyYy9lbG9TZXR1cC50cyIsICIuLi8uLi9zcmMvc2V0dGluZ3MudHMiLCAiLi4vLi4vc3JjL3N0b3JhZ2UudHMiLCAiLi4vLi4vc3JjL3VpL2NvbmZpcm1EaWFsb2cudHMiLCAiLi4vLi4vc3JjL25hdmlnYXRpb24udHMiLCAiLi4vLi4vc3JjL3BsYWNlbWVudC50cyIsICIuLi8uLi9zcmMvcGFpcnMudHMiLCAiLi4vLi4vc3JjL3VpL3NjZW5lVGl0bGUudHMiLCAiLi4vLi4vc3JjL3VpL3NjZW5lQ2FyZC50cyIsICIuLi8uLi9zcmMvdWkvc2NyZWVucy50cyIsICIuLi8uLi9zcmMvdWkvc3Rhc2hSYXRpbmdzVGV4dC50cyIsICIuLi8uLi9zcmMvdWkvc2V0dGluZ3NQYW5lbC50cyIsICIuLi8uLi9zcmMvdWkvbWFpblVJLnRzIiwgIi4uLy4uL3NyYy91aS9pY29ucy50cyIsICIuLi8uLi9zcmMvdWkvc2NlbmVFbG8udHMiLCAiLi4vLi4vc3JjL3VpL3JhdGluZ1ByZXZpZXcudHMiLCAiLi4vLi4vc3JjL3VpL3NldHVwU2NyZWVuLnRzIiwgIi4uLy4uL3NyYy91aS9tb2RhbC50cyIsICIuLi8uLi9zcmMvdWkvbmF2QnV0dG9uLnRzIiwgIi4uLy4uL3NyYy9tYWluLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBQbHVnaW4td2lkZSBjb25zdGFudHMuXG5cbmV4cG9ydCBjb25zdCBTVE9SQUdFX0tFWSA9IFwic3Rhc2gtYmF0dGxlLXN0YXRlXCI7XG5leHBvcnQgY29uc3QgQ0FDSEVfREJfTkFNRSA9IFwic3Rhc2gtYmF0dGxlLWNhY2hlXCI7XG4vKiogMiAoMy4wKTogY2FjaGVkIHNjZW5lcyBmcm9tIGJlZm9yZSBuZWVkIGN1c3RvbV9maWVsZHMgYW5kIEVMTyBvcmRlciwgc28gdGhlIHN0b3JlIGlzIGNsZWFyZWQuICovXG5leHBvcnQgY29uc3QgQ0FDSEVfREJfVkVSU0lPTiA9IDI7XG5leHBvcnQgY29uc3QgQ0FDSEVfU1RPUkVfTkFNRSA9IFwic2NlbmVzXCI7XG5leHBvcnQgY29uc3QgQ0FDSEVfTUFYX0FHRV9NUyA9IDUgKiA2MCAqIDEwMDA7IC8vIDUgbWludXRlcyBjYWNoZSBleHBpcnlcblxuaW1wb3J0IHR5cGUgeyBTZXR0aW5ncyB9IGZyb20gXCIuL3R5cGVzXCI7XG5cbi8qKiBQbHVnaW4gaWQgKGZvbGRlciBuYW1lKSDigJQga2V5IGZvciB0aGlzIHBsdWdpbidzIHNldHRpbmdzIGluIFN0YXNoJ3MgY29uZmlndXJhdGlvbi4gKi9cbmV4cG9ydCBjb25zdCBQTFVHSU5fSUQgPSBcInN0YXNoLWJhdHRsZVwiO1xuXG5leHBvcnQgY29uc3QgREVGQVVMVF9TRVRUSU5HUzogU2V0dGluZ3MgPSB7XG4gIHN0YXNoUmF0aW5nczogXCJvZmZcIixcbiAgZWxvU2V0dXBBdDogbnVsbCxcbiAgZWxvU2V0dXBNb2RlOiBudWxsLFxuICBvcGVuSW5OZXdUYWI6IGZhbHNlLFxuICBwbGFjZW1lbnRGcm9tQm90dG9tOiBmYWxzZSxcbiAgcHJldmlld1ZvbHVtZTogNTAsXG4gIGF1dG9wbGF5UHJldmlld3M6IHRydWUsXG4gIGZpbHRlck9wcG9uZW50czogZmFsc2UsXG4gIGNsZWFuTW9kZTogZmFsc2UsXG4gIHBhdXNlTWVkaWFPbk9wZW46IHRydWUsXG59O1xuXG4vLyBQcmUtMi43IGxvY2FsU3RvcmFnZSBwcmVmZXJlbmNlIGtleXMgKG1pZ3JhdGVkIGludG8gcGx1Z2luIHNldHRpbmdzKS5cbmV4cG9ydCBjb25zdCBMRUdBQ1lfRklMVEVSX09QUE9ORU5UU19LRVkgPSBcInNiX2ZpbHRlck9wcG9uZW50c1wiO1xuZXhwb3J0IGNvbnN0IExFR0FDWV9NVVRFX1BSRVZJRVdTX0tFWSA9IFwic2JfbXV0ZVByZXZpZXdzXCI7XG5cbi8vIFN3aXNzIG1vZGU6IGluaXRpYWwgcmFuayBiYW5kICjCsU4pIHdoZW4gcGlja2luZyBhIHNpbWlsYXItc3RyZW5ndGggb3Bwb25lbnQ7IGRvdWJsZXMgdW50aWwgY2FuZGlkYXRlcyBleGlzdC5cbmV4cG9ydCBjb25zdCBTV0lTU19PUFBPTkVOVF9SRUFDSF9JTklUSUFMID0gMTA7XG5leHBvcnQgY29uc3QgU1dJU1NfT1BQT05FTlRfUkVBQ0hfTVVMVElQTElFUiA9IDI7XG5cbi8vIENoYW1waW9uOiByYW5kb20gcGljayBhbW9uZyB0aGUgTiBjbG9zZXN0IHVuZGVmZWF0ZWQgb3Bwb25lbnRzIGFib3ZlIHRoZSBjaGFtcGlvbi5cbmV4cG9ydCBjb25zdCBDTElNQl9PUFBPTkVOVF9QSUNLX1dJTkRPVyA9IDU7XG5cbi8qKlxuICogRUxPIGFuIHVucmF0ZWQgc2NlbmUgY291bnRzIGFzIGluIENoYW1waW9uOiAxMDAwLCB0aGUgYm90dG9tICh3aGF0IGEgMCByYXRpbmcgc2VlZHMgdG8pLCBzbyBhXG4gKiBuZXdjb21lciBjbGltYnMgZnJvbSB0aGVyZSBhcyBiZWZvcmUuIFN3aXNzIGNvdW50cyB1bnJhdGVkIHNjZW5lcyBhcyBFTE9fU1RBUlQgKDE1MDApLlxuICovXG5leHBvcnQgY29uc3QgQ0hBTVBJT05fVU5SQVRFRF9FTE8gPSAxMDAwO1xuXG4vKiogU2hvdyBhIFVJIHdhcm5pbmcgd2hlbiBDaGFtcGlvbidzIG9wcG9uZW50IHBvb2wgaXMgc21hbGxlciB0aGFuIHRoaXMgKGZpbHRlciBvcHBvbmVudHMgb24pLiAqL1xuZXhwb3J0IGNvbnN0IENMSU1CX1NNQUxMX1BPT0xfV0FSTl9BVCA9IDEwO1xuXG4vLyAtLS0gVHJ1ZSBFTE8gKHN0b3JlZCBpbiBzY2VuZSBjdXN0b20gZmllbGRzKSAtLS1cblxuLyoqIFNjZW5lIGN1c3RvbSBmaWVsZCBrZXlzLiBXcml0ZXMgdXNlIGBwYXJ0aWFsYCwgc28gb3RoZXIgcGx1Z2lucycgZmllbGRzIGFyZSBuZXZlciB0b3VjaGVkLiAqL1xuZXhwb3J0IGNvbnN0IEVMT19GSUVMRCA9IFwic3Rhc2hfYmF0dGxlX2Vsb1wiO1xuLyoqIFJlYWwgYmF0dGxlcyB0aGF0IG1vdmVkIHRoaXMgc2NlbmUncyBFTE8gKFBsYWNlbWVudCBhZGRzIGl0cyBydW4ncyBiYXR0bGVzIHdoZW4gdGhlIHNjZW5lIGxhbmRzKS4gKi9cbmV4cG9ydCBjb25zdCBCQVRUTEVTX0ZJRUxEID0gXCJzdGFzaF9iYXR0bGVfYmF0dGxlc1wiO1xuLyoqIFRydWUgd2hlbiB0aGUgc2NlbmUncyBzdGFydGluZyBFTE8gY2FtZSBmcm9tIGl0cyBTdGFzaCByYXRpbmcgKHNldHVwJ3MgXCJVc2UgbXkgcmF0aW5nc1wiKS4gKi9cbmV4cG9ydCBjb25zdCBTRUVERURfRklFTEQgPSBcInN0YXNoX2JhdHRsZV9zZWVkZWRcIjtcbi8qKiBBbGwgb2YgU3Rhc2ggQmF0dGxlJ3MgcGVyLXNjZW5lIGZpZWxkcyAocmVtb3ZlZCB0b2dldGhlciB3aGVuIGEgc2NlbmUgYmVjb21lcyB1bnJhdGVkKS4gKi9cbmV4cG9ydCBjb25zdCBFTE9fRklFTERfS0VZUyA9IFtFTE9fRklFTEQsIEJBVFRMRVNfRklFTEQsIFNFRURFRF9GSUVMRF07XG5cbmV4cG9ydCBjb25zdCBFTE9fU1RBUlQgPSAxNTAwO1xuZXhwb3J0IGNvbnN0IEVMT19ESVZJU09SID0gNDAwO1xuXG4vKiogSyBieSBLLWdhbWVzIChiYXR0bGVzLCBwbHVzIHRoZSBoZWFkIHN0YXJ0IGlmIHNlZWRlZCk6IFtiZWxvdyB0aGlzIGNvdW50LCBLXTsgdGhlIGxhc3QgaGFzIG5vIGxpbWl0LiAqL1xuZXhwb3J0IGNvbnN0IEVMT19LX1RJRVJTOiByZWFkb25seSAocmVhZG9ubHkgW251bWJlciwgbnVtYmVyXSlbXSA9IFtcbiAgWzEwLCA0MF0sXG4gIFszMCwgMjRdLFxuICBbSW5maW5pdHksIDE2XSxcbl07XG5cbi8qKlxuICogRUxPIHBvaW50cyBwZXIgMS0xMDAgcmF0aW5nIHBvaW50LiBUaGUgcHJlLTMuMCBtYXRoIGRpdmlkZWQgYnkgNDAgb24gdGhlIDEtMTAwIHNjYWxlLCBzbyBvbmVcbiAqIHJhdGluZyBwb2ludCBhbHJlYWR5IG1lYW50IGV4YWN0bHkgMTAgc3RhbmRhcmQgKGRpdmlzb3IgNDAwKSBFTE8gcG9pbnRzLlxuICovXG5leHBvcnQgY29uc3QgRUxPX1BFUl9SQVRJTkdfUE9JTlQgPSAxMDtcblxuLyoqXG4gKiBIZWFkIHN0YXJ0IChjb3VudGVkIGFzIGJhdHRsZXMgZm9yIEsgb25seSkgZm9yIHNjZW5lcyBzZWVkZWQgZnJvbSB0aGVpciBTdGFzaCByYXRpbmc6IHRoZWlyXG4gKiByYXRpbmcgYWxyZWFkeSBzYXlzIHNvbWV0aGluZywgc28gdGhleSBza2lwIHRoZSBiaWdnZXN0IHN3aW5ncy4gQ2hhbmdpbmcgaXQgYXBwbGllcyB0byBldmVyeVxuICogc2VlZGVkIHNjZW5lIGF0IG9uY2UsIGJlY2F1c2UgaXQgaXNuJ3Qgc3RvcmVkLlxuICovXG5leHBvcnQgY29uc3QgU0VFREVEX0hFQURfU1RBUlQgPSAxMDtcblxuLyoqIEVMTyBnYXAgYWJvdmUgdGhlIHRvcCAvIGJlbG93IHRoZSBib3R0b20gc2NlbmUgd2hlbiBQbGFjZW1lbnQgbGFuZHMgYSBzY2VuZSBhdCBhbiBlZGdlLiAqL1xuZXhwb3J0IGNvbnN0IFBMQUNFTUVOVF9FREdFX0dBUCA9IDI1O1xuXG4vKipcbiAqIFBsYWNlbWVudCdzIGRvdWJsaW5nIGp1bXBzIGFyZSBjYXBwZWQgYXQgdGhpcyBzaGFyZSBvZiB0aGUgcG9vbCAoYnV0IGF0IGxlYXN0XG4gKiBQTEFDRU1FTlRfTUlOX01BWF9KVU1QIHJhbmtzKSwgc28gYSB3aW5uaW5nIHN0cmVhayBjbGltYnMgaW5zdGVhZCBvZiBsZWFwaW5nIHRvICMxLiBJbiBhXG4gKiA2MDAtc2NlbmUgbGlicmFyeTogYXQgbW9zdCA2MCByYW5rcyBwZXIganVtcCwgYWJvdXQgb25lIGV4dHJhIGJhdHRsZSBvbiBhdmVyYWdlLlxuICovXG5leHBvcnQgY29uc3QgUExBQ0VNRU5UX01BWF9KVU1QX1NIQVJFID0gMC4xO1xuZXhwb3J0IGNvbnN0IFBMQUNFTUVOVF9NSU5fTUFYX0pVTVAgPSA0O1xuIiwgIi8vIEVMTyBtYXRoIChwdXJlIGNhbGN1bGF0aW9uczogY2FsbGVycyBhcHBseSB0aGUgcmVzdWx0cyBhbmQgcGVyc2lzdCB0aGVtKS5cblxuaW1wb3J0IHsgRUxPX0RJVklTT1IsIEVMT19LX1RJRVJTIH0gZnJvbSBcIi4vY29uc3RhbnRzXCI7XG5cbi8qKiBLIGZvciBhIHNjZW5lIHdpdGggdGhpcyBtYW55IEstZ2FtZXMgKHNlZSBrR2FtZXMpOiBuZXcgc2NlbmVzIG1vdmUgYSBsb3QsIGVzdGFibGlzaGVkIG9uZXMgbGl0dGxlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVsb0tGYWN0b3Ioa0dhbWVzOiBudW1iZXIpOiBudW1iZXIge1xuICBmb3IgKGNvbnN0IFtiZWxvdywga10gb2YgRUxPX0tfVElFUlMpIHtcbiAgICBpZiAoa0dhbWVzIDwgYmVsb3cpIHJldHVybiBrO1xuICB9XG4gIHJldHVybiBFTE9fS19USUVSU1tFTE9fS19USUVSUy5sZW5ndGggLSAxXVsxXTtcbn1cblxuLyoqIFByb2JhYmlsaXR5IHRoYXQgYSBzY2VuZSByYXRlZCBgZWxvYCBiZWF0cyBvbmUgcmF0ZWQgYG9wcG9uZW50RWxvYC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlbG9FeHBlY3RlZChlbG86IG51bWJlciwgb3Bwb25lbnRFbG86IG51bWJlcik6IG51bWJlciB7XG4gIHJldHVybiAxIC8gKDEgKyBNYXRoLnBvdygxMCwgKG9wcG9uZW50RWxvIC0gZWxvKSAvIEVMT19ESVZJU09SKSk7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRWxvU2lkZSB7XG4gIGVsbzogbnVtYmVyO1xuICAvKiogQmF0dGxlcyBwbHVzIGFueSBzZWVkZWQgaGVhZCBzdGFydCAoc2NvcmUudHMga0dhbWVzKTogc2V0cyB0aGlzIHNpZGUncyBLLiAqL1xuICBrR2FtZXM6IG51bWJlcjtcbn1cblxuLyoqIFN0b3JlZCBFTE8gcHJlY2lzaW9uIChvbmUgZGVjaW1hbCksIHNvIHNtYWxsIGxhdGUtY2FyZWVyIGNoYW5nZXMgYXJlbid0IHJvdW5kZWQgYXdheS4gKi9cbmV4cG9ydCBmdW5jdGlvbiByb3VuZEVsbyhlbG86IG51bWJlcik6IG51bWJlciB7XG4gIHJldHVybiBNYXRoLnJvdW5kKGVsbyAqIDEwKSAvIDEwO1xufVxuXG4vKipcbiAqIFR3by1zaWRlZCBFTE8gZm9yIGEgaGVhZC10by1oZWFkIHdpbjsgZWFjaCBzaWRlIHVzZXMgaXRzIG93biBLLiBSZXR1cm5zIHRoZSBuZXcgRUxPcy5cbiAqIEVhY2ggc2lkZSBtb3ZlcyBieSBLIMOXIChhY3R1YWwg4oiSIGV4cGVjdGVkKTogdGhlIHdpbm5lciBieSBLIMOXICgxIOKIkiBpdHMgd2luIGNoYW5jZSksIHRoZSBsb3NlclxuICogYnkgSyDDlyAoMCDiiJIgaXRzIG93biB3aW4gY2hhbmNlKSwgd2hpY2ggaXMgdGhlIHNhbWUgMSDiiJIgd2lubmVyJ3MgY2hhbmNlLiBXaXRoIGVxdWFsIEsgdGhlXG4gKiBwb2ludHMgYXJlIGV4YWN0bHkgemVyby1zdW0uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlbG9SZXN1bHQod2lubmVyOiBFbG9TaWRlLCBsb3NlcjogRWxvU2lkZSk6IHsgd2lubmVyOiBudW1iZXI7IGxvc2VyOiBudW1iZXIgfSB7XG4gIGNvbnN0IHN1cnByaXNlID0gMSAtIGVsb0V4cGVjdGVkKHdpbm5lci5lbG8sIGxvc2VyLmVsbyk7XG4gIHJldHVybiB7XG4gICAgd2lubmVyOiByb3VuZEVsbyh3aW5uZXIuZWxvICsgZWxvS0ZhY3Rvcih3aW5uZXIua0dhbWVzKSAqIHN1cnByaXNlKSxcbiAgICBsb3Nlcjogcm91bmRFbG8obG9zZXIuZWxvIC0gZWxvS0ZhY3Rvcihsb3Nlci5rR2FtZXMpICogc3VycHJpc2UpLFxuICB9O1xufVxuIiwgIi8vIEEgc2NlbmUncyBFTE8gKHJlYWQgZnJvbSBpdHMgY3VzdG9tIGZpZWxkcyksIEVMTyBvcmRlcmluZywgYW5kIGNvbnZlcnNpb25zIGJldHdlZW4gRUxPIGFuZFxuLy8gU3Rhc2gncyAxLTEwMCByYXRpbmcuIFB1cmUgZnVuY3Rpb25zOiBubyBzdGF0ZSwgbm8gSS9PLlxuXG5pbXBvcnQge1xuICBCQVRUTEVTX0ZJRUxELFxuICBFTE9fRklFTEQsXG4gIEVMT19GSUVMRF9LRVlTLFxuICBFTE9fUEVSX1JBVElOR19QT0lOVCxcbiAgRUxPX1NUQVJULFxuICBQTEFDRU1FTlRfRURHRV9HQVAsXG4gIFNFRURFRF9GSUVMRCxcbiAgU0VFREVEX0hFQURfU1RBUlQsXG59IGZyb20gXCIuL2NvbnN0YW50c1wiO1xuaW1wb3J0IHsgcm91bmRFbG8gfSBmcm9tIFwiLi9lbG9cIjtcbmltcG9ydCB0eXBlIHsgRWxvRmllbGRzLCBFbG9TdGFydCwgU2NlbmUsIFN0YXNoUmF0aW5nc01vZGUgfSBmcm9tIFwiLi90eXBlc1wiO1xuXG4vKiogQ3VzdG9tIGZpZWxkIHZhbHVlcyBzaG91bGQgY29tZSBiYWNrIGFzIG51bWJlcnM7IG51bWVyaWMgc3RyaW5ncyBhcmUgYWNjZXB0ZWQgdG9vLiAqL1xuZnVuY3Rpb24gcmVhZE51bWJlcih2YWx1ZTogdW5rbm93bik6IG51bWJlciB8IG51bGwge1xuICBpZiAodHlwZW9mIHZhbHVlID09PSBcIm51bWJlclwiKSByZXR1cm4gTnVtYmVyLmlzRmluaXRlKHZhbHVlKSA/IHZhbHVlIDogbnVsbDtcbiAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gXCJzdHJpbmdcIiAmJiB2YWx1ZS50cmltKCkgIT09IFwiXCIpIHtcbiAgICBjb25zdCBuID0gTnVtYmVyKHZhbHVlKTtcbiAgICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pID8gbiA6IG51bGw7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbi8qKiBUaGUgc2NlbmUncyBzdG9yZWQgRUxPLCBvciBudWxsIHdoZW4gaXQgaGFzIG5vbmUgKHVucmF0ZWQpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVsbyhzY2VuZTogU2NlbmUpOiBudW1iZXIgfCBudWxsIHtcbiAgcmV0dXJuIHJlYWROdW1iZXIoc2NlbmUuY3VzdG9tX2ZpZWxkcz8uW0VMT19GSUVMRF0pO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gaXNSYXRlZChzY2VuZTogU2NlbmUpOiBib29sZWFuIHtcbiAgcmV0dXJuIGVsbyhzY2VuZSkgIT09IG51bGw7XG59XG5cbi8qKiBSZWFsIGJhdHRsZXMgdGhhdCBtb3ZlZCB0aGUgc2NlbmUncyBFTE8uICovXG5leHBvcnQgZnVuY3Rpb24gYmF0dGxlcyhzY2VuZTogU2NlbmUpOiBudW1iZXIge1xuICBjb25zdCBuID0gcmVhZE51bWJlcihzY2VuZS5jdXN0b21fZmllbGRzPy5bQkFUVExFU19GSUVMRF0pO1xuICByZXR1cm4gbiAhPT0gbnVsbCAmJiBuID4gMCA/IE1hdGguZmxvb3IobikgOiAwO1xufVxuXG4vKiogVGhlIHNjZW5lJ3Mgc3RhcnRpbmcgRUxPIGNhbWUgZnJvbSBpdHMgU3Rhc2ggcmF0aW5nLiAoU3Rhc2ggc3RvcmVzIGB0cnVlYCBhcyAxLikgKi9cbmV4cG9ydCBmdW5jdGlvbiBpc1NlZWRlZChzY2VuZTogU2NlbmUpOiBib29sZWFuIHtcbiAgY29uc3QgdmFsdWUgPSBzY2VuZS5jdXN0b21fZmllbGRzPy5bU0VFREVEX0ZJRUxEXTtcbiAgcmV0dXJuIHZhbHVlID09PSB0cnVlIHx8IHZhbHVlID09PSAxIHx8IHZhbHVlID09PSBcInRydWVcIiB8fCB2YWx1ZSA9PT0gXCIxXCI7XG59XG5cbi8qKiBUaGUgY291bnQgSyBpcyBiYXNlZCBvbjogcmVhbCBiYXR0bGVzLCBwbHVzIHRoZSBoZWFkIHN0YXJ0IGZvciBzZWVkZWQgc2NlbmVzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGtHYW1lcyhzY2VuZTogU2NlbmUpOiBudW1iZXIge1xuICByZXR1cm4gYmF0dGxlcyhzY2VuZSkgKyAoaXNTZWVkZWQoc2NlbmUpID8gU0VFREVEX0hFQURfU1RBUlQgOiAwKTtcbn1cblxuLyoqIEVsb0ZpZWxkcyBhcyB0aGUgY3VzdG9tIGZpZWxkcyBtYXAgU3Rhc2ggc3RvcmVzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVsb0N1c3RvbUZpZWxkcyh2YWx1ZTogRWxvRmllbGRzKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICByZXR1cm4geyBbRUxPX0ZJRUxEXTogdmFsdWUuZWxvLCBbQkFUVExFU19GSUVMRF06IHZhbHVlLmJhdHRsZXMsIFtTRUVERURfRklFTERdOiB2YWx1ZS5zZWVkZWQgfTtcbn1cblxuLyoqIFN0YXJ0aW5nIEVMTyBmb3IgYSAxLTEwMCBTdGFzaCByYXRpbmc6IDUwIGlzIDE1MDAsIHNvIDEtMTAwIG1hcHMgb250byAxMDEwLTIwMDAuICovXG5leHBvcnQgZnVuY3Rpb24gc2VlZChyYXRpbmcxMDA6IG51bWJlcik6IG51bWJlciB7XG4gIHJldHVybiBFTE9fU1RBUlQgKyAocmF0aW5nMTAwIC0gNTApICogRUxPX1BFUl9SQVRJTkdfUE9JTlQ7XG59XG5cbi8qKiBFTE8gdXNlZCBpbiBiYXR0bGUgbWF0aDogdGhlIHN0b3JlZCBFTE8sIG9yIGB1bnJhdGVkRWxvYCBmb3IgdW5yYXRlZCBzY2VuZXMgKDE1MDAgYnkgZGVmYXVsdCkuICovXG5leHBvcnQgZnVuY3Rpb24gZWZmZWN0aXZlRWxvKHNjZW5lOiBTY2VuZSwgdW5yYXRlZEVsbzogbnVtYmVyID0gRUxPX1NUQVJUKTogbnVtYmVyIHtcbiAgcmV0dXJuIGVsbyhzY2VuZSkgPz8gdW5yYXRlZEVsbztcbn1cblxuLyoqIFN0cmFpZ2h0LWxpbmUgU3Rhc2ggcmF0aW5nOiB0aGUgaW52ZXJzZSBvZiBzZWVkKCksIGNsYW1wZWQgdG8gMS0xMDAuICovXG5leHBvcnQgZnVuY3Rpb24gbGluZWFyUmF0aW5nKGVsb1ZhbHVlOiBudW1iZXIpOiBudW1iZXIge1xuICBjb25zdCByYXRpbmcgPSBNYXRoLnJvdW5kKDUwICsgKGVsb1ZhbHVlIC0gRUxPX1NUQVJUKSAvIEVMT19QRVJfUkFUSU5HX1BPSU5UKTtcbiAgcmV0dXJuIE1hdGgubWluKDEwMCwgTWF0aC5tYXgoMSwgcmF0aW5nKSk7XG59XG5cbi8qKlxuICogUGVyY2VudGlsZSBTdGFzaCByYXRpbmdzIGZvciBldmVyeSBzY2VuZSB3aXRoIGFuIEVMTzogdGhlIHRvcCBzY2VuZSBpcyAxMDAsIHRoZSBib3R0b20gMSxcbiAqIGV2ZW5seSBzcGFjZWQgYnkgcmFuay4gVGllZCBzY2VuZXMgc2hhcmUgdGhlIG1pZGRsZSBwb3NpdGlvbiBvZiB0aGVpciB0aWUgZ3JvdXAsIHNvIGEgZnVsbHlcbiAqIHRpZWQgbGlicmFyeSBpcyA1MCBldmVyeXdoZXJlLiBVbnJhdGVkIHNjZW5lcyBhcmUgbGVmdCBvdXQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwZXJjZW50aWxlUmF0aW5ncyhzY2VuZXM6IFNjZW5lW10pOiBNYXA8c3RyaW5nLCBudW1iZXI+IHtcbiAgY29uc3QgcmF0ZWQgPSBzY2VuZXNcbiAgICAubWFwKChzY2VuZSkgPT4gKHsgaWQ6IHNjZW5lLmlkLCBlbG86IGVsbyhzY2VuZSkgfSkpXG4gICAgLmZpbHRlcigocyk6IHMgaXMgeyBpZDogc3RyaW5nOyBlbG86IG51bWJlciB9ID0+IHMuZWxvICE9PSBudWxsKVxuICAgIC5zb3J0KChhLCBiKSA9PiBiLmVsbyAtIGEuZWxvKTtcblxuICBjb25zdCByYXRpbmdzID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgY29uc3QgbiA9IHJhdGVkLmxlbmd0aDtcbiAgaWYgKG4gPT09IDEpIHtcbiAgICByYXRpbmdzLnNldChyYXRlZFswXS5pZCwgNTApO1xuICAgIHJldHVybiByYXRpbmdzO1xuICB9XG5cbiAgbGV0IHN0YXJ0ID0gMDtcbiAgd2hpbGUgKHN0YXJ0IDwgbikge1xuICAgIGxldCBlbmQgPSBzdGFydDtcbiAgICB3aGlsZSAoZW5kICsgMSA8IG4gJiYgcmF0ZWRbZW5kICsgMV0uZWxvID09PSByYXRlZFtzdGFydF0uZWxvKSBlbmQrKztcbiAgICAvLyBSb3VuZGluZyBpbnNpZGUga2VlcHMgYSB0aWUgYXQgdGhlIGV4YWN0IG1pZGRsZSBvbiA1MCByYXRoZXIgdGhhbiA1MVxuICAgIGNvbnN0IHJhdGluZyA9IDEwMCAtIE1hdGgucm91bmQoKDk5ICogKChzdGFydCArIGVuZCkgLyAyKSkgLyAobiAtIDEpKTtcbiAgICBmb3IgKGxldCBpID0gc3RhcnQ7IGkgPD0gZW5kOyBpKyspIHJhdGluZ3Muc2V0KHJhdGVkW2ldLmlkLCByYXRpbmcpO1xuICAgIHN0YXJ0ID0gZW5kICsgMTtcbiAgfVxuICByZXR1cm4gcmF0aW5ncztcbn1cblxuLyoqIFRhcmdldCBTdGFzaCByYXRpbmcgZm9yIGV2ZXJ5IHNjZW5lIHdpdGggYW4gRUxPLCB1bmRlciB0aGUgZ2l2ZW4gbW9kZSAobm9uZSBmb3IgXCJvZmZcIikuICovXG5leHBvcnQgZnVuY3Rpb24gc3Rhc2hSYXRpbmdUYXJnZXRzKHNjZW5lczogU2NlbmVbXSwgbW9kZTogU3Rhc2hSYXRpbmdzTW9kZSk6IE1hcDxzdHJpbmcsIG51bWJlcj4ge1xuICBpZiAobW9kZSA9PT0gXCJwZXJjZW50aWxlXCIpIHJldHVybiBwZXJjZW50aWxlUmF0aW5ncyhzY2VuZXMpO1xuICBjb25zdCB0YXJnZXRzID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgaWYgKG1vZGUgPT09IFwibGluZWFyXCIpIHtcbiAgICBmb3IgKGNvbnN0IHNjZW5lIG9mIHNjZW5lcykge1xuICAgICAgY29uc3QgdmFsdWUgPSBlbG8oc2NlbmUpO1xuICAgICAgaWYgKHZhbHVlICE9PSBudWxsKSB0YXJnZXRzLnNldChzY2VuZS5pZCwgbGluZWFyUmF0aW5nKHZhbHVlKSk7XG4gICAgfVxuICB9XG4gIHJldHVybiB0YXJnZXRzO1xufVxuXG4vKiogVGhlIFN0YXNoIHJhdGluZ3MgYSBzeW5jIHdvdWxkIHdyaXRlOiBzY2VuZSBpZCB0byBuZXcgcmF0aW5nLCBvbmx5IHdoZXJlIGl0IGRpZmZlcnMgZnJvbSBub3cuICovXG5leHBvcnQgZnVuY3Rpb24gc3Rhc2hSYXRpbmdDaGFuZ2VzKHNjZW5lczogU2NlbmVbXSwgbW9kZTogU3Rhc2hSYXRpbmdzTW9kZSk6IE1hcDxzdHJpbmcsIG51bWJlcj4ge1xuICBjb25zdCBjdXJyZW50ID0gbmV3IE1hcChzY2VuZXMubWFwKChzY2VuZSkgPT4gW3NjZW5lLmlkLCBzY2VuZS5yYXRpbmcxMDAgPz8gbnVsbF0pKTtcbiAgY29uc3QgY2hhbmdlcyA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG4gIGZvciAoY29uc3QgW2lkLCByYXRpbmddIG9mIHN0YXNoUmF0aW5nVGFyZ2V0cyhzY2VuZXMsIG1vZGUpKSB7XG4gICAgaWYgKGN1cnJlbnQuZ2V0KGlkKSAhPT0gcmF0aW5nKSBjaGFuZ2VzLnNldChpZCwgcmF0aW5nKTtcbiAgfVxuICByZXR1cm4gY2hhbmdlcztcbn1cblxuLyoqXG4gKiBFTE8gYW5kIGdhbWVzIGEgc2NlbmUgZ2V0cyBmcm9tIHRoZSBvbmUtdGltZSBzZXR1cCwgb3IgbnVsbCB3aGVuIGl0IHN0YXJ0cyB1bnJhdGVkLlxuICogXCJyYXRpbmdzXCIgc2VlZHMgcmF0ZWQgc2NlbmVzIGZyb20gdGhlaXIgU3Rhc2ggcmF0aW5nOyBcImZyZXNoXCIgc3RhcnRzIGV2ZXJ5IHNjZW5lIGF0IDE1MDAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzdGFydGluZ0VsbyhzY2VuZTogU2NlbmUsIHN0YXJ0OiBFbG9TdGFydCk6IEVsb0ZpZWxkcyB8IG51bGwge1xuICBpZiAoc3RhcnQgPT09IFwiZnJlc2hcIikgcmV0dXJuIHsgZWxvOiBFTE9fU1RBUlQsIGJhdHRsZXM6IDAsIHNlZWRlZDogZmFsc2UgfTtcbiAgcmV0dXJuIHNjZW5lLnJhdGluZzEwMCAhPSBudWxsID8geyBlbG86IHNlZWQoc2NlbmUucmF0aW5nMTAwKSwgYmF0dGxlczogMCwgc2VlZGVkOiB0cnVlIH0gOiBudWxsO1xufVxuXG4vKiogQSBjb3B5IG9mIGEgY3VzdG9tIGZpZWxkcyBtYXAgd2l0aCB0aGUgRUxPIGZpZWxkcyBzZXQgdG8gYHZhbHVlYCAob3IsIHdpdGggbnVsbCwgcmVtb3ZlZCkuICovXG5leHBvcnQgZnVuY3Rpb24gd2l0aEVsb0ZpZWxkcyhjdXN0b21GaWVsZHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbCB8IHVuZGVmaW5lZCwgdmFsdWU6IEVsb0ZpZWxkcyB8IG51bGwpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gIGNvbnN0IGZpZWxkcyA9IHsgLi4uY3VzdG9tRmllbGRzIH07XG4gIGZvciAoY29uc3Qga2V5IG9mIEVMT19GSUVMRF9LRVlTKSBkZWxldGUgZmllbGRzW2tleV07XG4gIGlmICh2YWx1ZSkgT2JqZWN0LmFzc2lnbihmaWVsZHMsIGVsb0N1c3RvbUZpZWxkcyh2YWx1ZSkpO1xuICByZXR1cm4gZmllbGRzO1xufVxuXG4vKiogVGhlIHNjZW5lJ3MgRUxPIGZpZWxkcywgb3IgbnVsbCB3aGVuIGl0J3MgdW5yYXRlZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlbG9GaWVsZHMoc2NlbmU6IFNjZW5lKTogRWxvRmllbGRzIHwgbnVsbCB7XG4gIGNvbnN0IHZhbHVlID0gZWxvKHNjZW5lKTtcbiAgcmV0dXJuIHZhbHVlID09PSBudWxsID8gbnVsbCA6IHsgZWxvOiB2YWx1ZSwgYmF0dGxlczogYmF0dGxlcyhzY2VuZSksIHNlZWRlZDogaXNTZWVkZWQoc2NlbmUpIH07XG59XG5cbi8qKiBBIGNvcHkgb2YgdGhlIHNjZW5lIGFzIGl0IHdvdWxkIGJlIHJpZ2h0IGFmdGVyIHNldHVwIChpdHMgRUxPIGZpZWxkcyByZXBsYWNlZCkuICovXG5leHBvcnQgZnVuY3Rpb24gYWZ0ZXJTZXR1cChzY2VuZTogU2NlbmUsIHN0YXJ0OiBFbG9TdGFydCk6IFNjZW5lIHtcbiAgcmV0dXJuIHsgLi4uc2NlbmUsIGN1c3RvbV9maWVsZHM6IHdpdGhFbG9GaWVsZHMoc2NlbmUuY3VzdG9tX2ZpZWxkcywgc3RhcnRpbmdFbG8oc2NlbmUsIHN0YXJ0KSkgfTtcbn1cblxuLyoqIEhpZ2hlc3QgRUxPIGZpcnN0LCB1bnJhdGVkIHNjZW5lcyBsYXN0LiBFcXVhbCBFTE9zIGtlZXAgdGhlaXIgb3JkZXIgKEFycmF5LnNvcnQgaXMgc3RhYmxlKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb21wYXJlQnlFbG8oYTogU2NlbmUsIGI6IFNjZW5lKTogbnVtYmVyIHtcbiAgY29uc3QgZWxvQSA9IGVsbyhhKTtcbiAgY29uc3QgZWxvQiA9IGVsbyhiKTtcbiAgaWYgKGVsb0EgPT09IG51bGwpIHJldHVybiBlbG9CID09PSBudWxsID8gMCA6IDE7XG4gIGlmIChlbG9CID09PSBudWxsKSByZXR1cm4gLTE7XG4gIHJldHVybiBlbG9CIC0gZWxvQTtcbn1cblxuLyoqIFNvcnQgc2NlbmVzIGluIHBsYWNlIGJ5IEVMTyAoc2VlIGNvbXBhcmVCeUVsbykgYW5kIHJldHVybiB0aGUgc2FtZSBhcnJheS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzb3J0QnlFbG8oc2NlbmVzOiBTY2VuZVtdKTogU2NlbmVbXSB7XG4gIHJldHVybiBzY2VuZXMuc29ydChjb21wYXJlQnlFbG8pO1xufVxuXG4vKiogSW5kZXggd2hlcmUgYSBzY2VuZSB3aXRoIHRoaXMgRUxPIHdvdWxkIHNpdCBpbiBhbiBFTE8tc29ydGVkIHBvb2w6IGJlbG93IGV2ZXJ5IGVxdWFsIG9yIGhpZ2hlciBvbmUuICovXG5leHBvcnQgZnVuY3Rpb24gZWxvSW5zZXJ0aW9uSW5kZXgocG9vbDogU2NlbmVbXSwgZWxvVmFsdWU6IG51bWJlcik6IG51bWJlciB7XG4gIGNvbnN0IGlkeCA9IHBvb2wuZmluZEluZGV4KChzKSA9PiB7XG4gICAgY29uc3Qgb3RoZXIgPSBlbG8ocyk7XG4gICAgcmV0dXJuIG90aGVyID09PSBudWxsIHx8IG90aGVyIDwgZWxvVmFsdWU7XG4gIH0pO1xuICByZXR1cm4gaWR4ID09PSAtMSA/IHBvb2wubGVuZ3RoIDogaWR4O1xufVxuXG4vKipcbiAqIEVMTyBmb3IgYSBzY2VuZSBQbGFjZW1lbnQgbGFuZHMgYmV0d2VlbiB0d28gbmVpZ2hib3VycyAobnVsbCB3aGVyZSB0aGVyZSdzIG5vbmUsIG9yIHRoZVxuICogbmVpZ2hib3VyIGlzIHVucmF0ZWQpOiB0aGVpciBtaWRwb2ludCwgb3IgUExBQ0VNRU5UX0VER0VfR0FQIGJleW9uZCB0aGUgb25seSBvbmUgYXQgYW4gZWRnZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBsYWNlbWVudEVsbyhhYm92ZUVsbzogbnVtYmVyIHwgbnVsbCwgYmVsb3dFbG86IG51bWJlciB8IG51bGwpOiBudW1iZXIge1xuICBpZiAoYWJvdmVFbG8gPT09IG51bGwgJiYgYmVsb3dFbG8gPT09IG51bGwpIHJldHVybiBFTE9fU1RBUlQ7XG4gIGlmIChhYm92ZUVsbyA9PT0gbnVsbCkgcmV0dXJuIHJvdW5kRWxvKChiZWxvd0VsbyBhcyBudW1iZXIpICsgUExBQ0VNRU5UX0VER0VfR0FQKTtcbiAgaWYgKGJlbG93RWxvID09PSBudWxsKSByZXR1cm4gcm91bmRFbG8oYWJvdmVFbG8gLSBQTEFDRU1FTlRfRURHRV9HQVApO1xuICAvLyBOZWlnaGJvdXJzIDAuMSBhcGFydCAob3IgdGllZCkgaGF2ZSBubyByb29tIGJldHdlZW4gdGhlbTogdGFrZSB0aGUgdXBwZXIgb25lJ3MgRUxPLCB3aGljaFxuICAvLyBzdGlsbCBzb3J0cyB0aGUgc2NlbmUgYmVsb3cgaXQgKGVxdWFsIEVMT3MgZ28gYmVsb3cpIGFuZCBzbyBpbiB0aGUgc2FtZSBzbG90XG4gIGNvbnN0IG1pZCA9IHJvdW5kRWxvKChhYm92ZUVsbyArIGJlbG93RWxvKSAvIDIpO1xuICByZXR1cm4gbWlkID4gYmVsb3dFbG8gPyBtaWQgOiBhYm92ZUVsbztcbn1cbiIsICIvLyBHcmFwaFFMIGFjY2VzcyBhZ2FpbnN0IHRoZSBTdGFzaCBiYWNrZW5kLlxuXG5pbXBvcnQgdHlwZSB7IEFwb2xsb0NhY2hlTGlrZSB9IGZyb20gXCIuL3BsdWdpbkFwaVwiO1xuaW1wb3J0IHsgd2l0aEVsb0ZpZWxkcyB9IGZyb20gXCIuL3Njb3JlXCI7XG5pbXBvcnQgdHlwZSB7IEVsb0ZpZWxkcywgRmluZFNjZW5lUmVzdWx0LCBTY2VuZSB9IGZyb20gXCIuL3R5cGVzXCI7XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBncmFwaHFsUXVlcnk8VCA9IHVua25vd24+KFxuICBxdWVyeTogc3RyaW5nLFxuICB2YXJpYWJsZXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge30sXG4pOiBQcm9taXNlPFQ+IHtcbiAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChcIi9ncmFwaHFsXCIsIHtcbiAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgIGhlYWRlcnM6IHtcbiAgICAgIFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiLFxuICAgIH0sXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBxdWVyeSwgdmFyaWFibGVzIH0pLFxuICB9KTtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVzcG9uc2UuanNvbigpO1xuICBpZiAocmVzdWx0LmVycm9ycykge1xuICAgIGNvbnNvbGUuZXJyb3IoXCJbU3Rhc2ggQmF0dGxlXSBHcmFwaFFMIGVycm9yOlwiLCByZXN1bHQuZXJyb3JzKTtcbiAgICB0aHJvdyBuZXcgRXJyb3IocmVzdWx0LmVycm9yc1swXS5tZXNzYWdlKTtcbiAgfVxuICByZXR1cm4gcmVzdWx0LmRhdGEgYXMgVDtcbn1cblxuZXhwb3J0IGNvbnN0IFNDRU5FX0ZSQUdNRU5UID0gYFxuICAgIGlkXG4gICAgdGl0bGVcbiAgICBkYXRlXG4gICAgcmF0aW5nMTAwXG4gICAgcGxheV9jb3VudFxuICAgIGN1c3RvbV9maWVsZHNcbiAgICBwYXRocyB7XG4gICAgICBzY3JlZW5zaG90XG4gICAgICBwcmV2aWV3XG4gICAgfVxuICAgIGZpbGVzIHtcbiAgICAgIGR1cmF0aW9uXG4gICAgICBwYXRoXG4gICAgfVxuICAgIHN0dWRpbyB7XG4gICAgICBuYW1lXG4gICAgfVxuICAgIHBlcmZvcm1lcnMge1xuICAgICAgbmFtZVxuICAgIH1cbiAgICB0YWdzIHtcbiAgICAgIG5hbWVcbiAgICB9XG4gIGA7XG5cbmV4cG9ydCBjb25zdCBGSU5EX1NDRU5FU19RVUVSWSA9IGBcbiAgICAgIHF1ZXJ5IEZpbmRTY2VuZXNCeVJhdGluZygkZmlsdGVyOiBGaW5kRmlsdGVyVHlwZSwgJHNjZW5lX2ZpbHRlcjogU2NlbmVGaWx0ZXJUeXBlKSB7XG4gICAgICAgIGZpbmRTY2VuZXMoZmlsdGVyOiAkZmlsdGVyLCBzY2VuZV9maWx0ZXI6ICRzY2VuZV9maWx0ZXIpIHtcbiAgICAgICAgICBjb3VudFxuICAgICAgICAgIHNjZW5lcyB7XG4gICAgICAgICAgICAke1NDRU5FX0ZSQUdNRU5UfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIGA7XG5cbmxldCBjdXN0b21GaWVsZHNTdXBwb3J0OiBQcm9taXNlPGJvb2xlYW4+IHwgbnVsbCA9IG51bGw7XG5cbi8qKlxuICogV2hldGhlciB0aGlzIFN0YXNoIGhhcyBzY2VuZSBjdXN0b20gZmllbGRzIChuZWVkZWQgZm9yIEVMTyBzdG9yYWdlKS4gQ2hlY2tlZCBvbmNlIHBlciBwYWdlXG4gKiBsb2FkIHZpYSBpbnRyb3NwZWN0aW9uOyBpZiBpbnRyb3NwZWN0aW9uIGl0c2VsZiBmYWlscywgYXNzdW1lIHllcyBhbmQgbGV0IHJlYWwgcXVlcmllcyByZXBvcnQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzY2VuZUN1c3RvbUZpZWxkc1N1cHBvcnRlZCgpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgY3VzdG9tRmllbGRzU3VwcG9ydCA/Pz0gZ3JhcGhxbFF1ZXJ5PHsgX190eXBlOiB7IGZpZWxkczogeyBuYW1lOiBzdHJpbmcgfVtdIH0gfCBudWxsIH0+KFxuICAgIGBxdWVyeSB7IF9fdHlwZShuYW1lOiBcIlNjZW5lXCIpIHsgZmllbGRzIHsgbmFtZSB9IH0gfWAsXG4gIClcbiAgICAudGhlbigoZGF0YSkgPT4gZGF0YS5fX3R5cGU/LmZpZWxkcy5zb21lKChmKSA9PiBmLm5hbWUgPT09IFwiY3VzdG9tX2ZpZWxkc1wiKSA/PyB0cnVlKVxuICAgIC5jYXRjaCgoZSkgPT4ge1xuICAgICAgY29uc29sZS53YXJuKFwiW1N0YXNoIEJhdHRsZV0gQ291bGQgbm90IGNoZWNrIGZvciBzY2VuZSBjdXN0b20gZmllbGRzOlwiLCBlKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0pO1xuICByZXR1cm4gY3VzdG9tRmllbGRzU3VwcG9ydDtcbn1cblxuLyoqIEEgY2hhbmdlIFN0YXNoIEJhdHRsZSB3cm90ZSB0byBhIHNjZW5lLCB0byBtaXJyb3IgaW50byBTdGFzaCdzIG93biBwYWdlIGNhY2hlLiAqL1xuZXhwb3J0IGludGVyZmFjZSBTdGFzaENhY2hlVXBkYXRlIHtcbiAgaWQ6IHN0cmluZztcbiAgcmF0aW5nMTAwPzogbnVtYmVyO1xuICAvKiogTmV3IEVMTyBmaWVsZHMsIG9yIG51bGwgd2hlbiB0aGV5IHdlcmUgcmVtb3ZlZC4gKi9cbiAgZWxvPzogRWxvRmllbGRzIHwgbnVsbDtcbn1cblxuZnVuY3Rpb24gc3Rhc2hBcG9sbG9DYWNoZSgpOiBBcG9sbG9DYWNoZUxpa2UgfCB1bmRlZmluZWQge1xuICB0cnkge1xuICAgIHJldHVybiB3aW5kb3cuUGx1Z2luQXBpPy51dGlscz8uU3Rhc2hTZXJ2aWNlPy5nZXRDbGllbnQ/LigpPy5jYWNoZTtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxufVxuXG4vKiogV2hpbGUgU3Rhc2ggQmF0dGxlIGlzIG9wZW4sIFN0YXNoJ3MgY2FjaGVkIHNjZW5lIGxpc3RzIGFyZSBkcm9wcGVkIG9uY2Ugb24gY2xvc2UsIG5vdCBldmVyeSBiYXR0bGUuICovXG5sZXQgaG9sZExpc3RSZWZyZXNoID0gZmFsc2U7XG5sZXQgbGlzdHNTdGFsZSA9IGZhbHNlO1xuXG4vKiogRHJvcCBTdGFzaCdzIGNhY2hlZCBzY2VuZSBsaXN0cyAodGhleSByZWZldGNoKSwgc28gcmF0aW5nLXNvcnRlZCBsaXN0cyByZS1zb3J0LiAqL1xuZnVuY3Rpb24gZHJvcFN0YXNoTGlzdHMoY2FjaGU6IEFwb2xsb0NhY2hlTGlrZSB8IHVuZGVmaW5lZCA9IHN0YXNoQXBvbGxvQ2FjaGUoKSk6IHZvaWQge1xuICBsaXN0c1N0YWxlID0gZmFsc2U7XG4gIGlmICghY2FjaGUpIHJldHVybjtcbiAgdHJ5IHtcbiAgICBjYWNoZS5ldmljdCh7IGlkOiBcIlJPT1RfUVVFUllcIiwgZmllbGROYW1lOiBcImZpbmRTY2VuZXNcIiB9KTtcbiAgICBjYWNoZS5nYygpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS53YXJuKFwiW1N0YXNoIEJhdHRsZV0gQ291bGQgbm90IHJlZnJlc2ggU3Rhc2gncyBzY2VuZSBsaXN0czpcIiwgZSk7XG4gIH1cbn1cblxuLyoqXG4gKiBIb2xkIGJhY2sgZHJvcHBpbmcgU3Rhc2gncyBzY2VuZSBsaXN0cyB3aGlsZSBTdGFzaCBCYXR0bGUgaXMgb3BlbiAodHJ1ZSk7IHJlbGVhc2luZyBpdCAoZmFsc2UpXG4gKiBkcm9wcyB0aGVtIG9uY2UgaWYgcmF0aW5ncyBjaGFuZ2VkIG1lYW53aGlsZS4gVGhlIHBhZ2VzIGJlaGluZCB0aGUgbW9kYWwgY2FuIHdhaXQsIGFuZCBhIGRyb3BcbiAqIHBlciBiYXR0bGUgd291bGQgcmVmZXRjaCBldmVyeSBsaXN0IGVhY2ggcGljay5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhvbGRTdGFzaExpc3RSZWZyZXNoKGhvbGQ6IGJvb2xlYW4pOiB2b2lkIHtcbiAgaG9sZExpc3RSZWZyZXNoID0gaG9sZDtcbiAgaWYgKCFob2xkICYmIGxpc3RzU3RhbGUpIGRyb3BTdGFzaExpc3RzKCk7XG59XG5cbi8qKlxuICogU3Rhc2ggQmF0dGxlIHdyaXRlcyB3aXRoIHBsYWluIGZldGNoLCBzbyBTdGFzaCdzIG93biBwYWdlcyAoQXBvbGxvKSBuZXZlciBzZWUgdGhlIGNoYW5nZXMgYW5kXG4gKiBrZWVwIHNob3dpbmcgb2xkIHJhdGluZ3MgdW50aWwgcmVmcmVzaGVkLiBNaXJyb3IgdGhlIGNoYW5nZXMgaW50byBBcG9sbG8ncyBjYWNoZWQgc2NlbmVzLCBhbmRcbiAqIHdoZW4gcmF0aW5ncyBjaGFuZ2VkLCBkcm9wIGNhY2hlZCBzY2VuZSBsaXN0cyBzbyByYXRpbmctc29ydGVkIGxpc3RzIHJlLXNvcnQgKGhlbGQgYmFjayB3aGlsZVxuICogU3Rhc2ggQmF0dGxlIGlzIG9wZW4sIHNlZSBob2xkU3Rhc2hMaXN0UmVmcmVzaCkuIERvZXMgbm90aGluZyBpZiBTdGFzaCBkb2Vzbid0IGV4cG9zZSBpdHMgY2xpZW50LlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVmcmVzaFN0YXNoQ2FjaGUodXBkYXRlczogU3Rhc2hDYWNoZVVwZGF0ZVtdLCByYXRpbmdzQ2hhbmdlZDogYm9vbGVhbik6IHZvaWQge1xuICBjb25zdCBjYWNoZSA9IHN0YXNoQXBvbGxvQ2FjaGUoKTtcbiAgaWYgKCFjYWNoZSkgcmV0dXJuO1xuICB0cnkge1xuICAgIGZvciAoY29uc3QgdXBkYXRlIG9mIHVwZGF0ZXMpIHtcbiAgICAgIGNvbnN0IGlkID0gY2FjaGUuaWRlbnRpZnkoeyBfX3R5cGVuYW1lOiBcIlNjZW5lXCIsIGlkOiB1cGRhdGUuaWQgfSk7XG4gICAgICBpZiAoIWlkKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IGZpZWxkczogUmVjb3JkPHN0cmluZywgKGV4aXN0aW5nOiB1bmtub3duKSA9PiB1bmtub3duPiA9IHt9O1xuICAgICAgaWYgKHVwZGF0ZS5yYXRpbmcxMDAgIT09IHVuZGVmaW5lZCkgZmllbGRzLnJhdGluZzEwMCA9ICgpID0+IHVwZGF0ZS5yYXRpbmcxMDA7XG4gICAgICBpZiAodXBkYXRlLmVsbyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGNvbnN0IHZhbHVlID0gdXBkYXRlLmVsbztcbiAgICAgICAgZmllbGRzLmN1c3RvbV9maWVsZHMgPSAoZXhpc3RpbmcpID0+IHdpdGhFbG9GaWVsZHMoZXhpc3RpbmcgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCBudWxsLCB2YWx1ZSk7XG4gICAgICB9XG4gICAgICAvLyBBcG9sbG8gb25seSBjYWxscyBtb2RpZmllcnMgZm9yIGZpZWxkcyBpdCBoYXMgY2FjaGVkLCBzbyBtaXNzaW5nIG9uZXMgYXJlIHNraXBwZWRcbiAgICAgIGNhY2hlLm1vZGlmeSh7IGlkLCBmaWVsZHMgfSk7XG4gICAgfVxuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS53YXJuKFwiW1N0YXNoIEJhdHRsZV0gQ291bGQgbm90IHVwZGF0ZSBTdGFzaCdzIHBhZ2UgY2FjaGU6XCIsIGUpO1xuICB9XG4gIGlmIChyYXRpbmdzQ2hhbmdlZCkge1xuICAgIGxpc3RzU3RhbGUgPSB0cnVlO1xuICAgIGlmICghaG9sZExpc3RSZWZyZXNoKSBkcm9wU3Rhc2hMaXN0cyhjYWNoZSk7XG4gIH1cbn1cblxuLy8gRXh0cmFjdCBzY2VuZSBJRCBmcm9tIGluZGl2aWR1YWwgc2NlbmUgcGFnZXMgbGlrZSAvc2NlbmVzLzEyM1xuZXhwb3J0IGZ1bmN0aW9uIGdldFNjZW5lSWRGcm9tVXJsKCk6IHN0cmluZyB8IG51bGwge1xuICBjb25zdCBtYXRjaCA9IHdpbmRvdy5sb2NhdGlvbi5wYXRobmFtZS5tYXRjaCgvXlxcL3NjZW5lc1xcLyhcXGQrKSQvKTtcbiAgcmV0dXJuIG1hdGNoID8gbWF0Y2hbMV0gOiBudWxsO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmV0Y2hTY2VuZUJ5SWQoc2NlbmVJZDogc3RyaW5nKTogUHJvbWlzZTxTY2VuZSB8IG51bGw+IHtcbiAgY29uc3QgcXVlcnkgPSBgXG4gICAgICBxdWVyeSBGaW5kU2NlbmUoJGlkOiBJRCEpIHtcbiAgICAgICAgZmluZFNjZW5lKGlkOiAkaWQpIHtcbiAgICAgICAgICAke1NDRU5FX0ZSQUdNRU5UfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgYDtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZ3JhcGhxbFF1ZXJ5PEZpbmRTY2VuZVJlc3VsdD4ocXVlcnksIHsgaWQ6IHNjZW5lSWQgfSk7XG4gIHJldHVybiByZXN1bHQuZmluZFNjZW5lO1xufVxuIiwgIi8vIENsZWFuIG1vZGU6IG9wZW4gU3Rhc2gncyBvd24gRGVsZXRlU2NlbmVzRGlhbG9nLCBzbyBkZWxldGluZyBmcm9tIGEgYmF0dGxlIGJlaGF2ZXMgZXhhY3RseSBsaWtlXHJcbi8vIGRlbGV0aW5nIGluIFN0YXNoIChzYW1lIG9wdGlvbnMgYW5kIGRlZmF1bHRzLCBmaWxlIGxpc3QsIGRlbGV0ZSBjYWxsIGFuZCB0b2FzdCkuXHJcbi8vXHJcbi8vIFRoZSBkaWFsb2cgbmVlZHMgU3Rhc2gncyBSZWFjdCBjb250ZXh0IChpbnRsLCBjb25maWd1cmF0aW9uLCBBcG9sbG8sIHRvYXN0cyksIHNvIGl0IGNhbid0IGJlXHJcbi8vIHJlbmRlcmVkIHN0YW5kYWxvbmUuIEluc3RlYWQgYSBzbWFsbCBicmlkZ2UgY29tcG9uZW50IGlzIHBhdGNoZWQgaW50byBTdGFzaCdzIG5hdmJhciAoYWx3YXlzXHJcbi8vIG1vdW50ZWQpIGFuZCBvcGVucyB0aGUgZGlhbG9nIHdoZW4gQmF0dGxlIGFza3MgZm9yIGl0LiByZWFjdC1ib290c3RyYXAgcG9ydGFscyB0aGUgbW9kYWwgdG9cclxuLy8gPGJvZHk+OyBDU1MgbGlmdHMgaXQgYWJvdmUgdGhlIGJhdHRsZSBtb2RhbCB3aGlsZSBCYXR0bGUgaXMgb3Blbi5cclxuXHJcbmltcG9ydCB7IGdyYXBocWxRdWVyeSB9IGZyb20gXCIuLi9ncmFwaHFsXCI7XHJcbmltcG9ydCB0eXBlIHsgUmVhY3ROb2RlIH0gZnJvbSBcIi4uL3BsdWdpbkFwaVwiO1xyXG5pbXBvcnQgdHlwZSB7IFNjZW5lIH0gZnJvbSBcIi4uL3R5cGVzXCI7XHJcblxyXG4vKiogU2NlbmUgZmllbGRzIERlbGV0ZVNjZW5lc0RpYWxvZyByZWFkcyAoZmlsZSBsaXN0LCBmdW5zY3JpcHQsIG11dGF0aW9uIGlkcykuICovXHJcbmludGVyZmFjZSBEZWxldGFibGVTY2VuZSB7XHJcbiAgaWQ6IHN0cmluZztcclxuICB0aXRsZTogc3RyaW5nIHwgbnVsbDtcclxuICBpbnRlcmFjdGl2ZTogYm9vbGVhbjtcclxuICBmaWxlczogeyBwYXRoOiBzdHJpbmcgfVtdO1xyXG59XHJcblxyXG5jb25zdCBPUEVOX0VWRU5UID0gXCJzdGFzaC1iYXR0bGU6b3Blbi1kZWxldGUtZGlhbG9nXCI7XHJcbmNvbnN0IENMT1NFX0VWRU5UID0gXCJzdGFzaC1iYXR0bGU6Y2xvc2UtZGVsZXRlLWRpYWxvZ1wiO1xyXG5cclxubGV0IGJyaWRnZVJlZ2lzdGVyZWQgPSBmYWxzZTtcclxubGV0IHBlbmRpbmdSZXN1bHQ6ICgoZGVsZXRlZDogYm9vbGVhbikgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcclxuLyoqIFN0YXNoJ3MgRGVsZXRlU2NlbmVzRGlhbG9nIGNvbXBvbmVudCwgb25jZSBpdHMgY2h1bmsgaGFzIGxvYWRlZC4gKi9cclxubGV0IERlbGV0ZVNjZW5lc0RpYWxvZzogdW5rbm93biA9IG51bGw7XHJcbmxldCBkaWFsb2dMb2FkZWQ6IFByb21pc2U8dm9pZD4gPSBQcm9taXNlLnJlc29sdmUoKTtcclxuXHJcbmZ1bmN0aW9uIHNldHRsZShkZWxldGVkOiBib29sZWFuKTogdm9pZCB7XHJcbiAgY29uc3QgcmVzb2x2ZSA9IHBlbmRpbmdSZXN1bHQ7XHJcbiAgcGVuZGluZ1Jlc3VsdCA9IG51bGw7XHJcbiAgcmVzb2x2ZT8uKGRlbGV0ZWQpO1xyXG59XHJcblxyXG4vKiogVHJ1ZSB3aGVuIHRoaXMgU3Rhc2ggZXhwb3NlcyBpdHMgZGVsZXRlIGRpYWxvZyB0byBwbHVnaW5zIChDbGVhbiBtb2RlIGRlcGVuZHMgb24gaXQpLiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gaXNTdGFzaERlbGV0ZURpYWxvZ0F2YWlsYWJsZSgpOiBib29sZWFuIHtcclxuICByZXR1cm4gYnJpZGdlUmVnaXN0ZXJlZDtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGlzRGVsZXRlRGlhbG9nT3BlbigpOiBib29sZWFuIHtcclxuICByZXR1cm4gcGVuZGluZ1Jlc3VsdCAhPT0gbnVsbDtcclxufVxyXG5cclxuLyoqIENsb3NlIHRoZSBkaWFsb2cgd2l0aG91dCBkZWxldGluZyAoZS5nLiB3aGVuIHRoZSBiYXR0bGUgbW9kYWwgY2xvc2VzKS4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGNhbmNlbERlbGV0ZURpYWxvZygpOiB2b2lkIHtcclxuICBpZiAoIXBlbmRpbmdSZXN1bHQpIHJldHVybjtcclxuICB3aW5kb3cuZGlzcGF0Y2hFdmVudChuZXcgQ3VzdG9tRXZlbnQoQ0xPU0VfRVZFTlQpKTtcclxuICBzZXR0bGUoZmFsc2UpO1xyXG59XHJcblxyXG4vKiogUGF0Y2ggdGhlIGJyaWRnZSBpbnRvIFN0YXNoJ3MgbmF2YmFyLiBDYWxsIG9uY2UgYXQgc3RhcnR1cCwgYmVmb3JlIHRoZSBuYXZiYXIgcmVuZGVycy4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdGVyRGVsZXRlRGlhbG9nQnJpZGdlKCk6IHZvaWQge1xyXG4gIGNvbnN0IGFwaSA9IHdpbmRvdy5QbHVnaW5BcGk7XHJcbiAgaWYgKGJyaWRnZVJlZ2lzdGVyZWQgfHwgIWFwaT8ubG9hZGFibGVDb21wb25lbnRzPy5EZWxldGVTY2VuZXNEaWFsb2cpIHtcclxuICAgIGlmICghYXBpPy5sb2FkYWJsZUNvbXBvbmVudHM/LkRlbGV0ZVNjZW5lc0RpYWxvZykge1xyXG4gICAgICBjb25zb2xlLndhcm4oXCJbU3Rhc2ggQmF0dGxlXSBTdGFzaCdzIGRlbGV0ZSBkaWFsb2cgaXNuJ3QgYXZhaWxhYmxlIHRvIHBsdWdpbnM7IENsZWFuIG1vZGUgaXMgZGlzYWJsZWRcIik7XHJcbiAgICB9XHJcbiAgICByZXR1cm47XHJcbiAgfVxyXG4gIGJyaWRnZVJlZ2lzdGVyZWQgPSB0cnVlO1xyXG4gIGNvbnN0IHsgUmVhY3QgfSA9IGFwaTtcclxuXHJcbiAgLy8gTG9hZCB0aGUgZGlhbG9nJ3MgY2h1bmsgdXAgZnJvbnQgc28gaXQgb3BlbnMgaW5zdGFudGx5XHJcbiAgZGlhbG9nTG9hZGVkID0gYXBpLmxvYWRhYmxlQ29tcG9uZW50c1xyXG4gICAgLkRlbGV0ZVNjZW5lc0RpYWxvZygpXHJcbiAgICAudGhlbigobW9kKSA9PiB7XHJcbiAgICAgIERlbGV0ZVNjZW5lc0RpYWxvZyA9IG1vZC5EZWxldGVTY2VuZXNEaWFsb2cgPz8gbW9kLmRlZmF1bHQgPz8gbnVsbDtcclxuICAgIH0pXHJcbiAgICAuY2F0Y2goKGUpID0+IGNvbnNvbGUuZXJyb3IoXCJbU3Rhc2ggQmF0dGxlXSBGYWlsZWQgdG8gbG9hZCBTdGFzaCdzIGRlbGV0ZSBkaWFsb2c6XCIsIGUpKTtcclxuXHJcbiAgZnVuY3Rpb24gRGVsZXRlQnJpZGdlKCk6IFJlYWN0Tm9kZSB7XHJcbiAgICBjb25zdCBbc2NlbmUsIHNldFNjZW5lXSA9IFJlYWN0LnVzZVN0YXRlPERlbGV0YWJsZVNjZW5lIHwgbnVsbD4obnVsbCk7XHJcblxyXG4gICAgUmVhY3QudXNlRWZmZWN0KCgpID0+IHtcclxuICAgICAgY29uc3Qgb3BlbiA9IChlOiBFdmVudCk6IHZvaWQgPT4ge1xyXG4gICAgICAgIC8vIFRoZSBuYXZiYXIgY2FuIHJlbmRlciBtb3JlIHRoYW4gb25jZTsgdGhlIGZpcnN0IGJyaWRnZSB0byBoZWFyIHRoZSBldmVudCBoYW5kbGVzIGl0LlxyXG4gICAgICAgIC8vIHByZXZlbnREZWZhdWx0IHRlbGxzIGNvbmZpcm1EZWxldGVTY2VuZSB0aGUgcmVxdWVzdCB3YXMgcGlja2VkIHVwLlxyXG4gICAgICAgIGUuc3RvcEltbWVkaWF0ZVByb3BhZ2F0aW9uKCk7XHJcbiAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xyXG4gICAgICAgIHNldFNjZW5lKChlIGFzIEN1c3RvbUV2ZW50PERlbGV0YWJsZVNjZW5lPikuZGV0YWlsKTtcclxuICAgICAgfTtcclxuICAgICAgY29uc3QgY2xvc2UgPSAoKTogdm9pZCA9PiBzZXRTY2VuZShudWxsKTtcclxuICAgICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoT1BFTl9FVkVOVCwgb3Blbik7XHJcbiAgICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKENMT1NFX0VWRU5ULCBjbG9zZSk7XHJcbiAgICAgIHJldHVybiAoKSA9PiB7XHJcbiAgICAgICAgd2luZG93LnJlbW92ZUV2ZW50TGlzdGVuZXIoT1BFTl9FVkVOVCwgb3Blbik7XHJcbiAgICAgICAgd2luZG93LnJlbW92ZUV2ZW50TGlzdGVuZXIoQ0xPU0VfRVZFTlQsIGNsb3NlKTtcclxuICAgICAgfTtcclxuICAgIH0sIFtdKTtcclxuXHJcbiAgICBpZiAoIXNjZW5lIHx8ICFEZWxldGVTY2VuZXNEaWFsb2cpIHJldHVybiBudWxsO1xyXG4gICAgcmV0dXJuIFJlYWN0LmNyZWF0ZUVsZW1lbnQoRGVsZXRlU2NlbmVzRGlhbG9nLCB7XHJcbiAgICAgIHNlbGVjdGVkOiBbc2NlbmVdLFxyXG4gICAgICBvbkNsb3NlOiAoZGVsZXRlZDogYm9vbGVhbikgPT4ge1xyXG4gICAgICAgIHNldFNjZW5lKG51bGwpO1xyXG4gICAgICAgIHNldHRsZShkZWxldGVkKTtcclxuICAgICAgfSxcclxuICAgIH0pO1xyXG4gIH1cclxuXHJcbiAgLy8gU3Rhc2ggYXBwZW5kcyB0aGUgcmVuZGVyZWQgcmVzdWx0IGFmdGVyIHRoZSBjYWxsJ3MgYXJncywgYW5kIGFub3RoZXIgcGx1Z2luJ3MgYGJlZm9yZWAgcGF0Y2hcclxuICAvLyBjYW4gY2hhbmdlIGhvdyBtYW55IGFyZ3MgdGhlcmUgYXJlLCBzbyB0aGUgcmVzdWx0IGlzIGFsd2F5cyB0aGUgbGFzdCBvbmUsIG5vdCBhIGZpeGVkIHNsb3QuXHJcbiAgYXBpLnBhdGNoLmFmdGVyKFwiTWFpbk5hdkJhci5VdGlsaXR5SXRlbXNcIiwgKC4uLmFyZ3M6IHVua25vd25bXSkgPT5cclxuICAgIFJlYWN0LmNyZWF0ZUVsZW1lbnQoXHJcbiAgICAgIFJlYWN0LkZyYWdtZW50LFxyXG4gICAgICBudWxsLFxyXG4gICAgICBhcmdzW2FyZ3MubGVuZ3RoIC0gMV0gYXMgUmVhY3ROb2RlLFxyXG4gICAgICBSZWFjdC5jcmVhdGVFbGVtZW50KERlbGV0ZUJyaWRnZSksXHJcbiAgICApLFxyXG4gICk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBPcGVuIFN0YXNoJ3MgZGVsZXRlIGRpYWxvZyBmb3IgYHNjZW5lYC4gUmVzb2x2ZXMgdHJ1ZSBvbmNlIFN0YXNoIGhhcyBkZWxldGVkIGl0LCBmYWxzZSBpZiB0aGVcclxuICogdXNlciBjYW5jZWxsZWQgKG9yIHRoZSBkZWxldGUgZmFpbGVkIOKAlCBTdGFzaCBzaG93cyBpdHMgb3duIGVycm9yIHRvYXN0KS5cclxuICovXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjb25maXJtRGVsZXRlU2NlbmUoc2NlbmU6IFNjZW5lKTogUHJvbWlzZTxib29sZWFuPiB7XHJcbiAgaWYgKCFicmlkZ2VSZWdpc3RlcmVkKSByZXR1cm4gZmFsc2U7XHJcbiAgY2FuY2VsRGVsZXRlRGlhbG9nKCk7XHJcbiAgYXdhaXQgZGlhbG9nTG9hZGVkO1xyXG4gIGlmICghRGVsZXRlU2NlbmVzRGlhbG9nKSByZXR1cm4gZmFsc2U7XHJcblxyXG4gIGNvbnN0IHsgZmluZFNjZW5lIH0gPSBhd2FpdCBncmFwaHFsUXVlcnk8eyBmaW5kU2NlbmU6IERlbGV0YWJsZVNjZW5lIHwgbnVsbCB9PihcclxuICAgIGBxdWVyeSBCYXR0bGVEZWxldGFibGVTY2VuZSgkaWQ6IElEISkgeyBmaW5kU2NlbmUoaWQ6ICRpZCkgeyBpZCB0aXRsZSBpbnRlcmFjdGl2ZSBmaWxlcyB7IHBhdGggfSB9IH1gLFxyXG4gICAgeyBpZDogc2NlbmUuaWQgfSxcclxuICApO1xyXG4gIGlmICghZmluZFNjZW5lKSByZXR1cm4gZmFsc2U7XHJcblxyXG4gIGNvbnN0IHJlc3VsdCA9IG5ldyBQcm9taXNlPGJvb2xlYW4+KChyZXNvbHZlKSA9PiB7XHJcbiAgICBwZW5kaW5nUmVzdWx0ID0gcmVzb2x2ZTtcclxuICB9KTtcclxuXHJcbiAgLy8gU3Rhc2ggcmVuZGVycyB0aGUgbmF2YmFyIGFmdGVyIHBsdWdpbnMgbG9hZCwgc28gdGhlIGJyaWRnZSBpcyBtb3VudGVkIHdlbGwgYmVmb3JlIGFueW9uZSBjYW5cclxuICAvLyBjbGljayBhIGRlbGV0ZSBidXR0b247IGlmIGl0IHNvbWVob3cgaXNuJ3QsIHNheSBzbyByYXRoZXIgdGhhbiBmYWtpbmcgYSBuYXZpZ2F0aW9uXHJcbiAgaWYgKCFyZXF1ZXN0RGlhbG9nKGZpbmRTY2VuZSkpIHtcclxuICAgIGNvbnNvbGUud2FybihcIltTdGFzaCBCYXR0bGVdIFN0YXNoJ3MgZGVsZXRlIGRpYWxvZyBicmlkZ2UgaXNuJ3QgbW91bnRlZFwiKTtcclxuICAgIHNldHRsZShmYWxzZSk7XHJcbiAgICB3aW5kb3cuYWxlcnQoXCJDb3VsZG4ndCBvcGVuIFN0YXNoJ3MgZGVsZXRlIGRpYWxvZy4gUmVsb2FkIHRoZSBwYWdlIGFuZCB0cnkgYWdhaW4uXCIpO1xyXG4gIH1cclxuICByZXR1cm4gcmVzdWx0O1xyXG59XHJcblxyXG4vKiogQXNrIHRoZSBicmlkZ2UgdG8gb3BlbiB0aGUgZGlhbG9nOyBmYWxzZSBpZiBubyBicmlkZ2UgaXMgbW91bnRlZCB0byBwaWNrIGl0IHVwLiAqL1xyXG5mdW5jdGlvbiByZXF1ZXN0RGlhbG9nKHNjZW5lOiBEZWxldGFibGVTY2VuZSk6IGJvb2xlYW4ge1xyXG4gIGNvbnN0IHJlcXVlc3QgPSBuZXcgQ3VzdG9tRXZlbnQoT1BFTl9FVkVOVCwgeyBkZXRhaWw6IHNjZW5lLCBjYW5jZWxhYmxlOiB0cnVlIH0pO1xyXG4gIHJldHVybiAhd2luZG93LmRpc3BhdGNoRXZlbnQocmVxdWVzdCk7XHJcbn1cclxuIiwgIi8vIFVSTCBmaWx0ZXIgcGFyc2luZyBmb3IgU3Rhc2ggbGlzdCDihpIgR3JhcGhRTCBzY2VuZSBxdWVyaWVzLlxuXG5pbXBvcnQgdHlwZSB7IEZpbmRGaWx0ZXJUeXBlLCBTY2VuZUZpbHRlclR5cGUgfSBmcm9tIFwiLi90eXBlc1wiO1xuXG4vLyBHZXQgY3VycmVudCBVUkwgc2VhcmNoIHBhcmFtc1xuZXhwb3J0IGZ1bmN0aW9uIGdldFNlYXJjaFBhcmFtcygpOiBVUkxTZWFyY2hQYXJhbXMge1xuICByZXR1cm4gbmV3IFVSTFNlYXJjaFBhcmFtcyh3aW5kb3cubG9jYXRpb24uc2VhcmNoKTtcbn1cblxuLy8gQnVpbGQgRmluZEZpbHRlclR5cGUgZnJvbSBjdXJyZW50IFVSTCBzZWFyY2ggcGFyYW1zIChvciBhbiBleHBsaWNpdCBwYXJhbXMgb2JqZWN0KS5cbmV4cG9ydCBmdW5jdGlvbiBnZXRGaW5kRmlsdGVyKFxuICBvdmVycmlkZXM6IFBhcnRpYWw8RmluZEZpbHRlclR5cGU+ID0ge30sXG4gIHNlYXJjaFBhcmFtczogVVJMU2VhcmNoUGFyYW1zID0gZ2V0U2VhcmNoUGFyYW1zKCksXG4pOiBGaW5kRmlsdGVyVHlwZSB7XG4gIGNvbnN0IGZpbHRlcjogRmluZEZpbHRlclR5cGUgPSB7XG4gICAgcGVyX3BhZ2U6IG92ZXJyaWRlcy5wZXJfcGFnZSA/PyAtMSxcbiAgICBzb3J0OiBvdmVycmlkZXMuc29ydCA/PyAoc2VhcmNoUGFyYW1zLmdldChcInNvcnRieVwiKSB8fCBcInJhdGluZ1wiKSxcbiAgICBkaXJlY3Rpb246IG92ZXJyaWRlcy5kaXJlY3Rpb24gPz8gKHNlYXJjaFBhcmFtcy5nZXQoXCJzb3J0ZGlyXCIpPy50b1VwcGVyQ2FzZSgpIHx8IFwiREVTQ1wiKSxcbiAgICAuLi5vdmVycmlkZXMsXG4gIH07XG5cbiAgLy8gSW5jbHVkZSBzZWFyY2ggcXVlcnkgaWYgcHJlc2VudFxuICBjb25zdCBxdWVyeSA9IHNlYXJjaFBhcmFtcy5nZXQoXCJxXCIpO1xuICBpZiAocXVlcnkpIHtcbiAgICBmaWx0ZXIucSA9IHF1ZXJ5O1xuICB9XG5cbiAgcmV0dXJuIGZpbHRlcjtcbn1cblxuLy8gVHJhbnNsYXRlIEpTT04gc3RyaW5nIGJldHdlZW4gVVJMIGZvcm1hdCAocGFyZW50aGVzZXMpIGFuZCBzdGFuZGFyZCBKU09OIChicmFjZXMpXG4vLyBQb3J0ZWQgZnJvbSBTdGFzaCdzIExpc3RGaWx0ZXJNb2RlbC50cmFuc2xhdGVKU09OXG4vLyBUaGlzIHNhZmVseSBoYW5kbGVzIHBhcmVudGhlc2VzIGluc2lkZSBxdW90ZWQgc3RyaW5nc1xuZXhwb3J0IGZ1bmN0aW9uIHRyYW5zbGF0ZUpTT04oanNvblN0cmluZzogc3RyaW5nLCBkZWNvZGluZzogYm9vbGVhbik6IHN0cmluZyB7XG4gIGxldCBpblN0cmluZyA9IGZhbHNlO1xuICBsZXQgZXNjYXBlID0gZmFsc2U7XG4gIHJldHVybiBbLi4uanNvblN0cmluZ11cbiAgICAubWFwKChjKSA9PiB7XG4gICAgICBpZiAoZXNjYXBlKSB7XG4gICAgICAgIGVzY2FwZSA9IGZhbHNlO1xuICAgICAgICByZXR1cm4gYztcbiAgICAgIH1cbiAgICAgIHN3aXRjaCAoYykge1xuICAgICAgICBjYXNlIFwiXFxcXFwiOlxuICAgICAgICAgIGlmIChpblN0cmluZykgZXNjYXBlID0gdHJ1ZTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSAnXCInOlxuICAgICAgICAgIGluU3RyaW5nID0gIWluU3RyaW5nO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlIFwiKFwiOlxuICAgICAgICAgIGlmIChkZWNvZGluZyAmJiAhaW5TdHJpbmcpIHJldHVybiBcIntcIjtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSBcIilcIjpcbiAgICAgICAgICBpZiAoZGVjb2RpbmcgJiYgIWluU3RyaW5nKSByZXR1cm4gXCJ9XCI7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICByZXR1cm4gYztcbiAgICB9KVxuICAgIC5qb2luKFwiXCIpO1xufVxuXG4vLyBDcml0ZXJpb24gY2F0ZWdvcnkgbWFwcGluZ3MgZm9yIFVSTCAtPiBHcmFwaFFMIHRyYW5zZm9ybWF0aW9uXG4vLyBFYWNoIGNhdGVnb3J5IHJlcXVpcmVzIGRpZmZlcmVudCB0cmFuc2Zvcm1hdGlvbiBsb2dpY1xuY29uc3QgQ1JJVEVSSU9OX0NBVEVHT1JJRVMgPSB7XG4gIC8vIEJvb2xlYW46IG5vIG1vZGlmaWVyLCB2YWx1ZSBpcyBcInRydWVcIi9cImZhbHNlXCIgc3RyaW5nIC0+IGNvbnZlcnQgdG8gYm9vbGVhblxuICBib29sZWFuOiBuZXcgU2V0KFtcIm9yZ2FuaXplZFwiLCBcImludGVyYWN0aXZlXCIsIFwicGVyZm9ybWVyX2Zhdm9yaXRlXCJdKSxcbiAgLy8gU3RyaW5nRW51bTogVVJMIGhhcyBtb2RpZmllciBidXQgR3JhcGhRTCBqdXN0IGV4cGVjdHMgdGhlIHN0cmluZyB2YWx1ZSBkaXJlY3RseVxuICBzdHJpbmdFbnVtOiBuZXcgU2V0KFtcImlzX21pc3NpbmdcIiwgXCJoYXNfbWFya2Vyc1wiXSksXG4gIC8vIE11bHRpOiB2YWx1ZSBpcyBhcnJheSBvZiB7aWQsIGxhYmVsfSAtPiBleHRyYWN0IElEcyBvbmx5XG4gIG11bHRpOiBuZXcgU2V0KFtcInBlcmZvcm1lcnNcIiwgXCJncm91cHNcIiwgXCJtb3ZpZXNcIiwgXCJnYWxsZXJpZXNcIl0pLFxuICAvLyBIaWVyYXJjaGljYWxNdWx0aTogdmFsdWUgaGFzIHtpdGVtcywgZXhjbHVkZWQsIGRlcHRofSAtPiByZW5hbWUgdG8ge3ZhbHVlLCBleGNsdWRlcywgZGVwdGh9IGFuZCBleHRyYWN0IElEc1xuICBoaWVyYXJjaGljYWxNdWx0aTogbmV3IFNldChbXCJ0YWdzXCIsIFwic3R1ZGlvc1wiLCBcInBlcmZvcm1lcl90YWdzXCJdKSxcbn07XG5cbi8vIFJlc29sdXRpb24gc3RyaW5nIHRvIEdyYXBoUUwgZW51bSBtYXBwaW5nXG4vLyBVUkwgdXNlcyBodW1hbi1yZWFkYWJsZSBzdHJpbmdzLCBHcmFwaFFMIGV4cGVjdHMgUmVzb2x1dGlvbkVudW0gdmFsdWVzXG5jb25zdCBSRVNPTFVUSU9OX01BUDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgXCIxNDRwXCI6IFwiVkVSWV9MT1dcIixcbiAgXCIyNDBwXCI6IFwiTE9XXCIsXG4gIFwiMzYwcFwiOiBcIlIzNjBQXCIsXG4gIFwiNDgwcFwiOiBcIlNUQU5EQVJEXCIsXG4gIFwiNTQwcFwiOiBcIldFQl9IRFwiLFxuICBcIjcyMHBcIjogXCJTVEFOREFSRF9IRFwiLFxuICBcIjEwODBwXCI6IFwiRlVMTF9IRFwiLFxuICBcIjE0NDBwXCI6IFwiUVVBRF9IRFwiLFxuICBcIjRrXCI6IFwiRk9VUl9LXCIsXG4gIFwiNWtcIjogXCJGSVZFX0tcIixcbiAgXCI2a1wiOiBcIlNJWF9LXCIsXG4gIFwiN2tcIjogXCJTRVZFTl9LXCIsXG4gIFwiOGtcIjogXCJFSUdIVF9LXCIsXG4gIEh1Z2U6IFwiSFVHRVwiLFxufTtcblxuLy8gT3JpZW50YXRpb24gc3RyaW5nIHRvIEdyYXBoUUwgZW51bSBtYXBwaW5nXG5jb25zdCBPUklFTlRBVElPTl9NQVA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gIExhbmRzY2FwZTogXCJMQU5EU0NBUEVcIixcbiAgUG9ydHJhaXQ6IFwiUE9SVFJBSVRcIixcbiAgU3F1YXJlOiBcIlNRVUFSRVwiLFxufTtcblxuY29uc3QgaWRPZiA9ICh2OiBhbnkpOiB1bmtub3duID0+ICh0eXBlb2YgdiA9PT0gXCJvYmplY3RcIiAmJiB2ICYmIHYuaWQgPyB2LmlkIDogdik7XG5cbi8vIEJ1aWxkIFNjZW5lRmlsdGVyVHlwZSBmcm9tIFVSTCAnYycgcGFyYW1zIChkZWZhdWx0cyB0byBjdXJyZW50IHBhZ2UgVVJMKS5cbmV4cG9ydCBmdW5jdGlvbiBnZXRTY2VuZUZpbHRlcihcbiAgc2VhcmNoUGFyYW1zOiBVUkxTZWFyY2hQYXJhbXMgPSBnZXRTZWFyY2hQYXJhbXMoKSxcbik6IFNjZW5lRmlsdGVyVHlwZSB8IG51bGwge1xuICBjb25zdCBzY2VuZUZpbHRlcjogU2NlbmVGaWx0ZXJUeXBlID0ge307XG5cbiAgaWYgKCFzZWFyY2hQYXJhbXMuaGFzKFwiY1wiKSkgcmV0dXJuIG51bGw7XG5cbiAgZm9yIChjb25zdCBjU3RyIG9mIHNlYXJjaFBhcmFtcy5nZXRBbGwoXCJjXCIpKSB7XG4gICAgdHJ5IHtcbiAgICAgIC8vIERlY29kZSBVUkwgZm9ybWF0OiAoKSAtPiB7fSAoc2FmZWx5IHByZXNlcnZpbmcgc3RyaW5ncylcbiAgICAgIGNvbnN0IGRlY29kZWQgPSB0cmFuc2xhdGVKU09OKGNTdHIsIHRydWUpO1xuICAgICAgY29uc3QgY09iajogYW55ID0gSlNPTi5wYXJzZShkZWNvZGVkKTtcblxuICAgICAgY29uc3QgZmlsdGVyVHlwZTogc3RyaW5nIHwgdW5kZWZpbmVkID0gY09iai50eXBlO1xuICAgICAgaWYgKCFmaWx0ZXJUeXBlKSB7XG4gICAgICAgIGNvbnNvbGUud2FybihcIltTdGFzaCBCYXR0bGVdIEZpbHRlciBtaXNzaW5nIHR5cGU6XCIsIGNPYmopO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgLy8gUmVtb3ZlIHR5cGUgZnJvbSB0aGUgb2JqZWN0IC0gaXQgYmVjb21lcyB0aGUga2V5XG4gICAgICBjb25zdCB7IHR5cGU6IF90eXBlLCAuLi5yZXN0IH0gPSBjT2JqO1xuXG4gICAgICAvLyBDYXRlZ29yeTogQm9vbGVhbiAob3JnYW5pemVkLCBpbnRlcmFjdGl2ZSwgcGVyZm9ybWVyX2Zhdm9yaXRlKVxuICAgICAgaWYgKENSSVRFUklPTl9DQVRFR09SSUVTLmJvb2xlYW4uaGFzKGZpbHRlclR5cGUpKSB7XG4gICAgICAgIHNjZW5lRmlsdGVyW2ZpbHRlclR5cGVdID0gcmVzdC52YWx1ZSA9PT0gXCJ0cnVlXCIgfHwgcmVzdC52YWx1ZSA9PT0gdHJ1ZTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIC8vIENhdGVnb3J5OiBTdHJpbmdFbnVtIChzY2VuZUlzTWlzc2luZywgaGFzTWFya2VycylcbiAgICAgIGlmIChDUklURVJJT05fQ0FURUdPUklFUy5zdHJpbmdFbnVtLmhhcyhmaWx0ZXJUeXBlKSkge1xuICAgICAgICBzY2VuZUZpbHRlcltmaWx0ZXJUeXBlXSA9IHJlc3QudmFsdWU7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICAvLyBDYXRlZ29yeTogTXVsdGkgKHBlcmZvcm1lcnMsIGdyb3VwcywgbW92aWVzLCBnYWxsZXJpZXMpXG4gICAgICBpZiAoQ1JJVEVSSU9OX0NBVEVHT1JJRVMubXVsdGkuaGFzKGZpbHRlclR5cGUpKSB7XG4gICAgICAgIGNvbnN0IHJlc3VsdDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7IG1vZGlmaWVyOiByZXN0Lm1vZGlmaWVyIH07XG4gICAgICAgIGNvbnN0IHZhbCA9IHJlc3QudmFsdWUgfHwge307XG5cbiAgICAgICAgaWYgKHZhbC5pdGVtcyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgY29uc3QgaXRlbXM6IGFueVtdID0gdmFsLml0ZW1zIHx8IFtdO1xuICAgICAgICAgIGNvbnN0IGV4Y2x1ZGVkOiBhbnlbXSA9IHZhbC5leGNsdWRlZCB8fCBbXTtcbiAgICAgICAgICByZXN1bHQudmFsdWUgPSBpdGVtcy5tYXAoaWRPZik7XG4gICAgICAgICAgaWYgKGV4Y2x1ZGVkLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIHJlc3VsdC5leGNsdWRlcyA9IGV4Y2x1ZGVkLm1hcChpZE9mKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSBpZiAoQXJyYXkuaXNBcnJheShyZXN0LnZhbHVlKSkge1xuICAgICAgICAgIHJlc3VsdC52YWx1ZSA9IHJlc3QudmFsdWUubWFwKGlkT2YpO1xuICAgICAgICB9IGVsc2UgaWYgKHJlc3QubW9kaWZpZXIgPT09IFwiSVNfTlVMTFwiIHx8IHJlc3QubW9kaWZpZXIgPT09IFwiTk9UX05VTExcIikge1xuICAgICAgICAgIHJlc3VsdC52YWx1ZSA9IFtdO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHJlc3VsdC52YWx1ZSA9IHJlc3QudmFsdWU7XG4gICAgICAgIH1cblxuICAgICAgICBzY2VuZUZpbHRlcltmaWx0ZXJUeXBlXSA9IHJlc3VsdDtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIC8vIENhdGVnb3J5OiBIaWVyYXJjaGljYWxNdWx0aSAodGFncywgc3R1ZGlvcywgcGVyZm9ybWVyX3RhZ3MpXG4gICAgICBpZiAoQ1JJVEVSSU9OX0NBVEVHT1JJRVMuaGllcmFyY2hpY2FsTXVsdGkuaGFzKGZpbHRlclR5cGUpKSB7XG4gICAgICAgIGNvbnN0IHZhbCA9IHJlc3QudmFsdWUgfHwge307XG4gICAgICAgIGNvbnN0IGl0ZW1zOiBhbnlbXSA9IHZhbC5pdGVtcyB8fCBbXTtcbiAgICAgICAgY29uc3QgZXhjbHVkZWQ6IGFueVtdID0gdmFsLmV4Y2x1ZGVkIHx8IFtdO1xuICAgICAgICBzY2VuZUZpbHRlcltmaWx0ZXJUeXBlXSA9IHtcbiAgICAgICAgICBtb2RpZmllcjogcmVzdC5tb2RpZmllcixcbiAgICAgICAgICB2YWx1ZTogaXRlbXMubWFwKGlkT2YpLFxuICAgICAgICAgIGV4Y2x1ZGVzOiBleGNsdWRlZC5tYXAoaWRPZiksXG4gICAgICAgICAgZGVwdGg6IHZhbC5kZXB0aCA/PyAwLFxuICAgICAgICB9O1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgLy8gQ2F0ZWdvcnk6IFJlc29sdXRpb24gKG5lZWRzIHN0cmluZyAtPiBlbnVtIGNvbnZlcnNpb24pXG4gICAgICBpZiAoZmlsdGVyVHlwZSA9PT0gXCJyZXNvbHV0aW9uXCIpIHtcbiAgICAgICAgc2NlbmVGaWx0ZXJbZmlsdGVyVHlwZV0gPSB7XG4gICAgICAgICAgbW9kaWZpZXI6IHJlc3QubW9kaWZpZXIsXG4gICAgICAgICAgdmFsdWU6IFJFU09MVVRJT05fTUFQW3Jlc3QudmFsdWVdIHx8IHJlc3QudmFsdWUsXG4gICAgICAgIH07XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICAvLyBDYXRlZ29yeTogT3JpZW50YXRpb24gKG11bHRpLXNlbGVjdCBlbnVtLCBubyBtb2RpZmllcilcbiAgICAgIGlmIChmaWx0ZXJUeXBlID09PSBcIm9yaWVudGF0aW9uXCIpIHtcbiAgICAgICAgY29uc3QgdmFsdWVzOiBhbnlbXSA9IEFycmF5LmlzQXJyYXkocmVzdC52YWx1ZSkgPyByZXN0LnZhbHVlIDogW3Jlc3QudmFsdWVdO1xuICAgICAgICBzY2VuZUZpbHRlcltmaWx0ZXJUeXBlXSA9IHtcbiAgICAgICAgICB2YWx1ZTogdmFsdWVzLm1hcCgodikgPT4gT1JJRU5UQVRJT05fTUFQW3ZdIHx8IHYpLmZpbHRlcihCb29sZWFuKSxcbiAgICAgICAgfTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIC8vIENhdGVnb3J5OiBEdXBsaWNhdGVkIChwaGFzaCBkdXBsaWNhdGUgZmlsdGVyIC0gZGlmZmVyZW50IHN0cnVjdHVyZSlcbiAgICAgIGlmIChmaWx0ZXJUeXBlID09PSBcImR1cGxpY2F0ZWRcIikge1xuICAgICAgICBzY2VuZUZpbHRlcltmaWx0ZXJUeXBlXSA9IHtcbiAgICAgICAgICBkdXBsaWNhdGVkOiByZXN0LnZhbHVlID09PSBcInRydWVcIiB8fCByZXN0LnZhbHVlID09PSB0cnVlLFxuICAgICAgICB9O1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgLy8gQ2F0ZWdvcnk6IFN0YW5kYXJkIChudW1iZXIsIHN0cmluZywgZGF0ZSwgdGltZXN0YW1wLCBkdXJhdGlvbiwgc3BlY2lhbClcbiAgICAgIGlmIChcbiAgICAgICAgcmVzdC52YWx1ZSAmJlxuICAgICAgICB0eXBlb2YgcmVzdC52YWx1ZSA9PT0gXCJvYmplY3RcIiAmJlxuICAgICAgICAhQXJyYXkuaXNBcnJheShyZXN0LnZhbHVlKSAmJlxuICAgICAgICBcInZhbHVlXCIgaW4gcmVzdC52YWx1ZVxuICAgICAgKSB7XG4gICAgICAgIC8vIEZsYXR0ZW46IHsgbW9kaWZpZXIsIHZhbHVlOiB7IHZhbHVlOiBYLCB2YWx1ZTI6IFkgfSB9IC0+IHsgbW9kaWZpZXIsIHZhbHVlOiBYLCB2YWx1ZTI6IFkgfVxuICAgICAgICBzY2VuZUZpbHRlcltmaWx0ZXJUeXBlXSA9IHtcbiAgICAgICAgICBtb2RpZmllcjogcmVzdC5tb2RpZmllcixcbiAgICAgICAgICB2YWx1ZTogcmVzdC52YWx1ZS52YWx1ZSxcbiAgICAgICAgICAuLi4ocmVzdC52YWx1ZS52YWx1ZTIgIT09IHVuZGVmaW5lZCAmJiB7IHZhbHVlMjogcmVzdC52YWx1ZS52YWx1ZTIgfSksXG4gICAgICAgIH07XG4gICAgICB9IGVsc2UgaWYgKHJlc3QubW9kaWZpZXIgPT09IFwiSVNfTlVMTFwiIHx8IHJlc3QubW9kaWZpZXIgPT09IFwiTk9UX05VTExcIikge1xuICAgICAgICAvLyBJU19OVUxML05PVF9OVUxMIGRvbid0IHVzZSB0aGUgdmFsdWUsIGJ1dCB0aGUgc2NoZW1hIHN0aWxsIHJlcXVpcmVzIGl0XG4gICAgICAgIHNjZW5lRmlsdGVyW2ZpbHRlclR5cGVdID0ge1xuICAgICAgICAgIG1vZGlmaWVyOiByZXN0Lm1vZGlmaWVyLFxuICAgICAgICAgIHZhbHVlOiAwLFxuICAgICAgICB9O1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gUGFzcyB0aHJvdWdoIGFzLWlzIChzdHJpbmcgY3JpdGVyaWEsIHNwZWNpYWwgY3JpdGVyaWEgbGlrZSBwaGFzaCwgc3Rhc2hfaWQsIGV0Yy4pXG4gICAgICAgIHNjZW5lRmlsdGVyW2ZpbHRlclR5cGVdID0gcmVzdDtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0gRmFpbGVkIHRvIHBhcnNlIGZpbHRlcjpcIiwgY1N0ciwgZSk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIE9iamVjdC5rZXlzKHNjZW5lRmlsdGVyKS5sZW5ndGggPiAwID8gc2NlbmVGaWx0ZXIgOiBudWxsO1xufVxuXG4vKiogUGFyc2VkIGZpbHRlciBzdGF0ZSBmb3IgdGhlIGN1cnJlbnQgU3Rhc2ggbGlzdCBVUkwuICovXG5leHBvcnQgaW50ZXJmYWNlIExpc3RGaWx0ZXJzIHtcbiAgZmlsdGVyS2V5OiBzdHJpbmc7XG4gIHNjZW5lRmlsdGVyOiBTY2VuZUZpbHRlclR5cGUgfCBudWxsO1xuICBmaWx0ZXJBY3RpdmU6IGJvb2xlYW47XG59XG5cbi8qKiBSZWFkIFVSTCBmaWx0ZXIgc3RhdGUgb25jZSAoY2FjaGUga2V5LCBHcmFwaFFMIHNjZW5lX2ZpbHRlciwgYWN0aXZlIGZsYWcpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlYWRGaWx0ZXJzKCk6IExpc3RGaWx0ZXJzIHtcbiAgY29uc3Qgc2VhcmNoUGFyYW1zID0gZ2V0U2VhcmNoUGFyYW1zKCk7XG4gIGNvbnN0IHNjZW5lRmlsdGVyID0gZ2V0U2NlbmVGaWx0ZXIoc2VhcmNoUGFyYW1zKTtcbiAgY29uc3QgcSA9IHNlYXJjaFBhcmFtcy5nZXQoXCJxXCIpIHx8IFwiXCI7XG4gIHJldHVybiB7XG4gICAgZmlsdGVyS2V5OiBKU09OLnN0cmluZ2lmeSh7IHEsIGZpbHRlcjogc2NlbmVGaWx0ZXIgfHwge30gfSksXG4gICAgc2NlbmVGaWx0ZXIsXG4gICAgZmlsdGVyQWN0aXZlOiBCb29sZWFuKHNjZW5lRmlsdGVyIHx8IHNlYXJjaFBhcmFtcy5oYXMoXCJjXCIpIHx8IHNlYXJjaFBhcmFtcy5nZXQoXCJxXCIpKSxcbiAgfTtcbn1cblxuLy8gQ2FjaGUga2V5IGZvciB0aGUgY3VycmVudCBsaXN0IFVSTCAoY3JpdGVyaWEgKyB0ZXh0IHNlYXJjaCkuXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRGaWx0ZXJLZXkoKTogc3RyaW5nIHtcbiAgcmV0dXJuIHJlYWRGaWx0ZXJzKCkuZmlsdGVyS2V5O1xufVxuXG4vKiogVHJ1ZSB3aGVuIHRoZSBjdXJyZW50IFN0YXNoIGxpc3QgVVJMIGhhcyBhY3RpdmUgZmlsdGVycyAoY3JpdGVyaWEgYW5kL29yIHRleHQgc2VhcmNoKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjaGVja0ZvckZpbHRlcnMoKTogYm9vbGVhbiB7XG4gIHJldHVybiByZWFkRmlsdGVycygpLmZpbHRlckFjdGl2ZTtcbn1cbiIsICIvLyBDZW50cmFsIG11dGFibGUgcnVudGltZSBzdGF0ZS5cbi8vXG4vLyBUaGUgb3JpZ2luYWwgcGx1Z2luIHVzZWQgbW9kdWxlLWxldmVsIGBsZXRgIGJpbmRpbmdzIHNoYXJlZCBhY3Jvc3MgbWFueSBmdW5jdGlvbnMuXG4vLyBFUyBtb2R1bGVzIGNhbm5vdCByZWFzc2lnbiBhbiBpbXBvcnRlZCBiaW5kaW5nIGZyb20gYW5vdGhlciBtb2R1bGUsIHNvIGFsbCBzaGFyZWRcbi8vIG11dGFibGUgdmFsdWVzIGxpdmUgb24gdGhpcyBzaW5nbGUgYHN0YXRlYCBvYmplY3QgdGhhdCBldmVyeSBtb2R1bGUgaW1wb3J0cy5cblxuaW1wb3J0IHsgREVGQVVMVF9TRVRUSU5HUyB9IGZyb20gXCIuL2NvbnN0YW50c1wiO1xuaW1wb3J0IHR5cGUgeyBNb2RlLCBQYWlyLCBQbGFjZW1lbnRSdW4sIFJhbmtzLCBTY2VuZSwgU2V0dGluZ3MgfSBmcm9tIFwiLi90eXBlc1wiO1xuXG5leHBvcnQgaW50ZXJmYWNlIE1lbW9yeUNhY2hlIHtcbiAgYWxsU2NlbmVzOiBTY2VuZVtdIHwgbnVsbDsgLy8gQWxsIHNjZW5lcyAobm8gZmlsdGVyKVxuICBmaWx0ZXJlZFNjZW5lczogU2NlbmVbXSB8IG51bGw7IC8vIFNjZW5lcyBtYXRjaGluZyBjdXJyZW50IGZpbHRlclxuICBmaWx0ZXJLZXk6IHN0cmluZyB8IG51bGw7IC8vIEN1cnJlbnQgZmlsdGVyIHBhcmFtcyBmb3IgY2FjaGUgdmFsaWRhdGlvblxuICB0aW1lc3RhbXA6IG51bWJlciB8IG51bGw7IC8vIFdoZW4gY2FjaGUgd2FzIHBvcHVsYXRlZFxufVxuXG5leHBvcnQgaW50ZXJmYWNlIEJhdHRsZVN0YXRlIHtcbiAgLy8gQ3VycmVudCBjb21wYXJpc29uIHBhaXIgYW5kIG1vZGVcbiAgY3VycmVudFBhaXI6IFBhaXI7XG4gIGN1cnJlbnRSYW5rczogUmFua3M7XG4gIGN1cnJlbnRNb2RlOiBNb2RlO1xuICAvLyBDaGFtcGlvbiBydW4gdHJhY2tpbmdcbiAgY2hhbXBpb25TY2VuZTogU2NlbmUgfCBudWxsOyAvLyBUaGUgc2NlbmUgZGVmZW5kaW5nICh3aW5uZXIgc3RheXMgb24pXG4gIGNoYW1waW9uV2luczogbnVtYmVyOyAvLyBJdHMgY3VycmVudCB3aW4gc3RyZWFrXG4gIGNoYW1waW9uRGVmZWF0ZWQ6IHN0cmluZ1tdOyAvLyBJRHMgb2Ygc2NlbmVzIGl0IGhhcyBiZWF0ZW4gaW4gdGhpcyBydW5cbiAgLy8gUGxhY2VtZW50IHJ1biB0cmFja2luZ1xuICBwbGFjZW1lbnQ6IFBsYWNlbWVudFJ1biB8IG51bGw7XG4gIHRvdGFsU2NlbmVzQ291bnQ6IG51bWJlcjsgLy8gVG90YWwgc2NlbmVzIGZvciBwb3NpdGlvbiBkaXNwbGF5XG4gIGxlZnRQb29sU2l6ZTogbnVtYmVyIHwgbnVsbDsgLy8gU2NlbmVzIG9uIHRoZSBcInRvIHJhdGVcIiBzaWRlIChmaWx0ZXIgb3Igd2hvbGUgbGlicmFyeSk7IG51bGwgdW50aWwgbG9hZGVkXG4gIGRpc2FibGVDaG9pY2U6IGJvb2xlYW47IC8vIFByZXZlbnRzIG11bHRpcGxlIHJhcGlkIGNob2ljZSBldmVudHNcbiAgc2F2ZWRGaWx0ZXJQYXJhbXM6IHN0cmluZzsgLy8gU3RvcmVkIFVSTCBmaWx0ZXIgcGFyYW1zIHRvIGRldGVjdCBjaGFuZ2VzXG4gIC8vIFVzZXIgc2V0dGluZ3MgKGRlZmF1bHRzIHVudGlsIGxvYWRTZXR0aW5ncygpIHJlc29sdmVzKVxuICBzZXR0aW5nczogU2V0dGluZ3M7XG4gIHJlc2V0dGluZ0VsbzogYm9vbGVhbjsgLy8gUmVzZXQgRUxPJ3Mgc2V0dXAgc2NyZWVuIGlzIHNob3dpbmcgKGJhdHRsZXMgd2FpdCwgbGlrZSBhIGZpcnN0IHNldHVwKVxuICAvLyBTaHVmZmxlIHN0YXRlIGZvciB0aGUgbGVmdC1zaWRlIHBvb2wgKHByZXZlbnRzIHJlcGVhdHMgd2hlbiBza2lwcGluZylcbiAgc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lczogU2NlbmVbXTtcbiAgc2h1ZmZsZUluZGV4OiBudW1iZXI7XG4gIHNodWZmbGVGaWx0ZXJLZXk6IHN0cmluZyB8IG51bGw7XG4gIC8vIFNjZW5lIGNhY2hlIChtZW1vcnkgdGllcilcbiAgbWVtb3J5Q2FjaGU6IE1lbW9yeUNhY2hlO1xufVxuXG5leHBvcnQgY29uc3Qgc3RhdGU6IEJhdHRsZVN0YXRlID0ge1xuICBjdXJyZW50UGFpcjogeyBsZWZ0OiBudWxsLCByaWdodDogbnVsbCB9LFxuICBjdXJyZW50UmFua3M6IHsgbGVmdDogbnVsbCwgcmlnaHQ6IG51bGwgfSxcbiAgY3VycmVudE1vZGU6IFwic3dpc3NcIixcbiAgY2hhbXBpb25TY2VuZTogbnVsbCxcbiAgY2hhbXBpb25XaW5zOiAwLFxuICBjaGFtcGlvbkRlZmVhdGVkOiBbXSxcbiAgcGxhY2VtZW50OiBudWxsLFxuICB0b3RhbFNjZW5lc0NvdW50OiAwLFxuICBsZWZ0UG9vbFNpemU6IG51bGwsXG4gIGRpc2FibGVDaG9pY2U6IGZhbHNlLFxuICBzYXZlZEZpbHRlclBhcmFtczogXCJcIixcbiAgc2V0dGluZ3M6IHsgLi4uREVGQVVMVF9TRVRUSU5HUyB9LFxuICByZXNldHRpbmdFbG86IGZhbHNlLFxuICBzaHVmZmxlZEZpbHRlcmVkU2NlbmVzOiBbXSxcbiAgc2h1ZmZsZUluZGV4OiAwLFxuICBzaHVmZmxlRmlsdGVyS2V5OiBudWxsLFxuICBtZW1vcnlDYWNoZToge1xuICAgIGFsbFNjZW5lczogbnVsbCxcbiAgICBmaWx0ZXJlZFNjZW5lczogbnVsbCxcbiAgICBmaWx0ZXJLZXk6IG51bGwsXG4gICAgdGltZXN0YW1wOiBudWxsLFxuICB9LFxufTtcblxuLyoqIENsZWFyIGFueSBDaGFtcGlvbiAvIFBsYWNlbWVudCBydW4gaW4gcHJvZ3Jlc3MuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzZXRSdW5TdGF0ZSgpOiB2b2lkIHtcbiAgc3RhdGUuY2hhbXBpb25TY2VuZSA9IG51bGw7XG4gIHN0YXRlLmNoYW1waW9uV2lucyA9IDA7XG4gIHN0YXRlLmNoYW1waW9uRGVmZWF0ZWQgPSBbXTtcbiAgc3RhdGUucGxhY2VtZW50ID0gbnVsbDtcbn1cblxuLyoqIEZvcmdldCB0aGUgbGVmdC1zaWRlIHNodWZmbGUgc28gdGhlIG5leHQgcGljayByZXNodWZmbGVzIGZyb20gYSBmcmVzaCBwb29sLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc2V0U2h1ZmZsZSgpOiB2b2lkIHtcbiAgc3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lcyA9IFtdO1xuICBzdGF0ZS5zaHVmZmxlSW5kZXggPSAwO1xuICBzdGF0ZS5zaHVmZmxlRmlsdGVyS2V5ID0gbnVsbDtcbn1cblxuLyoqIFRydWUgd2hpbGUgYSBDaGFtcGlvbiAvIFBsYWNlbWVudCBydW4gaXMgdW5kZXIgd2F5IChza2lwIGlzIGRpc2FibGVkKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc1J1bkFjdGl2ZSgpOiBib29sZWFuIHtcbiAgc3dpdGNoIChzdGF0ZS5jdXJyZW50TW9kZSkge1xuICAgIGNhc2UgXCJjaGFtcGlvblwiOlxuICAgICAgcmV0dXJuIHN0YXRlLmNoYW1waW9uU2NlbmUgIT09IG51bGw7XG4gICAgY2FzZSBcInBsYWNlbWVudFwiOlxuICAgICAgcmV0dXJuIChzdGF0ZS5wbGFjZW1lbnQ/LmJhdHRsZXMgPz8gMCkgPiAwO1xuICAgIGRlZmF1bHQ6XG4gICAgICByZXR1cm4gZmFsc2U7XG4gIH1cbn1cblxuLyoqIEVMTyBzZXR1cCBoYXNuJ3QgZmluaXNoZWQgKG9yIFJlc2V0IEVMTyBpcyBzaG93aW5nIGl0KSwgc28gaXQgc2hvd3MgaW5zdGVhZCBvZiBsb2FkaW5nIHBhaXJzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzRWxvU2V0dXBQZW5kaW5nKCk6IGJvb2xlYW4ge1xuICByZXR1cm4gIXN0YXRlLnNldHRpbmdzLmVsb1NldHVwQXQgfHwgc3RhdGUucmVzZXR0aW5nRWxvO1xufVxuIiwgIi8vIFNjZW5lIGNhY2hlOiBJbmRleGVkREIgKGR1cmFibGUpICsgaW4tbWVtb3J5IChwZXIgc2Vzc2lvbiksIHN0YWxlLXdoaWxlLXJldmFsaWRhdGUuXG5cbmltcG9ydCB7XG4gIENBQ0hFX0RCX05BTUUsXG4gIENBQ0hFX0RCX1ZFUlNJT04sXG4gIENBQ0hFX01BWF9BR0VfTVMsXG4gIENBQ0hFX1NUT1JFX05BTUUsXG59IGZyb20gXCIuL2NvbnN0YW50c1wiO1xuaW1wb3J0IHsgZ2V0RmluZEZpbHRlciwgdHlwZSBMaXN0RmlsdGVycyB9IGZyb20gXCIuL2ZpbHRlcnNcIjtcbmltcG9ydCB7IEZJTkRfU0NFTkVTX1FVRVJZLCBncmFwaHFsUXVlcnkgfSBmcm9tIFwiLi9ncmFwaHFsXCI7XG5pbXBvcnQgeyBlbG9GaWVsZHMsIGVsb0luc2VydGlvbkluZGV4LCBzb3J0QnlFbG8sIHdpdGhFbG9GaWVsZHMgfSBmcm9tIFwiLi9zY29yZVwiO1xuaW1wb3J0IHsgc3RhdGUgfSBmcm9tIFwiLi9zdGF0ZVwiO1xuaW1wb3J0IHR5cGUgeyBDYWNoZUVudHJ5LCBFbG9GaWVsZHMsIEZpbmRTY2VuZXNSZXN1bHQsIFNjZW5lIH0gZnJvbSBcIi4vdHlwZXNcIjtcblxuLy8gT3BlbiBJbmRleGVkREIgZGF0YWJhc2VcbmZ1bmN0aW9uIG9wZW5DYWNoZURCKCk6IFByb21pc2U8SURCRGF0YWJhc2U+IHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICBjb25zdCByZXF1ZXN0ID0gaW5kZXhlZERCLm9wZW4oQ0FDSEVfREJfTkFNRSwgQ0FDSEVfREJfVkVSU0lPTik7XG5cbiAgICByZXF1ZXN0Lm9uZXJyb3IgPSAoKSA9PiB7XG4gICAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0gSW5kZXhlZERCIGVycm9yOlwiLCByZXF1ZXN0LmVycm9yKTtcbiAgICAgIHJlamVjdChyZXF1ZXN0LmVycm9yKTtcbiAgICB9O1xuXG4gICAgcmVxdWVzdC5vbnN1Y2Nlc3MgPSAoKSA9PiB7XG4gICAgICByZXNvbHZlKHJlcXVlc3QucmVzdWx0KTtcbiAgICB9O1xuXG4gICAgcmVxdWVzdC5vbnVwZ3JhZGVuZWVkZWQgPSAoZXZlbnQpID0+IHtcbiAgICAgIGNvbnN0IGRiID0gKGV2ZW50LnRhcmdldCBhcyBJREJPcGVuREJSZXF1ZXN0KS5yZXN1bHQ7XG4gICAgICAvLyBBbnkgb2xkZXIgc3RvcmUgaG9sZHMgc2NlbmVzIHdpdGhvdXQgRUxPIChvciBpbiByYXRpbmcgb3JkZXIpOiBzdGFydCBpdCBvdmVyXG4gICAgICBpZiAoZGIub2JqZWN0U3RvcmVOYW1lcy5jb250YWlucyhDQUNIRV9TVE9SRV9OQU1FKSkgZGIuZGVsZXRlT2JqZWN0U3RvcmUoQ0FDSEVfU1RPUkVfTkFNRSk7XG4gICAgICBkYi5jcmVhdGVPYmplY3RTdG9yZShDQUNIRV9TVE9SRV9OQU1FLCB7IGtleVBhdGg6IFwiY2FjaGVLZXlcIiB9KTtcbiAgICB9O1xuICB9KTtcbn1cblxuLy8gR2V0IGNhY2hlZCBzY2VuZXMgZnJvbSBJbmRleGVkREJcbmFzeW5jIGZ1bmN0aW9uIGdldENhY2hlZFNjZW5lcyhjYWNoZUtleTogc3RyaW5nKTogUHJvbWlzZTxDYWNoZUVudHJ5IHwgbnVsbD4ge1xuICB0cnkge1xuICAgIGNvbnN0IGRiID0gYXdhaXQgb3BlbkNhY2hlREIoKTtcbiAgICByZXR1cm4gbmV3IFByb21pc2U8Q2FjaGVFbnRyeSB8IG51bGw+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgIGNvbnN0IHRyYW5zYWN0aW9uID0gZGIudHJhbnNhY3Rpb24oQ0FDSEVfU1RPUkVfTkFNRSwgXCJyZWFkb25seVwiKTtcbiAgICAgIGNvbnN0IHN0b3JlID0gdHJhbnNhY3Rpb24ub2JqZWN0U3RvcmUoQ0FDSEVfU1RPUkVfTkFNRSk7XG4gICAgICBjb25zdCByZXF1ZXN0ID0gc3RvcmUuZ2V0KGNhY2hlS2V5KTtcblxuICAgICAgcmVxdWVzdC5vbnN1Y2Nlc3MgPSAoKSA9PiB7XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IHJlcXVlc3QucmVzdWx0IGFzIENhY2hlRW50cnkgfCB1bmRlZmluZWQ7XG4gICAgICAgIGlmIChyZXN1bHQgJiYgRGF0ZS5ub3coKSAtIHJlc3VsdC50aW1lc3RhbXAgPCBDQUNIRV9NQVhfQUdFX01TKSB7XG4gICAgICAgICAgcmVzb2x2ZShyZXN1bHQpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHJlc29sdmUobnVsbCk7IC8vIENhY2hlIG1pc3Mgb3IgZXhwaXJlZFxuICAgICAgICB9XG4gICAgICB9O1xuXG4gICAgICByZXF1ZXN0Lm9uZXJyb3IgPSAoKSA9PiByZWplY3QocmVxdWVzdC5lcnJvcik7XG4gICAgICB0cmFuc2FjdGlvbi5vbmNvbXBsZXRlID0gKCkgPT4gZGIuY2xvc2UoKTtcbiAgICB9KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnNvbGUuZXJyb3IoXCJbU3Rhc2ggQmF0dGxlXSBDYWNoZSByZWFkIGVycm9yOlwiLCBlKTtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxufVxuXG4vLyBTdG9yZSBzY2VuZXMgaW4gSW5kZXhlZERCXG5hc3luYyBmdW5jdGlvbiBzZXRDYWNoZWRTY2VuZXMoXG4gIGNhY2hlS2V5OiBzdHJpbmcsXG4gIHNjZW5lczogU2NlbmVbXSxcbiAgY291bnQ6IG51bWJlcixcbiAgZmlsdGVyS2V5Pzogc3RyaW5nLFxuICB0aW1lc3RhbXA6IG51bWJlciA9IERhdGUubm93KCksXG4pOiBQcm9taXNlPHZvaWQ+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBkYiA9IGF3YWl0IG9wZW5DYWNoZURCKCk7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgIGNvbnN0IHRyYW5zYWN0aW9uID0gZGIudHJhbnNhY3Rpb24oQ0FDSEVfU1RPUkVfTkFNRSwgXCJyZWFkd3JpdGVcIik7XG4gICAgICBjb25zdCBzdG9yZSA9IHRyYW5zYWN0aW9uLm9iamVjdFN0b3JlKENBQ0hFX1NUT1JFX05BTUUpO1xuXG4gICAgICBjb25zdCBkYXRhOiBDYWNoZUVudHJ5ID0ge1xuICAgICAgICBjYWNoZUtleSxcbiAgICAgICAgc2NlbmVzLFxuICAgICAgICBjb3VudCxcbiAgICAgICAgdGltZXN0YW1wLFxuICAgICAgICAuLi4oZmlsdGVyS2V5ICE9PSB1bmRlZmluZWQgJiYgeyBmaWx0ZXJLZXkgfSksXG4gICAgICB9O1xuXG4gICAgICBjb25zdCByZXF1ZXN0ID0gc3RvcmUucHV0KGRhdGEpO1xuICAgICAgcmVxdWVzdC5vbnN1Y2Nlc3MgPSAoKSA9PiByZXNvbHZlKCk7XG4gICAgICByZXF1ZXN0Lm9uZXJyb3IgPSAoKSA9PiByZWplY3QocmVxdWVzdC5lcnJvcik7XG4gICAgICB0cmFuc2FjdGlvbi5vbmNvbXBsZXRlID0gKCkgPT4gZGIuY2xvc2UoKTtcbiAgICB9KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnNvbGUuZXJyb3IoXCJbU3Rhc2ggQmF0dGxlXSBDYWNoZSB3cml0ZSBlcnJvcjpcIiwgZSk7XG4gIH1cbn1cblxuLy8gQ2xlYXIgYWxsIGNhY2hlZCBzY2VuZXMgKGZvciBtYW51YWwgcmVmcmVzaClcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjbGVhclNjZW5lQ2FjaGUoKTogUHJvbWlzZTx2b2lkPiB7XG4gIHRyeSB7XG4gICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5eR77iPIENsZWFyaW5nIGFsbCBzY2VuZSBjYWNoZXMuLi5cIik7XG4gICAgY29uc3QgZGIgPSBhd2FpdCBvcGVuQ2FjaGVEQigpO1xuICAgIHJldHVybiBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICBjb25zdCB0cmFuc2FjdGlvbiA9IGRiLnRyYW5zYWN0aW9uKENBQ0hFX1NUT1JFX05BTUUsIFwicmVhZHdyaXRlXCIpO1xuICAgICAgY29uc3Qgc3RvcmUgPSB0cmFuc2FjdGlvbi5vYmplY3RTdG9yZShDQUNIRV9TVE9SRV9OQU1FKTtcbiAgICAgIGNvbnN0IHJlcXVlc3QgPSBzdG9yZS5jbGVhcigpO1xuXG4gICAgICByZXF1ZXN0Lm9uc3VjY2VzcyA9ICgpID0+IHtcbiAgICAgICAgc3RhdGUubWVtb3J5Q2FjaGUgPSB7IGFsbFNjZW5lczogbnVsbCwgZmlsdGVyZWRTY2VuZXM6IG51bGwsIGZpbHRlcktleTogbnVsbCwgdGltZXN0YW1wOiBudWxsIH07XG4gICAgICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g4pyFIEFsbCBjYWNoZXMgY2xlYXJlZCAobWVtb3J5ICsgSW5kZXhlZERCKVwiKTtcbiAgICAgICAgcmVzb2x2ZSgpO1xuICAgICAgfTtcbiAgICAgIHJlcXVlc3Qub25lcnJvciA9ICgpID0+IHJlamVjdChyZXF1ZXN0LmVycm9yKTtcbiAgICAgIHRyYW5zYWN0aW9uLm9uY29tcGxldGUgPSAoKSA9PiBkYi5jbG9zZSgpO1xuICAgIH0pO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIOKdjCBDYWNoZSBjbGVhciBlcnJvcjpcIiwgZSk7XG4gIH1cbn1cblxuLy8gQ2xlYXIganVzdCB0aGUgZmlsdGVyZWQgc2NlbmVzIGNhY2hlIChmb3IgYXV0by1yZWZyZXNoIGFmdGVyIHBvb2wgZXhoYXVzdGlvbilcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjbGVhckZpbHRlcmVkQ2FjaGUoKTogUHJvbWlzZTx2b2lkPiB7XG4gIHRyeSB7XG4gICAgY29uc3QgZGIgPSBhd2FpdCBvcGVuQ2FjaGVEQigpO1xuICAgIHJldHVybiBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICBjb25zdCB0cmFuc2FjdGlvbiA9IGRiLnRyYW5zYWN0aW9uKENBQ0hFX1NUT1JFX05BTUUsIFwicmVhZHdyaXRlXCIpO1xuICAgICAgY29uc3Qgc3RvcmUgPSB0cmFuc2FjdGlvbi5vYmplY3RTdG9yZShDQUNIRV9TVE9SRV9OQU1FKTtcbiAgICAgIGNvbnN0IHJlcXVlc3QgPSBzdG9yZS5kZWxldGUoXCJmaWx0ZXJlZC1zY2VuZXNcIik7XG5cbiAgICAgIHJlcXVlc3Qub25zdWNjZXNzID0gKCkgPT4ge1xuICAgICAgICBzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJlZFNjZW5lcyA9IG51bGw7XG4gICAgICAgIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcktleSA9IG51bGw7XG4gICAgICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+Xke+4jyBGaWx0ZXJlZCBjYWNoZSBjbGVhcmVkIChtZW1vcnkgKyBJbmRleGVkREIpXCIpO1xuICAgICAgICByZXNvbHZlKCk7XG4gICAgICB9O1xuICAgICAgcmVxdWVzdC5vbmVycm9yID0gKCkgPT4gcmVqZWN0KHJlcXVlc3QuZXJyb3IpO1xuICAgICAgdHJhbnNhY3Rpb24ub25jb21wbGV0ZSA9ICgpID0+IGRiLmNsb3NlKCk7XG4gICAgfSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0g4p2MIEZpbHRlcmVkIGNhY2hlIGNsZWFyIGVycm9yOlwiLCBlKTtcbiAgICAvLyBTdGlsbCBjbGVhciBtZW1vcnkgY2FjaGUgZXZlbiBpZiBJbmRleGVkREIgZmFpbHNcbiAgICBzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJlZFNjZW5lcyA9IG51bGw7XG4gICAgc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyS2V5ID0gbnVsbDtcbiAgfVxufVxuXG4vLyBCYWNrZ3JvdW5kIHJlZnJlc2ggLSBmZXRjaCBmcm9tIG5ldHdvcmsgYW5kIHVwZGF0ZSBjYWNoZXMgc2lsZW50bHlcbmFzeW5jIGZ1bmN0aW9uIGJhY2tncm91bmRSZWZyZXNoQWxsU2NlbmVzKCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBjYWNoZUtleSA9IFwiYWxsLXNjZW5lc1wiO1xuXG4gIHRyeSB7XG4gICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5SEIEJhY2tncm91bmQgcmVmcmVzaCBzdGFydGVkIChhbGwgc2NlbmVzKS4uLlwiKTtcbiAgICBjb25zdCBzdGFydFRpbWUgPSBEYXRlLm5vdygpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZ3JhcGhxbFF1ZXJ5PEZpbmRTY2VuZXNSZXN1bHQ+KEZJTkRfU0NFTkVTX1FVRVJZLCB7XG4gICAgICBmaWx0ZXI6IHtcbiAgICAgICAgcGVyX3BhZ2U6IC0xLFxuICAgICAgICBzb3J0OiBcInJhdGluZ1wiLFxuICAgICAgICBkaXJlY3Rpb246IFwiREVTQ1wiLFxuICAgICAgfSxcbiAgICAgIHNjZW5lX2ZpbHRlcjogbnVsbCxcbiAgICB9KTtcblxuICAgIGNvbnN0IHNjZW5lcyA9IHNvcnRCeUVsbyhyZXN1bHQuZmluZFNjZW5lcy5zY2VuZXMgfHwgW10pO1xuICAgIGNvbnN0IGNvdW50ID0gcmVzdWx0LmZpbmRTY2VuZXMuY291bnQgfHwgc2NlbmVzLmxlbmd0aDtcbiAgICBjb25zdCBmZXRjaFRpbWUgPSBEYXRlLm5vdygpIC0gc3RhcnRUaW1lO1xuXG4gICAgY29uc3Qgb2xkQ291bnQgPSBzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXMgPyBzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXMubGVuZ3RoIDogMDtcbiAgICBpZiAoY291bnQgIT09IG9sZENvdW50KSB7XG4gICAgICBjb25zb2xlLmxvZyhcbiAgICAgICAgYFtTdGFzaCBCYXR0bGVdIPCfk4ogU2NlbmUgY291bnQgY2hhbmdlZDogJHtvbGRDb3VudH0g4oaSICR7Y291bnR9ICgke2NvdW50ID4gb2xkQ291bnQgPyBcIitcIiA6IFwiXCJ9JHtjb3VudCAtIG9sZENvdW50fSlgLFxuICAgICAgKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIPCfk4ogU2NlbmUgY291bnQgdW5jaGFuZ2VkOiAke2NvdW50fWApO1xuICAgIH1cblxuICAgIHN0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcyA9IHNjZW5lcztcbiAgICBzdGF0ZS5tZW1vcnlDYWNoZS50aW1lc3RhbXAgPSBEYXRlLm5vdygpO1xuICAgIGF3YWl0IHNldENhY2hlZFNjZW5lcyhjYWNoZUtleSwgc2NlbmVzLCBjb3VudCk7XG5cbiAgICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g4pyFIEJhY2tncm91bmQgcmVmcmVzaCBjb21wbGV0ZTogJHtzY2VuZXMubGVuZ3RofSBzY2VuZXMgaW4gJHtmZXRjaFRpbWV9bXNgKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnNvbGUuZXJyb3IoXCJbU3Rhc2ggQmF0dGxlXSDinYwgQmFja2dyb3VuZCByZWZyZXNoIGZhaWxlZDpcIiwgZSk7XG4gIH1cbn1cblxuLy8gR2V0IGFsbCBzY2VuZXMgKHVzZXMgY2FjaGUgd2l0aCBzdGFsZS13aGlsZS1yZXZhbGlkYXRlKVxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldEFsbFNjZW5lc0NhY2hlZCgpOiBQcm9taXNlPHsgc2NlbmVzOiBTY2VuZVtdOyBjb3VudDogbnVtYmVyIH0+IHtcbiAgY29uc3QgY2FjaGVLZXkgPSBcImFsbC1zY2VuZXNcIjtcblxuICAvLyBDaGVjayBtZW1vcnkgY2FjaGUgZmlyc3QgLSByZXR1cm4gaW1tZWRpYXRlbHkgaWYgYXZhaWxhYmxlXG4gIGlmIChzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXMpIHtcbiAgICBjb25zdCBjYWNoZUFnZSA9IE1hdGgucm91bmQoKERhdGUubm93KCkgLSAoc3RhdGUubWVtb3J5Q2FjaGUudGltZXN0YW1wID8/IDApKSAvIDEwMDApO1xuICAgIGNvbnN0IGlzU3RhbGUgPSBEYXRlLm5vdygpIC0gKHN0YXRlLm1lbW9yeUNhY2hlLnRpbWVzdGFtcCA/PyAwKSA+PSBDQUNIRV9NQVhfQUdFX01TO1xuXG4gICAgY29uc29sZS5sb2coXG4gICAgICBgW1N0YXNoIEJhdHRsZV0g8J+SviBNZW1vcnkgY2FjaGUgaGl0IChhbGwgc2NlbmVzKTogJHtzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXMubGVuZ3RofSBzY2VuZXMsIGFnZTogJHtjYWNoZUFnZX1zJHtpc1N0YWxlID8gXCIgW1NUQUxFXVwiIDogXCJcIn1gLFxuICAgICk7XG5cbiAgICBpZiAoaXNTdGFsZSkge1xuICAgICAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIOKPsCBDYWNoZSBzdGFsZSAoPiR7Q0FDSEVfTUFYX0FHRV9NUyAvIDEwMDB9cyksIHRyaWdnZXJpbmcgYmFja2dyb3VuZCByZWZyZXNoLi4uYCk7XG4gICAgICBiYWNrZ3JvdW5kUmVmcmVzaEFsbFNjZW5lcygpOyAvLyBEb24ndCBhd2FpdCAtIHJ1bnMgaW4gYmFja2dyb3VuZFxuICAgIH1cbiAgICByZXR1cm4geyBzY2VuZXM6IHN0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcywgY291bnQ6IHN0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcy5sZW5ndGggfTtcbiAgfVxuXG4gIC8vIENoZWNrIEluZGV4ZWREQiBjYWNoZSAtIHJldHVybiBpbW1lZGlhdGVseSBpZiBhdmFpbGFibGVcbiAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5SNIE1lbW9yeSBjYWNoZSBtaXNzLCBjaGVja2luZyBJbmRleGVkREIuLi5cIik7XG4gIGNvbnN0IGNhY2hlZCA9IGF3YWl0IGdldENhY2hlZFNjZW5lcyhjYWNoZUtleSk7XG4gIGlmIChjYWNoZWQpIHtcbiAgICBjb25zdCBjYWNoZUFnZSA9IE1hdGgucm91bmQoKERhdGUubm93KCkgLSBjYWNoZWQudGltZXN0YW1wKSAvIDEwMDApO1xuICAgIGNvbnN0IGlzU3RhbGUgPSBEYXRlLm5vdygpIC0gY2FjaGVkLnRpbWVzdGFtcCA+PSBDQUNIRV9NQVhfQUdFX01TO1xuXG4gICAgY29uc29sZS5sb2coXG4gICAgICBgW1N0YXNoIEJhdHRsZV0g8J+SvyBJbmRleGVkREIgY2FjaGUgaGl0IChhbGwgc2NlbmVzKTogJHtjYWNoZWQuc2NlbmVzLmxlbmd0aH0gc2NlbmVzLCBhZ2U6ICR7Y2FjaGVBZ2V9cyR7aXNTdGFsZSA/IFwiIFtTVEFMRV1cIiA6IFwiXCJ9YCxcbiAgICApO1xuXG4gICAgc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzID0gY2FjaGVkLnNjZW5lcztcbiAgICBzdGF0ZS5tZW1vcnlDYWNoZS50aW1lc3RhbXAgPSBjYWNoZWQudGltZXN0YW1wO1xuXG4gICAgaWYgKGlzU3RhbGUpIHtcbiAgICAgIGNvbnNvbGUubG9nKGBbU3Rhc2ggQmF0dGxlXSDij7AgQ2FjaGUgc3RhbGUgKD4ke0NBQ0hFX01BWF9BR0VfTVMgLyAxMDAwfXMpLCB0cmlnZ2VyaW5nIGJhY2tncm91bmQgcmVmcmVzaC4uLmApO1xuICAgICAgYmFja2dyb3VuZFJlZnJlc2hBbGxTY2VuZXMoKTsgLy8gRG9uJ3QgYXdhaXQgLSBydW5zIGluIGJhY2tncm91bmRcbiAgICB9XG4gICAgcmV0dXJuIHsgc2NlbmVzOiBjYWNoZWQuc2NlbmVzLCBjb3VudDogY2FjaGVkLmNvdW50IH07XG4gIH1cblxuICAvLyBObyBjYWNoZSBhdCBhbGwgLSBtdXN0IGZldGNoIGZyb20gbmV0d29yayAoYmxvY2tpbmcpXG4gIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+MkCBObyBjYWNoZSBmb3VuZCwgZmV0Y2hpbmcgYWxsIHNjZW5lcyBmcm9tIG5ldHdvcmsgKGZpcnN0IGxvYWQpLi4uXCIpO1xuICBjb25zdCBzdGFydFRpbWUgPSBEYXRlLm5vdygpO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGdyYXBocWxRdWVyeTxGaW5kU2NlbmVzUmVzdWx0PihGSU5EX1NDRU5FU19RVUVSWSwge1xuICAgIGZpbHRlcjoge1xuICAgICAgcGVyX3BhZ2U6IC0xLFxuICAgICAgc29ydDogXCJyYXRpbmdcIixcbiAgICAgIGRpcmVjdGlvbjogXCJERVNDXCIsXG4gICAgfSxcbiAgICBzY2VuZV9maWx0ZXI6IG51bGwsXG4gIH0pO1xuXG4gIGNvbnN0IHNjZW5lcyA9IHNvcnRCeUVsbyhyZXN1bHQuZmluZFNjZW5lcy5zY2VuZXMgfHwgW10pO1xuICBjb25zdCBjb3VudCA9IHJlc3VsdC5maW5kU2NlbmVzLmNvdW50IHx8IHNjZW5lcy5sZW5ndGg7XG4gIGNvbnN0IGZldGNoVGltZSA9IERhdGUubm93KCkgLSBzdGFydFRpbWU7XG5cbiAgc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzID0gc2NlbmVzO1xuICBzdGF0ZS5tZW1vcnlDYWNoZS50aW1lc3RhbXAgPSBEYXRlLm5vdygpO1xuICBhd2FpdCBzZXRDYWNoZWRTY2VuZXMoY2FjaGVLZXksIHNjZW5lcywgY291bnQpO1xuXG4gIGNvbnNvbGUubG9nKGBbU3Rhc2ggQmF0dGxlXSDinIUgRmV0Y2hlZCBhbmQgY2FjaGVkICR7c2NlbmVzLmxlbmd0aH0gc2NlbmVzIGluICR7ZmV0Y2hUaW1lfW1zYCk7XG4gIHJldHVybiB7IHNjZW5lcywgY291bnQgfTtcbn1cblxuLy8gQmFja2dyb3VuZCByZWZyZXNoIGZvciBmaWx0ZXJlZCBzY2VuZXNcbmFzeW5jIGZ1bmN0aW9uIGJhY2tncm91bmRSZWZyZXNoRmlsdGVyZWRTY2VuZXMoZmlsdGVyczogTGlzdEZpbHRlcnMpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgY2FjaGVLZXkgPSBcImZpbHRlcmVkLXNjZW5lc1wiO1xuXG4gIHRyeSB7XG4gICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5SEIEJhY2tncm91bmQgcmVmcmVzaCBzdGFydGVkIChmaWx0ZXJlZCBzY2VuZXMpLi4uXCIpO1xuICAgIGNvbnN0IHN0YXJ0VGltZSA9IERhdGUubm93KCk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBncmFwaHFsUXVlcnk8RmluZFNjZW5lc1Jlc3VsdD4oRklORF9TQ0VORVNfUVVFUlksIHtcbiAgICAgIGZpbHRlcjogZ2V0RmluZEZpbHRlcih7XG4gICAgICAgIHBlcl9wYWdlOiAtMSxcbiAgICAgICAgc29ydDogXCJyYXRpbmdcIixcbiAgICAgICAgZGlyZWN0aW9uOiBcIkRFU0NcIixcbiAgICAgIH0pLFxuICAgICAgc2NlbmVfZmlsdGVyOiBmaWx0ZXJzLnNjZW5lRmlsdGVyLFxuICAgIH0pO1xuXG4gICAgY29uc3Qgc2NlbmVzID0gc29ydEJ5RWxvKHJlc3VsdC5maW5kU2NlbmVzLnNjZW5lcyB8fCBbXSk7XG4gICAgY29uc3QgY291bnQgPSByZXN1bHQuZmluZFNjZW5lcy5jb3VudCB8fCBzY2VuZXMubGVuZ3RoO1xuICAgIGNvbnN0IGZldGNoVGltZSA9IERhdGUubm93KCkgLSBzdGFydFRpbWU7XG5cbiAgICAvLyBPbmx5IHVwZGF0ZSBpZiBzdGlsbCBvbiBzYW1lIGZpbHRlclxuICAgIGlmIChzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJLZXkgPT09IGZpbHRlcnMuZmlsdGVyS2V5KSB7XG4gICAgICBjb25zdCBvbGRDb3VudCA9IHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzID8gc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXMubGVuZ3RoIDogMDtcbiAgICAgIGlmIChjb3VudCAhPT0gb2xkQ291bnQpIHtcbiAgICAgICAgY29uc29sZS5sb2coXG4gICAgICAgICAgYFtTdGFzaCBCYXR0bGVdIPCfk4ogRmlsdGVyZWQgY291bnQgY2hhbmdlZDogJHtvbGRDb3VudH0g4oaSICR7Y291bnR9ICgke2NvdW50ID4gb2xkQ291bnQgPyBcIitcIiA6IFwiXCJ9JHtjb3VudCAtIG9sZENvdW50fSlgLFxuICAgICAgICApO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIPCfk4ogRmlsdGVyZWQgY291bnQgdW5jaGFuZ2VkOiAke2NvdW50fWApO1xuICAgICAgfVxuXG4gICAgICBzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJlZFNjZW5lcyA9IHNjZW5lcztcbiAgICAgIHN0YXRlLm1lbW9yeUNhY2hlLnRpbWVzdGFtcCA9IERhdGUubm93KCk7XG4gICAgICBhd2FpdCBzZXRDYWNoZWRTY2VuZXMoY2FjaGVLZXksIHNjZW5lcywgY291bnQsIGZpbHRlcnMuZmlsdGVyS2V5KTtcblxuICAgICAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIOKchSBCYWNrZ3JvdW5kIHJlZnJlc2ggY29tcGxldGU6ICR7c2NlbmVzLmxlbmd0aH0gZmlsdGVyZWQgc2NlbmVzIGluICR7ZmV0Y2hUaW1lfW1zYCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g4pqg77iPIEZpbHRlciBjaGFuZ2VkIGR1cmluZyByZWZyZXNoLCBkaXNjYXJkaW5nIHJlc3VsdHNcIik7XG4gICAgfVxuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIOKdjCBCYWNrZ3JvdW5kIHJlZnJlc2ggKGZpbHRlcmVkKSBmYWlsZWQ6XCIsIGUpO1xuICB9XG59XG5cbi8vIEdldCBmaWx0ZXJlZCBzY2VuZXMgKHVzZXMgY2FjaGUgd2l0aCBzdGFsZS13aGlsZS1yZXZhbGlkYXRlKVxuLy8gTk9URTogT25seSBPTkUgZmlsdGVyZWQgY2FjaGUgaXMga2VwdCAob3ZlcndyaXRlcyBwcmV2aW91cyBmaWx0ZXIgY2FjaGUgdG8gcHJldmVudCBJbmRleGVkREIgYmxvYXQpXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ2V0RmlsdGVyZWRTY2VuZXNDYWNoZWQoXG4gIGZpbHRlcnM6IExpc3RGaWx0ZXJzLFxuKTogUHJvbWlzZTx7IHNjZW5lczogU2NlbmVbXTsgY291bnQ6IG51bWJlciB9PiB7XG4gIGNvbnN0IHsgZmlsdGVyS2V5LCBzY2VuZUZpbHRlciB9ID0gZmlsdGVycztcbiAgY29uc3QgY2FjaGVLZXkgPSBcImZpbHRlcmVkLXNjZW5lc1wiOyAvLyBTaW5nbGUga2V5IC0gb3ZlcndyaXRlcyBwcmV2aW91cyBmaWx0ZXIgY2FjaGVcblxuICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCflI4gRmlsdGVyIGFjdGl2ZSwgY2hlY2tpbmcgZmlsdGVyZWQgY2FjaGUuLi5cIik7XG5cbiAgLy8gQ2hlY2sgbWVtb3J5IGNhY2hlIGZpcnN0IC0gcmV0dXJuIGltbWVkaWF0ZWx5IGlmIGF2YWlsYWJsZSBhbmQgc2FtZSBmaWx0ZXJcbiAgaWYgKHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzICYmIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcktleSA9PT0gZmlsdGVyS2V5KSB7XG4gICAgY29uc3QgY2FjaGVBZ2UgPSBNYXRoLnJvdW5kKChEYXRlLm5vdygpIC0gKHN0YXRlLm1lbW9yeUNhY2hlLnRpbWVzdGFtcCA/PyAwKSkgLyAxMDAwKTtcbiAgICBjb25zdCBpc1N0YWxlID0gRGF0ZS5ub3coKSAtIChzdGF0ZS5tZW1vcnlDYWNoZS50aW1lc3RhbXAgPz8gMCkgPj0gQ0FDSEVfTUFYX0FHRV9NUztcblxuICAgIGNvbnNvbGUubG9nKFxuICAgICAgYFtTdGFzaCBCYXR0bGVdIPCfkr4gTWVtb3J5IGNhY2hlIGhpdCAoZmlsdGVyZWQpOiAke3N0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzLmxlbmd0aH0gc2NlbmVzLCBhZ2U6ICR7Y2FjaGVBZ2V9cyR7aXNTdGFsZSA/IFwiIFtTVEFMRV1cIiA6IFwiXCJ9YCxcbiAgICApO1xuXG4gICAgaWYgKGlzU3RhbGUpIHtcbiAgICAgIGNvbnNvbGUubG9nKGBbU3Rhc2ggQmF0dGxlXSDij7AgQ2FjaGUgc3RhbGUgKD4ke0NBQ0hFX01BWF9BR0VfTVMgLyAxMDAwfXMpLCB0cmlnZ2VyaW5nIGJhY2tncm91bmQgcmVmcmVzaC4uLmApO1xuICAgICAgYmFja2dyb3VuZFJlZnJlc2hGaWx0ZXJlZFNjZW5lcyhmaWx0ZXJzKTtcbiAgICB9XG4gICAgcmV0dXJuIHsgc2NlbmVzOiBzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJlZFNjZW5lcywgY291bnQ6IHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzLmxlbmd0aCB9O1xuICB9XG5cbiAgLy8gQ2hlY2sgSW5kZXhlZERCIGNhY2hlIChvbmx5IGlmIGZpbHRlciBrZXkgbWF0Y2hlcylcbiAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5SNIE1lbW9yeSBjYWNoZSBtaXNzIChmaWx0ZXJlZCksIGNoZWNraW5nIEluZGV4ZWREQi4uLlwiKTtcbiAgY29uc3QgY2FjaGVkID0gYXdhaXQgZ2V0Q2FjaGVkU2NlbmVzKGNhY2hlS2V5KTtcbiAgaWYgKGNhY2hlZCAmJiBjYWNoZWQuZmlsdGVyS2V5ID09PSBmaWx0ZXJLZXkpIHtcbiAgICBjb25zdCBjYWNoZUFnZSA9IE1hdGgucm91bmQoKERhdGUubm93KCkgLSBjYWNoZWQudGltZXN0YW1wKSAvIDEwMDApO1xuICAgIGNvbnN0IGlzU3RhbGUgPSBEYXRlLm5vdygpIC0gY2FjaGVkLnRpbWVzdGFtcCA+PSBDQUNIRV9NQVhfQUdFX01TO1xuXG4gICAgY29uc29sZS5sb2coXG4gICAgICBgW1N0YXNoIEJhdHRsZV0g8J+SvyBJbmRleGVkREIgY2FjaGUgaGl0IChmaWx0ZXJlZCk6ICR7Y2FjaGVkLnNjZW5lcy5sZW5ndGh9IHNjZW5lcywgYWdlOiAke2NhY2hlQWdlfXMke2lzU3RhbGUgPyBcIiBbU1RBTEVdXCIgOiBcIlwifWAsXG4gICAgKTtcblxuICAgIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzID0gY2FjaGVkLnNjZW5lcztcbiAgICBzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJLZXkgPSBmaWx0ZXJLZXk7XG4gICAgc3RhdGUubWVtb3J5Q2FjaGUudGltZXN0YW1wID0gY2FjaGVkLnRpbWVzdGFtcDtcblxuICAgIGlmIChpc1N0YWxlKSB7XG4gICAgICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g4o+wIENhY2hlIHN0YWxlICg+JHtDQUNIRV9NQVhfQUdFX01TIC8gMTAwMH1zKSwgdHJpZ2dlcmluZyBiYWNrZ3JvdW5kIHJlZnJlc2guLi5gKTtcbiAgICAgIGJhY2tncm91bmRSZWZyZXNoRmlsdGVyZWRTY2VuZXMoZmlsdGVycyk7XG4gICAgfVxuICAgIHJldHVybiB7IHNjZW5lczogY2FjaGVkLnNjZW5lcywgY291bnQ6IGNhY2hlZC5jb3VudCB9O1xuICB9XG5cbiAgaWYgKGNhY2hlZCkge1xuICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+SvyBJbmRleGVkREIgY2FjaGUgZXhpc3RzIGJ1dCBmaWx0ZXIgY2hhbmdlZCwgZmV0Y2hpbmcgbmV3IGRhdGEuLi5cIik7XG4gIH0gZWxzZSB7XG4gICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5K/IEluZGV4ZWREQiBjYWNoZSBtaXNzIChmaWx0ZXJlZClcIik7XG4gIH1cblxuICAvLyBObyBtYXRjaGluZyBjYWNoZSAtIG11c3QgZmV0Y2ggZnJvbSBuZXR3b3JrIChibG9ja2luZylcbiAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn4yQIEZldGNoaW5nIGZpbHRlcmVkIHNjZW5lcyBmcm9tIG5ldHdvcmsuLi5cIik7XG4gIGNvbnN0IHN0YXJ0VGltZSA9IERhdGUubm93KCk7XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZ3JhcGhxbFF1ZXJ5PEZpbmRTY2VuZXNSZXN1bHQ+KEZJTkRfU0NFTkVTX1FVRVJZLCB7XG4gICAgZmlsdGVyOiBnZXRGaW5kRmlsdGVyKHtcbiAgICAgIHBlcl9wYWdlOiAtMSxcbiAgICAgIHNvcnQ6IFwicmF0aW5nXCIsXG4gICAgICBkaXJlY3Rpb246IFwiREVTQ1wiLFxuICAgIH0pLFxuICAgIHNjZW5lX2ZpbHRlcjogc2NlbmVGaWx0ZXIsXG4gIH0pO1xuXG4gIGNvbnN0IHNjZW5lcyA9IHNvcnRCeUVsbyhyZXN1bHQuZmluZFNjZW5lcy5zY2VuZXMgfHwgW10pO1xuICBjb25zdCBjb3VudCA9IHJlc3VsdC5maW5kU2NlbmVzLmNvdW50IHx8IHNjZW5lcy5sZW5ndGg7XG4gIGNvbnN0IGZldGNoVGltZSA9IERhdGUubm93KCkgLSBzdGFydFRpbWU7XG5cbiAgc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXMgPSBzY2VuZXM7XG4gIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcktleSA9IGZpbHRlcktleTtcbiAgc3RhdGUubWVtb3J5Q2FjaGUudGltZXN0YW1wID0gRGF0ZS5ub3coKTtcbiAgYXdhaXQgc2V0Q2FjaGVkU2NlbmVzKGNhY2hlS2V5LCBzY2VuZXMsIGNvdW50LCBmaWx0ZXJLZXkpO1xuXG4gIGNvbnNvbGUubG9nKGBbU3Rhc2ggQmF0dGxlXSDinIUgRmV0Y2hlZCBhbmQgY2FjaGVkICR7c2NlbmVzLmxlbmd0aH0gZmlsdGVyZWQgc2NlbmVzIGluICR7ZmV0Y2hUaW1lfW1zYCk7XG4gIHJldHVybiB7IHNjZW5lcywgY291bnQgfTtcbn1cblxuLyoqIFNldCAob3Igd2l0aCBudWxsLCByZW1vdmUpIHRoZSBFTE8gZmllbGRzIG9uIG9uZSBzY2VuZSBvYmplY3QuICovXG5mdW5jdGlvbiBhcHBseUVsbyhzY2VuZTogU2NlbmUsIHZhbHVlOiBFbG9GaWVsZHMgfCBudWxsKTogdm9pZCB7XG4gIHNjZW5lLmN1c3RvbV9maWVsZHMgPSB3aXRoRWxvRmllbGRzKHNjZW5lLmN1c3RvbV9maWVsZHMsIHZhbHVlKTtcbn1cblxuLyoqXG4gKiBUaGUgY2FjaGVkIGNvcHkgb2YgYSBzY2VuZSAoYWxsIHNjZW5lcyBmaXJzdCwgdGhlbiB0aGUgZmlsdGVyZWQgb25lcyksIG9yIHRoZSBzY2VuZSBpdHNlbGYgaWZcbiAqIG5laXRoZXIgaGFzIGl0LiBTY2VuZSBvYmplY3RzIGhlbGQgYWNyb3NzIGJhdHRsZXMgKHRoZSBzaHVmZmxlLCBhIHNhdmVkIHBhaXIsIGEgQ2hhbXBpb24gb3JcbiAqIFBsYWNlbWVudCBydW4pIGdvIHN0YWxlIG9uY2UgYSBiYWNrZ3JvdW5kIHJlZnJlc2ggc3dhcHMgaW4gbmV3IGNvcGllcywgc28gYmF0dGxlIG1hdGggcmVhZHNcbiAqIEVMTyBhbmQgYmF0dGxlcyBmcm9tIHRoaXMgaW5zdGVhZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxhdGVzdFNjZW5lKHNjZW5lOiBTY2VuZSk6IFNjZW5lIHtcbiAgcmV0dXJuIChcbiAgICBzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXM/LmZpbmQoKHMpID0+IHMuaWQgPT09IHNjZW5lLmlkKSA/P1xuICAgIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzPy5maW5kKChzKSA9PiBzLmlkID09PSBzY2VuZS5pZCkgPz9cbiAgICBzY2VuZVxuICApO1xufVxuXG4vKipcbiAqIFNldCAob3Igd2l0aCBudWxsLCByZW1vdmUpIGEgc2NlbmUncyBFTE8gb24gYHNjZW5lYCBpdHNlbGYgYW5kIG9uIGl0cyBjYWNoZWQgY29waWVzLCBhbmQgbW92ZVxuICogdGhlIGNhY2hlZCBjb3BpZXMgdG8gdGhlaXIgbmV3IHBsYWNlIGluIHRoZSBFTE8gb3JkZXIgc28gcmFua3Mgc3RheSByaWdodC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNldEVsb0luQ2FjaGUoc2NlbmU6IFNjZW5lLCB2YWx1ZTogRWxvRmllbGRzIHwgbnVsbCk6IHZvaWQge1xuICBhcHBseUVsbyhzY2VuZSwgdmFsdWUpO1xuICBmb3IgKGNvbnN0IHBvb2wgb2YgW3N0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcywgc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXNdKSB7XG4gICAgY29uc3QgaWR4ID0gcG9vbCA/IHBvb2wuZmluZEluZGV4KChzKSA9PiBzLmlkID09PSBzY2VuZS5pZCkgOiAtMTtcbiAgICBpZiAoIXBvb2wgfHwgaWR4ID09PSAtMSkgY29udGludWU7XG4gICAgY29uc3QgW2NhY2hlZF0gPSBwb29sLnNwbGljZShpZHgsIDEpO1xuICAgIGlmIChjYWNoZWQgIT09IHNjZW5lKSBhcHBseUVsbyhjYWNoZWQsIHZhbHVlKTtcbiAgICBwb29sLnNwbGljZSh2YWx1ZSA/IGVsb0luc2VydGlvbkluZGV4KHBvb2wsIHZhbHVlLmVsbykgOiBwb29sLmxlbmd0aCwgMCwgY2FjaGVkKTtcbiAgfVxuICBwZXJzaXN0Q2FjaGVTb29uKCk7XG59XG5cbi8qKiBTZXQgdGhlIFN0YXNoIHJhdGluZyBvbiBjYWNoZWQgc2NlbmVzIChhZnRlciBTdGFzaCBCYXR0bGUgd3JvdGUgdGhlbSkuIE9yZGVyIGlzIEVMTywgc28gdW5jaGFuZ2VkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNldFJhdGluZ3NJbkNhY2hlKHJhdGluZ3M6IE1hcDxzdHJpbmcsIG51bWJlcj4pOiB2b2lkIHtcbiAgZm9yIChjb25zdCBwb29sIG9mIFtzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXMsIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzXSkge1xuICAgIGZvciAoY29uc3Qgc2NlbmUgb2YgcG9vbCA/PyBbXSkge1xuICAgICAgY29uc3QgcmF0aW5nID0gcmF0aW5ncy5nZXQoc2NlbmUuaWQpO1xuICAgICAgaWYgKHJhdGluZyAhPT0gdW5kZWZpbmVkKSBzY2VuZS5yYXRpbmcxMDAgPSByYXRpbmc7XG4gICAgfVxuICB9XG4gIHBlcnNpc3RDYWNoZVNvb24oKTtcbn1cblxuLyoqXG4gKiBCcmluZyBhIHNjZW5lJ3MgY2FjaGVkIGNvcGllcyBpbiBsaW5lIHdpdGggZnJlc2ggdmFsdWVzIGZyb20gU3Rhc2ggKGl0cyBFTE8gZmllbGRzIGFuZCBTdGFzaFxuICogcmF0aW5nKSwgbW92aW5nIHRoZW0gdG8gdGhlaXIgcGxhY2UgaW4gdGhlIEVMTyBvcmRlci4gRm9yIHNjZW5lcyBmZXRjaGVkIG9uIHRoZWlyIG93biAoYVxuICogcmVzdG9yZWQgcGFpciwgYSBzY2VuZSBwYWdlIGJhdHRsZSksIHdoaWNoIG1heSBiZSBuZXdlciB0aGFuIHRoZSBjYWNoZTogY2hhbmdlZCBpbiBhbm90aGVyXG4gKiB0YWIsIHNheS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlZnJlc2hTY2VuZUluQ2FjaGUoZnJlc2g6IFNjZW5lKTogdm9pZCB7XG4gIGZvciAoY29uc3QgcG9vbCBvZiBbc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzLCBzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJlZFNjZW5lc10pIHtcbiAgICBjb25zdCBjYWNoZWQgPSBwb29sPy5maW5kKChzKSA9PiBzLmlkID09PSBmcmVzaC5pZCk7XG4gICAgaWYgKGNhY2hlZCkgY2FjaGVkLnJhdGluZzEwMCA9IGZyZXNoLnJhdGluZzEwMCA/PyBudWxsO1xuICB9XG4gIHNldEVsb0luQ2FjaGUoZnJlc2gsIGVsb0ZpZWxkcyhmcmVzaCkpO1xufVxuXG4vKiogV3JpdGUgdGhlIGluLW1lbW9yeSBzY2VuZSBsaXN0cyBiYWNrIHRvIEluZGV4ZWREQiB0aGlzIGxvbmcgYWZ0ZXIgdGhlIGxhc3QgY2hhbmdlLiAqL1xuY29uc3QgUEVSU0lTVF9ERUJPVU5DRV9NUyA9IDEwMDA7XG5sZXQgcGVyc2lzdFRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xuXG4vKipcbiAqIEJhdHRsZXMgY2hhbmdlIHRoZSBpbi1tZW1vcnkgbGlzdHMgb25seTsgd2l0aG91dCB0aGlzLCBhIHJlbG9hZCB3aXRoaW4gQ0FDSEVfTUFYX0FHRV9NUyB3b3VsZFxuICogcmVhZCB0aGUgSW5kZXhlZERCIGNvcHkgZnJvbSBiZWZvcmUgdGhlbSAob2xkIEVMTywgb2xkIG9yZGVyKS4gRGVib3VuY2VkLCBzbyBhIHBpY2sncyB3cml0ZXNcbiAqIGFuZCBpdHMgU3Rhc2ggcmF0aW5nIHN5bmMgYXJlIHNhdmVkIHRvZ2V0aGVyLlxuICovXG5mdW5jdGlvbiBwZXJzaXN0Q2FjaGVTb29uKCk6IHZvaWQge1xuICBpZiAodHlwZW9mIGluZGV4ZWREQiA9PT0gXCJ1bmRlZmluZWRcIikgcmV0dXJuO1xuICBpZiAocGVyc2lzdFRpbWVyKSBjbGVhclRpbWVvdXQocGVyc2lzdFRpbWVyKTtcbiAgcGVyc2lzdFRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgcGVyc2lzdFRpbWVyID0gbnVsbDtcbiAgICB2b2lkIHBlcnNpc3RDYWNoZSgpO1xuICB9LCBQRVJTSVNUX0RFQk9VTkNFX01TKTtcbn1cblxuLyoqIFNhdmUgdGhlIGluLW1lbW9yeSBsaXN0cyBvdmVyIHRoZWlyIEluZGV4ZWREQiBlbnRyaWVzLCBrZWVwaW5nIGVhY2ggZW50cnkncyB0aW1lc3RhbXAuICovXG5hc3luYyBmdW5jdGlvbiBwZXJzaXN0Q2FjaGUoKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGxpc3RzOiBbc3RyaW5nLCBTY2VuZVtdIHwgbnVsbF1bXSA9IFtcbiAgICBbXCJhbGwtc2NlbmVzXCIsIHN0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lc10sXG4gICAgW1wiZmlsdGVyZWQtc2NlbmVzXCIsIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzXSxcbiAgXTtcbiAgZm9yIChjb25zdCBbY2FjaGVLZXksIHNjZW5lc10gb2YgbGlzdHMpIHtcbiAgICBpZiAoIXNjZW5lcykgY29udGludWU7XG4gICAgY29uc3QgY2FjaGVkID0gYXdhaXQgZ2V0Q2FjaGVkU2NlbmVzKGNhY2hlS2V5KTtcbiAgICAvLyBNaXNzaW5nIG9yIGV4cGlyZWQ6IHRoZSBuZXh0IGxvYWQgZmV0Y2hlcyBmcmVzaCBhbnl3YXkuIEEgZGlmZmVyZW50IGZpbHRlcjogbm90IHRoaXMgbGlzdC5cbiAgICBpZiAoIWNhY2hlZCkgY29udGludWU7XG4gICAgaWYgKGNhY2hlS2V5ID09PSBcImZpbHRlcmVkLXNjZW5lc1wiICYmIGNhY2hlZC5maWx0ZXJLZXkgIT09IHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcktleSkgY29udGludWU7XG4gICAgYXdhaXQgc2V0Q2FjaGVkU2NlbmVzKGNhY2hlS2V5LCBzY2VuZXMsIHNjZW5lcy5sZW5ndGgsIGNhY2hlZC5maWx0ZXJLZXksIGNhY2hlZC50aW1lc3RhbXApO1xuICB9XG59XG5cbi8vIERyb3AgYSBkZWxldGVkIHNjZW5lIGZyb20gZXZlcnkgY2FjaGUgdGllciBhbmQgdGhlIGxlZnQtc2lkZSBzaHVmZmxlXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVtb3ZlU2NlbmVFdmVyeXdoZXJlKHNjZW5lSWQ6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB3aXRob3V0ID0gKHNjZW5lczogU2NlbmVbXSB8IG51bGwpOiBTY2VuZVtdIHwgbnVsbCA9PlxuICAgIHNjZW5lcyA/IHNjZW5lcy5maWx0ZXIoKHMpID0+IHMuaWQgIT09IHNjZW5lSWQpIDogc2NlbmVzO1xuXG4gIHN0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcyA9IHdpdGhvdXQoc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzKTtcbiAgc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXMgPSB3aXRob3V0KHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzKTtcblxuICBjb25zdCBzaHVmZmxlSWR4ID0gc3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lcy5maW5kSW5kZXgoKHMpID0+IHMuaWQgPT09IHNjZW5lSWQpO1xuICBpZiAoc2h1ZmZsZUlkeCAhPT0gLTEpIHtcbiAgICBzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzLnNwbGljZShzaHVmZmxlSWR4LCAxKTtcbiAgICBpZiAoc2h1ZmZsZUlkeCA8IHN0YXRlLnNodWZmbGVJbmRleCkgc3RhdGUuc2h1ZmZsZUluZGV4LS07XG4gIH1cblxuICBmb3IgKGNvbnN0IGNhY2hlS2V5IG9mIFtcImFsbC1zY2VuZXNcIiwgXCJmaWx0ZXJlZC1zY2VuZXNcIl0pIHtcbiAgICBjb25zdCBjYWNoZWQgPSBhd2FpdCBnZXRDYWNoZWRTY2VuZXMoY2FjaGVLZXkpO1xuICAgIGlmIChjYWNoZWQgJiYgY2FjaGVkLnNjZW5lcy5zb21lKChzKSA9PiBzLmlkID09PSBzY2VuZUlkKSkge1xuICAgICAgY29uc3Qgc2NlbmVzID0gY2FjaGVkLnNjZW5lcy5maWx0ZXIoKHMpID0+IHMuaWQgIT09IHNjZW5lSWQpO1xuICAgICAgLy8gS2VlcCB0aGUgb3JpZ2luYWwgdGltZXN0YW1wOiByZW1vdmluZyBvbmUgc2NlbmUgZG9lc24ndCBtYWtlIHRoZSByZXN0IGFueSBmcmVzaGVyXG4gICAgICBhd2FpdCBzZXRDYWNoZWRTY2VuZXMoY2FjaGVLZXksIHNjZW5lcywgc2NlbmVzLmxlbmd0aCwgY2FjaGVkLmZpbHRlcktleSwgY2FjaGVkLnRpbWVzdGFtcCk7XG4gICAgfVxuICB9XG4gIGNvbnNvbGUubG9nKGBbU3Rhc2ggQmF0dGxlXSDwn5eR77iPIFJlbW92ZWQgc2NlbmUgJHtzY2VuZUlkfSBmcm9tIGNhY2hlc2ApO1xufVxuIiwgIi8vIFNjZW5lIGxvb2t1cHMgZm9yIGRldGVjdGluZyBzY2VuZXMgZGVsZXRlZCB3aGlsZSB0aGV5IHdlcmUgaW4gYSBiYXR0bGUsIGFuZCBmb3IgYnJpbmdpbmcgYVxyXG4vLyBzYXZlZCBwYWlyJ3MgRUxPIGFuZCBTdGFzaCByYXRpbmcgdXAgdG8gZGF0ZS5cclxuXHJcbmltcG9ydCB7IGdyYXBocWxRdWVyeSB9IGZyb20gXCIuL2dyYXBocWxcIjtcclxuaW1wb3J0IHR5cGUgeyBTY2VuZSB9IGZyb20gXCIuL3R5cGVzXCI7XHJcblxyXG5leHBvcnQgdHlwZSBTY2VuZUZpZWxkcyA9IFBpY2s8U2NlbmUsIFwiaWRcIiB8IFwicmF0aW5nMTAwXCIgfCBcImN1c3RvbV9maWVsZHNcIj47XHJcblxyXG4vKipcclxuICogVGhlIGN1cnJlbnQgU3Rhc2ggcmF0aW5nIGFuZCBjdXN0b20gZmllbGRzIG9mIHRoZXNlIHNjZW5lcywgYnkgaWQ7IGlkcyB0aGF0IG5vIGxvbmdlciBleGlzdFxyXG4gKiBhcmUgbWlzc2luZy4gKGZpbmRTY2VuZXMoaWRzKSBlcnJvcnMgb24gYW55IG1pc3NpbmcgaWQsIHNvIGl0J3MgYWxpYXNlZCBmaW5kU2NlbmUgbG9va3Vwcy4pXHJcbiAqL1xyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmV0Y2hTY2VuZUZpZWxkcyhpZHM6IHN0cmluZ1tdKTogUHJvbWlzZTxNYXA8c3RyaW5nLCBTY2VuZUZpZWxkcz4+IHtcclxuICBjb25zdCBhbGlhc2VzID0gaWRzXHJcbiAgICAubWFwKChpZCwgaSkgPT4gYHMke2l9OiBmaW5kU2NlbmUoaWQ6ICR7SlNPTi5zdHJpbmdpZnkoaWQpfSkgeyBpZCByYXRpbmcxMDAgY3VzdG9tX2ZpZWxkcyB9YClcclxuICAgIC5qb2luKFwiXFxuXCIpO1xyXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGdyYXBocWxRdWVyeTxSZWNvcmQ8c3RyaW5nLCBTY2VuZUZpZWxkcyB8IG51bGw+PihgeyAke2FsaWFzZXN9IH1gKTtcclxuICByZXR1cm4gbmV3IE1hcChPYmplY3QudmFsdWVzKHJlc3VsdCkuZmxhdE1hcCgocykgPT4gKHMgPyBbW3MuaWQsIHNdIGFzIGNvbnN0XSA6IFtdKSkpO1xyXG59XHJcblxyXG4vKiogVHJ1ZSBmb3IgR3JhcGhRTCBlcnJvcnMgU3Rhc2ggcmFpc2VzIHdoZW4gYSBzY2VuZSBpZCBubyBsb25nZXIgZXhpc3RzLiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gaXNTY2VuZU5vdEZvdW5kRXJyb3IoZXJyb3I6IHVua25vd24pOiBib29sZWFuIHtcclxuICByZXR1cm4gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciAmJiAvbm90IGZvdW5kL2kudGVzdChlcnJvci5tZXNzYWdlKTtcclxufVxyXG4iLCAiLy8gUGVyc2lzdCBFTE8gKGFuZCBTdGFzaCByYXRpbmdzKSB0byBTdGFzaCBhbmQga2VlcCB0aGUgbG9jYWwgY2FjaGUgaW4gc3luYy5cblxuaW1wb3J0IHsgbGF0ZXN0U2NlbmUsIHNldEVsb0luQ2FjaGUsIHNldFJhdGluZ3NJbkNhY2hlIH0gZnJvbSBcIi4vY2FjaGVcIjtcbmltcG9ydCB7IEVMT19GSUVMRF9LRVlTIH0gZnJvbSBcIi4vY29uc3RhbnRzXCI7XG5pbXBvcnQgeyBncmFwaHFsUXVlcnksIHJlZnJlc2hTdGFzaENhY2hlIH0gZnJvbSBcIi4vZ3JhcGhxbFwiO1xuaW1wb3J0IHsgaXNTY2VuZU5vdEZvdW5kRXJyb3IgfSBmcm9tIFwiLi9zY2VuZUFjdGlvbnNcIjtcbmltcG9ydCB7IGVsb0N1c3RvbUZpZWxkcywgZWxvRmllbGRzLCBpc1NlZWRlZCwgc3Rhc2hSYXRpbmdDaGFuZ2VzIH0gZnJvbSBcIi4vc2NvcmVcIjtcbmltcG9ydCB7IHN0YXRlIH0gZnJvbSBcIi4vc3RhdGVcIjtcbmltcG9ydCB0eXBlIHsgRWxvRmllbGRzLCBTY2VuZSB9IGZyb20gXCIuL3R5cGVzXCI7XG5cbi8qKiBXaW5kb3cgZXZlbnQgZmlyZWQgd2hlbiBhIHJhdGluZyB3cml0ZSBmaW5kcyB0aGUgc2NlbmUgd2FzIGRlbGV0ZWQgZWxzZXdoZXJlIChkZXRhaWwgPSBzY2VuZSBpZCkuICovXG5leHBvcnQgY29uc3QgU0NFTkVfTUlTU0lOR19FVkVOVCA9IFwic3Rhc2gtYmF0dGxlOnNjZW5lLW1pc3NpbmdcIjtcblxuY29uc3QgU0NFTkVfVVBEQVRFX01VVEFUSU9OID0gYFxuICAgICAgbXV0YXRpb24gU2NlbmVVcGRhdGUoJGlucHV0OiBTY2VuZVVwZGF0ZUlucHV0ISkge1xuICAgICAgICBzY2VuZVVwZGF0ZShpbnB1dDogJGlucHV0KSB7XG4gICAgICAgICAgaWRcbiAgICAgICAgfVxuICAgICAgfVxuICAgIGA7XG5cbmZ1bmN0aW9uIHJlcG9ydFdyaXRlRXJyb3Ioc2NlbmVJZDogc3RyaW5nLCB3aGF0OiBzdHJpbmcsIGU6IHVua25vd24pOiB2b2lkIHtcbiAgY29uc29sZS5lcnJvcihgW1N0YXNoIEJhdHRsZV0gRmFpbGVkIHRvICR7d2hhdH0gZm9yIHNjZW5lICR7c2NlbmVJZH06YCwgZSk7XG4gIGlmIChpc1NjZW5lTm90Rm91bmRFcnJvcihlKSkge1xuICAgIHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBDdXN0b21FdmVudChTQ0VORV9NSVNTSU5HX0VWRU5ULCB7IGRldGFpbDogc2NlbmVJZCB9KSk7XG4gIH1cbn1cblxuLyoqIFRydWUgd2hlbiBib3RoIGFyZSB1bnJhdGVkLCBvciBob2xkIHRoZSBzYW1lIEVMTyBmaWVsZHMuICovXG5mdW5jdGlvbiBzYW1lRWxvKGE6IEVsb0ZpZWxkcyB8IG51bGwsIGI6IEVsb0ZpZWxkcyB8IG51bGwpOiBib29sZWFuIHtcbiAgaWYgKGEgPT09IG51bGwgfHwgYiA9PT0gbnVsbCkgcmV0dXJuIGEgPT09IGI7XG4gIHJldHVybiBhLmVsbyA9PT0gYi5lbG8gJiYgYS5iYXR0bGVzID09PSBiLmJhdHRsZXMgJiYgYS5zZWVkZWQgPT09IGIuc2VlZGVkO1xufVxuXG4vKipcbiAqIFVwZGF0ZSB0aGUgc2NlbmUgb2JqZWN0LCB0aGUgY2FjaGUgYW5kIFN0YXNoJ3MgcGFnZSBjYWNoZSBzdHJhaWdodCBhd2F5IChzbyB0aGUgbmV4dCBwYWlyXG4gKiBhbHJlYWR5IHNlZXMgdGhlIGNoYW5nZSksIHRoZW4gd3JpdGUgdG8gU3Rhc2guIElmIHRoZSB3cml0ZSBmYWlscywgcHV0IHRoZSBvbGQgdmFsdWUgYmFjayxcbiAqIHVubGVzcyBhIGxhdGVyIHdyaXRlIGhhcyByZXBsYWNlZCBpdCBzaW5jZS4gU3Rhc2ggcmF0aW5ncyBzeW5jIG9ubHkgYWZ0ZXIgYSBzdWNjZXNzZnVsIHdyaXRlLlxuICovXG5hc3luYyBmdW5jdGlvbiBzYXZlRWxvRmllbGRzKHNjZW5lOiBTY2VuZSwgdmFsdWU6IEVsb0ZpZWxkcyB8IG51bGwsIGN1c3RvbUZpZWxkczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sIHdoYXQ6IHN0cmluZyk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBjb25zdCBwcmV2aW91cyA9IGVsb0ZpZWxkcyhsYXRlc3RTY2VuZShzY2VuZSkpO1xuICBzZXRFbG9JbkNhY2hlKHNjZW5lLCB2YWx1ZSk7XG4gIHJlZnJlc2hTdGFzaENhY2hlKFt7IGlkOiBzY2VuZS5pZCwgZWxvOiB2YWx1ZSB9XSwgZmFsc2UpO1xuICB0cnkge1xuICAgIGF3YWl0IGdyYXBocWxRdWVyeShTQ0VORV9VUERBVEVfTVVUQVRJT04sIHsgaW5wdXQ6IHsgaWQ6IHNjZW5lLmlkLCBjdXN0b21fZmllbGRzOiBjdXN0b21GaWVsZHMgfSB9KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHJlcG9ydFdyaXRlRXJyb3Ioc2NlbmUuaWQsIHdoYXQsIGUpO1xuICAgIGlmIChzYW1lRWxvKGVsb0ZpZWxkcyhsYXRlc3RTY2VuZShzY2VuZSkpLCB2YWx1ZSkpIHtcbiAgICAgIHNldEVsb0luQ2FjaGUoc2NlbmUsIHByZXZpb3VzKTtcbiAgICAgIHJlZnJlc2hTdGFzaENhY2hlKFt7IGlkOiBzY2VuZS5pZCwgZWxvOiBwcmV2aW91cyB9XSwgZmFsc2UpO1xuICAgIH1cbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgc2NoZWR1bGVTdGFzaFJhdGluZ1N5bmMoKTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbi8qKlxuICogU2F2ZSBhIHNjZW5lJ3MgRUxPIGFuZCBiYXR0bGUgY291bnQgKGN1c3RvbSBmaWVsZHMgb25seTsgYHBhcnRpYWxgIGxlYXZlcyBvdGhlciBwbHVnaW5zJ1xuICogZmllbGRzIGFsb25lKS4gV2hldGhlciBpdCB3YXMgc2VlZGVkIHN0YXlzIGFzIGl0IHdhcy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHdyaXRlRWxvKHNjZW5lOiBTY2VuZSwgZWxvOiBudW1iZXIsIGJhdHRsZXM6IG51bWJlcik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB2YWx1ZSA9IHsgZWxvLCBiYXR0bGVzLCBzZWVkZWQ6IGlzU2VlZGVkKHNjZW5lKSB9O1xuICBpZiAoYXdhaXQgc2F2ZUVsb0ZpZWxkcyhzY2VuZSwgdmFsdWUsIHsgcGFydGlhbDogZWxvQ3VzdG9tRmllbGRzKHZhbHVlKSB9LCBcInNhdmUgRUxPXCIpKSB7XG4gICAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIPCfk50gU2F2ZWQgc2NlbmUgJHtzY2VuZS5pZH0gRUxPICR7ZWxvfSAoJHtiYXR0bGVzfSBiYXR0bGVzKWApO1xuICB9XG59XG5cbi8qKiBSZW1vdmUgYSBzY2VuZSdzIEVMTyBmaWVsZHMsIG1ha2luZyBpdCB1bnJhdGVkIGFnYWluLiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNsZWFyRWxvKHNjZW5lOiBTY2VuZSk6IFByb21pc2U8dm9pZD4ge1xuICBpZiAoYXdhaXQgc2F2ZUVsb0ZpZWxkcyhzY2VuZSwgbnVsbCwgeyByZW1vdmU6IEVMT19GSUVMRF9LRVlTIH0sIFwiY2xlYXIgRUxPXCIpKSB7XG4gICAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIPCfk50gQ2xlYXJlZCBzY2VuZSAke3NjZW5lLmlkfSBFTE9gKTtcbiAgfVxufVxuXG4vKipcbiAqIFdyaXRlIFN0YXNoIHJhdGluZ3MgKHNjZW5lIGlkIHRvIDEtMTAwKSBpbiBvbmUgR3JhcGhRTCByZXF1ZXN0OiBvbmUgYWxpYXNlZCBidWxrU2NlbmVVcGRhdGVcbiAqIHBlciBkaXN0aW5jdCB2YWx1ZS4gVGhyb3dzIG9uIGZhaWx1cmU7IGRvZXNuJ3QgdG91Y2ggdGhlIGNhY2hlLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gd3JpdGVTdGFzaFJhdGluZ3MocmF0aW5nczogTWFwPHN0cmluZywgbnVtYmVyPik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBpZHNCeVJhdGluZyA9IG5ldyBNYXA8bnVtYmVyLCBzdHJpbmdbXT4oKTtcbiAgZm9yIChjb25zdCBbaWQsIHJhdGluZ10gb2YgcmF0aW5ncykge1xuICAgIGNvbnN0IGlkcyA9IGlkc0J5UmF0aW5nLmdldChyYXRpbmcpID8/IFtdO1xuICAgIGlkcy5wdXNoKGlkKTtcbiAgICBpZHNCeVJhdGluZy5zZXQocmF0aW5nLCBpZHMpO1xuICB9XG4gIGlmIChpZHNCeVJhdGluZy5zaXplID09PSAwKSByZXR1cm47XG5cbiAgY29uc3QgdmFsdWVzID0gWy4uLmlkc0J5UmF0aW5nLmtleXMoKV07XG4gIGNvbnN0IG11dGF0aW9uID0gYFxuICAgICAgbXV0YXRpb24gU3luY1N0YXNoUmF0aW5ncygke3ZhbHVlcy5tYXAoKHIpID0+IGAkciR7cn06IEJ1bGtTY2VuZVVwZGF0ZUlucHV0IWApLmpvaW4oXCIsIFwiKX0pIHtcbiAgICAgICAgJHt2YWx1ZXMubWFwKChyKSA9PiBgciR7cn06IGJ1bGtTY2VuZVVwZGF0ZShpbnB1dDogJHIke3J9KSB7IGlkIH1gKS5qb2luKFwiXFxuICAgICAgICBcIil9XG4gICAgICB9XG4gICAgYDtcbiAgY29uc3QgdmFyaWFibGVzID0gT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgIHZhbHVlcy5tYXAoKHIpID0+IFtgciR7cn1gLCB7IGlkczogaWRzQnlSYXRpbmcuZ2V0KHIpLCByYXRpbmcxMDA6IHIgfV0pLFxuICApO1xuICBhd2FpdCBncmFwaHFsUXVlcnkobXV0YXRpb24sIHZhcmlhYmxlcyk7XG4gIGNvbnNvbGUubG9nKGBbU3Rhc2ggQmF0dGxlXSDwn5OdIFdyb3RlICR7cmF0aW5ncy5zaXplfSBTdGFzaCByYXRpbmdzICgke3ZhbHVlcy5sZW5ndGh9IGRpc3RpbmN0IHZhbHVlcylgKTtcbn1cblxuLyoqIEFmdGVyIFN0YXNoIHJhdGluZ3Mgd2VyZSB3cml0dGVuOiB1cGRhdGUgdGhlIGNhY2hlZCBzY2VuZXMgYW5kIFN0YXNoJ3Mgb3duIHBhZ2UgY2FjaGUuICovXG5leHBvcnQgZnVuY3Rpb24gYXBwbHlTdGFzaFJhdGluZ3MocmF0aW5nczogTWFwPHN0cmluZywgbnVtYmVyPik6IHZvaWQge1xuICBzZXRSYXRpbmdzSW5DYWNoZShyYXRpbmdzKTtcbiAgcmVmcmVzaFN0YXNoQ2FjaGUoXG4gICAgWy4uLnJhdGluZ3NdLm1hcCgoW2lkLCByYXRpbmcxMDBdKSA9PiAoeyBpZCwgcmF0aW5nMTAwIH0pKSxcbiAgICByYXRpbmdzLnNpemUgPiAwLFxuICApO1xufVxuXG4vKiogV2FpdCB0aGlzIGxvbmcgYWZ0ZXIgdGhlIGxhc3QgRUxPIHdyaXRlLCBzbyBib3RoIHNjZW5lcyBvZiBhIHBpY2sgc3luYyBpbiBvbmUgcmVxdWVzdC4gKi9cbmNvbnN0IFNZTkNfREVCT1VOQ0VfTVMgPSA1MDA7XG5sZXQgc3luY1RpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xuXG4vKiogU3luYyBTdGFzaCByYXRpbmdzIHNvb24gKGRlYm91bmNlZCksIHVubGVzcyB0aGUgXCJTdGFzaCByYXRpbmdzXCIgc2V0dGluZyBpcyBcIm9mZlwiLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNjaGVkdWxlU3Rhc2hSYXRpbmdTeW5jKCk6IHZvaWQge1xuICBpZiAoc3RhdGUuc2V0dGluZ3Muc3Rhc2hSYXRpbmdzID09PSBcIm9mZlwiKSByZXR1cm47XG4gIGlmIChzeW5jVGltZXIpIGNsZWFyVGltZW91dChzeW5jVGltZXIpO1xuICBzeW5jVGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICBzeW5jVGltZXIgPSBudWxsO1xuICAgIHZvaWQgc3luY1N0YXNoUmF0aW5ncygpO1xuICB9LCBTWU5DX0RFQk9VTkNFX01TKTtcbn1cblxuLyoqIFRoZSBTdGFzaCByYXRpbmcgd3JpdGUgaW4gcHJvZ3Jlc3MgKG9yIHRoZSBsYXN0IG9uZSksIHNvIHRoZSBuZXh0IHdhaXRzIGZvciBpdC4gKi9cbmxldCByYXRpbmdXcml0ZXM6IFByb21pc2U8dW5rbm93bj4gPSBQcm9taXNlLnJlc29sdmUoKTtcblxuLyoqXG4gKiBSdW4gYSBTdGFzaCByYXRpbmdzIHdyaXRlIGFmdGVyIGFueSBpbiBwcm9ncmVzcywgc28gZWFjaCBvbmUgc3RhcnRzIGZyb20gdGhlIHJhdGluZ3MgdGhlXG4gKiBwcmV2aW91cyBvbmUgd3JvdGUgKG92ZXJsYXBwaW5nIHdyaXRlcyBjb3VsZCByZXBlYXQgd29yayBvciBmaW5pc2ggb3V0IG9mIG9yZGVyKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHF1ZXVlUmF0aW5nV3JpdGU8VD4odGFzazogKCkgPT4gUHJvbWlzZTxUPik6IFByb21pc2U8VD4ge1xuICBjb25zdCBydW4gPSByYXRpbmdXcml0ZXMudGhlbih0YXNrKTtcbiAgcmF0aW5nV3JpdGVzID0gcnVuLmNhdGNoKCgpID0+IHVuZGVmaW5lZCk7XG4gIHJldHVybiBydW47XG59XG5cbi8qKlxuICogQnJpbmcgU3Rhc2ggcmF0aW5ncyBpbiBsaW5lIHdpdGggRUxPIGZvciB0aGUgd2hvbGUgbGlicmFyeSAodGhlIGFsbC1zY2VuZXMgY2FjaGUpOiB3b3JrIG91dFxuICogZXZlcnkgc2NlbmUncyB0YXJnZXQgdW5kZXIgdGhlIGN1cnJlbnQgc2V0dGluZywgYW5kIHdyaXRlIG9ubHkgdGhlIG9uZXMgdGhhdCBkaWZmZXIgZnJvbSB0aGVcbiAqIGNhY2hlZCByYXRpbmcsIGluIG9uZSByZXF1ZXN0LiBRdWV1ZWQgYmVoaW5kIGFueSB3cml0ZSBpbiBwcm9ncmVzcy4gUmV0dXJucyBob3cgbWFueSB3ZXJlIHdyaXR0ZW4uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzeW5jU3Rhc2hSYXRpbmdzKCk6IFByb21pc2U8bnVtYmVyPiB7XG4gIHJldHVybiBxdWV1ZVJhdGluZ1dyaXRlKGFzeW5jICgpID0+IHtcbiAgICBjb25zdCBtb2RlID0gc3RhdGUuc2V0dGluZ3Muc3Rhc2hSYXRpbmdzO1xuICAgIGNvbnN0IHNjZW5lcyA9IHN0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcztcbiAgICBpZiAobW9kZSA9PT0gXCJvZmZcIiB8fCAhc2NlbmVzKSByZXR1cm4gMDtcbiAgICBjb25zdCBjaGFuZ2VzID0gc3Rhc2hSYXRpbmdDaGFuZ2VzKHNjZW5lcywgbW9kZSk7XG4gICAgaWYgKGNoYW5nZXMuc2l6ZSA9PT0gMCkgcmV0dXJuIDA7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IHdyaXRlU3Rhc2hSYXRpbmdzKGNoYW5nZXMpO1xuICAgICAgYXBwbHlTdGFzaFJhdGluZ3MoY2hhbmdlcyk7XG4gICAgICByZXR1cm4gY2hhbmdlcy5zaXplO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoXCJbU3Rhc2ggQmF0dGxlXSBGYWlsZWQgdG8gc3luYyBTdGFzaCByYXRpbmdzOlwiLCBlKTtcbiAgICAgIHJldHVybiAwO1xuICAgIH1cbiAgfSk7XG59XG4iLCAiLy8gT25lLXRpbWUgRUxPIHNldHVwOiBnaXZlIGV2ZXJ5IHNjZW5lIGEgc3RhcnRpbmcgRUxPIChmcm9tIGl0cyBTdGFzaCByYXRpbmcsIG9yIDE1MDAgZm9yIGFsbCksXG4vLyB0aGVuIG9wdGlvbmFsbHkgc3luYyBTdGFzaCByYXRpbmdzIGZyb20gdGhlIG5ldyBFTE8uIFJlLXJ1bm5pbmcgaXQgb3ZlcndyaXRlcywgc28gYW5cbi8vIGludGVycnVwdGVkIHNldHVwIGlzIHNhZmUgdG8gcmVwZWF0LlxuXG5pbXBvcnQgeyBFTE9fRklFTERfS0VZUywgRUxPX1NUQVJUIH0gZnJvbSBcIi4vY29uc3RhbnRzXCI7XG5pbXBvcnQgeyBncmFwaHFsUXVlcnksIHJlZnJlc2hTdGFzaENhY2hlIH0gZnJvbSBcIi4vZ3JhcGhxbFwiO1xuaW1wb3J0IHsgd3JpdGVTdGFzaFJhdGluZ3MgfSBmcm9tIFwiLi9yYXRpbmdcIjtcbmltcG9ydCB7IGFmdGVyU2V0dXAsIGVsb0N1c3RvbUZpZWxkcywgaXNSYXRlZCwgc2VlZCwgc3RhcnRpbmdFbG8sIHN0YXNoUmF0aW5nQ2hhbmdlcyB9IGZyb20gXCIuL3Njb3JlXCI7XG5pbXBvcnQgdHlwZSB7IEVsb1N0YXJ0LCBTY2VuZSwgU3Rhc2hSYXRpbmdzTW9kZSB9IGZyb20gXCIuL3R5cGVzXCI7XG5cbmV4cG9ydCB0eXBlIFNldHVwUGhhc2UgPSBcImVsb1wiIHwgXCJyYXRpbmdzXCI7XG5cbi8qKiBQcm9ncmVzcyBjYWxsYmFjazogYGRvbmVgIG9mIGB0b3RhbGAgc2NlbmVzIGZpbmlzaGVkIGluIHRoaXMgcGhhc2UuICovXG5leHBvcnQgdHlwZSBTZXR1cFByb2dyZXNzID0gKHBoYXNlOiBTZXR1cFBoYXNlLCBkb25lOiBudW1iZXIsIHRvdGFsOiBudW1iZXIpID0+IHZvaWQ7XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2V0dXBTdW1tYXJ5IHtcbiAgZWxvV3JpdHRlbjogbnVtYmVyOyAvLyBTY2VuZXMgZ2l2ZW4gYSBzdGFydGluZyBFTE9cbiAgZWxvQ2xlYXJlZDogbnVtYmVyOyAvLyBTY2VuZXMgd2hvc2Ugb2xkIEVMTyB3YXMgcmVtb3ZlZCAocmUtcnVuIHdpdGggXCJVc2UgbXkgcmF0aW5nc1wiKVxuICByYXRpbmdzV3JpdHRlbjogbnVtYmVyOyAvLyBTdGFzaCByYXRpbmdzIGNoYW5nZWRcbn1cblxuY29uc3QgU0VUVVBfU0NFTkVTX1FVRVJZID0gYFxuICAgICAgcXVlcnkgRmluZFNjZW5lc0ZvckVsb1NldHVwIHtcbiAgICAgICAgZmluZFNjZW5lcyhmaWx0ZXI6IHsgcGVyX3BhZ2U6IC0xIH0pIHtcbiAgICAgICAgICBzY2VuZXMge1xuICAgICAgICAgICAgaWRcbiAgICAgICAgICAgIHJhdGluZzEwMFxuICAgICAgICAgICAgY3VzdG9tX2ZpZWxkc1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIGA7XG5cbi8qKiBFdmVyeSBzY2VuZSdzIGlkLCBTdGFzaCByYXRpbmcgYW5kIGN1c3RvbSBmaWVsZHMsIGZyZXNoIGZyb20gU3Rhc2ggKG5vdCB0aGUgNS1taW51dGUgY2FjaGUpLiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGZldGNoU2V0dXBTY2VuZXMoKTogUHJvbWlzZTxTY2VuZVtdPiB7XG4gIGNvbnN0IGRhdGEgPSBhd2FpdCBncmFwaHFsUXVlcnk8eyBmaW5kU2NlbmVzOiB7IHNjZW5lczogU2NlbmVbXSB9IH0+KFNFVFVQX1NDRU5FU19RVUVSWSk7XG4gIHJldHVybiBkYXRhLmZpbmRTY2VuZXMuc2NlbmVzID8/IFtdO1xufVxuXG4vKiogVGhlIFN0YXNoIHJhdGluZ3MgdGhlIHNldHVwIHdvdWxkIGNoYW5nZTogc2NlbmUgaWQgdG8gbmV3IHJhdGluZyAobm9uZSBmb3IgXCJvZmZcIikuICovXG5leHBvcnQgZnVuY3Rpb24gc2V0dXBSYXRpbmdDaGFuZ2VzKHNjZW5lczogU2NlbmVbXSwgc3RhcnQ6IEVsb1N0YXJ0LCBzdGFzaFJhdGluZ3M6IFN0YXNoUmF0aW5nc01vZGUpOiBNYXA8c3RyaW5nLCBudW1iZXI+IHtcbiAgcmV0dXJuIHN0YXNoUmF0aW5nQ2hhbmdlcyhcbiAgICBzY2VuZXMubWFwKChzY2VuZSkgPT4gYWZ0ZXJTZXR1cChzY2VuZSwgc3RhcnQpKSxcbiAgICBzdGFzaFJhdGluZ3MsXG4gICk7XG59XG5cbmNvbnN0IEJVTEtfVVBEQVRFX01VVEFUSU9OID0gYFxuICAgICAgbXV0YXRpb24gQnVsa1NjZW5lVXBkYXRlKCRpbnB1dDogQnVsa1NjZW5lVXBkYXRlSW5wdXQhKSB7XG4gICAgICAgIGJ1bGtTY2VuZVVwZGF0ZShpbnB1dDogJGlucHV0KSB7XG4gICAgICAgICAgaWRcbiAgICAgICAgfVxuICAgICAgfVxuICAgIGA7XG5cbi8qKlxuICogU2VlZCBlYWNoIHJhdGVkIHNjZW5lIGZyb20gaXRzIG93biByYXRpbmcuIFNjZW5lcyB3aXRoIHRoZSBzYW1lIFN0YXNoIHJhdGluZyBnZXQgdGhlIHNhbWVcbiAqIHN0YXJ0aW5nIGZpZWxkcywgc28gaXQncyBvbmUgYWxpYXNlZCBidWxrU2NlbmVVcGRhdGUgcGVyIGRpc3RpbmN0IHJhdGluZywgYWxsIGluIG9uZSByZXF1ZXN0LlxuICovXG5hc3luYyBmdW5jdGlvbiBzZWVkRnJvbVJhdGluZ3MocmF0ZWQ6IFNjZW5lW10pOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgaWRzQnlSYXRpbmcgPSBuZXcgTWFwPG51bWJlciwgc3RyaW5nW10+KCk7XG4gIGZvciAoY29uc3Qgc2NlbmUgb2YgcmF0ZWQpIHtcbiAgICBjb25zdCByYXRpbmcgPSBzY2VuZS5yYXRpbmcxMDAgYXMgbnVtYmVyO1xuICAgIGNvbnN0IGlkcyA9IGlkc0J5UmF0aW5nLmdldChyYXRpbmcpID8/IFtdO1xuICAgIGlkcy5wdXNoKHNjZW5lLmlkKTtcbiAgICBpZHNCeVJhdGluZy5zZXQocmF0aW5nLCBpZHMpO1xuICB9XG4gIGlmIChpZHNCeVJhdGluZy5zaXplID09PSAwKSByZXR1cm47XG5cbiAgY29uc3QgdmFsdWVzID0gWy4uLmlkc0J5UmF0aW5nLmtleXMoKV07XG4gIGNvbnN0IG11dGF0aW9uID0gYFxuICAgICAgbXV0YXRpb24gU2VlZEVsbygke3ZhbHVlcy5tYXAoKHIpID0+IGAkcyR7cn06IEJ1bGtTY2VuZVVwZGF0ZUlucHV0IWApLmpvaW4oXCIsIFwiKX0pIHtcbiAgICAgICAgJHt2YWx1ZXMubWFwKChyKSA9PiBgcyR7cn06IGJ1bGtTY2VuZVVwZGF0ZShpbnB1dDogJHMke3J9KSB7IGlkIH1gKS5qb2luKFwiXFxuICAgICAgICBcIil9XG4gICAgICB9XG4gICAgYDtcbiAgY29uc3QgdmFyaWFibGVzID0gT2JqZWN0LmZyb21FbnRyaWVzKFxuICAgIHZhbHVlcy5tYXAoKHIpID0+IHtcbiAgICAgIGNvbnN0IHBhcnRpYWwgPSBlbG9DdXN0b21GaWVsZHMoeyBlbG86IHNlZWQociksIGJhdHRsZXM6IDAsIHNlZWRlZDogdHJ1ZSB9KTtcbiAgICAgIHJldHVybiBbYHMke3J9YCwgeyBpZHM6IGlkc0J5UmF0aW5nLmdldChyKSwgY3VzdG9tX2ZpZWxkczogeyBwYXJ0aWFsIH0gfV07XG4gICAgfSksXG4gICk7XG4gIGF3YWl0IGdyYXBocWxRdWVyeShtdXRhdGlvbiwgdmFyaWFibGVzKTtcbn1cblxuLyoqXG4gKiBSdW4gdGhlIHNldHVwIG9uIGBzY2VuZXNgIChmcm9tIGZldGNoU2V0dXBTY2VuZXMpOiB3cml0ZSB0aGUgc3RhcnRpbmcgRUxPLCB0aGVuLCB1bmxlc3NcbiAqIHN0YXNoUmF0aW5ncyBpcyBcIm9mZlwiLCB0aGUgU3Rhc2ggcmF0aW5ncyB0aGF0IGNoYW5nZS4gVGhyb3dzIGlmIGEgcmVxdWVzdCBmYWlsczsgd2hhdGV2ZXJcbiAqIHdhcyB3cml0dGVuIGJ5IHRoZW4gc3RheXMsIGFuZCBydW5uaW5nIGl0IGFnYWluIG92ZXJ3cml0ZXMgaXQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5FbG9TZXR1cChcbiAgc2NlbmVzOiBTY2VuZVtdLFxuICBzdGFydDogRWxvU3RhcnQsXG4gIHN0YXNoUmF0aW5nczogU3Rhc2hSYXRpbmdzTW9kZSxcbiAgb25Qcm9ncmVzczogU2V0dXBQcm9ncmVzcyxcbik6IFByb21pc2U8U2V0dXBTdW1tYXJ5PiB7XG4gIGNvbnN0IHN1bW1hcnk6IFNldHVwU3VtbWFyeSA9IHsgZWxvV3JpdHRlbjogMCwgZWxvQ2xlYXJlZDogMCwgcmF0aW5nc1dyaXR0ZW46IDAgfTtcblxuICBpZiAoc3RhcnQgPT09IFwicmF0aW5nc1wiKSB7XG4gICAgY29uc3QgcmF0ZWQgPSBzY2VuZXMuZmlsdGVyKChzY2VuZSkgPT4gc2NlbmUucmF0aW5nMTAwICE9IG51bGwpO1xuICAgIG9uUHJvZ3Jlc3MoXCJlbG9cIiwgMCwgcmF0ZWQubGVuZ3RoKTtcbiAgICBhd2FpdCBzZWVkRnJvbVJhdGluZ3MocmF0ZWQpO1xuICAgIG9uUHJvZ3Jlc3MoXCJlbG9cIiwgcmF0ZWQubGVuZ3RoLCByYXRlZC5sZW5ndGgpO1xuICAgIHN1bW1hcnkuZWxvV3JpdHRlbiA9IHJhdGVkLmxlbmd0aDtcblxuICAgIC8vIE9ubHkgbWF0dGVycyBvbiBhIHJlLXJ1bjogc2NlbmVzIHdpdGggYW4gRUxPIGJ1dCBubyBTdGFzaCByYXRpbmcgYmVjb21lIHVucmF0ZWQgYWdhaW5cbiAgICBjb25zdCBzdGFsZSA9IHNjZW5lcy5maWx0ZXIoKHNjZW5lKSA9PiBzY2VuZS5yYXRpbmcxMDAgPT0gbnVsbCAmJiBpc1JhdGVkKHNjZW5lKSkubWFwKChzY2VuZSkgPT4gc2NlbmUuaWQpO1xuICAgIGlmIChzdGFsZS5sZW5ndGggPiAwKSB7XG4gICAgICBhd2FpdCBncmFwaHFsUXVlcnkoQlVMS19VUERBVEVfTVVUQVRJT04sIHtcbiAgICAgICAgaW5wdXQ6IHsgaWRzOiBzdGFsZSwgY3VzdG9tX2ZpZWxkczogeyByZW1vdmU6IEVMT19GSUVMRF9LRVlTIH0gfSxcbiAgICAgIH0pO1xuICAgICAgc3VtbWFyeS5lbG9DbGVhcmVkID0gc3RhbGUubGVuZ3RoO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICBjb25zdCBpZHMgPSBzY2VuZXMubWFwKChzY2VuZSkgPT4gc2NlbmUuaWQpO1xuICAgIG9uUHJvZ3Jlc3MoXCJlbG9cIiwgMCwgaWRzLmxlbmd0aCk7XG4gICAgaWYgKGlkcy5sZW5ndGggPiAwKSB7XG4gICAgICBhd2FpdCBncmFwaHFsUXVlcnkoQlVMS19VUERBVEVfTVVUQVRJT04sIHtcbiAgICAgICAgaW5wdXQ6IHsgaWRzLCBjdXN0b21fZmllbGRzOiB7IHBhcnRpYWw6IGVsb0N1c3RvbUZpZWxkcyh7IGVsbzogRUxPX1NUQVJULCBiYXR0bGVzOiAwLCBzZWVkZWQ6IGZhbHNlIH0pIH0gfSxcbiAgICAgIH0pO1xuICAgIH1cbiAgICBvblByb2dyZXNzKFwiZWxvXCIsIGlkcy5sZW5ndGgsIGlkcy5sZW5ndGgpO1xuICAgIHN1bW1hcnkuZWxvV3JpdHRlbiA9IGlkcy5sZW5ndGg7XG4gIH1cblxuICBjb25zdCBjaGFuZ2VzID0gc2V0dXBSYXRpbmdDaGFuZ2VzKHNjZW5lcywgc3RhcnQsIHN0YXNoUmF0aW5ncyk7XG4gIGlmIChjaGFuZ2VzLnNpemUgPiAwKSB7XG4gICAgb25Qcm9ncmVzcyhcInJhdGluZ3NcIiwgMCwgY2hhbmdlcy5zaXplKTtcbiAgICBhd2FpdCB3cml0ZVN0YXNoUmF0aW5ncyhjaGFuZ2VzKTtcbiAgICBvblByb2dyZXNzKFwicmF0aW5nc1wiLCBjaGFuZ2VzLnNpemUsIGNoYW5nZXMuc2l6ZSk7XG4gICAgc3VtbWFyeS5yYXRpbmdzV3JpdHRlbiA9IGNoYW5nZXMuc2l6ZTtcbiAgfVxuXG4gIC8vIFN0YXNoJ3Mgb3duIHBhZ2VzOiBldmVyeSBzY2VuZSdzIEVMTyAob3IgaXRzIHJlbW92YWwpIGFuZCBhbnkgY2hhbmdlZCByYXRpbmdcbiAgcmVmcmVzaFN0YXNoQ2FjaGUoXG4gICAgc2NlbmVzLm1hcCgoc2NlbmUpID0+ICh7IGlkOiBzY2VuZS5pZCwgZWxvOiBzdGFydGluZ0VsbyhzY2VuZSwgc3RhcnQpLCByYXRpbmcxMDA6IGNoYW5nZXMuZ2V0KHNjZW5lLmlkKSB9KSksXG4gICAgY2hhbmdlcy5zaXplID4gMCxcbiAgKTtcblxuICBjb25zb2xlLmxvZyhcbiAgICBgW1N0YXNoIEJhdHRsZV0g4pyFIEVMTyBzZXR1cCAoJHtzdGFydH0sIFN0YXNoIHJhdGluZ3MgJHtzdGFzaFJhdGluZ3N9KTogJHtzdW1tYXJ5LmVsb1dyaXR0ZW59IEVMTyB3cml0dGVuLCAke3N1bW1hcnkuZWxvQ2xlYXJlZH0gY2xlYXJlZCwgJHtzdW1tYXJ5LnJhdGluZ3NXcml0dGVufSBTdGFzaCByYXRpbmdzIHdyaXR0ZW5gLFxuICApO1xuICByZXR1cm4gc3VtbWFyeTtcbn1cbiIsICIvLyBVc2VyIHNldHRpbmdzIHN0b3JlZCBpbiBTdGFzaCdzIHBsdWdpbiBjb25maWd1cmF0aW9uIChjb25maWd1cmF0aW9uLnBsdWdpbnNbXCJzdGFzaC1iYXR0bGVcIl0pLFxuLy8gc28gdGhleSBmb2xsb3cgdGhlIHVzZXIgYWNyb3NzIGJyb3dzZXJzLiBBbHNvIGVkaXRhYmxlIGluIFN0YXNoIOKGkiBTZXR0aW5ncyDihpIgUGx1Z2lucy5cblxuaW1wb3J0IHtcbiAgREVGQVVMVF9TRVRUSU5HUyxcbiAgTEVHQUNZX0ZJTFRFUl9PUFBPTkVOVFNfS0VZLFxuICBMRUdBQ1lfTVVURV9QUkVWSUVXU19LRVksXG4gIFBMVUdJTl9JRCxcbn0gZnJvbSBcIi4vY29uc3RhbnRzXCI7XG5pbXBvcnQgeyBncmFwaHFsUXVlcnkgfSBmcm9tIFwiLi9ncmFwaHFsXCI7XG5pbXBvcnQgeyBzdGF0ZSB9IGZyb20gXCIuL3N0YXRlXCI7XG5pbXBvcnQgdHlwZSB7IEVsb1N0YXJ0LCBTZXR0aW5ncywgU3Rhc2hSYXRpbmdzTW9kZSB9IGZyb20gXCIuL3R5cGVzXCI7XG5cbmNvbnN0IENPTkZJR19RVUVSWSA9IGB7IGNvbmZpZ3VyYXRpb24geyBwbHVnaW5zIH0gfWA7XG5cbmNvbnN0IENPTkZJR1VSRV9QTFVHSU5fTVVUQVRJT04gPSBgXG4gICAgICBtdXRhdGlvbiBDb25maWd1cmVQbHVnaW4oJHBsdWdpbl9pZDogSUQhLCAkaW5wdXQ6IE1hcCEpIHtcbiAgICAgICAgY29uZmlndXJlUGx1Z2luKHBsdWdpbl9pZDogJHBsdWdpbl9pZCwgaW5wdXQ6ICRpbnB1dClcbiAgICAgIH1cbiAgICBgO1xuXG5jb25zdCBTQVZFX0RFQk9VTkNFX01TID0gNDAwO1xubGV0IHNhdmVUaW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCBudWxsID0gbnVsbDtcblxuLyoqIFByZS0zLjAgZnVuIG1vZGUgd2FzIG9uIGluIHRoZSBzdG9yZWQgY29uZmlnIChzbyBCYXR0bGUgd2Fzbid0IGNoYW5naW5nIFN0YXNoIHJhdGluZ3MpLiAqL1xubGV0IGxlZ2FjeUZ1bk1vZGUgPSBmYWxzZTtcblxuY29uc3QgU1RBU0hfUkFUSU5HU19NT0RFUzogcmVhZG9ubHkgU3Rhc2hSYXRpbmdzTW9kZVtdID0gW1wib2ZmXCIsIFwicGVyY2VudGlsZVwiLCBcImxpbmVhclwiXTtcbmNvbnN0IEVMT19TVEFSVFM6IHJlYWRvbmx5IEVsb1N0YXJ0W10gPSBbXCJyYXRpbmdzXCIsIFwiZnJlc2hcIl07XG5cbmZ1bmN0aW9uIG9uZU9mPFQgZXh0ZW5kcyBzdHJpbmc+KHZhbHVlOiB1bmtub3duLCBhbGxvd2VkOiByZWFkb25seSBUW10sIGZhbGxiYWNrOiBUKTogVCB7XG4gIHJldHVybiBhbGxvd2VkLmluY2x1ZGVzKHZhbHVlIGFzIFQpID8gKHZhbHVlIGFzIFQpIDogZmFsbGJhY2s7XG59XG5cbmZ1bmN0aW9uIGNsYW1wUGVyY2VudCh2YWx1ZTogdW5rbm93biwgZmFsbGJhY2s6IG51bWJlcik6IG51bWJlciB7XG4gIGNvbnN0IG4gPSBOdW1iZXIodmFsdWUpO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pID8gTWF0aC5taW4oMTAwLCBNYXRoLm1heCgwLCBNYXRoLnJvdW5kKG4pKSkgOiBmYWxsYmFjaztcbn1cblxuLyoqIENvZXJjZSBhIHN0b3JlZCBjb25maWcgbWFwIGludG8gU2V0dGluZ3MgKFN0YXNoIG1heSBvbWl0IGtleXMgb3Igc3RvcmUgbnVtYmVycyBhcyBzdHJpbmdzKS4gKi9cbmZ1bmN0aW9uIG5vcm1hbGl6ZShyYXc6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LCBiYXNlOiBTZXR0aW5ncyk6IFNldHRpbmdzIHtcbiAgY29uc3QgYm9vbCA9IChrZXk6IGtleW9mIFNldHRpbmdzKTogYm9vbGVhbiA9PlxuICAgIHR5cGVvZiByYXdba2V5XSA9PT0gXCJib29sZWFuXCIgPyAocmF3W2tleV0gYXMgYm9vbGVhbikgOiAoYmFzZVtrZXldIGFzIGJvb2xlYW4pO1xuICByZXR1cm4ge1xuICAgIC8vIEEgbWlzc2luZyBvciB1bmtub3duIHZhbHVlIGlzIFwib2ZmXCIuIChSZW1vdmVkIGtleXMsIGZ1bk1vZGUgYW5kIHVucmF0ZWRSYXRpbmcsIGFyZSBkcm9wcGVkLilcbiAgICBzdGFzaFJhdGluZ3M6IG9uZU9mKHJhdy5zdGFzaFJhdGluZ3MsIFNUQVNIX1JBVElOR1NfTU9ERVMsIFwib2ZmXCIpLFxuICAgIC8vIFNldHVwIGZsYWdzIGhhdmUgbm8gZmFsbGJhY2s6IHJhdyBhbHdheXMgY2FycmllcyB0aGVtIChzdG9yZWQgY29uZmlnLCBvciBjdXJyZW50ICsgcGF0Y2gpXG4gICAgZWxvU2V0dXBBdDogdHlwZW9mIHJhdy5lbG9TZXR1cEF0ID09PSBcInN0cmluZ1wiICYmIHJhdy5lbG9TZXR1cEF0ID8gcmF3LmVsb1NldHVwQXQgOiBudWxsLFxuICAgIGVsb1NldHVwTW9kZTogRUxPX1NUQVJUUy5pbmNsdWRlcyhyYXcuZWxvU2V0dXBNb2RlIGFzIEVsb1N0YXJ0KSA/IChyYXcuZWxvU2V0dXBNb2RlIGFzIEVsb1N0YXJ0KSA6IG51bGwsXG4gICAgb3BlbkluTmV3VGFiOiBib29sKFwib3BlbkluTmV3VGFiXCIpLFxuICAgIGF1dG9wbGF5UHJldmlld3M6IGJvb2woXCJhdXRvcGxheVByZXZpZXdzXCIpLFxuICAgIGZpbHRlck9wcG9uZW50czogYm9vbChcImZpbHRlck9wcG9uZW50c1wiKSxcbiAgICBjbGVhbk1vZGU6IGJvb2woXCJjbGVhbk1vZGVcIiksXG4gICAgcGF1c2VNZWRpYU9uT3BlbjogYm9vbChcInBhdXNlTWVkaWFPbk9wZW5cIiksXG4gICAgcGxhY2VtZW50RnJvbUJvdHRvbTogYm9vbChcInBsYWNlbWVudEZyb21Cb3R0b21cIiksXG4gICAgcHJldmlld1ZvbHVtZTogY2xhbXBQZXJjZW50KHJhdy5wcmV2aWV3Vm9sdW1lID8/IGJhc2UucHJldmlld1ZvbHVtZSwgYmFzZS5wcmV2aWV3Vm9sdW1lKSxcbiAgfTtcbn1cblxuLyoqIERlZmF1bHRzIG92ZXJsYWlkIHdpdGggdGhlIHByZS0yLjcgbG9jYWxTdG9yYWdlIHRvZ2dsZXMsIGZvciB1c2VycyB3aG8gbmV2ZXIgc2F2ZWQgc2V0dGluZ3MuICovXG5mdW5jdGlvbiBsZWdhY3lEZWZhdWx0cygpOiBTZXR0aW5ncyB7XG4gIGNvbnN0IHNldHRpbmdzID0geyAuLi5ERUZBVUxUX1NFVFRJTkdTIH07XG4gIHRyeSB7XG4gICAgaWYgKGxvY2FsU3RvcmFnZS5nZXRJdGVtKExFR0FDWV9GSUxURVJfT1BQT05FTlRTX0tFWSkgPT09IFwiMVwiKSBzZXR0aW5ncy5maWx0ZXJPcHBvbmVudHMgPSB0cnVlO1xuICAgIGlmIChsb2NhbFN0b3JhZ2UuZ2V0SXRlbShMRUdBQ1lfTVVURV9QUkVWSUVXU19LRVkpID09PSBcIjFcIikgc2V0dGluZ3MucHJldmlld1ZvbHVtZSA9IDA7XG4gIH0gY2F0Y2gge1xuICAgIC8qIGlnbm9yZSAqL1xuICB9XG4gIHJldHVybiBzZXR0aW5ncztcbn1cblxuLyoqXG4gKiBGZXRjaCBzZXR0aW5ncyBmcm9tIFN0YXNoIGludG8gc3RhdGUuc2V0dGluZ3MuIE9uIGZhaWx1cmUsIGtlZXBzIHRoZSBjdXJyZW50IHZhbHVlcyBhbmRcbiAqIHJldHVybnMgZmFsc2UuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBsb2FkU2V0dGluZ3MoKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIHRyeSB7XG4gICAgY29uc3Qgc3RvcmVkID0gYXdhaXQgZmV0Y2hTdG9yZWRDb25maWcoKTtcbiAgICBsZWdhY3lGdW5Nb2RlID0gc3RvcmVkPy5mdW5Nb2RlID09PSB0cnVlO1xuICAgIHN0YXRlLnNldHRpbmdzID0gc3RvcmVkID8gbm9ybWFsaXplKHN0b3JlZCwgREVGQVVMVF9TRVRUSU5HUykgOiBsZWdhY3lEZWZhdWx0cygpO1xuICAgIHJldHVybiB0cnVlO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIEZhaWxlZCB0byBsb2FkIHNldHRpbmdzLCB1c2luZyBjdXJyZW50IHZhbHVlczpcIiwgZSk7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbi8qKiBUcnVlIGlmIHRoZSBzdG9yZWQgY29uZmlnIHN0aWxsIGhhcyBwcmUtMy4wIGZ1biBtb2RlIHN3aXRjaGVkIG9uLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhhZEZ1bk1vZGUoKTogYm9vbGVhbiB7XG4gIHJldHVybiBsZWdhY3lGdW5Nb2RlO1xufVxuXG4vKiogU2V0dGluZ3MgY2hhbmdlZCBpbiB0aGlzIHRhYiBhbmQgbm90IHNhdmVkIHlldC4gKi9cbmNvbnN0IHVuc2F2ZWQgPSBuZXcgU2V0PGtleW9mIFNldHRpbmdzPigpO1xuXG4vKiogVGhlIHN0b3JlZCBjb25maWcgbWFwLCBmcmVzaCBmcm9tIFN0YXNoICh1bmRlZmluZWQgaWYgU3Rhc2ggQmF0dGxlIG5ldmVyIHNhdmVkIG9uZSkuICovXG5hc3luYyBmdW5jdGlvbiBmZXRjaFN0b3JlZENvbmZpZygpOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkPiB7XG4gIGNvbnN0IGRhdGEgPSBhd2FpdCBncmFwaHFsUXVlcnk8eyBjb25maWd1cmF0aW9uOiB7IHBsdWdpbnM6IFJlY29yZDxzdHJpbmcsIFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB9IH0+KFxuICAgIENPTkZJR19RVUVSWSxcbiAgKTtcbiAgcmV0dXJuIGRhdGEuY29uZmlndXJhdGlvbi5wbHVnaW5zPy5bUExVR0lOX0lEXTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcGVyc2lzdFNldHRpbmdzKCk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBjb25zdCBrZXlzID0gWy4uLnVuc2F2ZWRdO1xuICB1bnNhdmVkLmNsZWFyKCk7XG4gIHRyeSB7XG4gICAgLy8gY29uZmlndXJlUGx1Z2luIHJlcGxhY2VzIHRoZSB3aG9sZSBtYXAsIHNvIHRoaXMgdGFiJ3MgdW5zYXZlZCBjaGFuZ2VzIGdvIG9uIHRvcCBvZiB0aGVcbiAgICAvLyBzdG9yZWQgY29uZmlnLCBub3QgdGhpcyB0YWIncyBjb3B5IG9mIGl0OiBhbm90aGVyIHRhYiBtYXkgaGF2ZSBzYXZlZCBzaW5jZSB0aGlzIG9uZSBsb2FkZWRcbiAgICAvLyAoZmluaXNoZWQgdGhlIEVMTyBzZXR1cCwgc2F5KSwgYW5kIGFuIG9sZGVyIGNvcHkgd291bGQgdW5kbyB0aGF0LlxuICAgIGNvbnN0IHN0b3JlZCA9IGF3YWl0IGZldGNoU3RvcmVkQ29uZmlnKCk7XG4gICAgY29uc3QgbWVyZ2VkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHN0b3JlZCA/IHsgLi4ubm9ybWFsaXplKHN0b3JlZCwgc3RhdGUuc2V0dGluZ3MpIH0gOiB7IC4uLnN0YXRlLnNldHRpbmdzIH07XG4gICAgZm9yIChjb25zdCBrZXkgb2Yga2V5cykgbWVyZ2VkW2tleV0gPSBzdGF0ZS5zZXR0aW5nc1trZXldO1xuICAgIC8vIFVuc2V0IGtleXMgYXJlIGxlZnQgb3V0XG4gICAgY29uc3QgaW5wdXQgPSBPYmplY3QuZnJvbUVudHJpZXMoT2JqZWN0LmVudHJpZXMobWVyZ2VkKS5maWx0ZXIoKFssIHZhbHVlXSkgPT4gdmFsdWUgIT09IG51bGwpKTtcbiAgICBhd2FpdCBncmFwaHFsUXVlcnkoQ09ORklHVVJFX1BMVUdJTl9NVVRBVElPTiwgeyBwbHVnaW5faWQ6IFBMVUdJTl9JRCwgaW5wdXQgfSk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0gRmFpbGVkIHRvIHNhdmUgc2V0dGluZ3M6XCIsIGUpO1xuICAgIGZvciAoY29uc3Qga2V5IG9mIGtleXMpIHVuc2F2ZWQuYWRkKGtleSk7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbi8qKiBVcGRhdGUgc2V0dGluZ3MgbG9jYWxseSByaWdodCBhd2F5IGFuZCBwZXJzaXN0IHRvIFN0YXNoIChkZWJvdW5jZWQsIGZvciBzbGlkZXJzKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiB1cGRhdGVTZXR0aW5ncyhwYXRjaDogUGFydGlhbDxTZXR0aW5ncz4pOiB2b2lkIHtcbiAgc3RhdGUuc2V0dGluZ3MgPSBub3JtYWxpemUoeyAuLi5zdGF0ZS5zZXR0aW5ncywgLi4ucGF0Y2ggfSwgc3RhdGUuc2V0dGluZ3MpO1xuICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhwYXRjaCkgYXMgKGtleW9mIFNldHRpbmdzKVtdKSB1bnNhdmVkLmFkZChrZXkpO1xuICBpZiAoc2F2ZVRpbWVyKSBjbGVhclRpbWVvdXQoc2F2ZVRpbWVyKTtcbiAgc2F2ZVRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgc2F2ZVRpbWVyID0gbnVsbDtcbiAgICB2b2lkIHBlcnNpc3RTZXR0aW5ncygpO1xuICB9LCBTQVZFX0RFQk9VTkNFX01TKTtcbn1cblxuLyoqIFVwZGF0ZSBzZXR0aW5ncyBhbmQgc2F2ZSB0byBTdGFzaCByaWdodCBhd2F5IChubyBkZWJvdW5jZSkuIFJlc29sdmVzIGZhbHNlIGlmIHNhdmluZyBmYWlsZWQuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdXBkYXRlU2V0dGluZ3NOb3cocGF0Y2g6IFBhcnRpYWw8U2V0dGluZ3M+KTogUHJvbWlzZTxib29sZWFuPiB7XG4gIHN0YXRlLnNldHRpbmdzID0gbm9ybWFsaXplKHsgLi4uc3RhdGUuc2V0dGluZ3MsIC4uLnBhdGNoIH0sIHN0YXRlLnNldHRpbmdzKTtcbiAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXMocGF0Y2gpIGFzIChrZXlvZiBTZXR0aW5ncylbXSkgdW5zYXZlZC5hZGQoa2V5KTtcbiAgaWYgKHNhdmVUaW1lcikge1xuICAgIGNsZWFyVGltZW91dChzYXZlVGltZXIpO1xuICAgIHNhdmVUaW1lciA9IG51bGw7XG4gIH1cbiAgcmV0dXJuIHBlcnNpc3RTZXR0aW5ncygpO1xufVxuIiwgIi8vIFBlcnNpc3QvcmVzdG9yZSB0aGUgYmF0dGxlIHNlc3Npb24gdG8gbG9jYWxTdG9yYWdlLlxuXG5pbXBvcnQgeyBTVE9SQUdFX0tFWSB9IGZyb20gXCIuL2NvbnN0YW50c1wiO1xuaW1wb3J0IHsgc3RhdGUgfSBmcm9tIFwiLi9zdGF0ZVwiO1xuaW1wb3J0IHR5cGUgeyBNb2RlLCBQYWlyLCBQbGFjZW1lbnRSdW4sIFJhbmtzLCBTY2VuZSB9IGZyb20gXCIuL3R5cGVzXCI7XG5cbi8qKlxuICogQnVtcGVkIHdoZW4gc2F2ZWQgc2Vzc2lvbnMgY2FuJ3QgYmUgcmVzdG9yZWQgYXMgdGhleSBhcmUuIDMgKDMuMCk6IHNjZW5lcyBhcmUgcmFua2VkIGJ5IEVMT1xuICogZnJvbSBjdXN0b20gZmllbGRzLCB3aGljaCBvbGRlciBzYXZlZCBzY2VuZXMgbGFjaywgYW5kIEdhdW50bGV0IHJ1bnMgbm8gbG9uZ2VyIGV4aXN0LlxuICovXG5jb25zdCBTVEFURV9WRVJTSU9OID0gMztcblxuY29uc3QgTU9ERVM6IHJlYWRvbmx5IE1vZGVbXSA9IFtcInN3aXNzXCIsIFwicGxhY2VtZW50XCIsIFwiY2hhbXBpb25cIl07XG5cbmludGVyZmFjZSBQZXJzaXN0ZWRTdGF0ZSB7XG4gIHZlcnNpb24/OiBudW1iZXI7XG4gIGN1cnJlbnRQYWlyPzogUGFpcjtcbiAgY3VycmVudFJhbmtzPzogUmFua3M7XG4gIGN1cnJlbnRNb2RlPzogc3RyaW5nO1xuICBjaGFtcGlvblNjZW5lPzogU2NlbmUgfCBudWxsO1xuICBjaGFtcGlvbldpbnM/OiBudW1iZXI7XG4gIGNoYW1waW9uRGVmZWF0ZWQ/OiBzdHJpbmdbXTtcbiAgcGxhY2VtZW50PzogUGxhY2VtZW50UnVuIHwgbnVsbDtcbiAgdG90YWxTY2VuZXNDb3VudD86IG51bWJlcjtcbiAgc2F2ZWRGaWx0ZXJQYXJhbXM/OiBzdHJpbmc7XG59XG5cbi8qKiBBIHNhdmVkIG1vZGUgbmFtZSBhcyBhIGN1cnJlbnQgbW9kZTogR2F1bnRsZXQgYmVjYW1lIFBsYWNlbWVudCdzIFwiU3RhcnQgZnJvbSB0aGUgYm90dG9tXCIuICovXG5mdW5jdGlvbiByZXN0b3JlTW9kZShzYXZlZDogc3RyaW5nIHwgdW5kZWZpbmVkKTogTW9kZSB7XG4gIGlmIChzYXZlZCA9PT0gXCJnYXVudGxldFwiKSByZXR1cm4gXCJwbGFjZW1lbnRcIjtcbiAgcmV0dXJuIE1PREVTLmluY2x1ZGVzKHNhdmVkIGFzIE1vZGUpID8gKHNhdmVkIGFzIE1vZGUpIDogXCJzd2lzc1wiO1xufVxuXG4vKiogU2F2ZXMgdGhlIGN1cnJlbnQgYmF0dGxlIHNlc3Npb24gdG8gbG9jYWxTdG9yYWdlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNhdmVTdGF0ZSgpOiB2b2lkIHtcbiAgY29uc3Qgc25hcHNob3Q6IFBlcnNpc3RlZFN0YXRlID0ge1xuICAgIHZlcnNpb246IFNUQVRFX1ZFUlNJT04sXG4gICAgY3VycmVudFBhaXI6IHN0YXRlLmN1cnJlbnRQYWlyLFxuICAgIGN1cnJlbnRSYW5rczogc3RhdGUuY3VycmVudFJhbmtzLFxuICAgIGN1cnJlbnRNb2RlOiBzdGF0ZS5jdXJyZW50TW9kZSxcbiAgICBjaGFtcGlvblNjZW5lOiBzdGF0ZS5jaGFtcGlvblNjZW5lLFxuICAgIGNoYW1waW9uV2luczogc3RhdGUuY2hhbXBpb25XaW5zLFxuICAgIGNoYW1waW9uRGVmZWF0ZWQ6IHN0YXRlLmNoYW1waW9uRGVmZWF0ZWQsXG4gICAgcGxhY2VtZW50OiBzdGF0ZS5wbGFjZW1lbnQsXG4gICAgdG90YWxTY2VuZXNDb3VudDogc3RhdGUudG90YWxTY2VuZXNDb3VudCxcbiAgICBzYXZlZEZpbHRlclBhcmFtczogd2luZG93LmxvY2F0aW9uLnNlYXJjaCxcbiAgfTtcbiAgdHJ5IHtcbiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShTVE9SQUdFX0tFWSwgSlNPTi5zdHJpbmdpZnkoc25hcHNob3QpKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnNvbGUuZXJyb3IoXCJbU3Rhc2ggQmF0dGxlXSBGYWlsZWQgdG8gc2F2ZSBzdGF0ZTpcIiwgZSk7XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGxvYWRTdGF0ZSgpOiBib29sZWFuIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBzYXZlZCA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFNUT1JBR0VfS0VZKTtcbiAgICBpZiAoc2F2ZWQpIHtcbiAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2Uoc2F2ZWQpIGFzIFBlcnNpc3RlZFN0YXRlO1xuICAgICAgc3RhdGUuY3VycmVudE1vZGUgPSByZXN0b3JlTW9kZShwYXJzZWQuY3VycmVudE1vZGUpO1xuICAgICAgc3RhdGUuc2F2ZWRGaWx0ZXJQYXJhbXMgPSBwYXJzZWQuc2F2ZWRGaWx0ZXJQYXJhbXMgfHwgXCJcIjtcbiAgICAgIGlmIChwYXJzZWQudmVyc2lvbiAhPT0gU1RBVEVfVkVSU0lPTikge1xuICAgICAgICAvLyBPbGRlciBzZXNzaW9ucyBob2xkIHNjZW5lcyB3aXRob3V0IEVMTzoga2VlcCB0aGUgbW9kZSwgc3RhcnQgYSBmcmVzaCBwYWlyIGFuZCBydW5cbiAgICAgICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5OLIFNhdmVkIHNlc3Npb24gaXMgZnJvbSBhbiBvbGRlciB2ZXJzaW9uLCBzdGFydGluZyBmcmVzaFwiKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9XG4gICAgICBzdGF0ZS5jdXJyZW50UGFpciA9IHBhcnNlZC5jdXJyZW50UGFpciB8fCB7IGxlZnQ6IG51bGwsIHJpZ2h0OiBudWxsIH07XG4gICAgICBzdGF0ZS5jdXJyZW50UmFua3MgPSBwYXJzZWQuY3VycmVudFJhbmtzIHx8IHsgbGVmdDogbnVsbCwgcmlnaHQ6IG51bGwgfTtcbiAgICAgIHN0YXRlLmNoYW1waW9uU2NlbmUgPSBwYXJzZWQuY2hhbXBpb25TY2VuZSA/PyBudWxsO1xuICAgICAgc3RhdGUuY2hhbXBpb25XaW5zID0gcGFyc2VkLmNoYW1waW9uV2lucyB8fCAwO1xuICAgICAgc3RhdGUuY2hhbXBpb25EZWZlYXRlZCA9IHBhcnNlZC5jaGFtcGlvbkRlZmVhdGVkIHx8IFtdO1xuICAgICAgc3RhdGUucGxhY2VtZW50ID0gcGFyc2VkLnBsYWNlbWVudCB8fCBudWxsO1xuICAgICAgc3RhdGUudG90YWxTY2VuZXNDb3VudCA9IHBhcnNlZC50b3RhbFNjZW5lc0NvdW50IHx8IDA7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0gRmFpbGVkIHRvIGxvYWQgc3RhdGU6XCIsIGUpO1xuICB9XG4gIHJldHVybiBmYWxzZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNsZWFyU3RhdGUoKTogdm9pZCB7XG4gIHRyeSB7XG4gICAgbG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oU1RPUkFHRV9LRVkpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIEZhaWxlZCB0byBjbGVhciBzdGF0ZTpcIiwgZSk7XG4gIH1cbn1cbiIsICIvLyBBIHNtYWxsIGNvbmZpcm1hdGlvbiBkaWFsb2cgaW5zaWRlIHRoZSBTdGFzaCBCYXR0bGUgbW9kYWwgKHN3aXRjaGluZyBTdGFzaCByYXRpbmdzLCBSZXNldCBFTE8pLlxuLy8gVGhlIGNvbmZpcm0gYnV0dG9uIGNhbiBydW4gYW4gYXN5bmMgYWN0aW9uOiB0aGUgZGlhbG9nIHN0YXlzIG9wZW4gd2hpbGUgaXQgcnVucywgY2xvc2VzIHdoZW5cbi8vIGl0IHN1Y2NlZWRzLCBhbmQgc2hvd3MgdGhlIGVycm9yIGlmIGl0IGZhaWxzLlxuXG5leHBvcnQgaW50ZXJmYWNlIENvbmZpcm1EaWFsb2dPcHRpb25zIHtcbiAgdGl0bGU6IHN0cmluZztcbiAgLyoqIEhUTUwgYm9keS4gKi9cbiAgYm9keTogc3RyaW5nO1xuICBjb25maXJtTGFiZWw6IHN0cmluZztcbiAgLyoqIExhYmVsIG9uIHRoZSBjb25maXJtIGJ1dHRvbiB3aGlsZSBgYWN0aW9uYCBydW5zLiAqL1xuICB3b3JraW5nTGFiZWw/OiBzdHJpbmc7XG4gIC8qKiBSdW5zIG9uIGNvbmZpcm07IHRoZSBkaWFsb2cgcmVzb2x2ZXMgdHJ1ZSBvbmx5IG9uY2UgaXQgc3VjY2VlZHMuICovXG4gIGFjdGlvbj86ICgpID0+IFByb21pc2U8dm9pZD47XG59XG5cbmxldCBjYW5jZWxPcGVuOiAoKCkgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcblxuZXhwb3J0IGZ1bmN0aW9uIGlzQ29uZmlybURpYWxvZ09wZW4oKTogYm9vbGVhbiB7XG4gIHJldHVybiBjYW5jZWxPcGVuICE9PSBudWxsO1xufVxuXG4vKiogQ2FuY2VsIHRoZSBvcGVuIGRpYWxvZyAoRXNjYXBlKSwgdW5sZXNzIGl0cyBhY3Rpb24gaXMgcnVubmluZy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjYW5jZWxDb25maXJtRGlhbG9nKCk6IHZvaWQge1xuICBjYW5jZWxPcGVuPy4oKTtcbn1cblxuLyoqIFNob3cgdGhlIGRpYWxvZzsgcmVzb2x2ZXMgdHJ1ZSB3aGVuIGNvbmZpcm1lZCAoYW5kIGl0cyBhY3Rpb24gc3VjY2VlZGVkKSwgZmFsc2Ugd2hlbiBjYW5jZWxsZWQuICovXG5leHBvcnQgZnVuY3Rpb24gY29uZmlybURpYWxvZyhvcHRzOiBDb25maXJtRGlhbG9nT3B0aW9ucyk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBjYW5jZWxPcGVuPy4oKTtcbiAgY29uc3QgaG9zdCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic2ItbW9kYWxcIik7XG4gIGlmICghaG9zdCkgcmV0dXJuIFByb21pc2UucmVzb2x2ZShmYWxzZSk7XG5cbiAgY29uc3Qgb3ZlcmxheSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIG92ZXJsYXkuY2xhc3NOYW1lID0gXCJzYi1kaWFsb2ctYmFja2Ryb3BcIjtcbiAgb3ZlcmxheS5pbm5lckhUTUwgPSBgXG4gICAgICA8ZGl2IGNsYXNzPVwic2ItZGlhbG9nXCIgcm9sZT1cImRpYWxvZ1wiIGFyaWEtbW9kYWw9XCJ0cnVlXCIgYXJpYS1sYWJlbGxlZGJ5PVwic2ItZGlhbG9nLXRpdGxlXCI+XG4gICAgICAgIDxoMyBpZD1cInNiLWRpYWxvZy10aXRsZVwiIGNsYXNzPVwic2ItZGlhbG9nLXRpdGxlXCI+JHtvcHRzLnRpdGxlfTwvaDM+XG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi1kaWFsb2ctYm9keVwiPiR7b3B0cy5ib2R5fTwvZGl2PlxuICAgICAgICA8cCBjbGFzcz1cInNiLWRpYWxvZy1lcnJvclwiIGhpZGRlbj48L3A+XG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi1kaWFsb2ctYWN0aW9uc1wiPlxuICAgICAgICAgIDxidXR0b24gdHlwZT1cImJ1dHRvblwiIGNsYXNzPVwiYnRuIGJ0bi1zZWNvbmRhcnlcIiBkYXRhLXJvbGU9XCJjYW5jZWxcIj5DYW5jZWw8L2J1dHRvbj5cbiAgICAgICAgICA8YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cImJ0biBidG4tcHJpbWFyeVwiIGRhdGEtcm9sZT1cImNvbmZpcm1cIj4ke29wdHMuY29uZmlybUxhYmVsfTwvYnV0dG9uPlxuICAgICAgICA8L2Rpdj5cbiAgICAgIDwvZGl2PmA7XG4gIGhvc3QuYXBwZW5kQ2hpbGQob3ZlcmxheSk7XG5cbiAgY29uc3QgY29uZmlybUJ0biA9IG92ZXJsYXkucXVlcnlTZWxlY3RvcjxIVE1MQnV0dG9uRWxlbWVudD4oJ1tkYXRhLXJvbGU9XCJjb25maXJtXCJdJykgYXMgSFRNTEJ1dHRvbkVsZW1lbnQ7XG4gIGNvbnN0IGNhbmNlbEJ0biA9IG92ZXJsYXkucXVlcnlTZWxlY3RvcjxIVE1MQnV0dG9uRWxlbWVudD4oJ1tkYXRhLXJvbGU9XCJjYW5jZWxcIl0nKSBhcyBIVE1MQnV0dG9uRWxlbWVudDtcbiAgY29uc3QgZXJyb3IgPSBvdmVybGF5LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiLnNiLWRpYWxvZy1lcnJvclwiKSBhcyBIVE1MRWxlbWVudDtcbiAgY29uZmlybUJ0bi5mb2N1cygpO1xuXG4gIHJldHVybiBuZXcgUHJvbWlzZTxib29sZWFuPigocmVzb2x2ZSkgPT4ge1xuICAgIGxldCBidXN5ID0gZmFsc2U7XG4gICAgY29uc3QgY2xvc2UgPSAocmVzdWx0OiBib29sZWFuKTogdm9pZCA9PiB7XG4gICAgICBvdmVybGF5LnJlbW92ZSgpO1xuICAgICAgY2FuY2VsT3BlbiA9IG51bGw7XG4gICAgICByZXNvbHZlKHJlc3VsdCk7XG4gICAgfTtcbiAgICBjYW5jZWxPcGVuID0gKCkgPT4ge1xuICAgICAgaWYgKCFidXN5KSBjbG9zZShmYWxzZSk7XG4gICAgfTtcblxuICAgIGNhbmNlbEJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4gY2FuY2VsT3Blbj8uKCkpO1xuICAgIG92ZXJsYXkuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XG4gICAgICBpZiAoZS50YXJnZXQgPT09IG92ZXJsYXkpIGNhbmNlbE9wZW4/LigpO1xuICAgIH0pO1xuICAgIGNvbmZpcm1CdG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIGFzeW5jICgpID0+IHtcbiAgICAgIGlmICghb3B0cy5hY3Rpb24pIHtcbiAgICAgICAgY2xvc2UodHJ1ZSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGJ1c3kgPSB0cnVlO1xuICAgICAgZXJyb3IuaGlkZGVuID0gdHJ1ZTtcbiAgICAgIGNvbmZpcm1CdG4uZGlzYWJsZWQgPSBjYW5jZWxCdG4uZGlzYWJsZWQgPSB0cnVlO1xuICAgICAgY29uZmlybUJ0bi50ZXh0Q29udGVudCA9IG9wdHMud29ya2luZ0xhYmVsID8/IFwiV29ya2luZy4uLlwiO1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgb3B0cy5hY3Rpb24oKTtcbiAgICAgICAgY2xvc2UodHJ1ZSk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGJ1c3kgPSBmYWxzZTtcbiAgICAgICAgY29uZmlybUJ0bi5kaXNhYmxlZCA9IGNhbmNlbEJ0bi5kaXNhYmxlZCA9IGZhbHNlO1xuICAgICAgICBjb25maXJtQnRuLnRleHRDb250ZW50ID0gb3B0cy5jb25maXJtTGFiZWw7XG4gICAgICAgIGVycm9yLnRleHRDb250ZW50ID0gYFRoYXQgZGlkbid0IHdvcms6ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfS4gWW91IGNhbiB0cnkgYWdhaW4uYDtcbiAgICAgICAgZXJyb3IuaGlkZGVuID0gZmFsc2U7XG4gICAgICB9XG4gICAgfSk7XG4gIH0pO1xufVxuIiwgIi8vIFNQQSBuYXZpZ2F0aW9uIGhlbHBlcnMuXHJcblxyXG5pbXBvcnQgeyBjbG9zZU1vZGFsIH0gZnJvbSBcIi4vdWkvbW9kYWxcIjtcclxuXHJcbi8vIE5hdmlnYXRlIHVzaW5nIFJlYWN0IFJvdXRlciAocHJlc2VydmVzIEpTIHN0YXRlKVxyXG5leHBvcnQgZnVuY3Rpb24gbmF2aWdhdGVUb1VybCh1cmw6IHN0cmluZyk6IHZvaWQge1xyXG4gIGNsb3NlTW9kYWwoKTtcclxuXHJcbiAgLy8gVXNlIEhpc3RvcnkgQVBJICsgcG9wc3RhdGUgZXZlbnQgdG8gdHJpZ2dlciBSZWFjdCBSb3V0ZXIgbmF2aWdhdGlvblxyXG4gIGNvbnN0IHBhdGggPSB1cmwuc3RhcnRzV2l0aChcIi9cIikgPyB1cmwgOiBuZXcgVVJMKHVybCkucGF0aG5hbWUgKyBuZXcgVVJMKHVybCkuc2VhcmNoO1xyXG4gIHdpbmRvdy5oaXN0b3J5LnB1c2hTdGF0ZSh7fSwgXCJcIiwgcGF0aCk7XHJcbiAgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IFBvcFN0YXRlRXZlbnQoXCJwb3BzdGF0ZVwiLCB7IHN0YXRlOiB7fSB9KSk7XHJcbn1cclxuIiwgIi8vIFBsYWNlbWVudCBzZWFyY2gsIGtlcHQgcHVyZSAobm8gc3RhdGUgb3IgSS9PKSBzbyB3aG9sZSBydW5zIGNhbiBiZSBzaW11bGF0ZWQgaW4gdGVzdHMuXG4vL1xuLy8gVGhlIHNjZW5lJ3Mgc2xvdCBsaWVzIGluIFtsbywgaGkpIG9mIHRoZSBFTE8tc29ydGVkIG9wcG9uZW50IHBvb2wuIEEgd2luIGFnYWluc3QgaW5kZXggaVxuLy8gbWVhbnMgdGhlIHNsb3QgaXMgYWJvdmUgaSAoaGkgPSBpKTsgYSBsb3NzIG1lYW5zIGl0J3MgYmVsb3cgKGxvID0gaSArIDEpLiBBIHJhdGVkIHNjZW5lIHN0YXJ0c1xuLy8gbmV4dCB0byBpdHMgY3VycmVudCBFTE8gYW5kIGdhbGxvcHMgKHN0ZXBzIDEsIDIsIDQsIDguLi4pIHdoaWxlIHJlc3VsdHMga2VlcCBnb2luZyB0aGUgc2FtZVxuLy8gd2F5OyB0aGUgZmlyc3QgcmV2ZXJzYWwgKG9yIGFuIHVucmF0ZWQgc2NlbmUpIHN3aXRjaGVzIHRvIGhhbHZpbmcgdGhlIHJlbWFpbmluZyByYW5nZS5cbi8vIFwiU3RhcnQgZnJvbSB0aGUgYm90dG9tXCIgcnVucyBpZ25vcmUgdGhlIHNjZW5lJ3MgRUxPOiB0aGV5IHN0YXJ0IGFnYWluc3QgdGhlIGJvdHRvbSBzY2VuZSBhbmRcbi8vIGdhbGxvcCB1cHdhcmQsIHNvIGVhY2ggd2luIGRvdWJsZXMgdGhlIGp1bXAgdW50aWwgdGhlIGZpcnN0IGxvc3MuXG5cbmltcG9ydCB7IFBMQUNFTUVOVF9NQVhfSlVNUF9TSEFSRSwgUExBQ0VNRU5UX01JTl9NQVhfSlVNUCB9IGZyb20gXCIuL2NvbnN0YW50c1wiO1xuaW1wb3J0IHsgZWxvLCBlbG9JbnNlcnRpb25JbmRleCwgcGxhY2VtZW50RWxvIH0gZnJvbSBcIi4vc2NvcmVcIjtcbmltcG9ydCB0eXBlIHsgUGxhY2VtZW50UnVuLCBTY2VuZSB9IGZyb20gXCIuL3R5cGVzXCI7XG5cbmV4cG9ydCBmdW5jdGlvbiBuZXdQbGFjZW1lbnRSdW4oc2NlbmU6IFNjZW5lLCBmcm9tQm90dG9tOiBib29sZWFuKTogUGxhY2VtZW50UnVuIHtcbiAgcmV0dXJuIHtcbiAgICBzY2VuZSxcbiAgICBmcm9tQm90dG9tLFxuICAgIGFib3ZlSWQ6IG51bGwsXG4gICAgYmVsb3dJZDogbnVsbCxcbiAgICBsYXN0T3Bwb25lbnRJZDogbnVsbCxcbiAgICBsYXN0V29uOiBudWxsLFxuICAgIGdhbGxvcGluZzogZnJvbUJvdHRvbSB8fCBlbG8oc2NlbmUpICE9PSBudWxsLFxuICAgIHN0ZXA6IDEsXG4gICAgYmF0dGxlczogMCxcbiAgICBzdHJlYWs6IDAsXG4gICAgcmFuZ2VMbzogMCxcbiAgICByYW5nZUhpOiAwLFxuICB9O1xufVxuXG4vKiogSW5kZXggb2YgdGhlIGVuZCBvZiBwb29sW2lkeF0ncyB0aWUgZ3JvdXAgKHNjZW5lcyB3aXRoIHRoZSBzYW1lIEVMTykgaW4gZGlyZWN0aW9uIGBkaXJgLiAqL1xuZnVuY3Rpb24gdGllR3JvdXBFZGdlKHBvb2w6IFNjZW5lW10sIGlkeDogbnVtYmVyLCBkaXI6IDEgfCAtMSk6IG51bWJlciB7XG4gIGNvbnN0IHZhbHVlID0gZWxvKHBvb2xbaWR4XSk7XG4gIGxldCBlZGdlID0gaWR4O1xuICB3aGlsZSAoZWRnZSArIGRpciA+PSAwICYmIGVkZ2UgKyBkaXIgPCBwb29sLmxlbmd0aCAmJiBlbG8ocG9vbFtlZGdlICsgZGlyXSkgPT09IHZhbHVlKSBlZGdlICs9IGRpcjtcbiAgcmV0dXJuIGVkZ2U7XG59XG5cbi8qKlxuICogQ3VycmVudCBbbG8sIGhpKSBzbG90IGJvdW5kcywgcmVzb2x2ZWQgZnJvbSB0aGUgYm91bmRpbmcgb3Bwb25lbnRzJyBpZHMuIEEgcmVzdWx0IGNvdW50cyBmb3JcbiAqIHRoZSBvcHBvbmVudCdzIHdob2xlIHRpZSBncm91cDogYSBzY2VuZSBjYW4gb25seSBnZXQgYW4gRUxPIGFib3ZlIG9yIGJlbG93IGEgZ3JvdXAgb2YgZXF1YWxcbiAqIEVMT3MsIG5vdCBpbnNpZGUgaXQsIHNvIHRoZSBzbG90IGFsd2F5cyBlbmRzIGF0IGEgZ3JvdXAncyBlZGdlIGFuZCB0aGUgbGFuZGluZyBFTE8ga2VlcHMgaXQgdGhlcmUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwbGFjZW1lbnRCb3VuZHMocnVuOiBQbGFjZW1lbnRSdW4sIHBvb2w6IFNjZW5lW10pOiB7IGxvOiBudW1iZXI7IGhpOiBudW1iZXIgfSB7XG4gIGNvbnN0IGFib3ZlSWR4ID0gcnVuLmFib3ZlSWQgPyBwb29sLmZpbmRJbmRleCgocykgPT4gcy5pZCA9PT0gcnVuLmFib3ZlSWQpIDogLTE7XG4gIGNvbnN0IGJlbG93SWR4ID0gcnVuLmJlbG93SWQgPyBwb29sLmZpbmRJbmRleCgocykgPT4gcy5pZCA9PT0gcnVuLmJlbG93SWQpIDogLTE7XG4gIHJldHVybiB7XG4gICAgbG86IGFib3ZlSWR4ID49IDAgPyB0aWVHcm91cEVkZ2UocG9vbCwgYWJvdmVJZHgsIDEpICsgMSA6IDAsXG4gICAgaGk6IGJlbG93SWR4ID49IDAgPyB0aWVHcm91cEVkZ2UocG9vbCwgYmVsb3dJZHgsIC0xKSA6IHBvb2wubGVuZ3RoLFxuICB9O1xufVxuXG4vKiogVGhlIHBvb2wncyBsb3dlc3Qgc2NlbmUgd2l0aCBhbiBFTE8gKHVucmF0ZWQgb25lcyBzb3J0IGxhc3QpLCBvciBpdHMgbGFzdCBzY2VuZSBpZiBub25lIGhhcyBvbmUuICovXG5leHBvcnQgZnVuY3Rpb24gYm90dG9tSW5kZXgocG9vbDogU2NlbmVbXSk6IG51bWJlciB7XG4gIGZvciAobGV0IGkgPSBwb29sLmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7XG4gICAgaWYgKGVsbyhwb29sW2ldKSAhPT0gbnVsbCkgcmV0dXJuIGk7XG4gIH1cbiAgcmV0dXJuIHBvb2wubGVuZ3RoIC0gMTtcbn1cblxuLyoqIExhcmdlc3QganVtcCBhIGdhbGxvcGluZyBydW4gbWFrZXMgaW4gdGhpcyBwb29sIChzZWUgUExBQ0VNRU5UX01BWF9KVU1QX1NIQVJFKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtYXhQbGFjZW1lbnRKdW1wKHBvb2xTaXplOiBudW1iZXIpOiBudW1iZXIge1xuICByZXR1cm4gTWF0aC5tYXgoUExBQ0VNRU5UX01JTl9NQVhfSlVNUCwgTWF0aC5yb3VuZChwb29sU2l6ZSAqIFBMQUNFTUVOVF9NQVhfSlVNUF9TSEFSRSkpO1xufVxuXG4vKiogV2hlcmUgdGhlIG5leHQgb3Bwb25lbnQgc2hvdWxkIGNvbWUgZnJvbSAoYmVmb3JlIGNsYW1waW5nIGludG8gW2xvLCBoaSkpLiAqL1xuZnVuY3Rpb24gbmV4dFBsYWNlbWVudEluZGV4KHJ1bjogUGxhY2VtZW50UnVuLCBwb29sOiBTY2VuZVtdLCBsbzogbnVtYmVyLCBoaTogbnVtYmVyKTogbnVtYmVyIHtcbiAgaWYgKHJ1bi5nYWxsb3BpbmcpIHtcbiAgICBpZiAocnVuLmxhc3RPcHBvbmVudElkID09PSBudWxsKSB7XG4gICAgICBpZiAocnVuLmZyb21Cb3R0b20pIHJldHVybiBib3R0b21JbmRleChwb29sKTtcbiAgICAgIC8vIFN0YXJ0IGp1c3QgYmVsb3cgdGhlIHNjZW5lJ3MgY3VycmVudCBFTE86IGEgY29ycmVjdGx5IHJhdGVkIHNjZW5lIGNvbmZpcm1zIGluIH4yIGJhdHRsZXNcbiAgICAgIHJldHVybiBlbG9JbnNlcnRpb25JbmRleChwb29sLCBlbG8ocnVuLnNjZW5lKSA/PyAwKTtcbiAgICB9XG4gICAgY29uc3QgbGFzdElkeCA9IHBvb2wuZmluZEluZGV4KChzKSA9PiBzLmlkID09PSBydW4ubGFzdE9wcG9uZW50SWQpO1xuICAgIGlmIChsYXN0SWR4ID49IDApIHtcbiAgICAgIC8vIFN0ZXAgZnJvbSB0aGUgZmFyIGVkZ2Ugb2YgdGhlIGxhc3Qgb3Bwb25lbnQncyB0aWUgZ3JvdXA6IGFub3RoZXIgZXF1YWwgRUxPIHRlYWNoZXMgbm90aGluZ1xuICAgICAgY29uc3QgZGlyID0gcnVuLmxhc3RXb24gPyAtMSA6IDE7XG4gICAgICBjb25zdCB0YXJnZXQgPSB0aWVHcm91cEVkZ2UocG9vbCwgbGFzdElkeCwgZGlyKSArIGRpciAqIE1hdGgubWluKHJ1bi5zdGVwLCBtYXhQbGFjZW1lbnRKdW1wKHBvb2wubGVuZ3RoKSk7XG4gICAgICAvLyBBIGp1bXAgcGFzdCB0aGUgc2VhcmNoIHJhbmdlIHdvdWxkIGxhbmQgb24gaXRzIGVuZCAoc3RyYWlnaHQgdG8gIzEsIHNheSk6IGhhbHZlIGluc3RlYWRcbiAgICAgIGlmICh0YXJnZXQgPj0gbG8gJiYgdGFyZ2V0IDwgaGkpIHJldHVybiB0YXJnZXQ7XG4gICAgfVxuICB9XG4gIHJldHVybiBsbyArIE1hdGguZmxvb3IoKGhpIC0gbG8pIC8gMik7XG59XG5cbmV4cG9ydCB0eXBlIFBsYWNlbWVudFN0ZXAgPVxuICB8IHsgZG9uZTogdHJ1ZTsgc2xvdDogbnVtYmVyOyBsbzogbnVtYmVyOyBoaTogbnVtYmVyIH1cbiAgfCB7IGRvbmU6IGZhbHNlOyBpbmRleDogbnVtYmVyOyBsbzogbnVtYmVyOyBoaTogbnVtYmVyIH07XG5cbi8qKiBUaGUgcnVuJ3MgbmV4dCBzdGVwIG9uIHRoaXMgcG9vbDogdGhlIG9wcG9uZW50IGluZGV4IHRvIGJhdHRsZSwgb3IgdGhlIHNsb3QgaXQgaGFzIGxhbmRlZCBpbi4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwbGFjZW1lbnRTdGVwKHJ1bjogUGxhY2VtZW50UnVuLCBwb29sOiBTY2VuZVtdKTogUGxhY2VtZW50U3RlcCB7XG4gIGNvbnN0IHsgbG8sIGhpIH0gPSBwbGFjZW1lbnRCb3VuZHMocnVuLCBwb29sKTtcbiAgaWYgKGxvID49IGhpKSByZXR1cm4geyBkb25lOiB0cnVlLCBzbG90OiBNYXRoLm1pbihsbywgaGkpLCBsbywgaGkgfTtcbiAgY29uc3QgaW5kZXggPSBNYXRoLm1heChsbywgTWF0aC5taW4oaGkgLSAxLCBuZXh0UGxhY2VtZW50SW5kZXgocnVuLCBwb29sLCBsbywgaGkpKSk7XG4gIHJldHVybiB7IGRvbmU6IGZhbHNlLCBpbmRleCwgbG8sIGhpIH07XG59XG5cbi8qKiBSZWNvcmQgYSBwbGFjZW1lbnQgYmF0dGxlIHJlc3VsdCBhbmQgdXBkYXRlIHRoZSBtb21lbnR1bSBhbmQgdGhlIHdpbiBzdHJlYWsuICovXG5leHBvcnQgZnVuY3Rpb24gcmVjb3JkUGxhY2VtZW50UmVzdWx0KHJ1bjogUGxhY2VtZW50UnVuLCB3b246IGJvb2xlYW4sIG9wcG9uZW50SWQ6IHN0cmluZyk6IHZvaWQge1xuICBpZiAocnVuLmxhc3RXb24gIT09IG51bGwpIHtcbiAgICBpZiAocnVuLmxhc3RXb24gPT09IHdvbikgcnVuLnN0ZXAgKj0gMjtcbiAgICBlbHNlIHJ1bi5nYWxsb3BpbmcgPSBmYWxzZTtcbiAgfVxuICBpZiAod29uKSBydW4uYmVsb3dJZCA9IG9wcG9uZW50SWQ7XG4gIGVsc2UgcnVuLmFib3ZlSWQgPSBvcHBvbmVudElkO1xuXG4gIC8vIFRoZSBzdHJlYWsgY291bnRzIHdpbnMgdW50aWwgdGhlIGZpcnN0IGxvc3MsIHNvIGl0IG9ubHkgZ3Jvd3Mgd2hpbGUgZXZlcnkgYmF0dGxlIHdhcyBhIHdpblxuICBpZiAod29uICYmIHJ1bi5zdHJlYWsgPT09IHJ1bi5iYXR0bGVzKSBydW4uc3RyZWFrKys7XG4gIHJ1bi5sYXN0T3Bwb25lbnRJZCA9IG9wcG9uZW50SWQ7XG4gIHJ1bi5sYXN0V29uID0gd29uO1xuICBydW4uYmF0dGxlcysrO1xufVxuXG4vKipcbiAqIEVMTyBmb3IgYSBzY2VuZSBsYW5kaW5nIGF0IGBzbG90YCBvZiB0aGUgcG9vbDogYmV0d2VlbiB0aGUgbmVhcmVzdCBuZWlnaGJvdXJzIHRoYXQgaGF2ZSBhbiBFTE9cbiAqICh1bnJhdGVkIG9wcG9uZW50cywgcG9zc2libGUgaW4gYSBmaWx0ZXJlZCBwb29sLCBzYXkgbm90aGluZyBhYm91dCBpdCkuIFNlZSBwbGFjZW1lbnRFbG8uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBsYW5kaW5nRWxvKHBvb2w6IFNjZW5lW10sIHNsb3Q6IG51bWJlcik6IG51bWJlciB7XG4gIGxldCBhYm92ZTogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG4gIGZvciAobGV0IGkgPSBzbG90IC0gMTsgaSA+PSAwICYmIGFib3ZlID09PSBudWxsOyBpLS0pIGFib3ZlID0gZWxvKHBvb2xbaV0pO1xuICBsZXQgYmVsb3c6IG51bWJlciB8IG51bGwgPSBudWxsO1xuICBmb3IgKGxldCBpID0gc2xvdDsgaSA8IHBvb2wubGVuZ3RoICYmIGJlbG93ID09PSBudWxsOyBpKyspIGJlbG93ID0gZWxvKHBvb2xbaV0pO1xuICByZXR1cm4gcGxhY2VtZW50RWxvKGFib3ZlLCBiZWxvdyk7XG59XG4iLCAiLy8gTWF0Y2htYWtpbmc6IGJ1aWxkIHRoZSBzY2VuZSBwYWlycyBmb3IgZWFjaCBjb21wYXJpc29uIG1vZGUuXG5cbmltcG9ydCB7IGNsZWFyRmlsdGVyZWRDYWNoZSwgZ2V0QWxsU2NlbmVzQ2FjaGVkLCBnZXRGaWx0ZXJlZFNjZW5lc0NhY2hlZCwgbGF0ZXN0U2NlbmUgfSBmcm9tIFwiLi9jYWNoZVwiO1xuaW1wb3J0IHtcbiAgQ0hBTVBJT05fVU5SQVRFRF9FTE8sXG4gIENMSU1CX09QUE9ORU5UX1BJQ0tfV0lORE9XLFxuICBTV0lTU19PUFBPTkVOVF9SRUFDSF9JTklUSUFMLFxuICBTV0lTU19PUFBPTkVOVF9SRUFDSF9NVUxUSVBMSUVSLFxufSBmcm9tIFwiLi9jb25zdGFudHNcIjtcbmltcG9ydCB7IHJlYWRGaWx0ZXJzLCB0eXBlIExpc3RGaWx0ZXJzIH0gZnJvbSBcIi4vZmlsdGVyc1wiO1xuaW1wb3J0IHsgbGFuZGluZ0VsbywgbmV3UGxhY2VtZW50UnVuLCBwbGFjZW1lbnRTdGVwIH0gZnJvbSBcIi4vcGxhY2VtZW50XCI7XG5pbXBvcnQgeyB3cml0ZUVsbyB9IGZyb20gXCIuL3JhdGluZ1wiO1xuaW1wb3J0IHsgYmF0dGxlcywgZWZmZWN0aXZlRWxvLCBlbG8sIGVsb0luc2VydGlvbkluZGV4LCBpc1JhdGVkIH0gZnJvbSBcIi4vc2NvcmVcIjtcbmltcG9ydCB7IHN0YXRlIH0gZnJvbSBcIi4vc3RhdGVcIjtcbmltcG9ydCB0eXBlIHsgQ2hhbXBpb25QYWlyUmVzdWx0LCBQbGFjZW1lbnRQYWlyUmVzdWx0LCBSYW5rLCBTY2VuZSwgU3dpc3NQYWlyUmVzdWx0IH0gZnJvbSBcIi4vdHlwZXNcIjtcblxuZnVuY3Rpb24gc2h1ZmZsZUFycmF5PFQ+KGFycmF5OiBUW10pOiBUW10ge1xuICBjb25zdCBzaHVmZmxlZCA9IFsuLi5hcnJheV07XG4gIGZvciAobGV0IGkgPSBzaHVmZmxlZC5sZW5ndGggLSAxOyBpID4gMDsgaS0tKSB7XG4gICAgY29uc3QgaiA9IE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSAqIChpICsgMSkpO1xuICAgIFtzaHVmZmxlZFtpXSwgc2h1ZmZsZWRbal1dID0gW3NodWZmbGVkW2pdLCBzaHVmZmxlZFtpXV07XG4gIH1cbiAgcmV0dXJuIHNodWZmbGVkO1xufVxuXG4vLyBUcmFjayBsYXN0IHNjZW5lIHRvIGF2b2lkIGltbWVkaWF0ZSByZXBlYXQgYWZ0ZXIgcmVzaHVmZmxlXG5sZXQgbGFzdFNob3duU2NlbmVJZDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cbi8qKiBUcnVlIG9uY2UgZXZlcnkgc2NlbmUgaW4gdGhlIGN1cnJlbnQgc2h1ZmZsZSBoYXMgYmVlbiBzaG93biAodGltZSB0byByZS1xdWVyeSB0aGUgZmlsdGVyKS4gKi9cbmZ1bmN0aW9uIGlzU2h1ZmZsZUN5Y2xlQ29tcGxldGUoZmlsdGVyS2V5OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIChcbiAgICBzdGF0ZS5zaHVmZmxlRmlsdGVyS2V5ID09PSBmaWx0ZXJLZXkgJiZcbiAgICBzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzLmxlbmd0aCA+IDAgJiZcbiAgICBzdGF0ZS5zaHVmZmxlSW5kZXggPj0gc3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lcy5sZW5ndGhcbiAgKTtcbn1cblxuLyoqIFJlc2h1ZmZsZSB0aGUgbGVmdCBwb29sIGZvciBhIG5ldyBwYXNzLCB3aXRob3V0IHNob3dpbmcgdGhlIHByZXZpb3VzIHBhc3MncyBsYXN0IHNjZW5lIGZpcnN0LiAqL1xuZnVuY3Rpb24gc3RhcnROZXdQYXNzKGxlZnRQb29sOiBTY2VuZVtdKTogdm9pZCB7XG4gIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+UgCBSZXNodWZmbGluZyAoY29tcGxldGVkIGZ1bGwgY3ljbGUpXCIpO1xuICBzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzID0gc2h1ZmZsZUFycmF5KGxlZnRQb29sKTtcbiAgc3RhdGUuc2h1ZmZsZUluZGV4ID0gMDtcblxuICBpZiAoXG4gICAgbGFzdFNob3duU2NlbmVJZCAmJlxuICAgIHN0YXRlLnNodWZmbGVkRmlsdGVyZWRTY2VuZXMubGVuZ3RoID4gMSAmJlxuICAgIHN0YXRlLnNodWZmbGVkRmlsdGVyZWRTY2VuZXNbMF0uaWQgPT09IGxhc3RTaG93blNjZW5lSWRcbiAgKSB7XG4gICAgY29uc3Qgc3dhcElkeCA9IDEgKyBNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkgKiAoc3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lcy5sZW5ndGggLSAxKSk7XG4gICAgW3N0YXRlLnNodWZmbGVkRmlsdGVyZWRTY2VuZXNbMF0sIHN0YXRlLnNodWZmbGVkRmlsdGVyZWRTY2VuZXNbc3dhcElkeF1dID0gW1xuICAgICAgc3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lc1tzd2FwSWR4XSxcbiAgICAgIHN0YXRlLnNodWZmbGVkRmlsdGVyZWRTY2VuZXNbMF0sXG4gICAgXTtcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCflIQgU3dhcHBlZCBmaXJzdCBzY2VuZSB0byBhdm9pZCByZXBlYXRcIik7XG4gIH1cbn1cblxuLyoqIE5leHQgbGVmdC1zaWRlIHNjZW5lIGZyb20gdGhlIHNodWZmbGVkIGxlZnQgcG9vbCAobm8gbmV0d29yayBmZXRjaCkuIFNjZW5lcyBzdGF5IGluIHRoZSBwb29sLiAqL1xuZnVuY3Rpb24gZ2V0TmV4dEZpbHRlcmVkU2NlbmUobGVmdFBvb2w6IFNjZW5lW10sIGZpbHRlcktleTogc3RyaW5nKTogU2NlbmUgfCBudWxsIHtcbiAgaWYgKGxlZnRQb29sLmxlbmd0aCA9PT0gMCkge1xuICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+PgSBGaWx0ZXJlZCBwb29sIGlzIGVtcHR5XCIpO1xuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgaWYgKGZpbHRlcktleSAhPT0gc3RhdGUuc2h1ZmZsZUZpbHRlcktleSB8fCBzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzLmxlbmd0aCA9PT0gMCkge1xuICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+UgCBTaHVmZmxpbmcgZmlsdGVyZWQgc2NlbmVzIChmaWx0ZXIgY2hhbmdlZCBvciBmaXJzdCBsb2FkKVwiKTtcbiAgICBzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzID0gc2h1ZmZsZUFycmF5KGxlZnRQb29sKTtcbiAgICBzdGF0ZS5zaHVmZmxlSW5kZXggPSAwO1xuICAgIHN0YXRlLnNodWZmbGVGaWx0ZXJLZXkgPSBmaWx0ZXJLZXk7XG4gICAgbGFzdFNob3duU2NlbmVJZCA9IG51bGw7XG4gIH1cblxuICBpZiAoc3RhdGUuc2h1ZmZsZUluZGV4ID49IHN0YXRlLnNodWZmbGVkRmlsdGVyZWRTY2VuZXMubGVuZ3RoKSB7XG4gICAgc3RhcnROZXdQYXNzKGxlZnRQb29sKTtcbiAgfVxuXG4gIGNvbnN0IHNodWZmbGVkID0gc3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lc1tzdGF0ZS5zaHVmZmxlSW5kZXhdO1xuICAvLyBUaGUgc2h1ZmZsZSBrZWVwcyBpdHMgcGFzcydzIHNjZW5lIG9iamVjdHM7IGEgYmFja2dyb3VuZCByZWZyZXNoIG1heSBoYXZlIHJlcGxhY2VkIHRoZW0gc2luY2VcbiAgY29uc3Qgc2NlbmUgPSBsZWZ0UG9vbC5maW5kKChzKSA9PiBzLmlkID09PSBzaHVmZmxlZC5pZCkgPz8gc2h1ZmZsZWQ7XG4gIHN0YXRlLnNodWZmbGVJbmRleCsrO1xuICBsYXN0U2hvd25TY2VuZUlkID0gc2NlbmUuaWQ7XG4gIGNvbnNvbGUubG9nKFxuICAgIGBbU3Rhc2ggQmF0dGxlXSDwn5ONIFBpY2tlZCBzY2VuZSAke3NjZW5lLmlkfSAoJHtzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzLmxlbmd0aCAtIHN0YXRlLnNodWZmbGVJbmRleH0gbGVmdCBpbiB0aGlzIHBhc3MpYCxcbiAgKTtcbiAgcmV0dXJuIHNjZW5lO1xufVxuXG4vKipcbiAqIE9wcG9uZW50cyAocmlnaHQgc2lkZSksIHNvcnRlZCBieSBFTE86IHNjZW5lcyB3aXRoIGFuIEVMTywgb3IgdGhlIGZpbHRlcmVkIHNjZW5lcyB3aGVuIFwidXNlXG4gKiBmaWx0ZXJlZCBzY2VuZXMgZm9yIGJvdGggc2lkZXNcIiBpcyBvbiAodW5yYXRlZCBvbmVzIHRoZW4gc29ydCBsYXN0KS5cbiAqL1xuZnVuY3Rpb24gYnVpbGRPcHBvbmVudFBvb2woYWxsU2NlbmVzOiBTY2VuZVtdLCBsZWZ0UG9vbDogU2NlbmVbXSwgZmlsdGVyczogTGlzdEZpbHRlcnMpOiBTY2VuZVtdIHtcbiAgaWYgKHN0YXRlLnNldHRpbmdzLmZpbHRlck9wcG9uZW50cyAmJiBmaWx0ZXJzLmZpbHRlckFjdGl2ZSkge1xuICAgIHJldHVybiBsZWZ0UG9vbDtcbiAgfVxuICBjb25zdCByYXRlZCA9IGFsbFNjZW5lcy5maWx0ZXIoaXNSYXRlZCk7XG4gIHJldHVybiByYXRlZC5sZW5ndGggPj0gMSA/IHJhdGVkIDogYWxsU2NlbmVzO1xufVxuXG4vKiogTG9hZCB0aGUgbGVmdCAoXCJ0byByYXRlXCIpIGFuZCBmdWxsIHBvb2xzLiBCb3RoIGNvbWUgZnJvbSB0aGUgY2FjaGUsIHNvcnRlZCBieSBFTE8uICovXG5hc3luYyBmdW5jdGlvbiBsb2FkU2NlbmVQb29scyhcbiAgZmlsdGVyczogTGlzdEZpbHRlcnMsXG4pOiBQcm9taXNlPHsgbGVmdFBvb2w6IFNjZW5lW107IGFsbFNjZW5lczogU2NlbmVbXSB9PiB7XG4gIGxldCBsZWZ0UG9vbDogU2NlbmVbXTtcbiAgbGV0IGFsbFNjZW5lczogU2NlbmVbXTtcblxuICBpZiAoZmlsdGVycy5maWx0ZXJBY3RpdmUpIHtcbiAgICAvLyBSZS1xdWVyeSB0aGUgZmlsdGVyIGFmdGVyIGVhY2ggZnVsbCBwYXNzIHNvIGZpbHRlcnMgbGlrZSBcInVucmF0ZWRcIiBzaHJpbmsgYXMgc2NlbmVzIGdldCByYXRlZFxuICAgIGNvbnN0IHBhc3NDb21wbGV0ZSA9IGlzU2h1ZmZsZUN5Y2xlQ29tcGxldGUoZmlsdGVycy5maWx0ZXJLZXkpO1xuICAgIGlmIChwYXNzQ29tcGxldGUpIHtcbiAgICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+UgSBQYXNzIGNvbXBsZXRlLCByZS1mZXRjaGluZyBmaWx0ZXJlZCBzY2VuZXNcIik7XG4gICAgICBhd2FpdCBjbGVhckZpbHRlcmVkQ2FjaGUoKTtcbiAgICB9XG4gICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5OLIEZpbHRlciBhY3RpdmUsIGZldGNoaW5nIGZpbHRlcmVkICsgYWxsIHNjZW5lc1wiKTtcbiAgICBjb25zdCBbZmlsdGVyZWRSZXN1bHQsIGFsbFJlc3VsdF0gPSBhd2FpdCBQcm9taXNlLmFsbChbXG4gICAgICBnZXRGaWx0ZXJlZFNjZW5lc0NhY2hlZChmaWx0ZXJzKSxcbiAgICAgIGdldEFsbFNjZW5lc0NhY2hlZCgpLFxuICAgIF0pO1xuICAgIGxlZnRQb29sID0gZmlsdGVyZWRSZXN1bHQuc2NlbmVzIHx8IFtdO1xuICAgIGFsbFNjZW5lcyA9IGFsbFJlc3VsdC5zY2VuZXMgfHwgW107XG4gICAgLy8gU3RhcnQgdGhlIG5leHQgcGFzcyBub3csIHNvIGxhdGVyIGxvYWRzIGluIGEgcnVuICh3aGljaCBwaWNrIG5vIG5ldyBsZWZ0IHNjZW5lKSBkb24ndFxuICAgIC8vIHNlZSB0aGUgcGFzcyBhcyBjb21wbGV0ZSBhbmQgcmUtZmV0Y2ggdGhlIGZpbHRlciBldmVyeSB0aW1lXG4gICAgaWYgKHBhc3NDb21wbGV0ZSkgc3RhcnROZXdQYXNzKGxlZnRQb29sKTtcbiAgfSBlbHNlIHtcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCfk4sgTm8gZmlsdGVyIGFjdGl2ZSwgdXNpbmcgYWxsIHNjZW5lc1wiKTtcbiAgICBhbGxTY2VuZXMgPSAoYXdhaXQgZ2V0QWxsU2NlbmVzQ2FjaGVkKCkpLnNjZW5lcyB8fCBbXTtcbiAgICBsZWZ0UG9vbCA9IGFsbFNjZW5lcztcbiAgfVxuXG4gIHN0YXRlLmxlZnRQb29sU2l6ZSA9IGxlZnRQb29sLmxlbmd0aDtcbiAgcmV0dXJuIHsgbGVmdFBvb2wsIGFsbFNjZW5lcyB9O1xufVxuXG4vKipcbiAqIFJhbmtzIGZvciBhIHJlc3RvcmVkIHBhaXIgZnJvbSB0aGUgY3VycmVudCBwb29scyAoYWxzbyByZWNvcmRpbmcgdGhlIGxlZnQgcG9vbCdzIHNpemUpLCB0aGUgd2F5XG4gKiB0aGUgcGFpciBmZXRjaGVycyB3b3JrIHRoZW0gb3V0OiB0aGUgcGxhY2UgaW4gdGhlIG9wcG9uZW50IHBvb2wsIGFuZCBpbiBQbGFjZW1lbnQsIG5vbmUgZm9yIHRoZVxuICogc2NlbmUgYmVpbmcgcGxhY2VkIGFuZCB0aGUgb3Bwb25lbnQncyBwbGFjZSBpbiB0aGUgcG9vbCB3aXRob3V0IGl0LlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcGFpclJhbmtzKGxlZnQ6IFNjZW5lLCByaWdodDogU2NlbmUpOiBQcm9taXNlPFtSYW5rLCBSYW5rXT4ge1xuICBjb25zdCBmaWx0ZXJzID0gcmVhZEZpbHRlcnMoKTtcbiAgY29uc3QgeyBsZWZ0UG9vbCwgYWxsU2NlbmVzIH0gPSBhd2FpdCBsb2FkU2NlbmVQb29scyhmaWx0ZXJzKTtcbiAgbGV0IHBvb2wgPSBidWlsZE9wcG9uZW50UG9vbChhbGxTY2VuZXMsIGxlZnRQb29sLCBmaWx0ZXJzKTtcbiAgY29uc3QgcmFuayA9IChzY2VuZTogU2NlbmUpOiBSYW5rID0+IHtcbiAgICBjb25zdCBpZHggPSBwb29sLmZpbmRJbmRleCgocykgPT4gcy5pZCA9PT0gc2NlbmUuaWQpO1xuICAgIHJldHVybiBpZHggPj0gMCA/IGlkeCArIDEgOiBudWxsO1xuICB9O1xuICBpZiAoc3RhdGUuY3VycmVudE1vZGUgPT09IFwicGxhY2VtZW50XCIpIHtcbiAgICBwb29sID0gcG9vbC5maWx0ZXIoKHMpID0+IHMuaWQgIT09IGxlZnQuaWQpO1xuICAgIHJldHVybiBbbnVsbCwgcmFuayhyaWdodCldO1xuICB9XG4gIHJldHVybiBbcmFuayhsZWZ0KSwgcmFuayhyaWdodCldO1xufVxuXG4vKiogTG9hZCBsZWZ0IChzY2VuZSB0byByYXRlKSBhbmQgcmlnaHQgKG9wcG9uZW50KSBwb29scyBmb3IgU3dpc3MuICovXG5hc3luYyBmdW5jdGlvbiBidWlsZFN3aXNzUG9vbHMoKTogUHJvbWlzZTx7XG4gIGxlZnRQb29sOiBTY2VuZVtdO1xuICByaWdodFBvb2w6IFNjZW5lW107XG4gIGZpbHRlcktleTogc3RyaW5nO1xufT4ge1xuICBjb25zdCBmaWx0ZXJzID0gcmVhZEZpbHRlcnMoKTtcbiAgY29uc3QgeyBsZWZ0UG9vbCwgYWxsU2NlbmVzIH0gPSBhd2FpdCBsb2FkU2NlbmVQb29scyhmaWx0ZXJzKTtcblxuICBpZiAoYWxsU2NlbmVzLmxlbmd0aCA8IDIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJOb3QgZW5vdWdoIHNjZW5lcyBmb3IgY29tcGFyaXNvbi5cIik7XG4gIH1cblxuICBjb25zdCByaWdodFBvb2wgPSBidWlsZE9wcG9uZW50UG9vbChhbGxTY2VuZXMsIGxlZnRQb29sLCBmaWx0ZXJzKTtcbiAgaWYgKHN0YXRlLnNldHRpbmdzLmZpbHRlck9wcG9uZW50cyAmJiBmaWx0ZXJzLmZpbHRlckFjdGl2ZSAmJiByaWdodFBvb2wubGVuZ3RoIDwgMikge1xuICAgIHRocm93IG5ldyBFcnJvcihcIk5vdCBlbm91Z2ggc2NlbmVzIGluIHlvdXIgZmlsdGVyIGZvciBhIG1hdGNoLiBZb3UgbmVlZCBhdCBsZWFzdCAyIHNjZW5lcy5cIik7XG4gIH1cblxuICByZXR1cm4geyBsZWZ0UG9vbCwgcmlnaHRQb29sLCBmaWx0ZXJLZXk6IGZpbHRlcnMuZmlsdGVyS2V5IH07XG59XG5cbi8vIFN3aXNzIG1vZGU6IGxlZnQgPSBzY2VuZSB0byByYXRlIChmaWx0ZXJlZCBwb29sKSwgcmlnaHQgPSBzaW1pbGFyLXN0cmVuZ3RoIG9wcG9uZW50XG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmV0Y2hTd2lzc1BhaXIoZm9yY2VkTGVmdFNjZW5lOiBTY2VuZSB8IG51bGwgPSBudWxsKTogUHJvbWlzZTxTd2lzc1BhaXJSZXN1bHQ+IHtcbiAgY29uc3QgeyBsZWZ0UG9vbCwgcmlnaHRQb29sLCBmaWx0ZXJLZXkgfSA9IGF3YWl0IGJ1aWxkU3dpc3NQb29scygpO1xuXG4gIGNvbnN0IHNjZW5lMSA9IGZvcmNlZExlZnRTY2VuZSB8fCBnZXROZXh0RmlsdGVyZWRTY2VuZShsZWZ0UG9vbCwgZmlsdGVyS2V5KTtcbiAgaWYgKCFzY2VuZTEpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJObyBzY2VuZXMgbWF0Y2ggeW91ciBmaWx0ZXIgY3JpdGVyaWEuXCIpO1xuICB9XG5cbiAgY29uc3QgeyBzY2VuZTIsIHJhbmtzIH0gPSBwaWNrU3dpc3NPcHBvbmVudChzY2VuZTEsIHJpZ2h0UG9vbCk7XG4gIHJldHVybiB7IHNjZW5lczogW3NjZW5lMSwgc2NlbmUyXSwgcmFua3MgfTtcbn1cblxuLyoqIFBpY2sgYSByYW5kb20gb3Bwb25lbnQgbmVhciBzY2VuZTEncyByYW5rIGluIHRoZSBFTE8tc29ydGVkIHJpZ2h0IHBvb2wgKGV4cGFuZGluZyBiYW5kIGlmIG5lZWRlZCkuICovXG5mdW5jdGlvbiBwaWNrU3dpc3NPcHBvbmVudChcbiAgc2NlbmUxOiBTY2VuZSxcbiAgcmlnaHRQb29sOiBTY2VuZVtdLFxuKTogeyBzY2VuZTI6IFNjZW5lOyByYW5rczogW1JhbmssIFJhbmtdIH0ge1xuICBjb25zdCBzY2VuZTFJZHhJblBvb2wgPSByaWdodFBvb2wuZmluZEluZGV4KChzKSA9PiBzLmlkID09PSBzY2VuZTEuaWQpO1xuICAvLyBSYXRlZCBzY2VuZXMgbWF0Y2ggYXJvdW5kIHRoZWlyIG93biByYW5rOyB1bnJhdGVkIG9uZXMgYXJvdW5kIHdoZXJlIDE1MDAgd291bGQgc2l0XG4gIGNvbnN0IGVmZmVjdGl2ZVNjZW5lMUlkeCA9XG4gICAgaXNSYXRlZChzY2VuZTEpICYmIHNjZW5lMUlkeEluUG9vbCA+PSAwXG4gICAgICA/IHNjZW5lMUlkeEluUG9vbFxuICAgICAgOiBlbG9JbnNlcnRpb25JbmRleChyaWdodFBvb2wsIGVmZmVjdGl2ZUVsbyhzY2VuZTEpKTtcbiAgY29uc3Qgc2NlbmUxUmFua0luUG9vbCA9IHNjZW5lMUlkeEluUG9vbCA+PSAwID8gc2NlbmUxSWR4SW5Qb29sICsgMSA6IG51bGw7XG5cbiAgY29uc3QgY2FuZGlkYXRlczogeyBzY2VuZTogU2NlbmU7IGlkeDogbnVtYmVyIH1bXSA9IFtdO1xuICAvLyBQcmVmZXIgc2ltaWxhci1zdHJlbmd0aCBtYXRjaHVwcyAowrFyZWFjaCByYW5rcykuIElmIHRoZSBiYW5kIGlzIGVtcHR5IChlZGdlcywgdW5yYXRlZCBsZWZ0XG4gIC8vIHNjZW5lLCB0aW55IHBvb2wpLCBkb3VibGUgcmVhY2ggdW50aWwgd2UgZmluZCBjYW5kaWRhdGVzIG9yIGNvdmVyIHRoZSB3aG9sZSBwb29sLlxuICBmb3IgKFxuICAgIGxldCByZWFjaCA9IE1hdGgubWluKFNXSVNTX09QUE9ORU5UX1JFQUNIX0lOSVRJQUwsIHJpZ2h0UG9vbC5sZW5ndGgpO1xuICAgIGNhbmRpZGF0ZXMubGVuZ3RoID09PSAwICYmIHJlYWNoIDw9IHJpZ2h0UG9vbC5sZW5ndGg7XG4gICAgcmVhY2ggPSBNYXRoLm1pbihyZWFjaCAqIFNXSVNTX09QUE9ORU5UX1JFQUNIX01VTFRJUExJRVIsIHJpZ2h0UG9vbC5sZW5ndGgpXG4gICkge1xuICAgIGZvciAobGV0IGkgPSBlZmZlY3RpdmVTY2VuZTFJZHggLSByZWFjaDsgaSA8PSBlZmZlY3RpdmVTY2VuZTFJZHggKyByZWFjaDsgaSsrKSB7XG4gICAgICBpZiAoaSA+PSAwICYmIGkgPCByaWdodFBvb2wubGVuZ3RoICYmIGkgIT09IHNjZW5lMUlkeEluUG9vbCkge1xuICAgICAgICBjYW5kaWRhdGVzLnB1c2goeyBzY2VuZTogcmlnaHRQb29sW2ldLCBpZHg6IGkgfSk7XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChyZWFjaCA9PT0gcmlnaHRQb29sLmxlbmd0aCkgYnJlYWs7XG4gIH1cblxuICBpZiAoY2FuZGlkYXRlcy5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJOb3QgZW5vdWdoIHNjZW5lcyBmb3IgY29tcGFyaXNvbi4gWW91IG5lZWQgYXQgbGVhc3QgMiBzY2VuZXMuXCIpO1xuICB9XG5cbiAgY29uc3QgcGljayA9IGNhbmRpZGF0ZXNbTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogY2FuZGlkYXRlcy5sZW5ndGgpXTtcbiAgcmV0dXJuIHtcbiAgICBzY2VuZTI6IHBpY2suc2NlbmUsXG4gICAgcmFua3M6IFtzY2VuZTFSYW5rSW5Qb29sLCBwaWNrLmlkeCArIDFdLFxuICB9O1xufVxuXG4vKiogUmFuZG9tIHBpY2sgZnJvbSB0aGUgTiB1bmJlYXRlbiBvcHBvbmVudHMgY2xvc2VzdCBhYm92ZSB0aGUgY2hhbXBpb24gKGxpc3QgaXMgRUxPLXNvcnRlZCkuICovXG5mdW5jdGlvbiBwaWNrQ2xvc2VzdENoYW1waW9uT3Bwb25lbnQocmVtYWluaW5nT3Bwb25lbnRzOiBTY2VuZVtdKTogU2NlbmUge1xuICBjb25zdCBjbG9zZXN0ID0gcmVtYWluaW5nT3Bwb25lbnRzLnNsaWNlKC1DTElNQl9PUFBPTkVOVF9QSUNLX1dJTkRPVyk7XG4gIHJldHVybiBjbG9zZXN0W01hdGguZmxvb3IoTWF0aC5yYW5kb20oKSAqIGNsb3Nlc3QubGVuZ3RoKV07XG59XG5cbi8qKiBPcHBvbmVudHMgYWJvdmUgdGhlIGNoYW1waW9uIGluIHRoZSBFTE8tc29ydGVkIHBvb2wgdGhhdCBpdCBoYXNuJ3QgYmVhdGVuIGluIHRoaXMgcnVuLiAqL1xuZnVuY3Rpb24gZ2V0UmVtYWluaW5nQ2hhbXBpb25PcHBvbmVudHMoY2hhbXBpb246IFNjZW5lLCByaWdodFBvb2w6IFNjZW5lW10sIGNoYW1waW9uSW5kZXg6IG51bWJlcik6IFNjZW5lW10ge1xuICBjb25zdCBjaGFtcGlvbkVsbyA9IGVmZmVjdGl2ZUVsbyhjaGFtcGlvbiwgQ0hBTVBJT05fVU5SQVRFRF9FTE8pO1xuICByZXR1cm4gcmlnaHRQb29sLmZpbHRlcigocywgaWR4KSA9PiB7XG4gICAgaWYgKHMuaWQgPT09IGNoYW1waW9uLmlkIHx8IHN0YXRlLmNoYW1waW9uRGVmZWF0ZWQuaW5jbHVkZXMocy5pZCkpIHJldHVybiBmYWxzZTtcbiAgICByZXR1cm4gaWR4IDwgY2hhbXBpb25JbmRleCB8fCAoZWxvKHMpID8/IC1JbmZpbml0eSkgPj0gY2hhbXBpb25FbG87XG4gIH0pO1xufVxuXG4vKiogTG93ZXN0IHNjZW5lIHdpdGggYW4gRUxPIGluIHRoZSBwb29sIChleGNsdWRpbmcgb25lIHNjZW5lKSwgb3IgYW55IG90aGVyIHNjZW5lIGlmIG5vbmUgaGFzIG9uZS4gKi9cbmZ1bmN0aW9uIGZpbmRMb3dlc3RSYXRlZChzY2VuZXM6IFNjZW5lW10sIGV4Y2x1ZGVJZDogc3RyaW5nKTogeyBzY2VuZTogU2NlbmUgfCB1bmRlZmluZWQ7IGluZGV4OiBudW1iZXIgfSB7XG4gIGZvciAobGV0IGkgPSBzY2VuZXMubGVuZ3RoIC0gMTsgaSA+PSAwOyBpLS0pIHtcbiAgICBjb25zdCBzID0gc2NlbmVzW2ldO1xuICAgIGlmIChzLmlkICE9PSBleGNsdWRlSWQgJiYgaXNSYXRlZChzKSkge1xuICAgICAgcmV0dXJuIHsgc2NlbmU6IHMsIGluZGV4OiBpIH07XG4gICAgfVxuICB9XG4gIGNvbnN0IGZhbGxiYWNrSW5kZXggPSBzY2VuZXMuZmluZEluZGV4KChzKSA9PiBzLmlkICE9PSBleGNsdWRlSWQpO1xuICByZXR1cm4geyBzY2VuZTogc2NlbmVzW2ZhbGxiYWNrSW5kZXhdLCBpbmRleDogZmFsbGJhY2tJbmRleCB9O1xufVxuXG4vLyBDaGFtcGlvbiBtb2RlOiB3aW5uZXIgc3RheXMgb24sIHN0YXJ0aW5nIGFnYWluc3QgdGhlIGxvd2VzdC1yYXRlZCBzY2VuZVxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGZldGNoQ2hhbXBpb25QYWlyKFxuICBmb3JjZWRMZWZ0U2NlbmU6IFNjZW5lIHwgbnVsbCA9IG51bGwsXG4pOiBQcm9taXNlPENoYW1waW9uUGFpclJlc3VsdD4ge1xuICBjb25zdCBmaWx0ZXJzID0gcmVhZEZpbHRlcnMoKTtcblxuICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCfk4sgRmV0Y2hpbmcgc2NlbmVzIGZvciBjaGFtcGlvbi4uLlwiKTtcbiAgY29uc3QgeyBsZWZ0UG9vbCwgYWxsU2NlbmVzIH0gPSBhd2FpdCBsb2FkU2NlbmVQb29scyhmaWx0ZXJzKTtcblxuICBjb25zdCByaWdodFBvb2wgPSBidWlsZE9wcG9uZW50UG9vbChhbGxTY2VuZXMsIGxlZnRQb29sLCBmaWx0ZXJzKTtcbiAgc3RhdGUudG90YWxTY2VuZXNDb3VudCA9IHJpZ2h0UG9vbC5sZW5ndGg7XG5cbiAgaWYgKGFsbFNjZW5lcy5sZW5ndGggPCAyKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiTm90IGVub3VnaCBzY2VuZXMgZm9yIGNvbXBhcmlzb24uXCIpO1xuICB9XG5cbiAgLy8gTm8gY2hhbXBpb24geWV0OiB0aGUgY2hhbGxlbmdlciBmcm9tIHRoZSBsZWZ0IHBvb2wgc3RhcnRzIGFnYWluc3QgdGhlIGxvd2VzdC1yYXRlZCBzY2VuZVxuICBpZiAoIXN0YXRlLmNoYW1waW9uU2NlbmUpIHtcbiAgICBzdGF0ZS5jaGFtcGlvbkRlZmVhdGVkID0gW107XG5cbiAgICBjb25zdCBjaGFsbGVuZ2VyID0gZm9yY2VkTGVmdFNjZW5lIHx8IGdldE5leHRGaWx0ZXJlZFNjZW5lKGxlZnRQb29sLCBmaWx0ZXJzLmZpbHRlcktleSk7XG4gICAgaWYgKCFjaGFsbGVuZ2VyKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJObyBzY2VuZXMgbWF0Y2ggeW91ciBmaWx0ZXIgY3JpdGVyaWEuXCIpO1xuICAgIH1cblxuICAgIGNvbnN0IGNoYWxsZW5nZXJJbmRleCA9IHJpZ2h0UG9vbC5maW5kSW5kZXgoKHMpID0+IHMuaWQgPT09IGNoYWxsZW5nZXIuaWQpO1xuICAgIGNvbnN0IHsgc2NlbmU6IGxvd2VzdFJhdGVkLCBpbmRleDogbG93ZXN0SW5kZXggfSA9IGZpbmRMb3dlc3RSYXRlZChyaWdodFBvb2wsIGNoYWxsZW5nZXIuaWQpO1xuICAgIGlmICghbG93ZXN0UmF0ZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIk5vdCBlbm91Z2ggc2NlbmVzIGZvciBjb21wYXJpc29uLiBZb3UgbmVlZCBhdCBsZWFzdCAyIHNjZW5lcy5cIik7XG4gICAgfVxuXG4gICAgcmV0dXJuIHtcbiAgICAgIHNjZW5lczogW2NoYWxsZW5nZXIsIGxvd2VzdFJhdGVkXSxcbiAgICAgIHJhbmtzOiBbY2hhbGxlbmdlckluZGV4ID49IDAgPyBjaGFsbGVuZ2VySW5kZXggKyAxIDogbnVsbCwgbG93ZXN0SW5kZXggKyAxXSxcbiAgICAgIGlzVmljdG9yeTogZmFsc2UsXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IGNoYW1waW9uID0gc3RhdGUuY2hhbXBpb25TY2VuZTtcbiAgY29uc3QgY2hhbXBpb25JbmRleCA9IHJpZ2h0UG9vbC5maW5kSW5kZXgoKHMpID0+IHMuaWQgPT09IGNoYW1waW9uLmlkKTtcbiAgY29uc3QgcmVtYWluaW5nT3Bwb25lbnRzID0gZ2V0UmVtYWluaW5nQ2hhbXBpb25PcHBvbmVudHMoY2hhbXBpb24sIHJpZ2h0UG9vbCwgY2hhbXBpb25JbmRleCk7XG5cbiAgLy8gTm8gb3Bwb25lbnRzIGxlZnQ6IHRoZSBjaGFtcGlvbiBoYXMgYmVhdGVuIGV2ZXJ5b25lIGFib3ZlIGl0XG4gIGlmIChyZW1haW5pbmdPcHBvbmVudHMubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIHsgc2NlbmVzOiBbY2hhbXBpb25dLCByYW5rczogWzFdLCBpc1ZpY3Rvcnk6IHRydWUgfTtcbiAgfVxuXG4gIGNvbnN0IG5leHRPcHBvbmVudCA9IHBpY2tDbG9zZXN0Q2hhbXBpb25PcHBvbmVudChyZW1haW5pbmdPcHBvbmVudHMpO1xuICBjb25zdCBuZXh0T3Bwb25lbnRJbmRleCA9IHJpZ2h0UG9vbC5maW5kSW5kZXgoKHMpID0+IHMuaWQgPT09IG5leHRPcHBvbmVudC5pZCk7XG5cbiAgcmV0dXJuIHtcbiAgICBzY2VuZXM6IFtjaGFtcGlvbiwgbmV4dE9wcG9uZW50XSxcbiAgICByYW5rczogW2NoYW1waW9uSW5kZXggPj0gMCA/IGNoYW1waW9uSW5kZXggKyAxIDogbnVsbCwgbmV4dE9wcG9uZW50SW5kZXggKyAxXSxcbiAgICBpc1ZpY3Rvcnk6IGZhbHNlLFxuICB9O1xufVxuXG4vLyAtLS0gUGxhY2VtZW50IG1vZGUgKHRoZSBzZWFyY2ggaXRzZWxmIGlzIGluIHBsYWNlbWVudC50cykgLS0tXG5cbi8qKiBSYW5kb20gcGljayBhbW9uZyBzY2VuZXMgaW4gW2xvLCBoaSkgdGhhdCBzaGFyZSBwb29sW2lkeF0ncyBFTE8gKHRoZWlyIG9yZGVyIGlzIGFyYml0cmFyeSkuICovXG5mdW5jdGlvbiBwaWNrQW1vbmdUaWVzKHBvb2w6IFNjZW5lW10sIGlkeDogbnVtYmVyLCBsbzogbnVtYmVyLCBoaTogbnVtYmVyKTogbnVtYmVyIHtcbiAgY29uc3QgdGFyZ2V0ID0gZWxvKHBvb2xbaWR4XSk7XG4gIGNvbnN0IHRpZXM6IG51bWJlcltdID0gW107XG4gIGZvciAobGV0IGkgPSBsbzsgaSA8IGhpOyBpKyspIHtcbiAgICBpZiAoZWxvKHBvb2xbaV0pID09PSB0YXJnZXQpIHRpZXMucHVzaChpKTtcbiAgfVxuICByZXR1cm4gdGllc1tNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkgKiB0aWVzLmxlbmd0aCldO1xufVxuXG4vLyBQbGFjZW1lbnQgbW9kZTogbGVmdCA9IHNjZW5lIGJlaW5nIHBsYWNlZCwgcmlnaHQgPSB0aGUgbmV4dCBvcHBvbmVudCBpbiBpdHMgc2VhcmNoIHJhbmdlXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmV0Y2hQbGFjZW1lbnRQYWlyKFxuICBmb3JjZWRMZWZ0U2NlbmU6IFNjZW5lIHwgbnVsbCA9IG51bGwsXG4pOiBQcm9taXNlPFBsYWNlbWVudFBhaXJSZXN1bHQ+IHtcbiAgY29uc3QgZmlsdGVycyA9IHJlYWRGaWx0ZXJzKCk7XG4gIGNvbnN0IHsgbGVmdFBvb2wsIGFsbFNjZW5lcyB9ID0gYXdhaXQgbG9hZFNjZW5lUG9vbHMoZmlsdGVycyk7XG5cbiAgaWYgKGFsbFNjZW5lcy5sZW5ndGggPCAyKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiTm90IGVub3VnaCBzY2VuZXMgZm9yIGNvbXBhcmlzb24uXCIpO1xuICB9XG5cbiAgaWYgKCFzdGF0ZS5wbGFjZW1lbnQpIHtcbiAgICBjb25zdCBzY2VuZSA9IGZvcmNlZExlZnRTY2VuZSB8fCBnZXROZXh0RmlsdGVyZWRTY2VuZShsZWZ0UG9vbCwgZmlsdGVycy5maWx0ZXJLZXkpO1xuICAgIGlmICghc2NlbmUpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIk5vIHNjZW5lcyBtYXRjaCB5b3VyIGZpbHRlciBjcml0ZXJpYS5cIik7XG4gICAgfVxuICAgIHN0YXRlLnBsYWNlbWVudCA9IG5ld1BsYWNlbWVudFJ1bihzY2VuZSwgc3RhdGUuc2V0dGluZ3MucGxhY2VtZW50RnJvbUJvdHRvbSk7XG4gIH1cbiAgY29uc3QgcnVuID0gc3RhdGUucGxhY2VtZW50O1xuXG4gIGNvbnN0IHBvb2wgPSBidWlsZE9wcG9uZW50UG9vbChhbGxTY2VuZXMsIGxlZnRQb29sLCBmaWx0ZXJzKS5maWx0ZXIoKHMpID0+IHMuaWQgIT09IHJ1bi5zY2VuZS5pZCk7XG4gIGlmIChwb29sLmxlbmd0aCA9PT0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIk5vdCBlbm91Z2ggc2NlbmVzIGZvciBjb21wYXJpc29uLiBZb3UgbmVlZCBhdCBsZWFzdCAyIHNjZW5lcy5cIik7XG4gIH1cbiAgc3RhdGUudG90YWxTY2VuZXNDb3VudCA9IHBvb2wubGVuZ3RoICsgMTtcblxuICBjb25zdCBzdGVwID0gcGxhY2VtZW50U3RlcChydW4sIHBvb2wpO1xuICBydW4ucmFuZ2VMbyA9IE1hdGgubWluKHN0ZXAubG8sIHN0ZXAuaGkpO1xuICBydW4ucmFuZ2VIaSA9IHN0ZXAuaGk7XG5cbiAgaWYgKHN0ZXAuZG9uZSkge1xuICAgIC8vIE9ubHkgdGhlIHBsYWNlZCBzY2VuZSdzIEVMTyBjaGFuZ2VzOyBpdCdzIGNyZWRpdGVkIHdpdGggdGhlIGJhdHRsZXMgdGhpcyBydW4gdG9va1xuICAgIGNvbnN0IG5ld0VsbyA9IGxhbmRpbmdFbG8ocG9vbCwgc3RlcC5zbG90KTtcbiAgICBjb25zdCBuZXdCYXR0bGVzID0gYmF0dGxlcyhsYXRlc3RTY2VuZShydW4uc2NlbmUpKSArIHJ1bi5iYXR0bGVzO1xuICAgIGNvbnNvbGUubG9nKFxuICAgICAgYFtTdGFzaCBCYXR0bGVdIPCfk40gUGxhY2VtZW50OiBzY2VuZSAke3J1bi5zY2VuZS5pZH0gcGxhY2VkIGF0ICMke3N0ZXAuc2xvdCArIDF9IGFmdGVyICR7cnVuLmJhdHRsZXN9IGJhdHRsZXMsIEVMTyAke25ld0Vsb31gLFxuICAgICk7XG4gICAgYXdhaXQgd3JpdGVFbG8ocnVuLnNjZW5lLCBuZXdFbG8sIG5ld0JhdHRsZXMpO1xuICAgIHJldHVybiB7XG4gICAgICBkb25lOiB0cnVlLFxuICAgICAgc2NlbmU6IHJ1bi5zY2VuZSxcbiAgICAgIHJhbms6IHN0ZXAuc2xvdCArIDEsXG4gICAgICBlbG86IG5ld0VsbyxcbiAgICAgIGJhdHRsZXM6IHJ1bi5iYXR0bGVzLFxuICAgICAgc3RyZWFrOiBydW4uc3RyZWFrLFxuICAgICAgZnJvbUJvdHRvbTogcnVuLmZyb21Cb3R0b20sXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IGlkeCA9IHBpY2tBbW9uZ1RpZXMocG9vbCwgc3RlcC5pbmRleCwgc3RlcC5sbywgc3RlcC5oaSk7XG4gIHJldHVybiB7IGRvbmU6IGZhbHNlLCBzY2VuZXM6IFtydW4uc2NlbmUsIHBvb2xbaWR4XV0sIHJhbmtzOiBbbnVsbCwgaWR4ICsgMV0gfTtcbn1cbiIsICJpbXBvcnQgdHlwZSB7IFNjZW5lIH0gZnJvbSBcIi4uL3R5cGVzXCI7XHJcblxyXG4vKiogU2NlbmUgdGl0bGUgZnJvbSBtZXRhZGF0YSwgb3IgdGhlIGZpbGVuYW1lICh3aXRob3V0IGV4dGVuc2lvbikgZnJvbSB0aGUgZmlsZSBwYXRoLiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZVNjZW5lVGl0bGUoc2NlbmU6IFNjZW5lKTogc3RyaW5nIHtcclxuICBpZiAoc2NlbmUudGl0bGUpIHJldHVybiBzY2VuZS50aXRsZTtcclxuXHJcbiAgY29uc3QgcGF0aCA9IHNjZW5lLmZpbGVzPy5bMF0/LnBhdGg7XHJcbiAgaWYgKHBhdGgpIHtcclxuICAgIGNvbnN0IHBhdGhQYXJ0cyA9IHBhdGguc3BsaXQoL1svXFxcXF0vKTtcclxuICAgIHJldHVybiBwYXRoUGFydHNbcGF0aFBhcnRzLmxlbmd0aCAtIDFdLnJlcGxhY2UoL1xcLlteLy5dKyQvLCBcIlwiKTtcclxuICB9XHJcblxyXG4gIHJldHVybiBcIlwiO1xyXG59XHJcbiIsICIvLyBSZW5kZXJzIGFuIGluZGl2aWR1YWwgc2NlbmUgY2FyZCAocmV0dXJucyBhbiBIVE1MIHN0cmluZykuXG5cbmltcG9ydCB7IENIQU1QSU9OX1VOUkFURURfRUxPLCBFTE9fU1RBUlQgfSBmcm9tIFwiLi4vY29uc3RhbnRzXCI7XG5pbXBvcnQgeyBiYXR0bGVzLCBlbG8gfSBmcm9tIFwiLi4vc2NvcmVcIjtcbmltcG9ydCB7IHN0YXRlIH0gZnJvbSBcIi4uL3N0YXRlXCI7XG5pbXBvcnQgeyBpc1N0YXNoRGVsZXRlRGlhbG9nQXZhaWxhYmxlIH0gZnJvbSBcIi4vZGVsZXRlRGlhbG9nXCI7XG5pbXBvcnQgdHlwZSB7IFJhbmssIFNjZW5lIH0gZnJvbSBcIi4uL3R5cGVzXCI7XG5pbXBvcnQgeyByZXNvbHZlU2NlbmVUaXRsZSB9IGZyb20gXCIuL3NjZW5lVGl0bGVcIjtcblxuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdER1cmF0aW9uKHNlY29uZHM6IG51bWJlciB8IG51bGwgfCB1bmRlZmluZWQpOiBzdHJpbmcge1xuICBpZiAoIXNlY29uZHMpIHJldHVybiBcIk4vQVwiO1xuICBjb25zdCBoID0gTWF0aC5mbG9vcihzZWNvbmRzIC8gMzYwMCk7XG4gIGNvbnN0IG0gPSBNYXRoLmZsb29yKChzZWNvbmRzICUgMzYwMCkgLyA2MCk7XG4gIGNvbnN0IHMgPSBNYXRoLmZsb29yKHNlY29uZHMgJSA2MCk7XG4gIGlmIChoID4gMCkge1xuICAgIHJldHVybiBgJHtofToke20udG9TdHJpbmcoKS5wYWRTdGFydCgyLCBcIjBcIil9OiR7cy50b1N0cmluZygpLnBhZFN0YXJ0KDIsIFwiMFwiKX1gO1xuICB9XG4gIHJldHVybiBgJHttfToke3MudG9TdHJpbmcoKS5wYWRTdGFydCgyLCBcIjBcIil9YDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVNjZW5lQ2FyZChcbiAgc2NlbmU6IFNjZW5lLFxuICBzaWRlOiBcImxlZnRcIiB8IFwicmlnaHRcIixcbiAgcmFuazogUmFuayA9IG51bGwsXG4gIHN0YXR1c0JhZGdlOiBudW1iZXIgfCBzdHJpbmcgfCBudWxsID0gbnVsbCxcbik6IHN0cmluZyB7XG4gIGNvbnN0IGZpbGUgPSBzY2VuZS5maWxlcyAmJiBzY2VuZS5maWxlc1swXSA/IHNjZW5lLmZpbGVzWzBdIDoge307XG4gIGNvbnN0IGR1cmF0aW9uID0gZmlsZS5kdXJhdGlvbjtcbiAgY29uc3QgcGVyZm9ybWVycyA9XG4gICAgc2NlbmUucGVyZm9ybWVycyAmJiBzY2VuZS5wZXJmb3JtZXJzLmxlbmd0aCA+IDBcbiAgICAgID8gc2NlbmUucGVyZm9ybWVycy5tYXAoKHApID0+IHAubmFtZSkuam9pbihcIiwgXCIpXG4gICAgICA6IFwiTm8gcGVyZm9ybWVyc1wiO1xuICBjb25zdCBzdHVkaW8gPSBzY2VuZS5zdHVkaW8gPyBzY2VuZS5zdHVkaW8ubmFtZSA6IFwiTm8gc3R1ZGlvXCI7XG4gIGNvbnN0IHRhZ3MgPSBzY2VuZS50YWdzID8gc2NlbmUudGFncy5zbGljZSgwLCA1KS5tYXAoKHQpID0+IHQubmFtZSkgOiBbXTtcblxuICBjb25zdCB0aXRsZSA9IHJlc29sdmVTY2VuZVRpdGxlKHNjZW5lKTtcblxuICBjb25zdCBzY3JlZW5zaG90UGF0aCA9IHNjZW5lLnBhdGhzID8gc2NlbmUucGF0aHMuc2NyZWVuc2hvdCA6IG51bGw7XG4gIGNvbnN0IHByZXZpZXdQYXRoID0gc2NlbmUucGF0aHMgPyBzY2VuZS5wYXRocy5wcmV2aWV3IDogbnVsbDtcbiAgY29uc3QgeyBvcGVuSW5OZXdUYWIsIGNsZWFuTW9kZSB9ID0gc3RhdGUuc2V0dGluZ3M7XG4gIGNvbnN0IHN0YXNoUmF0aW5nID0gc2NlbmUucmF0aW5nMTAwID8gYCR7c2NlbmUucmF0aW5nMTAwfS8xMDBgIDogXCJOb25lXCI7XG5cbiAgLy8gRUxPIGJhZGdlOiBcIkVMTyAxNzQwIMK3ICM1MFwiIHdoZW4gcmF0ZWQgKHJhbmsgd2hlbiBrbm93bikuIFVucmF0ZWQgc2NlbmVzIHNob3cgdGhlIEVMTyB0aGV5XG4gIC8vIGNvdW50IGFzIGluIHRoaXMgbW9kZSBpbiB0aGUgc2FtZSBvcmRlciwgXCJFTE8gMTUwMCDCtyBVbnJhdGVkXCIgKFBsYWNlbWVudCBoYXMgbm9uZTogXCJVbnJhdGVkXCIpLlxuICBjb25zdCBlbG9WYWx1ZSA9IGVsbyhzY2VuZSk7XG4gIGNvbnN0IHVucmF0ZWRBcyA9XG4gICAgc3RhdGUuY3VycmVudE1vZGUgPT09IFwic3dpc3NcIiA/IEVMT19TVEFSVCA6IHN0YXRlLmN1cnJlbnRNb2RlID09PSBcImNoYW1waW9uXCIgPyBDSEFNUElPTl9VTlJBVEVEX0VMTyA6IG51bGw7XG4gIGxldCBlbG9MYWJlbDogc3RyaW5nO1xuICBpZiAoZWxvVmFsdWUgIT09IG51bGwpIHtcbiAgICBlbG9MYWJlbCA9IGBFTE8gJHtNYXRoLnJvdW5kKGVsb1ZhbHVlKX0ke3JhbmsgIT09IG51bGwgJiYgcmFuayAhPT0gdW5kZWZpbmVkID8gYCDCtyAjJHtyYW5rfWAgOiBcIlwifWA7XG4gIH0gZWxzZSB7XG4gICAgZWxvTGFiZWwgPSB1bnJhdGVkQXMgIT09IG51bGwgPyBgRUxPICR7dW5yYXRlZEFzfSDCtyBVbnJhdGVkYCA6IFwiVW5yYXRlZFwiO1xuICB9XG4gIGNvbnN0IHJhbmtEaXNwbGF5ID0gYDxzcGFuIGNsYXNzPVwic2Itc2NlbmUtcmFua1wiPiR7ZWxvTGFiZWx9PC9zcGFuPmA7XG5cbiAgLy8gU3RhdHVzIGJhZGdlOiB3aW4tc3RyZWFrIGNvdW50IChmb3JtYXR0ZWQpIG9yIGN1c3RvbSBsYWJlbCAoZS5nLiBmYWxsaW5nIG1vZGUpXG4gIGxldCBzdGF0dXNCYWRnZUh0bWwgPSBcIlwiO1xuICBpZiAodHlwZW9mIHN0YXR1c0JhZGdlID09PSBcInN0cmluZ1wiKSB7XG4gICAgc3RhdHVzQmFkZ2VIdG1sID0gYDxkaXYgY2xhc3M9XCJzYi1zdHJlYWstYmFkZ2VcIj4ke3N0YXR1c0JhZGdlfTwvZGl2PmA7XG4gIH0gZWxzZSBpZiAoc3RhdHVzQmFkZ2UgIT09IG51bGwgJiYgc3RhdHVzQmFkZ2UgPiAwKSB7XG4gICAgc3RhdHVzQmFkZ2VIdG1sID0gYDxkaXYgY2xhc3M9XCJzYi1zdHJlYWstYmFkZ2VcIj7wn5SlICR7c3RhdHVzQmFkZ2V9IHdpbiR7c3RhdHVzQmFkZ2UgPiAxID8gXCJzXCIgOiBcIlwifTwvZGl2PmA7XG4gIH1cblxuICAvLyBQcmVzZXJ2ZSBVUkwgc2VhcmNoIHBhcmFtcyB3aGVuIG9wZW5pbmcgc2NlbmVcbiAgY29uc3QgY3VycmVudFBhcmFtcyA9IHdpbmRvdy5sb2NhdGlvbi5zZWFyY2g7XG4gIGNvbnN0IHNjZW5lVXJsID0gYC9zY2VuZXMvJHtzY2VuZS5pZH0ke2N1cnJlbnRQYXJhbXN9YDtcbiAgY29uc3QgbGlua1RhcmdldCA9IG9wZW5Jbk5ld1RhYiA/IGAgdGFyZ2V0PVwiX2JsYW5rXCIgcmVsPVwibm9vcGVuZXJcImAgOiBcIlwiO1xuXG4gIC8vIHB3ci0qIGNsYXNzZXMgYXJlIHRoZSBwbHVnaW4ncyBwcmUtMi4wIG5hbWVzOyBTRlcgU3dpdGNoIHN0aWxsIHRhcmdldHMgdGhlbSB0byBibHVyIFN0YXNoIEJhdHRsZS5cbiAgLy8gQmFkZ2VzIHNpdCBvdXRzaWRlIHRoZSAoYmx1cnJlZCkgaW1hZ2UgY29udGFpbmVyIHNvIHRoZXkgc3RheSByZWFkYWJsZSBpbiBTRlcgbW9kZS5cbiAgcmV0dXJuIGBcbiAgICAgIDxkaXYgY2xhc3M9XCJzYi1zY2VuZS1jYXJkXCIgZGF0YS1zaWRlPVwiJHtzaWRlfVwiPlxuICAgICAgICA8ZGl2IGNsYXNzPVwic2Itc2NlbmUtbWVkaWFcIj5cbiAgICAgICAgICA8YSBjbGFzcz1cInNiLXNjZW5lLWltYWdlLWNvbnRhaW5lciBwd3Itc2NlbmUtaW1hZ2UtY29udGFpbmVyXCIgaHJlZj1cIiR7c2NlbmVVcmx9XCIke2xpbmtUYXJnZXR9PlxuICAgICAgICAgICAgJHtcbiAgICAgICAgICAgICAgc2NyZWVuc2hvdFBhdGhcbiAgICAgICAgICAgICAgICA/IGA8aW1nIGNsYXNzPVwic2Itc2NlbmUtaW1hZ2UgcHdyLXNjZW5lLWltYWdlXCIgc3JjPVwiJHtzY3JlZW5zaG90UGF0aH1cIiBhbHQ9XCIke3RpdGxlfVwiIGxvYWRpbmc9XCJsYXp5XCIgLz5gXG4gICAgICAgICAgICAgICAgOiBgPGRpdiBjbGFzcz1cInNiLXNjZW5lLWltYWdlIHNiLW5vLWltYWdlXCI+Tm8gU2NyZWVuc2hvdDwvZGl2PmBcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgICR7cHJldmlld1BhdGggPyBgPHZpZGVvIGNsYXNzPVwic2ItaG92ZXItcHJldmlldyBwd3ItaG92ZXItcHJldmlld1wiIHNyYz1cIiR7cHJldmlld1BhdGh9XCIgbG9vcCBtdXRlZCBwbGF5c2lubGluZT48L3ZpZGVvPmAgOiBcIlwifVxuICAgICAgICAgIDwvYT5cbiAgICAgICAgICA8ZGl2IGNsYXNzPVwic2Itc2NlbmUtZHVyYXRpb25cIj4ke2Zvcm1hdER1cmF0aW9uKGR1cmF0aW9uKX08L2Rpdj5cbiAgICAgICAgICAke3N0YXR1c0JhZGdlSHRtbH1cbiAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItY2xpY2staGludFwiPiR7b3BlbkluTmV3VGFiID8gXCJDbGljayB0byBvcGVuIGluIG5ldyB0YWJcIiA6IFwiQ2xpY2sgdG8gb3BlbiBzY2VuZVwifTwvZGl2PlxuICAgICAgICAgIDxhIGNsYXNzPVwic2Itb3Blbi1saW5rXCIgaHJlZj1cIiR7c2NlbmVVcmx9XCIgdGFyZ2V0PVwiX2JsYW5rXCIgcmVsPVwibm9vcGVuZXJcIiB0aXRsZT1cIk9wZW4gc2NlbmUgaW4gbmV3IHRhYlwiPuKGlzwvYT5cbiAgICAgICAgICAke2NsZWFuTW9kZSAmJiBpc1N0YXNoRGVsZXRlRGlhbG9nQXZhaWxhYmxlKCkgPyBgPGJ1dHRvbiB0eXBlPVwiYnV0dG9uXCIgY2xhc3M9XCJzYi1kZWxldGUtYnRuXCIgdGl0bGU9XCJEZWxldGUgdGhpcyBzY2VuZSBmcm9tIFN0YXNoXCI+8J+XkTwvYnV0dG9uPmAgOiBcIlwifVxuICAgICAgICA8L2Rpdj5cblxuICAgICAgICA8ZGl2IGNsYXNzPVwic2Itc2NlbmUtYm9keVwiIGRhdGEtd2lubmVyPVwiJHtzY2VuZS5pZH1cIj5cbiAgICAgICAgICA8ZGl2IGNsYXNzPVwic2Itc2NlbmUtaW5mbyBwd3Itc2NlbmUtaW5mb1wiPlxuICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNiLXNjZW5lLXRpdGxlLXJvd1wiPlxuICAgICAgICAgICAgICA8aDMgY2xhc3M9XCJzYi1zY2VuZS10aXRsZVwiPiR7dGl0bGV9PC9oMz5cbiAgICAgICAgICAgICAgJHtyYW5rRGlzcGxheX1cbiAgICAgICAgICAgIDwvZGl2PlxuXG4gICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2Itc2NlbmUtbWV0YVwiPlxuICAgICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItbWV0YS1pdGVtIHNiLW1ldGEtc3R1ZGlvXCI+PHN0cm9uZz5TdHVkaW86PC9zdHJvbmc+ICR7c3R1ZGlvfTwvZGl2PlxuICAgICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItbWV0YS1pdGVtIHNiLW1ldGEtcGVyZm9ybWVyc1wiPjxzdHJvbmc+UGVyZm9ybWVyczo8L3N0cm9uZz4gJHtwZXJmb3JtZXJzfTwvZGl2PlxuICAgICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItbWV0YS1pdGVtIHNiLW1ldGEtcGxheXNcIj48c3Ryb25nPlBsYXkgQ291bnQ6PC9zdHJvbmc+ICR7c2NlbmUucGxheV9jb3VudCB8fCAwfTwvZGl2PlxuICAgICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItbWV0YS1pdGVtIHNiLW1ldGEtYmF0dGxlc1wiPjxzdHJvbmc+QmF0dGxlczo8L3N0cm9uZz4gJHtiYXR0bGVzKHNjZW5lKX08L2Rpdj5cbiAgICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNiLW1ldGEtaXRlbSBzYi1tZXRhLXJhdGluZ1wiPjxzdHJvbmc+U3Rhc2ggUmF0aW5nOjwvc3Ryb25nPiAke3N0YXNoUmF0aW5nfTwvZGl2PlxuICAgICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItbWV0YS1pdGVtIHNiLXRhZ3Mtcm93XCI+PHN0cm9uZz5UYWdzOjwvc3Ryb25nPiAke3RhZ3MubGVuZ3RoID4gMCA/IHRhZ3MubWFwKCh0YWcpID0+IGA8c3BhbiBjbGFzcz1cInNiLXRhZ1wiPiR7dGFnfTwvc3Bhbj5gKS5qb2luKFwiXCIpIDogJzxzcGFuIGNsYXNzPVwic2Itbm9uZVwiPk5vbmU8L3NwYW4+J308L2Rpdj5cbiAgICAgICAgICAgIDwvZGl2PlxuICAgICAgICAgIDwvZGl2PlxuXG4gICAgICAgICAgPGRpdiBjbGFzcz1cInNiLWNob29zZS1idG5cIj5cbiAgICAgICAgICAgIOKckyBDaG9vc2U8c3BhbiBjbGFzcz1cInNiLWNob29zZS1sb25nXCI+IFRoaXMgU2NlbmU8L3NwYW4+XG4gICAgICAgICAgPC9kaXY+XG4gICAgICAgIDwvZGl2PlxuICAgICAgPC9kaXY+XG4gICAgYDtcbn1cbiIsICIvLyBWaWN0b3J5IGFuZCBwbGFjZW1lbnQgZW5kLXNjcmVlbnMgZm9yIENoYW1waW9uIGFuZCBQbGFjZW1lbnQgcnVucy5cblxuaW1wb3J0IHsgbGF0ZXN0U2NlbmUgfSBmcm9tIFwiLi4vY2FjaGVcIjtcbmltcG9ydCB7IGVsbywgc3Rhc2hSYXRpbmdUYXJnZXRzIH0gZnJvbSBcIi4uL3Njb3JlXCI7XG5pbXBvcnQgeyByZXNldFJ1blN0YXRlLCBzdGF0ZSB9IGZyb20gXCIuLi9zdGF0ZVwiO1xuaW1wb3J0IHsgc2F2ZVN0YXRlIH0gZnJvbSBcIi4uL3N0b3JhZ2VcIjtcbmltcG9ydCB0eXBlIHsgUGxhY2VtZW50UGFpclJlc3VsdCwgU2NlbmUgfSBmcm9tIFwiLi4vdHlwZXNcIjtcbmltcG9ydCB7IGxvYWROZXdQYWlyLCBzZXRBY3Rpb25zVmlzaWJsZSB9IGZyb20gXCIuL21haW5VSVwiO1xuaW1wb3J0IHsgcmVzb2x2ZVNjZW5lVGl0bGUgfSBmcm9tIFwiLi9zY2VuZVRpdGxlXCI7XG5cbmZ1bmN0aW9uIGJ1aWxkRW5kU2NyZWVuSHRtbChcbiAgc2NlbmU6IFNjZW5lLFxuICBjcm93bjogc3RyaW5nLFxuICBoZWFkbGluZTogc3RyaW5nLFxuICBzdGF0c0h0bWw6IHN0cmluZyxcbiAgYnV0dG9uTGFiZWw6IHN0cmluZyxcbik6IHN0cmluZyB7XG4gIGNvbnN0IHRpdGxlID0gcmVzb2x2ZVNjZW5lVGl0bGUoc2NlbmUpO1xuICBjb25zdCBzY3JlZW5zaG90UGF0aCA9IHNjZW5lLnBhdGhzPy5zY3JlZW5zaG90ID8/IG51bGw7XG5cbiAgcmV0dXJuIGBcbiAgICAgIDxkaXYgY2xhc3M9XCJzYi1lbmQtc2NyZWVuXCI+XG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi1lbmQtc2NyZWVuLWljb25cIj4ke2Nyb3dufTwvZGl2PlxuICAgICAgICA8aDIgY2xhc3M9XCJzYi1lbmQtc2NyZWVuLWhlYWRsaW5lXCI+JHtoZWFkbGluZX08L2gyPlxuICAgICAgICA8ZGl2IGNsYXNzPVwic2ItZW5kLXNjcmVlbi1zY2VuZSBwd3Itc2NlbmUtaW1hZ2UtY29udGFpbmVyXCI+XG4gICAgICAgICAgJHtcbiAgICAgICAgICAgIHNjcmVlbnNob3RQYXRoXG4gICAgICAgICAgICAgID8gYDxpbWcgY2xhc3M9XCJzYi1lbmQtc2NyZWVuLWltYWdlIHB3ci1zY2VuZS1pbWFnZVwiIHNyYz1cIiR7c2NyZWVuc2hvdFBhdGh9XCIgYWx0PVwiJHt0aXRsZX1cIiAvPmBcbiAgICAgICAgICAgICAgOiBgPGRpdiBjbGFzcz1cInNiLWVuZC1zY3JlZW4taW1hZ2Ugc2Itbm8taW1hZ2VcIj5ObyBTY3JlZW5zaG90PC9kaXY+YFxuICAgICAgICAgIH1cbiAgICAgICAgPC9kaXY+XG4gICAgICAgIDxoMyBjbGFzcz1cInNiLWVuZC1zY3JlZW4tbmFtZVwiPiR7dGl0bGV9PC9oMz5cbiAgICAgICAgPHAgY2xhc3M9XCJzYi1lbmQtc2NyZWVuLXN0YXRzXCI+JHtzdGF0c0h0bWx9PC9wPlxuICAgICAgICA8YnV0dG9uIGlkPVwic2ItbmV3LXJ1blwiIGNsYXNzPVwiYnRuIGJ0bi1wcmltYXJ5XCI+JHtidXR0b25MYWJlbH08L2J1dHRvbj5cbiAgICAgIDwvZGl2PlxuICAgIGA7XG59XG5cbi8qKiBSZW5kZXIgYW4gZW5kIHNjcmVlbiwgaGlkZSBiYXR0bGUgY29udHJvbHMsIGFuZCB3aXJlIHRoZSBuZXctcnVuIGJ1dHRvbi4gKi9cbmZ1bmN0aW9uIHNob3dFbmRTY3JlZW4oaHRtbDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IGNvbXBhcmlzb25BcmVhID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzYi1jb21wYXJpc29uLWFyZWFcIik7XG4gIGlmICghY29tcGFyaXNvbkFyZWEpIHJldHVybjtcblxuICBjb21wYXJpc29uQXJlYS5pbm5lckhUTUwgPSBodG1sO1xuICBzZXRBY3Rpb25zVmlzaWJsZShmYWxzZSk7XG5cbiAgY29tcGFyaXNvbkFyZWEucXVlcnlTZWxlY3RvcihcIiNzYi1uZXctcnVuXCIpPy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4ge1xuICAgIGxvYWROZXdQYWlyKCk7XG4gIH0pO1xufVxuXG4vKiogQ2FwdHVyZSBkaXNwbGF5IHZhbHVlcywgY2xlYXIgcnVuIHN0YXRlLCB0aGVuIHNob3cgdGhlIGVuZCBzY3JlZW4uICovXG5mdW5jdGlvbiBmaW5pc2hSdW5TaG93RW5kU2NyZWVuKGh0bWw6IHN0cmluZyk6IHZvaWQge1xuICByZXNldFJ1blN0YXRlKCk7XG4gIC8vIFRoZSBsYXN0IHBhaXIgYmVsb25ncyB0byB0aGUgZmluaXNoZWQgcnVuOiBhIHJlbG9hZCBtdXN0bid0IHJlc3RvcmUgaXQgd2l0aG91dCBpdHMgcnVuXG4gIHN0YXRlLmN1cnJlbnRQYWlyID0geyBsZWZ0OiBudWxsLCByaWdodDogbnVsbCB9O1xuICBzdGF0ZS5jdXJyZW50UmFua3MgPSB7IGxlZnQ6IG51bGwsIHJpZ2h0OiBudWxsIH07XG4gIHNhdmVTdGF0ZSgpO1xuICBzaG93RW5kU2NyZWVuKGh0bWwpO1xufVxuXG4vKipcbiAqIFwiRUxPOiAxNzQwXCIsIHBsdXMgXCLCtyBTdGFzaCBSYXRpbmc6IDc0XCIgd2hpbGUgYW4gdXBkYXRlIG1vZGUgaXMgb24uIFRoZSByYXRpbmcgaXMgd29ya2VkIG91dFxuICogdGhlIHdheSB0aGUgc3luYyBkb2VzIGl0IChpdCBtYXkgc3RpbGwgYmUgb24gaXRzIHdheSB0byBTdGFzaCksIHNvIGl0J3Mgd2hhdCBTdGFzaCB3aWxsIHNob3cuXG4gKi9cbmZ1bmN0aW9uIGVsb0xpbmUoc2NlbmU6IFNjZW5lLCB2YWx1ZTogbnVtYmVyIHwgbnVsbCk6IHN0cmluZyB7XG4gIGlmICh2YWx1ZSA9PT0gbnVsbCkgcmV0dXJuIFwiXCI7XG4gIGxldCBsaW5lID0gYDxicj5FTE86IDxzdHJvbmc+JHtNYXRoLnJvdW5kKHZhbHVlKX08L3N0cm9uZz5gO1xuICBjb25zdCBtb2RlID0gc3RhdGUuc2V0dGluZ3Muc3Rhc2hSYXRpbmdzO1xuICBjb25zdCBzY2VuZXMgPSBzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXM7XG4gIGlmIChtb2RlICE9PSBcIm9mZlwiICYmIHNjZW5lcykge1xuICAgIGNvbnN0IHJhdGluZyA9IHN0YXNoUmF0aW5nVGFyZ2V0cyhzY2VuZXMsIG1vZGUpLmdldChzY2VuZS5pZCk7XG4gICAgaWYgKHJhdGluZyAhPT0gdW5kZWZpbmVkKSBsaW5lICs9IGAgwrcgU3Rhc2ggUmF0aW5nOiA8c3Ryb25nPiR7cmF0aW5nfTwvc3Ryb25nPmA7XG4gIH1cbiAgcmV0dXJuIGxpbmU7XG59XG5cbi8qKiBDaGFtcGlvbiBiZWF0IGV2ZXJ5IHNjZW5lIGFib3ZlIGl0LCBvciBhIGNsaW1iIGZyb20gdGhlIGJvdHRvbSBuZXZlciBsb3N0OiBpdCdzICMxLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNob3dWaWN0b3J5U2NyZWVuKGNoYW1waW9uOiBTY2VuZSwgd2luU3RyZWFrOiBudW1iZXIpOiB2b2lkIHtcbiAgY29uc3QgaHRtbCA9IGJ1aWxkRW5kU2NyZWVuSHRtbChcbiAgICBjaGFtcGlvbixcbiAgICBcIvCfkZFcIixcbiAgICBcIkNIQU1QSU9OIVwiLFxuICAgIGBSZWFjaGVkIHRoZSB0b3A6ICR7d2luU3RyZWFrfSB3aW4ke3dpblN0cmVhayA9PT0gMSA/IFwiXCIgOiBcInNcIn0gaW4gYSByb3chJHtlbG9MaW5lKGNoYW1waW9uLCBlbG8obGF0ZXN0U2NlbmUoY2hhbXBpb24pKSl9YCxcbiAgICBcIlN0YXJ0IE5ldyBSdW5cIixcbiAgKTtcblxuICBmaW5pc2hSdW5TaG93RW5kU2NyZWVuKGh0bWwpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2hvd1BsYWNlbWVudFNjcmVlbihyZXN1bHQ6IEV4dHJhY3Q8UGxhY2VtZW50UGFpclJlc3VsdCwgeyBkb25lOiB0cnVlIH0+KTogdm9pZCB7XG4gIGNvbnN0IHsgc2NlbmUsIHJhbmssIGJhdHRsZXMsIHN0cmVhaywgZnJvbUJvdHRvbSB9ID0gcmVzdWx0O1xuICBjb25zdCBzdHJlYWtUZXh0ID0gZnJvbUJvdHRvbSAmJiBzdHJlYWsgPiAwID8gYPCflKUgJHtzdHJlYWt9IHdpbiBzdHJlYWsgwrcgYCA6IFwiXCI7XG4gIGNvbnN0IGJhdHRsZXNUZXh0ID0gYmF0dGxlcyA/IGAgwrcgJHtiYXR0bGVzfSBiYXR0bGUke2JhdHRsZXMgPT09IDEgPyBcIlwiIDogXCJzXCJ9YCA6IFwiXCI7XG4gIGNvbnN0IGh0bWwgPSBidWlsZEVuZFNjcmVlbkh0bWwoXG4gICAgc2NlbmUsXG4gICAgXCLwn5ONXCIsXG4gICAgXCJQTEFDRUQhXCIsXG4gICAgYCR7c3RyZWFrVGV4dH1SYW5rIDxzdHJvbmc+IyR7cmFua308L3N0cm9uZz4gb2YgJHtzdGF0ZS50b3RhbFNjZW5lc0NvdW50fSR7YmF0dGxlc1RleHR9JHtlbG9MaW5lKHNjZW5lLCByZXN1bHQuZWxvKX1gLFxuICAgIFwiU3RhcnQgTmV3IFJ1blwiLFxuICApO1xuXG4gIGZpbmlzaFJ1blNob3dFbmRTY3JlZW4oaHRtbCk7XG59XG4iLCAiLy8gV2hhdCBlYWNoIFwiU3Rhc2ggcmF0aW5nc1wiIG9wdGlvbiBkb2VzLCBzaGFyZWQgYnkgdGhlIHNldHVwIHNjcmVlbiBhbmQgdGhlIFNldHRpbmdzIGRyb3Bkb3duLlxuXG5pbXBvcnQgdHlwZSB7IFN0YXNoUmF0aW5nc01vZGUgfSBmcm9tIFwiLi4vdHlwZXNcIjtcblxuZXhwb3J0IGNvbnN0IFNUQVNIX1JBVElOR1NfT1BUSU9OUzogcmVhZG9ubHkgeyB2YWx1ZTogU3Rhc2hSYXRpbmdzTW9kZTsgbGFiZWw6IHN0cmluZzsgZGVzYzogc3RyaW5nIH1bXSA9IFtcbiAgeyB2YWx1ZTogXCJvZmZcIiwgbGFiZWw6IFwiRG9uJ3QgdXBkYXRlXCIsIGRlc2M6IFwiRUxPIGlzIHNhdmVkOyB5b3VyIFN0YXNoIHJhdGluZ3Mgc3RheSBhcyB0aGV5IGFyZS5cIiB9LFxuICB7XG4gICAgdmFsdWU6IFwibGluZWFyXCIsXG4gICAgbGFiZWw6IFwiU3RyYWlnaHQtbGluZVwiLFxuICAgIGRlc2M6IFwiUmF0aW5nID0gRUxPIGNvbnZlcnRlZCBiYWNrICgxNTAwID0gNTAsIDEwIEVMTyBwZXIgcG9pbnQpLiBWZXJ5IGhpZ2ggb3IgbG93IHNjZW5lcyBzdG9wIGF0IDEwMCBvciAxLlwiLFxuICB9LFxuICB7XG4gICAgdmFsdWU6IFwicGVyY2VudGlsZVwiLFxuICAgIGxhYmVsOiBcIlBlcmNlbnRpbGVcIixcbiAgICBkZXNjOiBcIlJhdGluZyA9IHBlcmNlbnRpbGUgaW4geW91ciBsaWJyYXJ5OiA5MCBtZWFucyB0aGUgc2NlbmUgcmFua3MgYWJvdmUgYWJvdXQgOTAlIG9mIHlvdXIgc2NlbmVzLiBUb3Agc2NlbmUgMTAwLCBib3R0b20gMS5cIixcbiAgfSxcbl07XG5cbmV4cG9ydCBmdW5jdGlvbiBzdGFzaFJhdGluZ3NPcHRpb24odmFsdWU6IFN0YXNoUmF0aW5nc01vZGUpOiAodHlwZW9mIFNUQVNIX1JBVElOR1NfT1BUSU9OUylbbnVtYmVyXSB7XG4gIHJldHVybiBTVEFTSF9SQVRJTkdTX09QVElPTlMuZmluZCgob3B0aW9uKSA9PiBvcHRpb24udmFsdWUgPT09IHZhbHVlKSA/PyBTVEFTSF9SQVRJTkdTX09QVElPTlNbMF07XG59XG4iLCAiLy8gQmF0dGxlIC8gU2V0dGluZ3MgdGFicyAoU3Rhc2gncyBvd24gbmF2LXRhYnMgKyAuc2V0dGluZyByb3dzLCBsaWtlIFN0YXNoLVRDb2RlKSwgcGx1cyB0aGVcbi8vIHByZXZpZXcgdm9sdW1lIGNvbnRyb2wgdGhhdCBzaXRzIG9uIHRoZSB0YWIgYmFyLiBFdmVyeSBjb250cm9sIGNhcnJpZXMgZGF0YS1zZXR0aW5nPVwiPGtleT5cIjtcbi8vIHZhbHVlcyBwZXJzaXN0IHZpYSB1cGRhdGVTZXR0aW5ncygpLiBBY3Rpb24gcm93cyAoUmVzZXQgRUxPKSBjYXJyeSBkYXRhLWFjdGlvbiBpbnN0ZWFkLlxuXG5pbXBvcnQgeyB1cGRhdGVTZXR0aW5ncyB9IGZyb20gXCIuLi9zZXR0aW5nc1wiO1xuaW1wb3J0IHsgc3RhdGUgfSBmcm9tIFwiLi4vc3RhdGVcIjtcbmltcG9ydCB0eXBlIHsgU2V0dGluZ3MsIFN0YXNoUmF0aW5nc01vZGUgfSBmcm9tIFwiLi4vdHlwZXNcIjtcbmltcG9ydCB7IFNUQVNIX1JBVElOR1NfT1BUSU9OUywgc3Rhc2hSYXRpbmdzT3B0aW9uIH0gZnJvbSBcIi4vc3Rhc2hSYXRpbmdzVGV4dFwiO1xuXG50eXBlIEJvb2xLZXkgPSB7IFtLIGluIGtleW9mIFNldHRpbmdzXTogU2V0dGluZ3NbS10gZXh0ZW5kcyBib29sZWFuID8gSyA6IG5ldmVyIH1ba2V5b2YgU2V0dGluZ3NdO1xuZXhwb3J0IHR5cGUgVGFiSWQgPSBcImJhdHRsZVwiIHwgXCJzZXR0aW5nc1wiO1xuXG50eXBlIFNldHRpbmdSb3cgPVxuICB8IHsga2V5OiBrZXlvZiBTZXR0aW5nczsgdGl0bGU6IHN0cmluZzsgaGludDogc3RyaW5nIH1cbiAgfCB7IGFjdGlvbjogXCJyZXNldC1lbG9cIjsgdGl0bGU6IHN0cmluZzsgaGludDogc3RyaW5nOyBidXR0b246IHN0cmluZyB9O1xuXG5jb25zdCBTRUNUSU9OUzogeyB0aXRsZTogc3RyaW5nOyByb3dzOiBTZXR0aW5nUm93W10gfVtdID0gW1xuICB7XG4gICAgdGl0bGU6IFwiRUxPXCIsXG4gICAgcm93czogW1xuICAgICAgLy8gVGhlIGhpbnQgaXMgdGhlIHNlbGVjdGVkIG9wdGlvbidzIGRlc2NyaXB0aW9uIChrZXB0IGN1cnJlbnQgYnkgc3luY1NldHRpbmdzQ29udHJvbHMpXG4gICAgICB7IGtleTogXCJzdGFzaFJhdGluZ3NcIiwgdGl0bGU6IFwiU3Rhc2ggcmF0aW5ncyB1cGRhdGUgbW9kZVwiLCBoaW50OiBcIlwiIH0sXG4gICAgICB7XG4gICAgICAgIGFjdGlvbjogXCJyZXNldC1lbG9cIixcbiAgICAgICAgdGl0bGU6IFwiUmVzZXQgRUxPXCIsXG4gICAgICAgIGhpbnQ6IFwiU3RhcnQgZXZlcnkgc2NlbmUncyBFTE8gb3ZlciwgZnJvbSBpdHMgU3Rhc2ggcmF0aW5nIG9yIGF0IDE1MDBcIixcbiAgICAgICAgYnV0dG9uOiBcIlJlc2V0IEVMT+KAplwiLFxuICAgICAgfSxcbiAgICBdLFxuICB9LFxuICB7XG4gICAgdGl0bGU6IFwiQmF0dGxlc1wiLFxuICAgIHJvd3M6IFtcbiAgICAgIHsga2V5OiBcImZpbHRlck9wcG9uZW50c1wiLCB0aXRsZTogXCJVc2UgZmlsdGVyZWQgc2NlbmVzIGZvciBib3RoIHNpZGVzXCIsIGhpbnQ6IFwiT3Bwb25lbnRzIGFsc28gY29tZSBmcm9tIHRoZSBjdXJyZW50IHNjZW5lIGxpc3QgZmlsdGVyIGluc3RlYWQgb2YgeW91ciB3aG9sZSByYXRlZCBsaWJyYXJ5XCIgfSxcbiAgICAgIHsga2V5OiBcInBsYWNlbWVudEZyb21Cb3R0b21cIiwgdGl0bGU6IFwiUGxhY2VtZW50OiBzdGFydCBmcm9tIHRoZSBib3R0b21cIiwgaGludDogXCJQbGFjZW1lbnQgaWdub3JlcyB0aGUgc2NlbmUncyBjdXJyZW50IEVMTzogaXQgc3RhcnRzIGFnYWluc3QgdGhlIGJvdHRvbSBzY2VuZSBhbmQgY2xpbWJzLCBqdW1waW5nIGZ1cnRoZXIgd2l0aCBlYWNoIHdpbiAodGhpcyByZXBsYWNlcyBHYXVudGxldClcIiB9LFxuICAgIF0sXG4gIH0sXG4gIHtcbiAgICB0aXRsZTogXCJTY2VuZXNcIixcbiAgICByb3dzOiBbXG4gICAgICB7IGtleTogXCJhdXRvcGxheVByZXZpZXdzXCIsIHRpdGxlOiBcIkF1dG9wbGF5IHByZXZpZXdzXCIsIGhpbnQ6IFwiTG9vcCBib3RoIHByZXZpZXdzIHNpbGVudGx5OyBob3ZlciBhIGNhcmQgdG8gaGVhciBpdFwiIH0sXG4gICAgICB7IGtleTogXCJwYXVzZU1lZGlhT25PcGVuXCIsIHRpdGxlOiBcIlBhdXNlIHBsYXlpbmcgdmlkZW8gd2hlbiBTdGFzaCBCYXR0bGUgb3BlbnNcIiwgaGludDogXCJTdG9wcyB0aGUgc2NlbmUgeW91J3JlIHdhdGNoaW5nIHNvIGl0cyBhdWRpbyBkb2Vzbid0IG92ZXJsYXAgdGhlIGJhdHRsZSBwcmV2aWV3c1wiIH0sXG4gICAgICB7IGtleTogXCJvcGVuSW5OZXdUYWJcIiwgdGl0bGU6IFwiT3BlbiBzY2VuZXMgaW4gYSBuZXcgdGFiXCIsIGhpbnQ6IFwiQ2xpY2tpbmcgYSB0aHVtYm5haWwgb3BlbnMgdGhlIHNjZW5lIGluIGEgbmV3IGJyb3dzZXIgdGFiXCIgfSxcbiAgICAgIHsga2V5OiBcImNsZWFuTW9kZVwiLCB0aXRsZTogXCJDbGVhbiBtb2RlXCIsIGhpbnQ6IFwiU2hvdyBhIPCfl5EgYnV0dG9uIG9uIGVhY2ggY2FyZCB0byBkZWxldGUgdGhlIHNjZW5lIGZyb20gU3Rhc2hcIiB9LFxuICAgIF0sXG4gIH0sXG5dO1xuXG4vKiogVm9sdW1lIHJlc3RvcmVkIHdoZW4gdW5tdXRpbmcgZnJvbSAwIHdpdGggbm8gZWFybGllciBsZXZlbCB0aGlzIHNlc3Npb24uICovXG5jb25zdCBERUZBVUxUX1VOTVVURV9WT0xVTUUgPSA1MDtcbmxldCB2b2x1bWVCZWZvcmVNdXRlOiBudW1iZXIgfCBudWxsID0gbnVsbDtcblxubGV0IGFjdGl2ZVRhYjogVGFiSWQgPSBcImJhdHRsZVwiO1xuXG5leHBvcnQgZnVuY3Rpb24gZ2V0QWN0aXZlVGFiKCk6IFRhYklkIHtcbiAgcmV0dXJuIGFjdGl2ZVRhYjtcbn1cblxuZnVuY3Rpb24gdm9sdW1lSWNvbih2b2x1bWU6IG51bWJlcik6IHN0cmluZyB7XG4gIGlmICh2b2x1bWUgPT09IDApIHJldHVybiBcIvCflIdcIjtcbiAgcmV0dXJuIHZvbHVtZSA8IDUwID8gXCLwn5SJXCIgOiBcIvCflIpcIjtcbn1cblxuZnVuY3Rpb24gc2V0dGluZ0NvbnRyb2woa2V5OiBrZXlvZiBTZXR0aW5ncyk6IHN0cmluZyB7XG4gIGlmIChrZXkgPT09IFwic3Rhc2hSYXRpbmdzXCIpIHtcbiAgICBjb25zdCBvcHRpb25zID0gU1RBU0hfUkFUSU5HU19PUFRJT05TLm1hcChcbiAgICAgICh7IHZhbHVlLCBsYWJlbCB9KSA9PlxuICAgICAgICBgPG9wdGlvbiB2YWx1ZT1cIiR7dmFsdWV9XCIgJHt2YWx1ZSA9PT0gc3RhdGUuc2V0dGluZ3Muc3Rhc2hSYXRpbmdzID8gXCJzZWxlY3RlZFwiIDogXCJcIn0+JHtsYWJlbH08L29wdGlvbj5gLFxuICAgICkuam9pbihcIlwiKTtcbiAgICByZXR1cm4gYDxzZWxlY3QgZGF0YS1zZXR0aW5nPVwiJHtrZXl9XCIgY2xhc3M9XCJmb3JtLWNvbnRyb2wgZm9ybS1jb250cm9sLXNtIHNiLXNldHRpbmctc2VsZWN0XCIgYXJpYS1sYWJlbD1cIlN0YXNoIHJhdGluZ3MgdXBkYXRlIG1vZGVcIj4ke29wdGlvbnN9PC9zZWxlY3Q+YDtcbiAgfVxuICBjb25zdCBpZCA9IGBzYi1zZXR0aW5nLSR7a2V5fWA7XG4gIHJldHVybiBgXG4gICAgICAgICAgPGRpdiBjbGFzcz1cImN1c3RvbS1jb250cm9sIGN1c3RvbS1zd2l0Y2hcIj5cbiAgICAgICAgICAgIDxpbnB1dCB0eXBlPVwiY2hlY2tib3hcIiBjbGFzcz1cImN1c3RvbS1jb250cm9sLWlucHV0XCIgaWQ9XCIke2lkfVwiIGRhdGEtc2V0dGluZz1cIiR7a2V5fVwiICR7c3RhdGUuc2V0dGluZ3Nba2V5IGFzIEJvb2xLZXldID8gXCJjaGVja2VkXCIgOiBcIlwifT5cbiAgICAgICAgICAgIDxsYWJlbCBjbGFzcz1cImN1c3RvbS1jb250cm9sLWxhYmVsXCIgZm9yPVwiJHtpZH1cIj48L2xhYmVsPlxuICAgICAgICAgIDwvZGl2PmA7XG59XG5cbi8qKiBUYWIgYmFyOiBCYXR0bGUgLyBTZXR0aW5ncyBvbiB0aGUgbGVmdCwgcHJldmlldyB2b2x1bWUgb24gdGhlIHJpZ2h0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVRhYkJhcigpOiBzdHJpbmcge1xuICBjb25zdCB7IHByZXZpZXdWb2x1bWUgfSA9IHN0YXRlLnNldHRpbmdzO1xuICByZXR1cm4gYFxuICAgICAgPGRpdiBjbGFzcz1cInNiLXRhYi1iYXJcIj5cbiAgICAgICAgPG5hdiBjbGFzcz1cIm5hdiBuYXYtdGFicyBzYi10YWJzXCIgcm9sZT1cInRhYmxpc3RcIj5cbiAgICAgICAgICA8YSBjbGFzcz1cIm5hdi1pdGVtIG5hdi1saW5rIGFjdGl2ZVwiIHJvbGU9XCJ0YWJcIiBkYXRhLXRhYj1cImJhdHRsZVwiIGFyaWEtc2VsZWN0ZWQ9XCJ0cnVlXCI+4pqU77iPIEJhdHRsZTwvYT5cbiAgICAgICAgICA8YSBjbGFzcz1cIm5hdi1pdGVtIG5hdi1saW5rXCIgcm9sZT1cInRhYlwiIGRhdGEtdGFiPVwic2V0dGluZ3NcIiBhcmlhLXNlbGVjdGVkPVwiZmFsc2VcIj7impkgU2V0dGluZ3M8L2E+XG4gICAgICAgIDwvbmF2PlxuICAgICAgICA8ZGl2IGNsYXNzPVwic2Itdm9sdW1lXCIgdGl0bGU9XCJQcmV2aWV3IHZvbHVtZVwiPlxuICAgICAgICAgIDxidXR0b24gdHlwZT1cImJ1dHRvblwiIGNsYXNzPVwic2Itdm9sdW1lLWljb25cIiBhcmlhLWxhYmVsPVwiTXV0ZSBwcmV2aWV3c1wiPiR7dm9sdW1lSWNvbihwcmV2aWV3Vm9sdW1lKX08L2J1dHRvbj5cbiAgICAgICAgICA8aW5wdXQgdHlwZT1cInJhbmdlXCIgbWluPVwiMFwiIG1heD1cIjEwMFwiIHN0ZXA9XCIxXCIgZGF0YS1zZXR0aW5nPVwicHJldmlld1ZvbHVtZVwiIHZhbHVlPVwiJHtwcmV2aWV3Vm9sdW1lfVwiIGFyaWEtbGFiZWw9XCJQcmV2aWV3IHZvbHVtZVwiPlxuICAgICAgICAgIDxzcGFuIGNsYXNzPVwic2Itdm9sdW1lLXZhbHVlXCI+JHtwcmV2aWV3Vm9sdW1lfTwvc3Bhbj5cbiAgICAgICAgPC9kaXY+XG4gICAgICA8L2Rpdj5cbiAgICBgO1xufVxuXG5mdW5jdGlvbiBzZXR0aW5nUm93SHRtbChyb3c6IFNldHRpbmdSb3cpOiBzdHJpbmcge1xuICBjb25zdCBoaW50ID0gXCJrZXlcIiBpbiByb3cgJiYgcm93LmtleSA9PT0gXCJzdGFzaFJhdGluZ3NcIiA/IHN0YXNoUmF0aW5nc09wdGlvbihzdGF0ZS5zZXR0aW5ncy5zdGFzaFJhdGluZ3MpLmRlc2MgOiByb3cuaGludDtcbiAgY29uc3QgaGludEZvciA9IFwia2V5XCIgaW4gcm93ID8gYCBkYXRhLWhpbnQtZm9yPVwiJHtyb3cua2V5fVwiYCA6IFwiXCI7XG4gIGNvbnN0IGNvbnRyb2wgPVxuICAgIFwia2V5XCIgaW4gcm93XG4gICAgICA/IHNldHRpbmdDb250cm9sKHJvdy5rZXkpXG4gICAgICA6IGA8YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cImJ0biBidG4tc2Vjb25kYXJ5IGJ0bi1zbVwiIGRhdGEtYWN0aW9uPVwiJHtyb3cuYWN0aW9ufVwiPiR7cm93LmJ1dHRvbn08L2J1dHRvbj5gO1xuICByZXR1cm4gYFxuICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNldHRpbmdcIj5cbiAgICAgICAgICAgICAgPGRpdj5cbiAgICAgICAgICAgICAgICA8aDM+JHtyb3cudGl0bGV9PC9oMz5cbiAgICAgICAgICAgICAgICA8ZGl2IGNsYXNzPVwic3ViLWhlYWRpbmdcIiR7aGludEZvcn0+JHtoaW50fTwvZGl2PlxuICAgICAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgICAgICAgPGRpdj4ke2NvbnRyb2x9PC9kaXY+XG4gICAgICAgICAgICA8L2Rpdj5gO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlU2V0dGluZ3NUYWIoKTogc3RyaW5nIHtcbiAgY29uc3Qgc2VjdGlvbnMgPSBTRUNUSU9OUy5tYXAoXG4gICAgKHsgdGl0bGUsIHJvd3MgfSkgPT4gYFxuICAgICAgICA8ZGl2IGNsYXNzPVwic2V0dGluZy1zZWN0aW9uXCI+XG4gICAgICAgICAgPGgxPiR7dGl0bGV9PC9oMT5cbiAgICAgICAgICA8ZGl2IGNsYXNzPVwiY2FyZFwiPlxuICAgICAgICAgICAgJHtyb3dzLm1hcChzZXR0aW5nUm93SHRtbCkuam9pbihcIlwiKX1cbiAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgPC9kaXY+YCxcbiAgKS5qb2luKFwiXCIpO1xuXG4gIHJldHVybiBgXG4gICAgICA8ZGl2IGNsYXNzPVwic2ItdGFiLXBhbmVsIHNiLXNldHRpbmdzLXRhYlwiIGRhdGEtcGFuZWw9XCJzZXR0aW5nc1wiIGhpZGRlbj5cbiAgICAgICAgJHtzZWN0aW9uc31cbiAgICAgICAgPHAgY2xhc3M9XCJzYi1zZXR0aW5ncy1ub3RlXCI+U2F2ZXMgdG8gU3Rhc2gsIGFsc28gdW5kZXIgU2V0dGluZ3Mg4oaSIFBsdWdpbnMuPC9wPlxuICAgICAgPC9kaXY+XG4gICAgYDtcbn1cblxuLyoqIFB1c2ggc3RhdGUuc2V0dGluZ3MgaW50byB0aGUgcmVuZGVyZWQgY29udHJvbHMgKGUuZy4gYWZ0ZXIgcmUtZmV0Y2hpbmcgc2V0dGluZ3Mgb24gcmVvcGVuKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzeW5jU2V0dGluZ3NDb250cm9scyhyb290OiBQYXJlbnROb2RlKTogdm9pZCB7XG4gIHJvb3QucXVlcnlTZWxlY3RvckFsbDxIVE1MSW5wdXRFbGVtZW50PihcImlucHV0W2RhdGEtc2V0dGluZ11cIikuZm9yRWFjaCgoaW5wdXQpID0+IHtcbiAgICBjb25zdCBrZXkgPSBpbnB1dC5kYXRhc2V0LnNldHRpbmcgYXMga2V5b2YgU2V0dGluZ3M7XG4gICAgY29uc3QgdmFsdWUgPSBzdGF0ZS5zZXR0aW5nc1trZXldO1xuICAgIGlmIChpbnB1dC50eXBlID09PSBcImNoZWNrYm94XCIpIGlucHV0LmNoZWNrZWQgPSBCb29sZWFuKHZhbHVlKTtcbiAgICBlbHNlIGlucHV0LnZhbHVlID0gU3RyaW5nKHZhbHVlKTtcbiAgfSk7XG4gIHJvb3QucXVlcnlTZWxlY3RvckFsbDxIVE1MU2VsZWN0RWxlbWVudD4oXCJzZWxlY3RbZGF0YS1zZXR0aW5nXVwiKS5mb3JFYWNoKChzZWxlY3QpID0+IHtcbiAgICBzZWxlY3QudmFsdWUgPSBTdHJpbmcoc3RhdGUuc2V0dGluZ3Nbc2VsZWN0LmRhdGFzZXQuc2V0dGluZyBhcyBrZXlvZiBTZXR0aW5nc10pO1xuICB9KTtcbiAgcm9vdC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PignW2RhdGEtaGludC1mb3I9XCJzdGFzaFJhdGluZ3NcIl0nKS5mb3JFYWNoKChoaW50KSA9PiB7XG4gICAgaGludC50ZXh0Q29udGVudCA9IHN0YXNoUmF0aW5nc09wdGlvbihzdGF0ZS5zZXR0aW5ncy5zdGFzaFJhdGluZ3MpLmRlc2M7XG4gIH0pO1xuICBjb25zdCB2b2x1bWUgPSBzdGF0ZS5zZXR0aW5ncy5wcmV2aWV3Vm9sdW1lO1xuICByb290LnF1ZXJ5U2VsZWN0b3JBbGwoXCIuc2Itdm9sdW1lLWljb25cIikuZm9yRWFjaCgoZWwpID0+IHtcbiAgICBlbC50ZXh0Q29udGVudCA9IHZvbHVtZUljb24odm9sdW1lKTtcbiAgICBlbC5zZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIsIHZvbHVtZSA9PT0gMCA/IFwiVW5tdXRlIHByZXZpZXdzXCIgOiBcIk11dGUgcHJldmlld3NcIik7XG4gIH0pO1xuICByb290LnF1ZXJ5U2VsZWN0b3JBbGwoXCIuc2Itdm9sdW1lLXZhbHVlXCIpLmZvckVhY2goKGVsKSA9PiAoZWwudGV4dENvbnRlbnQgPSBTdHJpbmcodm9sdW1lKSkpO1xufVxuXG4vKiogU2hvdyBhIHRhYi4gUGFuZWxzIGFyZSBzd2FwcGVkIGluIHBsYWNlLCBzbyBub3RoaW5nIGFib3ZlIHRoZSB0YWIgYmFyIG1vdmVzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNob3dUYWIocm9vdDogUGFyZW50Tm9kZSwgdGFiOiBUYWJJZCk6IHZvaWQge1xuICBhY3RpdmVUYWIgPSB0YWI7XG4gIHJvb3QucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oXCIuc2ItdGFicyAubmF2LWxpbmtcIikuZm9yRWFjaCgobGluaykgPT4ge1xuICAgIGNvbnN0IG9uID0gbGluay5kYXRhc2V0LnRhYiA9PT0gdGFiO1xuICAgIGxpbmsuY2xhc3NMaXN0LnRvZ2dsZShcImFjdGl2ZVwiLCBvbik7XG4gICAgbGluay5zZXRBdHRyaWJ1dGUoXCJhcmlhLXNlbGVjdGVkXCIsIFN0cmluZyhvbikpO1xuICB9KTtcbiAgcm9vdC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PihcIi5zYi10YWItcGFuZWxcIikuZm9yRWFjaCgocGFuZWwpID0+IHtcbiAgICBwYW5lbC5oaWRkZW4gPSBwYW5lbC5kYXRhc2V0LnBhbmVsICE9PSB0YWI7XG4gIH0pO1xufVxuXG4vKipcbiAqIFdpcmUgZXZlcnkgZGF0YS1zZXR0aW5nIGNvbnRyb2wsIHRoZSB0YWJzIGFuZCB0aGUgbXV0ZSBidXR0b24uXG4gKiBvbkNoYW5nZSBydW5zIGFmdGVyIGEgdmFsdWUgaXMgc3RvcmVkOyBvblRhYkNoYW5nZSBhZnRlciBhIHRhYiBzd2l0Y2guIEEgZHJvcGRvd24gY2hhbmdlXG4gKiBmaXJzdCBhd2FpdHMgYmVmb3JlQ2hhbmdlIChhIHdhcm5pbmcsIHNheSk6IGZhbHNlIHB1dHMgdGhlIGRyb3Bkb3duIGJhY2sgYW5kIHN0b3JlcyBub3RoaW5nLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYmluZFNldHRpbmdzQ29udHJvbHMoXG4gIHJvb3Q6IFBhcmVudE5vZGUsXG4gIG9uQ2hhbmdlOiAoa2V5OiBrZXlvZiBTZXR0aW5ncykgPT4gdm9pZCxcbiAgb25UYWJDaGFuZ2U6ICh0YWI6IFRhYklkKSA9PiB2b2lkLFxuICBiZWZvcmVDaGFuZ2U6IChrZXk6IGtleW9mIFNldHRpbmdzLCB2YWx1ZTogc3RyaW5nKSA9PiBQcm9taXNlPGJvb2xlYW4+ID0gYXN5bmMgKCkgPT4gdHJ1ZSxcbik6IHZvaWQge1xuICBjb25zdCBhcHBseSA9IChwYXRjaDogUGFydGlhbDxTZXR0aW5ncz4sIGtleToga2V5b2YgU2V0dGluZ3MpOiB2b2lkID0+IHtcbiAgICB1cGRhdGVTZXR0aW5ncyhwYXRjaCk7XG4gICAgc3luY1NldHRpbmdzQ29udHJvbHMocm9vdCk7XG4gICAgb25DaGFuZ2Uoa2V5KTtcbiAgfTtcblxuICByb290LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTElucHV0RWxlbWVudD4oXCJpbnB1dFtkYXRhLXNldHRpbmddXCIpLmZvckVhY2goKGlucHV0KSA9PiB7XG4gICAgY29uc3Qga2V5ID0gaW5wdXQuZGF0YXNldC5zZXR0aW5nIGFzIGtleW9mIFNldHRpbmdzO1xuICAgIC8vIFJhbmdlIHVwZGF0ZXMgbGl2ZSB3aGlsZSBkcmFnZ2luZzsgb3RoZXJzIG9uIGNvbW1pdFxuICAgIGNvbnN0IGV2ZW50TmFtZSA9IGlucHV0LnR5cGUgPT09IFwicmFuZ2VcIiA/IFwiaW5wdXRcIiA6IFwiY2hhbmdlXCI7XG4gICAgaW5wdXQuYWRkRXZlbnRMaXN0ZW5lcihldmVudE5hbWUsICgpID0+IHtcbiAgICAgIGNvbnN0IHZhbHVlID0gaW5wdXQudHlwZSA9PT0gXCJjaGVja2JveFwiID8gaW5wdXQuY2hlY2tlZCA6IE51bWJlcihpbnB1dC52YWx1ZSk7XG4gICAgICBhcHBseSh7IFtrZXldOiB2YWx1ZSB9IGFzIFBhcnRpYWw8U2V0dGluZ3M+LCBrZXkpO1xuICAgIH0pO1xuICB9KTtcblxuICByb290LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTFNlbGVjdEVsZW1lbnQ+KFwic2VsZWN0W2RhdGEtc2V0dGluZ11cIikuZm9yRWFjaCgoc2VsZWN0KSA9PiB7XG4gICAgY29uc3Qga2V5ID0gc2VsZWN0LmRhdGFzZXQuc2V0dGluZyBhcyBrZXlvZiBTZXR0aW5ncztcbiAgICBzZWxlY3QuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCBhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCB2YWx1ZSA9IHNlbGVjdC52YWx1ZTtcbiAgICAgIHNlbGVjdC5kaXNhYmxlZCA9IHRydWU7XG4gICAgICB0cnkge1xuICAgICAgICBpZiAoYXdhaXQgYmVmb3JlQ2hhbmdlKGtleSwgdmFsdWUpKSBhcHBseSh7IFtrZXldOiB2YWx1ZSBhcyBTdGFzaFJhdGluZ3NNb2RlIH0gYXMgUGFydGlhbDxTZXR0aW5ncz4sIGtleSk7XG4gICAgICAgIGVsc2Ugc3luY1NldHRpbmdzQ29udHJvbHMocm9vdCk7XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICBzZWxlY3QuZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfSk7XG5cbiAgLy8gU3BlYWtlciBpY29uOiBtdXRlLCBvciByZXN0b3JlIHRoZSBsZXZlbCBmcm9tIGJlZm9yZSBtdXRpbmdcbiAgcm9vdC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxCdXR0b25FbGVtZW50PihcIi5zYi12b2x1bWUtaWNvblwiKS5mb3JFYWNoKChidG4pID0+IHtcbiAgICBidG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHtcbiAgICAgIGNvbnN0IGN1cnJlbnQgPSBzdGF0ZS5zZXR0aW5ncy5wcmV2aWV3Vm9sdW1lO1xuICAgICAgaWYgKGN1cnJlbnQgPiAwKSB7XG4gICAgICAgIHZvbHVtZUJlZm9yZU11dGUgPSBjdXJyZW50O1xuICAgICAgICBhcHBseSh7IHByZXZpZXdWb2x1bWU6IDAgfSwgXCJwcmV2aWV3Vm9sdW1lXCIpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgYXBwbHkoeyBwcmV2aWV3Vm9sdW1lOiB2b2x1bWVCZWZvcmVNdXRlID8/IERFRkFVTFRfVU5NVVRFX1ZPTFVNRSB9LCBcInByZXZpZXdWb2x1bWVcIik7XG4gICAgICB9XG4gICAgfSk7XG4gIH0pO1xuXG4gIHJvb3QucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oXCIuc2ItdGFicyAubmF2LWxpbmtcIikuZm9yRWFjaCgobGluaykgPT4ge1xuICAgIGxpbmsuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHtcbiAgICAgIGNvbnN0IHRhYiA9IGxpbmsuZGF0YXNldC50YWIgYXMgVGFiSWQ7XG4gICAgICBpZiAodGFiID09PSBhY3RpdmVUYWIpIHJldHVybjtcbiAgICAgIHNob3dUYWIocm9vdCwgdGFiKTtcbiAgICAgIG9uVGFiQ2hhbmdlKHRhYik7XG4gICAgfSk7XG4gIH0pO1xufVxuIiwgIi8vIENvcmUgY29tcGFyaXNvbiBVSTogbGF5b3V0LCBwYWlyIHJlbmRlcmluZywgY2hvaWNlIGhhbmRsaW5nLCBhbmltYXRpb25zLlxuXG5pbXBvcnQgeyBjbGVhckZpbHRlcmVkQ2FjaGUsIGxhdGVzdFNjZW5lLCByZWZyZXNoU2NlbmVJbkNhY2hlLCByZW1vdmVTY2VuZUV2ZXJ5d2hlcmUgfSBmcm9tIFwiLi4vY2FjaGVcIjtcbmltcG9ydCB7IENIQU1QSU9OX1VOUkFURURfRUxPLCBDTElNQl9TTUFMTF9QT09MX1dBUk5fQVQgfSBmcm9tIFwiLi4vY29uc3RhbnRzXCI7XG5pbXBvcnQgeyBlbG9SZXN1bHQgfSBmcm9tIFwiLi4vZWxvXCI7XG5pbXBvcnQgeyByZWFkRmlsdGVycyB9IGZyb20gXCIuLi9maWx0ZXJzXCI7XG5pbXBvcnQgeyBmZXRjaFNjZW5lQnlJZCB9IGZyb20gXCIuLi9ncmFwaHFsXCI7XG5pbXBvcnQgeyBuYXZpZ2F0ZVRvVXJsIH0gZnJvbSBcIi4uL25hdmlnYXRpb25cIjtcbmltcG9ydCB7XG4gIGZldGNoQ2hhbXBpb25QYWlyLFxuICBmZXRjaFBsYWNlbWVudFBhaXIsXG4gIGZldGNoU3dpc3NQYWlyLFxuICBwYWlyUmFua3MsXG59IGZyb20gXCIuLi9wYWlyc1wiO1xuaW1wb3J0IHsgcmVjb3JkUGxhY2VtZW50UmVzdWx0IH0gZnJvbSBcIi4uL3BsYWNlbWVudFwiO1xuaW1wb3J0IHsgd3JpdGVFbG8gfSBmcm9tIFwiLi4vcmF0aW5nXCI7XG5pbXBvcnQgeyBmZXRjaFNjZW5lRmllbGRzIH0gZnJvbSBcIi4uL3NjZW5lQWN0aW9uc1wiO1xuaW1wb3J0IHsgYmF0dGxlcywgZWZmZWN0aXZlRWxvLCBrR2FtZXMgfSBmcm9tIFwiLi4vc2NvcmVcIjtcbmltcG9ydCB7IGlzRWxvU2V0dXBQZW5kaW5nLCBpc1J1bkFjdGl2ZSwgcmVzZXRSdW5TdGF0ZSwgcmVzZXRTaHVmZmxlLCBzdGF0ZSB9IGZyb20gXCIuLi9zdGF0ZVwiO1xuaW1wb3J0IHsgc2F2ZVN0YXRlIH0gZnJvbSBcIi4uL3N0b3JhZ2VcIjtcbmltcG9ydCB0eXBlIHsgTW9kZSwgUmFuaywgU2NlbmUgfSBmcm9tIFwiLi4vdHlwZXNcIjtcbmltcG9ydCB7IGNvbmZpcm1EZWxldGVTY2VuZSB9IGZyb20gXCIuL2RlbGV0ZURpYWxvZ1wiO1xuaW1wb3J0IHsgY3JlYXRlU2NlbmVDYXJkIH0gZnJvbSBcIi4vc2NlbmVDYXJkXCI7XG5pbXBvcnQgeyBzaG93UGxhY2VtZW50U2NyZWVuLCBzaG93VmljdG9yeVNjcmVlbiB9IGZyb20gXCIuL3NjcmVlbnNcIjtcbmltcG9ydCB7IGNyZWF0ZVNldHRpbmdzVGFiLCBjcmVhdGVUYWJCYXIsIGdldEFjdGl2ZVRhYiB9IGZyb20gXCIuL3NldHRpbmdzUGFuZWxcIjtcblxuY29uc3QgTU9ERVM6IHsgbW9kZTogTW9kZTsgaWNvbjogc3RyaW5nOyB0aXRsZTogc3RyaW5nOyBkZXNjOiBzdHJpbmc7IHRpcDogc3RyaW5nIH1bXSA9IFtcbiAge1xuICAgIG1vZGU6IFwic3dpc3NcIixcbiAgICBpY29uOiBcIuKalu+4j1wiLFxuICAgIHRpdGxlOiBcIlN3aXNzXCIsXG4gICAgZGVzYzogXCJGYWlyIG1hdGNodXBzXCIsXG4gICAgdGlwOiBcIkVhY2ggc2NlbmUgZmFjZXMgYW4gb3Bwb25lbnQgd2l0aCBhIHNpbWlsYXIgRUxPLiBCb3RoIHNjZW5lcycgRUxPIGNoYW5nZXMgYWZ0ZXIgZXZlcnkgcGljaywgYW5kIGV2ZXJ5IHNjZW5lIHN0YXlzIGluIHRoZSByb3RhdGlvbi5cIixcbiAgfSxcbiAge1xuICAgIG1vZGU6IFwicGxhY2VtZW50XCIsXG4gICAgaWNvbjogXCLwn5ONXCIsXG4gICAgdGl0bGU6IFwiUGxhY2VtZW50XCIsXG4gICAgZGVzYzogXCJQbGFjZSBhIHNjZW5lXCIsXG4gICAgdGlwOiBcIkZpbmRzIHdoZXJlIG9uZSBzY2VuZSBiZWxvbmdzLiBFYWNoIHBpY2sgbmFycm93cyB0aGUgcmFuZ2Ugb2YgcmFua3MgaXQgY291bGQgbGFuZCBpbiAoc2hvd24gb24gaXRzIGNhcmQpIHVudGlsIGl0cyBzcG90IGlzIGZvdW5kLCBhYm91dCAxMCBwaWNrcyBmb3IgYW4gdW5yYXRlZCBzY2VuZS5cXG5cXG5Mb29raW5nIGZvciBHYXVudGxldD8gVHVybiBvbiDigJxQbGFjZW1lbnQ6IHN0YXJ0IGZyb20gdGhlIGJvdHRvbeKAnSBpbiBTZXR0aW5ncyB0byBtYWtlIGEgc2NlbmUgY2xpbWIgdGhlIGxhZGRlciBmcm9tIHRoZSBib3R0b20uXCIsXG4gIH0sXG4gIHtcbiAgICBtb2RlOiBcImNoYW1waW9uXCIsXG4gICAgaWNvbjogXCLwn4+GXCIsXG4gICAgdGl0bGU6IFwiQ2hhbXBpb25cIixcbiAgICBkZXNjOiBcIldpbm5lciBzdGF5cyBvblwiLFxuICAgIHRpcDogXCJXaW5uZXIgc3RheXMgb246IHRoZSBzY2VuZSB5b3UgcGljayBrZWVwcyBkZWZlbmRpbmcgYWdhaW5zdCBuZXcgY2hhbGxlbmdlcnMgdW50aWwgaXQncyBiZWF0ZW4sIHRoZW4gdGhlIHdpbm5lciB0YWtlcyBvdmVyLiBCb3RoIHNjZW5lcycgRUxPIGNoYW5nZXMgYWZ0ZXIgZXZlcnkgcGljay5cIixcbiAgfSxcbl07XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVNYWluVUkoKTogc3RyaW5nIHtcbiAgY29uc3QgbW9kZUJ1dHRvbnMgPSBNT0RFUy5tYXAoXG4gICAgKHsgbW9kZSwgaWNvbiwgdGl0bGUsIGRlc2MsIHRpcCB9KSA9PiBgXG4gICAgICAgICAgICA8YnV0dG9uIGNsYXNzPVwic2ItbW9kZS1idG4gJHtzdGF0ZS5jdXJyZW50TW9kZSA9PT0gbW9kZSA/IFwiYWN0aXZlXCIgOiBcIlwifVwiIGRhdGEtbW9kZT1cIiR7bW9kZX1cIiBkYXRhLXRpcD1cIiR7dGlwfVwiIGFyaWEtZGVzY3JpcHRpb249XCIke3RpcH1cIj5cbiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9XCJzYi1tb2RlLWljb25cIj4ke2ljb259PC9zcGFuPlxuICAgICAgICAgICAgICA8c3BhbiBjbGFzcz1cInNiLW1vZGUtdGl0bGVcIj4ke3RpdGxlfTwvc3Bhbj5cbiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9XCJzYi1tb2RlLWRlc2NcIj4ke2Rlc2N9PC9zcGFuPlxuICAgICAgICAgICAgPC9idXR0b24+YCxcbiAgKS5qb2luKFwiXCIpO1xuXG4gIHJldHVybiBgXG4gICAgICA8ZGl2IGlkPVwic3Rhc2gtYmF0dGxlLWNvbnRhaW5lclwiIGNsYXNzPVwic2ItY29udGFpbmVyXCI+XG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi1oZWFkZXJcIj5cbiAgICAgICAgICA8aDEgY2xhc3M9XCJzYi10aXRsZVwiPuKalO+4jyBTdGFzaCBCYXR0bGU8L2gxPlxuICAgICAgICAgICR7Y3JlYXRlVGFiQmFyKCl9XG4gICAgICAgIDwvZGl2PlxuXG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi10YWItcGFuZWxcIiBkYXRhLXBhbmVsPVwiYmF0dGxlXCI+XG4gICAgICAgICAgPGRpdiBpZD1cInNiLXNldHVwLWFyZWFcIiBjbGFzcz1cInNiLXNldHVwLWFyZWFcIiBoaWRkZW4+PC9kaXY+XG4gICAgICAgICAgPGRpdiBjbGFzcz1cInNiLW1vZGUtcm93XCI+XG4gICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItbW9kZS10b2dnbGVcIj4ke21vZGVCdXR0b25zfVxuICAgICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgICA8YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cInNiLW1vZGUtaW5mby1idG5cIiBhcmlhLWNvbnRyb2xzPVwic2ItbW9kZS1pbmZvXCIgYXJpYS1leHBhbmRlZD1cImZhbHNlXCIgYXJpYS1sYWJlbD1cIldoYXQgZG9lcyB0aGlzIG1vZGUgZG8/XCI+4pOYPC9idXR0b24+XG4gICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgPHAgaWQ9XCJzYi1tb2RlLWluZm9cIiBjbGFzcz1cInNiLW1vZGUtaW5mb1wiIGhpZGRlbj48L3A+XG5cbiAgICAgICAgICA8cCBpZD1cInNiLWNsaW1iLXBvb2wtd2FybmluZ1wiIGNsYXNzPVwic2ItY2xpbWItd2FybmluZ1wiIGhpZGRlbj5cbiAgICAgICAgICAgIENoYW1waW9uIGNhbiBiZWhhdmUgb2RkbHkgd2l0aCBzbWFsbCBmaWx0ZXJlZCBwb29scyB3aGVuIGJvdGggc2lkZXMgdXNlIHRoZSBmaWx0ZXJcbiAgICAgICAgICAgIChmZXdlciB0aGFuICR7Q0xJTUJfU01BTExfUE9PTF9XQVJOX0FUfSBzY2VuZXMpLiBVc2UgYSBsYXJnZXIgZmlsdGVyLCBvciB0dXJuIG9mZlxuICAgICAgICAgICAgXCJVc2UgZmlsdGVyZWQgc2NlbmVzIGZvciBib3RoIHNpZGVzXCIgaW4gU2V0dGluZ3MuXG4gICAgICAgICAgPC9wPlxuXG4gICAgICAgICAgPHAgaWQ9XCJzYi1wb29sLXN0YXR1c1wiIGNsYXNzPVwic2ItcG9vbC1zdGF0dXNcIiBoaWRkZW4+PC9wPlxuICAgICAgICAgIDxwIGlkPVwic2ItcmF0aW5ncy1ub3RlXCIgY2xhc3M9XCJzYi1wb29sLXN0YXR1cyBzYi1yYXRpbmdzLW5vdGVcIiBoaWRkZW4+XG4gICAgICAgICAgICBTdGFzaCByYXRpbmdzIGFyZW4ndCBiZWluZyBjaGFuZ2VkIMK3IDxhIGhyZWY9XCIjXCIgZGF0YS1hY3Rpb249XCJvcGVuLXNldHRpbmdzXCI+Y2hhbmdlIGluIFNldHRpbmdzPC9hPlxuICAgICAgICAgIDwvcD5cblxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1jb250ZW50XCI+XG4gICAgICAgICAgICA8ZGl2IGlkPVwic2ItY29tcGFyaXNvbi1hcmVhXCIgY2xhc3M9XCJzYi1jb21wYXJpc29uLWFyZWFcIj5cbiAgICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNiLWxvYWRpbmdcIj5Mb2FkaW5nIHNjZW5lcy4uLjwvZGl2PlxuICAgICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItYWN0aW9uc1wiPlxuICAgICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItYWN0aW9uLWJ1dHRvbnNcIj5cbiAgICAgICAgICAgICAgICA8YnV0dG9uIGlkPVwic2Itc2tpcC1idG5cIiBjbGFzcz1cImJ0biBidG4tc2Vjb25kYXJ5XCI+U2tpcDwvYnV0dG9uPlxuICAgICAgICAgICAgICAgIDxidXR0b24gaWQ9XCJzYi1yZWZyZXNoLWNhY2hlLWJ0blwiIGNsYXNzPVwiYnRuIGJ0bi1zZWNvbmRhcnlcIiB0aXRsZT1cIlJlZnJlc2ggc2NlbmUgbGlzdCBmcm9tIHNlcnZlciAodXNlIGlmIHlvdSd2ZSBhZGRlZCBuZXcgc2NlbmVzKVwiPvCflIQgUmVmcmVzaDwvYnV0dG9uPlxuICAgICAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNiLWtleWJvYXJkLWhpbnRcIj5cbiAgICAgICAgICAgICAgICA8c3Bhbj7ihpA8L3NwYW4+IGNob29zZSBsZWZ0IMK3XG4gICAgICAgICAgICAgICAgPHNwYW4+4oaSPC9zcGFuPiBjaG9vc2UgcmlnaHQgwrdcbiAgICAgICAgICAgICAgICA8c3Bhbj5TcGFjZTwvc3Bhbj4gc2tpcFxuICAgICAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgICAgIDwvZGl2PlxuICAgICAgICAgIDwvZGl2PlxuICAgICAgICA8L2Rpdj5cblxuICAgICAgICAke2NyZWF0ZVNldHRpbmdzVGFiKCl9XG4gICAgICA8L2Rpdj5cbiAgICBgO1xufVxuXG4vKiogVG91Y2ggc2NyZWVucyBoYXZlIG5vIGhvdmVyIHRvb2x0aXBzOiB0aGUg4pOYIGJ1dHRvbiBzaG93cyB0aGUgY3VycmVudCBtb2RlJ3MgZXhwbGFuYXRpb24gaGVyZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiB1cGRhdGVNb2RlSW5mbygpOiB2b2lkIHtcbiAgY29uc3QgaW5mbyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic2ItbW9kZS1pbmZvXCIpO1xuICBjb25zdCBtb2RlID0gTU9ERVMuZmluZCgobSkgPT4gbS5tb2RlID09PSBzdGF0ZS5jdXJyZW50TW9kZSk7XG4gIGlmIChpbmZvICYmIG1vZGUpIGluZm8uaW5uZXJIVE1MID0gYDxzdHJvbmc+JHttb2RlLmljb259ICR7bW9kZS50aXRsZX06PC9zdHJvbmc+ICR7bW9kZS50aXAucmVwbGFjZSgvXFxuL2csIFwiPGJyPlwiKX1gO1xufVxuXG4vKiogQmF0dGxlIHRhYiBub3RlIHdoaWxlIHRoZSBcIlN0YXNoIHJhdGluZ3NcIiBzZXR0aW5nIGlzIFwiRG9uJ3QgdXBkYXRlXCIuICovXG5leHBvcnQgZnVuY3Rpb24gdXBkYXRlUmF0aW5nc05vdGUoKTogdm9pZCB7XG4gIGNvbnN0IG5vdGUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInNiLXJhdGluZ3Mtbm90ZVwiKTtcbiAgaWYgKG5vdGUpIG5vdGUuaGlkZGVuID0gc3RhdGUuc2V0dGluZ3Muc3Rhc2hSYXRpbmdzICE9PSBcIm9mZlwiO1xufVxuXG4vKiogXCJXaGljaCBzY2VuZXMgYW0gSSByYXRpbmc/XCIgbGluZSBhYm92ZSB0aGUgY2FyZHM6IHRoZSBTY2VuZXMgcGFnZSBmaWx0ZXIgb3IgdGhlIHdob2xlIGxpYnJhcnkuICovXG5leHBvcnQgZnVuY3Rpb24gdXBkYXRlUG9vbFN0YXR1cygpOiB2b2lkIHtcbiAgY29uc3Qgc3RhdHVzID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzYi1wb29sLXN0YXR1c1wiKTtcbiAgaWYgKCFzdGF0dXMpIHJldHVybjtcbiAgY29uc3QgY291bnQgPSBzdGF0ZS5sZWZ0UG9vbFNpemU7XG4gIGNvbnN0IGNvdW50SHRtbCA9XG4gICAgY291bnQgPT09IG51bGwgPyBcIlwiIDogYCDCtyA8c3Ryb25nPiR7Y291bnR9IHNjZW5lJHtjb3VudCA9PT0gMSA/IFwiXCIgOiBcInNcIn08L3N0cm9uZz5gO1xuXG4gIGlmIChyZWFkRmlsdGVycygpLmZpbHRlckFjdGl2ZSkge1xuICAgIGNvbnN0IG9wcG9uZW50cyA9IHN0YXRlLnNldHRpbmdzLmZpbHRlck9wcG9uZW50cyA/IFwiIMK3IG9wcG9uZW50cyBmcm9tIHRoZSBmaWx0ZXIgdG9vXCIgOiBcIlwiO1xuICAgIHN0YXR1cy5pbm5lckhUTUwgPSBgUmF0aW5nIHNjZW5lcyBmcm9tIHlvdXIgU2NlbmVzIHBhZ2UgZmlsdGVyJHtjb3VudEh0bWx9JHtvcHBvbmVudHN9YDtcbiAgfSBlbHNlIHtcbiAgICBzdGF0dXMuaW5uZXJIVE1MID0gYFJhdGluZyBzY2VuZXMgZnJvbSB5b3VyIHdob2xlIGxpYnJhcnkke2NvdW50SHRtbH08c3BhbiBjbGFzcz1cInNiLXBvb2wtaGludFwiPiDCtyBmaWx0ZXIgdGhlIFNjZW5lcyBwYWdlIHRvIG5hcnJvdyBpdCBkb3duPC9zcGFuPmA7XG4gIH1cbiAgc3RhdHVzLmhpZGRlbiA9IGZhbHNlO1xufVxuXG4vKiogQ2FyZCBiYWRnZTogdGhlIHdpbiBzdHJlYWsgd2hpbGUgY2xpbWJpbmcgb3IgZGVmZW5kaW5nLCBvciBQbGFjZW1lbnQncyBuYXJyb3dpbmcgcmFuZ2UuICovXG5mdW5jdGlvbiBjbGltYlN0YXR1c0JhZGdlKHNjZW5lOiBTY2VuZSk6IG51bWJlciB8IHN0cmluZyB8IG51bGwge1xuICBpZiAoc3RhdGUuY3VycmVudE1vZGUgPT09IFwicGxhY2VtZW50XCIpIHtcbiAgICBjb25zdCBydW4gPSBzdGF0ZS5wbGFjZW1lbnQ7XG4gICAgaWYgKHJ1bj8uc2NlbmUuaWQgIT09IHNjZW5lLmlkKSByZXR1cm4gbnVsbDtcbiAgICAvLyBcIlN0YXJ0IGZyb20gdGhlIGJvdHRvbVwiIHJ1bnMgc2hvdyB0aGUgc3RyZWFrIHVudGlsIHRoZSBmaXJzdCBsb3NzXG4gICAgaWYgKHJ1bi5mcm9tQm90dG9tICYmIHJ1bi5iYXR0bGVzID4gMCAmJiBydW4uc3RyZWFrID09PSBydW4uYmF0dGxlcykgcmV0dXJuIHJ1bi5zdHJlYWs7XG4gICAgaWYgKHJ1bi5yYW5nZUhpID09PSBydW4ucmFuZ2VMbykgcmV0dXJuIG51bGw7XG4gICAgcmV0dXJuIGDwn5ONIE5hcnJvd2luZyBiZXR3ZWVuICMke3J1bi5yYW5nZUxvICsgMX0gYW5kICMke3J1bi5yYW5nZUhpICsgMX1gO1xuICB9XG4gIGlmIChzdGF0ZS5jdXJyZW50TW9kZSA9PT0gXCJjaGFtcGlvblwiICYmIHN0YXRlLmNoYW1waW9uU2NlbmU/LmlkID09PSBzY2VuZS5pZCkge1xuICAgIHJldHVybiBzdGF0ZS5jaGFtcGlvbldpbnM7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbi8qKiBQcmVjb21wdXRlZCB3aW5uZXIvbG9zZXIgY29udGV4dCB3aXJlZCBhdCByZW5kZXIgdGltZSBmb3IgZWFjaCBjaG9vc2UgYnV0dG9uLiAqL1xuaW50ZXJmYWNlIFNjZW5lQ2hvaWNlIHtcbiAgd2lubmVyOiBTY2VuZTtcbiAgbG9zZXI6IFNjZW5lO1xuICBsZWZ0OiBTY2VuZTtcbiAgcmlnaHQ6IFNjZW5lO1xuICB3aW5uZXJDYXJkOiBIVE1MRWxlbWVudDtcbiAgbG9zZXJDYXJkOiBIVE1MRWxlbWVudDtcbiAgd2lubmVyUmFuazogUmFuaztcbiAgbG9zZXJSYW5rOiBSYW5rO1xufVxuXG5mdW5jdGlvbiBiaW5kU2NlbmVDaG9pY2UoYm9keTogSFRNTEVsZW1lbnQsIGNob2ljZTogU2NlbmVDaG9pY2UpOiB2b2lkIHtcbiAgYm9keS5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4gaGFuZGxlU2NlbmVDaG9pY2UoY2hvaWNlKSk7XG59XG5cbi8qKiBTaG93IG9yIGhpZGUgdGhlIFNraXAgLyBSZWZyZXNoIGJhci4gT25seSBlbmQgc2NyZWVucyBoaWRlIGl0OyBldmVyeSByZW5kZXJlZCBwYWlyIHNob3dzIGl0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNldEFjdGlvbnNWaXNpYmxlKHZpc2libGU6IGJvb2xlYW4pOiB2b2lkIHtcbiAgY29uc3QgYWN0aW9uc0VsID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCIuc2ItYWN0aW9uc1wiKTtcbiAgaWYgKGFjdGlvbnNFbCkgYWN0aW9uc0VsLnN0eWxlLmRpc3BsYXkgPSB2aXNpYmxlID8gXCJcIiA6IFwibm9uZVwiO1xufVxuXG4vKiogVG91Y2ggZGV2aWNlcyBoYXZlIG5vIGhvdmVyOiB0aHVtYm5haWxzIHRvZ2dsZSB0aGUgcHJldmlldyBpbnN0ZWFkIG9mIG9wZW5pbmcgdGhlIHNjZW5lLiAqL1xuZnVuY3Rpb24gaXNUb3VjaERldmljZSgpOiBib29sZWFuIHtcbiAgcmV0dXJuIHdpbmRvdy5tYXRjaE1lZGlhKFwiKGhvdmVyOiBub25lKVwiKS5tYXRjaGVzO1xufVxuXG4vKiogVGh1bWJuYWlsIC8g4oaXIGxpbmsgY2xpY2s6IG5hdGl2ZSBsaW5rIGZvciBuZXcgdGFiIG9yIG1vZGlmaWVyIGNsaWNrcywgU1BBIG5hdmlnYXRpb24gb3RoZXJ3aXNlLiAqL1xuZnVuY3Rpb24gaGFuZGxlU2NlbmVMaW5rQ2xpY2soZTogTW91c2VFdmVudCwgbGluazogSFRNTEFuY2hvckVsZW1lbnQpOiB2b2lkIHtcbiAgY29uc3QgbmF0aXZlTmV3VGFiID0gbGluay50YXJnZXQgPT09IFwiX2JsYW5rXCIgJiYgc3RhdGUuc2V0dGluZ3Mub3BlbkluTmV3VGFiO1xuICBpZiAobmF0aXZlTmV3VGFiIHx8IGUuY3RybEtleSB8fCBlLm1ldGFLZXkgfHwgZS5zaGlmdEtleSB8fCBlLmJ1dHRvbiAhPT0gMCkgcmV0dXJuO1xuICBlLnByZXZlbnREZWZhdWx0KCk7XG4gIG5hdmlnYXRlVG9VcmwobGluay5nZXRBdHRyaWJ1dGUoXCJocmVmXCIpIHx8IFwiXCIpO1xufVxuXG4vKipcbiAqIFNsaWRlciAoMC0xMDApIHRvIG1lZGlhIHZvbHVtZSBvbiBhIGN1YmljIGN1cnZlLCBzbyB0aGUgc2xpZGVyIHRyYWNrcyBwZXJjZWl2ZWQgbG91ZG5lc3MuXG4gKiAoU3Rhc2gncyBwbGF5ZXIgaXMgbGluZWFyLCBidXQgZ2VuZXJhdGVkIHByZXZpZXcgY2xpcHMgYXJlIG11Y2ggbG91ZGVyIHRoYW4gdGhlIHNvdXJjZS4pXG4gKi9cbmZ1bmN0aW9uIHNsaWRlclRvVm9sdW1lKHNsaWRlcjogbnVtYmVyKTogbnVtYmVyIHtcbiAgcmV0dXJuIE1hdGgucG93KHNsaWRlciAvIDEwMCwgMyk7XG59XG5cbi8qKiBBcHBseSB2b2x1bWUvYXV0b3BsYXkgc2V0dGluZ3MgdG8gdGhlIHJlbmRlcmVkIHByZXZpZXcgdmlkZW9zIChob3ZlcmVkIGNhcmQgaXMgYXVkaWJsZSkuICovXG5leHBvcnQgZnVuY3Rpb24gYXBwbHlQcmV2aWV3U2V0dGluZ3MoKTogdm9pZCB7XG4gIGNvbnN0IHsgcHJldmlld1ZvbHVtZSwgYXV0b3BsYXlQcmV2aWV3cyB9ID0gc3RhdGUuc2V0dGluZ3M7XG4gIGNvbnN0IGJhdHRsZVZpc2libGUgPSBnZXRBY3RpdmVUYWIoKSA9PT0gXCJiYXR0bGVcIjtcbiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvcihcIi5zYi12cy1jb250YWluZXJcIik/LmNsYXNzTGlzdC50b2dnbGUoXCJzYi1hdXRvcGxheVwiLCBhdXRvcGxheVByZXZpZXdzKTtcblxuICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PihcIiNzYi1jb21wYXJpc29uLWFyZWEgLnNiLXNjZW5lLWNhcmRcIikuZm9yRWFjaCgoY2FyZCkgPT4ge1xuICAgIGNvbnN0IHZpZGVvID0gY2FyZC5xdWVyeVNlbGVjdG9yPEhUTUxWaWRlb0VsZW1lbnQ+KFwiLnNiLWhvdmVyLXByZXZpZXdcIik7XG4gICAgaWYgKCF2aWRlbykgcmV0dXJuO1xuICAgIGNvbnN0IGFjdGl2ZSA9IGNhcmQubWF0Y2hlcyhcIjpob3ZlclwiKSB8fCBjYXJkLmNsYXNzTGlzdC5jb250YWlucyhcInNiLXByZXZpZXdpbmdcIik7XG4gICAgdmlkZW8udm9sdW1lID0gc2xpZGVyVG9Wb2x1bWUocHJldmlld1ZvbHVtZSk7XG4gICAgdmlkZW8ubXV0ZWQgPSAhYWN0aXZlIHx8IHByZXZpZXdWb2x1bWUgPT09IDA7XG4gICAgaWYgKGJhdHRsZVZpc2libGUgJiYgKGF1dG9wbGF5UHJldmlld3MgfHwgYWN0aXZlKSkge1xuICAgICAgaWYgKHZpZGVvLnBhdXNlZCkgdmlkZW8ucGxheSgpLmNhdGNoKCgpID0+IHt9KTtcbiAgICB9IGVsc2Uge1xuICAgICAgdmlkZW8ucGF1c2UoKTtcbiAgICAgIHZpZGVvLmN1cnJlbnRUaW1lID0gMDtcbiAgICB9XG4gIH0pO1xufVxuXG5mdW5jdGlvbiBiaW5kUHJldmlldyhjYXJkOiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICBjb25zdCB2aWRlbyA9IGNhcmQucXVlcnlTZWxlY3RvcjxIVE1MVmlkZW9FbGVtZW50PihcIi5zYi1ob3Zlci1wcmV2aWV3XCIpO1xuICBpZiAoIXZpZGVvKSByZXR1cm47XG5cbiAgY2FyZC5hZGRFdmVudExpc3RlbmVyKFwibW91c2VlbnRlclwiLCAoKSA9PiB7XG4gICAgaWYgKGlzVG91Y2hEZXZpY2UoKSkgcmV0dXJuO1xuICAgIGlmICghc3RhdGUuc2V0dGluZ3MuYXV0b3BsYXlQcmV2aWV3cykgdmlkZW8uY3VycmVudFRpbWUgPSAwO1xuICAgIHZpZGVvLnZvbHVtZSA9IHNsaWRlclRvVm9sdW1lKHN0YXRlLnNldHRpbmdzLnByZXZpZXdWb2x1bWUpO1xuICAgIHZpZGVvLm11dGVkID0gc3RhdGUuc2V0dGluZ3MucHJldmlld1ZvbHVtZSA9PT0gMDtcbiAgICB2aWRlby5wbGF5KCkuY2F0Y2goKCkgPT4ge30pO1xuICB9KTtcblxuICBjYXJkLmFkZEV2ZW50TGlzdGVuZXIoXCJtb3VzZWxlYXZlXCIsICgpID0+IHtcbiAgICBpZiAoaXNUb3VjaERldmljZSgpKSByZXR1cm47XG4gICAgaWYgKHN0YXRlLnNldHRpbmdzLmF1dG9wbGF5UHJldmlld3MpIHtcbiAgICAgIHZpZGVvLm11dGVkID0gdHJ1ZTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdmlkZW8ucGF1c2UoKTtcbiAgICB2aWRlby5jdXJyZW50VGltZSA9IDA7XG4gIH0pO1xufVxuXG4vKiogVG91Y2g6IHRhcCB0aGUgdGh1bWJuYWlsIHRvIHBsYXkvc3RvcCBpdHMgcHJldmlldyB3aXRoIHNvdW5kLiAqL1xuZnVuY3Rpb24gdG9nZ2xlUHJldmlldyhjYXJkOiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICBjb25zdCBwcmV2aWV3aW5nID0gIWNhcmQuY2xhc3NMaXN0LmNvbnRhaW5zKFwic2ItcHJldmlld2luZ1wiKTtcbiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbChcIi5zYi1zY2VuZS1jYXJkLnNiLXByZXZpZXdpbmdcIikuZm9yRWFjaCgoYykgPT4gYy5jbGFzc0xpc3QucmVtb3ZlKFwic2ItcHJldmlld2luZ1wiKSk7XG4gIGNhcmQuY2xhc3NMaXN0LnRvZ2dsZShcInNiLXByZXZpZXdpbmdcIiwgcHJldmlld2luZyk7XG4gIGFwcGx5UHJldmlld1NldHRpbmdzKCk7XG59XG5cbi8vIFNoYXJlZCByZW5kZXJpbmcgbG9naWMgZm9yIGRpc3BsYXlpbmcgYSBwYWlyIG9mIHNjZW5lc1xuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlclBhaXIoc2NlbmVzOiBTY2VuZVtdLCByYW5rczogUmFua1tdKTogdm9pZCB7XG4gIGNvbnN0IGNvbXBhcmlzb25BcmVhID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzYi1jb21wYXJpc29uLWFyZWFcIik7XG4gIGlmICghY29tcGFyaXNvbkFyZWEpIHJldHVybjtcblxuICBjb25zdCBzdGF0dXNCYWRnZXMgPSBzY2VuZXMubWFwKGNsaW1iU3RhdHVzQmFkZ2UpO1xuXG4gIGNvbXBhcmlzb25BcmVhLmlubmVySFRNTCA9IGBcbiAgICAgIDxkaXYgY2xhc3M9XCJzYi12cy1jb250YWluZXJcIj5cbiAgICAgICAgJHtjcmVhdGVTY2VuZUNhcmQoc2NlbmVzWzBdLCBcImxlZnRcIiwgcmFua3NbMF0sIHN0YXR1c0JhZGdlc1swXSl9XG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi12cy1kaXZpZGVyXCI+XG4gICAgICAgICAgPHNwYW4gY2xhc3M9XCJzYi12cy10ZXh0XCI+VlM8L3NwYW4+XG4gICAgICAgIDwvZGl2PlxuICAgICAgICAke2NyZWF0ZVNjZW5lQ2FyZChzY2VuZXNbMV0sIFwicmlnaHRcIiwgcmFua3NbMV0sIHN0YXR1c0JhZGdlc1sxXSl9XG4gICAgICA8L2Rpdj5cbiAgICBgO1xuXG4gIGNvbnN0IGxlZnQgPSBzY2VuZXNbMF07XG4gIGNvbnN0IHJpZ2h0ID0gc2NlbmVzWzFdO1xuICBjb25zdCBsZWZ0Q2FyZCA9IGNvbXBhcmlzb25BcmVhLnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KCcuc2Itc2NlbmUtY2FyZFtkYXRhLXNpZGU9XCJsZWZ0XCJdJyk7XG4gIGNvbnN0IHJpZ2h0Q2FyZCA9IGNvbXBhcmlzb25BcmVhLnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KCcuc2Itc2NlbmUtY2FyZFtkYXRhLXNpZGU9XCJyaWdodFwiXScpO1xuICBjb25zdCBsZWZ0Qm9keSA9IGxlZnRDYXJkPy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIi5zYi1zY2VuZS1ib2R5XCIpO1xuICBjb25zdCByaWdodEJvZHkgPSByaWdodENhcmQ/LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiLnNiLXNjZW5lLWJvZHlcIik7XG5cbiAgaWYgKGxlZnQgJiYgcmlnaHQgJiYgbGVmdENhcmQgJiYgcmlnaHRDYXJkICYmIGxlZnRCb2R5ICYmIHJpZ2h0Qm9keSkge1xuICAgIGJpbmRTY2VuZUNob2ljZShsZWZ0Qm9keSwge1xuICAgICAgd2lubmVyOiBsZWZ0LFxuICAgICAgbG9zZXI6IHJpZ2h0LFxuICAgICAgbGVmdCxcbiAgICAgIHJpZ2h0LFxuICAgICAgd2lubmVyQ2FyZDogbGVmdENhcmQsXG4gICAgICBsb3NlckNhcmQ6IHJpZ2h0Q2FyZCxcbiAgICAgIHdpbm5lclJhbms6IHJhbmtzWzBdLFxuICAgICAgbG9zZXJSYW5rOiByYW5rc1sxXSxcbiAgICB9KTtcbiAgICBiaW5kU2NlbmVDaG9pY2UocmlnaHRCb2R5LCB7XG4gICAgICB3aW5uZXI6IHJpZ2h0LFxuICAgICAgbG9zZXI6IGxlZnQsXG4gICAgICBsZWZ0LFxuICAgICAgcmlnaHQsXG4gICAgICB3aW5uZXJDYXJkOiByaWdodENhcmQsXG4gICAgICBsb3NlckNhcmQ6IGxlZnRDYXJkLFxuICAgICAgd2lubmVyUmFuazogcmFua3NbMV0sXG4gICAgICBsb3NlclJhbms6IHJhbmtzWzBdLFxuICAgIH0pO1xuXG4gICAgbGVmdENhcmQucXVlcnlTZWxlY3RvcihcIi5zYi1kZWxldGUtYnRuXCIpPy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4gdm9pZCBkZWxldGVGcm9tQmF0dGxlKGxlZnQpKTtcbiAgICByaWdodENhcmQucXVlcnlTZWxlY3RvcihcIi5zYi1kZWxldGUtYnRuXCIpPy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4gdm9pZCBkZWxldGVGcm9tQmF0dGxlKHJpZ2h0KSk7XG4gIH1cblxuICBjb21wYXJpc29uQXJlYS5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PihcIi5zYi1zY2VuZS1jYXJkXCIpLmZvckVhY2goKGNhcmQpID0+IHtcbiAgICBjb25zdCB0aHVtYiA9IGNhcmQucXVlcnlTZWxlY3RvcjxIVE1MQW5jaG9yRWxlbWVudD4oXCIuc2Itc2NlbmUtaW1hZ2UtY29udGFpbmVyXCIpO1xuICAgIHRodW1iPy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICAgIGlmIChpc1RvdWNoRGV2aWNlKCkpIHtcbiAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgICB0b2dnbGVQcmV2aWV3KGNhcmQpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBoYW5kbGVTY2VuZUxpbmtDbGljayhlLCB0aHVtYik7XG4gICAgfSk7XG4gICAgY29uc3Qgb3BlbkxpbmsgPSBjYXJkLnF1ZXJ5U2VsZWN0b3I8SFRNTEFuY2hvckVsZW1lbnQ+KFwiLnNiLW9wZW4tbGlua1wiKTtcbiAgICBvcGVuTGluaz8uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XG4gICAgICBpZiAoIXN0YXRlLnNldHRpbmdzLm9wZW5Jbk5ld1RhYikgaGFuZGxlU2NlbmVMaW5rQ2xpY2soZSwgb3BlbkxpbmspO1xuICAgIH0pO1xuICAgIGJpbmRQcmV2aWV3KGNhcmQpO1xuICB9KTtcbiAgYXBwbHlQcmV2aWV3U2V0dGluZ3MoKTtcblxuICBzZXRBY3Rpb25zVmlzaWJsZSh0cnVlKTtcblxuICAvLyBVcGRhdGUgc2tpcCBidXR0b24gc3RhdGVcbiAgY29uc3Qgc2tpcEJ0biA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3I8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiI3NiLXNraXAtYnRuXCIpO1xuICBpZiAoc2tpcEJ0bikgc2tpcEJ0bi5kaXNhYmxlZCA9IGlzUnVuQWN0aXZlKCk7XG59XG5cbi8qKiBTa2lwIHRoZSBjdXJyZW50IHBhaXIgKG5vdCBhbGxvd2VkIG1pZC1ydW4pLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNraXBQYWlyKCk6IHZvaWQge1xuICBpZiAoaXNSdW5BY3RpdmUoKSB8fCBzdGF0ZS5kaXNhYmxlQ2hvaWNlKSByZXR1cm47XG4gIHN0YXRlLmRpc2FibGVDaG9pY2UgPSB0cnVlO1xuICBpZiAoc3RhdGUuY3VycmVudE1vZGUgIT09IFwic3dpc3NcIikge1xuICAgIHJlc2V0UnVuU3RhdGUoKTtcbiAgICBzYXZlU3RhdGUoKTtcbiAgfVxuICBsb2FkTmV3UGFpcigpO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbG9hZE5ld1BhaXIoZm9yY2VkTGVmdFNjZW5lSWQ6IHN0cmluZyB8IG51bGwgPSBudWxsKTogUHJvbWlzZTx2b2lkPiB7XG4gIC8vIE5vIHBvb2wgbG9hZHMgYmVmb3JlIHRoZSBvbmUtdGltZSBFTE8gc2V0dXAgaGFzIHJ1biAoaXQgc2hvd3MgaW4gcGxhY2Ugb2YgdGhlIGJhdHRsZSlcbiAgaWYgKGlzRWxvU2V0dXBQZW5kaW5nKCkpIHJldHVybjtcbiAgc3RhdGUuZGlzYWJsZUNob2ljZSA9IGZhbHNlO1xuICBjb25zdCBjb21wYXJpc29uQXJlYSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic2ItY29tcGFyaXNvbi1hcmVhXCIpO1xuICBpZiAoIWNvbXBhcmlzb25BcmVhKSByZXR1cm47XG5cbiAgY29uc29sZS5sb2coXG4gICAgYFtTdGFzaCBCYXR0bGVdIPCfjq4gTG9hZGluZyBuZXcgcGFpciAobW9kZTogJHtzdGF0ZS5jdXJyZW50TW9kZX0pJHtmb3JjZWRMZWZ0U2NlbmVJZCA/IGAgd2l0aCBmb3JjZWQgc2NlbmUgJHtmb3JjZWRMZWZ0U2NlbmVJZH1gIDogXCJcIn0uLi5gLFxuICApO1xuICBjb25zdCBzdGFydFRpbWUgPSBEYXRlLm5vdygpO1xuXG4gIC8vIE9ubHkgc2hvdyBsb2FkaW5nIG9uIGZpcnN0IGxvYWQgKHdoZW4gZW1wdHkgb3IgYWxyZWFkeSBzaG93aW5nIGxvYWRpbmcpXG4gIGlmICghY29tcGFyaXNvbkFyZWEucXVlcnlTZWxlY3RvcihcIi5zYi12cy1jb250YWluZXJcIikpIHtcbiAgICBjb25zdCBoYXNDYWNoZSA9IHN0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcyAhPT0gbnVsbDtcbiAgICBjb21wYXJpc29uQXJlYS5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz1cInNiLWxvYWRpbmdcIj4ke2hhc0NhY2hlID8gXCJMb2FkaW5nIHNjZW5lcy4uLlwiIDogXCJMb2FkaW5nIGFuZCBjYWNoaW5nIHNjZW5lcyAoZmlyc3QgbG9hZCBtYXkgdGFrZSBhIG1vbWVudCkuLi5cIn08L2Rpdj5gO1xuICB9XG5cbiAgdHJ5IHtcbiAgICAvLyBGZXRjaCBmb3JjZWQgc2NlbmUgZGF0YSBpZiBhIHNjZW5lIElEIHdhcyBwcm92aWRlZFxuICAgIGxldCBmb3JjZWRMZWZ0U2NlbmU6IFNjZW5lIHwgbnVsbCA9IG51bGw7XG4gICAgaWYgKGZvcmNlZExlZnRTY2VuZUlkKSB7XG4gICAgICBmb3JjZWRMZWZ0U2NlbmUgPSBhd2FpdCBmZXRjaFNjZW5lQnlJZChmb3JjZWRMZWZ0U2NlbmVJZCk7XG4gICAgICAvLyBGcmVzaCBmcm9tIFN0YXNoOiB0aGUgY2FjaGUgbWF5IGJlIG9sZGVyIChhbm90aGVyIHRhYiksIGFuZCByYW5rcyBhbmQgYmF0dGxlIG1hdGggcmVhZCBpdFxuICAgICAgaWYgKGZvcmNlZExlZnRTY2VuZSkgcmVmcmVzaFNjZW5lSW5DYWNoZShmb3JjZWRMZWZ0U2NlbmUpO1xuICAgICAgaWYgKCFmb3JjZWRMZWZ0U2NlbmUpIHtcbiAgICAgICAgY29uc29sZS53YXJuKFwiW1N0YXNoIEJhdHRsZV0gQ291bGQgbm90IGZldGNoIHNjZW5lIGZyb20gVVJMLCBmYWxsaW5nIGJhY2sgdG8gbm9ybWFsIHBhaXJpbmdcIik7XG4gICAgICB9XG4gICAgfVxuXG4gICAgbGV0IHNjZW5lczogU2NlbmVbXSA9IFtdO1xuICAgIGxldCByYW5rczogUmFua1tdID0gW251bGwsIG51bGxdO1xuXG4gICAgaWYgKHN0YXRlLmN1cnJlbnRNb2RlID09PSBcInBsYWNlbWVudFwiKSB7XG4gICAgICBjb25zdCBwbGFjZW1lbnRSZXN1bHQgPSBhd2FpdCBmZXRjaFBsYWNlbWVudFBhaXIoZm9yY2VkTGVmdFNjZW5lKTtcblxuICAgICAgaWYgKHBsYWNlbWVudFJlc3VsdC5kb25lKSB7XG4gICAgICAgIC8vIEEgY2xpbWIgZnJvbSB0aGUgYm90dG9tIHRoYXQgbmV2ZXIgbG9zdCBoYXMgYmVhdGVuIHRoZSB0b3Agc2NlbmVcbiAgICAgICAgaWYgKHBsYWNlbWVudFJlc3VsdC5mcm9tQm90dG9tICYmIHBsYWNlbWVudFJlc3VsdC5yYW5rID09PSAxKSB7XG4gICAgICAgICAgc2hvd1ZpY3RvcnlTY3JlZW4ocGxhY2VtZW50UmVzdWx0LnNjZW5lLCBwbGFjZW1lbnRSZXN1bHQuc3RyZWFrKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBzaG93UGxhY2VtZW50U2NyZWVuKHBsYWNlbWVudFJlc3VsdCk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBzY2VuZXMgPSBwbGFjZW1lbnRSZXN1bHQuc2NlbmVzO1xuICAgICAgcmFua3MgPSBwbGFjZW1lbnRSZXN1bHQucmFua3M7XG4gICAgfSBlbHNlIGlmIChzdGF0ZS5jdXJyZW50TW9kZSA9PT0gXCJjaGFtcGlvblwiKSB7XG4gICAgICBjb25zdCBjaGFtcGlvblJlc3VsdCA9IGF3YWl0IGZldGNoQ2hhbXBpb25QYWlyKGZvcmNlZExlZnRTY2VuZSk7XG5cbiAgICAgIC8vIENoZWNrIGZvciB2aWN0b3J5IChjaGFtcGlvbiBiZWF0IGV2ZXJ5b25lKVxuICAgICAgaWYgKGNoYW1waW9uUmVzdWx0LmlzVmljdG9yeSkge1xuICAgICAgICBzaG93VmljdG9yeVNjcmVlbihjaGFtcGlvblJlc3VsdC5zY2VuZXNbMF0sIHN0YXRlLmNoYW1waW9uV2lucyk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgc2NlbmVzID0gY2hhbXBpb25SZXN1bHQuc2NlbmVzO1xuICAgICAgcmFua3MgPSBjaGFtcGlvblJlc3VsdC5yYW5rcztcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3Qgc3dpc3NSZXN1bHQgPSBhd2FpdCBmZXRjaFN3aXNzUGFpcihmb3JjZWRMZWZ0U2NlbmUpO1xuXG4gICAgICBzY2VuZXMgPSBzd2lzc1Jlc3VsdC5zY2VuZXM7XG4gICAgICByYW5rcyA9IHN3aXNzUmVzdWx0LnJhbmtzO1xuICAgIH1cblxuICAgIGlmIChzY2VuZXMubGVuZ3RoIDwgMikge1xuICAgICAgY29tcGFyaXNvbkFyZWEuaW5uZXJIVE1MID0gJzxkaXYgY2xhc3M9XCJzYi1lcnJvclwiPk5vdCBlbm91Z2ggc2NlbmVzIGF2YWlsYWJsZSBmb3IgY29tcGFyaXNvbi48L2Rpdj4nO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIHN0YXRlLmN1cnJlbnRQYWlyLmxlZnQgPSBzY2VuZXNbMF07XG4gICAgc3RhdGUuY3VycmVudFBhaXIucmlnaHQgPSBzY2VuZXNbMV07XG4gICAgc3RhdGUuY3VycmVudFJhbmtzLmxlZnQgPSByYW5rc1swXTtcbiAgICBzdGF0ZS5jdXJyZW50UmFua3MucmlnaHQgPSByYW5rc1sxXTtcblxuICAgIGNvbnN0IGxvYWRUaW1lID0gRGF0ZS5ub3coKSAtIHN0YXJ0VGltZTtcbiAgICBjb25zb2xlLmxvZyhcbiAgICAgIGBbU3Rhc2ggQmF0dGxlXSDinIUgUGFpciBsb2FkZWQgaW4gJHtsb2FkVGltZX1tczogU2NlbmUgJHtzY2VuZXNbMF0uaWR9IChyYW5rICMke3JhbmtzWzBdfSkgdnMgU2NlbmUgJHtzY2VuZXNbMV0uaWR9IChyYW5rICMke3JhbmtzWzFdfSlgLFxuICAgICk7XG5cbiAgICByZW5kZXJQYWlyKHNjZW5lcywgcmFua3MpO1xuICAgIHVwZGF0ZVBvb2xTdGF0dXMoKTtcbiAgICB1cGRhdGVDbGltYlBvb2xXYXJuaW5nKCk7XG4gICAgc2F2ZVN0YXRlKCk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIEVycm9yIGxvYWRpbmcgc2NlbmVzOlwiLCBlcnJvcik7XG4gICAgY29uc3QgbWVzc2FnZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcbiAgICBjb25zdCBpc05vU2NlbmVzID0gbWVzc2FnZS5pbmNsdWRlcyhcIk5vIHNjZW5lc1wiKSB8fCBtZXNzYWdlLmluY2x1ZGVzKFwiTm90IGVub3VnaFwiKTtcbiAgICBjb21wYXJpc29uQXJlYS5pbm5lckhUTUwgPSBgXG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi1lcnJvci1zY3JlZW5cIj5cbiAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItZXJyb3ItaWNvblwiPuKaoO+4jzwvZGl2PlxuICAgICAgICAgIDxwIGNsYXNzPVwic2ItZXJyb3ItbWVzc2FnZVwiPiR7bWVzc2FnZX08L3A+XG4gICAgICAgICAgPGJ1dHRvbiBpZD1cInNiLWVycm9yLXJldHJ5XCIgY2xhc3M9XCJidG4gYnRuLXByaW1hcnlcIj5SZXRyeTwvYnV0dG9uPlxuICAgICAgICA8L2Rpdj5cbiAgICAgIGA7XG4gICAgc2V0QWN0aW9uc1Zpc2libGUodHJ1ZSk7XG5cbiAgICAvLyBBdHRhY2ggcmV0cnkgaGFuZGxlclxuICAgIGNvbnN0IHJldHJ5QnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzYi1lcnJvci1yZXRyeVwiKSBhcyBIVE1MQnV0dG9uRWxlbWVudCB8IG51bGw7XG4gICAgaWYgKHJldHJ5QnRuKSB7XG4gICAgICByZXRyeUJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgICByZXRyeUJ0bi5kaXNhYmxlZCA9IHRydWU7XG4gICAgICAgIHJldHJ5QnRuLnRleHRDb250ZW50ID0gXCJMb2FkaW5nLi4uXCI7XG5cbiAgICAgICAgaWYgKGlzTm9TY2VuZXMpIHtcbiAgICAgICAgICAvLyBcIk5vIHNjZW5lc1wiIGVycm9yOiBjbGVhciBldmVyeXRoaW5nIGFuZCBzdGFydCBmcmVzaFxuICAgICAgICAgIGF3YWl0IGNsZWFyRmlsdGVyZWRDYWNoZSgpO1xuICAgICAgICAgIHJlc2V0U2h1ZmZsZSgpO1xuICAgICAgICB9XG4gICAgICAgIC8vIE5ldHdvcmsvb3RoZXIgZXJyb3JzOiBqdXN0IHJldHJ5IHdpdGhvdXQgY2xlYXJpbmcgc2Vzc2lvbiBzdGF0ZVxuXG4gICAgICAgIGF3YWl0IGxvYWROZXdQYWlyKCk7XG4gICAgICB9KTtcbiAgICB9XG4gIH1cbn1cblxuLyoqIFJlbmRlciB0aGUgc2F2ZWQgcGFpciwgdW5sZXNzIG9uZSBvZiBpdHMgc2NlbmVzIHdhcyBkZWxldGVkIGluIFN0YXNoIG1lYW53aGlsZS4gKi9cbi8qKlxuICogV2hldGhlciB0aGUgc2F2ZWQgcGFpciBiZWxvbmdzIHRvIHRoZSBjdXJyZW50IHJ1bi4gQSBQbGFjZW1lbnQgcGFpciBpcyBpdHMgcnVuJ3Mgc2NlbmUgYWdhaW5zdFxuICogYW4gb3Bwb25lbnQsIGFuZCBhIENoYW1waW9uIHBhaXIgaW5jbHVkZXMgdGhlIGNoYW1waW9uOyB3aXRob3V0IHRoYXQsIHBpY2tzIGhhdmUgbm90aGluZyB0b1xuICogYWN0IG9uIChhIHJ1biB0aGF0IGVuZGVkLCBzYXkpLlxuICovXG5mdW5jdGlvbiBwYWlyTWF0Y2hlc1J1bihsZWZ0OiBTY2VuZSwgcmlnaHQ6IFNjZW5lKTogYm9vbGVhbiB7XG4gIGlmIChzdGF0ZS5jdXJyZW50TW9kZSA9PT0gXCJwbGFjZW1lbnRcIikgcmV0dXJuIHN0YXRlLnBsYWNlbWVudD8uc2NlbmUuaWQgPT09IGxlZnQuaWQ7XG4gIGlmIChzdGF0ZS5jdXJyZW50TW9kZSA9PT0gXCJjaGFtcGlvblwiICYmIHN0YXRlLmNoYW1waW9uU2NlbmUpIHtcbiAgICByZXR1cm4gc3RhdGUuY2hhbXBpb25TY2VuZS5pZCA9PT0gbGVmdC5pZCB8fCBzdGF0ZS5jaGFtcGlvblNjZW5lLmlkID09PSByaWdodC5pZDtcbiAgfVxuICByZXR1cm4gdHJ1ZTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlc3RvcmVDdXJyZW50UGFpcigpOiBQcm9taXNlPHZvaWQ+IHtcbiAgaWYgKGlzRWxvU2V0dXBQZW5kaW5nKCkpIHJldHVybjtcbiAgY29uc3QgbGVmdCA9IHN0YXRlLmN1cnJlbnRQYWlyLmxlZnQgYXMgU2NlbmU7XG4gIGNvbnN0IHJpZ2h0ID0gc3RhdGUuY3VycmVudFBhaXIucmlnaHQgYXMgU2NlbmU7XG4gIGlmICghcGFpck1hdGNoZXNSdW4obGVmdCwgcmlnaHQpKSB7XG4gICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5OCIFNhdmVkIHBhaXIgZG9lc24ndCBiZWxvbmcgdG8gdGhlIGN1cnJlbnQgcnVuLCBsb2FkaW5nIGEgbmV3IHBhaXJcIik7XG4gICAgYXdhaXQgbG9hZE5ld1BhaXIoKTtcbiAgICByZXR1cm47XG4gIH1cbiAgc3RhdGUuZGlzYWJsZUNob2ljZSA9IGZhbHNlO1xuXG4gIC8vIEFsc28gYnJpbmdzIHRoZSBwYWlyJ3MgRUxPIGFuZCBTdGFzaCByYXRpbmcgdXAgdG8gZGF0ZSAodGhleSBtYXkgaGF2ZSBjaGFuZ2VkIHNpbmNlIGl0IHdhcyBzYXZlZClcbiAgaWYgKCEoYXdhaXQgdmVyaWZ5Q3VycmVudFBhaXIoKSkpIHJldHVybjtcblxuICAvLyBSYW5rcyBmcm9tIHRoZSBjdXJyZW50IHBvb2xzLCBub3QgdGhlIHNhdmVkIG9uZXM6IGJhdHRsZXMgc2luY2UgbWF5IGhhdmUgbW92ZWQgdGhlbS4gTG9hZGluZ1xuICAvLyB0aGUgcG9vbHMgYWxzbyBwcmUtd2FybXMgdGhlbSBmb3IgdGhlIG5leHQgY2hvaWNlIGFuZCBmaWxscyBpbiB0aGUgc3RhdHVzIGxpbmUncyBwb29sIHNpemUuXG4gIGxldCByYW5rczogW1JhbmssIFJhbmtdID0gW3N0YXRlLmN1cnJlbnRSYW5rcy5sZWZ0LCBzdGF0ZS5jdXJyZW50UmFua3MucmlnaHRdO1xuICB0cnkge1xuICAgIHJhbmtzID0gYXdhaXQgcGFpclJhbmtzKGxlZnQsIHJpZ2h0KTtcbiAgICBzdGF0ZS5jdXJyZW50UmFua3MgPSB7IGxlZnQ6IHJhbmtzWzBdLCByaWdodDogcmFua3NbMV0gfTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnNvbGUud2FybihcIltTdGFzaCBCYXR0bGVdIENvdWxkIG5vdCBsb2FkIHNjZW5lIHBvb2xzIGZvciB0aGUgc2F2ZWQgcGFpcidzIHJhbmtzOlwiLCBlKTtcbiAgfVxuXG4gIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+TgiBSZW5kZXJpbmcgc2F2ZWQgcGFpclwiKTtcbiAgcmVuZGVyUGFpcihbbGVmdCwgcmlnaHRdLCByYW5rcyk7XG4gIHVwZGF0ZVBvb2xTdGF0dXMoKTtcbn1cblxuLyoqXG4gKiBDaGVjayB0aGUgY3VycmVudCBwYWlyIHN0aWxsIGV4aXN0cyBpbiBTdGFzaCAoc2NlbmVzIG1heSBiZSBkZWxldGVkIGVsc2V3aGVyZSkuIElmIG9uZSBpcyBnb25lLFxuICogY29udGludWUgd2l0aG91dCBpdCBhbmQgcmV0dXJuIGZhbHNlLiBPdGhlcndpc2UgdGhlIHBhaXIncyBFTE8gYW5kIFN0YXNoIHJhdGluZyBhcmUgYnJvdWdodCB1cFxuICogdG8gZGF0ZSBmcm9tIFN0YXNoLCBpbiBpdHMgb2JqZWN0cyBhbmQgdGhlIGNhY2hlLiBOZXR3b3JrIGVycm9ycyBjb3VudCBhcyBcInN0aWxsIHRoZXJlXCIuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB2ZXJpZnlDdXJyZW50UGFpcigpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgY29uc3QgeyBsZWZ0LCByaWdodCB9ID0gc3RhdGUuY3VycmVudFBhaXI7XG4gIGlmICghbGVmdCB8fCAhcmlnaHQpIHJldHVybiB0cnVlO1xuICB0cnkge1xuICAgIGNvbnN0IGZyZXNoID0gYXdhaXQgZmV0Y2hTY2VuZUZpZWxkcyhbbGVmdC5pZCwgcmlnaHQuaWRdKTtcbiAgICBjb25zdCBnb25lID0gW2xlZnQsIHJpZ2h0XS5maW5kKChzKSA9PiAhZnJlc2guaGFzKHMuaWQpKTtcbiAgICBpZiAoZ29uZSkge1xuICAgICAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIPCfkbsgU2NlbmUgJHtnb25lLmlkfSBpbiB0aGUgY3VycmVudCBwYWlyIG5vIGxvbmdlciBleGlzdHNgKTtcbiAgICAgIGF3YWl0IGhhbmRsZVNjZW5lR29uZShnb25lLmlkKTtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgZm9yIChjb25zdCBzY2VuZSBvZiBbbGVmdCwgcmlnaHRdKSB7XG4gICAgICBjb25zdCBmaWVsZHMgPSBmcmVzaC5nZXQoc2NlbmUuaWQpO1xuICAgICAgaWYgKCFmaWVsZHMpIGNvbnRpbnVlO1xuICAgICAgc2NlbmUucmF0aW5nMTAwID0gZmllbGRzLnJhdGluZzEwMCA/PyBudWxsO1xuICAgICAgc2NlbmUuY3VzdG9tX2ZpZWxkcyA9IGZpZWxkcy5jdXN0b21fZmllbGRzID8/IHt9O1xuICAgICAgcmVmcmVzaFNjZW5lSW5DYWNoZShzY2VuZSk7XG4gICAgfVxuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS53YXJuKFwiW1N0YXNoIEJhdHRsZV0gQ291bGQgbm90IHZlcmlmeSBjdXJyZW50IHBhaXI6XCIsIGUpO1xuICB9XG4gIHJldHVybiB0cnVlO1xufVxuXG4vKiogRm9yZ2V0IGEgc2NlbmUgaWQgcmVmZXJlbmNlZCBieSB0aGUgY3VycmVudCBydW4gKGl0IG5vIGxvbmdlciBleGlzdHMpLiAqL1xuZnVuY3Rpb24gZHJvcEZyb21SdW4oc2NlbmVJZDogc3RyaW5nKTogdm9pZCB7XG4gIHN0YXRlLmNoYW1waW9uRGVmZWF0ZWQgPSBzdGF0ZS5jaGFtcGlvbkRlZmVhdGVkLmZpbHRlcigoaWQpID0+IGlkICE9PSBzY2VuZUlkKTtcbiAgY29uc3QgcnVuID0gc3RhdGUucGxhY2VtZW50O1xuICBpZiAoIXJ1bikgcmV0dXJuO1xuICBpZiAocnVuLmFib3ZlSWQgPT09IHNjZW5lSWQpIHJ1bi5hYm92ZUlkID0gbnVsbDtcbiAgaWYgKHJ1bi5iZWxvd0lkID09PSBzY2VuZUlkKSBydW4uYmVsb3dJZCA9IG51bGw7XG4gIGlmIChydW4ubGFzdE9wcG9uZW50SWQgPT09IHNjZW5lSWQpIHtcbiAgICBydW4ubGFzdE9wcG9uZW50SWQgPSBudWxsO1xuICAgIHJ1bi5nYWxsb3BpbmcgPSBmYWxzZTtcbiAgfVxufVxuXG4vKipcbiAqIEEgc2NlbmUgaW4gcGxheSBubyBsb25nZXIgZXhpc3RzLiBJZiBpdCB3YXMgdGhlIHNjZW5lIGJlaW5nIHJhdGVkL3BsYWNlZC9jbGltYmluZywgc3RhcnQgb3ZlcjtcbiAqIG90aGVyd2lzZSBrZWVwIHRoZSBvdGhlciBzY2VuZSBhbmQgZmluZCBpdCBhIG5ldyBvcHBvbmVudC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGhhbmRsZVNjZW5lR29uZShzY2VuZUlkOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgYXdhaXQgcmVtb3ZlU2NlbmVFdmVyeXdoZXJlKHNjZW5lSWQpO1xuXG4gIGNvbnN0IHsgbGVmdCwgcmlnaHQgfSA9IHN0YXRlLmN1cnJlbnRQYWlyO1xuICBjb25zdCBydW5TY2VuZUlkcyA9IFtsZWZ0Py5pZCwgc3RhdGUucGxhY2VtZW50Py5zY2VuZS5pZCwgc3RhdGUuY2hhbXBpb25TY2VuZT8uaWRdO1xuXG4gIGlmIChydW5TY2VuZUlkcy5pbmNsdWRlcyhzY2VuZUlkKSkge1xuICAgIHJlc2V0UnVuU3RhdGUoKTtcbiAgICBzYXZlU3RhdGUoKTtcbiAgICBhd2FpdCBsb2FkTmV3UGFpcigpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGRyb3BGcm9tUnVuKHNjZW5lSWQpO1xuICBzYXZlU3RhdGUoKTtcbiAgLy8gRm9yY2VkIGxlZnQgb25seSBhcHBsaWVzIHdoZW4gbm8gcnVuIGlzIHVuZGVyIHdheSAoU3dpc3MsIG9yIGJlZm9yZSBhIENoYW1waW9uIHJ1biBzdGFydHMpXG4gIGNvbnN0IGtlZXBJZCA9IHJpZ2h0Py5pZCA9PT0gc2NlbmVJZCA/IGxlZnQ/LmlkIDogbnVsbDtcbiAgYXdhaXQgbG9hZE5ld1BhaXIoa2VlcElkID8/IG51bGwpO1xufVxuXG4vKiogQ2xlYW4gbW9kZTogU3Rhc2gncyBvd24gZGVsZXRlIGRpYWxvZyBkb2VzIHRoZSBkZWxldGluZzsgdGhlbiBjb250aW51ZSB0aGUgYmF0dGxlIHdpdGhvdXQgaXQuICovXG5hc3luYyBmdW5jdGlvbiBkZWxldGVGcm9tQmF0dGxlKHNjZW5lOiBTY2VuZSk6IFByb21pc2U8dm9pZD4ge1xuICBpZiAoc3RhdGUuZGlzYWJsZUNob2ljZSkgcmV0dXJuO1xuICBjb25zdCBkZWxldGVkID0gYXdhaXQgY29uZmlybURlbGV0ZVNjZW5lKHNjZW5lKTtcbiAgaWYgKCFkZWxldGVkKSByZXR1cm47XG5cbiAgc3RhdGUuZGlzYWJsZUNob2ljZSA9IHRydWU7XG4gIGF3YWl0IGhhbmRsZVNjZW5lR29uZShzY2VuZS5pZCk7XG59XG5cbi8qKiBFTE8gdXNlZCBpbiBiYXR0bGUgbWF0aDogdW5yYXRlZCBzY2VuZXMgY291bnQgYXMgRUxPX1NUQVJUICgxNTAwKSBpbiBTd2lzcywgQ0hBTVBJT05fVU5SQVRFRF9FTE8gaW4gQ2hhbXBpb24uICovXG5mdW5jdGlvbiBiYXR0bGVFbG8oc2NlbmU6IFNjZW5lKTogbnVtYmVyIHtcbiAgcmV0dXJuIHN0YXRlLmN1cnJlbnRNb2RlID09PSBcImNoYW1waW9uXCIgPyBlZmZlY3RpdmVFbG8oc2NlbmUsIENIQU1QSU9OX1VOUkFURURfRUxPKSA6IGVmZmVjdGl2ZUVsbyhzY2VuZSk7XG59XG5cbmludGVyZmFjZSBFbG9DaGFuZ2Uge1xuICBmcm9tOiBudW1iZXI7XG4gIHRvOiBudW1iZXI7XG59XG5cbi8qKiBUd28tc2lkZWQgRUxPIGZvciBhIHBpY2sgKFN3aXNzIGFuZCBDaGFtcGlvbik6IGJvdGggc2NlbmVzJyBFTE8gYW5kIGJhdHRsZXMgY2hhbmdlIGFuZCBhcmUgc2F2ZWQuICovXG5mdW5jdGlvbiByZXNvbHZlQ29tcGFyaXNvbih3aW5uZXI6IFNjZW5lLCBsb3NlcjogU2NlbmUpOiB7IHdpbm5lcjogRWxvQ2hhbmdlOyBsb3NlcjogRWxvQ2hhbmdlIH0ge1xuICAvLyBUaGUgbWF0aCByZWFkcyB0aGUgY2FjaGVkIGNvcGllczogdGhlIHBhaXIncyBvd24gb2JqZWN0cyBtYXkgcHJlZGF0ZSBhIGJhY2tncm91bmQgcmVmcmVzaFxuICBjb25zdCBsYXRlc3RXaW5uZXIgPSBsYXRlc3RTY2VuZSh3aW5uZXIpO1xuICBjb25zdCBsYXRlc3RMb3NlciA9IGxhdGVzdFNjZW5lKGxvc2VyKTtcbiAgY29uc3Qgd2lubmVyU2lkZSA9IHsgZWxvOiBiYXR0bGVFbG8obGF0ZXN0V2lubmVyKSwga0dhbWVzOiBrR2FtZXMobGF0ZXN0V2lubmVyKSB9O1xuICBjb25zdCBsb3NlclNpZGUgPSB7IGVsbzogYmF0dGxlRWxvKGxhdGVzdExvc2VyKSwga0dhbWVzOiBrR2FtZXMobGF0ZXN0TG9zZXIpIH07XG4gIGNvbnN0IHJlc3VsdCA9IGVsb1Jlc3VsdCh3aW5uZXJTaWRlLCBsb3NlclNpZGUpO1xuXG4gIHZvaWQgd3JpdGVFbG8od2lubmVyLCByZXN1bHQud2lubmVyLCBiYXR0bGVzKGxhdGVzdFdpbm5lcikgKyAxKTtcbiAgdm9pZCB3cml0ZUVsbyhsb3NlciwgcmVzdWx0Lmxvc2VyLCBiYXR0bGVzKGxhdGVzdExvc2VyKSArIDEpO1xuXG4gIHJldHVybiB7XG4gICAgd2lubmVyOiB7IGZyb206IHdpbm5lclNpZGUuZWxvLCB0bzogcmVzdWx0Lndpbm5lciB9LFxuICAgIGxvc2VyOiB7IGZyb206IGxvc2VyU2lkZS5lbG8sIHRvOiByZXN1bHQubG9zZXIgfSxcbiAgfTtcbn1cblxuLyoqIFNob3cgd2hlbiBDaGFtcGlvbiArIGZpbHRlciBvcHBvbmVudHMgKyBzbWFsbCBmaWx0ZXJlZCBwb29sLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHVwZGF0ZUNsaW1iUG9vbFdhcm5pbmcoKTogdm9pZCB7XG4gIGNvbnN0IHdhcm5pbmcgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInNiLWNsaW1iLXBvb2wtd2FybmluZ1wiKTtcbiAgaWYgKCF3YXJuaW5nKSByZXR1cm47XG5cbiAgY29uc3QgaXNDbGltYiA9IHN0YXRlLmN1cnJlbnRNb2RlID09PSBcImNoYW1waW9uXCI7XG4gIGNvbnN0IGZpbHRlcnMgPSByZWFkRmlsdGVycygpO1xuICBjb25zdCBzbWFsbFBvb2wgPVxuICAgIHN0YXRlLnRvdGFsU2NlbmVzQ291bnQgPiAwICYmIHN0YXRlLnRvdGFsU2NlbmVzQ291bnQgPCBDTElNQl9TTUFMTF9QT09MX1dBUk5fQVQ7XG5cbiAgd2FybmluZy5oaWRkZW4gPSAhKFxuICAgIGlzQ2xpbWIgJiZcbiAgICBzdGF0ZS5zZXR0aW5ncy5maWx0ZXJPcHBvbmVudHMgJiZcbiAgICBmaWx0ZXJzLmZpbHRlckFjdGl2ZSAmJlxuICAgIHNtYWxsUG9vbFxuICApO1xufVxuXG4vKiogUGxhY2VtZW50OiByZWNvcmQgdGhlIHJlc3VsdDsgdGhlIG5leHQgcGFpciAob3IgdGhlIGZpbmFsIHBsYWNlbWVudCkgY29tZXMgZnJvbSB0aGUgZmV0Y2guICovXG5mdW5jdGlvbiBoYW5kbGVQbGFjZW1lbnRDaG9pY2UoY2hvaWNlOiBTY2VuZUNob2ljZSk6IHZvaWQge1xuICBjb25zdCBydW4gPSBzdGF0ZS5wbGFjZW1lbnQ7XG4gIGlmICghcnVuKSB7XG4gICAgc3RhdGUuZGlzYWJsZUNob2ljZSA9IGZhbHNlO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHdvbiA9IGNob2ljZS53aW5uZXIuaWQgPT09IHJ1bi5zY2VuZS5pZDtcbiAgcmVjb3JkUGxhY2VtZW50UmVzdWx0KHJ1biwgd29uLCB3b24gPyBjaG9pY2UubG9zZXIuaWQgOiBjaG9pY2Uud2lubmVyLmlkKTtcbiAgc2F2ZVN0YXRlKCk7XG5cbiAgY2hvaWNlLndpbm5lckNhcmQuY2xhc3NMaXN0LmFkZChcInNiLXdpbm5lclwiKTtcbiAgY2hvaWNlLmxvc2VyQ2FyZC5jbGFzc0xpc3QuYWRkKFwic2ItbG9zZXJcIik7XG4gIHNldFRpbWVvdXQoKCkgPT4gbG9hZE5ld1BhaXIoKSwgNjAwKTtcbn1cblxuLyoqIENoYW1waW9uOiB0d28tc2lkZWQgRUxPIGV2ZXJ5IHBpY2s7IHRoZSB3aW5uZXIgZGVmZW5kcyBuZXh0IChhIG5ldyB3aW5uZXIgdGFrZXMgb3ZlcikuICovXG5mdW5jdGlvbiBoYW5kbGVDaGFtcGlvbkNob2ljZShjaG9pY2U6IFNjZW5lQ2hvaWNlKTogdm9pZCB7XG4gIGNvbnN0IHsgd2lubmVyOiB3aW5uZXJTY2VuZSwgbG9zZXI6IGxvc2VyU2NlbmUsIGxlZnQsIHdpbm5lckNhcmQsIGxvc2VyQ2FyZCB9ID0gY2hvaWNlO1xuXG4gIGlmICghc3RhdGUuY2hhbXBpb25TY2VuZSkgc3RhdGUuY2hhbXBpb25TY2VuZSA9IGxlZnQ7XG4gIGNvbnN0IGNoYW5nZSA9IHJlc29sdmVDb21wYXJpc29uKHdpbm5lclNjZW5lLCBsb3NlclNjZW5lKTtcblxuICBpZiAod2lubmVyU2NlbmUuaWQgPT09IHN0YXRlLmNoYW1waW9uU2NlbmUuaWQpIHtcbiAgICBzdGF0ZS5jaGFtcGlvbkRlZmVhdGVkLnB1c2gobG9zZXJTY2VuZS5pZCk7XG4gICAgc3RhdGUuY2hhbXBpb25XaW5zKys7XG4gIH0gZWxzZSB7XG4gICAgc3RhdGUuY2hhbXBpb25TY2VuZSA9IHdpbm5lclNjZW5lO1xuICAgIHN0YXRlLmNoYW1waW9uRGVmZWF0ZWQgPSBbbG9zZXJTY2VuZS5pZF07XG4gICAgc3RhdGUuY2hhbXBpb25XaW5zID0gMTtcbiAgfVxuXG4gIHNhdmVTdGF0ZSgpO1xuXG4gIHdpbm5lckNhcmQuY2xhc3NMaXN0LmFkZChcInNiLXdpbm5lclwiKTtcbiAgbG9zZXJDYXJkLmNsYXNzTGlzdC5hZGQoXCJzYi1sb3NlclwiKTtcbiAgc2hvd1JhdGluZ0FuaW1hdGlvbih3aW5uZXJDYXJkLCBjaGFuZ2Uud2lubmVyLmZyb20sIGNoYW5nZS53aW5uZXIudG8sIHRydWUpO1xuICBzaG93UmF0aW5nQW5pbWF0aW9uKGxvc2VyQ2FyZCwgY2hhbmdlLmxvc2VyLmZyb20sIGNoYW5nZS5sb3Nlci50bywgZmFsc2UpO1xuICBzY2hlZHVsZU5leHRQYWlyQWZ0ZXJBbmltYXRpb25zKCk7XG59XG5cbmZ1bmN0aW9uIGhhbmRsZVNjZW5lQ2hvaWNlKGNob2ljZTogU2NlbmVDaG9pY2UpOiB2b2lkIHtcbiAgaWYgKHN0YXRlLmRpc2FibGVDaG9pY2UpIHJldHVybjtcbiAgc3RhdGUuZGlzYWJsZUNob2ljZSA9IHRydWU7XG5cbiAgY29uc3QgeyB3aW5uZXI6IHdpbm5lclNjZW5lLCBsb3NlcjogbG9zZXJTY2VuZSwgd2lubmVyQ2FyZCwgbG9zZXJDYXJkIH0gPSBjaG9pY2U7XG5cbiAgaWYgKHN0YXRlLmN1cnJlbnRNb2RlID09PSBcInBsYWNlbWVudFwiKSB7XG4gICAgaGFuZGxlUGxhY2VtZW50Q2hvaWNlKGNob2ljZSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKHN0YXRlLmN1cnJlbnRNb2RlID09PSBcImNoYW1waW9uXCIpIHtcbiAgICBoYW5kbGVDaGFtcGlvbkNob2ljZShjaG9pY2UpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFN3aXNzOiBib3RoIHNjZW5lcycgRUxPIGNoYW5nZXMgKGJvdGggc3RheSBpbiB0aGUgcG9vbClcbiAgY29uc3QgY2hhbmdlID0gcmVzb2x2ZUNvbXBhcmlzb24od2lubmVyU2NlbmUsIGxvc2VyU2NlbmUpO1xuXG4gIHNhdmVTdGF0ZSgpO1xuXG4gIHdpbm5lckNhcmQuY2xhc3NMaXN0LmFkZChcInNiLXdpbm5lclwiKTtcbiAgbG9zZXJDYXJkLmNsYXNzTGlzdC5hZGQoXCJzYi1sb3NlclwiKTtcbiAgc2hvd1JhdGluZ0FuaW1hdGlvbih3aW5uZXJDYXJkLCBjaGFuZ2Uud2lubmVyLmZyb20sIGNoYW5nZS53aW5uZXIudG8sIHRydWUpO1xuICBzaG93UmF0aW5nQW5pbWF0aW9uKGxvc2VyQ2FyZCwgY2hhbmdlLmxvc2VyLmZyb20sIGNoYW5nZS5sb3Nlci50bywgZmFsc2UpO1xuICBzY2hlZHVsZU5leHRQYWlyQWZ0ZXJBbmltYXRpb25zKCk7XG59XG5cbmNvbnN0IFJBVElOR19BTklNX01BWF9UT1RBTF9NUyA9IDE0MDA7XG5jb25zdCBSQVRJTkdfQU5JTV9IT0xEX01TID0gMzAwO1xuY29uc3QgUkFUSU5HX0FOSU1fQ09VTlRfQlVER0VUX01TID0gUkFUSU5HX0FOSU1fTUFYX1RPVEFMX01TIC0gUkFUSU5HX0FOSU1fSE9MRF9NUztcbmNvbnN0IFJBVElOR19BTklNX0RFRkFVTFRfU1RFUF9NUyA9IDUwO1xuY29uc3QgUkFUSU5HX0FOSU1fTUlOX1NURVBfTVMgPSA4O1xuXG5mdW5jdGlvbiBzY2hlZHVsZU5leHRQYWlyQWZ0ZXJBbmltYXRpb25zKCk6IHZvaWQge1xuICBzZXRUaW1lb3V0KCgpID0+IGxvYWROZXdQYWlyKCksIDE1MDApO1xufVxuXG4vKiogRUxPIGNvdW50LXVwL2Rvd24gb3ZlcmxheSAod2hvbGUgbnVtYmVycyk7IGxhcmdlIGp1bXBzIHNwZWVkIHVwIHNvIHRoZSBjb3VudCBmaXRzIHdpdGhpbiAxNDAwbXMuICovXG5mdW5jdGlvbiBzaG93UmF0aW5nQW5pbWF0aW9uKFxuICBjYXJkOiBIVE1MRWxlbWVudCxcbiAgb2xkRWxvOiBudW1iZXIsXG4gIG5ld0VsbzogbnVtYmVyLFxuICBpc1dpbm5lcjogYm9vbGVhbixcbik6IHZvaWQge1xuICBjb25zdCBvbGRSYXRpbmcgPSBNYXRoLnJvdW5kKG9sZEVsbyk7XG4gIGNvbnN0IG5ld1JhdGluZyA9IE1hdGgucm91bmQobmV3RWxvKTtcbiAgY29uc3QgY2hhbmdlID0gbmV3UmF0aW5nIC0gb2xkUmF0aW5nO1xuICAvLyBDcmVhdGUgb3ZlcmxheVxuICBjb25zdCBvdmVybGF5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgb3ZlcmxheS5jbGFzc05hbWUgPSBgc2ItcmF0aW5nLW92ZXJsYXkgJHtpc1dpbm5lciA/IFwic2ItcmF0aW5nLXdpbm5lclwiIDogXCJzYi1yYXRpbmctbG9zZXJcIn1gO1xuXG4gIGNvbnN0IHJhdGluZ0Rpc3BsYXkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByYXRpbmdEaXNwbGF5LmNsYXNzTmFtZSA9IFwic2ItcmF0aW5nLWRpc3BsYXlcIjtcbiAgcmF0aW5nRGlzcGxheS50ZXh0Q29udGVudCA9IFN0cmluZyhvbGRSYXRpbmcpO1xuXG4gIGNvbnN0IGNoYW5nZURpc3BsYXkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBjaGFuZ2VEaXNwbGF5LmNsYXNzTmFtZSA9IFwic2ItcmF0aW5nLWNoYW5nZVwiO1xuICBjaGFuZ2VEaXNwbGF5LnRleHRDb250ZW50ID0gY2hhbmdlID4gMCA/IGArJHtjaGFuZ2V9YCA6IFN0cmluZyhjaGFuZ2UpO1xuXG4gIG92ZXJsYXkuYXBwZW5kQ2hpbGQocmF0aW5nRGlzcGxheSk7XG4gIG92ZXJsYXkuYXBwZW5kQ2hpbGQoY2hhbmdlRGlzcGxheSk7XG4gIGNhcmQuYXBwZW5kQ2hpbGQob3ZlcmxheSk7XG5cbiAgY29uc3QgdG90YWxTdGVwcyA9IE1hdGguYWJzKGNoYW5nZSk7XG4gIGlmICh0b3RhbFN0ZXBzID09PSAwKSB7XG4gICAgcmF0aW5nRGlzcGxheS50ZXh0Q29udGVudCA9IFN0cmluZyhuZXdSYXRpbmcpO1xuICAgIHNldFRpbWVvdXQoKCkgPT4gb3ZlcmxheS5yZW1vdmUoKSwgUkFUSU5HX0FOSU1fTUFYX1RPVEFMX01TKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBzdGVwTXMgPSBNYXRoLm1pbihcbiAgICBSQVRJTkdfQU5JTV9ERUZBVUxUX1NURVBfTVMsXG4gICAgTWF0aC5tYXgoUkFUSU5HX0FOSU1fTUlOX1NURVBfTVMsIE1hdGgucm91bmQoUkFUSU5HX0FOSU1fQ09VTlRfQlVER0VUX01TIC8gdG90YWxTdGVwcykpLFxuICApO1xuXG4gIGxldCBjdXJyZW50RGlzcGxheSA9IG9sZFJhdGluZztcbiAgY29uc3Qgc3RlcCA9IGNoYW5nZSA+IDAgPyAxIDogLTE7XG4gIGxldCBzdGVwQ291bnQgPSAwO1xuXG4gIGNvbnN0IGludGVydmFsID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgIHN0ZXBDb3VudCsrO1xuICAgIGN1cnJlbnREaXNwbGF5ICs9IHN0ZXA7XG4gICAgcmF0aW5nRGlzcGxheS50ZXh0Q29udGVudCA9IFN0cmluZyhjdXJyZW50RGlzcGxheSk7XG5cbiAgICBpZiAoc3RlcENvdW50ID49IHRvdGFsU3RlcHMpIHtcbiAgICAgIGNsZWFySW50ZXJ2YWwoaW50ZXJ2YWwpO1xuICAgICAgcmF0aW5nRGlzcGxheS50ZXh0Q29udGVudCA9IFN0cmluZyhuZXdSYXRpbmcpO1xuICAgIH1cbiAgfSwgc3RlcE1zKTtcblxuICBzZXRUaW1lb3V0KCgpID0+IG92ZXJsYXkucmVtb3ZlKCksIFJBVElOR19BTklNX01BWF9UT1RBTF9NUyk7XG59XG4iLCAiLy8gU2hhcmVkIGljb25zLlxuXG4vKiogVGhlIGNyb3NzZWQgc3dvcmRzICgzNngzNiwgZmlsbGVkIHdpdGggY3VycmVudENvbG9yKTogdGhlIG5hdmJhciBidXR0b24gYW5kIHRoZSBzY2VuZSBwYWdlJ3MgRUxPLiAqL1xuZXhwb3J0IGNvbnN0IFNXT1JEU19QQVRIUyA9IGBcbiAgPHBhdGggZmlsbD1cImN1cnJlbnRDb2xvclwiIGQ9XCJtMjQgMjkgNS01TDYgMUgxdjV6XCIvPlxuICA8cGF0aCBmaWxsPVwiY3VycmVudENvbG9yXCIgZD1cIk0xIDF2NWwyMyAyMyAyLjUtMi41elwiLz5cbiAgPHBhdGggZmlsbD1cImN1cnJlbnRDb2xvclwiIGQ9XCJNMzMuNDI0IDMyLjgwOGMuMjg0LS4yODQuNDU4LS42MjYuNTMxLS45NjhsLTUuMjQyLTYuMTk1LS43LS43MDJjLS41NjUtLjU2NC0xLjU3LS40NzMtMi4yNDkuMjA1bC0uNjE0LjYxMmMtLjY3Ny42NzctLjc2OCAxLjY4My0uMjA0IDIuMjQ3bC43NDEuNzQxIDYuMTUgNS4yMDVjLjM0NS0uMDcyLjY4OC0uMjQ3Ljk3NC0uNTMyelwiLz5cbiAgPHBhdGggZmlsbD1cImN1cnJlbnRDb2xvclwiIGQ9XCJNMzMuNDI0IDMyLjgwOGMuMjg0LS4yODQuNDU4LS42MjYuNTMxLS45NjhsLTEuMzQyLTEuNTg2LS43MzcgMy42ODRjLjMzMS0uMDc3LjY2MS0uMjQzLjkzNS0uNTE4em0tMy4zMS01LjUwNi0uODg4IDQuNDQgMS4yNiAxLjA2Ny44Mi00LjF6bS0xLjQtMS42NTctLjcwMi0uNzAyYTEuMiAxLjIgMCAwIDAtLjMyNi0uMjI0bC0uOTc4IDQuODkyIDEuMjYgMS4wNjYuOTU3LTQuNzgzem0tMi40MDItLjg4OGEyIDIgMCAwIDAtLjU0OC4zOTJsLS42MTQuNjFhMiAyIDAgMCAwLS41MS44NmMtLjE0My41MS0uMDQ3IDEuMDM2LjMwNiAxLjM4OGwuNTk2LjU5NnptMCAwcTAtLjAwMyAwIDBcIi8+XG4gIDxwYXRoIGZpbGw9XCJjdXJyZW50Q29sb3JcIiBkPVwiTTMzLjI1IDM2YTIuNzUgMi43NSAwIDEgMCAwLTUuNSAyLjc1IDIuNzUgMCAwIDAgMCA1LjVNMjkuNjI2IDIyLjMyNGExLjAzNCAxLjAzNCAwIDAgMSAwIDEuNDYybC02LjA5MiA2LjA5MmExLjAzMiAxLjAzMiAwIDAgMS0xLjY4Ni0uMzM2IDEuMDMgMS4wMyAwIDAgMSAuMjI0LTEuMTI2bDYuMDkyLTYuMDkyYTEuMDMzIDEuMDMzIDAgMCAxIDEuNDYyIDBcIi8+XG4gIDxwYXRoIGZpbGw9XCJjdXJyZW50Q29sb3JcIiBkPVwiTTIyLjA3MiAzMS42MjdhMS43NSAxLjc1IDAgMSAwIDAtMy41IDEuNzUgMS43NSAwIDAgMCAwIDMuNU0yOS42MjYgMjQuMDczYTEuNzUgMS43NSAwIDEgMCAwLTMuNSAxLjc1IDEuNzUgMCAwIDAgMCAzLjVcIi8+XG4gIDxwYXRoIGZpbGw9XCJjdXJyZW50Q29sb3JcIiBkPVwiTTIyLjA3MiAzMC44NzdhMSAxIDAgMSAwIDAtMiAxIDEgMCAwIDAgMCAyTTI5LjYyNiAyMy4zMjNhMSAxIDAgMSAwIDAtMiAxIDEgMCAwIDAgMCAyTTMzLjkwMyAyOS4zNDJhLjc2Ljc2IDAgMCAxIDAgMS4wNzhsLTMuNDc2IDMuNDc1YS43NjIuNzYyIDAgMCAxLTEuMDc4LTEuMDc4bDMuNDc2LTMuNDc1YS43Ni43NiAwIDAgMSAxLjA3OCAwTTEyIDI5bC01LTVMMzAgMWg1djV6XCIvPlxuICA8cGF0aCBmaWxsPVwiY3VycmVudENvbG9yXCIgZD1cIk0zNSAxdjVMMTIgMjlsLTIuNS0yLjV6XCIvPlxuICA8cGF0aCBmaWxsPVwiY3VycmVudENvbG9yXCIgZD1cIk0yLjU3NiAzMi44MDhhMS45NSAxLjk1IDAgMCAxLS41MzEtLjk2OGw1LjI0Mi02LjE5NS43LS43MDJjLjU2NS0uNTY0IDEuNTctLjQ3MyAyLjI0OS4yMDVsLjYxMy42MTJjLjY3Ny42NzcuNzY4IDEuNjgzLjIwNCAyLjI0N2wtLjc0MS43NDEtNi4xNSA1LjIwNWExLjk1IDEuOTUgMCAwIDEtLjk3NC0uNTMyelwiLz5cbiAgPHBhdGggZmlsbD1cImN1cnJlbnRDb2xvclwiIGQ9XCJNMi41NzYgMzIuODA4YTEuOTUgMS45NSAwIDAgMS0uNTMxLS45NjhsMS4zNDItMS41ODYuNzM3IDMuNjg0YTEuOTMgMS45MyAwIDAgMS0uOTM1LS41MTh6bTMuMzEtNS41MDYuODg4IDQuNDQtMS4yNiAxLjA2Ny0uODItNC4xem0xLjQtMS42NTcuNzAyLS43MDJhMS4yIDEuMiAwIDAgMSAuMzI2LS4yMjRsLjk3OCA0Ljg5Mi0xLjI2IDEuMDY2LS45NTctNC43ODN6bTIuNDAyLS44ODhjLjE5NS4wOTUuMzgyLjIyNS41NDguMzkybC42MTMuNjEyYy4yNTQuMjU0LjQyNS41NTQuNTEuODYuMTQzLjUxLjA0NyAxLjAzNS0uMzA2IDEuMzg3bC0uNTk2LjU5NnptMCAwcTAtLjAwMyAwIDBcIi8+XG4gIDxwYXRoIGZpbGw9XCJjdXJyZW50Q29sb3JcIiBkPVwiTTIuNzUgMzZhMi43NSAyLjc1IDAgMSAwIDAtNS41IDIuNzUgMi43NSAwIDAgMCAwIDUuNU02LjM3NCAyMi4zMjRhMS4wMzQgMS4wMzQgMCAwIDAgMCAxLjQ2Mmw2LjA5MiA2LjA5MmExLjAzMyAxLjAzMyAwIDEgMCAxLjQ2Mi0xLjQ2MmwtNi4wOTItNi4wOTJhMS4wMzMgMS4wMzMgMCAwIDAtMS40NjIgMFwiLz5cbiAgPHBhdGggZmlsbD1cImN1cnJlbnRDb2xvclwiIGQ9XCJNMTMuOTI4IDMxLjYyN2ExLjc1IDEuNzUgMCAxIDAgMC0zLjUgMS43NSAxLjc1IDAgMCAwIDAgMy41TTYuMzc0IDI0LjA3M2ExLjc1IDEuNzUgMCAxIDAgMC0zLjUgMS43NSAxLjc1IDAgMCAwIDAgMy41XCIvPlxuICA8cGF0aCBmaWxsPVwiY3VycmVudENvbG9yXCIgZD1cIk0xMy45MjggMzAuODc3YTEgMSAwIDEgMCAwLTIgMSAxIDAgMCAwIDAgMk02LjM3NCAyMy4zMjNhMSAxIDAgMSAwIDAtMiAxIDEgMCAwIDAgMCAyTTIuMDk3IDI5LjM0MmEuNzYuNzYgMCAwIDAgMCAxLjA3OGwzLjQ3NiAzLjQ3NWEuNzYzLjc2MyAwIDAgMCAxLjA3OC0xLjA3OGwtMy40NzYtMy40NzVhLjc2Ljc2IDAgMCAwLTEuMDc4IDBcIi8+XG5gO1xuIiwgIi8vIFRoZSBzY2VuZSdzIEVMTyBhbmQgcmFuayBvbiBTdGFzaCdzIG93biBzY2VuZSBwYWdlLCBhcyBvbmUgbW9yZSBpdGVtIGluIHRoZSB0b29sYmFyIG5leHQgdG9cbi8vIFBsYXkgQ291bnQgYW5kIE8gQ291bnQ6IGEgc2luZ2xlIFN0YXNoIFwibWluaW1hbFwiIGJ1dHRvbiAoaWNvbiBhbmQgdGV4dCBoaWdobGlnaHQgdG9nZXRoZXIpLlxuLy9cbi8vIFN0YXNoJ3MgU2NlbmVQYWdlIGlzbid0IGEgcGF0Y2hhYmxlIGNvbXBvbmVudCwgc28gdGhlIGl0ZW0gaXMgYWRkZWQgdG8gdGhlIERPTSBhbmQgcmUtYWRkZWRcbi8vIHdoZW5ldmVyIFJlYWN0IHJlLXJlbmRlcnMgdGhlIHRvb2xiYXIuIFRoZSByYW5rIGNvbWVzIGZyb20gU3Rhc2ggQmF0dGxlJ3MgYWxsLXNjZW5lcyBjYWNoZSwgdGhlXG4vLyBzYW1lIHBsYWNlIHRoZSBiYXR0bGUgY2FyZHMgZ2V0IHRoZWlycyAoU3Rhc2ggY2FuJ3QgY291bnQgc2NlbmVzIGJ5IGEgbnVtZXJpYyBjdXN0b20gZmllbGQpLlxuXG5pbXBvcnQgeyBnZXRBbGxTY2VuZXNDYWNoZWQgfSBmcm9tIFwiLi4vY2FjaGVcIjtcbmltcG9ydCB7IGZldGNoU2NlbmVCeUlkLCBnZXRTY2VuZUlkRnJvbVVybCwgc2NlbmVDdXN0b21GaWVsZHNTdXBwb3J0ZWQgfSBmcm9tIFwiLi4vZ3JhcGhxbFwiO1xuaW1wb3J0IHsgZWxvLCBpc1JhdGVkIH0gZnJvbSBcIi4uL3Njb3JlXCI7XG5pbXBvcnQgdHlwZSB7IFNjZW5lIH0gZnJvbSBcIi4uL3R5cGVzXCI7XG5pbXBvcnQgeyBTV09SRFNfUEFUSFMgfSBmcm9tIFwiLi9pY29uc1wiO1xuXG5jb25zdCBJVEVNX0NMQVNTID0gXCJzYi1zY2VuZS1lbG9cIjtcbmNvbnN0IFRJVExFID0gXCJTdGFzaCBCYXR0bGUgRUxPLCBhbmQgcmFuayBpbiB5b3VyIGxpYnJhcnkuIENsaWNrIHRvIGJhdHRsZSB0aGlzIHNjZW5lLlwiO1xuXG4vKiogXCJFTE8gMTc0MCDCtyAjNTBcIiwgb3IgXCJFTE8gwrcgVW5yYXRlZFwiIGZvciBhIHNjZW5lIHdpdGggbm8gRUxPIHlldC4gKi9cbmZ1bmN0aW9uIGxhYmVsVGV4dChzY2VuZTogU2NlbmUsIHJhbms6IG51bWJlciB8IG51bGwpOiBzdHJpbmcge1xuICBjb25zdCB2YWx1ZSA9IGVsbyhzY2VuZSk7XG4gIGlmICh2YWx1ZSA9PT0gbnVsbCkgcmV0dXJuIFwiRUxPIMK3IFVucmF0ZWRcIjtcbiAgcmV0dXJuIGBFTE8gJHtNYXRoLnJvdW5kKHZhbHVlKX0ke3JhbmsgIT09IG51bGwgPyBgIMK3ICMke3Jhbmt9YCA6IFwiXCJ9YDtcbn1cblxuLyoqIFRoZSBzY2VuZSAoZnJvbSB0aGUgY2FjaGUsIG9yIGZldGNoZWQgaWYgaXQncyBuZXdlciB0aGFuIHRoZSBjYWNoZSkgYW5kIGl0cyByYW5rIGFtb25nIHJhdGVkIHNjZW5lcy4gKi9cbmFzeW5jIGZ1bmN0aW9uIHNjZW5lQW5kUmFuayhzY2VuZUlkOiBzdHJpbmcpOiBQcm9taXNlPHsgc2NlbmU6IFNjZW5lOyByYW5rOiBudW1iZXIgfCBudWxsIH0gfCBudWxsPiB7XG4gIGNvbnN0IHsgc2NlbmVzIH0gPSBhd2FpdCBnZXRBbGxTY2VuZXNDYWNoZWQoKTtcbiAgLy8gVGhlIGNhY2hlIGlzIHNvcnRlZCBieSBFTE8gd2l0aCB1bnJhdGVkIHNjZW5lcyBsYXN0LCBzbyBhIHJhdGVkIHNjZW5lJ3MgaW5kZXggaXMgaXRzIHJhbmtcbiAgY29uc3QgaW5kZXggPSBzY2VuZXMuZmluZEluZGV4KChzKSA9PiBzLmlkID09PSBzY2VuZUlkKTtcbiAgaWYgKGluZGV4ID49IDApIHJldHVybiB7IHNjZW5lOiBzY2VuZXNbaW5kZXhdLCByYW5rOiBpc1JhdGVkKHNjZW5lc1tpbmRleF0pID8gaW5kZXggKyAxIDogbnVsbCB9O1xuICBjb25zdCBzY2VuZSA9IGF3YWl0IGZldGNoU2NlbmVCeUlkKHNjZW5lSWQpO1xuICByZXR1cm4gc2NlbmUgPyB7IHNjZW5lLCByYW5rOiBudWxsIH0gOiBudWxsO1xufVxuXG4vKiogT3BlbnMgU3Rhc2ggQmF0dGxlIChvbiBhIHNjZW5lIHBhZ2UsIHdpdGggdGhpcyBzY2VuZSBpbiB0aGUgYmF0dGxlKS4gU2V0IGJ5IHJlZ2lzdGVyU2NlbmVFbG8uICovXG5sZXQgb3BlbkJhdHRsZTogKCkgPT4gdm9pZCA9ICgpID0+IHt9O1xuXG4vKiogT25lIFN0YXNoIFwibWluaW1hbFwiIGJ1dHRvbiB3aXRoIHRoZSBzd29yZHMgYW5kIHRoZSBFTE8sIHNvIGl0IGhvdmVycyBhcyBhIHdob2xlLiAqL1xuZnVuY3Rpb24gY3JlYXRlSXRlbSgpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGl0ZW0gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgaXRlbS5jbGFzc05hbWUgPSBJVEVNX0NMQVNTO1xuICBpdGVtLmlubmVySFRNTCA9IGBcbiAgICAgIDxidXR0b24gdHlwZT1cImJ1dHRvblwiIGNsYXNzPVwibWluaW1hbCBidG4gYnRuLXNlY29uZGFyeSBzYi1zY2VuZS1lbG8tYnV0dG9uXCIgdGl0bGU9XCIke1RJVExFfVwiPlxuICAgICAgICA8c3ZnIGNsYXNzPVwic3ZnLWlubGluZS0tZmEgZmEtaWNvblwiIGFyaWEtaGlkZGVuPVwidHJ1ZVwiIGZvY3VzYWJsZT1cImZhbHNlXCIgdmlld0JveD1cIjAgMCAzNiAzNlwiIHdpZHRoPVwiMWVtXCIgaGVpZ2h0PVwiMWVtXCI+JHtTV09SRFNfUEFUSFN9PC9zdmc+XG4gICAgICAgIDxzcGFuIGNsYXNzPVwic2Itc2NlbmUtZWxvLXZhbHVlXCI+PC9zcGFuPlxuICAgICAgPC9idXR0b24+YDtcbiAgaXRlbS5xdWVyeVNlbGVjdG9yKFwiYnV0dG9uXCIpPy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4gb3BlbkJhdHRsZSgpKTtcbiAgcmV0dXJuIGl0ZW07XG59XG5cbi8qKiBUaGUgdG9vbGJhciBncm91cCBob2xkaW5nIFBsYXkgQ291bnQgYW5kIE8gQ291bnQ7IHRoZSBpdGVtIGdvZXMgaW4gZnJvbnQgb2YgUGxheSBDb3VudC4gKi9cbmZ1bmN0aW9uIHBsYWNlSXRlbSh0b29sYmFyOiBFbGVtZW50LCBpdGVtOiBIVE1MRWxlbWVudCk6IGJvb2xlYW4ge1xuICBjb25zdCBwbGF5Q291bnQgPSB0b29sYmFyLnF1ZXJ5U2VsZWN0b3IoJ2J1dHRvblt0aXRsZT1cIlBsYXkgQ291bnRcIl0nKT8uY2xvc2VzdChcIi5zY2VuZS10b29sYmFyLWdyb3VwID4gKlwiKTtcbiAgaWYgKHBsYXlDb3VudCkge1xuICAgIHBsYXlDb3VudC5iZWZvcmUoaXRlbSk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgY29uc3QgZ3JvdXAgPSB0b29sYmFyLnF1ZXJ5U2VsZWN0b3IoXCIuc2NlbmUtdG9vbGJhci1ncm91cDpsYXN0LWNoaWxkXCIpO1xuICBpZiAoIWdyb3VwKSByZXR1cm4gZmFsc2U7XG4gIGdyb3VwLnByZXBlbmQoaXRlbSk7XG4gIHJldHVybiB0cnVlO1xufVxuXG5sZXQgcmVuZGVyaW5nOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuLyoqIEFkZCAob3IgdXBkYXRlKSB0aGUgaXRlbSBvbiB0aGUgY3VycmVudCBzY2VuZSBwYWdlLiBTYWZlIHRvIGNhbGwgb2Z0ZW4uICovXG5hc3luYyBmdW5jdGlvbiByZW5kZXJTY2VuZUVsbyhmb3JjZSA9IGZhbHNlKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHNjZW5lSWQgPSBnZXRTY2VuZUlkRnJvbVVybCgpO1xuICBjb25zdCB0b29sYmFyID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihcIi5zY2VuZS10b29sYmFyXCIpO1xuICBpZiAoIXNjZW5lSWQgfHwgIXRvb2xiYXIpIHJldHVybjtcbiAgY29uc3QgZXhpc3RpbmcgPSB0b29sYmFyLnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KGAuJHtJVEVNX0NMQVNTfWApO1xuICBpZiAoIWZvcmNlICYmIGV4aXN0aW5nPy5kYXRhc2V0LnNjZW5lSWQgPT09IHNjZW5lSWQpIHJldHVybjtcbiAgaWYgKHJlbmRlcmluZyA9PT0gc2NlbmVJZCkgcmV0dXJuO1xuXG4gIHJlbmRlcmluZyA9IHNjZW5lSWQ7XG4gIHRyeSB7XG4gICAgaWYgKCEoYXdhaXQgc2NlbmVDdXN0b21GaWVsZHNTdXBwb3J0ZWQoKSkpIHJldHVybjtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBzY2VuZUFuZFJhbmsoc2NlbmVJZCk7XG4gICAgLy8gVGhlIHBhZ2UgbWF5IGhhdmUgbW92ZWQgb24gKGFub3RoZXIgc2NlbmUsIG9yIHRoZSB0b29sYmFyIHJlLXJlbmRlcmVkKSB3aGlsZSB0aGlzIGxvYWRlZFxuICAgIGlmICghcmVzdWx0IHx8IGdldFNjZW5lSWRGcm9tVXJsKCkgIT09IHNjZW5lSWQpIHJldHVybjtcbiAgICBjb25zdCB0YXJnZXQgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKFwiLnNjZW5lLXRvb2xiYXJcIik7XG4gICAgaWYgKCF0YXJnZXQpIHJldHVybjtcblxuICAgIGxldCBpdGVtID0gdGFyZ2V0LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KGAuJHtJVEVNX0NMQVNTfWApO1xuICAgIGlmICghaXRlbSkge1xuICAgICAgaXRlbSA9IGNyZWF0ZUl0ZW0oKTtcbiAgICAgIGlmICghcGxhY2VJdGVtKHRhcmdldCwgaXRlbSkpIHJldHVybjtcbiAgICB9XG4gICAgaXRlbS5kYXRhc2V0LnNjZW5lSWQgPSBzY2VuZUlkO1xuICAgIGNvbnN0IHZhbHVlID0gaXRlbS5xdWVyeVNlbGVjdG9yKFwiLnNiLXNjZW5lLWVsby12YWx1ZVwiKTtcbiAgICBpZiAodmFsdWUpIHZhbHVlLnRleHRDb250ZW50ID0gbGFiZWxUZXh0KHJlc3VsdC5zY2VuZSwgcmVzdWx0LnJhbmspO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS53YXJuKFwiW1N0YXNoIEJhdHRsZV0gQ291bGRuJ3Qgc2hvdyB0aGUgc2NlbmUncyBFTE86XCIsIGUpO1xuICB9IGZpbmFsbHkge1xuICAgIHJlbmRlcmluZyA9IG51bGw7XG4gIH1cbn1cblxuLyoqIFJlZnJlc2ggdGhlIGl0ZW0gZnJvbSB0aGUgY2FjaGUgKGFmdGVyIGJhdHRsZXMgY2hhbmdlIEVMTykuICovXG5leHBvcnQgZnVuY3Rpb24gcmVmcmVzaFNjZW5lRWxvKCk6IHZvaWQge1xuICB2b2lkIHJlbmRlclNjZW5lRWxvKHRydWUpO1xufVxuXG4vKipcbiAqIFNob3cgdGhlIEVMTyBpdGVtIG9uIHNjZW5lIHBhZ2VzLCByZS1hZGRpbmcgaXQgYXMgU3Rhc2ggbmF2aWdhdGVzIGFuZCByZS1yZW5kZXJzOyBjbGlja2luZyBpdFxuICogY2FsbHMgYG9uQ2xpY2tgIChvcGVucyBTdGFzaCBCYXR0bGUpLiBDYWxsIG9uY2UgYXQgc3RhcnR1cC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdGVyU2NlbmVFbG8ob25DbGljazogKCkgPT4gdm9pZCk6IHZvaWQge1xuICBvcGVuQmF0dGxlID0gb25DbGljaztcbiAgbGV0IHF1ZXVlZCA9IGZhbHNlO1xuICBjb25zdCBjaGVjayA9ICgpOiB2b2lkID0+IHtcbiAgICBxdWV1ZWQgPSBmYWxzZTtcbiAgICBpZiAoZ2V0U2NlbmVJZEZyb21VcmwoKSkgdm9pZCByZW5kZXJTY2VuZUVsbygpO1xuICB9O1xuICAvLyBCYXRjaGVkIHdpdGggYSB0aW1lciwgbm90IGFuIGFuaW1hdGlvbiBmcmFtZTogZnJhbWVzIGRvbid0IHJ1biBpbiBhIGJhY2tncm91bmQgdGFiXG4gIG5ldyBNdXRhdGlvbk9ic2VydmVyKCgpID0+IHtcbiAgICBpZiAocXVldWVkKSByZXR1cm47XG4gICAgcXVldWVkID0gdHJ1ZTtcbiAgICBzZXRUaW1lb3V0KGNoZWNrLCA1MCk7XG4gIH0pLm9ic2VydmUoZG9jdW1lbnQuYm9keSwgeyBjaGlsZExpc3Q6IHRydWUsIHN1YnRyZWU6IHRydWUgfSk7XG4gIGNoZWNrKCk7XG59XG4iLCAiLy8gU2V0dXAgcHJldmlldzogdGVuIGV4YW1wbGUgc2NlbmVzIGluIHRocmVlIHJvd3MgKG5vdyBpbiBTdGFzaCAvIGFmdGVyIHNldHVwIC8gYWZ0ZXIgbG90cyBvZlxuLy8gYmF0dGxlcykuIEV2ZXJ5IG51bWJlciBjb21lcyBmcm9tIHRoZSByZWFsIHNjb3JlLnRzIGZ1bmN0aW9ucywgc28gdGhlIHByZXZpZXcgY2FuJ3QgZHJpZnRcbi8vIGZyb20gd2hhdCBzZXR1cCBhbmQgdGhlIFN0YXNoIHJhdGluZ3Mgb3B0aW9ucyBhY3R1YWxseSBkby5cblxuaW1wb3J0IHsgRUxPX0ZJRUxEIH0gZnJvbSBcIi4uL2NvbnN0YW50c1wiO1xuaW1wb3J0IHsgYWZ0ZXJTZXR1cCwgZWxvLCBzdGFzaFJhdGluZ1RhcmdldHMgfSBmcm9tIFwiLi4vc2NvcmVcIjtcbmltcG9ydCB0eXBlIHsgRWxvU3RhcnQsIFNjZW5lLCBTdGFzaFJhdGluZ3NNb2RlIH0gZnJvbSBcIi4uL3R5cGVzXCI7XG5cbi8qKiBFeGFtcGxlIFN0YXNoIHJhdGluZ3MgdG9kYXk6IHRoZSB0aWUgYXQgMTAwIHNob3dzIGhvdyByYXRpbmdzIGJ1bmNoIHVwIGF0IHRoZSB0b3AuICovXG5jb25zdCBOT1dfUkFUSU5HUzogKG51bWJlciB8IG51bGwpW10gPSBbMTAwLCAxMDAsIDk2LCA4NSwgNzQsIDcwLCA2MiwgNDUsIDIwLCBudWxsXTtcblxuLyoqIEV4YW1wbGUgRUxPIG9uY2UgYmF0dGxlcyBoYXZlIHNwcmVhZCB0aGUgc2NlbmVzIG91dCAodGhlIHNhbWUgZm9yIGJvdGggc3RhcnQgY2hvaWNlcykuICovXG5jb25zdCBCQVRUTEVEX0VMTyA9IFsyMTUwLCAxOTgwLCAxNzAwLCAxNjUwLCAxNjAwLCAxNTUwLCAxNTAwLCAxNDAwLCAxMjUwLCAxMTAwXTtcblxuaW50ZXJmYWNlIFNxdWFyZSB7XG4gIGVsbzogbnVtYmVyIHwgbnVsbDtcbiAgcmF0aW5nOiBudW1iZXIgfCBudWxsO1xuICBjaGFuZ2VkOiBib29sZWFuO1xufVxuXG5mdW5jdGlvbiBleGFtcGxlU2NlbmVzKCk6IFNjZW5lW10ge1xuICByZXR1cm4gTk9XX1JBVElOR1MubWFwKChyYXRpbmcxMDAsIGkpID0+ICh7IGlkOiBgZXhhbXBsZS0ke2l9YCwgcmF0aW5nMTAwLCBjdXN0b21fZmllbGRzOiB7fSB9KSk7XG59XG5cbi8qKiBFYWNoIHNjZW5lJ3MgU3Rhc2ggcmF0aW5nIHVuZGVyIHRoZSBtb2RlOiB3cml0dGVuIG9uZXMgZ2V0IHRoZWlyIHRhcmdldCwgb3RoZXJzIHN0YXkgYXMgbm93LiAqL1xuZnVuY3Rpb24gc3F1YXJlcyhzY2VuZXM6IFNjZW5lW10sIG1vZGU6IFN0YXNoUmF0aW5nc01vZGUpOiBTcXVhcmVbXSB7XG4gIGNvbnN0IHRhcmdldHMgPSBzdGFzaFJhdGluZ1RhcmdldHMoc2NlbmVzLCBtb2RlKTtcbiAgcmV0dXJuIHNjZW5lcy5tYXAoKHNjZW5lKSA9PiB7XG4gICAgY29uc3QgcmF0aW5nID0gdGFyZ2V0cy5nZXQoc2NlbmUuaWQpID8/IHNjZW5lLnJhdGluZzEwMCA/PyBudWxsO1xuICAgIHJldHVybiB7IGVsbzogZWxvKHNjZW5lKSwgcmF0aW5nLCBjaGFuZ2VkOiByYXRpbmcgIT09IChzY2VuZS5yYXRpbmcxMDAgPz8gbnVsbCkgfTtcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHNxdWFyZUh0bWwoeyBlbG86IGVsb1ZhbHVlLCByYXRpbmcsIGNoYW5nZWQgfTogU3F1YXJlLCBzaG93Q2hhbmdlOiBib29sZWFuKTogc3RyaW5nIHtcbiAgY29uc3QgY2xhc3NlcyA9IFtcInNiLXB2LXNxdWFyZVwiXTtcbiAgaWYgKHJhdGluZyA9PT0gbnVsbCkgY2xhc3Nlcy5wdXNoKFwic2ItcHYtdW5yYXRlZFwiKTtcbiAgaWYgKHJhdGluZyAhPT0gbnVsbCAmJiByYXRpbmcgPiA1NSkgY2xhc3Nlcy5wdXNoKFwic2ItcHYtc3Ryb25nXCIpO1xuICBpZiAoc2hvd0NoYW5nZSAmJiBjaGFuZ2VkKSBjbGFzc2VzLnB1c2goXCJzYi1wdi1jaGFuZ2VkXCIpO1xuICBjb25zdCBmaWxsID0gcmF0aW5nID09PSBudWxsID8gXCJcIiA6IGAgc3R5bGU9XCItLXNiLXB2LWZpbGw6ICR7cmF0aW5nfSVcImA7XG4gIHJldHVybiBgXG4gICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItcHYtY2VsbFwiPlxuICAgICAgICAgICAgICA8c3BhbiBjbGFzcz1cInNiLXB2LWVsb1wiPiR7ZWxvVmFsdWUgPT09IG51bGwgPyBcIlwiIDogTWF0aC5yb3VuZChlbG9WYWx1ZSl9PC9zcGFuPlxuICAgICAgICAgICAgICA8c3BhbiBjbGFzcz1cIiR7Y2xhc3Nlcy5qb2luKFwiIFwiKX1cIiR7ZmlsbH0+JHtyYXRpbmcgPz8gXCLigJNcIn08L3NwYW4+XG4gICAgICAgICAgICA8L2Rpdj5gO1xufVxuXG5mdW5jdGlvbiByb3dIdG1sKGxhYmVsOiBzdHJpbmcsIGNlbGxzOiBTcXVhcmVbXSwgbm90ZTogc3RyaW5nLCBvcHRpb25zOiB7IG11dGVkPzogYm9vbGVhbjsgc2hvd0NoYW5nZT86IGJvb2xlYW4gfSA9IHt9KTogc3RyaW5nIHtcbiAgcmV0dXJuIGBcbiAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItcHYtcm93JHtvcHRpb25zLm11dGVkID8gXCIgc2ItcHYtbXV0ZWRcIiA6IFwiXCJ9XCI+XG4gICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItcHYtbGFiZWxcIj4ke2xhYmVsfTwvZGl2PlxuICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNiLXB2LXNxdWFyZXNcIj4ke2NlbGxzLm1hcCgoY2VsbCkgPT4gc3F1YXJlSHRtbChjZWxsLCBvcHRpb25zLnNob3dDaGFuZ2UgPz8gZmFsc2UpKS5qb2luKFwiXCIpfVxuICAgICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItcHYtbm90ZVwiPiR7bm90ZX08L2Rpdj5cbiAgICAgICAgICA8L2Rpdj5gO1xufVxuXG4vKiogSG93IGxvbmcgYSBudW1iZXIgY291bnRzIGZyb20gaXRzIG9sZCB2YWx1ZSB0byBpdHMgbmV3IG9uZSAoY29sb3VycyBmYWRlIG92ZXIgdGhlIHNhbWUgdGltZSBpbiBDU1MpLiAqL1xuY29uc3QgVFdFRU5fTVMgPSA0MDA7XG5cbi8qKiBSdW5uaW5nIGNvdW50IHBlciBlbGVtZW50OiBpdHMgYW5pbWF0aW9uIGZyYW1lLCBhbmQgYSB0aW1lciB0aGF0IGxhbmRzIGl0IGlmIGZyYW1lcyBzdGFsbC4gKi9cbmNvbnN0IHR3ZWVucyA9IG5ldyBXZWFrTWFwPEVsZW1lbnQsIHsgZnJhbWU6IG51bWJlcjsgdGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IH0+KCk7XG5cbi8qKiBDb3VudCBhbiBlbGVtZW50J3MgbnVtYmVyIGZyb20gd2hhdCBpdCBzaG93cyBub3cgdG8gYHRhcmdldGA7IG5vbi1udW1iZXJzICjigJMsIGJsYW5rKSBqdXN0IHN3YXAuICovXG5mdW5jdGlvbiB0d2VlblRleHQoZWw6IEVsZW1lbnQsIHRhcmdldDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IHJ1bm5pbmcgPSB0d2VlbnMuZ2V0KGVsKTtcbiAgaWYgKHJ1bm5pbmcpIHtcbiAgICBjYW5jZWxBbmltYXRpb25GcmFtZShydW5uaW5nLmZyYW1lKTtcbiAgICBjbGVhclRpbWVvdXQocnVubmluZy50aW1lcik7XG4gICAgdHdlZW5zLmRlbGV0ZShlbCk7XG4gIH1cbiAgY29uc3QgZnJvbSA9IE51bWJlcihlbC50ZXh0Q29udGVudCk7XG4gIGNvbnN0IHRvID0gTnVtYmVyKHRhcmdldCk7XG4gIGlmIChlbC50ZXh0Q29udGVudCA9PT0gXCJcIiB8fCB0YXJnZXQgPT09IFwiXCIgfHwgIU51bWJlci5pc0Zpbml0ZShmcm9tKSB8fCAhTnVtYmVyLmlzRmluaXRlKHRvKSB8fCBmcm9tID09PSB0bykge1xuICAgIGVsLnRleHRDb250ZW50ID0gdGFyZ2V0O1xuICAgIHJldHVybjtcbiAgfVxuICBjb25zdCBzdGFydFRpbWUgPSBwZXJmb3JtYW5jZS5ub3coKTtcbiAgLy8gQmFja2dyb3VuZCB0YWJzIGdldCBubyBhbmltYXRpb24gZnJhbWVzOiBsYW5kIG9uIHRoZSBmaW5hbCBudW1iZXIgcmVnYXJkbGVzc1xuICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgIGNvbnN0IGN1cnJlbnQgPSB0d2VlbnMuZ2V0KGVsKTtcbiAgICBpZiAoY3VycmVudCkgY2FuY2VsQW5pbWF0aW9uRnJhbWUoY3VycmVudC5mcmFtZSk7XG4gICAgdHdlZW5zLmRlbGV0ZShlbCk7XG4gICAgZWwudGV4dENvbnRlbnQgPSB0YXJnZXQ7XG4gIH0sIFRXRUVOX01TICsgNTApO1xuICBjb25zdCBzdGVwID0gKG5vdzogbnVtYmVyKTogdm9pZCA9PiB7XG4gICAgY29uc3QgdCA9IE1hdGgubWluKDEsIChub3cgLSBzdGFydFRpbWUpIC8gVFdFRU5fTVMpO1xuICAgIGNvbnN0IGVhc2VkID0gMSAtIE1hdGgucG93KDEgLSB0LCAzKTtcbiAgICBlbC50ZXh0Q29udGVudCA9IFN0cmluZyhNYXRoLnJvdW5kKGZyb20gKyAodG8gLSBmcm9tKSAqIGVhc2VkKSk7XG4gICAgaWYgKHQgPCAxKSB0d2VlbnMuc2V0KGVsLCB7IGZyYW1lOiByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoc3RlcCksIHRpbWVyIH0pO1xuICB9O1xuICB0d2VlbnMuc2V0KGVsLCB7IGZyYW1lOiByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoc3RlcCksIHRpbWVyIH0pO1xufVxuXG4vKipcbiAqIFNob3cgdGhlIHByZXZpZXcgaW4gYGNvbnRhaW5lcmAuIFdoZW4gb25lIGlzIGFscmVhZHkgdGhlcmUsIGl0J3MgdXBkYXRlZCBpbiBwbGFjZSBzbyB0aGVcbiAqIG51bWJlcnMgY291bnQgdG8gdGhlaXIgbmV3IHZhbHVlcyBhbmQgdGhlIGNvbG91cnMgZmFkZSAoQ1NTIHRyYW5zaXRpb25zKSBpbnN0ZWFkIG9mIGp1bXBpbmcuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzaG93UmF0aW5nUHJldmlldyhjb250YWluZXI6IEhUTUxFbGVtZW50LCBzdGFydDogRWxvU3RhcnQsIHN0YXNoUmF0aW5nczogU3Rhc2hSYXRpbmdzTW9kZSk6IHZvaWQge1xuICBjb25zdCBuZXh0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbmV4dC5pbm5lckhUTUwgPSByZW5kZXJSYXRpbmdQcmV2aWV3KHN0YXJ0LCBzdGFzaFJhdGluZ3MpO1xuICBjb25zdCBjdXJyZW50ID0gY29udGFpbmVyLnF1ZXJ5U2VsZWN0b3IoXCIuc2ItcmF0aW5nLXByZXZpZXdcIik7XG4gIGNvbnN0IHJlZHVjZWRNb3Rpb24gPSB3aW5kb3cubWF0Y2hNZWRpYShcIihwcmVmZXJzLXJlZHVjZWQtbW90aW9uOiByZWR1Y2UpXCIpLm1hdGNoZXM7XG4gIGlmICghY3VycmVudCB8fCByZWR1Y2VkTW90aW9uKSB7XG4gICAgY29udGFpbmVyLnJlcGxhY2VDaGlsZHJlbiguLi5uZXh0LmNoaWxkTm9kZXMpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IGZyZXNoID0gbmV4dC5xdWVyeVNlbGVjdG9yKFwiLnNiLXJhdGluZy1wcmV2aWV3XCIpIGFzIEVsZW1lbnQ7XG4gIGNvbnN0IHBhaXJzID0gKHNlbGVjdG9yOiBzdHJpbmcpOiBbRWxlbWVudCwgRWxlbWVudF1bXSA9PiB7XG4gICAgY29uc3Qgbm93ID0gY3VycmVudC5xdWVyeVNlbGVjdG9yQWxsKHNlbGVjdG9yKTtcbiAgICByZXR1cm4gWy4uLmZyZXNoLnF1ZXJ5U2VsZWN0b3JBbGwoc2VsZWN0b3IpXS5tYXAoKGVsLCBpKSA9PiBbbm93W2ldLCBlbF0pO1xuICB9O1xuICBmb3IgKGNvbnN0IFtlbCwgdG9dIG9mIHBhaXJzKFwiLnNiLXB2LXJvd1wiKSkgZWwuY2xhc3NOYW1lID0gdG8uY2xhc3NOYW1lO1xuICBmb3IgKGNvbnN0IFtlbCwgdG9dIG9mIHBhaXJzKFwiLnNiLXB2LW5vdGVcIikpIGVsLnRleHRDb250ZW50ID0gdG8udGV4dENvbnRlbnQ7XG4gIGZvciAoY29uc3QgW2VsLCB0b10gb2YgcGFpcnMoXCIuc2ItcHYtZWxvXCIpKSB0d2VlblRleHQoZWwsIHRvLnRleHRDb250ZW50ID8/IFwiXCIpO1xuICBmb3IgKGNvbnN0IFtlbCwgdG9dIG9mIHBhaXJzKFwiLnNiLXB2LXNxdWFyZVwiKSkge1xuICAgIGVsLmNsYXNzTmFtZSA9IHRvLmNsYXNzTmFtZTtcbiAgICBlbC5zZXRBdHRyaWJ1dGUoXCJzdHlsZVwiLCB0by5nZXRBdHRyaWJ1dGUoXCJzdHlsZVwiKSA/PyBcIlwiKTtcbiAgICB0d2VlblRleHQoZWwsIHRvLnRleHRDb250ZW50ID8/IFwiXCIpO1xuICB9XG59XG5cbi8qKiBUaGUgcHJldmlldyBmb3Igb25lIHBhaXIgb2Ygc2V0dXAgYW5zd2VycywgYXMgYW4gSFRNTCBzdHJpbmcuICovXG5leHBvcnQgZnVuY3Rpb24gcmVuZGVyUmF0aW5nUHJldmlldyhzdGFydDogRWxvU3RhcnQsIHN0YXNoUmF0aW5nczogU3Rhc2hSYXRpbmdzTW9kZSk6IHN0cmluZyB7XG4gIGNvbnN0IG9mZiA9IHN0YXNoUmF0aW5ncyA9PT0gXCJvZmZcIjtcbiAgY29uc3Qgbm93ID0gc3F1YXJlcyhleGFtcGxlU2NlbmVzKCksIFwib2ZmXCIpO1xuXG4gIGNvbnN0IHNldFVwID0gc3F1YXJlcyhleGFtcGxlU2NlbmVzKCkubWFwKChzY2VuZSkgPT4gYWZ0ZXJTZXR1cChzY2VuZSwgc3RhcnQpKSwgc3Rhc2hSYXRpbmdzKTtcbiAgY29uc3QgY2hhbmdlZENvdW50ID0gc2V0VXAuZmlsdGVyKChjZWxsKSA9PiBjZWxsLmNoYW5nZWQpLmxlbmd0aDtcblxuICBjb25zdCBiYXR0bGVkID0gZXhhbXBsZVNjZW5lcygpLm1hcCgoc2NlbmUsIGkpID0+ICh7IC4uLnNjZW5lLCBjdXN0b21fZmllbGRzOiB7IFtFTE9fRklFTERdOiBCQVRUTEVEX0VMT1tpXSB9IH0pKTtcbiAgY29uc3QgbGF0ZXIgPSBzcXVhcmVzKGJhdHRsZWQsIHN0YXNoUmF0aW5ncyk7XG5cbiAgY29uc3QgdW5jaGFuZ2VkTm90ZSA9IFwiU3Rhc2ggcmF0aW5ncyBzdGF5IGFzIHRoZXkgYXJlXCI7XG4gIGNvbnN0IGxhdGVyTm90ZSA9IG9mZlxuICAgID8gdW5jaGFuZ2VkTm90ZVxuICAgIDogc3Rhc2hSYXRpbmdzID09PSBcInBlcmNlbnRpbGVcIlxuICAgICAgPyBcIkV2ZW5seSBzcGFjZWQgYnkgcmFuaywgd2hhdGV2ZXIgdGhlIGdhcHNcIlxuICAgICAgOiBcIkdhcHMgc2hvdywgYnV0IDIxNTAgaXMgc3R1Y2sgYXQgMTAwXCI7XG5cbiAgcmV0dXJuIGBcbiAgICAgICAgPGRpdiBjbGFzcz1cInNiLXJhdGluZy1wcmV2aWV3XCI+XG4gICAgICAgICAgPHAgY2xhc3M9XCJzYi1wdi1sZWdlbmRcIj5FYWNoIHNxdWFyZSBiZWxvdyBpcyBhbiBleGFtcGxlIHNjZW5lOiBpdHMgRUxPIGFib3ZlLCBpdHMgU3Rhc2ggcmF0aW5nIGluc2lkZS48L3A+XG4gICAgICAgICAgJHtyb3dIdG1sKFwiTm93IGluIFN0YXNoXCIsIG5vdywgXCJcIil9XG4gICAgICAgICAgJHtyb3dIdG1sKFwiQWZ0ZXIgc2V0dXBcIiwgc2V0VXAsIG9mZiA/IHVuY2hhbmdlZE5vdGUgOiBgJHtjaGFuZ2VkQ291bnR9IG9mIDEwIGNoYW5nZWAsIHsgbXV0ZWQ6IG9mZiwgc2hvd0NoYW5nZTogIW9mZiB9KX1cbiAgICAgICAgICAke3Jvd0h0bWwoXCJBZnRlciBsb3RzIG9mIGJhdHRsZXNcIiwgbGF0ZXIsIGxhdGVyTm90ZSwgeyBtdXRlZDogb2ZmIH0pfVxuICAgICAgICA8L2Rpdj5gO1xufVxuIiwgIi8vIE9uZS10aW1lIEVMTyBzZXR1cCBzY3JlZW4sIHNob3duIGluIHRoZSBCYXR0bGUgdGFiIGluIHBsYWNlIG9mIHRoZSBiYXR0bGUgdW50aWwgaXQncyBkb25lLlxuLy8gVHdvIHF1ZXN0aW9ucyBzaWRlIGJ5IHNpZGUgKGhvdyBFTE8gc3RhcnRzLCB3aGV0aGVyIFN0YXNoIEJhdHRsZSB3cml0ZXMgU3Rhc2ggcmF0aW5ncykgYWJvdmVcbi8vIGEgc2hhcmVkIHByZXZpZXcsIHRoZW4gYSBwcm9ncmVzcyB2aWV3IHdoaWxlIGVsb1NldHVwLnRzIHdyaXRlcywgdGhlbiBhIHN1bW1hcnkuIFJlc2V0IEVMT1xuLy8gKFNldHRpbmdzKSBzaG93cyB0aGUgc2FtZSBzY3JlZW4gaW4gcmVzZXQgbW9kZSwgd2l0aCBhIENhbmNlbCBidXR0b24uXG5cbmltcG9ydCB7IGNsZWFyU2NlbmVDYWNoZSB9IGZyb20gXCIuLi9jYWNoZVwiO1xuaW1wb3J0IHsgZmV0Y2hTZXR1cFNjZW5lcywgcnVuRWxvU2V0dXAsIHNldHVwUmF0aW5nQ2hhbmdlcywgdHlwZSBTZXR1cFBoYXNlLCB0eXBlIFNldHVwU3VtbWFyeSB9IGZyb20gXCIuLi9lbG9TZXR1cFwiO1xuaW1wb3J0IHsgaXNSYXRlZCB9IGZyb20gXCIuLi9zY29yZVwiO1xuaW1wb3J0IHsgaGFkRnVuTW9kZSwgdXBkYXRlU2V0dGluZ3NOb3cgfSBmcm9tIFwiLi4vc2V0dGluZ3NcIjtcbmltcG9ydCB7IHJlc2V0UnVuU3RhdGUsIHJlc2V0U2h1ZmZsZSwgc3RhdGUgfSBmcm9tIFwiLi4vc3RhdGVcIjtcbmltcG9ydCB7IHNhdmVTdGF0ZSB9IGZyb20gXCIuLi9zdG9yYWdlXCI7XG5pbXBvcnQgdHlwZSB7IEVsb1N0YXJ0LCBTY2VuZSwgU3Rhc2hSYXRpbmdzTW9kZSB9IGZyb20gXCIuLi90eXBlc1wiO1xuaW1wb3J0IHsgc2hvd1JhdGluZ1ByZXZpZXcgfSBmcm9tIFwiLi9yYXRpbmdQcmV2aWV3XCI7XG5pbXBvcnQgeyBTVEFTSF9SQVRJTkdTX09QVElPTlMgfSBmcm9tIFwiLi9zdGFzaFJhdGluZ3NUZXh0XCI7XG5cbi8qKiBPbiB0aGUgQmF0dGxlIHBhbmVsIHdoaWxlIHNldHVwIHNob3dzOyBDU1MgaGlkZXMgdGhlIGJhdHRsZSBVSSAobW9kZXMsIGNhcmRzLCBhY3Rpb25zKS4gKi9cbmNvbnN0IFNFVFVQX0FDVElWRV9DTEFTUyA9IFwic2Itc2V0dXAtYWN0aXZlXCI7XG5cbi8qKiBUcnVlIGZyb20gU3RhcnQgdW50aWwgdGhlIHdyaXRlcyBmaW5pc2ggb3IgZmFpbDsgcmVvcGVuaW5nIEJhdHRsZSBtZWFud2hpbGUga2VlcHMgdGhlIHByb2dyZXNzLiAqL1xubGV0IHJ1bm5pbmcgPSBmYWxzZTtcblxuZXhwb3J0IGludGVyZmFjZSBTZXR1cFNjcmVlbk9wdGlvbnMge1xuICAvKiogUmVzZXQgRUxPOiBldmVyeXRoaW5nIGFscmVhZHkgaGFzIGFuIEVMTzsgdGhlIGN1cnJlbnQgU3Rhc2ggcmF0aW5ncyBvcHRpb24gaXMgcHJlc2VsZWN0ZWQuICovXG4gIHJlc2V0PzogYm9vbGVhbjtcbiAgLyoqIFJlc2V0IG1vZGUncyBDYW5jZWwgYnV0dG9uIChiZWZvcmUgYW55dGhpbmcgaXMgd3JpdHRlbikuICovXG4gIG9uQ2FuY2VsPzogKCkgPT4gdm9pZDtcbn1cblxubGV0IG9wdGlvbnM6IFNldHVwU2NyZWVuT3B0aW9ucyA9IHt9O1xuXG5pbnRlcmZhY2UgQ2hvaWNlIHtcbiAgc3RhcnQ6IEVsb1N0YXJ0O1xuICBzdGFzaFJhdGluZ3M6IFN0YXNoUmF0aW5nc01vZGU7XG59XG5cbmNvbnN0IHBsdXJhbCA9IChuOiBudW1iZXIsIHdvcmQ6IHN0cmluZyk6IHN0cmluZyA9PiBgJHtufSAke3dvcmR9JHtuID09PSAxID8gXCJcIiA6IFwic1wifWA7XG5cbmZ1bmN0aW9uIHNldHVwQXJlYShyb290OiBQYXJlbnROb2RlKTogSFRNTEVsZW1lbnQgfCBudWxsIHtcbiAgcmV0dXJuIHJvb3QucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCIjc2Itc2V0dXAtYXJlYVwiKTtcbn1cblxuLyoqIFRydWUgd2hpbGUgc2V0dXAgaXMgd3JpdGluZyAoU3RhcnQgcHJlc3NlZCwgbm90IGZpbmlzaGVkIG9yIGZhaWxlZCB5ZXQpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzU2V0dXBSdW5uaW5nKCk6IGJvb2xlYW4ge1xuICByZXR1cm4gcnVubmluZztcbn1cblxuLyoqIFNob3cgdGhlIHNldHVwIGluIHRoZSBCYXR0bGUgdGFiLiBgb25Eb25lYCBydW5zIG9uY2Ugc2V0dXAgaGFzIGZpbmlzaGVkIGFuZCBiZWVuIHNhdmVkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNob3dTZXR1cFNjcmVlbihyb290OiBQYXJlbnROb2RlLCBvbkRvbmU6ICgpID0+IHZvaWQsIHNjcmVlbk9wdGlvbnM6IFNldHVwU2NyZWVuT3B0aW9ucyA9IHt9KTogdm9pZCB7XG4gIGNvbnN0IGFyZWEgPSBzZXR1cEFyZWEocm9vdCk7XG4gIGlmICghYXJlYSkgcmV0dXJuO1xuICBhcmVhLmNsb3Nlc3QoXCIuc2ItdGFiLXBhbmVsXCIpPy5jbGFzc0xpc3QuYWRkKFNFVFVQX0FDVElWRV9DTEFTUyk7XG4gIGFyZWEuaGlkZGVuID0gZmFsc2U7XG4gIGlmIChydW5uaW5nKSByZXR1cm47XG4gIG9wdGlvbnMgPSBzY3JlZW5PcHRpb25zO1xuICB2b2lkIGxvYWRDaG9pY2VzKGFyZWEsIG9uRG9uZSk7XG59XG5cbi8qKiBQdXQgdGhlIGJhdHRsZSBVSSBiYWNrIChzZXR1cCBmaW5pc2hlZCwgcG9zc2libHkgZWxzZXdoZXJlKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoaWRlU2V0dXBTY3JlZW4ocm9vdDogUGFyZW50Tm9kZSk6IHZvaWQge1xuICBjb25zdCBhcmVhID0gc2V0dXBBcmVhKHJvb3QpO1xuICBpZiAoIWFyZWEgfHwgcnVubmluZykgcmV0dXJuO1xuICBhcmVhLmNsb3Nlc3QoXCIuc2ItdGFiLXBhbmVsXCIpPy5jbGFzc0xpc3QucmVtb3ZlKFNFVFVQX0FDVElWRV9DTEFTUyk7XG4gIGFyZWEuaGlkZGVuID0gdHJ1ZTtcbiAgYXJlYS5pbm5lckhUTUwgPSBcIlwiO1xufVxuXG5hc3luYyBmdW5jdGlvbiBsb2FkQ2hvaWNlcyhhcmVhOiBIVE1MRWxlbWVudCwgb25Eb25lOiAoKSA9PiB2b2lkKTogUHJvbWlzZTx2b2lkPiB7XG4gIGFyZWEuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9XCJzYi1sb2FkaW5nXCI+TG9hZGluZyB5b3VyIGxpYnJhcnkuLi48L2Rpdj5gO1xuICBsZXQgc2NlbmVzOiBTY2VuZVtdO1xuICB0cnkge1xuICAgIHNjZW5lcyA9IGF3YWl0IGZldGNoU2V0dXBTY2VuZXMoKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnNvbGUuZXJyb3IoXCJbU3Rhc2ggQmF0dGxlXSBFTE8gc2V0dXA6IGNvdWxkIG5vdCBsb2FkIHNjZW5lczpcIiwgZSk7XG4gICAgc2hvd0Vycm9yKGFyZWEsIFwiQ291bGRuJ3QgbG9hZCB5b3VyIHNjZW5lcyBmcm9tIFN0YXNoLlwiLCAoKSA9PiB2b2lkIGxvYWRDaG9pY2VzKGFyZWEsIG9uRG9uZSkpO1xuICAgIHJldHVybjtcbiAgfVxuICByZW5kZXJDaG9pY2VzKGFyZWEsIHNjZW5lcywgb25Eb25lKTtcbn1cblxuZnVuY3Rpb24gcmFkaW8obmFtZTogc3RyaW5nLCB2YWx1ZTogc3RyaW5nLCBsYWJlbDogc3RyaW5nLCBkZXNjOiBzdHJpbmcsIGNoZWNrZWQ6IGJvb2xlYW4pOiBzdHJpbmcge1xuICBjb25zdCBpZCA9IGBzYi1zZXR1cC0ke25hbWV9LSR7dmFsdWV9YDtcbiAgcmV0dXJuIGBcbiAgICAgICAgICAgICAgPGRpdiBjbGFzcz1cImN1c3RvbS1jb250cm9sIGN1c3RvbS1yYWRpbyBzYi1zZXR1cC1vcHRpb25cIj5cbiAgICAgICAgICAgICAgICA8aW5wdXQgdHlwZT1cInJhZGlvXCIgY2xhc3M9XCJjdXN0b20tY29udHJvbC1pbnB1dFwiIGlkPVwiJHtpZH1cIiBuYW1lPVwiJHtuYW1lfVwiIHZhbHVlPVwiJHt2YWx1ZX1cIiAke2NoZWNrZWQgPyBcImNoZWNrZWRcIiA6IFwiXCJ9PlxuICAgICAgICAgICAgICAgIDxsYWJlbCBjbGFzcz1cImN1c3RvbS1jb250cm9sLWxhYmVsXCIgZm9yPVwiJHtpZH1cIj5cbiAgICAgICAgICAgICAgICAgIDxzdHJvbmc+JHtsYWJlbH08L3N0cm9uZz5cbiAgICAgICAgICAgICAgICAgIDxzcGFuIGNsYXNzPVwic2Itc2V0dXAtZGVzY1wiPiR7ZGVzY308L3NwYW4+XG4gICAgICAgICAgICAgICAgPC9sYWJlbD5cbiAgICAgICAgICAgICAgPC9kaXY+YDtcbn1cblxuLyoqIFdoYXQgdGhlIHNlY29uZCBhbnN3ZXIgZG9lcyB0byBTdGFzaCByYXRpbmdzIG5vdzogYSB3YXJuaW5nIHdoZW4gcmF0aW5ncyBjaGFuZ2UsIGVsc2UgYSBjYWxtIGxpbmUuICovXG5mdW5jdGlvbiByYXRpbmdzTWVzc2FnZShzdGFydDogRWxvU3RhcnQsIG1vZGU6IFN0YXNoUmF0aW5nc01vZGUsIGNoYW5nZXM6IG51bWJlcik6IHN0cmluZyB7XG4gIGNvbnN0IGJhY2t1cCA9IFwiVGFrZSBhIFN0YXNoIGJhY2t1cCBmaXJzdCAoU2V0dGluZ3Mg4oaSIFRhc2tzIOKGkiBCYWNrdXApLlwiO1xuICBsZXQgdGV4dDogc3RyaW5nO1xuICBsZXQgd2FybiA9IHRydWU7XG4gIGlmIChtb2RlID09PSBcIm9mZlwiKSB7XG4gICAgdGV4dCA9IFwiU3Rhc2ggcmF0aW5ncyB3b24ndCBjaGFuZ2UuXCI7XG4gICAgd2FybiA9IGZhbHNlO1xuICB9IGVsc2UgaWYgKGNoYW5nZXMgPT09IDApIHtcbiAgICB0ZXh0ID0gXCJObyBTdGFzaCByYXRpbmdzIGNoYW5nZSBub3c6IGV2ZXJ5IHNjZW5lIGNvbnZlcnRzIGJhY2sgdG8gaXRzIGN1cnJlbnQgcmF0aW5nLlwiO1xuICAgIHdhcm4gPSBmYWxzZTtcbiAgfSBlbHNlIGlmIChzdGFydCA9PT0gXCJmcmVzaFwiKSB7XG4gICAgdGV4dCA9IGDimqDvuI8gRXZlcnkgc2NlbmUgc3RhcnRzIGF0IDE1MDAgRUxPLCBzbyA8c3Ryb25nPmV2ZXJ5IFN0YXNoIHJhdGluZyBiZWNvbWVzIDUwPC9zdHJvbmc+OiAke3BsdXJhbChjaGFuZ2VzLCBcInJhdGluZ1wiKX0gY2hhbmdlLCB1bnJhdGVkIHNjZW5lcyBpbmNsdWRlZC4gJHtiYWNrdXB9YDtcbiAgfSBlbHNlIHtcbiAgICB0ZXh0ID0gYOKaoO+4jyA8c3Ryb25nPiR7cGx1cmFsKGNoYW5nZXMsIFwiU3Rhc2ggcmF0aW5nXCIpfSBjaGFuZ2U8L3N0cm9uZz4gbm93LCBzcHJlYWQgZXZlbmx5IGJ5IHJhbmsuIEEgc2NlbmUgeW91IHJhdGVkIDEwMCBieSBoYW5kIG1heSBlbmQgdXAgbG93ZXIuICR7YmFja3VwfWA7XG4gIH1cbiAgcmV0dXJuIGA8cCBjbGFzcz1cInNiLXNldHVwLW1lc3NhZ2Uke3dhcm4gPyBcIiBzYi1zZXR1cC13YXJuaW5nXCIgOiBcIlwifVwiPiR7dGV4dH08L3A+YDtcbn1cblxuZnVuY3Rpb24gcmVuZGVyQ2hvaWNlcyhhcmVhOiBIVE1MRWxlbWVudCwgc2NlbmVzOiBTY2VuZVtdLCBvbkRvbmU6ICgpID0+IHZvaWQpOiB2b2lkIHtcbiAgY29uc3QgdG90YWwgPSBzY2VuZXMubGVuZ3RoO1xuICBjb25zdCByYXRlZCA9IHNjZW5lcy5maWx0ZXIoKHNjZW5lKSA9PiBzY2VuZS5yYXRpbmcxMDAgIT0gbnVsbCkubGVuZ3RoO1xuICBjb25zdCB1bnJhdGVkID0gdG90YWwgLSByYXRlZDtcbiAgY29uc3Qgd2l0aEVsbyA9IHNjZW5lcy5maWx0ZXIoaXNSYXRlZCkubGVuZ3RoO1xuICAvLyBSZS1ydW5zIChSZXNldCBFTE8sIFN0YWdlIDQpIGFuZCBwcmUtMy4wIGZ1biBtb2RlIHVzZXJzIGhhZCBubyByYXRpbmcgdXBkYXRlcyB0byBsb3NlXG4gIGNvbnN0IHVwZ3JhZGVOb3RlID1cbiAgICAhc3RhdGUuc2V0dGluZ3MuZWxvU2V0dXBBdCAmJiAhaGFkRnVuTW9kZSgpXG4gICAgICA/IFwiIEJlZm9yZSAzLjAsIHJhdGluZ3MgY2hhbmdlZCBhZnRlciBldmVyeSBiYXR0bGU7IFN0cmFpZ2h0LWxpbmUgd2l0aCBVc2UgbXkgcmF0aW5ncyBpcyBjbG9zZXN0IHRvIHRoYXQuXCJcbiAgICAgIDogXCJcIjtcblxuICBjb25zdCByZXNldCA9IG9wdGlvbnMucmVzZXQgPT09IHRydWU7XG4gIGNvbnN0IGNob2ljZTogQ2hvaWNlID0geyBzdGFydDogXCJyYXRpbmdzXCIsIHN0YXNoUmF0aW5nczogcmVzZXQgPyBzdGF0ZS5zZXR0aW5ncy5zdGFzaFJhdGluZ3MgOiBcIm9mZlwiIH07XG5cbiAgYXJlYS5pbm5lckhUTUwgPSBgXG4gICAgICA8ZGl2IGNsYXNzPVwic2Itc2V0dXBcIj5cbiAgICAgICAgPGgyIGNsYXNzPVwic2Itc2V0dXAtdGl0bGVcIj4ke3Jlc2V0ID8gXCJSZXNldCBFTE9cIiA6IFwiU2V0IHVwIEVMT1wifTwvaDI+XG4gICAgICAgIDxwIGNsYXNzPVwic2Itc2V0dXAtaW50cm9cIj5cbiAgICAgICAgICAke1xuICAgICAgICAgICAgcmVzZXRcbiAgICAgICAgICAgICAgPyBcIkNob29zZSBob3cgRUxPIHN0YXJ0cyBhZ2Fpbi4gVGhpcyBvdmVyd3JpdGVzIGV2ZXJ5IHNjZW5lJ3MgRUxPIGFuZCBiYXR0bGUgY291bnQuXCJcbiAgICAgICAgICAgICAgOiBcIlN0YXNoIEJhdHRsZSBub3cgZ2l2ZXMgZWFjaCBzY2VuZSBhbiBFTE8gc2NvcmUsIHNhdmVkIGluIGl0cyBjdXN0b20gZmllbGRzLiBXaW5zIHJhaXNlIGl0LCBsb3NzZXMgbG93ZXIgaXQuIENob29zZSBob3cgaXQgc3RhcnRzLiBUaGlzIHJ1bnMgb25jZS5cIlxuICAgICAgICAgIH1cbiAgICAgICAgPC9wPlxuICAgICAgICAke1xuICAgICAgICAgIHdpdGhFbG8gPiAwICYmICFyZXNldFxuICAgICAgICAgICAgPyBgPHAgY2xhc3M9XCJzYi1zZXR1cC13YXJuaW5nXCI+JHtwbHVyYWwod2l0aEVsbywgXCJzY2VuZVwiKX0gYWxyZWFkeSAke3dpdGhFbG8gPT09IDEgPyBcImhhc1wiIDogXCJoYXZlXCJ9IGFuIEVMTyBmcm9tIGFuIGVhcmxpZXIgc2V0dXAgdGhhdCBkaWRuJ3QgZmluaXNoLiBTZXR0aW5nIHVwIGFnYWluIG92ZXJ3cml0ZXMgJHt3aXRoRWxvID09PSAxID8gXCJpdFwiIDogXCJ0aGVtXCJ9LjwvcD5gXG4gICAgICAgICAgICA6IFwiXCJcbiAgICAgICAgfVxuICAgICAgICA8ZGl2IGNsYXNzPVwic2Itc2V0dXAtcXVlc3Rpb25zXCI+XG4gICAgICAgICAgPGZpZWxkc2V0IGNsYXNzPVwic2Itc2V0dXAtcXVlc3Rpb25cIj5cbiAgICAgICAgICAgIDxsZWdlbmQ+SG93IHNob3VsZCBFTE8gc3RhcnQ/PC9sZWdlbmQ+XG4gICAgICAgICAgICAke3JhZGlvKFxuICAgICAgICAgICAgICBcInN0YXJ0XCIsXG4gICAgICAgICAgICAgIFwicmF0aW5nc1wiLFxuICAgICAgICAgICAgICBcIlVzZSBteSByYXRpbmdzXCIsXG4gICAgICAgICAgICAgIGBZb3VyICR7cGx1cmFsKHJhdGVkLCBcInJhdGVkIHNjZW5lXCIpfSBzdGFydCBmcm9tIHRoZWlyIHJhdGluZyAoNTAgPSAxNTAwIEVMTywgMTAgRUxPIHBlciBwb2ludCkuJHt1bnJhdGVkID4gMCA/IGAgVGhlICR7dW5yYXRlZH0gdW5yYXRlZCAke3VucmF0ZWQgPT09IDEgPyBcIm9uZSBzdGF5c1wiIDogXCJvbmVzIHN0YXlcIn0gdW5yYXRlZC5gIDogXCJcIn1gLFxuICAgICAgICAgICAgICB0cnVlLFxuICAgICAgICAgICAgKX1cbiAgICAgICAgICAgICR7cmFkaW8oXG4gICAgICAgICAgICAgIFwic3RhcnRcIixcbiAgICAgICAgICAgICAgXCJmcmVzaFwiLFxuICAgICAgICAgICAgICBcIlN0YXJ0IGV2ZXJ5b25lIGF0IDE1MDBcIixcbiAgICAgICAgICAgICAgYEFsbCAke3BsdXJhbCh0b3RhbCwgXCJzY2VuZVwiKX0gc3RhcnQgZXF1YWwuYCxcbiAgICAgICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgICApfVxuICAgICAgICAgIDwvZmllbGRzZXQ+XG4gICAgICAgICAgPGZpZWxkc2V0IGNsYXNzPVwic2Itc2V0dXAtcXVlc3Rpb25cIj5cbiAgICAgICAgICAgIDxsZWdlbmQ+U2hvdWxkIFN0YXNoIEJhdHRsZSBjaGFuZ2UgeW91ciBTdGFzaCByYXRpbmdzPzwvbGVnZW5kPlxuICAgICAgICAgICAgJHtTVEFTSF9SQVRJTkdTX09QVElPTlMubWFwKCh7IHZhbHVlLCBsYWJlbCwgZGVzYyB9KSA9PlxuICAgICAgICAgICAgICByYWRpbyhcInN0YXNoUmF0aW5nc1wiLCB2YWx1ZSwgbGFiZWwsIGRlc2MsIHZhbHVlID09PSBjaG9pY2Uuc3Rhc2hSYXRpbmdzKSxcbiAgICAgICAgICAgICkuam9pbihcIlwiKX1cbiAgICAgICAgICAgIDxwIGNsYXNzPVwic2Itc2V0dXAtbm90ZVwiPllvdSBjYW4gY2hhbmdlIHRoaXMgbGF0ZXIgaW4gU2V0dGluZ3MuJHt1cGdyYWRlTm90ZX08L3A+XG4gICAgICAgICAgPC9maWVsZHNldD5cbiAgICAgICAgPC9kaXY+XG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi1zZXR1cC1tZXNzYWdlLXNsb3RcIiBkYXRhLXJvbGU9XCJyYXRpbmdzLXdhcm5pbmdcIj48L2Rpdj5cbiAgICAgICAgPGgzIGNsYXNzPVwic2Itc2V0dXAtc3VidGl0bGVcIj5QcmV2aWV3PC9oMz5cbiAgICAgICAgPGRpdiBkYXRhLXJvbGU9XCJwcmV2aWV3XCI+PC9kaXY+XG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi1zZXR1cC1hY3Rpb25zXCI+XG4gICAgICAgICAgJHtyZXNldCA/IGA8YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cImJ0biBidG4tc2Vjb25kYXJ5XCIgZGF0YS1yb2xlPVwiY2FuY2VsXCI+Q2FuY2VsPC9idXR0b24+YCA6IFwiXCJ9XG4gICAgICAgICAgPGJ1dHRvbiB0eXBlPVwiYnV0dG9uXCIgY2xhc3M9XCJidG4gYnRuLXByaW1hcnlcIiBkYXRhLXJvbGU9XCJzdGFydFwiPlN0YXJ0IEVMTzwvYnV0dG9uPlxuICAgICAgICA8L2Rpdj5cbiAgICAgIDwvZGl2PmA7XG5cbiAgYXJlYS5xdWVyeVNlbGVjdG9yKCdbZGF0YS1yb2xlPVwiY2FuY2VsXCJdJyk/LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiBvcHRpb25zLm9uQ2FuY2VsPy4oKSk7XG5cbiAgY29uc3Qgc2xvdCA9IGFyZWEucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oJ1tkYXRhLXJvbGU9XCJyYXRpbmdzLXdhcm5pbmdcIl0nKSBhcyBIVE1MRWxlbWVudDtcbiAgY29uc3QgcHJldmlldyA9IGFyZWEucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oJ1tkYXRhLXJvbGU9XCJwcmV2aWV3XCJdJykgYXMgSFRNTEVsZW1lbnQ7XG4gIGNvbnN0IHN0YXJ0QnRuID0gYXJlYS5xdWVyeVNlbGVjdG9yPEhUTUxCdXR0b25FbGVtZW50PignW2RhdGEtcm9sZT1cInN0YXJ0XCJdJykgYXMgSFRNTEJ1dHRvbkVsZW1lbnQ7XG5cbiAgLy8gRXZlcnkgYW5zd2VyJ3MgbWVzc2FnZSBzaXRzIGluIHRoZSBzbG90IGF0IG9uY2UsIHN0YWNrZWQgaW4gb25lIGdyaWQgY2VsbCwgc28gdGhlIHNsb3QgaXNcbiAgLy8gYWx3YXlzIGFzIHRhbGwgYXMgdGhlIGxvbmdlc3QgYW5kIHN3aXRjaGluZyBhbnN3ZXJzIG5ldmVyIG1vdmVzIHRoZSBsYXlvdXQgYmVsb3cgaXQuXG4gIC8vIEFuc3dlcnMgd2l0aCB0aGUgc2FtZSBtZXNzYWdlIHNoYXJlIG9uZSBlbGVtZW50LCBzbyBzd2l0Y2hpbmcgYmV0d2VlbiB0aGVtIGRvZXNuJ3QgZmFkZS5cbiAgY29uc3QgY2hhbmdlQ291bnRzID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgY29uc3QgbWVzc2FnZUZvciA9IG5ldyBNYXA8c3RyaW5nLCBFbGVtZW50PigpO1xuICBjb25zdCBtZXNzYWdlQnlIdG1sID0gbmV3IE1hcDxzdHJpbmcsIEVsZW1lbnQ+KCk7XG4gIGZvciAoY29uc3Qgc3RhcnQgb2YgW1wicmF0aW5nc1wiLCBcImZyZXNoXCJdIGFzIGNvbnN0KSB7XG4gICAgZm9yIChjb25zdCBtb2RlIG9mIFtcIm9mZlwiLCBcImxpbmVhclwiLCBcInBlcmNlbnRpbGVcIl0gYXMgY29uc3QpIHtcbiAgICAgIGNvbnN0IGNoYW5nZXMgPSBzZXR1cFJhdGluZ0NoYW5nZXMoc2NlbmVzLCBzdGFydCwgbW9kZSkuc2l6ZTtcbiAgICAgIGNvbnN0IGh0bWwgPSByYXRpbmdzTWVzc2FnZShzdGFydCwgbW9kZSwgY2hhbmdlcyk7XG4gICAgICBsZXQgbWVzc2FnZSA9IG1lc3NhZ2VCeUh0bWwuZ2V0KGh0bWwpO1xuICAgICAgaWYgKCFtZXNzYWdlKSB7XG4gICAgICAgIHNsb3QuaW5zZXJ0QWRqYWNlbnRIVE1MKFwiYmVmb3JlZW5kXCIsIGh0bWwpO1xuICAgICAgICBtZXNzYWdlID0gc2xvdC5sYXN0RWxlbWVudENoaWxkIGFzIEVsZW1lbnQ7XG4gICAgICAgIG1lc3NhZ2VCeUh0bWwuc2V0KGh0bWwsIG1lc3NhZ2UpO1xuICAgICAgfVxuICAgICAgY2hhbmdlQ291bnRzLnNldChgJHtzdGFydH06JHttb2RlfWAsIGNoYW5nZXMpO1xuICAgICAgbWVzc2FnZUZvci5zZXQoYCR7c3RhcnR9OiR7bW9kZX1gLCBtZXNzYWdlKTtcbiAgICB9XG4gIH1cblxuICBjb25zdCB1cGRhdGUgPSAoKTogdm9pZCA9PiB7XG4gICAgc2hvd1JhdGluZ1ByZXZpZXcocHJldmlldywgY2hvaWNlLnN0YXJ0LCBjaG9pY2Uuc3Rhc2hSYXRpbmdzKTtcbiAgICBjb25zdCBrZXkgPSBgJHtjaG9pY2Uuc3RhcnR9OiR7Y2hvaWNlLnN0YXNoUmF0aW5nc31gO1xuICAgIGNvbnN0IHNob3duID0gbWVzc2FnZUZvci5nZXQoa2V5KTtcbiAgICBmb3IgKGNvbnN0IG1lc3NhZ2Ugb2Ygc2xvdC5jaGlsZHJlbikgbWVzc2FnZS5jbGFzc0xpc3QudG9nZ2xlKFwic2Itc2hvd25cIiwgbWVzc2FnZSA9PT0gc2hvd24pO1xuICAgIGNvbnN0IGNoYW5nZXMgPSBjaGFuZ2VDb3VudHMuZ2V0KGtleSkgPz8gMDtcbiAgICBzdGFydEJ0bi50ZXh0Q29udGVudCA9IGNoYW5nZXMgPiAwID8gYFN0YXJ0IEVMTyBhbmQgY2hhbmdlICR7cGx1cmFsKGNoYW5nZXMsIFwicmF0aW5nXCIpfWAgOiBcIlN0YXJ0IEVMT1wiO1xuICB9O1xuXG4gIGFyZWEucXVlcnlTZWxlY3RvckFsbDxIVE1MSW5wdXRFbGVtZW50PignaW5wdXRbdHlwZT1cInJhZGlvXCJdJykuZm9yRWFjaCgoaW5wdXQpID0+IHtcbiAgICBpbnB1dC5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsICgpID0+IHtcbiAgICAgIGlmIChpbnB1dC5uYW1lID09PSBcInN0YXJ0XCIpIGNob2ljZS5zdGFydCA9IGlucHV0LnZhbHVlIGFzIEVsb1N0YXJ0O1xuICAgICAgZWxzZSBjaG9pY2Uuc3Rhc2hSYXRpbmdzID0gaW5wdXQudmFsdWUgYXMgU3Rhc2hSYXRpbmdzTW9kZTtcbiAgICAgIHVwZGF0ZSgpO1xuICAgIH0pO1xuICB9KTtcbiAgc3RhcnRCdG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHZvaWQgcnVuU2V0dXAoYXJlYSwgc2NlbmVzLCBjaG9pY2UsIG9uRG9uZSkpO1xuICB1cGRhdGUoKTtcbn1cblxuZnVuY3Rpb24gcHJvZ3Jlc3NIdG1sKHBoYXNlOiBTZXR1cFBoYXNlLCBkb25lOiBudW1iZXIsIHRvdGFsOiBudW1iZXIpOiBzdHJpbmcge1xuICBjb25zdCBwZXJjZW50ID0gdG90YWwgPiAwID8gTWF0aC5yb3VuZCgoZG9uZSAvIHRvdGFsKSAqIDEwMCkgOiAxMDA7XG4gIGNvbnN0IGxhYmVsID1cbiAgICBwaGFzZSA9PT0gXCJlbG9cIlxuICAgICAgPyBgU2F2aW5nIHN0YXJ0aW5nIEVMTzogJHtkb25lfSBvZiAke3BsdXJhbCh0b3RhbCwgXCJzY2VuZVwiKX1gXG4gICAgICA6IGBVcGRhdGluZyBTdGFzaCByYXRpbmdzOiAke3BsdXJhbCh0b3RhbCwgXCJzY2VuZVwiKX1gO1xuICByZXR1cm4gYFxuICAgICAgPGRpdiBjbGFzcz1cInNiLXNldHVwIHNiLXNldHVwLXByb2dyZXNzXCI+XG4gICAgICAgIDxoMiBjbGFzcz1cInNiLXNldHVwLXRpdGxlXCI+U2V0dGluZyB1cCBFTE8uLi48L2gyPlxuICAgICAgICA8ZGl2IGNsYXNzPVwicHJvZ3Jlc3NcIj48ZGl2IGNsYXNzPVwicHJvZ3Jlc3MtYmFyXCIgcm9sZT1cInByb2dyZXNzYmFyXCIgc3R5bGU9XCJ3aWR0aDogJHtwZXJjZW50fSVcIiBhcmlhLXZhbHVlbm93PVwiJHtwZXJjZW50fVwiIGFyaWEtdmFsdWVtaW49XCIwXCIgYXJpYS12YWx1ZW1heD1cIjEwMFwiPjwvZGl2PjwvZGl2PlxuICAgICAgICA8cCBjbGFzcz1cInNiLXNldHVwLXByb2dyZXNzLWxhYmVsXCI+JHtsYWJlbH08L3A+XG4gICAgICAgIDxwIGNsYXNzPVwic2Itc2V0dXAtbm90ZVwiPllvdSBjYW4gY2xvc2UgU3Rhc2ggQmF0dGxlOyBzZXR1cCBrZWVwcyBnb2luZyB3aGlsZSB0aGlzIFN0YXNoIHRhYiBzdGF5cyBvcGVuLiBJZiB0aGUgdGFiIGNsb3NlcyBmaXJzdCwgU3Rhc2ggQmF0dGxlIGFza3MgYWdhaW4gbmV4dCB0aW1lLCBhbmQgcnVubmluZyBpdCBhZ2FpbiBpcyBzYWZlLjwvcD5cbiAgICAgIDwvZGl2PmA7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJ1blNldHVwKGFyZWE6IEhUTUxFbGVtZW50LCBzY2VuZXM6IFNjZW5lW10sIGNob2ljZTogQ2hvaWNlLCBvbkRvbmU6ICgpID0+IHZvaWQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgcnVubmluZyA9IHRydWU7XG4gIGFyZWEuaW5uZXJIVE1MID0gcHJvZ3Jlc3NIdG1sKFwiZWxvXCIsIDAsIDApO1xuICAvLyBBIHJlc2V0IGNsZWFycyB0aGUgXCJzZXR1cCBmaW5pc2hlZFwiIGZsYWcgZmlyc3QsIHNvIGlmIGl0J3MgaW50ZXJydXB0ZWQgU3Rhc2ggQmF0dGxlIGFza3MgYWdhaW5cbiAgaWYgKHN0YXRlLnNldHRpbmdzLmVsb1NldHVwQXQgJiYgIShhd2FpdCB1cGRhdGVTZXR0aW5nc05vdyh7IGVsb1NldHVwQXQ6IG51bGwsIGVsb1NldHVwTW9kZTogbnVsbCB9KSkpIHtcbiAgICBjb25zb2xlLndhcm4oXCJbU3Rhc2ggQmF0dGxlXSBDb3VsZG4ndCBjbGVhciB0aGUgc2V0dXAgZmxhZyBiZWZvcmUgcmVzZXR0aW5nIEVMTzsgY29udGludWluZ1wiKTtcbiAgfVxuICBsZXQgc3VtbWFyeTogU2V0dXBTdW1tYXJ5O1xuICB0cnkge1xuICAgIHN1bW1hcnkgPSBhd2FpdCBydW5FbG9TZXR1cChzY2VuZXMsIGNob2ljZS5zdGFydCwgY2hvaWNlLnN0YXNoUmF0aW5ncywgKHBoYXNlLCBkb25lLCB0b3RhbCkgPT4ge1xuICAgICAgYXJlYS5pbm5lckhUTUwgPSBwcm9ncmVzc0h0bWwocGhhc2UsIGRvbmUsIHRvdGFsKTtcbiAgICB9KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHJ1bm5pbmcgPSBmYWxzZTtcbiAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0gRUxPIHNldHVwIGZhaWxlZDpcIiwgZSk7XG4gICAgc2hvd0Vycm9yKFxuICAgICAgYXJlYSxcbiAgICAgIGBTZXR1cCBzdG9wcGVkIHBhcnR3YXk6ICR7ZXNjYXBlSHRtbChlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBTdHJpbmcoZSkpfS4gUnVubmluZyBpdCBhZ2FpbiBpcyBzYWZlOyBpdCBvdmVyd3JpdGVzIHdoYXQgd2FzIHdyaXR0ZW4uYCxcbiAgICAgICgpID0+IHZvaWQgbG9hZENob2ljZXMoYXJlYSwgb25Eb25lKSxcbiAgICApO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIENhY2hlZCBzY2VuZXMgYW5kIGFueSBzYXZlZCBwYWlyIHByZWRhdGUgdGhlIG5ldyBFTE8gKGFuZCBwb3NzaWJseSB0aGUgbmV3IHJhdGluZ3MpXG4gIGF3YWl0IGNsZWFyU2NlbmVDYWNoZSgpO1xuICByZXNldFNodWZmbGUoKTtcbiAgcmVzZXRSdW5TdGF0ZSgpO1xuICBzdGF0ZS5jdXJyZW50UGFpciA9IHsgbGVmdDogbnVsbCwgcmlnaHQ6IG51bGwgfTtcbiAgc3RhdGUuY3VycmVudFJhbmtzID0geyBsZWZ0OiBudWxsLCByaWdodDogbnVsbCB9O1xuICBzYXZlU3RhdGUoKTtcblxuICBhd2FpdCBmaW5pc2hTZXR1cChhcmVhLCBzdW1tYXJ5LCBjaG9pY2UsIG9uRG9uZSk7XG59XG5cbi8qKiBTYXZlIHRoZSBjb21wbGV0aW9uIGZsYWdzIChyZXRyeWluZyBvbiByZXF1ZXN0KSwgdGhlbiBzaG93IHRoZSBzdW1tYXJ5LiAqL1xuYXN5bmMgZnVuY3Rpb24gZmluaXNoU2V0dXAoYXJlYTogSFRNTEVsZW1lbnQsIHN1bW1hcnk6IFNldHVwU3VtbWFyeSwgY2hvaWNlOiBDaG9pY2UsIG9uRG9uZTogKCkgPT4gdm9pZCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBzYXZlZCA9IGF3YWl0IHVwZGF0ZVNldHRpbmdzTm93KHtcbiAgICBlbG9TZXR1cEF0OiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgZWxvU2V0dXBNb2RlOiBjaG9pY2Uuc3RhcnQsXG4gICAgc3Rhc2hSYXRpbmdzOiBjaG9pY2Uuc3Rhc2hSYXRpbmdzLFxuICB9KTtcbiAgaWYgKCFzYXZlZCkge1xuICAgIC8vIFdpdGhvdXQgdGhlIGZsYWcsIHNldHVwIHdvdWxkIHNob3cgYWdhaW4gb24gdGhlIG5leHQgb3Blbjoga2VlcCBpdCBwZW5kaW5nIGhlcmUgdG9vXG4gICAgc3RhdGUuc2V0dGluZ3MgPSB7IC4uLnN0YXRlLnNldHRpbmdzLCBlbG9TZXR1cEF0OiBudWxsIH07XG4gICAgc2hvd0Vycm9yKFxuICAgICAgYXJlYSxcbiAgICAgIFwiWW91ciBFTE8gaXMgc2F2ZWQsIGJ1dCBTdGFzaCBCYXR0bGUgY291bGRuJ3QgcmVjb3JkIGluIFN0YXNoIHRoYXQgc2V0dXAgZmluaXNoZWQuXCIsXG4gICAgICAoKSA9PiB2b2lkIGZpbmlzaFNldHVwKGFyZWEsIHN1bW1hcnksIGNob2ljZSwgb25Eb25lKSxcbiAgICApO1xuICAgIHJldHVybjtcbiAgfVxuICBydW5uaW5nID0gZmFsc2U7XG5cbiAgY29uc3QgZWxvTGluZSA9XG4gICAgY2hvaWNlLnN0YXJ0ID09PSBcInJhdGluZ3NcIlxuICAgICAgPyBgJHtwbHVyYWwoc3VtbWFyeS5lbG9Xcml0dGVuLCBcInNjZW5lXCIpfSBnb3QgYSBzdGFydGluZyBFTE8gZnJvbSAke3N1bW1hcnkuZWxvV3JpdHRlbiA9PT0gMSA/IFwiaXRzXCIgOiBcInRoZWlyXCJ9IHJhdGluZy4gVW5yYXRlZCBzY2VuZXMgc3RheSB1bnJhdGVkIHVudGlsIHRoZXkgYmF0dGxlLmBcbiAgICAgIDogYCR7cGx1cmFsKHN1bW1hcnkuZWxvV3JpdHRlbiwgXCJzY2VuZVwiKX0gc3RhcnQgYXQgMTUwMCBFTE8uYDtcbiAgY29uc3QgY2xlYXJlZExpbmUgPVxuICAgIHN1bW1hcnkuZWxvQ2xlYXJlZCA+IDAgPyBgPGxpPiR7cGx1cmFsKHN1bW1hcnkuZWxvQ2xlYXJlZCwgXCJzY2VuZVwiKX0gd2l0aG91dCBhIFN0YXNoIHJhdGluZyBoYWQgYW4gb2xkIEVMTyByZW1vdmVkLjwvbGk+YCA6IFwiXCI7XG4gIGNvbnN0IG9wdGlvbkxhYmVsID0gY2hvaWNlLnN0YXNoUmF0aW5ncyA9PT0gXCJwZXJjZW50aWxlXCIgPyBcIlBlcmNlbnRpbGVcIiA6IFwiU3RyYWlnaHQtbGluZVwiO1xuICBjb25zdCByYXRpbmdzTGluZSA9XG4gICAgY2hvaWNlLnN0YXNoUmF0aW5ncyA9PT0gXCJvZmZcIlxuICAgICAgPyBcIlN0YXNoIHJhdGluZ3Mgd2VyZW4ndCBjaGFuZ2VkLCBhbmQgYmF0dGxlcyB3b24ndCBjaGFuZ2UgdGhlbS5cIlxuICAgICAgOiBzdW1tYXJ5LnJhdGluZ3NXcml0dGVuID09PSAwXG4gICAgICAgID8gYFN0YXNoIHJhdGluZ3MgYWxyZWFkeSBtYXRjaGVkICgke29wdGlvbkxhYmVsfSksIHNvIG5vbmUgY2hhbmdlZC4gQmF0dGxlcyBrZWVwIHRoZW0gaW4gc3RlcCBmcm9tIG5vdyBvbi5gXG4gICAgICAgIDogYCR7cGx1cmFsKHN1bW1hcnkucmF0aW5nc1dyaXR0ZW4sIFwiU3Rhc2ggcmF0aW5nXCIpfSB1cGRhdGVkICgke29wdGlvbkxhYmVsfSkuIEJhdHRsZXMga2VlcCB0aGVtIGluIHN0ZXAgZnJvbSBub3cgb24uYDtcblxuICBhcmVhLmlubmVySFRNTCA9IGBcbiAgICAgIDxkaXYgY2xhc3M9XCJzYi1zZXR1cCBzYi1zZXR1cC1kb25lXCI+XG4gICAgICAgIDxoMiBjbGFzcz1cInNiLXNldHVwLXRpdGxlXCI+4pyFIEVMTyBpcyByZWFkeTwvaDI+XG4gICAgICAgIDx1bCBjbGFzcz1cInNiLXNldHVwLXN1bW1hcnlcIj5cbiAgICAgICAgICA8bGk+JHtlbG9MaW5lfTwvbGk+XG4gICAgICAgICAgJHtjbGVhcmVkTGluZX1cbiAgICAgICAgICA8bGk+JHtyYXRpbmdzTGluZX08L2xpPlxuICAgICAgICA8L3VsPlxuICAgICAgICA8ZGl2IGNsYXNzPVwic2Itc2V0dXAtYWN0aW9uc1wiPlxuICAgICAgICAgIDxidXR0b24gdHlwZT1cImJ1dHRvblwiIGNsYXNzPVwiYnRuIGJ0bi1wcmltYXJ5XCIgZGF0YS1yb2xlPVwiZG9uZVwiPlN0YXJ0IGJhdHRsaW5nPC9idXR0b24+XG4gICAgICAgIDwvZGl2PlxuICAgICAgPC9kaXY+YDtcbiAgYXJlYS5xdWVyeVNlbGVjdG9yKCdbZGF0YS1yb2xlPVwiZG9uZVwiXScpPy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4ge1xuICAgIGhpZGVTZXR1cFNjcmVlbihhcmVhLm93bmVyRG9jdW1lbnQpO1xuICAgIG9uRG9uZSgpO1xuICB9KTtcbn1cblxuZnVuY3Rpb24gZXNjYXBlSHRtbCh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gdGV4dC5yZXBsYWNlKC9bJjw+XCJdL2csIChjKSA9PiAoeyBcIiZcIjogXCImYW1wO1wiLCBcIjxcIjogXCImbHQ7XCIsIFwiPlwiOiBcIiZndDtcIiwgJ1wiJzogXCImcXVvdDtcIiB9KVtjXSBhcyBzdHJpbmcpO1xufVxuXG5mdW5jdGlvbiBzaG93RXJyb3IoYXJlYTogSFRNTEVsZW1lbnQsIG1lc3NhZ2U6IHN0cmluZywgcmV0cnk6ICgpID0+IHZvaWQpOiB2b2lkIHtcbiAgYXJlYS5pbm5lckhUTUwgPSBgXG4gICAgICA8ZGl2IGNsYXNzPVwic2Itc2V0dXAgc2ItZXJyb3Itc2NyZWVuXCI+XG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi1lcnJvci1pY29uXCI+4pqg77iPPC9kaXY+XG4gICAgICAgIDxwIGNsYXNzPVwic2ItZXJyb3ItbWVzc2FnZVwiPiR7bWVzc2FnZX08L3A+XG4gICAgICAgIDxidXR0b24gdHlwZT1cImJ1dHRvblwiIGNsYXNzPVwiYnRuIGJ0bi1wcmltYXJ5XCIgZGF0YS1yb2xlPVwicmV0cnlcIj5UcnkgYWdhaW48L2J1dHRvbj5cbiAgICAgIDwvZGl2PmA7XG4gIGFyZWEucXVlcnlTZWxlY3RvcignW2RhdGEtcm9sZT1cInJldHJ5XCJdJyk/LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCByZXRyeSk7XG59XG4iLCAiLy8gVGhlIGJhdHRsZSBtb2RhbDogb3BlbnMvY2xvc2VzLCB3aXJlcyBjb250cm9scyBhbmQga2V5Ym9hcmQgc2hvcnRjdXRzLlxuXG5pbXBvcnQgeyBjbGVhclNjZW5lQ2FjaGUgfSBmcm9tIFwiLi4vY2FjaGVcIjtcbmltcG9ydCB7IGZldGNoU2V0dXBTY2VuZXMgfSBmcm9tIFwiLi4vZWxvU2V0dXBcIjtcbmltcG9ydCB7IGdldFNjZW5lSWRGcm9tVXJsLCBob2xkU3Rhc2hMaXN0UmVmcmVzaCwgc2NlbmVDdXN0b21GaWVsZHNTdXBwb3J0ZWQgfSBmcm9tIFwiLi4vZ3JhcGhxbFwiO1xuaW1wb3J0IHsgYXBwbHlTdGFzaFJhdGluZ3MsIHF1ZXVlUmF0aW5nV3JpdGUsIFNDRU5FX01JU1NJTkdfRVZFTlQsIHNjaGVkdWxlU3Rhc2hSYXRpbmdTeW5jLCB3cml0ZVN0YXNoUmF0aW5ncyB9IGZyb20gXCIuLi9yYXRpbmdcIjtcbmltcG9ydCB7IHN0YXNoUmF0aW5nQ2hhbmdlcyB9IGZyb20gXCIuLi9zY29yZVwiO1xuaW1wb3J0IHsgbG9hZFNldHRpbmdzIH0gZnJvbSBcIi4uL3NldHRpbmdzXCI7XG5pbXBvcnQgeyBpc0Vsb1NldHVwUGVuZGluZywgcmVzZXRSdW5TdGF0ZSwgcmVzZXRTaHVmZmxlLCBzdGF0ZSB9IGZyb20gXCIuLi9zdGF0ZVwiO1xuaW1wb3J0IHsgbG9hZFN0YXRlLCBzYXZlU3RhdGUgfSBmcm9tIFwiLi4vc3RvcmFnZVwiO1xuaW1wb3J0IHR5cGUgeyBNb2RlLCBTZXR0aW5ncywgU3Rhc2hSYXRpbmdzTW9kZSB9IGZyb20gXCIuLi90eXBlc1wiO1xuaW1wb3J0IHsgY2FuY2VsQ29uZmlybURpYWxvZywgY29uZmlybURpYWxvZywgaXNDb25maXJtRGlhbG9nT3BlbiB9IGZyb20gXCIuL2NvbmZpcm1EaWFsb2dcIjtcbmltcG9ydCB7IGNhbmNlbERlbGV0ZURpYWxvZywgaXNEZWxldGVEaWFsb2dPcGVuIH0gZnJvbSBcIi4vZGVsZXRlRGlhbG9nXCI7XG5pbXBvcnQge1xuICBhcHBseVByZXZpZXdTZXR0aW5ncyxcbiAgY3JlYXRlTWFpblVJLFxuICBoYW5kbGVTY2VuZUdvbmUsXG4gIGxvYWROZXdQYWlyLFxuICByZW5kZXJQYWlyLFxuICByZXN0b3JlQ3VycmVudFBhaXIsXG4gIHNraXBQYWlyLFxuICB1cGRhdGVDbGltYlBvb2xXYXJuaW5nLFxuICB1cGRhdGVNb2RlSW5mbyxcbiAgdXBkYXRlUmF0aW5nc05vdGUsXG4gIHZlcmlmeUN1cnJlbnRQYWlyLFxufSBmcm9tIFwiLi9tYWluVUlcIjtcbmltcG9ydCB7IGJpbmRTZXR0aW5nc0NvbnRyb2xzLCBnZXRBY3RpdmVUYWIsIHNob3dUYWIsIHN5bmNTZXR0aW5nc0NvbnRyb2xzIH0gZnJvbSBcIi4vc2V0dGluZ3NQYW5lbFwiO1xuaW1wb3J0IHsgcmVmcmVzaFNjZW5lRWxvIH0gZnJvbSBcIi4vc2NlbmVFbG9cIjtcbmltcG9ydCB7IGhpZGVTZXR1cFNjcmVlbiwgaXNTZXR1cFJ1bm5pbmcsIHNob3dTZXR1cFNjcmVlbiB9IGZyb20gXCIuL3NldHVwU2NyZWVuXCI7XG5pbXBvcnQgeyBzdGFzaFJhdGluZ3NPcHRpb24gfSBmcm9tIFwiLi9zdGFzaFJhdGluZ3NUZXh0XCI7XG5cbi8vIFRyYWNrIGtleWJvYXJkIGhhbmRsZXIgc28gd2UgY2FuIHJlbW92ZSBpdCBvbiBjbG9zZVxubGV0IG1vZGFsS2V5SGFuZGxlcjogKChlOiBLZXlib2FyZEV2ZW50KSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xubGV0IHNjZW5lTWlzc2luZ0xpc3RlbmVyQWRkZWQgPSBmYWxzZTtcblxuLyoqIE9uIDxib2R5PiB3aGlsZSBCYXR0bGUgaXMgb3BlbjsgQ1NTIHVzZXMgaXQgdG8gbGlmdCBTdGFzaCdzIG93biBtb2RhbHMgYWJvdmUgb3Vycy4gKi9cbmNvbnN0IEJBVFRMRV9PUEVOX0NMQVNTID0gXCJzYi1iYXR0bGUtb3BlblwiO1xuXG4vKiogUmUtcmVuZGVyIHRoZSBwYWlyIG9uIHNjcmVlbiBzbyBjYXJkIG1hcmt1cCBwaWNrcyB1cCBhIGNoYW5nZWQgc2V0dGluZy4gKi9cbmZ1bmN0aW9uIHJlcmVuZGVyQ3VycmVudFBhaXIoKTogdm9pZCB7XG4gIGNvbnN0IHsgbGVmdCwgcmlnaHQgfSA9IHN0YXRlLmN1cnJlbnRQYWlyO1xuICBpZiAoIWxlZnQgfHwgIXJpZ2h0IHx8IHN0YXRlLmRpc2FibGVDaG9pY2UgfHwgIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoXCIjc2ItY29tcGFyaXNvbi1hcmVhIC5zYi12cy1jb250YWluZXJcIikpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgcmVuZGVyUGFpcihbbGVmdCwgcmlnaHRdLCBbc3RhdGUuY3VycmVudFJhbmtzLmxlZnQsIHN0YXRlLmN1cnJlbnRSYW5rcy5yaWdodF0pO1xufVxuXG4vKipcbiAqIEJlZm9yZSB0aGUgXCJTdGFzaCByYXRpbmdzXCIgZHJvcGRvd24gY2hhbmdlczogc3dpdGNoaW5nIHRvIFBlcmNlbnRpbGUgb3IgU3RyYWlnaHQtbGluZSB3YXJucyBob3dcbiAqIG1hbnkgU3Rhc2ggcmF0aW5ncyBjaGFuZ2UgYW5kIHN5bmNzIHRoZW0gYWxsIG9uIGNvbmZpcm0gKGZhbHNlIHB1dHMgdGhlIGRyb3Bkb3duIGJhY2spLlxuICogU3dpdGNoaW5nIHRvIERvbid0IHVwZGF0ZSwgb3IgYSBzd2l0Y2ggdGhhdCBjaGFuZ2VzIG5vdGhpbmcsIG5lZWRzIG5vIHdhcm5pbmcuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGNvbmZpcm1TZXR0aW5nQ2hhbmdlKGtleToga2V5b2YgU2V0dGluZ3MsIHZhbHVlOiBzdHJpbmcpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgaWYgKGtleSAhPT0gXCJzdGFzaFJhdGluZ3NcIikgcmV0dXJuIHRydWU7XG4gIGNvbnN0IG5leHQgPSB2YWx1ZSBhcyBTdGFzaFJhdGluZ3NNb2RlO1xuICBpZiAobmV4dCA9PT0gXCJvZmZcIiB8fCBuZXh0ID09PSBzdGF0ZS5zZXR0aW5ncy5zdGFzaFJhdGluZ3MpIHJldHVybiB0cnVlO1xuXG4gIGxldCBjaGFuZ2VzOiBNYXA8c3RyaW5nLCBudW1iZXI+O1xuICB0cnkge1xuICAgIGNoYW5nZXMgPSBzdGFzaFJhdGluZ0NoYW5nZXMoYXdhaXQgZmV0Y2hTZXR1cFNjZW5lcygpLCBuZXh0KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnNvbGUuZXJyb3IoXCJbU3Rhc2ggQmF0dGxlXSBDb3VsZG4ndCBsb2FkIHNjZW5lcyB0byBzd2l0Y2ggU3Rhc2ggcmF0aW5nczpcIiwgZSk7XG4gICAgYXdhaXQgY29uZmlybURpYWxvZyh7XG4gICAgICB0aXRsZTogXCJDb3VsZG4ndCBsb2FkIHlvdXIgc2NlbmVzXCIsXG4gICAgICBib2R5OiBcIjxwPlN0YXNoIEJhdHRsZSBuZWVkcyB5b3VyIHdob2xlIGxpYnJhcnkgdG8gd29yayBvdXQgdGhlIG5ldyBTdGFzaCByYXRpbmdzLiBOb3RoaW5nIHdhcyBjaGFuZ2VkOyB0cnkgYWdhaW4uPC9wPlwiLFxuICAgICAgY29uZmlybUxhYmVsOiBcIk9LXCIsXG4gICAgfSk7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIGlmIChjaGFuZ2VzLnNpemUgPT09IDApIHJldHVybiB0cnVlO1xuXG4gIGNvbnN0IHsgbGFiZWwsIGRlc2MgfSA9IHN0YXNoUmF0aW5nc09wdGlvbihuZXh0KTtcbiAgY29uc3QgY291bnQgPSBgJHtjaGFuZ2VzLnNpemV9IFN0YXNoIHJhdGluZyR7Y2hhbmdlcy5zaXplID09PSAxID8gXCJcIiA6IFwic1wifWA7XG4gIHJldHVybiBjb25maXJtRGlhbG9nKHtcbiAgICB0aXRsZTogYFN3aXRjaCBTdGFzaCByYXRpbmdzIHVwZGF0ZSBtb2RlIHRvICR7bGFiZWx9P2AsXG4gICAgYm9keTogYFxuICAgICAgICA8cD4ke2Rlc2N9PC9wPlxuICAgICAgICA8cD48c3Ryb25nPiR7Y291bnR9IGNoYW5nZSBub3cuPC9zdHJvbmc+IEFmdGVyIHRoYXQsIGJhdHRsZXMga2VlcCBTdGFzaCByYXRpbmdzIGluIHN0ZXAgd2l0aFxuICAgICAgICBFTE8sIGFuZCBhIHN0YXIgcmF0aW5nIHlvdSBjaGFuZ2UgYnkgaGFuZCBpbiBTdGFzaCBpcyBvdmVyd3JpdHRlbiB0aGUgbmV4dCB0aW1lIFN0YXNoIEJhdHRsZVxuICAgICAgICB3cml0ZXMgdGhhdCBzY2VuZS48L3A+XG4gICAgICAgIDxwPlRha2UgYSBTdGFzaCBiYWNrdXAgZmlyc3QgKFNldHRpbmdzIOKGkiBUYXNrcyDihpIgQmFja3VwKS48L3A+YCxcbiAgICBjb25maXJtTGFiZWw6IGBVcGRhdGUgJHtjb3VudH1gLFxuICAgIHdvcmtpbmdMYWJlbDogXCJVcGRhdGluZy4uLlwiLFxuICAgIGFjdGlvbjogKCkgPT5cbiAgICAgIHF1ZXVlUmF0aW5nV3JpdGUoYXN5bmMgKCkgPT4ge1xuICAgICAgICBhd2FpdCB3cml0ZVN0YXNoUmF0aW5ncyhjaGFuZ2VzKTtcbiAgICAgICAgYXBwbHlTdGFzaFJhdGluZ3MoY2hhbmdlcyk7XG4gICAgICB9KSxcbiAgfSk7XG59XG5cbi8qKiBTZXR0aW5ncyDihpIgUmVzZXQgRUxPOiBjb25maXJtLCB0aGVuIHNob3cgdGhlIHNldHVwIGNob2ljZXMgYWdhaW4gKENhbmNlbCBnb2VzIGJhY2spLiAqL1xuYXN5bmMgZnVuY3Rpb24gc3RhcnRSZXNldEVsbyhtb2RhbDogSFRNTEVsZW1lbnQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgcmF0aW5nc09uID0gc3RhdGUuc2V0dGluZ3Muc3Rhc2hSYXRpbmdzICE9PSBcIm9mZlwiO1xuICBjb25zdCBvayA9IGF3YWl0IGNvbmZpcm1EaWFsb2coe1xuICAgIHRpdGxlOiBcIlJlc2V0IEVMTz9cIixcbiAgICBib2R5OiBgXG4gICAgICAgIDxwPkV2ZXJ5IHNjZW5lJ3MgRUxPIGFuZCBiYXR0bGUgY291bnQgd2lsbCBiZSBvdmVyd3JpdHRlbi4gTmV4dCB5b3UgY2hvb3NlIGhvdyBFTE8gc3RhcnRzXG4gICAgICAgIGFnYWluOiBmcm9tIHlvdXIgU3Rhc2ggcmF0aW5ncywgb3IgMTUwMCBmb3IgZXZlcnlvbmUuJHtyYXRpbmdzT24gPyBcIiBTdGFzaCByYXRpbmdzIGFyZSB0aGVuIHVwZGF0ZWQgZnJvbSB0aGUgbmV3IEVMTy5cIiA6IFwiXCJ9PC9wPlxuICAgICAgICA8cD5Ob3RoaW5nIGNoYW5nZXMgdW50aWwgeW91IHByZXNzIFN0YXJ0IG9uIHRoZSBuZXh0IHNjcmVlbi48L3A+YCxcbiAgICBjb25maXJtTGFiZWw6IFwiQ29udGludWVcIixcbiAgfSk7XG4gIGlmICghb2spIHJldHVybjtcblxuICBzdGF0ZS5yZXNldHRpbmdFbG8gPSB0cnVlO1xuICBzaG93VGFiKG1vZGFsLCBcImJhdHRsZVwiKTtcbiAgbW9kYWwucXVlcnlTZWxlY3RvckFsbDxIVE1MVmlkZW9FbGVtZW50PihcIi5zYi1ob3Zlci1wcmV2aWV3XCIpLmZvckVhY2goKHYpID0+IHYucGF1c2UoKSk7XG4gIHNob3dTZXR1cFNjcmVlbihtb2RhbCwgKCkgPT4gYWZ0ZXJTZXR1cChtb2RhbCksIHtcbiAgICByZXNldDogdHJ1ZSxcbiAgICBvbkNhbmNlbDogKCkgPT4ge1xuICAgICAgc3RhdGUucmVzZXR0aW5nRWxvID0gZmFsc2U7XG4gICAgICBoaWRlU2V0dXBTY3JlZW4obW9kYWwpO1xuICAgICAgaWYgKHN0YXRlLmN1cnJlbnRQYWlyLmxlZnQgJiYgc3RhdGUuY3VycmVudFBhaXIucmlnaHQpIHZvaWQgcmVzdG9yZUN1cnJlbnRQYWlyKCk7XG4gICAgICBlbHNlIHZvaWQgbG9hZE5ld1BhaXIoKTtcbiAgICB9LFxuICB9KTtcbn1cblxuLyoqIFNldHVwIChmaXJzdCB0aW1lIG9yIFJlc2V0IEVMTykgZmluaXNoZWQ6IHNldHRpbmdzIGl0IHNhdmVkIHNob3csIHRoZW4gYmF0dGxlcyBzdGFydC4gKi9cbmZ1bmN0aW9uIGFmdGVyU2V0dXAobW9kYWw6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIHN0YXRlLnJlc2V0dGluZ0VsbyA9IGZhbHNlO1xuICBzeW5jU2V0dGluZ3NDb250cm9scyhtb2RhbCk7XG4gIHVwZGF0ZVJhdGluZ3NOb3RlKCk7XG4gIHZvaWQgbG9hZE5ld1BhaXIoZ2V0U2NlbmVJZEZyb21VcmwoKSk7XG59XG5cbmZ1bmN0aW9uIG9uU2V0dGluZ0NoYW5nZWQoa2V5OiBrZXlvZiBTZXR0aW5ncyk6IHZvaWQge1xuICBzd2l0Y2ggKGtleSkge1xuICAgIGNhc2UgXCJzdGFzaFJhdGluZ3NcIjpcbiAgICAgIHVwZGF0ZVJhdGluZ3NOb3RlKCk7XG4gICAgICAvLyBDYXRjaCBhbnl0aGluZyBhIHBlci1iYXR0bGUgc3luYyB1bmRlciB0aGUgb2xkIG1vZGUgY2hhbmdlZCBhZnRlciB0aGUgc3dpdGNoIHdhcyBjb3VudGVkXG4gICAgICBzY2hlZHVsZVN0YXNoUmF0aW5nU3luYygpO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcImZpbHRlck9wcG9uZW50c1wiOlxuICAgICAgLy8gc3dpdGNoaW5nIHRoZSB0b2dnbGUgY291bnRzIGFzIGNoYW5naW5nIGZpbHRlcnM6IHJlc2V0IGFueSBydW5cbiAgICAgIGlmIChzdGF0ZS5jdXJyZW50TW9kZSAhPT0gXCJzd2lzc1wiKSByZXNldFJ1blN0YXRlKCk7XG4gICAgICBzYXZlU3RhdGUoKTtcbiAgICAgIGxvYWROZXdQYWlyKCk7XG4gICAgICB1cGRhdGVDbGltYlBvb2xXYXJuaW5nKCk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwicGxhY2VtZW50RnJvbUJvdHRvbVwiOiB7XG4gICAgICAvLyBSZXN0YXJ0IHRoZSBzY2VuZSdzIHJ1biBmcm9tIHRoZSBuZXcgc3RhcnQgcG9pbnQgKG5vdGhpbmcgaXMgd3JpdHRlbiB1bnRpbCBpdCBsYW5kcylcbiAgICAgIGNvbnN0IHNjZW5lSWQgPSBzdGF0ZS5jdXJyZW50TW9kZSA9PT0gXCJwbGFjZW1lbnRcIiA/IHN0YXRlLnBsYWNlbWVudD8uc2NlbmUuaWQgOiB1bmRlZmluZWQ7XG4gICAgICBpZiAoc2NlbmVJZCkge1xuICAgICAgICByZXNldFJ1blN0YXRlKCk7XG4gICAgICAgIHNhdmVTdGF0ZSgpO1xuICAgICAgICB2b2lkIGxvYWROZXdQYWlyKHNjZW5lSWQpO1xuICAgICAgfVxuICAgICAgYnJlYWs7XG4gICAgfVxuICAgIGNhc2UgXCJwcmV2aWV3Vm9sdW1lXCI6XG4gICAgY2FzZSBcImF1dG9wbGF5UHJldmlld3NcIjpcbiAgICAgIGFwcGx5UHJldmlld1NldHRpbmdzKCk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwib3BlbkluTmV3VGFiXCI6XG4gICAgY2FzZSBcImNsZWFuTW9kZVwiOlxuICAgICAgcmVyZW5kZXJDdXJyZW50UGFpcigpO1xuICAgICAgYnJlYWs7XG4gIH1cbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG9wZW5Nb2RhbCgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn46vIE9wZW5pbmcgbW9kYWwuLi5cIik7XG5cbiAgY29uc3QgW3NldHRpbmdzT2ssIGN1c3RvbUZpZWxkc09rXSA9IGF3YWl0IFByb21pc2UuYWxsKFtsb2FkU2V0dGluZ3MoKSwgc2NlbmVDdXN0b21GaWVsZHNTdXBwb3J0ZWQoKV0pO1xuICBpZiAoIWN1c3RvbUZpZWxkc09rKSB7XG4gICAgc2hvd01lc3NhZ2VNb2RhbChcbiAgICAgIFwiU3Rhc2ggQmF0dGxlIG5lZWRzIGEgbmV3ZXIgdmVyc2lvbiBvZiBTdGFzaDogaXQgc3RvcmVzIGVhY2ggc2NlbmUncyBFTE8gaW4gc2NlbmUgY3VzdG9tIGZpZWxkcywgd2hpY2ggdGhpcyBTdGFzaCBkb2Vzbid0IGhhdmUuIFVwZGF0ZSBTdGFzaCB0byB1c2UgU3Rhc2ggQmF0dGxlLlwiLFxuICAgICk7XG4gICAgcmV0dXJuO1xuICB9XG4gIC8vIFdpdGhvdXQgc2V0dGluZ3MsIEJhdHRsZSBjYW4ndCB0ZWxsIHdoZXRoZXIgdGhlIG9uZS10aW1lIEVMTyBzZXR1cCBhbHJlYWR5IHJhbiAoYW5kIHJ1bm5pbmdcbiAgLy8gaXQgYWdhaW4gd291bGQgb3ZlcndyaXRlIGV2ZXJ5IHNjZW5lJ3MgRUxPKVxuICBpZiAoIXNldHRpbmdzT2sgJiYgaXNFbG9TZXR1cFBlbmRpbmcoKSkge1xuICAgIHNob3dNZXNzYWdlTW9kYWwoXCJTdGFzaCBCYXR0bGUgY291bGRuJ3QgbG9hZCBpdHMgc2V0dGluZ3MgZnJvbSBTdGFzaC4gQ2xvc2UgU3Rhc2ggQmF0dGxlIGFuZCB0cnkgYWdhaW4uXCIpO1xuICAgIHJldHVybjtcbiAgfVxuICBhZGRLZXlTd2FsbG93ZXJzKCk7XG4gIGhvbGRTdGFzaExpc3RSZWZyZXNoKHRydWUpO1xuXG4gIC8vIE9wdGlvbmFsbHkgcGF1c2Ugd2hhdGV2ZXIgU3Rhc2ggaXMgcGxheWluZyBzbyBpdCBkb2Vzbid0IG92ZXJsYXAgdGhlIGJhdHRsZSBwcmV2aWV3c1xuICBpZiAoc3RhdGUuc2V0dGluZ3MucGF1c2VNZWRpYU9uT3Blbikge1xuICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTE1lZGlhRWxlbWVudD4oXCJ2aWRlbywgYXVkaW9cIikuZm9yRWFjaCgodikgPT4gdi5wYXVzZSgpKTtcbiAgfVxuXG4gIGlmICghc2NlbmVNaXNzaW5nTGlzdGVuZXJBZGRlZCkge1xuICAgIHNjZW5lTWlzc2luZ0xpc3RlbmVyQWRkZWQgPSB0cnVlO1xuICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFNDRU5FX01JU1NJTkdfRVZFTlQsIChlKSA9PiB7XG4gICAgICB2b2lkIGhhbmRsZVNjZW5lR29uZSgoZSBhcyBDdXN0b21FdmVudDxzdHJpbmc+KS5kZXRhaWwpO1xuICAgIH0pO1xuICB9XG5cbiAgLy8gVHJ5IHRvIGxvYWQgc2F2ZWQgc3RhdGVcbiAgY29uc3QgaGFzU3RhdGUgPSBsb2FkU3RhdGUoKTtcbiAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIPCfk4sgTG9jYWxTdG9yYWdlIHN0YXRlOiAke2hhc1N0YXRlID8gXCJmb3VuZFwiIDogXCJub25lXCJ9YCk7XG5cbiAgLy8gQ2hlY2sgaWYgVVJMIGZpbHRlciBwYXJhbXMgaGF2ZSBjaGFuZ2VkIC0gaWYgc28sIHJlc2V0IHN0YXRlXG4gIGNvbnN0IGN1cnJlbnRGaWx0ZXJQYXJhbXMgPSB3aW5kb3cubG9jYXRpb24uc2VhcmNoO1xuICBjb25zdCBmaWx0ZXJzQ2hhbmdlZCA9IGhhc1N0YXRlICYmIHN0YXRlLnNhdmVkRmlsdGVyUGFyYW1zICE9PSBjdXJyZW50RmlsdGVyUGFyYW1zO1xuXG4gIGlmIChmaWx0ZXJzQ2hhbmdlZCkge1xuICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0gRmlsdGVyIHBhcmFtcyBjaGFuZ2VkLCByZXNldHRpbmcgcnVuIHN0YXRlIGFuZCBmaWx0ZXJlZCBjYWNoZVwiKTtcbiAgICBzdGF0ZS5jdXJyZW50UGFpciA9IHsgbGVmdDogbnVsbCwgcmlnaHQ6IG51bGwgfTtcbiAgICBzdGF0ZS5jdXJyZW50UmFua3MgPSB7IGxlZnQ6IG51bGwsIHJpZ2h0OiBudWxsIH07XG4gICAgcmVzZXRSdW5TdGF0ZSgpO1xuICAgIHN0YXRlLnNhdmVkRmlsdGVyUGFyYW1zID0gY3VycmVudEZpbHRlclBhcmFtcztcblxuICAgIC8vIENsZWFyIGZpbHRlcmVkIHNjZW5lcyBjYWNoZSAoYnV0IGtlZXAgYWxsIHNjZW5lcyBjYWNoZSlcbiAgICBzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJlZFNjZW5lcyA9IG51bGw7XG4gICAgc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyS2V5ID0gbnVsbDtcblxuICAgIC8vIFJlc2V0IHNodWZmbGUgZm9yIG5ldyBmaWx0ZXJcbiAgICByZXNldFNodWZmbGUoKTtcbiAgfVxuXG4gIC8vIERldGVjdCBpZiBvcGVuZWQgZnJvbSBhbiBpbmRpdmlkdWFsIHNjZW5lIHBhZ2UgKGUuZy4gL3NjZW5lcy8xMjMpXG4gIGNvbnN0IHNjZW5lUGFnZUlkID0gZ2V0U2NlbmVJZEZyb21VcmwoKTtcbiAgY29uc3Qgc2NlbmVBbHJlYWR5SW5QYWlyID1cbiAgICBzY2VuZVBhZ2VJZCAmJlxuICAgIHN0YXRlLmN1cnJlbnRQYWlyLmxlZnQgJiZcbiAgICBzdGF0ZS5jdXJyZW50UGFpci5yaWdodCAmJlxuICAgIChTdHJpbmcoc3RhdGUuY3VycmVudFBhaXIubGVmdC5pZCkgPT09IHNjZW5lUGFnZUlkIHx8XG4gICAgICBTdHJpbmcoc3RhdGUuY3VycmVudFBhaXIucmlnaHQuaWQpID09PSBzY2VuZVBhZ2VJZCk7XG4gIGNvbnN0IGZvcmNlU2NlbmVCYXR0bGUgPSBzY2VuZVBhZ2VJZCAmJiAhc2NlbmVBbHJlYWR5SW5QYWlyO1xuXG4gIGlmIChmb3JjZVNjZW5lQmF0dGxlKSB7XG4gICAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIPCfjq8gT3BlbmVkIGZyb20gc2NlbmUgcGFnZSAke3NjZW5lUGFnZUlkfSwgc3RhcnRpbmcgbmV3IGJhdHRsZSB3aXRoIHRoaXMgc2NlbmVgKTtcbiAgICByZXNldFJ1blN0YXRlKCk7XG4gICAgc3RhdGUuY3VycmVudFBhaXIgPSB7IGxlZnQ6IG51bGwsIHJpZ2h0OiBudWxsIH07XG4gICAgc3RhdGUuY3VycmVudFJhbmtzID0geyBsZWZ0OiBudWxsLCByaWdodDogbnVsbCB9O1xuICB9XG5cbiAgLy8gQ2hlY2sgZm9yIGV4aXN0aW5nIGhpZGRlbiBtb2RhbCAtIHJldXNlIGl0ICh1bmxlc3MgaXQncyBhIG1lc3NhZ2UgbW9kYWwsIHNlZSBzaG93TWVzc2FnZU1vZGFsKVxuICBjb25zdCBleGlzdGluZ01vZGFsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzYi1tb2RhbFwiKTtcbiAgaWYgKFxuICAgIGV4aXN0aW5nTW9kYWwgJiZcbiAgICBleGlzdGluZ01vZGFsLmNsYXNzTGlzdC5jb250YWlucyhcInNiLW1vZGFsLWhpZGRlblwiKSAmJlxuICAgIGV4aXN0aW5nTW9kYWwucXVlcnlTZWxlY3RvcihcIiNzdGFzaC1iYXR0bGUtY29udGFpbmVyXCIpXG4gICkge1xuICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g4pm777iPIFJldXNpbmcgZXhpc3RpbmcgbW9kYWxcIik7XG4gICAgZXhpc3RpbmdNb2RhbC5jbGFzc0xpc3QucmVtb3ZlKFwic2ItbW9kYWwtaGlkZGVuXCIsIFwic2ItbW9kYWwtY2xvc2luZ1wiKTtcbiAgICBkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5hZGQoQkFUVExFX09QRU5fQ0xBU1MpO1xuXG4gICAgLy8gQWx3YXlzIHJlb3BlbiBvbiB0aGUgQmF0dGxlIHRhYjsgc2V0dGluZ3MgbWF5IGhhdmUgY2hhbmdlZCBlbHNld2hlcmUgbWVhbndoaWxlXG4gICAgc2hvd1RhYihleGlzdGluZ01vZGFsLCBcImJhdHRsZVwiKTtcbiAgICBzeW5jU2V0dGluZ3NDb250cm9scyhleGlzdGluZ01vZGFsKTtcbiAgICB1cGRhdGVSYXRpbmdzTm90ZSgpO1xuXG4gICAgLy8gUmUtcmVnaXN0ZXIga2V5Ym9hcmQgaGFuZGxlclxuICAgIGlmIChtb2RhbEtleUhhbmRsZXIpIHtcbiAgICAgIGRvY3VtZW50LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJrZXlkb3duXCIsIG1vZGFsS2V5SGFuZGxlciwgdHJ1ZSk7XG4gICAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwia2V5ZG93blwiLCBtb2RhbEtleUhhbmRsZXIsIHRydWUpO1xuICAgIH1cblxuICAgIC8vIEZvY3VzIG1vZGFsIGNvbnRlbnRcbiAgICBjb25zdCBtb2RhbENvbnRlbnQgPSBleGlzdGluZ01vZGFsLnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiLnNiLW1vZGFsLWNvbnRlbnRcIik7XG4gICAgaWYgKG1vZGFsQ29udGVudCkgbW9kYWxDb250ZW50LmZvY3VzKCk7XG5cbiAgICAvLyBUaGUgb25lLXRpbWUgRUxPIHNldHVwIHNob3dzIGluIHBsYWNlIG9mIHRoZSBiYXR0bGUgdW50aWwgaXQncyBkb25lXG4gICAgaWYgKGlzRWxvU2V0dXBQZW5kaW5nKCkpIHtcbiAgICAgIHNob3dTZXR1cFNjcmVlbihleGlzdGluZ01vZGFsLCAoKSA9PiBhZnRlclNldHVwKGV4aXN0aW5nTW9kYWwpKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaGlkZVNldHVwU2NyZWVuKGV4aXN0aW5nTW9kYWwpO1xuXG4gICAgLy8gSWYgZmlsdGVycyBjaGFuZ2VkLCBubyBwYWlyLCBvciBmb3JjZWQgc2NlbmUsIGxvYWQgbmV3IGNvbnRlbnRcbiAgICBpZiAoZm9yY2VTY2VuZUJhdHRsZSkge1xuICAgICAgbG9hZE5ld1BhaXIoc2NlbmVQYWdlSWQpO1xuICAgIH0gZWxzZSBpZiAoZmlsdGVyc0NoYW5nZWQpIHtcbiAgICAgIGxvYWROZXdQYWlyKCk7XG4gICAgfSBlbHNlIGlmICghc3RhdGUuY3VycmVudFBhaXIubGVmdCB8fCAhc3RhdGUuY3VycmVudFBhaXIucmlnaHQpIHtcbiAgICAgIC8vIEEgZmluaXNoZWQgcnVuJ3MgZW5kIHNjcmVlbiBzdGF5cyB1bnRpbCBcIlN0YXJ0IE5ldyBSdW5cIiAodGhlIHJ1biBjbGVhcmVkIGl0cyBwYWlyKVxuICAgICAgaWYgKCFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKFwiI3NiLWNvbXBhcmlzb24tYXJlYSAuc2ItZW5kLXNjcmVlblwiKSkgbG9hZE5ld1BhaXIoKTtcbiAgICB9IGVsc2UgaWYgKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoXCIjc2ItY29tcGFyaXNvbi1hcmVhIC5zYi12cy1jb250YWluZXJcIikpIHtcbiAgICAgIC8vIEV4aXN0aW5nIHBhaXIgaXMgc3RpbGwgdmFsaWQgdW5sZXNzIGEgc2NlbmUgd2FzIGRlbGV0ZWQgZWxzZXdoZXJlIG1lYW53aGlsZVxuICAgICAgYXBwbHlQcmV2aWV3U2V0dGluZ3MoKTtcbiAgICAgIHZvaWQgdmVyaWZ5Q3VycmVudFBhaXIoKTtcbiAgICB9XG5cbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBSZW1vdmUgYW55IG90aGVyIGV4aXN0aW5nIG1vZGFsIChhIG1lc3NhZ2UgbW9kYWwsIG9yIGEgdmlzaWJsZSBvbmUsIHdoaWNoIHNob3VsZG4ndCBoYXBwZW4pXG4gIGlmIChleGlzdGluZ01vZGFsKSBleGlzdGluZ01vZGFsLnJlbW92ZSgpO1xuXG4gIC8vIEluaXRpYWxpemUgZmlsdGVyIHBhcmFtcyB0cmFja2luZ1xuICBpZiAoIXN0YXRlLnNhdmVkRmlsdGVyUGFyYW1zKSB7XG4gICAgc3RhdGUuc2F2ZWRGaWx0ZXJQYXJhbXMgPSBjdXJyZW50RmlsdGVyUGFyYW1zO1xuICB9XG5cbiAgY29uc3QgbW9kYWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBtb2RhbC5pZCA9IFwic2ItbW9kYWxcIjtcbiAgbW9kYWwuaW5uZXJIVE1MID0gYFxuICAgICAgPGRpdiBjbGFzcz1cInNiLW1vZGFsLWJhY2tkcm9wXCI+PC9kaXY+XG4gICAgICA8ZGl2IGNsYXNzPVwic2ItbW9kYWwtY29udGVudFwiPlxuICAgICAgICA8YnV0dG9uIGNsYXNzPVwic2ItbW9kYWwtY2xvc2VcIiBhcmlhLWxhYmVsPVwiQ2xvc2VcIj7inJU8L2J1dHRvbj5cbiAgICAgICAgJHtjcmVhdGVNYWluVUkoKX1cbiAgICAgIDwvZGl2PlxuICAgIGA7XG5cbiAgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZChtb2RhbCk7XG4gIGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LmFkZChCQVRUTEVfT1BFTl9DTEFTUyk7XG5cbiAgLy8gRm9jdXMgdGhlIG1vZGFsIGNvbnRlbnQgc28ga2V5Ym9hcmQgc2hvcnRjdXRzIHdvcmsgaW1tZWRpYXRlbHlcbiAgY29uc3QgbW9kYWxDb250ZW50ID0gbW9kYWwucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCIuc2ItbW9kYWwtY29udGVudFwiKTtcbiAgaWYgKG1vZGFsQ29udGVudCkge1xuICAgIG1vZGFsQ29udGVudC5zZXRBdHRyaWJ1dGUoXCJ0YWJpbmRleFwiLCBcIi0xXCIpO1xuICAgIG1vZGFsQ29udGVudC5zdHlsZS5vdXRsaW5lID0gXCJub25lXCI7XG4gICAgbW9kYWxDb250ZW50LmZvY3VzKCk7XG4gIH1cblxuICAvLyBNb2RlIHRvZ2dsZSBidXR0b25zXG4gIG1vZGFsLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KFwiLnNiLW1vZGUtYnRuXCIpLmZvckVhY2goKGJ0bikgPT4ge1xuICAgIGJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4ge1xuICAgICAgY29uc3QgbmV3TW9kZSA9IGJ0bi5kYXRhc2V0Lm1vZGUgYXMgTW9kZTtcbiAgICAgIGlmIChuZXdNb2RlICE9PSBzdGF0ZS5jdXJyZW50TW9kZSkge1xuICAgICAgICBzdGF0ZS5jdXJyZW50TW9kZSA9IG5ld01vZGU7XG5cbiAgICAgICAgcmVzZXRSdW5TdGF0ZSgpO1xuXG4gICAgICAgIC8vIFJlc2V0IHNodWZmbGUgdG8gc3RhcnQgZnJlc2ggd2l0aCBuZXcgbW9kZVxuICAgICAgICBzdGF0ZS5zaHVmZmxlSW5kZXggPSAwO1xuXG4gICAgICAgIC8vIFVwZGF0ZSBidXR0b24gc3RhdGVzXG4gICAgICAgIG1vZGFsLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KFwiLnNiLW1vZGUtYnRuXCIpLmZvckVhY2goKGIpID0+IHtcbiAgICAgICAgICBiLmNsYXNzTGlzdC50b2dnbGUoXCJhY3RpdmVcIiwgYi5kYXRhc2V0Lm1vZGUgPT09IHN0YXRlLmN1cnJlbnRNb2RlKTtcbiAgICAgICAgfSk7XG4gICAgICAgIHVwZGF0ZU1vZGVJbmZvKCk7XG5cbiAgICAgICAgLy8gTG9hZCBuZXcgcGFpciBpbiBuZXcgbW9kZSwgcHJlc2VydmluZyBzY2VuZSBwYWdlIGNvbnRleHRcbiAgICAgICAgbG9hZE5ld1BhaXIoZ2V0U2NlbmVJZEZyb21VcmwoKSk7XG4gICAgICAgIHVwZGF0ZUNsaW1iUG9vbFdhcm5pbmcoKTtcbiAgICAgICAgc2F2ZVN0YXRlKCk7XG4gICAgICB9XG4gICAgfSk7XG4gIH0pO1xuXG4gIC8vIFRvdWNoLW9ubHkg4pOYOiBzaG93L2hpZGUgdGhlIGN1cnJlbnQgbW9kZSdzIGV4cGxhbmF0aW9uXG4gIGNvbnN0IG1vZGVJbmZvQnRuID0gbW9kYWwucXVlcnlTZWxlY3RvcjxIVE1MQnV0dG9uRWxlbWVudD4oXCIuc2ItbW9kZS1pbmZvLWJ0blwiKTtcbiAgY29uc3QgbW9kZUluZm8gPSBtb2RhbC5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIiNzYi1tb2RlLWluZm9cIik7XG4gIG1vZGVJbmZvQnRuPy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4ge1xuICAgIGlmICghbW9kZUluZm8pIHJldHVybjtcbiAgICB1cGRhdGVNb2RlSW5mbygpO1xuICAgIG1vZGVJbmZvLmhpZGRlbiA9ICFtb2RlSW5mby5oaWRkZW47XG4gICAgbW9kZUluZm9CdG4uc2V0QXR0cmlidXRlKFwiYXJpYS1leHBhbmRlZFwiLCBTdHJpbmcoIW1vZGVJbmZvLmhpZGRlbikpO1xuICB9KTtcblxuICAvLyBCYXR0bGUgLyBTZXR0aW5ncyB0YWJzLCBzZXR0aW5ncyBjb250cm9scywgdm9sdW1lXG4gIHNob3dUYWIobW9kYWwsIFwiYmF0dGxlXCIpO1xuICBiaW5kU2V0dGluZ3NDb250cm9scyhtb2RhbCwgb25TZXR0aW5nQ2hhbmdlZCwgKCkgPT4gYXBwbHlQcmV2aWV3U2V0dGluZ3MoKSwgY29uZmlybVNldHRpbmdDaGFuZ2UpO1xuICB1cGRhdGVSYXRpbmdzTm90ZSgpO1xuXG4gIG1vZGFsLnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLWFjdGlvbj1cInJlc2V0LWVsb1wiXScpPy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4gdm9pZCBzdGFydFJlc2V0RWxvKG1vZGFsKSk7XG4gIC8vIEJhdHRsZSB0YWIgbm90ZSdzIFwiY2hhbmdlIGluIFNldHRpbmdzXCIgbGlua1xuICBtb2RhbC5xdWVyeVNlbGVjdG9yKCdbZGF0YS1hY3Rpb249XCJvcGVuLXNldHRpbmdzXCJdJyk/LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZSkgPT4ge1xuICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICBzaG93VGFiKG1vZGFsLCBcInNldHRpbmdzXCIpO1xuICAgIGFwcGx5UHJldmlld1NldHRpbmdzKCk7XG4gIH0pO1xuXG4gIC8vIFNraXAgYnV0dG9uXG4gIG1vZGFsLnF1ZXJ5U2VsZWN0b3IoXCIjc2Itc2tpcC1idG5cIik/LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBza2lwUGFpcik7XG5cbiAgLy8gUmVmcmVzaCBjYWNoZSBidXR0b25cbiAgY29uc3QgcmVmcmVzaENhY2hlQnRuID0gbW9kYWwucXVlcnlTZWxlY3RvcjxIVE1MQnV0dG9uRWxlbWVudD4oXCIjc2ItcmVmcmVzaC1jYWNoZS1idG5cIik7XG4gIGlmIChyZWZyZXNoQ2FjaGVCdG4pIHtcbiAgICByZWZyZXNoQ2FjaGVCdG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIGFzeW5jICgpID0+IHtcbiAgICAgIGlmIChzdGF0ZS5kaXNhYmxlQ2hvaWNlKSByZXR1cm47XG5cbiAgICAgIGNvbnN0IGxhYmVsID0gcmVmcmVzaENhY2hlQnRuLnRleHRDb250ZW50O1xuICAgICAgcmVmcmVzaENhY2hlQnRuLmRpc2FibGVkID0gdHJ1ZTtcbiAgICAgIHJlZnJlc2hDYWNoZUJ0bi50ZXh0Q29udGVudCA9IFwi8J+UhCBSZWZyZXNoaW5nLi4uXCI7XG5cbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IGNsZWFyU2NlbmVDYWNoZSgpO1xuXG4gICAgICAgIC8vIFJlc2V0IHNodWZmbGUgc3RhdGUgc2luY2Ugc2NlbmUgbGlzdCBpcyBiZWluZyByZWZyZXNoZWRcbiAgICAgICAgcmVzZXRTaHVmZmxlKCk7XG5cbiAgICAgICAgLy8gUmVzZXQgcnVuIHN0YXRlIHNpbmNlIHJhbmtpbmdzIG1heSBoYXZlIGNoYW5nZWRcbiAgICAgICAgcmVzZXRSdW5TdGF0ZSgpO1xuICAgICAgICBzYXZlU3RhdGUoKTtcblxuICAgICAgICBhd2FpdCBsb2FkTmV3UGFpcigpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0gUmVmcmVzaCBmYWlsZWQ6XCIsIGUpO1xuICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgcmVmcmVzaENhY2hlQnRuLmRpc2FibGVkID0gZmFsc2U7XG4gICAgICAgIHJlZnJlc2hDYWNoZUJ0bi50ZXh0Q29udGVudCA9IGxhYmVsO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG5cbiAgLy8gTG9hZCBpbml0aWFsIGNvbXBhcmlzb24gb3IgcmVzdG9yZSBzYXZlZCBwYWlyLCBhZnRlciB0aGUgb25lLXRpbWUgRUxPIHNldHVwIGlmIGl0J3MgcGVuZGluZ1xuICBpZiAoaXNFbG9TZXR1cFBlbmRpbmcoKSkge1xuICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+nrSBFTE8gc2V0dXAgbm90IGRvbmUgeWV0LCBzaG93aW5nIHNldHVwXCIpO1xuICAgIHNob3dTZXR1cFNjcmVlbihtb2RhbCwgKCkgPT4gYWZ0ZXJTZXR1cChtb2RhbCkpO1xuICB9IGVsc2UgaWYgKGZvcmNlU2NlbmVCYXR0bGUpIHtcbiAgICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g8J+OryBTdGFydGluZyBiYXR0bGUgd2l0aCBzY2VuZSAke3NjZW5lUGFnZUlkfSBmcm9tIHNjZW5lIHBhZ2VgKTtcbiAgICBsb2FkTmV3UGFpcihzY2VuZVBhZ2VJZCk7XG4gIH0gZWxzZSBpZiAoaGFzU3RhdGUgJiYgc3RhdGUuY3VycmVudFBhaXIubGVmdCAmJiBzdGF0ZS5jdXJyZW50UGFpci5yaWdodCAmJiAhZmlsdGVyc0NoYW5nZWQpIHtcbiAgICBjb25zb2xlLmxvZyhcbiAgICAgIGBbU3Rhc2ggQmF0dGxlXSDwn5OCIFJlc3RvcmluZyBzYXZlZCBwYWlyIGZyb20gbG9jYWxTdG9yYWdlIChTY2VuZSAke3N0YXRlLmN1cnJlbnRQYWlyLmxlZnQuaWR9IHZzIFNjZW5lICR7c3RhdGUuY3VycmVudFBhaXIucmlnaHQuaWR9KWAsXG4gICAgKTtcbiAgICB2b2lkIHJlc3RvcmVDdXJyZW50UGFpcigpO1xuICB9IGVsc2Uge1xuICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+GlSBObyBzYXZlZCBwYWlyIG9yIGZpbHRlcnMgY2hhbmdlZCwgbG9hZGluZyBuZXcgcGFpci4uLlwiKTtcbiAgICBsb2FkTmV3UGFpcigpO1xuICB9XG5cbiAgLy8gQ2xvc2UgaGFuZGxlcnNcbiAgbW9kYWwucXVlcnlTZWxlY3RvcihcIi5zYi1tb2RhbC1iYWNrZHJvcFwiKT8uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIGNsb3NlTW9kYWwpO1xuICBtb2RhbC5xdWVyeVNlbGVjdG9yKFwiLnNiLW1vZGFsLWNsb3NlXCIpPy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgY2xvc2VNb2RhbCk7XG5cbiAgLy8gUmVtb3ZlIGFueSBleGlzdGluZyBrZXlib2FyZCBoYW5kbGVycyBiZWZvcmUgYWRkaW5nIG5ldyBvbmVzXG4gIGlmIChtb2RhbEtleUhhbmRsZXIpIHtcbiAgICBkb2N1bWVudC5yZW1vdmVFdmVudExpc3RlbmVyKFwia2V5ZG93blwiLCBtb2RhbEtleUhhbmRsZXIsIHRydWUpO1xuICB9XG5cbiAgLy8gU2luZ2xlIGtleWJvYXJkIGhhbmRsZXIgZm9yIGFsbCBtb2RhbCBzaG9ydGN1dHNcbiAgbW9kYWxLZXlIYW5kbGVyID0gZnVuY3Rpb24gKGU6IEtleWJvYXJkRXZlbnQpIHtcbiAgICBjb25zdCBhY3RpdmVNb2RhbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic2ItbW9kYWxcIik7XG4gICAgaWYgKCFhY3RpdmVNb2RhbCkge1xuICAgICAgaWYgKG1vZGFsS2V5SGFuZGxlcikgZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImtleWRvd25cIiwgbW9kYWxLZXlIYW5kbGVyLCB0cnVlKTtcbiAgICAgIG1vZGFsS2V5SGFuZGxlciA9IG51bGw7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gU3Rhc2gncyBvd24gZGVsZXRlIGRpYWxvZyAoQ2xlYW4gbW9kZSkgaXMgb24gdG9wOiBsZXQgaXQgaGF2ZSB0aGUga2V5cyAoRXNjYXBlLCBFbnRlcilcbiAgICBpZiAoaXNEZWxldGVEaWFsb2dPcGVuKCkpIHJldHVybjtcblxuICAgIC8vIE5vdGhpbmcgdHlwZWQgd2hpbGUgQmF0dGxlIGlzIG9wZW4gbWF5IHJlYWNoIFN0YXNoJ3Mgb3duIGhvdGtleXMgKHBhZ2UgYXJyb3dzLCBsZXR0ZXJcbiAgICAvLyBzaG9ydGN1dHMpLCBvciBpdCBhY3RzIG9uIHRoZSBwYWdlIGJlaGluZCB0aGUgbW9kYWwuIERlZmF1bHQgYWN0aW9ucyAodHlwaW5nIGluIGlucHV0cyxcbiAgICAvLyBzbGlkZXIgYXJyb3dzLCBjaGVja2JveCBTcGFjZSkgc3RpbGwgaGFwcGVuIHNpbmNlIG9ubHkgcHJvcGFnYXRpb24gaXMgc3RvcHBlZCBoZXJlLlxuICAgIGUuc3RvcEltbWVkaWF0ZVByb3BhZ2F0aW9uKCk7XG5cbiAgICAvLyBBIGNvbmZpcm1hdGlvbiBkaWFsb2cgaXMgb3BlbjogRXNjYXBlIGNhbmNlbHMgaXQsIG90aGVyIGtleXMgYXJlIGl0cyBvd24gKFRhYiwgRW50ZXIpXG4gICAgaWYgKGlzQ29uZmlybURpYWxvZ09wZW4oKSkge1xuICAgICAgaWYgKGUua2V5ID09PSBcIkVzY2FwZVwiKSB7XG4gICAgICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICAgICAgY2FuY2VsQ29uZmlybURpYWxvZygpO1xuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIEVzY2FwZSB0byBjbG9zZVxuICAgIGlmIChlLmtleSA9PT0gXCJFc2NhcGVcIikge1xuICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgY2xvc2VNb2RhbCgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIEJhdHRsZSBzaG9ydGN1dHMgb25seSBhcHBseSBvbiB0aGUgQmF0dGxlIHRhYiwgb25jZSBFTE8gc2V0dXAgaXMgZG9uZVxuICAgIGlmIChnZXRBY3RpdmVUYWIoKSAhPT0gXCJiYXR0bGVcIiB8fCBpc0Vsb1NldHVwUGVuZGluZygpKSByZXR1cm47XG5cbiAgICAvLyBMZXQgdGhlIHZvbHVtZSBzbGlkZXIgLyBudW1iZXIgaW5wdXQga2VlcCB0aGVpciBvd24gYXJyb3cga2V5cyAoY2hlY2tib3hlcyBkb24ndCBuZWVkIHRoZW0pXG4gICAgY29uc3QgYWN0aXZlID0gZG9jdW1lbnQuYWN0aXZlRWxlbWVudCBhcyBIVE1MSW5wdXRFbGVtZW50IHwgbnVsbDtcbiAgICBjb25zdCB0YWcgPSBhY3RpdmU/LnRhZ05hbWU7XG4gICAgY29uc3QgaXNUb2dnbGUgPSB0YWcgPT09IFwiSU5QVVRcIiAmJiAoYWN0aXZlPy50eXBlID09PSBcImNoZWNrYm94XCIgfHwgYWN0aXZlPy50eXBlID09PSBcInJhZGlvXCIpO1xuICAgIGlmICgodGFnID09PSBcIklOUFVUXCIgJiYgIWlzVG9nZ2xlKSB8fCB0YWcgPT09IFwiVEVYVEFSRUFcIiB8fCB0YWcgPT09IFwiU0VMRUNUXCIpIHJldHVybjtcblxuICAgIC8vIEFycm93IGtleXMgdG8gY2hvb3NlXG4gICAgaWYgKGUua2V5ID09PSBcIkFycm93TGVmdFwiICYmIHN0YXRlLmN1cnJlbnRQYWlyLmxlZnQpIHtcbiAgICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICAgIGNvbnN0IGxlZnRCb2R5ID0gYWN0aXZlTW9kYWwucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oJy5zYi1zY2VuZS1jYXJkW2RhdGEtc2lkZT1cImxlZnRcIl0gLnNiLXNjZW5lLWJvZHknKTtcbiAgICAgIGlmIChsZWZ0Qm9keSkgbGVmdEJvZHkuY2xpY2soKTtcbiAgICB9XG4gICAgaWYgKGUua2V5ID09PSBcIkFycm93UmlnaHRcIiAmJiBzdGF0ZS5jdXJyZW50UGFpci5yaWdodCkge1xuICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgY29uc3QgcmlnaHRCb2R5ID0gYWN0aXZlTW9kYWwucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oJy5zYi1zY2VuZS1jYXJkW2RhdGEtc2lkZT1cInJpZ2h0XCJdIC5zYi1zY2VuZS1ib2R5Jyk7XG4gICAgICBpZiAocmlnaHRCb2R5KSByaWdodEJvZHkuY2xpY2soKTtcbiAgICB9XG5cbiAgICAvLyBTcGFjZWJhciB0byBza2lwXG4gICAgaWYgKGUua2V5ID09PSBcIiBcIiB8fCBlLmNvZGUgPT09IFwiU3BhY2VcIikge1xuICAgICAgLy8gTGV0IGEgZm9jdXNlZCBidXR0b24gb3IgY2hlY2tib3ggaGFuZGxlIGl0cyBvd24gU3BhY2VcbiAgICAgIGlmICh0YWcgPT09IFwiQlVUVE9OXCIgfHwgaXNUb2dnbGUpIHJldHVybjtcbiAgICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICAgIHNraXBQYWlyKCk7XG4gICAgfVxuICB9O1xuXG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJrZXlkb3duXCIsIG1vZGFsS2V5SGFuZGxlciwgdHJ1ZSk7XG59XG5cbi8qKiBBIG1vZGFsIHdpdGgganVzdCBhIG1lc3NhZ2UsIHNob3duIGluc3RlYWQgb2YgQmF0dGxlIChlLmcuIHRoaXMgU3Rhc2ggbGFja3MgY3VzdG9tIGZpZWxkcykuICovXG5mdW5jdGlvbiBzaG93TWVzc2FnZU1vZGFsKG1lc3NhZ2U6IHN0cmluZyk6IHZvaWQge1xuICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInNiLW1vZGFsXCIpPy5yZW1vdmUoKTtcbiAgY29uc3QgbW9kYWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBtb2RhbC5pZCA9IFwic2ItbW9kYWxcIjtcbiAgbW9kYWwuaW5uZXJIVE1MID0gYFxuICAgICAgPGRpdiBjbGFzcz1cInNiLW1vZGFsLWJhY2tkcm9wXCI+PC9kaXY+XG4gICAgICA8ZGl2IGNsYXNzPVwic2ItbW9kYWwtY29udGVudFwiPlxuICAgICAgICA8YnV0dG9uIGNsYXNzPVwic2ItbW9kYWwtY2xvc2VcIiBhcmlhLWxhYmVsPVwiQ2xvc2VcIj7inJU8L2J1dHRvbj5cbiAgICAgICAgPGRpdiBjbGFzcz1cInNiLWVycm9yLXNjcmVlblwiPlxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1lcnJvci1pY29uXCI+4pqg77iPPC9kaXY+XG4gICAgICAgICAgPHAgY2xhc3M9XCJzYi1lcnJvci1tZXNzYWdlXCI+JHttZXNzYWdlfTwvcD5cbiAgICAgICAgPC9kaXY+XG4gICAgICA8L2Rpdj5cbiAgICBgO1xuICBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKG1vZGFsKTtcbiAgZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QuYWRkKEJBVFRMRV9PUEVOX0NMQVNTKTtcbiAgbW9kYWwucXVlcnlTZWxlY3RvcihcIi5zYi1tb2RhbC1iYWNrZHJvcFwiKT8uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIGNsb3NlTW9kYWwpO1xuICBtb2RhbC5xdWVyeVNlbGVjdG9yKFwiLnNiLW1vZGFsLWNsb3NlXCIpPy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgY2xvc2VNb2RhbCk7XG59XG5cbi8qKiBUcnVlIHdoaWxlIHRoZSBiYXR0bGUgbW9kYWwgaXMgb24gc2NyZWVuIChpdCBzdGF5cyBpbiB0aGUgRE9NLCBoaWRkZW4sIGFmdGVyIGNsb3NpbmcpLiAqL1xuZnVuY3Rpb24gaXNNb2RhbFZpc2libGUoKTogYm9vbGVhbiB7XG4gIGNvbnN0IG1vZGFsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzYi1tb2RhbFwiKTtcbiAgcmV0dXJuIG1vZGFsICE9PSBudWxsICYmICFtb2RhbC5jbGFzc0xpc3QuY29udGFpbnMoXCJzYi1tb2RhbC1oaWRkZW5cIik7XG59XG5cbi8vIFN0YXNoJ3MgaG90a2V5cyAoTW91c2V0cmFwKSBhbHNvIGxpc3RlbiBmb3Iga2V5cHJlc3Mva2V5dXAgb24gZG9jdW1lbnQ7IGtleWRvd24gaXMgaGFuZGxlZFxuLy8gYnkgbW9kYWxLZXlIYW5kbGVyLiBSZWdpc3RlcmVkIG9uY2UsIGluIHRoZSBjYXB0dXJlIHBoYXNlLCBhbmQgaW5lcnQgd2hpbGUgdGhlIG1vZGFsIGlzIGhpZGRlbi5cbmxldCBrZXlTd2FsbG93ZXJzQWRkZWQgPSBmYWxzZTtcbmZ1bmN0aW9uIGFkZEtleVN3YWxsb3dlcnMoKTogdm9pZCB7XG4gIGlmIChrZXlTd2FsbG93ZXJzQWRkZWQpIHJldHVybjtcbiAga2V5U3dhbGxvd2Vyc0FkZGVkID0gdHJ1ZTtcbiAgY29uc3Qgc3dhbGxvdyA9IChlOiBLZXlib2FyZEV2ZW50KTogdm9pZCA9PiB7XG4gICAgaWYgKGlzTW9kYWxWaXNpYmxlKCkgJiYgIWlzRGVsZXRlRGlhbG9nT3BlbigpKSBlLnN0b3BJbW1lZGlhdGVQcm9wYWdhdGlvbigpO1xuICB9O1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwia2V5cHJlc3NcIiwgc3dhbGxvdywgdHJ1ZSk7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJrZXl1cFwiLCBzd2FsbG93LCB0cnVlKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNsb3NlTW9kYWwoKTogdm9pZCB7XG4gIGNvbnN0IG1vZGFsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzYi1tb2RhbFwiKTtcbiAgaWYgKCFtb2RhbCB8fCBtb2RhbC5jbGFzc0xpc3QuY29udGFpbnMoXCJzYi1tb2RhbC1oaWRkZW5cIikpIHJldHVybjtcblxuICBjYW5jZWxEZWxldGVEaWFsb2coKTtcbiAgY2FuY2VsQ29uZmlybURpYWxvZygpO1xuICAvLyBTdGFzaCdzIHNjZW5lIGxpc3RzIHNob3cgdGhlIHJhdGluZ3Mgd3JpdHRlbiB3aGlsZSBTdGFzaCBCYXR0bGUgd2FzIG9wZW4sIGFuZCBhIHNjZW5lIHBhZ2UgaXRzIEVMT1xuICBob2xkU3Rhc2hMaXN0UmVmcmVzaChmYWxzZSk7XG4gIHJlZnJlc2hTY2VuZUVsbygpO1xuICAvLyBDbG9zaW5nIFN0YXNoIEJhdHRsZSBvbiBSZXNldCBFTE8ncyBjaG9pY2VzIChiZWZvcmUgU3RhcnQpIGNhbmNlbHMgdGhlIHJlc2V0XG4gIGlmIChzdGF0ZS5yZXNldHRpbmdFbG8gJiYgIWlzU2V0dXBSdW5uaW5nKCkpIHtcbiAgICBzdGF0ZS5yZXNldHRpbmdFbG8gPSBmYWxzZTtcbiAgICBoaWRlU2V0dXBTY3JlZW4obW9kYWwpO1xuICB9XG5cbiAgLy8gU3RvcCBwcmV2aWV3cyAoYXV0b3BsYXkga2VlcHMgdGhlbSBydW5uaW5nIG90aGVyd2lzZSlcbiAgbW9kYWwucXVlcnlTZWxlY3RvckFsbDxIVE1MVmlkZW9FbGVtZW50PihcIi5zYi1ob3Zlci1wcmV2aWV3XCIpLmZvckVhY2goKHYpID0+IHYucGF1c2UoKSk7XG5cbiAgLy8gQWRkIGNsb3NpbmcgY2xhc3MgdG8gdHJpZ2dlciBmYWRlLW91dCBhbmltYXRpb25cbiAgbW9kYWwuY2xhc3NMaXN0LmFkZChcInNiLW1vZGFsLWNsb3NpbmdcIik7XG5cbiAgLy8gQWZ0ZXIgYW5pbWF0aW9uIGNvbXBsZXRlcywgaGlkZSB0aGUgbW9kYWwgKGtlZXAgaW4gRE9NIGZvciByZXVzZSlcbiAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgbW9kYWwuY2xhc3NMaXN0LmFkZChcInNiLW1vZGFsLWhpZGRlblwiKTtcbiAgICBkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5yZW1vdmUoQkFUVExFX09QRU5fQ0xBU1MpO1xuICAgIG1vZGFsLmNsYXNzTGlzdC5yZW1vdmUoXCJzYi1tb2RhbC1jbG9zaW5nXCIpO1xuICB9LCAyMDApOyAvLyBNYXRjaCBDU1MgYW5pbWF0aW9uIGR1cmF0aW9uXG5cbiAgLy8gQ2xlYW4gdXAga2V5Ym9hcmQgaGFuZGxlclxuICBpZiAobW9kYWxLZXlIYW5kbGVyKSB7XG4gICAgZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImtleWRvd25cIiwgbW9kYWxLZXlIYW5kbGVyLCB0cnVlKTtcbiAgfVxufVxuXG4iLCAiLy8gVGhlIG5hdmJhciBcIkJhdHRsZVwiIGJ1dHRvbiB0aGF0IG9wZW5zIHRoZSBjb21wYXJpc29uIG1vZGFsLlxuLy9cbi8vIFdoZXJlIFN0YXNoIGhhcyB0aGUgcGx1Z2luIHBhdGNoIEFQSSwgdGhlIGJ1dHRvbiBpcyBwYXRjaGVkIGludG8gTWFpbk5hdkJhci5NZW51SXRlbXMgKGFmdGVyXG4vLyBTdGFzaCdzIG93biBwYWdlIGxpbmtzKSwgc28gUmVhY3QgcmVuZGVycyBpdCB3aXRoIHRoZSByZXN0IG9mIHRoZSBuYXZiYXIuIE90aGVyd2lzZSBpdCdzIGFkZGVkXG4vLyB0byB0aGUgRE9NIGRpcmVjdGx5IGFuZCByZS1hZGRlZCB3aGVuZXZlciB0aGUgcGFnZSBjaGFuZ2VzLlxuXG5pbXBvcnQgdHlwZSB7IFBsdWdpbkFwaUxpa2UsIFJlYWN0Tm9kZSB9IGZyb20gXCIuLi9wbHVnaW5BcGlcIjtcbmltcG9ydCB7IFNXT1JEU19QQVRIUyB9IGZyb20gXCIuL2ljb25zXCI7XG5pbXBvcnQgeyBvcGVuTW9kYWwgfSBmcm9tIFwiLi9tb2RhbFwiO1xuXG5jb25zdCBCVVRUT05fSUQgPSBcInBsdWdpbl9zYlwiO1xuY29uc3QgTkFWX0lURU1fQ0xBU1MgPSBcImNvbC00IGNvbC1zbS0zIGNvbC1tZC0yIGNvbC1sZy1hdXRvIG5hdi1saW5rXCI7XG5jb25zdCBMSU5LX0NMQVNTID1cbiAgXCJtaW5pbWFsIHAtNCBwLXhsLTIgZC1mbGV4IGQteGwtaW5saW5lLWJsb2NrIGZsZXgtY29sdW1uIGp1c3RpZnktY29udGVudC1iZXR3ZWVuIGFsaWduLWl0ZW1zLWNlbnRlciBidG4gYnRuLXByaW1hcnlcIjtcbmNvbnN0IExJTktfSFRNTCA9IGBcbiAgICAgICAgICAgIDxzdmcgYXJpYS1oaWRkZW49XCJ0cnVlXCIgZm9jdXNhYmxlPVwiZmFsc2VcIiBjbGFzcz1cInN2Zy1pbmxpbmUtLWZhIGZhLWljb24gbmF2LW1lbnUtaWNvbiBkLWJsb2NrIGQteGwtaW5saW5lIG1iLTIgbWIteGwtMFwiIHJvbGU9XCJpbWdcIiB4bWxucz1cImh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnXCIgdmlld0JveD1cIjAgMCAzNiAzNlwiPiR7U1dPUkRTX1BBVEhTfTwvc3ZnPlxuICAgICAgICAgICAgPHNwYW4+QmF0dGxlPC9zcGFuPlxuICAgICAgICBgO1xuXG5leHBvcnQgZnVuY3Rpb24gc2hvdWxkU2hvd05hdkJ1dHRvbigpOiBib29sZWFuIHtcbiAgY29uc3QgcGF0aCA9IHdpbmRvdy5sb2NhdGlvbi5wYXRobmFtZTtcbiAgcmV0dXJuIChcbiAgICBwYXRoID09PSBcIi9cIiB8fFxuICAgIHBhdGggPT09IFwiL3NjZW5lc1wiIHx8XG4gICAgcGF0aCA9PT0gXCIvc2NlbmVzL1wiIHx8XG4gICAgcGF0aC5zdGFydHNXaXRoKFwiL3NjZW5lcy9cIilcbiAgKTtcbn1cblxuZnVuY3Rpb24gb25CdXR0b25DbGljayhlOiB7IHByZXZlbnREZWZhdWx0KCk6IHZvaWQgfSk6IHZvaWQge1xuICBlLnByZXZlbnREZWZhdWx0KCk7XG4gIHZvaWQgb3Blbk1vZGFsKCk7XG59XG5cbi8qKiBBZGQgdGhlIEJhdHRsZSBuYXYgaXRlbSB0byBTdGFzaCdzIG5hdmJhciwgc2hvd24gb25seSBvbiB0aGUgcm91dGVzIHdoZXJlIGl0IGFwcGxpZXMuIENhbGwgb25jZSBhdCBzdGFydHVwLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdGVyTmF2QnV0dG9uKCk6IHZvaWQge1xuICBjb25zdCBhcGkgPSB3aW5kb3cuUGx1Z2luQXBpO1xuICBpZiAoYXBpPy5jb21wb25lbnRzPy5bXCJNYWluTmF2QmFyLk1lbnVJdGVtc1wiXSAmJiB0eXBlb2YgYXBpLnBhdGNoPy5iZWZvcmUgPT09IFwiZnVuY3Rpb25cIikge1xuICAgIHBhdGNoTmF2QnV0dG9uKGFwaSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaW5qZWN0TmF2QnV0dG9uKCk7XG5cbiAgLy8gUmUtaW5qZWN0IG5hdiBidXR0b24gYWZ0ZXIgU3Rhc2ggU1BBIG5hdmlnYXRpb24gcmVidWlsZHMgdGhlIG5hdmJhclxuICBjb25zdCBvYnNlcnZlciA9IG5ldyBNdXRhdGlvbk9ic2VydmVyKCgpID0+IHtcbiAgICBpbmplY3ROYXZCdXR0b24oKTtcbiAgfSk7XG5cbiAgb2JzZXJ2ZXIub2JzZXJ2ZShkb2N1bWVudC5ib2R5LCB7XG4gICAgY2hpbGRMaXN0OiB0cnVlLFxuICAgIHN1YnRyZWU6IHRydWUsXG4gIH0pO1xufVxuXG5mdW5jdGlvbiBwYXRjaE5hdkJ1dHRvbihhcGk6IFBsdWdpbkFwaUxpa2UpOiB2b2lkIHtcbiAgY29uc3QgeyBSZWFjdCB9ID0gYXBpO1xuICBjb25zdCBldmVudHMgPSBhcGkuRXZlbnQ7XG5cbiAgZnVuY3Rpb24gQmF0dGxlTmF2SXRlbSgpOiBSZWFjdE5vZGUge1xuICAgIC8vIFRoZSByb3V0ZSBpcyByZWFkIG9uIGV2ZXJ5IHJlbmRlcjsgdGhlIHN0YXRlIG9ubHkgbWFrZXMgU3Rhc2gncyBuYXZpZ2F0aW9uIGV2ZW50cyByZS1yZW5kZXJcbiAgICBjb25zdCBbLCBzZXRQYXRoXSA9IFJlYWN0LnVzZVN0YXRlKHdpbmRvdy5sb2NhdGlvbi5wYXRobmFtZSk7XG5cbiAgICBSZWFjdC51c2VFZmZlY3QoKCkgPT4ge1xuICAgICAgaWYgKCFldmVudHMpIHJldHVybjtcbiAgICAgIGNvbnN0IHVwZGF0ZSA9ICgpOiB2b2lkID0+IHNldFBhdGgod2luZG93LmxvY2F0aW9uLnBhdGhuYW1lKTtcbiAgICAgIHVwZGF0ZSgpO1xuICAgICAgZXZlbnRzLmFkZEV2ZW50TGlzdGVuZXIoXCJzdGFzaDpsb2NhdGlvblwiLCB1cGRhdGUpO1xuICAgICAgcmV0dXJuICgpID0+IGV2ZW50cy5yZW1vdmVFdmVudExpc3RlbmVyKFwic3Rhc2g6bG9jYXRpb25cIiwgdXBkYXRlKTtcbiAgICB9LCBbXSk7XG5cbiAgICBpZiAoIXNob3VsZFNob3dOYXZCdXR0b24oKSkgcmV0dXJuIG51bGw7XG4gICAgcmV0dXJuIFJlYWN0LmNyZWF0ZUVsZW1lbnQoXG4gICAgICBcImRpdlwiLFxuICAgICAgeyBpZDogQlVUVE9OX0lELCBjbGFzc05hbWU6IE5BVl9JVEVNX0NMQVNTIH0sXG4gICAgICBSZWFjdC5jcmVhdGVFbGVtZW50KFwiYVwiLCB7XG4gICAgICAgIGhyZWY6IFwiI1wiLFxuICAgICAgICBjbGFzc05hbWU6IExJTktfQ0xBU1MsXG4gICAgICAgIG9uQ2xpY2s6IG9uQnV0dG9uQ2xpY2ssXG4gICAgICAgIGRhbmdlcm91c2x5U2V0SW5uZXJIVE1MOiB7IF9faHRtbDogTElOS19IVE1MIH0sXG4gICAgICB9KSxcbiAgICApO1xuICB9XG5cbiAgLy8gQXBwZW5kIHRvIHRoZSBjaGlsZHJlbiBNZW51SXRlbXMgcmVuZGVycyBpbiBpdHMgTmF2LiBFdmVyeSBvdGhlciBhcmcgaXMgcGFzc2VkIHRocm91Z2ggYXMgaXM6XG4gIC8vIGFuIGBhZnRlcmAgcGF0Y2ggZmluZHMgdGhlIHJlbmRlcmVkIHJlc3VsdCBieSBwb3NpdGlvbiwgc28gdGhlIGFyZyBjb3VudCBtdXN0IG5vdCBjaGFuZ2UuXG4gIGFwaS5wYXRjaC5iZWZvcmUoXCJNYWluTmF2QmFyLk1lbnVJdGVtc1wiLCAocHJvcHMsIC4uLnJlc3QpID0+IFtcbiAgICB7XG4gICAgICAuLi4ocHJvcHMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pLFxuICAgICAgY2hpbGRyZW46IFsocHJvcHMgYXMgeyBjaGlsZHJlbj86IFJlYWN0Tm9kZSB9KS5jaGlsZHJlbiwgUmVhY3QuY3JlYXRlRWxlbWVudChCYXR0bGVOYXZJdGVtLCB7IGtleTogQlVUVE9OX0lEIH0pXSxcbiAgICB9LFxuICAgIC4uLnJlc3QsXG4gIF0pO1xufVxuXG4vKiogSW5qZWN0IG9yIHJlbW92ZSB0aGUgQmF0dGxlIG5hdiBpdGVtIGJhc2VkIG9uIHRoZSBjdXJyZW50IHJvdXRlLiBTYWZlIHRvIGNhbGwgcmVwZWF0ZWRseS4gKi9cbmZ1bmN0aW9uIGluamVjdE5hdkJ1dHRvbigpOiB2b2lkIHtcbiAgaWYgKCFzaG91bGRTaG93TmF2QnV0dG9uKCkpIHtcbiAgICBjb25zdCBleGlzdGluZyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKEJVVFRPTl9JRCk7XG4gICAgaWYgKGV4aXN0aW5nKSB7XG4gICAgICBleGlzdGluZy5jbG9zZXN0KFwiLm5hdi1saW5rXCIpPy5yZW1vdmUoKTtcbiAgICB9XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKEJVVFRPTl9JRCkpIHJldHVybjtcblxuICBjb25zdCBuYXZJdGVtID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbmF2SXRlbS5jbGFzc05hbWUgPSBOQVZfSVRFTV9DTEFTUztcbiAgbmF2SXRlbS5pZCA9IEJVVFRPTl9JRDtcblxuICBjb25zdCBsaW5rID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImFcIik7XG4gIGxpbmsuaHJlZiA9IFwiI1wiO1xuICBsaW5rLmNsYXNzTmFtZSA9IExJTktfQ0xBU1M7XG4gIGxpbmsuaW5uZXJIVE1MID0gTElOS19IVE1MO1xuICBsaW5rLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBvbkJ1dHRvbkNsaWNrKTtcbiAgbmF2SXRlbS5hcHBlbmRDaGlsZChsaW5rKTtcblxuICBjb25zdCBuYXZUYXJnZXQgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKFwiLm5hdmJhci1uYXZcIik7XG4gIGlmIChuYXZUYXJnZXQpIHtcbiAgICBuYXZUYXJnZXQuYXBwZW5kQ2hpbGQobmF2SXRlbSk7XG4gIH1cbn1cbiIsICIvLyBTdGFzaCBCYXR0bGUgLSBlbnRyeSBwb2ludC5cbi8vIEJ1bmRsZWQgYnkgZXNidWlsZCBpbnRvIHBsdWdpbnMvc3Rhc2gtYmF0dGxlL3N0YXNoLWJhdHRsZS5qcyAoSUlGRSkuXG5cbmltcG9ydCB7IHJlZ2lzdGVyRGVsZXRlRGlhbG9nQnJpZGdlIH0gZnJvbSBcIi4vdWkvZGVsZXRlRGlhbG9nXCI7XG5pbXBvcnQgeyBvcGVuTW9kYWwgfSBmcm9tIFwiLi91aS9tb2RhbFwiO1xuaW1wb3J0IHsgcmVnaXN0ZXJOYXZCdXR0b24gfSBmcm9tIFwiLi91aS9uYXZCdXR0b25cIjtcbmltcG9ydCB7IHJlZ2lzdGVyU2NlbmVFbG8gfSBmcm9tIFwiLi91aS9zY2VuZUVsb1wiO1xuXG5mdW5jdGlvbiBpbml0KCk6IHZvaWQge1xuICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIEluaXRpYWxpemVkXCIpO1xuXG4gIHJlZ2lzdGVyRGVsZXRlRGlhbG9nQnJpZGdlKCk7XG4gIHJlZ2lzdGVyTmF2QnV0dG9uKCk7XG4gIHJlZ2lzdGVyU2NlbmVFbG8oKCkgPT4gdm9pZCBvcGVuTW9kYWwoKSk7XG59XG5cbmlmIChkb2N1bWVudC5yZWFkeVN0YXRlID09PSBcImxvYWRpbmdcIikge1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwiRE9NQ29udGVudExvYWRlZFwiLCBpbml0KTtcbn0gZWxzZSB7XG4gIGluaXQoKTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICI7OztBQUVPLE1BQU0sY0FBYztBQUNwQixNQUFNLGdCQUFnQjtBQUV0QixNQUFNLG1CQUFtQjtBQUN6QixNQUFNLG1CQUFtQjtBQUN6QixNQUFNLG1CQUFtQixJQUFJLEtBQUs7QUFLbEMsTUFBTSxZQUFZO0FBRWxCLE1BQU0sbUJBQTZCO0FBQUEsSUFDeEMsY0FBYztBQUFBLElBQ2QsWUFBWTtBQUFBLElBQ1osY0FBYztBQUFBLElBQ2QsY0FBYztBQUFBLElBQ2QscUJBQXFCO0FBQUEsSUFDckIsZUFBZTtBQUFBLElBQ2Ysa0JBQWtCO0FBQUEsSUFDbEIsaUJBQWlCO0FBQUEsSUFDakIsV0FBVztBQUFBLElBQ1gsa0JBQWtCO0FBQUEsRUFDcEI7QUFHTyxNQUFNLDhCQUE4QjtBQUNwQyxNQUFNLDJCQUEyQjtBQUdqQyxNQUFNLCtCQUErQjtBQUNyQyxNQUFNLGtDQUFrQztBQUd4QyxNQUFNLDZCQUE2QjtBQU1uQyxNQUFNLHVCQUF1QjtBQUc3QixNQUFNLDJC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QixNQUFNO0FBQ2hELGVBQU8sTUFBTSxPQUFPLG9CQUFvQixrQkFBa0IsTUFBTTtBQUFBLE1BQ2xFLEdBQUcsQ0FBQyxDQUFDO0FBRUwsVUFBSSxDQUFDLG9CQUFvQixFQUFHLFFBQU87QUFDbkMsYUFBTyxNQUFNO0FBQUEsUUFDWDtBQUFBLFFBQ0EsRUFBRSxJQUFJLFdBQVcsV0FBVyxlQUFlO0FBQUEsUUFDM0MsTUFBTSxjQUFjLEtBQUs7QUFBQSxVQUN2QixNQUFNO0FBQUEsVUFDTixXQUFXO0FBQUEsVUFDWCxTQUFTO0FBQUEsVUFDVCx5QkFBeUIsRUFBRSxRQUFRLFVBQVU7QUFBQSxRQUMvQyxDQUFDO0FBQUEsTUFDSDtBQUFBLElBQ0Y7QUFJQSxRQUFJLE1BQU0sT0FBTyx3QkFBd0IsQ0FBQyxVQUFVLFNBQVM7QUFBQSxNQUMzRDtBQUFBLFFBQ0UsR0FBSTtBQUFBLFFBQ0osVUFBVSxDQUFFLE1BQW1DLFVBQVUsTUFBTSxjQUFjLGVBQWUsRUFBRSxLQUFLLFVBQVUsQ0FBQyxDQUFDO0FBQUEsTUFDakg7QUFBQSxNQUNBLEdBQUc7QUFBQSxJQUNMLENBQUM7QUFBQSxFQUNIO0FBR0EsV0FBUyxrQkFBd0I7QUFDL0IsUUFBSSxDQUFDLG9CQUFvQixHQUFHO0FBQzFCLFlBQU0sV0FBVyxTQUFTLGVBQWUsU0FBUztBQUNsRCxVQUFJLFVBQVU7QUFDWixpQkFBUyxRQUFRLFdBQVcsR0FBRyxPQUFPO0FBQUEsTUFDeEM7QUFDQTtBQUFBLElBQ0Y7QUFFQSxRQUFJLFNBQVMsZUFBZSxTQUFTLEVBQUc7QUFFeEMsVUFBTSxVQUFVLFNBQVMsY0FBYyxLQUFLO0FBQzVDLFlBQVEsWUFBWTtBQUNwQixZQUFRLEtBQUs7QUFFYixVQUFNLE9BQU8sU0FBUyxjQUFjLEdBQUc7QUFDdkMsU0FBSyxPQUFPO0FBQ1osU0FBSyxZQUFZO0FBQ2pCLFNBQUssWUFBWTtBQUNqQixTQUFLLGlCQUFpQixTQUFTLGFBQWE7QUFDNUMsWUFBUSxZQUFZLElBQUk7QUFFeEIsVUFBTSxZQUFZLFNBQVMsY0FBYyxhQUFhO0FBQ3RELFFBQUksV0FBVztBQUNiLGdCQUFVLFlBQVksT0FBTztBQUFBLElBQy9CO0FBQUEsRUFDRjs7O0FDbEhBLFdBQVMsT0FBYTtBQUNwQixZQUFRLElBQUksNEJBQTRCO0FBRXhDLCtCQUEyQjtBQUMzQixzQkFBa0I7QUFDbEIscUJBQWlCLE1BQU0sS0FBSyxVQUFVLENBQUM7QUFBQSxFQUN6QztBQUVBLE1BQUksU0FBUyxlQUFlLFdBQVc7QUFDckMsYUFBUyxpQkFBaUIsb0JBQW9CLElBQUk7QUFBQSxFQUNwRCxPQUFPO0FBQ0wsU0FBSztBQUFBLEVBQ1A7IiwKICAibmFtZXMiOiBbImtHYW1lcyIsICJlbG8iLCAiZWxvIiwgImJhdHRsZXMiLCAiYmF0dGxlcyIsICJvcHRpb25zIiwgIk1PREVTIiwgIm9wdGlvbnMiLCAicnVubmluZyIsICJlbG9MaW5lIiwgImFmdGVyU2V0dXAiLCAibW9kYWxDb250ZW50Il0KfQo=
