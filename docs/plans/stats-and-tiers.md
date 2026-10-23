---
name: Stats tab and battle extras
overview: After 3.0. Show win chances, a provisional "?" and opt-in tiers on the battle cards; add a Stats tab (ELO distribution, hidden gems, how settled the rankings are) and, from new per-scene totals and small capped lists stored in Stash, records (win/loss, streaks, peak, hall of fame, top 10 with movement, biggest upsets). A full battle log (rating graphs, head-to-head) is deferred.
todos:
  - id: stage1-cards
    content: "Stage 1: battle cards - win chances, provisional '?', tiers (opt-in setting, off by default). Pure functions + tests, no new data."
    status: pending
  - id: stage2-stats-tab
    content: "Stage 2: Stats tab from existing data - overview numbers, ELO distribution, hidden gems / overplayed, how settled + 'battle the least-tested'."
    status: pending
  - id: stage3-records
    content: "Stage 3: new data in Stash - per-scene wins/losses/peak/streaks, capped lists in the plugin config (hall of fame, daily top-10 snapshots, biggest upsets); Records section."
    status: pending
  - id: stage4-docs
    content: "Stage 4: DOCUMENTATION.md, README, CHANGELOG, version 3.1.0, Stats screenshot, forum post."
    status: pending
isProject: false
---

<!-- Working plan for the features after 3.0. Written Oct 23, 2026 from the discussion with Brian; nothing is built yet. -->

# Stats tab and battle extras (3.1)

Impact: **Medium-large**. Four stages, with a review point after each one, the same way 3.0 was built.

## Status and where to start

