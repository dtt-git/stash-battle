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

- **Filter Support:** Apply filters on the Scenes page before opening Battle to rate specific scenes against your full collection.


## Installation

⚠️ Install at your own risk, nearly entirely vibe coded for myself using Claude, I have barely reviewed the code at all.

Recommend saving a backup of your database beforehand (Settings → Interface → Editing)

### Source Index: 

1. Add this repo's source index: `https://dtt-git.github.io/stash-battle/main/index.yml` to Stash plugin sources 
2. Checkbox the Stash Battle package and click Install

### Manual Download: 
1. Download the `/plugins/stash-battle/` folder to your Stash plugins directory

## Usage

Optional Step: Change Rating System Type to "Decimal" (Settings → Interface → Editing)
1. Navigate to the **Scenes** page in Stash
2. (Optional) Apply any filters or search to narrow down which scenes you want to rate
3. Click the floating ⚔️ button in the bottom-right corner
4. Choose your preferred comparison mode
5. Click on a scene (or use arrow keys) to pick the winner
6. Watch your rankings evolve over time!

## How It Works

The plugin uses an ELO-inspired algorithm where:
- Beating a higher-rated scene earns more points than beating a lower-rated one
- Losing to a lower-rated scene costs more points than losing to a higher-rated one
- Ratings are stored in Stash's native `rating100` field (1-100 scale which is why changing to decimal rating system type is recommended)

Filtering:
- The filtered scenes will appear on the left side to be rated, while opponents are drawn from your entire library.


## Requirements

- At least 2 scenes in your library

## License

See [LICENCE](LICENCE) for details.
