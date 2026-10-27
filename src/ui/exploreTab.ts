// The 🔎 Explore tab: the whole library as small cards, ranked by ELO, with search (title, studio,
// performers), tier / provisional / unrated filters, an ELO range and sorting. Clicking a card
// opens the scene's page; its ⚔️ button battles it; hovering (on touch, tapping the thumbnail)
// plays its preview (at the preview volume, like the battle cards). "Battle these" battles the filter's scenes. Built
// from Stash Battle's all-scenes cache each time the tab opens, and shown a page at a time, so a
// big library never puts thousands of cards on the page.

import { getAllScenesCached } from "../cache";
import { EXPLORE_PAGE_SIZES, TIERS } from "../constants";
import {
  DEFAULT_EXPLORE_FILTERS,
  exploreEntries,
  filterBattlesWithin,
  filterExplore,
  onlyGroup,
  type ExploreEntry,
  type ExploreFilters,
  type ExploreSort,
} from "../explore";
import { updateSettings } from "../settings";
import { isEloSetupPending, state } from "../state";
import { tierDescription, tierMap } from "../stats";
import { handleSceneLinkClick, isTouchDevice } from "./mainUI";
import { PROVISIONAL_TIP } from "./sceneCard";
import { escapeHtml, handleMiniMuteTap, handleMiniThumbTap, miniCardHtml, miniPreviewCard, startMiniPreview, stopMiniPreview } from "./miniCard";
import { resolveSceneTitle } from "../sceneTitle";
import type { StatsActions } from "./statsTab";

const SEARCH_DEBOUNCE_MS = 150;
/**
 * After a page change, card clicks wait this long: the list jumps under the pointer, and a quick
 * second click on Next would otherwise open whichever scene landed there.
 */
const PAGE_CLICK_GUARD_MS = 700;

const SORTS: { value: ExploreSort; label: string }[] = [
  { value: "elo-desc", label: "ELO: highest first" },
  { value: "elo-asc", label: "ELO: lowest first" },
  { value: "plays-desc", label: "Most played" },
  { value: "plays-asc", label: "Least played" },
  { value: "battles-desc", label: "Most battles" },
  { value: "battles-asc", label: "Fewest battles" },
  { value: "record-desc", label: "Best record" },
  { value: "peak-desc", label: "Highest peak ELO" },
  { value: "streak-desc", label: "Longest win streak" },
];

let filters: ExploreFilters = { ...DEFAULT_EXPLORE_FILTERS };
let entries: ExploreEntry[] = [];
let results: ExploreEntry[] = [];
let page = 0;
let ignoreCardClicksUntil = 0;
let actions: StatsActions | null = null;

export function createExploreTab(): string {
  return `
      <div class="sb-tab-panel sb-explore-tab" data-panel="explore" hidden>
        <div id="sb-explore-content"></div>
      </div>
    `;
}

/** Start Explore on these filters (e.g. an ELO range from the Stats tab); the rest reset. */
export function setExploreFilters(patch: Partial<ExploreFilters>): void {
  filters = { ...DEFAULT_EXPLORE_FILTERS, ...patch };
  page = 0;
}

function isFiltered(): boolean {
  return filters.query.trim() !== "" || filters.groups.length > 0 || filters.eloMin !== null || filters.eloMax !== null;
}

/** Cards per page ("All" puts every result on one page). */
function pageSize(): number {
  return state.settings.explorePageSize || Math.max(1, results.length);
}

function pageCount(): number {
  return Math.max(1, Math.ceil(results.length / pageSize()));
}

/** The filter chips after All, each with the tooltip its cards' pills have. */
const GROUPS: { value: string; label: string; tip: string }[] = [
  ...TIERS.map((t) => ({ value: t.id, label: `${t.emoji} ${t.name}`, tip: tierDescription(t) })),
  { value: "provisional", label: "Provisional", tip: PROVISIONAL_TIP },
  { value: "unrated", label: "Unrated", tip: "No ELO yet" },
];