- **Nothing is built yet.** This plan was written on Oct 23, 2026, right after 3.0 was finished.
- **3.0 state:** branch `elo-mode`, open as [PR #7](https://github.com/dtt-git/stash-battle/pull/7) into `main`. Latest commit `a4d6250`. Brian is using 3.0 himself before releasing it.
- **Where to branch:** if PR #7 has been merged, branch from `main`; if not, branch from the tip of `elo-mode`. Ask Brian which, and the branch name, before starting.
- **Read first:** [true-elo-handoff.md](true-elo-handoff.md) (how Brian works, environment, git rules) and [true-elo-mode.md](true-elo-mode.md) (how ELO works). Both are still accurate; the "Working notes" section below adds what changed since.

## Decisions (Brian, Oct 23)

- **Wanted, on the battle cards:**
  - **Win chances**, like a chess broadcast's "who's favoured" bar.
  - **A provisional "?"** after the ELO of scenes that haven't settled yet (`ELO 1540?`).
  - **Tiers**, **opt-in** (a setting, off by default) until Brian decides whether he likes them. Game-style names, **not chess titles** ("sounds a bit weird"). Proposed ladder below.
- **Wanted, in a new Stats tab:**
  - **Hidden gems / overplayed:** ELO against play count.
  - **ELO distribution**, with the Stash rating scale under it.
  - **How settled the rankings are** (battle counts), with a way to battle the least-tested scenes. Brian likes this one "a lot".
  - **Records:** win/loss and longest win streak per scene, peak ELO, a hall of fame of scenes that were ever #1, the top 10 with ▲▼ movement, the biggest upsets.
- **Not wanted:**
  - Averages by performer, tag or studio. Brian doesn't use them; other people might, but leave it out for now.
  - The "stars disagree with ELO" list.
- **Storage: in Stash, not the browser.** Brian closes his browsers, so anything kept only in IndexedDB or localStorage would be lost. Keep it small (see "New data").
- **Deferred:**
  - **A full battle log** (needed only for rating graphs per scene and head-to-head records). Its storage needs a separate decision, see "Later".
  - **Glicko** (ratings with their own uncertainty, like lichess). A change to the rating maths, so its own project.

## Design

### 1. Win chances (Stage 1)

- `eloExpected(elo, opponentElo)` in [src/elo.ts](../../src/elo.ts) already gives the chance the first side wins. Use the same ELO the pick will use: `battleElo` in `ui/mainUI.ts` (unrated = 1500 in Swiss, `CHAMPION_UNRATED_ELO` in Champion).
- Show it between the cards, at the VS: a thin two-colour bar with `68%` and `32%` on either side. On phones (cards stacked) a single line under VS.
- Round so the two always add up to 100.
- **Upset:** when the pick goes to a side that had under 50%, the result animation can say "Upset!". Keep it subtle (no glow, Brian dislikes glows).
- **Placement:** open question. The placed scene's ELO doesn't change per pick, and an unrated placed scene has no real ELO, so hide win chances in Placement unless Brian wants them.

### 2. Provisional "?" (Stage 1)

- A scene is **provisional** while `kGames(scene)` is below the first K tier's limit (10). That's exactly the "ELO moves by up to 40" stage, so the "?" and the big ELO swings start and stop together.
- Seeded scenes ("Use my ratings") start with the 10-battle head start, so they're never provisional. Their star rating already said something, which is the same reasoning as the head start.
- Card badge: `ELO 1540? · #212`, tooltip "Provisional: fewer than 10 battles, so this ELO is still settling". Also on the scene page button.
- Derive the threshold from `ELO_K_TIERS`, not a second constant, so retuning K moves both.

### 3. Tiers (Stage 1, opt-in)

- New setting `showTiers` (boolean, **default off**): Settings tab and `stash-battle.yml`, "Show tiers on cards".
- Assigned by **percentile among rated, non-provisional scenes**, so every tier always has scenes in it, whatever the library's ELO spread:

  | Tier | Who |
  |---|---|
  | 👑 Legendary | top 1% |
  | 💎 Diamond | top 5% |
  | 🔷 Platinum | top 15% |
  | 🥇 Gold | top 35% |
  | 🥈 Silver | top 65% |
  | 🥉 Bronze | the rest |

  - Ties share a tier (use the same middle-of-tie position as `percentileRatings`).
  - Provisional and unrated scenes get no tier, like "unranked until placement matches are done" in ranked games.
  - Names, emoji and cutoffs are a proposal; Brian decides at the Stage 1 review. Keep them in one table in `constants.ts`.
- Shown as a small pill on the card next to the ELO badge, and in the scene page button's tooltip.

### 4. Stats tab (Stage 2)

- A third tab, **📊 Stats**, after Battle and Settings (`TabId` in `ui/settingsPanel.ts` becomes `"battle" | "settings" | "stats"`). New module `ui/statsTab.ts`; pure maths in a new `src/stats.ts` (tested).
- **Data:** Stash Battle's all-scenes cache (`getAllScenesCached`), already sorted by ELO, with ELO, battles, play count, Stash rating, duration and date. No extra requests in Stage 2. Recompute when the tab opens.
- **Charts:** hand-drawn SVG, no chart library (keeps the bundle small). Dark theme, colours from the existing CSS, no glows.
- **Privacy:** no thumbnails in the charts. Titles only on hover or click (screenshots for the README need placeholder titles, see "Working notes").
- **Sections, top to bottom:**
  1. **Overview:** scenes with an ELO, unrated scenes, provisional scenes, total battles (sum of `stash_battle_battles`).
  2. **ELO distribution:** histogram in 25-ELO buckets. Under it, the Stash rating scale for the current update mode: Straight-line ticks (1010 = 1, 1500 = 50, 2000 = 100) with the clamped zones beyond 1010 and 2000 shaded, or Percentile ticks. A note like "142 scenes still tied at 1500" when a big tie exists.
  3. **Hidden gems / overplayed:** scatter, ELO up, play count across (square-root scale so a few heavily played scenes don't squash the rest). Quadrant labels: top-left "Hidden gems" (high ELO, rarely played), bottom-right "Overplayed". Clicking a dot shows the title, ELO, rank and plays, with **Battle this scene** (switches to the Battle tab and calls `loadNewPair(sceneId)`, like opening from a scene page).
  4. **How settled:** bars for 0, 1-9, 10-29 and 30+ battles (the K tiers), "212 scenes are still provisional", and a **Battle the least-tested** button.
     - Behaviour (open question, proposal): starts Swiss with the left side taken in order of fewest battles (random among equals) instead of the shuffle, until the mode changes, Stash Battle closes, or every provisional scene has had a battle. A note above the cards says it's on, with a "Stop" link.

### 5. New data (Stage 3)

All of it in Stash, all of it small.

**Per-scene totals: new custom fields**, written in the **same** `partial` update as the ELO (no extra request):

| Field | Meaning |
|---|---|
| `stash_battle_wins` | picks won (Swiss, Champion, and each Placement pick) |
| `stash_battle_losses` | picks lost |
| `stash_battle_peak` | highest ELO reached |
| `stash_battle_streak` | current win streak |
| `stash_battle_best_streak` | longest win streak |

- **Why these and not a history:** Stash returns *all* of a scene's custom fields with every scene, and the GraphQL field is a map with no way to pick keys. So anything per scene rides along on every library download, Stash Battle's and Stash's own. Five numbers are fine; a history per scene would roughly double the full-library download.
- Placement: the run already counts its picks (`run.battles`, `run.streak`); also count wins and losses, and add them when the scene lands. The opponents of a Placement run don't change (as now).
- Battles from before 3.1 have no win/loss: show "since 3.1" in the UI, and keep `stash_battle_battles` as the total.
- `peak` starts at the current ELO the first time it's written.
- Add the new keys to `ELO_FIELD_KEYS` (so Reset ELO and `clearElo` remove them), to `eloCustomFields` / `withEloFields`, and to `EloFields` (or a separate `RecordFields`, decide while building).
- Custom Fields CSS: `stash_battle_best_streak` is 24 characters; widen the 22ch rule.

**Capped lists: Stash Battle's plugin config** (`configuration.plugins["stash-battle"]`), each stored as a JSON string, each with a fixed maximum size:

| Key | Holds | Cap |
|---|---|---|
| `statsHallOfFame` | scenes that were ever #1, with the date they first got there | one entry per scene that ever reaches #1 (a handful) |
| `statsTopSnapshots` | the top 10 scene ids, once a day (taken on the first open each day) | last 8 days |
| `statsUpsets` | the biggest upsets: winner, loser, their ELOs, the winner's chance, date | top 20 by how unlikely the result was (lowest chance first) |

- **Required change first:** `normalize()` in `settings.ts` only returns keys it knows, and `persistSettings` rebuilds the map from it, so these keys would be dropped by the next settings save. Make `persistSettings` start from the **raw stored map** (keeping keys it doesn't know) and only overwrite this tab's unsaved keys. Test it.
- The plugin config is sent to Stash's own pages too, so the caps matter. Rough size of all three: a few KB.
- **Top 10 movement:** compare today's top 10 with the snapshot from 7 days ago (or the oldest kept): ▲3, ▼1, NEW.
- **Hall of fame:** after each ELO write, check whether the scene is now #1 in the all-scenes cache.
- **Upsets:** Swiss and Champion picks only (a Placement pick doesn't move ELO, and an unrated placed scene has no real ELO).
- **Records section** in the Stats tab: hall of fame, top 10 with movement, biggest upsets, best win streaks, best records (min. battles). On the cards: maybe `Record: 12–5` in the meta lines (open question).

### Later: full battle log

Only the **rating graph per scene** (with its peak) and **head-to-head records** ("3–1") need every battle stored.

- About 60 bytes a battle, so 10,000 battles ≈ 600 KB.
- Not per scene (rides along on every download) and not in the plugin config (sent to every Stash page).
- **Best candidate:** one dedicated Stash item, e.g. a single group "Stash Battle data", holding the log in its custom fields in chunks. It downloads only when the Stats tab needs it, it's in Stash's own backups, and every device sees it. The catch: that item shows up in the library.
- Alternative: a server-side plugin task writing a file. Needs Python on the Stash machine, and a plugin update could wipe the folder.
- Decide with Brian after Stage 3.

### Separate project: Glicko

Ratings with an uncertainty that shrinks as a scene battles (`1740 ± 80`), as on lichess: settled scenes barely move, new ones move fast, and matchmaking can target the scenes it's least sure of. Would replace the fixed K tiers. Not part of this plan.

## Stages (review point after each)

1. **Battle cards:** win chances (with "Upset!"), provisional "?" on cards and the scene page button, tiers behind the new setting. Pure functions in `elo.ts` / `score.ts` / `stats.ts`, unit-tested. No new stored data.
2. **Stats tab from existing data:** tab shell, overview, ELO distribution, hidden gems / overplayed (with Battle this scene), how settled (with Battle the least-tested).
3. **Records:** `persistSettings` keeps unknown keys; per-scene wins / losses / peak / streak fields; hall of fame, daily top-10 snapshots, biggest upsets; Records section; card record line if Brian wants it.
4. **Docs and release:** DOCUMENTATION.md, README (features, a Stats screenshot), CHANGELOG `v3.1.0`, version bump in `package.json` and the yml, forum update draft.

## Review checkpoints (after every stage)

Same as 3.0 (see the handoff):

1. `npm run typecheck` and `npm test` pass.
2. Deploy with `node scripts/build.mjs --dev`, then reload Stash (F5).
3. Browser checks on `http://localhost:9999/`, with screenshots under the privacy guard.
4. Report and **stop** until Brian has tried it and says go.

## Testing

- **Unit (pure functions):**
  - win chances round to a pair that adds to 100, and match `eloExpected`;
  - provisional threshold follows `ELO_K_TIERS`; seeded scenes are never provisional;
  - tier assignment by percentile, with ties sharing a tier, provisional and unrated excluded, tiny libraries (1, 2, 10 scenes);
  - histogram buckets, sqrt scale, quadrant split;
  - least-tested ordering;
  - win/loss, peak, streak and best streak updates, including Placement adding a run's picks when it lands, and Reset ELO clearing them;
  - upsets list: ranking, cap of 20, no duplicates;
  - top-10 snapshots: one per day, last 8 kept, ▲▼/NEW computed against 7 days back;
  - hall of fame: one entry per scene, first date kept;
  - `persistSettings` keeps keys it doesn't know.
- **Live:**
  - Stages 1-2 are read-only except the picks needed to see "Upset!" and the least-tested flow; snapshot and restore any scenes those picks write (the 3.0 `sbFieldsSnapshot` pattern: save `custom_fields` and `rating100` for the touched scenes, restore exactly, compare).
  - Stage 3 writes the new fields and the plugin config: snapshot the plugin config and the touched scenes first, restore after, and report what was written.

## Open questions for Brian

- Win chances in Placement: hide (proposed) or show?
- Tier names, emoji and cutoffs: is the proposed ladder right?
- "Battle the least-tested": the proposed behaviour (Swiss with the least-battled scenes on the left until stopped), or something else?
- A `Record: 12–5` line on the cards?
- Later: where the full battle log lives.

## Working notes (things learned since the 3.0 handoff)

- **Git push** (what actually works): `git -c credential.helper= -c 'credential.helper=!f() { test "$1" = get || exit 0; echo username=dtt-git; echo "password=$(gh auth token -u dtt-git)"; }; f' push`. Run gh as `GH_TOKEN=$(gh auth token -u dtt-git) gh ...`. Commit only as `dtt <dark7882009@hotmail.com>`. Push only when Brian asks.
- **Privacy guard for screenshots:** also hide the page behind the modal (`#root { visibility: hidden }`), and reinstall the guard after every reload. For a read-only screenshot of a state that would normally need a write, patch `window.fetch` in the page to refuse every `mutation` (and, if needed, alter what a query returns); a reload removes the patch.
- **Screenshots:** the browser tool captures at about 800 px wide, so README shots use an emulated 1040×960 window, cropped to 764 px with PIL. The capture is saved under the session's `tool-results` folder; copy it out before cropping. Frames can be stale right after a change: wait a second and capture again. If the pane is hidden, captures are blank (the page reports 0 width): ask Brian to show the browser pane.
- **Hidden pane:** `requestAnimationFrame` doesn't run in a background tab; use timers for anything that must run while the pane is hidden (the scene page button learned this).
- **Line endings:** some files are CRLF on disk (e.g. `sceneActions.ts`); a Python find-and-replace with LF strings won't match them. Use the Edit tool, or normalise first.
- **Stash v0.31.1 custom-field filters can't compare numbers** (DOCUMENTATION Common Pitfalls #19): anything ranked or counted by ELO has to be worked out in Stash Battle, from the all-scenes cache.
- **Since the 3.0 handoff:** code review fixes (`b0bacb6`); scene page ELO button in the toolbar, Straight-line listed before Percentile, wider Custom Fields names (`87d6086`); new setup screenshot (`f8a65b4`); end-screen Stash rating, stuck-Placement fix, cache written back to IndexedDB and restored pairs refreshed from Stash (`a4d6250`). DOCUMENTATION.md describes all of it.
- **Forum drafts:** `docs/forum/update-3.0.md` and `op-3.0.md` are uncommitted on purpose; Brian posts them himself.
