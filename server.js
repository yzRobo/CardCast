// server.js - CardCast Main Server (Updated with Coming Soon functionality + MTG Support)
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

// Import our modules
const Database = require('./src/database');
const TCGCSVApi = require('./src/tcg-api');
const OverlayServer = require('./src/overlay-server');
const { loadEnv, readJson, mergeConfig, resolveApiKeys } = require('./src/config');
const { ensureSeedDatabase } = require('./src/seed-install');

const AVAILABLE_GAMES = ['pokemon', 'magic', 'yugioh', 'lorcana', 'digimon', 'onepiece', 'gundam'];

// Initialize Express app
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Load optional .env (gitignored) so API keys can be supplied via env vars.
loadEnv();

// Load config. Resolution priority: process.env > config.local.json > config.json.
const configPath = path.join(__dirname, 'config.json');
const localConfigPath = path.join(__dirname, 'config.local.json');

const defaultConfig = {
    port: 3888,
    theme: 'dark',
    autoUpdate: true,
    games: {
        pokemon: { enabled: true, dataPath: null },
        magic: { enabled: true, dataPath: null },
        yugioh: { enabled: true, dataPath: null },
        lorcana: { enabled: true, dataPath: null },
        onepiece: { enabled: true, dataPath: null },
        digimon: { enabled: true, dataPath: null },
        gundam: { enabled: true, dataPath: null },
        fab: { enabled: false, dataPath: null },
        starwars: { enabled: false, dataPath: null }
    },
    obs: {
        mainOverlayPort: 3888,
        prizeOverlayPort: 3889,
        decklistPort: 3890
    }
};

// Read committed config.json (writing defaults out on first run), then overlay
// the gitignored config.local.json on top.
const diskConfig = readJson(configPath);
if (!diskConfig) {
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
}
const localConfig = readJson(localConfigPath);

let config = mergeConfig(mergeConfig(defaultConfig, diskConfig), localConfig);
// API keys are resolved separately and must never be persisted into config.json.
delete config.apiKeys;

// Resolve optional API keys (env var wins over config.local.json).
const apiKeys = resolveApiKeys(localConfig);
console.log(`Pokemon TCG API key: ${apiKeys.pokemonApiKey ? 'loaded (requests authenticated)' : 'not set (running anonymously)'}`);

// Save config function - strips any apiKeys so secrets are never written to disk.
function saveConfig() {
    const { apiKeys: _ignored, ...safeConfig } = config;
    fs.writeFileSync(configPath, JSON.stringify(safeConfig, null, 2));
}

// Initialize components. db and tcgApi are assigned in bootstrap() once the
// first-run seed install (if any) has finished; route handlers reference them
// lazily, so they only run after the server starts listening.
const dbPath = path.join(__dirname, 'data', 'cardcast.db');
let db;
let tcgApi;
const overlayServer = new OverlayServer(io);

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Lazy image resolution for cached card images. Three tiers:
//   1. file already on disk  -> fall through to express.static below
//   2. file missing but the card has a stored remote URL -> download + cache,
//      then fall through to serve it (this is what lets a metadata-only seed DB
//      self-heal its images on first view)
//   3. unknown card / no source URL -> 404 (the Download/Update buttons remain
//      the backfill path; no per-card API code here)
// Concurrent requests for the same missing image share one download via the
// in-flight map so we never fetch or write the same file twice at once.
const inFlightImageFetches = new Map();

app.get('/cache/images/:game/:filename', async (req, res, next) => {
    const { game, filename } = req.params;
    const diskPath = path.join(__dirname, 'cache', 'images', game, filename);

    // Tier 1: already cached.
    if (fs.existsSync(diskPath)) {
        return next();
    }

    // Tier 2: look the card up by its /cache web path and re-fetch from source.
    const webPath = `/cache/images/${game}/${filename}`;
    const sourceUrl = db.getSourceImageUrl(game, webPath);
    if (!sourceUrl) {
        // Tier 3: nothing we can do here; let the Update flow backfill it.
        return res.status(404).send('Image not available');
    }

    const key = `${game}/${filename}`;
    try {
        let fetchPromise = inFlightImageFetches.get(key);
        if (!fetchPromise) {
            fetchPromise = tcgApi.downloadImage(sourceUrl, game, filename)
                .finally(() => inFlightImageFetches.delete(key));
            inFlightImageFetches.set(key, fetchPromise);
        }
        const saved = await fetchPromise;
        if (saved) {
            return next(); // file now exists; express.static serves it
        }
        return res.status(404).send('Image not available');
    } catch (error) {
        console.error(`Lazy image fetch failed for ${webPath}:`, error.message);
        return res.status(502).send('Image source unavailable');
    }
});

// Serve cached images
app.use('/cache', express.static(path.join(__dirname, 'cache')));

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// API Routes
app.get('/api/config', (req, res) => {
    res.json(config);
});

