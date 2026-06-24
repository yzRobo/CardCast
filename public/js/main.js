// public/js/main.js - CardCast Client-Side JavaScript
const socket = io();

// State management
let currentGame = null;
let searchResults = [];
let selectedCard = null;
let recentCards = [];
let isOBSConnected = false;
// Map of gameId -> hasData, populated by loadGames; used by the header dropdown.
let gameHasData = {};
// Server port for OBS overlay URLs (refreshed from /api/config in loadConfig).
let serverPort = window.location.port || '3888';

// Build an OBS-friendly overlay URL for a route (e.g. '/overlay').
function overlayUrl(route) {
    return `http://localhost:${serverPort}${route}`;
}

// Current deck list - generic, keyed by the active game's registry categories
// (e.g. { Pokemon: [...], Trainers: [...] } or { Creatures: [...], Lands: [...] }).
let currentDeckList = {
    name: 'My Deck',
    format: 'Standard',
    categories: {}
};

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    initializeEventListeners();
    loadConfig();
    setupKeyboardShortcuts();
    initOBSConnection();

    // Auto-select a sensible default game once the list has ACTUALLY loaded.
    // loadGames() is async (it fetches /api/games, renders the tiles, and fills
    // gameHasData), so hook the auto-select to its resolution rather than a fixed
    // timer. A fixed 500ms delay raced the fetch: on a fresh install the seed DB
    // is freshly written and the first query can take longer than that, so the
    // timer fired before any tiles existed, selected nothing, and left the search
    // box permanently disabled with no way in. Prefer the first game that has
    // data; fall back to the first selectable game so a fresh install still lands
    // somewhere usable. loadGames() swallows its own errors, so it always
    // resolves and this callback always runs.
    loadGames().then(() => {
        const selectable = [...document.querySelectorAll('.game-item[data-game]')]
            .filter(item => item.style.opacity !== '0.6');
        if (!selectable.length) return;
        const withData = selectable.find(item => gameHasData[item.dataset.game]);
        (withData || selectable[0]).click();
    });
});

// Initialize OBS Connection monitoring
function initOBSConnection() {
    // Register as main client
    socket.emit('register-main');
    
    // Listen for OBS status updates
    socket.on('obs-status', (data) => {
        updateOBSStatus(data.connected);
    });
    
    // Check status periodically
    setInterval(() => {
        socket.emit('check-obs-status');
    }, 3000);
    
    // Initial check
    socket.emit('check-obs-status');
}

// Update OBS connection status UI
function updateOBSStatus(connected) {
    isOBSConnected = connected;
    const statusElement = document.getElementById('obsStatus');
    const statusIndicator = statusElement.querySelector('.status-indicator');
    const statusText = statusElement.querySelector('.status-text');
    
    if (connected) {
        statusElement.classList.add('connected');
        statusText.textContent = 'OBS Connected';
    } else {
        statusElement.classList.remove('connected');
        statusText.textContent = 'OBS Not Connected';
    }
}

// Initialize event listeners
function initializeEventListeners() {
    // Search input
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.addEventListener('input', debounce(handleSearch, 300));
    }
    
    // Display buttons
    const displayLeftBtn = document.getElementById('displayLeft');
    const displayRightBtn = document.getElementById('displayRight');
    if (displayLeftBtn) {
        displayLeftBtn.addEventListener('click', () => displayCard('left'));
    }
    if (displayRightBtn) {
        displayRightBtn.addEventListener('click', () => displayCard('right'));
    }
    
    // Clear display button
    const clearDisplayBtn = document.getElementById('clearDisplay');
    if (clearDisplayBtn) {
        clearDisplayBtn.addEventListener('click', clearDisplay);
    }

    // Header game selector (kept in sync with the sidebar list; both call selectGame)
    const gameSelect = document.getElementById('gameSelect');
    if (gameSelect) {
        gameSelect.addEventListener('change', (e) => {
            const id = e.target.value;
            if (id) selectGame(id, gameHasData[id]);
        });
    }
    
    // Copy buttons
    document.querySelectorAll('.copy-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const targetId = e.target.dataset.copy;
            copyToClipboard(targetId);
        });
    });
}

