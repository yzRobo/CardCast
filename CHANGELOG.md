# Changelog

All notable changes to CardCast will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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