app.post('/api/config', (req, res) => {
    const { apiKeys: _ignored, ...incoming } = req.body || {};
    config = { ...config, ...incoming };
    saveConfig();
    res.json({ success: true, config });
});

// Helper function to get game name
function getGameName(gameId) {
    const names = {
        pokemon: 'Pokemon',
        magic: 'Magic: The Gathering',
        yugioh: 'Yu-Gi-Oh!',
        lorcana: 'Disney Lorcana',
        onepiece: 'One Piece Card Game',
        digimon: 'Digimon Card Game',
        gundam: 'Gundam Card Game',
        fab: 'Flesh and Blood',
        starwars: 'Star Wars Unlimited'
    };
    return names[gameId] || gameId;
}

// Count cached image files on disk for a game (cache/images/<game>).
function countCachedImages(game) {
    try {
        const dir = path.join(__dirname, 'cache', 'images', game);
        if (!fs.existsSync(dir)) return 0;
        return fs.readdirSync(dir).length;
    } catch (e) {
        return 0;
    }
}

// Get list of games - UPDATED FOR COMING SOON
app.get('/api/games', (req, res) => {
    const games = Object.keys(config.games)
        .filter(key => config.games[key].enabled)
        .map(key => {
            // Only Pokemon and Magic are available, all others are coming soon
            const isComingSoon = !AVAILABLE_GAMES.includes(key);
            
            if (isComingSoon) {
                // For coming soon games, return minimal data
                return {
                    id: key,
                    name: getGameName(key),
                    enabled: config.games[key].enabled,
                    available: false,
                    comingSoon: true,
                    hasData: false,  // Always false for coming soon games
                    cardCount: 0,
                    lastUpdate: null
                };
            } else {
                // For available games, return actual data
                const hasData = db.hasGameData(key);
                const stats = db.getGameStats().find(g => g.id === key);
                
                return {
                    id: key,
                    name: getGameName(key),
                    enabled: config.games[key].enabled,
                    available: true,
                    comingSoon: false,
                    hasData: hasData,
                    cardCount: stats?.card_count || 0,
                    lastUpdate: stats?.last_update || null,
                    totalImages: hasData ? db.getImageManifestCount(key) : 0,
                    cachedImages: hasData ? countCachedImages(key) : 0
                };
            }
        });
    res.json(games);
});

// Pokemon set mappings endpoint
app.get('/api/pokemon/set-mappings', (req, res) => {
    try {
        const mappings = db.getSetMappings('pokemon');
        
        // Convert to a map format for easy lookup
        const mappingObject = {};
        mappings.forEach(row => {
            if (row.set_abbreviation) {
                mappingObject[row.set_abbreviation.toUpperCase()] = row.set_name;
            }
        });
        
        res.json(mappingObject);
    } catch (error) {
        console.error('Error fetching set mappings:', error);
        res.status(500).json({ error: 'Failed to fetch set mappings' });
    }
});

// Pokemon sets endpoint
app.get('/api/pokemon/sets', (req, res) => {
    try {
        const query = `
            SELECT DISTINCT 
                set_name,
                set_code,
                set_abbreviation,
                COUNT(*) as card_count
            FROM cards 
            WHERE game = 'pokemon' 
                AND set_name IS NOT NULL
            GROUP BY set_name, set_code, set_abbreviation
            ORDER BY set_name
        `;
        
        const sets = db.db.prepare(query).all();
        res.json(sets);
        
    } catch (error) {
        console.error('Error fetching Pokemon sets:', error);
        res.status(500).json({ error: 'Failed to fetch Pokemon sets' });
    }
});

// Magic Temp Testing
//---------------------------------------------------------------------------

//---------------------------------------------------------------------------

