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
    const html = buildEndScreenHtml(
      champion,
      "👑",
      "CHAMPION!",
      `Conquered all ${totalScenes} scenes with a ${winStreak} win streak!`,
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
    const raw = calculateRatingChanges({
      winner: { rating: winnerRating, playCount: winner.play_count ?? 0 },
      loser: { rating: loserRating, playCount: loser.play_count ?? 0 }
    });
    const deltas = applyModePolicy(winner, loser, mode, raw);
    if (deltas.winner !== 0) updateSceneRating(winner.id, winnerRating + deltas.winner);
    if (deltas.loser !== 0) updateSceneRating(loser.id, loserRating + deltas.loser);
    return deltas;
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
    const loserDisplayRating = loserScene.rating100 || 0;
    const { winner: winnerDelta, loser: loserDelta } = resolveComparison(winnerScene, loserScene);
    const newWinnerRating = winnerRating + winnerDelta;
    const newLoserRating = loserDisplayRating + loserDelta;
    if (winnerId === climber.id) {
      state.gauntletDefeated.push(loserId);
      state.gauntletWins++;
      climber.rating100 = newWinnerRating;
      console.log(
        `[Stash Battle] 📊 Gauntlet: climber ${winnerId} won (streak=${state.gauntletWins}), rating → ${newWinnerRating}`
      );
    } else if (isFirstBattle) {
      const finalRank = state.totalScenesCount;
      const finalRating = Math.max(1, (winnerScene.rating100 || 1) - 1);
      console.log(
        `[Stash Battle] 📊 Gauntlet: first battle, challenger ${loserId} lost to floor → rank #${finalRank}, rating ${finalRating}`
      );
      updateSceneRating(loserScene.id, finalRating);
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
    showRatingAnimation(winnerCard, winnerRating, newWinnerRating, true);
    if (loserCard) {
      const loserDisplayNew = loserDelta !== 0 ? newLoserRating : loserDisplayRating;
      showRatingAnimation(loserCard, loserDisplayRating, loserDisplayNew, false);
    }
    setTimeout(() => {
      loadNewPair();
    }, 1500);
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
          console.log(
            `[Stash Battle] 📊 Falling scene found floor: loserRating=${loserRating} → finalRating=${finalRating}`
          );
          updateSceneRating(fallingScene.id, finalRating);
          const finalRank = Math.max(1, (loserRank ?? 1) - 1);
          winnerCard.classList.add("sb-winner");
          if (loserCard) loserCard.classList.add("sb-loser");
          setTimeout(() => {
            showPlacementScreen(fallingScene, finalRank, finalRating);
          }, 800);
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
      const isFirstBattle = !state.gauntletClimber;
      if (isFirstBattle) {
        state.gauntletClimber = left;
      }
      const climber = state.gauntletClimber;
      const { winner: winnerDelta2, loser: loserDelta2 } = resolveComparison(winnerScene, loserScene);
      const newWinnerRating2 = winnerRating + winnerDelta2;
      const newLoserRating2 = loserDisplayRating + loserDelta2;
      if (winnerId === climber.id) {
        state.gauntletDefeated.push(loserId);
        state.gauntletWins++;
        climber.rating100 = newWinnerRating2;
      } else {
        state.gauntletClimber = winnerScene;
        winnerScene.rating100 = newWinnerRating2;
        state.gauntletDefeated = [loserId];
        state.gauntletWins = 1;
      }
      saveState();
      winnerCard.classList.add("sb-winner");
      if (loserCard) loserCard.classList.add("sb-loser");
      showRatingAnimation(winnerCard, winnerRating, newWinnerRating2, true);
      if (loserCard) {
        const loserDisplayNew = loserDelta2 !== 0 ? newLoserRating2 : loserDisplayRating;
        showRatingAnimation(loserCard, loserDisplayRating, loserDisplayNew, false);
      }
      setTimeout(() => {
        loadNewPair();
      }, 1500);
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
      const loserDisplayNew = loserDelta !== 0 ? newLoserRating : loserDisplayRating;
      showRatingAnimation(loserCard, loserDisplayRating, loserDisplayNew, false);
    }
    setTimeout(() => {
      loadNewPair();
    }, 1500);
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
    changeDisplay.textContent = isWinner ? `+${change}` : `${change}`;
    overlay.appendChild(ratingDisplay);
    overlay.appendChild(changeDisplay);
    card.appendChild(overlay);
    let currentDisplay = oldRating;
    const step = isWinner ? 1 : -1;
    const totalSteps = Math.abs(change);
    let stepCount = 0;
    const interval = setInterval(() => {
      stepCount++;
      currentDisplay += step;
      ratingDisplay.textContent = String(currentDisplay);
      if (stepCount >= totalSteps) {
        clearInterval(interval);
        ratingDisplay.textContent = String(newRating);
      }
    }, 50);
    setTimeout(() => {
      overlay.remove();
    }, 1400);
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vc3JjL2NvbnN0YW50cy50cyIsICIuLi8uLi9zcmMvZmlsdGVycy50cyIsICIuLi8uLi9zcmMvZ3JhcGhxbC50cyIsICIuLi8uLi9zcmMvc3RhdGUudHMiLCAiLi4vLi4vc3JjL2NhY2hlLnRzIiwgIi4uLy4uL3NyYy9zdG9yYWdlLnRzIiwgIi4uLy4uL3NyYy9lbG8udHMiLCAiLi4vLi4vc3JjL25hdmlnYXRpb24udHMiLCAiLi4vLi4vc3JjL3JhdGluZy50cyIsICIuLi8uLi9zcmMvcGFpcnMudHMiLCAiLi4vLi4vc3JjL3VpL3NjZW5lVGl0bGUudHMiLCAiLi4vLi4vc3JjL3VpL3NjZW5lQ2FyZC50cyIsICIuLi8uLi9zcmMvdWkvc2NyZWVucy50cyIsICIuLi8uLi9zcmMvdWkvbWFpblVJLnRzIiwgIi4uLy4uL3NyYy91aS9tb2RhbC50cyIsICIuLi8uLi9zcmMvdWkvbmF2QnV0dG9uLnRzIiwgIi4uLy4uL3NyYy9tYWluLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBQbHVnaW4td2lkZSBjb25zdGFudHMuXG5cbmV4cG9ydCBjb25zdCBTVE9SQUdFX0tFWSA9IFwic3Rhc2gtYmF0dGxlLXN0YXRlXCI7XG5leHBvcnQgY29uc3QgQ0FDSEVfREJfTkFNRSA9IFwic3Rhc2gtYmF0dGxlLWNhY2hlXCI7XG5leHBvcnQgY29uc3QgQ0FDSEVfREJfVkVSU0lPTiA9IDE7XG5leHBvcnQgY29uc3QgQ0FDSEVfU1RPUkVfTkFNRSA9IFwic2NlbmVzXCI7XG5leHBvcnQgY29uc3QgQ0FDSEVfTUFYX0FHRV9NUyA9IDUgKiA2MCAqIDEwMDA7IC8vIDUgbWludXRlcyBjYWNoZSBleHBpcnlcblxuLy8gdG9nZ2xlOiBzaG91bGQgc2NlbmUyL29wcG9uZW50cyBvYmV5IHRoZSBzYW1lIGZpbHRlciBhcyBzY2VuZTE/XG4vLyBkZWZhdWx0IGlzIGZhbHNlIChkb24ndCBhcHBseSBmaWx0ZXIgdG8gYm90aCBzaWRlcyk7IHVzZXIgY2FuIG92ZXJyaWRlIHZpYSBVSS5cbmV4cG9ydCBjb25zdCBERUZBVUxUX0ZJTFRFUl9PUFBPTkVOVFMgPSBmYWxzZTtcblxuLy8gTG9jYWxTdG9yYWdlIGtleXMgZm9yIHVzZXIgcHJlZmVyZW5jZXMuXG5leHBvcnQgY29uc3QgRklMVEVSX09QUE9ORU5UU19LRVkgPSBcInNiX2ZpbHRlck9wcG9uZW50c1wiO1xuZXhwb3J0IGNvbnN0IE1VVEVfUFJFVklFV1NfS0VZID0gXCJzYl9tdXRlUHJldmlld3NcIjtcblxuLy8gU3dpc3MgbW9kZTogaW5pdGlhbCByYW5rIGJhbmQgKMKxTikgd2hlbiBwaWNraW5nIGEgc2ltaWxhci1zdHJlbmd0aCBvcHBvbmVudDsgZG91YmxlcyB1bnRpbCBjYW5kaWRhdGVzIGV4aXN0LlxuZXhwb3J0IGNvbnN0IFNXSVNTX09QUE9ORU5UX1JFQUNIX0lOSVRJQUwgPSAxMDtcbmV4cG9ydCBjb25zdCBTV0lTU19PUFBPTkVOVF9SRUFDSF9NVUxUSVBMSUVSID0gMjtcblxuLy8gR2F1bnRsZXQvY2hhbXBpb246IHJhbmRvbSBwaWNrIGFtb25nIHRoZSBOIGNsb3Nlc3QgdW5kZWZlYXRlZCBvcHBvbmVudHMgYWJvdmUgdGhlIGNsaW1iZXIuXG5leHBvcnQgY29uc3QgQ0xJTUJfT1BQT05FTlRfUElDS19XSU5ET1cgPSA1O1xuIiwgIi8vIFVSTCBmaWx0ZXIgcGFyc2luZyBmb3IgU3Rhc2ggbGlzdCDihpIgR3JhcGhRTCBzY2VuZSBxdWVyaWVzLlxuXG5pbXBvcnQgdHlwZSB7IEZpbmRGaWx0ZXJUeXBlLCBTY2VuZUZpbHRlclR5cGUgfSBmcm9tIFwiLi90eXBlc1wiO1xuXG4vLyBHZXQgY3VycmVudCBVUkwgc2VhcmNoIHBhcmFtc1xuZXhwb3J0IGZ1bmN0aW9uIGdldFNlYXJjaFBhcmFtcygpOiBVUkxTZWFyY2hQYXJhbXMge1xuICByZXR1cm4gbmV3IFVSTFNlYXJjaFBhcmFtcyh3aW5kb3cubG9jYXRpb24uc2VhcmNoKTtcbn1cblxuLy8gQnVpbGQgRmluZEZpbHRlclR5cGUgZnJvbSBjdXJyZW50IFVSTCBzZWFyY2ggcGFyYW1zIChvciBhbiBleHBsaWNpdCBwYXJhbXMgb2JqZWN0KS5cbmV4cG9ydCBmdW5jdGlvbiBnZXRGaW5kRmlsdGVyKFxuICBvdmVycmlkZXM6IFBhcnRpYWw8RmluZEZpbHRlclR5cGU+ID0ge30sXG4gIHNlYXJjaFBhcmFtczogVVJMU2VhcmNoUGFyYW1zID0gZ2V0U2VhcmNoUGFyYW1zKCksXG4pOiBGaW5kRmlsdGVyVHlwZSB7XG4gIGNvbnN0IGZpbHRlcjogRmluZEZpbHRlclR5cGUgPSB7XG4gICAgcGVyX3BhZ2U6IG92ZXJyaWRlcy5wZXJfcGFnZSA/PyAtMSxcbiAgICBzb3J0OiBvdmVycmlkZXMuc29ydCA/PyAoc2VhcmNoUGFyYW1zLmdldChcInNvcnRieVwiKSB8fCBcInJhdGluZ1wiKSxcbiAgICBkaXJlY3Rpb246IG92ZXJyaWRlcy5kaXJlY3Rpb24gPz8gKHNlYXJjaFBhcmFtcy5nZXQoXCJzb3J0ZGlyXCIpPy50b1VwcGVyQ2FzZSgpIHx8IFwiREVTQ1wiKSxcbiAgICAuLi5vdmVycmlkZXMsXG4gIH07XG5cbiAgLy8gSW5jbHVkZSBzZWFyY2ggcXVlcnkgaWYgcHJlc2VudFxuICBjb25zdCBxdWVyeSA9IHNlYXJjaFBhcmFtcy5nZXQoXCJxXCIpO1xuICBpZiAocXVlcnkpIHtcbiAgICBmaWx0ZXIucSA9IHF1ZXJ5O1xuICB9XG5cbiAgcmV0dXJuIGZpbHRlcjtcbn1cblxuLy8gVHJhbnNsYXRlIEpTT04gc3RyaW5nIGJldHdlZW4gVVJMIGZvcm1hdCAocGFyZW50aGVzZXMpIGFuZCBzdGFuZGFyZCBKU09OIChicmFjZXMpXG4vLyBQb3J0ZWQgZnJvbSBTdGFzaCdzIExpc3RGaWx0ZXJNb2RlbC50cmFuc2xhdGVKU09OXG4vLyBUaGlzIHNhZmVseSBoYW5kbGVzIHBhcmVudGhlc2VzIGluc2lkZSBxdW90ZWQgc3RyaW5nc1xuZXhwb3J0IGZ1bmN0aW9uIHRyYW5zbGF0ZUpTT04oanNvblN0cmluZzogc3RyaW5nLCBkZWNvZGluZzogYm9vbGVhbik6IHN0cmluZyB7XG4gIGxldCBpblN0cmluZyA9IGZhbHNlO1xuICBsZXQgZXNjYXBlID0gZmFsc2U7XG4gIHJldHVybiBbLi4uanNvblN0cmluZ11cbiAgICAubWFwKChjKSA9PiB7XG4gICAgICBpZiAoZXNjYXBlKSB7XG4gICAgICAgIGVzY2FwZSA9IGZhbHNlO1xuICAgICAgICByZXR1cm4gYztcbiAgICAgIH1cbiAgICAgIHN3aXRjaCAoYykge1xuICAgICAgICBjYXNlIFwiXFxcXFwiOlxuICAgICAgICAgIGlmIChpblN0cmluZykgZXNjYXBlID0gdHJ1ZTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSAnXCInOlxuICAgICAgICAgIGluU3RyaW5nID0gIWluU3RyaW5nO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBjYXNlIFwiKFwiOlxuICAgICAgICAgIGlmIChkZWNvZGluZyAmJiAhaW5TdHJpbmcpIHJldHVybiBcIntcIjtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSBcIilcIjpcbiAgICAgICAgICBpZiAoZGVjb2RpbmcgJiYgIWluU3RyaW5nKSByZXR1cm4gXCJ9XCI7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgICByZXR1cm4gYztcbiAgICB9KVxuICAgIC5qb2luKFwiXCIpO1xufVxuXG4vLyBDcml0ZXJpb24gY2F0ZWdvcnkgbWFwcGluZ3MgZm9yIFVSTCAtPiBHcmFwaFFMIHRyYW5zZm9ybWF0aW9uXG4vLyBFYWNoIGNhdGVnb3J5IHJlcXVpcmVzIGRpZmZlcmVudCB0cmFuc2Zvcm1hdGlvbiBsb2dpY1xuY29uc3QgQ1JJVEVSSU9OX0NBVEVHT1JJRVMgPSB7XG4gIC8vIEJvb2xlYW46IG5vIG1vZGlmaWVyLCB2YWx1ZSBpcyBcInRydWVcIi9cImZhbHNlXCIgc3RyaW5nIC0+IGNvbnZlcnQgdG8gYm9vbGVhblxuICBib29sZWFuOiBuZXcgU2V0KFtcIm9yZ2FuaXplZFwiLCBcImludGVyYWN0aXZlXCIsIFwicGVyZm9ybWVyX2Zhdm9yaXRlXCJdKSxcbiAgLy8gU3RyaW5nRW51bTogVVJMIGhhcyBtb2RpZmllciBidXQgR3JhcGhRTCBqdXN0IGV4cGVjdHMgdGhlIHN0cmluZyB2YWx1ZSBkaXJlY3RseVxuICBzdHJpbmdFbnVtOiBuZXcgU2V0KFtcImlzX21pc3NpbmdcIiwgXCJoYXNfbWFya2Vyc1wiXSksXG4gIC8vIE11bHRpOiB2YWx1ZSBpcyBhcnJheSBvZiB7aWQsIGxhYmVsfSAtPiBleHRyYWN0IElEcyBvbmx5XG4gIG11bHRpOiBuZXcgU2V0KFtcInBlcmZvcm1lcnNcIiwgXCJncm91cHNcIiwgXCJtb3ZpZXNcIiwgXCJnYWxsZXJpZXNcIl0pLFxuICAvLyBIaWVyYXJjaGljYWxNdWx0aTogdmFsdWUgaGFzIHtpdGVtcywgZXhjbHVkZWQsIGRlcHRofSAtPiByZW5hbWUgdG8ge3ZhbHVlLCBleGNsdWRlcywgZGVwdGh9IGFuZCBleHRyYWN0IElEc1xuICBoaWVyYXJjaGljYWxNdWx0aTogbmV3IFNldChbXCJ0YWdzXCIsIFwic3R1ZGlvc1wiLCBcInBlcmZvcm1lcl90YWdzXCJdKSxcbn07XG5cbi8vIFJlc29sdXRpb24gc3RyaW5nIHRvIEdyYXBoUUwgZW51bSBtYXBwaW5nXG4vLyBVUkwgdXNlcyBodW1hbi1yZWFkYWJsZSBzdHJpbmdzLCBHcmFwaFFMIGV4cGVjdHMgUmVzb2x1dGlvbkVudW0gdmFsdWVzXG5jb25zdCBSRVNPTFVUSU9OX01BUDogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgXCIxNDRwXCI6IFwiVkVSWV9MT1dcIixcbiAgXCIyNDBwXCI6IFwiTE9XXCIsXG4gIFwiMzYwcFwiOiBcIlIzNjBQXCIsXG4gIFwiNDgwcFwiOiBcIlNUQU5EQVJEXCIsXG4gIFwiNTQwcFwiOiBcIldFQl9IRFwiLFxuICBcIjcyMHBcIjogXCJTVEFOREFSRF9IRFwiLFxuICBcIjEwODBwXCI6IFwiRlVMTF9IRFwiLFxuICBcIjE0NDBwXCI6IFwiUVVBRF9IRFwiLFxuICBcIjRrXCI6IFwiRk9VUl9LXCIsXG4gIFwiNWtcIjogXCJGSVZFX0tcIixcbiAgXCI2a1wiOiBcIlNJWF9LXCIsXG4gIFwiN2tcIjogXCJTRVZFTl9LXCIsXG4gIFwiOGtcIjogXCJFSUdIVF9LXCIsXG4gIEh1Z2U6IFwiSFVHRVwiLFxufTtcblxuLy8gT3JpZW50YXRpb24gc3RyaW5nIHRvIEdyYXBoUUwgZW51bSBtYXBwaW5nXG5jb25zdCBPUklFTlRBVElPTl9NQVA6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPSB7XG4gIExhbmRzY2FwZTogXCJMQU5EU0NBUEVcIixcbiAgUG9ydHJhaXQ6IFwiUE9SVFJBSVRcIixcbiAgU3F1YXJlOiBcIlNRVUFSRVwiLFxufTtcblxuY29uc3QgaWRPZiA9ICh2OiBhbnkpOiB1bmtub3duID0+ICh0eXBlb2YgdiA9PT0gXCJvYmplY3RcIiAmJiB2ICYmIHYuaWQgPyB2LmlkIDogdik7XG5cbi8vIEJ1aWxkIFNjZW5lRmlsdGVyVHlwZSBmcm9tIFVSTCAnYycgcGFyYW1zIChkZWZhdWx0cyB0byBjdXJyZW50IHBhZ2UgVVJMKS5cbmV4cG9ydCBmdW5jdGlvbiBnZXRTY2VuZUZpbHRlcihcbiAgc2VhcmNoUGFyYW1zOiBVUkxTZWFyY2hQYXJhbXMgPSBnZXRTZWFyY2hQYXJhbXMoKSxcbik6IFNjZW5lRmlsdGVyVHlwZSB8IG51bGwge1xuICBjb25zdCBzY2VuZUZpbHRlcjogU2NlbmVGaWx0ZXJUeXBlID0ge307XG5cbiAgaWYgKCFzZWFyY2hQYXJhbXMuaGFzKFwiY1wiKSkgcmV0dXJuIG51bGw7XG5cbiAgZm9yIChjb25zdCBjU3RyIG9mIHNlYXJjaFBhcmFtcy5nZXRBbGwoXCJjXCIpKSB7XG4gICAgdHJ5IHtcbiAgICAgIC8vIERlY29kZSBVUkwgZm9ybWF0OiAoKSAtPiB7fSAoc2FmZWx5IHByZXNlcnZpbmcgc3RyaW5ncylcbiAgICAgIGNvbnN0IGRlY29kZWQgPSB0cmFuc2xhdGVKU09OKGNTdHIsIHRydWUpO1xuICAgICAgY29uc3QgY09iajogYW55ID0gSlNPTi5wYXJzZShkZWNvZGVkKTtcblxuICAgICAgY29uc3QgZmlsdGVyVHlwZTogc3RyaW5nIHwgdW5kZWZpbmVkID0gY09iai50eXBlO1xuICAgICAgaWYgKCFmaWx0ZXJUeXBlKSB7XG4gICAgICAgIGNvbnNvbGUud2FybihcIltTdGFzaCBCYXR0bGVdIEZpbHRlciBtaXNzaW5nIHR5cGU6XCIsIGNPYmopO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgLy8gUmVtb3ZlIHR5cGUgZnJvbSB0aGUgb2JqZWN0IC0gaXQgYmVjb21lcyB0aGUga2V5XG4gICAgICBjb25zdCB7IHR5cGU6IF90eXBlLCAuLi5yZXN0IH0gPSBjT2JqO1xuXG4gICAgICAvLyBDYXRlZ29yeTogQm9vbGVhbiAob3JnYW5pemVkLCBpbnRlcmFjdGl2ZSwgcGVyZm9ybWVyX2Zhdm9yaXRlKVxuICAgICAgaWYgKENSSVRFUklPTl9DQVRFR09SSUVTLmJvb2xlYW4uaGFzKGZpbHRlclR5cGUpKSB7XG4gICAgICAgIHNjZW5lRmlsdGVyW2ZpbHRlclR5cGVdID0gcmVzdC52YWx1ZSA9PT0gXCJ0cnVlXCIgfHwgcmVzdC52YWx1ZSA9PT0gdHJ1ZTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIC8vIENhdGVnb3J5OiBTdHJpbmdFbnVtIChzY2VuZUlzTWlzc2luZywgaGFzTWFya2VycylcbiAgICAgIGlmIChDUklURVJJT05fQ0FURUdPUklFUy5zdHJpbmdFbnVtLmhhcyhmaWx0ZXJUeXBlKSkge1xuICAgICAgICBzY2VuZUZpbHRlcltmaWx0ZXJUeXBlXSA9IHJlc3QudmFsdWU7XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICAvLyBDYXRlZ29yeTogTXVsdGkgKHBlcmZvcm1lcnMsIGdyb3VwcywgbW92aWVzLCBnYWxsZXJpZXMpXG4gICAgICBpZiAoQ1JJVEVSSU9OX0NBVEVHT1JJRVMubXVsdGkuaGFzKGZpbHRlclR5cGUpKSB7XG4gICAgICAgIGNvbnN0IHJlc3VsdDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gPSB7IG1vZGlmaWVyOiByZXN0Lm1vZGlmaWVyIH07XG4gICAgICAgIGNvbnN0IHZhbCA9IHJlc3QudmFsdWUgfHwge307XG5cbiAgICAgICAgaWYgKHZhbC5pdGVtcyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgY29uc3QgaXRlbXM6IGFueVtdID0gdmFsLml0ZW1zIHx8IFtdO1xuICAgICAgICAgIGNvbnN0IGV4Y2x1ZGVkOiBhbnlbXSA9IHZhbC5leGNsdWRlZCB8fCBbXTtcbiAgICAgICAgICByZXN1bHQudmFsdWUgPSBpdGVtcy5tYXAoaWRPZik7XG4gICAgICAgICAgaWYgKGV4Y2x1ZGVkLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIHJlc3VsdC5leGNsdWRlcyA9IGV4Y2x1ZGVkLm1hcChpZE9mKTtcbiAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSBpZiAoQXJyYXkuaXNBcnJheShyZXN0LnZhbHVlKSkge1xuICAgICAgICAgIHJlc3VsdC52YWx1ZSA9IHJlc3QudmFsdWUubWFwKGlkT2YpO1xuICAgICAgICB9IGVsc2UgaWYgKHJlc3QubW9kaWZpZXIgPT09IFwiSVNfTlVMTFwiIHx8IHJlc3QubW9kaWZpZXIgPT09IFwiTk9UX05VTExcIikge1xuICAgICAgICAgIHJlc3VsdC52YWx1ZSA9IFtdO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHJlc3VsdC52YWx1ZSA9IHJlc3QudmFsdWU7XG4gICAgICAgIH1cblxuICAgICAgICBzY2VuZUZpbHRlcltmaWx0ZXJUeXBlXSA9IHJlc3VsdDtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIC8vIENhdGVnb3J5OiBIaWVyYXJjaGljYWxNdWx0aSAodGFncywgc3R1ZGlvcywgcGVyZm9ybWVyX3RhZ3MpXG4gICAgICBpZiAoQ1JJVEVSSU9OX0NBVEVHT1JJRVMuaGllcmFyY2hpY2FsTXVsdGkuaGFzKGZpbHRlclR5cGUpKSB7XG4gICAgICAgIGNvbnN0IHZhbCA9IHJlc3QudmFsdWUgfHwge307XG4gICAgICAgIGNvbnN0IGl0ZW1zOiBhbnlbXSA9IHZhbC5pdGVtcyB8fCBbXTtcbiAgICAgICAgY29uc3QgZXhjbHVkZWQ6IGFueVtdID0gdmFsLmV4Y2x1ZGVkIHx8IFtdO1xuICAgICAgICBzY2VuZUZpbHRlcltmaWx0ZXJUeXBlXSA9IHtcbiAgICAgICAgICBtb2RpZmllcjogcmVzdC5tb2RpZmllcixcbiAgICAgICAgICB2YWx1ZTogaXRlbXMubWFwKGlkT2YpLFxuICAgICAgICAgIGV4Y2x1ZGVzOiBleGNsdWRlZC5tYXAoaWRPZiksXG4gICAgICAgICAgZGVwdGg6IHZhbC5kZXB0aCA/PyAwLFxuICAgICAgICB9O1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgLy8gQ2F0ZWdvcnk6IFJlc29sdXRpb24gKG5lZWRzIHN0cmluZyAtPiBlbnVtIGNvbnZlcnNpb24pXG4gICAgICBpZiAoZmlsdGVyVHlwZSA9PT0gXCJyZXNvbHV0aW9uXCIpIHtcbiAgICAgICAgc2NlbmVGaWx0ZXJbZmlsdGVyVHlwZV0gPSB7XG4gICAgICAgICAgbW9kaWZpZXI6IHJlc3QubW9kaWZpZXIsXG4gICAgICAgICAgdmFsdWU6IFJFU09MVVRJT05fTUFQW3Jlc3QudmFsdWVdIHx8IHJlc3QudmFsdWUsXG4gICAgICAgIH07XG4gICAgICAgIGNvbnRpbnVlO1xuICAgICAgfVxuXG4gICAgICAvLyBDYXRlZ29yeTogT3JpZW50YXRpb24gKG11bHRpLXNlbGVjdCBlbnVtLCBubyBtb2RpZmllcilcbiAgICAgIGlmIChmaWx0ZXJUeXBlID09PSBcIm9yaWVudGF0aW9uXCIpIHtcbiAgICAgICAgY29uc3QgdmFsdWVzOiBhbnlbXSA9IEFycmF5LmlzQXJyYXkocmVzdC52YWx1ZSkgPyByZXN0LnZhbHVlIDogW3Jlc3QudmFsdWVdO1xuICAgICAgICBzY2VuZUZpbHRlcltmaWx0ZXJUeXBlXSA9IHtcbiAgICAgICAgICB2YWx1ZTogdmFsdWVzLm1hcCgodikgPT4gT1JJRU5UQVRJT05fTUFQW3ZdIHx8IHYpLmZpbHRlcihCb29sZWFuKSxcbiAgICAgICAgfTtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG5cbiAgICAgIC8vIENhdGVnb3J5OiBEdXBsaWNhdGVkIChwaGFzaCBkdXBsaWNhdGUgZmlsdGVyIC0gZGlmZmVyZW50IHN0cnVjdHVyZSlcbiAgICAgIGlmIChmaWx0ZXJUeXBlID09PSBcImR1cGxpY2F0ZWRcIikge1xuICAgICAgICBzY2VuZUZpbHRlcltmaWx0ZXJUeXBlXSA9IHtcbiAgICAgICAgICBkdXBsaWNhdGVkOiByZXN0LnZhbHVlID09PSBcInRydWVcIiB8fCByZXN0LnZhbHVlID09PSB0cnVlLFxuICAgICAgICB9O1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cblxuICAgICAgLy8gQ2F0ZWdvcnk6IFN0YW5kYXJkIChudW1iZXIsIHN0cmluZywgZGF0ZSwgdGltZXN0YW1wLCBkdXJhdGlvbiwgc3BlY2lhbClcbiAgICAgIGlmIChcbiAgICAgICAgcmVzdC52YWx1ZSAmJlxuICAgICAgICB0eXBlb2YgcmVzdC52YWx1ZSA9PT0gXCJvYmplY3RcIiAmJlxuICAgICAgICAhQXJyYXkuaXNBcnJheShyZXN0LnZhbHVlKSAmJlxuICAgICAgICBcInZhbHVlXCIgaW4gcmVzdC52YWx1ZVxuICAgICAgKSB7XG4gICAgICAgIC8vIEZsYXR0ZW46IHsgbW9kaWZpZXIsIHZhbHVlOiB7IHZhbHVlOiBYLCB2YWx1ZTI6IFkgfSB9IC0+IHsgbW9kaWZpZXIsIHZhbHVlOiBYLCB2YWx1ZTI6IFkgfVxuICAgICAgICBzY2VuZUZpbHRlcltmaWx0ZXJUeXBlXSA9IHtcbiAgICAgICAgICBtb2RpZmllcjogcmVzdC5tb2RpZmllcixcbiAgICAgICAgICB2YWx1ZTogcmVzdC52YWx1ZS52YWx1ZSxcbiAgICAgICAgICAuLi4ocmVzdC52YWx1ZS52YWx1ZTIgIT09IHVuZGVmaW5lZCAmJiB7IHZhbHVlMjogcmVzdC52YWx1ZS52YWx1ZTIgfSksXG4gICAgICAgIH07XG4gICAgICB9IGVsc2UgaWYgKHJlc3QubW9kaWZpZXIgPT09IFwiSVNfTlVMTFwiIHx8IHJlc3QubW9kaWZpZXIgPT09IFwiTk9UX05VTExcIikge1xuICAgICAgICAvLyBJU19OVUxML05PVF9OVUxMIGRvbid0IHVzZSB0aGUgdmFsdWUsIGJ1dCB0aGUgc2NoZW1hIHN0aWxsIHJlcXVpcmVzIGl0XG4gICAgICAgIHNjZW5lRmlsdGVyW2ZpbHRlclR5cGVdID0ge1xuICAgICAgICAgIG1vZGlmaWVyOiByZXN0Lm1vZGlmaWVyLFxuICAgICAgICAgIHZhbHVlOiAwLFxuICAgICAgICB9O1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gUGFzcyB0aHJvdWdoIGFzLWlzIChzdHJpbmcgY3JpdGVyaWEsIHNwZWNpYWwgY3JpdGVyaWEgbGlrZSBwaGFzaCwgc3Rhc2hfaWQsIGV0Yy4pXG4gICAgICAgIHNjZW5lRmlsdGVyW2ZpbHRlclR5cGVdID0gcmVzdDtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0gRmFpbGVkIHRvIHBhcnNlIGZpbHRlcjpcIiwgY1N0ciwgZSk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIE9iamVjdC5rZXlzKHNjZW5lRmlsdGVyKS5sZW5ndGggPiAwID8gc2NlbmVGaWx0ZXIgOiBudWxsO1xufVxuXG4vKiogUGFyc2VkIGZpbHRlciBzdGF0ZSBmb3IgdGhlIGN1cnJlbnQgU3Rhc2ggbGlzdCBVUkwuICovXG5leHBvcnQgaW50ZXJmYWNlIExpc3RGaWx0ZXJzIHtcbiAgZmlsdGVyS2V5OiBzdHJpbmc7XG4gIHNjZW5lRmlsdGVyOiBTY2VuZUZpbHRlclR5cGUgfCBudWxsO1xuICBmaWx0ZXJBY3RpdmU6IGJvb2xlYW47XG59XG5cbi8qKiBSZWFkIFVSTCBmaWx0ZXIgc3RhdGUgb25jZSAoY2FjaGUga2V5LCBHcmFwaFFMIHNjZW5lX2ZpbHRlciwgYWN0aXZlIGZsYWcpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlYWRGaWx0ZXJzKCk6IExpc3RGaWx0ZXJzIHtcbiAgY29uc3Qgc2VhcmNoUGFyYW1zID0gZ2V0U2VhcmNoUGFyYW1zKCk7XG4gIGNvbnN0IHNjZW5lRmlsdGVyID0gZ2V0U2NlbmVGaWx0ZXIoc2VhcmNoUGFyYW1zKTtcbiAgY29uc3QgcSA9IHNlYXJjaFBhcmFtcy5nZXQoXCJxXCIpIHx8IFwiXCI7XG4gIHJldHVybiB7XG4gICAgZmlsdGVyS2V5OiBKU09OLnN0cmluZ2lmeSh7IHEsIGZpbHRlcjogc2NlbmVGaWx0ZXIgfHwge30gfSksXG4gICAgc2NlbmVGaWx0ZXIsXG4gICAgZmlsdGVyQWN0aXZlOiBCb29sZWFuKHNjZW5lRmlsdGVyIHx8IHNlYXJjaFBhcmFtcy5oYXMoXCJjXCIpIHx8IHNlYXJjaFBhcmFtcy5nZXQoXCJxXCIpKSxcbiAgfTtcbn1cblxuLy8gQ2FjaGUga2V5IGZvciB0aGUgY3VycmVudCBsaXN0IFVSTCAoY3JpdGVyaWEgKyB0ZXh0IHNlYXJjaCkuXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRGaWx0ZXJLZXkoKTogc3RyaW5nIHtcbiAgcmV0dXJuIHJlYWRGaWx0ZXJzKCkuZmlsdGVyS2V5O1xufVxuXG4vKiogVHJ1ZSB3aGVuIHRoZSBjdXJyZW50IFN0YXNoIGxpc3QgVVJMIGhhcyBhY3RpdmUgZmlsdGVycyAoY3JpdGVyaWEgYW5kL29yIHRleHQgc2VhcmNoKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjaGVja0ZvckZpbHRlcnMoKTogYm9vbGVhbiB7XG4gIHJldHVybiByZWFkRmlsdGVycygpLmZpbHRlckFjdGl2ZTtcbn1cbiIsICIvLyBHcmFwaFFMIGFjY2VzcyBhZ2FpbnN0IHRoZSBTdGFzaCBiYWNrZW5kLlxuXG5pbXBvcnQgdHlwZSB7IEZpbmRTY2VuZVJlc3VsdCwgU2NlbmUgfSBmcm9tIFwiLi90eXBlc1wiO1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZ3JhcGhxbFF1ZXJ5PFQgPSB1bmtub3duPihcbiAgcXVlcnk6IHN0cmluZyxcbiAgdmFyaWFibGVzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHt9LFxuKTogUHJvbWlzZTxUPiB7XG4gIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goXCIvZ3JhcGhxbFwiLCB7XG4gICAgbWV0aG9kOiBcIlBPU1RcIixcbiAgICBoZWFkZXJzOiB7XG4gICAgICBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIixcbiAgICB9LFxuICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsgcXVlcnksIHZhcmlhYmxlcyB9KSxcbiAgfSk7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlc3BvbnNlLmpzb24oKTtcbiAgaWYgKHJlc3VsdC5lcnJvcnMpIHtcbiAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0gR3JhcGhRTCBlcnJvcjpcIiwgcmVzdWx0LmVycm9ycyk7XG4gICAgdGhyb3cgbmV3IEVycm9yKHJlc3VsdC5lcnJvcnNbMF0ubWVzc2FnZSk7XG4gIH1cbiAgcmV0dXJuIHJlc3VsdC5kYXRhIGFzIFQ7XG59XG5cbmV4cG9ydCBjb25zdCBTQ0VORV9GUkFHTUVOVCA9IGBcbiAgICBpZFxuICAgIHRpdGxlXG4gICAgZGF0ZVxuICAgIHJhdGluZzEwMFxuICAgIHBsYXlfY291bnRcbiAgICBwYXRocyB7XG4gICAgICBzY3JlZW5zaG90XG4gICAgICBwcmV2aWV3XG4gICAgfVxuICAgIGZpbGVzIHtcbiAgICAgIGR1cmF0aW9uXG4gICAgICBwYXRoXG4gICAgfVxuICAgIHN0dWRpbyB7XG4gICAgICBuYW1lXG4gICAgfVxuICAgIHBlcmZvcm1lcnMge1xuICAgICAgbmFtZVxuICAgIH1cbiAgICB0YWdzIHtcbiAgICAgIG5hbWVcbiAgICB9XG4gIGA7XG5cbmV4cG9ydCBjb25zdCBGSU5EX1NDRU5FU19RVUVSWSA9IGBcbiAgICAgIHF1ZXJ5IEZpbmRTY2VuZXNCeVJhdGluZygkZmlsdGVyOiBGaW5kRmlsdGVyVHlwZSwgJHNjZW5lX2ZpbHRlcjogU2NlbmVGaWx0ZXJUeXBlKSB7XG4gICAgICAgIGZpbmRTY2VuZXMoZmlsdGVyOiAkZmlsdGVyLCBzY2VuZV9maWx0ZXI6ICRzY2VuZV9maWx0ZXIpIHtcbiAgICAgICAgICBjb3VudFxuICAgICAgICAgIHNjZW5lcyB7XG4gICAgICAgICAgICAke1NDRU5FX0ZSQUdNRU5UfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIGA7XG5cbi8vIEV4dHJhY3Qgc2NlbmUgSUQgZnJvbSBpbmRpdmlkdWFsIHNjZW5lIHBhZ2VzIGxpa2UgL3NjZW5lcy8xMjNcbmV4cG9ydCBmdW5jdGlvbiBnZXRTY2VuZUlkRnJvbVVybCgpOiBzdHJpbmcgfCBudWxsIHtcbiAgY29uc3QgbWF0Y2ggPSB3aW5kb3cubG9jYXRpb24ucGF0aG5hbWUubWF0Y2goL15cXC9zY2VuZXNcXC8oXFxkKykkLyk7XG4gIHJldHVybiBtYXRjaCA/IG1hdGNoWzFdIDogbnVsbDtcbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGZldGNoU2NlbmVCeUlkKHNjZW5lSWQ6IHN0cmluZyk6IFByb21pc2U8U2NlbmUgfCBudWxsPiB7XG4gIGNvbnN0IHF1ZXJ5ID0gYFxuICAgICAgcXVlcnkgRmluZFNjZW5lKCRpZDogSUQhKSB7XG4gICAgICAgIGZpbmRTY2VuZShpZDogJGlkKSB7XG4gICAgICAgICAgJHtTQ0VORV9GUkFHTUVOVH1cbiAgICAgICAgfVxuICAgICAgfVxuICAgIGA7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGdyYXBocWxRdWVyeTxGaW5kU2NlbmVSZXN1bHQ+KHF1ZXJ5LCB7IGlkOiBzY2VuZUlkIH0pO1xuICByZXR1cm4gcmVzdWx0LmZpbmRTY2VuZTtcbn1cbiIsICIvLyBDZW50cmFsIG11dGFibGUgcnVudGltZSBzdGF0ZS5cbi8vXG4vLyBUaGUgb3JpZ2luYWwgcGx1Z2luIHVzZWQgbW9kdWxlLWxldmVsIGBsZXRgIGJpbmRpbmdzIHNoYXJlZCBhY3Jvc3MgbWFueSBmdW5jdGlvbnMuXG4vLyBFUyBtb2R1bGVzIGNhbm5vdCByZWFzc2lnbiBhbiBpbXBvcnRlZCBiaW5kaW5nIGZyb20gYW5vdGhlciBtb2R1bGUsIHNvIGFsbCBzaGFyZWRcbi8vIG11dGFibGUgdmFsdWVzIGxpdmUgb24gdGhpcyBzaW5nbGUgYHN0YXRlYCBvYmplY3QgdGhhdCBldmVyeSBtb2R1bGUgaW1wb3J0cy5cblxuaW1wb3J0IHsgREVGQVVMVF9GSUxURVJfT1BQT05FTlRTLCBGSUxURVJfT1BQT05FTlRTX0tFWSwgTVVURV9QUkVWSUVXU19LRVkgfSBmcm9tIFwiLi9jb25zdGFudHNcIjtcbmltcG9ydCB0eXBlIHsgTW9kZSwgUGFpciwgUmFua3MsIFNjZW5lIH0gZnJvbSBcIi4vdHlwZXNcIjtcblxuZXhwb3J0IGludGVyZmFjZSBNZW1vcnlDYWNoZSB7XG4gIGFsbFNjZW5lczogU2NlbmVbXSB8IG51bGw7IC8vIEFsbCBzY2VuZXMgKG5vIGZpbHRlcilcbiAgZmlsdGVyZWRTY2VuZXM6IFNjZW5lW10gfCBudWxsOyAvLyBTY2VuZXMgbWF0Y2hpbmcgY3VycmVudCBmaWx0ZXJcbiAgZmlsdGVyS2V5OiBzdHJpbmcgfCBudWxsOyAvLyBDdXJyZW50IGZpbHRlciBwYXJhbXMgZm9yIGNhY2hlIHZhbGlkYXRpb25cbiAgdGltZXN0YW1wOiBudW1iZXIgfCBudWxsOyAvLyBXaGVuIGNhY2hlIHdhcyBwb3B1bGF0ZWRcbn1cblxuZXhwb3J0IGludGVyZmFjZSBCYXR0bGVTdGF0ZSB7XG4gIC8vIEN1cnJlbnQgY29tcGFyaXNvbiBwYWlyIGFuZCBtb2RlXG4gIGN1cnJlbnRQYWlyOiBQYWlyO1xuICBjdXJyZW50UmFua3M6IFJhbmtzO1xuICBjdXJyZW50TW9kZTogTW9kZTtcbiAgLy8gR2F1bnRsZXQgLyBjaGFtcGlvbiBydW4gdHJhY2tpbmdcbiAgZ2F1bnRsZXRDbGltYmVyOiBTY2VuZSB8IG51bGw7IC8vIFRoZSBzY2VuZSBjdXJyZW50bHkgY2xpbWJpbmcgKG9uIGEgd2luIHN0cmVhaylcbiAgZ2F1bnRsZXRXaW5zOiBudW1iZXI7IC8vIEN1cnJlbnQgd2luIHN0cmVha1xuICBnYXVudGxldENsaW1iZXJSYW5rOiBudW1iZXI7IC8vIENsaW1iZXIncyBjdXJyZW50IHJhbmsgcG9zaXRpb24gKDEgPSB0b3ApXG4gIGdhdW50bGV0RGVmZWF0ZWQ6IHN0cmluZ1tdOyAvLyBJRHMgb2Ygc2NlbmVzIGRlZmVhdGVkIGluIGN1cnJlbnQgcnVuXG4gIGdhdW50bGV0RmFsbGluZzogYm9vbGVhbjsgLy8gVHJ1ZSB3aGVuIGNsaW1iZXIgbG9zdCBhbmQgaXMgZmluZGluZyB0aGVpciBmbG9vclxuICBnYXVudGxldEZhbGxpbmdTY2VuZTogU2NlbmUgfCBudWxsOyAvLyBUaGUgc2NlbmUgdGhhdCdzIGZhbGxpbmcgdG8gZmluZCBpdHMgcG9zaXRpb25cbiAgdG90YWxTY2VuZXNDb3VudDogbnVtYmVyOyAvLyBUb3RhbCBzY2VuZXMgZm9yIHBvc2l0aW9uIGRpc3BsYXlcbiAgZGlzYWJsZUNob2ljZTogYm9vbGVhbjsgLy8gUHJldmVudHMgbXVsdGlwbGUgcmFwaWQgY2hvaWNlIGV2ZW50c1xuICBzYXZlZEZpbHRlclBhcmFtczogc3RyaW5nOyAvLyBTdG9yZWQgVVJMIGZpbHRlciBwYXJhbXMgdG8gZGV0ZWN0IGNoYW5nZXNcbiAgLy8gVXNlciB0b2dnbGVzXG4gIGZpbHRlck9wcG9uZW50czogYm9vbGVhbjtcbiAgbXV0ZVByZXZpZXdzOiBib29sZWFuO1xuICAvLyBTaHVmZmxlIHN0YXRlIGZvciBmaWx0ZXJlZCBzY2VuZXMgKHByZXZlbnRzIGR1cGxpY2F0ZXMgd2hlbiBza2lwcGluZylcbiAgc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lczogU2NlbmVbXTtcbiAgc2h1ZmZsZUluZGV4OiBudW1iZXI7XG4gIHNodWZmbGVGaWx0ZXJLZXk6IHN0cmluZyB8IG51bGw7XG4gIHJlbW92ZWRTY2VuZUlkczogU2V0PHN0cmluZz47IC8vIFNjZW5lcyByZW1vdmVkIHRoaXMgc2Vzc2lvbiAoc3Vydml2ZXMgYmFja2dyb3VuZCByZWZyZXNoKVxuICAvLyBTY2VuZSBjYWNoZSAobWVtb3J5IHRpZXIpXG4gIG1lbW9yeUNhY2hlOiBNZW1vcnlDYWNoZTtcbn1cblxuZnVuY3Rpb24gcmVhZEJvb2xlYW5QcmVmKGtleTogc3RyaW5nLCBmYWxsYmFjazogYm9vbGVhbik6IGJvb2xlYW4ge1xuICB0cnkge1xuICAgIGNvbnN0IHN0b3JlZCA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKGtleSk7XG4gICAgaWYgKHN0b3JlZCAhPT0gbnVsbCkgcmV0dXJuIHN0b3JlZCA9PT0gXCIxXCI7XG4gIH0gY2F0Y2gge1xuICAgIC8qIGlnbm9yZSAqL1xuICB9XG4gIHJldHVybiBmYWxsYmFjaztcbn1cblxuZXhwb3J0IGNvbnN0IHN0YXRlOiBCYXR0bGVTdGF0ZSA9IHtcbiAgY3VycmVudFBhaXI6IHsgbGVmdDogbnVsbCwgcmlnaHQ6IG51bGwgfSxcbiAgY3VycmVudFJhbmtzOiB7IGxlZnQ6IG51bGwsIHJpZ2h0OiBudWxsIH0sXG4gIGN1cnJlbnRNb2RlOiBcInN3aXNzXCIsXG4gIGdhdW50bGV0Q2xpbWJlcjogbnVsbCxcbiAgZ2F1bnRsZXRXaW5zOiAwLFxuICBnYXVudGxldENsaW1iZXJSYW5rOiAwLFxuICBnYXVudGxldERlZmVhdGVkOiBbXSxcbiAgZ2F1bnRsZXRGYWxsaW5nOiBmYWxzZSxcbiAgZ2F1bnRsZXRGYWxsaW5nU2NlbmU6IG51bGwsXG4gIHRvdGFsU2NlbmVzQ291bnQ6IDAsXG4gIGRpc2FibGVDaG9pY2U6IGZhbHNlLFxuICBzYXZlZEZpbHRlclBhcmFtczogXCJcIixcbiAgZmlsdGVyT3Bwb25lbnRzOiByZWFkQm9vbGVhblByZWYoRklMVEVSX09QUE9ORU5UU19LRVksIERFRkFVTFRfRklMVEVSX09QUE9ORU5UUyksXG4gIG11dGVQcmV2aWV3czogcmVhZEJvb2xlYW5QcmVmKE1VVEVfUFJFVklFV1NfS0VZLCBmYWxzZSksXG4gIHNodWZmbGVkRmlsdGVyZWRTY2VuZXM6IFtdLFxuICBzaHVmZmxlSW5kZXg6IDAsXG4gIHNodWZmbGVGaWx0ZXJLZXk6IG51bGwsXG4gIHJlbW92ZWRTY2VuZUlkczogbmV3IFNldDxzdHJpbmc+KCksXG4gIG1lbW9yeUNhY2hlOiB7XG4gICAgYWxsU2NlbmVzOiBudWxsLFxuICAgIGZpbHRlcmVkU2NlbmVzOiBudWxsLFxuICAgIGZpbHRlcktleTogbnVsbCxcbiAgICB0aW1lc3RhbXA6IG51bGwsXG4gIH0sXG59O1xuXG5leHBvcnQgZnVuY3Rpb24gcmVzZXRHYXVudGxldFN0YXRlKCk6IHZvaWQge1xuICBzdGF0ZS5nYXVudGxldENsaW1iZXIgPSBudWxsO1xuICBzdGF0ZS5nYXVudGxldFdpbnMgPSAwO1xuICBzdGF0ZS5nYXVudGxldENsaW1iZXJSYW5rID0gMDtcbiAgc3RhdGUuZ2F1bnRsZXREZWZlYXRlZCA9IFtdO1xuICBzdGF0ZS5nYXVudGxldEZhbGxpbmcgPSBmYWxzZTtcbiAgc3RhdGUuZ2F1bnRsZXRGYWxsaW5nU2NlbmUgPSBudWxsO1xufVxuIiwgIi8vIFNjZW5lIGNhY2hlOiBJbmRleGVkREIgKGR1cmFibGUpICsgaW4tbWVtb3J5IChwZXIgc2Vzc2lvbiksIHN0YWxlLXdoaWxlLXJldmFsaWRhdGUuXG5cbmltcG9ydCB7XG4gIENBQ0hFX0RCX05BTUUsXG4gIENBQ0hFX0RCX1ZFUlNJT04sXG4gIENBQ0hFX01BWF9BR0VfTVMsXG4gIENBQ0hFX1NUT1JFX05BTUUsXG59IGZyb20gXCIuL2NvbnN0YW50c1wiO1xuaW1wb3J0IHsgZ2V0RmluZEZpbHRlciwgdHlwZSBMaXN0RmlsdGVycyB9IGZyb20gXCIuL2ZpbHRlcnNcIjtcbmltcG9ydCB7IEZJTkRfU0NFTkVTX1FVRVJZLCBncmFwaHFsUXVlcnkgfSBmcm9tIFwiLi9ncmFwaHFsXCI7XG5pbXBvcnQgeyBzdGF0ZSB9IGZyb20gXCIuL3N0YXRlXCI7XG5pbXBvcnQgdHlwZSB7IENhY2hlRW50cnksIEZpbmRTY2VuZXNSZXN1bHQsIFNjZW5lIH0gZnJvbSBcIi4vdHlwZXNcIjtcblxuLy8gT3BlbiBJbmRleGVkREIgZGF0YWJhc2VcbmZ1bmN0aW9uIG9wZW5DYWNoZURCKCk6IFByb21pc2U8SURCRGF0YWJhc2U+IHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICBjb25zdCByZXF1ZXN0ID0gaW5kZXhlZERCLm9wZW4oQ0FDSEVfREJfTkFNRSwgQ0FDSEVfREJfVkVSU0lPTik7XG5cbiAgICByZXF1ZXN0Lm9uZXJyb3IgPSAoKSA9PiB7XG4gICAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0gSW5kZXhlZERCIGVycm9yOlwiLCByZXF1ZXN0LmVycm9yKTtcbiAgICAgIHJlamVjdChyZXF1ZXN0LmVycm9yKTtcbiAgICB9O1xuXG4gICAgcmVxdWVzdC5vbnN1Y2Nlc3MgPSAoKSA9PiB7XG4gICAgICByZXNvbHZlKHJlcXVlc3QucmVzdWx0KTtcbiAgICB9O1xuXG4gICAgcmVxdWVzdC5vbnVwZ3JhZGVuZWVkZWQgPSAoZXZlbnQpID0+IHtcbiAgICAgIGNvbnN0IGRiID0gKGV2ZW50LnRhcmdldCBhcyBJREJPcGVuREJSZXF1ZXN0KS5yZXN1bHQ7XG4gICAgICBpZiAoIWRiLm9iamVjdFN0b3JlTmFtZXMuY29udGFpbnMoQ0FDSEVfU1RPUkVfTkFNRSkpIHtcbiAgICAgICAgZGIuY3JlYXRlT2JqZWN0U3RvcmUoQ0FDSEVfU1RPUkVfTkFNRSwgeyBrZXlQYXRoOiBcImNhY2hlS2V5XCIgfSk7XG4gICAgICB9XG4gICAgfTtcbiAgfSk7XG59XG5cbi8vIEdldCBjYWNoZWQgc2NlbmVzIGZyb20gSW5kZXhlZERCXG5hc3luYyBmdW5jdGlvbiBnZXRDYWNoZWRTY2VuZXMoY2FjaGVLZXk6IHN0cmluZyk6IFByb21pc2U8Q2FjaGVFbnRyeSB8IG51bGw+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBkYiA9IGF3YWl0IG9wZW5DYWNoZURCKCk7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlPENhY2hlRW50cnkgfCBudWxsPigocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICBjb25zdCB0cmFuc2FjdGlvbiA9IGRiLnRyYW5zYWN0aW9uKENBQ0hFX1NUT1JFX05BTUUsIFwicmVhZG9ubHlcIik7XG4gICAgICBjb25zdCBzdG9yZSA9IHRyYW5zYWN0aW9uLm9iamVjdFN0b3JlKENBQ0hFX1NUT1JFX05BTUUpO1xuICAgICAgY29uc3QgcmVxdWVzdCA9IHN0b3JlLmdldChjYWNoZUtleSk7XG5cbiAgICAgIHJlcXVlc3Qub25zdWNjZXNzID0gKCkgPT4ge1xuICAgICAgICBjb25zdCByZXN1bHQgPSByZXF1ZXN0LnJlc3VsdCBhcyBDYWNoZUVudHJ5IHwgdW5kZWZpbmVkO1xuICAgICAgICBpZiAocmVzdWx0ICYmIERhdGUubm93KCkgLSByZXN1bHQudGltZXN0YW1wIDwgQ0FDSEVfTUFYX0FHRV9NUykge1xuICAgICAgICAgIHJlc29sdmUocmVzdWx0KTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICByZXNvbHZlKG51bGwpOyAvLyBDYWNoZSBtaXNzIG9yIGV4cGlyZWRcbiAgICAgICAgfVxuICAgICAgfTtcblxuICAgICAgcmVxdWVzdC5vbmVycm9yID0gKCkgPT4gcmVqZWN0KHJlcXVlc3QuZXJyb3IpO1xuICAgICAgdHJhbnNhY3Rpb24ub25jb21wbGV0ZSA9ICgpID0+IGRiLmNsb3NlKCk7XG4gICAgfSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0gQ2FjaGUgcmVhZCBlcnJvcjpcIiwgZSk7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbn1cblxuLy8gU3RvcmUgc2NlbmVzIGluIEluZGV4ZWREQlxuYXN5bmMgZnVuY3Rpb24gc2V0Q2FjaGVkU2NlbmVzKFxuICBjYWNoZUtleTogc3RyaW5nLFxuICBzY2VuZXM6IFNjZW5lW10sXG4gIGNvdW50OiBudW1iZXIsXG4gIGZpbHRlcktleT86IHN0cmluZyxcbik6IFByb21pc2U8dm9pZD4ge1xuICB0cnkge1xuICAgIGNvbnN0IGRiID0gYXdhaXQgb3BlbkNhY2hlREIoKTtcbiAgICByZXR1cm4gbmV3IFByb21pc2U8dm9pZD4oKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgY29uc3QgdHJhbnNhY3Rpb24gPSBkYi50cmFuc2FjdGlvbihDQUNIRV9TVE9SRV9OQU1FLCBcInJlYWR3cml0ZVwiKTtcbiAgICAgIGNvbnN0IHN0b3JlID0gdHJhbnNhY3Rpb24ub2JqZWN0U3RvcmUoQ0FDSEVfU1RPUkVfTkFNRSk7XG5cbiAgICAgIGNvbnN0IGRhdGE6IENhY2hlRW50cnkgPSB7XG4gICAgICAgIGNhY2hlS2V5LFxuICAgICAgICBzY2VuZXMsXG4gICAgICAgIGNvdW50LFxuICAgICAgICB0aW1lc3RhbXA6IERhdGUubm93KCksXG4gICAgICAgIC4uLihmaWx0ZXJLZXkgIT09IHVuZGVmaW5lZCAmJiB7IGZpbHRlcktleSB9KSxcbiAgICAgIH07XG5cbiAgICAgIGNvbnN0IHJlcXVlc3QgPSBzdG9yZS5wdXQoZGF0YSk7XG4gICAgICByZXF1ZXN0Lm9uc3VjY2VzcyA9ICgpID0+IHJlc29sdmUoKTtcbiAgICAgIHJlcXVlc3Qub25lcnJvciA9ICgpID0+IHJlamVjdChyZXF1ZXN0LmVycm9yKTtcbiAgICAgIHRyYW5zYWN0aW9uLm9uY29tcGxldGUgPSAoKSA9PiBkYi5jbG9zZSgpO1xuICAgIH0pO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIENhY2hlIHdyaXRlIGVycm9yOlwiLCBlKTtcbiAgfVxufVxuXG4vLyBDbGVhciBhbGwgY2FjaGVkIHNjZW5lcyAoZm9yIG1hbnVhbCByZWZyZXNoKVxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNsZWFyU2NlbmVDYWNoZSgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgdHJ5IHtcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCfl5HvuI8gQ2xlYXJpbmcgYWxsIHNjZW5lIGNhY2hlcy4uLlwiKTtcbiAgICBjb25zdCBkYiA9IGF3YWl0IG9wZW5DYWNoZURCKCk7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgIGNvbnN0IHRyYW5zYWN0aW9uID0gZGIudHJhbnNhY3Rpb24oQ0FDSEVfU1RPUkVfTkFNRSwgXCJyZWFkd3JpdGVcIik7XG4gICAgICBjb25zdCBzdG9yZSA9IHRyYW5zYWN0aW9uLm9iamVjdFN0b3JlKENBQ0hFX1NUT1JFX05BTUUpO1xuICAgICAgY29uc3QgcmVxdWVzdCA9IHN0b3JlLmNsZWFyKCk7XG5cbiAgICAgIHJlcXVlc3Qub25zdWNjZXNzID0gKCkgPT4ge1xuICAgICAgICBzdGF0ZS5tZW1vcnlDYWNoZSA9IHsgYWxsU2NlbmVzOiBudWxsLCBmaWx0ZXJlZFNjZW5lczogbnVsbCwgZmlsdGVyS2V5OiBudWxsLCB0aW1lc3RhbXA6IG51bGwgfTtcbiAgICAgICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDinIUgQWxsIGNhY2hlcyBjbGVhcmVkIChtZW1vcnkgKyBJbmRleGVkREIpXCIpO1xuICAgICAgICByZXNvbHZlKCk7XG4gICAgICB9O1xuICAgICAgcmVxdWVzdC5vbmVycm9yID0gKCkgPT4gcmVqZWN0KHJlcXVlc3QuZXJyb3IpO1xuICAgICAgdHJhbnNhY3Rpb24ub25jb21wbGV0ZSA9ICgpID0+IGRiLmNsb3NlKCk7XG4gICAgfSk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0g4p2MIENhY2hlIGNsZWFyIGVycm9yOlwiLCBlKTtcbiAgfVxufVxuXG4vLyBDbGVhciBqdXN0IHRoZSBmaWx0ZXJlZCBzY2VuZXMgY2FjaGUgKGZvciBhdXRvLXJlZnJlc2ggYWZ0ZXIgcG9vbCBleGhhdXN0aW9uKVxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNsZWFyRmlsdGVyZWRDYWNoZSgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCBkYiA9IGF3YWl0IG9wZW5DYWNoZURCKCk7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgIGNvbnN0IHRyYW5zYWN0aW9uID0gZGIudHJhbnNhY3Rpb24oQ0FDSEVfU1RPUkVfTkFNRSwgXCJyZWFkd3JpdGVcIik7XG4gICAgICBjb25zdCBzdG9yZSA9IHRyYW5zYWN0aW9uLm9iamVjdFN0b3JlKENBQ0hFX1NUT1JFX05BTUUpO1xuICAgICAgY29uc3QgcmVxdWVzdCA9IHN0b3JlLmRlbGV0ZShcImZpbHRlcmVkLXNjZW5lc1wiKTtcblxuICAgICAgcmVxdWVzdC5vbnN1Y2Nlc3MgPSAoKSA9PiB7XG4gICAgICAgIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzID0gbnVsbDtcbiAgICAgICAgc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyS2V5ID0gbnVsbDtcbiAgICAgICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5eR77iPIEZpbHRlcmVkIGNhY2hlIGNsZWFyZWQgKG1lbW9yeSArIEluZGV4ZWREQilcIik7XG4gICAgICAgIHJlc29sdmUoKTtcbiAgICAgIH07XG4gICAgICByZXF1ZXN0Lm9uZXJyb3IgPSAoKSA9PiByZWplY3QocmVxdWVzdC5lcnJvcik7XG4gICAgICB0cmFuc2FjdGlvbi5vbmNvbXBsZXRlID0gKCkgPT4gZGIuY2xvc2UoKTtcbiAgICB9KTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnNvbGUuZXJyb3IoXCJbU3Rhc2ggQmF0dGxlXSDinYwgRmlsdGVyZWQgY2FjaGUgY2xlYXIgZXJyb3I6XCIsIGUpO1xuICAgIC8vIFN0aWxsIGNsZWFyIG1lbW9yeSBjYWNoZSBldmVuIGlmIEluZGV4ZWREQiBmYWlsc1xuICAgIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzID0gbnVsbDtcbiAgICBzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJLZXkgPSBudWxsO1xuICB9XG59XG5cbi8vIEJhY2tncm91bmQgcmVmcmVzaCAtIGZldGNoIGZyb20gbmV0d29yayBhbmQgdXBkYXRlIGNhY2hlcyBzaWxlbnRseVxuYXN5bmMgZnVuY3Rpb24gYmFja2dyb3VuZFJlZnJlc2hBbGxTY2VuZXMoKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGNhY2hlS2V5ID0gXCJhbGwtc2NlbmVzXCI7XG5cbiAgdHJ5IHtcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCflIQgQmFja2dyb3VuZCByZWZyZXNoIHN0YXJ0ZWQgKGFsbCBzY2VuZXMpLi4uXCIpO1xuICAgIGNvbnN0IHN0YXJ0VGltZSA9IERhdGUubm93KCk7XG5cbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBncmFwaHFsUXVlcnk8RmluZFNjZW5lc1Jlc3VsdD4oRklORF9TQ0VORVNfUVVFUlksIHtcbiAgICAgIGZpbHRlcjoge1xuICAgICAgICBwZXJfcGFnZTogLTEsXG4gICAgICAgIHNvcnQ6IFwicmF0aW5nXCIsXG4gICAgICAgIGRpcmVjdGlvbjogXCJERVNDXCIsXG4gICAgICB9LFxuICAgICAgc2NlbmVfZmlsdGVyOiBudWxsLFxuICAgIH0pO1xuXG4gICAgY29uc3Qgc2NlbmVzID0gcmVzdWx0LmZpbmRTY2VuZXMuc2NlbmVzIHx8IFtdO1xuICAgIGNvbnN0IGNvdW50ID0gcmVzdWx0LmZpbmRTY2VuZXMuY291bnQgfHwgc2NlbmVzLmxlbmd0aDtcbiAgICBjb25zdCBmZXRjaFRpbWUgPSBEYXRlLm5vdygpIC0gc3RhcnRUaW1lO1xuXG4gICAgY29uc3Qgb2xkQ291bnQgPSBzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXMgPyBzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXMubGVuZ3RoIDogMDtcbiAgICBpZiAoY291bnQgIT09IG9sZENvdW50KSB7XG4gICAgICBjb25zb2xlLmxvZyhcbiAgICAgICAgYFtTdGFzaCBCYXR0bGVdIPCfk4ogU2NlbmUgY291bnQgY2hhbmdlZDogJHtvbGRDb3VudH0g4oaSICR7Y291bnR9ICgke2NvdW50ID4gb2xkQ291bnQgPyBcIitcIiA6IFwiXCJ9JHtjb3VudCAtIG9sZENvdW50fSlgLFxuICAgICAgKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIPCfk4ogU2NlbmUgY291bnQgdW5jaGFuZ2VkOiAke2NvdW50fWApO1xuICAgIH1cblxuICAgIHN0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcyA9IHNjZW5lcztcbiAgICBzdGF0ZS5tZW1vcnlDYWNoZS50aW1lc3RhbXAgPSBEYXRlLm5vdygpO1xuICAgIGF3YWl0IHNldENhY2hlZFNjZW5lcyhjYWNoZUtleSwgc2NlbmVzLCBjb3VudCk7XG5cbiAgICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g4pyFIEJhY2tncm91bmQgcmVmcmVzaCBjb21wbGV0ZTogJHtzY2VuZXMubGVuZ3RofSBzY2VuZXMgaW4gJHtmZXRjaFRpbWV9bXNgKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnNvbGUuZXJyb3IoXCJbU3Rhc2ggQmF0dGxlXSDinYwgQmFja2dyb3VuZCByZWZyZXNoIGZhaWxlZDpcIiwgZSk7XG4gIH1cbn1cblxuLy8gR2V0IGFsbCBzY2VuZXMgKHVzZXMgY2FjaGUgd2l0aCBzdGFsZS13aGlsZS1yZXZhbGlkYXRlKVxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldEFsbFNjZW5lc0NhY2hlZCgpOiBQcm9taXNlPHsgc2NlbmVzOiBTY2VuZVtdOyBjb3VudDogbnVtYmVyIH0+IHtcbiAgY29uc3QgY2FjaGVLZXkgPSBcImFsbC1zY2VuZXNcIjtcblxuICAvLyBDaGVjayBtZW1vcnkgY2FjaGUgZmlyc3QgLSByZXR1cm4gaW1tZWRpYXRlbHkgaWYgYXZhaWxhYmxlXG4gIGlmIChzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXMpIHtcbiAgICBjb25zdCBjYWNoZUFnZSA9IE1hdGgucm91bmQoKERhdGUubm93KCkgLSAoc3RhdGUubWVtb3J5Q2FjaGUudGltZXN0YW1wID8/IDApKSAvIDEwMDApO1xuICAgIGNvbnN0IGlzU3RhbGUgPSBEYXRlLm5vdygpIC0gKHN0YXRlLm1lbW9yeUNhY2hlLnRpbWVzdGFtcCA/PyAwKSA+PSBDQUNIRV9NQVhfQUdFX01TO1xuXG4gICAgY29uc29sZS5sb2coXG4gICAgICBgW1N0YXNoIEJhdHRsZV0g8J+SviBNZW1vcnkgY2FjaGUgaGl0IChhbGwgc2NlbmVzKTogJHtzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXMubGVuZ3RofSBzY2VuZXMsIGFnZTogJHtjYWNoZUFnZX1zJHtpc1N0YWxlID8gXCIgW1NUQUxFXVwiIDogXCJcIn1gLFxuICAgICk7XG5cbiAgICBpZiAoaXNTdGFsZSkge1xuICAgICAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIOKPsCBDYWNoZSBzdGFsZSAoPiR7Q0FDSEVfTUFYX0FHRV9NUyAvIDEwMDB9cyksIHRyaWdnZXJpbmcgYmFja2dyb3VuZCByZWZyZXNoLi4uYCk7XG4gICAgICBiYWNrZ3JvdW5kUmVmcmVzaEFsbFNjZW5lcygpOyAvLyBEb24ndCBhd2FpdCAtIHJ1bnMgaW4gYmFja2dyb3VuZFxuICAgIH1cbiAgICByZXR1cm4geyBzY2VuZXM6IHN0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcywgY291bnQ6IHN0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcy5sZW5ndGggfTtcbiAgfVxuXG4gIC8vIENoZWNrIEluZGV4ZWREQiBjYWNoZSAtIHJldHVybiBpbW1lZGlhdGVseSBpZiBhdmFpbGFibGVcbiAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5SNIE1lbW9yeSBjYWNoZSBtaXNzLCBjaGVja2luZyBJbmRleGVkREIuLi5cIik7XG4gIGNvbnN0IGNhY2hlZCA9IGF3YWl0IGdldENhY2hlZFNjZW5lcyhjYWNoZUtleSk7XG4gIGlmIChjYWNoZWQpIHtcbiAgICBjb25zdCBjYWNoZUFnZSA9IE1hdGgucm91bmQoKERhdGUubm93KCkgLSBjYWNoZWQudGltZXN0YW1wKSAvIDEwMDApO1xuICAgIGNvbnN0IGlzU3RhbGUgPSBEYXRlLm5vdygpIC0gY2FjaGVkLnRpbWVzdGFtcCA+PSBDQUNIRV9NQVhfQUdFX01TO1xuXG4gICAgY29uc29sZS5sb2coXG4gICAgICBgW1N0YXNoIEJhdHRsZV0g8J+SvyBJbmRleGVkREIgY2FjaGUgaGl0IChhbGwgc2NlbmVzKTogJHtjYWNoZWQuc2NlbmVzLmxlbmd0aH0gc2NlbmVzLCBhZ2U6ICR7Y2FjaGVBZ2V9cyR7aXNTdGFsZSA/IFwiIFtTVEFMRV1cIiA6IFwiXCJ9YCxcbiAgICApO1xuXG4gICAgc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzID0gY2FjaGVkLnNjZW5lcztcbiAgICBzdGF0ZS5tZW1vcnlDYWNoZS50aW1lc3RhbXAgPSBjYWNoZWQudGltZXN0YW1wO1xuXG4gICAgaWYgKGlzU3RhbGUpIHtcbiAgICAgIGNvbnNvbGUubG9nKGBbU3Rhc2ggQmF0dGxlXSDij7AgQ2FjaGUgc3RhbGUgKD4ke0NBQ0hFX01BWF9BR0VfTVMgLyAxMDAwfXMpLCB0cmlnZ2VyaW5nIGJhY2tncm91bmQgcmVmcmVzaC4uLmApO1xuICAgICAgYmFja2dyb3VuZFJlZnJlc2hBbGxTY2VuZXMoKTsgLy8gRG9uJ3QgYXdhaXQgLSBydW5zIGluIGJhY2tncm91bmRcbiAgICB9XG4gICAgcmV0dXJuIHsgc2NlbmVzOiBjYWNoZWQuc2NlbmVzLCBjb3VudDogY2FjaGVkLmNvdW50IH07XG4gIH1cblxuICAvLyBObyBjYWNoZSBhdCBhbGwgLSBtdXN0IGZldGNoIGZyb20gbmV0d29yayAoYmxvY2tpbmcpXG4gIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+MkCBObyBjYWNoZSBmb3VuZCwgZmV0Y2hpbmcgYWxsIHNjZW5lcyBmcm9tIG5ldHdvcmsgKGZpcnN0IGxvYWQpLi4uXCIpO1xuICBjb25zdCBzdGFydFRpbWUgPSBEYXRlLm5vdygpO1xuXG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGdyYXBocWxRdWVyeTxGaW5kU2NlbmVzUmVzdWx0PihGSU5EX1NDRU5FU19RVUVSWSwge1xuICAgIGZpbHRlcjoge1xuICAgICAgcGVyX3BhZ2U6IC0xLFxuICAgICAgc29ydDogXCJyYXRpbmdcIixcbiAgICAgIGRpcmVjdGlvbjogXCJERVNDXCIsXG4gICAgfSxcbiAgICBzY2VuZV9maWx0ZXI6IG51bGwsXG4gIH0pO1xuXG4gIGNvbnN0IHNjZW5lcyA9IHJlc3VsdC5maW5kU2NlbmVzLnNjZW5lcyB8fCBbXTtcbiAgY29uc3QgY291bnQgPSByZXN1bHQuZmluZFNjZW5lcy5jb3VudCB8fCBzY2VuZXMubGVuZ3RoO1xuICBjb25zdCBmZXRjaFRpbWUgPSBEYXRlLm5vdygpIC0gc3RhcnRUaW1lO1xuXG4gIHN0YXRlLm1lbW9yeUNhY2hlLmFsbFNjZW5lcyA9IHNjZW5lcztcbiAgc3RhdGUubWVtb3J5Q2FjaGUudGltZXN0YW1wID0gRGF0ZS5ub3coKTtcbiAgYXdhaXQgc2V0Q2FjaGVkU2NlbmVzKGNhY2hlS2V5LCBzY2VuZXMsIGNvdW50KTtcblxuICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g4pyFIEZldGNoZWQgYW5kIGNhY2hlZCAke3NjZW5lcy5sZW5ndGh9IHNjZW5lcyBpbiAke2ZldGNoVGltZX1tc2ApO1xuICByZXR1cm4geyBzY2VuZXMsIGNvdW50IH07XG59XG5cbi8vIEJhY2tncm91bmQgcmVmcmVzaCBmb3IgZmlsdGVyZWQgc2NlbmVzXG5hc3luYyBmdW5jdGlvbiBiYWNrZ3JvdW5kUmVmcmVzaEZpbHRlcmVkU2NlbmVzKGZpbHRlcnM6IExpc3RGaWx0ZXJzKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGNhY2hlS2V5ID0gXCJmaWx0ZXJlZC1zY2VuZXNcIjtcblxuICB0cnkge1xuICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+UhCBCYWNrZ3JvdW5kIHJlZnJlc2ggc3RhcnRlZCAoZmlsdGVyZWQgc2NlbmVzKS4uLlwiKTtcbiAgICBjb25zdCBzdGFydFRpbWUgPSBEYXRlLm5vdygpO1xuXG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZ3JhcGhxbFF1ZXJ5PEZpbmRTY2VuZXNSZXN1bHQ+KEZJTkRfU0NFTkVTX1FVRVJZLCB7XG4gICAgICBmaWx0ZXI6IGdldEZpbmRGaWx0ZXIoe1xuICAgICAgICBwZXJfcGFnZTogLTEsXG4gICAgICAgIHNvcnQ6IFwicmF0aW5nXCIsXG4gICAgICAgIGRpcmVjdGlvbjogXCJERVNDXCIsXG4gICAgICB9KSxcbiAgICAgIHNjZW5lX2ZpbHRlcjogZmlsdGVycy5zY2VuZUZpbHRlcixcbiAgICB9KTtcblxuICAgIGNvbnN0IHNjZW5lcyA9IHJlc3VsdC5maW5kU2NlbmVzLnNjZW5lcyB8fCBbXTtcbiAgICBjb25zdCBjb3VudCA9IHJlc3VsdC5maW5kU2NlbmVzLmNvdW50IHx8IHNjZW5lcy5sZW5ndGg7XG4gICAgY29uc3QgZmV0Y2hUaW1lID0gRGF0ZS5ub3coKSAtIHN0YXJ0VGltZTtcblxuICAgIC8vIE9ubHkgdXBkYXRlIGlmIHN0aWxsIG9uIHNhbWUgZmlsdGVyXG4gICAgaWYgKHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcktleSA9PT0gZmlsdGVycy5maWx0ZXJLZXkpIHtcbiAgICAgIGNvbnN0IG9sZENvdW50ID0gc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXMgPyBzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJlZFNjZW5lcy5sZW5ndGggOiAwO1xuICAgICAgaWYgKGNvdW50ICE9PSBvbGRDb3VudCkge1xuICAgICAgICBjb25zb2xlLmxvZyhcbiAgICAgICAgICBgW1N0YXNoIEJhdHRsZV0g8J+TiiBGaWx0ZXJlZCBjb3VudCBjaGFuZ2VkOiAke29sZENvdW50fSDihpIgJHtjb3VudH0gKCR7Y291bnQgPiBvbGRDb3VudCA/IFwiK1wiIDogXCJcIn0ke2NvdW50IC0gb2xkQ291bnR9KWAsXG4gICAgICAgICk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g8J+TiiBGaWx0ZXJlZCBjb3VudCB1bmNoYW5nZWQ6ICR7Y291bnR9YCk7XG4gICAgICB9XG5cbiAgICAgIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzID0gc2NlbmVzO1xuICAgICAgc3RhdGUubWVtb3J5Q2FjaGUudGltZXN0YW1wID0gRGF0ZS5ub3coKTtcbiAgICAgIGF3YWl0IHNldENhY2hlZFNjZW5lcyhjYWNoZUtleSwgc2NlbmVzLCBjb3VudCwgZmlsdGVycy5maWx0ZXJLZXkpO1xuXG4gICAgICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g4pyFIEJhY2tncm91bmQgcmVmcmVzaCBjb21wbGV0ZTogJHtzY2VuZXMubGVuZ3RofSBmaWx0ZXJlZCBzY2VuZXMgaW4gJHtmZXRjaFRpbWV9bXNgKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDimqDvuI8gRmlsdGVyIGNoYW5nZWQgZHVyaW5nIHJlZnJlc2gsIGRpc2NhcmRpbmcgcmVzdWx0c1wiKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0g4p2MIEJhY2tncm91bmQgcmVmcmVzaCAoZmlsdGVyZWQpIGZhaWxlZDpcIiwgZSk7XG4gIH1cbn1cblxuLy8gR2V0IGZpbHRlcmVkIHNjZW5lcyAodXNlcyBjYWNoZSB3aXRoIHN0YWxlLXdoaWxlLXJldmFsaWRhdGUpXG4vLyBOT1RFOiBPbmx5IE9ORSBmaWx0ZXJlZCBjYWNoZSBpcyBrZXB0IChvdmVyd3JpdGVzIHByZXZpb3VzIGZpbHRlciBjYWNoZSB0byBwcmV2ZW50IEluZGV4ZWREQiBibG9hdClcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXRGaWx0ZXJlZFNjZW5lc0NhY2hlZChcbiAgZmlsdGVyczogTGlzdEZpbHRlcnMsXG4pOiBQcm9taXNlPHsgc2NlbmVzOiBTY2VuZVtdOyBjb3VudDogbnVtYmVyIH0+IHtcbiAgY29uc3QgeyBmaWx0ZXJLZXksIHNjZW5lRmlsdGVyIH0gPSBmaWx0ZXJzO1xuICBjb25zdCBjYWNoZUtleSA9IFwiZmlsdGVyZWQtc2NlbmVzXCI7IC8vIFNpbmdsZSBrZXkgLSBvdmVyd3JpdGVzIHByZXZpb3VzIGZpbHRlciBjYWNoZVxuXG4gIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+UjiBGaWx0ZXIgYWN0aXZlLCBjaGVja2luZyBmaWx0ZXJlZCBjYWNoZS4uLlwiKTtcblxuICAvLyBDaGVjayBtZW1vcnkgY2FjaGUgZmlyc3QgLSByZXR1cm4gaW1tZWRpYXRlbHkgaWYgYXZhaWxhYmxlIGFuZCBzYW1lIGZpbHRlclxuICBpZiAoc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXMgJiYgc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyS2V5ID09PSBmaWx0ZXJLZXkpIHtcbiAgICBjb25zdCBjYWNoZUFnZSA9IE1hdGgucm91bmQoKERhdGUubm93KCkgLSAoc3RhdGUubWVtb3J5Q2FjaGUudGltZXN0YW1wID8/IDApKSAvIDEwMDApO1xuICAgIGNvbnN0IGlzU3RhbGUgPSBEYXRlLm5vdygpIC0gKHN0YXRlLm1lbW9yeUNhY2hlLnRpbWVzdGFtcCA/PyAwKSA+PSBDQUNIRV9NQVhfQUdFX01TO1xuXG4gICAgY29uc29sZS5sb2coXG4gICAgICBgW1N0YXNoIEJhdHRsZV0g8J+SviBNZW1vcnkgY2FjaGUgaGl0IChmaWx0ZXJlZCk6ICR7c3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXMubGVuZ3RofSBzY2VuZXMsIGFnZTogJHtjYWNoZUFnZX1zJHtpc1N0YWxlID8gXCIgW1NUQUxFXVwiIDogXCJcIn1gLFxuICAgICk7XG5cbiAgICBpZiAoaXNTdGFsZSkge1xuICAgICAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIOKPsCBDYWNoZSBzdGFsZSAoPiR7Q0FDSEVfTUFYX0FHRV9NUyAvIDEwMDB9cyksIHRyaWdnZXJpbmcgYmFja2dyb3VuZCByZWZyZXNoLi4uYCk7XG4gICAgICBiYWNrZ3JvdW5kUmVmcmVzaEZpbHRlcmVkU2NlbmVzKGZpbHRlcnMpO1xuICAgIH1cbiAgICByZXR1cm4geyBzY2VuZXM6IHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzLCBjb3VudDogc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXMubGVuZ3RoIH07XG4gIH1cblxuICAvLyBDaGVjayBJbmRleGVkREIgY2FjaGUgKG9ubHkgaWYgZmlsdGVyIGtleSBtYXRjaGVzKVxuICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCflI0gTWVtb3J5IGNhY2hlIG1pc3MgKGZpbHRlcmVkKSwgY2hlY2tpbmcgSW5kZXhlZERCLi4uXCIpO1xuICBjb25zdCBjYWNoZWQgPSBhd2FpdCBnZXRDYWNoZWRTY2VuZXMoY2FjaGVLZXkpO1xuICBpZiAoY2FjaGVkICYmIGNhY2hlZC5maWx0ZXJLZXkgPT09IGZpbHRlcktleSkge1xuICAgIGNvbnN0IGNhY2hlQWdlID0gTWF0aC5yb3VuZCgoRGF0ZS5ub3coKSAtIGNhY2hlZC50aW1lc3RhbXApIC8gMTAwMCk7XG4gICAgY29uc3QgaXNTdGFsZSA9IERhdGUubm93KCkgLSBjYWNoZWQudGltZXN0YW1wID49IENBQ0hFX01BWF9BR0VfTVM7XG5cbiAgICBjb25zb2xlLmxvZyhcbiAgICAgIGBbU3Rhc2ggQmF0dGxlXSDwn5K/IEluZGV4ZWREQiBjYWNoZSBoaXQgKGZpbHRlcmVkKTogJHtjYWNoZWQuc2NlbmVzLmxlbmd0aH0gc2NlbmVzLCBhZ2U6ICR7Y2FjaGVBZ2V9cyR7aXNTdGFsZSA/IFwiIFtTVEFMRV1cIiA6IFwiXCJ9YCxcbiAgICApO1xuXG4gICAgc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXMgPSBjYWNoZWQuc2NlbmVzO1xuICAgIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcktleSA9IGZpbHRlcktleTtcbiAgICBzdGF0ZS5tZW1vcnlDYWNoZS50aW1lc3RhbXAgPSBjYWNoZWQudGltZXN0YW1wO1xuXG4gICAgaWYgKGlzU3RhbGUpIHtcbiAgICAgIGNvbnNvbGUubG9nKGBbU3Rhc2ggQmF0dGxlXSDij7AgQ2FjaGUgc3RhbGUgKD4ke0NBQ0hFX01BWF9BR0VfTVMgLyAxMDAwfXMpLCB0cmlnZ2VyaW5nIGJhY2tncm91bmQgcmVmcmVzaC4uLmApO1xuICAgICAgYmFja2dyb3VuZFJlZnJlc2hGaWx0ZXJlZFNjZW5lcyhmaWx0ZXJzKTtcbiAgICB9XG4gICAgcmV0dXJuIHsgc2NlbmVzOiBjYWNoZWQuc2NlbmVzLCBjb3VudDogY2FjaGVkLmNvdW50IH07XG4gIH1cblxuICBpZiAoY2FjaGVkKSB7XG4gICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5K/IEluZGV4ZWREQiBjYWNoZSBleGlzdHMgYnV0IGZpbHRlciBjaGFuZ2VkLCBmZXRjaGluZyBuZXcgZGF0YS4uLlwiKTtcbiAgfSBlbHNlIHtcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCfkr8gSW5kZXhlZERCIGNhY2hlIG1pc3MgKGZpbHRlcmVkKVwiKTtcbiAgfVxuXG4gIC8vIE5vIG1hdGNoaW5nIGNhY2hlIC0gbXVzdCBmZXRjaCBmcm9tIG5ldHdvcmsgKGJsb2NraW5nKVxuICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCfjJAgRmV0Y2hpbmcgZmlsdGVyZWQgc2NlbmVzIGZyb20gbmV0d29yay4uLlwiKTtcbiAgY29uc3Qgc3RhcnRUaW1lID0gRGF0ZS5ub3coKTtcblxuICBjb25zdCByZXN1bHQgPSBhd2FpdCBncmFwaHFsUXVlcnk8RmluZFNjZW5lc1Jlc3VsdD4oRklORF9TQ0VORVNfUVVFUlksIHtcbiAgICBmaWx0ZXI6IGdldEZpbmRGaWx0ZXIoe1xuICAgICAgcGVyX3BhZ2U6IC0xLFxuICAgICAgc29ydDogXCJyYXRpbmdcIixcbiAgICAgIGRpcmVjdGlvbjogXCJERVNDXCIsXG4gICAgfSksXG4gICAgc2NlbmVfZmlsdGVyOiBzY2VuZUZpbHRlcixcbiAgfSk7XG5cbiAgY29uc3Qgc2NlbmVzID0gcmVzdWx0LmZpbmRTY2VuZXMuc2NlbmVzIHx8IFtdO1xuICBjb25zdCBjb3VudCA9IHJlc3VsdC5maW5kU2NlbmVzLmNvdW50IHx8IHNjZW5lcy5sZW5ndGg7XG4gIGNvbnN0IGZldGNoVGltZSA9IERhdGUubm93KCkgLSBzdGFydFRpbWU7XG5cbiAgc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXMgPSBzY2VuZXM7XG4gIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcktleSA9IGZpbHRlcktleTtcbiAgc3RhdGUubWVtb3J5Q2FjaGUudGltZXN0YW1wID0gRGF0ZS5ub3coKTtcbiAgYXdhaXQgc2V0Q2FjaGVkU2NlbmVzKGNhY2hlS2V5LCBzY2VuZXMsIGNvdW50LCBmaWx0ZXJLZXkpO1xuXG4gIGNvbnNvbGUubG9nKGBbU3Rhc2ggQmF0dGxlXSDinIUgRmV0Y2hlZCBhbmQgY2FjaGVkICR7c2NlbmVzLmxlbmd0aH0gZmlsdGVyZWQgc2NlbmVzIGluICR7ZmV0Y2hUaW1lfW1zYCk7XG4gIHJldHVybiB7IHNjZW5lcywgY291bnQgfTtcbn1cblxuLy8gVXBkYXRlIGEgc2NlbmUncyByYXRpbmcgYW5kIHJlcG9zaXRpb24gaXQgaW4gdGhlIHNvcnRlZCBhcnJheSB0byBrZWVwIHJhbmtzIGFjY3VyYXRlXG5mdW5jdGlvbiByZXBvc2l0aW9uU2NlbmVJbkFycmF5KGFycjogU2NlbmVbXSwgc2NlbmVJZDogc3RyaW5nLCBuZXdSYXRpbmc6IG51bWJlcik6IGJvb2xlYW4ge1xuICBjb25zdCBpZHggPSBhcnIuZmluZEluZGV4KChzKSA9PiBzLmlkID09PSBzY2VuZUlkKTtcbiAgaWYgKGlkeCA9PT0gLTEpIHJldHVybiBmYWxzZTtcblxuICBjb25zdCBzY2VuZSA9IGFycltpZHhdO1xuICBzY2VuZS5yYXRpbmcxMDAgPSBuZXdSYXRpbmc7XG5cbiAgLy8gUmVtb3ZlIGZyb20gY3VycmVudCBwb3NpdGlvblxuICBhcnIuc3BsaWNlKGlkeCwgMSk7XG5cbiAgLy8gRmluZCBjb3JyZWN0IHBvc2l0aW9uIChhcnJheSBpcyBzb3J0ZWQgYnkgcmF0aW5nIERFU0MpXG4gIGNvbnN0IG5ld0lkeCA9IGFyci5maW5kSW5kZXgoKHMpID0+IChzLnJhdGluZzEwMCB8fCAwKSA8IG5ld1JhdGluZyk7XG5cbiAgaWYgKG5ld0lkeCA9PT0gLTEpIHtcbiAgICBhcnIucHVzaChzY2VuZSk7IC8vIExvd2VzdCByYXRlZCwgZ29lcyBhdCBlbmRcbiAgfSBlbHNlIHtcbiAgICBhcnIuc3BsaWNlKG5ld0lkeCwgMCwgc2NlbmUpO1xuICB9XG5cbiAgcmV0dXJuIHRydWU7XG59XG5cbi8vIENsZWFyIGEgc2NlbmUncyByYXRpbmcgaW4gdGhlIG1lbW9yeSBjYWNoZSBhbmQgbW92ZSBpdCB0byB0aGUgYm90dG9tIG9mIHRoZSBzb3J0ZWQgcG9vbFxuZXhwb3J0IGZ1bmN0aW9uIGNsZWFyU2NlbmVJbkNhY2hlKHNjZW5lSWQ6IHN0cmluZyk6IHZvaWQge1xuICBpZiAoc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzKSB7XG4gICAgY29uc3QgaWR4ID0gc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzLmZpbmRJbmRleCgocykgPT4gcy5pZCA9PT0gc2NlbmVJZCk7XG4gICAgaWYgKGlkeCAhPT0gLTEpIHtcbiAgICAgIGNvbnN0IHNjZW5lID0gc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzW2lkeF07XG4gICAgICBzY2VuZS5yYXRpbmcxMDAgPSBudWxsO1xuICAgICAgc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzLnNwbGljZShpZHgsIDEpO1xuICAgICAgc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzLnB1c2goc2NlbmUpO1xuICAgICAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIPCfk50gQ2xlYXJlZCBzY2VuZSAke3NjZW5lSWR9IHJhdGluZyBpbiBtZW1vcnkgY2FjaGVgKTtcbiAgICB9XG4gIH1cblxuICBpZiAoc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXMpIHtcbiAgICBjb25zdCBzY2VuZSA9IHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzLmZpbmQoKHMpID0+IHMuaWQgPT09IHNjZW5lSWQpO1xuICAgIGlmIChzY2VuZSkge1xuICAgICAgc2NlbmUucmF0aW5nMTAwID0gbnVsbDtcbiAgICB9XG4gIH1cbn1cblxuLy8gVXBkYXRlIGEgc2NlbmUncyByYXRpbmcgaW4gdGhlIG1lbW9yeSBjYWNoZSAoa2VlcHMgY2FjaGUgaW4gc3luYyBhZnRlciByYXRpbmcgY2hhbmdlcylcbmV4cG9ydCBmdW5jdGlvbiB1cGRhdGVTY2VuZUluQ2FjaGUoc2NlbmVJZDogc3RyaW5nLCBuZXdSYXRpbmc6IG51bWJlcik6IHZvaWQge1xuICAvLyBSZXBvc2l0aW9uIGluIGFsbFNjZW5lcyAoa2VlcHMgcmFua2luZ3MgYWNjdXJhdGUsIHNjZW5lIHN0YXlzIGZvciBvcHBvbmVudCBwb29sKVxuICBpZiAoc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzKSB7XG4gICAgcmVwb3NpdGlvblNjZW5lSW5BcnJheShzdGF0ZS5tZW1vcnlDYWNoZS5hbGxTY2VuZXMsIHNjZW5lSWQsIG5ld1JhdGluZyk7XG4gICAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIPCfk50gVXBkYXRlZCBzY2VuZSAke3NjZW5lSWR9IHJhdGluZyB0byAke25ld1JhdGluZ30gaW4gbWVtb3J5IGNhY2hlYCk7XG4gIH1cblxuICAvLyBBbHNvIHVwZGF0ZSByYXRpbmcgaW4gZmlsdGVyZWRTY2VuZXMgaWYgcHJlc2VudCAocmVtb3ZhbCBmcm9tIHRoZSBsZWZ0LXNpZGUgcG9vbCBpcyBzZXBhcmF0ZSlcbiAgaWYgKHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzKSB7XG4gICAgY29uc3Qgc2NlbmUgPSBzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJlZFNjZW5lcy5maW5kKChzKSA9PiBzLmlkID09PSBzY2VuZUlkKTtcbiAgICBpZiAoc2NlbmUpIHtcbiAgICAgIHNjZW5lLnJhdGluZzEwMCA9IG5ld1JhdGluZztcbiAgICB9XG4gIH1cbn1cblxuLy8gUmVtb3ZlIGEgc2NlbmUgZnJvbSB0aGUgZmlsdGVyZWQgcG9vbCAoY2FsbGVkIGFmdGVyIGJhdHRsZSByZWdhcmRsZXNzIG9mIHJhdGluZyBjaGFuZ2UpXG5leHBvcnQgZnVuY3Rpb24gcmVtb3ZlRnJvbUZpbHRlcmVkUG9vbChzY2VuZUlkOiBzdHJpbmcpOiB2b2lkIHtcbiAgLy8gVHJhY2sgcmVtb3ZhbCAtIHN1cnZpdmVzIGJhY2tncm91bmQgcmVmcmVzaCByYWNlIGNvbmRpdGlvblxuICBzdGF0ZS5yZW1vdmVkU2NlbmVJZHMuYWRkKHNjZW5lSWQpO1xuXG4gIGlmIChzdGF0ZS5tZW1vcnlDYWNoZS5maWx0ZXJlZFNjZW5lcykge1xuICAgIGNvbnN0IGlkeCA9IHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzLmZpbmRJbmRleCgocykgPT4gcy5pZCA9PT0gc2NlbmVJZCk7XG4gICAgaWYgKGlkeCAhPT0gLTEpIHtcbiAgICAgIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcmVkU2NlbmVzLnNwbGljZShpZHgsIDEpO1xuICAgICAgY29uc29sZS5sb2coXG4gICAgICAgIGBbU3Rhc2ggQmF0dGxlXSDwn5eR77iPIFJlbW92ZWQgc2NlbmUgJHtzY2VuZUlkfSBmcm9tIGZpbHRlcmVkIHBvb2wgKCR7c3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXMubGVuZ3RofSByZW1haW5pbmcsICR7c3RhdGUucmVtb3ZlZFNjZW5lSWRzLnNpemV9IHJlbW92ZWQgdGhpcyBzZXNzaW9uKWAsXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IHNodWZmbGVJZHggPSBzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzLmZpbmRJbmRleCgocykgPT4gcy5pZCA9PT0gc2NlbmVJZCk7XG4gIGlmIChzaHVmZmxlSWR4ICE9PSAtMSkge1xuICAgIHN0YXRlLnNodWZmbGVkRmlsdGVyZWRTY2VuZXMuc3BsaWNlKHNodWZmbGVJZHgsIDEpO1xuICAgIGlmIChzaHVmZmxlSWR4IDwgc3RhdGUuc2h1ZmZsZUluZGV4KSB7XG4gICAgICBzdGF0ZS5zaHVmZmxlSW5kZXgtLTtcbiAgICB9XG4gIH1cbn1cbiIsICIvLyBQZXJzaXN0L3Jlc3RvcmUgdGhlIGJhdHRsZSBzZXNzaW9uIHRvIGxvY2FsU3RvcmFnZS5cclxuXHJcbmltcG9ydCB7IFNUT1JBR0VfS0VZIH0gZnJvbSBcIi4vY29uc3RhbnRzXCI7XHJcbmltcG9ydCB7IHN0YXRlIH0gZnJvbSBcIi4vc3RhdGVcIjtcclxuaW1wb3J0IHR5cGUgeyBNb2RlLCBQYWlyLCBSYW5rcywgU2NlbmUgfSBmcm9tIFwiLi90eXBlc1wiO1xyXG5cclxuaW50ZXJmYWNlIFBlcnNpc3RlZFN0YXRlIHtcclxuICBjdXJyZW50UGFpcj86IFBhaXI7XHJcbiAgY3VycmVudFJhbmtzPzogUmFua3M7XHJcbiAgY3VycmVudE1vZGU/OiBNb2RlO1xyXG4gIGdhdW50bGV0Q2xpbWJlcj86IFNjZW5lIHwgbnVsbDtcclxuICBnYXVudGxldFdpbnM/OiBudW1iZXI7XHJcbiAgZ2F1bnRsZXRDbGltYmVyUmFuaz86IG51bWJlcjtcclxuICBnYXVudGxldERlZmVhdGVkPzogc3RyaW5nW107XHJcbiAgZ2F1bnRsZXRGYWxsaW5nPzogYm9vbGVhbjtcclxuICBnYXVudGxldEZhbGxpbmdTY2VuZT86IFNjZW5lIHwgbnVsbDtcclxuICB0b3RhbFNjZW5lc0NvdW50PzogbnVtYmVyO1xyXG4gIHNhdmVkRmlsdGVyUGFyYW1zPzogc3RyaW5nO1xyXG4gIC8qKiBAZGVwcmVjYXRlZCBSZW5hbWVkIHRvIGdhdW50bGV0Q2xpbWJlciAqL1xyXG4gIGdhdW50bGV0Q2hhbXBpb24/OiBTY2VuZSB8IG51bGw7XHJcbiAgLyoqIEBkZXByZWNhdGVkIFJlbmFtZWQgdG8gZ2F1bnRsZXRDbGltYmVyUmFuayAqL1xyXG4gIGdhdW50bGV0Q2hhbXBpb25SYW5rPzogbnVtYmVyO1xyXG59XHJcblxyXG4vKiogU2F2ZXMgdGhlIGN1cnJlbnQgYmF0dGxlIHNlc3Npb24gdG8gbG9jYWxTdG9yYWdlLiAqL1xyXG5leHBvcnQgZnVuY3Rpb24gc2F2ZVN0YXRlKCk6IHZvaWQge1xyXG4gIGNvbnN0IHNuYXBzaG90OiBQZXJzaXN0ZWRTdGF0ZSA9IHtcclxuICAgIGN1cnJlbnRQYWlyOiBzdGF0ZS5jdXJyZW50UGFpcixcclxuICAgIGN1cnJlbnRSYW5rczogc3RhdGUuY3VycmVudFJhbmtzLFxyXG4gICAgY3VycmVudE1vZGU6IHN0YXRlLmN1cnJlbnRNb2RlLFxyXG4gICAgZ2F1bnRsZXRDbGltYmVyOiBzdGF0ZS5nYXVudGxldENsaW1iZXIsXHJcbiAgICBnYXVudGxldFdpbnM6IHN0YXRlLmdhdW50bGV0V2lucyxcclxuICAgIGdhdW50bGV0Q2xpbWJlclJhbms6IHN0YXRlLmdhdW50bGV0Q2xpbWJlclJhbmssXHJcbiAgICBnYXVudGxldERlZmVhdGVkOiBzdGF0ZS5nYXVudGxldERlZmVhdGVkLFxyXG4gICAgZ2F1bnRsZXRGYWxsaW5nOiBzdGF0ZS5nYXVudGxldEZhbGxpbmcsXHJcbiAgICBnYXVudGxldEZhbGxpbmdTY2VuZTogc3RhdGUuZ2F1bnRsZXRGYWxsaW5nU2NlbmUsXHJcbiAgICB0b3RhbFNjZW5lc0NvdW50OiBzdGF0ZS50b3RhbFNjZW5lc0NvdW50LFxyXG4gICAgc2F2ZWRGaWx0ZXJQYXJhbXM6IHdpbmRvdy5sb2NhdGlvbi5zZWFyY2gsXHJcbiAgfTtcclxuICB0cnkge1xyXG4gICAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oU1RPUkFHRV9LRVksIEpTT04uc3RyaW5naWZ5KHNuYXBzaG90KSk7XHJcbiAgfSBjYXRjaCAoZSkge1xyXG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIEZhaWxlZCB0byBzYXZlIHN0YXRlOlwiLCBlKTtcclxuICB9XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBsb2FkU3RhdGUoKTogYm9vbGVhbiB7XHJcbiAgdHJ5IHtcclxuICAgIGNvbnN0IHNhdmVkID0gbG9jYWxTdG9yYWdlLmdldEl0ZW0oU1RPUkFHRV9LRVkpO1xyXG4gICAgaWYgKHNhdmVkKSB7XHJcbiAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2Uoc2F2ZWQpIGFzIFBlcnNpc3RlZFN0YXRlO1xyXG4gICAgICBzdGF0ZS5jdXJyZW50UGFpciA9IHBhcnNlZC5jdXJyZW50UGFpciB8fCB7IGxlZnQ6IG51bGwsIHJpZ2h0OiBudWxsIH07XHJcbiAgICAgIHN0YXRlLmN1cnJlbnRSYW5rcyA9IHBhcnNlZC5jdXJyZW50UmFua3MgfHwgeyBsZWZ0OiBudWxsLCByaWdodDogbnVsbCB9O1xyXG4gICAgICBzdGF0ZS5jdXJyZW50TW9kZSA9IHBhcnNlZC5jdXJyZW50TW9kZSB8fCBcInN3aXNzXCI7XHJcbiAgICAgIHN0YXRlLmdhdW50bGV0Q2xpbWJlciA9IHBhcnNlZC5nYXVudGxldENsaW1iZXIgPz8gcGFyc2VkLmdhdW50bGV0Q2hhbXBpb24gPz8gbnVsbDtcclxuICAgICAgc3RhdGUuZ2F1bnRsZXRXaW5zID0gcGFyc2VkLmdhdW50bGV0V2lucyB8fCAwO1xyXG4gICAgICBzdGF0ZS5nYXVudGxldENsaW1iZXJSYW5rID0gcGFyc2VkLmdhdW50bGV0Q2xpbWJlclJhbmsgPz8gcGFyc2VkLmdhdW50bGV0Q2hhbXBpb25SYW5rID8/IDA7XHJcbiAgICAgIHN0YXRlLmdhdW50bGV0RGVmZWF0ZWQgPSBwYXJzZWQuZ2F1bnRsZXREZWZlYXRlZCB8fCBbXTtcclxuICAgICAgc3RhdGUuZ2F1bnRsZXRGYWxsaW5nID0gcGFyc2VkLmdhdW50bGV0RmFsbGluZyB8fCBmYWxzZTtcclxuICAgICAgc3RhdGUuZ2F1bnRsZXRGYWxsaW5nU2NlbmUgPSBwYXJzZWQuZ2F1bnRsZXRGYWxsaW5nU2NlbmUgfHwgbnVsbDtcclxuICAgICAgc3RhdGUudG90YWxTY2VuZXNDb3VudCA9IHBhcnNlZC50b3RhbFNjZW5lc0NvdW50IHx8IDA7XHJcbiAgICAgIHN0YXRlLnNhdmVkRmlsdGVyUGFyYW1zID0gcGFyc2VkLnNhdmVkRmlsdGVyUGFyYW1zIHx8IFwiXCI7XHJcbiAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgfVxyXG4gIH0gY2F0Y2ggKGUpIHtcclxuICAgIGNvbnNvbGUuZXJyb3IoXCJbU3Rhc2ggQmF0dGxlXSBGYWlsZWQgdG8gbG9hZCBzdGF0ZTpcIiwgZSk7XHJcbiAgfVxyXG4gIHJldHVybiBmYWxzZTtcclxufVxyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGNsZWFyU3RhdGUoKTogdm9pZCB7XHJcbiAgdHJ5IHtcclxuICAgIGxvY2FsU3RvcmFnZS5yZW1vdmVJdGVtKFNUT1JBR0VfS0VZKTtcclxuICB9IGNhdGNoIChlKSB7XHJcbiAgICBjb25zb2xlLmVycm9yKFwiW1N0YXNoIEJhdHRsZV0gRmFpbGVkIHRvIGNsZWFyIHN0YXRlOlwiLCBlKTtcclxuICB9XHJcbn1cclxuIiwgIi8vIEVMTyByYXRpbmcgbG9naWMgKHB1cmUgY2FsY3VsYXRpb25zIOKAlCBjYWxsZXJzIGFwcGx5IHJlc3VsdHMgYW5kIHBlcnNpc3QpLlxuXG5pbXBvcnQgdHlwZSB7IENvbXBhcmlzb25EZWx0YXMsIENvbXBhcmlzb25JbnB1dCB9IGZyb20gXCIuL3R5cGVzXCI7XG5cbmNvbnN0IE1JTl9SQVRJTkcgPSAxO1xuY29uc3QgTUFYX1JBVElORyA9IDEwMDtcblxuLy8gRHluYW1pYyBLLWZhY3RvciBiYXNlZCBvbiBwbGF5X2NvdW50IChzaW1pbGFyIHRvIGNoZXNzIEVMTyBmb3IgbmV3IHZzIGVzdGFibGlzaGVkIHBsYXllcnMpXG5leHBvcnQgZnVuY3Rpb24gZ2V0S0ZhY3RvcihwbGF5Q291bnQ6IG51bWJlcik6IG51bWJlciB7XG4gIGlmIChwbGF5Q291bnQgPCAzKSByZXR1cm4gMTI7XG4gIGlmIChwbGF5Q291bnQgPCA4KSByZXR1cm4gODtcbiAgaWYgKHBsYXlDb3VudCA8IDE1KSByZXR1cm4gNjtcbiAgcmV0dXJuIDQ7XG59XG5cbmZ1bmN0aW9uIGNsYW1wUmF0aW5nKHJhdGluZzogbnVtYmVyKTogbnVtYmVyIHtcbiAgcmV0dXJuIE1hdGgubWluKE1BWF9SQVRJTkcsIE1hdGgubWF4KE1JTl9SQVRJTkcsIHJhdGluZykpO1xufVxuXG5mdW5jdGlvbiBleHBlY3RlZFNjb3JlKHJhdGluZ0E6IG51bWJlciwgcmF0aW5nQjogbnVtYmVyKTogbnVtYmVyIHtcbiAgY29uc3QgcmF0aW5nRGlmZiA9IHJhdGluZ0IgLSByYXRpbmdBO1xuICByZXR1cm4gMSAvICgxICsgTWF0aC5wb3coMTAsIHJhdGluZ0RpZmYgLyA0MCkpO1xufVxuXG4vKiogU3RhbmRhcmQgdHdvLXNpZGVkIEVMTyBmb3IgYSBoZWFkLXRvLWhlYWQgd2luLiBSZXR1cm5zIGVmZmVjdGl2ZSBkZWx0YXMgKHBvc3QtY2xhbXApLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNhbGN1bGF0ZVJhdGluZ0NoYW5nZXMoaW5wdXQ6IENvbXBhcmlzb25JbnB1dCk6IENvbXBhcmlzb25EZWx0YXMge1xuICBjb25zdCB7IHdpbm5lciwgbG9zZXIgfSA9IGlucHV0O1xuXG4gIGNvbnN0IGV4cGVjdGVkID0gZXhwZWN0ZWRTY29yZSh3aW5uZXIucmF0aW5nLCBsb3Nlci5yYXRpbmcpO1xuICBjb25zdCB3aW5uZXJDaGFuZ2UgPSBNYXRoLm1heCgxLCBNYXRoLnJvdW5kKGdldEtGYWN0b3Iod2lubmVyLnBsYXlDb3VudCkgKiAoMSAtIGV4cGVjdGVkKSkpO1xuICBjb25zdCBsb3NlckNoYW5nZSA9IC1NYXRoLm1heCgxLCBNYXRoLnJvdW5kKGdldEtGYWN0b3IobG9zZXIucGxheUNvdW50KSAqIGV4cGVjdGVkKSk7XG5cbiAgY29uc3Qgd2lubmVyTmV3ID0gY2xhbXBSYXRpbmcod2lubmVyLnJhdGluZyArIHdpbm5lckNoYW5nZSk7XG4gIGNvbnN0IGxvc2VyTmV3ID0gY2xhbXBSYXRpbmcobG9zZXIucmF0aW5nICsgbG9zZXJDaGFuZ2UpO1xuXG4gIHJldHVybiB7XG4gICAgd2lubmVyOiB3aW5uZXJOZXcgLSB3aW5uZXIucmF0aW5nLFxuICAgIGxvc2VyOiBsb3Nlck5ldyAtIGxvc2VyLnJhdGluZyxcbiAgfTtcbn1cbiIsICIvLyBTUEEgbmF2aWdhdGlvbiBoZWxwZXJzLlxyXG5cclxuaW1wb3J0IHsgY2xvc2VNb2RhbCB9IGZyb20gXCIuL3VpL21vZGFsXCI7XHJcblxyXG4vLyBOYXZpZ2F0ZSB1c2luZyBSZWFjdCBSb3V0ZXIgKHByZXNlcnZlcyBKUyBzdGF0ZSlcclxuZXhwb3J0IGZ1bmN0aW9uIG5hdmlnYXRlVG9VcmwodXJsOiBzdHJpbmcpOiB2b2lkIHtcclxuICBjbG9zZU1vZGFsKCk7XHJcblxyXG4gIC8vIFVzZSBIaXN0b3J5IEFQSSArIHBvcHN0YXRlIGV2ZW50IHRvIHRyaWdnZXIgUmVhY3QgUm91dGVyIG5hdmlnYXRpb25cclxuICBjb25zdCBwYXRoID0gdXJsLnN0YXJ0c1dpdGgoXCIvXCIpID8gdXJsIDogbmV3IFVSTCh1cmwpLnBhdGhuYW1lICsgbmV3IFVSTCh1cmwpLnNlYXJjaDtcclxuICB3aW5kb3cuaGlzdG9yeS5wdXNoU3RhdGUoe30sIFwiXCIsIHBhdGgpO1xyXG4gIHdpbmRvdy5kaXNwYXRjaEV2ZW50KG5ldyBQb3BTdGF0ZUV2ZW50KFwicG9wc3RhdGVcIiwgeyBzdGF0ZToge30gfSkpO1xyXG59XHJcbiIsICIvLyBQZXJzaXN0IHNjZW5lIHJhdGluZ3MgdG8gU3Rhc2ggYW5kIGtlZXAgdGhlIGxvY2FsIGNhY2hlIGluIHN5bmMuXG5cbmltcG9ydCB7IGNsZWFyU2NlbmVJbkNhY2hlLCB1cGRhdGVTY2VuZUluQ2FjaGUgfSBmcm9tIFwiLi9jYWNoZVwiO1xuaW1wb3J0IHsgZ3JhcGhxbFF1ZXJ5IH0gZnJvbSBcIi4vZ3JhcGhxbFwiO1xuXG5jb25zdCBTQ0VORV9VUERBVEVfTVVUQVRJT04gPSBgXG4gICAgICBtdXRhdGlvbiBTY2VuZVVwZGF0ZSgkaW5wdXQ6IFNjZW5lVXBkYXRlSW5wdXQhKSB7XG4gICAgICAgIHNjZW5lVXBkYXRlKGlucHV0OiAkaW5wdXQpIHtcbiAgICAgICAgICBpZFxuICAgICAgICAgIHJhdGluZzEwMFxuICAgICAgICB9XG4gICAgICB9XG4gICAgYDtcblxuLyoqIFdyaXRlIHJhdGluZyB0byBTdGFzaCAobnVsbCBjbGVhcnMpIGFuZCBzeW5jIHRoZSBpbi1tZW1vcnkgY2FjaGUuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gdXBkYXRlU2NlbmVSYXRpbmcoc2NlbmVJZDogc3RyaW5nLCByYXRpbmcxMDA6IG51bWJlciB8IG51bGwpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3Qgc3Rhc2hSYXRpbmcgPVxuICAgIHJhdGluZzEwMCA9PT0gbnVsbCA/IG51bGwgOiBNYXRoLm1heCgxLCBNYXRoLm1pbigxMDAsIHJhdGluZzEwMCkpO1xuXG4gIHRyeSB7XG4gICAgYXdhaXQgZ3JhcGhxbFF1ZXJ5KFNDRU5FX1VQREFURV9NVVRBVElPTiwge1xuICAgICAgaW5wdXQ6IHtcbiAgICAgICAgaWQ6IHNjZW5lSWQsXG4gICAgICAgIHJhdGluZzEwMDogc3Rhc2hSYXRpbmcsXG4gICAgICB9LFxuICAgIH0pO1xuXG4gICAgaWYgKHN0YXNoUmF0aW5nID09PSBudWxsKSB7XG4gICAgICBjb25zb2xlLmxvZyhgW1N0YXNoIEJhdHRsZV0g8J+TnSBDbGVhcmVkIHNjZW5lICR7c2NlbmVJZH0gcmF0aW5nIGluIFN0YXNoYCk7XG4gICAgICBjbGVhclNjZW5lSW5DYWNoZShzY2VuZUlkKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIPCfk50gVXBkYXRlZCBzY2VuZSAke3NjZW5lSWR9IHJhdGluZyB0byAke3N0YXNoUmF0aW5nfSBpbiBTdGFzaGApO1xuICAgICAgdXBkYXRlU2NlbmVJbkNhY2hlKHNjZW5lSWQsIHN0YXNoUmF0aW5nKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zdCBhY3Rpb24gPSBzdGFzaFJhdGluZyA9PT0gbnVsbCA/IFwiY2xlYXJcIiA6IFwidXBkYXRlXCI7XG4gICAgY29uc29sZS5lcnJvcihgW1N0YXNoIEJhdHRsZV0gRmFpbGVkIHRvICR7YWN0aW9ufSBzY2VuZSAke3NjZW5lSWR9IHJhdGluZzpgLCBlKTtcbiAgfVxufVxuIiwgIi8vIE1hdGNobWFraW5nOiBidWlsZCB0aGUgc2NlbmUgcGFpcnMgZm9yIGVhY2ggY29tcGFyaXNvbiBtb2RlLlxuXG5pbXBvcnQgeyBjbGVhckZpbHRlcmVkQ2FjaGUsIGdldEFsbFNjZW5lc0NhY2hlZCwgZ2V0RmlsdGVyZWRTY2VuZXNDYWNoZWQgfSBmcm9tIFwiLi9jYWNoZVwiO1xuaW1wb3J0IHsgQ0xJTUJfT1BQT05FTlRfUElDS19XSU5ET1csIFNXSVNTX09QUE9ORU5UX1JFQUNIX0lOSVRJQUwsIFNXSVNTX09QUE9ORU5UX1JFQUNIX01VTFRJUExJRVIgfSBmcm9tIFwiLi9jb25zdGFudHNcIjtcbmltcG9ydCB7IHJlYWRGaWx0ZXJzLCB0eXBlIExpc3RGaWx0ZXJzIH0gZnJvbSBcIi4vZmlsdGVyc1wiO1xuaW1wb3J0IHsgdXBkYXRlU2NlbmVSYXRpbmcgfSBmcm9tIFwiLi9yYXRpbmdcIjtcbmltcG9ydCB7IHN0YXRlIH0gZnJvbSBcIi4vc3RhdGVcIjtcbmltcG9ydCB0eXBlIHtcbiAgQ2hhbXBpb25QYWlyUmVzdWx0LFxuICBHYXVudGxldFBhaXJSZXN1bHQsXG4gIFJhbmssXG4gIFNjZW5lLFxuICBTd2lzc1BhaXJSZXN1bHQsXG59IGZyb20gXCIuL3R5cGVzXCI7XG5cbmZ1bmN0aW9uIHNodWZmbGVBcnJheTxUPihhcnJheTogVFtdKTogVFtdIHtcbiAgY29uc3Qgc2h1ZmZsZWQgPSBbLi4uYXJyYXldO1xuICBmb3IgKGxldCBpID0gc2h1ZmZsZWQubGVuZ3RoIC0gMTsgaSA+IDA7IGktLSkge1xuICAgIGNvbnN0IGogPSBNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkgKiAoaSArIDEpKTtcbiAgICBbc2h1ZmZsZWRbaV0sIHNodWZmbGVkW2pdXSA9IFtzaHVmZmxlZFtqXSwgc2h1ZmZsZWRbaV1dO1xuICB9XG4gIHJldHVybiBzaHVmZmxlZDtcbn1cblxuLy8gVHJhY2sgbGFzdCBzY2VuZSB0byBhdm9pZCBpbW1lZGlhdGUgcmVwZWF0IGFmdGVyIHJlc2h1ZmZsZVxubGV0IGxhc3RTaG93blNjZW5lSWQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuXG4vKiogTmV4dCBsZWZ0LXNpZGUgc2NlbmUgZnJvbSB0aGUgc2h1ZmZsZWQgbGVmdCBwb29sIChubyBuZXR3b3JrIGZldGNoKS4gKi9cbmZ1bmN0aW9uIGdldE5leHRGaWx0ZXJlZFNjZW5lKGxlZnRQb29sOiBTY2VuZVtdLCBmaWx0ZXJLZXk6IHN0cmluZyk6IFNjZW5lIHwgbnVsbCB7XG4gIGlmIChzdGF0ZS5zaHVmZmxlRmlsdGVyS2V5ICE9PSBudWxsICYmIGZpbHRlcktleSAhPT0gc3RhdGUuc2h1ZmZsZUZpbHRlcktleSkge1xuICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+UgCBGaWx0ZXIgY2hhbmdlZCwgcmVzZXR0aW5nIHJlbW92ZWQgc2NlbmVzIHRyYWNraW5nXCIpO1xuICAgIHN0YXRlLnJlbW92ZWRTY2VuZUlkcy5jbGVhcigpO1xuICB9XG5cbiAgY29uc3QgYXZhaWxhYmxlU2NlbmVzID0gbGVmdFBvb2wuZmlsdGVyKChzKSA9PiAhc3RhdGUucmVtb3ZlZFNjZW5lSWRzLmhhcyhzLmlkKSk7XG5cbiAgaWYgKGF2YWlsYWJsZVNjZW5lcy5sZW5ndGggPT09IDApIHtcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCfj4EgRmlsdGVyZWQgcG9vbCBleGhhdXN0ZWQgLSBhbGwgc2NlbmVzIHJhdGVkIVwiKTtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIGlmIChmaWx0ZXJLZXkgIT09IHN0YXRlLnNodWZmbGVGaWx0ZXJLZXkgfHwgc3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lcy5sZW5ndGggPT09IDApIHtcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCflIAgU2h1ZmZsaW5nIGZpbHRlcmVkIHNjZW5lcyAoZmlsdGVyIGNoYW5nZWQgb3IgZmlyc3QgbG9hZClcIik7XG4gICAgc3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lcyA9IHNodWZmbGVBcnJheShhdmFpbGFibGVTY2VuZXMpO1xuICAgIHN0YXRlLnNodWZmbGVJbmRleCA9IDA7XG4gICAgc3RhdGUuc2h1ZmZsZUZpbHRlcktleSA9IGZpbHRlcktleTtcbiAgICBsYXN0U2hvd25TY2VuZUlkID0gbnVsbDtcbiAgfVxuXG4gIGlmIChzdGF0ZS5zaHVmZmxlSW5kZXggPj0gc3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lcy5sZW5ndGgpIHtcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCflIAgUmVzaHVmZmxpbmcgKGNvbXBsZXRlZCBmdWxsIGN5Y2xlKVwiKTtcbiAgICBzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzID0gc2h1ZmZsZUFycmF5KGF2YWlsYWJsZVNjZW5lcyk7XG4gICAgc3RhdGUuc2h1ZmZsZUluZGV4ID0gMDtcblxuICAgIGlmIChcbiAgICAgIGxhc3RTaG93blNjZW5lSWQgJiZcbiAgICAgIHN0YXRlLnNodWZmbGVkRmlsdGVyZWRTY2VuZXMubGVuZ3RoID4gMSAmJlxuICAgICAgc3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lc1swXS5pZCA9PT0gbGFzdFNob3duU2NlbmVJZFxuICAgICkge1xuICAgICAgY29uc3Qgc3dhcElkeCA9IDEgKyBNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkgKiAoc3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lcy5sZW5ndGggLSAxKSk7XG4gICAgICBbc3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lc1swXSwgc3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lc1tzd2FwSWR4XV0gPSBbXG4gICAgICAgIHN0YXRlLnNodWZmbGVkRmlsdGVyZWRTY2VuZXNbc3dhcElkeF0sXG4gICAgICAgIHN0YXRlLnNodWZmbGVkRmlsdGVyZWRTY2VuZXNbMF0sXG4gICAgICBdO1xuICAgICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5SEIFN3YXBwZWQgZmlyc3Qgc2NlbmUgdG8gYXZvaWQgcmVwZWF0XCIpO1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IHNjZW5lID0gc3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lc1tzdGF0ZS5zaHVmZmxlSW5kZXhdO1xuICBzdGF0ZS5zaHVmZmxlSW5kZXgrKztcbiAgbGFzdFNob3duU2NlbmVJZCA9IHNjZW5lLmlkO1xuICBjb25zb2xlLmxvZyhcbiAgICBgW1N0YXNoIEJhdHRsZV0g8J+TjSBQaWNrZWQgc2NlbmUgJHtzY2VuZS5pZH0gKCR7c3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lcy5sZW5ndGggLSBzdGF0ZS5zaHVmZmxlSW5kZXh9IHJlbWFpbmluZyBpbiBwb29sLCAke3N0YXRlLnJlbW92ZWRTY2VuZUlkcy5zaXplfSByZW1vdmVkIHRoaXMgc2Vzc2lvbilgLFxuICApO1xuICByZXR1cm4gc2NlbmU7XG59XG5cbmZ1bmN0aW9uIGJ1aWxkT3Bwb25lbnRQb29sKGFsbFNjZW5lczogU2NlbmVbXSwgbGVmdFBvb2w6IFNjZW5lW10sIGZpbHRlcnM6IExpc3RGaWx0ZXJzKTogU2NlbmVbXSB7XG4gIGlmIChzdGF0ZS5maWx0ZXJPcHBvbmVudHMgJiYgZmlsdGVycy5maWx0ZXJBY3RpdmUpIHtcbiAgICByZXR1cm4gbGVmdFBvb2w7XG4gIH1cbiAgY29uc3QgcmF0ZWRPbmx5ID0gYWxsU2NlbmVzLmZpbHRlcigocykgPT4gcy5yYXRpbmcxMDAgIT0gbnVsbCk7XG4gIHJldHVybiByYXRlZE9ubHkubGVuZ3RoID49IDEgPyByYXRlZE9ubHkgOiBhbGxTY2VuZXM7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHJlc2V0TGVmdFBvb2woKTogUHJvbWlzZTx2b2lkPiB7XG4gIGF3YWl0IGNsZWFyRmlsdGVyZWRDYWNoZSgpO1xuICBzdGF0ZS5zaHVmZmxlZEZpbHRlcmVkU2NlbmVzID0gW107XG4gIHN0YXRlLnNodWZmbGVJbmRleCA9IDA7XG4gIHN0YXRlLnNodWZmbGVGaWx0ZXJLZXkgPSBudWxsO1xuICBzdGF0ZS5yZW1vdmVkU2NlbmVJZHMuY2xlYXIoKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gbG9hZFNjZW5lUG9vbHMoXG4gIGZpbHRlcnM6IExpc3RGaWx0ZXJzLFxuKTogUHJvbWlzZTx7IGxlZnRQb29sOiBTY2VuZVtdOyBhbGxTY2VuZXM6IFNjZW5lW10gfT4ge1xuICBpZiAoZmlsdGVycy5maWx0ZXJBY3RpdmUpIHtcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCfk4sgRmlsdGVyIGFjdGl2ZSwgZmV0Y2hpbmcgZmlsdGVyZWQgKyBhbGwgc2NlbmVzXCIpO1xuICAgIGNvbnN0IFtmaWx0ZXJlZFJlc3VsdCwgYWxsUmVzdWx0XSA9IGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICAgIGdldEZpbHRlcmVkU2NlbmVzQ2FjaGVkKGZpbHRlcnMpLFxuICAgICAgZ2V0QWxsU2NlbmVzQ2FjaGVkKCksXG4gICAgXSk7XG4gICAgcmV0dXJuIHtcbiAgICAgIGxlZnRQb29sOiBmaWx0ZXJlZFJlc3VsdC5zY2VuZXMgfHwgW10sXG4gICAgICBhbGxTY2VuZXM6IGFsbFJlc3VsdC5zY2VuZXMgfHwgW10sXG4gICAgfTtcbiAgfVxuXG4gIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+TiyBObyBmaWx0ZXIgYWN0aXZlLCB1c2luZyBhbGwgc2NlbmVzXCIpO1xuICBjb25zdCBhbGxSZXN1bHQgPSBhd2FpdCBnZXRBbGxTY2VuZXNDYWNoZWQoKTtcbiAgY29uc3QgYWxsU2NlbmVzID0gYWxsUmVzdWx0LnNjZW5lcyB8fCBbXTtcbiAgcmV0dXJuIHsgbGVmdFBvb2w6IGFsbFNjZW5lcywgYWxsU2NlbmVzIH07XG59XG5cbmZ1bmN0aW9uIHBpY2tMZWZ0U2NlbmUoXG4gIGZvcmNlZExlZnRTY2VuZTogU2NlbmUgfCBudWxsLFxuICBsZWZ0UG9vbDogU2NlbmVbXSxcbiAgZmlsdGVyS2V5OiBzdHJpbmcsXG4pOiBTY2VuZSB8IG51bGwge1xuICByZXR1cm4gZm9yY2VkTGVmdFNjZW5lIHx8IGdldE5leHRGaWx0ZXJlZFNjZW5lKGxlZnRQb29sLCBmaWx0ZXJLZXkpO1xufVxuXG5mdW5jdGlvbiBoYXNMZWZ0QXZhaWxhYmxlKGxlZnRQb29sOiBTY2VuZVtdLCBmb3JjZWRMZWZ0U2NlbmU6IFNjZW5lIHwgbnVsbCk6IGJvb2xlYW4ge1xuICByZXR1cm4gKFxuICAgIGZvcmNlZExlZnRTY2VuZSAhPT0gbnVsbCB8fFxuICAgIGxlZnRQb29sLnNvbWUoKHMpID0+ICFzdGF0ZS5yZW1vdmVkU2NlbmVJZHMuaGFzKHMuaWQpKVxuICApO1xufVxuXG4vKiogTG9hZCBsZWZ0L3JpZ2h0IHBvb2xzOyByZWZyZXNoIG9uY2UgaWYgdGhlIGxlZnQgcG9vbCBvciBmaWx0ZXItb3Bwb25lbnRzIHJpZ2h0IHBvb2wgaXMgZGVwbGV0ZWQuICovXG5hc3luYyBmdW5jdGlvbiBidWlsZFN3aXNzUG9vbHMoZm9yY2VkTGVmdFNjZW5lOiBTY2VuZSB8IG51bGwpOiBQcm9taXNlPHtcbiAgbGVmdFBvb2w6IFNjZW5lW107XG4gIHJpZ2h0UG9vbDogU2NlbmVbXTtcbiAgZmlsdGVyS2V5OiBzdHJpbmc7XG59PiB7XG4gIGxldCBmaWx0ZXJzID0gcmVhZEZpbHRlcnMoKTtcbiAgbGV0IHsgbGVmdFBvb2wsIGFsbFNjZW5lcyB9ID0gYXdhaXQgbG9hZFNjZW5lUG9vbHMoZmlsdGVycyk7XG5cbiAgaWYgKGFsbFNjZW5lcy5sZW5ndGggPCAyKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiTm90IGVub3VnaCBzY2VuZXMgZm9yIGNvbXBhcmlzb24uXCIpO1xuICB9XG5cbiAgbGV0IHJpZ2h0UG9vbCA9IGJ1aWxkT3Bwb25lbnRQb29sKGFsbFNjZW5lcywgbGVmdFBvb2wsIGZpbHRlcnMpO1xuXG4gIGNvbnN0IG5lZWRzTGVmdFJlZnJlc2ggPSAhaGFzTGVmdEF2YWlsYWJsZShsZWZ0UG9vbCwgZm9yY2VkTGVmdFNjZW5lKTtcbiAgY29uc3QgbmVlZHNPcHBvbmVudFJlc3RhcnQgPVxuICAgIHN0YXRlLmZpbHRlck9wcG9uZW50cyAmJiBmaWx0ZXJzLmZpbHRlckFjdGl2ZSAmJiByaWdodFBvb2wubGVuZ3RoIDwgMjtcblxuICBpZiAoIW5lZWRzTGVmdFJlZnJlc2ggJiYgIW5lZWRzT3Bwb25lbnRSZXN0YXJ0KSB7XG4gICAgcmV0dXJuIHsgbGVmdFBvb2wsIHJpZ2h0UG9vbCwgZmlsdGVyS2V5OiBmaWx0ZXJzLmZpbHRlcktleSB9O1xuICB9XG5cbiAgaWYgKG5lZWRzTGVmdFJlZnJlc2gpIHtcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCfj4EgUG9vbCBleGhhdXN0ZWQsIGZldGNoaW5nIGZyZXNoIGZyb20gbmV0d29yay4uLlwiKTtcbiAgfSBlbHNlIHtcbiAgICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCflIQgRmlsdGVyZWQgb3Bwb25lbnQgcG9vbCB0b28gc21hbGwsIHJlc3RhcnRpbmcgY3ljbGUuLi5cIik7XG4gIH1cblxuICBhd2FpdCByZXNldExlZnRQb29sKCk7XG4gIGxlZnRQb29sID0gZmlsdGVycy5maWx0ZXJBY3RpdmVcbiAgICA/IChhd2FpdCBnZXRGaWx0ZXJlZFNjZW5lc0NhY2hlZChmaWx0ZXJzKSkuc2NlbmVzIHx8IFtdXG4gICAgOiBhbGxTY2VuZXM7XG4gIGZpbHRlcnMgPSByZWFkRmlsdGVycygpO1xuICByaWdodFBvb2wgPSBidWlsZE9wcG9uZW50UG9vbChhbGxTY2VuZXMsIGxlZnRQb29sLCBmaWx0ZXJzKTtcblxuICBpZiAobmVlZHNPcHBvbmVudFJlc3RhcnQgJiYgcmlnaHRQb29sLmxlbmd0aCA8IDIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJOb3QgZW5vdWdoIHNjZW5lcyBpbiB5b3VyIGZpbHRlciBmb3IgYSBtYXRjaC4gWW91IG5lZWQgYXQgbGVhc3QgMiBzY2VuZXMuXCIpO1xuICB9XG5cbiAgcmV0dXJuIHtcbiAgICBsZWZ0UG9vbCxcbiAgICByaWdodFBvb2wsXG4gICAgZmlsdGVyS2V5OiBmaWx0ZXJzLmZpbHRlcktleSxcbiAgfTtcbn1cblxuLy8gU3dpc3MgbW9kZTogbGVmdCA9IHNjZW5lIHRvIHJhdGUgKGZpbHRlcmVkIHBvb2wpLCByaWdodCA9IHNpbWlsYXItc3RyZW5ndGggb3Bwb25lbnRcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBmZXRjaFN3aXNzUGFpcihmb3JjZWRMZWZ0U2NlbmU6IFNjZW5lIHwgbnVsbCA9IG51bGwpOiBQcm9taXNlPFN3aXNzUGFpclJlc3VsdD4ge1xuICBjb25zdCB7IGxlZnRQb29sLCByaWdodFBvb2wsIGZpbHRlcktleSB9ID0gYXdhaXQgYnVpbGRTd2lzc1Bvb2xzKGZvcmNlZExlZnRTY2VuZSk7XG5cbiAgY29uc3Qgc2NlbmUxID0gcGlja0xlZnRTY2VuZShmb3JjZWRMZWZ0U2NlbmUsIGxlZnRQb29sLCBmaWx0ZXJLZXkpO1xuICBpZiAoIXNjZW5lMSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcIk5vIHNjZW5lcyBtYXRjaCB5b3VyIGZpbHRlciBjcml0ZXJpYS5cIik7XG4gIH1cblxuICBjb25zdCB7IHNjZW5lMiwgcmFua3MgfSA9IHBpY2tTd2lzc09wcG9uZW50KHNjZW5lMSwgcmlnaHRQb29sKTtcbiAgcmV0dXJuIHsgc2NlbmVzOiBbc2NlbmUxLCBzY2VuZTJdLCByYW5rcyB9O1xufVxuXG4vKiogUGljayBhIHJhbmRvbSBvcHBvbmVudCBuZWFyIHNjZW5lMSdzIHJhbmsgaW4gdGhlIHJhdGluZy1zb3J0ZWQgcmlnaHQgcG9vbCAoZXhwYW5kaW5nIGJhbmQgaWYgbmVlZGVkKS4gKi9cbmZ1bmN0aW9uIHBpY2tTd2lzc09wcG9uZW50KFxuICBzY2VuZTE6IFNjZW5lLFxuICByaWdodFBvb2w6IFNjZW5lW10sXG4pOiB7IHNjZW5lMjogU2NlbmU7IHJhbmtzOiBbUmFuaywgUmFua10gfSB7XG4gIGNvbnN0IHNjZW5lMUlkeEluUG9vbCA9IHJpZ2h0UG9vbC5maW5kSW5kZXgoKHMpID0+IHMuaWQgPT09IHNjZW5lMS5pZCk7XG4gIGNvbnN0IGVmZmVjdGl2ZVNjZW5lMUlkeCA9IHNjZW5lMUlkeEluUG9vbCA+PSAwID8gc2NlbmUxSWR4SW5Qb29sIDogcmlnaHRQb29sLmxlbmd0aDtcbiAgY29uc3Qgc2NlbmUxUmFua0luUG9vbCA9IHNjZW5lMUlkeEluUG9vbCA+PSAwID8gc2NlbmUxSWR4SW5Qb29sICsgMSA6IG51bGw7XG5cbiAgY29uc3QgY2FuZGlkYXRlczogeyBzY2VuZTogU2NlbmU7IGlkeDogbnVtYmVyIH1bXSA9IFtdO1xuICAvLyBQcmVmZXIgc2ltaWxhci1zdHJlbmd0aCBtYXRjaHVwcyAowrFyZWFjaCByYW5rcykuIElmIHRoZSBiYW5kIGlzIGVtcHR5IChlZGdlcywgdW5yYXRlZCBsZWZ0XG4gIC8vIHNjZW5lLCB0aW55IHBvb2wpLCBkb3VibGUgcmVhY2ggdW50aWwgd2UgZmluZCBjYW5kaWRhdGVzIG9yIGNvdmVyIHRoZSB3aG9sZSBwb29sLlxuICBmb3IgKFxuICAgIGxldCByZWFjaCA9IE1hdGgubWluKFNXSVNTX09QUE9ORU5UX1JFQUNIX0lOSVRJQUwsIHJpZ2h0UG9vbC5sZW5ndGgpO1xuICAgIGNhbmRpZGF0ZXMubGVuZ3RoID09PSAwICYmIHJlYWNoIDw9IHJpZ2h0UG9vbC5sZW5ndGg7XG4gICAgcmVhY2ggPSBNYXRoLm1pbihyZWFjaCAqIFNXSVNTX09QUE9ORU5UX1JFQUNIX01VTFRJUExJRVIsIHJpZ2h0UG9vbC5sZW5ndGgpXG4gICkge1xuICAgIGZvciAobGV0IGkgPSBlZmZlY3RpdmVTY2VuZTFJZHggLSByZWFjaDsgaSA8PSBlZmZlY3RpdmVTY2VuZTFJZHggKyByZWFjaDsgaSsrKSB7XG4gICAgICBpZiAoaSA+PSAwICYmIGkgPCByaWdodFBvb2wubGVuZ3RoICYmIGkgIT09IHNjZW5lMUlkeEluUG9vbCkge1xuICAgICAgICBjYW5kaWRhdGVzLnB1c2goeyBzY2VuZTogcmlnaHRQb29sW2ldLCBpZHg6IGkgfSk7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgaWYgKGNhbmRpZGF0ZXMubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiTm90IGVub3VnaCBzY2VuZXMgZm9yIGNvbXBhcmlzb24uIFlvdSBuZWVkIGF0IGxlYXN0IDIgc2NlbmVzLlwiKTtcbiAgfVxuXG4gIGNvbnN0IHBpY2sgPSBjYW5kaWRhdGVzW01hdGguZmxvb3IoTWF0aC5yYW5kb20oKSAqIGNhbmRpZGF0ZXMubGVuZ3RoKV07XG4gIHJldHVybiB7XG4gICAgc2NlbmUyOiBwaWNrLnNjZW5lLFxuICAgIHJhbmtzOiBbc2NlbmUxUmFua0luUG9vbCwgcGljay5pZHggKyAxXSxcbiAgfTtcbn1cblxuLyoqIFJhbmRvbSBwaWNrIGZyb20gdGhlIE4gdW5kZWZlYXRlZCBvcHBvbmVudHMgY2xvc2VzdCBhYm92ZSB0aGUgY2xpbWJlciAobGlzdCBpcyByYXRpbmctc29ydGVkIERFU0MpLiAqL1xuZnVuY3Rpb24gcGlja0Nsb3Nlc3RDbGltYk9wcG9uZW50KHJlbWFpbmluZ09wcG9uZW50czogU2NlbmVbXSk6IFNjZW5lIHtcbiAgY29uc3QgY2xvc2VzdCA9IHJlbWFpbmluZ09wcG9uZW50cy5zbGljZSgtQ0xJTUJfT1BQT05FTlRfUElDS19XSU5ET1cpO1xuICByZXR1cm4gY2xvc2VzdFtNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkgKiBjbG9zZXN0Lmxlbmd0aCldO1xufVxuXG4vKiogVW5kZWZlYXRlZCBvcHBvbmVudHMgYWJvdmUgdGhlIGNsaW1iZXIgaW4gdGhlIHJhdGluZy1zb3J0ZWQgcmlnaHQgcG9vbC4gKi9cbmZ1bmN0aW9uIGdldFJlbWFpbmluZ0NsaW1iT3Bwb25lbnRzKFxuICBjbGltYmVyOiBTY2VuZSxcbiAgcmlnaHRQb29sOiBTY2VuZVtdLFxuICBjbGltYmVySW5kZXg6IG51bWJlcixcbik6IFNjZW5lW10ge1xuICByZXR1cm4gcmlnaHRQb29sLmZpbHRlcigocywgaWR4KSA9PiB7XG4gICAgaWYgKHMuaWQgPT09IGNsaW1iZXIuaWQgfHwgc3RhdGUuZ2F1bnRsZXREZWZlYXRlZC5pbmNsdWRlcyhzLmlkKSkgcmV0dXJuIGZhbHNlO1xuICAgIHJldHVybiBpZHggPCBjbGltYmVySW5kZXggfHwgKHMucmF0aW5nMTAwIHx8IDApID49IChjbGltYmVyLnJhdGluZzEwMCB8fCAwKTtcbiAgfSk7XG59XG5cbi8vIEZpbmQgdGhlIGxvd2VzdCBhY3R1YWxseSByYXRlZCBzY2VuZSBpbiBhIGRlc2NlbmRpbmctc29ydGVkIGFycmF5LCBleGNsdWRpbmcgYSBzcGVjaWZpYyBzY2VuZVxuLy8gUmV0dXJucyB7IHNjZW5lLCBpbmRleCB9IG9yIGZhbGxiYWNrIHRvIGZpcnN0IG5vbi1leGNsdWRlZCBzY2VuZSBpZiBub25lIHJhdGVkXG5mdW5jdGlvbiBmaW5kTG93ZXN0UmF0ZWQoc2NlbmVzOiBTY2VuZVtdLCBleGNsdWRlSWQ6IHN0cmluZyk6IHsgc2NlbmU6IFNjZW5lOyBpbmRleDogbnVtYmVyIH0ge1xuICBmb3IgKGxldCBpID0gc2NlbmVzLmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7XG4gICAgY29uc3QgcyA9IHNjZW5lc1tpXTtcbiAgICBpZiAocy5pZCAhPT0gZXhjbHVkZUlkICYmIHMucmF0aW5nMTAwICE9IG51bGwpIHtcbiAgICAgIHJldHVybiB7IHNjZW5lOiBzLCBpbmRleDogaSB9O1xuICAgIH1cbiAgfVxuICAvLyBGYWxsYmFjayB0byBhbnkgc2NlbmUgaWYgbm9uZSByYXRlZFxuICBjb25zdCBmYWxsYmFja0luZGV4ID0gc2NlbmVzLmZpbmRJbmRleCgocykgPT4gcy5pZCAhPT0gZXhjbHVkZUlkKTtcbiAgcmV0dXJuIHsgc2NlbmU6IHNjZW5lc1tmYWxsYmFja0luZGV4XSwgaW5kZXg6IGZhbGxiYWNrSW5kZXggfTtcbn1cblxuLy8gR2F1bnRsZXQgbW9kZTogY2hhbXBpb24gdnMgbmV4dCBjaGFsbGVuZ2VyXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmV0Y2hHYXVudGxldFBhaXIoXG4gIGZvcmNlZExlZnRTY2VuZTogU2NlbmUgfCBudWxsID0gbnVsbCxcbik6IFByb21pc2U8R2F1bnRsZXRQYWlyUmVzdWx0PiB7XG4gIGNvbnN0IGZpbHRlcnMgPSByZWFkRmlsdGVycygpO1xuXG4gIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+TiyBGZXRjaGluZyBzY2VuZXMgZm9yIGdhdW50bGV0Li4uXCIpO1xuICBjb25zdCB7IGxlZnRQb29sLCBhbGxTY2VuZXMgfSA9IGF3YWl0IGxvYWRTY2VuZVBvb2xzKGZpbHRlcnMpO1xuXG4gIGxldCByaWdodFBvb2wgPSBidWlsZE9wcG9uZW50UG9vbChhbGxTY2VuZXMsIGxlZnRQb29sLCBmaWx0ZXJzKTtcbiAgc3RhdGUudG90YWxTY2VuZXNDb3VudCA9IHJpZ2h0UG9vbC5sZW5ndGg7XG5cbiAgaWYgKGFsbFNjZW5lcy5sZW5ndGggPCAyKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFwiTm90IGVub3VnaCBzY2VuZXMgZm9yIGNvbXBhcmlzb24uXCIpO1xuICB9XG5cbiAgLy8gSGFuZGxlIGZhbGxpbmcgbW9kZSAtIGZpbmQgbmV4dCBvcHBvbmVudCBCRUxPVyB0byB0ZXN0IGFnYWluc3QgKGZyb20gZnVsbCBjb2xsZWN0aW9uKVxuICBpZiAoc3RhdGUuZ2F1bnRsZXRGYWxsaW5nICYmIHN0YXRlLmdhdW50bGV0RmFsbGluZ1NjZW5lKSB7XG4gICAgY29uc3QgZmFsbGluZ1NjZW5lID0gc3RhdGUuZ2F1bnRsZXRGYWxsaW5nU2NlbmU7XG4gICAgY29uc3QgZmFsbGluZ0luZGV4ID0gcmlnaHRQb29sLmZpbmRJbmRleCgocykgPT4gcy5pZCA9PT0gZmFsbGluZ1NjZW5lLmlkKTtcblxuICAgIGNvbnN0IGJlbG93T3Bwb25lbnRzID0gcmlnaHRQb29sLmZpbHRlcigocywgaWR4KSA9PiB7XG4gICAgICBpZiAocy5pZCA9PT0gZmFsbGluZ1NjZW5lLmlkIHx8IHN0YXRlLmdhdW50bGV0RGVmZWF0ZWQuaW5jbHVkZXMocy5pZCkpIHJldHVybiBmYWxzZTtcbiAgICAgIHJldHVybiBpZHggPiBmYWxsaW5nSW5kZXg7IC8vIEJlbG93IGluIHJhbmtpbmdcbiAgICB9KTtcblxuICAgIGlmIChiZWxvd09wcG9uZW50cy5sZW5ndGggPT09IDApIHtcbiAgICAgIC8vIEhpdCB0aGUgYm90dG9tIC0gcGxhY2UgMSBiZWxvdyB0aGUgbGFzdCBvcHBvbmVudCB0aGF0IGJlYXQgdGhlbVxuICAgICAgY29uc3QgZmluYWxSYW5rID0gcmlnaHRQb29sLmxlbmd0aDtcbiAgICAgIGNvbnN0IGxhc3REZWZlYXRlZEJ5SWQgPSBzdGF0ZS5nYXVudGxldERlZmVhdGVkW3N0YXRlLmdhdW50bGV0RGVmZWF0ZWQubGVuZ3RoIC0gMV07XG4gICAgICBjb25zdCBsYXN0T3Bwb25lbnQgPSByaWdodFBvb2wuZmluZCgocykgPT4gcy5pZCA9PT0gbGFzdERlZmVhdGVkQnlJZCk7XG4gICAgICBjb25zdCBmaW5hbFJhdGluZyA9IE1hdGgubWF4KDEsIChsYXN0T3Bwb25lbnQ/LnJhdGluZzEwMCB8fCAxKSAtIDEpO1xuICAgICAgdXBkYXRlU2NlbmVSYXRpbmcoZmFsbGluZ1NjZW5lLmlkLCBmaW5hbFJhdGluZyk7XG5cbiAgICAgIHJldHVybiB7XG4gICAgICAgIHNjZW5lczogW2ZhbGxpbmdTY2VuZV0sXG4gICAgICAgIHJhbmtzOiBbZmluYWxSYW5rXSxcbiAgICAgICAgaXNWaWN0b3J5OiBmYWxzZSxcbiAgICAgICAgaXNGYWxsaW5nOiB0cnVlLFxuICAgICAgICBpc1BsYWNlbWVudDogdHJ1ZSxcbiAgICAgICAgcGxhY2VtZW50UmFuazogZmluYWxSYW5rLFxuICAgICAgICBwbGFjZW1lbnRSYXRpbmc6IGZpbmFsUmF0aW5nLFxuICAgICAgfTtcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gR2V0IG5leHQgb3Bwb25lbnQgYmVsb3cgKGZpcnN0IG9uZSwgY2xvc2VzdCB0byBmYWxsaW5nIHNjZW5lKVxuICAgICAgY29uc3QgbmV4dEJlbG93ID0gYmVsb3dPcHBvbmVudHNbMF07XG4gICAgICBjb25zdCBuZXh0QmVsb3dJbmRleCA9IHJpZ2h0UG9vbC5maW5kSW5kZXgoKHMpID0+IHMuaWQgPT09IG5leHRCZWxvdy5pZCk7XG5cbiAgICAgIC8vIFVwZGF0ZSB0aGUgZmFsbGluZyBzY2VuZSdzIHJhbmsgZm9yIGRpc3BsYXlcbiAgICAgIHN0YXRlLmdhdW50bGV0Q2xpbWJlclJhbmsgPSBmYWxsaW5nSW5kZXggKyAxO1xuXG4gICAgICByZXR1cm4ge1xuICAgICAgICBzY2VuZXM6IFtmYWxsaW5nU2NlbmUsIG5leHRCZWxvd10sXG4gICAgICAgIHJhbmtzOiBbZmFsbGluZ0luZGV4ICsgMSwgbmV4dEJlbG93SW5kZXggKyAxXSxcbiAgICAgICAgaXNWaWN0b3J5OiBmYWxzZSxcbiAgICAgICAgaXNGYWxsaW5nOiB0cnVlLFxuICAgICAgfTtcbiAgICB9XG4gIH1cblxuICAvLyBJZiBubyBjbGltYmVyIHlldCwgcGljayBmcm9tIGZpbHRlcmVkIHBvb2wgdG8gc3RhcnRcbiAgaWYgKCFzdGF0ZS5nYXVudGxldENsaW1iZXIpIHtcbiAgICBzdGF0ZS5nYXVudGxldERlZmVhdGVkID0gW107XG4gICAgc3RhdGUuZ2F1bnRsZXRGYWxsaW5nID0gZmFsc2U7XG4gICAgc3RhdGUuZ2F1bnRsZXRGYWxsaW5nU2NlbmUgPSBudWxsO1xuXG4gICAgY29uc3QgY2hhbGxlbmdlciA9IGZvcmNlZExlZnRTY2VuZSB8fCBnZXROZXh0RmlsdGVyZWRTY2VuZShsZWZ0UG9vbCwgZmlsdGVycy5maWx0ZXJLZXkpO1xuXG4gICAgaWYgKCFjaGFsbGVuZ2VyKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJObyBzY2VuZXMgbWF0Y2ggeW91ciBmaWx0ZXIgY3JpdGVyaWEuXCIpO1xuICAgIH1cblxuICAgIGNvbnN0IGNoYWxsZW5nZXJJbmRleCA9IHJpZ2h0UG9vbC5maW5kSW5kZXgoKHMpID0+IHMuaWQgPT09IGNoYWxsZW5nZXIuaWQpO1xuXG4gICAgLy8gU3RhcnQgYXQgdGhlIGJvdHRvbSAtIGZpbmQgbG93ZXN0IHJhdGVkIHNjZW5lIGluIHJpZ2h0UG9vbFxuICAgIGNvbnN0IHsgc2NlbmU6IGxvd2VzdFJhdGVkLCBpbmRleDogbG93ZXN0SW5kZXggfSA9IGZpbmRMb3dlc3RSYXRlZChyaWdodFBvb2wsIGNoYWxsZW5nZXIuaWQpO1xuXG4gICAgc3RhdGUuZ2F1bnRsZXRDbGltYmVyUmFuayA9IGNoYWxsZW5nZXJJbmRleCA+PSAwID8gY2hhbGxlbmdlckluZGV4ICsgMSA6IHJpZ2h0UG9vbC5sZW5ndGg7XG5cbiAgICByZXR1cm4ge1xuICAgICAgc2NlbmVzOiBbY2hhbGxlbmdlciwgbG93ZXN0UmF0ZWRdLFxuICAgICAgcmFua3M6IFtzdGF0ZS5nYXVudGxldENsaW1iZXJSYW5rLCBsb3dlc3RJbmRleCArIDFdLFxuICAgICAgaXNWaWN0b3J5OiBmYWxzZSxcbiAgICAgIGlzRmFsbGluZzogZmFsc2UsXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IGNsaW1iZXIgPSBzdGF0ZS5nYXVudGxldENsaW1iZXI7XG4gIGNvbnN0IGNsaW1iZXJJbmRleCA9IHJpZ2h0UG9vbC5maW5kSW5kZXgoKHMpID0+IHMuaWQgPT09IGNsaW1iZXIuaWQpO1xuXG4gIHN0YXRlLmdhdW50bGV0Q2xpbWJlclJhbmsgPSBjbGltYmVySW5kZXggPj0gMCA/IGNsaW1iZXJJbmRleCArIDEgOiAxO1xuXG4gIGNvbnN0IHJlbWFpbmluZ09wcG9uZW50cyA9IGdldFJlbWFpbmluZ0NsaW1iT3Bwb25lbnRzKGNsaW1iZXIsIHJpZ2h0UG9vbCwgY2xpbWJlckluZGV4KTtcblxuICAvLyBJZiBubyBvcHBvbmVudHMgbGVmdCwgdGhlIGNsaW1iZXIgaGFzIGNvbnF1ZXJlZCB0aGUgbGFkZGVyXG4gIGlmIChyZW1haW5pbmdPcHBvbmVudHMubGVuZ3RoID09PSAwKSB7XG4gICAgc3RhdGUuZ2F1bnRsZXRDbGltYmVyUmFuayA9IDE7XG4gICAgcmV0dXJuIHtcbiAgICAgIHNjZW5lczogW2NsaW1iZXJdLFxuICAgICAgcmFua3M6IFsxXSxcbiAgICAgIGlzVmljdG9yeTogdHJ1ZSxcbiAgICAgIGlzRmFsbGluZzogZmFsc2UsXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IG5leHRPcHBvbmVudCA9IHBpY2tDbG9zZXN0Q2xpbWJPcHBvbmVudChyZW1haW5pbmdPcHBvbmVudHMpO1xuICBjb25zdCBuZXh0T3Bwb25lbnRJbmRleCA9IHJpZ2h0UG9vbC5maW5kSW5kZXgoKHMpID0+IHMuaWQgPT09IG5leHRPcHBvbmVudC5pZCk7XG5cbiAgcmV0dXJuIHtcbiAgICBzY2VuZXM6IFtjbGltYmVyLCBuZXh0T3Bwb25lbnRdLFxuICAgIHJhbmtzOiBbY2xpbWJlckluZGV4ICsgMSwgbmV4dE9wcG9uZW50SW5kZXggKyAxXSxcbiAgICBpc1ZpY3Rvcnk6IGZhbHNlLFxuICAgIGlzRmFsbGluZzogZmFsc2UsXG4gIH07XG59XG5cbi8vIENoYW1waW9uIG1vZGU6IGxpa2UgZ2F1bnRsZXQgYnV0IHdpbm5lciBzdGF5cyBvbiAobm8gZmFsbGluZylcbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBmZXRjaENoYW1waW9uUGFpcihcbiAgZm9yY2VkTGVmdFNjZW5lOiBTY2VuZSB8IG51bGwgPSBudWxsLFxuKTogUHJvbWlzZTxDaGFtcGlvblBhaXJSZXN1bHQ+IHtcbiAgY29uc3QgZmlsdGVycyA9IHJlYWRGaWx0ZXJzKCk7XG5cbiAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5OLIEZldGNoaW5nIHNjZW5lcyBmb3IgY2hhbXBpb24uLi5cIik7XG4gIGNvbnN0IHsgbGVmdFBvb2wsIGFsbFNjZW5lcyB9ID0gYXdhaXQgbG9hZFNjZW5lUG9vbHMoZmlsdGVycyk7XG5cbiAgbGV0IHJpZ2h0UG9vbCA9IGJ1aWxkT3Bwb25lbnRQb29sKGFsbFNjZW5lcywgbGVmdFBvb2wsIGZpbHRlcnMpO1xuICBzdGF0ZS50b3RhbFNjZW5lc0NvdW50ID0gcmlnaHRQb29sLmxlbmd0aDtcblxuICBpZiAoYWxsU2NlbmVzLmxlbmd0aCA8IDIpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXCJOb3QgZW5vdWdoIHNjZW5lcyBmb3IgY29tcGFyaXNvbi5cIik7XG4gIH1cblxuICAvLyBJZiBubyBjbGltYmVyIHlldCwgcGljayBmcm9tIGZpbHRlcmVkIHBvb2wgdG8gc3RhcnRcbiAgaWYgKCFzdGF0ZS5nYXVudGxldENsaW1iZXIpIHtcbiAgICBzdGF0ZS5nYXVudGxldERlZmVhdGVkID0gW107XG5cbiAgICBpZiAoIWZvcmNlZExlZnRTY2VuZSAmJiBsZWZ0UG9vbC5sZW5ndGggPCAxKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXCJObyBzY2VuZXMgbWF0Y2ggeW91ciBmaWx0ZXIgY3JpdGVyaWEuXCIpO1xuICAgIH1cblxuICAgIGNvbnN0IGNoYWxsZW5nZXIgPSBmb3JjZWRMZWZ0U2NlbmUgfHwgZ2V0TmV4dEZpbHRlcmVkU2NlbmUobGVmdFBvb2wsIGZpbHRlcnMuZmlsdGVyS2V5KTtcblxuICAgIGlmICghY2hhbGxlbmdlcikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFwiTm8gc2NlbmVzIG1hdGNoIHlvdXIgZmlsdGVyIGNyaXRlcmlhLlwiKTtcbiAgICB9XG5cbiAgICBjb25zdCBjaGFsbGVuZ2VySW5kZXggPSByaWdodFBvb2wuZmluZEluZGV4KChzKSA9PiBzLmlkID09PSBjaGFsbGVuZ2VyLmlkKTtcblxuICAgIC8vIFN0YXJ0IGF0IHRoZSBib3R0b20gLSBmaW5kIGxvd2VzdCBhY3R1YWxseSByYXRlZCBzY2VuZVxuICAgIGNvbnN0IHsgc2NlbmU6IGxvd2VzdFJhdGVkLCBpbmRleDogbG93ZXN0SW5kZXggfSA9IGZpbmRMb3dlc3RSYXRlZChyaWdodFBvb2wsIGNoYWxsZW5nZXIuaWQpO1xuXG4gICAgc3RhdGUuZ2F1bnRsZXRDbGltYmVyUmFuayA9IGNoYWxsZW5nZXJJbmRleCA+PSAwID8gY2hhbGxlbmdlckluZGV4ICsgMSA6IHJpZ2h0UG9vbC5sZW5ndGg7XG5cbiAgICByZXR1cm4ge1xuICAgICAgc2NlbmVzOiBbY2hhbGxlbmdlciwgbG93ZXN0UmF0ZWRdLFxuICAgICAgcmFua3M6IFtzdGF0ZS5nYXVudGxldENsaW1iZXJSYW5rLCBsb3dlc3RJbmRleCArIDFdLFxuICAgICAgaXNWaWN0b3J5OiBmYWxzZSxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgY2xpbWJlciA9IHN0YXRlLmdhdW50bGV0Q2xpbWJlcjtcbiAgY29uc3QgY2xpbWJlckluZGV4ID0gcmlnaHRQb29sLmZpbmRJbmRleCgocykgPT4gcy5pZCA9PT0gY2xpbWJlci5pZCk7XG5cbiAgc3RhdGUuZ2F1bnRsZXRDbGltYmVyUmFuayA9IGNsaW1iZXJJbmRleCA+PSAwID8gY2xpbWJlckluZGV4ICsgMSA6IDE7XG5cbiAgY29uc3QgcmVtYWluaW5nT3Bwb25lbnRzID0gZ2V0UmVtYWluaW5nQ2xpbWJPcHBvbmVudHMoY2xpbWJlciwgcmlnaHRQb29sLCBjbGltYmVySW5kZXgpO1xuICBcbiAgLy8gSWYgbm8gb3Bwb25lbnRzIGxlZnQsIHRoZSBjbGltYmVyIGhhcyBjb25xdWVyZWQgdGhlIGxhZGRlclxuICBpZiAocmVtYWluaW5nT3Bwb25lbnRzLmxlbmd0aCA9PT0gMCkge1xuICAgIHN0YXRlLmdhdW50bGV0Q2xpbWJlclJhbmsgPSAxO1xuICAgIHJldHVybiB7XG4gICAgICBzY2VuZXM6IFtjbGltYmVyXSxcbiAgICAgIHJhbmtzOiBbMV0sXG4gICAgICBpc1ZpY3Rvcnk6IHRydWUsXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IG5leHRPcHBvbmVudCA9IHBpY2tDbG9zZXN0Q2xpbWJPcHBvbmVudChyZW1haW5pbmdPcHBvbmVudHMpO1xuICBjb25zdCBuZXh0T3Bwb25lbnRJbmRleCA9IHJpZ2h0UG9vbC5maW5kSW5kZXgoKHMpID0+IHMuaWQgPT09IG5leHRPcHBvbmVudC5pZCk7XG5cbiAgcmV0dXJuIHtcbiAgICBzY2VuZXM6IFtjbGltYmVyLCBuZXh0T3Bwb25lbnRdLFxuICAgIHJhbmtzOiBbY2xpbWJlckluZGV4ICsgMSwgbmV4dE9wcG9uZW50SW5kZXggKyAxXSxcbiAgICBpc1ZpY3Rvcnk6IGZhbHNlLFxuICB9O1xufVxuIiwgImltcG9ydCB0eXBlIHsgU2NlbmUgfSBmcm9tIFwiLi4vdHlwZXNcIjtcclxuXHJcbi8qKiBTY2VuZSB0aXRsZSBmcm9tIG1ldGFkYXRhLCBvciB0aGUgZmlsZW5hbWUgKHdpdGhvdXQgZXh0ZW5zaW9uKSBmcm9tIHRoZSBmaWxlIHBhdGguICovXHJcbmV4cG9ydCBmdW5jdGlvbiByZXNvbHZlU2NlbmVUaXRsZShzY2VuZTogU2NlbmUpOiBzdHJpbmcge1xyXG4gIGlmIChzY2VuZS50aXRsZSkgcmV0dXJuIHNjZW5lLnRpdGxlO1xyXG5cclxuICBjb25zdCBwYXRoID0gc2NlbmUuZmlsZXM/LlswXT8ucGF0aDtcclxuICBpZiAocGF0aCkge1xyXG4gICAgY29uc3QgcGF0aFBhcnRzID0gcGF0aC5zcGxpdCgvWy9cXFxcXS8pO1xyXG4gICAgcmV0dXJuIHBhdGhQYXJ0c1twYXRoUGFydHMubGVuZ3RoIC0gMV0ucmVwbGFjZSgvXFwuW14vLl0rJC8sIFwiXCIpO1xyXG4gIH1cclxuXHJcbiAgcmV0dXJuIFwiXCI7XHJcbn1cclxuIiwgIi8vIFJlbmRlcnMgYW4gaW5kaXZpZHVhbCBzY2VuZSBjYXJkIChyZXR1cm5zIGFuIEhUTUwgc3RyaW5nKS5cblxuaW1wb3J0IHR5cGUgeyBSYW5rLCBTY2VuZSB9IGZyb20gXCIuLi90eXBlc1wiO1xuaW1wb3J0IHsgcmVzb2x2ZVNjZW5lVGl0bGUgfSBmcm9tIFwiLi9zY2VuZVRpdGxlXCI7XG5cbmV4cG9ydCBmdW5jdGlvbiBmb3JtYXREdXJhdGlvbihzZWNvbmRzOiBudW1iZXIgfCBudWxsIHwgdW5kZWZpbmVkKTogc3RyaW5nIHtcbiAgaWYgKCFzZWNvbmRzKSByZXR1cm4gXCJOL0FcIjtcbiAgY29uc3QgaCA9IE1hdGguZmxvb3Ioc2Vjb25kcyAvIDM2MDApO1xuICBjb25zdCBtID0gTWF0aC5mbG9vcigoc2Vjb25kcyAlIDM2MDApIC8gNjApO1xuICBjb25zdCBzID0gTWF0aC5mbG9vcihzZWNvbmRzICUgNjApO1xuICBpZiAoaCA+IDApIHtcbiAgICByZXR1cm4gYCR7aH06JHttLnRvU3RyaW5nKCkucGFkU3RhcnQoMiwgXCIwXCIpfToke3MudG9TdHJpbmcoKS5wYWRTdGFydCgyLCBcIjBcIil9YDtcbiAgfVxuICByZXR1cm4gYCR7bX06JHtzLnRvU3RyaW5nKCkucGFkU3RhcnQoMiwgXCIwXCIpfWA7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVTY2VuZUNhcmQoXG4gIHNjZW5lOiBTY2VuZSxcbiAgc2lkZTogXCJsZWZ0XCIgfCBcInJpZ2h0XCIsXG4gIHJhbms6IFJhbmsgPSBudWxsLFxuICBzdGF0dXNCYWRnZTogbnVtYmVyIHwgc3RyaW5nIHwgbnVsbCA9IG51bGwsXG4pOiBzdHJpbmcge1xuICBjb25zdCBmaWxlID0gc2NlbmUuZmlsZXMgJiYgc2NlbmUuZmlsZXNbMF0gPyBzY2VuZS5maWxlc1swXSA6IHt9O1xuICBjb25zdCBkdXJhdGlvbiA9IGZpbGUuZHVyYXRpb247XG4gIGNvbnN0IHBlcmZvcm1lcnMgPVxuICAgIHNjZW5lLnBlcmZvcm1lcnMgJiYgc2NlbmUucGVyZm9ybWVycy5sZW5ndGggPiAwXG4gICAgICA/IHNjZW5lLnBlcmZvcm1lcnMubWFwKChwKSA9PiBwLm5hbWUpLmpvaW4oXCIsIFwiKVxuICAgICAgOiBcIk5vIHBlcmZvcm1lcnNcIjtcbiAgY29uc3Qgc3R1ZGlvID0gc2NlbmUuc3R1ZGlvID8gc2NlbmUuc3R1ZGlvLm5hbWUgOiBcIk5vIHN0dWRpb1wiO1xuICBjb25zdCB0YWdzID0gc2NlbmUudGFncyA/IHNjZW5lLnRhZ3Muc2xpY2UoMCwgNSkubWFwKCh0KSA9PiB0Lm5hbWUpIDogW107XG5cbiAgY29uc3QgdGl0bGUgPSByZXNvbHZlU2NlbmVUaXRsZShzY2VuZSk7XG5cbiAgY29uc3Qgc2NyZWVuc2hvdFBhdGggPSBzY2VuZS5wYXRocyA/IHNjZW5lLnBhdGhzLnNjcmVlbnNob3QgOiBudWxsO1xuICBjb25zdCBwcmV2aWV3UGF0aCA9IHNjZW5lLnBhdGhzID8gc2NlbmUucGF0aHMucHJldmlldyA6IG51bGw7XG4gIGNvbnN0IHN0YXNoUmF0aW5nID0gc2NlbmUucmF0aW5nMTAwID8gYCR7c2NlbmUucmF0aW5nMTAwfS8xMDBgIDogXCJVbnJhdGVkXCI7XG5cbiAgLy8gTnVtZXJpYyByYW5rIGJhZGdlICgjTiksIG9taXR0ZWQgd2hlbiBudWxsXG4gIGxldCByYW5rRGlzcGxheSA9IFwiXCI7XG4gIGlmIChyYW5rICE9PSBudWxsICYmIHJhbmsgIT09IHVuZGVmaW5lZCkge1xuICAgIHJhbmtEaXNwbGF5ID0gYDxzcGFuIGNsYXNzPVwic2Itc2NlbmUtcmFua1wiPiMke3Jhbmt9PC9zcGFuPmA7XG4gIH1cblxuICAvLyBTdGF0dXMgYmFkZ2U6IHdpbi1zdHJlYWsgY291bnQgKGZvcm1hdHRlZCkgb3IgY3VzdG9tIGxhYmVsIChlLmcuIGZhbGxpbmcgbW9kZSlcbiAgbGV0IHN0YXR1c0JhZGdlSHRtbCA9IFwiXCI7XG4gIGlmICh0eXBlb2Ygc3RhdHVzQmFkZ2UgPT09IFwic3RyaW5nXCIpIHtcbiAgICBzdGF0dXNCYWRnZUh0bWwgPSBgPGRpdiBjbGFzcz1cInNiLXN0cmVhay1iYWRnZVwiPiR7c3RhdHVzQmFkZ2V9PC9kaXY+YDtcbiAgfSBlbHNlIGlmIChzdGF0dXNCYWRnZSAhPT0gbnVsbCAmJiBzdGF0dXNCYWRnZSA+IDApIHtcbiAgICBzdGF0dXNCYWRnZUh0bWwgPSBgPGRpdiBjbGFzcz1cInNiLXN0cmVhay1iYWRnZVwiPvCflKUgJHtzdGF0dXNCYWRnZX0gd2luJHtzdGF0dXNCYWRnZSA+IDEgPyBcInNcIiA6IFwiXCJ9PC9kaXY+YDtcbiAgfVxuXG4gIC8vIFByZXNlcnZlIFVSTCBzZWFyY2ggcGFyYW1zIHdoZW4gb3BlbmluZyBzY2VuZVxuICBjb25zdCBjdXJyZW50UGFyYW1zID0gd2luZG93LmxvY2F0aW9uLnNlYXJjaDtcbiAgY29uc3Qgc2NlbmVVcmwgPSBgL3NjZW5lcy8ke3NjZW5lLmlkfSR7Y3VycmVudFBhcmFtc31gO1xuXG4gIHJldHVybiBgXG4gICAgICA8ZGl2IGNsYXNzPVwic2Itc2NlbmUtY2FyZFwiIGRhdGEtc2lkZT1cIiR7c2lkZX1cIj5cbiAgICAgICAgPGRpdiBjbGFzcz1cInNiLXNjZW5lLWltYWdlLWNvbnRhaW5lclwiIGRhdGEtc2NlbmUtdXJsPVwiJHtzY2VuZVVybH1cIj5cbiAgICAgICAgICAke1xuICAgICAgICAgICAgc2NyZWVuc2hvdFBhdGhcbiAgICAgICAgICAgICAgPyBgPGltZyBjbGFzcz1cInNiLXNjZW5lLWltYWdlXCIgc3JjPVwiJHtzY3JlZW5zaG90UGF0aH1cIiBhbHQ9XCIke3RpdGxlfVwiIGxvYWRpbmc9XCJsYXp5XCIgLz5gXG4gICAgICAgICAgICAgIDogYDxkaXYgY2xhc3M9XCJzYi1zY2VuZS1pbWFnZSBzYi1uby1pbWFnZVwiPk5vIFNjcmVlbnNob3Q8L2Rpdj5gXG4gICAgICAgICAgfVxuICAgICAgICAgICR7cHJldmlld1BhdGggPyBgPHZpZGVvIGNsYXNzPVwic2ItaG92ZXItcHJldmlld1wiIHNyYz1cIiR7cHJldmlld1BhdGh9XCIgbG9vcCBwbGF5c2lubGluZT48L3ZpZGVvPmAgOiBcIlwifVxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1zY2VuZS1kdXJhdGlvblwiPiR7Zm9ybWF0RHVyYXRpb24oZHVyYXRpb24pfTwvZGl2PlxuICAgICAgICAgICR7c3RhdHVzQmFkZ2VIdG1sfVxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1jbGljay1oaW50XCI+Q2xpY2sgdG8gb3BlbiBzY2VuZTwvZGl2PlxuICAgICAgICA8L2Rpdj5cblxuICAgICAgICA8ZGl2IGNsYXNzPVwic2Itc2NlbmUtYm9keVwiIGRhdGEtd2lubmVyPVwiJHtzY2VuZS5pZH1cIj5cbiAgICAgICAgICA8ZGl2IGNsYXNzPVwic2Itc2NlbmUtaW5mb1wiPlxuICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNiLXNjZW5lLXRpdGxlLXJvd1wiPlxuICAgICAgICAgICAgICA8aDMgY2xhc3M9XCJzYi1zY2VuZS10aXRsZVwiPiR7dGl0bGV9PC9oMz5cbiAgICAgICAgICAgICAgJHtyYW5rRGlzcGxheX1cbiAgICAgICAgICAgIDwvZGl2PlxuXG4gICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2Itc2NlbmUtbWV0YVwiPlxuICAgICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItbWV0YS1pdGVtXCI+PHN0cm9uZz5TdHVkaW86PC9zdHJvbmc+ICR7c3R1ZGlvfTwvZGl2PlxuICAgICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItbWV0YS1pdGVtXCI+PHN0cm9uZz5QZXJmb3JtZXJzOjwvc3Ryb25nPiAke3BlcmZvcm1lcnN9PC9kaXY+XG4gICAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1tZXRhLWl0ZW1cIj48c3Ryb25nPlBsYXkgQ291bnQ6PC9zdHJvbmc+ICR7c2NlbmUucGxheV9jb3VudCB8fCAwfTwvZGl2PlxuICAgICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItbWV0YS1pdGVtXCI+PHN0cm9uZz5SYXRpbmc6PC9zdHJvbmc+ICR7c3Rhc2hSYXRpbmd9PC9kaXY+XG4gICAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1tZXRhLWl0ZW0gc2ItdGFncy1yb3dcIj48c3Ryb25nPlRhZ3M6PC9zdHJvbmc+ICR7dGFncy5sZW5ndGggPiAwID8gdGFncy5tYXAoKHRhZykgPT4gYDxzcGFuIGNsYXNzPVwic2ItdGFnXCI+JHt0YWd9PC9zcGFuPmApLmpvaW4oXCJcIikgOiAnPHNwYW4gY2xhc3M9XCJzYi1ub25lXCI+Tm9uZTwvc3Bhbj4nfTwvZGl2PlxuICAgICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgPC9kaXY+XG5cbiAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItY2hvb3NlLWJ0blwiPlxuICAgICAgICAgICAg4pyTIENob29zZSBUaGlzIFNjZW5lXG4gICAgICAgICAgPC9kaXY+XG4gICAgICAgIDwvZGl2PlxuICAgICAgPC9kaXY+XG4gICAgYDtcbn1cbiIsICIvLyBWaWN0b3J5IGFuZCBwbGFjZW1lbnQgZW5kLXNjcmVlbnMgZm9yIGdhdW50bGV0L2NoYW1waW9uIHJ1bnMuXHJcblxyXG5pbXBvcnQgeyByZXNldEdhdW50bGV0U3RhdGUsIHN0YXRlIH0gZnJvbSBcIi4uL3N0YXRlXCI7XHJcbmltcG9ydCB7IHNhdmVTdGF0ZSB9IGZyb20gXCIuLi9zdG9yYWdlXCI7XHJcbmltcG9ydCB0eXBlIHsgU2NlbmUgfSBmcm9tIFwiLi4vdHlwZXNcIjtcclxuaW1wb3J0IHsgbG9hZE5ld1BhaXIgfSBmcm9tIFwiLi9tYWluVUlcIjtcclxuaW1wb3J0IHsgcmVzb2x2ZVNjZW5lVGl0bGUgfSBmcm9tIFwiLi9zY2VuZVRpdGxlXCI7XHJcblxyXG5mdW5jdGlvbiBidWlsZEVuZFNjcmVlbkh0bWwoXHJcbiAgc2NlbmU6IFNjZW5lLFxyXG4gIGNyb3duOiBzdHJpbmcsXHJcbiAgaGVhZGxpbmU6IHN0cmluZyxcclxuICBzdGF0c0h0bWw6IHN0cmluZyxcclxuICBidXR0b25MYWJlbDogc3RyaW5nLFxyXG4pOiBzdHJpbmcge1xyXG4gIGNvbnN0IHRpdGxlID0gcmVzb2x2ZVNjZW5lVGl0bGUoc2NlbmUpO1xyXG4gIGNvbnN0IHNjcmVlbnNob3RQYXRoID0gc2NlbmUucGF0aHM/LnNjcmVlbnNob3QgPz8gbnVsbDtcclxuXHJcbiAgcmV0dXJuIGBcclxuICAgICAgPGRpdiBjbGFzcz1cInNiLWVuZC1zY3JlZW5cIj5cclxuICAgICAgICA8ZGl2IGNsYXNzPVwic2ItZW5kLXNjcmVlbi1pY29uXCI+JHtjcm93bn08L2Rpdj5cclxuICAgICAgICA8aDIgY2xhc3M9XCJzYi1lbmQtc2NyZWVuLWhlYWRsaW5lXCI+JHtoZWFkbGluZX08L2gyPlxyXG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi1lbmQtc2NyZWVuLXNjZW5lXCI+XHJcbiAgICAgICAgICAke1xyXG4gICAgICAgICAgICBzY3JlZW5zaG90UGF0aFxyXG4gICAgICAgICAgICAgID8gYDxpbWcgY2xhc3M9XCJzYi1lbmQtc2NyZWVuLWltYWdlXCIgc3JjPVwiJHtzY3JlZW5zaG90UGF0aH1cIiBhbHQ9XCIke3RpdGxlfVwiIC8+YFxyXG4gICAgICAgICAgICAgIDogYDxkaXYgY2xhc3M9XCJzYi1lbmQtc2NyZWVuLWltYWdlIHNiLW5vLWltYWdlXCI+Tm8gU2NyZWVuc2hvdDwvZGl2PmBcclxuICAgICAgICAgIH1cclxuICAgICAgICA8L2Rpdj5cclxuICAgICAgICA8aDMgY2xhc3M9XCJzYi1lbmQtc2NyZWVuLW5hbWVcIj4ke3RpdGxlfTwvaDM+XHJcbiAgICAgICAgPHAgY2xhc3M9XCJzYi1lbmQtc2NyZWVuLXN0YXRzXCI+JHtzdGF0c0h0bWx9PC9wPlxyXG4gICAgICAgIDxidXR0b24gaWQ9XCJzYi1uZXctZ2F1bnRsZXRcIiBjbGFzcz1cImJ0biBidG4tcHJpbWFyeVwiPiR7YnV0dG9uTGFiZWx9PC9idXR0b24+XHJcbiAgICAgIDwvZGl2PlxyXG4gICAgYDtcclxufVxyXG5cclxuLyoqIFJlbmRlciBhbiBlbmQgc2NyZWVuLCBoaWRlIGJhdHRsZSBjb250cm9scywgYW5kIHdpcmUgdGhlIG5ldy1ydW4gYnV0dG9uLiAqL1xyXG5mdW5jdGlvbiBzaG93RW5kU2NyZWVuKGh0bWw6IHN0cmluZyk6IHZvaWQge1xyXG4gIGNvbnN0IGNvbXBhcmlzb25BcmVhID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzYi1jb21wYXJpc29uLWFyZWFcIik7XHJcbiAgaWYgKCFjb21wYXJpc29uQXJlYSkgcmV0dXJuO1xyXG5cclxuICBjb21wYXJpc29uQXJlYS5pbm5lckhUTUwgPSBodG1sO1xyXG5cclxuICBjb25zdCBhY3Rpb25zRWwgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIi5zYi1hY3Rpb25zXCIpO1xyXG4gIGlmIChhY3Rpb25zRWwpIGFjdGlvbnNFbC5zdHlsZS5kaXNwbGF5ID0gXCJub25lXCI7XHJcblxyXG4gIGNvbXBhcmlzb25BcmVhLnF1ZXJ5U2VsZWN0b3IoXCIjc2ItbmV3LWdhdW50bGV0XCIpPy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4ge1xyXG4gICAgaWYgKGFjdGlvbnNFbCkgYWN0aW9uc0VsLnN0eWxlLmRpc3BsYXkgPSBcIlwiO1xyXG4gICAgbG9hZE5ld1BhaXIoKTtcclxuICB9KTtcclxufVxyXG5cclxuLyoqIENhcHR1cmUgZGlzcGxheSB2YWx1ZXMsIGNsZWFyIHJ1biBzdGF0ZSwgdGhlbiBzaG93IHRoZSBlbmQgc2NyZWVuLiAqL1xyXG5mdW5jdGlvbiBmaW5pc2hSdW5TaG93RW5kU2NyZWVuKGh0bWw6IHN0cmluZyk6IHZvaWQge1xyXG4gIHJlc2V0R2F1bnRsZXRTdGF0ZSgpO1xyXG4gIHNhdmVTdGF0ZSgpO1xyXG4gIHNob3dFbmRTY3JlZW4oaHRtbCk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBzaG93VmljdG9yeVNjcmVlbihjaGFtcGlvbjogU2NlbmUpOiB2b2lkIHtcclxuICBjb25zdCB0b3RhbFNjZW5lcyA9IHN0YXRlLnRvdGFsU2NlbmVzQ291bnQ7XHJcbiAgY29uc3Qgd2luU3RyZWFrID0gc3RhdGUuZ2F1bnRsZXRXaW5zO1xyXG5cclxuICBjb25zdCBodG1sID0gYnVpbGRFbmRTY3JlZW5IdG1sKFxyXG4gICAgY2hhbXBpb24sXHJcbiAgICBcIvCfkZFcIixcclxuICAgIFwiQ0hBTVBJT04hXCIsXHJcbiAgICBgQ29ucXVlcmVkIGFsbCAke3RvdGFsU2NlbmVzfSBzY2VuZXMgd2l0aCBhICR7d2luU3RyZWFrfSB3aW4gc3RyZWFrIWAsXHJcbiAgICBcIlN0YXJ0IE5ldyBHYXVudGxldFwiLFxyXG4gICk7XHJcblxyXG4gIGZpbmlzaFJ1blNob3dFbmRTY3JlZW4oaHRtbCk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiBzaG93UGxhY2VtZW50U2NyZWVuKHNjZW5lOiBTY2VuZSwgcmFuazogbnVtYmVyLCBmaW5hbFJhdGluZzogbnVtYmVyKTogdm9pZCB7XHJcbiAgY29uc3QgaHRtbCA9IGJ1aWxkRW5kU2NyZWVuSHRtbChcclxuICAgIHNjZW5lLFxyXG4gICAgXCLwn5ONXCIsXHJcbiAgICBcIlBMQUNFRCFcIixcclxuICAgIGBSYW5rIDxzdHJvbmc+IyR7cmFua308L3N0cm9uZz4gb2YgJHtzdGF0ZS50b3RhbFNjZW5lc0NvdW50fTxicj5SYXRpbmc6IDxzdHJvbmc+JHtmaW5hbFJhdGluZ30vMTAwPC9zdHJvbmc+YCxcclxuICAgIFwiU3RhcnQgTmV3IFJ1blwiLFxyXG4gICk7XHJcblxyXG4gIGZpbmlzaFJ1blNob3dFbmRTY3JlZW4oaHRtbCk7XHJcbn1cclxuIiwgIi8vIENvcmUgY29tcGFyaXNvbiBVSTogbGF5b3V0LCBwYWlyIHJlbmRlcmluZywgY2hvaWNlIGhhbmRsaW5nLCBhbmltYXRpb25zLlxuXG5pbXBvcnQgeyBjbGVhckZpbHRlcmVkQ2FjaGUsIGdldEFsbFNjZW5lc0NhY2hlZCwgcmVtb3ZlRnJvbUZpbHRlcmVkUG9vbCB9IGZyb20gXCIuLi9jYWNoZVwiO1xuaW1wb3J0IHsgY2FsY3VsYXRlUmF0aW5nQ2hhbmdlcyB9IGZyb20gXCIuLi9lbG9cIjtcbmltcG9ydCB7IGZldGNoU2NlbmVCeUlkIH0gZnJvbSBcIi4uL2dyYXBocWxcIjtcbmltcG9ydCB7IG5hdmlnYXRlVG9VcmwgfSBmcm9tIFwiLi4vbmF2aWdhdGlvblwiO1xuaW1wb3J0IHtcbiAgZmV0Y2hDaGFtcGlvblBhaXIsXG4gIGZldGNoR2F1bnRsZXRQYWlyLFxuICBmZXRjaFN3aXNzUGFpcixcbn0gZnJvbSBcIi4uL3BhaXJzXCI7XG5pbXBvcnQgeyB1cGRhdGVTY2VuZVJhdGluZyB9IGZyb20gXCIuLi9yYXRpbmdcIjtcbmltcG9ydCB7IHN0YXRlIH0gZnJvbSBcIi4uL3N0YXRlXCI7XG5pbXBvcnQgeyBzYXZlU3RhdGUgfSBmcm9tIFwiLi4vc3RvcmFnZVwiO1xuaW1wb3J0IHR5cGUgeyBCYXR0bGVTaWRlLCBDb21wYXJpc29uRGVsdGFzLCBNb2RlLCBSYW5rLCBTY2VuZSB9IGZyb20gXCIuLi90eXBlc1wiO1xuaW1wb3J0IHsgY3JlYXRlU2NlbmVDYXJkIH0gZnJvbSBcIi4vc2NlbmVDYXJkXCI7XG5pbXBvcnQgeyBzaG93UGxhY2VtZW50U2NyZWVuLCBzaG93VmljdG9yeVNjcmVlbiB9IGZyb20gXCIuL3NjcmVlbnNcIjtcblxuZXhwb3J0IGZ1bmN0aW9uIGNyZWF0ZU1haW5VSSgpOiBzdHJpbmcge1xuICByZXR1cm4gYFxuICAgICAgPGRpdiBpZD1cInN0YXNoLWJhdHRsZS1jb250YWluZXJcIiBjbGFzcz1cInNiLWNvbnRhaW5lclwiPlxuICAgICAgICA8ZGl2IGNsYXNzPVwic2ItaGVhZGVyXCI+XG4gICAgICAgICAgPGgxIGNsYXNzPVwic2ItdGl0bGVcIj7impTvuI8gU3Rhc2ggQmF0dGxlPC9oMT5cbiAgICAgICAgICA8cCBjbGFzcz1cInNiLXN1YnRpdGxlXCI+Q29tcGFyZSBzY2VuZXMgaGVhZC10by1oZWFkIHRvIGJ1aWxkIHlvdXIgcmFua2luZ3M8L3A+XG5cbiAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItbW9kZS10b2dnbGVcIj5cbiAgICAgICAgICAgIDxidXR0b24gY2xhc3M9XCJzYi1tb2RlLWJ0biAke3N0YXRlLmN1cnJlbnRNb2RlID09PSBcInN3aXNzXCIgPyBcImFjdGl2ZVwiIDogXCJcIn1cIiBkYXRhLW1vZGU9XCJzd2lzc1wiPlxuICAgICAgICAgICAgICA8c3BhbiBjbGFzcz1cInNiLW1vZGUtaWNvblwiPuKalu+4jzwvc3Bhbj5cbiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9XCJzYi1tb2RlLXRpdGxlXCI+U3dpc3M8L3NwYW4+XG4gICAgICAgICAgICAgIDxzcGFuIGNsYXNzPVwic2ItbW9kZS1kZXNjXCI+RmFpciBtYXRjaHVwczwvc3Bhbj5cbiAgICAgICAgICAgIDwvYnV0dG9uPlxuICAgICAgICAgICAgPGJ1dHRvbiBjbGFzcz1cInNiLW1vZGUtYnRuICR7c3RhdGUuY3VycmVudE1vZGUgPT09IFwiZ2F1bnRsZXRcIiA/IFwiYWN0aXZlXCIgOiBcIlwifVwiIGRhdGEtbW9kZT1cImdhdW50bGV0XCI+XG4gICAgICAgICAgICAgIDxzcGFuIGNsYXNzPVwic2ItbW9kZS1pY29uXCI+8J+Orzwvc3Bhbj5cbiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9XCJzYi1tb2RlLXRpdGxlXCI+R2F1bnRsZXQ8L3NwYW4+XG4gICAgICAgICAgICAgIDxzcGFuIGNsYXNzPVwic2ItbW9kZS1kZXNjXCI+UGxhY2UgYSBzY2VuZTwvc3Bhbj5cbiAgICAgICAgICAgIDwvYnV0dG9uPlxuICAgICAgICAgICAgPGJ1dHRvbiBjbGFzcz1cInNiLW1vZGUtYnRuICR7c3RhdGUuY3VycmVudE1vZGUgPT09IFwiY2hhbXBpb25cIiA/IFwiYWN0aXZlXCIgOiBcIlwifVwiIGRhdGEtbW9kZT1cImNoYW1waW9uXCI+XG4gICAgICAgICAgICAgIDxzcGFuIGNsYXNzPVwic2ItbW9kZS1pY29uXCI+8J+Phjwvc3Bhbj5cbiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9XCJzYi1tb2RlLXRpdGxlXCI+Q2hhbXBpb248L3NwYW4+XG4gICAgICAgICAgICAgIDxzcGFuIGNsYXNzPVwic2ItbW9kZS1kZXNjXCI+V2lubmVyIHN0YXlzIG9uPC9zcGFuPlxuICAgICAgICAgICAgPC9idXR0b24+XG4gICAgICAgICAgPC9kaXY+XG5cbiAgICAgICAgICA8ZGl2IGNsYXNzPVwic2Itb3Bwb25lbnRzLXRvZ2dsZVwiIHN0eWxlPVwibWFyZ2luLXRvcDo4cHg7XCI+XG4gICAgICAgICAgICA8bGFiZWw+XG4gICAgICAgICAgICAgIDxpbnB1dCB0eXBlPVwiY2hlY2tib3hcIiBpZD1cInNiLWZpbHRlci1vcHBvbmVudHMtY2hlY2tib3hcIiAke3N0YXRlLmZpbHRlck9wcG9uZW50cyA/IFwiY2hlY2tlZFwiIDogXCJcIn0+XG4gICAgICAgICAgICAgICBVc2UgZmlsdGVyZWQgc2NlbmVzIGZvciBib3RoIHNpZGVzXG4gICAgICAgICAgICA8L2xhYmVsPlxuICAgICAgICAgICAgPGxhYmVsIHN0eWxlPVwibWFyZ2luLWxlZnQ6MTZweDtcIj5cbiAgICAgICAgICAgICAgPGlucHV0IHR5cGU9XCJjaGVja2JveFwiIGlkPVwic2ItbXV0ZS1wcmV2aWV3cy1jaGVja2JveFwiICR7c3RhdGUubXV0ZVByZXZpZXdzID8gXCJjaGVja2VkXCIgOiBcIlwifT5cbiAgICAgICAgICAgICAgIE11dGUgaG92ZXIgcHJldmlld3NcbiAgICAgICAgICAgIDwvbGFiZWw+XG4gICAgICAgICAgPC9kaXY+XG4gICAgICAgIDwvZGl2PlxuXG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi1jb250ZW50XCI+XG4gICAgICAgICAgPGRpdiBpZD1cInNiLWNvbXBhcmlzb24tYXJlYVwiIGNsYXNzPVwic2ItY29tcGFyaXNvbi1hcmVhXCI+XG4gICAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItbG9hZGluZ1wiPkxvYWRpbmcgc2NlbmVzLi4uPC9kaXY+XG4gICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgPGRpdiBjbGFzcz1cInNiLWFjdGlvbnNcIj5cbiAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJzYi1hY3Rpb24tYnV0dG9uc1wiPlxuICAgICAgICAgICAgICA8YnV0dG9uIGlkPVwic2Itc2tpcC1idG5cIiBjbGFzcz1cImJ0biBidG4tc2Vjb25kYXJ5XCI+U2tpcCAoR2V0IE5ldyBQYWlyKTwvYnV0dG9uPlxuICAgICAgICAgICAgICA8YnV0dG9uIGlkPVwic2ItcmVmcmVzaC1jYWNoZS1idG5cIiBjbGFzcz1cImJ0biBidG4tc2Vjb25kYXJ5XCIgdGl0bGU9XCJSZWZyZXNoIHNjZW5lIGxpc3QgZnJvbSBzZXJ2ZXIgKHVzZSBpZiB5b3UndmUgYWRkZWQgbmV3IHNjZW5lcylcIj7wn5SEIFJlZnJlc2ggQ2FjaGU8L2J1dHRvbj5cbiAgICAgICAgICAgIDwvZGl2PlxuICAgICAgICAgICAgPGRpdiBjbGFzcz1cInNiLWtleWJvYXJkLWhpbnRcIj5cbiAgICAgICAgICAgICAgPHNwYW4+4oaQIExlZnQgQXJyb3c8L3NwYW4+IHRvIGNob29zZSBsZWZ0IMK3XG4gICAgICAgICAgICAgIDxzcGFuPuKGkiBSaWdodCBBcnJvdzwvc3Bhbj4gdG8gY2hvb3NlIHJpZ2h0IMK3XG4gICAgICAgICAgICAgIDxzcGFuPlNwYWNlPC9zcGFuPiB0byBza2lwXG4gICAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgPC9kaXY+XG4gICAgICA8L2Rpdj5cbiAgICBgO1xufVxuXG5mdW5jdGlvbiBjbGltYlN0YXR1c0JhZGdlKHNjZW5lOiBTY2VuZSk6IG51bWJlciB8IHN0cmluZyB8IG51bGwge1xuICBpZiAoc3RhdGUuY3VycmVudE1vZGUgIT09IFwiZ2F1bnRsZXRcIiAmJiBzdGF0ZS5jdXJyZW50TW9kZSAhPT0gXCJjaGFtcGlvblwiKSByZXR1cm4gbnVsbDtcbiAgaWYgKHN0YXRlLmdhdW50bGV0RmFsbGluZyAmJiBzdGF0ZS5nYXVudGxldEZhbGxpbmdTY2VuZT8uaWQgPT09IHNjZW5lLmlkKSB7XG4gICAgcmV0dXJuIFwi8J+TjSBGaW5kaW5nIGZpbmFsIHBsYWNlbWVudC4uLlwiO1xuICB9XG4gIGlmIChzdGF0ZS5nYXVudGxldENsaW1iZXI/LmlkID09PSBzY2VuZS5pZCkge1xuICAgIHJldHVybiBzdGF0ZS5nYXVudGxldFdpbnM7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbi8qKiBQcmVjb21wdXRlZCB3aW5uZXIvbG9zZXIgY29udGV4dCB3aXJlZCBhdCByZW5kZXIgdGltZSBmb3IgZWFjaCBjaG9vc2UgYnV0dG9uLiAqL1xuaW50ZXJmYWNlIFNjZW5lQ2hvaWNlIHtcbiAgd2lubmVyOiBTY2VuZTtcbiAgbG9zZXI6IFNjZW5lO1xuICBsZWZ0OiBTY2VuZTtcbiAgcmlnaHQ6IFNjZW5lO1xuICB3aW5uZXJDYXJkOiBIVE1MRWxlbWVudDtcbiAgbG9zZXJDYXJkOiBIVE1MRWxlbWVudDtcbiAgd2lubmVyUmFuazogUmFuaztcbiAgbG9zZXJSYW5rOiBSYW5rO1xufVxuXG5mdW5jdGlvbiBiaW5kU2NlbmVDaG9pY2UoYm9keTogSFRNTEVsZW1lbnQsIGNob2ljZTogU2NlbmVDaG9pY2UpOiB2b2lkIHtcbiAgYm9keS5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4gaGFuZGxlU2NlbmVDaG9pY2UoY2hvaWNlKSk7XG59XG5cbi8vIFNoYXJlZCByZW5kZXJpbmcgbG9naWMgZm9yIGRpc3BsYXlpbmcgYSBwYWlyIG9mIHNjZW5lc1xuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlclBhaXIoc2NlbmVzOiBTY2VuZVtdLCByYW5rczogUmFua1tdKTogdm9pZCB7XG4gIGNvbnN0IGNvbXBhcmlzb25BcmVhID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzYi1jb21wYXJpc29uLWFyZWFcIik7XG4gIGlmICghY29tcGFyaXNvbkFyZWEpIHJldHVybjtcblxuICBjb25zdCBzdGF0dXNCYWRnZXMgPSBzY2VuZXMubWFwKGNsaW1iU3RhdHVzQmFkZ2UpO1xuXG4gIGNvbXBhcmlzb25BcmVhLmlubmVySFRNTCA9IGBcbiAgICAgIDxkaXYgY2xhc3M9XCJzYi12cy1jb250YWluZXJcIj5cbiAgICAgICAgJHtjcmVhdGVTY2VuZUNhcmQoc2NlbmVzWzBdLCBcImxlZnRcIiwgcmFua3NbMF0sIHN0YXR1c0JhZGdlc1swXSl9XG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi12cy1kaXZpZGVyXCI+XG4gICAgICAgICAgPHNwYW4gY2xhc3M9XCJzYi12cy10ZXh0XCI+VlM8L3NwYW4+XG4gICAgICAgIDwvZGl2PlxuICAgICAgICAke2NyZWF0ZVNjZW5lQ2FyZChzY2VuZXNbMV0sIFwicmlnaHRcIiwgcmFua3NbMV0sIHN0YXR1c0JhZGdlc1sxXSl9XG4gICAgICA8L2Rpdj5cbiAgICBgO1xuXG4gIGNvbnN0IGxlZnQgPSBzY2VuZXNbMF07XG4gIGNvbnN0IHJpZ2h0ID0gc2NlbmVzWzFdO1xuICBjb25zdCBsZWZ0Q2FyZCA9IGNvbXBhcmlzb25BcmVhLnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KCcuc2Itc2NlbmUtY2FyZFtkYXRhLXNpZGU9XCJsZWZ0XCJdJyk7XG4gIGNvbnN0IHJpZ2h0Q2FyZCA9IGNvbXBhcmlzb25BcmVhLnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KCcuc2Itc2NlbmUtY2FyZFtkYXRhLXNpZGU9XCJyaWdodFwiXScpO1xuICBjb25zdCBsZWZ0Qm9keSA9IGxlZnRDYXJkPy5xdWVyeVNlbGVjdG9yPEhUTUxFbGVtZW50PihcIi5zYi1zY2VuZS1ib2R5XCIpO1xuICBjb25zdCByaWdodEJvZHkgPSByaWdodENhcmQ/LnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KFwiLnNiLXNjZW5lLWJvZHlcIik7XG5cbiAgaWYgKGxlZnQgJiYgcmlnaHQgJiYgbGVmdENhcmQgJiYgcmlnaHRDYXJkICYmIGxlZnRCb2R5ICYmIHJpZ2h0Qm9keSkge1xuICAgIGJpbmRTY2VuZUNob2ljZShsZWZ0Qm9keSwge1xuICAgICAgd2lubmVyOiBsZWZ0LFxuICAgICAgbG9zZXI6IHJpZ2h0LFxuICAgICAgbGVmdCxcbiAgICAgIHJpZ2h0LFxuICAgICAgd2lubmVyQ2FyZDogbGVmdENhcmQsXG4gICAgICBsb3NlckNhcmQ6IHJpZ2h0Q2FyZCxcbiAgICAgIHdpbm5lclJhbms6IHJhbmtzWzBdLFxuICAgICAgbG9zZXJSYW5rOiByYW5rc1sxXSxcbiAgICB9KTtcbiAgICBiaW5kU2NlbmVDaG9pY2UocmlnaHRCb2R5LCB7XG4gICAgICB3aW5uZXI6IHJpZ2h0LFxuICAgICAgbG9zZXI6IGxlZnQsXG4gICAgICBsZWZ0LFxuICAgICAgcmlnaHQsXG4gICAgICB3aW5uZXJDYXJkOiByaWdodENhcmQsXG4gICAgICBsb3NlckNhcmQ6IGxlZnRDYXJkLFxuICAgICAgd2lubmVyUmFuazogcmFua3NbMV0sXG4gICAgICBsb3NlclJhbms6IHJhbmtzWzBdLFxuICAgIH0pO1xuICB9XG5cbiAgLy8gQXR0YWNoIGNsaWNrLXRvLW9wZW4gKGZvciB0aHVtYm5haWwgb25seSkgLSB1c2UgUmVhY3QgUm91dGVyIG5hdmlnYXRpb25cbiAgY29tcGFyaXNvbkFyZWEucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oXCIuc2Itc2NlbmUtaW1hZ2UtY29udGFpbmVyXCIpLmZvckVhY2goKGNvbnRhaW5lcikgPT4ge1xuICAgIGNvbnN0IHNjZW5lVXJsID0gY29udGFpbmVyLmRhdGFzZXQuc2NlbmVVcmw7XG5cbiAgICBjb250YWluZXIuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHtcbiAgICAgIGlmIChzY2VuZVVybCkge1xuICAgICAgICBuYXZpZ2F0ZVRvVXJsKHNjZW5lVXJsKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfSk7XG5cbiAgLy8gQXR0YWNoIGhvdmVyIHByZXZpZXcgdG8gZW50aXJlIGNhcmRcbiAgY29tcGFyaXNvbkFyZWEucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oXCIuc2Itc2NlbmUtY2FyZFwiKS5mb3JFYWNoKChjYXJkKSA9PiB7XG4gICAgY29uc3QgdmlkZW8gPSBjYXJkLnF1ZXJ5U2VsZWN0b3I8SFRNTFZpZGVvRWxlbWVudD4oXCIuc2ItaG92ZXItcHJldmlld1wiKTtcbiAgICBpZiAoIXZpZGVvKSByZXR1cm47XG5cbiAgICBjYXJkLmFkZEV2ZW50TGlzdGVuZXIoXCJtb3VzZWVudGVyXCIsICgpID0+IHtcbiAgICAgIHZpZGVvLmN1cnJlbnRUaW1lID0gMDtcbiAgICAgIHZpZGVvLm11dGVkID0gc3RhdGUubXV0ZVByZXZpZXdzO1xuICAgICAgdmlkZW8udm9sdW1lID0gMC41O1xuICAgICAgdmlkZW8ucGxheSgpLmNhdGNoKCgpID0+IHt9KTtcbiAgICB9KTtcblxuICAgIGNhcmQuYWRkRXZlbnRMaXN0ZW5lcihcIm1vdXNlbGVhdmVcIiwgKCkgPT4ge1xuICAgICAgdmlkZW8ucGF1c2UoKTtcbiAgICAgIHZpZGVvLmN1cnJlbnRUaW1lID0gMDtcbiAgICB9KTtcbiAgfSk7XG5cbiAgLy8gVXBkYXRlIHNraXAgYnV0dG9uIHN0YXRlXG4gIGNvbnN0IHNraXBCdG4gPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9yPEhUTUxCdXR0b25FbGVtZW50PihcIiNzYi1za2lwLWJ0blwiKTtcbiAgaWYgKHNraXBCdG4pIHtcbiAgICBjb25zdCBkaXNhYmxlU2tpcCA9XG4gICAgICAoc3RhdGUuY3VycmVudE1vZGUgPT09IFwiZ2F1bnRsZXRcIiB8fCBzdGF0ZS5jdXJyZW50TW9kZSA9PT0gXCJjaGFtcGlvblwiKSAmJlxuICAgICAgc3RhdGUuZ2F1bnRsZXRDbGltYmVyICE9PSBudWxsO1xuICAgIHNraXBCdG4uZGlzYWJsZWQgPSBkaXNhYmxlU2tpcDtcbiAgICBza2lwQnRuLnN0eWxlLm9wYWNpdHkgPSBkaXNhYmxlU2tpcCA/IFwiMC41XCIgOiBcIjFcIjtcbiAgICBza2lwQnRuLnN0eWxlLmN1cnNvciA9IGRpc2FibGVTa2lwID8gXCJub3QtYWxsb3dlZFwiIDogXCJwb2ludGVyXCI7XG4gIH1cbn1cblxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGxvYWROZXdQYWlyKGZvcmNlZExlZnRTY2VuZUlkOiBzdHJpbmcgfCBudWxsID0gbnVsbCk6IFByb21pc2U8dm9pZD4ge1xuICBzdGF0ZS5kaXNhYmxlQ2hvaWNlID0gZmFsc2U7XG4gIGNvbnN0IGNvbXBhcmlzb25BcmVhID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzYi1jb21wYXJpc29uLWFyZWFcIik7XG4gIGlmICghY29tcGFyaXNvbkFyZWEpIHJldHVybjtcblxuICBjb25zb2xlLmxvZyhcbiAgICBgW1N0YXNoIEJhdHRsZV0g8J+OriBMb2FkaW5nIG5ldyBwYWlyIChtb2RlOiAke3N0YXRlLmN1cnJlbnRNb2RlfSkke2ZvcmNlZExlZnRTY2VuZUlkID8gYCB3aXRoIGZvcmNlZCBzY2VuZSAke2ZvcmNlZExlZnRTY2VuZUlkfWAgOiBcIlwifS4uLmAsXG4gICk7XG4gIGNvbnN0IHN0YXJ0VGltZSA9IERhdGUubm93KCk7XG5cbiAgLy8gT25seSBzaG93IGxvYWRpbmcgb24gZmlyc3QgbG9hZCAod2hlbiBlbXB0eSBvciBhbHJlYWR5IHNob3dpbmcgbG9hZGluZylcbiAgaWYgKCFjb21wYXJpc29uQXJlYS5xdWVyeVNlbGVjdG9yKFwiLnNiLXZzLWNvbnRhaW5lclwiKSkge1xuICAgIGNvbnN0IGhhc0NhY2hlID0gc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzICE9PSBudWxsO1xuICAgIGNvbXBhcmlzb25BcmVhLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPVwic2ItbG9hZGluZ1wiPiR7aGFzQ2FjaGUgPyBcIkxvYWRpbmcgc2NlbmVzLi4uXCIgOiBcIkxvYWRpbmcgYW5kIGNhY2hpbmcgc2NlbmVzIChmaXJzdCBsb2FkIG1heSB0YWtlIGEgbW9tZW50KS4uLlwifTwvZGl2PmA7XG4gIH1cblxuICB0cnkge1xuICAgIC8vIEZldGNoIGZvcmNlZCBzY2VuZSBkYXRhIGlmIGEgc2NlbmUgSUQgd2FzIHByb3ZpZGVkXG4gICAgbGV0IGZvcmNlZExlZnRTY2VuZTogU2NlbmUgfCBudWxsID0gbnVsbDtcbiAgICBpZiAoZm9yY2VkTGVmdFNjZW5lSWQpIHtcbiAgICAgIGZvcmNlZExlZnRTY2VuZSA9IGF3YWl0IGZldGNoU2NlbmVCeUlkKGZvcmNlZExlZnRTY2VuZUlkKTtcbiAgICAgIGlmICghZm9yY2VkTGVmdFNjZW5lKSB7XG4gICAgICAgIGNvbnNvbGUud2FybihcIltTdGFzaCBCYXR0bGVdIENvdWxkIG5vdCBmZXRjaCBzY2VuZSBmcm9tIFVSTCwgZmFsbGluZyBiYWNrIHRvIG5vcm1hbCBwYWlyaW5nXCIpO1xuICAgICAgfVxuICAgIH1cblxuICAgIGxldCBzY2VuZXM6IFNjZW5lW10gPSBbXTtcbiAgICBsZXQgcmFua3M6IFJhbmtbXSA9IFtudWxsLCBudWxsXTtcblxuICAgIGlmIChzdGF0ZS5jdXJyZW50TW9kZSA9PT0gXCJnYXVudGxldFwiKSB7XG4gICAgICBjb25zdCBnYXVudGxldFJlc3VsdCA9IGF3YWl0IGZldGNoR2F1bnRsZXRQYWlyKGZvcmNlZExlZnRTY2VuZSk7XG5cbiAgICAgIC8vIENoZWNrIGZvciB2aWN0b3J5IChjaGFtcGlvbiByZWFjaGVkICMxKVxuICAgICAgaWYgKGdhdW50bGV0UmVzdWx0LmlzVmljdG9yeSkge1xuICAgICAgICBzaG93VmljdG9yeVNjcmVlbihnYXVudGxldFJlc3VsdC5zY2VuZXNbMF0pO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIC8vIENoZWNrIGZvciBwbGFjZW1lbnQgKGZhbGxpbmcgc2NlbmUgaGl0IGJvdHRvbSlcbiAgICAgIGlmIChnYXVudGxldFJlc3VsdC5pc1BsYWNlbWVudCkge1xuICAgICAgICBzaG93UGxhY2VtZW50U2NyZWVuKFxuICAgICAgICAgIGdhdW50bGV0UmVzdWx0LnNjZW5lc1swXSxcbiAgICAgICAgICBnYXVudGxldFJlc3VsdC5wbGFjZW1lbnRSYW5rLFxuICAgICAgICAgIGdhdW50bGV0UmVzdWx0LnBsYWNlbWVudFJhdGluZyxcbiAgICAgICAgKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBzY2VuZXMgPSBnYXVudGxldFJlc3VsdC5zY2VuZXM7XG4gICAgICByYW5rcyA9IGdhdW50bGV0UmVzdWx0LnJhbmtzO1xuICAgIH0gZWxzZSBpZiAoc3RhdGUuY3VycmVudE1vZGUgPT09IFwiY2hhbXBpb25cIikge1xuICAgICAgY29uc3QgY2hhbXBpb25SZXN1bHQgPSBhd2FpdCBmZXRjaENoYW1waW9uUGFpcihmb3JjZWRMZWZ0U2NlbmUpO1xuXG4gICAgICAvLyBDaGVjayBmb3IgdmljdG9yeSAoY2hhbXBpb24gYmVhdCBldmVyeW9uZSlcbiAgICAgIGlmIChjaGFtcGlvblJlc3VsdC5pc1ZpY3RvcnkpIHtcbiAgICAgICAgc2hvd1ZpY3RvcnlTY3JlZW4oY2hhbXBpb25SZXN1bHQuc2NlbmVzWzBdKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBzY2VuZXMgPSBjaGFtcGlvblJlc3VsdC5zY2VuZXM7XG4gICAgICByYW5rcyA9IGNoYW1waW9uUmVzdWx0LnJhbmtzO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBzd2lzc1Jlc3VsdCA9IGF3YWl0IGZldGNoU3dpc3NQYWlyKGZvcmNlZExlZnRTY2VuZSk7XG5cbiAgICAgIHNjZW5lcyA9IHN3aXNzUmVzdWx0LnNjZW5lcztcbiAgICAgIHJhbmtzID0gc3dpc3NSZXN1bHQucmFua3M7XG4gICAgfVxuXG4gICAgaWYgKHNjZW5lcy5sZW5ndGggPCAyKSB7XG4gICAgICBjb21wYXJpc29uQXJlYS5pbm5lckhUTUwgPSAnPGRpdiBjbGFzcz1cInNiLWVycm9yXCI+Tm90IGVub3VnaCBzY2VuZXMgYXZhaWxhYmxlIGZvciBjb21wYXJpc29uLjwvZGl2Pic7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgc3RhdGUuY3VycmVudFBhaXIubGVmdCA9IHNjZW5lc1swXTtcbiAgICBzdGF0ZS5jdXJyZW50UGFpci5yaWdodCA9IHNjZW5lc1sxXTtcbiAgICBzdGF0ZS5jdXJyZW50UmFua3MubGVmdCA9IHJhbmtzWzBdO1xuICAgIHN0YXRlLmN1cnJlbnRSYW5rcy5yaWdodCA9IHJhbmtzWzFdO1xuXG4gICAgY29uc3QgbG9hZFRpbWUgPSBEYXRlLm5vdygpIC0gc3RhcnRUaW1lO1xuICAgIGNvbnNvbGUubG9nKFxuICAgICAgYFtTdGFzaCBCYXR0bGVdIOKchSBQYWlyIGxvYWRlZCBpbiAke2xvYWRUaW1lfW1zOiBTY2VuZSAke3NjZW5lc1swXS5pZH0gKHJhbmsgIyR7cmFua3NbMF19KSB2cyBTY2VuZSAke3NjZW5lc1sxXS5pZH0gKHJhbmsgIyR7cmFua3NbMV19KWAsXG4gICAgKTtcblxuICAgIHJlbmRlclBhaXIoc2NlbmVzLCByYW5rcyk7XG4gICAgc2F2ZVN0YXRlKCk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcihcIltTdGFzaCBCYXR0bGVdIEVycm9yIGxvYWRpbmcgc2NlbmVzOlwiLCBlcnJvcik7XG4gICAgY29uc3QgbWVzc2FnZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcbiAgICBjb25zdCBpc05vU2NlbmVzID0gbWVzc2FnZS5pbmNsdWRlcyhcIk5vIHNjZW5lc1wiKSB8fCBtZXNzYWdlLmluY2x1ZGVzKFwiTm90IGVub3VnaFwiKTtcbiAgICBjb21wYXJpc29uQXJlYS5pbm5lckhUTUwgPSBgXG4gICAgICAgIDxkaXYgY2xhc3M9XCJzYi1lcnJvci1zY3JlZW5cIj5cbiAgICAgICAgICA8ZGl2IGNsYXNzPVwic2ItZXJyb3ItaWNvblwiPuKaoO+4jzwvZGl2PlxuICAgICAgICAgIDxwIGNsYXNzPVwic2ItZXJyb3ItbWVzc2FnZVwiPiR7bWVzc2FnZX08L3A+XG4gICAgICAgICAgPGJ1dHRvbiBpZD1cInNiLWVycm9yLXJldHJ5XCIgY2xhc3M9XCJidG4gYnRuLXByaW1hcnlcIj5SZXRyeTwvYnV0dG9uPlxuICAgICAgICA8L2Rpdj5cbiAgICAgIGA7XG5cbiAgICAvLyBBdHRhY2ggcmV0cnkgaGFuZGxlclxuICAgIGNvbnN0IHJldHJ5QnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzYi1lcnJvci1yZXRyeVwiKSBhcyBIVE1MQnV0dG9uRWxlbWVudCB8IG51bGw7XG4gICAgaWYgKHJldHJ5QnRuKSB7XG4gICAgICByZXRyeUJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgICByZXRyeUJ0bi5kaXNhYmxlZCA9IHRydWU7XG4gICAgICAgIHJldHJ5QnRuLnRleHRDb250ZW50ID0gXCJMb2FkaW5nLi4uXCI7XG5cbiAgICAgICAgaWYgKGlzTm9TY2VuZXMpIHtcbiAgICAgICAgICAvLyBcIk5vIHNjZW5lc1wiIGVycm9yOiBjbGVhciBldmVyeXRoaW5nIGFuZCBzdGFydCBmcmVzaFxuICAgICAgICAgIGF3YWl0IGNsZWFyRmlsdGVyZWRDYWNoZSgpO1xuICAgICAgICAgIHN0YXRlLnNodWZmbGVkRmlsdGVyZWRTY2VuZXMgPSBbXTtcbiAgICAgICAgICBzdGF0ZS5zaHVmZmxlSW5kZXggPSAwO1xuICAgICAgICAgIHN0YXRlLnNodWZmbGVGaWx0ZXJLZXkgPSBudWxsO1xuICAgICAgICAgIHN0YXRlLnJlbW92ZWRTY2VuZUlkcy5jbGVhcigpO1xuICAgICAgICB9XG4gICAgICAgIC8vIE5ldHdvcmsvb3RoZXIgZXJyb3JzOiBqdXN0IHJldHJ5IHdpdGhvdXQgY2xlYXJpbmcgc2Vzc2lvbiBzdGF0ZVxuXG4gICAgICAgIGF3YWl0IGxvYWROZXdQYWlyKCk7XG4gICAgICB9KTtcbiAgICB9XG4gIH1cbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlc3RvcmVDdXJyZW50UGFpcigpOiB2b2lkIHtcbiAgc3RhdGUuZGlzYWJsZUNob2ljZSA9IGZhbHNlO1xuICBjb25zb2xlLmxvZyhcIltTdGFzaCBCYXR0bGVdIPCfk4IgUmVuZGVyaW5nIHNhdmVkIHBhaXIgKG5vIG5ldHdvcmsgZmV0Y2ggbmVlZGVkKVwiKTtcblxuICAvLyBQcmUtd2FybSB0aGUgY2FjaGUgaW4gYmFja2dyb3VuZCBmb3Igd2hlbiB1c2VyIG1ha2VzIGEgY2hvaWNlXG4gIGlmICghc3RhdGUubWVtb3J5Q2FjaGUuYWxsU2NlbmVzKSB7XG4gICAgY29uc29sZS5sb2coXCJbU3Rhc2ggQmF0dGxlXSDwn5SlIFByZS13YXJtaW5nIGNhY2hlIGluIGJhY2tncm91bmQuLi5cIik7XG4gICAgZ2V0QWxsU2NlbmVzQ2FjaGVkKCk7IC8vIERvbid0IGF3YWl0IC0gcnVucyBpbiBiYWNrZ3JvdW5kXG4gIH1cblxuICByZW5kZXJQYWlyKFxuICAgIFtzdGF0ZS5jdXJyZW50UGFpci5sZWZ0IGFzIFNjZW5lLCBzdGF0ZS5jdXJyZW50UGFpci5yaWdodCBhcyBTY2VuZV0sXG4gICAgW3N0YXRlLmN1cnJlbnRSYW5rcy5sZWZ0LCBzdGF0ZS5jdXJyZW50UmFua3MucmlnaHRdLFxuICApO1xufVxuXG5mdW5jdGlvbiBhY3RpdmVDbGltYmVySWQoKTogc3RyaW5nIHwgbnVsbCB7XG4gIGlmIChzdGF0ZS5nYXVudGxldEZhbGxpbmcgJiYgc3RhdGUuZ2F1bnRsZXRGYWxsaW5nU2NlbmUpIHtcbiAgICByZXR1cm4gc3RhdGUuZ2F1bnRsZXRGYWxsaW5nU2NlbmUuaWQ7XG4gIH1cbiAgcmV0dXJuIHN0YXRlLmdhdW50bGV0Q2xpbWJlcj8uaWQgPz8gbnVsbDtcbn1cblxuZnVuY3Rpb24gYmF0dGxlUm9sZUZvcihzY2VuZUlkOiBzdHJpbmcsIG1vZGU6IE1vZGUpOiBCYXR0bGVTaWRlW1wicm9sZVwiXSB7XG4gIGlmIChtb2RlID09PSBcInN3aXNzXCIpIHJldHVybiBcImNvbWJhdGFudFwiO1xuICBjb25zdCBjbGltYmVySWQgPSBhY3RpdmVDbGltYmVySWQoKTtcbiAgcmV0dXJuIGNsaW1iZXJJZCAhPT0gbnVsbCAmJiBzY2VuZUlkID09PSBjbGltYmVySWQgPyBcImNsaW1iZXJcIiA6IFwiYmVuY2htYXJrXCI7XG59XG5cbi8qKiBBcHBseSBjbGltYi9jaGFtcGlvbiBydWxlcyBvbiB0b3Agb2YgcmF3IHR3by1zaWRlZCBFTE8uIFN3aXNzIHVzZXMgdGhlIHJhdyByZXN1bHQgYXMtaXMuICovXG5mdW5jdGlvbiBhcHBseU1vZGVQb2xpY3koXG4gIHdpbm5lcjogU2NlbmUsXG4gIGxvc2VyOiBTY2VuZSxcbiAgbW9kZTogTW9kZSxcbiAgcmF3OiBDb21wYXJpc29uRGVsdGFzLFxuKTogQ29tcGFyaXNvbkRlbHRhcyB7XG4gIGlmIChtb2RlID09PSBcInN3aXNzXCIpIHJldHVybiByYXc7XG5cbiAgbGV0IHdpbm5lckRlbHRhID0gMDtcbiAgbGV0IGxvc2VyRGVsdGEgPSAwO1xuXG4gIGlmIChiYXR0bGVSb2xlRm9yKHdpbm5lci5pZCwgbW9kZSkgPT09IFwiY2xpbWJlclwiKSB7XG4gICAgd2lubmVyRGVsdGEgPSByYXcud2lubmVyO1xuICB9XG5cbiAgY29uc3QgbG9zZXJSYXRpbmcgPSBsb3Nlci5yYXRpbmcxMDAgfHwgMTtcbiAgLy8gU3BlY2lhbCBjYXNlOiBpZiAxMDAgcmF0ZWQgYmVuY2htYXJrIGxvc2VzLCB0aGV5IGRyb3AgdG8gOTkgc28gaXRzIGZ1bm5lciB0byBzZWUgYSBjaGFtcGlvbiBlbWVyZ2VcbiAgaWYgKGJhdHRsZVJvbGVGb3IobG9zZXIuaWQsIG1vZGUpID09PSBcImJlbmNobWFya1wiICYmIGxvc2VyUmF0aW5nID09PSAxMDApIHtcbiAgICBsb3NlckRlbHRhID0gLTE7XG4gIH1cblxuICByZXR1cm4geyB3aW5uZXI6IHdpbm5lckRlbHRhLCBsb3NlcjogbG9zZXJEZWx0YSB9O1xufVxuXG4vKiogUnVuIHB1cmUgRUxPIG1hdGggYW5kIHBlcnNpc3QgYW55IHJhdGluZyBjaGFuZ2VzIHRvIFN0YXNoLiAqL1xuZnVuY3Rpb24gcmVzb2x2ZUNvbXBhcmlzb24od2lubmVyOiBTY2VuZSwgbG9zZXI6IFNjZW5lKTogQ29tcGFyaXNvbkRlbHRhcyB7XG4gIGNvbnN0IG1vZGUgPSBzdGF0ZS5jdXJyZW50TW9kZTtcbiAgY29uc3Qgd2lubmVyUmF0aW5nID0gd2lubmVyLnJhdGluZzEwMCB8fCAxO1xuICBjb25zdCBsb3NlclJhdGluZyA9IGxvc2VyLnJhdGluZzEwMCB8fCAxO1xuICBjb25zdCByYXcgPSBjYWxjdWxhdGVSYXRpbmdDaGFuZ2VzKHtcbiAgICB3aW5uZXI6IHsgcmF0aW5nOiB3aW5uZXJSYXRpbmcsIHBsYXlDb3VudDogd2lubmVyLnBsYXlfY291bnQgPz8gMCB9LFxuICAgIGxvc2VyOiB7IHJhdGluZzogbG9zZXJSYXRpbmcsIHBsYXlDb3VudDogbG9zZXIucGxheV9jb3VudCA/PyAwIH0sXG4gIH0pO1xuICBjb25zdCBkZWx0YXMgPSBhcHBseU1vZGVQb2xpY3kod2lubmVyLCBsb3NlciwgbW9kZSwgcmF3KTtcblxuICBpZiAoZGVsdGFzLndpbm5lciAhPT0gMCkgdXBkYXRlU2NlbmVSYXRpbmcod2lubmVyLmlkLCB3aW5uZXJSYXRpbmcgKyBkZWx0YXMud2lubmVyKTtcbiAgaWYgKGRlbHRhcy5sb3NlciAhPT0gMCkgdXBkYXRlU2NlbmVSYXRpbmcobG9zZXIuaWQsIGxvc2VyUmF0aW5nICsgZGVsdGFzLmxvc2VyKTtcblxuICByZXR1cm4gZGVsdGFzO1xufVxuXG4vKiogR2F1bnRsZXQgY2xpbWIgLyBmaXJzdC1iYXR0bGUgcGF0aCAoYWZ0ZXIgZmFsbGluZy1tb2RlIGJyYW5jaCkuICovXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVHYXVudGxldENsaW1iQ2hvaWNlKGNob2ljZTogU2NlbmVDaG9pY2UpOiBQcm9taXNlPHZvaWQ+IHtcbiAgY29uc3Qge1xuICAgIHdpbm5lcjogd2lubmVyU2NlbmUsXG4gICAgbG9zZXI6IGxvc2VyU2NlbmUsXG4gICAgbGVmdCxcbiAgICB3aW5uZXJDYXJkLFxuICAgIGxvc2VyQ2FyZCxcbiAgfSA9IGNob2ljZTtcblxuICBjb25zdCB3aW5uZXJJZCA9IHdpbm5lclNjZW5lLmlkO1xuICBjb25zdCBsb3NlcklkID0gbG9zZXJTY2VuZS5pZDtcblxuICBjb25zdCBpc0ZpcnN0QmF0dGxlID0gIXN0YXRlLmdhdW50bGV0Q2xpbWJlcjtcblxuICAvLyBSZS12ZXJpZnkgZnJvbSB0aGUgYm90dG9tOiBjbGVhciBleGlzdGluZyByYXRpbmcgb24gZmlyc3QgY2hvaWNlLCBub3Qgb24gcGFpciBsb2FkXG4gIGlmIChpc0ZpcnN0QmF0dGxlICYmIGxlZnQucmF0aW5nMTAwICE9IG51bGwpIHtcbiAgICBjb25zb2xlLmxvZyhcbiAgICAgIGBbU3Rhc2ggQmF0dGxlXSDwn5OKIEdhdW50bGV0OiBjbGVhcmluZyByYXRpbmcgJHtsZWZ0LnJhdGluZzEwMH0gZm9yIHNjZW5lICR7bGVmdC5pZH0gb24gZmlyc3QgY2hvaWNlYCxcbiAgICApO1xuICAgIGF3YWl0IHVwZGF0ZVNjZW5lUmF0aW5nKGxlZnQuaWQsIG51bGwpO1xuICAgIGxlZnQucmF0aW5nMTAwID0gbnVsbDtcbiAgfVxuXG4gIGlmIChpc0ZpcnN0QmF0dGxlKSB7XG4gICAgc3RhdGUuZ2F1bnRsZXRDbGltYmVyID0gbGVmdDtcbiAgfVxuICBjb25zdCBjbGltYmVyID0gc3RhdGUuZ2F1bnRsZXRDbGltYmVyIGFzIFNjZW5lO1xuXG4gIGNvbnN0IHdpbm5lclJhdGluZyA9IHdpbm5lclNjZW5lLnJhdGluZzEwMCB8fCAxO1xuICBjb25zdCBsb3NlckRpc3BsYXlSYXRpbmcgPSBsb3NlclNjZW5lLnJhdGluZzEwMCB8fCAwO1xuXG4gIGNvbnN0IHsgd2lubmVyOiB3aW5uZXJEZWx0YSwgbG9zZXI6IGxvc2VyRGVsdGEgfSA9IHJlc29sdmVDb21wYXJpc29uKHdpbm5lclNjZW5lLCBsb3NlclNjZW5lKTtcbiAgY29uc3QgbmV3V2lubmVyUmF0aW5nID0gd2lubmVyUmF0aW5nICsgd2lubmVyRGVsdGE7XG4gIGNvbnN0IG5ld0xvc2VyUmF0aW5nID0gbG9zZXJEaXNwbGF5UmF0aW5nICsgbG9zZXJEZWx0YTtcblxuICBpZiAod2lubmVySWQgPT09IGNsaW1iZXIuaWQpIHtcbiAgICBzdGF0ZS5nYXVudGxldERlZmVhdGVkLnB1c2gobG9zZXJJZCk7XG4gICAgc3RhdGUuZ2F1bnRsZXRXaW5zKys7XG4gICAgY2xpbWJlci5yYXRpbmcxMDAgPSBuZXdXaW5uZXJSYXRpbmc7XG4gICAgY29uc29sZS5sb2coXG4gICAgICBgW1N0YXNoIEJhdHRsZV0g8J+TiiBHYXVudGxldDogY2xpbWJlciAke3dpbm5lcklkfSB3b24gKHN0cmVhaz0ke3N0YXRlLmdhdW50bGV0V2luc30pLCByYXRpbmcg4oaSICR7bmV3V2lubmVyUmF0aW5nfWAsXG4gICAgKTtcbiAgfSBlbHNlIGlmIChpc0ZpcnN0QmF0dGxlKSB7XG4gICAgLy8gQ2hhbGxlbmdlciBsb3N0IHRoZSBmbG9vciB0ZXN0IOKAlCBwbGFjZWQgb25lIGJlbG93IHRoZSBmbG9vciBiZW5jaG1hcmtcbiAgICBjb25zdCBmaW5hbFJhbmsgPSBzdGF0ZS50b3RhbFNjZW5lc0NvdW50O1xuICAgIGNvbnN0IGZpbmFsUmF0aW5nID0gTWF0aC5tYXgoMSwgKHdpbm5lclNjZW5lLnJhdGluZzEwMCB8fCAxKSAtIDEpO1xuICAgIGNvbnNvbGUubG9nKFxuICAgICAgYFtTdGFzaCBCYXR0bGVdIPCfk4ogR2F1bnRsZXQ6IGZpcnN0IGJhdHRsZSwgY2hhbGxlbmdlciAke2xvc2VySWR9IGxvc3QgdG8gZmxvb3Ig4oaSIHJhbmsgIyR7ZmluYWxSYW5rfSwgcmF0aW5nICR7ZmluYWxSYXRpbmd9YCxcbiAgICApO1xuICAgIHVwZGF0ZVNjZW5lUmF0aW5nKGxvc2VyU2NlbmUuaWQsIGZpbmFsUmF0aW5nKTtcblxuICAgIHdpbm5lckNhcmQuY2xhc3NMaXN0LmFkZChcInNiLXdpbm5lclwiKTtcbiAgICBpZiAobG9zZXJDYXJkKSBsb3NlckNhcmQuY2xhc3NMaXN0LmFkZChcInNiLWxvc2VyXCIpO1xuXG4gICAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICBzaG93UGxhY2VtZW50U2NyZWVuKGxvc2VyU2NlbmUsIGZpbmFsUmFuaywgZmluYWxSYXRpbmcpO1xuICAgIH0sIDgwMCk7XG4gICAgcmV0dXJuO1xuICB9IGVsc2Uge1xuICAgIGNvbnNvbGUubG9nKFxuICAgICAgYFtTdGFzaCBCYXR0bGVdIPCfk4ogR2F1bnRsZXQ6IGNsaW1iZXIgJHtjbGltYmVyLmlkfShyYXRpbmc9JHtjbGltYmVyLnJhdGluZzEwMH0pIExPU1QgdG8gJHt3aW5uZXJJZH0ocmF0aW5nPSR7bmV3V2lubmVyUmF0aW5nfSksIGVudGVyaW5nIGZhbGxpbmcgbW9kZWAsXG4gICAgKTtcbiAgICBzdGF0ZS5nYXVudGxldEZhbGxpbmcgPSB0cnVlO1xuICAgIHN0YXRlLmdhdW50bGV0RmFsbGluZ1NjZW5lID0gbG9zZXJTY2VuZTtcbiAgICBzdGF0ZS5nYXVudGxldERlZmVhdGVkID0gW3dpbm5lcklkXTtcbiAgfVxuXG4gIHNhdmVTdGF0ZSgpO1xuXG4gIHdpbm5lckNhcmQuY2xhc3NMaXN0LmFkZChcInNiLXdpbm5lclwiKTtcbiAgaWYgKGxvc2VyQ2FyZCkgbG9zZXJDYXJkLmNsYXNzTGlzdC5hZGQoXCJzYi1sb3NlclwiKTtcblxuICBzaG93UmF0aW5nQW5pbWF0aW9uKHdpbm5lckNhcmQsIHdpbm5lclJhdGluZywgbmV3V2lubmVyUmF0aW5nLCB0cnVlKTtcbiAgaWYgKGxvc2VyQ2FyZCkge1xuICAgIGNvbnN0IGxvc2VyRGlzcGxheU5ldyA9IGxvc2VyRGVsdGEgIT09IDAgPyBuZXdMb3NlclJhdGluZyA6IGxvc2VyRGlzcGxheVJhdGluZztcbiAgICBzaG93UmF0aW5nQW5pbWF0aW9uKGxvc2VyQ2FyZCwgbG9zZXJEaXNwbGF5UmF0aW5nLCBsb3NlckRpc3BsYXlOZXcsIGZhbHNlKTtcbiAgfVxuXG4gIHNldFRpbWVvdXQoKCkgPT4ge1xuICAgIGxvYWROZXdQYWlyKCk7XG4gIH0sIDE1MDApO1xufVxuXG5mdW5jdGlvbiBoYW5kbGVTY2VuZUNob2ljZShjaG9pY2U6IFNjZW5lQ2hvaWNlKTogdm9pZCB7XG4gIGlmIChzdGF0ZS5kaXNhYmxlQ2hvaWNlKSByZXR1cm47XG4gIHN0YXRlLmRpc2FibGVDaG9pY2UgPSB0cnVlO1xuXG4gIGNvbnN0IHtcbiAgICB3aW5uZXI6IHdpbm5lclNjZW5lLFxuICAgIGxvc2VyOiBsb3NlclNjZW5lLFxuICAgIGxlZnQsXG4gICAgcmlnaHQsXG4gICAgd2lubmVyQ2FyZCxcbiAgICBsb3NlckNhcmQsXG4gICAgbG9zZXJSYW5rLFxuICB9ID0gY2hvaWNlO1xuXG4gIGNvbnN0IHdpbm5lcklkID0gd2lubmVyU2NlbmUuaWQ7XG4gIGNvbnN0IGxvc2VySWQgPSBsb3NlclNjZW5lLmlkO1xuICBjb25zdCB3aW5uZXJSYXRpbmcgPSB3aW5uZXJTY2VuZS5yYXRpbmcxMDAgfHwgMTtcbiAgY29uc3QgbG9zZXJSYXRpbmcgPSBsb3NlclNjZW5lLnJhdGluZzEwMCB8fCAxO1xuICBjb25zdCBsb3NlckRpc3BsYXlSYXRpbmcgPSBsb3NlclNjZW5lLnJhdGluZzEwMCB8fCAwO1xuXG4gIC8vIEhhbmRsZSBnYXVudGxldCBtb2RlIChjbGltYmVyIHRyYWNraW5nKVxuICBpZiAoc3RhdGUuY3VycmVudE1vZGUgPT09IFwiZ2F1bnRsZXRcIikge1xuICAgIC8vIENoZWNrIGlmIHdlJ3JlIGluIGZhbGxpbmcgbW9kZSAoZmluZGluZyBmbG9vciBhZnRlciBhIGxvc3MpXG4gICAgaWYgKHN0YXRlLmdhdW50bGV0RmFsbGluZyAmJiBzdGF0ZS5nYXVudGxldEZhbGxpbmdTY2VuZSkge1xuICAgICAgY29uc3QgZmFsbGluZ1NjZW5lID0gc3RhdGUuZ2F1bnRsZXRGYWxsaW5nU2NlbmU7XG4gICAgICBjb25zb2xlLmxvZyhcbiAgICAgICAgYFtTdGFzaCBCYXR0bGVdIPCfk4ogRmFsbGluZyBtb2RlOiBmYWxsaW5nU2NlbmU9JHtmYWxsaW5nU2NlbmUuaWR9IHdpbm5lcklkPSR7d2lubmVySWR9IGxvc2VySWQ9JHtsb3NlcklkfSBsb3NlclJhdGluZz0ke2xvc2VyUmF0aW5nfWAsXG4gICAgICApO1xuICAgICAgaWYgKHdpbm5lcklkID09PSBmYWxsaW5nU2NlbmUuaWQpIHtcbiAgICAgICAgLy8gRmFsbGluZyBzY2VuZSB3b24gLSBmb3VuZCB0aGVpciBmbG9vciFcbiAgICAgICAgY29uc3QgZmluYWxSYXRpbmcgPSBNYXRoLm1pbigxMDAsIGxvc2VyUmF0aW5nICsgMSk7XG4gICAgICAgIGNvbnNvbGUubG9nKFxuICAgICAgICAgIGBbU3Rhc2ggQmF0dGxlXSDwn5OKIEZhbGxpbmcgc2NlbmUgZm91bmQgZmxvb3I6IGxvc2VyUmF0aW5nPSR7bG9zZXJSYXRpbmd9IOKGkiBmaW5hbFJhdGluZz0ke2ZpbmFsUmF0aW5nfWAsXG4gICAgICAgICk7XG4gICAgICAgIHVwZGF0ZVNjZW5lUmF0aW5nKGZhbGxpbmdTY2VuZS5pZCwgZmluYWxSYXRpbmcpO1xuXG4gICAgICAgIC8vIEZpbmFsIHJhbmsgaXMgb25lIGFib3ZlIHRoZSBvcHBvbmVudCAod2UgYmVhdCB0aGVtLCBzbyB3ZSdyZSBhYm92ZSB0aGVtKVxuICAgICAgICBjb25zdCBmaW5hbFJhbmsgPSBNYXRoLm1heCgxLCAobG9zZXJSYW5rID8/IDEpIC0gMSk7XG5cbiAgICAgICAgd2lubmVyQ2FyZC5jbGFzc0xpc3QuYWRkKFwic2Itd2lubmVyXCIpO1xuICAgICAgICBpZiAobG9zZXJDYXJkKSBsb3NlckNhcmQuY2xhc3NMaXN0LmFkZChcInNiLWxvc2VyXCIpO1xuXG4gICAgICAgIHNldFRpbWVvdXQoKCkgPT4ge1xuICAgICAgICAgIHNob3dQbGFjZW1lbnRTY3JlZW4oZmFsbGluZ1NjZW5lLCBmaW5hbFJhbmssIGZpbmFsUmF0aW5nKTtcbiAgICAgICAgfSwgODAwKTtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gRmFsbGluZyBzY2VuZSBsb3N0IGFnYWluIC0ga2VlcCBmYWxsaW5nXG4gICAgICAgIHN0YXRlLmdhdW50bGV0RGVmZWF0ZWQucHVzaCh3aW5uZXJJZCk7XG4gICAgICAgIHNhdmVTdGF0ZSgpO1xuXG4gICAgICAgIHdpbm5lckNhcmQuY2xhc3NMaXN0LmFkZChcInNiLXdpbm5lclwiKTtcbiAgICAgICAgaWYgKGxvc2VyQ2FyZCkgbG9zZXJDYXJkLmNsYXNzTGlzdC5hZGQoXCJzYi1sb3NlclwiKTtcblxuICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgICBsb2FkTmV3UGFpcigpO1xuICAgICAgICB9LCA4MDApO1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gQ2xpbWIgLyBmaXJzdCBiYXR0bGUgKGZhbGxpbmcgaGFuZGxlZCBhYm92ZSlcbiAgICB2b2lkIGhhbmRsZUdhdW50bGV0Q2xpbWJDaG9pY2UoY2hvaWNlKTtcbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBIYW5kbGUgY2hhbXBpb24gbW9kZSAobGlrZSBnYXVudGxldCBidXQgd2lubmVyIGFsd2F5cyB0YWtlcyBvdmVyKVxuICBpZiAoc3RhdGUuY3VycmVudE1vZGUgPT09IFwiY2hhbXBpb25cIikge1xuICAgIGNvbnN0IGlzRmlyc3RCYXR0bGUgPSAhc3RhdGUuZ2F1bnRsZXRDbGltYmVyO1xuICAgIGlmIChpc0ZpcnN0QmF0dGxlKSB7XG4gICAgICBzdGF0ZS5nYXVudGxldENsaW1iZXIgPSBsZWZ0O1xuICAgIH1cbiAgICBjb25zdCBjbGltYmVyID0gc3RhdGUuZ2F1bnRsZXRDbGltYmVyIGFzIFNjZW5lO1xuXG4gICAgY29uc3QgeyB3aW5uZXI6IHdpbm5lckRlbHRhLCBsb3NlcjogbG9zZXJEZWx0YSB9ID0gcmVzb2x2ZUNvbXBhcmlzb24od2lubmVyU2NlbmUsIGxvc2VyU2NlbmUpO1xuICAgIGNvbnN0IG5ld1dpbm5lclJhdGluZyA9IHdpbm5lclJhdGluZyArIHdpbm5lckRlbHRhO1xuICAgIGNvbnN0IG5ld0xvc2VyUmF0aW5nID0gbG9zZXJEaXNwbGF5UmF0aW5nICsgbG9zZXJEZWx0YTtcblxuICAgIGlmICh3aW5uZXJJZCA9PT0gY2xpbWJlci5pZCkge1xuICAgICAgLy8gQ2xpbWJlciB3b24gLSBjb250aW51ZSBjbGltYmluZ1xuICAgICAgc3RhdGUuZ2F1bnRsZXREZWZlYXRlZC5wdXNoKGxvc2VySWQpO1xuICAgICAgc3RhdGUuZ2F1bnRsZXRXaW5zKys7XG4gICAgICBjbGltYmVyLnJhdGluZzEwMCA9IG5ld1dpbm5lclJhdGluZztcbiAgICB9IGVsc2Uge1xuICAgICAgLy8gQ2xpbWJlciBsb3N0IG9yIGZpcnN0IHBpY2sgLSB3aW5uZXIgYmVjb21lcyBuZXcgY2xpbWJlclxuICAgICAgc3RhdGUuZ2F1bnRsZXRDbGltYmVyID0gd2lubmVyU2NlbmU7XG4gICAgICB3aW5uZXJTY2VuZS5yYXRpbmcxMDAgPSBuZXdXaW5uZXJSYXRpbmc7XG4gICAgICBzdGF0ZS5nYXVudGxldERlZmVhdGVkID0gW2xvc2VySWRdO1xuICAgICAgc3RhdGUuZ2F1bnRsZXRXaW5zID0gMTtcbiAgICB9XG5cbiAgICBzYXZlU3RhdGUoKTtcblxuICAgIHdpbm5lckNhcmQuY2xhc3NMaXN0LmFkZChcInNiLXdpbm5lclwiKTtcbiAgICBpZiAobG9zZXJDYXJkKSBsb3NlckNhcmQuY2xhc3NMaXN0LmFkZChcInNiLWxvc2VyXCIpO1xuXG4gICAgc2hvd1JhdGluZ0FuaW1hdGlvbih3aW5uZXJDYXJkLCB3aW5uZXJSYXRpbmcsIG5ld1dpbm5lclJhdGluZywgdHJ1ZSk7XG4gICAgaWYgKGxvc2VyQ2FyZCkge1xuICAgICAgY29uc3QgbG9zZXJEaXNwbGF5TmV3ID0gbG9zZXJEZWx0YSAhPT0gMCA/IG5ld0xvc2VyUmF0aW5nIDogbG9zZXJEaXNwbGF5UmF0aW5nO1xuICAgICAgc2hvd1JhdGluZ0FuaW1hdGlvbihsb3NlckNhcmQsIGxvc2VyRGlzcGxheVJhdGluZywgbG9zZXJEaXNwbGF5TmV3LCBmYWxzZSk7XG4gICAgfVxuXG4gICAgc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICBsb2FkTmV3UGFpcigpO1xuICAgIH0sIDE1MDApO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIEZvciBTd2lzczogQ2FsY3VsYXRlIGFuZCBzaG93IHJhdGluZyBjaGFuZ2VzXG4gIGNvbnN0IHsgd2lubmVyOiB3aW5uZXJEZWx0YSwgbG9zZXI6IGxvc2VyRGVsdGEgfSA9IHJlc29sdmVDb21wYXJpc29uKHdpbm5lclNjZW5lLCBsb3NlclNjZW5lKTtcbiAgY29uc3QgbmV3V2lubmVyUmF0aW5nID0gd2lubmVyUmF0aW5nICsgd2lubmVyRGVsdGE7XG4gIGNvbnN0IG5ld0xvc2VyUmF0aW5nID0gbG9zZXJEaXNwbGF5UmF0aW5nICsgbG9zZXJEZWx0YTtcblxuICAvLyBSZW1vdmUgYm90aCBzY2VuZXMgZnJvbSBmaWx0ZXJlZCBwb29sICh0aGV5J3ZlIGJlZW4gcHJvY2Vzc2VkKVxuICByZW1vdmVGcm9tRmlsdGVyZWRQb29sKGxlZnQuaWQpO1xuICByZW1vdmVGcm9tRmlsdGVyZWRQb29sKHJpZ2h0LmlkKTtcblxuICBzYXZlU3RhdGUoKTtcblxuICB3aW5uZXJDYXJkLmNsYXNzTGlzdC5hZGQoXCJzYi13aW5uZXJcIik7XG4gIGlmIChsb3NlckNhcmQpIGxvc2VyQ2FyZC5jbGFzc0xpc3QuYWRkKFwic2ItbG9zZXJcIik7XG5cbiAgc2hvd1JhdGluZ0FuaW1hdGlvbih3aW5uZXJDYXJkLCB3aW5uZXJSYXRpbmcsIG5ld1dpbm5lclJhdGluZywgdHJ1ZSk7XG4gIGlmIChsb3NlckNhcmQpIHtcbiAgICBjb25zdCBsb3NlckRpc3BsYXlOZXcgPSBsb3NlckRlbHRhICE9PSAwID8gbmV3TG9zZXJSYXRpbmcgOiBsb3NlckRpc3BsYXlSYXRpbmc7XG4gICAgc2hvd1JhdGluZ0FuaW1hdGlvbihsb3NlckNhcmQsIGxvc2VyRGlzcGxheVJhdGluZywgbG9zZXJEaXNwbGF5TmV3LCBmYWxzZSk7XG4gIH1cblxuICBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICBsb2FkTmV3UGFpcigpO1xuICB9LCAxNTAwKTtcbn1cblxuZnVuY3Rpb24gc2hvd1JhdGluZ0FuaW1hdGlvbihcbiAgY2FyZDogSFRNTEVsZW1lbnQsXG4gIG9sZFJhdGluZzogbnVtYmVyLFxuICBuZXdSYXRpbmc6IG51bWJlcixcbiAgaXNXaW5uZXI6IGJvb2xlYW4sXG4pOiB2b2lkIHtcbiAgY29uc3QgY2hhbmdlID0gbmV3UmF0aW5nIC0gb2xkUmF0aW5nO1xuICAvLyBDcmVhdGUgb3ZlcmxheVxuICBjb25zdCBvdmVybGF5ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgb3ZlcmxheS5jbGFzc05hbWUgPSBgc2ItcmF0aW5nLW92ZXJsYXkgJHtpc1dpbm5lciA/IFwic2ItcmF0aW5nLXdpbm5lclwiIDogXCJzYi1yYXRpbmctbG9zZXJcIn1gO1xuXG4gIGNvbnN0IHJhdGluZ0Rpc3BsYXkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICByYXRpbmdEaXNwbGF5LmNsYXNzTmFtZSA9IFwic2ItcmF0aW5nLWRpc3BsYXlcIjtcbiAgcmF0aW5nRGlzcGxheS50ZXh0Q29udGVudCA9IFN0cmluZyhvbGRSYXRpbmcpO1xuXG4gIGNvbnN0IGNoYW5nZURpc3BsYXkgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBjaGFuZ2VEaXNwbGF5LmNsYXNzTmFtZSA9IFwic2ItcmF0aW5nLWNoYW5nZVwiO1xuICBjaGFuZ2VEaXNwbGF5LnRleHRDb250ZW50ID0gaXNXaW5uZXIgPyBgKyR7Y2hhbmdlfWAgOiBgJHtjaGFuZ2V9YDtcblxuICBvdmVybGF5LmFwcGVuZENoaWxkKHJhdGluZ0Rpc3BsYXkpO1xuICBvdmVybGF5LmFwcGVuZENoaWxkKGNoYW5nZURpc3BsYXkpO1xuICBjYXJkLmFwcGVuZENoaWxkKG92ZXJsYXkpO1xuXG4gIC8vIEFuaW1hdGUgdGhlIHJhdGluZyBjb3VudGluZ1xuICBsZXQgY3VycmVudERpc3BsYXkgPSBvbGRSYXRpbmc7XG4gIGNvbnN0IHN0ZXAgPSBpc1dpbm5lciA/IDEgOiAtMTtcbiAgY29uc3QgdG90YWxTdGVwcyA9IE1hdGguYWJzKGNoYW5nZSk7XG4gIGxldCBzdGVwQ291bnQgPSAwO1xuXG4gIGNvbnN0IGludGVydmFsID0gc2V0SW50ZXJ2YWwoKCkgPT4ge1xuICAgIHN0ZXBDb3VudCsrO1xuICAgIGN1cnJlbnREaXNwbGF5ICs9IHN0ZXA7XG4gICAgcmF0aW5nRGlzcGxheS50ZXh0Q29udGVudCA9IFN0cmluZyhjdXJyZW50RGlzcGxheSk7XG5cbiAgICBpZiAoc3RlcENvdW50ID49IHRvdGFsU3RlcHMpIHtcbiAgICAgIGNsZWFySW50ZXJ2YWwoaW50ZXJ2YWwpO1xuICAgICAgcmF0aW5nRGlzcGxheS50ZXh0Q29udGVudCA9IFN0cmluZyhuZXdSYXRpbmcpO1xuICAgIH1cbiAgfSwgNTApO1xuXG4gIC8vIFJlbW92ZSBvdmVybGF5IGFmdGVyIGFuaW1hdGlvblxuICBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICBvdmVybGF5LnJlbW92ZSgpO1xuICB9LCAxNDAwKTtcbn1cbiIsICIvLyBUaGUgYmF0dGxlIG1vZGFsOiBvcGVucy9jbG9zZXMsIHdpcmVzIGNvbnRyb2xzIGFuZCBrZXlib2FyZCBzaG9ydGN1dHMuXG5cbmltcG9ydCB7IGNsZWFyU2NlbmVDYWNoZSB9IGZyb20gXCIuLi9jYWNoZVwiO1xuaW1wb3J0IHsgRklMVEVSX09QUE9ORU5UU19LRVksIE1VVEVfUFJFVklFV1NfS0VZIH0gZnJvbSBcIi4uL2NvbnN0YW50c1wiO1xuaW1wb3J0IHsgZ2V0U2NlbmVJZEZyb21VcmwgfSBmcm9tIFwiLi4vZ3JhcGhxbFwiO1xuaW1wb3J0IHsgcmVzZXRHYXVudGxldFN0YXRlLCBzdGF0ZSB9IGZyb20gXCIuLi9zdGF0ZVwiO1xuaW1wb3J0IHsgbG9hZFN0YXRlLCBzYXZlU3RhdGUgfSBmcm9tIFwiLi4vc3RvcmFnZVwiO1xuaW1wb3J0IHR5cGUgeyBNb2RlIH0gZnJvbSBcIi4uL3R5cGVzXCI7XG5pbXBvcnQgeyBjcmVhdGVNYWluVUksIGxvYWROZXdQYWlyLCByZXN0b3JlQ3VycmVudFBhaXIgfSBmcm9tIFwiLi9tYWluVUlcIjtcblxuLy8gVHJhY2sga2V5Ym9hcmQgaGFuZGxlciBzbyB3ZSBjYW4gcmVtb3ZlIGl0IG9uIGNsb3NlXG5sZXQgbW9kYWxLZXlIYW5kbGVyOiAoKGU6IEtleWJvYXJkRXZlbnQpID0+IHZvaWQpIHwgbnVsbCA9IG51bGw7XG5cbmV4cG9ydCBmdW5jdGlvbiBvcGVuTW9kYWwoKTogdm9pZCB7XG4gIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+OryBPcGVuaW5nIG1vZGFsLi4uXCIpO1xuXG4gIC8vIFBhdXNlIGFsbCBtZWRpYSBwbGF5aW5nIGluIHN0YXNoIHdoZW4gYmF0dGxlIG1vZGFsIGlzIG9wZW5lZCB0byBwcmV2ZW50IGF1ZGlvIG92ZXJsYXAgd2l0aCBob3ZlciBwcmV2aWV3c1xuICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxNZWRpYUVsZW1lbnQ+KFwidmlkZW8sIGF1ZGlvXCIpLmZvckVhY2goKHYpID0+IHYucGF1c2UoKSk7XG5cbiAgLy8gVHJ5IHRvIGxvYWQgc2F2ZWQgc3RhdGVcbiAgY29uc3QgaGFzU3RhdGUgPSBsb2FkU3RhdGUoKTtcbiAgY29uc29sZS5sb2coYFtTdGFzaCBCYXR0bGVdIPCfk4sgTG9jYWxTdG9yYWdlIHN0YXRlOiAke2hhc1N0YXRlID8gXCJmb3VuZFwiIDogXCJub25lXCJ9YCk7XG5cbiAgLy8gQ2hlY2sgaWYgVVJMIGZpbHRlciBwYXJhbXMgaGF2ZSBjaGFuZ2VkIC0gaWYgc28sIHJlc2V0IHN0YXRlXG4gIGNvbnN0IGN1cnJlbnRGaWx0ZXJQYXJhbXMgPSB3aW5kb3cubG9jYXRpb24uc2VhcmNoO1xuICBjb25zdCBmaWx0ZXJzQ2hhbmdlZCA9IGhhc1N0YXRlICYmIHN0YXRlLnNhdmVkRmlsdGVyUGFyYW1zICE9PSBjdXJyZW50RmlsdGVyUGFyYW1zO1xuXG4gIGlmIChmaWx0ZXJzQ2hhbmdlZCkge1xuICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0gRmlsdGVyIHBhcmFtcyBjaGFuZ2VkLCByZXNldHRpbmcgZ2F1bnRsZXQgc3RhdGUgYW5kIGZpbHRlcmVkIGNhY2hlXCIpO1xuICAgIHN0YXRlLmN1cnJlbnRQYWlyID0geyBsZWZ0OiBudWxsLCByaWdodDogbnVsbCB9O1xuICAgIHN0YXRlLmN1cnJlbnRSYW5rcyA9IHsgbGVmdDogbnVsbCwgcmlnaHQ6IG51bGwgfTtcbiAgICByZXNldEdhdW50bGV0U3RhdGUoKTtcbiAgICBzdGF0ZS5zYXZlZEZpbHRlclBhcmFtcyA9IGN1cnJlbnRGaWx0ZXJQYXJhbXM7XG5cbiAgICAvLyBDbGVhciBmaWx0ZXJlZCBzY2VuZXMgY2FjaGUgKGJ1dCBrZWVwIGFsbCBzY2VuZXMgY2FjaGUpXG4gICAgc3RhdGUubWVtb3J5Q2FjaGUuZmlsdGVyZWRTY2VuZXMgPSBudWxsO1xuICAgIHN0YXRlLm1lbW9yeUNhY2hlLmZpbHRlcktleSA9IG51bGw7XG5cbiAgICAvLyBSZXNldCBzaHVmZmxlIGZvciBuZXcgZmlsdGVyXG4gICAgc3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lcyA9IFtdO1xuICAgIHN0YXRlLnNodWZmbGVJbmRleCA9IDA7XG4gICAgc3RhdGUuc2h1ZmZsZUZpbHRlcktleSA9IG51bGw7XG4gIH1cblxuICAvLyBEZXRlY3QgaWYgb3BlbmVkIGZyb20gYW4gaW5kaXZpZHVhbCBzY2VuZSBwYWdlIChlLmcuIC9zY2VuZXMvMTIzKVxuICBjb25zdCBzY2VuZVBhZ2VJZCA9IGdldFNjZW5lSWRGcm9tVXJsKCk7XG4gIGNvbnN0IHNjZW5lQWxyZWFkeUluUGFpciA9XG4gICAgc2NlbmVQYWdlSWQgJiZcbiAgICBzdGF0ZS5jdXJyZW50UGFpci5sZWZ0ICYmXG4gICAgc3RhdGUuY3VycmVudFBhaXIucmlnaHQgJiZcbiAgICAoU3RyaW5nKHN0YXRlLmN1cnJlbnRQYWlyLmxlZnQuaWQpID09PSBzY2VuZVBhZ2VJZCB8fFxuICAgICAgU3RyaW5nKHN0YXRlLmN1cnJlbnRQYWlyLnJpZ2h0LmlkKSA9PT0gc2NlbmVQYWdlSWQpO1xuICBjb25zdCBmb3JjZVNjZW5lQmF0dGxlID0gc2NlbmVQYWdlSWQgJiYgIXNjZW5lQWxyZWFkeUluUGFpcjtcblxuICBpZiAoZm9yY2VTY2VuZUJhdHRsZSkge1xuICAgIGNvbnNvbGUubG9nKGBbU3Rhc2ggQmF0dGxlXSDwn46vIE9wZW5lZCBmcm9tIHNjZW5lIHBhZ2UgJHtzY2VuZVBhZ2VJZH0sIHN0YXJ0aW5nIG5ldyBiYXR0bGUgd2l0aCB0aGlzIHNjZW5lYCk7XG4gICAgcmVzZXRHYXVudGxldFN0YXRlKCk7XG4gICAgc3RhdGUuY3VycmVudFBhaXIgPSB7IGxlZnQ6IG51bGwsIHJpZ2h0OiBudWxsIH07XG4gICAgc3RhdGUuY3VycmVudFJhbmtzID0geyBsZWZ0OiBudWxsLCByaWdodDogbnVsbCB9O1xuICB9XG5cbiAgLy8gQ2hlY2sgZm9yIGV4aXN0aW5nIGhpZGRlbiBtb2RhbCAtIHJldXNlIGl0XG4gIGNvbnN0IGV4aXN0aW5nTW9kYWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInNiLW1vZGFsXCIpO1xuICBpZiAoZXhpc3RpbmdNb2RhbCAmJiBleGlzdGluZ01vZGFsLmNsYXNzTGlzdC5jb250YWlucyhcInNiLW1vZGFsLWhpZGRlblwiKSkge1xuICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g4pm777iPIFJldXNpbmcgZXhpc3RpbmcgbW9kYWxcIik7XG4gICAgZXhpc3RpbmdNb2RhbC5jbGFzc0xpc3QucmVtb3ZlKFwic2ItbW9kYWwtaGlkZGVuXCIsIFwic2ItbW9kYWwtY2xvc2luZ1wiKTtcblxuICAgIC8vIFJlLXJlZ2lzdGVyIGtleWJvYXJkIGhhbmRsZXJcbiAgICBpZiAobW9kYWxLZXlIYW5kbGVyKSB7XG4gICAgICBkb2N1bWVudC5yZW1vdmVFdmVudExpc3RlbmVyKFwia2V5ZG93blwiLCBtb2RhbEtleUhhbmRsZXIsIHRydWUpO1xuICAgIH1cbiAgICBpZiAobW9kYWxLZXlIYW5kbGVyKSBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKFwia2V5ZG93blwiLCBtb2RhbEtleUhhbmRsZXIsIHRydWUpO1xuXG4gICAgLy8gRm9jdXMgbW9kYWwgY29udGVudFxuICAgIGNvbnN0IG1vZGFsQ29udGVudCA9IGV4aXN0aW5nTW9kYWwucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCIuc2ItbW9kYWwtY29udGVudFwiKTtcbiAgICBpZiAobW9kYWxDb250ZW50KSBtb2RhbENvbnRlbnQuZm9jdXMoKTtcblxuICAgIC8vIElmIGZpbHRlcnMgY2hhbmdlZCwgbm8gcGFpciwgb3IgZm9yY2VkIHNjZW5lLCBsb2FkIG5ldyBjb250ZW50XG4gICAgaWYgKGZvcmNlU2NlbmVCYXR0bGUpIHtcbiAgICAgIGxvYWROZXdQYWlyKHNjZW5lUGFnZUlkKTtcbiAgICB9IGVsc2UgaWYgKGZpbHRlcnNDaGFuZ2VkIHx8ICFzdGF0ZS5jdXJyZW50UGFpci5sZWZ0IHx8ICFzdGF0ZS5jdXJyZW50UGFpci5yaWdodCkge1xuICAgICAgbG9hZE5ld1BhaXIoKTtcbiAgICB9XG4gICAgLy8gT3RoZXJ3aXNlIHRoZSBleGlzdGluZyBjb250ZW50IGlzIHN0aWxsIHZhbGlkXG5cbiAgICByZXR1cm47XG4gIH1cblxuICAvLyBSZW1vdmUgYW55IG5vbi1oaWRkZW4gZXhpc3RpbmcgbW9kYWwgKHNob3VsZG4ndCBoYXBwZW4sIGJ1dCBzYWZldHkpXG4gIGlmIChleGlzdGluZ01vZGFsKSBleGlzdGluZ01vZGFsLnJlbW92ZSgpO1xuXG4gIC8vIEluaXRpYWxpemUgZmlsdGVyIHBhcmFtcyB0cmFja2luZ1xuICBpZiAoIXN0YXRlLnNhdmVkRmlsdGVyUGFyYW1zKSB7XG4gICAgc3RhdGUuc2F2ZWRGaWx0ZXJQYXJhbXMgPSBjdXJyZW50RmlsdGVyUGFyYW1zO1xuICB9XG5cbiAgY29uc3QgbW9kYWwgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KFwiZGl2XCIpO1xuICBtb2RhbC5pZCA9IFwic2ItbW9kYWxcIjtcbiAgbW9kYWwuaW5uZXJIVE1MID0gYFxuICAgICAgPGRpdiBjbGFzcz1cInNiLW1vZGFsLWJhY2tkcm9wXCI+PC9kaXY+XG4gICAgICA8ZGl2IGNsYXNzPVwic2ItbW9kYWwtY29udGVudFwiPlxuICAgICAgICA8YnV0dG9uIGNsYXNzPVwic2ItbW9kYWwtY2xvc2VcIj7inJU8L2J1dHRvbj5cbiAgICAgICAgJHtjcmVhdGVNYWluVUkoKX1cbiAgICAgIDwvZGl2PlxuICAgIGA7XG5cbiAgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZChtb2RhbCk7XG5cbiAgLy8gRm9jdXMgdGhlIG1vZGFsIGNvbnRlbnQgc28ga2V5Ym9hcmQgc2hvcnRjdXRzIHdvcmsgaW1tZWRpYXRlbHlcbiAgY29uc3QgbW9kYWxDb250ZW50ID0gbW9kYWwucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCIuc2ItbW9kYWwtY29udGVudFwiKTtcbiAgaWYgKG1vZGFsQ29udGVudCkge1xuICAgIG1vZGFsQ29udGVudC5zZXRBdHRyaWJ1dGUoXCJ0YWJpbmRleFwiLCBcIi0xXCIpO1xuICAgIG1vZGFsQ29udGVudC5zdHlsZS5vdXRsaW5lID0gXCJub25lXCI7XG4gICAgbW9kYWxDb250ZW50LmZvY3VzKCk7XG4gIH1cblxuICAvLyBNb2RlIHRvZ2dsZSBidXR0b25zXG4gIG1vZGFsLnF1ZXJ5U2VsZWN0b3JBbGw8SFRNTEVsZW1lbnQ+KFwiLnNiLW1vZGUtYnRuXCIpLmZvckVhY2goKGJ0bikgPT4ge1xuICAgIGJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4ge1xuICAgICAgY29uc3QgbmV3TW9kZSA9IGJ0bi5kYXRhc2V0Lm1vZGUgYXMgTW9kZTtcbiAgICAgIGlmIChuZXdNb2RlICE9PSBzdGF0ZS5jdXJyZW50TW9kZSkge1xuICAgICAgICBzdGF0ZS5jdXJyZW50TW9kZSA9IG5ld01vZGU7XG5cbiAgICAgICAgcmVzZXRHYXVudGxldFN0YXRlKCk7XG5cbiAgICAgICAgLy8gUmVzZXQgc2h1ZmZsZSB0byBzdGFydCBmcmVzaCB3aXRoIG5ldyBtb2RlXG4gICAgICAgIHN0YXRlLnNodWZmbGVJbmRleCA9IDA7XG5cbiAgICAgICAgLy8gVXBkYXRlIGJ1dHRvbiBzdGF0ZXNcbiAgICAgICAgbW9kYWwucXVlcnlTZWxlY3RvckFsbDxIVE1MRWxlbWVudD4oXCIuc2ItbW9kZS1idG5cIikuZm9yRWFjaCgoYikgPT4ge1xuICAgICAgICAgIGIuY2xhc3NMaXN0LnRvZ2dsZShcImFjdGl2ZVwiLCBiLmRhdGFzZXQubW9kZSA9PT0gc3RhdGUuY3VycmVudE1vZGUpO1xuICAgICAgICB9KTtcblxuICAgICAgICAvLyBSZS1zaG93IGFjdGlvbnMgKHNraXAgYnV0dG9uKSBpbiBjYXNlIGl0IHdhcyBoaWRkZW5cbiAgICAgICAgY29uc3QgYWN0aW9uc0VsID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCIuc2ItYWN0aW9uc1wiKTtcbiAgICAgICAgaWYgKGFjdGlvbnNFbCkgYWN0aW9uc0VsLnN0eWxlLmRpc3BsYXkgPSBcIlwiO1xuXG4gICAgICAgIC8vIExvYWQgbmV3IHBhaXIgaW4gbmV3IG1vZGUsIHByZXNlcnZpbmcgc2NlbmUgcGFnZSBjb250ZXh0XG4gICAgICAgIGxvYWROZXdQYWlyKGdldFNjZW5lSWRGcm9tVXJsKCkpO1xuICAgICAgICBzYXZlU3RhdGUoKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfSk7XG5cbiAgLy8gT3Bwb25lbnRzIGZpbHRlciBjaGVja2JveFxuICBjb25zdCBvcHBDaGVja2JveCA9IG1vZGFsLnF1ZXJ5U2VsZWN0b3I8SFRNTElucHV0RWxlbWVudD4oXCIjc2ItZmlsdGVyLW9wcG9uZW50cy1jaGVja2JveFwiKTtcbiAgaWYgKG9wcENoZWNrYm94KSB7XG4gICAgb3BwQ2hlY2tib3guYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoZSkgPT4ge1xuICAgICAgc3RhdGUuZmlsdGVyT3Bwb25lbnRzID0gKGUudGFyZ2V0IGFzIEhUTUxJbnB1dEVsZW1lbnQpLmNoZWNrZWQ7XG4gICAgICB0cnkge1xuICAgICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShGSUxURVJfT1BQT05FTlRTX0tFWSwgc3RhdGUuZmlsdGVyT3Bwb25lbnRzID8gXCIxXCIgOiBcIjBcIik7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogaWdub3JlICovXG4gICAgICB9XG4gICAgICAvLyBzd2l0Y2hpbmcgdGhlIHRvZ2dsZSBjb3VudHMgYXMgY2hhbmdpbmcgZmlsdGVyczogcmVzZXQgZ2F1bnRsZXQvY2hhbXBpb24gcnVuXG4gICAgICBpZiAoc3RhdGUuY3VycmVudE1vZGUgPT09IFwiZ2F1bnRsZXRcIiB8fCBzdGF0ZS5jdXJyZW50TW9kZSA9PT0gXCJjaGFtcGlvblwiKSB7XG4gICAgICAgIHJlc2V0R2F1bnRsZXRTdGF0ZSgpO1xuICAgICAgfVxuICAgICAgc2F2ZVN0YXRlKCk7XG4gICAgICBsb2FkTmV3UGFpcigpO1xuICAgIH0pO1xuICB9XG5cbiAgLy8gTXV0ZSBob3ZlciBwcmV2aWV3cyBjaGVja2JveFxuICBjb25zdCBtdXRlQ2hlY2tib3ggPSBtb2RhbC5xdWVyeVNlbGVjdG9yPEhUTUxJbnB1dEVsZW1lbnQ+KFwiI3NiLW11dGUtcHJldmlld3MtY2hlY2tib3hcIik7XG4gIGlmIChtdXRlQ2hlY2tib3gpIHtcbiAgICBtdXRlQ2hlY2tib3guYWRkRXZlbnRMaXN0ZW5lcihcImNoYW5nZVwiLCAoZSkgPT4ge1xuICAgICAgc3RhdGUubXV0ZVByZXZpZXdzID0gKGUudGFyZ2V0IGFzIEhUTUxJbnB1dEVsZW1lbnQpLmNoZWNrZWQ7XG4gICAgICB0cnkge1xuICAgICAgICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShNVVRFX1BSRVZJRVdTX0tFWSwgc3RhdGUubXV0ZVByZXZpZXdzID8gXCIxXCIgOiBcIjBcIik7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyogaWdub3JlICovXG4gICAgICB9XG4gICAgICAvLyBhcHBseSBpbW1lZGlhdGVseSB0byBhbnkgcHJldmlldyB2aWRlb3MgY3VycmVudGx5IHJlbmRlcmVkXG4gICAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsPEhUTUxWaWRlb0VsZW1lbnQ+KFwiLnNiLWhvdmVyLXByZXZpZXdcIikuZm9yRWFjaCgodikgPT4ge1xuICAgICAgICB2Lm11dGVkID0gc3RhdGUubXV0ZVByZXZpZXdzO1xuICAgICAgfSk7XG4gICAgfSk7XG4gIH1cblxuICAvLyBTa2lwIGJ1dHRvblxuICBjb25zdCBza2lwQnRuID0gbW9kYWwucXVlcnlTZWxlY3RvcihcIiNzYi1za2lwLWJ0blwiKTtcbiAgaWYgKHNraXBCdG4pIHtcbiAgICBza2lwQnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiB7XG4gICAgICAvLyBJbiBnYXVudGxldC9jaGFtcGlvbiBtb2RlIHdpdGggYWN0aXZlIHJ1biwgc2tpcCBpcyBkaXNhYmxlZFxuICAgICAgaWYgKChzdGF0ZS5jdXJyZW50TW9kZSA9PT0gXCJnYXVudGxldFwiIHx8IHN0YXRlLmN1cnJlbnRNb2RlID09PSBcImNoYW1waW9uXCIpICYmIHN0YXRlLmdhdW50bGV0Q2xpbWJlcikge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBpZiAoc3RhdGUuZGlzYWJsZUNob2ljZSkgcmV0dXJuO1xuICAgICAgc3RhdGUuZGlzYWJsZUNob2ljZSA9IHRydWU7XG4gICAgICAvLyBSZXNldCBzdGF0ZSBvbiBza2lwXG4gICAgICBpZiAoc3RhdGUuY3VycmVudE1vZGUgPT09IFwiZ2F1bnRsZXRcIiB8fCBzdGF0ZS5jdXJyZW50TW9kZSA9PT0gXCJjaGFtcGlvblwiKSB7XG4gICAgICAgIHJlc2V0R2F1bnRsZXRTdGF0ZSgpO1xuICAgICAgICBzYXZlU3RhdGUoKTtcbiAgICAgIH1cbiAgICAgIGxvYWROZXdQYWlyKCk7XG4gICAgfSk7XG4gIH1cblxuICAvLyBSZWZyZXNoIGNhY2hlIGJ1dHRvblxuICBjb25zdCByZWZyZXNoQ2FjaGVCdG4gPSBtb2RhbC5xdWVyeVNlbGVjdG9yPEhUTUxCdXR0b25FbGVtZW50PihcIiNzYi1yZWZyZXNoLWNhY2hlLWJ0blwiKTtcbiAgaWYgKHJlZnJlc2hDYWNoZUJ0bikge1xuICAgIHJlZnJlc2hDYWNoZUJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgYXN5bmMgKCkgPT4ge1xuICAgICAgaWYgKHN0YXRlLmRpc2FibGVDaG9pY2UpIHJldHVybjtcblxuICAgICAgcmVmcmVzaENhY2hlQnRuLmRpc2FibGVkID0gdHJ1ZTtcbiAgICAgIHJlZnJlc2hDYWNoZUJ0bi50ZXh0Q29udGVudCA9IFwi8J+UhCBSZWZyZXNoaW5nLi4uXCI7XG5cbiAgICAgIHRyeSB7XG4gICAgICAgIGF3YWl0IGNsZWFyU2NlbmVDYWNoZSgpO1xuXG4gICAgICAgIC8vIFJlc2V0IHNodWZmbGUgc3RhdGUgc2luY2Ugc2NlbmUgbGlzdCBpcyBiZWluZyByZWZyZXNoZWRcbiAgICAgICAgc3RhdGUuc2h1ZmZsZWRGaWx0ZXJlZFNjZW5lcyA9IFtdO1xuICAgICAgICBzdGF0ZS5zaHVmZmxlSW5kZXggPSAwO1xuICAgICAgICBzdGF0ZS5zaHVmZmxlRmlsdGVyS2V5ID0gbnVsbDtcbiAgICAgICAgc3RhdGUucmVtb3ZlZFNjZW5lSWRzLmNsZWFyKCk7IC8vIFJlc2V0IHJlbW92ZWQgdHJhY2tpbmcgZm9yIGZyZXNoIGRhdGFcblxuICAgICAgICAvLyBSZXNldCBnYXVudGxldCBzdGF0ZSBzaW5jZSByYW5raW5ncyBtYXkgaGF2ZSBjaGFuZ2VkXG4gICAgICAgIHJlc2V0R2F1bnRsZXRTdGF0ZSgpO1xuICAgICAgICBzYXZlU3RhdGUoKTtcblxuICAgICAgICAvLyBSZS1zaG93IGFjdGlvbnMgaW4gY2FzZSBoaWRkZW5cbiAgICAgICAgY29uc3QgYWN0aW9uc0VsID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oXCIuc2ItYWN0aW9uc1wiKTtcbiAgICAgICAgaWYgKGFjdGlvbnNFbCkgYWN0aW9uc0VsLnN0eWxlLmRpc3BsYXkgPSBcIlwiO1xuXG4gICAgICAgIGF3YWl0IGxvYWROZXdQYWlyKCk7XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IoXCJbU3Rhc2ggQmF0dGxlXSBSZWZyZXNoIGZhaWxlZDpcIiwgZSk7XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICByZWZyZXNoQ2FjaGVCdG4uZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAgICAgcmVmcmVzaENhY2hlQnRuLnRleHRDb250ZW50ID0gXCLwn5SEIFJlZnJlc2ggQ2FjaGVcIjtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxuXG4gIC8vIExvYWQgaW5pdGlhbCBjb21wYXJpc29uIG9yIHJlc3RvcmUgc2F2ZWQgcGFpclxuICBpZiAoZm9yY2VTY2VuZUJhdHRsZSkge1xuICAgIGNvbnNvbGUubG9nKGBbU3Rhc2ggQmF0dGxlXSDwn46vIFN0YXJ0aW5nIGJhdHRsZSB3aXRoIHNjZW5lICR7c2NlbmVQYWdlSWR9IGZyb20gc2NlbmUgcGFnZWApO1xuICAgIGxvYWROZXdQYWlyKHNjZW5lUGFnZUlkKTtcbiAgfSBlbHNlIGlmIChoYXNTdGF0ZSAmJiBzdGF0ZS5jdXJyZW50UGFpci5sZWZ0ICYmIHN0YXRlLmN1cnJlbnRQYWlyLnJpZ2h0ICYmICFmaWx0ZXJzQ2hhbmdlZCkge1xuICAgIGNvbnNvbGUubG9nKFxuICAgICAgYFtTdGFzaCBCYXR0bGVdIPCfk4IgUmVzdG9yaW5nIHNhdmVkIHBhaXIgZnJvbSBsb2NhbFN0b3JhZ2UgKFNjZW5lICR7c3RhdGUuY3VycmVudFBhaXIubGVmdC5pZH0gdnMgU2NlbmUgJHtzdGF0ZS5jdXJyZW50UGFpci5yaWdodC5pZH0pYCxcbiAgICApO1xuICAgIHJlc3RvcmVDdXJyZW50UGFpcigpO1xuICB9IGVsc2Uge1xuICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0g8J+GlSBObyBzYXZlZCBwYWlyIG9yIGZpbHRlcnMgY2hhbmdlZCwgbG9hZGluZyBuZXcgcGFpci4uLlwiKTtcbiAgICBsb2FkTmV3UGFpcigpO1xuICB9XG5cbiAgLy8gQ2xvc2UgaGFuZGxlcnNcbiAgbW9kYWwucXVlcnlTZWxlY3RvcihcIi5zYi1tb2RhbC1iYWNrZHJvcFwiKT8uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIGNsb3NlTW9kYWwpO1xuICBtb2RhbC5xdWVyeVNlbGVjdG9yKFwiLnNiLW1vZGFsLWNsb3NlXCIpPy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgY2xvc2VNb2RhbCk7XG5cbiAgLy8gUmVtb3ZlIGFueSBleGlzdGluZyBrZXlib2FyZCBoYW5kbGVycyBiZWZvcmUgYWRkaW5nIG5ldyBvbmVzXG4gIGlmIChtb2RhbEtleUhhbmRsZXIpIHtcbiAgICBkb2N1bWVudC5yZW1vdmVFdmVudExpc3RlbmVyKFwia2V5ZG93blwiLCBtb2RhbEtleUhhbmRsZXIsIHRydWUpO1xuICB9XG5cbiAgLy8gU2luZ2xlIGtleWJvYXJkIGhhbmRsZXIgZm9yIGFsbCBtb2RhbCBzaG9ydGN1dHNcbiAgbW9kYWxLZXlIYW5kbGVyID0gZnVuY3Rpb24gKGU6IEtleWJvYXJkRXZlbnQpIHtcbiAgICBjb25zdCBhY3RpdmVNb2RhbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic2ItbW9kYWxcIik7XG4gICAgaWYgKCFhY3RpdmVNb2RhbCkge1xuICAgICAgaWYgKG1vZGFsS2V5SGFuZGxlcikgZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImtleWRvd25cIiwgbW9kYWxLZXlIYW5kbGVyLCB0cnVlKTtcbiAgICAgIG1vZGFsS2V5SGFuZGxlciA9IG51bGw7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gRXNjYXBlIHRvIGNsb3NlXG4gICAgaWYgKGUua2V5ID09PSBcIkVzY2FwZVwiKSB7XG4gICAgICBlLnByZXZlbnREZWZhdWx0KCk7XG4gICAgICBlLnN0b3BJbW1lZGlhdGVQcm9wYWdhdGlvbigpO1xuICAgICAgY2xvc2VNb2RhbCgpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIEFycm93IGtleXMgdG8gY2hvb3NlIChzdG9wIHByb3BhZ2F0aW9uIHRvIHByZXZlbnQgU3Rhc2ggc2NlbmUgbmF2aWdhdGlvbilcbiAgICBpZiAoZS5rZXkgPT09IFwiQXJyb3dMZWZ0XCIgJiYgc3RhdGUuY3VycmVudFBhaXIubGVmdCkge1xuICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgZS5zdG9wSW1tZWRpYXRlUHJvcGFnYXRpb24oKTtcbiAgICAgIGNvbnN0IGxlZnRCb2R5ID0gYWN0aXZlTW9kYWwucXVlcnlTZWxlY3RvcjxIVE1MRWxlbWVudD4oJy5zYi1zY2VuZS1jYXJkW2RhdGEtc2lkZT1cImxlZnRcIl0gLnNiLXNjZW5lLWJvZHknKTtcbiAgICAgIGlmIChsZWZ0Qm9keSkgbGVmdEJvZHkuY2xpY2soKTtcbiAgICB9XG4gICAgaWYgKGUua2V5ID09PSBcIkFycm93UmlnaHRcIiAmJiBzdGF0ZS5jdXJyZW50UGFpci5yaWdodCkge1xuICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpO1xuICAgICAgZS5zdG9wSW1tZWRpYXRlUHJvcGFnYXRpb24oKTtcbiAgICAgIGNvbnN0IHJpZ2h0Qm9keSA9IGFjdGl2ZU1vZGFsLnF1ZXJ5U2VsZWN0b3I8SFRNTEVsZW1lbnQ+KCcuc2Itc2NlbmUtY2FyZFtkYXRhLXNpZGU9XCJyaWdodFwiXSAuc2Itc2NlbmUtYm9keScpO1xuICAgICAgaWYgKHJpZ2h0Qm9keSkgcmlnaHRCb2R5LmNsaWNrKCk7XG4gICAgfVxuXG4gICAgLy8gU3BhY2ViYXIgdG8gc2tpcFxuICAgIGlmIChlLmtleSA9PT0gXCIgXCIgfHwgZS5jb2RlID09PSBcIlNwYWNlXCIpIHtcbiAgICAgIGNvbnN0IHRhZyA9IGRvY3VtZW50LmFjdGl2ZUVsZW1lbnQ/LnRhZ05hbWU7XG4gICAgICAvLyBTa2lwIGlmIGZvY3VzZWQgb24gaW5wdXQvdGV4dGFyZWEsIG9yIGlmIGEgYnV0dG9uIGlzIGZvY3VzZWQgKGxldCBidXR0b24ncyBjbGljayBoYW5kbGUgaXQpXG4gICAgICBpZiAodGFnID09PSBcIklOUFVUXCIgfHwgdGFnID09PSBcIlRFWFRBUkVBXCIgfHwgdGFnID09PSBcIkJVVFRPTlwiKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGUucHJldmVudERlZmF1bHQoKTtcbiAgICAgIGUuc3RvcEltbWVkaWF0ZVByb3BhZ2F0aW9uKCk7XG4gICAgICAvLyBEb24ndCBza2lwIGR1cmluZyBhY3RpdmUgZ2F1bnRsZXQvY2hhbXBpb24gcnVuXG4gICAgICBpZiAoKHN0YXRlLmN1cnJlbnRNb2RlID09PSBcImdhdW50bGV0XCIgfHwgc3RhdGUuY3VycmVudE1vZGUgPT09IFwiY2hhbXBpb25cIikgJiYgc3RhdGUuZ2F1bnRsZXRDbGltYmVyKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGlmIChzdGF0ZS5kaXNhYmxlQ2hvaWNlKSByZXR1cm47XG4gICAgICBzdGF0ZS5kaXNhYmxlQ2hvaWNlID0gdHJ1ZTtcbiAgICAgIGlmIChzdGF0ZS5jdXJyZW50TW9kZSA9PT0gXCJnYXVudGxldFwiIHx8IHN0YXRlLmN1cnJlbnRNb2RlID09PSBcImNoYW1waW9uXCIpIHtcbiAgICAgICAgcmVzZXRHYXVudGxldFN0YXRlKCk7XG4gICAgICAgIHNhdmVTdGF0ZSgpO1xuICAgICAgfVxuICAgICAgbG9hZE5ld1BhaXIoKTtcbiAgICB9XG4gIH07XG5cbiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcImtleWRvd25cIiwgbW9kYWxLZXlIYW5kbGVyLCB0cnVlKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGNsb3NlTW9kYWwoKTogdm9pZCB7XG4gIGNvbnN0IG1vZGFsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJzYi1tb2RhbFwiKTtcbiAgaWYgKCFtb2RhbCB8fCBtb2RhbC5jbGFzc0xpc3QuY29udGFpbnMoXCJzYi1tb2RhbC1oaWRkZW5cIikpIHJldHVybjtcblxuICAvLyBBZGQgY2xvc2luZyBjbGFzcyB0byB0cmlnZ2VyIGZhZGUtb3V0IGFuaW1hdGlvblxuICBtb2RhbC5jbGFzc0xpc3QuYWRkKFwic2ItbW9kYWwtY2xvc2luZ1wiKTtcblxuICAvLyBBZnRlciBhbmltYXRpb24gY29tcGxldGVzLCBoaWRlIHRoZSBtb2RhbCAoa2VlcCBpbiBET00gZm9yIHJldXNlKVxuICBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICBtb2RhbC5jbGFzc0xpc3QuYWRkKFwic2ItbW9kYWwtaGlkZGVuXCIpO1xuICAgIG1vZGFsLmNsYXNzTGlzdC5yZW1vdmUoXCJzYi1tb2RhbC1jbG9zaW5nXCIpO1xuICB9LCAyMDApOyAvLyBNYXRjaCBDU1MgYW5pbWF0aW9uIGR1cmF0aW9uXG5cbiAgLy8gQ2xlYW4gdXAga2V5Ym9hcmQgaGFuZGxlclxuICBpZiAobW9kYWxLZXlIYW5kbGVyKSB7XG4gICAgZG9jdW1lbnQucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImtleWRvd25cIiwgbW9kYWxLZXlIYW5kbGVyLCB0cnVlKTtcbiAgfVxufVxuIiwgIi8vIFRoZSBuYXZiYXIgXCJCYXR0bGVcIiBidXR0b24gdGhhdCBvcGVucyB0aGUgY29tcGFyaXNvbiBtb2RhbC5cclxuXHJcbmltcG9ydCB7IG9wZW5Nb2RhbCB9IGZyb20gXCIuL21vZGFsXCI7XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gc2hvdWxkU2hvd05hdkJ1dHRvbigpOiBib29sZWFuIHtcclxuICBjb25zdCBwYXRoID0gd2luZG93LmxvY2F0aW9uLnBhdGhuYW1lO1xyXG4gIHJldHVybiAoXHJcbiAgICBwYXRoID09PSBcIi9cIiB8fFxyXG4gICAgcGF0aCA9PT0gXCIvc2NlbmVzXCIgfHxcclxuICAgIHBhdGggPT09IFwiL3NjZW5lcy9cIiB8fFxyXG4gICAgcGF0aC5zdGFydHNXaXRoKFwiL3NjZW5lcy9cIilcclxuICApO1xyXG59XHJcblxyXG4vKiogSW5qZWN0IG9yIHJlbW92ZSB0aGUgQmF0dGxlIG5hdiBpdGVtIGJhc2VkIG9uIHRoZSBjdXJyZW50IHJvdXRlLiBTYWZlIHRvIGNhbGwgcmVwZWF0ZWRseS4gKi9cclxuZXhwb3J0IGZ1bmN0aW9uIGluamVjdE5hdkJ1dHRvbigpOiB2b2lkIHtcclxuICBjb25zdCBidXR0b25JZCA9IFwicGx1Z2luX3NiXCI7XHJcblxyXG4gIGlmICghc2hvdWxkU2hvd05hdkJ1dHRvbigpKSB7XHJcbiAgICBjb25zdCBleGlzdGluZyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGJ1dHRvbklkKTtcclxuICAgIGlmIChleGlzdGluZykge1xyXG4gICAgICBleGlzdGluZy5jbG9zZXN0KFwiLm5hdi1saW5rXCIpPy5yZW1vdmUoKTtcclxuICAgIH1cclxuICAgIHJldHVybjtcclxuICB9XHJcblxyXG4gIGlmIChkb2N1bWVudC5nZXRFbGVtZW50QnlJZChidXR0b25JZCkpIHJldHVybjtcclxuXHJcbiAgY29uc3QgbmF2SXRlbSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XHJcbiAgbmF2SXRlbS5jbGFzc05hbWUgPSBcImNvbC00IGNvbC1zbS0zIGNvbC1tZC0yIGNvbC1sZy1hdXRvIG5hdi1saW5rXCI7XHJcbiAgbmF2SXRlbS5pZCA9IGJ1dHRvbklkO1xyXG5cclxuICBuYXZJdGVtLmlubmVySFRNTCA9IGBcclxuICAgICAgICA8YSBocmVmPVwiI1wiIGNsYXNzPVwibWluaW1hbCBwLTQgcC14bC0yIGQtZmxleCBkLXhsLWlubGluZS1ibG9jayBmbGV4LWNvbHVtbiBqdXN0aWZ5LWNvbnRlbnQtYmV0d2VlbiBhbGlnbi1pdGVtcy1jZW50ZXIgYnRuIGJ0bi1wcmltYXJ5XCI+XHJcbiAgICAgICAgICAgIDxzdmcgYXJpYS1oaWRkZW49XCJ0cnVlXCIgZm9jdXNhYmxlPVwiZmFsc2VcIiBjbGFzcz1cInN2Zy1pbmxpbmUtLWZhIGZhLWljb24gbmF2LW1lbnUtaWNvbiBkLWJsb2NrIGQteGwtaW5saW5lIG1iLTIgbWIteGwtMFwiIHJvbGU9XCJpbWdcIiB4bWxucz1cImh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnXCIgdmlld0JveD1cIjAgMCAzNiAzNlwiPlxyXG4gICAgICAgICAgICAgICAgPHBhdGggZmlsbD1cImN1cnJlbnRDb2xvclwiIGQ9XCJtMjQgMjkgNS01TDYgMUgxdjV6XCIvPlxyXG4gICAgICAgICAgICAgICAgPHBhdGggZmlsbD1cImN1cnJlbnRDb2xvclwiIGQ9XCJNMSAxdjVsMjMgMjMgMi41LTIuNXpcIi8+XHJcbiAgICAgICAgICAgICAgICA8cGF0aCBmaWxsPVwiY3VycmVudENvbG9yXCIgZD1cIk0zMy40MjQgMzIuODA4Yy4yODQtLjI4NC40NTgtLjYyNi41MzEtLjk2OGwtNS4yNDItNi4xOTUtLjctLjcwMmMtLjU2NS0uNTY0LTEuNTctLjQ3My0yLjI0OS4yMDVsLS42MTQuNjEyYy0uNjc3LjY3Ny0uNzY4IDEuNjgzLS4yMDQgMi4yNDdsLjc0MS43NDEgNi4xNSA1LjIwNWMuMzQ1LS4wNzIuNjg4LS4yNDcuOTc0LS41MzJ6XCIvPlxyXG4gICAgICAgICAgICAgICAgPHBhdGggZmlsbD1cImN1cnJlbnRDb2xvclwiIGQ9XCJNMzMuNDI0IDMyLjgwOGMuMjg0LS4yODQuNDU4LS42MjYuNTMxLS45NjhsLTEuMzQyLTEuNTg2LS43MzcgMy42ODRjLjMzMS0uMDc3LjY2MS0uMjQzLjkzNS0uNTE4em0tMy4zMS01LjUwNi0uODg4IDQuNDQgMS4yNiAxLjA2Ny44Mi00LjF6bS0xLjQtMS42NTctLjcwMi0uNzAyYTEuMiAxLjIgMCAwIDAtLjMyNi0uMjI0bC0uOTc4IDQuODkyIDEuMjYgMS4wNjYuOTU3LTQuNzgzem0tMi40MDItLjg4OGEyIDIgMCAwIDAtLjU0OC4zOTJsLS42MTQuNjFhMiAyIDAgMCAwLS41MS44NmMtLjE0My41MS0uMDQ3IDEuMDM2LjMwNiAxLjM4OGwuNTk2LjU5NnptMCAwcTAtLjAwMyAwIDBcIi8+XHJcbiAgICAgICAgICAgICAgICA8cGF0aCBmaWxsPVwiY3VycmVudENvbG9yXCIgZD1cIk0zMy4yNSAzNmEyLjc1IDIuNzUgMCAxIDAgMC01LjUgMi43NSAyLjc1IDAgMCAwIDAgNS41TTI5LjYyNiAyMi4zMjRhMS4wMzQgMS4wMzQgMCAwIDEgMCAxLjQ2MmwtNi4wOTIgNi4wOTJhMS4wMzIgMS4wMzIgMCAwIDEtMS42ODYtLjMzNiAxLjAzIDEuMDMgMCAwIDEgLjIyNC0xLjEyNmw2LjA5Mi02LjA5MmExLjAzMyAxLjAzMyAwIDAgMSAxLjQ2MiAwXCIvPlxyXG4gICAgICAgICAgICAgICAgPHBhdGggZmlsbD1cImN1cnJlbnRDb2xvclwiIGQ9XCJNMjIuMDcyIDMxLjYyN2ExLjc1IDEuNzUgMCAxIDAgMC0zLjUgMS43NSAxLjc1IDAgMCAwIDAgMy41TTI5LjYyNiAyNC4wNzNhMS43NSAxLjc1IDAgMSAwIDAtMy41IDEuNzUgMS43NSAwIDAgMCAwIDMuNVwiLz5cclxuICAgICAgICAgICAgICAgIDxwYXRoIGZpbGw9XCJjdXJyZW50Q29sb3JcIiBkPVwiTTIyLjA3MiAzMC44NzdhMSAxIDAgMSAwIDAtMiAxIDEgMCAwIDAgMCAyTTI5LjYyNiAyMy4zMjNhMSAxIDAgMSAwIDAtMiAxIDEgMCAwIDAgMCAyTTMzLjkwMyAyOS4zNDJhLjc2Ljc2IDAgMCAxIDAgMS4wNzhsLTMuNDc2IDMuNDc1YS43NjIuNzYyIDAgMCAxLTEuMDc4LTEuMDc4bDMuNDc2LTMuNDc1YS43Ni43NiAwIDAgMSAxLjA3OCAwTTEyIDI5bC01LTVMMzAgMWg1djV6XCIvPlxyXG4gICAgICAgICAgICAgICAgPHBhdGggZmlsbD1cImN1cnJlbnRDb2xvclwiIGQ9XCJNMzUgMXY1TDEyIDI5bC0yLjUtMi41elwiLz5cclxuICAgICAgICAgICAgICAgIDxwYXRoIGZpbGw9XCJjdXJyZW50Q29sb3JcIiBkPVwiTTIuNTc2IDMyLjgwOGExLjk1IDEuOTUgMCAwIDEtLjUzMS0uOTY4bDUuMjQyLTYuMTk1LjctLjcwMmMuNTY1LS41NjQgMS41Ny0uNDczIDIuMjQ5LjIwNWwuNjEzLjYxMmMuNjc3LjY3Ny43NjggMS42ODMuMjA0IDIuMjQ3bC0uNzQxLjc0MS02LjE1IDUuMjA1YTEuOTUgMS45NSAwIDAgMS0uOTc0LS41MzJ6XCIvPlxyXG4gICAgICAgICAgICAgICAgPHBhdGggZmlsbD1cImN1cnJlbnRDb2xvclwiIGQ9XCJNMi41NzYgMzIuODA4YTEuOTUgMS45NSAwIDAgMS0uNTMxLS45NjhsMS4zNDItMS41ODYuNzM3IDMuNjg0YTEuOTMgMS45MyAwIDAgMS0uOTM1LS41MTh6bTMuMzEtNS41MDYuODg4IDQuNDQtMS4yNiAxLjA2Ny0uODItNC4xem0xLjQtMS42NTcuNzAyLS43MDJhMS4yIDEuMiAwIDAgMSAuMzI2LS4yMjRsLjk3OCA0Ljg5Mi0xLjI2IDEuMDY2LS45NTctNC43ODN6bTIuNDAyLS44ODhjLjE5NS4wOTUuMzgyLjIyNS41NDguMzkybC42MTMuNjEyYy4yNTQuMjU0LjQyNS41NTQuNTEuODYuMTQzLjUxLjA0NyAxLjAzNS0uMzA2IDEuMzg3bC0uNTk2LjU5NnptMCAwcTAtLjAwMyAwIDBcIi8+XHJcbiAgICAgICAgICAgICAgICA8cGF0aCBmaWxsPVwiY3VycmVudENvbG9yXCIgZD1cIk0yLjc1IDM2YTIuNzUgMi43NSAwIDEgMCAwLTUuNSAyLjc1IDIuNzUgMCAwIDAgMCA1LjVNNi4zNzQgMjIuMzI0YTEuMDM0IDEuMDM0IDAgMCAwIDAgMS40NjJsNi4wOTIgNi4wOTJhMS4wMzMgMS4wMzMgMCAxIDAgMS40NjItMS40NjJsLTYuMDkyLTYuMDkyYTEuMDMzIDEuMDMzIDAgMCAwLTEuNDYyIDBcIi8+XHJcbiAgICAgICAgICAgICAgICA8cGF0aCBmaWxsPVwiY3VycmVudENvbG9yXCIgZD1cIk0xMy45MjggMzEuNjI3YTEuNzUgMS43NSAwIDEgMCAwLTMuNSAxLjc1IDEuNzUgMCAwIDAgMCAzLjVNNi4zNzQgMjQuMDczYTEuNzUgMS43NSAwIDEgMCAwLTMuNSAxLjc1IDEuNzUgMCAwIDAgMCAzLjVcIi8+XHJcbiAgICAgICAgICAgICAgICA8cGF0aCBmaWxsPVwiY3VycmVudENvbG9yXCIgZD1cIk0xMy45MjggMzAuODc3YTEgMSAwIDEgMCAwLTIgMSAxIDAgMCAwIDAgMk02LjM3NCAyMy4zMjNhMSAxIDAgMSAwIDAtMiAxIDEgMCAwIDAgMCAyTTIuMDk3IDI5LjM0MmEuNzYuNzYgMCAwIDAgMCAxLjA3OGwzLjQ3NiAzLjQ3NWEuNzYzLjc2MyAwIDAgMCAxLjA3OC0xLjA3OGwtMy40NzYtMy40NzVhLjc2Ljc2IDAgMCAwLTEuMDc4IDBcIi8+XHJcbiAgICAgICAgICAgIDwvc3ZnPlxyXG4gICAgICAgICAgICA8c3Bhbj5CYXR0bGU8L3NwYW4+XHJcbiAgICAgICAgPC9hPlxyXG4gICAgYDtcclxuXHJcbiAgY29uc3QgbGluayA9IG5hdkl0ZW0ucXVlcnlTZWxlY3RvcihcImFcIik7XHJcbiAgaWYgKGxpbmspIHtcclxuICAgIGxpbmsuYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIChlKSA9PiB7XHJcbiAgICAgIGUucHJldmVudERlZmF1bHQoKTtcclxuICAgICAgb3Blbk1vZGFsKCk7XHJcbiAgICB9KTtcclxuICB9XHJcblxyXG4gIGNvbnN0IG5hdlRhcmdldCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoXCIubmF2YmFyLW5hdlwiKTtcclxuICBpZiAobmF2VGFyZ2V0KSB7XHJcbiAgICBuYXZUYXJnZXQuYXBwZW5kQ2hpbGQobmF2SXRlbSk7XHJcbiAgfVxyXG59XHJcbiIsICIvLyBTdGFzaCBCYXR0bGUgLSBlbnRyeSBwb2ludC5cbi8vIEJ1bmRsZWQgYnkgZXNidWlsZCBpbnRvIHBsdWdpbnMvc3Rhc2gtYmF0dGxlL3N0YXNoLWJhdHRsZS5qcyAoSUlGRSkuXG5cbmltcG9ydCB7IGluamVjdE5hdkJ1dHRvbiB9IGZyb20gXCIuL3VpL25hdkJ1dHRvblwiO1xuXG5mdW5jdGlvbiBpbml0KCk6IHZvaWQge1xuICAgIGNvbnNvbGUubG9nKFwiW1N0YXNoIEJhdHRsZV0gSW5pdGlhbGl6ZWRcIik7XG5cbiAgaW5qZWN0TmF2QnV0dG9uKCk7XG5cbiAgLy8gUmUtaW5qZWN0IG5hdiBidXR0b24gYWZ0ZXIgU3Rhc2ggU1BBIG5hdmlnYXRpb24gcmVidWlsZHMgdGhlIG5hdmJhclxuICAgIGNvbnN0IG9ic2VydmVyID0gbmV3IE11dGF0aW9uT2JzZXJ2ZXIoKCkgPT4ge1xuICAgIGluamVjdE5hdkJ1dHRvbigpO1xuICAgIH0pO1xuXG4gICAgb2JzZXJ2ZXIub2JzZXJ2ZShkb2N1bWVudC5ib2R5LCB7XG4gICAgICBjaGlsZExpc3Q6IHRydWUsXG4gICAgICBzdWJ0cmVlOiB0cnVlLFxuICAgIH0pO1xuICB9XG5cbiAgaWYgKGRvY3VtZW50LnJlYWR5U3RhdGUgPT09IFwibG9hZGluZ1wiKSB7XG4gICAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcihcIkRPTUNvbnRlbnRMb2FkZWRcIiwgaW5pdCk7XG4gIH0gZWxzZSB7XG4gICAgaW5pdCgpO1xuICB9XG4iXSwKICAibWFwcGluZ3MiOiAiOzs7QUFFTyxNQUFNLGNBQWM7QUFDcEIsTUFBTSxnQkFBZ0I7QUFDdEIsTUFBTSxtQkFBbUI7QUFDekIsTUFBTSxtQkFBbUI7QUFDekIsTUFBTSxtQkFBbUIsSUFBSSxLQUFLO0FBSWxDLE1BQU0sMkJBQTJCO0FBR2pDLE1BQU0sdUJBQXVCO0FBQzdCLE1BQU0sb0JBQW9CO0FBRzFCLE1BQU0sK0JBQStCO0FBQ3JDLE1BQU0sa0NBQWtDO0FBR3hDLE1BQU0sNkJBQTZCOzs7QUNoQm5DLFdBQVMsa0JBQW1DO0FBQ2pELFdBQU8sSUFBSSxnQkFBZ0IsT0FBTyxTQUFTLE1BQU07QUFBQSxFQUNuRDtBQUdPLFdBQVMsY0FDZCxZQUFxQyxDQUFDLEdBQ3RDLGVBQWdDLGdCQUFnQixHQUNoQztBQUNoQixVQUFNLFNBQXlCO0FBQUEsTUFDN0IsVUFBVSxVQUFVLFlBQVk7QUFBQSxNQUNoQyxNQUFNLFVBQVUsU0FBUyxhQUFhLElBQUksUUFBUSxLQUFLO0FBQUEsTUFDdkQsV0FBVyxVQUFVLGNBQWMsYUFBYSxJQUFJLFNBQVMsR0FBRyxZQUFZLEtBQUs7QUFBQSxNQUNqRixHQUFHO0FBQUEsSUFDTDtBQUdBLFVBQU0sUUFBUSxhQUFhLElBQUksR0FBRztBQUNsQyxRQUFJLE9BQU87QUFDVCxhQUFPLElBQUk7QUFBQSxJQUNiO0FBRUEsV0FBTztBQUFBLEVBQ1Q7QUFLTyxXQUFTLGNBQWMsWUFBb0IsVUFBMkI7QUFDM0Us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LHNCQUErQjtBQUM3QyxVQUFNLE9BQU8sT0FBTyxTQUFTO0FBQzdCLFdBQ0UsU0FBUyxPQUNULFNBQVMsYUFDVCxTQUFTLGNBQ1QsS0FBSyxXQUFXLFVBQVU7QUFBQSxFQUU5QjtBQUdPLFdBQVMsa0JBQXdCO0FBQ3RDLFVBQU0sV0FBVztBQUVqQixRQUFJLENBQUMsb0JBQW9CLEdBQUc7QUFDMUIsWUFBTSxXQUFXLFNBQVMsZUFBZSxRQUFRO0FBQ2pELFVBQUksVUFBVTtBQUNaLGlCQUFTLFFBQVEsV0FBVyxHQUFHLE9BQU87QUFBQSxNQUN4QztBQUNBO0FBQUEsSUFDRjtBQUVBLFFBQUksU0FBUyxlQUFlLFFBQVEsRUFBRztBQUV2QyxVQUFNLFVBQVUsU0FBUyxjQUFjLEtBQUs7QUFDNUMsWUFBUSxZQUFZO0FBQ3BCLFlBQVEsS0FBSztBQUViLFlBQVEsWUFBWTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBcUJwQixVQUFNLE9BQU8sUUFBUSxjQUFjLEdBQUc7QUFDdEMsUUFBSSxNQUFNO0FBQ1IsV0FBSyxpQkFBaUIsU0FBUyxDQUFDLE1BQU07QUFDcEMsVUFBRSxlQUFlO0FBQ2pCLGtCQUFVO0FBQUEsTUFDWixDQUFDO0FBQUEsSUFDSDtBQUVBLFVBQU0sWUFBWSxTQUFTLGNBQWMsYUFBYTtBQUN0RCxRQUFJLFdBQVc7QUFDYixnQkFBVSxZQUFZLE9BQU87QUFBQSxJQUMvQjtBQUFBLEVBQ0Y7OztBQzVEQSxXQUFTLE9BQWE7QUFDbEIsWUFBUSxJQUFJLDRCQUE0QjtBQUUxQyxvQkFBZ0I7QUFHZCxVQUFNLFdBQVcsSUFBSSxpQkFBaUIsTUFBTTtBQUM1QyxzQkFBZ0I7QUFBQSxJQUNoQixDQUFDO0FBRUQsYUFBUyxRQUFRLFNBQVMsTUFBTTtBQUFBLE1BQzlCLFdBQVc7QUFBQSxNQUNYLFNBQVM7QUFBQSxJQUNYLENBQUM7QUFBQSxFQUNIO0FBRUEsTUFBSSxTQUFTLGVBQWUsV0FBVztBQUNyQyxhQUFTLGlCQUFpQixvQkFBb0IsSUFBSTtBQUFBLEVBQ3BELE9BQU87QUFDTCxTQUFLO0FBQUEsRUFDUDsiLAogICJuYW1lcyI6IFsiYWxsUmVzdWx0IiwgIndpbm5lckRlbHRhIiwgImxvc2VyRGVsdGEiLCAibmV3V2lubmVyUmF0aW5nIiwgIm5ld0xvc2VyUmF0aW5nIiwgIm1vZGFsQ29udGVudCJdCn0K
