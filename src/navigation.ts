// SPA navigation helpers.

import { closeModal } from "./ui/modal";

// Navigate using React Router (preserves JS state)
export function navigateToUrl(url: string): void {
  closeModal();

  // Use History API + popstate event to trigger React Router navigation
  const path = url.startsWith("/") ? url : new URL(url).pathname + new URL(url).search;
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
}
