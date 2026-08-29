# Changelog

All notable changes to CardCast will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.2.0] - 2026-08-29

### Added
- Every match overlay now shows at a glance whose turn it is. The active player's board carries a lit accent rail along its inner edge and a soft glow on its main panels, while the other side settles back slightly. The rail is either there or it is not, which reads on stream in a way a brightness difference does not when the two boards sit at opposite edges of the screen in different colours.
- Empty board slots are no longer blank dashed boxes. Each game drifts its own quiet motif through them - a Pokeball for Pokemon, a zone diamond for Yu-Gi-Oh, an ink drop for Lorcana, a hexagon for Digimon, a ship's helm for One Piece, a targeting reticle for Gundam and a mana circle for Magic. They are slow, dim and staggered so no two slots move in step.
- The Pokemon overlay prints the Active Pokemon's ability and attacks at a readable size beneath the card, with the energy cost of each attack drawn as coloured pips and the damage aligned on the right. The card's own printed text is far too small to read at overlay scale, and smaller still after streaming compression. The Pokemon's name and stage now head the panel in their own banner.
- Depleting counters are drawn as artwork rather than plain rectangles: Pokemon prize cards as Pokeballs, Gundam shields as shields, One Piece life and Digimon security as face-down cards in each player's colour. A spent counter fades out instead of being stamped with a red cross, which read as an error rather than as a point scored.
- Life, HP and memory changes briefly show the amount that changed, and a resource in a critical state pulses gently. The last minute on the clock turns red.

### Fixed
- The active-player indicator reverted to player one a few seconds after every turn switch. The server passed the switch along to the overlays but never recorded it, so the state it replays to each overlay every five seconds still carried the previous turn and quietly undid the change. With the control page closed, the wrong player would stay highlighted for the rest of the session. This affected every game except Pokemon.
- A card whose artwork failed to load would retry forever - several thousand requests in a few seconds - because the fallback image every page falls back to was never actually shipped. The fallback card back now exists, so a missing image settles immediately on a placeholder.
- Overlays no longer flicker when a counter changes. Updating a life total, HP value or resource count used to rebuild the whole section, which reloaded every card image in it and restarted its animations. Only the parts that actually changed are redrawn now.
- Bench HP labels lost their last digit on a seven-slot Pokemon bench, so a Pokemon on 280 of 280 HP read as 280 of 28. Long player names, card names and attack names now shorten with an ellipsis instead of pushing other information out of the panel.
- The Pokemon Active card is no longer clipped along its bottom edge, and an attached tool no longer covers the card's own name.
- Seven-slot Pokemon benches were wider than the panel holding them.
- Magic overlays no longer stop updating if the match state arrives without one of the players, and card names containing quotes or ampersands no longer break the board.
- Attaching a pilot in Gundam, or editing a Leader's power in One Piece, no longer reloads the card artwork.

## [2.1.0] - 2026-08-18

### Added
- The desktop app now installs its own updates. When a new version is found it asks once, downloads it with a progress bar in the header and on the taskbar button, then asks to restart. Choosing Restart Now closes CardCast, installs silently and reopens on the new version - no browser, no downloads folder, no installer wizard. Choosing Later keeps the download and installs it the next time you quit. If an update cannot be installed automatically for any reason, CardCast falls back to the previous behaviour and offers to open the download page.
- CardCast has a real application icon: two fanned cards under a broadcast arc, in the app's indigo-to-violet palette. It is used for the window, taskbar, Start Menu, installer and the browser tab. A simplified version is drawn at 16 and 24 pixels, where the full artwork would be unreadable. The artwork lives in `assets/icon.svg` and is regenerated with `node scripts/build-icon.mjs`.

### Changed
- The Windows installer is now one-click. It installs for the current user without prompting for a folder or administrator rights, which is what lets updates install silently. If you previously installed CardCast for all users (typically in Program Files), the new version installs alongside it and offers, once, to remove the old copy - the old install is no longer used, but its Start Menu shortcut would otherwise still open it.