function controlsHtml(): string {
  // Each chip's tooltip is the one its cards' pills have
  // Each chip toggles; All (none on) shows everyone
  const chip = (value: string, label: string, tip = ""): string => {
    const on = value ? filters.groups.includes(value) : filters.groups.length === 0;
    return `<button type="button" class="sb-chip${on ? " active" : ""}" data-group="${value}" aria-pressed="${on}"${tip ? ` title="${tip}"` : ""}>${label}</button>`;
  };
  const number = (value: number | null): string => (value === null ? "" : String(value));
  return `
        <div class="sb-explore-controls">
          <div class="sb-explore-row">
            <input type="search" class="sb-explore-input sb-explore-search" placeholder="🔍  Search titles, studios, performers" value="${escapeHtml(filters.query)}" aria-label="Search scenes">
            <select class="sb-explore-input sb-explore-select sb-explore-sort" aria-label="Sort">
              ${SORTS.map((s) => `<option value="${s.value}"${s.value === filters.sort ? " selected" : ""}>${s.label}</option>`).join("")}
            </select>
          </div>
          <div class="sb-explore-row sb-explore-row-wrap">
            <div class="sb-chips">${chip("", "All")}${GROUPS.map((g) => chip(g.value, g.label, g.tip)).join("")}</div>
            <div class="sb-explore-range">
              <span>ELO</span>
              <input type="number" class="sb-explore-input sb-explore-elo" data-bound="min" placeholder="from" value="${number(filters.eloMin)}" aria-label="Lowest ELO">
              <span>–</span>
              <input type="number" class="sb-explore-input sb-explore-elo" data-bound="max" placeholder="to" value="${number(filters.eloMax)}" aria-label="Highest ELO">
            </div>
          </div>
          <div class="sb-explore-status-row">
            <div class="sb-explore-status"></div>
            <div class="sb-explore-paging">
              <select class="sb-explore-input sb-explore-select sb-pager-select sb-explore-per-page" aria-label="Scenes per page">
                ${EXPLORE_PAGE_SIZES.map((n) => `<option value="${n}"${n === state.settings.explorePageSize ? " selected" : ""}>${n ? `${n} per page` : "All on one page"}</option>`).join("")}
              </select>
              <div class="sb-explore-pager"></div>
            </div>
          </div>
        </div>
        <div class="sb-explore-grid"></div>
        <div class="sb-explore-pager sb-explore-pager-bottom"></div>`;
}

/** ‹ [Page 3 of 34] › — the page number is a dropdown, to jump straight to a page. */
function pagerHtml(): string {
  const pages = pageCount();
  if (pages <= 1) return "";
  const options = Array.from(
    { length: pages },
    (_, i) => `<option value="${i}"${i === page ? " selected" : ""}>Page ${i + 1} of ${pages}</option>`,
  ).join("");
  return `
          <button type="button" class="sb-pager-btn" data-page-step="-1"${page === 0 ? " disabled" : ""} aria-label="Previous page">‹</button>
          <select class="sb-explore-input sb-explore-select sb-pager-select" aria-label="Page">${options}</select>
          <button type="button" class="sb-pager-btn" data-page-step="1"${page >= pages - 1 ? " disabled" : ""} aria-label="Next page">›</button>`;
}

/** Draw the current page of cards and the pagers. */
function showPage(content: HTMLElement): void {
  stopMiniPreview();
  page = Math.min(Math.max(0, page), pageCount() - 1);
  const grid = content.querySelector<HTMLElement>(".sb-explore-grid");
  if (grid) {
    grid.innerHTML = results.length
      ? results.slice(page * pageSize(), (page + 1) * pageSize()).map((entry) => miniCardHtml(entry)).join("")
      : `<p class="sb-stats-empty">No scenes match.</p>`;
  }
  content.querySelectorAll<HTMLElement>(".sb-explore-pager").forEach((pager) => (pager.innerHTML = pagerHtml()));
}

/** The filter in words, for the note above the cards: "👑 Legendary · ELO 1600–1700 · “jane”". */
function filterLabel(): string {
  const parts: string[] = [];
  const groups = GROUPS.filter((g) => filters.groups.includes(g.value));
  if (groups.length) parts.push(groups.map((g) => g.label).join(", "));
  if (filters.eloMin !== null || filters.eloMax !== null) {
    parts.push(`ELO ${filters.eloMin ?? "…"}–${filters.eloMax ?? "…"}`);
  }
  if (filters.query.trim()) parts.push(`“${escapeHtml(filters.query.trim())}”`);
  return parts.join(" · ");
}

