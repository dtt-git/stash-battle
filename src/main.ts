// Stash Battle - entry point.
// Bundled by esbuild into plugins/stash-battle/stash-battle.js (IIFE).

import { registerDeleteDialogBridge } from "./ui/deleteDialog";
import { openModal } from "./ui/modal";
import { registerNavButton } from "./ui/navButton";
import { registerSceneElo } from "./ui/sceneElo";

function init(): void {
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
