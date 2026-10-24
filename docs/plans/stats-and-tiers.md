---
name: Stats tab and battle extras
overview: Part of 3.0 (on elo-mode). Show win chances, a provisional "?" and opt-in tiers on the battle cards; add a Stats tab (ELO distribution, hidden gems, how settled the rankings are) and, from new per-scene totals and small capped lists stored in Stash, records (win/loss, streaks, peak, hall of fame). Top-10 movement, biggest upsets and a full battle log were dropped (Brian, Oct 24).
todos:
  - id: stage1-cards
    content: "Stage 1: battle cards - win chances, provisional '?', tiers (opt-in setting, off by default). Pure functions + tests, no new data."
    status: completed
  - id: stage2-stats-tab
    content: "Stage 2: Stats tab from existing data - overview numbers, ELO distribution, hidden gems / overplayed, how settled + 'battle the least-tested'."
    status: completed
  - id: stage3-records
    content: "Stage 3 (trimmed, Brian Oct 24): per-scene wins/losses/peak/streak fields; hall of fame in the plugin config; record on battle and Explore cards, Explore sorts, Stats Records section."
    status: completed
  - id: stage4-docs
    content: "Stage 4: DOCUMENTATION.md, README, the 3.0.0 CHANGELOG entry, Stats screenshot, forum drafts (no version bump)."
    status: pending
isProject: false
---

<!-- Working plan for the features after 3.0. Written Oct 23, 2026 from the discussion with Brian; nothing is built yet. -->

# Stats tab and battle extras (part of 3.0)

Impact: **Medium-large**. Four stages, with a review point after each one, the same way 3.0 was built.

## Status and where to start

