<img width="764" alt="Stash Battle: two scenes side by side with their tier, ELO, rank and record, each side's chance of winning at the VS, the tab bar, mode buttons and preview volume" src="docs/screenshots/battle.png" />

# ⚔️ Stash Battle

A head-to-head scene comparison plugin for [Stash](https://stashapp.cc/) that uses an ELO rating system to help you rank your scenes.

## Overview

Stash Battle presents you with two scenes side-by-side and asks you to pick the better one. Every scene gets its own ELO score, the same kind of rating chess uses: winning raises it, losing lowers it, and beating a stronger scene earns more than beating a weaker one. Over time this builds an accurate ranking of your entire library based on your personal preferences.

Then explore it: browse your library by ELO and tier, see how your rankings are spread and how settled they are, find hidden gems you rarely play, and keep records like win streaks, peak ELO and a hall of fame of every scene that has been #1.

ELO is saved in each scene's custom fields, so **Stash Battle doesn't touch your Stash star ratings unless you ask it to**. If you'd like your ratings to follow your rankings, switch on a Stash ratings update mode.

## Requirements

- **Stash v0.31.0 or newer** (the version that added custom fields to scenes, where ELO is stored). On an older Stash, Stash Battle shows a message instead of loading.

## Features

### Three comparison modes

- **Swiss** ⚖️ – Fair matchups between scenes with similar ELO. Both scenes' ELO changes after every pick. Scenes stay in the pool, so you can keep battling a small filter indefinitely.
- **Placement** 📍 – Place a scene fast. Each pick narrows the range of ranks it could land in (shown on its card). A rated scene starts near its current rank and takes bigger jumps while it keeps winning or losing, then bounces back with smaller steps once it overshoots. An unrated scene lands in about 10 picks even in a library of 500+ scenes. Only the placed scene's ELO changes, once, when it lands.
  - **Start from the bottom** (a setting, and the replacement for Gauntlet): the scene ignores its current ELO, starts against your lowest scene and climbs, jumping further with each win (never more than a tenth of your library at once). A scene that never loses earns the champion spot.
- **Champion** 🏆 – Winner stays on. The winning scene keeps defending until it's beaten, then the winner takes over. Both scenes' ELO changes every pick.

| Placement | Champion |
|-----------|----------|
| <img width="420" alt="Placement mode: the scene being placed shows the range of ranks it could land in" src="docs/screenshots/placement.png" /> | <img width="420" alt="Champion mode: the winning scene stays on with a win streak badge" src="docs/screenshots/champion.png" /> |

### Scene cards

As in the screenshot at the top, each card shows the scene's tier, ELO and rank (`ELO 1740 · #50`), its record (`Record: 12–5`) and its Stash rating.

- **Win chances** at the VS, like a chess broadcast: `68%` VS `32%`. Win with 40% or less and the result says **Upset!**
- **Tiers** 👑 Legendary · 💎 Diamond · 🔷 Platinum · 🥇 Gold · 🥈 Silver · 🥉 Bronze, by where a scene ranks among your settled scenes (top 1%, 5%, 15%, 35%, 65%, the rest), so every tier always has scenes in it. The card's border takes the tier's colour (a setting).
- A **`?`** after the ELO (`ELO 1540?`) means it's still settling: the scene has had fewer than 10 battles, and its ELO still moves a lot.
- **↶ Undo** (or Backspace) takes back your last pick: both scenes' ELO and records, a Champion streak or Placement run, and the same pair comes back to pick again.

### One-time ELO setup

The first time you open Stash Battle, choose how ELO starts (from your current star ratings, so your existing order carries over, or 1500 for every scene) and whether Stash ratings should be updated. A live preview shows what each choice does. You can start over any time with **Reset ELO** in Settings.

<img width="600" alt="ELO setup: how ELO starts, whether Stash ratings are updated, and a 10-scene preview" src="docs/screenshots/setup.png" />

### Stash ratings update mode

Your choice (in setup or Settings) of whether Stash Battle writes your Stash ratings:

- **Don't update** (default): ELO is saved; your star ratings stay as they are.
- **Straight-line**: rating = ELO converted back (1500 = 5.0, or 2.5 stars). Very high or low scenes stop at the top or bottom of the scale.
- **Percentile**: rating = percentile in your library. 9.0 (4.5 stars) means the scene ranks above about 90% of your scenes; the top scene gets the top rating.

Switching to Straight-line or Percentile tells you how many ratings will change before anything is written. While an update mode is on, each battle updates only the ratings that changed, and Stash's own pages show the new ratings without a refresh.

### Filtering

Apply any filters on the Scenes page before opening Stash Battle. What you see on the Scenes page is what you get in Stash Battle, in every mode; a line above the cards shows whether you're rating your filter or your whole library, and how many scenes that is. By default, filtered scenes appear on the left (scenes to rate) and opponents come from your full library on the right; with **Use filtered scenes for both sides**, the filter's scenes battle each other.

### 🔎 Explore

Your whole library as small cards ranked by ELO. Search by title, studio or performer, filter by tier, provisional or unrated, pick an ELO range, and sort by ELO, plays, battles, best record, highest peak or longest win streak. Hover a card for its preview, click it to open the scene, or ⚔️ to battle it. **Battle these N scenes** battles everything the filter shows (unrated scenes go straight to Placement) until you press Stop.

<img width="600" alt="Explore tab: small scene cards with tier pills and ELO, search, tier filters, ELO range, sort and page controls" src="docs/screenshots/explore.png" />

### 📊 Stats

- **Overview**: scenes with an ELO, unrated, provisional, total battles.
- **See how settled your rankings are**, and battle your least-tested scenes in one click.
- **ELO distribution**, with your Stash rating scale under it. Click a bar to see those scenes in Explore.

<img width="600" alt="Stats tab: overview numbers, how settled the rankings are with Battle the least-tested, and the ELO distribution" src="docs/screenshots/stats.png" />

- **Hidden gems / overplayed**: ELO against play count. Top left are scenes you rank highly but rarely watch. Hover a dot to see the scene.

<img width="600" alt="Stats tab: hidden gems and overplayed, ELO against play count, with a scene's card on hover" src="docs/screenshots/gems.png" />

### 🏆 Records

The **hall of fame** (every scene that has ever been #1, and when it got there), the **longest win streaks** and the **highest peak ELOs**. The hall of fame is saved in Stash's plugin settings, so restoring a database backup doesn't change it; **Settings → Clear hall of fame** empties it.

<img width="600" alt="Records tab: the hall of fame of scenes that have been #1, the longest win streaks and the highest peak ELOs" src="docs/screenshots/records.png" />

### On Stash's scene pages

The same `ELO 1740 · #50` sits next to the play count and O count, with the scene's tier emoji. Click it to battle that scene.

<img width="455" alt="A scene page's toolbar: the star rating, then a crown emoji with ELO 2114 · #1, then the play count and O count" src="docs/screenshots/scene-page.png" />

### Settings

Most are also under Stash's Settings → Plugins. Everything saves to Stash:

- **Stash ratings update mode**, **Reset ELO** (see above) and **Clear hall of fame**
- **Use filtered scenes for both sides**
- **Placement: start from the bottom**
- **Autoplay previews** – both loop silently; hover a card to hear it (on by default)
- **Pause playing video when Stash Battle opens** – on by default; turn it off to keep a scene playing behind the battle
- **Tier colours on card borders** – on by default
- **Open scenes in a new tab** when clicking a thumbnail
- **Clean mode** – a 🗑 button on each card opens Stash's own delete dialog (same options and defaults as deleting in Stash), so you can clean up without leaving the battle

The **preview volume** slider sits on the tab bar (it follows perceived loudness); click the speaker to mute or unmute.

<img width="600" alt="Settings tab: Stash ratings update mode, Reset ELO, Clear hall of fame, battle and scene options" src="docs/screenshots/settings.png" />

### Phones and tablets

Full phone and tablet support.

| Battle | Explore | Stats |
|--------|---------|-------|
| <img width="260" alt="Phone: the two scenes stacked with the win chances between them, emoji tabs, and mute and open buttons on each card" src="docs/screenshots/phone-battle.png" /> | <img width="260" alt="Phone: Explore's filters and two columns of small scene cards" src="docs/screenshots/phone-explore.png" /> | <img width="260" alt="Phone: the Stats tab's overview, how settled the rankings are, and the ELO distribution" src="docs/screenshots/phone-stats.png" /> |

### SFW Switch support

Thumbnails and previews blur when the [SFW Switch](https://github.com/stashapp/CommunityScripts) plugin's SFW mode is on.

## Installation

⚠️ Install at your own risk, nearly entirely vibe coded for myself but I review (some) of the code and test as thoroughly as I can.

Recommend saving a backup of your database beforehand (Settings → Tasks → Backup) just in case, especially before turning on a Stash ratings update mode.

### Source Index:

1. Add this repo's source index: `https://dtt-git.github.io/stash-battle/main/index.yml` to Stash plugin sources
2. Checkbox the Stash Battle package and click Install

### Manual Download:
1. Download the `/plugins/stash-battle/` folder to your Stash plugins directory

## Usage

1. (Optional) On the **Scenes** page, apply any filters or search to narrow down which scenes you want to rate (the line above the cards confirms what you're rating)
2. Click the **⚔️ Battle** button in the navbar
3. The first time, set up ELO: choose how it starts and whether your Stash ratings should be updated
4. Choose a mode (hover a mode, or tap ⓘ on a phone, for a short explanation)
5. Click a scene (or press ← / →) to pick the winner; Space skips the pair, and ↶ Undo (Backspace) takes back a pick
6. Watch your rankings evolve over time in **Explore**, **Stats** and **Records**!

You can also open Stash Battle on a scene page (the **⚔️ Battle** button, or the ELO next to the play count), which puts that scene into a battle right away.

## How It Works

Every scene gets an ELO score, stored in its custom fields (`stash_battle_elo`, alongside `stash_battle_battles` and `stash_battle_seeded`, and its record: `stash_battle_wins`, `_losses`, `_peak`, `_streak` and `_best_streak`). The hall of fame is kept in Stash Battle's plugin settings, so everything follows you across browsers and devices. Scenes start at 1500, or from their star rating if you choose "Use my ratings" at setup (a 5.0 rating, or 2.5 stars, starts at 1500; each 0.1 is 10 ELO, so 10.0 = 2000).

- Beating a higher-rated scene earns more points than beating a lower-rated one
- Losing to a lower-rated scene costs more points than losing to a higher-rated one
- There's no top or bottom limit, so the very best scenes can keep pulling ahead
- A scene that's 400 ELO ahead is expected to win about 10 times out of 11

**How far ELO moves per battle (K):** new scenes move a lot so they find their level quickly, and established scenes move less:

| Battles so far | ELO moves by up to |
|----------------|--------------------|
| 0-9 | 40 |
| 10-29 | 24 |
| 30+ | 16 |

Scenes that started from their star rating get a 10-battle head start (they begin at 24), because their rating already said something about them.

**Swiss** pairs each scene with a random opponent within 100 ELO of it (or the closest few, if there aren't enough), so every pick is a real contest. In **Swiss** and **Champion**, both scenes' ELO changes after every pick. In **Placement**, nothing changes until the scene's spot is found; then it gets an ELO between the scenes directly above and below it, and only that scene changes.

**While a Stash ratings update mode is on**, Stash Battle keeps your star ratings in step with ELO, so a star rating you change by hand in Stash is overwritten the next time Stash Battle writes that scene. With "Don't update", your star ratings are never touched.

## Development

The plugin is written in TypeScript under [`src/`](src/) and bundled by [esbuild](https://esbuild.github.io/) into a single IIFE at `plugins/stash-battle/stash-battle.js` (which is what Stash actually loads). The committed `stash-battle.js` is a build artifact — edit the TypeScript modules, not the bundle. See [DOCUMENTATION.md](DOCUMENTATION.md) for how everything works.

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
| `npm test` | Unit tests (ELO math, Stash rating conversions, Placement search, tiers, stats, Explore, records, settings, rating sync) |
| `npm run smoke` | Headless checks against your running Stash (a first install, an older Stash, a 20,000-scene library); nothing is written to Stash. Needs Chrome or Edge installed |
| `npm run screenshots` | Retake the README screenshots (desktop and phone) from your running Stash, with placeholder titles and hidden thumbnails; nothing is written |

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
| `elo.ts` / `score.ts` | ELO math and win chances; a scene's ELO fields and record, ELO ↔ Stash rating, ordering, Swiss opponents |
| `stats.ts` / `explore.ts` | Tiers and the Stats / Records maths; Explore's search, filters and sorts |
| `placement.ts` | Placement's search |
| `eloSetup.ts` | One-time ELO setup and Reset ELO |
| `graphql.ts` | Stash GraphQL access + `SCENE_FRAGMENT`, Stash page-cache refresh |
| `cache.ts` | IndexedDB + in-memory scene cache (stale-while-revalidate), sorted by ELO |
| `storage.ts` | localStorage session persistence |
| `filters.ts` | URL filter parsing + filtered-scene selection |
| `pairs.ts` | Matchmaking for Swiss / Placement / Champion modes, battled Explore filters, least-tested |
| `rating.ts` | Save ELO and Stash ratings, keep pools in sync |
| `sceneActions.ts` | Checks for scenes deleted while in a battle |
| `ui/*` | Scene cards, screens, setup screen and preview, main UI, the Explore / Stats / Records tabs and their small cards, settings panel, dialogs, nav button, scene page ELO, modal |
| `main.ts` | Entry point / bootstrap |

## License

See [LICENCE](LICENCE) for details.
