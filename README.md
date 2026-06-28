<img width="1696" height="1135" alt="image" src="https://github.com/user-attachments/assets/4983d20c-2141-4000-afd5-cc1a669d4ddd" />

NSFW Demo Video on the Stash forum post: https://discourse.stashapp.cc/t/stash-battle/5180

# ⚔️ Stash Battle

A head-to-head scene comparison plugin for [Stash](https://stashapp.cc/) that uses an ELO-style rating system to help you rank your scenes.

## Overview

Stash Battle presents you with two scenes side-by-side and asks you to pick the better one. Based on your choices, scene ratings are automatically updated using an ELO algorithm. Over time, this builds an accurate ranking of your entire library based on your personal preferences.

## Features

- **Three Comparison Modes:**
  - **Swiss** ⚖️ – Fair matchups between similarly-rated scenes. Both scenes' ratings adjust based on the outcome.
  - **Gauntlet** 🎯 – Place a random scene in your rankings. It climbs from the bottom, challenging each scene above it until it loses, then settles into its final position.
  - **Champion** 🏆 – Winner stays on. The winning scene keeps battling until it's dethroned.

- **Filtering**: Apply any filters on the scenes page before opening Battle. What you see on the scenes page is what you get in Stash Battle. By default, filtered scenes appear on the left (scenes to rate) and opponents come from your full library on the right.


## Installation

⚠️ Install at your own risk, nearly entirely vibe coded for myself but I review code and test as thoroughly as I can.

Recommend saving a backup of your database beforehand (Settings → Interface → Editing) just in case. 

### Source Index: 

1. Add this repo's source index: `https://dtt-git.github.io/stash-battle/main/index.yml` to Stash plugin sources 
2. Checkbox the Stash Battle package and click Install

### Manual Download: 
1. Download the `/plugins/stash-battle/` folder to your Stash plugins directory

## Usage

Optional Step: Change Rating System Type to "Decimal" (Settings → Interface → Editing)
1. Navigate to the **Scenes** page in Stash
2. (Optional) Apply any filters or search to narrow down which scenes you want to rate
3. Click the **Battle** button in the navbar
4. Choose your preferred comparison mode
5. Click on a scene (or use arrow keys) to pick the winner
6. Watch your rankings evolve over time!

As well you can open battle on a scene page which puts that scene into battle right away. 


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
| `state.ts` | Central mutable runtime state + `resetGauntletState()` |
| `graphql.ts` | Stash GraphQL access + `SCENE_FRAGMENT` |
| `cache.ts` | IndexedDB + in-memory scene cache (stale-while-revalidate) |
| `storage.ts` | localStorage session persistence |
| `filters.ts` | URL filter parsing + filtered-scene selection |
| `pairs.ts` | Matchmaking for Swiss / Gauntlet / Champion modes |
| `elo.ts` | ELO rating math |
| `rating.ts` | Persist ratings to Stash, keep pools in sync |
| `ui/*` | Scene cards, screens, main UI, nav button, modal |
| `main.ts` | Entry point / bootstrap |

## License

See [LICENCE](LICENCE) for details.