// Load games list
async function loadGames() {
    try {
        const response = await fetch('/api/games');
        const games = await response.json();
        
        const gamesList = document.getElementById('gamesList');
        gamesList.innerHTML = '';

        games.forEach(game => {
            const gameItem = createGameElement(game);
            gamesList.appendChild(gameItem);
        });

        // Keep the header dropdown in sync with the sidebar list
        populateGameSelect(games);
    } catch (error) {
        console.error('Error loading games:', error);
    }
}

// Populate the header game-selector dropdown from the same /api/games data.
// Coming-soon games are disabled; games without data stay selectable but are
// marked "(no data)" so the dropdown is still usable on a fresh install.
function populateGameSelect(games) {
    const sel = document.getElementById('gameSelect');
    if (!sel) return;

    gameHasData = {};
    const opts = ['<option value="" disabled>Select a game...</option>'];
    games.forEach(game => {
        const available = game.available && !game.comingSoon;
        const hasData = !!(game.hasData && game.cardCount > 0);
        gameHasData[game.id] = hasData;
        const suffix = !available ? ' (coming soon)' : (hasData ? '' : ' (no data)');
        opts.push(`<option value="${game.id}"${available ? '' : ' disabled'}>${game.name}${suffix}</option>`);
    });
    sel.innerHTML = opts.join('');
    if (currentGame) sel.value = currentGame;
}

// Create game element - UPDATED FOR COMING SOON
function createGameElement(game) {
    console.log('Creating element for:', game.id, 'available:', game.available, 'comingSoon:', game.comingSoon);
    
    const gameItem = document.createElement('div');
    gameItem.className = 'game-item';
    gameItem.dataset.game = game.id;
    
    // Check if game is available based on API data
    const isAvailable = game.available && !game.comingSoon;
    const hasData = game.hasData && game.cardCount > 0;
    const cardCountFormatted = game.cardCount >= 1000
        ? `${(game.cardCount / 1000).toFixed(1)}k`
        : `${game.cardCount}`;

    // Image cache progress (how many card images are cached vs total available).
    const fmtCount = (nn) => nn >= 1000 ? `${(nn / 1000).toFixed(1)}k` : `${nn}`;
    const totalImages = game.totalImages || 0;
    const cachedImages = Math.min(game.cachedImages || 0, totalImages);
    const imagesLabel = totalImages > 0
        ? (cachedImages >= totalImages
            ? `all ${fmtCount(totalImages)} imgs cached`
            : `${fmtCount(cachedImages)}/${fmtCount(totalImages)} imgs cached`)
        : '';

    const gameColors = {
        pokemon: 'bg-gradient-to-br from-red-500 to-red-600',
        magic: 'bg-gradient-to-br from-orange-500 to-amber-600',
        yugioh: 'bg-gradient-to-br from-yellow-500 to-yellow-600',
        lorcana: 'bg-gradient-to-br from-purple-500 to-pink-600',
        onepiece: 'bg-gradient-to-br from-red-600 to-orange-600',
        digimon: 'bg-gradient-to-br from-blue-500 to-cyan-600',
        gundam: 'bg-gradient-to-br from-sky-600 to-indigo-700',
        fab: 'bg-gradient-to-br from-rose-500 to-red-600',
        starwars: 'bg-gradient-to-br from-gray-500 to-slate-600'
    };
    
    // Add opacity for unavailable games
    if (!isAvailable) {
        gameItem.style.opacity = '0.6';
        gameItem.style.cursor = 'not-allowed';
    }
    
    // Determine button HTML based on availability
    let buttonHTML = '';
    if (!isAvailable) {
        // Not available - show Coming Soon
        buttonHTML = '<span class="badge badge-neutral badge-sm">Coming Soon</span>';
    } else if (hasData) {
        // Available with data - show Update, Images and Delete
        buttonHTML = `
            <button class="btn btn-xs btn-primary flex-1" onclick="event.stopPropagation(); updateGameData('${game.id}')">Update</button>
            <button class="btn btn-xs btn-ghost border border-base-content/15 flex-1" onclick="event.stopPropagation(); prefetchImages('${game.id}')" title="Pre-download all card images so they are cached for offline / no-hitch use">Images</button>
            <button class="btn btn-xs btn-square btn-ghost text-error/80 hover:text-error hover:bg-error/10" onclick="event.stopPropagation(); deleteGameData('${game.id}')" title="Delete downloaded data">
                <svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
        `;
    } else {
        // Available without data - show Download
        buttonHTML = `<button class="btn btn-xs btn-secondary w-full" onclick="event.stopPropagation(); downloadGameData('${game.id}')">Download</button>`;
    }

    gameItem.innerHTML = `
        <div class="flex items-center gap-2.5 min-w-0">
            <div class="w-9 h-9 shrink-0 rounded-lg flex items-center justify-center text-white text-base font-bold shadow ${gameColors[game.id] || 'bg-gradient-to-br from-gray-500 to-gray-600'}">
                ${game.name[0]}
            </div>
            <div class="min-w-0 flex-1">
                <div class="game-title truncate">${game.name}</div>
                <div class="game-subtitle truncate" title="${hasData && imagesLabel ? `${cardCountFormatted} cards, ${imagesLabel}` : ''}">
                    ${!isAvailable ? 'Coming Soon' : (hasData ? `${cardCountFormatted} cards${imagesLabel ? ` &middot; ${imagesLabel}` : ''}` : 'No data')}
                </div>
            </div>
        </div>
        <div class="flex items-center gap-1.5">
            ${buttonHTML}
        </div>
    `;
    
    // Set click handler
    if (isAvailable) {
        gameItem.onclick = () => selectGame(game.id, hasData);
    } else {
        gameItem.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            showToast(`${game.name} support is coming soon!`);
        };
    }
    
    return gameItem;
}

