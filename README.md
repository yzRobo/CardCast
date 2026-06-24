<img width="4100" height="1688" alt="CardCastBanner" src="https://github.com/user-attachments/assets/56f138e0-e738-434c-ad39-24fedcdfa6b2" />

A straightforward streaming overlay tool for Trading Card Game content creators. Display card images and information in real-time through OBS browser sources, with all data stored locally for offline use. No Plug-ins needed!

## Currently Supported Games

- **Pokemon TCG** - Card search, match overlay, and deck building
- **Magic: The Gathering** - Card search, match overlay, and deck building
- **Yu-Gi-Oh!** - Card search, match overlay, and deck building
- **Disney Lorcana** - Card search, match overlay, and deck building
- **Digimon Card Game** - Card search, match overlay, and deck building
- **One Piece Card Game** - Card search, match overlay, and deck building (booster sets and starter decks)
- **Gundam Card Game** - Card search, match overlay, and deck building (boosters and starter decks)
- Flesh and Blood *(Coming Soon)*
- Star Wars Unlimited *(Coming Soon)*

Card data is pulled live on demand from each game's public API (or, for the Gundam
Card Game, the official card site, which has no public API) and cached locally
(images included), so the project hosts no card data itself. All seven games ship
a dedicated match overlay, a control page, and deck building. Pick the active game
from the main-page game switcher; the whole interface follows your choice.

## Features

- **Instant Card Search** - Fast fuzzy search with smart filtering
- **Offline Mode** - All data stored locally after initial download
- **OBS Integration** - Professional overlays for streaming
- **Pokemon Match Tracker** - Dual player display with prize cards, attachable Tools/Items, and an editable timer
- **MTG Match Tracker** - Life totals, phases, format presets, and a match overlay
- **Deck Builder** - Import and manage deck lists
- **Dark Theme** - Modern glassmorphic interface
- **Auto-Updates** - Keep card data current with one click

## Quick Start

