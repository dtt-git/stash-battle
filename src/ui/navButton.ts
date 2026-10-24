// The navbar "Battle" button that opens the comparison modal.
//
// Where Stash has the plugin patch API, the button is patched into MainNavBar.MenuItems (after
// Stash's own page links), so React renders it with the rest of the navbar. Otherwise it's added
// to the DOM directly and re-added whenever the page changes.
//
// While Stash folds its links into the ☰ menu (below 1200px: phones and tablets), a swords icon
// also sits in the top bar's buttons, next to SFW Switch and TCode, so Stash Battle is one tap
// away. (Stash's own MainNavBar.UtilityItems slot is hidden there, so it's added to the DOM, as
// those plugins do.)

import type { PluginApiLike, ReactNode } from "../pluginApi";
import { SWORDS_PATHS } from "./icons";
import { openModal } from "./modal";

const BUTTON_ID = "plugin_sb";
const ICON_ID = "plugin_sb_icon";
const NAV_ITEM_CLASS = "col-4 col-sm-3 col-md-2 col-lg-auto nav-link";
const LINK_CLASS =
  "minimal p-4 p-xl-2 d-flex d-xl-inline-block flex-column justify-content-between align-items-center btn btn-primary";
const LINK_HTML = `
            <svg aria-hidden="true" focusable="false" class="svg-inline--fa fa-icon nav-menu-icon d-block d-xl-inline mb-2 mb-xl-0" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36">${SWORDS_PATHS}</svg>
            <span>Battle</span>
        `;

export function shouldShowNavButton(): boolean {
  const path = window.location.pathname;
  return (
    path === "/" ||
    path === "/scenes" ||
    path === "/scenes/" ||
    path.startsWith("/scenes/")
  );
}

function onButtonClick(e: { preventDefault(): void }): void {
  e.preventDefault();
  void openModal();
}

/**
 * The top-bar icon (see the top of this file): added to the navbar's buttons after TCode's or SFW
 * Switch's when they're there, removed where the Battle link doesn't apply. Safe to call often.
 */
function placeNavIcon(): void {
  const existing = document.getElementById(ICON_ID);
  const buttons = document.querySelector(".navbar-buttons");
  if (!shouldShowNavButton() || !buttons) {
    existing?.remove();
    return;
  }
  if (existing && buttons.contains(existing)) {
    fitNavIcon(existing);
    return;
  }
  const item = existing ?? document.createElement("a");
  item.id = ICON_ID;
  item.className = "mr-2 sb-nav-icon";
  item.innerHTML = `
        <button type="button" class="minimal d-flex align-items-center h-100 btn btn-primary" title="Stash Battle" aria-label="Stash Battle">
          <svg aria-hidden="true" focusable="false" class="svg-inline--fa fa-icon" viewBox="0 0 36 36">${SWORDS_PATHS}</svg>
        </button>`;
  item.querySelector("button")?.addEventListener("click", onButtonClick);
  const after = buttons.querySelector("#tcode-nav-btn") ?? buttons.querySelector("#plugin_sfw")?.closest(".navbar-buttons > *");
  if (after) after.after(item);
  else buttons.prepend(item);
  fitNavIcon(item);
}

/**
 * Hide the icon when it would wrap Stash's bar onto a second row (narrow phones, or wide buttons
 * from other plugins); Battle is still in the ☰ menu then. Checked again whenever the bar changes
 * or the window resizes.
 */
function fitNavIcon(item: HTMLElement): void {
  item.style.removeProperty("display");
  if (getComputedStyle(item).display === "none") return; // a wide screen: the menu link shows
  const brand = document.querySelector(".navbar-brand");
  if (!brand) return;
  const wrapped = item.getBoundingClientRect().top >= brand.getBoundingClientRect().bottom - 1;
  if (wrapped) item.style.display = "none";
}

/** Keep the top-bar icon in place as Stash navigates and redraws the navbar. */
function registerNavIcon(): void {
  let queued = false;
  // Batched with a timer, not an animation frame: frames don't run in a background tab
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      placeNavIcon();
    }, 50);
  }).observe(document.body, { childList: true, subtree: true });
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener("resize", () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(placeNavIcon, 100);
  });
  placeNavIcon();
}

/** Add the Battle nav item to Stash's navbar, shown only on the routes where it applies. Call once at startup. */
export function registerNavButton(): void {
  registerNavIcon();
  const api = window.PluginApi;
  if (api?.components?.["MainNavBar.MenuItems"] && typeof api.patch?.before === "function") {
    patchNavButton(api);
    return;
  }

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

function patchNavButton(api: PluginApiLike): void {
  const { React } = api;
  const events = api.Event;

  function BattleNavItem(): ReactNode {
    // The route is read on every render; the state only makes Stash's navigation events re-render
    const [, setPath] = React.useState(window.location.pathname);

    React.useEffect(() => {
      if (!events) return;
      const update = (): void => setPath(window.location.pathname);
      update();
      events.addEventListener("stash:location", update);
      return () => events.removeEventListener("stash:location", update);
    }, []);

    if (!shouldShowNavButton()) return null;
    return React.createElement(
      "div",
      { id: BUTTON_ID, className: NAV_ITEM_CLASS },
      React.createElement("a", {
        href: "#",
        className: LINK_CLASS,
        onClick: onButtonClick,
        dangerouslySetInnerHTML: { __html: LINK_HTML },
      }),
    );
  }

  // Append to the children MenuItems renders in its Nav. Every other arg is passed through as is:
  // an `after` patch finds the rendered result by position, so the arg count must not change.
  api.patch.before("MainNavBar.MenuItems", (props, ...rest) => [
    {
      ...(props as Record<string, unknown>),
      children: [(props as { children?: ReactNode }).children, React.createElement(BattleNavItem, { key: BUTTON_ID })],
    },
    ...rest,
  ]);
}

/** Inject or remove the Battle nav item based on the current route. Safe to call repeatedly. */
function injectNavButton(): void {
  if (!shouldShowNavButton()) {
    const existing = document.getElementById(BUTTON_ID);
    if (existing) {
      existing.closest(".nav-link")?.remove();
    }
    return;
  }

  if (document.getElementById(BUTTON_ID)) return;

  const navItem = document.createElement("div");
  navItem.className = NAV_ITEM_CLASS;
  navItem.id = BUTTON_ID;

  const link = document.createElement("a");
  link.href = "#";
  link.className = LINK_CLASS;
  link.innerHTML = LINK_HTML;
  link.addEventListener("click", onButtonClick);
  navItem.appendChild(link);

  const navTarget = document.querySelector(".navbar-nav");
  if (navTarget) {
    navTarget.appendChild(navItem);
  }
}
