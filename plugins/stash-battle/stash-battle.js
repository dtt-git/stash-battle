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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL2NvbnN0YW50cy50cyIsICIuLi8uLi9zcmMvZWxvLnRzIiwgIi4uLy4uL3NyYy9zY29yZS50cyIsICIuLi8uLi9zcmMvZ3JhcGhxbC50cyIsICIuLi8uLi9zcmMvdWkvZGVsZXRlRGlhbG9nLnRzIiwgIi4uLy4uL3NyYy9maWx0ZXJzLnRzIiwgIi4uLy4uL3NyYy9zdGF0ZS50cyIsICIuLi8uLi9zcmMvY2FjaGUudHMiLCAiLi4vLi4vc3JjL3NjZW5lQWN0aW9ucy50cyIsICIuLi8uLi9zcmMvcmF0aW5nLnRzIiwgIi4uLy4uL3NyYy9lbG9TZXR1cC50cyIsICIuLi8uLi9zcmMvc2V0dGluZ3MudHMiLCAiLi4vLi4vc3JjL3N0b3JhZ2UudHMiLCAiLi4vLi4vc3JjL3VpL2NvbmZpcm1EaWFsb2cudHMiLCAiLi4vLi4vc3JjL25hdmlnYXRpb24udHMiLCAiLi4vLi4vc3JjL3BsYWNlbWVudC50cyIsICIuLi8uLi9zcmMvcGFpcnMudHMiLCAiLi4vLi4vc3JjL3N0YXRzLnRzIiwgIi4uLy4uL3NyYy91aS9zY2VuZVRpdGxlLnRzIiwgIi4uLy4uL3NyYy91aS9zY2VuZUNhcmQudHMiLCAiLi4vLi4vc3JjL3VpL3NjcmVlbnMudHMiLCAiLi4vLi4vc3JjL3VpL3N0YXNoUmF0aW5nc1RleHQudHMiLCAiLi4vLi4vc3JjL3VpL3NldHRpbmdzUGFuZWwudHMiLCAiLi4vLi4vc3JjL3VpL21haW5VSS50cyIsICIuLi8uLi9zcmMvdWkvaWNvbnMudHMiLCAiLi4vLi4vc3JjL3VpL3NjZW5lRWxvLnRzIiwgIi4uLy4uL3NyYy91aS9yYXRpbmdQcmV2aWV3LnRzIiwgIi4uLy4uL3NyYy91aS9zZXR1cFNjcmVlbi50cyIsICIuLi8uLi9zcmMvdWkvbW9kYWwudHMiLCAiLi4vLi4vc3JjL3VpL25hdkJ1dHRvbi50cyIsICIuLi8uLi9zcmMvbWFpbi50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUGx1Z2luLXdpZGUgY29uc3RhbnRzLlxuXG5leHBvcnQgY29uc3QgU1RPUkFHRV9LRVkgPSBcInN0YXNoLWJhdHRsZS1zdGF0ZVwiO1xuZXhwb3J0IGNvbnN0IENBQ0hFX0RCX05BTUUgPSBcInN0YXNoLWJhdHRsZS1jYWNoZVwiO1xuLyoqIDIgKDMuMCk6IGNhY2hlZCBzY2VuZXMgZnJvbSBiZWZvcmUgbmVlZCBjdXN0b21fZmllbGRzIGFuZCBFTE8gb3JkZXIsIHNvIHRoZSBzdG9yZSBpcyBjbGVhcmVkLiAqL1xuZXhwb3J0IGNvbnN0IENBQ0hFX0RCX1ZFUlNJT04gPSAyO1xuZXhwb3J0IGNvbnN0IENBQ0hFX1NUT1JFX05BTUUgPSBcInNjZW5lc1wiO1xuZXhwb3J0IGNvbnN0IENBQ0hFX01BWF9BR0VfTVMgPSA1ICogNjAgKiAxMDAwOyAvLyA1IG1pbnV0ZXMgY2FjaGUgZXhwaXJ5XG5cbmltcG9ydCB0eXBlIHsgU2V0dGluZ3MsIFRpZXIgfSBmcm9tIFwiLi90eXBlc1wiO1xuXG4vKiogUGx1Z2luIGlkIChmb2xkZXIgbmFtZSkg4oCUIGtleSBmb3IgdGhpcyBwbHVnaW4ncyBzZXR0aW5ncyBpbiBTdGFzaCdzIGNvbmZpZ3VyYXRpb24uICovXG5leHBvcnQgY29uc3QgUExVR0lOX0lEID0gXCJzdGFzaC1iYXR0bGVcIjtcblxuZXhwb3J0IGNvbnN0IERFRkFVTFRfU0VUVElOR1M6IFNldHRpbmdzID0ge1xuICBzdGFzaFJhdGluZ3M6IFwib2ZmXCIsXG4gIGVsb1NldHVwQXQ6IG51bGwsXG4gIGVsb1NldHVwTW9kZTogbnVsbCxcbiAgb3BlbkluTmV3VGFiOiBmYWxzZSxcbiAgcGxhY2VtZW50RnJvbUJvdHRvbTogZmFsc2UsXG4gIHNob3dUaWVyczogdHJ1ZSxcbiAgcHJldmlld1ZvbHVtZTogNTAsXG4gIGF1dG9wbGF5UHJldmlld3M6IHRydWUsXG4gIGZpbHRlck9wcG9uZW50czogZmFsc2UsXG4gIGNsZWFuTW9kZTogZmFsc2UsXG4gIHBhdXNlTWVkaWFPbk9wZW46IHRydWUsXG59O1xuXG4vLyBQcmUtMi43IGxvY2FsU3RvcmFnZSBwcmVmZXJlbmNlIGtleXMgKG1pZ3JhdGVkIGludG8gcGx1Z2luIHNldHRpbmdzKS5cbmV4cG9ydCBjb25zdCBMRUdBQ1lfRklMVEVSX09QUE9ORU5UU19LRVkgPSBcInNiX2ZpbHRlck9wcG9uZW50c1wiO1xuZXhwb3J0IGNvbnN0IExFR0FDWV9NVVRFX1BSRVZJRVdTX0tFWSA9IFwic2JfbXV0ZVByZXZpZXdzXCI7XG5cbi8qKlxuICogU3dpc3M6IHRoZSBvcHBvbmVudCBpcyBwaWNrZWQgYXQgcmFuZG9tIGZyb20gZXZlcnkgc2NlbmUgd2l0aGluIMKxdGhpcyBFTE8gKHdpbiBjaGFuY2VzIGJldHdlZW5cbiAqIDM2JSBhbmQgNjQlKS4gQSBwaWNrIHRoYXQgY2xvc2Ugc3RpbGwgdGVsbHMgb3ZlciA5MCUgb2Ygd2hhdCBhIDUwLzUwIG9uZSBkb2VzLCBhbmQgYSBzY2VuZSBtZWV0c1xuICogZmFyIG1vcmUgdmFyaWVkIG9wcG9uZW50cyB0aGFuIGEgd2luZG93IG9mIG5lYXJieSByYW5rcywgd2hpY2ggb24gYSBzZWVkZWQgbGlicmFyeSBpcyBtb3N0bHlcbiAqIHRpZXMuXG4gKi9cbmV4cG9ydCBjb25zdCBTV0lTU19PUFBPTkVOVF9FTE9fV0lORE9XID0gMTAwO1xuLyoqIFN3aXNzOiB3aGVuIGZld2VyIHNjZW5lcyB0aGFuIHRoaXMgYXJlIGluIHRoZSB3aW5kb3cgKHRvcCwgYm90dG9tLCBzbWFsbCBwb29scyksIHRha2UgdGhpcyBtYW55IG5lYXJlc3QuICovXG5leHBvcnQgY29uc3QgU1dJU1NfT1BQT05FTlRfTUlOX0NBTkRJREFURVMgPSAxMDtcblxuLy8gQ2hhbXBpb246IHJhbmRvbSBwaWNrIGFtb25nIHRoZSBOIGNsb3Nlc3QgdW5kZWZlYXRlZCBvcHBvbmVudHMgYWJvdmUgdGhlIGNoYW1waW9uLlxuZXhwb3J0IGNvbnN0IENMSU1CX09QUE9ORU5UX1BJQ0tfV0lORE9XID0gNTtcblxuLyoqXG4gKiBFTE8gYW4gdW5yYXRlZCBzY2VuZSBjb3VudHMgYXMgaW4gQ2hhbXBpb246IDEwMDAsIHRoZSBib3R0b20gKHdoYXQgYSAwIHJhdGluZyBzZWVkcyB0byksIHNvIGFcbiAqIG5ld2NvbWVyIGNsaW1icyBmcm9tIHRoZXJlIGFzIGJlZm9yZS4gU3dpc3MgY291bnRzIHVucmF0ZWQgc2NlbmVzIGFzIEVMT19TVEFSVCAoMTUwMCkuXG4gKi9cbmV4cG9ydCBjb25zdCBDSEFNUElPTl9VTlJBVEVEX0VMTyA9IDEwMDA7XG5cbi8qKlxuICogQSBwaWNrIGlzIGFuIFwiVXBzZXQhXCIgd2hlbiB0aGUgd2lubmVyJ3Mgd2luIGNoYW5jZSAoYXMgc2hvd24sIGluICUpIHdhcyBhdCBtb3N0IHRoaXM6IGFib3V0IDcwXG4gKiBFTE8gYmVsb3cgaXRzIG9wcG9uZW50LiBTd2lzcyBvcHBvbmVudHMgYXJlIHdpdGhpbiDCsTEwMCwgc28gYWJvdXQgMSBwaWNrIGluIDcgaWYgRUxPIGlzIHJpZ2h0LlxuICovXG5leHBvcnQgY29uc3QgVVBTRVRfTUFYX0NIQU5DRSA9IDQwO1xuXG4vKiogU2hvdyBhIFVJIHdhcm5pbmcgd2hlbiBDaGFtcGlvbidzIG9wcG9uZW50IHBvb2wgaXMgc21hbGxlciB0aGFuIHRoaXMgKGZpbHRlciBvcHBvbmVudHMgb24pLiAqL1xuZXhwb3J0IGNvbnN0IENMSU1CX1NNQUxMX1BPT0xfV0FSTl9BVCA9IDEwO1xuXG4vLyAtLS0gVHJ1ZSBFTE8gKHN0b3JlZCBpbiBzY2VuZSBjdXN0b20gZmllbGRzKSAtLS1cblxuLyoqIFNjZW5lIGN1c3RvbSBmaWVsZCBrZXlzLiBXcml0ZXMgdXNlIGBwYXJ0aWFsYCwgc28gb3RoZXIgcGx1Z2lucycgZmllbGRzIGFyZSBuZXZlciB0b3VjaGVkLiAqL1xuZXhwb3J0IGNvbnN0IEVMT19GSUVMRCA9IFwic3Rhc2hfYmF0dGxlX2Vsb1wiO1xuLyoqIFJlYWwgYmF0dGxlcyB0aGF0IG1vdmVkIHRoaXMgc2NlbmUncyBFTE8gKFBsYWNlbWVudCBhZGRzIGl0cyBydW4ncyBiYXR0bGVzIHdoZW4gdGhlIHNjZW5lIGxhbmRzKS4gKi9cbmV4cG9ydCBjb25zdCBCQVRUTEVTX0ZJRUxEID0gXCJzdGFzaF9iYXR0bGVfYmF0dGxlc1wiO1xuLyoqIFRydWUgd2hlbiB0aGUgc2NlbmUncyBzdGFydGluZyBFTE8gY2FtZSBmcm9tIGl0cyBTdGFzaCByYXRpbmcgKHNldHVwJ3MgXCJVc2UgbXkgcmF0aW5nc1wiKS4gKi9cbmV4cG9ydCBjb25zdCBTRUVERURfRklFTEQgPSBcInN0YXNoX2JhdHRsZV9zZWVkZWRcIjtcbi8qKiBBbGwgb2YgU3Rhc2ggQmF0dGxlJ3MgcGVyLXNjZW5lIGZpZWxkcyAocmVtb3ZlZCB0b2dldGhlciB3aGVuIGEgc2NlbmUgYmVjb21lcyB1bnJhdGVkKS4gKi9cbmV4cG9ydCBjb25zdCBFTE9fRklFTERfS0VZUyA9IFtFTE9fRklFTEQsIEJBVFRMRVNfRklFTEQsIFNFRURFRF9GSUVMRF07XG5cbmV4cG9ydCBjb25zdCBFTE9fU1RBUlQgPSAxNTAwO1xuZXhwb3J0IGNvbnN0IEVMT19ESVZJU09SID0gNDAwO1xuXG4vKiogSyBieSBLLWdhbWVzIChiYXR0bGVzLCBwbHVzIHRoZSBoZWFkIHN0YXJ0IGlmIHNlZWRlZCk6IFtiZWxvdyB0aGlzIGNvdW50LCBLXTsgdGhlIGxhc3QgaGFzIG5vIGxpbWl0LiAqL1xuZXhwb3J0IGNvbnN0IEVMT19LX1RJRVJTOiByZWFkb25seSAocmVhZG9ubHkgW251bWJlciwgbnVtYmVyXSlbXSA9IFtcbiAgWzEwLCA0MF0sXG4gIFszMCwgMjRdLFxuICBbSW5maW5pdHksIDE2XSxcbl07XG5cbi8qKlxuICogVGllcnMgKFwiU2hvdyB0aWVycyBvbiBjYXJkc1wiKSwgYmVzdCBmaXJzdCwgYnkgcmFuayBhbW9uZyB0aGUgbGlicmFyeSdzIHNldHRsZWQgc2NlbmVzOiBhIHNjZW5lXG4gKiB3aG9zZSByYW5rIGlzIHdpdGhpbiB0aGUgdG9wIGB0b3BgIHNoYXJlIGdldHMgdGhlIGZpcnN0IHRpZXIgdGhhdCBmaXRzLiBFdmVyeSB0aWVyIGFsd2F5cyBoYXNcbiAqIHNjZW5lcyBpbiBpdCwgd2hhdGV2ZXIgdGhlIGxpYnJhcnkncyBFTE8gc3ByZWFkLiBUaGUgbGFzdCB0aWVyIHRha2VzIGV2ZXJ5b25lIGVsc2UuXG4gKi9cbmV4cG9ydCBjb25zdCBUSUVSUzogcmVhZG9ubHkgVGllcltdID0gW1xuICB7IGlkOiBcImxlZ2VuZGFyeVwiLCBuYW1lOiBcIkxlZ2VuZGFyeVwiLCBlbW9qaTogXCLwn5GRXCIsIHRvcDogMC4wMSB9LFxuICB7IGlkOiBcImRpYW1vbmRcIiwgbmFtZTogXCJEaWFtb25kXCIsIGVtb2ppOiBcIvCfko5cIiwgdG9wOiAwLjA1IH0sXG4gIHsgaWQ6IFwicGxhdGludW1cIiwgbmFtZTogXCJQbGF0aW51bVwiLCBlbW9qaTogXCLwn5S3XCIsIHRvcDogMC4xNSB9LFxuICB7IGlkOiBcImdvbGRcIiwgbmFtZTogXCJHb2xkXCIsIGVtb2ppOiBcIvCfpYdcIiwgdG9wOiAwLjM1IH0sXG4gIHsgaWQ6IFwic2lsdmVyXCIsIG5hbWU6IFwiU2lsdmVyXCIsIGVtb2ppOiBcIvCfpYhcIiwgdG9wOiAwLjY1IH0sXG4gIHsgaWQ6IFwiYnJvbnplXCIsIG5hbWU6IFwiQnJvbnplXCIsIGVtb2ppOiBcIvCfpYlcIiwgdG9wOiAxIH0sXG5dO1xuXG4vKipcbiAqIEVMTyBwb2ludHMgcGVyIDEtMTAwIHJhdGluZyBwb2ludC4gVGhlIHByZS0zLjAgbWF0aCBkaXZpZGVkIGJ5IDQwIG9uIHRoZSAxLTEwMCBzY2FsZSwgc28gb25lXG4gKiByYXRpbmcgcG9pbnQgYWxyZWFkeSBtZWFudCBleGFjdGx5IDEwIHN0YW5kYXJkIChkaXZpc29yIDQwMCkgRUxPIHBvaW50cy5cbiAqL1xuZXhwb3J0IGNvbnN0IEVMT19QRVJfUkFUSU5HX1BPSU5UID0gMTA7XG5cbi8qKlxuICogSGVhZCBzdGFydCAoY291bnRlZCBhcyBiYXR0bGVzIGZvciBLIG9ubHkpIGZvciBzY2VuZXMgc2VlZGVkIGZyb20gdGhlaXIgU3Rhc2ggcmF0aW5nOiB0aGVpclxuICogcmF0aW5nIGFscmVhZHkgc2F5cyBzb21ldGhpbmcsIHNvIHRoZXkgc2tpcCB0aGUgYmlnZ2VzdCBzd2luZ3MuIENoYW5naW5nIGl0IGFwcGxpZXMgdG8gZXZlcnlcbiAqIHNlZWRlZCBzY2VuZSBhdCBvbmNlLCBiZWNhdXNlIGl0IGlzbid0IHN0b3JlZC5cbiAqL1xuZXhwb3J0IGNvbnN0IFNFRURFRF9IRUFEX1NUQVJUID0gMTA7XG5cbi8qKiBFTE8gZ2FwIGFib3ZlIHRoZSB0b3AgLyBiZWxvdyB0aGUgYm90dG9tIHNjZW5lIHdoZW4gUGxhY2VtZW50IGxhbmRzIGEgc2NlbmUgYXQgYW4gZWRnZS4gKi9cbmV4cG9ydCBjb25zdCBQTEFDRU1FTlRfRURHRV9HQVAgPSAyNTtcblxuLyoqXG4gKiBQbGFjZW1lbnQncyBkb3VibGluZyBqdW1wcyBhcmUgY2FwcGVkIGF0IHRoaXMgc2hhcmUgb2YgdGhlIHBvb2wgKGJ1dCBhdCBsZWFzdFxuICogUExBQ0VNRU5UX01JTl9NQVhfSlVNUCByYW5rcyksIHNvIGEgd2lubmluZyBzdHJlYWsgY2xpbWJzIGluc3RlYWQgb2YgbGVhcGluZyB0byAjMS4gSW4gYVxuICogNjAwLXNjZW5lIGxpYnJhcnk6IGF0IG1vc3QgNjAgcmFua3MgcGVyIGp1bXAsIGFib3V0IG9uZSBleHRyYSBiYXR0bGUgb24gYXZlcmFnZS5cbiAqL1xuZXhwb3J0IGNvbnN0IFBMQUNFTUVOVF9NQVhfSlVNUF9TSEFSRSA9IDAuMTtcbmV4cG9ydCBjb25zdCBQTEFDRU1FTlRfTUlOX01BWF9KVU1QID0gNDtcbiIsICIvLyBFTE8gbWF0aCAocHVyZSBjYWxjdWxhdGlvbnM6IGNhbGxlcnMgYXBwbHkgdGhlIHJlc3VsdHMgYW5kIHBlcnNpc3QgdGhlbSkuXG5cbmltcG9ydCB7IEVMT19ESVZJU09SLCBFTE9fS19USUVSUyB9IGZyb20gXCIuL2NvbnN0YW50c1wiO1xuXG4vKiogSyBmb3IgYSBzY2VuZSB3aXRoIHRoaXMgbWFueSBLLWdhbWVzIChzZWUga0dhbWVzKTogbmV3IHNjZW5lcyBtb3ZlIGEgbG90LCBlc3RhYmxpc2hlZCBvbmVzIGxpdHRsZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlbG9LRmFjdG9yKGtHYW1lczogbnVtYmVyKTogbnVtYmVyIHtcbiAgZm9yIChjb25zdCBbYmVsb3csIGtdIG9mIEVMT19LX1RJRVJTKSB7XG4gICAgaWYgKGtHYW1lcyA8IGJlbG93KSByZXR1cm4gaztcbiAgfVxuICByZXR1cm4gRUxPX0tfVElFUlNbRUxPX0tfVElFUlMubGVuZ3RoIC0gMV1bMV07XG59XG5cbi8qKiBQcm9iYWJpbGl0eSB0aGF0IGEgc2NlbmUgcmF0ZWQgYGVsb2AgYmVhdHMgb25lIHJhdGVkIGBvcHBvbmVudEVsb2AuICovXG5leHBvcnQgZnVuY3Rpb24gZWxvRXhwZWN0ZWQoZWxvOiBudW1iZXIsIG9wcG9uZW50RWxvOiBudW1iZXIpOiBudW1iZXIge1xuICByZXR1cm4gMSAvICgxICsgTWF0aC5wb3coMTAsIChvcHBvbmVudEVsbyAtIGVsbykgLyBFTE9fRElWSVNPUikpO1xufVxuXG4vKipcbiAqIEJvdGggc2lkZXMnIHdpbiBjaGFuY2VzIGFzIHdob2xlIHBlcmNlbnRhZ2VzIHRoYXQgYWx3YXlzIGFkZCB1cCB0byAxMDAsIGtlcHQgd2l0aGluIDEtOTkgKGFcbiAqIFwiMTAwJVwiIHdvdWxkIHJlYWQgYXMgYSBzdXJlIHRoaW5nLCBhbmQgRUxPIG5ldmVyIGlzKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdpbkNoYW5jZXMoZWxvOiBudW1iZXIsIG9wcG9uZW50RWxvOiBudW1iZXIpOiBbbnVtYmVyLCBudW1iZXJdIHtcbiAgY29uc3QgZmlyc3QgPSBNYXRoLm1pbig5OSwgTWF0aC5tYXgoMSwgTWF0aC5yb3VuZChlbG9FeHBlY3RlZChlbG8sIG9wcG9uZW50RWxvKSAqIDEwMCkpKTtcbiAgcmV0dXJuIFtmaXJzdCwgMTAwIC0gZmlyc3RdO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEVsb1NpZGUge1xuICBlbG86IG51bWJlcjtcbiAgLyoqIEJhdHRsZXMgcGx1cyBhbnkgc2VlZGVkIGhlYWQgc3RhcnQgKHNjb3JlLnRzIGtHYW1lcyk6IHNldHMgdGhpcyBzaWRlJ3MgSy4gKi9cbiAga0dhbWVzOiBudW1iZXI7XG59XG5cbi8qKiBTdG9yZWQgRUxPIHByZWNpc2lvbiAob25lIGRlY2ltYWwpLCBzbyBzbWFsbCBsYXRlLWNhcmVlciBjaGFuZ2VzIGFyZW4ndCByb3VuZGVkIGF3YXkuICovXG5leHBvcnQgZnVuY3Rpb24gcm91bmRFbG8oZWxvOiBudW1iZXIpOiBudW1iZXIge1xuICByZXR1cm4gTWF0aC5yb3VuZChlbG8gKiAxMCkgLyAxMDtcbn1cblxuLyoqXG4gKiBUd28tc2lkZWQgRUxPIGZvciBhIGhlYWQtdG8taGVhZCB3aW47IGVhY2ggc2lkZSB1c2VzIGl0cyBvd24gSy4gUmV0dXJucyB0aGUgbmV3IEVMT3MuXG4gKiBFYWNoIHNpZGUgbW92ZXMgYnkgSyDDlyAoYWN0dWFsIOKIkiBleHBlY3RlZCk6IHRoZSB3aW5uZXIgYnkgSyDDlyAoMSDiiJIgaXRzIHdpbiBjaGFuY2UpLCB0aGUgbG9zZXJcbiAqIGJ5IEsgw5cgKDAg4oiSIGl0cyBvd24gd2luIGNoYW5jZSksIHdoaWNoIGlzIHRoZSBzYW1lIDEg4oiSIHdpbm5lcidzIGNoYW5jZS4gV2l0aCBlcXVhbCBLIHRoZVxuICogcG9pbnRzIGFyZSBleGFjdGx5IHplcm8tc3VtLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZWxvUmVzdWx0KHdpbm5lcjogRWxvU2lkZSwgbG9zZXI6IEVsb1NpZGUpOiB7IHdpbm5lcjogbnVtYmVyOyBsb3NlcjogbnVtYmVyIH0ge1xuICBjb25zdCBzdXJwcmlzZSA9IDEgLSBlbG9FeHBlY3RlZCh3aW5uZXIuZWxvLCBsb3Nlci5lbG8pO1xuICByZXR1cm4ge1xuICAgIHdpbm5lcjogcm91bmRFbG8od2lubmVyLmVsbyArIGVsb0tGYWN0b3Iod2lubmVyLmtHYW1lcykgKiBzdXJwcmlzZSksXG4gICAgbG9zZXI6IHJvdW5kRWxvKGxvc2VyLmVsbyAtIGVsb0tGYWN0b3IobG9zZXIua0dhbWVzKSAqIHN1cnByaXNlKSxcbiAgfTtcbn1cbiIsICIvLyBBIHNjZW5lJ3MgRUxPIChyZWFkIGZyb20gaXRzIGN1c3RvbSBmaWVsZHMpLCBFTE8gb3JkZXJpbmcsIGFuZCBjb252ZXJzaW9ucyBiZXR3ZWVuIEVMTyBhbmRcbi8vIFN0YXNoJ3MgMS0xMDAgcmF0aW5nLiBQdXJlIGZ1bmN0aW9uczogbm8gc3RhdGUsIG5vIEkvTy5cblxuaW1wb3J0IHtcbiAgQkFUVExFU19GSUVMRCxcbiAgRUxPX0ZJRUxELFxuICBFTE9fRklFTERfS0VZUyxcbiAgRUxPX0tfVElFUlMsXG4gIEVMT19QRVJfUkFUSU5HX1BPSU5ULFxuICBFTE9fU1RBUlQsXG4gIFBMQUNFTUVOVF9FREdFX0dBUCxcbiAgU0VFREVEX0ZJRUxELFxuICBTRUVERURfSEVBRF9TVEFSVCxcbn0gZnJvbSBcIi4vY29uc3RhbnRzXCI7XG5pbXBvcnQgeyByb3VuZEVsbyB9IGZyb20gXCIuL2Vsb1wiO1xuaW1wb3J0IHR5cGUgeyBFbG9GaWVsZHMsIEVsb1N0YXJ0LCBTY2VuZSwgU3Rhc2hSYXRpbmdzTW9kZSB9IGZyb20gXCIuL3R5cGVzXCI7XG5cbi8qKiBDdXN0b20gZmllbGQgdmFsdWVzIHNob3VsZCBjb21lIGJhY2sgYXMgbnVtYmVyczsgbnVtZXJpYyBzdHJpbmdzIGFyZSBhY2NlcHRlZCB0b28uICovXG5mdW5jdGlvbiByZWFkTnVtYmVyKHZhbHVlOiB1bmtub3duKTogbnVtYmVyIHwgbnVsbCB7XG4gIGlmICh0eXBlb2YgdmFsdWUgPT09IFwibnVtYmVyXCIpIHJldHVybiBOdW1iZXIuaXNGaW5pdGUodmFsdWUpID8gdmFsdWUgOiBudWxsO1xuICBpZiAodHlwZW9mIHZhbHVlID09PSBcInN0cmluZ1wiICYmIHZhbHVlLnRyaW0oKSAhPT0gXCJcIikge1xuICAgIGNvbnN0IG4gPSBOdW1iZXIodmFsdWUpO1xuICAgIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobikgPyBuIDogbnVsbDtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqIFRoZSBzY2VuZSdzIHN0b3JlZCBFTE8sIG9yIG51bGwgd2hlbiBpdCBoYXMgbm9uZSAodW5yYXRlZCkuICovXG5leHBvcnQgZnVuY3Rpb24gZWxvKHNjZW5lOiBTY2VuZSk6IG51bWJlciB8IG51bGwge1xuICByZXR1cm4gcmVhZE51bWJlcihzY2VuZS5jdXN0b21fZmllbGRzPy5bRUxPX0ZJRUxEXSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpc1JhdGVkKHNjZW5lOiBTY2VuZSk6IGJvb2xlYW4ge1xuICByZXR1cm4gZWxvKHNjZW5lKSAhPT0gbnVsbDtcbn1cblxuLyoqIFJlYWwgYmF0dGxlcyB0aGF0IG1vdmVkIHRoZSBzY2VuZSdzIEVMTy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBiYXR0bGVzKHNjZW5lOiBTY2VuZSk6IG51bWJlciB7XG4gIGNvbnN0IG4gPSByZWFkTnVtYmVyKHNjZW5lLmN1c3RvbV9maWVsZHM/LltCQVRUTEVTX0ZJRUxEXSk7XG4gIHJldHVybiBuICE9PSBudWxsICYmIG4gPiAwID8gTWF0aC5mbG9vcihuKSA6IDA7XG59XG5cbi8qKiBUaGUgc2NlbmUncyBzdGFydGluZyBFTE8gY2FtZSBmcm9tIGl0cyBTdGFzaCByYXRpbmcuIChTdGFzaCBzdG9yZXMgYHRydWVgIGFzIDEuKSAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzU2VlZGVkKHNjZW5lOiBTY2VuZSk6IGJvb2xlYW4ge1xuICBjb25zdCB2YWx1ZSA9IHNjZW5lLmN1c3RvbV9maWVsZHM/LltTRUVERURfRklFTERdO1xuICByZXR1cm4gdmFsdWUgPT09IHRydWUgfHwgdmFsdWUgPT09IDEgfHwgdmFsdWUgPT09IFwidHJ1ZVwiIHx8IHZhbHVlID09PSBcIjFcIjtcbn1cblxuLyoqIFRoZSBjb3VudCBLIGlzIGJhc2VkIG9uOiByZWFsIGJhdHRsZXMsIHBsdXMgdGhlIGhlYWQgc3RhcnQgZm9yIHNlZWRlZCBzY2VuZXMuICovXG5leHBvcnQgZnVuY3Rpb24ga0dhbWVzKHNjZW5lOiBTY2VuZSk6IG51bWJlciB7XG4gIHJldHVybiBiYXR0bGVzKHNjZW5lKSArIChpc1NlZWRlZChzY2VuZSkgPyBTRUVERURfSEVBRF9TVEFSVCA6IDApO1xufVxuXG4vKipcbiAqIFRoZSBzY2VuZSdzIEVMTyBpcyBzdGlsbCBzZXR0bGluZzogaXQgaGFzIGZld2VyIEstZ2FtZXMgdGhhbiB0aGUgZmlyc3QgSyB0aWVyJ3MgbGltaXQgKDEwKSwgdGhlXG4gKiBzdGFnZSB3aGVyZSBlYWNoIGJhdHRsZSBtb3ZlcyBpdCB0aGUgbW9zdC4gU2VlZGVkIHNjZW5lcyBzdGFydCBwYXN0IGl0OyB1bnJhdGVkIG9uZXMgYXJlbid0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNQcm92aXNpb25hbChzY2VuZTogU2NlbmUpOiBib29sZWFuIHtcbiAgcmV0dXJuIGlzUmF0ZWQoc2NlbmUpICYmIGtHYW1lcyhzY2VuZSkgPCBFTE9fS19USUVSU1swXVswXTtcbn1cblxuLyoqIEVsb0ZpZWxkcyBhcyB0aGUgY3VzdG9tIGZpZWxkcyBtYXAgU3Rhc2ggc3RvcmVzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVsb0N1c3RvbUZpZWxkcyh2YWx1ZTogRWxvRmllbGRzKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICByZXR1cm4geyBbRUxPX0ZJRUxEXTogdmFsdWUuZWxvLCBbQkFUVExFU19GSUVMRF06IHZhbHVlLmJhdHRsZXMsIFtTRUVERURfRklFTERdOiB2YWx1ZS5zZWVkZWQgfTtcbn1cblxuLyoqIFN0YXJ0aW5nIEVMTyBmb3IgYSAxLTEwMCBTdGFzaCByYXRpbmc6IDUwIGlzIDE1MDAsIHNvIDEtMTAwIG1hcHMgb250byAxMDEwLTIwMDAuICovXG5leHBvcnQgZnVuY3Rpb24gc2VlZChyYXRpbmcxMDA6IG51bWJlcik6IG51bWJlciB7XG4gIHJldHVybiBFTE9fU1RBUlQgKyAocmF0aW5nMTAwIC0gNTApICogRUxPX1BFUl9SQVRJTkdfUE9JTlQ7XG59XG5cbi8qKiBFTE8gdXNlZCBpbiBiYXR0bGUgbWF0aDogdGhlIHN0b3JlZCBFTE8sIG9yIGB1bnJhdGVkRWxvYCBmb3IgdW5yYXRlZCBzY2VuZXMgKDE1MDAgYnkgZGVmYXVsdCkuICovXG5leHBvcnQgZnVuY3Rpb24gZWZmZWN0aXZlRWxvKHNjZW5lOiBTY2VuZSwgdW5yYXRlZEVsbzogbnVtYmVyID0gRUxPX1NUQVJUKTogbnVtYmVyIHtcbiAgcmV0dXJuIGVsbyhzY2VuZSkgPz8gdW5yYXRlZEVsbztcbn1cblxuLyoqIFN0cmFpZ2h0LWxpbmUgU3Rhc2ggcmF0aW5nOiB0aGUgaW52ZXJzZSBvZiBzZWVkKCksIGNsYW1wZWQgdG8gMS0xMDAuICovXG5leHBvcnQgZnVuY3Rpb24gbGluZWFyUmF0aW5nKGVsb1ZhbHVlOiBudW1iZXIpOiBudW1iZXIge1xuICBjb25zdCByYXRpbmcgPSBNYXRoLnJvdW5kKDUwICsgKGVsb1ZhbHVlIC0gRUxPX1NUQVJUKSAvIEVMT19QRVJfUkFUSU5HX1BPSU5UKTtcbiAgcmV0dXJuIE1hdGgubWluKDEwMCwgTWF0aC5tYXgoMSwgcmF0aW5nKSk7XG59XG5cbi8qKlxuICogUGVyY2VudGlsZSBTdGFzaCByYXRpbmdzIGZvciBldmVyeSBzY2VuZSB3aXRoIGFuIEVMTzogdGhlIHRvcCBzY2VuZSBpcyAxMDAsIHRoZSBib3R0b20gMSxcbiAqIGV2ZW5seSBzcGFjZWQgYnkgcmFuay4gVGllZCBzY2VuZXMgc2hhcmUgdGhlIG1pZGRsZSBwb3NpdGlvbiBvZiB0aGVpciB0aWUgZ3JvdXAsIHNvIGEgZnVsbHlcbiAqIHRpZWQgbGlicmFyeSBpcyA1MCBldmVyeXdoZXJlLiBVbnJhdGVkIHNjZW5lcyBhcmUgbGVmdCBvdXQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwZXJjZW50aWxlUmF0aW5ncyhzY2VuZXM6IFNjZW5lW10pOiBNYXA8c3RyaW5nLCBudW1iZXI+IHtcbiAgY29uc3QgcmF0ZWQgPSBzY2VuZXNcbiAgICAubWFwKChzY2VuZSkgPT4gKHsgaWQ6IHNjZW5lLmlkLCBlbG86IGVsbyhzY2VuZSkgfSkpXG4gICAgLmZpbHRlcigocyk6IHMgaXMgeyBpZDogc3RyaW5nOyBlbG86IG51bWJlciB9ID0+IHMuZWxvICE9PSBudWxsKVxuICAgIC5zb3J0KChhLCBiKSA9PiBiLmVsbyAtIGEuZWxvKTtcblxuICBjb25zdCByYXRpbmdzID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgY29uc3QgbiA9IHJhdGVkLmxlbmd0aDtcbiAgaWYgKG4gPT09IDEpIHtcbiAgICByYXRpbmdzLnNldChyYXRlZFswXS5pZCwgNTApO1xuICAgIHJldHVybiByYXRpbmdzO1xuICB9XG5cbiAgbGV0IHN0YXJ0ID0gMDtcbiAgd2hpbGUgKHN0YXJ0IDwgbikge1xuICAgIGxldCBlbmQgPSBzdGFydDtcbiAgICB3aGlsZSAoZW5kICsgMSA8IG4gJiYgcmF0ZWRbZW5kICsgMV0uZWxvID09PSByYXRlZFtzdGFydF0uZWxvKSBlbmQrKztcbiAgICAvLyBSb3VuZGluZyBpbnNpZGUga2VlcHMgYSB0aWUgYXQgdGhlIGV4YWN0IG1pZGRsZSBvbiA1MCByYXRoZXIgdGhhbiA1MVxuICAgIGNvbnN0IHJhdGluZyA9IDEwMCAtIE1hdGgucm91bmQoKDk5ICogKChzdGFydCArIGVuZCkgLyAyKSkgLyAobiAtIDEpKTtcbiAgICBmb3IgKGxldCBpID0gc3RhcnQ7IGkgPD0gZW5kOyBpKyspIHJhdGluZ3Muc2V0KHJhdGVkW2ldLmlkLCByYXRpbmcpO1xuICAgIHN0YXJ0ID0gZW5kICsgMTtcbiAgfVxuICByZXR1cm4gcmF0aW5ncztcbn1cblxuLyoqIFRhcmdldCBTdGFzaCByYXRpbmcgZm9yIGV2ZXJ5IHNjZW5lIHdpdGggYW4gRUxPLCB1bmRlciB0aGUgZ2l2ZW4gbW9kZSAobm9uZSBmb3IgXCJvZmZcIikuICovXG5leHBvcnQgZnVuY3Rpb24gc3Rhc2hSYXRpbmdUYXJnZXRzKHNjZW5lczogU2NlbmVbXSwgbW9kZTogU3Rhc2hSYXRpbmdzTW9kZSk6IE1hcDxzdHJpbmcsIG51bWJlcj4ge1xuICBpZiAobW9kZSA9PT0gXCJwZXJjZW50aWxlXCIpIHJldHVybiBwZXJjZW50aWxlUmF0aW5ncyhzY2VuZXMpO1xuICBjb25zdCB0YXJnZXRzID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgaWYgKG1vZGUgPT09IFwibGluZWFyXCIpIHtcbiAgICBmb3IgKGNvbnN0IHNjZW5lIG9mIHNjZW5lcykge1xuICAgICAgY29uc3QgdmFsdWUgPSBlbG8oc2NlbmUpO1xuICAgICAgaWYgKHZhbHVlICE9PSBudWxsKSB0YXJnZXRzLnNldChzY2VuZS5pZCwgbGluZWFyUmF0aW5nKHZhbHVlKSk7XG4gICAgfVxuICB9XG4gIHJldHVybiB0YXJnZXRzO1xufVxuXG4vKiogVGhlIFN0YXNoIHJhdGluZ3MgYSBzeW5jIHdvdWxkIHdyaXRlOiBzY2VuZSBpZCB0byBuZXcgcmF0aW5nLCBvbmx5IHdoZXJlIGl0IGRpZmZlcnMgZnJvbSBub3cuICovXG5leHBvcnQgZnVuY3Rpb24gc3Rhc2hSYXRpbmdDaGFuZ2VzKHNjZW5lczogU2NlbmVbXSwgbW9kZTogU3Rhc2hSYXRpbmdzTW9kZSk6IE1hcDxzdHJpbmcsIG51bWJlcj4ge1xuICBjb25zdCBjdXJyZW50ID0gbmV3IE1hcChzY2VuZXMubWFwKChzY2VuZSkgPT4gW3NjZW5lLmlkLCBzY2VuZS5yYXRpbmcxMDAgPz8gbnVsbF0pKTtcbiAgY29uc3QgY2hhbmdlcyA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG4gIGZvciAoY29uc3QgW2lkLCByYXRpbmddIG9mIHN0YXNoUmF0aW5nVGFyZ2V0cyhzY2VuZXMsIG1vZGUpKSB7XG4gICAgaWYgKGN1cnJlbnQuZ2V0KGlkKSAhPT0gcmF0aW5nKSBjaGFuZ2VzLnNldChpZCwgcmF0aW5nKTtcbiAgfVxuICByZXR1cm4gY2hhbmdlcztcbn1cblxuLyoqXG4gKiBFTE8gYW5kIGdhbWVzIGEgc2NlbmUgZ2V0cyBmcm9tIHRoZSBvbmUtdGltZSBzZXR1cCwgb3IgbnVsbCB3aGVuIGl0IHN0YXJ0cyB1bnJhdGVkLlxuICogXCJyYXRpbmdzXCIgc2VlZHMgcmF0ZWQgc2NlbmVzIGZyb20gdGhlaXIgU3Rhc2ggcmF0aW5nOyBcImZyZXNoXCIgc3RhcnRzIGV2ZXJ5IHNjZW5lIGF0IDE1MDAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzdGFydGluZ0VsbyhzY2VuZTogU2NlbmUsIHN0YXJ0OiBFbG9TdGFydCk6IEVsb0ZpZWxkcyB8IG51bGwge1xuICBpZiAoc3RhcnQgPT09IFwiZnJlc2hcIikgcmV0dXJuIHsgZWxvOiBFTE9fU1RBUlQsIGJhdHRsZXM6IDAsIHNlZWRlZDogZmFsc2UgfTtcbiAgcmV0dXJuIHNjZW5lLnJhdGluZzEwMCAhPSBudWxsID8geyBlbG86IHNlZWQoc2NlbmUucmF0aW5nMTAwKSwgYmF0dGxlczogMCwgc2VlZGVkOiB0cnVlIH0gOiBudWxsO1xufVxuXG4vKiogQSBjb3B5IG9mIGEgY3VzdG9tIGZpZWxkcyBtYXAgd2l0aCB0aGUgRUxPIGZpZWxkcyBzZXQgdG8gYHZhbHVlYCAob3IsIHdpdGggbnVsbCwgcmVtb3ZlZCkuICovXG5leHBvcnQgZnVuY3Rpb24gd2l0aEVsb0ZpZWxkcyhjdXN0b21GaWVsZHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbCB8IHVuZGVmaW5lZCwgdmFsdWU6IEVsb0ZpZWxkcyB8IG51bGwpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gIGNvbnN0IGZpZWxkcyA9IHsgLi4uY3VzdG9tRmllbGRzIH07XG4gIGZvciAoY29uc3Qga2V5IG9mIEVMT19GSUVMRF9LRVlTKSBkZWxldGUgZmllbGRzW2tleV07XG4gIGlmICh2YWx1ZSkgT2JqZWN0LmFzc2lnbihmaWVsZHMsIGVsb0N1c3RvbUZpZWxkcyh2YWx1ZSkpO1xuICByZXR1cm4gZmllbGRzO1xufVxuXG4vKiogVGhlIHNjZW5lJ3MgRUxPIGZpZWxkcywgb3IgbnVsbCB3aGVuIGl0J3MgdW5yYXRlZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlbG9GaWVsZHMoc2NlbmU6IFNjZW5lKTogRWxvRmllbGRzIHwgbnVsbCB7XG4gIGNvbnN0IHZhbHVlID0gZWxvKHNjZW5lKTtcbiAgcmV0dXJuIHZhbHVlID09PSBudWxsID8gbnVsbCA6IHsgZWxvOiB2YWx1ZSwgYmF0dGxlczogYmF0dGxlcyhzY2VuZSksIHNlZWRlZDogaXNTZWVkZWQoc2NlbmUpIH07XG59XG5cbi8qKiBBIGNvcHkgb2YgdGhlIHNjZW5lIGFzIGl0IHdvdWxkIGJlIHJpZ2h0IGFmdGVyIHNldHVwIChpdHMgRUxPIGZpZWxkcyByZXBsYWNlZCkuICovXG5leHBvcnQgZnVuY3Rpb24gYWZ0ZXJTZXR1cChzY2VuZTogU2NlbmUsIHN0YXJ0OiBFbG9TdGFydCk6IFNjZW5lIHtcbiAgcmV0dXJuIHsgLi4uc2NlbmUsIGN1c3RvbV9maWVsZHM6IHdpdGhFbG9GaWVsZHMoc2NlbmUuY3VzdG9tX2ZpZWxkcywgc3RhcnRpbmdFbG8oc2NlbmUsIHN0YXJ0KSkgfTtcbn1cblxuLyoqIEhpZ2hlc3QgRUxPIGZpcnN0LCB1bnJhdGVkIHNjZW5lcyBsYXN0LiBFcXVhbCBFTE9zIGtlZXAgdGhlaXIgb3JkZXIgKEFycmF5LnNvcnQgaXMgc3RhYmxlKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb21wYXJlQnlFbG8oYTogU2NlbmUsIGI6IFNjZW5lKTogbnVtYmVyIHtcbiAgY29uc3QgZWxvQSA9IGVsbyhhKTtcbiAgY29uc3QgZWxvQiA9IGVsbyhiKTtcbiAgaWYgKGVsb0EgPT09IG51bGwpIHJldHVybiBlbG9CID09PSBudWxsID8gMCA6IDE7XG4gIGlmIChlbG9CID09PSBudWxsKSByZXR1cm4gLTE7XG4gIHJldHVybiBlbG9CIC0gZWxvQTtcbn1cblxuLyoqIFNvcnQgc2NlbmVzIGluIHBsYWNlIGJ5IEVMTyAoc2VlIGNvbXBhcmVCeUVsbykgYW5kIHJldHVybiB0aGUgc2FtZSBhcnJheS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzb3J0QnlFbG8oc2NlbmVzOiBTY2VuZVtdKTogU2NlbmVbXSB7XG4gIHJldHVybiBzY2VuZXMuc29ydChjb21wYXJlQnlFbG8pO1xufVxuXG4vKiogSW5kZXggd2hlcmUgYSBzY2VuZSB3aXRoIHRoaXMgRUxPIHdvdWxkIHNpdCBpbiBhbiBFTE8tc29ydGVkIHBvb2w6IGJlbG93IGV2ZXJ5IGVxdWFsIG9yIGhpZ2hlciBvbmUuICovXG5leHBvcnQgZnVuY3Rpb24gZWxvSW5zZXJ0aW9uSW5kZXgocG9vbDogU2NlbmVbXSwgZWxvVmFsdWU6IG51bWJlcik6IG51bWJlciB7XG4gIGNvbnN0IGlkeCA9IHBvb2wuZmluZEluZGV4KChzKSA9PiB7XG4gICAgY29uc3Qgb3RoZXIgPSBlbG8ocyk7XG4gICAgcmV0dXJuIG90aGVyID09PSBudWxsIHx8IG90aGVyIDwgZWxvVmFsdWU7XG4gIH0pO1xuICByZXR1cm4gaWR4ID09PSAtMSA/IHBvb2wubGVuZ3RoIDogaWR4O1xufVxuXG4vKipcbiAqIEluZGV4ZXMgb2YgdGhlIFN3aXNzIG9wcG9uZW50cyBmb3IgYSBzY2VuZSBhdCBgZWxvVmFsdWVgOiBldmVyeSBzY2VuZSBpbiB0aGUgcG9vbCB3aXRoaW5cbiAqIMKxYHdpbmRvd2AgRUxPICh1bnJhdGVkIG9uZXMgY291bnQgYXMgRUxPX1NUQVJULCBhcyBpbiBTd2lzcyBiYXR0bGVzKSwgb3IsIHdoZW4gdGhhdCdzIGZld2VyIHRoYW5cbiAqIGBtaW5Db3VudGAsIHRoZSBgbWluQ291bnRgIG5lYXJlc3QgYnkgRUxPIChwbHVzIGFueSB0aWVkIHdpdGggdGhlIGxhc3Qgb2YgdGhlbSkuIFRoZSBzY2VuZVxuICogaXRzZWxmIChgZXhjbHVkZUlkYCkgaXMgbmV2ZXIgb25lLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc3dpc3NPcHBvbmVudEluZGV4ZXMoXG4gIHBvb2w6IFNjZW5lW10sXG4gIGVsb1ZhbHVlOiBudW1iZXIsXG4gIGV4Y2x1ZGVJZDogc3RyaW5nLFxuICB3aW5kb3c6IG51bWJlcixcbiAgbWluQ291bnQ6IG51bWJlcixcbik6IG51bWJlcltdIHtcbiAgY29uc3Qgb3RoZXJzID0gcG9vbFxuICAgIC5tYXAoKHNjZW5lLCBpZHgpID0+ICh7IGlkeCwgZ2FwOiBNYXRoLmFicyhlZmZlY3RpdmVFbG8oc2NlbmUpIC0gZWxvVmFsdWUpLCBpZDogc2NlbmUuaWQgfSkpXG4gICAgLmZpbHRlcigocykgPT4gcy5pZCAhPT0gZXhjbHVkZUlkKTtcbiAgY29uc3QgaW5XaW5kb3cgPSBvdGhlcnMuZmlsdGVyKChzKSA9PiBzLmdhcCA8PSB3aW5kb3cpO1xuICBpZiAoaW5XaW5kb3cubGVuZ3RoID49IG1pbkNvdW50IHx8IGluV2luZG93Lmxlbmd0aCA9PT0gb3RoZXJzLmxlbmd0aCkgcmV0dXJuIGluV2luZG93Lm1hcCgocykgPT4gcy5pZHgpO1xuICBjb25zdCBieUdhcCA9IFsuLi5vdGhlcnNdLnNvcnQoKGEsIGIpID0+IGEuZ2FwIC0gYi5nYXApO1xuICBjb25zdCBjdXRvZmYgPSBieUdhcFtNYXRoLm1pbihtaW5Db3VudCwgYnlHYXAubGVuZ3RoKSAtIDFdLmdhcDtcbiAgcmV0dXJuIGJ5R2FwLmZpbHRlcigocykgPT4gcy5nYXAgPD0gY3V0b2ZmKS5tYXAoKHMpID0+IHMuaWR4KS5zb3J0KChhLCBiKSA9PiBhIC0gYik7XG59XG5cbi8qKlxuICogRUxPIGZvciBhIHNjZW5lIFBsYWNlbWVudCBsYW5kcyBiZXR3ZWVuIHR3byBuZWlnaGJvdXJzIChudWxsIHdoZXJlIHRoZXJlJ3Mgbm9uZSwgb3IgdGhlXG4gKiBuZWlnaGJvdXIgaXMgdW5yYXRlZCk6IHRoZWlyIG1pZHBvaW50LCBvciBQTEFDRU1FTlRfRURHRV9HQVAgYmV5b25kIHRoZSBvbmx5IG9uZSBhdCBhbiBlZGdlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGxhY2VtZW50RWxvKGFib3ZlRWxvOiBudW1iZXIgfCBudWxsLCBiZWxvd0VsbzogbnVtYmVyIHwgbnVsbCk6IG51bWJlciB7XG4gIGlmIChhYm92ZUVsbyA9PT0gbnVsbCAmJiBiZWxvd0VsbyA9PT0gbnVsbCkgcmV0dXJuIEVMT19TVEFSVDtcbiAgaWYgKGFib3ZlRWxvID09PSBudWxsKSByZXR1cm4gcm91bmRFbG8oKGJlbG93RWxvIGFzIG51bWJlcikgKyBQTEFDRU1FTlRfRURHRV9HQVApO1xuICBpZiAoYmVsb3dFbG8gPT09IG51bGwpIHJldHVybiByb3VuZEVsbyhhYm92ZUVsbyAtIFBMQUNFTUVOVF9FREdFX0dBUCk7XG4gIC8vIE5laWdoYm91cnMgMC4xIGFwYXJ0IChvciB0aWVkKSBoYXZlIG5vIHJvb20gYmV0d2VlbiB0aGVtOiB0YWtlIHRoZSB1cHBlciBvbmUncyBFTE8sIHdoaWNoXG4gIC8vIHN0aWxsIHNvcnRzIHRoZSBzY2VuZSBiZWxvdyBpdCAoZXF1YWwgRUxPcyBnbyBiZWxvdykgYW5kIHNvIGluIHRoZSBzYW1lIHNsb3RcbiAgY29uc3QgbWlkID0gcm91bmRFbG8oKGFib3ZlRWxvICsgYmVsb3dFbG8pIC8gMik7XG4gIHJldHVybiBtaWQgPiBiZWxvd0VsbyA/IG1pZCA6IGFib3ZlRWxvO1xufVxuIiwgIi8vIEdyYXBoUUwgYWNjZXNzIGFnYWluc3QgdGhlIFN0YXNoIGJhY2tlbmQuXG5cbmltcG9ydCB0eXBlIHsgQXBvbGxvQ2FjaGVMaWtlIH0gZnJvbSBcIi4vcGx1Z2luQXBpXCI7XG5pbXBvcnQgeyB3aXRoRWxvRmllbGRzIH0gZnJvbSBcIi4vc2NvcmVcIjtcbmltcG9ydCB0eXBlIHsgRWxvRmllbGRzLCBGaW5kU2NlbmVSZXN1bHQsIFNjZW5lIH0gZnJvbSBcIi4vdHlwZXNcIjtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdyYXBocWxRdWVyeTxUID0gdW5rbm93bj4oXG4gIHF1ZXJ5OiBzdHJpbmcsXG4gIHZhcmlhYmxlczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fSxcbik6IFByb21pc2U8VD4ge1xuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKFwiL2dyYXBocWxcIiwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgaGVhZGVyczoge1xuICAgICAgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIsXG4gICAgfSxcbiAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IHF1ZXJ5LCB2YXJpYWJsZXMgfSksXG4gIH0pO1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXNwb25zZS5qc29uKCk7XG4gIGlmIChyZXN1bHQuZXJyb3JzKSB7XG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIEdyYXBoUUwgZXJyb3I6XCIsIHJlc3VsdC5lcnJvcnMpO1xuICAgIHRocm93IG5ldyBFcnJvcihyZXN1bHQuZXJyb3JzWzBdLm1lc3NhZ2UpO1xuICB9XG4gIHJldHVybiByZXN1bHQuZGF0YSBhcyBUO1xufVxuXG5leHBvcnQgY29uc3QgU0NFTkVfRlJBR01FTlQgPSBgXG4gICAgaWRcbiAgICB0aXRsZVxuICAgIGRhdGVcbiAgICByYXRpbmcxMDBcbiAgICBwbGF5X2NvdW50XG4gICAgY3VzdG9tX2ZpZWxkc1xuICAgIHBhdGhzIHtcbiAgICAgIHNjcmVlbnNob3RcbiAgICAgIHByZXZpZXdcbiAgICB9XG4gICAgZmlsZXMge1xuICAgICAgZHVyYXRpb25cbiAgICAgIHBhdGhcbiAgICB9XG4gICAgc3R1ZGlvIHtcbiAgICAgIG5hbWVcbiAgICB9XG4gICAgcGVyZm9ybWVycyB7XG4gICAgICBuYW1lXG4gICAgfVxuICAgIHRhZ3Mge1xuICAgICAgbmFtZVxuICAgIH1cbiAgYDtcblxuZXhwb3J0IGNvbnN0IEZJTkRfU0NFTkVTX1FVRVJZID0gYFxuICAgICAgcXVlcnkgRmluZFNjZW5lc0J5UmF0aW5nKCRmaWx0ZXI6IEZpbmRGaWx0ZXJUeXBlLCAkc2NlbmVfZmlsdGVyOiBTY2VuZUZpbHRlclR5cGUpIHtcbiAgICAgICAgZmluZFNjZW5lcyhmaWx0ZXI6ICRmaWx0ZXIsIHNjZW5lX2ZpbHRlcjogJHNjZW5lX2ZpbHRlcikge1xuICAgICAgICAgIGNvdW50XG4gICAgICAgICAgc2NlbmVzIHtcbiAgICAgICAgICAgICR7U0NFTkVfRlJBR01FTlR9XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgYDtcblxubGV0IGN1c3RvbUZpZWxkc1N1cHBvcnQ6IFByb21pc2U8Ym9vbGVhbj4gfCBudWxsID0gbnVsbDtcblxuLyoqXG4gKiBXaGV0aGVyIHRoaXMgU3Rhc2ggaGFzIHNjZW5lIGN1c3RvbSBmaWVsZHMgKG5lZWRlZCBmb3IgRUxPIHN0b3JhZ2UpLiBDaGVja2VkIG9uY2UgcGVyIHBhZ2VcbiAqIGxvYWQgdmlhIGludHJvc3BlY3Rpb247IGlmIGludHJvc3BlY3Rpb24gaXRzZWxmIGZhaWxzLCBhc3N1bWUgeWVzIGFuZCBsZXQgcmVhbCBxdWVyaWVzIHJlcG9ydC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNjZW5lQ3VzdG9tRmllbGRzU3VwcG9ydGVkKCk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBjdXN0b21GaWVsZHNTdXBwb3J0ID8/PSBncmFwaHFsUXVlcnk8eyBfX3R5cGU6IHsgZmllbGRzOiB7IG5hbWU6IHN0cmluZyB9W10gfSB8IG51bGwgfT4oXG4gICAgYHF1ZXJ5IHsgX190eXBlKG5hbWU6IFwiU2NlbmVcIikgeyBmaWVsZHMgeyBuYW1lIH0gfSB9YCxcbiAgKVxuICAgIC50aGVuKChkYXRhKSA9PiBkYXRhLl9fdHlwZT8uZmllbGRzLnNvbWUoKGYpID0+IGYubmFtZSA9PT0gXCJjdXN0b21fZmllbGRzXCIpID8/IHRydWUpXG4gICAgLmNhdGNoKChlKSA9PiB7XG4gICAgICBjb25zb2xlLndhcm4oXCJbU3Rhc2ggQmF0dGxlXSBDb3VsZCBub3QgY2hlY2sgZm9yIHNjZW5lIGN1c3RvbSBmaWVsZHM6XCIsIGUpO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfSk7XG4gIHJldHVybiBjdXN0b21GaWVsZHNTdXBwb3J0O1xufVxuXG4vKiogQSBjaGFuZ2UgU3Rhc2ggQmF0dGxlIHdyb3RlIHRvIGEgc2NlbmUsIHRvIG1pcnJvciBpbnRvIFN0YXNoJ3Mgb3duIHBhZ2UgY2FjaGUuICovXG5leHBvcnQgaW50ZXJmYWNlIFN0YXNoQ2FjaGVVcGRhdGUge1xuICBpZDogc3RyaW5nO1xuICByYXRpbmcxMDA/OiBudW1iZXI7XG4gIC8qKiBOZXcgRUxPIGZpZWxkcywgb3IgbnVsbCB3aGVuIHRoZXkgd2VyZSByZW1vdmVkLiAqL1xuICBlbG8/OiBFbG9GaWVsZHMgfCBudWxsO1xufVxuXG5mdW5jdGlvbiBzdGFzaEFwb2xsb0NhY2hlKCk6IEFwb2xsb0NhY2hlTGlrZSB8IHVuZGVmaW5lZCB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIHdpbmRvdy5QbHVnaW5BcGk/LnV0aWxzPy5TdGFzaFNlcnZpY2U/LmdldENsaWVudD8uKCk/LmNhY2hlO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG59XG5cbi8qKiBXaGlsZSBTdGFzaCBCYXR0bGUgaXMgb3BlbiwgU3Rhc2gncyBjYWNoZWQgc2NlbmUgbGlzdHMgYXJlIGRyb3BwZWQgb25jZSBvbiBjbG9zZSwgbm90IGV2ZXJ5IGJhdHRsZS4gKi9cbmxldCBob2xkTGlzdFJlZnJlc2ggPSBmYWxzZTtcbmxldCBsaXN0c1N0YWxlID0gZmFsc2U7XG5cbi8qKiBEcm9wIFN0YXNoJ3MgY2FjaGVkIHNjZW5lIGxpc3RzICh0aGV5IHJlZmV0Y2gpLCBzbyByYXRpbmctc29ydGVkIGxpc3RzIHJlLXNvcnQuICovXG5mdW5jdGlvbiBkcm9wU3Rhc2hMaXN0cyhjYWNoZTogQXBvbGxvQ2FjaGVMaWtlIHwgdW5kZWZpbmVkID0gc3Rhc2hBcG9sbG9DYWNoZSgpKTogdm9pZCB7XG4gIGxpc3RzU3RhbGUgPSBmYWxzZTtcbiAgaWYgKCFjYWNoZSkgcmV0dXJuO1xuICB0cnkge1xuICAgIGNhY2hlLmV2aWN0KHsgaWQ6IFwiUk9PVF9RVUVSWVwiLCBmaWVsZE5hbWU6IFwiZmluZFNjZW5lc1wiIH0pO1xuICAgIGNhY2hlLmdjKCk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zb2xlLndhcm4oXCJbU3Rhc2ggQmF0dGxlXSBDb3VsZCBub3QgcmVmcmVzaCBTdGFzaCdzIHNjZW5lIGxpc3RzOlwiLCBlKTtcbiAgfVxufVxuXG4vKipcbiAqIEhvbGQgYmFjayBkcm9wcGluZyBTdGFzaCdzIHNjZW5lIGxpc3RzIHdoaWxlIFN0YXNoIEJhdHRsZSBpcyBvcGVuICh0cnVlKTsgcmVsZWFzaW5nIGl0IChmYWxzZSlcbiAqIGRyb3BzIHRoZW0gb25jZSBpZiByYXRpbmdzIGNoYW5nZWQgbWVhbndoaWxlLiBUaGUgcGFnZXMgYmVoaW5kIHRoZSBtb2RhbCBjYW4gd2FpdCwgYW5kIGEgZHJvcFxuICogcGVyIGJhdHRsZSB3b3VsZCByZWZldGNoIGV2ZXJ5IGxpc3QgZWFjaCBwaWNrLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaG9sZFN0YXNoTGlzdFJlZnJlc2goaG9sZDogYm9vbGVhbik6IHZvaWQge1xuICBob2xkTGlzdFJlZnJlc2ggPSBob2xkO1xuICBpZiAoIWhvbGQgJiYgbGlzdHNTdGFsZSkgZHJvcFN0YXNoTGlzdHMoKTtcbn1cblxuLyoqXG4gKiBTdGFzaCBCYXR0bGUgd3JpdGVzIHdpdGggcGxhaW4gZmV0Y2gsIHNvIFN0YXNoJ3Mgb3duIHBhZ2VzIChBcG9sbG8pIG5ldmVyIHNlZSB0aGUgY2hhbmdlcyBhbmRcbiAqIGtlZXAgc2hvd2luZyBvbGQgcmF0aW5ncyB1bnRpbCByZWZyZXNoZWQuIE1pcnJvciB0aGUgY2hhbmdlcyBpbnRvIEFwb2xsbydzIGNhY2hlZCBzY2VuZXMsIGFuZFxuICogd2hlbiByYXRpbmdzIGNoYW5nZWQsIGRyb3AgY2FjaGVkIHNjZW5lIGxpc3RzIHNvIHJhdGluZy1zb3J0ZWQgbGlzdHMgcmUtc29ydCAoaGVsZCBiYWNrIHdoaWxlXG4gKiBTdGFzaCBCYXR0bGUgaXMgb3Blbiwgc2VlIGhvbGRTdGFzaExpc3RSZWZyZXNoKS4gRG9lcyBub3RoaW5nIGlmIFN0YXNoIGRvZXNuJ3QgZXhwb3NlIGl0cyBjbGllbnQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWZyZXNoU3Rhc2hDYWNoZSh1cGRhdGVzOiBTdGFzaENhY2hlVXBkYXRlW10sIHJhdGluZ3NDaGFuZ2VkOiBib29sZWFuKTogdm9pZCB7XG4gIGNvbnN0IGNhY2hlID0gc3Rhc2hBcG9sbG9DYWNoZSgpO1xuICBpZiAoIWNhY2hlKSByZXR1cm47XG4gIHRyeSB7XG4gICAgZm9yIChjb25zdCB1cGRhdGUgb2YgdXBkYXRlcykge1xuICAgICAgY29uc3QgaWQgPSBjYWNoZS5pZGVudGlmeSh7IF9fdHlwZW5hbWU6IFwiU2NlbmVcIiwgaWQ6IHVwZGF0ZS5pZCB9KTtcbiAgICAgIGlmICghaWQpIGNvbnRpbnVlO1xuICAgICAgY29uc3QgZmllbGRzOiBSZWNvcmQ8c3RyaW5nLCAoZXhpc3Rpbmc6IHVua25vd24pID0+IHVua25vd24+ID0ge307XG4gICAgICBpZiAodXBkYXRlLnJhdGluZzEwMCAhPT0gdW5kZWZpbmVkKSBmaWVsZHMucmF0aW5nMTAwID0gKCkgPT4gdXBkYXRlLnJhdGluZzEwMDtcbiAgICAgIGlmICh1cGRhdGUuZWxvICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgY29uc3QgdmFsdWUgPSB1cGRhdGUuZWxvO1xuICAgICAgICBmaWVsZHMuY3VzdG9tX2ZpZWxkcyA9IChleGlzdGluZykgPT4gd2l0aEVsb0ZpZWxkcyhleGlzdGluZyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IG51bGwsIHZhbHVlKTtcbiAgICAgIH1cbiAgICAgIC8vIEFwb2xsbyBvbmx5IGNhbGxzIG1vZGlmaWVycyBmb3IgZmllbGRzIGl0IGhhcyBjYWNoZWQsIHNvIG1pc3Npbmcgb25lcyBhcmUgc2tpcHBlZFxuICAgICAgY2FjaGUubW9kaWZ5KHsgaWQsIGZpZWxkcyB9KTtcbiAgICB9XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zb2xlLndhcm4oXCJbU3Rhc2ggQmF0dGxlXSBDb3VsZCBub3QgdXBkYXRlIFN0YXNoJ3MgcGFnZSBjYWNoZTpcIiwgZSk7XG4gIH1cbiAgaWYgKHJhdGluZ3NDaGFuZ2VkKSB7XG4gICAgbGlzdHNTdGFsZSA9IHRydWU7XG4gICAgaWYgKCFob2xkTGlzdFJlZnJlc2gpIGRyb3BTdGFzaExpc3RzKGNhY2hlKTtcbiAgfVxufVxuXG4vLyBFeHRyYWN0IHNjZW5lIElEIGZyb20gaW5kaXZpZHVhbCBzY2VuZSBwYWdlcyBsaWtlIC9zY2VuZXMvMTIzXG5leHBvcnQgZnVuY3Rpb24gZ2V0U2NlbmVJZEZyb21VcmwoKTogc3RyaW5nIHwgbnVsbCB7XG4gIGNvbnN0IG1hdGNoID0gd2luZG93LmxvY2F0aW9uLnBhdGhuYW1lLm1hdGNoKC9eXFwvc2NlbmVzXFwvKFxcZCspJC8pO1xuICByZXR1cm4gbWF0Y2ggPyBtYXRjaFsxXSA6IG51bGw7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBmZXRjaFNjZW5lQnlJZChzY2VuZUlkOiBzdHJpbmcpOiBQcm9taXNlPFNjZW5lIHwgbnVsbD4ge1xuICBjb25zdCBxdWVyeSA9IGBcbiAgICAgIHF1ZXJ5IEZpbmRTY2VuZSgkaWQ6IElEISkge1xuICAgICAgICBmaW5kU2NlbmUoaWQ6ICRpZCkge1xuICAgICAgICAgICR7U0NFTkVfRlJBR01FTlR9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICBgO1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCBncmFwaHFsUXVlcnk8RmluZFNjZW5lUmVzdWx0PihxdWVyeSwgeyBpZDogc2NlbmVJZCB9KTtcbiAgcmV0dXJuIHJlc3VsdC5maW5kU2NlbmU7XG59XG4iLCAiLy8gQ2xlYW4gbW9kZTogb3BlbiBTdGFzaCdzIG93biBEZWxldGVTY2VuZXNEaWFsb2csIHNvIGRlbGV0aW5nIGZyb20gYSBiYXR0bGUgYmVoYXZlcyBleGFjdGx5IGxpa2VcclxuLy8gZGVsZXRpbmcgaW4gU3Rhc2ggKHNhbWUgb3B0aW9ucyBhbmQgZGVmYXVsdHMsIGZpbGUgbGlzdCwgZGVsZXRlIGNhbGwgYW5kIHRvYXN0KS5cclxuLy9cclxuLy8gVGhlIGRpYWxvZyBuZWVkcyBTdGFzaCdzIFJlYWN0IGNvbnRleHQgKGludGwsIGNvbmZpZ3VyYXRpb24sIEFwb2xsbywgdG9hc3RzKSwgc28gaXQgY2FuJ3QgYmVcclxuLy8gcmVuZGVyZWQgc3RhbmRhbG9uZS4gSW5zdGVhZCBhIHNtYWxsIGJyaWRnZSBjb21wb25lbnQgaXMgcGF0Y2hlZCBpbnRvIFN0YXNoJ3MgbmF2YmFyIChhbHdheXNcclxuLy8gbW91bnRlZCkgYW5kIG9wZW5zIHRoZSBkaWFsb2cgd2hlbiBCYXR0bGUgYXNrcyBmb3IgaXQuIHJlYWN0LWJvb3RzdHJhcCBwb3J0YWxzIHRoZSBtb2RhbCB0b1xyXG4vLyA8Ym9keT47IENTUyBsaWZ0cyBpdCBhYm92ZSB0aGUgYmF0dGxlIG1vZGFsIHdoaWxlIEJhdHRsZSBpcyBvcGVuLlxyXG5cclxuaW1wb3J0IHsgZ3JhcGhxbFF1ZXJ5IH0gZnJvbSBcIi4uL2dyYXBocWxcIjtcclxuaW1wb3J0IHR5cGUgeyBSZWFjdE5vZGUgfSBmcm9tIFwiLi4vcGx1Z2luQXBpXCI7XHJcbmltcG9ydCB0eXBlIHsgU2NlbmUgfSBmcm9tIFwiLi4vdHlwZXNcIjtcclxuXHJcbi8qKiBTY2VuZSBmaWVsZHMgRGVsZXRlU2NlbmVzRGlhbG9nIHJlYWRzIChmaWxlIGxpc3QsIGZ1bnNjcmlwdCwgbXV0YXRpb24gaWRzKS4gKi9cclxuaW50ZXJmYWNlIERlbGV0YWJsZVNjZW5lIHtcclxuICBpZDogc3RyaW5nO1xyXG4gIHRpdGxlOiBzdHJpbmcgfCBudWxsO1xyXG4gIGludGVyYWN0aXZlOiBib29sZWFuO1xyXG4gIGZpbGVzOiB7IHBhdGg6IHN0cmluZyB9W107XHJcbn1cclxuXHJcbmNvbnN0IE9QRU5fRVZFTlQgPSBcInN0YXNoLWJhdHRsZTpvcGVuLWRlbGV0ZS1kaWFsb2dcIjtcclxuY29uc3QgQ0xPU0VfRVZFTlQgPSBcInN0YXNoLWJhdHRsZTpjbG9zZS1kZWxldGUtZGlhbG9nXCI7XHJcblxyXG5sZXQgYnJpZGdlUmVnaXN0ZXJlZCA9IGZhbHNlO1xyXG5sZXQgcGVuZGluZ1Jlc3VsdDogKChkZWxldGVkOiBib29sZWFuKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xyXG4vKiogU3Rhc2gncyBEZWxldGVTY2VuZXNEaWFsb2cgY29tcG9uZW50LCBvbmNlIGl0cyBjaHVuayBoYXMgbG9hZGVkLiAqL1xyXG5sZXQgRGVsZXRlU2NlbmVzRGlhbG9nOiB1bmtub3duID0gbnVsbDtcclxubGV0IGRpYWxvZ0xvYWRlZDogUHJvbWlzZTx2b2lkPiA9IFByb21pc2UucmVzb2x2ZSgpO1xyXG5cclxuZnVuY3Rpb24gc2V0dGxlKGRlbGV0ZWQ6IGJvb2xlYW4pOiB2b2lkIHtcclxuICBjb25zdCByZXNvbHZlID0gcGVuZGluZ1Jlc3VsdDtcclxuICBwZW5kaW5nUmVzdWx0ID0gbnVsbDtcclxuICByZXNvbHZlPy4oZGVsZXRlZCk7XHJcbn1cclxuXHJcbi8qKiBUcnVlIHdoZW4gdGhpcyBTdGFzaCBleHBvc2VzIGl0cyBkZWxldGUgZGlhbG9nIHRvIHBsdWdpbnMgKENsZWFuIG1vZGUgZGVwZW5kcyBvbiBpdCkuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBpc1N0YXNoRGVsZXRlRGlhbG9nQXZhaWxhYmxlKCk6IGJvb2xlYW4ge1xyXG4gIHJldHVybiBicmlkZ2VSZWdpc3RlcmVkO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gaXNEZWxldGVEaWFsb2dPcGVuKCk6IGJvb2xlYW4ge1xyXG4gIHJldHVybiBwZW5kaW5nUmVzdWx0ICE9PSBudWxsO1xyXG59XHJcblxyXG4vKiogQ2xvc2UgdGhlIGRpYWxvZyB3aXRob3V0IGRlbGV0aW5nIChlLmcuIHdoZW4gdGhlIGJhdHRsZSBtb2RhbCBjbG9zZXMpLiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gY2FuY2VsRGVsZXRlRGlhbG9nKCk6IHZvaWQge1xyXG4gIGlmICghcGVuZGluZ1Jlc3VsdCkgcmV0dXJuO1xyXG4gIHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBDdXN0b21FdmVudChDTE9TRV9FVkVOVCkpO1xyXG4gIHNldHRsZShmYWxzZSk7XHJcbn1cclxuXHJcbi8qKiBQYXRjaCB0aGUgYnJpZGdlIGludG8gU3Rhc2gncyBuYXZiYXIuIENhbGwgb25jZSBhdCBzdGFydHVwLCBiZWZvcmUgdGhlIG5hdmJhciByZW5kZXJzLiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gcmVnaXN0ZXJEZWxldGVEaWFsb2dCcmlkZ2UoKTogdm9pZCB7XHJcbiAgY29uc3QgYXBpID0gd2luZG93LlBsdWdpbkFwaTtcclxuICBpZiAoYnJpZGdlUmVnaXN0ZXJlZCB8fCAhYXBpPy5sb2FkYWJsZUNvbXBvbmVudHM/LkRlbGV0ZVNjZW5lc0RpYWxvZykge1xyXG4gICAgaWYgKCFhcGk/LmxvYWRhYmxlQ29tcG9uZW50cz8uRGVsZXRlU2NlbmVzRGlhbG9nKSB7XHJcbiAgICAgIGNvbnNvbGUud2FybihcIltTdGFzaCBCYXR0bGVdIFN0YXNoJ3MgZGVsZXRlIGRpYWxvZyBpc24ndCBhdmFpbGFibGUgdG8gcGx1Z2luczsgQ2xlYW4gbW9kZSBpcyBkaXNhYmxlZFwiKTtcclxuICAgIH1cclxuICAgIHJldHVybjtcclxuICB9XHJcbiAgYnJpZGdlUmVnaXN0ZXJlZCA9IHRydWU7XHJcbiAgY29uc3QgeyBSZWFjdCB9ID0gYXBpO1xyXG5cclxuICAvLyBMb2FkIHRoZSBkaWFsb2cncyBjaHVuayB1cCBmcm9udCBzbyBpdCBvcGVucyBpbnN0YW50bHlcclxuICBkaWFsb2dMb2FkZWQgPSBhcGkubG9hZGFibGVDb21wb25lbnRzXHJcbiAgICAuRGVsZXRlU2NlbmVzRGlhbG9nKClcclxuICAgIC50aGVuKChtb2QpID0+IHtcclxuICAgICAgRGVsZXRlU2NlbmVzRGlhbG9nID0gbW9kLkRlbGV0ZVNjZW5lc0RpYWxvZyA/PyBtb2QuZGVmYXVsdCA/PyBudWxsO1xyXG4gICAgfSlcclxuICAgIC5jYXRjaCgoZSkgPT4gY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIEZhaWxlZCB0byBsb2FkIFN0YXNoJ3MgZGVsZXRlIGRpYWxvZzpcIiwgZSkpO1xyXG5cclxuICBmdW5jdGlvbiBEZWxldGVCcmlkZ2UoKTogUmVhY3ROb2RlIHtcclxuICAgIGNvbnN0IFtzY2VuZSwgc2V0U2NlbmVdID0gUmVhY3QudXNlU3RhdGU8RGVsZXRhYmxlU2NlbmUgfCBudWxsPihudWxsKTtcclxuXHJcbiAgICBSZWFjdC51c2VFZmZlY3QoKCkgPT4ge1xyXG4gICAgICBjb25zdCBvcGVuID0gKGU6IEV2ZW50KTogdm9pZCA9PiB7XHJcbiAgICAgICAgLy8gVGhlIG5hdmJhciBjYW4gcmVuZGVyIG1vcmUgdGhhbiBvbmNlOyB0aGUgZmlyc3QgYnJpZGdlIHRvIGhlYXIgdGhlIGV2ZW50IGhhbmRsZXMgaXQuXHJcbiAgICAgICAgLy8gcHJldmVudERlZmF1bHQgdGVsbHMgY29uZmlybURlbGV0ZVNjZW5lIHRoZSByZXF1ZXN0IHdhcyBwaWNrZWQgdXAuXHJcbiAgICAgICAgZS5zdG9wSW1tZWRpYXRlUHJvcGFnYXRpb24oKTtcclxuICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7XHJcbiAgICAgICAgc2V0U2NlbmUoKGUgYXMgQ3VzdG9tRXZlbnQ8RGVsZXRhYmxlU2NlbmU+KS5kZXRhaWwpO1xyXG4gICAgICB9O1xyXG4gICAgICBjb25zdCBjbG9zZSA9ICgpOiB2b2lkID0+IHNldFNjZW5lKG51bGwpO1xyXG4gICAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcihPUEVOX0VWRU5ULCBvcGVuKTtcclxuICAgICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoQ0xPU0VfRVZFTlQsIGNsb3NlKTtcclxuICAgICAgcmV0dXJuICgpID0+IHtcclxuICAgICAgICB3aW5kb3cucmVtb3ZlRXZlbnRMaXN0ZW5lcihPUEVOX0VWRU5ULCBvcGVuKTtcclxuICAgICAgICB3aW5kb3cucmVtb3ZlRXZlbnRMaXN0ZW5lcihDTE9TRV9FVkVOVCwgY2xvc2UpO1xyXG4gICAgICB9O1xyXG4gICAgfSwgW10pO1xyXG5cclxuICAgIGlmICghc2NlbmUgfHwgIURlbGV0ZVNjZW5lc0RpYWxvZykgcmV0dXJuIG51bGw7XHJcbiAgICByZXR1cm4gUmVhY3QuY3JlYXRlRWxlbWVudChEZWxldGVTY2VuZXNEaWFsb2csIHtcclxuICAgICAgc2VsZWN0ZWQ6IFtzY2VuZV0sXHJcbiAgICAgIG9uQ2xvc2U6IChkZWxldGVkOiBib29sZWFuKSA9PiB7XHJcbiAgICAgICAgc2V0U2NlbmUobnVsbCk7XHJcbiAgICAgICAgc2V0dGxlKGRlbGV0ZWQpO1xyXG4gICAgICB9LFxyXG4gICAgfSk7XHJcbiAgfVxyXG5cclxuICAvLyBTdGFzaCBhcHBlbmRzIHRoZSByZW5kZXJlZCByZXN1bHQgYWZ0ZXIgdGhlIGNhbGwncyBhcmdzLCBhbmQgYW5vdGhlciBwbHVnaW4ncyBgYmVmb3JlYCBwYXRjaFxyXG4gIC8vIGNhbiBjaGFuZ2UgaG93IG1hbnkgYXJncyB0aGVyZSBhcmUsIHNvIHRoZSByZXN1bHQgaXMgYWx3YXlzIHRoZSBsYXN0IG9uZSwgbm90IGEgZml4ZWQgc2xvdC5cclxuICBhcGkucGF0Y2guYWZ0ZXIoXCJNYWluTmF2QmFyLlV0aWxpdHlJdGVtc1wiLCAoLi4uYXJnczogdW5rbm93bltdKSA9PlxyXG4gICAgUmVhY3QuY3JlYXRlRWxlbWVudChcclxuICAgICAgUmVhY3QuRnJhZ21lbnQsXHJcbiAgICAgIG51bGwsXHJcbiAgICAgIGFyZ3NbYXJncy5sZW5ndGggLSAxXSBhcyBSZWFjdE5vZGUsXHJcbiAgICAgIFJlYWN0LmNyZWF0ZUVsZW1lbnQoRGVsZXRlQnJpZGdlKSxcclxuICAgICksXHJcbiAgKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIE9wZW4gU3Rhc2gncyBkZWxldGUgZGlhbG9nIGZvciBgc2NlbmVgLiBSZXNvbHZlcyB0cnVlIG9uY2UgU3Rhc2ggaGFzIGRlbGV0ZWQgaXQsIGZhbHNlIGlmIHRoZVxyXG4gKiB1c2VyIGNhbmNlbGxlZCAob3IgdGhlIGRlbGV0ZSBmYWlsZWQg4oCUIFN0YXNoIHNob3dzIGl0cyBvd24gZXJyb3IgdG9hc3QpLlxyXG4gKi9cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNvbmZpcm1EZWxldGVTY2VuZShzY2VuZTogU2NlbmUpOiBQcm9taXNlPGJvb2xlYW4+IHtcclxuICBpZiAoIWJyaWRnZVJlZ2lzdGVyZWQpIHJldHVybiBmYWxzZTtcclxuICBjYW5jZWxEZWxldGVEaWFsb2coKTtcclxuICBhd2FpdCBkaWFsb2dMb2FkZWQ7XHJcbiAgaWYgKCFEZWxldGVTY2VuZXNEaWFsb2cpIHJldHVybiBmYWxzZTtcclxuXHJcbiAgY29uc3QgeyBmaW5kU2NlbmUgfSA9IGF3YWl0IGdyYXBocWxRdWVyeTx7IGZpbmRTY2VuZTogRGVsZXRhYmxlU2NlbmUgfCBudWxsIH0+KFxyXG4gICAgYHF1ZXJ5IEJhdHRsZURlbGV0YWJsZVNjZW5lKCRpZDogSUQhKSB7IGZpbmRTY2VuZShpZDogJGlkKSB7IGlkIHRpdGxlIGludGVyYWN0aXZlIGZpbGVzIHsgcGF0aCB9IH0gfWAsXHJcbiAgICB7IGlkOiBzY2VuZS5pZCB9LFxyXG4gICk7XHJcbiAgaWYgKCFmaW5kU2NlbmUpIHJldHVybiBmYWxzZTtcclxuXHJcbiAgY29uc3QgcmVzdWx0ID0gbmV3IFByb21pc2U8Ym9vbGVhbj4oKHJlc29sdmUpID0+IHtcclxuICAgIHBlbmRpbmdSZXN1bHQgPSByZXNvbHZlO1xyXG4gIH0pO1xyXG5cclxuICAvLyBTdGFzaCByZW5kZXJzIHRoZSBuYXZiYXIgYWZ0ZXIgcGx1Z2lucyBsb2FkLCBzbyB0aGUgYnJpZGdlIGlzIG1vdW50ZWQgd2VsbCBiZWZvcmUgYW55b25lIGNhblxyXG4gIC8vIGNsaWNrIGEgZGVsZXRlIGJ1dHRvbjsgaWYgaXQgc29tZWhvdyBpc24ndCwgc2F5IHNvIHJhdGhlciB0aGFuIGZha2luZyBhIG5hdmlnYXRpb25cclxuICBpZiAoIXJlcXVlc3REaWFsb2coZmluZFNjZW5lKSkge1xyXG4gICAgY29uc29sZS53YXJuKFwiW1N0YXNoIEJhdHRsZV0gU3Rhc2gncyBkZWxldGUgZGlhbG9nIGJyaWRnZSBpc24ndCBtb3VudGVkXCIpO1xyXG4gICAgc2V0dGxlKGZhbHNlKTtcclxuICAgIHdpbmRvdy5hbGVydChcIkNvdWxkbid0IG9wZW4gU3Rhc2gncyBkZWxldGUgZGlhbG9nLiBSZWxvYWQgdGhlIHBhZ2UgYW5kIHRyeSBhZ2Fpbi5cIik7XHJcbiAgfVxyXG4gIHJldHVybiByZXN1bHQ7XHJcbn1cclxuXHJcbi8qKiBBc2sgdGhlIGJyaWRnZSB0byBvcGVuIHRoZSBkaWFsb2c7IGZhbHNlIGlmIG5vIGJyaWRnZSBpcyBtb3VudGVkIHRvIHBpY2sgaXQgdXAuICovXHJcbmZ1bmN0aW9uIHJlcXVlc3REaWFsb2coc2NlbmU6IERlbGV0YWJsZVNjZW5lKTogYm9vbGVhbiB7XHJcbiAgY29uc3QgcmVxdWVzdCA9IG5ldyBDdXN0b21FdmVudChPUEVOX0VWRU5ULCB7IGRldGFpbDogc2NlbmUsIGNhbmNlbGFibGU6IHRydWUgfSk7XHJcbiAgcmV0dXJuICF3aW5kb3cuZGlzcGF0Y2hFdmVudChyZXF1ZXN0KTtcclxufVxyXG4iLCAiLy8gVVJMIGZpbHRlciBwYXJzaW5nIGZvciBTdGFzaCBsaXN0IOKGkiBHcmFwaFFMIHNjZW5lIHF1ZXJpZXMuXG5cbmltcG9ydCB0eXBlIHsgRmluZEZpbHRlclR5cGUsIFNjZW5lRmlsdGVyVHlwZSB9IGZyb20gXCIuL3R5cGVzXCI7XG5cbi8vIEdldCBjdXJyZW50IFVSTCBzZWFyY2ggcGFyYW1zXG5leHBvcnQgZnVuY3Rpb24gZ2V0U2VhcmNoUGFyYW1zKCk6IFVSTFNlYXJjaFBhcmFtcyB7XG4gIHJldHVybiBuZXcgVVJMU2VhcmNoUGFyYW1zKHdpbmRvdy5sb2NhdGlvbi5zZWFyY2gpO1xufVxuXG4vLyBCdWlsZCBGaW5kRmlsdGVyVHlwZSBmcm9tIGN1cnJlbnQgVVJMIHNlYXJjaCBwYXJhbXMgKG9yIGFuIGV4cGxpY2l0IHBhcmFtcyBvYmplY3QpLlxuZXhwb3J0IGZ1bmN0aW9uIGdldEZpbmRGaWx0ZXIoXG4gIG92ZXJyaWRlczogUGFydGlhbDxGaW5kRmlsdGVyVHlwZT4gPSB7fSxcbiAgc2VhcmNoUGFyYW1zOiBVUkxTZWFyY2hQYXJhbXMgPSBnZXRTZWFyY2hQYXJhbXMoKSxcbik6IEZpbmRGaWx0ZXJUeXBlIHtcbiAgY29uc3QgZmlsdGVyOiBGaW5kRmlsdGVyVHlwZSA9IHtcbiAgICBwZXJfcGFnZTogb3ZlcnJpZGVzLnBlcl9wYWdlID8/IC0xLFxuICAgIHNvcnQ6IG92ZXJyaWRlcy5zb3J0ID8/IChzZWFyY2hQYXJhbXMuZ2V0KFwic29ydGJ5XCIpIHx8IFwicmF0aW5nXCIpLFxuICAgIGRpcmVjdGlvbjogb3ZlcnJpZGVzLmRpcmVjdGlvbiA/PyAoc2VhcmNoUGFyYW1zLmdldChcInNvcnRkaXJcIik/LnRvVXBwZXJDYXNlKCkgfHwgXCJERVNDXCIpLFxuICAgIC4uLm92ZXJyaWRlcyxcbiAgfTtcblxuICAvLyBJbmNsdWRlIHNlYXJjaCBxdWVyeSBpZiBwcmVzZW50XG4gIGNvbnN0IHF1ZXJ5ID0gc2VhcmNoUGFyYW1zLmdldChcInFcIik7XG4gIGlmIChxdWVyeSkge1xuICAgIGZpbHRlci5xID0gcXVlcnk7XG4gIH1cblxuICByZXR1cm4gZmlsdGVyO1xufVxuXG4vLyBUcmFuc2xhdGUgSlNPTiBzdHJpbmcgYmV0d2VlbiBVUkwgZm9ybWF0IChwYXJlbnRoZXNlcykgYW5kIHN0YW5kYXJkIEpTT04gKGJyYWNlcylcbi8vIFBvcnRlZCBmcm9tIFN0YXNoJ3MgTGlzdEZpbHRlck1vZGVsLnRyYW5zbGF0ZUpTT05cbi8vIFRoaXMgc2FmZWx5IGhhbmRsZXMgcGFyZW50aGVzZXMgaW5zaWRlIHF1b3RlZCBzdHJpbmdzXG5leHBvcnQgZnVuY3Rpb24gdHJhbnNsYXRlSlNPTihqc29uU3RyaW5nOiBzdHJpbmcsIGRlY29kaW5nOiBib29sZWFuKTogc3RyaW5nIHtcbiAgbGV0IGluU3RyaW5nID0gZmFsc2U7XG4gIGxldCBlc2NhcGUgPSBmYWxzZTtcbiAgcmV0dXJuIFsuLi5qc29uU3RyaW5nXVxuICAgIC5tYXAoKGMpID0+IHtcbiAgICAgIGlmIChlc2NhcGUpIHtcbiAgICAgICAgZXNjYXBlID0gZmFsc2U7XG4gICAgICAgIHJldHVybiBjO1xuICAgICAgfVxuICAgICAgc3dpdGNoIChjKSB7XG4gICAgICAgIGNhc2UgXCJcXFxcXCI6XG4gICAgICAgICAgaWYgKGluU3RyaW5nKSBlc2NhcGUgPSB0cnVlO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlICdcIic6XG4gICAgICAgICAgaW5TdHJpbmcgPSAhaW5TdHJpbmc7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgXCIoXCI6XG4gICAgICAgICAgaWYgKGRlY29kaW5nICYmICFpblN0cmluZykgcmV0dXJuIFwie1wiO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlIFwiKVwiOlxuICAgICAgICAgIGlmIChkZWNvZGluZyAmJiAhaW5TdHJpbmcpIHJldHVybiBcIn1cIjtcbiAgICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIHJldHVybiBjO1xuICAgIH0pXG4gICAgLmpvaW4oXCJcIik7XG59XG5cbi8vIENyaXRlcmlvbiBjYXRlZ29yeSBtYXBwaW5ncyBmb3IgVVJMIC0+IEdyYXBoUUwgdHJhbnNmb3JtYXRpb25cbi8vIEVhY2ggY2F0ZWdvcnkgcmVxdWlyZXMgZGlmZmVyZW50IHRyYW5zZm9ybWF0aW9uIGxvZ2ljXG5jb25zdCBDUklURVJJT05fQ0FURUdPUklFUyA9IHtcbiAgLy8gQm9vbGVhbjogbm8gbW9kaWZpZXIsIHZhbHVlIGlzIFwidHJ1ZVwiL1wiZmFsc2VcIiBzdHJpbmcgLT4gY29udmVydCB0byBib29sZWFuXG4gIGJvb2xlYW46IG5ldyBTZXQoW1wib3JnYW5pemVkXCIsIFwiaW50ZXJhY3RpdmVcIiwgXCJwZXJmb3JtZXJfZmF2b3JpdGVcIl0pLFxuICAvLyBTdHJpbmdFbnVtOiBVUkwgaGFzIG1vZGlmaWVyIGJ1dCBHcmFwaFFMIGp1c3QgZXhwZWN0cyB0aGUgc3RyaW5nIHZhbHVlIGRpcmVjdGx5XG4gIHN0cmluZ0VudW06IG5ldyBTZXQoW1wiaXNfbWlzc2luZ1wiLCBcImhhc19tYXJrZXJzXCJdKSxcbiAgLy8gTXVsdGk6IHZhbHVlIGlzIGFycmF5IG9mIHtpZCwgbGFiZWx9IC0+IGV4dHJhY3QgSURzIG9ubHlcbiAgbXVsdGk6IG5ldyBTZXQoW1wicGVyZm9ybWVyc1wiLCBcImdyb3Vwc1wiLCBcIm1vdmllc1wiLCBcImdhbGxlcmllc1wiXSksXG4gIC8vIEhpZXJhcmNoaWNhbE11bHRpOiB2YWx1ZSBoYXMge2l0ZW1zLCBleGNsdWRlZCwgZGVwdGh9IC0+IHJlbmFtZSB0byB7dmFsdWUsIGV4Y2x1ZGVzLCBkZXB0aH0gYW5kIGV4dHJhY3QgSURzXG4gIGhpZXJhcmNoaWNhbE11bHRpOiBuZXcgU2V0KFtcInRhZ3NcIiwgXCJzdHVkaW9zXCIsIFwicGVyZm9ybWVyX3RhZ3NcIl0pLFxufTtcblxuLy8gUmVzb2x1dGlvbiBzdHJpbmcgdG8gR3JhcGhRTCBlbnVtIG1hcHBpbmdcbi8vIFVSTCB1c2VzIGh1bWFuLXJlYWRhYmxlIHN0cmluZ3MsIEdyYXBoUUwgZXhwZWN0cyBSZXNvbHV0aW9uRW51bSB2YWx1ZXNcbmNvbnN0IFJFU09MVVRJT05fTUFQOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICBcIjE0NHBcIjogXCJWRVJZX0xPV1wiLFxuICBcIjI0MHBcIjogXCJMT1dcIixcbiAgXCIzNjBwXCI6IFwiUjM2MFBcIixcbiAgXCI0ODBwXCI6IFwiU1RBTkRBUkRcIixcbiAgXCI1NDBwXCI6IFwiV0VCX0hEXCIsXG4gIFwiNzIwcFwiOiBcIlNUQU5EQVJEX0hEXCIsXG4gIFwiMTA4MHBcIjogXCJGVUxMX0hEXCIsXG4gIFwiMTQ0MHBcIjogXCJRVUFEX0hEXCIsXG4gIFwiNGtcIjogXCJGT1VSX0tcIixcbiAgXCI1a1wiOiBcIkZJVkVfS1wiLFxuICBcIjZrXCI6IFwiU0lYX0tcIixcbiAgXCI3a1wiOiBcIlNFVkVOX0tcIixcbiAgXCI4a1wiOiBcIkVJR0hUX0tcIixcbiAgSHVnZTogXCJIVUdFXCIsXG59O1xuXG4vLyBPcmllbnRhdGlvbiBzdHJpbmcgdG8gR3JhcGhRTCBlbnVtIG1hcHBpbmdcbmNvbnN0IE9SSUVOVEFUSU9OX01BUDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgTGFuZHNjYXBlOiBcIkxBTkRTQ0FQRVwiLFxuICBQb3J0cmFpdDogXCJQT1JUUkFJVFwiLFxuICBTcXVhcmU6IFwiU1FVQVJFXCIsXG59O1xuXG5jb25zdCBpZE9mID0gKHY6IGFueSk6IHVua25vd24gPT4gKHR5cGVvZiB2ID09PSBcIm9iamVjdFwiICYmIHYgJiYgdi5pZCA/IHYuaWQgOiB2KTtcblxuLy8gQnVpbGQgU2NlbmVGaWx0ZXJUeXBlIGZyb20gVVJMICdjJyBwYXJhbXMgKGRlZmF1bHRzIHRvIGN1cnJlbnQgcGFnZSBVUkwpLlxuZXhwb3J0IGZ1bmN0aW9uIGdldFNjZW5lRmlsdGVyKFxuICBzZWFyY2hQYXJhbXM6IFVSTFNlYXJjaFBhcmFtcyA9IGdldFNlYXJjaFBhcmFtcygpLFxuKTogU2NlbmVGaWx0ZXJUeXBlIHwgbnVsbCB7XG4gIGNvbnN0IHNjZW5lRmlsdGVyOiBTY2VuZUZpbHRlclR5cGUgPSB7fTtcblxuICBpZiAoIXNlYXJjaFBhcmFtcy5oYXMoXCJjXCIpKSByZXR1cm4gbnVsbDtcblxuICBmb3IgKGNvbnN0IGNTdHIgb2Ygc2VhcmNoUGFyYW1zLmdldEFsbChcImNcIikpIHtcbiAgICB0cnkge1xuICAgICAgLy8gRGVjb2RlIFVSTCBmb3JtYXQ6ICgpIC0+IHt9IChzYWZlbHkgcHJlc2VydmluZyBzdHJpbmdzKVxuICAgICAgY29uc3QgZGVjb2RlZCA9IHRyYW5zbGF0ZUpTT04oY1N0ciwgdHJ1ZSk7XG4gICAgICBjb25zdCBjT2JqOiBhbnkgPSBKU09OLnBhcnNlKGRlY29kZWQpO1xuXG4gICAgICBjb25zdCBmaWx0ZXJUeXBlOiBzdHJpbmcgfCB1bmRlZmluZWQgPSBjT2JqLnR5cGU7XG4gICAgICBpZiAoIWZpbHRlclR5cGUpIHtcbiAgICAgICAgY29uc29sZS53YXJuKFwiW1N0YXNoIEJhdHRsZV0gRmlsdGVyIG1pc3NpbmcgdHlwZTpcIiwgY09iaik7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICAvLyBSZW1vdmUgdHlwZSBmcm9tIHRoZSBvYmplY3QgLSBpdCBiZWNvbWVzIHRoZSBrZXlcbiAgICAgIGNvbnN0IHsgdHlwZTogX3R5cGUsIC4uLnJlc3QgfSA9IGNPYmo7XG5cbiAgICAgIC8vIENhdGVnb3J5OiBCb29sZWFuIChvcmdhbml6ZWQsIGludGVyYWN0aXZlLCBwZXJmb3JtZXJfZmF2b3JpdGUpXG4gICAgICBpZiAoQ1JJVEVSSU9OX0NBVEVHT1JJRVMuYm9vbGVhbi5oYXMoZmlsdGVyVHlwZSkpIHtcbiAgICAgICAgc2NlbmVGaWx0ZXJbZmlsdGVyVHlwZV0gPSByZXN0LnZhbHVlID09PSBcInRydWVcIiB8fCByZXN0LnZhbHVlID09PSB0cnVlO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgLy8gQ2F0ZWdvcnk6IFN0cmluZ0VudW0gKHNjZW5lSXNNaXNzaW5nLCBoYXNNYXJrZXJzKVxuICAgICAgaWYgKENSSVRFUklPTl9DQVRFR09SSUVTLnN0cmluZ0VudW0uaGFzKGZpbHRlclR5cGUpKSB7XG4gICAgICAgIHNjZW5lRmlsdGVyW2ZpbHRlclR5cGVdID0gcmVzdC52YWx1ZTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIC8vIENhdGVnb3J5OiBNdWx0aSAocGVyZm9ybWVycywgZ3JvdXBzLCBtb3ZpZXMsIGdhbGxlcmllcylcbiAgICAgIGlmIChDUklURVJJT05fQ0FURUdPUklFUy5tdWx0aS5oYXMoZmlsdGVyVHlwZSkpIHtcbiAgICAgICAgY29uc3QgcmVzdWx0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgbW9kaWZpZXI6IHJlc3QubW9kaWZpZXIgfTtcbiAgICAgICAgY29uc3QgdmFsID0gcmVzdC52YWx1ZSB8fCB7fTtcblxuICAgICAgICBpZiAodmFsLml0ZW1zICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICBjb25zdCBpdGVtczogYW55W10gPSB2YWwuaXRlbXMgfHwgW107XG4gICAgICAgICAgY29uc3QgZXhjbHVkZWQ6IGFueVtdID0gdmFsLmV4Y2x1ZGVkIHx8IFtdO1xuICAgICAgICAgIHJlc3VsdC52YWx1ZSA9IGl0ZW1zLm1hcChpZE9mKTtcbiAgICAgICAgICBpZiAoZXhjbHVkZWQubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgcmVzdWx0LmV4Y2x1ZGVzID0gZXhjbHVkZWQubWFwKGlkT2YpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIGlmIChBcnJheS5pc0FycmF5KHJlc3QudmFsdWUpKSB7XG4gICAgICAgICAgcmVzdWx0LnZhbHVlID0gcmVzdC52YWx1ZS5tYXAoaWRPZik7XG4gICAgICAgIH0gZWxzZSBpZiAocmVzdC5tb2RpZmllciA9PT0gXCJJU19OVUxMXCIgfHwgcmVzdC5tb2RpZmllciA9PT0gXCJOT1RfTlVMTFwiKSB7XG4gICAgICAgICAgcmVzdWx0LnZhbHVlID0gW107XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgcmVzdWx0LnZhbHVlID0gcmVzdC52YWx1ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIHNjZW5lRmlsdGVyW2ZpbHRlclR5cGVdID0gcmVzdWx0O1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgLy8gQ2F0ZWdvcnk6IEhpZXJhcmNoaWNhbE11bHRpICh0YWdzLCBzdHVkaW9zLCBwZXJmb3JtZXJfdGFncylcbiAgICAgIGlmIChDUklURVJJT05fQ0FURUdPUklFUy5oaWVyYXJjaGljYWxNdWx0aS5oYXMoZmlsdGVyVHlwZSkpIHtcbiAgICAgICAgY29uc3QgdmFsID0gcmVzdC52YWx1ZSB8fCB7fTtcbiAgICAgICAgY29uc3QgaXRlbXM6IGFueVtdID0gdmFsLml0ZW1zIHx8IFtdO1xuICAgICAgICBjb25zdCBleGNsdWRlZDogYW55W10gPSB2YWwuZXhjbHVkZWQgfHwgW107XG4gICAgICAgIHNjZW5lRmlsdGVyW2ZpbHRlclR5cGVdID0ge1xuICAgICAgICAgIG1vZGlmaWVyOiByZXN0Lm1vZGlmaWVyLFxuICAgICAgICAgIHZhbHVlOiBpdGVtcy5tYXAoaWRPZiksXG4gICAgICAgICAgZXhjbHVkZXM6IGV4Y2x1ZGVkLm1hcChpZE9mKSxcbiAgICAgICAgICBkZXB0aDogdmFsLmRlcHRoID8/IDAsXG4gICAgICAgIH07XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICAvLyBDYXRlZ29yeTogUmVzb2x1dGlvbiAobmVlZHMgc3RyaW5nIC0+IGVudW0gY29udmVyc2lvbilcbiAgICAgIGlmIChmaWx0ZXJUeXBlID09PSBcInJlc29sdXRpb25cIikge1xuICAgICAgICBzY2VuZUZpbHRlcltmaWx0ZXJUeXBlXSA9IHtcbiAgICAgICAgICBtb2RpZmllcjogcmVzdC5tb2RpZmllcixcbiAgICAgICAgICB2YWx1ZTogUkVTT0xVVElPTl9NQVBbcmVzdC52YWx1ZV0gfHwgcmVzdC52YWx1ZSxcbiAgICAgICAgfTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIC8vIENhdGVnb3J5OiBPcmllbnRhdGlvbiAobXVsdGktc2VsZWN0IGVudW0sIG5vIG1vZGlmaWVyKVxuICAgICAgaWYgKGZpbHRlclR5cGUgPT09IFwib3JpZW50YXRpb25cIikge1xuICAgICAgICBjb25zdCB2YWx1ZXM6IGFueVtdID0gQXJyYXkuaXNBcnJheShyZXN0LnZhbHVlKSA/IHJlc3QudmFsdWUgOiBbcmVzdC52YWx1ZV07XG4gICAgICAgIHNjZW5lRmlsdGVyW2ZpbHRlclR5cGVdID0ge1xuICAgICAgICAgIHZhbHVlOiB2YWx1ZXMubWFwKCh2KSA9PiBPUklFTlRBVElPTl9NQVBbdl0gfHwgdikuZmlsdGVyKEJvb2xlYW4pLFxuICAgICAgICB9O1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgLy8gQ2F0ZWdvcnk6IER1cGxpY2F0ZWQgKHBoYXNoIGR1cGxpY2F0ZSBmaWx0ZXIgLSBkaWZmZXJlbnQgc3RydWN0dXJlKVxuICAgICAgaWYgKGZpbHRlclR5cGUgPT09IFwiZHVwbGljYXRlZFwiKSB7XG4gICAgICAgIHNjZW5lRmlsdGVyW2ZpbHRlclR5cGVdID0ge1xuICAgICAgICAgIGR1cGxpY2F0ZWQ6IHJlc3QudmFsdWUgPT09IFwidHJ1ZVwiIHx8IHJlc3QudmFsdWUgPT09IHRydWUsXG4gICAgICAgIH07XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICAvLyBDYXRlZ29yeTogU3RhbmRhcmQgKG51bWJlciwgc3RyaW5nLCBkYXRlLCB0aW1lc3RhbXAsIGR1cmF0aW9uLCBzcGVjaWFsKVxuICAgICAgaWYgKFxuICAgICAgICByZXN0LnZhbHVlICYmXG4gICAgICAgIHR5cGVvZiByZXN0LnZhbHVlID09PSBcIm9iamVjdFwiICYmXG4gICAgICAgICFBcnJheS5pc0FycmF5KHJlc3QudmFsdWUpICYmXG4gICAgICAgIFwidmFsdWVcIiBpbiByZXN0LnZhbHVlXG4gICAgICApIHtcbiAgICAgICAgLy8gRmxhdHRlbjogeyBtb2RpZmllciwgdmFsdWU6IHsgdmFsdWU6IFgsIHZhbHVlMjogWSB9IH0gLT4geyBtb2RpZmllciwgdmFsdWU6IFgsIHZhbHVlMjogWSB9XG4gICAgICAgIHNjZW5lRmlsdGVyW2ZpbHRlclR5cGVdID0ge1xuICAgICAgICAgIG1vZGlmaWVyOiByZXN0Lm1vZGlmaWVyLFxuICAgICAgICAgIHZhbHVlOiByZXN0LnZhbHVlLnZhbHVlLFxuICAgICAgICAgIC4uLihyZXN0LnZhbHVlLnZhbHVlMiAhPT0gdW5kZWZpbmVkICYmIHsgdmFsdWUyOiByZXN0LnZhbHVlLnZhbHVlMiB9KSxcbiAgICAgICAgfTtcbiAgICAgIH0gZWxzZSBpZiAocmVzdC5tb2RpZmllciA9PT0gXCJJU19OVUxMXCIgfHwgcmVzdC5tb2RpZmllciA9PT0gXCJOT1RfTlVMTFwiKSB7XG4gICAgICAgIC8vIElTX05VTEwvTk9UX05VTEwgZG9uJ3QgdXNlIHRoZSB2YWx1ZSwgYnV0IHRoZSBzY2hlbWEgc3RpbGwgcmVxdWlyZXMgaXRcbiAgICAgICAgc2NlbmVGaWx0ZXJbZmlsdGVyVHlwZV0gPSB7XG4gICAgICAgICAgbW9kaWZpZXI6IHJlc3QubW9kaWZpZXIsXG4gICAgICAgICAgdmFsdWU6IDAsXG4gICAgICAgIH07XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBQYXNzIHRocm91Z2ggYXMtaXMgKHN0cmluZyBjcml0ZXJpYSwgc3BlY2lhbCBjcml0ZXJpYSBsaWtlIHBoYXNoLCBzdGFzaF9pZCwgZXRjLilcbiAgICAgICAgc2NlbmVGaWx0ZXJbZmlsdGVyVHlwZV0gPSByZXN0O1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoXCJbU3Rhc2ggQmF0dGxlXSBGYWlsZWQgdG8gcGFyc2UgZmlsdGVyOlwiLCBjU3RyLCBlKTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gT2JqZWN0LmtleXMoc2NlbmVGaWx0ZXIpLmxlbmd0aCA+IDAgPyBzY2VuZUZpbHRlciA6IG51bGw7XG59XG5cbi8qKiBQYXJzZWQgZmlsdGVyIHN0YXRlIGZvciB0aGUgY3VycmVudCBTdGFzaCBsaXN0IFVSTC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgTGlzdEZpbHRlcnMge1xuICBmaWx0ZXJLZXk6IHN0cmluZztcbiAgc2NlbmVGaWx0ZXI6IFNjZW5lRmlsdGVyVHlwZSB8IG51bGw7XG4gIGZpbHRlckFjdGl2ZTogYm9vbGVhbjtcbn1cblxuLyoqIFJlYWQgVVJMIGZpbHRlciBzdGF0ZSBvbmNlIChjYWNoZSBrZXksIEdyYXBoUUwgc2NlbmVfZmlsdGVyLCBhY3RpdmUgZmxhZykuICovXG5leHBvcnQgZnVuY3Rpb24gcmVhZEZpbHRlcnMoKTogTGlzdEZpbHRlcnMge1xuICBjb25zdCBzZWFyY2hQYXJhbXMgPSBnZXRTZWFyY2hQYXJhbXMoKTtcbiAgY29uc3Qgc2NlbmVGaWx0ZXIgPSBnZXRTY2VuZUZpbHRlcihzZWFyY2hQYXJhbXMpO1xuICBjb25zdCBxID0gc2VhcmNoUGFyYW1zLmdldChcInFcIikgfHwgXCJcIjtcbiAgcmV0dXJuIHtcbiAgICBmaWx0ZXJLZXk6IEpTT04uc3RyaW5naWZ5KHsgcSwgZmlsdGVyOiBzY2VuZUZpbHRlciB8fCB7fSB9KSxcbiAgICBzY2VuZUZpbHRlcixcbiAgICBmaWx0ZXJBY3RpdmU6IEJvb2xlYW4oc2NlbmVGaWx0ZXIgfHwgc2VhcmNoUGFyYW1zLmhhcyhcImNcIikgfHwgc2VhcmNoUGFyYW1zLmdldChcInFcIikpLFxuICB9O1xufVxuXG4vLyBDYWNoZSBrZXkgZm9yIHRoZSBjdXJyZW50IGxpc3QgVVJMIChjcml0ZXJpYSArIHRleHQgc2VhcmNoKS5cbmV4cG9ydCBmdW5jdGlvbiBidWlsZEZpbHRlcktleSgpOiBzdHJpbmcge1xuICByZXR1cm4gcmVhZEZpbHRlcnMoKS5maWx0ZXJLZXk7XG59XG5cbi8qKiBUcnVlIHdoZW4gdGhlIGN1cnJlbnQgU3Rhc2ggbGlzdCBVUkwgaGFzIGFjdGl2ZSBmaWx0ZXJzIChjcml0ZXJpYSBhbmQvb3IgdGV4dCBzZWFyY2gpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNoZWNrRm9yRmlsdGVycygpOiBib29sZWFuIHtcbiAgcmV0dXJuIHJlYWRGaWx0ZXJzKCkuZmlsdGVyQWN0aXZlO1xufVxuIiwgIi8vIENlbnRyYWwgbXV0YWJsZSBydW50aW1lIHN0YXRlLlxuLy9cbi8vIFRoZSBvcmlnaW5hbCBwbHVnaW4gdXNlZCBtb2R1bGUtbGV2ZWwgYGxldGAgYmluZGluZ3Mgc2hhcmVkIGFjcm9zcyBtYW55IGZ1bmN0aW9ucy5cbi8vIEVTIG1vZHVsZXMgY2Fubm90IHJlYXNzaWduIGFuIGltcG9ydGVkIGJpbmRpbmcgZnJvbSBhbm90aGVyIG1vZHVsZSwgc28gYWxsIHNoYXJlZFxuLy8gbXV0YWJsZSB2YWx1ZXMgbGl2ZSBvbiB0aGlzIHNpbmdsZSBgc3RhdGVgIG9iamVjdCB0aGF0IGV2ZXJ5IG1vZHVsZSBpbXBvcnRzLlxuXG5pbXBvcnQgeyBERUZBVUxUX1NFVFRJTkdTIH0gZnJvbSBcIi4vY29uc3RhbnRzXCI7XG5pbXBvcnQgdHlwZSB7IE1vZGUsIFBhaXIsIFBsYWNlbWVudFJ1biwgUmFua3MsIFNjZW5lLCBTZXR0aW5ncyB9IGZyb20gXCIuL3R5cGVzXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgTWVtb3J5Q2FjaGUge1xuICBhbGxTY2VuZXM6IFNjZW5lW10gfCBudWxsOyAvLyBBbGwgc2NlbmVzIChubyBmaWx0ZXIpXG4gIGZpbHRlcmVkU2NlbmVzOiBTY2VuZVtdIHwgbnVsbDsgLy8gU2NlbmVzIG1hdGNoaW5nIGN1cnJlbnQgZmlsdGVyXG4gIGZpbHRlcktleTogc3RyaW5nIHwgbnVsbDsgLy8gQ3VycmVudCBmaWx0ZXIgcGFyYW1zIGZvciBjYWNoZSB2YWxpZGF0aW9uXG4gIHRpbWVzdGFtcDogbnVtYmVyIHwgbnVsbDsgLy8gV2hlbiBjYWNoZSB3YXMgcG9wdWxhdGVkXG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQmF0dGxlU3RhdGUge1xuICAvLyBDdXJyZW50IGNvbXBhcmlzb24gcGFpciBhbmQgbW9kZVxuICBjdXJyZW50UGFpcjogUGFpcjtcbiAgY3VycmVudFJhbmtzOiBSYW5rcztcbiAgY3VycmVudE1vZGU6IE1vZGU7XG4gIC8vIENoYW1waW9uIHJ1biB0cmFja2luZ1xuICBjaGFtcGlvblNjZW5lOiBTY2VuZSB8IG51bGw7IC8vIFRoZSBzY2VuZSBkZWZlbmRpbmcgKHdpbm5lciBzdGF5cyBvbilcbiAgY2hhbXBpb25XaW5zOiBudW1iZXI7IC8vIEl0cyBjdXJyZW50IHdpbiBzdHJlYWtcbiAgY2hhbXBpb25EZWZlYXRlZDogc3RyaW5nW107IC8vIElEcyBvZiBzY2VuZXMgaXQgaGFzIGJlYXRlbiBpbiB0aGlzIHJ1blxuICAvLyBQbGFjZW1lbnQgcnVuIHRyYWNraW5nXG4gIHBsYWNlbWVudDogUGxhY2VtZW50UnVuIHwgbnVsbDtcbiAgdG90YWxTY2VuZXNDb3VudDogbnVtYmVyOyAvLyBUb3RhbCBzY2VuZXMgZm9yIHBvc2l0aW9uIGRpc3BsYXlcbiAgbGVmdFBvb2xTaXplOiBudW1iZXIgfCBudWxsOyAvLyBTY2VuZXMgb24gdGhlIFwidG8gcmF0ZVwiIHNpZGUgKGZpbHRlciBvciB3aG9sZSBsaWJyYXJ5KTsgbnVsbCB1bnRpbCBsb2FkZWRcbiAgZGlzYWJsZUNob2ljZTogYm9vbGVhbjsgLy8gUHJldmVudHMgbXVsdGlwbGUgcmFwaWQgY2hvaWNlIGV2ZW50c1xuICBzYXZlZEZpbHRlclBhcmFtczogc3RyaW5nOyAvLyBTdG9yZWQgVVJMIGZpbHRlciBwYXJhbXMgdG8gZGV0ZWN0IGNoYW5nZXNcbiAgLy8gVXNlciBzZXR0aW5ncyAoZGVmYXVsdHMgdW50aWwgbG9hZFNldHRpbmdzKCkgcmVzb2x2ZXMpXG4gIHNldHRpbmdzOiBTZXR0aW5ncztcbiAgcmVzZXR0aW5nRWxvOiBib29sZWFuOyAvLyBSZXNldCBFTE8ncyBzZXR1cCBzY3JlZW4gaXMgc2hvd2luZyAoYmF0dGxlcyB3YWl0LCBsaWtlIGEgZmlyc3Qgc2V0dXApXG4gIC8vIFNodWZmbGUgc3RhdGUgZm9yIHRoZSBsZWZ0LXNpZGUgcG9vbCAocHJldmVudHMgcmVwZWF0cyB3aGVuIHNraXBwaW5nKVxuICBzaHVmZmxlZEZpbHRlcmVkU2NlbmVzOiBTY2VuZVtdO1xuICBzaHVmZmxlSW5kZXg6IG51bWJlcjtcbiAgc2h1ZmZsZUZpbHRlcktleTogc3RyaW5nIHwgbnVsbDtcbiAgLy8gU2NlbmUgY2FjaGUgKG1lbW9yeSB0aWVyKVxuICBtZW1vcnlDYWNoZTogTWVtb3J5Q2FjaGU7XG59XG5cbmV4cG9ydCBjb25zdCBzdGF0ZTogQmF0dGxlU3RhdGUgPSB7XG4gIGN1cnJlbnRQYWlyOiB7IGxlZnQ6IG51bGwsIHJpZ2h0OiBudWxsIH0sXG4gIGN1cnJlbnRSYW5rczogeyBsZWZ0OiBudWxsLCByaWdodDogbnVsbCB9LFxuICBjdXJyZW50TW9kZTogXCJzd2lzc1wiLFxuICBjaGFtcGlvblNjZW5lOiBudWxsLFxuICBjaGFtcGlvbldpbnM6IDAsXG4gIGNoYW1waW9uRGVmZWF0ZWQ6IFtdLFxuICBwbGFjZW1lbnQ6IG51bGwsXG4gIHRvdGFsU2NlbmVzQ291bnQ6IDAsXG4gIGxlZnRQb29sU2l6ZTogbnVsbCxcbiAgZGlzYWJsZUNob2ljZTogZmFsc2UsXG4gIHNhdmVkRmlsdGVyUGFyYW1zOiBcIlwiLFxuICBzZXR0aW5nczogeyAuLi5ERUZBVUxUX1NFVFRJTkdTIH0sXG4gIHJlc2V0dGluZ0VsbzogZmFsc2UsXG4gIHNodWZmbGVkRmlsdGVyZWRTY2VuZXM6IFtdLFxuICBzaHVmZmxlSW5kZXg6IDAsXG4gIHNodWZmbGVGaWx0ZXJLZXk6IG51bGwsXG4gIG1lbW9yeUNhY2hlOiB7XG4gICAgYWxsU2NlbmVzOiBudWxsLFxuICAgIGZpbHRlcmVkU2NlbmVzOiBudWxsLFxuICAgIGZpbHRlcktleTogbnVsbCxcbiAgICB0aW1lc3RhbXA6IG51bGwsXG4gIH0sXG59O1xuXG4vKiogQ2xlYXIgYW55IENoYW1waW9uIC8gUGxhY2VtZW50IHJ1biBpbiBwcm9ncmVzcy4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNldFJ1blN0YXRlKCk6IHZvaWQge1xuICBzdGF0ZS5jaGFtcGlvblNjZW5lID0gbnVsbDtcbiAgc3RhdGUuY2hhbXBpb25XaW5zID0gMDtcbiAgc3RhdGUuY2hhbXBpb25EZWZlYXRlZCA9IFtdO1xuICBzdGF0ZS5wbGFjZW1lbnQgPSBudWxsO1xufVxuXG4vKiogRm9yZ2V0IHRoZSBsZWZ0LXNpZGUgc2h1ZmZsZSBzbyB0aGUgbmV4dCBwaWNrIHJlc2h1ZmZsZXMgZnJvbSBhIGZyZXNoIHBvb2wuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzZXRTaHVmZmxlKCk6IHZvaWQge1xuICBzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzID0gW107XG4gIHN0YXRlLnNodWZmbGVJbmRleCA9IDA7XG4gIHN0YXRlLnNodWZmbGVGaWx0ZXJLZXkgPSBudWxsO1xufVxuXG4vKiogVHJ1ZSB3aGlsZSBhIENoYW1waW9uIC8gUGxhY2VtZW50IHJ1biBpcyB1bmRlciB3YXkgKHNraXAgaXMgZGlzYWJsZWQpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzUnVuQWN0aXZlKCk6IGJvb2xlYW4ge1xuICBzd2l0Y2ggKHN0YXRlLmN1cnJlbnRNb2RlKSB7XG4gICAgY2FzZSBcImNoYW1waW9uXCI6XG4gICAgICByZXR1cm4gc3RhdGUuY2hhbXBpb25TY2VuZSAhPT0gbnVsbDtcbiAgICBjYXNlIFwicGxhY2VtZW50XCI6XG4gICAgICByZXR1cm4gKHN0YXRlLnBsYWNlbWVudD8uYmF0dGxlcyA/PyAwKSA+IDA7XG4gICAgZGVmYXVsdDpcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuXG4vKiogRUxPIHNldHVwIGhhc24ndCBmaW5pc2hlZCAob3IgUmVzZXQgRUxPIGlzIHNob3dpbmcgaXQpLCBzbyBpdCBzaG93cyBpbnN0ZWFkIG9mIGxvYWRpbmcgcGFpcnMuICovXG5leHBvcnQgZnVuY3Rpb24gaXNFbG9TZXR1cFBlbmRpbmcoKTogYm9vbGVhbiB7XG4gIHJldHVybiAhc3RhdGUuc2V0dGluZ3MuZWxvU2V0dXBBdCB8fCBzdGF0ZS5yZXNldHRpbmdFbG87XG59XG4iLCAiLy8gU2NlbmUgY2FjaGU6IEluZGV4ZWREQiAoZHVyYWJsZSkgKyBpbi1tZW1vcnkgKHBlciBzZXNzaW9uKSwgc3RhbGUtd2hpbGUtcmV2YWxpZGF0ZS5cblxuaW1wb3J0IHtcbiAgQ0FDSEVfREJfTkFNRSxcbiAgQ0FDSEVfREJfVkVSU0lPTixcbiAgQ0FDSEVfTUFYX0FHRV9NUyxcbiAgQ0FDSEVfU1RPUkVfTkFNRSxcbn0gZnJvbSBcIi4vY29uc3RhbnRzXCI7XG5pbXBvcnQgeyBnZXRGaW5kRmlsdGVyLCB0eXBlIExpc3RGaWx0ZXJzIH0gZnJvbSBcIi4vZmlsdGVyc1wiO1xuaW1wb3J0IHsgRklORF9TQ0VORVNfUVVFUlksIGdyYXBocWxRdWVyeSB9IGZyb20gXCIuL2dyYXBocWxcIjtcbmltcG9ydCB7IGVsb0ZpZWxkcywgZWxvSW5zZXJ0aW9uSW5kZXgsIHNvcnRCeUVsbywgd2l0aEVsb0ZpZWxkcyB9IGZyb20gXCIuL3Njb3JlXCI7XG5pbXBvcnQgeyBzdGF0ZSB9IGZyb20gXCIuL3N0YXRlXCI7XG5pbXBvcnQgdHlwZSB7IENhY2hlRW50cnksIEVsb0ZpZWxkcywgRmluZFNjZW5lc1Jlc3VsdCwgU2NlbmUgfSBmcm9tIFwiLi90eXBlc1wiO1xuXG4vLyBPcGVuIEluZGV4ZWREQiBkYXRhYmFzZVxuZnVuY3Rpb24gb3BlbkNhY2hlREIoKTogUHJvbWlzZTxJREJEYXRhYmFzZT4ge1xuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgIGNvbnN0IHJlcXVlc3QgPSBpbmRleGVkREIub3BlbihDQUNIRV9EQl9OQU1FLCBDQUNIRV9EQl9WRVJTSU9OKTtcblxuICAgIHJlcXVlc3Qub25lcnJvciA9ICgpID0+IHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoXCJbU3Rhc2ggQmF0dGxlXSBJbmRleGVkREIgZXJyb3I6XCIsIHJlcXVlc3QuZXJyb3IpO1xuICAgICAgcmVqZWN0KHJlcXVlc3QuZXJyb3IpO1xuICAgIH07XG5cbiAgICByZXF1ZXN0Lm9uc3VjY2VzcyA9ICgpID0+IHtcbiAgICAgIHJlc29sdmUocmVxdWVzdC5yZXN1bHQpO1xuICAgIH07XG5cbiAgICByZXF1ZXN0Lm9udXBncmFkZW5lZWRlZCA9IChldmVudCkgPT4ge1xuICAgICAgY29uc3QgZGIgPSAoZXZlbnQudGFyZ2V0IGFzIElEQk9wZW5EQlJlcXVlc3QpLnJlc3VsdDtcbiAgICAgIC8vIEFueSBvbGRlciBzdG9yZSBob2xkcyBzY2VuZXMgd2l0aG91dCBFTE8gKG9yIGluIHJhdGluZyBvcmRlcik6IHN0YXJ0IGl0IG92ZXJcbiAgICAgIGlmIChkYi5vYmplY3RTdG9yZU5hbWVzLmNvbnRhaW5zKENBQ0hFX1NUT1JFX05BTUUpKSBkYi5kZWxldGVPYmplY3RTdG9yZShDQUNIRV9TVE9SRV9OQU1FKTtcbiAgICAgIGRiLmNyZWF0ZU9iamVjdFN0b3JlKENBQ0hFX1NUT1JFX05BTUUsIHsga2V5UGF0aDogXCJjYWNoZUtleVwiIH0pO1xuICAgIH07XG4gIH0pO1xufVxuXG4vLyBHZXQgY2FjaGVkIHNjZW5lcyBmcm9tIEluZGV4ZWREQlxuYXN5bmMgZnVuY3Rpb24gZ2V0Q2FjaGVkU2NlbmVzKGNhY2hlS2V5OiBzdHJpbmcpOiBQcm9taXNlPENhY2hlRW50cnkgfCBudWxsPiB7XG4gIHRyeSB7XG4gICAgY29uc3QgZGIgPSBhd2FpdCBvcGVuQ2FjaGVEQigpO1xuICAgIHJldHVybiBuZXcgUHJvbWlzZTxDYWNoZUVudHJ5IHwgbnVsbD4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgY29uc3QgdHJhbnNhY3Rpb24gPSBkYi50cmFuc2FjdGlvbihDQUNIRV9TVE9SRV9OQU1FLCBcInJlYWRvbmx5XCIpO1xuICAgICAgY29uc3Qgc3RvcmUgPSB0cmFuc2FjdGlvbi5vYmplY3RTdG9yZShDQUNIRV9TVE9SRV9OQU1FKTtcbiAgICAgIGNvbnN0IHJlcXVlc3QgPSBzdG9yZS5nZXQoY2FjaGVLZXkpO1xuXG4gICAgICByZXF1ZXN0Lm9uc3VjY2VzcyA9ICgpID0+IHtcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gcmVxdWVzdC5yZXN1bHQgYXMgQ2FjaGVFbnRyeSB8IHVuZGVmaW5lZDtcbiAgICAgICAgaWYgKHJlc3VsdCAmJiBEYXRlLm5vdygpIC0gcmVzdWx0LnRpbWVzdGFtcCA8IENBQ0hFX01BWF9BR0VfTVMpIHtcbiAgICAgICAgICByZXNvbHZlKHJlc3VsdCk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgcmVzb2x2ZShudWxsKTsgLy8gQ2FjaGUgbWlzcyBvciBleHBpcmVkXG4gICAgICAgIH1cbiAgICAgIH07XG5cbiAgICAgIHJlcXVlc3Qub25lcnJvciA9ICgpID0+IHJlamVjdChyZXF1ZXN0LmVycm9yKTtcbiAgICAgIHRyYW5zYWN0aW9uLm9uY29tcGxldGUgPSAoKSA9PiBkYi5jbG9zZSgpO1xuICAgIH0pO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIENhY2hlIHJlYWQgZXJyb3I6XCIsIGUpO1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8vIFN0b3JlIHNjZW5lcyBpbiBJbmRleGVkREJcbmFzeW5jIGZ1bmN0aW9uIHNldENhY2hlZFNjZW5lcyhcbiAgY2FjaGVLZXk6IHN0cmluZyxcbiAgc2NlbmVzOiBTY2VuZVtdLFxuICBjb3VudDogbnVtYmVyLFxuICBmaWx0ZXJLZXk/OiBzdHJpbmcsXG4gIHRpbWVzdGFtcDogbnVtYmVyID0gRGF0ZS5ub3coKSxcbik6IFByb21pc2U8dm9pZD4ge1xuICB0cnkge1xuICAgIGNvbnN0IGRiID0gYXdhaXQgb3BlbkNhY2hlREIoKTtcbiAgICByZXR1cm4gbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgY29uc3QgdHJhbnNhY3Rpb24gPSBkYi50cmFuc2FjdGlvbihDQUNIRV9TVE9SRV9OQU1FLCBcInJlYWR3cml0ZVwiKTtcbiAgICAgIGNvbnN0IHN0b3JlID0gdHJhbnNhY3Rpb24ub2JqZWN0U3RvcmUoQ0FDSEVfU1RPUkVfTkFNRSk7XG5cbiAgICAgIGNvbnN0IGRhdGE6IENhY2hlRW50cnkgPSB7XG4gICAgICAgIGNhY2hlS2V5LFxuICAgICAgICBzY2VuZXMsXG4gICAgICAgIGNvdW50LFxuICAgICAgICB0aW1lc3RhbXAsXG4gICAgICAgIC4uLihmaWx0ZXJLZXkgIT09IHVuZGVmaW5lZCAmJiB7IGZpbHRlcktleSB9KSxcbiAgICAgIH07XG5cbiAgICAgIGNvbnN0IHJlcXVlc3QgPSBzdG9yZS5wdXQoZGF0YSk7XG4gICAgICByZXF1ZXN0Lm9uc3VjY2VzcyA9ICgpID0+IHJlc29sdmUoKTtcbiAgICAgIHJlcXVlc3Qub25lcnJvciA9ICgpID0+IHJlamVjdChyZXF1ZXN0LmVycm9yKTtcbiAgICAgIHRyYW5zYWN0aW9uLm9uY29tcGxldGUgPSAoKSA9PiBkYi5jbG9zZSgpO1xuICAgIH0pO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIENhY2hlIHdyaXRlIGVycm9yOlwiLCBlKTtcbiAgfVxufVxuXG4vLyBDbGVhciBhbGwgY2FjaGVkIHNjZW5lcyAoZm9yIG1hbnVhbCByZWZyZXNoKVxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNsZWFyU2NlbmVDYWNoZSgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgdHJ5IHtcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCfl5HvuI8gQ2xlYXJpbmcgYWxsIHNjZW5lIGNhY2hlcy4uLlwiKTtcbiAgICBjb25zdCBkYiA9IGF3YWl0IG9wZW5DYWNoZURCKCk7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgIGNvbnN0IHRyYW5zYWN0aW9uID0gZGIudHJhbnNhY3Rpb24oQ0FDSEVfU1RPUkVfTkFNRSwgXCJyZWFkd3JpdGVcIik7XG4gICAgICBjb25zdCBzdG9yZSA9IHRyYW5zYWN0aW9uLm9iamVjdFN0b3JlKENBQ0hFX1NUT1JFX05BTUUpO1xuICAgICAgY29uc3QgcmVxdWVzdCA9IHN0b3JlLmNsZWFyKCk7XG5cbiAgICAgIHJlcXVlc3Qub25zdWNjZXNzID0gKCkgPT4ge1xuICAgICAgICBzdGF0ZS5tZW1vcnlDYWNoZSA9IHsgYWxsU2NlbmVzOiBudWxsLCBmaWx0ZXJlZFNjZW5lczogbnVsbCwgZmlsdGVyS2V5OiBudWxsLCB0aW1lc3RhbXA6IG51bGwgfTtcbiAgICAgICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDinIUgQWxsIGNhY2hlcyBjbGVhcmVkIChtZW1vcnkgKyBJbmRleGVkREIpXCIpO1xuICAgICAgICByZXNvbHZlKCk7XG4gICAgICB9O1xuICAgICAgcmVxdWVzdC5vbmVycm9yID0gKCkgPT4gcmVqZWN0KHJlcXVlc3QuZXJyb3IpO1xuICAgICAgdHJhbnNhY3Rpb24ub25jb21wbGV0ZSA9ICgpID0+IGRiLmNsb3NlKCk7XG4gICAgfSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0g4p2MIENhY2hlIGNsZWFyIGVycm9yOlwiLCBlKTtcbiAgfVxufVxuXG4vLyBDbGVhciBqdXN0IHRoZSBmaWx0ZXJlZCBzY2VuZXMgY2FjaGUgKGZvciBhdXRvLXJlZnJlc2ggYWZ0ZXIgcG9vbCBleGhhdXN0aW9uKVxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNsZWFyRmlsdGVyZWRDYWNoZSgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBkYiA9IGF3YWl0IG9wZW5DYWNoZURCKCk7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgIGNvbnN0IHRyYW5zYWN0aW9uID0gZGIudHJhbnNhY3Rpb24oQ0FDSEVfU1RPUkVfTkFNRSwgXCJyZWFkd3JpdGVcIik7XG4gICAgICBjb25zdCBzdG9yZSA9IHRyYW5zYWN0aW9uLm9iamVjdFN0b3JlKENBQ0hFX1NUT1JFX05BTUUpO1xuICAgICAgY29uc3QgcmVxdWVzdCA9IHN0b3JlLmRlbGV0ZShcImZpbHRlcmVkLXNjZW5lc1wiKTtcblxuICAgICAgcmVxdWVzdC5vbnN1Y2Nlc3MgPSAoKSA9PiB7XG4gICAgICAgIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzID0gbnVsbDtcbiAgICAgICAgc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyS2V5ID0gbnVsbDtcbiAgICAgICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5eR77iPIEZpbHRlcmVkIGNhY2hlIGNsZWFyZWQgKG1lbW9yeSArIEluZGV4ZWREQilcIik7XG4gICAgICAgIHJlc29sdmUoKTtcbiAgICAgIH07XG4gICAgICByZXF1ZXN0Lm9uZXJyb3IgPSAoKSA9PiByZWplY3QocmVxdWVzdC5lcnJvcik7XG4gICAgICB0cmFuc2FjdGlvbi5vbmNvbXBsZXRlID0gKCkgPT4gZGIuY2xvc2UoKTtcbiAgICB9KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnNvbGUuZXJyb3IoXCJbU3Rhc2ggQmF0dGxlXSDinYwgRmlsdGVyZWQgY2FjaGUgY2xlYXIgZXJyb3I6XCIsIGUpO1xuICAgIC8vIFN0aWxsIGNsZWFyIG1lbW9yeSBjYWNoZSBldmVuIGlmIEluZGV4ZWREQiBmYWlsc1xuICAgIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzID0gbnVsbDtcbiAgICBzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJLZXkgPSBudWxsO1xuICB9XG59XG5cbi8vIEJhY2tncm91bmQgcmVmcmVzaCAtIGZldGNoIGZyb20gbmV0d29yayBhbmQgdXBkYXRlIGNhY2hlcyBzaWxlbnRseVxuYXN5bmMgZnVuY3Rpb24gYmFja2dyb3VuZFJlZnJlc2hBbGxTY2VuZXMoKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGNhY2hlS2V5ID0gXCJhbGwtc2NlbmVzXCI7XG5cbiAgdHJ5IHtcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCflIQgQmFja2dyb3VuZCByZWZyZXNoIHN0YXJ0ZWQgKGFsbCBzY2VuZXMpLi4uXCIpO1xuICAgIGNvbnN0IHN0YXJ0VGltZSA9IERhdGUubm93KCk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBncmFwaHFsUXVlcnk8RmluZFNjZW5lc1Jlc3VsdD4oRklORF9TQ0VORVNfUVVFUlksIHtcbiAgICAgIGZpbHRlcjoge1xuICAgICAgICBwZXJfcGFnZTogLTEsXG4gICAgICAgIHNvcnQ6IFwicmF0aW5nXCIsXG4gICAgICAgIGRpcmVjdGlvbjogXCJERVNDXCIsXG4gICAgICB9LFxuICAgICAgc2NlbmVfZmlsdGVyOiBudWxsLFxuICAgIH0pO1xuXG4gICAgY29uc3Qgc2NlbmVzID0gc29ydEJ5RWxvKHJlc3VsdC5maW5kU2NlbmVzLnNjZW5lcyB8fCBbXSk7XG4gICAgY29uc3QgY291bnQgPSByZXN1bHQuZmluZFNjZW5lcy5jb3VudCB8fCBzY2VuZXMubGVuZ3RoO1xuICAgIGNvbnN0IGZldGNoVGltZSA9IERhdGUubm93KCkgLSBzdGFydFRpbWU7XG5cbiAgICBjb25zdCBvbGRDb3VudCA9IHN0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcyA/IHN0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcy5sZW5ndGggOiAwO1xuICAgIGlmIChjb3VudCAhPT0gb2xkQ291bnQpIHtcbiAgICAgIGNvbnNvbGUubG9nKFxuICAgICAgICBgW1N0YXNoIEJhdHRsZV0g8J+TiiBTY2VuZSBjb3VudCBjaGFuZ2VkOiAke29sZENvdW50fSDihpIgJHtjb3VudH0gKCR7Y291bnQgPiBvbGRDb3VudCA/IFwiK1wiIDogXCJcIn0ke2NvdW50IC0gb2xkQ291bnR9KWAsXG4gICAgICApO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g8J+TiiBTY2VuZSBjb3VudCB1bmNoYW5nZWQ6ICR7Y291bnR9YCk7XG4gICAgfVxuXG4gICAgc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzID0gc2NlbmVzO1xuICAgIHN0YXRlLm1lbW9yeUNhY2hlLnRpbWVzdGFtcCA9IERhdGUubm93KCk7XG4gICAgYXdhaXQgc2V0Q2FjaGVkU2NlbmVzKGNhY2hlS2V5LCBzY2VuZXMsIGNvdW50KTtcblxuICAgIGNvbnNvbGUubG9nKGBbU3Rhc2ggQmF0dGxlXSDinIUgQmFja2dyb3VuZCByZWZyZXNoIGNvbXBsZXRlOiAke3NjZW5lcy5sZW5ndGh9IHNjZW5lcyBpbiAke2ZldGNoVGltZX1tc2ApO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIOKdjCBCYWNrZ3JvdW5kIHJlZnJlc2ggZmFpbGVkOlwiLCBlKTtcbiAgfVxufVxuXG4vLyBHZXQgYWxsIHNjZW5lcyAodXNlcyBjYWNoZSB3aXRoIHN0YWxlLXdoaWxlLXJldmFsaWRhdGUpXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ2V0QWxsU2NlbmVzQ2FjaGVkKCk6IFByb21pc2U8eyBzY2VuZXM6IFNjZW5lW107IGNvdW50OiBudW1iZXIgfT4ge1xuICBjb25zdCBjYWNoZUtleSA9IFwiYWxsLXNjZW5lc1wiO1xuXG4gIC8vIENoZWNrIG1lbW9yeSBjYWNoZSBmaXJzdCAtIHJldHVybiBpbW1lZGlhdGVseSBpZiBhdmFpbGFibGVcbiAgaWYgKHN0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcykge1xuICAgIGNvbnN0IGNhY2hlQWdlID0gTWF0aC5yb3VuZCgoRGF0ZS5ub3coKSAtIChzdGF0ZS5tZW1vcnlDYWNoZS50aW1lc3RhbXAgPz8gMCkpIC8gMTAwMCk7XG4gICAgY29uc3QgaXNTdGFsZSA9IERhdGUubm93KCkgLSAoc3RhdGUubWVtb3J5Q2FjaGUudGltZXN0YW1wID8/IDApID49IENBQ0hFX01BWF9BR0VfTVM7XG5cbiAgICBjb25zb2xlLmxvZyhcbiAgICAgIGBbU3Rhc2ggQmF0dGxlXSDwn5K+IE1lbW9yeSBjYWNoZSBoaXQgKGFsbCBzY2VuZXMpOiAke3N0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcy5sZW5ndGh9IHNjZW5lcywgYWdlOiAke2NhY2hlQWdlfXMke2lzU3RhbGUgPyBcIiBbU1RBTEVdXCIgOiBcIlwifWAsXG4gICAgKTtcblxuICAgIGlmIChpc1N0YWxlKSB7XG4gICAgICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g4o+wIENhY2hlIHN0YWxlICg+JHtDQUNIRV9NQVhfQUdFX01TIC8gMTAwMH1zKSwgdHJpZ2dlcmluZyBiYWNrZ3JvdW5kIHJlZnJlc2guLi5gKTtcbiAgICAgIGJhY2tncm91bmRSZWZyZXNoQWxsU2NlbmVzKCk7IC8vIERvbid0IGF3YWl0IC0gcnVucyBpbiBiYWNrZ3JvdW5kXG4gICAgfVxuICAgIHJldHVybiB7IHNjZW5lczogc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzLCBjb3VudDogc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzLmxlbmd0aCB9O1xuICB9XG5cbiAgLy8gQ2hlY2sgSW5kZXhlZERCIGNhY2hlIC0gcmV0dXJuIGltbWVkaWF0ZWx5IGlmIGF2YWlsYWJsZVxuICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCflI0gTWVtb3J5IGNhY2hlIG1pc3MsIGNoZWNraW5nIEluZGV4ZWREQi4uLlwiKTtcbiAgY29uc3QgY2FjaGVkID0gYXdhaXQgZ2V0Q2FjaGVkU2NlbmVzKGNhY2hlS2V5KTtcbiAgaWYgKGNhY2hlZCkge1xuICAgIGNvbnN0IGNhY2hlQWdlID0gTWF0aC5yb3VuZCgoRGF0ZS5ub3coKSAtIGNhY2hlZC50aW1lc3RhbXApIC8gMTAwMCk7XG4gICAgY29uc3QgaXNTdGFsZSA9IERhdGUubm93KCkgLSBjYWNoZWQudGltZXN0YW1wID49IENBQ0hFX01BWF9BR0VfTVM7XG5cbiAgICBjb25zb2xlLmxvZyhcbiAgICAgIGBbU3Rhc2ggQmF0dGxlXSDwn5K/IEluZGV4ZWREQiBjYWNoZSBoaXQgKGFsbCBzY2VuZXMpOiAke2NhY2hlZC5zY2VuZXMubGVuZ3RofSBzY2VuZXMsIGFnZTogJHtjYWNoZUFnZX1zJHtpc1N0YWxlID8gXCIgW1NUQUxFXVwiIDogXCJcIn1gLFxuICAgICk7XG5cbiAgICBzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXMgPSBjYWNoZWQuc2NlbmVzO1xuICAgIHN0YXRlLm1lbW9yeUNhY2hlLnRpbWVzdGFtcCA9IGNhY2hlZC50aW1lc3RhbXA7XG5cbiAgICBpZiAoaXNTdGFsZSkge1xuICAgICAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIOKPsCBDYWNoZSBzdGFsZSAoPiR7Q0FDSEVfTUFYX0FHRV9NUyAvIDEwMDB9cyksIHRyaWdnZXJpbmcgYmFja2dyb3VuZCByZWZyZXNoLi4uYCk7XG4gICAgICBiYWNrZ3JvdW5kUmVmcmVzaEFsbFNjZW5lcygpOyAvLyBEb24ndCBhd2FpdCAtIHJ1bnMgaW4gYmFja2dyb3VuZFxuICAgIH1cbiAgICByZXR1cm4geyBzY2VuZXM6IGNhY2hlZC5zY2VuZXMsIGNvdW50OiBjYWNoZWQuY291bnQgfTtcbiAgfVxuXG4gIC8vIE5vIGNhY2hlIGF0IGFsbCAtIG11c3QgZmV0Y2ggZnJvbSBuZXR3b3JrIChibG9ja2luZylcbiAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn4yQIE5vIGNhY2hlIGZvdW5kLCBmZXRjaGluZyBhbGwgc2NlbmVzIGZyb20gbmV0d29yayAoZmlyc3QgbG9hZCkuLi5cIik7XG4gIGNvbnN0IHN0YXJ0VGltZSA9IERhdGUubm93KCk7XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZ3JhcGhxbFF1ZXJ5PEZpbmRTY2VuZXNSZXN1bHQ+KEZJTkRfU0NFTkVTX1FVRVJZLCB7XG4gICAgZmlsdGVyOiB7XG4gICAgICBwZXJfcGFnZTogLTEsXG4gICAgICBzb3J0OiBcInJhdGluZ1wiLFxuICAgICAgZGlyZWN0aW9uOiBcIkRFU0NcIixcbiAgICB9LFxuICAgIHNjZW5lX2ZpbHRlcjogbnVsbCxcbiAgfSk7XG5cbiAgY29uc3Qgc2NlbmVzID0gc29ydEJ5RWxvKHJlc3VsdC5maW5kU2NlbmVzLnNjZW5lcyB8fCBbXSk7XG4gIGNvbnN0IGNvdW50ID0gcmVzdWx0LmZpbmRTY2VuZXMuY291bnQgfHwgc2NlbmVzLmxlbmd0aDtcbiAgY29uc3QgZmV0Y2hUaW1lID0gRGF0ZS5ub3coKSAtIHN0YXJ0VGltZTtcblxuICBzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXMgPSBzY2VuZXM7XG4gIHN0YXRlLm1lbW9yeUNhY2hlLnRpbWVzdGFtcCA9IERhdGUubm93KCk7XG4gIGF3YWl0IHNldENhY2hlZFNjZW5lcyhjYWNoZUtleSwgc2NlbmVzLCBjb3VudCk7XG5cbiAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIOKchSBGZXRjaGVkIGFuZCBjYWNoZWQgJHtzY2VuZXMubGVuZ3RofSBzY2VuZXMgaW4gJHtmZXRjaFRpbWV9bXNgKTtcbiAgcmV0dXJuIHsgc2NlbmVzLCBjb3VudCB9O1xufVxuXG4vLyBCYWNrZ3JvdW5kIHJlZnJlc2ggZm9yIGZpbHRlcmVkIHNjZW5lc1xuYXN5bmMgZnVuY3Rpb24gYmFja2dyb3VuZFJlZnJlc2hGaWx0ZXJlZFNjZW5lcyhmaWx0ZXJzOiBMaXN0RmlsdGVycyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBjYWNoZUtleSA9IFwiZmlsdGVyZWQtc2NlbmVzXCI7XG5cbiAgdHJ5IHtcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCflIQgQmFja2dyb3VuZCByZWZyZXNoIHN0YXJ0ZWQgKGZpbHRlcmVkIHNjZW5lcykuLi5cIik7XG4gICAgY29uc3Qgc3RhcnRUaW1lID0gRGF0ZS5ub3coKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGdyYXBocWxRdWVyeTxGaW5kU2NlbmVzUmVzdWx0PihGSU5EX1NDRU5FU19RVUVSWSwge1xuICAgICAgZmlsdGVyOiBnZXRGaW5kRmlsdGVyKHtcbiAgICAgICAgcGVyX3BhZ2U6IC0xLFxuICAgICAgICBzb3J0OiBcInJhdGluZ1wiLFxuICAgICAgICBkaXJlY3Rpb246IFwiREVTQ1wiLFxuICAgICAgfSksXG4gICAgICBzY2VuZV9maWx0ZXI6IGZpbHRlcnMuc2NlbmVGaWx0ZXIsXG4gICAgfSk7XG5cbiAgICBjb25zdCBzY2VuZXMgPSBzb3J0QnlFbG8ocmVzdWx0LmZpbmRTY2VuZXMuc2NlbmVzIHx8IFtdKTtcbiAgICBjb25zdCBjb3VudCA9IHJlc3VsdC5maW5kU2NlbmVzLmNvdW50IHx8IHNjZW5lcy5sZW5ndGg7XG4gICAgY29uc3QgZmV0Y2hUaW1lID0gRGF0ZS5ub3coKSAtIHN0YXJ0VGltZTtcblxuICAgIC8vIE9ubHkgdXBkYXRlIGlmIHN0aWxsIG9uIHNhbWUgZmlsdGVyXG4gICAgaWYgKHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcktleSA9PT0gZmlsdGVycy5maWx0ZXJLZXkpIHtcbiAgICAgIGNvbnN0IG9sZENvdW50ID0gc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXMgPyBzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJlZFNjZW5lcy5sZW5ndGggOiAwO1xuICAgICAgaWYgKGNvdW50ICE9PSBvbGRDb3VudCkge1xuICAgICAgICBjb25zb2xlLmxvZyhcbiAgICAgICAgICBgW1N0YXNoIEJhdHRsZV0g8J+TiiBGaWx0ZXJlZCBjb3VudCBjaGFuZ2VkOiAke29sZENvdW50fSDihpIgJHtjb3VudH0gKCR7Y291bnQgPiBvbGRDb3VudCA/IFwiK1wiIDogXCJcIn0ke2NvdW50IC0gb2xkQ291bnR9KWAsXG4gICAgICAgICk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g8J+TiiBGaWx0ZXJlZCBjb3VudCB1bmNoYW5nZWQ6ICR7Y291bnR9YCk7XG4gICAgICB9XG5cbiAgICAgIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzID0gc2NlbmVzO1xuICAgICAgc3RhdGUubWVtb3J5Q2FjaGUudGltZXN0YW1wID0gRGF0ZS5ub3coKTtcbiAgICAgIGF3YWl0IHNldENhY2hlZFNjZW5lcyhjYWNoZUtleSwgc2NlbmVzLCBjb3VudCwgZmlsdGVycy5maWx0ZXJLZXkpO1xuXG4gICAgICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g4pyFIEJhY2tncm91bmQgcmVmcmVzaCBjb21wbGV0ZTogJHtzY2VuZXMubGVuZ3RofSBmaWx0ZXJlZCBzY2VuZXMgaW4gJHtmZXRjaFRpbWV9bXNgKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDimqDvuI8gRmlsdGVyIGNoYW5nZWQgZHVyaW5nIHJlZnJlc2gsIGRpc2NhcmRpbmcgcmVzdWx0c1wiKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0g4p2MIEJhY2tncm91bmQgcmVmcmVzaCAoZmlsdGVyZWQpIGZhaWxlZDpcIiwgZSk7XG4gIH1cbn1cblxuLy8gR2V0IGZpbHRlcmVkIHNjZW5lcyAodXNlcyBjYWNoZSB3aXRoIHN0YWxlLXdoaWxlLXJldmFsaWRhdGUpXG4vLyBOT1RFOiBPbmx5IE9ORSBmaWx0ZXJlZCBjYWNoZSBpcyBrZXB0IChvdmVyd3JpdGVzIHByZXZpb3VzIGZpbHRlciBjYWNoZSB0byBwcmV2ZW50IEluZGV4ZWREQiBibG9hdClcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXRGaWx0ZXJlZFNjZW5lc0NhY2hlZChcbiAgZmlsdGVyczogTGlzdEZpbHRlcnMsXG4pOiBQcm9taXNlPHsgc2NlbmVzOiBTY2VuZVtdOyBjb3VudDogbnVtYmVyIH0+IHtcbiAgY29uc3QgeyBmaWx0ZXJLZXksIHNjZW5lRmlsdGVyIH0gPSBmaWx0ZXJzO1xuICBjb25zdCBjYWNoZUtleSA9IFwiZmlsdGVyZWQtc2NlbmVzXCI7IC8vIFNpbmdsZSBrZXkgLSBvdmVyd3JpdGVzIHByZXZpb3VzIGZpbHRlciBjYWNoZVxuXG4gIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+UjiBGaWx0ZXIgYWN0aXZlLCBjaGVja2luZyBmaWx0ZXJlZCBjYWNoZS4uLlwiKTtcblxuICAvLyBDaGVjayBtZW1vcnkgY2FjaGUgZmlyc3QgLSByZXR1cm4gaW1tZWRpYXRlbHkgaWYgYXZhaWxhYmxlIGFuZCBzYW1lIGZpbHRlclxuICBpZiAoc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXMgJiYgc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyS2V5ID09PSBmaWx0ZXJLZXkpIHtcbiAgICBjb25zdCBjYWNoZUFnZSA9IE1hdGgucm91bmQoKERhdGUubm93KCkgLSAoc3RhdGUubWVtb3J5Q2FjaGUudGltZXN0YW1wID8/IDApKSAvIDEwMDApO1xuICAgIGNvbnN0IGlzU3RhbGUgPSBEYXRlLm5vdygpIC0gKHN0YXRlLm1lbW9yeUNhY2hlLnRpbWVzdGFtcCA/PyAwKSA+PSBDQUNIRV9NQVhfQUdFX01TO1xuXG4gICAgY29uc29sZS5sb2coXG4gICAgICBgW1N0YXNoIEJhdHRsZV0g8J+SviBNZW1vcnkgY2FjaGUgaGl0IChmaWx0ZXJlZCk6ICR7c3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXMubGVuZ3RofSBzY2VuZXMsIGFnZTogJHtjYWNoZUFnZX1zJHtpc1N0YWxlID8gXCIgW1NUQUxFXVwiIDogXCJcIn1gLFxuICAgICk7XG5cbiAgICBpZiAoaXNTdGFsZSkge1xuICAgICAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIOKPsCBDYWNoZSBzdGFsZSAoPiR7Q0FDSEVfTUFYX0FHRV9NUyAvIDEwMDB9cyksIHRyaWdnZXJpbmcgYmFja2dyb3VuZCByZWZyZXNoLi4uYCk7XG4gICAgICBiYWNrZ3JvdW5kUmVmcmVzaEZpbHRlcmVkU2NlbmVzKGZpbHRlcnMpO1xuICAgIH1cbiAgICByZXR1cm4geyBzY2VuZXM6IHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzLCBjb3VudDogc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXMubGVuZ3RoIH07XG4gIH1cblxuICAvLyBDaGVjayBJbmRleGVkREIgY2FjaGUgKG9ubHkgaWYgZmlsdGVyIGtleSBtYXRjaGVzKVxuICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCflI0gTWVtb3J5IGNhY2hlIG1pc3MgKGZpbHRlcmVkKSwgY2hlY2tpbmcgSW5kZXhlZERCLi4uXCIpO1xuICBjb25zdCBjYWNoZWQgPSBhd2FpdCBnZXRDYWNoZWRTY2VuZXMoY2FjaGVLZXkpO1xuICBpZiAoY2FjaGVkICYmIGNhY2hlZC5maWx0ZXJLZXkgPT09IGZpbHRlcktleSkge1xuICAgIGNvbnN0IGNhY2hlQWdlID0gTWF0aC5yb3VuZCgoRGF0ZS5ub3coKSAtIGNhY2hlZC50aW1lc3RhbXApIC8gMTAwMCk7XG4gICAgY29uc3QgaXNTdGFsZSA9IERhdGUubm93KCkgLSBjYWNoZWQudGltZXN0YW1wID49IENBQ0hFX01BWF9BR0VfTVM7XG5cbiAgICBjb25zb2xlLmxvZyhcbiAgICAgIGBbU3Rhc2ggQmF0dGxlXSDwn5K/IEluZGV4ZWREQiBjYWNoZSBoaXQgKGZpbHRlcmVkKTogJHtjYWNoZWQuc2NlbmVzLmxlbmd0aH0gc2NlbmVzLCBhZ2U6ICR7Y2FjaGVBZ2V9cyR7aXNTdGFsZSA/IFwiIFtTVEFMRV1cIiA6IFwiXCJ9YCxcbiAgICApO1xuXG4gICAgc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXMgPSBjYWNoZWQuc2NlbmVzO1xuICAgIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcktleSA9IGZpbHRlcktleTtcbiAgICBzdGF0ZS5tZW1vcnlDYWNoZS50aW1lc3RhbXAgPSBjYWNoZWQudGltZXN0YW1wO1xuXG4gICAgaWYgKGlzU3RhbGUpIHtcbiAgICAgIGNvbnNvbGUubG9nKGBbU3Rhc2ggQmF0dGxlXSDij7AgQ2FjaGUgc3RhbGUgKD4ke0NBQ0hFX01BWF9BR0VfTVMgLyAxMDAwfXMpLCB0cmlnZ2VyaW5nIGJhY2tncm91bmQgcmVmcmVzaC4uLmApO1xuICAgICAgYmFja2dyb3VuZFJlZnJlc2hGaWx0ZXJlZFNjZW5lcyhmaWx0ZXJzKTtcbiAgICB9XG4gICAgcmV0dXJuIHsgc2NlbmVzOiBjYWNoZWQuc2NlbmVzLCBjb3VudDogY2FjaGVkLmNvdW50IH07XG4gIH1cblxuICBpZiAoY2FjaGVkKSB7XG4gICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5K/IEluZGV4ZWREQiBjYWNoZSBleGlzdHMgYnV0IGZpbHRlciBjaGFuZ2VkLCBmZXRjaGluZyBuZXcgZGF0YS4uLlwiKTtcbiAgfSBlbHNlIHtcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCfkr8gSW5kZXhlZERCIGNhY2hlIG1pc3MgKGZpbHRlcmVkKVwiKTtcbiAgfVxuXG4gIC8vIE5vIG1hdGNoaW5nIGNhY2hlIC0gbXVzdCBmZXRjaCBmcm9tIG5ldHdvcmsgKGJsb2NraW5nKVxuICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCfjJAgRmV0Y2hpbmcgZmlsdGVyZWQgc2NlbmVzIGZyb20gbmV0d29yay4uLlwiKTtcbiAgY29uc3Qgc3RhcnRUaW1lID0gRGF0ZS5ub3coKTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBncmFwaHFsUXVlcnk8RmluZFNjZW5lc1Jlc3VsdD4oRklORF9TQ0VORVNfUVVFUlksIHtcbiAgICBmaWx0ZXI6IGdldEZpbmRGaWx0ZXIoe1xuICAgICAgcGVyX3BhZ2U6IC0xLFxuICAgICAgc29ydDogXCJyYXRpbmdcIixcbiAgICAgIGRpcmVjdGlvbjogXCJERVNDXCIsXG4gICAgfSksXG4gICAgc2NlbmVfZmlsdGVyOiBzY2VuZUZpbHRlcixcbiAgfSk7XG5cbiAgY29uc3Qgc2NlbmVzID0gc29ydEJ5RWxvKHJlc3VsdC5maW5kU2NlbmVzLnNjZW5lcyB8fCBbXSk7XG4gIGNvbnN0IGNvdW50ID0gcmVzdWx0LmZpbmRTY2VuZXMuY291bnQgfHwgc2NlbmVzLmxlbmd0aDtcbiAgY29uc3QgZmV0Y2hUaW1lID0gRGF0ZS5ub3coKSAtIHN0YXJ0VGltZTtcblxuICBzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJlZFNjZW5lcyA9IHNjZW5lcztcbiAgc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyS2V5ID0gZmlsdGVyS2V5O1xuICBzdGF0ZS5tZW1vcnlDYWNoZS50aW1lc3RhbXAgPSBEYXRlLm5vdygpO1xuICBhd2FpdCBzZXRDYWNoZWRTY2VuZXMoY2FjaGVLZXksIHNjZW5lcywgY291bnQsIGZpbHRlcktleSk7XG5cbiAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIOKchSBGZXRjaGVkIGFuZCBjYWNoZWQgJHtzY2VuZXMubGVuZ3RofSBmaWx0ZXJlZCBzY2VuZXMgaW4gJHtmZXRjaFRpbWV9bXNgKTtcbiAgcmV0dXJuIHsgc2NlbmVzLCBjb3VudCB9O1xufVxuXG4vKiogU2V0IChvciB3aXRoIG51bGwsIHJlbW92ZSkgdGhlIEVMTyBmaWVsZHMgb24gb25lIHNjZW5lIG9iamVjdC4gKi9cbmZ1bmN0aW9uIGFwcGx5RWxvKHNjZW5lOiBTY2VuZSwgdmFsdWU6IEVsb0ZpZWxkcyB8IG51bGwpOiB2b2lkIHtcbiAgc2NlbmUuY3VzdG9tX2ZpZWxkcyA9IHdpdGhFbG9GaWVsZHMoc2NlbmUuY3VzdG9tX2ZpZWxkcywgdmFsdWUpO1xufVxuXG4vKipcbiAqIFRoZSBjYWNoZWQgY29weSBvZiBhIHNjZW5lIChhbGwgc2NlbmVzIGZpcnN0LCB0aGVuIHRoZSBmaWx0ZXJlZCBvbmVzKSwgb3IgdGhlIHNjZW5lIGl0c2VsZiBpZlxuICogbmVpdGhlciBoYXMgaXQuIFNjZW5lIG9iamVjdHMgaGVsZCBhY3Jvc3MgYmF0dGxlcyAodGhlIHNodWZmbGUsIGEgc2F2ZWQgcGFpciwgYSBDaGFtcGlvbiBvclxuICogUGxhY2VtZW50IHJ1bikgZ28gc3RhbGUgb25jZSBhIGJhY2tncm91bmQgcmVmcmVzaCBzd2FwcyBpbiBuZXcgY29waWVzLCBzbyBiYXR0bGUgbWF0aCByZWFkc1xuICogRUxPIGFuZCBiYXR0bGVzIGZyb20gdGhpcyBpbnN0ZWFkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbGF0ZXN0U2NlbmUoc2NlbmU6IFNjZW5lKTogU2NlbmUge1xuICByZXR1cm4gKFxuICAgIHN0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcz8uZmluZCgocykgPT4gcy5pZCA9PT0gc2NlbmUuaWQpID8/XG4gICAgc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXM/LmZpbmQoKHMpID0+IHMuaWQgPT09IHNjZW5lLmlkKSA/P1xuICAgIHNjZW5lXG4gICk7XG59XG5cbi8qKlxuICogU2V0IChvciB3aXRoIG51bGwsIHJlbW92ZSkgYSBzY2VuZSdzIEVMTyBvbiBgc2NlbmVgIGl0c2VsZiBhbmQgb24gaXRzIGNhY2hlZCBjb3BpZXMsIGFuZCBtb3ZlXG4gKiB0aGUgY2FjaGVkIGNvcGllcyB0byB0aGVpciBuZXcgcGxhY2UgaW4gdGhlIEVMTyBvcmRlciBzbyByYW5rcyBzdGF5IHJpZ2h0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2V0RWxvSW5DYWNoZShzY2VuZTogU2NlbmUsIHZhbHVlOiBFbG9GaWVsZHMgfCBudWxsKTogdm9pZCB7XG4gIGFwcGx5RWxvKHNjZW5lLCB2YWx1ZSk7XG4gIGZvciAoY29uc3QgcG9vbCBvZiBbc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzLCBzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJlZFNjZW5lc10pIHtcbiAgICBjb25zdCBpZHggPSBwb29sID8gcG9vbC5maW5kSW5kZXgoKHMpID0+IHMuaWQgPT09IHNjZW5lLmlkKSA6IC0xO1xuICAgIGlmICghcG9vbCB8fCBpZHggPT09IC0xKSBjb250aW51ZTtcbiAgICBjb25zdCBbY2FjaGVkXSA9IHBvb2wuc3BsaWNlKGlkeCwgMSk7XG4gICAgaWYgKGNhY2hlZCAhPT0gc2NlbmUpIGFwcGx5RWxvKGNhY2hlZCwgdmFsdWUpO1xuICAgIHBvb2wuc3BsaWNlKHZhbHVlID8gZWxvSW5zZXJ0aW9uSW5kZXgocG9vbCwgdmFsdWUuZWxvKSA6IHBvb2wubGVuZ3RoLCAwLCBjYWNoZWQpO1xuICB9XG4gIHBlcnNpc3RDYWNoZVNvb24oKTtcbn1cblxuLyoqIFNldCB0aGUgU3Rhc2ggcmF0aW5nIG9uIGNhY2hlZCBzY2VuZXMgKGFmdGVyIFN0YXNoIEJhdHRsZSB3cm90ZSB0aGVtKS4gT3JkZXIgaXMgRUxPLCBzbyB1bmNoYW5nZWQuICovXG5leHBvcnQgZnVuY3Rpb24gc2V0UmF0aW5nc0luQ2FjaGUocmF0aW5nczogTWFwPHN0cmluZywgbnVtYmVyPik6IHZvaWQge1xuICBmb3IgKGNvbnN0IHBvb2wgb2YgW3N0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcywgc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXNdKSB7XG4gICAgZm9yIChjb25zdCBzY2VuZSBvZiBwb29sID8/IFtdKSB7XG4gICAgICBjb25zdCByYXRpbmcgPSByYXRpbmdzLmdldChzY2VuZS5pZCk7XG4gICAgICBpZiAocmF0aW5nICE9PSB1bmRlZmluZWQpIHNjZW5lLnJhdGluZzEwMCA9IHJhdGluZztcbiAgICB9XG4gIH1cbiAgcGVyc2lzdENhY2hlU29vbigpO1xufVxuXG4vKipcbiAqIEJyaW5nIGEgc2NlbmUncyBjYWNoZWQgY29waWVzIGluIGxpbmUgd2l0aCBmcmVzaCB2YWx1ZXMgZnJvbSBTdGFzaCAoaXRzIEVMTyBmaWVsZHMgYW5kIFN0YXNoXG4gKiByYXRpbmcpLCBtb3ZpbmcgdGhlbSB0byB0aGVpciBwbGFjZSBpbiB0aGUgRUxPIG9yZGVyLiBGb3Igc2NlbmVzIGZldGNoZWQgb24gdGhlaXIgb3duIChhXG4gKiByZXN0b3JlZCBwYWlyLCBhIHNjZW5lIHBhZ2UgYmF0dGxlKSwgd2hpY2ggbWF5IGJlIG5ld2VyIHRoYW4gdGhlIGNhY2hlOiBjaGFuZ2VkIGluIGFub3RoZXJcbiAqIHRhYiwgc2F5LlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVmcmVzaFNjZW5lSW5DYWNoZShmcmVzaDogU2NlbmUpOiB2b2lkIHtcbiAgZm9yIChjb25zdCBwb29sIG9mIFtzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXMsIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzXSkge1xuICAgIGNvbnN0IGNhY2hlZCA9IHBvb2w/LmZpbmQoKHMpID0+IHMuaWQgPT09IGZyZXNoLmlkKTtcbiAgICBpZiAoY2FjaGVkKSBjYWNoZWQucmF0aW5nMTAwID0gZnJlc2gucmF0aW5nMTAwID8/IG51bGw7XG4gIH1cbiAgc2V0RWxvSW5DYWNoZShmcmVzaCwgZWxvRmllbGRzKGZyZXNoKSk7XG59XG5cbi8qKiBXcml0ZSB0aGUgaW4tbWVtb3J5IHNjZW5lIGxpc3RzIGJhY2sgdG8gSW5kZXhlZERCIHRoaXMgbG9uZyBhZnRlciB0aGUgbGFzdCBjaGFuZ2UuICovXG5jb25zdCBQRVJTSVNUX0RFQk9VTkNFX01TID0gMTAwMDtcbmxldCBwZXJzaXN0VGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XG5cbi8qKlxuICogQmF0dGxlcyBjaGFuZ2UgdGhlIGluLW1lbW9yeSBsaXN0cyBvbmx5OyB3aXRob3V0IHRoaXMsIGEgcmVsb2FkIHdpdGhpbiBDQUNIRV9NQVhfQUdFX01TIHdvdWxkXG4gKiByZWFkIHRoZSBJbmRleGVkREIgY29weSBmcm9tIGJlZm9yZSB0aGVtIChvbGQgRUxPLCBvbGQgb3JkZXIpLiBEZWJvdW5jZWQsIHNvIGEgcGljaydzIHdyaXRlc1xuICogYW5kIGl0cyBTdGFzaCByYXRpbmcgc3luYyBhcmUgc2F2ZWQgdG9nZXRoZXIuXG4gKi9cbmZ1bmN0aW9uIHBlcnNpc3RDYWNoZVNvb24oKTogdm9pZCB7XG4gIGlmICh0eXBlb2YgaW5kZXhlZERCID09PSBcInVuZGVmaW5lZFwiKSByZXR1cm47XG4gIGlmIChwZXJzaXN0VGltZXIpIGNsZWFyVGltZW91dChwZXJzaXN0VGltZXIpO1xuICBwZXJzaXN0VGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICBwZXJzaXN0VGltZXIgPSBudWxsO1xuICAgIHZvaWQgcGVyc2lzdENhY2hlKCk7XG4gIH0sIFBFUlNJU1RfREVCT1VOQ0VfTVMpO1xufVxuXG4vKiogU2F2ZSB0aGUgaW4tbWVtb3J5IGxpc3RzIG92ZXIgdGhlaXIgSW5kZXhlZERCIGVudHJpZXMsIGtlZXBpbmcgZWFjaCBlbnRyeSdzIHRpbWVzdGFtcC4gKi9cbmFzeW5jIGZ1bmN0aW9uIHBlcnNpc3RDYWNoZSgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgbGlzdHM6IFtzdHJpbmcsIFNjZW5lW10gfCBudWxsXVtdID0gW1xuICAgIFtcImFsbC1zY2VuZXNcIiwgc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzXSxcbiAgICBbXCJmaWx0ZXJlZC1zY2VuZXNcIiwgc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXNdLFxuICBdO1xuICBmb3IgKGNvbnN0IFtjYWNoZUtleSwgc2NlbmVzXSBvZiBsaXN0cykge1xuICAgIGlmICghc2NlbmVzKSBjb250aW51ZTtcbiAgICBjb25zdCBjYWNoZWQgPSBhd2FpdCBnZXRDYWNoZWRTY2VuZXMoY2FjaGVLZXkpO1xuICAgIC8vIE1pc3Npbmcgb3IgZXhwaXJlZDogdGhlIG5leHQgbG9hZCBmZXRjaGVzIGZyZXNoIGFueXdheS4gQSBkaWZmZXJlbnQgZmlsdGVyOiBub3QgdGhpcyBsaXN0LlxuICAgIGlmICghY2FjaGVkKSBjb250aW51ZTtcbiAgICBpZiAoY2FjaGVLZXkgPT09IFwiZmlsdGVyZWQtc2NlbmVzXCIgJiYgY2FjaGVkLmZpbHRlcktleSAhPT0gc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyS2V5KSBjb250aW51ZTtcbiAgICBhd2FpdCBzZXRDYWNoZWRTY2VuZXMoY2FjaGVLZXksIHNjZW5lcywgc2NlbmVzLmxlbmd0aCwgY2FjaGVkLmZpbHRlcktleSwgY2FjaGVkLnRpbWVzdGFtcCk7XG4gIH1cbn1cblxuLy8gRHJvcCBhIGRlbGV0ZWQgc2NlbmUgZnJvbSBldmVyeSBjYWNoZSB0aWVyIGFuZCB0aGUgbGVmdC1zaWRlIHNodWZmbGVcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZW1vdmVTY2VuZUV2ZXJ5d2hlcmUoc2NlbmVJZDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHdpdGhvdXQgPSAoc2NlbmVzOiBTY2VuZVtdIHwgbnVsbCk6IFNjZW5lW10gfCBudWxsID0+XG4gICAgc2NlbmVzID8gc2NlbmVzLmZpbHRlcigocykgPT4gcy5pZCAhPT0gc2NlbmVJZCkgOiBzY2VuZXM7XG5cbiAgc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzID0gd2l0aG91dChzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXMpO1xuICBzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJlZFNjZW5lcyA9IHdpdGhvdXQoc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXMpO1xuXG4gIGNvbnN0IHNodWZmbGVJZHggPSBzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzLmZpbmRJbmRleCgocykgPT4gcy5pZCA9PT0gc2NlbmVJZCk7XG4gIGlmIChzaHVmZmxlSWR4ICE9PSAtMSkge1xuICAgIHN0YXRlLnNodWZmbGVkRmlsdGVyZWRTY2VuZXMuc3BsaWNlKHNodWZmbGVJZHgsIDEpO1xuICAgIGlmIChzaHVmZmxlSWR4IDwgc3RhdGUuc2h1ZmZsZUluZGV4KSBzdGF0ZS5zaHVmZmxlSW5kZXgtLTtcbiAgfVxuXG4gIGZvciAoY29uc3QgY2FjaGVLZXkgb2YgW1wiYWxsLXNjZW5lc1wiLCBcImZpbHRlcmVkLXNjZW5lc1wiXSkge1xuICAgIGNvbnN0IGNhY2hlZCA9IGF3YWl0IGdldENhY2hlZFNjZW5lcyhjYWNoZUtleSk7XG4gICAgaWYgKGNhY2hlZCAmJiBjYWNoZWQuc2NlbmVzLnNvbWUoKHMpID0+IHMuaWQgPT09IHNjZW5lSWQpKSB7XG4gICAgICBjb25zdCBzY2VuZXMgPSBjYWNoZWQuc2NlbmVzLmZpbHRlcigocykgPT4gcy5pZCAhPT0gc2NlbmVJZCk7XG4gICAgICAvLyBLZWVwIHRoZSBvcmlnaW5hbCB0aW1lc3RhbXA6IHJlbW92aW5nIG9uZSBzY2VuZSBkb2Vzbid0IG1ha2UgdGhlIHJlc3QgYW55IGZyZXNoZXJcbiAgICAgIGF3YWl0IHNldENhY2hlZFNjZW5lcyhjYWNoZUtleSwgc2NlbmVzLCBzY2VuZXMubGVuZ3RoLCBjYWNoZWQuZmlsdGVyS2V5LCBjYWNoZWQudGltZXN0YW1wKTtcbiAgICB9XG4gIH1cbiAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIPCfl5HvuI8gUmVtb3ZlZCBzY2VuZSAke3NjZW5lSWR9IGZyb20gY2FjaGVzYCk7XG59XG4iLCAiLy8gU2NlbmUgbG9va3VwcyBmb3IgZGV0ZWN0aW5nIHNjZW5lcyBkZWxldGVkIHdoaWxlIHRoZXkgd2VyZSBpbiBhIGJhdHRsZSwgYW5kIGZvciBicmluZ2luZyBhXHJcbi8vIHNhdmVkIHBhaXIncyBFTE8gYW5kIFN0YXNoIHJhdGluZyB1cCB0byBkYXRlLlxyXG5cclxuaW1wb3J0IHsgZ3JhcGhxbFF1ZXJ5IH0gZnJvbSBcIi4vZ3JhcGhxbFwiO1xyXG5pbXBvcnQgdHlwZSB7IFNjZW5lIH0gZnJvbSBcIi4vdHlwZXNcIjtcclxuXHJcbmV4cG9ydCB0eXBlIFNjZW5lRmllbGRzID0gUGljazxTY2VuZSwgXCJpZFwiIHwgXCJyYXRpbmcxMDBcIiB8IFwiY3VzdG9tX2ZpZWxkc1wiPjtcclxuXHJcbi8qKlxyXG4gKiBUaGUgY3VycmVudCBTdGFzaCByYXRpbmcgYW5kIGN1c3RvbSBmaWVsZHMgb2YgdGhlc2Ugc2NlbmVzLCBieSBpZDsgaWRzIHRoYXQgbm8gbG9uZ2VyIGV4aXN0XHJcbiAqIGFyZSBtaXNzaW5nLiAoZmluZFNjZW5lcyhpZHMpIGVycm9ycyBvbiBhbnkgbWlzc2luZyBpZCwgc28gaXQncyBhbGlhc2VkIGZpbmRTY2VuZSBsb29rdXBzLilcclxuICovXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBmZXRjaFNjZW5lRmllbGRzKGlkczogc3RyaW5nW10pOiBQcm9taXNlPE1hcDxzdHJpbmcsIFNjZW5lRmllbGRzPj4ge1xyXG4gIGNvbnN0IGFsaWFzZXMgPSBpZHNcclxuICAgIC5tYXAoKGlkLCBpKSA9PiBgcyR7aX06IGZpbmRTY2VuZShpZDogJHtKU09OLnN0cmluZ2lmeShpZCl9KSB7IGlkIHJhdGluZzEwMCBjdXN0b21fZmllbGRzIH1gKVxyXG4gICAgLmpvaW4oXCJcXG5cIik7XHJcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZ3JhcGhxbFF1ZXJ5PFJlY29yZDxzdHJpbmcsIFNjZW5lRmllbGRzIHwgbnVsbD4+KGB7ICR7YWxpYXNlc30gfWApO1xyXG4gIHJldHVybiBuZXcgTWFwKE9iamVjdC52YWx1ZXMocmVzdWx0KS5mbGF0TWFwKChzKSA9PiAocyA/IFtbcy5pZCwgc10gYXMgY29uc3RdIDogW10pKSk7XHJcbn1cclxuXHJcbi8qKiBUcnVlIGZvciBHcmFwaFFMIGVycm9ycyBTdGFzaCByYWlzZXMgd2hlbiBhIHNjZW5lIGlkIG5vIGxvbmdlciBleGlzdHMuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBpc1NjZW5lTm90Rm91bmRFcnJvcihlcnJvcjogdW5rbm93bik6IGJvb2xlYW4ge1xyXG4gIHJldHVybiBlcnJvciBpbnN0YW5jZW9mIEVycm9yICYmIC9ub3QgZm91bmQvaS50ZXN0KGVycm9yLm1lc3NhZ2UpO1xyXG59XHJcbiIsICIvLyBQZXJzaXN0IEVMTyAoYW5kIFN0YXNoIHJhdGluZ3MpIHRvIFN0YXNoIGFuZCBrZWVwIHRoZSBsb2NhbCBjYWNoZSBpbiBzeW5jLlxuXG5pbXBvcnQgeyBsYXRlc3RTY2VuZSwgc2V0RWxvSW5DYWNoZSwgc2V0UmF0aW5nc0luQ2FjaGUgfSBmcm9tIFwiLi9jYWNoZVwiO1xuaW1wb3J0IHsgRUxPX0ZJRUxEX0tFWVMgfSBmcm9tIFwiLi9jb25zdGFudHNcIjtcbmltcG9ydCB7IGdyYXBocWxRdWVyeSwgcmVmcmVzaFN0YXNoQ2FjaGUgfSBmcm9tIFwiLi9ncmFwaHFsXCI7XG5pbXBvcnQgeyBpc1NjZW5lTm90Rm91bmRFcnJvciB9IGZyb20gXCIuL3NjZW5lQWN0aW9uc1wiO1xuaW1wb3J0IHsgZWxvQ3VzdG9tRmllbGRzLCBlbG9GaWVsZHMsIGlzU2VlZGVkLCBzdGFzaFJhdGluZ0NoYW5nZXMgfSBmcm9tIFwiLi9zY29yZVwiO1xuaW1wb3J0IHsgc3RhdGUgfSBmcm9tIFwiLi9zdGF0ZVwiO1xuaW1wb3J0IHR5cGUgeyBFbG9GaWVsZHMsIFNjZW5lIH0gZnJvbSBcIi4vdHlwZXNcIjtcblxuLyoqIFdpbmRvdyBldmVudCBmaXJlZCB3aGVuIGEgcmF0aW5nIHdyaXRlIGZpbmRzIHRoZSBzY2VuZSB3YXMgZGVsZXRlZCBlbHNld2hlcmUgKGRldGFpbCA9IHNjZW5lIGlkKS4gKi9cbmV4cG9ydCBjb25zdCBTQ0VORV9NSVNTSU5HX0VWRU5UID0gXCJzdGFzaC1iYXR0bGU6c2NlbmUtbWlzc2luZ1wiO1xuXG5jb25zdCBTQ0VORV9VUERBVEVfTVVUQVRJT04gPSBgXG4gICAgICBtdXRhdGlvbiBTY2VuZVVwZGF0ZSgkaW5wdXQ6IFNjZW5lVXBkYXRlSW5wdXQhKSB7XG4gICAgICAgIHNjZW5lVXBkYXRlKGlucHV0OiAkaW5wdXQpIHtcbiAgICAgICAgICBpZFxuICAgICAgICB9XG4gICAgICB9XG4gICAgYDtcblxuZnVuY3Rpb24gcmVwb3J0V3JpdGVFcnJvcihzY2VuZUlkOiBzdHJpbmcsIHdoYXQ6IHN0cmluZywgZTogdW5rbm93bik6IHZvaWQge1xuICBjb25zb2xlLmVycm9yKGBbU3Rhc2ggQmF0dGxlXSBGYWlsZWQgdG8gJHt3aGF0fSBmb3Igc2NlbmUgJHtzY2VuZUlkfTpgLCBlKTtcbiAgaWYgKGlzU2NlbmVOb3RGb3VuZEVycm9yKGUpKSB7XG4gICAgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEN1c3RvbUV2ZW50KFNDRU5FX01JU1NJTkdfRVZFTlQsIHsgZGV0YWlsOiBzY2VuZUlkIH0pKTtcbiAgfVxufVxuXG4vKiogVHJ1ZSB3aGVuIGJvdGggYXJlIHVucmF0ZWQsIG9yIGhvbGQgdGhlIHNhbWUgRUxPIGZpZWxkcy4gKi9cbmZ1bmN0aW9uIHNhbWVFbG8oYTogRWxvRmllbGRzIHwgbnVsbCwgYjogRWxvRmllbGRzIHwgbnVsbCk6IGJvb2xlYW4ge1xuICBpZiAoYSA9PT0gbnVsbCB8fCBiID09PSBudWxsKSByZXR1cm4gYSA9PT0gYjtcbiAgcmV0dXJuIGEuZWxvID09PSBiLmVsbyAmJiBhLmJhdHRsZXMgPT09IGIuYmF0dGxlcyAmJiBhLnNlZWRlZCA9PT0gYi5zZWVkZWQ7XG59XG5cbi8qKlxuICogVXBkYXRlIHRoZSBzY2VuZSBvYmplY3QsIHRoZSBjYWNoZSBhbmQgU3Rhc2gncyBwYWdlIGNhY2hlIHN0cmFpZ2h0IGF3YXkgKHNvIHRoZSBuZXh0IHBhaXJcbiAqIGFscmVhZHkgc2VlcyB0aGUgY2hhbmdlKSwgdGhlbiB3cml0ZSB0byBTdGFzaC4gSWYgdGhlIHdyaXRlIGZhaWxzLCBwdXQgdGhlIG9sZCB2YWx1ZSBiYWNrLFxuICogdW5sZXNzIGEgbGF0ZXIgd3JpdGUgaGFzIHJlcGxhY2VkIGl0IHNpbmNlLiBTdGFzaCByYXRpbmdzIHN5bmMgb25seSBhZnRlciBhIHN1Y2Nlc3NmdWwgd3JpdGUuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHNhdmVFbG9GaWVsZHMoc2NlbmU6IFNjZW5lLCB2YWx1ZTogRWxvRmllbGRzIHwgbnVsbCwgY3VzdG9tRmllbGRzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiwgd2hhdDogc3RyaW5nKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGNvbnN0IHByZXZpb3VzID0gZWxvRmllbGRzKGxhdGVzdFNjZW5lKHNjZW5lKSk7XG4gIHNldEVsb0luQ2FjaGUoc2NlbmUsIHZhbHVlKTtcbiAgcmVmcmVzaFN0YXNoQ2FjaGUoW3sgaWQ6IHNjZW5lLmlkLCBlbG86IHZhbHVlIH1dLCBmYWxzZSk7XG4gIHRyeSB7XG4gICAgYXdhaXQgZ3JhcGhxbFF1ZXJ5KFNDRU5FX1VQREFURV9NVVRBVElPTiwgeyBpbnB1dDogeyBpZDogc2NlbmUuaWQsIGN1c3RvbV9maWVsZHM6IGN1c3RvbUZpZWxkcyB9IH0pO1xuICB9IGNhdGNoIChlKSB7XG4gICAgcmVwb3J0V3JpdGVFcnJvcihzY2VuZS5pZCwgd2hhdCwgZSk7XG4gICAgaWYgKHNhbWVFbG8oZWxvRmllbGRzKGxhdGVzdFNjZW5lKHNjZW5lKSksIHZhbHVlKSkge1xuICAgICAgc2V0RWxvSW5DYWNoZShzY2VuZSwgcHJldmlvdXMpO1xuICAgICAgcmVmcmVzaFN0YXNoQ2FjaGUoW3sgaWQ6IHNjZW5lLmlkLCBlbG86IHByZXZpb3VzIH1dLCBmYWxzZSk7XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICBzY2hlZHVsZVN0YXNoUmF0aW5nU3luYygpO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuLyoqXG4gKiBTYXZlIGEgc2NlbmUncyBFTE8gYW5kIGJhdHRsZSBjb3VudCAoY3VzdG9tIGZpZWxkcyBvbmx5OyBgcGFydGlhbGAgbGVhdmVzIG90aGVyIHBsdWdpbnMnXG4gKiBmaWVsZHMgYWxvbmUpLiBXaGV0aGVyIGl0IHdhcyBzZWVkZWQgc3RheXMgYXMgaXQgd2FzLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gd3JpdGVFbG8oc2NlbmU6IFNjZW5lLCBlbG86IG51bWJlciwgYmF0dGxlczogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHZhbHVlID0geyBlbG8sIGJhdHRsZXMsIHNlZWRlZDogaXNTZWVkZWQoc2NlbmUpIH07XG4gIGlmIChhd2FpdCBzYXZlRWxvRmllbGRzKHNjZW5lLCB2YWx1ZSwgeyBwYXJ0aWFsOiBlbG9DdXN0b21GaWVsZHModmFsdWUpIH0sIFwic2F2ZSBFTE9cIikpIHtcbiAgICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g8J+TnSBTYXZlZCBzY2VuZSAke3NjZW5lLmlkfSBFTE8gJHtlbG99ICgke2JhdHRsZXN9IGJhdHRsZXMpYCk7XG4gIH1cbn1cblxuLyoqIFJlbW92ZSBhIHNjZW5lJ3MgRUxPIGZpZWxkcywgbWFraW5nIGl0IHVucmF0ZWQgYWdhaW4uICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY2xlYXJFbG8oc2NlbmU6IFNjZW5lKTogUHJvbWlzZTx2b2lkPiB7XG4gIGlmIChhd2FpdCBzYXZlRWxvRmllbGRzKHNjZW5lLCBudWxsLCB7IHJlbW92ZTogRUxPX0ZJRUxEX0tFWVMgfSwgXCJjbGVhciBFTE9cIikpIHtcbiAgICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g8J+TnSBDbGVhcmVkIHNjZW5lICR7c2NlbmUuaWR9IEVMT2ApO1xuICB9XG59XG5cbi8qKlxuICogV3JpdGUgU3Rhc2ggcmF0aW5ncyAoc2NlbmUgaWQgdG8gMS0xMDApIGluIG9uZSBHcmFwaFFMIHJlcXVlc3Q6IG9uZSBhbGlhc2VkIGJ1bGtTY2VuZVVwZGF0ZVxuICogcGVyIGRpc3RpbmN0IHZhbHVlLiBUaHJvd3Mgb24gZmFpbHVyZTsgZG9lc24ndCB0b3VjaCB0aGUgY2FjaGUuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB3cml0ZVN0YXNoUmF0aW5ncyhyYXRpbmdzOiBNYXA8c3RyaW5nLCBudW1iZXI+KTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGlkc0J5UmF0aW5nID0gbmV3IE1hcDxudW1iZXIsIHN0cmluZ1tdPigpO1xuICBmb3IgKGNvbnN0IFtpZCwgcmF0aW5nXSBvZiByYXRpbmdzKSB7XG4gICAgY29uc3QgaWRzID0gaWRzQnlSYXRpbmcuZ2V0KHJhdGluZykgPz8gW107XG4gICAgaWRzLnB1c2goaWQpO1xuICAgIGlkc0J5UmF0aW5nLnNldChyYXRpbmcsIGlkcyk7XG4gIH1cbiAgaWYgKGlkc0J5UmF0aW5nLnNpemUgPT09IDApIHJldHVybjtcblxuICBjb25zdCB2YWx1ZXMgPSBbLi4uaWRzQnlSYXRpbmcua2V5cygpXTtcbiAgY29uc3QgbXV0YXRpb24gPSBgXG4gICAgICBtdXRhdGlvbiBTeW5jU3Rhc2hSYXRpbmdzKCR7dmFsdWVzLm1hcCgocikgPT4gYCRyJHtyfTogQnVsa1NjZW5lVXBkYXRlSW5wdXQhYCkuam9pbihcIiwgXCIpfSkge1xuICAgICAgICAke3ZhbHVlcy5tYXAoKHIpID0+IGByJHtyfTogYnVsa1NjZW5lVXBkYXRlKGlucHV0OiAkciR7cn0pIHsgaWQgfWApLmpvaW4oXCJcXG4gICAgICAgIFwiKX1cbiAgICAgIH1cbiAgICBgO1xuICBjb25zdCB2YXJpYWJsZXMgPSBPYmplY3QuZnJvbUVudHJpZXMoXG4gICAgdmFsdWVzLm1hcCgocikgPT4gW2ByJHtyfWAsIHsgaWRzOiBpZHNCeVJhdGluZy5nZXQociksIHJhdGluZzEwMDogciB9XSksXG4gICk7XG4gIGF3YWl0IGdyYXBocWxRdWVyeShtdXRhdGlvbiwgdmFyaWFibGVzKTtcbiAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIPCfk50gV3JvdGUgJHtyYXRpbmdzLnNpemV9IFN0YXNoIHJhdGluZ3MgKCR7dmFsdWVzLmxlbmd0aH0gZGlzdGluY3QgdmFsdWVzKWApO1xufVxuXG4vKiogQWZ0ZXIgU3Rhc2ggcmF0aW5ncyB3ZXJlIHdyaXR0ZW46IHVwZGF0ZSB0aGUgY2FjaGVkIHNjZW5lcyBhbmQgU3Rhc2gncyBvd24gcGFnZSBjYWNoZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhcHBseVN0YXNoUmF0aW5ncyhyYXRpbmdzOiBNYXA8c3RyaW5nLCBudW1iZXI+KTogdm9pZCB7XG4gIHNldFJhdGluZ3NJbkNhY2hlKHJhdGluZ3MpO1xuICByZWZyZXNoU3Rhc2hDYWNoZShcbiAgICBbLi4ucmF0aW5nc10ubWFwKChbaWQsIHJhdGluZzEwMF0pID0+ICh7IGlkLCByYXRpbmcxMDAgfSkpLFxuICAgIHJhdGluZ3Muc2l6ZSA+IDAsXG4gICk7XG59XG5cbi8qKiBXYWl0IHRoaXMgbG9uZyBhZnRlciB0aGUgbGFzdCBFTE8gd3JpdGUsIHNvIGJvdGggc2NlbmVzIG9mIGEgcGljayBzeW5jIGluIG9uZSByZXF1ZXN0LiAqL1xuY29uc3QgU1lOQ19ERUJPVU5DRV9NUyA9IDUwMDtcbmxldCBzeW5jVGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XG5cbi8qKiBTeW5jIFN0YXNoIHJhdGluZ3Mgc29vbiAoZGVib3VuY2VkKSwgdW5sZXNzIHRoZSBcIlN0YXNoIHJhdGluZ3NcIiBzZXR0aW5nIGlzIFwib2ZmXCIuICovXG5leHBvcnQgZnVuY3Rpb24gc2NoZWR1bGVTdGFzaFJhdGluZ1N5bmMoKTogdm9pZCB7XG4gIGlmIChzdGF0ZS5zZXR0aW5ncy5zdGFzaFJhdGluZ3MgPT09IFwib2ZmXCIpIHJldHVybjtcbiAgaWYgKHN5bmNUaW1lcikgY2xlYXJUaW1lb3V0KHN5bmNUaW1lcik7XG4gIHN5bmNUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgIHN5bmNUaW1lciA9IG51bGw7XG4gICAgdm9pZCBzeW5jU3Rhc2hSYXRpbmdzKCk7XG4gIH0sIFNZTkNfREVCT1VOQ0VfTVMpO1xufVxuXG4vKiogVGhlIFN0YXNoIHJhdGluZyB3cml0ZSBpbiBwcm9ncmVzcyAob3IgdGhlIGxhc3Qgb25lKSwgc28gdGhlIG5leHQgd2FpdHMgZm9yIGl0LiAqL1xubGV0IHJhdGluZ1dyaXRlczogUHJvbWlzZTx1bmtub3duPiA9IFByb21pc2UucmVzb2x2ZSgpO1xuXG4vKipcbiAqIFJ1biBhIFN0YXNoIHJhdGluZ3Mgd3JpdGUgYWZ0ZXIgYW55IGluIHByb2dyZXNzLCBzbyBlYWNoIG9uZSBzdGFydHMgZnJvbSB0aGUgcmF0aW5ncyB0aGVcbiAqIHByZXZpb3VzIG9uZSB3cm90ZSAob3ZlcmxhcHBpbmcgd3JpdGVzIGNvdWxkIHJlcGVhdCB3b3JrIG9yIGZpbmlzaCBvdXQgb2Ygb3JkZXIpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcXVldWVSYXRpbmdXcml0ZTxUPih0YXNrOiAoKSA9PiBQcm9taXNlPFQ+KTogUHJvbWlzZTxUPiB7XG4gIGNvbnN0IHJ1biA9IHJhdGluZ1dyaXRlcy50aGVuKHRhc2spO1xuICByYXRpbmdXcml0ZXMgPSBydW4uY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcbiAgcmV0dXJuIHJ1bjtcbn1cblxuLyoqXG4gKiBCcmluZyBTdGFzaCByYXRpbmdzIGluIGxpbmUgd2l0aCBFTE8gZm9yIHRoZSB3aG9sZSBsaWJyYXJ5ICh0aGUgYWxsLXNjZW5lcyBjYWNoZSk6IHdvcmsgb3V0XG4gKiBldmVyeSBzY2VuZSdzIHRhcmdldCB1bmRlciB0aGUgY3VycmVudCBzZXR0aW5nLCBhbmQgd3JpdGUgb25seSB0aGUgb25lcyB0aGF0IGRpZmZlciBmcm9tIHRoZVxuICogY2FjaGVkIHJhdGluZywgaW4gb25lIHJlcXVlc3QuIFF1ZXVlZCBiZWhpbmQgYW55IHdyaXRlIGluIHByb2dyZXNzLiBSZXR1cm5zIGhvdyBtYW55IHdlcmUgd3JpdHRlbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN5bmNTdGFzaFJhdGluZ3MoKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgcmV0dXJuIHF1ZXVlUmF0aW5nV3JpdGUoYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IG1vZGUgPSBzdGF0ZS5zZXR0aW5ncy5zdGFzaFJhdGluZ3M7XG4gICAgY29uc3Qgc2NlbmVzID0gc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzO1xuICAgIGlmIChtb2RlID09PSBcIm9mZlwiIHx8ICFzY2VuZXMpIHJldHVybiAwO1xuICAgIGNvbnN0IGNoYW5nZXMgPSBzdGFzaFJhdGluZ0NoYW5nZXMoc2NlbmVzLCBtb2RlKTtcbiAgICBpZiAoY2hhbmdlcy5zaXplID09PSAwKSByZXR1cm4gMDtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgd3JpdGVTdGFzaFJhdGluZ3MoY2hhbmdlcyk7XG4gICAgICBhcHBseVN0YXNoUmF0aW5ncyhjaGFuZ2VzKTtcbiAgICAgIHJldHVybiBjaGFuZ2VzLnNpemU7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIEZhaWxlZCB0byBzeW5jIFN0YXNoIHJhdGluZ3M6XCIsIGUpO1xuICAgICAgcmV0dXJuIDA7XG4gICAgfVxuICB9KTtcbn1cbiIsICIvLyBPbmUtdGltZSBFTE8gc2V0dXA6IGdpdmUgZXZlcnkgc2NlbmUgYSBzdGFydGluZyBFTE8gKGZyb20gaXRzIFN0YXNoIHJhdGluZywgb3IgMTUwMCBmb3IgYWxsKSxcbi8vIHRoZW4gb3B0aW9uYWxseSBzeW5jIFN0YXNoIHJhdGluZ3MgZnJvbSB0aGUgbmV3IEVMTy4gUmUtcnVubmluZyBpdCBvdmVyd3JpdGVzLCBzbyBhblxuLy8gaW50ZXJydXB0ZWQgc2V0dXAgaXMgc2FmZSB0byByZXBlYXQuXG5cbmltcG9ydCB7IEVMT19GSUVMRF9LRVlTLCBFTE9fU1RBUlQgfSBmcm9tIFwiLi9jb25zdGFudHNcIjtcbmltcG9ydCB7IGdyYXBocWxRdWVyeSwgcmVmcmVzaFN0YXNoQ2FjaGUgfSBmcm9tIFwiLi9ncmFwaHFsXCI7XG5pbXBvcnQgeyB3cml0ZVN0YXNoUmF0aW5ncyB9IGZyb20gXCIuL3JhdGluZ1wiO1xuaW1wb3J0IHsgYWZ0ZXJTZXR1cCwgZWxvQ3VzdG9tRmllbGRzLCBpc1JhdGVkLCBzZWVkLCBzdGFydGluZ0Vsbywgc3Rhc2hSYXRpbmdDaGFuZ2VzIH0gZnJvbSBcIi4vc2NvcmVcIjtcbmltcG9ydCB0eXBlIHsgRWxvU3RhcnQsIFNjZW5lLCBTdGFzaFJhdGluZ3NNb2RlIH0gZnJvbSBcIi4vdHlwZXNcIjtcblxuZXhwb3J0IHR5cGUgU2V0dXBQaGFzZSA9IFwiZWxvXCIgfCBcInJhdGluZ3NcIjtcblxuLyoqIFByb2dyZXNzIGNhbGxiYWNrOiBgZG9uZWAgb2YgYHRvdGFsYCBzY2VuZXMgZmluaXNoZWQgaW4gdGhpcyBwaGFzZS4gKi9cbmV4cG9ydCB0eXBlIFNldHVwUHJvZ3Jlc3MgPSAocGhhc2U6IFNldHVwUGhhc2UsIGRvbmU6IG51bWJlciwgdG90YWw6IG51bWJlcikgPT4gdm9pZDtcblxuZXhwb3J0IGludGVyZmFjZSBTZXR1cFN1bW1hcnkge1xuICBlbG9Xcml0dGVuOiBudW1iZXI7IC8vIFNjZW5lcyBnaXZlbiBhIHN0YXJ0aW5nIEVMT1xuICBlbG9DbGVhcmVkOiBudW1iZXI7IC8vIFNjZW5lcyB3aG9zZSBvbGQgRUxPIHdhcyByZW1vdmVkIChyZS1ydW4gd2l0aCBcIlVzZSBteSByYXRpbmdzXCIpXG4gIHJhdGluZ3NXcml0dGVuOiBudW1iZXI7IC8vIFN0YXNoIHJhdGluZ3MgY2hhbmdlZFxufVxuXG5jb25zdCBTRVRVUF9TQ0VORVNfUVVFUlkgPSBgXG4gICAgICBxdWVyeSBGaW5kU2NlbmVzRm9yRWxvU2V0dXAge1xuICAgICAgICBmaW5kU2NlbmVzKGZpbHRlcjogeyBwZXJfcGFnZTogLTEgfSkge1xuICAgICAgICAgIHNjZW5lcyB7XG4gICAgICAgICAgICBpZFxuICAgICAgICAgICAgcmF0aW5nMTAwXG4gICAgICAgICAgICBjdXN0b21fZmllbGRzXG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgYDtcblxuLyoqIEV2ZXJ5IHNjZW5lJ3MgaWQsIFN0YXNoIHJhdGluZyBhbmQgY3VzdG9tIGZpZWxkcywgZnJlc2ggZnJvbSBTdGFzaCAobm90IHRoZSA1LW1pbnV0ZSBjYWNoZSkuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmV0Y2hTZXR1cFNjZW5lcygpOiBQcm9taXNlPFNjZW5lW10+IHtcbiAgY29uc3QgZGF0YSA9IGF3YWl0IGdyYXBocWxRdWVyeTx7IGZpbmRTY2VuZXM6IHsgc2NlbmVzOiBTY2VuZVtdIH0gfT4oU0VUVVBfU0NFTkVTX1FVRVJZKTtcbiAgcmV0dXJuIGRhdGEuZmluZFNjZW5lcy5zY2VuZXMgPz8gW107XG59XG5cbi8qKiBUaGUgU3Rhc2ggcmF0aW5ncyB0aGUgc2V0dXAgd291bGQgY2hhbmdlOiBzY2VuZSBpZCB0byBuZXcgcmF0aW5nIChub25lIGZvciBcIm9mZlwiKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZXR1cFJhdGluZ0NoYW5nZXMoc2NlbmVzOiBTY2VuZVtdLCBzdGFydDogRWxvU3RhcnQsIHN0YXNoUmF0aW5nczogU3Rhc2hSYXRpbmdzTW9kZSk6IE1hcDxzdHJpbmcsIG51bWJlcj4ge1xuICByZXR1cm4gc3Rhc2hSYXRpbmdDaGFuZ2VzKFxuICAgIHNjZW5lcy5tYXAoKHNjZW5lKSA9PiBhZnRlclNldHVwKHNjZW5lLCBzdGFydCkpLFxuICAgIHN0YXNoUmF0aW5ncyxcbiAgKTtcbn1cblxuY29uc3QgQlVMS19VUERBVEVfTVVUQVRJT04gPSBgXG4gICAgICBtdXRhdGlvbiBCdWxrU2NlbmVVcGRhdGUoJGlucHV0OiBCdWxrU2NlbmVVcGRhdGVJbnB1dCEpIHtcbiAgICAgICAgYnVsa1NjZW5lVXBkYXRlKGlucHV0OiAkaW5wdXQpIHtcbiAgICAgICAgICBpZFxuICAgICAgICB9XG4gICAgICB9XG4gICAgYDtcblxuLyoqXG4gKiBTZWVkIGVhY2ggcmF0ZWQgc2NlbmUgZnJvbSBpdHMgb3duIHJhdGluZy4gU2NlbmVzIHdpdGggdGhlIHNhbWUgU3Rhc2ggcmF0aW5nIGdldCB0aGUgc2FtZVxuICogc3RhcnRpbmcgZmllbGRzLCBzbyBpdCdzIG9uZSBhbGlhc2VkIGJ1bGtTY2VuZVVwZGF0ZSBwZXIgZGlzdGluY3QgcmF0aW5nLCBhbGwgaW4gb25lIHJlcXVlc3QuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHNlZWRGcm9tUmF0aW5ncyhyYXRlZDogU2NlbmVbXSk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBpZHNCeVJhdGluZyA9IG5ldyBNYXA8bnVtYmVyLCBzdHJpbmdbXT4oKTtcbiAgZm9yIChjb25zdCBzY2VuZSBvZiByYXRlZCkge1xuICAgIGNvbnN0IHJhdGluZyA9IHNjZW5lLnJhdGluZzEwMCBhcyBudW1iZXI7XG4gICAgY29uc3QgaWRzID0gaWRzQnlSYXRpbmcuZ2V0KHJhdGluZykgPz8gW107XG4gICAgaWRzLnB1c2goc2NlbmUuaWQpO1xuICAgIGlkc0J5UmF0aW5nLnNldChyYXRpbmcsIGlkcyk7XG4gIH1cbiAgaWYgKGlkc0J5UmF0aW5nLnNpemUgPT09IDApIHJldHVybjtcblxuICBjb25zdCB2YWx1ZXMgPSBbLi4uaWRzQnlSYXRpbmcua2V5cygpXTtcbiAgY29uc3QgbXV0YXRpb24gPSBgXG4gICAgICBtdXRhdGlvbiBTZWVkRWxvKCR7dmFsdWVzLm1hcCgocikgPT4gYCRzJHtyfTogQnVsa1NjZW5lVXBkYXRlSW5wdXQhYCkuam9pbihcIiwgXCIpfSkge1xuICAgICAgICAke3ZhbHVlcy5tYXAoKHIpID0+IGBzJHtyfTogYnVsa1NjZW5lVXBkYXRlKGlucHV0OiAkcyR7cn0pIHsgaWQgfWApLmpvaW4oXCJcXG4gICAgICAgIFwiKX1cbiAgICAgIH1cbiAgICBgO1xuICBjb25zdCB2YXJpYWJsZXMgPSBPYmplY3QuZnJvbUVudHJpZXMoXG4gICAgdmFsdWVzLm1hcCgocikgPT4ge1xuICAgICAgY29uc3QgcGFydGlhbCA9IGVsb0N1c3RvbUZpZWxkcyh7IGVsbzogc2VlZChyKSwgYmF0dGxlczogMCwgc2VlZGVkOiB0cnVlIH0pO1xuICAgICAgcmV0dXJuIFtgcyR7cn1gLCB7IGlkczogaWRzQnlSYXRpbmcuZ2V0KHIpLCBjdXN0b21fZmllbGRzOiB7IHBhcnRpYWwgfSB9XTtcbiAgICB9KSxcbiAgKTtcbiAgYXdhaXQgZ3JhcGhxbFF1ZXJ5KG11dGF0aW9uLCB2YXJpYWJsZXMpO1xufVxuXG4vKipcbiAqIFJ1biB0aGUgc2V0dXAgb24gYHNjZW5lc2AgKGZyb20gZmV0Y2hTZXR1cFNjZW5lcyk6IHdyaXRlIHRoZSBzdGFydGluZyBFTE8sIHRoZW4sIHVubGVzc1xuICogc3Rhc2hSYXRpbmdzIGlzIFwib2ZmXCIsIHRoZSBTdGFzaCByYXRpbmdzIHRoYXQgY2hhbmdlLiBUaHJvd3MgaWYgYSByZXF1ZXN0IGZhaWxzOyB3aGF0ZXZlclxuICogd2FzIHdyaXR0ZW4gYnkgdGhlbiBzdGF5cywgYW5kIHJ1bm5pbmcgaXQgYWdhaW4gb3ZlcndyaXRlcyBpdC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bkVsb1NldHVwKFxuICBzY2VuZXM6IFNjZW5lW10sXG4gIHN0YXJ0OiBFbG9TdGFydCxcbiAgc3Rhc2hSYXRpbmdzOiBTdGFzaFJhdGluZ3NNb2RlLFxuICBvblByb2dyZXNzOiBTZXR1cFByb2dyZXNzLFxuKTogUHJvbWlzZTxTZXR1cFN1bW1hcnk+IHtcbiAgY29uc3Qgc3VtbWFyeTogU2V0dXBTdW1tYXJ5ID0geyBlbG9Xcml0dGVuOiAwLCBlbG9DbGVhcmVkOiAwLCByYXRpbmdzV3JpdHRlbjogMCB9O1xuXG4gIGlmIChzdGFydCA9PT0gXCJyYXRpbmdzXCIpIHtcbiAgICBjb25zdCByYXRlZCA9IHNjZW5lcy5maWx0ZXIoKHNjZW5lKSA9PiBzY2VuZS5yYXRpbmcxMDAgIT0gbnVsbCk7XG4gICAgb25Qcm9ncmVzcyhcImVsb1wiLCAwLCByYXRlZC5sZW5ndGgpO1xuICAgIGF3YWl0IHNlZWRGcm9tUmF0aW5ncyhyYXRlZCk7XG4gICAgb25Qcm9ncmVzcyhcImVsb1wiLCByYXRlZC5sZW5ndGgsIHJhdGVkLmxlbmd0aCk7XG4gICAgc3VtbWFyeS5lbG9Xcml0dGVuID0gcmF0ZWQubGVuZ3RoO1xuXG4gICAgLy8gT25seSBtYXR0ZXJzIG9uIGEgcmUtcnVuOiBzY2VuZXMgd2l0aCBhbiBFTE8gYnV0IG5vIFN0YXNoIHJhdGluZyBiZWNvbWUgdW5yYXRlZCBhZ2FpblxuICAgIGNvbnN0IHN0YWxlID0gc2NlbmVzLmZpbHRlcigoc2NlbmUpID0+IHNjZW5lLnJhdGluZzEwMCA9PSBudWxsICYmIGlzUmF0ZWQoc2NlbmUpKS5tYXAoKHNjZW5lKSA9PiBzY2VuZS5pZCk7XG4gICAgaWYgKHN0YWxlLmxlbmd0aCA+IDApIHtcbiAgICAgIGF3YWl0IGdyYXBocWxRdWVyeShCVUxLX1VQREFURV9NVVRBVElPTiwge1xuICAgICAgICBpbnB1dDogeyBpZHM6IHN0YWxlLCBjdXN0b21fZmllbGRzOiB7IHJlbW92ZTogRUxPX0ZJRUxEX0tFWVMgfSB9LFxuICAgICAgfSk7XG4gICAgICBzdW1tYXJ5LmVsb0NsZWFyZWQgPSBzdGFsZS5sZW5ndGg7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIGNvbnN0IGlkcyA9IHNjZW5lcy5tYXAoKHNjZW5lKSA9PiBzY2VuZS5pZCk7XG4gICAgb25Qcm9ncmVzcyhcImVsb1wiLCAwLCBpZHMubGVuZ3RoKTtcbiAgICBpZiAoaWRzLmxlbmd0aCA+IDApIHtcbiAgICAgIGF3YWl0IGdyYXBocWxRdWVyeShCVUxLX1VQREFURV9NVVRBVElPTiwge1xuICAgICAgICBpbnB1dDogeyBpZHMsIGN1c3RvbV9maWVsZHM6IHsgcGFydGlhbDogZWxvQ3VzdG9tRmllbGRzKHsgZWxvOiBFTE9fU1RBUlQsIGJhdHRsZXM6IDAsIHNlZWRlZDogZmFsc2UgfSkgfSB9LFxuICAgICAgfSk7XG4gICAgfVxuICAgIG9uUHJvZ3Jlc3MoXCJlbG9cIiwgaWRzLmxlbmd0aCwgaWRzLmxlbmd0aCk7XG4gICAgc3VtbWFyeS5lbG9Xcml0dGVuID0gaWRzLmxlbmd0aDtcbiAgfVxuXG4gIGNvbnN0IGNoYW5nZXMgPSBzZXR1cFJhdGluZ0NoYW5nZXMoc2NlbmVzLCBzdGFydCwgc3Rhc2hSYXRpbmdzKTtcbiAgaWYgKGNoYW5nZXMuc2l6ZSA+IDApIHtcbiAgICBvblByb2dyZXNzKFwicmF0aW5nc1wiLCAwLCBjaGFuZ2VzLnNpemUpO1xuICAgIGF3YWl0IHdyaXRlU3Rhc2hSYXRpbmdzKGNoYW5nZXMpO1xuICAgIG9uUHJvZ3Jlc3MoXCJyYXRpbmdzXCIsIGNoYW5nZXMuc2l6ZSwgY2hhbmdlcy5zaXplKTtcbiAgICBzdW1tYXJ5LnJhdGluZ3NXcml0dGVuID0gY2hhbmdlcy5zaXplO1xuICB9XG5cbiAgLy8gU3Rhc2gncyBvd24gcGFnZXM6IGV2ZXJ5IHNjZW5lJ3MgRUxPIChvciBpdHMgcmVtb3ZhbCkgYW5kIGFueSBjaGFuZ2VkIHJhdGluZ1xuICByZWZyZXNoU3Rhc2hDYWNoZShcbiAgICBzY2VuZXMubWFwKChzY2VuZSkgPT4gKHsgaWQ6IHNjZW5lLmlkLCBlbG86IHN0YXJ0aW5nRWxvKHNjZW5lLCBzdGFydCksIHJhdGluZzEwMDogY2hhbmdlcy5nZXQoc2NlbmUuaWQpIH0pKSxcbiAgICBjaGFuZ2VzLnNpemUgPiAwLFxuICApO1xuXG4gIGNvbnNvbGUubG9nKFxuICAgIGBbU3Rhc2ggQmF0dGxlXSDinIUgRUxPIHNldHVwICgke3N0YXJ0fSwgU3Rhc2ggcmF0aW5ncyAke3N0YXNoUmF0aW5nc30pOiAke3N1bW1hcnkuZWxvV3JpdHRlbn0gRUxPIHdyaXR0ZW4sICR7c3VtbWFyeS5lbG9DbGVhcmVkfSBjbGVhcmVkLCAke3N1bW1hcnkucmF0aW5nc1dyaXR0ZW59IFN0YXNoIHJhdGluZ3Mgd3JpdHRlbmAsXG4gICk7XG4gIHJldHVybiBzdW1tYXJ5O1xufVxuIiwgIi8vIFVzZXIgc2V0dGluZ3Mgc3RvcmVkIGluIFN0YXNoJ3MgcGx1Z2luIGNvbmZpZ3VyYXRpb24gKGNvbmZpZ3VyYXRpb24ucGx1Z2luc1tcInN0YXNoLWJhdHRsZVwiXSksXG4vLyBzbyB0aGV5IGZvbGxvdyB0aGUgdXNlciBhY3Jvc3MgYnJvd3NlcnMuIEFsc28gZWRpdGFibGUgaW4gU3Rhc2gg4oaSIFNldHRpbmdzIOKGkiBQbHVnaW5zLlxuXG5pbXBvcnQge1xuICBERUZBVUxUX1NFVFRJTkdTLFxuICBMRUdBQ1lfRklMVEVSX09QUE9ORU5UU19LRVksXG4gIExFR0FDWV9NVVRFX1BSRVZJRVdTX0tFWSxcbiAgUExVR0lOX0lELFxufSBmcm9tIFwiLi9jb25zdGFudHNcIjtcbmltcG9ydCB7IGdyYXBocWxRdWVyeSB9IGZyb20gXCIuL2dyYXBocWxcIjtcbmltcG9ydCB7IHN0YXRlIH0gZnJvbSBcIi4vc3RhdGVcIjtcbmltcG9ydCB0eXBlIHsgRWxvU3RhcnQsIFNldHRpbmdzLCBTdGFzaFJhdGluZ3NNb2RlIH0gZnJvbSBcIi4vdHlwZXNcIjtcblxuY29uc3QgQ09ORklHX1FVRVJZID0gYHsgY29uZmlndXJhdGlvbiB7IHBsdWdpbnMgfSB9YDtcblxuY29uc3QgQ09ORklHVVJFX1BMVUdJTl9NVVRBVElPTiA9IGBcbiAgICAgIG11dGF0aW9uIENvbmZpZ3VyZVBsdWdpbigkcGx1Z2luX2lkOiBJRCEsICRpbnB1dDogTWFwISkge1xuICAgICAgICBjb25maWd1cmVQbHVnaW4ocGx1Z2luX2lkOiAkcGx1Z2luX2lkLCBpbnB1dDogJGlucHV0KVxuICAgICAgfVxuICAgIGA7XG5cbmNvbnN0IFNBVkVfREVCT1VOQ0VfTVMgPSA0MDA7XG5sZXQgc2F2ZVRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xuXG4vKiogUHJlLTMuMCBmdW4gbW9kZSB3YXMgb24gaW4gdGhlIHN0b3JlZCBjb25maWcgKHNvIEJhdHRsZSB3YXNuJ3QgY2hhbmdpbmcgU3Rhc2ggcmF0aW5ncykuICovXG5sZXQgbGVnYWN5RnVuTW9kZSA9IGZhbHNlO1xuXG5jb25zdCBTVEFTSF9SQVRJTkdTX01PREVTOiByZWFkb25seSBTdGFzaFJhdGluZ3NNb2RlW10gPSBbXCJvZmZcIiwgXCJwZXJjZW50aWxlXCIsIFwibGluZWFyXCJdO1xuY29uc3QgRUxPX1NUQVJUUzogcmVhZG9ubHkgRWxvU3RhcnRbXSA9IFtcInJhdGluZ3NcIiwgXCJmcmVzaFwiXTtcblxuZnVuY3Rpb24gb25lT2Y8VCBleHRlbmRzIHN0cmluZz4odmFsdWU6IHVua25vd24sIGFsbG93ZWQ6IHJlYWRvbmx5IFRbXSwgZmFsbGJhY2s6IFQpOiBUIHtcbiAgcmV0dXJuIGFsbG93ZWQuaW5jbHVkZXModmFsdWUgYXMgVCkgPyAodmFsdWUgYXMgVCkgOiBmYWxsYmFjaztcbn1cblxuZnVuY3Rpb24gY2xhbXBQZXJjZW50KHZhbHVlOiB1bmtub3duLCBmYWxsYmFjazogbnVtYmVyKTogbnVtYmVyIHtcbiAgY29uc3QgbiA9IE51bWJlcih2YWx1ZSk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobikgPyBNYXRoLm1pbigxMDAsIE1hdGgubWF4KDAsIE1hdGgucm91bmQobikpKSA6IGZhbGxiYWNrO1xufVxuXG4vKiogQ29lcmNlIGEgc3RvcmVkIGNvbmZpZyBtYXAgaW50byBTZXR0aW5ncyAoU3Rhc2ggbWF5IG9taXQga2V5cyBvciBzdG9yZSBudW1iZXJzIGFzIHN0cmluZ3MpLiAqL1xuZnVuY3Rpb24gbm9ybWFsaXplKHJhdzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sIGJhc2U6IFNldHRpbmdzKTogU2V0dGluZ3Mge1xuICBjb25zdCBib29sID0gKGtleToga2V5b2YgU2V0dGluZ3MpOiBib29sZWFuID0+XG4gICAgdHlwZW9mIHJhd1trZXldID09PSBcImJvb2xlYW5cIiA/IChyYXdba2V5XSBhcyBib29sZWFuKSA6IChiYXNlW2tleV0gYXMgYm9vbGVhbik7XG4gIHJldHVybiB7XG4gICAgLy8gQSBtaXNzaW5nIG9yIHVua25vd24gdmFsdWUgaXMgXCJvZmZcIi4gKFJlbW92ZWQga2V5cywgZnVuTW9kZSBhbmQgdW5yYXRlZFJhdGluZywgYXJlIGRyb3BwZWQuKVxuICAgIHN0YXNoUmF0aW5nczogb25lT2YocmF3LnN0YXNoUmF0aW5ncywgU1RBU0hfUkFUSU5HU19NT0RFUywgXCJvZmZcIiksXG4gICAgLy8gU2V0dXAgZmxhZ3MgaGF2ZSBubyBmYWxsYmFjazogcmF3IGFsd2F5cyBjYXJyaWVzIHRoZW0gKHN0b3JlZCBjb25maWcsIG9yIGN1cnJlbnQgKyBwYXRjaClcbiAgICBlbG9TZXR1cEF0OiB0eXBlb2YgcmF3LmVsb1NldHVwQXQgPT09IFwic3RyaW5nXCIgJiYgcmF3LmVsb1NldHVwQXQgPyByYXcuZWxvU2V0dXBBdCA6IG51bGwsXG4gICAgZWxvU2V0dXBNb2RlOiBFTE9fU1RBUlRTLmluY2x1ZGVzKHJhdy5lbG9TZXR1cE1vZGUgYXMgRWxvU3RhcnQpID8gKHJhdy5lbG9TZXR1cE1vZGUgYXMgRWxvU3RhcnQpIDogbnVsbCxcbiAgICBvcGVuSW5OZXdUYWI6IGJvb2woXCJvcGVuSW5OZXdUYWJcIiksXG4gICAgYXV0b3BsYXlQcmV2aWV3czogYm9vbChcImF1dG9wbGF5UHJldmlld3NcIiksXG4gICAgZmlsdGVyT3Bwb25lbnRzOiBib29sKFwiZmlsdGVyT3Bwb25lbnRzXCIpLFxuICAgIGNsZWFuTW9kZTogYm9vbChcImNsZWFuTW9kZVwiKSxcbiAgICBwYXVzZU1lZGlhT25PcGVuOiBib29sKFwicGF1c2VNZWRpYU9uT3BlblwiKSxcbiAgICBwbGFjZW1lbnRGcm9tQm90dG9tOiBib29sKFwicGxhY2VtZW50RnJvbUJvdHRvbVwiKSxcbiAgICBzaG93VGllcnM6IGJvb2woXCJzaG93VGllcnNcIiksXG4gICAgcHJldmlld1ZvbHVtZTogY2xhbXBQZXJjZW50KHJhdy5wcmV2aWV3Vm9sdW1lID8/IGJhc2UucHJldmlld1ZvbHVtZSwgYmFzZS5wcmV2aWV3Vm9sdW1lKSxcbiAgfTtcbn1cblxuLyoqIERlZmF1bHRzIG92ZXJsYWlkIHdpdGggdGhlIHByZS0yLjcgbG9jYWxTdG9yYWdlIHRvZ2dsZXMsIGZvciB1c2VycyB3aG8gbmV2ZXIgc2F2ZWQgc2V0dGluZ3MuICovXG5mdW5jdGlvbiBsZWdhY3lEZWZhdWx0cygpOiBTZXR0aW5ncyB7XG4gIGNvbnN0IHNldHRpbmdzID0geyAuLi5ERUZBVUxUX1NFVFRJTkdTIH07XG4gIHRyeSB7XG4gICAgaWYgKGxvY2FsU3RvcmFnZS5nZXRJdGVtKExFR0FDWV9GSUxURVJfT1BQT05FTlRTX0tFWSkgPT09IFwiMVwiKSBzZXR0aW5ncy5maWx0ZXJPcHBvbmVudHMgPSB0cnVlO1xuICAgIGlmIChsb2NhbFN0b3JhZ2UuZ2V0SXRlbShMRUdBQ1lfTVVURV9QUkVWSUVXU19LRVkpID09PSBcIjFcIikgc2V0dGluZ3MucHJldmlld1ZvbHVtZSA9IDA7XG4gIH0gY2F0Y2gge1xuICAgIC8qIGlnbm9yZSAqL1xuICB9XG4gIHJldHVybiBzZXR0aW5ncztcbn1cblxuLyoqXG4gKiBGZXRjaCBzZXR0aW5ncyBmcm9tIFN0YXNoIGludG8gc3RhdGUuc2V0dGluZ3MuIE9uIGZhaWx1cmUsIGtlZXBzIHRoZSBjdXJyZW50IHZhbHVlcyBhbmRcbiAqIHJldHVybnMgZmFsc2UuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBsb2FkU2V0dGluZ3MoKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIHRyeSB7XG4gICAgY29uc3Qgc3RvcmVkID0gYXdhaXQgZmV0Y2hTdG9yZWRDb25maWcoKTtcbiAgICBsZWdhY3lGdW5Nb2RlID0gc3RvcmVkPy5mdW5Nb2RlID09PSB0cnVlO1xuICAgIHN0YXRlLnNldHRpbmdzID0gc3RvcmVkID8gbm9ybWFsaXplKHN0b3JlZCwgREVGQVVMVF9TRVRUSU5HUykgOiBsZWdhY3lEZWZhdWx0cygpO1xuICAgIHJldHVybiB0cnVlO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIEZhaWxlZCB0byBsb2FkIHNldHRpbmdzLCB1c2luZyBjdXJyZW50IHZhbHVlczpcIiwgZSk7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbi8qKiBUcnVlIGlmIHRoZSBzdG9yZWQgY29uZmlnIHN0aWxsIGhhcyBwcmUtMy4wIGZ1biBtb2RlIHN3aXRjaGVkIG9uLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhhZEZ1bk1vZGUoKTogYm9vbGVhbiB7XG4gIHJldHVybiBsZWdhY3lGdW5Nb2RlO1xufVxuXG4vKiogU2V0dGluZ3MgY2hhbmdlZCBpbiB0aGlzIHRhYiBhbmQgbm90IHNhdmVkIHlldC4gKi9cbmNvbnN0IHVuc2F2ZWQgPSBuZXcgU2V0PGtleW9mIFNldHRpbmdzPigpO1xuXG4vKiogVGhlIHN0b3JlZCBjb25maWcgbWFwLCBmcmVzaCBmcm9tIFN0YXNoICh1bmRlZmluZWQgaWYgU3Rhc2ggQmF0dGxlIG5ldmVyIHNhdmVkIG9uZSkuICovXG5hc3luYyBmdW5jdGlvbiBmZXRjaFN0b3JlZENvbmZpZygpOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkPiB7XG4gIGNvbnN0IGRhdGEgPSBhd2FpdCBncmFwaHFsUXVlcnk8eyBjb25maWd1cmF0aW9uOiB7IHBsdWdpbnM6IFJlY29yZDxzdHJpbmcsIFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB9IH0+KFxuICAgIENPTkZJR19RVUVSWSxcbiAgKTtcbiAgcmV0dXJuIGRhdGEuY29uZmlndXJhdGlvbi5wbHVnaW5zPy5bUExVR0lOX0lEXTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcGVyc2lzdFNldHRpbmdzKCk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBjb25zdCBrZXlzID0gWy4uLnVuc2F2ZWRdO1xuICB1bnNhdmVkLmNsZWFyKCk7XG4gIHRyeSB7XG4gICAgLy8gY29uZmlndXJlUGx1Z2luIHJlcGxhY2VzIHRoZSB3aG9sZSBtYXAsIHNvIHRoaXMgdGFiJ3MgdW5zYXZlZCBjaGFuZ2VzIGdvIG9uIHRvcCBvZiB0aGVcbiAgICAvLyBzdG9yZWQgY29uZmlnLCBub3QgdGhpcyB0YWIncyBjb3B5IG9mIGl0OiBhbm90aGVyIHRhYiBtYXkgaGF2ZSBzYXZlZCBzaW5jZSB0aGlzIG9uZSBsb2FkZWRcbiAgICAvLyAoZmluaXNoZWQgdGhlIEVMTyBzZXR1cCwgc2F5KSwgYW5kIGFuIG9sZGVyIGNvcHkgd291bGQgdW5kbyB0aGF0LlxuICAgIGNvbnN0IHN0b3JlZCA9IGF3YWl0IGZldGNoU3RvcmVkQ29uZmlnKCk7XG4gICAgY29uc3QgbWVyZ2VkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHN0b3JlZCA/IHsgLi4ubm9ybWFsaXplKHN0b3JlZCwgc3RhdGUuc2V0dGluZ3MpIH0gOiB7IC4uLnN0YXRlLnNldHRpbmdzIH07XG4gICAgZm9yIChjb25zdCBrZXkgb2Yga2V5cykgbWVyZ2VkW2tleV0gPSBzdGF0ZS5zZXR0aW5nc1trZXldO1xuICAgIC8vIFVuc2V0IGtleXMgYXJlIGxlZnQgb3V0XG4gICAgY29uc3QgaW5wdXQgPSBPYmplY3QuZnJvbUVudHJpZXMoT2JqZWN0LmVudHJpZXMobWVyZ2VkKS5maWx0ZXIoKFssIHZhbHVlXSkgPT4gdmFsdWUgIT09IG51bGwpKTtcbiAgICBhd2FpdCBncmFwaHFsUXVlcnkoQ09ORklHVVJFX1BMVUdJTl9NVVRBVElPTiwgeyBwbHVnaW5faWQ6IFBMVUdJTl9JRCwgaW5wdXQgfSk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0gRmFpbGVkIHRvIHNhdmUgc2V0dGluZ3M6XCIsIGUpO1xuICAgIGZvciAoY29uc3Qga2V5IG9mIGtleXMpIHVuc2F2ZWQuYWRkKGtleSk7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbi8qKiBVcGRhdGUgc2V0dGluZ3MgbG9jYWxseSByaWdodCBhd2F5IGFuZCBwZXJzaXN0IHRvIFN0YXNoIChkZWJvdW5jZWQsIGZvciBzbGlkZXJzKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiB1cGRhdGVTZXR0aW5ncyhwYXRjaDogUGFydGlhbDxTZXR0aW5ncz4pOiB2b2lkIHtcbiAgc3RhdGUuc2V0dGluZ3MgPSBub3JtYWxpemUoeyAuLi5zdGF0ZS5zZXR0aW5ncywgLi4ucGF0Y2ggfSwgc3RhdGUuc2V0dGluZ3MpO1xuICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhwYXRjaCkgYXMgKGtleW9mIFNldHRpbmdzKVtdKSB1bnNhdmVkLmFkZChrZXkpO1xuICBpZiAoc2F2ZVRpbWVyKSBjbGVhclRpbWVvdXQoc2F2ZVRpbWVyKTtcbiAgc2F2ZVRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgc2F2ZVRpbWVyID0gbnVsbDtcbiAgICB2b2lkIHBlcnNpc3RTZXR0aW5ncygpO1xuICB9LCBTQVZFX0RFQk9VTkNFX01TKTtcbn1cblxuLyoqIFVwZGF0ZSBzZXR0aW5ncyBhbmQgc2F2ZSB0byBTdGFzaCByaWdodCBhd2F5IChubyBkZWJvdW5jZSkuIFJlc29sdmVzIGZhbHNlIGlmIHNhdmluZyBmYWlsZWQuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdXBkYXRlU2V0dGluZ3NOb3cocGF0Y2g6IFBhcnRpYWw8U2V0dGluZ3M+KTogUHJvbWlzZTxib29sZWFuPiB7XG4gIHN0YXRlLnNldHRpbmdzID0gbm9ybWFsaXplKHsgLi4uc3RhdGUuc2V0dGluZ3MsIC4uLnBhdGNoIH0sIHN0YXRlLnNldHRpbmdzKTtcbiAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXMocGF0Y2gpIGFzIChrZXlvZiBTZXR0aW5ncylbXSkgdW5zYXZlZC5hZGQoa2V5KTtcbiAgaWYgKHNhdmVUaW1lcikge1xuICAgIGNsZWFyVGltZW91dChzYXZlVGltZXIpO1xuICAgIHNhdmVUaW1lciA9IG51bGw7XG4gIH1cbiAgcmV0dXJuIHBlcnNpc3RTZXR0aW5ncygpO1xufVxuIiwgIi8vIFBlcnNpc3QvcmVzdG9yZSB0aGUgYmF0dGxlIHNlc3Npb24gdG8gbG9jYWxTdG9yYWdlLlxuXG5pbXBvcnQgeyBTVE9SQUdFX0tFWSB9IGZyb20gXCIuL2NvbnN0YW50c1wiO1xuaW1wb3J0IHsgc3RhdGUgfSBmcm9tIFwiLi9zdGF0ZVwiO1xuaW1wb3J0IHR5cGUgeyBNb2RlLCBQYWlyLCBQbGFjZW1lbnRSdW4sIFJhbmtzLCBTY2VuZSB9IGZyb20gXCIuL3R5cGVzXCI7XG5cbi8qKlxuICogQnVtcGVkIHdoZW4gc2F2ZWQgc2Vzc2lvbnMgY2FuJ3QgYmUgcmVzdG9yZWQgYXMgdGhleSBhcmUuIDMgKDMuMCk6IHNjZW5lcyBhcmUgcmFua2VkIGJ5IEVMT1xuICogZnJvbSBjdXN0b20gZmllbGRzLCB3aGljaCBvbGRlciBzYXZlZCBzY2VuZXMgbGFjaywgYW5kIEdhdW50bGV0IHJ1bnMgbm8gbG9uZ2VyIGV4aXN0LlxuICovXG5jb25zdCBTVEFURV9WRVJTSU9OID0gMztcblxuY29uc3QgTU9ERVM6IHJlYWRvbmx5IE1vZGVbXSA9IFtcInN3aXNzXCIsIFwicGxhY2VtZW50XCIsIFwiY2hhbXBpb25cIl07XG5cbmludGVyZmFjZSBQZXJzaXN0ZWRTdGF0ZSB7XG4gIHZlcnNpb24/OiBudW1iZXI7XG4gIGN1cnJlbnRQYWlyPzogUGFpcjtcbiAgY3VycmVudFJhbmtzPzogUmFua3M7XG4gIGN1cnJlbnRNb2RlPzogc3RyaW5nO1xuICBjaGFtcGlvblNjZW5lPzogU2NlbmUgfCBudWxsO1xuICBjaGFtcGlvbldpbnM/OiBudW1iZXI7XG4gIGNoYW1waW9uRGVmZWF0ZWQ/OiBzdHJpbmdbXTtcbiAgcGxhY2VtZW50PzogUGxhY2VtZW50UnVuIHwgbnVsbDtcbiAgdG90YWxTY2VuZXNDb3VudD86IG51bWJlcjtcbiAgc2F2ZWRGaWx0ZXJQYXJhbXM/OiBzdHJpbmc7XG59XG5cbi8qKiBBIHNhdmVkIG1vZGUgbmFtZSBhcyBhIGN1cnJlbnQgbW9kZTogR2F1bnRsZXQgYmVjYW1lIFBsYWNlbWVudCdzIFwiU3RhcnQgZnJvbSB0aGUgYm90dG9tXCIuICovXG5mdW5jdGlvbiByZXN0b3JlTW9kZShzYXZlZDogc3RyaW5nIHwgdW5kZWZpbmVkKTogTW9kZSB7XG4gIGlmIChzYXZlZCA9PT0gXCJnYXVudGxldFwiKSByZXR1cm4gXCJwbGFjZW1lbnRcIjtcbiAgcmV0dXJuIE1PREVTLmluY2x1ZGVzKHNhdmVkIGFzIE1vZGUpID8gKHNhdmVkIGFzIE1vZGUpIDogXCJzd2lzc1wiO1xufVxuXG4vKiogU2F2ZXMgdGhlIGN1cnJlbnQgYmF0dGxlIHNlc3Npb24gdG8gbG9jYWxTdG9yYWdlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNhdmVTdGF0ZSgpOiB2b2lkIHtcbiAgY29uc3Qgc25hcHNob3Q6IFBlcnNpc3RlZFN0YXRlID0ge1xuICAgIHZlcnNpb246IFNUQVRFX1ZFUlNJT04sXG4gICAgY3VycmVudFBhaXI6IHN0YXRlLmN1cnJlbnRQYWlyLFxuICAgIGN1cnJlbnRSYW5rczogc3RhdGUuY3VycmVudFJhbmtzLFxuICAgIGN1cnJlbnRNb2RlOiBzdGF0ZS5jdXJyZW50TW9kZSxcbiAgICBjaGFtcGlvblNjZW5lOiBzdGF0ZS5jaGFtcGlvblNjZW5lLFxuICAgIGNoYW1waW9uV2luczogc3RhdGUuY2hhbXBpb25XaW5zLFxuICAgIGNoYW1waW9uRGVmZWF0ZWQ6IHN0YXRlLmNoYW1waW9uRGVmZWF0ZWQsXG4gICAgcGxhY2VtZW50OiBzdGF0ZS5wbGFjZW1lbnQsXG4gICAgdG90YWxTY2VuZXNDb3VudDogc3RhdGUudG90YWxTY2VuZXNDb3VudCxcbiAgICBzYXZlZEZpbHRlclBhcmFtczogd2luZG93LmxvY2F0aW9uLnNlYXJjaCxcbiAgfTtcbiAgdHJ5IHtcbiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShTVE9SQUdFX0tFWSwgSlNPTi5zdHJpbmdpZnkoc25hcHNob3QpKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnNvbGUuZXJyb3IoXCJbU3Rhc2ggQmF0dGxlXSBGYWlsZWQgdG8gc2F2ZSBzdGF0ZTpcIiwgZSk7XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGxvYWRTdGF0ZSgpOiBib29sZWFuIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBzYXZlZCA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFNUT1JBR0VfS0VZKTtcbiAgICBpZiAoc2F2ZWQpIHtcbiAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2Uoc2F2ZWQpIGFzIFBlcnNpc3RlZFN0YXRlO1xuICAgICAgc3RhdGUuY3VycmVudE1vZGUgPSByZXN0b3JlTW9kZShwYXJzZWQuY3VycmVudE1vZGUpO1xuICAgICAgc3RhdGUuc2F2ZWRGaWx0ZXJQYXJhbXMgPSBwYXJzZWQuc2F2ZWRGaWx0ZXJQYXJhbXMgfHwgXCJcIjtcbiAgICAgIGlmIChwYXJzZWQudmVyc2lvbiAhPT0gU1RBVEVfVkVSU0lPTikge1xuICAgICAgICAvLyBPbGRlciBzZXNzaW9ucyBob2xkIHNjZW5lcyB3aXRob3V0IEVMTzoga2VlcCB0aGUgbW9kZSwgc3RhcnQgYSBmcmVzaCBwYWlyIGFuZCBydW5cbiAgICAgICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5OLIFNhdmVkIHNlc3Npb24gaXMgZnJvbSBhbiBvbGRlciB2ZXJzaW9uLCBzdGFydGluZyBmcmVzaFwiKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9XG4gICAgICBzdGF0ZS5jdXJyZW50UGFpciA9IHBhcnNlZC5jdXJyZW50UGFpciB8fCB7IGxlZnQ6IG51bGwsIHJpZ2h0OiBudWxsIH07XG4gICAgICBzdGF0ZS5jdXJyZW50UmFua3MgPSBwYXJzZWQuY3VycmVudFJhbmtzIHx8IHsgbGVmdDogbnVsbCwgcmlnaHQ6IG51bGwgfTtcbiAgICAgIHN0YXRlLmNoYW1waW9uU2NlbmUgPSBwYXJzZWQuY2hhbXBpb25TY2VuZSA/PyBudWxsO1xuICAgICAgc3RhdGUuY2hhbXBpb25XaW5zID0gcGFyc2VkLmNoYW1waW9uV2lucyB8fCAwO1xuICAgICAgc3RhdGUuY2hhbXBpb25EZWZlYXRlZCA9IHBhcnNlZC5jaGFtcGlvbkRlZmVhdGVkIHx8IFtdO1xuICAgICAgc3RhdGUucGxhY2VtZW50ID0gcGFyc2VkLnBsYWNlbWVudCB8fCBudWxsO1xuICAgICAgc3RhdGUudG90YWxTY2VuZXNDb3VudCA9IHBhcnNlZC50b3RhbFNjZW5lc0NvdW50IHx8IDA7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0gRmFpbGVkIHRvIGxvYWQgc3RhdGU6XCIsIGUpO1xuICB9XG4gIHJldHVybiBmYWxzZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNsZWFyU3RhdGUoKTogdm9pZCB7XG4gIHRyeSB7XG4gICAgbG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oU1RPUkFHRV9LRVkpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIEZhaWxlZCB0byBjbGVhciBzdGF0ZTpcIiwgZSk7XG4gIH1cbn1cbiIsICIvLyBBIHNtYWxsIGNvbmZpcm1hdGlvbiBkaWFsb2cgaW5zaWRlIHRoZSBTdGFzaCBCYXR0bGUgbW9kYWwgKHN3aXRjaGluZyBTdGFzaCByYXRpbmdzLCBSZXNldCBFTE8pLlxuLy8gVGhlIGNvbmZpcm0gYnV0dG9uIGNhbiBydW4gYW4gYXN5bmMgYWN0aW9uOiB0aGUgZGlhbG9nIHN0YXlzIG9wZW4gd2hpbGUgaXQgcnVucywgY2xvc2VzIHdoZW5cbi8vIGl0IHN1Y2NlZWRzLCBhbmQgc2hvd3MgdGhlIGVycm9yIGlmIGl0IGZhaWxzLlxuXG5leHBvcnQgaW50ZXJmYWNlIENvbmZpcm1EaWFsb2dPcHRpb25zIHtcbiAgdGl0bGU6IHN0cmluZztcbiAgLyoqIEhUTUwgYm9keS4gKi9cbiAgYm9keTogc3RyaW5nO1xuICBjb25maXJtTGFiZWw6IHN0cmluZztcbiAgLyoqIExhYmVsIG9uIHRoZSBjb25maXJtIGJ1dHRvbiB3aGlsZSBgYWN0aW9uYCBydW5zLiAqL1xuICB3b3JraW5nTGFiZWw/OiBzdHJpbmc7XG4gIC8qKiBSdW5zIG9uIGNvbmZpcm07IHRoZSBkaWFsb2cgcmVzb2x2ZXMgdHJ1ZSBvbmx5IG9uY2UgaXQgc3VjY2VlZHMuICovXG4gIGFjdGlvbj86ICgpID0+IFByb21pc2U8dm9pZD47XG59XG5cbmxldCBjYW5jZWxPcGVuOiAoKCkgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcblxuZXhwb3J0IGZ1bmN0aW9uIGlzQ29uZmlybURpYWxvZ09wZW4oKTogYm9vbGVhbiB7XG4gIHJldHVybiBjYW5jZWxPcGVuICE9PSBudWxsO1xufVxuXG4vKiogQ2FuY2VsIHRoZSBvcGVuIGRpYWxvZyAoRXNjYXBlKSwgdW5sZXNzIGl0cyBhY3Rpb24gaXMgcnVubmluZy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjYW5jZWxDb25maXJtRGlhbG9nKCk6IHZvaWQge1xuICBjYW5jZWxPcGVuPy4oKTtcbn1cblxuLyoqIFNob3cgdGhlIGRpYWxvZzsgcmVzb2x2ZXMgdHJ1ZSB3aGVuIGNvbmZpcm1lZCAoYW5kIGl0cyBhY3Rpb24gc3VjY2VlZGVkKSwgZmFsc2Ugd2hlbiBjYW5jZWxsZWQuICovXG5leHBvcnQgZnVuY3Rpb24gY29uZmlybURpYWxvZyhvcHRzOiBDb25maXJtRGlhbG9nT3B0aW9ucyk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBjYW5jZWxPcGVuPy4oKTtcbiAgY29uc3QgaG9zdCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic2ItbW9kYWxcIik7XG4gIGlmICghaG9zdCkgcmV0dXJuIFByb21pc2UucmVzb2x2ZShmYWxzZSk7XG5cbiAgY29uc3Qgb3ZlcmxheSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIG92ZXJsYXkuY2xhc3NOYW1lID0gXCJzYi1kaWFsb2ctYmFja2Ryb3BcIjtcbiAgb3ZlcmxheS5pbm5lckhUTUwgPSBgXG4gICAgICA8ZGl2IGNsYXNzPVwic2ItZGlhbG9nXCIgcm9sZT1cImRpYWxvZ1wiIGFyaWEtbW9kYWw9XCJ0cnVlXCIgYXJpYS1sYWJlbGxlZGJ5PVwic2ItZGlhbG9nLXRpdGxlXCI+XG4gICAgICAgIDxoMyBpZD1cInNiLWRpYWxvZy10aXRsZVwiIGNsYXNzPVwic2ItZGlhbG9nLXRpdGxlXCI+JHtvcHRzLnRpdGxlfTwvaDM+XG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi1kaWFsb2ctYm9keVwiPiR7b3B0cy5ib2R5fTwvZGl2PlxuICAgICAgICA8cCBjbGFzcz1cInNiLWRpYWxvZy1lcnJvclwiIGhpZGRlbj48L3A+XG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi1kaWFsb2ctYWN0aW9uc1wiPlxuICAgICAgICAgIDxidXR0b24gdHlwZT1cImJ1dHRvblwiIGNsYXNzPVwiYnRuIGJ0bi1zZWNvbmRhcnlcIiBkYXRhLXJvbGU9XCJjYW5jZWxcIj5DYW5jZWw8L2J1dHRvbj5cbiAgICAgICAgICA8YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cImJ0biBidG4tcHJpbWFyeVwiIGRhdGEtcm9sZT1cImNvbmZpcm1cIj4ke29wdHMuY29uZmlybUxhYmVsfTwvYnV0dG9uPlxuICAgICAgICA8L2Rpdj5cbiAgICAgIDwvZGl2PmA7XG4gIGhvc3QuYXBwZW5kQ2hpbGQob3ZlcmxheSk7XG5cbiAgY29uc3QgY29uZmlybUJ0biA9IG92ZXJsYXkucXVlcnlTZWxlY3RvcjxIVE1MQnV0dG9uRWxlbWVudD4oJ1tkYXRhLXJvbGU9XCJjb25maXJtXCJdJykgYXMgSFRNTEJ1dHRvbkVsZW1lbnQ7XG4gIGNvbnN0IGNhbmNlbEJ0biA9IG92ZXJsYXkucXVlcnlTZWxlY3RvcjxIVE1MQnV0dG9uRWxlbWVudD4oJ1tkYXRhLXJvbGU9XCJjYW5jZWxcIl0nKSBhcyBIVE1MQnV0dG9uRWxlbWVudDtcbiAgY29uc3QgZXJyb3IgPSBvdmVybGF5LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiLnNiLWRpYWxvZy1lcnJvclwiKSBhcyBIVE1MRWxlbWVudDtcbiAgY29uZmlybUJ0bi5mb2N1cygpO1xuXG4gIHJldHVybiBuZXcgUHJvbWlzZTxib29sZWFuPigocmVzb2x2ZSkgPT4ge1xuICAgIGxldCBidXN5ID0gZmFsc2U7XG4gICAgY29uc3QgY2xvc2UgPSAocmVzdWx0OiBib29sZWFuKTogdm9pZCA9PiB7XG4gICAgICBvdmVybGF5LnJlbW92ZSgpO1xuICAgICAgY2FuY2VsT3BlbiA9IG51bGw7XG4gICAgICByZXNvbHZlKHJlc3VsdCk7XG4gICAgfTtcbiAgICBjYW5jZWxPcGVuID0gKCkgPT4ge1xuICAgICAgaWYgKCFidXN5KSBjbG9zZShmYWxzZSk7XG4gICAgfTtcblxuICAgIGNhbmNlbEJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4gY2FuY2VsT3Blbj8uKCkpO1xuICAgIG92ZXJsYXkuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XG4gICAgICBpZiAoZS50YXJnZXQgPT09IG92ZXJsYXkpIGNhbmNlbE9wZW4/LigpO1xuICAgIH0pO1xuICAgIGNvbmZpcm1CdG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIGFzeW5jICgpID0+IHtcbiAgICAgIGlmICghb3B0cy5hY3Rpb24pIHtcbiAgICAgICAgY2xvc2UodHJ1ZSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGJ1c3kgPSB0cnVlO1xuICAgICAgZXJyb3IuaGlkZGVuID0gdHJ1ZTtcbiAgICAgIGNvbmZpcm1CdG4uZGlzYWJsZWQgPSBjYW5jZWxCdG4uZGlzYWJsZWQgPSB0cnVlO1xuICAgICAgY29uZmlybUJ0bi50ZXh0Q29udGVudCA9IG9wdHMud29ya2luZ0xhYmVsID8/IFwiV29ya2luZy4uLlwiO1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgb3B0cy5hY3Rpb24oKTtcbiAgICAgICAgY2xvc2UodHJ1ZSk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGJ1c3kgPSBmYWxzZTtcbiAgICAgICAgY29uZmlybUJ0bi5kaXNhYmxlZCA9IGNhbmNlbEJ0bi5kaXNhYmxlZCA9IGZhbHNlO1xuICAgICAgICBjb25maXJtQnRuLnRleHRDb250ZW50ID0gb3B0cy5jb25maXJtTGFiZWw7XG4gICAgICAgIGVycm9yLnRleHRDb250ZW50ID0gYFRoYXQgZGlkbid0IHdvcms6ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfS4gWW91IGNhbiB0cnkgYWdhaW4uYDtcbiAgICAgICAgZXJyb3IuaGlkZGVuID0gZmFsc2U7XG4gICAgICB9XG4gICAgfSk7XG4gIH0pO1xufVxuIiwgIi8vIFNQQSBuYXZpZ2F0aW9uIGhlbHBlcnMuXHJcblxyXG5pbXBvcnQgeyBjbG9zZU1vZGFsIH0gZnJvbSBcIi4vdWkvbW9kYWxcIjtcclxuXHJcbi8vIE5hdmlnYXRlIHVzaW5nIFJlYWN0IFJvdXRlciAocHJlc2VydmVzIEpTIHN0YXRlKVxyXG5leHBvcnQgZnVuY3Rpb24gbmF2aWdhdGVUb1VybCh1cmw6IHN0cmluZyk6IHZvaWQge1xyXG4gIGNsb3NlTW9kYWwoKTtcclxuXHJcbiAgLy8gVXNlIEhpc3RvcnkgQVBJICsgcG9wc3RhdGUgZXZlbnQgdG8gdHJpZ2dlciBSZWFjdCBSb3V0ZXIgbmF2aWdhdGlvblxyXG4gIGNvbnN0IHBhdGggPSB1cmwuc3RhcnRzV2l0aChcIi9cIikgPyB1cmwgOiBuZXcgVVJMKHVybCkucGF0aG5hbWUgKyBuZXcgVVJMKHVybCkuc2VhcmNoO1xyXG4gIHdpbmRvdy5oaXN0b3J5LnB1c2hTdGF0ZSh7fSwgXCJcIiwgcGF0aCk7XHJcbiAgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IFBvcFN0YXRlRXZlbnQoXCJwb3BzdGF0ZVwiLCB7IHN0YXRlOiB7fSB9KSk7XHJcbn1cclxuIiwgIi8vIFBsYWNlbWVudCBzZWFyY2gsIGtlcHQgcHVyZSAobm8gc3RhdGUgb3IgSS9PKSBzbyB3aG9sZSBydW5zIGNhbiBiZSBzaW11bGF0ZWQgaW4gdGVzdHMuXG4vL1xuLy8gVGhlIHNjZW5lJ3Mgc2xvdCBsaWVzIGluIFtsbywgaGkpIG9mIHRoZSBFTE8tc29ydGVkIG9wcG9uZW50IHBvb2wuIEEgd2luIGFnYWluc3QgaW5kZXggaVxuLy8gbWVhbnMgdGhlIHNsb3QgaXMgYWJvdmUgaSAoaGkgPSBpKTsgYSBsb3NzIG1lYW5zIGl0J3MgYmVsb3cgKGxvID0gaSArIDEpLiBBIHJhdGVkIHNjZW5lIHN0YXJ0c1xuLy8gbmV4dCB0byBpdHMgY3VycmVudCBFTE8gYW5kIGdhbGxvcHMgKHN0ZXBzIDEsIDIsIDQsIDguLi4pIHdoaWxlIHJlc3VsdHMga2VlcCBnb2luZyB0aGUgc2FtZVxuLy8gd2F5OyB0aGUgZmlyc3QgcmV2ZXJzYWwgKG9yIGFuIHVucmF0ZWQgc2NlbmUpIHN3aXRjaGVzIHRvIGhhbHZpbmcgdGhlIHJlbWFpbmluZyByYW5nZS5cbi8vIFwiU3RhcnQgZnJvbSB0aGUgYm90dG9tXCIgcnVucyBpZ25vcmUgdGhlIHNjZW5lJ3MgRUxPOiB0aGV5IHN0YXJ0IGFnYWluc3QgdGhlIGJvdHRvbSBzY2VuZSBhbmRcbi8vIGdhbGxvcCB1cHdhcmQsIHNvIGVhY2ggd2luIGRvdWJsZXMgdGhlIGp1bXAgdW50aWwgdGhlIGZpcnN0IGxvc3MuXG5cbmltcG9ydCB7IFBMQUNFTUVOVF9NQVhfSlVNUF9TSEFSRSwgUExBQ0VNRU5UX01JTl9NQVhfSlVNUCB9IGZyb20gXCIuL2NvbnN0YW50c1wiO1xuaW1wb3J0IHsgZWxvLCBlbG9JbnNlcnRpb25JbmRleCwgcGxhY2VtZW50RWxvIH0gZnJvbSBcIi4vc2NvcmVcIjtcbmltcG9ydCB0eXBlIHsgUGxhY2VtZW50UnVuLCBTY2VuZSB9IGZyb20gXCIuL3R5cGVzXCI7XG5cbmV4cG9ydCBmdW5jdGlvbiBuZXdQbGFjZW1lbnRSdW4oc2NlbmU6IFNjZW5lLCBmcm9tQm90dG9tOiBib29sZWFuKTogUGxhY2VtZW50UnVuIHtcbiAgcmV0dXJuIHtcbiAgICBzY2VuZSxcbiAgICBmcm9tQm90dG9tLFxuICAgIGFib3ZlSWQ6IG51bGwsXG4gICAgYmVsb3dJZDogbnVsbCxcbiAgICBsYXN0T3Bwb25lbnRJZDogbnVsbCxcbiAgICBsYXN0V29uOiBudWxsLFxuICAgIGdhbGxvcGluZzogZnJvbUJvdHRvbSB8fCBlbG8oc2NlbmUpICE9PSBudWxsLFxuICAgIHN0ZXA6IDEsXG4gICAgYmF0dGxlczogMCxcbiAgICBzdHJlYWs6IDAsXG4gICAgcmFuZ2VMbzogMCxcbiAgICByYW5nZUhpOiAwLFxuICB9O1xufVxuXG4vKiogSW5kZXggb2YgdGhlIGVuZCBvZiBwb29sW2lkeF0ncyB0aWUgZ3JvdXAgKHNjZW5lcyB3aXRoIHRoZSBzYW1lIEVMTykgaW4gZGlyZWN0aW9uIGBkaXJgLiAqL1xuZnVuY3Rpb24gdGllR3JvdXBFZGdlKHBvb2w6IFNjZW5lW10sIGlkeDogbnVtYmVyLCBkaXI6IDEgfCAtMSk6IG51bWJlciB7XG4gIGNvbnN0IHZhbHVlID0gZWxvKHBvb2xbaWR4XSk7XG4gIGxldCBlZGdlID0gaWR4O1xuICB3aGlsZSAoZWRnZSArIGRpciA+PSAwICYmIGVkZ2UgKyBkaXIgPCBwb29sLmxlbmd0aCAmJiBlbG8ocG9vbFtlZGdlICsgZGlyXSkgPT09IHZhbHVlKSBlZGdlICs9IGRpcjtcbiAgcmV0dXJuIGVkZ2U7XG59XG5cbi8qKlxuICogQ3VycmVudCBbbG8sIGhpKSBzbG90IGJvdW5kcywgcmVzb2x2ZWQgZnJvbSB0aGUgYm91bmRpbmcgb3Bwb25lbnRzJyBpZHMuIEEgcmVzdWx0IGNvdW50cyBmb3JcbiAqIHRoZSBvcHBvbmVudCdzIHdob2xlIHRpZSBncm91cDogYSBzY2VuZSBjYW4gb25seSBnZXQgYW4gRUxPIGFib3ZlIG9yIGJlbG93IGEgZ3JvdXAgb2YgZXF1YWxcbiAqIEVMT3MsIG5vdCBpbnNpZGUgaXQsIHNvIHRoZSBzbG90IGFsd2F5cyBlbmRzIGF0IGEgZ3JvdXAncyBlZGdlIGFuZCB0aGUgbGFuZGluZyBFTE8ga2VlcHMgaXQgdGhlcmUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwbGFjZW1lbnRCb3VuZHMocnVuOiBQbGFjZW1lbnRSdW4sIHBvb2w6IFNjZW5lW10pOiB7IGxvOiBudW1iZXI7IGhpOiBudW1iZXIgfSB7XG4gIGNvbnN0IGFib3ZlSWR4ID0gcnVuLmFib3ZlSWQgPyBwb29sLmZpbmRJbmRleCgocykgPT4gcy5pZCA9PT0gcnVuLmFib3ZlSWQpIDogLTE7XG4gIGNvbnN0IGJlbG93SWR4ID0gcnVuLmJlbG93SWQgPyBwb29sLmZpbmRJbmRleCgocykgPT4gcy5pZCA9PT0gcnVuLmJlbG93SWQpIDogLTE7XG4gIHJldHVybiB7XG4gICAgbG86IGFib3ZlSWR4ID49IDAgPyB0aWVHcm91cEVkZ2UocG9vbCwgYWJvdmVJZHgsIDEpICsgMSA6IDAsXG4gICAgaGk6IGJlbG93SWR4ID49IDAgPyB0aWVHcm91cEVkZ2UocG9vbCwgYmVsb3dJZHgsIC0xKSA6IHBvb2wubGVuZ3RoLFxuICB9O1xufVxuXG4vKiogVGhlIHBvb2wncyBsb3dlc3Qgc2NlbmUgd2l0aCBhbiBFTE8gKHVucmF0ZWQgb25lcyBzb3J0IGxhc3QpLCBvciBpdHMgbGFzdCBzY2VuZSBpZiBub25lIGhhcyBvbmUuICovXG5leHBvcnQgZnVuY3Rpb24gYm90dG9tSW5kZXgocG9vbDogU2NlbmVbXSk6IG51bWJlciB7XG4gIGZvciAobGV0IGkgPSBwb29sLmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7XG4gICAgaWYgKGVsbyhwb29sW2ldKSAhPT0gbnVsbCkgcmV0dXJuIGk7XG4gIH1cbiAgcmV0dXJuIHBvb2wubGVuZ3RoIC0gMTtcbn1cblxuLyoqIExhcmdlc3QganVtcCBhIGdhbGxvcGluZyBydW4gbWFrZXMgaW4gdGhpcyBwb29sIChzZWUgUExBQ0VNRU5UX01BWF9KVU1QX1NIQVJFKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtYXhQbGFjZW1lbnRKdW1wKHBvb2xTaXplOiBudW1iZXIpOiBudW1iZXIge1xuICByZXR1cm4gTWF0aC5tYXgoUExBQ0VNRU5UX01JTl9NQVhfSlVNUCwgTWF0aC5yb3VuZChwb29sU2l6ZSAqIFBMQUNFTUVOVF9NQVhfSlVNUF9TSEFSRSkpO1xufVxuXG4vKiogV2hlcmUgdGhlIG5leHQgb3Bwb25lbnQgc2hvdWxkIGNvbWUgZnJvbSAoYmVmb3JlIGNsYW1waW5nIGludG8gW2xvLCBoaSkpLiAqL1xuZnVuY3Rpb24gbmV4dFBsYWNlbWVudEluZGV4KHJ1bjogUGxhY2VtZW50UnVuLCBwb29sOiBTY2VuZVtdLCBsbzogbnVtYmVyLCBoaTogbnVtYmVyKTogbnVtYmVyIHtcbiAgaWYgKHJ1bi5nYWxsb3BpbmcpIHtcbiAgICBpZiAocnVuLmxhc3RPcHBvbmVudElkID09PSBudWxsKSB7XG4gICAgICBpZiAocnVuLmZyb21Cb3R0b20pIHJldHVybiBib3R0b21JbmRleChwb29sKTtcbiAgICAgIC8vIFN0YXJ0IGp1c3QgYmVsb3cgdGhlIHNjZW5lJ3MgY3VycmVudCBFTE86IGEgY29ycmVjdGx5IHJhdGVkIHNjZW5lIGNvbmZpcm1zIGluIH4yIGJhdHRsZXNcbiAgICAgIHJldHVybiBlbG9JbnNlcnRpb25JbmRleChwb29sLCBlbG8ocnVuLnNjZW5lKSA/PyAwKTtcbiAgICB9XG4gICAgY29uc3QgbGFzdElkeCA9IHBvb2wuZmluZEluZGV4KChzKSA9PiBzLmlkID09PSBydW4ubGFzdE9wcG9uZW50SWQpO1xuICAgIGlmIChsYXN0SWR4ID49IDApIHtcbiAgICAgIC8vIFN0ZXAgZnJvbSB0aGUgZmFyIGVkZ2Ugb2YgdGhlIGxhc3Qgb3Bwb25lbnQncyB0aWUgZ3JvdXA6IGFub3RoZXIgZXF1YWwgRUxPIHRlYWNoZXMgbm90aGluZ1xuICAgICAgY29uc3QgZGlyID0gcnVuLmxhc3RXb24gPyAtMSA6IDE7XG4gICAgICBjb25zdCB0YXJnZXQgPSB0aWVHcm91cEVkZ2UocG9vbCwgbGFzdElkeCwgZGlyKSArIGRpciAqIE1hdGgubWluKHJ1bi5zdGVwLCBtYXhQbGFjZW1lbnRKdW1wKHBvb2wubGVuZ3RoKSk7XG4gICAgICAvLyBBIGp1bXAgcGFzdCB0aGUgc2VhcmNoIHJhbmdlIHdvdWxkIGxhbmQgb24gaXRzIGVuZCAoc3RyYWlnaHQgdG8gIzEsIHNheSk6IGhhbHZlIGluc3RlYWRcbiAgICAgIGlmICh0YXJnZXQgPj0gbG8gJiYgdGFyZ2V0IDwgaGkpIHJldHVybiB0YXJnZXQ7XG4gICAgfVxuICB9XG4gIHJldHVybiBsbyArIE1hdGguZmxvb3IoKGhpIC0gbG8pIC8gMik7XG59XG5cbmV4cG9ydCB0eXBlIFBsYWNlbWVudFN0ZXAgPVxuICB8IHsgZG9uZTogdHJ1ZTsgc2xvdDogbnVtYmVyOyBsbzogbnVtYmVyOyBoaTogbnVtYmVyIH1cbiAgfCB7IGRvbmU6IGZhbHNlOyBpbmRleDogbnVtYmVyOyBsbzogbnVtYmVyOyBoaTogbnVtYmVyIH07XG5cbi8qKiBUaGUgcnVuJ3MgbmV4dCBzdGVwIG9uIHRoaXMgcG9vbDogdGhlIG9wcG9uZW50IGluZGV4IHRvIGJhdHRsZSwgb3IgdGhlIHNsb3QgaXQgaGFzIGxhbmRlZCBpbi4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwbGFjZW1lbnRTdGVwKHJ1bjogUGxhY2VtZW50UnVuLCBwb29sOiBTY2VuZVtdKTogUGxhY2VtZW50U3RlcCB7XG4gIGNvbnN0IHsgbG8sIGhpIH0gPSBwbGFjZW1lbnRCb3VuZHMocnVuLCBwb29sKTtcbiAgaWYgKGxvID49IGhpKSByZXR1cm4geyBkb25lOiB0cnVlLCBzbG90OiBNYXRoLm1pbihsbywgaGkpLCBsbywgaGkgfTtcbiAgY29uc3QgaW5kZXggPSBNYXRoLm1heChsbywgTWF0aC5taW4oaGkgLSAxLCBuZXh0UGxhY2VtZW50SW5kZXgocnVuLCBwb29sLCBsbywgaGkpKSk7XG4gIHJldHVybiB7IGRvbmU6IGZhbHNlLCBpbmRleCwgbG8sIGhpIH07XG59XG5cbi8qKiBSZWNvcmQgYSBwbGFjZW1lbnQgYmF0dGxlIHJlc3VsdCBhbmQgdXBkYXRlIHRoZSBtb21lbnR1bSBhbmQgdGhlIHdpbiBzdHJlYWsuICovXG5leHBvcnQgZnVuY3Rpb24gcmVjb3JkUGxhY2VtZW50UmVzdWx0KHJ1bjogUGxhY2VtZW50UnVuLCB3b246IGJvb2xlYW4sIG9wcG9uZW50SWQ6IHN0cmluZyk6IHZvaWQge1xuICBpZiAocnVuLmxhc3RXb24gIT09IG51bGwpIHtcbiAgICBpZiAocnVuLmxhc3RXb24gPT09IHdvbikgcnVuLnN0ZXAgKj0gMjtcbiAgICBlbHNlIHJ1bi5nYWxsb3BpbmcgPSBmYWxzZTtcbiAgfVxuICBpZiAod29uKSBydW4uYmVsb3dJZCA9IG9wcG9uZW50SWQ7XG4gIGVsc2UgcnVuLmFib3ZlSWQgPSBvcHBvbmVudElkO1xuXG4gIC8vIFRoZSBzdHJlYWsgY291bnRzIHdpbnMgdW50aWwgdGhlIGZpcnN0IGxvc3MsIHNvIGl0IG9ubHkgZ3Jvd3Mgd2hpbGUgZXZlcnkgYmF0dGxlIHdhcyBhIHdpblxuICBpZiAod29uICYmIHJ1bi5zdHJlYWsgPT09IHJ1bi5iYXR0bGVzKSBydW4uc3RyZWFrKys7XG4gIHJ1bi5sYXN0T3Bwb25lbnRJZCA9IG9wcG9uZW50SWQ7XG4gIHJ1bi5sYXN0V29uID0gd29uO1xuICBydW4uYmF0dGxlcysrO1xufVxuXG4vKipcbiAqIEVMTyBmb3IgYSBzY2VuZSBsYW5kaW5nIGF0IGBzbG90YCBvZiB0aGUgcG9vbDogYmV0d2VlbiB0aGUgbmVhcmVzdCBuZWlnaGJvdXJzIHRoYXQgaGF2ZSBhbiBFTE9cbiAqICh1bnJhdGVkIG9wcG9uZW50cywgcG9zc2libGUgaW4gYSBmaWx0ZXJlZCBwb29sLCBzYXkgbm90aGluZyBhYm91dCBpdCkuIFNlZSBwbGFjZW1lbnRFbG8uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBsYW5kaW5nRWxvKHBvb2w6IFNjZW5lW10sIHNsb3Q6IG51bWJlcik6IG51bWJlciB7XG4gIGxldCBhYm92ZTogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG4gIGZvciAobGV0IGkgPSBzbG90IC0gMTsgaSA+PSAwICYmIGFib3ZlID09PSBudWxsOyBpLS0pIGFib3ZlID0gZWxvKHBvb2xbaV0pO1xuICBsZXQgYmVsb3c6IG51bWJlciB8IG51bGwgPSBudWxsO1xuICBmb3IgKGxldCBpID0gc2xvdDsgaSA8IHBvb2wubGVuZ3RoICYmIGJlbG93ID09PSBudWxsOyBpKyspIGJlbG93ID0gZWxvKHBvb2xbaV0pO1xuICByZXR1cm4gcGxhY2VtZW50RWxvKGFib3ZlLCBiZWxvdyk7XG59XG4iLCAiLy8gTWF0Y2htYWtpbmc6IGJ1aWxkIHRoZSBzY2VuZSBwYWlycyBmb3IgZWFjaCBjb21wYXJpc29uIG1vZGUuXG5cbmltcG9ydCB7IGNsZWFyRmlsdGVyZWRDYWNoZSwgZ2V0QWxsU2NlbmVzQ2FjaGVkLCBnZXRGaWx0ZXJlZFNjZW5lc0NhY2hlZCwgbGF0ZXN0U2NlbmUgfSBmcm9tIFwiLi9jYWNoZVwiO1xuaW1wb3J0IHtcbiAgQ0hBTVBJT05fVU5SQVRFRF9FTE8sXG4gIENMSU1CX09QUE9ORU5UX1BJQ0tfV0lORE9XLFxuICBTV0lTU19PUFBPTkVOVF9FTE9fV0lORE9XLFxuICBTV0lTU19PUFBPTkVOVF9NSU5fQ0FORElEQVRFUyxcbn0gZnJvbSBcIi4vY29uc3RhbnRzXCI7XG5pbXBvcnQgeyByZWFkRmlsdGVycywgdHlwZSBMaXN0RmlsdGVycyB9IGZyb20gXCIuL2ZpbHRlcnNcIjtcbmltcG9ydCB7IGxhbmRpbmdFbG8sIG5ld1BsYWNlbWVudFJ1biwgcGxhY2VtZW50U3RlcCB9IGZyb20gXCIuL3BsYWNlbWVudFwiO1xuaW1wb3J0IHsgd3JpdGVFbG8gfSBmcm9tIFwiLi9yYXRpbmdcIjtcbmltcG9ydCB7IGJhdHRsZXMsIGVmZmVjdGl2ZUVsbywgZWxvLCBpc1JhdGVkLCBzd2lzc09wcG9uZW50SW5kZXhlcyB9IGZyb20gXCIuL3Njb3JlXCI7XG5pbXBvcnQgeyBzdGF0ZSB9IGZyb20gXCIuL3N0YXRlXCI7XG5pbXBvcnQgdHlwZSB7IENoYW1waW9uUGFpclJlc3VsdCwgUGxhY2VtZW50UGFpclJlc3VsdCwgUmFuaywgU2NlbmUsIFN3aXNzUGFpclJlc3VsdCB9IGZyb20gXCIuL3R5cGVzXCI7XG5cbmZ1bmN0aW9uIHNodWZmbGVBcnJheTxUPihhcnJheTogVFtdKTogVFtdIHtcbiAgY29uc3Qgc2h1ZmZsZWQgPSBbLi4uYXJyYXldO1xuICBmb3IgKGxldCBpID0gc2h1ZmZsZWQubGVuZ3RoIC0gMTsgaSA+IDA7IGktLSkge1xuICAgIGNvbnN0IGogPSBNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkgKiAoaSArIDEpKTtcbiAgICBbc2h1ZmZsZWRbaV0sIHNodWZmbGVkW2pdXSA9IFtzaHVmZmxlZFtqXSwgc2h1ZmZsZWRbaV1dO1xuICB9XG4gIHJldHVybiBzaHVmZmxlZDtcbn1cblxuLy8gVHJhY2sgbGFzdCBzY2VuZSB0byBhdm9pZCBpbW1lZGlhdGUgcmVwZWF0IGFmdGVyIHJlc2h1ZmZsZVxubGV0IGxhc3RTaG93blNjZW5lSWQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG4vKiogVHJ1ZSBvbmNlIGV2ZXJ5IHNjZW5lIGluIHRoZSBjdXJyZW50IHNodWZmbGUgaGFzIGJlZW4gc2hvd24gKHRpbWUgdG8gcmUtcXVlcnkgdGhlIGZpbHRlcikuICovXG5mdW5jdGlvbiBpc1NodWZmbGVDeWNsZUNvbXBsZXRlKGZpbHRlcktleTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiAoXG4gICAgc3RhdGUuc2h1ZmZsZUZpbHRlcktleSA9PT0gZmlsdGVyS2V5ICYmXG4gICAgc3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lcy5sZW5ndGggPiAwICYmXG4gICAgc3RhdGUuc2h1ZmZsZUluZGV4ID49IHN0YXRlLnNodWZmbGVkRmlsdGVyZWRTY2VuZXMubGVuZ3RoXG4gICk7XG59XG5cbi8qKiBSZXNodWZmbGUgdGhlIGxlZnQgcG9vbCBmb3IgYSBuZXcgcGFzcywgd2l0aG91dCBzaG93aW5nIHRoZSBwcmV2aW91cyBwYXNzJ3MgbGFzdCBzY2VuZSBmaXJzdC4gKi9cbmZ1bmN0aW9uIHN0YXJ0TmV3UGFzcyhsZWZ0UG9vbDogU2NlbmVbXSk6IHZvaWQge1xuICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCflIAgUmVzaHVmZmxpbmcgKGNvbXBsZXRlZCBmdWxsIGN5Y2xlKVwiKTtcbiAgc3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lcyA9IHNodWZmbGVBcnJheShsZWZ0UG9vbCk7XG4gIHN0YXRlLnNodWZmbGVJbmRleCA9IDA7XG5cbiAgaWYgKFxuICAgIGxhc3RTaG93blNjZW5lSWQgJiZcbiAgICBzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzLmxlbmd0aCA+IDEgJiZcbiAgICBzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzWzBdLmlkID09PSBsYXN0U2hvd25TY2VuZUlkXG4gICkge1xuICAgIGNvbnN0IHN3YXBJZHggPSAxICsgTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogKHN0YXRlLnNodWZmbGVkRmlsdGVyZWRTY2VuZXMubGVuZ3RoIC0gMSkpO1xuICAgIFtzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzWzBdLCBzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzW3N3YXBJZHhdXSA9IFtcbiAgICAgIHN0YXRlLnNodWZmbGVkRmlsdGVyZWRTY2VuZXNbc3dhcElkeF0sXG4gICAgICBzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzWzBdLFxuICAgIF07XG4gICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5SEIFN3YXBwZWQgZmlyc3Qgc2NlbmUgdG8gYXZvaWQgcmVwZWF0XCIpO1xuICB9XG59XG5cbi8qKiBOZXh0IGxlZnQtc2lkZSBzY2VuZSBmcm9tIHRoZSBzaHVmZmxlZCBsZWZ0IHBvb2wgKG5vIG5ldHdvcmsgZmV0Y2gpLiBTY2VuZXMgc3RheSBpbiB0aGUgcG9vbC4gKi9cbmZ1bmN0aW9uIGdldE5leHRGaWx0ZXJlZFNjZW5lKGxlZnRQb29sOiBTY2VuZVtdLCBmaWx0ZXJLZXk6IHN0cmluZyk6IFNjZW5lIHwgbnVsbCB7XG4gIGlmIChsZWZ0UG9vbC5sZW5ndGggPT09IDApIHtcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCfj4EgRmlsdGVyZWQgcG9vbCBpcyBlbXB0eVwiKTtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIGlmIChmaWx0ZXJLZXkgIT09IHN0YXRlLnNodWZmbGVGaWx0ZXJLZXkgfHwgc3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lcy5sZW5ndGggPT09IDApIHtcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCflIAgU2h1ZmZsaW5nIGZpbHRlcmVkIHNjZW5lcyAoZmlsdGVyIGNoYW5nZWQgb3IgZmlyc3QgbG9hZClcIik7XG4gICAgc3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lcyA9IHNodWZmbGVBcnJheShsZWZ0UG9vbCk7XG4gICAgc3RhdGUuc2h1ZmZsZUluZGV4ID0gMDtcbiAgICBzdGF0ZS5zaHVmZmxlRmlsdGVyS2V5ID0gZmlsdGVyS2V5O1xuICAgIGxhc3RTaG93blNjZW5lSWQgPSBudWxsO1xuICB9XG5cbiAgaWYgKHN0YXRlLnNodWZmbGVJbmRleCA+PSBzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzLmxlbmd0aCkge1xuICAgIHN0YXJ0TmV3UGFzcyhsZWZ0UG9vbCk7XG4gIH1cblxuICBjb25zdCBzaHVmZmxlZCA9IHN0YXRlLnNodWZmbGVkRmlsdGVyZWRTY2VuZXNbc3RhdGUuc2h1ZmZsZUluZGV4XTtcbiAgLy8gVGhlIHNodWZmbGUga2VlcHMgaXRzIHBhc3MncyBzY2VuZSBvYmplY3RzOyBhIGJhY2tncm91bmQgcmVmcmVzaCBtYXkgaGF2ZSByZXBsYWNlZCB0aGVtIHNpbmNlXG4gIGNvbnN0IHNjZW5lID0gbGVmdFBvb2wuZmluZCgocykgPT4gcy5pZCA9PT0gc2h1ZmZsZWQuaWQpID8/IHNodWZmbGVkO1xuICBzdGF0ZS5zaHVmZmxlSW5kZXgrKztcbiAgbGFzdFNob3duU2NlbmVJZCA9IHNjZW5lLmlkO1xuICBjb25zb2xlLmxvZyhcbiAgICBgW1N0YXNoIEJhdHRsZV0g8J+TjSBQaWNrZWQgc2NlbmUgJHtzY2VuZS5pZH0gKCR7c3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lcy5sZW5ndGggLSBzdGF0ZS5zaHVmZmxlSW5kZXh9IGxlZnQgaW4gdGhpcyBwYXNzKWAsXG4gICk7XG4gIHJldHVybiBzY2VuZTtcbn1cblxuLyoqXG4gKiBPcHBvbmVudHMgKHJpZ2h0IHNpZGUpLCBzb3J0ZWQgYnkgRUxPOiBzY2VuZXMgd2l0aCBhbiBFTE8sIG9yIHRoZSBmaWx0ZXJlZCBzY2VuZXMgd2hlbiBcInVzZVxuICogZmlsdGVyZWQgc2NlbmVzIGZvciBib3RoIHNpZGVzXCIgaXMgb24gKHVucmF0ZWQgb25lcyB0aGVuIHNvcnQgbGFzdCkuXG4gKi9cbmZ1bmN0aW9uIGJ1aWxkT3Bwb25lbnRQb29sKGFsbFNjZW5lczogU2NlbmVbXSwgbGVmdFBvb2w6IFNjZW5lW10sIGZpbHRlcnM6IExpc3RGaWx0ZXJzKTogU2NlbmVbXSB7XG4gIGlmIChzdGF0ZS5zZXR0aW5ncy5maWx0ZXJPcHBvbmVudHMgJiYgZmlsdGVycy5maWx0ZXJBY3RpdmUpIHtcbiAgICByZXR1cm4gbGVmdFBvb2w7XG4gIH1cbiAgY29uc3QgcmF0ZWQgPSBhbGxTY2VuZXMuZmlsdGVyKGlzUmF0ZWQpO1xuICByZXR1cm4gcmF0ZWQubGVuZ3RoID49IDEgPyByYXRlZCA6IGFsbFNjZW5lcztcbn1cblxuLyoqIExvYWQgdGhlIGxlZnQgKFwidG8gcmF0ZVwiKSBhbmQgZnVsbCBwb29scy4gQm90aCBjb21lIGZyb20gdGhlIGNhY2hlLCBzb3J0ZWQgYnkgRUxPLiAqL1xuYXN5bmMgZnVuY3Rpb24gbG9hZFNjZW5lUG9vbHMoXG4gIGZpbHRlcnM6IExpc3RGaWx0ZXJzLFxuKTogUHJvbWlzZTx7IGxlZnRQb29sOiBTY2VuZVtdOyBhbGxTY2VuZXM6IFNjZW5lW10gfT4ge1xuICBsZXQgbGVmdFBvb2w6IFNjZW5lW107XG4gIGxldCBhbGxTY2VuZXM6IFNjZW5lW107XG5cbiAgaWYgKGZpbHRlcnMuZmlsdGVyQWN0aXZlKSB7XG4gICAgLy8gUmUtcXVlcnkgdGhlIGZpbHRlciBhZnRlciBlYWNoIGZ1bGwgcGFzcyBzbyBmaWx0ZXJzIGxpa2UgXCJ1bnJhdGVkXCIgc2hyaW5rIGFzIHNjZW5lcyBnZXQgcmF0ZWRcbiAgICBjb25zdCBwYXNzQ29tcGxldGUgPSBpc1NodWZmbGVDeWNsZUNvbXBsZXRlKGZpbHRlcnMuZmlsdGVyS2V5KTtcbiAgICBpZiAocGFzc0NvbXBsZXRlKSB7XG4gICAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCflIEgUGFzcyBjb21wbGV0ZSwgcmUtZmV0Y2hpbmcgZmlsdGVyZWQgc2NlbmVzXCIpO1xuICAgICAgYXdhaXQgY2xlYXJGaWx0ZXJlZENhY2hlKCk7XG4gICAgfVxuICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+TiyBGaWx0ZXIgYWN0aXZlLCBmZXRjaGluZyBmaWx0ZXJlZCArIGFsbCBzY2VuZXNcIik7XG4gICAgY29uc3QgW2ZpbHRlcmVkUmVzdWx0LCBhbGxSZXN1bHRdID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xuICAgICAgZ2V0RmlsdGVyZWRTY2VuZXNDYWNoZWQoZmlsdGVycyksXG4gICAgICBnZXRBbGxTY2VuZXNDYWNoZWQoKSxcbiAgICBdKTtcbiAgICBsZWZ0UG9vbCA9IGZpbHRlcmVkUmVzdWx0LnNjZW5lcyB8fCBbXTtcbiAgICBhbGxTY2VuZXMgPSBhbGxSZXN1bHQuc2NlbmVzIHx8IFtdO1xuICAgIC8vIFN0YXJ0IHRoZSBuZXh0IHBhc3Mgbm93LCBzbyBsYXRlciBsb2FkcyBpbiBhIHJ1biAod2hpY2ggcGljayBubyBuZXcgbGVmdCBzY2VuZSkgZG9uJ3RcbiAgICAvLyBzZWUgdGhlIHBhc3MgYXMgY29tcGxldGUgYW5kIHJlLWZldGNoIHRoZSBmaWx0ZXIgZXZlcnkgdGltZVxuICAgIGlmIChwYXNzQ29tcGxldGUpIHN0YXJ0TmV3UGFzcyhsZWZ0UG9vbCk7XG4gIH0gZWxzZSB7XG4gICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5OLIE5vIGZpbHRlciBhY3RpdmUsIHVzaW5nIGFsbCBzY2VuZXNcIik7XG4gICAgYWxsU2NlbmVzID0gKGF3YWl0IGdldEFsbFNjZW5lc0NhY2hlZCgpKS5zY2VuZXMgfHwgW107XG4gICAgbGVmdFBvb2wgPSBhbGxTY2VuZXM7XG4gIH1cblxuICBzdGF0ZS5sZWZ0UG9vbFNpemUgPSBsZWZ0UG9vbC5sZW5ndGg7XG4gIHJldHVybiB7IGxlZnRQb29sLCBhbGxTY2VuZXMgfTtcbn1cblxuLyoqXG4gKiBSYW5rcyBmb3IgYSByZXN0b3JlZCBwYWlyIGZyb20gdGhlIGN1cnJlbnQgcG9vbHMgKGFsc28gcmVjb3JkaW5nIHRoZSBsZWZ0IHBvb2wncyBzaXplKSwgdGhlIHdheVxuICogdGhlIHBhaXIgZmV0Y2hlcnMgd29yayB0aGVtIG91dDogdGhlIHBsYWNlIGluIHRoZSBvcHBvbmVudCBwb29sLCBhbmQgaW4gUGxhY2VtZW50LCBub25lIGZvciB0aGVcbiAqIHNjZW5lIGJlaW5nIHBsYWNlZCBhbmQgdGhlIG9wcG9uZW50J3MgcGxhY2UgaW4gdGhlIHBvb2wgd2l0aG91dCBpdC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHBhaXJSYW5rcyhsZWZ0OiBTY2VuZSwgcmlnaHQ6IFNjZW5lKTogUHJvbWlzZTxbUmFuaywgUmFua10+IHtcbiAgY29uc3QgZmlsdGVycyA9IHJlYWRGaWx0ZXJzKCk7XG4gIGNvbnN0IHsgbGVmdFBvb2wsIGFsbFNjZW5lcyB9ID0gYXdhaXQgbG9hZFNjZW5lUG9vbHMoZmlsdGVycyk7XG4gIGxldCBwb29sID0gYnVpbGRPcHBvbmVudFBvb2woYWxsU2NlbmVzLCBsZWZ0UG9vbCwgZmlsdGVycyk7XG4gIGNvbnN0IHJhbmsgPSAoc2NlbmU6IFNjZW5lKTogUmFuayA9PiB7XG4gICAgY29uc3QgaWR4ID0gcG9vbC5maW5kSW5kZXgoKHMpID0+IHMuaWQgPT09IHNjZW5lLmlkKTtcbiAgICByZXR1cm4gaWR4ID49IDAgPyBpZHggKyAxIDogbnVsbDtcbiAgfTtcbiAgaWYgKHN0YXRlLmN1cnJlbnRNb2RlID09PSBcInBsYWNlbWVudFwiKSB7XG4gICAgcG9vbCA9IHBvb2wuZmlsdGVyKChzKSA9PiBzLmlkICE9PSBsZWZ0LmlkKTtcbiAgICByZXR1cm4gW251bGwsIHJhbmsocmlnaHQpXTtcbiAgfVxuICByZXR1cm4gW3JhbmsobGVmdCksIHJhbmsocmlnaHQpXTtcbn1cblxuLyoqIExvYWQgbGVmdCAoc2NlbmUgdG8gcmF0ZSkgYW5kIHJpZ2h0IChvcHBvbmVudCkgcG9vbHMgZm9yIFN3aXNzLiAqL1xuYXN5bmMgZnVuY3Rpb24gYnVpbGRTd2lzc1Bvb2xzKCk6IFByb21pc2U8e1xuICBsZWZ0UG9vbDogU2NlbmVbXTtcbiAgcmlnaHRQb29sOiBTY2VuZVtdO1xuICBmaWx0ZXJLZXk6IHN0cmluZztcbn0+IHtcbiAgY29uc3QgZmlsdGVycyA9IHJlYWRGaWx0ZXJzKCk7XG4gIGNvbnN0IHsgbGVmdFBvb2wsIGFsbFNjZW5lcyB9ID0gYXdhaXQgbG9hZFNjZW5lUG9vbHMoZmlsdGVycyk7XG5cbiAgaWYgKGFsbFNjZW5lcy5sZW5ndGggPCAyKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiTm90IGVub3VnaCBzY2VuZXMgZm9yIGNvbXBhcmlzb24uXCIpO1xuICB9XG5cbiAgY29uc3QgcmlnaHRQb29sID0gYnVpbGRPcHBvbmVudFBvb2woYWxsU2NlbmVzLCBsZWZ0UG9vbCwgZmlsdGVycyk7XG4gIGlmIChzdGF0ZS5zZXR0aW5ncy5maWx0ZXJPcHBvbmVudHMgJiYgZmlsdGVycy5maWx0ZXJBY3RpdmUgJiYgcmlnaHRQb29sLmxlbmd0aCA8IDIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJOb3QgZW5vdWdoIHNjZW5lcyBpbiB5b3VyIGZpbHRlciBmb3IgYSBtYXRjaC4gWW91IG5lZWQgYXQgbGVhc3QgMiBzY2VuZXMuXCIpO1xuICB9XG5cbiAgcmV0dXJuIHsgbGVmdFBvb2wsIHJpZ2h0UG9vbCwgZmlsdGVyS2V5OiBmaWx0ZXJzLmZpbHRlcktleSB9O1xufVxuXG4vLyBTd2lzcyBtb2RlOiBsZWZ0ID0gc2NlbmUgdG8gcmF0ZSAoZmlsdGVyZWQgcG9vbCksIHJpZ2h0ID0gc2ltaWxhci1zdHJlbmd0aCBvcHBvbmVudFxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGZldGNoU3dpc3NQYWlyKGZvcmNlZExlZnRTY2VuZTogU2NlbmUgfCBudWxsID0gbnVsbCk6IFByb21pc2U8U3dpc3NQYWlyUmVzdWx0PiB7XG4gIGNvbnN0IHsgbGVmdFBvb2wsIHJpZ2h0UG9vbCwgZmlsdGVyS2V5IH0gPSBhd2FpdCBidWlsZFN3aXNzUG9vbHMoKTtcblxuICBjb25zdCBzY2VuZTEgPSBmb3JjZWRMZWZ0U2NlbmUgfHwgZ2V0TmV4dEZpbHRlcmVkU2NlbmUobGVmdFBvb2wsIGZpbHRlcktleSk7XG4gIGlmICghc2NlbmUxKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiTm8gc2NlbmVzIG1hdGNoIHlvdXIgZmlsdGVyIGNyaXRlcmlhLlwiKTtcbiAgfVxuXG4gIGNvbnN0IHsgc2NlbmUyLCByYW5rcyB9ID0gcGlja1N3aXNzT3Bwb25lbnQoc2NlbmUxLCByaWdodFBvb2wpO1xuICByZXR1cm4geyBzY2VuZXM6IFtzY2VuZTEsIHNjZW5lMl0sIHJhbmtzIH07XG59XG5cbi8qKlxuICogUGljayBhIHJhbmRvbSBvcHBvbmVudCB3aXRoaW4gwrFTV0lTU19PUFBPTkVOVF9FTE9fV0lORE9XIG9mIHNjZW5lMSdzIEVMTyBpbiB0aGUgRUxPLXNvcnRlZCByaWdodFxuICogcG9vbCAodW5yYXRlZCBzY2VuZXMgY291bnQgYXMgMTUwMCksIG9yIGFtb25nIHRoZSBuZWFyZXN0IGZldyB3aGVuIHRoZSB3aW5kb3cgaGFzIHRvbyBmZXcuXG4gKi9cbmZ1bmN0aW9uIHBpY2tTd2lzc09wcG9uZW50KFxuICBzY2VuZTE6IFNjZW5lLFxuICByaWdodFBvb2w6IFNjZW5lW10sXG4pOiB7IHNjZW5lMjogU2NlbmU7IHJhbmtzOiBbUmFuaywgUmFua10gfSB7XG4gIGNvbnN0IHNjZW5lMUlkeEluUG9vbCA9IHJpZ2h0UG9vbC5maW5kSW5kZXgoKHMpID0+IHMuaWQgPT09IHNjZW5lMS5pZCk7XG4gIGNvbnN0IHNjZW5lMVJhbmtJblBvb2wgPSBzY2VuZTFJZHhJblBvb2wgPj0gMCA/IHNjZW5lMUlkeEluUG9vbCArIDEgOiBudWxsO1xuXG4gIGNvbnN0IGNhbmRpZGF0ZXMgPSBzd2lzc09wcG9uZW50SW5kZXhlcyhcbiAgICByaWdodFBvb2wsXG4gICAgZWZmZWN0aXZlRWxvKGxhdGVzdFNjZW5lKHNjZW5lMSkpLFxuICAgIHNjZW5lMS5pZCxcbiAgICBTV0lTU19PUFBPTkVOVF9FTE9fV0lORE9XLFxuICAgIFNXSVNTX09QUE9ORU5UX01JTl9DQU5ESURBVEVTLFxuICApO1xuICBpZiAoY2FuZGlkYXRlcy5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJOb3QgZW5vdWdoIHNjZW5lcyBmb3IgY29tcGFyaXNvbi4gWW91IG5lZWQgYXQgbGVhc3QgMiBzY2VuZXMuXCIpO1xuICB9XG5cbiAgY29uc3QgaWR4ID0gY2FuZGlkYXRlc1tNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkgKiBjYW5kaWRhdGVzLmxlbmd0aCldO1xuICByZXR1cm4ge1xuICAgIHNjZW5lMjogcmlnaHRQb29sW2lkeF0sXG4gICAgcmFua3M6IFtzY2VuZTFSYW5rSW5Qb29sLCBpZHggKyAxXSxcbiAgfTtcbn1cblxuLyoqIFJhbmRvbSBwaWNrIGZyb20gdGhlIE4gdW5iZWF0ZW4gb3Bwb25lbnRzIGNsb3Nlc3QgYWJvdmUgdGhlIGNoYW1waW9uIChsaXN0IGlzIEVMTy1zb3J0ZWQpLiAqL1xuZnVuY3Rpb24gcGlja0Nsb3Nlc3RDaGFtcGlvbk9wcG9uZW50KHJlbWFpbmluZ09wcG9uZW50czogU2NlbmVbXSk6IFNjZW5lIHtcbiAgY29uc3QgY2xvc2VzdCA9IHJlbWFpbmluZ09wcG9uZW50cy5zbGljZSgtQ0xJTUJfT1BQT05FTlRfUElDS19XSU5ET1cpO1xuICByZXR1cm4gY2xvc2VzdFtNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkgKiBjbG9zZXN0Lmxlbmd0aCldO1xufVxuXG4vKiogT3Bwb25lbnRzIGFib3ZlIHRoZSBjaGFtcGlvbiBpbiB0aGUgRUxPLXNvcnRlZCBwb29sIHRoYXQgaXQgaGFzbid0IGJlYXRlbiBpbiB0aGlzIHJ1bi4gKi9cbmZ1bmN0aW9uIGdldFJlbWFpbmluZ0NoYW1waW9uT3Bwb25lbnRzKGNoYW1waW9uOiBTY2VuZSwgcmlnaHRQb29sOiBTY2VuZVtdLCBjaGFtcGlvbkluZGV4OiBudW1iZXIpOiBTY2VuZVtdIHtcbiAgY29uc3QgY2hhbXBpb25FbG8gPSBlZmZlY3RpdmVFbG8oY2hhbXBpb24sIENIQU1QSU9OX1VOUkFURURfRUxPKTtcbiAgcmV0dXJuIHJpZ2h0UG9vbC5maWx0ZXIoKHMsIGlkeCkgPT4ge1xuICAgIGlmIChzLmlkID09PSBjaGFtcGlvbi5pZCB8fCBzdGF0ZS5jaGFtcGlvbkRlZmVhdGVkLmluY2x1ZGVzKHMuaWQpKSByZXR1cm4gZmFsc2U7XG4gICAgcmV0dXJuIGlkeCA8IGNoYW1waW9uSW5kZXggfHwgKGVsbyhzKSA/PyAtSW5maW5pdHkpID49IGNoYW1waW9uRWxvO1xuICB9KTtcbn1cblxuLyoqIExvd2VzdCBzY2VuZSB3aXRoIGFuIEVMTyBpbiB0aGUgcG9vbCAoZXhjbHVkaW5nIG9uZSBzY2VuZSksIG9yIGFueSBvdGhlciBzY2VuZSBpZiBub25lIGhhcyBvbmUuICovXG5mdW5jdGlvbiBmaW5kTG93ZXN0UmF0ZWQoc2NlbmVzOiBTY2VuZVtdLCBleGNsdWRlSWQ6IHN0cmluZyk6IHsgc2NlbmU6IFNjZW5lIHwgdW5kZWZpbmVkOyBpbmRleDogbnVtYmVyIH0ge1xuICBmb3IgKGxldCBpID0gc2NlbmVzLmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7XG4gICAgY29uc3QgcyA9IHNjZW5lc1tpXTtcbiAgICBpZiAocy5pZCAhPT0gZXhjbHVkZUlkICYmIGlzUmF0ZWQocykpIHtcbiAgICAgIHJldHVybiB7IHNjZW5lOiBzLCBpbmRleDogaSB9O1xuICAgIH1cbiAgfVxuICBjb25zdCBmYWxsYmFja0luZGV4ID0gc2NlbmVzLmZpbmRJbmRleCgocykgPT4gcy5pZCAhPT0gZXhjbHVkZUlkKTtcbiAgcmV0dXJuIHsgc2NlbmU6IHNjZW5lc1tmYWxsYmFja0luZGV4XSwgaW5kZXg6IGZhbGxiYWNrSW5kZXggfTtcbn1cblxuLy8gQ2hhbXBpb24gbW9kZTogd2lubmVyIHN0YXlzIG9uLCBzdGFydGluZyBhZ2FpbnN0IHRoZSBsb3dlc3QtcmF0ZWQgc2NlbmVcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBmZXRjaENoYW1waW9uUGFpcihcbiAgZm9yY2VkTGVmdFNjZW5lOiBTY2VuZSB8IG51bGwgPSBudWxsLFxuKTogUHJvbWlzZTxDaGFtcGlvblBhaXJSZXN1bHQ+IHtcbiAgY29uc3QgZmlsdGVycyA9IHJlYWRGaWx0ZXJzKCk7XG5cbiAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5OLIEZldGNoaW5nIHNjZW5lcyBmb3IgY2hhbXBpb24uLi5cIik7XG4gIGNvbnN0IHsgbGVmdFBvb2wsIGFsbFNjZW5lcyB9ID0gYXdhaXQgbG9hZFNjZW5lUG9vbHMoZmlsdGVycyk7XG5cbiAgY29uc3QgcmlnaHRQb29sID0gYnVpbGRPcHBvbmVudFBvb2woYWxsU2NlbmVzLCBsZWZ0UG9vbCwgZmlsdGVycyk7XG4gIHN0YXRlLnRvdGFsU2NlbmVzQ291bnQgPSByaWdodFBvb2wubGVuZ3RoO1xuXG4gIGlmIChhbGxTY2VuZXMubGVuZ3RoIDwgMikge1xuICAgIHRocm93IG5ldyBFcnJvcihcIk5vdCBlbm91Z2ggc2NlbmVzIGZvciBjb21wYXJpc29uLlwiKTtcbiAgfVxuXG4gIC8vIE5vIGNoYW1waW9uIHlldDogdGhlIGNoYWxsZW5nZXIgZnJvbSB0aGUgbGVmdCBwb29sIHN0YXJ0cyBhZ2FpbnN0IHRoZSBsb3dlc3QtcmF0ZWQgc2NlbmVcbiAgaWYgKCFzdGF0ZS5jaGFtcGlvblNjZW5lKSB7XG4gICAgc3RhdGUuY2hhbXBpb25EZWZlYXRlZCA9IFtdO1xuXG4gICAgY29uc3QgY2hhbGxlbmdlciA9IGZvcmNlZExlZnRTY2VuZSB8fCBnZXROZXh0RmlsdGVyZWRTY2VuZShsZWZ0UG9vbCwgZmlsdGVycy5maWx0ZXJLZXkpO1xuICAgIGlmICghY2hhbGxlbmdlcikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiTm8gc2NlbmVzIG1hdGNoIHlvdXIgZmlsdGVyIGNyaXRlcmlhLlwiKTtcbiAgICB9XG5cbiAgICBjb25zdCBjaGFsbGVuZ2VySW5kZXggPSByaWdodFBvb2wuZmluZEluZGV4KChzKSA9PiBzLmlkID09PSBjaGFsbGVuZ2VyLmlkKTtcbiAgICBjb25zdCB7IHNjZW5lOiBsb3dlc3RSYXRlZCwgaW5kZXg6IGxvd2VzdEluZGV4IH0gPSBmaW5kTG93ZXN0UmF0ZWQocmlnaHRQb29sLCBjaGFsbGVuZ2VyLmlkKTtcbiAgICBpZiAoIWxvd2VzdFJhdGVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJOb3QgZW5vdWdoIHNjZW5lcyBmb3IgY29tcGFyaXNvbi4gWW91IG5lZWQgYXQgbGVhc3QgMiBzY2VuZXMuXCIpO1xuICAgIH1cblxuICAgIHJldHVybiB7XG4gICAgICBzY2VuZXM6IFtjaGFsbGVuZ2VyLCBsb3dlc3RSYXRlZF0sXG4gICAgICByYW5rczogW2NoYWxsZW5nZXJJbmRleCA+PSAwID8gY2hhbGxlbmdlckluZGV4ICsgMSA6IG51bGwsIGxvd2VzdEluZGV4ICsgMV0sXG4gICAgICBpc1ZpY3Rvcnk6IGZhbHNlLFxuICAgIH07XG4gIH1cblxuICBjb25zdCBjaGFtcGlvbiA9IHN0YXRlLmNoYW1waW9uU2NlbmU7XG4gIGNvbnN0IGNoYW1waW9uSW5kZXggPSByaWdodFBvb2wuZmluZEluZGV4KChzKSA9PiBzLmlkID09PSBjaGFtcGlvbi5pZCk7XG4gIGNvbnN0IHJlbWFpbmluZ09wcG9uZW50cyA9IGdldFJlbWFpbmluZ0NoYW1waW9uT3Bwb25lbnRzKGNoYW1waW9uLCByaWdodFBvb2wsIGNoYW1waW9uSW5kZXgpO1xuXG4gIC8vIE5vIG9wcG9uZW50cyBsZWZ0OiB0aGUgY2hhbXBpb24gaGFzIGJlYXRlbiBldmVyeW9uZSBhYm92ZSBpdFxuICBpZiAocmVtYWluaW5nT3Bwb25lbnRzLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiB7IHNjZW5lczogW2NoYW1waW9uXSwgcmFua3M6IFsxXSwgaXNWaWN0b3J5OiB0cnVlIH07XG4gIH1cblxuICBjb25zdCBuZXh0T3Bwb25lbnQgPSBwaWNrQ2xvc2VzdENoYW1waW9uT3Bwb25lbnQocmVtYWluaW5nT3Bwb25lbnRzKTtcbiAgY29uc3QgbmV4dE9wcG9uZW50SW5kZXggPSByaWdodFBvb2wuZmluZEluZGV4KChzKSA9PiBzLmlkID09PSBuZXh0T3Bwb25lbnQuaWQpO1xuXG4gIHJldHVybiB7XG4gICAgc2NlbmVzOiBbY2hhbXBpb24sIG5leHRPcHBvbmVudF0sXG4gICAgcmFua3M6IFtjaGFtcGlvbkluZGV4ID49IDAgPyBjaGFtcGlvbkluZGV4ICsgMSA6IG51bGwsIG5leHRPcHBvbmVudEluZGV4ICsgMV0sXG4gICAgaXNWaWN0b3J5OiBmYWxzZSxcbiAgfTtcbn1cblxuLy8gLS0tIFBsYWNlbWVudCBtb2RlICh0aGUgc2VhcmNoIGl0c2VsZiBpcyBpbiBwbGFjZW1lbnQudHMpIC0tLVxuXG4vKiogUmFuZG9tIHBpY2sgYW1vbmcgc2NlbmVzIGluIFtsbywgaGkpIHRoYXQgc2hhcmUgcG9vbFtpZHhdJ3MgRUxPICh0aGVpciBvcmRlciBpcyBhcmJpdHJhcnkpLiAqL1xuZnVuY3Rpb24gcGlja0Ftb25nVGllcyhwb29sOiBTY2VuZVtdLCBpZHg6IG51bWJlciwgbG86IG51bWJlciwgaGk6IG51bWJlcik6IG51bWJlciB7XG4gIGNvbnN0IHRhcmdldCA9IGVsbyhwb29sW2lkeF0pO1xuICBjb25zdCB0aWVzOiBudW1iZXJbXSA9IFtdO1xuICBmb3IgKGxldCBpID0gbG87IGkgPCBoaTsgaSsrKSB7XG4gICAgaWYgKGVsbyhwb29sW2ldKSA9PT0gdGFyZ2V0KSB0aWVzLnB1c2goaSk7XG4gIH1cbiAgcmV0dXJuIHRpZXNbTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogdGllcy5sZW5ndGgpXTtcbn1cblxuLy8gUGxhY2VtZW50IG1vZGU6IGxlZnQgPSBzY2VuZSBiZWluZyBwbGFjZWQsIHJpZ2h0ID0gdGhlIG5leHQgb3Bwb25lbnQgaW4gaXRzIHNlYXJjaCByYW5nZVxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGZldGNoUGxhY2VtZW50UGFpcihcbiAgZm9yY2VkTGVmdFNjZW5lOiBTY2VuZSB8IG51bGwgPSBudWxsLFxuKTogUHJvbWlzZTxQbGFjZW1lbnRQYWlyUmVzdWx0PiB7XG4gIGNvbnN0IGZpbHRlcnMgPSByZWFkRmlsdGVycygpO1xuICBjb25zdCB7IGxlZnRQb29sLCBhbGxTY2VuZXMgfSA9IGF3YWl0IGxvYWRTY2VuZVBvb2xzKGZpbHRlcnMpO1xuXG4gIGlmIChhbGxTY2VuZXMubGVuZ3RoIDwgMikge1xuICAgIHRocm93IG5ldyBFcnJvcihcIk5vdCBlbm91Z2ggc2NlbmVzIGZvciBjb21wYXJpc29uLlwiKTtcbiAgfVxuXG4gIGlmICghc3RhdGUucGxhY2VtZW50KSB7XG4gICAgY29uc3Qgc2NlbmUgPSBmb3JjZWRMZWZ0U2NlbmUgfHwgZ2V0TmV4dEZpbHRlcmVkU2NlbmUobGVmdFBvb2wsIGZpbHRlcnMuZmlsdGVyS2V5KTtcbiAgICBpZiAoIXNjZW5lKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJObyBzY2VuZXMgbWF0Y2ggeW91ciBmaWx0ZXIgY3JpdGVyaWEuXCIpO1xuICAgIH1cbiAgICBzdGF0ZS5wbGFjZW1lbnQgPSBuZXdQbGFjZW1lbnRSdW4oc2NlbmUsIHN0YXRlLnNldHRpbmdzLnBsYWNlbWVudEZyb21Cb3R0b20pO1xuICB9XG4gIGNvbnN0IHJ1biA9IHN0YXRlLnBsYWNlbWVudDtcblxuICBjb25zdCBwb29sID0gYnVpbGRPcHBvbmVudFBvb2woYWxsU2NlbmVzLCBsZWZ0UG9vbCwgZmlsdGVycykuZmlsdGVyKChzKSA9PiBzLmlkICE9PSBydW4uc2NlbmUuaWQpO1xuICBpZiAocG9vbC5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJOb3QgZW5vdWdoIHNjZW5lcyBmb3IgY29tcGFyaXNvbi4gWW91IG5lZWQgYXQgbGVhc3QgMiBzY2VuZXMuXCIpO1xuICB9XG4gIHN0YXRlLnRvdGFsU2NlbmVzQ291bnQgPSBwb29sLmxlbmd0aCArIDE7XG5cbiAgY29uc3Qgc3RlcCA9IHBsYWNlbWVudFN0ZXAocnVuLCBwb29sKTtcbiAgcnVuLnJhbmdlTG8gPSBNYXRoLm1pbihzdGVwLmxvLCBzdGVwLmhpKTtcbiAgcnVuLnJhbmdlSGkgPSBzdGVwLmhpO1xuXG4gIGlmIChzdGVwLmRvbmUpIHtcbiAgICAvLyBPbmx5IHRoZSBwbGFjZWQgc2NlbmUncyBFTE8gY2hhbmdlczsgaXQncyBjcmVkaXRlZCB3aXRoIHRoZSBiYXR0bGVzIHRoaXMgcnVuIHRvb2tcbiAgICBjb25zdCBuZXdFbG8gPSBsYW5kaW5nRWxvKHBvb2wsIHN0ZXAuc2xvdCk7XG4gICAgY29uc3QgbmV3QmF0dGxlcyA9IGJhdHRsZXMobGF0ZXN0U2NlbmUocnVuLnNjZW5lKSkgKyBydW4uYmF0dGxlcztcbiAgICBjb25zb2xlLmxvZyhcbiAgICAgIGBbU3Rhc2ggQmF0dGxlXSDwn5ONIFBsYWNlbWVudDogc2NlbmUgJHtydW4uc2NlbmUuaWR9IHBsYWNlZCBhdCAjJHtzdGVwLnNsb3QgKyAxfSBhZnRlciAke3J1bi5iYXR0bGVzfSBiYXR0bGVzLCBFTE8gJHtuZXdFbG99YCxcbiAgICApO1xuICAgIGF3YWl0IHdyaXRlRWxvKHJ1bi5zY2VuZSwgbmV3RWxvLCBuZXdCYXR0bGVzKTtcbiAgICByZXR1cm4ge1xuICAgICAgZG9uZTogdHJ1ZSxcbiAgICAgIHNjZW5lOiBydW4uc2NlbmUsXG4gICAgICByYW5rOiBzdGVwLnNsb3QgKyAxLFxuICAgICAgZWxvOiBuZXdFbG8sXG4gICAgICBiYXR0bGVzOiBydW4uYmF0dGxlcyxcbiAgICAgIHN0cmVhazogcnVuLnN0cmVhayxcbiAgICAgIGZyb21Cb3R0b206IHJ1bi5mcm9tQm90dG9tLFxuICAgIH07XG4gIH1cblxuICBjb25zdCBpZHggPSBwaWNrQW1vbmdUaWVzKHBvb2wsIHN0ZXAuaW5kZXgsIHN0ZXAubG8sIHN0ZXAuaGkpO1xuICByZXR1cm4geyBkb25lOiBmYWxzZSwgc2NlbmVzOiBbcnVuLnNjZW5lLCBwb29sW2lkeF1dLCByYW5rczogW251bGwsIGlkeCArIDFdIH07XG59XG4iLCAiLy8gTGlicmFyeS13aWRlIG51bWJlcnMgd29ya2VkIG91dCBmcm9tIHRoZSBzY2VuZXM6IHRpZXJzLCBhbmQgdGhlIFN0YXRzIHRhYidzIG92ZXJ2aWV3LCBFTE9cbi8vIGRpc3RyaWJ1dGlvbiwgaGlkZGVuIGdlbXMgYW5kIGhvdyBzZXR0bGVkIHRoZSByYW5raW5ncyBhcmUuIFB1cmUgZnVuY3Rpb25zOiBubyBzdGF0ZSwgbm8gSS9PLlxuXG5pbXBvcnQgeyBFTE9fS19USUVSUywgVElFUlMgfSBmcm9tIFwiLi9jb25zdGFudHNcIjtcbmltcG9ydCB7IGJhdHRsZXMsIGVsbywgaXNQcm92aXNpb25hbCwgcGVyY2VudGlsZVJhdGluZ3MsIHNlZWQgfSBmcm9tIFwiLi9zY29yZVwiO1xuaW1wb3J0IHR5cGUgeyBTY2VuZSwgU3Rhc2hSYXRpbmdzTW9kZSwgVGllciB9IGZyb20gXCIuL3R5cGVzXCI7XG5cbi8qKiBSYXRlZCBzY2VuZXMgd2l0aCB0aGVpciBFTE8gKHVucmF0ZWQgb25lcyBkcm9wcGVkKS4gKi9cbmZ1bmN0aW9uIHJhdGVkRWxvcyhzY2VuZXM6IFNjZW5lW10pOiB7IHNjZW5lOiBTY2VuZTsgZWxvOiBudW1iZXIgfVtdIHtcbiAgcmV0dXJuIHNjZW5lc1xuICAgIC5tYXAoKHNjZW5lKSA9PiAoeyBzY2VuZSwgZWxvOiBlbG8oc2NlbmUpIH0pKVxuICAgIC5maWx0ZXIoKHMpOiBzIGlzIHsgc2NlbmU6IFNjZW5lOyBlbG86IG51bWJlciB9ID0+IHMuZWxvICE9PSBudWxsKTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBPdmVydmlldyB7XG4gIHJhdGVkOiBudW1iZXI7XG4gIHVucmF0ZWQ6IG51bWJlcjtcbiAgcHJvdmlzaW9uYWw6IG51bWJlcjtcbiAgLyoqIFN1bSBvZiBldmVyeSBzY2VuZSdzIGJhdHRsZXM6IGEgYmF0dGxlIGNvdW50cyBvbmNlIGZvciBlYWNoIHNjZW5lIGluIGl0LiAqL1xuICBiYXR0bGVzOiBudW1iZXI7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBvdmVydmlldyhzY2VuZXM6IFNjZW5lW10pOiBPdmVydmlldyB7XG4gIGNvbnN0IHJhdGVkID0gcmF0ZWRFbG9zKHNjZW5lcyk7XG4gIHJldHVybiB7XG4gICAgcmF0ZWQ6IHJhdGVkLmxlbmd0aCxcbiAgICB1bnJhdGVkOiBzY2VuZXMubGVuZ3RoIC0gcmF0ZWQubGVuZ3RoLFxuICAgIHByb3Zpc2lvbmFsOiBzY2VuZXMuZmlsdGVyKGlzUHJvdmlzaW9uYWwpLmxlbmd0aCxcbiAgICBiYXR0bGVzOiByYXRlZC5yZWR1Y2UoKHN1bSwgcykgPT4gc3VtICsgYmF0dGxlcyhzLnNjZW5lKSwgMCksXG4gIH07XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgSGlzdG9ncmFtQnVja2V0IHtcbiAgLyoqIFRoZSBidWNrZXQgY292ZXJzIGZyb20uLmZyb20gKyBzaXplIChleGNsdXNpdmUpLiAqL1xuICBmcm9tOiBudW1iZXI7XG4gIGNvdW50OiBudW1iZXI7XG59XG5cbi8qKiBSYXRlZCBzY2VuZXMgY291bnRlZCBpbiBgc2l6ZWAtRUxPIGJ1Y2tldHMsIGxvd2VzdCB0byBoaWdoZXN0LCBlbXB0eSBidWNrZXRzIGluIGJldHdlZW4gaW5jbHVkZWQuICovXG5leHBvcnQgZnVuY3Rpb24gZWxvSGlzdG9ncmFtKHNjZW5lczogU2NlbmVbXSwgc2l6ZSA9IDI1KTogSGlzdG9ncmFtQnVja2V0W10ge1xuICBjb25zdCByYXRlZCA9IHJhdGVkRWxvcyhzY2VuZXMpO1xuICBpZiAocmF0ZWQubGVuZ3RoID09PSAwKSByZXR1cm4gW107XG4gIGNvbnN0IGJ1Y2tldE9mID0gKHZhbHVlOiBudW1iZXIpOiBudW1iZXIgPT4gTWF0aC5mbG9vcih2YWx1ZSAvIHNpemUpICogc2l6ZTtcbiAgY29uc3QgY291bnRzID0gbmV3IE1hcDxudW1iZXIsIG51bWJlcj4oKTtcbiAgZm9yIChjb25zdCB7IGVsbzogdmFsdWUgfSBvZiByYXRlZCkgY291bnRzLnNldChidWNrZXRPZih2YWx1ZSksIChjb3VudHMuZ2V0KGJ1Y2tldE9mKHZhbHVlKSkgPz8gMCkgKyAxKTtcbiAgY29uc3QgbG93ZXN0ID0gTWF0aC5taW4oLi4uY291bnRzLmtleXMoKSk7XG4gIGNvbnN0IGhpZ2hlc3QgPSBNYXRoLm1heCguLi5jb3VudHMua2V5cygpKTtcbiAgY29uc3QgYnVja2V0czogSGlzdG9ncmFtQnVja2V0W10gPSBbXTtcbiAgZm9yIChsZXQgZnJvbSA9IGxvd2VzdDsgZnJvbSA8PSBoaWdoZXN0OyBmcm9tICs9IHNpemUpIGJ1Y2tldHMucHVzaCh7IGZyb20sIGNvdW50OiBjb3VudHMuZ2V0KGZyb20pID8/IDAgfSk7XG4gIHJldHVybiBidWNrZXRzO1xufVxuXG4vKiogVGhlIGJpZ2dlc3QgZ3JvdXAgb2Ygc2NlbmVzIHNoYXJpbmcgb25lIEVMTyAobnVsbCB3aGVuIG5vIHR3byBzY2VuZXMgc2hhcmUgb25lKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBsYXJnZXN0VGllKHNjZW5lczogU2NlbmVbXSk6IHsgZWxvOiBudW1iZXI7IGNvdW50OiBudW1iZXIgfSB8IG51bGwge1xuICBjb25zdCBjb3VudHMgPSBuZXcgTWFwPG51bWJlciwgbnVtYmVyPigpO1xuICBmb3IgKGNvbnN0IHsgZWxvOiB2YWx1ZSB9IG9mIHJhdGVkRWxvcyhzY2VuZXMpKSBjb3VudHMuc2V0KHZhbHVlLCAoY291bnRzLmdldCh2YWx1ZSkgPz8gMCkgKyAxKTtcbiAgbGV0IGJlc3Q6IHsgZWxvOiBudW1iZXI7IGNvdW50OiBudW1iZXIgfSB8IG51bGwgPSBudWxsO1xuICBmb3IgKGNvbnN0IFt2YWx1ZSwgY291bnRdIG9mIGNvdW50cykge1xuICAgIGlmIChjb3VudCA+PSAyICYmICghYmVzdCB8fCBjb3VudCA+IGJlc3QuY291bnQgfHwgKGNvdW50ID09PSBiZXN0LmNvdW50ICYmIHZhbHVlID4gYmVzdC5lbG8pKSkge1xuICAgICAgYmVzdCA9IHsgZWxvOiB2YWx1ZSwgY291bnQgfTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGJlc3Q7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2NhbGVUaWNrIHtcbiAgZWxvOiBudW1iZXI7XG4gIHJhdGluZzogbnVtYmVyO1xufVxuXG4vKiogU3Rhc2ggcmF0aW5ncyBtYXJrZWQgb24gdGhlIEVMTyBheGlzLiAqL1xuY29uc3QgU0NBTEVfUkFUSU5HUyA9IFsxLCAyNSwgNTAsIDc1LCAxMDBdO1xuXG4vKipcbiAqIFdoZXJlIFN0YXNoIHJhdGluZ3Mgc2l0IG9uIHRoZSBFTE8gYXhpcyB1bmRlciB0aGUgdXBkYXRlIG1vZGU6IFN0cmFpZ2h0LWxpbmUgaXMgZml4ZWQgKDEgYXRcbiAqIDEwMTAsIDUwIGF0IDE1MDAsIDEwMCBhdCAyMDAwKTsgUGVyY2VudGlsZSBkZXBlbmRzIG9uIHRoZSBsaWJyYXJ5IChlYWNoIG1hcmsgYXQgdGhlIEVMTyBvZiB0aGVcbiAqIHNjZW5lIHdob3NlIHJhdGluZyBpcyBjbG9zZXN0IHRvIGl0KS4gTm9uZSBmb3IgXCJvZmZcIi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJhdGluZ1NjYWxlVGlja3Moc2NlbmVzOiBTY2VuZVtdLCBtb2RlOiBTdGFzaFJhdGluZ3NNb2RlKTogU2NhbGVUaWNrW10ge1xuICBpZiAobW9kZSA9PT0gXCJsaW5lYXJcIikgcmV0dXJuIFNDQUxFX1JBVElOR1MubWFwKChyYXRpbmcpID0+ICh7IGVsbzogc2VlZChyYXRpbmcpLCByYXRpbmcgfSkpO1xuICBpZiAobW9kZSAhPT0gXCJwZXJjZW50aWxlXCIpIHJldHVybiBbXTtcbiAgY29uc3QgcmF0aW5ncyA9IHBlcmNlbnRpbGVSYXRpbmdzKHNjZW5lcyk7XG4gIGNvbnN0IHJhdGVkID0gcmF0ZWRFbG9zKHNjZW5lcykuZmlsdGVyKChzKSA9PiByYXRpbmdzLmhhcyhzLnNjZW5lLmlkKSk7XG4gIGlmIChyYXRlZC5sZW5ndGggPT09IDApIHJldHVybiBbXTtcbiAgY29uc3QgdGlja3M6IFNjYWxlVGlja1tdID0gW107XG4gIGZvciAoY29uc3QgcmF0aW5nIG9mIFNDQUxFX1JBVElOR1MpIHtcbiAgICBsZXQgbmVhcmVzdCA9IHJhdGVkWzBdO1xuICAgIGZvciAoY29uc3QgcyBvZiByYXRlZCkge1xuICAgICAgY29uc3QgZ2FwID0gTWF0aC5hYnMoKHJhdGluZ3MuZ2V0KHMuc2NlbmUuaWQpIGFzIG51bWJlcikgLSByYXRpbmcpO1xuICAgICAgY29uc3QgbmVhcmVzdEdhcCA9IE1hdGguYWJzKChyYXRpbmdzLmdldChuZWFyZXN0LnNjZW5lLmlkKSBhcyBudW1iZXIpIC0gcmF0aW5nKTtcbiAgICAgIGlmIChnYXAgPCBuZWFyZXN0R2FwKSBuZWFyZXN0ID0gcztcbiAgICB9XG4gICAgaWYgKCF0aWNrcy5zb21lKCh0KSA9PiB0LmVsbyA9PT0gbmVhcmVzdC5lbG8pKSB0aWNrcy5wdXNoKHsgZWxvOiBuZWFyZXN0LmVsbywgcmF0aW5nIH0pO1xuICB9XG4gIHJldHVybiB0aWNrcztcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1lZGlhbih2YWx1ZXM6IG51bWJlcltdKTogbnVtYmVyIHtcbiAgaWYgKHZhbHVlcy5sZW5ndGggPT09IDApIHJldHVybiAwO1xuICBjb25zdCBzb3J0ZWQgPSBbLi4udmFsdWVzXS5zb3J0KChhLCBiKSA9PiBhIC0gYik7XG4gIGNvbnN0IG1pZCA9IE1hdGguZmxvb3Ioc29ydGVkLmxlbmd0aCAvIDIpO1xuICByZXR1cm4gc29ydGVkLmxlbmd0aCAlIDIgPyBzb3J0ZWRbbWlkXSA6IChzb3J0ZWRbbWlkIC0gMV0gKyBzb3J0ZWRbbWlkXSkgLyAyO1xufVxuXG4vKiogVGhlIGhpZGRlbiBnZW1zIGNoYXJ0J3MgcXVhZHJhbnQgbGluZXM6IHRoZSBtZWRpYW4gRUxPIGFuZCBtZWRpYW4gcGxheSBjb3VudCBvZiByYXRlZCBzY2VuZXMuICovXG5leHBvcnQgaW50ZXJmYWNlIEdlbXNTcGxpdCB7XG4gIGVsbzogbnVtYmVyO1xuICBwbGF5czogbnVtYmVyO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2Vtc1NwbGl0KHNjZW5lczogU2NlbmVbXSk6IEdlbXNTcGxpdCB8IG51bGwge1xuICBjb25zdCByYXRlZCA9IHJhdGVkRWxvcyhzY2VuZXMpO1xuICBpZiAocmF0ZWQubGVuZ3RoID09PSAwKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHsgZWxvOiBtZWRpYW4ocmF0ZWQubWFwKChzKSA9PiBzLmVsbykpLCBwbGF5czogbWVkaWFuKHJhdGVkLm1hcCgocykgPT4gcy5zY2VuZS5wbGF5X2NvdW50ID8/IDApKSB9O1xufVxuXG4vKipcbiAqIFwiZ2VtXCI6IHJhbmtlZCBhYm92ZSB0aGUgbWVkaWFuIGJ1dCBwbGF5ZWQgbGVzcyB0aGFuIHRoZSBtZWRpYW4gKGEgaGlkZGVuIGdlbSk7IFwib3ZlcnBsYXllZFwiOlxuICogYmVsb3cgdGhlIG1lZGlhbiBFTE8gYnV0IHBsYXllZCBtb3JlLiBOdWxsIGZvciBldmVyeXRoaW5nIGVsc2UsIGFuZCBmb3IgdW5yYXRlZCBzY2VuZXMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZW1zUXVhZHJhbnQoc2NlbmU6IFNjZW5lLCBzcGxpdDogR2Vtc1NwbGl0KTogXCJnZW1cIiB8IFwib3ZlcnBsYXllZFwiIHwgbnVsbCB7XG4gIGNvbnN0IHZhbHVlID0gZWxvKHNjZW5lKTtcbiAgaWYgKHZhbHVlID09PSBudWxsKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgcGxheXMgPSBzY2VuZS5wbGF5X2NvdW50ID8/IDA7XG4gIGlmICh2YWx1ZSA+IHNwbGl0LmVsbyAmJiBwbGF5cyA8IHNwbGl0LnBsYXlzKSByZXR1cm4gXCJnZW1cIjtcbiAgaWYgKHZhbHVlIDwgc3BsaXQuZWxvICYmIHBsYXlzID4gc3BsaXQucGxheXMpIHJldHVybiBcIm92ZXJwbGF5ZWRcIjtcbiAgcmV0dXJuIG51bGw7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2V0dGxlZEJ1Y2tldCB7XG4gIG1pbjogbnVtYmVyO1xuICAvKiogSW5jbHVzaXZlOyBudWxsIGZvciB0aGUgb3Blbi1lbmRlZCBsYXN0IGJ1Y2tldC4gKi9cbiAgbWF4OiBudW1iZXIgfCBudWxsO1xuICBjb3VudDogbnVtYmVyO1xufVxuXG4vKipcbiAqIFJhdGVkIHNjZW5lcyBieSByZWFsIGJhdHRsZXM6IG5vbmUgeWV0LCB0aGVuIHRoZSBLIHRpZXJzJyByYW5nZXMgKDEtOSwgMTAtMjksIDMwKyksIHNvIGVhY2hcbiAqIGJ1Y2tldCBhZnRlciB0aGUgZmlyc3QgaXMgYSBzdGFnZSB3aGVyZSBhIGJhdHRsZSBtb3ZlcyBFTE8gYnkgYSBkaWZmZXJlbnQgYW1vdW50LlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2V0dGxlZEJ1Y2tldHMoc2NlbmVzOiBTY2VuZVtdKTogU2V0dGxlZEJ1Y2tldFtdIHtcbiAgY29uc3QgbGltaXRzID0gRUxPX0tfVElFUlMubWFwKChbYmVsb3ddKSA9PiBiZWxvdykuZmlsdGVyKE51bWJlci5pc0Zpbml0ZSk7XG4gIGNvbnN0IGVkZ2VzID0gWzAsIDEsIC4uLmxpbWl0c107XG4gIGNvbnN0IGJ1Y2tldHM6IFNldHRsZWRCdWNrZXRbXSA9IGVkZ2VzLm1hcCgobWluLCBpKSA9PiAoe1xuICAgIG1pbixcbiAgICBtYXg6IGkgKyAxIDwgZWRnZXMubGVuZ3RoID8gZWRnZXNbaSArIDFdIC0gMSA6IG51bGwsXG4gICAgY291bnQ6IDAsXG4gIH0pKTtcbiAgZm9yIChjb25zdCB7IHNjZW5lIH0gb2YgcmF0ZWRFbG9zKHNjZW5lcykpIHtcbiAgICBjb25zdCBuID0gYmF0dGxlcyhzY2VuZSk7XG4gICAgY29uc3QgYnVja2V0ID0gWy4uLmJ1Y2tldHNdLnJldmVyc2UoKS5maW5kKChiKSA9PiBuID49IGIubWluKTtcbiAgICBpZiAoYnVja2V0KSBidWNrZXQuY291bnQrKztcbiAgfVxuICByZXR1cm4gYnVja2V0cztcbn1cblxuLyoqXG4gKiBcIkJhdHRsZSB0aGUgbGVhc3QtdGVzdGVkXCI6IHRoZSBzY2VuZSBpbiB0aGUgcG9vbCB3aXRoIHRoZSBmZXdlc3QgcmVhbCBiYXR0bGVzLCBhdCByYW5kb20gYW1vbmdcbiAqIGVxdWFscy4gYGV4Y2x1ZGVJZGAgKHRoZSBzY2VuZSBqdXN0IHNob3duKSBpcyBza2lwcGVkIHVubGVzcyBpdCdzIHRoZSBvbmx5IG9uZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxlYXN0VGVzdGVkKHBvb2w6IFNjZW5lW10sIGV4Y2x1ZGVJZDogc3RyaW5nIHwgbnVsbCwgcmFuZG9tOiAoKSA9PiBudW1iZXIgPSBNYXRoLnJhbmRvbSk6IFNjZW5lIHwgbnVsbCB7XG4gIGNvbnN0IGNhbmRpZGF0ZXMgPSBwb29sLmxlbmd0aCA+IDEgPyBwb29sLmZpbHRlcigocykgPT4gcy5pZCAhPT0gZXhjbHVkZUlkKSA6IHBvb2w7XG4gIGlmIChjYW5kaWRhdGVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGZld2VzdCA9IE1hdGgubWluKC4uLmNhbmRpZGF0ZXMubWFwKGJhdHRsZXMpKTtcbiAgY29uc3QgdGllZCA9IGNhbmRpZGF0ZXMuZmlsdGVyKChzKSA9PiBiYXR0bGVzKHMpID09PSBmZXdlc3QpO1xuICByZXR1cm4gdGllZFtNYXRoLm1pbih0aWVkLmxlbmd0aCAtIDEsIE1hdGguZmxvb3IocmFuZG9tKCkgKiB0aWVkLmxlbmd0aCkpXTtcbn1cblxuLyoqXG4gKiBUaWVyIGZvciBldmVyeSBzZXR0bGVkIHNjZW5lIChyYXRlZCBhbmQgbm90IHByb3Zpc2lvbmFsKSwgYnkgcmFuayBhbW9uZyB0aGVtOiBhIHNjZW5lIHdob3NlXG4gKiByYW5rIGlzIHdpdGhpbiB0aGUgdG9wIGB0aWVyLnRvcGAgc2hhcmUgZ2V0cyB0aGF0IHRpZXIuIFRpZWQgc2NlbmVzIHNoYXJlIHRoZSBtaWRkbGUgcG9zaXRpb25cbiAqIG9mIHRoZWlyIHRpZSBncm91cCwgYXMgaW4gcGVyY2VudGlsZVJhdGluZ3MsIHNvIHRoZXkgYWx3YXlzIHNoYXJlIGEgdGllci4gUHJvdmlzaW9uYWwgYW5kXG4gKiB1bnJhdGVkIHNjZW5lcyBnZXQgbm9uZSwgbGlrZSBcInVucmFua2VkXCIgdW50aWwgcGxhY2VtZW50IG1hdGNoZXMgYXJlIGRvbmUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0aWVyTWFwKHNjZW5lczogU2NlbmVbXSk6IE1hcDxzdHJpbmcsIFRpZXI+IHtcbiAgY29uc3Qgc2V0dGxlZCA9IHNjZW5lc1xuICAgIC5maWx0ZXIoKHNjZW5lKSA9PiAhaXNQcm92aXNpb25hbChzY2VuZSkpXG4gICAgLm1hcCgoc2NlbmUpID0+ICh7IGlkOiBzY2VuZS5pZCwgZWxvOiBlbG8oc2NlbmUpIH0pKVxuICAgIC5maWx0ZXIoKHMpOiBzIGlzIHsgaWQ6IHN0cmluZzsgZWxvOiBudW1iZXIgfSA9PiBzLmVsbyAhPT0gbnVsbClcbiAgICAuc29ydCgoYSwgYikgPT4gYi5lbG8gLSBhLmVsbyk7XG5cbiAgY29uc3QgdGllcnMgPSBuZXcgTWFwPHN0cmluZywgVGllcj4oKTtcbiAgY29uc3QgbiA9IHNldHRsZWQubGVuZ3RoO1xuICBsZXQgc3RhcnQgPSAwO1xuICB3aGlsZSAoc3RhcnQgPCBuKSB7XG4gICAgbGV0IGVuZCA9IHN0YXJ0O1xuICAgIHdoaWxlIChlbmQgKyAxIDwgbiAmJiBzZXR0bGVkW2VuZCArIDFdLmVsbyA9PT0gc2V0dGxlZFtzdGFydF0uZWxvKSBlbmQrKztcbiAgICAvLyBTaGFyZSBvZiBzZXR0bGVkIHNjZW5lcyByYW5rZWQgYWJvdmUgdGhpcyB0aWUgZ3JvdXAncyBtaWRkbGUgKDAgZm9yIHRoZSB0b3Agc2NlbmUpXG4gICAgY29uc3QgYWJvdmUgPSAoc3RhcnQgKyBlbmQpIC8gMiAvIG47XG4gICAgY29uc3QgdGllciA9IFRJRVJTLmZpbmQoKHQpID0+IGFib3ZlIDwgdC50b3ApID8/IFRJRVJTW1RJRVJTLmxlbmd0aCAtIDFdO1xuICAgIGZvciAobGV0IGkgPSBzdGFydDsgaSA8PSBlbmQ7IGkrKykgdGllcnMuc2V0KHNldHRsZWRbaV0uaWQsIHRpZXIpO1xuICAgIHN0YXJ0ID0gZW5kICsgMTtcbiAgfVxuICByZXR1cm4gdGllcnM7XG59XG5cbi8qKiBUb29sdGlwIGZvciBhIHRpZXI6IFwiR29sZDogaW4gdGhlIHRvcCAzNSUgb2YgeW91ciBzY2VuZXMgd2l0aCBhIHNldHRsZWQgRUxPXCIuICovXG5leHBvcnQgZnVuY3Rpb24gdGllckRlc2NyaXB0aW9uKHRpZXI6IFRpZXIpOiBzdHJpbmcge1xuICBjb25zdCBpbmRleCA9IFRJRVJTLmZpbmRJbmRleCgodCkgPT4gdC5pZCA9PT0gdGllci5pZCk7XG4gIGNvbnN0IHBlcmNlbnQgPSAoc2hhcmU6IG51bWJlcik6IHN0cmluZyA9PiBgJHtNYXRoLnJvdW5kKHNoYXJlICogMTAwKX0lYDtcbiAgY29uc3Qgd2hlcmUgPVxuICAgIGluZGV4ID09PSBUSUVSUy5sZW5ndGggLSAxICYmIGluZGV4ID4gMFxuICAgICAgPyBgYmVsb3cgdGhlIHRvcCAke3BlcmNlbnQoVElFUlNbaW5kZXggLSAxXS50b3ApfWBcbiAgICAgIDogYGluIHRoZSB0b3AgJHtwZXJjZW50KHRpZXIudG9wKX1gO1xuICByZXR1cm4gYCR7dGllci5uYW1lfTogJHt3aGVyZX0gb2YgeW91ciBzY2VuZXMgd2l0aCBhIHNldHRsZWQgRUxPYDtcbn1cbiIsICJpbXBvcnQgdHlwZSB7IFNjZW5lIH0gZnJvbSBcIi4uL3R5cGVzXCI7XHJcblxyXG4vKiogU2NlbmUgdGl0bGUgZnJvbSBtZXRhZGF0YSwgb3IgdGhlIGZpbGVuYW1lICh3aXRob3V0IGV4dGVuc2lvbikgZnJvbSB0aGUgZmlsZSBwYXRoLiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZVNjZW5lVGl0bGUoc2NlbmU6IFNjZW5lKTogc3RyaW5nIHtcclxuICBpZiAoc2NlbmUudGl0bGUpIHJldHVybiBzY2VuZS50aXRsZTtcclxuXHJcbiAgY29uc3QgcGF0aCA9IHNjZW5lLmZpbGVzPy5bMF0/LnBhdGg7XHJcbiAgaWYgKHBhdGgpIHtcclxuICAgIGNvbnN0IHBhdGhQYXJ0cyA9IHBhdGguc3BsaXQoL1svXFxcXF0vKTtcclxuICAgIHJldHVybiBwYXRoUGFydHNbcGF0aFBhcnRzLmxlbmd0aCAtIDFdLnJlcGxhY2UoL1xcLlteLy5dKyQvLCBcIlwiKTtcclxuICB9XHJcblxyXG4gIHJldHVybiBcIlwiO1xyXG59XHJcbiIsICIvLyBSZW5kZXJzIGFuIGluZGl2aWR1YWwgc2NlbmUgY2FyZCAocmV0dXJucyBhbiBIVE1MIHN0cmluZykuXG5cbmltcG9ydCB7IENIQU1QSU9OX1VOUkFURURfRUxPLCBFTE9fS19USUVSUywgRUxPX1NUQVJUIH0gZnJvbSBcIi4uL2NvbnN0YW50c1wiO1xuaW1wb3J0IHsgYmF0dGxlcywgZWxvLCBpc1Byb3Zpc2lvbmFsIH0gZnJvbSBcIi4uL3Njb3JlXCI7XG5pbXBvcnQgeyBzdGF0ZSB9IGZyb20gXCIuLi9zdGF0ZVwiO1xuaW1wb3J0IHsgdGllckRlc2NyaXB0aW9uIH0gZnJvbSBcIi4uL3N0YXRzXCI7XG5pbXBvcnQgeyBpc1N0YXNoRGVsZXRlRGlhbG9nQXZhaWxhYmxlIH0gZnJvbSBcIi4vZGVsZXRlRGlhbG9nXCI7XG5pbXBvcnQgdHlwZSB7IFJhbmssIFNjZW5lLCBUaWVyIH0gZnJvbSBcIi4uL3R5cGVzXCI7XG5pbXBvcnQgeyByZXNvbHZlU2NlbmVUaXRsZSB9IGZyb20gXCIuL3NjZW5lVGl0bGVcIjtcblxuLyoqIFRvb2x0aXAgZm9yIGEgcHJvdmlzaW9uYWwgRUxPICh0aGUgXCI/XCIgYWZ0ZXIgaXQpLiAqL1xuZXhwb3J0IGNvbnN0IFBST1ZJU0lPTkFMX1RJUCA9IGBQcm92aXNpb25hbDogZmV3ZXIgdGhhbiAke0VMT19LX1RJRVJTWzBdWzBdfSBiYXR0bGVzLCBzbyB0aGlzIEVMTyBpcyBzdGlsbCBzZXR0bGluZ2A7XG5cbi8qKiBTbWFsbCBwaWxsIHdpdGggdGhlIHRpZXIncyBlbW9qaSBhbmQgbmFtZSAodGhlIG5hbWUgaGlkZXMgb24gcGhvbmVzKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0aWVyUGlsbCh0aWVyOiBUaWVyKTogc3RyaW5nIHtcbiAgcmV0dXJuIGA8c3BhbiBjbGFzcz1cInNiLXRpZXIgc2ItdGllci0ke3RpZXIuaWR9XCIgdGl0bGU9XCIke3RpZXJEZXNjcmlwdGlvbih0aWVyKX1cIj4ke3RpZXIuZW1vaml9PHNwYW4gY2xhc3M9XCJzYi10aWVyLW5hbWVcIj4gJHt0aWVyLm5hbWV9PC9zcGFuPjwvc3Bhbj5gO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0RHVyYXRpb24oc2Vjb25kczogbnVtYmVyIHwgbnVsbCB8IHVuZGVmaW5lZCk6IHN0cmluZyB7XG4gIGlmICghc2Vjb25kcykgcmV0dXJuIFwiTi9BXCI7XG4gIGNvbnN0IGggPSBNYXRoLmZsb29yKHNlY29uZHMgLyAzNjAwKTtcbiAgY29uc3QgbSA9IE1hdGguZmxvb3IoKHNlY29uZHMgJSAzNjAwKSAvIDYwKTtcbiAgY29uc3QgcyA9IE1hdGguZmxvb3Ioc2Vjb25kcyAlIDYwKTtcbiAgaWYgKGggPiAwKSB7XG4gICAgcmV0dXJuIGAke2h9OiR7bS50b1N0cmluZygpLnBhZFN0YXJ0KDIsIFwiMFwiKX06JHtzLnRvU3RyaW5nKCkucGFkU3RhcnQoMiwgXCIwXCIpfWA7XG4gIH1cbiAgcmV0dXJuIGAke219OiR7cy50b1N0cmluZygpLnBhZFN0YXJ0KDIsIFwiMFwiKX1gO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlU2NlbmVDYXJkKFxuICBzY2VuZTogU2NlbmUsXG4gIHNpZGU6IFwibGVmdFwiIHwgXCJyaWdodFwiLFxuICByYW5rOiBSYW5rID0gbnVsbCxcbiAgc3RhdHVzQmFkZ2U6IG51bWJlciB8IHN0cmluZyB8IG51bGwgPSBudWxsLFxuICB0aWVyOiBUaWVyIHwgbnVsbCA9IG51bGwsXG4pOiBzdHJpbmcge1xuICBjb25zdCBmaWxlID0gc2NlbmUuZmlsZXMgJiYgc2NlbmUuZmlsZXNbMF0gPyBzY2VuZS5maWxlc1swXSA6IHt9O1xuICBjb25zdCBkdXJhdGlvbiA9IGZpbGUuZHVyYXRpb247XG4gIGNvbnN0IHBlcmZvcm1lcnMgPVxuICAgIHNjZW5lLnBlcmZvcm1lcnMgJiYgc2NlbmUucGVyZm9ybWVycy5sZW5ndGggPiAwXG4gICAgICA/IHNjZW5lLnBlcmZvcm1lcnMubWFwKChwKSA9PiBwLm5hbWUpLmpvaW4oXCIsIFwiKVxuICAgICAgOiBcIk5vIHBlcmZvcm1lcnNcIjtcbiAgY29uc3Qgc3R1ZGlvID0gc2NlbmUuc3R1ZGlvID8gc2NlbmUuc3R1ZGlvLm5hbWUgOiBcIk5vIHN0dWRpb1wiO1xuICBjb25zdCB0YWdzID0gc2NlbmUudGFncyA/IHNjZW5lLnRhZ3Muc2xpY2UoMCwgNSkubWFwKCh0KSA9PiB0Lm5hbWUpIDogW107XG5cbiAgY29uc3QgdGl0bGUgPSByZXNvbHZlU2NlbmVUaXRsZShzY2VuZSk7XG5cbiAgY29uc3Qgc2NyZWVuc2hvdFBhdGggPSBzY2VuZS5wYXRocyA/IHNjZW5lLnBhdGhzLnNjcmVlbnNob3QgOiBudWxsO1xuICBjb25zdCBwcmV2aWV3UGF0aCA9IHNjZW5lLnBhdGhzID8gc2NlbmUucGF0aHMucHJldmlldyA6IG51bGw7XG4gIGNvbnN0IHsgb3BlbkluTmV3VGFiLCBjbGVhbk1vZGUgfSA9IHN0YXRlLnNldHRpbmdzO1xuICBjb25zdCBzdGFzaFJhdGluZyA9IHNjZW5lLnJhdGluZzEwMCA/IGAke3NjZW5lLnJhdGluZzEwMH0vMTAwYCA6IFwiTm9uZVwiO1xuXG4gIC8vIEVMTyBiYWRnZTogXCJFTE8gMTc0MCDCtyAjNTBcIiB3aGVuIHJhdGVkIChyYW5rIHdoZW4ga25vd24pLCB3aXRoIGEgXCI/XCIgd2hpbGUgaXQncyBwcm92aXNpb25hbC5cbiAgLy8gVW5yYXRlZCBzY2VuZXMgc2hvdyB0aGUgRUxPIHRoZXkgY291bnQgYXMgaW4gdGhpcyBtb2RlIGluIHRoZSBzYW1lIG9yZGVyLCBcIkVMTyAxNTAwIMK3XG4gIC8vIFVucmF0ZWRcIiAoUGxhY2VtZW50IGhhcyBub25lOiBcIlVucmF0ZWRcIikuXG4gIGNvbnN0IGVsb1ZhbHVlID0gZWxvKHNjZW5lKTtcbiAgY29uc3QgdW5yYXRlZEFzID1cbiAgICBzdGF0ZS5jdXJyZW50TW9kZSA9PT0gXCJzd2lzc1wiID8gRUxPX1NUQVJUIDogc3RhdGUuY3VycmVudE1vZGUgPT09IFwiY2hhbXBpb25cIiA/IENIQU1QSU9OX1VOUkFURURfRUxPIDogbnVsbDtcbiAgY29uc3QgcHJvdmlzaW9uYWwgPSBpc1Byb3Zpc2lvbmFsKHNjZW5lKTtcbiAgbGV0IGVsb0xhYmVsOiBzdHJpbmc7XG4gIGlmIChlbG9WYWx1ZSAhPT0gbnVsbCkge1xuICAgIGVsb0xhYmVsID0gYEVMTyAke01hdGgucm91bmQoZWxvVmFsdWUpfSR7cHJvdmlzaW9uYWwgPyBcIj9cIiA6IFwiXCJ9JHtyYW5rICE9PSBudWxsICYmIHJhbmsgIT09IHVuZGVmaW5lZCA/IGAgwrcgIyR7cmFua31gIDogXCJcIn1gO1xuICB9IGVsc2Uge1xuICAgIGVsb0xhYmVsID0gdW5yYXRlZEFzICE9PSBudWxsID8gYEVMTyAke3VucmF0ZWRBc30gwrcgVW5yYXRlZGAgOiBcIlVucmF0ZWRcIjtcbiAgfVxuICBjb25zdCByYW5rVGl0bGUgPSBwcm92aXNpb25hbCA/IGAgdGl0bGU9XCIke1BST1ZJU0lPTkFMX1RJUH1cImAgOiBcIlwiO1xuICBjb25zdCByYW5rRGlzcGxheSA9IGAke3RpZXIgPyB0aWVyUGlsbCh0aWVyKSA6IFwiXCJ9PHNwYW4gY2xhc3M9XCJzYi1zY2VuZS1yYW5rXCIke3JhbmtUaXRsZX0+JHtlbG9MYWJlbH08L3NwYW4+YDtcblxuICAvLyBTdGF0dXMgYmFkZ2U6IHdpbi1zdHJlYWsgY291bnQgKGZvcm1hdHRlZCkgb3IgY3VzdG9tIGxhYmVsIChlLmcuIGZhbGxpbmcgbW9kZSlcbiAgbGV0IHN0YXR1c0JhZGdlSHRtbCA9IFwiXCI7XG4gIGlmICh0eXBlb2Ygc3RhdHVzQmFkZ2UgPT09IFwic3RyaW5nXCIpIHtcbiAgICBzdGF0dXNCYWRnZUh0bWwgPSBgPGRpdiBjbGFzcz1cInNiLXN0cmVhay1iYWRnZVwiPiR7c3RhdHVzQmFkZ2V9PC9kaXY+YDtcbiAgfSBlbHNlIGlmIChzdGF0dXNCYWRnZSAhPT0gbnVsbCAmJiBzdGF0dXNCYWRnZSA+IDApIHtcbiAgICBzdGF0dXNCYWRnZUh0bWwgPSBgPGRpdiBjbGFzcz1cInNiLXN0cmVhay1iYWRnZVwiPvCflKUgJHtzdGF0dXNCYWRnZX0gd2luJHtzdGF0dXNCYWRnZSA+IDEgPyBcInNcIiA6IFwiXCJ9PC9kaXY+YDtcbiAgfVxuXG4gIC8vIFByZXNlcnZlIFVSTCBzZWFyY2ggcGFyYW1zIHdoZW4gb3BlbmluZyBzY2VuZVxuICBjb25zdCBjdXJyZW50UGFyYW1zID0gd2luZG93LmxvY2F0aW9uLnNlYXJjaDtcbiAgY29uc3Qgc2NlbmVVcmwgPSBgL3NjZW5lcy8ke3NjZW5lLmlkfSR7Y3VycmVudFBhcmFtc31gO1xuICBjb25zdCBsaW5rVGFyZ2V0ID0gb3BlbkluTmV3VGFiID8gYCB0YXJnZXQ9XCJfYmxhbmtcIiByZWw9XCJub29wZW5lclwiYCA6IFwiXCI7XG5cbiAgLy8gcHdyLSogY2xhc3NlcyBhcmUgdGhlIHBsdWdpbidzIHByZS0yLjAgbmFtZXM7IFNGVyBTd2l0Y2ggc3RpbGwgdGFyZ2V0cyB0aGVtIHRvIGJsdXIgU3Rhc2ggQmF0dGxlLlxuICAvLyBCYWRnZXMgc2l0IG91dHNpZGUgdGhlIChibHVycmVkKSBpbWFnZSBjb250YWluZXIgc28gdGhleSBzdGF5IHJlYWRhYmxlIGluIFNGVyBtb2RlLlxuICByZXR1cm4gYFxuICAgICAgPGRpdiBjbGFzcz1cInNiLXNjZW5lLWNhcmRcIiBkYXRhLXNpZGU9XCIke3NpZGV9XCI+XG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi1zY2VuZS1tZWRpYVwiPlxuICAgICAgICAgIDxhIGNsYXNzPVwic2Itc2NlbmUtaW1hZ2UtY29udGFpbmVyIHB3ci1zY2VuZS1pbWFnZS1jb250YWluZXJcIiBocmVmPVwiJHtzY2VuZVVybH1cIiR7bGlua1RhcmdldH0+XG4gICAgICAgICAgICAke1xuICAgICAgICAgICAgICBzY3JlZW5zaG90UGF0aFxuICAgICAgICAgICAgICAgID8gYDxpbWcgY2xhc3M9XCJzYi1zY2VuZS1pbWFnZSBwd3Itc2NlbmUtaW1hZ2VcIiBzcmM9XCIke3NjcmVlbnNob3RQYXRofVwiIGFsdD1cIiR7dGl0bGV9XCIgbG9hZGluZz1cImxhenlcIiAvPmBcbiAgICAgICAgICAgICAgICA6IGA8ZGl2IGNsYXNzPVwic2Itc2NlbmUtaW1hZ2Ugc2Itbm8taW1hZ2VcIj5ObyBTY3JlZW5zaG90PC9kaXY+YFxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgJHtwcmV2aWV3UGF0aCA/IGA8dmlkZW8gY2xhc3M9XCJzYi1ob3Zlci1wcmV2aWV3IHB3ci1ob3Zlci1wcmV2aWV3XCIgc3JjPVwiJHtwcmV2aWV3UGF0aH1cIiBsb29wIG11dGVkIHBsYXlzaW5saW5lPjwvdmlkZW8+YCA6IFwiXCJ9XG4gICAgICAgICAgPC9hPlxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1zY2VuZS1kdXJhdGlvblwiPiR7Zm9ybWF0RHVyYXRpb24oZHVyYXRpb24pfTwvZGl2PlxuICAgICAgICAgICR7c3RhdHVzQmFkZ2VIdG1sfVxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1jbGljay1oaW50XCI+JHtvcGVuSW5OZXdUYWIgPyBcIkNsaWNrIHRvIG9wZW4gaW4gbmV3IHRhYlwiIDogXCJDbGljayB0byBvcGVuIHNjZW5lXCJ9PC9kaXY+XG4gICAgICAgICAgPGEgY2xhc3M9XCJzYi1vcGVuLWxpbmtcIiBocmVmPVwiJHtzY2VuZVVybH1cIiB0YXJnZXQ9XCJfYmxhbmtcIiByZWw9XCJub29wZW5lclwiIHRpdGxlPVwiT3BlbiBzY2VuZSBpbiBuZXcgdGFiXCI+4oaXPC9hPlxuICAgICAgICAgICR7Y2xlYW5Nb2RlICYmIGlzU3Rhc2hEZWxldGVEaWFsb2dBdmFpbGFibGUoKSA/IGA8YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cInNiLWRlbGV0ZS1idG5cIiB0aXRsZT1cIkRlbGV0ZSB0aGlzIHNjZW5lIGZyb20gU3Rhc2hcIj7wn5eRPC9idXR0b24+YCA6IFwiXCJ9XG4gICAgICAgIDwvZGl2PlxuXG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi1zY2VuZS1ib2R5XCIgZGF0YS13aW5uZXI9XCIke3NjZW5lLmlkfVwiPlxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1zY2VuZS1pbmZvIHB3ci1zY2VuZS1pbmZvXCI+XG4gICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2Itc2NlbmUtdGl0bGUtcm93XCI+XG4gICAgICAgICAgICAgIDxoMyBjbGFzcz1cInNiLXNjZW5lLXRpdGxlXCI+JHt0aXRsZX08L2gzPlxuICAgICAgICAgICAgICAke3JhbmtEaXNwbGF5fVxuICAgICAgICAgICAgPC9kaXY+XG5cbiAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1zY2VuZS1tZXRhXCI+XG4gICAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1tZXRhLWl0ZW0gc2ItbWV0YS1zdHVkaW9cIj48c3Ryb25nPlN0dWRpbzo8L3N0cm9uZz4gJHtzdHVkaW99PC9kaXY+XG4gICAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1tZXRhLWl0ZW0gc2ItbWV0YS1wZXJmb3JtZXJzXCI+PHN0cm9uZz5QZXJmb3JtZXJzOjwvc3Ryb25nPiAke3BlcmZvcm1lcnN9PC9kaXY+XG4gICAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1tZXRhLWl0ZW0gc2ItbWV0YS1wbGF5c1wiPjxzdHJvbmc+UGxheSBDb3VudDo8L3N0cm9uZz4gJHtzY2VuZS5wbGF5X2NvdW50IHx8IDB9PC9kaXY+XG4gICAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1tZXRhLWl0ZW0gc2ItbWV0YS1iYXR0bGVzXCI+PHN0cm9uZz5CYXR0bGVzOjwvc3Ryb25nPiAke2JhdHRsZXMoc2NlbmUpfTwvZGl2PlxuICAgICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItbWV0YS1pdGVtIHNiLW1ldGEtcmF0aW5nXCI+PHN0cm9uZz5TdGFzaCBSYXRpbmc6PC9zdHJvbmc+ICR7c3Rhc2hSYXRpbmd9PC9kaXY+XG4gICAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1tZXRhLWl0ZW0gc2ItdGFncy1yb3dcIj48c3Ryb25nPlRhZ3M6PC9zdHJvbmc+ICR7dGFncy5sZW5ndGggPiAwID8gdGFncy5tYXAoKHRhZykgPT4gYDxzcGFuIGNsYXNzPVwic2ItdGFnXCI+JHt0YWd9PC9zcGFuPmApLmpvaW4oXCJcIikgOiAnPHNwYW4gY2xhc3M9XCJzYi1ub25lXCI+Tm9uZTwvc3Bhbj4nfTwvZGl2PlxuICAgICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgPC9kaXY+XG5cbiAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItY2hvb3NlLWJ0blwiPlxuICAgICAgICAgICAg4pyTIENob29zZTxzcGFuIGNsYXNzPVwic2ItY2hvb3NlLWxvbmdcIj4gVGhpcyBTY2VuZTwvc3Bhbj5cbiAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgPC9kaXY+XG4gICAgICA8L2Rpdj5cbiAgICBgO1xufVxuIiwgIi8vIFZpY3RvcnkgYW5kIHBsYWNlbWVudCBlbmQtc2NyZWVucyBmb3IgQ2hhbXBpb24gYW5kIFBsYWNlbWVudCBydW5zLlxuXG5pbXBvcnQgeyBsYXRlc3RTY2VuZSB9IGZyb20gXCIuLi9jYWNoZVwiO1xuaW1wb3J0IHsgZWxvLCBzdGFzaFJhdGluZ1RhcmdldHMgfSBmcm9tIFwiLi4vc2NvcmVcIjtcbmltcG9ydCB7IHJlc2V0UnVuU3RhdGUsIHN0YXRlIH0gZnJvbSBcIi4uL3N0YXRlXCI7XG5pbXBvcnQgeyBzYXZlU3RhdGUgfSBmcm9tIFwiLi4vc3RvcmFnZVwiO1xuaW1wb3J0IHR5cGUgeyBQbGFjZW1lbnRQYWlyUmVzdWx0LCBTY2VuZSB9IGZyb20gXCIuLi90eXBlc1wiO1xuaW1wb3J0IHsgbG9hZE5ld1BhaXIsIHNldEFjdGlvbnNWaXNpYmxlIH0gZnJvbSBcIi4vbWFpblVJXCI7XG5pbXBvcnQgeyByZXNvbHZlU2NlbmVUaXRsZSB9IGZyb20gXCIuL3NjZW5lVGl0bGVcIjtcblxuZnVuY3Rpb24gYnVpbGRFbmRTY3JlZW5IdG1sKFxuICBzY2VuZTogU2NlbmUsXG4gIGNyb3duOiBzdHJpbmcsXG4gIGhlYWRsaW5lOiBzdHJpbmcsXG4gIHN0YXRzSHRtbDogc3RyaW5nLFxuICBidXR0b25MYWJlbDogc3RyaW5nLFxuKTogc3RyaW5nIHtcbiAgY29uc3QgdGl0bGUgPSByZXNvbHZlU2NlbmVUaXRsZShzY2VuZSk7XG4gIGNvbnN0IHNjcmVlbnNob3RQYXRoID0gc2NlbmUucGF0aHM/LnNjcmVlbnNob3QgPz8gbnVsbDtcblxuICByZXR1cm4gYFxuICAgICAgPGRpdiBjbGFzcz1cInNiLWVuZC1zY3JlZW5cIj5cbiAgICAgICAgPGRpdiBjbGFzcz1cInNiLWVuZC1zY3JlZW4taWNvblwiPiR7Y3Jvd259PC9kaXY+XG4gICAgICAgIDxoMiBjbGFzcz1cInNiLWVuZC1zY3JlZW4taGVhZGxpbmVcIj4ke2hlYWRsaW5lfTwvaDI+XG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi1lbmQtc2NyZWVuLXNjZW5lIHB3ci1zY2VuZS1pbWFnZS1jb250YWluZXJcIj5cbiAgICAgICAgICAke1xuICAgICAgICAgICAgc2NyZWVuc2hvdFBhdGhcbiAgICAgICAgICAgICAgPyBgPGltZyBjbGFzcz1cInNiLWVuZC1zY3JlZW4taW1hZ2UgcHdyLXNjZW5lLWltYWdlXCIgc3JjPVwiJHtzY3JlZW5zaG90UGF0aH1cIiBhbHQ9XCIke3RpdGxlfVwiIC8+YFxuICAgICAgICAgICAgICA6IGA8ZGl2IGNsYXNzPVwic2ItZW5kLXNjcmVlbi1pbWFnZSBzYi1uby1pbWFnZVwiPk5vIFNjcmVlbnNob3Q8L2Rpdj5gXG4gICAgICAgICAgfVxuICAgICAgICA8L2Rpdj5cbiAgICAgICAgPGgzIGNsYXNzPVwic2ItZW5kLXNjcmVlbi1uYW1lXCI+JHt0aXRsZX08L2gzPlxuICAgICAgICA8cCBjbGFzcz1cInNiLWVuZC1zY3JlZW4tc3RhdHNcIj4ke3N0YXRzSHRtbH08L3A+XG4gICAgICAgIDxidXR0b24gaWQ9XCJzYi1uZXctcnVuXCIgY2xhc3M9XCJidG4gYnRuLXByaW1hcnlcIj4ke2J1dHRvbkxhYmVsfTwvYnV0dG9uPlxuICAgICAgPC9kaXY+XG4gICAgYDtcbn1cblxuLyoqIFJlbmRlciBhbiBlbmQgc2NyZWVuLCBoaWRlIGJhdHRsZSBjb250cm9scywgYW5kIHdpcmUgdGhlIG5ldy1ydW4gYnV0dG9uLiAqL1xuZnVuY3Rpb24gc2hvd0VuZFNjcmVlbihodG1sOiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgY29tcGFyaXNvbkFyZWEgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInNiLWNvbXBhcmlzb24tYXJlYVwiKTtcbiAgaWYgKCFjb21wYXJpc29uQXJlYSkgcmV0dXJuO1xuXG4gIGNvbXBhcmlzb25BcmVhLmlubmVySFRNTCA9IGh0bWw7XG4gIHNldEFjdGlvbnNWaXNpYmxlKGZhbHNlKTtcblxuICBjb21wYXJpc29uQXJlYS5xdWVyeVNlbGVjdG9yKFwiI3NiLW5ldy1ydW5cIik/LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiB7XG4gICAgbG9hZE5ld1BhaXIoKTtcbiAgfSk7XG59XG5cbi8qKiBDYXB0dXJlIGRpc3BsYXkgdmFsdWVzLCBjbGVhciBydW4gc3RhdGUsIHRoZW4gc2hvdyB0aGUgZW5kIHNjcmVlbi4gKi9cbmZ1bmN0aW9uIGZpbmlzaFJ1blNob3dFbmRTY3JlZW4oaHRtbDogc3RyaW5nKTogdm9pZCB7XG4gIHJlc2V0UnVuU3RhdGUoKTtcbiAgLy8gVGhlIGxhc3QgcGFpciBiZWxvbmdzIHRvIHRoZSBmaW5pc2hlZCBydW46IGEgcmVsb2FkIG11c3RuJ3QgcmVzdG9yZSBpdCB3aXRob3V0IGl0cyBydW5cbiAgc3RhdGUuY3VycmVudFBhaXIgPSB7IGxlZnQ6IG51bGwsIHJpZ2h0OiBudWxsIH07XG4gIHN0YXRlLmN1cnJlbnRSYW5rcyA9IHsgbGVmdDogbnVsbCwgcmlnaHQ6IG51bGwgfTtcbiAgc2F2ZVN0YXRlKCk7XG4gIHNob3dFbmRTY3JlZW4oaHRtbCk7XG59XG5cbi8qKlxuICogXCJFTE86IDE3NDBcIiwgcGx1cyBcIsK3IFN0YXNoIFJhdGluZzogNzRcIiB3aGlsZSBhbiB1cGRhdGUgbW9kZSBpcyBvbi4gVGhlIHJhdGluZyBpcyB3b3JrZWQgb3V0XG4gKiB0aGUgd2F5IHRoZSBzeW5jIGRvZXMgaXQgKGl0IG1heSBzdGlsbCBiZSBvbiBpdHMgd2F5IHRvIFN0YXNoKSwgc28gaXQncyB3aGF0IFN0YXNoIHdpbGwgc2hvdy5cbiAqL1xuZnVuY3Rpb24gZWxvTGluZShzY2VuZTogU2NlbmUsIHZhbHVlOiBudW1iZXIgfCBudWxsKTogc3RyaW5nIHtcbiAgaWYgKHZhbHVlID09PSBudWxsKSByZXR1cm4gXCJcIjtcbiAgbGV0IGxpbmUgPSBgPGJyPkVMTzogPHN0cm9uZz4ke01hdGgucm91bmQodmFsdWUpfTwvc3Ryb25nPmA7XG4gIGNvbnN0IG1vZGUgPSBzdGF0ZS5zZXR0aW5ncy5zdGFzaFJhdGluZ3M7XG4gIGNvbnN0IHNjZW5lcyA9IHN0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcztcbiAgaWYgKG1vZGUgIT09IFwib2ZmXCIgJiYgc2NlbmVzKSB7XG4gICAgY29uc3QgcmF0aW5nID0gc3Rhc2hSYXRpbmdUYXJnZXRzKHNjZW5lcywgbW9kZSkuZ2V0KHNjZW5lLmlkKTtcbiAgICBpZiAocmF0aW5nICE9PSB1bmRlZmluZWQpIGxpbmUgKz0gYCDCtyBTdGFzaCBSYXRpbmc6IDxzdHJvbmc+JHtyYXRpbmd9PC9zdHJvbmc+YDtcbiAgfVxuICByZXR1cm4gbGluZTtcbn1cblxuLyoqIENoYW1waW9uIGJlYXQgZXZlcnkgc2NlbmUgYWJvdmUgaXQsIG9yIGEgY2xpbWIgZnJvbSB0aGUgYm90dG9tIG5ldmVyIGxvc3Q6IGl0J3MgIzEuICovXG5leHBvcnQgZnVuY3Rpb24gc2hvd1ZpY3RvcnlTY3JlZW4oY2hhbXBpb246IFNjZW5lLCB3aW5TdHJlYWs6IG51bWJlcik6IHZvaWQge1xuICBjb25zdCBodG1sID0gYnVpbGRFbmRTY3JlZW5IdG1sKFxuICAgIGNoYW1waW9uLFxuICAgIFwi8J+RkVwiLFxuICAgIFwiQ0hBTVBJT04hXCIsXG4gICAgYFJlYWNoZWQgdGhlIHRvcDogJHt3aW5TdHJlYWt9IHdpbiR7d2luU3RyZWFrID09PSAxID8gXCJcIiA6IFwic1wifSBpbiBhIHJvdyEke2Vsb0xpbmUoY2hhbXBpb24sIGVsbyhsYXRlc3RTY2VuZShjaGFtcGlvbikpKX1gLFxuICAgIFwiU3RhcnQgTmV3IFJ1blwiLFxuICApO1xuXG4gIGZpbmlzaFJ1blNob3dFbmRTY3JlZW4oaHRtbCk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBzaG93UGxhY2VtZW50U2NyZWVuKHJlc3VsdDogRXh0cmFjdDxQbGFjZW1lbnRQYWlyUmVzdWx0LCB7IGRvbmU6IHRydWUgfT4pOiB2b2lkIHtcbiAgY29uc3QgeyBzY2VuZSwgcmFuaywgYmF0dGxlcywgc3RyZWFrLCBmcm9tQm90dG9tIH0gPSByZXN1bHQ7XG4gIGNvbnN0IHN0cmVha1RleHQgPSBmcm9tQm90dG9tICYmIHN0cmVhayA+IDAgPyBg8J+UpSAke3N0cmVha30gd2luIHN0cmVhayDCtyBgIDogXCJcIjtcbiAgY29uc3QgYmF0dGxlc1RleHQgPSBiYXR0bGVzID8gYCDCtyAke2JhdHRsZXN9IGJhdHRsZSR7YmF0dGxlcyA9PT0gMSA/IFwiXCIgOiBcInNcIn1gIDogXCJcIjtcbiAgY29uc3QgaHRtbCA9IGJ1aWxkRW5kU2NyZWVuSHRtbChcbiAgICBzY2VuZSxcbiAgICBcIvCfk41cIixcbiAgICBcIlBMQUNFRCFcIixcbiAgICBgJHtzdHJlYWtUZXh0fVJhbmsgPHN0cm9uZz4jJHtyYW5rfTwvc3Ryb25nPiBvZiAke3N0YXRlLnRvdGFsU2NlbmVzQ291bnR9JHtiYXR0bGVzVGV4dH0ke2Vsb0xpbmUoc2NlbmUsIHJlc3VsdC5lbG8pfWAsXG4gICAgXCJTdGFydCBOZXcgUnVuXCIsXG4gICk7XG5cbiAgZmluaXNoUnVuU2hvd0VuZFNjcmVlbihodG1sKTtcbn1cbiIsICIvLyBXaGF0IGVhY2ggXCJTdGFzaCByYXRpbmdzXCIgb3B0aW9uIGRvZXMsIHNoYXJlZCBieSB0aGUgc2V0dXAgc2NyZWVuIGFuZCB0aGUgU2V0dGluZ3MgZHJvcGRvd24uXG5cbmltcG9ydCB0eXBlIHsgU3Rhc2hSYXRpbmdzTW9kZSB9IGZyb20gXCIuLi90eXBlc1wiO1xuXG5leHBvcnQgY29uc3QgU1RBU0hfUkFUSU5HU19PUFRJT05TOiByZWFkb25seSB7IHZhbHVlOiBTdGFzaFJhdGluZ3NNb2RlOyBsYWJlbDogc3RyaW5nOyBkZXNjOiBzdHJpbmcgfVtdID0gW1xuICB7IHZhbHVlOiBcIm9mZlwiLCBsYWJlbDogXCJEb24ndCB1cGRhdGVcIiwgZGVzYzogXCJFTE8gaXMgc2F2ZWQ7IHlvdXIgU3Rhc2ggcmF0aW5ncyBzdGF5IGFzIHRoZXkgYXJlLlwiIH0sXG4gIHtcbiAgICB2YWx1ZTogXCJsaW5lYXJcIixcbiAgICBsYWJlbDogXCJTdHJhaWdodC1saW5lXCIsXG4gICAgZGVzYzogXCJSYXRpbmcgPSBFTE8gY29udmVydGVkIGJhY2sgKDE1MDAgPSA1MCwgMTAgRUxPIHBlciBwb2ludCkuIFZlcnkgaGlnaCBvciBsb3cgc2NlbmVzIHN0b3AgYXQgMTAwIG9yIDEuXCIsXG4gIH0sXG4gIHtcbiAgICB2YWx1ZTogXCJwZXJjZW50aWxlXCIsXG4gICAgbGFiZWw6IFwiUGVyY2VudGlsZVwiLFxuICAgIGRlc2M6IFwiUmF0aW5nID0gcGVyY2VudGlsZSBpbiB5b3VyIGxpYnJhcnk6IDkwIG1lYW5zIHRoZSBzY2VuZSByYW5rcyBhYm92ZSBhYm91dCA5MCUgb2YgeW91ciBzY2VuZXMuIFRvcCBzY2VuZSAxMDAsIGJvdHRvbSAxLlwiLFxuICB9LFxuXTtcblxuZXhwb3J0IGZ1bmN0aW9uIHN0YXNoUmF0aW5nc09wdGlvbih2YWx1ZTogU3Rhc2hSYXRpbmdzTW9kZSk6ICh0eXBlb2YgU1RBU0hfUkFUSU5HU19PUFRJT05TKVtudW1iZXJdIHtcbiAgcmV0dXJuIFNUQVNIX1JBVElOR1NfT1BUSU9OUy5maW5kKChvcHRpb24pID0+IG9wdGlvbi52YWx1ZSA9PT0gdmFsdWUpID8/IFNUQVNIX1JBVElOR1NfT1BUSU9OU1swXTtcbn1cbiIsICIvLyBCYXR0bGUgLyBTZXR0aW5ncyB0YWJzIChTdGFzaCdzIG93biBuYXYtdGFicyArIC5zZXR0aW5nIHJvd3MsIGxpa2UgU3Rhc2gtVENvZGUpLCBwbHVzIHRoZVxuLy8gcHJldmlldyB2b2x1bWUgY29udHJvbCB0aGF0IHNpdHMgb24gdGhlIHRhYiBiYXIuIEV2ZXJ5IGNvbnRyb2wgY2FycmllcyBkYXRhLXNldHRpbmc9XCI8a2V5PlwiO1xuLy8gdmFsdWVzIHBlcnNpc3QgdmlhIHVwZGF0ZVNldHRpbmdzKCkuIEFjdGlvbiByb3dzIChSZXNldCBFTE8pIGNhcnJ5IGRhdGEtYWN0aW9uIGluc3RlYWQuXG5cbmltcG9ydCB7IHVwZGF0ZVNldHRpbmdzIH0gZnJvbSBcIi4uL3NldHRpbmdzXCI7XG5pbXBvcnQgeyBzdGF0ZSB9IGZyb20gXCIuLi9zdGF0ZVwiO1xuaW1wb3J0IHR5cGUgeyBTZXR0aW5ncywgU3Rhc2hSYXRpbmdzTW9kZSB9IGZyb20gXCIuLi90eXBlc1wiO1xuaW1wb3J0IHsgU1RBU0hfUkFUSU5HU19PUFRJT05TLCBzdGFzaFJhdGluZ3NPcHRpb24gfSBmcm9tIFwiLi9zdGFzaFJhdGluZ3NUZXh0XCI7XG5cbnR5cGUgQm9vbEtleSA9IHsgW0sgaW4ga2V5b2YgU2V0dGluZ3NdOiBTZXR0aW5nc1tLXSBleHRlbmRzIGJvb2xlYW4gPyBLIDogbmV2ZXIgfVtrZXlvZiBTZXR0aW5nc107XG5leHBvcnQgdHlwZSBUYWJJZCA9IFwiYmF0dGxlXCIgfCBcInNldHRpbmdzXCI7XG5cbnR5cGUgU2V0dGluZ1JvdyA9XG4gIHwgeyBrZXk6IGtleW9mIFNldHRpbmdzOyB0aXRsZTogc3RyaW5nOyBoaW50OiBzdHJpbmcgfVxuICB8IHsgYWN0aW9uOiBcInJlc2V0LWVsb1wiOyB0aXRsZTogc3RyaW5nOyBoaW50OiBzdHJpbmc7IGJ1dHRvbjogc3RyaW5nIH07XG5cbmNvbnN0IFNFQ1RJT05TOiB7IHRpdGxlOiBzdHJpbmc7IHJvd3M6IFNldHRpbmdSb3dbXSB9W10gPSBbXG4gIHtcbiAgICB0aXRsZTogXCJFTE9cIixcbiAgICByb3dzOiBbXG4gICAgICAvLyBUaGUgaGludCBpcyB0aGUgc2VsZWN0ZWQgb3B0aW9uJ3MgZGVzY3JpcHRpb24gKGtlcHQgY3VycmVudCBieSBzeW5jU2V0dGluZ3NDb250cm9scylcbiAgICAgIHsga2V5OiBcInN0YXNoUmF0aW5nc1wiLCB0aXRsZTogXCJTdGFzaCByYXRpbmdzIHVwZGF0ZSBtb2RlXCIsIGhpbnQ6IFwiXCIgfSxcbiAgICAgIHtcbiAgICAgICAgYWN0aW9uOiBcInJlc2V0LWVsb1wiLFxuICAgICAgICB0aXRsZTogXCJSZXNldCBFTE9cIixcbiAgICAgICAgaGludDogXCJTdGFydCBldmVyeSBzY2VuZSdzIEVMTyBvdmVyLCBmcm9tIGl0cyBTdGFzaCByYXRpbmcgb3IgYXQgMTUwMFwiLFxuICAgICAgICBidXR0b246IFwiUmVzZXQgRUxP4oCmXCIsXG4gICAgICB9LFxuICAgIF0sXG4gIH0sXG4gIHtcbiAgICB0aXRsZTogXCJCYXR0bGVzXCIsXG4gICAgcm93czogW1xuICAgICAgeyBrZXk6IFwiZmlsdGVyT3Bwb25lbnRzXCIsIHRpdGxlOiBcIlVzZSBmaWx0ZXJlZCBzY2VuZXMgZm9yIGJvdGggc2lkZXNcIiwgaGludDogXCJPcHBvbmVudHMgYWxzbyBjb21lIGZyb20gdGhlIGN1cnJlbnQgc2NlbmUgbGlzdCBmaWx0ZXIgaW5zdGVhZCBvZiB5b3VyIHdob2xlIHJhdGVkIGxpYnJhcnlcIiB9LFxuICAgICAgeyBrZXk6IFwicGxhY2VtZW50RnJvbUJvdHRvbVwiLCB0aXRsZTogXCJQbGFjZW1lbnQ6IHN0YXJ0IGZyb20gdGhlIGJvdHRvbVwiLCBoaW50OiBcIlBsYWNlbWVudCBpZ25vcmVzIHRoZSBzY2VuZSdzIGN1cnJlbnQgRUxPOiBpdCBzdGFydHMgYWdhaW5zdCB0aGUgYm90dG9tIHNjZW5lIGFuZCBjbGltYnMsIGp1bXBpbmcgZnVydGhlciB3aXRoIGVhY2ggd2luICh0aGlzIHJlcGxhY2VzIEdhdW50bGV0KVwiIH0sXG4gICAgXSxcbiAgfSxcbiAge1xuICAgIHRpdGxlOiBcIlNjZW5lc1wiLFxuICAgIHJvd3M6IFtcbiAgICAgIHsga2V5OiBcImF1dG9wbGF5UHJldmlld3NcIiwgdGl0bGU6IFwiQXV0b3BsYXkgcHJldmlld3NcIiwgaGludDogXCJMb29wIGJvdGggcHJldmlld3Mgc2lsZW50bHk7IGhvdmVyIGEgY2FyZCB0byBoZWFyIGl0XCIgfSxcbiAgICAgIHsga2V5OiBcInBhdXNlTWVkaWFPbk9wZW5cIiwgdGl0bGU6IFwiUGF1c2UgcGxheWluZyB2aWRlbyB3aGVuIFN0YXNoIEJhdHRsZSBvcGVuc1wiLCBoaW50OiBcIlN0b3BzIHRoZSBzY2VuZSB5b3UncmUgd2F0Y2hpbmcgc28gaXRzIGF1ZGlvIGRvZXNuJ3Qgb3ZlcmxhcCB0aGUgYmF0dGxlIHByZXZpZXdzXCIgfSxcbiAgICAgIHsga2V5OiBcInNob3dUaWVyc1wiLCB0aXRsZTogXCJTaG93IHRpZXJzIG9uIGNhcmRzXCIsIGhpbnQ6IFwiQSB0aWVyIG5leHQgdG8gZWFjaCBzY2VuZSdzIEVMTywgZnJvbSDwn5GRIExlZ2VuZGFyeSAodG9wIDElKSBkb3duIHRvIPCfpYkgQnJvbnplLCBieSBpdHMgcmFuayBhbW9uZyB5b3VyIHNjZW5lcyB3aXRoIGEgc2V0dGxlZCBFTE9cIiB9LFxuICAgICAgeyBrZXk6IFwib3BlbkluTmV3VGFiXCIsIHRpdGxlOiBcIk9wZW4gc2NlbmVzIGluIGEgbmV3IHRhYlwiLCBoaW50OiBcIkNsaWNraW5nIGEgdGh1bWJuYWlsIG9wZW5zIHRoZSBzY2VuZSBpbiBhIG5ldyBicm93c2VyIHRhYlwiIH0sXG4gICAgICB7IGtleTogXCJjbGVhbk1vZGVcIiwgdGl0bGU6IFwiQ2xlYW4gbW9kZVwiLCBoaW50OiBcIlNob3cgYSDwn5eRIGJ1dHRvbiBvbiBlYWNoIGNhcmQgdG8gZGVsZXRlIHRoZSBzY2VuZSBmcm9tIFN0YXNoXCIgfSxcbiAgICBdLFxuICB9LFxuXTtcblxuLyoqIFZvbHVtZSByZXN0b3JlZCB3aGVuIHVubXV0aW5nIGZyb20gMCB3aXRoIG5vIGVhcmxpZXIgbGV2ZWwgdGhpcyBzZXNzaW9uLiAqL1xuY29uc3QgREVGQVVMVF9VTk1VVEVfVk9MVU1FID0gNTA7XG5sZXQgdm9sdW1lQmVmb3JlTXV0ZTogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG5cbmxldCBhY3RpdmVUYWI6IFRhYklkID0gXCJiYXR0bGVcIjtcblxuZXhwb3J0IGZ1bmN0aW9uIGdldEFjdGl2ZVRhYigpOiBUYWJJZCB7XG4gIHJldHVybiBhY3RpdmVUYWI7XG59XG5cbmZ1bmN0aW9uIHZvbHVtZUljb24odm9sdW1lOiBudW1iZXIpOiBzdHJpbmcge1xuICBpZiAodm9sdW1lID09PSAwKSByZXR1cm4gXCLwn5SHXCI7XG4gIHJldHVybiB2b2x1bWUgPCA1MCA/IFwi8J+UiVwiIDogXCLwn5SKXCI7XG59XG5cbmZ1bmN0aW9uIHNldHRpbmdDb250cm9sKGtleToga2V5b2YgU2V0dGluZ3MpOiBzdHJpbmcge1xuICBpZiAoa2V5ID09PSBcInN0YXNoUmF0aW5nc1wiKSB7XG4gICAgY29uc3Qgb3B0aW9ucyA9IFNUQVNIX1JBVElOR1NfT1BUSU9OUy5tYXAoXG4gICAgICAoeyB2YWx1ZSwgbGFiZWwgfSkgPT5cbiAgICAgICAgYDxvcHRpb24gdmFsdWU9XCIke3ZhbHVlfVwiICR7dmFsdWUgPT09IHN0YXRlLnNldHRpbmdzLnN0YXNoUmF0aW5ncyA/IFwic2VsZWN0ZWRcIiA6IFwiXCJ9PiR7bGFiZWx9PC9vcHRpb24+YCxcbiAgICApLmpvaW4oXCJcIik7XG4gICAgcmV0dXJuIGA8c2VsZWN0IGRhdGEtc2V0dGluZz1cIiR7a2V5fVwiIGNsYXNzPVwiZm9ybS1jb250cm9sIGZvcm0tY29udHJvbC1zbSBzYi1zZXR0aW5nLXNlbGVjdFwiIGFyaWEtbGFiZWw9XCJTdGFzaCByYXRpbmdzIHVwZGF0ZSBtb2RlXCI+JHtvcHRpb25zfTwvc2VsZWN0PmA7XG4gIH1cbiAgY29uc3QgaWQgPSBgc2Itc2V0dGluZy0ke2tleX1gO1xuICByZXR1cm4gYFxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJjdXN0b20tY29udHJvbCBjdXN0b20tc3dpdGNoXCI+XG4gICAgICAgICAgICA8aW5wdXQgdHlwZT1cImNoZWNrYm94XCIgY2xhc3M9XCJjdXN0b20tY29udHJvbC1pbnB1dFwiIGlkPVwiJHtpZH1cIiBkYXRhLXNldHRpbmc9XCIke2tleX1cIiAke3N0YXRlLnNldHRpbmdzW2tleSBhcyBCb29sS2V5XSA/IFwiY2hlY2tlZFwiIDogXCJcIn0+XG4gICAgICAgICAgICA8bGFiZWwgY2xhc3M9XCJjdXN0b20tY29udHJvbC1sYWJlbFwiIGZvcj1cIiR7aWR9XCI+PC9sYWJlbD5cbiAgICAgICAgICA8L2Rpdj5gO1xufVxuXG4vKiogVGFiIGJhcjogQmF0dGxlIC8gU2V0dGluZ3Mgb24gdGhlIGxlZnQsIHByZXZpZXcgdm9sdW1lIG9uIHRoZSByaWdodC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVUYWJCYXIoKTogc3RyaW5nIHtcbiAgY29uc3QgeyBwcmV2aWV3Vm9sdW1lIH0gPSBzdGF0ZS5zZXR0aW5ncztcbiAgcmV0dXJuIGBcbiAgICAgIDxkaXYgY2xhc3M9XCJzYi10YWItYmFyXCI+XG4gICAgICAgIDxuYXYgY2xhc3M9XCJuYXYgbmF2LXRhYnMgc2ItdGFic1wiIHJvbGU9XCJ0YWJsaXN0XCI+XG4gICAgICAgICAgPGEgY2xhc3M9XCJuYXYtaXRlbSBuYXYtbGluayBhY3RpdmVcIiByb2xlPVwidGFiXCIgZGF0YS10YWI9XCJiYXR0bGVcIiBhcmlhLXNlbGVjdGVkPVwidHJ1ZVwiPuKalO+4jyBCYXR0bGU8L2E+XG4gICAgICAgICAgPGEgY2xhc3M9XCJuYXYtaXRlbSBuYXYtbGlua1wiIHJvbGU9XCJ0YWJcIiBkYXRhLXRhYj1cInNldHRpbmdzXCIgYXJpYS1zZWxlY3RlZD1cImZhbHNlXCI+4pqZIFNldHRpbmdzPC9hPlxuICAgICAgICA8L25hdj5cbiAgICAgICAgPGRpdiBjbGFzcz1cInNiLXZvbHVtZVwiIHRpdGxlPVwiUHJldmlldyB2b2x1bWVcIj5cbiAgICAgICAgICA8YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cInNiLXZvbHVtZS1pY29uXCIgYXJpYS1sYWJlbD1cIk11dGUgcHJldmlld3NcIj4ke3ZvbHVtZUljb24ocHJldmlld1ZvbHVtZSl9PC9idXR0b24+XG4gICAgICAgICAgPGlucHV0IHR5cGU9XCJyYW5nZVwiIG1pbj1cIjBcIiBtYXg9XCIxMDBcIiBzdGVwPVwiMVwiIGRhdGEtc2V0dGluZz1cInByZXZpZXdWb2x1bWVcIiB2YWx1ZT1cIiR7cHJldmlld1ZvbHVtZX1cIiBhcmlhLWxhYmVsPVwiUHJldmlldyB2b2x1bWVcIj5cbiAgICAgICAgICA8c3BhbiBjbGFzcz1cInNiLXZvbHVtZS12YWx1ZVwiPiR7cHJldmlld1ZvbHVtZX08L3NwYW4+XG4gICAgICAgIDwvZGl2PlxuICAgICAgPC9kaXY+XG4gICAgYDtcbn1cblxuZnVuY3Rpb24gc2V0dGluZ1Jvd0h0bWwocm93OiBTZXR0aW5nUm93KTogc3RyaW5nIHtcbiAgY29uc3QgaGludCA9IFwia2V5XCIgaW4gcm93ICYmIHJvdy5rZXkgPT09IFwic3Rhc2hSYXRpbmdzXCIgPyBzdGFzaFJhdGluZ3NPcHRpb24oc3RhdGUuc2V0dGluZ3Muc3Rhc2hSYXRpbmdzKS5kZXNjIDogcm93LmhpbnQ7XG4gIGNvbnN0IGhpbnRGb3IgPSBcImtleVwiIGluIHJvdyA/IGAgZGF0YS1oaW50LWZvcj1cIiR7cm93LmtleX1cImAgOiBcIlwiO1xuICBjb25zdCBjb250cm9sID1cbiAgICBcImtleVwiIGluIHJvd1xuICAgICAgPyBzZXR0aW5nQ29udHJvbChyb3cua2V5KVxuICAgICAgOiBgPGJ1dHRvbiB0eXBlPVwiYnV0dG9uXCIgY2xhc3M9XCJidG4gYnRuLXNlY29uZGFyeSBidG4tc21cIiBkYXRhLWFjdGlvbj1cIiR7cm93LmFjdGlvbn1cIj4ke3Jvdy5idXR0b259PC9idXR0b24+YDtcbiAgcmV0dXJuIGBcbiAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzZXR0aW5nXCI+XG4gICAgICAgICAgICAgIDxkaXY+XG4gICAgICAgICAgICAgICAgPGgzPiR7cm93LnRpdGxlfTwvaDM+XG4gICAgICAgICAgICAgICAgPGRpdiBjbGFzcz1cInN1Yi1oZWFkaW5nXCIke2hpbnRGb3J9PiR7aGludH08L2Rpdj5cbiAgICAgICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgICAgIDxkaXY+JHtjb250cm9sfTwvZGl2PlxuICAgICAgICAgICAgPC9kaXY+YDtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVNldHRpbmdzVGFiKCk6IHN0cmluZyB7XG4gIGNvbnN0IHNlY3Rpb25zID0gU0VDVElPTlMubWFwKFxuICAgICh7IHRpdGxlLCByb3dzIH0pID0+IGBcbiAgICAgICAgPGRpdiBjbGFzcz1cInNldHRpbmctc2VjdGlvblwiPlxuICAgICAgICAgIDxoMT4ke3RpdGxlfTwvaDE+XG4gICAgICAgICAgPGRpdiBjbGFzcz1cImNhcmRcIj5cbiAgICAgICAgICAgICR7cm93cy5tYXAoc2V0dGluZ1Jvd0h0bWwpLmpvaW4oXCJcIil9XG4gICAgICAgICAgPC9kaXY+XG4gICAgICAgIDwvZGl2PmAsXG4gICkuam9pbihcIlwiKTtcblxuICByZXR1cm4gYFxuICAgICAgPGRpdiBjbGFzcz1cInNiLXRhYi1wYW5lbCBzYi1zZXR0aW5ncy10YWJcIiBkYXRhLXBhbmVsPVwic2V0dGluZ3NcIiBoaWRkZW4+XG4gICAgICAgICR7c2VjdGlvbnN9XG4gICAgICAgIDxwIGNsYXNzPVwic2Itc2V0dGluZ3Mtbm90ZVwiPlNhdmVzIHRvIFN0YXNoLCBhbHNvIHVuZGVyIFNldHRpbmdzIOKGkiBQbHVnaW5zLjwvcD5cbiAgICAgIDwvZGl2PlxuICAgIGA7XG59XG5cbi8qKiBQdXNoIHN0YXRlLnNldHRpbmdzIGludG8gdGhlIHJlbmRlcmVkIGNvbnRyb2xzIChlLmcuIGFmdGVyIHJlLWZldGNoaW5nIHNldHRpbmdzIG9uIHJlb3BlbikuICovXG5leHBvcnQgZnVuY3Rpb24gc3luY1NldHRpbmdzQ29udHJvbHMocm9vdDogUGFyZW50Tm9kZSk6IHZvaWQge1xuICByb290LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTElucHV0RWxlbWVudD4oXCJpbnB1dFtkYXRhLXNldHRpbmddXCIpLmZvckVhY2goKGlucHV0KSA9PiB7XG4gICAgY29uc3Qga2V5ID0gaW5wdXQuZGF0YXNldC5zZXR0aW5nIGFzIGtleW9mIFNldHRpbmdzO1xuICAgIGNvbnN0IHZhbHVlID0gc3RhdGUuc2V0dGluZ3Nba2V5XTtcbiAgICBpZiAoaW5wdXQudHlwZSA9PT0gXCJjaGVja2JveFwiKSBpbnB1dC5jaGVja2VkID0gQm9vbGVhbih2YWx1ZSk7XG4gICAgZWxzZSBpbnB1dC52YWx1ZSA9IFN0cmluZyh2YWx1ZSk7XG4gIH0pO1xuICByb290LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTFNlbGVjdEVsZW1lbnQ+KFwic2VsZWN0W2RhdGEtc2V0dGluZ11cIikuZm9yRWFjaCgoc2VsZWN0KSA9PiB7XG4gICAgc2VsZWN0LnZhbHVlID0gU3RyaW5nKHN0YXRlLnNldHRpbmdzW3NlbGVjdC5kYXRhc2V0LnNldHRpbmcgYXMga2V5b2YgU2V0dGluZ3NdKTtcbiAgfSk7XG4gIHJvb3QucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oJ1tkYXRhLWhpbnQtZm9yPVwic3Rhc2hSYXRpbmdzXCJdJykuZm9yRWFjaCgoaGludCkgPT4ge1xuICAgIGhpbnQudGV4dENvbnRlbnQgPSBzdGFzaFJhdGluZ3NPcHRpb24oc3RhdGUuc2V0dGluZ3Muc3Rhc2hSYXRpbmdzKS5kZXNjO1xuICB9KTtcbiAgY29uc3Qgdm9sdW1lID0gc3RhdGUuc2V0dGluZ3MucHJldmlld1ZvbHVtZTtcbiAgcm9vdC5xdWVyeVNlbGVjdG9yQWxsKFwiLnNiLXZvbHVtZS1pY29uXCIpLmZvckVhY2goKGVsKSA9PiB7XG4gICAgZWwudGV4dENvbnRlbnQgPSB2b2x1bWVJY29uKHZvbHVtZSk7XG4gICAgZWwuc2V0QXR0cmlidXRlKFwiYXJpYS1sYWJlbFwiLCB2b2x1bWUgPT09IDAgPyBcIlVubXV0ZSBwcmV2aWV3c1wiIDogXCJNdXRlIHByZXZpZXdzXCIpO1xuICB9KTtcbiAgcm9vdC5xdWVyeVNlbGVjdG9yQWxsKFwiLnNiLXZvbHVtZS12YWx1ZVwiKS5mb3JFYWNoKChlbCkgPT4gKGVsLnRleHRDb250ZW50ID0gU3RyaW5nKHZvbHVtZSkpKTtcbn1cblxuLyoqIFNob3cgYSB0YWIuIFBhbmVscyBhcmUgc3dhcHBlZCBpbiBwbGFjZSwgc28gbm90aGluZyBhYm92ZSB0aGUgdGFiIGJhciBtb3Zlcy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzaG93VGFiKHJvb3Q6IFBhcmVudE5vZGUsIHRhYjogVGFiSWQpOiB2b2lkIHtcbiAgYWN0aXZlVGFiID0gdGFiO1xuICByb290LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KFwiLnNiLXRhYnMgLm5hdi1saW5rXCIpLmZvckVhY2goKGxpbmspID0+IHtcbiAgICBjb25zdCBvbiA9IGxpbmsuZGF0YXNldC50YWIgPT09IHRhYjtcbiAgICBsaW5rLmNsYXNzTGlzdC50b2dnbGUoXCJhY3RpdmVcIiwgb24pO1xuICAgIGxpbmsuc2V0QXR0cmlidXRlKFwiYXJpYS1zZWxlY3RlZFwiLCBTdHJpbmcob24pKTtcbiAgfSk7XG4gIHJvb3QucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oXCIuc2ItdGFiLXBhbmVsXCIpLmZvckVhY2goKHBhbmVsKSA9PiB7XG4gICAgcGFuZWwuaGlkZGVuID0gcGFuZWwuZGF0YXNldC5wYW5lbCAhPT0gdGFiO1xuICB9KTtcbn1cblxuLyoqXG4gKiBXaXJlIGV2ZXJ5IGRhdGEtc2V0dGluZyBjb250cm9sLCB0aGUgdGFicyBhbmQgdGhlIG11dGUgYnV0dG9uLlxuICogb25DaGFuZ2UgcnVucyBhZnRlciBhIHZhbHVlIGlzIHN0b3JlZDsgb25UYWJDaGFuZ2UgYWZ0ZXIgYSB0YWIgc3dpdGNoLiBBIGRyb3Bkb3duIGNoYW5nZVxuICogZmlyc3QgYXdhaXRzIGJlZm9yZUNoYW5nZSAoYSB3YXJuaW5nLCBzYXkpOiBmYWxzZSBwdXRzIHRoZSBkcm9wZG93biBiYWNrIGFuZCBzdG9yZXMgbm90aGluZy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJpbmRTZXR0aW5nc0NvbnRyb2xzKFxuICByb290OiBQYXJlbnROb2RlLFxuICBvbkNoYW5nZTogKGtleToga2V5b2YgU2V0dGluZ3MpID0+IHZvaWQsXG4gIG9uVGFiQ2hhbmdlOiAodGFiOiBUYWJJZCkgPT4gdm9pZCxcbiAgYmVmb3JlQ2hhbmdlOiAoa2V5OiBrZXlvZiBTZXR0aW5ncywgdmFsdWU6IHN0cmluZykgPT4gUHJvbWlzZTxib29sZWFuPiA9IGFzeW5jICgpID0+IHRydWUsXG4pOiB2b2lkIHtcbiAgY29uc3QgYXBwbHkgPSAocGF0Y2g6IFBhcnRpYWw8U2V0dGluZ3M+LCBrZXk6IGtleW9mIFNldHRpbmdzKTogdm9pZCA9PiB7XG4gICAgdXBkYXRlU2V0dGluZ3MocGF0Y2gpO1xuICAgIHN5bmNTZXR0aW5nc0NvbnRyb2xzKHJvb3QpO1xuICAgIG9uQ2hhbmdlKGtleSk7XG4gIH07XG5cbiAgcm9vdC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxJbnB1dEVsZW1lbnQ+KFwiaW5wdXRbZGF0YS1zZXR0aW5nXVwiKS5mb3JFYWNoKChpbnB1dCkgPT4ge1xuICAgIGNvbnN0IGtleSA9IGlucHV0LmRhdGFzZXQuc2V0dGluZyBhcyBrZXlvZiBTZXR0aW5ncztcbiAgICAvLyBSYW5nZSB1cGRhdGVzIGxpdmUgd2hpbGUgZHJhZ2dpbmc7IG90aGVycyBvbiBjb21taXRcbiAgICBjb25zdCBldmVudE5hbWUgPSBpbnB1dC50eXBlID09PSBcInJhbmdlXCIgPyBcImlucHV0XCIgOiBcImNoYW5nZVwiO1xuICAgIGlucHV0LmFkZEV2ZW50TGlzdGVuZXIoZXZlbnROYW1lLCAoKSA9PiB7XG4gICAgICBjb25zdCB2YWx1ZSA9IGlucHV0LnR5cGUgPT09IFwiY2hlY2tib3hcIiA/IGlucHV0LmNoZWNrZWQgOiBOdW1iZXIoaW5wdXQudmFsdWUpO1xuICAgICAgYXBwbHkoeyBba2V5XTogdmFsdWUgfSBhcyBQYXJ0aWFsPFNldHRpbmdzPiwga2V5KTtcbiAgICB9KTtcbiAgfSk7XG5cbiAgcm9vdC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxTZWxlY3RFbGVtZW50PihcInNlbGVjdFtkYXRhLXNldHRpbmddXCIpLmZvckVhY2goKHNlbGVjdCkgPT4ge1xuICAgIGNvbnN0IGtleSA9IHNlbGVjdC5kYXRhc2V0LnNldHRpbmcgYXMga2V5b2YgU2V0dGluZ3M7XG4gICAgc2VsZWN0LmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgdmFsdWUgPSBzZWxlY3QudmFsdWU7XG4gICAgICBzZWxlY3QuZGlzYWJsZWQgPSB0cnVlO1xuICAgICAgdHJ5IHtcbiAgICAgICAgaWYgKGF3YWl0IGJlZm9yZUNoYW5nZShrZXksIHZhbHVlKSkgYXBwbHkoeyBba2V5XTogdmFsdWUgYXMgU3Rhc2hSYXRpbmdzTW9kZSB9IGFzIFBhcnRpYWw8U2V0dGluZ3M+LCBrZXkpO1xuICAgICAgICBlbHNlIHN5bmNTZXR0aW5nc0NvbnRyb2xzKHJvb3QpO1xuICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgc2VsZWN0LmRpc2FibGVkID0gZmFsc2U7XG4gICAgICB9XG4gICAgfSk7XG4gIH0pO1xuXG4gIC8vIFNwZWFrZXIgaWNvbjogbXV0ZSwgb3IgcmVzdG9yZSB0aGUgbGV2ZWwgZnJvbSBiZWZvcmUgbXV0aW5nXG4gIHJvb3QucXVlcnlTZWxlY3RvckFsbDxIVE1MQnV0dG9uRWxlbWVudD4oXCIuc2Itdm9sdW1lLWljb25cIikuZm9yRWFjaCgoYnRuKSA9PiB7XG4gICAgYnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiB7XG4gICAgICBjb25zdCBjdXJyZW50ID0gc3RhdGUuc2V0dGluZ3MucHJldmlld1ZvbHVtZTtcbiAgICAgIGlmIChjdXJyZW50ID4gMCkge1xuICAgICAgICB2b2x1bWVCZWZvcmVNdXRlID0gY3VycmVudDtcbiAgICAgICAgYXBwbHkoeyBwcmV2aWV3Vm9sdW1lOiAwIH0sIFwicHJldmlld1ZvbHVtZVwiKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGFwcGx5KHsgcHJldmlld1ZvbHVtZTogdm9sdW1lQmVmb3JlTXV0ZSA/PyBERUZBVUxUX1VOTVVURV9WT0xVTUUgfSwgXCJwcmV2aWV3Vm9sdW1lXCIpO1xuICAgICAgfVxuICAgIH0pO1xuICB9KTtcblxuICByb290LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KFwiLnNiLXRhYnMgLm5hdi1saW5rXCIpLmZvckVhY2goKGxpbmspID0+IHtcbiAgICBsaW5rLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiB7XG4gICAgICBjb25zdCB0YWIgPSBsaW5rLmRhdGFzZXQudGFiIGFzIFRhYklkO1xuICAgICAgaWYgKHRhYiA9PT0gYWN0aXZlVGFiKSByZXR1cm47XG4gICAgICBzaG93VGFiKHJvb3QsIHRhYik7XG4gICAgICBvblRhYkNoYW5nZSh0YWIpO1xuICAgIH0pO1xuICB9KTtcbn1cbiIsICIvLyBDb3JlIGNvbXBhcmlzb24gVUk6IGxheW91dCwgcGFpciByZW5kZXJpbmcsIGNob2ljZSBoYW5kbGluZywgYW5pbWF0aW9ucy5cblxuaW1wb3J0IHsgY2xlYXJGaWx0ZXJlZENhY2hlLCBsYXRlc3RTY2VuZSwgcmVmcmVzaFNjZW5lSW5DYWNoZSwgcmVtb3ZlU2NlbmVFdmVyeXdoZXJlIH0gZnJvbSBcIi4uL2NhY2hlXCI7XG5pbXBvcnQgeyBDSEFNUElPTl9VTlJBVEVEX0VMTywgQ0xJTUJfU01BTExfUE9PTF9XQVJOX0FULCBVUFNFVF9NQVhfQ0hBTkNFIH0gZnJvbSBcIi4uL2NvbnN0YW50c1wiO1xuaW1wb3J0IHsgZWxvUmVzdWx0LCB3aW5DaGFuY2VzIH0gZnJvbSBcIi4uL2Vsb1wiO1xuaW1wb3J0IHsgcmVhZEZpbHRlcnMgfSBmcm9tIFwiLi4vZmlsdGVyc1wiO1xuaW1wb3J0IHsgZmV0Y2hTY2VuZUJ5SWQgfSBmcm9tIFwiLi4vZ3JhcGhxbFwiO1xuaW1wb3J0IHsgbmF2aWdhdGVUb1VybCB9IGZyb20gXCIuLi9uYXZpZ2F0aW9uXCI7XG5pbXBvcnQge1xuICBmZXRjaENoYW1waW9uUGFpcixcbiAgZmV0Y2hQbGFjZW1lbnRQYWlyLFxuICBmZXRjaFN3aXNzUGFpcixcbiAgcGFpclJhbmtzLFxufSBmcm9tIFwiLi4vcGFpcnNcIjtcbmltcG9ydCB7IHJlY29yZFBsYWNlbWVudFJlc3VsdCB9IGZyb20gXCIuLi9wbGFjZW1lbnRcIjtcbmltcG9ydCB7IHdyaXRlRWxvIH0gZnJvbSBcIi4uL3JhdGluZ1wiO1xuaW1wb3J0IHsgZmV0Y2hTY2VuZUZpZWxkcyB9IGZyb20gXCIuLi9zY2VuZUFjdGlvbnNcIjtcbmltcG9ydCB7IGJhdHRsZXMsIGVmZmVjdGl2ZUVsbywga0dhbWVzIH0gZnJvbSBcIi4uL3Njb3JlXCI7XG5pbXBvcnQgeyBpc0Vsb1NldHVwUGVuZGluZywgaXNSdW5BY3RpdmUsIHJlc2V0UnVuU3RhdGUsIHJlc2V0U2h1ZmZsZSwgc3RhdGUgfSBmcm9tIFwiLi4vc3RhdGVcIjtcbmltcG9ydCB7IHRpZXJNYXAgfSBmcm9tIFwiLi4vc3RhdHNcIjtcbmltcG9ydCB7IHNhdmVTdGF0ZSB9IGZyb20gXCIuLi9zdG9yYWdlXCI7XG5pbXBvcnQgdHlwZSB7IE1vZGUsIFJhbmssIFNjZW5lLCBUaWVyIH0gZnJvbSBcIi4uL3R5cGVzXCI7XG5pbXBvcnQgeyBjb25maXJtRGVsZXRlU2NlbmUgfSBmcm9tIFwiLi9kZWxldGVEaWFsb2dcIjtcbmltcG9ydCB7IGNyZWF0ZVNjZW5lQ2FyZCB9IGZyb20gXCIuL3NjZW5lQ2FyZFwiO1xuaW1wb3J0IHsgc2hvd1BsYWNlbWVudFNjcmVlbiwgc2hvd1ZpY3RvcnlTY3JlZW4gfSBmcm9tIFwiLi9zY3JlZW5zXCI7XG5pbXBvcnQgeyBjcmVhdGVTZXR0aW5nc1RhYiwgY3JlYXRlVGFiQmFyLCBnZXRBY3RpdmVUYWIgfSBmcm9tIFwiLi9zZXR0aW5nc1BhbmVsXCI7XG5cbmNvbnN0IE1PREVTOiB7IG1vZGU6IE1vZGU7IGljb246IHN0cmluZzsgdGl0bGU6IHN0cmluZzsgZGVzYzogc3RyaW5nOyB0aXA6IHN0cmluZyB9W10gPSBbXG4gIHtcbiAgICBtb2RlOiBcInN3aXNzXCIsXG4gICAgaWNvbjogXCLimpbvuI9cIixcbiAgICB0aXRsZTogXCJTd2lzc1wiLFxuICAgIGRlc2M6IFwiRmFpciBtYXRjaHVwc1wiLFxuICAgIHRpcDogXCJFYWNoIHNjZW5lIGZhY2VzIGFuIG9wcG9uZW50IHdpdGggYSBzaW1pbGFyIEVMTy4gQm90aCBzY2VuZXMnIEVMTyBjaGFuZ2VzIGFmdGVyIGV2ZXJ5IHBpY2ssIGFuZCBldmVyeSBzY2VuZSBzdGF5cyBpbiB0aGUgcm90YXRpb24uXCIsXG4gIH0sXG4gIHtcbiAgICBtb2RlOiBcInBsYWNlbWVudFwiLFxuICAgIGljb246IFwi8J+TjVwiLFxuICAgIHRpdGxlOiBcIlBsYWNlbWVudFwiLFxuICAgIGRlc2M6IFwiUGxhY2UgYSBzY2VuZVwiLFxuICAgIHRpcDogXCJGaW5kcyB3aGVyZSBvbmUgc2NlbmUgYmVsb25ncy4gRWFjaCBwaWNrIG5hcnJvd3MgdGhlIHJhbmdlIG9mIHJhbmtzIGl0IGNvdWxkIGxhbmQgaW4gKHNob3duIG9uIGl0cyBjYXJkKSB1bnRpbCBpdHMgc3BvdCBpcyBmb3VuZCwgYWJvdXQgMTAgcGlja3MgZm9yIGFuIHVucmF0ZWQgc2NlbmUuXFxuXFxuTG9va2luZyBmb3IgR2F1bnRsZXQ/IFR1cm4gb24g4oCcUGxhY2VtZW50OiBzdGFydCBmcm9tIHRoZSBib3R0b23igJ0gaW4gU2V0dGluZ3MgdG8gbWFrZSBhIHNjZW5lIGNsaW1iIHRoZSBsYWRkZXIgZnJvbSB0aGUgYm90dG9tLlwiLFxuICB9LFxuICB7XG4gICAgbW9kZTogXCJjaGFtcGlvblwiLFxuICAgIGljb246IFwi8J+PhlwiLFxuICAgIHRpdGxlOiBcIkNoYW1waW9uXCIsXG4gICAgZGVzYzogXCJXaW5uZXIgc3RheXMgb25cIixcbiAgICB0aXA6IFwiV2lubmVyIHN0YXlzIG9uOiB0aGUgc2NlbmUgeW91IHBpY2sga2VlcHMgZGVmZW5kaW5nIGFnYWluc3QgbmV3IGNoYWxsZW5nZXJzIHVudGlsIGl0J3MgYmVhdGVuLCB0aGVuIHRoZSB3aW5uZXIgdGFrZXMgb3Zlci4gQm90aCBzY2VuZXMnIEVMTyBjaGFuZ2VzIGFmdGVyIGV2ZXJ5IHBpY2suXCIsXG4gIH0sXG5dO1xuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlTWFpblVJKCk6IHN0cmluZyB7XG4gIGNvbnN0IG1vZGVCdXR0b25zID0gTU9ERVMubWFwKFxuICAgICh7IG1vZGUsIGljb24sIHRpdGxlLCBkZXNjLCB0aXAgfSkgPT4gYFxuICAgICAgICAgICAgPGJ1dHRvbiBjbGFzcz1cInNiLW1vZGUtYnRuICR7c3RhdGUuY3VycmVudE1vZGUgPT09IG1vZGUgPyBcImFjdGl2ZVwiIDogXCJcIn1cIiBkYXRhLW1vZGU9XCIke21vZGV9XCIgZGF0YS10aXA9XCIke3RpcH1cIiBhcmlhLWRlc2NyaXB0aW9uPVwiJHt0aXB9XCI+XG4gICAgICAgICAgICAgIDxzcGFuIGNsYXNzPVwic2ItbW9kZS1pY29uXCI+JHtpY29ufTwvc3Bhbj5cbiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9XCJzYi1tb2RlLXRpdGxlXCI+JHt0aXRsZX08L3NwYW4+XG4gICAgICAgICAgICAgIDxzcGFuIGNsYXNzPVwic2ItbW9kZS1kZXNjXCI+JHtkZXNjfTwvc3Bhbj5cbiAgICAgICAgICAgIDwvYnV0dG9uPmAsXG4gICkuam9pbihcIlwiKTtcblxuICByZXR1cm4gYFxuICAgICAgPGRpdiBpZD1cInN0YXNoLWJhdHRsZS1jb250YWluZXJcIiBjbGFzcz1cInNiLWNvbnRhaW5lclwiPlxuICAgICAgICA8ZGl2IGNsYXNzPVwic2ItaGVhZGVyXCI+XG4gICAgICAgICAgPGgxIGNsYXNzPVwic2ItdGl0bGVcIj7impTvuI8gU3Rhc2ggQmF0dGxlPC9oMT5cbiAgICAgICAgICAke2NyZWF0ZVRhYkJhcigpfVxuICAgICAgICA8L2Rpdj5cblxuICAgICAgICA8ZGl2IGNsYXNzPVwic2ItdGFiLXBhbmVsXCIgZGF0YS1wYW5lbD1cImJhdHRsZVwiPlxuICAgICAgICAgIDxkaXYgaWQ9XCJzYi1zZXR1cC1hcmVhXCIgY2xhc3M9XCJzYi1zZXR1cC1hcmVhXCIgaGlkZGVuPjwvZGl2PlxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1tb2RlLXJvd1wiPlxuICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNiLW1vZGUtdG9nZ2xlXCI+JHttb2RlQnV0dG9uc31cbiAgICAgICAgICAgIDwvZGl2PlxuICAgICAgICAgICAgPGJ1dHRvbiB0eXBlPVwiYnV0dG9uXCIgY2xhc3M9XCJzYi1tb2RlLWluZm8tYnRuXCIgYXJpYS1jb250cm9scz1cInNiLW1vZGUtaW5mb1wiIGFyaWEtZXhwYW5kZWQ9XCJmYWxzZVwiIGFyaWEtbGFiZWw9XCJXaGF0IGRvZXMgdGhpcyBtb2RlIGRvP1wiPuKTmDwvYnV0dG9uPlxuICAgICAgICAgIDwvZGl2PlxuICAgICAgICAgIDxwIGlkPVwic2ItbW9kZS1pbmZvXCIgY2xhc3M9XCJzYi1tb2RlLWluZm9cIiBoaWRkZW4+PC9wPlxuXG4gICAgICAgICAgPHAgaWQ9XCJzYi1jbGltYi1wb29sLXdhcm5pbmdcIiBjbGFzcz1cInNiLWNsaW1iLXdhcm5pbmdcIiBoaWRkZW4+XG4gICAgICAgICAgICBDaGFtcGlvbiBjYW4gYmVoYXZlIG9kZGx5IHdpdGggc21hbGwgZmlsdGVyZWQgcG9vbHMgd2hlbiBib3RoIHNpZGVzIHVzZSB0aGUgZmlsdGVyXG4gICAgICAgICAgICAoZmV3ZXIgdGhhbiAke0NMSU1CX1NNQUxMX1BPT0xfV0FSTl9BVH0gc2NlbmVzKS4gVXNlIGEgbGFyZ2VyIGZpbHRlciwgb3IgdHVybiBvZmZcbiAgICAgICAgICAgIFwiVXNlIGZpbHRlcmVkIHNjZW5lcyBmb3IgYm90aCBzaWRlc1wiIGluIFNldHRpbmdzLlxuICAgICAgICAgIDwvcD5cblxuICAgICAgICAgIDxwIGlkPVwic2ItcG9vbC1zdGF0dXNcIiBjbGFzcz1cInNiLXBvb2wtc3RhdHVzXCIgaGlkZGVuPjwvcD5cbiAgICAgICAgICA8cCBpZD1cInNiLXJhdGluZ3Mtbm90ZVwiIGNsYXNzPVwic2ItcG9vbC1zdGF0dXMgc2ItcmF0aW5ncy1ub3RlXCIgaGlkZGVuPlxuICAgICAgICAgICAgU3Rhc2ggcmF0aW5ncyBhcmVuJ3QgYmVpbmcgY2hhbmdlZCDCtyA8YSBocmVmPVwiI1wiIGRhdGEtYWN0aW9uPVwib3Blbi1zZXR0aW5nc1wiPmNoYW5nZSBpbiBTZXR0aW5nczwvYT5cbiAgICAgICAgICA8L3A+XG5cbiAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItY29udGVudFwiPlxuICAgICAgICAgICAgPGRpdiBpZD1cInNiLWNvbXBhcmlzb24tYXJlYVwiIGNsYXNzPVwic2ItY29tcGFyaXNvbi1hcmVhXCI+XG4gICAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1sb2FkaW5nXCI+TG9hZGluZyBzY2VuZXMuLi48L2Rpdj5cbiAgICAgICAgICAgIDwvZGl2PlxuICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNiLWFjdGlvbnNcIj5cbiAgICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNiLWFjdGlvbi1idXR0b25zXCI+XG4gICAgICAgICAgICAgICAgPGJ1dHRvbiBpZD1cInNiLXNraXAtYnRuXCIgY2xhc3M9XCJidG4gYnRuLXNlY29uZGFyeVwiPlNraXA8L2J1dHRvbj5cbiAgICAgICAgICAgICAgICA8YnV0dG9uIGlkPVwic2ItcmVmcmVzaC1jYWNoZS1idG5cIiBjbGFzcz1cImJ0biBidG4tc2Vjb25kYXJ5XCIgdGl0bGU9XCJSZWZyZXNoIHNjZW5lIGxpc3QgZnJvbSBzZXJ2ZXIgKHVzZSBpZiB5b3UndmUgYWRkZWQgbmV3IHNjZW5lcylcIj7wn5SEIFJlZnJlc2g8L2J1dHRvbj5cbiAgICAgICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1rZXlib2FyZC1oaW50XCI+XG4gICAgICAgICAgICAgICAgPHNwYW4+4oaQPC9zcGFuPiBjaG9vc2UgbGVmdCDCt1xuICAgICAgICAgICAgICAgIDxzcGFuPuKGkjwvc3Bhbj4gY2hvb3NlIHJpZ2h0IMK3XG4gICAgICAgICAgICAgICAgPHNwYW4+U3BhY2U8L3NwYW4+IHNraXBcbiAgICAgICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgPC9kaXY+XG5cbiAgICAgICAgJHtjcmVhdGVTZXR0aW5nc1RhYigpfVxuICAgICAgPC9kaXY+XG4gICAgYDtcbn1cblxuLyoqIFRvdWNoIHNjcmVlbnMgaGF2ZSBubyBob3ZlciB0b29sdGlwczogdGhlIOKTmCBidXR0b24gc2hvd3MgdGhlIGN1cnJlbnQgbW9kZSdzIGV4cGxhbmF0aW9uIGhlcmUuICovXG5leHBvcnQgZnVuY3Rpb24gdXBkYXRlTW9kZUluZm8oKTogdm9pZCB7XG4gIGNvbnN0IGluZm8gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInNiLW1vZGUtaW5mb1wiKTtcbiAgY29uc3QgbW9kZSA9IE1PREVTLmZpbmQoKG0pID0+IG0ubW9kZSA9PT0gc3RhdGUuY3VycmVudE1vZGUpO1xuICBpZiAoaW5mbyAmJiBtb2RlKSBpbmZvLmlubmVySFRNTCA9IGA8c3Ryb25nPiR7bW9kZS5pY29ufSAke21vZGUudGl0bGV9Ojwvc3Ryb25nPiAke21vZGUudGlwLnJlcGxhY2UoL1xcbi9nLCBcIjxicj5cIil9YDtcbn1cblxuLyoqIEJhdHRsZSB0YWIgbm90ZSB3aGlsZSB0aGUgXCJTdGFzaCByYXRpbmdzXCIgc2V0dGluZyBpcyBcIkRvbid0IHVwZGF0ZVwiLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHVwZGF0ZVJhdGluZ3NOb3RlKCk6IHZvaWQge1xuICBjb25zdCBub3RlID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzYi1yYXRpbmdzLW5vdGVcIik7XG4gIGlmIChub3RlKSBub3RlLmhpZGRlbiA9IHN0YXRlLnNldHRpbmdzLnN0YXNoUmF0aW5ncyAhPT0gXCJvZmZcIjtcbn1cblxuLyoqIFwiV2hpY2ggc2NlbmVzIGFtIEkgcmF0aW5nP1wiIGxpbmUgYWJvdmUgdGhlIGNhcmRzOiB0aGUgU2NlbmVzIHBhZ2UgZmlsdGVyIG9yIHRoZSB3aG9sZSBsaWJyYXJ5LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHVwZGF0ZVBvb2xTdGF0dXMoKTogdm9pZCB7XG4gIGNvbnN0IHN0YXR1cyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic2ItcG9vbC1zdGF0dXNcIik7XG4gIGlmICghc3RhdHVzKSByZXR1cm47XG4gIGNvbnN0IGNvdW50ID0gc3RhdGUubGVmdFBvb2xTaXplO1xuICBjb25zdCBjb3VudEh0bWwgPVxuICAgIGNvdW50ID09PSBudWxsID8gXCJcIiA6IGAgwrcgPHN0cm9uZz4ke2NvdW50fSBzY2VuZSR7Y291bnQgPT09IDEgPyBcIlwiIDogXCJzXCJ9PC9zdHJvbmc+YDtcblxuICBpZiAocmVhZEZpbHRlcnMoKS5maWx0ZXJBY3RpdmUpIHtcbiAgICBjb25zdCBvcHBvbmVudHMgPSBzdGF0ZS5zZXR0aW5ncy5maWx0ZXJPcHBvbmVudHMgPyBcIiDCtyBvcHBvbmVudHMgZnJvbSB0aGUgZmlsdGVyIHRvb1wiIDogXCJcIjtcbiAgICBzdGF0dXMuaW5uZXJIVE1MID0gYFJhdGluZyBzY2VuZXMgZnJvbSB5b3VyIFNjZW5lcyBwYWdlIGZpbHRlciR7Y291bnRIdG1sfSR7b3Bwb25lbnRzfWA7XG4gIH0gZWxzZSB7XG4gICAgc3RhdHVzLmlubmVySFRNTCA9IGBSYXRpbmcgc2NlbmVzIGZyb20geW91ciB3aG9sZSBsaWJyYXJ5JHtjb3VudEh0bWx9PHNwYW4gY2xhc3M9XCJzYi1wb29sLWhpbnRcIj4gwrcgZmlsdGVyIHRoZSBTY2VuZXMgcGFnZSB0byBuYXJyb3cgaXQgZG93bjwvc3Bhbj5gO1xuICB9XG4gIHN0YXR1cy5oaWRkZW4gPSBmYWxzZTtcbn1cblxuLyoqIENhcmQgYmFkZ2U6IHRoZSB3aW4gc3RyZWFrIHdoaWxlIGNsaW1iaW5nIG9yIGRlZmVuZGluZywgb3IgUGxhY2VtZW50J3MgbmFycm93aW5nIHJhbmdlLiAqL1xuZnVuY3Rpb24gY2xpbWJTdGF0dXNCYWRnZShzY2VuZTogU2NlbmUpOiBudW1iZXIgfCBzdHJpbmcgfCBudWxsIHtcbiAgaWYgKHN0YXRlLmN1cnJlbnRNb2RlID09PSBcInBsYWNlbWVudFwiKSB7XG4gICAgY29uc3QgcnVuID0gc3RhdGUucGxhY2VtZW50O1xuICAgIGlmIChydW4/LnNjZW5lLmlkICE9PSBzY2VuZS5pZCkgcmV0dXJuIG51bGw7XG4gICAgLy8gXCJTdGFydCBmcm9tIHRoZSBib3R0b21cIiBydW5zIHNob3cgdGhlIHN0cmVhayB1bnRpbCB0aGUgZmlyc3QgbG9zc1xuICAgIGlmIChydW4uZnJvbUJvdHRvbSAmJiBydW4uYmF0dGxlcyA+IDAgJiYgcnVuLnN0cmVhayA9PT0gcnVuLmJhdHRsZXMpIHJldHVybiBydW4uc3RyZWFrO1xuICAgIGlmIChydW4ucmFuZ2VIaSA9PT0gcnVuLnJhbmdlTG8pIHJldHVybiBudWxsO1xuICAgIHJldHVybiBg8J+TjSBOYXJyb3dpbmcgYmV0d2VlbiAjJHtydW4ucmFuZ2VMbyArIDF9IGFuZCAjJHtydW4ucmFuZ2VIaSArIDF9YDtcbiAgfVxuICBpZiAoc3RhdGUuY3VycmVudE1vZGUgPT09IFwiY2hhbXBpb25cIiAmJiBzdGF0ZS5jaGFtcGlvblNjZW5lPy5pZCA9PT0gc2NlbmUuaWQpIHtcbiAgICByZXR1cm4gc3RhdGUuY2hhbXBpb25XaW5zO1xuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG4vKiogUHJlY29tcHV0ZWQgd2lubmVyL2xvc2VyIGNvbnRleHQgd2lyZWQgYXQgcmVuZGVyIHRpbWUgZm9yIGVhY2ggY2hvb3NlIGJ1dHRvbi4gKi9cbmludGVyZmFjZSBTY2VuZUNob2ljZSB7XG4gIHdpbm5lcjogU2NlbmU7XG4gIGxvc2VyOiBTY2VuZTtcbiAgbGVmdDogU2NlbmU7XG4gIHJpZ2h0OiBTY2VuZTtcbiAgd2lubmVyQ2FyZDogSFRNTEVsZW1lbnQ7XG4gIGxvc2VyQ2FyZDogSFRNTEVsZW1lbnQ7XG4gIHdpbm5lclJhbms6IFJhbms7XG4gIGxvc2VyUmFuazogUmFuaztcbn1cblxuZnVuY3Rpb24gYmluZFNjZW5lQ2hvaWNlKGJvZHk6IEhUTUxFbGVtZW50LCBjaG9pY2U6IFNjZW5lQ2hvaWNlKTogdm9pZCB7XG4gIGJvZHkuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IGhhbmRsZVNjZW5lQ2hvaWNlKGNob2ljZSkpO1xufVxuXG4vKiogU2hvdyBvciBoaWRlIHRoZSBTa2lwIC8gUmVmcmVzaCBiYXIuIE9ubHkgZW5kIHNjcmVlbnMgaGlkZSBpdDsgZXZlcnkgcmVuZGVyZWQgcGFpciBzaG93cyBpdC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZXRBY3Rpb25zVmlzaWJsZSh2aXNpYmxlOiBib29sZWFuKTogdm9pZCB7XG4gIGNvbnN0IGFjdGlvbnNFbCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiLnNiLWFjdGlvbnNcIik7XG4gIGlmIChhY3Rpb25zRWwpIGFjdGlvbnNFbC5zdHlsZS5kaXNwbGF5ID0gdmlzaWJsZSA/IFwiXCIgOiBcIm5vbmVcIjtcbn1cblxuLyoqIFRvdWNoIGRldmljZXMgaGF2ZSBubyBob3ZlcjogdGh1bWJuYWlscyB0b2dnbGUgdGhlIHByZXZpZXcgaW5zdGVhZCBvZiBvcGVuaW5nIHRoZSBzY2VuZS4gKi9cbmZ1bmN0aW9uIGlzVG91Y2hEZXZpY2UoKTogYm9vbGVhbiB7XG4gIHJldHVybiB3aW5kb3cubWF0Y2hNZWRpYShcIihob3Zlcjogbm9uZSlcIikubWF0Y2hlcztcbn1cblxuLyoqIFRodW1ibmFpbCAvIOKGlyBsaW5rIGNsaWNrOiBuYXRpdmUgbGluayBmb3IgbmV3IHRhYiBvciBtb2RpZmllciBjbGlja3MsIFNQQSBuYXZpZ2F0aW9uIG90aGVyd2lzZS4gKi9cbmZ1bmN0aW9uIGhhbmRsZVNjZW5lTGlua0NsaWNrKGU6IE1vdXNlRXZlbnQsIGxpbms6IEhUTUxBbmNob3JFbGVtZW50KTogdm9pZCB7XG4gIGNvbnN0IG5hdGl2ZU5ld1RhYiA9IGxpbmsudGFyZ2V0ID09PSBcIl9ibGFua1wiICYmIHN0YXRlLnNldHRpbmdzLm9wZW5Jbk5ld1RhYjtcbiAgaWYgKG5hdGl2ZU5ld1RhYiB8fCBlLmN0cmxLZXkgfHwgZS5tZXRhS2V5IHx8IGUuc2hpZnRLZXkgfHwgZS5idXR0b24gIT09IDApIHJldHVybjtcbiAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICBuYXZpZ2F0ZVRvVXJsKGxpbmsuZ2V0QXR0cmlidXRlKFwiaHJlZlwiKSB8fCBcIlwiKTtcbn1cblxuLyoqXG4gKiBTbGlkZXIgKDAtMTAwKSB0byBtZWRpYSB2b2x1bWUgb24gYSBjdWJpYyBjdXJ2ZSwgc28gdGhlIHNsaWRlciB0cmFja3MgcGVyY2VpdmVkIGxvdWRuZXNzLlxuICogKFN0YXNoJ3MgcGxheWVyIGlzIGxpbmVhciwgYnV0IGdlbmVyYXRlZCBwcmV2aWV3IGNsaXBzIGFyZSBtdWNoIGxvdWRlciB0aGFuIHRoZSBzb3VyY2UuKVxuICovXG5mdW5jdGlvbiBzbGlkZXJUb1ZvbHVtZShzbGlkZXI6IG51bWJlcik6IG51bWJlciB7XG4gIHJldHVybiBNYXRoLnBvdyhzbGlkZXIgLyAxMDAsIDMpO1xufVxuXG4vKiogQXBwbHkgdm9sdW1lL2F1dG9wbGF5IHNldHRpbmdzIHRvIHRoZSByZW5kZXJlZCBwcmV2aWV3IHZpZGVvcyAoaG92ZXJlZCBjYXJkIGlzIGF1ZGlibGUpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFwcGx5UHJldmlld1NldHRpbmdzKCk6IHZvaWQge1xuICBjb25zdCB7IHByZXZpZXdWb2x1bWUsIGF1dG9wbGF5UHJldmlld3MgfSA9IHN0YXRlLnNldHRpbmdzO1xuICBjb25zdCBiYXR0bGVWaXNpYmxlID0gZ2V0QWN0aXZlVGFiKCkgPT09IFwiYmF0dGxlXCI7XG4gIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoXCIuc2ItdnMtY29udGFpbmVyXCIpPy5jbGFzc0xpc3QudG9nZ2xlKFwic2ItYXV0b3BsYXlcIiwgYXV0b3BsYXlQcmV2aWV3cyk7XG5cbiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oXCIjc2ItY29tcGFyaXNvbi1hcmVhIC5zYi1zY2VuZS1jYXJkXCIpLmZvckVhY2goKGNhcmQpID0+IHtcbiAgICBjb25zdCB2aWRlbyA9IGNhcmQucXVlcnlTZWxlY3RvcjxIVE1MVmlkZW9FbGVtZW50PihcIi5zYi1ob3Zlci1wcmV2aWV3XCIpO1xuICAgIGlmICghdmlkZW8pIHJldHVybjtcbiAgICBjb25zdCBhY3RpdmUgPSBjYXJkLm1hdGNoZXMoXCI6aG92ZXJcIikgfHwgY2FyZC5jbGFzc0xpc3QuY29udGFpbnMoXCJzYi1wcmV2aWV3aW5nXCIpO1xuICAgIHZpZGVvLnZvbHVtZSA9IHNsaWRlclRvVm9sdW1lKHByZXZpZXdWb2x1bWUpO1xuICAgIHZpZGVvLm11dGVkID0gIWFjdGl2ZSB8fCBwcmV2aWV3Vm9sdW1lID09PSAwO1xuICAgIGlmIChiYXR0bGVWaXNpYmxlICYmIChhdXRvcGxheVByZXZpZXdzIHx8IGFjdGl2ZSkpIHtcbiAgICAgIGlmICh2aWRlby5wYXVzZWQpIHZpZGVvLnBsYXkoKS5jYXRjaCgoKSA9PiB7fSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHZpZGVvLnBhdXNlKCk7XG4gICAgICB2aWRlby5jdXJyZW50VGltZSA9IDA7XG4gICAgfVxuICB9KTtcbn1cblxuZnVuY3Rpb24gYmluZFByZXZpZXcoY2FyZDogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgY29uc3QgdmlkZW8gPSBjYXJkLnF1ZXJ5U2VsZWN0b3I8SFRNTFZpZGVvRWxlbWVudD4oXCIuc2ItaG92ZXItcHJldmlld1wiKTtcbiAgaWYgKCF2aWRlbykgcmV0dXJuO1xuXG4gIGNhcmQuYWRkRXZlbnRMaXN0ZW5lcihcIm1vdXNlZW50ZXJcIiwgKCkgPT4ge1xuICAgIGlmIChpc1RvdWNoRGV2aWNlKCkpIHJldHVybjtcbiAgICBpZiAoIXN0YXRlLnNldHRpbmdzLmF1dG9wbGF5UHJldmlld3MpIHZpZGVvLmN1cnJlbnRUaW1lID0gMDtcbiAgICB2aWRlby52b2x1bWUgPSBzbGlkZXJUb1ZvbHVtZShzdGF0ZS5zZXR0aW5ncy5wcmV2aWV3Vm9sdW1lKTtcbiAgICB2aWRlby5tdXRlZCA9IHN0YXRlLnNldHRpbmdzLnByZXZpZXdWb2x1bWUgPT09IDA7XG4gICAgdmlkZW8ucGxheSgpLmNhdGNoKCgpID0+IHt9KTtcbiAgfSk7XG5cbiAgY2FyZC5hZGRFdmVudExpc3RlbmVyKFwibW91c2VsZWF2ZVwiLCAoKSA9PiB7XG4gICAgaWYgKGlzVG91Y2hEZXZpY2UoKSkgcmV0dXJuO1xuICAgIGlmIChzdGF0ZS5zZXR0aW5ncy5hdXRvcGxheVByZXZpZXdzKSB7XG4gICAgICB2aWRlby5tdXRlZCA9IHRydWU7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHZpZGVvLnBhdXNlKCk7XG4gICAgdmlkZW8uY3VycmVudFRpbWUgPSAwO1xuICB9KTtcbn1cblxuLyoqIFRvdWNoOiB0YXAgdGhlIHRodW1ibmFpbCB0byBwbGF5L3N0b3AgaXRzIHByZXZpZXcgd2l0aCBzb3VuZC4gKi9cbmZ1bmN0aW9uIHRvZ2dsZVByZXZpZXcoY2FyZDogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgY29uc3QgcHJldmlld2luZyA9ICFjYXJkLmNsYXNzTGlzdC5jb250YWlucyhcInNiLXByZXZpZXdpbmdcIik7XG4gIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoXCIuc2Itc2NlbmUtY2FyZC5zYi1wcmV2aWV3aW5nXCIpLmZvckVhY2goKGMpID0+IGMuY2xhc3NMaXN0LnJlbW92ZShcInNiLXByZXZpZXdpbmdcIikpO1xuICBjYXJkLmNsYXNzTGlzdC50b2dnbGUoXCJzYi1wcmV2aWV3aW5nXCIsIHByZXZpZXdpbmcpO1xuICBhcHBseVByZXZpZXdTZXR0aW5ncygpO1xufVxuXG4vKipcbiAqIFRoZSBWUyBiZXR3ZWVuIHRoZSBjYXJkcywgd2l0aCBlYWNoIHNpZGUncyB3aW4gY2hhbmNlIHVuZGVyIGl0IChhIFwid2hvJ3MgZmF2b3VyZWRcIiBiYXIpLlxuICogUGxhY2VtZW50IGhhcyBub25lOiBpdHMgc2NlbmUncyBFTE8gZG9lc24ndCBjaGFuZ2UgcGVyIHBpY2ssIGFuZCBhbiB1bnJhdGVkIG9uZSBoYXMgbm8gRUxPLlxuICovXG5mdW5jdGlvbiB2c0RpdmlkZXIobGVmdDogU2NlbmUsIHJpZ2h0OiBTY2VuZSk6IHN0cmluZyB7XG4gIGlmIChzdGF0ZS5jdXJyZW50TW9kZSA9PT0gXCJwbGFjZW1lbnRcIikge1xuICAgIHJldHVybiBgPGRpdiBjbGFzcz1cInNiLXZzLWRpdmlkZXJcIj48c3BhbiBjbGFzcz1cInNiLXZzLXRleHRcIj5WUzwvc3Bhbj48L2Rpdj5gO1xuICB9XG4gIGNvbnN0IFtsZWZ0Q2hhbmNlLCByaWdodENoYW5jZV0gPSB3aW5DaGFuY2VzKGJhdHRsZUVsbyhsYXRlc3RTY2VuZShsZWZ0KSksIGJhdHRsZUVsbyhsYXRlc3RTY2VuZShyaWdodCkpKTtcbiAgY29uc3QgZmF2b3VyZWQgPSAoY2hhbmNlOiBudW1iZXIpOiBzdHJpbmcgPT4gKGNoYW5jZSA+IDUwID8gXCIgc2ItZmF2b3VyZWRcIiA6IFwiXCIpO1xuICBjb25zdCB0aXAgPSBgQ2hhbmNlIGVhY2ggc2NlbmUgd2lucywgZnJvbSB0aGVpciBFTE86IGxlZnQgJHtsZWZ0Q2hhbmNlfSUsIHJpZ2h0ICR7cmlnaHRDaGFuY2V9JWA7XG4gIHJldHVybiBgXG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi12cy1kaXZpZGVyXCI+XG4gICAgICAgICAgPGRpdiBjbGFzcz1cInNiLXZzLXN0YWNrXCIgdGl0bGU9XCIke3RpcH1cIj5cbiAgICAgICAgICAgIDxzcGFuIGNsYXNzPVwic2Itd2luLWNoYW5jZSBzYi13aW4tY2hhbmNlLWxlZnQke2Zhdm91cmVkKGxlZnRDaGFuY2UpfVwiPiR7bGVmdENoYW5jZX0lPC9zcGFuPlxuICAgICAgICAgICAgPHNwYW4gY2xhc3M9XCJzYi12cy10ZXh0XCI+VlM8L3NwYW4+XG4gICAgICAgICAgICA8c3BhbiBjbGFzcz1cInNiLXdpbi1jaGFuY2Ugc2Itd2luLWNoYW5jZS1yaWdodCR7ZmF2b3VyZWQocmlnaHRDaGFuY2UpfVwiPiR7cmlnaHRDaGFuY2V9JTwvc3Bhbj5cbiAgICAgICAgICAgIDxzcGFuIGNsYXNzPVwic2Itd2luLWJhclwiIGFyaWEtaGlkZGVuPVwidHJ1ZVwiPjxzcGFuIHN0eWxlPVwid2lkdGg6ICR7bGVmdENoYW5jZX0lXCI+PC9zcGFuPjwvc3Bhbj5cbiAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgPC9kaXY+YDtcbn1cblxuLyoqIEVhY2ggc2NlbmUncyB0aWVyIHdoZW4gXCJTaG93IHRpZXJzIG9uIGNhcmRzXCIgaXMgb24gKGZyb20gdGhlIHdob2xlIGxpYnJhcnkncyBFTE8gb3JkZXIpLiAqL1xuZnVuY3Rpb24gcGFpclRpZXJzKHNjZW5lczogU2NlbmVbXSk6IChUaWVyIHwgbnVsbClbXSB7XG4gIGNvbnN0IGxpYnJhcnkgPSBzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXM7XG4gIGlmICghc3RhdGUuc2V0dGluZ3Muc2hvd1RpZXJzIHx8ICFsaWJyYXJ5KSByZXR1cm4gc2NlbmVzLm1hcCgoKSA9PiBudWxsKTtcbiAgY29uc3QgdGllcnMgPSB0aWVyTWFwKGxpYnJhcnkpO1xuICByZXR1cm4gc2NlbmVzLm1hcCgoc2NlbmUpID0+IHRpZXJzLmdldChzY2VuZS5pZCkgPz8gbnVsbCk7XG59XG5cbi8vIFNoYXJlZCByZW5kZXJpbmcgbG9naWMgZm9yIGRpc3BsYXlpbmcgYSBwYWlyIG9mIHNjZW5lc1xuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlclBhaXIoc2NlbmVzOiBTY2VuZVtdLCByYW5rczogUmFua1tdKTogdm9pZCB7XG4gIGNvbnN0IGNvbXBhcmlzb25BcmVhID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzYi1jb21wYXJpc29uLWFyZWFcIik7XG4gIGlmICghY29tcGFyaXNvbkFyZWEpIHJldHVybjtcblxuICBjb25zdCBzdGF0dXNCYWRnZXMgPSBzY2VuZXMubWFwKGNsaW1iU3RhdHVzQmFkZ2UpO1xuICBjb25zdCB0aWVycyA9IHBhaXJUaWVycyhzY2VuZXMpO1xuXG4gIGNvbXBhcmlzb25BcmVhLmlubmVySFRNTCA9IGBcbiAgICAgIDxkaXYgY2xhc3M9XCJzYi12cy1jb250YWluZXJcIj5cbiAgICAgICAgJHtjcmVhdGVTY2VuZUNhcmQoc2NlbmVzWzBdLCBcImxlZnRcIiwgcmFua3NbMF0sIHN0YXR1c0JhZGdlc1swXSwgdGllcnNbMF0pfVxuICAgICAgICAke3ZzRGl2aWRlcihzY2VuZXNbMF0sIHNjZW5lc1sxXSl9XG4gICAgICAgICR7Y3JlYXRlU2NlbmVDYXJkKHNjZW5lc1sxXSwgXCJyaWdodFwiLCByYW5rc1sxXSwgc3RhdHVzQmFkZ2VzWzFdLCB0aWVyc1sxXSl9XG4gICAgICA8L2Rpdj5cbiAgICBgO1xuXG4gIGNvbnN0IGxlZnQgPSBzY2VuZXNbMF07XG4gIGNvbnN0IHJpZ2h0ID0gc2NlbmVzWzFdO1xuICBjb25zdCBsZWZ0Q2FyZCA9IGNvbXBhcmlzb25BcmVhLnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KCcuc2Itc2NlbmUtY2FyZFtkYXRhLXNpZGU9XCJsZWZ0XCJdJyk7XG4gIGNvbnN0IHJpZ2h0Q2FyZCA9IGNvbXBhcmlzb25BcmVhLnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KCcuc2Itc2NlbmUtY2FyZFtkYXRhLXNpZGU9XCJyaWdodFwiXScpO1xuICBjb25zdCBsZWZ0Qm9keSA9IGxlZnRDYXJkPy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIi5zYi1zY2VuZS1ib2R5XCIpO1xuICBjb25zdCByaWdodEJvZHkgPSByaWdodENhcmQ/LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiLnNiLXNjZW5lLWJvZHlcIik7XG5cbiAgaWYgKGxlZnQgJiYgcmlnaHQgJiYgbGVmdENhcmQgJiYgcmlnaHRDYXJkICYmIGxlZnRCb2R5ICYmIHJpZ2h0Qm9keSkge1xuICAgIGJpbmRTY2VuZUNob2ljZShsZWZ0Qm9keSwge1xuICAgICAgd2lubmVyOiBsZWZ0LFxuICAgICAgbG9zZXI6IHJpZ2h0LFxuICAgICAgbGVmdCxcbiAgICAgIHJpZ2h0LFxuICAgICAgd2lubmVyQ2FyZDogbGVmdENhcmQsXG4gICAgICBsb3NlckNhcmQ6IHJpZ2h0Q2FyZCxcbiAgICAgIHdpbm5lclJhbms6IHJhbmtzWzBdLFxuICAgICAgbG9zZXJSYW5rOiByYW5rc1sxXSxcbiAgICB9KTtcbiAgICBiaW5kU2NlbmVDaG9pY2UocmlnaHRCb2R5LCB7XG4gICAgICB3aW5uZXI6IHJpZ2h0LFxuICAgICAgbG9zZXI6IGxlZnQsXG4gICAgICBsZWZ0LFxuICAgICAgcmlnaHQsXG4gICAgICB3aW5uZXJDYXJkOiByaWdodENhcmQsXG4gICAgICBsb3NlckNhcmQ6IGxlZnRDYXJkLFxuICAgICAgd2lubmVyUmFuazogcmFua3NbMV0sXG4gICAgICBsb3NlclJhbms6IHJhbmtzWzBdLFxuICAgIH0pO1xuXG4gICAgbGVmdENhcmQucXVlcnlTZWxlY3RvcihcIi5zYi1kZWxldGUtYnRuXCIpPy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4gdm9pZCBkZWxldGVGcm9tQmF0dGxlKGxlZnQpKTtcbiAgICByaWdodENhcmQucXVlcnlTZWxlY3RvcihcIi5zYi1kZWxldGUtYnRuXCIpPy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4gdm9pZCBkZWxldGVGcm9tQmF0dGxlKHJpZ2h0KSk7XG4gIH1cblxuICBjb21wYXJpc29uQXJlYS5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PihcIi5zYi1zY2VuZS1jYXJkXCIpLmZvckVhY2goKGNhcmQpID0+IHtcbiAgICBjb25zdCB0aHVtYiA9IGNhcmQucXVlcnlTZWxlY3RvcjxIVE1MQW5jaG9yRWxlbWVudD4oXCIuc2Itc2NlbmUtaW1hZ2UtY29udGFpbmVyXCIpO1xuICAgIHRodW1iPy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKGUpID0+IHtcbiAgICAgIGlmIChpc1RvdWNoRGV2aWNlKCkpIHtcbiAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgICB0b2dnbGVQcmV2aWV3KGNhcmQpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBoYW5kbGVTY2VuZUxpbmtDbGljayhlLCB0aHVtYik7XG4gICAgfSk7XG4gICAgY29uc3Qgb3BlbkxpbmsgPSBjYXJkLnF1ZXJ5U2VsZWN0b3I8SFRNTEFuY2hvckVsZW1lbnQ+KFwiLnNiLW9wZW4tbGlua1wiKTtcbiAgICBvcGVuTGluaz8uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XG4gICAgICBpZiAoIXN0YXRlLnNldHRpbmdzLm9wZW5Jbk5ld1RhYikgaGFuZGxlU2NlbmVMaW5rQ2xpY2soZSwgb3BlbkxpbmspO1xuICAgIH0pO1xuICAgIGJpbmRQcmV2aWV3KGNhcmQpO1xuICB9KTtcbiAgYXBwbHlQcmV2aWV3U2V0dGluZ3MoKTtcblxuICBzZXRBY3Rpb25zVmlzaWJsZSh0cnVlKTtcblxuICAvLyBVcGRhdGUgc2tpcCBidXR0b24gc3RhdGVcbiAgY29uc3Qgc2tpcEJ0biA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3I8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiI3NiLXNraXAtYnRuXCIpO1xuICBpZiAoc2tpcEJ0bikgc2tpcEJ0bi5kaXNhYmxlZCA9IGlzUnVuQWN0aXZlKCk7XG59XG5cbi8qKiBTa2lwIHRoZSBjdXJyZW50IHBhaXIgKG5vdCBhbGxvd2VkIG1pZC1ydW4pLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNraXBQYWlyKCk6IHZvaWQge1xuICBpZiAoaXNSdW5BY3RpdmUoKSB8fCBzdGF0ZS5kaXNhYmxlQ2hvaWNlKSByZXR1cm47XG4gIHN0YXRlLmRpc2FibGVDaG9pY2UgPSB0cnVlO1xuICBpZiAoc3RhdGUuY3VycmVudE1vZGUgIT09IFwic3dpc3NcIikge1xuICAgIHJlc2V0UnVuU3RhdGUoKTtcbiAgICBzYXZlU3RhdGUoKTtcbiAgfVxuICBsb2FkTmV3UGFpcigpO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbG9hZE5ld1BhaXIoZm9yY2VkTGVmdFNjZW5lSWQ6IHN0cmluZyB8IG51bGwgPSBudWxsKTogUHJvbWlzZTx2b2lkPiB7XG4gIC8vIE5vIHBvb2wgbG9hZHMgYmVmb3JlIHRoZSBvbmUtdGltZSBFTE8gc2V0dXAgaGFzIHJ1biAoaXQgc2hvd3MgaW4gcGxhY2Ugb2YgdGhlIGJhdHRsZSlcbiAgaWYgKGlzRWxvU2V0dXBQZW5kaW5nKCkpIHJldHVybjtcbiAgc3RhdGUuZGlzYWJsZUNob2ljZSA9IGZhbHNlO1xuICBjb25zdCBjb21wYXJpc29uQXJlYSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic2ItY29tcGFyaXNvbi1hcmVhXCIpO1xuICBpZiAoIWNvbXBhcmlzb25BcmVhKSByZXR1cm47XG5cbiAgY29uc29sZS5sb2coXG4gICAgYFtTdGFzaCBCYXR0bGVdIPCfjq4gTG9hZGluZyBuZXcgcGFpciAobW9kZTogJHtzdGF0ZS5jdXJyZW50TW9kZX0pJHtmb3JjZWRMZWZ0U2NlbmVJZCA/IGAgd2l0aCBmb3JjZWQgc2NlbmUgJHtmb3JjZWRMZWZ0U2NlbmVJZH1gIDogXCJcIn0uLi5gLFxuICApO1xuICBjb25zdCBzdGFydFRpbWUgPSBEYXRlLm5vdygpO1xuXG4gIC8vIE9ubHkgc2hvdyBsb2FkaW5nIG9uIGZpcnN0IGxvYWQgKHdoZW4gZW1wdHkgb3IgYWxyZWFkeSBzaG93aW5nIGxvYWRpbmcpXG4gIGlmICghY29tcGFyaXNvbkFyZWEucXVlcnlTZWxlY3RvcihcIi5zYi12cy1jb250YWluZXJcIikpIHtcbiAgICBjb25zdCBoYXNDYWNoZSA9IHN0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcyAhPT0gbnVsbDtcbiAgICBjb21wYXJpc29uQXJlYS5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz1cInNiLWxvYWRpbmdcIj4ke2hhc0NhY2hlID8gXCJMb2FkaW5nIHNjZW5lcy4uLlwiIDogXCJMb2FkaW5nIGFuZCBjYWNoaW5nIHNjZW5lcyAoZmlyc3QgbG9hZCBtYXkgdGFrZSBhIG1vbWVudCkuLi5cIn08L2Rpdj5gO1xuICB9XG5cbiAgdHJ5IHtcbiAgICAvLyBGZXRjaCBmb3JjZWQgc2NlbmUgZGF0YSBpZiBhIHNjZW5lIElEIHdhcyBwcm92aWRlZFxuICAgIGxldCBmb3JjZWRMZWZ0U2NlbmU6IFNjZW5lIHwgbnVsbCA9IG51bGw7XG4gICAgaWYgKGZvcmNlZExlZnRTY2VuZUlkKSB7XG4gICAgICBmb3JjZWRMZWZ0U2NlbmUgPSBhd2FpdCBmZXRjaFNjZW5lQnlJZChmb3JjZWRMZWZ0U2NlbmVJZCk7XG4gICAgICAvLyBGcmVzaCBmcm9tIFN0YXNoOiB0aGUgY2FjaGUgbWF5IGJlIG9sZGVyIChhbm90aGVyIHRhYiksIGFuZCByYW5rcyBhbmQgYmF0dGxlIG1hdGggcmVhZCBpdFxuICAgICAgaWYgKGZvcmNlZExlZnRTY2VuZSkgcmVmcmVzaFNjZW5lSW5DYWNoZShmb3JjZWRMZWZ0U2NlbmUpO1xuICAgICAgaWYgKCFmb3JjZWRMZWZ0U2NlbmUpIHtcbiAgICAgICAgY29uc29sZS53YXJuKFwiW1N0YXNoIEJhdHRsZV0gQ291bGQgbm90IGZldGNoIHNjZW5lIGZyb20gVVJMLCBmYWxsaW5nIGJhY2sgdG8gbm9ybWFsIHBhaXJpbmdcIik7XG4gICAgICB9XG4gICAgfVxuXG4gICAgbGV0IHNjZW5lczogU2NlbmVbXSA9IFtdO1xuICAgIGxldCByYW5rczogUmFua1tdID0gW251bGwsIG51bGxdO1xuXG4gICAgaWYgKHN0YXRlLmN1cnJlbnRNb2RlID09PSBcInBsYWNlbWVudFwiKSB7XG4gICAgICBjb25zdCBwbGFjZW1lbnRSZXN1bHQgPSBhd2FpdCBmZXRjaFBsYWNlbWVudFBhaXIoZm9yY2VkTGVmdFNjZW5lKTtcblxuICAgICAgaWYgKHBsYWNlbWVudFJlc3VsdC5kb25lKSB7XG4gICAgICAgIC8vIEEgY2xpbWIgZnJvbSB0aGUgYm90dG9tIHRoYXQgbmV2ZXIgbG9zdCBoYXMgYmVhdGVuIHRoZSB0b3Agc2NlbmVcbiAgICAgICAgaWYgKHBsYWNlbWVudFJlc3VsdC5mcm9tQm90dG9tICYmIHBsYWNlbWVudFJlc3VsdC5yYW5rID09PSAxKSB7XG4gICAgICAgICAgc2hvd1ZpY3RvcnlTY3JlZW4ocGxhY2VtZW50UmVzdWx0LnNjZW5lLCBwbGFjZW1lbnRSZXN1bHQuc3RyZWFrKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBzaG93UGxhY2VtZW50U2NyZWVuKHBsYWNlbWVudFJlc3VsdCk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBzY2VuZXMgPSBwbGFjZW1lbnRSZXN1bHQuc2NlbmVzO1xuICAgICAgcmFua3MgPSBwbGFjZW1lbnRSZXN1bHQucmFua3M7XG4gICAgfSBlbHNlIGlmIChzdGF0ZS5jdXJyZW50TW9kZSA9PT0gXCJjaGFtcGlvblwiKSB7XG4gICAgICBjb25zdCBjaGFtcGlvblJlc3VsdCA9IGF3YWl0IGZldGNoQ2hhbXBpb25QYWlyKGZvcmNlZExlZnRTY2VuZSk7XG5cbiAgICAgIC8vIENoZWNrIGZvciB2aWN0b3J5IChjaGFtcGlvbiBiZWF0IGV2ZXJ5b25lKVxuICAgICAgaWYgKGNoYW1waW9uUmVzdWx0LmlzVmljdG9yeSkge1xuICAgICAgICBzaG93VmljdG9yeVNjcmVlbihjaGFtcGlvblJlc3VsdC5zY2VuZXNbMF0sIHN0YXRlLmNoYW1waW9uV2lucyk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgc2NlbmVzID0gY2hhbXBpb25SZXN1bHQuc2NlbmVzO1xuICAgICAgcmFua3MgPSBjaGFtcGlvblJlc3VsdC5yYW5rcztcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3Qgc3dpc3NSZXN1bHQgPSBhd2FpdCBmZXRjaFN3aXNzUGFpcihmb3JjZWRMZWZ0U2NlbmUpO1xuXG4gICAgICBzY2VuZXMgPSBzd2lzc1Jlc3VsdC5zY2VuZXM7XG4gICAgICByYW5rcyA9IHN3aXNzUmVzdWx0LnJhbmtzO1xuICAgIH1cblxuICAgIGlmIChzY2VuZXMubGVuZ3RoIDwgMikge1xuICAgICAgY29tcGFyaXNvbkFyZWEuaW5uZXJIVE1MID0gJzxkaXYgY2xhc3M9XCJzYi1lcnJvclwiPk5vdCBlbm91Z2ggc2NlbmVzIGF2YWlsYWJsZSBmb3IgY29tcGFyaXNvbi48L2Rpdj4nO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIHN0YXRlLmN1cnJlbnRQYWlyLmxlZnQgPSBzY2VuZXNbMF07XG4gICAgc3RhdGUuY3VycmVudFBhaXIucmlnaHQgPSBzY2VuZXNbMV07XG4gICAgc3RhdGUuY3VycmVudFJhbmtzLmxlZnQgPSByYW5rc1swXTtcbiAgICBzdGF0ZS5jdXJyZW50UmFua3MucmlnaHQgPSByYW5rc1sxXTtcblxuICAgIGNvbnN0IGxvYWRUaW1lID0gRGF0ZS5ub3coKSAtIHN0YXJ0VGltZTtcbiAgICBjb25zb2xlLmxvZyhcbiAgICAgIGBbU3Rhc2ggQmF0dGxlXSDinIUgUGFpciBsb2FkZWQgaW4gJHtsb2FkVGltZX1tczogU2NlbmUgJHtzY2VuZXNbMF0uaWR9IChyYW5rICMke3JhbmtzWzBdfSkgdnMgU2NlbmUgJHtzY2VuZXNbMV0uaWR9IChyYW5rICMke3JhbmtzWzFdfSlgLFxuICAgICk7XG5cbiAgICByZW5kZXJQYWlyKHNjZW5lcywgcmFua3MpO1xuICAgIHVwZGF0ZVBvb2xTdGF0dXMoKTtcbiAgICB1cGRhdGVDbGltYlBvb2xXYXJuaW5nKCk7XG4gICAgc2F2ZVN0YXRlKCk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIEVycm9yIGxvYWRpbmcgc2NlbmVzOlwiLCBlcnJvcik7XG4gICAgY29uc3QgbWVzc2FnZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcbiAgICBjb25zdCBpc05vU2NlbmVzID0gbWVzc2FnZS5pbmNsdWRlcyhcIk5vIHNjZW5lc1wiKSB8fCBtZXNzYWdlLmluY2x1ZGVzKFwiTm90IGVub3VnaFwiKTtcbiAgICBjb21wYXJpc29uQXJlYS5pbm5lckhUTUwgPSBgXG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi1lcnJvci1zY3JlZW5cIj5cbiAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItZXJyb3ItaWNvblwiPuKaoO+4jzwvZGl2PlxuICAgICAgICAgIDxwIGNsYXNzPVwic2ItZXJyb3ItbWVzc2FnZVwiPiR7bWVzc2FnZX08L3A+XG4gICAgICAgICAgPGJ1dHRvbiBpZD1cInNiLWVycm9yLXJldHJ5XCIgY2xhc3M9XCJidG4gYnRuLXByaW1hcnlcIj5SZXRyeTwvYnV0dG9uPlxuICAgICAgICA8L2Rpdj5cbiAgICAgIGA7XG4gICAgc2V0QWN0aW9uc1Zpc2libGUodHJ1ZSk7XG5cbiAgICAvLyBBdHRhY2ggcmV0cnkgaGFuZGxlclxuICAgIGNvbnN0IHJldHJ5QnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzYi1lcnJvci1yZXRyeVwiKSBhcyBIVE1MQnV0dG9uRWxlbWVudCB8IG51bGw7XG4gICAgaWYgKHJldHJ5QnRuKSB7XG4gICAgICByZXRyeUJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgICByZXRyeUJ0bi5kaXNhYmxlZCA9IHRydWU7XG4gICAgICAgIHJldHJ5QnRuLnRleHRDb250ZW50ID0gXCJMb2FkaW5nLi4uXCI7XG5cbiAgICAgICAgaWYgKGlzTm9TY2VuZXMpIHtcbiAgICAgICAgICAvLyBcIk5vIHNjZW5lc1wiIGVycm9yOiBjbGVhciBldmVyeXRoaW5nIGFuZCBzdGFydCBmcmVzaFxuICAgICAgICAgIGF3YWl0IGNsZWFyRmlsdGVyZWRDYWNoZSgpO1xuICAgICAgICAgIHJlc2V0U2h1ZmZsZSgpO1xuICAgICAgICB9XG4gICAgICAgIC8vIE5ldHdvcmsvb3RoZXIgZXJyb3JzOiBqdXN0IHJldHJ5IHdpdGhvdXQgY2xlYXJpbmcgc2Vzc2lvbiBzdGF0ZVxuXG4gICAgICAgIGF3YWl0IGxvYWROZXdQYWlyKCk7XG4gICAgICB9KTtcbiAgICB9XG4gIH1cbn1cblxuLyoqIFJlbmRlciB0aGUgc2F2ZWQgcGFpciwgdW5sZXNzIG9uZSBvZiBpdHMgc2NlbmVzIHdhcyBkZWxldGVkIGluIFN0YXNoIG1lYW53aGlsZS4gKi9cbi8qKlxuICogV2hldGhlciB0aGUgc2F2ZWQgcGFpciBiZWxvbmdzIHRvIHRoZSBjdXJyZW50IHJ1bi4gQSBQbGFjZW1lbnQgcGFpciBpcyBpdHMgcnVuJ3Mgc2NlbmUgYWdhaW5zdFxuICogYW4gb3Bwb25lbnQsIGFuZCBhIENoYW1waW9uIHBhaXIgaW5jbHVkZXMgdGhlIGNoYW1waW9uOyB3aXRob3V0IHRoYXQsIHBpY2tzIGhhdmUgbm90aGluZyB0b1xuICogYWN0IG9uIChhIHJ1biB0aGF0IGVuZGVkLCBzYXkpLlxuICovXG5mdW5jdGlvbiBwYWlyTWF0Y2hlc1J1bihsZWZ0OiBTY2VuZSwgcmlnaHQ6IFNjZW5lKTogYm9vbGVhbiB7XG4gIGlmIChzdGF0ZS5jdXJyZW50TW9kZSA9PT0gXCJwbGFjZW1lbnRcIikgcmV0dXJuIHN0YXRlLnBsYWNlbWVudD8uc2NlbmUuaWQgPT09IGxlZnQuaWQ7XG4gIGlmIChzdGF0ZS5jdXJyZW50TW9kZSA9PT0gXCJjaGFtcGlvblwiICYmIHN0YXRlLmNoYW1waW9uU2NlbmUpIHtcbiAgICByZXR1cm4gc3RhdGUuY2hhbXBpb25TY2VuZS5pZCA9PT0gbGVmdC5pZCB8fCBzdGF0ZS5jaGFtcGlvblNjZW5lLmlkID09PSByaWdodC5pZDtcbiAgfVxuICByZXR1cm4gdHJ1ZTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlc3RvcmVDdXJyZW50UGFpcigpOiBQcm9taXNlPHZvaWQ+IHtcbiAgaWYgKGlzRWxvU2V0dXBQZW5kaW5nKCkpIHJldHVybjtcbiAgY29uc3QgbGVmdCA9IHN0YXRlLmN1cnJlbnRQYWlyLmxlZnQgYXMgU2NlbmU7XG4gIGNvbnN0IHJpZ2h0ID0gc3RhdGUuY3VycmVudFBhaXIucmlnaHQgYXMgU2NlbmU7XG4gIGlmICghcGFpck1hdGNoZXNSdW4obGVmdCwgcmlnaHQpKSB7XG4gICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5OCIFNhdmVkIHBhaXIgZG9lc24ndCBiZWxvbmcgdG8gdGhlIGN1cnJlbnQgcnVuLCBsb2FkaW5nIGEgbmV3IHBhaXJcIik7XG4gICAgYXdhaXQgbG9hZE5ld1BhaXIoKTtcbiAgICByZXR1cm47XG4gIH1cbiAgc3RhdGUuZGlzYWJsZUNob2ljZSA9IGZhbHNlO1xuXG4gIC8vIEFsc28gYnJpbmdzIHRoZSBwYWlyJ3MgRUxPIGFuZCBTdGFzaCByYXRpbmcgdXAgdG8gZGF0ZSAodGhleSBtYXkgaGF2ZSBjaGFuZ2VkIHNpbmNlIGl0IHdhcyBzYXZlZClcbiAgaWYgKCEoYXdhaXQgdmVyaWZ5Q3VycmVudFBhaXIoKSkpIHJldHVybjtcblxuICAvLyBSYW5rcyBmcm9tIHRoZSBjdXJyZW50IHBvb2xzLCBub3QgdGhlIHNhdmVkIG9uZXM6IGJhdHRsZXMgc2luY2UgbWF5IGhhdmUgbW92ZWQgdGhlbS4gTG9hZGluZ1xuICAvLyB0aGUgcG9vbHMgYWxzbyBwcmUtd2FybXMgdGhlbSBmb3IgdGhlIG5leHQgY2hvaWNlIGFuZCBmaWxscyBpbiB0aGUgc3RhdHVzIGxpbmUncyBwb29sIHNpemUuXG4gIGxldCByYW5rczogW1JhbmssIFJhbmtdID0gW3N0YXRlLmN1cnJlbnRSYW5rcy5sZWZ0LCBzdGF0ZS5jdXJyZW50UmFua3MucmlnaHRdO1xuICB0cnkge1xuICAgIHJhbmtzID0gYXdhaXQgcGFpclJhbmtzKGxlZnQsIHJpZ2h0KTtcbiAgICBzdGF0ZS5jdXJyZW50UmFua3MgPSB7IGxlZnQ6IHJhbmtzWzBdLCByaWdodDogcmFua3NbMV0gfTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnNvbGUud2FybihcIltTdGFzaCBCYXR0bGVdIENvdWxkIG5vdCBsb2FkIHNjZW5lIHBvb2xzIGZvciB0aGUgc2F2ZWQgcGFpcidzIHJhbmtzOlwiLCBlKTtcbiAgfVxuXG4gIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+TgiBSZW5kZXJpbmcgc2F2ZWQgcGFpclwiKTtcbiAgcmVuZGVyUGFpcihbbGVmdCwgcmlnaHRdLCByYW5rcyk7XG4gIHVwZGF0ZVBvb2xTdGF0dXMoKTtcbn1cblxuLyoqXG4gKiBDaGVjayB0aGUgY3VycmVudCBwYWlyIHN0aWxsIGV4aXN0cyBpbiBTdGFzaCAoc2NlbmVzIG1heSBiZSBkZWxldGVkIGVsc2V3aGVyZSkuIElmIG9uZSBpcyBnb25lLFxuICogY29udGludWUgd2l0aG91dCBpdCBhbmQgcmV0dXJuIGZhbHNlLiBPdGhlcndpc2UgdGhlIHBhaXIncyBFTE8gYW5kIFN0YXNoIHJhdGluZyBhcmUgYnJvdWdodCB1cFxuICogdG8gZGF0ZSBmcm9tIFN0YXNoLCBpbiBpdHMgb2JqZWN0cyBhbmQgdGhlIGNhY2hlLiBOZXR3b3JrIGVycm9ycyBjb3VudCBhcyBcInN0aWxsIHRoZXJlXCIuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB2ZXJpZnlDdXJyZW50UGFpcigpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgY29uc3QgeyBsZWZ0LCByaWdodCB9ID0gc3RhdGUuY3VycmVudFBhaXI7XG4gIGlmICghbGVmdCB8fCAhcmlnaHQpIHJldHVybiB0cnVlO1xuICB0cnkge1xuICAgIGNvbnN0IGZyZXNoID0gYXdhaXQgZmV0Y2hTY2VuZUZpZWxkcyhbbGVmdC5pZCwgcmlnaHQuaWRdKTtcbiAgICBjb25zdCBnb25lID0gW2xlZnQsIHJpZ2h0XS5maW5kKChzKSA9PiAhZnJlc2guaGFzKHMuaWQpKTtcbiAgICBpZiAoZ29uZSkge1xuICAgICAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIPCfkbsgU2NlbmUgJHtnb25lLmlkfSBpbiB0aGUgY3VycmVudCBwYWlyIG5vIGxvbmdlciBleGlzdHNgKTtcbiAgICAgIGF3YWl0IGhhbmRsZVNjZW5lR29uZShnb25lLmlkKTtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgZm9yIChjb25zdCBzY2VuZSBvZiBbbGVmdCwgcmlnaHRdKSB7XG4gICAgICBjb25zdCBmaWVsZHMgPSBmcmVzaC5nZXQoc2NlbmUuaWQpO1xuICAgICAgaWYgKCFmaWVsZHMpIGNvbnRpbnVlO1xuICAgICAgc2NlbmUucmF0aW5nMTAwID0gZmllbGRzLnJhdGluZzEwMCA/PyBudWxsO1xuICAgICAgc2NlbmUuY3VzdG9tX2ZpZWxkcyA9IGZpZWxkcy5jdXN0b21fZmllbGRzID8/IHt9O1xuICAgICAgcmVmcmVzaFNjZW5lSW5DYWNoZShzY2VuZSk7XG4gICAgfVxuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS53YXJuKFwiW1N0YXNoIEJhdHRsZV0gQ291bGQgbm90IHZlcmlmeSBjdXJyZW50IHBhaXI6XCIsIGUpO1xuICB9XG4gIHJldHVybiB0cnVlO1xufVxuXG4vKiogRm9yZ2V0IGEgc2NlbmUgaWQgcmVmZXJlbmNlZCBieSB0aGUgY3VycmVudCBydW4gKGl0IG5vIGxvbmdlciBleGlzdHMpLiAqL1xuZnVuY3Rpb24gZHJvcEZyb21SdW4oc2NlbmVJZDogc3RyaW5nKTogdm9pZCB7XG4gIHN0YXRlLmNoYW1waW9uRGVmZWF0ZWQgPSBzdGF0ZS5jaGFtcGlvbkRlZmVhdGVkLmZpbHRlcigoaWQpID0+IGlkICE9PSBzY2VuZUlkKTtcbiAgY29uc3QgcnVuID0gc3RhdGUucGxhY2VtZW50O1xuICBpZiAoIXJ1bikgcmV0dXJuO1xuICBpZiAocnVuLmFib3ZlSWQgPT09IHNjZW5lSWQpIHJ1bi5hYm92ZUlkID0gbnVsbDtcbiAgaWYgKHJ1bi5iZWxvd0lkID09PSBzY2VuZUlkKSBydW4uYmVsb3dJZCA9IG51bGw7XG4gIGlmIChydW4ubGFzdE9wcG9uZW50SWQgPT09IHNjZW5lSWQpIHtcbiAgICBydW4ubGFzdE9wcG9uZW50SWQgPSBudWxsO1xuICAgIHJ1bi5nYWxsb3BpbmcgPSBmYWxzZTtcbiAgfVxufVxuXG4vKipcbiAqIEEgc2NlbmUgaW4gcGxheSBubyBsb25nZXIgZXhpc3RzLiBJZiBpdCB3YXMgdGhlIHNjZW5lIGJlaW5nIHJhdGVkL3BsYWNlZC9jbGltYmluZywgc3RhcnQgb3ZlcjtcbiAqIG90aGVyd2lzZSBrZWVwIHRoZSBvdGhlciBzY2VuZSBhbmQgZmluZCBpdCBhIG5ldyBvcHBvbmVudC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGhhbmRsZVNjZW5lR29uZShzY2VuZUlkOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgYXdhaXQgcmVtb3ZlU2NlbmVFdmVyeXdoZXJlKHNjZW5lSWQpO1xuXG4gIGNvbnN0IHsgbGVmdCwgcmlnaHQgfSA9IHN0YXRlLmN1cnJlbnRQYWlyO1xuICBjb25zdCBydW5TY2VuZUlkcyA9IFtsZWZ0Py5pZCwgc3RhdGUucGxhY2VtZW50Py5zY2VuZS5pZCwgc3RhdGUuY2hhbXBpb25TY2VuZT8uaWRdO1xuXG4gIGlmIChydW5TY2VuZUlkcy5pbmNsdWRlcyhzY2VuZUlkKSkge1xuICAgIHJlc2V0UnVuU3RhdGUoKTtcbiAgICBzYXZlU3RhdGUoKTtcbiAgICBhd2FpdCBsb2FkTmV3UGFpcigpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGRyb3BGcm9tUnVuKHNjZW5lSWQpO1xuICBzYXZlU3RhdGUoKTtcbiAgLy8gRm9yY2VkIGxlZnQgb25seSBhcHBsaWVzIHdoZW4gbm8gcnVuIGlzIHVuZGVyIHdheSAoU3dpc3MsIG9yIGJlZm9yZSBhIENoYW1waW9uIHJ1biBzdGFydHMpXG4gIGNvbnN0IGtlZXBJZCA9IHJpZ2h0Py5pZCA9PT0gc2NlbmVJZCA/IGxlZnQ/LmlkIDogbnVsbDtcbiAgYXdhaXQgbG9hZE5ld1BhaXIoa2VlcElkID8/IG51bGwpO1xufVxuXG4vKiogQ2xlYW4gbW9kZTogU3Rhc2gncyBvd24gZGVsZXRlIGRpYWxvZyBkb2VzIHRoZSBkZWxldGluZzsgdGhlbiBjb250aW51ZSB0aGUgYmF0dGxlIHdpdGhvdXQgaXQuICovXG5hc3luYyBmdW5jdGlvbiBkZWxldGVGcm9tQmF0dGxlKHNjZW5lOiBTY2VuZSk6IFByb21pc2U8dm9pZD4ge1xuICBpZiAoc3RhdGUuZGlzYWJsZUNob2ljZSkgcmV0dXJuO1xuICBjb25zdCBkZWxldGVkID0gYXdhaXQgY29uZmlybURlbGV0ZVNjZW5lKHNjZW5lKTtcbiAgaWYgKCFkZWxldGVkKSByZXR1cm47XG5cbiAgc3RhdGUuZGlzYWJsZUNob2ljZSA9IHRydWU7XG4gIGF3YWl0IGhhbmRsZVNjZW5lR29uZShzY2VuZS5pZCk7XG59XG5cbi8qKiBFTE8gdXNlZCBpbiBiYXR0bGUgbWF0aDogdW5yYXRlZCBzY2VuZXMgY291bnQgYXMgRUxPX1NUQVJUICgxNTAwKSBpbiBTd2lzcywgQ0hBTVBJT05fVU5SQVRFRF9FTE8gaW4gQ2hhbXBpb24uICovXG5mdW5jdGlvbiBiYXR0bGVFbG8oc2NlbmU6IFNjZW5lKTogbnVtYmVyIHtcbiAgcmV0dXJuIHN0YXRlLmN1cnJlbnRNb2RlID09PSBcImNoYW1waW9uXCIgPyBlZmZlY3RpdmVFbG8oc2NlbmUsIENIQU1QSU9OX1VOUkFURURfRUxPKSA6IGVmZmVjdGl2ZUVsbyhzY2VuZSk7XG59XG5cbmludGVyZmFjZSBFbG9DaGFuZ2Uge1xuICBmcm9tOiBudW1iZXI7XG4gIHRvOiBudW1iZXI7XG59XG5cbi8qKlxuICogVHdvLXNpZGVkIEVMTyBmb3IgYSBwaWNrIChTd2lzcyBhbmQgQ2hhbXBpb24pOiBib3RoIHNjZW5lcycgRUxPIGFuZCBiYXR0bGVzIGNoYW5nZSBhbmQgYXJlXG4gKiBzYXZlZC4gYHVwc2V0YCBpcyB0cnVlIHdoZW4gdGhlIHdpbm5lciB3YXMgYSByZWFsIHVuZGVyZG9nIChzZWUgVVBTRVRfTUFYX0NIQU5DRSkuXG4gKi9cbmZ1bmN0aW9uIHJlc29sdmVDb21wYXJpc29uKHdpbm5lcjogU2NlbmUsIGxvc2VyOiBTY2VuZSk6IHsgd2lubmVyOiBFbG9DaGFuZ2U7IGxvc2VyOiBFbG9DaGFuZ2U7IHVwc2V0OiBib29sZWFuIH0ge1xuICAvLyBUaGUgbWF0aCByZWFkcyB0aGUgY2FjaGVkIGNvcGllczogdGhlIHBhaXIncyBvd24gb2JqZWN0cyBtYXkgcHJlZGF0ZSBhIGJhY2tncm91bmQgcmVmcmVzaFxuICBjb25zdCBsYXRlc3RXaW5uZXIgPSBsYXRlc3RTY2VuZSh3aW5uZXIpO1xuICBjb25zdCBsYXRlc3RMb3NlciA9IGxhdGVzdFNjZW5lKGxvc2VyKTtcbiAgY29uc3Qgd2lubmVyU2lkZSA9IHsgZWxvOiBiYXR0bGVFbG8obGF0ZXN0V2lubmVyKSwga0dhbWVzOiBrR2FtZXMobGF0ZXN0V2lubmVyKSB9O1xuICBjb25zdCBsb3NlclNpZGUgPSB7IGVsbzogYmF0dGxlRWxvKGxhdGVzdExvc2VyKSwga0dhbWVzOiBrR2FtZXMobGF0ZXN0TG9zZXIpIH07XG4gIGNvbnN0IHJlc3VsdCA9IGVsb1Jlc3VsdCh3aW5uZXJTaWRlLCBsb3NlclNpZGUpO1xuXG4gIHZvaWQgd3JpdGVFbG8od2lubmVyLCByZXN1bHQud2lubmVyLCBiYXR0bGVzKGxhdGVzdFdpbm5lcikgKyAxKTtcbiAgdm9pZCB3cml0ZUVsbyhsb3NlciwgcmVzdWx0Lmxvc2VyLCBiYXR0bGVzKGxhdGVzdExvc2VyKSArIDEpO1xuXG4gIHJldHVybiB7XG4gICAgd2lubmVyOiB7IGZyb206IHdpbm5lclNpZGUuZWxvLCB0bzogcmVzdWx0Lndpbm5lciB9LFxuICAgIGxvc2VyOiB7IGZyb206IGxvc2VyU2lkZS5lbG8sIHRvOiByZXN1bHQubG9zZXIgfSxcbiAgICB1cHNldDogd2luQ2hhbmNlcyh3aW5uZXJTaWRlLmVsbywgbG9zZXJTaWRlLmVsbylbMF0gPD0gVVBTRVRfTUFYX0NIQU5DRSxcbiAgfTtcbn1cblxuLyoqIFNob3cgd2hlbiBDaGFtcGlvbiArIGZpbHRlciBvcHBvbmVudHMgKyBzbWFsbCBmaWx0ZXJlZCBwb29sLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHVwZGF0ZUNsaW1iUG9vbFdhcm5pbmcoKTogdm9pZCB7XG4gIGNvbnN0IHdhcm5pbmcgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInNiLWNsaW1iLXBvb2wtd2FybmluZ1wiKTtcbiAgaWYgKCF3YXJuaW5nKSByZXR1cm47XG5cbiAgY29uc3QgaXNDbGltYiA9IHN0YXRlLmN1cnJlbnRNb2RlID09PSBcImNoYW1waW9uXCI7XG4gIGNvbnN0IGZpbHRlcnMgPSByZWFkRmlsdGVycygpO1xuICBjb25zdCBzbWFsbFBvb2wgPVxuICAgIHN0YXRlLnRvdGFsU2NlbmVzQ291bnQgPiAwICYmIHN0YXRlLnRvdGFsU2NlbmVzQ291bnQgPCBDTElNQl9TTUFMTF9QT09MX1dBUk5fQVQ7XG5cbiAgd2FybmluZy5oaWRkZW4gPSAhKFxuICAgIGlzQ2xpbWIgJiZcbiAgICBzdGF0ZS5zZXR0aW5ncy5maWx0ZXJPcHBvbmVudHMgJiZcbiAgICBmaWx0ZXJzLmZpbHRlckFjdGl2ZSAmJlxuICAgIHNtYWxsUG9vbFxuICApO1xufVxuXG4vKiogUGxhY2VtZW50OiByZWNvcmQgdGhlIHJlc3VsdDsgdGhlIG5leHQgcGFpciAob3IgdGhlIGZpbmFsIHBsYWNlbWVudCkgY29tZXMgZnJvbSB0aGUgZmV0Y2guICovXG5mdW5jdGlvbiBoYW5kbGVQbGFjZW1lbnRDaG9pY2UoY2hvaWNlOiBTY2VuZUNob2ljZSk6IHZvaWQge1xuICBjb25zdCBydW4gPSBzdGF0ZS5wbGFjZW1lbnQ7XG4gIGlmICghcnVuKSB7XG4gICAgc3RhdGUuZGlzYWJsZUNob2ljZSA9IGZhbHNlO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHdvbiA9IGNob2ljZS53aW5uZXIuaWQgPT09IHJ1bi5zY2VuZS5pZDtcbiAgcmVjb3JkUGxhY2VtZW50UmVzdWx0KHJ1biwgd29uLCB3b24gPyBjaG9pY2UubG9zZXIuaWQgOiBjaG9pY2Uud2lubmVyLmlkKTtcbiAgc2F2ZVN0YXRlKCk7XG5cbiAgY2hvaWNlLndpbm5lckNhcmQuY2xhc3NMaXN0LmFkZChcInNiLXdpbm5lclwiKTtcbiAgY2hvaWNlLmxvc2VyQ2FyZC5jbGFzc0xpc3QuYWRkKFwic2ItbG9zZXJcIik7XG4gIHNldFRpbWVvdXQoKCkgPT4gbG9hZE5ld1BhaXIoKSwgNjAwKTtcbn1cblxuLyoqIENoYW1waW9uOiB0d28tc2lkZWQgRUxPIGV2ZXJ5IHBpY2s7IHRoZSB3aW5uZXIgZGVmZW5kcyBuZXh0IChhIG5ldyB3aW5uZXIgdGFrZXMgb3ZlcikuICovXG5mdW5jdGlvbiBoYW5kbGVDaGFtcGlvbkNob2ljZShjaG9pY2U6IFNjZW5lQ2hvaWNlKTogdm9pZCB7XG4gIGNvbnN0IHsgd2lubmVyOiB3aW5uZXJTY2VuZSwgbG9zZXI6IGxvc2VyU2NlbmUsIGxlZnQsIHdpbm5lckNhcmQsIGxvc2VyQ2FyZCB9ID0gY2hvaWNlO1xuXG4gIGlmICghc3RhdGUuY2hhbXBpb25TY2VuZSkgc3RhdGUuY2hhbXBpb25TY2VuZSA9IGxlZnQ7XG4gIGNvbnN0IGNoYW5nZSA9IHJlc29sdmVDb21wYXJpc29uKHdpbm5lclNjZW5lLCBsb3NlclNjZW5lKTtcblxuICBpZiAod2lubmVyU2NlbmUuaWQgPT09IHN0YXRlLmNoYW1waW9uU2NlbmUuaWQpIHtcbiAgICBzdGF0ZS5jaGFtcGlvbkRlZmVhdGVkLnB1c2gobG9zZXJTY2VuZS5pZCk7XG4gICAgc3RhdGUuY2hhbXBpb25XaW5zKys7XG4gIH0gZWxzZSB7XG4gICAgc3RhdGUuY2hhbXBpb25TY2VuZSA9IHdpbm5lclNjZW5lO1xuICAgIHN0YXRlLmNoYW1waW9uRGVmZWF0ZWQgPSBbbG9zZXJTY2VuZS5pZF07XG4gICAgc3RhdGUuY2hhbXBpb25XaW5zID0gMTtcbiAgfVxuXG4gIHNhdmVTdGF0ZSgpO1xuXG4gIHNob3dQaWNrUmVzdWx0KHdpbm5lckNhcmQsIGxvc2VyQ2FyZCwgY2hhbmdlKTtcbn1cblxuLyoqIFdpbm5lci9sb3NlciBjYXJkIHN0eWxlcyBhbmQgYm90aCBFTE8gYW5pbWF0aW9ucywgdGhlbiB0aGUgbmV4dCBwYWlyLiAqL1xuZnVuY3Rpb24gc2hvd1BpY2tSZXN1bHQoXG4gIHdpbm5lckNhcmQ6IEhUTUxFbGVtZW50LFxuICBsb3NlckNhcmQ6IEhUTUxFbGVtZW50LFxuICBjaGFuZ2U6IHsgd2lubmVyOiBFbG9DaGFuZ2U7IGxvc2VyOiBFbG9DaGFuZ2U7IHVwc2V0OiBib29sZWFuIH0sXG4pOiB2b2lkIHtcbiAgd2lubmVyQ2FyZC5jbGFzc0xpc3QuYWRkKFwic2Itd2lubmVyXCIpO1xuICBsb3NlckNhcmQuY2xhc3NMaXN0LmFkZChcInNiLWxvc2VyXCIpO1xuICBzaG93UmF0aW5nQW5pbWF0aW9uKHdpbm5lckNhcmQsIGNoYW5nZS53aW5uZXIuZnJvbSwgY2hhbmdlLndpbm5lci50bywgdHJ1ZSwgY2hhbmdlLnVwc2V0KTtcbiAgc2hvd1JhdGluZ0FuaW1hdGlvbihsb3NlckNhcmQsIGNoYW5nZS5sb3Nlci5mcm9tLCBjaGFuZ2UubG9zZXIudG8sIGZhbHNlKTtcbiAgc2NoZWR1bGVOZXh0UGFpckFmdGVyQW5pbWF0aW9ucygpO1xufVxuXG5mdW5jdGlvbiBoYW5kbGVTY2VuZUNob2ljZShjaG9pY2U6IFNjZW5lQ2hvaWNlKTogdm9pZCB7XG4gIGlmIChzdGF0ZS5kaXNhYmxlQ2hvaWNlKSByZXR1cm47XG4gIHN0YXRlLmRpc2FibGVDaG9pY2UgPSB0cnVlO1xuXG4gIGNvbnN0IHsgd2lubmVyOiB3aW5uZXJTY2VuZSwgbG9zZXI6IGxvc2VyU2NlbmUsIHdpbm5lckNhcmQsIGxvc2VyQ2FyZCB9ID0gY2hvaWNlO1xuXG4gIGlmIChzdGF0ZS5jdXJyZW50TW9kZSA9PT0gXCJwbGFjZW1lbnRcIikge1xuICAgIGhhbmRsZVBsYWNlbWVudENob2ljZShjaG9pY2UpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGlmIChzdGF0ZS5jdXJyZW50TW9kZSA9PT0gXCJjaGFtcGlvblwiKSB7XG4gICAgaGFuZGxlQ2hhbXBpb25DaG9pY2UoY2hvaWNlKTtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBTd2lzczogYm90aCBzY2VuZXMnIEVMTyBjaGFuZ2VzIChib3RoIHN0YXkgaW4gdGhlIHBvb2wpXG4gIGNvbnN0IGNoYW5nZSA9IHJlc29sdmVDb21wYXJpc29uKHdpbm5lclNjZW5lLCBsb3NlclNjZW5lKTtcblxuICBzYXZlU3RhdGUoKTtcblxuICBzaG93UGlja1Jlc3VsdCh3aW5uZXJDYXJkLCBsb3NlckNhcmQsIGNoYW5nZSk7XG59XG5cbmNvbnN0IFJBVElOR19BTklNX01BWF9UT1RBTF9NUyA9IDE0MDA7XG5jb25zdCBSQVRJTkdfQU5JTV9IT0xEX01TID0gMzAwO1xuY29uc3QgUkFUSU5HX0FOSU1fQ09VTlRfQlVER0VUX01TID0gUkFUSU5HX0FOSU1fTUFYX1RPVEFMX01TIC0gUkFUSU5HX0FOSU1fSE9MRF9NUztcbmNvbnN0IFJBVElOR19BTklNX0RFRkFVTFRfU1RFUF9NUyA9IDUwO1xuY29uc3QgUkFUSU5HX0FOSU1fTUlOX1NURVBfTVMgPSA4O1xuXG5mdW5jdGlvbiBzY2hlZHVsZU5leHRQYWlyQWZ0ZXJBbmltYXRpb25zKCk6IHZvaWQge1xuICBzZXRUaW1lb3V0KCgpID0+IGxvYWROZXdQYWlyKCksIDE1MDApO1xufVxuXG4vKipcbiAqIEVMTyBjb3VudC11cC9kb3duIG92ZXJsYXkgKHdob2xlIG51bWJlcnMpOyBsYXJnZSBqdW1wcyBzcGVlZCB1cCBzbyB0aGUgY291bnQgZml0cyB3aXRoaW4gMTQwMG1zLlxuICogYHVwc2V0YCBhZGRzIGEgc21hbGwgXCJVcHNldCFcIiB1bmRlciB0aGUgY2hhbmdlLlxuICovXG5mdW5jdGlvbiBzaG93UmF0aW5nQW5pbWF0aW9uKFxuICBjYXJkOiBIVE1MRWxlbWVudCxcbiAgb2xkRWxvOiBudW1iZXIsXG4gIG5ld0VsbzogbnVtYmVyLFxuICBpc1dpbm5lcjogYm9vbGVhbixcbiAgdXBzZXQgPSBmYWxzZSxcbik6IHZvaWQge1xuICBjb25zdCBvbGRSYXRpbmcgPSBNYXRoLnJvdW5kKG9sZEVsbyk7XG4gIGNvbnN0IG5ld1JhdGluZyA9IE1hdGgucm91bmQobmV3RWxvKTtcbiAgY29uc3QgY2hhbmdlID0gbmV3UmF0aW5nIC0gb2xkUmF0aW5nO1xuICAvLyBDcmVhdGUgb3ZlcmxheVxuICBjb25zdCBvdmVybGF5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgb3ZlcmxheS5jbGFzc05hbWUgPSBgc2ItcmF0aW5nLW92ZXJsYXkgJHtpc1dpbm5lciA/IFwic2ItcmF0aW5nLXdpbm5lclwiIDogXCJzYi1yYXRpbmctbG9zZXJcIn1gO1xuXG4gIGNvbnN0IHJhdGluZ0Rpc3BsYXkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByYXRpbmdEaXNwbGF5LmNsYXNzTmFtZSA9IFwic2ItcmF0aW5nLWRpc3BsYXlcIjtcbiAgcmF0aW5nRGlzcGxheS50ZXh0Q29udGVudCA9IFN0cmluZyhvbGRSYXRpbmcpO1xuXG4gIGNvbnN0IGNoYW5nZURpc3BsYXkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBjaGFuZ2VEaXNwbGF5LmNsYXNzTmFtZSA9IFwic2ItcmF0aW5nLWNoYW5nZVwiO1xuICBjaGFuZ2VEaXNwbGF5LnRleHRDb250ZW50ID0gY2hhbmdlID4gMCA/IGArJHtjaGFuZ2V9YCA6IFN0cmluZyhjaGFuZ2UpO1xuXG4gIG92ZXJsYXkuYXBwZW5kQ2hpbGQocmF0aW5nRGlzcGxheSk7XG4gIG92ZXJsYXkuYXBwZW5kQ2hpbGQoY2hhbmdlRGlzcGxheSk7XG4gIGlmICh1cHNldCkge1xuICAgIGNvbnN0IHVwc2V0RGlzcGxheSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgdXBzZXREaXNwbGF5LmNsYXNzTmFtZSA9IFwic2ItcmF0aW5nLXVwc2V0XCI7XG4gICAgdXBzZXREaXNwbGF5LnRleHRDb250ZW50ID0gXCJVcHNldCFcIjtcbiAgICBvdmVybGF5LmFwcGVuZENoaWxkKHVwc2V0RGlzcGxheSk7XG4gIH1cbiAgY2FyZC5hcHBlbmRDaGlsZChvdmVybGF5KTtcblxuICBjb25zdCB0b3RhbFN0ZXBzID0gTWF0aC5hYnMoY2hhbmdlKTtcbiAgaWYgKHRvdGFsU3RlcHMgPT09IDApIHtcbiAgICByYXRpbmdEaXNwbGF5LnRleHRDb250ZW50ID0gU3RyaW5nKG5ld1JhdGluZyk7XG4gICAgc2V0VGltZW91dCgoKSA9PiBvdmVybGF5LnJlbW92ZSgpLCBSQVRJTkdfQU5JTV9NQVhfVE9UQUxfTVMpO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IHN0ZXBNcyA9IE1hdGgubWluKFxuICAgIFJBVElOR19BTklNX0RFRkFVTFRfU1RFUF9NUyxcbiAgICBNYXRoLm1heChSQVRJTkdfQU5JTV9NSU5fU1RFUF9NUywgTWF0aC5yb3VuZChSQVRJTkdfQU5JTV9DT1VOVF9CVURHRVRfTVMgLyB0b3RhbFN0ZXBzKSksXG4gICk7XG5cbiAgbGV0IGN1cnJlbnREaXNwbGF5ID0gb2xkUmF0aW5nO1xuICBjb25zdCBzdGVwID0gY2hhbmdlID4gMCA/IDEgOiAtMTtcbiAgbGV0IHN0ZXBDb3VudCA9IDA7XG5cbiAgY29uc3QgaW50ZXJ2YWwgPSBzZXRJbnRlcnZhbCgoKSA9PiB7XG4gICAgc3RlcENvdW50Kys7XG4gICAgY3VycmVudERpc3BsYXkgKz0gc3RlcDtcbiAgICByYXRpbmdEaXNwbGF5LnRleHRDb250ZW50ID0gU3RyaW5nKGN1cnJlbnREaXNwbGF5KTtcblxuICAgIGlmIChzdGVwQ291bnQgPj0gdG90YWxTdGVwcykge1xuICAgICAgY2xlYXJJbnRlcnZhbChpbnRlcnZhbCk7XG4gICAgICByYXRpbmdEaXNwbGF5LnRleHRDb250ZW50ID0gU3RyaW5nKG5ld1JhdGluZyk7XG4gICAgfVxuICB9LCBzdGVwTXMpO1xuXG4gIHNldFRpbWVvdXQoKCkgPT4gb3ZlcmxheS5yZW1vdmUoKSwgUkFUSU5HX0FOSU1fTUFYX1RPVEFMX01TKTtcbn1cbiIsICIvLyBTaGFyZWQgaWNvbnMuXG5cbi8qKiBUaGUgY3Jvc3NlZCBzd29yZHMgKDM2eDM2LCBmaWxsZWQgd2l0aCBjdXJyZW50Q29sb3IpOiB0aGUgbmF2YmFyIGJ1dHRvbiBhbmQgdGhlIHNjZW5lIHBhZ2UncyBFTE8uICovXG5leHBvcnQgY29uc3QgU1dPUkRTX1BBVEhTID0gYFxuICA8cGF0aCBmaWxsPVwiY3VycmVudENvbG9yXCIgZD1cIm0yNCAyOSA1LTVMNiAxSDF2NXpcIi8+XG4gIDxwYXRoIGZpbGw9XCJjdXJyZW50Q29sb3JcIiBkPVwiTTEgMXY1bDIzIDIzIDIuNS0yLjV6XCIvPlxuICA8cGF0aCBmaWxsPVwiY3VycmVudENvbG9yXCIgZD1cIk0zMy40MjQgMzIuODA4Yy4yODQtLjI4NC40NTgtLjYyNi41MzEtLjk2OGwtNS4yNDItNi4xOTUtLjctLjcwMmMtLjU2NS0uNTY0LTEuNTctLjQ3My0yLjI0OS4yMDVsLS42MTQuNjEyYy0uNjc3LjY3Ny0uNzY4IDEuNjgzLS4yMDQgMi4yNDdsLjc0MS43NDEgNi4xNSA1LjIwNWMuMzQ1LS4wNzIuNjg4LS4yNDcuOTc0LS41MzJ6XCIvPlxuICA8cGF0aCBmaWxsPVwiY3VycmVudENvbG9yXCIgZD1cIk0zMy40MjQgMzIuODA4Yy4yODQtLjI4NC40NTgtLjYyNi41MzEtLjk2OGwtMS4zNDItMS41ODYtLjczNyAzLjY4NGMuMzMxLS4wNzcuNjYxLS4yNDMuOTM1LS41MTh6bS0zLjMxLTUuNTA2LS44ODggNC40NCAxLjI2IDEuMDY3LjgyLTQuMXptLTEuNC0xLjY1Ny0uNzAyLS43MDJhMS4yIDEuMiAwIDAgMC0uMzI2LS4yMjRsLS45NzggNC44OTIgMS4yNiAxLjA2Ni45NTctNC43ODN6bS0yLjQwMi0uODg4YTIgMiAwIDAgMC0uNTQ4LjM5MmwtLjYxNC42MWEyIDIgMCAwIDAtLjUxLjg2Yy0uMTQzLjUxLS4wNDcgMS4wMzYuMzA2IDEuMzg4bC41OTYuNTk2em0wIDBxMC0uMDAzIDAgMFwiLz5cbiAgPHBhdGggZmlsbD1cImN1cnJlbnRDb2xvclwiIGQ9XCJNMzMuMjUgMzZhMi43NSAyLjc1IDAgMSAwIDAtNS41IDIuNzUgMi43NSAwIDAgMCAwIDUuNU0yOS42MjYgMjIuMzI0YTEuMDM0IDEuMDM0IDAgMCAxIDAgMS40NjJsLTYuMDkyIDYuMDkyYTEuMDMyIDEuMDMyIDAgMCAxLTEuNjg2LS4zMzYgMS4wMyAxLjAzIDAgMCAxIC4yMjQtMS4xMjZsNi4wOTItNi4wOTJhMS4wMzMgMS4wMzMgMCAwIDEgMS40NjIgMFwiLz5cbiAgPHBhdGggZmlsbD1cImN1cnJlbnRDb2xvclwiIGQ9XCJNMjIuMDcyIDMxLjYyN2ExLjc1IDEuNzUgMCAxIDAgMC0zLjUgMS43NSAxLjc1IDAgMCAwIDAgMy41TTI5LjYyNiAyNC4wNzNhMS43NSAxLjc1IDAgMSAwIDAtMy41IDEuNzUgMS43NSAwIDAgMCAwIDMuNVwiLz5cbiAgPHBhdGggZmlsbD1cImN1cnJlbnRDb2xvclwiIGQ9XCJNMjIuMDcyIDMwLjg3N2ExIDEgMCAxIDAgMC0yIDEgMSAwIDAgMCAwIDJNMjkuNjI2IDIzLjMyM2ExIDEgMCAxIDAgMC0yIDEgMSAwIDAgMCAwIDJNMzMuOTAzIDI5LjM0MmEuNzYuNzYgMCAwIDEgMCAxLjA3OGwtMy40NzYgMy40NzVhLjc2Mi43NjIgMCAwIDEtMS4wNzgtMS4wNzhsMy40NzYtMy40NzVhLjc2Ljc2IDAgMCAxIDEuMDc4IDBNMTIgMjlsLTUtNUwzMCAxaDV2NXpcIi8+XG4gIDxwYXRoIGZpbGw9XCJjdXJyZW50Q29sb3JcIiBkPVwiTTM1IDF2NUwxMiAyOWwtMi41LTIuNXpcIi8+XG4gIDxwYXRoIGZpbGw9XCJjdXJyZW50Q29sb3JcIiBkPVwiTTIuNTc2IDMyLjgwOGExLjk1IDEuOTUgMCAwIDEtLjUzMS0uOTY4bDUuMjQyLTYuMTk1LjctLjcwMmMuNTY1LS41NjQgMS41Ny0uNDczIDIuMjQ5LjIwNWwuNjEzLjYxMmMuNjc3LjY3Ny43NjggMS42ODMuMjA0IDIuMjQ3bC0uNzQxLjc0MS02LjE1IDUuMjA1YTEuOTUgMS45NSAwIDAgMS0uOTc0LS41MzJ6XCIvPlxuICA8cGF0aCBmaWxsPVwiY3VycmVudENvbG9yXCIgZD1cIk0yLjU3NiAzMi44MDhhMS45NSAxLjk1IDAgMCAxLS41MzEtLjk2OGwxLjM0Mi0xLjU4Ni43MzcgMy42ODRhMS45MyAxLjkzIDAgMCAxLS45MzUtLjUxOHptMy4zMS01LjUwNi44ODggNC40NC0xLjI2IDEuMDY3LS44Mi00LjF6bTEuNC0xLjY1Ny43MDItLjcwMmExLjIgMS4yIDAgMCAxIC4zMjYtLjIyNGwuOTc4IDQuODkyLTEuMjYgMS4wNjYtLjk1Ny00Ljc4M3ptMi40MDItLjg4OGMuMTk1LjA5NS4zODIuMjI1LjU0OC4zOTJsLjYxMy42MTJjLjI1NC4yNTQuNDI1LjU1NC41MS44Ni4xNDMuNTEuMDQ3IDEuMDM1LS4zMDYgMS4zODdsLS41OTYuNTk2em0wIDBxMC0uMDAzIDAgMFwiLz5cbiAgPHBhdGggZmlsbD1cImN1cnJlbnRDb2xvclwiIGQ9XCJNMi43NSAzNmEyLjc1IDIuNzUgMCAxIDAgMC01LjUgMi43NSAyLjc1IDAgMCAwIDAgNS41TTYuMzc0IDIyLjMyNGExLjAzNCAxLjAzNCAwIDAgMCAwIDEuNDYybDYuMDkyIDYuMDkyYTEuMDMzIDEuMDMzIDAgMSAwIDEuNDYyLTEuNDYybC02LjA5Mi02LjA5MmExLjAzMyAxLjAzMyAwIDAgMC0xLjQ2MiAwXCIvPlxuICA8cGF0aCBmaWxsPVwiY3VycmVudENvbG9yXCIgZD1cIk0xMy45MjggMzEuNjI3YTEuNzUgMS43NSAwIDEgMCAwLTMuNSAxLjc1IDEuNzUgMCAwIDAgMCAzLjVNNi4zNzQgMjQuMDczYTEuNzUgMS43NSAwIDEgMCAwLTMuNSAxLjc1IDEuNzUgMCAwIDAgMCAzLjVcIi8+XG4gIDxwYXRoIGZpbGw9XCJjdXJyZW50Q29sb3JcIiBkPVwiTTEzLjkyOCAzMC44NzdhMSAxIDAgMSAwIDAtMiAxIDEgMCAwIDAgMCAyTTYuMzc0IDIzLjMyM2ExIDEgMCAxIDAgMC0yIDEgMSAwIDAgMCAwIDJNMi4wOTcgMjkuMzQyYS43Ni43NiAwIDAgMCAwIDEuMDc4bDMuNDc2IDMuNDc1YS43NjMuNzYzIDAgMCAwIDEuMDc4LTEuMDc4bC0zLjQ3Ni0zLjQ3NWEuNzYuNzYgMCAwIDAtMS4wNzggMFwiLz5cbmA7XG4iLCAiLy8gVGhlIHNjZW5lJ3MgRUxPIGFuZCByYW5rIG9uIFN0YXNoJ3Mgb3duIHNjZW5lIHBhZ2UsIGFzIG9uZSBtb3JlIGl0ZW0gaW4gdGhlIHRvb2xiYXIgbmV4dCB0b1xuLy8gUGxheSBDb3VudCBhbmQgTyBDb3VudDogYSBzaW5nbGUgU3Rhc2ggXCJtaW5pbWFsXCIgYnV0dG9uIChpY29uIGFuZCB0ZXh0IGhpZ2hsaWdodCB0b2dldGhlcikuXG4vL1xuLy8gU3Rhc2gncyBTY2VuZVBhZ2UgaXNuJ3QgYSBwYXRjaGFibGUgY29tcG9uZW50LCBzbyB0aGUgaXRlbSBpcyBhZGRlZCB0byB0aGUgRE9NIGFuZCByZS1hZGRlZFxuLy8gd2hlbmV2ZXIgUmVhY3QgcmUtcmVuZGVycyB0aGUgdG9vbGJhci4gVGhlIHJhbmsgY29tZXMgZnJvbSBTdGFzaCBCYXR0bGUncyBhbGwtc2NlbmVzIGNhY2hlLCB0aGVcbi8vIHNhbWUgcGxhY2UgdGhlIGJhdHRsZSBjYXJkcyBnZXQgdGhlaXJzIChTdGFzaCBjYW4ndCBjb3VudCBzY2VuZXMgYnkgYSBudW1lcmljIGN1c3RvbSBmaWVsZCkuXG5cbmltcG9ydCB7IGdldEFsbFNjZW5lc0NhY2hlZCB9IGZyb20gXCIuLi9jYWNoZVwiO1xuaW1wb3J0IHsgZmV0Y2hTY2VuZUJ5SWQsIGdldFNjZW5lSWRGcm9tVXJsLCBzY2VuZUN1c3RvbUZpZWxkc1N1cHBvcnRlZCB9IGZyb20gXCIuLi9ncmFwaHFsXCI7XG5pbXBvcnQgeyBlbG8sIGlzUHJvdmlzaW9uYWwsIGlzUmF0ZWQgfSBmcm9tIFwiLi4vc2NvcmVcIjtcbmltcG9ydCB7IGxvYWRTZXR0aW5ncyB9IGZyb20gXCIuLi9zZXR0aW5nc1wiO1xuaW1wb3J0IHsgc3RhdGUgfSBmcm9tIFwiLi4vc3RhdGVcIjtcbmltcG9ydCB7IHRpZXJEZXNjcmlwdGlvbiwgdGllck1hcCB9IGZyb20gXCIuLi9zdGF0c1wiO1xuaW1wb3J0IHR5cGUgeyBTY2VuZSwgVGllciB9IGZyb20gXCIuLi90eXBlc1wiO1xuaW1wb3J0IHsgU1dPUkRTX1BBVEhTIH0gZnJvbSBcIi4vaWNvbnNcIjtcbmltcG9ydCB7IFBST1ZJU0lPTkFMX1RJUCB9IGZyb20gXCIuL3NjZW5lQ2FyZFwiO1xuXG5jb25zdCBJVEVNX0NMQVNTID0gXCJzYi1zY2VuZS1lbG9cIjtcbmNvbnN0IFRJVExFID0gXCJTdGFzaCBCYXR0bGUgRUxPLCBhbmQgcmFuayBpbiB5b3VyIGxpYnJhcnkuIENsaWNrIHRvIGJhdHRsZSB0aGlzIHNjZW5lLlwiO1xuXG4vKiogXCJFTE8gMTc0MCDCtyAjNTBcIiAoYSBcIj9cIiBhZnRlciBhIHByb3Zpc2lvbmFsIEVMTyksIG9yIFwiRUxPIMK3IFVucmF0ZWRcIiBmb3IgYSBzY2VuZSB3aXRoIG5vIEVMTyB5ZXQuICovXG5mdW5jdGlvbiBsYWJlbFRleHQoc2NlbmU6IFNjZW5lLCByYW5rOiBudW1iZXIgfCBudWxsKTogc3RyaW5nIHtcbiAgY29uc3QgdmFsdWUgPSBlbG8oc2NlbmUpO1xuICBpZiAodmFsdWUgPT09IG51bGwpIHJldHVybiBcIkVMTyDCtyBVbnJhdGVkXCI7XG4gIHJldHVybiBgRUxPICR7TWF0aC5yb3VuZCh2YWx1ZSl9JHtpc1Byb3Zpc2lvbmFsKHNjZW5lKSA/IFwiP1wiIDogXCJcIn0ke3JhbmsgIT09IG51bGwgPyBgIMK3ICMke3Jhbmt9YCA6IFwiXCJ9YDtcbn1cblxuLyoqIFRoZSBidXR0b24ncyB0b29sdGlwLCB3aXRoIHRoZSBwcm92aXNpb25hbCBub3RlIGFuZCB0aGUgdGllciAod2hlbiB0aWVycyBhcmUgb24pIGFkZGVkLiAqL1xuZnVuY3Rpb24gdGl0bGVUZXh0KHNjZW5lOiBTY2VuZSwgdGllcjogVGllciB8IG51bGwpOiBzdHJpbmcge1xuICBjb25zdCBsaW5lcyA9IFtUSVRMRV07XG4gIGlmIChpc1Byb3Zpc2lvbmFsKHNjZW5lKSkgbGluZXMucHVzaChQUk9WSVNJT05BTF9USVApO1xuICBpZiAodGllciAmJiBzdGF0ZS5zZXR0aW5ncy5zaG93VGllcnMpIGxpbmVzLnB1c2goYCR7dGllci5lbW9qaX0gJHt0aWVyRGVzY3JpcHRpb24odGllcil9YCk7XG4gIHJldHVybiBsaW5lcy5qb2luKFwiXFxuXCIpO1xufVxuXG4vKipcbiAqIFRoZSBzY2VuZSAoZnJvbSB0aGUgY2FjaGUsIG9yIGZldGNoZWQgaWYgaXQncyBuZXdlciB0aGFuIHRoZSBjYWNoZSksIGl0cyByYW5rIGFtb25nIHJhdGVkXG4gKiBzY2VuZXMgYW5kIGl0cyB0aWVyLlxuICovXG5hc3luYyBmdW5jdGlvbiBzY2VuZUFuZFJhbmsoc2NlbmVJZDogc3RyaW5nKTogUHJvbWlzZTx7IHNjZW5lOiBTY2VuZTsgcmFuazogbnVtYmVyIHwgbnVsbDsgdGllcjogVGllciB8IG51bGwgfSB8IG51bGw+IHtcbiAgY29uc3QgeyBzY2VuZXMgfSA9IGF3YWl0IGdldEFsbFNjZW5lc0NhY2hlZCgpO1xuICAvLyBUaGUgY2FjaGUgaXMgc29ydGVkIGJ5IEVMTyB3aXRoIHVucmF0ZWQgc2NlbmVzIGxhc3QsIHNvIGEgcmF0ZWQgc2NlbmUncyBpbmRleCBpcyBpdHMgcmFua1xuICBjb25zdCBpbmRleCA9IHNjZW5lcy5maW5kSW5kZXgoKHMpID0+IHMuaWQgPT09IHNjZW5lSWQpO1xuICBpZiAoaW5kZXggPj0gMCkge1xuICAgIGNvbnN0IHNjZW5lID0gc2NlbmVzW2luZGV4XTtcbiAgICByZXR1cm4geyBzY2VuZSwgcmFuazogaXNSYXRlZChzY2VuZSkgPyBpbmRleCArIDEgOiBudWxsLCB0aWVyOiB0aWVyTWFwKHNjZW5lcykuZ2V0KHNjZW5lSWQpID8/IG51bGwgfTtcbiAgfVxuICBjb25zdCBzY2VuZSA9IGF3YWl0IGZldGNoU2NlbmVCeUlkKHNjZW5lSWQpO1xuICByZXR1cm4gc2NlbmUgPyB7IHNjZW5lLCByYW5rOiBudWxsLCB0aWVyOiBudWxsIH0gOiBudWxsO1xufVxuXG4vKiogU2V0dGluZ3MgbG9hZCB3aXRoIFN0YXNoIEJhdHRsZTsgb24gYSBzY2VuZSBwYWdlIGl0IG1heSBub3QgaGF2ZSBvcGVuZWQgeWV0IChvbmNlIHBlciBwYWdlIGxvYWQpLiAqL1xubGV0IHNldHRpbmdzTG9hZDogUHJvbWlzZTxib29sZWFuPiB8IG51bGwgPSBudWxsO1xuXG4vKiogT3BlbnMgU3Rhc2ggQmF0dGxlIChvbiBhIHNjZW5lIHBhZ2UsIHdpdGggdGhpcyBzY2VuZSBpbiB0aGUgYmF0dGxlKS4gU2V0IGJ5IHJlZ2lzdGVyU2NlbmVFbG8uICovXG5sZXQgb3BlbkJhdHRsZTogKCkgPT4gdm9pZCA9ICgpID0+IHt9O1xuXG4vKiogT25lIFN0YXNoIFwibWluaW1hbFwiIGJ1dHRvbiB3aXRoIHRoZSBzd29yZHMgYW5kIHRoZSBFTE8sIHNvIGl0IGhvdmVycyBhcyBhIHdob2xlLiAqL1xuZnVuY3Rpb24gY3JlYXRlSXRlbSgpOiBIVE1MRWxlbWVudCB7XG4gIGNvbnN0IGl0ZW0gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwic3BhblwiKTtcbiAgaXRlbS5jbGFzc05hbWUgPSBJVEVNX0NMQVNTO1xuICBpdGVtLmlubmVySFRNTCA9IGBcbiAgICAgIDxidXR0b24gdHlwZT1cImJ1dHRvblwiIGNsYXNzPVwibWluaW1hbCBidG4gYnRuLXNlY29uZGFyeSBzYi1zY2VuZS1lbG8tYnV0dG9uXCIgdGl0bGU9XCIke1RJVExFfVwiPlxuICAgICAgICA8c3ZnIGNsYXNzPVwic3ZnLWlubGluZS0tZmEgZmEtaWNvblwiIGFyaWEtaGlkZGVuPVwidHJ1ZVwiIGZvY3VzYWJsZT1cImZhbHNlXCIgdmlld0JveD1cIjAgMCAzNiAzNlwiIHdpZHRoPVwiMWVtXCIgaGVpZ2h0PVwiMWVtXCI+JHtTV09SRFNfUEFUSFN9PC9zdmc+XG4gICAgICAgIDxzcGFuIGNsYXNzPVwic2Itc2NlbmUtZWxvLXZhbHVlXCI+PC9zcGFuPlxuICAgICAgPC9idXR0b24+YDtcbiAgaXRlbS5xdWVyeVNlbGVjdG9yKFwiYnV0dG9uXCIpPy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4gb3BlbkJhdHRsZSgpKTtcbiAgcmV0dXJuIGl0ZW07XG59XG5cbi8qKiBUaGUgdG9vbGJhciBncm91cCBob2xkaW5nIFBsYXkgQ291bnQgYW5kIE8gQ291bnQ7IHRoZSBpdGVtIGdvZXMgaW4gZnJvbnQgb2YgUGxheSBDb3VudC4gKi9cbmZ1bmN0aW9uIHBsYWNlSXRlbSh0b29sYmFyOiBFbGVtZW50LCBpdGVtOiBIVE1MRWxlbWVudCk6IGJvb2xlYW4ge1xuICBjb25zdCBwbGF5Q291bnQgPSB0b29sYmFyLnF1ZXJ5U2VsZWN0b3IoJ2J1dHRvblt0aXRsZT1cIlBsYXkgQ291bnRcIl0nKT8uY2xvc2VzdChcIi5zY2VuZS10b29sYmFyLWdyb3VwID4gKlwiKTtcbiAgaWYgKHBsYXlDb3VudCkge1xuICAgIHBsYXlDb3VudC5iZWZvcmUoaXRlbSk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgY29uc3QgZ3JvdXAgPSB0b29sYmFyLnF1ZXJ5U2VsZWN0b3IoXCIuc2NlbmUtdG9vbGJhci1ncm91cDpsYXN0LWNoaWxkXCIpO1xuICBpZiAoIWdyb3VwKSByZXR1cm4gZmFsc2U7XG4gIGdyb3VwLnByZXBlbmQoaXRlbSk7XG4gIHJldHVybiB0cnVlO1xufVxuXG5sZXQgcmVuZGVyaW5nOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuLyoqIEFkZCAob3IgdXBkYXRlKSB0aGUgaXRlbSBvbiB0aGUgY3VycmVudCBzY2VuZSBwYWdlLiBTYWZlIHRvIGNhbGwgb2Z0ZW4uICovXG5hc3luYyBmdW5jdGlvbiByZW5kZXJTY2VuZUVsbyhmb3JjZSA9IGZhbHNlKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHNjZW5lSWQgPSBnZXRTY2VuZUlkRnJvbVVybCgpO1xuICBjb25zdCB0b29sYmFyID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihcIi5zY2VuZS10b29sYmFyXCIpO1xuICBpZiAoIXNjZW5lSWQgfHwgIXRvb2xiYXIpIHJldHVybjtcbiAgY29uc3QgZXhpc3RpbmcgPSB0b29sYmFyLnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KGAuJHtJVEVNX0NMQVNTfWApO1xuICBpZiAoIWZvcmNlICYmIGV4aXN0aW5nPy5kYXRhc2V0LnNjZW5lSWQgPT09IHNjZW5lSWQpIHJldHVybjtcbiAgaWYgKHJlbmRlcmluZyA9PT0gc2NlbmVJZCkgcmV0dXJuO1xuXG4gIHJlbmRlcmluZyA9IHNjZW5lSWQ7XG4gIHRyeSB7XG4gICAgaWYgKCEoYXdhaXQgc2NlbmVDdXN0b21GaWVsZHNTdXBwb3J0ZWQoKSkpIHJldHVybjtcbiAgICBzZXR0aW5nc0xvYWQgPz89IGxvYWRTZXR0aW5ncygpO1xuICAgIGNvbnN0IFtyZXN1bHRdID0gYXdhaXQgUHJvbWlzZS5hbGwoW3NjZW5lQW5kUmFuayhzY2VuZUlkKSwgc2V0dGluZ3NMb2FkXSk7XG4gICAgLy8gVGhlIHBhZ2UgbWF5IGhhdmUgbW92ZWQgb24gKGFub3RoZXIgc2NlbmUsIG9yIHRoZSB0b29sYmFyIHJlLXJlbmRlcmVkKSB3aGlsZSB0aGlzIGxvYWRlZFxuICAgIGlmICghcmVzdWx0IHx8IGdldFNjZW5lSWRGcm9tVXJsKCkgIT09IHNjZW5lSWQpIHJldHVybjtcbiAgICBjb25zdCB0YXJnZXQgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKFwiLnNjZW5lLXRvb2xiYXJcIik7XG4gICAgaWYgKCF0YXJnZXQpIHJldHVybjtcblxuICAgIGxldCBpdGVtID0gdGFyZ2V0LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KGAuJHtJVEVNX0NMQVNTfWApO1xuICAgIGlmICghaXRlbSkge1xuICAgICAgaXRlbSA9IGNyZWF0ZUl0ZW0oKTtcbiAgICAgIGlmICghcGxhY2VJdGVtKHRhcmdldCwgaXRlbSkpIHJldHVybjtcbiAgICB9XG4gICAgaXRlbS5kYXRhc2V0LnNjZW5lSWQgPSBzY2VuZUlkO1xuICAgIGNvbnN0IHZhbHVlID0gaXRlbS5xdWVyeVNlbGVjdG9yKFwiLnNiLXNjZW5lLWVsby12YWx1ZVwiKTtcbiAgICBpZiAodmFsdWUpIHZhbHVlLnRleHRDb250ZW50ID0gbGFiZWxUZXh0KHJlc3VsdC5zY2VuZSwgcmVzdWx0LnJhbmspO1xuICAgIGl0ZW0ucXVlcnlTZWxlY3RvcihcImJ1dHRvblwiKT8uc2V0QXR0cmlidXRlKFwidGl0bGVcIiwgdGl0bGVUZXh0KHJlc3VsdC5zY2VuZSwgcmVzdWx0LnRpZXIpKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnNvbGUud2FybihcIltTdGFzaCBCYXR0bGVdIENvdWxkbid0IHNob3cgdGhlIHNjZW5lJ3MgRUxPOlwiLCBlKTtcbiAgfSBmaW5hbGx5IHtcbiAgICByZW5kZXJpbmcgPSBudWxsO1xuICB9XG59XG5cbi8qKiBSZWZyZXNoIHRoZSBpdGVtIGZyb20gdGhlIGNhY2hlIChhZnRlciBiYXR0bGVzIGNoYW5nZSBFTE8pLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlZnJlc2hTY2VuZUVsbygpOiB2b2lkIHtcbiAgdm9pZCByZW5kZXJTY2VuZUVsbyh0cnVlKTtcbn1cblxuLyoqXG4gKiBTaG93IHRoZSBFTE8gaXRlbSBvbiBzY2VuZSBwYWdlcywgcmUtYWRkaW5nIGl0IGFzIFN0YXNoIG5hdmlnYXRlcyBhbmQgcmUtcmVuZGVyczsgY2xpY2tpbmcgaXRcbiAqIGNhbGxzIGBvbkNsaWNrYCAob3BlbnMgU3Rhc2ggQmF0dGxlKS4gQ2FsbCBvbmNlIGF0IHN0YXJ0dXAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWdpc3RlclNjZW5lRWxvKG9uQ2xpY2s6ICgpID0+IHZvaWQpOiB2b2lkIHtcbiAgb3BlbkJhdHRsZSA9IG9uQ2xpY2s7XG4gIGxldCBxdWV1ZWQgPSBmYWxzZTtcbiAgY29uc3QgY2hlY2sgPSAoKTogdm9pZCA9PiB7XG4gICAgcXVldWVkID0gZmFsc2U7XG4gICAgaWYgKGdldFNjZW5lSWRGcm9tVXJsKCkpIHZvaWQgcmVuZGVyU2NlbmVFbG8oKTtcbiAgfTtcbiAgLy8gQmF0Y2hlZCB3aXRoIGEgdGltZXIsIG5vdCBhbiBhbmltYXRpb24gZnJhbWU6IGZyYW1lcyBkb24ndCBydW4gaW4gYSBiYWNrZ3JvdW5kIHRhYlxuICBuZXcgTXV0YXRpb25PYnNlcnZlcigoKSA9PiB7XG4gICAgaWYgKHF1ZXVlZCkgcmV0dXJuO1xuICAgIHF1ZXVlZCA9IHRydWU7XG4gICAgc2V0VGltZW91dChjaGVjaywgNTApO1xuICB9KS5vYnNlcnZlKGRvY3VtZW50LmJvZHksIHsgY2hpbGRMaXN0OiB0cnVlLCBzdWJ0cmVlOiB0cnVlIH0pO1xuICBjaGVjaygpO1xufVxuIiwgIi8vIFNldHVwIHByZXZpZXc6IHRlbiBleGFtcGxlIHNjZW5lcyBpbiB0aHJlZSByb3dzIChub3cgaW4gU3Rhc2ggLyBhZnRlciBzZXR1cCAvIGFmdGVyIGxvdHMgb2Zcbi8vIGJhdHRsZXMpLiBFdmVyeSBudW1iZXIgY29tZXMgZnJvbSB0aGUgcmVhbCBzY29yZS50cyBmdW5jdGlvbnMsIHNvIHRoZSBwcmV2aWV3IGNhbid0IGRyaWZ0XG4vLyBmcm9tIHdoYXQgc2V0dXAgYW5kIHRoZSBTdGFzaCByYXRpbmdzIG9wdGlvbnMgYWN0dWFsbHkgZG8uXG5cbmltcG9ydCB7IEVMT19GSUVMRCB9IGZyb20gXCIuLi9jb25zdGFudHNcIjtcbmltcG9ydCB7IGFmdGVyU2V0dXAsIGVsbywgc3Rhc2hSYXRpbmdUYXJnZXRzIH0gZnJvbSBcIi4uL3Njb3JlXCI7XG5pbXBvcnQgdHlwZSB7IEVsb1N0YXJ0LCBTY2VuZSwgU3Rhc2hSYXRpbmdzTW9kZSB9IGZyb20gXCIuLi90eXBlc1wiO1xuXG4vKiogRXhhbXBsZSBTdGFzaCByYXRpbmdzIHRvZGF5OiB0aGUgdGllIGF0IDEwMCBzaG93cyBob3cgcmF0aW5ncyBidW5jaCB1cCBhdCB0aGUgdG9wLiAqL1xuY29uc3QgTk9XX1JBVElOR1M6IChudW1iZXIgfCBudWxsKVtdID0gWzEwMCwgMTAwLCA5NiwgODUsIDc0LCA3MCwgNjIsIDQ1LCAyMCwgbnVsbF07XG5cbi8qKiBFeGFtcGxlIEVMTyBvbmNlIGJhdHRsZXMgaGF2ZSBzcHJlYWQgdGhlIHNjZW5lcyBvdXQgKHRoZSBzYW1lIGZvciBib3RoIHN0YXJ0IGNob2ljZXMpLiAqL1xuY29uc3QgQkFUVExFRF9FTE8gPSBbMjE1MCwgMTk4MCwgMTcwMCwgMTY1MCwgMTYwMCwgMTU1MCwgMTUwMCwgMTQwMCwgMTI1MCwgMTEwMF07XG5cbmludGVyZmFjZSBTcXVhcmUge1xuICBlbG86IG51bWJlciB8IG51bGw7XG4gIHJhdGluZzogbnVtYmVyIHwgbnVsbDtcbiAgY2hhbmdlZDogYm9vbGVhbjtcbn1cblxuZnVuY3Rpb24gZXhhbXBsZVNjZW5lcygpOiBTY2VuZVtdIHtcbiAgcmV0dXJuIE5PV19SQVRJTkdTLm1hcCgocmF0aW5nMTAwLCBpKSA9PiAoeyBpZDogYGV4YW1wbGUtJHtpfWAsIHJhdGluZzEwMCwgY3VzdG9tX2ZpZWxkczoge30gfSkpO1xufVxuXG4vKiogRWFjaCBzY2VuZSdzIFN0YXNoIHJhdGluZyB1bmRlciB0aGUgbW9kZTogd3JpdHRlbiBvbmVzIGdldCB0aGVpciB0YXJnZXQsIG90aGVycyBzdGF5IGFzIG5vdy4gKi9cbmZ1bmN0aW9uIHNxdWFyZXMoc2NlbmVzOiBTY2VuZVtdLCBtb2RlOiBTdGFzaFJhdGluZ3NNb2RlKTogU3F1YXJlW10ge1xuICBjb25zdCB0YXJnZXRzID0gc3Rhc2hSYXRpbmdUYXJnZXRzKHNjZW5lcywgbW9kZSk7XG4gIHJldHVybiBzY2VuZXMubWFwKChzY2VuZSkgPT4ge1xuICAgIGNvbnN0IHJhdGluZyA9IHRhcmdldHMuZ2V0KHNjZW5lLmlkKSA/PyBzY2VuZS5yYXRpbmcxMDAgPz8gbnVsbDtcbiAgICByZXR1cm4geyBlbG86IGVsbyhzY2VuZSksIHJhdGluZywgY2hhbmdlZDogcmF0aW5nICE9PSAoc2NlbmUucmF0aW5nMTAwID8/IG51bGwpIH07XG4gIH0pO1xufVxuXG5mdW5jdGlvbiBzcXVhcmVIdG1sKHsgZWxvOiBlbG9WYWx1ZSwgcmF0aW5nLCBjaGFuZ2VkIH06IFNxdWFyZSwgc2hvd0NoYW5nZTogYm9vbGVhbik6IHN0cmluZyB7XG4gIGNvbnN0IGNsYXNzZXMgPSBbXCJzYi1wdi1zcXVhcmVcIl07XG4gIGlmIChyYXRpbmcgPT09IG51bGwpIGNsYXNzZXMucHVzaChcInNiLXB2LXVucmF0ZWRcIik7XG4gIGlmIChyYXRpbmcgIT09IG51bGwgJiYgcmF0aW5nID4gNTUpIGNsYXNzZXMucHVzaChcInNiLXB2LXN0cm9uZ1wiKTtcbiAgaWYgKHNob3dDaGFuZ2UgJiYgY2hhbmdlZCkgY2xhc3Nlcy5wdXNoKFwic2ItcHYtY2hhbmdlZFwiKTtcbiAgY29uc3QgZmlsbCA9IHJhdGluZyA9PT0gbnVsbCA/IFwiXCIgOiBgIHN0eWxlPVwiLS1zYi1wdi1maWxsOiAke3JhdGluZ30lXCJgO1xuICByZXR1cm4gYFxuICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNiLXB2LWNlbGxcIj5cbiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9XCJzYi1wdi1lbG9cIj4ke2Vsb1ZhbHVlID09PSBudWxsID8gXCJcIiA6IE1hdGgucm91bmQoZWxvVmFsdWUpfTwvc3Bhbj5cbiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9XCIke2NsYXNzZXMuam9pbihcIiBcIil9XCIke2ZpbGx9PiR7cmF0aW5nID8/IFwi4oCTXCJ9PC9zcGFuPlxuICAgICAgICAgICAgPC9kaXY+YDtcbn1cblxuZnVuY3Rpb24gcm93SHRtbChsYWJlbDogc3RyaW5nLCBjZWxsczogU3F1YXJlW10sIG5vdGU6IHN0cmluZywgb3B0aW9uczogeyBtdXRlZD86IGJvb2xlYW47IHNob3dDaGFuZ2U/OiBib29sZWFuIH0gPSB7fSk6IHN0cmluZyB7XG4gIHJldHVybiBgXG4gICAgICAgICAgPGRpdiBjbGFzcz1cInNiLXB2LXJvdyR7b3B0aW9ucy5tdXRlZCA/IFwiIHNiLXB2LW11dGVkXCIgOiBcIlwifVwiPlxuICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNiLXB2LWxhYmVsXCI+JHtsYWJlbH08L2Rpdj5cbiAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1wdi1zcXVhcmVzXCI+JHtjZWxscy5tYXAoKGNlbGwpID0+IHNxdWFyZUh0bWwoY2VsbCwgb3B0aW9ucy5zaG93Q2hhbmdlID8/IGZhbHNlKSkuam9pbihcIlwiKX1cbiAgICAgICAgICAgIDwvZGl2PlxuICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNiLXB2LW5vdGVcIj4ke25vdGV9PC9kaXY+XG4gICAgICAgICAgPC9kaXY+YDtcbn1cblxuLyoqIEhvdyBsb25nIGEgbnVtYmVyIGNvdW50cyBmcm9tIGl0cyBvbGQgdmFsdWUgdG8gaXRzIG5ldyBvbmUgKGNvbG91cnMgZmFkZSBvdmVyIHRoZSBzYW1lIHRpbWUgaW4gQ1NTKS4gKi9cbmNvbnN0IFRXRUVOX01TID0gNDAwO1xuXG4vKiogUnVubmluZyBjb3VudCBwZXIgZWxlbWVudDogaXRzIGFuaW1hdGlvbiBmcmFtZSwgYW5kIGEgdGltZXIgdGhhdCBsYW5kcyBpdCBpZiBmcmFtZXMgc3RhbGwuICovXG5jb25zdCB0d2VlbnMgPSBuZXcgV2Vha01hcDxFbGVtZW50LCB7IGZyYW1lOiBudW1iZXI7IHRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB9PigpO1xuXG4vKiogQ291bnQgYW4gZWxlbWVudCdzIG51bWJlciBmcm9tIHdoYXQgaXQgc2hvd3Mgbm93IHRvIGB0YXJnZXRgOyBub24tbnVtYmVycyAo4oCTLCBibGFuaykganVzdCBzd2FwLiAqL1xuZnVuY3Rpb24gdHdlZW5UZXh0KGVsOiBFbGVtZW50LCB0YXJnZXQ6IHN0cmluZyk6IHZvaWQge1xuICBjb25zdCBydW5uaW5nID0gdHdlZW5zLmdldChlbCk7XG4gIGlmIChydW5uaW5nKSB7XG4gICAgY2FuY2VsQW5pbWF0aW9uRnJhbWUocnVubmluZy5mcmFtZSk7XG4gICAgY2xlYXJUaW1lb3V0KHJ1bm5pbmcudGltZXIpO1xuICAgIHR3ZWVucy5kZWxldGUoZWwpO1xuICB9XG4gIGNvbnN0IGZyb20gPSBOdW1iZXIoZWwudGV4dENvbnRlbnQpO1xuICBjb25zdCB0byA9IE51bWJlcih0YXJnZXQpO1xuICBpZiAoZWwudGV4dENvbnRlbnQgPT09IFwiXCIgfHwgdGFyZ2V0ID09PSBcIlwiIHx8ICFOdW1iZXIuaXNGaW5pdGUoZnJvbSkgfHwgIU51bWJlci5pc0Zpbml0ZSh0bykgfHwgZnJvbSA9PT0gdG8pIHtcbiAgICBlbC50ZXh0Q29udGVudCA9IHRhcmdldDtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3Qgc3RhcnRUaW1lID0gcGVyZm9ybWFuY2Uubm93KCk7XG4gIC8vIEJhY2tncm91bmQgdGFicyBnZXQgbm8gYW5pbWF0aW9uIGZyYW1lczogbGFuZCBvbiB0aGUgZmluYWwgbnVtYmVyIHJlZ2FyZGxlc3NcbiAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICBjb25zdCBjdXJyZW50ID0gdHdlZW5zLmdldChlbCk7XG4gICAgaWYgKGN1cnJlbnQpIGNhbmNlbEFuaW1hdGlvbkZyYW1lKGN1cnJlbnQuZnJhbWUpO1xuICAgIHR3ZWVucy5kZWxldGUoZWwpO1xuICAgIGVsLnRleHRDb250ZW50ID0gdGFyZ2V0O1xuICB9LCBUV0VFTl9NUyArIDUwKTtcbiAgY29uc3Qgc3RlcCA9IChub3c6IG51bWJlcik6IHZvaWQgPT4ge1xuICAgIGNvbnN0IHQgPSBNYXRoLm1pbigxLCAobm93IC0gc3RhcnRUaW1lKSAvIFRXRUVOX01TKTtcbiAgICBjb25zdCBlYXNlZCA9IDEgLSBNYXRoLnBvdygxIC0gdCwgMyk7XG4gICAgZWwudGV4dENvbnRlbnQgPSBTdHJpbmcoTWF0aC5yb3VuZChmcm9tICsgKHRvIC0gZnJvbSkgKiBlYXNlZCkpO1xuICAgIGlmICh0IDwgMSkgdHdlZW5zLnNldChlbCwgeyBmcmFtZTogcmVxdWVzdEFuaW1hdGlvbkZyYW1lKHN0ZXApLCB0aW1lciB9KTtcbiAgfTtcbiAgdHdlZW5zLnNldChlbCwgeyBmcmFtZTogcmVxdWVzdEFuaW1hdGlvbkZyYW1lKHN0ZXApLCB0aW1lciB9KTtcbn1cblxuLyoqXG4gKiBTaG93IHRoZSBwcmV2aWV3IGluIGBjb250YWluZXJgLiBXaGVuIG9uZSBpcyBhbHJlYWR5IHRoZXJlLCBpdCdzIHVwZGF0ZWQgaW4gcGxhY2Ugc28gdGhlXG4gKiBudW1iZXJzIGNvdW50IHRvIHRoZWlyIG5ldyB2YWx1ZXMgYW5kIHRoZSBjb2xvdXJzIGZhZGUgKENTUyB0cmFuc2l0aW9ucykgaW5zdGVhZCBvZiBqdW1waW5nLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2hvd1JhdGluZ1ByZXZpZXcoY29udGFpbmVyOiBIVE1MRWxlbWVudCwgc3RhcnQ6IEVsb1N0YXJ0LCBzdGFzaFJhdGluZ3M6IFN0YXNoUmF0aW5nc01vZGUpOiB2b2lkIHtcbiAgY29uc3QgbmV4dCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIG5leHQuaW5uZXJIVE1MID0gcmVuZGVyUmF0aW5nUHJldmlldyhzdGFydCwgc3Rhc2hSYXRpbmdzKTtcbiAgY29uc3QgY3VycmVudCA9IGNvbnRhaW5lci5xdWVyeVNlbGVjdG9yKFwiLnNiLXJhdGluZy1wcmV2aWV3XCIpO1xuICBjb25zdCByZWR1Y2VkTW90aW9uID0gd2luZG93Lm1hdGNoTWVkaWEoXCIocHJlZmVycy1yZWR1Y2VkLW1vdGlvbjogcmVkdWNlKVwiKS5tYXRjaGVzO1xuICBpZiAoIWN1cnJlbnQgfHwgcmVkdWNlZE1vdGlvbikge1xuICAgIGNvbnRhaW5lci5yZXBsYWNlQ2hpbGRyZW4oLi4ubmV4dC5jaGlsZE5vZGVzKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBmcmVzaCA9IG5leHQucXVlcnlTZWxlY3RvcihcIi5zYi1yYXRpbmctcHJldmlld1wiKSBhcyBFbGVtZW50O1xuICBjb25zdCBwYWlycyA9IChzZWxlY3Rvcjogc3RyaW5nKTogW0VsZW1lbnQsIEVsZW1lbnRdW10gPT4ge1xuICAgIGNvbnN0IG5vdyA9IGN1cnJlbnQucXVlcnlTZWxlY3RvckFsbChzZWxlY3Rvcik7XG4gICAgcmV0dXJuIFsuLi5mcmVzaC5xdWVyeVNlbGVjdG9yQWxsKHNlbGVjdG9yKV0ubWFwKChlbCwgaSkgPT4gW25vd1tpXSwgZWxdKTtcbiAgfTtcbiAgZm9yIChjb25zdCBbZWwsIHRvXSBvZiBwYWlycyhcIi5zYi1wdi1yb3dcIikpIGVsLmNsYXNzTmFtZSA9IHRvLmNsYXNzTmFtZTtcbiAgZm9yIChjb25zdCBbZWwsIHRvXSBvZiBwYWlycyhcIi5zYi1wdi1ub3RlXCIpKSBlbC50ZXh0Q29udGVudCA9IHRvLnRleHRDb250ZW50O1xuICBmb3IgKGNvbnN0IFtlbCwgdG9dIG9mIHBhaXJzKFwiLnNiLXB2LWVsb1wiKSkgdHdlZW5UZXh0KGVsLCB0by50ZXh0Q29udGVudCA/PyBcIlwiKTtcbiAgZm9yIChjb25zdCBbZWwsIHRvXSBvZiBwYWlycyhcIi5zYi1wdi1zcXVhcmVcIikpIHtcbiAgICBlbC5jbGFzc05hbWUgPSB0by5jbGFzc05hbWU7XG4gICAgZWwuc2V0QXR0cmlidXRlKFwic3R5bGVcIiwgdG8uZ2V0QXR0cmlidXRlKFwic3R5bGVcIikgPz8gXCJcIik7XG4gICAgdHdlZW5UZXh0KGVsLCB0by50ZXh0Q29udGVudCA/PyBcIlwiKTtcbiAgfVxufVxuXG4vKiogVGhlIHByZXZpZXcgZm9yIG9uZSBwYWlyIG9mIHNldHVwIGFuc3dlcnMsIGFzIGFuIEhUTUwgc3RyaW5nLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlclJhdGluZ1ByZXZpZXcoc3RhcnQ6IEVsb1N0YXJ0LCBzdGFzaFJhdGluZ3M6IFN0YXNoUmF0aW5nc01vZGUpOiBzdHJpbmcge1xuICBjb25zdCBvZmYgPSBzdGFzaFJhdGluZ3MgPT09IFwib2ZmXCI7XG4gIGNvbnN0IG5vdyA9IHNxdWFyZXMoZXhhbXBsZVNjZW5lcygpLCBcIm9mZlwiKTtcblxuICBjb25zdCBzZXRVcCA9IHNxdWFyZXMoZXhhbXBsZVNjZW5lcygpLm1hcCgoc2NlbmUpID0+IGFmdGVyU2V0dXAoc2NlbmUsIHN0YXJ0KSksIHN0YXNoUmF0aW5ncyk7XG4gIGNvbnN0IGNoYW5nZWRDb3VudCA9IHNldFVwLmZpbHRlcigoY2VsbCkgPT4gY2VsbC5jaGFuZ2VkKS5sZW5ndGg7XG5cbiAgY29uc3QgYmF0dGxlZCA9IGV4YW1wbGVTY2VuZXMoKS5tYXAoKHNjZW5lLCBpKSA9PiAoeyAuLi5zY2VuZSwgY3VzdG9tX2ZpZWxkczogeyBbRUxPX0ZJRUxEXTogQkFUVExFRF9FTE9baV0gfSB9KSk7XG4gIGNvbnN0IGxhdGVyID0gc3F1YXJlcyhiYXR0bGVkLCBzdGFzaFJhdGluZ3MpO1xuXG4gIGNvbnN0IHVuY2hhbmdlZE5vdGUgPSBcIlN0YXNoIHJhdGluZ3Mgc3RheSBhcyB0aGV5IGFyZVwiO1xuICBjb25zdCBsYXRlck5vdGUgPSBvZmZcbiAgICA/IHVuY2hhbmdlZE5vdGVcbiAgICA6IHN0YXNoUmF0aW5ncyA9PT0gXCJwZXJjZW50aWxlXCJcbiAgICAgID8gXCJFdmVubHkgc3BhY2VkIGJ5IHJhbmssIHdoYXRldmVyIHRoZSBnYXBzXCJcbiAgICAgIDogXCJHYXBzIHNob3csIGJ1dCAyMTUwIGlzIHN0dWNrIGF0IDEwMFwiO1xuXG4gIHJldHVybiBgXG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi1yYXRpbmctcHJldmlld1wiPlxuICAgICAgICAgIDxwIGNsYXNzPVwic2ItcHYtbGVnZW5kXCI+RWFjaCBzcXVhcmUgYmVsb3cgaXMgYW4gZXhhbXBsZSBzY2VuZTogaXRzIEVMTyBhYm92ZSwgaXRzIFN0YXNoIHJhdGluZyBpbnNpZGUuPC9wPlxuICAgICAgICAgICR7cm93SHRtbChcIk5vdyBpbiBTdGFzaFwiLCBub3csIFwiXCIpfVxuICAgICAgICAgICR7cm93SHRtbChcIkFmdGVyIHNldHVwXCIsIHNldFVwLCBvZmYgPyB1bmNoYW5nZWROb3RlIDogYCR7Y2hhbmdlZENvdW50fSBvZiAxMCBjaGFuZ2VgLCB7IG11dGVkOiBvZmYsIHNob3dDaGFuZ2U6ICFvZmYgfSl9XG4gICAgICAgICAgJHtyb3dIdG1sKFwiQWZ0ZXIgbG90cyBvZiBiYXR0bGVzXCIsIGxhdGVyLCBsYXRlck5vdGUsIHsgbXV0ZWQ6IG9mZiB9KX1cbiAgICAgICAgPC9kaXY+YDtcbn1cbiIsICIvLyBPbmUtdGltZSBFTE8gc2V0dXAgc2NyZWVuLCBzaG93biBpbiB0aGUgQmF0dGxlIHRhYiBpbiBwbGFjZSBvZiB0aGUgYmF0dGxlIHVudGlsIGl0J3MgZG9uZS5cbi8vIFR3byBxdWVzdGlvbnMgc2lkZSBieSBzaWRlIChob3cgRUxPIHN0YXJ0cywgd2hldGhlciBTdGFzaCBCYXR0bGUgd3JpdGVzIFN0YXNoIHJhdGluZ3MpIGFib3ZlXG4vLyBhIHNoYXJlZCBwcmV2aWV3LCB0aGVuIGEgcHJvZ3Jlc3MgdmlldyB3aGlsZSBlbG9TZXR1cC50cyB3cml0ZXMsIHRoZW4gYSBzdW1tYXJ5LiBSZXNldCBFTE9cbi8vIChTZXR0aW5ncykgc2hvd3MgdGhlIHNhbWUgc2NyZWVuIGluIHJlc2V0IG1vZGUsIHdpdGggYSBDYW5jZWwgYnV0dG9uLlxuXG5pbXBvcnQgeyBjbGVhclNjZW5lQ2FjaGUgfSBmcm9tIFwiLi4vY2FjaGVcIjtcbmltcG9ydCB7IGZldGNoU2V0dXBTY2VuZXMsIHJ1bkVsb1NldHVwLCBzZXR1cFJhdGluZ0NoYW5nZXMsIHR5cGUgU2V0dXBQaGFzZSwgdHlwZSBTZXR1cFN1bW1hcnkgfSBmcm9tIFwiLi4vZWxvU2V0dXBcIjtcbmltcG9ydCB7IGlzUmF0ZWQgfSBmcm9tIFwiLi4vc2NvcmVcIjtcbmltcG9ydCB7IGhhZEZ1bk1vZGUsIHVwZGF0ZVNldHRpbmdzTm93IH0gZnJvbSBcIi4uL3NldHRpbmdzXCI7XG5pbXBvcnQgeyByZXNldFJ1blN0YXRlLCByZXNldFNodWZmbGUsIHN0YXRlIH0gZnJvbSBcIi4uL3N0YXRlXCI7XG5pbXBvcnQgeyBzYXZlU3RhdGUgfSBmcm9tIFwiLi4vc3RvcmFnZVwiO1xuaW1wb3J0IHR5cGUgeyBFbG9TdGFydCwgU2NlbmUsIFN0YXNoUmF0aW5nc01vZGUgfSBmcm9tIFwiLi4vdHlwZXNcIjtcbmltcG9ydCB7IHNob3dSYXRpbmdQcmV2aWV3IH0gZnJvbSBcIi4vcmF0aW5nUHJldmlld1wiO1xuaW1wb3J0IHsgU1RBU0hfUkFUSU5HU19PUFRJT05TIH0gZnJvbSBcIi4vc3Rhc2hSYXRpbmdzVGV4dFwiO1xuXG4vKiogT24gdGhlIEJhdHRsZSBwYW5lbCB3aGlsZSBzZXR1cCBzaG93czsgQ1NTIGhpZGVzIHRoZSBiYXR0bGUgVUkgKG1vZGVzLCBjYXJkcywgYWN0aW9ucykuICovXG5jb25zdCBTRVRVUF9BQ1RJVkVfQ0xBU1MgPSBcInNiLXNldHVwLWFjdGl2ZVwiO1xuXG4vKiogVHJ1ZSBmcm9tIFN0YXJ0IHVudGlsIHRoZSB3cml0ZXMgZmluaXNoIG9yIGZhaWw7IHJlb3BlbmluZyBCYXR0bGUgbWVhbndoaWxlIGtlZXBzIHRoZSBwcm9ncmVzcy4gKi9cbmxldCBydW5uaW5nID0gZmFsc2U7XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2V0dXBTY3JlZW5PcHRpb25zIHtcbiAgLyoqIFJlc2V0IEVMTzogZXZlcnl0aGluZyBhbHJlYWR5IGhhcyBhbiBFTE87IHRoZSBjdXJyZW50IFN0YXNoIHJhdGluZ3Mgb3B0aW9uIGlzIHByZXNlbGVjdGVkLiAqL1xuICByZXNldD86IGJvb2xlYW47XG4gIC8qKiBSZXNldCBtb2RlJ3MgQ2FuY2VsIGJ1dHRvbiAoYmVmb3JlIGFueXRoaW5nIGlzIHdyaXR0ZW4pLiAqL1xuICBvbkNhbmNlbD86ICgpID0+IHZvaWQ7XG59XG5cbmxldCBvcHRpb25zOiBTZXR1cFNjcmVlbk9wdGlvbnMgPSB7fTtcblxuaW50ZXJmYWNlIENob2ljZSB7XG4gIHN0YXJ0OiBFbG9TdGFydDtcbiAgc3Rhc2hSYXRpbmdzOiBTdGFzaFJhdGluZ3NNb2RlO1xufVxuXG5jb25zdCBwbHVyYWwgPSAobjogbnVtYmVyLCB3b3JkOiBzdHJpbmcpOiBzdHJpbmcgPT4gYCR7bn0gJHt3b3JkfSR7biA9PT0gMSA/IFwiXCIgOiBcInNcIn1gO1xuXG5mdW5jdGlvbiBzZXR1cEFyZWEocm9vdDogUGFyZW50Tm9kZSk6IEhUTUxFbGVtZW50IHwgbnVsbCB7XG4gIHJldHVybiByb290LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiI3NiLXNldHVwLWFyZWFcIik7XG59XG5cbi8qKiBUcnVlIHdoaWxlIHNldHVwIGlzIHdyaXRpbmcgKFN0YXJ0IHByZXNzZWQsIG5vdCBmaW5pc2hlZCBvciBmYWlsZWQgeWV0KS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc1NldHVwUnVubmluZygpOiBib29sZWFuIHtcbiAgcmV0dXJuIHJ1bm5pbmc7XG59XG5cbi8qKiBTaG93IHRoZSBzZXR1cCBpbiB0aGUgQmF0dGxlIHRhYi4gYG9uRG9uZWAgcnVucyBvbmNlIHNldHVwIGhhcyBmaW5pc2hlZCBhbmQgYmVlbiBzYXZlZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzaG93U2V0dXBTY3JlZW4ocm9vdDogUGFyZW50Tm9kZSwgb25Eb25lOiAoKSA9PiB2b2lkLCBzY3JlZW5PcHRpb25zOiBTZXR1cFNjcmVlbk9wdGlvbnMgPSB7fSk6IHZvaWQge1xuICBjb25zdCBhcmVhID0gc2V0dXBBcmVhKHJvb3QpO1xuICBpZiAoIWFyZWEpIHJldHVybjtcbiAgYXJlYS5jbG9zZXN0KFwiLnNiLXRhYi1wYW5lbFwiKT8uY2xhc3NMaXN0LmFkZChTRVRVUF9BQ1RJVkVfQ0xBU1MpO1xuICBhcmVhLmhpZGRlbiA9IGZhbHNlO1xuICBpZiAocnVubmluZykgcmV0dXJuO1xuICBvcHRpb25zID0gc2NyZWVuT3B0aW9ucztcbiAgdm9pZCBsb2FkQ2hvaWNlcyhhcmVhLCBvbkRvbmUpO1xufVxuXG4vKiogUHV0IHRoZSBiYXR0bGUgVUkgYmFjayAoc2V0dXAgZmluaXNoZWQsIHBvc3NpYmx5IGVsc2V3aGVyZSkuICovXG5leHBvcnQgZnVuY3Rpb24gaGlkZVNldHVwU2NyZWVuKHJvb3Q6IFBhcmVudE5vZGUpOiB2b2lkIHtcbiAgY29uc3QgYXJlYSA9IHNldHVwQXJlYShyb290KTtcbiAgaWYgKCFhcmVhIHx8IHJ1bm5pbmcpIHJldHVybjtcbiAgYXJlYS5jbG9zZXN0KFwiLnNiLXRhYi1wYW5lbFwiKT8uY2xhc3NMaXN0LnJlbW92ZShTRVRVUF9BQ1RJVkVfQ0xBU1MpO1xuICBhcmVhLmhpZGRlbiA9IHRydWU7XG4gIGFyZWEuaW5uZXJIVE1MID0gXCJcIjtcbn1cblxuYXN5bmMgZnVuY3Rpb24gbG9hZENob2ljZXMoYXJlYTogSFRNTEVsZW1lbnQsIG9uRG9uZTogKCkgPT4gdm9pZCk6IFByb21pc2U8dm9pZD4ge1xuICBhcmVhLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPVwic2ItbG9hZGluZ1wiPkxvYWRpbmcgeW91ciBsaWJyYXJ5Li4uPC9kaXY+YDtcbiAgbGV0IHNjZW5lczogU2NlbmVbXTtcbiAgdHJ5IHtcbiAgICBzY2VuZXMgPSBhd2FpdCBmZXRjaFNldHVwU2NlbmVzKCk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0gRUxPIHNldHVwOiBjb3VsZCBub3QgbG9hZCBzY2VuZXM6XCIsIGUpO1xuICAgIHNob3dFcnJvcihhcmVhLCBcIkNvdWxkbid0IGxvYWQgeW91ciBzY2VuZXMgZnJvbSBTdGFzaC5cIiwgKCkgPT4gdm9pZCBsb2FkQ2hvaWNlcyhhcmVhLCBvbkRvbmUpKTtcbiAgICByZXR1cm47XG4gIH1cbiAgcmVuZGVyQ2hvaWNlcyhhcmVhLCBzY2VuZXMsIG9uRG9uZSk7XG59XG5cbmZ1bmN0aW9uIHJhZGlvKG5hbWU6IHN0cmluZywgdmFsdWU6IHN0cmluZywgbGFiZWw6IHN0cmluZywgZGVzYzogc3RyaW5nLCBjaGVja2VkOiBib29sZWFuKTogc3RyaW5nIHtcbiAgY29uc3QgaWQgPSBgc2Itc2V0dXAtJHtuYW1lfS0ke3ZhbHVlfWA7XG4gIHJldHVybiBgXG4gICAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJjdXN0b20tY29udHJvbCBjdXN0b20tcmFkaW8gc2Itc2V0dXAtb3B0aW9uXCI+XG4gICAgICAgICAgICAgICAgPGlucHV0IHR5cGU9XCJyYWRpb1wiIGNsYXNzPVwiY3VzdG9tLWNvbnRyb2wtaW5wdXRcIiBpZD1cIiR7aWR9XCIgbmFtZT1cIiR7bmFtZX1cIiB2YWx1ZT1cIiR7dmFsdWV9XCIgJHtjaGVja2VkID8gXCJjaGVja2VkXCIgOiBcIlwifT5cbiAgICAgICAgICAgICAgICA8bGFiZWwgY2xhc3M9XCJjdXN0b20tY29udHJvbC1sYWJlbFwiIGZvcj1cIiR7aWR9XCI+XG4gICAgICAgICAgICAgICAgICA8c3Ryb25nPiR7bGFiZWx9PC9zdHJvbmc+XG4gICAgICAgICAgICAgICAgICA8c3BhbiBjbGFzcz1cInNiLXNldHVwLWRlc2NcIj4ke2Rlc2N9PC9zcGFuPlxuICAgICAgICAgICAgICAgIDwvbGFiZWw+XG4gICAgICAgICAgICAgIDwvZGl2PmA7XG59XG5cbi8qKiBXaGF0IHRoZSBzZWNvbmQgYW5zd2VyIGRvZXMgdG8gU3Rhc2ggcmF0aW5ncyBub3c6IGEgd2FybmluZyB3aGVuIHJhdGluZ3MgY2hhbmdlLCBlbHNlIGEgY2FsbSBsaW5lLiAqL1xuZnVuY3Rpb24gcmF0aW5nc01lc3NhZ2Uoc3RhcnQ6IEVsb1N0YXJ0LCBtb2RlOiBTdGFzaFJhdGluZ3NNb2RlLCBjaGFuZ2VzOiBudW1iZXIpOiBzdHJpbmcge1xuICBjb25zdCBiYWNrdXAgPSBcIlRha2UgYSBTdGFzaCBiYWNrdXAgZmlyc3QgKFNldHRpbmdzIOKGkiBUYXNrcyDihpIgQmFja3VwKS5cIjtcbiAgbGV0IHRleHQ6IHN0cmluZztcbiAgbGV0IHdhcm4gPSB0cnVlO1xuICBpZiAobW9kZSA9PT0gXCJvZmZcIikge1xuICAgIHRleHQgPSBcIlN0YXNoIHJhdGluZ3Mgd29uJ3QgY2hhbmdlLlwiO1xuICAgIHdhcm4gPSBmYWxzZTtcbiAgfSBlbHNlIGlmIChjaGFuZ2VzID09PSAwKSB7XG4gICAgdGV4dCA9IFwiTm8gU3Rhc2ggcmF0aW5ncyBjaGFuZ2Ugbm93OiBldmVyeSBzY2VuZSBjb252ZXJ0cyBiYWNrIHRvIGl0cyBjdXJyZW50IHJhdGluZy5cIjtcbiAgICB3YXJuID0gZmFsc2U7XG4gIH0gZWxzZSBpZiAoc3RhcnQgPT09IFwiZnJlc2hcIikge1xuICAgIHRleHQgPSBg4pqg77iPIEV2ZXJ5IHNjZW5lIHN0YXJ0cyBhdCAxNTAwIEVMTywgc28gPHN0cm9uZz5ldmVyeSBTdGFzaCByYXRpbmcgYmVjb21lcyA1MDwvc3Ryb25nPjogJHtwbHVyYWwoY2hhbmdlcywgXCJyYXRpbmdcIil9IGNoYW5nZSwgdW5yYXRlZCBzY2VuZXMgaW5jbHVkZWQuICR7YmFja3VwfWA7XG4gIH0gZWxzZSB7XG4gICAgdGV4dCA9IGDimqDvuI8gPHN0cm9uZz4ke3BsdXJhbChjaGFuZ2VzLCBcIlN0YXNoIHJhdGluZ1wiKX0gY2hhbmdlPC9zdHJvbmc+IG5vdywgc3ByZWFkIGV2ZW5seSBieSByYW5rLiBBIHNjZW5lIHlvdSByYXRlZCAxMDAgYnkgaGFuZCBtYXkgZW5kIHVwIGxvd2VyLiAke2JhY2t1cH1gO1xuICB9XG4gIHJldHVybiBgPHAgY2xhc3M9XCJzYi1zZXR1cC1tZXNzYWdlJHt3YXJuID8gXCIgc2Itc2V0dXAtd2FybmluZ1wiIDogXCJcIn1cIj4ke3RleHR9PC9wPmA7XG59XG5cbmZ1bmN0aW9uIHJlbmRlckNob2ljZXMoYXJlYTogSFRNTEVsZW1lbnQsIHNjZW5lczogU2NlbmVbXSwgb25Eb25lOiAoKSA9PiB2b2lkKTogdm9pZCB7XG4gIGNvbnN0IHRvdGFsID0gc2NlbmVzLmxlbmd0aDtcbiAgY29uc3QgcmF0ZWQgPSBzY2VuZXMuZmlsdGVyKChzY2VuZSkgPT4gc2NlbmUucmF0aW5nMTAwICE9IG51bGwpLmxlbmd0aDtcbiAgY29uc3QgdW5yYXRlZCA9IHRvdGFsIC0gcmF0ZWQ7XG4gIGNvbnN0IHdpdGhFbG8gPSBzY2VuZXMuZmlsdGVyKGlzUmF0ZWQpLmxlbmd0aDtcbiAgLy8gUmUtcnVucyAoUmVzZXQgRUxPLCBTdGFnZSA0KSBhbmQgcHJlLTMuMCBmdW4gbW9kZSB1c2VycyBoYWQgbm8gcmF0aW5nIHVwZGF0ZXMgdG8gbG9zZVxuICBjb25zdCB1cGdyYWRlTm90ZSA9XG4gICAgIXN0YXRlLnNldHRpbmdzLmVsb1NldHVwQXQgJiYgIWhhZEZ1bk1vZGUoKVxuICAgICAgPyBcIiBCZWZvcmUgMy4wLCByYXRpbmdzIGNoYW5nZWQgYWZ0ZXIgZXZlcnkgYmF0dGxlOyBTdHJhaWdodC1saW5lIHdpdGggVXNlIG15IHJhdGluZ3MgaXMgY2xvc2VzdCB0byB0aGF0LlwiXG4gICAgICA6IFwiXCI7XG5cbiAgY29uc3QgcmVzZXQgPSBvcHRpb25zLnJlc2V0ID09PSB0cnVlO1xuICBjb25zdCBjaG9pY2U6IENob2ljZSA9IHsgc3RhcnQ6IFwicmF0aW5nc1wiLCBzdGFzaFJhdGluZ3M6IHJlc2V0ID8gc3RhdGUuc2V0dGluZ3Muc3Rhc2hSYXRpbmdzIDogXCJvZmZcIiB9O1xuXG4gIGFyZWEuaW5uZXJIVE1MID0gYFxuICAgICAgPGRpdiBjbGFzcz1cInNiLXNldHVwXCI+XG4gICAgICAgIDxoMiBjbGFzcz1cInNiLXNldHVwLXRpdGxlXCI+JHtyZXNldCA/IFwiUmVzZXQgRUxPXCIgOiBcIlNldCB1cCBFTE9cIn08L2gyPlxuICAgICAgICA8cCBjbGFzcz1cInNiLXNldHVwLWludHJvXCI+XG4gICAgICAgICAgJHtcbiAgICAgICAgICAgIHJlc2V0XG4gICAgICAgICAgICAgID8gXCJDaG9vc2UgaG93IEVMTyBzdGFydHMgYWdhaW4uIFRoaXMgb3ZlcndyaXRlcyBldmVyeSBzY2VuZSdzIEVMTyBhbmQgYmF0dGxlIGNvdW50LlwiXG4gICAgICAgICAgICAgIDogXCJTdGFzaCBCYXR0bGUgbm93IGdpdmVzIGVhY2ggc2NlbmUgYW4gRUxPIHNjb3JlLCBzYXZlZCBpbiBpdHMgY3VzdG9tIGZpZWxkcy4gV2lucyByYWlzZSBpdCwgbG9zc2VzIGxvd2VyIGl0LiBDaG9vc2UgaG93IGl0IHN0YXJ0cy4gVGhpcyBydW5zIG9uY2UuXCJcbiAgICAgICAgICB9XG4gICAgICAgIDwvcD5cbiAgICAgICAgJHtcbiAgICAgICAgICB3aXRoRWxvID4gMCAmJiAhcmVzZXRcbiAgICAgICAgICAgID8gYDxwIGNsYXNzPVwic2Itc2V0dXAtd2FybmluZ1wiPiR7cGx1cmFsKHdpdGhFbG8sIFwic2NlbmVcIil9IGFscmVhZHkgJHt3aXRoRWxvID09PSAxID8gXCJoYXNcIiA6IFwiaGF2ZVwifSBhbiBFTE8gZnJvbSBhbiBlYXJsaWVyIHNldHVwIHRoYXQgZGlkbid0IGZpbmlzaC4gU2V0dGluZyB1cCBhZ2FpbiBvdmVyd3JpdGVzICR7d2l0aEVsbyA9PT0gMSA/IFwiaXRcIiA6IFwidGhlbVwifS48L3A+YFxuICAgICAgICAgICAgOiBcIlwiXG4gICAgICAgIH1cbiAgICAgICAgPGRpdiBjbGFzcz1cInNiLXNldHVwLXF1ZXN0aW9uc1wiPlxuICAgICAgICAgIDxmaWVsZHNldCBjbGFzcz1cInNiLXNldHVwLXF1ZXN0aW9uXCI+XG4gICAgICAgICAgICA8bGVnZW5kPkhvdyBzaG91bGQgRUxPIHN0YXJ0PzwvbGVnZW5kPlxuICAgICAgICAgICAgJHtyYWRpbyhcbiAgICAgICAgICAgICAgXCJzdGFydFwiLFxuICAgICAgICAgICAgICBcInJhdGluZ3NcIixcbiAgICAgICAgICAgICAgXCJVc2UgbXkgcmF0aW5nc1wiLFxuICAgICAgICAgICAgICBgWW91ciAke3BsdXJhbChyYXRlZCwgXCJyYXRlZCBzY2VuZVwiKX0gc3RhcnQgZnJvbSB0aGVpciByYXRpbmcgKDUwID0gMTUwMCBFTE8sIDEwIEVMTyBwZXIgcG9pbnQpLiR7dW5yYXRlZCA+IDAgPyBgIFRoZSAke3VucmF0ZWR9IHVucmF0ZWQgJHt1bnJhdGVkID09PSAxID8gXCJvbmUgc3RheXNcIiA6IFwib25lcyBzdGF5XCJ9IHVucmF0ZWQuYCA6IFwiXCJ9YCxcbiAgICAgICAgICAgICAgdHJ1ZSxcbiAgICAgICAgICAgICl9XG4gICAgICAgICAgICAke3JhZGlvKFxuICAgICAgICAgICAgICBcInN0YXJ0XCIsXG4gICAgICAgICAgICAgIFwiZnJlc2hcIixcbiAgICAgICAgICAgICAgXCJTdGFydCBldmVyeW9uZSBhdCAxNTAwXCIsXG4gICAgICAgICAgICAgIGBBbGwgJHtwbHVyYWwodG90YWwsIFwic2NlbmVcIil9IHN0YXJ0IGVxdWFsLmAsXG4gICAgICAgICAgICAgIGZhbHNlLFxuICAgICAgICAgICAgKX1cbiAgICAgICAgICA8L2ZpZWxkc2V0PlxuICAgICAgICAgIDxmaWVsZHNldCBjbGFzcz1cInNiLXNldHVwLXF1ZXN0aW9uXCI+XG4gICAgICAgICAgICA8bGVnZW5kPlNob3VsZCBTdGFzaCBCYXR0bGUgY2hhbmdlIHlvdXIgU3Rhc2ggcmF0aW5ncz88L2xlZ2VuZD5cbiAgICAgICAgICAgICR7U1RBU0hfUkFUSU5HU19PUFRJT05TLm1hcCgoeyB2YWx1ZSwgbGFiZWwsIGRlc2MgfSkgPT5cbiAgICAgICAgICAgICAgcmFkaW8oXCJzdGFzaFJhdGluZ3NcIiwgdmFsdWUsIGxhYmVsLCBkZXNjLCB2YWx1ZSA9PT0gY2hvaWNlLnN0YXNoUmF0aW5ncyksXG4gICAgICAgICAgICApLmpvaW4oXCJcIil9XG4gICAgICAgICAgICA8cCBjbGFzcz1cInNiLXNldHVwLW5vdGVcIj5Zb3UgY2FuIGNoYW5nZSB0aGlzIGxhdGVyIGluIFNldHRpbmdzLiR7dXBncmFkZU5vdGV9PC9wPlxuICAgICAgICAgIDwvZmllbGRzZXQ+XG4gICAgICAgIDwvZGl2PlxuICAgICAgICA8ZGl2IGNsYXNzPVwic2Itc2V0dXAtbWVzc2FnZS1zbG90XCIgZGF0YS1yb2xlPVwicmF0aW5ncy13YXJuaW5nXCI+PC9kaXY+XG4gICAgICAgIDxoMyBjbGFzcz1cInNiLXNldHVwLXN1YnRpdGxlXCI+UHJldmlldzwvaDM+XG4gICAgICAgIDxkaXYgZGF0YS1yb2xlPVwicHJldmlld1wiPjwvZGl2PlxuICAgICAgICA8ZGl2IGNsYXNzPVwic2Itc2V0dXAtYWN0aW9uc1wiPlxuICAgICAgICAgICR7cmVzZXQgPyBgPGJ1dHRvbiB0eXBlPVwiYnV0dG9uXCIgY2xhc3M9XCJidG4gYnRuLXNlY29uZGFyeVwiIGRhdGEtcm9sZT1cImNhbmNlbFwiPkNhbmNlbDwvYnV0dG9uPmAgOiBcIlwifVxuICAgICAgICAgIDxidXR0b24gdHlwZT1cImJ1dHRvblwiIGNsYXNzPVwiYnRuIGJ0bi1wcmltYXJ5XCIgZGF0YS1yb2xlPVwic3RhcnRcIj5TdGFydCBFTE88L2J1dHRvbj5cbiAgICAgICAgPC9kaXY+XG4gICAgICA8L2Rpdj5gO1xuXG4gIGFyZWEucXVlcnlTZWxlY3RvcignW2RhdGEtcm9sZT1cImNhbmNlbFwiXScpPy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4gb3B0aW9ucy5vbkNhbmNlbD8uKCkpO1xuXG4gIGNvbnN0IHNsb3QgPSBhcmVhLnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KCdbZGF0YS1yb2xlPVwicmF0aW5ncy13YXJuaW5nXCJdJykgYXMgSFRNTEVsZW1lbnQ7XG4gIGNvbnN0IHByZXZpZXcgPSBhcmVhLnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KCdbZGF0YS1yb2xlPVwicHJldmlld1wiXScpIGFzIEhUTUxFbGVtZW50O1xuICBjb25zdCBzdGFydEJ0biA9IGFyZWEucXVlcnlTZWxlY3RvcjxIVE1MQnV0dG9uRWxlbWVudD4oJ1tkYXRhLXJvbGU9XCJzdGFydFwiXScpIGFzIEhUTUxCdXR0b25FbGVtZW50O1xuXG4gIC8vIEV2ZXJ5IGFuc3dlcidzIG1lc3NhZ2Ugc2l0cyBpbiB0aGUgc2xvdCBhdCBvbmNlLCBzdGFja2VkIGluIG9uZSBncmlkIGNlbGwsIHNvIHRoZSBzbG90IGlzXG4gIC8vIGFsd2F5cyBhcyB0YWxsIGFzIHRoZSBsb25nZXN0IGFuZCBzd2l0Y2hpbmcgYW5zd2VycyBuZXZlciBtb3ZlcyB0aGUgbGF5b3V0IGJlbG93IGl0LlxuICAvLyBBbnN3ZXJzIHdpdGggdGhlIHNhbWUgbWVzc2FnZSBzaGFyZSBvbmUgZWxlbWVudCwgc28gc3dpdGNoaW5nIGJldHdlZW4gdGhlbSBkb2Vzbid0IGZhZGUuXG4gIGNvbnN0IGNoYW5nZUNvdW50cyA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG4gIGNvbnN0IG1lc3NhZ2VGb3IgPSBuZXcgTWFwPHN0cmluZywgRWxlbWVudD4oKTtcbiAgY29uc3QgbWVzc2FnZUJ5SHRtbCA9IG5ldyBNYXA8c3RyaW5nLCBFbGVtZW50PigpO1xuICBmb3IgKGNvbnN0IHN0YXJ0IG9mIFtcInJhdGluZ3NcIiwgXCJmcmVzaFwiXSBhcyBjb25zdCkge1xuICAgIGZvciAoY29uc3QgbW9kZSBvZiBbXCJvZmZcIiwgXCJsaW5lYXJcIiwgXCJwZXJjZW50aWxlXCJdIGFzIGNvbnN0KSB7XG4gICAgICBjb25zdCBjaGFuZ2VzID0gc2V0dXBSYXRpbmdDaGFuZ2VzKHNjZW5lcywgc3RhcnQsIG1vZGUpLnNpemU7XG4gICAgICBjb25zdCBodG1sID0gcmF0aW5nc01lc3NhZ2Uoc3RhcnQsIG1vZGUsIGNoYW5nZXMpO1xuICAgICAgbGV0IG1lc3NhZ2UgPSBtZXNzYWdlQnlIdG1sLmdldChodG1sKTtcbiAgICAgIGlmICghbWVzc2FnZSkge1xuICAgICAgICBzbG90Lmluc2VydEFkamFjZW50SFRNTChcImJlZm9yZWVuZFwiLCBodG1sKTtcbiAgICAgICAgbWVzc2FnZSA9IHNsb3QubGFzdEVsZW1lbnRDaGlsZCBhcyBFbGVtZW50O1xuICAgICAgICBtZXNzYWdlQnlIdG1sLnNldChodG1sLCBtZXNzYWdlKTtcbiAgICAgIH1cbiAgICAgIGNoYW5nZUNvdW50cy5zZXQoYCR7c3RhcnR9OiR7bW9kZX1gLCBjaGFuZ2VzKTtcbiAgICAgIG1lc3NhZ2VGb3Iuc2V0KGAke3N0YXJ0fToke21vZGV9YCwgbWVzc2FnZSk7XG4gICAgfVxuICB9XG5cbiAgY29uc3QgdXBkYXRlID0gKCk6IHZvaWQgPT4ge1xuICAgIHNob3dSYXRpbmdQcmV2aWV3KHByZXZpZXcsIGNob2ljZS5zdGFydCwgY2hvaWNlLnN0YXNoUmF0aW5ncyk7XG4gICAgY29uc3Qga2V5ID0gYCR7Y2hvaWNlLnN0YXJ0fToke2Nob2ljZS5zdGFzaFJhdGluZ3N9YDtcbiAgICBjb25zdCBzaG93biA9IG1lc3NhZ2VGb3IuZ2V0KGtleSk7XG4gICAgZm9yIChjb25zdCBtZXNzYWdlIG9mIHNsb3QuY2hpbGRyZW4pIG1lc3NhZ2UuY2xhc3NMaXN0LnRvZ2dsZShcInNiLXNob3duXCIsIG1lc3NhZ2UgPT09IHNob3duKTtcbiAgICBjb25zdCBjaGFuZ2VzID0gY2hhbmdlQ291bnRzLmdldChrZXkpID8/IDA7XG4gICAgc3RhcnRCdG4udGV4dENvbnRlbnQgPSBjaGFuZ2VzID4gMCA/IGBTdGFydCBFTE8gYW5kIGNoYW5nZSAke3BsdXJhbChjaGFuZ2VzLCBcInJhdGluZ1wiKX1gIDogXCJTdGFydCBFTE9cIjtcbiAgfTtcblxuICBhcmVhLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTElucHV0RWxlbWVudD4oJ2lucHV0W3R5cGU9XCJyYWRpb1wiXScpLmZvckVhY2goKGlucHV0KSA9PiB7XG4gICAgaW5wdXQuYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoKSA9PiB7XG4gICAgICBpZiAoaW5wdXQubmFtZSA9PT0gXCJzdGFydFwiKSBjaG9pY2Uuc3RhcnQgPSBpbnB1dC52YWx1ZSBhcyBFbG9TdGFydDtcbiAgICAgIGVsc2UgY2hvaWNlLnN0YXNoUmF0aW5ncyA9IGlucHV0LnZhbHVlIGFzIFN0YXNoUmF0aW5nc01vZGU7XG4gICAgICB1cGRhdGUoKTtcbiAgICB9KTtcbiAgfSk7XG4gIHN0YXJ0QnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiB2b2lkIHJ1blNldHVwKGFyZWEsIHNjZW5lcywgY2hvaWNlLCBvbkRvbmUpKTtcbiAgdXBkYXRlKCk7XG59XG5cbmZ1bmN0aW9uIHByb2dyZXNzSHRtbChwaGFzZTogU2V0dXBQaGFzZSwgZG9uZTogbnVtYmVyLCB0b3RhbDogbnVtYmVyKTogc3RyaW5nIHtcbiAgY29uc3QgcGVyY2VudCA9IHRvdGFsID4gMCA/IE1hdGgucm91bmQoKGRvbmUgLyB0b3RhbCkgKiAxMDApIDogMTAwO1xuICBjb25zdCBsYWJlbCA9XG4gICAgcGhhc2UgPT09IFwiZWxvXCJcbiAgICAgID8gYFNhdmluZyBzdGFydGluZyBFTE86ICR7ZG9uZX0gb2YgJHtwbHVyYWwodG90YWwsIFwic2NlbmVcIil9YFxuICAgICAgOiBgVXBkYXRpbmcgU3Rhc2ggcmF0aW5nczogJHtwbHVyYWwodG90YWwsIFwic2NlbmVcIil9YDtcbiAgcmV0dXJuIGBcbiAgICAgIDxkaXYgY2xhc3M9XCJzYi1zZXR1cCBzYi1zZXR1cC1wcm9ncmVzc1wiPlxuICAgICAgICA8aDIgY2xhc3M9XCJzYi1zZXR1cC10aXRsZVwiPlNldHRpbmcgdXAgRUxPLi4uPC9oMj5cbiAgICAgICAgPGRpdiBjbGFzcz1cInByb2dyZXNzXCI+PGRpdiBjbGFzcz1cInByb2dyZXNzLWJhclwiIHJvbGU9XCJwcm9ncmVzc2JhclwiIHN0eWxlPVwid2lkdGg6ICR7cGVyY2VudH0lXCIgYXJpYS12YWx1ZW5vdz1cIiR7cGVyY2VudH1cIiBhcmlhLXZhbHVlbWluPVwiMFwiIGFyaWEtdmFsdWVtYXg9XCIxMDBcIj48L2Rpdj48L2Rpdj5cbiAgICAgICAgPHAgY2xhc3M9XCJzYi1zZXR1cC1wcm9ncmVzcy1sYWJlbFwiPiR7bGFiZWx9PC9wPlxuICAgICAgICA8cCBjbGFzcz1cInNiLXNldHVwLW5vdGVcIj5Zb3UgY2FuIGNsb3NlIFN0YXNoIEJhdHRsZTsgc2V0dXAga2VlcHMgZ29pbmcgd2hpbGUgdGhpcyBTdGFzaCB0YWIgc3RheXMgb3Blbi4gSWYgdGhlIHRhYiBjbG9zZXMgZmlyc3QsIFN0YXNoIEJhdHRsZSBhc2tzIGFnYWluIG5leHQgdGltZSwgYW5kIHJ1bm5pbmcgaXQgYWdhaW4gaXMgc2FmZS48L3A+XG4gICAgICA8L2Rpdj5gO1xufVxuXG5hc3luYyBmdW5jdGlvbiBydW5TZXR1cChhcmVhOiBIVE1MRWxlbWVudCwgc2NlbmVzOiBTY2VuZVtdLCBjaG9pY2U6IENob2ljZSwgb25Eb25lOiAoKSA9PiB2b2lkKTogUHJvbWlzZTx2b2lkPiB7XG4gIHJ1bm5pbmcgPSB0cnVlO1xuICBhcmVhLmlubmVySFRNTCA9IHByb2dyZXNzSHRtbChcImVsb1wiLCAwLCAwKTtcbiAgLy8gQSByZXNldCBjbGVhcnMgdGhlIFwic2V0dXAgZmluaXNoZWRcIiBmbGFnIGZpcnN0LCBzbyBpZiBpdCdzIGludGVycnVwdGVkIFN0YXNoIEJhdHRsZSBhc2tzIGFnYWluXG4gIGlmIChzdGF0ZS5zZXR0aW5ncy5lbG9TZXR1cEF0ICYmICEoYXdhaXQgdXBkYXRlU2V0dGluZ3NOb3coeyBlbG9TZXR1cEF0OiBudWxsLCBlbG9TZXR1cE1vZGU6IG51bGwgfSkpKSB7XG4gICAgY29uc29sZS53YXJuKFwiW1N0YXNoIEJhdHRsZV0gQ291bGRuJ3QgY2xlYXIgdGhlIHNldHVwIGZsYWcgYmVmb3JlIHJlc2V0dGluZyBFTE87IGNvbnRpbnVpbmdcIik7XG4gIH1cbiAgbGV0IHN1bW1hcnk6IFNldHVwU3VtbWFyeTtcbiAgdHJ5IHtcbiAgICBzdW1tYXJ5ID0gYXdhaXQgcnVuRWxvU2V0dXAoc2NlbmVzLCBjaG9pY2Uuc3RhcnQsIGNob2ljZS5zdGFzaFJhdGluZ3MsIChwaGFzZSwgZG9uZSwgdG90YWwpID0+IHtcbiAgICAgIGFyZWEuaW5uZXJIVE1MID0gcHJvZ3Jlc3NIdG1sKHBoYXNlLCBkb25lLCB0b3RhbCk7XG4gICAgfSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBydW5uaW5nID0gZmFsc2U7XG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIEVMTyBzZXR1cCBmYWlsZWQ6XCIsIGUpO1xuICAgIHNob3dFcnJvcihcbiAgICAgIGFyZWEsXG4gICAgICBgU2V0dXAgc3RvcHBlZCBwYXJ0d2F5OiAke2VzY2FwZUh0bWwoZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpKX0uIFJ1bm5pbmcgaXQgYWdhaW4gaXMgc2FmZTsgaXQgb3ZlcndyaXRlcyB3aGF0IHdhcyB3cml0dGVuLmAsXG4gICAgICAoKSA9PiB2b2lkIGxvYWRDaG9pY2VzKGFyZWEsIG9uRG9uZSksXG4gICAgKTtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBDYWNoZWQgc2NlbmVzIGFuZCBhbnkgc2F2ZWQgcGFpciBwcmVkYXRlIHRoZSBuZXcgRUxPIChhbmQgcG9zc2libHkgdGhlIG5ldyByYXRpbmdzKVxuICBhd2FpdCBjbGVhclNjZW5lQ2FjaGUoKTtcbiAgcmVzZXRTaHVmZmxlKCk7XG4gIHJlc2V0UnVuU3RhdGUoKTtcbiAgc3RhdGUuY3VycmVudFBhaXIgPSB7IGxlZnQ6IG51bGwsIHJpZ2h0OiBudWxsIH07XG4gIHN0YXRlLmN1cnJlbnRSYW5rcyA9IHsgbGVmdDogbnVsbCwgcmlnaHQ6IG51bGwgfTtcbiAgc2F2ZVN0YXRlKCk7XG5cbiAgYXdhaXQgZmluaXNoU2V0dXAoYXJlYSwgc3VtbWFyeSwgY2hvaWNlLCBvbkRvbmUpO1xufVxuXG4vKiogU2F2ZSB0aGUgY29tcGxldGlvbiBmbGFncyAocmV0cnlpbmcgb24gcmVxdWVzdCksIHRoZW4gc2hvdyB0aGUgc3VtbWFyeS4gKi9cbmFzeW5jIGZ1bmN0aW9uIGZpbmlzaFNldHVwKGFyZWE6IEhUTUxFbGVtZW50LCBzdW1tYXJ5OiBTZXR1cFN1bW1hcnksIGNob2ljZTogQ2hvaWNlLCBvbkRvbmU6ICgpID0+IHZvaWQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3Qgc2F2ZWQgPSBhd2FpdCB1cGRhdGVTZXR0aW5nc05vdyh7XG4gICAgZWxvU2V0dXBBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLFxuICAgIGVsb1NldHVwTW9kZTogY2hvaWNlLnN0YXJ0LFxuICAgIHN0YXNoUmF0aW5nczogY2hvaWNlLnN0YXNoUmF0aW5ncyxcbiAgfSk7XG4gIGlmICghc2F2ZWQpIHtcbiAgICAvLyBXaXRob3V0IHRoZSBmbGFnLCBzZXR1cCB3b3VsZCBzaG93IGFnYWluIG9uIHRoZSBuZXh0IG9wZW46IGtlZXAgaXQgcGVuZGluZyBoZXJlIHRvb1xuICAgIHN0YXRlLnNldHRpbmdzID0geyAuLi5zdGF0ZS5zZXR0aW5ncywgZWxvU2V0dXBBdDogbnVsbCB9O1xuICAgIHNob3dFcnJvcihcbiAgICAgIGFyZWEsXG4gICAgICBcIllvdXIgRUxPIGlzIHNhdmVkLCBidXQgU3Rhc2ggQmF0dGxlIGNvdWxkbid0IHJlY29yZCBpbiBTdGFzaCB0aGF0IHNldHVwIGZpbmlzaGVkLlwiLFxuICAgICAgKCkgPT4gdm9pZCBmaW5pc2hTZXR1cChhcmVhLCBzdW1tYXJ5LCBjaG9pY2UsIG9uRG9uZSksXG4gICAgKTtcbiAgICByZXR1cm47XG4gIH1cbiAgcnVubmluZyA9IGZhbHNlO1xuXG4gIGNvbnN0IGVsb0xpbmUgPVxuICAgIGNob2ljZS5zdGFydCA9PT0gXCJyYXRpbmdzXCJcbiAgICAgID8gYCR7cGx1cmFsKHN1bW1hcnkuZWxvV3JpdHRlbiwgXCJzY2VuZVwiKX0gZ290IGEgc3RhcnRpbmcgRUxPIGZyb20gJHtzdW1tYXJ5LmVsb1dyaXR0ZW4gPT09IDEgPyBcIml0c1wiIDogXCJ0aGVpclwifSByYXRpbmcuIFVucmF0ZWQgc2NlbmVzIHN0YXkgdW5yYXRlZCB1bnRpbCB0aGV5IGJhdHRsZS5gXG4gICAgICA6IGAke3BsdXJhbChzdW1tYXJ5LmVsb1dyaXR0ZW4sIFwic2NlbmVcIil9IHN0YXJ0IGF0IDE1MDAgRUxPLmA7XG4gIGNvbnN0IGNsZWFyZWRMaW5lID1cbiAgICBzdW1tYXJ5LmVsb0NsZWFyZWQgPiAwID8gYDxsaT4ke3BsdXJhbChzdW1tYXJ5LmVsb0NsZWFyZWQsIFwic2NlbmVcIil9IHdpdGhvdXQgYSBTdGFzaCByYXRpbmcgaGFkIGFuIG9sZCBFTE8gcmVtb3ZlZC48L2xpPmAgOiBcIlwiO1xuICBjb25zdCBvcHRpb25MYWJlbCA9IGNob2ljZS5zdGFzaFJhdGluZ3MgPT09IFwicGVyY2VudGlsZVwiID8gXCJQZXJjZW50aWxlXCIgOiBcIlN0cmFpZ2h0LWxpbmVcIjtcbiAgY29uc3QgcmF0aW5nc0xpbmUgPVxuICAgIGNob2ljZS5zdGFzaFJhdGluZ3MgPT09IFwib2ZmXCJcbiAgICAgID8gXCJTdGFzaCByYXRpbmdzIHdlcmVuJ3QgY2hhbmdlZCwgYW5kIGJhdHRsZXMgd29uJ3QgY2hhbmdlIHRoZW0uXCJcbiAgICAgIDogc3VtbWFyeS5yYXRpbmdzV3JpdHRlbiA9PT0gMFxuICAgICAgICA/IGBTdGFzaCByYXRpbmdzIGFscmVhZHkgbWF0Y2hlZCAoJHtvcHRpb25MYWJlbH0pLCBzbyBub25lIGNoYW5nZWQuIEJhdHRsZXMga2VlcCB0aGVtIGluIHN0ZXAgZnJvbSBub3cgb24uYFxuICAgICAgICA6IGAke3BsdXJhbChzdW1tYXJ5LnJhdGluZ3NXcml0dGVuLCBcIlN0YXNoIHJhdGluZ1wiKX0gdXBkYXRlZCAoJHtvcHRpb25MYWJlbH0pLiBCYXR0bGVzIGtlZXAgdGhlbSBpbiBzdGVwIGZyb20gbm93IG9uLmA7XG5cbiAgYXJlYS5pbm5lckhUTUwgPSBgXG4gICAgICA8ZGl2IGNsYXNzPVwic2Itc2V0dXAgc2Itc2V0dXAtZG9uZVwiPlxuICAgICAgICA8aDIgY2xhc3M9XCJzYi1zZXR1cC10aXRsZVwiPuKchSBFTE8gaXMgcmVhZHk8L2gyPlxuICAgICAgICA8dWwgY2xhc3M9XCJzYi1zZXR1cC1zdW1tYXJ5XCI+XG4gICAgICAgICAgPGxpPiR7ZWxvTGluZX08L2xpPlxuICAgICAgICAgICR7Y2xlYXJlZExpbmV9XG4gICAgICAgICAgPGxpPiR7cmF0aW5nc0xpbmV9PC9saT5cbiAgICAgICAgPC91bD5cbiAgICAgICAgPGRpdiBjbGFzcz1cInNiLXNldHVwLWFjdGlvbnNcIj5cbiAgICAgICAgICA8YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cImJ0biBidG4tcHJpbWFyeVwiIGRhdGEtcm9sZT1cImRvbmVcIj5TdGFydCBiYXR0bGluZzwvYnV0dG9uPlxuICAgICAgICA8L2Rpdj5cbiAgICAgIDwvZGl2PmA7XG4gIGFyZWEucXVlcnlTZWxlY3RvcignW2RhdGEtcm9sZT1cImRvbmVcIl0nKT8uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHtcbiAgICBoaWRlU2V0dXBTY3JlZW4oYXJlYS5vd25lckRvY3VtZW50KTtcbiAgICBvbkRvbmUoKTtcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGVzY2FwZUh0bWwodGV4dDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIHRleHQucmVwbGFjZSgvWyY8PlwiXS9nLCAoYykgPT4gKHsgXCImXCI6IFwiJmFtcDtcIiwgXCI8XCI6IFwiJmx0O1wiLCBcIj5cIjogXCImZ3Q7XCIsICdcIic6IFwiJnF1b3Q7XCIgfSlbY10gYXMgc3RyaW5nKTtcbn1cblxuZnVuY3Rpb24gc2hvd0Vycm9yKGFyZWE6IEhUTUxFbGVtZW50LCBtZXNzYWdlOiBzdHJpbmcsIHJldHJ5OiAoKSA9PiB2b2lkKTogdm9pZCB7XG4gIGFyZWEuaW5uZXJIVE1MID0gYFxuICAgICAgPGRpdiBjbGFzcz1cInNiLXNldHVwIHNiLWVycm9yLXNjcmVlblwiPlxuICAgICAgICA8ZGl2IGNsYXNzPVwic2ItZXJyb3ItaWNvblwiPuKaoO+4jzwvZGl2PlxuICAgICAgICA8cCBjbGFzcz1cInNiLWVycm9yLW1lc3NhZ2VcIj4ke21lc3NhZ2V9PC9wPlxuICAgICAgICA8YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cImJ0biBidG4tcHJpbWFyeVwiIGRhdGEtcm9sZT1cInJldHJ5XCI+VHJ5IGFnYWluPC9idXR0b24+XG4gICAgICA8L2Rpdj5gO1xuICBhcmVhLnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLXJvbGU9XCJyZXRyeVwiXScpPy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgcmV0cnkpO1xufVxuIiwgIi8vIFRoZSBiYXR0bGUgbW9kYWw6IG9wZW5zL2Nsb3Nlcywgd2lyZXMgY29udHJvbHMgYW5kIGtleWJvYXJkIHNob3J0Y3V0cy5cblxuaW1wb3J0IHsgY2xlYXJTY2VuZUNhY2hlIH0gZnJvbSBcIi4uL2NhY2hlXCI7XG5pbXBvcnQgeyBmZXRjaFNldHVwU2NlbmVzIH0gZnJvbSBcIi4uL2Vsb1NldHVwXCI7XG5pbXBvcnQgeyBnZXRTY2VuZUlkRnJvbVVybCwgaG9sZFN0YXNoTGlzdFJlZnJlc2gsIHNjZW5lQ3VzdG9tRmllbGRzU3VwcG9ydGVkIH0gZnJvbSBcIi4uL2dyYXBocWxcIjtcbmltcG9ydCB7IGFwcGx5U3Rhc2hSYXRpbmdzLCBxdWV1ZVJhdGluZ1dyaXRlLCBTQ0VORV9NSVNTSU5HX0VWRU5ULCBzY2hlZHVsZVN0YXNoUmF0aW5nU3luYywgd3JpdGVTdGFzaFJhdGluZ3MgfSBmcm9tIFwiLi4vcmF0aW5nXCI7XG5pbXBvcnQgeyBzdGFzaFJhdGluZ0NoYW5nZXMgfSBmcm9tIFwiLi4vc2NvcmVcIjtcbmltcG9ydCB7IGxvYWRTZXR0aW5ncyB9IGZyb20gXCIuLi9zZXR0aW5nc1wiO1xuaW1wb3J0IHsgaXNFbG9TZXR1cFBlbmRpbmcsIHJlc2V0UnVuU3RhdGUsIHJlc2V0U2h1ZmZsZSwgc3RhdGUgfSBmcm9tIFwiLi4vc3RhdGVcIjtcbmltcG9ydCB7IGxvYWRTdGF0ZSwgc2F2ZVN0YXRlIH0gZnJvbSBcIi4uL3N0b3JhZ2VcIjtcbmltcG9ydCB0eXBlIHsgTW9kZSwgU2V0dGluZ3MsIFN0YXNoUmF0aW5nc01vZGUgfSBmcm9tIFwiLi4vdHlwZXNcIjtcbmltcG9ydCB7IGNhbmNlbENvbmZpcm1EaWFsb2csIGNvbmZpcm1EaWFsb2csIGlzQ29uZmlybURpYWxvZ09wZW4gfSBmcm9tIFwiLi9jb25maXJtRGlhbG9nXCI7XG5pbXBvcnQgeyBjYW5jZWxEZWxldGVEaWFsb2csIGlzRGVsZXRlRGlhbG9nT3BlbiB9IGZyb20gXCIuL2RlbGV0ZURpYWxvZ1wiO1xuaW1wb3J0IHtcbiAgYXBwbHlQcmV2aWV3U2V0dGluZ3MsXG4gIGNyZWF0ZU1haW5VSSxcbiAgaGFuZGxlU2NlbmVHb25lLFxuICBsb2FkTmV3UGFpcixcbiAgcmVuZGVyUGFpcixcbiAgcmVzdG9yZUN1cnJlbnRQYWlyLFxuICBza2lwUGFpcixcbiAgdXBkYXRlQ2xpbWJQb29sV2FybmluZyxcbiAgdXBkYXRlTW9kZUluZm8sXG4gIHVwZGF0ZVJhdGluZ3NOb3RlLFxuICB2ZXJpZnlDdXJyZW50UGFpcixcbn0gZnJvbSBcIi4vbWFpblVJXCI7XG5pbXBvcnQgeyBiaW5kU2V0dGluZ3NDb250cm9scywgZ2V0QWN0aXZlVGFiLCBzaG93VGFiLCBzeW5jU2V0dGluZ3NDb250cm9scyB9IGZyb20gXCIuL3NldHRpbmdzUGFuZWxcIjtcbmltcG9ydCB7IHJlZnJlc2hTY2VuZUVsbyB9IGZyb20gXCIuL3NjZW5lRWxvXCI7XG5pbXBvcnQgeyBoaWRlU2V0dXBTY3JlZW4sIGlzU2V0dXBSdW5uaW5nLCBzaG93U2V0dXBTY3JlZW4gfSBmcm9tIFwiLi9zZXR1cFNjcmVlblwiO1xuaW1wb3J0IHsgc3Rhc2hSYXRpbmdzT3B0aW9uIH0gZnJvbSBcIi4vc3Rhc2hSYXRpbmdzVGV4dFwiO1xuXG4vLyBUcmFjayBrZXlib2FyZCBoYW5kbGVyIHNvIHdlIGNhbiByZW1vdmUgaXQgb24gY2xvc2VcbmxldCBtb2RhbEtleUhhbmRsZXI6ICgoZTogS2V5Ym9hcmRFdmVudCkgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcbmxldCBzY2VuZU1pc3NpbmdMaXN0ZW5lckFkZGVkID0gZmFsc2U7XG5cbi8qKiBPbiA8Ym9keT4gd2hpbGUgQmF0dGxlIGlzIG9wZW47IENTUyB1c2VzIGl0IHRvIGxpZnQgU3Rhc2gncyBvd24gbW9kYWxzIGFib3ZlIG91cnMuICovXG5jb25zdCBCQVRUTEVfT1BFTl9DTEFTUyA9IFwic2ItYmF0dGxlLW9wZW5cIjtcblxuLyoqIFJlLXJlbmRlciB0aGUgcGFpciBvbiBzY3JlZW4gc28gY2FyZCBtYXJrdXAgcGlja3MgdXAgYSBjaGFuZ2VkIHNldHRpbmcuICovXG5mdW5jdGlvbiByZXJlbmRlckN1cnJlbnRQYWlyKCk6IHZvaWQge1xuICBjb25zdCB7IGxlZnQsIHJpZ2h0IH0gPSBzdGF0ZS5jdXJyZW50UGFpcjtcbiAgaWYgKCFsZWZ0IHx8ICFyaWdodCB8fCBzdGF0ZS5kaXNhYmxlQ2hvaWNlIHx8ICFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKFwiI3NiLWNvbXBhcmlzb24tYXJlYSAuc2ItdnMtY29udGFpbmVyXCIpKSB7XG4gICAgcmV0dXJuO1xuICB9XG4gIHJlbmRlclBhaXIoW2xlZnQsIHJpZ2h0XSwgW3N0YXRlLmN1cnJlbnRSYW5rcy5sZWZ0LCBzdGF0ZS5jdXJyZW50UmFua3MucmlnaHRdKTtcbn1cblxuLyoqXG4gKiBCZWZvcmUgdGhlIFwiU3Rhc2ggcmF0aW5nc1wiIGRyb3Bkb3duIGNoYW5nZXM6IHN3aXRjaGluZyB0byBQZXJjZW50aWxlIG9yIFN0cmFpZ2h0LWxpbmUgd2FybnMgaG93XG4gKiBtYW55IFN0YXNoIHJhdGluZ3MgY2hhbmdlIGFuZCBzeW5jcyB0aGVtIGFsbCBvbiBjb25maXJtIChmYWxzZSBwdXRzIHRoZSBkcm9wZG93biBiYWNrKS5cbiAqIFN3aXRjaGluZyB0byBEb24ndCB1cGRhdGUsIG9yIGEgc3dpdGNoIHRoYXQgY2hhbmdlcyBub3RoaW5nLCBuZWVkcyBubyB3YXJuaW5nLlxuICovXG5hc3luYyBmdW5jdGlvbiBjb25maXJtU2V0dGluZ0NoYW5nZShrZXk6IGtleW9mIFNldHRpbmdzLCB2YWx1ZTogc3RyaW5nKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGlmIChrZXkgIT09IFwic3Rhc2hSYXRpbmdzXCIpIHJldHVybiB0cnVlO1xuICBjb25zdCBuZXh0ID0gdmFsdWUgYXMgU3Rhc2hSYXRpbmdzTW9kZTtcbiAgaWYgKG5leHQgPT09IFwib2ZmXCIgfHwgbmV4dCA9PT0gc3RhdGUuc2V0dGluZ3Muc3Rhc2hSYXRpbmdzKSByZXR1cm4gdHJ1ZTtcblxuICBsZXQgY2hhbmdlczogTWFwPHN0cmluZywgbnVtYmVyPjtcbiAgdHJ5IHtcbiAgICBjaGFuZ2VzID0gc3Rhc2hSYXRpbmdDaGFuZ2VzKGF3YWl0IGZldGNoU2V0dXBTY2VuZXMoKSwgbmV4dCk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0gQ291bGRuJ3QgbG9hZCBzY2VuZXMgdG8gc3dpdGNoIFN0YXNoIHJhdGluZ3M6XCIsIGUpO1xuICAgIGF3YWl0IGNvbmZpcm1EaWFsb2coe1xuICAgICAgdGl0bGU6IFwiQ291bGRuJ3QgbG9hZCB5b3VyIHNjZW5lc1wiLFxuICAgICAgYm9keTogXCI8cD5TdGFzaCBCYXR0bGUgbmVlZHMgeW91ciB3aG9sZSBsaWJyYXJ5IHRvIHdvcmsgb3V0IHRoZSBuZXcgU3Rhc2ggcmF0aW5ncy4gTm90aGluZyB3YXMgY2hhbmdlZDsgdHJ5IGFnYWluLjwvcD5cIixcbiAgICAgIGNvbmZpcm1MYWJlbDogXCJPS1wiLFxuICAgIH0pO1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICBpZiAoY2hhbmdlcy5zaXplID09PSAwKSByZXR1cm4gdHJ1ZTtcblxuICBjb25zdCB7IGxhYmVsLCBkZXNjIH0gPSBzdGFzaFJhdGluZ3NPcHRpb24obmV4dCk7XG4gIGNvbnN0IGNvdW50ID0gYCR7Y2hhbmdlcy5zaXplfSBTdGFzaCByYXRpbmcke2NoYW5nZXMuc2l6ZSA9PT0gMSA/IFwiXCIgOiBcInNcIn1gO1xuICByZXR1cm4gY29uZmlybURpYWxvZyh7XG4gICAgdGl0bGU6IGBTd2l0Y2ggU3Rhc2ggcmF0aW5ncyB1cGRhdGUgbW9kZSB0byAke2xhYmVsfT9gLFxuICAgIGJvZHk6IGBcbiAgICAgICAgPHA+JHtkZXNjfTwvcD5cbiAgICAgICAgPHA+PHN0cm9uZz4ke2NvdW50fSBjaGFuZ2Ugbm93Ljwvc3Ryb25nPiBBZnRlciB0aGF0LCBiYXR0bGVzIGtlZXAgU3Rhc2ggcmF0aW5ncyBpbiBzdGVwIHdpdGhcbiAgICAgICAgRUxPLCBhbmQgYSBzdGFyIHJhdGluZyB5b3UgY2hhbmdlIGJ5IGhhbmQgaW4gU3Rhc2ggaXMgb3ZlcndyaXR0ZW4gdGhlIG5leHQgdGltZSBTdGFzaCBCYXR0bGVcbiAgICAgICAgd3JpdGVzIHRoYXQgc2NlbmUuPC9wPlxuICAgICAgICA8cD5UYWtlIGEgU3Rhc2ggYmFja3VwIGZpcnN0IChTZXR0aW5ncyDihpIgVGFza3Mg4oaSIEJhY2t1cCkuPC9wPmAsXG4gICAgY29uZmlybUxhYmVsOiBgVXBkYXRlICR7Y291bnR9YCxcbiAgICB3b3JraW5nTGFiZWw6IFwiVXBkYXRpbmcuLi5cIixcbiAgICBhY3Rpb246ICgpID0+XG4gICAgICBxdWV1ZVJhdGluZ1dyaXRlKGFzeW5jICgpID0+IHtcbiAgICAgICAgYXdhaXQgd3JpdGVTdGFzaFJhdGluZ3MoY2hhbmdlcyk7XG4gICAgICAgIGFwcGx5U3Rhc2hSYXRpbmdzKGNoYW5nZXMpO1xuICAgICAgfSksXG4gIH0pO1xufVxuXG4vKiogU2V0dGluZ3Mg4oaSIFJlc2V0IEVMTzogY29uZmlybSwgdGhlbiBzaG93IHRoZSBzZXR1cCBjaG9pY2VzIGFnYWluIChDYW5jZWwgZ29lcyBiYWNrKS4gKi9cbmFzeW5jIGZ1bmN0aW9uIHN0YXJ0UmVzZXRFbG8obW9kYWw6IEhUTUxFbGVtZW50KTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHJhdGluZ3NPbiA9IHN0YXRlLnNldHRpbmdzLnN0YXNoUmF0aW5ncyAhPT0gXCJvZmZcIjtcbiAgY29uc3Qgb2sgPSBhd2FpdCBjb25maXJtRGlhbG9nKHtcbiAgICB0aXRsZTogXCJSZXNldCBFTE8/XCIsXG4gICAgYm9keTogYFxuICAgICAgICA8cD5FdmVyeSBzY2VuZSdzIEVMTyBhbmQgYmF0dGxlIGNvdW50IHdpbGwgYmUgb3ZlcndyaXR0ZW4uIE5leHQgeW91IGNob29zZSBob3cgRUxPIHN0YXJ0c1xuICAgICAgICBhZ2FpbjogZnJvbSB5b3VyIFN0YXNoIHJhdGluZ3MsIG9yIDE1MDAgZm9yIGV2ZXJ5b25lLiR7cmF0aW5nc09uID8gXCIgU3Rhc2ggcmF0aW5ncyBhcmUgdGhlbiB1cGRhdGVkIGZyb20gdGhlIG5ldyBFTE8uXCIgOiBcIlwifTwvcD5cbiAgICAgICAgPHA+Tm90aGluZyBjaGFuZ2VzIHVudGlsIHlvdSBwcmVzcyBTdGFydCBvbiB0aGUgbmV4dCBzY3JlZW4uPC9wPmAsXG4gICAgY29uZmlybUxhYmVsOiBcIkNvbnRpbnVlXCIsXG4gIH0pO1xuICBpZiAoIW9rKSByZXR1cm47XG5cbiAgc3RhdGUucmVzZXR0aW5nRWxvID0gdHJ1ZTtcbiAgc2hvd1RhYihtb2RhbCwgXCJiYXR0bGVcIik7XG4gIG1vZGFsLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTFZpZGVvRWxlbWVudD4oXCIuc2ItaG92ZXItcHJldmlld1wiKS5mb3JFYWNoKCh2KSA9PiB2LnBhdXNlKCkpO1xuICBzaG93U2V0dXBTY3JlZW4obW9kYWwsICgpID0+IGFmdGVyU2V0dXAobW9kYWwpLCB7XG4gICAgcmVzZXQ6IHRydWUsXG4gICAgb25DYW5jZWw6ICgpID0+IHtcbiAgICAgIHN0YXRlLnJlc2V0dGluZ0VsbyA9IGZhbHNlO1xuICAgICAgaGlkZVNldHVwU2NyZWVuKG1vZGFsKTtcbiAgICAgIGlmIChzdGF0ZS5jdXJyZW50UGFpci5sZWZ0ICYmIHN0YXRlLmN1cnJlbnRQYWlyLnJpZ2h0KSB2b2lkIHJlc3RvcmVDdXJyZW50UGFpcigpO1xuICAgICAgZWxzZSB2b2lkIGxvYWROZXdQYWlyKCk7XG4gICAgfSxcbiAgfSk7XG59XG5cbi8qKiBTZXR1cCAoZmlyc3QgdGltZSBvciBSZXNldCBFTE8pIGZpbmlzaGVkOiBzZXR0aW5ncyBpdCBzYXZlZCBzaG93LCB0aGVuIGJhdHRsZXMgc3RhcnQuICovXG5mdW5jdGlvbiBhZnRlclNldHVwKG1vZGFsOiBIVE1MRWxlbWVudCk6IHZvaWQge1xuICBzdGF0ZS5yZXNldHRpbmdFbG8gPSBmYWxzZTtcbiAgc3luY1NldHRpbmdzQ29udHJvbHMobW9kYWwpO1xuICB1cGRhdGVSYXRpbmdzTm90ZSgpO1xuICB2b2lkIGxvYWROZXdQYWlyKGdldFNjZW5lSWRGcm9tVXJsKCkpO1xufVxuXG5mdW5jdGlvbiBvblNldHRpbmdDaGFuZ2VkKGtleToga2V5b2YgU2V0dGluZ3MpOiB2b2lkIHtcbiAgc3dpdGNoIChrZXkpIHtcbiAgICBjYXNlIFwic3Rhc2hSYXRpbmdzXCI6XG4gICAgICB1cGRhdGVSYXRpbmdzTm90ZSgpO1xuICAgICAgLy8gQ2F0Y2ggYW55dGhpbmcgYSBwZXItYmF0dGxlIHN5bmMgdW5kZXIgdGhlIG9sZCBtb2RlIGNoYW5nZWQgYWZ0ZXIgdGhlIHN3aXRjaCB3YXMgY291bnRlZFxuICAgICAgc2NoZWR1bGVTdGFzaFJhdGluZ1N5bmMoKTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJmaWx0ZXJPcHBvbmVudHNcIjpcbiAgICAgIC8vIHN3aXRjaGluZyB0aGUgdG9nZ2xlIGNvdW50cyBhcyBjaGFuZ2luZyBmaWx0ZXJzOiByZXNldCBhbnkgcnVuXG4gICAgICBpZiAoc3RhdGUuY3VycmVudE1vZGUgIT09IFwic3dpc3NcIikgcmVzZXRSdW5TdGF0ZSgpO1xuICAgICAgc2F2ZVN0YXRlKCk7XG4gICAgICBsb2FkTmV3UGFpcigpO1xuICAgICAgdXBkYXRlQ2xpbWJQb29sV2FybmluZygpO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcInBsYWNlbWVudEZyb21Cb3R0b21cIjoge1xuICAgICAgLy8gUmVzdGFydCB0aGUgc2NlbmUncyBydW4gZnJvbSB0aGUgbmV3IHN0YXJ0IHBvaW50IChub3RoaW5nIGlzIHdyaXR0ZW4gdW50aWwgaXQgbGFuZHMpXG4gICAgICBjb25zdCBzY2VuZUlkID0gc3RhdGUuY3VycmVudE1vZGUgPT09IFwicGxhY2VtZW50XCIgPyBzdGF0ZS5wbGFjZW1lbnQ/LnNjZW5lLmlkIDogdW5kZWZpbmVkO1xuICAgICAgaWYgKHNjZW5lSWQpIHtcbiAgICAgICAgcmVzZXRSdW5TdGF0ZSgpO1xuICAgICAgICBzYXZlU3RhdGUoKTtcbiAgICAgICAgdm9pZCBsb2FkTmV3UGFpcihzY2VuZUlkKTtcbiAgICAgIH1cbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBjYXNlIFwicHJldmlld1ZvbHVtZVwiOlxuICAgIGNhc2UgXCJhdXRvcGxheVByZXZpZXdzXCI6XG4gICAgICBhcHBseVByZXZpZXdTZXR0aW5ncygpO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSBcIm9wZW5Jbk5ld1RhYlwiOlxuICAgIGNhc2UgXCJjbGVhbk1vZGVcIjpcbiAgICBjYXNlIFwic2hvd1RpZXJzXCI6XG4gICAgICByZXJlbmRlckN1cnJlbnRQYWlyKCk7XG4gICAgICBicmVhaztcbiAgfVxufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gb3Blbk1vZGFsKCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCfjq8gT3BlbmluZyBtb2RhbC4uLlwiKTtcblxuICBjb25zdCBbc2V0dGluZ3NPaywgY3VzdG9tRmllbGRzT2tdID0gYXdhaXQgUHJvbWlzZS5hbGwoW2xvYWRTZXR0aW5ncygpLCBzY2VuZUN1c3RvbUZpZWxkc1N1cHBvcnRlZCgpXSk7XG4gIGlmICghY3VzdG9tRmllbGRzT2spIHtcbiAgICBzaG93TWVzc2FnZU1vZGFsKFxuICAgICAgXCJTdGFzaCBCYXR0bGUgbmVlZHMgYSBuZXdlciB2ZXJzaW9uIG9mIFN0YXNoOiBpdCBzdG9yZXMgZWFjaCBzY2VuZSdzIEVMTyBpbiBzY2VuZSBjdXN0b20gZmllbGRzLCB3aGljaCB0aGlzIFN0YXNoIGRvZXNuJ3QgaGF2ZS4gVXBkYXRlIFN0YXNoIHRvIHVzZSBTdGFzaCBCYXR0bGUuXCIsXG4gICAgKTtcbiAgICByZXR1cm47XG4gIH1cbiAgLy8gV2l0aG91dCBzZXR0aW5ncywgQmF0dGxlIGNhbid0IHRlbGwgd2hldGhlciB0aGUgb25lLXRpbWUgRUxPIHNldHVwIGFscmVhZHkgcmFuIChhbmQgcnVubmluZ1xuICAvLyBpdCBhZ2FpbiB3b3VsZCBvdmVyd3JpdGUgZXZlcnkgc2NlbmUncyBFTE8pXG4gIGlmICghc2V0dGluZ3NPayAmJiBpc0Vsb1NldHVwUGVuZGluZygpKSB7XG4gICAgc2hvd01lc3NhZ2VNb2RhbChcIlN0YXNoIEJhdHRsZSBjb3VsZG4ndCBsb2FkIGl0cyBzZXR0aW5ncyBmcm9tIFN0YXNoLiBDbG9zZSBTdGFzaCBCYXR0bGUgYW5kIHRyeSBhZ2Fpbi5cIik7XG4gICAgcmV0dXJuO1xuICB9XG4gIGFkZEtleVN3YWxsb3dlcnMoKTtcbiAgaG9sZFN0YXNoTGlzdFJlZnJlc2godHJ1ZSk7XG5cbiAgLy8gT3B0aW9uYWxseSBwYXVzZSB3aGF0ZXZlciBTdGFzaCBpcyBwbGF5aW5nIHNvIGl0IGRvZXNuJ3Qgb3ZlcmxhcCB0aGUgYmF0dGxlIHByZXZpZXdzXG4gIGlmIChzdGF0ZS5zZXR0aW5ncy5wYXVzZU1lZGlhT25PcGVuKSB7XG4gICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MTWVkaWFFbGVtZW50PihcInZpZGVvLCBhdWRpb1wiKS5mb3JFYWNoKCh2KSA9PiB2LnBhdXNlKCkpO1xuICB9XG5cbiAgaWYgKCFzY2VuZU1pc3NpbmdMaXN0ZW5lckFkZGVkKSB7XG4gICAgc2NlbmVNaXNzaW5nTGlzdGVuZXJBZGRlZCA9IHRydWU7XG4gICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoU0NFTkVfTUlTU0lOR19FVkVOVCwgKGUpID0+IHtcbiAgICAgIHZvaWQgaGFuZGxlU2NlbmVHb25lKChlIGFzIEN1c3RvbUV2ZW50PHN0cmluZz4pLmRldGFpbCk7XG4gICAgfSk7XG4gIH1cblxuICAvLyBUcnkgdG8gbG9hZCBzYXZlZCBzdGF0ZVxuICBjb25zdCBoYXNTdGF0ZSA9IGxvYWRTdGF0ZSgpO1xuICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g8J+TiyBMb2NhbFN0b3JhZ2Ugc3RhdGU6ICR7aGFzU3RhdGUgPyBcImZvdW5kXCIgOiBcIm5vbmVcIn1gKTtcblxuICAvLyBDaGVjayBpZiBVUkwgZmlsdGVyIHBhcmFtcyBoYXZlIGNoYW5nZWQgLSBpZiBzbywgcmVzZXQgc3RhdGVcbiAgY29uc3QgY3VycmVudEZpbHRlclBhcmFtcyA9IHdpbmRvdy5sb2NhdGlvbi5zZWFyY2g7XG4gIGNvbnN0IGZpbHRlcnNDaGFuZ2VkID0gaGFzU3RhdGUgJiYgc3RhdGUuc2F2ZWRGaWx0ZXJQYXJhbXMgIT09IGN1cnJlbnRGaWx0ZXJQYXJhbXM7XG5cbiAgaWYgKGZpbHRlcnNDaGFuZ2VkKSB7XG4gICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSBGaWx0ZXIgcGFyYW1zIGNoYW5nZWQsIHJlc2V0dGluZyBydW4gc3RhdGUgYW5kIGZpbHRlcmVkIGNhY2hlXCIpO1xuICAgIHN0YXRlLmN1cnJlbnRQYWlyID0geyBsZWZ0OiBudWxsLCByaWdodDogbnVsbCB9O1xuICAgIHN0YXRlLmN1cnJlbnRSYW5rcyA9IHsgbGVmdDogbnVsbCwgcmlnaHQ6IG51bGwgfTtcbiAgICByZXNldFJ1blN0YXRlKCk7XG4gICAgc3RhdGUuc2F2ZWRGaWx0ZXJQYXJhbXMgPSBjdXJyZW50RmlsdGVyUGFyYW1zO1xuXG4gICAgLy8gQ2xlYXIgZmlsdGVyZWQgc2NlbmVzIGNhY2hlIChidXQga2VlcCBhbGwgc2NlbmVzIGNhY2hlKVxuICAgIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzID0gbnVsbDtcbiAgICBzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJLZXkgPSBudWxsO1xuXG4gICAgLy8gUmVzZXQgc2h1ZmZsZSBmb3IgbmV3IGZpbHRlclxuICAgIHJlc2V0U2h1ZmZsZSgpO1xuICB9XG5cbiAgLy8gRGV0ZWN0IGlmIG9wZW5lZCBmcm9tIGFuIGluZGl2aWR1YWwgc2NlbmUgcGFnZSAoZS5nLiAvc2NlbmVzLzEyMylcbiAgY29uc3Qgc2NlbmVQYWdlSWQgPSBnZXRTY2VuZUlkRnJvbVVybCgpO1xuICBjb25zdCBzY2VuZUFscmVhZHlJblBhaXIgPVxuICAgIHNjZW5lUGFnZUlkICYmXG4gICAgc3RhdGUuY3VycmVudFBhaXIubGVmdCAmJlxuICAgIHN0YXRlLmN1cnJlbnRQYWlyLnJpZ2h0ICYmXG4gICAgKFN0cmluZyhzdGF0ZS5jdXJyZW50UGFpci5sZWZ0LmlkKSA9PT0gc2NlbmVQYWdlSWQgfHxcbiAgICAgIFN0cmluZyhzdGF0ZS5jdXJyZW50UGFpci5yaWdodC5pZCkgPT09IHNjZW5lUGFnZUlkKTtcbiAgY29uc3QgZm9yY2VTY2VuZUJhdHRsZSA9IHNjZW5lUGFnZUlkICYmICFzY2VuZUFscmVhZHlJblBhaXI7XG5cbiAgaWYgKGZvcmNlU2NlbmVCYXR0bGUpIHtcbiAgICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g8J+OryBPcGVuZWQgZnJvbSBzY2VuZSBwYWdlICR7c2NlbmVQYWdlSWR9LCBzdGFydGluZyBuZXcgYmF0dGxlIHdpdGggdGhpcyBzY2VuZWApO1xuICAgIHJlc2V0UnVuU3RhdGUoKTtcbiAgICBzdGF0ZS5jdXJyZW50UGFpciA9IHsgbGVmdDogbnVsbCwgcmlnaHQ6IG51bGwgfTtcbiAgICBzdGF0ZS5jdXJyZW50UmFua3MgPSB7IGxlZnQ6IG51bGwsIHJpZ2h0OiBudWxsIH07XG4gIH1cblxuICAvLyBDaGVjayBmb3IgZXhpc3RpbmcgaGlkZGVuIG1vZGFsIC0gcmV1c2UgaXQgKHVubGVzcyBpdCdzIGEgbWVzc2FnZSBtb2RhbCwgc2VlIHNob3dNZXNzYWdlTW9kYWwpXG4gIGNvbnN0IGV4aXN0aW5nTW9kYWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInNiLW1vZGFsXCIpO1xuICBpZiAoXG4gICAgZXhpc3RpbmdNb2RhbCAmJlxuICAgIGV4aXN0aW5nTW9kYWwuY2xhc3NMaXN0LmNvbnRhaW5zKFwic2ItbW9kYWwtaGlkZGVuXCIpICYmXG4gICAgZXhpc3RpbmdNb2RhbC5xdWVyeVNlbGVjdG9yKFwiI3N0YXNoLWJhdHRsZS1jb250YWluZXJcIilcbiAgKSB7XG4gICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDimbvvuI8gUmV1c2luZyBleGlzdGluZyBtb2RhbFwiKTtcbiAgICBleGlzdGluZ01vZGFsLmNsYXNzTGlzdC5yZW1vdmUoXCJzYi1tb2RhbC1oaWRkZW5cIiwgXCJzYi1tb2RhbC1jbG9zaW5nXCIpO1xuICAgIGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LmFkZChCQVRUTEVfT1BFTl9DTEFTUyk7XG5cbiAgICAvLyBBbHdheXMgcmVvcGVuIG9uIHRoZSBCYXR0bGUgdGFiOyBzZXR0aW5ncyBtYXkgaGF2ZSBjaGFuZ2VkIGVsc2V3aGVyZSBtZWFud2hpbGVcbiAgICBzaG93VGFiKGV4aXN0aW5nTW9kYWwsIFwiYmF0dGxlXCIpO1xuICAgIHN5bmNTZXR0aW5nc0NvbnRyb2xzKGV4aXN0aW5nTW9kYWwpO1xuICAgIHVwZGF0ZVJhdGluZ3NOb3RlKCk7XG5cbiAgICAvLyBSZS1yZWdpc3RlciBrZXlib2FyZCBoYW5kbGVyXG4gICAgaWYgKG1vZGFsS2V5SGFuZGxlcikge1xuICAgICAgZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImtleWRvd25cIiwgbW9kYWxLZXlIYW5kbGVyLCB0cnVlKTtcbiAgICAgIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJrZXlkb3duXCIsIG1vZGFsS2V5SGFuZGxlciwgdHJ1ZSk7XG4gICAgfVxuXG4gICAgLy8gRm9jdXMgbW9kYWwgY29udGVudFxuICAgIGNvbnN0IG1vZGFsQ29udGVudCA9IGV4aXN0aW5nTW9kYWwucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCIuc2ItbW9kYWwtY29udGVudFwiKTtcbiAgICBpZiAobW9kYWxDb250ZW50KSBtb2RhbENvbnRlbnQuZm9jdXMoKTtcblxuICAgIC8vIFRoZSBvbmUtdGltZSBFTE8gc2V0dXAgc2hvd3MgaW4gcGxhY2Ugb2YgdGhlIGJhdHRsZSB1bnRpbCBpdCdzIGRvbmVcbiAgICBpZiAoaXNFbG9TZXR1cFBlbmRpbmcoKSkge1xuICAgICAgc2hvd1NldHVwU2NyZWVuKGV4aXN0aW5nTW9kYWwsICgpID0+IGFmdGVyU2V0dXAoZXhpc3RpbmdNb2RhbCkpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBoaWRlU2V0dXBTY3JlZW4oZXhpc3RpbmdNb2RhbCk7XG5cbiAgICAvLyBJZiBmaWx0ZXJzIGNoYW5nZWQsIG5vIHBhaXIsIG9yIGZvcmNlZCBzY2VuZSwgbG9hZCBuZXcgY29udGVudFxuICAgIGlmIChmb3JjZVNjZW5lQmF0dGxlKSB7XG4gICAgICBsb2FkTmV3UGFpcihzY2VuZVBhZ2VJZCk7XG4gICAgfSBlbHNlIGlmIChmaWx0ZXJzQ2hhbmdlZCkge1xuICAgICAgbG9hZE5ld1BhaXIoKTtcbiAgICB9IGVsc2UgaWYgKCFzdGF0ZS5jdXJyZW50UGFpci5sZWZ0IHx8ICFzdGF0ZS5jdXJyZW50UGFpci5yaWdodCkge1xuICAgICAgLy8gQSBmaW5pc2hlZCBydW4ncyBlbmQgc2NyZWVuIHN0YXlzIHVudGlsIFwiU3RhcnQgTmV3IFJ1blwiICh0aGUgcnVuIGNsZWFyZWQgaXRzIHBhaXIpXG4gICAgICBpZiAoIWRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoXCIjc2ItY29tcGFyaXNvbi1hcmVhIC5zYi1lbmQtc2NyZWVuXCIpKSBsb2FkTmV3UGFpcigpO1xuICAgIH0gZWxzZSBpZiAoZG9jdW1lbnQucXVlcnlTZWxlY3RvcihcIiNzYi1jb21wYXJpc29uLWFyZWEgLnNiLXZzLWNvbnRhaW5lclwiKSkge1xuICAgICAgLy8gRXhpc3RpbmcgcGFpciBpcyBzdGlsbCB2YWxpZCB1bmxlc3MgYSBzY2VuZSB3YXMgZGVsZXRlZCBlbHNld2hlcmUgbWVhbndoaWxlXG4gICAgICBhcHBseVByZXZpZXdTZXR0aW5ncygpO1xuICAgICAgdm9pZCB2ZXJpZnlDdXJyZW50UGFpcigpO1xuICAgIH1cblxuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIFJlbW92ZSBhbnkgb3RoZXIgZXhpc3RpbmcgbW9kYWwgKGEgbWVzc2FnZSBtb2RhbCwgb3IgYSB2aXNpYmxlIG9uZSwgd2hpY2ggc2hvdWxkbid0IGhhcHBlbilcbiAgaWYgKGV4aXN0aW5nTW9kYWwpIGV4aXN0aW5nTW9kYWwucmVtb3ZlKCk7XG5cbiAgLy8gSW5pdGlhbGl6ZSBmaWx0ZXIgcGFyYW1zIHRyYWNraW5nXG4gIGlmICghc3RhdGUuc2F2ZWRGaWx0ZXJQYXJhbXMpIHtcbiAgICBzdGF0ZS5zYXZlZEZpbHRlclBhcmFtcyA9IGN1cnJlbnRGaWx0ZXJQYXJhbXM7XG4gIH1cblxuICBjb25zdCBtb2RhbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIG1vZGFsLmlkID0gXCJzYi1tb2RhbFwiO1xuICBtb2RhbC5pbm5lckhUTUwgPSBgXG4gICAgICA8ZGl2IGNsYXNzPVwic2ItbW9kYWwtYmFja2Ryb3BcIj48L2Rpdj5cbiAgICAgIDxkaXYgY2xhc3M9XCJzYi1tb2RhbC1jb250ZW50XCI+XG4gICAgICAgIDxidXR0b24gY2xhc3M9XCJzYi1tb2RhbC1jbG9zZVwiIGFyaWEtbGFiZWw9XCJDbG9zZVwiPuKclTwvYnV0dG9uPlxuICAgICAgICAke2NyZWF0ZU1haW5VSSgpfVxuICAgICAgPC9kaXY+XG4gICAgYDtcblxuICBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKG1vZGFsKTtcbiAgZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QuYWRkKEJBVFRMRV9PUEVOX0NMQVNTKTtcblxuICAvLyBGb2N1cyB0aGUgbW9kYWwgY29udGVudCBzbyBrZXlib2FyZCBzaG9ydGN1dHMgd29yayBpbW1lZGlhdGVseVxuICBjb25zdCBtb2RhbENvbnRlbnQgPSBtb2RhbC5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIi5zYi1tb2RhbC1jb250ZW50XCIpO1xuICBpZiAobW9kYWxDb250ZW50KSB7XG4gICAgbW9kYWxDb250ZW50LnNldEF0dHJpYnV0ZShcInRhYmluZGV4XCIsIFwiLTFcIik7XG4gICAgbW9kYWxDb250ZW50LnN0eWxlLm91dGxpbmUgPSBcIm5vbmVcIjtcbiAgICBtb2RhbENvbnRlbnQuZm9jdXMoKTtcbiAgfVxuXG4gIC8vIE1vZGUgdG9nZ2xlIGJ1dHRvbnNcbiAgbW9kYWwucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oXCIuc2ItbW9kZS1idG5cIikuZm9yRWFjaCgoYnRuKSA9PiB7XG4gICAgYnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiB7XG4gICAgICBjb25zdCBuZXdNb2RlID0gYnRuLmRhdGFzZXQubW9kZSBhcyBNb2RlO1xuICAgICAgaWYgKG5ld01vZGUgIT09IHN0YXRlLmN1cnJlbnRNb2RlKSB7XG4gICAgICAgIHN0YXRlLmN1cnJlbnRNb2RlID0gbmV3TW9kZTtcblxuICAgICAgICByZXNldFJ1blN0YXRlKCk7XG5cbiAgICAgICAgLy8gUmVzZXQgc2h1ZmZsZSB0byBzdGFydCBmcmVzaCB3aXRoIG5ldyBtb2RlXG4gICAgICAgIHN0YXRlLnNodWZmbGVJbmRleCA9IDA7XG5cbiAgICAgICAgLy8gVXBkYXRlIGJ1dHRvbiBzdGF0ZXNcbiAgICAgICAgbW9kYWwucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oXCIuc2ItbW9kZS1idG5cIikuZm9yRWFjaCgoYikgPT4ge1xuICAgICAgICAgIGIuY2xhc3NMaXN0LnRvZ2dsZShcImFjdGl2ZVwiLCBiLmRhdGFzZXQubW9kZSA9PT0gc3RhdGUuY3VycmVudE1vZGUpO1xuICAgICAgICB9KTtcbiAgICAgICAgdXBkYXRlTW9kZUluZm8oKTtcblxuICAgICAgICAvLyBMb2FkIG5ldyBwYWlyIGluIG5ldyBtb2RlLCBwcmVzZXJ2aW5nIHNjZW5lIHBhZ2UgY29udGV4dFxuICAgICAgICBsb2FkTmV3UGFpcihnZXRTY2VuZUlkRnJvbVVybCgpKTtcbiAgICAgICAgdXBkYXRlQ2xpbWJQb29sV2FybmluZygpO1xuICAgICAgICBzYXZlU3RhdGUoKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfSk7XG5cbiAgLy8gVG91Y2gtb25seSDik5g6IHNob3cvaGlkZSB0aGUgY3VycmVudCBtb2RlJ3MgZXhwbGFuYXRpb25cbiAgY29uc3QgbW9kZUluZm9CdG4gPSBtb2RhbC5xdWVyeVNlbGVjdG9yPEhUTUxCdXR0b25FbGVtZW50PihcIi5zYi1tb2RlLWluZm8tYnRuXCIpO1xuICBjb25zdCBtb2RlSW5mbyA9IG1vZGFsLnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiI3NiLW1vZGUtaW5mb1wiKTtcbiAgbW9kZUluZm9CdG4/LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiB7XG4gICAgaWYgKCFtb2RlSW5mbykgcmV0dXJuO1xuICAgIHVwZGF0ZU1vZGVJbmZvKCk7XG4gICAgbW9kZUluZm8uaGlkZGVuID0gIW1vZGVJbmZvLmhpZGRlbjtcbiAgICBtb2RlSW5mb0J0bi5zZXRBdHRyaWJ1dGUoXCJhcmlhLWV4cGFuZGVkXCIsIFN0cmluZyghbW9kZUluZm8uaGlkZGVuKSk7XG4gIH0pO1xuXG4gIC8vIEJhdHRsZSAvIFNldHRpbmdzIHRhYnMsIHNldHRpbmdzIGNvbnRyb2xzLCB2b2x1bWVcbiAgc2hvd1RhYihtb2RhbCwgXCJiYXR0bGVcIik7XG4gIGJpbmRTZXR0aW5nc0NvbnRyb2xzKG1vZGFsLCBvblNldHRpbmdDaGFuZ2VkLCAoKSA9PiBhcHBseVByZXZpZXdTZXR0aW5ncygpLCBjb25maXJtU2V0dGluZ0NoYW5nZSk7XG4gIHVwZGF0ZVJhdGluZ3NOb3RlKCk7XG5cbiAgbW9kYWwucXVlcnlTZWxlY3RvcignW2RhdGEtYWN0aW9uPVwicmVzZXQtZWxvXCJdJyk/LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiB2b2lkIHN0YXJ0UmVzZXRFbG8obW9kYWwpKTtcbiAgLy8gQmF0dGxlIHRhYiBub3RlJ3MgXCJjaGFuZ2UgaW4gU2V0dGluZ3NcIiBsaW5rXG4gIG1vZGFsLnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLWFjdGlvbj1cIm9wZW4tc2V0dGluZ3NcIl0nKT8uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XG4gICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgIHNob3dUYWIobW9kYWwsIFwic2V0dGluZ3NcIik7XG4gICAgYXBwbHlQcmV2aWV3U2V0dGluZ3MoKTtcbiAgfSk7XG5cbiAgLy8gU2tpcCBidXR0b25cbiAgbW9kYWwucXVlcnlTZWxlY3RvcihcIiNzYi1za2lwLWJ0blwiKT8uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIHNraXBQYWlyKTtcblxuICAvLyBSZWZyZXNoIGNhY2hlIGJ1dHRvblxuICBjb25zdCByZWZyZXNoQ2FjaGVCdG4gPSBtb2RhbC5xdWVyeVNlbGVjdG9yPEhUTUxCdXR0b25FbGVtZW50PihcIiNzYi1yZWZyZXNoLWNhY2hlLWJ0blwiKTtcbiAgaWYgKHJlZnJlc2hDYWNoZUJ0bikge1xuICAgIHJlZnJlc2hDYWNoZUJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgaWYgKHN0YXRlLmRpc2FibGVDaG9pY2UpIHJldHVybjtcblxuICAgICAgY29uc3QgbGFiZWwgPSByZWZyZXNoQ2FjaGVCdG4udGV4dENvbnRlbnQ7XG4gICAgICByZWZyZXNoQ2FjaGVCdG4uZGlzYWJsZWQgPSB0cnVlO1xuICAgICAgcmVmcmVzaENhY2hlQnRuLnRleHRDb250ZW50ID0gXCLwn5SEIFJlZnJlc2hpbmcuLi5cIjtcblxuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgY2xlYXJTY2VuZUNhY2hlKCk7XG5cbiAgICAgICAgLy8gUmVzZXQgc2h1ZmZsZSBzdGF0ZSBzaW5jZSBzY2VuZSBsaXN0IGlzIGJlaW5nIHJlZnJlc2hlZFxuICAgICAgICByZXNldFNodWZmbGUoKTtcblxuICAgICAgICAvLyBSZXNldCBydW4gc3RhdGUgc2luY2UgcmFua2luZ3MgbWF5IGhhdmUgY2hhbmdlZFxuICAgICAgICByZXNldFJ1blN0YXRlKCk7XG4gICAgICAgIHNhdmVTdGF0ZSgpO1xuXG4gICAgICAgIGF3YWl0IGxvYWROZXdQYWlyKCk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IoXCJbU3Rhc2ggQmF0dGxlXSBSZWZyZXNoIGZhaWxlZDpcIiwgZSk7XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICByZWZyZXNoQ2FjaGVCdG4uZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAgICAgcmVmcmVzaENhY2hlQnRuLnRleHRDb250ZW50ID0gbGFiZWw7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cblxuICAvLyBMb2FkIGluaXRpYWwgY29tcGFyaXNvbiBvciByZXN0b3JlIHNhdmVkIHBhaXIsIGFmdGVyIHRoZSBvbmUtdGltZSBFTE8gc2V0dXAgaWYgaXQncyBwZW5kaW5nXG4gIGlmIChpc0Vsb1NldHVwUGVuZGluZygpKSB7XG4gICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn6etIEVMTyBzZXR1cCBub3QgZG9uZSB5ZXQsIHNob3dpbmcgc2V0dXBcIik7XG4gICAgc2hvd1NldHVwU2NyZWVuKG1vZGFsLCAoKSA9PiBhZnRlclNldHVwKG1vZGFsKSk7XG4gIH0gZWxzZSBpZiAoZm9yY2VTY2VuZUJhdHRsZSkge1xuICAgIGNvbnNvbGUubG9nKGBbU3Rhc2ggQmF0dGxlXSDwn46vIFN0YXJ0aW5nIGJhdHRsZSB3aXRoIHNjZW5lICR7c2NlbmVQYWdlSWR9IGZyb20gc2NlbmUgcGFnZWApO1xuICAgIGxvYWROZXdQYWlyKHNjZW5lUGFnZUlkKTtcbiAgfSBlbHNlIGlmIChoYXNTdGF0ZSAmJiBzdGF0ZS5jdXJyZW50UGFpci5sZWZ0ICYmIHN0YXRlLmN1cnJlbnRQYWlyLnJpZ2h0ICYmICFmaWx0ZXJzQ2hhbmdlZCkge1xuICAgIGNvbnNvbGUubG9nKFxuICAgICAgYFtTdGFzaCBCYXR0bGVdIPCfk4IgUmVzdG9yaW5nIHNhdmVkIHBhaXIgZnJvbSBsb2NhbFN0b3JhZ2UgKFNjZW5lICR7c3RhdGUuY3VycmVudFBhaXIubGVmdC5pZH0gdnMgU2NlbmUgJHtzdGF0ZS5jdXJyZW50UGFpci5yaWdodC5pZH0pYCxcbiAgICApO1xuICAgIHZvaWQgcmVzdG9yZUN1cnJlbnRQYWlyKCk7XG4gIH0gZWxzZSB7XG4gICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn4aVIE5vIHNhdmVkIHBhaXIgb3IgZmlsdGVycyBjaGFuZ2VkLCBsb2FkaW5nIG5ldyBwYWlyLi4uXCIpO1xuICAgIGxvYWROZXdQYWlyKCk7XG4gIH1cblxuICAvLyBDbG9zZSBoYW5kbGVyc1xuICBtb2RhbC5xdWVyeVNlbGVjdG9yKFwiLnNiLW1vZGFsLWJhY2tkcm9wXCIpPy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgY2xvc2VNb2RhbCk7XG4gIG1vZGFsLnF1ZXJ5U2VsZWN0b3IoXCIuc2ItbW9kYWwtY2xvc2VcIik/LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBjbG9zZU1vZGFsKTtcblxuICAvLyBSZW1vdmUgYW55IGV4aXN0aW5nIGtleWJvYXJkIGhhbmRsZXJzIGJlZm9yZSBhZGRpbmcgbmV3IG9uZXNcbiAgaWYgKG1vZGFsS2V5SGFuZGxlcikge1xuICAgIGRvY3VtZW50LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJrZXlkb3duXCIsIG1vZGFsS2V5SGFuZGxlciwgdHJ1ZSk7XG4gIH1cblxuICAvLyBTaW5nbGUga2V5Ym9hcmQgaGFuZGxlciBmb3IgYWxsIG1vZGFsIHNob3J0Y3V0c1xuICBtb2RhbEtleUhhbmRsZXIgPSBmdW5jdGlvbiAoZTogS2V5Ym9hcmRFdmVudCkge1xuICAgIGNvbnN0IGFjdGl2ZU1vZGFsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzYi1tb2RhbFwiKTtcbiAgICBpZiAoIWFjdGl2ZU1vZGFsKSB7XG4gICAgICBpZiAobW9kYWxLZXlIYW5kbGVyKSBkb2N1bWVudC5yZW1vdmVFdmVudExpc3RlbmVyKFwia2V5ZG93blwiLCBtb2RhbEtleUhhbmRsZXIsIHRydWUpO1xuICAgICAgbW9kYWxLZXlIYW5kbGVyID0gbnVsbDtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBTdGFzaCdzIG93biBkZWxldGUgZGlhbG9nIChDbGVhbiBtb2RlKSBpcyBvbiB0b3A6IGxldCBpdCBoYXZlIHRoZSBrZXlzIChFc2NhcGUsIEVudGVyKVxuICAgIGlmIChpc0RlbGV0ZURpYWxvZ09wZW4oKSkgcmV0dXJuO1xuXG4gICAgLy8gTm90aGluZyB0eXBlZCB3aGlsZSBCYXR0bGUgaXMgb3BlbiBtYXkgcmVhY2ggU3Rhc2gncyBvd24gaG90a2V5cyAocGFnZSBhcnJvd3MsIGxldHRlclxuICAgIC8vIHNob3J0Y3V0cyksIG9yIGl0IGFjdHMgb24gdGhlIHBhZ2UgYmVoaW5kIHRoZSBtb2RhbC4gRGVmYXVsdCBhY3Rpb25zICh0eXBpbmcgaW4gaW5wdXRzLFxuICAgIC8vIHNsaWRlciBhcnJvd3MsIGNoZWNrYm94IFNwYWNlKSBzdGlsbCBoYXBwZW4gc2luY2Ugb25seSBwcm9wYWdhdGlvbiBpcyBzdG9wcGVkIGhlcmUuXG4gICAgZS5zdG9wSW1tZWRpYXRlUHJvcGFnYXRpb24oKTtcblxuICAgIC8vIEEgY29uZmlybWF0aW9uIGRpYWxvZyBpcyBvcGVuOiBFc2NhcGUgY2FuY2VscyBpdCwgb3RoZXIga2V5cyBhcmUgaXRzIG93biAoVGFiLCBFbnRlcilcbiAgICBpZiAoaXNDb25maXJtRGlhbG9nT3BlbigpKSB7XG4gICAgICBpZiAoZS5rZXkgPT09IFwiRXNjYXBlXCIpIHtcbiAgICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgICBjYW5jZWxDb25maXJtRGlhbG9nKCk7XG4gICAgICB9XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gRXNjYXBlIHRvIGNsb3NlXG4gICAgaWYgKGUua2V5ID09PSBcIkVzY2FwZVwiKSB7XG4gICAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgICBjbG9zZU1vZGFsKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gQmF0dGxlIHNob3J0Y3V0cyBvbmx5IGFwcGx5IG9uIHRoZSBCYXR0bGUgdGFiLCBvbmNlIEVMTyBzZXR1cCBpcyBkb25lXG4gICAgaWYgKGdldEFjdGl2ZVRhYigpICE9PSBcImJhdHRsZVwiIHx8IGlzRWxvU2V0dXBQZW5kaW5nKCkpIHJldHVybjtcblxuICAgIC8vIExldCB0aGUgdm9sdW1lIHNsaWRlciAvIG51bWJlciBpbnB1dCBrZWVwIHRoZWlyIG93biBhcnJvdyBrZXlzIChjaGVja2JveGVzIGRvbid0IG5lZWQgdGhlbSlcbiAgICBjb25zdCBhY3RpdmUgPSBkb2N1bWVudC5hY3RpdmVFbGVtZW50IGFzIEhUTUxJbnB1dEVsZW1lbnQgfCBudWxsO1xuICAgIGNvbnN0IHRhZyA9IGFjdGl2ZT8udGFnTmFtZTtcbiAgICBjb25zdCBpc1RvZ2dsZSA9IHRhZyA9PT0gXCJJTlBVVFwiICYmIChhY3RpdmU/LnR5cGUgPT09IFwiY2hlY2tib3hcIiB8fCBhY3RpdmU/LnR5cGUgPT09IFwicmFkaW9cIik7XG4gICAgaWYgKCh0YWcgPT09IFwiSU5QVVRcIiAmJiAhaXNUb2dnbGUpIHx8IHRhZyA9PT0gXCJURVhUQVJFQVwiIHx8IHRhZyA9PT0gXCJTRUxFQ1RcIikgcmV0dXJuO1xuXG4gICAgLy8gQXJyb3cga2V5cyB0byBjaG9vc2VcbiAgICBpZiAoZS5rZXkgPT09IFwiQXJyb3dMZWZ0XCIgJiYgc3RhdGUuY3VycmVudFBhaXIubGVmdCkge1xuICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgY29uc3QgbGVmdEJvZHkgPSBhY3RpdmVNb2RhbC5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PignLnNiLXNjZW5lLWNhcmRbZGF0YS1zaWRlPVwibGVmdFwiXSAuc2Itc2NlbmUtYm9keScpO1xuICAgICAgaWYgKGxlZnRCb2R5KSBsZWZ0Qm9keS5jbGljaygpO1xuICAgIH1cbiAgICBpZiAoZS5rZXkgPT09IFwiQXJyb3dSaWdodFwiICYmIHN0YXRlLmN1cnJlbnRQYWlyLnJpZ2h0KSB7XG4gICAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgICBjb25zdCByaWdodEJvZHkgPSBhY3RpdmVNb2RhbC5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PignLnNiLXNjZW5lLWNhcmRbZGF0YS1zaWRlPVwicmlnaHRcIl0gLnNiLXNjZW5lLWJvZHknKTtcbiAgICAgIGlmIChyaWdodEJvZHkpIHJpZ2h0Qm9keS5jbGljaygpO1xuICAgIH1cblxuICAgIC8vIFNwYWNlYmFyIHRvIHNraXBcbiAgICBpZiAoZS5rZXkgPT09IFwiIFwiIHx8IGUuY29kZSA9PT0gXCJTcGFjZVwiKSB7XG4gICAgICAvLyBMZXQgYSBmb2N1c2VkIGJ1dHRvbiBvciBjaGVja2JveCBoYW5kbGUgaXRzIG93biBTcGFjZVxuICAgICAgaWYgKHRhZyA9PT0gXCJCVVRUT05cIiB8fCBpc1RvZ2dsZSkgcmV0dXJuO1xuICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgc2tpcFBhaXIoKTtcbiAgICB9XG4gIH07XG5cbiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcImtleWRvd25cIiwgbW9kYWxLZXlIYW5kbGVyLCB0cnVlKTtcbn1cblxuLyoqIEEgbW9kYWwgd2l0aCBqdXN0IGEgbWVzc2FnZSwgc2hvd24gaW5zdGVhZCBvZiBCYXR0bGUgKGUuZy4gdGhpcyBTdGFzaCBsYWNrcyBjdXN0b20gZmllbGRzKS4gKi9cbmZ1bmN0aW9uIHNob3dNZXNzYWdlTW9kYWwobWVzc2FnZTogc3RyaW5nKTogdm9pZCB7XG4gIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic2ItbW9kYWxcIik/LnJlbW92ZSgpO1xuICBjb25zdCBtb2RhbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIG1vZGFsLmlkID0gXCJzYi1tb2RhbFwiO1xuICBtb2RhbC5pbm5lckhUTUwgPSBgXG4gICAgICA8ZGl2IGNsYXNzPVwic2ItbW9kYWwtYmFja2Ryb3BcIj48L2Rpdj5cbiAgICAgIDxkaXYgY2xhc3M9XCJzYi1tb2RhbC1jb250ZW50XCI+XG4gICAgICAgIDxidXR0b24gY2xhc3M9XCJzYi1tb2RhbC1jbG9zZVwiIGFyaWEtbGFiZWw9XCJDbG9zZVwiPuKclTwvYnV0dG9uPlxuICAgICAgICA8ZGl2IGNsYXNzPVwic2ItZXJyb3Itc2NyZWVuXCI+XG4gICAgICAgICAgPGRpdiBjbGFzcz1cInNiLWVycm9yLWljb25cIj7imqDvuI88L2Rpdj5cbiAgICAgICAgICA8cCBjbGFzcz1cInNiLWVycm9yLW1lc3NhZ2VcIj4ke21lc3NhZ2V9PC9wPlxuICAgICAgICA8L2Rpdj5cbiAgICAgIDwvZGl2PlxuICAgIGA7XG4gIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQobW9kYWwpO1xuICBkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5hZGQoQkFUVExFX09QRU5fQ0xBU1MpO1xuICBtb2RhbC5xdWVyeVNlbGVjdG9yKFwiLnNiLW1vZGFsLWJhY2tkcm9wXCIpPy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgY2xvc2VNb2RhbCk7XG4gIG1vZGFsLnF1ZXJ5U2VsZWN0b3IoXCIuc2ItbW9kYWwtY2xvc2VcIik/LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBjbG9zZU1vZGFsKTtcbn1cblxuLyoqIFRydWUgd2hpbGUgdGhlIGJhdHRsZSBtb2RhbCBpcyBvbiBzY3JlZW4gKGl0IHN0YXlzIGluIHRoZSBET00sIGhpZGRlbiwgYWZ0ZXIgY2xvc2luZykuICovXG5mdW5jdGlvbiBpc01vZGFsVmlzaWJsZSgpOiBib29sZWFuIHtcbiAgY29uc3QgbW9kYWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInNiLW1vZGFsXCIpO1xuICByZXR1cm4gbW9kYWwgIT09IG51bGwgJiYgIW1vZGFsLmNsYXNzTGlzdC5jb250YWlucyhcInNiLW1vZGFsLWhpZGRlblwiKTtcbn1cblxuLy8gU3Rhc2gncyBob3RrZXlzIChNb3VzZXRyYXApIGFsc28gbGlzdGVuIGZvciBrZXlwcmVzcy9rZXl1cCBvbiBkb2N1bWVudDsga2V5ZG93biBpcyBoYW5kbGVkXG4vLyBieSBtb2RhbEtleUhhbmRsZXIuIFJlZ2lzdGVyZWQgb25jZSwgaW4gdGhlIGNhcHR1cmUgcGhhc2UsIGFuZCBpbmVydCB3aGlsZSB0aGUgbW9kYWwgaXMgaGlkZGVuLlxubGV0IGtleVN3YWxsb3dlcnNBZGRlZCA9IGZhbHNlO1xuZnVuY3Rpb24gYWRkS2V5U3dhbGxvd2VycygpOiB2b2lkIHtcbiAgaWYgKGtleVN3YWxsb3dlcnNBZGRlZCkgcmV0dXJuO1xuICBrZXlTd2FsbG93ZXJzQWRkZWQgPSB0cnVlO1xuICBjb25zdCBzd2FsbG93ID0gKGU6IEtleWJvYXJkRXZlbnQpOiB2b2lkID0+IHtcbiAgICBpZiAoaXNNb2RhbFZpc2libGUoKSAmJiAhaXNEZWxldGVEaWFsb2dPcGVuKCkpIGUuc3RvcEltbWVkaWF0ZVByb3BhZ2F0aW9uKCk7XG4gIH07XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJrZXlwcmVzc1wiLCBzd2FsbG93LCB0cnVlKTtcbiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcImtleXVwXCIsIHN3YWxsb3csIHRydWUpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY2xvc2VNb2RhbCgpOiB2b2lkIHtcbiAgY29uc3QgbW9kYWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInNiLW1vZGFsXCIpO1xuICBpZiAoIW1vZGFsIHx8IG1vZGFsLmNsYXNzTGlzdC5jb250YWlucyhcInNiLW1vZGFsLWhpZGRlblwiKSkgcmV0dXJuO1xuXG4gIGNhbmNlbERlbGV0ZURpYWxvZygpO1xuICBjYW5jZWxDb25maXJtRGlhbG9nKCk7XG4gIC8vIFN0YXNoJ3Mgc2NlbmUgbGlzdHMgc2hvdyB0aGUgcmF0aW5ncyB3cml0dGVuIHdoaWxlIFN0YXNoIEJhdHRsZSB3YXMgb3BlbiwgYW5kIGEgc2NlbmUgcGFnZSBpdHMgRUxPXG4gIGhvbGRTdGFzaExpc3RSZWZyZXNoKGZhbHNlKTtcbiAgcmVmcmVzaFNjZW5lRWxvKCk7XG4gIC8vIENsb3NpbmcgU3Rhc2ggQmF0dGxlIG9uIFJlc2V0IEVMTydzIGNob2ljZXMgKGJlZm9yZSBTdGFydCkgY2FuY2VscyB0aGUgcmVzZXRcbiAgaWYgKHN0YXRlLnJlc2V0dGluZ0VsbyAmJiAhaXNTZXR1cFJ1bm5pbmcoKSkge1xuICAgIHN0YXRlLnJlc2V0dGluZ0VsbyA9IGZhbHNlO1xuICAgIGhpZGVTZXR1cFNjcmVlbihtb2RhbCk7XG4gIH1cblxuICAvLyBTdG9wIHByZXZpZXdzIChhdXRvcGxheSBrZWVwcyB0aGVtIHJ1bm5pbmcgb3RoZXJ3aXNlKVxuICBtb2RhbC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxWaWRlb0VsZW1lbnQ+KFwiLnNiLWhvdmVyLXByZXZpZXdcIikuZm9yRWFjaCgodikgPT4gdi5wYXVzZSgpKTtcblxuICAvLyBBZGQgY2xvc2luZyBjbGFzcyB0byB0cmlnZ2VyIGZhZGUtb3V0IGFuaW1hdGlvblxuICBtb2RhbC5jbGFzc0xpc3QuYWRkKFwic2ItbW9kYWwtY2xvc2luZ1wiKTtcblxuICAvLyBBZnRlciBhbmltYXRpb24gY29tcGxldGVzLCBoaWRlIHRoZSBtb2RhbCAoa2VlcCBpbiBET00gZm9yIHJldXNlKVxuICBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICBtb2RhbC5jbGFzc0xpc3QuYWRkKFwic2ItbW9kYWwtaGlkZGVuXCIpO1xuICAgIGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LnJlbW92ZShCQVRUTEVfT1BFTl9DTEFTUyk7XG4gICAgbW9kYWwuY2xhc3NMaXN0LnJlbW92ZShcInNiLW1vZGFsLWNsb3NpbmdcIik7XG4gIH0sIDIwMCk7IC8vIE1hdGNoIENTUyBhbmltYXRpb24gZHVyYXRpb25cblxuICAvLyBDbGVhbiB1cCBrZXlib2FyZCBoYW5kbGVyXG4gIGlmIChtb2RhbEtleUhhbmRsZXIpIHtcbiAgICBkb2N1bWVudC5yZW1vdmVFdmVudExpc3RlbmVyKFwia2V5ZG93blwiLCBtb2RhbEtleUhhbmRsZXIsIHRydWUpO1xuICB9XG59XG5cbiIsICIvLyBUaGUgbmF2YmFyIFwiQmF0dGxlXCIgYnV0dG9uIHRoYXQgb3BlbnMgdGhlIGNvbXBhcmlzb24gbW9kYWwuXG4vL1xuLy8gV2hlcmUgU3Rhc2ggaGFzIHRoZSBwbHVnaW4gcGF0Y2ggQVBJLCB0aGUgYnV0dG9uIGlzIHBhdGNoZWQgaW50byBNYWluTmF2QmFyLk1lbnVJdGVtcyAoYWZ0ZXJcbi8vIFN0YXNoJ3Mgb3duIHBhZ2UgbGlua3MpLCBzbyBSZWFjdCByZW5kZXJzIGl0IHdpdGggdGhlIHJlc3Qgb2YgdGhlIG5hdmJhci4gT3RoZXJ3aXNlIGl0J3MgYWRkZWRcbi8vIHRvIHRoZSBET00gZGlyZWN0bHkgYW5kIHJlLWFkZGVkIHdoZW5ldmVyIHRoZSBwYWdlIGNoYW5nZXMuXG5cbmltcG9ydCB0eXBlIHsgUGx1Z2luQXBpTGlrZSwgUmVhY3ROb2RlIH0gZnJvbSBcIi4uL3BsdWdpbkFwaVwiO1xuaW1wb3J0IHsgU1dPUkRTX1BBVEhTIH0gZnJvbSBcIi4vaWNvbnNcIjtcbmltcG9ydCB7IG9wZW5Nb2RhbCB9IGZyb20gXCIuL21vZGFsXCI7XG5cbmNvbnN0IEJVVFRPTl9JRCA9IFwicGx1Z2luX3NiXCI7XG5jb25zdCBOQVZfSVRFTV9DTEFTUyA9IFwiY29sLTQgY29sLXNtLTMgY29sLW1kLTIgY29sLWxnLWF1dG8gbmF2LWxpbmtcIjtcbmNvbnN0IExJTktfQ0xBU1MgPVxuICBcIm1pbmltYWwgcC00IHAteGwtMiBkLWZsZXggZC14bC1pbmxpbmUtYmxvY2sgZmxleC1jb2x1bW4ganVzdGlmeS1jb250ZW50LWJldHdlZW4gYWxpZ24taXRlbXMtY2VudGVyIGJ0biBidG4tcHJpbWFyeVwiO1xuY29uc3QgTElOS19IVE1MID0gYFxuICAgICAgICAgICAgPHN2ZyBhcmlhLWhpZGRlbj1cInRydWVcIiBmb2N1c2FibGU9XCJmYWxzZVwiIGNsYXNzPVwic3ZnLWlubGluZS0tZmEgZmEtaWNvbiBuYXYtbWVudS1pY29uIGQtYmxvY2sgZC14bC1pbmxpbmUgbWItMiBtYi14bC0wXCIgcm9sZT1cImltZ1wiIHhtbG5zPVwiaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmdcIiB2aWV3Qm94PVwiMCAwIDM2IDM2XCI+JHtTV09SRFNfUEFUSFN9PC9zdmc+XG4gICAgICAgICAgICA8c3Bhbj5CYXR0bGU8L3NwYW4+XG4gICAgICAgIGA7XG5cbmV4cG9ydCBmdW5jdGlvbiBzaG91bGRTaG93TmF2QnV0dG9uKCk6IGJvb2xlYW4ge1xuICBjb25zdCBwYXRoID0gd2luZG93LmxvY2F0aW9uLnBhdGhuYW1lO1xuICByZXR1cm4gKFxuICAgIHBhdGggPT09IFwiL1wiIHx8XG4gICAgcGF0aCA9PT0gXCIvc2NlbmVzXCIgfHxcbiAgICBwYXRoID09PSBcIi9zY2VuZXMvXCIgfHxcbiAgICBwYXRoLnN0YXJ0c1dpdGgoXCIvc2NlbmVzL1wiKVxuICApO1xufVxuXG5mdW5jdGlvbiBvbkJ1dHRvbkNsaWNrKGU6IHsgcHJldmVudERlZmF1bHQoKTogdm9pZCB9KTogdm9pZCB7XG4gIGUucHJldmVudERlZmF1bHQoKTtcbiAgdm9pZCBvcGVuTW9kYWwoKTtcbn1cblxuLyoqIEFkZCB0aGUgQmF0dGxlIG5hdiBpdGVtIHRvIFN0YXNoJ3MgbmF2YmFyLCBzaG93biBvbmx5IG9uIHRoZSByb3V0ZXMgd2hlcmUgaXQgYXBwbGllcy4gQ2FsbCBvbmNlIGF0IHN0YXJ0dXAuICovXG5leHBvcnQgZnVuY3Rpb24gcmVnaXN0ZXJOYXZCdXR0b24oKTogdm9pZCB7XG4gIGNvbnN0IGFwaSA9IHdpbmRvdy5QbHVnaW5BcGk7XG4gIGlmIChhcGk/LmNvbXBvbmVudHM/LltcIk1haW5OYXZCYXIuTWVudUl0ZW1zXCJdICYmIHR5cGVvZiBhcGkucGF0Y2g/LmJlZm9yZSA9PT0gXCJmdW5jdGlvblwiKSB7XG4gICAgcGF0Y2hOYXZCdXR0b24oYXBpKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBpbmplY3ROYXZCdXR0b24oKTtcblxuICAvLyBSZS1pbmplY3QgbmF2IGJ1dHRvbiBhZnRlciBTdGFzaCBTUEEgbmF2aWdhdGlvbiByZWJ1aWxkcyB0aGUgbmF2YmFyXG4gIGNvbnN0IG9ic2VydmVyID0gbmV3IE11dGF0aW9uT2JzZXJ2ZXIoKCkgPT4ge1xuICAgIGluamVjdE5hdkJ1dHRvbigpO1xuICB9KTtcblxuICBvYnNlcnZlci5vYnNlcnZlKGRvY3VtZW50LmJvZHksIHtcbiAgICBjaGlsZExpc3Q6IHRydWUsXG4gICAgc3VidHJlZTogdHJ1ZSxcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHBhdGNoTmF2QnV0dG9uKGFwaTogUGx1Z2luQXBpTGlrZSk6IHZvaWQge1xuICBjb25zdCB7IFJlYWN0IH0gPSBhcGk7XG4gIGNvbnN0IGV2ZW50cyA9IGFwaS5FdmVudDtcblxuICBmdW5jdGlvbiBCYXR0bGVOYXZJdGVtKCk6IFJlYWN0Tm9kZSB7XG4gICAgLy8gVGhlIHJvdXRlIGlzIHJlYWQgb24gZXZlcnkgcmVuZGVyOyB0aGUgc3RhdGUgb25seSBtYWtlcyBTdGFzaCdzIG5hdmlnYXRpb24gZXZlbnRzIHJlLXJlbmRlclxuICAgIGNvbnN0IFssIHNldFBhdGhdID0gUmVhY3QudXNlU3RhdGUod2luZG93LmxvY2F0aW9uLnBhdGhuYW1lKTtcblxuICAgIFJlYWN0LnVzZUVmZmVjdCgoKSA9PiB7XG4gICAgICBpZiAoIWV2ZW50cykgcmV0dXJuO1xuICAgICAgY29uc3QgdXBkYXRlID0gKCk6IHZvaWQgPT4gc2V0UGF0aCh3aW5kb3cubG9jYXRpb24ucGF0aG5hbWUpO1xuICAgICAgdXBkYXRlKCk7XG4gICAgICBldmVudHMuYWRkRXZlbnRMaXN0ZW5lcihcInN0YXNoOmxvY2F0aW9uXCIsIHVwZGF0ZSk7XG4gICAgICByZXR1cm4gKCkgPT4gZXZlbnRzLnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJzdGFzaDpsb2NhdGlvblwiLCB1cGRhdGUpO1xuICAgIH0sIFtdKTtcblxuICAgIGlmICghc2hvdWxkU2hvd05hdkJ1dHRvbigpKSByZXR1cm4gbnVsbDtcbiAgICByZXR1cm4gUmVhY3QuY3JlYXRlRWxlbWVudChcbiAgICAgIFwiZGl2XCIsXG4gICAgICB7IGlkOiBCVVRUT05fSUQsIGNsYXNzTmFtZTogTkFWX0lURU1fQ0xBU1MgfSxcbiAgICAgIFJlYWN0LmNyZWF0ZUVsZW1lbnQoXCJhXCIsIHtcbiAgICAgICAgaHJlZjogXCIjXCIsXG4gICAgICAgIGNsYXNzTmFtZTogTElOS19DTEFTUyxcbiAgICAgICAgb25DbGljazogb25CdXR0b25DbGljayxcbiAgICAgICAgZGFuZ2Vyb3VzbHlTZXRJbm5lckhUTUw6IHsgX19odG1sOiBMSU5LX0hUTUwgfSxcbiAgICAgIH0pLFxuICAgICk7XG4gIH1cblxuICAvLyBBcHBlbmQgdG8gdGhlIGNoaWxkcmVuIE1lbnVJdGVtcyByZW5kZXJzIGluIGl0cyBOYXYuIEV2ZXJ5IG90aGVyIGFyZyBpcyBwYXNzZWQgdGhyb3VnaCBhcyBpczpcbiAgLy8gYW4gYGFmdGVyYCBwYXRjaCBmaW5kcyB0aGUgcmVuZGVyZWQgcmVzdWx0IGJ5IHBvc2l0aW9uLCBzbyB0aGUgYXJnIGNvdW50IG11c3Qgbm90IGNoYW5nZS5cbiAgYXBpLnBhdGNoLmJlZm9yZShcIk1haW5OYXZCYXIuTWVudUl0ZW1zXCIsIChwcm9wcywgLi4ucmVzdCkgPT4gW1xuICAgIHtcbiAgICAgIC4uLihwcm9wcyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiksXG4gICAgICBjaGlsZHJlbjogWyhwcm9wcyBhcyB7IGNoaWxkcmVuPzogUmVhY3ROb2RlIH0pLmNoaWxkcmVuLCBSZWFjdC5jcmVhdGVFbGVtZW50KEJhdHRsZU5hdkl0ZW0sIHsga2V5OiBCVVRUT05fSUQgfSldLFxuICAgIH0sXG4gICAgLi4ucmVzdCxcbiAgXSk7XG59XG5cbi8qKiBJbmplY3Qgb3IgcmVtb3ZlIHRoZSBCYXR0bGUgbmF2IGl0ZW0gYmFzZWQgb24gdGhlIGN1cnJlbnQgcm91dGUuIFNhZmUgdG8gY2FsbCByZXBlYXRlZGx5LiAqL1xuZnVuY3Rpb24gaW5qZWN0TmF2QnV0dG9uKCk6IHZvaWQge1xuICBpZiAoIXNob3VsZFNob3dOYXZCdXR0b24oKSkge1xuICAgIGNvbnN0IGV4aXN0aW5nID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoQlVUVE9OX0lEKTtcbiAgICBpZiAoZXhpc3RpbmcpIHtcbiAgICAgIGV4aXN0aW5nLmNsb3Nlc3QoXCIubmF2LWxpbmtcIik/LnJlbW92ZSgpO1xuICAgIH1cbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAoZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoQlVUVE9OX0lEKSkgcmV0dXJuO1xuXG4gIGNvbnN0IG5hdkl0ZW0gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBuYXZJdGVtLmNsYXNzTmFtZSA9IE5BVl9JVEVNX0NMQVNTO1xuICBuYXZJdGVtLmlkID0gQlVUVE9OX0lEO1xuXG4gIGNvbnN0IGxpbmsgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiYVwiKTtcbiAgbGluay5ocmVmID0gXCIjXCI7XG4gIGxpbmsuY2xhc3NOYW1lID0gTElOS19DTEFTUztcbiAgbGluay5pbm5lckhUTUwgPSBMSU5LX0hUTUw7XG4gIGxpbmsuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIG9uQnV0dG9uQ2xpY2spO1xuICBuYXZJdGVtLmFwcGVuZENoaWxkKGxpbmspO1xuXG4gIGNvbnN0IG5hdlRhcmdldCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoXCIubmF2YmFyLW5hdlwiKTtcbiAgaWYgKG5hdlRhcmdldCkge1xuICAgIG5hdlRhcmdldC5hcHBlbmRDaGlsZChuYXZJdGVtKTtcbiAgfVxufVxuIiwgIi8vIFN0YXNoIEJhdHRsZSAtIGVudHJ5IHBvaW50LlxuLy8gQnVuZGxlZCBieSBlc2J1aWxkIGludG8gcGx1Z2lucy9zdGFzaC1iYXR0bGUvc3Rhc2gtYmF0dGxlLmpzIChJSUZFKS5cblxuaW1wb3J0IHsgcmVnaXN0ZXJEZWxldGVEaWFsb2dCcmlkZ2UgfSBmcm9tIFwiLi91aS9kZWxldGVEaWFsb2dcIjtcbmltcG9ydCB7IG9wZW5Nb2RhbCB9IGZyb20gXCIuL3VpL21vZGFsXCI7XG5pbXBvcnQgeyByZWdpc3Rlck5hdkJ1dHRvbiB9IGZyb20gXCIuL3VpL25hdkJ1dHRvblwiO1xuaW1wb3J0IHsgcmVnaXN0ZXJTY2VuZUVsbyB9IGZyb20gXCIuL3VpL3NjZW5lRWxvXCI7XG5cbmZ1bmN0aW9uIGluaXQoKTogdm9pZCB7XG4gIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0gSW5pdGlhbGl6ZWRcIik7XG5cbiAgcmVnaXN0ZXJEZWxldGVEaWFsb2dCcmlkZ2UoKTtcbiAgcmVnaXN0ZXJOYXZCdXR0b24oKTtcbiAgcmVnaXN0ZXJTY2VuZUVsbygoKSA9PiB2b2lkIG9wZW5Nb2RhbCgpKTtcbn1cblxuaWYgKGRvY3VtZW50LnJlYWR5U3RhdGUgPT09IFwibG9hZGluZ1wiKSB7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJET01Db250ZW50TG9hZGVkXCIsIGluaXQpO1xufSBlbHNlIHtcbiAgaW5pdCgpO1xufVxuIl0sCiAgIm1hcHBpbmdzIjogIjs7O0FBRU8sTUFBTSxjQUFjO0FBQ3BCLE1BQU0sZ0JBQWdCO0FBRXRCLE1BQU0sbUJBQW1CO0FBQ3pCLE1BQU0sbUJBQW1CO0FBQ3pCLE1BQU0sbUJBQW1CLElBQUksS0FBSztBQUtsQyxNQUFNLFlBQVk7QUFFbEIsTUFBTSxtQkFBNkI7QUFBQSxJQUN4QyxjQUFjO0FBQUEsSUFDZCxZQUFZO0FBQUEsSUFDWixjQUFjO0FBQUEsSUFDZCxjQUFjO0FBQUEsSUFDZCxxQkFBcUI7QUFBQSxJQUNyQixXQUFXO0FBQUEsSUFDWCxlQUFlO0FBQUEsSUFDZixrQkFBa0I7QUFBQSxJQUNsQixpQkFBaUI7QUFBQSxJQUNqQixXQUFXO0FBQUEsSUFDWCxrQkFBa0I7QUFBQSxFQUNwQjtBQUdPLE1BQU0sOEJBQThCO0FBQ3BDLE1BQU0sMkJBQTJCO0FBUWpDLE1BQU0sNEJBQTRCO0FB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O0FBRUwsVUFBSSxDQUFDLG9CQUFvQixFQUFHLFFBQU87QUFDbkMsYUFBTyxNQUFNO0FBQUEsUUFDWDtBQUFBLFFBQ0EsRUFBRSxJQUFJLFdBQVcsV0FBVyxlQUFlO0FBQUEsUUFDM0MsTUFBTSxjQUFjLEtBQUs7QUFBQSxVQUN2QixNQUFNO0FBQUEsVUFDTixXQUFXO0FBQUEsVUFDWCxTQUFTO0FBQUEsVUFDVCx5QkFBeUIsRUFBRSxRQUFRLFVBQVU7QUFBQSxRQUMvQyxDQUFDO0FBQUEsTUFDSDtBQUFBLElBQ0Y7QUFJQSxRQUFJLE1BQU0sT0FBTyx3QkFBd0IsQ0FBQyxVQUFVLFNBQVM7QUFBQSxNQUMzRDtBQUFBLFFBQ0UsR0FBSTtBQUFBLFFBQ0osVUFBVSxDQUFFLE1BQW1DLFVBQVUsTUFBTSxjQUFjLGVBQWUsRUFBRSxLQUFLLFVBQVUsQ0FBQyxDQUFDO0FBQUEsTUFDakg7QUFBQSxNQUNBLEdBQUc7QUFBQSxJQUNMLENBQUM7QUFBQSxFQUNIO0FBR0EsV0FBUyxrQkFBd0I7QUFDL0IsUUFBSSxDQUFDLG9CQUFvQixHQUFHO0FBQzFCLFlBQU0sV0FBVyxTQUFTLGVBQWUsU0FBUztBQUNsRCxVQUFJLFVBQVU7QUFDWixpQkFBUyxRQUFRLFdBQVcsR0FBRyxPQUFPO0FBQUEsTUFDeEM7QUFDQTtBQUFBLElBQ0Y7QUFFQSxRQUFJLFNBQVMsZUFBZSxTQUFTLEVBQUc7QUFFeEMsVUFBTSxVQUFVLFNBQVMsY0FBYyxLQUFLO0FBQzVDLFlBQVEsWUFBWTtBQUNwQixZQUFRLEtBQUs7QUFFYixVQUFNLE9BQU8sU0FBUyxjQUFjLEdBQUc7QUFDdkMsU0FBSyxPQUFPO0FBQ1osU0FBSyxZQUFZO0FBQ2pCLFNBQUssWUFBWTtBQUNqQixTQUFLLGlCQUFpQixTQUFTLGFBQWE7QUFDNUMsWUFBUSxZQUFZLElBQUk7QUFFeEIsVUFBTSxZQUFZLFNBQVMsY0FBYyxhQUFhO0FBQ3RELFFBQUksV0FBVztBQUNiLGdCQUFVLFlBQVksT0FBTztBQUFBLElBQy9CO0FBQUEsRUFDRjs7O0FDbEhBLFdBQVMsT0FBYTtBQUNwQixZQUFRLElBQUksNEJBQTRCO0FBRXhDLCtCQUEyQjtBQUMzQixzQkFBa0I7QUFDbEIscUJBQWlCLE1BQU0sS0FBSyxVQUFVLENBQUM7QUFBQSxFQUN6QztBQUVBLE1BQUksU0FBUyxlQUFlLFdBQVc7QUFDckMsYUFBUyxpQkFBaUIsb0JBQW9CLElBQUk7QUFBQSxFQUNwRCxPQUFPO0FBQ0wsU0FBSztBQUFBLEVBQ1A7IiwKICAibmFtZXMiOiBbImtHYW1lcyIsICJlbG8iLCAid2luZG93IiwgImVsbyIsICJiYXR0bGVzIiwgImJhdHRsZXMiLCAib3B0aW9ucyIsICJNT0RFUyIsICJzY2VuZSIsICJvcHRpb25zIiwgInJ1bm5pbmciLCAiZWxvTGluZSIsICJhZnRlclNldHVwIiwgIm1vZGFsQ29udGVudCJdCn0K
