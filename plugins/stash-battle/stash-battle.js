"use strict";
(() => {
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

  // src/constants.ts
  var STORAGE_KEY = "stash-battle-state";
  var CACHE_DB_NAME = "stash-battle-cache";
  var CACHE_DB_VERSION = 1;
  var CACHE_STORE_NAME = "scenes";
  var CACHE_MAX_AGE_MS = 5 * 60 * 1e3;
  var PLUGIN_ID = "stash-battle";
  var DEFAULT_SETTINGS = {
    funMode: false,
    openInNewTab: false,
    unratedRating: 50,
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
  var CLIMB_SMALL_POOL_WARN_AT = 10;
  var CLIMB_K_PLAY_COUNT = 0;

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
    gauntletClimber: null,
    gauntletWins: 0,
    gauntletClimberRank: 0,
    gauntletDefeated: [],
    gauntletFalling: false,
    gauntletFallingScene: null,
    placement: null,
    totalScenesCount: 0,
    leftPoolSize: null,
    disableChoice: false,
    savedFilterParams: "",
    settings: { ...DEFAULT_SETTINGS },
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
    state.gauntletClimber = null;
    state.gauntletWins = 0;
    state.gauntletClimberRank = 0;
    state.gauntletDefeated = [];
    state.gauntletFalling = false;
    state.gauntletFallingScene = null;
    state.placement = null;
  }
  function resetShuffle() {
    state.shuffledFilteredScenes = [];
    state.shuffleIndex = 0;
    state.shuffleFilterKey = null;
  }
  function isRunActive() {
    switch (state.currentMode) {
      case "gauntlet":
      case "champion":
        return state.gauntletClimber !== null;
      case "placement":
        return (state.placement?.battles ?? 0) > 0;
      default:
        return false;
    }
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
        if (!db.objectStoreNames.contains(CACHE_STORE_NAME)) {
          db.createObjectStore(CACHE_STORE_NAME, { keyPath: "cacheKey" });
        }
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
      const scenes = result.findScenes.scenes || [];
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
    const scenes = result.findScenes.scenes || [];
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
      const scenes = result.findScenes.scenes || [];
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
    const scenes = result.findScenes.scenes || [];
    const count = result.findScenes.count || scenes.length;
    const fetchTime = Date.now() - startTime;
    state.memoryCache.filteredScenes = scenes;
    state.memoryCache.filterKey = filterKey;
    state.memoryCache.timestamp = Date.now();
    await setCachedScenes(cacheKey, scenes, count, filterKey);
    console.log(`[Stash Battle] ✅ Fetched and cached ${scenes.length} filtered scenes in ${fetchTime}ms`);
    return { scenes, count };
  }
  function repositionSceneInArray(arr, sceneId, newRating) {
    const idx = arr.findIndex((s) => s.id === sceneId);
    if (idx === -1) return false;
    const scene = arr[idx];
    scene.rating100 = newRating;
    arr.splice(idx, 1);
    const newIdx = arr.findIndex((s) => (s.rating100 || 0) < newRating);
    if (newIdx === -1) {
      arr.push(scene);
    } else {
      arr.splice(newIdx, 0, scene);
    }
    return true;
  }
  function clearSceneInCache(sceneId) {
    if (state.memoryCache.allScenes) {
      const idx = state.memoryCache.allScenes.findIndex((s) => s.id === sceneId);
      if (idx !== -1) {
        const scene = state.memoryCache.allScenes[idx];
        scene.rating100 = null;
        state.memoryCache.allScenes.splice(idx, 1);
        state.memoryCache.allScenes.push(scene);
        console.log(`[Stash Battle] 📝 Cleared scene ${sceneId} rating in memory cache`);
      }
    }
    if (state.memoryCache.filteredScenes) {
      const scene = state.memoryCache.filteredScenes.find((s) => s.id === sceneId);
      if (scene) {
        scene.rating100 = null;
      }
    }
  }
  function updateSceneInCache(sceneId, newRating) {
    if (state.memoryCache.allScenes) {
      repositionSceneInArray(state.memoryCache.allScenes, sceneId, newRating);
      console.log(`[Stash Battle] 📝 Updated scene ${sceneId} rating to ${newRating} in memory cache`);
    }
    if (state.memoryCache.filteredScenes) {
      repositionSceneInArray(state.memoryCache.filteredScenes, sceneId, newRating);
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
  var funSandbox = /* @__PURE__ */ new Map();
  function sandboxScene(scene) {
    let copy = funSandbox.get(scene.id);
    if (!copy) {
      copy = { ...scene };
      funSandbox.set(scene.id, copy);
    }
    return copy;
  }
  function sandboxPool(pool) {
    return pool.map(sandboxScene).sort((a, b) => (b.rating100 ?? 0) - (a.rating100 ?? 0));
  }
  function setSandboxRating(sceneId, rating100) {
    const real = funSandbox.has(sceneId) ? null : state.memoryCache.allScenes?.find((s) => s.id === sceneId);
    const copy = funSandbox.get(sceneId) ?? (real ? sandboxScene(real) : null);
    if (copy) copy.rating100 = rating100;
  }
  function resetSandbox() {
    funSandbox.clear();
  }
  function savedRating(scene) {
    const real = state.memoryCache.allScenes?.find((s) => s.id === scene.id);
    return real ? real.rating100 : scene.rating100;
  }

  // src/sceneActions.ts
  async function findExistingSceneIds(ids) {
    const aliases = ids.map((id, i) => `s${i}: findScene(id: ${JSON.stringify(id)}) { id }`).join("\n");
    const result = await graphqlQuery(`{ ${aliases} }`);
    return new Set(Object.values(result).flatMap((s) => s ? [s.id] : []));
  }
  function isSceneNotFoundError(error) {
    return error instanceof Error && /not found/i.test(error.message);
  }

  // src/rating.ts
  var SCENE_MISSING_EVENT = "stash-battle:scene-missing";
  function ratingsEnabled() {
    return !state.settings.funMode;
  }
  var SCENE_UPDATE_MUTATION = `
      mutation SceneUpdate($input: SceneUpdateInput!) {
        sceneUpdate(input: $input) {
          id
          rating100
        }
      }
    `;
  async function updateSceneRating(sceneId, rating100) {
    const stashRating = rating100 === null ? null : Math.max(1, Math.min(100, rating100));
    if (!ratingsEnabled()) {
      console.log(`[Stash Battle] 🎈 Fun mode: scene ${sceneId} rating ${stashRating} kept in memory only`);
      setSandboxRating(sceneId, stashRating);
      return;
    }
    try {
      await graphqlQuery(SCENE_UPDATE_MUTATION, {
        input: {
          id: sceneId,
          rating100: stashRating
        }
      });
      if (stashRating === null) {
        console.log(`[Stash Battle] 📝 Cleared scene ${sceneId} rating in Stash`);
        clearSceneInCache(sceneId);
      } else {
        console.log(`[Stash Battle] 📝 Updated scene ${sceneId} rating to ${stashRating} in Stash`);
        updateSceneInCache(sceneId, stashRating);
      }
    } catch (e) {
      const action = stashRating === null ? "clear" : "update";
      console.error(`[Stash Battle] Failed to ${action} scene ${sceneId} rating:`, e);
      if (isSceneNotFoundError(e)) {
        window.dispatchEvent(new CustomEvent(SCENE_MISSING_EVENT, { detail: sceneId }));
      }
    }
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
  function clampPercent(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : fallback;
  }
  function normalize(raw, base) {
    const bool = (key) => typeof raw[key] === "boolean" ? raw[key] : base[key];
    return {
      funMode: bool("funMode"),
      openInNewTab: bool("openInNewTab"),
      autoplayPreviews: bool("autoplayPreviews"),
      filterOpponents: bool("filterOpponents"),
      cleanMode: bool("cleanMode"),
      pauseMediaOnOpen: bool("pauseMediaOnOpen"),
      unratedRating: clampPercent(raw.unratedRating ?? base.unratedRating, base.unratedRating),
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
      const data = await graphqlQuery(
        CONFIG_QUERY
      );
      const stored = data.configuration.plugins?.[PLUGIN_ID];
      state.settings = stored ? normalize(stored, DEFAULT_SETTINGS) : legacyDefaults();
    } catch (e) {
      console.error("[Stash Battle] Failed to load settings, using current values:", e);
    }
    return state.settings;
  }
  async function persistSettings() {
    try {
      await graphqlQuery(CONFIGURE_PLUGIN_MUTATION, { plugin_id: PLUGIN_ID, input: { ...state.settings } });
    } catch (e) {
      console.error("[Stash Battle] Failed to save settings:", e);
    }
  }
  function updateSettings(patch) {
    state.settings = normalize({ ...state.settings, ...patch }, state.settings);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void persistSettings();
    }, SAVE_DEBOUNCE_MS);
  }

  // src/storage.ts
  function saveState() {
    const snapshot = {
      currentPair: state.currentPair,
      currentRanks: state.currentRanks,
      currentMode: state.currentMode,
      gauntletClimber: state.gauntletClimber,
      gauntletWins: state.gauntletWins,
      gauntletClimberRank: state.gauntletClimberRank,
      gauntletDefeated: state.gauntletDefeated,
      gauntletFalling: state.gauntletFalling,
      gauntletFallingScene: state.gauntletFallingScene,
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
        state.currentPair = parsed.currentPair || { left: null, right: null };
        state.currentRanks = parsed.currentRanks || { left: null, right: null };
        state.currentMode = parsed.currentMode || "swiss";
        state.gauntletClimber = parsed.gauntletClimber ?? parsed.gauntletChampion ?? null;
        state.gauntletWins = parsed.gauntletWins || 0;
        state.gauntletClimberRank = parsed.gauntletClimberRank ?? parsed.gauntletChampionRank ?? 0;
        state.gauntletDefeated = parsed.gauntletDefeated || [];
        state.gauntletFalling = parsed.gauntletFalling || false;
        state.gauntletFallingScene = parsed.gauntletFallingScene || null;
        state.placement = parsed.placement || null;
        state.totalScenesCount = parsed.totalScenesCount || 0;
        state.savedFilterParams = parsed.savedFilterParams || "";
        return true;
      }
    } catch (e) {
      console.error("[Stash Battle] Failed to load state:", e);
    }
    return false;
  }

  // src/elo.ts
  var MIN_RATING = 1;
  var MAX_RATING = 100;
  function getKFactor(playCount) {
    if (playCount < 3) return 12;
    if (playCount < 8) return 8;
    if (playCount < 15) return 6;
    return 4;
  }
  function effectiveRating(rating100, unratedRating) {
    return rating100 || clampRating(unratedRating);
  }
  function clampRating(rating) {
    return Math.min(MAX_RATING, Math.max(MIN_RATING, rating));
  }
  function expectedScore(ratingA, ratingB) {
    const ratingDiff = ratingB - ratingA;
    return 1 / (1 + Math.pow(10, ratingDiff / 40));
  }
  function calculateRatingChanges(input) {
    const { winner, loser } = input;
    const expected = expectedScore(winner.rating, loser.rating);
    const winnerChange = Math.max(1, Math.round(getKFactor(winner.playCount) * (1 - expected)));
    const loserChange = -Math.max(1, Math.round(getKFactor(loser.playCount) * expected));
    const winnerNew = clampRating(winner.rating + winnerChange);
    const loserNew = clampRating(loser.rating + loserChange);
    return {
      winner: winnerNew - winner.rating,
      loser: loserNew - loser.rating
    };
  }

  // src/navigation.ts
  function navigateToUrl(url) {
    closeModal();
    const path = url.startsWith("/") ? url : new URL(url).pathname + new URL(url).search;
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
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
    const scene = state.shuffledFilteredScenes[state.shuffleIndex];
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
    const ratedOnly = allScenes.filter((s) => s.rating100 != null);
    return ratedOnly.length >= 1 ? ratedOnly : allScenes;
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
    if (state.settings.funMode) {
      return { leftPool: sandboxPool(leftPool), allScenes: sandboxPool(allScenes) };
    }
    return { leftPool, allScenes };
  }
  async function loadPoolSize() {
    await loadScenePools(readFilters());
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
  function insertionIndex(pool, rating) {
    const idx = pool.findIndex((s) => (s.rating100 ?? 0) < rating);
    return idx === -1 ? pool.length : idx;
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
    const effectiveScene1Idx = scene1.rating100 && scene1IdxInPool >= 0 ? scene1IdxInPool : insertionIndex(rightPool, effectiveRating(scene1.rating100, state.settings.unratedRating));
    const scene1RankInPool = scene1IdxInPool >= 0 ? scene1IdxInPool + 1 : null;
    const candidates = [];
    for (let reach = Math.min(SWISS_OPPONENT_REACH_INITIAL, rightPool.length); candidates.length === 0 && reach <= rightPool.length; reach = Math.min(reach * SWISS_OPPONENT_REACH_MULTIPLIER, rightPool.length)) {
      for (let i = effectiveScene1Idx - reach; i <= effectiveScene1Idx + reach; i++) {
        if (i >= 0 && i < rightPool.length && i !== scene1IdxInPool) {
          candidates.push({ scene: rightPool[i], idx: i });
        }
      }
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
  function pickClosestClimbOpponent(remainingOpponents) {
    const closest = remainingOpponents.slice(-CLIMB_OPPONENT_PICK_WINDOW);
    return closest[Math.floor(Math.random() * closest.length)];
  }
  function getRemainingClimbOpponents(climber, rightPool, climberIndex) {
    return rightPool.filter((s, idx) => {
      if (s.id === climber.id || state.gauntletDefeated.includes(s.id)) return false;
      return idx < climberIndex || (s.rating100 || 0) >= (climber.rating100 || 0);
    });
  }
  async function getClimbOpponentPool() {
    const filters = readFilters();
    const { leftPool, allScenes } = await loadScenePools(filters);
    return buildOpponentPool(allScenes, leftPool, filters);
  }
  async function applyClimbWinRating(climber, beatenOpponent, eloRating) {
    climber.rating100 = eloRating;
    const rightPool = await getClimbOpponentPool();
    const climberIndex = rightPool.findIndex((s) => s.id === climber.id);
    if (getRemainingClimbOpponents(climber, rightPool, climberIndex).length > 0) {
      return eloRating;
    }
    const minWinnerRating = Math.min(100, (beatenOpponent.rating100 ?? 0) + 1);
    if (eloRating < minWinnerRating) {
      await updateSceneRating(climber.id, minWinnerRating);
      climber.rating100 = minWinnerRating;
    }
    return climber.rating100 ?? eloRating;
  }
  function findLowestRated(scenes, excludeId) {
    for (let i = scenes.length - 1; i >= 0; i--) {
      const s = scenes[i];
      if (s.id !== excludeId && s.rating100 != null) {
        return { scene: s, index: i };
      }
    }
    const fallbackIndex = scenes.findIndex((s) => s.id !== excludeId);
    return { scene: scenes[fallbackIndex], index: fallbackIndex };
  }
  async function fetchGauntletPair(forcedLeftScene = null) {
    const filters = readFilters();
    console.log("[Stash Battle] 📋 Fetching scenes for gauntlet...");
    const { leftPool, allScenes } = await loadScenePools(filters);
    let rightPool = buildOpponentPool(allScenes, leftPool, filters);
    state.totalScenesCount = rightPool.length;
    if (allScenes.length < 2) {
      throw new Error("Not enough scenes for comparison.");
    }
    if (state.gauntletFalling && state.gauntletFallingScene) {
      const fallingScene = state.gauntletFallingScene;
      const fallingIndex = rightPool.findIndex((s) => s.id === fallingScene.id);
      const belowOpponents = rightPool.filter((s, idx) => {
        if (s.id === fallingScene.id || state.gauntletDefeated.includes(s.id)) return false;
        return idx > fallingIndex;
      });
      if (belowOpponents.length === 0) {
        const finalRank = rightPool.length;
        const lastDefeatedById = state.gauntletDefeated[state.gauntletDefeated.length - 1];
        const lastOpponent = rightPool.find((s) => s.id === lastDefeatedById);
        const finalRating = Math.max(1, (lastOpponent?.rating100 || 1) - 1);
        updateSceneRating(fallingScene.id, finalRating);
        return {
          scenes: [fallingScene],
          ranks: [finalRank],
          isVictory: false,
          isFalling: true,
          isPlacement: true,
          placementRank: finalRank,
          placementRating: finalRating
        };
      } else {
        const nextBelow = belowOpponents[0];
        const nextBelowIndex = rightPool.findIndex((s) => s.id === nextBelow.id);
        state.gauntletClimberRank = fallingIndex + 1;
        return {
          scenes: [fallingScene, nextBelow],
          ranks: [fallingIndex + 1, nextBelowIndex + 1],
          isVictory: false,
          isFalling: true
        };
      }
    }
    if (!state.gauntletClimber) {
      state.gauntletDefeated = [];
      state.gauntletFalling = false;
      state.gauntletFallingScene = null;
      const challenger = forcedLeftScene || getNextFilteredScene(leftPool, filters.filterKey);
      if (!challenger) {
        throw new Error("No scenes match your filter criteria.");
      }
      const challengerIndex = rightPool.findIndex((s) => s.id === challenger.id);
      const { scene: lowestRated, index: lowestIndex } = findLowestRated(rightPool, challenger.id);
      state.gauntletClimberRank = challengerIndex >= 0 ? challengerIndex + 1 : rightPool.length;
      return {
        scenes: [challenger, lowestRated],
        ranks: [state.gauntletClimberRank, lowestIndex + 1],
        isVictory: false,
        isFalling: false
      };
    }
    const climber = state.gauntletClimber;
    const climberIndex = rightPool.findIndex((s) => s.id === climber.id);
    state.gauntletClimberRank = climberIndex >= 0 ? climberIndex + 1 : 1;
    const remainingOpponents = getRemainingClimbOpponents(climber, rightPool, climberIndex);
    if (remainingOpponents.length === 0) {
      state.gauntletClimberRank = 1;
      return {
        scenes: [climber],
        ranks: [1],
        isVictory: true,
        isFalling: false
      };
    }
    const nextOpponent = pickClosestClimbOpponent(remainingOpponents);
    const nextOpponentIndex = rightPool.findIndex((s) => s.id === nextOpponent.id);
    return {
      scenes: [climber, nextOpponent],
      ranks: [climberIndex >= 0 ? climberIndex + 1 : null, nextOpponentIndex + 1],
      isVictory: false,
      isFalling: false
    };
  }
  async function fetchChampionPair(forcedLeftScene = null) {
    const filters = readFilters();
    console.log("[Stash Battle] 📋 Fetching scenes for champion...");
    const { leftPool, allScenes } = await loadScenePools(filters);
    let rightPool = buildOpponentPool(allScenes, leftPool, filters);
    state.totalScenesCount = rightPool.length;
    if (allScenes.length < 2) {
      throw new Error("Not enough scenes for comparison.");
    }
    if (!state.gauntletClimber) {
      state.gauntletDefeated = [];
      if (!forcedLeftScene && leftPool.length < 1) {
        throw new Error("No scenes match your filter criteria.");
      }
      const challenger = forcedLeftScene || getNextFilteredScene(leftPool, filters.filterKey);
      if (!challenger) {
        throw new Error("No scenes match your filter criteria.");
      }
      const challengerIndex = rightPool.findIndex((s) => s.id === challenger.id);
      const { scene: lowestRated, index: lowestIndex } = findLowestRated(rightPool, challenger.id);
      state.gauntletClimberRank = challengerIndex >= 0 ? challengerIndex + 1 : rightPool.length;
      return {
        scenes: [challenger, lowestRated],
        ranks: [state.gauntletClimberRank, lowestIndex + 1],
        isVictory: false
      };
    }
    const climber = state.gauntletClimber;
    const climberIndex = rightPool.findIndex((s) => s.id === climber.id);
    state.gauntletClimberRank = climberIndex >= 0 ? climberIndex + 1 : 1;
    const remainingOpponents = getRemainingClimbOpponents(climber, rightPool, climberIndex);
    if (remainingOpponents.length === 0) {
      state.gauntletClimberRank = 1;
      return {
        scenes: [climber],
        ranks: [1],
        isVictory: true
      };
    }
    const nextOpponent = pickClosestClimbOpponent(remainingOpponents);
    const nextOpponentIndex = rightPool.findIndex((s) => s.id === nextOpponent.id);
    return {
      scenes: [climber, nextOpponent],
      ranks: [climberIndex + 1, nextOpponentIndex + 1],
      isVictory: false
    };
  }
  function newPlacementRun(scene) {
    return {
      scene,
      aboveId: null,
      belowId: null,
      lastOpponentId: null,
      lastWon: null,
      galloping: scene.rating100 != null,
      step: 1,
      battles: 0,
      rangeLo: 0,
      rangeHi: 0
    };
  }
  function placementBounds(run, pool) {
    const aboveIdx = run.aboveId ? pool.findIndex((s) => s.id === run.aboveId) : -1;
    const belowIdx = run.belowId ? pool.findIndex((s) => s.id === run.belowId) : -1;
    return { lo: aboveIdx + 1, hi: belowIdx >= 0 ? belowIdx : pool.length };
  }
  function nextPlacementIndex(run, pool, lo, hi) {
    if (run.galloping) {
      if (run.lastOpponentId === null) {
        return insertionIndex(pool, run.scene.rating100 ?? 0);
      }
      const lastIdx = pool.findIndex((s) => s.id === run.lastOpponentId);
      if (lastIdx >= 0) {
        const dir = run.lastWon ? -1 : 1;
        const lastRating = pool[lastIdx].rating100 ?? 0;
        let edge = lastIdx;
        while (edge + dir >= 0 && edge + dir < pool.length && (pool[edge + dir].rating100 ?? 0) === lastRating) {
          edge += dir;
        }
        return edge + dir * run.step;
      }
    }
    return lo + Math.floor((hi - lo) / 2);
  }
  function pickAmongTies(pool, idx, lo, hi) {
    const rating = pool[idx].rating100 ?? 0;
    const ties = [];
    for (let i = lo; i < hi; i++) {
      if ((pool[i].rating100 ?? 0) === rating) ties.push(i);
    }
    return ties[Math.floor(Math.random() * ties.length)];
  }
  function placementRating(pool, slot) {
    const above = slot > 0 ? pool[slot - 1].rating100 ?? 0 : null;
    const below = slot < pool.length ? pool[slot].rating100 ?? 0 : null;
    if (above === null) return Math.min(100, (below ?? 0) + 1);
    if (below === null) return Math.max(1, above - 1);
    if (above - below >= 2) return Math.round((above + below) / 2);
    return Math.max(1, above);
  }
  function recordPlacementResult(won, opponentId) {
    const run = state.placement;
    if (!run) return;
    if (run.lastWon !== null) {
      if (run.lastWon === won) run.step *= 2;
      else run.galloping = false;
    }
    if (won) run.belowId = opponentId;
    else run.aboveId = opponentId;
    run.lastOpponentId = opponentId;
    run.lastWon = won;
    run.battles++;
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
      state.placement = newPlacementRun(scene);
    }
    const run = state.placement;
    const pool = buildOpponentPool(allScenes, leftPool, filters).filter((s) => s.id !== run.scene.id);
    if (pool.length === 0) {
      throw new Error("Not enough scenes for comparison. You need at least 2 scenes.");
    }
    state.totalScenesCount = pool.length + 1;
    const { lo, hi } = placementBounds(run, pool);
    run.rangeLo = Math.min(lo, hi);
    run.rangeHi = hi;
    if (lo >= hi) {
      const slot = Math.min(lo, hi);
      const rating = placementRating(pool, slot);
      console.log(
        `[Stash Battle] 📍 Placement: scene ${run.scene.id} placed at #${slot + 1} after ${run.battles} battles, rating ${rating}`
      );
      await updateSceneRating(run.scene.id, rating);
      run.scene.rating100 = rating;
      return { done: true, scene: run.scene, rank: slot + 1, rating };
    }
    const target = Math.max(lo, Math.min(hi - 1, nextPlacementIndex(run, pool, lo, hi)));
    const idx = pickAmongTies(pool, target, lo, hi);
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
    const { unratedRating, openInNewTab, cleanMode } = state.settings;
    const unratedLabel = state.currentMode === "swiss" && unratedRating > 1 ? `Unrated (counts as ${unratedRating})` : "Unrated";
    const shownRating = state.settings.funMode ? savedRating(scene) : scene.rating100;
    const stashRating = shownRating ? `${shownRating}/100` : unratedLabel;
    let rankDisplay = "";
    if (rank !== null && rank !== void 0) {
      rankDisplay = `<span class="sb-scene-rank">#${rank}</span>`;
    }
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
              <div class="sb-meta-item sb-meta-rating"><strong>Rating:</strong> ${stashRating}</div>
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
        <p class="sb-end-screen-stats">${statsHtml}${ratingsEnabled() ? "" : "<br><em>🎈 Fun mode: rating not saved</em>"}</p>
        <button id="sb-new-gauntlet" class="btn btn-primary">${buttonLabel}</button>
      </div>
    `;
  }
  function showEndScreen(html) {
    const comparisonArea = document.getElementById("sb-comparison-area");
    if (!comparisonArea) return;
    comparisonArea.innerHTML = html;
    setActionsVisible(false);
    comparisonArea.querySelector("#sb-new-gauntlet")?.addEventListener("click", () => {
      loadNewPair();
    });
  }
  function finishRunShowEndScreen(html) {
    resetRunState();
    saveState();
    showEndScreen(html);
  }
  function showVictoryScreen(champion) {
    const totalScenes = state.totalScenesCount;
    const winStreak = state.gauntletWins;
    const ratingLine = champion.rating100 != null ? `<br>Rating: <strong>${champion.rating100}/100</strong>` : "";
    const html = buildEndScreenHtml(
      champion,
      "👑",
      "CHAMPION!",
      `Conquered all ${totalScenes} scenes with a ${winStreak} win streak!${ratingLine}`,
      "Start New Gauntlet"
    );
    finishRunShowEndScreen(html);
  }
  function showPlacementScreen(scene, rank, finalRating) {
    const battles = state.placement?.battles;
    const battlesLine = battles ? ` · ${battles} battle${battles === 1 ? "" : "s"}` : "";
    const html = buildEndScreenHtml(
      scene,
      "📍",
      "PLACED!",
      `Rank <strong>#${rank}</strong> of ${state.totalScenesCount}${battlesLine}<br>Rating: <strong>${finalRating}/100</strong>`,
      "Start New Run"
    );
    finishRunShowEndScreen(html);
  }

  // src/ui/settingsPanel.ts
  var SECTIONS = [
    {
      title: "Battles",
      rows: [
        { key: "filterOpponents", title: "Use filtered scenes for both sides", hint: "Opponents also come from the current scene list filter instead of your whole rated library" },
        { key: "unratedRating", title: "Unrated scene rating", hint: "What unrated scenes count as in Swiss. 0 starts them at the bottom; 50 is closer to a classic ELO start" },
        { key: "funMode", title: "Fun mode", hint: "Battle without changing any ratings" }
      ]
    },
    {
      title: "Scenes",
      rows: [
        { key: "autoplayPreviews", title: "Autoplay previews", hint: "Loop both previews silently; hover a card to hear it" },
        { key: "pauseMediaOnOpen", title: "Pause playing video when Battle opens", hint: "Stops the scene you're watching so its audio doesn't overlap the battle previews" },
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
    if (key === "unratedRating") {
      return `<input type="number" min="0" max="100" step="1" data-setting="${key}" value="${state.settings[key]}" class="form-control form-control-sm input-control sb-setting-number">`;
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
  function createSettingsTab() {
    const sections = SECTIONS.map(
      ({ title, rows }) => `
        <div class="setting-section">
          <h1>${title}</h1>
          <div class="card">
            ${rows.map(
        ({ key, title: rowTitle, hint }) => `
            <div class="setting">
              <div>
                <h3>${rowTitle}</h3>
                <div class="sub-heading">${hint}</div>
              </div>
              <div>${settingControl(key)}</div>
            </div>`
      ).join("")}
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
  function bindSettingsControls(root, onChange, onTabChange) {
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
  var MODES = [
    {
      mode: "swiss",
      icon: "⚖️",
      title: "Swiss",
      desc: "Fair matchups",
      tip: "Each scene faces an opponent with a similar rating. Both ratings change after every pick, and every scene stays in the rotation."
    },
    {
      mode: "placement",
      icon: "📍",
      title: "Placement",
      desc: "Place a scene",
      tip: "Finds where one scene belongs. Each pick narrows the range of ranks it could land in (shown on its card) until its spot is found, about 10 picks for an unrated scene. Only its rating changes, once at the end."
    },
    {
      mode: "gauntlet",
      icon: "🎯",
      title: "Gauntlet",
      desc: "Climb the ladder",
      tip: "A scene starts at the bottom and climbs by beating the scenes above it. When it loses, it falls until it finds its floor. Only the climber's rating changes."
    },
    {
      mode: "champion",
      icon: "🏆",
      title: "Champion",
      desc: "Winner stays on",
      tip: "Winner stays on: the scene you pick keeps defending against new challengers until it's beaten, then the winner takes over."
    }
  ];
  function createMainUI() {
    const modeButtons = MODES.map(
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
          <p class="sb-subtitle">Compare scenes head-to-head to build your rankings</p>
          ${createTabBar()}
        </div>

        <div class="sb-tab-panel" data-panel="battle">
          <p id="sb-fun-badge" class="sb-fun-badge" ${state.settings.funMode ? "" : "hidden"}>🎈 Fun mode: ratings are not saved</p>
          <div class="sb-mode-row">
            <div class="sb-mode-toggle">${modeButtons}
            </div>
            <button type="button" class="sb-mode-info-btn" aria-controls="sb-mode-info" aria-expanded="false" aria-label="What does this mode do?">ⓘ</button>
          </div>
          <p id="sb-mode-info" class="sb-mode-info" hidden></p>

          <p id="sb-climb-pool-warning" class="sb-climb-warning" hidden>
            Gauntlet and Champion can behave oddly with small filtered pools when both sides use the filter
            (fewer than ${CLIMB_SMALL_POOL_WARN_AT} scenes). Use a larger filter, or turn off
            "Use filtered scenes for both sides" in Settings.
          </p>

          <p id="sb-pool-status" class="sb-pool-status" hidden></p>

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
    const mode = MODES.find((m) => m.mode === state.currentMode);
    if (info && mode) info.innerHTML = `<strong>${mode.icon} ${mode.title}:</strong> ${mode.tip}`;
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
  function updateFunBadge() {
    const badge = document.getElementById("sb-fun-badge");
    if (badge) badge.hidden = !state.settings.funMode;
  }
  function climbStatusBadge(scene) {
    if (state.currentMode === "placement") {
      const run = state.placement;
      if (run?.scene.id !== scene.id || run.rangeHi === run.rangeLo) return null;
      return `📍 Narrowing between #${run.rangeLo + 1} and #${run.rangeHi + 1}`;
    }
    if (state.currentMode !== "gauntlet" && state.currentMode !== "champion") return null;
    if (state.gauntletFalling && state.gauntletFallingScene?.id === scene.id) {
      return "📍 Finding final placement...";
    }
    if (state.gauntletClimber?.id === scene.id) {
      return state.gauntletWins;
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
        if (forcedLeftScene && !ratingsEnabled()) forcedLeftScene = sandboxScene(forcedLeftScene);
        if (!forcedLeftScene) {
          console.warn("[Stash Battle] Could not fetch scene from URL, falling back to normal pairing");
        }
      }
      let scenes = [];
      let ranks = [null, null];
      if (state.currentMode === "placement") {
        const placementResult = await fetchPlacementPair(forcedLeftScene);
        if (placementResult.done) {
          showPlacementScreen(placementResult.scene, placementResult.rank, placementResult.rating);
          return;
        }
        scenes = placementResult.scenes;
        ranks = placementResult.ranks;
      } else if (state.currentMode === "gauntlet") {
        const gauntletResult = await fetchGauntletPair(forcedLeftScene);
        if (gauntletResult.isVictory) {
          showVictoryScreen(gauntletResult.scenes[0]);
          return;
        }
        if (gauntletResult.isPlacement) {
          showPlacementScreen(
            gauntletResult.scenes[0],
            gauntletResult.placementRank,
            gauntletResult.placementRating
          );
          return;
        }
        scenes = gauntletResult.scenes;
        ranks = gauntletResult.ranks;
      } else if (state.currentMode === "champion") {
        const championResult = await fetchChampionPair(forcedLeftScene);
        if (championResult.isVictory) {
          showVictoryScreen(championResult.scenes[0]);
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
  async function restoreCurrentPair() {
    state.disableChoice = false;
    const left = state.currentPair.left;
    const right = state.currentPair.right;
    void loadPoolSize().then(updatePoolStatus).catch((e) => console.warn("[Stash Battle] Could not load scene pools for the status line:", e));
    if (!await verifyCurrentPair()) return;
    console.log("[Stash Battle] 📂 Rendering saved pair (no network fetch needed)");
    renderPair([left, right], [state.currentRanks.left, state.currentRanks.right]);
    updatePoolStatus();
  }
  async function verifyCurrentPair() {
    const { left, right } = state.currentPair;
    if (!left || !right) return true;
    try {
      const existing = await findExistingSceneIds([left.id, right.id]);
      const gone = [left, right].find((s) => !existing.has(s.id));
      if (gone) {
        console.log(`[Stash Battle] 👻 Scene ${gone.id} in the current pair no longer exists`);
        await handleSceneGone(gone.id);
        return false;
      }
    } catch (e) {
      console.warn("[Stash Battle] Could not verify current pair:", e);
    }
    return true;
  }
  function dropFromRun(sceneId) {
    state.gauntletDefeated = state.gauntletDefeated.filter((id) => id !== sceneId);
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
    const runSceneIds = [left?.id, state.placement?.scene.id, state.gauntletClimber?.id, state.gauntletFallingScene?.id];
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
  function activeClimberId() {
    if (state.gauntletFalling && state.gauntletFallingScene) {
      return state.gauntletFallingScene.id;
    }
    return state.gauntletClimber?.id ?? null;
  }
  function battleRoleFor(sceneId, mode) {
    if (mode === "swiss") return "combatant";
    const climberId = activeClimberId();
    return climberId !== null && sceneId === climberId ? "climber" : "benchmark";
  }
  function battleRating(scene) {
    const unrated = state.currentMode === "swiss" ? state.settings.unratedRating : 0;
    return effectiveRating(scene.rating100, unrated);
  }
  function applyModePolicy(winner, loser, mode, raw) {
    if (mode === "swiss") return raw;
    let winnerDelta = 0;
    let loserDelta = 0;
    if (battleRoleFor(winner.id, mode) === "climber") {
      winnerDelta = raw.winner;
    }
    const loserRating = loser.rating100 || 1;
    if (battleRoleFor(loser.id, mode) === "benchmark" && loserRating === 100) {
      loserDelta = -1;
    }
    return { winner: winnerDelta, loser: loserDelta };
  }
  function resolveComparison(winner, loser) {
    const mode = state.currentMode;
    const winnerRating = battleRating(winner);
    const loserRating = battleRating(loser);
    const climberId = activeClimberId();
    const winnerPlayCount = mode !== "swiss" && climberId === winner.id ? CLIMB_K_PLAY_COUNT : winner.play_count ?? 0;
    const raw = calculateRatingChanges({
      winner: { rating: winnerRating, playCount: winnerPlayCount },
      loser: { rating: loserRating, playCount: loser.play_count ?? 0 }
    });
    const deltas = applyModePolicy(winner, loser, mode, raw);
    if (deltas.winner !== 0) updateSceneRating(winner.id, winnerRating + deltas.winner);
    if (deltas.loser !== 0) updateSceneRating(loser.id, loserRating + deltas.loser);
    return deltas;
  }
  function updateClimbPoolWarning() {
    const warning = document.getElementById("sb-climb-pool-warning");
    if (!warning) return;
    const isClimb = state.currentMode === "gauntlet" || state.currentMode === "champion";
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
    recordPlacementResult(won, won ? choice.loser.id : choice.winner.id);
    saveState();
    choice.winnerCard.classList.add("sb-winner");
    choice.loserCard.classList.add("sb-loser");
    setTimeout(() => loadNewPair(), 600);
  }
  async function handleGauntletClimbChoice(choice) {
    const {
      winner: winnerScene,
      loser: loserScene,
      left,
      winnerCard,
      loserCard
    } = choice;
    const winnerId = winnerScene.id;
    const loserId = loserScene.id;
    const isFirstBattle = !state.gauntletClimber;
    if (isFirstBattle && left.rating100 != null) {
      console.log(
        `[Stash Battle] 📊 Gauntlet: clearing rating ${left.rating100} for scene ${left.id} on first choice`
      );
      await updateSceneRating(left.id, null);
      left.rating100 = null;
    }
    if (isFirstBattle) {
      state.gauntletClimber = left;
    }
    const climber = state.gauntletClimber;
    const winnerRating = winnerScene.rating100 || 1;
    const winnerAnimStart = winnerScene.rating100 ?? 0;
    const loserDisplayRating = loserScene.rating100 ?? 0;
    const { winner: winnerDelta, loser: loserDelta } = resolveComparison(winnerScene, loserScene);
    const newWinnerRating = winnerRating + winnerDelta;
    const newLoserRating = loserDisplayRating + loserDelta;
    let winnerDisplayRating = newWinnerRating;
    if (winnerId === climber.id) {
      state.gauntletDefeated.push(loserId);
      state.gauntletWins++;
      winnerDisplayRating = await applyClimbWinRating(climber, loserScene, newWinnerRating);
      console.log(
        `[Stash Battle] 📊 Gauntlet: climber ${winnerId} won (streak=${state.gauntletWins}), rating → ${winnerDisplayRating}`
      );
    } else if (isFirstBattle) {
      const finalRank = state.totalScenesCount;
      const finalRating = Math.max(1, (winnerScene.rating100 || 1) - 1);
      console.log(
        `[Stash Battle] 📊 Gauntlet: first battle, challenger ${loserId} lost to floor → rank #${finalRank}, rating ${finalRating}`
      );
      void updateSceneRating(loserScene.id, finalRating);
      winnerCard.classList.add("sb-winner");
      if (loserCard) loserCard.classList.add("sb-loser");
      setTimeout(() => {
        showPlacementScreen(loserScene, finalRank, finalRating);
      }, 800);
      return;
    } else {
      console.log(
        `[Stash Battle] 📊 Gauntlet: climber ${climber.id}(rating=${climber.rating100}) LOST to ${winnerId}(rating=${newWinnerRating}), entering falling mode`
      );
      state.gauntletFalling = true;
      state.gauntletFallingScene = loserScene;
      state.gauntletDefeated = [winnerId];
    }
    saveState();
    winnerCard.classList.add("sb-winner");
    if (loserCard) loserCard.classList.add("sb-loser");
    showRatingAnimation(winnerCard, winnerAnimStart, winnerDisplayRating, true);
    if (loserCard) {
      showRatingAnimation(
        loserCard,
        loserDisplayRating,
        loserDelta !== 0 ? newLoserRating : loserDisplayRating,
        false
      );
    }
    scheduleNextPairAfterAnimations();
  }
  async function handleChampionChoice(choice) {
    const {
      winner: winnerScene,
      loser: loserScene,
      left,
      winnerCard,
      loserCard
    } = choice;
    const winnerId = winnerScene.id;
    const loserId = loserScene.id;
    const winnerRating = winnerScene.rating100 || 1;
    const winnerAnimStart = winnerScene.rating100 ?? 0;
    const loserDisplayRating = loserScene.rating100 ?? 0;
    const isFirstBattle = !state.gauntletClimber;
    if (isFirstBattle) {
      state.gauntletClimber = left;
    }
    const climber = state.gauntletClimber;
    const { winner: winnerDelta, loser: loserDelta } = resolveComparison(winnerScene, loserScene);
    const newWinnerRating = winnerRating + winnerDelta;
    const newLoserRating = loserDisplayRating + loserDelta;
    let winnerDisplayRating = newWinnerRating;
    if (winnerId === climber.id) {
      state.gauntletDefeated.push(loserId);
      state.gauntletWins++;
      winnerDisplayRating = await applyClimbWinRating(climber, loserScene, newWinnerRating);
    } else {
      state.gauntletClimber = winnerScene;
      winnerScene.rating100 = newWinnerRating;
      state.gauntletDefeated = [loserId];
      state.gauntletWins = 1;
    }
    saveState();
    winnerCard.classList.add("sb-winner");
    if (loserCard) loserCard.classList.add("sb-loser");
    showRatingAnimation(winnerCard, winnerAnimStart, winnerDisplayRating, true);
    if (loserCard) {
      showRatingAnimation(
        loserCard,
        loserDisplayRating,
        loserDelta !== 0 ? newLoserRating : loserDisplayRating,
        false
      );
    }
    scheduleNextPairAfterAnimations();
  }
  function handleSceneChoice(choice) {
    if (state.disableChoice) return;
    state.disableChoice = true;
    const {
      winner: winnerScene,
      loser: loserScene,
      winnerCard,
      loserCard,
      loserRank
    } = choice;
    const winnerId = winnerScene.id;
    const loserId = loserScene.id;
    if (state.currentMode === "placement") {
      handlePlacementChoice(choice);
      return;
    }
    if (state.currentMode === "gauntlet") {
      if (state.gauntletFalling && state.gauntletFallingScene) {
        const fallingScene = state.gauntletFallingScene;
        const loserRating = loserScene.rating100 || 1;
        console.log(
          `[Stash Battle] 📊 Falling mode: fallingScene=${fallingScene.id} winnerId=${winnerId} loserId=${loserId} loserRating=${loserRating}`
        );
        if (winnerId === fallingScene.id) {
          const finalRating = Math.min(100, loserRating + 1);
          const fallingAnimStart = fallingScene.rating100 ?? 0;
          console.log(
            `[Stash Battle] 📊 Falling scene found floor: loserRating=${loserRating} → finalRating=${finalRating}`
          );
          void updateSceneRating(fallingScene.id, finalRating);
          fallingScene.rating100 = finalRating;
          const finalRank = Math.max(1, (loserRank ?? 1) - 1);
          winnerCard.classList.add("sb-winner");
          if (loserCard) loserCard.classList.add("sb-loser");
          showRatingAnimation(winnerCard, fallingAnimStart, finalRating, true);
          setTimeout(() => {
            showPlacementScreen(fallingScene, finalRank, finalRating);
          }, 1500);
          return;
        } else {
          state.gauntletDefeated.push(winnerId);
          saveState();
          winnerCard.classList.add("sb-winner");
          if (loserCard) loserCard.classList.add("sb-loser");
          setTimeout(() => {
            loadNewPair();
          }, 800);
          return;
        }
      }
      void handleGauntletClimbChoice(choice);
      return;
    }
    if (state.currentMode === "champion") {
      void handleChampionChoice(choice);
      return;
    }
    const winnerStart = battleRating(winnerScene);
    const loserStart = battleRating(loserScene);
    const { winner: winnerDelta, loser: loserDelta } = resolveComparison(winnerScene, loserScene);
    saveState();
    winnerCard.classList.add("sb-winner");
    if (loserCard) loserCard.classList.add("sb-loser");
    showRatingAnimation(winnerCard, winnerStart, winnerStart + winnerDelta, true);
    if (loserCard) {
      showRatingAnimation(loserCard, loserStart, loserStart + loserDelta, false);
    }
    scheduleNextPairAfterAnimations();
  }
  var RATING_ANIM_MAX_TOTAL_MS = 1400;
  var RATING_ANIM_HOLD_MS = 300;
  var RATING_ANIM_COUNT_BUDGET_MS = RATING_ANIM_MAX_TOTAL_MS - RATING_ANIM_HOLD_MS;
  var RATING_ANIM_DEFAULT_STEP_MS = 50;
  var RATING_ANIM_MIN_STEP_MS = 8;
  function scheduleNextPairAfterAnimations() {
    setTimeout(() => loadNewPair(), ratingsEnabled() ? 1500 : 600);
  }
  function showRatingAnimation(card, oldRating, newRating, isWinner) {
    if (!ratingsEnabled()) return;
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
  function onSettingChanged(key) {
    switch (key) {
      case "filterOpponents":
        if (state.currentMode !== "swiss") resetRunState();
        saveState();
        loadNewPair();
        updateClimbPoolWarning();
        break;
      case "funMode":
        resetSandbox();
        resetShuffle();
        resetRunState();
        saveState();
        updateFunBadge();
        loadNewPair();
        break;
      case "previewVolume":
      case "autoplayPreviews":
        applyPreviewSettings();
        break;
      case "openInNewTab":
      case "cleanMode":
      case "unratedRating":
        rerenderCurrentPair();
        break;
    }
  }
  async function openModal() {
    console.log("[Stash Battle] 🎯 Opening modal...");
    const [, customFieldsOk] = await Promise.all([loadSettings(), sceneCustomFieldsSupported()]);
    if (!customFieldsOk) {
      showUnsupportedStash();
      return;
    }
    addKeySwallowers();
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
    if (existingModal && existingModal.classList.contains("sb-modal-hidden")) {
      console.log("[Stash Battle] ♻️ Reusing existing modal");
      existingModal.classList.remove("sb-modal-hidden", "sb-modal-closing");
      document.body.classList.add(BATTLE_OPEN_CLASS);
      showTab(existingModal, "battle");
      syncSettingsControls(existingModal);
      updateFunBadge();
      if (modalKeyHandler) {
        document.removeEventListener("keydown", modalKeyHandler, true);
        document.addEventListener("keydown", modalKeyHandler, true);
      }
      const modalContent2 = existingModal.querySelector(".sb-modal-content");
      if (modalContent2) modalContent2.focus();
      if (forceSceneBattle) {
        loadNewPair(scenePageId);
      } else if (filtersChanged || !state.currentPair.left || !state.currentPair.right) {
        loadNewPair();
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
    bindSettingsControls(modal, onSettingChanged, () => applyPreviewSettings());
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
          resetSandbox();
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
    if (forceSceneBattle) {
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
      if (e.key === "Escape") {
        e.preventDefault();
        closeModal();
        return;
      }
      if (getActiveTab() !== "battle") return;
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
  function showUnsupportedStash() {
    document.getElementById("sb-modal")?.remove();
    const modal = document.createElement("div");
    modal.id = "sb-modal";
    modal.innerHTML = `
      <div class="sb-modal-backdrop"></div>
      <div class="sb-modal-content">
        <button class="sb-modal-close" aria-label="Close">✕</button>
        <div class="sb-error-screen">
          <div class="sb-error-icon">⚠️</div>
          <p class="sb-error-message">
            Stash Battle needs a newer version of Stash: it stores each scene's ELO in scene custom
            fields, which this Stash doesn't have. Update Stash to use Battle.
          </p>
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
  function shouldShowNavButton() {
    const path = window.location.pathname;
    return path === "/" || path === "/scenes" || path === "/scenes/" || path.startsWith("/scenes/");
  }
  function injectNavButton() {
    const buttonId = "plugin_sb";
    if (!shouldShowNavButton()) {
      const existing = document.getElementById(buttonId);
      if (existing) {
        existing.closest(".nav-link")?.remove();
      }
      return;
    }
    if (document.getElementById(buttonId)) return;
    const navItem = document.createElement("div");
    navItem.className = "col-4 col-sm-3 col-md-2 col-lg-auto nav-link";
    navItem.id = buttonId;
    navItem.innerHTML = `
        <a href="#" class="minimal p-4 p-xl-2 d-flex d-xl-inline-block flex-column justify-content-between align-items-center btn btn-primary">
            <svg aria-hidden="true" focusable="false" class="svg-inline--fa fa-icon nav-menu-icon d-block d-xl-inline mb-2 mb-xl-0" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36">
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
            </svg>
            <span>Battle</span>
        </a>
    `;
    const link = navItem.querySelector("a");
    if (link) {
      link.addEventListener("click", (e) => {
        e.preventDefault();
        void openModal();
      });
    }
    const navTarget = document.querySelector(".navbar-nav");
    if (navTarget) {
      navTarget.appendChild(navItem);
    }
  }

  // src/main.ts
  function init() {
    console.log("[Stash Battle] Initialized");
    registerDeleteDialogBridge();
    injectNavButton();
    const observer = new MutationObserver(() => {
      injectNavButton();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL2dyYXBocWwudHMiLCAiLi4vLi4vc3JjL3VpL2RlbGV0ZURpYWxvZy50cyIsICIuLi8uLi9zcmMvY29uc3RhbnRzLnRzIiwgIi4uLy4uL3NyYy9maWx0ZXJzLnRzIiwgIi4uLy4uL3NyYy9zdGF0ZS50cyIsICIuLi8uLi9zcmMvY2FjaGUudHMiLCAiLi4vLi4vc3JjL3NjZW5lQWN0aW9ucy50cyIsICIuLi8uLi9zcmMvcmF0aW5nLnRzIiwgIi4uLy4uL3NyYy9zZXR0aW5ncy50cyIsICIuLi8uLi9zcmMvc3RvcmFnZS50cyIsICIuLi8uLi9zcmMvZWxvLnRzIiwgIi4uLy4uL3NyYy9uYXZpZ2F0aW9uLnRzIiwgIi4uLy4uL3NyYy9wYWlycy50cyIsICIuLi8uLi9zcmMvdWkvc2NlbmVUaXRsZS50cyIsICIuLi8uLi9zcmMvdWkvc2NlbmVDYXJkLnRzIiwgIi4uLy4uL3NyYy91aS9zY3JlZW5zLnRzIiwgIi4uLy4uL3NyYy91aS9zZXR0aW5nc1BhbmVsLnRzIiwgIi4uLy4uL3NyYy91aS9tYWluVUkudHMiLCAiLi4vLi4vc3JjL3VpL21vZGFsLnRzIiwgIi4uLy4uL3NyYy91aS9uYXZCdXR0b24udHMiLCAiLi4vLi4vc3JjL21haW4udHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8vIEdyYXBoUUwgYWNjZXNzIGFnYWluc3QgdGhlIFN0YXNoIGJhY2tlbmQuXG5cbmltcG9ydCB0eXBlIHsgRmluZFNjZW5lUmVzdWx0LCBTY2VuZSB9IGZyb20gXCIuL3R5cGVzXCI7XG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBncmFwaHFsUXVlcnk8VCA9IHVua25vd24+KFxuICBxdWVyeTogc3RyaW5nLFxuICB2YXJpYWJsZXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge30sXG4pOiBQcm9taXNlPFQ+IHtcbiAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChcIi9ncmFwaHFsXCIsIHtcbiAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgIGhlYWRlcnM6IHtcbiAgICAgIFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiLFxuICAgIH0sXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBxdWVyeSwgdmFyaWFibGVzIH0pLFxuICB9KTtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVzcG9uc2UuanNvbigpO1xuICBpZiAocmVzdWx0LmVycm9ycykge1xuICAgIGNvbnNvbGUuZXJyb3IoXCJbU3Rhc2ggQmF0dGxlXSBHcmFwaFFMIGVycm9yOlwiLCByZXN1bHQuZXJyb3JzKTtcbiAgICB0aHJvdyBuZXcgRXJyb3IocmVzdWx0LmVycm9yc1swXS5tZXNzYWdlKTtcbiAgfVxuICByZXR1cm4gcmVzdWx0LmRhdGEgYXMgVDtcbn1cblxuZXhwb3J0IGNvbnN0IFNDRU5FX0ZSQUdNRU5UID0gYFxuICAgIGlkXG4gICAgdGl0bGVcbiAgICBkYXRlXG4gICAgcmF0aW5nMTAwXG4gICAgcGxheV9jb3VudFxuICAgIGN1c3RvbV9maWVsZHNcbiAgICBwYXRocyB7XG4gICAgICBzY3JlZW5zaG90XG4gICAgICBwcmV2aWV3XG4gICAgfVxuICAgIGZpbGVzIHtcbiAgICAgIGR1cmF0aW9uXG4gICAgICBwYXRoXG4gICAgfVxuICAgIHN0dWRpbyB7XG4gICAgICBuYW1lXG4gICAgfVxuICAgIHBlcmZvcm1lcnMge1xuICAgICAgbmFtZVxuICAgIH1cbiAgICB0YWdzIHtcbiAgICAgIG5hbWVcbiAgICB9XG4gIGA7XG5cbmV4cG9ydCBjb25zdCBGSU5EX1NDRU5FU19RVUVSWSA9IGBcbiAgICAgIHF1ZXJ5IEZpbmRTY2VuZXNCeVJhdGluZygkZmlsdGVyOiBGaW5kRmlsdGVyVHlwZSwgJHNjZW5lX2ZpbHRlcjogU2NlbmVGaWx0ZXJUeXBlKSB7XG4gICAgICAgIGZpbmRTY2VuZXMoZmlsdGVyOiAkZmlsdGVyLCBzY2VuZV9maWx0ZXI6ICRzY2VuZV9maWx0ZXIpIHtcbiAgICAgICAgICBjb3VudFxuICAgICAgICAgIHNjZW5lcyB7XG4gICAgICAgICAgICAke1NDRU5FX0ZSQUdNRU5UfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIGA7XG5cbmxldCBjdXN0b21GaWVsZHNTdXBwb3J0OiBQcm9taXNlPGJvb2xlYW4+IHwgbnVsbCA9IG51bGw7XG5cbi8qKlxuICogV2hldGhlciB0aGlzIFN0YXNoIGhhcyBzY2VuZSBjdXN0b20gZmllbGRzIChuZWVkZWQgZm9yIEVMTyBzdG9yYWdlKS4gQ2hlY2tlZCBvbmNlIHBlciBwYWdlXG4gKiBsb2FkIHZpYSBpbnRyb3NwZWN0aW9uOyBpZiBpbnRyb3NwZWN0aW9uIGl0c2VsZiBmYWlscywgYXNzdW1lIHllcyBhbmQgbGV0IHJlYWwgcXVlcmllcyByZXBvcnQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzY2VuZUN1c3RvbUZpZWxkc1N1cHBvcnRlZCgpOiBQcm9taXNlPGJvb2xlYW4+IHtcbiAgY3VzdG9tRmllbGRzU3VwcG9ydCA/Pz0gZ3JhcGhxbFF1ZXJ5PHsgX190eXBlOiB7IGZpZWxkczogeyBuYW1lOiBzdHJpbmcgfVtdIH0gfCBudWxsIH0+KFxuICAgIGBxdWVyeSB7IF9fdHlwZShuYW1lOiBcIlNjZW5lXCIpIHsgZmllbGRzIHsgbmFtZSB9IH0gfWAsXG4gIClcbiAgICAudGhlbigoZGF0YSkgPT4gZGF0YS5fX3R5cGU/LmZpZWxkcy5zb21lKChmKSA9PiBmLm5hbWUgPT09IFwiY3VzdG9tX2ZpZWxkc1wiKSA/PyB0cnVlKVxuICAgIC5jYXRjaCgoZSkgPT4ge1xuICAgICAgY29uc29sZS53YXJuKFwiW1N0YXNoIEJhdHRsZV0gQ291bGQgbm90IGNoZWNrIGZvciBzY2VuZSBjdXN0b20gZmllbGRzOlwiLCBlKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0pO1xuICByZXR1cm4gY3VzdG9tRmllbGRzU3VwcG9ydDtcbn1cblxuLy8gRXh0cmFjdCBzY2VuZSBJRCBmcm9tIGluZGl2aWR1YWwgc2NlbmUgcGFnZXMgbGlrZSAvc2NlbmVzLzEyM1xuZXhwb3J0IGZ1bmN0aW9uIGdldFNjZW5lSWRGcm9tVXJsKCk6IHN0cmluZyB8IG51bGwge1xuICBjb25zdCBtYXRjaCA9IHdpbmRvdy5sb2NhdGlvbi5wYXRobmFtZS5tYXRjaCgvXlxcL3NjZW5lc1xcLyhcXGQrKSQvKTtcbiAgcmV0dXJuIG1hdGNoID8gbWF0Y2hbMV0gOiBudWxsO1xufVxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmV0Y2hTY2VuZUJ5SWQoc2NlbmVJZDogc3RyaW5nKTogUHJvbWlzZTxTY2VuZSB8IG51bGw+IHtcbiAgY29uc3QgcXVlcnkgPSBgXG4gICAgICBxdWVyeSBGaW5kU2NlbmUoJGlkOiBJRCEpIHtcbiAgICAgICAgZmluZFNjZW5lKGlkOiAkaWQpIHtcbiAgICAgICAgICAke1NDRU5FX0ZSQUdNRU5UfVxuICAgICAgICB9XG4gICAgICB9XG4gICAgYDtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZ3JhcGhxbFF1ZXJ5PEZpbmRTY2VuZVJlc3VsdD4ocXVlcnksIHsgaWQ6IHNjZW5lSWQgfSk7XG4gIHJldHVybiByZXN1bHQuZmluZFNjZW5lO1xufVxuIiwgIi8vIENsZWFuIG1vZGU6IG9wZW4gU3Rhc2gncyBvd24gRGVsZXRlU2NlbmVzRGlhbG9nLCBzbyBkZWxldGluZyBmcm9tIGEgYmF0dGxlIGJlaGF2ZXMgZXhhY3RseSBsaWtlXHJcbi8vIGRlbGV0aW5nIGluIFN0YXNoIChzYW1lIG9wdGlvbnMgYW5kIGRlZmF1bHRzLCBmaWxlIGxpc3QsIGRlbGV0ZSBjYWxsIGFuZCB0b2FzdCkuXHJcbi8vXHJcbi8vIFRoZSBkaWFsb2cgbmVlZHMgU3Rhc2gncyBSZWFjdCBjb250ZXh0IChpbnRsLCBjb25maWd1cmF0aW9uLCBBcG9sbG8sIHRvYXN0cyksIHNvIGl0IGNhbid0IGJlXHJcbi8vIHJlbmRlcmVkIHN0YW5kYWxvbmUuIEluc3RlYWQgYSBzbWFsbCBicmlkZ2UgY29tcG9uZW50IGlzIHBhdGNoZWQgaW50byBTdGFzaCdzIG5hdmJhciAoYWx3YXlzXHJcbi8vIG1vdW50ZWQpIGFuZCBvcGVucyB0aGUgZGlhbG9nIHdoZW4gQmF0dGxlIGFza3MgZm9yIGl0LiByZWFjdC1ib290c3RyYXAgcG9ydGFscyB0aGUgbW9kYWwgdG9cclxuLy8gPGJvZHk+OyBDU1MgbGlmdHMgaXQgYWJvdmUgdGhlIGJhdHRsZSBtb2RhbCB3aGlsZSBCYXR0bGUgaXMgb3Blbi5cclxuXHJcbmltcG9ydCB7IGdyYXBocWxRdWVyeSB9IGZyb20gXCIuLi9ncmFwaHFsXCI7XHJcbmltcG9ydCB0eXBlIHsgU2NlbmUgfSBmcm9tIFwiLi4vdHlwZXNcIjtcclxuXHJcbi8qIE1pbmltYWwgdHlwaW5nIGZvciB0aGUgcGFydHMgb2Ygd2luZG93LlBsdWdpbkFwaSB1c2VkIGhlcmUuICovXHJcbnR5cGUgUmVhY3ROb2RlID0gdW5rbm93bjtcclxuaW50ZXJmYWNlIFJlYWN0TGlrZSB7XHJcbiAgY3JlYXRlRWxlbWVudCh0eXBlOiB1bmtub3duLCBwcm9wcz86IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHwgbnVsbCwgLi4uY2hpbGRyZW46IFJlYWN0Tm9kZVtdKTogUmVhY3ROb2RlO1xyXG4gIEZyYWdtZW50OiB1bmtub3duO1xyXG4gIHVzZVN0YXRlPFQ+KGluaXRpYWw6IFQpOiBbVCwgKHZhbHVlOiBUKSA9PiB2b2lkXTtcclxuICB1c2VFZmZlY3QoZWZmZWN0OiAoKSA9PiB2b2lkIHwgKCgpID0+IHZvaWQpLCBkZXBzPzogdW5rbm93bltdKTogdm9pZDtcclxufVxyXG5pbnRlcmZhY2UgUGx1Z2luQXBpTGlrZSB7XHJcbiAgUmVhY3Q6IFJlYWN0TGlrZTtcclxuICAvKiogTG9hZGVycyByZXNvbHZpbmcgdG8gdGhlIGNvbXBvbmVudCdzIG1vZHVsZSAodGhleSBkb24ndCBhZGQgaXQgdG8gYGNvbXBvbmVudHNgKS4gKi9cclxuICBsb2FkYWJsZUNvbXBvbmVudHM/OiBSZWNvcmQ8c3RyaW5nLCAoKSA9PiBQcm9taXNlPFJlY29yZDxzdHJpbmcsIHVua25vd24+Pj47XHJcbiAgcGF0Y2g6IHsgYWZ0ZXIoY29tcG9uZW50OiBzdHJpbmcsIGZuOiAocHJvcHM6IHVua25vd24sIGN0eDogdW5rbm93biwgcmVzdWx0OiBSZWFjdE5vZGUpID0+IFJlYWN0Tm9kZSk6IHZvaWQgfTtcclxufVxyXG5kZWNsYXJlIGdsb2JhbCB7XHJcbiAgaW50ZXJmYWNlIFdpbmRvdyB7XHJcbiAgICBQbHVnaW5BcGk/OiBQbHVnaW5BcGlMaWtlO1xyXG4gIH1cclxufVxyXG5cclxuLyoqIFNjZW5lIGZpZWxkcyBEZWxldGVTY2VuZXNEaWFsb2cgcmVhZHMgKGZpbGUgbGlzdCwgZnVuc2NyaXB0LCBtdXRhdGlvbiBpZHMpLiAqL1xyXG5pbnRlcmZhY2UgRGVsZXRhYmxlU2NlbmUge1xyXG4gIGlkOiBzdHJpbmc7XHJcbiAgdGl0bGU6IHN0cmluZyB8IG51bGw7XHJcbiAgaW50ZXJhY3RpdmU6IGJvb2xlYW47XHJcbiAgZmlsZXM6IHsgcGF0aDogc3RyaW5nIH1bXTtcclxufVxyXG5cclxuY29uc3QgT1BFTl9FVkVOVCA9IFwic3Rhc2gtYmF0dGxlOm9wZW4tZGVsZXRlLWRpYWxvZ1wiO1xyXG5jb25zdCBDTE9TRV9FVkVOVCA9IFwic3Rhc2gtYmF0dGxlOmNsb3NlLWRlbGV0ZS1kaWFsb2dcIjtcclxuXHJcbmxldCBicmlkZ2VSZWdpc3RlcmVkID0gZmFsc2U7XHJcbmxldCBwZW5kaW5nUmVzdWx0OiAoKGRlbGV0ZWQ6IGJvb2xlYW4pID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XHJcbi8qKiBTdGFzaCdzIERlbGV0ZVNjZW5lc0RpYWxvZyBjb21wb25lbnQsIG9uY2UgaXRzIGNodW5rIGhhcyBsb2FkZWQuICovXHJcbmxldCBEZWxldGVTY2VuZXNEaWFsb2c6IHVua25vd24gPSBudWxsO1xyXG5sZXQgZGlhbG9nTG9hZGVkOiBQcm9taXNlPHZvaWQ+ID0gUHJvbWlzZS5yZXNvbHZlKCk7XHJcblxyXG5mdW5jdGlvbiBzZXR0bGUoZGVsZXRlZDogYm9vbGVhbik6IHZvaWQge1xyXG4gIGNvbnN0IHJlc29sdmUgPSBwZW5kaW5nUmVzdWx0O1xyXG4gIHBlbmRpbmdSZXN1bHQgPSBudWxsO1xyXG4gIHJlc29sdmU/LihkZWxldGVkKTtcclxufVxyXG5cclxuLyoqIFRydWUgd2hlbiB0aGlzIFN0YXNoIGV4cG9zZXMgaXRzIGRlbGV0ZSBkaWFsb2cgdG8gcGx1Z2lucyAoQ2xlYW4gbW9kZSBkZXBlbmRzIG9uIGl0KS4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGlzU3Rhc2hEZWxldGVEaWFsb2dBdmFpbGFibGUoKTogYm9vbGVhbiB7XHJcbiAgcmV0dXJuIGJyaWRnZVJlZ2lzdGVyZWQ7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBpc0RlbGV0ZURpYWxvZ09wZW4oKTogYm9vbGVhbiB7XHJcbiAgcmV0dXJuIHBlbmRpbmdSZXN1bHQgIT09IG51bGw7XHJcbn1cclxuXHJcbi8qKiBDbG9zZSB0aGUgZGlhbG9nIHdpdGhvdXQgZGVsZXRpbmcgKGUuZy4gd2hlbiB0aGUgYmF0dGxlIG1vZGFsIGNsb3NlcykuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBjYW5jZWxEZWxldGVEaWFsb2coKTogdm9pZCB7XHJcbiAgaWYgKCFwZW5kaW5nUmVzdWx0KSByZXR1cm47XHJcbiAgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEN1c3RvbUV2ZW50KENMT1NFX0VWRU5UKSk7XHJcbiAgc2V0dGxlKGZhbHNlKTtcclxufVxyXG5cclxuLyoqIFBhdGNoIHRoZSBicmlkZ2UgaW50byBTdGFzaCdzIG5hdmJhci4gQ2FsbCBvbmNlIGF0IHN0YXJ0dXAsIGJlZm9yZSB0aGUgbmF2YmFyIHJlbmRlcnMuICovXHJcbmV4cG9ydCBmdW5jdGlvbiByZWdpc3RlckRlbGV0ZURpYWxvZ0JyaWRnZSgpOiB2b2lkIHtcclxuICBjb25zdCBhcGkgPSB3aW5kb3cuUGx1Z2luQXBpO1xyXG4gIGlmIChicmlkZ2VSZWdpc3RlcmVkIHx8ICFhcGk/LmxvYWRhYmxlQ29tcG9uZW50cz8uRGVsZXRlU2NlbmVzRGlhbG9nKSB7XHJcbiAgICBpZiAoIWFwaT8ubG9hZGFibGVDb21wb25lbnRzPy5EZWxldGVTY2VuZXNEaWFsb2cpIHtcclxuICAgICAgY29uc29sZS53YXJuKFwiW1N0YXNoIEJhdHRsZV0gU3Rhc2gncyBkZWxldGUgZGlhbG9nIGlzbid0IGF2YWlsYWJsZSB0byBwbHVnaW5zOyBDbGVhbiBtb2RlIGlzIGRpc2FibGVkXCIpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuO1xyXG4gIH1cclxuICBicmlkZ2VSZWdpc3RlcmVkID0gdHJ1ZTtcclxuICBjb25zdCB7IFJlYWN0IH0gPSBhcGk7XHJcblxyXG4gIC8vIExvYWQgdGhlIGRpYWxvZydzIGNodW5rIHVwIGZyb250IHNvIGl0IG9wZW5zIGluc3RhbnRseVxyXG4gIGRpYWxvZ0xvYWRlZCA9IGFwaS5sb2FkYWJsZUNvbXBvbmVudHNcclxuICAgIC5EZWxldGVTY2VuZXNEaWFsb2coKVxyXG4gICAgLnRoZW4oKG1vZCkgPT4ge1xyXG4gICAgICBEZWxldGVTY2VuZXNEaWFsb2cgPSBtb2QuRGVsZXRlU2NlbmVzRGlhbG9nID8/IG1vZC5kZWZhdWx0ID8/IG51bGw7XHJcbiAgICB9KVxyXG4gICAgLmNhdGNoKChlKSA9PiBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0gRmFpbGVkIHRvIGxvYWQgU3Rhc2gncyBkZWxldGUgZGlhbG9nOlwiLCBlKSk7XHJcblxyXG4gIGZ1bmN0aW9uIERlbGV0ZUJyaWRnZSgpOiBSZWFjdE5vZGUge1xyXG4gICAgY29uc3QgW3NjZW5lLCBzZXRTY2VuZV0gPSBSZWFjdC51c2VTdGF0ZTxEZWxldGFibGVTY2VuZSB8IG51bGw+KG51bGwpO1xyXG5cclxuICAgIFJlYWN0LnVzZUVmZmVjdCgoKSA9PiB7XHJcbiAgICAgIGNvbnN0IG9wZW4gPSAoZTogRXZlbnQpOiB2b2lkID0+IHtcclxuICAgICAgICAvLyBUaGUgbmF2YmFyIGNhbiByZW5kZXIgbW9yZSB0aGFuIG9uY2U7IHRoZSBmaXJzdCBicmlkZ2UgdG8gaGVhciB0aGUgZXZlbnQgaGFuZGxlcyBpdC5cclxuICAgICAgICAvLyBwcmV2ZW50RGVmYXVsdCB0ZWxscyBjb25maXJtRGVsZXRlU2NlbmUgdGhlIHJlcXVlc3Qgd2FzIHBpY2tlZCB1cC5cclxuICAgICAgICBlLnN0b3BJbW1lZGlhdGVQcm9wYWdhdGlvbigpO1xyXG4gICAgICAgIGUucHJldmVudERlZmF1bHQoKTtcclxuICAgICAgICBzZXRTY2VuZSgoZSBhcyBDdXN0b21FdmVudDxEZWxldGFibGVTY2VuZT4pLmRldGFpbCk7XHJcbiAgICAgIH07XHJcbiAgICAgIGNvbnN0IGNsb3NlID0gKCk6IHZvaWQgPT4gc2V0U2NlbmUobnVsbCk7XHJcbiAgICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKE9QRU5fRVZFTlQsIG9wZW4pO1xyXG4gICAgICB3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcihDTE9TRV9FVkVOVCwgY2xvc2UpO1xyXG4gICAgICByZXR1cm4gKCkgPT4ge1xyXG4gICAgICAgIHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKE9QRU5fRVZFTlQsIG9wZW4pO1xyXG4gICAgICAgIHdpbmRvdy5yZW1vdmVFdmVudExpc3RlbmVyKENMT1NFX0VWRU5ULCBjbG9zZSk7XHJcbiAgICAgIH07XHJcbiAgICB9LCBbXSk7XHJcblxyXG4gICAgaWYgKCFzY2VuZSB8fCAhRGVsZXRlU2NlbmVzRGlhbG9nKSByZXR1cm4gbnVsbDtcclxuICAgIHJldHVybiBSZWFjdC5jcmVhdGVFbGVtZW50KERlbGV0ZVNjZW5lc0RpYWxvZywge1xyXG4gICAgICBzZWxlY3RlZDogW3NjZW5lXSxcclxuICAgICAgb25DbG9zZTogKGRlbGV0ZWQ6IGJvb2xlYW4pID0+IHtcclxuICAgICAgICBzZXRTY2VuZShudWxsKTtcclxuICAgICAgICBzZXR0bGUoZGVsZXRlZCk7XHJcbiAgICAgIH0sXHJcbiAgICB9KTtcclxuICB9XHJcblxyXG4gIC8vIFN0YXNoIGFwcGVuZHMgdGhlIHJlbmRlcmVkIHJlc3VsdCBhZnRlciB0aGUgY2FsbCdzIGFyZ3MsIGFuZCBhbm90aGVyIHBsdWdpbidzIGBiZWZvcmVgIHBhdGNoXHJcbiAgLy8gY2FuIGNoYW5nZSBob3cgbWFueSBhcmdzIHRoZXJlIGFyZSwgc28gdGhlIHJlc3VsdCBpcyBhbHdheXMgdGhlIGxhc3Qgb25lLCBub3QgYSBmaXhlZCBzbG90LlxyXG4gIGFwaS5wYXRjaC5hZnRlcihcIk1haW5OYXZCYXIuVXRpbGl0eUl0ZW1zXCIsICguLi5hcmdzOiB1bmtub3duW10pID0+XHJcbiAgICBSZWFjdC5jcmVhdGVFbGVtZW50KFxyXG4gICAgICBSZWFjdC5GcmFnbWVudCxcclxuICAgICAgbnVsbCxcclxuICAgICAgYXJnc1thcmdzLmxlbmd0aCAtIDFdIGFzIFJlYWN0Tm9kZSxcclxuICAgICAgUmVhY3QuY3JlYXRlRWxlbWVudChEZWxldGVCcmlkZ2UpLFxyXG4gICAgKSxcclxuICApO1xyXG59XHJcblxyXG4vKipcclxuICogT3BlbiBTdGFzaCdzIGRlbGV0ZSBkaWFsb2cgZm9yIGBzY2VuZWAuIFJlc29sdmVzIHRydWUgb25jZSBTdGFzaCBoYXMgZGVsZXRlZCBpdCwgZmFsc2UgaWYgdGhlXHJcbiAqIHVzZXIgY2FuY2VsbGVkIChvciB0aGUgZGVsZXRlIGZhaWxlZCDigJQgU3Rhc2ggc2hvd3MgaXRzIG93biBlcnJvciB0b2FzdCkuXHJcbiAqL1xyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY29uZmlybURlbGV0ZVNjZW5lKHNjZW5lOiBTY2VuZSk6IFByb21pc2U8Ym9vbGVhbj4ge1xyXG4gIGlmICghYnJpZGdlUmVnaXN0ZXJlZCkgcmV0dXJuIGZhbHNlO1xyXG4gIGNhbmNlbERlbGV0ZURpYWxvZygpO1xyXG4gIGF3YWl0IGRpYWxvZ0xvYWRlZDtcclxuICBpZiAoIURlbGV0ZVNjZW5lc0RpYWxvZykgcmV0dXJuIGZhbHNlO1xyXG5cclxuICBjb25zdCB7IGZpbmRTY2VuZSB9ID0gYXdhaXQgZ3JhcGhxbFF1ZXJ5PHsgZmluZFNjZW5lOiBEZWxldGFibGVTY2VuZSB8IG51bGwgfT4oXHJcbiAgICBgcXVlcnkgQmF0dGxlRGVsZXRhYmxlU2NlbmUoJGlkOiBJRCEpIHsgZmluZFNjZW5lKGlkOiAkaWQpIHsgaWQgdGl0bGUgaW50ZXJhY3RpdmUgZmlsZXMgeyBwYXRoIH0gfSB9YCxcclxuICAgIHsgaWQ6IHNjZW5lLmlkIH0sXHJcbiAgKTtcclxuICBpZiAoIWZpbmRTY2VuZSkgcmV0dXJuIGZhbHNlO1xyXG5cclxuICBjb25zdCByZXN1bHQgPSBuZXcgUHJvbWlzZTxib29sZWFuPigocmVzb2x2ZSkgPT4ge1xyXG4gICAgcGVuZGluZ1Jlc3VsdCA9IHJlc29sdmU7XHJcbiAgfSk7XHJcblxyXG4gIC8vIFN0YXNoIHJlbmRlcnMgdGhlIG5hdmJhciBhZnRlciBwbHVnaW5zIGxvYWQsIHNvIHRoZSBicmlkZ2UgaXMgbW91bnRlZCB3ZWxsIGJlZm9yZSBhbnlvbmUgY2FuXHJcbiAgLy8gY2xpY2sgYSBkZWxldGUgYnV0dG9uOyBpZiBpdCBzb21laG93IGlzbid0LCBzYXkgc28gcmF0aGVyIHRoYW4gZmFraW5nIGEgbmF2aWdhdGlvblxyXG4gIGlmICghcmVxdWVzdERpYWxvZyhmaW5kU2NlbmUpKSB7XHJcbiAgICBjb25zb2xlLndhcm4oXCJbU3Rhc2ggQmF0dGxlXSBTdGFzaCdzIGRlbGV0ZSBkaWFsb2cgYnJpZGdlIGlzbid0IG1vdW50ZWRcIik7XHJcbiAgICBzZXR0bGUoZmFsc2UpO1xyXG4gICAgd2luZG93LmFsZXJ0KFwiQ291bGRuJ3Qgb3BlbiBTdGFzaCdzIGRlbGV0ZSBkaWFsb2cuIFJlbG9hZCB0aGUgcGFnZSBhbmQgdHJ5IGFnYWluLlwiKTtcclxuICB9XHJcbiAgcmV0dXJuIHJlc3VsdDtcclxufVxyXG5cclxuLyoqIEFzayB0aGUgYnJpZGdlIHRvIG9wZW4gdGhlIGRpYWxvZzsgZmFsc2UgaWYgbm8gYnJpZGdlIGlzIG1vdW50ZWQgdG8gcGljayBpdCB1cC4gKi9cclxuZnVuY3Rpb24gcmVxdWVzdERpYWxvZyhzY2VuZTogRGVsZXRhYmxlU2NlbmUpOiBib29sZWFuIHtcclxuICBjb25zdCByZXF1ZXN0ID0gbmV3IEN1c3RvbUV2ZW50KE9QRU5fRVZFTlQsIHsgZGV0YWlsOiBzY2VuZSwgY2FuY2VsYWJsZTogdHJ1ZSB9KTtcclxuICByZXR1cm4gIXdpbmRvdy5kaXNwYXRjaEV2ZW50KHJlcXVlc3QpO1xyXG59XHJcbiIsICIvLyBQbHVnaW4td2lkZSBjb25zdGFudHMuXHJcblxyXG5leHBvcnQgY29uc3QgU1RPUkFHRV9LRVkgPSBcInN0YXNoLWJhdHRsZS1zdGF0ZVwiO1xyXG5leHBvcnQgY29uc3QgQ0FDSEVfREJfTkFNRSA9IFwic3Rhc2gtYmF0dGxlLWNhY2hlXCI7XHJcbmV4cG9ydCBjb25zdCBDQUNIRV9EQl9WRVJTSU9OID0gMTtcclxuZXhwb3J0IGNvbnN0IENBQ0hFX1NUT1JFX05BTUUgPSBcInNjZW5lc1wiO1xyXG5leHBvcnQgY29uc3QgQ0FDSEVfTUFYX0FHRV9NUyA9IDUgKiA2MCAqIDEwMDA7IC8vIDUgbWludXRlcyBjYWNoZSBleHBpcnlcclxuXHJcbmltcG9ydCB0eXBlIHsgU2V0dGluZ3MgfSBmcm9tIFwiLi90eXBlc1wiO1xyXG5cclxuLyoqIFBsdWdpbiBpZCAoZm9sZGVyIG5hbWUpIOKAlCBrZXkgZm9yIHRoaXMgcGx1Z2luJ3Mgc2V0dGluZ3MgaW4gU3Rhc2gncyBjb25maWd1cmF0aW9uLiAqL1xyXG5leHBvcnQgY29uc3QgUExVR0lOX0lEID0gXCJzdGFzaC1iYXR0bGVcIjtcclxuXHJcbmV4cG9ydCBjb25zdCBERUZBVUxUX1NFVFRJTkdTOiBTZXR0aW5ncyA9IHtcclxuICBmdW5Nb2RlOiBmYWxzZSxcclxuICBvcGVuSW5OZXdUYWI6IGZhbHNlLFxyXG4gIHVucmF0ZWRSYXRpbmc6IDUwLFxyXG4gIHByZXZpZXdWb2x1bWU6IDUwLFxyXG4gIGF1dG9wbGF5UHJldmlld3M6IHRydWUsXHJcbiAgZmlsdGVyT3Bwb25lbnRzOiBmYWxzZSxcclxuICBjbGVhbk1vZGU6IGZhbHNlLFxyXG4gIHBhdXNlTWVkaWFPbk9wZW46IHRydWUsXHJcbn07XHJcblxyXG4vLyBQcmUtMi43IGxvY2FsU3RvcmFnZSBwcmVmZXJlbmNlIGtleXMgKG1pZ3JhdGVkIGludG8gcGx1Z2luIHNldHRpbmdzKS5cclxuZXhwb3J0IGNvbnN0IExFR0FDWV9GSUxURVJfT1BQT05FTlRTX0tFWSA9IFwic2JfZmlsdGVyT3Bwb25lbnRzXCI7XHJcbmV4cG9ydCBjb25zdCBMRUdBQ1lfTVVURV9QUkVWSUVXU19LRVkgPSBcInNiX211dGVQcmV2aWV3c1wiO1xyXG5cclxuLy8gU3dpc3MgbW9kZTogaW5pdGlhbCByYW5rIGJhbmQgKMKxTikgd2hlbiBwaWNraW5nIGEgc2ltaWxhci1zdHJlbmd0aCBvcHBvbmVudDsgZG91YmxlcyB1bnRpbCBjYW5kaWRhdGVzIGV4aXN0LlxyXG5leHBvcnQgY29uc3QgU1dJU1NfT1BQT05FTlRfUkVBQ0hfSU5JVElBTCA9IDEwO1xyXG5leHBvcnQgY29uc3QgU1dJU1NfT1BQT05FTlRfUkVBQ0hfTVVMVElQTElFUiA9IDI7XHJcblxyXG4vLyBHYXVudGxldC9jaGFtcGlvbjogcmFuZG9tIHBpY2sgYW1vbmcgdGhlIE4gY2xvc2VzdCB1bmRlZmVhdGVkIG9wcG9uZW50cyBhYm92ZSB0aGUgY2xpbWJlci5cclxuZXhwb3J0IGNvbnN0IENMSU1CX09QUE9ORU5UX1BJQ0tfV0lORE9XID0gNTtcclxuXHJcbi8qKiBTaG93IGEgVUkgd2FybmluZyB3aGVuIHRoZSBjbGltYiBvcHBvbmVudCBwb29sIGlzIHNtYWxsZXIgdGhhbiB0aGlzIChmaWx0ZXIgb3Bwb25lbnRzIG9uKS4gKi9cclxuZXhwb3J0IGNvbnN0IENMSU1CX1NNQUxMX1BPT0xfV0FSTl9BVCA9IDEwO1xyXG5cclxuLyoqIHBsYXlfY291bnQgc3RhbmQtaW4gd2hlbiB0aGUgY2xpbWJlciB3aW5zIGluIGdhdW50bGV0L2NoYW1waW9uICgwIOKGkiBLPTEyKS4gKi9cclxuZXhwb3J0IGNvbnN0IENMSU1CX0tfUExBWV9DT1VOVCA9IDA7XHJcblxyXG4vLyAtLS0gVHJ1ZSBFTE8gKHN0b3JlZCBpbiBzY2VuZSBjdXN0b20gZmllbGRzKSAtLS1cclxuXHJcbi8qKiBTY2VuZSBjdXN0b20gZmllbGQga2V5cy4gV3JpdGVzIHVzZSBgcGFydGlhbGAsIHNvIG90aGVyIHBsdWdpbnMnIGZpZWxkcyBhcmUgbmV2ZXIgdG91Y2hlZC4gKi9cclxuZXhwb3J0IGNvbnN0IEVMT19GSUVMRCA9IFwic3Rhc2hfYmF0dGxlX2Vsb1wiO1xyXG5leHBvcnQgY29uc3QgR0FNRVNfRklFTEQgPSBcInN0YXNoX2JhdHRsZV9nYW1lc1wiO1xyXG5cclxuZXhwb3J0IGNvbnN0IEVMT19TVEFSVCA9IDE1MDA7XHJcbmV4cG9ydCBjb25zdCBFTE9fRElWSVNPUiA9IDQwMDtcclxuXHJcbi8qKiBLIGJ5IGdhbWVzIHBsYXllZDogW2dhbWVzIGJlbG93IHdoaWNoIHRoaXMgSyBhcHBsaWVzLCBLXTsgdGhlIGxhc3QgZW50cnkgaGFzIG5vIGxpbWl0LiAqL1xyXG5leHBvcnQgY29uc3QgRUxPX0tfVElFUlM6IHJlYWRvbmx5IChyZWFkb25seSBbbnVtYmVyLCBudW1iZXJdKVtdID0gW1xyXG4gIFsxMCwgNDBdLFxyXG4gIFszMCwgMjRdLFxyXG4gIFtJbmZpbml0eSwgMTZdLFxyXG5dO1xyXG5cclxuLyoqXHJcbiAqIEVMTyBwb2ludHMgcGVyIDEtMTAwIHJhdGluZyBwb2ludC4gVGhlIHByZS0zLjAgbWF0aCBkaXZpZGVkIGJ5IDQwIG9uIHRoZSAxLTEwMCBzY2FsZSwgc28gb25lXHJcbiAqIHJhdGluZyBwb2ludCBhbHJlYWR5IG1lYW50IGV4YWN0bHkgMTAgc3RhbmRhcmQgKGRpdmlzb3IgNDAwKSBFTE8gcG9pbnRzLlxyXG4gKi9cclxuZXhwb3J0IGNvbnN0IEVMT19QRVJfUkFUSU5HX1BPSU5UID0gMTA7XHJcblxyXG4vKiogR2FtZXMgY3JlZGl0ZWQgdG8gc2NlbmVzIHNlZWRlZCBmcm9tIHRoZWlyIFN0YXNoIHJhdGluZyAodGhlaXIgcmF0aW5nIGFscmVhZHkgc2F5cyBzb21ldGhpbmcpLiAqL1xyXG5leHBvcnQgY29uc3QgU0VFREVEX0dBTUVTID0gMTA7XHJcblxyXG4vKiogRUxPIGdhcCBhYm92ZSB0aGUgdG9wIC8gYmVsb3cgdGhlIGJvdHRvbSBzY2VuZSB3aGVuIFBsYWNlbWVudCBsYW5kcyBhIHNjZW5lIGF0IGFuIGVkZ2UuICovXHJcbmV4cG9ydCBjb25zdCBQTEFDRU1FTlRfRURHRV9HQVAgPSAyNTtcclxuIiwgIi8vIFVSTCBmaWx0ZXIgcGFyc2luZyBmb3IgU3Rhc2ggbGlzdCDihpIgR3JhcGhRTCBzY2VuZSBxdWVyaWVzLlxuXG5pbXBvcnQgdHlwZSB7IEZpbmRGaWx0ZXJUeXBlLCBTY2VuZUZpbHRlclR5cGUgfSBmcm9tIFwiLi90eXBlc1wiO1xuXG4vLyBHZXQgY3VycmVudCBVUkwgc2VhcmNoIHBhcmFtc1xuZXhwb3J0IGZ1bmN0aW9uIGdldFNlYXJjaFBhcmFtcygpOiBVUkxTZWFyY2hQYXJhbXMge1xuICByZXR1cm4gbmV3IFVSTFNlYXJjaFBhcmFtcyh3aW5kb3cubG9jYXRpb24uc2VhcmNoKTtcbn1cblxuLy8gQnVpbGQgRmluZEZpbHRlclR5cGUgZnJvbSBjdXJyZW50IFVSTCBzZWFyY2ggcGFyYW1zIChvciBhbiBleHBsaWNpdCBwYXJhbXMgb2JqZWN0KS5cbmV4cG9ydCBmdW5jdGlvbiBnZXRGaW5kRmlsdGVyKFxuICBvdmVycmlkZXM6IFBhcnRpYWw8RmluZEZpbHRlclR5cGU+ID0ge30sXG4gIHNlYXJjaFBhcmFtczogVVJMU2VhcmNoUGFyYW1zID0gZ2V0U2VhcmNoUGFyYW1zKCksXG4pOiBGaW5kRmlsdGVyVHlwZSB7XG4gIGNvbnN0IGZpbHRlcjogRmluZEZpbHRlclR5cGUgPSB7XG4gICAgcGVyX3BhZ2U6IG92ZXJyaWRlcy5wZXJfcGFnZSA/PyAtMSxcbiAgICBzb3J0OiBvdmVycmlkZXMuc29ydCA/PyAoc2VhcmNoUGFyYW1zLmdldChcInNvcnRieVwiKSB8fCBcInJhdGluZ1wiKSxcbiAgICBkaXJlY3Rpb246IG92ZXJyaWRlcy5kaXJlY3Rpb24gPz8gKHNlYXJjaFBhcmFtcy5nZXQoXCJzb3J0ZGlyXCIpPy50b1VwcGVyQ2FzZSgpIHx8IFwiREVTQ1wiKSxcbiAgICAuLi5vdmVycmlkZXMsXG4gIH07XG5cbiAgLy8gSW5jbHVkZSBzZWFyY2ggcXVlcnkgaWYgcHJlc2VudFxuICBjb25zdCBxdWVyeSA9IHNlYXJjaFBhcmFtcy5nZXQoXCJxXCIpO1xuICBpZiAocXVlcnkpIHtcbiAgICBmaWx0ZXIucSA9IHF1ZXJ5O1xuICB9XG5cbiAgcmV0dXJuIGZpbHRlcjtcbn1cblxuLy8gVHJhbnNsYXRlIEpTT04gc3RyaW5nIGJldHdlZW4gVVJMIGZvcm1hdCAocGFyZW50aGVzZXMpIGFuZCBzdGFuZGFyZCBKU09OIChicmFjZXMpXG4vLyBQb3J0ZWQgZnJvbSBTdGFzaCdzIExpc3RGaWx0ZXJNb2RlbC50cmFuc2xhdGVKU09OXG4vLyBUaGlzIHNhZmVseSBoYW5kbGVzIHBhcmVudGhlc2VzIGluc2lkZSBxdW90ZWQgc3RyaW5nc1xuZXhwb3J0IGZ1bmN0aW9uIHRyYW5zbGF0ZUpTT04oanNvblN0cmluZzogc3RyaW5nLCBkZWNvZGluZzogYm9vbGVhbik6IHN0cmluZyB7XG4gIGxldCBpblN0cmluZyA9IGZhbHNlO1xuICBsZXQgZXNjYXBlID0gZmFsc2U7XG4gIHJldHVybiBbLi4uanNvblN0cmluZ11cbiAgICAubWFwKChjKSA9PiB7XG4gICAgICBpZiAoZXNjYXBlKSB7XG4gICAgICAgIGVzY2FwZSA9IGZhbHNlO1xuICAgICAgICByZXR1cm4gYztcbiAgICAgIH1cbiAgICAgIHN3aXRjaCAoYykge1xuICAgICAgICBjYXNlIFwiXFxcXFwiOlxuICAgICAgICAgIGlmIChpblN0cmluZykgZXNjYXBlID0gdHJ1ZTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSAnXCInOlxuICAgICAgICAgIGluU3RyaW5nID0gIWluU3RyaW5nO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlIFwiKFwiOlxuICAgICAgICAgIGlmIChkZWNvZGluZyAmJiAhaW5TdHJpbmcpIHJldHVybiBcIntcIjtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSBcIilcIjpcbiAgICAgICAgICBpZiAoZGVjb2RpbmcgJiYgIWluU3RyaW5nKSByZXR1cm4gXCJ9XCI7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICByZXR1cm4gYztcbiAgICB9KVxuICAgIC5qb2luKFwiXCIpO1xufVxuXG4vLyBDcml0ZXJpb24gY2F0ZWdvcnkgbWFwcGluZ3MgZm9yIFVSTCAtPiBHcmFwaFFMIHRyYW5zZm9ybWF0aW9uXG4vLyBFYWNoIGNhdGVnb3J5IHJlcXVpcmVzIGRpZmZlcmVudCB0cmFuc2Zvcm1hdGlvbiBsb2dpY1xuY29uc3QgQ1JJVEVSSU9OX0NBVEVHT1JJRVMgPSB7XG4gIC8vIEJvb2xlYW46IG5vIG1vZGlmaWVyLCB2YWx1ZSBpcyBcInRydWVcIi9cImZhbHNlXCIgc3RyaW5nIC0+IGNvbnZlcnQgdG8gYm9vbGVhblxuICBib29sZWFuOiBuZXcgU2V0KFtcIm9yZ2FuaXplZFwiLCBcImludGVyYWN0aXZlXCIsIFwicGVyZm9ybWVyX2Zhdm9yaXRlXCJdKSxcbiAgLy8gU3RyaW5nRW51bTogVVJMIGhhcyBtb2RpZmllciBidXQgR3JhcGhRTCBqdXN0IGV4cGVjdHMgdGhlIHN0cmluZyB2YWx1ZSBkaXJlY3RseVxuICBzdHJpbmdFbnVtOiBuZXcgU2V0KFtcImlzX21pc3NpbmdcIiwgXCJoYXNfbWFya2Vyc1wiXSksXG4gIC8vIE11bHRpOiB2YWx1ZSBpcyBhcnJheSBvZiB7aWQsIGxhYmVsfSAtPiBleHRyYWN0IElEcyBvbmx5XG4gIG11bHRpOiBuZXcgU2V0KFtcInBlcmZvcm1lcnNcIiwgXCJncm91cHNcIiwgXCJtb3ZpZXNcIiwgXCJnYWxsZXJpZXNcIl0pLFxuICAvLyBIaWVyYXJjaGljYWxNdWx0aTogdmFsdWUgaGFzIHtpdGVtcywgZXhjbHVkZWQsIGRlcHRofSAtPiByZW5hbWUgdG8ge3ZhbHVlLCBleGNsdWRlcywgZGVwdGh9IGFuZCBleHRyYWN0IElEc1xuICBoaWVyYXJjaGljYWxNdWx0aTogbmV3IFNldChbXCJ0YWdzXCIsIFwic3R1ZGlvc1wiLCBcInBlcmZvcm1lcl90YWdzXCJdKSxcbn07XG5cbi8vIFJlc29sdXRpb24gc3RyaW5nIHRvIEdyYXBoUUwgZW51bSBtYXBwaW5nXG4vLyBVUkwgdXNlcyBodW1hbi1yZWFkYWJsZSBzdHJpbmdzLCBHcmFwaFFMIGV4cGVjdHMgUmVzb2x1dGlvbkVudW0gdmFsdWVzXG5jb25zdCBSRVNPTFVUSU9OX01BUDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgXCIxNDRwXCI6IFwiVkVSWV9MT1dcIixcbiAgXCIyNDBwXCI6IFwiTE9XXCIsXG4gIFwiMzYwcFwiOiBcIlIzNjBQXCIsXG4gIFwiNDgwcFwiOiBcIlNUQU5EQVJEXCIsXG4gIFwiNTQwcFwiOiBcIldFQl9IRFwiLFxuICBcIjcyMHBcIjogXCJTVEFOREFSRF9IRFwiLFxuICBcIjEwODBwXCI6IFwiRlVMTF9IRFwiLFxuICBcIjE0NDBwXCI6IFwiUVVBRF9IRFwiLFxuICBcIjRrXCI6IFwiRk9VUl9LXCIsXG4gIFwiNWtcIjogXCJGSVZFX0tcIixcbiAgXCI2a1wiOiBcIlNJWF9LXCIsXG4gIFwiN2tcIjogXCJTRVZFTl9LXCIsXG4gIFwiOGtcIjogXCJFSUdIVF9LXCIsXG4gIEh1Z2U6IFwiSFVHRVwiLFxufTtcblxuLy8gT3JpZW50YXRpb24gc3RyaW5nIHRvIEdyYXBoUUwgZW51bSBtYXBwaW5nXG5jb25zdCBPUklFTlRBVElPTl9NQVA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gIExhbmRzY2FwZTogXCJMQU5EU0NBUEVcIixcbiAgUG9ydHJhaXQ6IFwiUE9SVFJBSVRcIixcbiAgU3F1YXJlOiBcIlNRVUFSRVwiLFxufTtcblxuY29uc3QgaWRPZiA9ICh2OiBhbnkpOiB1bmtub3duID0+ICh0eXBlb2YgdiA9PT0gXCJvYmplY3RcIiAmJiB2ICYmIHYuaWQgPyB2LmlkIDogdik7XG5cbi8vIEJ1aWxkIFNjZW5lRmlsdGVyVHlwZSBmcm9tIFVSTCAnYycgcGFyYW1zIChkZWZhdWx0cyB0byBjdXJyZW50IHBhZ2UgVVJMKS5cbmV4cG9ydCBmdW5jdGlvbiBnZXRTY2VuZUZpbHRlcihcbiAgc2VhcmNoUGFyYW1zOiBVUkxTZWFyY2hQYXJhbXMgPSBnZXRTZWFyY2hQYXJhbXMoKSxcbik6IFNjZW5lRmlsdGVyVHlwZSB8IG51bGwge1xuICBjb25zdCBzY2VuZUZpbHRlcjogU2NlbmVGaWx0ZXJUeXBlID0ge307XG5cbiAgaWYgKCFzZWFyY2hQYXJhbXMuaGFzKFwiY1wiKSkgcmV0dXJuIG51bGw7XG5cbiAgZm9yIChjb25zdCBjU3RyIG9mIHNlYXJjaFBhcmFtcy5nZXRBbGwoXCJjXCIpKSB7XG4gICAgdHJ5IHtcbiAgICAgIC8vIERlY29kZSBVUkwgZm9ybWF0OiAoKSAtPiB7fSAoc2FmZWx5IHByZXNlcnZpbmcgc3RyaW5ncylcbiAgICAgIGNvbnN0IGRlY29kZWQgPSB0cmFuc2xhdGVKU09OKGNTdHIsIHRydWUpO1xuICAgICAgY29uc3QgY09iajogYW55ID0gSlNPTi5wYXJzZShkZWNvZGVkKTtcblxuICAgICAgY29uc3QgZmlsdGVyVHlwZTogc3RyaW5nIHwgdW5kZWZpbmVkID0gY09iai50eXBlO1xuICAgICAgaWYgKCFmaWx0ZXJUeXBlKSB7XG4gICAgICAgIGNvbnNvbGUud2FybihcIltTdGFzaCBCYXR0bGVdIEZpbHRlciBtaXNzaW5nIHR5cGU6XCIsIGNPYmopO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgLy8gUmVtb3ZlIHR5cGUgZnJvbSB0aGUgb2JqZWN0IC0gaXQgYmVjb21lcyB0aGUga2V5XG4gICAgICBjb25zdCB7IHR5cGU6IF90eXBlLCAuLi5yZXN0IH0gPSBjT2JqO1xuXG4gICAgICAvLyBDYXRlZ29yeTogQm9vbGVhbiAob3JnYW5pemVkLCBpbnRlcmFjdGl2ZSwgcGVyZm9ybWVyX2Zhdm9yaXRlKVxuICAgICAgaWYgKENSSVRFUklPTl9DQVRFR09SSUVTLmJvb2xlYW4uaGFzKGZpbHRlclR5cGUpKSB7XG4gICAgICAgIHNjZW5lRmlsdGVyW2ZpbHRlclR5cGVdID0gcmVzdC52YWx1ZSA9PT0gXCJ0cnVlXCIgfHwgcmVzdC52YWx1ZSA9PT0gdHJ1ZTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIC8vIENhdGVnb3J5OiBTdHJpbmdFbnVtIChzY2VuZUlzTWlzc2luZywgaGFzTWFya2VycylcbiAgICAgIGlmIChDUklURVJJT05fQ0FURUdPUklFUy5zdHJpbmdFbnVtLmhhcyhmaWx0ZXJUeXBlKSkge1xuICAgICAgICBzY2VuZUZpbHRlcltmaWx0ZXJUeXBlXSA9IHJlc3QudmFsdWU7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICAvLyBDYXRlZ29yeTogTXVsdGkgKHBlcmZvcm1lcnMsIGdyb3VwcywgbW92aWVzLCBnYWxsZXJpZXMpXG4gICAgICBpZiAoQ1JJVEVSSU9OX0NBVEVHT1JJRVMubXVsdGkuaGFzKGZpbHRlclR5cGUpKSB7XG4gICAgICAgIGNvbnN0IHJlc3VsdDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7IG1vZGlmaWVyOiByZXN0Lm1vZGlmaWVyIH07XG4gICAgICAgIGNvbnN0IHZhbCA9IHJlc3QudmFsdWUgfHwge307XG5cbiAgICAgICAgaWYgKHZhbC5pdGVtcyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgY29uc3QgaXRlbXM6IGFueVtdID0gdmFsLml0ZW1zIHx8IFtdO1xuICAgICAgICAgIGNvbnN0IGV4Y2x1ZGVkOiBhbnlbXSA9IHZhbC5leGNsdWRlZCB8fCBbXTtcbiAgICAgICAgICByZXN1bHQudmFsdWUgPSBpdGVtcy5tYXAoaWRPZik7XG4gICAgICAgICAgaWYgKGV4Y2x1ZGVkLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIHJlc3VsdC5leGNsdWRlcyA9IGV4Y2x1ZGVkLm1hcChpZE9mKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSBpZiAoQXJyYXkuaXNBcnJheShyZXN0LnZhbHVlKSkge1xuICAgICAgICAgIHJlc3VsdC52YWx1ZSA9IHJlc3QudmFsdWUubWFwKGlkT2YpO1xuICAgICAgICB9IGVsc2UgaWYgKHJlc3QubW9kaWZpZXIgPT09IFwiSVNfTlVMTFwiIHx8IHJlc3QubW9kaWZpZXIgPT09IFwiTk9UX05VTExcIikge1xuICAgICAgICAgIHJlc3VsdC52YWx1ZSA9IFtdO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHJlc3VsdC52YWx1ZSA9IHJlc3QudmFsdWU7XG4gICAgICAgIH1cblxuICAgICAgICBzY2VuZUZpbHRlcltmaWx0ZXJUeXBlXSA9IHJlc3VsdDtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIC8vIENhdGVnb3J5OiBIaWVyYXJjaGljYWxNdWx0aSAodGFncywgc3R1ZGlvcywgcGVyZm9ybWVyX3RhZ3MpXG4gICAgICBpZiAoQ1JJVEVSSU9OX0NBVEVHT1JJRVMuaGllcmFyY2hpY2FsTXVsdGkuaGFzKGZpbHRlclR5cGUpKSB7XG4gICAgICAgIGNvbnN0IHZhbCA9IHJlc3QudmFsdWUgfHwge307XG4gICAgICAgIGNvbnN0IGl0ZW1zOiBhbnlbXSA9IHZhbC5pdGVtcyB8fCBbXTtcbiAgICAgICAgY29uc3QgZXhjbHVkZWQ6IGFueVtdID0gdmFsLmV4Y2x1ZGVkIHx8IFtdO1xuICAgICAgICBzY2VuZUZpbHRlcltmaWx0ZXJUeXBlXSA9IHtcbiAgICAgICAgICBtb2RpZmllcjogcmVzdC5tb2RpZmllcixcbiAgICAgICAgICB2YWx1ZTogaXRlbXMubWFwKGlkT2YpLFxuICAgICAgICAgIGV4Y2x1ZGVzOiBleGNsdWRlZC5tYXAoaWRPZiksXG4gICAgICAgICAgZGVwdGg6IHZhbC5kZXB0aCA/PyAwLFxuICAgICAgICB9O1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgLy8gQ2F0ZWdvcnk6IFJlc29sdXRpb24gKG5lZWRzIHN0cmluZyAtPiBlbnVtIGNvbnZlcnNpb24pXG4gICAgICBpZiAoZmlsdGVyVHlwZSA9PT0gXCJyZXNvbHV0aW9uXCIpIHtcbiAgICAgICAgc2NlbmVGaWx0ZXJbZmlsdGVyVHlwZV0gPSB7XG4gICAgICAgICAgbW9kaWZpZXI6IHJlc3QubW9kaWZpZXIsXG4gICAgICAgICAgdmFsdWU6IFJFU09MVVRJT05fTUFQW3Jlc3QudmFsdWVdIHx8IHJlc3QudmFsdWUsXG4gICAgICAgIH07XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICAvLyBDYXRlZ29yeTogT3JpZW50YXRpb24gKG11bHRpLXNlbGVjdCBlbnVtLCBubyBtb2RpZmllcilcbiAgICAgIGlmIChmaWx0ZXJUeXBlID09PSBcIm9yaWVudGF0aW9uXCIpIHtcbiAgICAgICAgY29uc3QgdmFsdWVzOiBhbnlbXSA9IEFycmF5LmlzQXJyYXkocmVzdC52YWx1ZSkgPyByZXN0LnZhbHVlIDogW3Jlc3QudmFsdWVdO1xuICAgICAgICBzY2VuZUZpbHRlcltmaWx0ZXJUeXBlXSA9IHtcbiAgICAgICAgICB2YWx1ZTogdmFsdWVzLm1hcCgodikgPT4gT1JJRU5UQVRJT05fTUFQW3ZdIHx8IHYpLmZpbHRlcihCb29sZWFuKSxcbiAgICAgICAgfTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIC8vIENhdGVnb3J5OiBEdXBsaWNhdGVkIChwaGFzaCBkdXBsaWNhdGUgZmlsdGVyIC0gZGlmZmVyZW50IHN0cnVjdHVyZSlcbiAgICAgIGlmIChmaWx0ZXJUeXBlID09PSBcImR1cGxpY2F0ZWRcIikge1xuICAgICAgICBzY2VuZUZpbHRlcltmaWx0ZXJUeXBlXSA9IHtcbiAgICAgICAgICBkdXBsaWNhdGVkOiByZXN0LnZhbHVlID09PSBcInRydWVcIiB8fCByZXN0LnZhbHVlID09PSB0cnVlLFxuICAgICAgICB9O1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgLy8gQ2F0ZWdvcnk6IFN0YW5kYXJkIChudW1iZXIsIHN0cmluZywgZGF0ZSwgdGltZXN0YW1wLCBkdXJhdGlvbiwgc3BlY2lhbClcbiAgICAgIGlmIChcbiAgICAgICAgcmVzdC52YWx1ZSAmJlxuICAgICAgICB0eXBlb2YgcmVzdC52YWx1ZSA9PT0gXCJvYmplY3RcIiAmJlxuICAgICAgICAhQXJyYXkuaXNBcnJheShyZXN0LnZhbHVlKSAmJlxuICAgICAgICBcInZhbHVlXCIgaW4gcmVzdC52YWx1ZVxuICAgICAgKSB7XG4gICAgICAgIC8vIEZsYXR0ZW46IHsgbW9kaWZpZXIsIHZhbHVlOiB7IHZhbHVlOiBYLCB2YWx1ZTI6IFkgfSB9IC0+IHsgbW9kaWZpZXIsIHZhbHVlOiBYLCB2YWx1ZTI6IFkgfVxuICAgICAgICBzY2VuZUZpbHRlcltmaWx0ZXJUeXBlXSA9IHtcbiAgICAgICAgICBtb2RpZmllcjogcmVzdC5tb2RpZmllcixcbiAgICAgICAgICB2YWx1ZTogcmVzdC52YWx1ZS52YWx1ZSxcbiAgICAgICAgICAuLi4ocmVzdC52YWx1ZS52YWx1ZTIgIT09IHVuZGVmaW5lZCAmJiB7IHZhbHVlMjogcmVzdC52YWx1ZS52YWx1ZTIgfSksXG4gICAgICAgIH07XG4gICAgICB9IGVsc2UgaWYgKHJlc3QubW9kaWZpZXIgPT09IFwiSVNfTlVMTFwiIHx8IHJlc3QubW9kaWZpZXIgPT09IFwiTk9UX05VTExcIikge1xuICAgICAgICAvLyBJU19OVUxML05PVF9OVUxMIGRvbid0IHVzZSB0aGUgdmFsdWUsIGJ1dCB0aGUgc2NoZW1hIHN0aWxsIHJlcXVpcmVzIGl0XG4gICAgICAgIHNjZW5lRmlsdGVyW2ZpbHRlclR5cGVdID0ge1xuICAgICAgICAgIG1vZGlmaWVyOiByZXN0Lm1vZGlmaWVyLFxuICAgICAgICAgIHZhbHVlOiAwLFxuICAgICAgICB9O1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gUGFzcyB0aHJvdWdoIGFzLWlzIChzdHJpbmcgY3JpdGVyaWEsIHNwZWNpYWwgY3JpdGVyaWEgbGlrZSBwaGFzaCwgc3Rhc2hfaWQsIGV0Yy4pXG4gICAgICAgIHNjZW5lRmlsdGVyW2ZpbHRlclR5cGVdID0gcmVzdDtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0gRmFpbGVkIHRvIHBhcnNlIGZpbHRlcjpcIiwgY1N0ciwgZSk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIE9iamVjdC5rZXlzKHNjZW5lRmlsdGVyKS5sZW5ndGggPiAwID8gc2NlbmVGaWx0ZXIgOiBudWxsO1xufVxuXG4vKiogUGFyc2VkIGZpbHRlciBzdGF0ZSBmb3IgdGhlIGN1cnJlbnQgU3Rhc2ggbGlzdCBVUkwuICovXG5leHBvcnQgaW50ZXJmYWNlIExpc3RGaWx0ZXJzIHtcbiAgZmlsdGVyS2V5OiBzdHJpbmc7XG4gIHNjZW5lRmlsdGVyOiBTY2VuZUZpbHRlclR5cGUgfCBudWxsO1xuICBmaWx0ZXJBY3RpdmU6IGJvb2xlYW47XG59XG5cbi8qKiBSZWFkIFVSTCBmaWx0ZXIgc3RhdGUgb25jZSAoY2FjaGUga2V5LCBHcmFwaFFMIHNjZW5lX2ZpbHRlciwgYWN0aXZlIGZsYWcpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlYWRGaWx0ZXJzKCk6IExpc3RGaWx0ZXJzIHtcbiAgY29uc3Qgc2VhcmNoUGFyYW1zID0gZ2V0U2VhcmNoUGFyYW1zKCk7XG4gIGNvbnN0IHNjZW5lRmlsdGVyID0gZ2V0U2NlbmVGaWx0ZXIoc2VhcmNoUGFyYW1zKTtcbiAgY29uc3QgcSA9IHNlYXJjaFBhcmFtcy5nZXQoXCJxXCIpIHx8IFwiXCI7XG4gIHJldHVybiB7XG4gICAgZmlsdGVyS2V5OiBKU09OLnN0cmluZ2lmeSh7IHEsIGZpbHRlcjogc2NlbmVGaWx0ZXIgfHwge30gfSksXG4gICAgc2NlbmVGaWx0ZXIsXG4gICAgZmlsdGVyQWN0aXZlOiBCb29sZWFuKHNjZW5lRmlsdGVyIHx8IHNlYXJjaFBhcmFtcy5oYXMoXCJjXCIpIHx8IHNlYXJjaFBhcmFtcy5nZXQoXCJxXCIpKSxcbiAgfTtcbn1cblxuLy8gQ2FjaGUga2V5IGZvciB0aGUgY3VycmVudCBsaXN0IFVSTCAoY3JpdGVyaWEgKyB0ZXh0IHNlYXJjaCkuXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRGaWx0ZXJLZXkoKTogc3RyaW5nIHtcbiAgcmV0dXJuIHJlYWRGaWx0ZXJzKCkuZmlsdGVyS2V5O1xufVxuXG4vKiogVHJ1ZSB3aGVuIHRoZSBjdXJyZW50IFN0YXNoIGxpc3QgVVJMIGhhcyBhY3RpdmUgZmlsdGVycyAoY3JpdGVyaWEgYW5kL29yIHRleHQgc2VhcmNoKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjaGVja0ZvckZpbHRlcnMoKTogYm9vbGVhbiB7XG4gIHJldHVybiByZWFkRmlsdGVycygpLmZpbHRlckFjdGl2ZTtcbn1cbiIsICIvLyBDZW50cmFsIG11dGFibGUgcnVudGltZSBzdGF0ZS5cclxuLy9cclxuLy8gVGhlIG9yaWdpbmFsIHBsdWdpbiB1c2VkIG1vZHVsZS1sZXZlbCBgbGV0YCBiaW5kaW5ncyBzaGFyZWQgYWNyb3NzIG1hbnkgZnVuY3Rpb25zLlxyXG4vLyBFUyBtb2R1bGVzIGNhbm5vdCByZWFzc2lnbiBhbiBpbXBvcnRlZCBiaW5kaW5nIGZyb20gYW5vdGhlciBtb2R1bGUsIHNvIGFsbCBzaGFyZWRcclxuLy8gbXV0YWJsZSB2YWx1ZXMgbGl2ZSBvbiB0aGlzIHNpbmdsZSBgc3RhdGVgIG9iamVjdCB0aGF0IGV2ZXJ5IG1vZHVsZSBpbXBvcnRzLlxyXG5cclxuaW1wb3J0IHsgREVGQVVMVF9TRVRUSU5HUyB9IGZyb20gXCIuL2NvbnN0YW50c1wiO1xyXG5pbXBvcnQgdHlwZSB7IE1vZGUsIFBhaXIsIFBsYWNlbWVudFJ1biwgUmFua3MsIFNjZW5lLCBTZXR0aW5ncyB9IGZyb20gXCIuL3R5cGVzXCI7XHJcblxyXG5leHBvcnQgaW50ZXJmYWNlIE1lbW9yeUNhY2hlIHtcclxuICBhbGxTY2VuZXM6IFNjZW5lW10gfCBudWxsOyAvLyBBbGwgc2NlbmVzIChubyBmaWx0ZXIpXHJcbiAgZmlsdGVyZWRTY2VuZXM6IFNjZW5lW10gfCBudWxsOyAvLyBTY2VuZXMgbWF0Y2hpbmcgY3VycmVudCBmaWx0ZXJcclxuICBmaWx0ZXJLZXk6IHN0cmluZyB8IG51bGw7IC8vIEN1cnJlbnQgZmlsdGVyIHBhcmFtcyBmb3IgY2FjaGUgdmFsaWRhdGlvblxyXG4gIHRpbWVzdGFtcDogbnVtYmVyIHwgbnVsbDsgLy8gV2hlbiBjYWNoZSB3YXMgcG9wdWxhdGVkXHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgQmF0dGxlU3RhdGUge1xyXG4gIC8vIEN1cnJlbnQgY29tcGFyaXNvbiBwYWlyIGFuZCBtb2RlXHJcbiAgY3VycmVudFBhaXI6IFBhaXI7XHJcbiAgY3VycmVudFJhbmtzOiBSYW5rcztcclxuICBjdXJyZW50TW9kZTogTW9kZTtcclxuICAvLyBHYXVudGxldCAvIGNoYW1waW9uIHJ1biB0cmFja2luZ1xyXG4gIGdhdW50bGV0Q2xpbWJlcjogU2NlbmUgfCBudWxsOyAvLyBUaGUgc2NlbmUgY3VycmVudGx5IGNsaW1iaW5nIChvbiBhIHdpbiBzdHJlYWspXHJcbiAgZ2F1bnRsZXRXaW5zOiBudW1iZXI7IC8vIEN1cnJlbnQgd2luIHN0cmVha1xyXG4gIGdhdW50bGV0Q2xpbWJlclJhbms6IG51bWJlcjsgLy8gQ2xpbWJlcidzIGN1cnJlbnQgcmFuayBwb3NpdGlvbiAoMSA9IHRvcClcclxuICBnYXVudGxldERlZmVhdGVkOiBzdHJpbmdbXTsgLy8gSURzIG9mIHNjZW5lcyBkZWZlYXRlZCBpbiBjdXJyZW50IHJ1blxyXG4gIGdhdW50bGV0RmFsbGluZzogYm9vbGVhbjsgLy8gVHJ1ZSB3aGVuIGNsaW1iZXIgbG9zdCBhbmQgaXMgZmluZGluZyB0aGVpciBmbG9vclxyXG4gIGdhdW50bGV0RmFsbGluZ1NjZW5lOiBTY2VuZSB8IG51bGw7IC8vIFRoZSBzY2VuZSB0aGF0J3MgZmFsbGluZyB0byBmaW5kIGl0cyBwb3NpdGlvblxyXG4gIC8vIFBsYWNlbWVudCBydW4gdHJhY2tpbmdcclxuICBwbGFjZW1lbnQ6IFBsYWNlbWVudFJ1biB8IG51bGw7XHJcbiAgdG90YWxTY2VuZXNDb3VudDogbnVtYmVyOyAvLyBUb3RhbCBzY2VuZXMgZm9yIHBvc2l0aW9uIGRpc3BsYXlcclxuICBsZWZ0UG9vbFNpemU6IG51bWJlciB8IG51bGw7IC8vIFNjZW5lcyBvbiB0aGUgXCJ0byByYXRlXCIgc2lkZSAoZmlsdGVyIG9yIHdob2xlIGxpYnJhcnkpOyBudWxsIHVudGlsIGxvYWRlZFxyXG4gIGRpc2FibGVDaG9pY2U6IGJvb2xlYW47IC8vIFByZXZlbnRzIG11bHRpcGxlIHJhcGlkIGNob2ljZSBldmVudHNcclxuICBzYXZlZEZpbHRlclBhcmFtczogc3RyaW5nOyAvLyBTdG9yZWQgVVJMIGZpbHRlciBwYXJhbXMgdG8gZGV0ZWN0IGNoYW5nZXNcclxuICAvLyBVc2VyIHNldHRpbmdzIChkZWZhdWx0cyB1bnRpbCBsb2FkU2V0dGluZ3MoKSByZXNvbHZlcylcclxuICBzZXR0aW5nczogU2V0dGluZ3M7XHJcbiAgLy8gU2h1ZmZsZSBzdGF0ZSBmb3IgdGhlIGxlZnQtc2lkZSBwb29sIChwcmV2ZW50cyByZXBlYXRzIHdoZW4gc2tpcHBpbmcpXHJcbiAgc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lczogU2NlbmVbXTtcclxuICBzaHVmZmxlSW5kZXg6IG51bWJlcjtcclxuICBzaHVmZmxlRmlsdGVyS2V5OiBzdHJpbmcgfCBudWxsO1xyXG4gIC8vIFNjZW5lIGNhY2hlIChtZW1vcnkgdGllcilcclxuICBtZW1vcnlDYWNoZTogTWVtb3J5Q2FjaGU7XHJcbn1cclxuXHJcbmV4cG9ydCBjb25zdCBzdGF0ZTogQmF0dGxlU3RhdGUgPSB7XHJcbiAgY3VycmVudFBhaXI6IHsgbGVmdDogbnVsbCwgcmlnaHQ6IG51bGwgfSxcclxuICBjdXJyZW50UmFua3M6IHsgbGVmdDogbnVsbCwgcmlnaHQ6IG51bGwgfSxcclxuICBjdXJyZW50TW9kZTogXCJzd2lzc1wiLFxyXG4gIGdhdW50bGV0Q2xpbWJlcjogbnVsbCxcclxuICBnYXVudGxldFdpbnM6IDAsXHJcbiAgZ2F1bnRsZXRDbGltYmVyUmFuazogMCxcclxuICBnYXVudGxldERlZmVhdGVkOiBbXSxcclxuICBnYXVudGxldEZhbGxpbmc6IGZhbHNlLFxyXG4gIGdhdW50bGV0RmFsbGluZ1NjZW5lOiBudWxsLFxyXG4gIHBsYWNlbWVudDogbnVsbCxcclxuICB0b3RhbFNjZW5lc0NvdW50OiAwLFxyXG4gIGxlZnRQb29sU2l6ZTogbnVsbCxcclxuICBkaXNhYmxlQ2hvaWNlOiBmYWxzZSxcclxuICBzYXZlZEZpbHRlclBhcmFtczogXCJcIixcclxuICBzZXR0aW5nczogeyAuLi5ERUZBVUxUX1NFVFRJTkdTIH0sXHJcbiAgc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lczogW10sXHJcbiAgc2h1ZmZsZUluZGV4OiAwLFxyXG4gIHNodWZmbGVGaWx0ZXJLZXk6IG51bGwsXHJcbiAgbWVtb3J5Q2FjaGU6IHtcclxuICAgIGFsbFNjZW5lczogbnVsbCxcclxuICAgIGZpbHRlcmVkU2NlbmVzOiBudWxsLFxyXG4gICAgZmlsdGVyS2V5OiBudWxsLFxyXG4gICAgdGltZXN0YW1wOiBudWxsLFxyXG4gIH0sXHJcbn07XHJcblxyXG4vKiogQ2xlYXIgYW55IGdhdW50bGV0IC8gY2hhbXBpb24gLyBwbGFjZW1lbnQgcnVuIGluIHByb2dyZXNzLiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gcmVzZXRSdW5TdGF0ZSgpOiB2b2lkIHtcclxuICBzdGF0ZS5nYXVudGxldENsaW1iZXIgPSBudWxsO1xyXG4gIHN0YXRlLmdhdW50bGV0V2lucyA9IDA7XHJcbiAgc3RhdGUuZ2F1bnRsZXRDbGltYmVyUmFuayA9IDA7XHJcbiAgc3RhdGUuZ2F1bnRsZXREZWZlYXRlZCA9IFtdO1xyXG4gIHN0YXRlLmdhdW50bGV0RmFsbGluZyA9IGZhbHNlO1xyXG4gIHN0YXRlLmdhdW50bGV0RmFsbGluZ1NjZW5lID0gbnVsbDtcclxuICBzdGF0ZS5wbGFjZW1lbnQgPSBudWxsO1xyXG59XHJcblxyXG4vKiogRm9yZ2V0IHRoZSBsZWZ0LXNpZGUgc2h1ZmZsZSBzbyB0aGUgbmV4dCBwaWNrIHJlc2h1ZmZsZXMgZnJvbSBhIGZyZXNoIHBvb2wuICovXHJcbmV4cG9ydCBmdW5jdGlvbiByZXNldFNodWZmbGUoKTogdm9pZCB7XHJcbiAgc3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lcyA9IFtdO1xyXG4gIHN0YXRlLnNodWZmbGVJbmRleCA9IDA7XHJcbiAgc3RhdGUuc2h1ZmZsZUZpbHRlcktleSA9IG51bGw7XHJcbn1cclxuXHJcbi8qKiBUcnVlIHdoaWxlIGEgZ2F1bnRsZXQvY2hhbXBpb24vcGxhY2VtZW50IHJ1biBpcyB1bmRlciB3YXkgKHNraXAgaXMgZGlzYWJsZWQpLiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gaXNSdW5BY3RpdmUoKTogYm9vbGVhbiB7XHJcbiAgc3dpdGNoIChzdGF0ZS5jdXJyZW50TW9kZSkge1xyXG4gICAgY2FzZSBcImdhdW50bGV0XCI6XHJcbiAgICBjYXNlIFwiY2hhbXBpb25cIjpcclxuICAgICAgcmV0dXJuIHN0YXRlLmdhdW50bGV0Q2xpbWJlciAhPT0gbnVsbDtcclxuICAgIGNhc2UgXCJwbGFjZW1lbnRcIjpcclxuICAgICAgcmV0dXJuIChzdGF0ZS5wbGFjZW1lbnQ/LmJhdHRsZXMgPz8gMCkgPiAwO1xyXG4gICAgZGVmYXVsdDpcclxuICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gIH1cclxufVxyXG4iLCAiLy8gU2NlbmUgY2FjaGU6IEluZGV4ZWREQiAoZHVyYWJsZSkgKyBpbi1tZW1vcnkgKHBlciBzZXNzaW9uKSwgc3RhbGUtd2hpbGUtcmV2YWxpZGF0ZS5cclxuXHJcbmltcG9ydCB7XHJcbiAgQ0FDSEVfREJfTkFNRSxcclxuICBDQUNIRV9EQl9WRVJTSU9OLFxyXG4gIENBQ0hFX01BWF9BR0VfTVMsXHJcbiAgQ0FDSEVfU1RPUkVfTkFNRSxcclxufSBmcm9tIFwiLi9jb25zdGFudHNcIjtcclxuaW1wb3J0IHsgZ2V0RmluZEZpbHRlciwgdHlwZSBMaXN0RmlsdGVycyB9IGZyb20gXCIuL2ZpbHRlcnNcIjtcclxuaW1wb3J0IHsgRklORF9TQ0VORVNfUVVFUlksIGdyYXBocWxRdWVyeSB9IGZyb20gXCIuL2dyYXBocWxcIjtcclxuaW1wb3J0IHsgc3RhdGUgfSBmcm9tIFwiLi9zdGF0ZVwiO1xyXG5pbXBvcnQgdHlwZSB7IENhY2hlRW50cnksIEZpbmRTY2VuZXNSZXN1bHQsIFNjZW5lIH0gZnJvbSBcIi4vdHlwZXNcIjtcclxuXHJcbi8vIE9wZW4gSW5kZXhlZERCIGRhdGFiYXNlXHJcbmZ1bmN0aW9uIG9wZW5DYWNoZURCKCk6IFByb21pc2U8SURCRGF0YWJhc2U+IHtcclxuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xyXG4gICAgY29uc3QgcmVxdWVzdCA9IGluZGV4ZWREQi5vcGVuKENBQ0hFX0RCX05BTUUsIENBQ0hFX0RCX1ZFUlNJT04pO1xyXG5cclxuICAgIHJlcXVlc3Qub25lcnJvciA9ICgpID0+IHtcclxuICAgICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIEluZGV4ZWREQiBlcnJvcjpcIiwgcmVxdWVzdC5lcnJvcik7XHJcbiAgICAgIHJlamVjdChyZXF1ZXN0LmVycm9yKTtcclxuICAgIH07XHJcblxyXG4gICAgcmVxdWVzdC5vbnN1Y2Nlc3MgPSAoKSA9PiB7XHJcbiAgICAgIHJlc29sdmUocmVxdWVzdC5yZXN1bHQpO1xyXG4gICAgfTtcclxuXHJcbiAgICByZXF1ZXN0Lm9udXBncmFkZW5lZWRlZCA9IChldmVudCkgPT4ge1xyXG4gICAgICBjb25zdCBkYiA9IChldmVudC50YXJnZXQgYXMgSURCT3BlbkRCUmVxdWVzdCkucmVzdWx0O1xyXG4gICAgICBpZiAoIWRiLm9iamVjdFN0b3JlTmFtZXMuY29udGFpbnMoQ0FDSEVfU1RPUkVfTkFNRSkpIHtcclxuICAgICAgICBkYi5jcmVhdGVPYmplY3RTdG9yZShDQUNIRV9TVE9SRV9OQU1FLCB7IGtleVBhdGg6IFwiY2FjaGVLZXlcIiB9KTtcclxuICAgICAgfVxyXG4gICAgfTtcclxuICB9KTtcclxufVxyXG5cclxuLy8gR2V0IGNhY2hlZCBzY2VuZXMgZnJvbSBJbmRleGVkREJcclxuYXN5bmMgZnVuY3Rpb24gZ2V0Q2FjaGVkU2NlbmVzKGNhY2hlS2V5OiBzdHJpbmcpOiBQcm9taXNlPENhY2hlRW50cnkgfCBudWxsPiB7XHJcbiAgdHJ5IHtcclxuICAgIGNvbnN0IGRiID0gYXdhaXQgb3BlbkNhY2hlREIoKTtcclxuICAgIHJldHVybiBuZXcgUHJvbWlzZTxDYWNoZUVudHJ5IHwgbnVsbD4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xyXG4gICAgICBjb25zdCB0cmFuc2FjdGlvbiA9IGRiLnRyYW5zYWN0aW9uKENBQ0hFX1NUT1JFX05BTUUsIFwicmVhZG9ubHlcIik7XHJcbiAgICAgIGNvbnN0IHN0b3JlID0gdHJhbnNhY3Rpb24ub2JqZWN0U3RvcmUoQ0FDSEVfU1RPUkVfTkFNRSk7XHJcbiAgICAgIGNvbnN0IHJlcXVlc3QgPSBzdG9yZS5nZXQoY2FjaGVLZXkpO1xyXG5cclxuICAgICAgcmVxdWVzdC5vbnN1Y2Nlc3MgPSAoKSA9PiB7XHJcbiAgICAgICAgY29uc3QgcmVzdWx0ID0gcmVxdWVzdC5yZXN1bHQgYXMgQ2FjaGVFbnRyeSB8IHVuZGVmaW5lZDtcclxuICAgICAgICBpZiAocmVzdWx0ICYmIERhdGUubm93KCkgLSByZXN1bHQudGltZXN0YW1wIDwgQ0FDSEVfTUFYX0FHRV9NUykge1xyXG4gICAgICAgICAgcmVzb2x2ZShyZXN1bHQpO1xyXG4gICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICByZXNvbHZlKG51bGwpOyAvLyBDYWNoZSBtaXNzIG9yIGV4cGlyZWRcclxuICAgICAgICB9XHJcbiAgICAgIH07XHJcblxyXG4gICAgICByZXF1ZXN0Lm9uZXJyb3IgPSAoKSA9PiByZWplY3QocmVxdWVzdC5lcnJvcik7XHJcbiAgICAgIHRyYW5zYWN0aW9uLm9uY29tcGxldGUgPSAoKSA9PiBkYi5jbG9zZSgpO1xyXG4gICAgfSk7XHJcbiAgfSBjYXRjaCAoZSkge1xyXG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIENhY2hlIHJlYWQgZXJyb3I6XCIsIGUpO1xyXG4gICAgcmV0dXJuIG51bGw7XHJcbiAgfVxyXG59XHJcblxyXG4vLyBTdG9yZSBzY2VuZXMgaW4gSW5kZXhlZERCXHJcbmFzeW5jIGZ1bmN0aW9uIHNldENhY2hlZFNjZW5lcyhcclxuICBjYWNoZUtleTogc3RyaW5nLFxyXG4gIHNjZW5lczogU2NlbmVbXSxcclxuICBjb3VudDogbnVtYmVyLFxyXG4gIGZpbHRlcktleT86IHN0cmluZyxcclxuICB0aW1lc3RhbXA6IG51bWJlciA9IERhdGUubm93KCksXHJcbik6IFByb21pc2U8dm9pZD4ge1xyXG4gIHRyeSB7XHJcbiAgICBjb25zdCBkYiA9IGF3YWl0IG9wZW5DYWNoZURCKCk7XHJcbiAgICByZXR1cm4gbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xyXG4gICAgICBjb25zdCB0cmFuc2FjdGlvbiA9IGRiLnRyYW5zYWN0aW9uKENBQ0hFX1NUT1JFX05BTUUsIFwicmVhZHdyaXRlXCIpO1xyXG4gICAgICBjb25zdCBzdG9yZSA9IHRyYW5zYWN0aW9uLm9iamVjdFN0b3JlKENBQ0hFX1NUT1JFX05BTUUpO1xyXG5cclxuICAgICAgY29uc3QgZGF0YTogQ2FjaGVFbnRyeSA9IHtcclxuICAgICAgICBjYWNoZUtleSxcclxuICAgICAgICBzY2VuZXMsXHJcbiAgICAgICAgY291bnQsXHJcbiAgICAgICAgdGltZXN0YW1wLFxyXG4gICAgICAgIC4uLihmaWx0ZXJLZXkgIT09IHVuZGVmaW5lZCAmJiB7IGZpbHRlcktleSB9KSxcclxuICAgICAgfTtcclxuXHJcbiAgICAgIGNvbnN0IHJlcXVlc3QgPSBzdG9yZS5wdXQoZGF0YSk7XHJcbiAgICAgIHJlcXVlc3Qub25zdWNjZXNzID0gKCkgPT4gcmVzb2x2ZSgpO1xyXG4gICAgICByZXF1ZXN0Lm9uZXJyb3IgPSAoKSA9PiByZWplY3QocmVxdWVzdC5lcnJvcik7XHJcbiAgICAgIHRyYW5zYWN0aW9uLm9uY29tcGxldGUgPSAoKSA9PiBkYi5jbG9zZSgpO1xyXG4gICAgfSk7XHJcbiAgfSBjYXRjaCAoZSkge1xyXG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIENhY2hlIHdyaXRlIGVycm9yOlwiLCBlKTtcclxuICB9XHJcbn1cclxuXHJcbi8vIENsZWFyIGFsbCBjYWNoZWQgc2NlbmVzIChmb3IgbWFudWFsIHJlZnJlc2gpXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjbGVhclNjZW5lQ2FjaGUoKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgdHJ5IHtcclxuICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+Xke+4jyBDbGVhcmluZyBhbGwgc2NlbmUgY2FjaGVzLi4uXCIpO1xyXG4gICAgY29uc3QgZGIgPSBhd2FpdCBvcGVuQ2FjaGVEQigpO1xyXG4gICAgcmV0dXJuIG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcclxuICAgICAgY29uc3QgdHJhbnNhY3Rpb24gPSBkYi50cmFuc2FjdGlvbihDQUNIRV9TVE9SRV9OQU1FLCBcInJlYWR3cml0ZVwiKTtcclxuICAgICAgY29uc3Qgc3RvcmUgPSB0cmFuc2FjdGlvbi5vYmplY3RTdG9yZShDQUNIRV9TVE9SRV9OQU1FKTtcclxuICAgICAgY29uc3QgcmVxdWVzdCA9IHN0b3JlLmNsZWFyKCk7XHJcblxyXG4gICAgICByZXF1ZXN0Lm9uc3VjY2VzcyA9ICgpID0+IHtcclxuICAgICAgICBzdGF0ZS5tZW1vcnlDYWNoZSA9IHsgYWxsU2NlbmVzOiBudWxsLCBmaWx0ZXJlZFNjZW5lczogbnVsbCwgZmlsdGVyS2V5OiBudWxsLCB0aW1lc3RhbXA6IG51bGwgfTtcclxuICAgICAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIOKchSBBbGwgY2FjaGVzIGNsZWFyZWQgKG1lbW9yeSArIEluZGV4ZWREQilcIik7XHJcbiAgICAgICAgcmVzb2x2ZSgpO1xyXG4gICAgICB9O1xyXG4gICAgICByZXF1ZXN0Lm9uZXJyb3IgPSAoKSA9PiByZWplY3QocmVxdWVzdC5lcnJvcik7XHJcbiAgICAgIHRyYW5zYWN0aW9uLm9uY29tcGxldGUgPSAoKSA9PiBkYi5jbG9zZSgpO1xyXG4gICAgfSk7XHJcbiAgfSBjYXRjaCAoZSkge1xyXG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIOKdjCBDYWNoZSBjbGVhciBlcnJvcjpcIiwgZSk7XHJcbiAgfVxyXG59XHJcblxyXG4vLyBDbGVhciBqdXN0IHRoZSBmaWx0ZXJlZCBzY2VuZXMgY2FjaGUgKGZvciBhdXRvLXJlZnJlc2ggYWZ0ZXIgcG9vbCBleGhhdXN0aW9uKVxyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY2xlYXJGaWx0ZXJlZENhY2hlKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gIHRyeSB7XHJcbiAgICBjb25zdCBkYiA9IGF3YWl0IG9wZW5DYWNoZURCKCk7XHJcbiAgICByZXR1cm4gbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xyXG4gICAgICBjb25zdCB0cmFuc2FjdGlvbiA9IGRiLnRyYW5zYWN0aW9uKENBQ0hFX1NUT1JFX05BTUUsIFwicmVhZHdyaXRlXCIpO1xyXG4gICAgICBjb25zdCBzdG9yZSA9IHRyYW5zYWN0aW9uLm9iamVjdFN0b3JlKENBQ0hFX1NUT1JFX05BTUUpO1xyXG4gICAgICBjb25zdCByZXF1ZXN0ID0gc3RvcmUuZGVsZXRlKFwiZmlsdGVyZWQtc2NlbmVzXCIpO1xyXG5cclxuICAgICAgcmVxdWVzdC5vbnN1Y2Nlc3MgPSAoKSA9PiB7XHJcbiAgICAgICAgc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXMgPSBudWxsO1xyXG4gICAgICAgIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcktleSA9IG51bGw7XHJcbiAgICAgICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5eR77iPIEZpbHRlcmVkIGNhY2hlIGNsZWFyZWQgKG1lbW9yeSArIEluZGV4ZWREQilcIik7XHJcbiAgICAgICAgcmVzb2x2ZSgpO1xyXG4gICAgICB9O1xyXG4gICAgICByZXF1ZXN0Lm9uZXJyb3IgPSAoKSA9PiByZWplY3QocmVxdWVzdC5lcnJvcik7XHJcbiAgICAgIHRyYW5zYWN0aW9uLm9uY29tcGxldGUgPSAoKSA9PiBkYi5jbG9zZSgpO1xyXG4gICAgfSk7XHJcbiAgfSBjYXRjaCAoZSkge1xyXG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIOKdjCBGaWx0ZXJlZCBjYWNoZSBjbGVhciBlcnJvcjpcIiwgZSk7XHJcbiAgICAvLyBTdGlsbCBjbGVhciBtZW1vcnkgY2FjaGUgZXZlbiBpZiBJbmRleGVkREIgZmFpbHNcclxuICAgIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzID0gbnVsbDtcclxuICAgIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcktleSA9IG51bGw7XHJcbiAgfVxyXG59XHJcblxyXG4vLyBCYWNrZ3JvdW5kIHJlZnJlc2ggLSBmZXRjaCBmcm9tIG5ldHdvcmsgYW5kIHVwZGF0ZSBjYWNoZXMgc2lsZW50bHlcclxuYXN5bmMgZnVuY3Rpb24gYmFja2dyb3VuZFJlZnJlc2hBbGxTY2VuZXMoKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgY29uc3QgY2FjaGVLZXkgPSBcImFsbC1zY2VuZXNcIjtcclxuXHJcbiAgdHJ5IHtcclxuICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+UhCBCYWNrZ3JvdW5kIHJlZnJlc2ggc3RhcnRlZCAoYWxsIHNjZW5lcykuLi5cIik7XHJcbiAgICBjb25zdCBzdGFydFRpbWUgPSBEYXRlLm5vdygpO1xyXG5cclxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGdyYXBocWxRdWVyeTxGaW5kU2NlbmVzUmVzdWx0PihGSU5EX1NDRU5FU19RVUVSWSwge1xyXG4gICAgICBmaWx0ZXI6IHtcclxuICAgICAgICBwZXJfcGFnZTogLTEsXHJcbiAgICAgICAgc29ydDogXCJyYXRpbmdcIixcclxuICAgICAgICBkaXJlY3Rpb246IFwiREVTQ1wiLFxyXG4gICAgICB9LFxyXG4gICAgICBzY2VuZV9maWx0ZXI6IG51bGwsXHJcbiAgICB9KTtcclxuXHJcbiAgICBjb25zdCBzY2VuZXMgPSByZXN1bHQuZmluZFNjZW5lcy5zY2VuZXMgfHwgW107XHJcbiAgICBjb25zdCBjb3VudCA9IHJlc3VsdC5maW5kU2NlbmVzLmNvdW50IHx8IHNjZW5lcy5sZW5ndGg7XHJcbiAgICBjb25zdCBmZXRjaFRpbWUgPSBEYXRlLm5vdygpIC0gc3RhcnRUaW1lO1xyXG5cclxuICAgIGNvbnN0IG9sZENvdW50ID0gc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzID8gc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzLmxlbmd0aCA6IDA7XHJcbiAgICBpZiAoY291bnQgIT09IG9sZENvdW50KSB7XHJcbiAgICAgIGNvbnNvbGUubG9nKFxyXG4gICAgICAgIGBbU3Rhc2ggQmF0dGxlXSDwn5OKIFNjZW5lIGNvdW50IGNoYW5nZWQ6ICR7b2xkQ291bnR9IOKGkiAke2NvdW50fSAoJHtjb3VudCA+IG9sZENvdW50ID8gXCIrXCIgOiBcIlwifSR7Y291bnQgLSBvbGRDb3VudH0pYCxcclxuICAgICAgKTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgIGNvbnNvbGUubG9nKGBbU3Rhc2ggQmF0dGxlXSDwn5OKIFNjZW5lIGNvdW50IHVuY2hhbmdlZDogJHtjb3VudH1gKTtcclxuICAgIH1cclxuXHJcbiAgICBzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXMgPSBzY2VuZXM7XHJcbiAgICBzdGF0ZS5tZW1vcnlDYWNoZS50aW1lc3RhbXAgPSBEYXRlLm5vdygpO1xyXG4gICAgYXdhaXQgc2V0Q2FjaGVkU2NlbmVzKGNhY2hlS2V5LCBzY2VuZXMsIGNvdW50KTtcclxuXHJcbiAgICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g4pyFIEJhY2tncm91bmQgcmVmcmVzaCBjb21wbGV0ZTogJHtzY2VuZXMubGVuZ3RofSBzY2VuZXMgaW4gJHtmZXRjaFRpbWV9bXNgKTtcclxuICB9IGNhdGNoIChlKSB7XHJcbiAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0g4p2MIEJhY2tncm91bmQgcmVmcmVzaCBmYWlsZWQ6XCIsIGUpO1xyXG4gIH1cclxufVxyXG5cclxuLy8gR2V0IGFsbCBzY2VuZXMgKHVzZXMgY2FjaGUgd2l0aCBzdGFsZS13aGlsZS1yZXZhbGlkYXRlKVxyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ2V0QWxsU2NlbmVzQ2FjaGVkKCk6IFByb21pc2U8eyBzY2VuZXM6IFNjZW5lW107IGNvdW50OiBudW1iZXIgfT4ge1xyXG4gIGNvbnN0IGNhY2hlS2V5ID0gXCJhbGwtc2NlbmVzXCI7XHJcblxyXG4gIC8vIENoZWNrIG1lbW9yeSBjYWNoZSBmaXJzdCAtIHJldHVybiBpbW1lZGlhdGVseSBpZiBhdmFpbGFibGVcclxuICBpZiAoc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzKSB7XHJcbiAgICBjb25zdCBjYWNoZUFnZSA9IE1hdGgucm91bmQoKERhdGUubm93KCkgLSAoc3RhdGUubWVtb3J5Q2FjaGUudGltZXN0YW1wID8/IDApKSAvIDEwMDApO1xyXG4gICAgY29uc3QgaXNTdGFsZSA9IERhdGUubm93KCkgLSAoc3RhdGUubWVtb3J5Q2FjaGUudGltZXN0YW1wID8/IDApID49IENBQ0hFX01BWF9BR0VfTVM7XHJcblxyXG4gICAgY29uc29sZS5sb2coXHJcbiAgICAgIGBbU3Rhc2ggQmF0dGxlXSDwn5K+IE1lbW9yeSBjYWNoZSBoaXQgKGFsbCBzY2VuZXMpOiAke3N0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcy5sZW5ndGh9IHNjZW5lcywgYWdlOiAke2NhY2hlQWdlfXMke2lzU3RhbGUgPyBcIiBbU1RBTEVdXCIgOiBcIlwifWAsXHJcbiAgICApO1xyXG5cclxuICAgIGlmIChpc1N0YWxlKSB7XHJcbiAgICAgIGNvbnNvbGUubG9nKGBbU3Rhc2ggQmF0dGxlXSDij7AgQ2FjaGUgc3RhbGUgKD4ke0NBQ0hFX01BWF9BR0VfTVMgLyAxMDAwfXMpLCB0cmlnZ2VyaW5nIGJhY2tncm91bmQgcmVmcmVzaC4uLmApO1xyXG4gICAgICBiYWNrZ3JvdW5kUmVmcmVzaEFsbFNjZW5lcygpOyAvLyBEb24ndCBhd2FpdCAtIHJ1bnMgaW4gYmFja2dyb3VuZFxyXG4gICAgfVxyXG4gICAgcmV0dXJuIHsgc2NlbmVzOiBzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXMsIGNvdW50OiBzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXMubGVuZ3RoIH07XHJcbiAgfVxyXG5cclxuICAvLyBDaGVjayBJbmRleGVkREIgY2FjaGUgLSByZXR1cm4gaW1tZWRpYXRlbHkgaWYgYXZhaWxhYmxlXHJcbiAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5SNIE1lbW9yeSBjYWNoZSBtaXNzLCBjaGVja2luZyBJbmRleGVkREIuLi5cIik7XHJcbiAgY29uc3QgY2FjaGVkID0gYXdhaXQgZ2V0Q2FjaGVkU2NlbmVzKGNhY2hlS2V5KTtcclxuICBpZiAoY2FjaGVkKSB7XHJcbiAgICBjb25zdCBjYWNoZUFnZSA9IE1hdGgucm91bmQoKERhdGUubm93KCkgLSBjYWNoZWQudGltZXN0YW1wKSAvIDEwMDApO1xyXG4gICAgY29uc3QgaXNTdGFsZSA9IERhdGUubm93KCkgLSBjYWNoZWQudGltZXN0YW1wID49IENBQ0hFX01BWF9BR0VfTVM7XHJcblxyXG4gICAgY29uc29sZS5sb2coXHJcbiAgICAgIGBbU3Rhc2ggQmF0dGxlXSDwn5K/IEluZGV4ZWREQiBjYWNoZSBoaXQgKGFsbCBzY2VuZXMpOiAke2NhY2hlZC5zY2VuZXMubGVuZ3RofSBzY2VuZXMsIGFnZTogJHtjYWNoZUFnZX1zJHtpc1N0YWxlID8gXCIgW1NUQUxFXVwiIDogXCJcIn1gLFxyXG4gICAgKTtcclxuXHJcbiAgICBzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXMgPSBjYWNoZWQuc2NlbmVzO1xyXG4gICAgc3RhdGUubWVtb3J5Q2FjaGUudGltZXN0YW1wID0gY2FjaGVkLnRpbWVzdGFtcDtcclxuXHJcbiAgICBpZiAoaXNTdGFsZSkge1xyXG4gICAgICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g4o+wIENhY2hlIHN0YWxlICg+JHtDQUNIRV9NQVhfQUdFX01TIC8gMTAwMH1zKSwgdHJpZ2dlcmluZyBiYWNrZ3JvdW5kIHJlZnJlc2guLi5gKTtcclxuICAgICAgYmFja2dyb3VuZFJlZnJlc2hBbGxTY2VuZXMoKTsgLy8gRG9uJ3QgYXdhaXQgLSBydW5zIGluIGJhY2tncm91bmRcclxuICAgIH1cclxuICAgIHJldHVybiB7IHNjZW5lczogY2FjaGVkLnNjZW5lcywgY291bnQ6IGNhY2hlZC5jb3VudCB9O1xyXG4gIH1cclxuXHJcbiAgLy8gTm8gY2FjaGUgYXQgYWxsIC0gbXVzdCBmZXRjaCBmcm9tIG5ldHdvcmsgKGJsb2NraW5nKVxyXG4gIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+MkCBObyBjYWNoZSBmb3VuZCwgZmV0Y2hpbmcgYWxsIHNjZW5lcyBmcm9tIG5ldHdvcmsgKGZpcnN0IGxvYWQpLi4uXCIpO1xyXG4gIGNvbnN0IHN0YXJ0VGltZSA9IERhdGUubm93KCk7XHJcblxyXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGdyYXBocWxRdWVyeTxGaW5kU2NlbmVzUmVzdWx0PihGSU5EX1NDRU5FU19RVUVSWSwge1xyXG4gICAgZmlsdGVyOiB7XHJcbiAgICAgIHBlcl9wYWdlOiAtMSxcclxuICAgICAgc29ydDogXCJyYXRpbmdcIixcclxuICAgICAgZGlyZWN0aW9uOiBcIkRFU0NcIixcclxuICAgIH0sXHJcbiAgICBzY2VuZV9maWx0ZXI6IG51bGwsXHJcbiAgfSk7XHJcblxyXG4gIGNvbnN0IHNjZW5lcyA9IHJlc3VsdC5maW5kU2NlbmVzLnNjZW5lcyB8fCBbXTtcclxuICBjb25zdCBjb3VudCA9IHJlc3VsdC5maW5kU2NlbmVzLmNvdW50IHx8IHNjZW5lcy5sZW5ndGg7XHJcbiAgY29uc3QgZmV0Y2hUaW1lID0gRGF0ZS5ub3coKSAtIHN0YXJ0VGltZTtcclxuXHJcbiAgc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzID0gc2NlbmVzO1xyXG4gIHN0YXRlLm1lbW9yeUNhY2hlLnRpbWVzdGFtcCA9IERhdGUubm93KCk7XHJcbiAgYXdhaXQgc2V0Q2FjaGVkU2NlbmVzKGNhY2hlS2V5LCBzY2VuZXMsIGNvdW50KTtcclxuXHJcbiAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIOKchSBGZXRjaGVkIGFuZCBjYWNoZWQgJHtzY2VuZXMubGVuZ3RofSBzY2VuZXMgaW4gJHtmZXRjaFRpbWV9bXNgKTtcclxuICByZXR1cm4geyBzY2VuZXMsIGNvdW50IH07XHJcbn1cclxuXHJcbi8vIEJhY2tncm91bmQgcmVmcmVzaCBmb3IgZmlsdGVyZWQgc2NlbmVzXHJcbmFzeW5jIGZ1bmN0aW9uIGJhY2tncm91bmRSZWZyZXNoRmlsdGVyZWRTY2VuZXMoZmlsdGVyczogTGlzdEZpbHRlcnMpOiBQcm9taXNlPHZvaWQ+IHtcclxuICBjb25zdCBjYWNoZUtleSA9IFwiZmlsdGVyZWQtc2NlbmVzXCI7XHJcblxyXG4gIHRyeSB7XHJcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCflIQgQmFja2dyb3VuZCByZWZyZXNoIHN0YXJ0ZWQgKGZpbHRlcmVkIHNjZW5lcykuLi5cIik7XHJcbiAgICBjb25zdCBzdGFydFRpbWUgPSBEYXRlLm5vdygpO1xyXG5cclxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGdyYXBocWxRdWVyeTxGaW5kU2NlbmVzUmVzdWx0PihGSU5EX1NDRU5FU19RVUVSWSwge1xyXG4gICAgICBmaWx0ZXI6IGdldEZpbmRGaWx0ZXIoe1xyXG4gICAgICAgIHBlcl9wYWdlOiAtMSxcclxuICAgICAgICBzb3J0OiBcInJhdGluZ1wiLFxyXG4gICAgICAgIGRpcmVjdGlvbjogXCJERVNDXCIsXHJcbiAgICAgIH0pLFxyXG4gICAgICBzY2VuZV9maWx0ZXI6IGZpbHRlcnMuc2NlbmVGaWx0ZXIsXHJcbiAgICB9KTtcclxuXHJcbiAgICBjb25zdCBzY2VuZXMgPSByZXN1bHQuZmluZFNjZW5lcy5zY2VuZXMgfHwgW107XHJcbiAgICBjb25zdCBjb3VudCA9IHJlc3VsdC5maW5kU2NlbmVzLmNvdW50IHx8IHNjZW5lcy5sZW5ndGg7XHJcbiAgICBjb25zdCBmZXRjaFRpbWUgPSBEYXRlLm5vdygpIC0gc3RhcnRUaW1lO1xyXG5cclxuICAgIC8vIE9ubHkgdXBkYXRlIGlmIHN0aWxsIG9uIHNhbWUgZmlsdGVyXHJcbiAgICBpZiAoc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyS2V5ID09PSBmaWx0ZXJzLmZpbHRlcktleSkge1xyXG4gICAgICBjb25zdCBvbGRDb3VudCA9IHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzID8gc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXMubGVuZ3RoIDogMDtcclxuICAgICAgaWYgKGNvdW50ICE9PSBvbGRDb3VudCkge1xyXG4gICAgICAgIGNvbnNvbGUubG9nKFxyXG4gICAgICAgICAgYFtTdGFzaCBCYXR0bGVdIPCfk4ogRmlsdGVyZWQgY291bnQgY2hhbmdlZDogJHtvbGRDb3VudH0g4oaSICR7Y291bnR9ICgke2NvdW50ID4gb2xkQ291bnQgPyBcIitcIiA6IFwiXCJ9JHtjb3VudCAtIG9sZENvdW50fSlgLFxyXG4gICAgICAgICk7XHJcbiAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIPCfk4ogRmlsdGVyZWQgY291bnQgdW5jaGFuZ2VkOiAke2NvdW50fWApO1xyXG4gICAgICB9XHJcblxyXG4gICAgICBzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJlZFNjZW5lcyA9IHNjZW5lcztcclxuICAgICAgc3RhdGUubWVtb3J5Q2FjaGUudGltZXN0YW1wID0gRGF0ZS5ub3coKTtcclxuICAgICAgYXdhaXQgc2V0Q2FjaGVkU2NlbmVzKGNhY2hlS2V5LCBzY2VuZXMsIGNvdW50LCBmaWx0ZXJzLmZpbHRlcktleSk7XHJcblxyXG4gICAgICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g4pyFIEJhY2tncm91bmQgcmVmcmVzaCBjb21wbGV0ZTogJHtzY2VuZXMubGVuZ3RofSBmaWx0ZXJlZCBzY2VuZXMgaW4gJHtmZXRjaFRpbWV9bXNgKTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g4pqg77iPIEZpbHRlciBjaGFuZ2VkIGR1cmluZyByZWZyZXNoLCBkaXNjYXJkaW5nIHJlc3VsdHNcIik7XHJcbiAgICB9XHJcbiAgfSBjYXRjaCAoZSkge1xyXG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIOKdjCBCYWNrZ3JvdW5kIHJlZnJlc2ggKGZpbHRlcmVkKSBmYWlsZWQ6XCIsIGUpO1xyXG4gIH1cclxufVxyXG5cclxuLy8gR2V0IGZpbHRlcmVkIHNjZW5lcyAodXNlcyBjYWNoZSB3aXRoIHN0YWxlLXdoaWxlLXJldmFsaWRhdGUpXHJcbi8vIE5PVEU6IE9ubHkgT05FIGZpbHRlcmVkIGNhY2hlIGlzIGtlcHQgKG92ZXJ3cml0ZXMgcHJldmlvdXMgZmlsdGVyIGNhY2hlIHRvIHByZXZlbnQgSW5kZXhlZERCIGJsb2F0KVxyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ2V0RmlsdGVyZWRTY2VuZXNDYWNoZWQoXHJcbiAgZmlsdGVyczogTGlzdEZpbHRlcnMsXHJcbik6IFByb21pc2U8eyBzY2VuZXM6IFNjZW5lW107IGNvdW50OiBudW1iZXIgfT4ge1xyXG4gIGNvbnN0IHsgZmlsdGVyS2V5LCBzY2VuZUZpbHRlciB9ID0gZmlsdGVycztcclxuICBjb25zdCBjYWNoZUtleSA9IFwiZmlsdGVyZWQtc2NlbmVzXCI7IC8vIFNpbmdsZSBrZXkgLSBvdmVyd3JpdGVzIHByZXZpb3VzIGZpbHRlciBjYWNoZVxyXG5cclxuICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCflI4gRmlsdGVyIGFjdGl2ZSwgY2hlY2tpbmcgZmlsdGVyZWQgY2FjaGUuLi5cIik7XHJcblxyXG4gIC8vIENoZWNrIG1lbW9yeSBjYWNoZSBmaXJzdCAtIHJldHVybiBpbW1lZGlhdGVseSBpZiBhdmFpbGFibGUgYW5kIHNhbWUgZmlsdGVyXHJcbiAgaWYgKHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzICYmIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcktleSA9PT0gZmlsdGVyS2V5KSB7XHJcbiAgICBjb25zdCBjYWNoZUFnZSA9IE1hdGgucm91bmQoKERhdGUubm93KCkgLSAoc3RhdGUubWVtb3J5Q2FjaGUudGltZXN0YW1wID8/IDApKSAvIDEwMDApO1xyXG4gICAgY29uc3QgaXNTdGFsZSA9IERhdGUubm93KCkgLSAoc3RhdGUubWVtb3J5Q2FjaGUudGltZXN0YW1wID8/IDApID49IENBQ0hFX01BWF9BR0VfTVM7XHJcblxyXG4gICAgY29uc29sZS5sb2coXHJcbiAgICAgIGBbU3Rhc2ggQmF0dGxlXSDwn5K+IE1lbW9yeSBjYWNoZSBoaXQgKGZpbHRlcmVkKTogJHtzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJlZFNjZW5lcy5sZW5ndGh9IHNjZW5lcywgYWdlOiAke2NhY2hlQWdlfXMke2lzU3RhbGUgPyBcIiBbU1RBTEVdXCIgOiBcIlwifWAsXHJcbiAgICApO1xyXG5cclxuICAgIGlmIChpc1N0YWxlKSB7XHJcbiAgICAgIGNvbnNvbGUubG9nKGBbU3Rhc2ggQmF0dGxlXSDij7AgQ2FjaGUgc3RhbGUgKD4ke0NBQ0hFX01BWF9BR0VfTVMgLyAxMDAwfXMpLCB0cmlnZ2VyaW5nIGJhY2tncm91bmQgcmVmcmVzaC4uLmApO1xyXG4gICAgICBiYWNrZ3JvdW5kUmVmcmVzaEZpbHRlcmVkU2NlbmVzKGZpbHRlcnMpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHsgc2NlbmVzOiBzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJlZFNjZW5lcywgY291bnQ6IHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzLmxlbmd0aCB9O1xyXG4gIH1cclxuXHJcbiAgLy8gQ2hlY2sgSW5kZXhlZERCIGNhY2hlIChvbmx5IGlmIGZpbHRlciBrZXkgbWF0Y2hlcylcclxuICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCflI0gTWVtb3J5IGNhY2hlIG1pc3MgKGZpbHRlcmVkKSwgY2hlY2tpbmcgSW5kZXhlZERCLi4uXCIpO1xyXG4gIGNvbnN0IGNhY2hlZCA9IGF3YWl0IGdldENhY2hlZFNjZW5lcyhjYWNoZUtleSk7XHJcbiAgaWYgKGNhY2hlZCAmJiBjYWNoZWQuZmlsdGVyS2V5ID09PSBmaWx0ZXJLZXkpIHtcclxuICAgIGNvbnN0IGNhY2hlQWdlID0gTWF0aC5yb3VuZCgoRGF0ZS5ub3coKSAtIGNhY2hlZC50aW1lc3RhbXApIC8gMTAwMCk7XHJcbiAgICBjb25zdCBpc1N0YWxlID0gRGF0ZS5ub3coKSAtIGNhY2hlZC50aW1lc3RhbXAgPj0gQ0FDSEVfTUFYX0FHRV9NUztcclxuXHJcbiAgICBjb25zb2xlLmxvZyhcclxuICAgICAgYFtTdGFzaCBCYXR0bGVdIPCfkr8gSW5kZXhlZERCIGNhY2hlIGhpdCAoZmlsdGVyZWQpOiAke2NhY2hlZC5zY2VuZXMubGVuZ3RofSBzY2VuZXMsIGFnZTogJHtjYWNoZUFnZX1zJHtpc1N0YWxlID8gXCIgW1NUQUxFXVwiIDogXCJcIn1gLFxyXG4gICAgKTtcclxuXHJcbiAgICBzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJlZFNjZW5lcyA9IGNhY2hlZC5zY2VuZXM7XHJcbiAgICBzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJLZXkgPSBmaWx0ZXJLZXk7XHJcbiAgICBzdGF0ZS5tZW1vcnlDYWNoZS50aW1lc3RhbXAgPSBjYWNoZWQudGltZXN0YW1wO1xyXG5cclxuICAgIGlmIChpc1N0YWxlKSB7XHJcbiAgICAgIGNvbnNvbGUubG9nKGBbU3Rhc2ggQmF0dGxlXSDij7AgQ2FjaGUgc3RhbGUgKD4ke0NBQ0hFX01BWF9BR0VfTVMgLyAxMDAwfXMpLCB0cmlnZ2VyaW5nIGJhY2tncm91bmQgcmVmcmVzaC4uLmApO1xyXG4gICAgICBiYWNrZ3JvdW5kUmVmcmVzaEZpbHRlcmVkU2NlbmVzKGZpbHRlcnMpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHsgc2NlbmVzOiBjYWNoZWQuc2NlbmVzLCBjb3VudDogY2FjaGVkLmNvdW50IH07XHJcbiAgfVxyXG5cclxuICBpZiAoY2FjaGVkKSB7XHJcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCfkr8gSW5kZXhlZERCIGNhY2hlIGV4aXN0cyBidXQgZmlsdGVyIGNoYW5nZWQsIGZldGNoaW5nIG5ldyBkYXRhLi4uXCIpO1xyXG4gIH0gZWxzZSB7XHJcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCfkr8gSW5kZXhlZERCIGNhY2hlIG1pc3MgKGZpbHRlcmVkKVwiKTtcclxuICB9XHJcblxyXG4gIC8vIE5vIG1hdGNoaW5nIGNhY2hlIC0gbXVzdCBmZXRjaCBmcm9tIG5ldHdvcmsgKGJsb2NraW5nKVxyXG4gIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+MkCBGZXRjaGluZyBmaWx0ZXJlZCBzY2VuZXMgZnJvbSBuZXR3b3JrLi4uXCIpO1xyXG4gIGNvbnN0IHN0YXJ0VGltZSA9IERhdGUubm93KCk7XHJcblxyXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGdyYXBocWxRdWVyeTxGaW5kU2NlbmVzUmVzdWx0PihGSU5EX1NDRU5FU19RVUVSWSwge1xyXG4gICAgZmlsdGVyOiBnZXRGaW5kRmlsdGVyKHtcclxuICAgICAgcGVyX3BhZ2U6IC0xLFxyXG4gICAgICBzb3J0OiBcInJhdGluZ1wiLFxyXG4gICAgICBkaXJlY3Rpb246IFwiREVTQ1wiLFxyXG4gICAgfSksXHJcbiAgICBzY2VuZV9maWx0ZXI6IHNjZW5lRmlsdGVyLFxyXG4gIH0pO1xyXG5cclxuICBjb25zdCBzY2VuZXMgPSByZXN1bHQuZmluZFNjZW5lcy5zY2VuZXMgfHwgW107XHJcbiAgY29uc3QgY291bnQgPSByZXN1bHQuZmluZFNjZW5lcy5jb3VudCB8fCBzY2VuZXMubGVuZ3RoO1xyXG4gIGNvbnN0IGZldGNoVGltZSA9IERhdGUubm93KCkgLSBzdGFydFRpbWU7XHJcblxyXG4gIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzID0gc2NlbmVzO1xyXG4gIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcktleSA9IGZpbHRlcktleTtcclxuICBzdGF0ZS5tZW1vcnlDYWNoZS50aW1lc3RhbXAgPSBEYXRlLm5vdygpO1xyXG4gIGF3YWl0IHNldENhY2hlZFNjZW5lcyhjYWNoZUtleSwgc2NlbmVzLCBjb3VudCwgZmlsdGVyS2V5KTtcclxuXHJcbiAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIOKchSBGZXRjaGVkIGFuZCBjYWNoZWQgJHtzY2VuZXMubGVuZ3RofSBmaWx0ZXJlZCBzY2VuZXMgaW4gJHtmZXRjaFRpbWV9bXNgKTtcclxuICByZXR1cm4geyBzY2VuZXMsIGNvdW50IH07XHJcbn1cclxuXHJcbi8vIFVwZGF0ZSBhIHNjZW5lJ3MgcmF0aW5nIGFuZCByZXBvc2l0aW9uIGl0IGluIHRoZSBzb3J0ZWQgYXJyYXkgdG8ga2VlcCByYW5rcyBhY2N1cmF0ZVxyXG5mdW5jdGlvbiByZXBvc2l0aW9uU2NlbmVJbkFycmF5KGFycjogU2NlbmVbXSwgc2NlbmVJZDogc3RyaW5nLCBuZXdSYXRpbmc6IG51bWJlcik6IGJvb2xlYW4ge1xyXG4gIGNvbnN0IGlkeCA9IGFyci5maW5kSW5kZXgoKHMpID0+IHMuaWQgPT09IHNjZW5lSWQpO1xyXG4gIGlmIChpZHggPT09IC0xKSByZXR1cm4gZmFsc2U7XHJcblxyXG4gIGNvbnN0IHNjZW5lID0gYXJyW2lkeF07XHJcbiAgc2NlbmUucmF0aW5nMTAwID0gbmV3UmF0aW5nO1xyXG5cclxuICAvLyBSZW1vdmUgZnJvbSBjdXJyZW50IHBvc2l0aW9uXHJcbiAgYXJyLnNwbGljZShpZHgsIDEpO1xyXG5cclxuICAvLyBGaW5kIGNvcnJlY3QgcG9zaXRpb24gKGFycmF5IGlzIHNvcnRlZCBieSByYXRpbmcgREVTQylcclxuICBjb25zdCBuZXdJZHggPSBhcnIuZmluZEluZGV4KChzKSA9PiAocy5yYXRpbmcxMDAgfHwgMCkgPCBuZXdSYXRpbmcpO1xyXG5cclxuICBpZiAobmV3SWR4ID09PSAtMSkge1xyXG4gICAgYXJyLnB1c2goc2NlbmUpOyAvLyBMb3dlc3QgcmF0ZWQsIGdvZXMgYXQgZW5kXHJcbiAgfSBlbHNlIHtcclxuICAgIGFyci5zcGxpY2UobmV3SWR4LCAwLCBzY2VuZSk7XHJcbiAgfVxyXG5cclxuICByZXR1cm4gdHJ1ZTtcclxufVxyXG5cclxuLy8gQ2xlYXIgYSBzY2VuZSdzIHJhdGluZyBpbiB0aGUgbWVtb3J5IGNhY2hlIGFuZCBtb3ZlIGl0IHRvIHRoZSBib3R0b20gb2YgdGhlIHNvcnRlZCBwb29sXHJcbmV4cG9ydCBmdW5jdGlvbiBjbGVhclNjZW5lSW5DYWNoZShzY2VuZUlkOiBzdHJpbmcpOiB2b2lkIHtcclxuICBpZiAoc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzKSB7XHJcbiAgICBjb25zdCBpZHggPSBzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXMuZmluZEluZGV4KChzKSA9PiBzLmlkID09PSBzY2VuZUlkKTtcclxuICAgIGlmIChpZHggIT09IC0xKSB7XHJcbiAgICAgIGNvbnN0IHNjZW5lID0gc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzW2lkeF07XHJcbiAgICAgIHNjZW5lLnJhdGluZzEwMCA9IG51bGw7XHJcbiAgICAgIHN0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcy5zcGxpY2UoaWR4LCAxKTtcclxuICAgICAgc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzLnB1c2goc2NlbmUpO1xyXG4gICAgICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g8J+TnSBDbGVhcmVkIHNjZW5lICR7c2NlbmVJZH0gcmF0aW5nIGluIG1lbW9yeSBjYWNoZWApO1xyXG4gICAgfVxyXG4gIH1cclxuXHJcbiAgaWYgKHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzKSB7XHJcbiAgICBjb25zdCBzY2VuZSA9IHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzLmZpbmQoKHMpID0+IHMuaWQgPT09IHNjZW5lSWQpO1xyXG4gICAgaWYgKHNjZW5lKSB7XHJcbiAgICAgIHNjZW5lLnJhdGluZzEwMCA9IG51bGw7XHJcbiAgICB9XHJcbiAgfVxyXG59XHJcblxyXG4vLyBVcGRhdGUgYSBzY2VuZSdzIHJhdGluZyBpbiB0aGUgbWVtb3J5IGNhY2hlIChrZWVwcyBjYWNoZSBpbiBzeW5jIGFmdGVyIHJhdGluZyBjaGFuZ2VzKVxyXG5leHBvcnQgZnVuY3Rpb24gdXBkYXRlU2NlbmVJbkNhY2hlKHNjZW5lSWQ6IHN0cmluZywgbmV3UmF0aW5nOiBudW1iZXIpOiB2b2lkIHtcclxuICAvLyBSZXBvc2l0aW9uIGluIGFsbFNjZW5lcyAoa2VlcHMgcmFua2luZ3MgYWNjdXJhdGUsIHNjZW5lIHN0YXlzIGZvciBvcHBvbmVudCBwb29sKVxyXG4gIGlmIChzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXMpIHtcclxuICAgIHJlcG9zaXRpb25TY2VuZUluQXJyYXkoc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzLCBzY2VuZUlkLCBuZXdSYXRpbmcpO1xyXG4gICAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIPCfk50gVXBkYXRlZCBzY2VuZSAke3NjZW5lSWR9IHJhdGluZyB0byAke25ld1JhdGluZ30gaW4gbWVtb3J5IGNhY2hlYCk7XHJcbiAgfVxyXG5cclxuICAvLyBBbHNvIHJlcG9zaXRpb24gaW4gZmlsdGVyZWRTY2VuZXMgKGl0IGRvdWJsZXMgYXMgdGhlIG9wcG9uZW50IHBvb2wgd2hlbiBmaWx0ZXJpbmcgYm90aCBzaWRlcylcclxuICBpZiAoc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXMpIHtcclxuICAgIHJlcG9zaXRpb25TY2VuZUluQXJyYXkoc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXMsIHNjZW5lSWQsIG5ld1JhdGluZyk7XHJcbiAgfVxyXG59XHJcblxyXG4vLyBEcm9wIGEgZGVsZXRlZCBzY2VuZSBmcm9tIGV2ZXJ5IGNhY2hlIHRpZXIgYW5kIHRoZSBsZWZ0LXNpZGUgc2h1ZmZsZVxyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVtb3ZlU2NlbmVFdmVyeXdoZXJlKHNjZW5lSWQ6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xyXG4gIGNvbnN0IHdpdGhvdXQgPSAoc2NlbmVzOiBTY2VuZVtdIHwgbnVsbCk6IFNjZW5lW10gfCBudWxsID0+XHJcbiAgICBzY2VuZXMgPyBzY2VuZXMuZmlsdGVyKChzKSA9PiBzLmlkICE9PSBzY2VuZUlkKSA6IHNjZW5lcztcclxuXHJcbiAgc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzID0gd2l0aG91dChzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXMpO1xyXG4gIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzID0gd2l0aG91dChzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJlZFNjZW5lcyk7XHJcblxyXG4gIGNvbnN0IHNodWZmbGVJZHggPSBzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzLmZpbmRJbmRleCgocykgPT4gcy5pZCA9PT0gc2NlbmVJZCk7XHJcbiAgaWYgKHNodWZmbGVJZHggIT09IC0xKSB7XHJcbiAgICBzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzLnNwbGljZShzaHVmZmxlSWR4LCAxKTtcclxuICAgIGlmIChzaHVmZmxlSWR4IDwgc3RhdGUuc2h1ZmZsZUluZGV4KSBzdGF0ZS5zaHVmZmxlSW5kZXgtLTtcclxuICB9XHJcblxyXG4gIGZvciAoY29uc3QgY2FjaGVLZXkgb2YgW1wiYWxsLXNjZW5lc1wiLCBcImZpbHRlcmVkLXNjZW5lc1wiXSkge1xyXG4gICAgY29uc3QgY2FjaGVkID0gYXdhaXQgZ2V0Q2FjaGVkU2NlbmVzKGNhY2hlS2V5KTtcclxuICAgIGlmIChjYWNoZWQgJiYgY2FjaGVkLnNjZW5lcy5zb21lKChzKSA9PiBzLmlkID09PSBzY2VuZUlkKSkge1xyXG4gICAgICBjb25zdCBzY2VuZXMgPSBjYWNoZWQuc2NlbmVzLmZpbHRlcigocykgPT4gcy5pZCAhPT0gc2NlbmVJZCk7XHJcbiAgICAgIC8vIEtlZXAgdGhlIG9yaWdpbmFsIHRpbWVzdGFtcDogcmVtb3Zpbmcgb25lIHNjZW5lIGRvZXNuJ3QgbWFrZSB0aGUgcmVzdCBhbnkgZnJlc2hlclxyXG4gICAgICBhd2FpdCBzZXRDYWNoZWRTY2VuZXMoY2FjaGVLZXksIHNjZW5lcywgc2NlbmVzLmxlbmd0aCwgY2FjaGVkLmZpbHRlcktleSwgY2FjaGVkLnRpbWVzdGFtcCk7XHJcbiAgICB9XHJcbiAgfVxyXG4gIGNvbnNvbGUubG9nKGBbU3Rhc2ggQmF0dGxlXSDwn5eR77iPIFJlbW92ZWQgc2NlbmUgJHtzY2VuZUlkfSBmcm9tIGNhY2hlc2ApO1xyXG59XHJcblxyXG4vLyAtLS0gRnVuIG1vZGUgc2FuZGJveCAtLS1cclxuLy9cclxuLy8gSW4gZnVuIG1vZGUsIGJhdHRsZXMgcnVuIHRoZWlyIG5vcm1hbCBsb2dpYyBidXQgcmF0aW5ncyBsaXZlIG9ubHkgaW4gbWVtb3J5OiBwb29scyBhcmUgc2VydmVkXHJcbi8vIGFzIGNvcGllcyBvZiB0aGUgY2FjaGVkIHNjZW5lcyAob25lIGNvcHkgcGVyIHNjZW5lIGlkKSwgcmUtc29ydGVkIGJ5IHRob3NlIGNvcGllcycgcmF0aW5ncywgYW5kXHJcbi8vIHJhdGluZyB3cml0ZXMgdXBkYXRlIHRoZSBjb3BpZXMgaW5zdGVhZCBvZiBTdGFzaCBvciB0aGUgcmVhbCBjYWNoZS5cclxuXHJcbmNvbnN0IGZ1blNhbmRib3ggPSBuZXcgTWFwPHN0cmluZywgU2NlbmU+KCk7XHJcblxyXG4vKiogRnVuLW1vZGUgY29weSBvZiBhIHNjZW5lLCBjcmVhdGVkIGZyb20gdGhlIHJlYWwgb25lIG9uIGZpcnN0IHVzZS4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHNhbmRib3hTY2VuZShzY2VuZTogU2NlbmUpOiBTY2VuZSB7XHJcbiAgbGV0IGNvcHkgPSBmdW5TYW5kYm94LmdldChzY2VuZS5pZCk7XHJcbiAgaWYgKCFjb3B5KSB7XHJcbiAgICBjb3B5ID0geyAuLi5zY2VuZSB9O1xyXG4gICAgZnVuU2FuZGJveC5zZXQoc2NlbmUuaWQsIGNvcHkpO1xyXG4gIH1cclxuICByZXR1cm4gY29weTtcclxufVxyXG5cclxuLyoqIEEgcmVhbCAocmF0aW5nLXNvcnRlZCkgcG9vbCBhcyBzYW5kYm94IGNvcGllcywgcmUtc29ydGVkIGJ5IHRoZWlyIGluLW1lbW9yeSByYXRpbmdzLiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gc2FuZGJveFBvb2wocG9vbDogU2NlbmVbXSk6IFNjZW5lW10ge1xyXG4gIC8vIFN0YWJsZSBzb3J0OiB0aWVzIGtlZXAgdGhlIHJlYWwgY2FjaGUncyBvcmRlciwgdW5yYXRlZCAoMCkgc3RheSBsYXN0XHJcbiAgcmV0dXJuIHBvb2wubWFwKHNhbmRib3hTY2VuZSkuc29ydCgoYSwgYikgPT4gKGIucmF0aW5nMTAwID8/IDApIC0gKGEucmF0aW5nMTAwID8/IDApKTtcclxufVxyXG5cclxuLyoqIEZ1bi1tb2RlIHJhdGluZyB3cml0ZTogdXBkYXRlcyB0aGUgaW4tbWVtb3J5IGNvcHkgb25seS4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHNldFNhbmRib3hSYXRpbmcoc2NlbmVJZDogc3RyaW5nLCByYXRpbmcxMDA6IG51bWJlciB8IG51bGwpOiB2b2lkIHtcclxuICBjb25zdCByZWFsID0gZnVuU2FuZGJveC5oYXMoc2NlbmVJZCkgPyBudWxsIDogc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzPy5maW5kKChzKSA9PiBzLmlkID09PSBzY2VuZUlkKTtcclxuICBjb25zdCBjb3B5ID0gZnVuU2FuZGJveC5nZXQoc2NlbmVJZCkgPz8gKHJlYWwgPyBzYW5kYm94U2NlbmUocmVhbCkgOiBudWxsKTtcclxuICBpZiAoY29weSkgY29weS5yYXRpbmcxMDAgPSByYXRpbmcxMDA7XHJcbn1cclxuXHJcbi8qKiBGb3JnZXQgYWxsIGZ1bi1tb2RlIHJhdGluZ3MgKGZ1biBtb2RlIHRvZ2dsZWQsIGNhY2hlIHJlZnJlc2hlZCkuICovXHJcbmV4cG9ydCBmdW5jdGlvbiByZXNldFNhbmRib3goKTogdm9pZCB7XHJcbiAgZnVuU2FuZGJveC5jbGVhcigpO1xyXG59XHJcblxyXG4vKiogVGhlIHNjZW5lJ3Mgc2F2ZWQgcmF0aW5nIChmcm9tIHRoZSByZWFsIGNhY2hlKSwgZm9yIGRpc3BsYXkgd2hpbGUgZnVuIG1vZGUgc2hvd3Mgc2FuZGJveCBjb3BpZXMuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBzYXZlZFJhdGluZyhzY2VuZTogU2NlbmUpOiBudW1iZXIgfCBudWxsIHwgdW5kZWZpbmVkIHtcclxuICBjb25zdCByZWFsID0gc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzPy5maW5kKChzKSA9PiBzLmlkID09PSBzY2VuZS5pZCk7XHJcbiAgcmV0dXJuIHJlYWwgPyByZWFsLnJhdGluZzEwMCA6IHNjZW5lLnJhdGluZzEwMDtcclxufVxyXG4iLCAiLy8gU2NlbmUgbG9va3VwcyBmb3IgZGV0ZWN0aW5nIHNjZW5lcyBkZWxldGVkIHdoaWxlIHRoZXkgd2VyZSBpbiBhIGJhdHRsZS5cclxuXHJcbmltcG9ydCB7IGdyYXBocWxRdWVyeSB9IGZyb20gXCIuL2dyYXBocWxcIjtcclxuXHJcbi8qKiBXaGljaCBvZiB0aGVzZSBzY2VuZSBpZHMgc3RpbGwgZXhpc3QgaW4gU3Rhc2guIChmaW5kU2NlbmVzKGlkcykgZXJyb3JzIG9uIGFueSBtaXNzaW5nIGlkLikgKi9cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGZpbmRFeGlzdGluZ1NjZW5lSWRzKGlkczogc3RyaW5nW10pOiBQcm9taXNlPFNldDxzdHJpbmc+PiB7XHJcbiAgY29uc3QgYWxpYXNlcyA9IGlkcy5tYXAoKGlkLCBpKSA9PiBgcyR7aX06IGZpbmRTY2VuZShpZDogJHtKU09OLnN0cmluZ2lmeShpZCl9KSB7IGlkIH1gKS5qb2luKFwiXFxuXCIpO1xyXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGdyYXBocWxRdWVyeTxSZWNvcmQ8c3RyaW5nLCB7IGlkOiBzdHJpbmcgfSB8IG51bGw+PihgeyAke2FsaWFzZXN9IH1gKTtcclxuICByZXR1cm4gbmV3IFNldChPYmplY3QudmFsdWVzKHJlc3VsdCkuZmxhdE1hcCgocykgPT4gKHMgPyBbcy5pZF0gOiBbXSkpKTtcclxufVxyXG5cclxuLyoqIFRydWUgZm9yIEdyYXBoUUwgZXJyb3JzIFN0YXNoIHJhaXNlcyB3aGVuIGEgc2NlbmUgaWQgbm8gbG9uZ2VyIGV4aXN0cy4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGlzU2NlbmVOb3RGb3VuZEVycm9yKGVycm9yOiB1bmtub3duKTogYm9vbGVhbiB7XHJcbiAgcmV0dXJuIGVycm9yIGluc3RhbmNlb2YgRXJyb3IgJiYgL25vdCBmb3VuZC9pLnRlc3QoZXJyb3IubWVzc2FnZSk7XHJcbn1cclxuIiwgIi8vIFBlcnNpc3Qgc2NlbmUgcmF0aW5ncyB0byBTdGFzaCBhbmQga2VlcCB0aGUgbG9jYWwgY2FjaGUgaW4gc3luYy5cclxuXHJcbmltcG9ydCB7IGNsZWFyU2NlbmVJbkNhY2hlLCBzZXRTYW5kYm94UmF0aW5nLCB1cGRhdGVTY2VuZUluQ2FjaGUgfSBmcm9tIFwiLi9jYWNoZVwiO1xyXG5pbXBvcnQgeyBncmFwaHFsUXVlcnkgfSBmcm9tIFwiLi9ncmFwaHFsXCI7XHJcbmltcG9ydCB7IGlzU2NlbmVOb3RGb3VuZEVycm9yIH0gZnJvbSBcIi4vc2NlbmVBY3Rpb25zXCI7XHJcbmltcG9ydCB7IHN0YXRlIH0gZnJvbSBcIi4vc3RhdGVcIjtcclxuXHJcbi8qKiBXaW5kb3cgZXZlbnQgZmlyZWQgd2hlbiBhIHJhdGluZyB3cml0ZSBmaW5kcyB0aGUgc2NlbmUgd2FzIGRlbGV0ZWQgZWxzZXdoZXJlIChkZXRhaWwgPSBzY2VuZSBpZCkuICovXHJcbmV4cG9ydCBjb25zdCBTQ0VORV9NSVNTSU5HX0VWRU5UID0gXCJzdGFzaC1iYXR0bGU6c2NlbmUtbWlzc2luZ1wiO1xyXG5cclxuLyoqXHJcbiAqIEZhbHNlIGluIGZ1biBtb2RlLiBPbmx5IGZvciBVSSAocmF0aW5nIGFuaW1hdGlvbnMsIFwibm90IHNhdmVkXCIgbm90ZXMpOiB0aGUgd3JpdGUgcGF0aCBiZWxvd1xyXG4gKiBoYW5kbGVzIGZ1biBtb2RlIGl0c2VsZiwgc28gYmF0dGxlIGxvZ2ljIG5ldmVyIG5lZWRzIHRvIGNoZWNrIHRoaXMuXHJcbiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gcmF0aW5nc0VuYWJsZWQoKTogYm9vbGVhbiB7XHJcbiAgcmV0dXJuICFzdGF0ZS5zZXR0aW5ncy5mdW5Nb2RlO1xyXG59XHJcblxyXG5jb25zdCBTQ0VORV9VUERBVEVfTVVUQVRJT04gPSBgXHJcbiAgICAgIG11dGF0aW9uIFNjZW5lVXBkYXRlKCRpbnB1dDogU2NlbmVVcGRhdGVJbnB1dCEpIHtcclxuICAgICAgICBzY2VuZVVwZGF0ZShpbnB1dDogJGlucHV0KSB7XHJcbiAgICAgICAgICBpZFxyXG4gICAgICAgICAgcmF0aW5nMTAwXHJcbiAgICAgICAgfVxyXG4gICAgICB9XHJcbiAgICBgO1xyXG5cclxuLyoqXHJcbiAqIFdyaXRlIGEgcmF0aW5nIChudWxsIGNsZWFycyk6IHRvIFN0YXNoIGFuZCB0aGUgY2FjaGUsIG9yIGluIGZ1biBtb2RlIG9ubHkgdG8gdGhlIGluLW1lbW9yeVxyXG4gKiBzYW5kYm94LCBzbyBiYXR0bGVzIGJlaGF2ZSBub3JtYWxseSB3aXRob3V0IHNhdmluZyBhbnl0aGluZy5cclxuICovXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB1cGRhdGVTY2VuZVJhdGluZyhzY2VuZUlkOiBzdHJpbmcsIHJhdGluZzEwMDogbnVtYmVyIHwgbnVsbCk6IFByb21pc2U8dm9pZD4ge1xyXG4gIGNvbnN0IHN0YXNoUmF0aW5nID1cclxuICAgIHJhdGluZzEwMCA9PT0gbnVsbCA/IG51bGwgOiBNYXRoLm1heCgxLCBNYXRoLm1pbigxMDAsIHJhdGluZzEwMCkpO1xyXG5cclxuICBpZiAoIXJhdGluZ3NFbmFibGVkKCkpIHtcclxuICAgIGNvbnNvbGUubG9nKGBbU3Rhc2ggQmF0dGxlXSDwn46IIEZ1biBtb2RlOiBzY2VuZSAke3NjZW5lSWR9IHJhdGluZyAke3N0YXNoUmF0aW5nfSBrZXB0IGluIG1lbW9yeSBvbmx5YCk7XHJcbiAgICBzZXRTYW5kYm94UmF0aW5nKHNjZW5lSWQsIHN0YXNoUmF0aW5nKTtcclxuICAgIHJldHVybjtcclxuICB9XHJcblxyXG4gIHRyeSB7XHJcbiAgICBhd2FpdCBncmFwaHFsUXVlcnkoU0NFTkVfVVBEQVRFX01VVEFUSU9OLCB7XHJcbiAgICAgIGlucHV0OiB7XHJcbiAgICAgICAgaWQ6IHNjZW5lSWQsXHJcbiAgICAgICAgcmF0aW5nMTAwOiBzdGFzaFJhdGluZyxcclxuICAgICAgfSxcclxuICAgIH0pO1xyXG5cclxuICAgIGlmIChzdGFzaFJhdGluZyA9PT0gbnVsbCkge1xyXG4gICAgICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g8J+TnSBDbGVhcmVkIHNjZW5lICR7c2NlbmVJZH0gcmF0aW5nIGluIFN0YXNoYCk7XHJcbiAgICAgIGNsZWFyU2NlbmVJbkNhY2hlKHNjZW5lSWQpO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIPCfk50gVXBkYXRlZCBzY2VuZSAke3NjZW5lSWR9IHJhdGluZyB0byAke3N0YXNoUmF0aW5nfSBpbiBTdGFzaGApO1xyXG4gICAgICB1cGRhdGVTY2VuZUluQ2FjaGUoc2NlbmVJZCwgc3Rhc2hSYXRpbmcpO1xyXG4gICAgfVxyXG4gIH0gY2F0Y2ggKGUpIHtcclxuICAgIGNvbnN0IGFjdGlvbiA9IHN0YXNoUmF0aW5nID09PSBudWxsID8gXCJjbGVhclwiIDogXCJ1cGRhdGVcIjtcclxuICAgIGNvbnNvbGUuZXJyb3IoYFtTdGFzaCBCYXR0bGVdIEZhaWxlZCB0byAke2FjdGlvbn0gc2NlbmUgJHtzY2VuZUlkfSByYXRpbmc6YCwgZSk7XHJcbiAgICBpZiAoaXNTY2VuZU5vdEZvdW5kRXJyb3IoZSkpIHtcclxuICAgICAgd2luZG93LmRpc3BhdGNoRXZlbnQobmV3IEN1c3RvbUV2ZW50KFNDRU5FX01JU1NJTkdfRVZFTlQsIHsgZGV0YWlsOiBzY2VuZUlkIH0pKTtcclxuICAgIH1cclxuICB9XHJcbn1cclxuIiwgIi8vIFVzZXIgc2V0dGluZ3Mgc3RvcmVkIGluIFN0YXNoJ3MgcGx1Z2luIGNvbmZpZ3VyYXRpb24gKGNvbmZpZ3VyYXRpb24ucGx1Z2luc1tcInN0YXNoLWJhdHRsZVwiXSksXHJcbi8vIHNvIHRoZXkgZm9sbG93IHRoZSB1c2VyIGFjcm9zcyBicm93c2Vycy4gQWxzbyBlZGl0YWJsZSBpbiBTdGFzaCDihpIgU2V0dGluZ3Mg4oaSIFBsdWdpbnMuXHJcblxyXG5pbXBvcnQge1xyXG4gIERFRkFVTFRfU0VUVElOR1MsXHJcbiAgTEVHQUNZX0ZJTFRFUl9PUFBPTkVOVFNfS0VZLFxyXG4gIExFR0FDWV9NVVRFX1BSRVZJRVdTX0tFWSxcclxuICBQTFVHSU5fSUQsXHJcbn0gZnJvbSBcIi4vY29uc3RhbnRzXCI7XHJcbmltcG9ydCB7IGdyYXBocWxRdWVyeSB9IGZyb20gXCIuL2dyYXBocWxcIjtcclxuaW1wb3J0IHsgc3RhdGUgfSBmcm9tIFwiLi9zdGF0ZVwiO1xyXG5pbXBvcnQgdHlwZSB7IFNldHRpbmdzIH0gZnJvbSBcIi4vdHlwZXNcIjtcclxuXHJcbmNvbnN0IENPTkZJR19RVUVSWSA9IGB7IGNvbmZpZ3VyYXRpb24geyBwbHVnaW5zIH0gfWA7XHJcblxyXG5jb25zdCBDT05GSUdVUkVfUExVR0lOX01VVEFUSU9OID0gYFxyXG4gICAgICBtdXRhdGlvbiBDb25maWd1cmVQbHVnaW4oJHBsdWdpbl9pZDogSUQhLCAkaW5wdXQ6IE1hcCEpIHtcclxuICAgICAgICBjb25maWd1cmVQbHVnaW4ocGx1Z2luX2lkOiAkcGx1Z2luX2lkLCBpbnB1dDogJGlucHV0KVxyXG4gICAgICB9XHJcbiAgICBgO1xyXG5cclxuY29uc3QgU0FWRV9ERUJPVU5DRV9NUyA9IDQwMDtcclxubGV0IHNhdmVUaW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCBudWxsID0gbnVsbDtcclxuXHJcbmZ1bmN0aW9uIGNsYW1wUGVyY2VudCh2YWx1ZTogdW5rbm93biwgZmFsbGJhY2s6IG51bWJlcik6IG51bWJlciB7XHJcbiAgY29uc3QgbiA9IE51bWJlcih2YWx1ZSk7XHJcbiAgcmV0dXJuIE51bWJlci5pc0Zpbml0ZShuKSA/IE1hdGgubWluKDEwMCwgTWF0aC5tYXgoMCwgTWF0aC5yb3VuZChuKSkpIDogZmFsbGJhY2s7XHJcbn1cclxuXHJcbi8qKiBDb2VyY2UgYSBzdG9yZWQgY29uZmlnIG1hcCBpbnRvIFNldHRpbmdzIChTdGFzaCBtYXkgb21pdCBrZXlzIG9yIHN0b3JlIG51bWJlcnMgYXMgc3RyaW5ncykuICovXHJcbmZ1bmN0aW9uIG5vcm1hbGl6ZShyYXc6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LCBiYXNlOiBTZXR0aW5ncyk6IFNldHRpbmdzIHtcclxuICBjb25zdCBib29sID0gKGtleToga2V5b2YgU2V0dGluZ3MpOiBib29sZWFuID0+XHJcbiAgICB0eXBlb2YgcmF3W2tleV0gPT09IFwiYm9vbGVhblwiID8gKHJhd1trZXldIGFzIGJvb2xlYW4pIDogKGJhc2Vba2V5XSBhcyBib29sZWFuKTtcclxuICByZXR1cm4ge1xyXG4gICAgZnVuTW9kZTogYm9vbChcImZ1bk1vZGVcIiksXHJcbiAgICBvcGVuSW5OZXdUYWI6IGJvb2woXCJvcGVuSW5OZXdUYWJcIiksXHJcbiAgICBhdXRvcGxheVByZXZpZXdzOiBib29sKFwiYXV0b3BsYXlQcmV2aWV3c1wiKSxcclxuICAgIGZpbHRlck9wcG9uZW50czogYm9vbChcImZpbHRlck9wcG9uZW50c1wiKSxcclxuICAgIGNsZWFuTW9kZTogYm9vbChcImNsZWFuTW9kZVwiKSxcclxuICAgIHBhdXNlTWVkaWFPbk9wZW46IGJvb2woXCJwYXVzZU1lZGlhT25PcGVuXCIpLFxyXG4gICAgdW5yYXRlZFJhdGluZzogY2xhbXBQZXJjZW50KHJhdy51bnJhdGVkUmF0aW5nID8/IGJhc2UudW5yYXRlZFJhdGluZywgYmFzZS51bnJhdGVkUmF0aW5nKSxcclxuICAgIHByZXZpZXdWb2x1bWU6IGNsYW1wUGVyY2VudChyYXcucHJldmlld1ZvbHVtZSA/PyBiYXNlLnByZXZpZXdWb2x1bWUsIGJhc2UucHJldmlld1ZvbHVtZSksXHJcbiAgfTtcclxufVxyXG5cclxuLyoqIERlZmF1bHRzIG92ZXJsYWlkIHdpdGggdGhlIHByZS0yLjcgbG9jYWxTdG9yYWdlIHRvZ2dsZXMsIGZvciB1c2VycyB3aG8gbmV2ZXIgc2F2ZWQgc2V0dGluZ3MuICovXHJcbmZ1bmN0aW9uIGxlZ2FjeURlZmF1bHRzKCk6IFNldHRpbmdzIHtcclxuICBjb25zdCBzZXR0aW5ncyA9IHsgLi4uREVGQVVMVF9TRVRUSU5HUyB9O1xyXG4gIHRyeSB7XHJcbiAgICBpZiAobG9jYWxTdG9yYWdlLmdldEl0ZW0oTEVHQUNZX0ZJTFRFUl9PUFBPTkVOVFNfS0VZKSA9PT0gXCIxXCIpIHNldHRpbmdzLmZpbHRlck9wcG9uZW50cyA9IHRydWU7XHJcbiAgICBpZiAobG9jYWxTdG9yYWdlLmdldEl0ZW0oTEVHQUNZX01VVEVfUFJFVklFV1NfS0VZKSA9PT0gXCIxXCIpIHNldHRpbmdzLnByZXZpZXdWb2x1bWUgPSAwO1xyXG4gIH0gY2F0Y2gge1xyXG4gICAgLyogaWdub3JlICovXHJcbiAgfVxyXG4gIHJldHVybiBzZXR0aW5ncztcclxufVxyXG5cclxuLyoqIEZldGNoIHNldHRpbmdzIGZyb20gU3Rhc2ggaW50byBzdGF0ZS5zZXR0aW5ncy4gRmFsbHMgYmFjayB0byBjdXJyZW50IHZhbHVlcyBvbiBmYWlsdXJlLiAqL1xyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbG9hZFNldHRpbmdzKCk6IFByb21pc2U8U2V0dGluZ3M+IHtcclxuICB0cnkge1xyXG4gICAgY29uc3QgZGF0YSA9IGF3YWl0IGdyYXBocWxRdWVyeTx7IGNvbmZpZ3VyYXRpb246IHsgcGx1Z2luczogUmVjb3JkPHN0cmluZywgUmVjb3JkPHN0cmluZywgdW5rbm93bj4+IH0gfT4oXHJcbiAgICAgIENPTkZJR19RVUVSWSxcclxuICAgICk7XHJcbiAgICBjb25zdCBzdG9yZWQgPSBkYXRhLmNvbmZpZ3VyYXRpb24ucGx1Z2lucz8uW1BMVUdJTl9JRF07XHJcbiAgICBzdGF0ZS5zZXR0aW5ncyA9IHN0b3JlZCA/IG5vcm1hbGl6ZShzdG9yZWQsIERFRkFVTFRfU0VUVElOR1MpIDogbGVnYWN5RGVmYXVsdHMoKTtcclxuICB9IGNhdGNoIChlKSB7XHJcbiAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0gRmFpbGVkIHRvIGxvYWQgc2V0dGluZ3MsIHVzaW5nIGN1cnJlbnQgdmFsdWVzOlwiLCBlKTtcclxuICB9XHJcbiAgcmV0dXJuIHN0YXRlLnNldHRpbmdzO1xyXG59XHJcblxyXG5hc3luYyBmdW5jdGlvbiBwZXJzaXN0U2V0dGluZ3MoKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgdHJ5IHtcclxuICAgIC8vIGNvbmZpZ3VyZVBsdWdpbiByZXBsYWNlcyB0aGUgd2hvbGUgbWFwLCBzbyBhbHdheXMgc2VuZCBldmVyeSBrZXlcclxuICAgIGF3YWl0IGdyYXBocWxRdWVyeShDT05GSUdVUkVfUExVR0lOX01VVEFUSU9OLCB7IHBsdWdpbl9pZDogUExVR0lOX0lELCBpbnB1dDogeyAuLi5zdGF0ZS5zZXR0aW5ncyB9IH0pO1xyXG4gIH0gY2F0Y2ggKGUpIHtcclxuICAgIGNvbnNvbGUuZXJyb3IoXCJbU3Rhc2ggQmF0dGxlXSBGYWlsZWQgdG8gc2F2ZSBzZXR0aW5nczpcIiwgZSk7XHJcbiAgfVxyXG59XHJcblxyXG4vKiogVXBkYXRlIHNldHRpbmdzIGxvY2FsbHkgcmlnaHQgYXdheSBhbmQgcGVyc2lzdCB0byBTdGFzaCAoZGVib3VuY2VkLCBmb3Igc2xpZGVycykuICovXHJcbmV4cG9ydCBmdW5jdGlvbiB1cGRhdGVTZXR0aW5ncyhwYXRjaDogUGFydGlhbDxTZXR0aW5ncz4pOiB2b2lkIHtcclxuICBzdGF0ZS5zZXR0aW5ncyA9IG5vcm1hbGl6ZSh7IC4uLnN0YXRlLnNldHRpbmdzLCAuLi5wYXRjaCB9LCBzdGF0ZS5zZXR0aW5ncyk7XHJcbiAgaWYgKHNhdmVUaW1lcikgY2xlYXJUaW1lb3V0KHNhdmVUaW1lcik7XHJcbiAgc2F2ZVRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XHJcbiAgICBzYXZlVGltZXIgPSBudWxsO1xyXG4gICAgdm9pZCBwZXJzaXN0U2V0dGluZ3MoKTtcclxuICB9LCBTQVZFX0RFQk9VTkNFX01TKTtcclxufVxyXG4iLCAiLy8gUGVyc2lzdC9yZXN0b3JlIHRoZSBiYXR0bGUgc2Vzc2lvbiB0byBsb2NhbFN0b3JhZ2UuXHJcblxyXG5pbXBvcnQgeyBTVE9SQUdFX0tFWSB9IGZyb20gXCIuL2NvbnN0YW50c1wiO1xyXG5pbXBvcnQgeyBzdGF0ZSB9IGZyb20gXCIuL3N0YXRlXCI7XHJcbmltcG9ydCB0eXBlIHsgTW9kZSwgUGFpciwgUGxhY2VtZW50UnVuLCBSYW5rcywgU2NlbmUgfSBmcm9tIFwiLi90eXBlc1wiO1xyXG5cclxuaW50ZXJmYWNlIFBlcnNpc3RlZFN0YXRlIHtcclxuICBjdXJyZW50UGFpcj86IFBhaXI7XHJcbiAgY3VycmVudFJhbmtzPzogUmFua3M7XHJcbiAgY3VycmVudE1vZGU/OiBNb2RlO1xyXG4gIGdhdW50bGV0Q2xpbWJlcj86IFNjZW5lIHwgbnVsbDtcclxuICBnYXVudGxldFdpbnM/OiBudW1iZXI7XHJcbiAgZ2F1bnRsZXRDbGltYmVyUmFuaz86IG51bWJlcjtcclxuICBnYXVudGxldERlZmVhdGVkPzogc3RyaW5nW107XHJcbiAgZ2F1bnRsZXRGYWxsaW5nPzogYm9vbGVhbjtcclxuICBnYXVudGxldEZhbGxpbmdTY2VuZT86IFNjZW5lIHwgbnVsbDtcclxuICBwbGFjZW1lbnQ/OiBQbGFjZW1lbnRSdW4gfCBudWxsO1xyXG4gIHRvdGFsU2NlbmVzQ291bnQ/OiBudW1iZXI7XHJcbiAgc2F2ZWRGaWx0ZXJQYXJhbXM/OiBzdHJpbmc7XHJcbiAgLyoqIEBkZXByZWNhdGVkIFJlbmFtZWQgdG8gZ2F1bnRsZXRDbGltYmVyICovXHJcbiAgZ2F1bnRsZXRDaGFtcGlvbj86IFNjZW5lIHwgbnVsbDtcclxuICAvKiogQGRlcHJlY2F0ZWQgUmVuYW1lZCB0byBnYXVudGxldENsaW1iZXJSYW5rICovXHJcbiAgZ2F1bnRsZXRDaGFtcGlvblJhbms/OiBudW1iZXI7XHJcbn1cclxuXHJcbi8qKiBTYXZlcyB0aGUgY3VycmVudCBiYXR0bGUgc2Vzc2lvbiB0byBsb2NhbFN0b3JhZ2UuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBzYXZlU3RhdGUoKTogdm9pZCB7XHJcbiAgY29uc3Qgc25hcHNob3Q6IFBlcnNpc3RlZFN0YXRlID0ge1xyXG4gICAgY3VycmVudFBhaXI6IHN0YXRlLmN1cnJlbnRQYWlyLFxyXG4gICAgY3VycmVudFJhbmtzOiBzdGF0ZS5jdXJyZW50UmFua3MsXHJcbiAgICBjdXJyZW50TW9kZTogc3RhdGUuY3VycmVudE1vZGUsXHJcbiAgICBnYXVudGxldENsaW1iZXI6IHN0YXRlLmdhdW50bGV0Q2xpbWJlcixcclxuICAgIGdhdW50bGV0V2luczogc3RhdGUuZ2F1bnRsZXRXaW5zLFxyXG4gICAgZ2F1bnRsZXRDbGltYmVyUmFuazogc3RhdGUuZ2F1bnRsZXRDbGltYmVyUmFuayxcclxuICAgIGdhdW50bGV0RGVmZWF0ZWQ6IHN0YXRlLmdhdW50bGV0RGVmZWF0ZWQsXHJcbiAgICBnYXVudGxldEZhbGxpbmc6IHN0YXRlLmdhdW50bGV0RmFsbGluZyxcclxuICAgIGdhdW50bGV0RmFsbGluZ1NjZW5lOiBzdGF0ZS5nYXVudGxldEZhbGxpbmdTY2VuZSxcclxuICAgIHBsYWNlbWVudDogc3RhdGUucGxhY2VtZW50LFxyXG4gICAgdG90YWxTY2VuZXNDb3VudDogc3RhdGUudG90YWxTY2VuZXNDb3VudCxcclxuICAgIHNhdmVkRmlsdGVyUGFyYW1zOiB3aW5kb3cubG9jYXRpb24uc2VhcmNoLFxyXG4gIH07XHJcbiAgdHJ5IHtcclxuICAgIGxvY2FsU3RvcmFnZS5zZXRJdGVtKFNUT1JBR0VfS0VZLCBKU09OLnN0cmluZ2lmeShzbmFwc2hvdCkpO1xyXG4gIH0gY2F0Y2ggKGUpIHtcclxuICAgIGNvbnNvbGUuZXJyb3IoXCJbU3Rhc2ggQmF0dGxlXSBGYWlsZWQgdG8gc2F2ZSBzdGF0ZTpcIiwgZSk7XHJcbiAgfVxyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gbG9hZFN0YXRlKCk6IGJvb2xlYW4ge1xyXG4gIHRyeSB7XHJcbiAgICBjb25zdCBzYXZlZCA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKFNUT1JBR0VfS0VZKTtcclxuICAgIGlmIChzYXZlZCkge1xyXG4gICAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHNhdmVkKSBhcyBQZXJzaXN0ZWRTdGF0ZTtcclxuICAgICAgc3RhdGUuY3VycmVudFBhaXIgPSBwYXJzZWQuY3VycmVudFBhaXIgfHwgeyBsZWZ0OiBudWxsLCByaWdodDogbnVsbCB9O1xyXG4gICAgICBzdGF0ZS5jdXJyZW50UmFua3MgPSBwYXJzZWQuY3VycmVudFJhbmtzIHx8IHsgbGVmdDogbnVsbCwgcmlnaHQ6IG51bGwgfTtcclxuICAgICAgc3RhdGUuY3VycmVudE1vZGUgPSBwYXJzZWQuY3VycmVudE1vZGUgfHwgXCJzd2lzc1wiO1xyXG4gICAgICBzdGF0ZS5nYXVudGxldENsaW1iZXIgPSBwYXJzZWQuZ2F1bnRsZXRDbGltYmVyID8/IHBhcnNlZC5nYXVudGxldENoYW1waW9uID8/IG51bGw7XHJcbiAgICAgIHN0YXRlLmdhdW50bGV0V2lucyA9IHBhcnNlZC5nYXVudGxldFdpbnMgfHwgMDtcclxuICAgICAgc3RhdGUuZ2F1bnRsZXRDbGltYmVyUmFuayA9IHBhcnNlZC5nYXVudGxldENsaW1iZXJSYW5rID8/IHBhcnNlZC5nYXVudGxldENoYW1waW9uUmFuayA/PyAwO1xyXG4gICAgICBzdGF0ZS5nYXVudGxldERlZmVhdGVkID0gcGFyc2VkLmdhdW50bGV0RGVmZWF0ZWQgfHwgW107XHJcbiAgICAgIHN0YXRlLmdhdW50bGV0RmFsbGluZyA9IHBhcnNlZC5nYXVudGxldEZhbGxpbmcgfHwgZmFsc2U7XHJcbiAgICAgIHN0YXRlLmdhdW50bGV0RmFsbGluZ1NjZW5lID0gcGFyc2VkLmdhdW50bGV0RmFsbGluZ1NjZW5lIHx8IG51bGw7XHJcbiAgICAgIHN0YXRlLnBsYWNlbWVudCA9IHBhcnNlZC5wbGFjZW1lbnQgfHwgbnVsbDtcclxuICAgICAgc3RhdGUudG90YWxTY2VuZXNDb3VudCA9IHBhcnNlZC50b3RhbFNjZW5lc0NvdW50IHx8IDA7XHJcbiAgICAgIHN0YXRlLnNhdmVkRmlsdGVyUGFyYW1zID0gcGFyc2VkLnNhdmVkRmlsdGVyUGFyYW1zIHx8IFwiXCI7XHJcbiAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgfVxyXG4gIH0gY2F0Y2ggKGUpIHtcclxuICAgIGNvbnNvbGUuZXJyb3IoXCJbU3Rhc2ggQmF0dGxlXSBGYWlsZWQgdG8gbG9hZCBzdGF0ZTpcIiwgZSk7XHJcbiAgfVxyXG4gIHJldHVybiBmYWxzZTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGNsZWFyU3RhdGUoKTogdm9pZCB7XHJcbiAgdHJ5IHtcclxuICAgIGxvY2FsU3RvcmFnZS5yZW1vdmVJdGVtKFNUT1JBR0VfS0VZKTtcclxuICB9IGNhdGNoIChlKSB7XHJcbiAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0gRmFpbGVkIHRvIGNsZWFyIHN0YXRlOlwiLCBlKTtcclxuICB9XHJcbn1cclxuIiwgIi8vIEVMTyByYXRpbmcgbG9naWMgKHB1cmUgY2FsY3VsYXRpb25zIOKAlCBjYWxsZXJzIGFwcGx5IHJlc3VsdHMgYW5kIHBlcnNpc3QpLlxyXG5cclxuaW1wb3J0IHsgRUxPX0RJVklTT1IsIEVMT19LX1RJRVJTIH0gZnJvbSBcIi4vY29uc3RhbnRzXCI7XHJcbmltcG9ydCB0eXBlIHsgQ29tcGFyaXNvbkRlbHRhcywgQ29tcGFyaXNvbklucHV0IH0gZnJvbSBcIi4vdHlwZXNcIjtcclxuXHJcbi8vIC0tLSBTdGFuZGFyZCBFTE8gKDMuMDogdW5jYXBwZWQsIHN0b3JlZCBpbiBjdXN0b20gZmllbGRzKSAtLS1cclxuXHJcbi8qKiBLIGZvciBhIHNjZW5lIHdpdGggdGhpcyBtYW55IHJhdGVkIGdhbWVzOiBuZXcgc2NlbmVzIG1vdmUgYSBsb3QsIGVzdGFibGlzaGVkIG9uZXMgbGl0dGxlLiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gZWxvS0ZhY3RvcihnYW1lczogbnVtYmVyKTogbnVtYmVyIHtcclxuICBmb3IgKGNvbnN0IFtiZWxvdywga10gb2YgRUxPX0tfVElFUlMpIHtcclxuICAgIGlmIChnYW1lcyA8IGJlbG93KSByZXR1cm4gaztcclxuICB9XHJcbiAgcmV0dXJuIEVMT19LX1RJRVJTW0VMT19LX1RJRVJTLmxlbmd0aCAtIDFdWzFdO1xyXG59XHJcblxyXG4vKiogUHJvYmFiaWxpdHkgdGhhdCBhIHNjZW5lIHJhdGVkIGBlbG9gIGJlYXRzIG9uZSByYXRlZCBgb3Bwb25lbnRFbG9gLiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gZWxvRXhwZWN0ZWQoZWxvOiBudW1iZXIsIG9wcG9uZW50RWxvOiBudW1iZXIpOiBudW1iZXIge1xyXG4gIHJldHVybiAxIC8gKDEgKyBNYXRoLnBvdygxMCwgKG9wcG9uZW50RWxvIC0gZWxvKSAvIEVMT19ESVZJU09SKSk7XHJcbn1cclxuXHJcbmV4cG9ydCBpbnRlcmZhY2UgRWxvU2lkZSB7XHJcbiAgZWxvOiBudW1iZXI7XHJcbiAgZ2FtZXM6IG51bWJlcjtcclxufVxyXG5cclxuLyoqIFN0b3JlZCBFTE8gcHJlY2lzaW9uIChvbmUgZGVjaW1hbCksIHNvIHNtYWxsIGxhdGUtY2FyZWVyIGNoYW5nZXMgYXJlbid0IHJvdW5kZWQgYXdheS4gKi9cclxuZnVuY3Rpb24gcm91bmRFbG8oZWxvOiBudW1iZXIpOiBudW1iZXIge1xyXG4gIHJldHVybiBNYXRoLnJvdW5kKGVsbyAqIDEwKSAvIDEwO1xyXG59XHJcblxyXG4vKiogVHdvLXNpZGVkIEVMTyBmb3IgYSBoZWFkLXRvLWhlYWQgd2luOyBlYWNoIHNpZGUgdXNlcyBpdHMgb3duIEsuIFJldHVybnMgdGhlIG5ldyBFTE9zLiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gZWxvUmVzdWx0KHdpbm5lcjogRWxvU2lkZSwgbG9zZXI6IEVsb1NpZGUpOiB7IHdpbm5lcjogbnVtYmVyOyBsb3NlcjogbnVtYmVyIH0ge1xyXG4gIGNvbnN0IGV4cGVjdGVkID0gZWxvRXhwZWN0ZWQod2lubmVyLmVsbywgbG9zZXIuZWxvKTtcclxuICByZXR1cm4ge1xyXG4gICAgd2lubmVyOiByb3VuZEVsbyh3aW5uZXIuZWxvICsgZWxvS0ZhY3Rvcih3aW5uZXIuZ2FtZXMpICogKDEgLSBleHBlY3RlZCkpLFxyXG4gICAgbG9zZXI6IHJvdW5kRWxvKGxvc2VyLmVsbyAtIGVsb0tGYWN0b3IobG9zZXIuZ2FtZXMpICogZXhwZWN0ZWQpLFxyXG4gIH07XHJcbn1cclxuXHJcbi8vIC0tLSBQcmUtMy4wIHJhdGluZzEwMCBFTE8gLS0tXHJcblxyXG5jb25zdCBNSU5fUkFUSU5HID0gMTtcclxuY29uc3QgTUFYX1JBVElORyA9IDEwMDtcclxuXHJcbi8vIER5bmFtaWMgSy1mYWN0b3IgYmFzZWQgb24gcGxheV9jb3VudCAoc2ltaWxhciB0byBjaGVzcyBFTE8gZm9yIG5ldyB2cyBlc3RhYmxpc2hlZCBwbGF5ZXJzKVxyXG5leHBvcnQgZnVuY3Rpb24gZ2V0S0ZhY3RvcihwbGF5Q291bnQ6IG51bWJlcik6IG51bWJlciB7XHJcbiAgaWYgKHBsYXlDb3VudCA8IDMpIHJldHVybiAxMjtcclxuICBpZiAocGxheUNvdW50IDwgOCkgcmV0dXJuIDg7XHJcbiAgaWYgKHBsYXlDb3VudCA8IDE1KSByZXR1cm4gNjtcclxuICByZXR1cm4gNDtcclxufVxyXG5cclxuLyoqIFJhdGluZyB1c2VkIGluIEVMTyBtYXRoOiB0aGUgc3RvcmVkIHJhdGluZywgb3IgYHVucmF0ZWRSYXRpbmdgIGZvciB1bnJhdGVkIHNjZW5lcyAobWluIDEpLiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gZWZmZWN0aXZlUmF0aW5nKHJhdGluZzEwMDogbnVtYmVyIHwgbnVsbCB8IHVuZGVmaW5lZCwgdW5yYXRlZFJhdGluZzogbnVtYmVyKTogbnVtYmVyIHtcclxuICByZXR1cm4gcmF0aW5nMTAwIHx8IGNsYW1wUmF0aW5nKHVucmF0ZWRSYXRpbmcpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjbGFtcFJhdGluZyhyYXRpbmc6IG51bWJlcik6IG51bWJlciB7XHJcbiAgcmV0dXJuIE1hdGgubWluKE1BWF9SQVRJTkcsIE1hdGgubWF4KE1JTl9SQVRJTkcsIHJhdGluZykpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBleHBlY3RlZFNjb3JlKHJhdGluZ0E6IG51bWJlciwgcmF0aW5nQjogbnVtYmVyKTogbnVtYmVyIHtcclxuICBjb25zdCByYXRpbmdEaWZmID0gcmF0aW5nQiAtIHJhdGluZ0E7XHJcbiAgcmV0dXJuIDEgLyAoMSArIE1hdGgucG93KDEwLCByYXRpbmdEaWZmIC8gNDApKTtcclxufVxyXG5cclxuLyoqIFN0YW5kYXJkIHR3by1zaWRlZCBFTE8gZm9yIGEgaGVhZC10by1oZWFkIHdpbi4gUmV0dXJucyBlZmZlY3RpdmUgZGVsdGFzIChwb3N0LWNsYW1wKS4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGNhbGN1bGF0ZVJhdGluZ0NoYW5nZXMoaW5wdXQ6IENvbXBhcmlzb25JbnB1dCk6IENvbXBhcmlzb25EZWx0YXMge1xyXG4gIGNvbnN0IHsgd2lubmVyLCBsb3NlciB9ID0gaW5wdXQ7XHJcblxyXG4gIGNvbnN0IGV4cGVjdGVkID0gZXhwZWN0ZWRTY29yZSh3aW5uZXIucmF0aW5nLCBsb3Nlci5yYXRpbmcpO1xyXG4gIGNvbnN0IHdpbm5lckNoYW5nZSA9IE1hdGgubWF4KDEsIE1hdGgucm91bmQoZ2V0S0ZhY3Rvcih3aW5uZXIucGxheUNvdW50KSAqICgxIC0gZXhwZWN0ZWQpKSk7XHJcbiAgY29uc3QgbG9zZXJDaGFuZ2UgPSAtTWF0aC5tYXgoMSwgTWF0aC5yb3VuZChnZXRLRmFjdG9yKGxvc2VyLnBsYXlDb3VudCkgKiBleHBlY3RlZCkpO1xyXG5cclxuICBjb25zdCB3aW5uZXJOZXcgPSBjbGFtcFJhdGluZyh3aW5uZXIucmF0aW5nICsgd2lubmVyQ2hhbmdlKTtcclxuICBjb25zdCBsb3Nlck5ldyA9IGNsYW1wUmF0aW5nKGxvc2VyLnJhdGluZyArIGxvc2VyQ2hhbmdlKTtcclxuXHJcbiAgcmV0dXJuIHtcclxuICAgIHdpbm5lcjogd2lubmVyTmV3IC0gd2lubmVyLnJhdGluZyxcclxuICAgIGxvc2VyOiBsb3Nlck5ldyAtIGxvc2VyLnJhdGluZyxcclxuICB9O1xyXG59XHJcbiIsICIvLyBTUEEgbmF2aWdhdGlvbiBoZWxwZXJzLlxyXG5cclxuaW1wb3J0IHsgY2xvc2VNb2RhbCB9IGZyb20gXCIuL3VpL21vZGFsXCI7XHJcblxyXG4vLyBOYXZpZ2F0ZSB1c2luZyBSZWFjdCBSb3V0ZXIgKHByZXNlcnZlcyBKUyBzdGF0ZSlcclxuZXhwb3J0IGZ1bmN0aW9uIG5hdmlnYXRlVG9VcmwodXJsOiBzdHJpbmcpOiB2b2lkIHtcclxuICBjbG9zZU1vZGFsKCk7XHJcblxyXG4gIC8vIFVzZSBIaXN0b3J5IEFQSSArIHBvcHN0YXRlIGV2ZW50IHRvIHRyaWdnZXIgUmVhY3QgUm91dGVyIG5hdmlnYXRpb25cclxuICBjb25zdCBwYXRoID0gdXJsLnN0YXJ0c1dpdGgoXCIvXCIpID8gdXJsIDogbmV3IFVSTCh1cmwpLnBhdGhuYW1lICsgbmV3IFVSTCh1cmwpLnNlYXJjaDtcclxuICB3aW5kb3cuaGlzdG9yeS5wdXNoU3RhdGUoe30sIFwiXCIsIHBhdGgpO1xyXG4gIHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBQb3BTdGF0ZUV2ZW50KFwicG9wc3RhdGVcIiwgeyBzdGF0ZToge30gfSkpO1xyXG59XHJcbiIsICIvLyBNYXRjaG1ha2luZzogYnVpbGQgdGhlIHNjZW5lIHBhaXJzIGZvciBlYWNoIGNvbXBhcmlzb24gbW9kZS5cclxuXHJcbmltcG9ydCB7IGNsZWFyRmlsdGVyZWRDYWNoZSwgZ2V0QWxsU2NlbmVzQ2FjaGVkLCBnZXRGaWx0ZXJlZFNjZW5lc0NhY2hlZCwgc2FuZGJveFBvb2wgfSBmcm9tIFwiLi9jYWNoZVwiO1xyXG5pbXBvcnQgeyBDTElNQl9PUFBPTkVOVF9QSUNLX1dJTkRPVywgU1dJU1NfT1BQT05FTlRfUkVBQ0hfSU5JVElBTCwgU1dJU1NfT1BQT05FTlRfUkVBQ0hfTVVMVElQTElFUiB9IGZyb20gXCIuL2NvbnN0YW50c1wiO1xyXG5pbXBvcnQgeyBlZmZlY3RpdmVSYXRpbmcgfSBmcm9tIFwiLi9lbG9cIjtcclxuaW1wb3J0IHsgcmVhZEZpbHRlcnMsIHR5cGUgTGlzdEZpbHRlcnMgfSBmcm9tIFwiLi9maWx0ZXJzXCI7XHJcbmltcG9ydCB7IHVwZGF0ZVNjZW5lUmF0aW5nIH0gZnJvbSBcIi4vcmF0aW5nXCI7XHJcbmltcG9ydCB7IHN0YXRlIH0gZnJvbSBcIi4vc3RhdGVcIjtcclxuaW1wb3J0IHR5cGUge1xyXG4gIENoYW1waW9uUGFpclJlc3VsdCxcclxuICBHYXVudGxldFBhaXJSZXN1bHQsXHJcbiAgUGxhY2VtZW50UGFpclJlc3VsdCxcclxuICBQbGFjZW1lbnRSdW4sXHJcbiAgUmFuayxcclxuICBTY2VuZSxcclxuICBTd2lzc1BhaXJSZXN1bHQsXHJcbn0gZnJvbSBcIi4vdHlwZXNcIjtcclxuXHJcbmZ1bmN0aW9uIHNodWZmbGVBcnJheTxUPihhcnJheTogVFtdKTogVFtdIHtcclxuICBjb25zdCBzaHVmZmxlZCA9IFsuLi5hcnJheV07XHJcbiAgZm9yIChsZXQgaSA9IHNodWZmbGVkLmxlbmd0aCAtIDE7IGkgPiAwOyBpLS0pIHtcclxuICAgIGNvbnN0IGogPSBNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkgKiAoaSArIDEpKTtcclxuICAgIFtzaHVmZmxlZFtpXSwgc2h1ZmZsZWRbal1dID0gW3NodWZmbGVkW2pdLCBzaHVmZmxlZFtpXV07XHJcbiAgfVxyXG4gIHJldHVybiBzaHVmZmxlZDtcclxufVxyXG5cclxuLy8gVHJhY2sgbGFzdCBzY2VuZSB0byBhdm9pZCBpbW1lZGlhdGUgcmVwZWF0IGFmdGVyIHJlc2h1ZmZsZVxyXG5sZXQgbGFzdFNob3duU2NlbmVJZDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XHJcblxyXG4vKiogVHJ1ZSBvbmNlIGV2ZXJ5IHNjZW5lIGluIHRoZSBjdXJyZW50IHNodWZmbGUgaGFzIGJlZW4gc2hvd24gKHRpbWUgdG8gcmUtcXVlcnkgdGhlIGZpbHRlcikuICovXHJcbmZ1bmN0aW9uIGlzU2h1ZmZsZUN5Y2xlQ29tcGxldGUoZmlsdGVyS2V5OiBzdHJpbmcpOiBib29sZWFuIHtcclxuICByZXR1cm4gKFxyXG4gICAgc3RhdGUuc2h1ZmZsZUZpbHRlcktleSA9PT0gZmlsdGVyS2V5ICYmXHJcbiAgICBzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzLmxlbmd0aCA+IDAgJiZcclxuICAgIHN0YXRlLnNodWZmbGVJbmRleCA+PSBzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzLmxlbmd0aFxyXG4gICk7XHJcbn1cclxuXHJcbi8qKiBSZXNodWZmbGUgdGhlIGxlZnQgcG9vbCBmb3IgYSBuZXcgcGFzcywgd2l0aG91dCBzaG93aW5nIHRoZSBwcmV2aW91cyBwYXNzJ3MgbGFzdCBzY2VuZSBmaXJzdC4gKi9cclxuZnVuY3Rpb24gc3RhcnROZXdQYXNzKGxlZnRQb29sOiBTY2VuZVtdKTogdm9pZCB7XHJcbiAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5SAIFJlc2h1ZmZsaW5nIChjb21wbGV0ZWQgZnVsbCBjeWNsZSlcIik7XHJcbiAgc3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lcyA9IHNodWZmbGVBcnJheShsZWZ0UG9vbCk7XHJcbiAgc3RhdGUuc2h1ZmZsZUluZGV4ID0gMDtcclxuXHJcbiAgaWYgKFxyXG4gICAgbGFzdFNob3duU2NlbmVJZCAmJlxyXG4gICAgc3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lcy5sZW5ndGggPiAxICYmXHJcbiAgICBzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzWzBdLmlkID09PSBsYXN0U2hvd25TY2VuZUlkXHJcbiAgKSB7XHJcbiAgICBjb25zdCBzd2FwSWR4ID0gMSArIE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSAqIChzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzLmxlbmd0aCAtIDEpKTtcclxuICAgIFtzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzWzBdLCBzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzW3N3YXBJZHhdXSA9IFtcclxuICAgICAgc3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lc1tzd2FwSWR4XSxcclxuICAgICAgc3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lc1swXSxcclxuICAgIF07XHJcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCflIQgU3dhcHBlZCBmaXJzdCBzY2VuZSB0byBhdm9pZCByZXBlYXRcIik7XHJcbiAgfVxyXG59XHJcblxyXG4vKiogTmV4dCBsZWZ0LXNpZGUgc2NlbmUgZnJvbSB0aGUgc2h1ZmZsZWQgbGVmdCBwb29sIChubyBuZXR3b3JrIGZldGNoKS4gU2NlbmVzIHN0YXkgaW4gdGhlIHBvb2wuICovXHJcbmZ1bmN0aW9uIGdldE5leHRGaWx0ZXJlZFNjZW5lKGxlZnRQb29sOiBTY2VuZVtdLCBmaWx0ZXJLZXk6IHN0cmluZyk6IFNjZW5lIHwgbnVsbCB7XHJcbiAgaWYgKGxlZnRQb29sLmxlbmd0aCA9PT0gMCkge1xyXG4gICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn4+BIEZpbHRlcmVkIHBvb2wgaXMgZW1wdHlcIik7XHJcbiAgICByZXR1cm4gbnVsbDtcclxuICB9XHJcblxyXG4gIGlmIChmaWx0ZXJLZXkgIT09IHN0YXRlLnNodWZmbGVGaWx0ZXJLZXkgfHwgc3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lcy5sZW5ndGggPT09IDApIHtcclxuICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+UgCBTaHVmZmxpbmcgZmlsdGVyZWQgc2NlbmVzIChmaWx0ZXIgY2hhbmdlZCBvciBmaXJzdCBsb2FkKVwiKTtcclxuICAgIHN0YXRlLnNodWZmbGVkRmlsdGVyZWRTY2VuZXMgPSBzaHVmZmxlQXJyYXkobGVmdFBvb2wpO1xyXG4gICAgc3RhdGUuc2h1ZmZsZUluZGV4ID0gMDtcclxuICAgIHN0YXRlLnNodWZmbGVGaWx0ZXJLZXkgPSBmaWx0ZXJLZXk7XHJcbiAgICBsYXN0U2hvd25TY2VuZUlkID0gbnVsbDtcclxuICB9XHJcblxyXG4gIGlmIChzdGF0ZS5zaHVmZmxlSW5kZXggPj0gc3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lcy5sZW5ndGgpIHtcclxuICAgIHN0YXJ0TmV3UGFzcyhsZWZ0UG9vbCk7XHJcbiAgfVxyXG5cclxuICBjb25zdCBzY2VuZSA9IHN0YXRlLnNodWZmbGVkRmlsdGVyZWRTY2VuZXNbc3RhdGUuc2h1ZmZsZUluZGV4XTtcclxuICBzdGF0ZS5zaHVmZmxlSW5kZXgrKztcclxuICBsYXN0U2hvd25TY2VuZUlkID0gc2NlbmUuaWQ7XHJcbiAgY29uc29sZS5sb2coXHJcbiAgICBgW1N0YXNoIEJhdHRsZV0g8J+TjSBQaWNrZWQgc2NlbmUgJHtzY2VuZS5pZH0gKCR7c3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lcy5sZW5ndGggLSBzdGF0ZS5zaHVmZmxlSW5kZXh9IGxlZnQgaW4gdGhpcyBwYXNzKWAsXHJcbiAgKTtcclxuICByZXR1cm4gc2NlbmU7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGJ1aWxkT3Bwb25lbnRQb29sKGFsbFNjZW5lczogU2NlbmVbXSwgbGVmdFBvb2w6IFNjZW5lW10sIGZpbHRlcnM6IExpc3RGaWx0ZXJzKTogU2NlbmVbXSB7XHJcbiAgaWYgKHN0YXRlLnNldHRpbmdzLmZpbHRlck9wcG9uZW50cyAmJiBmaWx0ZXJzLmZpbHRlckFjdGl2ZSkge1xyXG4gICAgcmV0dXJuIGxlZnRQb29sO1xyXG4gIH1cclxuICBjb25zdCByYXRlZE9ubHkgPSBhbGxTY2VuZXMuZmlsdGVyKChzKSA9PiBzLnJhdGluZzEwMCAhPSBudWxsKTtcclxuICByZXR1cm4gcmF0ZWRPbmx5Lmxlbmd0aCA+PSAxID8gcmF0ZWRPbmx5IDogYWxsU2NlbmVzO1xyXG59XHJcblxyXG4vKiogTG9hZCB0aGUgbGVmdCAoXCJ0byByYXRlXCIpIGFuZCBmdWxsIHBvb2xzLiBJbiBmdW4gbW9kZSBib3RoIGFyZSBzYW5kYm94IGNvcGllcyAoc2VlIGNhY2hlLnRzKS4gKi9cclxuYXN5bmMgZnVuY3Rpb24gbG9hZFNjZW5lUG9vbHMoXHJcbiAgZmlsdGVyczogTGlzdEZpbHRlcnMsXHJcbik6IFByb21pc2U8eyBsZWZ0UG9vbDogU2NlbmVbXTsgYWxsU2NlbmVzOiBTY2VuZVtdIH0+IHtcclxuICBsZXQgbGVmdFBvb2w6IFNjZW5lW107XHJcbiAgbGV0IGFsbFNjZW5lczogU2NlbmVbXTtcclxuXHJcbiAgaWYgKGZpbHRlcnMuZmlsdGVyQWN0aXZlKSB7XHJcbiAgICAvLyBSZS1xdWVyeSB0aGUgZmlsdGVyIGFmdGVyIGVhY2ggZnVsbCBwYXNzIHNvIGZpbHRlcnMgbGlrZSBcInVucmF0ZWRcIiBzaHJpbmsgYXMgc2NlbmVzIGdldCByYXRlZFxyXG4gICAgY29uc3QgcGFzc0NvbXBsZXRlID0gaXNTaHVmZmxlQ3ljbGVDb21wbGV0ZShmaWx0ZXJzLmZpbHRlcktleSk7XHJcbiAgICBpZiAocGFzc0NvbXBsZXRlKSB7XHJcbiAgICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+UgSBQYXNzIGNvbXBsZXRlLCByZS1mZXRjaGluZyBmaWx0ZXJlZCBzY2VuZXNcIik7XHJcbiAgICAgIGF3YWl0IGNsZWFyRmlsdGVyZWRDYWNoZSgpO1xyXG4gICAgfVxyXG4gICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5OLIEZpbHRlciBhY3RpdmUsIGZldGNoaW5nIGZpbHRlcmVkICsgYWxsIHNjZW5lc1wiKTtcclxuICAgIGNvbnN0IFtmaWx0ZXJlZFJlc3VsdCwgYWxsUmVzdWx0XSA9IGF3YWl0IFByb21pc2UuYWxsKFtcclxuICAgICAgZ2V0RmlsdGVyZWRTY2VuZXNDYWNoZWQoZmlsdGVycyksXHJcbiAgICAgIGdldEFsbFNjZW5lc0NhY2hlZCgpLFxyXG4gICAgXSk7XHJcbiAgICBsZWZ0UG9vbCA9IGZpbHRlcmVkUmVzdWx0LnNjZW5lcyB8fCBbXTtcclxuICAgIGFsbFNjZW5lcyA9IGFsbFJlc3VsdC5zY2VuZXMgfHwgW107XHJcbiAgICAvLyBTdGFydCB0aGUgbmV4dCBwYXNzIG5vdywgc28gbGF0ZXIgbG9hZHMgaW4gYSBydW4gKHdoaWNoIHBpY2sgbm8gbmV3IGxlZnQgc2NlbmUpIGRvbid0XHJcbiAgICAvLyBzZWUgdGhlIHBhc3MgYXMgY29tcGxldGUgYW5kIHJlLWZldGNoIHRoZSBmaWx0ZXIgZXZlcnkgdGltZVxyXG4gICAgaWYgKHBhc3NDb21wbGV0ZSkgc3RhcnROZXdQYXNzKGxlZnRQb29sKTtcclxuICB9IGVsc2Uge1xyXG4gICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5OLIE5vIGZpbHRlciBhY3RpdmUsIHVzaW5nIGFsbCBzY2VuZXNcIik7XHJcbiAgICBhbGxTY2VuZXMgPSAoYXdhaXQgZ2V0QWxsU2NlbmVzQ2FjaGVkKCkpLnNjZW5lcyB8fCBbXTtcclxuICAgIGxlZnRQb29sID0gYWxsU2NlbmVzO1xyXG4gIH1cclxuXHJcbiAgc3RhdGUubGVmdFBvb2xTaXplID0gbGVmdFBvb2wubGVuZ3RoO1xyXG4gIGlmIChzdGF0ZS5zZXR0aW5ncy5mdW5Nb2RlKSB7XHJcbiAgICByZXR1cm4geyBsZWZ0UG9vbDogc2FuZGJveFBvb2wobGVmdFBvb2wpLCBhbGxTY2VuZXM6IHNhbmRib3hQb29sKGFsbFNjZW5lcykgfTtcclxuICB9XHJcbiAgcmV0dXJuIHsgbGVmdFBvb2wsIGFsbFNjZW5lcyB9O1xyXG59XHJcblxyXG4vKiogTG9hZCB0aGUgcG9vbHMgKHNlcnZlZCBmcm9tIGNhY2hlIHdoZW4gcG9zc2libGUpIGp1c3QgdG8gcmVjb3JkIHRoZSBsZWZ0IHBvb2wncyBzaXplLiAqL1xyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbG9hZFBvb2xTaXplKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gIGF3YWl0IGxvYWRTY2VuZVBvb2xzKHJlYWRGaWx0ZXJzKCkpO1xyXG59XHJcblxyXG4vKiogTG9hZCBsZWZ0IChzY2VuZSB0byByYXRlKSBhbmQgcmlnaHQgKG9wcG9uZW50KSBwb29scyBmb3IgU3dpc3MuICovXHJcbmFzeW5jIGZ1bmN0aW9uIGJ1aWxkU3dpc3NQb29scygpOiBQcm9taXNlPHtcclxuICBsZWZ0UG9vbDogU2NlbmVbXTtcclxuICByaWdodFBvb2w6IFNjZW5lW107XHJcbiAgZmlsdGVyS2V5OiBzdHJpbmc7XHJcbn0+IHtcclxuICBjb25zdCBmaWx0ZXJzID0gcmVhZEZpbHRlcnMoKTtcclxuICBjb25zdCB7IGxlZnRQb29sLCBhbGxTY2VuZXMgfSA9IGF3YWl0IGxvYWRTY2VuZVBvb2xzKGZpbHRlcnMpO1xyXG5cclxuICBpZiAoYWxsU2NlbmVzLmxlbmd0aCA8IDIpIHtcclxuICAgIHRocm93IG5ldyBFcnJvcihcIk5vdCBlbm91Z2ggc2NlbmVzIGZvciBjb21wYXJpc29uLlwiKTtcclxuICB9XHJcblxyXG4gIGNvbnN0IHJpZ2h0UG9vbCA9IGJ1aWxkT3Bwb25lbnRQb29sKGFsbFNjZW5lcywgbGVmdFBvb2wsIGZpbHRlcnMpO1xyXG4gIGlmIChzdGF0ZS5zZXR0aW5ncy5maWx0ZXJPcHBvbmVudHMgJiYgZmlsdGVycy5maWx0ZXJBY3RpdmUgJiYgcmlnaHRQb29sLmxlbmd0aCA8IDIpIHtcclxuICAgIHRocm93IG5ldyBFcnJvcihcIk5vdCBlbm91Z2ggc2NlbmVzIGluIHlvdXIgZmlsdGVyIGZvciBhIG1hdGNoLiBZb3UgbmVlZCBhdCBsZWFzdCAyIHNjZW5lcy5cIik7XHJcbiAgfVxyXG5cclxuICByZXR1cm4geyBsZWZ0UG9vbCwgcmlnaHRQb29sLCBmaWx0ZXJLZXk6IGZpbHRlcnMuZmlsdGVyS2V5IH07XHJcbn1cclxuXHJcbi8qKiBJbmRleCB3aGVyZSBhIHNjZW5lIHdpdGggdGhpcyByYXRpbmcgd291bGQgc2l0IGluIGEgcmF0aW5nLXNvcnRlZCAoREVTQykgcG9vbC4gKi9cclxuZnVuY3Rpb24gaW5zZXJ0aW9uSW5kZXgocG9vbDogU2NlbmVbXSwgcmF0aW5nOiBudW1iZXIpOiBudW1iZXIge1xyXG4gIGNvbnN0IGlkeCA9IHBvb2wuZmluZEluZGV4KChzKSA9PiAocy5yYXRpbmcxMDAgPz8gMCkgPCByYXRpbmcpO1xyXG4gIHJldHVybiBpZHggPT09IC0xID8gcG9vbC5sZW5ndGggOiBpZHg7XHJcbn1cclxuXHJcbi8vIFN3aXNzIG1vZGU6IGxlZnQgPSBzY2VuZSB0byByYXRlIChmaWx0ZXJlZCBwb29sKSwgcmlnaHQgPSBzaW1pbGFyLXN0cmVuZ3RoIG9wcG9uZW50XHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBmZXRjaFN3aXNzUGFpcihmb3JjZWRMZWZ0U2NlbmU6IFNjZW5lIHwgbnVsbCA9IG51bGwpOiBQcm9taXNlPFN3aXNzUGFpclJlc3VsdD4ge1xyXG4gIGNvbnN0IHsgbGVmdFBvb2wsIHJpZ2h0UG9vbCwgZmlsdGVyS2V5IH0gPSBhd2FpdCBidWlsZFN3aXNzUG9vbHMoKTtcclxuXHJcbiAgY29uc3Qgc2NlbmUxID0gZm9yY2VkTGVmdFNjZW5lIHx8IGdldE5leHRGaWx0ZXJlZFNjZW5lKGxlZnRQb29sLCBmaWx0ZXJLZXkpO1xyXG4gIGlmICghc2NlbmUxKSB7XHJcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJObyBzY2VuZXMgbWF0Y2ggeW91ciBmaWx0ZXIgY3JpdGVyaWEuXCIpO1xyXG4gIH1cclxuXHJcbiAgY29uc3QgeyBzY2VuZTIsIHJhbmtzIH0gPSBwaWNrU3dpc3NPcHBvbmVudChzY2VuZTEsIHJpZ2h0UG9vbCk7XHJcbiAgcmV0dXJuIHsgc2NlbmVzOiBbc2NlbmUxLCBzY2VuZTJdLCByYW5rcyB9O1xyXG59XHJcblxyXG4vKiogUGljayBhIHJhbmRvbSBvcHBvbmVudCBuZWFyIHNjZW5lMSdzIHJhbmsgaW4gdGhlIHJhdGluZy1zb3J0ZWQgcmlnaHQgcG9vbCAoZXhwYW5kaW5nIGJhbmQgaWYgbmVlZGVkKS4gKi9cclxuZnVuY3Rpb24gcGlja1N3aXNzT3Bwb25lbnQoXHJcbiAgc2NlbmUxOiBTY2VuZSxcclxuICByaWdodFBvb2w6IFNjZW5lW10sXHJcbik6IHsgc2NlbmUyOiBTY2VuZTsgcmFua3M6IFtSYW5rLCBSYW5rXSB9IHtcclxuICBjb25zdCBzY2VuZTFJZHhJblBvb2wgPSByaWdodFBvb2wuZmluZEluZGV4KChzKSA9PiBzLmlkID09PSBzY2VuZTEuaWQpO1xyXG4gIC8vIFJhdGVkIHNjZW5lcyBtYXRjaCBhcm91bmQgdGhlaXIgb3duIHJhbms7IHVucmF0ZWQgb25lcyBhcm91bmQgd2hlcmUgYHVucmF0ZWRSYXRpbmdgIHdvdWxkIHNpdFxyXG4gIGNvbnN0IGVmZmVjdGl2ZVNjZW5lMUlkeCA9XHJcbiAgICBzY2VuZTEucmF0aW5nMTAwICYmIHNjZW5lMUlkeEluUG9vbCA+PSAwXHJcbiAgICAgID8gc2NlbmUxSWR4SW5Qb29sXHJcbiAgICAgIDogaW5zZXJ0aW9uSW5kZXgocmlnaHRQb29sLCBlZmZlY3RpdmVSYXRpbmcoc2NlbmUxLnJhdGluZzEwMCwgc3RhdGUuc2V0dGluZ3MudW5yYXRlZFJhdGluZykpO1xyXG4gIGNvbnN0IHNjZW5lMVJhbmtJblBvb2wgPSBzY2VuZTFJZHhJblBvb2wgPj0gMCA/IHNjZW5lMUlkeEluUG9vbCArIDEgOiBudWxsO1xyXG5cclxuICBjb25zdCBjYW5kaWRhdGVzOiB7IHNjZW5lOiBTY2VuZTsgaWR4OiBudW1iZXIgfVtdID0gW107XHJcbiAgLy8gUHJlZmVyIHNpbWlsYXItc3RyZW5ndGggbWF0Y2h1cHMgKMKxcmVhY2ggcmFua3MpLiBJZiB0aGUgYmFuZCBpcyBlbXB0eSAoZWRnZXMsIHVucmF0ZWQgbGVmdFxyXG4gIC8vIHNjZW5lLCB0aW55IHBvb2wpLCBkb3VibGUgcmVhY2ggdW50aWwgd2UgZmluZCBjYW5kaWRhdGVzIG9yIGNvdmVyIHRoZSB3aG9sZSBwb29sLlxyXG4gIGZvciAoXHJcbiAgICBsZXQgcmVhY2ggPSBNYXRoLm1pbihTV0lTU19PUFBPTkVOVF9SRUFDSF9JTklUSUFMLCByaWdodFBvb2wubGVuZ3RoKTtcclxuICAgIGNhbmRpZGF0ZXMubGVuZ3RoID09PSAwICYmIHJlYWNoIDw9IHJpZ2h0UG9vbC5sZW5ndGg7XHJcbiAgICByZWFjaCA9IE1hdGgubWluKHJlYWNoICogU1dJU1NfT1BQT05FTlRfUkVBQ0hfTVVMVElQTElFUiwgcmlnaHRQb29sLmxlbmd0aClcclxuICApIHtcclxuICAgIGZvciAobGV0IGkgPSBlZmZlY3RpdmVTY2VuZTFJZHggLSByZWFjaDsgaSA8PSBlZmZlY3RpdmVTY2VuZTFJZHggKyByZWFjaDsgaSsrKSB7XHJcbiAgICAgIGlmIChpID49IDAgJiYgaSA8IHJpZ2h0UG9vbC5sZW5ndGggJiYgaSAhPT0gc2NlbmUxSWR4SW5Qb29sKSB7XHJcbiAgICAgICAgY2FuZGlkYXRlcy5wdXNoKHsgc2NlbmU6IHJpZ2h0UG9vbFtpXSwgaWR4OiBpIH0pO1xyXG4gICAgICB9XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICBpZiAoY2FuZGlkYXRlcy5sZW5ndGggPT09IDApIHtcclxuICAgIHRocm93IG5ldyBFcnJvcihcIk5vdCBlbm91Z2ggc2NlbmVzIGZvciBjb21wYXJpc29uLiBZb3UgbmVlZCBhdCBsZWFzdCAyIHNjZW5lcy5cIik7XHJcbiAgfVxyXG5cclxuICBjb25zdCBwaWNrID0gY2FuZGlkYXRlc1tNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkgKiBjYW5kaWRhdGVzLmxlbmd0aCldO1xyXG4gIHJldHVybiB7XHJcbiAgICBzY2VuZTI6IHBpY2suc2NlbmUsXHJcbiAgICByYW5rczogW3NjZW5lMVJhbmtJblBvb2wsIHBpY2suaWR4ICsgMV0sXHJcbiAgfTtcclxufVxyXG5cclxuLyoqIFJhbmRvbSBwaWNrIGZyb20gdGhlIE4gdW5kZWZlYXRlZCBvcHBvbmVudHMgY2xvc2VzdCBhYm92ZSB0aGUgY2xpbWJlciAobGlzdCBpcyByYXRpbmctc29ydGVkIERFU0MpLiAqL1xyXG5mdW5jdGlvbiBwaWNrQ2xvc2VzdENsaW1iT3Bwb25lbnQocmVtYWluaW5nT3Bwb25lbnRzOiBTY2VuZVtdKTogU2NlbmUge1xyXG4gIGNvbnN0IGNsb3Nlc3QgPSByZW1haW5pbmdPcHBvbmVudHMuc2xpY2UoLUNMSU1CX09QUE9ORU5UX1BJQ0tfV0lORE9XKTtcclxuICByZXR1cm4gY2xvc2VzdFtNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkgKiBjbG9zZXN0Lmxlbmd0aCldO1xyXG59XHJcblxyXG4vKiogVW5kZWZlYXRlZCBvcHBvbmVudHMgYWJvdmUgdGhlIGNsaW1iZXIgaW4gdGhlIHJhdGluZy1zb3J0ZWQgcmlnaHQgcG9vbC4gKi9cclxuZnVuY3Rpb24gZ2V0UmVtYWluaW5nQ2xpbWJPcHBvbmVudHMoXHJcbiAgY2xpbWJlcjogU2NlbmUsXHJcbiAgcmlnaHRQb29sOiBTY2VuZVtdLFxyXG4gIGNsaW1iZXJJbmRleDogbnVtYmVyLFxyXG4pOiBTY2VuZVtdIHtcclxuICByZXR1cm4gcmlnaHRQb29sLmZpbHRlcigocywgaWR4KSA9PiB7XHJcbiAgICBpZiAocy5pZCA9PT0gY2xpbWJlci5pZCB8fCBzdGF0ZS5nYXVudGxldERlZmVhdGVkLmluY2x1ZGVzKHMuaWQpKSByZXR1cm4gZmFsc2U7XHJcbiAgICByZXR1cm4gaWR4IDwgY2xpbWJlckluZGV4IHx8IChzLnJhdGluZzEwMCB8fCAwKSA+PSAoY2xpbWJlci5yYXRpbmcxMDAgfHwgMCk7XHJcbiAgfSk7XHJcbn1cclxuXHJcbmFzeW5jIGZ1bmN0aW9uIGdldENsaW1iT3Bwb25lbnRQb29sKCk6IFByb21pc2U8U2NlbmVbXT4ge1xyXG4gIGNvbnN0IGZpbHRlcnMgPSByZWFkRmlsdGVycygpO1xyXG4gIGNvbnN0IHsgbGVmdFBvb2wsIGFsbFNjZW5lcyB9ID0gYXdhaXQgbG9hZFNjZW5lUG9vbHMoZmlsdGVycyk7XHJcbiAgcmV0dXJuIGJ1aWxkT3Bwb25lbnRQb29sKGFsbFNjZW5lcywgbGVmdFBvb2wsIGZpbHRlcnMpO1xyXG59XHJcblxyXG4vKiogQXBwbHkgRUxPIGZyb20gYSBjbGltYmVyIHdpbjsgYnVtcCBhYm92ZSB0aGUgYmVhdGVuIG9wcG9uZW50IHdoZW4gdGhlIHBvb2wgaXMgY2xlYXJlZC4gKi9cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGFwcGx5Q2xpbWJXaW5SYXRpbmcoXHJcbiAgY2xpbWJlcjogU2NlbmUsXHJcbiAgYmVhdGVuT3Bwb25lbnQ6IFNjZW5lLFxyXG4gIGVsb1JhdGluZzogbnVtYmVyLFxyXG4pOiBQcm9taXNlPG51bWJlcj4ge1xyXG4gIGNsaW1iZXIucmF0aW5nMTAwID0gZWxvUmF0aW5nO1xyXG5cclxuICBjb25zdCByaWdodFBvb2wgPSBhd2FpdCBnZXRDbGltYk9wcG9uZW50UG9vbCgpO1xyXG4gIGNvbnN0IGNsaW1iZXJJbmRleCA9IHJpZ2h0UG9vbC5maW5kSW5kZXgoKHMpID0+IHMuaWQgPT09IGNsaW1iZXIuaWQpO1xyXG4gIC8vIElmIHRoZSBjbGltYmVyIGhhcyByZW1haW5pbmcgb3Bwb25lbnRzIHJldHVybiBFTE8gcmF0aW5nIGFzIG5vcm1hbFxyXG4gIGlmIChnZXRSZW1haW5pbmdDbGltYk9wcG9uZW50cyhjbGltYmVyLCByaWdodFBvb2wsIGNsaW1iZXJJbmRleCkubGVuZ3RoID4gMCkge1xyXG4gICAgcmV0dXJuIGVsb1JhdGluZztcclxuICB9XHJcblxyXG4gIC8vIElmIHRoZSBjbGltYmVyIGhhcyBubyByZW1haW5pbmcgb3Bwb25lbnRzLCBlbnN1cmUgdGhlaXIgcmF0aW5nIGlzIGFib3ZlIHRoZSBvcHBvbmVudCB0aGV5IGp1c3QgYmVhdFxyXG4gIGNvbnN0IG1pbldpbm5lclJhdGluZyA9IE1hdGgubWluKDEwMCwgKGJlYXRlbk9wcG9uZW50LnJhdGluZzEwMCA/PyAwKSArIDEpO1xyXG4gIGlmIChlbG9SYXRpbmcgPCBtaW5XaW5uZXJSYXRpbmcpIHtcclxuICAgIGF3YWl0IHVwZGF0ZVNjZW5lUmF0aW5nKGNsaW1iZXIuaWQsIG1pbldpbm5lclJhdGluZyk7XHJcbiAgICBjbGltYmVyLnJhdGluZzEwMCA9IG1pbldpbm5lclJhdGluZztcclxuICB9XHJcbiAgcmV0dXJuIGNsaW1iZXIucmF0aW5nMTAwID8/IGVsb1JhdGluZztcclxufVxyXG5cclxuLy8gRmluZCB0aGUgbG93ZXN0IGFjdHVhbGx5IHJhdGVkIHNjZW5lIGluIGEgZGVzY2VuZGluZy1zb3J0ZWQgYXJyYXksIGV4Y2x1ZGluZyBhIHNwZWNpZmljIHNjZW5lXHJcbi8vIFJldHVybnMgeyBzY2VuZSwgaW5kZXggfSBvciBmYWxsYmFjayB0byBmaXJzdCBub24tZXhjbHVkZWQgc2NlbmUgaWYgbm9uZSByYXRlZFxyXG5mdW5jdGlvbiBmaW5kTG93ZXN0UmF0ZWQoc2NlbmVzOiBTY2VuZVtdLCBleGNsdWRlSWQ6IHN0cmluZyk6IHsgc2NlbmU6IFNjZW5lOyBpbmRleDogbnVtYmVyIH0ge1xyXG4gIGZvciAobGV0IGkgPSBzY2VuZXMubGVuZ3RoIC0gMTsgaSA+PSAwOyBpLS0pIHtcclxuICAgIGNvbnN0IHMgPSBzY2VuZXNbaV07XHJcbiAgICBpZiAocy5pZCAhPT0gZXhjbHVkZUlkICYmIHMucmF0aW5nMTAwICE9IG51bGwpIHtcclxuICAgICAgcmV0dXJuIHsgc2NlbmU6IHMsIGluZGV4OiBpIH07XHJcbiAgICB9XHJcbiAgfVxyXG4gIC8vIEZhbGxiYWNrIHRvIGFueSBzY2VuZSBpZiBub25lIHJhdGVkXHJcbiAgY29uc3QgZmFsbGJhY2tJbmRleCA9IHNjZW5lcy5maW5kSW5kZXgoKHMpID0+IHMuaWQgIT09IGV4Y2x1ZGVJZCk7XHJcbiAgcmV0dXJuIHsgc2NlbmU6IHNjZW5lc1tmYWxsYmFja0luZGV4XSwgaW5kZXg6IGZhbGxiYWNrSW5kZXggfTtcclxufVxyXG5cclxuLy8gR2F1bnRsZXQgbW9kZTogY2hhbXBpb24gdnMgbmV4dCBjaGFsbGVuZ2VyXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBmZXRjaEdhdW50bGV0UGFpcihcclxuICBmb3JjZWRMZWZ0U2NlbmU6IFNjZW5lIHwgbnVsbCA9IG51bGwsXHJcbik6IFByb21pc2U8R2F1bnRsZXRQYWlyUmVzdWx0PiB7XHJcbiAgY29uc3QgZmlsdGVycyA9IHJlYWRGaWx0ZXJzKCk7XHJcblxyXG4gIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+TiyBGZXRjaGluZyBzY2VuZXMgZm9yIGdhdW50bGV0Li4uXCIpO1xyXG4gIGNvbnN0IHsgbGVmdFBvb2wsIGFsbFNjZW5lcyB9ID0gYXdhaXQgbG9hZFNjZW5lUG9vbHMoZmlsdGVycyk7XHJcblxyXG4gIGxldCByaWdodFBvb2wgPSBidWlsZE9wcG9uZW50UG9vbChhbGxTY2VuZXMsIGxlZnRQb29sLCBmaWx0ZXJzKTtcclxuICBzdGF0ZS50b3RhbFNjZW5lc0NvdW50ID0gcmlnaHRQb29sLmxlbmd0aDtcclxuXHJcbiAgaWYgKGFsbFNjZW5lcy5sZW5ndGggPCAyKSB7XHJcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJOb3QgZW5vdWdoIHNjZW5lcyBmb3IgY29tcGFyaXNvbi5cIik7XHJcbiAgfVxyXG5cclxuICAvLyBIYW5kbGUgZmFsbGluZyBtb2RlIC0gZmluZCBuZXh0IG9wcG9uZW50IEJFTE9XIHRvIHRlc3QgYWdhaW5zdCAoZnJvbSBmdWxsIGNvbGxlY3Rpb24pXHJcbiAgaWYgKHN0YXRlLmdhdW50bGV0RmFsbGluZyAmJiBzdGF0ZS5nYXVudGxldEZhbGxpbmdTY2VuZSkge1xyXG4gICAgY29uc3QgZmFsbGluZ1NjZW5lID0gc3RhdGUuZ2F1bnRsZXRGYWxsaW5nU2NlbmU7XHJcbiAgICBjb25zdCBmYWxsaW5nSW5kZXggPSByaWdodFBvb2wuZmluZEluZGV4KChzKSA9PiBzLmlkID09PSBmYWxsaW5nU2NlbmUuaWQpO1xyXG5cclxuICAgIGNvbnN0IGJlbG93T3Bwb25lbnRzID0gcmlnaHRQb29sLmZpbHRlcigocywgaWR4KSA9PiB7XHJcbiAgICAgIGlmIChzLmlkID09PSBmYWxsaW5nU2NlbmUuaWQgfHwgc3RhdGUuZ2F1bnRsZXREZWZlYXRlZC5pbmNsdWRlcyhzLmlkKSkgcmV0dXJuIGZhbHNlO1xyXG4gICAgICByZXR1cm4gaWR4ID4gZmFsbGluZ0luZGV4OyAvLyBCZWxvdyBpbiByYW5raW5nXHJcbiAgICB9KTtcclxuXHJcbiAgICBpZiAoYmVsb3dPcHBvbmVudHMubGVuZ3RoID09PSAwKSB7XHJcbiAgICAgIC8vIEhpdCB0aGUgYm90dG9tIC0gcGxhY2UgMSBiZWxvdyB0aGUgbGFzdCBvcHBvbmVudCB0aGF0IGJlYXQgdGhlbVxyXG4gICAgICBjb25zdCBmaW5hbFJhbmsgPSByaWdodFBvb2wubGVuZ3RoO1xyXG4gICAgICBjb25zdCBsYXN0RGVmZWF0ZWRCeUlkID0gc3RhdGUuZ2F1bnRsZXREZWZlYXRlZFtzdGF0ZS5nYXVudGxldERlZmVhdGVkLmxlbmd0aCAtIDFdO1xyXG4gICAgICBjb25zdCBsYXN0T3Bwb25lbnQgPSByaWdodFBvb2wuZmluZCgocykgPT4gcy5pZCA9PT0gbGFzdERlZmVhdGVkQnlJZCk7XHJcbiAgICAgIGNvbnN0IGZpbmFsUmF0aW5nID0gTWF0aC5tYXgoMSwgKGxhc3RPcHBvbmVudD8ucmF0aW5nMTAwIHx8IDEpIC0gMSk7XHJcbiAgICAgIHVwZGF0ZVNjZW5lUmF0aW5nKGZhbGxpbmdTY2VuZS5pZCwgZmluYWxSYXRpbmcpO1xyXG5cclxuICAgICAgcmV0dXJuIHtcclxuICAgICAgICBzY2VuZXM6IFtmYWxsaW5nU2NlbmVdLFxyXG4gICAgICAgIHJhbmtzOiBbZmluYWxSYW5rXSxcclxuICAgICAgICBpc1ZpY3Rvcnk6IGZhbHNlLFxyXG4gICAgICAgIGlzRmFsbGluZzogdHJ1ZSxcclxuICAgICAgICBpc1BsYWNlbWVudDogdHJ1ZSxcclxuICAgICAgICBwbGFjZW1lbnRSYW5rOiBmaW5hbFJhbmssXHJcbiAgICAgICAgcGxhY2VtZW50UmF0aW5nOiBmaW5hbFJhdGluZyxcclxuICAgICAgfTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgIC8vIEdldCBuZXh0IG9wcG9uZW50IGJlbG93IChmaXJzdCBvbmUsIGNsb3Nlc3QgdG8gZmFsbGluZyBzY2VuZSlcclxuICAgICAgY29uc3QgbmV4dEJlbG93ID0gYmVsb3dPcHBvbmVudHNbMF07XHJcbiAgICAgIGNvbnN0IG5leHRCZWxvd0luZGV4ID0gcmlnaHRQb29sLmZpbmRJbmRleCgocykgPT4gcy5pZCA9PT0gbmV4dEJlbG93LmlkKTtcclxuXHJcbiAgICAgIC8vIFVwZGF0ZSB0aGUgZmFsbGluZyBzY2VuZSdzIHJhbmsgZm9yIGRpc3BsYXlcclxuICAgICAgc3RhdGUuZ2F1bnRsZXRDbGltYmVyUmFuayA9IGZhbGxpbmdJbmRleCArIDE7XHJcblxyXG4gICAgICByZXR1cm4ge1xyXG4gICAgICAgIHNjZW5lczogW2ZhbGxpbmdTY2VuZSwgbmV4dEJlbG93XSxcclxuICAgICAgICByYW5rczogW2ZhbGxpbmdJbmRleCArIDEsIG5leHRCZWxvd0luZGV4ICsgMV0sXHJcbiAgICAgICAgaXNWaWN0b3J5OiBmYWxzZSxcclxuICAgICAgICBpc0ZhbGxpbmc6IHRydWUsXHJcbiAgICAgIH07XHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICAvLyBJZiBubyBjbGltYmVyIHlldCwgcGljayBmcm9tIGZpbHRlcmVkIHBvb2wgdG8gc3RhcnRcclxuICBpZiAoIXN0YXRlLmdhdW50bGV0Q2xpbWJlcikge1xyXG4gICAgc3RhdGUuZ2F1bnRsZXREZWZlYXRlZCA9IFtdO1xyXG4gICAgc3RhdGUuZ2F1bnRsZXRGYWxsaW5nID0gZmFsc2U7XHJcbiAgICBzdGF0ZS5nYXVudGxldEZhbGxpbmdTY2VuZSA9IG51bGw7XHJcblxyXG4gICAgY29uc3QgY2hhbGxlbmdlciA9IGZvcmNlZExlZnRTY2VuZSB8fCBnZXROZXh0RmlsdGVyZWRTY2VuZShsZWZ0UG9vbCwgZmlsdGVycy5maWx0ZXJLZXkpO1xyXG5cclxuICAgIGlmICghY2hhbGxlbmdlcikge1xyXG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJObyBzY2VuZXMgbWF0Y2ggeW91ciBmaWx0ZXIgY3JpdGVyaWEuXCIpO1xyXG4gICAgfVxyXG5cclxuICAgIGNvbnN0IGNoYWxsZW5nZXJJbmRleCA9IHJpZ2h0UG9vbC5maW5kSW5kZXgoKHMpID0+IHMuaWQgPT09IGNoYWxsZW5nZXIuaWQpO1xyXG5cclxuICAgIC8vIFN0YXJ0IGF0IHRoZSBib3R0b20gLSBmaW5kIGxvd2VzdCByYXRlZCBzY2VuZSBpbiByaWdodFBvb2xcclxuICAgIGNvbnN0IHsgc2NlbmU6IGxvd2VzdFJhdGVkLCBpbmRleDogbG93ZXN0SW5kZXggfSA9IGZpbmRMb3dlc3RSYXRlZChyaWdodFBvb2wsIGNoYWxsZW5nZXIuaWQpO1xyXG5cclxuICAgIHN0YXRlLmdhdW50bGV0Q2xpbWJlclJhbmsgPSBjaGFsbGVuZ2VySW5kZXggPj0gMCA/IGNoYWxsZW5nZXJJbmRleCArIDEgOiByaWdodFBvb2wubGVuZ3RoO1xyXG5cclxuICAgIHJldHVybiB7XHJcbiAgICAgIHNjZW5lczogW2NoYWxsZW5nZXIsIGxvd2VzdFJhdGVkXSxcclxuICAgICAgcmFua3M6IFtzdGF0ZS5nYXVudGxldENsaW1iZXJSYW5rLCBsb3dlc3RJbmRleCArIDFdLFxyXG4gICAgICBpc1ZpY3Rvcnk6IGZhbHNlLFxyXG4gICAgICBpc0ZhbGxpbmc6IGZhbHNlLFxyXG4gICAgfTtcclxuICB9XHJcblxyXG4gIGNvbnN0IGNsaW1iZXIgPSBzdGF0ZS5nYXVudGxldENsaW1iZXI7XHJcbiAgY29uc3QgY2xpbWJlckluZGV4ID0gcmlnaHRQb29sLmZpbmRJbmRleCgocykgPT4gcy5pZCA9PT0gY2xpbWJlci5pZCk7XHJcblxyXG4gIHN0YXRlLmdhdW50bGV0Q2xpbWJlclJhbmsgPSBjbGltYmVySW5kZXggPj0gMCA/IGNsaW1iZXJJbmRleCArIDEgOiAxO1xyXG5cclxuICBjb25zdCByZW1haW5pbmdPcHBvbmVudHMgPSBnZXRSZW1haW5pbmdDbGltYk9wcG9uZW50cyhjbGltYmVyLCByaWdodFBvb2wsIGNsaW1iZXJJbmRleCk7XHJcblxyXG4gIC8vIElmIG5vIG9wcG9uZW50cyBsZWZ0LCB0aGUgY2xpbWJlciBoYXMgY29ucXVlcmVkIHRoZSBsYWRkZXJcclxuICBpZiAocmVtYWluaW5nT3Bwb25lbnRzLmxlbmd0aCA9PT0gMCkge1xyXG4gICAgc3RhdGUuZ2F1bnRsZXRDbGltYmVyUmFuayA9IDE7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICBzY2VuZXM6IFtjbGltYmVyXSxcclxuICAgICAgcmFua3M6IFsxXSxcclxuICAgICAgaXNWaWN0b3J5OiB0cnVlLFxyXG4gICAgICBpc0ZhbGxpbmc6IGZhbHNlLFxyXG4gICAgfTtcclxuICB9XHJcblxyXG4gIGNvbnN0IG5leHRPcHBvbmVudCA9IHBpY2tDbG9zZXN0Q2xpbWJPcHBvbmVudChyZW1haW5pbmdPcHBvbmVudHMpO1xyXG4gIGNvbnN0IG5leHRPcHBvbmVudEluZGV4ID0gcmlnaHRQb29sLmZpbmRJbmRleCgocykgPT4gcy5pZCA9PT0gbmV4dE9wcG9uZW50LmlkKTtcclxuXHJcbiAgcmV0dXJuIHtcclxuICAgIHNjZW5lczogW2NsaW1iZXIsIG5leHRPcHBvbmVudF0sXHJcbiAgICByYW5rczogW2NsaW1iZXJJbmRleCA+PSAwID8gY2xpbWJlckluZGV4ICsgMSA6IG51bGwsIG5leHRPcHBvbmVudEluZGV4ICsgMV0sXHJcbiAgICBpc1ZpY3Rvcnk6IGZhbHNlLFxyXG4gICAgaXNGYWxsaW5nOiBmYWxzZSxcclxuICB9O1xyXG59XHJcblxyXG4vLyBDaGFtcGlvbiBtb2RlOiBsaWtlIGdhdW50bGV0IGJ1dCB3aW5uZXIgc3RheXMgb24gKG5vIGZhbGxpbmcpXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBmZXRjaENoYW1waW9uUGFpcihcclxuICBmb3JjZWRMZWZ0U2NlbmU6IFNjZW5lIHwgbnVsbCA9IG51bGwsXHJcbik6IFByb21pc2U8Q2hhbXBpb25QYWlyUmVzdWx0PiB7XHJcbiAgY29uc3QgZmlsdGVycyA9IHJlYWRGaWx0ZXJzKCk7XHJcblxyXG4gIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+TiyBGZXRjaGluZyBzY2VuZXMgZm9yIGNoYW1waW9uLi4uXCIpO1xyXG4gIGNvbnN0IHsgbGVmdFBvb2wsIGFsbFNjZW5lcyB9ID0gYXdhaXQgbG9hZFNjZW5lUG9vbHMoZmlsdGVycyk7XHJcblxyXG4gIGxldCByaWdodFBvb2wgPSBidWlsZE9wcG9uZW50UG9vbChhbGxTY2VuZXMsIGxlZnRQb29sLCBmaWx0ZXJzKTtcclxuICBzdGF0ZS50b3RhbFNjZW5lc0NvdW50ID0gcmlnaHRQb29sLmxlbmd0aDtcclxuXHJcbiAgaWYgKGFsbFNjZW5lcy5sZW5ndGggPCAyKSB7XHJcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJOb3QgZW5vdWdoIHNjZW5lcyBmb3IgY29tcGFyaXNvbi5cIik7XHJcbiAgfVxyXG5cclxuICAvLyBJZiBubyBjbGltYmVyIHlldCwgcGljayBmcm9tIGZpbHRlcmVkIHBvb2wgdG8gc3RhcnRcclxuICBpZiAoIXN0YXRlLmdhdW50bGV0Q2xpbWJlcikge1xyXG4gICAgc3RhdGUuZ2F1bnRsZXREZWZlYXRlZCA9IFtdO1xyXG5cclxuICAgIGlmICghZm9yY2VkTGVmdFNjZW5lICYmIGxlZnRQb29sLmxlbmd0aCA8IDEpIHtcclxuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiTm8gc2NlbmVzIG1hdGNoIHlvdXIgZmlsdGVyIGNyaXRlcmlhLlwiKTtcclxuICAgIH1cclxuXHJcbiAgICBjb25zdCBjaGFsbGVuZ2VyID0gZm9yY2VkTGVmdFNjZW5lIHx8IGdldE5leHRGaWx0ZXJlZFNjZW5lKGxlZnRQb29sLCBmaWx0ZXJzLmZpbHRlcktleSk7XHJcblxyXG4gICAgaWYgKCFjaGFsbGVuZ2VyKSB7XHJcbiAgICAgIHRocm93IG5ldyBFcnJvcihcIk5vIHNjZW5lcyBtYXRjaCB5b3VyIGZpbHRlciBjcml0ZXJpYS5cIik7XHJcbiAgICB9XHJcblxyXG4gICAgY29uc3QgY2hhbGxlbmdlckluZGV4ID0gcmlnaHRQb29sLmZpbmRJbmRleCgocykgPT4gcy5pZCA9PT0gY2hhbGxlbmdlci5pZCk7XHJcblxyXG4gICAgLy8gU3RhcnQgYXQgdGhlIGJvdHRvbSAtIGZpbmQgbG93ZXN0IGFjdHVhbGx5IHJhdGVkIHNjZW5lXHJcbiAgICBjb25zdCB7IHNjZW5lOiBsb3dlc3RSYXRlZCwgaW5kZXg6IGxvd2VzdEluZGV4IH0gPSBmaW5kTG93ZXN0UmF0ZWQocmlnaHRQb29sLCBjaGFsbGVuZ2VyLmlkKTtcclxuXHJcbiAgICBzdGF0ZS5nYXVudGxldENsaW1iZXJSYW5rID0gY2hhbGxlbmdlckluZGV4ID49IDAgPyBjaGFsbGVuZ2VySW5kZXggKyAxIDogcmlnaHRQb29sLmxlbmd0aDtcclxuXHJcbiAgICByZXR1cm4ge1xyXG4gICAgICBzY2VuZXM6IFtjaGFsbGVuZ2VyLCBsb3dlc3RSYXRlZF0sXHJcbiAgICAgIHJhbmtzOiBbc3RhdGUuZ2F1bnRsZXRDbGltYmVyUmFuaywgbG93ZXN0SW5kZXggKyAxXSxcclxuICAgICAgaXNWaWN0b3J5OiBmYWxzZSxcclxuICAgIH07XHJcbiAgfVxyXG5cclxuICBjb25zdCBjbGltYmVyID0gc3RhdGUuZ2F1bnRsZXRDbGltYmVyO1xyXG4gIGNvbnN0IGNsaW1iZXJJbmRleCA9IHJpZ2h0UG9vbC5maW5kSW5kZXgoKHMpID0+IHMuaWQgPT09IGNsaW1iZXIuaWQpO1xyXG5cclxuICBzdGF0ZS5nYXVudGxldENsaW1iZXJSYW5rID0gY2xpbWJlckluZGV4ID49IDAgPyBjbGltYmVySW5kZXggKyAxIDogMTtcclxuXHJcbiAgY29uc3QgcmVtYWluaW5nT3Bwb25lbnRzID0gZ2V0UmVtYWluaW5nQ2xpbWJPcHBvbmVudHMoY2xpbWJlciwgcmlnaHRQb29sLCBjbGltYmVySW5kZXgpO1xyXG4gIFxyXG4gIC8vIElmIG5vIG9wcG9uZW50cyBsZWZ0LCB0aGUgY2xpbWJlciBoYXMgY29ucXVlcmVkIHRoZSBsYWRkZXJcclxuICBpZiAocmVtYWluaW5nT3Bwb25lbnRzLmxlbmd0aCA9PT0gMCkge1xyXG4gICAgc3RhdGUuZ2F1bnRsZXRDbGltYmVyUmFuayA9IDE7XHJcbiAgICByZXR1cm4ge1xyXG4gICAgICBzY2VuZXM6IFtjbGltYmVyXSxcclxuICAgICAgcmFua3M6IFsxXSxcclxuICAgICAgaXNWaWN0b3J5OiB0cnVlLFxyXG4gICAgfTtcclxuICB9XHJcblxyXG4gIGNvbnN0IG5leHRPcHBvbmVudCA9IHBpY2tDbG9zZXN0Q2xpbWJPcHBvbmVudChyZW1haW5pbmdPcHBvbmVudHMpO1xyXG4gIGNvbnN0IG5leHRPcHBvbmVudEluZGV4ID0gcmlnaHRQb29sLmZpbmRJbmRleCgocykgPT4gcy5pZCA9PT0gbmV4dE9wcG9uZW50LmlkKTtcclxuXHJcbiAgcmV0dXJuIHtcclxuICAgIHNjZW5lczogW2NsaW1iZXIsIG5leHRPcHBvbmVudF0sXHJcbiAgICByYW5rczogW2NsaW1iZXJJbmRleCArIDEsIG5leHRPcHBvbmVudEluZGV4ICsgMV0sXHJcbiAgICBpc1ZpY3Rvcnk6IGZhbHNlLFxyXG4gIH07XHJcbn1cclxuXHJcbi8vIC0tLSBQbGFjZW1lbnQgbW9kZTogYm91bmRlZCBzZWFyY2ggd2l0aCBtb21lbnR1bSAtLS1cclxuLy9cclxuLy8gVGhlIHNjZW5lJ3Mgc2xvdCBsaWVzIGluIFtsbywgaGkpIG9mIHRoZSByYXRpbmctc29ydGVkIG9wcG9uZW50IHBvb2wuIEEgd2luIGFnYWluc3QgaW5kZXggaVxyXG4vLyBtZWFucyB0aGUgc2xvdCBpcyBhYm92ZSBpIChoaSA9IGkpOyBhIGxvc3MgbWVhbnMgaXQncyBiZWxvdyAobG8gPSBpICsgMSkuIEEgcmF0ZWQgc2NlbmUgc3RhcnRzXHJcbi8vIG5leHQgdG8gaXRzIGN1cnJlbnQgcmFuayBhbmQgZ2FsbG9wcyAoc3RlcHMgMSwgMiwgNCwgOC4uLikgd2hpbGUgcmVzdWx0cyBrZWVwIGdvaW5nIHRoZSBzYW1lXHJcbi8vIHdheTsgdGhlIGZpcnN0IHJldmVyc2FsIChvciBhbiB1bnJhdGVkIHNjZW5lKSBzd2l0Y2hlcyB0byBoYWx2aW5nIHRoZSByZW1haW5pbmcgcmFuZ2UuXHJcblxyXG5mdW5jdGlvbiBuZXdQbGFjZW1lbnRSdW4oc2NlbmU6IFNjZW5lKTogUGxhY2VtZW50UnVuIHtcclxuICByZXR1cm4ge1xyXG4gICAgc2NlbmUsXHJcbiAgICBhYm92ZUlkOiBudWxsLFxyXG4gICAgYmVsb3dJZDogbnVsbCxcclxuICAgIGxhc3RPcHBvbmVudElkOiBudWxsLFxyXG4gICAgbGFzdFdvbjogbnVsbCxcclxuICAgIGdhbGxvcGluZzogc2NlbmUucmF0aW5nMTAwICE9IG51bGwsXHJcbiAgICBzdGVwOiAxLFxyXG4gICAgYmF0dGxlczogMCxcclxuICAgIHJhbmdlTG86IDAsXHJcbiAgICByYW5nZUhpOiAwLFxyXG4gIH07XHJcbn1cclxuXHJcbi8qKiBDdXJyZW50IFtsbywgaGkpIHNsb3QgYm91bmRzLCByZXNvbHZlZCBmcm9tIHRoZSBib3VuZGluZyBvcHBvbmVudHMnIGlkcy4gKi9cclxuZnVuY3Rpb24gcGxhY2VtZW50Qm91bmRzKHJ1bjogUGxhY2VtZW50UnVuLCBwb29sOiBTY2VuZVtdKTogeyBsbzogbnVtYmVyOyBoaTogbnVtYmVyIH0ge1xyXG4gIGNvbnN0IGFib3ZlSWR4ID0gcnVuLmFib3ZlSWQgPyBwb29sLmZpbmRJbmRleCgocykgPT4gcy5pZCA9PT0gcnVuLmFib3ZlSWQpIDogLTE7XHJcbiAgY29uc3QgYmVsb3dJZHggPSBydW4uYmVsb3dJZCA/IHBvb2wuZmluZEluZGV4KChzKSA9PiBzLmlkID09PSBydW4uYmVsb3dJZCkgOiAtMTtcclxuICByZXR1cm4geyBsbzogYWJvdmVJZHggKyAxLCBoaTogYmVsb3dJZHggPj0gMCA/IGJlbG93SWR4IDogcG9vbC5sZW5ndGggfTtcclxufVxyXG5cclxuZnVuY3Rpb24gbmV4dFBsYWNlbWVudEluZGV4KHJ1bjogUGxhY2VtZW50UnVuLCBwb29sOiBTY2VuZVtdLCBsbzogbnVtYmVyLCBoaTogbnVtYmVyKTogbnVtYmVyIHtcclxuICBpZiAocnVuLmdhbGxvcGluZykge1xyXG4gICAgaWYgKHJ1bi5sYXN0T3Bwb25lbnRJZCA9PT0gbnVsbCkge1xyXG4gICAgICAvLyBTdGFydCBqdXN0IGJlbG93IHRoZSBzY2VuZSdzIGN1cnJlbnQgcmF0aW5nOiBhIGNvcnJlY3RseSByYXRlZCBzY2VuZSBjb25maXJtcyBpbiB+MiBiYXR0bGVzXHJcbiAgICAgIHJldHVybiBpbnNlcnRpb25JbmRleChwb29sLCBydW4uc2NlbmUucmF0aW5nMTAwID8/IDApO1xyXG4gICAgfVxyXG4gICAgY29uc3QgbGFzdElkeCA9IHBvb2wuZmluZEluZGV4KChzKSA9PiBzLmlkID09PSBydW4ubGFzdE9wcG9uZW50SWQpO1xyXG4gICAgaWYgKGxhc3RJZHggPj0gMCkge1xyXG4gICAgICAvLyBTdGVwIGZyb20gdGhlIGZhciBlZGdlIG9mIHRoZSBsYXN0IG9wcG9uZW50J3MgdGllIGdyb3VwOiBhbm90aGVyIGVxdWFsIHJhdGluZyB0ZWFjaGVzIG5vdGhpbmdcclxuICAgICAgY29uc3QgZGlyID0gcnVuLmxhc3RXb24gPyAtMSA6IDE7XHJcbiAgICAgIGNvbnN0IGxhc3RSYXRpbmcgPSBwb29sW2xhc3RJZHhdLnJhdGluZzEwMCA/PyAwO1xyXG4gICAgICBsZXQgZWRnZSA9IGxhc3RJZHg7XHJcbiAgICAgIHdoaWxlIChlZGdlICsgZGlyID49IDAgJiYgZWRnZSArIGRpciA8IHBvb2wubGVuZ3RoICYmIChwb29sW2VkZ2UgKyBkaXJdLnJhdGluZzEwMCA/PyAwKSA9PT0gbGFzdFJhdGluZykge1xyXG4gICAgICAgIGVkZ2UgKz0gZGlyO1xyXG4gICAgICB9XHJcbiAgICAgIHJldHVybiBlZGdlICsgZGlyICogcnVuLnN0ZXA7XHJcbiAgICB9XHJcbiAgfVxyXG4gIHJldHVybiBsbyArIE1hdGguZmxvb3IoKGhpIC0gbG8pIC8gMik7XHJcbn1cclxuXHJcbi8qKiBSYW5kb20gcGljayBhbW9uZyBzY2VuZXMgaW4gW2xvLCBoaSkgdGhhdCBzaGFyZSBwb29sW2lkeF0ncyByYXRpbmcgKHRoZWlyIG9yZGVyIGlzIGFyYml0cmFyeSkuICovXHJcbmZ1bmN0aW9uIHBpY2tBbW9uZ1RpZXMocG9vbDogU2NlbmVbXSwgaWR4OiBudW1iZXIsIGxvOiBudW1iZXIsIGhpOiBudW1iZXIpOiBudW1iZXIge1xyXG4gIGNvbnN0IHJhdGluZyA9IHBvb2xbaWR4XS5yYXRpbmcxMDAgPz8gMDtcclxuICBjb25zdCB0aWVzOiBudW1iZXJbXSA9IFtdO1xyXG4gIGZvciAobGV0IGkgPSBsbzsgaSA8IGhpOyBpKyspIHtcclxuICAgIGlmICgocG9vbFtpXS5yYXRpbmcxMDAgPz8gMCkgPT09IHJhdGluZykgdGllcy5wdXNoKGkpO1xyXG4gIH1cclxuICByZXR1cm4gdGllc1tNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkgKiB0aWVzLmxlbmd0aCldO1xyXG59XHJcblxyXG4vKiogUmF0aW5nIGZvciBhIHNjZW5lIHBsYWNlZCBhdCBgc2xvdGA6IGJldHdlZW4gaXRzIG5laWdoYm91cnMsIMKxMSBhdCB0aGUgZWRnZXMuICovXHJcbmZ1bmN0aW9uIHBsYWNlbWVudFJhdGluZyhwb29sOiBTY2VuZVtdLCBzbG90OiBudW1iZXIpOiBudW1iZXIge1xyXG4gIGNvbnN0IGFib3ZlID0gc2xvdCA+IDAgPyAocG9vbFtzbG90IC0gMV0ucmF0aW5nMTAwID8/IDApIDogbnVsbDtcclxuICBjb25zdCBiZWxvdyA9IHNsb3QgPCBwb29sLmxlbmd0aCA/IChwb29sW3Nsb3RdLnJhdGluZzEwMCA/PyAwKSA6IG51bGw7XHJcbiAgaWYgKGFib3ZlID09PSBudWxsKSByZXR1cm4gTWF0aC5taW4oMTAwLCAoYmVsb3cgPz8gMCkgKyAxKTtcclxuICBpZiAoYmVsb3cgPT09IG51bGwpIHJldHVybiBNYXRoLm1heCgxLCBhYm92ZSAtIDEpO1xyXG4gIGlmIChhYm92ZSAtIGJlbG93ID49IDIpIHJldHVybiBNYXRoLnJvdW5kKChhYm92ZSArIGJlbG93KSAvIDIpO1xyXG4gIC8vIE5vIGludGVnZXIgc3RyaWN0bHkgYmV0d2VlbjogdGllIHdpdGggdGhlIHNjZW5lIGFib3ZlIChjYWNoZSBvcmRlcmluZyBwdXRzIHRpZXMgZmlyc3QtY29tZSlcclxuICByZXR1cm4gTWF0aC5tYXgoMSwgYWJvdmUpO1xyXG59XHJcblxyXG4vKiogUmVjb3JkIGEgcGxhY2VtZW50IGJhdHRsZSByZXN1bHQgYW5kIHVwZGF0ZSB0aGUgbW9tZW50dW0uICovXHJcbmV4cG9ydCBmdW5jdGlvbiByZWNvcmRQbGFjZW1lbnRSZXN1bHQod29uOiBib29sZWFuLCBvcHBvbmVudElkOiBzdHJpbmcpOiB2b2lkIHtcclxuICBjb25zdCBydW4gPSBzdGF0ZS5wbGFjZW1lbnQ7XHJcbiAgaWYgKCFydW4pIHJldHVybjtcclxuXHJcbiAgaWYgKHJ1bi5sYXN0V29uICE9PSBudWxsKSB7XHJcbiAgICBpZiAocnVuLmxhc3RXb24gPT09IHdvbikgcnVuLnN0ZXAgKj0gMjtcclxuICAgIGVsc2UgcnVuLmdhbGxvcGluZyA9IGZhbHNlO1xyXG4gIH1cclxuICBpZiAod29uKSBydW4uYmVsb3dJZCA9IG9wcG9uZW50SWQ7XHJcbiAgZWxzZSBydW4uYWJvdmVJZCA9IG9wcG9uZW50SWQ7XHJcblxyXG4gIHJ1bi5sYXN0T3Bwb25lbnRJZCA9IG9wcG9uZW50SWQ7XHJcbiAgcnVuLmxhc3RXb24gPSB3b247XHJcbiAgcnVuLmJhdHRsZXMrKztcclxufVxyXG5cclxuLy8gUGxhY2VtZW50IG1vZGU6IGxlZnQgPSBzY2VuZSBiZWluZyBwbGFjZWQsIHJpZ2h0ID0gdGhlIG5leHQgb3Bwb25lbnQgaW4gaXRzIHNlYXJjaCByYW5nZVxyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmV0Y2hQbGFjZW1lbnRQYWlyKFxyXG4gIGZvcmNlZExlZnRTY2VuZTogU2NlbmUgfCBudWxsID0gbnVsbCxcclxuKTogUHJvbWlzZTxQbGFjZW1lbnRQYWlyUmVzdWx0PiB7XHJcbiAgY29uc3QgZmlsdGVycyA9IHJlYWRGaWx0ZXJzKCk7XHJcbiAgY29uc3QgeyBsZWZ0UG9vbCwgYWxsU2NlbmVzIH0gPSBhd2FpdCBsb2FkU2NlbmVQb29scyhmaWx0ZXJzKTtcclxuXHJcbiAgaWYgKGFsbFNjZW5lcy5sZW5ndGggPCAyKSB7XHJcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJOb3QgZW5vdWdoIHNjZW5lcyBmb3IgY29tcGFyaXNvbi5cIik7XHJcbiAgfVxyXG5cclxuICBpZiAoIXN0YXRlLnBsYWNlbWVudCkge1xyXG4gICAgY29uc3Qgc2NlbmUgPSBmb3JjZWRMZWZ0U2NlbmUgfHwgZ2V0TmV4dEZpbHRlcmVkU2NlbmUobGVmdFBvb2wsIGZpbHRlcnMuZmlsdGVyS2V5KTtcclxuICAgIGlmICghc2NlbmUpIHtcclxuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiTm8gc2NlbmVzIG1hdGNoIHlvdXIgZmlsdGVyIGNyaXRlcmlhLlwiKTtcclxuICAgIH1cclxuICAgIHN0YXRlLnBsYWNlbWVudCA9IG5ld1BsYWNlbWVudFJ1bihzY2VuZSk7XHJcbiAgfVxyXG4gIGNvbnN0IHJ1biA9IHN0YXRlLnBsYWNlbWVudDtcclxuXHJcbiAgY29uc3QgcG9vbCA9IGJ1aWxkT3Bwb25lbnRQb29sKGFsbFNjZW5lcywgbGVmdFBvb2wsIGZpbHRlcnMpLmZpbHRlcigocykgPT4gcy5pZCAhPT0gcnVuLnNjZW5lLmlkKTtcclxuICBpZiAocG9vbC5sZW5ndGggPT09IDApIHtcclxuICAgIHRocm93IG5ldyBFcnJvcihcIk5vdCBlbm91Z2ggc2NlbmVzIGZvciBjb21wYXJpc29uLiBZb3UgbmVlZCBhdCBsZWFzdCAyIHNjZW5lcy5cIik7XHJcbiAgfVxyXG4gIHN0YXRlLnRvdGFsU2NlbmVzQ291bnQgPSBwb29sLmxlbmd0aCArIDE7XHJcblxyXG4gIGNvbnN0IHsgbG8sIGhpIH0gPSBwbGFjZW1lbnRCb3VuZHMocnVuLCBwb29sKTtcclxuICBydW4ucmFuZ2VMbyA9IE1hdGgubWluKGxvLCBoaSk7XHJcbiAgcnVuLnJhbmdlSGkgPSBoaTtcclxuXHJcbiAgaWYgKGxvID49IGhpKSB7XHJcbiAgICBjb25zdCBzbG90ID0gTWF0aC5taW4obG8sIGhpKTtcclxuICAgIGNvbnN0IHJhdGluZyA9IHBsYWNlbWVudFJhdGluZyhwb29sLCBzbG90KTtcclxuICAgIGNvbnNvbGUubG9nKFxyXG4gICAgICBgW1N0YXNoIEJhdHRsZV0g8J+TjSBQbGFjZW1lbnQ6IHNjZW5lICR7cnVuLnNjZW5lLmlkfSBwbGFjZWQgYXQgIyR7c2xvdCArIDF9IGFmdGVyICR7cnVuLmJhdHRsZXN9IGJhdHRsZXMsIHJhdGluZyAke3JhdGluZ31gLFxyXG4gICAgKTtcclxuICAgIGF3YWl0IHVwZGF0ZVNjZW5lUmF0aW5nKHJ1bi5zY2VuZS5pZCwgcmF0aW5nKTtcclxuICAgIHJ1bi5zY2VuZS5yYXRpbmcxMDAgPSByYXRpbmc7XHJcbiAgICByZXR1cm4geyBkb25lOiB0cnVlLCBzY2VuZTogcnVuLnNjZW5lLCByYW5rOiBzbG90ICsgMSwgcmF0aW5nIH07XHJcbiAgfVxyXG5cclxuICBjb25zdCB0YXJnZXQgPSBNYXRoLm1heChsbywgTWF0aC5taW4oaGkgLSAxLCBuZXh0UGxhY2VtZW50SW5kZXgocnVuLCBwb29sLCBsbywgaGkpKSk7XHJcbiAgY29uc3QgaWR4ID0gcGlja0Ftb25nVGllcyhwb29sLCB0YXJnZXQsIGxvLCBoaSk7XHJcbiAgcmV0dXJuIHsgZG9uZTogZmFsc2UsIHNjZW5lczogW3J1bi5zY2VuZSwgcG9vbFtpZHhdXSwgcmFua3M6IFtudWxsLCBpZHggKyAxXSB9O1xyXG59XHJcbiIsICJpbXBvcnQgdHlwZSB7IFNjZW5lIH0gZnJvbSBcIi4uL3R5cGVzXCI7XHJcblxyXG4vKiogU2NlbmUgdGl0bGUgZnJvbSBtZXRhZGF0YSwgb3IgdGhlIGZpbGVuYW1lICh3aXRob3V0IGV4dGVuc2lvbikgZnJvbSB0aGUgZmlsZSBwYXRoLiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gcmVzb2x2ZVNjZW5lVGl0bGUoc2NlbmU6IFNjZW5lKTogc3RyaW5nIHtcclxuICBpZiAoc2NlbmUudGl0bGUpIHJldHVybiBzY2VuZS50aXRsZTtcclxuXHJcbiAgY29uc3QgcGF0aCA9IHNjZW5lLmZpbGVzPy5bMF0/LnBhdGg7XHJcbiAgaWYgKHBhdGgpIHtcclxuICAgIGNvbnN0IHBhdGhQYXJ0cyA9IHBhdGguc3BsaXQoL1svXFxcXF0vKTtcclxuICAgIHJldHVybiBwYXRoUGFydHNbcGF0aFBhcnRzLmxlbmd0aCAtIDFdLnJlcGxhY2UoL1xcLlteLy5dKyQvLCBcIlwiKTtcclxuICB9XHJcblxyXG4gIHJldHVybiBcIlwiO1xyXG59XHJcbiIsICIvLyBSZW5kZXJzIGFuIGluZGl2aWR1YWwgc2NlbmUgY2FyZCAocmV0dXJucyBhbiBIVE1MIHN0cmluZykuXHJcblxyXG5pbXBvcnQgeyBzYXZlZFJhdGluZyB9IGZyb20gXCIuLi9jYWNoZVwiO1xyXG5pbXBvcnQgeyBzdGF0ZSB9IGZyb20gXCIuLi9zdGF0ZVwiO1xyXG5pbXBvcnQgeyBpc1N0YXNoRGVsZXRlRGlhbG9nQXZhaWxhYmxlIH0gZnJvbSBcIi4vZGVsZXRlRGlhbG9nXCI7XHJcbmltcG9ydCB0eXBlIHsgUmFuaywgU2NlbmUgfSBmcm9tIFwiLi4vdHlwZXNcIjtcclxuaW1wb3J0IHsgcmVzb2x2ZVNjZW5lVGl0bGUgfSBmcm9tIFwiLi9zY2VuZVRpdGxlXCI7XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0RHVyYXRpb24oc2Vjb25kczogbnVtYmVyIHwgbnVsbCB8IHVuZGVmaW5lZCk6IHN0cmluZyB7XHJcbiAgaWYgKCFzZWNvbmRzKSByZXR1cm4gXCJOL0FcIjtcclxuICBjb25zdCBoID0gTWF0aC5mbG9vcihzZWNvbmRzIC8gMzYwMCk7XHJcbiAgY29uc3QgbSA9IE1hdGguZmxvb3IoKHNlY29uZHMgJSAzNjAwKSAvIDYwKTtcclxuICBjb25zdCBzID0gTWF0aC5mbG9vcihzZWNvbmRzICUgNjApO1xyXG4gIGlmIChoID4gMCkge1xyXG4gICAgcmV0dXJuIGAke2h9OiR7bS50b1N0cmluZygpLnBhZFN0YXJ0KDIsIFwiMFwiKX06JHtzLnRvU3RyaW5nKCkucGFkU3RhcnQoMiwgXCIwXCIpfWA7XHJcbiAgfVxyXG4gIHJldHVybiBgJHttfToke3MudG9TdHJpbmcoKS5wYWRTdGFydCgyLCBcIjBcIil9YDtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZVNjZW5lQ2FyZChcclxuICBzY2VuZTogU2NlbmUsXHJcbiAgc2lkZTogXCJsZWZ0XCIgfCBcInJpZ2h0XCIsXHJcbiAgcmFuazogUmFuayA9IG51bGwsXHJcbiAgc3RhdHVzQmFkZ2U6IG51bWJlciB8IHN0cmluZyB8IG51bGwgPSBudWxsLFxyXG4pOiBzdHJpbmcge1xyXG4gIGNvbnN0IGZpbGUgPSBzY2VuZS5maWxlcyAmJiBzY2VuZS5maWxlc1swXSA/IHNjZW5lLmZpbGVzWzBdIDoge307XHJcbiAgY29uc3QgZHVyYXRpb24gPSBmaWxlLmR1cmF0aW9uO1xyXG4gIGNvbnN0IHBlcmZvcm1lcnMgPVxyXG4gICAgc2NlbmUucGVyZm9ybWVycyAmJiBzY2VuZS5wZXJmb3JtZXJzLmxlbmd0aCA+IDBcclxuICAgICAgPyBzY2VuZS5wZXJmb3JtZXJzLm1hcCgocCkgPT4gcC5uYW1lKS5qb2luKFwiLCBcIilcclxuICAgICAgOiBcIk5vIHBlcmZvcm1lcnNcIjtcclxuICBjb25zdCBzdHVkaW8gPSBzY2VuZS5zdHVkaW8gPyBzY2VuZS5zdHVkaW8ubmFtZSA6IFwiTm8gc3R1ZGlvXCI7XHJcbiAgY29uc3QgdGFncyA9IHNjZW5lLnRhZ3MgPyBzY2VuZS50YWdzLnNsaWNlKDAsIDUpLm1hcCgodCkgPT4gdC5uYW1lKSA6IFtdO1xyXG5cclxuICBjb25zdCB0aXRsZSA9IHJlc29sdmVTY2VuZVRpdGxlKHNjZW5lKTtcclxuXHJcbiAgY29uc3Qgc2NyZWVuc2hvdFBhdGggPSBzY2VuZS5wYXRocyA/IHNjZW5lLnBhdGhzLnNjcmVlbnNob3QgOiBudWxsO1xyXG4gIGNvbnN0IHByZXZpZXdQYXRoID0gc2NlbmUucGF0aHMgPyBzY2VuZS5wYXRocy5wcmV2aWV3IDogbnVsbDtcclxuICBjb25zdCB7IHVucmF0ZWRSYXRpbmcsIG9wZW5Jbk5ld1RhYiwgY2xlYW5Nb2RlIH0gPSBzdGF0ZS5zZXR0aW5ncztcclxuICBjb25zdCB1bnJhdGVkTGFiZWwgPVxyXG4gICAgc3RhdGUuY3VycmVudE1vZGUgPT09IFwic3dpc3NcIiAmJiB1bnJhdGVkUmF0aW5nID4gMSA/IGBVbnJhdGVkIChjb3VudHMgYXMgJHt1bnJhdGVkUmF0aW5nfSlgIDogXCJVbnJhdGVkXCI7XHJcbiAgLy8gRnVuIG1vZGUgYmF0dGxlcyBzYW5kYm94IGNvcGllcyB3aG9zZSByYXRpbmdzIG1vdmUgaW4gbWVtb3J5OyBjYXJkcyBrZWVwIHNob3dpbmcgdGhlIHNhdmVkIG9uZVxyXG4gIGNvbnN0IHNob3duUmF0aW5nID0gc3RhdGUuc2V0dGluZ3MuZnVuTW9kZSA/IHNhdmVkUmF0aW5nKHNjZW5lKSA6IHNjZW5lLnJhdGluZzEwMDtcclxuICBjb25zdCBzdGFzaFJhdGluZyA9IHNob3duUmF0aW5nID8gYCR7c2hvd25SYXRpbmd9LzEwMGAgOiB1bnJhdGVkTGFiZWw7XHJcblxyXG4gIC8vIE51bWVyaWMgcmFuayBiYWRnZSAoI04pLCBvbWl0dGVkIHdoZW4gbnVsbFxyXG4gIGxldCByYW5rRGlzcGxheSA9IFwiXCI7XHJcbiAgaWYgKHJhbmsgIT09IG51bGwgJiYgcmFuayAhPT0gdW5kZWZpbmVkKSB7XHJcbiAgICByYW5rRGlzcGxheSA9IGA8c3BhbiBjbGFzcz1cInNiLXNjZW5lLXJhbmtcIj4jJHtyYW5rfTwvc3Bhbj5gO1xyXG4gIH1cclxuXHJcbiAgLy8gU3RhdHVzIGJhZGdlOiB3aW4tc3RyZWFrIGNvdW50IChmb3JtYXR0ZWQpIG9yIGN1c3RvbSBsYWJlbCAoZS5nLiBmYWxsaW5nIG1vZGUpXHJcbiAgbGV0IHN0YXR1c0JhZGdlSHRtbCA9IFwiXCI7XHJcbiAgaWYgKHR5cGVvZiBzdGF0dXNCYWRnZSA9PT0gXCJzdHJpbmdcIikge1xyXG4gICAgc3RhdHVzQmFkZ2VIdG1sID0gYDxkaXYgY2xhc3M9XCJzYi1zdHJlYWstYmFkZ2VcIj4ke3N0YXR1c0JhZGdlfTwvZGl2PmA7XHJcbiAgfSBlbHNlIGlmIChzdGF0dXNCYWRnZSAhPT0gbnVsbCAmJiBzdGF0dXNCYWRnZSA+IDApIHtcclxuICAgIHN0YXR1c0JhZGdlSHRtbCA9IGA8ZGl2IGNsYXNzPVwic2Itc3RyZWFrLWJhZGdlXCI+8J+UpSAke3N0YXR1c0JhZGdlfSB3aW4ke3N0YXR1c0JhZGdlID4gMSA/IFwic1wiIDogXCJcIn08L2Rpdj5gO1xyXG4gIH1cclxuXHJcbiAgLy8gUHJlc2VydmUgVVJMIHNlYXJjaCBwYXJhbXMgd2hlbiBvcGVuaW5nIHNjZW5lXHJcbiAgY29uc3QgY3VycmVudFBhcmFtcyA9IHdpbmRvdy5sb2NhdGlvbi5zZWFyY2g7XHJcbiAgY29uc3Qgc2NlbmVVcmwgPSBgL3NjZW5lcy8ke3NjZW5lLmlkfSR7Y3VycmVudFBhcmFtc31gO1xyXG4gIGNvbnN0IGxpbmtUYXJnZXQgPSBvcGVuSW5OZXdUYWIgPyBgIHRhcmdldD1cIl9ibGFua1wiIHJlbD1cIm5vb3BlbmVyXCJgIDogXCJcIjtcclxuXHJcbiAgLy8gcHdyLSogY2xhc3NlcyBhcmUgdGhlIHBsdWdpbidzIHByZS0yLjAgbmFtZXM7IFNGVyBTd2l0Y2ggc3RpbGwgdGFyZ2V0cyB0aGVtIHRvIGJsdXIgU3Rhc2ggQmF0dGxlLlxyXG4gIC8vIEJhZGdlcyBzaXQgb3V0c2lkZSB0aGUgKGJsdXJyZWQpIGltYWdlIGNvbnRhaW5lciBzbyB0aGV5IHN0YXkgcmVhZGFibGUgaW4gU0ZXIG1vZGUuXHJcbiAgcmV0dXJuIGBcclxuICAgICAgPGRpdiBjbGFzcz1cInNiLXNjZW5lLWNhcmRcIiBkYXRhLXNpZGU9XCIke3NpZGV9XCI+XHJcbiAgICAgICAgPGRpdiBjbGFzcz1cInNiLXNjZW5lLW1lZGlhXCI+XHJcbiAgICAgICAgICA8YSBjbGFzcz1cInNiLXNjZW5lLWltYWdlLWNvbnRhaW5lciBwd3Itc2NlbmUtaW1hZ2UtY29udGFpbmVyXCIgaHJlZj1cIiR7c2NlbmVVcmx9XCIke2xpbmtUYXJnZXR9PlxyXG4gICAgICAgICAgICAke1xyXG4gICAgICAgICAgICAgIHNjcmVlbnNob3RQYXRoXHJcbiAgICAgICAgICAgICAgICA/IGA8aW1nIGNsYXNzPVwic2Itc2NlbmUtaW1hZ2UgcHdyLXNjZW5lLWltYWdlXCIgc3JjPVwiJHtzY3JlZW5zaG90UGF0aH1cIiBhbHQ9XCIke3RpdGxlfVwiIGxvYWRpbmc9XCJsYXp5XCIgLz5gXHJcbiAgICAgICAgICAgICAgICA6IGA8ZGl2IGNsYXNzPVwic2Itc2NlbmUtaW1hZ2Ugc2Itbm8taW1hZ2VcIj5ObyBTY3JlZW5zaG90PC9kaXY+YFxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICR7cHJldmlld1BhdGggPyBgPHZpZGVvIGNsYXNzPVwic2ItaG92ZXItcHJldmlldyBwd3ItaG92ZXItcHJldmlld1wiIHNyYz1cIiR7cHJldmlld1BhdGh9XCIgbG9vcCBtdXRlZCBwbGF5c2lubGluZT48L3ZpZGVvPmAgOiBcIlwifVxyXG4gICAgICAgICAgPC9hPlxyXG4gICAgICAgICAgPGRpdiBjbGFzcz1cInNiLXNjZW5lLWR1cmF0aW9uXCI+JHtmb3JtYXREdXJhdGlvbihkdXJhdGlvbil9PC9kaXY+XHJcbiAgICAgICAgICAke3N0YXR1c0JhZGdlSHRtbH1cclxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1jbGljay1oaW50XCI+JHtvcGVuSW5OZXdUYWIgPyBcIkNsaWNrIHRvIG9wZW4gaW4gbmV3IHRhYlwiIDogXCJDbGljayB0byBvcGVuIHNjZW5lXCJ9PC9kaXY+XHJcbiAgICAgICAgICA8YSBjbGFzcz1cInNiLW9wZW4tbGlua1wiIGhyZWY9XCIke3NjZW5lVXJsfVwiIHRhcmdldD1cIl9ibGFua1wiIHJlbD1cIm5vb3BlbmVyXCIgdGl0bGU9XCJPcGVuIHNjZW5lIGluIG5ldyB0YWJcIj7ihpc8L2E+XHJcbiAgICAgICAgICAke2NsZWFuTW9kZSAmJiBpc1N0YXNoRGVsZXRlRGlhbG9nQXZhaWxhYmxlKCkgPyBgPGJ1dHRvbiB0eXBlPVwiYnV0dG9uXCIgY2xhc3M9XCJzYi1kZWxldGUtYnRuXCIgdGl0bGU9XCJEZWxldGUgdGhpcyBzY2VuZSBmcm9tIFN0YXNoXCI+8J+XkTwvYnV0dG9uPmAgOiBcIlwifVxyXG4gICAgICAgIDwvZGl2PlxyXG5cclxuICAgICAgICA8ZGl2IGNsYXNzPVwic2Itc2NlbmUtYm9keVwiIGRhdGEtd2lubmVyPVwiJHtzY2VuZS5pZH1cIj5cclxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1zY2VuZS1pbmZvIHB3ci1zY2VuZS1pbmZvXCI+XHJcbiAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1zY2VuZS10aXRsZS1yb3dcIj5cclxuICAgICAgICAgICAgICA8aDMgY2xhc3M9XCJzYi1zY2VuZS10aXRsZVwiPiR7dGl0bGV9PC9oMz5cclxuICAgICAgICAgICAgICAke3JhbmtEaXNwbGF5fVxyXG4gICAgICAgICAgICA8L2Rpdj5cclxuXHJcbiAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1zY2VuZS1tZXRhXCI+XHJcbiAgICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNiLW1ldGEtaXRlbSBzYi1tZXRhLXN0dWRpb1wiPjxzdHJvbmc+U3R1ZGlvOjwvc3Ryb25nPiAke3N0dWRpb308L2Rpdj5cclxuICAgICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItbWV0YS1pdGVtIHNiLW1ldGEtcGVyZm9ybWVyc1wiPjxzdHJvbmc+UGVyZm9ybWVyczo8L3N0cm9uZz4gJHtwZXJmb3JtZXJzfTwvZGl2PlxyXG4gICAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1tZXRhLWl0ZW0gc2ItbWV0YS1wbGF5c1wiPjxzdHJvbmc+UGxheSBDb3VudDo8L3N0cm9uZz4gJHtzY2VuZS5wbGF5X2NvdW50IHx8IDB9PC9kaXY+XHJcbiAgICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNiLW1ldGEtaXRlbSBzYi1tZXRhLXJhdGluZ1wiPjxzdHJvbmc+UmF0aW5nOjwvc3Ryb25nPiAke3N0YXNoUmF0aW5nfTwvZGl2PlxyXG4gICAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1tZXRhLWl0ZW0gc2ItdGFncy1yb3dcIj48c3Ryb25nPlRhZ3M6PC9zdHJvbmc+ICR7dGFncy5sZW5ndGggPiAwID8gdGFncy5tYXAoKHRhZykgPT4gYDxzcGFuIGNsYXNzPVwic2ItdGFnXCI+JHt0YWd9PC9zcGFuPmApLmpvaW4oXCJcIikgOiAnPHNwYW4gY2xhc3M9XCJzYi1ub25lXCI+Tm9uZTwvc3Bhbj4nfTwvZGl2PlxyXG4gICAgICAgICAgICA8L2Rpdj5cclxuICAgICAgICAgIDwvZGl2PlxyXG5cclxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1jaG9vc2UtYnRuXCI+XHJcbiAgICAgICAgICAgIOKckyBDaG9vc2U8c3BhbiBjbGFzcz1cInNiLWNob29zZS1sb25nXCI+IFRoaXMgU2NlbmU8L3NwYW4+XHJcbiAgICAgICAgICA8L2Rpdj5cclxuICAgICAgICA8L2Rpdj5cclxuICAgICAgPC9kaXY+XHJcbiAgICBgO1xyXG59XHJcbiIsICIvLyBWaWN0b3J5IGFuZCBwbGFjZW1lbnQgZW5kLXNjcmVlbnMgZm9yIGdhdW50bGV0L2NoYW1waW9uIHJ1bnMuXHJcblxyXG5pbXBvcnQgeyByYXRpbmdzRW5hYmxlZCB9IGZyb20gXCIuLi9yYXRpbmdcIjtcclxuaW1wb3J0IHsgcmVzZXRSdW5TdGF0ZSwgc3RhdGUgfSBmcm9tIFwiLi4vc3RhdGVcIjtcclxuaW1wb3J0IHsgc2F2ZVN0YXRlIH0gZnJvbSBcIi4uL3N0b3JhZ2VcIjtcclxuaW1wb3J0IHR5cGUgeyBTY2VuZSB9IGZyb20gXCIuLi90eXBlc1wiO1xyXG5pbXBvcnQgeyBsb2FkTmV3UGFpciwgc2V0QWN0aW9uc1Zpc2libGUgfSBmcm9tIFwiLi9tYWluVUlcIjtcclxuaW1wb3J0IHsgcmVzb2x2ZVNjZW5lVGl0bGUgfSBmcm9tIFwiLi9zY2VuZVRpdGxlXCI7XHJcblxyXG5mdW5jdGlvbiBidWlsZEVuZFNjcmVlbkh0bWwoXHJcbiAgc2NlbmU6IFNjZW5lLFxyXG4gIGNyb3duOiBzdHJpbmcsXHJcbiAgaGVhZGxpbmU6IHN0cmluZyxcclxuICBzdGF0c0h0bWw6IHN0cmluZyxcclxuICBidXR0b25MYWJlbDogc3RyaW5nLFxyXG4pOiBzdHJpbmcge1xyXG4gIGNvbnN0IHRpdGxlID0gcmVzb2x2ZVNjZW5lVGl0bGUoc2NlbmUpO1xyXG4gIGNvbnN0IHNjcmVlbnNob3RQYXRoID0gc2NlbmUucGF0aHM/LnNjcmVlbnNob3QgPz8gbnVsbDtcclxuXHJcbiAgcmV0dXJuIGBcclxuICAgICAgPGRpdiBjbGFzcz1cInNiLWVuZC1zY3JlZW5cIj5cclxuICAgICAgICA8ZGl2IGNsYXNzPVwic2ItZW5kLXNjcmVlbi1pY29uXCI+JHtjcm93bn08L2Rpdj5cclxuICAgICAgICA8aDIgY2xhc3M9XCJzYi1lbmQtc2NyZWVuLWhlYWRsaW5lXCI+JHtoZWFkbGluZX08L2gyPlxyXG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi1lbmQtc2NyZWVuLXNjZW5lIHB3ci1zY2VuZS1pbWFnZS1jb250YWluZXJcIj5cclxuICAgICAgICAgICR7XHJcbiAgICAgICAgICAgIHNjcmVlbnNob3RQYXRoXHJcbiAgICAgICAgICAgICAgPyBgPGltZyBjbGFzcz1cInNiLWVuZC1zY3JlZW4taW1hZ2UgcHdyLXNjZW5lLWltYWdlXCIgc3JjPVwiJHtzY3JlZW5zaG90UGF0aH1cIiBhbHQ9XCIke3RpdGxlfVwiIC8+YFxyXG4gICAgICAgICAgICAgIDogYDxkaXYgY2xhc3M9XCJzYi1lbmQtc2NyZWVuLWltYWdlIHNiLW5vLWltYWdlXCI+Tm8gU2NyZWVuc2hvdDwvZGl2PmBcclxuICAgICAgICAgIH1cclxuICAgICAgICA8L2Rpdj5cclxuICAgICAgICA8aDMgY2xhc3M9XCJzYi1lbmQtc2NyZWVuLW5hbWVcIj4ke3RpdGxlfTwvaDM+XHJcbiAgICAgICAgPHAgY2xhc3M9XCJzYi1lbmQtc2NyZWVuLXN0YXRzXCI+JHtzdGF0c0h0bWx9JHtyYXRpbmdzRW5hYmxlZCgpID8gXCJcIiA6IFwiPGJyPjxlbT7wn46IIEZ1biBtb2RlOiByYXRpbmcgbm90IHNhdmVkPC9lbT5cIn08L3A+XHJcbiAgICAgICAgPGJ1dHRvbiBpZD1cInNiLW5ldy1nYXVudGxldFwiIGNsYXNzPVwiYnRuIGJ0bi1wcmltYXJ5XCI+JHtidXR0b25MYWJlbH08L2J1dHRvbj5cclxuICAgICAgPC9kaXY+XHJcbiAgICBgO1xyXG59XHJcblxyXG4vKiogUmVuZGVyIGFuIGVuZCBzY3JlZW4sIGhpZGUgYmF0dGxlIGNvbnRyb2xzLCBhbmQgd2lyZSB0aGUgbmV3LXJ1biBidXR0b24uICovXHJcbmZ1bmN0aW9uIHNob3dFbmRTY3JlZW4oaHRtbDogc3RyaW5nKTogdm9pZCB7XHJcbiAgY29uc3QgY29tcGFyaXNvbkFyZWEgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInNiLWNvbXBhcmlzb24tYXJlYVwiKTtcclxuICBpZiAoIWNvbXBhcmlzb25BcmVhKSByZXR1cm47XHJcblxyXG4gIGNvbXBhcmlzb25BcmVhLmlubmVySFRNTCA9IGh0bWw7XHJcbiAgc2V0QWN0aW9uc1Zpc2libGUoZmFsc2UpO1xyXG5cclxuICBjb21wYXJpc29uQXJlYS5xdWVyeVNlbGVjdG9yKFwiI3NiLW5ldy1nYXVudGxldFwiKT8uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHtcclxuICAgIGxvYWROZXdQYWlyKCk7XHJcbiAgfSk7XHJcbn1cclxuXHJcbi8qKiBDYXB0dXJlIGRpc3BsYXkgdmFsdWVzLCBjbGVhciBydW4gc3RhdGUsIHRoZW4gc2hvdyB0aGUgZW5kIHNjcmVlbi4gKi9cclxuZnVuY3Rpb24gZmluaXNoUnVuU2hvd0VuZFNjcmVlbihodG1sOiBzdHJpbmcpOiB2b2lkIHtcclxuICByZXNldFJ1blN0YXRlKCk7XHJcbiAgc2F2ZVN0YXRlKCk7XHJcbiAgc2hvd0VuZFNjcmVlbihodG1sKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHNob3dWaWN0b3J5U2NyZWVuKGNoYW1waW9uOiBTY2VuZSk6IHZvaWQge1xyXG4gIGNvbnN0IHRvdGFsU2NlbmVzID0gc3RhdGUudG90YWxTY2VuZXNDb3VudDtcclxuICBjb25zdCB3aW5TdHJlYWsgPSBzdGF0ZS5nYXVudGxldFdpbnM7XHJcbiAgY29uc3QgcmF0aW5nTGluZSA9XHJcbiAgICBjaGFtcGlvbi5yYXRpbmcxMDAgIT0gbnVsbFxyXG4gICAgICA/IGA8YnI+UmF0aW5nOiA8c3Ryb25nPiR7Y2hhbXBpb24ucmF0aW5nMTAwfS8xMDA8L3N0cm9uZz5gXHJcbiAgICAgIDogXCJcIjtcclxuXHJcbiAgY29uc3QgaHRtbCA9IGJ1aWxkRW5kU2NyZWVuSHRtbChcclxuICAgIGNoYW1waW9uLFxyXG4gICAgXCLwn5GRXCIsXHJcbiAgICBcIkNIQU1QSU9OIVwiLFxyXG4gICAgYENvbnF1ZXJlZCBhbGwgJHt0b3RhbFNjZW5lc30gc2NlbmVzIHdpdGggYSAke3dpblN0cmVha30gd2luIHN0cmVhayEke3JhdGluZ0xpbmV9YCxcclxuICAgIFwiU3RhcnQgTmV3IEdhdW50bGV0XCIsXHJcbiAgKTtcclxuXHJcbiAgZmluaXNoUnVuU2hvd0VuZFNjcmVlbihodG1sKTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHNob3dQbGFjZW1lbnRTY3JlZW4oc2NlbmU6IFNjZW5lLCByYW5rOiBudW1iZXIsIGZpbmFsUmF0aW5nOiBudW1iZXIpOiB2b2lkIHtcclxuICBjb25zdCBiYXR0bGVzID0gc3RhdGUucGxhY2VtZW50Py5iYXR0bGVzO1xyXG4gIGNvbnN0IGJhdHRsZXNMaW5lID0gYmF0dGxlcyA/IGAgwrcgJHtiYXR0bGVzfSBiYXR0bGUke2JhdHRsZXMgPT09IDEgPyBcIlwiIDogXCJzXCJ9YCA6IFwiXCI7XHJcbiAgY29uc3QgaHRtbCA9IGJ1aWxkRW5kU2NyZWVuSHRtbChcclxuICAgIHNjZW5lLFxyXG4gICAgXCLwn5ONXCIsXHJcbiAgICBcIlBMQUNFRCFcIixcclxuICAgIGBSYW5rIDxzdHJvbmc+IyR7cmFua308L3N0cm9uZz4gb2YgJHtzdGF0ZS50b3RhbFNjZW5lc0NvdW50fSR7YmF0dGxlc0xpbmV9PGJyPlJhdGluZzogPHN0cm9uZz4ke2ZpbmFsUmF0aW5nfS8xMDA8L3N0cm9uZz5gLFxyXG4gICAgXCJTdGFydCBOZXcgUnVuXCIsXHJcbiAgKTtcclxuXHJcbiAgZmluaXNoUnVuU2hvd0VuZFNjcmVlbihodG1sKTtcclxufVxyXG4iLCAiLy8gQmF0dGxlIC8gU2V0dGluZ3MgdGFicyAoU3Rhc2gncyBvd24gbmF2LXRhYnMgKyAuc2V0dGluZyByb3dzLCBsaWtlIFN0YXNoLVRDb2RlKSwgcGx1cyB0aGVcclxuLy8gcHJldmlldyB2b2x1bWUgY29udHJvbCB0aGF0IHNpdHMgb24gdGhlIHRhYiBiYXIuIEV2ZXJ5IGNvbnRyb2wgY2FycmllcyBkYXRhLXNldHRpbmc9XCI8a2V5PlwiO1xyXG4vLyB2YWx1ZXMgcGVyc2lzdCB2aWEgdXBkYXRlU2V0dGluZ3MoKS5cclxuXHJcbmltcG9ydCB7IHVwZGF0ZVNldHRpbmdzIH0gZnJvbSBcIi4uL3NldHRpbmdzXCI7XHJcbmltcG9ydCB7IHN0YXRlIH0gZnJvbSBcIi4uL3N0YXRlXCI7XHJcbmltcG9ydCB0eXBlIHsgU2V0dGluZ3MgfSBmcm9tIFwiLi4vdHlwZXNcIjtcclxuXHJcbnR5cGUgQm9vbEtleSA9IHsgW0sgaW4ga2V5b2YgU2V0dGluZ3NdOiBTZXR0aW5nc1tLXSBleHRlbmRzIGJvb2xlYW4gPyBLIDogbmV2ZXIgfVtrZXlvZiBTZXR0aW5nc107XHJcbmV4cG9ydCB0eXBlIFRhYklkID0gXCJiYXR0bGVcIiB8IFwic2V0dGluZ3NcIjtcclxuXHJcbmludGVyZmFjZSBTZXR0aW5nUm93IHtcclxuICBrZXk6IGtleW9mIFNldHRpbmdzO1xyXG4gIHRpdGxlOiBzdHJpbmc7XHJcbiAgaGludDogc3RyaW5nO1xyXG59XHJcblxyXG5jb25zdCBTRUNUSU9OUzogeyB0aXRsZTogc3RyaW5nOyByb3dzOiBTZXR0aW5nUm93W10gfVtdID0gW1xyXG4gIHtcclxuICAgIHRpdGxlOiBcIkJhdHRsZXNcIixcclxuICAgIHJvd3M6IFtcclxuICAgICAgeyBrZXk6IFwiZmlsdGVyT3Bwb25lbnRzXCIsIHRpdGxlOiBcIlVzZSBmaWx0ZXJlZCBzY2VuZXMgZm9yIGJvdGggc2lkZXNcIiwgaGludDogXCJPcHBvbmVudHMgYWxzbyBjb21lIGZyb20gdGhlIGN1cnJlbnQgc2NlbmUgbGlzdCBmaWx0ZXIgaW5zdGVhZCBvZiB5b3VyIHdob2xlIHJhdGVkIGxpYnJhcnlcIiB9LFxyXG4gICAgICB7IGtleTogXCJ1bnJhdGVkUmF0aW5nXCIsIHRpdGxlOiBcIlVucmF0ZWQgc2NlbmUgcmF0aW5nXCIsIGhpbnQ6IFwiV2hhdCB1bnJhdGVkIHNjZW5lcyBjb3VudCBhcyBpbiBTd2lzcy4gMCBzdGFydHMgdGhlbSBhdCB0aGUgYm90dG9tOyA1MCBpcyBjbG9zZXIgdG8gYSBjbGFzc2ljIEVMTyBzdGFydFwiIH0sXHJcbiAgICAgIHsga2V5OiBcImZ1bk1vZGVcIiwgdGl0bGU6IFwiRnVuIG1vZGVcIiwgaGludDogXCJCYXR0bGUgd2l0aG91dCBjaGFuZ2luZyBhbnkgcmF0aW5nc1wiIH0sXHJcbiAgICBdLFxyXG4gIH0sXHJcbiAge1xyXG4gICAgdGl0bGU6IFwiU2NlbmVzXCIsXHJcbiAgICByb3dzOiBbXHJcbiAgICAgIHsga2V5OiBcImF1dG9wbGF5UHJldmlld3NcIiwgdGl0bGU6IFwiQXV0b3BsYXkgcHJldmlld3NcIiwgaGludDogXCJMb29wIGJvdGggcHJldmlld3Mgc2lsZW50bHk7IGhvdmVyIGEgY2FyZCB0byBoZWFyIGl0XCIgfSxcclxuICAgICAgeyBrZXk6IFwicGF1c2VNZWRpYU9uT3BlblwiLCB0aXRsZTogXCJQYXVzZSBwbGF5aW5nIHZpZGVvIHdoZW4gQmF0dGxlIG9wZW5zXCIsIGhpbnQ6IFwiU3RvcHMgdGhlIHNjZW5lIHlvdSdyZSB3YXRjaGluZyBzbyBpdHMgYXVkaW8gZG9lc24ndCBvdmVybGFwIHRoZSBiYXR0bGUgcHJldmlld3NcIiB9LFxyXG4gICAgICB7IGtleTogXCJvcGVuSW5OZXdUYWJcIiwgdGl0bGU6IFwiT3BlbiBzY2VuZXMgaW4gYSBuZXcgdGFiXCIsIGhpbnQ6IFwiQ2xpY2tpbmcgYSB0aHVtYm5haWwgb3BlbnMgdGhlIHNjZW5lIGluIGEgbmV3IGJyb3dzZXIgdGFiXCIgfSxcclxuICAgICAgeyBrZXk6IFwiY2xlYW5Nb2RlXCIsIHRpdGxlOiBcIkNsZWFuIG1vZGVcIiwgaGludDogXCJTaG93IGEg8J+XkSBidXR0b24gb24gZWFjaCBjYXJkIHRvIGRlbGV0ZSB0aGUgc2NlbmUgZnJvbSBTdGFzaFwiIH0sXHJcbiAgICBdLFxyXG4gIH0sXHJcbl07XHJcblxyXG4vKiogVm9sdW1lIHJlc3RvcmVkIHdoZW4gdW5tdXRpbmcgZnJvbSAwIHdpdGggbm8gZWFybGllciBsZXZlbCB0aGlzIHNlc3Npb24uICovXHJcbmNvbnN0IERFRkFVTFRfVU5NVVRFX1ZPTFVNRSA9IDUwO1xyXG5sZXQgdm9sdW1lQmVmb3JlTXV0ZTogbnVtYmVyIHwgbnVsbCA9IG51bGw7XHJcblxyXG5sZXQgYWN0aXZlVGFiOiBUYWJJZCA9IFwiYmF0dGxlXCI7XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gZ2V0QWN0aXZlVGFiKCk6IFRhYklkIHtcclxuICByZXR1cm4gYWN0aXZlVGFiO1xyXG59XHJcblxyXG5mdW5jdGlvbiB2b2x1bWVJY29uKHZvbHVtZTogbnVtYmVyKTogc3RyaW5nIHtcclxuICBpZiAodm9sdW1lID09PSAwKSByZXR1cm4gXCLwn5SHXCI7XHJcbiAgcmV0dXJuIHZvbHVtZSA8IDUwID8gXCLwn5SJXCIgOiBcIvCflIpcIjtcclxufVxyXG5cclxuZnVuY3Rpb24gc2V0dGluZ0NvbnRyb2woa2V5OiBrZXlvZiBTZXR0aW5ncyk6IHN0cmluZyB7XHJcbiAgaWYgKGtleSA9PT0gXCJ1bnJhdGVkUmF0aW5nXCIpIHtcclxuICAgIHJldHVybiBgPGlucHV0IHR5cGU9XCJudW1iZXJcIiBtaW49XCIwXCIgbWF4PVwiMTAwXCIgc3RlcD1cIjFcIiBkYXRhLXNldHRpbmc9XCIke2tleX1cIiB2YWx1ZT1cIiR7c3RhdGUuc2V0dGluZ3Nba2V5XX1cIiBjbGFzcz1cImZvcm0tY29udHJvbCBmb3JtLWNvbnRyb2wtc20gaW5wdXQtY29udHJvbCBzYi1zZXR0aW5nLW51bWJlclwiPmA7XHJcbiAgfVxyXG4gIGNvbnN0IGlkID0gYHNiLXNldHRpbmctJHtrZXl9YDtcclxuICByZXR1cm4gYFxyXG4gICAgICAgICAgPGRpdiBjbGFzcz1cImN1c3RvbS1jb250cm9sIGN1c3RvbS1zd2l0Y2hcIj5cclxuICAgICAgICAgICAgPGlucHV0IHR5cGU9XCJjaGVja2JveFwiIGNsYXNzPVwiY3VzdG9tLWNvbnRyb2wtaW5wdXRcIiBpZD1cIiR7aWR9XCIgZGF0YS1zZXR0aW5nPVwiJHtrZXl9XCIgJHtzdGF0ZS5zZXR0aW5nc1trZXkgYXMgQm9vbEtleV0gPyBcImNoZWNrZWRcIiA6IFwiXCJ9PlxyXG4gICAgICAgICAgICA8bGFiZWwgY2xhc3M9XCJjdXN0b20tY29udHJvbC1sYWJlbFwiIGZvcj1cIiR7aWR9XCI+PC9sYWJlbD5cclxuICAgICAgICAgIDwvZGl2PmA7XHJcbn1cclxuXHJcbi8qKiBUYWIgYmFyOiBCYXR0bGUgLyBTZXR0aW5ncyBvbiB0aGUgbGVmdCwgcHJldmlldyB2b2x1bWUgb24gdGhlIHJpZ2h0LiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlVGFiQmFyKCk6IHN0cmluZyB7XHJcbiAgY29uc3QgeyBwcmV2aWV3Vm9sdW1lIH0gPSBzdGF0ZS5zZXR0aW5ncztcclxuICByZXR1cm4gYFxyXG4gICAgICA8ZGl2IGNsYXNzPVwic2ItdGFiLWJhclwiPlxyXG4gICAgICAgIDxuYXYgY2xhc3M9XCJuYXYgbmF2LXRhYnMgc2ItdGFic1wiIHJvbGU9XCJ0YWJsaXN0XCI+XHJcbiAgICAgICAgICA8YSBjbGFzcz1cIm5hdi1pdGVtIG5hdi1saW5rIGFjdGl2ZVwiIHJvbGU9XCJ0YWJcIiBkYXRhLXRhYj1cImJhdHRsZVwiIGFyaWEtc2VsZWN0ZWQ9XCJ0cnVlXCI+4pqU77iPIEJhdHRsZTwvYT5cclxuICAgICAgICAgIDxhIGNsYXNzPVwibmF2LWl0ZW0gbmF2LWxpbmtcIiByb2xlPVwidGFiXCIgZGF0YS10YWI9XCJzZXR0aW5nc1wiIGFyaWEtc2VsZWN0ZWQ9XCJmYWxzZVwiPuKamSBTZXR0aW5nczwvYT5cclxuICAgICAgICA8L25hdj5cclxuICAgICAgICA8ZGl2IGNsYXNzPVwic2Itdm9sdW1lXCIgdGl0bGU9XCJQcmV2aWV3IHZvbHVtZVwiPlxyXG4gICAgICAgICAgPGJ1dHRvbiB0eXBlPVwiYnV0dG9uXCIgY2xhc3M9XCJzYi12b2x1bWUtaWNvblwiIGFyaWEtbGFiZWw9XCJNdXRlIHByZXZpZXdzXCI+JHt2b2x1bWVJY29uKHByZXZpZXdWb2x1bWUpfTwvYnV0dG9uPlxyXG4gICAgICAgICAgPGlucHV0IHR5cGU9XCJyYW5nZVwiIG1pbj1cIjBcIiBtYXg9XCIxMDBcIiBzdGVwPVwiMVwiIGRhdGEtc2V0dGluZz1cInByZXZpZXdWb2x1bWVcIiB2YWx1ZT1cIiR7cHJldmlld1ZvbHVtZX1cIiBhcmlhLWxhYmVsPVwiUHJldmlldyB2b2x1bWVcIj5cclxuICAgICAgICAgIDxzcGFuIGNsYXNzPVwic2Itdm9sdW1lLXZhbHVlXCI+JHtwcmV2aWV3Vm9sdW1lfTwvc3Bhbj5cclxuICAgICAgICA8L2Rpdj5cclxuICAgICAgPC9kaXY+XHJcbiAgICBgO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlU2V0dGluZ3NUYWIoKTogc3RyaW5nIHtcclxuICBjb25zdCBzZWN0aW9ucyA9IFNFQ1RJT05TLm1hcChcclxuICAgICh7IHRpdGxlLCByb3dzIH0pID0+IGBcclxuICAgICAgICA8ZGl2IGNsYXNzPVwic2V0dGluZy1zZWN0aW9uXCI+XHJcbiAgICAgICAgICA8aDE+JHt0aXRsZX08L2gxPlxyXG4gICAgICAgICAgPGRpdiBjbGFzcz1cImNhcmRcIj5cclxuICAgICAgICAgICAgJHtyb3dzXHJcbiAgICAgICAgICAgICAgLm1hcChcclxuICAgICAgICAgICAgICAgICh7IGtleSwgdGl0bGU6IHJvd1RpdGxlLCBoaW50IH0pID0+IGBcclxuICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNldHRpbmdcIj5cclxuICAgICAgICAgICAgICA8ZGl2PlxyXG4gICAgICAgICAgICAgICAgPGgzPiR7cm93VGl0bGV9PC9oMz5cclxuICAgICAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzdWItaGVhZGluZ1wiPiR7aGludH08L2Rpdj5cclxuICAgICAgICAgICAgICA8L2Rpdj5cclxuICAgICAgICAgICAgICA8ZGl2PiR7c2V0dGluZ0NvbnRyb2woa2V5KX08L2Rpdj5cclxuICAgICAgICAgICAgPC9kaXY+YCxcclxuICAgICAgICAgICAgICApXHJcbiAgICAgICAgICAgICAgLmpvaW4oXCJcIil9XHJcbiAgICAgICAgICA8L2Rpdj5cclxuICAgICAgICA8L2Rpdj5gLFxyXG4gICkuam9pbihcIlwiKTtcclxuXHJcbiAgcmV0dXJuIGBcclxuICAgICAgPGRpdiBjbGFzcz1cInNiLXRhYi1wYW5lbCBzYi1zZXR0aW5ncy10YWJcIiBkYXRhLXBhbmVsPVwic2V0dGluZ3NcIiBoaWRkZW4+XHJcbiAgICAgICAgJHtzZWN0aW9uc31cclxuICAgICAgICA8cCBjbGFzcz1cInNiLXNldHRpbmdzLW5vdGVcIj5TYXZlcyB0byBTdGFzaCwgYWxzbyB1bmRlciBTZXR0aW5ncyDihpIgUGx1Z2lucy48L3A+XHJcbiAgICAgIDwvZGl2PlxyXG4gICAgYDtcclxufVxyXG5cclxuLyoqIFB1c2ggc3RhdGUuc2V0dGluZ3MgaW50byB0aGUgcmVuZGVyZWQgY29udHJvbHMgKGUuZy4gYWZ0ZXIgcmUtZmV0Y2hpbmcgc2V0dGluZ3Mgb24gcmVvcGVuKS4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHN5bmNTZXR0aW5nc0NvbnRyb2xzKHJvb3Q6IFBhcmVudE5vZGUpOiB2b2lkIHtcclxuICByb290LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTElucHV0RWxlbWVudD4oXCJpbnB1dFtkYXRhLXNldHRpbmddXCIpLmZvckVhY2goKGlucHV0KSA9PiB7XHJcbiAgICBjb25zdCBrZXkgPSBpbnB1dC5kYXRhc2V0LnNldHRpbmcgYXMga2V5b2YgU2V0dGluZ3M7XHJcbiAgICBjb25zdCB2YWx1ZSA9IHN0YXRlLnNldHRpbmdzW2tleV07XHJcbiAgICBpZiAoaW5wdXQudHlwZSA9PT0gXCJjaGVja2JveFwiKSBpbnB1dC5jaGVja2VkID0gQm9vbGVhbih2YWx1ZSk7XHJcbiAgICBlbHNlIGlucHV0LnZhbHVlID0gU3RyaW5nKHZhbHVlKTtcclxuICB9KTtcclxuICBjb25zdCB2b2x1bWUgPSBzdGF0ZS5zZXR0aW5ncy5wcmV2aWV3Vm9sdW1lO1xyXG4gIHJvb3QucXVlcnlTZWxlY3RvckFsbChcIi5zYi12b2x1bWUtaWNvblwiKS5mb3JFYWNoKChlbCkgPT4ge1xyXG4gICAgZWwudGV4dENvbnRlbnQgPSB2b2x1bWVJY29uKHZvbHVtZSk7XHJcbiAgICBlbC5zZXRBdHRyaWJ1dGUoXCJhcmlhLWxhYmVsXCIsIHZvbHVtZSA9PT0gMCA/IFwiVW5tdXRlIHByZXZpZXdzXCIgOiBcIk11dGUgcHJldmlld3NcIik7XHJcbiAgfSk7XHJcbiAgcm9vdC5xdWVyeVNlbGVjdG9yQWxsKFwiLnNiLXZvbHVtZS12YWx1ZVwiKS5mb3JFYWNoKChlbCkgPT4gKGVsLnRleHRDb250ZW50ID0gU3RyaW5nKHZvbHVtZSkpKTtcclxufVxyXG5cclxuLyoqIFNob3cgYSB0YWIuIFBhbmVscyBhcmUgc3dhcHBlZCBpbiBwbGFjZSwgc28gbm90aGluZyBhYm92ZSB0aGUgdGFiIGJhciBtb3Zlcy4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHNob3dUYWIocm9vdDogUGFyZW50Tm9kZSwgdGFiOiBUYWJJZCk6IHZvaWQge1xyXG4gIGFjdGl2ZVRhYiA9IHRhYjtcclxuICByb290LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KFwiLnNiLXRhYnMgLm5hdi1saW5rXCIpLmZvckVhY2goKGxpbmspID0+IHtcclxuICAgIGNvbnN0IG9uID0gbGluay5kYXRhc2V0LnRhYiA9PT0gdGFiO1xyXG4gICAgbGluay5jbGFzc0xpc3QudG9nZ2xlKFwiYWN0aXZlXCIsIG9uKTtcclxuICAgIGxpbmsuc2V0QXR0cmlidXRlKFwiYXJpYS1zZWxlY3RlZFwiLCBTdHJpbmcob24pKTtcclxuICB9KTtcclxuICByb290LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KFwiLnNiLXRhYi1wYW5lbFwiKS5mb3JFYWNoKChwYW5lbCkgPT4ge1xyXG4gICAgcGFuZWwuaGlkZGVuID0gcGFuZWwuZGF0YXNldC5wYW5lbCAhPT0gdGFiO1xyXG4gIH0pO1xyXG59XHJcblxyXG4vKipcclxuICogV2lyZSBldmVyeSBkYXRhLXNldHRpbmcgY29udHJvbCwgdGhlIHRhYnMgYW5kIHRoZSBtdXRlIGJ1dHRvbi5cclxuICogb25DaGFuZ2UgcnVucyBhZnRlciBhIHZhbHVlIGlzIHN0b3JlZDsgb25UYWJDaGFuZ2UgYWZ0ZXIgYSB0YWIgc3dpdGNoLlxyXG4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGJpbmRTZXR0aW5nc0NvbnRyb2xzKFxyXG4gIHJvb3Q6IFBhcmVudE5vZGUsXHJcbiAgb25DaGFuZ2U6IChrZXk6IGtleW9mIFNldHRpbmdzKSA9PiB2b2lkLFxyXG4gIG9uVGFiQ2hhbmdlOiAodGFiOiBUYWJJZCkgPT4gdm9pZCxcclxuKTogdm9pZCB7XHJcbiAgY29uc3QgYXBwbHkgPSAocGF0Y2g6IFBhcnRpYWw8U2V0dGluZ3M+LCBrZXk6IGtleW9mIFNldHRpbmdzKTogdm9pZCA9PiB7XHJcbiAgICB1cGRhdGVTZXR0aW5ncyhwYXRjaCk7XHJcbiAgICBzeW5jU2V0dGluZ3NDb250cm9scyhyb290KTtcclxuICAgIG9uQ2hhbmdlKGtleSk7XHJcbiAgfTtcclxuXHJcbiAgcm9vdC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxJbnB1dEVsZW1lbnQ+KFwiaW5wdXRbZGF0YS1zZXR0aW5nXVwiKS5mb3JFYWNoKChpbnB1dCkgPT4ge1xyXG4gICAgY29uc3Qga2V5ID0gaW5wdXQuZGF0YXNldC5zZXR0aW5nIGFzIGtleW9mIFNldHRpbmdzO1xyXG4gICAgLy8gUmFuZ2UgdXBkYXRlcyBsaXZlIHdoaWxlIGRyYWdnaW5nOyBvdGhlcnMgb24gY29tbWl0XHJcbiAgICBjb25zdCBldmVudE5hbWUgPSBpbnB1dC50eXBlID09PSBcInJhbmdlXCIgPyBcImlucHV0XCIgOiBcImNoYW5nZVwiO1xyXG4gICAgaW5wdXQuYWRkRXZlbnRMaXN0ZW5lcihldmVudE5hbWUsICgpID0+IHtcclxuICAgICAgY29uc3QgdmFsdWUgPSBpbnB1dC50eXBlID09PSBcImNoZWNrYm94XCIgPyBpbnB1dC5jaGVja2VkIDogTnVtYmVyKGlucHV0LnZhbHVlKTtcclxuICAgICAgYXBwbHkoeyBba2V5XTogdmFsdWUgfSBhcyBQYXJ0aWFsPFNldHRpbmdzPiwga2V5KTtcclxuICAgIH0pO1xyXG4gIH0pO1xyXG5cclxuICAvLyBTcGVha2VyIGljb246IG11dGUsIG9yIHJlc3RvcmUgdGhlIGxldmVsIGZyb20gYmVmb3JlIG11dGluZ1xyXG4gIHJvb3QucXVlcnlTZWxlY3RvckFsbDxIVE1MQnV0dG9uRWxlbWVudD4oXCIuc2Itdm9sdW1lLWljb25cIikuZm9yRWFjaCgoYnRuKSA9PiB7XHJcbiAgICBidG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHtcclxuICAgICAgY29uc3QgY3VycmVudCA9IHN0YXRlLnNldHRpbmdzLnByZXZpZXdWb2x1bWU7XHJcbiAgICAgIGlmIChjdXJyZW50ID4gMCkge1xyXG4gICAgICAgIHZvbHVtZUJlZm9yZU11dGUgPSBjdXJyZW50O1xyXG4gICAgICAgIGFwcGx5KHsgcHJldmlld1ZvbHVtZTogMCB9LCBcInByZXZpZXdWb2x1bWVcIik7XHJcbiAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgYXBwbHkoeyBwcmV2aWV3Vm9sdW1lOiB2b2x1bWVCZWZvcmVNdXRlID8/IERFRkFVTFRfVU5NVVRFX1ZPTFVNRSB9LCBcInByZXZpZXdWb2x1bWVcIik7XHJcbiAgICAgIH1cclxuICAgIH0pO1xyXG4gIH0pO1xyXG5cclxuICByb290LnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KFwiLnNiLXRhYnMgLm5hdi1saW5rXCIpLmZvckVhY2goKGxpbmspID0+IHtcclxuICAgIGxpbmsuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHtcclxuICAgICAgY29uc3QgdGFiID0gbGluay5kYXRhc2V0LnRhYiBhcyBUYWJJZDtcclxuICAgICAgaWYgKHRhYiA9PT0gYWN0aXZlVGFiKSByZXR1cm47XHJcbiAgICAgIHNob3dUYWIocm9vdCwgdGFiKTtcclxuICAgICAgb25UYWJDaGFuZ2UodGFiKTtcclxuICAgIH0pO1xyXG4gIH0pO1xyXG59XHJcbiIsICIvLyBDb3JlIGNvbXBhcmlzb24gVUk6IGxheW91dCwgcGFpciByZW5kZXJpbmcsIGNob2ljZSBoYW5kbGluZywgYW5pbWF0aW9ucy5cclxuXHJcbmltcG9ydCB7IGNsZWFyRmlsdGVyZWRDYWNoZSwgcmVtb3ZlU2NlbmVFdmVyeXdoZXJlLCBzYW5kYm94U2NlbmUgfSBmcm9tIFwiLi4vY2FjaGVcIjtcclxuaW1wb3J0IHsgY2FsY3VsYXRlUmF0aW5nQ2hhbmdlcywgZWZmZWN0aXZlUmF0aW5nIH0gZnJvbSBcIi4uL2Vsb1wiO1xyXG5pbXBvcnQgeyBDTElNQl9LX1BMQVlfQ09VTlQsIENMSU1CX1NNQUxMX1BPT0xfV0FSTl9BVCB9IGZyb20gXCIuLi9jb25zdGFudHNcIjtcclxuaW1wb3J0IHsgcmVhZEZpbHRlcnMgfSBmcm9tIFwiLi4vZmlsdGVyc1wiO1xyXG5pbXBvcnQgeyBmZXRjaFNjZW5lQnlJZCB9IGZyb20gXCIuLi9ncmFwaHFsXCI7XHJcbmltcG9ydCB7IG5hdmlnYXRlVG9VcmwgfSBmcm9tIFwiLi4vbmF2aWdhdGlvblwiO1xyXG5pbXBvcnQge1xyXG4gIGFwcGx5Q2xpbWJXaW5SYXRpbmcsXHJcbiAgZmV0Y2hDaGFtcGlvblBhaXIsXHJcbiAgZmV0Y2hHYXVudGxldFBhaXIsXHJcbiAgZmV0Y2hQbGFjZW1lbnRQYWlyLFxyXG4gIGZldGNoU3dpc3NQYWlyLFxyXG4gIGxvYWRQb29sU2l6ZSxcclxuICByZWNvcmRQbGFjZW1lbnRSZXN1bHQsXHJcbn0gZnJvbSBcIi4uL3BhaXJzXCI7XHJcbmltcG9ydCB7IHJhdGluZ3NFbmFibGVkLCB1cGRhdGVTY2VuZVJhdGluZyB9IGZyb20gXCIuLi9yYXRpbmdcIjtcclxuaW1wb3J0IHsgZmluZEV4aXN0aW5nU2NlbmVJZHMgfSBmcm9tIFwiLi4vc2NlbmVBY3Rpb25zXCI7XHJcbmltcG9ydCB7IGlzUnVuQWN0aXZlLCByZXNldFJ1blN0YXRlLCByZXNldFNodWZmbGUsIHN0YXRlIH0gZnJvbSBcIi4uL3N0YXRlXCI7XHJcbmltcG9ydCB7IHNhdmVTdGF0ZSB9IGZyb20gXCIuLi9zdG9yYWdlXCI7XHJcbmltcG9ydCB0eXBlIHsgQmF0dGxlU2lkZSwgQ29tcGFyaXNvbkRlbHRhcywgTW9kZSwgUmFuaywgU2NlbmUgfSBmcm9tIFwiLi4vdHlwZXNcIjtcclxuaW1wb3J0IHsgY29uZmlybURlbGV0ZVNjZW5lIH0gZnJvbSBcIi4vZGVsZXRlRGlhbG9nXCI7XHJcbmltcG9ydCB7IGNyZWF0ZVNjZW5lQ2FyZCB9IGZyb20gXCIuL3NjZW5lQ2FyZFwiO1xyXG5pbXBvcnQgeyBzaG93UGxhY2VtZW50U2NyZWVuLCBzaG93VmljdG9yeVNjcmVlbiB9IGZyb20gXCIuL3NjcmVlbnNcIjtcclxuaW1wb3J0IHsgY3JlYXRlU2V0dGluZ3NUYWIsIGNyZWF0ZVRhYkJhciwgZ2V0QWN0aXZlVGFiIH0gZnJvbSBcIi4vc2V0dGluZ3NQYW5lbFwiO1xyXG5cclxuY29uc3QgTU9ERVM6IHsgbW9kZTogTW9kZTsgaWNvbjogc3RyaW5nOyB0aXRsZTogc3RyaW5nOyBkZXNjOiBzdHJpbmc7IHRpcDogc3RyaW5nIH1bXSA9IFtcclxuICB7XHJcbiAgICBtb2RlOiBcInN3aXNzXCIsXHJcbiAgICBpY29uOiBcIuKalu+4j1wiLFxyXG4gICAgdGl0bGU6IFwiU3dpc3NcIixcclxuICAgIGRlc2M6IFwiRmFpciBtYXRjaHVwc1wiLFxyXG4gICAgdGlwOiBcIkVhY2ggc2NlbmUgZmFjZXMgYW4gb3Bwb25lbnQgd2l0aCBhIHNpbWlsYXIgcmF0aW5nLiBCb3RoIHJhdGluZ3MgY2hhbmdlIGFmdGVyIGV2ZXJ5IHBpY2ssIGFuZCBldmVyeSBzY2VuZSBzdGF5cyBpbiB0aGUgcm90YXRpb24uXCIsXHJcbiAgfSxcclxuICB7XHJcbiAgICBtb2RlOiBcInBsYWNlbWVudFwiLFxyXG4gICAgaWNvbjogXCLwn5ONXCIsXHJcbiAgICB0aXRsZTogXCJQbGFjZW1lbnRcIixcclxuICAgIGRlc2M6IFwiUGxhY2UgYSBzY2VuZVwiLFxyXG4gICAgdGlwOiBcIkZpbmRzIHdoZXJlIG9uZSBzY2VuZSBiZWxvbmdzLiBFYWNoIHBpY2sgbmFycm93cyB0aGUgcmFuZ2Ugb2YgcmFua3MgaXQgY291bGQgbGFuZCBpbiAoc2hvd24gb24gaXRzIGNhcmQpIHVudGlsIGl0cyBzcG90IGlzIGZvdW5kLCBhYm91dCAxMCBwaWNrcyBmb3IgYW4gdW5yYXRlZCBzY2VuZS4gT25seSBpdHMgcmF0aW5nIGNoYW5nZXMsIG9uY2UgYXQgdGhlIGVuZC5cIixcclxuICB9LFxyXG4gIHtcclxuICAgIG1vZGU6IFwiZ2F1bnRsZXRcIixcclxuICAgIGljb246IFwi8J+Or1wiLFxyXG4gICAgdGl0bGU6IFwiR2F1bnRsZXRcIixcclxuICAgIGRlc2M6IFwiQ2xpbWIgdGhlIGxhZGRlclwiLFxyXG4gICAgdGlwOiBcIkEgc2NlbmUgc3RhcnRzIGF0IHRoZSBib3R0b20gYW5kIGNsaW1icyBieSBiZWF0aW5nIHRoZSBzY2VuZXMgYWJvdmUgaXQuIFdoZW4gaXQgbG9zZXMsIGl0IGZhbGxzIHVudGlsIGl0IGZpbmRzIGl0cyBmbG9vci4gT25seSB0aGUgY2xpbWJlcidzIHJhdGluZyBjaGFuZ2VzLlwiLFxyXG4gIH0sXHJcbiAge1xyXG4gICAgbW9kZTogXCJjaGFtcGlvblwiLFxyXG4gICAgaWNvbjogXCLwn4+GXCIsXHJcbiAgICB0aXRsZTogXCJDaGFtcGlvblwiLFxyXG4gICAgZGVzYzogXCJXaW5uZXIgc3RheXMgb25cIixcclxuICAgIHRpcDogXCJXaW5uZXIgc3RheXMgb246IHRoZSBzY2VuZSB5b3UgcGljayBrZWVwcyBkZWZlbmRpbmcgYWdhaW5zdCBuZXcgY2hhbGxlbmdlcnMgdW50aWwgaXQncyBiZWF0ZW4sIHRoZW4gdGhlIHdpbm5lciB0YWtlcyBvdmVyLlwiLFxyXG4gIH0sXHJcbl07XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlTWFpblVJKCk6IHN0cmluZyB7XHJcbiAgY29uc3QgbW9kZUJ1dHRvbnMgPSBNT0RFUy5tYXAoXHJcbiAgICAoeyBtb2RlLCBpY29uLCB0aXRsZSwgZGVzYywgdGlwIH0pID0+IGBcclxuICAgICAgICAgICAgPGJ1dHRvbiBjbGFzcz1cInNiLW1vZGUtYnRuICR7c3RhdGUuY3VycmVudE1vZGUgPT09IG1vZGUgPyBcImFjdGl2ZVwiIDogXCJcIn1cIiBkYXRhLW1vZGU9XCIke21vZGV9XCIgZGF0YS10aXA9XCIke3RpcH1cIiBhcmlhLWRlc2NyaXB0aW9uPVwiJHt0aXB9XCI+XHJcbiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9XCJzYi1tb2RlLWljb25cIj4ke2ljb259PC9zcGFuPlxyXG4gICAgICAgICAgICAgIDxzcGFuIGNsYXNzPVwic2ItbW9kZS10aXRsZVwiPiR7dGl0bGV9PC9zcGFuPlxyXG4gICAgICAgICAgICAgIDxzcGFuIGNsYXNzPVwic2ItbW9kZS1kZXNjXCI+JHtkZXNjfTwvc3Bhbj5cclxuICAgICAgICAgICAgPC9idXR0b24+YCxcclxuICApLmpvaW4oXCJcIik7XHJcblxyXG4gIHJldHVybiBgXHJcbiAgICAgIDxkaXYgaWQ9XCJzdGFzaC1iYXR0bGUtY29udGFpbmVyXCIgY2xhc3M9XCJzYi1jb250YWluZXJcIj5cclxuICAgICAgICA8ZGl2IGNsYXNzPVwic2ItaGVhZGVyXCI+XHJcbiAgICAgICAgICA8aDEgY2xhc3M9XCJzYi10aXRsZVwiPuKalO+4jyBTdGFzaCBCYXR0bGU8L2gxPlxyXG4gICAgICAgICAgPHAgY2xhc3M9XCJzYi1zdWJ0aXRsZVwiPkNvbXBhcmUgc2NlbmVzIGhlYWQtdG8taGVhZCB0byBidWlsZCB5b3VyIHJhbmtpbmdzPC9wPlxyXG4gICAgICAgICAgJHtjcmVhdGVUYWJCYXIoKX1cclxuICAgICAgICA8L2Rpdj5cclxuXHJcbiAgICAgICAgPGRpdiBjbGFzcz1cInNiLXRhYi1wYW5lbFwiIGRhdGEtcGFuZWw9XCJiYXR0bGVcIj5cclxuICAgICAgICAgIDxwIGlkPVwic2ItZnVuLWJhZGdlXCIgY2xhc3M9XCJzYi1mdW4tYmFkZ2VcIiAke3N0YXRlLnNldHRpbmdzLmZ1bk1vZGUgPyBcIlwiIDogXCJoaWRkZW5cIn0+8J+OiCBGdW4gbW9kZTogcmF0aW5ncyBhcmUgbm90IHNhdmVkPC9wPlxyXG4gICAgICAgICAgPGRpdiBjbGFzcz1cInNiLW1vZGUtcm93XCI+XHJcbiAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1tb2RlLXRvZ2dsZVwiPiR7bW9kZUJ1dHRvbnN9XHJcbiAgICAgICAgICAgIDwvZGl2PlxyXG4gICAgICAgICAgICA8YnV0dG9uIHR5cGU9XCJidXR0b25cIiBjbGFzcz1cInNiLW1vZGUtaW5mby1idG5cIiBhcmlhLWNvbnRyb2xzPVwic2ItbW9kZS1pbmZvXCIgYXJpYS1leHBhbmRlZD1cImZhbHNlXCIgYXJpYS1sYWJlbD1cIldoYXQgZG9lcyB0aGlzIG1vZGUgZG8/XCI+4pOYPC9idXR0b24+XHJcbiAgICAgICAgICA8L2Rpdj5cclxuICAgICAgICAgIDxwIGlkPVwic2ItbW9kZS1pbmZvXCIgY2xhc3M9XCJzYi1tb2RlLWluZm9cIiBoaWRkZW4+PC9wPlxyXG5cclxuICAgICAgICAgIDxwIGlkPVwic2ItY2xpbWItcG9vbC13YXJuaW5nXCIgY2xhc3M9XCJzYi1jbGltYi13YXJuaW5nXCIgaGlkZGVuPlxyXG4gICAgICAgICAgICBHYXVudGxldCBhbmQgQ2hhbXBpb24gY2FuIGJlaGF2ZSBvZGRseSB3aXRoIHNtYWxsIGZpbHRlcmVkIHBvb2xzIHdoZW4gYm90aCBzaWRlcyB1c2UgdGhlIGZpbHRlclxyXG4gICAgICAgICAgICAoZmV3ZXIgdGhhbiAke0NMSU1CX1NNQUxMX1BPT0xfV0FSTl9BVH0gc2NlbmVzKS4gVXNlIGEgbGFyZ2VyIGZpbHRlciwgb3IgdHVybiBvZmZcclxuICAgICAgICAgICAgXCJVc2UgZmlsdGVyZWQgc2NlbmVzIGZvciBib3RoIHNpZGVzXCIgaW4gU2V0dGluZ3MuXHJcbiAgICAgICAgICA8L3A+XHJcblxyXG4gICAgICAgICAgPHAgaWQ9XCJzYi1wb29sLXN0YXR1c1wiIGNsYXNzPVwic2ItcG9vbC1zdGF0dXNcIiBoaWRkZW4+PC9wPlxyXG5cclxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1jb250ZW50XCI+XHJcbiAgICAgICAgICAgIDxkaXYgaWQ9XCJzYi1jb21wYXJpc29uLWFyZWFcIiBjbGFzcz1cInNiLWNvbXBhcmlzb24tYXJlYVwiPlxyXG4gICAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1sb2FkaW5nXCI+TG9hZGluZyBzY2VuZXMuLi48L2Rpdj5cclxuICAgICAgICAgICAgPC9kaXY+XHJcbiAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1hY3Rpb25zXCI+XHJcbiAgICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNiLWFjdGlvbi1idXR0b25zXCI+XHJcbiAgICAgICAgICAgICAgICA8YnV0dG9uIGlkPVwic2Itc2tpcC1idG5cIiBjbGFzcz1cImJ0biBidG4tc2Vjb25kYXJ5XCI+U2tpcDwvYnV0dG9uPlxyXG4gICAgICAgICAgICAgICAgPGJ1dHRvbiBpZD1cInNiLXJlZnJlc2gtY2FjaGUtYnRuXCIgY2xhc3M9XCJidG4gYnRuLXNlY29uZGFyeVwiIHRpdGxlPVwiUmVmcmVzaCBzY2VuZSBsaXN0IGZyb20gc2VydmVyICh1c2UgaWYgeW91J3ZlIGFkZGVkIG5ldyBzY2VuZXMpXCI+8J+UhCBSZWZyZXNoPC9idXR0b24+XHJcbiAgICAgICAgICAgICAgPC9kaXY+XHJcbiAgICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNiLWtleWJvYXJkLWhpbnRcIj5cclxuICAgICAgICAgICAgICAgIDxzcGFuPuKGkDwvc3Bhbj4gY2hvb3NlIGxlZnQgwrdcclxuICAgICAgICAgICAgICAgIDxzcGFuPuKGkjwvc3Bhbj4gY2hvb3NlIHJpZ2h0IMK3XHJcbiAgICAgICAgICAgICAgICA8c3Bhbj5TcGFjZTwvc3Bhbj4gc2tpcFxyXG4gICAgICAgICAgICAgIDwvZGl2PlxyXG4gICAgICAgICAgICA8L2Rpdj5cclxuICAgICAgICAgIDwvZGl2PlxyXG4gICAgICAgIDwvZGl2PlxyXG5cclxuICAgICAgICAke2NyZWF0ZVNldHRpbmdzVGFiKCl9XHJcbiAgICAgIDwvZGl2PlxyXG4gICAgYDtcclxufVxyXG5cclxuLyoqIFRvdWNoIHNjcmVlbnMgaGF2ZSBubyBob3ZlciB0b29sdGlwczogdGhlIOKTmCBidXR0b24gc2hvd3MgdGhlIGN1cnJlbnQgbW9kZSdzIGV4cGxhbmF0aW9uIGhlcmUuICovXHJcbmV4cG9ydCBmdW5jdGlvbiB1cGRhdGVNb2RlSW5mbygpOiB2b2lkIHtcclxuICBjb25zdCBpbmZvID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzYi1tb2RlLWluZm9cIik7XHJcbiAgY29uc3QgbW9kZSA9IE1PREVTLmZpbmQoKG0pID0+IG0ubW9kZSA9PT0gc3RhdGUuY3VycmVudE1vZGUpO1xyXG4gIGlmIChpbmZvICYmIG1vZGUpIGluZm8uaW5uZXJIVE1MID0gYDxzdHJvbmc+JHttb2RlLmljb259ICR7bW9kZS50aXRsZX06PC9zdHJvbmc+ICR7bW9kZS50aXB9YDtcclxufVxyXG5cclxuLyoqIFwiV2hpY2ggc2NlbmVzIGFtIEkgcmF0aW5nP1wiIGxpbmUgYWJvdmUgdGhlIGNhcmRzOiB0aGUgU2NlbmVzIHBhZ2UgZmlsdGVyIG9yIHRoZSB3aG9sZSBsaWJyYXJ5LiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gdXBkYXRlUG9vbFN0YXR1cygpOiB2b2lkIHtcclxuICBjb25zdCBzdGF0dXMgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInNiLXBvb2wtc3RhdHVzXCIpO1xyXG4gIGlmICghc3RhdHVzKSByZXR1cm47XHJcbiAgY29uc3QgY291bnQgPSBzdGF0ZS5sZWZ0UG9vbFNpemU7XHJcbiAgY29uc3QgY291bnRIdG1sID1cclxuICAgIGNvdW50ID09PSBudWxsID8gXCJcIiA6IGAgwrcgPHN0cm9uZz4ke2NvdW50fSBzY2VuZSR7Y291bnQgPT09IDEgPyBcIlwiIDogXCJzXCJ9PC9zdHJvbmc+YDtcclxuXHJcbiAgaWYgKHJlYWRGaWx0ZXJzKCkuZmlsdGVyQWN0aXZlKSB7XHJcbiAgICBjb25zdCBvcHBvbmVudHMgPSBzdGF0ZS5zZXR0aW5ncy5maWx0ZXJPcHBvbmVudHMgPyBcIiDCtyBvcHBvbmVudHMgZnJvbSB0aGUgZmlsdGVyIHRvb1wiIDogXCJcIjtcclxuICAgIHN0YXR1cy5pbm5lckhUTUwgPSBgUmF0aW5nIHNjZW5lcyBmcm9tIHlvdXIgU2NlbmVzIHBhZ2UgZmlsdGVyJHtjb3VudEh0bWx9JHtvcHBvbmVudHN9YDtcclxuICB9IGVsc2Uge1xyXG4gICAgc3RhdHVzLmlubmVySFRNTCA9IGBSYXRpbmcgc2NlbmVzIGZyb20geW91ciB3aG9sZSBsaWJyYXJ5JHtjb3VudEh0bWx9PHNwYW4gY2xhc3M9XCJzYi1wb29sLWhpbnRcIj4gwrcgZmlsdGVyIHRoZSBTY2VuZXMgcGFnZSB0byBuYXJyb3cgaXQgZG93bjwvc3Bhbj5gO1xyXG4gIH1cclxuICBzdGF0dXMuaGlkZGVuID0gZmFsc2U7XHJcbn1cclxuXHJcbi8qKiBTaG93L2hpZGUgdGhlIGZ1biBtb2RlIGJhZGdlIHRvIG1hdGNoIHRoZSBzZXR0aW5nLiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gdXBkYXRlRnVuQmFkZ2UoKTogdm9pZCB7XHJcbiAgY29uc3QgYmFkZ2UgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInNiLWZ1bi1iYWRnZVwiKTtcclxuICBpZiAoYmFkZ2UpIGJhZGdlLmhpZGRlbiA9ICFzdGF0ZS5zZXR0aW5ncy5mdW5Nb2RlO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjbGltYlN0YXR1c0JhZGdlKHNjZW5lOiBTY2VuZSk6IG51bWJlciB8IHN0cmluZyB8IG51bGwge1xyXG4gIGlmIChzdGF0ZS5jdXJyZW50TW9kZSA9PT0gXCJwbGFjZW1lbnRcIikge1xyXG4gICAgY29uc3QgcnVuID0gc3RhdGUucGxhY2VtZW50O1xyXG4gICAgaWYgKHJ1bj8uc2NlbmUuaWQgIT09IHNjZW5lLmlkIHx8IHJ1bi5yYW5nZUhpID09PSBydW4ucmFuZ2VMbykgcmV0dXJuIG51bGw7XHJcbiAgICByZXR1cm4gYPCfk40gTmFycm93aW5nIGJldHdlZW4gIyR7cnVuLnJhbmdlTG8gKyAxfSBhbmQgIyR7cnVuLnJhbmdlSGkgKyAxfWA7XHJcbiAgfVxyXG4gIGlmIChzdGF0ZS5jdXJyZW50TW9kZSAhPT0gXCJnYXVudGxldFwiICYmIHN0YXRlLmN1cnJlbnRNb2RlICE9PSBcImNoYW1waW9uXCIpIHJldHVybiBudWxsO1xyXG4gIGlmIChzdGF0ZS5nYXVudGxldEZhbGxpbmcgJiYgc3RhdGUuZ2F1bnRsZXRGYWxsaW5nU2NlbmU/LmlkID09PSBzY2VuZS5pZCkge1xyXG4gICAgcmV0dXJuIFwi8J+TjSBGaW5kaW5nIGZpbmFsIHBsYWNlbWVudC4uLlwiO1xyXG4gIH1cclxuICBpZiAoc3RhdGUuZ2F1bnRsZXRDbGltYmVyPy5pZCA9PT0gc2NlbmUuaWQpIHtcclxuICAgIHJldHVybiBzdGF0ZS5nYXVudGxldFdpbnM7XHJcbiAgfVxyXG4gIHJldHVybiBudWxsO1xyXG59XHJcblxyXG4vKiogUHJlY29tcHV0ZWQgd2lubmVyL2xvc2VyIGNvbnRleHQgd2lyZWQgYXQgcmVuZGVyIHRpbWUgZm9yIGVhY2ggY2hvb3NlIGJ1dHRvbi4gKi9cclxuaW50ZXJmYWNlIFNjZW5lQ2hvaWNlIHtcclxuICB3aW5uZXI6IFNjZW5lO1xyXG4gIGxvc2VyOiBTY2VuZTtcclxuICBsZWZ0OiBTY2VuZTtcclxuICByaWdodDogU2NlbmU7XHJcbiAgd2lubmVyQ2FyZDogSFRNTEVsZW1lbnQ7XHJcbiAgbG9zZXJDYXJkOiBIVE1MRWxlbWVudDtcclxuICB3aW5uZXJSYW5rOiBSYW5rO1xyXG4gIGxvc2VyUmFuazogUmFuaztcclxufVxyXG5cclxuZnVuY3Rpb24gYmluZFNjZW5lQ2hvaWNlKGJvZHk6IEhUTUxFbGVtZW50LCBjaG9pY2U6IFNjZW5lQ2hvaWNlKTogdm9pZCB7XHJcbiAgYm9keS5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4gaGFuZGxlU2NlbmVDaG9pY2UoY2hvaWNlKSk7XHJcbn1cclxuXHJcbi8qKiBTaG93IG9yIGhpZGUgdGhlIFNraXAgLyBSZWZyZXNoIGJhci4gT25seSBlbmQgc2NyZWVucyBoaWRlIGl0OyBldmVyeSByZW5kZXJlZCBwYWlyIHNob3dzIGl0LiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gc2V0QWN0aW9uc1Zpc2libGUodmlzaWJsZTogYm9vbGVhbik6IHZvaWQge1xyXG4gIGNvbnN0IGFjdGlvbnNFbCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiLnNiLWFjdGlvbnNcIik7XHJcbiAgaWYgKGFjdGlvbnNFbCkgYWN0aW9uc0VsLnN0eWxlLmRpc3BsYXkgPSB2aXNpYmxlID8gXCJcIiA6IFwibm9uZVwiO1xyXG59XHJcblxyXG4vKiogVG91Y2ggZGV2aWNlcyBoYXZlIG5vIGhvdmVyOiB0aHVtYm5haWxzIHRvZ2dsZSB0aGUgcHJldmlldyBpbnN0ZWFkIG9mIG9wZW5pbmcgdGhlIHNjZW5lLiAqL1xyXG5mdW5jdGlvbiBpc1RvdWNoRGV2aWNlKCk6IGJvb2xlYW4ge1xyXG4gIHJldHVybiB3aW5kb3cubWF0Y2hNZWRpYShcIihob3Zlcjogbm9uZSlcIikubWF0Y2hlcztcclxufVxyXG5cclxuLyoqIFRodW1ibmFpbCAvIOKGlyBsaW5rIGNsaWNrOiBuYXRpdmUgbGluayBmb3IgbmV3IHRhYiBvciBtb2RpZmllciBjbGlja3MsIFNQQSBuYXZpZ2F0aW9uIG90aGVyd2lzZS4gKi9cclxuZnVuY3Rpb24gaGFuZGxlU2NlbmVMaW5rQ2xpY2soZTogTW91c2VFdmVudCwgbGluazogSFRNTEFuY2hvckVsZW1lbnQpOiB2b2lkIHtcclxuICBjb25zdCBuYXRpdmVOZXdUYWIgPSBsaW5rLnRhcmdldCA9PT0gXCJfYmxhbmtcIiAmJiBzdGF0ZS5zZXR0aW5ncy5vcGVuSW5OZXdUYWI7XHJcbiAgaWYgKG5hdGl2ZU5ld1RhYiB8fCBlLmN0cmxLZXkgfHwgZS5tZXRhS2V5IHx8IGUuc2hpZnRLZXkgfHwgZS5idXR0b24gIT09IDApIHJldHVybjtcclxuICBlLnByZXZlbnREZWZhdWx0KCk7XHJcbiAgbmF2aWdhdGVUb1VybChsaW5rLmdldEF0dHJpYnV0ZShcImhyZWZcIikgfHwgXCJcIik7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBTbGlkZXIgKDAtMTAwKSB0byBtZWRpYSB2b2x1bWUgb24gYSBjdWJpYyBjdXJ2ZSwgc28gdGhlIHNsaWRlciB0cmFja3MgcGVyY2VpdmVkIGxvdWRuZXNzLlxyXG4gKiAoU3Rhc2gncyBwbGF5ZXIgaXMgbGluZWFyLCBidXQgZ2VuZXJhdGVkIHByZXZpZXcgY2xpcHMgYXJlIG11Y2ggbG91ZGVyIHRoYW4gdGhlIHNvdXJjZS4pXHJcbiAqL1xyXG5mdW5jdGlvbiBzbGlkZXJUb1ZvbHVtZShzbGlkZXI6IG51bWJlcik6IG51bWJlciB7XHJcbiAgcmV0dXJuIE1hdGgucG93KHNsaWRlciAvIDEwMCwgMyk7XHJcbn1cclxuXHJcbi8qKiBBcHBseSB2b2x1bWUvYXV0b3BsYXkgc2V0dGluZ3MgdG8gdGhlIHJlbmRlcmVkIHByZXZpZXcgdmlkZW9zIChob3ZlcmVkIGNhcmQgaXMgYXVkaWJsZSkuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBhcHBseVByZXZpZXdTZXR0aW5ncygpOiB2b2lkIHtcclxuICBjb25zdCB7IHByZXZpZXdWb2x1bWUsIGF1dG9wbGF5UHJldmlld3MgfSA9IHN0YXRlLnNldHRpbmdzO1xyXG4gIGNvbnN0IGJhdHRsZVZpc2libGUgPSBnZXRBY3RpdmVUYWIoKSA9PT0gXCJiYXR0bGVcIjtcclxuICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKFwiLnNiLXZzLWNvbnRhaW5lclwiKT8uY2xhc3NMaXN0LnRvZ2dsZShcInNiLWF1dG9wbGF5XCIsIGF1dG9wbGF5UHJldmlld3MpO1xyXG5cclxuICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PihcIiNzYi1jb21wYXJpc29uLWFyZWEgLnNiLXNjZW5lLWNhcmRcIikuZm9yRWFjaCgoY2FyZCkgPT4ge1xyXG4gICAgY29uc3QgdmlkZW8gPSBjYXJkLnF1ZXJ5U2VsZWN0b3I8SFRNTFZpZGVvRWxlbWVudD4oXCIuc2ItaG92ZXItcHJldmlld1wiKTtcclxuICAgIGlmICghdmlkZW8pIHJldHVybjtcclxuICAgIGNvbnN0IGFjdGl2ZSA9IGNhcmQubWF0Y2hlcyhcIjpob3ZlclwiKSB8fCBjYXJkLmNsYXNzTGlzdC5jb250YWlucyhcInNiLXByZXZpZXdpbmdcIik7XHJcbiAgICB2aWRlby52b2x1bWUgPSBzbGlkZXJUb1ZvbHVtZShwcmV2aWV3Vm9sdW1lKTtcclxuICAgIHZpZGVvLm11dGVkID0gIWFjdGl2ZSB8fCBwcmV2aWV3Vm9sdW1lID09PSAwO1xyXG4gICAgaWYgKGJhdHRsZVZpc2libGUgJiYgKGF1dG9wbGF5UHJldmlld3MgfHwgYWN0aXZlKSkge1xyXG4gICAgICBpZiAodmlkZW8ucGF1c2VkKSB2aWRlby5wbGF5KCkuY2F0Y2goKCkgPT4ge30pO1xyXG4gICAgfSBlbHNlIHtcclxuICAgICAgdmlkZW8ucGF1c2UoKTtcclxuICAgICAgdmlkZW8uY3VycmVudFRpbWUgPSAwO1xyXG4gICAgfVxyXG4gIH0pO1xyXG59XHJcblxyXG5mdW5jdGlvbiBiaW5kUHJldmlldyhjYXJkOiBIVE1MRWxlbWVudCk6IHZvaWQge1xyXG4gIGNvbnN0IHZpZGVvID0gY2FyZC5xdWVyeVNlbGVjdG9yPEhUTUxWaWRlb0VsZW1lbnQ+KFwiLnNiLWhvdmVyLXByZXZpZXdcIik7XHJcbiAgaWYgKCF2aWRlbykgcmV0dXJuO1xyXG5cclxuICBjYXJkLmFkZEV2ZW50TGlzdGVuZXIoXCJtb3VzZWVudGVyXCIsICgpID0+IHtcclxuICAgIGlmIChpc1RvdWNoRGV2aWNlKCkpIHJldHVybjtcclxuICAgIGlmICghc3RhdGUuc2V0dGluZ3MuYXV0b3BsYXlQcmV2aWV3cykgdmlkZW8uY3VycmVudFRpbWUgPSAwO1xyXG4gICAgdmlkZW8udm9sdW1lID0gc2xpZGVyVG9Wb2x1bWUoc3RhdGUuc2V0dGluZ3MucHJldmlld1ZvbHVtZSk7XHJcbiAgICB2aWRlby5tdXRlZCA9IHN0YXRlLnNldHRpbmdzLnByZXZpZXdWb2x1bWUgPT09IDA7XHJcbiAgICB2aWRlby5wbGF5KCkuY2F0Y2goKCkgPT4ge30pO1xyXG4gIH0pO1xyXG5cclxuICBjYXJkLmFkZEV2ZW50TGlzdGVuZXIoXCJtb3VzZWxlYXZlXCIsICgpID0+IHtcclxuICAgIGlmIChpc1RvdWNoRGV2aWNlKCkpIHJldHVybjtcclxuICAgIGlmIChzdGF0ZS5zZXR0aW5ncy5hdXRvcGxheVByZXZpZXdzKSB7XHJcbiAgICAgIHZpZGVvLm11dGVkID0gdHJ1ZTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgdmlkZW8ucGF1c2UoKTtcclxuICAgIHZpZGVvLmN1cnJlbnRUaW1lID0gMDtcclxuICB9KTtcclxufVxyXG5cclxuLyoqIFRvdWNoOiB0YXAgdGhlIHRodW1ibmFpbCB0byBwbGF5L3N0b3AgaXRzIHByZXZpZXcgd2l0aCBzb3VuZC4gKi9cclxuZnVuY3Rpb24gdG9nZ2xlUHJldmlldyhjYXJkOiBIVE1MRWxlbWVudCk6IHZvaWQge1xyXG4gIGNvbnN0IHByZXZpZXdpbmcgPSAhY2FyZC5jbGFzc0xpc3QuY29udGFpbnMoXCJzYi1wcmV2aWV3aW5nXCIpO1xyXG4gIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoXCIuc2Itc2NlbmUtY2FyZC5zYi1wcmV2aWV3aW5nXCIpLmZvckVhY2goKGMpID0+IGMuY2xhc3NMaXN0LnJlbW92ZShcInNiLXByZXZpZXdpbmdcIikpO1xyXG4gIGNhcmQuY2xhc3NMaXN0LnRvZ2dsZShcInNiLXByZXZpZXdpbmdcIiwgcHJldmlld2luZyk7XHJcbiAgYXBwbHlQcmV2aWV3U2V0dGluZ3MoKTtcclxufVxyXG5cclxuLy8gU2hhcmVkIHJlbmRlcmluZyBsb2dpYyBmb3IgZGlzcGxheWluZyBhIHBhaXIgb2Ygc2NlbmVzXHJcbmV4cG9ydCBmdW5jdGlvbiByZW5kZXJQYWlyKHNjZW5lczogU2NlbmVbXSwgcmFua3M6IFJhbmtbXSk6IHZvaWQge1xyXG4gIGNvbnN0IGNvbXBhcmlzb25BcmVhID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzYi1jb21wYXJpc29uLWFyZWFcIik7XHJcbiAgaWYgKCFjb21wYXJpc29uQXJlYSkgcmV0dXJuO1xyXG5cclxuICBjb25zdCBzdGF0dXNCYWRnZXMgPSBzY2VuZXMubWFwKGNsaW1iU3RhdHVzQmFkZ2UpO1xyXG5cclxuICBjb21wYXJpc29uQXJlYS5pbm5lckhUTUwgPSBgXHJcbiAgICAgIDxkaXYgY2xhc3M9XCJzYi12cy1jb250YWluZXJcIj5cclxuICAgICAgICAke2NyZWF0ZVNjZW5lQ2FyZChzY2VuZXNbMF0sIFwibGVmdFwiLCByYW5rc1swXSwgc3RhdHVzQmFkZ2VzWzBdKX1cclxuICAgICAgICA8ZGl2IGNsYXNzPVwic2ItdnMtZGl2aWRlclwiPlxyXG4gICAgICAgICAgPHNwYW4gY2xhc3M9XCJzYi12cy10ZXh0XCI+VlM8L3NwYW4+XHJcbiAgICAgICAgPC9kaXY+XHJcbiAgICAgICAgJHtjcmVhdGVTY2VuZUNhcmQoc2NlbmVzWzFdLCBcInJpZ2h0XCIsIHJhbmtzWzFdLCBzdGF0dXNCYWRnZXNbMV0pfVxyXG4gICAgICA8L2Rpdj5cclxuICAgIGA7XHJcblxyXG4gIGNvbnN0IGxlZnQgPSBzY2VuZXNbMF07XHJcbiAgY29uc3QgcmlnaHQgPSBzY2VuZXNbMV07XHJcbiAgY29uc3QgbGVmdENhcmQgPSBjb21wYXJpc29uQXJlYS5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PignLnNiLXNjZW5lLWNhcmRbZGF0YS1zaWRlPVwibGVmdFwiXScpO1xyXG4gIGNvbnN0IHJpZ2h0Q2FyZCA9IGNvbXBhcmlzb25BcmVhLnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KCcuc2Itc2NlbmUtY2FyZFtkYXRhLXNpZGU9XCJyaWdodFwiXScpO1xyXG4gIGNvbnN0IGxlZnRCb2R5ID0gbGVmdENhcmQ/LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiLnNiLXNjZW5lLWJvZHlcIik7XHJcbiAgY29uc3QgcmlnaHRCb2R5ID0gcmlnaHRDYXJkPy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIi5zYi1zY2VuZS1ib2R5XCIpO1xyXG5cclxuICBpZiAobGVmdCAmJiByaWdodCAmJiBsZWZ0Q2FyZCAmJiByaWdodENhcmQgJiYgbGVmdEJvZHkgJiYgcmlnaHRCb2R5KSB7XHJcbiAgICBiaW5kU2NlbmVDaG9pY2UobGVmdEJvZHksIHtcclxuICAgICAgd2lubmVyOiBsZWZ0LFxyXG4gICAgICBsb3NlcjogcmlnaHQsXHJcbiAgICAgIGxlZnQsXHJcbiAgICAgIHJpZ2h0LFxyXG4gICAgICB3aW5uZXJDYXJkOiBsZWZ0Q2FyZCxcclxuICAgICAgbG9zZXJDYXJkOiByaWdodENhcmQsXHJcbiAgICAgIHdpbm5lclJhbms6IHJhbmtzWzBdLFxyXG4gICAgICBsb3NlclJhbms6IHJhbmtzWzFdLFxyXG4gICAgfSk7XHJcbiAgICBiaW5kU2NlbmVDaG9pY2UocmlnaHRCb2R5LCB7XHJcbiAgICAgIHdpbm5lcjogcmlnaHQsXHJcbiAgICAgIGxvc2VyOiBsZWZ0LFxyXG4gICAgICBsZWZ0LFxyXG4gICAgICByaWdodCxcclxuICAgICAgd2lubmVyQ2FyZDogcmlnaHRDYXJkLFxyXG4gICAgICBsb3NlckNhcmQ6IGxlZnRDYXJkLFxyXG4gICAgICB3aW5uZXJSYW5rOiByYW5rc1sxXSxcclxuICAgICAgbG9zZXJSYW5rOiByYW5rc1swXSxcclxuICAgIH0pO1xyXG5cclxuICAgIGxlZnRDYXJkLnF1ZXJ5U2VsZWN0b3IoXCIuc2ItZGVsZXRlLWJ0blwiKT8uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHZvaWQgZGVsZXRlRnJvbUJhdHRsZShsZWZ0KSk7XHJcbiAgICByaWdodENhcmQucXVlcnlTZWxlY3RvcihcIi5zYi1kZWxldGUtYnRuXCIpPy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4gdm9pZCBkZWxldGVGcm9tQmF0dGxlKHJpZ2h0KSk7XHJcbiAgfVxyXG5cclxuICBjb21wYXJpc29uQXJlYS5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PihcIi5zYi1zY2VuZS1jYXJkXCIpLmZvckVhY2goKGNhcmQpID0+IHtcclxuICAgIGNvbnN0IHRodW1iID0gY2FyZC5xdWVyeVNlbGVjdG9yPEhUTUxBbmNob3JFbGVtZW50PihcIi5zYi1zY2VuZS1pbWFnZS1jb250YWluZXJcIik7XHJcbiAgICB0aHVtYj8uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XHJcbiAgICAgIGlmIChpc1RvdWNoRGV2aWNlKCkpIHtcclxuICAgICAgICBlLnByZXZlbnREZWZhdWx0KCk7XHJcbiAgICAgICAgdG9nZ2xlUHJldmlldyhjYXJkKTtcclxuICAgICAgICByZXR1cm47XHJcbiAgICAgIH1cclxuICAgICAgaGFuZGxlU2NlbmVMaW5rQ2xpY2soZSwgdGh1bWIpO1xyXG4gICAgfSk7XHJcbiAgICBjb25zdCBvcGVuTGluayA9IGNhcmQucXVlcnlTZWxlY3RvcjxIVE1MQW5jaG9yRWxlbWVudD4oXCIuc2Itb3Blbi1saW5rXCIpO1xyXG4gICAgb3Blbkxpbms/LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZSkgPT4ge1xyXG4gICAgICBpZiAoIXN0YXRlLnNldHRpbmdzLm9wZW5Jbk5ld1RhYikgaGFuZGxlU2NlbmVMaW5rQ2xpY2soZSwgb3BlbkxpbmspO1xyXG4gICAgfSk7XHJcbiAgICBiaW5kUHJldmlldyhjYXJkKTtcclxuICB9KTtcclxuICBhcHBseVByZXZpZXdTZXR0aW5ncygpO1xyXG5cclxuICBzZXRBY3Rpb25zVmlzaWJsZSh0cnVlKTtcclxuXHJcbiAgLy8gVXBkYXRlIHNraXAgYnV0dG9uIHN0YXRlXHJcbiAgY29uc3Qgc2tpcEJ0biA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3I8SFRNTEJ1dHRvbkVsZW1lbnQ+KFwiI3NiLXNraXAtYnRuXCIpO1xyXG4gIGlmIChza2lwQnRuKSBza2lwQnRuLmRpc2FibGVkID0gaXNSdW5BY3RpdmUoKTtcclxufVxyXG5cclxuLyoqIFNraXAgdGhlIGN1cnJlbnQgcGFpciAobm90IGFsbG93ZWQgbWlkLXJ1bikuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBza2lwUGFpcigpOiB2b2lkIHtcclxuICBpZiAoaXNSdW5BY3RpdmUoKSB8fCBzdGF0ZS5kaXNhYmxlQ2hvaWNlKSByZXR1cm47XHJcbiAgc3RhdGUuZGlzYWJsZUNob2ljZSA9IHRydWU7XHJcbiAgaWYgKHN0YXRlLmN1cnJlbnRNb2RlICE9PSBcInN3aXNzXCIpIHtcclxuICAgIHJlc2V0UnVuU3RhdGUoKTtcclxuICAgIHNhdmVTdGF0ZSgpO1xyXG4gIH1cclxuICBsb2FkTmV3UGFpcigpO1xyXG59XHJcblxyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbG9hZE5ld1BhaXIoZm9yY2VkTGVmdFNjZW5lSWQ6IHN0cmluZyB8IG51bGwgPSBudWxsKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgc3RhdGUuZGlzYWJsZUNob2ljZSA9IGZhbHNlO1xyXG4gIGNvbnN0IGNvbXBhcmlzb25BcmVhID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzYi1jb21wYXJpc29uLWFyZWFcIik7XHJcbiAgaWYgKCFjb21wYXJpc29uQXJlYSkgcmV0dXJuO1xyXG5cclxuICBjb25zb2xlLmxvZyhcclxuICAgIGBbU3Rhc2ggQmF0dGxlXSDwn46uIExvYWRpbmcgbmV3IHBhaXIgKG1vZGU6ICR7c3RhdGUuY3VycmVudE1vZGV9KSR7Zm9yY2VkTGVmdFNjZW5lSWQgPyBgIHdpdGggZm9yY2VkIHNjZW5lICR7Zm9yY2VkTGVmdFNjZW5lSWR9YCA6IFwiXCJ9Li4uYCxcclxuICApO1xyXG4gIGNvbnN0IHN0YXJ0VGltZSA9IERhdGUubm93KCk7XHJcblxyXG4gIC8vIE9ubHkgc2hvdyBsb2FkaW5nIG9uIGZpcnN0IGxvYWQgKHdoZW4gZW1wdHkgb3IgYWxyZWFkeSBzaG93aW5nIGxvYWRpbmcpXHJcbiAgaWYgKCFjb21wYXJpc29uQXJlYS5xdWVyeVNlbGVjdG9yKFwiLnNiLXZzLWNvbnRhaW5lclwiKSkge1xyXG4gICAgY29uc3QgaGFzQ2FjaGUgPSBzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXMgIT09IG51bGw7XHJcbiAgICBjb21wYXJpc29uQXJlYS5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz1cInNiLWxvYWRpbmdcIj4ke2hhc0NhY2hlID8gXCJMb2FkaW5nIHNjZW5lcy4uLlwiIDogXCJMb2FkaW5nIGFuZCBjYWNoaW5nIHNjZW5lcyAoZmlyc3QgbG9hZCBtYXkgdGFrZSBhIG1vbWVudCkuLi5cIn08L2Rpdj5gO1xyXG4gIH1cclxuXHJcbiAgdHJ5IHtcclxuICAgIC8vIEZldGNoIGZvcmNlZCBzY2VuZSBkYXRhIGlmIGEgc2NlbmUgSUQgd2FzIHByb3ZpZGVkXHJcbiAgICBsZXQgZm9yY2VkTGVmdFNjZW5lOiBTY2VuZSB8IG51bGwgPSBudWxsO1xyXG4gICAgaWYgKGZvcmNlZExlZnRTY2VuZUlkKSB7XHJcbiAgICAgIGZvcmNlZExlZnRTY2VuZSA9IGF3YWl0IGZldGNoU2NlbmVCeUlkKGZvcmNlZExlZnRTY2VuZUlkKTtcclxuICAgICAgLy8gRnVuIG1vZGUgYmF0dGxlcyBvbmx5IGV2ZXIgdG91Y2ggc2FuZGJveCBjb3BpZXMgKHNlZSBjYWNoZS50cylcclxuICAgICAgaWYgKGZvcmNlZExlZnRTY2VuZSAmJiAhcmF0aW5nc0VuYWJsZWQoKSkgZm9yY2VkTGVmdFNjZW5lID0gc2FuZGJveFNjZW5lKGZvcmNlZExlZnRTY2VuZSk7XHJcbiAgICAgIGlmICghZm9yY2VkTGVmdFNjZW5lKSB7XHJcbiAgICAgICAgY29uc29sZS53YXJuKFwiW1N0YXNoIEJhdHRsZV0gQ291bGQgbm90IGZldGNoIHNjZW5lIGZyb20gVVJMLCBmYWxsaW5nIGJhY2sgdG8gbm9ybWFsIHBhaXJpbmdcIik7XHJcbiAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICBsZXQgc2NlbmVzOiBTY2VuZVtdID0gW107XHJcbiAgICBsZXQgcmFua3M6IFJhbmtbXSA9IFtudWxsLCBudWxsXTtcclxuXHJcbiAgICBpZiAoc3RhdGUuY3VycmVudE1vZGUgPT09IFwicGxhY2VtZW50XCIpIHtcclxuICAgICAgY29uc3QgcGxhY2VtZW50UmVzdWx0ID0gYXdhaXQgZmV0Y2hQbGFjZW1lbnRQYWlyKGZvcmNlZExlZnRTY2VuZSk7XHJcblxyXG4gICAgICBpZiAocGxhY2VtZW50UmVzdWx0LmRvbmUpIHtcclxuICAgICAgICBzaG93UGxhY2VtZW50U2NyZWVuKHBsYWNlbWVudFJlc3VsdC5zY2VuZSwgcGxhY2VtZW50UmVzdWx0LnJhbmssIHBsYWNlbWVudFJlc3VsdC5yYXRpbmcpO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgICAgfVxyXG5cclxuICAgICAgc2NlbmVzID0gcGxhY2VtZW50UmVzdWx0LnNjZW5lcztcclxuICAgICAgcmFua3MgPSBwbGFjZW1lbnRSZXN1bHQucmFua3M7XHJcbiAgICB9IGVsc2UgaWYgKHN0YXRlLmN1cnJlbnRNb2RlID09PSBcImdhdW50bGV0XCIpIHtcclxuICAgICAgY29uc3QgZ2F1bnRsZXRSZXN1bHQgPSBhd2FpdCBmZXRjaEdhdW50bGV0UGFpcihmb3JjZWRMZWZ0U2NlbmUpO1xyXG5cclxuICAgICAgLy8gQ2hlY2sgZm9yIHZpY3RvcnkgKGNoYW1waW9uIHJlYWNoZWQgIzEpXHJcbiAgICAgIGlmIChnYXVudGxldFJlc3VsdC5pc1ZpY3RvcnkpIHtcclxuICAgICAgICBzaG93VmljdG9yeVNjcmVlbihnYXVudGxldFJlc3VsdC5zY2VuZXNbMF0pO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgICAgfVxyXG5cclxuICAgICAgLy8gQ2hlY2sgZm9yIHBsYWNlbWVudCAoZmFsbGluZyBzY2VuZSBoaXQgYm90dG9tKVxyXG4gICAgICBpZiAoZ2F1bnRsZXRSZXN1bHQuaXNQbGFjZW1lbnQpIHtcclxuICAgICAgICBzaG93UGxhY2VtZW50U2NyZWVuKFxyXG4gICAgICAgICAgZ2F1bnRsZXRSZXN1bHQuc2NlbmVzWzBdLFxyXG4gICAgICAgICAgZ2F1bnRsZXRSZXN1bHQucGxhY2VtZW50UmFuayxcclxuICAgICAgICAgIGdhdW50bGV0UmVzdWx0LnBsYWNlbWVudFJhdGluZyxcclxuICAgICAgICApO1xyXG4gICAgICAgIHJldHVybjtcclxuICAgICAgfVxyXG5cclxuICAgICAgc2NlbmVzID0gZ2F1bnRsZXRSZXN1bHQuc2NlbmVzO1xyXG4gICAgICByYW5rcyA9IGdhdW50bGV0UmVzdWx0LnJhbmtzO1xyXG4gICAgfSBlbHNlIGlmIChzdGF0ZS5jdXJyZW50TW9kZSA9PT0gXCJjaGFtcGlvblwiKSB7XHJcbiAgICAgIGNvbnN0IGNoYW1waW9uUmVzdWx0ID0gYXdhaXQgZmV0Y2hDaGFtcGlvblBhaXIoZm9yY2VkTGVmdFNjZW5lKTtcclxuXHJcbiAgICAgIC8vIENoZWNrIGZvciB2aWN0b3J5IChjaGFtcGlvbiBiZWF0IGV2ZXJ5b25lKVxyXG4gICAgICBpZiAoY2hhbXBpb25SZXN1bHQuaXNWaWN0b3J5KSB7XHJcbiAgICAgICAgc2hvd1ZpY3RvcnlTY3JlZW4oY2hhbXBpb25SZXN1bHQuc2NlbmVzWzBdKTtcclxuICAgICAgICByZXR1cm47XHJcbiAgICAgIH1cclxuXHJcbiAgICAgIHNjZW5lcyA9IGNoYW1waW9uUmVzdWx0LnNjZW5lcztcclxuICAgICAgcmFua3MgPSBjaGFtcGlvblJlc3VsdC5yYW5rcztcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgIGNvbnN0IHN3aXNzUmVzdWx0ID0gYXdhaXQgZmV0Y2hTd2lzc1BhaXIoZm9yY2VkTGVmdFNjZW5lKTtcclxuXHJcbiAgICAgIHNjZW5lcyA9IHN3aXNzUmVzdWx0LnNjZW5lcztcclxuICAgICAgcmFua3MgPSBzd2lzc1Jlc3VsdC5yYW5rcztcclxuICAgIH1cclxuXHJcbiAgICBpZiAoc2NlbmVzLmxlbmd0aCA8IDIpIHtcclxuICAgICAgY29tcGFyaXNvbkFyZWEuaW5uZXJIVE1MID0gJzxkaXYgY2xhc3M9XCJzYi1lcnJvclwiPk5vdCBlbm91Z2ggc2NlbmVzIGF2YWlsYWJsZSBmb3IgY29tcGFyaXNvbi48L2Rpdj4nO1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcblxyXG4gICAgc3RhdGUuY3VycmVudFBhaXIubGVmdCA9IHNjZW5lc1swXTtcclxuICAgIHN0YXRlLmN1cnJlbnRQYWlyLnJpZ2h0ID0gc2NlbmVzWzFdO1xyXG4gICAgc3RhdGUuY3VycmVudFJhbmtzLmxlZnQgPSByYW5rc1swXTtcclxuICAgIHN0YXRlLmN1cnJlbnRSYW5rcy5yaWdodCA9IHJhbmtzWzFdO1xyXG5cclxuICAgIGNvbnN0IGxvYWRUaW1lID0gRGF0ZS5ub3coKSAtIHN0YXJ0VGltZTtcclxuICAgIGNvbnNvbGUubG9nKFxyXG4gICAgICBgW1N0YXNoIEJhdHRsZV0g4pyFIFBhaXIgbG9hZGVkIGluICR7bG9hZFRpbWV9bXM6IFNjZW5lICR7c2NlbmVzWzBdLmlkfSAocmFuayAjJHtyYW5rc1swXX0pIHZzIFNjZW5lICR7c2NlbmVzWzFdLmlkfSAocmFuayAjJHtyYW5rc1sxXX0pYCxcclxuICAgICk7XHJcblxyXG4gICAgcmVuZGVyUGFpcihzY2VuZXMsIHJhbmtzKTtcclxuICAgIHVwZGF0ZVBvb2xTdGF0dXMoKTtcclxuICAgIHVwZGF0ZUNsaW1iUG9vbFdhcm5pbmcoKTtcclxuICAgIHNhdmVTdGF0ZSgpO1xyXG4gIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0gRXJyb3IgbG9hZGluZyBzY2VuZXM6XCIsIGVycm9yKTtcclxuICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XHJcbiAgICBjb25zdCBpc05vU2NlbmVzID0gbWVzc2FnZS5pbmNsdWRlcyhcIk5vIHNjZW5lc1wiKSB8fCBtZXNzYWdlLmluY2x1ZGVzKFwiTm90IGVub3VnaFwiKTtcclxuICAgIGNvbXBhcmlzb25BcmVhLmlubmVySFRNTCA9IGBcclxuICAgICAgICA8ZGl2IGNsYXNzPVwic2ItZXJyb3Itc2NyZWVuXCI+XHJcbiAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItZXJyb3ItaWNvblwiPuKaoO+4jzwvZGl2PlxyXG4gICAgICAgICAgPHAgY2xhc3M9XCJzYi1lcnJvci1tZXNzYWdlXCI+JHttZXNzYWdlfTwvcD5cclxuICAgICAgICAgIDxidXR0b24gaWQ9XCJzYi1lcnJvci1yZXRyeVwiIGNsYXNzPVwiYnRuIGJ0bi1wcmltYXJ5XCI+UmV0cnk8L2J1dHRvbj5cclxuICAgICAgICA8L2Rpdj5cclxuICAgICAgYDtcclxuICAgIHNldEFjdGlvbnNWaXNpYmxlKHRydWUpO1xyXG5cclxuICAgIC8vIEF0dGFjaCByZXRyeSBoYW5kbGVyXHJcbiAgICBjb25zdCByZXRyeUJ0biA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic2ItZXJyb3ItcmV0cnlcIikgYXMgSFRNTEJ1dHRvbkVsZW1lbnQgfCBudWxsO1xyXG4gICAgaWYgKHJldHJ5QnRuKSB7XHJcbiAgICAgIHJldHJ5QnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBhc3luYyAoKSA9PiB7XHJcbiAgICAgICAgcmV0cnlCdG4uZGlzYWJsZWQgPSB0cnVlO1xyXG4gICAgICAgIHJldHJ5QnRuLnRleHRDb250ZW50ID0gXCJMb2FkaW5nLi4uXCI7XHJcblxyXG4gICAgICAgIGlmIChpc05vU2NlbmVzKSB7XHJcbiAgICAgICAgICAvLyBcIk5vIHNjZW5lc1wiIGVycm9yOiBjbGVhciBldmVyeXRoaW5nIGFuZCBzdGFydCBmcmVzaFxyXG4gICAgICAgICAgYXdhaXQgY2xlYXJGaWx0ZXJlZENhY2hlKCk7XHJcbiAgICAgICAgICByZXNldFNodWZmbGUoKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgLy8gTmV0d29yay9vdGhlciBlcnJvcnM6IGp1c3QgcmV0cnkgd2l0aG91dCBjbGVhcmluZyBzZXNzaW9uIHN0YXRlXHJcblxyXG4gICAgICAgIGF3YWl0IGxvYWROZXdQYWlyKCk7XHJcbiAgICAgIH0pO1xyXG4gICAgfVxyXG4gIH1cclxufVxyXG5cclxuLyoqIFJlbmRlciB0aGUgc2F2ZWQgcGFpciwgdW5sZXNzIG9uZSBvZiBpdHMgc2NlbmVzIHdhcyBkZWxldGVkIGluIFN0YXNoIG1lYW53aGlsZS4gKi9cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlc3RvcmVDdXJyZW50UGFpcigpOiBQcm9taXNlPHZvaWQ+IHtcclxuICBzdGF0ZS5kaXNhYmxlQ2hvaWNlID0gZmFsc2U7XHJcbiAgY29uc3QgbGVmdCA9IHN0YXRlLmN1cnJlbnRQYWlyLmxlZnQgYXMgU2NlbmU7XHJcbiAgY29uc3QgcmlnaHQgPSBzdGF0ZS5jdXJyZW50UGFpci5yaWdodCBhcyBTY2VuZTtcclxuXHJcbiAgLy8gTG9hZCB0aGUgKGNhY2hlZCkgcG9vbHMgaW4gdGhlIGJhY2tncm91bmQ6IHByZS13YXJtcyB0aGVtIGZvciB0aGUgbmV4dCBjaG9pY2UgYW5kIGZpbGxzIGluXHJcbiAgLy8gdGhlIHBvb2wgc2l6ZSBvbiB0aGUgc3RhdHVzIGxpbmUsIHdoaWNoIGEgcmVzdG9yZWQgcGFpciBvdGhlcndpc2UgZG9lc24ndCBrbm93IHlldFxyXG4gIHZvaWQgbG9hZFBvb2xTaXplKClcclxuICAgIC50aGVuKHVwZGF0ZVBvb2xTdGF0dXMpXHJcbiAgICAuY2F0Y2goKGUpID0+IGNvbnNvbGUud2FybihcIltTdGFzaCBCYXR0bGVdIENvdWxkIG5vdCBsb2FkIHNjZW5lIHBvb2xzIGZvciB0aGUgc3RhdHVzIGxpbmU6XCIsIGUpKTtcclxuXHJcbiAgaWYgKCEoYXdhaXQgdmVyaWZ5Q3VycmVudFBhaXIoKSkpIHJldHVybjtcclxuXHJcbiAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5OCIFJlbmRlcmluZyBzYXZlZCBwYWlyIChubyBuZXR3b3JrIGZldGNoIG5lZWRlZClcIik7XHJcbiAgcmVuZGVyUGFpcihbbGVmdCwgcmlnaHRdLCBbc3RhdGUuY3VycmVudFJhbmtzLmxlZnQsIHN0YXRlLmN1cnJlbnRSYW5rcy5yaWdodF0pO1xyXG4gIHVwZGF0ZVBvb2xTdGF0dXMoKTtcclxufVxyXG5cclxuLyoqXHJcbiAqIENoZWNrIHRoZSBjdXJyZW50IHBhaXIgc3RpbGwgZXhpc3RzIGluIFN0YXNoIChzY2VuZXMgbWF5IGJlIGRlbGV0ZWQgZWxzZXdoZXJlKS4gSWYgb25lIGlzIGdvbmUsXHJcbiAqIGNvbnRpbnVlIHdpdGhvdXQgaXQgYW5kIHJldHVybiBmYWxzZS4gTmV0d29yayBlcnJvcnMgY291bnQgYXMgXCJzdGlsbCB0aGVyZVwiLlxyXG4gKi9cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHZlcmlmeUN1cnJlbnRQYWlyKCk6IFByb21pc2U8Ym9vbGVhbj4ge1xyXG4gIGNvbnN0IHsgbGVmdCwgcmlnaHQgfSA9IHN0YXRlLmN1cnJlbnRQYWlyO1xyXG4gIGlmICghbGVmdCB8fCAhcmlnaHQpIHJldHVybiB0cnVlO1xyXG4gIHRyeSB7XHJcbiAgICBjb25zdCBleGlzdGluZyA9IGF3YWl0IGZpbmRFeGlzdGluZ1NjZW5lSWRzKFtsZWZ0LmlkLCByaWdodC5pZF0pO1xyXG4gICAgY29uc3QgZ29uZSA9IFtsZWZ0LCByaWdodF0uZmluZCgocykgPT4gIWV4aXN0aW5nLmhhcyhzLmlkKSk7XHJcbiAgICBpZiAoZ29uZSkge1xyXG4gICAgICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g8J+RuyBTY2VuZSAke2dvbmUuaWR9IGluIHRoZSBjdXJyZW50IHBhaXIgbm8gbG9uZ2VyIGV4aXN0c2ApO1xyXG4gICAgICBhd2FpdCBoYW5kbGVTY2VuZUdvbmUoZ29uZS5pZCk7XHJcbiAgICAgIHJldHVybiBmYWxzZTtcclxuICAgIH1cclxuICB9IGNhdGNoIChlKSB7XHJcbiAgICBjb25zb2xlLndhcm4oXCJbU3Rhc2ggQmF0dGxlXSBDb3VsZCBub3QgdmVyaWZ5IGN1cnJlbnQgcGFpcjpcIiwgZSk7XHJcbiAgfVxyXG4gIHJldHVybiB0cnVlO1xyXG59XHJcblxyXG4vKiogRm9yZ2V0IGEgc2NlbmUgaWQgcmVmZXJlbmNlZCBieSB0aGUgY3VycmVudCBydW4gKGl0IG5vIGxvbmdlciBleGlzdHMpLiAqL1xyXG5mdW5jdGlvbiBkcm9wRnJvbVJ1bihzY2VuZUlkOiBzdHJpbmcpOiB2b2lkIHtcclxuICBzdGF0ZS5nYXVudGxldERlZmVhdGVkID0gc3RhdGUuZ2F1bnRsZXREZWZlYXRlZC5maWx0ZXIoKGlkKSA9PiBpZCAhPT0gc2NlbmVJZCk7XHJcbiAgY29uc3QgcnVuID0gc3RhdGUucGxhY2VtZW50O1xyXG4gIGlmICghcnVuKSByZXR1cm47XHJcbiAgaWYgKHJ1bi5hYm92ZUlkID09PSBzY2VuZUlkKSBydW4uYWJvdmVJZCA9IG51bGw7XHJcbiAgaWYgKHJ1bi5iZWxvd0lkID09PSBzY2VuZUlkKSBydW4uYmVsb3dJZCA9IG51bGw7XHJcbiAgaWYgKHJ1bi5sYXN0T3Bwb25lbnRJZCA9PT0gc2NlbmVJZCkge1xyXG4gICAgcnVuLmxhc3RPcHBvbmVudElkID0gbnVsbDtcclxuICAgIHJ1bi5nYWxsb3BpbmcgPSBmYWxzZTtcclxuICB9XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBBIHNjZW5lIGluIHBsYXkgbm8gbG9uZ2VyIGV4aXN0cy4gSWYgaXQgd2FzIHRoZSBzY2VuZSBiZWluZyByYXRlZC9wbGFjZWQvY2xpbWJpbmcsIHN0YXJ0IG92ZXI7XHJcbiAqIG90aGVyd2lzZSBrZWVwIHRoZSBvdGhlciBzY2VuZSBhbmQgZmluZCBpdCBhIG5ldyBvcHBvbmVudC5cclxuICovXHJcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBoYW5kbGVTY2VuZUdvbmUoc2NlbmVJZDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgYXdhaXQgcmVtb3ZlU2NlbmVFdmVyeXdoZXJlKHNjZW5lSWQpO1xyXG5cclxuICBjb25zdCB7IGxlZnQsIHJpZ2h0IH0gPSBzdGF0ZS5jdXJyZW50UGFpcjtcclxuICBjb25zdCBydW5TY2VuZUlkcyA9IFtsZWZ0Py5pZCwgc3RhdGUucGxhY2VtZW50Py5zY2VuZS5pZCwgc3RhdGUuZ2F1bnRsZXRDbGltYmVyPy5pZCwgc3RhdGUuZ2F1bnRsZXRGYWxsaW5nU2NlbmU/LmlkXTtcclxuXHJcbiAgaWYgKHJ1blNjZW5lSWRzLmluY2x1ZGVzKHNjZW5lSWQpKSB7XHJcbiAgICByZXNldFJ1blN0YXRlKCk7XHJcbiAgICBzYXZlU3RhdGUoKTtcclxuICAgIGF3YWl0IGxvYWROZXdQYWlyKCk7XHJcbiAgICByZXR1cm47XHJcbiAgfVxyXG5cclxuICBkcm9wRnJvbVJ1bihzY2VuZUlkKTtcclxuICBzYXZlU3RhdGUoKTtcclxuICAvLyBGb3JjZWQgbGVmdCBvbmx5IGFwcGxpZXMgd2hlbiBubyBydW4gaXMgdW5kZXIgd2F5IChTd2lzcywgb3IgYmVmb3JlIGEgY2xpbWIgc3RhcnRzKVxyXG4gIGNvbnN0IGtlZXBJZCA9IHJpZ2h0Py5pZCA9PT0gc2NlbmVJZCA/IGxlZnQ/LmlkIDogbnVsbDtcclxuICBhd2FpdCBsb2FkTmV3UGFpcihrZWVwSWQgPz8gbnVsbCk7XHJcbn1cclxuXHJcbi8qKiBDbGVhbiBtb2RlOiBTdGFzaCdzIG93biBkZWxldGUgZGlhbG9nIGRvZXMgdGhlIGRlbGV0aW5nOyB0aGVuIGNvbnRpbnVlIHRoZSBiYXR0bGUgd2l0aG91dCBpdC4gKi9cclxuYXN5bmMgZnVuY3Rpb24gZGVsZXRlRnJvbUJhdHRsZShzY2VuZTogU2NlbmUpOiBQcm9taXNlPHZvaWQ+IHtcclxuICBpZiAoc3RhdGUuZGlzYWJsZUNob2ljZSkgcmV0dXJuO1xyXG4gIGNvbnN0IGRlbGV0ZWQgPSBhd2FpdCBjb25maXJtRGVsZXRlU2NlbmUoc2NlbmUpO1xyXG4gIGlmICghZGVsZXRlZCkgcmV0dXJuO1xyXG5cclxuICBzdGF0ZS5kaXNhYmxlQ2hvaWNlID0gdHJ1ZTtcclxuICBhd2FpdCBoYW5kbGVTY2VuZUdvbmUoc2NlbmUuaWQpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBhY3RpdmVDbGltYmVySWQoKTogc3RyaW5nIHwgbnVsbCB7XHJcbiAgaWYgKHN0YXRlLmdhdW50bGV0RmFsbGluZyAmJiBzdGF0ZS5nYXVudGxldEZhbGxpbmdTY2VuZSkge1xyXG4gICAgcmV0dXJuIHN0YXRlLmdhdW50bGV0RmFsbGluZ1NjZW5lLmlkO1xyXG4gIH1cclxuICByZXR1cm4gc3RhdGUuZ2F1bnRsZXRDbGltYmVyPy5pZCA/PyBudWxsO1xyXG59XHJcblxyXG5mdW5jdGlvbiBiYXR0bGVSb2xlRm9yKHNjZW5lSWQ6IHN0cmluZywgbW9kZTogTW9kZSk6IEJhdHRsZVNpZGVbXCJyb2xlXCJdIHtcclxuICBpZiAobW9kZSA9PT0gXCJzd2lzc1wiKSByZXR1cm4gXCJjb21iYXRhbnRcIjtcclxuICBjb25zdCBjbGltYmVySWQgPSBhY3RpdmVDbGltYmVySWQoKTtcclxuICByZXR1cm4gY2xpbWJlcklkICE9PSBudWxsICYmIHNjZW5lSWQgPT09IGNsaW1iZXJJZCA/IFwiY2xpbWJlclwiIDogXCJiZW5jaG1hcmtcIjtcclxufVxyXG5cclxuLyoqIFJhdGluZyB1c2VkIGluIEVMTyBtYXRoLiBUaGUgdW5yYXRlZC1yYXRpbmcgc2V0dGluZyBhcHBsaWVzIHRvIFN3aXNzOyBjbGltYnMgc3RhcnQgZnJvbSB0aGUgYm90dG9tLiAqL1xyXG5mdW5jdGlvbiBiYXR0bGVSYXRpbmcoc2NlbmU6IFNjZW5lKTogbnVtYmVyIHtcclxuICBjb25zdCB1bnJhdGVkID0gc3RhdGUuY3VycmVudE1vZGUgPT09IFwic3dpc3NcIiA/IHN0YXRlLnNldHRpbmdzLnVucmF0ZWRSYXRpbmcgOiAwO1xyXG4gIHJldHVybiBlZmZlY3RpdmVSYXRpbmcoc2NlbmUucmF0aW5nMTAwLCB1bnJhdGVkKTtcclxufVxyXG5cclxuLyoqIEFwcGx5IGNsaW1iL2NoYW1waW9uIHJ1bGVzIG9uIHRvcCBvZiByYXcgdHdvLXNpZGVkIEVMTy4gU3dpc3MgdXNlcyB0aGUgcmF3IHJlc3VsdCBhcy1pcy4gKi9cclxuZnVuY3Rpb24gYXBwbHlNb2RlUG9saWN5KFxyXG4gIHdpbm5lcjogU2NlbmUsXHJcbiAgbG9zZXI6IFNjZW5lLFxyXG4gIG1vZGU6IE1vZGUsXHJcbiAgcmF3OiBDb21wYXJpc29uRGVsdGFzLFxyXG4pOiBDb21wYXJpc29uRGVsdGFzIHtcclxuICBpZiAobW9kZSA9PT0gXCJzd2lzc1wiKSByZXR1cm4gcmF3O1xyXG5cclxuICBsZXQgd2lubmVyRGVsdGEgPSAwO1xyXG4gIGxldCBsb3NlckRlbHRhID0gMDtcclxuXHJcbiAgaWYgKGJhdHRsZVJvbGVGb3Iod2lubmVyLmlkLCBtb2RlKSA9PT0gXCJjbGltYmVyXCIpIHtcclxuICAgIHdpbm5lckRlbHRhID0gcmF3Lndpbm5lcjtcclxuICB9XHJcblxyXG4gIGNvbnN0IGxvc2VyUmF0aW5nID0gbG9zZXIucmF0aW5nMTAwIHx8IDE7XHJcbiAgLy8gU3BlY2lhbCBjYXNlOiBpZiAxMDAgcmF0ZWQgYmVuY2htYXJrIGxvc2VzLCB0aGV5IGRyb3AgdG8gOTkgc28gaXRzIGZ1bm5lciB0byBzZWUgYSBjaGFtcGlvbiBlbWVyZ2VcclxuICBpZiAoYmF0dGxlUm9sZUZvcihsb3Nlci5pZCwgbW9kZSkgPT09IFwiYmVuY2htYXJrXCIgJiYgbG9zZXJSYXRpbmcgPT09IDEwMCkge1xyXG4gICAgbG9zZXJEZWx0YSA9IC0xO1xyXG4gIH1cclxuXHJcbiAgcmV0dXJuIHsgd2lubmVyOiB3aW5uZXJEZWx0YSwgbG9zZXI6IGxvc2VyRGVsdGEgfTtcclxufVxyXG5cclxuLyoqIFJ1biBwdXJlIEVMTyBtYXRoIGFuZCB3cml0ZSBhbnkgcmF0aW5nIGNoYW5nZXMgKHRvIFN0YXNoLCBvciBpbiBmdW4gbW9kZSB0byB0aGUgaW4tbWVtb3J5IHNhbmRib3gpLiAqL1xyXG5mdW5jdGlvbiByZXNvbHZlQ29tcGFyaXNvbih3aW5uZXI6IFNjZW5lLCBsb3NlcjogU2NlbmUpOiBDb21wYXJpc29uRGVsdGFzIHtcclxuICBjb25zdCBtb2RlID0gc3RhdGUuY3VycmVudE1vZGU7XHJcbiAgY29uc3Qgd2lubmVyUmF0aW5nID0gYmF0dGxlUmF0aW5nKHdpbm5lcik7XHJcbiAgY29uc3QgbG9zZXJSYXRpbmcgPSBiYXR0bGVSYXRpbmcobG9zZXIpO1xyXG5cclxuICBjb25zdCBjbGltYmVySWQgPSBhY3RpdmVDbGltYmVySWQoKTtcclxuICBjb25zdCB3aW5uZXJQbGF5Q291bnQgPVxyXG4gICAgbW9kZSAhPT0gXCJzd2lzc1wiICYmIGNsaW1iZXJJZCA9PT0gd2lubmVyLmlkXHJcbiAgICAgID8gQ0xJTUJfS19QTEFZX0NPVU5UXHJcbiAgICAgIDogKHdpbm5lci5wbGF5X2NvdW50ID8/IDApO1xyXG5cclxuICBjb25zdCByYXcgPSBjYWxjdWxhdGVSYXRpbmdDaGFuZ2VzKHtcclxuICAgIHdpbm5lcjogeyByYXRpbmc6IHdpbm5lclJhdGluZywgcGxheUNvdW50OiB3aW5uZXJQbGF5Q291bnQgfSxcclxuICAgIGxvc2VyOiB7IHJhdGluZzogbG9zZXJSYXRpbmcsIHBsYXlDb3VudDogbG9zZXIucGxheV9jb3VudCA/PyAwIH0sXHJcbiAgfSk7XHJcbiAgY29uc3QgZGVsdGFzID0gYXBwbHlNb2RlUG9saWN5KHdpbm5lciwgbG9zZXIsIG1vZGUsIHJhdyk7XHJcblxyXG4gIGlmIChkZWx0YXMud2lubmVyICE9PSAwKSB1cGRhdGVTY2VuZVJhdGluZyh3aW5uZXIuaWQsIHdpbm5lclJhdGluZyArIGRlbHRhcy53aW5uZXIpO1xyXG4gIGlmIChkZWx0YXMubG9zZXIgIT09IDApIHVwZGF0ZVNjZW5lUmF0aW5nKGxvc2VyLmlkLCBsb3NlclJhdGluZyArIGRlbHRhcy5sb3Nlcik7XHJcblxyXG4gIHJldHVybiBkZWx0YXM7XHJcbn1cclxuXHJcbi8qKiBTaG93IHdoZW4gZ2F1bnRsZXQvY2hhbXBpb24gKyBmaWx0ZXIgb3Bwb25lbnRzICsgc21hbGwgZmlsdGVyZWQgcG9vbC4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIHVwZGF0ZUNsaW1iUG9vbFdhcm5pbmcoKTogdm9pZCB7XHJcbiAgY29uc3Qgd2FybmluZyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic2ItY2xpbWItcG9vbC13YXJuaW5nXCIpO1xyXG4gIGlmICghd2FybmluZykgcmV0dXJuO1xyXG5cclxuICBjb25zdCBpc0NsaW1iID0gc3RhdGUuY3VycmVudE1vZGUgPT09IFwiZ2F1bnRsZXRcIiB8fCBzdGF0ZS5jdXJyZW50TW9kZSA9PT0gXCJjaGFtcGlvblwiO1xyXG4gIGNvbnN0IGZpbHRlcnMgPSByZWFkRmlsdGVycygpO1xyXG4gIGNvbnN0IHNtYWxsUG9vbCA9XHJcbiAgICBzdGF0ZS50b3RhbFNjZW5lc0NvdW50ID4gMCAmJiBzdGF0ZS50b3RhbFNjZW5lc0NvdW50IDwgQ0xJTUJfU01BTExfUE9PTF9XQVJOX0FUO1xyXG5cclxuICB3YXJuaW5nLmhpZGRlbiA9ICEoXHJcbiAgICBpc0NsaW1iICYmXHJcbiAgICBzdGF0ZS5zZXR0aW5ncy5maWx0ZXJPcHBvbmVudHMgJiZcclxuICAgIGZpbHRlcnMuZmlsdGVyQWN0aXZlICYmXHJcbiAgICBzbWFsbFBvb2xcclxuICApO1xyXG59XHJcblxyXG4vKiogUGxhY2VtZW50OiByZWNvcmQgdGhlIHJlc3VsdDsgdGhlIG5leHQgcGFpciAob3IgdGhlIGZpbmFsIHBsYWNlbWVudCkgY29tZXMgZnJvbSB0aGUgZmV0Y2guICovXHJcbmZ1bmN0aW9uIGhhbmRsZVBsYWNlbWVudENob2ljZShjaG9pY2U6IFNjZW5lQ2hvaWNlKTogdm9pZCB7XHJcbiAgY29uc3QgcnVuID0gc3RhdGUucGxhY2VtZW50O1xyXG4gIGlmICghcnVuKSB7XHJcbiAgICBzdGF0ZS5kaXNhYmxlQ2hvaWNlID0gZmFsc2U7XHJcbiAgICByZXR1cm47XHJcbiAgfVxyXG5cclxuICBjb25zdCB3b24gPSBjaG9pY2Uud2lubmVyLmlkID09PSBydW4uc2NlbmUuaWQ7XHJcbiAgcmVjb3JkUGxhY2VtZW50UmVzdWx0KHdvbiwgd29uID8gY2hvaWNlLmxvc2VyLmlkIDogY2hvaWNlLndpbm5lci5pZCk7XHJcbiAgc2F2ZVN0YXRlKCk7XHJcblxyXG4gIGNob2ljZS53aW5uZXJDYXJkLmNsYXNzTGlzdC5hZGQoXCJzYi13aW5uZXJcIik7XHJcbiAgY2hvaWNlLmxvc2VyQ2FyZC5jbGFzc0xpc3QuYWRkKFwic2ItbG9zZXJcIik7XHJcbiAgc2V0VGltZW91dCgoKSA9PiBsb2FkTmV3UGFpcigpLCA2MDApO1xyXG59XHJcblxyXG4vKiogR2F1bnRsZXQgY2xpbWIgLyBmaXJzdC1iYXR0bGUgcGF0aCAoYWZ0ZXIgZmFsbGluZy1tb2RlIGJyYW5jaCkuICovXHJcbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZUdhdW50bGV0Q2xpbWJDaG9pY2UoY2hvaWNlOiBTY2VuZUNob2ljZSk6IFByb21pc2U8dm9pZD4ge1xyXG4gIGNvbnN0IHtcclxuICAgIHdpbm5lcjogd2lubmVyU2NlbmUsXHJcbiAgICBsb3NlcjogbG9zZXJTY2VuZSxcclxuICAgIGxlZnQsXHJcbiAgICB3aW5uZXJDYXJkLFxyXG4gICAgbG9zZXJDYXJkLFxyXG4gIH0gPSBjaG9pY2U7XHJcblxyXG4gIGNvbnN0IHdpbm5lcklkID0gd2lubmVyU2NlbmUuaWQ7XHJcbiAgY29uc3QgbG9zZXJJZCA9IGxvc2VyU2NlbmUuaWQ7XHJcblxyXG4gIGNvbnN0IGlzRmlyc3RCYXR0bGUgPSAhc3RhdGUuZ2F1bnRsZXRDbGltYmVyO1xyXG5cclxuICAvLyBSZS12ZXJpZnkgZnJvbSB0aGUgYm90dG9tOiBjbGVhciBleGlzdGluZyByYXRpbmcgb24gZmlyc3QgY2hvaWNlLCBub3Qgb24gcGFpciBsb2FkXHJcbiAgaWYgKGlzRmlyc3RCYXR0bGUgJiYgbGVmdC5yYXRpbmcxMDAgIT0gbnVsbCkge1xyXG4gICAgY29uc29sZS5sb2coXHJcbiAgICAgIGBbU3Rhc2ggQmF0dGxlXSDwn5OKIEdhdW50bGV0OiBjbGVhcmluZyByYXRpbmcgJHtsZWZ0LnJhdGluZzEwMH0gZm9yIHNjZW5lICR7bGVmdC5pZH0gb24gZmlyc3QgY2hvaWNlYCxcclxuICAgICk7XHJcbiAgICBhd2FpdCB1cGRhdGVTY2VuZVJhdGluZyhsZWZ0LmlkLCBudWxsKTtcclxuICAgIGxlZnQucmF0aW5nMTAwID0gbnVsbDtcclxuICB9XHJcblxyXG4gIGlmIChpc0ZpcnN0QmF0dGxlKSB7XHJcbiAgICBzdGF0ZS5nYXVudGxldENsaW1iZXIgPSBsZWZ0O1xyXG4gIH1cclxuICBjb25zdCBjbGltYmVyID0gc3RhdGUuZ2F1bnRsZXRDbGltYmVyIGFzIFNjZW5lO1xyXG5cclxuICBjb25zdCB3aW5uZXJSYXRpbmcgPSB3aW5uZXJTY2VuZS5yYXRpbmcxMDAgfHwgMTtcclxuICBjb25zdCB3aW5uZXJBbmltU3RhcnQgPSB3aW5uZXJTY2VuZS5yYXRpbmcxMDAgPz8gMDtcclxuICBjb25zdCBsb3NlckRpc3BsYXlSYXRpbmcgPSBsb3NlclNjZW5lLnJhdGluZzEwMCA/PyAwO1xyXG5cclxuICBjb25zdCB7IHdpbm5lcjogd2lubmVyRGVsdGEsIGxvc2VyOiBsb3NlckRlbHRhIH0gPSByZXNvbHZlQ29tcGFyaXNvbih3aW5uZXJTY2VuZSwgbG9zZXJTY2VuZSk7XHJcbiAgY29uc3QgbmV3V2lubmVyUmF0aW5nID0gd2lubmVyUmF0aW5nICsgd2lubmVyRGVsdGE7XHJcbiAgY29uc3QgbmV3TG9zZXJSYXRpbmcgPSBsb3NlckRpc3BsYXlSYXRpbmcgKyBsb3NlckRlbHRhO1xyXG5cclxuICBsZXQgd2lubmVyRGlzcGxheVJhdGluZyA9IG5ld1dpbm5lclJhdGluZztcclxuXHJcbiAgaWYgKHdpbm5lcklkID09PSBjbGltYmVyLmlkKSB7XHJcbiAgICBzdGF0ZS5nYXVudGxldERlZmVhdGVkLnB1c2gobG9zZXJJZCk7XHJcbiAgICBzdGF0ZS5nYXVudGxldFdpbnMrKztcclxuICAgIHdpbm5lckRpc3BsYXlSYXRpbmcgPSBhd2FpdCBhcHBseUNsaW1iV2luUmF0aW5nKGNsaW1iZXIsIGxvc2VyU2NlbmUsIG5ld1dpbm5lclJhdGluZyk7XHJcbiAgICBjb25zb2xlLmxvZyhcclxuICAgICAgYFtTdGFzaCBCYXR0bGVdIPCfk4ogR2F1bnRsZXQ6IGNsaW1iZXIgJHt3aW5uZXJJZH0gd29uIChzdHJlYWs9JHtzdGF0ZS5nYXVudGxldFdpbnN9KSwgcmF0aW5nIOKGkiAke3dpbm5lckRpc3BsYXlSYXRpbmd9YCxcclxuICAgICk7XHJcbiAgfSBlbHNlIGlmIChpc0ZpcnN0QmF0dGxlKSB7XHJcbiAgICBjb25zdCBmaW5hbFJhbmsgPSBzdGF0ZS50b3RhbFNjZW5lc0NvdW50O1xyXG4gICAgY29uc3QgZmluYWxSYXRpbmcgPSBNYXRoLm1heCgxLCAod2lubmVyU2NlbmUucmF0aW5nMTAwIHx8IDEpIC0gMSk7XHJcbiAgICBjb25zb2xlLmxvZyhcclxuICAgICAgYFtTdGFzaCBCYXR0bGVdIPCfk4ogR2F1bnRsZXQ6IGZpcnN0IGJhdHRsZSwgY2hhbGxlbmdlciAke2xvc2VySWR9IGxvc3QgdG8gZmxvb3Ig4oaSIHJhbmsgIyR7ZmluYWxSYW5rfSwgcmF0aW5nICR7ZmluYWxSYXRpbmd9YCxcclxuICAgICk7XHJcbiAgICB2b2lkIHVwZGF0ZVNjZW5lUmF0aW5nKGxvc2VyU2NlbmUuaWQsIGZpbmFsUmF0aW5nKTtcclxuXHJcbiAgICB3aW5uZXJDYXJkLmNsYXNzTGlzdC5hZGQoXCJzYi13aW5uZXJcIik7XHJcbiAgICBpZiAobG9zZXJDYXJkKSBsb3NlckNhcmQuY2xhc3NMaXN0LmFkZChcInNiLWxvc2VyXCIpO1xyXG5cclxuICAgIHNldFRpbWVvdXQoKCkgPT4ge1xyXG4gICAgICBzaG93UGxhY2VtZW50U2NyZWVuKGxvc2VyU2NlbmUsIGZpbmFsUmFuaywgZmluYWxSYXRpbmcpO1xyXG4gICAgfSwgODAwKTtcclxuICAgIHJldHVybjtcclxuICB9IGVsc2Uge1xyXG4gICAgY29uc29sZS5sb2coXHJcbiAgICAgIGBbU3Rhc2ggQmF0dGxlXSDwn5OKIEdhdW50bGV0OiBjbGltYmVyICR7Y2xpbWJlci5pZH0ocmF0aW5nPSR7Y2xpbWJlci5yYXRpbmcxMDB9KSBMT1NUIHRvICR7d2lubmVySWR9KHJhdGluZz0ke25ld1dpbm5lclJhdGluZ30pLCBlbnRlcmluZyBmYWxsaW5nIG1vZGVgLFxyXG4gICAgKTtcclxuICAgIHN0YXRlLmdhdW50bGV0RmFsbGluZyA9IHRydWU7XHJcbiAgICBzdGF0ZS5nYXVudGxldEZhbGxpbmdTY2VuZSA9IGxvc2VyU2NlbmU7XHJcbiAgICBzdGF0ZS5nYXVudGxldERlZmVhdGVkID0gW3dpbm5lcklkXTtcclxuICB9XHJcblxyXG4gIHNhdmVTdGF0ZSgpO1xyXG5cclxuICB3aW5uZXJDYXJkLmNsYXNzTGlzdC5hZGQoXCJzYi13aW5uZXJcIik7XHJcbiAgaWYgKGxvc2VyQ2FyZCkgbG9zZXJDYXJkLmNsYXNzTGlzdC5hZGQoXCJzYi1sb3NlclwiKTtcclxuXHJcbiAgc2hvd1JhdGluZ0FuaW1hdGlvbih3aW5uZXJDYXJkLCB3aW5uZXJBbmltU3RhcnQsIHdpbm5lckRpc3BsYXlSYXRpbmcsIHRydWUpO1xyXG4gIGlmIChsb3NlckNhcmQpIHtcclxuICAgIHNob3dSYXRpbmdBbmltYXRpb24oXHJcbiAgICAgIGxvc2VyQ2FyZCxcclxuICAgICAgbG9zZXJEaXNwbGF5UmF0aW5nLFxyXG4gICAgICBsb3NlckRlbHRhICE9PSAwID8gbmV3TG9zZXJSYXRpbmcgOiBsb3NlckRpc3BsYXlSYXRpbmcsXHJcbiAgICAgIGZhbHNlLFxyXG4gICAgKTtcclxuICB9XHJcbiAgc2NoZWR1bGVOZXh0UGFpckFmdGVyQW5pbWF0aW9ucygpO1xyXG59XHJcblxyXG4vKiogQ2hhbXBpb24gbW9kZSBjbGltYiBwYXRoLiAqL1xyXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVDaGFtcGlvbkNob2ljZShjaG9pY2U6IFNjZW5lQ2hvaWNlKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgY29uc3Qge1xyXG4gICAgd2lubmVyOiB3aW5uZXJTY2VuZSxcclxuICAgIGxvc2VyOiBsb3NlclNjZW5lLFxyXG4gICAgbGVmdCxcclxuICAgIHdpbm5lckNhcmQsXHJcbiAgICBsb3NlckNhcmQsXHJcbiAgfSA9IGNob2ljZTtcclxuXHJcbiAgY29uc3Qgd2lubmVySWQgPSB3aW5uZXJTY2VuZS5pZDtcclxuICBjb25zdCBsb3NlcklkID0gbG9zZXJTY2VuZS5pZDtcclxuICBjb25zdCB3aW5uZXJSYXRpbmcgPSB3aW5uZXJTY2VuZS5yYXRpbmcxMDAgfHwgMTtcclxuICBjb25zdCB3aW5uZXJBbmltU3RhcnQgPSB3aW5uZXJTY2VuZS5yYXRpbmcxMDAgPz8gMDtcclxuICBjb25zdCBsb3NlckRpc3BsYXlSYXRpbmcgPSBsb3NlclNjZW5lLnJhdGluZzEwMCA/PyAwO1xyXG5cclxuICBjb25zdCBpc0ZpcnN0QmF0dGxlID0gIXN0YXRlLmdhdW50bGV0Q2xpbWJlcjtcclxuICBpZiAoaXNGaXJzdEJhdHRsZSkge1xyXG4gICAgc3RhdGUuZ2F1bnRsZXRDbGltYmVyID0gbGVmdDtcclxuICB9XHJcbiAgY29uc3QgY2xpbWJlciA9IHN0YXRlLmdhdW50bGV0Q2xpbWJlciBhcyBTY2VuZTtcclxuXHJcbiAgY29uc3QgeyB3aW5uZXI6IHdpbm5lckRlbHRhLCBsb3NlcjogbG9zZXJEZWx0YSB9ID0gcmVzb2x2ZUNvbXBhcmlzb24od2lubmVyU2NlbmUsIGxvc2VyU2NlbmUpO1xyXG4gIGNvbnN0IG5ld1dpbm5lclJhdGluZyA9IHdpbm5lclJhdGluZyArIHdpbm5lckRlbHRhO1xyXG4gIGNvbnN0IG5ld0xvc2VyUmF0aW5nID0gbG9zZXJEaXNwbGF5UmF0aW5nICsgbG9zZXJEZWx0YTtcclxuXHJcbiAgbGV0IHdpbm5lckRpc3BsYXlSYXRpbmcgPSBuZXdXaW5uZXJSYXRpbmc7XHJcblxyXG4gIGlmICh3aW5uZXJJZCA9PT0gY2xpbWJlci5pZCkge1xyXG4gICAgc3RhdGUuZ2F1bnRsZXREZWZlYXRlZC5wdXNoKGxvc2VySWQpO1xyXG4gICAgc3RhdGUuZ2F1bnRsZXRXaW5zKys7XHJcbiAgICB3aW5uZXJEaXNwbGF5UmF0aW5nID0gYXdhaXQgYXBwbHlDbGltYldpblJhdGluZyhjbGltYmVyLCBsb3NlclNjZW5lLCBuZXdXaW5uZXJSYXRpbmcpO1xyXG4gIH0gZWxzZSB7XHJcbiAgICBzdGF0ZS5nYXVudGxldENsaW1iZXIgPSB3aW5uZXJTY2VuZTtcclxuICAgIHdpbm5lclNjZW5lLnJhdGluZzEwMCA9IG5ld1dpbm5lclJhdGluZztcclxuICAgIHN0YXRlLmdhdW50bGV0RGVmZWF0ZWQgPSBbbG9zZXJJZF07XHJcbiAgICBzdGF0ZS5nYXVudGxldFdpbnMgPSAxO1xyXG4gIH1cclxuXHJcbiAgc2F2ZVN0YXRlKCk7XHJcblxyXG4gIHdpbm5lckNhcmQuY2xhc3NMaXN0LmFkZChcInNiLXdpbm5lclwiKTtcclxuICBpZiAobG9zZXJDYXJkKSBsb3NlckNhcmQuY2xhc3NMaXN0LmFkZChcInNiLWxvc2VyXCIpO1xyXG5cclxuICBzaG93UmF0aW5nQW5pbWF0aW9uKHdpbm5lckNhcmQsIHdpbm5lckFuaW1TdGFydCwgd2lubmVyRGlzcGxheVJhdGluZywgdHJ1ZSk7XHJcbiAgaWYgKGxvc2VyQ2FyZCkge1xyXG4gICAgc2hvd1JhdGluZ0FuaW1hdGlvbihcclxuICAgICAgbG9zZXJDYXJkLFxyXG4gICAgICBsb3NlckRpc3BsYXlSYXRpbmcsXHJcbiAgICAgIGxvc2VyRGVsdGEgIT09IDAgPyBuZXdMb3NlclJhdGluZyA6IGxvc2VyRGlzcGxheVJhdGluZyxcclxuICAgICAgZmFsc2UsXHJcbiAgICApO1xyXG4gIH1cclxuICBzY2hlZHVsZU5leHRQYWlyQWZ0ZXJBbmltYXRpb25zKCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGhhbmRsZVNjZW5lQ2hvaWNlKGNob2ljZTogU2NlbmVDaG9pY2UpOiB2b2lkIHtcclxuICBpZiAoc3RhdGUuZGlzYWJsZUNob2ljZSkgcmV0dXJuO1xyXG4gIHN0YXRlLmRpc2FibGVDaG9pY2UgPSB0cnVlO1xyXG5cclxuICBjb25zdCB7XHJcbiAgICB3aW5uZXI6IHdpbm5lclNjZW5lLFxyXG4gICAgbG9zZXI6IGxvc2VyU2NlbmUsXHJcbiAgICB3aW5uZXJDYXJkLFxyXG4gICAgbG9zZXJDYXJkLFxyXG4gICAgbG9zZXJSYW5rLFxyXG4gIH0gPSBjaG9pY2U7XHJcblxyXG4gIGNvbnN0IHdpbm5lcklkID0gd2lubmVyU2NlbmUuaWQ7XHJcbiAgY29uc3QgbG9zZXJJZCA9IGxvc2VyU2NlbmUuaWQ7XHJcblxyXG4gIGlmIChzdGF0ZS5jdXJyZW50TW9kZSA9PT0gXCJwbGFjZW1lbnRcIikge1xyXG4gICAgaGFuZGxlUGxhY2VtZW50Q2hvaWNlKGNob2ljZSk7XHJcbiAgICByZXR1cm47XHJcbiAgfVxyXG5cclxuICAvLyBIYW5kbGUgZ2F1bnRsZXQgbW9kZSAoY2xpbWJlciB0cmFja2luZylcclxuICBpZiAoc3RhdGUuY3VycmVudE1vZGUgPT09IFwiZ2F1bnRsZXRcIikge1xyXG4gICAgLy8gQ2hlY2sgaWYgd2UncmUgaW4gZmFsbGluZyBtb2RlIChmaW5kaW5nIGZsb29yIGFmdGVyIGEgbG9zcylcclxuICAgIGlmIChzdGF0ZS5nYXVudGxldEZhbGxpbmcgJiYgc3RhdGUuZ2F1bnRsZXRGYWxsaW5nU2NlbmUpIHtcclxuICAgICAgY29uc3QgZmFsbGluZ1NjZW5lID0gc3RhdGUuZ2F1bnRsZXRGYWxsaW5nU2NlbmU7XHJcbiAgICAgIGNvbnN0IGxvc2VyUmF0aW5nID0gbG9zZXJTY2VuZS5yYXRpbmcxMDAgfHwgMTtcclxuICAgICAgY29uc29sZS5sb2coXHJcbiAgICAgICAgYFtTdGFzaCBCYXR0bGVdIPCfk4ogRmFsbGluZyBtb2RlOiBmYWxsaW5nU2NlbmU9JHtmYWxsaW5nU2NlbmUuaWR9IHdpbm5lcklkPSR7d2lubmVySWR9IGxvc2VySWQ9JHtsb3NlcklkfSBsb3NlclJhdGluZz0ke2xvc2VyUmF0aW5nfWAsXHJcbiAgICAgICk7XHJcbiAgICAgIGlmICh3aW5uZXJJZCA9PT0gZmFsbGluZ1NjZW5lLmlkKSB7XHJcbiAgICAgICAgLy8gRmFsbGluZyBzY2VuZSB3b24gLSBmb3VuZCB0aGVpciBmbG9vciFcclxuICAgICAgICBjb25zdCBmaW5hbFJhdGluZyA9IE1hdGgubWluKDEwMCwgbG9zZXJSYXRpbmcgKyAxKTtcclxuICAgICAgICBjb25zdCBmYWxsaW5nQW5pbVN0YXJ0ID0gZmFsbGluZ1NjZW5lLnJhdGluZzEwMCA/PyAwO1xyXG4gICAgICAgIGNvbnNvbGUubG9nKFxyXG4gICAgICAgICAgYFtTdGFzaCBCYXR0bGVdIPCfk4ogRmFsbGluZyBzY2VuZSBmb3VuZCBmbG9vcjogbG9zZXJSYXRpbmc9JHtsb3NlclJhdGluZ30g4oaSIGZpbmFsUmF0aW5nPSR7ZmluYWxSYXRpbmd9YCxcclxuICAgICAgICApO1xyXG4gICAgICAgIHZvaWQgdXBkYXRlU2NlbmVSYXRpbmcoZmFsbGluZ1NjZW5lLmlkLCBmaW5hbFJhdGluZyk7XHJcbiAgICAgICAgZmFsbGluZ1NjZW5lLnJhdGluZzEwMCA9IGZpbmFsUmF0aW5nO1xyXG5cclxuICAgICAgICAvLyBGaW5hbCByYW5rIGlzIG9uZSBhYm92ZSB0aGUgb3Bwb25lbnQgKHdlIGJlYXQgdGhlbSwgc28gd2UncmUgYWJvdmUgdGhlbSlcclxuICAgICAgICBjb25zdCBmaW5hbFJhbmsgPSBNYXRoLm1heCgxLCAobG9zZXJSYW5rID8/IDEpIC0gMSk7XHJcblxyXG4gICAgICAgIHdpbm5lckNhcmQuY2xhc3NMaXN0LmFkZChcInNiLXdpbm5lclwiKTtcclxuICAgICAgICBpZiAobG9zZXJDYXJkKSBsb3NlckNhcmQuY2xhc3NMaXN0LmFkZChcInNiLWxvc2VyXCIpO1xyXG5cclxuICAgICAgICBzaG93UmF0aW5nQW5pbWF0aW9uKHdpbm5lckNhcmQsIGZhbGxpbmdBbmltU3RhcnQsIGZpbmFsUmF0aW5nLCB0cnVlKTtcclxuXHJcbiAgICAgICAgc2V0VGltZW91dCgoKSA9PiB7XHJcbiAgICAgICAgICBzaG93UGxhY2VtZW50U2NyZWVuKGZhbGxpbmdTY2VuZSwgZmluYWxSYW5rLCBmaW5hbFJhdGluZyk7XHJcbiAgICAgICAgfSwgMTUwMCk7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgICB9IGVsc2Uge1xyXG4gICAgICAgIC8vIEZhbGxpbmcgc2NlbmUgbG9zdCBhZ2FpbiAtIGtlZXAgZmFsbGluZ1xyXG4gICAgICAgIHN0YXRlLmdhdW50bGV0RGVmZWF0ZWQucHVzaCh3aW5uZXJJZCk7XHJcbiAgICAgICAgc2F2ZVN0YXRlKCk7XHJcblxyXG4gICAgICAgIHdpbm5lckNhcmQuY2xhc3NMaXN0LmFkZChcInNiLXdpbm5lclwiKTtcclxuICAgICAgICBpZiAobG9zZXJDYXJkKSBsb3NlckNhcmQuY2xhc3NMaXN0LmFkZChcInNiLWxvc2VyXCIpO1xyXG5cclxuICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHtcclxuICAgICAgICAgIGxvYWROZXdQYWlyKCk7XHJcbiAgICAgICAgfSwgODAwKTtcclxuICAgICAgICByZXR1cm47XHJcbiAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICAvLyBDbGltYiAvIGZpcnN0IGJhdHRsZSAoZmFsbGluZyBoYW5kbGVkIGFib3ZlKVxyXG4gICAgdm9pZCBoYW5kbGVHYXVudGxldENsaW1iQ2hvaWNlKGNob2ljZSk7XHJcbiAgICByZXR1cm47XHJcbiAgfVxyXG5cclxuICAvLyBIYW5kbGUgY2hhbXBpb24gbW9kZSAobGlrZSBnYXVudGxldCBidXQgd2lubmVyIGFsd2F5cyB0YWtlcyBvdmVyKVxyXG4gIGlmIChzdGF0ZS5jdXJyZW50TW9kZSA9PT0gXCJjaGFtcGlvblwiKSB7XHJcbiAgICB2b2lkIGhhbmRsZUNoYW1waW9uQ2hvaWNlKGNob2ljZSk7XHJcbiAgICByZXR1cm47XHJcbiAgfVxyXG5cclxuICAvLyBTd2lzczogY2FsY3VsYXRlIGFuZCBzaG93IHJhdGluZyBjaGFuZ2VzIChib3RoIHNjZW5lcyBzdGF5IGluIHRoZSBwb29sKVxyXG4gIGNvbnN0IHdpbm5lclN0YXJ0ID0gYmF0dGxlUmF0aW5nKHdpbm5lclNjZW5lKTtcclxuICBjb25zdCBsb3NlclN0YXJ0ID0gYmF0dGxlUmF0aW5nKGxvc2VyU2NlbmUpO1xyXG4gIGNvbnN0IHsgd2lubmVyOiB3aW5uZXJEZWx0YSwgbG9zZXI6IGxvc2VyRGVsdGEgfSA9IHJlc29sdmVDb21wYXJpc29uKHdpbm5lclNjZW5lLCBsb3NlclNjZW5lKTtcclxuXHJcbiAgc2F2ZVN0YXRlKCk7XHJcblxyXG4gIHdpbm5lckNhcmQuY2xhc3NMaXN0LmFkZChcInNiLXdpbm5lclwiKTtcclxuICBpZiAobG9zZXJDYXJkKSBsb3NlckNhcmQuY2xhc3NMaXN0LmFkZChcInNiLWxvc2VyXCIpO1xyXG5cclxuICBzaG93UmF0aW5nQW5pbWF0aW9uKHdpbm5lckNhcmQsIHdpbm5lclN0YXJ0LCB3aW5uZXJTdGFydCArIHdpbm5lckRlbHRhLCB0cnVlKTtcclxuICBpZiAobG9zZXJDYXJkKSB7XHJcbiAgICBzaG93UmF0aW5nQW5pbWF0aW9uKGxvc2VyQ2FyZCwgbG9zZXJTdGFydCwgbG9zZXJTdGFydCArIGxvc2VyRGVsdGEsIGZhbHNlKTtcclxuICB9XHJcbiAgc2NoZWR1bGVOZXh0UGFpckFmdGVyQW5pbWF0aW9ucygpO1xyXG59XHJcblxyXG5jb25zdCBSQVRJTkdfQU5JTV9NQVhfVE9UQUxfTVMgPSAxNDAwO1xyXG5jb25zdCBSQVRJTkdfQU5JTV9IT0xEX01TID0gMzAwO1xyXG5jb25zdCBSQVRJTkdfQU5JTV9DT1VOVF9CVURHRVRfTVMgPSBSQVRJTkdfQU5JTV9NQVhfVE9UQUxfTVMgLSBSQVRJTkdfQU5JTV9IT0xEX01TO1xyXG5jb25zdCBSQVRJTkdfQU5JTV9ERUZBVUxUX1NURVBfTVMgPSA1MDtcclxuY29uc3QgUkFUSU5HX0FOSU1fTUlOX1NURVBfTVMgPSA4O1xyXG5cclxuZnVuY3Rpb24gc2NoZWR1bGVOZXh0UGFpckFmdGVyQW5pbWF0aW9ucygpOiB2b2lkIHtcclxuICAvLyBGdW4gbW9kZSBoYXMgbm8gcmF0aW5nIGFuaW1hdGlvbiB0byB3YWl0IGZvclxyXG4gIHNldFRpbWVvdXQoKCkgPT4gbG9hZE5ld1BhaXIoKSwgcmF0aW5nc0VuYWJsZWQoKSA/IDE1MDAgOiA2MDApO1xyXG59XHJcblxyXG4vKiogQ291bnQtdXAvZG93biBvdmVybGF5OyBsYXJnZSBqdW1wcyBzcGVlZCB1cCBzbyB0aGUgZnVsbCBjb3VudCBmaXRzIHdpdGhpbiAxNDAwbXMuICovXHJcbmZ1bmN0aW9uIHNob3dSYXRpbmdBbmltYXRpb24oXHJcbiAgY2FyZDogSFRNTEVsZW1lbnQsXHJcbiAgb2xkUmF0aW5nOiBudW1iZXIsXHJcbiAgbmV3UmF0aW5nOiBudW1iZXIsXHJcbiAgaXNXaW5uZXI6IGJvb2xlYW4sXHJcbik6IHZvaWQge1xyXG4gIGlmICghcmF0aW5nc0VuYWJsZWQoKSkgcmV0dXJuO1xyXG4gIGNvbnN0IGNoYW5nZSA9IG5ld1JhdGluZyAtIG9sZFJhdGluZztcclxuICAvLyBDcmVhdGUgb3ZlcmxheVxyXG4gIGNvbnN0IG92ZXJsYXkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xyXG4gIG92ZXJsYXkuY2xhc3NOYW1lID0gYHNiLXJhdGluZy1vdmVybGF5ICR7aXNXaW5uZXIgPyBcInNiLXJhdGluZy13aW5uZXJcIiA6IFwic2ItcmF0aW5nLWxvc2VyXCJ9YDtcclxuXHJcbiAgY29uc3QgcmF0aW5nRGlzcGxheSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XHJcbiAgcmF0aW5nRGlzcGxheS5jbGFzc05hbWUgPSBcInNiLXJhdGluZy1kaXNwbGF5XCI7XHJcbiAgcmF0aW5nRGlzcGxheS50ZXh0Q29udGVudCA9IFN0cmluZyhvbGRSYXRpbmcpO1xyXG5cclxuICBjb25zdCBjaGFuZ2VEaXNwbGF5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcclxuICBjaGFuZ2VEaXNwbGF5LmNsYXNzTmFtZSA9IFwic2ItcmF0aW5nLWNoYW5nZVwiO1xyXG4gIGNoYW5nZURpc3BsYXkudGV4dENvbnRlbnQgPSBjaGFuZ2UgPiAwID8gYCske2NoYW5nZX1gIDogU3RyaW5nKGNoYW5nZSk7XHJcblxyXG4gIG92ZXJsYXkuYXBwZW5kQ2hpbGQocmF0aW5nRGlzcGxheSk7XHJcbiAgb3ZlcmxheS5hcHBlbmRDaGlsZChjaGFuZ2VEaXNwbGF5KTtcclxuICBjYXJkLmFwcGVuZENoaWxkKG92ZXJsYXkpO1xyXG5cclxuICBjb25zdCB0b3RhbFN0ZXBzID0gTWF0aC5hYnMoY2hhbmdlKTtcclxuICBpZiAodG90YWxTdGVwcyA9PT0gMCkge1xyXG4gICAgcmF0aW5nRGlzcGxheS50ZXh0Q29udGVudCA9IFN0cmluZyhuZXdSYXRpbmcpO1xyXG4gICAgc2V0VGltZW91dCgoKSA9PiBvdmVybGF5LnJlbW92ZSgpLCBSQVRJTkdfQU5JTV9NQVhfVE9UQUxfTVMpO1xyXG4gICAgcmV0dXJuO1xyXG4gIH1cclxuXHJcbiAgY29uc3Qgc3RlcE1zID0gTWF0aC5taW4oXHJcbiAgICBSQVRJTkdfQU5JTV9ERUZBVUxUX1NURVBfTVMsXHJcbiAgICBNYXRoLm1heChSQVRJTkdfQU5JTV9NSU5fU1RFUF9NUywgTWF0aC5yb3VuZChSQVRJTkdfQU5JTV9DT1VOVF9CVURHRVRfTVMgLyB0b3RhbFN0ZXBzKSksXHJcbiAgKTtcclxuXHJcbiAgbGV0IGN1cnJlbnREaXNwbGF5ID0gb2xkUmF0aW5nO1xyXG4gIGNvbnN0IHN0ZXAgPSBjaGFuZ2UgPiAwID8gMSA6IC0xO1xyXG4gIGxldCBzdGVwQ291bnQgPSAwO1xyXG5cclxuICBjb25zdCBpbnRlcnZhbCA9IHNldEludGVydmFsKCgpID0+IHtcclxuICAgIHN0ZXBDb3VudCsrO1xyXG4gICAgY3VycmVudERpc3BsYXkgKz0gc3RlcDtcclxuICAgIHJhdGluZ0Rpc3BsYXkudGV4dENvbnRlbnQgPSBTdHJpbmcoY3VycmVudERpc3BsYXkpO1xyXG5cclxuICAgIGlmIChzdGVwQ291bnQgPj0gdG90YWxTdGVwcykge1xyXG4gICAgICBjbGVhckludGVydmFsKGludGVydmFsKTtcclxuICAgICAgcmF0aW5nRGlzcGxheS50ZXh0Q29udGVudCA9IFN0cmluZyhuZXdSYXRpbmcpO1xyXG4gICAgfVxyXG4gIH0sIHN0ZXBNcyk7XHJcblxyXG4gIHNldFRpbWVvdXQoKCkgPT4gb3ZlcmxheS5yZW1vdmUoKSwgUkFUSU5HX0FOSU1fTUFYX1RPVEFMX01TKTtcclxufVxyXG4iLCAiLy8gVGhlIGJhdHRsZSBtb2RhbDogb3BlbnMvY2xvc2VzLCB3aXJlcyBjb250cm9scyBhbmQga2V5Ym9hcmQgc2hvcnRjdXRzLlxyXG5cclxuaW1wb3J0IHsgY2xlYXJTY2VuZUNhY2hlLCByZXNldFNhbmRib3ggfSBmcm9tIFwiLi4vY2FjaGVcIjtcclxuaW1wb3J0IHsgZ2V0U2NlbmVJZEZyb21VcmwsIHNjZW5lQ3VzdG9tRmllbGRzU3VwcG9ydGVkIH0gZnJvbSBcIi4uL2dyYXBocWxcIjtcclxuaW1wb3J0IHsgU0NFTkVfTUlTU0lOR19FVkVOVCB9IGZyb20gXCIuLi9yYXRpbmdcIjtcclxuaW1wb3J0IHsgbG9hZFNldHRpbmdzIH0gZnJvbSBcIi4uL3NldHRpbmdzXCI7XHJcbmltcG9ydCB7IHJlc2V0UnVuU3RhdGUsIHJlc2V0U2h1ZmZsZSwgc3RhdGUgfSBmcm9tIFwiLi4vc3RhdGVcIjtcclxuaW1wb3J0IHsgbG9hZFN0YXRlLCBzYXZlU3RhdGUgfSBmcm9tIFwiLi4vc3RvcmFnZVwiO1xyXG5pbXBvcnQgdHlwZSB7IE1vZGUsIFNldHRpbmdzIH0gZnJvbSBcIi4uL3R5cGVzXCI7XHJcbmltcG9ydCB7IGNhbmNlbERlbGV0ZURpYWxvZywgaXNEZWxldGVEaWFsb2dPcGVuIH0gZnJvbSBcIi4vZGVsZXRlRGlhbG9nXCI7XHJcbmltcG9ydCB7XHJcbiAgYXBwbHlQcmV2aWV3U2V0dGluZ3MsXHJcbiAgY3JlYXRlTWFpblVJLFxyXG4gIGhhbmRsZVNjZW5lR29uZSxcclxuICBsb2FkTmV3UGFpcixcclxuICByZW5kZXJQYWlyLFxyXG4gIHJlc3RvcmVDdXJyZW50UGFpcixcclxuICBza2lwUGFpcixcclxuICB1cGRhdGVDbGltYlBvb2xXYXJuaW5nLFxyXG4gIHVwZGF0ZUZ1bkJhZGdlLFxyXG4gIHVwZGF0ZU1vZGVJbmZvLFxyXG4gIHZlcmlmeUN1cnJlbnRQYWlyLFxyXG59IGZyb20gXCIuL21haW5VSVwiO1xyXG5pbXBvcnQgeyBiaW5kU2V0dGluZ3NDb250cm9scywgZ2V0QWN0aXZlVGFiLCBzaG93VGFiLCBzeW5jU2V0dGluZ3NDb250cm9scyB9IGZyb20gXCIuL3NldHRpbmdzUGFuZWxcIjtcclxuXHJcbi8vIFRyYWNrIGtleWJvYXJkIGhhbmRsZXIgc28gd2UgY2FuIHJlbW92ZSBpdCBvbiBjbG9zZVxyXG5sZXQgbW9kYWxLZXlIYW5kbGVyOiAoKGU6IEtleWJvYXJkRXZlbnQpID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XHJcbmxldCBzY2VuZU1pc3NpbmdMaXN0ZW5lckFkZGVkID0gZmFsc2U7XHJcblxyXG4vKiogT24gPGJvZHk+IHdoaWxlIEJhdHRsZSBpcyBvcGVuOyBDU1MgdXNlcyBpdCB0byBsaWZ0IFN0YXNoJ3Mgb3duIG1vZGFscyBhYm92ZSBvdXJzLiAqL1xyXG5jb25zdCBCQVRUTEVfT1BFTl9DTEFTUyA9IFwic2ItYmF0dGxlLW9wZW5cIjtcclxuXHJcbi8qKiBSZS1yZW5kZXIgdGhlIHBhaXIgb24gc2NyZWVuIHNvIGNhcmQgbWFya3VwIHBpY2tzIHVwIGEgY2hhbmdlZCBzZXR0aW5nLiAqL1xyXG5mdW5jdGlvbiByZXJlbmRlckN1cnJlbnRQYWlyKCk6IHZvaWQge1xyXG4gIGNvbnN0IHsgbGVmdCwgcmlnaHQgfSA9IHN0YXRlLmN1cnJlbnRQYWlyO1xyXG4gIGlmICghbGVmdCB8fCAhcmlnaHQgfHwgc3RhdGUuZGlzYWJsZUNob2ljZSB8fCAhZG9jdW1lbnQucXVlcnlTZWxlY3RvcihcIiNzYi1jb21wYXJpc29uLWFyZWEgLnNiLXZzLWNvbnRhaW5lclwiKSkge1xyXG4gICAgcmV0dXJuO1xyXG4gIH1cclxuICByZW5kZXJQYWlyKFtsZWZ0LCByaWdodF0sIFtzdGF0ZS5jdXJyZW50UmFua3MubGVmdCwgc3RhdGUuY3VycmVudFJhbmtzLnJpZ2h0XSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIG9uU2V0dGluZ0NoYW5nZWQoa2V5OiBrZXlvZiBTZXR0aW5ncyk6IHZvaWQge1xyXG4gIHN3aXRjaCAoa2V5KSB7XHJcbiAgICBjYXNlIFwiZmlsdGVyT3Bwb25lbnRzXCI6XHJcbiAgICAgIC8vIHN3aXRjaGluZyB0aGUgdG9nZ2xlIGNvdW50cyBhcyBjaGFuZ2luZyBmaWx0ZXJzOiByZXNldCBhbnkgcnVuXHJcbiAgICAgIGlmIChzdGF0ZS5jdXJyZW50TW9kZSAhPT0gXCJzd2lzc1wiKSByZXNldFJ1blN0YXRlKCk7XHJcbiAgICAgIHNhdmVTdGF0ZSgpO1xyXG4gICAgICBsb2FkTmV3UGFpcigpO1xyXG4gICAgICB1cGRhdGVDbGltYlBvb2xXYXJuaW5nKCk7XHJcbiAgICAgIGJyZWFrO1xyXG4gICAgY2FzZSBcImZ1bk1vZGVcIjpcclxuICAgICAgLy8gU3dpdGNoaW5nIGJldHdlZW4gcmVhbCBhbmQgc2FuZGJveCByYXRpbmdzIG1pZC1ydW4gd291bGQgbWl4IHRoZSB0d286IHN0YXJ0IGZyZXNoXHJcbiAgICAgIHJlc2V0U2FuZGJveCgpO1xyXG4gICAgICByZXNldFNodWZmbGUoKTtcclxuICAgICAgcmVzZXRSdW5TdGF0ZSgpO1xyXG4gICAgICBzYXZlU3RhdGUoKTtcclxuICAgICAgdXBkYXRlRnVuQmFkZ2UoKTtcclxuICAgICAgbG9hZE5ld1BhaXIoKTtcclxuICAgICAgYnJlYWs7XHJcbiAgICBjYXNlIFwicHJldmlld1ZvbHVtZVwiOlxyXG4gICAgY2FzZSBcImF1dG9wbGF5UHJldmlld3NcIjpcclxuICAgICAgYXBwbHlQcmV2aWV3U2V0dGluZ3MoKTtcclxuICAgICAgYnJlYWs7XHJcbiAgICBjYXNlIFwib3BlbkluTmV3VGFiXCI6XHJcbiAgICBjYXNlIFwiY2xlYW5Nb2RlXCI6XHJcbiAgICBjYXNlIFwidW5yYXRlZFJhdGluZ1wiOlxyXG4gICAgICByZXJlbmRlckN1cnJlbnRQYWlyKCk7XHJcbiAgICAgIGJyZWFrO1xyXG4gIH1cclxufVxyXG5cclxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIG9wZW5Nb2RhbCgpOiBQcm9taXNlPHZvaWQ+IHtcclxuICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCfjq8gT3BlbmluZyBtb2RhbC4uLlwiKTtcclxuXHJcbiAgY29uc3QgWywgY3VzdG9tRmllbGRzT2tdID0gYXdhaXQgUHJvbWlzZS5hbGwoW2xvYWRTZXR0aW5ncygpLCBzY2VuZUN1c3RvbUZpZWxkc1N1cHBvcnRlZCgpXSk7XHJcbiAgaWYgKCFjdXN0b21GaWVsZHNPaykge1xyXG4gICAgc2hvd1Vuc3VwcG9ydGVkU3Rhc2goKTtcclxuICAgIHJldHVybjtcclxuICB9XHJcbiAgYWRkS2V5U3dhbGxvd2VycygpO1xyXG5cclxuICAvLyBPcHRpb25hbGx5IHBhdXNlIHdoYXRldmVyIFN0YXNoIGlzIHBsYXlpbmcgc28gaXQgZG9lc24ndCBvdmVybGFwIHRoZSBiYXR0bGUgcHJldmlld3NcclxuICBpZiAoc3RhdGUuc2V0dGluZ3MucGF1c2VNZWRpYU9uT3Blbikge1xyXG4gICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbDxIVE1MTWVkaWFFbGVtZW50PihcInZpZGVvLCBhdWRpb1wiKS5mb3JFYWNoKCh2KSA9PiB2LnBhdXNlKCkpO1xyXG4gIH1cclxuXHJcbiAgaWYgKCFzY2VuZU1pc3NpbmdMaXN0ZW5lckFkZGVkKSB7XHJcbiAgICBzY2VuZU1pc3NpbmdMaXN0ZW5lckFkZGVkID0gdHJ1ZTtcclxuICAgIHdpbmRvdy5hZGRFdmVudExpc3RlbmVyKFNDRU5FX01JU1NJTkdfRVZFTlQsIChlKSA9PiB7XHJcbiAgICAgIHZvaWQgaGFuZGxlU2NlbmVHb25lKChlIGFzIEN1c3RvbUV2ZW50PHN0cmluZz4pLmRldGFpbCk7XHJcbiAgICB9KTtcclxuICB9XHJcblxyXG4gIC8vIFRyeSB0byBsb2FkIHNhdmVkIHN0YXRlXHJcbiAgY29uc3QgaGFzU3RhdGUgPSBsb2FkU3RhdGUoKTtcclxuICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g8J+TiyBMb2NhbFN0b3JhZ2Ugc3RhdGU6ICR7aGFzU3RhdGUgPyBcImZvdW5kXCIgOiBcIm5vbmVcIn1gKTtcclxuXHJcbiAgLy8gQ2hlY2sgaWYgVVJMIGZpbHRlciBwYXJhbXMgaGF2ZSBjaGFuZ2VkIC0gaWYgc28sIHJlc2V0IHN0YXRlXHJcbiAgY29uc3QgY3VycmVudEZpbHRlclBhcmFtcyA9IHdpbmRvdy5sb2NhdGlvbi5zZWFyY2g7XHJcbiAgY29uc3QgZmlsdGVyc0NoYW5nZWQgPSBoYXNTdGF0ZSAmJiBzdGF0ZS5zYXZlZEZpbHRlclBhcmFtcyAhPT0gY3VycmVudEZpbHRlclBhcmFtcztcclxuXHJcbiAgaWYgKGZpbHRlcnNDaGFuZ2VkKSB7XHJcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIEZpbHRlciBwYXJhbXMgY2hhbmdlZCwgcmVzZXR0aW5nIHJ1biBzdGF0ZSBhbmQgZmlsdGVyZWQgY2FjaGVcIik7XHJcbiAgICBzdGF0ZS5jdXJyZW50UGFpciA9IHsgbGVmdDogbnVsbCwgcmlnaHQ6IG51bGwgfTtcclxuICAgIHN0YXRlLmN1cnJlbnRSYW5rcyA9IHsgbGVmdDogbnVsbCwgcmlnaHQ6IG51bGwgfTtcclxuICAgIHJlc2V0UnVuU3RhdGUoKTtcclxuICAgIHN0YXRlLnNhdmVkRmlsdGVyUGFyYW1zID0gY3VycmVudEZpbHRlclBhcmFtcztcclxuXHJcbiAgICAvLyBDbGVhciBmaWx0ZXJlZCBzY2VuZXMgY2FjaGUgKGJ1dCBrZWVwIGFsbCBzY2VuZXMgY2FjaGUpXHJcbiAgICBzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJlZFNjZW5lcyA9IG51bGw7XHJcbiAgICBzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJLZXkgPSBudWxsO1xyXG5cclxuICAgIC8vIFJlc2V0IHNodWZmbGUgZm9yIG5ldyBmaWx0ZXJcclxuICAgIHJlc2V0U2h1ZmZsZSgpO1xyXG4gIH1cclxuXHJcbiAgLy8gRGV0ZWN0IGlmIG9wZW5lZCBmcm9tIGFuIGluZGl2aWR1YWwgc2NlbmUgcGFnZSAoZS5nLiAvc2NlbmVzLzEyMylcclxuICBjb25zdCBzY2VuZVBhZ2VJZCA9IGdldFNjZW5lSWRGcm9tVXJsKCk7XHJcbiAgY29uc3Qgc2NlbmVBbHJlYWR5SW5QYWlyID1cclxuICAgIHNjZW5lUGFnZUlkICYmXHJcbiAgICBzdGF0ZS5jdXJyZW50UGFpci5sZWZ0ICYmXHJcbiAgICBzdGF0ZS5jdXJyZW50UGFpci5yaWdodCAmJlxyXG4gICAgKFN0cmluZyhzdGF0ZS5jdXJyZW50UGFpci5sZWZ0LmlkKSA9PT0gc2NlbmVQYWdlSWQgfHxcclxuICAgICAgU3RyaW5nKHN0YXRlLmN1cnJlbnRQYWlyLnJpZ2h0LmlkKSA9PT0gc2NlbmVQYWdlSWQpO1xyXG4gIGNvbnN0IGZvcmNlU2NlbmVCYXR0bGUgPSBzY2VuZVBhZ2VJZCAmJiAhc2NlbmVBbHJlYWR5SW5QYWlyO1xyXG5cclxuICBpZiAoZm9yY2VTY2VuZUJhdHRsZSkge1xyXG4gICAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIPCfjq8gT3BlbmVkIGZyb20gc2NlbmUgcGFnZSAke3NjZW5lUGFnZUlkfSwgc3RhcnRpbmcgbmV3IGJhdHRsZSB3aXRoIHRoaXMgc2NlbmVgKTtcclxuICAgIHJlc2V0UnVuU3RhdGUoKTtcclxuICAgIHN0YXRlLmN1cnJlbnRQYWlyID0geyBsZWZ0OiBudWxsLCByaWdodDogbnVsbCB9O1xyXG4gICAgc3RhdGUuY3VycmVudFJhbmtzID0geyBsZWZ0OiBudWxsLCByaWdodDogbnVsbCB9O1xyXG4gIH1cclxuXHJcbiAgLy8gQ2hlY2sgZm9yIGV4aXN0aW5nIGhpZGRlbiBtb2RhbCAtIHJldXNlIGl0XHJcbiAgY29uc3QgZXhpc3RpbmdNb2RhbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic2ItbW9kYWxcIik7XHJcbiAgaWYgKGV4aXN0aW5nTW9kYWwgJiYgZXhpc3RpbmdNb2RhbC5jbGFzc0xpc3QuY29udGFpbnMoXCJzYi1tb2RhbC1oaWRkZW5cIikpIHtcclxuICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g4pm777iPIFJldXNpbmcgZXhpc3RpbmcgbW9kYWxcIik7XHJcbiAgICBleGlzdGluZ01vZGFsLmNsYXNzTGlzdC5yZW1vdmUoXCJzYi1tb2RhbC1oaWRkZW5cIiwgXCJzYi1tb2RhbC1jbG9zaW5nXCIpO1xyXG4gICAgZG9jdW1lbnQuYm9keS5jbGFzc0xpc3QuYWRkKEJBVFRMRV9PUEVOX0NMQVNTKTtcclxuXHJcbiAgICAvLyBBbHdheXMgcmVvcGVuIG9uIHRoZSBCYXR0bGUgdGFiOyBzZXR0aW5ncyBtYXkgaGF2ZSBjaGFuZ2VkIGVsc2V3aGVyZSBtZWFud2hpbGVcclxuICAgIHNob3dUYWIoZXhpc3RpbmdNb2RhbCwgXCJiYXR0bGVcIik7XHJcbiAgICBzeW5jU2V0dGluZ3NDb250cm9scyhleGlzdGluZ01vZGFsKTtcclxuICAgIHVwZGF0ZUZ1bkJhZGdlKCk7XHJcblxyXG4gICAgLy8gUmUtcmVnaXN0ZXIga2V5Ym9hcmQgaGFuZGxlclxyXG4gICAgaWYgKG1vZGFsS2V5SGFuZGxlcikge1xyXG4gICAgICBkb2N1bWVudC5yZW1vdmVFdmVudExpc3RlbmVyKFwia2V5ZG93blwiLCBtb2RhbEtleUhhbmRsZXIsIHRydWUpO1xyXG4gICAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwia2V5ZG93blwiLCBtb2RhbEtleUhhbmRsZXIsIHRydWUpO1xyXG4gICAgfVxyXG5cclxuICAgIC8vIEZvY3VzIG1vZGFsIGNvbnRlbnRcclxuICAgIGNvbnN0IG1vZGFsQ29udGVudCA9IGV4aXN0aW5nTW9kYWwucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCIuc2ItbW9kYWwtY29udGVudFwiKTtcclxuICAgIGlmIChtb2RhbENvbnRlbnQpIG1vZGFsQ29udGVudC5mb2N1cygpO1xyXG5cclxuICAgIC8vIElmIGZpbHRlcnMgY2hhbmdlZCwgbm8gcGFpciwgb3IgZm9yY2VkIHNjZW5lLCBsb2FkIG5ldyBjb250ZW50XHJcbiAgICBpZiAoZm9yY2VTY2VuZUJhdHRsZSkge1xyXG4gICAgICBsb2FkTmV3UGFpcihzY2VuZVBhZ2VJZCk7XHJcbiAgICB9IGVsc2UgaWYgKGZpbHRlcnNDaGFuZ2VkIHx8ICFzdGF0ZS5jdXJyZW50UGFpci5sZWZ0IHx8ICFzdGF0ZS5jdXJyZW50UGFpci5yaWdodCkge1xyXG4gICAgICBsb2FkTmV3UGFpcigpO1xyXG4gICAgfSBlbHNlIGlmIChkb2N1bWVudC5xdWVyeVNlbGVjdG9yKFwiI3NiLWNvbXBhcmlzb24tYXJlYSAuc2ItdnMtY29udGFpbmVyXCIpKSB7XHJcbiAgICAgIC8vIEV4aXN0aW5nIHBhaXIgaXMgc3RpbGwgdmFsaWQgdW5sZXNzIGEgc2NlbmUgd2FzIGRlbGV0ZWQgZWxzZXdoZXJlIG1lYW53aGlsZVxyXG4gICAgICBhcHBseVByZXZpZXdTZXR0aW5ncygpO1xyXG4gICAgICB2b2lkIHZlcmlmeUN1cnJlbnRQYWlyKCk7XHJcbiAgICB9XHJcblxyXG4gICAgcmV0dXJuO1xyXG4gIH1cclxuXHJcbiAgLy8gUmVtb3ZlIGFueSBub24taGlkZGVuIGV4aXN0aW5nIG1vZGFsIChzaG91bGRuJ3QgaGFwcGVuLCBidXQgc2FmZXR5KVxyXG4gIGlmIChleGlzdGluZ01vZGFsKSBleGlzdGluZ01vZGFsLnJlbW92ZSgpO1xyXG5cclxuICAvLyBJbml0aWFsaXplIGZpbHRlciBwYXJhbXMgdHJhY2tpbmdcclxuICBpZiAoIXN0YXRlLnNhdmVkRmlsdGVyUGFyYW1zKSB7XHJcbiAgICBzdGF0ZS5zYXZlZEZpbHRlclBhcmFtcyA9IGN1cnJlbnRGaWx0ZXJQYXJhbXM7XHJcbiAgfVxyXG5cclxuICBjb25zdCBtb2RhbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XHJcbiAgbW9kYWwuaWQgPSBcInNiLW1vZGFsXCI7XHJcbiAgbW9kYWwuaW5uZXJIVE1MID0gYFxyXG4gICAgICA8ZGl2IGNsYXNzPVwic2ItbW9kYWwtYmFja2Ryb3BcIj48L2Rpdj5cclxuICAgICAgPGRpdiBjbGFzcz1cInNiLW1vZGFsLWNvbnRlbnRcIj5cclxuICAgICAgICA8YnV0dG9uIGNsYXNzPVwic2ItbW9kYWwtY2xvc2VcIiBhcmlhLWxhYmVsPVwiQ2xvc2VcIj7inJU8L2J1dHRvbj5cclxuICAgICAgICAke2NyZWF0ZU1haW5VSSgpfVxyXG4gICAgICA8L2Rpdj5cclxuICAgIGA7XHJcblxyXG4gIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQobW9kYWwpO1xyXG4gIGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LmFkZChCQVRUTEVfT1BFTl9DTEFTUyk7XHJcblxyXG4gIC8vIEZvY3VzIHRoZSBtb2RhbCBjb250ZW50IHNvIGtleWJvYXJkIHNob3J0Y3V0cyB3b3JrIGltbWVkaWF0ZWx5XHJcbiAgY29uc3QgbW9kYWxDb250ZW50ID0gbW9kYWwucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCIuc2ItbW9kYWwtY29udGVudFwiKTtcclxuICBpZiAobW9kYWxDb250ZW50KSB7XHJcbiAgICBtb2RhbENvbnRlbnQuc2V0QXR0cmlidXRlKFwidGFiaW5kZXhcIiwgXCItMVwiKTtcclxuICAgIG1vZGFsQ29udGVudC5zdHlsZS5vdXRsaW5lID0gXCJub25lXCI7XHJcbiAgICBtb2RhbENvbnRlbnQuZm9jdXMoKTtcclxuICB9XHJcblxyXG4gIC8vIE1vZGUgdG9nZ2xlIGJ1dHRvbnNcclxuICBtb2RhbC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PihcIi5zYi1tb2RlLWJ0blwiKS5mb3JFYWNoKChidG4pID0+IHtcclxuICAgIGJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4ge1xyXG4gICAgICBjb25zdCBuZXdNb2RlID0gYnRuLmRhdGFzZXQubW9kZSBhcyBNb2RlO1xyXG4gICAgICBpZiAobmV3TW9kZSAhPT0gc3RhdGUuY3VycmVudE1vZGUpIHtcclxuICAgICAgICBzdGF0ZS5jdXJyZW50TW9kZSA9IG5ld01vZGU7XHJcblxyXG4gICAgICAgIHJlc2V0UnVuU3RhdGUoKTtcclxuXHJcbiAgICAgICAgLy8gUmVzZXQgc2h1ZmZsZSB0byBzdGFydCBmcmVzaCB3aXRoIG5ldyBtb2RlXHJcbiAgICAgICAgc3RhdGUuc2h1ZmZsZUluZGV4ID0gMDtcclxuXHJcbiAgICAgICAgLy8gVXBkYXRlIGJ1dHRvbiBzdGF0ZXNcclxuICAgICAgICBtb2RhbC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxFbGVtZW50PihcIi5zYi1tb2RlLWJ0blwiKS5mb3JFYWNoKChiKSA9PiB7XHJcbiAgICAgICAgICBiLmNsYXNzTGlzdC50b2dnbGUoXCJhY3RpdmVcIiwgYi5kYXRhc2V0Lm1vZGUgPT09IHN0YXRlLmN1cnJlbnRNb2RlKTtcclxuICAgICAgICB9KTtcclxuICAgICAgICB1cGRhdGVNb2RlSW5mbygpO1xyXG5cclxuICAgICAgICAvLyBMb2FkIG5ldyBwYWlyIGluIG5ldyBtb2RlLCBwcmVzZXJ2aW5nIHNjZW5lIHBhZ2UgY29udGV4dFxyXG4gICAgICAgIGxvYWROZXdQYWlyKGdldFNjZW5lSWRGcm9tVXJsKCkpO1xyXG4gICAgICAgIHVwZGF0ZUNsaW1iUG9vbFdhcm5pbmcoKTtcclxuICAgICAgICBzYXZlU3RhdGUoKTtcclxuICAgICAgfVxyXG4gICAgfSk7XHJcbiAgfSk7XHJcblxyXG4gIC8vIFRvdWNoLW9ubHkg4pOYOiBzaG93L2hpZGUgdGhlIGN1cnJlbnQgbW9kZSdzIGV4cGxhbmF0aW9uXHJcbiAgY29uc3QgbW9kZUluZm9CdG4gPSBtb2RhbC5xdWVyeVNlbGVjdG9yPEhUTUxCdXR0b25FbGVtZW50PihcIi5zYi1tb2RlLWluZm8tYnRuXCIpO1xyXG4gIGNvbnN0IG1vZGVJbmZvID0gbW9kYWwucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCIjc2ItbW9kZS1pbmZvXCIpO1xyXG4gIG1vZGVJbmZvQnRuPy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4ge1xyXG4gICAgaWYgKCFtb2RlSW5mbykgcmV0dXJuO1xyXG4gICAgdXBkYXRlTW9kZUluZm8oKTtcclxuICAgIG1vZGVJbmZvLmhpZGRlbiA9ICFtb2RlSW5mby5oaWRkZW47XHJcbiAgICBtb2RlSW5mb0J0bi5zZXRBdHRyaWJ1dGUoXCJhcmlhLWV4cGFuZGVkXCIsIFN0cmluZyghbW9kZUluZm8uaGlkZGVuKSk7XHJcbiAgfSk7XHJcblxyXG4gIC8vIEJhdHRsZSAvIFNldHRpbmdzIHRhYnMsIHNldHRpbmdzIGNvbnRyb2xzLCB2b2x1bWVcclxuICBzaG93VGFiKG1vZGFsLCBcImJhdHRsZVwiKTtcclxuICBiaW5kU2V0dGluZ3NDb250cm9scyhtb2RhbCwgb25TZXR0aW5nQ2hhbmdlZCwgKCkgPT4gYXBwbHlQcmV2aWV3U2V0dGluZ3MoKSk7XHJcblxyXG4gIC8vIFNraXAgYnV0dG9uXHJcbiAgbW9kYWwucXVlcnlTZWxlY3RvcihcIiNzYi1za2lwLWJ0blwiKT8uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIHNraXBQYWlyKTtcclxuXHJcbiAgLy8gUmVmcmVzaCBjYWNoZSBidXR0b25cclxuICBjb25zdCByZWZyZXNoQ2FjaGVCdG4gPSBtb2RhbC5xdWVyeVNlbGVjdG9yPEhUTUxCdXR0b25FbGVtZW50PihcIiNzYi1yZWZyZXNoLWNhY2hlLWJ0blwiKTtcclxuICBpZiAocmVmcmVzaENhY2hlQnRuKSB7XHJcbiAgICByZWZyZXNoQ2FjaGVCdG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIGFzeW5jICgpID0+IHtcclxuICAgICAgaWYgKHN0YXRlLmRpc2FibGVDaG9pY2UpIHJldHVybjtcclxuXHJcbiAgICAgIGNvbnN0IGxhYmVsID0gcmVmcmVzaENhY2hlQnRuLnRleHRDb250ZW50O1xyXG4gICAgICByZWZyZXNoQ2FjaGVCdG4uZGlzYWJsZWQgPSB0cnVlO1xyXG4gICAgICByZWZyZXNoQ2FjaGVCdG4udGV4dENvbnRlbnQgPSBcIvCflIQgUmVmcmVzaGluZy4uLlwiO1xyXG5cclxuICAgICAgdHJ5IHtcclxuICAgICAgICBhd2FpdCBjbGVhclNjZW5lQ2FjaGUoKTtcclxuICAgICAgICByZXNldFNhbmRib3goKTtcclxuXHJcbiAgICAgICAgLy8gUmVzZXQgc2h1ZmZsZSBzdGF0ZSBzaW5jZSBzY2VuZSBsaXN0IGlzIGJlaW5nIHJlZnJlc2hlZFxyXG4gICAgICAgIHJlc2V0U2h1ZmZsZSgpO1xyXG5cclxuICAgICAgICAvLyBSZXNldCBydW4gc3RhdGUgc2luY2UgcmFua2luZ3MgbWF5IGhhdmUgY2hhbmdlZFxyXG4gICAgICAgIHJlc2V0UnVuU3RhdGUoKTtcclxuICAgICAgICBzYXZlU3RhdGUoKTtcclxuXHJcbiAgICAgICAgYXdhaXQgbG9hZE5ld1BhaXIoKTtcclxuICAgICAgfSBjYXRjaCAoZSkge1xyXG4gICAgICAgIGNvbnNvbGUuZXJyb3IoXCJbU3Rhc2ggQmF0dGxlXSBSZWZyZXNoIGZhaWxlZDpcIiwgZSk7XHJcbiAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgcmVmcmVzaENhY2hlQnRuLmRpc2FibGVkID0gZmFsc2U7XHJcbiAgICAgICAgcmVmcmVzaENhY2hlQnRuLnRleHRDb250ZW50ID0gbGFiZWw7XHJcbiAgICAgIH1cclxuICAgIH0pO1xyXG4gIH1cclxuXHJcbiAgLy8gTG9hZCBpbml0aWFsIGNvbXBhcmlzb24gb3IgcmVzdG9yZSBzYXZlZCBwYWlyXHJcbiAgaWYgKGZvcmNlU2NlbmVCYXR0bGUpIHtcclxuICAgIGNvbnNvbGUubG9nKGBbU3Rhc2ggQmF0dGxlXSDwn46vIFN0YXJ0aW5nIGJhdHRsZSB3aXRoIHNjZW5lICR7c2NlbmVQYWdlSWR9IGZyb20gc2NlbmUgcGFnZWApO1xyXG4gICAgbG9hZE5ld1BhaXIoc2NlbmVQYWdlSWQpO1xyXG4gIH0gZWxzZSBpZiAoaGFzU3RhdGUgJiYgc3RhdGUuY3VycmVudFBhaXIubGVmdCAmJiBzdGF0ZS5jdXJyZW50UGFpci5yaWdodCAmJiAhZmlsdGVyc0NoYW5nZWQpIHtcclxuICAgIGNvbnNvbGUubG9nKFxyXG4gICAgICBgW1N0YXNoIEJhdHRsZV0g8J+TgiBSZXN0b3Jpbmcgc2F2ZWQgcGFpciBmcm9tIGxvY2FsU3RvcmFnZSAoU2NlbmUgJHtzdGF0ZS5jdXJyZW50UGFpci5sZWZ0LmlkfSB2cyBTY2VuZSAke3N0YXRlLmN1cnJlbnRQYWlyLnJpZ2h0LmlkfSlgLFxyXG4gICAgKTtcclxuICAgIHZvaWQgcmVzdG9yZUN1cnJlbnRQYWlyKCk7XHJcbiAgfSBlbHNlIHtcclxuICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+GlSBObyBzYXZlZCBwYWlyIG9yIGZpbHRlcnMgY2hhbmdlZCwgbG9hZGluZyBuZXcgcGFpci4uLlwiKTtcclxuICAgIGxvYWROZXdQYWlyKCk7XHJcbiAgfVxyXG5cclxuICAvLyBDbG9zZSBoYW5kbGVyc1xyXG4gIG1vZGFsLnF1ZXJ5U2VsZWN0b3IoXCIuc2ItbW9kYWwtYmFja2Ryb3BcIik/LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBjbG9zZU1vZGFsKTtcclxuICBtb2RhbC5xdWVyeVNlbGVjdG9yKFwiLnNiLW1vZGFsLWNsb3NlXCIpPy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgY2xvc2VNb2RhbCk7XHJcblxyXG4gIC8vIFJlbW92ZSBhbnkgZXhpc3Rpbmcga2V5Ym9hcmQgaGFuZGxlcnMgYmVmb3JlIGFkZGluZyBuZXcgb25lc1xyXG4gIGlmIChtb2RhbEtleUhhbmRsZXIpIHtcclxuICAgIGRvY3VtZW50LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJrZXlkb3duXCIsIG1vZGFsS2V5SGFuZGxlciwgdHJ1ZSk7XHJcbiAgfVxyXG5cclxuICAvLyBTaW5nbGUga2V5Ym9hcmQgaGFuZGxlciBmb3IgYWxsIG1vZGFsIHNob3J0Y3V0c1xyXG4gIG1vZGFsS2V5SGFuZGxlciA9IGZ1bmN0aW9uIChlOiBLZXlib2FyZEV2ZW50KSB7XHJcbiAgICBjb25zdCBhY3RpdmVNb2RhbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic2ItbW9kYWxcIik7XHJcbiAgICBpZiAoIWFjdGl2ZU1vZGFsKSB7XHJcbiAgICAgIGlmIChtb2RhbEtleUhhbmRsZXIpIGRvY3VtZW50LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJrZXlkb3duXCIsIG1vZGFsS2V5SGFuZGxlciwgdHJ1ZSk7XHJcbiAgICAgIG1vZGFsS2V5SGFuZGxlciA9IG51bGw7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuXHJcbiAgICAvLyBTdGFzaCdzIG93biBkZWxldGUgZGlhbG9nIChDbGVhbiBtb2RlKSBpcyBvbiB0b3A6IGxldCBpdCBoYXZlIHRoZSBrZXlzIChFc2NhcGUsIEVudGVyKVxyXG4gICAgaWYgKGlzRGVsZXRlRGlhbG9nT3BlbigpKSByZXR1cm47XHJcblxyXG4gICAgLy8gTm90aGluZyB0eXBlZCB3aGlsZSBCYXR0bGUgaXMgb3BlbiBtYXkgcmVhY2ggU3Rhc2gncyBvd24gaG90a2V5cyAocGFnZSBhcnJvd3MsIGxldHRlclxyXG4gICAgLy8gc2hvcnRjdXRzKSwgb3IgaXQgYWN0cyBvbiB0aGUgcGFnZSBiZWhpbmQgdGhlIG1vZGFsLiBEZWZhdWx0IGFjdGlvbnMgKHR5cGluZyBpbiBpbnB1dHMsXHJcbiAgICAvLyBzbGlkZXIgYXJyb3dzLCBjaGVja2JveCBTcGFjZSkgc3RpbGwgaGFwcGVuIHNpbmNlIG9ubHkgcHJvcGFnYXRpb24gaXMgc3RvcHBlZCBoZXJlLlxyXG4gICAgZS5zdG9wSW1tZWRpYXRlUHJvcGFnYXRpb24oKTtcclxuXHJcbiAgICAvLyBFc2NhcGUgdG8gY2xvc2VcclxuICAgIGlmIChlLmtleSA9PT0gXCJFc2NhcGVcIikge1xyXG4gICAgICBlLnByZXZlbnREZWZhdWx0KCk7XHJcbiAgICAgIGNsb3NlTW9kYWwoKTtcclxuICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG5cclxuICAgIC8vIEJhdHRsZSBzaG9ydGN1dHMgb25seSBhcHBseSBvbiB0aGUgQmF0dGxlIHRhYlxyXG4gICAgaWYgKGdldEFjdGl2ZVRhYigpICE9PSBcImJhdHRsZVwiKSByZXR1cm47XHJcblxyXG4gICAgLy8gTGV0IHRoZSB2b2x1bWUgc2xpZGVyIC8gbnVtYmVyIGlucHV0IGtlZXAgdGhlaXIgb3duIGFycm93IGtleXMgKGNoZWNrYm94ZXMgZG9uJ3QgbmVlZCB0aGVtKVxyXG4gICAgY29uc3QgYWN0aXZlID0gZG9jdW1lbnQuYWN0aXZlRWxlbWVudCBhcyBIVE1MSW5wdXRFbGVtZW50IHwgbnVsbDtcclxuICAgIGNvbnN0IHRhZyA9IGFjdGl2ZT8udGFnTmFtZTtcclxuICAgIGNvbnN0IGlzVG9nZ2xlID0gdGFnID09PSBcIklOUFVUXCIgJiYgKGFjdGl2ZT8udHlwZSA9PT0gXCJjaGVja2JveFwiIHx8IGFjdGl2ZT8udHlwZSA9PT0gXCJyYWRpb1wiKTtcclxuICAgIGlmICgodGFnID09PSBcIklOUFVUXCIgJiYgIWlzVG9nZ2xlKSB8fCB0YWcgPT09IFwiVEVYVEFSRUFcIiB8fCB0YWcgPT09IFwiU0VMRUNUXCIpIHJldHVybjtcclxuXHJcbiAgICAvLyBBcnJvdyBrZXlzIHRvIGNob29zZVxyXG4gICAgaWYgKGUua2V5ID09PSBcIkFycm93TGVmdFwiICYmIHN0YXRlLmN1cnJlbnRQYWlyLmxlZnQpIHtcclxuICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xyXG4gICAgICBjb25zdCBsZWZ0Qm9keSA9IGFjdGl2ZU1vZGFsLnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KCcuc2Itc2NlbmUtY2FyZFtkYXRhLXNpZGU9XCJsZWZ0XCJdIC5zYi1zY2VuZS1ib2R5Jyk7XHJcbiAgICAgIGlmIChsZWZ0Qm9keSkgbGVmdEJvZHkuY2xpY2soKTtcclxuICAgIH1cclxuICAgIGlmIChlLmtleSA9PT0gXCJBcnJvd1JpZ2h0XCIgJiYgc3RhdGUuY3VycmVudFBhaXIucmlnaHQpIHtcclxuICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xyXG4gICAgICBjb25zdCByaWdodEJvZHkgPSBhY3RpdmVNb2RhbC5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PignLnNiLXNjZW5lLWNhcmRbZGF0YS1zaWRlPVwicmlnaHRcIl0gLnNiLXNjZW5lLWJvZHknKTtcclxuICAgICAgaWYgKHJpZ2h0Qm9keSkgcmlnaHRCb2R5LmNsaWNrKCk7XHJcbiAgICB9XHJcblxyXG4gICAgLy8gU3BhY2ViYXIgdG8gc2tpcFxyXG4gICAgaWYgKGUua2V5ID09PSBcIiBcIiB8fCBlLmNvZGUgPT09IFwiU3BhY2VcIikge1xyXG4gICAgICAvLyBMZXQgYSBmb2N1c2VkIGJ1dHRvbiBvciBjaGVja2JveCBoYW5kbGUgaXRzIG93biBTcGFjZVxyXG4gICAgICBpZiAodGFnID09PSBcIkJVVFRPTlwiIHx8IGlzVG9nZ2xlKSByZXR1cm47XHJcbiAgICAgIGUucHJldmVudERlZmF1bHQoKTtcclxuICAgICAgc2tpcFBhaXIoKTtcclxuICAgIH1cclxuICB9O1xyXG5cclxuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwia2V5ZG93blwiLCBtb2RhbEtleUhhbmRsZXIsIHRydWUpO1xyXG59XHJcblxyXG4vKiogQmF0dGxlIHN0b3JlcyBFTE8gaW4gc2NlbmUgY3VzdG9tIGZpZWxkczogb24gYSBTdGFzaCB3aXRob3V0IHRoZW0sIGV4cGxhaW4gaW5zdGVhZCBvZiBsb2FkaW5nLiAqL1xyXG5mdW5jdGlvbiBzaG93VW5zdXBwb3J0ZWRTdGFzaCgpOiB2b2lkIHtcclxuICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInNiLW1vZGFsXCIpPy5yZW1vdmUoKTtcclxuICBjb25zdCBtb2RhbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XHJcbiAgbW9kYWwuaWQgPSBcInNiLW1vZGFsXCI7XHJcbiAgbW9kYWwuaW5uZXJIVE1MID0gYFxyXG4gICAgICA8ZGl2IGNsYXNzPVwic2ItbW9kYWwtYmFja2Ryb3BcIj48L2Rpdj5cclxuICAgICAgPGRpdiBjbGFzcz1cInNiLW1vZGFsLWNvbnRlbnRcIj5cclxuICAgICAgICA8YnV0dG9uIGNsYXNzPVwic2ItbW9kYWwtY2xvc2VcIiBhcmlhLWxhYmVsPVwiQ2xvc2VcIj7inJU8L2J1dHRvbj5cclxuICAgICAgICA8ZGl2IGNsYXNzPVwic2ItZXJyb3Itc2NyZWVuXCI+XHJcbiAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItZXJyb3ItaWNvblwiPuKaoO+4jzwvZGl2PlxyXG4gICAgICAgICAgPHAgY2xhc3M9XCJzYi1lcnJvci1tZXNzYWdlXCI+XHJcbiAgICAgICAgICAgIFN0YXNoIEJhdHRsZSBuZWVkcyBhIG5ld2VyIHZlcnNpb24gb2YgU3Rhc2g6IGl0IHN0b3JlcyBlYWNoIHNjZW5lJ3MgRUxPIGluIHNjZW5lIGN1c3RvbVxyXG4gICAgICAgICAgICBmaWVsZHMsIHdoaWNoIHRoaXMgU3Rhc2ggZG9lc24ndCBoYXZlLiBVcGRhdGUgU3Rhc2ggdG8gdXNlIEJhdHRsZS5cclxuICAgICAgICAgIDwvcD5cclxuICAgICAgICA8L2Rpdj5cclxuICAgICAgPC9kaXY+XHJcbiAgICBgO1xyXG4gIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQobW9kYWwpO1xyXG4gIGRvY3VtZW50LmJvZHkuY2xhc3NMaXN0LmFkZChCQVRUTEVfT1BFTl9DTEFTUyk7XHJcbiAgbW9kYWwucXVlcnlTZWxlY3RvcihcIi5zYi1tb2RhbC1iYWNrZHJvcFwiKT8uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIGNsb3NlTW9kYWwpO1xyXG4gIG1vZGFsLnF1ZXJ5U2VsZWN0b3IoXCIuc2ItbW9kYWwtY2xvc2VcIik/LmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBjbG9zZU1vZGFsKTtcclxufVxyXG5cclxuLyoqIFRydWUgd2hpbGUgdGhlIGJhdHRsZSBtb2RhbCBpcyBvbiBzY3JlZW4gKGl0IHN0YXlzIGluIHRoZSBET00sIGhpZGRlbiwgYWZ0ZXIgY2xvc2luZykuICovXHJcbmZ1bmN0aW9uIGlzTW9kYWxWaXNpYmxlKCk6IGJvb2xlYW4ge1xyXG4gIGNvbnN0IG1vZGFsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzYi1tb2RhbFwiKTtcclxuICByZXR1cm4gbW9kYWwgIT09IG51bGwgJiYgIW1vZGFsLmNsYXNzTGlzdC5jb250YWlucyhcInNiLW1vZGFsLWhpZGRlblwiKTtcclxufVxyXG5cclxuLy8gU3Rhc2gncyBob3RrZXlzIChNb3VzZXRyYXApIGFsc28gbGlzdGVuIGZvciBrZXlwcmVzcy9rZXl1cCBvbiBkb2N1bWVudDsga2V5ZG93biBpcyBoYW5kbGVkXHJcbi8vIGJ5IG1vZGFsS2V5SGFuZGxlci4gUmVnaXN0ZXJlZCBvbmNlLCBpbiB0aGUgY2FwdHVyZSBwaGFzZSwgYW5kIGluZXJ0IHdoaWxlIHRoZSBtb2RhbCBpcyBoaWRkZW4uXHJcbmxldCBrZXlTd2FsbG93ZXJzQWRkZWQgPSBmYWxzZTtcclxuZnVuY3Rpb24gYWRkS2V5U3dhbGxvd2VycygpOiB2b2lkIHtcclxuICBpZiAoa2V5U3dhbGxvd2Vyc0FkZGVkKSByZXR1cm47XHJcbiAga2V5U3dhbGxvd2Vyc0FkZGVkID0gdHJ1ZTtcclxuICBjb25zdCBzd2FsbG93ID0gKGU6IEtleWJvYXJkRXZlbnQpOiB2b2lkID0+IHtcclxuICAgIGlmIChpc01vZGFsVmlzaWJsZSgpICYmICFpc0RlbGV0ZURpYWxvZ09wZW4oKSkgZS5zdG9wSW1tZWRpYXRlUHJvcGFnYXRpb24oKTtcclxuICB9O1xyXG4gIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoXCJrZXlwcmVzc1wiLCBzd2FsbG93LCB0cnVlKTtcclxuICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwia2V5dXBcIiwgc3dhbGxvdywgdHJ1ZSk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBjbG9zZU1vZGFsKCk6IHZvaWQge1xyXG4gIGNvbnN0IG1vZGFsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzYi1tb2RhbFwiKTtcclxuICBpZiAoIW1vZGFsIHx8IG1vZGFsLmNsYXNzTGlzdC5jb250YWlucyhcInNiLW1vZGFsLWhpZGRlblwiKSkgcmV0dXJuO1xyXG5cclxuICBjYW5jZWxEZWxldGVEaWFsb2coKTtcclxuXHJcbiAgLy8gU3RvcCBwcmV2aWV3cyAoYXV0b3BsYXkga2VlcHMgdGhlbSBydW5uaW5nIG90aGVyd2lzZSlcclxuICBtb2RhbC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxWaWRlb0VsZW1lbnQ+KFwiLnNiLWhvdmVyLXByZXZpZXdcIikuZm9yRWFjaCgodikgPT4gdi5wYXVzZSgpKTtcclxuXHJcbiAgLy8gQWRkIGNsb3NpbmcgY2xhc3MgdG8gdHJpZ2dlciBmYWRlLW91dCBhbmltYXRpb25cclxuICBtb2RhbC5jbGFzc0xpc3QuYWRkKFwic2ItbW9kYWwtY2xvc2luZ1wiKTtcclxuXHJcbiAgLy8gQWZ0ZXIgYW5pbWF0aW9uIGNvbXBsZXRlcywgaGlkZSB0aGUgbW9kYWwgKGtlZXAgaW4gRE9NIGZvciByZXVzZSlcclxuICBzZXRUaW1lb3V0KCgpID0+IHtcclxuICAgIG1vZGFsLmNsYXNzTGlzdC5hZGQoXCJzYi1tb2RhbC1oaWRkZW5cIik7XHJcbiAgICBkb2N1bWVudC5ib2R5LmNsYXNzTGlzdC5yZW1vdmUoQkFUVExFX09QRU5fQ0xBU1MpO1xyXG4gICAgbW9kYWwuY2xhc3NMaXN0LnJlbW92ZShcInNiLW1vZGFsLWNsb3NpbmdcIik7XHJcbiAgfSwgMjAwKTsgLy8gTWF0Y2ggQ1NTIGFuaW1hdGlvbiBkdXJhdGlvblxyXG5cclxuICAvLyBDbGVhbiB1cCBrZXlib2FyZCBoYW5kbGVyXHJcbiAgaWYgKG1vZGFsS2V5SGFuZGxlcikge1xyXG4gICAgZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImtleWRvd25cIiwgbW9kYWxLZXlIYW5kbGVyLCB0cnVlKTtcclxuICB9XHJcbn1cclxuXHJcbiIsICIvLyBUaGUgbmF2YmFyIFwiQmF0dGxlXCIgYnV0dG9uIHRoYXQgb3BlbnMgdGhlIGNvbXBhcmlzb24gbW9kYWwuXHJcblxyXG5pbXBvcnQgeyBvcGVuTW9kYWwgfSBmcm9tIFwiLi9tb2RhbFwiO1xyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIHNob3VsZFNob3dOYXZCdXR0b24oKTogYm9vbGVhbiB7XHJcbiAgY29uc3QgcGF0aCA9IHdpbmRvdy5sb2NhdGlvbi5wYXRobmFtZTtcclxuICByZXR1cm4gKFxyXG4gICAgcGF0aCA9PT0gXCIvXCIgfHxcclxuICAgIHBhdGggPT09IFwiL3NjZW5lc1wiIHx8XHJcbiAgICBwYXRoID09PSBcIi9zY2VuZXMvXCIgfHxcclxuICAgIHBhdGguc3RhcnRzV2l0aChcIi9zY2VuZXMvXCIpXHJcbiAgKTtcclxufVxyXG5cclxuLyoqIEluamVjdCBvciByZW1vdmUgdGhlIEJhdHRsZSBuYXYgaXRlbSBiYXNlZCBvbiB0aGUgY3VycmVudCByb3V0ZS4gU2FmZSB0byBjYWxsIHJlcGVhdGVkbHkuICovXHJcbmV4cG9ydCBmdW5jdGlvbiBpbmplY3ROYXZCdXR0b24oKTogdm9pZCB7XHJcbiAgY29uc3QgYnV0dG9uSWQgPSBcInBsdWdpbl9zYlwiO1xyXG5cclxuICBpZiAoIXNob3VsZFNob3dOYXZCdXR0b24oKSkge1xyXG4gICAgY29uc3QgZXhpc3RpbmcgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChidXR0b25JZCk7XHJcbiAgICBpZiAoZXhpc3RpbmcpIHtcclxuICAgICAgZXhpc3RpbmcuY2xvc2VzdChcIi5uYXYtbGlua1wiKT8ucmVtb3ZlKCk7XHJcbiAgICB9XHJcbiAgICByZXR1cm47XHJcbiAgfVxyXG5cclxuICBpZiAoZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoYnV0dG9uSWQpKSByZXR1cm47XHJcblxyXG4gIGNvbnN0IG5hdkl0ZW0gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xyXG4gIG5hdkl0ZW0uY2xhc3NOYW1lID0gXCJjb2wtNCBjb2wtc20tMyBjb2wtbWQtMiBjb2wtbGctYXV0byBuYXYtbGlua1wiO1xyXG4gIG5hdkl0ZW0uaWQgPSBidXR0b25JZDtcclxuXHJcbiAgbmF2SXRlbS5pbm5lckhUTUwgPSBgXHJcbiAgICAgICAgPGEgaHJlZj1cIiNcIiBjbGFzcz1cIm1pbmltYWwgcC00IHAteGwtMiBkLWZsZXggZC14bC1pbmxpbmUtYmxvY2sgZmxleC1jb2x1bW4ganVzdGlmeS1jb250ZW50LWJldHdlZW4gYWxpZ24taXRlbXMtY2VudGVyIGJ0biBidG4tcHJpbWFyeVwiPlxyXG4gICAgICAgICAgICA8c3ZnIGFyaWEtaGlkZGVuPVwidHJ1ZVwiIGZvY3VzYWJsZT1cImZhbHNlXCIgY2xhc3M9XCJzdmctaW5saW5lLS1mYSBmYS1pY29uIG5hdi1tZW51LWljb24gZC1ibG9jayBkLXhsLWlubGluZSBtYi0yIG1iLXhsLTBcIiByb2xlPVwiaW1nXCIgeG1sbnM9XCJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2Z1wiIHZpZXdCb3g9XCIwIDAgMzYgMzZcIj5cclxuICAgICAgICAgICAgICAgIDxwYXRoIGZpbGw9XCJjdXJyZW50Q29sb3JcIiBkPVwibTI0IDI5IDUtNUw2IDFIMXY1elwiLz5cclxuICAgICAgICAgICAgICAgIDxwYXRoIGZpbGw9XCJjdXJyZW50Q29sb3JcIiBkPVwiTTEgMXY1bDIzIDIzIDIuNS0yLjV6XCIvPlxyXG4gICAgICAgICAgICAgICAgPHBhdGggZmlsbD1cImN1cnJlbnRDb2xvclwiIGQ9XCJNMzMuNDI0IDMyLjgwOGMuMjg0LS4yODQuNDU4LS42MjYuNTMxLS45NjhsLTUuMjQyLTYuMTk1LS43LS43MDJjLS41NjUtLjU2NC0xLjU3LS40NzMtMi4yNDkuMjA1bC0uNjE0LjYxMmMtLjY3Ny42NzctLjc2OCAxLjY4My0uMjA0IDIuMjQ3bC43NDEuNzQxIDYuMTUgNS4yMDVjLjM0NS0uMDcyLjY4OC0uMjQ3Ljk3NC0uNTMyelwiLz5cclxuICAgICAgICAgICAgICAgIDxwYXRoIGZpbGw9XCJjdXJyZW50Q29sb3JcIiBkPVwiTTMzLjQyNCAzMi44MDhjLjI4NC0uMjg0LjQ1OC0uNjI2LjUzMS0uOTY4bC0xLjM0Mi0xLjU4Ni0uNzM3IDMuNjg0Yy4zMzEtLjA3Ny42NjEtLjI0My45MzUtLjUxOHptLTMuMzEtNS41MDYtLjg4OCA0LjQ0IDEuMjYgMS4wNjcuODItNC4xem0tMS40LTEuNjU3LS43MDItLjcwMmExLjIgMS4yIDAgMCAwLS4zMjYtLjIyNGwtLjk3OCA0Ljg5MiAxLjI2IDEuMDY2Ljk1Ny00Ljc4M3ptLTIuNDAyLS44ODhhMiAyIDAgMCAwLS41NDguMzkybC0uNjE0LjYxYTIgMiAwIDAgMC0uNTEuODZjLS4xNDMuNTEtLjA0NyAxLjAzNi4zMDYgMS4zODhsLjU5Ni41OTZ6bTAgMHEwLS4wMDMgMCAwXCIvPlxyXG4gICAgICAgICAgICAgICAgPHBhdGggZmlsbD1cImN1cnJlbnRDb2xvclwiIGQ9XCJNMzMuMjUgMzZhMi43NSAyLjc1IDAgMSAwIDAtNS41IDIuNzUgMi43NSAwIDAgMCAwIDUuNU0yOS42MjYgMjIuMzI0YTEuMDM0IDEuMDM0IDAgMCAxIDAgMS40NjJsLTYuMDkyIDYuMDkyYTEuMDMyIDEuMDMyIDAgMCAxLTEuNjg2LS4zMzYgMS4wMyAxLjAzIDAgMCAxIC4yMjQtMS4xMjZsNi4wOTItNi4wOTJhMS4wMzMgMS4wMzMgMCAwIDEgMS40NjIgMFwiLz5cclxuICAgICAgICAgICAgICAgIDxwYXRoIGZpbGw9XCJjdXJyZW50Q29sb3JcIiBkPVwiTTIyLjA3MiAzMS42MjdhMS43NSAxLjc1IDAgMSAwIDAtMy41IDEuNzUgMS43NSAwIDAgMCAwIDMuNU0yOS42MjYgMjQuMDczYTEuNzUgMS43NSAwIDEgMCAwLTMuNSAxLjc1IDEuNzUgMCAwIDAgMCAzLjVcIi8+XHJcbiAgICAgICAgICAgICAgICA8cGF0aCBmaWxsPVwiY3VycmVudENvbG9yXCIgZD1cIk0yMi4wNzIgMzAuODc3YTEgMSAwIDEgMCAwLTIgMSAxIDAgMCAwIDAgMk0yOS42MjYgMjMuMzIzYTEgMSAwIDEgMCAwLTIgMSAxIDAgMCAwIDAgMk0zMy45MDMgMjkuMzQyYS43Ni43NiAwIDAgMSAwIDEuMDc4bC0zLjQ3NiAzLjQ3NWEuNzYyLjc2MiAwIDAgMS0xLjA3OC0xLjA3OGwzLjQ3Ni0zLjQ3NWEuNzYuNzYgMCAwIDEgMS4wNzggME0xMiAyOWwtNS01TDMwIDFoNXY1elwiLz5cclxuICAgICAgICAgICAgICAgIDxwYXRoIGZpbGw9XCJjdXJyZW50Q29sb3JcIiBkPVwiTTM1IDF2NUwxMiAyOWwtMi41LTIuNXpcIi8+XHJcbiAgICAgICAgICAgICAgICA8cGF0aCBmaWxsPVwiY3VycmVudENvbG9yXCIgZD1cIk0yLjU3NiAzMi44MDhhMS45NSAxLjk1IDAgMCAxLS41MzEtLjk2OGw1LjI0Mi02LjE5NS43LS43MDJjLjU2NS0uNTY0IDEuNTctLjQ3MyAyLjI0OS4yMDVsLjYxMy42MTJjLjY3Ny42NzcuNzY4IDEuNjgzLjIwNCAyLjI0N2wtLjc0MS43NDEtNi4xNSA1LjIwNWExLjk1IDEuOTUgMCAwIDEtLjk3NC0uNTMyelwiLz5cclxuICAgICAgICAgICAgICAgIDxwYXRoIGZpbGw9XCJjdXJyZW50Q29sb3JcIiBkPVwiTTIuNTc2IDMyLjgwOGExLjk1IDEuOTUgMCAwIDEtLjUzMS0uOTY4bDEuMzQyLTEuNTg2LjczNyAzLjY4NGExLjkzIDEuOTMgMCAwIDEtLjkzNS0uNTE4em0zLjMxLTUuNTA2Ljg4OCA0LjQ0LTEuMjYgMS4wNjctLjgyLTQuMXptMS40LTEuNjU3LjcwMi0uNzAyYTEuMiAxLjIgMCAwIDEgLjMyNi0uMjI0bC45NzggNC44OTItMS4yNiAxLjA2Ni0uOTU3LTQuNzgzem0yLjQwMi0uODg4Yy4xOTUuMDk1LjM4Mi4yMjUuNTQ4LjM5MmwuNjEzLjYxMmMuMjU0LjI1NC40MjUuNTU0LjUxLjg2LjE0My41MS4wNDcgMS4wMzUtLjMwNiAxLjM4N2wtLjU5Ni41OTZ6bTAgMHEwLS4wMDMgMCAwXCIvPlxyXG4gICAgICAgICAgICAgICAgPHBhdGggZmlsbD1cImN1cnJlbnRDb2xvclwiIGQ9XCJNMi43NSAzNmEyLjc1IDIuNzUgMCAxIDAgMC01LjUgMi43NSAyLjc1IDAgMCAwIDAgNS41TTYuMzc0IDIyLjMyNGExLjAzNCAxLjAzNCAwIDAgMCAwIDEuNDYybDYuMDkyIDYuMDkyYTEuMDMzIDEuMDMzIDAgMSAwIDEuNDYyLTEuNDYybC02LjA5Mi02LjA5MmExLjAzMyAxLjAzMyAwIDAgMC0xLjQ2MiAwXCIvPlxyXG4gICAgICAgICAgICAgICAgPHBhdGggZmlsbD1cImN1cnJlbnRDb2xvclwiIGQ9XCJNMTMuOTI4IDMxLjYyN2ExLjc1IDEuNzUgMCAxIDAgMC0zLjUgMS43NSAxLjc1IDAgMCAwIDAgMy41TTYuMzc0IDI0LjA3M2ExLjc1IDEuNzUgMCAxIDAgMC0zLjUgMS43NSAxLjc1IDAgMCAwIDAgMy41XCIvPlxyXG4gICAgICAgICAgICAgICAgPHBhdGggZmlsbD1cImN1cnJlbnRDb2xvclwiIGQ9XCJNMTMuOTI4IDMwLjg3N2ExIDEgMCAxIDAgMC0yIDEgMSAwIDAgMCAwIDJNNi4zNzQgMjMuMzIzYTEgMSAwIDEgMCAwLTIgMSAxIDAgMCAwIDAgMk0yLjA5NyAyOS4zNDJhLjc2Ljc2IDAgMCAwIDAgMS4wNzhsMy40NzYgMy40NzVhLjc2My43NjMgMCAwIDAgMS4wNzgtMS4wNzhsLTMuNDc2LTMuNDc1YS43Ni43NiAwIDAgMC0xLjA3OCAwXCIvPlxyXG4gICAgICAgICAgICA8L3N2Zz5cclxuICAgICAgICAgICAgPHNwYW4+QmF0dGxlPC9zcGFuPlxyXG4gICAgICAgIDwvYT5cclxuICAgIGA7XHJcblxyXG4gIGNvbnN0IGxpbmsgPSBuYXZJdGVtLnF1ZXJ5U2VsZWN0b3IoXCJhXCIpO1xyXG4gIGlmIChsaW5rKSB7XHJcbiAgICBsaW5rLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoZSkgPT4ge1xyXG4gICAgICBlLnByZXZlbnREZWZhdWx0KCk7XHJcbiAgICAgIHZvaWQgb3Blbk1vZGFsKCk7XHJcbiAgICB9KTtcclxuICB9XHJcblxyXG4gIGNvbnN0IG5hdlRhcmdldCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoXCIubmF2YmFyLW5hdlwiKTtcclxuICBpZiAobmF2VGFyZ2V0KSB7XHJcbiAgICBuYXZUYXJnZXQuYXBwZW5kQ2hpbGQobmF2SXRlbSk7XHJcbiAgfVxyXG59XHJcbiIsICIvLyBTdGFzaCBCYXR0bGUgLSBlbnRyeSBwb2ludC5cclxuLy8gQnVuZGxlZCBieSBlc2J1aWxkIGludG8gcGx1Z2lucy9zdGFzaC1iYXR0bGUvc3Rhc2gtYmF0dGxlLmpzIChJSUZFKS5cclxuXHJcbmltcG9ydCB7IHJlZ2lzdGVyRGVsZXRlRGlhbG9nQnJpZGdlIH0gZnJvbSBcIi4vdWkvZGVsZXRlRGlhbG9nXCI7XHJcbmltcG9ydCB7IGluamVjdE5hdkJ1dHRvbiB9IGZyb20gXCIuL3VpL25hdkJ1dHRvblwiO1xyXG5cclxuZnVuY3Rpb24gaW5pdCgpOiB2b2lkIHtcclxuICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0gSW5pdGlhbGl6ZWRcIik7XHJcblxyXG4gIHJlZ2lzdGVyRGVsZXRlRGlhbG9nQnJpZGdlKCk7XHJcblxyXG4gIGluamVjdE5hdkJ1dHRvbigpO1xyXG5cclxuICAvLyBSZS1pbmplY3QgbmF2IGJ1dHRvbiBhZnRlciBTdGFzaCBTUEEgbmF2aWdhdGlvbiByZWJ1aWxkcyB0aGUgbmF2YmFyXHJcbiAgICBjb25zdCBvYnNlcnZlciA9IG5ldyBNdXRhdGlvbk9ic2VydmVyKCgpID0+IHtcclxuICAgIGluamVjdE5hdkJ1dHRvbigpO1xyXG4gICAgfSk7XHJcblxyXG4gICAgb2JzZXJ2ZXIub2JzZXJ2ZShkb2N1bWVudC5ib2R5LCB7XHJcbiAgICAgIGNoaWxkTGlzdDogdHJ1ZSxcclxuICAgICAgc3VidHJlZTogdHJ1ZSxcclxuICAgIH0pO1xyXG4gIH1cclxuXHJcbiAgaWYgKGRvY3VtZW50LnJlYWR5U3RhdGUgPT09IFwibG9hZGluZ1wiKSB7XHJcbiAgICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwiRE9NQ29udGVudExvYWRlZFwiLCBpbml0KTtcclxuICB9IGVsc2Uge1xyXG4gICAgaW5pdCgpO1xyXG4gIH1cclxuIl0sCiAgIm1hcHBpbmdzIjogIjs7O0FBSUEsaUJBQXNCLGFBQ3BCLE9BQ0EsWUFBcUMsQ0FBQyxHQUMxQjtBQUNaLFVBQU0sV0FBVyxNQUFNLE1BQU0sWUFBWTtBQUFBLE1BQ3ZDLFFBQVE7QUFBQSxNQUNSLFNBQVM7QUFBQSxRQUNQLGdCQUFnQjtBQUFBLE1BQ2xCO0FBQUEsTUFDQSxNQUFNLEtBQUssVUFBVSxFQUFFLE9BQU8sVUFBVSxDQUFDO0FBQUEsSUFDM0MsQ0FBQztBQUNELFVBQU0sU0FBUyxNQUFNLFNBQVMsS0FBSztBQUNuQyxRQUFJLE9BQU8sUUFBUTtBQUNqQixjQUFRLE1BQU0saUNBQWlDLE9BQU8sTUFBTTtBQUM1RCxZQUFNLElBQUksTUFBTSxPQUFPLE9BQU8sQ0FBQyxFQUFFLE9BQU87QUFBQSxJQUMxQztBQUNBLFdBQU8sT0FBTztBQUFBLEVBQ2hCO0FB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
