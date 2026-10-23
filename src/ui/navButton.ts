// The navbar "Battle" button that opens the comparison modal.
//
// Where Stash has the plugin patch API, the button is patched into MainNavBar.MenuItems (after
// Stash's own page links), so React renders it with the rest of the navbar. Otherwise it's added
// to the DOM directly and re-added whenever the page changes.

import type { PluginApiLike, ReactNode } from "../pluginApi";
import { SWORDS_PATHS } from "./icons";
import { openModal } from "./modal";

const BUTTON_ID = "plugin_sb";
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

/** Add the Battle nav item to Stash's navbar, shown only on the routes where it applies. Call once at startup. */
export function registerNavButton(): void {
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