// Delete game data endpoint - UPDATED FOR COMING SOON
app.delete('/api/games/:game/data', (req, res) => {
    const game = req.params.game;
    
    // Only allow delete for set available games
    if (!AVAILABLE_GAMES.includes(game)) {
        return res.status(400).json({ 
            error: `${getGameName(game)} support is coming soon!`,
            comingSoon: true 
        });
    }
    
    console.log(`DELETE request for game: ${game}`);
    
    if (!config.games[game]) {
        console.error(`Invalid game requested for deletion: ${game}`);
        return res.status(400).json({ error: 'Invalid game' });
    }
    
    let dbCleared = false;
    let imagesCleared = false;
    let errors = [];
    
    try {
        // Clear database
        console.log(`Attempting to clear database for ${game}...`);
        try {
            db.clearGameData(game);
            dbCleared = true;
            console.log(`Database cleared successfully for ${game}`);
        } catch (dbError) {
            console.error(`Database clear error for ${game}:`, dbError);
            errors.push(`Database: ${dbError.message}`);
        }
        
        // Clear cached images
        const imagesDir = path.join(__dirname, 'cache', 'images', game);
        console.log(`Checking for images directory: ${imagesDir}`);
        
        if (fs.existsSync(imagesDir)) {
            try {
                const files = fs.readdirSync(imagesDir);
                console.log(`Found ${files.length} image files to delete`);
                
                let deletedCount = 0;
                let failedFiles = [];
                
                files.forEach(file => {
                    try {
                        fs.unlinkSync(path.join(imagesDir, file));
                        deletedCount++;
                    } catch (fileErr) {
                        console.error(`Could not delete ${file}:`, fileErr.message);
                        failedFiles.push(file);
                    }
                });
                
                console.log(`Deleted ${deletedCount}/${files.length} cached images for ${game}`);
                if (failedFiles.length > 0) {
                    errors.push(`Failed to delete ${failedFiles.length} image files`);
                }
                imagesCleared = deletedCount > 0 || files.length === 0;
            } catch (dirErr) {
                console.error(`Error reading images directory for ${game}:`, dirErr);
                errors.push(`Images directory: ${dirErr.message}`);
            }
        } else {
            console.log(`No images directory found for ${game}`);
            imagesCleared = true; // No directory means no images to clear
        }
        
        // If at least database was cleared, consider it a success
        if (dbCleared) {
            const message = errors.length > 0 
                ? `Deleted data for ${game} with some warnings: ${errors.join(', ')}`
                : `Successfully deleted all data for ${game}`;
                
            console.log(message);
            
            res.json({ 
                success: true, 
                message: message,
                warnings: errors
            });
            
            // Notify connected clients
            io.emit('data-deleted', { game });
        } else {
            throw new Error('Failed to clear database');
        }
        
    } catch (error) {
        console.error(`Critical error deleting data for ${game}:`, error);
        console.error('Stack trace:', error.stack);
        
        res.status(500).json({ 
            error: 'Failed to delete data', 
            details: error.message,
            errors: errors
        });
    }
});

// Download/Update cards - UPDATED FOR COMING SOON
app.post('/api/download/:game', async (req, res) => {
    const game = req.params.game;
    const incremental = req.body.incremental || false;
    const setCount = req.body.setCount || 'all';
    
    // Only allow download for set available games
    if (!AVAILABLE_GAMES.includes(game)) {
        return res.status(400).json({ 
            error: `${getGameName(game)} support is coming soon!`,
            comingSoon: true 
        });
    }
    
    if (!config.games[game]) {
        return res.status(400).json({ error: 'Invalid game' });
    }
    
    res.json({ 
        message: incremental ? 'Update started' : 'Download started', 
        game,
        mode: incremental ? 'incremental' : 'full',
        setCount
    });
    
    // Start download in background
    tcgApi.downloadGameData(game, (progress) => {
        io.emit('download-progress', { 
            game, 
            progress: progress.percent || 0,
            message: progress.message || 'Processing...'
        });
    }, incremental, setCount).then((cardCount) => {
        io.emit('download-complete', { 
            game, 
            cardCount,
            incremental 
        });
        console.log(`${incremental ? 'Updated' : 'Downloaded'} ${cardCount} cards for ${game}`);
    }).catch(err => {
        console.error(`${incremental ? 'Update' : 'Download'} error for ${game}:`, err);
        
        let userMessage = err.message;
        if (err.message.includes('Network error') || err.message.includes('ENOTFOUND')) {
            userMessage = `Network error: Cannot connect to ${game} API. Please check your internet connection and try again.`;
        } else if (err.message.includes('Timeout error') || err.message.includes('ETIMEDOUT') || err.message.includes('timeout')) {
            userMessage = `Timeout error: ${game} API is taking too long to respond. Please try again later or check your network speed.`;
        } else if (err.message.includes('Rate limit')) {
            userMessage = `Rate limit error: Too many requests to ${game} API. Please wait a few minutes before trying again.`;
        } else if (err.message.includes('No cards were fetched')) {
            userMessage = `Failed to fetch cards for ${game}. The API might be down or the format may have changed.`;
        }
        
        io.emit('download-error', {
            game,
            error: userMessage,
            details: err.message,
            canRetry: !err.message.includes('Rate limit')
        });
    });
});

// Pre-download all cached card images for a game (optional cache-warming so
// streamers avoid any on-air hitch from lazy image fetching). Mirrors the
// download flow: responds immediately and reports progress over socket.io.
app.post('/api/download-images/:game', async (req, res) => {
    const game = req.params.game;
    const setCount = req.body.setCount || 'all';

    if (!AVAILABLE_GAMES.includes(game)) {
        return res.status(400).json({
            error: `${getGameName(game)} support is coming soon!`,
            comingSoon: true
        });
    }

    if (!config.games[game]) {
        return res.status(400).json({ error: 'Invalid game' });
    }

    res.json({ message: 'Image pre-download started', game, setCount });

    tcgApi.downloadAllImages(game, (progress) => {
        io.emit('image-download-progress', {
            game,
            progress: progress.percent || 0,
            message: progress.message || 'Caching images...'
        });
    }, setCount).then((result) => {
        io.emit('image-download-complete', { game, ...result });
        console.log(`Image cache for ${game}: ${result.downloaded} downloaded, ${result.skipped} cached, ${result.failed} failed`);
    }).catch((err) => {
        console.error(`Image pre-download error for ${game}:`, err);
        io.emit('image-download-error', { game, error: err.message });
    });
});

