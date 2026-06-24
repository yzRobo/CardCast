# Changelog

All notable changes to CardCast will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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