// public/js/main.js - CardCast Client-Side JavaScript
const socket = io();

// State management
let currentGame = null;
let searchResults = [];
let selectedCard = null;
let recentCards = [];
let isOBSConnected = false;

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
    
    const gameInfo = document.createElement('div');
    gameInfo.className = 'game-info';
    
    const gameIcon = document.createElement('div');
    gameIcon.className = `game-icon ${game.id}`;
    gameIcon.textContent = game.name[0];
    
    const gameName = document.createElement('span');
    gameName.className = 'game-name';
    gameName.textContent = game.name;
    
    gameInfo.appendChild(gameIcon);
    gameInfo.appendChild(gameName);
    
    const gameStatus = document.createElement('div');
    gameStatus.className = 'game-status';
    
    if (game.hasData && game.cardCount > 0) {
        const cardCount = document.createElement('span');
        cardCount.className = 'card-count';
        // Format large numbers more compactly
        if (game.cardCount >= 1000) {
            cardCount.textContent = `${(game.cardCount / 1000).toFixed(1)}k`;
        } else {
            cardCount.textContent = `${game.cardCount}`;
        }
        cardCount.title = `${game.cardCount.toLocaleString()} cards`;
        gameStatus.appendChild(cardCount);
        
        const updateBtn = document.createElement('button');
        updateBtn.className = 'update-btn';
        updateBtn.textContent = 'Update';
        updateBtn.title = 'Check for new cards';
        updateBtn.onclick = (e) => {
            e.stopPropagation();
            updateGameData(game.id);
        };
        gameStatus.appendChild(updateBtn);
        
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'delete-btn';
        deleteBtn.innerHTML = '×';  // Use × instead of emoji for better sizing
        deleteBtn.title = 'Delete all data';
        deleteBtn.onclick = (e) => {
            e.stopPropagation();
            deleteGameData(game.id);
        };
        gameStatus.appendChild(deleteBtn);
    } else {
        const downloadBtn = document.createElement('button');
        downloadBtn.className = 'download-btn';
        downloadBtn.textContent = 'Download';
        downloadBtn.title = 'Download card data';
        downloadBtn.onclick = (e) => {
            e.stopPropagation();
            downloadGameData(game.id);
        };
        gameStatus.appendChild(downloadBtn);
    }
    
    gameItem.appendChild(gameInfo);
    gameItem.appendChild(gameStatus);
    
    gameItem.onclick = () => selectGame(game.id, game.hasData && game.cardCount > 0);
    
    return gameItem;
}

// Select a game
function selectGame(gameId, hasData) {
    currentGame = gameId;
    
    // Update UI
    document.querySelectorAll('.game-item').forEach(item => {
        item.classList.toggle('active', item.dataset.game === gameId);
    });
    
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
            <img class="card-thumbnail" src="${card.image_url || '/images/card-back.png'}" alt="${card.name}">
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
        <img src="${card.image_url || '/images/card-back.png'}" alt="${card.name}">
        <div class="card-info">
            <h3>${card.name}</h3>
            <p>${card.set_name || ''} ${card.card_number ? '#' + card.card_number : ''}</p>
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
            <img src="${card.image_url || '/images/card-back.png'}" alt="${card.name}">
        </div>
    `).join('');
}

// Display card on overlay
function displayCard(position) {
    if (!selectedCard) {
        alert('Please select a card first');
        return;
    }
    
    socket.emit('display-card', {
        card: selectedCard,
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