// Search cards - UPDATED FOR COMING SOON
app.get('/api/search/:game', (req, res) => {
    const { game } = req.params;
    const { q } = req.query;
    
    // Only allow search for set available games
    if (!AVAILABLE_GAMES.includes(game)) {
        return res.status(400).json({ 
            error: `${getGameName(game)} support is coming soon!`,
            comingSoon: true 
        });
    }
    
    if (!q || q.length < 2) {
        return res.json([]);
    }
    
    try {
        // Use the database's searchCards method which now handles set abbreviations
        const results = db.searchCards(game, q);
        
        // Use local_image if available, otherwise fall back to image_url
        const processedResults = results.map(card => ({
            ...card,
            display_image: card.image_url || card.local_image
        }));
        
        res.json(processedResults);
    } catch (error) {
        console.error('Search error:', error);
        res.json([]);
    }
});

// Get card by ID - UPDATED FOR COMING SOON
app.get('/api/card/:game/:id', (req, res) => {
    const { game, id } = req.params;
    
    // Only allow for set available games
    if (!AVAILABLE_GAMES.includes(game)) {
        return res.status(400).json({ 
            error: `${getGameName(game)} support is coming soon!`,
            comingSoon: true 
        });
    }
    
    try {
        const card = db.getCard(game, id);
        
        if (!card) {
            return res.status(404).json({ error: 'Card not found' });
        }
        
        // Add display_image field that uses local if available
        card.display_image = card.image_url || card.local_image;
        
        res.json(card);
    } catch (error) {
        console.error('Get card error:', error);
        res.status(500).json({ error: 'Failed to get card' });
    }
});

// Get game statistics - UPDATED FOR COMING SOON
app.get('/api/stats/:game', (req, res) => {
    const { game } = req.params;
    
    // Only allow stats for set available games
    if (!AVAILABLE_GAMES.includes(game)) {
        return res.status(400).json({ 
            error: `${getGameName(game)} support is coming soon!`,
            comingSoon: true 
        });
    }
    
    try {
        const stats = db.getGameStats().find(g => g.id === game);
        const cacheDir = path.join(__dirname, 'cache', 'images', game);
        let imageCount = 0;
        let cacheSize = 0;
        
        if (fs.existsSync(cacheDir)) {
            const files = fs.readdirSync(cacheDir);
            imageCount = files.length;
            
            files.forEach(file => {
                const filePath = path.join(cacheDir, file);
                const stat = fs.statSync(filePath);
                cacheSize += stat.size;
            });
        }
        
        res.json({
            game: game,
            cardCount: stats?.card_count || 0,
            lastUpdate: stats?.last_update || null,
            imageCount: imageCount,
            cacheSize: (cacheSize / 1024 / 1024).toFixed(2) + ' MB'
        });
    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({ error: 'Failed to get stats' });
    }
});

// Overlay endpoints
app.get('/pokemon-match', (req, res) => {
    res.sendFile(path.join(__dirname, 'overlays', 'pokemon-match.html'));
});

app.get('/pokemon-match-control', (req, res) => {
    res.sendFile(path.join(__dirname, 'pokemon-match-control.html'));
});

app.get('/mtg-match-control', (req, res) => {
    res.sendFile(path.join(__dirname, 'mtg-match-control.html'));
});

app.get('/mtg-match', (req, res) => {
    res.sendFile(path.join(__dirname, 'overlays', 'mtg-match.html'));
});

app.get('/gundam-match', (req, res) => {
    res.sendFile(path.join(__dirname, 'overlays', 'gundam-match.html'));
});

app.get('/gundam-match-control', (req, res) => {
    res.sendFile(path.join(__dirname, 'gundam-match-control.html'));
});

app.get('/yugioh-match', (req, res) => {
    res.sendFile(path.join(__dirname, 'overlays', 'yugioh-match.html'));
});

app.get('/yugioh-match-control', (req, res) => {
    res.sendFile(path.join(__dirname, 'yugioh-match-control.html'));
});

// Main card-display overlay (dual card display controlled from the dashboard)
app.get('/overlay', (req, res) => {
    res.sendFile(path.join(__dirname, 'overlays', 'main.html'));
});

// Prize cards overlay
app.get('/prizes', (req, res) => {
    res.sendFile(path.join(__dirname, 'overlays', 'prizes.html'));
});

// Deck list overlay
app.get('/decklist', (req, res) => {
    res.sendFile(path.join(__dirname, 'overlays', 'decklist.html'));
});

// Track overlay connections
let overlayClients = new Set();
let mainClients = new Set();
let controlClients = new Set();
let overlayStates = {
    'pokemon-match': false,
    'prizes': false,
    'decklist': false,
    'main': false,
    'mtg-match': false,
    'gundam-match': false,
    'yugioh-match': false
};

