// public/js/main.js - CardCast Client-Side JavaScript
const socket = io();

// State management
let currentGame = 'pokemon';
let searchResults = [];
let selectedCard = null;
let recentCards = [];
let currentDeck = {
    title: 'My Deck',
    format: 'Standard',
    game: 'pokemon',
    categories: {}
};

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    initializeEventListeners();
    loadGames();
    loadConfig();
    setupKeyboardShortcuts();
});

// Initialize event listeners
function initializeEventListeners() {
    // Search input
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.addEventListener('input', debounce(handleSearch, 300));
        searchInput.addEventListener('focus', () => {
            document.getElementById('searchResults').style.display = 'block';
        });
    }
    
    // Clear search button
    const clearSearchBtn = document.getElementById('clearSearch');
    if (clearSearchBtn) {
        clearSearchBtn.addEventListener('click', clearSearch);
    }
    
    // Display position buttons
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
    
    // Prize card controls
    const showPrizesBtn = document.getElementById('showPrizes');
    const hidePrizesBtn = document.getElementById('hidePrizes');
    if (showPrizesBtn) {
        showPrizesBtn.addEventListener('click', showPrizes);
    }
    if (hidePrizesBtn) {
        hidePrizesBtn.addEventListener('click', hidePrizes);
    }
    
    // Decklist controls
    const addToDeckBtn = document.getElementById('addToDeck');
    const showDecklistBtn = document.getElementById('showDecklist');
    const hideDecklistBtn = document.getElementById('hideDecklist');
    const clearDecklistBtn = document.getElementById('clearDecklist');
    
    if (addToDeckBtn) {
        addToDeckBtn.addEventListener('click', addCardToDeck);
    }
    if (showDecklistBtn) {
        showDecklistBtn.addEventListener('click', showDecklist);
    }
    if (hideDecklistBtn) {
        hideDecklistBtn.addEventListener('click', hideDecklist);
    }
    if (clearDecklistBtn) {
        clearDecklistBtn.addEventListener('click', clearDecklist);
    }
    
    // Click outside to close search results
    document.addEventListener('click', (e) => {
        const searchContainer = document.querySelector('.search-section');
        if (!searchContainer.contains(e.target)) {
            document.getElementById('searchResults').style.display = 'none';
        }
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
            const gameItem = document.createElement('div');
            gameItem.className = `game-item ${game.id === currentGame ? 'active' : ''}`;
            gameItem.dataset.game = game.id;
            
            gameItem.innerHTML = `
                <div class="game-header">
                    <span class="game-name">${game.name}</span>
                    ${game.hasData ? '<span class="game-status">✓</span>' : ''}
                </div>
                <div class="game-actions">
                    ${!game.hasData ? 
                        `<button class="btn-download" onclick="downloadGameData('${game.id}')">
                            Download Data
                        </button>` : 
                        `<button class="btn-update" onclick="downloadGameData('${game.id}')">
                            Update
                        </button>`
                    }
                </div>
                <div class="download-progress" id="progress-${game.id}" style="display: none;">
                    <div class="progress-bar">
                        <div class="progress-fill"></div>
                    </div>
                    <span class="progress-text">0%</span>
                </div>
            `;
            
            gameItem.addEventListener('click', (e) => {
                if (!e.target.closest('button')) {
                    selectGame(game.id);
                }
            });
            
            gamesList.appendChild(gameItem);
        });
    } catch (error) {
        console.error('Error loading games:', error);
    }
}

// Select a game
function selectGame(gameId) {
    currentGame = gameId;
    currentDeck.game = gameId;
    
    // Update UI
    document.querySelectorAll('.game-item').forEach(item => {
        item.classList.toggle('active', item.dataset.game === gameId);
    });
    
    // Clear search
    clearSearch();
    
    // Update placeholder
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.placeholder = `Search ${gameId} cards...`;
    }
}