// Select a game - single data-driven switcher backed by GAME_REGISTRY.
// Rebuilds every game-specific panel so switching games never leaves another
// game's links/controls on screen.
function selectGame(gameId, hasData) {
    // Coming-soon guard (unavailable games are dimmed in the list)
    const gameElement = document.querySelector(`.game-item[data-game="${gameId}"]`);
    if (gameElement && gameElement.style.opacity === '0.6') {
        showToast(`${gameId.charAt(0).toUpperCase() + gameId.slice(1)} support is coming soon!`);
        return;
    }

    currentGame = gameId;
    const cfg = getGameConfig(gameId);

    // Highlight the active game in the sidebar list
    document.querySelectorAll('.game-item').forEach(item => {
        item.classList.toggle('active', item.dataset.game === gameId);
    });

    // Rebuild the per-game panels from the registry
    renderMatchControls(gameId);
    renderObsSources(gameId);

    // Keep the deck-import game selector in sync with the chosen game
    const deckGameSelect = document.getElementById('deckGameSelect');
    if (deckGameSelect) deckGameSelect.value = gameId;

    // Keep the header dropdown in sync (so sidebar clicks update it too)
    const gameSelect = document.getElementById('gameSelect');
    if (gameSelect) gameSelect.value = gameId;

    // Enable/disable search + per-game placeholder
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.disabled = !hasData;
        searchInput.placeholder = hasData
            ? `Search ${cfg.name} cards...`
            : 'Download card data first';
        if (hasData) searchInput.focus();
    }

    // Leaving a game should drop any open deck view
    if (typeof isDeckViewMode !== 'undefined' && isDeckViewMode && typeof exitDeckView === 'function') {
        exitDeckView();
    }

    // Reset the results pane for the new game
    clearSearchResults();

    // Re-apply the "search imported cards only" filter if it's on
    const deckOnly = document.getElementById('searchDeckOnly');
    if (deckOnly && deckOnly.checked && typeof updateSearchToDeckOnly === 'function') {
        updateSearchToDeckOnly();
    }

    // Refilter the saved-decks list to this game's decks
    if (typeof updateSavedDecksList === 'function') updateSavedDecksList();
}

