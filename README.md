<img width="4100" height="1688" alt="CardCastBanner" src="https://github.com/user-attachments/assets/56f138e0-e738-434c-ad39-24fedcdfa6b2" />

A straightforward streaming overlay tool for Trading Card Game content creators. Display card images and information in real-time through OBS browser sources, with all data stored locally for offline use. No Plug-ins needed!

## Currently Supported Games

- **Pokemon TCG** - Fully functional with 20,000+ cards
- Magic: The Gathering *(Coming Soon)*
- Yu-Gi-Oh! *(Coming Soon)*
- Disney Lorcana *(Coming Soon)*
- One Piece Card Game *(Coming Soon)*
- Digimon Card Game *(Coming Soon)*
- Flesh and Blood *(Coming Soon)*
- Star Wars Unlimited *(Coming Soon)*

## Features

- **Instant Card Search** - Fast fuzzy search with smart filtering
- **Offline Mode** - All data stored locally after initial download
- **OBS Integration** - Professional overlays for streaming
- **Pokemon Match Tracker** - Dual player display with prize cards
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
| Main Display | `http://localhost:3888/overlay` | Dual card display with VS indicator |
| Prize Cards | `http://localhost:3888/prizes` | Pokemon prize tracker (6 cards) |
| Deck List | `http://localhost:3888/decklist` | Full deck display |
| Pokemon Match | `http://localhost:3888/pokemon-match` | Complete match overlay |

## Pokemon Features

### Card Search
- Search by name, set code, or card number
- Smart search: `"Pikachu SV01 25"` finds exact card
- Fuzzy matching for partial names
- Recent cards quick access

### Pokemon Match Overlay
- Player name displays
- Active Pokemon slots
- Bench Pokemon (up to 5)
- Prize card tracker
- Turn indicator
- Match timer

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
      "enabled": true,    // Currently the only working game
      "dataPath": null 
    }
  }
}
```

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
- Node.js 16+ (LTS recommended)
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

Card data is sourced from:
[PokemonTCG.io](https://pokemontcg.io/) - Highly Organized and Comprehensive Pokemon TCG API.
[TCGCSV.com](https://tcgcsv.com) - A Comprehensive TCGPlayer Database API.

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
- [ ] Magic: The Gathering support
- [ ] Yu-Gi-Oh! integration
- [ ] Disney Lorcana cards
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

**CardCast v1.0.1** - Built with love for the TCG streaming community