// Download game data
async function downloadGameData(gameId) {
    try {
        const progressDiv = document.getElementById(`progress-${gameId}`);
        progressDiv.style.display = 'block';
        
        const response = await fetch(`/api/download/${gameId}`, { method: 'POST' });
        const result = await response.json();
        
        if (result.error) {
            alert(`Error: ${result.error}`);
            progressDiv.style.display = 'none';
        }
    } catch (error) {
        console.error('Error downloading game data:', error);
        alert('Failed to start download');
    }
}

// Handle search
async function handleSearch(event) {
    const query = event.target.value.trim();
    
    if (query.length < 2) {
        document.getElementById('searchResults').innerHTML = '';
        return;
    }
    
    try {
        const response = await fetch(`/api/search/${currentGame}?q=${encodeURIComponent(query)}`);
        searchResults = await response.json();
        
        displaySearchResults(searchResults);
    } catch (error) {
        console.error('Error searching:', error);
    }
}

// Display search results
function displaySearchResults(results) {
    const resultsDiv = document.getElementById('searchResults');
    
    if (results.length === 0) {
        resultsDiv.innerHTML = '<div class="no-results">No cards found</div>';
        return;
    }
    
    resultsDiv.innerHTML = results.map(card => `
        <div class="search-result" onclick="selectCard('${card.id}')">
            <img src="${card.image_url || '/images/card-back.png'}" alt="${card.name}">
            <div class="result-info">
                <div class="result-name">${card.name}</div>
                <div class="result-details">
                    ${card.set_name || ''} 
                    ${card.card_number ? `#${card.card_number}` : ''}
                    ${card.rarity ? `• ${card.rarity}` : ''}
                </div>
            </div>
        </div>
    `).join('');
    
    resultsDiv.style.display = 'block';
}

// Select a card
async function selectCard(cardId) {
    try {
        const response = await fetch(`/api/card/${currentGame}/${cardId}`);
        selectedCard = await response.json();
        
        // Update preview
        updateCardPreview(selectedCard);
        
        // Hide search results
        document.getElementById('searchResults').style.display = 'none';
        
        // Add to recent cards
        addToRecentCards(selectedCard);
        
    } catch (error) {
        console.error('Error loading card:', error);
    }
}

// Update card preview
function updateCardPreview(card) {
    const previewDiv = document.getElementById('cardPreview');
    
    if (!card) {
        previewDiv.innerHTML = '<div class="no-preview">No card selected</div>';
        return;
    }
    
    previewDiv.innerHTML = `
        <img src="${card.image_url || '/images/card-back.png'}" alt="${card.name}">
        <div class="preview-info">
            <h3>${card.name}</h3>
            <div class="preview-details">
                ${card.set_name || ''} ${card.card_number ? `#${card.card_number}` : ''}
            </div>
            ${card.card_text ? `<div class="preview-text">${card.card_text}</div>` : ''}
        </div>
    `;
}

// Add to recent cards
function addToRecentCards(card) {
    // Remove if already exists
    recentCards = recentCards.filter(c => c.id !== card.id);
    
    // Add to beginning
    recentCards.unshift(card);
    
    // Keep only last 5
    recentCards = recentCards.slice(0, 5);
    
    // Update UI
    updateRecentCards();
}

// Update recent cards display
function updateRecentCards() {
    const recentDiv = document.getElementById('recentCards');
    
    if (recentCards.length === 0) {
        recentDiv.innerHTML = '<div class="no-recent">No recent cards</div>';
        return;
    }
    
    recentDiv.innerHTML = recentCards.map((card, index) => `
        <div class="recent-card" onclick="selectCard('${card.id}')" title="${card.name}">
            <img src="${card.image_url || '/images/card-back.png'}" alt="${card.name}">
            <span class="recent-number">${index + 1}</span>
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
    const btn = position === 'left' ? 
        document.getElementById('displayLeft') : 
        document.getElementById('displayRight');
    
    btn.classList.add('success');
    setTimeout(() => btn.classList.remove('success'), 1000);
}

// Clear display
function clearDisplay() {
    socket.emit('clear-display');
}

// Clear search
function clearSearch() {
    document.getElementById('searchInput').value = '';
    document.getElementById('searchResults').innerHTML = '';
    document.getElementById('searchResults').style.display = 'none';
}

// Prize card functions
function showPrizes() {
    socket.emit('update-prizes', {
        game: currentGame,
        player1: { total: 6, taken: [] },
        player2: { total: 6, taken: [] },
        show: true
    });
}

function hidePrizes() {
    socket.emit('update-prizes', { show: false });
}

// Decklist functions
function addCardToDeck() {
    if (!selectedCard) {
        alert('Please select a card first');
        return;
    }
    
    const category = determineCardCategory(selectedCard);
    socket.emit('decklist-add-card', {
        category: category,
        card: {
            name: selectedCard.name,
            cost: selectedCard.attributes?.cost || '',
            quantity: 1
        }
    });
    
    // Visual feedback
    const btn = document.getElementById('addToDeck');
    btn.classList.add('success');
    setTimeout(() => btn.classList.remove('success'), 1000);
}

function determineCardCategory(card) {
    const type = (card.card_type || '').toLowerCase();
    
    if (currentGame === 'pokemon') {
        if (type.includes('pokemon')) return 'Pokemon';
        if (type.includes('trainer')) return 'Trainer';
        if (type.includes('energy')) return 'Energy';
        return 'Other';
    } else if (currentGame === 'magic') {
        if (type.includes('creature')) return 'Creatures';
        if (type.includes('instant') || type.includes('sorcery')) return 'Spells';
        if (type.includes('land')) return 'Lands';
        if (type.includes('enchantment')) return 'Enchantments';
        if (type.includes('artifact')) return 'Artifacts';
        if (type.includes('planeswalker')) return 'Planeswalkers';
        return 'Other';
    } else if (currentGame === 'yugioh') {
        if (type.includes('monster')) return 'Monsters';
        if (type.includes('spell')) return 'Spells';
        if (type.includes('trap')) return 'Traps';
        return 'Other';
    }
    
    return 'Cards';
}

function showDecklist() {
    socket.emit('decklist-update', {
        deck: currentDeck,
        show: true
    });
}

function hideDecklist() {
    socket.emit('decklist-update', { show: false });
}

function clearDecklist() {
    currentDeck.categories = {};
    socket.emit('decklist-clear');
}

// Load config
async function loadConfig() {
    try {
        const response = await fetch('/api/config');
        const config = await response.json();
        
        // Update OBS URLs
        document.getElementById('obsMainUrl').value = `http://localhost:${config.port}/overlay`;
        document.getElementById('obsPrizesUrl').value = `http://localhost:${config.port}/prizes`;
        document.getElementById('obsDecklistUrl').value = `http://localhost:${config.port}/decklist`;
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
            document.getElementById('searchInput').focus();
        }
        
        // Escape - Clear search
        if (e.key === 'Escape') {
            clearSearch();
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
    const progressDiv = document.getElementById(`progress-${data.game}`);
    const progressFill = progressDiv.querySelector('.progress-fill');
    const progressText = progressDiv.querySelector('.progress-text');
    
    progressFill.style.width = `${data.progress}%`;
    progressText.textContent = `${data.progress}%`;
});

socket.on('download-complete', (data) => {
    const progressDiv = document.getElementById(`progress-${data.game}`);
    progressDiv.style.display = 'none';
    loadGames(); // Reload games to update status
    alert(`${data.game} data download complete!`);
});

socket.on('download-error', (data) => {
    const progressDiv = document.getElementById(`progress-${data.game}`);
    progressDiv.style.display = 'none';
    alert(`Error downloading ${data.game}: ${data.error}`);
});

// Utility functions
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