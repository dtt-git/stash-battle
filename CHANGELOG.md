# Changelog

## v3.0.0

A new rating system: Stash Battle now keeps a true ELO score for every scene, separate from your star ratings.

### ⚠️ Before you update

- **Requires Stash v0.31.0 or newer.** ELO is stored in scene custom fields, which Stash added in v0.31.0. On an older Stash, Stash Battle shows a message instead of loading.
- **Stash Battle no longer changes your Stash star ratings by default.** Every battle still updates rankings, but in Stash Battle's own ELO score. If you want your star ratings to keep following your rankings, set **Settings → Stash ratings update mode** to Percentile or Straight-line, either in the setup screen or later in Settings. **Straight-line with "Use my ratings" is closest to how 2.x worked.**
- **Take a Stash backup first** (Settings → Tasks → Backup), especially if you turn on a Stash ratings update mode, which rewrites ratings.

### New

- **True ELO** 📈: every scene gets an uncapped ELO score (the same idea chess uses), saved in its custom fields (`stash_battle_elo`, `stash_battle_battles`, `stash_battle_seeded`). Scenes are no longer squeezed into 1-100, so your favourites can keep pulling ahead instead of piling up at 100.
- **One-time ELO setup**: the first time you open Stash Battle, choose how ELO starts:
  - **Use my ratings**: every rated scene starts from its star rating, so your existing order carries over (50 stars = 1500 ELO, 10 ELO per rating point).
  - **Start everyone at 1500**: every scene starts equal.
  
  A live 10-scene preview shows what each choice does, and how many of your ratings would change, before anything is written.
- **Stash ratings update mode** (Settings): Don't update (the default), **Percentile** (rating = percentile in your library: the top scene is 100, the bottom 1), or **Straight-line** (rating = ELO converted back, 1500 = 50). Switching tells you exactly how many ratings will change. While it's on, each battle writes only the ratings that changed, in one go, and Stash's own pages show the new ratings without a refresh.
- **Reset ELO** (Settings): start every scene's ELO over, with the same choices as the setup. Cancel any time before pressing Start.
- **Placement → Start from the bottom** (a setting): a scene ignores its current ELO and climbs from your lowest scene, jumping further with each win, with a win streak badge and a Champion screen if it never loses. **This replaces Gauntlet**, with much shorter runs (about 8-21 battles in a 600-scene library).
- **Cards** show each scene's ELO and rank (`ELO 1740 · #50`), how many battles it has had, and its Stash rating.

### Changed

- **Gauntlet mode is removed**; use Placement with "Start from the bottom". A saved Gauntlet session opens in Placement.
- **Fun mode is removed.** With ELO kept separately, "Don't update" now does what fun mode was for: battle without touching your star ratings, except that your rankings are saved.
- **Champion** is plain winner-stays-on ELO: both scenes' ELO changes every pick, including the defender's. The old special rules (the climber keeping its rating when it loses, 100 dropping to 99) are gone.
- **Placement** caps its jumps at a tenth of your library, so a winning streak climbs steadily instead of leaping to #1, and lands a scene halfway between its neighbours' ELO.
- **"Unrated scene rating" setting removed**: unrated scenes count as 1500 in Swiss, the standard ELO start, and start at the bottom in Champion. Placement is the best way to slot a new scene in.
- How far a scene's ELO moves per battle now depends on how many battles it has had (40, then 24 after 10 battles, then 16 after 30), not on its play count. Scenes set up from your star ratings get a 10-battle head start.
- The navbar button is added through Stash's plugin API, so it plays nicely with other plugins that add navbar items.
- Cleaner look: no glow effects, and the mode icons show on phones again.

### Fixed

- The Champion and Placement end screens no longer flash a scrollbar for half a second.
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