// Render the Match Controls panel buttons for a game from the registry.
function renderMatchControls(gameId) {
    const list = document.getElementById('matchControlsList');
    if (!list) return;

    const controls = getGameConfig(gameId).matchControls;
    if (!controls.length) {
        list.innerHTML = `
            <p class="text-xs text-center text-base-content/40 pt-1">
                No dedicated match controls for this game yet
            </p>`;
        return;
    }

    list.innerHTML = controls.map(c => `
        <button onclick="window.open('${c.route}', '_blank')" class="btn btn-sm ${c.style || 'btn-primary'} w-full gap-2 justify-start">
            <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>
            ${c.label}
        </button>
    `).join('');
}

// Render the OBS Browser Sources list for a game from the registry.
function renderObsSources(gameId) {
    const list = document.getElementById('obsSourcesList');
    if (!list) return;

    const overlays = getGameConfig(gameId || currentGame).overlays;
    list.innerHTML = overlays.map(o => {
        const url = overlayUrl(o.route);
        return `
            <div class="bg-base-300/60 border border-white/5 p-2 rounded-lg">
                <div class="flex justify-between items-center gap-2">
                    <div class="min-w-0">
                        <p class="text-xs text-base-content/50">${o.label}</p>
                        <p class="text-xs font-mono truncate">${url}</p>
                    </div>
                    <button class="btn btn-ghost btn-xs copy-btn shrink-0" data-copy-url="${url}">Copy</button>
                </div>
            </div>`;
    }).join('');

    // Wire the freshly-rendered copy buttons (innerHTML drops old listeners).
    list.querySelectorAll('.copy-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            navigator.clipboard.writeText(btn.dataset.copyUrl).then(() => {
                const original = btn.textContent;
                btn.textContent = 'Copied!';
                setTimeout(() => { btn.textContent = original; }, 1500);
            });
        });
    });
}

// Download game data - UPDATED FOR COMING SOON
async function downloadGameData(gameId) {

    const setCount = document.querySelector('input[name="sets"]:checked')?.value || '1';
    showDownloadProgress(true);
    
    try {
        const response = await fetch(`/api/download/${gameId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ incremental: false, setCount })
        });
        
        if (!response.ok) {
            throw new Error('Download failed');
        }
    } catch (error) {
        console.error('Download error:', error);
        showDownloadProgress(false);
        alert('Failed to start download');
    }
}

// Update game data - UPDATED FOR COMING SOON
async function updateGameData(gameId) {    
    const setCount = document.querySelector('input[name="sets"]:checked')?.value || '3';
    showDownloadProgress(true);
    
    try {
        const response = await fetch(`/api/download/${gameId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ incremental: true, setCount })
        });
        
        if (!response.ok) {
            throw new Error('Update failed');
        }
    } catch (error) {
        console.error('Update error:', error);
        showDownloadProgress(false);
        alert('Failed to start update');
    }
}

