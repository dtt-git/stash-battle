// Stash's URLs when it's served under a subpath (a reverse proxy at /stash/, say): Stash then
// rewrites its page's <base href> to that prefix, and its API and pages all live under it.

/** Stash's base path: "/", or the subpath it's served under ("/stash/"), always ending in "/". */
export function basePath(): string {
  const href = typeof document === "undefined" ? null : document.querySelector("base")?.getAttribute("href");
  if (!href) return "/";
  const path = href.startsWith("/") ? href : new URL(href, window.location.href).pathname;
  return path.endsWith("/") ? path : `${path}/`;
}

/** A path on this Stash: stashUrl("graphql") is "/graphql", or "/stash/graphql" under /stash/. */
export function stashUrl(path: string): string {
  return basePath() + path.replace(/^\//, "");
}

/** The current page's path inside Stash, without the subpath: "/scenes/12" under /stash/ too. */
export function stashRoute(): string {
  const path = window.location.pathname;
  const base = basePath();
  if (base === "/") return path;
  if (path.startsWith(base)) return `/${path.slice(base.length)}`;
  return `${path}/` === base ? "/" : path;
}