/** "Battle these": Placement for unrated scenes, otherwise Swiss (vs everyone, or within the filter). */
function battleButtonHtml(): string {
  if (!isFiltered() || results.length === 0) return "";
  const within = filterBattlesWithin(filters, state.settings.filterOpponents);
  const n = results.length;
  const scenes = `${n} scene${n === 1 ? "" : "s"}`;
  const label =
    onlyGroup(filters, "unrated")
      ? `📍 Place these ${scenes}`
      : onlyGroup(filters, "provisional")
        ? `🔁 Keep testing these ${scenes}`
        : `⚔️ Battle these ${scenes}`;
  const tip =
    onlyGroup(filters, "unrated")
      ? "Placement, one scene at a time, against your whole library"
      : within
        ? "Swiss, with both sides from these scenes (“Use filtered scenes for both sides” is on)"
        : "Swiss, these scenes against your whole library (turn on “Use filtered scenes for both sides” in Settings to keep both sides in the filter)";
  const disabled = within && n < 2 ? " disabled" : "";
  return `<button type="button" class="btn btn-primary btn-sm sb-explore-battle" data-explore-battle title="${tip}"${disabled}>${label}</button>`;
}

/** Re-run the filters and go back to the first page. */
function applyFilters(content: HTMLElement, keepPage = false): void {
  results = filterExplore(entries, filters);
  if (!keepPage) page = 0;
  const status = content.querySelector<HTMLElement>(".sb-explore-status");
  if (status) {
    status.innerHTML = `<span>${results.length === entries.length ? `${entries.length} scenes` : `${results.length} of ${entries.length} scenes`}${
      isFiltered() ? ` · <a href="#" data-explore-clear>Clear filters</a>` : ""
    }</span>${battleButtonHtml()}`;
  }
  showPage(content);
}

/** Change page; from the bottom pager, bring the top of the list back into view. */
function goToPage(content: HTMLElement, scrollRoot: HTMLElement | null, next: number): void {
  page = next;
  showPage(content);
  ignoreCardClicksUntil = Date.now() + PAGE_CLICK_GUARD_MS;
  const controls = content.querySelector<HTMLElement>(".sb-explore-controls");
  if (!scrollRoot || !controls) return;
  const offset = controls.getBoundingClientRect().top - scrollRoot.getBoundingClientRect().top;
  if (offset < 0) scrollRoot.scrollTop += offset;
}

// ---------- Events ----------

function bindControls(content: HTMLElement, scrollRoot: HTMLElement | null): void {
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  content.querySelector<HTMLInputElement>(".sb-explore-search")?.addEventListener("input", (e) => {
    filters.query = (e.target as HTMLInputElement).value;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => applyFilters(content), SEARCH_DEBOUNCE_MS);
  });
  content.querySelector<HTMLSelectElement>(".sb-explore-sort")?.addEventListener("change", (e) => {
    filters.sort = (e.target as HTMLSelectElement).value as ExploreSort;
    applyFilters(content);
  });
  content.querySelectorAll<HTMLInputElement>(".sb-explore-elo").forEach((input) => {
    input.addEventListener("change", () => {
      const value = input.value.trim() === "" ? null : Number(input.value);
      const bound = Number.isFinite(value) ? value : null;
      if (input.dataset.bound === "min") filters.eloMin = bound;
      else filters.eloMax = bound;
      applyFilters(content);
    });
  });

  // The content element outlives each render, so these bind once
  if (content.dataset.bound === "1") return;
  content.dataset.bound = "1";
  content.addEventListener("click", (e) => onContentClick(e, content, scrollRoot));
  content.addEventListener("change", (e) => {
    const select = e.target as HTMLSelectElement;
    if (select.classList.contains("sb-explore-per-page")) {
      updateSettings({ explorePageSize: Number(select.value) });
      goToPage(content, scrollRoot, 0);
    } else if (select.classList.contains("sb-pager-select")) {
      goToPage(content, scrollRoot, Number(select.value));
    }
  });
  // Previews follow the mouse only (touch screens have no hover)
  content.addEventListener("mouseover", (e) => {
    if (isTouchDevice()) return;
    const card = (e.target as Element).closest<HTMLElement>(".sb-mini-card[data-preview]");
    if (card) startMiniPreview(card);
  });
  content.addEventListener("mouseout", (e) => {
    const playing = miniPreviewCard();
    if (playing && content.contains(playing) && !playing.contains(e.relatedTarget as Node | null)) stopMiniPreview();
  });
}