### Note
- Updating to 2.1.0 itself is still a manual download, because self-updating only exists from this version onward. Every update after this one installs itself.

## [2.0.5] - 2026-08-17

### Fixed
- Deck view showed completely unrelated cards. Adding a card, or importing a decklist, could put a different card entirely into the deck: searching for Pikachu and clicking it produced Aegislash, Lightning Bolt produced Abzan Guide, Iono produced Ampharos-GX. The deck stored only a card's name and collector number and re-found the artwork later by searching for that number on its own, which matched any card sharing the number and returned the first one alphabetically. Deck entries now keep the card that was actually chosen (its id, set and art), and the fallback lookup will only ever accept a card whose name matches the deck entry. Existing saved decks are corrected the next time they are opened. This affected Pokemon, Magic and Lorcana, whose collector numbers are plain digits, and was introduced in 2.0.3; Yu-Gi-Oh, One Piece, Digimon and Gundam were unaffected, and no deck data was damaged - only the picture shown in the app was wrong, so the deck list on the stream overlay was correct throughout.
- Cards added from the main page recorded an empty set code, because the search results carry the set abbreviation under a different field than the one being read. The set code is now stored correctly, which also gives imported and hand-built decks a reliable way to tell printings apart.
- Card names containing quotes or ampersands no longer break the "Add Cards" picker in deck edit mode.

## [2.0.4] - 2026-07-05

### Fixed
- Deck builder copy counting is now correct per game. Games where the copy limit is per card number (Digimon, One Piece, Gundam) keep distinct same-named cards as separate entries (as in 2.0.3); games where the limit is per card name (Pokemon, Magic, Yu-Gi-Oh, Lorcana) now correctly merge different printings of the same card into a single entry counted by name, instead of splitting them by printing.

## [2.0.3] - 2026-07-05

### Fixed
- Deck builder: you can now add multiple different cards that share a name (for example the many distinct "Agumon" in Digimon). Cards are keyed by their unique card number instead of by name, so distinct same-named cards stay separate entries - each with its own copy count - and the deck view fetches the correct art for each. Previously they merged into one entry and shared the copy limit, which blocked adding a legitimately different same-named card.
- Deck import/export: pasting a decklist, or exporting a deck and re-importing it, no longer merges different cards that share a name. The text export now includes each card's number even when it has no set code (e.g. Digimon), and the Digimon / One Piece / Gundam importers key by card number, so distinct same-named cards round-trip correctly.

## [2.0.2] - 2026-06-24

### Changed
- Premium redesign of the admin/control interface. A refined indigo-to-violet design system with real material depth (layered gradient surfaces, inset highlights, soft shadows; sunken inputs vs raised buttons), the accent reserved for primary actions and active state, solid card slots in place of the old dashed wireframe placeholders across every match control page, refined section headers, consistent connection status pills, glossy game icons, larger corner radii, and calmer secondary buttons. Removed leftover decorative effects (floating background orbs, neon glows, rainbow borders, 3D card tilts). The OBS overlays are unchanged.
- Native select dropdowns now render with a dark popup, so options stay readable on every browser and OS.

### Fixed
- The OBS/overlay connection indicator now turns green when connected (it was stuck red) on the dashboard and on every match control page.

## [2.0.1] - 2026-06-24

### Fixed
- Search box could stay disabled on a fresh desktop install: the startup game auto-select used a fixed timer that could fire before the card list finished loading (more likely on first run, when the database is freshly written), leaving no game selected and the search box disabled. It now waits for the game list to load, so a game is always selected and search is enabled.

### Added
- In-app update check (desktop app): on launch CardCast checks GitHub for a newer release and offers to open the download page. A visible "Check for Updates" button in the top bar lets you check on demand at any time (it runs the same check; in the browser/portable build it opens the Releases page). The header version badge now shows the real app version.