// Socket.io events
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    
    // Send initial state
    socket.emit('state', overlayServer.getState());
    
    // Handle overlay registration
    socket.on('register-overlay', (type) => {
        overlayClients.add(socket.id);
        overlayStates[type] = true;
        console.log(`Overlay registered: ${type} (${socket.id})`);
        
        // Notify all control panels that overlay is connected
        io.emit('overlay-connected', type);
        
        // Notify all main clients that OBS is connected
        io.emit('obs-status', { connected: true });
        
        // Send current state to the overlay
        const state = overlayServer.getState();
        if (type === 'pokemon-match') {
            socket.emit('pokemon-match-state', state.pokemonMatch);
            // Also send as update for compatibility
            socket.emit('pokemon-match-update', {
                player1: state.pokemonMatch.player1,
                player2: state.pokemonMatch.player2,
                stadium: state.pokemonMatch.stadium
            });
        } else if (type === 'prizes') {
            socket.emit('prizes-state', state);
        } else if (type === 'decklist') {
            socket.emit('decklist-state', state);
        } else if (type === 'mtg-match') {
            socket.emit('state-update', { mtgMatch: state.mtgMatch });
        } else if (type === 'gundam-match') {
            socket.emit('gundam-match-state', state.gundamMatch);
            // Also send as update so a freshly-loaded overlay renders immediately
            socket.emit('gundam-match-update', {
                player1: state.gundamMatch.player1,
                player2: state.gundamMatch.player2,
                currentTurn: state.gundamMatch.currentTurn,
                gameNumber: state.gundamMatch.gameNumber,
                matchFormat: state.gundamMatch.matchFormat
            });
        } else if (type === 'yugioh-match') {
            socket.emit('yugioh-match-state', state.yugiohMatch);
            // Also send as update so a freshly-loaded overlay renders immediately
            socket.emit('yugioh-match-update', {
                player1: state.yugiohMatch.player1,
                player2: state.yugiohMatch.player2,
                currentTurn: state.yugiohMatch.currentTurn,
                currentPhase: state.yugiohMatch.currentPhase,
                gameNumber: state.yugiohMatch.gameNumber,
                matchFormat: state.yugiohMatch.matchFormat
            });
        }
    });

    // Handle control panel registration
    socket.on('register-control', (type) => {
        controlClients.add(socket.id);
        console.log(`Control panel registered: ${type} (${socket.id})`);
        
        // Send current overlay connection states
        Object.keys(overlayStates).forEach(overlayType => {
            if (overlayStates[overlayType]) {
                socket.emit('overlay-connected', overlayType);
            }
        });
    });
    
    // Handle main client registration
    socket.on('register-main', () => {
        mainClients.add(socket.id);
        
        // Send current OBS status to this client
        socket.emit('obs-status', { connected: overlayClients.size > 0 });
    });
    
    // Request state (from overlays)
    socket.on('request-state', (type) => {
        console.log(`State requested for ${type}`);
        const state = overlayServer.getState();
        
        if (type === 'prizes') {
            socket.emit('prizes-update', {
                player1: state.prizeCards.player1,
                player2: state.prizeCards.player2,
                game: 'pokemon',
                show: true
            });
        } else if (type === 'decklist') {
            socket.emit('decklist-update', {
                deck: state.decklist,
                show: true
            });
        } else if (type === 'pokemon-match') {
            // Send the pokemonMatch state from the overlay server
            socket.emit('pokemon-match-state', state.pokemonMatch);
            // Also send as update for compatibility
            socket.emit('pokemon-match-update', {
                player1: state.pokemonMatch.player1,
                player2: state.pokemonMatch.player2,
                stadium: state.pokemonMatch.stadium
            });
        } else if (type === 'mtg-match') {
            socket.emit('state-update', { mtgMatch: state.mtgMatch });
        } else if (type === 'gundam-match') {
            socket.emit('gundam-match-state', state.gundamMatch);
            socket.emit('gundam-match-update', {
                player1: state.gundamMatch.player1,
                player2: state.gundamMatch.player2,
                currentTurn: state.gundamMatch.currentTurn,
                gameNumber: state.gundamMatch.gameNumber,
                matchFormat: state.gundamMatch.matchFormat
            });
        } else if (type === 'yugioh-match') {
            socket.emit('yugioh-match-state', state.yugiohMatch);
            socket.emit('yugioh-match-update', {
                player1: state.yugiohMatch.player1,
                player2: state.yugiohMatch.player2,
                currentTurn: state.yugiohMatch.currentTurn,
                currentPhase: state.yugiohMatch.currentPhase,
                gameNumber: state.yugiohMatch.gameNumber,
                matchFormat: state.yugiohMatch.matchFormat
            });
        }
    });

    // Handle OBS status check
    socket.on('check-obs-status', () => {
        socket.emit('obs-status', { connected: overlayClients.size > 0 });
    });
    
    // Check overlay status
    socket.on('check-overlay-status', (type) => {
        if (overlayStates[type]) {
            socket.emit('overlay-connected', type);
        } else {
            socket.emit('overlay-disconnected', type);
        }
    });
    
    // Search handler - UPDATED FOR COMING SOON
    socket.on('search', async (data) => {
        const { game, query } = data;
        
        // Only allow search for set available games
        if (!AVAILABLE_GAMES.includes(game)) {
            socket.emit('search-error', {
                error: `${getGameName(game)} support is coming soon!`,
                comingSoon: true
            });
            return;
        }
        
        const results = db.searchCards(game, query);
        socket.emit('search-results', results);
    });
    
    // Display card event
    socket.on('display-card', (data) => {
        console.log('Display card:', data.card?.name);
        overlayServer.updateCard(data.card, data.position);
        
        // Emit to all overlay clients
        io.emit('show-card', {
            card: data.card,
            position: data.position || 'left',
            game: data.game
        });
    });
    
    // Clear display event
    socket.on('clear-display', () => {
        console.log('Clear display');
        overlayServer.clearCard();
        io.emit('clear-card', { position: 'both' });
    });
    
    // Pokemon Match events
    socket.on('pokemon-match-update', (data) => {
        console.log('Pokemon match update:', data);
        overlayServer.updatePokemonMatch(data);  // Store in overlay server
        io.emit('pokemon-match-update', data);
    });
    
    socket.on('active-pokemon', (data) => {
        console.log('Active pokemon update for player', data.player);
        overlayServer.updateActivePokemon(data.player, data.pokemon);  // Store in overlay server
        io.emit('active-pokemon', data);
    });
    
    socket.on('bench-update', (data) => {
        console.log('Bench update for player', data.player);
        overlayServer.updateBench(data.player, data.bench);  // Store in overlay server
        io.emit('bench-update', data);
    });
    
    socket.on('prize-taken', (data) => {
        console.log('Prize taken:', data);
        overlayServer.takePrize(data.player, data.index);
        io.emit('prize-taken', data);
    });
    
    socket.on('prizes-reset', () => {
        console.log('Prizes reset');
        overlayServer.resetPrizes();
        io.emit('prizes-reset');
    });
    
    socket.on('turn-switch', (data) => {
        console.log('Turn switch:', data);
        io.emit('turn-switch', data);
    });
    
    socket.on('timer-start', () => {
        console.log('Timer start');
        io.emit('timer-start');
    });
    
    socket.on('timer-pause', () => {
        console.log('Timer pause');
        io.emit('timer-pause');
    });
    
    socket.on('timer-reset', () => {
        console.log('Timer reset');
        io.emit('timer-reset');
    });

    socket.on('timer-set', (data) => {
        console.log('Timer set:', data);
        io.emit('timer-set', data);
    });
    
    socket.on('match-reset', () => {
        console.log('Match reset');
        io.emit('match-reset');
    });
    
    socket.on('match-settings', (data) => {
        console.log('Match settings:', data);
        io.emit('match-settings', data);
    });
    
    socket.on('toggle-pokemon-match', (data) => {
        console.log('Toggle pokemon match overlay:', data.show);
        io.emit('toggle-pokemon-match', data);
    });
    
    socket.on('toggle-prizes', (data) => {
        console.log('Toggle prizes overlay:', data.show);
        io.emit('toggle-prizes', data);
    });
    
    // Stadium events
    socket.on('stadium-update', (data) => {
        console.log('Stadium update:', data.stadium);
        overlayServer.updateStadium(data.stadium);
        io.emit('stadium-update', data);
    });
    
    // Player record events
    socket.on('record-update', (data) => {
        console.log('Record update for player', data.player, ':', data.record);
        overlayServer.updatePlayerRecord(data.player, data.record);
        io.emit('record-update', data);
    });
    
    // Match score events
    socket.on('match-score-update', (data) => {
        console.log('Match score update for player', data.player, ':', data.score);
        overlayServer.updateMatchScore(data.player, data.score);
        io.emit('match-score-update', data);
    });
    
    // Turn actions events
    socket.on('turn-actions-update', (data) => {
        console.log('Turn actions update for player', data.player, ':', data.actions);
        overlayServer.updateTurnActions(data.player, data.actions);
        io.emit('turn-actions-update', data);
    });
    
    socket.on('turn-actions-reset', () => {
        console.log('Turn actions reset');
        overlayServer.resetTurnActions();
        io.emit('turn-actions-reset');
    });
    
    // Bench size events
    socket.on('bench-size-update', (data) => {
        console.log('Bench size update for player', data.player, ':', data.size);
        overlayServer.updateBenchSize(data.player, data.size);
        io.emit('bench-size-update', data);
    });
    
    // Prize card events (alternative handling)
    socket.on('update-prizes', (data) => {
        console.log('Update prizes:', data);
        overlayServer.updatePrizes(data);
        io.emit('prizes-update', data);
    });
    
    // Decklist events
    socket.on('decklist-update', (data) => {
        console.log('Update decklist');
        overlayServer.updateDecklist(data);
        io.emit('decklist-update', data);
    });
    
    socket.on('decklist-add-card', (data) => {
        console.log('Add card to decklist:', data.card?.name);
        overlayServer.addCardToDeck(data.category, data.card);
    });
    
    socket.on('decklist-clear', () => {
        console.log('Clear decklist');
        overlayServer.clearDecklist();
        io.emit('decklist-clear');
    });

    // MTG Match events
    socket.on('mtg-life-update', (data) => {
        overlayServer.updateMTGLife(data.player, data.life);
    });

    socket.on('mtg-poison-update', (data) => {
        overlayServer.updateMTGPoison(data.player, data.poison);
    });

    socket.on('mtg-lands-update', (data) => {
        overlayServer.updateLands(data.player, data.lands);
    });

    socket.on('mtg-permanent-add', (data) => {
        overlayServer.addFeaturedPermanent(data.player, data.card);
    });

    socket.on('mtg-permanent-remove', (data) => {
        overlayServer.removeFeaturedPermanent(data.player, data.index);
    });

    socket.on('mtg-permanents-clear', (data) => {
        overlayServer.clearFeaturedPermanents(data.player);
    });

    socket.on('mtg-phase-update', (data) => {
        overlayServer.updatePhase(data.phase);
    });

    socket.on('mtg-player-name-update', (data) => {
        overlayServer.updateMTGPlayerName(data.player, data.name);
    });

    socket.on('mtg-player-record-update', (data) => {
        overlayServer.updateMTGPlayerRecord(data.player, data.record);
    });

    socket.on('mtg-games-won-update', (data) => {
        overlayServer.updateMTGGamesWon(data.player, data.gamesWon);
    });

    socket.on('mtg-turn-action', (data) => {
        overlayServer.setMTGTurnAction(data.player, data.action, data.value);
    });

    socket.on('mtg-player-switch', (data) => {
        overlayServer.switchMTGActivePlayer(data && data.activePlayer);
    });

    socket.on('mtg-format-update', (data) => {
        overlayServer.updateMTGFormat(data.format);
    });

    socket.on('mtg-timer-update', (data) => {
        overlayServer.updateMTGTimer(data.seconds);
    });

    socket.on('mtg-match-reset', () => {
        overlayServer.resetMTGMatch();
    });

    // Gundam Match events (the overlay-server mutators re-broadcast to overlays)
    socket.on('gundam-match-update', (data) => {
        overlayServer.updateGundamMatch(data);
    });

    socket.on('gundam-unit-update', (data) => {
        overlayServer.setGundamUnit(data.player, data.index, data.unit);
    });

    socket.on('gundam-unit-hp', (data) => {
        overlayServer.setGundamUnitHp(data.player, data.index, data.currentHp, data.maxHp);
    });

    socket.on('gundam-pilot-pair', (data) => {
        overlayServer.setGundamPilot(data.player, data.index, data.pilot);
    });

    socket.on('gundam-base-update', (data) => {
        overlayServer.setGundamBase(data.player, data.base);
    });

    socket.on('gundam-base-hp', (data) => {
        overlayServer.setGundamBaseHp(data.player, data.currentHp, data.maxHp);
    });

    socket.on('gundam-resource-update', (data) => {
        overlayServer.setGundamResources(data.player, data.resources);
    });

    socket.on('gundam-shield-taken', (data) => {
        if (Array.isArray(data.shieldsTaken)) overlayServer.setGundamShields(data.player, data.shieldsTaken);
        else overlayServer.takeGundamShield(data.player, data.index);
    });

    socket.on('gundam-shields-reset', () => {
        overlayServer.resetGundamShields();
    });

    socket.on('gundam-record-update', (data) => {
        overlayServer.updateGundamRecord(data.player, data.record);
    });

    socket.on('gundam-games-won-update', (data) => {
        overlayServer.updateGundamGamesWon(data.player, data.gamesWon);
    });

    socket.on('gundam-match-reset', () => {
        overlayServer.resetGundamMatch();
    });

    socket.on('toggle-gundam-match', (data) => {
        console.log('Toggle gundam match overlay:', data.show);
        io.emit('toggle-gundam-match', data);
    });

    // Yu-Gi-Oh! Match events (the overlay-server mutators re-broadcast to overlays)
    socket.on('yugioh-match-update', (data) => {
        overlayServer.updateYugiohMatch(data);
    });

    socket.on('yugioh-life-update', (data) => {
        overlayServer.updateYugiohLife(data.player, data.lifePoints);
    });

    socket.on('yugioh-monster-update', (data) => {
        overlayServer.setYugiohMonster(data.player, data.index, data.monster);
    });

    socket.on('yugioh-monster-position', (data) => {
        overlayServer.setYugiohMonsterPosition(data.player, data.index, data.position);
    });

    socket.on('yugioh-spelltrap-update', (data) => {
        overlayServer.setYugiohSpellTrap(data.player, data.index, data.card);
    });

    socket.on('yugioh-field-update', (data) => {
        overlayServer.setYugiohField(data.player, data.field);
    });

    socket.on('yugioh-counts-update', (data) => {
        overlayServer.setYugiohCounts(data.player, data.counts);
    });

    socket.on('yugioh-normal-summon', (data) => {
        overlayServer.setYugiohNormalSummon(data.player, data.used);
    });

    socket.on('yugioh-phase-update', (data) => {
        overlayServer.updateYugiohPhase(data.phase);
    });

    socket.on('yugioh-record-update', (data) => {
        overlayServer.updateYugiohRecord(data.player, data.record);
    });

    socket.on('yugioh-games-won-update', (data) => {
        overlayServer.updateYugiohGamesWon(data.player, data.gamesWon);
    });

    socket.on('yugioh-match-reset', () => {
        overlayServer.resetYugiohMatch();
    });

    socket.on('toggle-yugioh-match', (data) => {
        console.log('Toggle yugioh match overlay:', data.show);
        io.emit('toggle-yugioh-match', data);
    });

    // Handle disconnect
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        
        // Check if it was an overlay client
        const wasOverlay = overlayClients.delete(socket.id);
        const wasControl = controlClients.delete(socket.id);
        mainClients.delete(socket.id);
        
        if (wasOverlay) {
            // Check which overlay disconnected
            Object.keys(overlayStates).forEach(type => {
                // For simplicity, mark all as disconnected when any overlay disconnects
                // In production, you'd track which specific overlay each socket represents
                overlayStates[type] = false;
            });
            
            // Notify control panels
            io.emit('overlay-disconnected', 'pokemon-match');
            io.emit('overlay-disconnected', 'mtg-match');
            io.emit('overlay-disconnected', 'gundam-match');
            io.emit('overlay-disconnected', 'yugioh-match');
            
            // If no more overlays are connected, notify main clients
            if (overlayClients.size === 0) {
                io.emit('obs-status', { connected: false });
            }
        }
    });
});