/** Chips, Clear filters, page buttons, ⚔️ and card links. */
function onContentClick(e: Event, content: HTMLElement, scrollRoot: HTMLElement | null): void {
  const target = e.target as Element;
  const chip = target.closest<HTMLElement>(".sb-chip");
  if (chip) {
    const group = chip.dataset.group || "";
    const on = new Set(filters.groups);
    if (!group) on.clear();
    else if (on.has(group)) on.delete(group);
    else on.add(group);
    // In the chips' order, so the same chips make the same filter
    filters.groups = GROUPS.map((g) => g.value).filter((value) => on.has(value));
    content.querySelectorAll<HTMLElement>(".sb-chip").forEach((c) => {
      const active = c.dataset.group ? on.has(c.dataset.group) : on.size === 0;
      c.classList.toggle("active", active);
      c.setAttribute("aria-pressed", String(active));
    });
    applyFilters(content);
    return;
  }
  if (target.closest("[data-explore-clear]")) {
    e.preventDefault();
    filters = { ...DEFAULT_EXPLORE_FILTERS, sort: filters.sort };
    render(content, scrollRoot);
    return;
  }
  const step = target.closest<HTMLButtonElement>("[data-page-step]");
  if (step) {
    goToPage(content, scrollRoot, page + Number(step.dataset.pageStep));
    return;
  }
  // Just after a page change, a click on a card is most likely a double click on Next
  if (Date.now() < ignoreCardClicksUntil && target.closest(".sb-mini-card")) {
    e.preventDefault();
    return;
  }
  if (target.closest("[data-explore-battle]")) {
    stopMiniPreview();
    actions?.battleFilter(filters, filterLabel());
    return;
  }
  if (handleMiniMuteTap(e) || handleMiniThumbTap(e)) return;
  const battle = target.closest<HTMLElement>("[data-battle]");
  if (battle?.dataset.battle) {
    stopMiniPreview();
    actions?.battleScene(battle.dataset.battle);
    return;
  }
  const link = target.closest<HTMLAnchorElement>(".sb-mini-link");
  if (link) {
    stopMiniPreview();
    handleSceneLinkClick(e as MouseEvent, link);
  }
}

function render(content: HTMLElement, scrollRoot: HTMLElement | null): void {
  content.innerHTML = controlsHtml();
  bindControls(content, scrollRoot);
  // Reopening Explore (back from a scene page, say) stays on the same page; showPage clamps it
  applyFilters(content, true);
}


/** Fill the Explore tab from the all-scenes cache (call each time the tab opens). */
export async function renderExploreTab(modal: HTMLElement, tabActions: StatsActions): Promise<void> {
  actions = tabActions;
  const content = modal.querySelector<HTMLElement>("#sb-explore-content");
  if (!content) return;
  if (isEloSetupPending()) {
    content.innerHTML = `<p class="sb-stats-empty">Explore opens once the ELO setup on the Battle tab is done.</p>`;
    return;
  }
  content.innerHTML = `<div class="sb-loading">Loading scenes...</div>`;
  let scenes;
  try {
    scenes = (await getAllScenesCached()).scenes ?? [];
  } catch (e) {
    console.error("[Stash Battle] Couldn't load scenes for Explore:", e);
    content.innerHTML = `<p class="sb-stats-empty">Couldn't load your scenes. Switch tabs to try again.</p>`;
    return;
  }
  entries = exploreEntries(scenes, tierMap(scenes), resolveSceneTitle);
  render(content, modal.querySelector<HTMLElement>(".sb-modal-content"));
}