### Removed
- Retired the standalone Prize Tracker panel from the main page and its separate `/prizes` overlay. The main page is for card search, deck building, and the spotlight overlay; live match state (including each game's facedown resource) belongs on the per-game match control pages, which already own it. The panel was a Pokemon-only holdover that showed on every game even though only some games have an equivalent mechanic (Pokemon prizes, Gundam shields, Digimon security, One Piece life) and three have none (Magic, Yu-Gi-Oh, Lorcana). The full prize display inside the Pokemon match overlay is unchanged.

## [2.0.0] - 2026-06-24

### Added
- Match overlays, dedicated control pages, and deck building for six new games: Magic: The Gathering (MTG-proper), Yu-Gi-Oh!, One Piece Card Game, Disney Lorcana, Digimon Card Game, and Gundam Card Game (One Piece and Gundam include starter-deck cards)
- Main-page game switcher: a single game selector drives the whole interface, powered by a client-side GAME_REGISTRY so search, match controls, and deck building follow the active game
- Generic decklist overlay: a single registry-driven overlay renders deck sections for every game from its registered categories, with no per-game branching
- Metadata seed database: fresh installs fetch a prebuilt metadata-only database so they skip the live API/scrape downloads
- Lazy, self-healing image cache: card images download on first view and are re-fetched from their source URL if missing
- Shared cross-game color capture: multi-color identity is stored in a shared color column used across games

### Changed
- Card data is pulled from each game's free public API, except Gundam which is read from the official card site (no public API for that game)
- Magic refocused to MTG-proper (20 life, Commander removed)

## [1.0.1] - 2025-08-24

### Fixed
- Fixed prize card display showing "false,false,false,false,false,false" instead of numbers
- Fixed match reset throwing error due to non-existent stadiumManual element
- Fixed timer auto-starting after match reset
- Fixed prize cards not visually resetting in overlay
- Fixed turn actions not clearing on match reset
- Fixed element ID mismatches between control page and overlay
- Fixed match state not properly syncing between control and overlay

### Improved
- Enhanced error handling in clearStadium function
- Better prize data conversion between boolean arrays and prizesTaken arrays
- Improved timer management to prevent auto-start
- More robust match reset sequence

### Technical Changes
- Removed reference to non-existent stadiumManual element
- Fixed updatePlayerInfo using wrong element ID (PrizeCount → Prizes)
- Fixed updatePrizeDisplay using wrong container ID (Prizes → PrizeCards)
- Added proper timer pause before all reset operations

## [1.0.0] - 2025-08-21

### Added
- Initial release with full Pokemon TCG support
- Real-time card search with fuzzy matching
- OBS browser source integration
- Pokemon Match overlay with prize cards and bench
- Deck import/export functionality
- Portable distribution with auto-Node.js download
- Dark theme with glassmorphic UI
- SQLite database for offline storage
- Socket.io for real-time updates
- TCGCSV.com integration for card data
- Support for 20,000+ Pokemon cards
- Smart search with set codes and card numbers
- Recent cards quick access
- Download progress tracking
- Auto-update checking for card data
- Deck importing works with PTCGL and Limitless lists. 

### Changed
- Switched from pkg executable to portable Node.js distribution
- Improved build process for better compatibility
- Enhanced error handling and user feedback

### Coming Soon
- Magic: The Gathering support
- Yu-Gi-Oh! integration
- Disney Lorcana cards
- One Piece Card Game
- Digimon Card Game
- Flesh and Blood
- Star Wars Unlimited

### Known Issues
- Only Pokemon TCG is currently functional
- Pokemon Match Control deck lists will show a some extra cards that aren't part of that deck list.

## [0.9.0] - 2025-08-18 (Pre-release)

### Added
- Project structure and core modules
- Basic Express server setup
- Database schema design
- UI prototype with DaisyUI
- Initial Pokemon data scraping

### Technical Details
- Node.js 16+ required
- Express.js backend
- Better-SQLite3 for database
- Socket.io for WebSocket communication
- Axios 0.27.2 (for pkg compatibility)
- GPL-3.0 license

---

For more information, see the [README](README.md) or visit the [GitHub repository](https://github.com/yzRobo/CardCast).