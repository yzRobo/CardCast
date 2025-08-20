// public/js/main.js - CardCast Client-Side JavaScript
const socket = io();

// State management
let currentGame = null;
let searchResults = [];
let selectedCard = null;
let recentCards = [];
let isOBSConnected = false;

// Pokemon Match State
let pokemonMatchState = {
    player1: {
        name: 'Player 1',
        prizes: 6,
        prizesTaken: [],
        active: null,
        bench: [],
        hand: 7,
        deck: 47
    },
    player2: {
        name: 'Player 2',
        prizes: 6,
        prizesTaken: [],
        active: null,
        bench: [],
        hand: 7,
        deck: 47
    },
    currentTurn: 1,
    timerRunning: false,
    showPokemonMatch: false,
    showPrizes: false
};

// Current deck list
let currentDeckList = {
    name: 'My Deck',
    format: 'Standard',
    pokemon: [],
    trainers: [],
    energy: []
};

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    initializeEventListeners();
    loadGames();
    loadConfig();
    setupKeyboardShortcuts();
    initOBSConnection();
});

// Initialize OBS Connection monitoring
function initOBSConnection() {
    // Register as main client
    socket.emit('register-main');
    
    // Listen for OBS status updates
    socket.on('obs-status', (data) => {
        console.log('OBS status update:', data);
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
    } catch (error) {
        console.error('Error loading games:', error);
    }
}

// Create game element
function createGameElement(game) {
    const gameItem = document.createElement('div');
    gameItem.className = 'game-item';
    gameItem.dataset.game = game.id;
    
    const hasData = game.hasData && game.cardCount > 0;
    const cardCountFormatted = game.cardCount >= 1000 
        ? `${(game.cardCount / 1000).toFixed(1)}k` 
        : `${game.cardCount}`;
    
    const gameColors = {
        pokemon: 'bg-gradient-to-br from-red-500 to-red-600',
        magic: 'bg-gradient-to-br from-orange-500 to-amber-600',
        yugioh: 'bg-gradient-to-br from-yellow-500 to-yellow-600',
        lorcana: 'bg-gradient-to-br from-purple-500 to-pink-600',
        onepiece: 'bg-gradient-to-br from-red-600 to-orange-600',
        digimon: 'bg-gradient-to-br from-blue-500 to-cyan-600',
        fab: 'bg-gradient-to-br from-rose-500 to-red-600',
        starwars: 'bg-gradient-to-br from-gray-500 to-slate-600'
    };
    
    gameItem.innerHTML = `
        <div class="flex items-center gap-3 flex-1">
            <div class="avatar">
                <div class="w-10 rounded-lg ${gameColors[game.id] || 'bg-gradient-to-br from-gray-500 to-gray-600'}">
                    <span class="text-white text-lg flex items-center justify-center h-full font-bold">
                        ${game.name[0]}
                    </span>
                </div>
            </div>
            <div class="flex-1">
                <div class="font-semibold text-base-content">${game.name}</div>
                <div class="text-xs opacity-60">
                    ${hasData ? `${cardCountFormatted} cards` : 'No data'}
                </div>
            </div>
        </div>
        <div class="flex gap-2">
            ${hasData ? `
                <button class="btn btn-xs btn-primary" onclick="event.stopPropagation(); updateGameData('${game.id}')">Update</button>
                <button class="btn btn-xs btn-error btn-outline" onclick="event.stopPropagation(); deleteGameData('${game.id}')">×</button>
            ` : `
                <button class="btn btn-xs btn-secondary" onclick="event.stopPropagation(); downloadGameData('${game.id}')">Download</button>
            `}
        </div>
    `;
    
    gameItem.onclick = () => selectGame(game.id, hasData);
    
    return gameItem;
}

// Select a game
function selectGame(gameId, hasData) {
    currentGame = gameId;
    
    // Update UI
    document.querySelectorAll('.game-item').forEach(item => {
        item.classList.toggle('active', item.dataset.game === gameId);
    });
    
    // Show/hide Pokemon-specific controls
    const pokemonControls = document.getElementById('pokemonMatchControls');
    if (pokemonControls) {
        pokemonControls.style.display = gameId === 'pokemon' ? 'block' : 'none';
    }
    
    // Enable/disable search
    const searchInput = document.getElementById('searchInput');
    searchInput.disabled = !hasData;
    searchInput.placeholder = hasData 
        ? `Search ${gameId} cards...` 
        : 'Download card data first';
    
    if (hasData) {
        searchInput.focus();
    }
    
    // Clear search results
    clearSearchResults();
}

// Download game data
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

// Update game data
async function updateGameData(gameId) {
    showDownloadProgress(true);
    
    try {
        const response = await fetch(`/api/download/${gameId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ incremental: true, setCount: '3' })
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

// Delete game data
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

// Handle search
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

// Display search results
function displaySearchResults(results) {
    const resultsDiv = document.getElementById('searchResults');
    
    if (results.length === 0) {
        resultsDiv.innerHTML = '<div class="empty-state"><div class="empty-icon">🔍</div><p>No cards found</p></div>';
        return;
    }
    
    resultsDiv.innerHTML = results.map(card => `
        <div class="card-result" onclick="selectCard('${card.id}')">
            <img class="card-thumbnail" src="${card.display_image || card.local_image || card.image_url || '/images/card-back.png'}" alt="${card.name}">
            <div class="card-name">${card.name}</div>
            <div class="card-meta">${card.set_name || ''} ${card.card_number ? '#' + card.card_number : ''}</div>
        </div>
    `).join('');
}

// Select a card
async function selectCard(cardId) {
    try {
        const response = await fetch(`/api/card/${currentGame}/${cardId}`);
        selectedCard = await response.json();
        
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

// Update card preview
function updateCardPreview(card) {
    const previewDiv = document.getElementById('cardPreview');
    
    if (!card) {
        previewDiv.innerHTML = '<div class="empty-state"><div class="empty-icon">🎴</div><p>No card selected</p></div>';
        return;
    }
    
    previewDiv.innerHTML = `
        <img src="${card.display_image || card.local_image || card.image_url || '/images/card-back.png'}" alt="${card.name}">
        <div class="card-info">
            <h3>${card.name}</h3>
            <p>${card.set_name || ''} ${card.card_number ? '#' + card.card_number : ''}</p>
            ${card.hp ? `<p>HP: ${card.hp}</p>` : ''}
        </div>
    `;
}

// Add to recent cards
function addToRecentCards(card) {
    recentCards = recentCards.filter(c => c.id !== card.id);
    recentCards.unshift(card);
    recentCards = recentCards.slice(0, 5);
    updateRecentCardsDisplay();
}

// Update recent cards display
function updateRecentCardsDisplay() {
    const recentDiv = document.getElementById('recentCards');
    
    if (recentCards.length === 0) {
        recentDiv.innerHTML = '';
        return;
    }
    
    recentDiv.innerHTML = recentCards.map((card, index) => `
        <div class="recent-card" onclick="selectCard('${card.id}')" title="${card.name}">
            <img src="${card.display_image || card.local_image || card.image_url || '/images/card-back.png'}" alt="${card.name}">
        </div>
    `).join('');
}

// Display card on overlay
function displayCard(position) {
    if (!selectedCard) {
        alert('Please select a card first');
        return;
    }
    
    const cardToSend = {
        ...selectedCard,
        image_url: selectedCard.display_image || selectedCard.local_image || selectedCard.image_url
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

// Pokemon Match Functions
function updatePlayerNames() {
    const p1Name = document.getElementById('p1NameInput').value || 'Player 1';
    const p2Name = document.getElementById('p2NameInput').value || 'Player 2';
    
    pokemonMatchState.player1.name = p1Name;
    pokemonMatchState.player2.name = p2Name;
    
    socket.emit('pokemon-match-update', {
        player1: pokemonMatchState.player1,
        player2: pokemonMatchState.player2
    });
}

function setActivePokemon(playerNum) {
    if (!selectedCard) {
        alert('Please select a Pokemon card first');
        return;
    }
    
    if (currentGame !== 'pokemon') {
        alert('Please select a Pokemon card');
        return;
    }
    
    const pokemon = {
        id: selectedCard.id,
        name: selectedCard.name,
        image: selectedCard.display_image || selectedCard.local_image || selectedCard.image_url,
        maxHp: selectedCard.hp || 100,
        currentHp: selectedCard.hp || 100
    };
    
    socket.emit('active-pokemon', {
        player: playerNum,
        pokemon: pokemon
    });
    
    pokemonMatchState[`player${playerNum}`].active = pokemon;
    alert(`Set ${selectedCard.name} as Player ${playerNum}'s active Pokemon`);
}

function addToBench(playerNum) {
    if (!selectedCard) {
        alert('Please select a Pokemon card first');
        return;
    }
    
    if (currentGame !== 'pokemon') {
        alert('Please select a Pokemon card');
        return;
    }
    
    const player = pokemonMatchState[`player${playerNum}`];
    if (player.bench.length >= 5) {
        alert(`Player ${playerNum}'s bench is full!`);
        return;
    }
    
    const pokemon = {
        id: selectedCard.id,
        name: selectedCard.name,
        image: selectedCard.display_image || selectedCard.local_image || selectedCard.image_url,
        maxHp: selectedCard.hp || 100,
        currentHp: selectedCard.hp || 100
    };
    
    player.bench.push(pokemon);
    
    socket.emit('bench-update', {
        player: playerNum,
        bench: player.bench
    });
    
    alert(`Added ${selectedCard.name} to Player ${playerNum}'s bench`);
}

function clearBench(playerNum) {
    if (!confirm(`Clear Player ${playerNum}'s bench?`)) {
        return;
    }
    
    pokemonMatchState[`player${playerNum}`].bench = [];
    
    socket.emit('bench-update', {
        player: playerNum,
        bench: []
    });
}

function takePrize(playerNum) {
    const player = pokemonMatchState[`player${playerNum}`];
    
    if (player.prizesTaken.length >= 6) {
        alert(`Player ${playerNum} has already taken all prizes!`);
        return;
    }
    
    const nextPrize = player.prizesTaken.length;
    player.prizesTaken.push(nextPrize);
    player.prizes = 6 - player.prizesTaken.length;
    
    socket.emit('prize-taken', {
        player: playerNum,
        index: nextPrize
    });
    
    updatePrizeDisplay();
}

function resetPrizes() {
    if (!confirm('Reset all prize cards?')) {
        return;
    }
    
    pokemonMatchState.player1.prizes = 6;
    pokemonMatchState.player1.prizesTaken = [];
    pokemonMatchState.player2.prizes = 6;
    pokemonMatchState.player2.prizesTaken = [];
    
    socket.emit('prizes-reset');
    updatePrizeDisplay();
}

function updatePrizeDisplay() {
    const p1Count = document.getElementById('p1PrizeCount');
    const p2Count = document.getElementById('p2PrizeCount');
    
    if (p1Count) {
        p1Count.textContent = `${pokemonMatchState.player1.prizes}/6`;
    }
    if (p2Count) {
        p2Count.textContent = `${pokemonMatchState.player2.prizes}/6`;
    }
}

function switchTurn() {
    pokemonMatchState.currentTurn = pokemonMatchState.currentTurn === 1 ? 2 : 1;
    
    socket.emit('turn-switch', {
        currentTurn: pokemonMatchState.currentTurn
    });
    
    alert(`Now Player ${pokemonMatchState.currentTurn}'s turn`);
}

function toggleTimer() {
    pokemonMatchState.timerRunning = !pokemonMatchState.timerRunning;
    
    socket.emit(pokemonMatchState.timerRunning ? 'timer-start' : 'timer-pause');
}

function resetMatch() {
    if (!confirm('Reset the entire match? This will clear all Pokemon, prizes, and timer.')) {
        return;
    }
    
    pokemonMatchState = {
        player1: {
            name: document.getElementById('p1NameInput').value || 'Player 1',
            prizes: 6,
            prizesTaken: [],
            active: null,
            bench: [],
            hand: 7,
            deck: 47
        },
        player2: {
            name: document.getElementById('p2NameInput').value || 'Player 2',
            prizes: 6,
            prizesTaken: [],
            active: null,
            bench: [],
            hand: 7,
            deck: 47
        },
        currentTurn: 1,
        timerRunning: false
    };
    
    socket.emit('match-reset');
    updatePrizeDisplay();
    alert('Match reset');
}

function togglePokemonMatch() {
    pokemonMatchState.showPokemonMatch = !pokemonMatchState.showPokemonMatch;
    socket.emit('toggle-pokemon-match', { show: pokemonMatchState.showPokemonMatch });
}

function togglePrizeOverlay() {
    pokemonMatchState.showPrizes = !pokemonMatchState.showPrizes;
    socket.emit('toggle-prizes', { show: pokemonMatchState.showPrizes });
}

// Deck List Functions
function parseDeckList(deckText) {
    const lines = deckText.trim().split('\n');
    const deck = {
        pokemon: [],
        trainers: [],
        energy: []
    };
    
    let currentSection = null;
    
    lines.forEach(line => {
        line = line.trim();
        if (!line) return;
        
        // Check for section headers
        if (line.toLowerCase().includes('pokémon:') || line.toLowerCase().includes('pokemon:')) {
            currentSection = 'pokemon';
            return;
        } else if (line.toLowerCase().includes('trainer:')) {
            currentSection = 'trainers';
            return;
        } else if (line.toLowerCase().includes('energy:')) {
            currentSection = 'energy';
            return;
        }
        
        // Skip lines that are just numbers (like "Total Cards: 60")
        if (line.match(/^(Total Cards:|Pokémon:|Trainer:|Energy:)/i)) {
            return;
        }
        
        // Parse card lines - handle both formats
        // Format 1: "3 Ralts SVI 84"
        // Format 2: "3 Basic {P} Energy SVE 13"
        const match = line.match(/^(\d+)\s+(.+?)\s+([A-Z]{2,}[A-Z0-9]*)\s+(\d+)$/);
        if (match) {
            const [_, quantity, name, setCode, number] = match;
            const cleanName = name.replace(/\{.\}/g, '').replace(/Basic\s+Energy/g, 'Energy').trim();
            
            const card = {
                quantity: parseInt(quantity),
                name: cleanName,
                setCode: setCode,
                number: number,
                fullName: `${cleanName} ${setCode} ${number}`
            };
            
            if (currentSection === 'pokemon') {
                deck.pokemon.push(card);
            } else if (currentSection === 'trainers') {
                deck.trainers.push(card);
            } else if (currentSection === 'energy') {
                deck.energy.push(card);
            }
        }
    });
    
    return deck;
}

async function importDeck() {
    const deckText = document.getElementById('deckImportText').value;
    if (!deckText) {
        alert('Please paste a deck list first');
        return;
    }
    
    const deckName = document.getElementById('deckNameInput').value || 'Imported Deck';
    const deck = parseDeckList(deckText);
    
    const totalCards = 
        deck.pokemon.reduce((sum, c) => sum + c.quantity, 0) +
        deck.trainers.reduce((sum, c) => sum + c.quantity, 0) +
        deck.energy.reduce((sum, c) => sum + c.quantity, 0);
    
    if (totalCards !== 60) {
        if (!confirm(`Deck has ${totalCards} cards (should be 60). Import anyway?`)) {
            return;
        }
    }
    
    // Update current deck list
    currentDeckList = {
        name: deckName,
        format: 'Standard',
        pokemon: deck.pokemon,
        trainers: deck.trainers,
        energy: deck.energy
    };
    
    // Send to overlay
    socket.emit('decklist-update', {
        deck: {
            title: deckName,
            format: 'Standard',
            game: 'pokemon',
            categories: {
                'Pokemon': deck.pokemon,
                'Trainers': deck.trainers,
                'Energy': deck.energy
            }
        },
        show: false
    });
    
    // Clear import area
    document.getElementById('deckImportText').value = '';
    document.getElementById('deckNameInput').value = '';
    
    alert(`Imported "${deckName}" with ${deck.pokemon.length} Pokémon, ${deck.trainers.length} Trainers, ${deck.energy.length} Energy`);
}

function clearDeckImport() {
    document.getElementById('deckImportText').value = '';
    document.getElementById('deckNameInput').value = '';
}

function showDeckList() {
    socket.emit('decklist-update', {
        deck: {
            title: currentDeckList.name,
            format: 'Standard',
            game: 'pokemon',
            categories: {
                'Pokemon': currentDeckList.pokemon,
                'Trainers': currentDeckList.trainers,
                'Energy': currentDeckList.energy
            }
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
    
    // Determine category
    let category = 'pokemon';
    if (selectedCard.card_type?.includes('Trainer')) {
        category = 'trainers';
    } else if (selectedCard.card_type?.includes('Energy')) {
        category = 'energy';
    }
    
    // Find if card already exists
    const existingCard = currentDeckList[category].find(c => 
        c.name === selectedCard.name && 
        c.setCode === selectedCard.set_code
    );
    
    if (existingCard) {
        existingCard.quantity++;
    } else {
        currentDeckList[category].push({
            quantity: 1,
            name: selectedCard.name,
            setCode: selectedCard.set_code || '',
            number: selectedCard.card_number || '',
            fullName: `${selectedCard.name} ${selectedCard.set_code || ''} ${selectedCard.card_number || ''}`
        });
    }
    
    // Send update
    socket.emit('decklist-add-card', {
        category: category === 'pokemon' ? 'Pokemon' : 
                  category === 'trainers' ? 'Trainers' : 'Energy',
        card: selectedCard
    });
    
    alert(`Added ${selectedCard.name} to deck`);
}

function clearDeckList() {
    if (!confirm('Clear the entire deck list?')) {
        return;
    }
    
    currentDeckList = {
        name: 'My Deck',
        format: 'Standard',
        pokemon: [],
        trainers: [],
        energy: []
    };
    
    socket.emit('decklist-clear');
}

// Clear search results
function clearSearchResults() {
    document.getElementById('searchResults').innerHTML = 
        '<div class="empty-state"><div class="empty-icon">📦</div><p>Select a game and download card data to begin</p></div>';
    searchResults = [];
}

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

// Load config
async function loadConfig() {
    try {
        const response = await fetch('/api/config');
        const config = await response.json();
        
        // Update OBS URLs
        const port = config.port || 3888;
        document.getElementById('obsMainUrl').textContent = `http://localhost:${port}/overlay`;
        document.getElementById('obsPokemonUrl').textContent = `http://localhost:${port}/pokemon-match`;
        document.getElementById('obsPrizesUrl').textContent = `http://localhost:${port}/prizes`;
        document.getElementById('obsDecklistUrl').textContent = `http://localhost:${port}/decklist`;
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
        
        // P - Take prize for active player
        if (e.key === 'p' && currentGame === 'pokemon') {
            takePrize(pokemonMatchState.currentTurn);
        }
        
        // T - Switch turn
        if (e.key === 't' && currentGame === 'pokemon') {
            switchTurn();
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
window.updatePlayerNames = updatePlayerNames;
window.setActivePokemon = setActivePokemon;
window.addToBench = addToBench;
window.clearBench = clearBench;
window.takePrize = takePrize;
window.resetPrizes = resetPrizes;
window.switchTurn = switchTurn;
window.toggleTimer = toggleTimer;
window.resetMatch = resetMatch;
window.togglePokemonMatch = togglePokemonMatch;
window.togglePrizeOverlay = togglePrizeOverlay;
window.importDeck = importDeck;
window.clearDeckImport = clearDeckImport;
window.showDeckList = showDeckList;
window.hideDeckList = hideDeckList;
window.addSelectedToDeck = addSelectedToDeck;
window.clearDeckList = clearDeckList;