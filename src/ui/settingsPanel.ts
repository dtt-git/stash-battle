// Battle / Settings tabs (Stash's own nav-tabs + .setting rows, like Stash-TCode), plus the
// preview volume control that sits on the tab bar. Every control carries data-setting="<key>";
// values persist via updateSettings(). Action rows (Reset ELO) carry data-action instead.

import { updateSettings } from "../settings";
import { state } from "../state";
import type { Settings, StashRatingsMode } from "../types";
import { STASH_RATINGS_OPTIONS, stashRatingsOption } from "./stashRatingsText";

type BoolKey = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];
export type TabId = "battle" | "explore" | "stats" | "settings";

type SettingRow =
  | { key: keyof Settings; title: string; hint: string; className?: string }
  | { action: "reset-elo"; title: string; hint: string; button: string };

const SECTIONS: { title: string; rows: SettingRow[] }[] = [
  {
    title: "ELO",
    rows: [
      // The hint is the selected option's description (kept current by syncSettingsControls)
      { key: "stashRatings", title: "Stash ratings update mode", hint: "" },
      {
        action: "reset-elo",
        title: "Reset ELO",
        hint: "Start every scene's ELO over, from its Stash rating or at 1500",
        button: "Reset ELO…",
      },
    ],
  },
  {
    title: "Battles",
    rows: [
      { key: "filterOpponents", title: "Use filtered scenes for both sides", hint: "Opponents also come from the current scene list filter instead of your whole rated library" },
      { key: "placementFromBottom", title: "Placement: start from the bottom", hint: "Placement ignores the scene's current ELO: it starts against the bottom scene and climbs, jumping further with each win (this replaces Gauntlet)" },
    ],
  },
  {
    title: "Scenes",
    rows: [
      // Narrow phones hide the tab bar's slider (only its mute button fits), so it's here instead
      { key: "previewVolume", title: "Preview volume", hint: "How loud the hovered or tapped card's preview plays. 0 mutes it", className: "sb-setting-phone-only" },
      { key: "autoplayPreviews", title: "Autoplay previews", hint: "Loop both previews silently; hover a card to hear it" },
      { key: "pauseMediaOnOpen", title: "Pause playing video when Stash Battle opens", hint: "Stops the scene you're watching so its audio doesn't overlap the battle previews" },
      { key: "tierBorders", title: "Tier colours on card borders", hint: "Each battle card's border takes the colour of its tier (👑 Legendary down to 🥉 Bronze), as on the Explore cards" },
      { key: "openInNewTab", title: "Open scenes in a new tab", hint: "Clicking a thumbnail opens the scene in a new browser tab" },
      { key: "cleanMode", title: "Clean mode", hint: "Show a 🗑 button on each card to delete the scene from Stash" },
    ],
  },
];

/** Volume restored when unmuting from 0 with no earlier level this session. */
const DEFAULT_UNMUTE_VOLUME = 50;
let volumeBeforeMute: number | null = null;

let activeTab: TabId = "battle";

export function getActiveTab(): TabId {
  return activeTab;
}

function volumeIcon(volume: number): string {
  if (volume === 0) return "🔇";
  return volume < 50 ? "🔉" : "🔊";
}

function settingControl(key: keyof Settings): string {
  if (key === "previewVolume") {
    const volume = state.settings.previewVolume;
    return `<div class="sb-setting-volume"><input type="range" min="0" max="100" step="1" data-setting="previewVolume" value="${volume}" aria-label="Preview volume"><span class="sb-volume-value">${volume}</span></div>`;
  }
  if (key === "stashRatings") {
    const options = STASH_RATINGS_OPTIONS.map(
      ({ value, label }) =>
        `<option value="${value}" ${value === state.settings.stashRatings ? "selected" : ""}>${label}</option>`,
    ).join("");
    return `<select data-setting="${key}" class="form-control form-control-sm sb-setting-select" aria-label="Stash ratings update mode">${options}</select>`;
  }
  const id = `sb-setting-${key}`;
  return `
          <div class="custom-control custom-switch">
            <input type="checkbox" class="custom-control-input" id="${id}" data-setting="${key}" ${state.settings[key as BoolKey] ? "checked" : ""}>
            <label class="custom-control-label" for="${id}"></label>
          </div>`;
}

/** Tab bar: Battle / Explore / Stats / Settings on the left, preview volume on the right. */
export function createTabBar(): string {
  const { previewVolume } = state.settings;
  return `
      <div class="sb-tab-bar">
        <nav class="nav nav-tabs sb-tabs" role="tablist">
          <a class="nav-item nav-link active" role="tab" data-tab="battle" aria-selected="true">⚔️ Battle</a>
          <a class="nav-item nav-link" role="tab" data-tab="explore" aria-selected="false">🔎 Explore</a>
          <a class="nav-item nav-link" role="tab" data-tab="stats" aria-selected="false">📊 Stats</a>
          <a class="nav-item nav-link" role="tab" data-tab="settings" aria-selected="false">⚙ Settings</a>
        </nav>
        <div class="sb-volume" title="Preview volume">
          <button type="button" class="sb-volume-icon" aria-label="Mute previews">${volumeIcon(previewVolume)}</button>
          <input type="range" min="0" max="100" step="1" data-setting="previewVolume" value="${previewVolume}" aria-label="Preview volume">
          <span class="sb-volume-value">${previewVolume}</span>
        </div>
      </div>
    `;
}

