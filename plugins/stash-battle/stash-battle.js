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
      <div class="sb-scene-card${tier ? ` sb-tier-${tier.id}` : ""}" data-side="${side}"${tier ? ` data-tier="${tier.id}"` : ""}>
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL2NvbnN0YW50cy50cyIsICIuLi8uLi9zcmMvZWxvLnRzIiwgIi4uLy4uL3NyYy9zY29yZS50cyIsICIuLi8uLi9zcmMvZ3JhcGhxbC50cyIsICIuLi8uLi9zcmMvdWkvZGVsZXRlRGlhbG9nLnRzIiwgIi4uLy4uL3NyYy9maWx0ZXJzLnRzIiwgIi4uLy4uL3NyYy9zdGF0ZS50cyIsICIuLi8uLi9zcmMvY2FjaGUudHMiLCAiLi4vLi4vc3JjL3NjZW5lQWN0aW9ucy50cyIsICIuLi8uLi9zcmMvcmF0aW5nLnRzIiwgIi4uLy4uL3NyYy9lbG9TZXR1cC50cyIsICIuLi8uLi9zcmMvc2V0dGluZ3MudHMiLCAiLi4vLi4vc3JjL3N0b3JhZ2UudHMiLCAiLi4vLi4vc3JjL3VpL2NvbmZpcm1EaWFsb2cudHMiLCAiLi4vLi4vc3JjL25hdmlnYXRpb24udHMiLCAiLi4vLi4vc3JjL3BsYWNlbWVudC50cyIsICIuLi8uLi9zcmMvcGFpcnMudHMiLCAiLi4vLi4vc3JjL3N0YXRzLnRzIiwgIi4uLy4uL3NyYy91aS9zY2VuZVRpdGxlLnRzIiwgIi4uLy4uL3NyYy91aS9zY2VuZUNhcmQudHMiLCAiLi4vLi4vc3JjL3VpL3NjcmVlbnMudHMiLCAiLi4vLi4vc3JjL3VpL3N0YXNoUmF0aW5nc1RleHQudHMiLCAiLi4vLi4vc3JjL3VpL3NldHRpbmdzUGFuZWwudHMiLCAiLi4vLi4vc3JjL3VpL21haW5VSS50cyIsICIuLi8uLi9zcmMvdWkvaWNvbnMudHMiLCAiLi4vLi4vc3JjL3VpL3NjZW5lRWxvLnRzIiwgIi4uLy4uL3NyYy91aS9yYXRpbmdQcmV2aWV3LnRzIiwgIi4uLy4uL3NyYy91aS9zZXR1cFNjcmVlbi50cyIsICIuLi8uLi9zcmMvdWkvbW9kYWwudHMiLCAiLi4vLi4vc3JjL3VpL25hdkJ1dHRvbi50cyIsICIuLi8uLi9zcmMvbWFpbi50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLy8gUGx1Z2luLXdpZGUgY29uc3RhbnRzLlxuXG5leHBvcnQgY29uc3QgU1RPUkFHRV9LRVkgPSBcInN0YXNoLWJhdHRsZS1zdGF0ZVwiO1xuZXhwb3J0IGNvbnN0IENBQ0hFX0RCX05BTUUgPSBcInN0YXNoLWJhdHRsZS1jYWNoZVwiO1xuLyoqIDIgKDMuMCk6IGNhY2hlZCBzY2VuZXMgZnJvbSBiZWZvcmUgbmVlZCBjdXN0b21fZmllbGRzIGFuZCBFTE8gb3JkZXIsIHNvIHRoZSBzdG9yZSBpcyBjbGVhcmVkLiAqL1xuZXhwb3J0IGNvbnN0IENBQ0hFX0RCX1ZFUlNJT04gPSAyO1xuZXhwb3J0IGNvbnN0IENBQ0hFX1NUT1JFX05BTUUgPSBcInNjZW5lc1wiO1xuZXhwb3J0IGNvbnN0IENBQ0hFX01BWF9BR0VfTVMgPSA1ICogNjAgKiAxMDAwOyAvLyA1IG1pbnV0ZXMgY2FjaGUgZXhwaXJ5XG5cbmltcG9ydCB0eXBlIHsgU2V0dGluZ3MsIFRpZXIgfSBmcm9tIFwiLi90eXBlc1wiO1xuXG4vKiogUGx1Z2luIGlkIChmb2xkZXIgbmFtZSkg4oCUIGtleSBmb3IgdGhpcyBwbHVnaW4ncyBzZXR0aW5ncyBpbiBTdGFzaCdzIGNvbmZpZ3VyYXRpb24uICovXG5leHBvcnQgY29uc3QgUExVR0lOX0lEID0gXCJzdGFzaC1iYXR0bGVcIjtcblxuZXhwb3J0IGNvbnN0IERFRkFVTFRfU0VUVElOR1M6IFNldHRpbmdzID0ge1xuICBzdGFzaFJhdGluZ3M6IFwib2ZmXCIsXG4gIGVsb1NldHVwQXQ6IG51bGwsXG4gIGVsb1NldHVwTW9kZTogbnVsbCxcbiAgb3BlbkluTmV3VGFiOiBmYWxzZSxcbiAgcGxhY2VtZW50RnJvbUJvdHRvbTogZmFsc2UsXG4gIHNob3dUaWVyczogdHJ1ZSxcbiAgcHJldmlld1ZvbHVtZTogNTAsXG4gIGF1dG9wbGF5UHJldmlld3M6IHRydWUsXG4gIGZpbHRlck9wcG9uZW50czogZmFsc2UsXG4gIGNsZWFuTW9kZTogZmFsc2UsXG4gIHBhdXNlTWVkaWFPbk9wZW46IHRydWUsXG59O1xuXG4vLyBQcmUtMi43IGxvY2FsU3RvcmFnZSBwcmVmZXJlbmNlIGtleXMgKG1pZ3JhdGVkIGludG8gcGx1Z2luIHNldHRpbmdzKS5cbmV4cG9ydCBjb25zdCBMRUdBQ1lfRklMVEVSX09QUE9ORU5UU19LRVkgPSBcInNiX2ZpbHRlck9wcG9uZW50c1wiO1xuZXhwb3J0IGNvbnN0IExFR0FDWV9NVVRFX1BSRVZJRVdTX0tFWSA9IFwic2JfbXV0ZVByZXZpZXdzXCI7XG5cbi8qKlxuICogU3dpc3M6IHRoZSBvcHBvbmVudCBpcyBwaWNrZWQgYXQgcmFuZG9tIGZyb20gZXZlcnkgc2NlbmUgd2l0aGluIMKxdGhpcyBFTE8gKHdpbiBjaGFuY2VzIGJldHdlZW5cbiAqIDM2JSBhbmQgNjQlKS4gQSBwaWNrIHRoYXQgY2xvc2Ugc3RpbGwgdGVsbHMgb3ZlciA5MCUgb2Ygd2hhdCBhIDUwLzUwIG9uZSBkb2VzLCBhbmQgYSBzY2VuZSBtZWV0c1xuICogZmFyIG1vcmUgdmFyaWVkIG9wcG9uZW50cyB0aGFuIGEgd2luZG93IG9mIG5lYXJieSByYW5rcywgd2hpY2ggb24gYSBzZWVkZWQgbGlicmFyeSBpcyBtb3N0bHlcbiAqIHRpZXMuXG4gKi9cbmV4cG9ydCBjb25zdCBTV0lTU19PUFBPTkVOVF9FTE9fV0lORE9XID0gMTAwO1xuLyoqIFN3aXNzOiB3aGVuIGZld2VyIHNjZW5lcyB0aGFuIHRoaXMgYXJlIGluIHRoZSB3aW5kb3cgKHRvcCwgYm90dG9tLCBzbWFsbCBwb29scyksIHRha2UgdGhpcyBtYW55IG5lYXJlc3QuICovXG5leHBvcnQgY29uc3QgU1dJU1NfT1BQT05FTlRfTUlOX0NBTkRJREFURVMgPSAxMDtcblxuLy8gQ2hhbXBpb246IHJhbmRvbSBwaWNrIGFtb25nIHRoZSBOIGNsb3Nlc3QgdW5kZWZlYXRlZCBvcHBvbmVudHMgYWJvdmUgdGhlIGNoYW1waW9uLlxuZXhwb3J0IGNvbnN0IENMSU1CX09QUE9ORU5UX1BJQ0tfV0lORE9XID0gNTtcblxuLyoqXG4gKiBFTE8gYW4gdW5yYXRlZCBzY2VuZSBjb3VudHMgYXMgaW4gQ2hhbXBpb246IDEwMDAsIHRoZSBib3R0b20gKHdoYXQgYSAwIHJhdGluZyBzZWVkcyB0byksIHNvIGFcbiAqIG5ld2NvbWVyIGNsaW1icyBmcm9tIHRoZXJlIGFzIGJlZm9yZS4gU3dpc3MgY291bnRzIHVucmF0ZWQgc2NlbmVzIGFzIEVMT19TVEFSVCAoMTUwMCkuXG4gKi9cbmV4cG9ydCBjb25zdCBDSEFNUElPTl9VTlJBVEVEX0VMTyA9IDEwMDA7XG5cbi8qKlxuICogQSBwaWNrIGlzIGFuIFwiVXBzZXQhXCIgd2hlbiB0aGUgd2lubmVyJ3Mgd2luIGNoYW5jZSAoYXMgc2hvd24sIGluICUpIHdhcyBhdCBtb3N0IHRoaXM6IGFib3V0IDcwXG4gKiBFTE8gYmVsb3cgaXRzIG9wcG9uZW50LiBTd2lzcyBvcHBvbmVudHMgYXJlIHdpdGhpbiDCsTEwMCwgc28gYWJvdXQgMSBwaWNrIGluIDcgaWYgRUxPIGlzIHJpZ2h0LlxuICovXG5leHBvcnQgY29uc3QgVVBTRVRfTUFYX0NIQU5DRSA9IDQwO1xuXG4vKiogU2hvdyBhIFVJIHdhcm5pbmcgd2hlbiBDaGFtcGlvbidzIG9wcG9uZW50IHBvb2wgaXMgc21hbGxlciB0aGFuIHRoaXMgKGZpbHRlciBvcHBvbmVudHMgb24pLiAqL1xuZXhwb3J0IGNvbnN0IENMSU1CX1NNQUxMX1BPT0xfV0FSTl9BVCA9IDEwO1xuXG4vLyAtLS0gVHJ1ZSBFTE8gKHN0b3JlZCBpbiBzY2VuZSBjdXN0b20gZmllbGRzKSAtLS1cblxuLyoqIFNjZW5lIGN1c3RvbSBmaWVsZCBrZXlzLiBXcml0ZXMgdXNlIGBwYXJ0aWFsYCwgc28gb3RoZXIgcGx1Z2lucycgZmllbGRzIGFyZSBuZXZlciB0b3VjaGVkLiAqL1xuZXhwb3J0IGNvbnN0IEVMT19GSUVMRCA9IFwic3Rhc2hfYmF0dGxlX2Vsb1wiO1xuLyoqIFJlYWwgYmF0dGxlcyB0aGF0IG1vdmVkIHRoaXMgc2NlbmUncyBFTE8gKFBsYWNlbWVudCBhZGRzIGl0cyBydW4ncyBiYXR0bGVzIHdoZW4gdGhlIHNjZW5lIGxhbmRzKS4gKi9cbmV4cG9ydCBjb25zdCBCQVRUTEVTX0ZJRUxEID0gXCJzdGFzaF9iYXR0bGVfYmF0dGxlc1wiO1xuLyoqIFRydWUgd2hlbiB0aGUgc2NlbmUncyBzdGFydGluZyBFTE8gY2FtZSBmcm9tIGl0cyBTdGFzaCByYXRpbmcgKHNldHVwJ3MgXCJVc2UgbXkgcmF0aW5nc1wiKS4gKi9cbmV4cG9ydCBjb25zdCBTRUVERURfRklFTEQgPSBcInN0YXNoX2JhdHRsZV9zZWVkZWRcIjtcbi8qKiBBbGwgb2YgU3Rhc2ggQmF0dGxlJ3MgcGVyLXNjZW5lIGZpZWxkcyAocmVtb3ZlZCB0b2dldGhlciB3aGVuIGEgc2NlbmUgYmVjb21lcyB1bnJhdGVkKS4gKi9cbmV4cG9ydCBjb25zdCBFTE9fRklFTERfS0VZUyA9IFtFTE9fRklFTEQsIEJBVFRMRVNfRklFTEQsIFNFRURFRF9GSUVMRF07XG5cbmV4cG9ydCBjb25zdCBFTE9fU1RBUlQgPSAxNTAwO1xuZXhwb3J0IGNvbnN0IEVMT19ESVZJU09SID0gNDAwO1xuXG4vKiogSyBieSBLLWdhbWVzIChiYXR0bGVzLCBwbHVzIHRoZSBoZWFkIHN0YXJ0IGlmIHNlZWRlZCk6IFtiZWxvdyB0aGlzIGNvdW50LCBLXTsgdGhlIGxhc3QgaGFzIG5vIGxpbWl0LiAqL1xuZXhwb3J0IGNvbnN0IEVMT19LX1RJRVJTOiByZWFkb25seSAocmVhZG9ubHkgW251bWJlciwgbnVtYmVyXSlbXSA9IFtcbiAgWzEwLCA0MF0sXG4gIFszMCwgMjRdLFxuICBbSW5maW5pdHksIDE2XSxcbl07XG5cbi8qKlxuICogVGllcnMgKFwiU2hvdyB0aWVycyBvbiBjYXJkc1wiKSwgYmVzdCBmaXJzdCwgYnkgcmFuayBhbW9uZyB0aGUgbGlicmFyeSdzIHNldHRsZWQgc2NlbmVzOiBhIHNjZW5lXG4gKiB3aG9zZSByYW5rIGlzIHdpdGhpbiB0aGUgdG9wIGB0b3BgIHNoYXJlIGdldHMgdGhlIGZpcnN0IHRpZXIgdGhhdCBmaXRzLiBFdmVyeSB0aWVyIGFsd2F5cyBoYXNcbiAqIHNjZW5lcyBpbiBpdCwgd2hhdGV2ZXIgdGhlIGxpYnJhcnkncyBFTE8gc3ByZWFkLiBUaGUgbGFzdCB0aWVyIHRha2VzIGV2ZXJ5b25lIGVsc2UuXG4gKi9cbmV4cG9ydCBjb25zdCBUSUVSUzogcmVhZG9ubHkgVGllcltdID0gW1xuICB7IGlkOiBcImxlZ2VuZGFyeVwiLCBuYW1lOiBcIkxlZ2VuZGFyeVwiLCBlbW9qaTogXCLwn5GRXCIsIHRvcDogMC4wMSB9LFxuICB7IGlkOiBcImRpYW1vbmRcIiwgbmFtZTogXCJEaWFtb25kXCIsIGVtb2ppOiBcIvCfko5cIiwgdG9wOiAwLjA1IH0sXG4gIHsgaWQ6IFwicGxhdGludW1cIiwgbmFtZTogXCJQbGF0aW51bVwiLCBlbW9qaTogXCLwn5S3XCIsIHRvcDogMC4xNSB9LFxuICB7IGlkOiBcImdvbGRcIiwgbmFtZTogXCJHb2xkXCIsIGVtb2ppOiBcIvCfpYdcIiwgdG9wOiAwLjM1IH0sXG4gIHsgaWQ6IFwic2lsdmVyXCIsIG5hbWU6IFwiU2lsdmVyXCIsIGVtb2ppOiBcIvCfpYhcIiwgdG9wOiAwLjY1IH0sXG4gIHsgaWQ6IFwiYnJvbnplXCIsIG5hbWU6IFwiQnJvbnplXCIsIGVtb2ppOiBcIvCfpYlcIiwgdG9wOiAxIH0sXG5dO1xuXG4vKipcbiAqIEVMTyBwb2ludHMgcGVyIDEtMTAwIHJhdGluZyBwb2ludC4gVGhlIHByZS0zLjAgbWF0aCBkaXZpZGVkIGJ5IDQwIG9uIHRoZSAxLTEwMCBzY2FsZSwgc28gb25lXG4gKiByYXRpbmcgcG9pbnQgYWxyZWFkeSBtZWFudCBleGFjdGx5IDEwIHN0YW5kYXJkIChkaXZpc29yIDQwMCkgRUxPIHBvaW50cy5cbiAqL1xuZXhwb3J0IGNvbnN0IEVMT19QRVJfUkFUSU5HX1BPSU5UID0gMTA7XG5cbi8qKlxuICogSGVhZCBzdGFydCAoY291bnRlZCBhcyBiYXR0bGVzIGZvciBLIG9ubHkpIGZvciBzY2VuZXMgc2VlZGVkIGZyb20gdGhlaXIgU3Rhc2ggcmF0aW5nOiB0aGVpclxuICogcmF0aW5nIGFscmVhZHkgc2F5cyBzb21ldGhpbmcsIHNvIHRoZXkgc2tpcCB0aGUgYmlnZ2VzdCBzd2luZ3MuIENoYW5naW5nIGl0IGFwcGxpZXMgdG8gZXZlcnlcbiAqIHNlZWRlZCBzY2VuZSBhdCBvbmNlLCBiZWNhdXNlIGl0IGlzbid0IHN0b3JlZC5cbiAqL1xuZXhwb3J0IGNvbnN0IFNFRURFRF9IRUFEX1NUQVJUID0gMTA7XG5cbi8qKiBFTE8gZ2FwIGFib3ZlIHRoZSB0b3AgLyBiZWxvdyB0aGUgYm90dG9tIHNjZW5lIHdoZW4gUGxhY2VtZW50IGxhbmRzIGEgc2NlbmUgYXQgYW4gZWRnZS4gKi9cbmV4cG9ydCBjb25zdCBQTEFDRU1FTlRfRURHRV9HQVAgPSAyNTtcblxuLyoqXG4gKiBQbGFjZW1lbnQncyBkb3VibGluZyBqdW1wcyBhcmUgY2FwcGVkIGF0IHRoaXMgc2hhcmUgb2YgdGhlIHBvb2wgKGJ1dCBhdCBsZWFzdFxuICogUExBQ0VNRU5UX01JTl9NQVhfSlVNUCByYW5rcyksIHNvIGEgd2lubmluZyBzdHJlYWsgY2xpbWJzIGluc3RlYWQgb2YgbGVhcGluZyB0byAjMS4gSW4gYVxuICogNjAwLXNjZW5lIGxpYnJhcnk6IGF0IG1vc3QgNjAgcmFua3MgcGVyIGp1bXAsIGFib3V0IG9uZSBleHRyYSBiYXR0bGUgb24gYXZlcmFnZS5cbiAqL1xuZXhwb3J0IGNvbnN0IFBMQUNFTUVOVF9NQVhfSlVNUF9TSEFSRSA9IDAuMTtcbmV4cG9ydCBjb25zdCBQTEFDRU1FTlRfTUlOX01BWF9KVU1QID0gNDtcbiIsICIvLyBFTE8gbWF0aCAocHVyZSBjYWxjdWxhdGlvbnM6IGNhbGxlcnMgYXBwbHkgdGhlIHJlc3VsdHMgYW5kIHBlcnNpc3QgdGhlbSkuXG5cbmltcG9ydCB7IEVMT19ESVZJU09SLCBFTE9fS19USUVSUyB9IGZyb20gXCIuL2NvbnN0YW50c1wiO1xuXG4vKiogSyBmb3IgYSBzY2VuZSB3aXRoIHRoaXMgbWFueSBLLWdhbWVzIChzZWUga0dhbWVzKTogbmV3IHNjZW5lcyBtb3ZlIGEgbG90LCBlc3RhYmxpc2hlZCBvbmVzIGxpdHRsZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlbG9LRmFjdG9yKGtHYW1lczogbnVtYmVyKTogbnVtYmVyIHtcbiAgZm9yIChjb25zdCBbYmVsb3csIGtdIG9mIEVMT19LX1RJRVJTKSB7XG4gICAgaWYgKGtHYW1lcyA8IGJlbG93KSByZXR1cm4gaztcbiAgfVxuICByZXR1cm4gRUxPX0tfVElFUlNbRUxPX0tfVElFUlMubGVuZ3RoIC0gMV1bMV07XG59XG5cbi8qKiBQcm9iYWJpbGl0eSB0aGF0IGEgc2NlbmUgcmF0ZWQgYGVsb2AgYmVhdHMgb25lIHJhdGVkIGBvcHBvbmVudEVsb2AuICovXG5leHBvcnQgZnVuY3Rpb24gZWxvRXhwZWN0ZWQoZWxvOiBudW1iZXIsIG9wcG9uZW50RWxvOiBudW1iZXIpOiBudW1iZXIge1xuICByZXR1cm4gMSAvICgxICsgTWF0aC5wb3coMTAsIChvcHBvbmVudEVsbyAtIGVsbykgLyBFTE9fRElWSVNPUikpO1xufVxuXG4vKipcbiAqIEJvdGggc2lkZXMnIHdpbiBjaGFuY2VzIGFzIHdob2xlIHBlcmNlbnRhZ2VzIHRoYXQgYWx3YXlzIGFkZCB1cCB0byAxMDAsIGtlcHQgd2l0aGluIDEtOTkgKGFcbiAqIFwiMTAwJVwiIHdvdWxkIHJlYWQgYXMgYSBzdXJlIHRoaW5nLCBhbmQgRUxPIG5ldmVyIGlzKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdpbkNoYW5jZXMoZWxvOiBudW1iZXIsIG9wcG9uZW50RWxvOiBudW1iZXIpOiBbbnVtYmVyLCBudW1iZXJdIHtcbiAgY29uc3QgZmlyc3QgPSBNYXRoLm1pbig5OSwgTWF0aC5tYXgoMSwgTWF0aC5yb3VuZChlbG9FeHBlY3RlZChlbG8sIG9wcG9uZW50RWxvKSAqIDEwMCkpKTtcbiAgcmV0dXJuIFtmaXJzdCwgMTAwIC0gZmlyc3RdO1xufVxuXG5leHBvcnQgaW50ZXJmYWNlIEVsb1NpZGUge1xuICBlbG86IG51bWJlcjtcbiAgLyoqIEJhdHRsZXMgcGx1cyBhbnkgc2VlZGVkIGhlYWQgc3RhcnQgKHNjb3JlLnRzIGtHYW1lcyk6IHNldHMgdGhpcyBzaWRlJ3MgSy4gKi9cbiAga0dhbWVzOiBudW1iZXI7XG59XG5cbi8qKiBTdG9yZWQgRUxPIHByZWNpc2lvbiAob25lIGRlY2ltYWwpLCBzbyBzbWFsbCBsYXRlLWNhcmVlciBjaGFuZ2VzIGFyZW4ndCByb3VuZGVkIGF3YXkuICovXG5leHBvcnQgZnVuY3Rpb24gcm91bmRFbG8oZWxvOiBudW1iZXIpOiBudW1iZXIge1xuICByZXR1cm4gTWF0aC5yb3VuZChlbG8gKiAxMCkgLyAxMDtcbn1cblxuLyoqXG4gKiBUd28tc2lkZWQgRUxPIGZvciBhIGhlYWQtdG8taGVhZCB3aW47IGVhY2ggc2lkZSB1c2VzIGl0cyBvd24gSy4gUmV0dXJucyB0aGUgbmV3IEVMT3MuXG4gKiBFYWNoIHNpZGUgbW92ZXMgYnkgSyDDlyAoYWN0dWFsIOKIkiBleHBlY3RlZCk6IHRoZSB3aW5uZXIgYnkgSyDDlyAoMSDiiJIgaXRzIHdpbiBjaGFuY2UpLCB0aGUgbG9zZXJcbiAqIGJ5IEsgw5cgKDAg4oiSIGl0cyBvd24gd2luIGNoYW5jZSksIHdoaWNoIGlzIHRoZSBzYW1lIDEg4oiSIHdpbm5lcidzIGNoYW5jZS4gV2l0aCBlcXVhbCBLIHRoZVxuICogcG9pbnRzIGFyZSBleGFjdGx5IHplcm8tc3VtLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZWxvUmVzdWx0KHdpbm5lcjogRWxvU2lkZSwgbG9zZXI6IEVsb1NpZGUpOiB7IHdpbm5lcjogbnVtYmVyOyBsb3NlcjogbnVtYmVyIH0ge1xuICBjb25zdCBzdXJwcmlzZSA9IDEgLSBlbG9FeHBlY3RlZCh3aW5uZXIuZWxvLCBsb3Nlci5lbG8pO1xuICByZXR1cm4ge1xuICAgIHdpbm5lcjogcm91bmRFbG8od2lubmVyLmVsbyArIGVsb0tGYWN0b3Iod2lubmVyLmtHYW1lcykgKiBzdXJwcmlzZSksXG4gICAgbG9zZXI6IHJvdW5kRWxvKGxvc2VyLmVsbyAtIGVsb0tGYWN0b3IobG9zZXIua0dhbWVzKSAqIHN1cnByaXNlKSxcbiAgfTtcbn1cbiIsICIvLyBBIHNjZW5lJ3MgRUxPIChyZWFkIGZyb20gaXRzIGN1c3RvbSBmaWVsZHMpLCBFTE8gb3JkZXJpbmcsIGFuZCBjb252ZXJzaW9ucyBiZXR3ZWVuIEVMTyBhbmRcbi8vIFN0YXNoJ3MgMS0xMDAgcmF0aW5nLiBQdXJlIGZ1bmN0aW9uczogbm8gc3RhdGUsIG5vIEkvTy5cblxuaW1wb3J0IHtcbiAgQkFUVExFU19GSUVMRCxcbiAgRUxPX0ZJRUxELFxuICBFTE9fRklFTERfS0VZUyxcbiAgRUxPX0tfVElFUlMsXG4gIEVMT19QRVJfUkFUSU5HX1BPSU5ULFxuICBFTE9fU1RBUlQsXG4gIFBMQUNFTUVOVF9FREdFX0dBUCxcbiAgU0VFREVEX0ZJRUxELFxuICBTRUVERURfSEVBRF9TVEFSVCxcbn0gZnJvbSBcIi4vY29uc3RhbnRzXCI7XG5pbXBvcnQgeyByb3VuZEVsbyB9IGZyb20gXCIuL2Vsb1wiO1xuaW1wb3J0IHR5cGUgeyBFbG9GaWVsZHMsIEVsb1N0YXJ0LCBTY2VuZSwgU3Rhc2hSYXRpbmdzTW9kZSB9IGZyb20gXCIuL3R5cGVzXCI7XG5cbi8qKiBDdXN0b20gZmllbGQgdmFsdWVzIHNob3VsZCBjb21lIGJhY2sgYXMgbnVtYmVyczsgbnVtZXJpYyBzdHJpbmdzIGFyZSBhY2NlcHRlZCB0b28uICovXG5mdW5jdGlvbiByZWFkTnVtYmVyKHZhbHVlOiB1bmtub3duKTogbnVtYmVyIHwgbnVsbCB7XG4gIGlmICh0eXBlb2YgdmFsdWUgPT09IFwibnVtYmVyXCIpIHJldHVybiBOdW1iZXIuaXNGaW5pdGUodmFsdWUpID8gdmFsdWUgOiBudWxsO1xuICBpZiAodHlwZW9mIHZhbHVlID09PSBcInN0cmluZ1wiICYmIHZhbHVlLnRyaW0oKSAhPT0gXCJcIikge1xuICAgIGNvbnN0IG4gPSBOdW1iZXIodmFsdWUpO1xuICAgIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobikgPyBuIDogbnVsbDtcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqIFRoZSBzY2VuZSdzIHN0b3JlZCBFTE8sIG9yIG51bGwgd2hlbiBpdCBoYXMgbm9uZSAodW5yYXRlZCkuICovXG5leHBvcnQgZnVuY3Rpb24gZWxvKHNjZW5lOiBTY2VuZSk6IG51bWJlciB8IG51bGwge1xuICByZXR1cm4gcmVhZE51bWJlcihzY2VuZS5jdXN0b21fZmllbGRzPy5bRUxPX0ZJRUxEXSk7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpc1JhdGVkKHNjZW5lOiBTY2VuZSk6IGJvb2xlYW4ge1xuICByZXR1cm4gZWxvKHNjZW5lKSAhPT0gbnVsbDtcbn1cblxuLyoqIFJlYWwgYmF0dGxlcyB0aGF0IG1vdmVkIHRoZSBzY2VuZSdzIEVMTy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBiYXR0bGVzKHNjZW5lOiBTY2VuZSk6IG51bWJlciB7XG4gIGNvbnN0IG4gPSByZWFkTnVtYmVyKHNjZW5lLmN1c3RvbV9maWVsZHM/LltCQVRUTEVTX0ZJRUxEXSk7XG4gIHJldHVybiBuICE9PSBudWxsICYmIG4gPiAwID8gTWF0aC5mbG9vcihuKSA6IDA7XG59XG5cbi8qKiBUaGUgc2NlbmUncyBzdGFydGluZyBFTE8gY2FtZSBmcm9tIGl0cyBTdGFzaCByYXRpbmcuIChTdGFzaCBzdG9yZXMgYHRydWVgIGFzIDEuKSAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzU2VlZGVkKHNjZW5lOiBTY2VuZSk6IGJvb2xlYW4ge1xuICBjb25zdCB2YWx1ZSA9IHNjZW5lLmN1c3RvbV9maWVsZHM/LltTRUVERURfRklFTERdO1xuICByZXR1cm4gdmFsdWUgPT09IHRydWUgfHwgdmFsdWUgPT09IDEgfHwgdmFsdWUgPT09IFwidHJ1ZVwiIHx8IHZhbHVlID09PSBcIjFcIjtcbn1cblxuLyoqIFRoZSBjb3VudCBLIGlzIGJhc2VkIG9uOiByZWFsIGJhdHRsZXMsIHBsdXMgdGhlIGhlYWQgc3RhcnQgZm9yIHNlZWRlZCBzY2VuZXMuICovXG5leHBvcnQgZnVuY3Rpb24ga0dhbWVzKHNjZW5lOiBTY2VuZSk6IG51bWJlciB7XG4gIHJldHVybiBiYXR0bGVzKHNjZW5lKSArIChpc1NlZWRlZChzY2VuZSkgPyBTRUVERURfSEVBRF9TVEFSVCA6IDApO1xufVxuXG4vKipcbiAqIFRoZSBzY2VuZSdzIEVMTyBpcyBzdGlsbCBzZXR0bGluZzogaXQgaGFzIGZld2VyIEstZ2FtZXMgdGhhbiB0aGUgZmlyc3QgSyB0aWVyJ3MgbGltaXQgKDEwKSwgdGhlXG4gKiBzdGFnZSB3aGVyZSBlYWNoIGJhdHRsZSBtb3ZlcyBpdCB0aGUgbW9zdC4gU2VlZGVkIHNjZW5lcyBzdGFydCBwYXN0IGl0OyB1bnJhdGVkIG9uZXMgYXJlbid0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNQcm92aXNpb25hbChzY2VuZTogU2NlbmUpOiBib29sZWFuIHtcbiAgcmV0dXJuIGlzUmF0ZWQoc2NlbmUpICYmIGtHYW1lcyhzY2VuZSkgPCBFTE9fS19USUVSU1swXVswXTtcbn1cblxuLyoqIEVsb0ZpZWxkcyBhcyB0aGUgY3VzdG9tIGZpZWxkcyBtYXAgU3Rhc2ggc3RvcmVzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVsb0N1c3RvbUZpZWxkcyh2YWx1ZTogRWxvRmllbGRzKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICByZXR1cm4geyBbRUxPX0ZJRUxEXTogdmFsdWUuZWxvLCBbQkFUVExFU19GSUVMRF06IHZhbHVlLmJhdHRsZXMsIFtTRUVERURfRklFTERdOiB2YWx1ZS5zZWVkZWQgfTtcbn1cblxuLyoqIFN0YXJ0aW5nIEVMTyBmb3IgYSAxLTEwMCBTdGFzaCByYXRpbmc6IDUwIGlzIDE1MDAsIHNvIDEtMTAwIG1hcHMgb250byAxMDEwLTIwMDAuICovXG5leHBvcnQgZnVuY3Rpb24gc2VlZChyYXRpbmcxMDA6IG51bWJlcik6IG51bWJlciB7XG4gIHJldHVybiBFTE9fU1RBUlQgKyAocmF0aW5nMTAwIC0gNTApICogRUxPX1BFUl9SQVRJTkdfUE9JTlQ7XG59XG5cbi8qKiBFTE8gdXNlZCBpbiBiYXR0bGUgbWF0aDogdGhlIHN0b3JlZCBFTE8sIG9yIGB1bnJhdGVkRWxvYCBmb3IgdW5yYXRlZCBzY2VuZXMgKDE1MDAgYnkgZGVmYXVsdCkuICovXG5leHBvcnQgZnVuY3Rpb24gZWZmZWN0aXZlRWxvKHNjZW5lOiBTY2VuZSwgdW5yYXRlZEVsbzogbnVtYmVyID0gRUxPX1NUQVJUKTogbnVtYmVyIHtcbiAgcmV0dXJuIGVsbyhzY2VuZSkgPz8gdW5yYXRlZEVsbztcbn1cblxuLyoqIFN0cmFpZ2h0LWxpbmUgU3Rhc2ggcmF0aW5nOiB0aGUgaW52ZXJzZSBvZiBzZWVkKCksIGNsYW1wZWQgdG8gMS0xMDAuICovXG5leHBvcnQgZnVuY3Rpb24gbGluZWFyUmF0aW5nKGVsb1ZhbHVlOiBudW1iZXIpOiBudW1iZXIge1xuICBjb25zdCByYXRpbmcgPSBNYXRoLnJvdW5kKDUwICsgKGVsb1ZhbHVlIC0gRUxPX1NUQVJUKSAvIEVMT19QRVJfUkFUSU5HX1BPSU5UKTtcbiAgcmV0dXJuIE1hdGgubWluKDEwMCwgTWF0aC5tYXgoMSwgcmF0aW5nKSk7XG59XG5cbi8qKlxuICogUGVyY2VudGlsZSBTdGFzaCByYXRpbmdzIGZvciBldmVyeSBzY2VuZSB3aXRoIGFuIEVMTzogdGhlIHRvcCBzY2VuZSBpcyAxMDAsIHRoZSBib3R0b20gMSxcbiAqIGV2ZW5seSBzcGFjZWQgYnkgcmFuay4gVGllZCBzY2VuZXMgc2hhcmUgdGhlIG1pZGRsZSBwb3NpdGlvbiBvZiB0aGVpciB0aWUgZ3JvdXAsIHNvIGEgZnVsbHlcbiAqIHRpZWQgbGlicmFyeSBpcyA1MCBldmVyeXdoZXJlLiBVbnJhdGVkIHNjZW5lcyBhcmUgbGVmdCBvdXQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwZXJjZW50aWxlUmF0aW5ncyhzY2VuZXM6IFNjZW5lW10pOiBNYXA8c3RyaW5nLCBudW1iZXI+IHtcbiAgY29uc3QgcmF0ZWQgPSBzY2VuZXNcbiAgICAubWFwKChzY2VuZSkgPT4gKHsgaWQ6IHNjZW5lLmlkLCBlbG86IGVsbyhzY2VuZSkgfSkpXG4gICAgLmZpbHRlcigocyk6IHMgaXMgeyBpZDogc3RyaW5nOyBlbG86IG51bWJlciB9ID0+IHMuZWxvICE9PSBudWxsKVxuICAgIC5zb3J0KChhLCBiKSA9PiBiLmVsbyAtIGEuZWxvKTtcblxuICBjb25zdCByYXRpbmdzID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgY29uc3QgbiA9IHJhdGVkLmxlbmd0aDtcbiAgaWYgKG4gPT09IDEpIHtcbiAgICByYXRpbmdzLnNldChyYXRlZFswXS5pZCwgNTApO1xuICAgIHJldHVybiByYXRpbmdzO1xuICB9XG5cbiAgbGV0IHN0YXJ0ID0gMDtcbiAgd2hpbGUgKHN0YXJ0IDwgbikge1xuICAgIGxldCBlbmQgPSBzdGFydDtcbiAgICB3aGlsZSAoZW5kICsgMSA8IG4gJiYgcmF0ZWRbZW5kICsgMV0uZWxvID09PSByYXRlZFtzdGFydF0uZWxvKSBlbmQrKztcbiAgICAvLyBSb3VuZGluZyBpbnNpZGUga2VlcHMgYSB0aWUgYXQgdGhlIGV4YWN0IG1pZGRsZSBvbiA1MCByYXRoZXIgdGhhbiA1MVxuICAgIGNvbnN0IHJhdGluZyA9IDEwMCAtIE1hdGgucm91bmQoKDk5ICogKChzdGFydCArIGVuZCkgLyAyKSkgLyAobiAtIDEpKTtcbiAgICBmb3IgKGxldCBpID0gc3RhcnQ7IGkgPD0gZW5kOyBpKyspIHJhdGluZ3Muc2V0KHJhdGVkW2ldLmlkLCByYXRpbmcpO1xuICAgIHN0YXJ0ID0gZW5kICsgMTtcbiAgfVxuICByZXR1cm4gcmF0aW5ncztcbn1cblxuLyoqIFRhcmdldCBTdGFzaCByYXRpbmcgZm9yIGV2ZXJ5IHNjZW5lIHdpdGggYW4gRUxPLCB1bmRlciB0aGUgZ2l2ZW4gbW9kZSAobm9uZSBmb3IgXCJvZmZcIikuICovXG5leHBvcnQgZnVuY3Rpb24gc3Rhc2hSYXRpbmdUYXJnZXRzKHNjZW5lczogU2NlbmVbXSwgbW9kZTogU3Rhc2hSYXRpbmdzTW9kZSk6IE1hcDxzdHJpbmcsIG51bWJlcj4ge1xuICBpZiAobW9kZSA9PT0gXCJwZXJjZW50aWxlXCIpIHJldHVybiBwZXJjZW50aWxlUmF0aW5ncyhzY2VuZXMpO1xuICBjb25zdCB0YXJnZXRzID0gbmV3IE1hcDxzdHJpbmcsIG51bWJlcj4oKTtcbiAgaWYgKG1vZGUgPT09IFwibGluZWFyXCIpIHtcbiAgICBmb3IgKGNvbnN0IHNjZW5lIG9mIHNjZW5lcykge1xuICAgICAgY29uc3QgdmFsdWUgPSBlbG8oc2NlbmUpO1xuICAgICAgaWYgKHZhbHVlICE9PSBudWxsKSB0YXJnZXRzLnNldChzY2VuZS5pZCwgbGluZWFyUmF0aW5nKHZhbHVlKSk7XG4gICAgfVxuICB9XG4gIHJldHVybiB0YXJnZXRzO1xufVxuXG4vKiogVGhlIFN0YXNoIHJhdGluZ3MgYSBzeW5jIHdvdWxkIHdyaXRlOiBzY2VuZSBpZCB0byBuZXcgcmF0aW5nLCBvbmx5IHdoZXJlIGl0IGRpZmZlcnMgZnJvbSBub3cuICovXG5leHBvcnQgZnVuY3Rpb24gc3Rhc2hSYXRpbmdDaGFuZ2VzKHNjZW5lczogU2NlbmVbXSwgbW9kZTogU3Rhc2hSYXRpbmdzTW9kZSk6IE1hcDxzdHJpbmcsIG51bWJlcj4ge1xuICBjb25zdCBjdXJyZW50ID0gbmV3IE1hcChzY2VuZXMubWFwKChzY2VuZSkgPT4gW3NjZW5lLmlkLCBzY2VuZS5yYXRpbmcxMDAgPz8gbnVsbF0pKTtcbiAgY29uc3QgY2hhbmdlcyA9IG5ldyBNYXA8c3RyaW5nLCBudW1iZXI+KCk7XG4gIGZvciAoY29uc3QgW2lkLCByYXRpbmddIG9mIHN0YXNoUmF0aW5nVGFyZ2V0cyhzY2VuZXMsIG1vZGUpKSB7XG4gICAgaWYgKGN1cnJlbnQuZ2V0KGlkKSAhPT0gcmF0aW5nKSBjaGFuZ2VzLnNldChpZCwgcmF0aW5nKTtcbiAgfVxuICByZXR1cm4gY2hhbmdlcztcbn1cblxuLyoqXG4gKiBFTE8gYW5kIGdhbWVzIGEgc2NlbmUgZ2V0cyBmcm9tIHRoZSBvbmUtdGltZSBzZXR1cCwgb3IgbnVsbCB3aGVuIGl0IHN0YXJ0cyB1bnJhdGVkLlxuICogXCJyYXRpbmdzXCIgc2VlZHMgcmF0ZWQgc2NlbmVzIGZyb20gdGhlaXIgU3Rhc2ggcmF0aW5nOyBcImZyZXNoXCIgc3RhcnRzIGV2ZXJ5IHNjZW5lIGF0IDE1MDAuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzdGFydGluZ0VsbyhzY2VuZTogU2NlbmUsIHN0YXJ0OiBFbG9TdGFydCk6IEVsb0ZpZWxkcyB8IG51bGwge1xuICBpZiAoc3RhcnQgPT09IFwiZnJlc2hcIikgcmV0dXJuIHsgZWxvOiBFTE9fU1RBUlQsIGJhdHRsZXM6IDAsIHNlZWRlZDogZmFsc2UgfTtcbiAgcmV0dXJuIHNjZW5lLnJhdGluZzEwMCAhPSBudWxsID8geyBlbG86IHNlZWQoc2NlbmUucmF0aW5nMTAwKSwgYmF0dGxlczogMCwgc2VlZGVkOiB0cnVlIH0gOiBudWxsO1xufVxuXG4vKiogQSBjb3B5IG9mIGEgY3VzdG9tIGZpZWxkcyBtYXAgd2l0aCB0aGUgRUxPIGZpZWxkcyBzZXQgdG8gYHZhbHVlYCAob3IsIHdpdGggbnVsbCwgcmVtb3ZlZCkuICovXG5leHBvcnQgZnVuY3Rpb24gd2l0aEVsb0ZpZWxkcyhjdXN0b21GaWVsZHM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbCB8IHVuZGVmaW5lZCwgdmFsdWU6IEVsb0ZpZWxkcyB8IG51bGwpOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gIGNvbnN0IGZpZWxkcyA9IHsgLi4uY3VzdG9tRmllbGRzIH07XG4gIGZvciAoY29uc3Qga2V5IG9mIEVMT19GSUVMRF9LRVlTKSBkZWxldGUgZmllbGRzW2tleV07XG4gIGlmICh2YWx1ZSkgT2JqZWN0LmFzc2lnbihmaWVsZHMsIGVsb0N1c3RvbUZpZWxkcyh2YWx1ZSkpO1xuICByZXR1cm4gZmllbGRzO1xufVxuXG4vKiogVGhlIHNjZW5lJ3MgRUxPIGZpZWxkcywgb3IgbnVsbCB3aGVuIGl0J3MgdW5yYXRlZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBlbG9GaWVsZHMoc2NlbmU6IFNjZW5lKTogRWxvRmllbGRzIHwgbnVsbCB7XG4gIGNvbnN0IHZhbHVlID0gZWxvKHNjZW5lKTtcbiAgcmV0dXJuIHZhbHVlID09PSBudWxsID8gbnVsbCA6IHsgZWxvOiB2YWx1ZSwgYmF0dGxlczogYmF0dGxlcyhzY2VuZSksIHNlZWRlZDogaXNTZWVkZWQoc2NlbmUpIH07XG59XG5cbi8qKiBBIGNvcHkgb2YgdGhlIHNjZW5lIGFzIGl0IHdvdWxkIGJlIHJpZ2h0IGFmdGVyIHNldHVwIChpdHMgRUxPIGZpZWxkcyByZXBsYWNlZCkuICovXG5leHBvcnQgZnVuY3Rpb24gYWZ0ZXJTZXR1cChzY2VuZTogU2NlbmUsIHN0YXJ0OiBFbG9TdGFydCk6IFNjZW5lIHtcbiAgcmV0dXJuIHsgLi4uc2NlbmUsIGN1c3RvbV9maWVsZHM6IHdpdGhFbG9GaWVsZHMoc2NlbmUuY3VzdG9tX2ZpZWxkcywgc3RhcnRpbmdFbG8oc2NlbmUsIHN0YXJ0KSkgfTtcbn1cblxuLyoqIEhpZ2hlc3QgRUxPIGZpcnN0LCB1bnJhdGVkIHNjZW5lcyBsYXN0LiBFcXVhbCBFTE9zIGtlZXAgdGhlaXIgb3JkZXIgKEFycmF5LnNvcnQgaXMgc3RhYmxlKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjb21wYXJlQnlFbG8oYTogU2NlbmUsIGI6IFNjZW5lKTogbnVtYmVyIHtcbiAgY29uc3QgZWxvQSA9IGVsbyhhKTtcbiAgY29uc3QgZWxvQiA9IGVsbyhiKTtcbiAgaWYgKGVsb0EgPT09IG51bGwpIHJldHVybiBlbG9CID09PSBudWxsID8gMCA6IDE7XG4gIGlmIChlbG9CID09PSBudWxsKSByZXR1cm4gLTE7XG4gIHJldHVybiBlbG9CIC0gZWxvQTtcbn1cblxuLyoqIFNvcnQgc2NlbmVzIGluIHBsYWNlIGJ5IEVMTyAoc2VlIGNvbXBhcmVCeUVsbykgYW5kIHJldHVybiB0aGUgc2FtZSBhcnJheS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzb3J0QnlFbG8oc2NlbmVzOiBTY2VuZVtdKTogU2NlbmVbXSB7XG4gIHJldHVybiBzY2VuZXMuc29ydChjb21wYXJlQnlFbG8pO1xufVxuXG4vKiogSW5kZXggd2hlcmUgYSBzY2VuZSB3aXRoIHRoaXMgRUxPIHdvdWxkIHNpdCBpbiBhbiBFTE8tc29ydGVkIHBvb2w6IGJlbG93IGV2ZXJ5IGVxdWFsIG9yIGhpZ2hlciBvbmUuICovXG5leHBvcnQgZnVuY3Rpb24gZWxvSW5zZXJ0aW9uSW5kZXgocG9vbDogU2NlbmVbXSwgZWxvVmFsdWU6IG51bWJlcik6IG51bWJlciB7XG4gIGNvbnN0IGlkeCA9IHBvb2wuZmluZEluZGV4KChzKSA9PiB7XG4gICAgY29uc3Qgb3RoZXIgPSBlbG8ocyk7XG4gICAgcmV0dXJuIG90aGVyID09PSBudWxsIHx8IG90aGVyIDwgZWxvVmFsdWU7XG4gIH0pO1xuICByZXR1cm4gaWR4ID09PSAtMSA/IHBvb2wubGVuZ3RoIDogaWR4O1xufVxuXG4vKipcbiAqIEluZGV4ZXMgb2YgdGhlIFN3aXNzIG9wcG9uZW50cyBmb3IgYSBzY2VuZSBhdCBgZWxvVmFsdWVgOiBldmVyeSBzY2VuZSBpbiB0aGUgcG9vbCB3aXRoaW5cbiAqIMKxYHdpbmRvd2AgRUxPICh1bnJhdGVkIG9uZXMgY291bnQgYXMgRUxPX1NUQVJULCBhcyBpbiBTd2lzcyBiYXR0bGVzKSwgb3IsIHdoZW4gdGhhdCdzIGZld2VyIHRoYW5cbiAqIGBtaW5Db3VudGAsIHRoZSBgbWluQ291bnRgIG5lYXJlc3QgYnkgRUxPIChwbHVzIGFueSB0aWVkIHdpdGggdGhlIGxhc3Qgb2YgdGhlbSkuIFRoZSBzY2VuZVxuICogaXRzZWxmIChgZXhjbHVkZUlkYCkgaXMgbmV2ZXIgb25lLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc3dpc3NPcHBvbmVudEluZGV4ZXMoXG4gIHBvb2w6IFNjZW5lW10sXG4gIGVsb1ZhbHVlOiBudW1iZXIsXG4gIGV4Y2x1ZGVJZDogc3RyaW5nLFxuICB3aW5kb3c6IG51bWJlcixcbiAgbWluQ291bnQ6IG51bWJlcixcbik6IG51bWJlcltdIHtcbiAgY29uc3Qgb3RoZXJzID0gcG9vbFxuICAgIC5tYXAoKHNjZW5lLCBpZHgpID0+ICh7IGlkeCwgZ2FwOiBNYXRoLmFicyhlZmZlY3RpdmVFbG8oc2NlbmUpIC0gZWxvVmFsdWUpLCBpZDogc2NlbmUuaWQgfSkpXG4gICAgLmZpbHRlcigocykgPT4gcy5pZCAhPT0gZXhjbHVkZUlkKTtcbiAgY29uc3QgaW5XaW5kb3cgPSBvdGhlcnMuZmlsdGVyKChzKSA9PiBzLmdhcCA8PSB3aW5kb3cpO1xuICBpZiAoaW5XaW5kb3cubGVuZ3RoID49IG1pbkNvdW50IHx8IGluV2luZG93Lmxlbmd0aCA9PT0gb3RoZXJzLmxlbmd0aCkgcmV0dXJuIGluV2luZG93Lm1hcCgocykgPT4gcy5pZHgpO1xuICBjb25zdCBieUdhcCA9IFsuLi5vdGhlcnNdLnNvcnQoKGEsIGIpID0+IGEuZ2FwIC0gYi5nYXApO1xuICBjb25zdCBjdXRvZmYgPSBieUdhcFtNYXRoLm1pbihtaW5Db3VudCwgYnlHYXAubGVuZ3RoKSAtIDFdLmdhcDtcbiAgcmV0dXJuIGJ5R2FwLmZpbHRlcigocykgPT4gcy5nYXAgPD0gY3V0b2ZmKS5tYXAoKHMpID0+IHMuaWR4KS5zb3J0KChhLCBiKSA9PiBhIC0gYik7XG59XG5cbi8qKlxuICogRUxPIGZvciBhIHNjZW5lIFBsYWNlbWVudCBsYW5kcyBiZXR3ZWVuIHR3byBuZWlnaGJvdXJzIChudWxsIHdoZXJlIHRoZXJlJ3Mgbm9uZSwgb3IgdGhlXG4gKiBuZWlnaGJvdXIgaXMgdW5yYXRlZCk6IHRoZWlyIG1pZHBvaW50LCBvciBQTEFDRU1FTlRfRURHRV9HQVAgYmV5b25kIHRoZSBvbmx5IG9uZSBhdCBhbiBlZGdlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcGxhY2VtZW50RWxvKGFib3ZlRWxvOiBudW1iZXIgfCBudWxsLCBiZWxvd0VsbzogbnVtYmVyIHwgbnVsbCk6IG51bWJlciB7XG4gIGlmIChhYm92ZUVsbyA9PT0gbnVsbCAmJiBiZWxvd0VsbyA9PT0gbnVsbCkgcmV0dXJuIEVMT19TVEFSVDtcbiAgaWYgKGFib3ZlRWxvID09PSBudWxsKSByZXR1cm4gcm91bmRFbG8oKGJlbG93RWxvIGFzIG51bWJlcikgKyBQTEFDRU1FTlRfRURHRV9HQVApO1xuICBpZiAoYmVsb3dFbG8gPT09IG51bGwpIHJldHVybiByb3VuZEVsbyhhYm92ZUVsbyAtIFBMQUNFTUVOVF9FREdFX0dBUCk7XG4gIC8vIE5laWdoYm91cnMgMC4xIGFwYXJ0IChvciB0aWVkKSBoYXZlIG5vIHJvb20gYmV0d2VlbiB0aGVtOiB0YWtlIHRoZSB1cHBlciBvbmUncyBFTE8sIHdoaWNoXG4gIC8vIHN0aWxsIHNvcnRzIHRoZSBzY2VuZSBiZWxvdyBpdCAoZXF1YWwgRUxPcyBnbyBiZWxvdykgYW5kIHNvIGluIHRoZSBzYW1lIHNsb3RcbiAgY29uc3QgbWlkID0gcm91bmRFbG8oKGFib3ZlRWxvICsgYmVsb3dFbG8pIC8gMik7XG4gIHJldHVybiBtaWQgPiBiZWxvd0VsbyA/IG1pZCA6IGFib3ZlRWxvO1xufVxuIiwgIi8vIEdyYXBoUUwgYWNjZXNzIGFnYWluc3QgdGhlIFN0YXNoIGJhY2tlbmQuXG5cbmltcG9ydCB0eXBlIHsgQXBvbGxvQ2FjaGVMaWtlIH0gZnJvbSBcIi4vcGx1Z2luQXBpXCI7XG5pbXBvcnQgeyB3aXRoRWxvRmllbGRzIH0gZnJvbSBcIi4vc2NvcmVcIjtcbmltcG9ydCB0eXBlIHsgRWxvRmllbGRzLCBGaW5kU2NlbmVSZXN1bHQsIFNjZW5lIH0gZnJvbSBcIi4vdHlwZXNcIjtcblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdyYXBocWxRdWVyeTxUID0gdW5rbm93bj4oXG4gIHF1ZXJ5OiBzdHJpbmcsXG4gIHZhcmlhYmxlczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7fSxcbik6IFByb21pc2U8VD4ge1xuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKFwiL2dyYXBocWxcIiwge1xuICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgaGVhZGVyczoge1xuICAgICAgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIsXG4gICAgfSxcbiAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IHF1ZXJ5LCB2YXJpYWJsZXMgfSksXG4gIH0pO1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXNwb25zZS5qc29uKCk7XG4gIGlmIChyZXN1bHQuZXJyb3JzKSB7XG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIEdyYXBoUUwgZXJyb3I6XCIsIHJlc3VsdC5lcnJvcnMpO1xuICAgIHRocm93IG5ldyBFcnJvcihyZXN1bHQuZXJyb3JzWzBdLm1lc3NhZ2UpO1xuICB9XG4gIHJldHVybiByZXN1bHQuZGF0YSBhcyBUO1xufVxuXG5leHBvcnQgY29uc3QgU0NFTkVfRlJBR01FTlQgPSBgXG4gICAgaWRcbiAgICB0aXRsZVxuICAgIGRhdGVcbiAgICByYXRpbmcxMDBcbiAgICBwbGF5X2NvdW50XG4gICAgY3VzdG9tX2ZpZWxkc1xuICAgIHBhdGhzIHtcbiAgICAgIHNjcmVlbnNob3RcbiAgICAgIHByZXZpZXdcbiAgICB9XG4gICAgZmlsZXMge1xuICAgICAgZHVyYXRpb25cbiAgICAgIHBhdGhcbiAgICB9XG4gICAgc3R1ZGlvIHtcbiAgICAgIG5hbWVcbiAgICB9XG4gICAgcGVyZm9ybWVycyB7XG4gICAgICBuYW1lXG4gICAgfVxuICAgIHRhZ3Mge1xuICAgICAgbmFtZVxuICAgIH1cbiAgYDtcblxuZXhwb3J0IGNvbnN0IEZJTkRfU0NFTkVTX1FVRVJZID0gYFxuICAgICAgcXVlcnkgRmluZFNjZW5lc0J5UmF0aW5nKCRmaWx0ZXI6IEZpbmRGaWx0ZXJUeXBlLCAkc2NlbmVfZmlsdGVyOiBTY2VuZUZpbHRlclR5cGUpIHtcbiAgICAgICAgZmluZFNjZW5lcyhmaWx0ZXI6ICRmaWx0ZXIsIHNjZW5lX2ZpbHRlcjogJHNjZW5lX2ZpbHRlcikge1xuICAgICAgICAgIGNvdW50XG4gICAgICAgICAgc2NlbmVzIHtcbiAgICAgICAgICAgICR7U0NFTkVfRlJBR01FTlR9XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgYDtcblxubGV0IGN1c3RvbUZpZWxkc1N1cHBvcnQ6IFByb21pc2U8Ym9vbGVhbj4gfCBudWxsID0gbnVsbDtcblxuLyoqXG4gKiBXaGV0aGVyIHRoaXMgU3Rhc2ggaGFzIHNjZW5lIGN1c3RvbSBmaWVsZHMgKG5lZWRlZCBmb3IgRUxPIHN0b3JhZ2UpLiBDaGVja2VkIG9uY2UgcGVyIHBhZ2VcbiAqIGxvYWQgdmlhIGludHJvc3BlY3Rpb247IGlmIGludHJvc3BlY3Rpb24gaXRzZWxmIGZhaWxzLCBhc3N1bWUgeWVzIGFuZCBsZXQgcmVhbCBxdWVyaWVzIHJlcG9ydC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNjZW5lQ3VzdG9tRmllbGRzU3VwcG9ydGVkKCk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBjdXN0b21GaWVsZHNTdXBwb3J0ID8/PSBncmFwaHFsUXVlcnk8eyBfX3R5cGU6IHsgZmllbGRzOiB7IG5hbWU6IHN0cmluZyB9W10gfSB8IG51bGwgfT4oXG4gICAgYHF1ZXJ5IHsgX190eXBlKG5hbWU6IFwiU2NlbmVcIikgeyBmaWVsZHMgeyBuYW1lIH0gfSB9YCxcbiAgKVxuICAgIC50aGVuKChkYXRhKSA9PiBkYXRhLl9fdHlwZT8uZmllbGRzLnNvbWUoKGYpID0+IGYubmFtZSA9PT0gXCJjdXN0b21fZmllbGRzXCIpID8/IHRydWUpXG4gICAgLmNhdGNoKChlKSA9PiB7XG4gICAgICBjb25zb2xlLndhcm4oXCJbU3Rhc2ggQmF0dGxlXSBDb3VsZCBub3QgY2hlY2sgZm9yIHNjZW5lIGN1c3RvbSBmaWVsZHM6XCIsIGUpO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfSk7XG4gIHJldHVybiBjdXN0b21GaWVsZHNTdXBwb3J0O1xufVxuXG4vKiogQSBjaGFuZ2UgU3Rhc2ggQmF0dGxlIHdyb3RlIHRvIGEgc2NlbmUsIHRvIG1pcnJvciBpbnRvIFN0YXNoJ3Mgb3duIHBhZ2UgY2FjaGUuICovXG5leHBvcnQgaW50ZXJmYWNlIFN0YXNoQ2FjaGVVcGRhdGUge1xuICBpZDogc3RyaW5nO1xuICByYXRpbmcxMDA/OiBudW1iZXI7XG4gIC8qKiBOZXcgRUxPIGZpZWxkcywgb3IgbnVsbCB3aGVuIHRoZXkgd2VyZSByZW1vdmVkLiAqL1xuICBlbG8/OiBFbG9GaWVsZHMgfCBudWxsO1xufVxuXG5mdW5jdGlvbiBzdGFzaEFwb2xsb0NhY2hlKCk6IEFwb2xsb0NhY2hlTGlrZSB8IHVuZGVmaW5lZCB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIHdpbmRvdy5QbHVnaW5BcGk/LnV0aWxzPy5TdGFzaFNlcnZpY2U/LmdldENsaWVudD8uKCk/LmNhY2hlO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gdW5kZWZpbmVkO1xuICB9XG59XG5cbi8qKiBXaGlsZSBTdGFzaCBCYXR0bGUgaXMgb3BlbiwgU3Rhc2gncyBjYWNoZWQgc2NlbmUgbGlzdHMgYXJlIGRyb3BwZWQgb25jZSBvbiBjbG9zZSwgbm90IGV2ZXJ5IGJhdHRsZS4gKi9cbmxldCBob2xkTGlzdFJlZnJlc2ggPSBmYWxzZTtcbmxldCBsaXN0c1N0YWxlID0gZmFsc2U7XG5cbi8qKiBEcm9wIFN0YXNoJ3MgY2FjaGVkIHNjZW5lIGxpc3RzICh0aGV5IHJlZmV0Y2gpLCBzbyByYXRpbmctc29ydGVkIGxpc3RzIHJlLXNvcnQuICovXG5mdW5jdGlvbiBkcm9wU3Rhc2hMaXN0cyhjYWNoZTogQXBvbGxvQ2FjaGVMaWtlIHwgdW5kZWZpbmVkID0gc3Rhc2hBcG9sbG9DYWNoZSgpKTogdm9pZCB7XG4gIGxpc3RzU3RhbGUgPSBmYWxzZTtcbiAgaWYgKCFjYWNoZSkgcmV0dXJuO1xuICB0cnkge1xuICAgIGNhY2hlLmV2aWN0KHsgaWQ6IFwiUk9PVF9RVUVSWVwiLCBmaWVsZE5hbWU6IFwiZmluZFNjZW5lc1wiIH0pO1xuICAgIGNhY2hlLmdjKCk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zb2xlLndhcm4oXCJbU3Rhc2ggQmF0dGxlXSBDb3VsZCBub3QgcmVmcmVzaCBTdGFzaCdzIHNjZW5lIGxpc3RzOlwiLCBlKTtcbiAgfVxufVxuXG4vKipcbiAqIEhvbGQgYmFjayBkcm9wcGluZyBTdGFzaCdzIHNjZW5lIGxpc3RzIHdoaWxlIFN0YXNoIEJhdHRsZSBpcyBvcGVuICh0cnVlKTsgcmVsZWFzaW5nIGl0IChmYWxzZSlcbiAqIGRyb3BzIHRoZW0gb25jZSBpZiByYXRpbmdzIGNoYW5nZWQgbWVhbndoaWxlLiBUaGUgcGFnZXMgYmVoaW5kIHRoZSBtb2RhbCBjYW4gd2FpdCwgYW5kIGEgZHJvcFxuICogcGVyIGJhdHRsZSB3b3VsZCByZWZldGNoIGV2ZXJ5IGxpc3QgZWFjaCBwaWNrLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaG9sZFN0YXNoTGlzdFJlZnJlc2goaG9sZDogYm9vbGVhbik6IHZvaWQge1xuICBob2xkTGlzdFJlZnJlc2ggPSBob2xkO1xuICBpZiAoIWhvbGQgJiYgbGlzdHNTdGFsZSkgZHJvcFN0YXNoTGlzdHMoKTtcbn1cblxuLyoqXG4gKiBTdGFzaCBCYXR0bGUgd3JpdGVzIHdpdGggcGxhaW4gZmV0Y2gsIHNvIFN0YXNoJ3Mgb3duIHBhZ2VzIChBcG9sbG8pIG5ldmVyIHNlZSB0aGUgY2hhbmdlcyBhbmRcbiAqIGtlZXAgc2hvd2luZyBvbGQgcmF0aW5ncyB1bnRpbCByZWZyZXNoZWQuIE1pcnJvciB0aGUgY2hhbmdlcyBpbnRvIEFwb2xsbydzIGNhY2hlZCBzY2VuZXMsIGFuZFxuICogd2hlbiByYXRpbmdzIGNoYW5nZWQsIGRyb3AgY2FjaGVkIHNjZW5lIGxpc3RzIHNvIHJhdGluZy1zb3J0ZWQgbGlzdHMgcmUtc29ydCAoaGVsZCBiYWNrIHdoaWxlXG4gKiBTdGFzaCBCYXR0bGUgaXMgb3Blbiwgc2VlIGhvbGRTdGFzaExpc3RSZWZyZXNoKS4gRG9lcyBub3RoaW5nIGlmIFN0YXNoIGRvZXNuJ3QgZXhwb3NlIGl0cyBjbGllbnQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWZyZXNoU3Rhc2hDYWNoZSh1cGRhdGVzOiBTdGFzaENhY2hlVXBkYXRlW10sIHJhdGluZ3NDaGFuZ2VkOiBib29sZWFuKTogdm9pZCB7XG4gIGNvbnN0IGNhY2hlID0gc3Rhc2hBcG9sbG9DYWNoZSgpO1xuICBpZiAoIWNhY2hlKSByZXR1cm47XG4gIHRyeSB7XG4gICAgZm9yIChjb25zdCB1cGRhdGUgb2YgdXBkYXRlcykge1xuICAgICAgY29uc3QgaWQgPSBjYWNoZS5pZGVudGlmeSh7IF9fdHlwZW5hbWU6IFwiU2NlbmVcIiwgaWQ6IHVwZGF0ZS5pZCB9KTtcbiAgICAgIGlmICghaWQpIGNvbnRpbnVlO1xuICAgICAgY29uc3QgZmllbGRzOiBSZWNvcmQ8c3RyaW5nLCAoZXhpc3Rpbmc6IHVua25vd24pID0+IHVua25vd24+ID0ge307XG4gICAgICBpZiAodXBkYXRlLnJhdGluZzEwMCAhPT0gdW5kZWZpbmVkKSBmaWVsZHMucmF0aW5nMTAwID0gKCkgPT4gdXBkYXRlLnJhdGluZzEwMDtcbiAgICAgIGlmICh1cGRhdGUuZWxvICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgY29uc3QgdmFsdWUgPSB1cGRhdGUuZWxvO1xuICAgICAgICBmaWVsZHMuY3VzdG9tX2ZpZWxkcyA9IChleGlzdGluZykgPT4gd2l0aEVsb0ZpZWxkcyhleGlzdGluZyBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IG51bGwsIHZhbHVlKTtcbiAgICAgIH1cbiAgICAgIC8vIEFwb2xsbyBvbmx5IGNhbGxzIG1vZGlmaWVycyBmb3IgZmllbGRzIGl0IGhhcyBjYWNoZWQsIHNvIG1pc3Npbmcgb25lcyBhcmUgc2tpcHBlZFxuICAgICAgY2FjaGUubW9kaWZ5KHsgaWQsIGZpZWxkcyB9KTtcbiAgICB9XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zb2xlLndhcm4oXCJbU3Rhc2ggQmF0dGxlXSBDb3VsZCBub3QgdXBkYXRlIFN0YXNoJ3MgcGFnZSBjYWNoZTpcIiwgZSk7XG4gIH1cbiAgaWYgKHJhdGluZ3NDaGFuZ2VkKSB7XG4gICAgbGlzdHNTdGFsZSA9IHRydWU7XG4gICAgaWYgKCFob2xkTGlzdFJlZnJlc2gpIGRyb3BTdGFzaExpc3RzKGNhY2hlKTtcbiAgfVxufVxuXG4vLyBFeHRyYWN0IHNjZW5lIElEIGZyb20gaW5kaXZpZHVhbCBzY2VuZSBwYWdlcyBsaWtlIC9zY2VuZXMvMTIzXG5leHBvcnQgZnVuY3Rpb24gZ2V0U2NlbmVJZEZyb21VcmwoKTogc3RyaW5nIHwgbnVsbCB7XG4gIGNvbnN0IG1hdGNoID0gd2luZG93LmxvY2F0aW9uLnBhdGhuYW1lLm1hdGNoKC9eXFwvc2NlbmVzXFwvKFxcZCspJC8pO1xuICByZXR1cm4gbWF0Y2ggPyBtYXRjaFsxXSA6IG51bGw7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBmZXRjaFNjZW5lQnlJZChzY2VuZUlkOiBzdHJpbmcpOiBQcm9taXNlPFNjZW5lIHwgbnVsbD4ge1xuICBjb25zdCBxdWVyeSA9IGBcbiAgICAgIHF1ZXJ5IEZpbmRTY2VuZSgkaWQ6IElEISkge1xuICAgICAgICBmaW5kU2NlbmUoaWQ6ICRpZCkge1xuICAgICAgICAgICR7U0NFTkVfRlJBR01FTlR9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICBgO1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCBncmFwaHFsUXVlcnk8RmluZFNjZW5lUmVzdWx0PihxdWVyeSwgeyBpZDogc2NlbmVJZCB9KTtcbiAgcmV0dXJuIHJlc3VsdC5maW5kU2NlbmU7XG59XG4iLCAiLy8gQ2xlYW4gbW9kZTogb3BlbiBTdGFzaCdzIG93biBEZWxldGVTY2VuZXNEaWFsb2csIHNvIGRlbGV0aW5nIGZyb20gYSBiYXR0bGUgYmVoYXZlcyBleGFjdGx5IGxpa2VcclxuLy8gZGVsZXRpbmcgaW4gU3Rhc2ggKHNhbWUgb3B0aW9ucyBhbmQgZGVmYXVsdHMsIGZpbGUgbGlzdCwgZGVsZXRlIGNhbGwgYW5kIHRvYXN0KS5cclxuLy9cclxuLy8gVGhlIGRpYWxvZyBuZWVkcyBTdGFzaCdzIFJlYWN0IGNvbnRleHQgKGludGwsIGNvbmZpZ3VyYXRpb24sIEFwb2xsbywgdG9hc3RzKSwgc28gaXQgY2FuJ3QgYmVcclxuLy8gcmVuZGVyZWQgc3RhbmRhbG9uZS4gSW5zdGVhZCBhIHNtYWxsIGJyaWRnZSBjb21wb25lbnQgaXMgcGF0Y2hlZCBpbnRvIFN0YXNoJ3MgbmF2YmFyIChhbHdheXNcclxuLy8gbW91bnRlZCkgYW5kIG9wZW5zIHRoZSBkaWFsb2cgd2hlbiBCYXR0bGUgYXNrcyBmb3IgaXQuIHJlYWN0LWJvb3RzdHJhcCBwb3J0YWxzIHRoZSBtb2RhbCB0b1xyXG4vLyA8Ym9keT47IENTUyBsaWZ0cyBpdCBhYm92ZSB0aGUgYmF0dGxlIG1vZGFsIHdoaWxlIEJhdHRsZSBpcyBvcGVuLlxyXG5cclxuaW1wb3J0IHsgZ3JhcGhxbFF1ZXJ5IH0gZnJvbSBcIi4uL2dyYXBocWxcIjtcclxuaW1wb3J0IHR5cGUgeyBSZWFjdE5vZGUgfSBmcm9tIFwiLi4vcGx1Z2luQXBpXCI7XHJcbmltcG9ydCB0eXBlIHsgU2NlbmUgfSBmcm9tIFwiLi4vdHlwZXNcIjtcclxuXHJcbi8qKiBTY2VuZSBmaWVsZHMgRGVsZXRlU2NlbmVzRGlhbG9nIHJlYWRzIChmaWxlIGxpc3QsIGZ1bnNjcmlwdCwgbXV0YXRpb24gaWRzKS4gKi9cclxuaW50ZXJmYWNlIERlbGV0YWJsZVNjZW5lIHtcclxuICBpZDogc3RyaW5nO1xyXG4gIHRpdGxlOiBzdHJpbmcgfCBudWxsO1xyXG4gIGludGVyYWN0aXZlOiBib29sZWFuO1xyXG4gIGZpbGVzOiB7IHBhdGg6IHN0cmluZyB9W107XHJcbn1cclxuXHJcbmNvbnN0IE9QRU5fRVZFTlQgPSBcInN0YXNoLWJhdHRsZTpvcGVuLWRlbGV0ZS1kaWFsb2dcIjtcclxuY29uc3QgQ0xPU0VfRVZFTlQgPSBcInN0YXNoLWJhdHRsZTpjbG9zZS1kZWxldGUtZGlhbG9nXCI7XHJcblxyXG5sZXQgYnJpZGdlUmVnaXN0ZXJlZCA9IGZhbHNlO1xyXG5sZXQgcGVuZGluZ1Jlc3VsdDogKChkZWxldGVkOiBib29sZWFuKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xyXG4vKiogU3Rhc2gncyBEZWxldGVTY2VuZXNEaWFsb2cgY29tcG9uZW50LCBvbmNlIGl0cyBjaHVuayBoYXMgbG9hZGVkLiAqL1xyXG5sZXQgRGVsZXRlU2NlbmVzRGlhbG9nOiB1bmtub3duID0gbnVsbDtcclxubGV0IGRpYWxvZ0xvYWRlZDogUHJvbWlzZTx2b2lkPiA9IFByb21pc2UucmVzb2x2ZSgpO1xyXG5cclxuZnVuY3Rpb24gc2V0dGxlKGRlbGV0ZWQ6IGJvb2xlYW4pOiB2b2lkIHtcclxuICBjb25zdCByZXNvbHZlID0gcGVuZGluZ1Jlc3VsdDtcclxuICBwZW5kaW5nUmVzdWx0ID0gbnVsbDtcclxuICByZXNvbHZlPy4oZGVsZXRlZCk7XHJcbn1cclxuXHJcbi8qKiBUcnVlIHdoZW4gdGhpcyBTdGFzaCBleHBvc2VzIGl0cyBkZWxldGUgZGlhbG9nIHRvIHBsdWdpbnMgKENsZWFuIG1vZGUgZGVwZW5kcyBvbiBpdCkuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBpc1N0YXNoRGVsZXRlRGlhbG9nQXZhaWxhYmxlKCk6IGJvb2xlYW4ge1xyXG4gIHJldHVybiBicmlkZ2VSZWdpc3RlcmVkO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gaXNEZWxldGVEaWFsb2dPcGVuKCk6IGJvb2xlYW4ge1xyXG4gIHJldHVybiBwZW5kaW5nUmVzdWx0ICE9PSBudWxsO1xyXG59XHJcblxyXG4vKiogQ2xvc2UgdGhlIGRpYWxvZyB3aXRob3V0IGRlbGV0aW5nIChlLmcuIHdoZW4gdGhlIGJhdHRsZSBtb2RhbCBjbG9zZXMpLiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gY2FuY2VsRGVsZXRlRGlhbG9nKCk6IHZvaWQge1xyXG4gIGlmICghcGVuZGluZ1Jlc3VsdCkgcmV0dXJuO1xyXG4gIHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBDdXN0b21FdmVudChDTE9TRV9FVkVOVCkpO1xyXG4gIHNldHRsZShmYWxzZSk7XHJcbn1cclxuXHJcbi8qKiBQYXRjaCB0aGUgYnJpZGdlIGludG8gU3Rhc2gncyBuYXZiYXIuIENhbGwgb25jZSBhdCBzdGFydHVwLCBiZWZvcmUgdGhlIG5hdmJhciByZW5kZXJzLiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gcmVnaXN0ZXJEZWxldGVEaWFsb2dCcmlkZ2UoKTogdm9pZCB7XHJcbiAgY29uc3QgYXBpID0gd2luZG93LlBsdWdpbkFwaTtcclxuICBpZiAoYnJpZGdlUmVnaXN0ZXJlZCB8fCAhYXBpPy5sb2FkYWJsZUNvbXBvbmVudHM/LkRlbGV0ZVNjZW5lc0RpYWxvZykge1xyXG4gICAgaWYgKCFhcGk/LmxvYWRhYmxlQ29tcG9uZW50cz8uRGVsZXRlU2NlbmVzRGlhbG9nKSB7XHJcbiAgICAgIGNvbnNvbGUud2FybihcIltTdGFzaCBCYXR0bGVdIFN0YXNoJ3MgZGVsZXRlIGRpYWxvZyBpc24ndCBhdmFpbGFibGUgdG8gcGx1Z2luczsgQ2xlYW4gbW9kZSBpcyBkaXNhYmxlZFwiKTtcclxuICAgIH1cclxuICAgIHJldHVybjtcclxuICB9XHJcbiAgYnJpZGdlUmVnaXN0ZXJlZCA9IHRydWU7XHJcbiAgY29uc3QgeyBSZWFjdCB9ID0gYXBpO1xyXG5cclxuICAvLyBMb2FkIHRoZSBkaWFsb2cncyBjaHVuayB1cCBmcm9udCBzbyBpdCBvcGVucyBpbnN0YW50bHlcclxuICBkaWFsb2dMb2FkZWQgPSBhcGkubG9hZGFibGVDb21wb25lbnRzXHJcbiAgICAuRGVsZXRlU2NlbmVzRGlhbG9nKClcclxuICAgIC50aGVuKChtb2QpID0+IHtcclxuICAgICAgRGVsZXRlU2NlbmVzRGlhbG9nID0gbW9kLkRlbGV0ZVNjZW5lc0RpYWxvZyA/PyBtb2QuZGVmYXVsdCA/PyBudWxsO1xyXG4gICAgfSlcclxuICAgIC5jYXRjaCgoZSkgPT4gY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIEZhaWxlZCB0byBsb2FkIFN0YXNoJ3MgZGVsZXRlIGRpYWxvZzpcIiwgZSkpO1xyXG5cclxuICBmdW5jdGlvbiBEZWxldGVCcmlkZ2UoKTogUmVhY3ROb2RlIHtcclxuICAgIGNvbnN0IFtzY2VuZSwgc2V0U2NlbmVdID0gUmVhY3QudXNlU3RhdGU8RGVsZXRhYmxlU2NlbmUgfCBudWxsPihudWxsKTtcclxuXHJcbiAgICBSZWFjdC51c2VFZmZlY3QoKCkgPT4ge1xyXG4gICAgICBjb25zdCBvcGVuID0gKGU6IEV2ZW50KTogdm9pZCA9PiB7XHJcbiAgICAgICAgLy8gVGhlIG5hdmJhciBjYW4gcmVuZGVyIG1vcmUgdGhhbiBvbmNlOyB0aGUgZmlyc3QgYnJpZGdlIHRvIGhlYXIgdGhlIGV2ZW50IGhhbmRsZXMgaXQuXHJcbiAgICAgICAgLy8gcHJldmVudERlZmF1bHQgdGVsbHMgY29uZmlybURlbGV0ZVNjZW5lIHRoZSByZXF1ZXN0IHdhcyBwaWNrZWQgdXAuXHJcbiAgICAgICAgZS5zdG9wSW1tZWRpYXRlUHJvcGFnYXRpb24oKTtcclxuICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7XHJcbiAgICAgICAgc2V0U2NlbmUoKGUgYXMgQ3VzdG9tRXZlbnQ8RGVsZXRhYmxlU2NlbmU+KS5kZXRhaWwpO1xyXG4gICAgICB9O1xyXG4gICAgICBjb25zdCBjbG9zZSA9ICgpOiB2b2lkID0+IHNldFNjZW5lKG51bGwpO1xyXG4gICAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcihPUEVOX0VWRU5ULCBvcGVuKTtcclxuICAgICAgd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoQ0xPU0VfRVZFTlQsIGNsb3NlKTtcclxuICAgICAgcmV0dXJuICgpID0+IHtcclxuICAgICAgICB3aW5kb3cucmVtb3ZlRXZlbnRMaXN0ZW5lcihPUEVOX0VWRU5ULCBvcGVuKTtcclxuICAgICAgICB3aW5kb3cucmVtb3ZlRXZlbnRMaXN0ZW5lcihDTE9TRV9FVkVOVCwgY2xvc2UpO1xyXG4gICAgICB9O1xyXG4gICAgfSwgW10pO1xyXG5cclxuICAgIGlmICghc2NlbmUgfHwgIURlbGV0ZVNjZW5lc0RpYWxvZykgcmV0dXJuIG51bGw7XHJcbiAgICByZXR1cm4gUmVhY3QuY3JlYXRlRWxlbWVudChEZWxldGVTY2VuZXNEaWFsb2csIHtcclxuICAgICAgc2VsZWN0ZWQ6IFtzY2VuZV0sXHJcbiAgICAgIG9uQ2xvc2U6IChkZWxldGVkOiBib29sZWFuKSA9PiB7XHJcbiAgICAgICAgc2V0U2NlbmUobnVsbCk7XHJcbiAgICAgICAgc2V0dGxlKGRlbGV0ZWQpO1xyXG4gICAgICB9LFxyXG4gICAgfSk7XHJcbiAgfVxyXG5cclxuICAvLyBTdGFzaCBhcHBlbmRzIHRoZSByZW5kZXJlZCByZXN1bHQgYWZ0ZXIgdGhlIGNhbGwncyBhcmdzLCBhbmQgYW5vdGhlciBwbHVnaW4ncyBgYmVmb3JlYCBwYXRjaFxyXG4gIC8vIGNhbiBjaGFuZ2UgaG93IG1hbnkgYXJncyB0aGVyZSBhcmUsIHNvIHRoZSByZXN1bHQgaXMgYWx3YXlzIHRoZSBsYXN0IG9uZSwgbm90IGEgZml4ZWQgc2xvdC5cclxuICBhcGkucGF0Y2guYWZ0ZXIoXCJNYWluTmF2QmFyLlV0aWxpdHlJdGVtc1wiLCAoLi4uYXJnczogdW5rbm93bltdKSA9PlxyXG4gICAgUmVhY3QuY3JlYXRlRWxlbWVudChcclxuICAgICAgUmVhY3QuRnJhZ21lbnQsXHJcbiAgICAgIG51bGwsXHJcbiAgICAgIGFyZ3NbYXJncy5sZW5ndGggLSAxXSBhcyBSZWFjdE5vZGUsXHJcbiAgICAgIFJlYWN0LmNyZWF0ZUVsZW1lbnQoRGVsZXRlQnJpZGdlKSxcclxuICAgICksXHJcbiAgKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIE9wZW4gU3Rhc2gncyBkZWxldGUgZGlhbG9nIGZvciBgc2NlbmVgLiBSZXNvbHZlcyB0cnVlIG9uY2UgU3Rhc2ggaGFzIGRlbGV0ZWQgaXQsIGZhbHNlIGlmIHRoZVxyXG4gKiB1c2VyIGNhbmNlbGxlZCAob3IgdGhlIGRlbGV0ZSBmYWlsZWQg4oCUIFN0YXNoIHNob3dzIGl0cyBvd24gZXJyb3IgdG9hc3QpLlxyXG4gKi9cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNvbmZpcm1EZWxldGVTY2VuZShzY2VuZTogU2NlbmUpOiBQcm9taXNlPGJvb2xlYW4+IHtcclxuICBpZiAoIWJyaWRnZVJlZ2lzdGVyZWQpIHJldHVybiBmYWxzZTtcclxuICBjYW5jZWxEZWxldGVEaWFsb2coKTtcclxuICBhd2FpdCBkaWFsb2dMb2FkZWQ7XHJcbiAgaWYgKCFEZWxldGVTY2VuZXNEaWFsb2cpIHJldHVybiBmYWxzZTtcclxuXHJcbiAgY29uc3QgeyBmaW5kU2NlbmUgfSA9IGF3YWl0IGdyYXBocWxRdWVyeTx7IGZpbmRTY2VuZTogRGVsZXRhYmxlU2NlbmUgfCBudWxsIH0+KFxyXG4gICAgYHF1ZXJ5IEJhdHRsZURlbGV0YWJsZVNjZW5lKCRpZDogSUQhKSB7IGZpbmRTY2VuZShpZDogJGlkKSB7IGlkIHRpdGxlIGludGVyYWN0aXZlIGZpbGVzIHsgcGF0aCB9IH0gfWAsXHJcbiAgICB7IGlkOiBzY2VuZS5pZCB9LFxyXG4gICk7XHJcbiAgaWYgKCFmaW5kU2NlbmUpIHJldHVybiBmYWxzZTtcclxuXHJcbiAgY29uc3QgcmVzdWx0ID0gbmV3IFByb21pc2U8Ym9vbGVhbj4oKHJlc29sdmUpID0+IHtcclxuICAgIHBlbmRpbmdSZXN1bHQgPSByZXNvbHZlO1xyXG4gIH0pO1xyXG5cclxuICAvLyBTdGFzaCByZW5kZXJzIHRoZSBuYXZiYXIgYWZ0ZXIgcGx1Z2lucyBsb2FkLCBzbyB0aGUgYnJpZGdlIGlzIG1vdW50ZWQgd2VsbCBiZWZvcmUgYW55b25lIGNhblxyXG4gIC8vIGNsaWNrIGEgZGVsZXRlIGJ1dHRvbjsgaWYgaXQgc29tZWhvdyBpc24ndCwgc2F5IHNvIHJhdGhlciB0aGFuIGZha2luZyBhIG5hdmlnYXRpb25cclxuICBpZiAoIXJlcXVlc3REaWFsb2coZmluZFNjZW5lKSkge1xyXG4gICAgY29uc29sZS53YXJuKFwiW1N0YXNoIEJhdHRsZV0gU3Rhc2gncyBkZWxldGUgZGlhbG9nIGJyaWRnZSBpc24ndCBtb3VudGVkXCIpO1xyXG4gICAgc2V0dGxlKGZhbHNlKTtcclxuICAgIHdpbmRvdy5hbGVydChcIkNvdWxkbid0IG9wZW4gU3Rhc2gncyBkZWxldGUgZGlhbG9nLiBSZWxvYWQgdGhlIHBhZ2UgYW5kIHRyeSBhZ2Fpbi5cIik7XHJcbiAgfVxyXG4gIHJldHVybiByZXN1bHQ7XHJcbn1cclxuXHJcbi8qKiBBc2sgdGhlIGJyaWRnZSB0byBvcGVuIHRoZSBkaWFsb2c7IGZhbHNlIGlmIG5vIGJyaWRnZSBpcyBtb3VudGVkIHRvIHBpY2sgaXQgdXAuICovXHJcbmZ1bmN0aW9uIHJlcXVlc3REaWFsb2coc2NlbmU6IERlbGV0YWJsZVNjZW5lKTogYm9vbGVhbiB7XHJcbiAgY29uc3QgcmVxdWVzdCA9IG5ldyBDdXN0b21FdmVudChPUEVOX0VWRU5ULCB7IGRldGFpbDogc2NlbmUsIGNhbmNlbGFibGU6IHRydWUgfSk7XHJcbiAgcmV0dXJuICF3aW5kb3cuZGlzcGF0Y2hFdmVudChyZXF1ZXN0KTtcclxufVxyXG4iLCAiLy8gVVJMIGZpbHRlciBwYXJzaW5nIGZvciBTdGFzaCBsaXN0IOKGkiBHcmFwaFFMIHNjZW5lIHF1ZXJpZXMuXG5cbmltcG9ydCB0eXBlIHsgRmluZEZpbHRlclR5cGUsIFNjZW5lRmlsdGVyVHlwZSB9IGZyb20gXCIuL3R5cGVzXCI7XG5cbi8vIEdldCBjdXJyZW50IFVSTCBzZWFyY2ggcGFyYW1zXG5leHBvcnQgZnVuY3Rpb24gZ2V0U2VhcmNoUGFyYW1zKCk6IFVSTFNlYXJjaFBhcmFtcyB7XG4gIHJldHVybiBuZXcgVVJMU2VhcmNoUGFyYW1zKHdpbmRvdy5sb2NhdGlvbi5zZWFyY2gpO1xufVxuXG4vLyBCdWlsZCBGaW5kRmlsdGVyVHlwZSBmcm9tIGN1cnJlbnQgVVJMIHNlYXJjaCBwYXJhbXMgKG9yIGFuIGV4cGxpY2l0IHBhcmFtcyBvYmplY3QpLlxuZXhwb3J0IGZ1bmN0aW9uIGdldEZpbmRGaWx0ZXIoXG4gIG92ZXJyaWRlczogUGFydGlhbDxGaW5kRmlsdGVyVHlwZT4gPSB7fSxcbiAgc2VhcmNoUGFyYW1zOiBVUkxTZWFyY2hQYXJhbXMgPSBnZXRTZWFyY2hQYXJhbXMoKSxcbik6IEZpbmRGaWx0ZXJUeXBlIHtcbiAgY29uc3QgZmlsdGVyOiBGaW5kRmlsdGVyVHlwZSA9IHtcbiAgICBwZXJfcGFnZTogb3ZlcnJpZGVzLnBlcl9wYWdlID8/IC0xLFxuICAgIHNvcnQ6IG92ZXJyaWRlcy5zb3J0ID8/IChzZWFyY2hQYXJhbXMuZ2V0KFwic29ydGJ5XCIpIHx8IFwicmF0aW5nXCIpLFxuICAgIGRpcmVjdGlvbjogb3ZlcnJpZGVzLmRpcmVjdGlvbiA/PyAoc2VhcmNoUGFyYW1zLmdldChcInNvcnRkaXJcIik/LnRvVXBwZXJDYXNlKCkgfHwgXCJERVNDXCIpLFxuICAgIC4uLm92ZXJyaWRlcyxcbiAgfTtcblxuICAvLyBJbmNsdWRlIHNlYXJjaCBxdWVyeSBpZiBwcmVzZW50XG4gIGNvbnN0IHF1ZXJ5ID0gc2VhcmNoUGFyYW1zLmdldChcInFcIik7XG4gIGlmIChxdWVyeSkge1xuICAgIGZpbHRlci5xID0gcXVlcnk7XG4gIH1cblxuICByZXR1cm4gZmlsdGVyO1xufVxuXG4vLyBUcmFuc2xhdGUgSlNPTiBzdHJpbmcgYmV0d2VlbiBVUkwgZm9ybWF0IChwYXJlbnRoZXNlcykgYW5kIHN0YW5kYXJkIEpTT04gKGJyYWNlcylcbi8vIFBvcnRlZCBmcm9tIFN0YXNoJ3MgTGlzdEZpbHRlck1vZGVsLnRyYW5zbGF0ZUpTT05cbi8vIFRoaXMgc2FmZWx5IGhhbmRsZXMgcGFyZW50aGVzZXMgaW5zaWRlIHF1b3RlZCBzdHJpbmdzXG5leHBvcnQgZnVuY3Rpb24gdHJhbnNsYXRlSlNPTihqc29uU3RyaW5nOiBzdHJpbmcsIGRlY29kaW5nOiBib29sZWFuKTogc3RyaW5nIHtcbiAgbGV0IGluU3RyaW5nID0gZmFsc2U7XG4gIGxldCBlc2NhcGUgPSBmYWxzZTtcbiAgcmV0dXJuIFsuLi5qc29uU3RyaW5nXVxuICAgIC5tYXAoKGMpID0+IHtcbiAgICAgIGlmIChlc2NhcGUpIHtcbiAgICAgICAgZXNjYXBlID0gZmFsc2U7XG4gICAgICAgIHJldHVybiBjO1xuICAgICAgfVxuICAgICAgc3dpdGNoIChjKSB7XG4gICAgICAgIGNhc2UgXCJcXFxcXCI6XG4gICAgICAgICAgaWYgKGluU3RyaW5nKSBlc2NhcGUgPSB0cnVlO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlICdcIic6XG4gICAgICAgICAgaW5TdHJpbmcgPSAhaW5TdHJpbmc7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgXCIoXCI6XG4gICAgICAgICAgaWYgKGRlY29kaW5nICYmICFpblN0cmluZykgcmV0dXJuIFwie1wiO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlIFwiKVwiOlxuICAgICAgICAgIGlmIChkZWNvZGluZyAmJiAhaW5TdHJpbmcpIHJldHVybiBcIn1cIjtcbiAgICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIHJldHVybiBjO1xuICAgIH0pXG4gICAgLmpvaW4oXCJcIik7XG59XG5cbi8vIENyaXRlcmlvbiBjYXRlZ29yeSBtYXBwaW5ncyBmb3IgVVJMIC0+IEdyYXBoUUwgdHJhbnNmb3JtYXRpb25cbi8vIEVhY2ggY2F0ZWdvcnkgcmVxdWlyZXMgZGlmZmVyZW50IHRyYW5zZm9ybWF0aW9uIGxvZ2ljXG5jb25zdCBDUklURVJJT05fQ0FURUdPUklFUyA9IHtcbiAgLy8gQm9vbGVhbjogbm8gbW9kaWZpZXIsIHZhbHVlIGlzIFwidHJ1ZVwiL1wiZmFsc2VcIiBzdHJpbmcgLT4gY29udmVydCB0byBib29sZWFuXG4gIGJvb2xlYW46IG5ldyBTZXQoW1wib3JnYW5pemVkXCIsIFwiaW50ZXJhY3RpdmVcIiwgXCJwZXJmb3JtZXJfZmF2b3JpdGVcIl0pLFxuICAvLyBTdHJpbmdFbnVtOiBVUkwgaGFzIG1vZGlmaWVyIGJ1dCBHcmFwaFFMIGp1c3QgZXhwZWN0cyB0aGUgc3RyaW5nIHZhbHVlIGRpcmVjdGx5XG4gIHN0cmluZ0VudW06IG5ldyBTZXQoW1wiaXNfbWlzc2luZ1wiLCBcImhhc19tYXJrZXJzXCJdKSxcbiAgLy8gTXVsdGk6IHZhbHVlIGlzIGFycmF5IG9mIHtpZCwgbGFiZWx9IC0+IGV4dHJhY3QgSURzIG9ubHlcbiAgbXVsdGk6IG5ldyBTZXQoW1wicGVyZm9ybWVyc1wiLCBcImdyb3Vwc1wiLCBcIm1vdmllc1wiLCBcImdhbGxlcmllc1wiXSksXG4gIC8vIEhpZXJhcmNoaWNhbE11bHRpOiB2YWx1ZSBoYXMge2l0ZW1zLCBleGNsdWRlZCwgZGVwdGh9IC0+IHJlbmFtZSB0byB7dmFsdWUsIGV4Y2x1ZGVzLCBkZXB0aH0gYW5kIGV4dHJhY3QgSURzXG4gIGhpZXJhcmNoaWNhbE11bHRpOiBuZXcgU2V0KFtcInRhZ3NcIiwgXCJzdHVkaW9zXCIsIFwicGVyZm9ybWVyX3RhZ3NcIl0pLFxufTtcblxuLy8gUmVzb2x1dGlvbiBzdHJpbmcgdG8gR3JhcGhRTCBlbnVtIG1hcHBpbmdcbi8vIFVSTCB1c2VzIGh1bWFuLXJlYWRhYmxlIHN0cmluZ3MsIEdyYXBoUUwgZXhwZWN0cyBSZXNvbHV0aW9uRW51bSB2YWx1ZXNcbmNvbnN0IFJFU09MVVRJT05fTUFQOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICBcIjE0NHBcIjogXCJWRVJZX0xPV1wiLFxuICBcIjI0MHBcIjogXCJMT1dcIixcbiAgXCIzNjBwXCI6IFwiUjM2MFBcIixcbiAgXCI0ODBwXCI6IFwiU1RBTkRBUkRcIixcbiAgXCI1NDBwXCI6IFwiV0VCX0hEXCIsXG4gIFwiNzIwcFwiOiBcIlNUQU5EQVJEX0hEXCIsXG4gIFwiMTA4MHBcIjogXCJGVUxMX0hEXCIsXG4gIFwiMTQ0MHBcIjogXCJRVUFEX0hEXCIsXG4gIFwiNGtcIjogXCJGT1VSX0tcIixcbiAgXCI1a1wiOiBcIkZJVkVfS1wiLFxuICBcIjZrXCI6IFwiU0lYX0tcIixcbiAgXCI3a1wiOiBcIlNFVkVOX0tcIixcbiAgXCI4a1wiOiBcIkVJR0hUX0tcIixcbiAgSHVnZTogXCJIVUdFXCIsXG59O1xuXG4vLyBPcmllbnRhdGlvbiBzdHJpbmcgdG8gR3JhcGhRTCBlbnVtIG1hcHBpbmdcbmNvbnN0IE9SSUVOVEFUSU9OX01BUDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgTGFuZHNjYXBlOiBcIkxBTkRTQ0FQRVwiLFxuICBQb3J0cmFpdDogXCJQT1JUUkFJVFwiLFxuICBTcXVhcmU6IFwiU1FVQVJFXCIsXG59O1xuXG5jb25zdCBpZE9mID0gKHY6IGFueSk6IHVua25vd24gPT4gKHR5cGVvZiB2ID09PSBcIm9iamVjdFwiICYmIHYgJiYgdi5pZCA/IHYuaWQgOiB2KTtcblxuLy8gQnVpbGQgU2NlbmVGaWx0ZXJUeXBlIGZyb20gVVJMICdjJyBwYXJhbXMgKGRlZmF1bHRzIHRvIGN1cnJlbnQgcGFnZSBVUkwpLlxuZXhwb3J0IGZ1bmN0aW9uIGdldFNjZW5lRmlsdGVyKFxuICBzZWFyY2hQYXJhbXM6IFVSTFNlYXJjaFBhcmFtcyA9IGdldFNlYXJjaFBhcmFtcygpLFxuKTogU2NlbmVGaWx0ZXJUeXBlIHwgbnVsbCB7XG4gIGNvbnN0IHNjZW5lRmlsdGVyOiBTY2VuZUZpbHRlclR5cGUgPSB7fTtcblxuICBpZiAoIXNlYXJjaFBhcmFtcy5oYXMoXCJjXCIpKSByZXR1cm4gbnVsbDtcblxuICBmb3IgKGNvbnN0IGNTdHIgb2Ygc2VhcmNoUGFyYW1zLmdldEFsbChcImNcIikpIHtcbiAgICB0cnkge1xuICAgICAgLy8gRGVjb2RlIFVSTCBmb3JtYXQ6ICgpIC0+IHt9IChzYWZlbHkgcHJlc2VydmluZyBzdHJpbmdzKVxuICAgICAgY29uc3QgZGVjb2RlZCA9IHRyYW5zbGF0ZUpTT04oY1N0ciwgdHJ1ZSk7XG4gICAgICBjb25zdCBjT2JqOiBhbnkgPSBKU09OLnBhcnNlKGRlY29kZWQpO1xuXG4gICAgICBjb25zdCBmaWx0ZXJUeXBlOiBzdHJpbmcgfCB1bmRlZmluZWQgPSBjT2JqLnR5cGU7XG4gICAgICBpZiAoIWZpbHRlclR5cGUpIHtcbiAgICAgICAgY29uc29sZS53YXJuKFwiW1N0YXNoIEJhdHRsZV0gRmlsdGVyIG1pc3NpbmcgdHlwZTpcIiwgY09iaik7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICAvLyBSZW1vdmUgdHlwZSBmcm9tIHRoZSBvYmplY3QgLSBpdCBiZWNvbWVzIHRoZSBrZXlcbiAgICAgIGNvbnN0IHsgdHlwZTogX3R5cGUsIC4uLnJlc3QgfSA9IGNPYmo7XG5cbiAgICAgIC8vIENhdGVnb3J5OiBCb29sZWFuIChvcmdhbml6ZWQsIGludGVyYWN0aXZlLCBwZXJmb3JtZXJfZmF2b3JpdGUpXG4gICAgICBpZiAoQ1JJVEVSSU9OX0NBVEVHT1JJRVMuYm9vbGVhbi5oYXMoZmlsdGVyVHlwZSkpIHtcbiAgICAgICAgc2NlbmVGaWx0ZXJbZmlsdGVyVHlwZV0gPSByZXN0LnZhbHVlID09PSBcInRydWVcIiB8fCByZXN0LnZhbHVlID09PSB0cnVlO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgLy8gQ2F0ZWdvcnk6IFN0cmluZ0VudW0gKHNjZW5lSXNNaXNzaW5nLCBoYXNNYXJrZXJzKVxuICAgICAgaWYgKENSSVRFUklPTl9DQVRFR09SSUVTLnN0cmluZ0VudW0uaGFzKGZpbHRlclR5cGUpKSB7XG4gICAgICAgIHNjZW5lRmlsdGVyW2ZpbHRlclR5cGVdID0gcmVzdC52YWx1ZTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIC8vIENhdGVnb3J5OiBNdWx0aSAocGVyZm9ybWVycywgZ3JvdXBzLCBtb3ZpZXMsIGdhbGxlcmllcylcbiAgICAgIGlmIChDUklURVJJT05fQ0FURUdPUklFUy5tdWx0aS5oYXMoZmlsdGVyVHlwZSkpIHtcbiAgICAgICAgY29uc3QgcmVzdWx0OiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgbW9kaWZpZXI6IHJlc3QubW9kaWZpZXIgfTtcbiAgICAgICAgY29uc3QgdmFsID0gcmVzdC52YWx1ZSB8fCB7fTtcblxuICAgICAgICBpZiAodmFsLml0ZW1zICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICBjb25zdCBpdGVtczogYW55W10gPSB2YWwuaXRlbXMgfHwgW107XG4gICAgICAgICAgY29uc3QgZXhjbHVkZWQ6IGFueVtdID0gdmFsLmV4Y2x1ZGVkIHx8IFtdO1xuICAgICAgICAgIHJlc3VsdC52YWx1ZSA9IGl0ZW1zLm1hcChpZE9mKTtcbiAgICAgICAgICBpZiAoZXhjbHVkZWQubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgcmVzdWx0LmV4Y2x1ZGVzID0gZXhjbHVkZWQubWFwKGlkT2YpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIGlmIChBcnJheS5pc0FycmF5KHJlc3QudmFsdWUpKSB7XG4gICAgICAgICAgcmVzdWx0LnZhbHVlID0gcmVzdC52YWx1ZS5tYXAoaWRPZik7XG4gICAgICAgIH0gZWxzZSBpZiAocmVzdC5tb2RpZmllciA9PT0gXCJJU19OVUxMXCIgfHwgcmVzdC5tb2RpZmllciA9PT0gXCJOT1RfTlVMTFwiKSB7XG4gICAgICAgICAgcmVzdWx0LnZhbHVlID0gW107XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgcmVzdWx0LnZhbHVlID0gcmVzdC52YWx1ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIHNjZW5lRmlsdGVyW2ZpbHRlclR5cGVdID0gcmVzdWx0O1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgLy8gQ2F0ZWdvcnk6IEhpZXJhcmNoaWNhbE11bHRpICh0YWdzLCBzdHVkaW9zLCBwZXJmb3JtZXJfdGFncylcbiAgICAgIGlmIChDUklURVJJT05fQ0FURUdPUklFUy5oaWVyYXJjaGljYWxNdWx0aS5oYXMoZmlsdGVyVHlwZSkpIHtcbiAgICAgICAgY29uc3QgdmFsID0gcmVzdC52YWx1ZSB8fCB7fTtcbiAgICAgICAgY29uc3QgaXRlbXM6IGFueVtdID0gdmFsLml0ZW1zIHx8IFtdO1xuICAgICAgICBjb25zdCBleGNsdWRlZDogYW55W10gPSB2YWwuZXhjbHVkZWQgfHwgW107XG4gICAgICAgIHNjZW5lRmlsdGVyW2ZpbHRlclR5cGVdID0ge1xuICAgICAgICAgIG1vZGlmaWVyOiByZXN0Lm1vZGlmaWVyLFxuICAgICAgICAgIHZhbHVlOiBpdGVtcy5tYXAoaWRPZiksXG4gICAgICAgICAgZXhjbHVkZXM6IGV4Y2x1ZGVkLm1hcChpZE9mKSxcbiAgICAgICAgICBkZXB0aDogdmFsLmRlcHRoID8/IDAsXG4gICAgICAgIH07XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICAvLyBDYXRlZ29yeTogUmVzb2x1dGlvbiAobmVlZHMgc3RyaW5nIC0+IGVudW0gY29udmVyc2lvbilcbiAgICAgIGlmIChmaWx0ZXJUeXBlID09PSBcInJlc29sdXRpb25cIikge1xuICAgICAgICBzY2VuZUZpbHRlcltmaWx0ZXJUeXBlXSA9IHtcbiAgICAgICAgICBtb2RpZmllcjogcmVzdC5tb2RpZmllcixcbiAgICAgICAgICB2YWx1ZTogUkVTT0xVVElPTl9NQVBbcmVzdC52YWx1ZV0gfHwgcmVzdC52YWx1ZSxcbiAgICAgICAgfTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIC8vIENhdGVnb3J5OiBPcmllbnRhdGlvbiAobXVsdGktc2VsZWN0IGVudW0sIG5vIG1vZGlmaWVyKVxuICAgICAgaWYgKGZpbHRlclR5cGUgPT09IFwib3JpZW50YXRpb25cIikge1xuICAgICAgICBjb25zdCB2YWx1ZXM6IGFueVtdID0gQXJyYXkuaXNBcnJheShyZXN0LnZhbHVlKSA/IHJlc3QudmFsdWUgOiBbcmVzdC52YWx1ZV07XG4gICAgICAgIHNjZW5lRmlsdGVyW2ZpbHRlclR5cGVdID0ge1xuICAgICAgICAgIHZhbHVlOiB2YWx1ZXMubWFwKCh2KSA9PiBPUklFTlRBVElPTl9NQVBbdl0gfHwgdikuZmlsdGVyKEJvb2xlYW4pLFxuICAgICAgICB9O1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgLy8gQ2F0ZWdvcnk6IER1cGxpY2F0ZWQgKHBoYXNoIGR1cGxpY2F0ZSBmaWx0ZXIgLSBkaWZmZXJlbnQgc3RydWN0dXJlKVxuICAgICAgaWYgKGZpbHRlclR5cGUgPT09IFwiZHVwbGljYXRlZFwiKSB7XG4gICAgICAgIHNjZW5lRmlsdGVyW2ZpbHRlclR5cGVdID0ge1xuICAgICAgICAgIGR1cGxpY2F0ZWQ6IHJlc3QudmFsdWUgPT09IFwidHJ1ZVwiIHx8IHJlc3QudmFsdWUgPT09IHRydWUsXG4gICAgICAgIH07XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICAvLyBDYXRlZ29yeTogU3RhbmRhcmQgKG51bWJlciwgc3RyaW5nLCBkYXRlLCB0aW1lc3RhbXAsIGR1cmF0aW9uLCBzcGVjaWFsKVxuICAgICAgaWYgKFxuICAgICAgICByZXN0LnZhbHVlICYmXG4gICAgICAgIHR5cGVvZiByZXN0LnZhbHVlID09PSBcIm9iamVjdFwiICYmXG4gICAgICAgICFBcnJheS5pc0FycmF5KHJlc3QudmFsdWUpICYmXG4gICAgICAgIFwidmFsdWVcIiBpbiByZXN0LnZhbHVlXG4gICAgICApIHtcbiAgICAgICAgLy8gRmxhdHRlbjogeyBtb2RpZmllciwgdmFsdWU6IHsgdmFsdWU6IFgsIHZhbHVlMjogWSB9IH0gLT4geyBtb2RpZmllciwgdmFsdWU6IFgsIHZhbHVlMjogWSB9XG4gICAgICAgIHNjZW5lRmlsdGVyW2ZpbHRlclR5cGVdID0ge1xuICAgICAgICAgIG1vZGlmaWVyOiByZXN0Lm1vZGlmaWVyLFxuICAgICAgICAgIHZhbHVlOiByZXN0LnZhbHVlLnZhbHVlLFxuICAgICAgICAgIC4uLihyZXN0LnZhbHVlLnZhbHVlMiAhPT0gdW5kZWZpbmVkICYmIHsgdmFsdWUyOiByZXN0LnZhbHVlLnZhbHVlMiB9KSxcbiAgICAgICAgfTtcbiAgICAgIH0gZWxzZSBpZiAocmVzdC5tb2RpZmllciA9PT0gXCJJU19OVUxMXCIgfHwgcmVzdC5tb2RpZmllciA9PT0gXCJOT1RfTlVMTFwiKSB7XG4gICAgICAgIC8vIElTX05VTEwvTk9UX05VTEwgZG9uJ3QgdXNlIHRoZSB2YWx1ZSwgYnV0IHRoZSBzY2hlbWEgc3RpbGwgcmVxdWlyZXMgaXRcbiAgICAgICAgc2NlbmVGaWx0ZXJbZmlsdGVyVHlwZV0gPSB7XG4gICAgICAgICAgbW9kaWZpZXI6IHJlc3QubW9kaWZpZXIsXG4gICAgICAgICAgdmFsdWU6IDAsXG4gICAgICAgIH07XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBQYXNzIHRocm91Z2ggYXMtaXMgKHN0cmluZyBjcml0ZXJpYSwgc3BlY2lhbCBjcml0ZXJpYSBsaWtlIHBoYXNoLCBzdGFzaF9pZCwgZXRjLilcbiAgICAgICAgc2NlbmVGaWx0ZXJbZmlsdGVyVHlwZV0gPSByZXN0O1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoXCJbU3Rhc2ggQmF0dGxlXSBGYWlsZWQgdG8gcGFyc2UgZmlsdGVyOlwiLCBjU3RyLCBlKTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gT2JqZWN0LmtleXMoc2NlbmVGaWx0ZXIpLmxlbmd0aCA+IDAgPyBzY2VuZUZpbHRlciA6IG51bGw7XG59XG5cbi8qKiBQYXJzZWQgZmlsdGVyIHN0YXRlIGZvciB0aGUgY3VycmVudCBTdGFzaCBsaXN0IFVSTC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgTGlzdEZpbHRlcnMge1xuICBmaWx0ZXJLZXk6IHN0cmluZztcbiAgc2NlbmVGaWx0ZXI6IFNjZW5lRmlsdGVyVHlwZSB8IG51bGw7XG4gIGZpbHRlckFjdGl2ZTogYm9vbGVhbjtcbn1cblxuLyoqIFJlYWQgVVJMIGZpbHRlciBzdGF0ZSBvbmNlIChjYWNoZSBrZXksIEdyYXBoUUwgc2NlbmVfZmlsdGVyLCBhY3RpdmUgZmxhZykuICovXG5leHBvcnQgZnVuY3Rpb24gcmVhZEZpbHRlcnMoKTogTGlzdEZpbHRlcnMge1xuICBjb25zdCBzZWFyY2hQYXJhbXMgPSBnZXRTZWFyY2hQYXJhbXMoKTtcbiAgY29uc3Qgc2NlbmVGaWx0ZXIgPSBnZXRTY2VuZUZpbHRlcihzZWFyY2hQYXJhbXMpO1xuICBjb25zdCBxID0gc2VhcmNoUGFyYW1zLmdldChcInFcIikgfHwgXCJcIjtcbiAgcmV0dXJuIHtcbiAgICBmaWx0ZXJLZXk6IEpTT04uc3RyaW5naWZ5KHsgcSwgZmlsdGVyOiBzY2VuZUZpbHRlciB8fCB7fSB9KSxcbiAgICBzY2VuZUZpbHRlcixcbiAgICBmaWx0ZXJBY3RpdmU6IEJvb2xlYW4oc2NlbmVGaWx0ZXIgfHwgc2VhcmNoUGFyYW1zLmhhcyhcImNcIikgfHwgc2VhcmNoUGFyYW1zLmdldChcInFcIikpLFxuICB9O1xufVxuXG4vLyBDYWNoZSBrZXkgZm9yIHRoZSBjdXJyZW50IGxpc3QgVVJMIChjcml0ZXJpYSArIHRleHQgc2VhcmNoKS5cbmV4cG9ydCBmdW5jdGlvbiBidWlsZEZpbHRlcktleSgpOiBzdHJpbmcge1xuICByZXR1cm4gcmVhZEZpbHRlcnMoKS5maWx0ZXJLZXk7XG59XG5cbi8qKiBUcnVlIHdoZW4gdGhlIGN1cnJlbnQgU3Rhc2ggbGlzdCBVUkwgaGFzIGFjdGl2ZSBmaWx0ZXJzIChjcml0ZXJpYSBhbmQvb3IgdGV4dCBzZWFyY2gpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNoZWNrRm9yRmlsdGVycygpOiBib29sZWFuIHtcbiAgcmV0dXJuIHJlYWRGaWx0ZXJzKCkuZmlsdGVyQWN0aXZlO1xufVxuIiwgIi8vIENlbnRyYWwgbXV0YWJsZSBydW50aW1lIHN0YXRlLlxuLy9cbi8vIFRoZSBvcmlnaW5hbCBwbHVnaW4gdXNlZCBtb2R1bGUtbGV2ZWwgYGxldGAgYmluZGluZ3Mgc2hhcmVkIGFjcm9zcyBtYW55IGZ1bmN0aW9ucy5cbi8vIEVTIG1vZHVsZXMgY2Fubm90IHJlYXNzaWduIGFuIGltcG9ydGVkIGJpbmRpbmcgZnJvbSBhbm90aGVyIG1vZHVsZSwgc28gYWxsIHNoYXJlZFxuLy8gbXV0YWJsZSB2YWx1ZXMgbGl2ZSBvbiB0aGlzIHNpbmdsZSBgc3RhdGVgIG9iamVjdCB0aGF0IGV2ZXJ5IG1vZHVsZSBpbXBvcnRzLlxuXG5pbXBvcnQgeyBERUZBVUxUX1NFVFRJTkdTIH0gZnJvbSBcIi4vY29uc3RhbnRzXCI7XG5pbXBvcnQgdHlwZSB7IE1vZGUsIFBhaXIsIFBsYWNlbWVudFJ1biwgUmFua3MsIFNjZW5lLCBTZXR0aW5ncyB9IGZyb20gXCIuL3R5cGVzXCI7XG5cbmV4cG9ydCBpbnRlcmZhY2UgTWVtb3J5Q2FjaGUge1xuICBhbGxTY2VuZXM6IFNjZW5lW10gfCBudWxsOyAvLyBBbGwgc2NlbmVzIChubyBmaWx0ZXIpXG4gIGZpbHRlcmVkU2NlbmVzOiBTY2VuZVtdIHwgbnVsbDsgLy8gU2NlbmVzIG1hdGNoaW5nIGN1cnJlbnQgZmlsdGVyXG4gIGZpbHRlcktleTogc3RyaW5nIHwgbnVsbDsgLy8gQ3VycmVudCBmaWx0ZXIgcGFyYW1zIGZvciBjYWNoZSB2YWxpZGF0aW9uXG4gIHRpbWVzdGFtcDogbnVtYmVyIHwgbnVsbDsgLy8gV2hlbiBjYWNoZSB3YXMgcG9wdWxhdGVkXG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQmF0dGxlU3RhdGUge1xuICAvLyBDdXJyZW50IGNvbXBhcmlzb24gcGFpciBhbmQgbW9kZVxuICBjdXJyZW50UGFpcjogUGFpcjtcbiAgY3VycmVudFJhbmtzOiBSYW5rcztcbiAgY3VycmVudE1vZGU6IE1vZGU7XG4gIC8vIENoYW1waW9uIHJ1biB0cmFja2luZ1xuICBjaGFtcGlvblNjZW5lOiBTY2VuZSB8IG51bGw7IC8vIFRoZSBzY2VuZSBkZWZlbmRpbmcgKHdpbm5lciBzdGF5cyBvbilcbiAgY2hhbXBpb25XaW5zOiBudW1iZXI7IC8vIEl0cyBjdXJyZW50IHdpbiBzdHJlYWtcbiAgY2hhbXBpb25EZWZlYXRlZDogc3RyaW5nW107IC8vIElEcyBvZiBzY2VuZXMgaXQgaGFzIGJlYXRlbiBpbiB0aGlzIHJ1blxuICAvLyBQbGFjZW1lbnQgcnVuIHRyYWNraW5nXG4gIHBsYWNlbWVudDogUGxhY2VtZW50UnVuIHwgbnVsbDtcbiAgdG90YWxTY2VuZXNDb3VudDogbnVtYmVyOyAvLyBUb3RhbCBzY2VuZXMgZm9yIHBvc2l0aW9uIGRpc3BsYXlcbiAgbGVmdFBvb2xTaXplOiBudW1iZXIgfCBudWxsOyAvLyBTY2VuZXMgb24gdGhlIFwidG8gcmF0ZVwiIHNpZGUgKGZpbHRlciBvciB3aG9sZSBsaWJyYXJ5KTsgbnVsbCB1bnRpbCBsb2FkZWRcbiAgZGlzYWJsZUNob2ljZTogYm9vbGVhbjsgLy8gUHJldmVudHMgbXVsdGlwbGUgcmFwaWQgY2hvaWNlIGV2ZW50c1xuICBzYXZlZEZpbHRlclBhcmFtczogc3RyaW5nOyAvLyBTdG9yZWQgVVJMIGZpbHRlciBwYXJhbXMgdG8gZGV0ZWN0IGNoYW5nZXNcbiAgLy8gVXNlciBzZXR0aW5ncyAoZGVmYXVsdHMgdW50aWwgbG9hZFNldHRpbmdzKCkgcmVzb2x2ZXMpXG4gIHNldHRpbmdzOiBTZXR0aW5ncztcbiAgcmVzZXR0aW5nRWxvOiBib29sZWFuOyAvLyBSZXNldCBFTE8ncyBzZXR1cCBzY3JlZW4gaXMgc2hvd2luZyAoYmF0dGxlcyB3YWl0LCBsaWtlIGEgZmlyc3Qgc2V0dXApXG4gIC8vIFNodWZmbGUgc3RhdGUgZm9yIHRoZSBsZWZ0LXNpZGUgcG9vbCAocHJldmVudHMgcmVwZWF0cyB3aGVuIHNraXBwaW5nKVxuICBzaHVmZmxlZEZpbHRlcmVkU2NlbmVzOiBTY2VuZVtdO1xuICBzaHVmZmxlSW5kZXg6IG51bWJlcjtcbiAgc2h1ZmZsZUZpbHRlcktleTogc3RyaW5nIHwgbnVsbDtcbiAgLy8gU2NlbmUgY2FjaGUgKG1lbW9yeSB0aWVyKVxuICBtZW1vcnlDYWNoZTogTWVtb3J5Q2FjaGU7XG59XG5cbmV4cG9ydCBjb25zdCBzdGF0ZTogQmF0dGxlU3RhdGUgPSB7XG4gIGN1cnJlbnRQYWlyOiB7IGxlZnQ6IG51bGwsIHJpZ2h0OiBudWxsIH0sXG4gIGN1cnJlbnRSYW5rczogeyBsZWZ0OiBudWxsLCByaWdodDogbnVsbCB9LFxuICBjdXJyZW50TW9kZTogXCJzd2lzc1wiLFxuICBjaGFtcGlvblNjZW5lOiBudWxsLFxuICBjaGFtcGlvbldpbnM6IDAsXG4gIGNoYW1waW9uRGVmZWF0ZWQ6IFtdLFxuICBwbGFjZW1lbnQ6IG51bGwsXG4gIHRvdGFsU2NlbmVzQ291bnQ6IDAsXG4gIGxlZnRQb29sU2l6ZTogbnVsbCxcbiAgZGlzYWJsZUNob2ljZTogZmFsc2UsXG4gIHNhdmVkRmlsdGVyUGFyYW1zOiBcIlwiLFxuICBzZXR0aW5nczogeyAuLi5ERUZBVUxUX1NFVFRJTkdTIH0sXG4gIHJlc2V0dGluZ0VsbzogZmFsc2UsXG4gIHNodWZmbGVkRmlsdGVyZWRTY2VuZXM6IFtdLFxuICBzaHVmZmxlSW5kZXg6IDAsXG4gIHNodWZmbGVGaWx0ZXJLZXk6IG51bGwsXG4gIG1lbW9yeUNhY2hlOiB7XG4gICAgYWxsU2NlbmVzOiBudWxsLFxuICAgIGZpbHRlcmVkU2NlbmVzOiBudWxsLFxuICAgIGZpbHRlcktleTogbnVsbCxcbiAgICB0aW1lc3RhbXA6IG51bGwsXG4gIH0sXG59O1xuXG4vKiogQ2xlYXIgYW55IENoYW1waW9uIC8gUGxhY2VtZW50IHJ1biBpbiBwcm9ncmVzcy4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZXNldFJ1blN0YXRlKCk6IHZvaWQge1xuICBzdGF0ZS5jaGFtcGlvblNjZW5lID0gbnVsbDtcbiAgc3RhdGUuY2hhbXBpb25XaW5zID0gMDtcbiAgc3RhdGUuY2hhbXBpb25EZWZlYXRlZCA9IFtdO1xuICBzdGF0ZS5wbGFjZW1lbnQgPSBudWxsO1xufVxuXG4vKiogRm9yZ2V0IHRoZSBsZWZ0LXNpZGUgc2h1ZmZsZSBzbyB0aGUgbmV4dCBwaWNrIHJlc2h1ZmZsZXMgZnJvbSBhIGZyZXNoIHBvb2wuICovXG5leHBvcnQgZnVuY3Rpb24gcmVzZXRTaHVmZmxlKCk6IHZvaWQge1xuICBzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzID0gW107XG4gIHN0YXRlLnNodWZmbGVJbmRleCA9IDA7XG4gIHN0YXRlLnNodWZmbGVGaWx0ZXJLZXkgPSBudWxsO1xufVxuXG4vKiogVHJ1ZSB3aGlsZSBhIENoYW1waW9uIC8gUGxhY2VtZW50IHJ1biBpcyB1bmRlciB3YXkgKHNraXAgaXMgZGlzYWJsZWQpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzUnVuQWN0aXZlKCk6IGJvb2xlYW4ge1xuICBzd2l0Y2ggKHN0YXRlLmN1cnJlbnRNb2RlKSB7XG4gICAgY2FzZSBcImNoYW1waW9uXCI6XG4gICAgICByZXR1cm4gc3RhdGUuY2hhbXBpb25TY2VuZSAhPT0gbnVsbDtcbiAgICBjYXNlIFwicGxhY2VtZW50XCI6XG4gICAgICByZXR1cm4gKHN0YXRlLnBsYWNlbWVudD8uYmF0dGxlcyA/PyAwKSA+IDA7XG4gICAgZGVmYXVsdDpcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuXG4vKiogRUxPIHNldHVwIGhhc24ndCBmaW5pc2hlZCAob3IgUmVzZXQgRUxPIGlzIHNob3dpbmcgaXQpLCBzbyBpdCBzaG93cyBpbnN0ZWFkIG9mIGxvYWRpbmcgcGFpcnMuICovXG5leHBvcnQgZnVuY3Rpb24gaXNFbG9TZXR1cFBlbmRpbmcoKTogYm9vbGVhbiB7XG4gIHJldHVybiAhc3RhdGUuc2V0dGluZ3MuZWxvU2V0dXBBdCB8fCBzdGF0ZS5yZXNldHRpbmdFbG87XG59XG4iLCAiLy8gU2NlbmUgY2FjaGU6IEluZGV4ZWREQiAoZHVyYWJsZSkgKyBpbi1tZW1vcnkgKHBlciBzZXNzaW9uKSwgc3RhbGUtd2hpbGUtcmV2YWxpZGF0ZS5cblxuaW1wb3J0IHtcbiAgQ0FDSEVfREJfTkFNRSxcbiAgQ0FDSEVfREJfVkVSU0lPTixcbiAgQ0FDSEVfTUFYX0FHRV9NUyxcbiAgQ0FDSEVfU1RPUkVfTkFNRSxcbn0gZnJvbSBcIi4vY29uc3RhbnRzXCI7XG5pbXBvcnQgeyBnZXRGaW5kRmlsdGVyLCB0eXBlIExpc3RGaWx0ZXJzIH0gZnJvbSBcIi4vZmlsdGVyc1wiO1xuaW1wb3J0IHsgRklORF9TQ0VORVNfUVVFUlksIGdyYXBocWxRdWVyeSB9IGZyb20gXCIuL2dyYXBocWxcIjtcbmltcG9ydCB7IGVsb0ZpZWxkcywgZWxvSW5zZXJ0aW9uSW5kZXgsIHNvcnRCeUVsbywgd2l0aEVsb0ZpZWxkcyB9IGZyb20gXCIuL3Njb3JlXCI7XG5pbXBvcnQgeyBzdGF0ZSB9IGZyb20gXCIuL3N0YXRlXCI7XG5pbXBvcnQgdHlwZSB7IENhY2hlRW50cnksIEVsb0ZpZWxkcywgRmluZFNjZW5lc1Jlc3VsdCwgU2NlbmUgfSBmcm9tIFwiLi90eXBlc1wiO1xuXG4vLyBPcGVuIEluZGV4ZWREQiBkYXRhYmFzZVxuZnVuY3Rpb24gb3BlbkNhY2hlREIoKTogUHJvbWlzZTxJREJEYXRhYmFzZT4ge1xuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgIGNvbnN0IHJlcXVlc3QgPSBpbmRleGVkREIub3BlbihDQUNIRV9EQl9OQU1FLCBDQUNIRV9EQl9WRVJTSU9OKTtcblxuICAgIHJlcXVlc3Qub25lcnJvciA9ICgpID0+IHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoXCJbU3Rhc2ggQmF0dGxlXSBJbmRleGVkREIgZXJyb3I6XCIsIHJlcXVlc3QuZXJyb3IpO1xuICAgICAgcmVqZWN0KHJlcXVlc3QuZXJyb3IpO1xuICAgIH07XG5cbiAgICByZXF1ZXN0Lm9uc3VjY2VzcyA9ICgpID0+IHtcbiAgICAgIHJlc29sdmUocmVxdWVzdC5yZXN1bHQpO1xuICAgIH07XG5cbiAgICByZXF1ZXN0Lm9udXBncmFkZW5lZWRlZCA9IChldmVudCkgPT4ge1xuICAgICAgY29uc3QgZGIgPSAoZXZlbnQudGFyZ2V0IGFzIElEQk9wZW5EQlJlcXVlc3QpLnJlc3VsdDtcbiAgICAgIC8vIEFueSBvbGRlciBzdG9yZSBob2xkcyBzY2VuZXMgd2l0aG91dCBFTE8gKG9yIGluIHJhdGluZyBvcmRlcik6IHN0YXJ0IGl0IG92ZXJcbiAgICAgIGlmIChkYi5vYmplY3RTdG9yZU5hbWVzLmNvbnRhaW5zKENBQ0hFX1NUT1JFX05BTUUpKSBkYi5kZWxldGVPYmplY3RTdG9yZShDQUNIRV9TVE9SRV9OQU1FKTtcbiAgICAgIGRiLmNyZWF0ZU9iamVjdFN0b3JlKENBQ0hFX1NUT1JFX05BTUUsIHsga2V5UGF0aDogXCJjYWNoZUtleVwiIH0pO1xuICAgIH07XG4gIH0pO1xufVxuXG4vLyBHZXQgY2FjaGVkIHNjZW5lcyBmcm9tIEluZGV4ZWREQlxuYXN5bmMgZnVuY3Rpb24gZ2V0Q2FjaGVkU2NlbmVzKGNhY2hlS2V5OiBzdHJpbmcpOiBQcm9taXNlPENhY2hlRW50cnkgfCBudWxsPiB7XG4gIHRyeSB7XG4gICAgY29uc3QgZGIgPSBhd2FpdCBvcGVuQ2FjaGVEQigpO1xuICAgIHJldHVybiBuZXcgUHJvbWlzZTxDYWNoZUVudHJ5IHwgbnVsbD4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgY29uc3QgdHJhbnNhY3Rpb24gPSBkYi50cmFuc2FjdGlvbihDQUNIRV9TVE9SRV9OQU1FLCBcInJlYWRvbmx5XCIpO1xuICAgICAgY29uc3Qgc3RvcmUgPSB0cmFuc2FjdGlvbi5vYmplY3RTdG9yZShDQUNIRV9TVE9SRV9OQU1FKTtcbiAgICAgIGNvbnN0IHJlcXVlc3QgPSBzdG9yZS5nZXQoY2FjaGVLZXkpO1xuXG4gICAgICByZXF1ZXN0Lm9uc3VjY2VzcyA9ICgpID0+IHtcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gcmVxdWVzdC5yZXN1bHQgYXMgQ2FjaGVFbnRyeSB8IHVuZGVmaW5lZDtcbiAgICAgICAgaWYgKHJlc3VsdCAmJiBEYXRlLm5vdygpIC0gcmVzdWx0LnRpbWVzdGFtcCA8IENBQ0hFX01BWF9BR0VfTVMpIHtcbiAgICAgICAgICByZXNvbHZlKHJlc3VsdCk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgcmVzb2x2ZShudWxsKTsgLy8gQ2FjaGUgbWlzcyBvciBleHBpcmVkXG4gICAgICAgIH1cbiAgICAgIH07XG5cbiAgICAgIHJlcXVlc3Qub25lcnJvciA9ICgpID0+IHJlamVjdChyZXF1ZXN0LmVycm9yKTtcbiAgICAgIHRyYW5zYWN0aW9uLm9uY29tcGxldGUgPSAoKSA9PiBkYi5jbG9zZSgpO1xuICAgIH0pO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIENhY2hlIHJlYWQgZXJyb3I6XCIsIGUpO1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8vIFN0b3JlIHNjZW5lcyBpbiBJbmRleGVkREJcbmFzeW5jIGZ1bmN0aW9uIHNldENhY2hlZFNjZW5lcyhcbiAgY2FjaGVLZXk6IHN0cmluZyxcbiAgc2NlbmVzOiBTY2VuZVtdLFxuICBjb3VudDogbnVtYmVyLFxuICBmaWx0ZXJLZXk/OiBzdHJpbmcsXG4gIHRpbWVzdGFtcDogbnVtYmVyID0gRGF0ZS5ub3coKSxcbik6IFByb21pc2U8dm9pZD4ge1xuICB0cnkge1xuICAgIGNvbnN0IGRiID0gYXdhaXQgb3BlbkNhY2hlREIoKTtcbiAgICByZXR1cm4gbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgY29uc3QgdHJhbnNhY3Rpb24gPSBkYi50cmFuc2FjdGlvbihDQUNIRV9TVE9SRV9OQU1FLCBcInJlYWR3cml0ZVwiKTtcbiAgICAgIGNvbnN0IHN0b3JlID0gdHJhbnNhY3Rpb24ub2JqZWN0U3RvcmUoQ0FDSEVfU1RPUkVfTkFNRSk7XG5cbiAgICAgIGNvbnN0IGRhdGE6IENhY2hlRW50cnkgPSB7XG4gICAgICAgIGNhY2hlS2V5LFxuICAgICAgICBzY2VuZXMsXG4gICAgICAgIGNvdW50LFxuICAgICAgICB0aW1lc3RhbXAsXG4gICAgICAgIC4uLihmaWx0ZXJLZXkgIT09IHVuZGVmaW5lZCAmJiB7IGZpbHRlcktleSB9KSxcbiAgICAgIH07XG5cbiAgICAgIGNvbnN0IHJlcXVlc3QgPSBzdG9yZS5wdXQoZGF0YSk7XG4gICAgICByZXF1ZXN0Lm9uc3VjY2VzcyA9ICgpID0+IHJlc29sdmUoKTtcbiAgICAgIHJlcXVlc3Qub25lcnJvciA9ICgpID0+IHJlamVjdChyZXF1ZXN0LmVycm9yKTtcbiAgICAgIHRyYW5zYWN0aW9uLm9uY29tcGxldGUgPSAoKSA9PiBkYi5jbG9zZSgpO1xuICAgIH0pO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIENhY2hlIHdyaXRlIGVycm9yOlwiLCBlKTtcbiAgfVxufVxuXG4vLyBDbGVhciBhbGwgY2FjaGVkIHNjZW5lcyAoZm9yIG1hbnVhbCByZWZyZXNoKVxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNsZWFyU2NlbmVDYWNoZSgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgdHJ5IHtcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCfl5HvuI8gQ2xlYXJpbmcgYWxsIHNjZW5lIGNhY2hlcy4uLlwiKTtcbiAgICBjb25zdCBkYiA9IGF3YWl0IG9wZW5DYWNoZURCKCk7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgIGNvbnN0IHRyYW5zYWN0aW9uID0gZGIudHJhbnNhY3Rpb24oQ0FDSEVfU1RPUkVfTkFNRSwgXCJyZWFkd3JpdGVcIik7XG4gICAgICBjb25zdCBzdG9yZSA9IHRyYW5zYWN0aW9uLm9iamVjdFN0b3JlKENBQ0hFX1NUT1JFX05BTUUpO1xuICAgICAgY29uc3QgcmVxdWVzdCA9IHN0b3JlLmNsZWFyKCk7XG5cbiAgICAgIHJlcXVlc3Qub25zdWNjZXNzID0gKCkgPT4ge1xuICAgICAgICBzdGF0ZS5tZW1vcnlDYWNoZSA9IHsgYWxsU2NlbmVzOiBudWxsLCBmaWx0ZXJlZFNjZW5lczogbnVsbCwgZmlsdGVyS2V5OiBudWxsLCB0aW1lc3RhbXA6IG51bGwgfTtcbiAgICAgICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDinIUgQWxsIGNhY2hlcyBjbGVhcmVkIChtZW1vcnkgKyBJbmRleGVkREIpXCIpO1xuICAgICAgICByZXNvbHZlKCk7XG4gICAgICB9O1xuICAgICAgcmVxdWVzdC5vbmVycm9yID0gKCkgPT4gcmVqZWN0KHJlcXVlc3QuZXJyb3IpO1xuICAgICAgdHJhbnNhY3Rpb24ub25jb21wbGV0ZSA9ICgpID0+IGRiLmNsb3NlKCk7XG4gICAgfSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0g4p2MIENhY2hlIGNsZWFyIGVycm9yOlwiLCBlKTtcbiAgfVxufVxuXG4vLyBDbGVhciBqdXN0IHRoZSBmaWx0ZXJlZCBzY2VuZXMgY2FjaGUgKGZvciBhdXRvLXJlZnJlc2ggYWZ0ZXIgcG9vbCBleGhhdXN0aW9uKVxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNsZWFyRmlsdGVyZWRDYWNoZSgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBkYiA9IGF3YWl0IG9wZW5DYWNoZURCKCk7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgIGNvbnN0IHRyYW5zYWN0aW9uID0gZGIudHJhbnNhY3Rpb24oQ0FDSEVfU1RPUkVfTkFNRSwgXCJyZWFkd3JpdGVcIik7XG4gICAgICBjb25zdCBzdG9yZSA9IHRyYW5zYWN0aW9uLm9iamVjdFN0b3JlKENBQ0hFX1NUT1JFX05BTUUpO1xuICAgICAgY29uc3QgcmVxdWVzdCA9IHN0b3JlLmRlbGV0ZShcImZpbHRlcmVkLXNjZW5lc1wiKTtcblxuICAgICAgcmVxdWVzdC5vbnN1Y2Nlc3MgPSAoKSA9PiB7XG4gICAgICAgIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzID0gbnVsbDtcbiAgICAgICAgc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyS2V5ID0gbnVsbDtcbiAgICAgICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5eR77iPIEZpbHRlcmVkIGNhY2hlIGNsZWFyZWQgKG1lbW9yeSArIEluZGV4ZWREQilcIik7XG4gICAgICAgIHJlc29sdmUoKTtcbiAgICAgIH07XG4gICAgICByZXF1ZXN0Lm9uZXJyb3IgPSAoKSA9PiByZWplY3QocmVxdWVzdC5lcnJvcik7XG4gICAgICB0cmFuc2FjdGlvbi5vbmNvbXBsZXRlID0gKCkgPT4gZGIuY2xvc2UoKTtcbiAgICB9KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnNvbGUuZXJyb3IoXCJbU3Rhc2ggQmF0dGxlXSDinYwgRmlsdGVyZWQgY2FjaGUgY2xlYXIgZXJyb3I6XCIsIGUpO1xuICAgIC8vIFN0aWxsIGNsZWFyIG1lbW9yeSBjYWNoZSBldmVuIGlmIEluZGV4ZWREQiBmYWlsc1xuICAgIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzID0gbnVsbDtcbiAgICBzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJLZXkgPSBudWxsO1xuICB9XG59XG5cbi8vIEJhY2tncm91bmQgcmVmcmVzaCAtIGZldGNoIGZyb20gbmV0d29yayBhbmQgdXBkYXRlIGNhY2hlcyBzaWxlbnRseVxuYXN5bmMgZnVuY3Rpb24gYmFja2dyb3VuZFJlZnJlc2hBbGxTY2VuZXMoKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGNhY2hlS2V5ID0gXCJhbGwtc2NlbmVzXCI7XG5cbiAgdHJ5IHtcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCflIQgQmFja2dyb3VuZCByZWZyZXNoIHN0YXJ0ZWQgKGFsbCBzY2VuZXMpLi4uXCIpO1xuICAgIGNvbnN0IHN0YXJ0VGltZSA9IERhdGUubm93KCk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBncmFwaHFsUXVlcnk8RmluZFNjZW5lc1Jlc3VsdD4oRklORF9TQ0VORVNfUVVFUlksIHtcbiAgICAgIGZpbHRlcjoge1xuICAgICAgICBwZXJfcGFnZTogLTEsXG4gICAgICAgIHNvcnQ6IFwicmF0aW5nXCIsXG4gICAgICAgIGRpcmVjdGlvbjogXCJERVNDXCIsXG4gICAgICB9LFxuICAgICAgc2NlbmVfZmlsdGVyOiBudWxsLFxuICAgIH0pO1xuXG4gICAgY29uc3Qgc2NlbmVzID0gc29ydEJ5RWxvKHJlc3VsdC5maW5kU2NlbmVzLnNjZW5lcyB8fCBbXSk7XG4gICAgY29uc3QgY291bnQgPSByZXN1bHQuZmluZFNjZW5lcy5jb3VudCB8fCBzY2VuZXMubGVuZ3RoO1xuICAgIGNvbnN0IGZldGNoVGltZSA9IERhdGUubm93KCkgLSBzdGFydFRpbWU7XG5cbiAgICBjb25zdCBvbGRDb3VudCA9IHN0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcyA/IHN0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcy5sZW5ndGggOiAwO1xuICAgIGlmIChjb3VudCAhPT0gb2xkQ291bnQpIHtcbiAgICAgIGNvbnNvbGUubG9nKFxuICAgICAgICBgW1N0YXNoIEJhdHRsZV0g8J+TiiBTY2VuZSBjb3VudCBjaGFuZ2VkOiAke29sZENvdW50fSDihpIgJHtjb3VudH0gKCR7Y291bnQgPiBvbGRDb3VudCA/IFwiK1wiIDogXCJcIn0ke2NvdW50IC0gb2xkQ291bnR9KWAsXG4gICAgICApO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g8J+TiiBTY2VuZSBjb3VudCB1bmNoYW5nZWQ6ICR7Y291bnR9YCk7XG4gICAgfVxuXG4gICAgc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzID0gc2NlbmVzO1xuICAgIHN0YXRlLm1lbW9yeUNhY2hlLnRpbWVzdGFtcCA9IERhdGUubm93KCk7XG4gICAgYXdhaXQgc2V0Q2FjaGVkU2NlbmVzKGNhY2hlS2V5LCBzY2VuZXMsIGNvdW50KTtcblxuICAgIGNvbnNvbGUubG9nKGBbU3Rhc2ggQmF0dGxlXSDinIUgQmFja2dyb3VuZCByZWZyZXNoIGNvbXBsZXRlOiAke3NjZW5lcy5sZW5ndGh9IHNjZW5lcyBpbiAke2ZldGNoVGltZX1tc2ApO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIOKdjCBCYWNrZ3JvdW5kIHJlZnJlc2ggZmFpbGVkOlwiLCBlKTtcbiAgfVxufVxuXG4vLyBHZXQgYWxsIHNjZW5lcyAodXNlcyBjYWNoZSB3aXRoIHN0YWxlLXdoaWxlLXJldmFsaWRhdGUpXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ2V0QWxsU2NlbmVzQ2FjaGVkKCk6IFByb21pc2U8eyBzY2VuZXM6IFNjZW5lW107IGNvdW50OiBudW1iZXIgfT4ge1xuICBjb25zdCBjYWNoZUtleSA9IFwiYWxsLXNjZW5lc1wiO1xuXG4gIC8vIENoZWNrIG1lbW9yeSBjYWNoZSBmaXJzdCAtIHJldHVybiBpbW1lZGlhdGVseSBpZiBhdmFpbGFibGVcbiAgaWYgKHN0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcykge1xuICAgIGNvbnN0IGNhY2hlQWdlID0gTWF0aC5yb3VuZCgoRGF0ZS5ub3coKSAtIChzdGF0ZS5tZW1vcnlDYWNoZS50aW1lc3RhbXAgPz8gMCkpIC8gMTAwMCk7XG4gICAgY29uc3QgaXNTdGFsZSA9IERhdGUubm93KCkgLSAoc3RhdGUubWVtb3J5Q2FjaGUudGltZXN0YW1wID8/IDApID49IENBQ0hFX01BWF9BR0VfTVM7XG5cbiAgICBjb25zb2xlLmxvZyhcbiAgICAgIGBbU3Rhc2ggQmF0dGxlXSDwn5K+IE1lbW9yeSBjYWNoZSBoaXQgKGFsbCBzY2VuZXMpOiAke3N0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcy5sZW5ndGh9IHNjZW5lcywgYWdlOiAke2NhY2hlQWdlfXMke2lzU3RhbGUgPyBcIiBbU1RBTEVdXCIgOiBcIlwifWAsXG4gICAgKTtcblxuICAgIGlmIChpc1N0YWxlKSB7XG4gICAgICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g4o+wIENhY2hlIHN0YWxlICg+JHtDQUNIRV9NQVhfQUdFX01TIC8gMTAwMH1zKSwgdHJpZ2dlcmluZyBiYWNrZ3JvdW5kIHJlZnJlc2guLi5gKTtcbiAgICAgIGJhY2tncm91bmRSZWZyZXNoQWxsU2NlbmVzKCk7IC8vIERvbid0IGF3YWl0IC0gcnVucyBpbiBiYWNrZ3JvdW5kXG4gICAgfVxuICAgIHJldHVybiB7IHNjZW5lczogc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzLCBjb3VudDogc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzLmxlbmd0aCB9O1xuICB9XG5cbiAgLy8gQ2hlY2sgSW5kZXhlZERCIGNhY2hlIC0gcmV0dXJuIGltbWVkaWF0ZWx5IGlmIGF2YWlsYWJsZVxuICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCflI0gTWVtb3J5IGNhY2hlIG1pc3MsIGNoZWNraW5nIEluZGV4ZWREQi4uLlwiKTtcbiAgY29uc3QgY2FjaGVkID0gYXdhaXQgZ2V0Q2FjaGVkU2NlbmVzKGNhY2hlS2V5KTtcbiAgaWYgKGNhY2hlZCkge1xuICAgIGNvbnN0IGNhY2hlQWdlID0gTWF0aC5yb3VuZCgoRGF0ZS5ub3coKSAtIGNhY2hlZC50aW1lc3RhbXApIC8gMTAwMCk7XG4gICAgY29uc3QgaXNTdGFsZSA9IERhdGUubm93KCkgLSBjYWNoZWQudGltZXN0YW1wID49IENBQ0hFX01BWF9BR0VfTVM7XG5cbiAgICBjb25zb2xlLmxvZyhcbiAgICAgIGBbU3Rhc2ggQmF0dGxlXSDwn5K/IEluZGV4ZWREQiBjYWNoZSBoaXQgKGFsbCBzY2VuZXMpOiAke2NhY2hlZC5zY2VuZXMubGVuZ3RofSBzY2VuZXMsIGFnZTogJHtjYWNoZUFnZX1zJHtpc1N0YWxlID8gXCIgW1NUQUxFXVwiIDogXCJcIn1gLFxuICAgICk7XG5cbiAgICBzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXMgPSBjYWNoZWQuc2NlbmVzO1xuICAgIHN0YXRlLm1lbW9yeUNhY2hlLnRpbWVzdGFtcCA9IGNhY2hlZC50aW1lc3RhbXA7XG5cbiAgICBpZiAoaXNTdGFsZSkge1xuICAgICAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIOKPsCBDYWNoZSBzdGFsZSAoPiR7Q0FDSEVfTUFYX0FHRV9NUyAvIDEwMDB9cyksIHRyaWdnZXJpbmcgYmFja2dyb3VuZCByZWZyZXNoLi4uYCk7XG4gICAgICBiYWNrZ3JvdW5kUmVmcmVzaEFsbFNjZW5lcygpOyAvLyBEb24ndCBhd2FpdCAtIHJ1bnMgaW4gYmFja2dyb3VuZFxuICAgIH1cbiAgICByZXR1cm4geyBzY2VuZXM6IGNhY2hlZC5zY2VuZXMsIGNvdW50OiBjYWNoZWQuY291bnQgfTtcbiAgfVxuXG4gIC8vIE5vIGNhY2hlIGF0IGFsbCAtIG11c3QgZmV0Y2ggZnJvbSBuZXR3b3JrIChibG9ja2luZylcbiAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn4yQIE5vIGNhY2hlIGZvdW5kLCBmZXRjaGluZyBhbGwgc2NlbmVzIGZyb20gbmV0d29yayAoZmlyc3QgbG9hZCkuLi5cIik7XG4gIGNvbnN0IHN0YXJ0VGltZSA9IERhdGUubm93KCk7XG5cbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZ3JhcGhxbFF1ZXJ5PEZpbmRTY2VuZXNSZXN1bHQ+KEZJTkRfU0NFTkVTX1FVRVJZLCB7XG4gICAgZmlsdGVyOiB7XG4gICAgICBwZXJfcGFnZTogLTEsXG4gICAgICBzb3J0OiBcInJhdGluZ1wiLFxuICAgICAgZGlyZWN0aW9uOiBcIkRFU0NcIixcbiAgICB9LFxuICAgIHNjZW5lX2ZpbHRlcjogbnVsbCxcbiAgfSk7XG5cbiAgY29uc3Qgc2NlbmVzID0gc29ydEJ5RWxvKHJlc3VsdC5maW5kU2NlbmVzLnNjZW5lcyB8fCBbXSk7XG4gIGNvbnN0IGNvdW50ID0gcmVzdWx0LmZpbmRTY2VuZXMuY291bnQgfHwgc2NlbmVzLmxlbmd0aDtcbiAgY29uc3QgZmV0Y2hUaW1lID0gRGF0ZS5ub3coKSAtIHN0YXJ0VGltZTtcblxuICBzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXMgPSBzY2VuZXM7XG4gIHN0YXRlLm1lbW9yeUNhY2hlLnRpbWVzdGFtcCA9IERhdGUubm93KCk7XG4gIGF3YWl0IHNldENhY2hlZFNjZW5lcyhjYWNoZUtleSwgc2NlbmVzLCBjb3VudCk7XG5cbiAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIOKchSBGZXRjaGVkIGFuZCBjYWNoZWQgJHtzY2VuZXMubGVuZ3RofSBzY2VuZXMgaW4gJHtmZXRjaFRpbWV9bXNgKTtcbiAgcmV0dXJuIHsgc2NlbmVzLCBjb3VudCB9O1xufVxuXG4vLyBCYWNrZ3JvdW5kIHJlZnJlc2ggZm9yIGZpbHRlcmVkIHNjZW5lc1xuYXN5bmMgZnVuY3Rpb24gYmFja2dyb3VuZFJlZnJlc2hGaWx0ZXJlZFNjZW5lcyhmaWx0ZXJzOiBMaXN0RmlsdGVycyk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBjYWNoZUtleSA9IFwiZmlsdGVyZWQtc2NlbmVzXCI7XG5cbiAgdHJ5IHtcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCflIQgQmFja2dyb3VuZCByZWZyZXNoIHN0YXJ0ZWQgKGZpbHRlcmVkIHNjZW5lcykuLi5cIik7XG4gICAgY29uc3Qgc3RhcnRUaW1lID0gRGF0ZS5ub3coKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGdyYXBocWxRdWVyeTxGaW5kU2NlbmVzUmVzdWx0PihGSU5EX1NDRU5FU19RVUVSWSwge1xuICAgICAgZmlsdGVyOiBnZXRGaW5kRmlsdGVyKHtcbiAgICAgICAgcGVyX3BhZ2U6IC0xLFxuICAgICAgICBzb3J0OiBcInJhdGluZ1wiLFxuICAgICAgICBkaXJlY3Rpb246IFwiREVTQ1wiLFxuICAgICAgfSksXG4gICAgICBzY2VuZV9maWx0ZXI6IGZpbHRlcnMuc2NlbmVGaWx0ZXIsXG4gICAgfSk7XG5cbiAgICBjb25zdCBzY2VuZXMgPSBzb3J0QnlFbG8ocmVzdWx0LmZpbmRTY2VuZXMuc2NlbmVzIHx8IFtdKTtcbiAgICBjb25zdCBjb3VudCA9IHJlc3VsdC5maW5kU2NlbmVzLmNvdW50IHx8IHNjZW5lcy5sZW5ndGg7XG4gICAgY29uc3QgZmV0Y2hUaW1lID0gRGF0ZS5ub3coKSAtIHN0YXJ0VGltZTtcblxuICAgIC8vIE9ubHkgdXBkYXRlIGlmIHN0aWxsIG9uIHNhbWUgZmlsdGVyXG4gICAgaWYgKHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcktleSA9PT0gZmlsdGVycy5maWx0ZXJLZXkpIHtcbiAgICAgIGNvbnN0IG9sZENvdW50ID0gc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXMgPyBzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJlZFNjZW5lcy5sZW5ndGggOiAwO1xuICAgICAgaWYgKGNvdW50ICE9PSBvbGRDb3VudCkge1xuICAgICAgICBjb25zb2xlLmxvZyhcbiAgICAgICAgICBgW1N0YXNoIEJhdHRsZV0g8J+TiiBGaWx0ZXJlZCBjb3VudCBjaGFuZ2VkOiAke29sZENvdW50fSDihpIgJHtjb3VudH0gKCR7Y291bnQgPiBvbGRDb3VudCA/IFwiK1wiIDogXCJcIn0ke2NvdW50IC0gb2xkQ291bnR9KWAsXG4gICAgICAgICk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g8J+TiiBGaWx0ZXJlZCBjb3VudCB1bmNoYW5nZWQ6ICR7Y291bnR9YCk7XG4gICAgICB9XG5cbiAgICAgIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzID0gc2NlbmVzO1xuICAgICAgc3RhdGUubWVtb3J5Q2FjaGUudGltZXN0YW1wID0gRGF0ZS5ub3coKTtcbiAgICAgIGF3YWl0IHNldENhY2hlZFNjZW5lcyhjYWNoZUtleSwgc2NlbmVzLCBjb3VudCwgZmlsdGVycy5maWx0ZXJLZXkpO1xuXG4gICAgICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g4pyFIEJhY2tncm91bmQgcmVmcmVzaCBjb21wbGV0ZTogJHtzY2VuZXMubGVuZ3RofSBmaWx0ZXJlZCBzY2VuZXMgaW4gJHtmZXRjaFRpbWV9bXNgKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDimqDvuI8gRmlsdGVyIGNoYW5nZWQgZHVyaW5nIHJlZnJlc2gsIGRpc2NhcmRpbmcgcmVzdWx0c1wiKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0g4p2MIEJhY2tncm91bmQgcmVmcmVzaCAoZmlsdGVyZWQpIGZhaWxlZDpcIiwgZSk7XG4gIH1cbn1cblxuLy8gR2V0IGZpbHRlcmVkIHNjZW5lcyAodXNlcyBjYWNoZSB3aXRoIHN0YWxlLXdoaWxlLXJldmFsaWRhdGUpXG4vLyBOT1RFOiBPbmx5IE9ORSBmaWx0ZXJlZCBjYWNoZSBpcyBrZXB0IChvdmVyd3JpdGVzIHByZXZpb3VzIGZpbHRlciBjYWNoZSB0byBwcmV2ZW50IEluZGV4ZWREQiBibG9hdClcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXRGaWx0ZXJlZFNjZW5lc0NhY2hlZChcbiAgZmlsdGVyczogTGlzdEZpbHRlcnMsXG4pOiBQcm9taXNlPHsgc2NlbmVzOiBTY2VuZVtdOyBjb3VudDogbnVtYmVyIH0+IHtcbiAgY29uc3QgeyBmaWx0ZXJLZXksIHNjZW5lRmlsdGVyIH0gPSBmaWx0ZXJzO1xuICBjb25zdCBjYWNoZUtleSA9IFwiZmlsdGVyZWQtc2NlbmVzXCI7IC8vIFNpbmdsZSBrZXkgLSBvdmVyd3JpdGVzIHByZXZpb3VzIGZpbHRlciBjYWNoZVxuXG4gIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+UjiBGaWx0ZXIgYWN0aXZlLCBjaGVja2luZyBmaWx0ZXJlZCBjYWNoZS4uLlwiKTtcblxuICAvLyBDaGVjayBtZW1vcnkgY2FjaGUgZmlyc3QgLSByZXR1cm4gaW1tZWRpYXRlbHkgaWYgYXZhaWxhYmxlIGFuZCBzYW1lIGZpbHRlclxuICBpZiAoc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXMgJiYgc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyS2V5ID09PSBmaWx0ZXJLZXkpIHtcbiAgICBjb25zdCBjYWNoZUFnZSA9IE1hdGgucm91bmQoKERhdGUubm93KCkgLSAoc3RhdGUubWVtb3J5Q2FjaGUudGltZXN0YW1wID8/IDApKSAvIDEwMDApO1xuICAgIGNvbnN0IGlzU3RhbGUgPSBEYXRlLm5vdygpIC0gKHN0YXRlLm1lbW9yeUNhY2hlLnRpbWVzdGFtcCA/PyAwKSA+PSBDQUNIRV9NQVhfQUdFX01TO1xuXG4gICAgY29uc29sZS5sb2coXG4gICAgICBgW1N0YXNoIEJhdHRsZV0g8J+SviBNZW1vcnkgY2FjaGUgaGl0IChmaWx0ZXJlZCk6ICR7c3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXMubGVuZ3RofSBzY2VuZXMsIGFnZTogJHtjYWNoZUFnZX1zJHtpc1N0YWxlID8gXCIgW1NUQUxFXVwiIDogXCJcIn1gLFxuICAgICk7XG5cbiAgICBpZiAoaXNTdGFsZSkge1xuICAgICAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIOKPsCBDYWNoZSBzdGFsZSAoPiR7Q0FDSEVfTUFYX0FHRV9NUyAvIDEwMDB9cyksIHRyaWdnZXJpbmcgYmFja2dyb3VuZCByZWZyZXNoLi4uYCk7XG4gICAgICBiYWNrZ3JvdW5kUmVmcmVzaEZpbHRlcmVkU2NlbmVzKGZpbHRlcnMpO1xuICAgIH1cbiAgICByZXR1cm4geyBzY2VuZXM6IHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzLCBjb3VudDogc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXMubGVuZ3RoIH07XG4gIH1cblxuICAvLyBDaGVjayBJbmRleGVkREIgY2FjaGUgKG9ubHkgaWYgZmlsdGVyIGtleSBtYXRjaGVzKVxuICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCflI0gTWVtb3J5IGNhY2hlIG1pc3MgKGZpbHRlcmVkKSwgY2hlY2tpbmcgSW5kZXhlZERCLi4uXCIpO1xuICBjb25zdCBjYWNoZWQgPSBhd2FpdCBnZXRDYWNoZWRTY2VuZXMoY2FjaGVLZXkpO1xuICBpZiAoY2FjaGVkICYmIGNhY2hlZC5maWx0ZXJLZXkgPT09IGZpbHRlcktleSkge1xuICAgIGNvbnN0IGNhY2hlQWdlID0gTWF0aC5yb3VuZCgoRGF0ZS5ub3coKSAtIGNhY2hlZC50aW1lc3RhbXApIC8gMTAwMCk7XG4gICAgY29uc3QgaXNTdGFsZSA9IERhdGUubm93KCkgLSBjYWNoZWQudGltZXN0YW1wID49IENBQ0hFX01BWF9BR0VfTVM7XG5cbiAgICBjb25zb2xlLmxvZyhcbiAgICAgIGBbU3Rhc2ggQmF0dGxlXSDwn5K/IEluZGV4ZWREQiBjYWNoZSBoaXQgKGZpbHRlcmVkKTogJHtjYWNoZWQuc2NlbmVzLmxlbmd0aH0gc2NlbmVzLCBhZ2U6ICR7Y2FjaGVBZ2V9cyR7aXNTdGFsZSA/IFwiIFtTVEFMRV1cIiA6IFwiXCJ9YCxcbiAgICApO1xuXG4gICAgc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXMgPSBjYWNoZWQuc2NlbmVzO1xuICAgIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcktleSA9IGZpbHRlcktleTtcbiAgICBzdGF0ZS5tZW1vcnlDYWNoZS50aW1lc3RhbXAgPSBjYWNoZWQudGltZXN0YW1wO1xuXG4gICAgaWYgKGlzU3RhbGUpIHtcbiAgICAgIGNvbnNvbGUubG9nKGBbU3Rhc2ggQmF0dGxlXSDij7AgQ2FjaGUgc3RhbGUgKD4ke0NBQ0hFX01BWF9BR0VfTVMgLyAxMDAwfXMpLCB0cmlnZ2VyaW5nIGJhY2tncm91bmQgcmVmcmVzaC4uLmApO1xuICAgICAgYmFja2dyb3VuZFJlZnJlc2hGaWx0ZXJlZFNjZW5lcyhmaWx0ZXJzKTtcbiAgICB9XG4gICAgcmV0dXJuIHsgc2NlbmVzOiBjYWNoZWQuc2NlbmVzLCBjb3VudDogY2FjaGVkLmNvdW50IH07XG4gIH1cblxuICBpZiAoY2FjaGVkKSB7XG4gICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5K/IEluZGV4ZWREQiBjYWNoZSBleGlzdHMgYnV0IGZpbHRlciBjaGFuZ2VkLCBmZXRjaGluZyBuZXcgZGF0YS4uLlwiKTtcbiAgfSBlbHNlIHtcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCfkr8gSW5kZXhlZERCIGNhY2hlIG1pc3MgKGZpbHRlcmVkKVwiKTtcbiAgfVxuXG4gIC8vIE5vIG1hdGNoaW5nIGNhY2hlIC0gbXVzdCBmZXRjaCBmcm9tIG5ldHdvcmsgKGJsb2NraW5nKVxuICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCfjJAgRmV0Y2hpbmcgZmlsdGVyZWQgc2NlbmVzIGZyb20gbmV0d29yay4uLlwiKTtcbiAgY29uc3Qgc3RhcnRUaW1lID0gRGF0ZS5ub3coKTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBncmFwaHFsUXVlcnk8RmluZFNjZW5lc1Jlc3VsdD4oRklORF9TQ0VORVNfUVVFUlksIHtcbiAgICBmaWx0ZXI6IGdldEZpbmRGaWx0ZXIoe1xuICAgICAgcGVyX3BhZ2U6IC0xLFxuICAgICAgc29ydDogXCJyYXRpbmdcIixcbiAgICAgIGRpcmVjdGlvbjogXCJERVNDXCIsXG4gICAgfSksXG4gICAgc2NlbmVfZmlsdGVyOiBzY2VuZUZpbHRlcixcbiAgfSk7XG5cbiAgY29uc3Qgc2NlbmVzID0gc29ydEJ5RWxvKHJlc3VsdC5maW5kU2NlbmVzLnNjZW5lcyB8fCBbXSk7XG4gIGNvbnN0IGNvdW50ID0gcmVzdWx0LmZpbmRTY2VuZXMuY291bnQgfHwgc2NlbmVzLmxlbmd0aDtcbiAgY29uc3QgZmV0Y2hUaW1lID0gRGF0ZS5ub3coKSAtIHN0YXJ0VGltZTtcblxuICBzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJlZFNjZW5lcyA9IHNjZW5lcztcbiAgc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyS2V5ID0gZmlsdGVyS2V5O1xuICBzdGF0ZS5tZW1vcnlDYWNoZS50aW1lc3RhbXAgPSBEYXRlLm5vdygpO1xuICBhd2FpdCBzZXRDYWNoZWRTY2VuZXMoY2FjaGVLZXksIHNjZW5lcywgY291bnQsIGZpbHRlcktleSk7XG5cbiAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIOKchSBGZXRjaGVkIGFuZCBjYWNoZWQgJHtzY2VuZXMubGVuZ3RofSBmaWx0ZXJlZCBzY2VuZXMgaW4gJHtmZXRjaFRpbWV9bXNgKTtcbiAgcmV0dXJuIHsgc2NlbmVzLCBjb3VudCB9O1xufVxuXG4vKiogU2V0IChvciB3aXRoIG51bGwsIHJlbW92ZSkgdGhlIEVMTyBmaWVsZHMgb24gb25lIHNjZW5lIG9iamVjdC4gKi9cbmZ1bmN0aW9uIGFwcGx5RWxvKHNjZW5lOiBTY2VuZSwgdmFsdWU6IEVsb0ZpZWxkcyB8IG51bGwpOiB2b2lkIHtcbiAgc2NlbmUuY3VzdG9tX2ZpZWxkcyA9IHdpdGhFbG9GaWVsZHMoc2NlbmUuY3VzdG9tX2ZpZWxkcywgdmFsdWUpO1xufVxuXG4vKipcbiAqIFRoZSBjYWNoZWQgY29weSBvZiBhIHNjZW5lIChhbGwgc2NlbmVzIGZpcnN0LCB0aGVuIHRoZSBmaWx0ZXJlZCBvbmVzKSwgb3IgdGhlIHNjZW5lIGl0c2VsZiBpZlxuICogbmVpdGhlciBoYXMgaXQuIFNjZW5lIG9iamVjdHMgaGVsZCBhY3Jvc3MgYmF0dGxlcyAodGhlIHNodWZmbGUsIGEgc2F2ZWQgcGFpciwgYSBDaGFtcGlvbiBvclxuICogUGxhY2VtZW50IHJ1bikgZ28gc3RhbGUgb25jZSBhIGJhY2tncm91bmQgcmVmcmVzaCBzd2FwcyBpbiBuZXcgY29waWVzLCBzbyBiYXR0bGUgbWF0aCByZWFkc1xuICogRUxPIGFuZCBiYXR0bGVzIGZyb20gdGhpcyBpbnN0ZWFkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbGF0ZXN0U2NlbmUoc2NlbmU6IFNjZW5lKTogU2NlbmUge1xuICByZXR1cm4gKFxuICAgIHN0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcz8uZmluZCgocykgPT4gcy5pZCA9PT0gc2NlbmUuaWQpID8/XG4gICAgc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXM/LmZpbmQoKHMpID0+IHMuaWQgPT09IHNjZW5lLmlkKSA/P1xuICAgIHNjZW5lXG4gICk7XG59XG5cbi8qKlxuICogU2V0IChvciB3aXRoIG51bGwsIHJlbW92ZSkgYSBzY2VuZSdzIEVMTyBvbiBgc2NlbmVgIGl0c2VsZiBhbmQgb24gaXRzIGNhY2hlZCBjb3BpZXMsIGFuZCBtb3ZlXG4gKiB0aGUgY2FjaGVkIGNvcGllcyB0byB0aGVpciBuZXcgcGxhY2UgaW4gdGhlIEVMTyBvcmRlciBzbyByYW5rcyBzdGF5IHJpZ2h0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2V0RWxvSW5DYWNoZShzY2VuZTogU2NlbmUsIHZhbHVlOiBFbG9GaWVsZHMgfCBudWxsKTogdm9pZCB7XG4gIGFwcGx5RWxvKHNjZW5lLCB2YWx1ZSk7XG4gIGZvciAoY29uc3QgcG9vbCBvZiBbc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzLCBzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJlZFNjZW5lc10pIHtcbiAgICBjb25zdCBpZHggPSBwb29sID8gcG9vbC5maW5kSW5kZXgoKHMpID0+IHMuaWQgPT09IHNjZW5lLmlkKSA6IC0xO1xuICAgIGlmICghcG9vbCB8fCBpZHggPT09IC0xKSBjb250aW51ZTtcbiAgICBjb25zdCBbY2FjaGVkXSA9IHBvb2wuc3BsaWNlKGlkeCwgMSk7XG4gICAgaWYgKGNhY2hlZCAhPT0gc2NlbmUpIGFwcGx5RWxvKGNhY2hlZCwgdmFsdWUpO1xuICAgIHBvb2wuc3BsaWNlKHZhbHVlID8gZWxvSW5zZXJ0aW9uSW5kZXgocG9vbCwgdmFsdWUuZWxvKSA6IHBvb2wubGVuZ3RoLCAwLCBjYWNoZWQpO1xuICB9XG4gIHBlcnNpc3RDYWNoZVNvb24oKTtcbn1cblxuLyoqIFNldCB0aGUgU3Rhc2ggcmF0aW5nIG9uIGNhY2hlZCBzY2VuZXMgKGFmdGVyIFN0YXNoIEJhdHRsZSB3cm90ZSB0aGVtKS4gT3JkZXIgaXMgRUxPLCBzbyB1bmNoYW5nZWQuICovXG5leHBvcnQgZnVuY3Rpb24gc2V0UmF0aW5nc0luQ2FjaGUocmF0aW5nczogTWFwPHN0cmluZywgbnVtYmVyPik6IHZvaWQge1xuICBmb3IgKGNvbnN0IHBvb2wgb2YgW3N0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcywgc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXNdKSB7XG4gICAgZm9yIChjb25zdCBzY2VuZSBvZiBwb29sID8/IFtdKSB7XG4gICAgICBjb25zdCByYXRpbmcgPSByYXRpbmdzLmdldChzY2VuZS5pZCk7XG4gICAgICBpZiAocmF0aW5nICE9PSB1bmRlZmluZWQpIHNjZW5lLnJhdGluZzEwMCA9IHJhdGluZztcbiAgICB9XG4gIH1cbiAgcGVyc2lzdENhY2hlU29vbigpO1xufVxuXG4vKipcbiAqIEJyaW5nIGEgc2NlbmUncyBjYWNoZWQgY29waWVzIGluIGxpbmUgd2l0aCBmcmVzaCB2YWx1ZXMgZnJvbSBTdGFzaCAoaXRzIEVMTyBmaWVsZHMgYW5kIFN0YXNoXG4gKiByYXRpbmcpLCBtb3ZpbmcgdGhlbSB0byB0aGVpciBwbGFjZSBpbiB0aGUgRUxPIG9yZGVyLiBGb3Igc2NlbmVzIGZldGNoZWQgb24gdGhlaXIgb3duIChhXG4gKiByZXN0b3JlZCBwYWlyLCBhIHNjZW5lIHBhZ2UgYmF0dGxlKSwgd2hpY2ggbWF5IGJlIG5ld2VyIHRoYW4gdGhlIGNhY2hlOiBjaGFuZ2VkIGluIGFub3RoZXJcbiAqIHRhYiwgc2F5LlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVmcmVzaFNjZW5lSW5DYWNoZShmcmVzaDogU2NlbmUpOiB2b2lkIHtcbiAgZm9yIChjb25zdCBwb29sIG9mIFtzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXMsIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzXSkge1xuICAgIGNvbnN0IGNhY2hlZCA9IHBvb2w/LmZpbmQoKHMpID0+IHMuaWQgPT09IGZyZXNoLmlkKTtcbiAgICBpZiAoY2FjaGVkKSBjYWNoZWQucmF0aW5nMTAwID0gZnJlc2gucmF0aW5nMTAwID8/IG51bGw7XG4gIH1cbiAgc2V0RWxvSW5DYWNoZShmcmVzaCwgZWxvRmllbGRzKGZyZXNoKSk7XG59XG5cbi8qKiBXcml0ZSB0aGUgaW4tbWVtb3J5IHNjZW5lIGxpc3RzIGJhY2sgdG8gSW5kZXhlZERCIHRoaXMgbG9uZyBhZnRlciB0aGUgbGFzdCBjaGFuZ2UuICovXG5jb25zdCBQRVJTSVNUX0RFQk9VTkNFX01TID0gMTAwMDtcbmxldCBwZXJzaXN0VGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XG5cbi8qKlxuICogQmF0dGxlcyBjaGFuZ2UgdGhlIGluLW1lbW9yeSBsaXN0cyBvbmx5OyB3aXRob3V0IHRoaXMsIGEgcmVsb2FkIHdpdGhpbiBDQUNIRV9NQVhfQUdFX01TIHdvdWxkXG4gKiByZWFkIHRoZSBJbmRleGVkREIgY29weSBmcm9tIGJlZm9yZSB0aGVtIChvbGQgRUxPLCBvbGQgb3JkZXIpLiBEZWJvdW5jZWQsIHNvIGEgcGljaydzIHdyaXRlc1xuICogYW5kIGl0cyBTdGFzaCByYXRpbmcgc3luYyBhcmUgc2F2ZWQgdG9nZXRoZXIuXG4gKi9cbmZ1bmN0aW9uIHBlcnNpc3RDYWNoZVNvb24oKTogdm9pZCB7XG4gIGlmICh0eXBlb2YgaW5kZXhlZERCID09PSBcInVuZGVmaW5lZFwiKSByZXR1cm47XG4gIGlmIChwZXJzaXN0VGltZXIpIGNsZWFyVGltZW91dChwZXJzaXN0VGltZXIpO1xuICBwZXJzaXN0VGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICBwZXJzaXN0VGltZXIgPSBudWxsO1xuICAgIHZvaWQgcGVyc2lzdENhY2hlKCk7XG4gIH0sIFBFUlNJU1RfREVCT1VOQ0VfTVMpO1xufVxuXG4vKiogU2F2ZSB0aGUgaW4tbWVtb3J5IGxpc3RzIG92ZXIgdGhlaXIgSW5kZXhlZERCIGVudHJpZXMsIGtlZXBpbmcgZWFjaCBlbnRyeSdzIHRpbWVzdGFtcC4gKi9cbmFzeW5jIGZ1bmN0aW9uIHBlcnNpc3RDYWNoZSgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3QgbGlzdHM6IFtzdHJpbmcsIFNjZW5lW10gfCBudWxsXVtdID0gW1xuICAgIFtcImFsbC1zY2VuZXNcIiwgc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzXSxcbiAgICBbXCJmaWx0ZXJlZC1zY2VuZXNcIiwgc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXNdLFxuICBdO1xuICBmb3IgKGNvbnN0IFtjYWNoZUtleSwgc2NlbmVzXSBvZiBsaXN0cykge1xuICAgIGlmICghc2NlbmVzKSBjb250aW51ZTtcbiAgICBjb25zdCBjYWNoZWQgPSBhd2FpdCBnZXRDYWNoZWRTY2VuZXMoY2FjaGVLZXkpO1xuICAgIC8vIE1pc3Npbmcgb3IgZXhwaXJlZDogdGhlIG5leHQgbG9hZCBmZXRjaGVzIGZyZXNoIGFueXdheS4gQSBkaWZmZXJlbnQgZmlsdGVyOiBub3QgdGhpcyBsaXN0LlxuICAgIGlmICghY2FjaGVkKSBjb250aW51ZTtcbiAgICBpZiAoY2FjaGVLZXkgPT09IFwiZmlsdGVyZWQtc2NlbmVzXCIgJiYgY2FjaGVkLmZpbHRlcktleSAhPT0gc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyS2V5KSBjb250aW51ZTtcbiAgICBhd2FpdCBzZXRDYWNoZWRTY2VuZXMoY2FjaGVLZXksIHNjZW5lcywgc2NlbmVzLmxlbmd0aCwgY2FjaGVkLmZpbHRlcktleSwgY2FjaGVkLnRpbWVzdGFtcCk7XG4gIH1cbn1cblxuLy8gRHJvcCBhIGRlbGV0ZWQgc2NlbmUgZnJvbSBldmVyeSBjYWNoZSB0aWVyIGFuZCB0aGUgbGVmdC1zaWRlIHNodWZmbGVcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZW1vdmVTY2VuZUV2ZXJ5d2hlcmUoc2NlbmVJZDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHdpdGhvdXQgPSAoc2NlbmVzOiBTY2VuZVtdIHwgbnVsbCk6IFNjZW5lW10gfCBudWxsID0+XG4gICAgc2NlbmVzID8gc2NlbmVzLmZpbHRlcigocykgPT4gcy5pZCAhPT0gc2NlbmVJZCkgOiBzY2VuZXM7XG5cbiAgc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzID0gd2l0aG91dChzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXMpO1xuICBzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJlZFNjZW5lcyA9IHdpdGhvdXQoc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXMpO1xuXG4gIGNvbnN0IHNodWZmbGVJZHggPSBzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzLmZpbmRJbmRleCgocykgPT4gcy5pZCA9PT0gc2NlbmVJZCk7XG4gIGlmIChzaHVmZmxlSWR4ICE9PSAtMSkge1xuICAgIHN0YXRlLnNodWZmbGVkRmlsdGVyZWRTY2VuZXMuc3BsaWNlKHNodWZmbGVJZHgsIDEpO1xuICAgIGlmIChzaHVmZmxlSWR4IDwgc3RhdGUuc2h1ZmZsZUluZGV4KSBzdGF0ZS5zaHVmZmxlSW5kZXgtLTtcbiAgfVxuXG4gIGZvciAoY29uc3QgY2FjaGVLZXkgb2YgW1wiYWxsLXNjZW5lc1wiLCBcImZpbHRlcmVkLXNjZW5lc1wiXSkge1xuICAgIGNvbnN0IGNhY2hlZCA9IGF3YWl0IGdldENhY2hlZFNjZW5lcyhjYWNoZUtleSk7XG4gICAgaWYgKGNhY2hlZCAmJiBjYWNoZWQuc2NlbmVzLnNvbWUoKHMpID0+IHMuaWQgPT09IHNjZW5lSWQpKSB7XG4gICAgICBjb25zdCBzY2VuZXMgPSBjYWNoZWQuc2NlbmVzLmZpbHRlcigocykgPT4gcy5pZCAhPT0gc2NlbmVJZCk7XG4gICAgICAvLyBLZWVwIHRoZSBvcmlnaW5hbCB0aW1lc3RhbXA6IHJlbW92aW5nIG9uZSBzY2VuZSBkb2Vzbid0IG1ha2UgdGhlIHJlc3QgYW55IGZyZXNoZXJcbiAgICAgIGF3YWl0IHNldENhY2hlZFNjZW5lcyhjYWNoZUtleSwgc2NlbmVzLCBzY2VuZXMubGVuZ3RoLCBjYWNoZWQuZmlsdGVyS2V5LCBjYWNoZWQudGltZXN0YW1wKTtcbiAgICB9XG4gIH1cbiAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIPCfl5HvuI8gUmVtb3ZlZCBzY2VuZSAke3NjZW5lSWR9IGZyb20gY2FjaGVzYCk7XG59XG4iLCAiLy8gU2NlbmUgbG9va3VwcyBmb3IgZGV0ZWN0aW5nIHNjZW5lcyBkZWxldGVkIHdoaWxlIHRoZXkgd2VyZSBpbiBhIGJhdHRsZSwgYW5kIGZvciBicmluZ2luZyBhXHJcbi8vIHNhdmVkIHBhaXIncyBFTE8gYW5kIFN0YXNoIHJhdGluZyB1cCB0byBkYXRlLlxyXG5cclxuaW1wb3J0IHsgZ3JhcGhxbFF1ZXJ5IH0gZnJvbSBcIi4vZ3JhcGhxbFwiO1xyXG5pbXBvcnQgdHlwZSB7IFNjZW5lIH0gZnJvbSBcIi4vdHlwZXNcIjtcclxuXHJcbmV4cG9ydCB0eXBlIFNjZW5lRmllbGRzID0gUGljazxTY2VuZSwgXCJpZFwiIHwgXCJyYXRpbmcxMDBcIiB8IFwiY3VzdG9tX2ZpZWxkc1wiPjtcclxuXHJcbi8qKlxyXG4gKiBUaGUgY3VycmVudCBTdGFzaCByYXRpbmcgYW5kIGN1c3RvbSBmaWVsZHMgb2YgdGhlc2Ugc2NlbmVzLCBieSBpZDsgaWRzIHRoYXQgbm8gbG9uZ2VyIGV4aXN0XHJcbiAqIGFyZSBtaXNzaW5nLiAoZmluZFNjZW5lcyhpZHMpIGVycm9ycyBvbiBhbnkgbWlzc2luZyBpZCwgc28gaXQncyBhbGlhc2VkIGZpbmRTY2VuZSBsb29rdXBzLilcclxuICovXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBmZXRjaFNjZW5lRmllbGRzKGlkczogc3RyaW5nW10pOiBQcm9taXNlPE1hcDxzdHJpbmcsIFNjZW5lRmllbGRzPj4ge1xyXG4gIGNvbnN0IGFsaWFzZXMgPSBpZHNcclxuICAgIC5tYXAoKGlkLCBpKSA9PiBgcyR7aX06IGZpbmRTY2VuZShpZDogJHtKU09OLnN0cmluZ2lmeShpZCl9KSB7IGlkIHJhdGluZzEwMCBjdXN0b21fZmllbGRzIH1gKVxyXG4gICAgLmpvaW4oXCJcXG5cIik7XHJcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZ3JhcGhxbFF1ZXJ5PFJlY29yZDxzdHJpbmcsIFNjZW5lRmllbGRzIHwgbnVsbD4+KGB7ICR7YWxpYXNlc30gfWApO1xyXG4gIHJldHVybiBuZXcgTWFwKE9iamVjdC52YWx1ZXMocmVzdWx0KS5mbGF0TWFwKChzKSA9PiAocyA/IFtbcy5pZCwgc10gYXMgY29uc3RdIDogW10pKSk7XHJcbn1cclxuXHJcbi8qKiBUcnVlIGZvciBHcmFwaFFMIGVycm9ycyBTdGFzaCByYWlzZXMgd2hlbiBhIHNjZW5lIGlkIG5vIGxvbmdlciBleGlzdHMuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBpc1NjZW5lTm90Rm91bmRFcnJvcihlcnJvcjogdW5rbm93bik6IGJvb2xlYW4ge1xyXG4gIHJldHVybiBlcnJvciBpbnN0YW5jZW9mIEVycm9yICYmIC9ub3QgZm91bmQvaS50ZXN0KGVycm9yLm1lc3NhZ2UpO1xyXG59XHJcbiIsICIvLyBQZXJzaXN0IEVMTyAoYW5kIFN0YXNoIHJhdGluZ3MpIHRvIFN0YXNoIGFuZCBrZWVwIHRoZSBsb2NhbCBjYWNoZSBpbiBzeW5jLlxuXG5pbXBvcnQgeyBsYXRlc3RTY2VuZSwgc2V0RWxvSW5DYWNoZSwgc2V0UmF0aW5nc0luQ2FjaGUgfSBmcm9tIFwiLi9jYWNoZVwiO1xuaW1wb3J0IHsgRUxPX0ZJRUxEX0tFWVMgfSBmcm9tIFwiLi9jb25zdGFudHNcIjtcbmltcG9ydCB7IGdyYXBocWxRdWVyeSwgcmVmcmVzaFN0YXNoQ2FjaGUgfSBmcm9tIFwiLi9ncmFwaHFsXCI7XG5pbXBvcnQgeyBpc1NjZW5lTm90Rm91bmRFcnJvciB9IGZyb20gXCIuL3NjZW5lQWN0aW9uc1wiO1xuaW1wb3J0IHsgZWxvQ3VzdG9tRmllbGRzLCBlbG9GaWVsZHMsIGlzU2VlZGVkLCBzdGFzaFJhdGluZ0NoYW5nZXMgfSBmcm9tIFwiLi9zY29yZVwiO1xuaW1wb3J0IHsgc3RhdGUgfSBmcm9tIFwiLi9zdGF0ZVwiO1xuaW1wb3J0IHR5cGUgeyBFbG9GaWVsZHMsIFNjZW5lIH0gZnJvbSBcIi4vdHlwZXNcIjtcblxuLyoqIFdpbmRvdyBldmVudCBmaXJlZCB3aGVuIGEgcmF0aW5nIHdyaXRlIGZpbmRzIHRoZSBzY2VuZSB3YXMgZGVsZXRlZCBlbHNld2hlcmUgKGRldGFpbCA9IHNjZW5lIGlkKS4gKi9cbmV4cG9ydCBjb25zdCBTQ0VORV9NSVNTSU5HX0VWRU5UID0gXCJzdGFzaC1iYXR0bGU6c2NlbmUtbWlzc2luZ1wiO1xuXG5jb25zdCBTQ0VORV9VUERBVEVfTVVUQVRJT04gPSBgXG4gICAgICBtdXRhdGlvbiBTY2VuZVVwZGF0ZSgkaW5wdXQ6IFNjZW5lVXBkYXRlSW5wdXQhKSB7XG4gICAgICAgIHNjZW5lVXBkYXRlKGlucHV0OiAkaW5wdXQpIHtcbiAgICAgICAgICBpZFxuICAgICAgICB9XG4gICAgICB9XG4gICAgYDtcblxuZnVuY3Rpb24gcmVwb3J0V3JpdGVFcnJvcihzY2VuZUlkOiBzdHJpbmcsIHdoYXQ6IHN0cmluZywgZTogdW5rbm93bik6IHZvaWQge1xuICBjb25zb2xlLmVycm9yKGBbU3Rhc2ggQmF0dGxlXSBGYWlsZWQgdG8gJHt3aGF0fSBmb3Igc2NlbmUgJHtzY2VuZUlkfTpgLCBlKTtcbiAgaWYgKGlzU2NlbmVOb3RGb3VuZEVycm9yKGUpKSB7XG4gICAgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEN1c3RvbUV2ZW50KFNDRU5FX01JU1NJTkdfRVZFTlQsIHsgZGV0YWlsOiBzY2VuZUlkIH0pKTtcbiAgfVxufVxuXG4vKiogVHJ1ZSB3aGVuIGJvdGggYXJlIHVucmF0ZWQsIG9yIGhvbGQgdGhlIHNhbWUgRUxPIGZpZWxkcy4gKi9cbmZ1bmN0aW9uIHNhbWVFbG8oYTogRWxvRmllbGRzIHwgbnVsbCwgYjogRWxvRmllbGRzIHwgbnVsbCk6IGJvb2xlYW4ge1xuICBpZiAoYSA9PT0gbnVsbCB8fCBiID09PSBudWxsKSByZXR1cm4gYSA9PT0gYjtcbiAgcmV0dXJuIGEuZWxvID09PSBiLmVsbyAmJiBhLmJhdHRsZXMgPT09IGIuYmF0dGxlcyAmJiBhLnNlZWRlZCA9PT0gYi5zZWVkZWQ7XG59XG5cbi8qKlxuICogVXBkYXRlIHRoZSBzY2VuZSBvYmplY3QsIHRoZSBjYWNoZSBhbmQgU3Rhc2gncyBwYWdlIGNhY2hlIHN0cmFpZ2h0IGF3YXkgKHNvIHRoZSBuZXh0IHBhaXJcbiAqIGFscmVhZHkgc2VlcyB0aGUgY2hhbmdlKSwgdGhlbiB3cml0ZSB0byBTdGFzaC4gSWYgdGhlIHdyaXRlIGZhaWxzLCBwdXQgdGhlIG9sZCB2YWx1ZSBiYWNrLFxuICogdW5sZXNzIGEgbGF0ZXIgd3JpdGUgaGFzIHJlcGxhY2VkIGl0IHNpbmNlLiBTdGFzaCByYXRpbmdzIHN5bmMgb25seSBhZnRlciBhIHN1Y2Nlc3NmdWwgd3JpdGUuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHNhdmVFbG9GaWVsZHMoc2NlbmU6IFNjZW5lLCB2YWx1ZTogRWxvRmllbGRzIHwgbnVsbCwgY3VzdG9tRmllbGRzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiwgd2hhdDogc3RyaW5nKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGNvbnN0IHByZXZpb3VzID0gZWxvRmllbGRzKGxhdGVzdFNjZW5lKHNjZW5lKSk7XG4gIHNldEVsb0luQ2FjaGUoc2NlbmUsIHZhbHVlKTtcbiAgcmVmcmVzaFN0YXNoQ2FjaGUoW3sgaWQ6IHNjZW5lLmlkLCBlbG86IHZhbHVlIH1dLCBmYWxzZSk7XG4gIHRyeSB7XG4gICAgYXdhaXQgZ3JhcGhxbFF1ZXJ5KFNDRU5FX1VQREFURV9NVVRBVElPTiwgeyBpbnB1dDogeyBpZDogc2NlbmUuaWQsIGN1c3RvbV9maWVsZHM6IGN1c3RvbUZpZWxkcyB9IH0pO1xuICB9IGNhdGNoIChlKSB7XG4gICAgcmVwb3J0V3JpdGVFcnJvcihzY2VuZS5pZCwgd2hhdCwgZSk7XG4gICAgaWYgKHNhbWVFbG8oZWxvRmllbGRzKGxhdGVzdFNjZW5lKHNjZW5lKSksIHZhbHVlKSkge1xuICAgICAgc2V0RWxvSW5DYWNoZShzY2VuZSwgcHJldmlvdXMpO1xuICAgICAgcmVmcmVzaFN0YXNoQ2FjaGUoW3sgaWQ6IHNjZW5lLmlkLCBlbG86IHByZXZpb3VzIH1dLCBmYWxzZSk7XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICBzY2hlZHVsZVN0YXNoUmF0aW5nU3luYygpO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxuLyoqXG4gKiBTYXZlIGEgc2NlbmUncyBFTE8gYW5kIGJhdHRsZSBjb3VudCAoY3VzdG9tIGZpZWxkcyBvbmx5OyBgcGFydGlhbGAgbGVhdmVzIG90aGVyIHBsdWdpbnMnXG4gKiBmaWVsZHMgYWxvbmUpLiBXaGV0aGVyIGl0IHdhcyBzZWVkZWQgc3RheXMgYXMgaXQgd2FzLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gd3JpdGVFbG8oc2NlbmU6IFNjZW5lLCBlbG86IG51bWJlciwgYmF0dGxlczogbnVtYmVyKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHZhbHVlID0geyBlbG8sIGJhdHRsZXMsIHNlZWRlZDogaXNTZWVkZWQoc2NlbmUpIH07XG4gIGlmIChhd2FpdCBzYXZlRWxvRmllbGRzKHNjZW5lLCB2YWx1ZSwgeyBwYXJ0aWFsOiBlbG9DdXN0b21GaWVsZHModmFsdWUpIH0sIFwic2F2ZSBFTE9cIikpIHtcbiAgICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g8J+TnSBTYXZlZCBzY2VuZSAke3NjZW5lLmlkfSBFTE8gJHtlbG99ICgke2JhdHRsZXN9IGJhdHRsZXMpYCk7XG4gIH1cbn1cblxuLyoqIFJlbW92ZSBhIHNjZW5lJ3MgRUxPIGZpZWxkcywgbWFraW5nIGl0IHVucmF0ZWQgYWdhaW4uICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY2xlYXJFbG8oc2NlbmU6IFNjZW5lKTogUHJvbWlzZTx2b2lkPiB7XG4gIGlmIChhd2FpdCBzYXZlRWxvRmllbGRzKHNjZW5lLCBudWxsLCB7IHJlbW92ZTogRUxPX0ZJRUxEX0tFWVMgfSwgXCJjbGVhciBFTE9cIikpIHtcbiAgICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g8J+TnSBDbGVhcmVkIHNjZW5lICR7c2NlbmUuaWR9IEVMT2ApO1xuICB9XG59XG5cbi8qKlxuICogV3JpdGUgU3Rhc2ggcmF0aW5ncyAoc2NlbmUgaWQgdG8gMS0xMDApIGluIG9uZSBHcmFwaFFMIHJlcXVlc3Q6IG9uZSBhbGlhc2VkIGJ1bGtTY2VuZVVwZGF0ZVxuICogcGVyIGRpc3RpbmN0IHZhbHVlLiBUaHJvd3Mgb24gZmFpbHVyZTsgZG9lc24ndCB0b3VjaCB0aGUgY2FjaGUuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB3cml0ZVN0YXNoUmF0aW5ncyhyYXRpbmdzOiBNYXA8c3RyaW5nLCBudW1iZXI+KTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGlkc0J5UmF0aW5nID0gbmV3IE1hcDxudW1iZXIsIHN0cmluZ1tdPigpO1xuICBmb3IgKGNvbnN0IFtpZCwgcmF0aW5nXSBvZiByYXRpbmdzKSB7XG4gICAgY29uc3QgaWRzID0gaWRzQnlSYXRpbmcuZ2V0KHJhdGluZykgPz8gW107XG4gICAgaWRzLnB1c2goaWQpO1xuICAgIGlkc0J5UmF0aW5nLnNldChyYXRpbmcsIGlkcyk7XG4gIH1cbiAgaWYgKGlkc0J5UmF0aW5nLnNpemUgPT09IDApIHJldHVybjtcblxuICBjb25zdCB2YWx1ZXMgPSBbLi4uaWRzQnlSYXRpbmcua2V5cygpXTtcbiAgY29uc3QgbXV0YXRpb24gPSBgXG4gICAgICBtdXRhdGlvbiBTeW5jU3Rhc2hSYXRpbmdzKCR7dmFsdWVzLm1hcCgocikgPT4gYCRyJHtyfTogQnVsa1NjZW5lVXBkYXRlSW5wdXQhYCkuam9pbihcIiwgXCIpfSkge1xuICAgICAgICAke3ZhbHVlcy5tYXAoKHIpID0+IGByJHtyfTogYnVsa1NjZW5lVXBkYXRlKGlucHV0OiAkciR7cn0pIHsgaWQgfWApLmpvaW4oXCJcXG4gICAgICAgIFwiKX1cbiAgICAgIH1cbiAgICBgO1xuICBjb25zdCB2YXJpYWJsZXMgPSBPYmplY3QuZnJvbUVudHJpZXMoXG4gICAgdmFsdWVzLm1hcCgocikgPT4gW2ByJHtyfWAsIHsgaWRzOiBpZHNCeVJhdGluZy5nZXQociksIHJhdGluZzEwMDogciB9XSksXG4gICk7XG4gIGF3YWl0IGdyYXBocWxRdWVyeShtdXRhdGlvbiwgdmFyaWFibGVzKTtcbiAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIPCfk50gV3JvdGUgJHtyYXRpbmdzLnNpemV9IFN0YXNoIHJhdGluZ3MgKCR7dmFsdWVzLmxlbmd0aH0gZGlzdGluY3QgdmFsdWVzKWApO1xufVxuXG4vKiogQWZ0ZXIgU3Rhc2ggcmF0aW5ncyB3ZXJlIHdyaXR0ZW46IHVwZGF0ZSB0aGUgY2FjaGVkIHNjZW5lcyBhbmQgU3Rhc2gncyBvd24gcGFnZSBjYWNoZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhcHBseVN0YXNoUmF0aW5ncyhyYXRpbmdzOiBNYXA8c3RyaW5nLCBudW1iZXI+KTogdm9pZCB7XG4gIHNldFJhdGluZ3NJbkNhY2hlKHJhdGluZ3MpO1xuICByZWZyZXNoU3Rhc2hDYWNoZShcbiAgICBbLi4ucmF0aW5nc10ubWFwKChbaWQsIHJhdGluZzEwMF0pID0+ICh7IGlkLCByYXRpbmcxMDAgfSkpLFxuICAgIHJhdGluZ3Muc2l6ZSA+IDAsXG4gICk7XG59XG5cbi8qKiBXYWl0IHRoaXMgbG9uZyBhZnRlciB0aGUgbGFzdCBFTE8gd3JpdGUsIHNvIGJvdGggc2NlbmVzIG9mIGEgcGljayBzeW5jIGluIG9uZSByZXF1ZXN0LiAqL1xuY29uc3QgU1lOQ19ERUJPVU5DRV9NUyA9IDUwMDtcbmxldCBzeW5jVGltZXI6IFJldHVyblR5cGU8dHlwZW9mIHNldFRpbWVvdXQ+IHwgbnVsbCA9IG51bGw7XG5cbi8qKiBTeW5jIFN0YXNoIHJhdGluZ3Mgc29vbiAoZGVib3VuY2VkKSwgdW5sZXNzIHRoZSBcIlN0YXNoIHJhdGluZ3NcIiBzZXR0aW5nIGlzIFwib2ZmXCIuICovXG5leHBvcnQgZnVuY3Rpb24gc2NoZWR1bGVTdGFzaFJhdGluZ1N5bmMoKTogdm9pZCB7XG4gIGlmIChzdGF0ZS5zZXR0aW5ncy5zdGFzaFJhdGluZ3MgPT09IFwib2ZmXCIpIHJldHVybjtcbiAgaWYgKHN5bmNUaW1lcikgY2xlYXJUaW1lb3V0KHN5bmNUaW1lcik7XG4gIHN5bmNUaW1lciA9IHNldFRpbWVvdXQoKCkgPT4ge1xuICAgIHN5bmNUaW1lciA9IG51bGw7XG4gICAgdm9pZCBzeW5jU3Rhc2hSYXRpbmdzKCk7XG4gIH0sIFNZTkNfREVCT1VOQ0VfTVMpO1xufVxuXG4vKiogVGhlIFN0YXNoIHJhdGluZyB3cml0ZSBpbiBwcm9ncmVzcyAob3IgdGhlIGxhc3Qgb25lKSwgc28gdGhlIG5leHQgd2FpdHMgZm9yIGl0LiAqL1xubGV0IHJhdGluZ1dyaXRlczogUHJvbWlzZTx1bmtub3duPiA9IFByb21pc2UucmVzb2x2ZSgpO1xuXG4vKipcbiAqIFJ1biBhIFN0YXNoIHJhdGluZ3Mgd3JpdGUgYWZ0ZXIgYW55IGluIHByb2dyZXNzLCBzbyBlYWNoIG9uZSBzdGFydHMgZnJvbSB0aGUgcmF0aW5ncyB0aGVcbiAqIHByZXZpb3VzIG9uZSB3cm90ZSAob3ZlcmxhcHBpbmcgd3JpdGVzIGNvdWxkIHJlcGVhdCB3b3JrIG9yIGZpbmlzaCBvdXQgb2Ygb3JkZXIpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcXVldWVSYXRpbmdXcml0ZTxUPih0YXNrOiAoKSA9PiBQcm9taXNlPFQ+KTogUHJvbWlzZTxUPiB7XG4gIGNvbnN0IHJ1biA9IHJhdGluZ1dyaXRlcy50aGVuKHRhc2spO1xuICByYXRpbmdXcml0ZXMgPSBydW4uY2F0Y2goKCkgPT4gdW5kZWZpbmVkKTtcbiAgcmV0dXJuIHJ1bjtcbn1cblxuLyoqXG4gKiBCcmluZyBTdGFzaCByYXRpbmdzIGluIGxpbmUgd2l0aCBFTE8gZm9yIHRoZSB3aG9sZSBsaWJyYXJ5ICh0aGUgYWxsLXNjZW5lcyBjYWNoZSk6IHdvcmsgb3V0XG4gKiBldmVyeSBzY2VuZSdzIHRhcmdldCB1bmRlciB0aGUgY3VycmVudCBzZXR0aW5nLCBhbmQgd3JpdGUgb25seSB0aGUgb25lcyB0aGF0IGRpZmZlciBmcm9tIHRoZVxuICogY2FjaGVkIHJhdGluZywgaW4gb25lIHJlcXVlc3QuIFF1ZXVlZCBiZWhpbmQgYW55IHdyaXRlIGluIHByb2dyZXNzLiBSZXR1cm5zIGhvdyBtYW55IHdlcmUgd3JpdHRlbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN5bmNTdGFzaFJhdGluZ3MoKTogUHJvbWlzZTxudW1iZXI+IHtcbiAgcmV0dXJuIHF1ZXVlUmF0aW5nV3JpdGUoYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IG1vZGUgPSBzdGF0ZS5zZXR0aW5ncy5zdGFzaFJhdGluZ3M7XG4gICAgY29uc3Qgc2NlbmVzID0gc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzO1xuICAgIGlmIChtb2RlID09PSBcIm9mZlwiIHx8ICFzY2VuZXMpIHJldHVybiAwO1xuICAgIGNvbnN0IGNoYW5nZXMgPSBzdGFzaFJhdGluZ0NoYW5nZXMoc2NlbmVzLCBtb2RlKTtcbiAgICBpZiAoY2hhbmdlcy5zaXplID09PSAwKSByZXR1cm4gMDtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgd3JpdGVTdGFzaFJhdGluZ3MoY2hhbmdlcyk7XG4gICAgICBhcHBseVN0YXNoUmF0aW5ncyhjaGFuZ2VzKTtcbiAgICAgIHJldHVybiBjaGFuZ2VzLnNpemU7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIEZhaWxlZCB0byBzeW5jIFN0YXNoIHJhdGluZ3M6XCIsIGUpO1xuICAgICAgcmV0dXJuIDA7XG4gICAgfVxuICB9KTtcbn1cbiIsICIvLyBPbmUtdGltZSBFTE8gc2V0dXA6IGdpdmUgZXZlcnkgc2NlbmUgYSBzdGFydGluZyBFTE8gKGZyb20gaXRzIFN0YXNoIHJhdGluZywgb3IgMTUwMCBmb3IgYWxsKSxcbi8vIHRoZW4gb3B0aW9uYWxseSBzeW5jIFN0YXNoIHJhdGluZ3MgZnJvbSB0aGUgbmV3IEVMTy4gUmUtcnVubmluZyBpdCBvdmVyd3JpdGVzLCBzbyBhblxuLy8gaW50ZXJydXB0ZWQgc2V0dXAgaXMgc2FmZSB0byByZXBlYXQuXG5cbmltcG9ydCB7IEVMT19GSUVMRF9LRVlTLCBFTE9fU1RBUlQgfSBmcm9tIFwiLi9jb25zdGFudHNcIjtcbmltcG9ydCB7IGdyYXBocWxRdWVyeSwgcmVmcmVzaFN0YXNoQ2FjaGUgfSBmcm9tIFwiLi9ncmFwaHFsXCI7XG5pbXBvcnQgeyB3cml0ZVN0YXNoUmF0aW5ncyB9IGZyb20gXCIuL3JhdGluZ1wiO1xuaW1wb3J0IHsgYWZ0ZXJTZXR1cCwgZWxvQ3VzdG9tRmllbGRzLCBpc1JhdGVkLCBzZWVkLCBzdGFydGluZ0Vsbywgc3Rhc2hSYXRpbmdDaGFuZ2VzIH0gZnJvbSBcIi4vc2NvcmVcIjtcbmltcG9ydCB0eXBlIHsgRWxvU3RhcnQsIFNjZW5lLCBTdGFzaFJhdGluZ3NNb2RlIH0gZnJvbSBcIi4vdHlwZXNcIjtcblxuZXhwb3J0IHR5cGUgU2V0dXBQaGFzZSA9IFwiZWxvXCIgfCBcInJhdGluZ3NcIjtcblxuLyoqIFByb2dyZXNzIGNhbGxiYWNrOiBgZG9uZWAgb2YgYHRvdGFsYCBzY2VuZXMgZmluaXNoZWQgaW4gdGhpcyBwaGFzZS4gKi9cbmV4cG9ydCB0eXBlIFNldHVwUHJvZ3Jlc3MgPSAocGhhc2U6IFNldHVwUGhhc2UsIGRvbmU6IG51bWJlciwgdG90YWw6IG51bWJlcikgPT4gdm9pZDtcblxuZXhwb3J0IGludGVyZmFjZSBTZXR1cFN1bW1hcnkge1xuICBlbG9Xcml0dGVuOiBudW1iZXI7IC8vIFNjZW5lcyBnaXZlbiBhIHN0YXJ0aW5nIEVMT1xuICBlbG9DbGVhcmVkOiBudW1iZXI7IC8vIFNjZW5lcyB3aG9zZSBvbGQgRUxPIHdhcyByZW1vdmVkIChyZS1ydW4gd2l0aCBcIlVzZSBteSByYXRpbmdzXCIpXG4gIHJhdGluZ3NXcml0dGVuOiBudW1iZXI7IC8vIFN0YXNoIHJhdGluZ3MgY2hhbmdlZFxufVxuXG5jb25zdCBTRVRVUF9TQ0VORVNfUVVFUlkgPSBgXG4gICAgICBxdWVyeSBGaW5kU2NlbmVzRm9yRWxvU2V0dXAge1xuICAgICAgICBmaW5kU2NlbmVzKGZpbHRlcjogeyBwZXJfcGFnZTogLTEgfSkge1xuICAgICAgICAgIHNjZW5lcyB7XG4gICAgICAgICAgICBpZFxuICAgICAgICAgICAgcmF0aW5nMTAwXG4gICAgICAgICAgICBjdXN0b21fZmllbGRzXG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgYDtcblxuLyoqIEV2ZXJ5IHNjZW5lJ3MgaWQsIFN0YXNoIHJhdGluZyBhbmQgY3VzdG9tIGZpZWxkcywgZnJlc2ggZnJvbSBTdGFzaCAobm90IHRoZSA1LW1pbnV0ZSBjYWNoZSkuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmV0Y2hTZXR1cFNjZW5lcygpOiBQcm9taXNlPFNjZW5lW10+IHtcbiAgY29uc3QgZGF0YSA9IGF3YWl0IGdyYXBocWxRdWVyeTx7IGZpbmRTY2VuZXM6IHsgc2NlbmVzOiBTY2VuZVtdIH0gfT4oU0VUVVBfU0NFTkVTX1FVRVJZKTtcbiAgcmV0dXJuIGRhdGEuZmluZFNjZW5lcy5zY2VuZXMgPz8gW107XG59XG5cbi8qKiBUaGUgU3Rhc2ggcmF0aW5ncyB0aGUgc2V0dXAgd291bGQgY2hhbmdlOiBzY2VuZSBpZCB0byBuZXcgcmF0aW5nIChub25lIGZvciBcIm9mZlwiKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZXR1cFJhdGluZ0NoYW5nZXMoc2NlbmVzOiBTY2VuZVtdLCBzdGFydDogRWxvU3RhcnQsIHN0YXNoUmF0aW5nczogU3Rhc2hSYXRpbmdzTW9kZSk6IE1hcDxzdHJpbmcsIG51bWJlcj4ge1xuICByZXR1cm4gc3Rhc2hSYXRpbmdDaGFuZ2VzKFxuICAgIHNjZW5lcy5tYXAoKHNjZW5lKSA9PiBhZnRlclNldHVwKHNjZW5lLCBzdGFydCkpLFxuICAgIHN0YXNoUmF0aW5ncyxcbiAgKTtcbn1cblxuY29uc3QgQlVMS19VUERBVEVfTVVUQVRJT04gPSBgXG4gICAgICBtdXRhdGlvbiBCdWxrU2NlbmVVcGRhdGUoJGlucHV0OiBCdWxrU2NlbmVVcGRhdGVJbnB1dCEpIHtcbiAgICAgICAgYnVsa1NjZW5lVXBkYXRlKGlucHV0OiAkaW5wdXQpIHtcbiAgICAgICAgICBpZFxuICAgICAgICB9XG4gICAgICB9XG4gICAgYDtcblxuLyoqXG4gKiBTZWVkIGVhY2ggcmF0ZWQgc2NlbmUgZnJvbSBpdHMgb3duIHJhdGluZy4gU2NlbmVzIHdpdGggdGhlIHNhbWUgU3Rhc2ggcmF0aW5nIGdldCB0aGUgc2FtZVxuICogc3RhcnRpbmcgZmllbGRzLCBzbyBpdCdzIG9uZSBhbGlhc2VkIGJ1bGtTY2VuZVVwZGF0ZSBwZXIgZGlzdGluY3QgcmF0aW5nLCBhbGwgaW4gb25lIHJlcXVlc3QuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIHNlZWRGcm9tUmF0aW5ncyhyYXRlZDogU2NlbmVbXSk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBpZHNCeVJhdGluZyA9IG5ldyBNYXA8bnVtYmVyLCBzdHJpbmdbXT4oKTtcbiAgZm9yIChjb25zdCBzY2VuZSBvZiByYXRlZCkge1xuICAgIGNvbnN0IHJhdGluZyA9IHNjZW5lLnJhdGluZzEwMCBhcyBudW1iZXI7XG4gICAgY29uc3QgaWRzID0gaWRzQnlSYXRpbmcuZ2V0KHJhdGluZykgPz8gW107XG4gICAgaWRzLnB1c2goc2NlbmUuaWQpO1xuICAgIGlkc0J5UmF0aW5nLnNldChyYXRpbmcsIGlkcyk7XG4gIH1cbiAgaWYgKGlkc0J5UmF0aW5nLnNpemUgPT09IDApIHJldHVybjtcblxuICBjb25zdCB2YWx1ZXMgPSBbLi4uaWRzQnlSYXRpbmcua2V5cygpXTtcbiAgY29uc3QgbXV0YXRpb24gPSBgXG4gICAgICBtdXRhdGlvbiBTZWVkRWxvKCR7dmFsdWVzLm1hcCgocikgPT4gYCRzJHtyfTogQnVsa1NjZW5lVXBkYXRlSW5wdXQhYCkuam9pbihcIiwgXCIpfSkge1xuICAgICAgICAke3ZhbHVlcy5tYXAoKHIpID0+IGBzJHtyfTogYnVsa1NjZW5lVXBkYXRlKGlucHV0OiAkcyR7cn0pIHsgaWQgfWApLmpvaW4oXCJcXG4gICAgICAgIFwiKX1cbiAgICAgIH1cbiAgICBgO1xuICBjb25zdCB2YXJpYWJsZXMgPSBPYmplY3QuZnJvbUVudHJpZXMoXG4gICAgdmFsdWVzLm1hcCgocikgPT4ge1xuICAgICAgY29uc3QgcGFydGlhbCA9IGVsb0N1c3RvbUZpZWxkcyh7IGVsbzogc2VlZChyKSwgYmF0dGxlczogMCwgc2VlZGVkOiB0cnVlIH0pO1xuICAgICAgcmV0dXJuIFtgcyR7cn1gLCB7IGlkczogaWRzQnlSYXRpbmcuZ2V0KHIpLCBjdXN0b21fZmllbGRzOiB7IHBhcnRpYWwgfSB9XTtcbiAgICB9KSxcbiAgKTtcbiAgYXdhaXQgZ3JhcGhxbFF1ZXJ5KG11dGF0aW9uLCB2YXJpYWJsZXMpO1xufVxuXG4vKipcbiAqIFJ1biB0aGUgc2V0dXAgb24gYHNjZW5lc2AgKGZyb20gZmV0Y2hTZXR1cFNjZW5lcyk6IHdyaXRlIHRoZSBzdGFydGluZyBFTE8sIHRoZW4sIHVubGVzc1xuICogc3Rhc2hSYXRpbmdzIGlzIFwib2ZmXCIsIHRoZSBTdGFzaCByYXRpbmdzIHRoYXQgY2hhbmdlLiBUaHJvd3MgaWYgYSByZXF1ZXN0IGZhaWxzOyB3aGF0ZXZlclxuICogd2FzIHdyaXR0ZW4gYnkgdGhlbiBzdGF5cywgYW5kIHJ1bm5pbmcgaXQgYWdhaW4gb3ZlcndyaXRlcyBpdC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJ1bkVsb1NldHVwKFxuICBzY2VuZXM6IFNjZW5lW10sXG4gIHN0YXJ0OiBFbG9TdGFydCxcbiAgc3Rhc2hSYXRpbmdzOiBTdGFzaFJhdGluZ3NNb2RlLFxuICBvblByb2dyZXNzOiBTZXR1cFByb2dyZXNzLFxuKTogUHJvbWlzZTxTZXR1cFN1bW1hcnk+IHtcbiAgY29uc3Qgc3VtbWFyeTogU2V0dXBTdW1tYXJ5ID0geyBlbG9Xcml0dGVuOiAwLCBlbG9DbGVhcmVkOiAwLCByYXRpbmdzV3JpdHRlbjogMCB9O1xuXG4gIGlmIChzdGFydCA9PT0gXCJyYXRpbmdzXCIpIHtcbiAgICBjb25zdCByYXRlZCA9IHNjZW5lcy5maWx0ZXIoKHNjZW5lKSA9PiBzY2VuZS5yYXRpbmcxMDAgIT0gbnVsbCk7XG4gICAgb25Qcm9ncmVzcyhcImVsb1wiLCAwLCByYXRlZC5sZW5ndGgpO1xuICAgIGF3YWl0IHNlZWRGcm9tUmF0aW5ncyhyYXRlZCk7XG4gICAgb25Qcm9ncmVzcyhcImVsb1wiLCByYXRlZC5sZW5ndGgsIHJhdGVkLmxlbmd0aCk7XG4gICAgc3VtbWFyeS5lbG9Xcml0dGVuID0gcmF0ZWQubGVuZ3RoO1xuXG4gICAgLy8gT25seSBtYXR0ZXJzIG9uIGEgcmUtcnVuOiBzY2VuZXMgd2l0aCBhbiBFTE8gYnV0IG5vIFN0YXNoIHJhdGluZyBiZWNvbWUgdW5yYXRlZCBhZ2FpblxuICAgIGNvbnN0IHN0YWxlID0gc2NlbmVzLmZpbHRlcigoc2NlbmUpID0+IHNjZW5lLnJhdGluZzEwMCA9PSBudWxsICYmIGlzUmF0ZWQoc2NlbmUpKS5tYXAoKHNjZW5lKSA9PiBzY2VuZS5pZCk7XG4gICAgaWYgKHN0YWxlLmxlbmd0aCA+IDApIHtcbiAgICAgIGF3YWl0IGdyYXBocWxRdWVyeShCVUxLX1VQREFURV9NVVRBVElPTiwge1xuICAgICAgICBpbnB1dDogeyBpZHM6IHN0YWxlLCBjdXN0b21fZmllbGRzOiB7IHJlbW92ZTogRUxPX0ZJRUxEX0tFWVMgfSB9LFxuICAgICAgfSk7XG4gICAgICBzdW1tYXJ5LmVsb0NsZWFyZWQgPSBzdGFsZS5sZW5ndGg7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIGNvbnN0IGlkcyA9IHNjZW5lcy5tYXAoKHNjZW5lKSA9PiBzY2VuZS5pZCk7XG4gICAgb25Qcm9ncmVzcyhcImVsb1wiLCAwLCBpZHMubGVuZ3RoKTtcbiAgICBpZiAoaWRzLmxlbmd0aCA+IDApIHtcbiAgICAgIGF3YWl0IGdyYXBocWxRdWVyeShCVUxLX1VQREFURV9NVVRBVElPTiwge1xuICAgICAgICBpbnB1dDogeyBpZHMsIGN1c3RvbV9maWVsZHM6IHsgcGFydGlhbDogZWxvQ3VzdG9tRmllbGRzKHsgZWxvOiBFTE9fU1RBUlQsIGJhdHRsZXM6IDAsIHNlZWRlZDogZmFsc2UgfSkgfSB9LFxuICAgICAgfSk7XG4gICAgfVxuICAgIG9uUHJvZ3Jlc3MoXCJlbG9cIiwgaWRzLmxlbmd0aCwgaWRzLmxlbmd0aCk7XG4gICAgc3VtbWFyeS5lbG9Xcml0dGVuID0gaWRzLmxlbmd0aDtcbiAgfVxuXG4gIGNvbnN0IGNoYW5nZXMgPSBzZXR1cFJhdGluZ0NoYW5nZXMoc2NlbmVzLCBzdGFydCwgc3Rhc2hSYXRpbmdzKTtcbiAgaWYgKGNoYW5nZXMuc2l6ZSA+IDApIHtcbiAgICBvblByb2dyZXNzKFwicmF0aW5nc1wiLCAwLCBjaGFuZ2VzLnNpemUpO1xuICAgIGF3YWl0IHdyaXRlU3Rhc2hSYXRpbmdzKGNoYW5nZXMpO1xuICAgIG9uUHJvZ3Jlc3MoXCJyYXRpbmdzXCIsIGNoYW5nZXMuc2l6ZSwgY2hhbmdlcy5zaXplKTtcbiAgICBzdW1tYXJ5LnJhdGluZ3NXcml0dGVuID0gY2hhbmdlcy5zaXplO1xuICB9XG5cbiAgLy8gU3Rhc2gncyBvd24gcGFnZXM6IGV2ZXJ5IHNjZW5lJ3MgRUxPIChvciBpdHMgcmVtb3ZhbCkgYW5kIGFueSBjaGFuZ2VkIHJhdGluZ1xuICByZWZyZXNoU3Rhc2hDYWNoZShcbiAgICBzY2VuZXMubWFwKChzY2VuZSkgPT4gKHsgaWQ6IHNjZW5lLmlkLCBlbG86IHN0YXJ0aW5nRWxvKHNjZW5lLCBzdGFydCksIHJhdGluZzEwMDogY2hhbmdlcy5nZXQoc2NlbmUuaWQpIH0pKSxcbiAgICBjaGFuZ2VzLnNpemUgPiAwLFxuICApO1xuXG4gIGNvbnNvbGUubG9nKFxuICAgIGBbU3Rhc2ggQmF0dGxlXSDinIUgRUxPIHNldHVwICgke3N0YXJ0fSwgU3Rhc2ggcmF0aW5ncyAke3N0YXNoUmF0aW5nc30pOiAke3N1bW1hcnkuZWxvV3JpdHRlbn0gRUxPIHdyaXR0ZW4sICR7c3VtbWFyeS5lbG9DbGVhcmVkfSBjbGVhcmVkLCAke3N1bW1hcnkucmF0aW5nc1dyaXR0ZW59IFN0YXNoIHJhdGluZ3Mgd3JpdHRlbmAsXG4gICk7XG4gIHJldHVybiBzdW1tYXJ5O1xufVxuIiwgIi8vIFVzZXIgc2V0dGluZ3Mgc3RvcmVkIGluIFN0YXNoJ3MgcGx1Z2luIGNvbmZpZ3VyYXRpb24gKGNvbmZpZ3VyYXRpb24ucGx1Z2luc1tcInN0YXNoLWJhdHRsZVwiXSksXG4vLyBzbyB0aGV5IGZvbGxvdyB0aGUgdXNlciBhY3Jvc3MgYnJvd3NlcnMuIEFsc28gZWRpdGFibGUgaW4gU3Rhc2gg4oaSIFNldHRpbmdzIOKGkiBQbHVnaW5zLlxuXG5pbXBvcnQge1xuICBERUZBVUxUX1NFVFRJTkdTLFxuICBMRUdBQ1lfRklMVEVSX09QUE9ORU5UU19LRVksXG4gIExFR0FDWV9NVVRFX1BSRVZJRVdTX0tFWSxcbiAgUExVR0lOX0lELFxufSBmcm9tIFwiLi9jb25zdGFudHNcIjtcbmltcG9ydCB7IGdyYXBocWxRdWVyeSB9IGZyb20gXCIuL2dyYXBocWxcIjtcbmltcG9ydCB7IHN0YXRlIH0gZnJvbSBcIi4vc3RhdGVcIjtcbmltcG9ydCB0eXBlIHsgRWxvU3RhcnQsIFNldHRpbmdzLCBTdGFzaFJhdGluZ3NNb2RlIH0gZnJvbSBcIi4vdHlwZXNcIjtcblxuY29uc3QgQ09ORklHX1FVRVJZID0gYHsgY29uZmlndXJhdGlvbiB7IHBsdWdpbnMgfSB9YDtcblxuY29uc3QgQ09ORklHVVJFX1BMVUdJTl9NVVRBVElPTiA9IGBcbiAgICAgIG11dGF0aW9uIENvbmZpZ3VyZVBsdWdpbigkcGx1Z2luX2lkOiBJRCEsICRpbnB1dDogTWFwISkge1xuICAgICAgICBjb25maWd1cmVQbHVnaW4ocGx1Z2luX2lkOiAkcGx1Z2luX2lkLCBpbnB1dDogJGlucHV0KVxuICAgICAgfVxuICAgIGA7XG5cbmNvbnN0IFNBVkVfREVCT1VOQ0VfTVMgPSA0MDA7XG5sZXQgc2F2ZVRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IG51bGwgPSBudWxsO1xuXG4vKiogUHJlLTMuMCBmdW4gbW9kZSB3YXMgb24gaW4gdGhlIHN0b3JlZCBjb25maWcgKHNvIEJhdHRsZSB3YXNuJ3QgY2hhbmdpbmcgU3Rhc2ggcmF0aW5ncykuICovXG5sZXQgbGVnYWN5RnVuTW9kZSA9IGZhbHNlO1xuXG5jb25zdCBTVEFTSF9SQVRJTkdTX01PREVTOiByZWFkb25seSBTdGFzaFJhdGluZ3NNb2RlW10gPSBbXCJvZmZcIiwgXCJwZXJjZW50aWxlXCIsIFwibGluZWFyXCJdO1xuY29uc3QgRUxPX1NUQVJUUzogcmVhZG9ubHkgRWxvU3RhcnRbXSA9IFtcInJhdGluZ3NcIiwgXCJmcmVzaFwiXTtcblxuZnVuY3Rpb24gb25lT2Y8VCBleHRlbmRzIHN0cmluZz4odmFsdWU6IHVua25vd24sIGFsbG93ZWQ6IHJlYWRvbmx5IFRbXSwgZmFsbGJhY2s6IFQpOiBUIHtcbiAgcmV0dXJuIGFsbG93ZWQuaW5jbHVkZXModmFsdWUgYXMgVCkgPyAodmFsdWUgYXMgVCkgOiBmYWxsYmFjaztcbn1cblxuZnVuY3Rpb24gY2xhbXBQZXJjZW50KHZhbHVlOiB1bmtub3duLCBmYWxsYmFjazogbnVtYmVyKTogbnVtYmVyIHtcbiAgY29uc3QgbiA9IE51bWJlcih2YWx1ZSk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUobikgPyBNYXRoLm1pbigxMDAsIE1hdGgubWF4KDAsIE1hdGgucm91bmQobikpKSA6IGZhbGxiYWNrO1xufVxuXG4vKiogQ29lcmNlIGEgc3RvcmVkIGNvbmZpZyBtYXAgaW50byBTZXR0aW5ncyAoU3Rhc2ggbWF5IG9taXQga2V5cyBvciBzdG9yZSBudW1iZXJzIGFzIHN0cmluZ3MpLiAqL1xuZnVuY3Rpb24gbm9ybWFsaXplKHJhdzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sIGJhc2U6IFNldHRpbmdzKTogU2V0dGluZ3Mge1xuICBjb25zdCBib29sID0gKGtleToga2V5b2YgU2V0dGluZ3MpOiBib29sZWFuID0+XG4gICAgdHlwZW9mIHJhd1trZXldID09PSBcImJvb2xlYW5cIiA/IChyYXdba2V5XSBhcyBib29sZWFuKSA6IChiYXNlW2tleV0gYXMgYm9vbGVhbik7XG4gIHJldHVybiB7XG4gICAgLy8gQSBtaXNzaW5nIG9yIHVua25vd24gdmFsdWUgaXMgXCJvZmZcIi4gKFJlbW92ZWQga2V5cywgZnVuTW9kZSBhbmQgdW5yYXRlZFJhdGluZywgYXJlIGRyb3BwZWQuKVxuICAgIHN0YXNoUmF0aW5nczogb25lT2YocmF3LnN0YXNoUmF0aW5ncywgU1RBU0hfUkFUSU5HU19NT0RFUywgXCJvZmZcIiksXG4gICAgLy8gU2V0dXAgZmxhZ3MgaGF2ZSBubyBmYWxsYmFjazogcmF3IGFsd2F5cyBjYXJyaWVzIHRoZW0gKHN0b3JlZCBjb25maWcsIG9yIGN1cnJlbnQgKyBwYXRjaClcbiAgICBlbG9TZXR1cEF0OiB0eXBlb2YgcmF3LmVsb1NldHVwQXQgPT09IFwic3RyaW5nXCIgJiYgcmF3LmVsb1NldHVwQXQgPyByYXcuZWxvU2V0dXBBdCA6IG51bGwsXG4gICAgZWxvU2V0dXBNb2RlOiBFTE9fU1RBUlRTLmluY2x1ZGVzKHJhdy5lbG9TZXR1cE1vZGUgYXMgRWxvU3RhcnQpID8gKHJhdy5lbG9TZXR1cE1vZGUgYXMgRWxvU3RhcnQpIDogbnVsbCxcbiAgICBvcGVuSW5OZXdUYWI6IGJvb2woXCJvcGVuSW5OZXdUYWJcIiksXG4gICAgYXV0b3BsYXlQcmV2aWV3czogYm9vbChcImF1dG9wbGF5UHJldmlld3NcIiksXG4gICAgZmlsdGVyT3Bwb25lbnRzOiBib29sKFwiZmlsdGVyT3Bwb25lbnRzXCIpLFxuICAgIGNsZWFuTW9kZTogYm9vbChcImNsZWFuTW9kZVwiKSxcbiAgICBwYXVzZU1lZGlhT25PcGVuOiBib29sKFwicGF1c2VNZWRpYU9uT3BlblwiKSxcbiAgICBwbGFjZW1lbnRGcm9tQm90dG9tOiBib29sKFwicGxhY2VtZW50RnJvbUJvdHRvbVwiKSxcbiAgICBzaG93VGllcnM6IGJvb2woXCJzaG93VGllcnNcIiksXG4gICAgcHJldmlld1ZvbHVtZTogY2xhbXBQZXJjZW50KHJhdy5wcmV2aWV3Vm9sdW1lID8/IGJhc2UucHJldmlld1ZvbHVtZSwgYmFzZS5wcmV2aWV3Vm9sdW1lKSxcbiAgfTtcbn1cblxuLyoqIERlZmF1bHRzIG92ZXJsYWlkIHdpdGggdGhlIHByZS0yLjcgbG9jYWxTdG9yYWdlIHRvZ2dsZXMsIGZvciB1c2VycyB3aG8gbmV2ZXIgc2F2ZWQgc2V0dGluZ3MuICovXG5mdW5jdGlvbiBsZWdhY3lEZWZhdWx0cygpOiBTZXR0aW5ncyB7XG4gIGNvbnN0IHNldHRpbmdzID0geyAuLi5ERUZBVUxUX1NFVFRJTkdTIH07XG4gIHRyeSB7XG4gICAgaWYgKGxvY2FsU3RvcmFnZS5nZXRJdGVtKExFR0FDWV9GSUxURVJfT1BQT05FTlRTX0tFWSkgPT09IFwiMVwiKSBzZXR0aW5ncy5maWx0ZXJPcHBvbmVudHMgPSB0cnVlO1xuICAgIGlmIChsb2NhbFN0b3JhZ2UuZ2V0SXRlbShMRUdBQ1lfTVVURV9QUkVWSUVXU19LRVkpID09PSBcIjFcIikgc2V0dGluZ3MucHJldmlld1ZvbHVtZSA9IDA7XG4gIH0gY2F0Y2gge1xuICAgIC8qIGlnbm9yZSAqL1xuICB9XG4gIHJldHVybiBzZXR0aW5ncztcbn1cblxuLyoqXG4gKiBGZXRjaCBzZXR0aW5ncyBmcm9tIFN0YXNoIGludG8gc3RhdGUuc2V0dGluZ3MuIE9uIGZhaWx1cmUsIGtlZXBzIHRoZSBjdXJyZW50IHZhbHVlcyBhbmRcbiAqIHJldHVybnMgZmFsc2UuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBsb2FkU2V0dGluZ3MoKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIHRyeSB7XG4gICAgY29uc3Qgc3RvcmVkID0gYXdhaXQgZmV0Y2hTdG9yZWRDb25maWcoKTtcbiAgICBsZWdhY3lGdW5Nb2RlID0gc3RvcmVkPy5mdW5Nb2RlID09PSB0cnVlO1xuICAgIHN0YXRlLnNldHRpbmdzID0gc3RvcmVkID8gbm9ybWFsaXplKHN0b3JlZCwgREVGQVVMVF9TRVRUSU5HUykgOiBsZWdhY3lEZWZhdWx0cygpO1xuICAgIHJldHVybiB0cnVlO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIEZhaWxlZCB0byBsb2FkIHNldHRpbmdzLCB1c2luZyBjdXJyZW50IHZhbHVlczpcIiwgZSk7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbi8qKiBUcnVlIGlmIHRoZSBzdG9yZWQgY29uZmlnIHN0aWxsIGhhcyBwcmUtMy4wIGZ1biBtb2RlIHN3aXRjaGVkIG9uLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhhZEZ1bk1vZGUoKTogYm9vbGVhbiB7XG4gIHJldHVybiBsZWdhY3lGdW5Nb2RlO1xufVxuXG4vKiogU2V0dGluZ3MgY2hhbmdlZCBpbiB0aGlzIHRhYiBhbmQgbm90IHNhdmVkIHlldC4gKi9cbmNvbnN0IHVuc2F2ZWQgPSBuZXcgU2V0PGtleW9mIFNldHRpbmdzPigpO1xuXG4vKiogVGhlIHN0b3JlZCBjb25maWcgbWFwLCBmcmVzaCBmcm9tIFN0YXNoICh1bmRlZmluZWQgaWYgU3Rhc2ggQmF0dGxlIG5ldmVyIHNhdmVkIG9uZSkuICovXG5hc3luYyBmdW5jdGlvbiBmZXRjaFN0b3JlZENvbmZpZygpOiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgdW5kZWZpbmVkPiB7XG4gIGNvbnN0IGRhdGEgPSBhd2FpdCBncmFwaHFsUXVlcnk8eyBjb25maWd1cmF0aW9uOiB7IHBsdWdpbnM6IFJlY29yZDxzdHJpbmcsIFJlY29yZDxzdHJpbmcsIHVua25vd24+PiB9IH0+KFxuICAgIENPTkZJR19RVUVSWSxcbiAgKTtcbiAgcmV0dXJuIGRhdGEuY29uZmlndXJhdGlvbi5wbHVnaW5zPy5bUExVR0lOX0lEXTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcGVyc2lzdFNldHRpbmdzKCk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBjb25zdCBrZXlzID0gWy4uLnVuc2F2ZWRdO1xuICB1bnNhdmVkLmNsZWFyKCk7XG4gIHRyeSB7XG4gICAgLy8gY29uZmlndXJlUGx1Z2luIHJlcGxhY2VzIHRoZSB3aG9sZSBtYXAsIHNvIHRoaXMgdGFiJ3MgdW5zYXZlZCBjaGFuZ2VzIGdvIG9uIHRvcCBvZiB0aGVcbiAgICAvLyBzdG9yZWQgY29uZmlnLCBub3QgdGhpcyB0YWIncyBjb3B5IG9mIGl0OiBhbm90aGVyIHRhYiBtYXkgaGF2ZSBzYXZlZCBzaW5jZSB0aGlzIG9uZSBsb2FkZWRcbiAgICAvLyAoZmluaXNoZWQgdGhlIEVMTyBzZXR1cCwgc2F5KSwgYW5kIGFuIG9sZGVyIGNvcHkgd291bGQgdW5kbyB0aGF0LlxuICAgIGNvbnN0IHN0b3JlZCA9IGF3YWl0IGZldGNoU3RvcmVkQ29uZmlnKCk7XG4gICAgY29uc3QgbWVyZ2VkOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHN0b3JlZCA/IHsgLi4ubm9ybWFsaXplKHN0b3JlZCwgc3RhdGUuc2V0dGluZ3MpIH0gOiB7IC4uLnN0YXRlLnNldHRpbmdzIH07XG4gICAgZm9yIChjb25zdCBrZXkgb2Yga2V5cykgbWVyZ2VkW2tleV0gPSBzdGF0ZS5zZXR0aW5nc1trZXldO1xuICAgIC8vIFVuc2V0IGtleXMgYXJlIGxlZnQgb3V0XG4gICAgY29uc3QgaW5wdXQgPSBPYmplY3QuZnJvbUVudHJpZXMoT2JqZWN0LmVudHJpZXMobWVyZ2VkKS5maWx0ZXIoKFssIHZhbHVlXSkgPT4gdmFsdWUgIT09IG51bGwpKTtcbiAgICBhd2FpdCBncmFwaHFsUXVlcnkoQ09ORklHVVJFX1BMVUdJTl9NVVRBVElPTiwgeyBwbHVnaW5faWQ6IFBMVUdJTl9JRCwgaW5wdXQgfSk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0gRmFpbGVkIHRvIHNhdmUgc2V0dGluZ3M6XCIsIGUpO1xuICAgIGZvciAoY29uc3Qga2V5IG9mIGtleXMpIHVuc2F2ZWQuYWRkKGtleSk7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG59XG5cbi8qKiBVcGRhdGUgc2V0dGluZ3MgbG9jYWxseSByaWdodCBhd2F5IGFuZCBwZXJzaXN0IHRvIFN0YXNoIChkZWJvdW5jZWQsIGZvciBzbGlkZXJzKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiB1cGRhdGVTZXR0aW5ncyhwYXRjaDogUGFydGlhbDxTZXR0aW5ncz4pOiB2b2lkIHtcbiAgc3RhdGUuc2V0dGluZ3MgPSBub3JtYWxpemUoeyAuLi5zdGF0ZS5zZXR0aW5ncywgLi4ucGF0Y2ggfSwgc3RhdGUuc2V0dGluZ3MpO1xuICBmb3IgKGNvbnN0IGtleSBvZiBPYmplY3Qua2V5cyhwYXRjaCkgYXMgKGtleW9mIFNldHRpbmdzKVtdKSB1bnNhdmVkLmFkZChrZXkpO1xuICBpZiAoc2F2ZVRpbWVyKSBjbGVhclRpbWVvdXQoc2F2ZVRpbWVyKTtcbiAgc2F2ZVRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgc2F2ZVRpbWVyID0gbnVsbDtcbiAgICB2b2lkIHBlcnNpc3RTZXR0aW5ncygpO1xuICB9LCBTQVZFX0RFQk9VTkNFX01TKTtcbn1cblxuLyoqIFVwZGF0ZSBzZXR0aW5ncyBhbmQgc2F2ZSB0byBTdGFzaCByaWdodCBhd2F5IChubyBkZWJvdW5jZSkuIFJlc29sdmVzIGZhbHNlIGlmIHNhdmluZyBmYWlsZWQuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdXBkYXRlU2V0dGluZ3NOb3cocGF0Y2g6IFBhcnRpYWw8U2V0dGluZ3M+KTogUHJvbWlzZTxib29sZWFuPiB7XG4gIHN0YXRlLnNldHRpbmdzID0gbm9ybWFsaXplKHsgLi4uc3RhdGUuc2V0dGluZ3MsIC4uLnBhdGNoIH0sIHN0YXRlLnNldHRpbmdzKTtcbiAgZm9yIChjb25zdCBrZXkgb2YgT2JqZWN0LmtleXMocGF0Y2gpIGFzIChrZXlvZiBTZXR0aW5ncylbXSkgdW5zYXZlZC5hZGQoa2V5KTtcbiAgaWYgKHNhdmVUaW1lcikge1xuICAgIGNsZWFyVGltZW91dChzYXZlVGltZXIpO1xuICAgIHNhdmVUaW1lciA9IG51bGw7XG4gIH1cbiAgcmV0dXJuIHBlcnNpc3RTZXR0aW5ncygpO1xufVxuIiwgIi8vIFBlcnNpc3QvcmVzdG9yZSB0aGUgYmF0dGxlIHNlc3Npb24gdG8gbG9jYWxTdG9yYWdlLlxuXG5pbXBvcnQgeyBTVE9SQUdFX0tFWSB9IGZyb20gXCIuL2NvbnN0YW50c1wiO1xuaW1wb3J0IHsgc3RhdGUgfSBmcm9tIFwiLi9zdGF0ZVwiO1xuaW1wb3J0IHR5cGUgeyBNb2RlLCBQYWlyLCBQbGFjZW1lbnRSdW4sIFJhbmtzLCBTY2VuZSB9IGZyb20gXCIuL3R5cGVzXCI7XG5cbi8qKlxuICogQnVtcGVkIHdoZW4gc2F2ZWQgc2Vzc2lvbnMgY2FuJ3QgYmUgcmVzdG9yZWQgYXMgdGhleSBhcmUuIDMgKDMuMCk6IHNjZW5lcyBhcmUgcmFua2VkIGJ5IEVMT1xuICogZnJvbSBjdXN0b20gZmllbGRzLCB3aGljaCBvbGRlciBzYXZlZCBzY2VuZXMgbGFjaywgYW5kIEdhdW50bGV0IHJ1bnMgbm8gbG9uZ2VyIGV4aXN0LlxuICovXG5jb25zdCBTVEFURV9WRVJTSU9OID0gMztcblxuY29uc3QgTU9ERVM6IHJlYWRvbmx5IE1vZGVbXSA9IFtcInN3aXNzXCIsIFwicGxhY2VtZW50XCIsIFwiY2hhbXBpb25cIl07XG5cbmludGVyZmFjZSBQZXJzaXN0ZWRTdGF0ZSB7XG4gIHZlcnNpb24/OiBudW1iZXI7XG4gIGN1cnJlbnRQYWlyPzogUGFpcjtcbiAgY3VycmVudFJhbmtzPzogUmFua3M7XG4gIGN1cnJlbnRNb2RlPzogc3RyaW5nO1xuICBjaGFtcGlvblNjZW5lPzogU2NlbmUgfCBudWxsO1xuICBjaGFtcGlvbldpbnM/OiBudW1iZXI7XG4gIGNoYW1waW9uRGVmZWF0ZWQ/OiBzdHJpbmdbXTtcbiAgcGxhY2VtZW50PzogUGxhY2VtZW50UnVuIHwgbnVsbDtcbiAgdG90YWxTY2VuZXNDb3VudD86IG51bWJlcjtcbiAgc2F2ZWRGaWx0ZXJQYXJhbXM/OiBzdHJpbmc7XG59XG5cbi8qKiBBIHNhdmVkIG1vZGUgbmFtZSBhcyBhIGN1cnJlbnQgbW9kZTogR2F1bnRsZXQgYmVjYW1lIFBsYWNlbWVudCdzIFwiU3RhcnQgZnJvbSB0aGUgYm90dG9tXCIuICovXG5mdW5jdGlvbiByZXN0b3JlTW9kZShzYXZlZDogc3RyaW5nIHwgdW5kZWZpbmVkKTogTW9kZSB7XG4gIGlmIChzYXZlZCA9PT0gXCJnYXVudGxldFwiKSByZXR1cm4gXCJwbGFjZW1lbnRcIjtcbiAgcmV0dXJuIE1PREVTLmluY2x1ZGVzKHNhdmVkIGFzIE1vZGUpID8gKHNhdmVkIGFzIE1vZGUpIDogXCJzd2lzc1wiO1xufVxuXG4vKiogU2F2ZXMgdGhlIGN1cnJlbnQgYmF0dGxlIHNlc3Npb24gdG8gbG9jYWxTdG9yYWdlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNhdmVTdGF0ZSgpOiB2b2lkIHtcbiAgY29uc3Qgc25hcHNob3Q6IFBlcnNpc3RlZFN0YXRlID0ge1xuICAgIHZlcnNpb246IFNUQVRFX1ZFUlNJT04sXG4gICAgY3VycmVudFBhaXI6IHN0YXRlLmN1cnJlbnRQYWlyLFxuICAgIGN1cnJlbnRSYW5rczogc3RhdGUuY3VycmVudFJhbmtzLFxuICAgIGN1cnJlbnRNb2RlOiBzdGF0ZS5jdXJyZW50TW9kZSxcbiAgICBjaGFtcGlvblNjZW5lOiBzdGF0ZS5jaGFtcGlvblNjZW5lLFxuICAgIGNoYW1waW9uV2luczogc3RhdGUuY2hhbXBpb25XaW5zLFxuICAgIGNoYW1waW9uRGVmZWF0ZWQ6IHN0YXRlLmNoYW1waW9uRGVmZWF0ZWQsXG4gICAgcGxhY2VtZW50OiBzdGF0ZS5wbGFjZW1lbnQsXG4gICAgdG90YWxTY2VuZXNDb3VudDogc3RhdGUudG90YWxTY2VuZXNDb3VudCxcbiAgICBzYXZlZEZpbHRlclBhcmFtczogd2luZG93LmxvY2F0aW9uLnNlYXJjaCxcbiAgfTtcbiAgdHJ5IHtcbiAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShTVE9SQUdFX0tFWSwgSlNPTi5zdHJpbmdpZnkoc25hcHNob3QpKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnNvbGUuZXJyb3IoXCJbU3Rhc2ggQmF0dGxlXSBGYWlsZWQgdG8gc2F2ZSBzdGF0ZTpcIiwgZSk7XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGxvYWRTdGF0ZSgpOiBib29sZWFuIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBzYXZlZCA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFNUT1JBR0VfS0VZKTtcbiAgICBpZiAoc2F2ZWQpIHtcbiAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2Uoc2F2ZWQpIGFzIFBlcnNpc3RlZFN0YXRlO1xuICAgICAgc3RhdGUuY3VycmVudE1vZGUgPSByZXN0b3JlTW9kZShwYXJzZWQuY3VycmVudE1vZGUpO1xuICAgICAgc3RhdGUuc2F2ZWRGaWx0ZXJQYXJhbXMgPSBwYXJzZWQuc2F2ZWRGaWx0ZXJQYXJhbXMgfHwgXCJcIjtcbiAgICAgIGlmIChwYXJzZWQudmVyc2lvbiAhPT0gU1RBVEVfVkVSU0lPTikge1xuICAgICAgICAvLyBPbGRlciBzZXNzaW9ucyBob2xkIHNjZW5lcyB3aXRob3V0IEVMTzoga2VlcCB0aGUgbW9kZSwgc3RhcnQgYSBmcmVzaCBwYWlyIGFuZCBydW5cbiAgICAgICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5OLIFNhdmVkIHNlc3Npb24gaXMgZnJvbSBhbiBvbGRlciB2ZXJzaW9uLCBzdGFydGluZyBmcmVzaFwiKTtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICB9XG4gICAgICBzdGF0ZS5jdXJyZW50UGFpciA9IHBhcnNlZC5jdXJyZW50UGFpciB8fCB7IGxlZnQ6IG51bGwsIHJpZ2h0OiBudWxsIH07XG4gICAgICBzdGF0ZS5jdXJyZW50UmFua3MgPSBwYXJzZWQuY3VycmVudFJhbmtzIHx8IHsgbGVmdDogbnVsbCwgcmlnaHQ6IG51bGwgfTtcbiAgICAgIHN0YXRlLmNoYW1waW9uU2NlbmUgPSBwYXJzZWQuY2hhbXBpb25TY2VuZSA/PyBudWxsO1xuICAgICAgc3RhdGUuY2hhbXBpb25XaW5zID0gcGFyc2VkLmNoYW1waW9uV2lucyB8fCAwO1xuICAgICAgc3RhdGUuY2hhbXBpb25EZWZlYXRlZCA9IHBhcnNlZC5jaGFtcGlvbkRlZmVhdGVkIHx8IFtdO1xuICAgICAgc3RhdGUucGxhY2VtZW50ID0gcGFyc2VkLnBsYWNlbWVudCB8fCBudWxsO1xuICAgICAgc3RhdGUudG90YWxTY2VuZXNDb3VudCA9IHBhcnNlZC50b3RhbFNjZW5lc0NvdW50IHx8IDA7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0gRmFpbGVkIHRvIGxvYWQgc3RhdGU6XCIsIGUpO1xuICB9XG4gIHJldHVybiBmYWxzZTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNsZWFyU3RhdGUoKTogdm9pZCB7XG4gIHRyeSB7XG4gICAgbG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oU1RPUkFHRV9LRVkpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIEZhaWxlZCB0byBjbGVhciBzdGF0ZTpcIiwgZSk7XG4gIH1cbn1cbiIsICIvLyBBIHNtYWxsIGNvbmZpcm1hdGlvbiBkaWFsb2cgaW5zaWRlIHRoZSBTdGFzaCBCYXR0bGUgbW9kYWwgKHN3aXRjaGluZyBTdGFzaCByYXRpbmdzLCBSZXNldCBFTE8pLlxuLy8gVGhlIGNvbmZpcm0gYnV0dG9uIGNhbiBydW4gYW4gYXN5bmMgYWN0aW9uOiB0aGUgZGlhbG9nIHN0YXlzIG9wZW4gd2hpbGUgaXQgcnVucywgY2xvc2VzIHdoZW5cbi8vIGl0IHN1Y2NlZWRzLCBhbmQgc2hvd3MgdGhlIGVycm9yIGlmIGl0IGZhaWxzLlxuXG5leHBvcnQgaW50ZXJmYWNlIENvbmZpcm1EaWFsb2dPcHRpb25zIHtcbiAgdGl0bGU6IHN0cmluZztcbiAgLyoqIEhUTUwgYm9keS4gKi9cbiAgYm9keTogc3RyaW5nO1xuICBjb25maXJtTGFiZWw6IHN0cmluZztcbiAgLyoqIExhYmVsIG9uIHRoZSBjb25maXJtIGJ1dHRvbiB3aGlsZSBgYWN0aW9uYCBydW5zLiAqL1xuICB3b3JraW5nTGFiZWw/OiBzdHJpbmc7XG4gIC8qKiBSdW5zIG9uIGNvbmZpcm07IHRoZSBkaWFsb2cgcmVzb2x2ZXMgdHJ1ZSBvbmx5IG9uY2UgaXQgc3VjY2VlZHMuICovXG4gIGFjdGlvbj86ICgpID0+IFByb21pc2U8dm9pZD47XG59XG5cbmxldCBjYW5jZWxPcGVuOiAoKCkgPT4gdm9pZCkgfCBudWxsID0gbnVsbDtcblxuZXhwb3J0IGZ1bmN0aW9uIGlzQ29uZmlybURpYWxvZ09wZW4oKTogYm9vbGVhbiB7XG4gIHJldHVybiBjYW5jZWxPcGVuICE9PSBudWxsO1xufVxuXG4vKiogQ2FuY2VsIHRoZSBvcGVuIGRpYWxvZyAoRXNjYXBlKSwgdW5sZXNzIGl0cyBhY3Rpb24gaXMgcnVubmluZy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjYW5jZWxDb25maXJtRGlhbG9nKCk6IHZvaWQge1xuICBjYW5jZWxPcGVuPy4oKTtcbn1cblxuLyoqIFNob3cgdGhlIGRpYWxvZzsgcmVzb2x2ZXMgdHJ1ZSB3aGVuIGNvbmZpcm1lZCAoYW5kIGl0cyBhY3Rpb24gc3VjY2VlZGVkKSwgZmFsc2Ugd2hlbiBjYW5jZWxsZWQuICovXG5leHBvcnQgZnVuY3Rpb24gY29uZmlybURpYWxvZyhvcHRzOiBDb25maXJtRGlhbG9nT3B0aW9ucyk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBjYW5jZWxPcGVuPy4oKTtcbiAgY29uc3QgaG9zdCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic2ItbW9kYWxcIik7XG4gIGlmICghaG9zdCkgcmV0dXJuIFByb21pc2UucmVzb2x2ZShmYWxzZSk7XG5cbiAgY29uc3Qgb3ZlcmxheSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIG92ZXJsYXkuY2xhc3NOYW1lID0gXCJzYi1kaWFsb2ctYmFja2Ryb3BcIjtcbiAgb3ZlcmxheS5pbm5lckhUTUwgPSBgXG4gICAgICA8ZGl2IGNsYXNzPVwic2ItZGlhbG9nXCIgcm9sZT1cImRpYWxvZ1wiIGFyaWEtbW9kYWw9XCJ0cnVlXCIgYXJpYS1sYWJlbGxlZGJ5PVwic2ItZGlhbG9nLXRpdGxlXCI+XG4gICAgICAgIDxoMyBpZD1cInNiLWRpYWxvZy10aXRsZVwiIGNsYXNzPVwic2ItZGlhbG9nLXRpdGxlXCI+JHtvcHRzLnRpdGxlfTwvaDM+XG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi1kaWFsb2ctYm9keVwiPiR7b3B0cy5ib2R5fTwvZGl2PlxuICAgICAgICA8cCBjbGFzcz1cInNiLWRpYWxvZy1lcnJvclwiIGhpZGRlbj48L3A+XG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi1kaWFsb2ctYWN0aW9uc1wiPlxuICAgICAgICAgIDxidXR0b24gdHlwZT1cImJ1dHRvblwiIGNsYXNzPVwiYnRuIGJ0bi1zZWNvbmRhcnlcIiBkYXRhLXJvbGU9XCJjYW5jZWxcIj5DYW5jZWw8L2J1dHRvbj5cbiAgICAgICAgICA8YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cImJ0biBidG4tcHJpbWFyeVwiIGRhdGEtcm9sZT1cImNvbmZpcm1cIj4ke29wdHMuY29uZmlybUxhYmVsfTwvYnV0dG9uPlxuICAgICAgICA8L2Rpdj5cbiAgICAgIDwvZGl2PmA7XG4gIGhvc3QuYXBwZW5kQ2hpbGQob3ZlcmxheSk7XG5cbiAgY29uc3QgY29uZmlybUJ0biA9IG92ZXJsYXkucXVlcnlTZWxlY3RvcjxIVE1MQnV0dG9uRWxlbWVudD4oJ1tkYXRhLXJvbGU9XCJjb25maXJtXCJdJykgYXMgSFRNTEJ1dHRvbkVsZW1lbnQ7XG4gIGNvbnN0IGNhbmNlbEJ0biA9IG92ZXJsYXkucXVlcnlTZWxlY3RvcjxIVE1MQnV0dG9uRWxlbWVudD4oJ1tkYXRhLXJvbGU9XCJjYW5jZWxcIl0nKSBhcyBIVE1MQnV0dG9uRWxlbWVudDtcbiAgY29uc3QgZXJyb3IgPSBvdmVybGF5LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiLnNiLWRpYWxvZy1lcnJvclwiKSBhcyBIVE1MRWxlbWVudDtcbiAgY29uZmlybUJ0bi5mb2N1cygpO1xuXG4gIHJldHVybiBuZXcgUHJvbWlzZTxib29sZWFuPigocmVzb2x2ZSkgPT4ge1xuICAgIGxldCBidXN5ID0gZmFsc2U7XG4gICAgY29uc3QgY2xvc2UgPSAocmVzdWx0OiBib29sZWFuKTogdm9pZCA9PiB7XG4gICAgICBvdmVybGF5LnJlbW92ZSgpO1xuICAgICAgY2FuY2VsT3BlbiA9IG51bGw7XG4gICAgICByZXNvbHZlKHJlc3VsdCk7XG4gICAgfTtcbiAgICBjYW5jZWxPcGVuID0gKCkgPT4ge1xuICAgICAgaWYgKCFidXN5KSBjbG9zZShmYWxzZSk7XG4gICAgfTtcblxuICAgIGNhbmNlbEJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4gY2FuY2VsT3Blbj8uKCkpO1xuICAgIG92ZXJsYXkuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XG4gICAgICBpZiAoZS50YXJnZXQgPT09IG92ZXJsYXkpIGNhbmNlbE9wZW4/LigpO1xuICAgIH0pO1xuICAgIGNvbmZpcm1CdG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIGFzeW5jICgpID0+IHtcbiAgICAgIGlmICghb3B0cy5hY3Rpb24pIHtcbiAgICAgICAgY2xvc2UodHJ1ZSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGJ1c3kgPSB0cnVlO1xuICAgICAgZXJyb3IuaGlkZGVuID0gdHJ1ZTtcbiAgICAgIGNvbmZpcm1CdG4uZGlzYWJsZWQgPSBjYW5jZWxCdG4uZGlzYWJsZWQgPSB0cnVlO1xuICAgICAgY29uZmlybUJ0bi50ZXh0Q29udGVudCA9IG9wdHMud29ya2luZ0xhYmVsID8/IFwiV29ya2luZy4uLlwiO1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgb3B0cy5hY3Rpb24oKTtcbiAgICAgICAgY2xvc2UodHJ1ZSk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGJ1c3kgPSBmYWxzZTtcbiAgICAgICAgY29uZmlybUJ0bi5kaXNhYmxlZCA9IGNhbmNlbEJ0bi5kaXNhYmxlZCA9IGZhbHNlO1xuICAgICAgICBjb25maXJtQnRuLnRleHRDb250ZW50ID0gb3B0cy5jb25maXJtTGFiZWw7XG4gICAgICAgIGVycm9yLnRleHRDb250ZW50ID0gYFRoYXQgZGlkbid0IHdvcms6ICR7ZSBpbnN0YW5jZW9mIEVycm9yID8gZS5tZXNzYWdlIDogU3RyaW5nKGUpfS4gWW91IGNhbiB0cnkgYWdhaW4uYDtcbiAgICAgICAgZXJyb3IuaGlkZGVuID0gZmFsc2U7XG4gICAgICB9XG4gICAgfSk7XG4gIH0pO1xufVxuIiwgIi8vIFNQQSBuYXZpZ2F0aW9uIGhlbHBlcnMuXHJcblxyXG5pbXBvcnQgeyBjbG9zZU1vZGFsIH0gZnJvbSBcIi4vdWkvbW9kYWxcIjtcclxuXHJcbi8vIE5hdmlnYXRlIHVzaW5nIFJlYWN0IFJvdXRlciAocHJlc2VydmVzIEpTIHN0YXRlKVxyXG5leHBvcnQgZnVuY3Rpb24gbmF2aWdhdGVUb1VybCh1cmw6IHN0cmluZyk6IHZvaWQge1xyXG4gIGNsb3NlTW9kYWwoKTtcclxuXHJcbiAgLy8gVXNlIEhpc3RvcnkgQVBJICsgcG9wc3RhdGUgZXZlbnQgdG8gdHJpZ2dlciBSZWFjdCBSb3V0ZXIgbmF2aWdhdGlvblxyXG4gIGNvbnN0IHBhdGggPSB1cmwuc3RhcnRzV2l0aChcIi9cIikgPyB1cmwgOiBuZXcgVVJMKHVybCkucGF0aG5hbWUgKyBuZXcgVVJMKHVybCkuc2VhcmNoO1xyXG4gIHdpbmRvdy5oaXN0b3J5LnB1c2hTdGF0ZSh7fSwgXCJcIiwgcGF0aCk7XHJcbiAgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IFBvcFN0YXRlRXZlbnQoXCJwb3BzdGF0ZVwiLCB7IHN0YXRlOiB7fSB9KSk7XHJcbn1cclxuIiwgIi8vIFBsYWNlbWVudCBzZWFyY2gsIGtlcHQgcHVyZSAobm8gc3RhdGUgb3IgSS9PKSBzbyB3aG9sZSBydW5zIGNhbiBiZSBzaW11bGF0ZWQgaW4gdGVzdHMuXG4vL1xuLy8gVGhlIHNjZW5lJ3Mgc2xvdCBsaWVzIGluIFtsbywgaGkpIG9mIHRoZSBFTE8tc29ydGVkIG9wcG9uZW50IHBvb2wuIEEgd2luIGFnYWluc3QgaW5kZXggaVxuLy8gbWVhbnMgdGhlIHNsb3QgaXMgYWJvdmUgaSAoaGkgPSBpKTsgYSBsb3NzIG1lYW5zIGl0J3MgYmVsb3cgKGxvID0gaSArIDEpLiBBIHJhdGVkIHNjZW5lIHN0YXJ0c1xuLy8gbmV4dCB0byBpdHMgY3VycmVudCBFTE8gYW5kIGdhbGxvcHMgKHN0ZXBzIDEsIDIsIDQsIDguLi4pIHdoaWxlIHJlc3VsdHMga2VlcCBnb2luZyB0aGUgc2FtZVxuLy8gd2F5OyB0aGUgZmlyc3QgcmV2ZXJzYWwgKG9yIGFuIHVucmF0ZWQgc2NlbmUpIHN3aXRjaGVzIHRvIGhhbHZpbmcgdGhlIHJlbWFpbmluZyByYW5nZS5cbi8vIFwiU3RhcnQgZnJvbSB0aGUgYm90dG9tXCIgcnVucyBpZ25vcmUgdGhlIHNjZW5lJ3MgRUxPOiB0aGV5IHN0YXJ0IGFnYWluc3QgdGhlIGJvdHRvbSBzY2VuZSBhbmRcbi8vIGdhbGxvcCB1cHdhcmQsIHNvIGVhY2ggd2luIGRvdWJsZXMgdGhlIGp1bXAgdW50aWwgdGhlIGZpcnN0IGxvc3MuXG5cbmltcG9ydCB7IFBMQUNFTUVOVF9NQVhfSlVNUF9TSEFSRSwgUExBQ0VNRU5UX01JTl9NQVhfSlVNUCB9IGZyb20gXCIuL2NvbnN0YW50c1wiO1xuaW1wb3J0IHsgZWxvLCBlbG9JbnNlcnRpb25JbmRleCwgcGxhY2VtZW50RWxvIH0gZnJvbSBcIi4vc2NvcmVcIjtcbmltcG9ydCB0eXBlIHsgUGxhY2VtZW50UnVuLCBTY2VuZSB9IGZyb20gXCIuL3R5cGVzXCI7XG5cbmV4cG9ydCBmdW5jdGlvbiBuZXdQbGFjZW1lbnRSdW4oc2NlbmU6IFNjZW5lLCBmcm9tQm90dG9tOiBib29sZWFuKTogUGxhY2VtZW50UnVuIHtcbiAgcmV0dXJuIHtcbiAgICBzY2VuZSxcbiAgICBmcm9tQm90dG9tLFxuICAgIGFib3ZlSWQ6IG51bGwsXG4gICAgYmVsb3dJZDogbnVsbCxcbiAgICBsYXN0T3Bwb25lbnRJZDogbnVsbCxcbiAgICBsYXN0V29uOiBudWxsLFxuICAgIGdhbGxvcGluZzogZnJvbUJvdHRvbSB8fCBlbG8oc2NlbmUpICE9PSBudWxsLFxuICAgIHN0ZXA6IDEsXG4gICAgYmF0dGxlczogMCxcbiAgICBzdHJlYWs6IDAsXG4gICAgcmFuZ2VMbzogMCxcbiAgICByYW5nZUhpOiAwLFxuICB9O1xufVxuXG4vKiogSW5kZXggb2YgdGhlIGVuZCBvZiBwb29sW2lkeF0ncyB0aWUgZ3JvdXAgKHNjZW5lcyB3aXRoIHRoZSBzYW1lIEVMTykgaW4gZGlyZWN0aW9uIGBkaXJgLiAqL1xuZnVuY3Rpb24gdGllR3JvdXBFZGdlKHBvb2w6IFNjZW5lW10sIGlkeDogbnVtYmVyLCBkaXI6IDEgfCAtMSk6IG51bWJlciB7XG4gIGNvbnN0IHZhbHVlID0gZWxvKHBvb2xbaWR4XSk7XG4gIGxldCBlZGdlID0gaWR4O1xuICB3aGlsZSAoZWRnZSArIGRpciA+PSAwICYmIGVkZ2UgKyBkaXIgPCBwb29sLmxlbmd0aCAmJiBlbG8ocG9vbFtlZGdlICsgZGlyXSkgPT09IHZhbHVlKSBlZGdlICs9IGRpcjtcbiAgcmV0dXJuIGVkZ2U7XG59XG5cbi8qKlxuICogQ3VycmVudCBbbG8sIGhpKSBzbG90IGJvdW5kcywgcmVzb2x2ZWQgZnJvbSB0aGUgYm91bmRpbmcgb3Bwb25lbnRzJyBpZHMuIEEgcmVzdWx0IGNvdW50cyBmb3JcbiAqIHRoZSBvcHBvbmVudCdzIHdob2xlIHRpZSBncm91cDogYSBzY2VuZSBjYW4gb25seSBnZXQgYW4gRUxPIGFib3ZlIG9yIGJlbG93IGEgZ3JvdXAgb2YgZXF1YWxcbiAqIEVMT3MsIG5vdCBpbnNpZGUgaXQsIHNvIHRoZSBzbG90IGFsd2F5cyBlbmRzIGF0IGEgZ3JvdXAncyBlZGdlIGFuZCB0aGUgbGFuZGluZyBFTE8ga2VlcHMgaXQgdGhlcmUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwbGFjZW1lbnRCb3VuZHMocnVuOiBQbGFjZW1lbnRSdW4sIHBvb2w6IFNjZW5lW10pOiB7IGxvOiBudW1iZXI7IGhpOiBudW1iZXIgfSB7XG4gIGNvbnN0IGFib3ZlSWR4ID0gcnVuLmFib3ZlSWQgPyBwb29sLmZpbmRJbmRleCgocykgPT4gcy5pZCA9PT0gcnVuLmFib3ZlSWQpIDogLTE7XG4gIGNvbnN0IGJlbG93SWR4ID0gcnVuLmJlbG93SWQgPyBwb29sLmZpbmRJbmRleCgocykgPT4gcy5pZCA9PT0gcnVuLmJlbG93SWQpIDogLTE7XG4gIHJldHVybiB7XG4gICAgbG86IGFib3ZlSWR4ID49IDAgPyB0aWVHcm91cEVkZ2UocG9vbCwgYWJvdmVJZHgsIDEpICsgMSA6IDAsXG4gICAgaGk6IGJlbG93SWR4ID49IDAgPyB0aWVHcm91cEVkZ2UocG9vbCwgYmVsb3dJZHgsIC0xKSA6IHBvb2wubGVuZ3RoLFxuICB9O1xufVxuXG4vKiogVGhlIHBvb2wncyBsb3dlc3Qgc2NlbmUgd2l0aCBhbiBFTE8gKHVucmF0ZWQgb25lcyBzb3J0IGxhc3QpLCBvciBpdHMgbGFzdCBzY2VuZSBpZiBub25lIGhhcyBvbmUuICovXG5leHBvcnQgZnVuY3Rpb24gYm90dG9tSW5kZXgocG9vbDogU2NlbmVbXSk6IG51bWJlciB7XG4gIGZvciAobGV0IGkgPSBwb29sLmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7XG4gICAgaWYgKGVsbyhwb29sW2ldKSAhPT0gbnVsbCkgcmV0dXJuIGk7XG4gIH1cbiAgcmV0dXJuIHBvb2wubGVuZ3RoIC0gMTtcbn1cblxuLyoqIExhcmdlc3QganVtcCBhIGdhbGxvcGluZyBydW4gbWFrZXMgaW4gdGhpcyBwb29sIChzZWUgUExBQ0VNRU5UX01BWF9KVU1QX1NIQVJFKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtYXhQbGFjZW1lbnRKdW1wKHBvb2xTaXplOiBudW1iZXIpOiBudW1iZXIge1xuICByZXR1cm4gTWF0aC5tYXgoUExBQ0VNRU5UX01JTl9NQVhfSlVNUCwgTWF0aC5yb3VuZChwb29sU2l6ZSAqIFBMQUNFTUVOVF9NQVhfSlVNUF9TSEFSRSkpO1xufVxuXG4vKiogV2hlcmUgdGhlIG5leHQgb3Bwb25lbnQgc2hvdWxkIGNvbWUgZnJvbSAoYmVmb3JlIGNsYW1waW5nIGludG8gW2xvLCBoaSkpLiAqL1xuZnVuY3Rpb24gbmV4dFBsYWNlbWVudEluZGV4KHJ1bjogUGxhY2VtZW50UnVuLCBwb29sOiBTY2VuZVtdLCBsbzogbnVtYmVyLCBoaTogbnVtYmVyKTogbnVtYmVyIHtcbiAgaWYgKHJ1bi5nYWxsb3BpbmcpIHtcbiAgICBpZiAocnVuLmxhc3RPcHBvbmVudElkID09PSBudWxsKSB7XG4gICAgICBpZiAocnVuLmZyb21Cb3R0b20pIHJldHVybiBib3R0b21JbmRleChwb29sKTtcbiAgICAgIC8vIFN0YXJ0IGp1c3QgYmVsb3cgdGhlIHNjZW5lJ3MgY3VycmVudCBFTE86IGEgY29ycmVjdGx5IHJhdGVkIHNjZW5lIGNvbmZpcm1zIGluIH4yIGJhdHRsZXNcbiAgICAgIHJldHVybiBlbG9JbnNlcnRpb25JbmRleChwb29sLCBlbG8ocnVuLnNjZW5lKSA/PyAwKTtcbiAgICB9XG4gICAgY29uc3QgbGFzdElkeCA9IHBvb2wuZmluZEluZGV4KChzKSA9PiBzLmlkID09PSBydW4ubGFzdE9wcG9uZW50SWQpO1xuICAgIGlmIChsYXN0SWR4ID49IDApIHtcbiAgICAgIC8vIFN0ZXAgZnJvbSB0aGUgZmFyIGVkZ2Ugb2YgdGhlIGxhc3Qgb3Bwb25lbnQncyB0aWUgZ3JvdXA6IGFub3RoZXIgZXF1YWwgRUxPIHRlYWNoZXMgbm90aGluZ1xuICAgICAgY29uc3QgZGlyID0gcnVuLmxhc3RXb24gPyAtMSA6IDE7XG4gICAgICBjb25zdCB0YXJnZXQgPSB0aWVHcm91cEVkZ2UocG9vbCwgbGFzdElkeCwgZGlyKSArIGRpciAqIE1hdGgubWluKHJ1bi5zdGVwLCBtYXhQbGFjZW1lbnRKdW1wKHBvb2wubGVuZ3RoKSk7XG4gICAgICAvLyBBIGp1bXAgcGFzdCB0aGUgc2VhcmNoIHJhbmdlIHdvdWxkIGxhbmQgb24gaXRzIGVuZCAoc3RyYWlnaHQgdG8gIzEsIHNheSk6IGhhbHZlIGluc3RlYWRcbiAgICAgIGlmICh0YXJnZXQgPj0gbG8gJiYgdGFyZ2V0IDwgaGkpIHJldHVybiB0YXJnZXQ7XG4gICAgfVxuICB9XG4gIHJldHVybiBsbyArIE1hdGguZmxvb3IoKGhpIC0gbG8pIC8gMik7XG59XG5cbmV4cG9ydCB0eXBlIFBsYWNlbWVudFN0ZXAgPVxuICB8IHsgZG9uZTogdHJ1ZTsgc2xvdDogbnVtYmVyOyBsbzogbnVtYmVyOyBoaTogbnVtYmVyIH1cbiAgfCB7IGRvbmU6IGZhbHNlOyBpbmRleDogbnVtYmVyOyBsbzogbnVtYmVyOyBoaTogbnVtYmVyIH07XG5cbi8qKiBUaGUgcnVuJ3MgbmV4dCBzdGVwIG9uIHRoaXMgcG9vbDogdGhlIG9wcG9uZW50IGluZGV4IHRvIGJhdHRsZSwgb3IgdGhlIHNsb3QgaXQgaGFzIGxhbmRlZCBpbi4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwbGFjZW1lbnRTdGVwKHJ1bjogUGxhY2VtZW50UnVuLCBwb29sOiBTY2VuZVtdKTogUGxhY2VtZW50U3RlcCB7XG4gIGNvbnN0IHsgbG8sIGhpIH0gPSBwbGFjZW1lbnRCb3VuZHMocnVuLCBwb29sKTtcbiAgaWYgKGxvID49IGhpKSByZXR1cm4geyBkb25lOiB0cnVlLCBzbG90OiBNYXRoLm1pbihsbywgaGkpLCBsbywgaGkgfTtcbiAgY29uc3QgaW5kZXggPSBNYXRoLm1heChsbywgTWF0aC5taW4oaGkgLSAxLCBuZXh0UGxhY2VtZW50SW5kZXgocnVuLCBwb29sLCBsbywgaGkpKSk7XG4gIHJldHVybiB7IGRvbmU6IGZhbHNlLCBpbmRleCwgbG8sIGhpIH07XG59XG5cbi8qKiBSZWNvcmQgYSBwbGFjZW1lbnQgYmF0dGxlIHJlc3VsdCBhbmQgdXBkYXRlIHRoZSBtb21lbnR1bSBhbmQgdGhlIHdpbiBzdHJlYWsuICovXG5leHBvcnQgZnVuY3Rpb24gcmVjb3JkUGxhY2VtZW50UmVzdWx0KHJ1bjogUGxhY2VtZW50UnVuLCB3b246IGJvb2xlYW4sIG9wcG9uZW50SWQ6IHN0cmluZyk6IHZvaWQge1xuICBpZiAocnVuLmxhc3RXb24gIT09IG51bGwpIHtcbiAgICBpZiAocnVuLmxhc3RXb24gPT09IHdvbikgcnVuLnN0ZXAgKj0gMjtcbiAgICBlbHNlIHJ1bi5nYWxsb3BpbmcgPSBmYWxzZTtcbiAgfVxuICBpZiAod29uKSBydW4uYmVsb3dJZCA9IG9wcG9uZW50SWQ7XG4gIGVsc2UgcnVuLmFib3ZlSWQgPSBvcHBvbmVudElkO1xuXG4gIC8vIFRoZSBzdHJlYWsgY291bnRzIHdpbnMgdW50aWwgdGhlIGZpcnN0IGxvc3MsIHNvIGl0IG9ubHkgZ3Jvd3Mgd2hpbGUgZXZlcnkgYmF0dGxlIHdhcyBhIHdpblxuICBpZiAod29uICYmIHJ1bi5zdHJlYWsgPT09IHJ1bi5iYXR0bGVzKSBydW4uc3RyZWFrKys7XG4gIHJ1bi5sYXN0T3Bwb25lbnRJZCA9IG9wcG9uZW50SWQ7XG4gIHJ1bi5sYXN0V29uID0gd29uO1xuICBydW4uYmF0dGxlcysrO1xufVxuXG4vKipcbiAqIEVMTyBmb3IgYSBzY2VuZSBsYW5kaW5nIGF0IGBzbG90YCBvZiB0aGUgcG9vbDogYmV0d2VlbiB0aGUgbmVhcmVzdCBuZWlnaGJvdXJzIHRoYXQgaGF2ZSBhbiBFTE9cbiAqICh1bnJhdGVkIG9wcG9uZW50cywgcG9zc2libGUgaW4gYSBmaWx0ZXJlZCBwb29sLCBzYXkgbm90aGluZyBhYm91dCBpdCkuIFNlZSBwbGFjZW1lbnRFbG8uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBsYW5kaW5nRWxvKHBvb2w6IFNjZW5lW10sIHNsb3Q6IG51bWJlcik6IG51bWJlciB7XG4gIGxldCBhYm92ZTogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG4gIGZvciAobGV0IGkgPSBzbG90IC0gMTsgaSA+PSAwICYmIGFib3ZlID09PSBudWxsOyBpLS0pIGFib3ZlID0gZWxvKHBvb2xbaV0pO1xuICBsZXQgYmVsb3c6IG51bWJlciB8IG51bGwgPSBudWxsO1xuICBmb3IgKGxldCBpID0gc2xvdDsgaSA8IHBvb2wubGVuZ3RoICYmIGJlbG93ID09PSBudWxsOyBpKyspIGJlbG93ID0gZWxvKHBvb2xbaV0pO1xuICByZXR1cm4gcGxhY2VtZW50RWxvKGFib3ZlLCBiZWxvdyk7XG59XG4iLCAiLy8gTWF0Y2htYWtpbmc6IGJ1aWxkIHRoZSBzY2VuZSBwYWlycyBmb3IgZWFjaCBjb21wYXJpc29uIG1vZGUuXG5cbmltcG9ydCB7IGNsZWFyRmlsdGVyZWRDYWNoZSwgZ2V0QWxsU2NlbmVzQ2FjaGVkLCBnZXRGaWx0ZXJlZFNjZW5lc0NhY2hlZCwgbGF0ZXN0U2NlbmUgfSBmcm9tIFwiLi9jYWNoZVwiO1xuaW1wb3J0IHtcbiAgQ0hBTVBJT05fVU5SQVRFRF9FTE8sXG4gIENMSU1CX09QUE9ORU5UX1BJQ0tfV0lORE9XLFxuICBTV0lTU19PUFBPTkVOVF9FTE9fV0lORE9XLFxuICBTV0lTU19PUFBPTkVOVF9NSU5fQ0FORElEQVRFUyxcbn0gZnJvbSBcIi4vY29uc3RhbnRzXCI7XG5pbXBvcnQgeyByZWFkRmlsdGVycywgdHlwZSBMaXN0RmlsdGVycyB9IGZyb20gXCIuL2ZpbHRlcnNcIjtcbmltcG9ydCB7IGxhbmRpbmdFbG8sIG5ld1BsYWNlbWVudFJ1biwgcGxhY2VtZW50U3RlcCB9IGZyb20gXCIuL3BsYWNlbWVudFwiO1xuaW1wb3J0IHsgd3JpdGVFbG8gfSBmcm9tIFwiLi9yYXRpbmdcIjtcbmltcG9ydCB7IGJhdHRsZXMsIGVmZmVjdGl2ZUVsbywgZWxvLCBpc1JhdGVkLCBzd2lzc09wcG9uZW50SW5kZXhlcyB9IGZyb20gXCIuL3Njb3JlXCI7XG5pbXBvcnQgeyBzdGF0ZSB9IGZyb20gXCIuL3N0YXRlXCI7XG5pbXBvcnQgdHlwZSB7IENoYW1waW9uUGFpclJlc3VsdCwgUGxhY2VtZW50UGFpclJlc3VsdCwgUmFuaywgU2NlbmUsIFN3aXNzUGFpclJlc3VsdCB9IGZyb20gXCIuL3R5cGVzXCI7XG5cbmZ1bmN0aW9uIHNodWZmbGVBcnJheTxUPihhcnJheTogVFtdKTogVFtdIHtcbiAgY29uc3Qgc2h1ZmZsZWQgPSBbLi4uYXJyYXldO1xuICBmb3IgKGxldCBpID0gc2h1ZmZsZWQubGVuZ3RoIC0gMTsgaSA+IDA7IGktLSkge1xuICAgIGNvbnN0IGogPSBNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkgKiAoaSArIDEpKTtcbiAgICBbc2h1ZmZsZWRbaV0sIHNodWZmbGVkW2pdXSA9IFtzaHVmZmxlZFtqXSwgc2h1ZmZsZWRbaV1dO1xuICB9XG4gIHJldHVybiBzaHVmZmxlZDtcbn1cblxuLy8gVHJhY2sgbGFzdCBzY2VuZSB0byBhdm9pZCBpbW1lZGlhdGUgcmVwZWF0IGFmdGVyIHJlc2h1ZmZsZVxubGV0IGxhc3RTaG93blNjZW5lSWQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG4vKiogVHJ1ZSBvbmNlIGV2ZXJ5IHNjZW5lIGluIHRoZSBjdXJyZW50IHNodWZmbGUgaGFzIGJlZW4gc2hvd24gKHRpbWUgdG8gcmUtcXVlcnkgdGhlIGZpbHRlcikuICovXG5mdW5jdGlvbiBpc1NodWZmbGVDeWNsZUNvbXBsZXRlKGZpbHRlcktleTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiAoXG4gICAgc3RhdGUuc2h1ZmZsZUZpbHRlcktleSA9PT0gZmlsdGVyS2V5ICYmXG4gICAgc3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lcy5sZW5ndGggPiAwICYmXG4gICAgc3RhdGUuc2h1ZmZsZUluZGV4ID49IHN0YXRlLnNodWZmbGVkRmlsdGVyZWRTY2VuZXMubGVuZ3RoXG4gICk7XG59XG5cbi8qKiBSZXNodWZmbGUgdGhlIGxlZnQgcG9vbCBmb3IgYSBuZXcgcGFzcywgd2l0aG91dCBzaG93aW5nIHRoZSBwcmV2aW91cyBwYXNzJ3MgbGFzdCBzY2VuZSBmaXJzdC4gKi9cbmZ1bmN0aW9uIHN0YXJ0TmV3UGFzcyhsZWZ0UG9vbDogU2NlbmVbXSk6IHZvaWQge1xuICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCflIAgUmVzaHVmZmxpbmcgKGNvbXBsZXRlZCBmdWxsIGN5Y2xlKVwiKTtcbiAgc3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lcyA9IHNodWZmbGVBcnJheShsZWZ0UG9vbCk7XG4gIHN0YXRlLnNodWZmbGVJbmRleCA9IDA7XG5cbiAgaWYgKFxuICAgIGxhc3RTaG93blNjZW5lSWQgJiZcbiAgICBzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzLmxlbmd0aCA+IDEgJiZcbiAgICBzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzWzBdLmlkID09PSBsYXN0U2hvd25TY2VuZUlkXG4gICkge1xuICAgIGNvbnN0IHN3YXBJZHggPSAxICsgTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogKHN0YXRlLnNodWZmbGVkRmlsdGVyZWRTY2VuZXMubGVuZ3RoIC0gMSkpO1xuICAgIFtzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzWzBdLCBzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzW3N3YXBJZHhdXSA9IFtcbiAgICAgIHN0YXRlLnNodWZmbGVkRmlsdGVyZWRTY2VuZXNbc3dhcElkeF0sXG4gICAgICBzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzWzBdLFxuICAgIF07XG4gICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5SEIFN3YXBwZWQgZmlyc3Qgc2NlbmUgdG8gYXZvaWQgcmVwZWF0XCIpO1xuICB9XG59XG5cbi8qKiBOZXh0IGxlZnQtc2lkZSBzY2VuZSBmcm9tIHRoZSBzaHVmZmxlZCBsZWZ0IHBvb2wgKG5vIG5ldHdvcmsgZmV0Y2gpLiBTY2VuZXMgc3RheSBpbiB0aGUgcG9vbC4gKi9cbmZ1bmN0aW9uIGdldE5leHRGaWx0ZXJlZFNjZW5lKGxlZnRQb29sOiBTY2VuZVtdLCBmaWx0ZXJLZXk6IHN0cmluZyk6IFNjZW5lIHwgbnVsbCB7XG4gIGlmIChsZWZ0UG9vbC5sZW5ndGggPT09IDApIHtcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCfj4EgRmlsdGVyZWQgcG9vbCBpcyBlbXB0eVwiKTtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIGlmIChmaWx0ZXJLZXkgIT09IHN0YXRlLnNodWZmbGVGaWx0ZXJLZXkgfHwgc3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lcy5sZW5ndGggPT09IDApIHtcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCflIAgU2h1ZmZsaW5nIGZpbHRlcmVkIHNjZW5lcyAoZmlsdGVyIGNoYW5nZWQgb3IgZmlyc3QgbG9hZClcIik7XG4gICAgc3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lcyA9IHNodWZmbGVBcnJheShsZWZ0UG9vbCk7XG4gICAgc3RhdGUuc2h1ZmZsZUluZGV4ID0gMDtcbiAgICBzdGF0ZS5zaHVmZmxlRmlsdGVyS2V5ID0gZmlsdGVyS2V5O1xuICAgIGxhc3RTaG93blNjZW5lSWQgPSBudWxsO1xuICB9XG5cbiAgaWYgKHN0YXRlLnNodWZmbGVJbmRleCA+PSBzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzLmxlbmd0aCkge1xuICAgIHN0YXJ0TmV3UGFzcyhsZWZ0UG9vbCk7XG4gIH1cblxuICBjb25zdCBzaHVmZmxlZCA9IHN0YXRlLnNodWZmbGVkRmlsdGVyZWRTY2VuZXNbc3RhdGUuc2h1ZmZsZUluZGV4XTtcbiAgLy8gVGhlIHNodWZmbGUga2VlcHMgaXRzIHBhc3MncyBzY2VuZSBvYmplY3RzOyBhIGJhY2tncm91bmQgcmVmcmVzaCBtYXkgaGF2ZSByZXBsYWNlZCB0aGVtIHNpbmNlXG4gIGNvbnN0IHNjZW5lID0gbGVmdFBvb2wuZmluZCgocykgPT4gcy5pZCA9PT0gc2h1ZmZsZWQuaWQpID8/IHNodWZmbGVkO1xuICBzdGF0ZS5zaHVmZmxlSW5kZXgrKztcbiAgbGFzdFNob3duU2NlbmVJZCA9IHNjZW5lLmlkO1xuICBjb25zb2xlLmxvZyhcbiAgICBgW1N0YXNoIEJhdHRsZV0g8J+TjSBQaWNrZWQgc2NlbmUgJHtzY2VuZS5pZH0gKCR7c3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lcy5sZW5ndGggLSBzdGF0ZS5zaHVmZmxlSW5kZXh9IGxlZnQgaW4gdGhpcyBwYXNzKWAsXG4gICk7XG4gIHJldHVybiBzY2VuZTtcbn1cblxuLyoqXG4gKiBPcHBvbmVudHMgKHJpZ2h0IHNpZGUpLCBzb3J0ZWQgYnkgRUxPOiBzY2VuZXMgd2l0aCBhbiBFTE8sIG9yIHRoZSBmaWx0ZXJlZCBzY2VuZXMgd2hlbiBcInVzZVxuICogZmlsdGVyZWQgc2NlbmVzIGZvciBib3RoIHNpZGVzXCIgaXMgb24gKHVucmF0ZWQgb25lcyB0aGVuIHNvcnQgbGFzdCkuXG4gKi9cbmZ1bmN0aW9uIGJ1aWxkT3Bwb25lbnRQb29sKGFsbFNjZW5lczogU2NlbmVbXSwgbGVmdFBvb2w6IFNjZW5lW10sIGZpbHRlcnM6IExpc3RGaWx0ZXJzKTogU2NlbmVbXSB7XG4gIGlmIChzdGF0ZS5zZXR0aW5ncy5maWx0ZXJPcHBvbmVudHMgJiYgZmlsdGVycy5maWx0ZXJBY3RpdmUpIHtcbiAgICByZXR1cm4gbGVmdFBvb2w7XG4gIH1cbiAgY29uc3QgcmF0ZWQgPSBhbGxTY2VuZXMuZmlsdGVyKGlzUmF0ZWQpO1xuICByZXR1cm4gcmF0ZWQubGVuZ3RoID49IDEgPyByYXRlZCA6IGFsbFNjZW5lcztcbn1cblxuLyoqIExvYWQgdGhlIGxlZnQgKFwidG8gcmF0ZVwiKSBhbmQgZnVsbCBwb29scy4gQm90aCBjb21lIGZyb20gdGhlIGNhY2hlLCBzb3J0ZWQgYnkgRUxPLiAqL1xuYXN5bmMgZnVuY3Rpb24gbG9hZFNjZW5lUG9vbHMoXG4gIGZpbHRlcnM6IExpc3RGaWx0ZXJzLFxuKTogUHJvbWlzZTx7IGxlZnRQb29sOiBTY2VuZVtdOyBhbGxTY2VuZXM6IFNjZW5lW10gfT4ge1xuICBsZXQgbGVmdFBvb2w6IFNjZW5lW107XG4gIGxldCBhbGxTY2VuZXM6IFNjZW5lW107XG5cbiAgaWYgKGZpbHRlcnMuZmlsdGVyQWN0aXZlKSB7XG4gICAgLy8gUmUtcXVlcnkgdGhlIGZpbHRlciBhZnRlciBlYWNoIGZ1bGwgcGFzcyBzbyBmaWx0ZXJzIGxpa2UgXCJ1bnJhdGVkXCIgc2hyaW5rIGFzIHNjZW5lcyBnZXQgcmF0ZWRcbiAgICBjb25zdCBwYXNzQ29tcGxldGUgPSBpc1NodWZmbGVDeWNsZUNvbXBsZXRlKGZpbHRlcnMuZmlsdGVyS2V5KTtcbiAgICBpZiAocGFzc0NvbXBsZXRlKSB7XG4gICAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCflIEgUGFzcyBjb21wbGV0ZSwgcmUtZmV0Y2hpbmcgZmlsdGVyZWQgc2NlbmVzXCIpO1xuICAgICAgYXdhaXQgY2xlYXJGaWx0ZXJlZENhY2hlKCk7XG4gICAgfVxuICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+TiyBGaWx0ZXIgYWN0aXZlLCBmZXRjaGluZyBmaWx0ZXJlZCArIGFsbCBzY2VuZXNcIik7XG4gICAgY29uc3QgW2ZpbHRlcmVkUmVzdWx0LCBhbGxSZXN1bHRdID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xuICAgICAgZ2V0RmlsdGVyZWRTY2VuZXNDYWNoZWQoZmlsdGVycyksXG4gICAgICBnZXRBbGxTY2VuZXNDYWNoZWQoKSxcbiAgICBdKTtcbiAgICBsZWZ0UG9vbCA9IGZpbHRlcmVkUmVzdWx0LnNjZW5lcyB8fCBbXTtcbiAgICBhbGxTY2VuZXMgPSBhbGxSZXN1bHQuc2NlbmVzIHx8IFtdO1xuICAgIC8vIFN0YXJ0IHRoZSBuZXh0IHBhc3Mgbm93LCBzbyBsYXRlciBsb2FkcyBpbiBhIHJ1biAod2hpY2ggcGljayBubyBuZXcgbGVmdCBzY2VuZSkgZG9uJ3RcbiAgICAvLyBzZWUgdGhlIHBhc3MgYXMgY29tcGxldGUgYW5kIHJlLWZldGNoIHRoZSBmaWx0ZXIgZXZlcnkgdGltZVxuICAgIGlmIChwYXNzQ29tcGxldGUpIHN0YXJ0TmV3UGFzcyhsZWZ0UG9vbCk7XG4gIH0gZWxzZSB7XG4gICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5OLIE5vIGZpbHRlciBhY3RpdmUsIHVzaW5nIGFsbCBzY2VuZXNcIik7XG4gICAgYWxsU2NlbmVzID0gKGF3YWl0IGdldEFsbFNjZW5lc0NhY2hlZCgpKS5zY2VuZXMgfHwgW107XG4gICAgbGVmdFBvb2wgPSBhbGxTY2VuZXM7XG4gIH1cblxuICBzdGF0ZS5sZWZ0UG9vbFNpemUgPSBsZWZ0UG9vbC5sZW5ndGg7XG4gIHJldHVybiB7IGxlZnRQb29sLCBhbGxTY2VuZXMgfTtcbn1cblxuLyoqXG4gKiBSYW5rcyBmb3IgYSByZXN0b3JlZCBwYWlyIGZyb20gdGhlIGN1cnJlbnQgcG9vbHMgKGFsc28gcmVjb3JkaW5nIHRoZSBsZWZ0IHBvb2wncyBzaXplKSwgdGhlIHdheVxuICogdGhlIHBhaXIgZmV0Y2hlcnMgd29yayB0aGVtIG91dDogdGhlIHBsYWNlIGluIHRoZSBvcHBvbmVudCBwb29sLCBhbmQgaW4gUGxhY2VtZW50LCBub25lIGZvciB0aGVcbiAqIHNjZW5lIGJlaW5nIHBsYWNlZCBhbmQgdGhlIG9wcG9uZW50J3MgcGxhY2UgaW4gdGhlIHBvb2wgd2l0aG91dCBpdC5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHBhaXJSYW5rcyhsZWZ0OiBTY2VuZSwgcmlnaHQ6IFNjZW5lKTogUHJvbWlzZTxbUmFuaywgUmFua10+IHtcbiAgY29uc3QgZmlsdGVycyA9IHJlYWRGaWx0ZXJzKCk7XG4gIGNvbnN0IHsgbGVmdFBvb2wsIGFsbFNjZW5lcyB9ID0gYXdhaXQgbG9hZFNjZW5lUG9vbHMoZmlsdGVycyk7XG4gIGxldCBwb29sID0gYnVpbGRPcHBvbmVudFBvb2woYWxsU2NlbmVzLCBsZWZ0UG9vbCwgZmlsdGVycyk7XG4gIGNvbnN0IHJhbmsgPSAoc2NlbmU6IFNjZW5lKTogUmFuayA9PiB7XG4gICAgY29uc3QgaWR4ID0gcG9vbC5maW5kSW5kZXgoKHMpID0+IHMuaWQgPT09IHNjZW5lLmlkKTtcbiAgICByZXR1cm4gaWR4ID49IDAgPyBpZHggKyAxIDogbnVsbDtcbiAgfTtcbiAgaWYgKHN0YXRlLmN1cnJlbnRNb2RlID09PSBcInBsYWNlbWVudFwiKSB7XG4gICAgcG9vbCA9IHBvb2wuZmlsdGVyKChzKSA9PiBzLmlkICE9PSBsZWZ0LmlkKTtcbiAgICByZXR1cm4gW251bGwsIHJhbmsocmlnaHQpXTtcbiAgfVxuICByZXR1cm4gW3JhbmsobGVmdCksIHJhbmsocmlnaHQpXTtcbn1cblxuLyoqIExvYWQgbGVmdCAoc2NlbmUgdG8gcmF0ZSkgYW5kIHJpZ2h0IChvcHBvbmVudCkgcG9vbHMgZm9yIFN3aXNzLiAqL1xuYXN5bmMgZnVuY3Rpb24gYnVpbGRTd2lzc1Bvb2xzKCk6IFByb21pc2U8e1xuICBsZWZ0UG9vbDogU2NlbmVbXTtcbiAgcmlnaHRQb29sOiBTY2VuZVtdO1xuICBmaWx0ZXJLZXk6IHN0cmluZztcbn0+IHtcbiAgY29uc3QgZmlsdGVycyA9IHJlYWRGaWx0ZXJzKCk7XG4gIGNvbnN0IHsgbGVmdFBvb2wsIGFsbFNjZW5lcyB9ID0gYXdhaXQgbG9hZFNjZW5lUG9vbHMoZmlsdGVycyk7XG5cbiAgaWYgKGFsbFNjZW5lcy5sZW5ndGggPCAyKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiTm90IGVub3VnaCBzY2VuZXMgZm9yIGNvbXBhcmlzb24uXCIpO1xuICB9XG5cbiAgY29uc3QgcmlnaHRQb29sID0gYnVpbGRPcHBvbmVudFBvb2woYWxsU2NlbmVzLCBsZWZ0UG9vbCwgZmlsdGVycyk7XG4gIGlmIChzdGF0ZS5zZXR0aW5ncy5maWx0ZXJPcHBvbmVudHMgJiYgZmlsdGVycy5maWx0ZXJBY3RpdmUgJiYgcmlnaHRQb29sLmxlbmd0aCA8IDIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJOb3QgZW5vdWdoIHNjZW5lcyBpbiB5b3VyIGZpbHRlciBmb3IgYSBtYXRjaC4gWW91IG5lZWQgYXQgbGVhc3QgMiBzY2VuZXMuXCIpO1xuICB9XG5cbiAgcmV0dXJuIHsgbGVmdFBvb2wsIHJpZ2h0UG9vbCwgZmlsdGVyS2V5OiBmaWx0ZXJzLmZpbHRlcktleSB9O1xufVxuXG4vLyBTd2lzcyBtb2RlOiBsZWZ0ID0gc2NlbmUgdG8gcmF0ZSAoZmlsdGVyZWQgcG9vbCksIHJpZ2h0ID0gc2ltaWxhci1zdHJlbmd0aCBvcHBvbmVudFxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGZldGNoU3dpc3NQYWlyKGZvcmNlZExlZnRTY2VuZTogU2NlbmUgfCBudWxsID0gbnVsbCk6IFByb21pc2U8U3dpc3NQYWlyUmVzdWx0PiB7XG4gIGNvbnN0IHsgbGVmdFBvb2wsIHJpZ2h0UG9vbCwgZmlsdGVyS2V5IH0gPSBhd2FpdCBidWlsZFN3aXNzUG9vbHMoKTtcblxuICBjb25zdCBzY2VuZTEgPSBmb3JjZWRMZWZ0U2NlbmUgfHwgZ2V0TmV4dEZpbHRlcmVkU2NlbmUobGVmdFBvb2wsIGZpbHRlcktleSk7XG4gIGlmICghc2NlbmUxKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiTm8gc2NlbmVzIG1hdGNoIHlvdXIgZmlsdGVyIGNyaXRlcmlhLlwiKTtcbiAgfVxuXG4gIGNvbnN0IHsgc2NlbmUyLCByYW5rcyB9ID0gcGlja1N3aXNzT3Bwb25lbnQoc2NlbmUxLCByaWdodFBvb2wpO1xuICByZXR1cm4geyBzY2VuZXM6IFtzY2VuZTEsIHNjZW5lMl0sIHJhbmtzIH07XG59XG5cbi8qKlxuICogUGljayBhIHJhbmRvbSBvcHBvbmVudCB3aXRoaW4gwrFTV0lTU19PUFBPTkVOVF9FTE9fV0lORE9XIG9mIHNjZW5lMSdzIEVMTyBpbiB0aGUgRUxPLXNvcnRlZCByaWdodFxuICogcG9vbCAodW5yYXRlZCBzY2VuZXMgY291bnQgYXMgMTUwMCksIG9yIGFtb25nIHRoZSBuZWFyZXN0IGZldyB3aGVuIHRoZSB3aW5kb3cgaGFzIHRvbyBmZXcuXG4gKi9cbmZ1bmN0aW9uIHBpY2tTd2lzc09wcG9uZW50KFxuICBzY2VuZTE6IFNjZW5lLFxuICByaWdodFBvb2w6IFNjZW5lW10sXG4pOiB7IHNjZW5lMjogU2NlbmU7IHJhbmtzOiBbUmFuaywgUmFua10gfSB7XG4gIGNvbnN0IHNjZW5lMUlkeEluUG9vbCA9IHJpZ2h0UG9vbC5maW5kSW5kZXgoKHMpID0+IHMuaWQgPT09IHNjZW5lMS5pZCk7XG4gIGNvbnN0IHNjZW5lMVJhbmtJblBvb2wgPSBzY2VuZTFJZHhJblBvb2wgPj0gMCA/IHNjZW5lMUlkeEluUG9vbCArIDEgOiBudWxsO1xuXG4gIGNvbnN0IGNhbmRpZGF0ZXMgPSBzd2lzc09wcG9uZW50SW5kZXhlcyhcbiAgICByaWdodFBvb2wsXG4gICAgZWZmZWN0aXZlRWxvKGxhdGVzdFNjZW5lKHNjZW5lMSkpLFxuICAgIHNjZW5lMS5pZCxcbiAgICBTV0lTU19PUFBPTkVOVF9FTE9fV0lORE9XLFxuICAgIFNXSVNTX09QUE9ORU5UX01JTl9DQU5ESURBVEVTLFxuICApO1xuICBpZiAoY2FuZGlkYXRlcy5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJOb3QgZW5vdWdoIHNjZW5lcyBmb3IgY29tcGFyaXNvbi4gWW91IG5lZWQgYXQgbGVhc3QgMiBzY2VuZXMuXCIpO1xuICB9XG5cbiAgY29uc3QgaWR4ID0gY2FuZGlkYXRlc1tNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkgKiBjYW5kaWRhdGVzLmxlbmd0aCldO1xuICByZXR1cm4ge1xuICAgIHNjZW5lMjogcmlnaHRQb29sW2lkeF0sXG4gICAgcmFua3M6IFtzY2VuZTFSYW5rSW5Qb29sLCBpZHggKyAxXSxcbiAgfTtcbn1cblxuLyoqIFJhbmRvbSBwaWNrIGZyb20gdGhlIE4gdW5iZWF0ZW4gb3Bwb25lbnRzIGNsb3Nlc3QgYWJvdmUgdGhlIGNoYW1waW9uIChsaXN0IGlzIEVMTy1zb3J0ZWQpLiAqL1xuZnVuY3Rpb24gcGlja0Nsb3Nlc3RDaGFtcGlvbk9wcG9uZW50KHJlbWFpbmluZ09wcG9uZW50czogU2NlbmVbXSk6IFNjZW5lIHtcbiAgY29uc3QgY2xvc2VzdCA9IHJlbWFpbmluZ09wcG9uZW50cy5zbGljZSgtQ0xJTUJfT1BQT05FTlRfUElDS19XSU5ET1cpO1xuICByZXR1cm4gY2xvc2VzdFtNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkgKiBjbG9zZXN0Lmxlbmd0aCldO1xufVxuXG4vKiogT3Bwb25lbnRzIGFib3ZlIHRoZSBjaGFtcGlvbiBpbiB0aGUgRUxPLXNvcnRlZCBwb29sIHRoYXQgaXQgaGFzbid0IGJlYXRlbiBpbiB0aGlzIHJ1bi4gKi9cbmZ1bmN0aW9uIGdldFJlbWFpbmluZ0NoYW1waW9uT3Bwb25lbnRzKGNoYW1waW9uOiBTY2VuZSwgcmlnaHRQb29sOiBTY2VuZVtdLCBjaGFtcGlvbkluZGV4OiBudW1iZXIpOiBTY2VuZVtdIHtcbiAgY29uc3QgY2hhbXBpb25FbG8gPSBlZmZlY3RpdmVFbG8oY2hhbXBpb24sIENIQU1QSU9OX1VOUkFURURfRUxPKTtcbiAgcmV0dXJuIHJpZ2h0UG9vbC5maWx0ZXIoKHMsIGlkeCkgPT4ge1xuICAgIGlmIChzLmlkID09PSBjaGFtcGlvbi5pZCB8fCBzdGF0ZS5jaGFtcGlvbkRlZmVhdGVkLmluY2x1ZGVzKHMuaWQpKSByZXR1cm4gZmFsc2U7XG4gICAgcmV0dXJuIGlkeCA8IGNoYW1waW9uSW5kZXggfHwgKGVsbyhzKSA/PyAtSW5maW5pdHkpID49IGNoYW1waW9uRWxvO1xuICB9KTtcbn1cblxuLyoqIExvd2VzdCBzY2VuZSB3aXRoIGFuIEVMTyBpbiB0aGUgcG9vbCAoZXhjbHVkaW5nIG9uZSBzY2VuZSksIG9yIGFueSBvdGhlciBzY2VuZSBpZiBub25lIGhhcyBvbmUuICovXG5mdW5jdGlvbiBmaW5kTG93ZXN0UmF0ZWQoc2NlbmVzOiBTY2VuZVtdLCBleGNsdWRlSWQ6IHN0cmluZyk6IHsgc2NlbmU6IFNjZW5lIHwgdW5kZWZpbmVkOyBpbmRleDogbnVtYmVyIH0ge1xuICBmb3IgKGxldCBpID0gc2NlbmVzLmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7XG4gICAgY29uc3QgcyA9IHNjZW5lc1tpXTtcbiAgICBpZiAocy5pZCAhPT0gZXhjbHVkZUlkICYmIGlzUmF0ZWQocykpIHtcbiAgICAgIHJldHVybiB7IHNjZW5lOiBzLCBpbmRleDogaSB9O1xuICAgIH1cbiAgfVxuICBjb25zdCBmYWxsYmFja0luZGV4ID0gc2NlbmVzLmZpbmRJbmRleCgocykgPT4gcy5pZCAhPT0gZXhjbHVkZUlkKTtcbiAgcmV0dXJuIHsgc2NlbmU6IHNjZW5lc1tmYWxsYmFja0luZGV4XSwgaW5kZXg6IGZhbGxiYWNrSW5kZXggfTtcbn1cblxuLy8gQ2hhbXBpb24gbW9kZTogd2lubmVyIHN0YXlzIG9uLCBzdGFydGluZyBhZ2FpbnN0IHRoZSBsb3dlc3QtcmF0ZWQgc2NlbmVcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBmZXRjaENoYW1waW9uUGFpcihcbiAgZm9yY2VkTGVmdFNjZW5lOiBTY2VuZSB8IG51bGwgPSBudWxsLFxuKTogUHJvbWlzZTxDaGFtcGlvblBhaXJSZXN1bHQ+IHtcbiAgY29uc3QgZmlsdGVycyA9IHJlYWRGaWx0ZXJzKCk7XG5cbiAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5OLIEZldGNoaW5nIHNjZW5lcyBmb3IgY2hhbXBpb24uLi5cIik7XG4gIGNvbnN0IHsgbGVmdFBvb2wsIGFsbFNjZW5lcyB9ID0gYXdhaXQgbG9hZFNjZW5lUG9vbHMoZmlsdGVycyk7XG5cbiAgY29uc3QgcmlnaHRQb29sID0gYnVpbGRPcHBvbmVudFBvb2woYWxsU2NlbmVzLCBsZWZ0UG9vbCwgZmlsdGVycyk7XG4gIHN0YXRlLnRvdGFsU2NlbmVzQ291bnQgPSByaWdodFBvb2wubGVuZ3RoO1xuXG4gIGlmIChhbGxTY2VuZXMubGVuZ3RoIDwgMikge1xuICAgIHRocm93IG5ldyBFcnJvcihcIk5vdCBlbm91Z2ggc2NlbmVzIGZvciBjb21wYXJpc29uLlwiKTtcbiAgfVxuXG4gIC8vIE5vIGNoYW1waW9uIHlldDogdGhlIGNoYWxsZW5nZXIgZnJvbSB0aGUgbGVmdCBwb29sIHN0YXJ0cyBhZ2FpbnN0IHRoZSBsb3dlc3QtcmF0ZWQgc2NlbmVcbiAgaWYgKCFzdGF0ZS5jaGFtcGlvblNjZW5lKSB7XG4gICAgc3RhdGUuY2hhbXBpb25EZWZlYXRlZCA9IFtdO1xuXG4gICAgY29uc3QgY2hhbGxlbmdlciA9IGZvcmNlZExlZnRTY2VuZSB8fCBnZXROZXh0RmlsdGVyZWRTY2VuZShsZWZ0UG9vbCwgZmlsdGVycy5maWx0ZXJLZXkpO1xuICAgIGlmICghY2hhbGxlbmdlcikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiTm8gc2NlbmVzIG1hdGNoIHlvdXIgZmlsdGVyIGNyaXRlcmlhLlwiKTtcbiAgICB9XG5cbiAgICBjb25zdCBjaGFsbGVuZ2VySW5kZXggPSByaWdodFBvb2wuZmluZEluZGV4KChzKSA9PiBzLmlkID09PSBjaGFsbGVuZ2VyLmlkKTtcbiAgICBjb25zdCB7IHNjZW5lOiBsb3dlc3RSYXRlZCwgaW5kZXg6IGxvd2VzdEluZGV4IH0gPSBmaW5kTG93ZXN0UmF0ZWQocmlnaHRQb29sLCBjaGFsbGVuZ2VyLmlkKTtcbiAgICBpZiAoIWxvd2VzdFJhdGVkKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJOb3QgZW5vdWdoIHNjZW5lcyBmb3IgY29tcGFyaXNvbi4gWW91IG5lZWQgYXQgbGVhc3QgMiBzY2VuZXMuXCIpO1xuICAgIH1cblxuICAgIHJldHVybiB7XG4gICAgICBzY2VuZXM6IFtjaGFsbGVuZ2VyLCBsb3dlc3RSYXRlZF0sXG4gICAgICByYW5rczogW2NoYWxsZW5nZXJJbmRleCA+PSAwID8gY2hhbGxlbmdlckluZGV4ICsgMSA6IG51bGwsIGxvd2VzdEluZGV4ICsgMV0sXG4gICAgICBpc1ZpY3Rvcnk6IGZhbHNlLFxuICAgIH07XG4gIH1cblxuICBjb25zdCBjaGFtcGlvbiA9IHN0YXRlLmNoYW1waW9uU2NlbmU7XG4gIGNvbnN0IGNoYW1waW9uSW5kZXggPSByaWdodFBvb2wuZmluZEluZGV4KChzKSA9PiBzLmlkID09PSBjaGFtcGlvbi5pZCk7XG4gIGNvbnN0IHJlbWFpbmluZ09wcG9uZW50cyA9IGdldFJlbWFpbmluZ0NoYW1waW9uT3Bwb25lbnRzKGNoYW1waW9uLCByaWdodFBvb2wsIGNoYW1waW9uSW5kZXgpO1xuXG4gIC8vIE5vIG9wcG9uZW50cyBsZWZ0OiB0aGUgY2hhbXBpb24gaGFzIGJlYXRlbiBldmVyeW9uZSBhYm92ZSBpdFxuICBpZiAocmVtYWluaW5nT3Bwb25lbnRzLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiB7IHNjZW5lczogW2NoYW1waW9uXSwgcmFua3M6IFsxXSwgaXNWaWN0b3J5OiB0cnVlIH07XG4gIH1cblxuICBjb25zdCBuZXh0T3Bwb25lbnQgPSBwaWNrQ2xvc2VzdENoYW1waW9uT3Bwb25lbnQocmVtYWluaW5nT3Bwb25lbnRzKTtcbiAgY29uc3QgbmV4dE9wcG9uZW50SW5kZXggPSByaWdodFBvb2wuZmluZEluZGV4KChzKSA9PiBzLmlkID09PSBuZXh0T3Bwb25lbnQuaWQpO1xuXG4gIHJldHVybiB7XG4gICAgc2NlbmVzOiBbY2hhbXBpb24sIG5leHRPcHBvbmVudF0sXG4gICAgcmFua3M6IFtjaGFtcGlvbkluZGV4ID49IDAgPyBjaGFtcGlvbkluZGV4ICsgMSA6IG51bGwsIG5leHRPcHBvbmVudEluZGV4ICsgMV0sXG4gICAgaXNWaWN0b3J5OiBmYWxzZSxcbiAgfTtcbn1cblxuLy8gLS0tIFBsYWNlbWVudCBtb2RlICh0aGUgc2VhcmNoIGl0c2VsZiBpcyBpbiBwbGFjZW1lbnQudHMpIC0tLVxuXG4vKiogUmFuZG9tIHBpY2sgYW1vbmcgc2NlbmVzIGluIFtsbywgaGkpIHRoYXQgc2hhcmUgcG9vbFtpZHhdJ3MgRUxPICh0aGVpciBvcmRlciBpcyBhcmJpdHJhcnkpLiAqL1xuZnVuY3Rpb24gcGlja0Ftb25nVGllcyhwb29sOiBTY2VuZVtdLCBpZHg6IG51bWJlciwgbG86IG51bWJlciwgaGk6IG51bWJlcik6IG51bWJlciB7XG4gIGNvbnN0IHRhcmdldCA9IGVsbyhwb29sW2lkeF0pO1xuICBjb25zdCB0aWVzOiBudW1iZXJbXSA9IFtdO1xuICBmb3IgKGxldCBpID0gbG87IGkgPCBoaTsgaSsrKSB7XG4gICAgaWYgKGVsbyhwb29sW2ldKSA9PT0gdGFyZ2V0KSB0aWVzLnB1c2goaSk7XG4gIH1cbiAgcmV0dXJuIHRpZXNbTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogdGllcy5sZW5ndGgpXTtcbn1cblxuLy8gUGxhY2VtZW50IG1vZGU6IGxlZnQgPSBzY2VuZSBiZWluZyBwbGFjZWQsIHJpZ2h0ID0gdGhlIG5leHQgb3Bwb25lbnQgaW4gaXRzIHNlYXJjaCByYW5nZVxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGZldGNoUGxhY2VtZW50UGFpcihcbiAgZm9yY2VkTGVmdFNjZW5lOiBTY2VuZSB8IG51bGwgPSBudWxsLFxuKTogUHJvbWlzZTxQbGFjZW1lbnRQYWlyUmVzdWx0PiB7XG4gIGNvbnN0IGZpbHRlcnMgPSByZWFkRmlsdGVycygpO1xuICBjb25zdCB7IGxlZnRQb29sLCBhbGxTY2VuZXMgfSA9IGF3YWl0IGxvYWRTY2VuZVBvb2xzKGZpbHRlcnMpO1xuXG4gIGlmIChhbGxTY2VuZXMubGVuZ3RoIDwgMikge1xuICAgIHRocm93IG5ldyBFcnJvcihcIk5vdCBlbm91Z2ggc2NlbmVzIGZvciBjb21wYXJpc29uLlwiKTtcbiAgfVxuXG4gIGlmICghc3RhdGUucGxhY2VtZW50KSB7XG4gICAgY29uc3Qgc2NlbmUgPSBmb3JjZWRMZWZ0U2NlbmUgfHwgZ2V0TmV4dEZpbHRlcmVkU2NlbmUobGVmdFBvb2wsIGZpbHRlcnMuZmlsdGVyS2V5KTtcbiAgICBpZiAoIXNjZW5lKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJObyBzY2VuZXMgbWF0Y2ggeW91ciBmaWx0ZXIgY3JpdGVyaWEuXCIpO1xuICAgIH1cbiAgICBzdGF0ZS5wbGFjZW1lbnQgPSBuZXdQbGFjZW1lbnRSdW4oc2NlbmUsIHN0YXRlLnNldHRpbmdzLnBsYWNlbWVudEZyb21Cb3R0b20pO1xuICB9XG4gIGNvbnN0IHJ1biA9IHN0YXRlLnBsYWNlbWVudDtcblxuICBjb25zdCBwb29sID0gYnVpbGRPcHBvbmVudFBvb2woYWxsU2NlbmVzLCBsZWZ0UG9vbCwgZmlsdGVycykuZmlsdGVyKChzKSA9PiBzLmlkICE9PSBydW4uc2NlbmUuaWQpO1xuICBpZiAocG9vbC5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJOb3QgZW5vdWdoIHNjZW5lcyBmb3IgY29tcGFyaXNvbi4gWW91IG5lZWQgYXQgbGVhc3QgMiBzY2VuZXMuXCIpO1xuICB9XG4gIHN0YXRlLnRvdGFsU2NlbmVzQ291bnQgPSBwb29sLmxlbmd0aCArIDE7XG5cbiAgY29uc3Qgc3RlcCA9IHBsYWNlbWVudFN0ZXAocnVuLCBwb29sKTtcbiAgcnVuLnJhbmdlTG8gPSBNYXRoLm1pbihzdGVwLmxvLCBzdGVwLmhpKTtcbiAgcnVuLnJhbmdlSGkgPSBzdGVwLmhpO1xuXG4gIGlmIChzdGVwLmRvbmUpIHtcbiAgICAvLyBPbmx5IHRoZSBwbGFjZWQgc2NlbmUncyBFTE8gY2hhbmdlczsgaXQncyBjcmVkaXRlZCB3aXRoIHRoZSBiYXR0bGVzIHRoaXMgcnVuIHRvb2tcbiAgICBjb25zdCBuZXdFbG8gPSBsYW5kaW5nRWxvKHBvb2wsIHN0ZXAuc2xvdCk7XG4gICAgY29uc3QgbmV3QmF0dGxlcyA9IGJhdHRsZXMobGF0ZXN0U2NlbmUocnVuLnNjZW5lKSkgKyBydW4uYmF0dGxlcztcbiAgICBjb25zb2xlLmxvZyhcbiAgICAgIGBbU3Rhc2ggQmF0dGxlXSDwn5ONIFBsYWNlbWVudDogc2NlbmUgJHtydW4uc2NlbmUuaWR9IHBsYWNlZCBhdCAjJHtzdGVwLnNsb3QgKyAxfSBhZnRlciAke3J1bi5iYXR0bGVzfSBiYXR0bGVzLCBFTE8gJHtuZXdFbG99YCxcbiAgICApO1xuICAgIGF3YWl0IHdyaXRlRWxvKHJ1bi5zY2VuZSwgbmV3RWxvLCBuZXdCYXR0bGVzKTtcbiAgICByZXR1cm4ge1xuICAgICAgZG9uZTogdHJ1ZSxcbiAgICAgIHNjZW5lOiBydW4uc2NlbmUsXG4gICAgICByYW5rOiBzdGVwLnNsb3QgKyAxLFxuICAgICAgZWxvOiBuZXdFbG8sXG4gICAgICBiYXR0bGVzOiBydW4uYmF0dGxlcyxcbiAgICAgIHN0cmVhazogcnVuLnN0cmVhayxcbiAgICAgIGZyb21Cb3R0b206IHJ1bi5mcm9tQm90dG9tLFxuICAgIH07XG4gIH1cblxuICBjb25zdCBpZHggPSBwaWNrQW1vbmdUaWVzKHBvb2wsIHN0ZXAuaW5kZXgsIHN0ZXAubG8sIHN0ZXAuaGkpO1xuICByZXR1cm4geyBkb25lOiBmYWxzZSwgc2NlbmVzOiBbcnVuLnNjZW5lLCBwb29sW2lkeF1dLCByYW5rczogW251bGwsIGlkeCArIDFdIH07XG59XG4iLCAiLy8gTGlicmFyeS13aWRlIG51bWJlcnMgd29ya2VkIG91dCBmcm9tIHRoZSBzY2VuZXM6IHRpZXJzLCBhbmQgdGhlIFN0YXRzIHRhYidzIG92ZXJ2aWV3LCBFTE9cbi8vIGRpc3RyaWJ1dGlvbiwgaGlkZGVuIGdlbXMgYW5kIGhvdyBzZXR0bGVkIHRoZSByYW5raW5ncyBhcmUuIFB1cmUgZnVuY3Rpb25zOiBubyBzdGF0ZSwgbm8gSS9PLlxuXG5pbXBvcnQgeyBFTE9fS19USUVSUywgVElFUlMgfSBmcm9tIFwiLi9jb25zdGFudHNcIjtcbmltcG9ydCB7IGJhdHRsZXMsIGVsbywgaXNQcm92aXNpb25hbCwgcGVyY2VudGlsZVJhdGluZ3MsIHNlZWQgfSBmcm9tIFwiLi9zY29yZVwiO1xuaW1wb3J0IHR5cGUgeyBTY2VuZSwgU3Rhc2hSYXRpbmdzTW9kZSwgVGllciB9IGZyb20gXCIuL3R5cGVzXCI7XG5cbi8qKiBSYXRlZCBzY2VuZXMgd2l0aCB0aGVpciBFTE8gKHVucmF0ZWQgb25lcyBkcm9wcGVkKS4gKi9cbmZ1bmN0aW9uIHJhdGVkRWxvcyhzY2VuZXM6IFNjZW5lW10pOiB7IHNjZW5lOiBTY2VuZTsgZWxvOiBudW1iZXIgfVtdIHtcbiAgcmV0dXJuIHNjZW5lc1xuICAgIC5tYXAoKHNjZW5lKSA9PiAoeyBzY2VuZSwgZWxvOiBlbG8oc2NlbmUpIH0pKVxuICAgIC5maWx0ZXIoKHMpOiBzIGlzIHsgc2NlbmU6IFNjZW5lOyBlbG86IG51bWJlciB9ID0+IHMuZWxvICE9PSBudWxsKTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBPdmVydmlldyB7XG4gIHJhdGVkOiBudW1iZXI7XG4gIHVucmF0ZWQ6IG51bWJlcjtcbiAgcHJvdmlzaW9uYWw6IG51bWJlcjtcbiAgLyoqIFN1bSBvZiBldmVyeSBzY2VuZSdzIGJhdHRsZXM6IGEgYmF0dGxlIGNvdW50cyBvbmNlIGZvciBlYWNoIHNjZW5lIGluIGl0LiAqL1xuICBiYXR0bGVzOiBudW1iZXI7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBvdmVydmlldyhzY2VuZXM6IFNjZW5lW10pOiBPdmVydmlldyB7XG4gIGNvbnN0IHJhdGVkID0gcmF0ZWRFbG9zKHNjZW5lcyk7XG4gIHJldHVybiB7XG4gICAgcmF0ZWQ6IHJhdGVkLmxlbmd0aCxcbiAgICB1bnJhdGVkOiBzY2VuZXMubGVuZ3RoIC0gcmF0ZWQubGVuZ3RoLFxuICAgIHByb3Zpc2lvbmFsOiBzY2VuZXMuZmlsdGVyKGlzUHJvdmlzaW9uYWwpLmxlbmd0aCxcbiAgICBiYXR0bGVzOiByYXRlZC5yZWR1Y2UoKHN1bSwgcykgPT4gc3VtICsgYmF0dGxlcyhzLnNjZW5lKSwgMCksXG4gIH07XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgSGlzdG9ncmFtQnVja2V0IHtcbiAgLyoqIFRoZSBidWNrZXQgY292ZXJzIGZyb20uLmZyb20gKyBzaXplIChleGNsdXNpdmUpLiAqL1xuICBmcm9tOiBudW1iZXI7XG4gIGNvdW50OiBudW1iZXI7XG59XG5cbi8qKiBSYXRlZCBzY2VuZXMgY291bnRlZCBpbiBgc2l6ZWAtRUxPIGJ1Y2tldHMsIGxvd2VzdCB0byBoaWdoZXN0LCBlbXB0eSBidWNrZXRzIGluIGJldHdlZW4gaW5jbHVkZWQuICovXG5leHBvcnQgZnVuY3Rpb24gZWxvSGlzdG9ncmFtKHNjZW5lczogU2NlbmVbXSwgc2l6ZSA9IDI1KTogSGlzdG9ncmFtQnVja2V0W10ge1xuICBjb25zdCByYXRlZCA9IHJhdGVkRWxvcyhzY2VuZXMpO1xuICBpZiAocmF0ZWQubGVuZ3RoID09PSAwKSByZXR1cm4gW107XG4gIGNvbnN0IGJ1Y2tldE9mID0gKHZhbHVlOiBudW1iZXIpOiBudW1iZXIgPT4gTWF0aC5mbG9vcih2YWx1ZSAvIHNpemUpICogc2l6ZTtcbiAgY29uc3QgY291bnRzID0gbmV3IE1hcDxudW1iZXIsIG51bWJlcj4oKTtcbiAgZm9yIChjb25zdCB7IGVsbzogdmFsdWUgfSBvZiByYXRlZCkgY291bnRzLnNldChidWNrZXRPZih2YWx1ZSksIChjb3VudHMuZ2V0KGJ1Y2tldE9mKHZhbHVlKSkgPz8gMCkgKyAxKTtcbiAgY29uc3QgbG93ZXN0ID0gTWF0aC5taW4oLi4uY291bnRzLmtleXMoKSk7XG4gIGNvbnN0IGhpZ2hlc3QgPSBNYXRoLm1heCguLi5jb3VudHMua2V5cygpKTtcbiAgY29uc3QgYnVja2V0czogSGlzdG9ncmFtQnVja2V0W10gPSBbXTtcbiAgZm9yIChsZXQgZnJvbSA9IGxvd2VzdDsgZnJvbSA8PSBoaWdoZXN0OyBmcm9tICs9IHNpemUpIGJ1Y2tldHMucHVzaCh7IGZyb20sIGNvdW50OiBjb3VudHMuZ2V0KGZyb20pID8/IDAgfSk7XG4gIHJldHVybiBidWNrZXRzO1xufVxuXG4vKiogVGhlIGJpZ2dlc3QgZ3JvdXAgb2Ygc2NlbmVzIHNoYXJpbmcgb25lIEVMTyAobnVsbCB3aGVuIG5vIHR3byBzY2VuZXMgc2hhcmUgb25lKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBsYXJnZXN0VGllKHNjZW5lczogU2NlbmVbXSk6IHsgZWxvOiBudW1iZXI7IGNvdW50OiBudW1iZXIgfSB8IG51bGwge1xuICBjb25zdCBjb3VudHMgPSBuZXcgTWFwPG51bWJlciwgbnVtYmVyPigpO1xuICBmb3IgKGNvbnN0IHsgZWxvOiB2YWx1ZSB9IG9mIHJhdGVkRWxvcyhzY2VuZXMpKSBjb3VudHMuc2V0KHZhbHVlLCAoY291bnRzLmdldCh2YWx1ZSkgPz8gMCkgKyAxKTtcbiAgbGV0IGJlc3Q6IHsgZWxvOiBudW1iZXI7IGNvdW50OiBudW1iZXIgfSB8IG51bGwgPSBudWxsO1xuICBmb3IgKGNvbnN0IFt2YWx1ZSwgY291bnRdIG9mIGNvdW50cykge1xuICAgIGlmIChjb3VudCA+PSAyICYmICghYmVzdCB8fCBjb3VudCA+IGJlc3QuY291bnQgfHwgKGNvdW50ID09PSBiZXN0LmNvdW50ICYmIHZhbHVlID4gYmVzdC5lbG8pKSkge1xuICAgICAgYmVzdCA9IHsgZWxvOiB2YWx1ZSwgY291bnQgfTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGJlc3Q7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2NhbGVUaWNrIHtcbiAgZWxvOiBudW1iZXI7XG4gIHJhdGluZzogbnVtYmVyO1xufVxuXG4vKiogU3Rhc2ggcmF0aW5ncyBtYXJrZWQgb24gdGhlIEVMTyBheGlzLiAqL1xuY29uc3QgU0NBTEVfUkFUSU5HUyA9IFsxLCAyNSwgNTAsIDc1LCAxMDBdO1xuXG4vKipcbiAqIFdoZXJlIFN0YXNoIHJhdGluZ3Mgc2l0IG9uIHRoZSBFTE8gYXhpcyB1bmRlciB0aGUgdXBkYXRlIG1vZGU6IFN0cmFpZ2h0LWxpbmUgaXMgZml4ZWQgKDEgYXRcbiAqIDEwMTAsIDUwIGF0IDE1MDAsIDEwMCBhdCAyMDAwKTsgUGVyY2VudGlsZSBkZXBlbmRzIG9uIHRoZSBsaWJyYXJ5IChlYWNoIG1hcmsgYXQgdGhlIEVMTyBvZiB0aGVcbiAqIHNjZW5lIHdob3NlIHJhdGluZyBpcyBjbG9zZXN0IHRvIGl0KS4gTm9uZSBmb3IgXCJvZmZcIi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJhdGluZ1NjYWxlVGlja3Moc2NlbmVzOiBTY2VuZVtdLCBtb2RlOiBTdGFzaFJhdGluZ3NNb2RlKTogU2NhbGVUaWNrW10ge1xuICBpZiAobW9kZSA9PT0gXCJsaW5lYXJcIikgcmV0dXJuIFNDQUxFX1JBVElOR1MubWFwKChyYXRpbmcpID0+ICh7IGVsbzogc2VlZChyYXRpbmcpLCByYXRpbmcgfSkpO1xuICBpZiAobW9kZSAhPT0gXCJwZXJjZW50aWxlXCIpIHJldHVybiBbXTtcbiAgY29uc3QgcmF0aW5ncyA9IHBlcmNlbnRpbGVSYXRpbmdzKHNjZW5lcyk7XG4gIGNvbnN0IHJhdGVkID0gcmF0ZWRFbG9zKHNjZW5lcykuZmlsdGVyKChzKSA9PiByYXRpbmdzLmhhcyhzLnNjZW5lLmlkKSk7XG4gIGlmIChyYXRlZC5sZW5ndGggPT09IDApIHJldHVybiBbXTtcbiAgY29uc3QgdGlja3M6IFNjYWxlVGlja1tdID0gW107XG4gIGZvciAoY29uc3QgcmF0aW5nIG9mIFNDQUxFX1JBVElOR1MpIHtcbiAgICBsZXQgbmVhcmVzdCA9IHJhdGVkWzBdO1xuICAgIGZvciAoY29uc3QgcyBvZiByYXRlZCkge1xuICAgICAgY29uc3QgZ2FwID0gTWF0aC5hYnMoKHJhdGluZ3MuZ2V0KHMuc2NlbmUuaWQpIGFzIG51bWJlcikgLSByYXRpbmcpO1xuICAgICAgY29uc3QgbmVhcmVzdEdhcCA9IE1hdGguYWJzKChyYXRpbmdzLmdldChuZWFyZXN0LnNjZW5lLmlkKSBhcyBudW1iZXIpIC0gcmF0aW5nKTtcbiAgICAgIGlmIChnYXAgPCBuZWFyZXN0R2FwKSBuZWFyZXN0ID0gcztcbiAgICB9XG4gICAgaWYgKCF0aWNrcy5zb21lKCh0KSA9PiB0LmVsbyA9PT0gbmVhcmVzdC5lbG8pKSB0aWNrcy5wdXNoKHsgZWxvOiBuZWFyZXN0LmVsbywgcmF0aW5nIH0pO1xuICB9XG4gIHJldHVybiB0aWNrcztcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIG1lZGlhbih2YWx1ZXM6IG51bWJlcltdKTogbnVtYmVyIHtcbiAgaWYgKHZhbHVlcy5sZW5ndGggPT09IDApIHJldHVybiAwO1xuICBjb25zdCBzb3J0ZWQgPSBbLi4udmFsdWVzXS5zb3J0KChhLCBiKSA9PiBhIC0gYik7XG4gIGNvbnN0IG1pZCA9IE1hdGguZmxvb3Ioc29ydGVkLmxlbmd0aCAvIDIpO1xuICByZXR1cm4gc29ydGVkLmxlbmd0aCAlIDIgPyBzb3J0ZWRbbWlkXSA6IChzb3J0ZWRbbWlkIC0gMV0gKyBzb3J0ZWRbbWlkXSkgLyAyO1xufVxuXG4vKiogVGhlIGhpZGRlbiBnZW1zIGNoYXJ0J3MgcXVhZHJhbnQgbGluZXM6IHRoZSBtZWRpYW4gRUxPIGFuZCBtZWRpYW4gcGxheSBjb3VudCBvZiByYXRlZCBzY2VuZXMuICovXG5leHBvcnQgaW50ZXJmYWNlIEdlbXNTcGxpdCB7XG4gIGVsbzogbnVtYmVyO1xuICBwbGF5czogbnVtYmVyO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZ2Vtc1NwbGl0KHNjZW5lczogU2NlbmVbXSk6IEdlbXNTcGxpdCB8IG51bGwge1xuICBjb25zdCByYXRlZCA9IHJhdGVkRWxvcyhzY2VuZXMpO1xuICBpZiAocmF0ZWQubGVuZ3RoID09PSAwKSByZXR1cm4gbnVsbDtcbiAgcmV0dXJuIHsgZWxvOiBtZWRpYW4ocmF0ZWQubWFwKChzKSA9PiBzLmVsbykpLCBwbGF5czogbWVkaWFuKHJhdGVkLm1hcCgocykgPT4gcy5zY2VuZS5wbGF5X2NvdW50ID8/IDApKSB9O1xufVxuXG4vKipcbiAqIFwiZ2VtXCI6IHJhbmtlZCBhYm92ZSB0aGUgbWVkaWFuIGJ1dCBwbGF5ZWQgbGVzcyB0aGFuIHRoZSBtZWRpYW4gKGEgaGlkZGVuIGdlbSk7IFwib3ZlcnBsYXllZFwiOlxuICogYmVsb3cgdGhlIG1lZGlhbiBFTE8gYnV0IHBsYXllZCBtb3JlLiBOdWxsIGZvciBldmVyeXRoaW5nIGVsc2UsIGFuZCBmb3IgdW5yYXRlZCBzY2VuZXMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZW1zUXVhZHJhbnQoc2NlbmU6IFNjZW5lLCBzcGxpdDogR2Vtc1NwbGl0KTogXCJnZW1cIiB8IFwib3ZlcnBsYXllZFwiIHwgbnVsbCB7XG4gIGNvbnN0IHZhbHVlID0gZWxvKHNjZW5lKTtcbiAgaWYgKHZhbHVlID09PSBudWxsKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgcGxheXMgPSBzY2VuZS5wbGF5X2NvdW50ID8/IDA7XG4gIGlmICh2YWx1ZSA+IHNwbGl0LmVsbyAmJiBwbGF5cyA8IHNwbGl0LnBsYXlzKSByZXR1cm4gXCJnZW1cIjtcbiAgaWYgKHZhbHVlIDwgc3BsaXQuZWxvICYmIHBsYXlzID4gc3BsaXQucGxheXMpIHJldHVybiBcIm92ZXJwbGF5ZWRcIjtcbiAgcmV0dXJuIG51bGw7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgU2V0dGxlZEJ1Y2tldCB7XG4gIG1pbjogbnVtYmVyO1xuICAvKiogSW5jbHVzaXZlOyBudWxsIGZvciB0aGUgb3Blbi1lbmRlZCBsYXN0IGJ1Y2tldC4gKi9cbiAgbWF4OiBudW1iZXIgfCBudWxsO1xuICBjb3VudDogbnVtYmVyO1xufVxuXG4vKipcbiAqIFJhdGVkIHNjZW5lcyBieSByZWFsIGJhdHRsZXM6IG5vbmUgeWV0LCB0aGVuIHRoZSBLIHRpZXJzJyByYW5nZXMgKDEtOSwgMTAtMjksIDMwKyksIHNvIGVhY2hcbiAqIGJ1Y2tldCBhZnRlciB0aGUgZmlyc3QgaXMgYSBzdGFnZSB3aGVyZSBhIGJhdHRsZSBtb3ZlcyBFTE8gYnkgYSBkaWZmZXJlbnQgYW1vdW50LlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2V0dGxlZEJ1Y2tldHMoc2NlbmVzOiBTY2VuZVtdKTogU2V0dGxlZEJ1Y2tldFtdIHtcbiAgY29uc3QgbGltaXRzID0gRUxPX0tfVElFUlMubWFwKChbYmVsb3ddKSA9PiBiZWxvdykuZmlsdGVyKE51bWJlci5pc0Zpbml0ZSk7XG4gIGNvbnN0IGVkZ2VzID0gWzAsIDEsIC4uLmxpbWl0c107XG4gIGNvbnN0IGJ1Y2tldHM6IFNldHRsZWRCdWNrZXRbXSA9IGVkZ2VzLm1hcCgobWluLCBpKSA9PiAoe1xuICAgIG1pbixcbiAgICBtYXg6IGkgKyAxIDwgZWRnZXMubGVuZ3RoID8gZWRnZXNbaSArIDFdIC0gMSA6IG51bGwsXG4gICAgY291bnQ6IDAsXG4gIH0pKTtcbiAgZm9yIChjb25zdCB7IHNjZW5lIH0gb2YgcmF0ZWRFbG9zKHNjZW5lcykpIHtcbiAgICBjb25zdCBuID0gYmF0dGxlcyhzY2VuZSk7XG4gICAgY29uc3QgYnVja2V0ID0gWy4uLmJ1Y2tldHNdLnJldmVyc2UoKS5maW5kKChiKSA9PiBuID49IGIubWluKTtcbiAgICBpZiAoYnVja2V0KSBidWNrZXQuY291bnQrKztcbiAgfVxuICByZXR1cm4gYnVja2V0cztcbn1cblxuLyoqXG4gKiBcIkJhdHRsZSB0aGUgbGVhc3QtdGVzdGVkXCI6IHRoZSBzY2VuZSBpbiB0aGUgcG9vbCB3aXRoIHRoZSBmZXdlc3QgcmVhbCBiYXR0bGVzLCBhdCByYW5kb20gYW1vbmdcbiAqIGVxdWFscy4gYGV4Y2x1ZGVJZGAgKHRoZSBzY2VuZSBqdXN0IHNob3duKSBpcyBza2lwcGVkIHVubGVzcyBpdCdzIHRoZSBvbmx5IG9uZS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGxlYXN0VGVzdGVkKHBvb2w6IFNjZW5lW10sIGV4Y2x1ZGVJZDogc3RyaW5nIHwgbnVsbCwgcmFuZG9tOiAoKSA9PiBudW1iZXIgPSBNYXRoLnJhbmRvbSk6IFNjZW5lIHwgbnVsbCB7XG4gIGNvbnN0IGNhbmRpZGF0ZXMgPSBwb29sLmxlbmd0aCA+IDEgPyBwb29sLmZpbHRlcigocykgPT4gcy5pZCAhPT0gZXhjbHVkZUlkKSA6IHBvb2w7XG4gIGlmIChjYW5kaWRhdGVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGZld2VzdCA9IE1hdGgubWluKC4uLmNhbmRpZGF0ZXMubWFwKGJhdHRsZXMpKTtcbiAgY29uc3QgdGllZCA9IGNhbmRpZGF0ZXMuZmlsdGVyKChzKSA9PiBiYXR0bGVzKHMpID09PSBmZXdlc3QpO1xuICByZXR1cm4gdGllZFtNYXRoLm1pbih0aWVkLmxlbmd0aCAtIDEsIE1hdGguZmxvb3IocmFuZG9tKCkgKiB0aWVkLmxlbmd0aCkpXTtcbn1cblxuLyoqXG4gKiBUaWVyIGZvciBldmVyeSBzZXR0bGVkIHNjZW5lIChyYXRlZCBhbmQgbm90IHByb3Zpc2lvbmFsKSwgYnkgcmFuayBhbW9uZyB0aGVtOiBhIHNjZW5lIHdob3NlXG4gKiByYW5rIGlzIHdpdGhpbiB0aGUgdG9wIGB0aWVyLnRvcGAgc2hhcmUgZ2V0cyB0aGF0IHRpZXIuIFRpZWQgc2NlbmVzIHNoYXJlIHRoZSBtaWRkbGUgcG9zaXRpb25cbiAqIG9mIHRoZWlyIHRpZSBncm91cCwgYXMgaW4gcGVyY2VudGlsZVJhdGluZ3MsIHNvIHRoZXkgYWx3YXlzIHNoYXJlIGEgdGllci4gUHJvdmlzaW9uYWwgYW5kXG4gKiB1bnJhdGVkIHNjZW5lcyBnZXQgbm9uZSwgbGlrZSBcInVucmFua2VkXCIgdW50aWwgcGxhY2VtZW50IG1hdGNoZXMgYXJlIGRvbmUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0aWVyTWFwKHNjZW5lczogU2NlbmVbXSk6IE1hcDxzdHJpbmcsIFRpZXI+IHtcbiAgY29uc3Qgc2V0dGxlZCA9IHNjZW5lc1xuICAgIC5maWx0ZXIoKHNjZW5lKSA9PiAhaXNQcm92aXNpb25hbChzY2VuZSkpXG4gICAgLm1hcCgoc2NlbmUpID0+ICh7IGlkOiBzY2VuZS5pZCwgZWxvOiBlbG8oc2NlbmUpIH0pKVxuICAgIC5maWx0ZXIoKHMpOiBzIGlzIHsgaWQ6IHN0cmluZzsgZWxvOiBudW1iZXIgfSA9PiBzLmVsbyAhPT0gbnVsbClcbiAgICAuc29ydCgoYSwgYikgPT4gYi5lbG8gLSBhLmVsbyk7XG5cbiAgY29uc3QgdGllcnMgPSBuZXcgTWFwPHN0cmluZywgVGllcj4oKTtcbiAgY29uc3QgbiA9IHNldHRsZWQubGVuZ3RoO1xuICBsZXQgc3RhcnQgPSAwO1xuICB3aGlsZSAoc3RhcnQgPCBuKSB7XG4gICAgbGV0IGVuZCA9IHN0YXJ0O1xuICAgIHdoaWxlIChlbmQgKyAxIDwgbiAmJiBzZXR0bGVkW2VuZCArIDFdLmVsbyA9PT0gc2V0dGxlZFtzdGFydF0uZWxvKSBlbmQrKztcbiAgICAvLyBTaGFyZSBvZiBzZXR0bGVkIHNjZW5lcyByYW5rZWQgYWJvdmUgdGhpcyB0aWUgZ3JvdXAncyBtaWRkbGUgKDAgZm9yIHRoZSB0b3Agc2NlbmUpXG4gICAgY29uc3QgYWJvdmUgPSAoc3RhcnQgKyBlbmQpIC8gMiAvIG47XG4gICAgY29uc3QgdGllciA9IFRJRVJTLmZpbmQoKHQpID0+IGFib3ZlIDwgdC50b3ApID8/IFRJRVJTW1RJRVJTLmxlbmd0aCAtIDFdO1xuICAgIGZvciAobGV0IGkgPSBzdGFydDsgaSA8PSBlbmQ7IGkrKykgdGllcnMuc2V0KHNldHRsZWRbaV0uaWQsIHRpZXIpO1xuICAgIHN0YXJ0ID0gZW5kICsgMTtcbiAgfVxuICByZXR1cm4gdGllcnM7XG59XG5cbi8qKiBUb29sdGlwIGZvciBhIHRpZXI6IFwiR29sZDogaW4gdGhlIHRvcCAzNSUgb2YgeW91ciBzY2VuZXMgd2l0aCBhIHNldHRsZWQgRUxPXCIuICovXG5leHBvcnQgZnVuY3Rpb24gdGllckRlc2NyaXB0aW9uKHRpZXI6IFRpZXIpOiBzdHJpbmcge1xuICBjb25zdCBpbmRleCA9IFRJRVJTLmZpbmRJbmRleCgodCkgPT4gdC5pZCA9PT0gdGllci5pZCk7XG4gIGNvbnN0IHBlcmNlbnQgPSAoc2hhcmU6IG51bWJlcik6IHN0cmluZyA9PiBgJHtNYXRoLnJvdW5kKHNoYXJlICogMTAwKX0lYDtcbiAgY29uc3Qgd2hlcmUgPVxuICAgIGluZGV4ID09PSBUSUVSUy5sZW5ndGggLSAxICYmIGluZGV4ID4gMFxuICAgICAgPyBgYmVsb3cgdGhlIHRvcCAke3BlcmNlbnQoVElFUlNbaW5kZXggLSAxXS50b3ApfWBcbiAgICAgIDogYGluIHRoZSB0b3AgJHtwZXJjZW50KHRpZXIudG9wKX1gO1xuICByZXR1cm4gYCR7dGllci5uYW1lfTogJHt3aGVyZX0gb2YgeW91ciBzY2VuZXMgd2l0aCBhIHNldHRsZWQgRUxPYDtcbn1cbiIsICJpbXBvcnQgdHlwZSB7IFNjZW5lIH0gZnJvbSBcIi4uL3R5cGVzXCI7XHJcblxyXG4vKiogU2NlbmUgdGl0bGUgZnJvbSBtZXRhZGF0YSwgb3IgdGhlIGZpbGVuYW1lICh3aXRob3V0IGV4dGVuc2lvbikgZnJvbSB0aGUgZmlsZSBwYXRoLiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZVNjZW5lVGl0bGUoc2NlbmU6IFNjZW5lKTogc3RyaW5nIHtcclxuICBpZiAoc2NlbmUudGl0bGUpIHJldHVybiBzY2VuZS50aXRsZTtcclxuXHJcbiAgY29uc3QgcGF0aCA9IHNjZW5lLmZpbGVzPy5bMF0/LnBhdGg7XHJcbiAgaWYgKHBhdGgpIHtcclxuICAgIGNvbnN0IHBhdGhQYXJ0cyA9IHBhdGguc3BsaXQoL1svXFxcXF0vKTtcclxuICAgIHJldHVybiBwYXRoUGFydHNbcGF0aFBhcnRzLmxlbmd0aCAtIDFdLnJlcGxhY2UoL1xcLlteLy5dKyQvLCBcIlwiKTtcclxuICB9XHJcblxyXG4gIHJldHVybiBcIlwiO1xyXG59XHJcbiIsICIvLyBSZW5kZXJzIGFuIGluZGl2aWR1YWwgc2NlbmUgY2FyZCAocmV0dXJucyBhbiBIVE1MIHN0cmluZykuXG5cbmltcG9ydCB7IENIQU1QSU9OX1VOUkFURURfRUxPLCBFTE9fS19USUVSUywgRUxPX1NUQVJUIH0gZnJvbSBcIi4uL2NvbnN0YW50c1wiO1xuaW1wb3J0IHsgYmF0dGxlcywgZWxvLCBpc1Byb3Zpc2lvbmFsIH0gZnJvbSBcIi4uL3Njb3JlXCI7XG5pbXBvcnQgeyBzdGF0ZSB9IGZyb20gXCIuLi9zdGF0ZVwiO1xuaW1wb3J0IHsgdGllckRlc2NyaXB0aW9uIH0gZnJvbSBcIi4uL3N0YXRzXCI7XG5pbXBvcnQgeyBpc1N0YXNoRGVsZXRlRGlhbG9nQXZhaWxhYmxlIH0gZnJvbSBcIi4vZGVsZXRlRGlhbG9nXCI7XG5pbXBvcnQgdHlwZSB7IFJhbmssIFNjZW5lLCBUaWVyIH0gZnJvbSBcIi4uL3R5cGVzXCI7XG5pbXBvcnQgeyByZXNvbHZlU2NlbmVUaXRsZSB9IGZyb20gXCIuL3NjZW5lVGl0bGVcIjtcblxuLyoqIFRvb2x0aXAgZm9yIGEgcHJvdmlzaW9uYWwgRUxPICh0aGUgXCI/XCIgYWZ0ZXIgaXQpLiAqL1xuZXhwb3J0IGNvbnN0IFBST1ZJU0lPTkFMX1RJUCA9IGBQcm92aXNpb25hbDogZmV3ZXIgdGhhbiAke0VMT19LX1RJRVJTWzBdWzBdfSBiYXR0bGVzLCBzbyB0aGlzIEVMTyBpcyBzdGlsbCBzZXR0bGluZ2A7XG5cbi8qKiBTbWFsbCBwaWxsIHdpdGggdGhlIHRpZXIncyBlbW9qaSBhbmQgbmFtZSAodGhlIG5hbWUgaGlkZXMgb24gcGhvbmVzKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0aWVyUGlsbCh0aWVyOiBUaWVyKTogc3RyaW5nIHtcbiAgcmV0dXJuIGA8c3BhbiBjbGFzcz1cInNiLXRpZXIgc2ItdGllci0ke3RpZXIuaWR9XCIgdGl0bGU9XCIke3RpZXJEZXNjcmlwdGlvbih0aWVyKX1cIj4ke3RpZXIuZW1vaml9PHNwYW4gY2xhc3M9XCJzYi10aWVyLW5hbWVcIj4gJHt0aWVyLm5hbWV9PC9zcGFuPjwvc3Bhbj5gO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0RHVyYXRpb24oc2Vjb25kczogbnVtYmVyIHwgbnVsbCB8IHVuZGVmaW5lZCk6IHN0cmluZyB7XG4gIGlmICghc2Vjb25kcykgcmV0dXJuIFwiTi9BXCI7XG4gIGNvbnN0IGggPSBNYXRoLmZsb29yKHNlY29uZHMgLyAzNjAwKTtcbiAgY29uc3QgbSA9IE1hdGguZmxvb3IoKHNlY29uZHMgJSAzNjAwKSAvIDYwKTtcbiAgY29uc3QgcyA9IE1hdGguZmxvb3Ioc2Vjb25kcyAlIDYwKTtcbiAgaWYgKGggPiAwKSB7XG4gICAgcmV0dXJuIGAke2h9OiR7bS50b1N0cmluZygpLnBhZFN0YXJ0KDIsIFwiMFwiKX06JHtzLnRvU3RyaW5nKCkucGFkU3RhcnQoMiwgXCIwXCIpfWA7XG4gIH1cbiAgcmV0dXJuIGAke219OiR7cy50b1N0cmluZygpLnBhZFN0YXJ0KDIsIFwiMFwiKX1gO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlU2NlbmVDYXJkKFxuICBzY2VuZTogU2NlbmUsXG4gIHNpZGU6IFwibGVmdFwiIHwgXCJyaWdodFwiLFxuICByYW5rOiBSYW5rID0gbnVsbCxcbiAgc3RhdHVzQmFkZ2U6IG51bWJlciB8IHN0cmluZyB8IG51bGwgPSBudWxsLFxuICB0aWVyOiBUaWVyIHwgbnVsbCA9IG51bGwsXG4pOiBzdHJpbmcge1xuICBjb25zdCBmaWxlID0gc2NlbmUuZmlsZXMgJiYgc2NlbmUuZmlsZXNbMF0gPyBzY2VuZS5maWxlc1swXSA6IHt9O1xuICBjb25zdCBkdXJhdGlvbiA9IGZpbGUuZHVyYXRpb247XG4gIGNvbnN0IHBlcmZvcm1lcnMgPVxuICAgIHNjZW5lLnBlcmZvcm1lcnMgJiYgc2NlbmUucGVyZm9ybWVycy5sZW5ndGggPiAwXG4gICAgICA/IHNjZW5lLnBlcmZvcm1lcnMubWFwKChwKSA9PiBwLm5hbWUpLmpvaW4oXCIsIFwiKVxuICAgICAgOiBcIk5vIHBlcmZvcm1lcnNcIjtcbiAgY29uc3Qgc3R1ZGlvID0gc2NlbmUuc3R1ZGlvID8gc2NlbmUuc3R1ZGlvLm5hbWUgOiBcIk5vIHN0dWRpb1wiO1xuICBjb25zdCB0YWdzID0gc2NlbmUudGFncyA/IHNjZW5lLnRhZ3Muc2xpY2UoMCwgNSkubWFwKCh0KSA9PiB0Lm5hbWUpIDogW107XG5cbiAgY29uc3QgdGl0bGUgPSByZXNvbHZlU2NlbmVUaXRsZShzY2VuZSk7XG5cbiAgY29uc3Qgc2NyZWVuc2hvdFBhdGggPSBzY2VuZS5wYXRocyA/IHNjZW5lLnBhdGhzLnNjcmVlbnNob3QgOiBudWxsO1xuICBjb25zdCBwcmV2aWV3UGF0aCA9IHNjZW5lLnBhdGhzID8gc2NlbmUucGF0aHMucHJldmlldyA6IG51bGw7XG4gIGNvbnN0IHsgb3BlbkluTmV3VGFiLCBjbGVhbk1vZGUgfSA9IHN0YXRlLnNldHRpbmdzO1xuICBjb25zdCBzdGFzaFJhdGluZyA9IHNjZW5lLnJhdGluZzEwMCA/IGAke3NjZW5lLnJhdGluZzEwMH0vMTAwYCA6IFwiTm9uZVwiO1xuXG4gIC8vIEVMTyBiYWRnZTogXCJFTE8gMTc0MCDCtyAjNTBcIiB3aGVuIHJhdGVkIChyYW5rIHdoZW4ga25vd24pLCB3aXRoIGEgXCI/XCIgd2hpbGUgaXQncyBwcm92aXNpb25hbC5cbiAgLy8gVW5yYXRlZCBzY2VuZXMgc2hvdyB0aGUgRUxPIHRoZXkgY291bnQgYXMgaW4gdGhpcyBtb2RlIGluIHRoZSBzYW1lIG9yZGVyLCBcIkVMTyAxNTAwIMK3XG4gIC8vIFVucmF0ZWRcIiAoUGxhY2VtZW50IGhhcyBub25lOiBcIlVucmF0ZWRcIikuXG4gIGNvbnN0IGVsb1ZhbHVlID0gZWxvKHNjZW5lKTtcbiAgY29uc3QgdW5yYXRlZEFzID1cbiAgICBzdGF0ZS5jdXJyZW50TW9kZSA9PT0gXCJzd2lzc1wiID8gRUxPX1NUQVJUIDogc3RhdGUuY3VycmVudE1vZGUgPT09IFwiY2hhbXBpb25cIiA/IENIQU1QSU9OX1VOUkFURURfRUxPIDogbnVsbDtcbiAgY29uc3QgcHJvdmlzaW9uYWwgPSBpc1Byb3Zpc2lvbmFsKHNjZW5lKTtcbiAgbGV0IGVsb0xhYmVsOiBzdHJpbmc7XG4gIGlmIChlbG9WYWx1ZSAhPT0gbnVsbCkge1xuICAgIGVsb0xhYmVsID0gYEVMTyAke01hdGgucm91bmQoZWxvVmFsdWUpfSR7cHJvdmlzaW9uYWwgPyBcIj9cIiA6IFwiXCJ9JHtyYW5rICE9PSBudWxsICYmIHJhbmsgIT09IHVuZGVmaW5lZCA/IGAgwrcgIyR7cmFua31gIDogXCJcIn1gO1xuICB9IGVsc2Uge1xuICAgIGVsb0xhYmVsID0gdW5yYXRlZEFzICE9PSBudWxsID8gYEVMTyAke3VucmF0ZWRBc30gwrcgVW5yYXRlZGAgOiBcIlVucmF0ZWRcIjtcbiAgfVxuICBjb25zdCByYW5rVGl0bGUgPSBwcm92aXNpb25hbCA/IGAgdGl0bGU9XCIke1BST1ZJU0lPTkFMX1RJUH1cImAgOiBcIlwiO1xuICBjb25zdCByYW5rRGlzcGxheSA9IGAke3RpZXIgPyB0aWVyUGlsbCh0aWVyKSA6IFwiXCJ9PHNwYW4gY2xhc3M9XCJzYi1zY2VuZS1yYW5rXCIke3JhbmtUaXRsZX0+JHtlbG9MYWJlbH08L3NwYW4+YDtcblxuICAvLyBTdGF0dXMgYmFkZ2U6IHdpbi1zdHJlYWsgY291bnQgKGZvcm1hdHRlZCkgb3IgY3VzdG9tIGxhYmVsIChlLmcuIGZhbGxpbmcgbW9kZSlcbiAgbGV0IHN0YXR1c0JhZGdlSHRtbCA9IFwiXCI7XG4gIGlmICh0eXBlb2Ygc3RhdHVzQmFkZ2UgPT09IFwic3RyaW5nXCIpIHtcbiAgICBzdGF0dXNCYWRnZUh0bWwgPSBgPGRpdiBjbGFzcz1cInNiLXN0cmVhay1iYWRnZVwiPiR7c3RhdHVzQmFkZ2V9PC9kaXY+YDtcbiAgfSBlbHNlIGlmIChzdGF0dXNCYWRnZSAhPT0gbnVsbCAmJiBzdGF0dXNCYWRnZSA+IDApIHtcbiAgICBzdGF0dXNCYWRnZUh0bWwgPSBgPGRpdiBjbGFzcz1cInNiLXN0cmVhay1iYWRnZVwiPvCflKUgJHtzdGF0dXNCYWRnZX0gd2luJHtzdGF0dXNCYWRnZSA+IDEgPyBcInNcIiA6IFwiXCJ9PC9kaXY+YDtcbiAgfVxuXG4gIC8vIFByZXNlcnZlIFVSTCBzZWFyY2ggcGFyYW1zIHdoZW4gb3BlbmluZyBzY2VuZVxuICBjb25zdCBjdXJyZW50UGFyYW1zID0gd2luZG93LmxvY2F0aW9uLnNlYXJjaDtcbiAgY29uc3Qgc2NlbmVVcmwgPSBgL3NjZW5lcy8ke3NjZW5lLmlkfSR7Y3VycmVudFBhcmFtc31gO1xuICBjb25zdCBsaW5rVGFyZ2V0ID0gb3BlbkluTmV3VGFiID8gYCB0YXJnZXQ9XCJfYmxhbmtcIiByZWw9XCJub29wZW5lclwiYCA6IFwiXCI7XG5cbiAgLy8gcHdyLSogY2xhc3NlcyBhcmUgdGhlIHBsdWdpbidzIHByZS0yLjAgbmFtZXM7IFNGVyBTd2l0Y2ggc3RpbGwgdGFyZ2V0cyB0aGVtIHRvIGJsdXIgU3Rhc2ggQmF0dGxlLlxuICAvLyBCYWRnZXMgc2l0IG91dHNpZGUgdGhlIChibHVycmVkKSBpbWFnZSBjb250YWluZXIgc28gdGhleSBzdGF5IHJlYWRhYmxlIGluIFNGVyBtb2RlLlxuICByZXR1cm4gYFxuICAgICAgPGRpdiBjbGFzcz1cInNiLXNjZW5lLWNhcmQke3RpZXIgPyBgIHNiLXRpZXItJHt0aWVyLmlkfWAgOiBcIlwifVwiIGRhdGEtc2lkZT1cIiR7c2lkZX1cIiR7dGllciA/IGAgZGF0YS10aWVyPVwiJHt0aWVyLmlkfVwiYCA6IFwiXCJ9PlxuICAgICAgICA8ZGl2IGNsYXNzPVwic2Itc2NlbmUtbWVkaWFcIj5cbiAgICAgICAgICA8YSBjbGFzcz1cInNiLXNjZW5lLWltYWdlLWNvbnRhaW5lciBwd3Itc2NlbmUtaW1hZ2UtY29udGFpbmVyXCIgaHJlZj1cIiR7c2NlbmVVcmx9XCIke2xpbmtUYXJnZXR9PlxuICAgICAgICAgICAgJHtcbiAgICAgICAgICAgICAgc2NyZWVuc2hvdFBhdGhcbiAgICAgICAgICAgICAgICA/IGA8aW1nIGNsYXNzPVwic2Itc2NlbmUtaW1hZ2UgcHdyLXNjZW5lLWltYWdlXCIgc3JjPVwiJHtzY3JlZW5zaG90UGF0aH1cIiBhbHQ9XCIke3RpdGxlfVwiIGxvYWRpbmc9XCJsYXp5XCIgLz5gXG4gICAgICAgICAgICAgICAgOiBgPGRpdiBjbGFzcz1cInNiLXNjZW5lLWltYWdlIHNiLW5vLWltYWdlXCI+Tm8gU2NyZWVuc2hvdDwvZGl2PmBcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgICR7cHJldmlld1BhdGggPyBgPHZpZGVvIGNsYXNzPVwic2ItaG92ZXItcHJldmlldyBwd3ItaG92ZXItcHJldmlld1wiIHNyYz1cIiR7cHJldmlld1BhdGh9XCIgbG9vcCBtdXRlZCBwbGF5c2lubGluZT48L3ZpZGVvPmAgOiBcIlwifVxuICAgICAgICAgIDwvYT5cbiAgICAgICAgICA8ZGl2IGNsYXNzPVwic2Itc2NlbmUtZHVyYXRpb25cIj4ke2Zvcm1hdER1cmF0aW9uKGR1cmF0aW9uKX08L2Rpdj5cbiAgICAgICAgICAke3N0YXR1c0JhZGdlSHRtbH1cbiAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItY2xpY2staGludFwiPiR7b3BlbkluTmV3VGFiID8gXCJDbGljayB0byBvcGVuIGluIG5ldyB0YWJcIiA6IFwiQ2xpY2sgdG8gb3BlbiBzY2VuZVwifTwvZGl2PlxuICAgICAgICAgIDxhIGNsYXNzPVwic2Itb3Blbi1saW5rXCIgaHJlZj1cIiR7c2NlbmVVcmx9XCIgdGFyZ2V0PVwiX2JsYW5rXCIgcmVsPVwibm9vcGVuZXJcIiB0aXRsZT1cIk9wZW4gc2NlbmUgaW4gbmV3IHRhYlwiPuKGlzwvYT5cbiAgICAgICAgICAke2NsZWFuTW9kZSAmJiBpc1N0YXNoRGVsZXRlRGlhbG9nQXZhaWxhYmxlKCkgPyBgPGJ1dHRvbiB0eXBlPVwiYnV0dG9uXCIgY2xhc3M9XCJzYi1kZWxldGUtYnRuXCIgdGl0bGU9XCJEZWxldGUgdGhpcyBzY2VuZSBmcm9tIFN0YXNoXCI+8J+XkTwvYnV0dG9uPmAgOiBcIlwifVxuICAgICAgICA8L2Rpdj5cblxuICAgICAgICA8ZGl2IGNsYXNzPVwic2Itc2NlbmUtYm9keVwiIGRhdGEtd2lubmVyPVwiJHtzY2VuZS5pZH1cIj5cbiAgICAgICAgICA8ZGl2IGNsYXNzPVwic2Itc2NlbmUtaW5mbyBwd3Itc2NlbmUtaW5mb1wiPlxuICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNiLXNjZW5lLXRpdGxlLXJvd1wiPlxuICAgICAgICAgICAgICA8aDMgY2xhc3M9XCJzYi1zY2VuZS10aXRsZVwiPiR7dGl0bGV9PC9oMz5cbiAgICAgICAgICAgICAgJHtyYW5rRGlzcGxheX1cbiAgICAgICAgICAgIDwvZGl2PlxuXG4gICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2Itc2NlbmUtbWV0YVwiPlxuICAgICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItbWV0YS1pdGVtIHNiLW1ldGEtc3R1ZGlvXCI+PHN0cm9uZz5TdHVkaW86PC9zdHJvbmc+ICR7c3R1ZGlvfTwvZGl2PlxuICAgICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItbWV0YS1pdGVtIHNiLW1ldGEtcGVyZm9ybWVyc1wiPjxzdHJvbmc+UGVyZm9ybWVyczo8L3N0cm9uZz4gJHtwZXJmb3JtZXJzfTwvZGl2PlxuICAgICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItbWV0YS1pdGVtIHNiLW1ldGEtcGxheXNcIj48c3Ryb25nPlBsYXkgQ291bnQ6PC9zdHJvbmc+ICR7c2NlbmUucGxheV9jb3VudCB8fCAwfTwvZGl2PlxuICAgICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItbWV0YS1pdGVtIHNiLW1ldGEtYmF0dGxlc1wiPjxzdHJvbmc+QmF0dGxlczo8L3N0cm9uZz4gJHtiYXR0bGVzKHNjZW5lKX08L2Rpdj5cbiAgICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNiLW1ldGEtaXRlbSBzYi1tZXRhLXJhdGluZ1wiPjxzdHJvbmc+U3Rhc2ggUmF0aW5nOjwvc3Ryb25nPiAke3N0YXNoUmF0aW5nfTwvZGl2PlxuICAgICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItbWV0YS1pdGVtIHNiLXRhZ3Mtcm93XCI+PHN0cm9uZz5UYWdzOjwvc3Ryb25nPiAke3RhZ3MubGVuZ3RoID4gMCA/IHRhZ3MubWFwKCh0YWcpID0+IGA8c3BhbiBjbGFzcz1cInNiLXRhZ1wiPiR7dGFnfTwvc3Bhbj5gKS5qb2luKFwiXCIpIDogJzxzcGFuIGNsYXNzPVwic2Itbm9uZVwiPk5vbmU8L3NwYW4+J308L2Rpdj5cbiAgICAgICAgICAgIDwvZGl2PlxuICAgICAgICAgIDwvZGl2PlxuXG4gICAgICAgICAgPGRpdiBjbGFzcz1cInNiLWNob29zZS1idG5cIj5cbiAgICAgICAgICAgIOKckyBDaG9vc2U8c3BhbiBjbGFzcz1cInNiLWNob29zZS1sb25nXCI+IFRoaXMgU2NlbmU8L3NwYW4+XG4gICAgICAgICAgPC9kaXY+XG4gICAgICAgIDwvZGl2PlxuICAgICAgPC9kaXY+XG4gICAgYDtcbn1cbiIsICIvLyBWaWN0b3J5IGFuZCBwbGFjZW1lbnQgZW5kLXNjcmVlbnMgZm9yIENoYW1waW9uIGFuZCBQbGFjZW1lbnQgcnVucy5cblxuaW1wb3J0IHsgbGF0ZXN0U2NlbmUgfSBmcm9tIFwiLi4vY2FjaGVcIjtcbmltcG9ydCB7IGVsbywgc3Rhc2hSYXRpbmdUYXJnZXRzIH0gZnJvbSBcIi4uL3Njb3JlXCI7XG5pbXBvcnQgeyByZXNldFJ1blN0YXRlLCBzdGF0ZSB9IGZyb20gXCIuLi9zdGF0ZVwiO1xuaW1wb3J0IHsgc2F2ZVN0YXRlIH0gZnJvbSBcIi4uL3N0b3JhZ2VcIjtcbmltcG9ydCB0eXBlIHsgUGxhY2VtZW50UGFpclJlc3VsdCwgU2NlbmUgfSBmcm9tIFwiLi4vdHlwZXNcIjtcbmltcG9ydCB7IGxvYWROZXdQYWlyLCBzZXRBY3Rpb25zVmlzaWJsZSB9IGZyb20gXCIuL21haW5VSVwiO1xuaW1wb3J0IHsgcmVzb2x2ZVNjZW5lVGl0bGUgfSBmcm9tIFwiLi9zY2VuZVRpdGxlXCI7XG5cbmZ1bmN0aW9uIGJ1aWxkRW5kU2NyZWVuSHRtbChcbiAgc2NlbmU6IFNjZW5lLFxuICBjcm93bjogc3RyaW5nLFxuICBoZWFkbGluZTogc3RyaW5nLFxuICBzdGF0c0h0bWw6IHN0cmluZyxcbiAgYnV0dG9uTGFiZWw6IHN0cmluZyxcbik6IHN0cmluZyB7XG4gIGNvbnN0IHRpdGxlID0gcmVzb2x2ZVNjZW5lVGl0bGUoc2NlbmUpO1xuICBjb25zdCBzY3JlZW5zaG90UGF0aCA9IHNjZW5lLnBhdGhzPy5zY3JlZW5zaG90ID8/IG51bGw7XG5cbiAgcmV0dXJuIGBcbiAgICAgIDxkaXYgY2xhc3M9XCJzYi1lbmQtc2NyZWVuXCI+XG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi1lbmQtc2NyZWVuLWljb25cIj4ke2Nyb3dufTwvZGl2PlxuICAgICAgICA8aDIgY2xhc3M9XCJzYi1lbmQtc2NyZWVuLWhlYWRsaW5lXCI+JHtoZWFkbGluZX08L2gyPlxuICAgICAgICA8ZGl2IGNsYXNzPVwic2ItZW5kLXNjcmVlbi1zY2VuZSBwd3Itc2NlbmUtaW1hZ2UtY29udGFpbmVyXCI+XG4gICAgICAgICAgJHtcbiAgICAgICAgICAgIHNjcmVlbnNob3RQYXRoXG4gICAgICAgICAgICAgID8gYDxpbWcgY2xhc3M9XCJzYi1lbmQtc2NyZWVuLWltYWdlIHB3ci1zY2VuZS1pbWFnZVwiIHNyYz1cIiR7c2NyZWVuc2hvdFBhdGh9XCIgYWx0PVwiJHt0aXRsZX1cIiAvPmBcbiAgICAgICAgICAgICAgOiBgPGRpdiBjbGFzcz1cInNiLWVuZC1zY3JlZW4taW1hZ2Ugc2Itbm8taW1hZ2VcIj5ObyBTY3JlZW5zaG90PC9kaXY+YFxuICAgICAgICAgIH1cbiAgICAgICAgPC9kaXY+XG4gICAgICAgIDxoMyBjbGFzcz1cInNiLWVuZC1zY3JlZW4tbmFtZVwiPiR7dGl0bGV9PC9oMz5cbiAgICAgICAgPHAgY2xhc3M9XCJzYi1lbmQtc2NyZWVuLXN0YXRzXCI+JHtzdGF0c0h0bWx9PC9wPlxuICAgICAgICA8YnV0dG9uIGlkPVwic2ItbmV3LXJ1blwiIGNsYXNzPVwiYnRuIGJ0bi1wcmltYXJ5XCI+JHtidXR0b25MYWJlbH08L2J1dHRvbj5cbiAgICAgIDwvZGl2PlxuICAgIGA7XG59XG5cbi8qKiBSZW5kZXIgYW4gZW5kIHNjcmVlbiwgaGlkZSBiYXR0bGUgY29udHJvbHMsIGFuZCB3aXJlIHRoZSBuZXctcnVuIGJ1dHRvbi4gKi9cbmZ1bmN0aW9uIHNob3dFbmRTY3JlZW4oaHRtbDogc3RyaW5nKTogdm9pZCB7XG4gIGNvbnN0IGNvbXBhcmlzb25BcmVhID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzYi1jb21wYXJpc29uLWFyZWFcIik7XG4gIGlmICghY29tcGFyaXNvbkFyZWEpIHJldHVybjtcblxuICBjb21wYXJpc29uQXJlYS5pbm5lckhUTUwgPSBodG1sO1xuICBzZXRBY3Rpb25zVmlzaWJsZShmYWxzZSk7XG5cbiAgY29tcGFyaXNvbkFyZWEucXVlcnlTZWxlY3RvcihcIiNzYi1uZXctcnVuXCIpPy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4ge1xuICAgIGxvYWROZXdQYWlyKCk7XG4gIH0pO1xufVxuXG4vKiogQ2FwdHVyZSBkaXNwbGF5IHZhbHVlcywgY2xlYXIgcnVuIHN0YXRlLCB0aGVuIHNob3cgdGhlIGVuZCBzY3JlZW4uICovXG5mdW5jdGlvbiBmaW5pc2hSdW5TaG93RW5kU2NyZWVuKGh0bWw6IHN0cmluZyk6IHZvaWQge1xuICByZXNldFJ1blN0YXRlKCk7XG4gIC8vIFRoZSBsYXN0IHBhaXIgYmVsb25ncyB0byB0aGUgZmluaXNoZWQgcnVuOiBhIHJlbG9hZCBtdXN0bid0IHJlc3RvcmUgaXQgd2l0aG91dCBpdHMgcnVuXG4gIHN0YXRlLmN1cnJlbnRQYWlyID0geyBsZWZ0OiBudWxsLCByaWdodDogbnVsbCB9O1xuICBzdGF0ZS5jdXJyZW50UmFua3MgPSB7IGxlZnQ6IG51bGwsIHJpZ2h0OiBudWxsIH07XG4gIHNhdmVTdGF0ZSgpO1xuICBzaG93RW5kU2NyZWVuKGh0bWwpO1xufVxuXG4vKipcbiAqIFwiRUxPOiAxNzQwXCIsIHBsdXMgXCLCtyBTdGFzaCBSYXRpbmc6IDc0XCIgd2hpbGUgYW4gdXBkYXRlIG1vZGUgaXMgb24uIFRoZSByYXRpbmcgaXMgd29ya2VkIG91dFxuICogdGhlIHdheSB0aGUgc3luYyBkb2VzIGl0IChpdCBtYXkgc3RpbGwgYmUgb24gaXRzIHdheSB0byBTdGFzaCksIHNvIGl0J3Mgd2hhdCBTdGFzaCB3aWxsIHNob3cuXG4gKi9cbmZ1bmN0aW9uIGVsb0xpbmUoc2NlbmU6IFNjZW5lLCB2YWx1ZTogbnVtYmVyIHwgbnVsbCk6IHN0cmluZyB7XG4gIGlmICh2YWx1ZSA9PT0gbnVsbCkgcmV0dXJuIFwiXCI7XG4gIGxldCBsaW5lID0gYDxicj5FTE86IDxzdHJvbmc+JHtNYXRoLnJvdW5kKHZhbHVlKX08L3N0cm9uZz5gO1xuICBjb25zdCBtb2RlID0gc3RhdGUuc2V0dGluZ3Muc3Rhc2hSYXRpbmdzO1xuICBjb25zdCBzY2VuZXMgPSBzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXM7XG4gIGlmIChtb2RlICE9PSBcIm9mZlwiICYmIHNjZW5lcykge1xuICAgIGNvbnN0IHJhdGluZyA9IHN0YXNoUmF0aW5nVGFyZ2V0cyhzY2VuZXMsIG1vZGUpLmdldChzY2VuZS5pZCk7XG4gICAgaWYgKHJhdGluZyAhPT0gdW5kZWZpbmVkKSBsaW5lICs9IGAgwrcgU3Rhc2ggUmF0aW5nOiA8c3Ryb25nPiR7cmF0aW5nfTwvc3Ryb25nPmA7XG4gIH1cbiAgcmV0dXJuIGxpbmU7XG59XG5cbi8qKiBDaGFtcGlvbiBiZWF0IGV2ZXJ5IHNjZW5lIGFib3ZlIGl0LCBvciBhIGNsaW1iIGZyb20gdGhlIGJvdHRvbSBuZXZlciBsb3N0OiBpdCdzICMxLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNob3dWaWN0b3J5U2NyZWVuKGNoYW1waW9uOiBTY2VuZSwgd2luU3RyZWFrOiBudW1iZXIpOiB2b2lkIHtcbiAgY29uc3QgaHRtbCA9IGJ1aWxkRW5kU2NyZWVuSHRtbChcbiAgICBjaGFtcGlvbixcbiAgICBcIvCfkZFcIixcbiAgICBcIkNIQU1QSU9OIVwiLFxuICAgIGBSZWFjaGVkIHRoZSB0b3A6ICR7d2luU3RyZWFrfSB3aW4ke3dpblN0cmVhayA9PT0gMSA/IFwiXCIgOiBcInNcIn0gaW4gYSByb3chJHtlbG9MaW5lKGNoYW1waW9uLCBlbG8obGF0ZXN0U2NlbmUoY2hhbXBpb24pKSl9YCxcbiAgICBcIlN0YXJ0IE5ldyBSdW5cIixcbiAgKTtcblxuICBmaW5pc2hSdW5TaG93RW5kU2NyZWVuKGh0bWwpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2hvd1BsYWNlbWVudFNjcmVlbihyZXN1bHQ6IEV4dHJhY3Q8UGxhY2VtZW50UGFpclJlc3VsdCwgeyBkb25lOiB0cnVlIH0+KTogdm9pZCB7XG4gIGNvbnN0IHsgc2NlbmUsIHJhbmssIGJhdHRsZXMsIHN0cmVhaywgZnJvbUJvdHRvbSB9ID0gcmVzdWx0O1xuICBjb25zdCBzdHJlYWtUZXh0ID0gZnJvbUJvdHRvbSAmJiBzdHJlYWsgPiAwID8gYPCflKUgJHtzdHJlYWt9IHdpbiBzdHJlYWsgwrcgYCA6IFwiXCI7XG4gIGNvbnN0IGJhdHRsZXNUZXh0ID0gYmF0dGxlcyA/IGAgwrcgJHtiYXR0bGVzfSBiYXR0bGUke2JhdHRsZXMgPT09IDEgPyBcIlwiIDogXCJzXCJ9YCA6IFwiXCI7XG4gIGNvbnN0IGh0bWwgPSBidWlsZEVuZFNjcmVlbkh0bWwoXG4gICAgc2NlbmUsXG4gICAgXCLwn5ONXCIsXG4gICAgXCJQTEFDRUQhXCIsXG4gICAgYCR7c3RyZWFrVGV4dH1SYW5rIDxzdHJvbmc+IyR7cmFua308L3N0cm9uZz4gb2YgJHtzdGF0ZS50b3RhbFNjZW5lc0NvdW50fSR7YmF0dGxlc1RleHR9JHtlbG9MaW5lKHNjZW5lLCByZXN1bHQuZWxvKX1gLFxuICAgIFwiU3RhcnQgTmV3IFJ1blwiLFxuICApO1xuXG4gIGZpbmlzaFJ1blNob3dFbmRTY3JlZW4oaHRtbCk7XG59XG4iLCAiLy8gV2hhdCBlYWNoIFwiU3Rhc2ggcmF0aW5nc1wiIG9wdGlvbiBkb2VzLCBzaGFyZWQgYnkgdGhlIHNldHVwIHNjcmVlbiBhbmQgdGhlIFNldHRpbmdzIGRyb3Bkb3duLlxuXG5pbXBvcnQgdHlwZSB7IFN0YXNoUmF0aW5nc01vZGUgfSBmcm9tIFwiLi4vdHlwZXNcIjtcblxuZXhwb3J0IGNvbnN0IFNUQVNIX1JBVElOR1NfT1BUSU9OUzogcmVhZG9ubHkgeyB2YWx1ZTogU3Rhc2hSYXRpbmdzTW9kZTsgbGFiZWw6IHN0cmluZzsgZGVzYzogc3RyaW5nIH1bXSA9IFtcbiAgeyB2YWx1ZTogXCJvZmZcIiwgbGFiZWw6IFwiRG9uJ3QgdXBkYXRlXCIsIGRlc2M6IFwiRUxPIGlzIHNhdmVkOyB5b3VyIFN0YXNoIHJhdGluZ3Mgc3RheSBhcyB0aGV5IGFyZS5cIiB9LFxuICB7XG4gICAgdmFsdWU6IFwibGluZWFyXCIsXG4gICAgbGFiZWw6IFwiU3RyYWlnaHQtbGluZVwiLFxuICAgIGRlc2M6IFwiUmF0aW5nID0gRUxPIGNvbnZlcnRlZCBiYWNrICgxNTAwID0gNTAsIDEwIEVMTyBwZXIgcG9pbnQpLiBWZXJ5IGhpZ2ggb3IgbG93IHNjZW5lcyBzdG9wIGF0IDEwMCBvciAxLlwiLFxuICB9LFxuICB7XG4gICAgdmFsdWU6IFwicGVyY2VudGlsZVwiLFxuICAgIGxhYmVsOiBcIlBlcmNlbnRpbGVcIixcbiAgICBkZXNjOiBcIlJhdGluZyA9IHBlcmNlbnRpbGUgaW4geW91ciBsaWJyYXJ5OiA5MCBtZWFucyB0aGUgc2NlbmUgcmFua3MgYWJvdmUgYWJvdXQgOTAlIG9mIHlvdXIgc2NlbmVzLiBUb3Agc2NlbmUgMTAwLCBib3R0b20gMS5cIixcbiAgfSxcbl07XG5cbmV4cG9ydCBmdW5jdGlvbiBzdGFzaFJhdGluZ3NPcHRpb24odmFsdWU6IFN0YXNoUmF0aW5nc01vZGUpOiAodHlwZW9mIFNUQVNIX1JBVElOR1NfT1BUSU9OUylbbnVtYmVyXSB7XG4gIHJldHVybiBTVEFTSF9SQVRJTkdTX09QVElPTlMuZmluZCgob3B0aW9uKSA9PiBvcHRpb24udmFsdWUgPT09IHZhbHVlKSA/PyBTVEFTSF9SQVRJTkdTX09QVElPTlNbMF07XG59XG4iLCAiLy8gQmF0dGxlIC8gU2V0dGluZ3MgdGFicyAoU3Rhc2gncyBvd24gbmF2LXRhYnMgKyAuc2V0dGluZyByb3dzLCBsaWtlIFN0YXNoLVRDb2RlKSwgcGx1cyB0aGVcbi8vIHByZXZpZXcgdm9sdW1lIGNvbnRyb2wgdGhhdCBzaXRzIG9uIHRoZSB0YWIgYmFyLiBFdmVyeSBjb250cm9sIGNhcnJpZXMgZGF0YS1zZXR0aW5nPVwiPGtleT5cIjtcbi8vIHZhbHVlcyBwZXJzaXN0IHZpYSB1cGRhdGVTZXR0aW5ncygpLiBBY3Rpb24gcm93cyAoUmVzZXQgRUxPKSBjYXJyeSBkYXRhLWFjdGlvbiBpbnN0ZWFkLlxuXG5pbXBvcnQgeyB1cGRhdGVTZXR0aW5ncyB9IGZyb20gXCIuLi9zZXR0aW5nc1wiO1xuaW1wb3J0IHsgc3RhdGUgfSBmcm9tIFwiLi4vc3RhdGVcIjtcbmltcG9ydCB0eXBlIHsgU2V0dGluZ3MsIFN0YXNoUmF0aW5nc01vZGUgfSBmcm9tIFwiLi4vdHlwZXNcIjtcbmltcG9ydCB7IFNUQVNIX1JBVElOR1NfT1BUSU9OUywgc3Rhc2hSYXRpbmdzT3B0aW9uIH0gZnJvbSBcIi4vc3Rhc2hSYXRpbmdzVGV4dFwiO1xuXG50eXBlIEJvb2xLZXkgPSB7IFtLIGluIGtleW9mIFNldHRpbmdzXTogU2V0dGluZ3NbS10gZXh0ZW5kcyBib29sZWFuID8gSyA6IG5ldmVyIH1ba2V5b2YgU2V0dGluZ3NdO1xuZXhwb3J0IHR5cGUgVGFiSWQgPSBcImJhdHRsZVwiIHwgXCJzZXR0aW5nc1wiO1xuXG50eXBlIFNldHRpbmdSb3cgPVxuICB8IHsga2V5OiBrZXlvZiBTZXR0aW5nczsgdGl0bGU6IHN0cmluZzsgaGludDogc3RyaW5nIH1cbiAgfCB7IGFjdGlvbjogXCJyZXNldC1lbG9cIjsgdGl0bGU6IHN0cmluZzsgaGludDogc3RyaW5nOyBidXR0b246IHN0cmluZyB9O1xuXG5jb25zdCBTRUNUSU9OUzogeyB0aXRsZTogc3RyaW5nOyByb3dzOiBTZXR0aW5nUm93W10gfVtdID0gW1xuICB7XG4gICAgdGl0bGU6IFwiRUxPXCIsXG4gICAgcm93czogW1xuICAgICAgLy8gVGhlIGhpbnQgaXMgdGhlIHNlbGVjdGVkIG9wdGlvbidzIGRlc2NyaXB0aW9uIChrZXB0IGN1cnJlbnQgYnkgc3luY1NldHRpbmdzQ29udHJvbHMpXG4gICAgICB7IGtleTogXCJzdGFzaFJhdGluZ3NcIiwgdGl0bGU6IFwiU3Rhc2ggcmF0aW5ncyB1cGRhdGUgbW9kZVwiLCBoaW50OiBcIlwiIH0sXG4gICAgICB7XG4gICAgICAgIGFjdGlvbjogXCJyZXNldC1lbG9cIixcbiAgICAgICAgdGl0bGU6IFwiUmVzZXQgRUxPXCIsXG4gICAgICAgIGhpbnQ6IFwiU3RhcnQgZXZlcnkgc2NlbmUncyBFTE8gb3ZlciwgZnJvbSBpdHMgU3Rhc2ggcmF0aW5nIG9yIGF0IDE1MDBcIixcbiAgICAgICAgYnV0dG9uOiBcIlJlc2V0IEVMT+KAplwiLFxuICAgICAgfSxcbiAgICBdLFxuICB9LFxuICB7XG4gICAgdGl0bGU6IFwiQmF0dGxlc1wiLFxuICAgIHJvd3M6IFtcbiAgICAgIHsga2V5OiBcImZpbHRlck9wcG9uZW50c1wiLCB0aXRsZTogXCJVc2UgZmlsdGVyZWQgc2NlbmVzIGZvciBib3RoIHNpZGVzXCIsIGhpbnQ6IFwiT3Bwb25lbnRzIGFsc28gY29tZSBmcm9tIHRoZSBjdXJyZW50IHNjZW5lIGxpc3QgZmlsdGVyIGluc3RlYWQgb2YgeW91ciB3aG9sZSByYXRlZCBsaWJyYXJ5XCIgfSxcbiAgICAgIHsga2V5OiBcInBsYWNlbWVudEZyb21Cb3R0b21cIiwgdGl0bGU6IFwiUGxhY2VtZW50OiBzdGFydCBmcm9tIHRoZSBib3R0b21cIiwgaGludDogXCJQbGFjZW1lbnQgaWdub3JlcyB0aGUgc2NlbmUncyBjdXJyZW50IEVMTzogaXQgc3RhcnRzIGFnYWluc3QgdGhlIGJvdHRvbSBzY2VuZSBhbmQgY2xpbWJzLCBqdW1waW5nIGZ1cnRoZXIgd2l0aCBlYWNoIHdpbiAodGhpcyByZXBsYWNlcyBHYXVudGxldClcIiB9LFxuICAgIF0sXG4gIH0sXG4gIHtcbiAgICB0aXRsZTogXCJTY2VuZXNcIixcbiAgICByb3dzOiBbXG4gICAgICB7IGtleTogXCJhdXRvcGxheVByZXZpZXdzXCIsIHRpdGxlOiBcIkF1dG9wbGF5IHByZXZpZXdzXCIsIGhpbnQ6IFwiTG9vcCBib3RoIHByZXZpZXdzIHNpbGVudGx5OyBob3ZlciBhIGNhcmQgdG8gaGVhciBpdFwiIH0sXG4gICAgICB7IGtleTogXCJwYXVzZU1lZGlhT25PcGVuXCIsIHRpdGxlOiBcIlBhdXNlIHBsYXlpbmcgdmlkZW8gd2hlbiBTdGFzaCBCYXR0bGUgb3BlbnNcIiwgaGludDogXCJTdG9wcyB0aGUgc2NlbmUgeW91J3JlIHdhdGNoaW5nIHNvIGl0cyBhdWRpbyBkb2Vzbid0IG92ZXJsYXAgdGhlIGJhdHRsZSBwcmV2aWV3c1wiIH0sXG4gICAgICB7IGtleTogXCJzaG93VGllcnNcIiwgdGl0bGU6IFwiU2hvdyB0aWVycyBvbiBjYXJkc1wiLCBoaW50OiBcIkEgdGllciBuZXh0IHRvIGVhY2ggc2NlbmUncyBFTE8sIGZyb20g8J+RkSBMZWdlbmRhcnkgKHRvcCAxJSkgZG93biB0byDwn6WJIEJyb256ZSwgYnkgaXRzIHJhbmsgYW1vbmcgeW91ciBzY2VuZXMgd2l0aCBhIHNldHRsZWQgRUxPXCIgfSxcbiAgICAgIHsga2V5OiBcIm9wZW5Jbk5ld1RhYlwiLCB0aXRsZTogXCJPcGVuIHNjZW5lcyBpbiBhIG5ldyB0YWJcIiwgaGludDogXCJDbGlja2luZyBhIHRodW1ibmFpbCBvcGVucyB0aGUgc2NlbmUgaW4gYSBuZXcgYnJvd3NlciB0YWJcIiB9LFxuICAgICAgeyBrZXk6IFwiY2xlYW5Nb2RlXCIsIHRpdGxlOiBcIkNsZWFuIG1vZGVcIiwgaGludDogXCJTaG93IGEg8J+XkSBidXR0b24gb24gZWFjaCBjYXJkIHRvIGRlbGV0ZSB0aGUgc2NlbmUgZnJvbSBTdGFzaFwiIH0sXG4gICAgXSxcbiAgfSxcbl07XG5cbi8qKiBWb2x1bWUgcmVzdG9yZWQgd2hlbiB1bm11dGluZyBmcm9tIDAgd2l0aCBubyBlYXJsaWVyIGxldmVsIHRoaXMgc2Vzc2lvbi4gKi9cbmNvbnN0IERFRkFVTFRfVU5NVVRFX1ZPTFVNRSA9IDUwO1xubGV0IHZvbHVtZUJlZm9yZU11dGU6IG51bWJlciB8IG51bGwgPSBudWxsO1xuXG5sZXQgYWN0aXZlVGFiOiBUYWJJZCA9IFwiYmF0dGxlXCI7XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRBY3RpdmVUYWIoKTogVGFiSWQge1xuICByZXR1cm4gYWN0aXZlVGFiO1xufVxuXG5mdW5jdGlvbiB2b2x1bWVJY29uKHZvbHVtZTogbnVtYmVyKTogc3RyaW5nIHtcbiAgaWYgKHZvbHVtZSA9PT0gMCkgcmV0dXJuIFwi8J+Uh1wiO1xuICByZXR1cm4gdm9sdW1lIDwgNTAgPyBcIvCflIlcIiA6IFwi8J+UilwiO1xufVxuXG5mdW5jdGlvbiBzZXR0aW5nQ29udHJvbChrZXk6IGtleW9mIFNldHRpbmdzKTogc3RyaW5nIHtcbiAgaWYgKGtleSA9PT0gXCJzdGFzaFJhdGluZ3NcIikge1xuICAgIGNvbnN0IG9wdGlvbnMgPSBTVEFTSF9SQVRJTkdTX09QVElPTlMubWFwKFxuICAgICAgKHsgdmFsdWUsIGxhYmVsIH0pID0+XG4gICAgICAgIGA8b3B0aW9uIHZhbHVlPVwiJHt2YWx1ZX1cIiAke3ZhbHVlID09PSBzdGF0ZS5zZXR0aW5ncy5zdGFzaFJhdGluZ3MgPyBcInNlbGVjdGVkXCIgOiBcIlwifT4ke2xhYmVsfTwvb3B0aW9uPmAsXG4gICAgKS5qb2luKFwiXCIpO1xuICAgIHJldHVybiBgPHNlbGVjdCBkYXRhLXNldHRpbmc9XCIke2tleX1cIiBjbGFzcz1cImZvcm0tY29udHJvbCBmb3JtLWNvbnRyb2wtc20gc2Itc2V0dGluZy1zZWxlY3RcIiBhcmlhLWxhYmVsPVwiU3Rhc2ggcmF0aW5ncyB1cGRhdGUgbW9kZVwiPiR7b3B0aW9uc308L3NlbGVjdD5gO1xuICB9XG4gIGNvbnN0IGlkID0gYHNiLXNldHRpbmctJHtrZXl9YDtcbiAgcmV0dXJuIGBcbiAgICAgICAgICA8ZGl2IGNsYXNzPVwiY3VzdG9tLWNvbnRyb2wgY3VzdG9tLXN3aXRjaFwiPlxuICAgICAgICAgICAgPGlucHV0IHR5cGU9XCJjaGVja2JveFwiIGNsYXNzPVwiY3VzdG9tLWNvbnRyb2wtaW5wdXRcIiBpZD1cIiR7aWR9XCIgZGF0YS1zZXR0aW5nPVwiJHtrZXl9XCIgJHtzdGF0ZS5zZXR0aW5nc1trZXkgYXMgQm9vbEtleV0gPyBcImNoZWNrZWRcIiA6IFwiXCJ9PlxuICAgICAgICAgICAgPGxhYmVsIGNsYXNzPVwiY3VzdG9tLWNvbnRyb2wtbGFiZWxcIiBmb3I9XCIke2lkfVwiPjwvbGFiZWw+XG4gICAgICAgICAgPC9kaXY+YDtcbn1cblxuLyoqIFRhYiBiYXI6IEJhdHRsZSAvIFNldHRpbmdzIG9uIHRoZSBsZWZ0LCBwcmV2aWV3IHZvbHVtZSBvbiB0aGUgcmlnaHQuICovXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlVGFiQmFyKCk6IHN0cmluZyB7XG4gIGNvbnN0IHsgcHJldmlld1ZvbHVtZSB9ID0gc3RhdGUuc2V0dGluZ3M7XG4gIHJldHVybiBgXG4gICAgICA8ZGl2IGNsYXNzPVwic2ItdGFiLWJhclwiPlxuICAgICAgICA8bmF2IGNsYXNzPVwibmF2IG5hdi10YWJzIHNiLXRhYnNcIiByb2xlPVwidGFibGlzdFwiPlxuICAgICAgICAgIDxhIGNsYXNzPVwibmF2LWl0ZW0gbmF2LWxpbmsgYWN0aXZlXCIgcm9sZT1cInRhYlwiIGRhdGEtdGFiPVwiYmF0dGxlXCIgYXJpYS1zZWxlY3RlZD1cInRydWVcIj7impTvuI8gQmF0dGxlPC9hPlxuICAgICAgICAgIDxhIGNsYXNzPVwibmF2LWl0ZW0gbmF2LWxpbmtcIiByb2xlPVwidGFiXCIgZGF0YS10YWI9XCJzZXR0aW5nc1wiIGFyaWEtc2VsZWN0ZWQ9XCJmYWxzZVwiPuKamSBTZXR0aW5nczwvYT5cbiAgICAgICAgPC9uYXY+XG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi12b2x1bWVcIiB0aXRsZT1cIlByZXZpZXcgdm9sdW1lXCI+XG4gICAgICAgICAgPGJ1dHRvbiB0eXBlPVwiYnV0dG9uXCIgY2xhc3M9XCJzYi12b2x1bWUtaWNvblwiIGFyaWEtbGFiZWw9XCJNdXRlIHByZXZpZXdzXCI+JHt2b2x1bWVJY29uKHByZXZpZXdWb2x1bWUpfTwvYnV0dG9uPlxuICAgICAgICAgIDxpbnB1dCB0eXBlPVwicmFuZ2VcIiBtaW49XCIwXCIgbWF4PVwiMTAwXCIgc3RlcD1cIjFcIiBkYXRhLXNldHRpbmc9XCJwcmV2aWV3Vm9sdW1lXCIgdmFsdWU9XCIke3ByZXZpZXdWb2x1bWV9XCIgYXJpYS1sYWJlbD1cIlByZXZpZXcgdm9sdW1lXCI+XG4gICAgICAgICAgPHNwYW4gY2xhc3M9XCJzYi12b2x1bWUtdmFsdWVcIj4ke3ByZXZpZXdWb2x1bWV9PC9zcGFuPlxuICAgICAgICA8L2Rpdj5cbiAgICAgIDwvZGl2PlxuICAgIGA7XG59XG5cbmZ1bmN0aW9uIHNldHRpbmdSb3dIdG1sKHJvdzogU2V0dGluZ1Jvdyk6IHN0cmluZyB7XG4gIGNvbnN0IGhpbnQgPSBcImtleVwiIGluIHJvdyAmJiByb3cua2V5ID09PSBcInN0YXNoUmF0aW5nc1wiID8gc3Rhc2hSYXRpbmdzT3B0aW9uKHN0YXRlLnNldHRpbmdzLnN0YXNoUmF0aW5ncykuZGVzYyA6IHJvdy5oaW50O1xuICBjb25zdCBoaW50Rm9yID0gXCJrZXlcIiBpbiByb3cgPyBgIGRhdGEtaGludC1mb3I9XCIke3Jvdy5rZXl9XCJgIDogXCJcIjtcbiAgY29uc3QgY29udHJvbCA9XG4gICAgXCJrZXlcIiBpbiByb3dcbiAgICAgID8gc2V0dGluZ0NvbnRyb2wocm93LmtleSlcbiAgICAgIDogYDxidXR0b24gdHlwZT1cImJ1dHRvblwiIGNsYXNzPVwiYnRuIGJ0bi1zZWNvbmRhcnkgYnRuLXNtXCIgZGF0YS1hY3Rpb249XCIke3Jvdy5hY3Rpb259XCI+JHtyb3cuYnV0dG9ufTwvYnV0dG9uPmA7XG4gIHJldHVybiBgXG4gICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2V0dGluZ1wiPlxuICAgICAgICAgICAgICA8ZGl2PlxuICAgICAgICAgICAgICAgIDxoMz4ke3Jvdy50aXRsZX08L2gzPlxuICAgICAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzdWItaGVhZGluZ1wiJHtoaW50Rm9yfT4ke2hpbnR9PC9kaXY+XG4gICAgICAgICAgICAgIDwvZGl2PlxuICAgICAgICAgICAgICA8ZGl2PiR7Y29udHJvbH08L2Rpdj5cbiAgICAgICAgICAgIDwvZGl2PmA7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVTZXR0aW5nc1RhYigpOiBzdHJpbmcge1xuICBjb25zdCBzZWN0aW9ucyA9IFNFQ1RJT05TLm1hcChcbiAgICAoeyB0aXRsZSwgcm93cyB9KSA9PiBgXG4gICAgICAgIDxkaXYgY2xhc3M9XCJzZXR0aW5nLXNlY3Rpb25cIj5cbiAgICAgICAgICA8aDE+JHt0aXRsZX08L2gxPlxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJjYXJkXCI+XG4gICAgICAgICAgICAke3Jvd3MubWFwKHNldHRpbmdSb3dIdG1sKS5qb2luKFwiXCIpfVxuICAgICAgICAgIDwvZGl2PlxuICAgICAgICA8L2Rpdj5gLFxuICApLmpvaW4oXCJcIik7XG5cbiAgcmV0dXJuIGBcbiAgICAgIDxkaXYgY2xhc3M9XCJzYi10YWItcGFuZWwgc2Itc2V0dGluZ3MtdGFiXCIgZGF0YS1wYW5lbD1cInNldHRpbmdzXCIgaGlkZGVuPlxuICAgICAgICAke3NlY3Rpb25zfVxuICAgICAgICA8cCBjbGFzcz1cInNiLXNldHRpbmdzLW5vdGVcIj5TYXZlcyB0byBTdGFzaCwgYWxzbyB1bmRlciBTZXR0aW5ncyDihpIgUGx1Z2lucy48L3A+XG4gICAgICA8L2Rpdj5cbiAgICBgO1xufVxuXG4vKiogUHVzaCBzdGF0ZS5zZXR0aW5ncyBpbnRvIHRoZSByZW5kZXJlZCBjb250cm9scyAoZS5nLiBhZnRlciByZS1mZXRjaGluZyBzZXR0aW5ncyBvbiByZW9wZW4pLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN5bmNTZXR0aW5nc0NvbnRyb2xzKHJvb3Q6IFBhcmVudE5vZGUpOiB2b2lkIHtcbiAgcm9vdC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxJbnB1dEVsZW1lbnQ+KFwiaW5wdXRbZGF0YS1zZXR0aW5nXVwiKS5mb3JFYWNoKChpbnB1dCkgPT4ge1xuICAgIGNvbnN0IGtleSA9IGlucHV0LmRhdGFzZXQuc2V0dGluZyBhcyBrZXlvZiBTZXR0aW5ncztcbiAgICBjb25zdCB2YWx1ZSA9IHN0YXRlLnNldHRpbmdzW2tleV07XG4gICAgaWYgKGlucHV0LnR5cGUgPT09IFwiY2hlY2tib3hcIikgaW5wdXQuY2hlY2tlZCA9IEJvb2xlYW4odmFsdWUpO1xuICAgIGVsc2UgaW5wdXQudmFsdWUgPSBTdHJpbmcodmFsdWUpO1xuICB9KTtcbiAgcm9vdC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxTZWxlY3RFbGVtZW50PihcInNlbGVjdFtkYXRhLXNldHRpbmddXCIpLmZvckVhY2goKHNlbGVjdCkgPT4ge1xuICAgIHNlbGVjdC52YWx1ZSA9IFN0cmluZyhzdGF0ZS5zZXR0aW5nc1tzZWxlY3QuZGF0YXNldC5zZXR0aW5nIGFzIGtleW9mIFNldHRpbmdzXSk7XG4gIH0pO1xuICByb290LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KCdbZGF0YS1oaW50LWZvcj1cInN0YXNoUmF0aW5nc1wiXScpLmZvckVhY2goKGhpbnQpID0+IHtcbiAgICBoaW50LnRleHRDb250ZW50ID0gc3Rhc2hSYXRpbmdzT3B0aW9uKHN0YXRlLnNldHRpbmdzLnN0YXNoUmF0aW5ncykuZGVzYztcbiAgfSk7XG4gIGNvbnN0IHZvbHVtZSA9IHN0YXRlLnNldHRpbmdzLnByZXZpZXdWb2x1bWU7XG4gIHJvb3QucXVlcnlTZWxlY3RvckFsbChcIi5zYi12b2x1bWUtaWNvblwiKS5mb3JFYWNoKChlbCkgPT4ge1xuICAgIGVsLnRleHRDb250ZW50ID0gdm9sdW1lSWNvbih2b2x1bWUpO1xuICAgIGVsLnNldEF0dHJpYnV0ZShcImFyaWEtbGFiZWxcIiwgdm9sdW1lID09PSAwID8gXCJVbm11dGUgcHJldmlld3NcIiA6IFwiTXV0ZSBwcmV2aWV3c1wiKTtcbiAgfSk7XG4gIHJvb3QucXVlcnlTZWxlY3RvckFsbChcIi5zYi12b2x1bWUtdmFsdWVcIikuZm9yRWFjaCgoZWwpID0+IChlbC50ZXh0Q29udGVudCA9IFN0cmluZyh2b2x1bWUpKSk7XG59XG5cbi8qKiBTaG93IGEgdGFiLiBQYW5lbHMgYXJlIHN3YXBwZWQgaW4gcGxhY2UsIHNvIG5vdGhpbmcgYWJvdmUgdGhlIHRhYiBiYXIgbW92ZXMuICovXG5leHBvcnQgZnVuY3Rpb24gc2hvd1RhYihyb290OiBQYXJlbnROb2RlLCB0YWI6IFRhYklkKTogdm9pZCB7XG4gIGFjdGl2ZVRhYiA9IHRhYjtcbiAgcm9vdC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PihcIi5zYi10YWJzIC5uYXYtbGlua1wiKS5mb3JFYWNoKChsaW5rKSA9PiB7XG4gICAgY29uc3Qgb24gPSBsaW5rLmRhdGFzZXQudGFiID09PSB0YWI7XG4gICAgbGluay5jbGFzc0xpc3QudG9nZ2xlKFwiYWN0aXZlXCIsIG9uKTtcbiAgICBsaW5rLnNldEF0dHJpYnV0ZShcImFyaWEtc2VsZWN0ZWRcIiwgU3RyaW5nKG9uKSk7XG4gIH0pO1xuICByb290LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KFwiLnNiLXRhYi1wYW5lbFwiKS5mb3JFYWNoKChwYW5lbCkgPT4ge1xuICAgIHBhbmVsLmhpZGRlbiA9IHBhbmVsLmRhdGFzZXQucGFuZWwgIT09IHRhYjtcbiAgfSk7XG59XG5cbi8qKlxuICogV2lyZSBldmVyeSBkYXRhLXNldHRpbmcgY29udHJvbCwgdGhlIHRhYnMgYW5kIHRoZSBtdXRlIGJ1dHRvbi5cbiAqIG9uQ2hhbmdlIHJ1bnMgYWZ0ZXIgYSB2YWx1ZSBpcyBzdG9yZWQ7IG9uVGFiQ2hhbmdlIGFmdGVyIGEgdGFiIHN3aXRjaC4gQSBkcm9wZG93biBjaGFuZ2VcbiAqIGZpcnN0IGF3YWl0cyBiZWZvcmVDaGFuZ2UgKGEgd2FybmluZywgc2F5KTogZmFsc2UgcHV0cyB0aGUgZHJvcGRvd24gYmFjayBhbmQgc3RvcmVzIG5vdGhpbmcuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBiaW5kU2V0dGluZ3NDb250cm9scyhcbiAgcm9vdDogUGFyZW50Tm9kZSxcbiAgb25DaGFuZ2U6IChrZXk6IGtleW9mIFNldHRpbmdzKSA9PiB2b2lkLFxuICBvblRhYkNoYW5nZTogKHRhYjogVGFiSWQpID0+IHZvaWQsXG4gIGJlZm9yZUNoYW5nZTogKGtleToga2V5b2YgU2V0dGluZ3MsIHZhbHVlOiBzdHJpbmcpID0+IFByb21pc2U8Ym9vbGVhbj4gPSBhc3luYyAoKSA9PiB0cnVlLFxuKTogdm9pZCB7XG4gIGNvbnN0IGFwcGx5ID0gKHBhdGNoOiBQYXJ0aWFsPFNldHRpbmdzPiwga2V5OiBrZXlvZiBTZXR0aW5ncyk6IHZvaWQgPT4ge1xuICAgIHVwZGF0ZVNldHRpbmdzKHBhdGNoKTtcbiAgICBzeW5jU2V0dGluZ3NDb250cm9scyhyb290KTtcbiAgICBvbkNoYW5nZShrZXkpO1xuICB9O1xuXG4gIHJvb3QucXVlcnlTZWxlY3RvckFsbDxIVE1MSW5wdXRFbGVtZW50PihcImlucHV0W2RhdGEtc2V0dGluZ11cIikuZm9yRWFjaCgoaW5wdXQpID0+IHtcbiAgICBjb25zdCBrZXkgPSBpbnB1dC5kYXRhc2V0LnNldHRpbmcgYXMga2V5b2YgU2V0dGluZ3M7XG4gICAgLy8gUmFuZ2UgdXBkYXRlcyBsaXZlIHdoaWxlIGRyYWdnaW5nOyBvdGhlcnMgb24gY29tbWl0XG4gICAgY29uc3QgZXZlbnROYW1lID0gaW5wdXQudHlwZSA9PT0gXCJyYW5nZVwiID8gXCJpbnB1dFwiIDogXCJjaGFuZ2VcIjtcbiAgICBpbnB1dC5hZGRFdmVudExpc3RlbmVyKGV2ZW50TmFtZSwgKCkgPT4ge1xuICAgICAgY29uc3QgdmFsdWUgPSBpbnB1dC50eXBlID09PSBcImNoZWNrYm94XCIgPyBpbnB1dC5jaGVja2VkIDogTnVtYmVyKGlucHV0LnZhbHVlKTtcbiAgICAgIGFwcGx5KHsgW2tleV06IHZhbHVlIH0gYXMgUGFydGlhbDxTZXR0aW5ncz4sIGtleSk7XG4gICAgfSk7XG4gIH0pO1xuXG4gIHJvb3QucXVlcnlTZWxlY3RvckFsbDxIVE1MU2VsZWN0RWxlbWVudD4oXCJzZWxlY3RbZGF0YS1zZXR0aW5nXVwiKS5mb3JFYWNoKChzZWxlY3QpID0+IHtcbiAgICBjb25zdCBrZXkgPSBzZWxlY3QuZGF0YXNldC5zZXR0aW5nIGFzIGtleW9mIFNldHRpbmdzO1xuICAgIHNlbGVjdC5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsIGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHZhbHVlID0gc2VsZWN0LnZhbHVlO1xuICAgICAgc2VsZWN0LmRpc2FibGVkID0gdHJ1ZTtcbiAgICAgIHRyeSB7XG4gICAgICAgIGlmIChhd2FpdCBiZWZvcmVDaGFuZ2Uoa2V5LCB2YWx1ZSkpIGFwcGx5KHsgW2tleV06IHZhbHVlIGFzIFN0YXNoUmF0aW5nc01vZGUgfSBhcyBQYXJ0aWFsPFNldHRpbmdzPiwga2V5KTtcbiAgICAgICAgZWxzZSBzeW5jU2V0dGluZ3NDb250cm9scyhyb290KTtcbiAgICAgIH0gZmluYWxseSB7XG4gICAgICAgIHNlbGVjdC5kaXNhYmxlZCA9IGZhbHNlO1xuICAgICAgfVxuICAgIH0pO1xuICB9KTtcblxuICAvLyBTcGVha2VyIGljb246IG11dGUsIG9yIHJlc3RvcmUgdGhlIGxldmVsIGZyb20gYmVmb3JlIG11dGluZ1xuICByb290LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiLnNiLXZvbHVtZS1pY29uXCIpLmZvckVhY2goKGJ0bikgPT4ge1xuICAgIGJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4ge1xuICAgICAgY29uc3QgY3VycmVudCA9IHN0YXRlLnNldHRpbmdzLnByZXZpZXdWb2x1bWU7XG4gICAgICBpZiAoY3VycmVudCA+IDApIHtcbiAgICAgICAgdm9sdW1lQmVmb3JlTXV0ZSA9IGN1cnJlbnQ7XG4gICAgICAgIGFwcGx5KHsgcHJldmlld1ZvbHVtZTogMCB9LCBcInByZXZpZXdWb2x1bWVcIik7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBhcHBseSh7IHByZXZpZXdWb2x1bWU6IHZvbHVtZUJlZm9yZU11dGUgPz8gREVGQVVMVF9VTk1VVEVfVk9MVU1FIH0sIFwicHJldmlld1ZvbHVtZVwiKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfSk7XG5cbiAgcm9vdC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PihcIi5zYi10YWJzIC5uYXYtbGlua1wiKS5mb3JFYWNoKChsaW5rKSA9PiB7XG4gICAgbGluay5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4ge1xuICAgICAgY29uc3QgdGFiID0gbGluay5kYXRhc2V0LnRhYiBhcyBUYWJJZDtcbiAgICAgIGlmICh0YWIgPT09IGFjdGl2ZVRhYikgcmV0dXJuO1xuICAgICAgc2hvd1RhYihyb290LCB0YWIpO1xuICAgICAgb25UYWJDaGFuZ2UodGFiKTtcbiAgICB9KTtcbiAgfSk7XG59XG4iLCAiLy8gQ29yZSBjb21wYXJpc29uIFVJOiBsYXlvdXQsIHBhaXIgcmVuZGVyaW5nLCBjaG9pY2UgaGFuZGxpbmcsIGFuaW1hdGlvbnMuXG5cbmltcG9ydCB7IGNsZWFyRmlsdGVyZWRDYWNoZSwgbGF0ZXN0U2NlbmUsIHJlZnJlc2hTY2VuZUluQ2FjaGUsIHJlbW92ZVNjZW5lRXZlcnl3aGVyZSB9IGZyb20gXCIuLi9jYWNoZVwiO1xuaW1wb3J0IHsgQ0hBTVBJT05fVU5SQVRFRF9FTE8sIENMSU1CX1NNQUxMX1BPT0xfV0FSTl9BVCwgVVBTRVRfTUFYX0NIQU5DRSB9IGZyb20gXCIuLi9jb25zdGFudHNcIjtcbmltcG9ydCB7IGVsb1Jlc3VsdCwgd2luQ2hhbmNlcyB9IGZyb20gXCIuLi9lbG9cIjtcbmltcG9ydCB7IHJlYWRGaWx0ZXJzIH0gZnJvbSBcIi4uL2ZpbHRlcnNcIjtcbmltcG9ydCB7IGZldGNoU2NlbmVCeUlkIH0gZnJvbSBcIi4uL2dyYXBocWxcIjtcbmltcG9ydCB7IG5hdmlnYXRlVG9VcmwgfSBmcm9tIFwiLi4vbmF2aWdhdGlvblwiO1xuaW1wb3J0IHtcbiAgZmV0Y2hDaGFtcGlvblBhaXIsXG4gIGZldGNoUGxhY2VtZW50UGFpcixcbiAgZmV0Y2hTd2lzc1BhaXIsXG4gIHBhaXJSYW5rcyxcbn0gZnJvbSBcIi4uL3BhaXJzXCI7XG5pbXBvcnQgeyByZWNvcmRQbGFjZW1lbnRSZXN1bHQgfSBmcm9tIFwiLi4vcGxhY2VtZW50XCI7XG5pbXBvcnQgeyB3cml0ZUVsbyB9IGZyb20gXCIuLi9yYXRpbmdcIjtcbmltcG9ydCB7IGZldGNoU2NlbmVGaWVsZHMgfSBmcm9tIFwiLi4vc2NlbmVBY3Rpb25zXCI7XG5pbXBvcnQgeyBiYXR0bGVzLCBlZmZlY3RpdmVFbG8sIGtHYW1lcyB9IGZyb20gXCIuLi9zY29yZVwiO1xuaW1wb3J0IHsgaXNFbG9TZXR1cFBlbmRpbmcsIGlzUnVuQWN0aXZlLCByZXNldFJ1blN0YXRlLCByZXNldFNodWZmbGUsIHN0YXRlIH0gZnJvbSBcIi4uL3N0YXRlXCI7XG5pbXBvcnQgeyB0aWVyTWFwIH0gZnJvbSBcIi4uL3N0YXRzXCI7XG5pbXBvcnQgeyBzYXZlU3RhdGUgfSBmcm9tIFwiLi4vc3RvcmFnZVwiO1xuaW1wb3J0IHR5cGUgeyBNb2RlLCBSYW5rLCBTY2VuZSwgVGllciB9IGZyb20gXCIuLi90eXBlc1wiO1xuaW1wb3J0IHsgY29uZmlybURlbGV0ZVNjZW5lIH0gZnJvbSBcIi4vZGVsZXRlRGlhbG9nXCI7XG5pbXBvcnQgeyBjcmVhdGVTY2VuZUNhcmQgfSBmcm9tIFwiLi9zY2VuZUNhcmRcIjtcbmltcG9ydCB7IHNob3dQbGFjZW1lbnRTY3JlZW4sIHNob3dWaWN0b3J5U2NyZWVuIH0gZnJvbSBcIi4vc2NyZWVuc1wiO1xuaW1wb3J0IHsgY3JlYXRlU2V0dGluZ3NUYWIsIGNyZWF0ZVRhYkJhciwgZ2V0QWN0aXZlVGFiIH0gZnJvbSBcIi4vc2V0dGluZ3NQYW5lbFwiO1xuXG5jb25zdCBNT0RFUzogeyBtb2RlOiBNb2RlOyBpY29uOiBzdHJpbmc7IHRpdGxlOiBzdHJpbmc7IGRlc2M6IHN0cmluZzsgdGlwOiBzdHJpbmcgfVtdID0gW1xuICB7XG4gICAgbW9kZTogXCJzd2lzc1wiLFxuICAgIGljb246IFwi4pqW77iPXCIsXG4gICAgdGl0bGU6IFwiU3dpc3NcIixcbiAgICBkZXNjOiBcIkZhaXIgbWF0Y2h1cHNcIixcbiAgICB0aXA6IFwiRWFjaCBzY2VuZSBmYWNlcyBhbiBvcHBvbmVudCB3aXRoIGEgc2ltaWxhciBFTE8uIEJvdGggc2NlbmVzJyBFTE8gY2hhbmdlcyBhZnRlciBldmVyeSBwaWNrLCBhbmQgZXZlcnkgc2NlbmUgc3RheXMgaW4gdGhlIHJvdGF0aW9uLlwiLFxuICB9LFxuICB7XG4gICAgbW9kZTogXCJwbGFjZW1lbnRcIixcbiAgICBpY29uOiBcIvCfk41cIixcbiAgICB0aXRsZTogXCJQbGFjZW1lbnRcIixcbiAgICBkZXNjOiBcIlBsYWNlIGEgc2NlbmVcIixcbiAgICB0aXA6IFwiRmluZHMgd2hlcmUgb25lIHNjZW5lIGJlbG9uZ3MuIEVhY2ggcGljayBuYXJyb3dzIHRoZSByYW5nZSBvZiByYW5rcyBpdCBjb3VsZCBsYW5kIGluIChzaG93biBvbiBpdHMgY2FyZCkgdW50aWwgaXRzIHNwb3QgaXMgZm91bmQsIGFib3V0IDEwIHBpY2tzIGZvciBhbiB1bnJhdGVkIHNjZW5lLlxcblxcbkxvb2tpbmcgZm9yIEdhdW50bGV0PyBUdXJuIG9uIOKAnFBsYWNlbWVudDogc3RhcnQgZnJvbSB0aGUgYm90dG9t4oCdIGluIFNldHRpbmdzIHRvIG1ha2UgYSBzY2VuZSBjbGltYiB0aGUgbGFkZGVyIGZyb20gdGhlIGJvdHRvbS5cIixcbiAgfSxcbiAge1xuICAgIG1vZGU6IFwiY2hhbXBpb25cIixcbiAgICBpY29uOiBcIvCfj4ZcIixcbiAgICB0aXRsZTogXCJDaGFtcGlvblwiLFxuICAgIGRlc2M6IFwiV2lubmVyIHN0YXlzIG9uXCIsXG4gICAgdGlwOiBcIldpbm5lciBzdGF5cyBvbjogdGhlIHNjZW5lIHlvdSBwaWNrIGtlZXBzIGRlZmVuZGluZyBhZ2FpbnN0IG5ldyBjaGFsbGVuZ2VycyB1bnRpbCBpdCdzIGJlYXRlbiwgdGhlbiB0aGUgd2lubmVyIHRha2VzIG92ZXIuIEJvdGggc2NlbmVzJyBFTE8gY2hhbmdlcyBhZnRlciBldmVyeSBwaWNrLlwiLFxuICB9LFxuXTtcblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZU1haW5VSSgpOiBzdHJpbmcge1xuICBjb25zdCBtb2RlQnV0dG9ucyA9IE1PREVTLm1hcChcbiAgICAoeyBtb2RlLCBpY29uLCB0aXRsZSwgZGVzYywgdGlwIH0pID0+IGBcbiAgICAgICAgICAgIDxidXR0b24gY2xhc3M9XCJzYi1tb2RlLWJ0biAke3N0YXRlLmN1cnJlbnRNb2RlID09PSBtb2RlID8gXCJhY3RpdmVcIiA6IFwiXCJ9XCIgZGF0YS1tb2RlPVwiJHttb2RlfVwiIGRhdGEtdGlwPVwiJHt0aXB9XCIgYXJpYS1kZXNjcmlwdGlvbj1cIiR7dGlwfVwiPlxuICAgICAgICAgICAgICA8c3BhbiBjbGFzcz1cInNiLW1vZGUtaWNvblwiPiR7aWNvbn08L3NwYW4+XG4gICAgICAgICAgICAgIDxzcGFuIGNsYXNzPVwic2ItbW9kZS10aXRsZVwiPiR7dGl0bGV9PC9zcGFuPlxuICAgICAgICAgICAgICA8c3BhbiBjbGFzcz1cInNiLW1vZGUtZGVzY1wiPiR7ZGVzY308L3NwYW4+XG4gICAgICAgICAgICA8L2J1dHRvbj5gLFxuICApLmpvaW4oXCJcIik7XG5cbiAgcmV0dXJuIGBcbiAgICAgIDxkaXYgaWQ9XCJzdGFzaC1iYXR0bGUtY29udGFpbmVyXCIgY2xhc3M9XCJzYi1jb250YWluZXJcIj5cbiAgICAgICAgPGRpdiBjbGFzcz1cInNiLWhlYWRlclwiPlxuICAgICAgICAgIDxoMSBjbGFzcz1cInNiLXRpdGxlXCI+4pqU77iPIFN0YXNoIEJhdHRsZTwvaDE+XG4gICAgICAgICAgJHtjcmVhdGVUYWJCYXIoKX1cbiAgICAgICAgPC9kaXY+XG5cbiAgICAgICAgPGRpdiBjbGFzcz1cInNiLXRhYi1wYW5lbFwiIGRhdGEtcGFuZWw9XCJiYXR0bGVcIj5cbiAgICAgICAgICA8ZGl2IGlkPVwic2Itc2V0dXAtYXJlYVwiIGNsYXNzPVwic2Itc2V0dXAtYXJlYVwiIGhpZGRlbj48L2Rpdj5cbiAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItbW9kZS1yb3dcIj5cbiAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1tb2RlLXRvZ2dsZVwiPiR7bW9kZUJ1dHRvbnN9XG4gICAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgICAgIDxidXR0b24gdHlwZT1cImJ1dHRvblwiIGNsYXNzPVwic2ItbW9kZS1pbmZvLWJ0blwiIGFyaWEtY29udHJvbHM9XCJzYi1tb2RlLWluZm9cIiBhcmlhLWV4cGFuZGVkPVwiZmFsc2VcIiBhcmlhLWxhYmVsPVwiV2hhdCBkb2VzIHRoaXMgbW9kZSBkbz9cIj7ik5g8L2J1dHRvbj5cbiAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgICA8cCBpZD1cInNiLW1vZGUtaW5mb1wiIGNsYXNzPVwic2ItbW9kZS1pbmZvXCIgaGlkZGVuPjwvcD5cblxuICAgICAgICAgIDxwIGlkPVwic2ItY2xpbWItcG9vbC13YXJuaW5nXCIgY2xhc3M9XCJzYi1jbGltYi13YXJuaW5nXCIgaGlkZGVuPlxuICAgICAgICAgICAgQ2hhbXBpb24gY2FuIGJlaGF2ZSBvZGRseSB3aXRoIHNtYWxsIGZpbHRlcmVkIHBvb2xzIHdoZW4gYm90aCBzaWRlcyB1c2UgdGhlIGZpbHRlclxuICAgICAgICAgICAgKGZld2VyIHRoYW4gJHtDTElNQl9TTUFMTF9QT09MX1dBUk5fQVR9IHNjZW5lcykuIFVzZSBhIGxhcmdlciBmaWx0ZXIsIG9yIHR1cm4gb2ZmXG4gICAgICAgICAgICBcIlVzZSBmaWx0ZXJlZCBzY2VuZXMgZm9yIGJvdGggc2lkZXNcIiBpbiBTZXR0aW5ncy5cbiAgICAgICAgICA8L3A+XG5cbiAgICAgICAgICA8cCBpZD1cInNiLXBvb2wtc3RhdHVzXCIgY2xhc3M9XCJzYi1wb29sLXN0YXR1c1wiIGhpZGRlbj48L3A+XG4gICAgICAgICAgPHAgaWQ9XCJzYi1yYXRpbmdzLW5vdGVcIiBjbGFzcz1cInNiLXBvb2wtc3RhdHVzIHNiLXJhdGluZ3Mtbm90ZVwiIGhpZGRlbj5cbiAgICAgICAgICAgIFN0YXNoIHJhdGluZ3MgYXJlbid0IGJlaW5nIGNoYW5nZWQgwrcgPGEgaHJlZj1cIiNcIiBkYXRhLWFjdGlvbj1cIm9wZW4tc2V0dGluZ3NcIj5jaGFuZ2UgaW4gU2V0dGluZ3M8L2E+XG4gICAgICAgICAgPC9wPlxuXG4gICAgICAgICAgPGRpdiBjbGFzcz1cInNiLWNvbnRlbnRcIj5cbiAgICAgICAgICAgIDxkaXYgaWQ9XCJzYi1jb21wYXJpc29uLWFyZWFcIiBjbGFzcz1cInNiLWNvbXBhcmlzb24tYXJlYVwiPlxuICAgICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItbG9hZGluZ1wiPkxvYWRpbmcgc2NlbmVzLi4uPC9kaXY+XG4gICAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1hY3Rpb25zXCI+XG4gICAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1hY3Rpb24tYnV0dG9uc1wiPlxuICAgICAgICAgICAgICAgIDxidXR0b24gaWQ9XCJzYi1za2lwLWJ0blwiIGNsYXNzPVwiYnRuIGJ0bi1zZWNvbmRhcnlcIj5Ta2lwPC9idXR0b24+XG4gICAgICAgICAgICAgICAgPGJ1dHRvbiBpZD1cInNiLXJlZnJlc2gtY2FjaGUtYnRuXCIgY2xhc3M9XCJidG4gYnRuLXNlY29uZGFyeVwiIHRpdGxlPVwiUmVmcmVzaCBzY2VuZSBsaXN0IGZyb20gc2VydmVyICh1c2UgaWYgeW91J3ZlIGFkZGVkIG5ldyBzY2VuZXMpXCI+8J+UhCBSZWZyZXNoPC9idXR0b24+XG4gICAgICAgICAgICAgIDwvZGl2PlxuICAgICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2Ita2V5Ym9hcmQtaGludFwiPlxuICAgICAgICAgICAgICAgIDxzcGFuPuKGkDwvc3Bhbj4gY2hvb3NlIGxlZnQgwrdcbiAgICAgICAgICAgICAgICA8c3Bhbj7ihpI8L3NwYW4+IGNob29zZSByaWdodCDCt1xuICAgICAgICAgICAgICAgIDxzcGFuPlNwYWNlPC9zcGFuPiBza2lwXG4gICAgICAgICAgICAgIDwvZGl2PlxuICAgICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgPC9kaXY+XG4gICAgICAgIDwvZGl2PlxuXG4gICAgICAgICR7Y3JlYXRlU2V0dGluZ3NUYWIoKX1cbiAgICAgIDwvZGl2PlxuICAgIGA7XG59XG5cbi8qKiBUb3VjaCBzY3JlZW5zIGhhdmUgbm8gaG92ZXIgdG9vbHRpcHM6IHRoZSDik5ggYnV0dG9uIHNob3dzIHRoZSBjdXJyZW50IG1vZGUncyBleHBsYW5hdGlvbiBoZXJlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHVwZGF0ZU1vZGVJbmZvKCk6IHZvaWQge1xuICBjb25zdCBpbmZvID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzYi1tb2RlLWluZm9cIik7XG4gIGNvbnN0IG1vZGUgPSBNT0RFUy5maW5kKChtKSA9PiBtLm1vZGUgPT09IHN0YXRlLmN1cnJlbnRNb2RlKTtcbiAgaWYgKGluZm8gJiYgbW9kZSkgaW5mby5pbm5lckhUTUwgPSBgPHN0cm9uZz4ke21vZGUuaWNvbn0gJHttb2RlLnRpdGxlfTo8L3N0cm9uZz4gJHttb2RlLnRpcC5yZXBsYWNlKC9cXG4vZywgXCI8YnI+XCIpfWA7XG59XG5cbi8qKiBCYXR0bGUgdGFiIG5vdGUgd2hpbGUgdGhlIFwiU3Rhc2ggcmF0aW5nc1wiIHNldHRpbmcgaXMgXCJEb24ndCB1cGRhdGVcIi4gKi9cbmV4cG9ydCBmdW5jdGlvbiB1cGRhdGVSYXRpbmdzTm90ZSgpOiB2b2lkIHtcbiAgY29uc3Qgbm90ZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic2ItcmF0aW5ncy1ub3RlXCIpO1xuICBpZiAobm90ZSkgbm90ZS5oaWRkZW4gPSBzdGF0ZS5zZXR0aW5ncy5zdGFzaFJhdGluZ3MgIT09IFwib2ZmXCI7XG59XG5cbi8qKiBcIldoaWNoIHNjZW5lcyBhbSBJIHJhdGluZz9cIiBsaW5lIGFib3ZlIHRoZSBjYXJkczogdGhlIFNjZW5lcyBwYWdlIGZpbHRlciBvciB0aGUgd2hvbGUgbGlicmFyeS4gKi9cbmV4cG9ydCBmdW5jdGlvbiB1cGRhdGVQb29sU3RhdHVzKCk6IHZvaWQge1xuICBjb25zdCBzdGF0dXMgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInNiLXBvb2wtc3RhdHVzXCIpO1xuICBpZiAoIXN0YXR1cykgcmV0dXJuO1xuICBjb25zdCBjb3VudCA9IHN0YXRlLmxlZnRQb29sU2l6ZTtcbiAgY29uc3QgY291bnRIdG1sID1cbiAgICBjb3VudCA9PT0gbnVsbCA/IFwiXCIgOiBgIMK3IDxzdHJvbmc+JHtjb3VudH0gc2NlbmUke2NvdW50ID09PSAxID8gXCJcIiA6IFwic1wifTwvc3Ryb25nPmA7XG5cbiAgaWYgKHJlYWRGaWx0ZXJzKCkuZmlsdGVyQWN0aXZlKSB7XG4gICAgY29uc3Qgb3Bwb25lbnRzID0gc3RhdGUuc2V0dGluZ3MuZmlsdGVyT3Bwb25lbnRzID8gXCIgwrcgb3Bwb25lbnRzIGZyb20gdGhlIGZpbHRlciB0b29cIiA6IFwiXCI7XG4gICAgc3RhdHVzLmlubmVySFRNTCA9IGBSYXRpbmcgc2NlbmVzIGZyb20geW91ciBTY2VuZXMgcGFnZSBmaWx0ZXIke2NvdW50SHRtbH0ke29wcG9uZW50c31gO1xuICB9IGVsc2Uge1xuICAgIHN0YXR1cy5pbm5lckhUTUwgPSBgUmF0aW5nIHNjZW5lcyBmcm9tIHlvdXIgd2hvbGUgbGlicmFyeSR7Y291bnRIdG1sfTxzcGFuIGNsYXNzPVwic2ItcG9vbC1oaW50XCI+IMK3IGZpbHRlciB0aGUgU2NlbmVzIHBhZ2UgdG8gbmFycm93IGl0IGRvd248L3NwYW4+YDtcbiAgfVxuICBzdGF0dXMuaGlkZGVuID0gZmFsc2U7XG59XG5cbi8qKiBDYXJkIGJhZGdlOiB0aGUgd2luIHN0cmVhayB3aGlsZSBjbGltYmluZyBvciBkZWZlbmRpbmcsIG9yIFBsYWNlbWVudCdzIG5hcnJvd2luZyByYW5nZS4gKi9cbmZ1bmN0aW9uIGNsaW1iU3RhdHVzQmFkZ2Uoc2NlbmU6IFNjZW5lKTogbnVtYmVyIHwgc3RyaW5nIHwgbnVsbCB7XG4gIGlmIChzdGF0ZS5jdXJyZW50TW9kZSA9PT0gXCJwbGFjZW1lbnRcIikge1xuICAgIGNvbnN0IHJ1biA9IHN0YXRlLnBsYWNlbWVudDtcbiAgICBpZiAocnVuPy5zY2VuZS5pZCAhPT0gc2NlbmUuaWQpIHJldHVybiBudWxsO1xuICAgIC8vIFwiU3RhcnQgZnJvbSB0aGUgYm90dG9tXCIgcnVucyBzaG93IHRoZSBzdHJlYWsgdW50aWwgdGhlIGZpcnN0IGxvc3NcbiAgICBpZiAocnVuLmZyb21Cb3R0b20gJiYgcnVuLmJhdHRsZXMgPiAwICYmIHJ1bi5zdHJlYWsgPT09IHJ1bi5iYXR0bGVzKSByZXR1cm4gcnVuLnN0cmVhaztcbiAgICBpZiAocnVuLnJhbmdlSGkgPT09IHJ1bi5yYW5nZUxvKSByZXR1cm4gbnVsbDtcbiAgICByZXR1cm4gYPCfk40gTmFycm93aW5nIGJldHdlZW4gIyR7cnVuLnJhbmdlTG8gKyAxfSBhbmQgIyR7cnVuLnJhbmdlSGkgKyAxfWA7XG4gIH1cbiAgaWYgKHN0YXRlLmN1cnJlbnRNb2RlID09PSBcImNoYW1waW9uXCIgJiYgc3RhdGUuY2hhbXBpb25TY2VuZT8uaWQgPT09IHNjZW5lLmlkKSB7XG4gICAgcmV0dXJuIHN0YXRlLmNoYW1waW9uV2lucztcbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqIFByZWNvbXB1dGVkIHdpbm5lci9sb3NlciBjb250ZXh0IHdpcmVkIGF0IHJlbmRlciB0aW1lIGZvciBlYWNoIGNob29zZSBidXR0b24uICovXG5pbnRlcmZhY2UgU2NlbmVDaG9pY2Uge1xuICB3aW5uZXI6IFNjZW5lO1xuICBsb3NlcjogU2NlbmU7XG4gIGxlZnQ6IFNjZW5lO1xuICByaWdodDogU2NlbmU7XG4gIHdpbm5lckNhcmQ6IEhUTUxFbGVtZW50O1xuICBsb3NlckNhcmQ6IEhUTUxFbGVtZW50O1xuICB3aW5uZXJSYW5rOiBSYW5rO1xuICBsb3NlclJhbms6IFJhbms7XG59XG5cbmZ1bmN0aW9uIGJpbmRTY2VuZUNob2ljZShib2R5OiBIVE1MRWxlbWVudCwgY2hvaWNlOiBTY2VuZUNob2ljZSk6IHZvaWQge1xuICBib2R5LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiBoYW5kbGVTY2VuZUNob2ljZShjaG9pY2UpKTtcbn1cblxuLyoqIFNob3cgb3IgaGlkZSB0aGUgU2tpcCAvIFJlZnJlc2ggYmFyLiBPbmx5IGVuZCBzY3JlZW5zIGhpZGUgaXQ7IGV2ZXJ5IHJlbmRlcmVkIHBhaXIgc2hvd3MgaXQuICovXG5leHBvcnQgZnVuY3Rpb24gc2V0QWN0aW9uc1Zpc2libGUodmlzaWJsZTogYm9vbGVhbik6IHZvaWQge1xuICBjb25zdCBhY3Rpb25zRWwgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIi5zYi1hY3Rpb25zXCIpO1xuICBpZiAoYWN0aW9uc0VsKSBhY3Rpb25zRWwuc3R5bGUuZGlzcGxheSA9IHZpc2libGUgPyBcIlwiIDogXCJub25lXCI7XG59XG5cbi8qKiBUb3VjaCBkZXZpY2VzIGhhdmUgbm8gaG92ZXI6IHRodW1ibmFpbHMgdG9nZ2xlIHRoZSBwcmV2aWV3IGluc3RlYWQgb2Ygb3BlbmluZyB0aGUgc2NlbmUuICovXG5mdW5jdGlvbiBpc1RvdWNoRGV2aWNlKCk6IGJvb2xlYW4ge1xuICByZXR1cm4gd2luZG93Lm1hdGNoTWVkaWEoXCIoaG92ZXI6IG5vbmUpXCIpLm1hdGNoZXM7XG59XG5cbi8qKiBUaHVtYm5haWwgLyDihpcgbGluayBjbGljazogbmF0aXZlIGxpbmsgZm9yIG5ldyB0YWIgb3IgbW9kaWZpZXIgY2xpY2tzLCBTUEEgbmF2aWdhdGlvbiBvdGhlcndpc2UuICovXG5mdW5jdGlvbiBoYW5kbGVTY2VuZUxpbmtDbGljayhlOiBNb3VzZUV2ZW50LCBsaW5rOiBIVE1MQW5jaG9yRWxlbWVudCk6IHZvaWQge1xuICBjb25zdCBuYXRpdmVOZXdUYWIgPSBsaW5rLnRhcmdldCA9PT0gXCJfYmxhbmtcIiAmJiBzdGF0ZS5zZXR0aW5ncy5vcGVuSW5OZXdUYWI7XG4gIGlmIChuYXRpdmVOZXdUYWIgfHwgZS5jdHJsS2V5IHx8IGUubWV0YUtleSB8fCBlLnNoaWZ0S2V5IHx8IGUuYnV0dG9uICE9PSAwKSByZXR1cm47XG4gIGUucHJldmVudERlZmF1bHQoKTtcbiAgbmF2aWdhdGVUb1VybChsaW5rLmdldEF0dHJpYnV0ZShcImhyZWZcIikgfHwgXCJcIik7XG59XG5cbi8qKlxuICogU2xpZGVyICgwLTEwMCkgdG8gbWVkaWEgdm9sdW1lIG9uIGEgY3ViaWMgY3VydmUsIHNvIHRoZSBzbGlkZXIgdHJhY2tzIHBlcmNlaXZlZCBsb3VkbmVzcy5cbiAqIChTdGFzaCdzIHBsYXllciBpcyBsaW5lYXIsIGJ1dCBnZW5lcmF0ZWQgcHJldmlldyBjbGlwcyBhcmUgbXVjaCBsb3VkZXIgdGhhbiB0aGUgc291cmNlLilcbiAqL1xuZnVuY3Rpb24gc2xpZGVyVG9Wb2x1bWUoc2xpZGVyOiBudW1iZXIpOiBudW1iZXIge1xuICByZXR1cm4gTWF0aC5wb3coc2xpZGVyIC8gMTAwLCAzKTtcbn1cblxuLyoqIEFwcGx5IHZvbHVtZS9hdXRvcGxheSBzZXR0aW5ncyB0byB0aGUgcmVuZGVyZWQgcHJldmlldyB2aWRlb3MgKGhvdmVyZWQgY2FyZCBpcyBhdWRpYmxlKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhcHBseVByZXZpZXdTZXR0aW5ncygpOiB2b2lkIHtcbiAgY29uc3QgeyBwcmV2aWV3Vm9sdW1lLCBhdXRvcGxheVByZXZpZXdzIH0gPSBzdGF0ZS5zZXR0aW5ncztcbiAgY29uc3QgYmF0dGxlVmlzaWJsZSA9IGdldEFjdGl2ZVRhYigpID09PSBcImJhdHRsZVwiO1xuICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKFwiLnNiLXZzLWNvbnRhaW5lclwiKT8uY2xhc3NMaXN0LnRvZ2dsZShcInNiLWF1dG9wbGF5XCIsIGF1dG9wbGF5UHJldmlld3MpO1xuXG4gIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KFwiI3NiLWNvbXBhcmlzb24tYXJlYSAuc2Itc2NlbmUtY2FyZFwiKS5mb3JFYWNoKChjYXJkKSA9PiB7XG4gICAgY29uc3QgdmlkZW8gPSBjYXJkLnF1ZXJ5U2VsZWN0b3I8SFRNTFZpZGVvRWxlbWVudD4oXCIuc2ItaG92ZXItcHJldmlld1wiKTtcbiAgICBpZiAoIXZpZGVvKSByZXR1cm47XG4gICAgY29uc3QgYWN0aXZlID0gY2FyZC5tYXRjaGVzKFwiOmhvdmVyXCIpIHx8IGNhcmQuY2xhc3NMaXN0LmNvbnRhaW5zKFwic2ItcHJldmlld2luZ1wiKTtcbiAgICB2aWRlby52b2x1bWUgPSBzbGlkZXJUb1ZvbHVtZShwcmV2aWV3Vm9sdW1lKTtcbiAgICB2aWRlby5tdXRlZCA9ICFhY3RpdmUgfHwgcHJldmlld1ZvbHVtZSA9PT0gMDtcbiAgICBpZiAoYmF0dGxlVmlzaWJsZSAmJiAoYXV0b3BsYXlQcmV2aWV3cyB8fCBhY3RpdmUpKSB7XG4gICAgICBpZiAodmlkZW8ucGF1c2VkKSB2aWRlby5wbGF5KCkuY2F0Y2goKCkgPT4ge30pO1xuICAgIH0gZWxzZSB7XG4gICAgICB2aWRlby5wYXVzZSgpO1xuICAgICAgdmlkZW8uY3VycmVudFRpbWUgPSAwO1xuICAgIH1cbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGJpbmRQcmV2aWV3KGNhcmQ6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIGNvbnN0IHZpZGVvID0gY2FyZC5xdWVyeVNlbGVjdG9yPEhUTUxWaWRlb0VsZW1lbnQ+KFwiLnNiLWhvdmVyLXByZXZpZXdcIik7XG4gIGlmICghdmlkZW8pIHJldHVybjtcblxuICBjYXJkLmFkZEV2ZW50TGlzdGVuZXIoXCJtb3VzZWVudGVyXCIsICgpID0+IHtcbiAgICBpZiAoaXNUb3VjaERldmljZSgpKSByZXR1cm47XG4gICAgaWYgKCFzdGF0ZS5zZXR0aW5ncy5hdXRvcGxheVByZXZpZXdzKSB2aWRlby5jdXJyZW50VGltZSA9IDA7XG4gICAgdmlkZW8udm9sdW1lID0gc2xpZGVyVG9Wb2x1bWUoc3RhdGUuc2V0dGluZ3MucHJldmlld1ZvbHVtZSk7XG4gICAgdmlkZW8ubXV0ZWQgPSBzdGF0ZS5zZXR0aW5ncy5wcmV2aWV3Vm9sdW1lID09PSAwO1xuICAgIHZpZGVvLnBsYXkoKS5jYXRjaCgoKSA9PiB7fSk7XG4gIH0pO1xuXG4gIGNhcmQuYWRkRXZlbnRMaXN0ZW5lcihcIm1vdXNlbGVhdmVcIiwgKCkgPT4ge1xuICAgIGlmIChpc1RvdWNoRGV2aWNlKCkpIHJldHVybjtcbiAgICBpZiAoc3RhdGUuc2V0dGluZ3MuYXV0b3BsYXlQcmV2aWV3cykge1xuICAgICAgdmlkZW8ubXV0ZWQgPSB0cnVlO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB2aWRlby5wYXVzZSgpO1xuICAgIHZpZGVvLmN1cnJlbnRUaW1lID0gMDtcbiAgfSk7XG59XG5cbi8qKiBUb3VjaDogdGFwIHRoZSB0aHVtYm5haWwgdG8gcGxheS9zdG9wIGl0cyBwcmV2aWV3IHdpdGggc291bmQuICovXG5mdW5jdGlvbiB0b2dnbGVQcmV2aWV3KGNhcmQ6IEhUTUxFbGVtZW50KTogdm9pZCB7XG4gIGNvbnN0IHByZXZpZXdpbmcgPSAhY2FyZC5jbGFzc0xpc3QuY29udGFpbnMoXCJzYi1wcmV2aWV3aW5nXCIpO1xuICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKFwiLnNiLXNjZW5lLWNhcmQuc2ItcHJldmlld2luZ1wiKS5mb3JFYWNoKChjKSA9PiBjLmNsYXNzTGlzdC5yZW1vdmUoXCJzYi1wcmV2aWV3aW5nXCIpKTtcbiAgY2FyZC5jbGFzc0xpc3QudG9nZ2xlKFwic2ItcHJldmlld2luZ1wiLCBwcmV2aWV3aW5nKTtcbiAgYXBwbHlQcmV2aWV3U2V0dGluZ3MoKTtcbn1cblxuLyoqXG4gKiBUaGUgVlMgYmV0d2VlbiB0aGUgY2FyZHMsIHdpdGggZWFjaCBzaWRlJ3Mgd2luIGNoYW5jZSB1bmRlciBpdCAoYSBcIndobydzIGZhdm91cmVkXCIgYmFyKS5cbiAqIFBsYWNlbWVudCBoYXMgbm9uZTogaXRzIHNjZW5lJ3MgRUxPIGRvZXNuJ3QgY2hhbmdlIHBlciBwaWNrLCBhbmQgYW4gdW5yYXRlZCBvbmUgaGFzIG5vIEVMTy5cbiAqL1xuZnVuY3Rpb24gdnNEaXZpZGVyKGxlZnQ6IFNjZW5lLCByaWdodDogU2NlbmUpOiBzdHJpbmcge1xuICBpZiAoc3RhdGUuY3VycmVudE1vZGUgPT09IFwicGxhY2VtZW50XCIpIHtcbiAgICByZXR1cm4gYDxkaXYgY2xhc3M9XCJzYi12cy1kaXZpZGVyXCI+PHNwYW4gY2xhc3M9XCJzYi12cy10ZXh0XCI+VlM8L3NwYW4+PC9kaXY+YDtcbiAgfVxuICBjb25zdCBbbGVmdENoYW5jZSwgcmlnaHRDaGFuY2VdID0gd2luQ2hhbmNlcyhiYXR0bGVFbG8obGF0ZXN0U2NlbmUobGVmdCkpLCBiYXR0bGVFbG8obGF0ZXN0U2NlbmUocmlnaHQpKSk7XG4gIGNvbnN0IGZhdm91cmVkID0gKGNoYW5jZTogbnVtYmVyKTogc3RyaW5nID0+IChjaGFuY2UgPiA1MCA/IFwiIHNiLWZhdm91cmVkXCIgOiBcIlwiKTtcbiAgY29uc3QgdGlwID0gYENoYW5jZSBlYWNoIHNjZW5lIHdpbnMsIGZyb20gdGhlaXIgRUxPOiBsZWZ0ICR7bGVmdENoYW5jZX0lLCByaWdodCAke3JpZ2h0Q2hhbmNlfSVgO1xuICByZXR1cm4gYFxuICAgICAgICA8ZGl2IGNsYXNzPVwic2ItdnMtZGl2aWRlclwiPlxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi12cy1zdGFja1wiIHRpdGxlPVwiJHt0aXB9XCI+XG4gICAgICAgICAgICA8c3BhbiBjbGFzcz1cInNiLXdpbi1jaGFuY2Ugc2Itd2luLWNoYW5jZS1sZWZ0JHtmYXZvdXJlZChsZWZ0Q2hhbmNlKX1cIj4ke2xlZnRDaGFuY2V9JTwvc3Bhbj5cbiAgICAgICAgICAgIDxzcGFuIGNsYXNzPVwic2ItdnMtdGV4dFwiPlZTPC9zcGFuPlxuICAgICAgICAgICAgPHNwYW4gY2xhc3M9XCJzYi13aW4tY2hhbmNlIHNiLXdpbi1jaGFuY2UtcmlnaHQke2Zhdm91cmVkKHJpZ2h0Q2hhbmNlKX1cIj4ke3JpZ2h0Q2hhbmNlfSU8L3NwYW4+XG4gICAgICAgICAgICA8c3BhbiBjbGFzcz1cInNiLXdpbi1iYXJcIiBhcmlhLWhpZGRlbj1cInRydWVcIj48c3BhbiBzdHlsZT1cIndpZHRoOiAke2xlZnRDaGFuY2V9JVwiPjwvc3Bhbj48L3NwYW4+XG4gICAgICAgICAgPC9kaXY+XG4gICAgICAgIDwvZGl2PmA7XG59XG5cbi8qKiBFYWNoIHNjZW5lJ3MgdGllciB3aGVuIFwiU2hvdyB0aWVycyBvbiBjYXJkc1wiIGlzIG9uIChmcm9tIHRoZSB3aG9sZSBsaWJyYXJ5J3MgRUxPIG9yZGVyKS4gKi9cbmZ1bmN0aW9uIHBhaXJUaWVycyhzY2VuZXM6IFNjZW5lW10pOiAoVGllciB8IG51bGwpW10ge1xuICBjb25zdCBsaWJyYXJ5ID0gc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzO1xuICBpZiAoIXN0YXRlLnNldHRpbmdzLnNob3dUaWVycyB8fCAhbGlicmFyeSkgcmV0dXJuIHNjZW5lcy5tYXAoKCkgPT4gbnVsbCk7XG4gIGNvbnN0IHRpZXJzID0gdGllck1hcChsaWJyYXJ5KTtcbiAgcmV0dXJuIHNjZW5lcy5tYXAoKHNjZW5lKSA9PiB0aWVycy5nZXQoc2NlbmUuaWQpID8/IG51bGwpO1xufVxuXG4vLyBTaGFyZWQgcmVuZGVyaW5nIGxvZ2ljIGZvciBkaXNwbGF5aW5nIGEgcGFpciBvZiBzY2VuZXNcbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJQYWlyKHNjZW5lczogU2NlbmVbXSwgcmFua3M6IFJhbmtbXSk6IHZvaWQge1xuICBjb25zdCBjb21wYXJpc29uQXJlYSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic2ItY29tcGFyaXNvbi1hcmVhXCIpO1xuICBpZiAoIWNvbXBhcmlzb25BcmVhKSByZXR1cm47XG5cbiAgY29uc3Qgc3RhdHVzQmFkZ2VzID0gc2NlbmVzLm1hcChjbGltYlN0YXR1c0JhZGdlKTtcbiAgY29uc3QgdGllcnMgPSBwYWlyVGllcnMoc2NlbmVzKTtcblxuICBjb21wYXJpc29uQXJlYS5pbm5lckhUTUwgPSBgXG4gICAgICA8ZGl2IGNsYXNzPVwic2ItdnMtY29udGFpbmVyXCI+XG4gICAgICAgICR7Y3JlYXRlU2NlbmVDYXJkKHNjZW5lc1swXSwgXCJsZWZ0XCIsIHJhbmtzWzBdLCBzdGF0dXNCYWRnZXNbMF0sIHRpZXJzWzBdKX1cbiAgICAgICAgJHt2c0RpdmlkZXIoc2NlbmVzWzBdLCBzY2VuZXNbMV0pfVxuICAgICAgICAke2NyZWF0ZVNjZW5lQ2FyZChzY2VuZXNbMV0sIFwicmlnaHRcIiwgcmFua3NbMV0sIHN0YXR1c0JhZGdlc1sxXSwgdGllcnNbMV0pfVxuICAgICAgPC9kaXY+XG4gICAgYDtcblxuICBjb25zdCBsZWZ0ID0gc2NlbmVzWzBdO1xuICBjb25zdCByaWdodCA9IHNjZW5lc1sxXTtcbiAgY29uc3QgbGVmdENhcmQgPSBjb21wYXJpc29uQXJlYS5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PignLnNiLXNjZW5lLWNhcmRbZGF0YS1zaWRlPVwibGVmdFwiXScpO1xuICBjb25zdCByaWdodENhcmQgPSBjb21wYXJpc29uQXJlYS5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PignLnNiLXNjZW5lLWNhcmRbZGF0YS1zaWRlPVwicmlnaHRcIl0nKTtcbiAgY29uc3QgbGVmdEJvZHkgPSBsZWZ0Q2FyZD8ucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCIuc2Itc2NlbmUtYm9keVwiKTtcbiAgY29uc3QgcmlnaHRCb2R5ID0gcmlnaHRDYXJkPy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIi5zYi1zY2VuZS1ib2R5XCIpO1xuXG4gIGlmIChsZWZ0ICYmIHJpZ2h0ICYmIGxlZnRDYXJkICYmIHJpZ2h0Q2FyZCAmJiBsZWZ0Qm9keSAmJiByaWdodEJvZHkpIHtcbiAgICBiaW5kU2NlbmVDaG9pY2UobGVmdEJvZHksIHtcbiAgICAgIHdpbm5lcjogbGVmdCxcbiAgICAgIGxvc2VyOiByaWdodCxcbiAgICAgIGxlZnQsXG4gICAgICByaWdodCxcbiAgICAgIHdpbm5lckNhcmQ6IGxlZnRDYXJkLFxuICAgICAgbG9zZXJDYXJkOiByaWdodENhcmQsXG4gICAgICB3aW5uZXJSYW5rOiByYW5rc1swXSxcbiAgICAgIGxvc2VyUmFuazogcmFua3NbMV0sXG4gICAgfSk7XG4gICAgYmluZFNjZW5lQ2hvaWNlKHJpZ2h0Qm9keSwge1xuICAgICAgd2lubmVyOiByaWdodCxcbiAgICAgIGxvc2VyOiBsZWZ0LFxuICAgICAgbGVmdCxcbiAgICAgIHJpZ2h0LFxuICAgICAgd2lubmVyQ2FyZDogcmlnaHRDYXJkLFxuICAgICAgbG9zZXJDYXJkOiBsZWZ0Q2FyZCxcbiAgICAgIHdpbm5lclJhbms6IHJhbmtzWzFdLFxuICAgICAgbG9zZXJSYW5rOiByYW5rc1swXSxcbiAgICB9KTtcblxuICAgIGxlZnRDYXJkLnF1ZXJ5U2VsZWN0b3IoXCIuc2ItZGVsZXRlLWJ0blwiKT8uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHZvaWQgZGVsZXRlRnJvbUJhdHRsZShsZWZ0KSk7XG4gICAgcmlnaHRDYXJkLnF1ZXJ5U2VsZWN0b3IoXCIuc2ItZGVsZXRlLWJ0blwiKT8uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHZvaWQgZGVsZXRlRnJvbUJhdHRsZShyaWdodCkpO1xuICB9XG5cbiAgY29tcGFyaXNvbkFyZWEucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oXCIuc2Itc2NlbmUtY2FyZFwiKS5mb3JFYWNoKChjYXJkKSA9PiB7XG4gICAgY29uc3QgdGh1bWIgPSBjYXJkLnF1ZXJ5U2VsZWN0b3I8SFRNTEFuY2hvckVsZW1lbnQ+KFwiLnNiLXNjZW5lLWltYWdlLWNvbnRhaW5lclwiKTtcbiAgICB0aHVtYj8uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XG4gICAgICBpZiAoaXNUb3VjaERldmljZSgpKSB7XG4gICAgICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICAgICAgdG9nZ2xlUHJldmlldyhjYXJkKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuICAgICAgaGFuZGxlU2NlbmVMaW5rQ2xpY2soZSwgdGh1bWIpO1xuICAgIH0pO1xuICAgIGNvbnN0IG9wZW5MaW5rID0gY2FyZC5xdWVyeVNlbGVjdG9yPEhUTUxBbmNob3JFbGVtZW50PihcIi5zYi1vcGVuLWxpbmtcIik7XG4gICAgb3Blbkxpbms/LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZSkgPT4ge1xuICAgICAgaWYgKCFzdGF0ZS5zZXR0aW5ncy5vcGVuSW5OZXdUYWIpIGhhbmRsZVNjZW5lTGlua0NsaWNrKGUsIG9wZW5MaW5rKTtcbiAgICB9KTtcbiAgICBiaW5kUHJldmlldyhjYXJkKTtcbiAgfSk7XG4gIGFwcGx5UHJldmlld1NldHRpbmdzKCk7XG5cbiAgc2V0QWN0aW9uc1Zpc2libGUodHJ1ZSk7XG5cbiAgLy8gVXBkYXRlIHNraXAgYnV0dG9uIHN0YXRlXG4gIGNvbnN0IHNraXBCdG4gPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yPEhUTUxCdXR0b25FbGVtZW50PihcIiNzYi1za2lwLWJ0blwiKTtcbiAgaWYgKHNraXBCdG4pIHNraXBCdG4uZGlzYWJsZWQgPSBpc1J1bkFjdGl2ZSgpO1xufVxuXG4vKiogU2tpcCB0aGUgY3VycmVudCBwYWlyIChub3QgYWxsb3dlZCBtaWQtcnVuKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBza2lwUGFpcigpOiB2b2lkIHtcbiAgaWYgKGlzUnVuQWN0aXZlKCkgfHwgc3RhdGUuZGlzYWJsZUNob2ljZSkgcmV0dXJuO1xuICBzdGF0ZS5kaXNhYmxlQ2hvaWNlID0gdHJ1ZTtcbiAgaWYgKHN0YXRlLmN1cnJlbnRNb2RlICE9PSBcInN3aXNzXCIpIHtcbiAgICByZXNldFJ1blN0YXRlKCk7XG4gICAgc2F2ZVN0YXRlKCk7XG4gIH1cbiAgbG9hZE5ld1BhaXIoKTtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGxvYWROZXdQYWlyKGZvcmNlZExlZnRTY2VuZUlkOiBzdHJpbmcgfCBudWxsID0gbnVsbCk6IFByb21pc2U8dm9pZD4ge1xuICAvLyBObyBwb29sIGxvYWRzIGJlZm9yZSB0aGUgb25lLXRpbWUgRUxPIHNldHVwIGhhcyBydW4gKGl0IHNob3dzIGluIHBsYWNlIG9mIHRoZSBiYXR0bGUpXG4gIGlmIChpc0Vsb1NldHVwUGVuZGluZygpKSByZXR1cm47XG4gIHN0YXRlLmRpc2FibGVDaG9pY2UgPSBmYWxzZTtcbiAgY29uc3QgY29tcGFyaXNvbkFyZWEgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInNiLWNvbXBhcmlzb24tYXJlYVwiKTtcbiAgaWYgKCFjb21wYXJpc29uQXJlYSkgcmV0dXJuO1xuXG4gIGNvbnNvbGUubG9nKFxuICAgIGBbU3Rhc2ggQmF0dGxlXSDwn46uIExvYWRpbmcgbmV3IHBhaXIgKG1vZGU6ICR7c3RhdGUuY3VycmVudE1vZGV9KSR7Zm9yY2VkTGVmdFNjZW5lSWQgPyBgIHdpdGggZm9yY2VkIHNjZW5lICR7Zm9yY2VkTGVmdFNjZW5lSWR9YCA6IFwiXCJ9Li4uYCxcbiAgKTtcbiAgY29uc3Qgc3RhcnRUaW1lID0gRGF0ZS5ub3coKTtcblxuICAvLyBPbmx5IHNob3cgbG9hZGluZyBvbiBmaXJzdCBsb2FkICh3aGVuIGVtcHR5IG9yIGFscmVhZHkgc2hvd2luZyBsb2FkaW5nKVxuICBpZiAoIWNvbXBhcmlzb25BcmVhLnF1ZXJ5U2VsZWN0b3IoXCIuc2ItdnMtY29udGFpbmVyXCIpKSB7XG4gICAgY29uc3QgaGFzQ2FjaGUgPSBzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXMgIT09IG51bGw7XG4gICAgY29tcGFyaXNvbkFyZWEuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9XCJzYi1sb2FkaW5nXCI+JHtoYXNDYWNoZSA/IFwiTG9hZGluZyBzY2VuZXMuLi5cIiA6IFwiTG9hZGluZyBhbmQgY2FjaGluZyBzY2VuZXMgKGZpcnN0IGxvYWQgbWF5IHRha2UgYSBtb21lbnQpLi4uXCJ9PC9kaXY+YDtcbiAgfVxuXG4gIHRyeSB7XG4gICAgLy8gRmV0Y2ggZm9yY2VkIHNjZW5lIGRhdGEgaWYgYSBzY2VuZSBJRCB3YXMgcHJvdmlkZWRcbiAgICBsZXQgZm9yY2VkTGVmdFNjZW5lOiBTY2VuZSB8IG51bGwgPSBudWxsO1xuICAgIGlmIChmb3JjZWRMZWZ0U2NlbmVJZCkge1xuICAgICAgZm9yY2VkTGVmdFNjZW5lID0gYXdhaXQgZmV0Y2hTY2VuZUJ5SWQoZm9yY2VkTGVmdFNjZW5lSWQpO1xuICAgICAgLy8gRnJlc2ggZnJvbSBTdGFzaDogdGhlIGNhY2hlIG1heSBiZSBvbGRlciAoYW5vdGhlciB0YWIpLCBhbmQgcmFua3MgYW5kIGJhdHRsZSBtYXRoIHJlYWQgaXRcbiAgICAgIGlmIChmb3JjZWRMZWZ0U2NlbmUpIHJlZnJlc2hTY2VuZUluQ2FjaGUoZm9yY2VkTGVmdFNjZW5lKTtcbiAgICAgIGlmICghZm9yY2VkTGVmdFNjZW5lKSB7XG4gICAgICAgIGNvbnNvbGUud2FybihcIltTdGFzaCBCYXR0bGVdIENvdWxkIG5vdCBmZXRjaCBzY2VuZSBmcm9tIFVSTCwgZmFsbGluZyBiYWNrIHRvIG5vcm1hbCBwYWlyaW5nXCIpO1xuICAgICAgfVxuICAgIH1cblxuICAgIGxldCBzY2VuZXM6IFNjZW5lW10gPSBbXTtcbiAgICBsZXQgcmFua3M6IFJhbmtbXSA9IFtudWxsLCBudWxsXTtcblxuICAgIGlmIChzdGF0ZS5jdXJyZW50TW9kZSA9PT0gXCJwbGFjZW1lbnRcIikge1xuICAgICAgY29uc3QgcGxhY2VtZW50UmVzdWx0ID0gYXdhaXQgZmV0Y2hQbGFjZW1lbnRQYWlyKGZvcmNlZExlZnRTY2VuZSk7XG5cbiAgICAgIGlmIChwbGFjZW1lbnRSZXN1bHQuZG9uZSkge1xuICAgICAgICAvLyBBIGNsaW1iIGZyb20gdGhlIGJvdHRvbSB0aGF0IG5ldmVyIGxvc3QgaGFzIGJlYXRlbiB0aGUgdG9wIHNjZW5lXG4gICAgICAgIGlmIChwbGFjZW1lbnRSZXN1bHQuZnJvbUJvdHRvbSAmJiBwbGFjZW1lbnRSZXN1bHQucmFuayA9PT0gMSkge1xuICAgICAgICAgIHNob3dWaWN0b3J5U2NyZWVuKHBsYWNlbWVudFJlc3VsdC5zY2VuZSwgcGxhY2VtZW50UmVzdWx0LnN0cmVhayk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgc2hvd1BsYWNlbWVudFNjcmVlbihwbGFjZW1lbnRSZXN1bHQpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgc2NlbmVzID0gcGxhY2VtZW50UmVzdWx0LnNjZW5lcztcbiAgICAgIHJhbmtzID0gcGxhY2VtZW50UmVzdWx0LnJhbmtzO1xuICAgIH0gZWxzZSBpZiAoc3RhdGUuY3VycmVudE1vZGUgPT09IFwiY2hhbXBpb25cIikge1xuICAgICAgY29uc3QgY2hhbXBpb25SZXN1bHQgPSBhd2FpdCBmZXRjaENoYW1waW9uUGFpcihmb3JjZWRMZWZ0U2NlbmUpO1xuXG4gICAgICAvLyBDaGVjayBmb3IgdmljdG9yeSAoY2hhbXBpb24gYmVhdCBldmVyeW9uZSlcbiAgICAgIGlmIChjaGFtcGlvblJlc3VsdC5pc1ZpY3RvcnkpIHtcbiAgICAgICAgc2hvd1ZpY3RvcnlTY3JlZW4oY2hhbXBpb25SZXN1bHQuc2NlbmVzWzBdLCBzdGF0ZS5jaGFtcGlvbldpbnMpO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIHNjZW5lcyA9IGNoYW1waW9uUmVzdWx0LnNjZW5lcztcbiAgICAgIHJhbmtzID0gY2hhbXBpb25SZXN1bHQucmFua3M7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IHN3aXNzUmVzdWx0ID0gYXdhaXQgZmV0Y2hTd2lzc1BhaXIoZm9yY2VkTGVmdFNjZW5lKTtcblxuICAgICAgc2NlbmVzID0gc3dpc3NSZXN1bHQuc2NlbmVzO1xuICAgICAgcmFua3MgPSBzd2lzc1Jlc3VsdC5yYW5rcztcbiAgICB9XG5cbiAgICBpZiAoc2NlbmVzLmxlbmd0aCA8IDIpIHtcbiAgICAgIGNvbXBhcmlzb25BcmVhLmlubmVySFRNTCA9ICc8ZGl2IGNsYXNzPVwic2ItZXJyb3JcIj5Ob3QgZW5vdWdoIHNjZW5lcyBhdmFpbGFibGUgZm9yIGNvbXBhcmlzb24uPC9kaXY+JztcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBzdGF0ZS5jdXJyZW50UGFpci5sZWZ0ID0gc2NlbmVzWzBdO1xuICAgIHN0YXRlLmN1cnJlbnRQYWlyLnJpZ2h0ID0gc2NlbmVzWzFdO1xuICAgIHN0YXRlLmN1cnJlbnRSYW5rcy5sZWZ0ID0gcmFua3NbMF07XG4gICAgc3RhdGUuY3VycmVudFJhbmtzLnJpZ2h0ID0gcmFua3NbMV07XG5cbiAgICBjb25zdCBsb2FkVGltZSA9IERhdGUubm93KCkgLSBzdGFydFRpbWU7XG4gICAgY29uc29sZS5sb2coXG4gICAgICBgW1N0YXNoIEJhdHRsZV0g4pyFIFBhaXIgbG9hZGVkIGluICR7bG9hZFRpbWV9bXM6IFNjZW5lICR7c2NlbmVzWzBdLmlkfSAocmFuayAjJHtyYW5rc1swXX0pIHZzIFNjZW5lICR7c2NlbmVzWzFdLmlkfSAocmFuayAjJHtyYW5rc1sxXX0pYCxcbiAgICApO1xuXG4gICAgcmVuZGVyUGFpcihzY2VuZXMsIHJhbmtzKTtcbiAgICB1cGRhdGVQb29sU3RhdHVzKCk7XG4gICAgdXBkYXRlQ2xpbWJQb29sV2FybmluZygpO1xuICAgIHNhdmVTdGF0ZSgpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnNvbGUuZXJyb3IoXCJbU3Rhc2ggQmF0dGxlXSBFcnJvciBsb2FkaW5nIHNjZW5lczpcIiwgZXJyb3IpO1xuICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XG4gICAgY29uc3QgaXNOb1NjZW5lcyA9IG1lc3NhZ2UuaW5jbHVkZXMoXCJObyBzY2VuZXNcIikgfHwgbWVzc2FnZS5pbmNsdWRlcyhcIk5vdCBlbm91Z2hcIik7XG4gICAgY29tcGFyaXNvbkFyZWEuaW5uZXJIVE1MID0gYFxuICAgICAgICA8ZGl2IGNsYXNzPVwic2ItZXJyb3Itc2NyZWVuXCI+XG4gICAgICAgICAgPGRpdiBjbGFzcz1cInNiLWVycm9yLWljb25cIj7imqDvuI88L2Rpdj5cbiAgICAgICAgICA8cCBjbGFzcz1cInNiLWVycm9yLW1lc3NhZ2VcIj4ke21lc3NhZ2V9PC9wPlxuICAgICAgICAgIDxidXR0b24gaWQ9XCJzYi1lcnJvci1yZXRyeVwiIGNsYXNzPVwiYnRuIGJ0bi1wcmltYXJ5XCI+UmV0cnk8L2J1dHRvbj5cbiAgICAgICAgPC9kaXY+XG4gICAgICBgO1xuICAgIHNldEFjdGlvbnNWaXNpYmxlKHRydWUpO1xuXG4gICAgLy8gQXR0YWNoIHJldHJ5IGhhbmRsZXJcbiAgICBjb25zdCByZXRyeUJ0biA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic2ItZXJyb3ItcmV0cnlcIikgYXMgSFRNTEJ1dHRvbkVsZW1lbnQgfCBudWxsO1xuICAgIGlmIChyZXRyeUJ0bikge1xuICAgICAgcmV0cnlCdG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIGFzeW5jICgpID0+IHtcbiAgICAgICAgcmV0cnlCdG4uZGlzYWJsZWQgPSB0cnVlO1xuICAgICAgICByZXRyeUJ0bi50ZXh0Q29udGVudCA9IFwiTG9hZGluZy4uLlwiO1xuXG4gICAgICAgIGlmIChpc05vU2NlbmVzKSB7XG4gICAgICAgICAgLy8gXCJObyBzY2VuZXNcIiBlcnJvcjogY2xlYXIgZXZlcnl0aGluZyBhbmQgc3RhcnQgZnJlc2hcbiAgICAgICAgICBhd2FpdCBjbGVhckZpbHRlcmVkQ2FjaGUoKTtcbiAgICAgICAgICByZXNldFNodWZmbGUoKTtcbiAgICAgICAgfVxuICAgICAgICAvLyBOZXR3b3JrL290aGVyIGVycm9yczoganVzdCByZXRyeSB3aXRob3V0IGNsZWFyaW5nIHNlc3Npb24gc3RhdGVcblxuICAgICAgICBhd2FpdCBsb2FkTmV3UGFpcigpO1xuICAgICAgfSk7XG4gICAgfVxuICB9XG59XG5cbi8qKiBSZW5kZXIgdGhlIHNhdmVkIHBhaXIsIHVubGVzcyBvbmUgb2YgaXRzIHNjZW5lcyB3YXMgZGVsZXRlZCBpbiBTdGFzaCBtZWFud2hpbGUuICovXG4vKipcbiAqIFdoZXRoZXIgdGhlIHNhdmVkIHBhaXIgYmVsb25ncyB0byB0aGUgY3VycmVudCBydW4uIEEgUGxhY2VtZW50IHBhaXIgaXMgaXRzIHJ1bidzIHNjZW5lIGFnYWluc3RcbiAqIGFuIG9wcG9uZW50LCBhbmQgYSBDaGFtcGlvbiBwYWlyIGluY2x1ZGVzIHRoZSBjaGFtcGlvbjsgd2l0aG91dCB0aGF0LCBwaWNrcyBoYXZlIG5vdGhpbmcgdG9cbiAqIGFjdCBvbiAoYSBydW4gdGhhdCBlbmRlZCwgc2F5KS5cbiAqL1xuZnVuY3Rpb24gcGFpck1hdGNoZXNSdW4obGVmdDogU2NlbmUsIHJpZ2h0OiBTY2VuZSk6IGJvb2xlYW4ge1xuICBpZiAoc3RhdGUuY3VycmVudE1vZGUgPT09IFwicGxhY2VtZW50XCIpIHJldHVybiBzdGF0ZS5wbGFjZW1lbnQ/LnNjZW5lLmlkID09PSBsZWZ0LmlkO1xuICBpZiAoc3RhdGUuY3VycmVudE1vZGUgPT09IFwiY2hhbXBpb25cIiAmJiBzdGF0ZS5jaGFtcGlvblNjZW5lKSB7XG4gICAgcmV0dXJuIHN0YXRlLmNoYW1waW9uU2NlbmUuaWQgPT09IGxlZnQuaWQgfHwgc3RhdGUuY2hhbXBpb25TY2VuZS5pZCA9PT0gcmlnaHQuaWQ7XG4gIH1cbiAgcmV0dXJuIHRydWU7XG59XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZXN0b3JlQ3VycmVudFBhaXIoKTogUHJvbWlzZTx2b2lkPiB7XG4gIGlmIChpc0Vsb1NldHVwUGVuZGluZygpKSByZXR1cm47XG4gIGNvbnN0IGxlZnQgPSBzdGF0ZS5jdXJyZW50UGFpci5sZWZ0IGFzIFNjZW5lO1xuICBjb25zdCByaWdodCA9IHN0YXRlLmN1cnJlbnRQYWlyLnJpZ2h0IGFzIFNjZW5lO1xuICBpZiAoIXBhaXJNYXRjaGVzUnVuKGxlZnQsIHJpZ2h0KSkge1xuICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+TgiBTYXZlZCBwYWlyIGRvZXNuJ3QgYmVsb25nIHRvIHRoZSBjdXJyZW50IHJ1biwgbG9hZGluZyBhIG5ldyBwYWlyXCIpO1xuICAgIGF3YWl0IGxvYWROZXdQYWlyKCk7XG4gICAgcmV0dXJuO1xuICB9XG4gIHN0YXRlLmRpc2FibGVDaG9pY2UgPSBmYWxzZTtcblxuICAvLyBBbHNvIGJyaW5ncyB0aGUgcGFpcidzIEVMTyBhbmQgU3Rhc2ggcmF0aW5nIHVwIHRvIGRhdGUgKHRoZXkgbWF5IGhhdmUgY2hhbmdlZCBzaW5jZSBpdCB3YXMgc2F2ZWQpXG4gIGlmICghKGF3YWl0IHZlcmlmeUN1cnJlbnRQYWlyKCkpKSByZXR1cm47XG5cbiAgLy8gUmFua3MgZnJvbSB0aGUgY3VycmVudCBwb29scywgbm90IHRoZSBzYXZlZCBvbmVzOiBiYXR0bGVzIHNpbmNlIG1heSBoYXZlIG1vdmVkIHRoZW0uIExvYWRpbmdcbiAgLy8gdGhlIHBvb2xzIGFsc28gcHJlLXdhcm1zIHRoZW0gZm9yIHRoZSBuZXh0IGNob2ljZSBhbmQgZmlsbHMgaW4gdGhlIHN0YXR1cyBsaW5lJ3MgcG9vbCBzaXplLlxuICBsZXQgcmFua3M6IFtSYW5rLCBSYW5rXSA9IFtzdGF0ZS5jdXJyZW50UmFua3MubGVmdCwgc3RhdGUuY3VycmVudFJhbmtzLnJpZ2h0XTtcbiAgdHJ5IHtcbiAgICByYW5rcyA9IGF3YWl0IHBhaXJSYW5rcyhsZWZ0LCByaWdodCk7XG4gICAgc3RhdGUuY3VycmVudFJhbmtzID0geyBsZWZ0OiByYW5rc1swXSwgcmlnaHQ6IHJhbmtzWzFdIH07XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zb2xlLndhcm4oXCJbU3Rhc2ggQmF0dGxlXSBDb3VsZCBub3QgbG9hZCBzY2VuZSBwb29scyBmb3IgdGhlIHNhdmVkIHBhaXIncyByYW5rczpcIiwgZSk7XG4gIH1cblxuICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCfk4IgUmVuZGVyaW5nIHNhdmVkIHBhaXJcIik7XG4gIHJlbmRlclBhaXIoW2xlZnQsIHJpZ2h0XSwgcmFua3MpO1xuICB1cGRhdGVQb29sU3RhdHVzKCk7XG59XG5cbi8qKlxuICogQ2hlY2sgdGhlIGN1cnJlbnQgcGFpciBzdGlsbCBleGlzdHMgaW4gU3Rhc2ggKHNjZW5lcyBtYXkgYmUgZGVsZXRlZCBlbHNld2hlcmUpLiBJZiBvbmUgaXMgZ29uZSxcbiAqIGNvbnRpbnVlIHdpdGhvdXQgaXQgYW5kIHJldHVybiBmYWxzZS4gT3RoZXJ3aXNlIHRoZSBwYWlyJ3MgRUxPIGFuZCBTdGFzaCByYXRpbmcgYXJlIGJyb3VnaHQgdXBcbiAqIHRvIGRhdGUgZnJvbSBTdGFzaCwgaW4gaXRzIG9iamVjdHMgYW5kIHRoZSBjYWNoZS4gTmV0d29yayBlcnJvcnMgY291bnQgYXMgXCJzdGlsbCB0aGVyZVwiLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdmVyaWZ5Q3VycmVudFBhaXIoKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIGNvbnN0IHsgbGVmdCwgcmlnaHQgfSA9IHN0YXRlLmN1cnJlbnRQYWlyO1xuICBpZiAoIWxlZnQgfHwgIXJpZ2h0KSByZXR1cm4gdHJ1ZTtcbiAgdHJ5IHtcbiAgICBjb25zdCBmcmVzaCA9IGF3YWl0IGZldGNoU2NlbmVGaWVsZHMoW2xlZnQuaWQsIHJpZ2h0LmlkXSk7XG4gICAgY29uc3QgZ29uZSA9IFtsZWZ0LCByaWdodF0uZmluZCgocykgPT4gIWZyZXNoLmhhcyhzLmlkKSk7XG4gICAgaWYgKGdvbmUpIHtcbiAgICAgIGNvbnNvbGUubG9nKGBbU3Rhc2ggQmF0dGxlXSDwn5G7IFNjZW5lICR7Z29uZS5pZH0gaW4gdGhlIGN1cnJlbnQgcGFpciBubyBsb25nZXIgZXhpc3RzYCk7XG4gICAgICBhd2FpdCBoYW5kbGVTY2VuZUdvbmUoZ29uZS5pZCk7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIGZvciAoY29uc3Qgc2NlbmUgb2YgW2xlZnQsIHJpZ2h0XSkge1xuICAgICAgY29uc3QgZmllbGRzID0gZnJlc2guZ2V0KHNjZW5lLmlkKTtcbiAgICAgIGlmICghZmllbGRzKSBjb250aW51ZTtcbiAgICAgIHNjZW5lLnJhdGluZzEwMCA9IGZpZWxkcy5yYXRpbmcxMDAgPz8gbnVsbDtcbiAgICAgIHNjZW5lLmN1c3RvbV9maWVsZHMgPSBmaWVsZHMuY3VzdG9tX2ZpZWxkcyA/PyB7fTtcbiAgICAgIHJlZnJlc2hTY2VuZUluQ2FjaGUoc2NlbmUpO1xuICAgIH1cbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnNvbGUud2FybihcIltTdGFzaCBCYXR0bGVdIENvdWxkIG5vdCB2ZXJpZnkgY3VycmVudCBwYWlyOlwiLCBlKTtcbiAgfVxuICByZXR1cm4gdHJ1ZTtcbn1cblxuLyoqIEZvcmdldCBhIHNjZW5lIGlkIHJlZmVyZW5jZWQgYnkgdGhlIGN1cnJlbnQgcnVuIChpdCBubyBsb25nZXIgZXhpc3RzKS4gKi9cbmZ1bmN0aW9uIGRyb3BGcm9tUnVuKHNjZW5lSWQ6IHN0cmluZyk6IHZvaWQge1xuICBzdGF0ZS5jaGFtcGlvbkRlZmVhdGVkID0gc3RhdGUuY2hhbXBpb25EZWZlYXRlZC5maWx0ZXIoKGlkKSA9PiBpZCAhPT0gc2NlbmVJZCk7XG4gIGNvbnN0IHJ1biA9IHN0YXRlLnBsYWNlbWVudDtcbiAgaWYgKCFydW4pIHJldHVybjtcbiAgaWYgKHJ1bi5hYm92ZUlkID09PSBzY2VuZUlkKSBydW4uYWJvdmVJZCA9IG51bGw7XG4gIGlmIChydW4uYmVsb3dJZCA9PT0gc2NlbmVJZCkgcnVuLmJlbG93SWQgPSBudWxsO1xuICBpZiAocnVuLmxhc3RPcHBvbmVudElkID09PSBzY2VuZUlkKSB7XG4gICAgcnVuLmxhc3RPcHBvbmVudElkID0gbnVsbDtcbiAgICBydW4uZ2FsbG9waW5nID0gZmFsc2U7XG4gIH1cbn1cblxuLyoqXG4gKiBBIHNjZW5lIGluIHBsYXkgbm8gbG9uZ2VyIGV4aXN0cy4gSWYgaXQgd2FzIHRoZSBzY2VuZSBiZWluZyByYXRlZC9wbGFjZWQvY2xpbWJpbmcsIHN0YXJ0IG92ZXI7XG4gKiBvdGhlcndpc2Uga2VlcCB0aGUgb3RoZXIgc2NlbmUgYW5kIGZpbmQgaXQgYSBuZXcgb3Bwb25lbnQuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBoYW5kbGVTY2VuZUdvbmUoc2NlbmVJZDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XG4gIGF3YWl0IHJlbW92ZVNjZW5lRXZlcnl3aGVyZShzY2VuZUlkKTtcblxuICBjb25zdCB7IGxlZnQsIHJpZ2h0IH0gPSBzdGF0ZS5jdXJyZW50UGFpcjtcbiAgY29uc3QgcnVuU2NlbmVJZHMgPSBbbGVmdD8uaWQsIHN0YXRlLnBsYWNlbWVudD8uc2NlbmUuaWQsIHN0YXRlLmNoYW1waW9uU2NlbmU/LmlkXTtcblxuICBpZiAocnVuU2NlbmVJZHMuaW5jbHVkZXMoc2NlbmVJZCkpIHtcbiAgICByZXNldFJ1blN0YXRlKCk7XG4gICAgc2F2ZVN0YXRlKCk7XG4gICAgYXdhaXQgbG9hZE5ld1BhaXIoKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBkcm9wRnJvbVJ1bihzY2VuZUlkKTtcbiAgc2F2ZVN0YXRlKCk7XG4gIC8vIEZvcmNlZCBsZWZ0IG9ubHkgYXBwbGllcyB3aGVuIG5vIHJ1biBpcyB1bmRlciB3YXkgKFN3aXNzLCBvciBiZWZvcmUgYSBDaGFtcGlvbiBydW4gc3RhcnRzKVxuICBjb25zdCBrZWVwSWQgPSByaWdodD8uaWQgPT09IHNjZW5lSWQgPyBsZWZ0Py5pZCA6IG51bGw7XG4gIGF3YWl0IGxvYWROZXdQYWlyKGtlZXBJZCA/PyBudWxsKTtcbn1cblxuLyoqIENsZWFuIG1vZGU6IFN0YXNoJ3Mgb3duIGRlbGV0ZSBkaWFsb2cgZG9lcyB0aGUgZGVsZXRpbmc7IHRoZW4gY29udGludWUgdGhlIGJhdHRsZSB3aXRob3V0IGl0LiAqL1xuYXN5bmMgZnVuY3Rpb24gZGVsZXRlRnJvbUJhdHRsZShzY2VuZTogU2NlbmUpOiBQcm9taXNlPHZvaWQ+IHtcbiAgaWYgKHN0YXRlLmRpc2FibGVDaG9pY2UpIHJldHVybjtcbiAgY29uc3QgZGVsZXRlZCA9IGF3YWl0IGNvbmZpcm1EZWxldGVTY2VuZShzY2VuZSk7XG4gIGlmICghZGVsZXRlZCkgcmV0dXJuO1xuXG4gIHN0YXRlLmRpc2FibGVDaG9pY2UgPSB0cnVlO1xuICBhd2FpdCBoYW5kbGVTY2VuZUdvbmUoc2NlbmUuaWQpO1xufVxuXG4vKiogRUxPIHVzZWQgaW4gYmF0dGxlIG1hdGg6IHVucmF0ZWQgc2NlbmVzIGNvdW50IGFzIEVMT19TVEFSVCAoMTUwMCkgaW4gU3dpc3MsIENIQU1QSU9OX1VOUkFURURfRUxPIGluIENoYW1waW9uLiAqL1xuZnVuY3Rpb24gYmF0dGxlRWxvKHNjZW5lOiBTY2VuZSk6IG51bWJlciB7XG4gIHJldHVybiBzdGF0ZS5jdXJyZW50TW9kZSA9PT0gXCJjaGFtcGlvblwiID8gZWZmZWN0aXZlRWxvKHNjZW5lLCBDSEFNUElPTl9VTlJBVEVEX0VMTykgOiBlZmZlY3RpdmVFbG8oc2NlbmUpO1xufVxuXG5pbnRlcmZhY2UgRWxvQ2hhbmdlIHtcbiAgZnJvbTogbnVtYmVyO1xuICB0bzogbnVtYmVyO1xufVxuXG4vKipcbiAqIFR3by1zaWRlZCBFTE8gZm9yIGEgcGljayAoU3dpc3MgYW5kIENoYW1waW9uKTogYm90aCBzY2VuZXMnIEVMTyBhbmQgYmF0dGxlcyBjaGFuZ2UgYW5kIGFyZVxuICogc2F2ZWQuIGB1cHNldGAgaXMgdHJ1ZSB3aGVuIHRoZSB3aW5uZXIgd2FzIGEgcmVhbCB1bmRlcmRvZyAoc2VlIFVQU0VUX01BWF9DSEFOQ0UpLlxuICovXG5mdW5jdGlvbiByZXNvbHZlQ29tcGFyaXNvbih3aW5uZXI6IFNjZW5lLCBsb3NlcjogU2NlbmUpOiB7IHdpbm5lcjogRWxvQ2hhbmdlOyBsb3NlcjogRWxvQ2hhbmdlOyB1cHNldDogYm9vbGVhbiB9IHtcbiAgLy8gVGhlIG1hdGggcmVhZHMgdGhlIGNhY2hlZCBjb3BpZXM6IHRoZSBwYWlyJ3Mgb3duIG9iamVjdHMgbWF5IHByZWRhdGUgYSBiYWNrZ3JvdW5kIHJlZnJlc2hcbiAgY29uc3QgbGF0ZXN0V2lubmVyID0gbGF0ZXN0U2NlbmUod2lubmVyKTtcbiAgY29uc3QgbGF0ZXN0TG9zZXIgPSBsYXRlc3RTY2VuZShsb3Nlcik7XG4gIGNvbnN0IHdpbm5lclNpZGUgPSB7IGVsbzogYmF0dGxlRWxvKGxhdGVzdFdpbm5lciksIGtHYW1lczoga0dhbWVzKGxhdGVzdFdpbm5lcikgfTtcbiAgY29uc3QgbG9zZXJTaWRlID0geyBlbG86IGJhdHRsZUVsbyhsYXRlc3RMb3NlciksIGtHYW1lczoga0dhbWVzKGxhdGVzdExvc2VyKSB9O1xuICBjb25zdCByZXN1bHQgPSBlbG9SZXN1bHQod2lubmVyU2lkZSwgbG9zZXJTaWRlKTtcblxuICB2b2lkIHdyaXRlRWxvKHdpbm5lciwgcmVzdWx0Lndpbm5lciwgYmF0dGxlcyhsYXRlc3RXaW5uZXIpICsgMSk7XG4gIHZvaWQgd3JpdGVFbG8obG9zZXIsIHJlc3VsdC5sb3NlciwgYmF0dGxlcyhsYXRlc3RMb3NlcikgKyAxKTtcblxuICByZXR1cm4ge1xuICAgIHdpbm5lcjogeyBmcm9tOiB3aW5uZXJTaWRlLmVsbywgdG86IHJlc3VsdC53aW5uZXIgfSxcbiAgICBsb3NlcjogeyBmcm9tOiBsb3NlclNpZGUuZWxvLCB0bzogcmVzdWx0Lmxvc2VyIH0sXG4gICAgdXBzZXQ6IHdpbkNoYW5jZXMod2lubmVyU2lkZS5lbG8sIGxvc2VyU2lkZS5lbG8pWzBdIDw9IFVQU0VUX01BWF9DSEFOQ0UsXG4gIH07XG59XG5cbi8qKiBTaG93IHdoZW4gQ2hhbXBpb24gKyBmaWx0ZXIgb3Bwb25lbnRzICsgc21hbGwgZmlsdGVyZWQgcG9vbC4gKi9cbmV4cG9ydCBmdW5jdGlvbiB1cGRhdGVDbGltYlBvb2xXYXJuaW5nKCk6IHZvaWQge1xuICBjb25zdCB3YXJuaW5nID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzYi1jbGltYi1wb29sLXdhcm5pbmdcIik7XG4gIGlmICghd2FybmluZykgcmV0dXJuO1xuXG4gIGNvbnN0IGlzQ2xpbWIgPSBzdGF0ZS5jdXJyZW50TW9kZSA9PT0gXCJjaGFtcGlvblwiO1xuICBjb25zdCBmaWx0ZXJzID0gcmVhZEZpbHRlcnMoKTtcbiAgY29uc3Qgc21hbGxQb29sID1cbiAgICBzdGF0ZS50b3RhbFNjZW5lc0NvdW50ID4gMCAmJiBzdGF0ZS50b3RhbFNjZW5lc0NvdW50IDwgQ0xJTUJfU01BTExfUE9PTF9XQVJOX0FUO1xuXG4gIHdhcm5pbmcuaGlkZGVuID0gIShcbiAgICBpc0NsaW1iICYmXG4gICAgc3RhdGUuc2V0dGluZ3MuZmlsdGVyT3Bwb25lbnRzICYmXG4gICAgZmlsdGVycy5maWx0ZXJBY3RpdmUgJiZcbiAgICBzbWFsbFBvb2xcbiAgKTtcbn1cblxuLyoqIFBsYWNlbWVudDogcmVjb3JkIHRoZSByZXN1bHQ7IHRoZSBuZXh0IHBhaXIgKG9yIHRoZSBmaW5hbCBwbGFjZW1lbnQpIGNvbWVzIGZyb20gdGhlIGZldGNoLiAqL1xuZnVuY3Rpb24gaGFuZGxlUGxhY2VtZW50Q2hvaWNlKGNob2ljZTogU2NlbmVDaG9pY2UpOiB2b2lkIHtcbiAgY29uc3QgcnVuID0gc3RhdGUucGxhY2VtZW50O1xuICBpZiAoIXJ1bikge1xuICAgIHN0YXRlLmRpc2FibGVDaG9pY2UgPSBmYWxzZTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCB3b24gPSBjaG9pY2Uud2lubmVyLmlkID09PSBydW4uc2NlbmUuaWQ7XG4gIHJlY29yZFBsYWNlbWVudFJlc3VsdChydW4sIHdvbiwgd29uID8gY2hvaWNlLmxvc2VyLmlkIDogY2hvaWNlLndpbm5lci5pZCk7XG4gIHNhdmVTdGF0ZSgpO1xuXG4gIGNob2ljZS53aW5uZXJDYXJkLmNsYXNzTGlzdC5hZGQoXCJzYi13aW5uZXJcIik7XG4gIGNob2ljZS5sb3NlckNhcmQuY2xhc3NMaXN0LmFkZChcInNiLWxvc2VyXCIpO1xuICBzZXRUaW1lb3V0KCgpID0+IGxvYWROZXdQYWlyKCksIDYwMCk7XG59XG5cbi8qKiBDaGFtcGlvbjogdHdvLXNpZGVkIEVMTyBldmVyeSBwaWNrOyB0aGUgd2lubmVyIGRlZmVuZHMgbmV4dCAoYSBuZXcgd2lubmVyIHRha2VzIG92ZXIpLiAqL1xuZnVuY3Rpb24gaGFuZGxlQ2hhbXBpb25DaG9pY2UoY2hvaWNlOiBTY2VuZUNob2ljZSk6IHZvaWQge1xuICBjb25zdCB7IHdpbm5lcjogd2lubmVyU2NlbmUsIGxvc2VyOiBsb3NlclNjZW5lLCBsZWZ0LCB3aW5uZXJDYXJkLCBsb3NlckNhcmQgfSA9IGNob2ljZTtcblxuICBpZiAoIXN0YXRlLmNoYW1waW9uU2NlbmUpIHN0YXRlLmNoYW1waW9uU2NlbmUgPSBsZWZ0O1xuICBjb25zdCBjaGFuZ2UgPSByZXNvbHZlQ29tcGFyaXNvbih3aW5uZXJTY2VuZSwgbG9zZXJTY2VuZSk7XG5cbiAgaWYgKHdpbm5lclNjZW5lLmlkID09PSBzdGF0ZS5jaGFtcGlvblNjZW5lLmlkKSB7XG4gICAgc3RhdGUuY2hhbXBpb25EZWZlYXRlZC5wdXNoKGxvc2VyU2NlbmUuaWQpO1xuICAgIHN0YXRlLmNoYW1waW9uV2lucysrO1xuICB9IGVsc2Uge1xuICAgIHN0YXRlLmNoYW1waW9uU2NlbmUgPSB3aW5uZXJTY2VuZTtcbiAgICBzdGF0ZS5jaGFtcGlvbkRlZmVhdGVkID0gW2xvc2VyU2NlbmUuaWRdO1xuICAgIHN0YXRlLmNoYW1waW9uV2lucyA9IDE7XG4gIH1cblxuICBzYXZlU3RhdGUoKTtcblxuICBzaG93UGlja1Jlc3VsdCh3aW5uZXJDYXJkLCBsb3NlckNhcmQsIGNoYW5nZSk7XG59XG5cbi8qKiBXaW5uZXIvbG9zZXIgY2FyZCBzdHlsZXMgYW5kIGJvdGggRUxPIGFuaW1hdGlvbnMsIHRoZW4gdGhlIG5leHQgcGFpci4gKi9cbmZ1bmN0aW9uIHNob3dQaWNrUmVzdWx0KFxuICB3aW5uZXJDYXJkOiBIVE1MRWxlbWVudCxcbiAgbG9zZXJDYXJkOiBIVE1MRWxlbWVudCxcbiAgY2hhbmdlOiB7IHdpbm5lcjogRWxvQ2hhbmdlOyBsb3NlcjogRWxvQ2hhbmdlOyB1cHNldDogYm9vbGVhbiB9LFxuKTogdm9pZCB7XG4gIHdpbm5lckNhcmQuY2xhc3NMaXN0LmFkZChcInNiLXdpbm5lclwiKTtcbiAgbG9zZXJDYXJkLmNsYXNzTGlzdC5hZGQoXCJzYi1sb3NlclwiKTtcbiAgc2hvd1JhdGluZ0FuaW1hdGlvbih3aW5uZXJDYXJkLCBjaGFuZ2Uud2lubmVyLmZyb20sIGNoYW5nZS53aW5uZXIudG8sIHRydWUsIGNoYW5nZS51cHNldCk7XG4gIHNob3dSYXRpbmdBbmltYXRpb24obG9zZXJDYXJkLCBjaGFuZ2UubG9zZXIuZnJvbSwgY2hhbmdlLmxvc2VyLnRvLCBmYWxzZSk7XG4gIHNjaGVkdWxlTmV4dFBhaXJBZnRlckFuaW1hdGlvbnMoKTtcbn1cblxuZnVuY3Rpb24gaGFuZGxlU2NlbmVDaG9pY2UoY2hvaWNlOiBTY2VuZUNob2ljZSk6IHZvaWQge1xuICBpZiAoc3RhdGUuZGlzYWJsZUNob2ljZSkgcmV0dXJuO1xuICBzdGF0ZS5kaXNhYmxlQ2hvaWNlID0gdHJ1ZTtcblxuICBjb25zdCB7IHdpbm5lcjogd2lubmVyU2NlbmUsIGxvc2VyOiBsb3NlclNjZW5lLCB3aW5uZXJDYXJkLCBsb3NlckNhcmQgfSA9IGNob2ljZTtcblxuICBpZiAoc3RhdGUuY3VycmVudE1vZGUgPT09IFwicGxhY2VtZW50XCIpIHtcbiAgICBoYW5kbGVQbGFjZW1lbnRDaG9pY2UoY2hvaWNlKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBpZiAoc3RhdGUuY3VycmVudE1vZGUgPT09IFwiY2hhbXBpb25cIikge1xuICAgIGhhbmRsZUNoYW1waW9uQ2hvaWNlKGNob2ljZSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gU3dpc3M6IGJvdGggc2NlbmVzJyBFTE8gY2hhbmdlcyAoYm90aCBzdGF5IGluIHRoZSBwb29sKVxuICBjb25zdCBjaGFuZ2UgPSByZXNvbHZlQ29tcGFyaXNvbih3aW5uZXJTY2VuZSwgbG9zZXJTY2VuZSk7XG5cbiAgc2F2ZVN0YXRlKCk7XG5cbiAgc2hvd1BpY2tSZXN1bHQod2lubmVyQ2FyZCwgbG9zZXJDYXJkLCBjaGFuZ2UpO1xufVxuXG5jb25zdCBSQVRJTkdfQU5JTV9NQVhfVE9UQUxfTVMgPSAxNDAwO1xuY29uc3QgUkFUSU5HX0FOSU1fSE9MRF9NUyA9IDMwMDtcbmNvbnN0IFJBVElOR19BTklNX0NPVU5UX0JVREdFVF9NUyA9IFJBVElOR19BTklNX01BWF9UT1RBTF9NUyAtIFJBVElOR19BTklNX0hPTERfTVM7XG5jb25zdCBSQVRJTkdfQU5JTV9ERUZBVUxUX1NURVBfTVMgPSA1MDtcbmNvbnN0IFJBVElOR19BTklNX01JTl9TVEVQX01TID0gODtcblxuZnVuY3Rpb24gc2NoZWR1bGVOZXh0UGFpckFmdGVyQW5pbWF0aW9ucygpOiB2b2lkIHtcbiAgc2V0VGltZW91dCgoKSA9PiBsb2FkTmV3UGFpcigpLCAxNTAwKTtcbn1cblxuLyoqXG4gKiBFTE8gY291bnQtdXAvZG93biBvdmVybGF5ICh3aG9sZSBudW1iZXJzKTsgbGFyZ2UganVtcHMgc3BlZWQgdXAgc28gdGhlIGNvdW50IGZpdHMgd2l0aGluIDE0MDBtcy5cbiAqIGB1cHNldGAgYWRkcyBhIHNtYWxsIFwiVXBzZXQhXCIgdW5kZXIgdGhlIGNoYW5nZS5cbiAqL1xuZnVuY3Rpb24gc2hvd1JhdGluZ0FuaW1hdGlvbihcbiAgY2FyZDogSFRNTEVsZW1lbnQsXG4gIG9sZEVsbzogbnVtYmVyLFxuICBuZXdFbG86IG51bWJlcixcbiAgaXNXaW5uZXI6IGJvb2xlYW4sXG4gIHVwc2V0ID0gZmFsc2UsXG4pOiB2b2lkIHtcbiAgY29uc3Qgb2xkUmF0aW5nID0gTWF0aC5yb3VuZChvbGRFbG8pO1xuICBjb25zdCBuZXdSYXRpbmcgPSBNYXRoLnJvdW5kKG5ld0Vsbyk7XG4gIGNvbnN0IGNoYW5nZSA9IG5ld1JhdGluZyAtIG9sZFJhdGluZztcbiAgLy8gQ3JlYXRlIG92ZXJsYXlcbiAgY29uc3Qgb3ZlcmxheSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gIG92ZXJsYXkuY2xhc3NOYW1lID0gYHNiLXJhdGluZy1vdmVybGF5ICR7aXNXaW5uZXIgPyBcInNiLXJhdGluZy13aW5uZXJcIiA6IFwic2ItcmF0aW5nLWxvc2VyXCJ9YDtcblxuICBjb25zdCByYXRpbmdEaXNwbGF5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgcmF0aW5nRGlzcGxheS5jbGFzc05hbWUgPSBcInNiLXJhdGluZy1kaXNwbGF5XCI7XG4gIHJhdGluZ0Rpc3BsYXkudGV4dENvbnRlbnQgPSBTdHJpbmcob2xkUmF0aW5nKTtcblxuICBjb25zdCBjaGFuZ2VEaXNwbGF5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgY2hhbmdlRGlzcGxheS5jbGFzc05hbWUgPSBcInNiLXJhdGluZy1jaGFuZ2VcIjtcbiAgY2hhbmdlRGlzcGxheS50ZXh0Q29udGVudCA9IGNoYW5nZSA+IDAgPyBgKyR7Y2hhbmdlfWAgOiBTdHJpbmcoY2hhbmdlKTtcblxuICBvdmVybGF5LmFwcGVuZENoaWxkKHJhdGluZ0Rpc3BsYXkpO1xuICBvdmVybGF5LmFwcGVuZENoaWxkKGNoYW5nZURpc3BsYXkpO1xuICBpZiAodXBzZXQpIHtcbiAgICBjb25zdCB1cHNldERpc3BsYXkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICAgIHVwc2V0RGlzcGxheS5jbGFzc05hbWUgPSBcInNiLXJhdGluZy11cHNldFwiO1xuICAgIHVwc2V0RGlzcGxheS50ZXh0Q29udGVudCA9IFwiVXBzZXQhXCI7XG4gICAgb3ZlcmxheS5hcHBlbmRDaGlsZCh1cHNldERpc3BsYXkpO1xuICB9XG4gIGNhcmQuYXBwZW5kQ2hpbGQob3ZlcmxheSk7XG5cbiAgY29uc3QgdG90YWxTdGVwcyA9IE1hdGguYWJzKGNoYW5nZSk7XG4gIGlmICh0b3RhbFN0ZXBzID09PSAwKSB7XG4gICAgcmF0aW5nRGlzcGxheS50ZXh0Q29udGVudCA9IFN0cmluZyhuZXdSYXRpbmcpO1xuICAgIHNldFRpbWVvdXQoKCkgPT4gb3ZlcmxheS5yZW1vdmUoKSwgUkFUSU5HX0FOSU1fTUFYX1RPVEFMX01TKTtcbiAgICByZXR1cm47XG4gIH1cblxuICBjb25zdCBzdGVwTXMgPSBNYXRoLm1pbihcbiAgICBSQVRJTkdfQU5JTV9ERUZBVUxUX1NURVBfTVMsXG4gICAgTWF0aC5tYXgoUkFUSU5HX0FOSU1fTUlOX1NURVBfTVMsIE1hdGgucm91bmQoUkFUSU5HX0FOSU1fQ09VTlRfQlVER0VUX01TIC8gdG90YWxTdGVwcykpLFxuICApO1xuXG4gIGxldCBjdXJyZW50RGlzcGxheSA9IG9sZFJhdGluZztcbiAgY29uc3Qgc3RlcCA9IGNoYW5nZSA+IDAgPyAxIDogLTE7XG4gIGxldCBzdGVwQ291bnQgPSAwO1xuXG4gIGNvbnN0IGludGVydmFsID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgIHN0ZXBDb3VudCsrO1xuICAgIGN1cnJlbnREaXNwbGF5ICs9IHN0ZXA7XG4gICAgcmF0aW5nRGlzcGxheS50ZXh0Q29udGVudCA9IFN0cmluZyhjdXJyZW50RGlzcGxheSk7XG5cbiAgICBpZiAoc3RlcENvdW50ID49IHRvdGFsU3RlcHMpIHtcbiAgICAgIGNsZWFySW50ZXJ2YWwoaW50ZXJ2YWwpO1xuICAgICAgcmF0aW5nRGlzcGxheS50ZXh0Q29udGVudCA9IFN0cmluZyhuZXdSYXRpbmcpO1xuICAgIH1cbiAgfSwgc3RlcE1zKTtcblxuICBzZXRUaW1lb3V0KCgpID0+IG92ZXJsYXkucmVtb3ZlKCksIFJBVElOR19BTklNX01BWF9UT1RBTF9NUyk7XG59XG4iLCAiLy8gU2hhcmVkIGljb25zLlxuXG4vKiogVGhlIGNyb3NzZWQgc3dvcmRzICgzNngzNiwgZmlsbGVkIHdpdGggY3VycmVudENvbG9yKTogdGhlIG5hdmJhciBidXR0b24gYW5kIHRoZSBzY2VuZSBwYWdlJ3MgRUxPLiAqL1xuZXhwb3J0IGNvbnN0IFNXT1JEU19QQVRIUyA9IGBcbiAgPHBhdGggZmlsbD1cImN1cnJlbnRDb2xvclwiIGQ9XCJtMjQgMjkgNS01TDYgMUgxdjV6XCIvPlxuICA8cGF0aCBmaWxsPVwiY3VycmVudENvbG9yXCIgZD1cIk0xIDF2NWwyMyAyMyAyLjUtMi41elwiLz5cbiAgPHBhdGggZmlsbD1cImN1cnJlbnRDb2xvclwiIGQ9XCJNMzMuNDI0IDMyLjgwOGMuMjg0LS4yODQuNDU4LS42MjYuNTMxLS45NjhsLTUuMjQyLTYuMTk1LS43LS43MDJjLS41NjUtLjU2NC0xLjU3LS40NzMtMi4yNDkuMjA1bC0uNjE0LjYxMmMtLjY3Ny42NzctLjc2OCAxLjY4My0uMjA0IDIuMjQ3bC43NDEuNzQxIDYuMTUgNS4yMDVjLjM0NS0uMDcyLjY4OC0uMjQ3Ljk3NC0uNTMyelwiLz5cbiAgPHBhdGggZmlsbD1cImN1cnJlbnRDb2xvclwiIGQ9XCJNMzMuNDI0IDMyLjgwOGMuMjg0LS4yODQuNDU4LS42MjYuNTMxLS45NjhsLTEuMzQyLTEuNTg2LS43MzcgMy42ODRjLjMzMS0uMDc3LjY2MS0uMjQzLjkzNS0uNTE4em0tMy4zMS01LjUwNi0uODg4IDQuNDQgMS4yNiAxLjA2Ny44Mi00LjF6bS0xLjQtMS42NTctLjcwMi0uNzAyYTEuMiAxLjIgMCAwIDAtLjMyNi0uMjI0bC0uOTc4IDQuODkyIDEuMjYgMS4wNjYuOTU3LTQuNzgzem0tMi40MDItLjg4OGEyIDIgMCAwIDAtLjU0OC4zOTJsLS42MTQuNjFhMiAyIDAgMCAwLS41MS44NmMtLjE0My41MS0uMDQ3IDEuMDM2LjMwNiAxLjM4OGwuNTk2LjU5NnptMCAwcTAtLjAwMyAwIDBcIi8+XG4gIDxwYXRoIGZpbGw9XCJjdXJyZW50Q29sb3JcIiBkPVwiTTMzLjI1IDM2YTIuNzUgMi43NSAwIDEgMCAwLTUuNSAyLjc1IDIuNzUgMCAwIDAgMCA1LjVNMjkuNjI2IDIyLjMyNGExLjAzNCAxLjAzNCAwIDAgMSAwIDEuNDYybC02LjA5MiA2LjA5MmExLjAzMiAxLjAzMiAwIDAgMS0xLjY4Ni0uMzM2IDEuMDMgMS4wMyAwIDAgMSAuMjI0LTEuMTI2bDYuMDkyLTYuMDkyYTEuMDMzIDEuMDMzIDAgMCAxIDEuNDYyIDBcIi8+XG4gIDxwYXRoIGZpbGw9XCJjdXJyZW50Q29sb3JcIiBkPVwiTTIyLjA3MiAzMS42MjdhMS43NSAxLjc1IDAgMSAwIDAtMy41IDEuNzUgMS43NSAwIDAgMCAwIDMuNU0yOS42MjYgMjQuMDczYTEuNzUgMS43NSAwIDEgMCAwLTMuNSAxLjc1IDEuNzUgMCAwIDAgMCAzLjVcIi8+XG4gIDxwYXRoIGZpbGw9XCJjdXJyZW50Q29sb3JcIiBkPVwiTTIyLjA3MiAzMC44NzdhMSAxIDAgMSAwIDAtMiAxIDEgMCAwIDAgMCAyTTI5LjYyNiAyMy4zMjNhMSAxIDAgMSAwIDAtMiAxIDEgMCAwIDAgMCAyTTMzLjkwMyAyOS4zNDJhLjc2Ljc2IDAgMCAxIDAgMS4wNzhsLTMuNDc2IDMuNDc1YS43NjIuNzYyIDAgMCAxLTEuMDc4LTEuMDc4bDMuNDc2LTMuNDc1YS43Ni43NiAwIDAgMSAxLjA3OCAwTTEyIDI5bC01LTVMMzAgMWg1djV6XCIvPlxuICA8cGF0aCBmaWxsPVwiY3VycmVudENvbG9yXCIgZD1cIk0zNSAxdjVMMTIgMjlsLTIuNS0yLjV6XCIvPlxuICA8cGF0aCBmaWxsPVwiY3VycmVudENvbG9yXCIgZD1cIk0yLjU3NiAzMi44MDhhMS45NSAxLjk1IDAgMCAxLS41MzEtLjk2OGw1LjI0Mi02LjE5NS43LS43MDJjLjU2NS0uNTY0IDEuNTctLjQ3MyAyLjI0OS4yMDVsLjYxMy42MTJjLjY3Ny42NzcuNzY4IDEuNjgzLjIwNCAyLjI0N2wtLjc0MS43NDEtNi4xNSA1LjIwNWExLjk1IDEuOTUgMCAwIDEtLjk3NC0uNTMyelwiLz5cbiAgPHBhdGggZmlsbD1cImN1cnJlbnRDb2xvclwiIGQ9XCJNMi41NzYgMzIuODA4YTEuOTUgMS45NSAwIDAgMS0uNTMxLS45NjhsMS4zNDItMS41ODYuNzM3IDMuNjg0YTEuOTMgMS45MyAwIDAgMS0uOTM1LS41MTh6bTMuMzEtNS41MDYuODg4IDQuNDQtMS4yNiAxLjA2Ny0uODItNC4xem0xLjQtMS42NTcuNzAyLS43MDJhMS4yIDEuMiAwIDAgMSAuMzI2LS4yMjRsLjk3OCA0Ljg5Mi0xLjI2IDEuMDY2LS45NTctNC43ODN6bTIuNDAyLS44ODhjLjE5NS4wOTUuMzgyLjIyNS41NDguMzkybC42MTMuNjEyYy4yNTQuMjU0LjQyNS41NTQuNTEuODYuMTQzLjUxLjA0NyAxLjAzNS0uMzA2IDEuMzg3bC0uNTk2LjU5NnptMCAwcTAtLjAwMyAwIDBcIi8+XG4gIDxwYXRoIGZpbGw9XCJjdXJyZW50Q29sb3JcIiBkPVwiTTIuNzUgMzZhMi43NSAyLjc1IDAgMSAwIDAtNS41IDIuNzUgMi43NSAwIDAgMCAwIDUuNU02LjM3NCAyMi4zMjRhMS4wMzQgMS4wMzQgMCAwIDAgMCAxLjQ2Mmw2LjA5MiA2LjA5MmExLjAzMyAxLjAzMyAwIDEgMCAxLjQ2Mi0xLjQ2MmwtNi4wOTItNi4wOTJhMS4wMzMgMS4wMzMgMCAwIDAtMS40NjIgMFwiLz5cbiAgPHBhdGggZmlsbD1cImN1cnJlbnRDb2xvclwiIGQ9XCJNMTMuOTI4IDMxLjYyN2ExLjc1IDEuNzUgMCAxIDAgMC0zLjUgMS43NSAxLjc1IDAgMCAwIDAgMy41TTYuMzc0IDI0LjA3M2ExLjc1IDEuNzUgMCAxIDAgMC0zLjUgMS43NSAxLjc1IDAgMCAwIDAgMy41XCIvPlxuICA8cGF0aCBmaWxsPVwiY3VycmVudENvbG9yXCIgZD1cIk0xMy45MjggMzAuODc3YTEgMSAwIDEgMCAwLTIgMSAxIDAgMCAwIDAgMk02LjM3NCAyMy4zMjNhMSAxIDAgMSAwIDAtMiAxIDEgMCAwIDAgMCAyTTIuMDk3IDI5LjM0MmEuNzYuNzYgMCAwIDAgMCAxLjA3OGwzLjQ3NiAzLjQ3NWEuNzYzLjc2MyAwIDAgMCAxLjA3OC0xLjA3OGwtMy40NzYtMy40NzVhLjc2Ljc2IDAgMCAwLTEuMDc4IDBcIi8+XG5gO1xuIiwgIi8vIFRoZSBzY2VuZSdzIEVMTyBhbmQgcmFuayBvbiBTdGFzaCdzIG93biBzY2VuZSBwYWdlLCBhcyBvbmUgbW9yZSBpdGVtIGluIHRoZSB0b29sYmFyIG5leHQgdG9cbi8vIFBsYXkgQ291bnQgYW5kIE8gQ291bnQ6IGEgc2luZ2xlIFN0YXNoIFwibWluaW1hbFwiIGJ1dHRvbiAoaWNvbiBhbmQgdGV4dCBoaWdobGlnaHQgdG9nZXRoZXIpLlxuLy9cbi8vIFN0YXNoJ3MgU2NlbmVQYWdlIGlzbid0IGEgcGF0Y2hhYmxlIGNvbXBvbmVudCwgc28gdGhlIGl0ZW0gaXMgYWRkZWQgdG8gdGhlIERPTSBhbmQgcmUtYWRkZWRcbi8vIHdoZW5ldmVyIFJlYWN0IHJlLXJlbmRlcnMgdGhlIHRvb2xiYXIuIFRoZSByYW5rIGNvbWVzIGZyb20gU3Rhc2ggQmF0dGxlJ3MgYWxsLXNjZW5lcyBjYWNoZSwgdGhlXG4vLyBzYW1lIHBsYWNlIHRoZSBiYXR0bGUgY2FyZHMgZ2V0IHRoZWlycyAoU3Rhc2ggY2FuJ3QgY291bnQgc2NlbmVzIGJ5IGEgbnVtZXJpYyBjdXN0b20gZmllbGQpLlxuXG5pbXBvcnQgeyBnZXRBbGxTY2VuZXNDYWNoZWQgfSBmcm9tIFwiLi4vY2FjaGVcIjtcbmltcG9ydCB7IGZldGNoU2NlbmVCeUlkLCBnZXRTY2VuZUlkRnJvbVVybCwgc2NlbmVDdXN0b21GaWVsZHNTdXBwb3J0ZWQgfSBmcm9tIFwiLi4vZ3JhcGhxbFwiO1xuaW1wb3J0IHsgZWxvLCBpc1Byb3Zpc2lvbmFsLCBpc1JhdGVkIH0gZnJvbSBcIi4uL3Njb3JlXCI7XG5pbXBvcnQgeyBsb2FkU2V0dGluZ3MgfSBmcm9tIFwiLi4vc2V0dGluZ3NcIjtcbmltcG9ydCB7IHN0YXRlIH0gZnJvbSBcIi4uL3N0YXRlXCI7XG5pbXBvcnQgeyB0aWVyRGVzY3JpcHRpb24sIHRpZXJNYXAgfSBmcm9tIFwiLi4vc3RhdHNcIjtcbmltcG9ydCB0eXBlIHsgU2NlbmUsIFRpZXIgfSBmcm9tIFwiLi4vdHlwZXNcIjtcbmltcG9ydCB7IFNXT1JEU19QQVRIUyB9IGZyb20gXCIuL2ljb25zXCI7XG5pbXBvcnQgeyBQUk9WSVNJT05BTF9USVAgfSBmcm9tIFwiLi9zY2VuZUNhcmRcIjtcblxuY29uc3QgSVRFTV9DTEFTUyA9IFwic2Itc2NlbmUtZWxvXCI7XG5jb25zdCBUSVRMRSA9IFwiU3Rhc2ggQmF0dGxlIEVMTywgYW5kIHJhbmsgaW4geW91ciBsaWJyYXJ5LiBDbGljayB0byBiYXR0bGUgdGhpcyBzY2VuZS5cIjtcblxuLyoqIFwiRUxPIDE3NDAgwrcgIzUwXCIgKGEgXCI/XCIgYWZ0ZXIgYSBwcm92aXNpb25hbCBFTE8pLCBvciBcIkVMTyDCtyBVbnJhdGVkXCIgZm9yIGEgc2NlbmUgd2l0aCBubyBFTE8geWV0LiAqL1xuZnVuY3Rpb24gbGFiZWxUZXh0KHNjZW5lOiBTY2VuZSwgcmFuazogbnVtYmVyIHwgbnVsbCk6IHN0cmluZyB7XG4gIGNvbnN0IHZhbHVlID0gZWxvKHNjZW5lKTtcbiAgaWYgKHZhbHVlID09PSBudWxsKSByZXR1cm4gXCJFTE8gwrcgVW5yYXRlZFwiO1xuICByZXR1cm4gYEVMTyAke01hdGgucm91bmQodmFsdWUpfSR7aXNQcm92aXNpb25hbChzY2VuZSkgPyBcIj9cIiA6IFwiXCJ9JHtyYW5rICE9PSBudWxsID8gYCDCtyAjJHtyYW5rfWAgOiBcIlwifWA7XG59XG5cbi8qKiBUaGUgYnV0dG9uJ3MgdG9vbHRpcCwgd2l0aCB0aGUgcHJvdmlzaW9uYWwgbm90ZSBhbmQgdGhlIHRpZXIgKHdoZW4gdGllcnMgYXJlIG9uKSBhZGRlZC4gKi9cbmZ1bmN0aW9uIHRpdGxlVGV4dChzY2VuZTogU2NlbmUsIHRpZXI6IFRpZXIgfCBudWxsKTogc3RyaW5nIHtcbiAgY29uc3QgbGluZXMgPSBbVElUTEVdO1xuICBpZiAoaXNQcm92aXNpb25hbChzY2VuZSkpIGxpbmVzLnB1c2goUFJPVklTSU9OQUxfVElQKTtcbiAgaWYgKHRpZXIgJiYgc3RhdGUuc2V0dGluZ3Muc2hvd1RpZXJzKSBsaW5lcy5wdXNoKGAke3RpZXIuZW1vaml9ICR7dGllckRlc2NyaXB0aW9uKHRpZXIpfWApO1xuICByZXR1cm4gbGluZXMuam9pbihcIlxcblwiKTtcbn1cblxuLyoqXG4gKiBUaGUgc2NlbmUgKGZyb20gdGhlIGNhY2hlLCBvciBmZXRjaGVkIGlmIGl0J3MgbmV3ZXIgdGhhbiB0aGUgY2FjaGUpLCBpdHMgcmFuayBhbW9uZyByYXRlZFxuICogc2NlbmVzIGFuZCBpdHMgdGllci5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gc2NlbmVBbmRSYW5rKHNjZW5lSWQ6IHN0cmluZyk6IFByb21pc2U8eyBzY2VuZTogU2NlbmU7IHJhbms6IG51bWJlciB8IG51bGw7IHRpZXI6IFRpZXIgfCBudWxsIH0gfCBudWxsPiB7XG4gIGNvbnN0IHsgc2NlbmVzIH0gPSBhd2FpdCBnZXRBbGxTY2VuZXNDYWNoZWQoKTtcbiAgLy8gVGhlIGNhY2hlIGlzIHNvcnRlZCBieSBFTE8gd2l0aCB1bnJhdGVkIHNjZW5lcyBsYXN0LCBzbyBhIHJhdGVkIHNjZW5lJ3MgaW5kZXggaXMgaXRzIHJhbmtcbiAgY29uc3QgaW5kZXggPSBzY2VuZXMuZmluZEluZGV4KChzKSA9PiBzLmlkID09PSBzY2VuZUlkKTtcbiAgaWYgKGluZGV4ID49IDApIHtcbiAgICBjb25zdCBzY2VuZSA9IHNjZW5lc1tpbmRleF07XG4gICAgcmV0dXJuIHsgc2NlbmUsIHJhbms6IGlzUmF0ZWQoc2NlbmUpID8gaW5kZXggKyAxIDogbnVsbCwgdGllcjogdGllck1hcChzY2VuZXMpLmdldChzY2VuZUlkKSA/PyBudWxsIH07XG4gIH1cbiAgY29uc3Qgc2NlbmUgPSBhd2FpdCBmZXRjaFNjZW5lQnlJZChzY2VuZUlkKTtcbiAgcmV0dXJuIHNjZW5lID8geyBzY2VuZSwgcmFuazogbnVsbCwgdGllcjogbnVsbCB9IDogbnVsbDtcbn1cblxuLyoqIFNldHRpbmdzIGxvYWQgd2l0aCBTdGFzaCBCYXR0bGU7IG9uIGEgc2NlbmUgcGFnZSBpdCBtYXkgbm90IGhhdmUgb3BlbmVkIHlldCAob25jZSBwZXIgcGFnZSBsb2FkKS4gKi9cbmxldCBzZXR0aW5nc0xvYWQ6IFByb21pc2U8Ym9vbGVhbj4gfCBudWxsID0gbnVsbDtcblxuLyoqIE9wZW5zIFN0YXNoIEJhdHRsZSAob24gYSBzY2VuZSBwYWdlLCB3aXRoIHRoaXMgc2NlbmUgaW4gdGhlIGJhdHRsZSkuIFNldCBieSByZWdpc3RlclNjZW5lRWxvLiAqL1xubGV0IG9wZW5CYXR0bGU6ICgpID0+IHZvaWQgPSAoKSA9PiB7fTtcblxuLyoqIE9uZSBTdGFzaCBcIm1pbmltYWxcIiBidXR0b24gd2l0aCB0aGUgc3dvcmRzIGFuZCB0aGUgRUxPLCBzbyBpdCBob3ZlcnMgYXMgYSB3aG9sZS4gKi9cbmZ1bmN0aW9uIGNyZWF0ZUl0ZW0oKTogSFRNTEVsZW1lbnQge1xuICBjb25zdCBpdGVtID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInNwYW5cIik7XG4gIGl0ZW0uY2xhc3NOYW1lID0gSVRFTV9DTEFTUztcbiAgaXRlbS5pbm5lckhUTUwgPSBgXG4gICAgICA8YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cIm1pbmltYWwgYnRuIGJ0bi1zZWNvbmRhcnkgc2Itc2NlbmUtZWxvLWJ1dHRvblwiIHRpdGxlPVwiJHtUSVRMRX1cIj5cbiAgICAgICAgPHN2ZyBjbGFzcz1cInN2Zy1pbmxpbmUtLWZhIGZhLWljb25cIiBhcmlhLWhpZGRlbj1cInRydWVcIiBmb2N1c2FibGU9XCJmYWxzZVwiIHZpZXdCb3g9XCIwIDAgMzYgMzZcIiB3aWR0aD1cIjFlbVwiIGhlaWdodD1cIjFlbVwiPiR7U1dPUkRTX1BBVEhTfTwvc3ZnPlxuICAgICAgICA8c3BhbiBjbGFzcz1cInNiLXNjZW5lLWVsby12YWx1ZVwiPjwvc3Bhbj5cbiAgICAgIDwvYnV0dG9uPmA7XG4gIGl0ZW0ucXVlcnlTZWxlY3RvcihcImJ1dHRvblwiKT8uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IG9wZW5CYXR0bGUoKSk7XG4gIHJldHVybiBpdGVtO1xufVxuXG4vKiogVGhlIHRvb2xiYXIgZ3JvdXAgaG9sZGluZyBQbGF5IENvdW50IGFuZCBPIENvdW50OyB0aGUgaXRlbSBnb2VzIGluIGZyb250IG9mIFBsYXkgQ291bnQuICovXG5mdW5jdGlvbiBwbGFjZUl0ZW0odG9vbGJhcjogRWxlbWVudCwgaXRlbTogSFRNTEVsZW1lbnQpOiBib29sZWFuIHtcbiAgY29uc3QgcGxheUNvdW50ID0gdG9vbGJhci5xdWVyeVNlbGVjdG9yKCdidXR0b25bdGl0bGU9XCJQbGF5IENvdW50XCJdJyk/LmNsb3Nlc3QoXCIuc2NlbmUtdG9vbGJhci1ncm91cCA+ICpcIik7XG4gIGlmIChwbGF5Q291bnQpIHtcbiAgICBwbGF5Q291bnQuYmVmb3JlKGl0ZW0pO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGNvbnN0IGdyb3VwID0gdG9vbGJhci5xdWVyeVNlbGVjdG9yKFwiLnNjZW5lLXRvb2xiYXItZ3JvdXA6bGFzdC1jaGlsZFwiKTtcbiAgaWYgKCFncm91cCkgcmV0dXJuIGZhbHNlO1xuICBncm91cC5wcmVwZW5kKGl0ZW0pO1xuICByZXR1cm4gdHJ1ZTtcbn1cblxubGV0IHJlbmRlcmluZzogc3RyaW5nIHwgbnVsbCA9IG51bGw7XG5cbi8qKiBBZGQgKG9yIHVwZGF0ZSkgdGhlIGl0ZW0gb24gdGhlIGN1cnJlbnQgc2NlbmUgcGFnZS4gU2FmZSB0byBjYWxsIG9mdGVuLiAqL1xuYXN5bmMgZnVuY3Rpb24gcmVuZGVyU2NlbmVFbG8oZm9yY2UgPSBmYWxzZSk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCBzY2VuZUlkID0gZ2V0U2NlbmVJZEZyb21VcmwoKTtcbiAgY29uc3QgdG9vbGJhciA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoXCIuc2NlbmUtdG9vbGJhclwiKTtcbiAgaWYgKCFzY2VuZUlkIHx8ICF0b29sYmFyKSByZXR1cm47XG4gIGNvbnN0IGV4aXN0aW5nID0gdG9vbGJhci5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihgLiR7SVRFTV9DTEFTU31gKTtcbiAgaWYgKCFmb3JjZSAmJiBleGlzdGluZz8uZGF0YXNldC5zY2VuZUlkID09PSBzY2VuZUlkKSByZXR1cm47XG4gIGlmIChyZW5kZXJpbmcgPT09IHNjZW5lSWQpIHJldHVybjtcblxuICByZW5kZXJpbmcgPSBzY2VuZUlkO1xuICB0cnkge1xuICAgIGlmICghKGF3YWl0IHNjZW5lQ3VzdG9tRmllbGRzU3VwcG9ydGVkKCkpKSByZXR1cm47XG4gICAgc2V0dGluZ3NMb2FkID8/PSBsb2FkU2V0dGluZ3MoKTtcbiAgICBjb25zdCBbcmVzdWx0XSA9IGF3YWl0IFByb21pc2UuYWxsKFtzY2VuZUFuZFJhbmsoc2NlbmVJZCksIHNldHRpbmdzTG9hZF0pO1xuICAgIC8vIFRoZSBwYWdlIG1heSBoYXZlIG1vdmVkIG9uIChhbm90aGVyIHNjZW5lLCBvciB0aGUgdG9vbGJhciByZS1yZW5kZXJlZCkgd2hpbGUgdGhpcyBsb2FkZWRcbiAgICBpZiAoIXJlc3VsdCB8fCBnZXRTY2VuZUlkRnJvbVVybCgpICE9PSBzY2VuZUlkKSByZXR1cm47XG4gICAgY29uc3QgdGFyZ2V0ID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcihcIi5zY2VuZS10b29sYmFyXCIpO1xuICAgIGlmICghdGFyZ2V0KSByZXR1cm47XG5cbiAgICBsZXQgaXRlbSA9IHRhcmdldC5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihgLiR7SVRFTV9DTEFTU31gKTtcbiAgICBpZiAoIWl0ZW0pIHtcbiAgICAgIGl0ZW0gPSBjcmVhdGVJdGVtKCk7XG4gICAgICBpZiAoIXBsYWNlSXRlbSh0YXJnZXQsIGl0ZW0pKSByZXR1cm47XG4gICAgfVxuICAgIGl0ZW0uZGF0YXNldC5zY2VuZUlkID0gc2NlbmVJZDtcbiAgICBjb25zdCB2YWx1ZSA9IGl0ZW0ucXVlcnlTZWxlY3RvcihcIi5zYi1zY2VuZS1lbG8tdmFsdWVcIik7XG4gICAgaWYgKHZhbHVlKSB2YWx1ZS50ZXh0Q29udGVudCA9IGxhYmVsVGV4dChyZXN1bHQuc2NlbmUsIHJlc3VsdC5yYW5rKTtcbiAgICBpdGVtLnF1ZXJ5U2VsZWN0b3IoXCJidXR0b25cIik/LnNldEF0dHJpYnV0ZShcInRpdGxlXCIsIHRpdGxlVGV4dChyZXN1bHQuc2NlbmUsIHJlc3VsdC50aWVyKSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zb2xlLndhcm4oXCJbU3Rhc2ggQmF0dGxlXSBDb3VsZG4ndCBzaG93IHRoZSBzY2VuZSdzIEVMTzpcIiwgZSk7XG4gIH0gZmluYWxseSB7XG4gICAgcmVuZGVyaW5nID0gbnVsbDtcbiAgfVxufVxuXG4vKiogUmVmcmVzaCB0aGUgaXRlbSBmcm9tIHRoZSBjYWNoZSAoYWZ0ZXIgYmF0dGxlcyBjaGFuZ2UgRUxPKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWZyZXNoU2NlbmVFbG8oKTogdm9pZCB7XG4gIHZvaWQgcmVuZGVyU2NlbmVFbG8odHJ1ZSk7XG59XG5cbi8qKlxuICogU2hvdyB0aGUgRUxPIGl0ZW0gb24gc2NlbmUgcGFnZXMsIHJlLWFkZGluZyBpdCBhcyBTdGFzaCBuYXZpZ2F0ZXMgYW5kIHJlLXJlbmRlcnM7IGNsaWNraW5nIGl0XG4gKiBjYWxscyBgb25DbGlja2AgKG9wZW5zIFN0YXNoIEJhdHRsZSkuIENhbGwgb25jZSBhdCBzdGFydHVwLlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVnaXN0ZXJTY2VuZUVsbyhvbkNsaWNrOiAoKSA9PiB2b2lkKTogdm9pZCB7XG4gIG9wZW5CYXR0bGUgPSBvbkNsaWNrO1xuICBsZXQgcXVldWVkID0gZmFsc2U7XG4gIGNvbnN0IGNoZWNrID0gKCk6IHZvaWQgPT4ge1xuICAgIHF1ZXVlZCA9IGZhbHNlO1xuICAgIGlmIChnZXRTY2VuZUlkRnJvbVVybCgpKSB2b2lkIHJlbmRlclNjZW5lRWxvKCk7XG4gIH07XG4gIC8vIEJhdGNoZWQgd2l0aCBhIHRpbWVyLCBub3QgYW4gYW5pbWF0aW9uIGZyYW1lOiBmcmFtZXMgZG9uJ3QgcnVuIGluIGEgYmFja2dyb3VuZCB0YWJcbiAgbmV3IE11dGF0aW9uT2JzZXJ2ZXIoKCkgPT4ge1xuICAgIGlmIChxdWV1ZWQpIHJldHVybjtcbiAgICBxdWV1ZWQgPSB0cnVlO1xuICAgIHNldFRpbWVvdXQoY2hlY2ssIDUwKTtcbiAgfSkub2JzZXJ2ZShkb2N1bWVudC5ib2R5LCB7IGNoaWxkTGlzdDogdHJ1ZSwgc3VidHJlZTogdHJ1ZSB9KTtcbiAgY2hlY2soKTtcbn1cbiIsICIvLyBTZXR1cCBwcmV2aWV3OiB0ZW4gZXhhbXBsZSBzY2VuZXMgaW4gdGhyZWUgcm93cyAobm93IGluIFN0YXNoIC8gYWZ0ZXIgc2V0dXAgLyBhZnRlciBsb3RzIG9mXG4vLyBiYXR0bGVzKS4gRXZlcnkgbnVtYmVyIGNvbWVzIGZyb20gdGhlIHJlYWwgc2NvcmUudHMgZnVuY3Rpb25zLCBzbyB0aGUgcHJldmlldyBjYW4ndCBkcmlmdFxuLy8gZnJvbSB3aGF0IHNldHVwIGFuZCB0aGUgU3Rhc2ggcmF0aW5ncyBvcHRpb25zIGFjdHVhbGx5IGRvLlxuXG5pbXBvcnQgeyBFTE9fRklFTEQgfSBmcm9tIFwiLi4vY29uc3RhbnRzXCI7XG5pbXBvcnQgeyBhZnRlclNldHVwLCBlbG8sIHN0YXNoUmF0aW5nVGFyZ2V0cyB9IGZyb20gXCIuLi9zY29yZVwiO1xuaW1wb3J0IHR5cGUgeyBFbG9TdGFydCwgU2NlbmUsIFN0YXNoUmF0aW5nc01vZGUgfSBmcm9tIFwiLi4vdHlwZXNcIjtcblxuLyoqIEV4YW1wbGUgU3Rhc2ggcmF0aW5ncyB0b2RheTogdGhlIHRpZSBhdCAxMDAgc2hvd3MgaG93IHJhdGluZ3MgYnVuY2ggdXAgYXQgdGhlIHRvcC4gKi9cbmNvbnN0IE5PV19SQVRJTkdTOiAobnVtYmVyIHwgbnVsbClbXSA9IFsxMDAsIDEwMCwgOTYsIDg1LCA3NCwgNzAsIDYyLCA0NSwgMjAsIG51bGxdO1xuXG4vKiogRXhhbXBsZSBFTE8gb25jZSBiYXR0bGVzIGhhdmUgc3ByZWFkIHRoZSBzY2VuZXMgb3V0ICh0aGUgc2FtZSBmb3IgYm90aCBzdGFydCBjaG9pY2VzKS4gKi9cbmNvbnN0IEJBVFRMRURfRUxPID0gWzIxNTAsIDE5ODAsIDE3MDAsIDE2NTAsIDE2MDAsIDE1NTAsIDE1MDAsIDE0MDAsIDEyNTAsIDExMDBdO1xuXG5pbnRlcmZhY2UgU3F1YXJlIHtcbiAgZWxvOiBudW1iZXIgfCBudWxsO1xuICByYXRpbmc6IG51bWJlciB8IG51bGw7XG4gIGNoYW5nZWQ6IGJvb2xlYW47XG59XG5cbmZ1bmN0aW9uIGV4YW1wbGVTY2VuZXMoKTogU2NlbmVbXSB7XG4gIHJldHVybiBOT1dfUkFUSU5HUy5tYXAoKHJhdGluZzEwMCwgaSkgPT4gKHsgaWQ6IGBleGFtcGxlLSR7aX1gLCByYXRpbmcxMDAsIGN1c3RvbV9maWVsZHM6IHt9IH0pKTtcbn1cblxuLyoqIEVhY2ggc2NlbmUncyBTdGFzaCByYXRpbmcgdW5kZXIgdGhlIG1vZGU6IHdyaXR0ZW4gb25lcyBnZXQgdGhlaXIgdGFyZ2V0LCBvdGhlcnMgc3RheSBhcyBub3cuICovXG5mdW5jdGlvbiBzcXVhcmVzKHNjZW5lczogU2NlbmVbXSwgbW9kZTogU3Rhc2hSYXRpbmdzTW9kZSk6IFNxdWFyZVtdIHtcbiAgY29uc3QgdGFyZ2V0cyA9IHN0YXNoUmF0aW5nVGFyZ2V0cyhzY2VuZXMsIG1vZGUpO1xuICByZXR1cm4gc2NlbmVzLm1hcCgoc2NlbmUpID0+IHtcbiAgICBjb25zdCByYXRpbmcgPSB0YXJnZXRzLmdldChzY2VuZS5pZCkgPz8gc2NlbmUucmF0aW5nMTAwID8/IG51bGw7XG4gICAgcmV0dXJuIHsgZWxvOiBlbG8oc2NlbmUpLCByYXRpbmcsIGNoYW5nZWQ6IHJhdGluZyAhPT0gKHNjZW5lLnJhdGluZzEwMCA/PyBudWxsKSB9O1xuICB9KTtcbn1cblxuZnVuY3Rpb24gc3F1YXJlSHRtbCh7IGVsbzogZWxvVmFsdWUsIHJhdGluZywgY2hhbmdlZCB9OiBTcXVhcmUsIHNob3dDaGFuZ2U6IGJvb2xlYW4pOiBzdHJpbmcge1xuICBjb25zdCBjbGFzc2VzID0gW1wic2ItcHYtc3F1YXJlXCJdO1xuICBpZiAocmF0aW5nID09PSBudWxsKSBjbGFzc2VzLnB1c2goXCJzYi1wdi11bnJhdGVkXCIpO1xuICBpZiAocmF0aW5nICE9PSBudWxsICYmIHJhdGluZyA+IDU1KSBjbGFzc2VzLnB1c2goXCJzYi1wdi1zdHJvbmdcIik7XG4gIGlmIChzaG93Q2hhbmdlICYmIGNoYW5nZWQpIGNsYXNzZXMucHVzaChcInNiLXB2LWNoYW5nZWRcIik7XG4gIGNvbnN0IGZpbGwgPSByYXRpbmcgPT09IG51bGwgPyBcIlwiIDogYCBzdHlsZT1cIi0tc2ItcHYtZmlsbDogJHtyYXRpbmd9JVwiYDtcbiAgcmV0dXJuIGBcbiAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1wdi1jZWxsXCI+XG4gICAgICAgICAgICAgIDxzcGFuIGNsYXNzPVwic2ItcHYtZWxvXCI+JHtlbG9WYWx1ZSA9PT0gbnVsbCA/IFwiXCIgOiBNYXRoLnJvdW5kKGVsb1ZhbHVlKX08L3NwYW4+XG4gICAgICAgICAgICAgIDxzcGFuIGNsYXNzPVwiJHtjbGFzc2VzLmpvaW4oXCIgXCIpfVwiJHtmaWxsfT4ke3JhdGluZyA/PyBcIuKAk1wifTwvc3Bhbj5cbiAgICAgICAgICAgIDwvZGl2PmA7XG59XG5cbmZ1bmN0aW9uIHJvd0h0bWwobGFiZWw6IHN0cmluZywgY2VsbHM6IFNxdWFyZVtdLCBub3RlOiBzdHJpbmcsIG9wdGlvbnM6IHsgbXV0ZWQ/OiBib29sZWFuOyBzaG93Q2hhbmdlPzogYm9vbGVhbiB9ID0ge30pOiBzdHJpbmcge1xuICByZXR1cm4gYFxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1wdi1yb3cke29wdGlvbnMubXV0ZWQgPyBcIiBzYi1wdi1tdXRlZFwiIDogXCJcIn1cIj5cbiAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1wdi1sYWJlbFwiPiR7bGFiZWx9PC9kaXY+XG4gICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItcHYtc3F1YXJlc1wiPiR7Y2VsbHMubWFwKChjZWxsKSA9PiBzcXVhcmVIdG1sKGNlbGwsIG9wdGlvbnMuc2hvd0NoYW5nZSA/PyBmYWxzZSkpLmpvaW4oXCJcIil9XG4gICAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1wdi1ub3RlXCI+JHtub3RlfTwvZGl2PlxuICAgICAgICAgIDwvZGl2PmA7XG59XG5cbi8qKiBIb3cgbG9uZyBhIG51bWJlciBjb3VudHMgZnJvbSBpdHMgb2xkIHZhbHVlIHRvIGl0cyBuZXcgb25lIChjb2xvdXJzIGZhZGUgb3ZlciB0aGUgc2FtZSB0aW1lIGluIENTUykuICovXG5jb25zdCBUV0VFTl9NUyA9IDQwMDtcblxuLyoqIFJ1bm5pbmcgY291bnQgcGVyIGVsZW1lbnQ6IGl0cyBhbmltYXRpb24gZnJhbWUsIGFuZCBhIHRpbWVyIHRoYXQgbGFuZHMgaXQgaWYgZnJhbWVzIHN0YWxsLiAqL1xuY29uc3QgdHdlZW5zID0gbmV3IFdlYWtNYXA8RWxlbWVudCwgeyBmcmFtZTogbnVtYmVyOyB0aW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfT4oKTtcblxuLyoqIENvdW50IGFuIGVsZW1lbnQncyBudW1iZXIgZnJvbSB3aGF0IGl0IHNob3dzIG5vdyB0byBgdGFyZ2V0YDsgbm9uLW51bWJlcnMgKOKAkywgYmxhbmspIGp1c3Qgc3dhcC4gKi9cbmZ1bmN0aW9uIHR3ZWVuVGV4dChlbDogRWxlbWVudCwgdGFyZ2V0OiBzdHJpbmcpOiB2b2lkIHtcbiAgY29uc3QgcnVubmluZyA9IHR3ZWVucy5nZXQoZWwpO1xuICBpZiAocnVubmluZykge1xuICAgIGNhbmNlbEFuaW1hdGlvbkZyYW1lKHJ1bm5pbmcuZnJhbWUpO1xuICAgIGNsZWFyVGltZW91dChydW5uaW5nLnRpbWVyKTtcbiAgICB0d2VlbnMuZGVsZXRlKGVsKTtcbiAgfVxuICBjb25zdCBmcm9tID0gTnVtYmVyKGVsLnRleHRDb250ZW50KTtcbiAgY29uc3QgdG8gPSBOdW1iZXIodGFyZ2V0KTtcbiAgaWYgKGVsLnRleHRDb250ZW50ID09PSBcIlwiIHx8IHRhcmdldCA9PT0gXCJcIiB8fCAhTnVtYmVyLmlzRmluaXRlKGZyb20pIHx8ICFOdW1iZXIuaXNGaW5pdGUodG8pIHx8IGZyb20gPT09IHRvKSB7XG4gICAgZWwudGV4dENvbnRlbnQgPSB0YXJnZXQ7XG4gICAgcmV0dXJuO1xuICB9XG4gIGNvbnN0IHN0YXJ0VGltZSA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICAvLyBCYWNrZ3JvdW5kIHRhYnMgZ2V0IG5vIGFuaW1hdGlvbiBmcmFtZXM6IGxhbmQgb24gdGhlIGZpbmFsIG51bWJlciByZWdhcmRsZXNzXG4gIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgY29uc3QgY3VycmVudCA9IHR3ZWVucy5nZXQoZWwpO1xuICAgIGlmIChjdXJyZW50KSBjYW5jZWxBbmltYXRpb25GcmFtZShjdXJyZW50LmZyYW1lKTtcbiAgICB0d2VlbnMuZGVsZXRlKGVsKTtcbiAgICBlbC50ZXh0Q29udGVudCA9IHRhcmdldDtcbiAgfSwgVFdFRU5fTVMgKyA1MCk7XG4gIGNvbnN0IHN0ZXAgPSAobm93OiBudW1iZXIpOiB2b2lkID0+IHtcbiAgICBjb25zdCB0ID0gTWF0aC5taW4oMSwgKG5vdyAtIHN0YXJ0VGltZSkgLyBUV0VFTl9NUyk7XG4gICAgY29uc3QgZWFzZWQgPSAxIC0gTWF0aC5wb3coMSAtIHQsIDMpO1xuICAgIGVsLnRleHRDb250ZW50ID0gU3RyaW5nKE1hdGgucm91bmQoZnJvbSArICh0byAtIGZyb20pICogZWFzZWQpKTtcbiAgICBpZiAodCA8IDEpIHR3ZWVucy5zZXQoZWwsIHsgZnJhbWU6IHJlcXVlc3RBbmltYXRpb25GcmFtZShzdGVwKSwgdGltZXIgfSk7XG4gIH07XG4gIHR3ZWVucy5zZXQoZWwsIHsgZnJhbWU6IHJlcXVlc3RBbmltYXRpb25GcmFtZShzdGVwKSwgdGltZXIgfSk7XG59XG5cbi8qKlxuICogU2hvdyB0aGUgcHJldmlldyBpbiBgY29udGFpbmVyYC4gV2hlbiBvbmUgaXMgYWxyZWFkeSB0aGVyZSwgaXQncyB1cGRhdGVkIGluIHBsYWNlIHNvIHRoZVxuICogbnVtYmVycyBjb3VudCB0byB0aGVpciBuZXcgdmFsdWVzIGFuZCB0aGUgY29sb3VycyBmYWRlIChDU1MgdHJhbnNpdGlvbnMpIGluc3RlYWQgb2YganVtcGluZy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHNob3dSYXRpbmdQcmV2aWV3KGNvbnRhaW5lcjogSFRNTEVsZW1lbnQsIHN0YXJ0OiBFbG9TdGFydCwgc3Rhc2hSYXRpbmdzOiBTdGFzaFJhdGluZ3NNb2RlKTogdm9pZCB7XG4gIGNvbnN0IG5leHQgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBuZXh0LmlubmVySFRNTCA9IHJlbmRlclJhdGluZ1ByZXZpZXcoc3RhcnQsIHN0YXNoUmF0aW5ncyk7XG4gIGNvbnN0IGN1cnJlbnQgPSBjb250YWluZXIucXVlcnlTZWxlY3RvcihcIi5zYi1yYXRpbmctcHJldmlld1wiKTtcbiAgY29uc3QgcmVkdWNlZE1vdGlvbiA9IHdpbmRvdy5tYXRjaE1lZGlhKFwiKHByZWZlcnMtcmVkdWNlZC1tb3Rpb246IHJlZHVjZSlcIikubWF0Y2hlcztcbiAgaWYgKCFjdXJyZW50IHx8IHJlZHVjZWRNb3Rpb24pIHtcbiAgICBjb250YWluZXIucmVwbGFjZUNoaWxkcmVuKC4uLm5leHQuY2hpbGROb2Rlcyk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgZnJlc2ggPSBuZXh0LnF1ZXJ5U2VsZWN0b3IoXCIuc2ItcmF0aW5nLXByZXZpZXdcIikgYXMgRWxlbWVudDtcbiAgY29uc3QgcGFpcnMgPSAoc2VsZWN0b3I6IHN0cmluZyk6IFtFbGVtZW50LCBFbGVtZW50XVtdID0+IHtcbiAgICBjb25zdCBub3cgPSBjdXJyZW50LnF1ZXJ5U2VsZWN0b3JBbGwoc2VsZWN0b3IpO1xuICAgIHJldHVybiBbLi4uZnJlc2gucXVlcnlTZWxlY3RvckFsbChzZWxlY3RvcildLm1hcCgoZWwsIGkpID0+IFtub3dbaV0sIGVsXSk7XG4gIH07XG4gIGZvciAoY29uc3QgW2VsLCB0b10gb2YgcGFpcnMoXCIuc2ItcHYtcm93XCIpKSBlbC5jbGFzc05hbWUgPSB0by5jbGFzc05hbWU7XG4gIGZvciAoY29uc3QgW2VsLCB0b10gb2YgcGFpcnMoXCIuc2ItcHYtbm90ZVwiKSkgZWwudGV4dENvbnRlbnQgPSB0by50ZXh0Q29udGVudDtcbiAgZm9yIChjb25zdCBbZWwsIHRvXSBvZiBwYWlycyhcIi5zYi1wdi1lbG9cIikpIHR3ZWVuVGV4dChlbCwgdG8udGV4dENvbnRlbnQgPz8gXCJcIik7XG4gIGZvciAoY29uc3QgW2VsLCB0b10gb2YgcGFpcnMoXCIuc2ItcHYtc3F1YXJlXCIpKSB7XG4gICAgZWwuY2xhc3NOYW1lID0gdG8uY2xhc3NOYW1lO1xuICAgIGVsLnNldEF0dHJpYnV0ZShcInN0eWxlXCIsIHRvLmdldEF0dHJpYnV0ZShcInN0eWxlXCIpID8/IFwiXCIpO1xuICAgIHR3ZWVuVGV4dChlbCwgdG8udGV4dENvbnRlbnQgPz8gXCJcIik7XG4gIH1cbn1cblxuLyoqIFRoZSBwcmV2aWV3IGZvciBvbmUgcGFpciBvZiBzZXR1cCBhbnN3ZXJzLCBhcyBhbiBIVE1MIHN0cmluZy4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJSYXRpbmdQcmV2aWV3KHN0YXJ0OiBFbG9TdGFydCwgc3Rhc2hSYXRpbmdzOiBTdGFzaFJhdGluZ3NNb2RlKTogc3RyaW5nIHtcbiAgY29uc3Qgb2ZmID0gc3Rhc2hSYXRpbmdzID09PSBcIm9mZlwiO1xuICBjb25zdCBub3cgPSBzcXVhcmVzKGV4YW1wbGVTY2VuZXMoKSwgXCJvZmZcIik7XG5cbiAgY29uc3Qgc2V0VXAgPSBzcXVhcmVzKGV4YW1wbGVTY2VuZXMoKS5tYXAoKHNjZW5lKSA9PiBhZnRlclNldHVwKHNjZW5lLCBzdGFydCkpLCBzdGFzaFJhdGluZ3MpO1xuICBjb25zdCBjaGFuZ2VkQ291bnQgPSBzZXRVcC5maWx0ZXIoKGNlbGwpID0+IGNlbGwuY2hhbmdlZCkubGVuZ3RoO1xuXG4gIGNvbnN0IGJhdHRsZWQgPSBleGFtcGxlU2NlbmVzKCkubWFwKChzY2VuZSwgaSkgPT4gKHsgLi4uc2NlbmUsIGN1c3RvbV9maWVsZHM6IHsgW0VMT19GSUVMRF06IEJBVFRMRURfRUxPW2ldIH0gfSkpO1xuICBjb25zdCBsYXRlciA9IHNxdWFyZXMoYmF0dGxlZCwgc3Rhc2hSYXRpbmdzKTtcblxuICBjb25zdCB1bmNoYW5nZWROb3RlID0gXCJTdGFzaCByYXRpbmdzIHN0YXkgYXMgdGhleSBhcmVcIjtcbiAgY29uc3QgbGF0ZXJOb3RlID0gb2ZmXG4gICAgPyB1bmNoYW5nZWROb3RlXG4gICAgOiBzdGFzaFJhdGluZ3MgPT09IFwicGVyY2VudGlsZVwiXG4gICAgICA/IFwiRXZlbmx5IHNwYWNlZCBieSByYW5rLCB3aGF0ZXZlciB0aGUgZ2Fwc1wiXG4gICAgICA6IFwiR2FwcyBzaG93LCBidXQgMjE1MCBpcyBzdHVjayBhdCAxMDBcIjtcblxuICByZXR1cm4gYFxuICAgICAgICA8ZGl2IGNsYXNzPVwic2ItcmF0aW5nLXByZXZpZXdcIj5cbiAgICAgICAgICA8cCBjbGFzcz1cInNiLXB2LWxlZ2VuZFwiPkVhY2ggc3F1YXJlIGJlbG93IGlzIGFuIGV4YW1wbGUgc2NlbmU6IGl0cyBFTE8gYWJvdmUsIGl0cyBTdGFzaCByYXRpbmcgaW5zaWRlLjwvcD5cbiAgICAgICAgICAke3Jvd0h0bWwoXCJOb3cgaW4gU3Rhc2hcIiwgbm93LCBcIlwiKX1cbiAgICAgICAgICAke3Jvd0h0bWwoXCJBZnRlciBzZXR1cFwiLCBzZXRVcCwgb2ZmID8gdW5jaGFuZ2VkTm90ZSA6IGAke2NoYW5nZWRDb3VudH0gb2YgMTAgY2hhbmdlYCwgeyBtdXRlZDogb2ZmLCBzaG93Q2hhbmdlOiAhb2ZmIH0pfVxuICAgICAgICAgICR7cm93SHRtbChcIkFmdGVyIGxvdHMgb2YgYmF0dGxlc1wiLCBsYXRlciwgbGF0ZXJOb3RlLCB7IG11dGVkOiBvZmYgfSl9XG4gICAgICAgIDwvZGl2PmA7XG59XG4iLCAiLy8gT25lLXRpbWUgRUxPIHNldHVwIHNjcmVlbiwgc2hvd24gaW4gdGhlIEJhdHRsZSB0YWIgaW4gcGxhY2Ugb2YgdGhlIGJhdHRsZSB1bnRpbCBpdCdzIGRvbmUuXG4vLyBUd28gcXVlc3Rpb25zIHNpZGUgYnkgc2lkZSAoaG93IEVMTyBzdGFydHMsIHdoZXRoZXIgU3Rhc2ggQmF0dGxlIHdyaXRlcyBTdGFzaCByYXRpbmdzKSBhYm92ZVxuLy8gYSBzaGFyZWQgcHJldmlldywgdGhlbiBhIHByb2dyZXNzIHZpZXcgd2hpbGUgZWxvU2V0dXAudHMgd3JpdGVzLCB0aGVuIGEgc3VtbWFyeS4gUmVzZXQgRUxPXG4vLyAoU2V0dGluZ3MpIHNob3dzIHRoZSBzYW1lIHNjcmVlbiBpbiByZXNldCBtb2RlLCB3aXRoIGEgQ2FuY2VsIGJ1dHRvbi5cblxuaW1wb3J0IHsgY2xlYXJTY2VuZUNhY2hlIH0gZnJvbSBcIi4uL2NhY2hlXCI7XG5pbXBvcnQgeyBmZXRjaFNldHVwU2NlbmVzLCBydW5FbG9TZXR1cCwgc2V0dXBSYXRpbmdDaGFuZ2VzLCB0eXBlIFNldHVwUGhhc2UsIHR5cGUgU2V0dXBTdW1tYXJ5IH0gZnJvbSBcIi4uL2Vsb1NldHVwXCI7XG5pbXBvcnQgeyBpc1JhdGVkIH0gZnJvbSBcIi4uL3Njb3JlXCI7XG5pbXBvcnQgeyBoYWRGdW5Nb2RlLCB1cGRhdGVTZXR0aW5nc05vdyB9IGZyb20gXCIuLi9zZXR0aW5nc1wiO1xuaW1wb3J0IHsgcmVzZXRSdW5TdGF0ZSwgcmVzZXRTaHVmZmxlLCBzdGF0ZSB9IGZyb20gXCIuLi9zdGF0ZVwiO1xuaW1wb3J0IHsgc2F2ZVN0YXRlIH0gZnJvbSBcIi4uL3N0b3JhZ2VcIjtcbmltcG9ydCB0eXBlIHsgRWxvU3RhcnQsIFNjZW5lLCBTdGFzaFJhdGluZ3NNb2RlIH0gZnJvbSBcIi4uL3R5cGVzXCI7XG5pbXBvcnQgeyBzaG93UmF0aW5nUHJldmlldyB9IGZyb20gXCIuL3JhdGluZ1ByZXZpZXdcIjtcbmltcG9ydCB7IFNUQVNIX1JBVElOR1NfT1BUSU9OUyB9IGZyb20gXCIuL3N0YXNoUmF0aW5nc1RleHRcIjtcblxuLyoqIE9uIHRoZSBCYXR0bGUgcGFuZWwgd2hpbGUgc2V0dXAgc2hvd3M7IENTUyBoaWRlcyB0aGUgYmF0dGxlIFVJIChtb2RlcywgY2FyZHMsIGFjdGlvbnMpLiAqL1xuY29uc3QgU0VUVVBfQUNUSVZFX0NMQVNTID0gXCJzYi1zZXR1cC1hY3RpdmVcIjtcblxuLyoqIFRydWUgZnJvbSBTdGFydCB1bnRpbCB0aGUgd3JpdGVzIGZpbmlzaCBvciBmYWlsOyByZW9wZW5pbmcgQmF0dGxlIG1lYW53aGlsZSBrZWVwcyB0aGUgcHJvZ3Jlc3MuICovXG5sZXQgcnVubmluZyA9IGZhbHNlO1xuXG5leHBvcnQgaW50ZXJmYWNlIFNldHVwU2NyZWVuT3B0aW9ucyB7XG4gIC8qKiBSZXNldCBFTE86IGV2ZXJ5dGhpbmcgYWxyZWFkeSBoYXMgYW4gRUxPOyB0aGUgY3VycmVudCBTdGFzaCByYXRpbmdzIG9wdGlvbiBpcyBwcmVzZWxlY3RlZC4gKi9cbiAgcmVzZXQ/OiBib29sZWFuO1xuICAvKiogUmVzZXQgbW9kZSdzIENhbmNlbCBidXR0b24gKGJlZm9yZSBhbnl0aGluZyBpcyB3cml0dGVuKS4gKi9cbiAgb25DYW5jZWw/OiAoKSA9PiB2b2lkO1xufVxuXG5sZXQgb3B0aW9uczogU2V0dXBTY3JlZW5PcHRpb25zID0ge307XG5cbmludGVyZmFjZSBDaG9pY2Uge1xuICBzdGFydDogRWxvU3RhcnQ7XG4gIHN0YXNoUmF0aW5nczogU3Rhc2hSYXRpbmdzTW9kZTtcbn1cblxuY29uc3QgcGx1cmFsID0gKG46IG51bWJlciwgd29yZDogc3RyaW5nKTogc3RyaW5nID0+IGAke259ICR7d29yZH0ke24gPT09IDEgPyBcIlwiIDogXCJzXCJ9YDtcblxuZnVuY3Rpb24gc2V0dXBBcmVhKHJvb3Q6IFBhcmVudE5vZGUpOiBIVE1MRWxlbWVudCB8IG51bGwge1xuICByZXR1cm4gcm9vdC5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIiNzYi1zZXR1cC1hcmVhXCIpO1xufVxuXG4vKiogVHJ1ZSB3aGlsZSBzZXR1cCBpcyB3cml0aW5nIChTdGFydCBwcmVzc2VkLCBub3QgZmluaXNoZWQgb3IgZmFpbGVkIHlldCkuICovXG5leHBvcnQgZnVuY3Rpb24gaXNTZXR1cFJ1bm5pbmcoKTogYm9vbGVhbiB7XG4gIHJldHVybiBydW5uaW5nO1xufVxuXG4vKiogU2hvdyB0aGUgc2V0dXAgaW4gdGhlIEJhdHRsZSB0YWIuIGBvbkRvbmVgIHJ1bnMgb25jZSBzZXR1cCBoYXMgZmluaXNoZWQgYW5kIGJlZW4gc2F2ZWQuICovXG5leHBvcnQgZnVuY3Rpb24gc2hvd1NldHVwU2NyZWVuKHJvb3Q6IFBhcmVudE5vZGUsIG9uRG9uZTogKCkgPT4gdm9pZCwgc2NyZWVuT3B0aW9uczogU2V0dXBTY3JlZW5PcHRpb25zID0ge30pOiB2b2lkIHtcbiAgY29uc3QgYXJlYSA9IHNldHVwQXJlYShyb290KTtcbiAgaWYgKCFhcmVhKSByZXR1cm47XG4gIGFyZWEuY2xvc2VzdChcIi5zYi10YWItcGFuZWxcIik/LmNsYXNzTGlzdC5hZGQoU0VUVVBfQUNUSVZFX0NMQVNTKTtcbiAgYXJlYS5oaWRkZW4gPSBmYWxzZTtcbiAgaWYgKHJ1bm5pbmcpIHJldHVybjtcbiAgb3B0aW9ucyA9IHNjcmVlbk9wdGlvbnM7XG4gIHZvaWQgbG9hZENob2ljZXMoYXJlYSwgb25Eb25lKTtcbn1cblxuLyoqIFB1dCB0aGUgYmF0dGxlIFVJIGJhY2sgKHNldHVwIGZpbmlzaGVkLCBwb3NzaWJseSBlbHNld2hlcmUpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGhpZGVTZXR1cFNjcmVlbihyb290OiBQYXJlbnROb2RlKTogdm9pZCB7XG4gIGNvbnN0IGFyZWEgPSBzZXR1cEFyZWEocm9vdCk7XG4gIGlmICghYXJlYSB8fCBydW5uaW5nKSByZXR1cm47XG4gIGFyZWEuY2xvc2VzdChcIi5zYi10YWItcGFuZWxcIik/LmNsYXNzTGlzdC5yZW1vdmUoU0VUVVBfQUNUSVZFX0NMQVNTKTtcbiAgYXJlYS5oaWRkZW4gPSB0cnVlO1xuICBhcmVhLmlubmVySFRNTCA9IFwiXCI7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGxvYWRDaG9pY2VzKGFyZWE6IEhUTUxFbGVtZW50LCBvbkRvbmU6ICgpID0+IHZvaWQpOiBQcm9taXNlPHZvaWQ+IHtcbiAgYXJlYS5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz1cInNiLWxvYWRpbmdcIj5Mb2FkaW5nIHlvdXIgbGlicmFyeS4uLjwvZGl2PmA7XG4gIGxldCBzY2VuZXM6IFNjZW5lW107XG4gIHRyeSB7XG4gICAgc2NlbmVzID0gYXdhaXQgZmV0Y2hTZXR1cFNjZW5lcygpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIEVMTyBzZXR1cDogY291bGQgbm90IGxvYWQgc2NlbmVzOlwiLCBlKTtcbiAgICBzaG93RXJyb3IoYXJlYSwgXCJDb3VsZG4ndCBsb2FkIHlvdXIgc2NlbmVzIGZyb20gU3Rhc2guXCIsICgpID0+IHZvaWQgbG9hZENob2ljZXMoYXJlYSwgb25Eb25lKSk7XG4gICAgcmV0dXJuO1xuICB9XG4gIHJlbmRlckNob2ljZXMoYXJlYSwgc2NlbmVzLCBvbkRvbmUpO1xufVxuXG5mdW5jdGlvbiByYWRpbyhuYW1lOiBzdHJpbmcsIHZhbHVlOiBzdHJpbmcsIGxhYmVsOiBzdHJpbmcsIGRlc2M6IHN0cmluZywgY2hlY2tlZDogYm9vbGVhbik6IHN0cmluZyB7XG4gIGNvbnN0IGlkID0gYHNiLXNldHVwLSR7bmFtZX0tJHt2YWx1ZX1gO1xuICByZXR1cm4gYFxuICAgICAgICAgICAgICA8ZGl2IGNsYXNzPVwiY3VzdG9tLWNvbnRyb2wgY3VzdG9tLXJhZGlvIHNiLXNldHVwLW9wdGlvblwiPlxuICAgICAgICAgICAgICAgIDxpbnB1dCB0eXBlPVwicmFkaW9cIiBjbGFzcz1cImN1c3RvbS1jb250cm9sLWlucHV0XCIgaWQ9XCIke2lkfVwiIG5hbWU9XCIke25hbWV9XCIgdmFsdWU9XCIke3ZhbHVlfVwiICR7Y2hlY2tlZCA/IFwiY2hlY2tlZFwiIDogXCJcIn0+XG4gICAgICAgICAgICAgICAgPGxhYmVsIGNsYXNzPVwiY3VzdG9tLWNvbnRyb2wtbGFiZWxcIiBmb3I9XCIke2lkfVwiPlxuICAgICAgICAgICAgICAgICAgPHN0cm9uZz4ke2xhYmVsfTwvc3Ryb25nPlxuICAgICAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9XCJzYi1zZXR1cC1kZXNjXCI+JHtkZXNjfTwvc3Bhbj5cbiAgICAgICAgICAgICAgICA8L2xhYmVsPlxuICAgICAgICAgICAgICA8L2Rpdj5gO1xufVxuXG4vKiogV2hhdCB0aGUgc2Vjb25kIGFuc3dlciBkb2VzIHRvIFN0YXNoIHJhdGluZ3Mgbm93OiBhIHdhcm5pbmcgd2hlbiByYXRpbmdzIGNoYW5nZSwgZWxzZSBhIGNhbG0gbGluZS4gKi9cbmZ1bmN0aW9uIHJhdGluZ3NNZXNzYWdlKHN0YXJ0OiBFbG9TdGFydCwgbW9kZTogU3Rhc2hSYXRpbmdzTW9kZSwgY2hhbmdlczogbnVtYmVyKTogc3RyaW5nIHtcbiAgY29uc3QgYmFja3VwID0gXCJUYWtlIGEgU3Rhc2ggYmFja3VwIGZpcnN0IChTZXR0aW5ncyDihpIgVGFza3Mg4oaSIEJhY2t1cCkuXCI7XG4gIGxldCB0ZXh0OiBzdHJpbmc7XG4gIGxldCB3YXJuID0gdHJ1ZTtcbiAgaWYgKG1vZGUgPT09IFwib2ZmXCIpIHtcbiAgICB0ZXh0ID0gXCJTdGFzaCByYXRpbmdzIHdvbid0IGNoYW5nZS5cIjtcbiAgICB3YXJuID0gZmFsc2U7XG4gIH0gZWxzZSBpZiAoY2hhbmdlcyA9PT0gMCkge1xuICAgIHRleHQgPSBcIk5vIFN0YXNoIHJhdGluZ3MgY2hhbmdlIG5vdzogZXZlcnkgc2NlbmUgY29udmVydHMgYmFjayB0byBpdHMgY3VycmVudCByYXRpbmcuXCI7XG4gICAgd2FybiA9IGZhbHNlO1xuICB9IGVsc2UgaWYgKHN0YXJ0ID09PSBcImZyZXNoXCIpIHtcbiAgICB0ZXh0ID0gYOKaoO+4jyBFdmVyeSBzY2VuZSBzdGFydHMgYXQgMTUwMCBFTE8sIHNvIDxzdHJvbmc+ZXZlcnkgU3Rhc2ggcmF0aW5nIGJlY29tZXMgNTA8L3N0cm9uZz46ICR7cGx1cmFsKGNoYW5nZXMsIFwicmF0aW5nXCIpfSBjaGFuZ2UsIHVucmF0ZWQgc2NlbmVzIGluY2x1ZGVkLiAke2JhY2t1cH1gO1xuICB9IGVsc2Uge1xuICAgIHRleHQgPSBg4pqg77iPIDxzdHJvbmc+JHtwbHVyYWwoY2hhbmdlcywgXCJTdGFzaCByYXRpbmdcIil9IGNoYW5nZTwvc3Ryb25nPiBub3csIHNwcmVhZCBldmVubHkgYnkgcmFuay4gQSBzY2VuZSB5b3UgcmF0ZWQgMTAwIGJ5IGhhbmQgbWF5IGVuZCB1cCBsb3dlci4gJHtiYWNrdXB9YDtcbiAgfVxuICByZXR1cm4gYDxwIGNsYXNzPVwic2Itc2V0dXAtbWVzc2FnZSR7d2FybiA/IFwiIHNiLXNldHVwLXdhcm5pbmdcIiA6IFwiXCJ9XCI+JHt0ZXh0fTwvcD5gO1xufVxuXG5mdW5jdGlvbiByZW5kZXJDaG9pY2VzKGFyZWE6IEhUTUxFbGVtZW50LCBzY2VuZXM6IFNjZW5lW10sIG9uRG9uZTogKCkgPT4gdm9pZCk6IHZvaWQge1xuICBjb25zdCB0b3RhbCA9IHNjZW5lcy5sZW5ndGg7XG4gIGNvbnN0IHJhdGVkID0gc2NlbmVzLmZpbHRlcigoc2NlbmUpID0+IHNjZW5lLnJhdGluZzEwMCAhPSBudWxsKS5sZW5ndGg7XG4gIGNvbnN0IHVucmF0ZWQgPSB0b3RhbCAtIHJhdGVkO1xuICBjb25zdCB3aXRoRWxvID0gc2NlbmVzLmZpbHRlcihpc1JhdGVkKS5sZW5ndGg7XG4gIC8vIFJlLXJ1bnMgKFJlc2V0IEVMTywgU3RhZ2UgNCkgYW5kIHByZS0zLjAgZnVuIG1vZGUgdXNlcnMgaGFkIG5vIHJhdGluZyB1cGRhdGVzIHRvIGxvc2VcbiAgY29uc3QgdXBncmFkZU5vdGUgPVxuICAgICFzdGF0ZS5zZXR0aW5ncy5lbG9TZXR1cEF0ICYmICFoYWRGdW5Nb2RlKClcbiAgICAgID8gXCIgQmVmb3JlIDMuMCwgcmF0aW5ncyBjaGFuZ2VkIGFmdGVyIGV2ZXJ5IGJhdHRsZTsgU3RyYWlnaHQtbGluZSB3aXRoIFVzZSBteSByYXRpbmdzIGlzIGNsb3Nlc3QgdG8gdGhhdC5cIlxuICAgICAgOiBcIlwiO1xuXG4gIGNvbnN0IHJlc2V0ID0gb3B0aW9ucy5yZXNldCA9PT0gdHJ1ZTtcbiAgY29uc3QgY2hvaWNlOiBDaG9pY2UgPSB7IHN0YXJ0OiBcInJhdGluZ3NcIiwgc3Rhc2hSYXRpbmdzOiByZXNldCA/IHN0YXRlLnNldHRpbmdzLnN0YXNoUmF0aW5ncyA6IFwib2ZmXCIgfTtcblxuICBhcmVhLmlubmVySFRNTCA9IGBcbiAgICAgIDxkaXYgY2xhc3M9XCJzYi1zZXR1cFwiPlxuICAgICAgICA8aDIgY2xhc3M9XCJzYi1zZXR1cC10aXRsZVwiPiR7cmVzZXQgPyBcIlJlc2V0IEVMT1wiIDogXCJTZXQgdXAgRUxPXCJ9PC9oMj5cbiAgICAgICAgPHAgY2xhc3M9XCJzYi1zZXR1cC1pbnRyb1wiPlxuICAgICAgICAgICR7XG4gICAgICAgICAgICByZXNldFxuICAgICAgICAgICAgICA/IFwiQ2hvb3NlIGhvdyBFTE8gc3RhcnRzIGFnYWluLiBUaGlzIG92ZXJ3cml0ZXMgZXZlcnkgc2NlbmUncyBFTE8gYW5kIGJhdHRsZSBjb3VudC5cIlxuICAgICAgICAgICAgICA6IFwiU3Rhc2ggQmF0dGxlIG5vdyBnaXZlcyBlYWNoIHNjZW5lIGFuIEVMTyBzY29yZSwgc2F2ZWQgaW4gaXRzIGN1c3RvbSBmaWVsZHMuIFdpbnMgcmFpc2UgaXQsIGxvc3NlcyBsb3dlciBpdC4gQ2hvb3NlIGhvdyBpdCBzdGFydHMuIFRoaXMgcnVucyBvbmNlLlwiXG4gICAgICAgICAgfVxuICAgICAgICA8L3A+XG4gICAgICAgICR7XG4gICAgICAgICAgd2l0aEVsbyA+IDAgJiYgIXJlc2V0XG4gICAgICAgICAgICA/IGA8cCBjbGFzcz1cInNiLXNldHVwLXdhcm5pbmdcIj4ke3BsdXJhbCh3aXRoRWxvLCBcInNjZW5lXCIpfSBhbHJlYWR5ICR7d2l0aEVsbyA9PT0gMSA/IFwiaGFzXCIgOiBcImhhdmVcIn0gYW4gRUxPIGZyb20gYW4gZWFybGllciBzZXR1cCB0aGF0IGRpZG4ndCBmaW5pc2guIFNldHRpbmcgdXAgYWdhaW4gb3ZlcndyaXRlcyAke3dpdGhFbG8gPT09IDEgPyBcIml0XCIgOiBcInRoZW1cIn0uPC9wPmBcbiAgICAgICAgICAgIDogXCJcIlxuICAgICAgICB9XG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi1zZXR1cC1xdWVzdGlvbnNcIj5cbiAgICAgICAgICA8ZmllbGRzZXQgY2xhc3M9XCJzYi1zZXR1cC1xdWVzdGlvblwiPlxuICAgICAgICAgICAgPGxlZ2VuZD5Ib3cgc2hvdWxkIEVMTyBzdGFydD88L2xlZ2VuZD5cbiAgICAgICAgICAgICR7cmFkaW8oXG4gICAgICAgICAgICAgIFwic3RhcnRcIixcbiAgICAgICAgICAgICAgXCJyYXRpbmdzXCIsXG4gICAgICAgICAgICAgIFwiVXNlIG15IHJhdGluZ3NcIixcbiAgICAgICAgICAgICAgYFlvdXIgJHtwbHVyYWwocmF0ZWQsIFwicmF0ZWQgc2NlbmVcIil9IHN0YXJ0IGZyb20gdGhlaXIgcmF0aW5nICg1MCA9IDE1MDAgRUxPLCAxMCBFTE8gcGVyIHBvaW50KS4ke3VucmF0ZWQgPiAwID8gYCBUaGUgJHt1bnJhdGVkfSB1bnJhdGVkICR7dW5yYXRlZCA9PT0gMSA/IFwib25lIHN0YXlzXCIgOiBcIm9uZXMgc3RheVwifSB1bnJhdGVkLmAgOiBcIlwifWAsXG4gICAgICAgICAgICAgIHRydWUsXG4gICAgICAgICAgICApfVxuICAgICAgICAgICAgJHtyYWRpbyhcbiAgICAgICAgICAgICAgXCJzdGFydFwiLFxuICAgICAgICAgICAgICBcImZyZXNoXCIsXG4gICAgICAgICAgICAgIFwiU3RhcnQgZXZlcnlvbmUgYXQgMTUwMFwiLFxuICAgICAgICAgICAgICBgQWxsICR7cGx1cmFsKHRvdGFsLCBcInNjZW5lXCIpfSBzdGFydCBlcXVhbC5gLFxuICAgICAgICAgICAgICBmYWxzZSxcbiAgICAgICAgICAgICl9XG4gICAgICAgICAgPC9maWVsZHNldD5cbiAgICAgICAgICA8ZmllbGRzZXQgY2xhc3M9XCJzYi1zZXR1cC1xdWVzdGlvblwiPlxuICAgICAgICAgICAgPGxlZ2VuZD5TaG91bGQgU3Rhc2ggQmF0dGxlIGNoYW5nZSB5b3VyIFN0YXNoIHJhdGluZ3M/PC9sZWdlbmQ+XG4gICAgICAgICAgICAke1NUQVNIX1JBVElOR1NfT1BUSU9OUy5tYXAoKHsgdmFsdWUsIGxhYmVsLCBkZXNjIH0pID0+XG4gICAgICAgICAgICAgIHJhZGlvKFwic3Rhc2hSYXRpbmdzXCIsIHZhbHVlLCBsYWJlbCwgZGVzYywgdmFsdWUgPT09IGNob2ljZS5zdGFzaFJhdGluZ3MpLFxuICAgICAgICAgICAgKS5qb2luKFwiXCIpfVxuICAgICAgICAgICAgPHAgY2xhc3M9XCJzYi1zZXR1cC1ub3RlXCI+WW91IGNhbiBjaGFuZ2UgdGhpcyBsYXRlciBpbiBTZXR0aW5ncy4ke3VwZ3JhZGVOb3RlfTwvcD5cbiAgICAgICAgICA8L2ZpZWxkc2V0PlxuICAgICAgICA8L2Rpdj5cbiAgICAgICAgPGRpdiBjbGFzcz1cInNiLXNldHVwLW1lc3NhZ2Utc2xvdFwiIGRhdGEtcm9sZT1cInJhdGluZ3Mtd2FybmluZ1wiPjwvZGl2PlxuICAgICAgICA8aDMgY2xhc3M9XCJzYi1zZXR1cC1zdWJ0aXRsZVwiPlByZXZpZXc8L2gzPlxuICAgICAgICA8ZGl2IGRhdGEtcm9sZT1cInByZXZpZXdcIj48L2Rpdj5cbiAgICAgICAgPGRpdiBjbGFzcz1cInNiLXNldHVwLWFjdGlvbnNcIj5cbiAgICAgICAgICAke3Jlc2V0ID8gYDxidXR0b24gdHlwZT1cImJ1dHRvblwiIGNsYXNzPVwiYnRuIGJ0bi1zZWNvbmRhcnlcIiBkYXRhLXJvbGU9XCJjYW5jZWxcIj5DYW5jZWw8L2J1dHRvbj5gIDogXCJcIn1cbiAgICAgICAgICA8YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cImJ0biBidG4tcHJpbWFyeVwiIGRhdGEtcm9sZT1cInN0YXJ0XCI+U3RhcnQgRUxPPC9idXR0b24+XG4gICAgICAgIDwvZGl2PlxuICAgICAgPC9kaXY+YDtcblxuICBhcmVhLnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLXJvbGU9XCJjYW5jZWxcIl0nKT8uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IG9wdGlvbnMub25DYW5jZWw/LigpKTtcblxuICBjb25zdCBzbG90ID0gYXJlYS5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PignW2RhdGEtcm9sZT1cInJhdGluZ3Mtd2FybmluZ1wiXScpIGFzIEhUTUxFbGVtZW50O1xuICBjb25zdCBwcmV2aWV3ID0gYXJlYS5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PignW2RhdGEtcm9sZT1cInByZXZpZXdcIl0nKSBhcyBIVE1MRWxlbWVudDtcbiAgY29uc3Qgc3RhcnRCdG4gPSBhcmVhLnF1ZXJ5U2VsZWN0b3I8SFRNTEJ1dHRvbkVsZW1lbnQ+KCdbZGF0YS1yb2xlPVwic3RhcnRcIl0nKSBhcyBIVE1MQnV0dG9uRWxlbWVudDtcblxuICAvLyBFdmVyeSBhbnN3ZXIncyBtZXNzYWdlIHNpdHMgaW4gdGhlIHNsb3QgYXQgb25jZSwgc3RhY2tlZCBpbiBvbmUgZ3JpZCBjZWxsLCBzbyB0aGUgc2xvdCBpc1xuICAvLyBhbHdheXMgYXMgdGFsbCBhcyB0aGUgbG9uZ2VzdCBhbmQgc3dpdGNoaW5nIGFuc3dlcnMgbmV2ZXIgbW92ZXMgdGhlIGxheW91dCBiZWxvdyBpdC5cbiAgLy8gQW5zd2VycyB3aXRoIHRoZSBzYW1lIG1lc3NhZ2Ugc2hhcmUgb25lIGVsZW1lbnQsIHNvIHN3aXRjaGluZyBiZXR3ZWVuIHRoZW0gZG9lc24ndCBmYWRlLlxuICBjb25zdCBjaGFuZ2VDb3VudHMgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xuICBjb25zdCBtZXNzYWdlRm9yID0gbmV3IE1hcDxzdHJpbmcsIEVsZW1lbnQ+KCk7XG4gIGNvbnN0IG1lc3NhZ2VCeUh0bWwgPSBuZXcgTWFwPHN0cmluZywgRWxlbWVudD4oKTtcbiAgZm9yIChjb25zdCBzdGFydCBvZiBbXCJyYXRpbmdzXCIsIFwiZnJlc2hcIl0gYXMgY29uc3QpIHtcbiAgICBmb3IgKGNvbnN0IG1vZGUgb2YgW1wib2ZmXCIsIFwibGluZWFyXCIsIFwicGVyY2VudGlsZVwiXSBhcyBjb25zdCkge1xuICAgICAgY29uc3QgY2hhbmdlcyA9IHNldHVwUmF0aW5nQ2hhbmdlcyhzY2VuZXMsIHN0YXJ0LCBtb2RlKS5zaXplO1xuICAgICAgY29uc3QgaHRtbCA9IHJhdGluZ3NNZXNzYWdlKHN0YXJ0LCBtb2RlLCBjaGFuZ2VzKTtcbiAgICAgIGxldCBtZXNzYWdlID0gbWVzc2FnZUJ5SHRtbC5nZXQoaHRtbCk7XG4gICAgICBpZiAoIW1lc3NhZ2UpIHtcbiAgICAgICAgc2xvdC5pbnNlcnRBZGphY2VudEhUTUwoXCJiZWZvcmVlbmRcIiwgaHRtbCk7XG4gICAgICAgIG1lc3NhZ2UgPSBzbG90Lmxhc3RFbGVtZW50Q2hpbGQgYXMgRWxlbWVudDtcbiAgICAgICAgbWVzc2FnZUJ5SHRtbC5zZXQoaHRtbCwgbWVzc2FnZSk7XG4gICAgICB9XG4gICAgICBjaGFuZ2VDb3VudHMuc2V0KGAke3N0YXJ0fToke21vZGV9YCwgY2hhbmdlcyk7XG4gICAgICBtZXNzYWdlRm9yLnNldChgJHtzdGFydH06JHttb2RlfWAsIG1lc3NhZ2UpO1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IHVwZGF0ZSA9ICgpOiB2b2lkID0+IHtcbiAgICBzaG93UmF0aW5nUHJldmlldyhwcmV2aWV3LCBjaG9pY2Uuc3RhcnQsIGNob2ljZS5zdGFzaFJhdGluZ3MpO1xuICAgIGNvbnN0IGtleSA9IGAke2Nob2ljZS5zdGFydH06JHtjaG9pY2Uuc3Rhc2hSYXRpbmdzfWA7XG4gICAgY29uc3Qgc2hvd24gPSBtZXNzYWdlRm9yLmdldChrZXkpO1xuICAgIGZvciAoY29uc3QgbWVzc2FnZSBvZiBzbG90LmNoaWxkcmVuKSBtZXNzYWdlLmNsYXNzTGlzdC50b2dnbGUoXCJzYi1zaG93blwiLCBtZXNzYWdlID09PSBzaG93bik7XG4gICAgY29uc3QgY2hhbmdlcyA9IGNoYW5nZUNvdW50cy5nZXQoa2V5KSA/PyAwO1xuICAgIHN0YXJ0QnRuLnRleHRDb250ZW50ID0gY2hhbmdlcyA+IDAgPyBgU3RhcnQgRUxPIGFuZCBjaGFuZ2UgJHtwbHVyYWwoY2hhbmdlcywgXCJyYXRpbmdcIil9YCA6IFwiU3RhcnQgRUxPXCI7XG4gIH07XG5cbiAgYXJlYS5xdWVyeVNlbGVjdG9yQWxsPEhUTUxJbnB1dEVsZW1lbnQ+KCdpbnB1dFt0eXBlPVwicmFkaW9cIl0nKS5mb3JFYWNoKChpbnB1dCkgPT4ge1xuICAgIGlucHV0LmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKCkgPT4ge1xuICAgICAgaWYgKGlucHV0Lm5hbWUgPT09IFwic3RhcnRcIikgY2hvaWNlLnN0YXJ0ID0gaW5wdXQudmFsdWUgYXMgRWxvU3RhcnQ7XG4gICAgICBlbHNlIGNob2ljZS5zdGFzaFJhdGluZ3MgPSBpbnB1dC52YWx1ZSBhcyBTdGFzaFJhdGluZ3NNb2RlO1xuICAgICAgdXBkYXRlKCk7XG4gICAgfSk7XG4gIH0pO1xuICBzdGFydEJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4gdm9pZCBydW5TZXR1cChhcmVhLCBzY2VuZXMsIGNob2ljZSwgb25Eb25lKSk7XG4gIHVwZGF0ZSgpO1xufVxuXG5mdW5jdGlvbiBwcm9ncmVzc0h0bWwocGhhc2U6IFNldHVwUGhhc2UsIGRvbmU6IG51bWJlciwgdG90YWw6IG51bWJlcik6IHN0cmluZyB7XG4gIGNvbnN0IHBlcmNlbnQgPSB0b3RhbCA+IDAgPyBNYXRoLnJvdW5kKChkb25lIC8gdG90YWwpICogMTAwKSA6IDEwMDtcbiAgY29uc3QgbGFiZWwgPVxuICAgIHBoYXNlID09PSBcImVsb1wiXG4gICAgICA/IGBTYXZpbmcgc3RhcnRpbmcgRUxPOiAke2RvbmV9IG9mICR7cGx1cmFsKHRvdGFsLCBcInNjZW5lXCIpfWBcbiAgICAgIDogYFVwZGF0aW5nIFN0YXNoIHJhdGluZ3M6ICR7cGx1cmFsKHRvdGFsLCBcInNjZW5lXCIpfWA7XG4gIHJldHVybiBgXG4gICAgICA8ZGl2IGNsYXNzPVwic2Itc2V0dXAgc2Itc2V0dXAtcHJvZ3Jlc3NcIj5cbiAgICAgICAgPGgyIGNsYXNzPVwic2Itc2V0dXAtdGl0bGVcIj5TZXR0aW5nIHVwIEVMTy4uLjwvaDI+XG4gICAgICAgIDxkaXYgY2xhc3M9XCJwcm9ncmVzc1wiPjxkaXYgY2xhc3M9XCJwcm9ncmVzcy1iYXJcIiByb2xlPVwicHJvZ3Jlc3NiYXJcIiBzdHlsZT1cIndpZHRoOiAke3BlcmNlbnR9JVwiIGFyaWEtdmFsdWVub3c9XCIke3BlcmNlbnR9XCIgYXJpYS12YWx1ZW1pbj1cIjBcIiBhcmlhLXZhbHVlbWF4PVwiMTAwXCI+PC9kaXY+PC9kaXY+XG4gICAgICAgIDxwIGNsYXNzPVwic2Itc2V0dXAtcHJvZ3Jlc3MtbGFiZWxcIj4ke2xhYmVsfTwvcD5cbiAgICAgICAgPHAgY2xhc3M9XCJzYi1zZXR1cC1ub3RlXCI+WW91IGNhbiBjbG9zZSBTdGFzaCBCYXR0bGU7IHNldHVwIGtlZXBzIGdvaW5nIHdoaWxlIHRoaXMgU3Rhc2ggdGFiIHN0YXlzIG9wZW4uIElmIHRoZSB0YWIgY2xvc2VzIGZpcnN0LCBTdGFzaCBCYXR0bGUgYXNrcyBhZ2FpbiBuZXh0IHRpbWUsIGFuZCBydW5uaW5nIGl0IGFnYWluIGlzIHNhZmUuPC9wPlxuICAgICAgPC9kaXY+YDtcbn1cblxuYXN5bmMgZnVuY3Rpb24gcnVuU2V0dXAoYXJlYTogSFRNTEVsZW1lbnQsIHNjZW5lczogU2NlbmVbXSwgY2hvaWNlOiBDaG9pY2UsIG9uRG9uZTogKCkgPT4gdm9pZCk6IFByb21pc2U8dm9pZD4ge1xuICBydW5uaW5nID0gdHJ1ZTtcbiAgYXJlYS5pbm5lckhUTUwgPSBwcm9ncmVzc0h0bWwoXCJlbG9cIiwgMCwgMCk7XG4gIC8vIEEgcmVzZXQgY2xlYXJzIHRoZSBcInNldHVwIGZpbmlzaGVkXCIgZmxhZyBmaXJzdCwgc28gaWYgaXQncyBpbnRlcnJ1cHRlZCBTdGFzaCBCYXR0bGUgYXNrcyBhZ2FpblxuICBpZiAoc3RhdGUuc2V0dGluZ3MuZWxvU2V0dXBBdCAmJiAhKGF3YWl0IHVwZGF0ZVNldHRpbmdzTm93KHsgZWxvU2V0dXBBdDogbnVsbCwgZWxvU2V0dXBNb2RlOiBudWxsIH0pKSkge1xuICAgIGNvbnNvbGUud2FybihcIltTdGFzaCBCYXR0bGVdIENvdWxkbid0IGNsZWFyIHRoZSBzZXR1cCBmbGFnIGJlZm9yZSByZXNldHRpbmcgRUxPOyBjb250aW51aW5nXCIpO1xuICB9XG4gIGxldCBzdW1tYXJ5OiBTZXR1cFN1bW1hcnk7XG4gIHRyeSB7XG4gICAgc3VtbWFyeSA9IGF3YWl0IHJ1bkVsb1NldHVwKHNjZW5lcywgY2hvaWNlLnN0YXJ0LCBjaG9pY2Uuc3Rhc2hSYXRpbmdzLCAocGhhc2UsIGRvbmUsIHRvdGFsKSA9PiB7XG4gICAgICBhcmVhLmlubmVySFRNTCA9IHByb2dyZXNzSHRtbChwaGFzZSwgZG9uZSwgdG90YWwpO1xuICAgIH0pO1xuICB9IGNhdGNoIChlKSB7XG4gICAgcnVubmluZyA9IGZhbHNlO1xuICAgIGNvbnNvbGUuZXJyb3IoXCJbU3Rhc2ggQmF0dGxlXSBFTE8gc2V0dXAgZmFpbGVkOlwiLCBlKTtcbiAgICBzaG93RXJyb3IoXG4gICAgICBhcmVhLFxuICAgICAgYFNldHVwIHN0b3BwZWQgcGFydHdheTogJHtlc2NhcGVIdG1sKGUgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IFN0cmluZyhlKSl9LiBSdW5uaW5nIGl0IGFnYWluIGlzIHNhZmU7IGl0IG92ZXJ3cml0ZXMgd2hhdCB3YXMgd3JpdHRlbi5gLFxuICAgICAgKCkgPT4gdm9pZCBsb2FkQ2hvaWNlcyhhcmVhLCBvbkRvbmUpLFxuICAgICk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgLy8gQ2FjaGVkIHNjZW5lcyBhbmQgYW55IHNhdmVkIHBhaXIgcHJlZGF0ZSB0aGUgbmV3IEVMTyAoYW5kIHBvc3NpYmx5IHRoZSBuZXcgcmF0aW5ncylcbiAgYXdhaXQgY2xlYXJTY2VuZUNhY2hlKCk7XG4gIHJlc2V0U2h1ZmZsZSgpO1xuICByZXNldFJ1blN0YXRlKCk7XG4gIHN0YXRlLmN1cnJlbnRQYWlyID0geyBsZWZ0OiBudWxsLCByaWdodDogbnVsbCB9O1xuICBzdGF0ZS5jdXJyZW50UmFua3MgPSB7IGxlZnQ6IG51bGwsIHJpZ2h0OiBudWxsIH07XG4gIHNhdmVTdGF0ZSgpO1xuXG4gIGF3YWl0IGZpbmlzaFNldHVwKGFyZWEsIHN1bW1hcnksIGNob2ljZSwgb25Eb25lKTtcbn1cblxuLyoqIFNhdmUgdGhlIGNvbXBsZXRpb24gZmxhZ3MgKHJldHJ5aW5nIG9uIHJlcXVlc3QpLCB0aGVuIHNob3cgdGhlIHN1bW1hcnkuICovXG5hc3luYyBmdW5jdGlvbiBmaW5pc2hTZXR1cChhcmVhOiBIVE1MRWxlbWVudCwgc3VtbWFyeTogU2V0dXBTdW1tYXJ5LCBjaG9pY2U6IENob2ljZSwgb25Eb25lOiAoKSA9PiB2b2lkKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHNhdmVkID0gYXdhaXQgdXBkYXRlU2V0dGluZ3NOb3coe1xuICAgIGVsb1NldHVwQXQ6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSxcbiAgICBlbG9TZXR1cE1vZGU6IGNob2ljZS5zdGFydCxcbiAgICBzdGFzaFJhdGluZ3M6IGNob2ljZS5zdGFzaFJhdGluZ3MsXG4gIH0pO1xuICBpZiAoIXNhdmVkKSB7XG4gICAgLy8gV2l0aG91dCB0aGUgZmxhZywgc2V0dXAgd291bGQgc2hvdyBhZ2FpbiBvbiB0aGUgbmV4dCBvcGVuOiBrZWVwIGl0IHBlbmRpbmcgaGVyZSB0b29cbiAgICBzdGF0ZS5zZXR0aW5ncyA9IHsgLi4uc3RhdGUuc2V0dGluZ3MsIGVsb1NldHVwQXQ6IG51bGwgfTtcbiAgICBzaG93RXJyb3IoXG4gICAgICBhcmVhLFxuICAgICAgXCJZb3VyIEVMTyBpcyBzYXZlZCwgYnV0IFN0YXNoIEJhdHRsZSBjb3VsZG4ndCByZWNvcmQgaW4gU3Rhc2ggdGhhdCBzZXR1cCBmaW5pc2hlZC5cIixcbiAgICAgICgpID0+IHZvaWQgZmluaXNoU2V0dXAoYXJlYSwgc3VtbWFyeSwgY2hvaWNlLCBvbkRvbmUpLFxuICAgICk7XG4gICAgcmV0dXJuO1xuICB9XG4gIHJ1bm5pbmcgPSBmYWxzZTtcblxuICBjb25zdCBlbG9MaW5lID1cbiAgICBjaG9pY2Uuc3RhcnQgPT09IFwicmF0aW5nc1wiXG4gICAgICA/IGAke3BsdXJhbChzdW1tYXJ5LmVsb1dyaXR0ZW4sIFwic2NlbmVcIil9IGdvdCBhIHN0YXJ0aW5nIEVMTyBmcm9tICR7c3VtbWFyeS5lbG9Xcml0dGVuID09PSAxID8gXCJpdHNcIiA6IFwidGhlaXJcIn0gcmF0aW5nLiBVbnJhdGVkIHNjZW5lcyBzdGF5IHVucmF0ZWQgdW50aWwgdGhleSBiYXR0bGUuYFxuICAgICAgOiBgJHtwbHVyYWwoc3VtbWFyeS5lbG9Xcml0dGVuLCBcInNjZW5lXCIpfSBzdGFydCBhdCAxNTAwIEVMTy5gO1xuICBjb25zdCBjbGVhcmVkTGluZSA9XG4gICAgc3VtbWFyeS5lbG9DbGVhcmVkID4gMCA/IGA8bGk+JHtwbHVyYWwoc3VtbWFyeS5lbG9DbGVhcmVkLCBcInNjZW5lXCIpfSB3aXRob3V0IGEgU3Rhc2ggcmF0aW5nIGhhZCBhbiBvbGQgRUxPIHJlbW92ZWQuPC9saT5gIDogXCJcIjtcbiAgY29uc3Qgb3B0aW9uTGFiZWwgPSBjaG9pY2Uuc3Rhc2hSYXRpbmdzID09PSBcInBlcmNlbnRpbGVcIiA/IFwiUGVyY2VudGlsZVwiIDogXCJTdHJhaWdodC1saW5lXCI7XG4gIGNvbnN0IHJhdGluZ3NMaW5lID1cbiAgICBjaG9pY2Uuc3Rhc2hSYXRpbmdzID09PSBcIm9mZlwiXG4gICAgICA/IFwiU3Rhc2ggcmF0aW5ncyB3ZXJlbid0IGNoYW5nZWQsIGFuZCBiYXR0bGVzIHdvbid0IGNoYW5nZSB0aGVtLlwiXG4gICAgICA6IHN1bW1hcnkucmF0aW5nc1dyaXR0ZW4gPT09IDBcbiAgICAgICAgPyBgU3Rhc2ggcmF0aW5ncyBhbHJlYWR5IG1hdGNoZWQgKCR7b3B0aW9uTGFiZWx9KSwgc28gbm9uZSBjaGFuZ2VkLiBCYXR0bGVzIGtlZXAgdGhlbSBpbiBzdGVwIGZyb20gbm93IG9uLmBcbiAgICAgICAgOiBgJHtwbHVyYWwoc3VtbWFyeS5yYXRpbmdzV3JpdHRlbiwgXCJTdGFzaCByYXRpbmdcIil9IHVwZGF0ZWQgKCR7b3B0aW9uTGFiZWx9KS4gQmF0dGxlcyBrZWVwIHRoZW0gaW4gc3RlcCBmcm9tIG5vdyBvbi5gO1xuXG4gIGFyZWEuaW5uZXJIVE1MID0gYFxuICAgICAgPGRpdiBjbGFzcz1cInNiLXNldHVwIHNiLXNldHVwLWRvbmVcIj5cbiAgICAgICAgPGgyIGNsYXNzPVwic2Itc2V0dXAtdGl0bGVcIj7inIUgRUxPIGlzIHJlYWR5PC9oMj5cbiAgICAgICAgPHVsIGNsYXNzPVwic2Itc2V0dXAtc3VtbWFyeVwiPlxuICAgICAgICAgIDxsaT4ke2Vsb0xpbmV9PC9saT5cbiAgICAgICAgICAke2NsZWFyZWRMaW5lfVxuICAgICAgICAgIDxsaT4ke3JhdGluZ3NMaW5lfTwvbGk+XG4gICAgICAgIDwvdWw+XG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi1zZXR1cC1hY3Rpb25zXCI+XG4gICAgICAgICAgPGJ1dHRvbiB0eXBlPVwiYnV0dG9uXCIgY2xhc3M9XCJidG4gYnRuLXByaW1hcnlcIiBkYXRhLXJvbGU9XCJkb25lXCI+U3RhcnQgYmF0dGxpbmc8L2J1dHRvbj5cbiAgICAgICAgPC9kaXY+XG4gICAgICA8L2Rpdj5gO1xuICBhcmVhLnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLXJvbGU9XCJkb25lXCJdJyk/LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiB7XG4gICAgaGlkZVNldHVwU2NyZWVuKGFyZWEub3duZXJEb2N1bWVudCk7XG4gICAgb25Eb25lKCk7XG4gIH0pO1xufVxuXG5mdW5jdGlvbiBlc2NhcGVIdG1sKHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiB0ZXh0LnJlcGxhY2UoL1smPD5cIl0vZywgKGMpID0+ICh7IFwiJlwiOiBcIiZhbXA7XCIsIFwiPFwiOiBcIiZsdDtcIiwgXCI+XCI6IFwiJmd0O1wiLCAnXCInOiBcIiZxdW90O1wiIH0pW2NdIGFzIHN0cmluZyk7XG59XG5cbmZ1bmN0aW9uIHNob3dFcnJvcihhcmVhOiBIVE1MRWxlbWVudCwgbWVzc2FnZTogc3RyaW5nLCByZXRyeTogKCkgPT4gdm9pZCk6IHZvaWQge1xuICBhcmVhLmlubmVySFRNTCA9IGBcbiAgICAgIDxkaXYgY2xhc3M9XCJzYi1zZXR1cCBzYi1lcnJvci1zY3JlZW5cIj5cbiAgICAgICAgPGRpdiBjbGFzcz1cInNiLWVycm9yLWljb25cIj7imqDvuI88L2Rpdj5cbiAgICAgICAgPHAgY2xhc3M9XCJzYi1lcnJvci1tZXNzYWdlXCI+JHttZXNzYWdlfTwvcD5cbiAgICAgICAgPGJ1dHRvbiB0eXBlPVwiYnV0dG9uXCIgY2xhc3M9XCJidG4gYnRuLXByaW1hcnlcIiBkYXRhLXJvbGU9XCJyZXRyeVwiPlRyeSBhZ2FpbjwvYnV0dG9uPlxuICAgICAgPC9kaXY+YDtcbiAgYXJlYS5xdWVyeVNlbGVjdG9yKCdbZGF0YS1yb2xlPVwicmV0cnlcIl0nKT8uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIHJldHJ5KTtcbn1cbiIsICIvLyBUaGUgYmF0dGxlIG1vZGFsOiBvcGVucy9jbG9zZXMsIHdpcmVzIGNvbnRyb2xzIGFuZCBrZXlib2FyZCBzaG9ydGN1dHMuXG5cbmltcG9ydCB7IGNsZWFyU2NlbmVDYWNoZSB9IGZyb20gXCIuLi9jYWNoZVwiO1xuaW1wb3J0IHsgZmV0Y2hTZXR1cFNjZW5lcyB9IGZyb20gXCIuLi9lbG9TZXR1cFwiO1xuaW1wb3J0IHsgZ2V0U2NlbmVJZEZyb21VcmwsIGhvbGRTdGFzaExpc3RSZWZyZXNoLCBzY2VuZUN1c3RvbUZpZWxkc1N1cHBvcnRlZCB9IGZyb20gXCIuLi9ncmFwaHFsXCI7XG5pbXBvcnQgeyBhcHBseVN0YXNoUmF0aW5ncywgcXVldWVSYXRpbmdXcml0ZSwgU0NFTkVfTUlTU0lOR19FVkVOVCwgc2NoZWR1bGVTdGFzaFJhdGluZ1N5bmMsIHdyaXRlU3Rhc2hSYXRpbmdzIH0gZnJvbSBcIi4uL3JhdGluZ1wiO1xuaW1wb3J0IHsgc3Rhc2hSYXRpbmdDaGFuZ2VzIH0gZnJvbSBcIi4uL3Njb3JlXCI7XG5pbXBvcnQgeyBsb2FkU2V0dGluZ3MgfSBmcm9tIFwiLi4vc2V0dGluZ3NcIjtcbmltcG9ydCB7IGlzRWxvU2V0dXBQZW5kaW5nLCByZXNldFJ1blN0YXRlLCByZXNldFNodWZmbGUsIHN0YXRlIH0gZnJvbSBcIi4uL3N0YXRlXCI7XG5pbXBvcnQgeyBsb2FkU3RhdGUsIHNhdmVTdGF0ZSB9IGZyb20gXCIuLi9zdG9yYWdlXCI7XG5pbXBvcnQgdHlwZSB7IE1vZGUsIFNldHRpbmdzLCBTdGFzaFJhdGluZ3NNb2RlIH0gZnJvbSBcIi4uL3R5cGVzXCI7XG5pbXBvcnQgeyBjYW5jZWxDb25maXJtRGlhbG9nLCBjb25maXJtRGlhbG9nLCBpc0NvbmZpcm1EaWFsb2dPcGVuIH0gZnJvbSBcIi4vY29uZmlybURpYWxvZ1wiO1xuaW1wb3J0IHsgY2FuY2VsRGVsZXRlRGlhbG9nLCBpc0RlbGV0ZURpYWxvZ09wZW4gfSBmcm9tIFwiLi9kZWxldGVEaWFsb2dcIjtcbmltcG9ydCB7XG4gIGFwcGx5UHJldmlld1NldHRpbmdzLFxuICBjcmVhdGVNYWluVUksXG4gIGhhbmRsZVNjZW5lR29uZSxcbiAgbG9hZE5ld1BhaXIsXG4gIHJlbmRlclBhaXIsXG4gIHJlc3RvcmVDdXJyZW50UGFpcixcbiAgc2tpcFBhaXIsXG4gIHVwZGF0ZUNsaW1iUG9vbFdhcm5pbmcsXG4gIHVwZGF0ZU1vZGVJbmZvLFxuICB1cGRhdGVSYXRpbmdzTm90ZSxcbiAgdmVyaWZ5Q3VycmVudFBhaXIsXG59IGZyb20gXCIuL21haW5VSVwiO1xuaW1wb3J0IHsgYmluZFNldHRpbmdzQ29udHJvbHMsIGdldEFjdGl2ZVRhYiwgc2hvd1RhYiwgc3luY1NldHRpbmdzQ29udHJvbHMgfSBmcm9tIFwiLi9zZXR0aW5nc1BhbmVsXCI7XG5pbXBvcnQgeyByZWZyZXNoU2NlbmVFbG8gfSBmcm9tIFwiLi9zY2VuZUVsb1wiO1xuaW1wb3J0IHsgaGlkZVNldHVwU2NyZWVuLCBpc1NldHVwUnVubmluZywgc2hvd1NldHVwU2NyZWVuIH0gZnJvbSBcIi4vc2V0dXBTY3JlZW5cIjtcbmltcG9ydCB7IHN0YXNoUmF0aW5nc09wdGlvbiB9IGZyb20gXCIuL3N0YXNoUmF0aW5nc1RleHRcIjtcblxuLy8gVHJhY2sga2V5Ym9hcmQgaGFuZGxlciBzbyB3ZSBjYW4gcmVtb3ZlIGl0IG9uIGNsb3NlXG5sZXQgbW9kYWxLZXlIYW5kbGVyOiAoKGU6IEtleWJvYXJkRXZlbnQpID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XG5sZXQgc2NlbmVNaXNzaW5nTGlzdGVuZXJBZGRlZCA9IGZhbHNlO1xuXG4vKiogT24gPGJvZHk+IHdoaWxlIEJhdHRsZSBpcyBvcGVuOyBDU1MgdXNlcyBpdCB0byBsaWZ0IFN0YXNoJ3Mgb3duIG1vZGFscyBhYm92ZSBvdXJzLiAqL1xuY29uc3QgQkFUVExFX09QRU5fQ0xBU1MgPSBcInNiLWJhdHRsZS1vcGVuXCI7XG5cbi8qKiBSZS1yZW5kZXIgdGhlIHBhaXIgb24gc2NyZWVuIHNvIGNhcmQgbWFya3VwIHBpY2tzIHVwIGEgY2hhbmdlZCBzZXR0aW5nLiAqL1xuZnVuY3Rpb24gcmVyZW5kZXJDdXJyZW50UGFpcigpOiB2b2lkIHtcbiAgY29uc3QgeyBsZWZ0LCByaWdodCB9ID0gc3RhdGUuY3VycmVudFBhaXI7XG4gIGlmICghbGVmdCB8fCAhcmlnaHQgfHwgc3RhdGUuZGlzYWJsZUNob2ljZSB8fCAhZG9jdW1lbnQucXVlcnlTZWxlY3RvcihcIiNzYi1jb21wYXJpc29uLWFyZWEgLnNiLXZzLWNvbnRhaW5lclwiKSkge1xuICAgIHJldHVybjtcbiAgfVxuICByZW5kZXJQYWlyKFtsZWZ0LCByaWdodF0sIFtzdGF0ZS5jdXJyZW50UmFua3MubGVmdCwgc3RhdGUuY3VycmVudFJhbmtzLnJpZ2h0XSk7XG59XG5cbi8qKlxuICogQmVmb3JlIHRoZSBcIlN0YXNoIHJhdGluZ3NcIiBkcm9wZG93biBjaGFuZ2VzOiBzd2l0Y2hpbmcgdG8gUGVyY2VudGlsZSBvciBTdHJhaWdodC1saW5lIHdhcm5zIGhvd1xuICogbWFueSBTdGFzaCByYXRpbmdzIGNoYW5nZSBhbmQgc3luY3MgdGhlbSBhbGwgb24gY29uZmlybSAoZmFsc2UgcHV0cyB0aGUgZHJvcGRvd24gYmFjaykuXG4gKiBTd2l0Y2hpbmcgdG8gRG9uJ3QgdXBkYXRlLCBvciBhIHN3aXRjaCB0aGF0IGNoYW5nZXMgbm90aGluZywgbmVlZHMgbm8gd2FybmluZy5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gY29uZmlybVNldHRpbmdDaGFuZ2Uoa2V5OiBrZXlvZiBTZXR0aW5ncywgdmFsdWU6IHN0cmluZyk6IFByb21pc2U8Ym9vbGVhbj4ge1xuICBpZiAoa2V5ICE9PSBcInN0YXNoUmF0aW5nc1wiKSByZXR1cm4gdHJ1ZTtcbiAgY29uc3QgbmV4dCA9IHZhbHVlIGFzIFN0YXNoUmF0aW5nc01vZGU7XG4gIGlmIChuZXh0ID09PSBcIm9mZlwiIHx8IG5leHQgPT09IHN0YXRlLnNldHRpbmdzLnN0YXNoUmF0aW5ncykgcmV0dXJuIHRydWU7XG5cbiAgbGV0IGNoYW5nZXM6IE1hcDxzdHJpbmcsIG51bWJlcj47XG4gIHRyeSB7XG4gICAgY2hhbmdlcyA9IHN0YXNoUmF0aW5nQ2hhbmdlcyhhd2FpdCBmZXRjaFNldHVwU2NlbmVzKCksIG5leHQpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIENvdWxkbid0IGxvYWQgc2NlbmVzIHRvIHN3aXRjaCBTdGFzaCByYXRpbmdzOlwiLCBlKTtcbiAgICBhd2FpdCBjb25maXJtRGlhbG9nKHtcbiAgICAgIHRpdGxlOiBcIkNvdWxkbid0IGxvYWQgeW91ciBzY2VuZXNcIixcbiAgICAgIGJvZHk6IFwiPHA+U3Rhc2ggQmF0dGxlIG5lZWRzIHlvdXIgd2hvbGUgbGlicmFyeSB0byB3b3JrIG91dCB0aGUgbmV3IFN0YXNoIHJhdGluZ3MuIE5vdGhpbmcgd2FzIGNoYW5nZWQ7IHRyeSBhZ2Fpbi48L3A+XCIsXG4gICAgICBjb25maXJtTGFiZWw6IFwiT0tcIixcbiAgICB9KTtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgaWYgKGNoYW5nZXMuc2l6ZSA9PT0gMCkgcmV0dXJuIHRydWU7XG5cbiAgY29uc3QgeyBsYWJlbCwgZGVzYyB9ID0gc3Rhc2hSYXRpbmdzT3B0aW9uKG5leHQpO1xuICBjb25zdCBjb3VudCA9IGAke2NoYW5nZXMuc2l6ZX0gU3Rhc2ggcmF0aW5nJHtjaGFuZ2VzLnNpemUgPT09IDEgPyBcIlwiIDogXCJzXCJ9YDtcbiAgcmV0dXJuIGNvbmZpcm1EaWFsb2coe1xuICAgIHRpdGxlOiBgU3dpdGNoIFN0YXNoIHJhdGluZ3MgdXBkYXRlIG1vZGUgdG8gJHtsYWJlbH0/YCxcbiAgICBib2R5OiBgXG4gICAgICAgIDxwPiR7ZGVzY308L3A+XG4gICAgICAgIDxwPjxzdHJvbmc+JHtjb3VudH0gY2hhbmdlIG5vdy48L3N0cm9uZz4gQWZ0ZXIgdGhhdCwgYmF0dGxlcyBrZWVwIFN0YXNoIHJhdGluZ3MgaW4gc3RlcCB3aXRoXG4gICAgICAgIEVMTywgYW5kIGEgc3RhciByYXRpbmcgeW91IGNoYW5nZSBieSBoYW5kIGluIFN0YXNoIGlzIG92ZXJ3cml0dGVuIHRoZSBuZXh0IHRpbWUgU3Rhc2ggQmF0dGxlXG4gICAgICAgIHdyaXRlcyB0aGF0IHNjZW5lLjwvcD5cbiAgICAgICAgPHA+VGFrZSBhIFN0YXNoIGJhY2t1cCBmaXJzdCAoU2V0dGluZ3Mg4oaSIFRhc2tzIOKGkiBCYWNrdXApLjwvcD5gLFxuICAgIGNvbmZpcm1MYWJlbDogYFVwZGF0ZSAke2NvdW50fWAsXG4gICAgd29ya2luZ0xhYmVsOiBcIlVwZGF0aW5nLi4uXCIsXG4gICAgYWN0aW9uOiAoKSA9PlxuICAgICAgcXVldWVSYXRpbmdXcml0ZShhc3luYyAoKSA9PiB7XG4gICAgICAgIGF3YWl0IHdyaXRlU3Rhc2hSYXRpbmdzKGNoYW5nZXMpO1xuICAgICAgICBhcHBseVN0YXNoUmF0aW5ncyhjaGFuZ2VzKTtcbiAgICAgIH0pLFxuICB9KTtcbn1cblxuLyoqIFNldHRpbmdzIOKGkiBSZXNldCBFTE86IGNvbmZpcm0sIHRoZW4gc2hvdyB0aGUgc2V0dXAgY2hvaWNlcyBhZ2FpbiAoQ2FuY2VsIGdvZXMgYmFjaykuICovXG5hc3luYyBmdW5jdGlvbiBzdGFydFJlc2V0RWxvKG1vZGFsOiBIVE1MRWxlbWVudCk6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCByYXRpbmdzT24gPSBzdGF0ZS5zZXR0aW5ncy5zdGFzaFJhdGluZ3MgIT09IFwib2ZmXCI7XG4gIGNvbnN0IG9rID0gYXdhaXQgY29uZmlybURpYWxvZyh7XG4gICAgdGl0bGU6IFwiUmVzZXQgRUxPP1wiLFxuICAgIGJvZHk6IGBcbiAgICAgICAgPHA+RXZlcnkgc2NlbmUncyBFTE8gYW5kIGJhdHRsZSBjb3VudCB3aWxsIGJlIG92ZXJ3cml0dGVuLiBOZXh0IHlvdSBjaG9vc2UgaG93IEVMTyBzdGFydHNcbiAgICAgICAgYWdhaW46IGZyb20geW91ciBTdGFzaCByYXRpbmdzLCBvciAxNTAwIGZvciBldmVyeW9uZS4ke3JhdGluZ3NPbiA/IFwiIFN0YXNoIHJhdGluZ3MgYXJlIHRoZW4gdXBkYXRlZCBmcm9tIHRoZSBuZXcgRUxPLlwiIDogXCJcIn08L3A+XG4gICAgICAgIDxwPk5vdGhpbmcgY2hhbmdlcyB1bnRpbCB5b3UgcHJlc3MgU3RhcnQgb24gdGhlIG5leHQgc2NyZWVuLjwvcD5gLFxuICAgIGNvbmZpcm1MYWJlbDogXCJDb250aW51ZVwiLFxuICB9KTtcbiAgaWYgKCFvaykgcmV0dXJuO1xuXG4gIHN0YXRlLnJlc2V0dGluZ0VsbyA9IHRydWU7XG4gIHNob3dUYWIobW9kYWwsIFwiYmF0dGxlXCIpO1xuICBtb2RhbC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxWaWRlb0VsZW1lbnQ+KFwiLnNiLWhvdmVyLXByZXZpZXdcIikuZm9yRWFjaCgodikgPT4gdi5wYXVzZSgpKTtcbiAgc2hvd1NldHVwU2NyZWVuKG1vZGFsLCAoKSA9PiBhZnRlclNldHVwKG1vZGFsKSwge1xuICAgIHJlc2V0OiB0cnVlLFxuICAgIG9uQ2FuY2VsOiAoKSA9PiB7XG4gICAgICBzdGF0ZS5yZXNldHRpbmdFbG8gPSBmYWxzZTtcbiAgICAgIGhpZGVTZXR1cFNjcmVlbihtb2RhbCk7XG4gICAgICBpZiAoc3RhdGUuY3VycmVudFBhaXIubGVmdCAmJiBzdGF0ZS5jdXJyZW50UGFpci5yaWdodCkgdm9pZCByZXN0b3JlQ3VycmVudFBhaXIoKTtcbiAgICAgIGVsc2Ugdm9pZCBsb2FkTmV3UGFpcigpO1xuICAgIH0sXG4gIH0pO1xufVxuXG4vKiogU2V0dXAgKGZpcnN0IHRpbWUgb3IgUmVzZXQgRUxPKSBmaW5pc2hlZDogc2V0dGluZ3MgaXQgc2F2ZWQgc2hvdywgdGhlbiBiYXR0bGVzIHN0YXJ0LiAqL1xuZnVuY3Rpb24gYWZ0ZXJTZXR1cChtb2RhbDogSFRNTEVsZW1lbnQpOiB2b2lkIHtcbiAgc3RhdGUucmVzZXR0aW5nRWxvID0gZmFsc2U7XG4gIHN5bmNTZXR0aW5nc0NvbnRyb2xzKG1vZGFsKTtcbiAgdXBkYXRlUmF0aW5nc05vdGUoKTtcbiAgdm9pZCBsb2FkTmV3UGFpcihnZXRTY2VuZUlkRnJvbVVybCgpKTtcbn1cblxuZnVuY3Rpb24gb25TZXR0aW5nQ2hhbmdlZChrZXk6IGtleW9mIFNldHRpbmdzKTogdm9pZCB7XG4gIHN3aXRjaCAoa2V5KSB7XG4gICAgY2FzZSBcInN0YXNoUmF0aW5nc1wiOlxuICAgICAgdXBkYXRlUmF0aW5nc05vdGUoKTtcbiAgICAgIC8vIENhdGNoIGFueXRoaW5nIGEgcGVyLWJhdHRsZSBzeW5jIHVuZGVyIHRoZSBvbGQgbW9kZSBjaGFuZ2VkIGFmdGVyIHRoZSBzd2l0Y2ggd2FzIGNvdW50ZWRcbiAgICAgIHNjaGVkdWxlU3Rhc2hSYXRpbmdTeW5jKCk7XG4gICAgICBicmVhaztcbiAgICBjYXNlIFwiZmlsdGVyT3Bwb25lbnRzXCI6XG4gICAgICAvLyBzd2l0Y2hpbmcgdGhlIHRvZ2dsZSBjb3VudHMgYXMgY2hhbmdpbmcgZmlsdGVyczogcmVzZXQgYW55IHJ1blxuICAgICAgaWYgKHN0YXRlLmN1cnJlbnRNb2RlICE9PSBcInN3aXNzXCIpIHJlc2V0UnVuU3RhdGUoKTtcbiAgICAgIHNhdmVTdGF0ZSgpO1xuICAgICAgbG9hZE5ld1BhaXIoKTtcbiAgICAgIHVwZGF0ZUNsaW1iUG9vbFdhcm5pbmcoKTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJwbGFjZW1lbnRGcm9tQm90dG9tXCI6IHtcbiAgICAgIC8vIFJlc3RhcnQgdGhlIHNjZW5lJ3MgcnVuIGZyb20gdGhlIG5ldyBzdGFydCBwb2ludCAobm90aGluZyBpcyB3cml0dGVuIHVudGlsIGl0IGxhbmRzKVxuICAgICAgY29uc3Qgc2NlbmVJZCA9IHN0YXRlLmN1cnJlbnRNb2RlID09PSBcInBsYWNlbWVudFwiID8gc3RhdGUucGxhY2VtZW50Py5zY2VuZS5pZCA6IHVuZGVmaW5lZDtcbiAgICAgIGlmIChzY2VuZUlkKSB7XG4gICAgICAgIHJlc2V0UnVuU3RhdGUoKTtcbiAgICAgICAgc2F2ZVN0YXRlKCk7XG4gICAgICAgIHZvaWQgbG9hZE5ld1BhaXIoc2NlbmVJZCk7XG4gICAgICB9XG4gICAgICBicmVhaztcbiAgICB9XG4gICAgY2FzZSBcInByZXZpZXdWb2x1bWVcIjpcbiAgICBjYXNlIFwiYXV0b3BsYXlQcmV2aWV3c1wiOlxuICAgICAgYXBwbHlQcmV2aWV3U2V0dGluZ3MoKTtcbiAgICAgIGJyZWFrO1xuICAgIGNhc2UgXCJvcGVuSW5OZXdUYWJcIjpcbiAgICBjYXNlIFwiY2xlYW5Nb2RlXCI6XG4gICAgY2FzZSBcInNob3dUaWVyc1wiOlxuICAgICAgcmVyZW5kZXJDdXJyZW50UGFpcigpO1xuICAgICAgYnJlYWs7XG4gIH1cbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG9wZW5Nb2RhbCgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn46vIE9wZW5pbmcgbW9kYWwuLi5cIik7XG5cbiAgY29uc3QgW3NldHRpbmdzT2ssIGN1c3RvbUZpZWxkc09rXSA9IGF3YWl0IFByb21pc2UuYWxsKFtsb2FkU2V0dGluZ3MoKSwgc2NlbmVDdXN0b21GaWVsZHNTdXBwb3J0ZWQoKV0pO1xuICBpZiAoIWN1c3RvbUZpZWxkc09rKSB7XG4gICAgc2hvd01lc3NhZ2VNb2RhbChcbiAgICAgIFwiU3Rhc2ggQmF0dGxlIG5lZWRzIGEgbmV3ZXIgdmVyc2lvbiBvZiBTdGFzaDogaXQgc3RvcmVzIGVhY2ggc2NlbmUncyBFTE8gaW4gc2NlbmUgY3VzdG9tIGZpZWxkcywgd2hpY2ggdGhpcyBTdGFzaCBkb2Vzbid0IGhhdmUuIFVwZGF0ZSBTdGFzaCB0byB1c2UgU3Rhc2ggQmF0dGxlLlwiLFxuICAgICk7XG4gICAgcmV0dXJuO1xuICB9XG4gIC8vIFdpdGhvdXQgc2V0dGluZ3MsIEJhdHRsZSBjYW4ndCB0ZWxsIHdoZXRoZXIgdGhlIG9uZS10aW1lIEVMTyBzZXR1cCBhbHJlYWR5IHJhbiAoYW5kIHJ1bm5pbmdcbiAgLy8gaXQgYWdhaW4gd291bGQgb3ZlcndyaXRlIGV2ZXJ5IHNjZW5lJ3MgRUxPKVxuICBpZiAoIXNldHRpbmdzT2sgJiYgaXNFbG9TZXR1cFBlbmRpbmcoKSkge1xuICAgIHNob3dNZXNzYWdlTW9kYWwoXCJTdGFzaCBCYXR0bGUgY291bGRuJ3QgbG9hZCBpdHMgc2V0dGluZ3MgZnJvbSBTdGFzaC4gQ2xvc2UgU3Rhc2ggQmF0dGxlIGFuZCB0cnkgYWdhaW4uXCIpO1xuICAgIHJldHVybjtcbiAgfVxuICBhZGRLZXlTd2FsbG93ZXJzKCk7XG4gIGhvbGRTdGFzaExpc3RSZWZyZXNoKHRydWUpO1xuXG4gIC8vIE9wdGlvbmFsbHkgcGF1c2Ugd2hhdGV2ZXIgU3Rhc2ggaXMgcGxheWluZyBzbyBpdCBkb2Vzbid0IG92ZXJsYXAgdGhlIGJhdHRsZSBwcmV2aWV3c1xuICBpZiAoc3RhdGUuc2V0dGluZ3MucGF1c2VNZWRpYU9uT3Blbikge1xuICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTE1lZGlhRWxlbWVudD4oXCJ2aWRlbywgYXVkaW9cIikuZm9yRWFjaCgodikgPT4gdi5wYXVzZSgpKTtcbiAgfVxuXG4gIGlmICghc2NlbmVNaXNzaW5nTGlzdGVuZXJBZGRlZCkge1xuICAgIHNjZW5lTWlzc2luZ0xpc3RlbmVyQWRkZWQgPSB0cnVlO1xuICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFNDRU5FX01JU1NJTkdfRVZFTlQsIChlKSA9PiB7XG4gICAgICB2b2lkIGhhbmRsZVNjZW5lR29uZSgoZSBhcyBDdXN0b21FdmVudDxzdHJpbmc+KS5kZXRhaWwpO1xuICAgIH0pO1xuICB9XG5cbiAgLy8gVHJ5IHRvIGxvYWQgc2F2ZWQgc3RhdGVcbiAgY29uc3QgaGFzU3RhdGUgPSBsb2FkU3RhdGUoKTtcbiAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIPCfk4sgTG9jYWxTdG9yYWdlIHN0YXRlOiAke2hhc1N0YXRlID8gXCJmb3VuZFwiIDogXCJub25lXCJ9YCk7XG5cbiAgLy8gQ2hlY2sgaWYgVVJMIGZpbHRlciBwYXJhbXMgaGF2ZSBjaGFuZ2VkIC0gaWYgc28sIHJlc2V0IHN0YXRlXG4gIGNvbnN0IGN1cnJlbnRGaWx0ZXJQYXJhbXMgPSB3aW5kb3cubG9jYXRpb24uc2VhcmNoO1xuICBjb25zdCBmaWx0ZXJzQ2hhbmdlZCA9IGhhc1N0YXRlICYmIHN0YXRlLnNhdmVkRmlsdGVyUGFyYW1zICE9PSBjdXJyZW50RmlsdGVyUGFyYW1zO1xuXG4gIGlmIChmaWx0ZXJzQ2hhbmdlZCkge1xuICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0gRmlsdGVyIHBhcmFtcyBjaGFuZ2VkLCByZXNldHRpbmcgcnVuIHN0YXRlIGFuZCBmaWx0ZXJlZCBjYWNoZVwiKTtcbiAgICBzdGF0ZS5jdXJyZW50UGFpciA9IHsgbGVmdDogbnVsbCwgcmlnaHQ6IG51bGwgfTtcbiAgICBzdGF0ZS5jdXJyZW50UmFua3MgPSB7IGxlZnQ6IG51bGwsIHJpZ2h0OiBudWxsIH07XG4gICAgcmVzZXRSdW5TdGF0ZSgpO1xuICAgIHN0YXRlLnNhdmVkRmlsdGVyUGFyYW1zID0gY3VycmVudEZpbHRlclBhcmFtcztcblxuICAgIC8vIENsZWFyIGZpbHRlcmVkIHNjZW5lcyBjYWNoZSAoYnV0IGtlZXAgYWxsIHNjZW5lcyBjYWNoZSlcbiAgICBzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJlZFNjZW5lcyA9IG51bGw7XG4gICAgc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyS2V5ID0gbnVsbDtcblxuICAgIC8vIFJlc2V0IHNodWZmbGUgZm9yIG5ldyBmaWx0ZXJcbiAgICByZXNldFNodWZmbGUoKTtcbiAgfVxuXG4gIC8vIERldGVjdCBpZiBvcGVuZWQgZnJvbSBhbiBpbmRpdmlkdWFsIHNjZW5lIHBhZ2UgKGUuZy4gL3NjZW5lcy8xMjMpXG4gIGNvbnN0IHNjZW5lUGFnZUlkID0gZ2V0U2NlbmVJZEZyb21VcmwoKTtcbiAgY29uc3Qgc2NlbmVBbHJlYWR5SW5QYWlyID1cbiAgICBzY2VuZVBhZ2VJZCAmJlxuICAgIHN0YXRlLmN1cnJlbnRQYWlyLmxlZnQgJiZcbiAgICBzdGF0ZS5jdXJyZW50UGFpci5yaWdodCAmJlxuICAgIChTdHJpbmcoc3RhdGUuY3VycmVudFBhaXIubGVmdC5pZCkgPT09IHNjZW5lUGFnZUlkIHx8XG4gICAgICBTdHJpbmcoc3RhdGUuY3VycmVudFBhaXIucmlnaHQuaWQpID09PSBzY2VuZVBhZ2VJZCk7XG4gIGNvbnN0IGZvcmNlU2NlbmVCYXR0bGUgPSBzY2VuZVBhZ2VJZCAmJiAhc2NlbmVBbHJlYWR5SW5QYWlyO1xuXG4gIGlmIChmb3JjZVNjZW5lQmF0dGxlKSB7XG4gICAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIPCfjq8gT3BlbmVkIGZyb20gc2NlbmUgcGFnZSAke3NjZW5lUGFnZUlkfSwgc3RhcnRpbmcgbmV3IGJhdHRsZSB3aXRoIHRoaXMgc2NlbmVgKTtcbiAgICByZXNldFJ1blN0YXRlKCk7XG4gICAgc3RhdGUuY3VycmVudFBhaXIgPSB7IGxlZnQ6IG51bGwsIHJpZ2h0OiBudWxsIH07XG4gICAgc3RhdGUuY3VycmVudFJhbmtzID0geyBsZWZ0OiBudWxsLCByaWdodDogbnVsbCB9O1xuICB9XG5cbiAgLy8gQ2hlY2sgZm9yIGV4aXN0aW5nIGhpZGRlbiBtb2RhbCAtIHJldXNlIGl0ICh1bmxlc3MgaXQncyBhIG1lc3NhZ2UgbW9kYWwsIHNlZSBzaG93TWVzc2FnZU1vZGFsKVxuICBjb25zdCBleGlzdGluZ01vZGFsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzYi1tb2RhbFwiKTtcbiAgaWYgKFxuICAgIGV4aXN0aW5nTW9kYWwgJiZcbiAgICBleGlzdGluZ01vZGFsLmNsYXNzTGlzdC5jb250YWlucyhcInNiLW1vZGFsLWhpZGRlblwiKSAmJlxuICAgIGV4aXN0aW5nTW9kYWwucXVlcnlTZWxlY3RvcihcIiNzdGFzaC1iYXR0bGUtY29udGFpbmVyXCIpXG4gICkge1xuICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g4pm777iPIFJldXNpbmcgZXhpc3RpbmcgbW9kYWxcIik7XG4gICAgZXhpc3RpbmdNb2RhbC5jbGFzc0xpc3QucmVtb3ZlKFwic2ItbW9kYWwtaGlkZGVuXCIsIFwic2ItbW9kYWwtY2xvc2luZ1wiKTtcbiAgICBkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5hZGQoQkFUVExFX09QRU5fQ0xBU1MpO1xuXG4gICAgLy8gQWx3YXlzIHJlb3BlbiBvbiB0aGUgQmF0dGxlIHRhYjsgc2V0dGluZ3MgbWF5IGhhdmUgY2hhbmdlZCBlbHNld2hlcmUgbWVhbndoaWxlXG4gICAgc2hvd1RhYihleGlzdGluZ01vZGFsLCBcImJhdHRsZVwiKTtcbiAgICBzeW5jU2V0dGluZ3NDb250cm9scyhleGlzdGluZ01vZGFsKTtcbiAgICB1cGRhdGVSYXRpbmdzTm90ZSgpO1xuXG4gICAgLy8gUmUtcmVnaXN0ZXIga2V5Ym9hcmQgaGFuZGxlclxuICAgIGlmIChtb2RhbEtleUhhbmRsZXIpIHtcbiAgICAgIGRvY3VtZW50LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJrZXlkb3duXCIsIG1vZGFsS2V5SGFuZGxlciwgdHJ1ZSk7XG4gICAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwia2V5ZG93blwiLCBtb2RhbEtleUhhbmRsZXIsIHRydWUpO1xuICAgIH1cblxuICAgIC8vIEZvY3VzIG1vZGFsIGNvbnRlbnRcbiAgICBjb25zdCBtb2RhbENvbnRlbnQgPSBleGlzdGluZ01vZGFsLnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiLnNiLW1vZGFsLWNvbnRlbnRcIik7XG4gICAgaWYgKG1vZGFsQ29udGVudCkgbW9kYWxDb250ZW50LmZvY3VzKCk7XG5cbiAgICAvLyBUaGUgb25lLXRpbWUgRUxPIHNldHVwIHNob3dzIGluIHBsYWNlIG9mIHRoZSBiYXR0bGUgdW50aWwgaXQncyBkb25lXG4gICAgaWYgKGlzRWxvU2V0dXBQZW5kaW5nKCkpIHtcbiAgICAgIHNob3dTZXR1cFNjcmVlbihleGlzdGluZ01vZGFsLCAoKSA9PiBhZnRlclNldHVwKGV4aXN0aW5nTW9kYWwpKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaGlkZVNldHVwU2NyZWVuKGV4aXN0aW5nTW9kYWwpO1xuXG4gICAgLy8gSWYgZmlsdGVycyBjaGFuZ2VkLCBubyBwYWlyLCBvciBmb3JjZWQgc2NlbmUsIGxvYWQgbmV3IGNvbnRlbnRcbiAgICBpZiAoZm9yY2VTY2VuZUJhdHRsZSkge1xuICAgICAgbG9hZE5ld1BhaXIoc2NlbmVQYWdlSWQpO1xuICAgIH0gZWxzZSBpZiAoZmlsdGVyc0NoYW5nZWQpIHtcbiAgICAgIGxvYWROZXdQYWlyKCk7XG4gICAgfSBlbHNlIGlmICghc3RhdGUuY3VycmVudFBhaXIubGVmdCB8fCAhc3RhdGUuY3VycmVudFBhaXIucmlnaHQpIHtcbiAgICAgIC8vIEEgZmluaXNoZWQgcnVuJ3MgZW5kIHNjcmVlbiBzdGF5cyB1bnRpbCBcIlN0YXJ0IE5ldyBSdW5cIiAodGhlIHJ1biBjbGVhcmVkIGl0cyBwYWlyKVxuICAgICAgaWYgKCFkb2N1bWVudC5xdWVyeVNlbGVjdG9yKFwiI3NiLWNvbXBhcmlzb24tYXJlYSAuc2ItZW5kLXNjcmVlblwiKSkgbG9hZE5ld1BhaXIoKTtcbiAgICB9IGVsc2UgaWYgKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoXCIjc2ItY29tcGFyaXNvbi1hcmVhIC5zYi12cy1jb250YWluZXJcIikpIHtcbiAgICAgIC8vIEV4aXN0aW5nIHBhaXIgaXMgc3RpbGwgdmFsaWQgdW5sZXNzIGEgc2NlbmUgd2FzIGRlbGV0ZWQgZWxzZXdoZXJlIG1lYW53aGlsZVxuICAgICAgYXBwbHlQcmV2aWV3U2V0dGluZ3MoKTtcbiAgICAgIHZvaWQgdmVyaWZ5Q3VycmVudFBhaXIoKTtcbiAgICB9XG5cbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBSZW1vdmUgYW55IG90aGVyIGV4aXN0aW5nIG1vZGFsIChhIG1lc3NhZ2UgbW9kYWwsIG9yIGEgdmlzaWJsZSBvbmUsIHdoaWNoIHNob3VsZG4ndCBoYXBwZW4pXG4gIGlmIChleGlzdGluZ01vZGFsKSBleGlzdGluZ01vZGFsLnJlbW92ZSgpO1xuXG4gIC8vIEluaXRpYWxpemUgZmlsdGVyIHBhcmFtcyB0cmFja2luZ1xuICBpZiAoIXN0YXRlLnNhdmVkRmlsdGVyUGFyYW1zKSB7XG4gICAgc3RhdGUuc2F2ZWRGaWx0ZXJQYXJhbXMgPSBjdXJyZW50RmlsdGVyUGFyYW1zO1xuICB9XG5cbiAgY29uc3QgbW9kYWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBtb2RhbC5pZCA9IFwic2ItbW9kYWxcIjtcbiAgbW9kYWwuaW5uZXJIVE1MID0gYFxuICAgICAgPGRpdiBjbGFzcz1cInNiLW1vZGFsLWJhY2tkcm9wXCI+PC9kaXY+XG4gICAgICA8ZGl2IGNsYXNzPVwic2ItbW9kYWwtY29udGVudFwiPlxuICAgICAgICA8YnV0dG9uIGNsYXNzPVwic2ItbW9kYWwtY2xvc2VcIiBhcmlhLWxhYmVsPVwiQ2xvc2VcIj7inJU8L2J1dHRvbj5cbiAgICAgICAgJHtjcmVhdGVNYWluVUkoKX1cbiAgICAgIDwvZGl2PlxuICAgIGA7XG5cbiAgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZChtb2RhbCk7XG4gIGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LmFkZChCQVRUTEVfT1BFTl9DTEFTUyk7XG5cbiAgLy8gRm9jdXMgdGhlIG1vZGFsIGNvbnRlbnQgc28ga2V5Ym9hcmQgc2hvcnRjdXRzIHdvcmsgaW1tZWRpYXRlbHlcbiAgY29uc3QgbW9kYWxDb250ZW50ID0gbW9kYWwucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCIuc2ItbW9kYWwtY29udGVudFwiKTtcbiAgaWYgKG1vZGFsQ29udGVudCkge1xuICAgIG1vZGFsQ29udGVudC5zZXRBdHRyaWJ1dGUoXCJ0YWJpbmRleFwiLCBcIi0xXCIpO1xuICAgIG1vZGFsQ29udGVudC5zdHlsZS5vdXRsaW5lID0gXCJub25lXCI7XG4gICAgbW9kYWxDb250ZW50LmZvY3VzKCk7XG4gIH1cblxuICAvLyBNb2RlIHRvZ2dsZSBidXR0b25zXG4gIG1vZGFsLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KFwiLnNiLW1vZGUtYnRuXCIpLmZvckVhY2goKGJ0bikgPT4ge1xuICAgIGJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4ge1xuICAgICAgY29uc3QgbmV3TW9kZSA9IGJ0bi5kYXRhc2V0Lm1vZGUgYXMgTW9kZTtcbiAgICAgIGlmIChuZXdNb2RlICE9PSBzdGF0ZS5jdXJyZW50TW9kZSkge1xuICAgICAgICBzdGF0ZS5jdXJyZW50TW9kZSA9IG5ld01vZGU7XG5cbiAgICAgICAgcmVzZXRSdW5TdGF0ZSgpO1xuXG4gICAgICAgIC8vIFJlc2V0IHNodWZmbGUgdG8gc3RhcnQgZnJlc2ggd2l0aCBuZXcgbW9kZVxuICAgICAgICBzdGF0ZS5zaHVmZmxlSW5kZXggPSAwO1xuXG4gICAgICAgIC8vIFVwZGF0ZSBidXR0b24gc3RhdGVzXG4gICAgICAgIG1vZGFsLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KFwiLnNiLW1vZGUtYnRuXCIpLmZvckVhY2goKGIpID0+IHtcbiAgICAgICAgICBiLmNsYXNzTGlzdC50b2dnbGUoXCJhY3RpdmVcIiwgYi5kYXRhc2V0Lm1vZGUgPT09IHN0YXRlLmN1cnJlbnRNb2RlKTtcbiAgICAgICAgfSk7XG4gICAgICAgIHVwZGF0ZU1vZGVJbmZvKCk7XG5cbiAgICAgICAgLy8gTG9hZCBuZXcgcGFpciBpbiBuZXcgbW9kZSwgcHJlc2VydmluZyBzY2VuZSBwYWdlIGNvbnRleHRcbiAgICAgICAgbG9hZE5ld1BhaXIoZ2V0U2NlbmVJZEZyb21VcmwoKSk7XG4gICAgICAgIHVwZGF0ZUNsaW1iUG9vbFdhcm5pbmcoKTtcbiAgICAgICAgc2F2ZVN0YXRlKCk7XG4gICAgICB9XG4gICAgfSk7XG4gIH0pO1xuXG4gIC8vIFRvdWNoLW9ubHkg4pOYOiBzaG93L2hpZGUgdGhlIGN1cnJlbnQgbW9kZSdzIGV4cGxhbmF0aW9uXG4gIGNvbnN0IG1vZGVJbmZvQnRuID0gbW9kYWwucXVlcnlTZWxlY3RvcjxIVE1MQnV0dG9uRWxlbWVudD4oXCIuc2ItbW9kZS1pbmZvLWJ0blwiKTtcbiAgY29uc3QgbW9kZUluZm8gPSBtb2RhbC5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIiNzYi1tb2RlLWluZm9cIik7XG4gIG1vZGVJbmZvQnRuPy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4ge1xuICAgIGlmICghbW9kZUluZm8pIHJldHVybjtcbiAgICB1cGRhdGVNb2RlSW5mbygpO1xuICAgIG1vZGVJbmZvLmhpZGRlbiA9ICFtb2RlSW5mby5oaWRkZW47XG4gICAgbW9kZUluZm9CdG4uc2V0QXR0cmlidXRlKFwiYXJpYS1leHBhbmRlZFwiLCBTdHJpbmcoIW1vZGVJbmZvLmhpZGRlbikpO1xuICB9KTtcblxuICAvLyBCYXR0bGUgLyBTZXR0aW5ncyB0YWJzLCBzZXR0aW5ncyBjb250cm9scywgdm9sdW1lXG4gIHNob3dUYWIobW9kYWwsIFwiYmF0dGxlXCIpO1xuICBiaW5kU2V0dGluZ3NDb250cm9scyhtb2RhbCwgb25TZXR0aW5nQ2hhbmdlZCwgKCkgPT4gYXBwbHlQcmV2aWV3U2V0dGluZ3MoKSwgY29uZmlybVNldHRpbmdDaGFuZ2UpO1xuICB1cGRhdGVSYXRpbmdzTm90ZSgpO1xuXG4gIG1vZGFsLnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLWFjdGlvbj1cInJlc2V0LWVsb1wiXScpPy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4gdm9pZCBzdGFydFJlc2V0RWxvKG1vZGFsKSk7XG4gIC8vIEJhdHRsZSB0YWIgbm90ZSdzIFwiY2hhbmdlIGluIFNldHRpbmdzXCIgbGlua1xuICBtb2RhbC5xdWVyeVNlbGVjdG9yKCdbZGF0YS1hY3Rpb249XCJvcGVuLXNldHRpbmdzXCJdJyk/LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZSkgPT4ge1xuICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICBzaG93VGFiKG1vZGFsLCBcInNldHRpbmdzXCIpO1xuICAgIGFwcGx5UHJldmlld1NldHRpbmdzKCk7XG4gIH0pO1xuXG4gIC8vIFNraXAgYnV0dG9uXG4gIG1vZGFsLnF1ZXJ5U2VsZWN0b3IoXCIjc2Itc2tpcC1idG5cIik/LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBza2lwUGFpcik7XG5cbiAgLy8gUmVmcmVzaCBjYWNoZSBidXR0b25cbiAgY29uc3QgcmVmcmVzaENhY2hlQnRuID0gbW9kYWwucXVlcnlTZWxlY3RvcjxIVE1MQnV0dG9uRWxlbWVudD4oXCIjc2ItcmVmcmVzaC1jYWNoZS1idG5cIik7XG4gIGlmIChyZWZyZXNoQ2FjaGVCdG4pIHtcbiAgICByZWZyZXNoQ2FjaGVCdG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIGFzeW5jICgpID0+IHtcbiAgICAgIGlmIChzdGF0ZS5kaXNhYmxlQ2hvaWNlKSByZXR1cm47XG5cbiAgICAgIGNvbnN0IGxhYmVsID0gcmVmcmVzaENhY2hlQnRuLnRleHRDb250ZW50O1xuICAgICAgcmVmcmVzaENhY2hlQnRuLmRpc2FibGVkID0gdHJ1ZTtcbiAgICAgIHJlZnJlc2hDYWNoZUJ0bi50ZXh0Q29udGVudCA9IFwi8J+UhCBSZWZyZXNoaW5nLi4uXCI7XG5cbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IGNsZWFyU2NlbmVDYWNoZSgpO1xuXG4gICAgICAgIC8vIFJlc2V0IHNodWZmbGUgc3RhdGUgc2luY2Ugc2NlbmUgbGlzdCBpcyBiZWluZyByZWZyZXNoZWRcbiAgICAgICAgcmVzZXRTaHVmZmxlKCk7XG5cbiAgICAgICAgLy8gUmVzZXQgcnVuIHN0YXRlIHNpbmNlIHJhbmtpbmdzIG1heSBoYXZlIGNoYW5nZWRcbiAgICAgICAgcmVzZXRSdW5TdGF0ZSgpO1xuICAgICAgICBzYXZlU3RhdGUoKTtcblxuICAgICAgICBhd2FpdCBsb2FkTmV3UGFpcigpO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0gUmVmcmVzaCBmYWlsZWQ6XCIsIGUpO1xuICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgcmVmcmVzaENhY2hlQnRuLmRpc2FibGVkID0gZmFsc2U7XG4gICAgICAgIHJlZnJlc2hDYWNoZUJ0bi50ZXh0Q29udGVudCA9IGxhYmVsO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG5cbiAgLy8gTG9hZCBpbml0aWFsIGNvbXBhcmlzb24gb3IgcmVzdG9yZSBzYXZlZCBwYWlyLCBhZnRlciB0aGUgb25lLXRpbWUgRUxPIHNldHVwIGlmIGl0J3MgcGVuZGluZ1xuICBpZiAoaXNFbG9TZXR1cFBlbmRpbmcoKSkge1xuICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+nrSBFTE8gc2V0dXAgbm90IGRvbmUgeWV0LCBzaG93aW5nIHNldHVwXCIpO1xuICAgIHNob3dTZXR1cFNjcmVlbihtb2RhbCwgKCkgPT4gYWZ0ZXJTZXR1cChtb2RhbCkpO1xuICB9IGVsc2UgaWYgKGZvcmNlU2NlbmVCYXR0bGUpIHtcbiAgICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g8J+OryBTdGFydGluZyBiYXR0bGUgd2l0aCBzY2VuZSAke3NjZW5lUGFnZUlkfSBmcm9tIHNjZW5lIHBhZ2VgKTtcbiAgICBsb2FkTmV3UGFpcihzY2VuZVBhZ2VJZCk7XG4gIH0gZWxzZSBpZiAoaGFzU3RhdGUgJiYgc3RhdGUuY3VycmVudFBhaXIubGVmdCAmJiBzdGF0ZS5jdXJyZW50UGFpci5yaWdodCAmJiAhZmlsdGVyc0NoYW5nZWQpIHtcbiAgICBjb25zb2xlLmxvZyhcbiAgICAgIGBbU3Rhc2ggQmF0dGxlXSDwn5OCIFJlc3RvcmluZyBzYXZlZCBwYWlyIGZyb20gbG9jYWxTdG9yYWdlIChTY2VuZSAke3N0YXRlLmN1cnJlbnRQYWlyLmxlZnQuaWR9IHZzIFNjZW5lICR7c3RhdGUuY3VycmVudFBhaXIucmlnaHQuaWR9KWAsXG4gICAgKTtcbiAgICB2b2lkIHJlc3RvcmVDdXJyZW50UGFpcigpO1xuICB9IGVsc2Uge1xuICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+GlSBObyBzYXZlZCBwYWlyIG9yIGZpbHRlcnMgY2hhbmdlZCwgbG9hZGluZyBuZXcgcGFpci4uLlwiKTtcbiAgICBsb2FkTmV3UGFpcigpO1xuICB9XG5cbiAgLy8gQ2xvc2UgaGFuZGxlcnNcbiAgbW9kYWwucXVlcnlTZWxlY3RvcihcIi5zYi1tb2RhbC1iYWNrZHJvcFwiKT8uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIGNsb3NlTW9kYWwpO1xuICBtb2RhbC5xdWVyeVNlbGVjdG9yKFwiLnNiLW1vZGFsLWNsb3NlXCIpPy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgY2xvc2VNb2RhbCk7XG5cbiAgLy8gUmVtb3ZlIGFueSBleGlzdGluZyBrZXlib2FyZCBoYW5kbGVycyBiZWZvcmUgYWRkaW5nIG5ldyBvbmVzXG4gIGlmIChtb2RhbEtleUhhbmRsZXIpIHtcbiAgICBkb2N1bWVudC5yZW1vdmVFdmVudExpc3RlbmVyKFwia2V5ZG93blwiLCBtb2RhbEtleUhhbmRsZXIsIHRydWUpO1xuICB9XG5cbiAgLy8gU2luZ2xlIGtleWJvYXJkIGhhbmRsZXIgZm9yIGFsbCBtb2RhbCBzaG9ydGN1dHNcbiAgbW9kYWxLZXlIYW5kbGVyID0gZnVuY3Rpb24gKGU6IEtleWJvYXJkRXZlbnQpIHtcbiAgICBjb25zdCBhY3RpdmVNb2RhbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic2ItbW9kYWxcIik7XG4gICAgaWYgKCFhY3RpdmVNb2RhbCkge1xuICAgICAgaWYgKG1vZGFsS2V5SGFuZGxlcikgZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImtleWRvd25cIiwgbW9kYWxLZXlIYW5kbGVyLCB0cnVlKTtcbiAgICAgIG1vZGFsS2V5SGFuZGxlciA9IG51bGw7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gU3Rhc2gncyBvd24gZGVsZXRlIGRpYWxvZyAoQ2xlYW4gbW9kZSkgaXMgb24gdG9wOiBsZXQgaXQgaGF2ZSB0aGUga2V5cyAoRXNjYXBlLCBFbnRlcilcbiAgICBpZiAoaXNEZWxldGVEaWFsb2dPcGVuKCkpIHJldHVybjtcblxuICAgIC8vIE5vdGhpbmcgdHlwZWQgd2hpbGUgQmF0dGxlIGlzIG9wZW4gbWF5IHJlYWNoIFN0YXNoJ3Mgb3duIGhvdGtleXMgKHBhZ2UgYXJyb3dzLCBsZXR0ZXJcbiAgICAvLyBzaG9ydGN1dHMpLCBvciBpdCBhY3RzIG9uIHRoZSBwYWdlIGJlaGluZCB0aGUgbW9kYWwuIERlZmF1bHQgYWN0aW9ucyAodHlwaW5nIGluIGlucHV0cyxcbiAgICAvLyBzbGlkZXIgYXJyb3dzLCBjaGVja2JveCBTcGFjZSkgc3RpbGwgaGFwcGVuIHNpbmNlIG9ubHkgcHJvcGFnYXRpb24gaXMgc3RvcHBlZCBoZXJlLlxuICAgIGUuc3RvcEltbWVkaWF0ZVByb3BhZ2F0aW9uKCk7XG5cbiAgICAvLyBBIGNvbmZpcm1hdGlvbiBkaWFsb2cgaXMgb3BlbjogRXNjYXBlIGNhbmNlbHMgaXQsIG90aGVyIGtleXMgYXJlIGl0cyBvd24gKFRhYiwgRW50ZXIpXG4gICAgaWYgKGlzQ29uZmlybURpYWxvZ09wZW4oKSkge1xuICAgICAgaWYgKGUua2V5ID09PSBcIkVzY2FwZVwiKSB7XG4gICAgICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICAgICAgY2FuY2VsQ29uZmlybURpYWxvZygpO1xuICAgICAgfVxuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIEVzY2FwZSB0byBjbG9zZVxuICAgIGlmIChlLmtleSA9PT0gXCJFc2NhcGVcIikge1xuICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgY2xvc2VNb2RhbCgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIEJhdHRsZSBzaG9ydGN1dHMgb25seSBhcHBseSBvbiB0aGUgQmF0dGxlIHRhYiwgb25jZSBFTE8gc2V0dXAgaXMgZG9uZVxuICAgIGlmIChnZXRBY3RpdmVUYWIoKSAhPT0gXCJiYXR0bGVcIiB8fCBpc0Vsb1NldHVwUGVuZGluZygpKSByZXR1cm47XG5cbiAgICAvLyBMZXQgdGhlIHZvbHVtZSBzbGlkZXIgLyBudW1iZXIgaW5wdXQga2VlcCB0aGVpciBvd24gYXJyb3cga2V5cyAoY2hlY2tib3hlcyBkb24ndCBuZWVkIHRoZW0pXG4gICAgY29uc3QgYWN0aXZlID0gZG9jdW1lbnQuYWN0aXZlRWxlbWVudCBhcyBIVE1MSW5wdXRFbGVtZW50IHwgbnVsbDtcbiAgICBjb25zdCB0YWcgPSBhY3RpdmU/LnRhZ05hbWU7XG4gICAgY29uc3QgaXNUb2dnbGUgPSB0YWcgPT09IFwiSU5QVVRcIiAmJiAoYWN0aXZlPy50eXBlID09PSBcImNoZWNrYm94XCIgfHwgYWN0aXZlPy50eXBlID09PSBcInJhZGlvXCIpO1xuICAgIGlmICgodGFnID09PSBcIklOUFVUXCIgJiYgIWlzVG9nZ2xlKSB8fCB0YWcgPT09IFwiVEVYVEFSRUFcIiB8fCB0YWcgPT09IFwiU0VMRUNUXCIpIHJldHVybjtcblxuICAgIC8vIEFycm93IGtleXMgdG8gY2hvb3NlXG4gICAgaWYgKGUua2V5ID09PSBcIkFycm93TGVmdFwiICYmIHN0YXRlLmN1cnJlbnRQYWlyLmxlZnQpIHtcbiAgICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICAgIGNvbnN0IGxlZnRCb2R5ID0gYWN0aXZlTW9kYWwucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oJy5zYi1zY2VuZS1jYXJkW2RhdGEtc2lkZT1cImxlZnRcIl0gLnNiLXNjZW5lLWJvZHknKTtcbiAgICAgIGlmIChsZWZ0Qm9keSkgbGVmdEJvZHkuY2xpY2soKTtcbiAgICB9XG4gICAgaWYgKGUua2V5ID09PSBcIkFycm93UmlnaHRcIiAmJiBzdGF0ZS5jdXJyZW50UGFpci5yaWdodCkge1xuICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgY29uc3QgcmlnaHRCb2R5ID0gYWN0aXZlTW9kYWwucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oJy5zYi1zY2VuZS1jYXJkW2RhdGEtc2lkZT1cInJpZ2h0XCJdIC5zYi1zY2VuZS1ib2R5Jyk7XG4gICAgICBpZiAocmlnaHRCb2R5KSByaWdodEJvZHkuY2xpY2soKTtcbiAgICB9XG5cbiAgICAvLyBTcGFjZWJhciB0byBza2lwXG4gICAgaWYgKGUua2V5ID09PSBcIiBcIiB8fCBlLmNvZGUgPT09IFwiU3BhY2VcIikge1xuICAgICAgLy8gTGV0IGEgZm9jdXNlZCBidXR0b24gb3IgY2hlY2tib3ggaGFuZGxlIGl0cyBvd24gU3BhY2VcbiAgICAgIGlmICh0YWcgPT09IFwiQlVUVE9OXCIgfHwgaXNUb2dnbGUpIHJldHVybjtcbiAgICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICAgIHNraXBQYWlyKCk7XG4gICAgfVxuICB9O1xuXG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJrZXlkb3duXCIsIG1vZGFsS2V5SGFuZGxlciwgdHJ1ZSk7XG59XG5cbi8qKiBBIG1vZGFsIHdpdGgganVzdCBhIG1lc3NhZ2UsIHNob3duIGluc3RlYWQgb2YgQmF0dGxlIChlLmcuIHRoaXMgU3Rhc2ggbGFja3MgY3VzdG9tIGZpZWxkcykuICovXG5mdW5jdGlvbiBzaG93TWVzc2FnZU1vZGFsKG1lc3NhZ2U6IHN0cmluZyk6IHZvaWQge1xuICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInNiLW1vZGFsXCIpPy5yZW1vdmUoKTtcbiAgY29uc3QgbW9kYWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBtb2RhbC5pZCA9IFwic2ItbW9kYWxcIjtcbiAgbW9kYWwuaW5uZXJIVE1MID0gYFxuICAgICAgPGRpdiBjbGFzcz1cInNiLW1vZGFsLWJhY2tkcm9wXCI+PC9kaXY+XG4gICAgICA8ZGl2IGNsYXNzPVwic2ItbW9kYWwtY29udGVudFwiPlxuICAgICAgICA8YnV0dG9uIGNsYXNzPVwic2ItbW9kYWwtY2xvc2VcIiBhcmlhLWxhYmVsPVwiQ2xvc2VcIj7inJU8L2J1dHRvbj5cbiAgICAgICAgPGRpdiBjbGFzcz1cInNiLWVycm9yLXNjcmVlblwiPlxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1lcnJvci1pY29uXCI+4pqg77iPPC9kaXY+XG4gICAgICAgICAgPHAgY2xhc3M9XCJzYi1lcnJvci1tZXNzYWdlXCI+JHttZXNzYWdlfTwvcD5cbiAgICAgICAgPC9kaXY+XG4gICAgICA8L2Rpdj5cbiAgICBgO1xuICBkb2N1bWVudC5ib2R5LmFwcGVuZENoaWxkKG1vZGFsKTtcbiAgZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QuYWRkKEJBVFRMRV9PUEVOX0NMQVNTKTtcbiAgbW9kYWwucXVlcnlTZWxlY3RvcihcIi5zYi1tb2RhbC1iYWNrZHJvcFwiKT8uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIGNsb3NlTW9kYWwpO1xuICBtb2RhbC5xdWVyeVNlbGVjdG9yKFwiLnNiLW1vZGFsLWNsb3NlXCIpPy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgY2xvc2VNb2RhbCk7XG59XG5cbi8qKiBUcnVlIHdoaWxlIHRoZSBiYXR0bGUgbW9kYWwgaXMgb24gc2NyZWVuIChpdCBzdGF5cyBpbiB0aGUgRE9NLCBoaWRkZW4sIGFmdGVyIGNsb3NpbmcpLiAqL1xuZnVuY3Rpb24gaXNNb2RhbFZpc2libGUoKTogYm9vbGVhbiB7XG4gIGNvbnN0IG1vZGFsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzYi1tb2RhbFwiKTtcbiAgcmV0dXJuIG1vZGFsICE9PSBudWxsICYmICFtb2RhbC5jbGFzc0xpc3QuY29udGFpbnMoXCJzYi1tb2RhbC1oaWRkZW5cIik7XG59XG5cbi8vIFN0YXNoJ3MgaG90a2V5cyAoTW91c2V0cmFwKSBhbHNvIGxpc3RlbiBmb3Iga2V5cHJlc3Mva2V5dXAgb24gZG9jdW1lbnQ7IGtleWRvd24gaXMgaGFuZGxlZFxuLy8gYnkgbW9kYWxLZXlIYW5kbGVyLiBSZWdpc3RlcmVkIG9uY2UsIGluIHRoZSBjYXB0dXJlIHBoYXNlLCBhbmQgaW5lcnQgd2hpbGUgdGhlIG1vZGFsIGlzIGhpZGRlbi5cbmxldCBrZXlTd2FsbG93ZXJzQWRkZWQgPSBmYWxzZTtcbmZ1bmN0aW9uIGFkZEtleVN3YWxsb3dlcnMoKTogdm9pZCB7XG4gIGlmIChrZXlTd2FsbG93ZXJzQWRkZWQpIHJldHVybjtcbiAga2V5U3dhbGxvd2Vyc0FkZGVkID0gdHJ1ZTtcbiAgY29uc3Qgc3dhbGxvdyA9IChlOiBLZXlib2FyZEV2ZW50KTogdm9pZCA9PiB7XG4gICAgaWYgKGlzTW9kYWxWaXNpYmxlKCkgJiYgIWlzRGVsZXRlRGlhbG9nT3BlbigpKSBlLnN0b3BJbW1lZGlhdGVQcm9wYWdhdGlvbigpO1xuICB9O1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwia2V5cHJlc3NcIiwgc3dhbGxvdywgdHJ1ZSk7XG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJrZXl1cFwiLCBzd2FsbG93LCB0cnVlKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNsb3NlTW9kYWwoKTogdm9pZCB7XG4gIGNvbnN0IG1vZGFsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzYi1tb2RhbFwiKTtcbiAgaWYgKCFtb2RhbCB8fCBtb2RhbC5jbGFzc0xpc3QuY29udGFpbnMoXCJzYi1tb2RhbC1oaWRkZW5cIikpIHJldHVybjtcblxuICBjYW5jZWxEZWxldGVEaWFsb2coKTtcbiAgY2FuY2VsQ29uZmlybURpYWxvZygpO1xuICAvLyBTdGFzaCdzIHNjZW5lIGxpc3RzIHNob3cgdGhlIHJhdGluZ3Mgd3JpdHRlbiB3aGlsZSBTdGFzaCBCYXR0bGUgd2FzIG9wZW4sIGFuZCBhIHNjZW5lIHBhZ2UgaXRzIEVMT1xuICBob2xkU3Rhc2hMaXN0UmVmcmVzaChmYWxzZSk7XG4gIHJlZnJlc2hTY2VuZUVsbygpO1xuICAvLyBDbG9zaW5nIFN0YXNoIEJhdHRsZSBvbiBSZXNldCBFTE8ncyBjaG9pY2VzIChiZWZvcmUgU3RhcnQpIGNhbmNlbHMgdGhlIHJlc2V0XG4gIGlmIChzdGF0ZS5yZXNldHRpbmdFbG8gJiYgIWlzU2V0dXBSdW5uaW5nKCkpIHtcbiAgICBzdGF0ZS5yZXNldHRpbmdFbG8gPSBmYWxzZTtcbiAgICBoaWRlU2V0dXBTY3JlZW4obW9kYWwpO1xuICB9XG5cbiAgLy8gU3RvcCBwcmV2aWV3cyAoYXV0b3BsYXkga2VlcHMgdGhlbSBydW5uaW5nIG90aGVyd2lzZSlcbiAgbW9kYWwucXVlcnlTZWxlY3RvckFsbDxIVE1MVmlkZW9FbGVtZW50PihcIi5zYi1ob3Zlci1wcmV2aWV3XCIpLmZvckVhY2goKHYpID0+IHYucGF1c2UoKSk7XG5cbiAgLy8gQWRkIGNsb3NpbmcgY2xhc3MgdG8gdHJpZ2dlciBmYWRlLW91dCBhbmltYXRpb25cbiAgbW9kYWwuY2xhc3NMaXN0LmFkZChcInNiLW1vZGFsLWNsb3NpbmdcIik7XG5cbiAgLy8gQWZ0ZXIgYW5pbWF0aW9uIGNvbXBsZXRlcywgaGlkZSB0aGUgbW9kYWwgKGtlZXAgaW4gRE9NIGZvciByZXVzZSlcbiAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgbW9kYWwuY2xhc3NMaXN0LmFkZChcInNiLW1vZGFsLWhpZGRlblwiKTtcbiAgICBkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5yZW1vdmUoQkFUVExFX09QRU5fQ0xBU1MpO1xuICAgIG1vZGFsLmNsYXNzTGlzdC5yZW1vdmUoXCJzYi1tb2RhbC1jbG9zaW5nXCIpO1xuICB9LCAyMDApOyAvLyBNYXRjaCBDU1MgYW5pbWF0aW9uIGR1cmF0aW9uXG5cbiAgLy8gQ2xlYW4gdXAga2V5Ym9hcmQgaGFuZGxlclxuICBpZiAobW9kYWxLZXlIYW5kbGVyKSB7XG4gICAgZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImtleWRvd25cIiwgbW9kYWxLZXlIYW5kbGVyLCB0cnVlKTtcbiAgfVxufVxuXG4iLCAiLy8gVGhlIG5hdmJhciBcIkJhdHRsZVwiIGJ1dHRvbiB0aGF0IG9wZW5zIHRoZSBjb21wYXJpc29uIG1vZGFsLlxuLy9cbi8vIFdoZXJlIFN0YXNoIGhhcyB0aGUgcGx1Z2luIHBhdGNoIEFQSSwgdGhlIGJ1dHRvbiBpcyBwYXRjaGVkIGludG8gTWFpbk5hdkJhci5NZW51SXRlbXMgKGFmdGVyXG4vLyBTdGFzaCdzIG93biBwYWdlIGxpbmtzKSwgc28gUmVhY3QgcmVuZGVycyBpdCB3aXRoIHRoZSByZXN0IG9mIHRoZSBuYXZiYXIuIE90aGVyd2lzZSBpdCdzIGFkZGVkXG4vLyB0byB0aGUgRE9NIGRpcmVjdGx5IGFuZCByZS1hZGRlZCB3aGVuZXZlciB0aGUgcGFnZSBjaGFuZ2VzLlxuXG5pbXBvcnQgdHlwZSB7IFBsdWdpbkFwaUxpa2UsIFJlYWN0Tm9kZSB9IGZyb20gXCIuLi9wbHVnaW5BcGlcIjtcbmltcG9ydCB7IFNXT1JEU19QQVRIUyB9IGZyb20gXCIuL2ljb25zXCI7XG5pbXBvcnQgeyBvcGVuTW9kYWwgfSBmcm9tIFwiLi9tb2RhbFwiO1xuXG5jb25zdCBCVVRUT05fSUQgPSBcInBsdWdpbl9zYlwiO1xuY29uc3QgTkFWX0lURU1fQ0xBU1MgPSBcImNvbC00IGNvbC1zbS0zIGNvbC1tZC0yIGNvbC1sZy1hdXRvIG5hdi1saW5rXCI7XG5jb25zdCBMSU5LX0NMQVNTID1cbiAgXCJtaW5pbWFsIHAtNCBwLXhsLTIgZC1mbGV4IGQteGwtaW5saW5lLWJsb2NrIGZsZXgtY29sdW1uIGp1c3RpZnktY29udGVudC1iZXR3ZWVuIGFsaWduLWl0ZW1zLWNlbnRlciBidG4gYnRuLXByaW1hcnlcIjtcbmNvbnN0IExJTktfSFRNTCA9IGBcbiAgICAgICAgICAgIDxzdmcgYXJpYS1oaWRkZW49XCJ0cnVlXCIgZm9jdXNhYmxlPVwiZmFsc2VcIiBjbGFzcz1cInN2Zy1pbmxpbmUtLWZhIGZhLWljb24gbmF2LW1lbnUtaWNvbiBkLWJsb2NrIGQteGwtaW5saW5lIG1iLTIgbWIteGwtMFwiIHJvbGU9XCJpbWdcIiB4bWxucz1cImh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnXCIgdmlld0JveD1cIjAgMCAzNiAzNlwiPiR7U1dPUkRTX1BBVEhTfTwvc3ZnPlxuICAgICAgICAgICAgPHNwYW4+QmF0dGxlPC9zcGFuPlxuICAgICAgICBgO1xuXG5leHBvcnQgZnVuY3Rpb24gc2hvdWxkU2hvd05hdkJ1dHRvbigpOiBib29sZWFuIHtcbiAgY29uc3QgcGF0aCA9IHdpbmRvdy5sb2NhdGlvbi5wYXRobmFtZTtcbiAgcmV0dXJuIChcbiAgICBwYXRoID09PSBcIi9cIiB8fFxuICAgIHBhdGggPT09IFwiL3NjZW5lc1wiIHx8XG4gICAgcGF0aCA9PT0gXCIvc2NlbmVzL1wiIHx8XG4gICAgcGF0aC5zdGFydHNXaXRoKFwiL3NjZW5lcy9cIilcbiAgKTtcbn1cblxuZnVuY3Rpb24gb25CdXR0b25DbGljayhlOiB7IHByZXZlbnREZWZhdWx0KCk6IHZvaWQgfSk6IHZvaWQge1xuICBlLnByZXZlbnREZWZhdWx0KCk7XG4gIHZvaWQgb3Blbk1vZGFsKCk7XG59XG5cbi8qKiBBZGQgdGhlIEJhdHRsZSBuYXYgaXRlbSB0byBTdGFzaCdzIG5hdmJhciwgc2hvd24gb25seSBvbiB0aGUgcm91dGVzIHdoZXJlIGl0IGFwcGxpZXMuIENhbGwgb25jZSBhdCBzdGFydHVwLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlZ2lzdGVyTmF2QnV0dG9uKCk6IHZvaWQge1xuICBjb25zdCBhcGkgPSB3aW5kb3cuUGx1Z2luQXBpO1xuICBpZiAoYXBpPy5jb21wb25lbnRzPy5bXCJNYWluTmF2QmFyLk1lbnVJdGVtc1wiXSAmJiB0eXBlb2YgYXBpLnBhdGNoPy5iZWZvcmUgPT09IFwiZnVuY3Rpb25cIikge1xuICAgIHBhdGNoTmF2QnV0dG9uKGFwaSk7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaW5qZWN0TmF2QnV0dG9uKCk7XG5cbiAgLy8gUmUtaW5qZWN0IG5hdiBidXR0b24gYWZ0ZXIgU3Rhc2ggU1BBIG5hdmlnYXRpb24gcmVidWlsZHMgdGhlIG5hdmJhclxuICBjb25zdCBvYnNlcnZlciA9IG5ldyBNdXRhdGlvbk9ic2VydmVyKCgpID0+IHtcbiAgICBpbmplY3ROYXZCdXR0b24oKTtcbiAgfSk7XG5cbiAgb2JzZXJ2ZXIub2JzZXJ2ZShkb2N1bWVudC5ib2R5LCB7XG4gICAgY2hpbGRMaXN0OiB0cnVlLFxuICAgIHN1YnRyZWU6IHRydWUsXG4gIH0pO1xufVxuXG5mdW5jdGlvbiBwYXRjaE5hdkJ1dHRvbihhcGk6IFBsdWdpbkFwaUxpa2UpOiB2b2lkIHtcbiAgY29uc3QgeyBSZWFjdCB9ID0gYXBpO1xuICBjb25zdCBldmVudHMgPSBhcGkuRXZlbnQ7XG5cbiAgZnVuY3Rpb24gQmF0dGxlTmF2SXRlbSgpOiBSZWFjdE5vZGUge1xuICAgIC8vIFRoZSByb3V0ZSBpcyByZWFkIG9uIGV2ZXJ5IHJlbmRlcjsgdGhlIHN0YXRlIG9ubHkgbWFrZXMgU3Rhc2gncyBuYXZpZ2F0aW9uIGV2ZW50cyByZS1yZW5kZXJcbiAgICBjb25zdCBbLCBzZXRQYXRoXSA9IFJlYWN0LnVzZVN0YXRlKHdpbmRvdy5sb2NhdGlvbi5wYXRobmFtZSk7XG5cbiAgICBSZWFjdC51c2VFZmZlY3QoKCkgPT4ge1xuICAgICAgaWYgKCFldmVudHMpIHJldHVybjtcbiAgICAgIGNvbnN0IHVwZGF0ZSA9ICgpOiB2b2lkID0+IHNldFBhdGgod2luZG93LmxvY2F0aW9uLnBhdGhuYW1lKTtcbiAgICAgIHVwZGF0ZSgpO1xuICAgICAgZXZlbnRzLmFkZEV2ZW50TGlzdGVuZXIoXCJzdGFzaDpsb2NhdGlvblwiLCB1cGRhdGUpO1xuICAgICAgcmV0dXJuICgpID0+IGV2ZW50cy5yZW1vdmVFdmVudExpc3RlbmVyKFwic3Rhc2g6bG9jYXRpb25cIiwgdXBkYXRlKTtcbiAgICB9LCBbXSk7XG5cbiAgICBpZiAoIXNob3VsZFNob3dOYXZCdXR0b24oKSkgcmV0dXJuIG51bGw7XG4gICAgcmV0dXJuIFJlYWN0LmNyZWF0ZUVsZW1lbnQoXG4gICAgICBcImRpdlwiLFxuICAgICAgeyBpZDogQlVUVE9OX0lELCBjbGFzc05hbWU6IE5BVl9JVEVNX0NMQVNTIH0sXG4gICAgICBSZWFjdC5jcmVhdGVFbGVtZW50KFwiYVwiLCB7XG4gICAgICAgIGhyZWY6IFwiI1wiLFxuICAgICAgICBjbGFzc05hbWU6IExJTktfQ0xBU1MsXG4gICAgICAgIG9uQ2xpY2s6IG9uQnV0dG9uQ2xpY2ssXG4gICAgICAgIGRhbmdlcm91c2x5U2V0SW5uZXJIVE1MOiB7IF9faHRtbDogTElOS19IVE1MIH0sXG4gICAgICB9KSxcbiAgICApO1xuICB9XG5cbiAgLy8gQXBwZW5kIHRvIHRoZSBjaGlsZHJlbiBNZW51SXRlbXMgcmVuZGVycyBpbiBpdHMgTmF2LiBFdmVyeSBvdGhlciBhcmcgaXMgcGFzc2VkIHRocm91Z2ggYXMgaXM6XG4gIC8vIGFuIGBhZnRlcmAgcGF0Y2ggZmluZHMgdGhlIHJlbmRlcmVkIHJlc3VsdCBieSBwb3NpdGlvbiwgc28gdGhlIGFyZyBjb3VudCBtdXN0IG5vdCBjaGFuZ2UuXG4gIGFwaS5wYXRjaC5iZWZvcmUoXCJNYWluTmF2QmFyLk1lbnVJdGVtc1wiLCAocHJvcHMsIC4uLnJlc3QpID0+IFtcbiAgICB7XG4gICAgICAuLi4ocHJvcHMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pLFxuICAgICAgY2hpbGRyZW46IFsocHJvcHMgYXMgeyBjaGlsZHJlbj86IFJlYWN0Tm9kZSB9KS5jaGlsZHJlbiwgUmVhY3QuY3JlYXRlRWxlbWVudChCYXR0bGVOYXZJdGVtLCB7IGtleTogQlVUVE9OX0lEIH0pXSxcbiAgICB9LFxuICAgIC4uLnJlc3QsXG4gIF0pO1xufVxuXG4vKiogSW5qZWN0IG9yIHJlbW92ZSB0aGUgQmF0dGxlIG5hdiBpdGVtIGJhc2VkIG9uIHRoZSBjdXJyZW50IHJvdXRlLiBTYWZlIHRvIGNhbGwgcmVwZWF0ZWRseS4gKi9cbmZ1bmN0aW9uIGluamVjdE5hdkJ1dHRvbigpOiB2b2lkIHtcbiAgaWYgKCFzaG91bGRTaG93TmF2QnV0dG9uKCkpIHtcbiAgICBjb25zdCBleGlzdGluZyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKEJVVFRPTl9JRCk7XG4gICAgaWYgKGV4aXN0aW5nKSB7XG4gICAgICBleGlzdGluZy5jbG9zZXN0KFwiLm5hdi1saW5rXCIpPy5yZW1vdmUoKTtcbiAgICB9XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgaWYgKGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKEJVVFRPTl9JRCkpIHJldHVybjtcblxuICBjb25zdCBuYXZJdGVtID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgbmF2SXRlbS5jbGFzc05hbWUgPSBOQVZfSVRFTV9DTEFTUztcbiAgbmF2SXRlbS5pZCA9IEJVVFRPTl9JRDtcblxuICBjb25zdCBsaW5rID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImFcIik7XG4gIGxpbmsuaHJlZiA9IFwiI1wiO1xuICBsaW5rLmNsYXNzTmFtZSA9IExJTktfQ0xBU1M7XG4gIGxpbmsuaW5uZXJIVE1MID0gTElOS19IVE1MO1xuICBsaW5rLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBvbkJ1dHRvbkNsaWNrKTtcbiAgbmF2SXRlbS5hcHBlbmRDaGlsZChsaW5rKTtcblxuICBjb25zdCBuYXZUYXJnZXQgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKFwiLm5hdmJhci1uYXZcIik7XG4gIGlmIChuYXZUYXJnZXQpIHtcbiAgICBuYXZUYXJnZXQuYXBwZW5kQ2hpbGQobmF2SXRlbSk7XG4gIH1cbn1cbiIsICIvLyBTdGFzaCBCYXR0bGUgLSBlbnRyeSBwb2ludC5cbi8vIEJ1bmRsZWQgYnkgZXNidWlsZCBpbnRvIHBsdWdpbnMvc3Rhc2gtYmF0dGxlL3N0YXNoLWJhdHRsZS5qcyAoSUlGRSkuXG5cbmltcG9ydCB7IHJlZ2lzdGVyRGVsZXRlRGlhbG9nQnJpZGdlIH0gZnJvbSBcIi4vdWkvZGVsZXRlRGlhbG9nXCI7XG5pbXBvcnQgeyBvcGVuTW9kYWwgfSBmcm9tIFwiLi91aS9tb2RhbFwiO1xuaW1wb3J0IHsgcmVnaXN0ZXJOYXZCdXR0b24gfSBmcm9tIFwiLi91aS9uYXZCdXR0b25cIjtcbmltcG9ydCB7IHJlZ2lzdGVyU2NlbmVFbG8gfSBmcm9tIFwiLi91aS9zY2VuZUVsb1wiO1xuXG5mdW5jdGlvbiBpbml0KCk6IHZvaWQge1xuICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIEluaXRpYWxpemVkXCIpO1xuXG4gIHJlZ2lzdGVyRGVsZXRlRGlhbG9nQnJpZGdlKCk7XG4gIHJlZ2lzdGVyTmF2QnV0dG9uKCk7XG4gIHJlZ2lzdGVyU2NlbmVFbG8oKCkgPT4gdm9pZCBvcGVuTW9kYWwoKSk7XG59XG5cbmlmIChkb2N1bWVudC5yZWFkeVN0YXRlID09PSBcImxvYWRpbmdcIikge1xuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwiRE9NQ29udGVudExvYWRlZFwiLCBpbml0KTtcbn0gZWxzZSB7XG4gIGluaXQoKTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICI7OztBQUVPLE1BQU0sY0FBYztBQUNwQixNQUFNLGdCQUFnQjtBQUV0QixNQUFNLG1CQUFtQjtBQUN6QixNQUFNLG1CQUFtQjtBQUN6QixNQUFNLG1CQUFtQixJQUFJLEtBQUs7QUFLbEMsTUFBTSxZQUFZO0FBRWxCLE1BQU0sbUJBQTZCO0FBQUEsSUFDeEMsY0FBYztBQUFBLElBQ2QsWUFBWTtBQUFBLElBQ1osY0FBYztBQUFBLElBQ2QsY0FBYztBQUFBLElBQ2QscUJBQXFCO0FBQUEsSUFDckIsV0FBVztBQUFBLElBQ1gsZUFBZTtBQUFBLElBQ2Ysa0JBQWtCO0FBQUEsSUFDbEIsaUJBQWlCO0FBQUEsSUFDakIsV0FBVztB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akIsU0FBSyxpQkFBaUIsU0FBUyxhQUFhO0FBQzVDLFlBQVEsWUFBWSxJQUFJO0FBRXhCLFVBQU0sWUFBWSxTQUFTLGNBQWMsYUFBYTtBQUN0RCxRQUFJLFdBQVc7QUFDYixnQkFBVSxZQUFZLE9BQU87QUFBQSxJQUMvQjtBQUFBLEVBQ0Y7OztBQ2xIQSxXQUFTLE9BQWE7QUFDcEIsWUFBUSxJQUFJLDRCQUE0QjtBQUV4QywrQkFBMkI7QUFDM0Isc0JBQWtCO0FBQ2xCLHFCQUFpQixNQUFNLEtBQUssVUFBVSxDQUFDO0FBQUEsRUFDekM7QUFFQSxNQUFJLFNBQVMsZUFBZSxXQUFXO0FBQ3JDLGFBQVMsaUJBQWlCLG9CQUFvQixJQUFJO0FBQUEsRUFDcEQsT0FBTztBQUNMLFNBQUs7QUFBQSxFQUNQOyIsCiAgIm5hbWVzIjogWyJrR2FtZXMiLCAiZWxvIiwgIndpbmRvdyIsICJlbG8iLCAiYmF0dGxlcyIsICJiYXR0bGVzIiwgIm9wdGlvbnMiLCAiTU9ERVMiLCAic2NlbmUiLCAib3B0aW9ucyIsICJydW5uaW5nIiwgImVsb0xpbmUiLCAiYWZ0ZXJTZXR1cCIsICJtb2RhbENvbnRlbnQiXQp9Cg==