// Pre-download all card images for a game (optional cache warming). The work runs
// in the background on the server; progress arrives over the image-download-* socket
// events and reuses the shared download progress bar.
async function prefetchImages(gameId) {
    const setCount = document.querySelector('input[name="sets"]:checked')?.value || '1';
    showDownloadProgress(true);

    try {
        const response = await fetch(`/api/download-images/${gameId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ setCount })
        });

        if (!response.ok) {
            throw new Error('Image pre-download failed to start');
        }
        const scope = setCount === 'all'
            ? 'all sets'
            : `newest ${setCount} set${setCount === '1' ? '' : 's'}`;
        showToast(`Caching ${gameId} images (${scope}) in the background...`);
    } catch (error) {
        console.error('Image pre-download error:', error);
        showDownloadProgress(false);
        alert('Failed to start image pre-download');
    }
}

// Delete game data - UPDATED FOR COMING SOON
async function deleteGameData(gameId) {
    if (!confirm(`Delete all data for ${gameId}?\n\nThis action cannot be undone.`)) {
        return;
    }
    
    try {
        const response = await fetch(`/api/games/${gameId}/data`, {
            method: 'DELETE'
        });
        
        if (response.ok) {
            loadGames();
            if (currentGame === gameId) {
                currentGame = null;
                clearSearchResults();
            }
        }
    } catch (error) {
        console.error('Delete error:', error);
        alert('Failed to delete data');
    }
}

// Handle search - UPDATED FOR COMING SOON
async function handleSearch(event) {
    const query = event.target.value.trim();
    
    if (!currentGame || query.length < 2) {
        clearSearchResults();
        return;
    }
        
    try {
        const response = await fetch(`/api/search/${currentGame}?q=${encodeURIComponent(query)}`);
        searchResults = await response.json();
        displaySearchResults(searchResults);
    } catch (error) {
        console.error('Search error:', error);
    }
}

// Display search results, card preview, recent cards, and the cleared-results
// state are all rendered by the registry-aware window.* overrides defined in
// index.html (window.displaySearchResults / window.updateCardPreview /
// window.updateRecentCardsDisplay / window.clearSearchResults). Those overrides
// supersede any local copies, so they are intentionally not duplicated here.

// Select a card
async function selectCard(cardId) {
    try {
        const response = await fetch(`/api/card/${currentGame}/${cardId}`);
        selectedCard = await response.json();
        
        // Ensure selectedCard has a usable image_url
        if (!selectedCard.image_url && selectedCard.display_image) {
            selectedCard.image_url = selectedCard.display_image;
        }
        
        // Update preview
        updateCardPreview(selectedCard);
        
        // Add to recent cards
        addToRecentCards(selectedCard);
        
        // Enable display buttons
        document.getElementById('displayLeft').disabled = false;
        document.getElementById('displayRight').disabled = false;
        
    } catch (error) {
        console.error('Error loading card:', error);
    }
}

// Add to recent cards (updateRecentCardsDisplay is provided by the registry-aware
// window.* override in index.html; the local definition was removed as dead code).
function addToRecentCards(card) {
    recentCards = recentCards.filter(c => c.id !== card.id);
    recentCards.unshift(card);
    recentCards = recentCards.slice(0, 5);
    updateRecentCardsDisplay();
}

// Display card on overlay
function displayCard(position) {
    if (!selectedCard) {
        alert('Please select a card first');
        return;
    }
    
    const cardToSend = {
        ...selectedCard,
        image_url: selectedCard.image_url  // Already has the correct path
    };
    
    socket.emit('display-card', {
        card: cardToSend,
        position: position,
        game: currentGame
    });
    
    // Visual feedback
    const btn = document.getElementById(`display${position.charAt(0).toUpperCase() + position.slice(1)}`);
    btn.classList.add('success');
    setTimeout(() => btn.classList.remove('success'), 1000);
}

// Clear display
function clearDisplay() {
    socket.emit('clear-display');
    
    // Visual feedback
    const btn = document.getElementById('clearDisplay');
    btn.classList.add('success');
    setTimeout(() => btn.classList.remove('success'), 1000);
}

async function importDeck() {
    const deckText = document.getElementById('deckImportText').value;
    if (!deckText) {
        alert('Please paste a deck list first');
        return;
    }

    const deckName = document.getElementById('deckNameInput').value || 'Imported Deck';

    // parseDeckList auto-detects the game and returns a game-specific shape;
    // deckToCategories normalizes ALL of them to { CategoryName: [cards] } and,
    // for Magic, resolves each card's type against the local DB so it buckets
    // into Creatures / Spells / Artifacts / Enchantments / Planeswalkers / Lands.
    const parsed = await parseDeckList(deckText);
    const { game, categories } = await deckToCategories(parsed);

    const catCount = (arr) => arr.reduce((s, c) => s + (c.quantity || 1), 0);
    const totalCards = Object.values(categories).reduce((sum, arr) => sum + catCount(arr), 0);

    // Soft-warn against the active game's main-deck size. Most games compare the
    // whole deck to a single number (e.g. 60); games with separate Extra/Side
    // decks (Yu-Gi-Oh) use a [min,max] range applied to the main categories only.
    const rules = getGameConfig(game).deck?.rules;
    const target = rules?.main;
    if (target) {
        // Categories that form a SEPARATE deck and must not count toward the main-deck
        // size: Yu-Gi-Oh Extra/Side, Digimon Digi-Egg, Gundam Resources, One Piece Leader.
        const SECONDARY_CATS = new Set(['Extra', 'Side', 'Digi-Egg', 'Resources', 'Leader']);
        const hasSideDecks = ['extra', 'side', 'egg', 'resources', 'leader'].some(k => rules[k] !== undefined);
        const mainCount = hasSideDecks
            ? Object.entries(categories)
                .filter(([name]) => !SECONDARY_CATS.has(name))
                .reduce((sum, [, arr]) => sum + catCount(arr), 0)
            : totalCards;
        const ok = Array.isArray(target)
            ? (mainCount >= target[0] && mainCount <= target[1])
            : (mainCount === target);
        if (!ok) {
            const want = Array.isArray(target) ? `${target[0]}-${target[1]}` : target;
            if (!confirm(`Main deck has ${mainCount} cards (should be ${want}). Import anyway?`)) {
                return;
            }
        }
    }

    currentDeckList = { name: deckName, format: 'Standard', game, categories };

    socket.emit('decklist-update', {
        deck: { title: deckName, format: 'Standard', game, categories },
        show: false
    });

    document.getElementById('deckImportText').value = '';
    document.getElementById('deckNameInput').value = '';

    const summary = Object.entries(categories)
        .map(([name, arr]) => `${arr.reduce((s, c) => s + (c.quantity || 1), 0)} ${name}`)
        .join(', ');
    alert(`Imported "${deckName}" (${summary})`);
}

// Normalize any parsed-deck shape to { game, categories: { Name: [cards] } }.
//   Pokemon: { pokemon, trainers, energy }
//   Gundam:  { categories: {...} }  (already generic)
//   Magic:   { cards, sideboard }   -> resolve types against the DB and bucket
async function deckToCategories(parsed) {
    // Gundam / Yu-Gi-Oh (and any future parser) already return the generic shape.
    // They tag their own game id; default to gundam for older callers.
    if (parsed.categories && typeof parsed.categories === 'object') {
        return { game: parsed.game || 'gundam', categories: parsed.categories };
    }

    // Pokemon shape.
    if (parsed.pokemon || parsed.trainers || parsed.energy) {
        const categories = {};
        if (parsed.pokemon && parsed.pokemon.length) categories.Pokemon = parsed.pokemon;
        if (parsed.trainers && parsed.trainers.length) categories.Trainers = parsed.trainers;
        if (parsed.energy && parsed.energy.length) categories.Energy = parsed.energy;
        return { game: 'pokemon', categories };
    }

    // Magic shape.
    if (parsed.cards || parsed.sideboard) {
        return { game: 'magic', categories: await mtgToCategories(parsed) };
    }

    return { game: currentGame, categories: {} };
}

// Bucket an imported MTG deck into the registry's type categories by resolving
// each card's type_line against the local DB (cached per name). Unresolved
// cards fall back to the registry's default bucket; the sideboard is kept separate.
async function mtgToCategories(parsed) {
    const categorize = getGameConfig('magic').deck.categorize;
    const categories = {};
    const add = (cat, card) => { (categories[cat] = categories[cat] || []).push(card); };
    const typeCache = {};

    for (const card of (parsed.cards || [])) {
        if (!(card.name in typeCache)) typeCache[card.name] = await resolveMagicCardType(card.name);
        add(categorize(typeCache[card.name] || { card_type: '', type_line: '' }), card);
    }

    if (parsed.sideboard && parsed.sideboard.length) categories.Sideboard = parsed.sideboard;
    return categories;
}

// Look up a Magic card by name in the local DB; returns the fields the registry
// categorize() needs (card_type / type_line), or null if nothing matches.
//
// The /api/search projection does NOT include type_line, so we resolve the full
// card row via /api/card/<game>/<id> (which is SELECT *), giving categorize a real
// type_line in addition to card_type. The search-result fields are used as a
// fallback if the full-card fetch fails, so this never regresses below card_type.
async function resolveMagicCardType(name) {
    try {
        const res = await fetch(`/api/search/magic?q=${encodeURIComponent(name)}&limit=10`);
        const cards = await res.json();
        if (!Array.isArray(cards) || !cards.length) return null;
        const match = cards.find(c => (c.name || '').toLowerCase() === name.toLowerCase()) || cards[0];

        // Resolve the full card so type_line (omitted by the search projection)
        // is available alongside card_type.
        if (match.id != null) {
            try {
                const fullRes = await fetch(`/api/card/magic/${encodeURIComponent(match.id)}`);
                if (fullRes.ok) {
                    const full = await fullRes.json();
                    if (full && !full.error) {
                        return { card_type: full.card_type, type_line: full.type_line };
                    }
                }
            } catch (_) {
                // fall through to the search-result fields below
            }
        }

        return { card_type: match.card_type, type_line: match.type_line };
    } catch (err) {
        console.error('MTG type resolve failed for', name, err);
        return null;
    }
}

function clearDeckImport() {
    document.getElementById('deckImportText').value = '';
    document.getElementById('deckNameInput').value = '';
}

function showDeckList() {
    socket.emit('decklist-update', {
        deck: {
            title: currentDeckList.name,
            format: currentDeckList.format || 'Standard',
            game: currentDeckList.game || currentGame,
            categories: currentDeckList.categories || {}
        },
        show: true
    });
}

function hideDeckList() {
    socket.emit('decklist-update', {
        deck: currentDeckList,
        show: false
    });
}

function addSelectedToDeck() {
    if (!selectedCard) {
        alert('Please select a card first');
        return;
    }

    // Bucket the card into the active game's category via the registry.
    const cfg = getGameConfig(currentGame);
    if (!cfg.deck) {
        showToast(`Deck building is not set up for ${cfg.name || 'this game'} yet`);
        return;
    }
    const category = cfg.deck.categorize(selectedCard);

    if (!currentDeckList.categories) currentDeckList.categories = {};
    if (!currentDeckList.categories[category]) currentDeckList.categories[category] = [];
    const bucket = currentDeckList.categories[category];

    // Find if card already exists
    const existingCard = bucket.find(c =>
        c.name === selectedCard.name &&
        c.setCode === (selectedCard.set_code || '')
    );

    if (existingCard) {
        existingCard.quantity++;
    } else {
        bucket.push({
            quantity: 1,
            name: selectedCard.name,
            setCode: selectedCard.set_code || '',
            number: selectedCard.card_number || '',
            fullName: `${selectedCard.name} ${selectedCard.set_code || ''} ${selectedCard.card_number || ''}`.trim()
        });
    }

    // Send update (category is the registry label, e.g. 'Pokemon' / 'Creatures')
    socket.emit('decklist-add-card', { category, card: selectedCard });

    showToast(`Added ${selectedCard.name} to ${category}`);
}

function clearDeckList() {
    if (!confirm('Clear the entire deck list?')) {
        return;
    }
    
    currentDeckList = {
        name: 'My Deck',
        format: 'Standard',
        categories: {}
    };

    socket.emit('decklist-clear');
}

// clearSearchResults is provided by the registry-aware window.* override in
// index.html (it also resets the searchResults array); the local duplicate was
// removed as dead code.

// Copy to clipboard
function copyToClipboard(elementId) {
    const element = document.getElementById(elementId);
    const text = element.textContent;
    
    navigator.clipboard.writeText(text).then(() => {
        const btn = event.target;
        const originalText = btn.textContent;
        btn.textContent = 'Copied!';
        btn.classList.add('success');
        setTimeout(() => {
            btn.textContent = originalText;
            btn.classList.remove('success');
        }, 1500);
    });
}

// Show/hide download progress
function showDownloadProgress(show) {
    const progress = document.getElementById('downloadProgress');
    if (show) {
        progress.classList.add('active');
    } else {
        progress.classList.remove('active');
    }
}

// Toast notification function - NEW
function showToast(message) {
    // Check if toast container exists, if not create it
    let toastContainer = document.getElementById('toast-container');
    if (!toastContainer) {
        toastContainer = document.createElement('div');
        toastContainer.id = 'toast-container';
        toastContainer.className = 'toast toast-top toast-end';
        document.body.appendChild(toastContainer);
    }
    
    // Create toast element
    const toast = document.createElement('div');
    toast.className = 'alert alert-info';
    toast.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="stroke-current shrink-0 w-6 h-6">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
        </svg>
        <span>${message}</span>
    `;
    
    toastContainer.appendChild(toast);
    
    // Remove toast after 3 seconds
    setTimeout(() => {
        toast.remove();
    }, 3000);
}

// Load config
async function loadConfig() {
    try {
        const response = await fetch('/api/config');
        const config = await response.json();
        
        // OBS Browser Sources are rendered per game from the registry; just
        // refresh the port and re-render the current game's links.
        serverPort = config.port || serverPort;
        if (currentGame) renderObsSources(currentGame);
    } catch (error) {
        console.error('Error loading config:', error);
    }
}

// Keyboard shortcuts
function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        // Ctrl+F - Focus search
        if (e.ctrlKey && e.key === 'f') {
            e.preventDefault();
            const searchInput = document.getElementById('searchInput');
            if (!searchInput.disabled) {
                searchInput.focus();
            }
        }
        
        // Escape - Clear search
        if (e.key === 'Escape') {
            clearSearchResults();
            document.getElementById('searchInput').value = '';
        }
        
        // Ctrl+1-5 - Select recent cards
        if (e.ctrlKey && e.key >= '1' && e.key <= '5') {
            const index = parseInt(e.key) - 1;
            if (recentCards[index]) {
                selectCard(recentCards[index].id);
            }
        }
        
    });
}

