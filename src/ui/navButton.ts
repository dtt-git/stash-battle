// The navbar "Battle" button that opens the comparison modal.
//
// Where Stash has the plugin patch API, the button is patched into MainNavBar.MenuItems (after
// Stash's own page links), so React renders it with the rest of the navbar. Otherwise it's added
// to the DOM directly and re-added whenever the page changes.

import type { PluginApiLike, ReactNode } from "../pluginApi";
import { openModal } from "./modal";

const BUTTON_ID = "plugin_sb";
const NAV_ITEM_CLASS = "col-4 col-sm-3 col-md-2 col-lg-auto nav-link";
const LINK_CLASS =
  "minimal p-4 p-xl-2 d-flex d-xl-inline-block flex-column justify-content-between align-items-center btn btn-primary";
const LINK_HTML = `
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
