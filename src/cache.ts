// Scene cache: IndexedDB (durable) + in-memory (per session), stale-while-revalidate.

import {
  CACHE_DB_NAME,
  CACHE_DB_VERSION,
  CACHE_MAX_AGE_MS,
  CACHE_STORE_NAME,
} from "./constants";
import { getFindFilter, type ListFilters } from "./filters";
import { FIND_SCENES_QUERY, graphqlQuery } from "./graphql";
import { state } from "./state";
import type { CacheEntry, FindScenesResult, Scene } from "./types";

// Open IndexedDB database
function openCacheDB(): Promise<IDBDatabase> {
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
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(CACHE_STORE_NAME)) {
        db.createObjectStore(CACHE_STORE_NAME, { keyPath: "cacheKey" });
      }
    };
  });
}

// Get cached scenes from IndexedDB
async function getCachedScenes(cacheKey: string): Promise<CacheEntry | null> {
  try {
    const db = await openCacheDB();
    return new Promise<CacheEntry | null>((resolve, reject) => {
      const transaction = db.transaction(CACHE_STORE_NAME, "readonly");
      const store = transaction.objectStore(CACHE_STORE_NAME);
      const request = store.get(cacheKey);

      request.onsuccess = () => {
        const result = request.result as CacheEntry | undefined;
        if (result && Date.now() - result.timestamp < CACHE_MAX_AGE_MS) {
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
async function setCachedScenes(
  cacheKey: string,
  scenes: Scene[],
  count: number,
  filterKey?: string,
): Promise<void> {
  try {
    const db = await openCacheDB();
    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(CACHE_STORE_NAME, "readwrite");
      const store = transaction.objectStore(CACHE_STORE_NAME);

      const data: CacheEntry = {
        cacheKey,
        scenes,
        count,
        timestamp: Date.now(),
        ...(filterKey !== undefined && { filterKey }),
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
export async function clearSceneCache(): Promise<void> {
  try {
    console.log("[Stash Battle] 🗑️ Clearing all scene caches...");
    const db = await openCacheDB();
    return new Promise<void>((resolve, reject) => {
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

// Clear just the filtered scenes cache (for auto-refresh after pool exhaustion)
export async function clearFilteredCache(): Promise<void> {
  try {
    const db = await openCacheDB();
    return new Promise<void>((resolve, reject) => {
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
    // Still clear memory cache even if IndexedDB fails
    state.memoryCache.filteredScenes = null;
    state.memoryCache.filterKey = null;
  }
}

// Background refresh - fetch from network and update caches silently
async function backgroundRefreshAllScenes(): Promise<void> {
  const cacheKey = "all-scenes";

  try {
    console.log("[Stash Battle] 🔄 Background refresh started (all scenes)...");
    const startTime = Date.now();

    const result = await graphqlQuery<FindScenesResult>(FIND_SCENES_QUERY, {
      filter: {
        per_page: -1,
        sort: "rating",
        direction: "DESC",
      },
      scene_filter: null,
    });

    const scenes = result.findScenes.scenes || [];
    const count = result.findScenes.count || scenes.length;
    const fetchTime = Date.now() - startTime;

    const oldCount = state.memoryCache.allScenes ? state.memoryCache.allScenes.length : 0;
    if (count !== oldCount) {
      console.log(
        `[Stash Battle] 📊 Scene count changed: ${oldCount} → ${count} (${count > oldCount ? "+" : ""}${count - oldCount})`,
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

// Get all scenes (uses cache with stale-while-revalidate)
export async function getAllScenesCached(): Promise<{ scenes: Scene[]; count: number }> {
  const cacheKey = "all-scenes";

  // Check memory cache first - return immediately if available
  if (state.memoryCache.allScenes) {
    const cacheAge = Math.round((Date.now() - (state.memoryCache.timestamp ?? 0)) / 1000);
    const isStale = Date.now() - (state.memoryCache.timestamp ?? 0) >= CACHE_MAX_AGE_MS;

    console.log(
      `[Stash Battle] 💾 Memory cache hit (all scenes): ${state.memoryCache.allScenes.length} scenes, age: ${cacheAge}s${isStale ? " [STALE]" : ""}`,
    );

    if (isStale) {
      console.log(`[Stash Battle] ⏰ Cache stale (>${CACHE_MAX_AGE_MS / 1000}s), triggering background refresh...`);
      backgroundRefreshAllScenes(); // Don't await - runs in background
    }
    return { scenes: state.memoryCache.allScenes, count: state.memoryCache.allScenes.length };
  }

  // Check IndexedDB cache - return immediately if available
  console.log("[Stash Battle] 🔍 Memory cache miss, checking IndexedDB...");
  const cached = await getCachedScenes(cacheKey);
  if (cached) {
    const cacheAge = Math.round((Date.now() - cached.timestamp) / 1000);
    const isStale = Date.now() - cached.timestamp >= CACHE_MAX_AGE_MS;

    console.log(
      `[Stash Battle] 💿 IndexedDB cache hit (all scenes): ${cached.scenes.length} scenes, age: ${cacheAge}s${isStale ? " [STALE]" : ""}`,
    );

    state.memoryCache.allScenes = cached.scenes;
    state.memoryCache.timestamp = cached.timestamp;

    if (isStale) {
      console.log(`[Stash Battle] ⏰ Cache stale (>${CACHE_MAX_AGE_MS / 1000}s), triggering background refresh...`);
      backgroundRefreshAllScenes(); // Don't await - runs in background
    }
    return { scenes: cached.scenes, count: cached.count };
  }

  // No cache at all - must fetch from network (blocking)
  console.log("[Stash Battle] 🌐 No cache found, fetching all scenes from network (first load)...");
  const startTime = Date.now();

  const result = await graphqlQuery<FindScenesResult>(FIND_SCENES_QUERY, {
    filter: {
      per_page: -1,
      sort: "rating",
      direction: "DESC",
    },
    scene_filter: null,
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

// Background refresh for filtered scenes
async function backgroundRefreshFilteredScenes(filters: ListFilters): Promise<void> {
  const cacheKey = "filtered-scenes";

  try {
    console.log("[Stash Battle] 🔄 Background refresh started (filtered scenes)...");
    const startTime = Date.now();

    const result = await graphqlQuery<FindScenesResult>(FIND_SCENES_QUERY, {
      filter: getFindFilter({
        per_page: -1,
        sort: "rating",
        direction: "DESC",
      }),
      scene_filter: filters.sceneFilter,
    });

    const scenes = result.findScenes.scenes || [];
    const count = result.findScenes.count || scenes.length;
    const fetchTime = Date.now() - startTime;

    // Only update if still on same filter
    if (state.memoryCache.filterKey === filters.filterKey) {
      const oldCount = state.memoryCache.filteredScenes ? state.memoryCache.filteredScenes.length : 0;
      if (count !== oldCount) {
        console.log(
          `[Stash Battle] 📊 Filtered count changed: ${oldCount} → ${count} (${count > oldCount ? "+" : ""}${count - oldCount})`,
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

// Get filtered scenes (uses cache with stale-while-revalidate)
// NOTE: Only ONE filtered cache is kept (overwrites previous filter cache to prevent IndexedDB bloat)
export async function getFilteredScenesCached(
  filters: ListFilters,
): Promise<{ scenes: Scene[]; count: number }> {
  const { filterKey, sceneFilter } = filters;
  const cacheKey = "filtered-scenes"; // Single key - overwrites previous filter cache

  console.log("[Stash Battle] 🔎 Filter active, checking filtered cache...");

  // Check memory cache first - return immediately if available and same filter
  if (state.memoryCache.filteredScenes && state.memoryCache.filterKey === filterKey) {
    const cacheAge = Math.round((Date.now() - (state.memoryCache.timestamp ?? 0)) / 1000);
    const isStale = Date.now() - (state.memoryCache.timestamp ?? 0) >= CACHE_MAX_AGE_MS;

    console.log(
      `[Stash Battle] 💾 Memory cache hit (filtered): ${state.memoryCache.filteredScenes.length} scenes, age: ${cacheAge}s${isStale ? " [STALE]" : ""}`,
    );

    if (isStale) {
      console.log(`[Stash Battle] ⏰ Cache stale (>${CACHE_MAX_AGE_MS / 1000}s), triggering background refresh...`);
      backgroundRefreshFilteredScenes(filters);
    }
    return { scenes: state.memoryCache.filteredScenes, count: state.memoryCache.filteredScenes.length };
  }

  // Check IndexedDB cache (only if filter key matches)
  console.log("[Stash Battle] 🔍 Memory cache miss (filtered), checking IndexedDB...");
  const cached = await getCachedScenes(cacheKey);
  if (cached && cached.filterKey === filterKey) {
    const cacheAge = Math.round((Date.now() - cached.timestamp) / 1000);
    const isStale = Date.now() - cached.timestamp >= CACHE_MAX_AGE_MS;

    console.log(
      `[Stash Battle] 💿 IndexedDB cache hit (filtered): ${cached.scenes.length} scenes, age: ${cacheAge}s${isStale ? " [STALE]" : ""}`,
    );

    state.memoryCache.filteredScenes = cached.scenes;
    state.memoryCache.filterKey = filterKey;
    state.memoryCache.timestamp = cached.timestamp;

    if (isStale) {
      console.log(`[Stash Battle] ⏰ Cache stale (>${CACHE_MAX_AGE_MS / 1000}s), triggering background refresh...`);
      backgroundRefreshFilteredScenes(filters);
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

  const result = await graphqlQuery<FindScenesResult>(FIND_SCENES_QUERY, {
    filter: getFindFilter({
      per_page: -1,
      sort: "rating",
      direction: "DESC",
    }),
    scene_filter: sceneFilter,
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

// Update a scene's rating and reposition it in the sorted array to keep ranks accurate
function repositionSceneInArray(arr: Scene[], sceneId: string, newRating: number): boolean {
  const idx = arr.findIndex((s) => s.id === sceneId);
  if (idx === -1) return false;

  const scene = arr[idx];
  scene.rating100 = newRating;

  // Remove from current position
  arr.splice(idx, 1);

  // Find correct position (array is sorted by rating DESC)
  const newIdx = arr.findIndex((s) => (s.rating100 || 0) < newRating);

  if (newIdx === -1) {
    arr.push(scene); // Lowest rated, goes at end
  } else {
    arr.splice(newIdx, 0, scene);
  }

  return true;
}

// Clear a scene's rating in the memory cache and move it to the bottom of the sorted pool
export function clearSceneInCache(sceneId: string): void {
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

// Update a scene's rating in the memory cache (keeps cache in sync after rating changes)
export function updateSceneInCache(sceneId: string, newRating: number): void {
  // Reposition in allScenes (keeps rankings accurate, scene stays for opponent pool)
  if (state.memoryCache.allScenes) {
    repositionSceneInArray(state.memoryCache.allScenes, sceneId, newRating);
    console.log(`[Stash Battle] 📝 Updated scene ${sceneId} rating to ${newRating} in memory cache`);
  }

  // Also update rating in filteredScenes if present (removal from the left-side pool is separate)
  if (state.memoryCache.filteredScenes) {
    const scene = state.memoryCache.filteredScenes.find((s) => s.id === sceneId);
    if (scene) {
      scene.rating100 = newRating;
    }
  }
}

// Remove a scene from the filtered pool (called after battle regardless of rating change)
export function removeFromFilteredPool(sceneId: string): void {
  // Track removal - survives background refresh race condition
  state.removedSceneIds.add(sceneId);

  if (state.memoryCache.filteredScenes) {
    const idx = state.memoryCache.filteredScenes.findIndex((s) => s.id === sceneId);
    if (idx !== -1) {
      state.memoryCache.filteredScenes.splice(idx, 1);
      console.log(
        `[Stash Battle] 🗑️ Removed scene ${sceneId} from filtered pool (${state.memoryCache.filteredScenes.length} remaining, ${state.removedSceneIds.size} removed this session)`,
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