// Socket event listeners
socket.on('download-progress', (data) => {
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');
    
    if (progressFill && progressText) {
        progressFill.style.width = `${data.progress}%`;
        progressText.textContent = `${data.progress}% - ${data.message || ''}`;
    }
});

socket.on('download-complete', (data) => {
    showDownloadProgress(false);
    loadGames();
    
    if (data.incremental) {
        alert(data.cardCount > 0 
            ? `Added ${data.cardCount} new cards for ${data.game}` 
            : `No new cards found for ${data.game}`);
    } else {
        alert(`Downloaded ${data.cardCount} cards for ${data.game}`);
    }
});

socket.on('download-error', (data) => {
    showDownloadProgress(false);
    alert(`Download failed: ${data.error}`);
});

socket.on('image-download-progress', (data) => {
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');

    if (progressFill && progressText) {
        progressFill.style.width = `${data.progress}%`;
        progressText.textContent = `${data.progress}% - ${data.message || ''}`;
    }
});

socket.on('image-download-complete', (data) => {
    showDownloadProgress(false);
    const msg = (data.total === 0)
        ? `${data.game}: selected sets are already cached`
        : `Image cache ready for ${data.game}: ${data.downloaded} downloaded, ${data.skipped} already cached${data.failed ? `, ${data.failed} failed` : ''}`;
    showToast(msg);
    // Refresh the game cards so the cached/total image counts update.
    loadGames();
});

socket.on('image-download-error', (data) => {
    showDownloadProgress(false);
    alert(`Image pre-download failed: ${data.error}`);
});

// Utility: Debounce function
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// Make functions globally available for onclick handlers
window.selectCard = selectCard;
window.importDeck = importDeck;
window.clearDeckImport = clearDeckImport;
window.showDeckList = showDeckList;
window.hideDeckList = hideDeckList;
window.addSelectedToDeck = addSelectedToDeck;
window.clearDeckList = clearDeckList;
window.downloadGameData = downloadGameData;
window.updateGameData = updateGameData;
window.prefetchImages = prefetchImages;
window.deleteGameData = deleteGameData;
window.selectGame = selectGame;

// Add CSS for toast layering
const style = document.createElement('style');
style.textContent = `
    .toast {
        z-index: 9999;
    }
`;
document.head.appendChild(style);