# Changelog

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