### Option 1: Portable Version (Recommended)
1. Download the latest release from [Releases](https://github.com/yzRobo/CardCast/releases)
2. Extract the ZIP file to any folder
3. Double-click `CardCast.bat`
4. The app will automatically:
   - Download portable Node.js if needed (no admin required)
   - Install dependencies on first run
   - Open your browser to http://localhost:3888 (It should open automatically in your default browser)

### Option 2: Development Setup
```bash
# Clone the repository
git clone https://github.com/yzRobo/CardCast.git
cd cardcast

# Install dependencies
npm install

# Start development server
npm run dev

# Build portable distribution
npm run build
```

## OBS Setup

1. In CardCast, go to the **OBS Setup** tab
2. Copy the browser source URLs
3. In OBS Studio:
   - Add a new **Browser Source**
   - Paste the URL
   - Set dimensions to **1920x1080**
   - Set FPS to **30**

### Available Overlays

| Overlay | URL | Description |
|---------|-----|-------------|
| Pokemon Match | `http://localhost:3888/pokemon-match` | Complete Pokemon match overlay |
| MTG Match | `http://localhost:3888/mtg-match` | Complete Magic: The Gathering match overlay |
| Yu-Gi-Oh! Match | `http://localhost:3888/yugioh-match` | Complete Yu-Gi-Oh! match overlay |
| One Piece Match | `http://localhost:3888/onepiece-match` | Complete One Piece Card Game match overlay |
| Lorcana Match | `http://localhost:3888/lorcana-match` | Complete Disney Lorcana match overlay |
| Digimon Match | `http://localhost:3888/digimon-match` | Complete Digimon Card Game match overlay |
| Gundam Match | `http://localhost:3888/gundam-match` | Complete Gundam Card Game match overlay |

## Pokemon Features

### Card Search
- Search by name, set code, or card number
- Smart search: `"Pikachu SV01 25"` finds exact card
- Fuzzy matching for partial names
- Recent cards quick access

### Pokemon Match Overlay
- Player name displays
- Active Pokemon with attachable Tools/Items
- Bench Pokemon (up to 5) with editable HP
- Prize card tracker
- Turn indicator
- Editable match timer with BO1 (25 min) and BO3 (50 min) presets

### Deck Import
Supports multiple formats:
- **PTCGL Format**: `4 Professor's Research SV01 25`
- **Limitless TCG**: Copy/paste from deck lists
- **Simple Format**: Just card names with quantities

## File Structure

```
CardCast/
├── CardCast.bat          # One-click launcher
├── server.js             # Main application
├── config.json           # User settings
├── public/               # Web interface
├── src/                  # Core modules
├── overlays/             # OBS overlay files
├── data/                 # Card databases (auto-created)
└── cache/                # Card images (auto-created)
```

## Configuration

Edit `config.json` to customize:
```json
{
  "port": 3888,           // Change if port is in use
  "theme": "dark",        // UI theme
  "autoUpdate": true,     // Auto-check for card updates
  "games": {
    "pokemon": {
      "enabled": true,    // Show this game in the interface
      "dataPath": null
    }
  }
}
```

For a personal override that is never committed, copy `config.local.example.json`
to `config.local.json` (gitignored). Anything there overrides `config.json`.

## Optional API keys

All card downloads work with no API key (anonymous requests). A key is only
useful for raising rate limits. Keys are optional, never committed, and resolved
in this priority order:

1. Environment variable (preferred)
2. `config.local.json` (gitignored)
3. None (anonymous)

| Game | Key | Environment variable | `config.local.json` |
| --- | --- | --- | --- |
| Pokemon | [pokemontcg.io](https://dev.pokemontcg.io/) | `POKEMONTCG_API_KEY` | `apiKeys.pokemon` |

The other games use sources that need no key: Magic via Scryfall, Yu-Gi-Oh via
YGOPRODeck, Lorcana via Lorcast, Digimon via digimoncard.io, One Piece via
optcgapi.com, and Gundam via the official card site (scraped, no API).

To configure a key, either copy `.env.example` to `.env` and fill it in:

```
POKEMONTCG_API_KEY=your-key-here
```

or copy `config.local.example.json` to `config.local.json`:

```json
{
  "apiKeys": { "pokemon": "your-key-here" }
}
```

When a Pokemon key is present it is sent as the `X-Api-Key` header on requests to
`api.pokemontcg.io`; when absent, requests are made anonymously. On startup the
server logs whether a key was loaded. Never commit a real key - `.env` and
`config.local.json` are already gitignored.

## Troubleshooting

### Port Already in Use
1. Edit `config.json`
2. Change `"port": 3888` to another number (e.g., `3889`)
3. Restart CardCast

### OBS Not Showing Cards
- Verify CardCast is running
- Check the browser source URL is correct
- Try refreshing the browser source cache in OBS
- Ensure Windows Firewall isn't blocking connections

### Cards Not Downloading
- Check your internet connection
- Verify Windows Defender isn't blocking the app
- Try running as Administrator
- Delete `data/cardcast.db` and try again

### Database Errors
```bash
# Reset the database
1. Close CardCast
2. Delete the `data` folder
3. Restart CardCast
4. Re-download card data
```

## Development

### Requirements
- Node.js 22+ (LTS recommended)
- Windows 10/11 (primary platform)
- 4GB RAM minimum
- 5GB free disk space (for card image storage)

### Project Structure
- **Express.js** backend with Socket.io
- **SQLite** database via better-sqlite3
- **Vanilla JavaScript** frontend
- **DaisyUI** + Tailwind CSS styling

### Build Process
```bash
# Install dependencies
npm install

# Run tests
npm test

# Build portable distribution
npm run build

# The output will be in dist-portable/
```

## Data Sources

Card data is pulled live when you click download, then cached locally (database
and images) for offline use. Most games use a free public API; the Gundam Card
Game has no public API, so its data is read from the official card site:

- [PokemonTCG.io](https://pokemontcg.io/) - Pokemon TCG
- [Scryfall](https://scryfall.com/docs/api) - Magic: The Gathering
- [YGOPRODeck](https://ygoprodeck.com/api-guide/) - Yu-Gi-Oh!
- [Lorcast](https://lorcast.com/docs/api) - Disney Lorcana
- [digimoncard.io](https://digimoncard.io/api-public/) - Digimon Card Game
- [optcgapi.com](https://optcgapi.com/documentation) - One Piece Card Game (booster sets and starter decks)
- [gundam-gcg.com](https://www.gundam-gcg.com/en/cards) - Gundam Card Game (boosters and starter decks; site scrape, no public API)

## Contributing

Contributions are welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

### Priority Areas
- Adding support for more TCGs
- Improving search algorithms
- Creating new overlay designs
- Performance optimizations

## License

**GPL-3.0** - This ensures CardCast remains free and open source forever.

Key points:
- Free to use for any purpose
- Modify and distribute freely
- Must keep source code open
- Include license in distributions

See [LICENSE](LICENSE) file for full details.

## Roadmap

### Current Focus
- [x] Pokemon TCG full support
- [x] OBS overlay system
- [x] Deck import/export
- [x] Portable distribution

### Coming Soon
- [x] Magic: The Gathering match control and overlay
- [x] Yu-Gi-Oh! integration
- [x] Disney Lorcana cards
- [x] One Piece Card Game cards
- [x] Digimon Card Game cards
- [x] Gundam Card Game cards
- [ ] Tournament mode
- [ ] Stream deck integration
- [ ] Custom overlay designer
- [ ] Multi-language support

## Support

- **Issues**: [GitHub Issues](https://github.com/yzRobo/CardCast/issues)
- **Discord**: Coming soon
- **Email**: support@cardcast.app

## Acknowledgments

- [PokemonTCG.io](https://pokemontcg.io/) for card data
- [TCGCSV.com](https://tcgcsv.com) for card data
- [Socket.io](https://socket.io) for real-time updates
- [Better-SQLite3](https://github.com/WiseLibs/better-sqlite3) for database
- [DaisyUI](https://daisyui.com) for UI components
- The TCG streaming community for inspiration

---

**CardCast v2.0.2** - Built for the TCG streaming community
