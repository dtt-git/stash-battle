# Changelog

## v3.0.0

A new rating system: Stash Battle now keeps a true ELO score for every scene, separate from your star ratings. And new tabs to explore it: browse your library by ELO and tier, see stats on your rankings, and keep records.

### ⚠️ Before you update

- **Requires Stash v0.31.0 or newer.** ELO is stored in scene custom fields, which Stash added in v0.31.0. On an older Stash, Stash Battle shows a message instead of loading.
- **Stash Battle no longer changes your Stash star ratings by default.** Every battle still updates rankings, but in Stash Battle's own ELO score. If you want your star ratings to keep following your rankings, set **Settings → Stash ratings update mode** to Straight-line or Percentile, either in the setup screen or later in Settings. **Straight-line with "Use my ratings" is closest to how 2.x worked.**
- **Take a Stash backup first** (Settings → Tasks → Backup), especially if you turn on a Stash ratings update mode, which rewrites ratings.

### New

- **True ELO** 📈: every scene gets an uncapped ELO score (the same idea chess uses), saved in its custom fields (`stash_battle_elo`, `stash_battle_battles`, `stash_battle_seeded`). Scenes are no longer squeezed into 1-100, so your favourites can keep pulling ahead instead of piling up at 100.
- **One-time ELO setup**: the first time you open Stash Battle, choose how ELO starts:
  - **Use my ratings**: every rated scene starts from its star rating, so your existing order carries over (50 stars = 1500 ELO, 10 ELO per rating point).
  - **Start everyone at 1500**: every scene starts equal.
  
  A live 10-scene preview shows what each choice does, and how many of your ratings would change, before anything is written.
