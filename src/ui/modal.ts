// The battle modal: opens/closes, wires controls and keyboard shortcuts.

import { clearSceneCache } from "../cache";
import { fetchSetupScenes } from "../eloSetup";
import { getSceneIdFromUrl, holdStashListRefresh, sceneCustomFieldsSupported } from "../graphql";
import { applyStashRatings, queueRatingWrite, SCENE_MISSING_EVENT, scheduleStashRatingSync, writeStashRatings } from "../rating";
import { stashRatingChanges } from "../score";
import { loadSettings } from "../settings";
import { isEloSetupPending, resetRunState, resetShuffle, state } from "../state";
import { loadState, saveState } from "../storage";
import type { Mode, Settings, StashRatingsMode } from "../types";
import { cancelConfirmDialog, confirmDialog, isConfirmDialogOpen } from "./confirmDialog";
import { cancelDeleteDialog, isDeleteDialogOpen } from "./deleteDialog";
import {
  applyPreviewSettings,
  createMainUI,
  handleSceneGone,
  loadNewPair,
  renderPair,
  restoreCurrentPair,
  skipPair,
  updateClimbPoolWarning,
  updateModeInfo,
  updateRatingsNote,
  verifyCurrentPair,
} from "./mainUI";
import { bindSettingsControls, getActiveTab, showTab, syncSettingsControls } from "./settingsPanel";
import { hideSetupScreen, isSetupRunning, showSetupScreen } from "./setupScreen";
import { stashRatingsOption } from "./stashRatingsText";

// Track keyboard handler so we can remove it on close
let modalKeyHandler: ((e: KeyboardEvent) => void) | null = null;
let sceneMissingListenerAdded = false;

/** On <body> while Battle is open; CSS uses it to lift Stash's own modals above ours. */
const BATTLE_OPEN_CLASS = "sb-battle-open";

/** Re-render the pair on screen so card markup picks up a changed setting. */
function rerenderCurrentPair(): void {
  const { left, right } = state.currentPair;
  if (!left || !right || state.disableChoice || !document.querySelector("#sb-comparison-area .sb-vs-container")) {
    return;
  }
  renderPair([left, right], [state.currentRanks.left, state.currentRanks.right]);
}

/**
 * Before the "Stash ratings" dropdown changes: switching to Percentile or Straight-line warns how
 * many Stash ratings change and syncs them all on confirm (false puts the dropdown back).
 * Switching to Don't update, or a switch that changes nothing, needs no warning.
 */
