(function () {
  "use strict";

  const STORAGE_KEY = "stash-battle-state";
  const CACHE_DB_NAME = "stash-battle-cache";
  const CACHE_DB_VERSION = 1;
  const CACHE_STORE_NAME = "scenes";
  const CACHE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes cache expiry

  // Current comparison pair and mode
  let currentPair = { left: null, right: null };
  let currentRanks = { left: null, right: null };
  let currentMode = "swiss"; // "swiss", "gauntlet", or "champion"
  let gauntletChampion = null; // The scene currently on a winning streak
  let gauntletWins = 0; // Current win streak
  let gauntletChampionRank = 0; // Current rank position (1 = top)
  let gauntletDefeated = []; // IDs of scenes defeated in current run
  let gauntletFalling = false; // True when champion lost and is finding their floor
  let gauntletFallingScene = null; // The scene that's falling to find its position
  let totalScenesCount = 0; // Total scenes for position display
  let disableChoice = false; // Track when inputs should be disabled to prevent multiple events
  let savedFilterParams = ""; // Store URL filter params to detect changes

  // Shuffle state for filtered scenes (prevents duplicates when skipping)
  let shuffledFilteredScenes = [];  // Shuffled copy of filtered scenes
  let shuffleIndex = 0;             // Current position in shuffled list
  let shuffleFilterKey = null;      // Filter key to detect changes
  let removedSceneIds = new Set();  // Track scenes removed during this session (survives background refresh)

  // ============================================
  // SCENE CACHE (IndexedDB + Memory)
  // ============================================

  // In-memory cache for current session (avoids repeated IndexedDB reads)
  let memoryCache = {
    allScenes: null,           // All scenes (no filter)
    filteredScenes: null,      // Scenes matching current filter
    filterKey: null,           // Current filter params for cache validation
    timestamp: null            // When cache was populated
  };

  // Open IndexedDB database
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

  // Get cached scenes from IndexedDB
  async function getCachedScenes(cacheKey) {
    try {
      const db = await openCacheDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(CACHE_STORE_NAME, "readonly");
        const store = transaction.objectStore(CACHE_STORE_NAME);
        const request = store.get(cacheKey);
        
        request.onsuccess = () => {
          const result = request.result;
          if (result && (Date.now() - result.timestamp) < CACHE_MAX_AGE_MS) {
            resolve(result);
          } else {
            resolve(null); // Cache miss or expired
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

  // Store scenes in IndexedDB
  async function setCachedScenes(cacheKey, scenes, count) {
    try {
      const db = await openCacheDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(CACHE_STORE_NAME, "readwrite");
        const store = transaction.objectStore(CACHE_STORE_NAME);
        
        const data = {
          cacheKey,
          scenes,
          count,
          timestamp: Date.now()
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

  // Store filtered scenes with filter key for validation
  async function setCachedScenesWithFilter(cacheKey, scenes, count, filterKey) {
    try {
      const db = await openCacheDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(CACHE_STORE_NAME, "readwrite");
        const store = transaction.objectStore(CACHE_STORE_NAME);
        
        const data = {
          cacheKey,
          scenes,
          count,
          filterKey,  // Store filter key for validation on read
          timestamp: Date.now()
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

  // Clear all cached scenes (for manual refresh)
  async function clearSceneCache() {
    try {
      console.log("[Stash Battle] 🗑️ Clearing all scene caches...");
      const db = await openCacheDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(CACHE_STORE_NAME, "readwrite");
        const store = transaction.objectStore(CACHE_STORE_NAME);
        const request = store.clear();
        
        request.onsuccess = () => {
          memoryCache = { allScenes: null, filteredScenes: null, filterKey: null, timestamp: null };
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

  // Clear just the filtered scenes cache (for auto-refresh after pool exhaustion)
  async function clearFilteredCache() {
    try {
      const db = await openCacheDB();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(CACHE_STORE_NAME, "readwrite");
        const store = transaction.objectStore(CACHE_STORE_NAME);
        const request = store.delete("filtered-scenes");
        
        request.onsuccess = () => {
          memoryCache.filteredScenes = null;
          memoryCache.filterKey = null;
          console.log("[Stash Battle] 🗑️ Filtered cache cleared (memory + IndexedDB)");
          resolve();
        };
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => db.close();
      });
    } catch (e) {
      console.error("[Stash Battle] ❌ Filtered cache clear error:", e);
      // Still clear memory cache even if IndexedDB fails
      memoryCache.filteredScenes = null;
      memoryCache.filterKey = null;
    }
  }

  // Background refresh - fetch from network and update caches silently
  async function backgroundRefreshAllScenes() {
    const cacheKey = "all-scenes";
    
    try {
      console.log("[Stash Battle] 🔄 Background refresh started (all scenes)...");
      const startTime = Date.now();
      
      const scenesQuery = `
        query FindScenesByRating($filter: FindFilterType, $scene_filter: SceneFilterType) {
          findScenes(filter: $filter, scene_filter: $scene_filter) {
            count
            scenes {
              ${SCENE_FRAGMENT}
            }
          }
        }
      `;
      
      const result = await graphqlQuery(scenesQuery, {
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
      
      // Check if count changed (new scenes added/removed)
      const oldCount = memoryCache.allScenes ? memoryCache.allScenes.length : 0;
      if (count !== oldCount) {
        console.log(`[Stash Battle] 📊 Scene count changed: ${oldCount} → ${count} (${count > oldCount ? '+' : ''}${count - oldCount})`);
      } else {
        console.log(`[Stash Battle] 📊 Scene count unchanged: ${count}`);
      }
      
      // Update both caches silently
      memoryCache.allScenes = scenes;
      memoryCache.timestamp = Date.now();
      await setCachedScenes(cacheKey, scenes, count);
      
      console.log(`[Stash Battle] ✅ Background refresh complete: ${scenes.length} scenes in ${fetchTime}ms`);
    } catch (e) {
      console.error("[Stash Battle] ❌ Background refresh failed:", e);
    }
  }

  // Get all scenes (uses cache with stale-while-revalidate)
  async function getAllScenesCached() {
    const cacheKey = "all-scenes";
    
    // Check memory cache first - return immediately if available
    if (memoryCache.allScenes) {
      const cacheAge = Math.round((Date.now() - memoryCache.timestamp) / 1000);
      const isStale = (Date.now() - memoryCache.timestamp) >= CACHE_MAX_AGE_MS;
      
      console.log(`[Stash Battle] 💾 Memory cache hit (all scenes): ${memoryCache.allScenes.length} scenes, age: ${cacheAge}s${isStale ? ' [STALE]' : ''}`);
      
      // If stale, trigger background refresh (but still return cached data)
      if (isStale) {
        console.log(`[Stash Battle] ⏰ Cache stale (>${CACHE_MAX_AGE_MS/1000}s), triggering background refresh...`);
        backgroundRefreshAllScenes(); // Don't await - runs in background
      }
      return { scenes: memoryCache.allScenes, count: memoryCache.allScenes.length };
    }
    
    // Check IndexedDB cache - return immediately if available
    console.log("[Stash Battle] 🔍 Memory cache miss, checking IndexedDB...");
    const cached = await getCachedScenes(cacheKey);
    if (cached) {
      const cacheAge = Math.round((Date.now() - cached.timestamp) / 1000);
      const isStale = (Date.now() - cached.timestamp) >= CACHE_MAX_AGE_MS;
      
      console.log(`[Stash Battle] 💿 IndexedDB cache hit (all scenes): ${cached.scenes.length} scenes, age: ${cacheAge}s${isStale ? ' [STALE]' : ''}`);
      
      memoryCache.allScenes = cached.scenes;
      memoryCache.timestamp = cached.timestamp;
      
      // If stale, trigger background refresh
      if (isStale) {
        console.log(`[Stash Battle] ⏰ Cache stale (>${CACHE_MAX_AGE_MS/1000}s), triggering background refresh...`);
        backgroundRefreshAllScenes(); // Don't await - runs in background
      }
      return { scenes: cached.scenes, count: cached.count };
    }
    
    // No cache at all - must fetch from network (blocking)
    console.log("[Stash Battle] 🌐 No cache found, fetching all scenes from network (first load)...");
    const startTime = Date.now();
    
    const scenesQuery = `
      query FindScenesByRating($filter: FindFilterType, $scene_filter: SceneFilterType) {
        findScenes(filter: $filter, scene_filter: $scene_filter) {
          count
          scenes {
            ${SCENE_FRAGMENT}
          }
        }
      }
    `;
    
    const result = await graphqlQuery(scenesQuery, {
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
    
    // Store in both caches
    memoryCache.allScenes = scenes;
    memoryCache.timestamp = Date.now();
    await setCachedScenes(cacheKey, scenes, count);
    
    console.log(`[Stash Battle] ✅ Fetched and cached ${scenes.length} scenes in ${fetchTime}ms`);
    return { scenes, count };
  }

  // Background refresh for filtered scenes
  async function backgroundRefreshFilteredScenes(searchParams, sceneFilter, filterKey) {
    const cacheKey = "filtered-scenes";
    
    try {
      console.log("[Stash Battle] 🔄 Background refresh started (filtered scenes)...");
      const startTime = Date.now();
      
      const scenesQuery = `
        query FindScenesByRating($filter: FindFilterType, $scene_filter: SceneFilterType) {
          findScenes(filter: $filter, scene_filter: $scene_filter) {
            count
            scenes {
              ${SCENE_FRAGMENT}
            }
          }
        }
      `;
      
      const result = await graphqlQuery(scenesQuery, {
        filter: getFindFilter(searchParams, {
          per_page: -1,
          sort: "rating",
          direction: "DESC"
        }),
        scene_filter: sceneFilter
      });
      
      const scenes = result.findScenes.scenes || [];
      const count = result.findScenes.count || scenes.length;
      const fetchTime = Date.now() - startTime;
      
      // Only update if still on same filter
      if (memoryCache.filterKey === filterKey) {
        const oldCount = memoryCache.filteredScenes ? memoryCache.filteredScenes.length : 0;
        if (count !== oldCount) {
          console.log(`[Stash Battle] 📊 Filtered count changed: ${oldCount} → ${count} (${count > oldCount ? '+' : ''}${count - oldCount})`);
        } else {
          console.log(`[Stash Battle] 📊 Filtered count unchanged: ${count}`);
        }
        
        memoryCache.filteredScenes = scenes;
        memoryCache.timestamp = Date.now();
        await setCachedScenesWithFilter(cacheKey, scenes, count, filterKey);
        
        console.log(`[Stash Battle] ✅ Background refresh complete: ${scenes.length} filtered scenes in ${fetchTime}ms`);
      } else {
        console.log(`[Stash Battle] ⚠️ Filter changed during refresh, discarding results`);
      }
    } catch (e) {
      console.error("[Stash Battle] ❌ Background refresh (filtered) failed:", e);
    }
  }

  // Build a cache key that includes both sceneFilter (c params) AND search query (q param)
  function buildFilterKey(searchParams, sceneFilter) {
    const q = searchParams.get("q") || "";
    return JSON.stringify({ q, filter: sceneFilter || {} });
  }

  // Get filtered scenes (uses cache with stale-while-revalidate)
  // NOTE: Only ONE filtered cache is kept (overwrites previous filter cache to prevent IndexedDB bloat)
  // NOTE: Fetch functions should check hasFilter first and call getAllScenesCached() directly if no filter
  async function getFilteredScenesCached(searchParams, sceneFilter) {
    const filterKey = buildFilterKey(searchParams, sceneFilter);
    const cacheKey = "filtered-scenes"; // Single key - overwrites previous filter cache
    
    console.log("[Stash Battle] 🔎 Filter active, checking filtered cache...");
    
    // Check memory cache first - return immediately if available and same filter
    if (memoryCache.filteredScenes && memoryCache.filterKey === filterKey) {
      const cacheAge = Math.round((Date.now() - memoryCache.timestamp) / 1000);
      const isStale = (Date.now() - memoryCache.timestamp) >= CACHE_MAX_AGE_MS;
      
      console.log(`[Stash Battle] 💾 Memory cache hit (filtered): ${memoryCache.filteredScenes.length} scenes, age: ${cacheAge}s${isStale ? ' [STALE]' : ''}`);
      
      // If stale, trigger background refresh
      if (isStale) {
        console.log(`[Stash Battle] ⏰ Cache stale (>${CACHE_MAX_AGE_MS/1000}s), triggering background refresh...`);
        backgroundRefreshFilteredScenes(searchParams, sceneFilter, filterKey);
      }
      return { scenes: memoryCache.filteredScenes, count: memoryCache.filteredScenes.length };
    }
    
    // Check IndexedDB cache (only if filter key matches)
    console.log("[Stash Battle] 🔍 Memory cache miss (filtered), checking IndexedDB...");
    const cached = await getCachedScenes(cacheKey);
    if (cached && cached.filterKey === filterKey) {
      const cacheAge = Math.round((Date.now() - cached.timestamp) / 1000);
      const isStale = (Date.now() - cached.timestamp) >= CACHE_MAX_AGE_MS;
      
      console.log(`[Stash Battle] 💿 IndexedDB cache hit (filtered): ${cached.scenes.length} scenes, age: ${cacheAge}s${isStale ? ' [STALE]' : ''}`);
      
      memoryCache.filteredScenes = cached.scenes;
      memoryCache.filterKey = filterKey;
      memoryCache.timestamp = cached.timestamp;
      
      // If stale, trigger background refresh
      if (isStale) {
        console.log(`[Stash Battle] ⏰ Cache stale (>${CACHE_MAX_AGE_MS/1000}s), triggering background refresh...`);
        backgroundRefreshFilteredScenes(searchParams, sceneFilter, filterKey);
      }
      return { scenes: cached.scenes, count: cached.count };
    }
    
    if (cached) {
      console.log("[Stash Battle] 💿 IndexedDB cache exists but filter changed, fetching new data...");
    } else {
      console.log("[Stash Battle] 💿 IndexedDB cache miss (filtered)");
    }
    
    // No matching cache - must fetch from network (blocking)
    console.log("[Stash Battle] 🌐 Fetching filtered scenes from network...");
    const startTime = Date.now();
    
    const scenesQuery = `
      query FindScenesByRating($filter: FindFilterType, $scene_filter: SceneFilterType) {
        findScenes(filter: $filter, scene_filter: $scene_filter) {
          count
          scenes {
            ${SCENE_FRAGMENT}
          }
        }
      }
    `;
    
    const result = await graphqlQuery(scenesQuery, {
      filter: getFindFilter(searchParams, {
        per_page: -1,
        sort: "rating",
        direction: "DESC"
      }),
      scene_filter: sceneFilter
    });
    
    const scenes = result.findScenes.scenes || [];
    const count = result.findScenes.count || scenes.length;
    const fetchTime = Date.now() - startTime;
    
    // Store in both caches (include filterKey so we can validate on read)
    memoryCache.filteredScenes = scenes;
    memoryCache.filterKey = filterKey;
    memoryCache.timestamp = Date.now();
    await setCachedScenesWithFilter(cacheKey, scenes, count, filterKey);
    
    console.log(`[Stash Battle] ✅ Fetched and cached ${scenes.length} filtered scenes in ${fetchTime}ms`);
    return { scenes, count };
  }

  // Update a scene's rating and reposition it in the sorted array to keep ranks accurate
  function repositionSceneInArray(arr, sceneId, newRating) {
    const idx = arr.findIndex(s => s.id === sceneId);
    if (idx === -1) return false;
    
    const scene = arr[idx];
    scene.rating100 = newRating;
    
    // Remove from current position
    arr.splice(idx, 1);
    
    // Find correct position (array is sorted by rating DESC)
    const newIdx = arr.findIndex(s => (s.rating100 || 0) < newRating);
    
    // Insert at correct position
    if (newIdx === -1) {
      arr.push(scene); // Lowest rated, goes at end
    } else {
      arr.splice(newIdx, 0, scene);
    }
    
    return true;
  }

  // Update a scene's rating in the memory cache (keeps cache in sync after rating changes)
  function updateSceneInCache(sceneId, newRating) {
    // Reposition in allScenes (keeps rankings accurate, scene stays for opponent pool)
    if (memoryCache.allScenes) {
      repositionSceneInArray(memoryCache.allScenes, sceneId, newRating);
      console.log(`[Stash Battle] 📝 Updated scene ${sceneId} rating to ${newRating} in memory cache`);
    }
    
    // Also update in filteredScenes if present (but don't remove - that's done separately)
    if (memoryCache.filteredScenes) {
      const scene = memoryCache.filteredScenes.find(s => s.id === sceneId);
      if (scene) {
        scene.rating100 = newRating;
      }
    }
  }

  // ============================================
  // STATE PERSISTENCE
  // ============================================

  function saveState() {
    const state = {
      currentPair,
      currentRanks,
      currentMode,
      gauntletChampion,
      gauntletWins,
      gauntletChampionRank,
      gauntletDefeated,
      gauntletFalling,
      gauntletFallingScene,
      totalScenesCount,
      savedFilterParams: window.location.search
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.error("[Stash Battle] Failed to save state:", e);
    }
  }

  function loadState() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const state = JSON.parse(saved);
        currentPair = state.currentPair || { left: null, right: null };
        currentRanks = state.currentRanks || { left: null, right: null };
        currentMode = state.currentMode || "swiss";
        gauntletChampion = state.gauntletChampion || null;
        gauntletWins = state.gauntletWins || 0;
        gauntletChampionRank = state.gauntletChampionRank || 0;
        gauntletDefeated = state.gauntletDefeated || [];
        gauntletFalling = state.gauntletFalling || false;
        gauntletFallingScene = state.gauntletFallingScene || null;
        totalScenesCount = state.totalScenesCount || 0;
        savedFilterParams = state.savedFilterParams || "";
        return true;
      }
    } catch (e) {
      console.error("[Stash Battle] Failed to load state:", e);
    }
    return false;
  }

  function clearState() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      console.error("[Stash Battle] Failed to clear state:", e);
    }
  } 

  // ============================================
  // GRAPHQL QUERIES
  // ============================================

  async function graphqlQuery(query, variables = {}) {
    const response = await fetch("/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    const result = await response.json();
    if (result.errors) {
      console.error("[Stash Battle] GraphQL error:", result.errors);
      throw new Error(result.errors[0].message);
    }
    return result.data;
  }

  const SCENE_FRAGMENT = `
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

  // ============================================
  // NAVIGATION
  // ============================================

  // Navigate using React Router (preserves JS state)
  function navigateToUrl(url) {
    closeRankingModal();
    
    // Use History API + popstate event to trigger React Router navigation
    const path = url.startsWith('/') ? url : new URL(url).pathname + new URL(url).search;
    window.history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
  }

  // ============================================
  // URL FILTER PARSING
  // ============================================

  // Get current URL search params
  function getSearchParams() {
    return new URLSearchParams(window.location.search);
  }

  // Build FindFilterType from search params
  function getFindFilter(searchParams, overrides = {}) {
    const filter = {
      per_page: overrides.per_page ?? -1,
      sort: overrides.sort ?? (searchParams.get("sortby") || "rating"),
      direction: overrides.direction ?? (searchParams.get("sortdir")?.toUpperCase() || "DESC"),
      ...overrides
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

  // Criterion category mappings for URL → GraphQL transformation
  // Each category requires different transformation logic
  const CRITERION_CATEGORIES = {
    // Boolean: no modifier, value is "true"/"false" string → convert to boolean
    boolean: new Set(["organized", "interactive", "performer_favorite"]),
    // StringEnum: URL has modifier but GraphQL just expects the string value directly
    stringEnum: new Set(["is_missing", "has_markers"]),
    // Multi: value is array of {id, label} → extract IDs only
    multi: new Set(["performers", "groups", "movies", "galleries"]),
    // HierarchicalMulti: value has {items, excluded, depth} → rename to {value, excludes, depth} and extract IDs
    hierarchicalMulti: new Set(["tags", "studios", "performer_tags"]),
  };
  
  // Resolution string to GraphQL enum mapping
  // URL uses human-readable strings, GraphQL expects ResolutionEnum values
  const RESOLUTION_MAP = {
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
    "Huge": "HUGE",
  };
  
  // Orientation string to GraphQL enum mapping
  const ORIENTATION_MAP = {
    "Landscape": "LANDSCAPE",
    "Portrait": "PORTRAIT",
    "Square": "SQUARE",
  };

  // Build SceneFilterType from URL 'c' params
  // Transforms URL criterion format to GraphQL SceneFilterType format
  function getSceneFilter(searchParams) {
    const sceneFilter = {};
    
    if (!searchParams.has("c")) return null;
    
    for (const cStr of searchParams.getAll("c")) {
      try {
        // Decode URL format: () → {} (safely preserving strings)
        const decoded = translateJSON(cStr, true);
        const cObj = JSON.parse(decoded);
        
        const filterType = cObj.type;
        if (!filterType) {
          console.warn("[Stash Battle] Filter missing type:", cObj);
          continue;
        }
        
        // Remove type from the object - it becomes the key
        const { type, ...rest } = cObj;
        
        // Category: Boolean (organized, interactive, performer_favorite)
        // URL: { type, value: "true" } → GraphQL: true
        if (CRITERION_CATEGORIES.boolean.has(filterType)) {
          sceneFilter[filterType] = rest.value === "true" || rest.value === true;
          continue;
        }
        
        // Category: StringEnum (sceneIsMissing, hasMarkers)
        // URL: { type, value: "enumValue" } → GraphQL: "enumValue"
        if (CRITERION_CATEGORIES.stringEnum.has(filterType)) {
          sceneFilter[filterType] = rest.value;
          continue;
        }
        
        // Category: Multi (performers, groups, movies, galleries)
        // URL uses same {items, excluded} structure as hierarchical, but GraphQL doesn't use depth
        // URL: { type, modifier, value: { items: [{id, label}], excluded: [{id, label}] } }
        // GraphQL: { modifier, value: [ids], excludes?: [ids] }
        if (CRITERION_CATEGORIES.multi.has(filterType)) {
          const result = { modifier: rest.modifier };
          const val = rest.value || {};
          
          // Handle {items, excluded} structure (standard URL format)
          if (val.items !== undefined) {
            const items = val.items || [];
            const excluded = val.excluded || [];
            result.value = items.map(v => (typeof v === "object" && v.id) ? v.id : v);
            if (excluded.length > 0) {
              result.excludes = excluded.map(v => (typeof v === "object" && v.id) ? v.id : v);
            }
          }
          // Handle flat array format (fallback)
          else if (Array.isArray(rest.value)) {
            result.value = rest.value.map(v => (typeof v === "object" && v.id) ? v.id : v);
          }
          // IS_NULL/NOT_NULL don't use value, but GraphQL schema still requires it (empty array for multi)
          else if (rest.modifier === "IS_NULL" || rest.modifier === "NOT_NULL") {
            result.value = [];
          }
          // Pass through as-is (shouldn't happen, but safe fallback)
          else {
            result.value = rest.value;
          }
          
          sceneFilter[filterType] = result;
          continue;
        }
        
        // Category: HierarchicalMulti (tags, studios, performer_tags)
        // URL: { type, modifier, value: { items: [{id, label}], excluded: [{id, label}], depth } }
        // GraphQL: { modifier, value: [ids], excludes: [ids], depth }
        if (CRITERION_CATEGORIES.hierarchicalMulti.has(filterType)) {
          const val = rest.value || {};
          const items = val.items || [];
          const excluded = val.excluded || [];
          sceneFilter[filterType] = {
            modifier: rest.modifier,
            value: items.map(v => (typeof v === "object" && v.id) ? v.id : v),
            excludes: excluded.map(v => (typeof v === "object" && v.id) ? v.id : v),
            depth: val.depth ?? 0
          };
          continue;
        }
        
        // Category: Resolution (needs string → enum conversion)
        // URL: { type: "resolution", modifier, value: "720p" } → GraphQL: { modifier, value: "STANDARD_HD" }
        if (filterType === "resolution") {
          sceneFilter[filterType] = {
            modifier: rest.modifier,
            value: RESOLUTION_MAP[rest.value] || rest.value
          };
          continue;
        }
        
        // Category: Orientation (multi-select enum, no modifier)
        // URL: { type: "orientation", value: ["Landscape", "Portrait"] } → GraphQL: { value: ["LANDSCAPE", "PORTRAIT"] }
        if (filterType === "orientation") {
          const values = Array.isArray(rest.value) ? rest.value : [rest.value];
          sceneFilter[filterType] = {
            value: values.map(v => ORIENTATION_MAP[v] || v).filter(Boolean)
          };
          continue;
        }
        
        // Category: Duplicated (phash duplicate filter - different structure)
        // URL: { type: "duplicated", value: "true" } → GraphQL: { duplicated: true }
        if (filterType === "duplicated") {
          sceneFilter[filterType] = {
            duplicated: rest.value === "true" || rest.value === true
          };
          continue;
        }
        
        // Category: Standard (number, string, date, timestamp, duration, special)
        // Check if value needs flattening (nested { value, value2 } structure from range criteria)
        if (rest.value && typeof rest.value === "object" && !Array.isArray(rest.value) && "value" in rest.value) {
          // Flatten: { modifier, value: { value: X, value2: Y } } → { modifier, value: X, value2: Y }
          sceneFilter[filterType] = {
            modifier: rest.modifier,
            value: rest.value.value,
            ...(rest.value.value2 !== undefined && { value2: rest.value.value2 })
          };
        } else if (rest.modifier === "IS_NULL" || rest.modifier === "NOT_NULL") {
          // IS_NULL/NOT_NULL modifiers don't use the value, but GraphQL schema still requires it
          // Provide a dummy value (0 for numbers, empty string for strings) to satisfy the schema
          sceneFilter[filterType] = {
            modifier: rest.modifier,
            value: 0
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

  // Fisher-Yates shuffle algorithm - creates a randomized copy of the array
  function shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  // Get next scene from shuffled filtered list (prevents duplicates when skipping)
  // Reshuffles when filter changes or when all scenes have been shown
  let lastShownSceneId = null; // Track last scene to avoid immediate repeat after reshuffle
  
  function getNextFilteredScene(filteredScenes, filterKey) {
    // If filter changed, clear removed tracking BEFORE filtering
    if (shuffleFilterKey !== null && filterKey !== shuffleFilterKey) {
      console.log("[Stash Battle] 🔀 Filter changed, resetting removed scenes tracking");
      removedSceneIds.clear();
    }
    
    // Filter out scenes that were removed this session (survives background refresh race condition)
    const availableScenes = filteredScenes.filter(s => !removedSceneIds.has(s.id));
    
    // Check if pool is exhausted (all scenes rated)
    if (availableScenes.length === 0) {
      console.log("[Stash Battle] 🏁 Filtered pool exhausted - all scenes rated!");
      return null; // Signal that pool is empty
    }
    
    // Reshuffle if filter changed or first load
    if (filterKey !== shuffleFilterKey || shuffledFilteredScenes.length === 0) {
      console.log("[Stash Battle] 🔀 Shuffling filtered scenes (filter changed or first load)");
      shuffledFilteredScenes = shuffleArray(availableScenes);
      shuffleIndex = 0;
      shuffleFilterKey = filterKey;
      lastShownSceneId = null; // Reset on filter change
    }
    
    // Reshuffle if we've gone through all remaining scenes
    if (shuffleIndex >= shuffledFilteredScenes.length) {
      console.log("[Stash Battle] 🔀 Reshuffling (completed full cycle)");
      shuffledFilteredScenes = shuffleArray(availableScenes);
      shuffleIndex = 0;
      
      // Avoid showing the same scene that ended the previous cycle
      if (lastShownSceneId && shuffledFilteredScenes.length > 1 && 
          shuffledFilteredScenes[0].id === lastShownSceneId) {
        // Swap first scene with a random other position
        const swapIdx = 1 + Math.floor(Math.random() * (shuffledFilteredScenes.length - 1));
        [shuffledFilteredScenes[0], shuffledFilteredScenes[swapIdx]] = 
          [shuffledFilteredScenes[swapIdx], shuffledFilteredScenes[0]];
        console.log("[Stash Battle] 🔄 Swapped first scene to avoid repeat");
      }
    }
    
    const scene = shuffledFilteredScenes[shuffleIndex];
    shuffleIndex++;
    lastShownSceneId = scene.id; // Remember for next reshuffle
    console.log(`[Stash Battle] 📍 Picked scene ${scene.id} (${shuffledFilteredScenes.length - shuffleIndex} remaining in pool, ${removedSceneIds.size} removed this session)`);
    return scene;
  }

  async function fetchSceneCount() {
    const searchParams = getSearchParams();
    const sceneFilter = getSceneFilter(searchParams);
    
    const countQuery = `
      query FindScenesCount($scene_filter: SceneFilterType) {
        findScenes(filter: { per_page: 0 }, scene_filter: $scene_filter) {
          count
        }
      }
    `;
    const countResult = await graphqlQuery(countQuery, { scene_filter: sceneFilter });
    return countResult.findScenes.count;
  }

  async function fetchRandomScenes(count = 2) {
    const totalScenes = await fetchSceneCount();
    
    if (totalScenes < 2) {
      throw new Error("Not enough scenes for comparison. You need at least 2 scenes.");
    }

    const searchParams = getSearchParams();
    const sceneFilter = getSceneFilter(searchParams);

    const scenesQuery = `
      query FindRandomScenes($filter: FindFilterType, $scene_filter: SceneFilterType) {
        findScenes(filter: $filter, scene_filter: $scene_filter) {
          scenes {
            ${SCENE_FRAGMENT}
          }
        }
      }
    `;

    const result = await graphqlQuery(scenesQuery, {
      filter: getFindFilter(searchParams, {
        per_page: Math.min(100, totalScenes),
        sort: "random"
      }),
      scene_filter: sceneFilter
    });

    const allScenes = result.findScenes.scenes || [];
    
    if (allScenes.length < 2) {
      throw new Error("Not enough scenes returned from query.");
    }

    const shuffled = allScenes.sort(() => Math.random() - 0.5);
    return shuffled.slice(0, 2);
  }

  // Swiss mode: fetch two scenes with similar ratings
  // Left side (scene1): from filtered pool (scenes to be rated)
  // Right side (scene2): from full collection (opponents)
  async function fetchSwissPair() {
    const searchParams = getSearchParams();
    const sceneFilter = getSceneFilter(searchParams);
    const hasFilter = sceneFilter || searchParams.has("c") || searchParams.get("q");

    let filteredScenes, allScenes;
    
    if (hasFilter) {
      // With filter: need both filtered scenes and all scenes
      console.log("[Stash Battle] 📋 Filter active, fetching filtered + all scenes");
      const [filteredResult, allResult] = await Promise.all([
        getFilteredScenesCached(searchParams, sceneFilter),
        getAllScenesCached()
      ]);
      filteredScenes = filteredResult.scenes || [];
      allScenes = allResult.scenes || [];
    } else {
      // No filter: all scenes = filtered scenes, only need one fetch
      console.log("[Stash Battle] 📋 No filter active, using all scenes");
      const allResult = await getAllScenesCached();
      allScenes = allResult.scenes || [];
      filteredScenes = allScenes;
    }
    
    // Need at least 2 scenes in full collection for opponents
    if (allScenes.length < 2) {
      throw new Error("Not enough scenes for comparison.");
    }
    // Note: filteredScenes can be empty - getNextFilteredScene will return null for poolExhausted

    // Pick next scene from shuffled filtered pool (left side - to be rated)
    let filterKey = buildFilterKey(searchParams, sceneFilter);
    let scene1 = getNextFilteredScene(filteredScenes, filterKey);
    
    // Handle pool exhaustion - auto-refresh and continue
    if (!scene1) {
      console.log("[Stash Battle] 🏁 Pool exhausted, fetching fresh from network...");
      
      // Clear filtered cache (memory + IndexedDB) to force fresh network fetch
      // This picks up newly-qualified scenes (e.g., a scene that just hit rating 100)
      await clearFilteredCache();
      shuffledFilteredScenes = [];
      shuffleIndex = 0;
      shuffleFilterKey = null;
      removedSceneIds.clear(); // Safe to clear since we're forcing a fresh network fetch
      
      // Re-fetch filtered scenes (will hit network since cache is cleared)
      if (hasFilter) {
        const freshResult = await getFilteredScenesCached(searchParams, sceneFilter);
        filteredScenes = freshResult.scenes || [];
      } else {
        // For no filter, allScenes is already fresh enough
        filteredScenes = allScenes;
      }
      
      // Try again with fresh pool (removedSceneIds will filter out already-rated scenes)
      filterKey = buildFilterKey(searchParams, sceneFilter);
      scene1 = getNextFilteredScene(filteredScenes, filterKey);
      
      // If still empty after fresh fetch, truly no scenes match (or all were already rated)
      if (!scene1) {
        throw new Error("No scenes match your filter criteria.");
      }
    }
    
    const rating1 = scene1.rating100 || 50;

    // Find opponent from full collection with similar rating (right side)
    // allScenes is already sorted by rating DESC, so grab neighbors around scene1's position
    const scene1Idx = allScenes.findIndex(s => s.id === scene1.id);
    const scene1RankInAll = scene1Idx + 1; // Reuse the index we already found
    
    // Collect candidates from nearby positions (excluding scene1)
    const candidates = [];
    const reach = 5; // How far above/below to look (gives up to 10 candidates)
    
    // Grab scenes above (higher rated) and below (lower rated)
    for (let i = scene1Idx - reach; i <= scene1Idx + reach; i++) {
      if (i >= 0 && i < allScenes.length && i !== scene1Idx) {
        candidates.push({ scene: allScenes[i], idx: i });
      }
    }
    
    // Fallback: if no candidates (shouldn't happen with 2+ scenes), pick any other scene
    if (candidates.length === 0) {
      const fallbackIdx = scene1Idx === 0 ? 1 : 0;
      candidates.push({ scene: allScenes[fallbackIdx], idx: fallbackIdx });
    }
    
    // Pick randomly from candidates
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    const scene2 = pick.scene;
    const scene2Index = pick.idx;

    return { 
      scenes: [scene1, scene2], 
      ranks: [scene1RankInAll, scene2Index + 1] 
    };
  }

  // Find the lowest actually rated scene in a descending-sorted array, excluding a specific scene
  // Returns { scene, index } or fallback to first non-excluded scene if none rated
  function findLowestRated(scenes, excludeId) {
    for (let i = scenes.length - 1; i >= 0; i--) {
      const s = scenes[i];
      if (s.id !== excludeId && s.rating100 != null) {
        return { scene: s, index: i };
      }
    }
    // Fallback to any scene if none rated
    const fallbackIndex = scenes.findIndex(s => s.id !== excludeId);
    return { scene: scenes[fallbackIndex], index: fallbackIndex };
  }

  // Gauntlet mode: champion vs next challenger
  // Left side (champion): initially picked from filtered pool (scenes to be rated)
  // Right side (opponents): from full collection
  async function fetchGauntletPair() {
    const searchParams = getSearchParams();
    const sceneFilter = getSceneFilter(searchParams);
    const hasFilter = sceneFilter || searchParams.has("c") || searchParams.get("q");

    // Get ALL scenes for opponent pool and ranking - CACHED
    console.log("[Stash Battle] 📋 Fetching all scenes for gauntlet...");
    const allResult = await getAllScenesCached();
    const allScenes = allResult.scenes || [];
    totalScenesCount = allResult.count || allScenes.length;
    
    if (allScenes.length < 2) {
      return { scenes: await fetchRandomScenes(2), ranks: [null, null], isVictory: false, isFalling: false };
    }

    // Handle falling mode - find next opponent BELOW to test against (from full collection)
    if (gauntletFalling && gauntletFallingScene) {
      const fallingIndex = allScenes.findIndex(s => s.id === gauntletFallingScene.id);
      
      // Find opponents below (higher index) that haven't been tested
      const belowOpponents = allScenes.filter((s, idx) => {
        if (s.id === gauntletFallingScene.id) return false;
        if (gauntletDefeated.includes(s.id)) return false;
        return idx > fallingIndex; // Below in ranking
      });
      
      if (belowOpponents.length === 0) {
        // Hit the bottom - they're the lowest, place them here
        const finalRank = allScenes.length;
        const finalRating = 1; // Lowest rating
        updateSceneRating(gauntletFallingScene.id, finalRating);
        
        return {
          scenes: [gauntletFallingScene],
          ranks: [finalRank],
          isVictory: false,
          isFalling: true,
          isPlacement: true,
          placementRank: finalRank,
          placementRating: finalRating
        };
      } else {
        // Get next opponent below (first one, closest to falling scene)
        const nextBelow = belowOpponents[0];
        const nextBelowIndex = allScenes.findIndex(s => s.id === nextBelow.id);
        
        // Update the falling scene's rank for display
        gauntletChampionRank = fallingIndex + 1;
        
        return {
          scenes: [gauntletFallingScene, nextBelow],
          ranks: [fallingIndex + 1, nextBelowIndex + 1],
          isVictory: false,
          isFalling: true
        };
      }
    }

    // If no champion yet, pick from filtered pool to start
    if (!gauntletChampion) {
      // Reset state
      gauntletDefeated = [];
      gauntletFalling = false;
      gauntletFallingScene = null;
      
      // Get filtered scenes to pick initial challenger from (scenes to be rated) - CACHED
      // If no filter, reuse allScenes to avoid redundant cache hit
      const filteredScenes = hasFilter 
        ? (await getFilteredScenesCached(searchParams, sceneFilter)).scenes || []
        : allScenes;
      
      if (filteredScenes.length < 1) {
        throw new Error("No scenes match your filter criteria.");
      }
      
      // Pick next scene from shuffled filtered pool as challenger (left side - to be rated)
      const filterKey = buildFilterKey(searchParams, sceneFilter);
      const challenger = getNextFilteredScene(filteredScenes, filterKey);
      
      if (!challenger) {
        throw new Error("No scenes match your filter criteria.");
      }
      
      // Find challenger's position in full collection
      const challengerIndex = allScenes.findIndex(s => s.id === challenger.id);
      
      // Start at the bottom - find lowest actually rated scene (unrated = unknown, not lowest)
      const { scene: lowestRated, index: lowestIndex } = findLowestRated(allScenes, challenger.id);
      
      // Challenger's current rank in full collection
      gauntletChampionRank = challengerIndex >= 0 ? challengerIndex + 1 : allScenes.length;
      
      return { 
        scenes: [challenger, lowestRated], 
        ranks: [gauntletChampionRank, lowestIndex + 1],
        isVictory: false,
        isFalling: false
      };
    }

    // Champion exists - find next opponent from full collection they haven't defeated yet
    const championIndex = allScenes.findIndex(s => s.id === gauntletChampion.id);
    
    // Update champion rank (1-indexed, so +1)
    gauntletChampionRank = championIndex >= 0 ? championIndex + 1 : 1;
    
    // Find opponents above champion that haven't been defeated (from full collection)
    const remainingOpponents = allScenes.filter((s, idx) => {
      if (s.id === gauntletChampion.id) return false;
      if (gauntletDefeated.includes(s.id)) return false;
      // Only scenes ranked higher (lower index) or same rating
      return idx < championIndex || (s.rating100 || 0) >= (gauntletChampion.rating100 || 0);
    });
    
    // If no opponents left, champion has truly won
    if (remainingOpponents.length === 0) {
      gauntletChampionRank = 1;
      return { 
        scenes: [gauntletChampion], 
        ranks: [1],
        isVictory: true,
        isFalling: false
      };
    }
    
    // Pick the next highest-ranked remaining opponent
    const nextOpponent = remainingOpponents[remainingOpponents.length - 1]; // Closest to champion
    const nextOpponentIndex = allScenes.findIndex(s => s.id === nextOpponent.id);
    
    return { 
      scenes: [gauntletChampion, nextOpponent], 
      ranks: [championIndex + 1, nextOpponentIndex + 1],
      isVictory: false,
      isFalling: false
    };
  }

  // Champion mode: like gauntlet but winner stays on (no falling)
  // Left side (champion): initially picked from filtered pool (scenes to be rated)
  // Right side (opponents): from full collection
  async function fetchChampionPair() {
    const searchParams = getSearchParams();
    const sceneFilter = getSceneFilter(searchParams);
    const hasFilter = sceneFilter || searchParams.has("c") || searchParams.get("q");

    // Get ALL scenes for opponent pool and ranking - CACHED
    console.log("[Stash Battle] 📋 Fetching all scenes for champion...");
    const allResult = await getAllScenesCached();
    const allScenes = allResult.scenes || [];
    totalScenesCount = allResult.count || allScenes.length;
    
    if (allScenes.length < 2) {
      return { scenes: await fetchRandomScenes(2), ranks: [null, null], isVictory: false };
    }

    // If no champion yet, pick from filtered pool to start
    if (!gauntletChampion) {
      gauntletDefeated = [];
      
      // Get filtered scenes to pick initial challenger from (scenes to be rated) - CACHED
      // If no filter, reuse allScenes to avoid redundant cache hit
      const filteredScenes = hasFilter 
        ? (await getFilteredScenesCached(searchParams, sceneFilter)).scenes || []
        : allScenes;
      
      if (filteredScenes.length < 1) {
        throw new Error("No scenes match your filter criteria.");
      }
      
      // Pick next scene from shuffled filtered pool as challenger (left side - to be rated)
      const filterKey = buildFilterKey(searchParams, sceneFilter);
      const challenger = getNextFilteredScene(filteredScenes, filterKey);
      
      if (!challenger) {
        throw new Error("No scenes match your filter criteria.");
      }
      
      // Find challenger's position in full collection
      const challengerIndex = allScenes.findIndex(s => s.id === challenger.id);
      
      // Start at the bottom - find lowest actually rated scene (unrated = unknown, not lowest)
      const { scene: lowestRated, index: lowestIndex } = findLowestRated(allScenes, challenger.id);
      
      gauntletChampionRank = challengerIndex >= 0 ? challengerIndex + 1 : allScenes.length;
      
      return { 
        scenes: [challenger, lowestRated], 
        ranks: [gauntletChampionRank, lowestIndex + 1],
        isVictory: false
      };
    }

    // Champion exists - find next opponent from full collection they haven't defeated yet
    const championIndex = allScenes.findIndex(s => s.id === gauntletChampion.id);
    
    gauntletChampionRank = championIndex >= 0 ? championIndex + 1 : 1;
    
    // Find opponents above champion that haven't been defeated (from full collection)
    const remainingOpponents = allScenes.filter((s, idx) => {
      if (s.id === gauntletChampion.id) return false;
      if (gauntletDefeated.includes(s.id)) return false;
      return idx < championIndex || (s.rating100 || 0) >= (gauntletChampion.rating100 || 0);
    });
    
    // If no opponents left, champion has won!
    if (remainingOpponents.length === 0) {
      gauntletChampionRank = 1;
      return { 
        scenes: [gauntletChampion], 
        ranks: [1],
        isVictory: true
      };
    }
    
    // Pick the next highest-ranked remaining opponent
    const nextOpponent = remainingOpponents[remainingOpponents.length - 1];
    const nextOpponentIndex = allScenes.findIndex(s => s.id === nextOpponent.id);
    
    return { 
      scenes: [gauntletChampion, nextOpponent], 
      ranks: [championIndex + 1, nextOpponentIndex + 1],
      isVictory: false
    };
  }
  
  function createVictoryScreen(champion) {
    const file = champion.files && champion.files[0] ? champion.files[0] : {};
    let title = champion.title;
    if (!title && file.path) {
      const pathParts = file.path.split(/[/\\]/);
      title = pathParts[pathParts.length - 1].replace(/\.[^/.]+$/, "");
    }
    if (!title) {
      title = `Scene #${champion.id}`;
    }
    
    const screenshotPath = champion.paths ? champion.paths.screenshot : null;
    
    return `
      <div class="pwr-victory-screen">
        <div class="pwr-victory-crown">👑</div>
        <h2 class="pwr-victory-title">CHAMPION!</h2>
        <div class="pwr-victory-scene">
          ${screenshotPath 
            ? `<img class="pwr-victory-image" src="${screenshotPath}" alt="${title}" />`
            : `<div class="pwr-victory-image pwr-no-image">No Screenshot</div>`
          }
        </div>
        <h3 class="pwr-victory-name">${title}</h3>
        <p class="pwr-victory-stats">Conquered all ${totalScenesCount} scenes with a ${gauntletWins} win streak!</p>
        <button id="pwr-new-gauntlet" class="btn btn-primary">Start New Gauntlet</button>
      </div>
    `;
  }

  function showPlacementScreen(scene, rank, finalRating) {
    const comparisonArea = document.getElementById("pwr-comparison-area");
    if (!comparisonArea) return;
    
    const file = scene.files && scene.files[0] ? scene.files[0] : {};
    let title = scene.title;
    if (!title && file.path) {
      const pathParts = file.path.split(/[/\\]/);
      title = pathParts[pathParts.length - 1].replace(/\.[^/.]+$/, "");
    }
    if (!title) {
      title = `Scene #${scene.id}`;
    }
    
    const screenshotPath = scene.paths ? scene.paths.screenshot : null;
    
    comparisonArea.innerHTML = `
      <div class="pwr-victory-screen">
        <div class="pwr-victory-crown">📍</div>
        <h2 class="pwr-victory-title">PLACED!</h2>
        <div class="pwr-victory-scene">
          ${screenshotPath 
            ? `<img class="pwr-victory-image" src="${screenshotPath}" alt="${title}" />`
            : `<div class="pwr-victory-image pwr-no-image">No Screenshot</div>`
          }
        </div>
        <h3 class="pwr-victory-name">${title}</h3>
        <p class="pwr-victory-stats">
          Rank <strong>#${rank}</strong> of ${totalScenesCount}<br>
          Rating: <strong>${finalRating}/100</strong>
        </p>
        <button id="pwr-new-gauntlet" class="btn btn-primary">Start New Run</button>
      </div>
    `;
    
    // Hide status and actions
    const statusEl = document.getElementById("pwr-gauntlet-status");
    const actionsEl = document.querySelector(".pwr-actions");
    if (statusEl) statusEl.style.display = "none";
    if (actionsEl) actionsEl.style.display = "none";
    
    // Reset state
    gauntletFalling = false;
    gauntletFallingScene = null;
    gauntletChampion = null;
    gauntletWins = 0;
    gauntletDefeated = [];
    saveState();
    
    // Attach button handler
    const newBtn = comparisonArea.querySelector("#pwr-new-gauntlet");
    if (newBtn) {
      newBtn.addEventListener("click", () => {
        if (actionsEl) actionsEl.style.display = "";
        loadNewPair();
      });
    }
  }
  
  // Update scene rating in Stash database
  async function updateSceneRating(sceneId, rating100) {
    const mutation = `
      mutation SceneUpdate($input: SceneUpdateInput!) {
        sceneUpdate(input: $input) {
          id
          rating100
        }
      }
    `;
    
    const finalRating = Math.max(1, Math.min(100, rating100));
    
    try {
      await graphqlQuery(mutation, {
        input: {
          id: sceneId,
          rating100: finalRating
        }
      });
      console.log(`[Stash Battle] 📝 Updated scene ${sceneId} rating to ${finalRating} in Stash`);

      
      // Update the in-memory cache to keep it in sync
      updateSceneInCache(sceneId, finalRating);
      
    } catch (e) {
      console.error(`[Stash Battle] Failed to update scene ${sceneId} rating:`, e);
    }
  }

  // Remove a scene from the filtered pool (called after battle regardless of rating change)
  function removeFromFilteredPool(sceneId) {
    // Track removal - survives background refresh race condition
    removedSceneIds.add(sceneId);
    
    // Remove from filtered cache
    if (memoryCache.filteredScenes) {
      const idx = memoryCache.filteredScenes.findIndex(s => s.id === sceneId);
      if (idx !== -1) {
        memoryCache.filteredScenes.splice(idx, 1);
        console.log(`[Stash Battle] 🗑️ Removed scene ${sceneId} from filtered pool (${memoryCache.filteredScenes.length} remaining, ${removedSceneIds.size} removed this session)`);
      }
    }
    
    // Also remove from shuffled queue
    const shuffleIdx = shuffledFilteredScenes.findIndex(s => s.id === sceneId);
    if (shuffleIdx !== -1) {
      shuffledFilteredScenes.splice(shuffleIdx, 1);
      if (shuffleIdx < shuffleIndex) {
        shuffleIndex--;
      }
    }
  }

  // ============================================
  // RATING LOGIC
  // ============================================

  // Dynamic K-factor based on play_count (similar to chess ELO for new vs established players)
  // Scenes with more plays have more "established" ratings and change more slowly
  function getKFactor(playCount) {
    const count = playCount || 0;   // Handle null/undefined
    if (count < 3) return 12;       // New: volatile, find true rating fast
    if (count < 8) return 8;        // Settling: moderate changes
    if (count < 15) return 6;       // Established: smaller changes
    return 4;                       // Very established: stable rating
  }

  function handleComparison(winnerId, loserId, winnerCurrentRating, loserCurrentRating, winnerPlayCount = 0, loserPlayCount = 0, loserRank = null) {
    const winnerRating = winnerCurrentRating || 50;
    const loserRating = loserCurrentRating || 50;
    
    const ratingDiff = loserRating - winnerRating;
    const expectedWinner = 1 / (1 + Math.pow(10, ratingDiff / 40));
    
    let winnerGain = 0, loserLoss = 0;
    
    if (currentMode === "gauntlet" || currentMode === "champion") {
      // In gauntlet/champion, only the champion/falling scene changes rating
      // Defenders stay the same (they're just benchmarks)
      // EXCEPT: if the defender is rank #1, they lose 1 point when defeated
      const isChampionWinner = gauntletChampion && winnerId === gauntletChampion.id;
      const isFallingWinner = gauntletFalling && gauntletFallingScene && winnerId === gauntletFallingScene.id;
      const isChampionLoser = gauntletChampion && loserId === gauntletChampion.id;
      const isFallingLoser = gauntletFalling && gauntletFallingScene && loserId === gauntletFallingScene.id;
      
      // Only the active scene (champion or falling) gets rating changes
      if (isChampionWinner || isFallingWinner) {
        const kFactor = getKFactor(winnerPlayCount);
        winnerGain = Math.max(1, Math.round(kFactor * (1 - expectedWinner)));
      }
      if (isChampionLoser || isFallingLoser) {
        const kFactor = getKFactor(loserPlayCount);
        loserLoss = Math.max(1, Math.round(kFactor * expectedWinner));
      }
      
      // Special case: if defender was rank #1 and lost, drop their rating by 1
      if (loserRank === 1 && !isChampionLoser && !isFallingLoser) {
        loserLoss = 1;
      }
    } else {
      // Swiss mode: True ELO - both change based on expected outcome
      const winnerK = getKFactor(winnerPlayCount);
      const loserK = getKFactor(loserPlayCount);
      
      winnerGain = Math.max(1, Math.round(winnerK * (1 - expectedWinner)));
      loserLoss = Math.max(1, Math.round(loserK * expectedWinner));
    }
    
    const newWinnerRating = Math.min(100, Math.max(1, winnerRating + winnerGain));
    const newLoserRating = Math.min(100, Math.max(1, loserRating - loserLoss));
    
    const winnerChange = newWinnerRating - winnerRating;
    const loserChange = newLoserRating - loserRating;
    
    // Update scenes in Stash (only if changed)
    if (winnerChange !== 0) updateSceneRating(winnerId, newWinnerRating);
    if (loserChange !== 0) updateSceneRating(loserId, newLoserRating);
    
    return { newWinnerRating, newLoserRating, winnerChange, loserChange };
  }
  
  // Called when gauntlet champion loses - place them one below the winner
  function finalizeGauntletLoss(championId, winnerRating) {
    // Set champion rating to just below the scene that beat them
    const newRating = Math.max(1, winnerRating - 1);
    updateSceneRating(championId, newRating);
    return newRating;
  }

  // ============================================
  // UI COMPONENTS
  // ============================================

  function formatDuration(seconds) {
    if (!seconds) return "N/A";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
    }
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  function createSceneCard(scene, side, rank = null, streak = null) {
    const file = scene.files && scene.files[0] ? scene.files[0] : {};
    const duration = file.duration;
    const performers = scene.performers && scene.performers.length > 0 
      ? scene.performers.map((p) => p.name).join(", ") 
      : "No performers";
    const studio = scene.studio ? scene.studio.name : "No studio";
    const tags = scene.tags ? scene.tags.slice(0, 5).map((t) => t.name) : [];
    
    // Title fallback: title -> filename from path -> Scene ID
    let title = scene.title;
    if (!title && file.path) {
      const pathParts = file.path.split(/[/\\]/);
      title = pathParts[pathParts.length - 1].replace(/\.[^/.]+$/, "");
    }
    if (!title) {
      title = `Scene #${scene.id}`;
    }
    
    const screenshotPath = scene.paths ? scene.paths.screenshot : null;
    const previewPath = scene.paths ? scene.paths.preview : null;
    const stashRating = scene.rating100 ? `${scene.rating100}/100` : "Unrated";
    
    // Handle numeric ranks and string ranks
    let rankDisplay = '';
    if (rank !== null && rank !== undefined) {
      if (typeof rank === 'number') {
        rankDisplay = `<span class="pwr-scene-rank">#${rank}</span>`;
      } else {
        rankDisplay = `<span class="pwr-scene-rank">${rank}</span>`;
      }
    }
    
    // Streak badge for gauntlet champion
    let streakDisplay = '';
    if (streak !== null && streak > 0) {
      streakDisplay = `<div class="pwr-streak-badge">🔥 ${streak} win${streak > 1 ? 's' : ''}</div>`;
    }

    // Preserve URL search params when opening scene
    const currentParams = window.location.search;
    const sceneUrl = `/scenes/${scene.id}${currentParams}`;

    return `
      <div class="pwr-scene-card" data-scene-id="${scene.id}" data-side="${side}" data-rating="${scene.rating100 || 50}">
        <div class="pwr-scene-image-container" data-scene-url="${sceneUrl}">
          ${screenshotPath 
            ? `<img class="pwr-scene-image" src="${screenshotPath}" alt="${title}" loading="lazy" />`
            : `<div class="pwr-scene-image pwr-no-image">No Screenshot</div>`
          }
          ${previewPath ? `<video class="pwr-hover-preview" src="${previewPath}" loop playsinline></video>` : ''}
          <div class="pwr-scene-duration">${formatDuration(duration)}</div>
          ${streakDisplay}
          <div class="pwr-click-hint">Click to open scene</div>
        </div>
        
        <div class="pwr-scene-body" data-winner="${scene.id}">
          <div class="pwr-scene-info">
            <div class="pwr-scene-title-row">
              <h3 class="pwr-scene-title">${title}</h3>
              ${rankDisplay}
            </div>
            
            <div class="pwr-scene-meta">
              <div class="pwr-meta-item"><strong>Studio:</strong> ${studio}</div>
              <div class="pwr-meta-item"><strong>Performers:</strong> ${performers}</div>
              <div class="pwr-meta-item"><strong>Play Count:</strong> ${scene.play_count || 0}</div>
              <div class="pwr-meta-item"><strong>Rating:</strong> ${stashRating}</div>
              <div class="pwr-meta-item pwr-tags-row"><strong>Tags:</strong> ${tags.length > 0 ? tags.map((tag) => `<span class="pwr-tag">${tag}</span>`).join("") : '<span class="pwr-none">None</span>'}</div>
            </div>
          </div>
          
          <div class="pwr-choose-btn">
            ✓ Choose This Scene
          </div>
        </div>
      </div>
    `;
  }

  function createMainUI() {
    return `
      <div id="stash-battle-container" class="pwr-container">
        <div class="pwr-header">
          <h1 class="pwr-title">⚔️ Stash Battle</h1>
          <p class="pwr-subtitle">Compare scenes head-to-head to build your rankings</p>
          
          <div class="pwr-mode-toggle">
            <button class="pwr-mode-btn ${currentMode === 'swiss' ? 'active' : ''}" data-mode="swiss">
              <span class="pwr-mode-icon">⚖️</span>
              <span class="pwr-mode-title">Swiss</span>
              <span class="pwr-mode-desc">Fair matchups</span>
            </button>
            <button class="pwr-mode-btn ${currentMode === 'gauntlet' ? 'active' : ''}" data-mode="gauntlet">
              <span class="pwr-mode-icon">🎯</span>
              <span class="pwr-mode-title">Gauntlet</span>
              <span class="pwr-mode-desc">Place a scene</span>
            </button>
            <button class="pwr-mode-btn ${currentMode === 'champion' ? 'active' : ''}" data-mode="champion">
              <span class="pwr-mode-icon">🏆</span>
              <span class="pwr-mode-title">Champion</span>
              <span class="pwr-mode-desc">Winner stays on</span>
            </button>
          </div>
        </div>

        <div class="pwr-content">
          <div id="pwr-comparison-area" class="pwr-comparison-area">
            <div class="pwr-loading">Loading scenes...</div>
          </div>
          <div class="pwr-actions">
            <div class="pwr-action-buttons">
              <button id="pwr-skip-btn" class="btn btn-secondary">Skip (Get New Pair)</button>
              <button id="pwr-refresh-cache-btn" class="btn btn-secondary" title="Refresh scene list from server (use if you've added new scenes)">🔄 Refresh Cache</button>
            </div>
            <div class="pwr-keyboard-hint">
              <span>← Left Arrow</span> to choose left · 
              <span>→ Right Arrow</span> to choose right · 
              <span>Space</span> to skip
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // ============================================
  // EVENT HANDLERS
  // ============================================

  // Shared rendering logic for displaying a pair of scenes
  function renderPair(scenes, ranks) {
    const comparisonArea = document.getElementById("pwr-comparison-area");
    if (!comparisonArea) return;

    // Determine streak for each card (gauntlet and champion modes)
    let leftStreak = null;
    let rightStreak = null;
    if (currentMode === "gauntlet" || currentMode === "champion") {
      if (gauntletChampion && scenes[0].id === gauntletChampion.id) {
        leftStreak = gauntletWins;
      } else if (gauntletChampion && scenes[1].id === gauntletChampion.id) {
        rightStreak = gauntletWins;
      }
    }

    comparisonArea.innerHTML = `
      <div class="pwr-vs-container">
        ${createSceneCard(scenes[0], "left", ranks[0], leftStreak)}
        <div class="pwr-vs-divider">
          <span class="pwr-vs-text">VS</span>
        </div>
        ${createSceneCard(scenes[1], "right", ranks[1], rightStreak)}
      </div>
    `;

    // Attach event listeners to scene body (for choosing)
    comparisonArea.querySelectorAll(".pwr-scene-body").forEach((body) => {
      body.addEventListener("click", handleChooseScene);
    });

    // Attach click-to-open (for thumbnail only) - use React Router navigation
    comparisonArea.querySelectorAll(".pwr-scene-image-container").forEach((container) => {
      const sceneUrl = container.dataset.sceneUrl;
      
      container.addEventListener("click", () => {
        if (sceneUrl) {
          navigateToUrl(sceneUrl);
        }
      });
    });

    // Attach hover preview to entire card
    comparisonArea.querySelectorAll(".pwr-scene-card").forEach((card) => {
      const video = card.querySelector(".pwr-hover-preview");
      if (!video) return;
      
      card.addEventListener("mouseenter", () => {
        video.currentTime = 0;
        video.muted = false;
        video.volume = 0.5;
        video.play().catch(() => {});
      });
      
      card.addEventListener("mouseleave", () => {
        video.pause();
        video.currentTime = 0;
      });
    });
    
    // Update skip button state
    const skipBtn = document.querySelector("#pwr-skip-btn");
    if (skipBtn) {
      const disableSkip = (currentMode === "gauntlet" || currentMode === "champion") && gauntletChampion;
      skipBtn.disabled = disableSkip;
      skipBtn.style.opacity = disableSkip ? "0.5" : "1";
      skipBtn.style.cursor = disableSkip ? "not-allowed" : "pointer";
    }
  }

  async function loadNewPair() {
    disableChoice = false;
    const comparisonArea = document.getElementById("pwr-comparison-area");
    if (!comparisonArea) return;

    console.log(`[Stash Battle] 🎮 Loading new pair (mode: ${currentMode})...`);
    const startTime = Date.now();

    // Only show loading on first load (when empty or already showing loading)
    if (!comparisonArea.querySelector('.pwr-vs-container')) {
      const hasCache = memoryCache.allScenes !== null;
      comparisonArea.innerHTML = `<div class="pwr-loading">${hasCache ? 'Loading scenes...' : 'Loading and caching scenes (first load may take a moment)...'}</div>`;
    }

    try {
      let scenes;
      let ranks = [null, null];
      
      if (currentMode === "gauntlet") {
        const gauntletResult = await fetchGauntletPair();
        
        // Check for victory (champion reached #1)
        if (gauntletResult.isVictory) {
          comparisonArea.innerHTML = createVictoryScreen(gauntletResult.scenes[0]);
          
          // Hide the status banner and skip button
          const statusEl = document.getElementById("pwr-gauntlet-status");
          const actionsEl = document.querySelector(".pwr-actions");
          if (statusEl) statusEl.style.display = "none";
          if (actionsEl) actionsEl.style.display = "none";
          
          // Attach new gauntlet button
          const newGauntletBtn = comparisonArea.querySelector("#pwr-new-gauntlet");
          if (newGauntletBtn) {
            newGauntletBtn.addEventListener("click", () => {
              gauntletChampion = null;
              gauntletWins = 0;
              gauntletChampionRank = 0;
              gauntletDefeated = [];
              gauntletFalling = false;
              gauntletFallingScene = null;
              saveState();
              // Show the actions again
              if (actionsEl) actionsEl.style.display = "";
              loadNewPair();
            });
          }
          
          return;
        }
        
        // Check for placement (falling scene hit bottom)
        if (gauntletResult.isPlacement) {
          showPlacementScreen(gauntletResult.scenes[0], gauntletResult.placementRank, gauntletResult.placementRating);
          return;
        }
        
        scenes = gauntletResult.scenes;
        ranks = gauntletResult.ranks;
      } else if (currentMode === "champion") {
        const championResult = await fetchChampionPair();
        
        // Check for victory (champion beat everyone)
        if (championResult.isVictory) {
          comparisonArea.innerHTML = createVictoryScreen(championResult.scenes[0]);
          
          // Hide the skip button
          const actionsEl = document.querySelector(".pwr-actions");
          if (actionsEl) actionsEl.style.display = "none";
          
          // Attach new run button
          const newGauntletBtn = comparisonArea.querySelector("#pwr-new-gauntlet");
          if (newGauntletBtn) {
            newGauntletBtn.addEventListener("click", () => {
              gauntletChampion = null;
              gauntletWins = 0;
              gauntletChampionRank = 0;
              gauntletDefeated = [];
              saveState();
              if (actionsEl) actionsEl.style.display = "";
              loadNewPair();
            });
          }
          
          return;
        }
        
        scenes = championResult.scenes;
        ranks = championResult.ranks;
      } else {
        const swissResult = await fetchSwissPair();
        
        scenes = swissResult.scenes;
        ranks = swissResult.ranks;
      }
      
      if (scenes.length < 2) {
        comparisonArea.innerHTML =
          '<div class="pwr-error">Not enough scenes available for comparison.</div>';
        return;
      }

      currentPair.left = scenes[0];
      currentPair.right = scenes[1];
      currentRanks.left = ranks[0];
      currentRanks.right = ranks[1];

      const loadTime = Date.now() - startTime;
      console.log(`[Stash Battle] ✅ Pair loaded in ${loadTime}ms: Scene ${scenes[0].id} (rank #${ranks[0]}) vs Scene ${scenes[1].id} (rank #${ranks[1]})`);

      renderPair(scenes, ranks);
      saveState();
    } catch (error) {
      console.error("[Stash Battle] Error loading scenes:", error);
      const isNoScenes = error.message.includes("No scenes") || error.message.includes("Not enough");
      comparisonArea.innerHTML = `
        <div class="pwr-error-screen">
          <div class="pwr-error-icon">⚠️</div>
          <p class="pwr-error-message">${error.message}</p>
          <button id="pwr-error-retry" class="btn btn-primary">Retry</button>
        </div>
      `;
      
      // Attach retry handler
      const retryBtn = document.getElementById("pwr-error-retry");
      if (retryBtn) {
        retryBtn.addEventListener("click", async () => {
          retryBtn.disabled = true;
          retryBtn.textContent = "Loading...";
          
          if (isNoScenes) {
            // "No scenes" error: clear everything and start fresh
            await clearFilteredCache();
            shuffledFilteredScenes = [];
            shuffleIndex = 0;
            shuffleFilterKey = null;
            removedSceneIds.clear();
          }
          // Network/other errors: just retry without clearing session state
          
          await loadNewPair();
        });
      }
    }
  }

  function restoreCurrentPair() {
    disableChoice = false;
    console.log("[Stash Battle] 📂 Rendering saved pair (no network fetch needed)");

    // Pre-warm the cache in background for when user makes a choice
    if (!memoryCache.allScenes) {
      console.log("[Stash Battle] 🔥 Pre-warming cache in background...");
      getAllScenesCached(); // Don't await - runs in background
    }

    renderPair(
      [currentPair.left, currentPair.right],
      [currentRanks.left, currentRanks.right]
    );
  }

  function handleChooseScene(event) {
    if(disableChoice) return;
    disableChoice = true;
    const body = event.currentTarget;
    const winnerId = body.dataset.winner;
    const winnerCard = body.closest(".pwr-scene-card");
    const loserId = winnerId === currentPair.left.id ? currentPair.right.id : currentPair.left.id;
    
    const winnerRating = parseInt(winnerCard.dataset.rating) || 50;
    const loserCard = document.querySelector(`.pwr-scene-card[data-scene-id="${loserId}"]`);
    const loserRating = parseInt(loserCard?.dataset.rating) || 50;
    
    // Get the loser's rank for #1 dethrone logic
    const loserRank = loserId === currentPair.left.id ? currentRanks.left : currentRanks.right;

    // Handle gauntlet mode (champion tracking)
    if (currentMode === "gauntlet") {
      const winnerScene = winnerId === currentPair.left.id ? currentPair.left : currentPair.right;
      const loserScene = loserId === currentPair.left.id ? currentPair.left : currentPair.right;
      
      // Check if we're in falling mode (finding floor after a loss)
      if (gauntletFalling && gauntletFallingScene) {
        if (winnerId === gauntletFallingScene.id) {
          // Falling scene won - found their floor!
          // Set their rating to just above the scene they beat
          const finalRating = Math.min(100, loserRating + 1);
          updateSceneRating(gauntletFallingScene.id, finalRating);
          
          // Final rank is one above the opponent (we beat them, so we're above them)
          const opponentRank = loserId === currentPair.left.id ? currentRanks.left : currentRanks.right;
          const finalRank = Math.max(1, (opponentRank || 1) - 1);
          
          // Visual feedback
          winnerCard.classList.add("pwr-winner");
          if (loserCard) loserCard.classList.add("pwr-loser");
          
          // Show placement screen after brief delay
          setTimeout(() => {
            showPlacementScreen(gauntletFallingScene, finalRank, finalRating);
            saveState();
          }, 800);
          return;
        } else {
          // Falling scene lost again - keep falling
          gauntletDefeated.push(winnerId);
          saveState();
          
          // Visual feedback
          winnerCard.classList.add("pwr-winner");
          if (loserCard) loserCard.classList.add("pwr-loser");
          
          setTimeout(() => {
            loadNewPair();
          }, 800);
          return;
        }
      }
      
      // Normal climbing - calculate rating changes (pass loserRank for #1 dethrone)
      const { newWinnerRating, newLoserRating, winnerChange, loserChange } = handleComparison(
        winnerId, loserId, winnerRating, loserRating,
        winnerScene.play_count, loserScene.play_count, loserRank
      );
      
      if (gauntletChampion && winnerId === gauntletChampion.id) {
        // Champion won - add loser to defeated list and continue climbing
        gauntletDefeated.push(loserId);
        gauntletWins++;
        gauntletChampion.rating100 = newWinnerRating;
      } else if (gauntletChampion && winnerId !== gauntletChampion.id) {
        // Champion LOST - start falling to find their floor
        gauntletFalling = true;
        gauntletFallingScene = loserScene; // The old champion is now falling
        gauntletDefeated = [winnerId]; // They lost to this scene
        
        // Winner becomes the new climbing champion
        gauntletChampion = winnerScene;
        gauntletChampion.rating100 = newWinnerRating;
        gauntletWins = 1;
      } else {
        // No champion yet - winner becomes champion
        gauntletChampion = winnerScene;
        gauntletChampion.rating100 = newWinnerRating;
        gauntletDefeated = [loserId];
        gauntletWins = 1;
      }
      
      saveState();
      
      // Visual feedback with animations
      winnerCard.classList.add("pwr-winner");
      if (loserCard) loserCard.classList.add("pwr-loser");
      
      showRatingAnimation(winnerCard, winnerRating, newWinnerRating, winnerChange, true);
      if (loserCard) {
        showRatingAnimation(loserCard, loserRating, newLoserRating, loserChange, false);
      }
      
      // Load new pair after animation
      setTimeout(() => {
        loadNewPair();
      }, 1500);
      return;
    }

    // Handle champion mode (like gauntlet but winner always takes over)
    if (currentMode === "champion") {
      const winnerScene = winnerId === currentPair.left.id ? currentPair.left : currentPair.right;
      const loserScene = loserId === currentPair.left.id ? currentPair.left : currentPair.right;
      
      // Calculate rating changes (pass loserRank for #1 dethrone)
      const { newWinnerRating, newLoserRating, winnerChange, loserChange } = handleComparison(
        winnerId, loserId, winnerRating, loserRating,
        winnerScene.play_count, loserScene.play_count, loserRank
      );
      
      if (gauntletChampion && winnerId === gauntletChampion.id) {
        // Champion won - continue climbing
        gauntletDefeated.push(loserId);
        gauntletWins++;
        gauntletChampion.rating100 = newWinnerRating;
      } else {
        // Champion lost or first pick - winner becomes new champion
        gauntletChampion = winnerScene;
        gauntletChampion.rating100 = newWinnerRating;
        gauntletDefeated = [loserId];
        gauntletWins = 1;
      }
      
      saveState();
      
      // Visual feedback with animations
      winnerCard.classList.add("pwr-winner");
      if (loserCard) loserCard.classList.add("pwr-loser");
      
      showRatingAnimation(winnerCard, winnerRating, newWinnerRating, winnerChange, true);
      if (loserCard) {
        showRatingAnimation(loserCard, loserRating, newLoserRating, loserChange, false);
      }
      
      // Load new pair after animation
      setTimeout(() => {
        loadNewPair();
      }, 1500);
      return;
    }

    // For Swiss: Calculate and show rating changes
    const winnerScene = winnerId === currentPair.left.id ? currentPair.left : currentPair.right;
    const loserScene = loserId === currentPair.left.id ? currentPair.left : currentPair.right;
    const { newWinnerRating, newLoserRating, winnerChange, loserChange } = handleComparison(
      winnerId, loserId, winnerRating, loserRating,
      winnerScene.play_count, loserScene.play_count
    );
    
    // Remove both scenes from filtered pool (they've been processed)
    // This prevents the loser from reappearing if it no longer matches the filter
    removeFromFilteredPool(currentPair.left.id);
    removeFromFilteredPool(currentPair.right.id);

    saveState();

    // Visual feedback
    winnerCard.classList.add("pwr-winner");
    if (loserCard) loserCard.classList.add("pwr-loser");

    // Show rating change animation
    showRatingAnimation(winnerCard, winnerRating, newWinnerRating, winnerChange, true);
    if (loserCard) {
      showRatingAnimation(loserCard, loserRating, newLoserRating, loserChange, false);
    }

    // Load new pair after animation
    setTimeout(() => {
      loadNewPair();
    }, 1500);
  }

  function showRatingAnimation(card, oldRating, newRating, change, isWinner) {
    // Create overlay
    const overlay = document.createElement("div");
    overlay.className = `pwr-rating-overlay ${isWinner ? 'pwr-rating-winner' : 'pwr-rating-loser'}`;
    
    const ratingDisplay = document.createElement("div");
    ratingDisplay.className = "pwr-rating-display";
    ratingDisplay.textContent = oldRating;
    
    const changeDisplay = document.createElement("div");
    changeDisplay.className = "pwr-rating-change";
    changeDisplay.textContent = isWinner ? `+${change}` : `${change}`;
    
    overlay.appendChild(ratingDisplay);
    overlay.appendChild(changeDisplay);
    card.appendChild(overlay);

    // Animate the rating counting
    let currentDisplay = oldRating;
    const step = isWinner ? 1 : -1;
    const totalSteps = Math.abs(change);
    let stepCount = 0;
    
    const interval = setInterval(() => {
      stepCount++;
      currentDisplay += step;
      ratingDisplay.textContent = currentDisplay;
      
      if (stepCount >= totalSteps) {
        clearInterval(interval);
        ratingDisplay.textContent = newRating;
      }
    }, 50);

    // Remove overlay after animation
    setTimeout(() => {
      overlay.remove();
    }, 1400);
  }

  // ============================================
  // MODAL & NAVIGATION
  // ============================================

  function shouldShowButton() {
    const path = window.location.pathname;
    // Show on /scenes list and individual scene pages (/scenes/12345)
    return path === '/scenes' || path === '/scenes/' || path.startsWith('/scenes/');
  }

  function addFloatingButton() {
    const buttonId = "plugin_pwr";
    
    // Remove button if we're not on the scenes page
    if (!shouldShowButton()) {
        const existing = document.getElementById(buttonId);
        if (existing) {
            existing.closest(".nav-link")?.remove();
        }
        return;
    }
    
    // Prevent duplicates
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

    // Prevent default link behavior and attach click handler
    const link = navItem.querySelector("a");
    link.addEventListener("click", (e) => {
        e.preventDefault();
        openRankingModal();
    });

    // Append to navbar
    const navTarget = document.querySelector(".navbar-nav");
    if (navTarget) {
        navTarget.appendChild(navItem);
    }
  }


  function openRankingModal() {
    console.log("[Stash Battle] 🎯 Opening modal...");
    
    // Try to load saved state
    const hasState = loadState();
    console.log(`[Stash Battle] 📋 LocalStorage state: ${hasState ? 'found' : 'none'}`);
    
    // Check if URL filter params have changed - if so, reset state
    const currentFilterParams = window.location.search;
    const filtersChanged = hasState && savedFilterParams !== currentFilterParams;
    
    if (filtersChanged) {
      console.log("[Stash Battle] Filter params changed, resetting gauntlet state and filtered cache");
      currentPair = { left: null, right: null };
      currentRanks = { left: null, right: null };
      gauntletChampion = null;
      gauntletWins = 0;
      gauntletChampionRank = 0;
      gauntletDefeated = [];
      gauntletFalling = false;
      gauntletFallingScene = null;
      savedFilterParams = currentFilterParams;
      
      // Clear filtered scenes cache (but keep all scenes cache)
      memoryCache.filteredScenes = null;
      memoryCache.filterKey = null;
      
      // Reset shuffle for new filter
      shuffledFilteredScenes = [];
      shuffleIndex = 0;
      shuffleFilterKey = null;
    }
    
    // Check for existing hidden modal - reuse it
    const existingModal = document.getElementById("pwr-modal");
    if (existingModal && existingModal.classList.contains("pwr-modal-hidden")) {
      console.log("[Stash Battle] ♻️ Reusing existing modal");
      existingModal.classList.remove("pwr-modal-hidden", "pwr-modal-closing");
      
      // Re-register keyboard handler
      if (modalKeyHandler) {
        document.removeEventListener("keydown", modalKeyHandler, true);
      }
      document.addEventListener("keydown", modalKeyHandler, true);
      
      // Focus modal content
      const modalContent = existingModal.querySelector(".pwr-modal-content");
      if (modalContent) modalContent.focus();
      
      // If filters changed or no pair, load new content
      if (filtersChanged || !currentPair.left || !currentPair.right) {
        loadNewPair();
      }
      // Otherwise the existing content is still valid
      
      return;
    }
    
    // Remove any non-hidden existing modal (shouldn't happen, but safety)
    if (existingModal) existingModal.remove();
    
    // Initialize filter params tracking
    if (!savedFilterParams) {
      savedFilterParams = currentFilterParams;
    }

    const modal = document.createElement("div");
    modal.id = "pwr-modal";
    modal.innerHTML = `
      <div class="pwr-modal-backdrop"></div>
      <div class="pwr-modal-content">
        <button class="pwr-modal-close">✕</button>
        ${createMainUI()}
      </div>
    `;

    document.body.appendChild(modal);

    // Focus the modal content so keyboard shortcuts work immediately
    const modalContent = modal.querySelector(".pwr-modal-content");
    if (modalContent) {
      modalContent.setAttribute("tabindex", "-1");
      modalContent.style.outline = "none";
      modalContent.focus();
    }

    // Mode toggle buttons
    modal.querySelectorAll(".pwr-mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const newMode = btn.dataset.mode;
        if (newMode !== currentMode) {
          currentMode = newMode;
          
          // Reset gauntlet state when switching modes
          gauntletChampion = null;
          gauntletWins = 0;
          gauntletDefeated = [];
          gauntletFalling = false;
          gauntletFallingScene = null;
          
          // Reset shuffle to start fresh with new mode
          shuffleIndex = 0;
          
          // Update button states
          modal.querySelectorAll(".pwr-mode-btn").forEach((b) => {
            b.classList.toggle("active", b.dataset.mode === currentMode);
          });
          
          // Re-show actions (skip button) in case it was hidden
          const actionsEl = document.querySelector(".pwr-actions");
          if (actionsEl) actionsEl.style.display = "";
          
          // Load new pair in new mode
          loadNewPair();
          saveState();
        }
      });
    });

    // Skip button
    const skipBtn = modal.querySelector("#pwr-skip-btn");
    if (skipBtn) {
      skipBtn.addEventListener("click", () => {
        // In gauntlet/champion mode with active run, skip is disabled
        if ((currentMode === "gauntlet" || currentMode === "champion") && gauntletChampion) {
          return;
        }
        if(disableChoice) return
        disableChoice = true;
        // Reset state on skip
        if (currentMode === "gauntlet" || currentMode === "champion") {
          gauntletChampion = null;
          gauntletWins = 0;
          gauntletDefeated = [];
          gauntletFalling = false;
          gauntletFallingScene = null;
          saveState();
        }
        loadNewPair();
      });
    }

    // Refresh cache button
    const refreshCacheBtn = modal.querySelector("#pwr-refresh-cache-btn");
    if (refreshCacheBtn) {
      refreshCacheBtn.addEventListener("click", async () => {
        if (disableChoice) return;
        
        refreshCacheBtn.disabled = true;
        refreshCacheBtn.textContent = "🔄 Refreshing...";
        
        try {
          await clearSceneCache();
          
          // Reset shuffle state since scene list is being refreshed
          shuffledFilteredScenes = [];
          shuffleIndex = 0;
          shuffleFilterKey = null;
          removedSceneIds.clear(); // Reset removed tracking for fresh data
          
          // Reset gauntlet state since rankings may have changed
          gauntletChampion = null;
          gauntletWins = 0;
          gauntletDefeated = [];
          gauntletFalling = false;
          gauntletFallingScene = null;
          saveState();
          
          // Re-show actions in case hidden
          const actionsEl = document.querySelector(".pwr-actions");
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

    // Load initial comparison or restore saved pair
    if (hasState && currentPair.left && currentPair.right && !filtersChanged) {
      console.log(`[Stash Battle] 📂 Restoring saved pair from localStorage (Scene ${currentPair.left.id} vs Scene ${currentPair.right.id})`);
      restoreCurrentPair();
    } else {
      console.log(`[Stash Battle] 🆕 No saved pair or filters changed, loading new pair...`);
      loadNewPair();
    }

    // Close handlers
    modal.querySelector(".pwr-modal-backdrop").addEventListener("click", closeRankingModal);
    modal.querySelector(".pwr-modal-close").addEventListener("click", closeRankingModal);
    
    // Remove any existing keyboard handlers before adding new ones
    if (modalKeyHandler) {
      document.removeEventListener("keydown", modalKeyHandler, true);
    }
    
    // Single keyboard handler for all modal shortcuts
    modalKeyHandler = function(e) {
      const modal = document.getElementById("pwr-modal");
      if (!modal) {
        document.removeEventListener("keydown", modalKeyHandler, true);
        modalKeyHandler = null;
        return;
      }

      // Escape to close
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeRankingModal();
        return;
      }

      // Arrow keys to choose (stop propagation to prevent Stash scene navigation)
      if (e.key === "ArrowLeft" && currentPair.left) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const leftBody = modal.querySelector('.pwr-scene-card[data-side="left"] .pwr-scene-body');
        if (leftBody) leftBody.click();
      }
      if (e.key === "ArrowRight" && currentPair.right) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const rightBody = modal.querySelector('.pwr-scene-card[data-side="right"] .pwr-scene-body');
        if (rightBody) rightBody.click();
      }
      
      // Spacebar to skip
      if (e.key === " " || e.code === "Space") {
        const activeElement = document.activeElement;
        // Skip if focused on input/textarea, or if a button is focused (let button's click handle it)
        if (activeElement.tagName === "INPUT" || activeElement.tagName === "TEXTAREA" || activeElement.tagName === "BUTTON") {
          return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        // Don't skip during active gauntlet/champion run
        if ((currentMode === "gauntlet" || currentMode === "champion") && gauntletChampion) {
          return;
        }
        if(disableChoice) return;
        disableChoice = true;
        if (currentMode === "gauntlet" || currentMode === "champion") {
          gauntletChampion = null;
          gauntletWins = 0;
          gauntletDefeated = [];
          gauntletFalling = false;
          gauntletFallingScene = null;
          saveState();
        }
        loadNewPair();
      }
    };
    
    document.addEventListener("keydown", modalKeyHandler, true);
  }

  // Track keyboard handler so we can remove it on close
  let modalKeyHandler = null;

  function closeRankingModal() {
    const modal = document.getElementById("pwr-modal");
    if (!modal || modal.classList.contains("pwr-modal-hidden")) return;
    
    // Add closing class to trigger fade-out animation
    modal.classList.add("pwr-modal-closing");
    
    // After animation completes, hide the modal (keep in DOM for reuse)
    setTimeout(() => {
      modal.classList.add("pwr-modal-hidden");
      modal.classList.remove("pwr-modal-closing");
    }, 200); // Match CSS animation duration
    
    // Clean up keyboard handler
    if (modalKeyHandler) {
      document.removeEventListener("keydown", modalKeyHandler, true);
    }
  }

  // ============================================
  // INITIALIZATION
  // ============================================

  function init() {
    console.log("[Stash Battle] Initialized");

    addFloatingButton();

    // Watch for SPA navigation
    const observer = new MutationObserver(() => {
      addFloatingButton();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();