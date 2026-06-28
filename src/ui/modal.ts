// The battle modal: opens/closes, wires controls and keyboard shortcuts.

import { clearSceneCache } from "../cache";
import { FILTER_OPPONENTS_KEY, MUTE_PREVIEWS_KEY } from "../constants";
import { getSceneIdFromUrl } from "../graphql";
import { resetGauntletState, state } from "../state";
import { loadState, saveState } from "../storage";
import type { Mode } from "../types";
import { createMainUI, loadNewPair, restoreCurrentPair, updateClimbPoolWarning } from "./mainUI";

// Track keyboard handler so we can remove it on close
let modalKeyHandler: ((e: KeyboardEvent) => void) | null = null;

export function openModal(): void {
  console.log("[Stash Battle] 🎯 Opening modal...");

  // Pause all media playing in stash when battle modal is opened to prevent audio overlap with hover previews
  document.querySelectorAll<HTMLMediaElement>("video, audio").forEach((v) => v.pause());

  // Try to load saved state
  const hasState = loadState();
  console.log(`[Stash Battle] 📋 LocalStorage state: ${hasState ? "found" : "none"}`);

  // Check if URL filter params have changed - if so, reset state
  const currentFilterParams = window.location.search;
  const filtersChanged = hasState && state.savedFilterParams !== currentFilterParams;

  if (filtersChanged) {
    console.log("[Stash Battle] Filter params changed, resetting gauntlet state and filtered cache");
    state.currentPair = { left: null, right: null };
    state.currentRanks = { left: null, right: null };
    resetGauntletState();
    state.savedFilterParams = currentFilterParams;

    // Clear filtered scenes cache (but keep all scenes cache)
    state.memoryCache.filteredScenes = null;
    state.memoryCache.filterKey = null;

    // Reset shuffle for new filter
    state.shuffledFilteredScenes = [];
    state.shuffleIndex = 0;
    state.shuffleFilterKey = null;
  }

  // Detect if opened from an individual scene page (e.g. /scenes/123)
  const scenePageId = getSceneIdFromUrl();
  const sceneAlreadyInPair =
    scenePageId &&
    state.currentPair.left &&
    state.currentPair.right &&
    (String(state.currentPair.left.id) === scenePageId ||
      String(state.currentPair.right.id) === scenePageId);
  const forceSceneBattle = scenePageId && !sceneAlreadyInPair;

  if (forceSceneBattle) {
    console.log(`[Stash Battle] 🎯 Opened from scene page ${scenePageId}, starting new battle with this scene`);
    resetGauntletState();
    state.currentPair = { left: null, right: null };
    state.currentRanks = { left: null, right: null };
  }

  // Check for existing hidden modal - reuse it
  const existingModal = document.getElementById("sb-modal");
  if (existingModal && existingModal.classList.contains("sb-modal-hidden")) {
    console.log("[Stash Battle] ♻️ Reusing existing modal");
    existingModal.classList.remove("sb-modal-hidden", "sb-modal-closing");

    // Re-register keyboard handler
    if (modalKeyHandler) {
      document.removeEventListener("keydown", modalKeyHandler, true);
    }
    if (modalKeyHandler) document.addEventListener("keydown", modalKeyHandler, true);

    // Focus modal content
    const modalContent = existingModal.querySelector<HTMLElement>(".sb-modal-content");
    if (modalContent) modalContent.focus();

    // If filters changed, no pair, or forced scene, load new content
    if (forceSceneBattle) {
      loadNewPair(scenePageId);
    } else if (filtersChanged || !state.currentPair.left || !state.currentPair.right) {
      loadNewPair();
    }
    // Otherwise the existing content is still valid

    return;
  }

  // Remove any non-hidden existing modal (shouldn't happen, but safety)
  if (existingModal) existingModal.remove();

  // Initialize filter params tracking
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

  // Focus the modal content so keyboard shortcuts work immediately
  const modalContent = modal.querySelector<HTMLElement>(".sb-modal-content");
  if (modalContent) {
    modalContent.setAttribute("tabindex", "-1");
    modalContent.style.outline = "none";
    modalContent.focus();
  }

  // Mode toggle buttons
  modal.querySelectorAll<HTMLElement>(".sb-mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const newMode = btn.dataset.mode as Mode;
      if (newMode !== state.currentMode) {
        state.currentMode = newMode;

        resetGauntletState();

        // Reset shuffle to start fresh with new mode
        state.shuffleIndex = 0;

        // Update button states
        modal.querySelectorAll<HTMLElement>(".sb-mode-btn").forEach((b) => {
          b.classList.toggle("active", b.dataset.mode === state.currentMode);
        });

        // Re-show actions (skip button) in case it was hidden
        const actionsEl = document.querySelector<HTMLElement>(".sb-actions");
        if (actionsEl) actionsEl.style.display = "";

        // Load new pair in new mode, preserving scene page context
        loadNewPair(getSceneIdFromUrl());
        updateClimbPoolWarning();
        saveState();
      }
    });
  });

  // Opponents filter checkbox
  const oppCheckbox = modal.querySelector<HTMLInputElement>("#sb-filter-opponents-checkbox");
  if (oppCheckbox) {
    oppCheckbox.addEventListener("change", (e) => {
      state.filterOpponents = (e.target as HTMLInputElement).checked;
      try {
        localStorage.setItem(FILTER_OPPONENTS_KEY, state.filterOpponents ? "1" : "0");
      } catch {
        /* ignore */
      }
      // switching the toggle counts as changing filters: reset gauntlet/champion run
      if (state.currentMode === "gauntlet" || state.currentMode === "champion") {
        resetGauntletState();
      }
      saveState();
      loadNewPair();
      updateClimbPoolWarning();
    });
  }

  // Mute hover previews checkbox
  const muteCheckbox = modal.querySelector<HTMLInputElement>("#sb-mute-previews-checkbox");
  if (muteCheckbox) {
    muteCheckbox.addEventListener("change", (e) => {
      state.mutePreviews = (e.target as HTMLInputElement).checked;
      try {
        localStorage.setItem(MUTE_PREVIEWS_KEY, state.mutePreviews ? "1" : "0");
      } catch {
        /* ignore */
      }
      // apply immediately to any preview videos currently rendered
      document.querySelectorAll<HTMLVideoElement>(".sb-hover-preview").forEach((v) => {
        v.muted = state.mutePreviews;
      });
    });
  }

  // Skip button
  const skipBtn = modal.querySelector("#sb-skip-btn");
  if (skipBtn) {
    skipBtn.addEventListener("click", () => {
      // In gauntlet/champion mode with active run, skip is disabled
      if ((state.currentMode === "gauntlet" || state.currentMode === "champion") && state.gauntletClimber) {
        return;
      }
      if (state.disableChoice) return;
      state.disableChoice = true;
      // Reset state on skip
      if (state.currentMode === "gauntlet" || state.currentMode === "champion") {
        resetGauntletState();
        saveState();
      }
      loadNewPair();
    });
  }

  // Refresh cache button
  const refreshCacheBtn = modal.querySelector<HTMLButtonElement>("#sb-refresh-cache-btn");
  if (refreshCacheBtn) {
    refreshCacheBtn.addEventListener("click", async () => {
      if (state.disableChoice) return;

      refreshCacheBtn.disabled = true;
      refreshCacheBtn.textContent = "🔄 Refreshing...";

      try {
        await clearSceneCache();

        // Reset shuffle state since scene list is being refreshed
        state.shuffledFilteredScenes = [];
        state.shuffleIndex = 0;
        state.shuffleFilterKey = null;
        state.removedSceneIds.clear(); // Reset removed tracking for fresh data

        // Reset gauntlet state since rankings may have changed
        resetGauntletState();
        saveState();

        // Re-show actions in case hidden
        const actionsEl = document.querySelector<HTMLElement>(".sb-actions");
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
  if (forceSceneBattle) {
    console.log(`[Stash Battle] 🎯 Starting battle with scene ${scenePageId} from scene page`);
    loadNewPair(scenePageId);
  } else if (hasState && state.currentPair.left && state.currentPair.right && !filtersChanged) {
    console.log(
      `[Stash Battle] 📂 Restoring saved pair from localStorage (Scene ${state.currentPair.left.id} vs Scene ${state.currentPair.right.id})`,
    );
    restoreCurrentPair();
  } else {
    console.log("[Stash Battle] 🆕 No saved pair or filters changed, loading new pair...");
    loadNewPair();
  }

  // Close handlers
  modal.querySelector(".sb-modal-backdrop")?.addEventListener("click", closeModal);
  modal.querySelector(".sb-modal-close")?.addEventListener("click", closeModal);

  // Remove any existing keyboard handlers before adding new ones
  if (modalKeyHandler) {
    document.removeEventListener("keydown", modalKeyHandler, true);
  }

  // Single keyboard handler for all modal shortcuts
  modalKeyHandler = function (e: KeyboardEvent) {
    const activeModal = document.getElementById("sb-modal");
    if (!activeModal) {
      if (modalKeyHandler) document.removeEventListener("keydown", modalKeyHandler, true);
      modalKeyHandler = null;
      return;
    }

    // Escape to close
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      closeModal();
      return;
    }

    // Arrow keys to choose (stop propagation to prevent Stash scene navigation)
    if (e.key === "ArrowLeft" && state.currentPair.left) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const leftBody = activeModal.querySelector<HTMLElement>('.sb-scene-card[data-side="left"] .sb-scene-body');
      if (leftBody) leftBody.click();
    }
    if (e.key === "ArrowRight" && state.currentPair.right) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const rightBody = activeModal.querySelector<HTMLElement>('.sb-scene-card[data-side="right"] .sb-scene-body');
      if (rightBody) rightBody.click();
    }

    // Spacebar to skip
    if (e.key === " " || e.code === "Space") {
      const tag = document.activeElement?.tagName;
      // Skip if focused on input/textarea, or if a button is focused (let button's click handle it)
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON") {
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      // Don't skip during active gauntlet/champion run
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

export function closeModal(): void {
  const modal = document.getElementById("sb-modal");
  if (!modal || modal.classList.contains("sb-modal-hidden")) return;

  // Add closing class to trigger fade-out animation
  modal.classList.add("sb-modal-closing");

  // After animation completes, hide the modal (keep in DOM for reuse)
  setTimeout(() => {
    modal.classList.add("sb-modal-hidden");
    modal.classList.remove("sb-modal-closing");
  }, 200); // Match CSS animation duration

  // Clean up keyboard handler
  if (modalKeyHandler) {
    document.removeEventListener("keydown", modalKeyHandler, true);
  }
}
