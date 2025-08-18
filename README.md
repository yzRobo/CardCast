# CardCast

Streaming overlay tool for Trading Card Game content creators. Display card information in real-time with OBS Studio.

## Supported Games

- Pokemon TCG
- Magic: The Gathering
- Yu-Gi-Oh!
- Disney Lorcana
- One Piece Card Game
- Digimon Card Game
- Flesh and Blood
- Star Wars Unlimited

## Features

- Instant card search
- Offline mode with local data storage
- Professional overlay layouts
- OBS browser source integration
- Game-specific displays
- Real-time updates
- Dark mode interface

## Quick Start

1. Download the latest release for your platform
2. Launch CardCast
3. Select your TCG and download card data
4. Add the browser source URL to OBS
5. Start searching and displaying cards

## Installation

### Windows
```bash
# Download the .exe installer from releases
CardCast-Setup-1.0.0.exe
```

### macOS
```bash
# Download the .dmg from releases
CardCast-1.0.0.dmg
```

### Linux
```bash
# Download the .AppImage from releases
CardCast-1.0.0.AppImage
```

## Development

```bash
# Clone the repository
git clone https://github.com/yourusername/cardcast.git
cd cardcast

# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build

# Package for distribution
npm run dist
```

## OBS Setup

1. Open CardCast and navigate to Settings
2. Copy your browser source URL (default: `http://localhost:3888/overlay`)
3. In OBS, add a new Browser Source
4. Paste the URL and set dimensions (1920x1080 recommended)
5. Cards will appear automatically when searched in CardCast

## Configuration

CardCast stores all data locally in:
- Windows: `%APPDATA%/CardCast`
- macOS: `~/Library/Application Support/CardCast`
- Linux: `~/.config/CardCast`

## Requirements

- OBS Studio 28.0 or higher
- 4GB RAM minimum
- 2GB free disk space per game

## License

GPL-3.0 - This ensures CardCast remains free and open source forever. See [LICENSE](LICENSE) file for details.

## Credits

Card data provided by TCGCSV.com API