// Start server (after the first-run seed install + DB init)
const PORT = config.port || 3888;

async function bootstrap() {
    // On a fresh install (no data/cardcast.db yet) try to fetch the metadata seed
    // so the user skips the live metadata-API downloads. Soft-fails to an empty DB
    // if the Release asset is unreachable; the live Download buttons still work.
    const result = await ensureSeedDatabase({ dbPath });
    if (result.installed) {
        console.log('Initialized from downloaded metadata seed database.');
    }

    db = new Database(dbPath);
    tcgApi = new TCGCSVApi(db, apiKeys);
}

bootstrap().then(() => {
server.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════╗
║          CardCast v1.0.1              ║
║     TCG Streaming Overlay Tool        ║
╚═══════════════════════════════════════╝

Server running on http://localhost:${PORT}

OBS Overlays:
  - Main: http://localhost:${PORT}/overlay
  - Prizes: http://localhost:${PORT}/prizes  
  - Decklist: http://localhost:${PORT}/decklist
  - Pokemon Match: http://localhost:${PORT}/pokemon-match
  - MTG Match: http://localhost:${PORT}/mtg-match
  - Gundam Match: http://localhost:${PORT}/gundam-match
  - Yu-Gi-Oh Match: http://localhost:${PORT}/yugioh-match

Control Panels:
  - Pokemon: http://localhost:${PORT}/pokemon-match-control
  - MTG: http://localhost:${PORT}/mtg-match-control
  - Gundam: http://localhost:${PORT}/gundam-match-control
  - Yu-Gi-Oh: http://localhost:${PORT}/yugioh-match-control

Currently Available:
  ✓ Pokemon TCG (20,000+ cards)
  ✓ Magic: The Gathering
  ✓ Yu-Gi-Oh!
  ✓ Disney Lorcana
  ✓ Digimon Card Game
  ✓ One Piece Card Game
  ✓ Gundam Card Game

Coming Soon:
  ○ Flesh and Blood
  ○ Star Wars Unlimited

Cache directory: ${path.join(__dirname, 'cache')}
Database: ${path.join(__dirname, 'data', 'cardcast.db')}

Opening browser...
`);
    
    // Auto-open browser
    const url = `http://localhost:${PORT}`;
    switch (process.platform) {
        case 'win32':
            exec(`start ${url}`);
            break;
        case 'darwin':
            exec(`open ${url}`);
            break;
        case 'linux':
            exec(`xdg-open ${url}`);
            break;
    }
});
}).catch((error) => {
    console.error('Failed to start CardCast:', error);
    process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down CardCast...');
    if (db) db.close();
    server.close();
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (error) => {
    console.error('Unhandled Rejection:', error);
});