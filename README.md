<img width="1000" height="702" alt="Stash Battle: two scenes side by side with the Battle and Settings tabs, mode buttons and preview volume" src="docs/screenshots/battle.jpg" />

# ⚔️ Stash Battle

A head-to-head scene comparison plugin for [Stash](https://stashapp.cc/) that uses an ELO-style rating system to help you rank your scenes.

## Overview

Stash Battle presents you with two scenes side-by-side and asks you to pick the better one. Based on your choices, scene ratings are automatically updated using an ELO algorithm. Over time, this builds an accurate ranking of your entire library based on your personal preferences.

## Features

- **Four Comparison Modes:**
  - **Swiss** ⚖️ – Fair matchups between similarly-rated scenes. Both scenes' ratings adjust based on the outcome. Scenes stay in the pool, so you can keep battling a small filter indefinitely.
  - **Placement** 📍 – Place a scene fast. Each pick narrows the range of ranks it could land in (shown on its card). A rated scene starts near its current rank and takes bigger jumps while it keeps winning or losing, then bounces back with smaller steps once it overshoots, so it never skips scenes it belongs among. An unrated scene lands in about 10 picks even in a library of 500+ rated scenes.
  - **Gauntlet** 🎯 – Climb the ladder. A scene climbs from the bottom, challenging scenes above it until it loses, then falls to find its floor.
  - **Champion** 🏆 – Winner stays on. The winning scene keeps battling until it's dethroned.

- **Filtering**: Apply any filters on the scenes page before opening Battle. What you see on the scenes page is what you get in Stash Battle, in every mode; a line above the cards shows whether you're rating your filter or your whole library, and how many scenes that is. By default, filtered scenes appear on the left (scenes to rate) and opponents come from your full library on the right.

- **Settings tab** (next to the Battle tab, or Stash's Settings → Plugins). Saves to Stash:
  - **Fun mode** – battle without changing any ratings; every mode still plays out normally, nothing is saved
  - **Autoplay previews** – both loop silently; hover a card to hear it (on by default)
  - **Pause playing video when Battle opens** – on by default; turn it off to keep a scene playing behind the battle
  - **Open scenes in a new tab** when clicking a thumbnail
  - **Unrated scene rating** – what unrated scenes count as in Swiss (50 by default, a classic ELO start; 0 starts them at the bottom)
  - **Use filtered scenes for both sides**
  - **Clean mode** – a 🗑 button on each card opens Stash's own delete dialog (same options and defaults as deleting in Stash), so you can clean up without leaving the battle

- **Preview volume** slider on the tab bar (it follows perceived loudness); click the speaker to mute or unmute.

- **Works on phones and tablets**: the cards stay side by side on tablets, stack compactly on phones, and Skip stays pinned at the bottom. On touch screens, tap a thumbnail to play its preview, use ↗ to open the scene, and tap ⓘ next to the modes for an explanation of the current mode.

- **SFW Switch support**: thumbnails and previews blur when the [SFW Switch](https://github.com/stashapp/CommunityScripts) plugin's SFW mode is on.

## Screenshots

| Placement mode | Champion mode |
|----------------|---------------|
| <img width="480" alt="Placement mode: the scene being placed shows the range of ranks it could land in" src="docs/screenshots/placement.png" /> | <img width="480" alt="Champion mode: the winning scene stays on with a win streak badge" src="docs/screenshots/champion.png" /> |

<img width="800" alt="Settings tab: battle and scene options saved to Stash" src="docs/screenshots/settings.png" />


## Installation

⚠️ Install at your own risk, nearly entirely vibe coded for myself but I review (some) of the code and test as thoroughly as I can.

Recommend saving a backup of your database beforehand (Settings → Tasks → Backup) just in case. 

### Source Index: 

1. Add this repo's source index: `https://dtt-git.github.io/stash-battle/main/index.yml` to Stash plugin sources 
2. Checkbox the Stash Battle package and click Install

### Manual Download: 
1. Download the `/plugins/stash-battle/` folder to your Stash plugins directory

## Usage

Optional Step: Change Rating System Type to "Decimal" (Settings → Interface → Editing)
1. Navigate to the **Scenes** page in Stash
2. (Optional) Apply any filters or search to narrow down which scenes you want to rate (the line above the cards confirms what you're rating)
3. Click the **Battle** button in the navbar
4. Choose a mode (hover a mode, or tap ⓘ on a phone, for a short explanation)
5. Click a scene (or press ← / →) to pick the winner; Space skips the pair
6. Watch your rankings evolve over time!

You can also open Battle on a scene page, which puts that scene into a battle right away. 

Settings live in the **Settings** tab next to **Battle**.


## How It Works

The plugin uses an ELO-inspired algorithm where:
- Beating a higher-rated scene earns more points than beating a lower-rated one
- Losing to a lower-rated scene costs more points than losing to a higher-rated one
- Ratings are stored in Stash's native `rating100` field (1-100 scale which is why changing to decimal rating system type is recommended)

**Dynamic K-Factor:** Rating changes scale based on a scene's `play_count` (similar to chess ELO where new players' ratings are more volatile):
| Play Count | K-Factor | Behavior |
|------------|----------|----------|
| 0-2 | 12 | New scenes adjust quickly to find their true rating |
| 3-7 | 8 | Settling in with moderate changes |
| 8-14 | 6 | Established scenes change more slowly |
| 15+ | 4 | Very stable ratings that resist large swings |

In Gauntlet and Champion mode, only the active climber’s rating changes during a run (opponents are benchmarks). Climber wins use a high K-factor so placements move quickly.

In Placement mode no ratings change until the scene's spot is found; then it gets one rating between the scenes directly above and below it.

## Development

The plugin is written in TypeScript under [`src/`](src/) and bundled by [esbuild](https://esbuild.github.io/) into a single IIFE at `plugins/stash-battle/stash-battle.js` (which is what Stash actually loads). The committed `stash-battle.js` is a build artifact — edit the TypeScript modules, not the bundle.

### Setup

```bash
npm install
```

### Scripts

| Command | What it does |
|---------|--------------|
| `npm run build` | Production build -> `plugins/stash-battle/stash-battle.js` |
| `npm run dev` | Watch `src/`, rebuild on save, and deploy the bundle + css + yml into your live Stash plugins folder (when `STASH_PLUGINS_DIR` is set in `.env`) |
| `npm run typecheck` | Strict TypeScript type-check (`tsc --noEmit`) — esbuild does not type-check on its own. |

### Live development against Stash

To have `npm run dev` deploy straight into your local Stash install, point it at your Stash `plugins` folder. Copy `.env.example` to `.env` (which is gitignored, so your local path is never committed) and set:

```bash
# .env
STASH_PLUGINS_DIR=C:\Path\To\Stash\plugins
```

Each rebuild then writes the bundle + css + yml into `<STASH_PLUGINS_DIR>/stash-battle`. If `STASH_PLUGINS_DIR` is unset (or `none`), dev builds are produced in the repo but not deployed into Stash. You can also set it inline instead of using `.env`:

```bash
# PowerShell
$env:STASH_PLUGINS_DIR = "D:\path\to\Stash\plugins"; npm run dev
```

With the watcher running, edit any file in `src/` and save — the build deploys automatically. **Refresh Stash manually (F5)** to load the new bundle. (Browser auto-reload is not used: Stash's Content Security Policy blocks connections to `localhost`.)

### Source layout

| Module | Responsibility |
|--------|----------------|
| `types.ts` / `constants.ts` | Shared types and constants |
| `state.ts` | Central mutable runtime state + `resetRunState()` |
| `settings.ts` | User settings stored in Stash's plugin config |
| `graphql.ts` | Stash GraphQL access + `SCENE_FRAGMENT` |
| `cache.ts` | IndexedDB + in-memory scene cache (stale-while-revalidate) |
| `storage.ts` | localStorage session persistence |
| `filters.ts` | URL filter parsing + filtered-scene selection |
| `pairs.ts` | Matchmaking for Swiss / Placement / Gauntlet / Champion modes |
| `elo.ts` | ELO rating math |
| `rating.ts` | Persist ratings to Stash, keep pools in sync |
| `sceneActions.ts` | Checks for scenes deleted while in a battle |
| `ui/*` | Scene cards, screens, main UI, settings panel, delete dialog, nav button, modal |
| `main.ts` | Entry point / bootstrap |

## License

See [LICENCE](LICENCE) for details.
