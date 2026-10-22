// Stash Battle - entry point.
// Bundled by esbuild into plugins/stash-battle/stash-battle.js (IIFE).

import { registerDeleteDialogBridge } from "./ui/deleteDialog";
import { injectNavButton } from "./ui/navButton";

function init(): void {
    console.log("[Stash Battle] Initialized");

  registerDeleteDialogBridge();

  injectNavButton();

  // Re-inject nav button after Stash SPA navigation rebuilds the navbar
    const observer = new MutationObserver(() => {
    injectNavButton();
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