- **Stage 1 is done, reviewed and committed** (Oct 23). Win chances (`winChances` in `elo.ts`), `isProvisional` (`score.ts`), `tierMap` / `tierDescription` (new `stats.ts`), the `showTiers` setting (Settings tab "Scenes" section and yml; on by default). 47 tests pass (67 by the end of Stage 2). "Upset!" shows when the winner's chance was **40% or less** (`UPSET_MAX_CHANCE`, Brian's choice: under 50% would flag about half of all Swiss picks, and 35% never fires with the ±100 Swiss window).
- **Swiss window (Brian, Oct 23, outside this plan):** Swiss now picks a random opponent within **±100 ELO** (`SWISS_OPPONENT_ELO_WINDOW`, `swissOpponentIndexes` in `score.ts`), or the 10 nearest when fewer are in range. The old ±10 ranks meant a median farthest opponent of 20 ELO, about a third of them exact ties. Live: 25 skipped pairs had gaps up to 100, average 40. **Stage 3 note:** with ±100, the "biggest upsets" list would mostly hold 36-40% wins; revisit it then. Checked live: the VS block, "Upset!" on an 8% win, the "?" on the card and the scene page button (scenes 1443/1446 are provisional), the Gold and Diamond pills, and the phone layout (`58% VS 42%` in the pill, emoji-only tier). Both test-pick scenes and the config were restored exactly.
- **After Stage 3 (Oct 24):** Records moved to its own **🏆 Records** tab (`ui/recordsTab.ts`; tab order Battle · Explore · Stats · Records · Settings). On phones ≤480 px the tabs you're not on show only their emoji (≤360 px: every tab), each tab at least 44 × 44 px, names kept as `aria-label` / tooltip. Hall of fame shows the newest 10 with "Show all (N)" (the stored list isn't capped), sorted by the full time each first reached #1 (`mergeHallOfFame`; a save merges with the stored list so two tabs can't drop each other's entries); Records cards play previews on hover. On touch screens, small cards (Explore, Records) follow the battle cards: tapping the thumbnail plays the preview with sound (`handleMiniThumbTap`), and a tap on the playing preview or on the info below opens the scene. **Battle cards on touch** work the same way: the first thumbnail tap previews with sound, a tap on the previewing thumbnail or on the title / details opens the scene, and only **Choose** picks (`bindSceneChoice`; the arrow-key shortcuts press Choose). The touch-only ↗ button (opens the scene in a new tab) stays, as before. **Revised (Oct 24):** on touch a thumbnail tap only plays / stops the preview (battle and small cards; no second-tap-opens, Brian found it confusing); battle cards' details pick them again, the ↗ opens the scene, small cards' details open it. A 🔊/🔇 button at the battle card preview's bottom left shows whether that card's preview is heard and mutes / unmutes just that preview (`toggleCardSound`; unmuting at volume 0 turns the volume back on). Small cards (Explore, Records) have the same button on touch (`handleMiniMuteTap`, over the thumbnail via `.sb-mini-overlay`). On touch a tapped card's sticky `:hover` no longer counts as "active", so a second thumbnail tap mutes again. Phone thumbnails and previews use `object-fit: cover` (no black bars in the 2:1 box). **Undo last pick:** ↶ Undo button (and Backspace; on end screens "↶ Undo last pick") takes back the last pick: `takePickSnapshot` before each pick, `restoreElo` writes both scenes' fields back (removing record fields a first battle created) after `eloWritesSettled`, `keepOnlyHallOfFame` drops a #1 it added, Champion / Placement run state and the pair come back; the next-pair timer is cancelled. One level; setup / Reset ELO clear it. Checked live in all three modes (Swiss during and after the animation, Champion streak, Placement mid-run and after landing). Battle cards on tablets / phones / short screens show the record in the rating line ("50/100 · 0–0"). **Top-bar Battle icon:** below 1200 px (while Stash folds its links into ☰) a swords button sits in the navbar's buttons after TCode / SFW Switch (DOM, re-placed by a MutationObserver; `MainNavBar.UtilityItems` is hidden there), same pages as the menu link; it hides itself when it would wrap the bar onto a second row (`fitNavIcon`: shown at 393 px and 768 px, hidden at 375 px).
- **Stage 3 (trimmed) is done, reviewed and committed** (Oct 24). Record fields join the ELO's field group (`EloFields.record`, `sceneRecord` / `recordAfter` / `recordText` in `score.ts`), written by `writeElo(scene, elo, battles, results)` in the same request; Placement runs keep `results` and add them on landing; setup and Reset ELO `remove` the record fields and empty the hall of fame. `mergeConfig` (settings.ts) keeps keys that aren't settings and drops `REMOVED_KEYS`; config writes are queued. Hall of fame: `statsHallOfFame` (JSON string), `noteTopScene()` after each ELO write and when Stats opens. Display: "Record: 12–5" on battle cards (scenes with only pre-record battles keep "Battles: N"), "12–5" on small cards, Explore sorts Best record / Highest peak ELO / Longest win streak, Stats → Records (hall of fame, top 5 streaks, top 5 peaks) under "How settled". 77 tests. Live: 3 Swiss picks and a 7-pick Placement wrote one request per scene with the right records; hall of fame and config keys checked; everything restored exactly (7 scenes, config identical). The Stage 2 review session's fixes were committed separately first (`de5a05d`).
- **Stage 2 is done, reviewed and committed** (Oct 24), together with the Explore tab and the feedback rounds below. `ui/statsTab.ts` (📊 Stats tab, third after Battle and Settings, filled from the all-scenes cache each time it opens); maths in `stats.ts` (`overview`, `eloHistogram`, `largestTie`, `ratingScaleTicks`, `gemsSplit` / `gemsQuadrant` at the median ELO and play count, `settledBuckets` by real battles 0 / 1-9 / 10-29 / 30+, `leastTested`). "Battle the least-tested" sets `state.leastTested`: Swiss takes the fewest-battled scene on the left (random among equals, never the one just shown) until Stop, a mode change or closing. 58 tests. Checked live with no writes: all sections, a dot click and "Battle this scene", least-tested (5 skips, all 0-battle scenes on the left), Stop, and 375 px.
- **Explore tab and Stage 2 feedback (Brian, Oct 24, committed).** Goal from Brian: the tabs should help you *explore and navigate* your ELO library, not only show fun stats. So:
  - New **🔎 Explore** tab (tab order Battle · Explore · Stats · Settings): the library as small cards (thumbnail, tier pill and border, `ELO 1820 · #97`, plays and battles), with search (title, studio, performers), tier / Provisional / Unrated chips, an ELO range and six sorts. Clicking a card opens the scene page (`handleSceneLinkClick`, so the new-tab setting applies); its ⚔️ button battles it. Pages of 60 cards load as the modal scrolls (a scroll listener: the browser pane delivered no IntersectionObserver callbacks). Maths in `src/explore.ts` (tested); UI in `ui/exploreTab.ts` and `ui/miniCard.ts`.
  - **Stats:** clicking a histogram bar opens Explore at that 25-ELO range; hovering a hidden gems dot shows the scene's small card, and clicking a dot opens the scene page (the clicked-dot panel and its "Battle this scene" button are gone). The Stats click handler was being added again on every tab open; it is now bound once.
  - **Tiers:** more vivid colours, checked with the dataviz palette validator (all pairs pass the colour-blind, normal-vision and contrast checks): Legendary #ff5277, Diamond #3d9bff, Platinum #2ee0c0, Gold #ffd23f, Silver #8f99a5, Bronze #c46a2b. Tiered cards (battle and small) have a 3px border.
  - **Phones ≤480 px:** the volume slider hides (the speaker still mutes), so four tabs fit.
  - **Feedback round (Oct 24):** the tier pill always shows (battle cards, scene page, Explore, hover cards); the setting is now `tierBorders` ("Tier colours on card borders", off by default) and colours only the **battle** cards' borders, while Explore and hover cards always have tier borders. Borders back to 2px. Small-card thumbnails carry their own top corners (Pitfall 13). SFW Switch `pwr-*` classes on small cards and their previews. Mode tooltip z-index 200 (above the cards' 101 border layer). Explore: real pages of 60 (‹ / page dropdown / ›, top and bottom) instead of endless scrolling, muted hover previews (one at a time), ELO and rank on the right edge, taller inputs, `scrollbar-gutter: stable` while Explore shows. Stats: "How settled" first, least-tested explained (fewest real battles, the seeded head start doesn't count), hover cards placed beside the pointer inside the chart. **Scene page:** the tier joins the subheader, `60 fps | 4K | 🔷 Platinum` (none for provisional or unrated scenes).
  - **Feedback round 2 (Oct 24):** tier border colours (`tierBorders`) **on by default**, 2px. Small-card ELO back next to the pill (not pushed right). Scene page: the subheader tier is gone; the ELO button's icon is the tier emoji (swords for provisional / unrated). iPhone cut-off fixed: the tab bar could widen the modal (`flex-wrap: nowrap` tabs); the tabs now shrink and scroll sideways instead. Explore: `explorePageSize` setting (30 / 60 / 120 / 240 / All, saved in the plugin config, not in the yml), card clicks ignored for 700 ms after a page change (a quick second click on Next landed on a card), only the bottom pager scrolls back up, previews play at the preview volume. Stats: "How settled" under Overview; least-tested picks **rated** scenes only (unrated ones are left to Placement) and the text says what it counts and how many scenes are in the pool (`leastTestedPool`). Touch: tapping a hidden gems dot pins its card (link + ⚔️). **Battle an Explore filter** ("Battle these N scenes" / "📍 Place these N scenes", `state.explorePool`): Unrated → Placement against the whole library; Provisional → Swiss against the whole library; any other filter → Swiss within the filter. It replaces the Scenes page filter (`currentFilters()` in `pairs.ts`), is recomputed on every pick (placed scenes leave an Unrated pool; the shuffle now skips scenes that left the pool), shows in the pool line with Stop, survives mode changes and ends on Stop or close. Big-card corner aliasing left as is (Brian: leave it unless easy; the card clips at its outer edge, so the border can't be extended past it without restructuring).
  - **Feedback round 3 (Oct 24):** card borders (battle and small) are now a **2px box-shadow ring just outside the card** (`0 0 0 2px var(--sb-card-border)`), replacing the `::after` layer: the content clip's anti-aliasing and the ring's meet on the same curve, so no background shows at the corners, and a playing video (GPU layer) can't cover a ring outside the card box. **Stage 4: update DOCUMENTATION "Card border and corners" and Pitfall 13.** Hover: no blue border on tiered cards (blue is Diamond), only on untiered battle cards; the hover glow is a neutral shadow. Phone VS pill centred. Least-tested includes unrated scenes again; the button reads "Battle the least-tested (559 scenes)" with a one-line description. Battled Explore filters and least-tested **survive closing Stash Battle** (until Stop). Provisional button: "🔁 Keep testing these N scenes". Touch: pinned cards no longer close on the tap's `pointerleave`; a tapped histogram bar pins "ELO 1600–1649: 55 scenes" with a "🔎 See them in Explore" button; charts under 500 px use 50-ELO bars. Scene page tier emoji centred in a fixed box. Phones ≤480 px: a "Preview volume" slider row in Settings (the tab bar keeps the mute button).
  - **Feedback round 4 (Oct 24):** the box-shadow ring **reverted** (it brought back the inner-corner aliasing of Pitfall 13); borders are the `::after` layer again, so **DOCUMENTATION needs no border change, but Pitfalls should note the ring was tried and why it failed**. The ring had fixed the mobile video bleed, so preview videos (battle and small cards) now sit 2px inside the card's top and sides with matching inner corners: a hardware-drawn video can paint above the border layer, but no longer reaches it. Hover never changes the border colour. Explore from a histogram bar opens at the top. Least-tested text spells out its count ("557 scenes have no battles yet: 461 with an ELO … and 96 unrated"); `leastTestedPool` also returns `unrated`. **Battling a filter now follows "Use filtered scenes for both sides"** (`filterBattlesWithin(filters, bothSides)`, read each pick via `explorePoolWithin()`): off = the filter's scenes vs your whole library, on = within the filter; Unrated always vs the library (placing among unrated scenes would land them all at 1500). A battled Explore filter overrides the Scenes page filter until Stop. Phones: the modal's sideways scroll is pinned to 0 (focus / scroll-into-view could shift an `overflow-x: hidden` box), and charts clip to their own box.
  - **Feedback round 5 (Oct 24):** the preview video inset is **reverted** (thumbnails showed around the videos); battle-card video CSS is back to the committed version, so the original mobile video-over-border bleed is accepted as it was. Least-tested text no longer mentions the head start. Explore from a histogram bar scrolls so the scene-count line sits just above the first row. **Scene page on phones (≤576 px):** the ELO button leads the subheader line ("🔷 ELO 1960 · #41 · date · 60 fps | 4K") instead of the toolbar, which had made the page scroll sideways (the real cause of the "cut-off" Brian saw); it moves back to the toolbar on wider screens (matchMedia listener).
  - **Feedback round 6 (Oct 24):** small-card thumbnails start 1px inside the card (under the 2px border, 9px corners): cropped (`object-fit: cover`) pictures let a faint line through the double-anti-aliased edge, visible only under the dark grey border of unrated / provisional cards. Explore's status line is a wrapping flex row, so "Battle these" sits on its own line at the left on phones. Small-card previews are shared (`startMiniPreview` / `stopMiniPreview` in `ui/miniCard.ts`, one at a time): Explore uses them, and any tab change stops a playing preview. (Hidden gems cards played previews briefly; Brian preferred thumbnails, so they were taken out.) While a small card's preview plays, its thumbnail is hidden (a sub-pixel gap at the video's bottom edge showed a line of it).
  - Known, not new: battling a scene that shares its ELO with others (from Explore or its scene page) moves it to the end of its tie group, so its rank can change within the tie (#5 showed as #13).
- This plan was written on Oct 23, 2026, right after 3.0 was finished.
- **3.0 state:** branch `elo-mode`, open as [PR #7](https://github.com/dtt-git/stash-battle/pull/7) into `main`. Latest commit `a4d6250`. Brian is using 3.0 himself before releasing it.
- **Where it goes (Brian, Oct 23):** straight onto `elo-mode`, into PR #7 and **version 3.0.0**. No new branch and no 3.1 version bump.
- **Read first:** [true-elo-handoff.md](true-elo-handoff.md) (how Brian works, environment, git rules) and [true-elo-mode.md](true-elo-mode.md) (how ELO works). Both are still accurate; the "Working notes" section below adds what changed since.

## Decisions (Brian, Oct 23)

- **Wanted, on the battle cards:**
  - **Win chances**, like a chess broadcast's "who's favoured" bar.
  - **A provisional "?"** after the ELO of scenes that haven't settled yet (`ELO 1540?`).
  - **Tiers**, as a setting. First built off by default; after trying them Brian made them **on by default** (Oct 23: "it should be the intended experience"), with squarer corners (6px) and more padding. Game-style names, **not chess titles** ("sounds a bit weird"). Proposed ladder below.
- **Wanted, in a new Stats tab:**
  - **Hidden gems / overplayed:** ELO against play count.
  - **ELO distribution**, with the Stash rating scale under it.
  - **How settled the rankings are** (battle counts), with a way to battle the least-tested scenes. Brian likes this one "a lot".
  - **Records:** win/loss and longest win streak per scene, peak ELO, a hall of fame of scenes that were ever #1. (Top 10 with ▲▼ movement and biggest upsets were dropped on Oct 24.)
- **Not wanted:**
  - Averages by performer, tag or studio. Brian doesn't use them; other people might, but leave it out for now.
  - The "stars disagree with ELO" list.
- **Storage: in Stash, not the browser.** Brian closes his browsers, so anything kept only in IndexedDB or localStorage would be lost. Keep it small (see "New data").
- **Deferred:**
  - ~~A full battle log~~ (rating graphs, head-to-head): **dropped** on Oct 24, too much tracking for what it gives.
  - **Glicko** (ratings with their own uncertainty, like lichess). A change to the rating maths, so its own project.

## Design

### 1. Win chances (Stage 1)

- `eloExpected(elo, opponentElo)` in [src/elo.ts](../../src/elo.ts) already gives the chance the first side wins. Use the same ELO the pick will use: `battleElo` in `ui/mainUI.ts` (unrated = 1500 in Swiss, `CHAMPION_UNRATED_ELO` in Champion).
- Show it between the cards, at the VS: a thin two-colour bar with `68%` and `32%` on either side. On phones (cards stacked) a single line under VS.
- Round so the two always add up to 100.
- **Upset:** when the pick goes to a side that had under 50%, the result animation can say "Upset!". Keep it subtle (no glow, Brian dislikes glows).
- **Placement:** hidden (Brian, Oct 23). The placed scene's ELO doesn't change per pick, and an unrated placed scene has no real ELO.

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

### 5. Records (Stage 3, trimmed)

**Scope (Brian, Oct 24):** keep it simple, nothing that needs heavier tracking. **Dropped:** top-10 movement (daily snapshots), biggest upsets, and the full battle log (scene-vs-scene history, rating graphs, head-to-head) for good. No server-side scripts.

**Per-scene totals: new custom fields**, written in the **same** `partial` update as the ELO (no extra request):

| Field | Meaning |
|---|---|
| `stash_battle_wins` | picks won (Swiss, Champion, and each Placement pick) |
| `stash_battle_losses` | picks lost |
| `stash_battle_peak` | highest ELO reached |
| `stash_battle_streak` | current win streak (needed to know the best one) |
| `stash_battle_best_streak` | longest win streak |

- Stash returns every custom field with every scene, so per-scene data stays at these few numbers.
- Placement: the run already counts its picks; also count wins and losses, and add them when the scene lands. Its opponents don't change (as now).
- Battles from before these fields have no win/loss (only Brian's library, 3.0 is unreleased): keep `stash_battle_battles` as the total.
- `peak` starts at the current ELO the first time it's written.
- Add the keys to `ELO_FIELD_KEYS` (Reset ELO and `clearElo` remove them) and the write helpers. Custom Fields CSS: `stash_battle_best_streak` is 24 characters; widen the 22ch rule.

**Hall of fame: one list in the plugin config** (`statsHallOfFame`, a JSON string): every scene that has ever been #1, with the date it first got there (a handful of entries).

- **Required change first:** `normalize()` only returns keys it knows and `persistSettings` rebuilds the map from it, so this key would be dropped by the next settings save. Make `persistSettings` keep keys it doesn't know. Test it.
- Checked after each ELO write: is the scene now #1 in the all-scenes cache?

**Where records show (Brian, Oct 24):**
- **Battle cards:** the "Battles: 17" line becomes "Record: 12–5".
- **Explore:** "12–5" in the small card's bottom line, and sorts "Best record", "Highest peak", "Longest win streak".
- **Stats:** a Records section with the hall of fame, and the top 5 by best win streak and by peak ELO.
- Not on the scene page tooltip.

### Separate project: Glicko

Ratings with an uncertainty that shrinks as a scene battles (`1740 ± 80`), as on lichess: settled scenes barely move, new ones move fast, and matchmaking can target the scenes it's least sure of. Would replace the fixed K tiers. Not part of this plan.

## Stages (review point after each)

1. **Battle cards:** win chances (with "Upset!"), provisional "?" on cards and the scene page button, tiers behind the new setting. Pure functions in `elo.ts` / `score.ts` / `stats.ts`, unit-tested. No new stored data.
2. **Stats tab from existing data:** tab shell, overview, ELO distribution, hidden gems / overplayed (with Battle this scene), how settled (with Battle the least-tested).
3. **Records (trimmed):** `persistSettings` keeps unknown keys; per-scene wins / losses / peak / streak fields; hall of fame; record on battle and Explore cards, Explore sorts, Stats Records section.
4. **Docs:** DOCUMENTATION.md, README (features, a Stats screenshot), the existing CHANGELOG `v3.0.0` entry, the forum drafts in `docs/forum/`. The version stays 3.0.0.

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
  - hall of fame: one entry per scene, first date kept;
  - `persistSettings` keeps keys it doesn't know.
- **Live:**
  - Stages 1-2 are read-only except the picks needed to see "Upset!" and the least-tested flow; snapshot and restore any scenes those picks write (the 3.0 `sbFieldsSnapshot` pattern: save `custom_fields` and `rating100` for the touched scenes, restore exactly, compare).
  - Stage 3 writes the new fields and the plugin config: snapshot the plugin config and the touched scenes first, restore after, and report what was written.

## Open questions for Brian

- Tier names, emoji and cutoffs: kept as proposed so far (no change asked for).
- Answered: "Battle the least-tested" works as proposed (Brian likes it); the record line goes on the battle and Explore cards; the battle log is dropped.

## Working notes (things learned since the 3.0 handoff)

- **Git push** (what actually works): `git -c credential.helper= -c 'credential.helper=!f() { test "$1" = get || exit 0; echo username=dtt-git; echo "password=$(gh auth token -u dtt-git)"; }; f' push`. Run gh as `GH_TOKEN=$(gh auth token -u dtt-git) gh ...`. Commit only as `dtt <dark7882009@hotmail.com>`. Push only when Brian asks.
- **Privacy guard for screenshots:** also hide the page behind the modal (`#root { visibility: hidden }`), and reinstall the guard after every reload. For a read-only screenshot of a state that would normally need a write, patch `window.fetch` in the page to refuse every `mutation` (and, if needed, alter what a query returns); a reload removes the patch.
- **Screenshots:** the browser tool captures at about 800 px wide, so README shots use an emulated 1040×960 window, cropped to 764 px with PIL. The capture is saved under the session's `tool-results` folder; copy it out before cropping. Frames can be stale right after a change: wait a second and capture again. If the pane is hidden, captures are blank (the page reports 0 width): ask Brian to show the browser pane.
- **Hidden pane:** `requestAnimationFrame` doesn't run in a background tab; use timers for anything that must run while the pane is hidden (the scene page button learned this).
- **Line endings:** some files are CRLF on disk (e.g. `sceneActions.ts`); a Python find-and-replace with LF strings won't match them. Use the Edit tool, or normalise first.
- **Stash v0.31.1 custom-field filters can't compare numbers** (DOCUMENTATION Common Pitfalls #19): anything ranked or counted by ELO has to be worked out in Stash Battle, from the all-scenes cache.
- **Since the 3.0 handoff:** code review fixes (`b0bacb6`); scene page ELO button in the toolbar, Straight-line listed before Percentile, wider Custom Fields names (`87d6086`); new setup screenshot (`f8a65b4`); end-screen Stash rating, stuck-Placement fix, cache written back to IndexedDB and restored pairs refreshed from Stash (`a4d6250`). DOCUMENTATION.md describes all of it.
- **Forum drafts:** `docs/forum/update-3.0.md` and `op-3.0.md` are uncommitted on purpose; Brian posts them himself.
