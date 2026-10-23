// Stash Battle - entry point.
// Bundled by esbuild into plugins/stash-battle/stash-battle.js (IIFE).

import { registerDeleteDialogBridge } from "./ui/deleteDialog";
import { registerNavButton } from "./ui/navButton";

function init(): void {
  console.log("[Stash Battle] Initialized");

  registerDeleteDialogBridge();
  registerNavButton();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