- **Stash ratings update mode** (Settings): Don't update (the default), **Straight-line** (rating = ELO converted back, 1500 = 50), or **Percentile** (rating = percentile in your library: the top scene is 100, the bottom 1). Switching tells you exactly how many ratings will change. While it's on, each battle writes only the ratings that changed, in one go, and Stash's own pages show the new ratings without a refresh.
- The **Placement and Champion end screens** show where the scene's Stash rating ended up, while a Stash ratings update mode is on.
- **Reset ELO** (Settings): start every scene's ELO over, with the same choices as the setup. Cancel any time before pressing Start.
- **Placement → Start from the bottom** (a setting): a scene ignores its current ELO and climbs from your lowest scene, jumping further with each win, with a win streak badge and a Champion screen if it never loses. **This replaces Gauntlet**, with much shorter runs (about 8-21 battles in a 600-scene library).
- **Cards** show each scene's ELO and rank (`ELO 1740 · #50`), its record (`Record: 12–5`), and its Stash rating.
- **Win chances** 📊 at the VS between the cards (`68%` VS `32%`), from the two scenes' ELO. A pick that wins with 40% or less says **Upset!** Hidden in Placement, where the placed scene's ELO doesn't change per pick.
- **Tiers** 👑 Legendary · 💎 Diamond · 🔷 Platinum · 🥇 Gold · 🥈 Silver · 🥉 Bronze, by where a scene ranks among your settled scenes (top 1%, 5%, 15%, 35%, 65%, the rest), on every card. Battle cards' borders take the tier's colour (**Tier colours on card borders**, on by default).
- **Provisional `?`**: `ELO 1540?` while a scene has had fewer than 10 battles and its ELO is still settling. Scenes set up from your star ratings start settled.
- **Undo last pick** ↶ (the Undo button, or Backspace): takes back both scenes' ELO and records, a Champion streak or Placement run, and brings the same pair back. Also on the Champion and Placement end screens.
- **🔎 Explore tab**: your library as small cards, ranked by ELO, a page at a time (30 to 240, or all). Search by title, studio or performer; filter by tier, provisional or unrated, or an ELO range; sort by ELO, plays, battles, best record, highest peak or longest win streak. Hover for the preview, click to open the scene, ⚔️ to battle it. **Battle these N scenes** battles what the filter shows until you press Stop: against your whole library, or against each other with "Use filtered scenes for both sides". Unrated scenes go to Placement.
- **📊 Stats tab**: an overview; **how settled** your rankings are, with **Battle the least-tested** (Swiss puts your least-battled scenes on the left first); the **ELO distribution** with your Stash rating scale under it (click a bar to see those scenes in Explore); and **hidden gems / overplayed** (ELO against play count, hover a dot to see the scene).
- **🏆 Records tab**: the **hall of fame** (every scene that has ever been #1, and when), the **longest win streaks** and the **highest peak ELOs**. Each scene's wins, losses, peak and streaks are saved in its custom fields with its ELO (no extra requests); the hall of fame is saved in Stash Battle's plugin settings. Setup and Reset ELO start them over.
- **Scene pages** show the scene's ELO and rank too, next to the play count and O count, with its tier emoji as the icon. Click it to battle that scene. Stash's Custom Fields list is widened so Stash Battle's field names aren't cut off.
- **Phones and tablets**: tap a thumbnail to play or stop its preview, 🔊 / 🔇 on each card to hear or mute it, ↗ to open the scene. Tabs shrink to their emoji on small phones. When Stash folds its menu away (below 1200px wide), a ⚔ button sits in the top bar next to other plugins' buttons.

### Changed

- **Gauntlet mode is removed**; use Placement with "Start from the bottom". A saved Gauntlet session opens in Placement.
- **Fun mode is removed.** With ELO kept separately, "Don't update" now does what fun mode was for: battle without touching your star ratings, except that your rankings are saved.
- **Champion** is plain winner-stays-on ELO: both scenes' ELO changes every pick, including the defender's. The old special rules (the climber keeping its rating when it loses, 100 dropping to 99) are gone.
- **Placement** caps its jumps at a tenth of your library, so a winning streak climbs steadily instead of leaping to #1, and lands a scene halfway between its neighbours' ELO.
- **"Unrated scene rating" setting removed**: unrated scenes count as 1500 in Swiss, the standard ELO start, and start at the bottom in Champion. Placement is the best way to slot a new scene in.
- **Swiss** picks a random opponent within 100 ELO of the scene (or the closest 10 if there aren't enough), instead of one within 10 ranks, so fewer picks are between two scenes with the same ELO.
- How far a scene's ELO moves per battle now depends on how many battles it has had (40, then 24 after 10 battles, then 16 after 30), not on its play count. Scenes set up from your star ratings get a 10-battle head start.
- The navbar button is added through Stash's plugin API, so it plays nicely with other plugins that add navbar items.
- Cleaner look: no glow effects, and the mode icons show on phones again.

### Fixed

- The Champion and Placement end screens no longer flash a scrollbar for half a second.
- Reopening Stash Battle after a finished Placement run (after a page refresh) no longer shows a pair you can't pick from.
- Ranks no longer lag behind after refreshing the page soon after battling, or after battling in another tab: a restored pair, and a scene opened from its page, show their current ELO and rank.
- No more dark sliver at the rounded corners of a card, including while its preview plays or the green/red result shows.

## v2.7.0

A big refresh based on community feedback. Thanks to everyone who sent requests and bug reports!

### New

- **Placement mode** 📍: a new way to place a scene in your rankings, much faster than Gauntlet. Each pick narrows the range of ranks the scene could land in (shown on its card as "Narrowing between #X and #Y"). A scene that keeps winning or losing takes bigger and bigger jumps, then bounces back with smaller steps once it overshoots, so it never skips past scenes it belongs among. An unrated scene lands in about 10 picks, even in a library of 500+ rated scenes, and only its own rating changes, once, at the end.
- **Settings tab** ⚙ next to the Battle tab. Settings are saved to Stash, so they follow you across devices, and they also appear under Settings → Plugins:
  - **Fun mode**: battle without changing any ratings. Every mode still plays out normally, it just never saves.
  - **Unrated scene rating**: what unrated scenes count as in Swiss (now 50 by default, closer to a classic ELO start; set 0 to start them at the bottom like before).
  - **Autoplay previews**: both previews loop silently, and hovering a card plays its sound (on by default).
  - **Pause playing video when Battle opens**: on by default; turn it off to keep a scene playing behind the battle.
  - **Open scenes in a new tab** when clicking a thumbnail.
  - **Use filtered scenes for both sides** (moved here from the main screen).
  - **Clean mode**: a 🗑 button on each card opens Stash's own delete dialog (same options and defaults as deleting in Stash), so you can clean up your library without leaving the battle.
- **Preview volume slider** on the tab bar. Click the speaker to mute or unmute, and the slider now follows how loud things actually sound.
- **Mode explanations**: hover a mode button for a short description (on phones, tap ⓘ next to the modes).
- **Scene pool line** above the cards, showing whether you're rating your Scenes page filter or your whole library, and how many scenes that is.
- **SFW Switch support**: thumbnails and previews blur when the SFW Switch plugin's SFW mode is on.

### Changed

- **Swiss keeps every scene in rotation.** Scenes are no longer removed from the pool after a battle, so you can keep battling a small filter as long as you like. Filters like "unrated only" still shrink as you rate, because the filter is refreshed after each full pass.
- **Works properly on phones and tablets.** Cards stay side by side on tablets, stack compactly on phones, and the Skip button stays pinned at the bottom. On short laptop screens both Choose buttons fit without scrolling. On touch screens, tap a thumbnail to play its preview and use ↗ to open the scene.
- Cleaner badges on the cards, and clearer wording throughout.

### Fixed

- The Skip / Refresh buttons no longer disappear after finishing a Gauntlet or Placement run.
- Pressing keys while Battle is open no longer triggers Stash shortcuts on the page behind it (for example, arrow keys changing the scene list page).
- Battle notices when a scene in the current pair was deleted elsewhere and moves on instead of getting stuck. No need to hit Refresh.

### Improvements

- Behind-the-scenes performance and reliability work: fewer repeated downloads of your scene list during runs, smarter caching, and a cleaner internal design for fun mode and the settings. Plus updated documentation for contributors.
