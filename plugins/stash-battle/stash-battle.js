"use strict";
(() => {
  // src/constants.ts
  var STORAGE_KEY = "stash-battle-state";
  var CACHE_DB_NAME = "stash-battle-cache";
  var CACHE_DB_VERSION = 1;
  var CACHE_STORE_NAME = "scenes";
  var CACHE_MAX_AGE_MS = 5 * 60 * 1e3;
  var DEFAULT_FILTER_OPPONENTS = false;
  var FILTER_OPPONENTS_KEY = "sb_filterOpponents";
  var MUTE_PREVIEWS_KEY = "sb_mutePreviews";
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

  // src/state.ts
  function readBooleanPref(key, fallback) {
    try {
      const stored = localStorage.getItem(key);
      if (stored !== null) return stored === "1";
    } catch {
    }
    return fallback;
  }
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
    totalScenesCount: 0,
    disableChoice: false,
    savedFilterParams: "",
    filterOpponents: readBooleanPref(FILTER_OPPONENTS_KEY, DEFAULT_FILTER_OPPONENTS),
    mutePreviews: readBooleanPref(MUTE_PREVIEWS_KEY, false),
    shuffledFilteredScenes: [],
    shuffleIndex: 0,
    shuffleFilterKey: null,
    removedSceneIds: /* @__PURE__ */ new Set(),
    memoryCache: {
      allScenes: null,
      filteredScenes: null,
      filterKey: null,
      timestamp: null
    }
  };
  function resetGauntletState() {
    state.gauntletClimber = null;
    state.gauntletWins = 0;
    state.gauntletClimberRank = 0;
    state.gauntletDefeated = [];
    state.gauntletFalling = false;
    state.gauntletFallingScene = null;
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
  async function setCachedScenes(cacheKey, scenes, count, filterKey) {
    try {
      const db = await openCacheDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(CACHE_STORE_NAME, "readwrite");
        const store = transaction.objectStore(CACHE_STORE_NAME);
        const data = {
          cacheKey,
          scenes,
          count,
          timestamp: Date.now(),
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
      const scene = state.memoryCache.filteredScenes.find((s) => s.id === sceneId);
      if (scene) {
        scene.rating100 = newRating;
      }
    }
  }
  function removeFromFilteredPool(sceneId) {
    state.removedSceneIds.add(sceneId);
    if (state.memoryCache.filteredScenes) {
      const idx = state.memoryCache.filteredScenes.findIndex((s) => s.id === sceneId);
      if (idx !== -1) {
        state.memoryCache.filteredScenes.splice(idx, 1);
        console.log(
          `[Stash Battle] 🗑️ Removed scene ${sceneId} from filtered pool (${state.memoryCache.filteredScenes.length} remaining, ${state.removedSceneIds.size} removed this session)`
        );
      }
    }
    const shuffleIdx = state.shuffledFilteredScenes.findIndex((s) => s.id === sceneId);
    if (shuffleIdx !== -1) {
      state.shuffledFilteredScenes.splice(shuffleIdx, 1);
      if (shuffleIdx < state.shuffleIndex) {
        state.shuffleIndex--;
      }
    }
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

  // src/rating.ts
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
    }
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
  function getNextFilteredScene(leftPool, filterKey) {
    if (state.shuffleFilterKey !== null && filterKey !== state.shuffleFilterKey) {
      console.log("[Stash Battle] 🔀 Filter changed, resetting removed scenes tracking");
      state.removedSceneIds.clear();
    }
    const availableScenes = leftPool.filter((s) => !state.removedSceneIds.has(s.id));
    if (availableScenes.length === 0) {
      console.log("[Stash Battle] 🏁 Filtered pool exhausted - all scenes rated!");
      return null;
    }
    if (filterKey !== state.shuffleFilterKey || state.shuffledFilteredScenes.length === 0) {
      console.log("[Stash Battle] 🔀 Shuffling filtered scenes (filter changed or first load)");
      state.shuffledFilteredScenes = shuffleArray(availableScenes);
      state.shuffleIndex = 0;
      state.shuffleFilterKey = filterKey;
      lastShownSceneId = null;
    }
    if (state.shuffleIndex >= state.shuffledFilteredScenes.length) {
      console.log("[Stash Battle] 🔀 Reshuffling (completed full cycle)");
      state.shuffledFilteredScenes = shuffleArray(availableScenes);
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
    const scene = state.shuffledFilteredScenes[state.shuffleIndex];
    state.shuffleIndex++;
    lastShownSceneId = scene.id;
    console.log(
      `[Stash Battle] 📍 Picked scene ${scene.id} (${state.shuffledFilteredScenes.length - state.shuffleIndex} remaining in pool, ${state.removedSceneIds.size} removed this session)`
    );
    return scene;
  }
  function buildOpponentPool(allScenes, leftPool, filters) {
    if (state.filterOpponents && filters.filterActive) {
      return leftPool;
    }
    const ratedOnly = allScenes.filter((s) => s.rating100 != null);
    return ratedOnly.length >= 1 ? ratedOnly : allScenes;
  }
  async function resetLeftPool() {
    await clearFilteredCache();
    state.shuffledFilteredScenes = [];
    state.shuffleIndex = 0;
    state.shuffleFilterKey = null;
    state.removedSceneIds.clear();
  }
  async function loadScenePools(filters) {
    if (filters.filterActive) {
      console.log("[Stash Battle] 📋 Filter active, fetching filtered + all scenes");
      const [filteredResult, allResult2] = await Promise.all([
        getFilteredScenesCached(filters),
        getAllScenesCached()
      ]);
      return {
        leftPool: filteredResult.scenes || [],
        allScenes: allResult2.scenes || []
      };
    }
    console.log("[Stash Battle] 📋 No filter active, using all scenes");
    const allResult = await getAllScenesCached();
    const allScenes = allResult.scenes || [];
    return { leftPool: allScenes, allScenes };
  }
  function pickLeftScene(forcedLeftScene, leftPool, filterKey) {
    return forcedLeftScene || getNextFilteredScene(leftPool, filterKey);
  }
  function hasLeftAvailable(leftPool, forcedLeftScene) {
    return forcedLeftScene !== null || leftPool.some((s) => !state.removedSceneIds.has(s.id));
  }
  async function buildSwissPools(forcedLeftScene) {
    let filters = readFilters();
    let { leftPool, allScenes } = await loadScenePools(filters);
    if (allScenes.length < 2) {
      throw new Error("Not enough scenes for comparison.");
    }
    let rightPool = buildOpponentPool(allScenes, leftPool, filters);
    const needsLeftRefresh = !hasLeftAvailable(leftPool, forcedLeftScene);
    const needsOpponentRestart = state.filterOpponents && filters.filterActive && rightPool.length < 2;
    if (!needsLeftRefresh && !needsOpponentRestart) {
      return { leftPool, rightPool, filterKey: filters.filterKey };
    }
    if (needsLeftRefresh) {
      console.log("[Stash Battle] 🏁 Pool exhausted, fetching fresh from network...");
    } else {
      console.log("[Stash Battle] 🔄 Filtered opponent pool too small, restarting cycle...");
    }
    await resetLeftPool();
    leftPool = filters.filterActive ? (await getFilteredScenesCached(filters)).scenes || [] : allScenes;
    filters = readFilters();
    rightPool = buildOpponentPool(allScenes, leftPool, filters);
    if (needsOpponentRestart && rightPool.length < 2) {
      throw new Error("Not enough scenes in your filter for a match. You need at least 2 scenes.");
    }
    return {
      leftPool,
      rightPool,
      filterKey: filters.filterKey
    };
  }
  async function fetchSwissPair(forcedLeftScene = null) {
    const { leftPool, rightPool, filterKey } = await buildSwissPools(forcedLeftScene);
    const scene1 = pickLeftScene(forcedLeftScene, leftPool, filterKey);
    if (!scene1) {
      throw new Error("No scenes match your filter criteria.");
    }
    const { scene2, ranks } = pickSwissOpponent(scene1, rightPool);
    return { scenes: [scene1, scene2], ranks };
  }
  function pickSwissOpponent(scene1, rightPool) {
    const scene1IdxInPool = rightPool.findIndex((s) => s.id === scene1.id);
    const effectiveScene1Idx = scene1IdxInPool >= 0 ? scene1IdxInPool : rightPool.length;
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
      ranks: [climberIndex + 1, nextOpponentIndex + 1],
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
    const stashRating = scene.rating100 ? `${scene.rating100}/100` : "Unrated";
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
    return `
      <div class="sb-scene-card" data-side="${side}">
        <div class="sb-scene-image-container" data-scene-url="${sceneUrl}">
          ${screenshotPath ? `<img class="sb-scene-image" src="${screenshotPath}" alt="${title}" loading="lazy" />` : `<div class="sb-scene-image sb-no-image">No Screenshot</div>`}
          ${previewPath ? `<video class="sb-hover-preview" src="${previewPath}" loop playsinline></video>` : ""}
          <div class="sb-scene-duration">${formatDuration(duration)}</div>
          ${statusBadgeHtml}
          <div class="sb-click-hint">Click to open scene</div>
        </div>

        <div class="sb-scene-body" data-winner="${scene.id}">
          <div class="sb-scene-info">
            <div class="sb-scene-title-row">
              <h3 class="sb-scene-title">${title}</h3>
              ${rankDisplay}
            </div>

            <div class="sb-scene-meta">
              <div class="sb-meta-item"><strong>Studio:</strong> ${studio}</div>
              <div class="sb-meta-item"><strong>Performers:</strong> ${performers}</div>
              <div class="sb-meta-item"><strong>Play Count:</strong> ${scene.play_count || 0}</div>
              <div class="sb-meta-item"><strong>Rating:</strong> ${stashRating}</div>
              <div class="sb-meta-item sb-tags-row"><strong>Tags:</strong> ${tags.length > 0 ? tags.map((tag) => `<span class="sb-tag">${tag}</span>`).join("") : '<span class="sb-none">None</span>'}</div>
            </div>
          </div>

          <div class="sb-choose-btn">
            ✓ Choose This Scene
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
        <div class="sb-end-screen-scene">
          ${screenshotPath ? `<img class="sb-end-screen-image" src="${screenshotPath}" alt="${title}" />` : `<div class="sb-end-screen-image sb-no-image">No Screenshot</div>`}
        </div>
        <h3 class="sb-end-screen-name">${title}</h3>
        <p class="sb-end-screen-stats">${statsHtml}</p>
        <button id="sb-new-gauntlet" class="btn btn-primary">${buttonLabel}</button>
      </div>
    `;
  }
  function showEndScreen(html) {
    const comparisonArea = document.getElementById("sb-comparison-area");
    if (!comparisonArea) return;
    comparisonArea.innerHTML = html;
    const actionsEl = document.querySelector(".sb-actions");
    if (actionsEl) actionsEl.style.display = "none";
    comparisonArea.querySelector("#sb-new-gauntlet")?.addEventListener("click", () => {
      if (actionsEl) actionsEl.style.display = "";
      loadNewPair();
    });
  }
  function finishRunShowEndScreen(html) {
    resetGauntletState();
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
    const html = buildEndScreenHtml(
      scene,
      "📍",
      "PLACED!",
      `Rank <strong>#${rank}</strong> of ${state.totalScenesCount}<br>Rating: <strong>${finalRating}/100</strong>`,
      "Start New Run"
    );
    finishRunShowEndScreen(html);
  }

  // src/ui/mainUI.ts
  function createMainUI() {
    return `
      <div id="stash-battle-container" class="sb-container">
        <div class="sb-header">
          <h1 class="sb-title">⚔️ Stash Battle</h1>
          <p class="sb-subtitle">Compare scenes head-to-head to build your rankings</p>

          <div class="sb-mode-toggle">
            <button class="sb-mode-btn ${state.currentMode === "swiss" ? "active" : ""}" data-mode="swiss">
              <span class="sb-mode-icon">⚖️</span>
              <span class="sb-mode-title">Swiss</span>
              <span class="sb-mode-desc">Fair matchups</span>
            </button>
            <button class="sb-mode-btn ${state.currentMode === "gauntlet" ? "active" : ""}" data-mode="gauntlet">
              <span class="sb-mode-icon">🎯</span>
              <span class="sb-mode-title">Gauntlet</span>
              <span class="sb-mode-desc">Place a scene</span>
            </button>
            <button class="sb-mode-btn ${state.currentMode === "champion" ? "active" : ""}" data-mode="champion">
              <span class="sb-mode-icon">🏆</span>
              <span class="sb-mode-title">Champion</span>
              <span class="sb-mode-desc">Winner stays on</span>
            </button>
          </div>

          <div class="sb-opponents-toggle" style="margin-top:8px;">
            <label>
              <input type="checkbox" id="sb-filter-opponents-checkbox" ${state.filterOpponents ? "checked" : ""}>
               Use filtered scenes for both sides
            </label>
            <label style="margin-left:16px;">
              <input type="checkbox" id="sb-mute-previews-checkbox" ${state.mutePreviews ? "checked" : ""}>
               Mute hover previews
            </label>
          </div>
          <p id="sb-climb-pool-warning" class="sb-climb-warning" hidden>
            Gauntlet and Champion can behave oddly with small filtered pools when both sides use the filter
            (fewer than ${CLIMB_SMALL_POOL_WARN_AT} scenes). Prefer a larger filter or turn off filter opponents.
          </p>
        </div>

        <div class="sb-content">
          <div id="sb-comparison-area" class="sb-comparison-area">
            <div class="sb-loading">Loading scenes...</div>
          </div>
          <div class="sb-actions">
            <div class="sb-action-buttons">
              <button id="sb-skip-btn" class="btn btn-secondary">Skip (Get New Pair)</button>
              <button id="sb-refresh-cache-btn" class="btn btn-secondary" title="Refresh scene list from server (use if you've added new scenes)">🔄 Refresh Cache</button>
            </div>
            <div class="sb-keyboard-hint">
              <span>← Left Arrow</span> to choose left ·
              <span>→ Right Arrow</span> to choose right ·
              <span>Space</span> to skip
            </div>
          </div>
        </div>
      </div>
    `;
  }
  function climbStatusBadge(scene) {
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
    }
    comparisonArea.querySelectorAll(".sb-scene-image-container").forEach((container) => {
      const sceneUrl = container.dataset.sceneUrl;
      container.addEventListener("click", () => {
        if (sceneUrl) {
          navigateToUrl(sceneUrl);
        }
      });
    });
    comparisonArea.querySelectorAll(".sb-scene-card").forEach((card) => {
      const video = card.querySelector(".sb-hover-preview");
      if (!video) return;
      card.addEventListener("mouseenter", () => {
        video.currentTime = 0;
        video.muted = state.mutePreviews;
        video.volume = 0.5;
        video.play().catch(() => {
        });
      });
      card.addEventListener("mouseleave", () => {
        video.pause();
        video.currentTime = 0;
      });
    });
    const skipBtn = document.querySelector("#sb-skip-btn");
    if (skipBtn) {
      const disableSkip = (state.currentMode === "gauntlet" || state.currentMode === "champion") && state.gauntletClimber !== null;
      skipBtn.disabled = disableSkip;
      skipBtn.style.opacity = disableSkip ? "0.5" : "1";
      skipBtn.style.cursor = disableSkip ? "not-allowed" : "pointer";
    }
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
        if (!forcedLeftScene) {
          console.warn("[Stash Battle] Could not fetch scene from URL, falling back to normal pairing");
        }
      }
      let scenes = [];
      let ranks = [null, null];
      if (state.currentMode === "gauntlet") {
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
      const retryBtn = document.getElementById("sb-error-retry");
      if (retryBtn) {
        retryBtn.addEventListener("click", async () => {
          retryBtn.disabled = true;
          retryBtn.textContent = "Loading...";
          if (isNoScenes) {
            await clearFilteredCache();
            state.shuffledFilteredScenes = [];
            state.shuffleIndex = 0;
            state.shuffleFilterKey = null;
            state.removedSceneIds.clear();
          }
          await loadNewPair();
        });
      }
    }
  }
  function restoreCurrentPair() {
    state.disableChoice = false;
    console.log("[Stash Battle] 📂 Rendering saved pair (no network fetch needed)");
    if (!state.memoryCache.allScenes) {
      console.log("[Stash Battle] 🔥 Pre-warming cache in background...");
      getAllScenesCached();
    }
    renderPair(
      [state.currentPair.left, state.currentPair.right],
      [state.currentRanks.left, state.currentRanks.right]
    );
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
    const winnerRating = winner.rating100 || 1;
    const loserRating = loser.rating100 || 1;
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
    warning.hidden = !(isClimb && state.filterOpponents && filters.filterActive && smallPool);
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
      left,
      right,
      winnerCard,
      loserCard,
      loserRank
    } = choice;
    const winnerId = winnerScene.id;
    const loserId = loserScene.id;
    const winnerRating = winnerScene.rating100 || 1;
    const loserRating = loserScene.rating100 || 1;
    const loserDisplayRating = loserScene.rating100 || 0;
    if (state.currentMode === "gauntlet") {
      if (state.gauntletFalling && state.gauntletFallingScene) {
        const fallingScene = state.gauntletFallingScene;
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
    const { winner: winnerDelta, loser: loserDelta } = resolveComparison(winnerScene, loserScene);
    const newWinnerRating = winnerRating + winnerDelta;
    const newLoserRating = loserDisplayRating + loserDelta;
    removeFromFilteredPool(left.id);
    removeFromFilteredPool(right.id);
    saveState();
    winnerCard.classList.add("sb-winner");
    if (loserCard) loserCard.classList.add("sb-loser");
    showRatingAnimation(winnerCard, winnerRating, newWinnerRating, true);
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
  var RATING_ANIM_MAX_TOTAL_MS = 1400;
  var RATING_ANIM_HOLD_MS = 300;
  var RATING_ANIM_COUNT_BUDGET_MS = RATING_ANIM_MAX_TOTAL_MS - RATING_ANIM_HOLD_MS;
  var RATING_ANIM_DEFAULT_STEP_MS = 50;
  var RATING_ANIM_MIN_STEP_MS = 8;
  function scheduleNextPairAfterAnimations() {
    setTimeout(() => loadNewPair(), 1500);
  }
  function showRatingAnimation(card, oldRating, newRating, isWinner) {
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
  function openModal() {
    console.log("[Stash Battle] 🎯 Opening modal...");
    document.querySelectorAll("video, audio").forEach((v) => v.pause());
    const hasState = loadState();
    console.log(`[Stash Battle] 📋 LocalStorage state: ${hasState ? "found" : "none"}`);
    const currentFilterParams = window.location.search;
    const filtersChanged = hasState && state.savedFilterParams !== currentFilterParams;
    if (filtersChanged) {
      console.log("[Stash Battle] Filter params changed, resetting gauntlet state and filtered cache");
      state.currentPair = { left: null, right: null };
      state.currentRanks = { left: null, right: null };
      resetGauntletState();
      state.savedFilterParams = currentFilterParams;
      state.memoryCache.filteredScenes = null;
      state.memoryCache.filterKey = null;
      state.shuffledFilteredScenes = [];
      state.shuffleIndex = 0;
      state.shuffleFilterKey = null;
    }
    const scenePageId = getSceneIdFromUrl();
    const sceneAlreadyInPair = scenePageId && state.currentPair.left && state.currentPair.right && (String(state.currentPair.left.id) === scenePageId || String(state.currentPair.right.id) === scenePageId);
    const forceSceneBattle = scenePageId && !sceneAlreadyInPair;
    if (forceSceneBattle) {
      console.log(`[Stash Battle] 🎯 Opened from scene page ${scenePageId}, starting new battle with this scene`);
      resetGauntletState();
      state.currentPair = { left: null, right: null };
      state.currentRanks = { left: null, right: null };
    }
    const existingModal = document.getElementById("sb-modal");
    if (existingModal && existingModal.classList.contains("sb-modal-hidden")) {
      console.log("[Stash Battle] ♻️ Reusing existing modal");
      existingModal.classList.remove("sb-modal-hidden", "sb-modal-closing");
      if (modalKeyHandler) {
        document.removeEventListener("keydown", modalKeyHandler, true);
      }
      if (modalKeyHandler) document.addEventListener("keydown", modalKeyHandler, true);
      const modalContent2 = existingModal.querySelector(".sb-modal-content");
      if (modalContent2) modalContent2.focus();
      if (forceSceneBattle) {
        loadNewPair(scenePageId);
      } else if (filtersChanged || !state.currentPair.left || !state.currentPair.right) {
        loadNewPair();
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
        <button class="sb-modal-close">✕</button>
        ${createMainUI()}
      </div>
    `;
    document.body.appendChild(modal);
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
          resetGauntletState();
          state.shuffleIndex = 0;
          modal.querySelectorAll(".sb-mode-btn").forEach((b) => {
            b.classList.toggle("active", b.dataset.mode === state.currentMode);
          });
          const actionsEl = document.querySelector(".sb-actions");
          if (actionsEl) actionsEl.style.display = "";
          loadNewPair(getSceneIdFromUrl());
          updateClimbPoolWarning();
          saveState();
        }
      });
    });
    const oppCheckbox = modal.querySelector("#sb-filter-opponents-checkbox");
    if (oppCheckbox) {
      oppCheckbox.addEventListener("change", (e) => {
        state.filterOpponents = e.target.checked;
        try {
          localStorage.setItem(FILTER_OPPONENTS_KEY, state.filterOpponents ? "1" : "0");
        } catch {
        }
        if (state.currentMode === "gauntlet" || state.currentMode === "champion") {
          resetGauntletState();
        }
        saveState();
        loadNewPair();
        updateClimbPoolWarning();
      });
    }
    const muteCheckbox = modal.querySelector("#sb-mute-previews-checkbox");
    if (muteCheckbox) {
      muteCheckbox.addEventListener("change", (e) => {
        state.mutePreviews = e.target.checked;
        try {
          localStorage.setItem(MUTE_PREVIEWS_KEY, state.mutePreviews ? "1" : "0");
        } catch {
        }
        document.querySelectorAll(".sb-hover-preview").forEach((v) => {
          v.muted = state.mutePreviews;
        });
      });
    }
    const skipBtn = modal.querySelector("#sb-skip-btn");
    if (skipBtn) {
      skipBtn.addEventListener("click", () => {
        if ((state.currentMode === "gauntlet" || state.currentMode === "champion") && state.gauntletClimber) {
          return;
        }
        if (state.disableChoice) return;
        state.disableChoice = true;
        if (state.currentMode === "gauntlet" || state.currentMode === "champion") {
          resetGauntletState();
          saveState();
        }
        loadNewPair();
      });
    }
    const refreshCacheBtn = modal.querySelector("#sb-refresh-cache-btn");
    if (refreshCacheBtn) {
      refreshCacheBtn.addEventListener("click", async () => {
        if (state.disableChoice) return;
        refreshCacheBtn.disabled = true;
        refreshCacheBtn.textContent = "🔄 Refreshing...";
        try {
          await clearSceneCache();
          state.shuffledFilteredScenes = [];
          state.shuffleIndex = 0;
          state.shuffleFilterKey = null;
          state.removedSceneIds.clear();
          resetGauntletState();
          saveState();
          const actionsEl = document.querySelector(".sb-actions");
          if (actionsEl) actionsEl.style.display = "";
          await loadNewPair();
        } catch (e) {
          console.error("[Stash Battle] Refresh failed:", e);
        } finally {
          refreshCacheBtn.disabled = false;
          refreshCacheBtn.textContent = "🔄 Refresh Cache";
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
      restoreCurrentPair();
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
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeModal();
        return;
      }
      if (e.key === "ArrowLeft" && state.currentPair.left) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const leftBody = activeModal.querySelector('.sb-scene-card[data-side="left"] .sb-scene-body');
        if (leftBody) leftBody.click();
      }
      if (e.key === "ArrowRight" && state.currentPair.right) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const rightBody = activeModal.querySelector('.sb-scene-card[data-side="right"] .sb-scene-body');
        if (rightBody) rightBody.click();
      }
      if (e.key === " " || e.code === "Space") {
        const tag = document.activeElement?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON") {
          return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        if ((state.currentMode === "gauntlet" || state.currentMode === "champion") && state.gauntletClimber) {
          return;
        }
        if (state.disableChoice) return;
        state.disableChoice = true;
        if (state.currentMode === "gauntlet" || state.currentMode === "champion") {
          resetGauntletState();
          saveState();
        }
        loadNewPair();
      }
    };
    document.addEventListener("keydown", modalKeyHandler, true);
  }
  function closeModal() {
    const modal = document.getElementById("sb-modal");
    if (!modal || modal.classList.contains("sb-modal-hidden")) return;
    modal.classList.add("sb-modal-closing");
    setTimeout(() => {
      modal.classList.add("sb-modal-hidden");
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
        openModal();
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
