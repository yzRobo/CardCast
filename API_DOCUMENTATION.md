# CardCast API Documentation

## REST API Endpoints

### Configuration

#### GET /api/config
Returns current server configuration.

**Response:**
```json
{
  "port": 3888,
  "theme": "dark",
  "autoUpdate": true,
  "games": { ... },
  "obs": { ... }
}
```

#### POST /api/config
Updates server configuration.

**Request Body:**
```json
{
  "port": 3889,
  "theme": "dark"
}
```

### Games

#### GET /api/games
Returns list of available games with their status.

**Response:**
```json
[
  {
    "id": "pokemon",
    "name": "Pokemon",
    "enabled": true,
    "available": true,
    "hasData": true,
    "cardCount": 20453,
    "lastUpdate": "2024-01-15T10:30:00Z"
  }
]
```

#### DELETE /api/games/:game/data
Deletes all data for a specific game.

**Parameters:**
- `game`: Game ID (pokemon, magic, etc.)

**Response:**
```json
{
  "success": true,
  "message": "Data cleared for pokemon"
}
```

### Card Search

#### GET /api/search/:game
Search for cards in a specific game.

**Parameters:**
- `game`: Game ID
- `q`: Search query (query parameter)

**Example:**
```
GET /api/search/pokemon?q=pikachu
```

**Response:**
```json
{
  "results": [
    {
      "id": 12345,
      "name": "Pikachu",
      "set_name": "Surging Sparks",
      "set_abbreviation": "SV08",
      "card_number": "25",
      "image_url": "https://...",
      "rarity": "Common",
      "hp": "60"
    }
  ],
  "count": 15
}
```

### Pokemon-Specific

#### GET /api/pokemon/sets
Returns all Pokemon sets in the database.

**Response:**
```json
[
  {
    "set_name": "Surging Sparks",
    "set_code": "SV08",
    "set_abbreviation": "SV08",
    "card_count": 191
  }
]
```

#### GET /api/pokemon/set-mappings
Returns set abbreviation to name mappings.

**Response:**
```json
{
  "SV01": "Scarlet & Violet",
  "SV08": "Surging Sparks",
  "ME01": "Mega Evolution"
}
```

### Download

#### POST /api/download/:game
Starts downloading card data for a game.

**Parameters:**
- `game`: Game ID

**Request Body:**
```json
{
  "incremental": false,
  "setCount": "3"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Download started for pokemon"
}
```

## WebSocket Events

### Client → Server

#### `search`
Search for cards.
```javascript
socket.emit('search', {
  game: 'pokemon',
  query: 'pikachu'
});
```

#### `display-card`
Display a card in OBS overlay.
```javascript
socket.emit('display-card', {
  position: 'left',  // or 'right'
  card: { /* card object */ }
});
```

#### `register-overlay`
Register an OBS overlay connection.
```javascript
socket.emit('register-overlay', 'pokemon-match');
```

#### `pokemon-match-update`
Update Pokemon match state.
```javascript
socket.emit('pokemon-match-update', {
  player1: {
    name: 'Player 1',
    active: { /* card */ },
    bench: [ /* cards */ ],
    prizes: 6
  },
  player2: { /* same structure */ }
});
```

### Server → Client

#### `search-results`
Returns search results.
```javascript
socket.on('search-results', (data) => {
  console.log(data.results);  // Array of cards
  console.log(data.count);     // Total count
});
```

#### `download-progress`
Download progress updates.
```javascript
socket.on('download-progress', (data) => {
  console.log(data.game);       // 'pokemon'
  console.log(data.progress);   // 0-100
  console.log(data.message);    // Status message
});
```

#### `download-complete`
Download finished.
```javascript
socket.on('download-complete', (data) => {
  console.log(data.cardCount);  // Number of cards
  console.log(data.setCount);   // Number of sets
});
```

#### `card-displayed`
Card shown in overlay.
```javascript
socket.on('card-displayed', (data) => {
  console.log(data.position);   // 'left' or 'right'
  console.log(data.card);        // Card object
});
```

#### `obs-status`
OBS connection status.
```javascript
socket.on('obs-status', (data) => {
  console.log(data.connected);  // true/false
});
```

## Database Schema

### Cards Table
```sql
CREATE TABLE cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game TEXT NOT NULL,
  product_id TEXT,
  name TEXT NOT NULL,
  set_name TEXT,
  set_code TEXT,
  set_abbreviation TEXT,
  card_number TEXT,
  image_url TEXT,
  local_image TEXT,
  rarity TEXT,
  card_type TEXT,
  hp TEXT,
  mana_cost TEXT,
  attack TEXT,
  defense TEXT,
  cost TEXT,
  card_text TEXT,
  search_text TEXT,
  data JSON,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Indexes
- `idx_cards_game_name` - For fast game + name searches
- `idx_cards_search` - For text search
- `idx_cards_set` - For set-based queries
- `idx_cards_game_product` - For unique constraint

## Error Codes

| Code | Description |
|------|-------------|
| 400 | Bad Request - Invalid parameters |
| 404 | Not Found - Game or card not found |
| 500 | Server Error - Internal error |
| 503 | Service Unavailable - Download in progress |

## Rate Limits

- Search: No limit (local database)
- Download: One concurrent download per game
- WebSocket: 100 messages per second per client

## Examples

### Search with Set Code
```javascript
// Search for specific Pikachu
const response = await fetch('/api/search/pokemon?q=pikachu SV01 25');
```

### Display Card in OBS
```javascript
// Connect to WebSocket
const socket = io('http://localhost:3888');

// Register as overlay
socket.emit('register-overlay', 'main');

// Listen for cards to display
socket.on('card-displayed', (data) => {
  updateOverlay(data.position, data.card);
});
```

### Download Pokemon Data
```javascript
// Start download
await fetch('/api/download/pokemon', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    incremental: false,
    setCount: '3'
  })
});

// Listen for progress
socket.on('download-progress', (data) => {
  updateProgressBar(data.progress);
});
```

---

For more examples, see the source code in `public/js/main.js` and `src/overlay-server.js`.