function settingRowHtml(row: SettingRow): string {
  const hint = "key" in row && row.key === "stashRatings" ? stashRatingsOption(state.settings.stashRatings).desc : row.hint;
  const hintFor = "key" in row ? ` data-hint-for="${row.key}"` : "";
  const control =
    "key" in row
      ? settingControl(row.key)
      : `<button type="button" class="btn btn-secondary btn-sm" data-action="${row.action}">${row.button}</button>`;
  const rowClass = "key" in row && row.className ? ` ${row.className}` : "";
  return `
            <div class="setting${rowClass}">
              <div>
                <h3>${row.title}</h3>
                <div class="sub-heading"${hintFor}>${hint}</div>
              </div>
              <div>${control}</div>
            </div>`;
}

export function createSettingsTab(): string {
  const sections = SECTIONS.map(
    ({ title, rows }) => `
        <div class="setting-section">
          <h1>${title}</h1>
          <div class="card">
            ${rows.map(settingRowHtml).join("")}
          </div>
        </div>`,
  ).join("");

  return `
      <div class="sb-tab-panel sb-settings-tab" data-panel="settings" hidden>
        ${sections}
        <p class="sb-settings-note">Saves to Stash, also under Settings → Plugins.</p>
      </div>
    `;
}

/** Push state.settings into the rendered controls (e.g. after re-fetching settings on reopen). */
export function syncSettingsControls(root: ParentNode): void {
  root.querySelectorAll<HTMLInputElement>("input[data-setting]").forEach((input) => {
    const key = input.dataset.setting as keyof Settings;
    const value = state.settings[key];
    if (input.type === "checkbox") input.checked = Boolean(value);
    else input.value = String(value);
  });
  root.querySelectorAll<HTMLSelectElement>("select[data-setting]").forEach((select) => {
    select.value = String(state.settings[select.dataset.setting as keyof Settings]);
  });
  root.querySelectorAll<HTMLElement>('[data-hint-for="stashRatings"]').forEach((hint) => {
    hint.textContent = stashRatingsOption(state.settings.stashRatings).desc;
  });
  const volume = state.settings.previewVolume;
  root.querySelectorAll(".sb-volume-icon").forEach((el) => {
    el.textContent = volumeIcon(volume);
    el.setAttribute("aria-label", volume === 0 ? "Unmute previews" : "Mute previews");
  });
  root.querySelectorAll(".sb-volume-value").forEach((el) => (el.textContent = String(volume)));
}

/** Show a tab. Panels are swapped in place, so nothing above the tab bar moves. */
export function showTab(root: ParentNode, tab: TabId): void {
  activeTab = tab;
  root.querySelectorAll<HTMLElement>(".sb-tabs .nav-link").forEach((link) => {
    const on = link.dataset.tab === tab;
    link.classList.toggle("active", on);
    link.setAttribute("aria-selected", String(on));
  });
  root.querySelectorAll<HTMLElement>(".sb-tab-panel").forEach((panel) => {
    panel.hidden = panel.dataset.panel !== tab;
  });
}

/**
 * Wire every data-setting control, the tabs and the mute button.
 * onChange runs after a value is stored; onTabChange after a tab switch. A dropdown change
 * first awaits beforeChange (a warning, say): false puts the dropdown back and stores nothing.
 */
export function bindSettingsControls(
  root: ParentNode,
  onChange: (key: keyof Settings) => void,
  onTabChange: (tab: TabId) => void,
  beforeChange: (key: keyof Settings, value: string) => Promise<boolean> = async () => true,
): void {
  const apply = (patch: Partial<Settings>, key: keyof Settings): void => {
    updateSettings(patch);
    syncSettingsControls(root);
    onChange(key);
  };

  root.querySelectorAll<HTMLInputElement>("input[data-setting]").forEach((input) => {
    const key = input.dataset.setting as keyof Settings;
    // Range updates live while dragging; others on commit
    const eventName = input.type === "range" ? "input" : "change";
    input.addEventListener(eventName, () => {
      const value = input.type === "checkbox" ? input.checked : Number(input.value);
      apply({ [key]: value } as Partial<Settings>, key);
    });
  });

  root.querySelectorAll<HTMLSelectElement>("select[data-setting]").forEach((select) => {
    const key = select.dataset.setting as keyof Settings;
    select.addEventListener("change", async () => {
      const value = select.value;
      select.disabled = true;
      try {
        if (await beforeChange(key, value)) apply({ [key]: value as StashRatingsMode } as Partial<Settings>, key);
        else syncSettingsControls(root);
      } finally {
        select.disabled = false;
      }
    });
  });

  // Speaker icon: mute, or restore the level from before muting
  root.querySelectorAll<HTMLButtonElement>(".sb-volume-icon").forEach((btn) => {
    btn.addEventListener("click", () => {
      const current = state.settings.previewVolume;
      if (current > 0) {
        volumeBeforeMute = current;
        apply({ previewVolume: 0 }, "previewVolume");
      } else {
        apply({ previewVolume: volumeBeforeMute ?? DEFAULT_UNMUTE_VOLUME }, "previewVolume");
      }
    });
  });

  root.querySelectorAll<HTMLElement>(".sb-tabs .nav-link").forEach((link) => {
    link.addEventListener("click", () => {
      const tab = link.dataset.tab as TabId;
      if (tab === activeTab) return;
      showTab(root, tab);
      onTabChange(tab);
    });
  });
}