async function confirmSettingChange(key: keyof Settings, value: string): Promise<boolean> {
  if (key !== "stashRatings") return true;
  const next = value as StashRatingsMode;
  if (next === "off" || next === state.settings.stashRatings) return true;

  let changes: Map<string, number>;
  try {
    changes = stashRatingChanges(await fetchSetupScenes(), next);
  } catch (e) {
    console.error("[Stash Battle] Couldn't load scenes to switch Stash ratings:", e);
    await confirmDialog({
      title: "Couldn't load your scenes",
      body: "<p>Stash Battle needs your whole library to work out the new Stash ratings. Nothing was changed; try again.</p>",
      confirmLabel: "OK",
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
    action: () =>
      queueRatingWrite(async () => {
        await writeStashRatings(changes);
        applyStashRatings(changes);
      }),
  });
}

/** Settings → Reset ELO: confirm, then show the setup choices again (Cancel goes back). */
async function startResetElo(modal: HTMLElement): Promise<void> {
  const ratingsOn = state.settings.stashRatings !== "off";
  const ok = await confirmDialog({
    title: "Reset ELO?",
    body: `
        <p>Every scene's ELO and battle count will be overwritten. Next you choose how ELO starts
        again: from your Stash ratings, or 1500 for everyone.${ratingsOn ? " Stash ratings are then updated from the new ELO." : ""}</p>
        <p>Nothing changes until you press Start on the next screen.</p>`,
    confirmLabel: "Continue",
  });
  if (!ok) return;

  state.resettingElo = true;
  showTab(modal, "battle");
  modal.querySelectorAll<HTMLVideoElement>(".sb-hover-preview").forEach((v) => v.pause());
  showSetupScreen(modal, () => afterSetup(modal), {
    reset: true,
    onCancel: () => {
      state.resettingElo = false;
      hideSetupScreen(modal);
      if (state.currentPair.left && state.currentPair.right) void restoreCurrentPair();
      else void loadNewPair();
    },
  });
}

/** Setup (first time or Reset ELO) finished: settings it saved show, then battles start. */
function afterSetup(modal: HTMLElement): void {
  state.resettingElo = false;
  syncSettingsControls(modal);
  updateRatingsNote();
  void loadNewPair(getSceneIdFromUrl());
}

function onSettingChanged(key: keyof Settings): void {
  switch (key) {
    case "stashRatings":
      updateRatingsNote();
      // Catch anything a per-battle sync under the old mode changed after the switch was counted
      scheduleStashRatingSync();
      break;
    case "filterOpponents":
      // switching the toggle counts as changing filters: reset any run
      if (state.currentMode !== "swiss") resetRunState();
      saveState();
      loadNewPair();
      updateClimbPoolWarning();
      break;
    case "placementFromBottom": {
      // Restart the scene's run from the new start point (nothing is written until it lands)
      const sceneId = state.currentMode === "placement" ? state.placement?.scene.id : undefined;
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

export async function openModal(): Promise<void> {
  console.log("[Stash Battle] 🎯 Opening modal...");

  const [settingsOk, customFieldsOk] = await Promise.all([loadSettings(), sceneCustomFieldsSupported()]);
  if (!customFieldsOk) {
    showMessageModal(
      "Stash Battle needs a newer version of Stash: it stores each scene's ELO in scene custom fields, which this Stash doesn't have. Update Stash to use Stash Battle.",
    );
    return;
  }
  // Without settings, Battle can't tell whether the one-time ELO setup already ran (and running
  // it again would overwrite every scene's ELO)
  if (!settingsOk && isEloSetupPending()) {
    showMessageModal("Stash Battle couldn't load its settings from Stash. Close Stash Battle and try again.");
    return;
  }
  addKeySwallowers();
  holdStashListRefresh(true);

  // Optionally pause whatever Stash is playing so it doesn't overlap the battle previews
  if (state.settings.pauseMediaOnOpen) {
    document.querySelectorAll<HTMLMediaElement>("video, audio").forEach((v) => v.pause());
  }

  if (!sceneMissingListenerAdded) {
    sceneMissingListenerAdded = true;
    window.addEventListener(SCENE_MISSING_EVENT, (e) => {
      void handleSceneGone((e as CustomEvent<string>).detail);
    });
  }

  // Try to load saved state
  const hasState = loadState();
  console.log(`[Stash Battle] 📋 LocalStorage state: ${hasState ? "found" : "none"}`);

  // Check if URL filter params have changed - if so, reset state
  const currentFilterParams = window.location.search;
  const filtersChanged = hasState && state.savedFilterParams !== currentFilterParams;

  if (filtersChanged) {
    console.log("[Stash Battle] Filter params changed, resetting run state and filtered cache");
    state.currentPair = { left: null, right: null };
    state.currentRanks = { left: null, right: null };
    resetRunState();
    state.savedFilterParams = currentFilterParams;

    // Clear filtered scenes cache (but keep all scenes cache)
    state.memoryCache.filteredScenes = null;
    state.memoryCache.filterKey = null;

    // Reset shuffle for new filter
    resetShuffle();
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
    resetRunState();
    state.currentPair = { left: null, right: null };
    state.currentRanks = { left: null, right: null };
  }

  // Check for existing hidden modal - reuse it (unless it's a message modal, see showMessageModal)
  const existingModal = document.getElementById("sb-modal");
  if (
    existingModal &&
    existingModal.classList.contains("sb-modal-hidden") &&
    existingModal.querySelector("#stash-battle-container")
  ) {
    console.log("[Stash Battle] ♻️ Reusing existing modal");
    existingModal.classList.remove("sb-modal-hidden", "sb-modal-closing");
    document.body.classList.add(BATTLE_OPEN_CLASS);

    // Always reopen on the Battle tab; settings may have changed elsewhere meanwhile
    showTab(existingModal, "battle");
    syncSettingsControls(existingModal);
    updateRatingsNote();

    // Re-register keyboard handler
    if (modalKeyHandler) {
      document.removeEventListener("keydown", modalKeyHandler, true);
      document.addEventListener("keydown", modalKeyHandler, true);
    }

    // Focus modal content
    const modalContent = existingModal.querySelector<HTMLElement>(".sb-modal-content");
    if (modalContent) modalContent.focus();

    // The one-time ELO setup shows in place of the battle until it's done
    if (isEloSetupPending()) {
      showSetupScreen(existingModal, () => afterSetup(existingModal));
      return;
    }
    hideSetupScreen(existingModal);

    // If filters changed, no pair, or forced scene, load new content
    if (forceSceneBattle) {
      loadNewPair(scenePageId);
    } else if (filtersChanged || !state.currentPair.left || !state.currentPair.right) {
      loadNewPair();
    } else if (document.querySelector("#sb-comparison-area .sb-vs-container")) {
      // Existing pair is still valid unless a scene was deleted elsewhere meanwhile
      applyPreviewSettings();
      void verifyCurrentPair();
    }

    return;
  }

  // Remove any other existing modal (a message modal, or a visible one, which shouldn't happen)
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
        <button class="sb-modal-close" aria-label="Close">✕</button>
        ${createMainUI()}
      </div>
    `;

  document.body.appendChild(modal);
  document.body.classList.add(BATTLE_OPEN_CLASS);

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

        resetRunState();

        // Reset shuffle to start fresh with new mode
        state.shuffleIndex = 0;

        // Update button states
        modal.querySelectorAll<HTMLElement>(".sb-mode-btn").forEach((b) => {
          b.classList.toggle("active", b.dataset.mode === state.currentMode);
        });
        updateModeInfo();

        // Load new pair in new mode, preserving scene page context
        loadNewPair(getSceneIdFromUrl());
        updateClimbPoolWarning();
        saveState();
      }
    });
  });

  // Touch-only ⓘ: show/hide the current mode's explanation
  const modeInfoBtn = modal.querySelector<HTMLButtonElement>(".sb-mode-info-btn");
  const modeInfo = modal.querySelector<HTMLElement>("#sb-mode-info");
  modeInfoBtn?.addEventListener("click", () => {
    if (!modeInfo) return;
    updateModeInfo();
    modeInfo.hidden = !modeInfo.hidden;
    modeInfoBtn.setAttribute("aria-expanded", String(!modeInfo.hidden));
  });

  // Battle / Settings tabs, settings controls, volume
  showTab(modal, "battle");
  bindSettingsControls(modal, onSettingChanged, () => applyPreviewSettings(), confirmSettingChange);
  updateRatingsNote();

  modal.querySelector('[data-action="reset-elo"]')?.addEventListener("click", () => void startResetElo(modal));
  // Battle tab note's "change in Settings" link
  modal.querySelector('[data-action="open-settings"]')?.addEventListener("click", (e) => {
    e.preventDefault();
    showTab(modal, "settings");
    applyPreviewSettings();
  });

  // Skip button
  modal.querySelector("#sb-skip-btn")?.addEventListener("click", skipPair);

  // Refresh cache button
  const refreshCacheBtn = modal.querySelector<HTMLButtonElement>("#sb-refresh-cache-btn");
  if (refreshCacheBtn) {
    refreshCacheBtn.addEventListener("click", async () => {
      if (state.disableChoice) return;

      const label = refreshCacheBtn.textContent;
      refreshCacheBtn.disabled = true;
      refreshCacheBtn.textContent = "🔄 Refreshing...";

      try {
        await clearSceneCache();

        // Reset shuffle state since scene list is being refreshed
        resetShuffle();

        // Reset run state since rankings may have changed
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

  // Load initial comparison or restore saved pair, after the one-time ELO setup if it's pending
  if (isEloSetupPending()) {
    console.log("[Stash Battle] 🧭 ELO setup not done yet, showing setup");
    showSetupScreen(modal, () => afterSetup(modal));
  } else if (forceSceneBattle) {
    console.log(`[Stash Battle] 🎯 Starting battle with scene ${scenePageId} from scene page`);
    loadNewPair(scenePageId);
  } else if (hasState && state.currentPair.left && state.currentPair.right && !filtersChanged) {
    console.log(
      `[Stash Battle] 📂 Restoring saved pair from localStorage (Scene ${state.currentPair.left.id} vs Scene ${state.currentPair.right.id})`,
    );
    void restoreCurrentPair();
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

    // Stash's own delete dialog (Clean mode) is on top: let it have the keys (Escape, Enter)
    if (isDeleteDialogOpen()) return;

    // Nothing typed while Battle is open may reach Stash's own hotkeys (page arrows, letter
    // shortcuts), or it acts on the page behind the modal. Default actions (typing in inputs,
    // slider arrows, checkbox Space) still happen since only propagation is stopped here.
    e.stopImmediatePropagation();

    // A confirmation dialog is open: Escape cancels it, other keys are its own (Tab, Enter)
    if (isConfirmDialogOpen()) {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelConfirmDialog();
      }
      return;
    }

    // Escape to close
    if (e.key === "Escape") {
      e.preventDefault();
      closeModal();
      return;
    }

    // Battle shortcuts only apply on the Battle tab, once ELO setup is done
    if (getActiveTab() !== "battle" || isEloSetupPending()) return;

    // Let the volume slider / number input keep their own arrow keys (checkboxes don't need them)
    const active = document.activeElement as HTMLInputElement | null;
    const tag = active?.tagName;
    const isToggle = tag === "INPUT" && (active?.type === "checkbox" || active?.type === "radio");
    if ((tag === "INPUT" && !isToggle) || tag === "TEXTAREA" || tag === "SELECT") return;

    // Arrow keys to choose
    if (e.key === "ArrowLeft" && state.currentPair.left) {
      e.preventDefault();
      const leftBody = activeModal.querySelector<HTMLElement>('.sb-scene-card[data-side="left"] .sb-scene-body');
      if (leftBody) leftBody.click();
    }
    if (e.key === "ArrowRight" && state.currentPair.right) {
      e.preventDefault();
      const rightBody = activeModal.querySelector<HTMLElement>('.sb-scene-card[data-side="right"] .sb-scene-body');
      if (rightBody) rightBody.click();
    }

    // Spacebar to skip
    if (e.key === " " || e.code === "Space") {
      // Let a focused button or checkbox handle its own Space
      if (tag === "BUTTON" || isToggle) return;
      e.preventDefault();
      skipPair();
    }
  };

  document.addEventListener("keydown", modalKeyHandler, true);
}

/** A modal with just a message, shown instead of Battle (e.g. this Stash lacks custom fields). */
function showMessageModal(message: string): void {
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

/** True while the battle modal is on screen (it stays in the DOM, hidden, after closing). */
function isModalVisible(): boolean {
  const modal = document.getElementById("sb-modal");
  return modal !== null && !modal.classList.contains("sb-modal-hidden");
}

// Stash's hotkeys (Mousetrap) also listen for keypress/keyup on document; keydown is handled
// by modalKeyHandler. Registered once, in the capture phase, and inert while the modal is hidden.
let keySwallowersAdded = false;
function addKeySwallowers(): void {
  if (keySwallowersAdded) return;
  keySwallowersAdded = true;
  const swallow = (e: KeyboardEvent): void => {
    if (isModalVisible() && !isDeleteDialogOpen()) e.stopImmediatePropagation();
  };
  document.addEventListener("keypress", swallow, true);
  document.addEventListener("keyup", swallow, true);
}

export function closeModal(): void {
  const modal = document.getElementById("sb-modal");
  if (!modal || modal.classList.contains("sb-modal-hidden")) return;

  cancelDeleteDialog();
  cancelConfirmDialog();
  // Stash's scene lists show the ratings written while Stash Battle was open
  holdStashListRefresh(false);
  // Closing Stash Battle on Reset ELO's choices (before Start) cancels the reset
  if (state.resettingElo && !isSetupRunning()) {
    state.resettingElo = false;
    hideSetupScreen(modal);
  }

  // Stop previews (autoplay keeps them running otherwise)
  modal.querySelectorAll<HTMLVideoElement>(".sb-hover-preview").forEach((v) => v.pause());

  // Add closing class to trigger fade-out animation
  modal.classList.add("sb-modal-closing");

  // After animation completes, hide the modal (keep in DOM for reuse)
  setTimeout(() => {
    modal.classList.add("sb-modal-hidden");
    document.body.classList.remove(BATTLE_OPEN_CLASS);
    modal.classList.remove("sb-modal-closing");
  }, 200); // Match CSS animation duration

  // Clean up keyboard handler
  if (modalKeyHandler) {
    document.removeEventListener("keydown", modalKeyHandler, true);
  }
}

