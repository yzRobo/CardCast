/**
 * CardCast Deck View Module
 * Handles deck viewing and editing for all TCGs
 */

// State management for deck view
let isDeckViewMode = false;
let currentViewedDeck = null;
let isEditMode = false;
let editingDeck = null;
let draggedCard = null;
let draggedFromCategory = null;
let draggedFromIndex = null;

/**
 * Display deck view - main entry point
 */
window.displayDeckView = async function(deck, game) {
    isDeckViewMode = true;
    currentViewedDeck = deck;
    editingDeck = JSON.parse(JSON.stringify(deck)); // Deep copy for editing
    
    // Update UI state
    document.getElementById('searchResults').classList.add('hidden');
    document.getElementById('deckView').classList.remove('hidden');
    document.getElementById('deckViewToggle').classList.remove('hidden');
    document.getElementById('mainContentCard').classList.add('deck-view-mode');
    document.getElementById('searchInput').disabled = true;
    
    // Render the deck
    await renderDeckView();
}

/**
 * Render deck view - generic across games (iterates the deck's categories).
 * Section list + order comes from the registry (getDeckSectionNames); card
 * arrays are read via getDeckCategories so any deck shape renders correctly.
 */
window.renderDeckView = async function() {
    const deck = editingDeck || currentViewedDeck;
    const cats = getDeckCategories(deck);

    // Standard sections for this game, plus any populated categories not in that list.
    const sectionNames = getDeckSectionNames(deck);
    Object.keys(cats).forEach(name => {
        if (!sectionNames.includes(name)) sectionNames.push(name);
    });

    const totalCards = deckCardCount(deck);
    let deckHTML = buildDeckHeader(deck, totalCards);

    if (isEditMode) {
        deckHTML += `
            <div class="edit-mode-indicator">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
                <span>Edit Mode - Drag cards to reorder or move between sections</span>
            </div>
        `;
    }

    for (const name of sectionNames) {
        const cards = cats[name] || [];
        const count = cards.reduce((sum, c) => sum + (c.quantity || 1), 0);
        deckHTML += `
            <div class="deck-section">
                <div class="deck-section-header">
                    <span class="deck-section-title">${name}</span>
                    <span class="deck-section-count">${count}</span>
                </div>
                <div class="deck-card-grid" id="${name}-grid">
                    ${cards.length > 0 ? await renderDeckCards(cards, deck.game, name) :
                      (isEditMode ? '<div class="empty-section">Drop cards here</div>' : '')}
                </div>
            </div>
        `;
    }

    if (isEditMode) {
        deckHTML += buildAddCardSection();
    }

    document.getElementById('deckView').innerHTML = deckHTML;
}

/**
 * Build deck header HTML
 */
function buildDeckHeader(deck, totalCards) {
    const game = deck.game;
    return `
        <div class="deck-view-header">
            <div class="deck-info">
                ${isEditMode ? 
                    `<input type="text" class="deck-name-input" id="deckNameEdit" value="${deck.name}" />` :
                    `<div class="deck-name">${deck.name}</div>`
                }
                <div class="deck-stats">
                    <div class="deck-stat">
                        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>
                        <span>${totalCards} cards</span>
                    </div>
                    <div class="deck-stat capitalize">
                        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" x2="10" y1="11" y2="11"/><line x1="8" x2="8" y1="9" y2="13"/><line x1="15" x2="15.01" y1="12" y2="12"/><line x1="18" x2="18.01" y1="10" y2="10"/><rect width="20" height="12" x="2" y="6" rx="2"/></svg>
                        <span>${game.charAt(0).toUpperCase() + game.slice(1)}</span>
                    </div>
                </div>
            </div>
            <div class="deck-actions">
                ${isEditMode ? `
                    <button class="btn btn-sm btn-success" onclick="saveDeckEdits()">Save Changes</button>
                    <button class="btn btn-sm btn-warning" onclick="cancelDeckEdit()">Cancel</button>
                ` : `
                    <button class="btn btn-sm btn-primary" onclick="sendDeckToOverlay()">Send to Overlay</button>
                    <button class="btn btn-sm btn-secondary" onclick="enterEditMode()">Edit Deck</button>
                    <button class="btn btn-sm btn-ghost" onclick="exitDeckView()">Close</button>
                `}
            </div>
        </div>
    `;
}

/**
 * Build add card section HTML
 */
function buildAddCardSection() {
    const deck = editingDeck || currentViewedDeck;

    // One option per standard section for this game (display name = storage target).
    const categoryOptions = getDeckSectionNames(deck)
        .map(name => `<option value="${name}">${name}</option>`)
        .join('');

    return `
        <div class="add-card-section show">
            <h3 class="text-lg font-semibold mb-3">Add Cards</h3>
            <div class="flex gap-2 mb-3">
                <input type="text" 
                       id="addCardSearch" 
                       class="input input-bordered flex-1" 
                       placeholder="Search for cards to add..."
                       onkeyup="searchCardsToAdd(event)">
                <select id="addCardCategory" class="select select-bordered">
                    ${categoryOptions}
                </select>
            </div>
            <div id="addCardResults" class="add-card-results">
                <!-- Search results will appear here -->
            </div>
        </div>
    `;
}

/**
 * Render individual deck cards
 */
async function renderDeckCards(cards, game, category) {
    let cardsHTML = '';
    
    for (let i = 0; i < cards.length; i++) {
        const card = cards[i];
        let cardImage = '/images/card-back.png';
        
        try {
            let searchQuery = '';
            
            if (card.setCode && card.number) {
                searchQuery = `${card.name} ${card.setCode.toUpperCase()} ${card.number}`;
            } else if (card.setCode) {
                searchQuery = `${card.name} ${card.setCode.toUpperCase()}`;
            } else {
                searchQuery = card.name;
            }
            
            const response = await fetch(`/api/search/${game}?q=${encodeURIComponent(searchQuery)}`);
            const results = await response.json();
            
            if (results.length > 0) {
                let matchedCard = null;
                if (card.setCode && card.number) {
                    matchedCard = results.find(r => 
                        r.set_abbreviation === card.setCode.toUpperCase() && 
                        r.card_number === card.number
                    );
                }
                
                if (!matchedCard) {
                    matchedCard = results[0];
                }
                
                if (matchedCard) {
                    cardImage = matchedCard.image_url || cardImage;
                }
            }
        } catch (error) {
            console.error(`Error fetching card image for ${card.name}:`, error);
        }
        
        const cardTitle = card.setCode ? 
            `${card.name} (${card.setCode} ${card.number || ''})` : 
            card.name;
        
        if (isEditMode) {
            cardsHTML += `
                <div class="deck-card-item edit-mode" 
                    draggable="true"
                    ondragstart="handleCardDragStart(event, '${category}', ${i})"
                    ondragend="handleCardDragEnd(event)"
                    ondragover="event.preventDefault()"
                    data-category="${category}"
                    data-index="${i}"
                    title="${cardTitle}">
                    <div class="deck-card-controls">
                        <button class="deck-card-control-btn" onclick="event.stopPropagation(); adjustCardQuantity('${category}', ${i}, -1)">−</button>
                        <span style="color: white; font-size: 0.875rem;">${card.quantity}</span>
                        <button class="deck-card-control-btn" onclick="event.stopPropagation(); adjustCardQuantity('${category}', ${i}, 1)">+</button>
                        <button class="deck-card-control-btn remove" onclick="event.stopPropagation(); removeCardFromDeck('${category}', ${i})">×</button>
                    </div>
                    <img src="${cardImage}" alt="${cardTitle}" class="deck-card-image" draggable="false" />
                    ${card.quantity > 1 ? `<div class="deck-card-quantity">${card.quantity}</div>` : ''}
                </div>
            `;
        } else {
            cardsHTML += `
                <div class="deck-card-item" title="${cardTitle}">
                    <img src="${cardImage}" alt="${cardTitle}" class="deck-card-image" />
                    ${card.quantity > 1 ? `<div class="deck-card-quantity">${card.quantity}</div>` : ''}
                </div>
            `;
        }
    }
    
    return cardsHTML;
}

/**
 * Exit deck view mode
 */
window.exitDeckView = function() {
    isDeckViewMode = false;
    currentViewedDeck = null;
    isEditMode = false;
    editingDeck = null;
    
    // Reset UI state
    document.getElementById('searchResults').classList.remove('hidden');
    document.getElementById('deckView').classList.add('hidden');
    document.getElementById('deckViewToggle').classList.add('hidden');
    document.getElementById('mainContentCard').classList.remove('deck-view-mode');
    
    // Re-enable search if game is selected
    if (window.currentGame) {
        document.getElementById('searchInput').disabled = false;
    }
    
    // Clear deck view content
    document.getElementById('deckView').innerHTML = '';
}

/**
 * Enter edit mode
 */
window.enterEditMode = function() {
    isEditMode = true;
    editingDeck = JSON.parse(JSON.stringify(currentViewedDeck));
    renderDeckView();
}

/**
 * Cancel deck edit
 */
window.cancelDeckEdit = function() {
    isEditMode = false;
    editingDeck = null;
    renderDeckView();
}

/**
 * Save deck edits
 */
window.saveDeckEdits = function() {
    const newName = document.getElementById('deckNameEdit').value.trim();
    if (!newName) {
        alert('Deck name cannot be empty');
        return;
    }
    
    editingDeck.name = newName;
    
    const game = editingDeck.game;
    const oldName = currentViewedDeck.name;
    
    // Get savedDecks from window scope
    if (window.savedDecks && window.savedDecks[game]) {
        const deckIndex = window.savedDecks[game].findIndex(d => d.name === oldName);
        if (deckIndex > -1) {
            window.savedDecks[game][deckIndex] = editingDeck;
            localStorage.setItem('savedDecks', JSON.stringify(window.savedDecks));
            
            currentViewedDeck = JSON.parse(JSON.stringify(editingDeck));
            window.currentImportedDeck = currentViewedDeck;
            
            isEditMode = false;
            editingDeck = null;
            
            if (window.updateSavedDecksList) {
                window.updateSavedDecksList();
            }
            renderDeckView();
            
            alert('Deck saved successfully!');
        }
    }
}

/**
 * Adjust card quantity
 */
window.adjustCardQuantity = function(category, index, delta) {
    const card = getDeckCategoryArray(editingDeck, category)[index];
    if (!card) return;
    const limit = (GAME_REGISTRY[editingDeck.game]?.deck?.rules?.copyLimit) || 4;
    card.quantity = Math.max(1, Math.min(limit, card.quantity + delta));
    renderDeckView();
}

/**
 * Remove card from deck
 */
window.removeCardFromDeck = function(category, index) {
    getDeckCategoryArray(editingDeck, category).splice(index, 1);
    renderDeckView();
}

/**
 * Search cards to add
 */
window.searchCardsToAdd = async function(event) {
    const query = event.target.value.trim();
    if (query.length < 2) {
        document.getElementById('addCardResults').innerHTML = '';
        return;
    }
    
    const game = editingDeck.game;
    
    try {
        const response = await fetch(`/api/search/${game}?q=${encodeURIComponent(query)}`);
        const results = await response.json();
        
        const resultsHTML = results.slice(0, 24).map(card => `
            <div class="add-card-result" 
                 onclick="addCardToDeck('${card.name.replace(/'/g, "\\'")}', '${card.image_url || '/images/card-back.png'}')">
                <img src="${card.image_url || '/images/card-back.png'}" 
                     alt="${card.name}"
                     title="${card.name}">
            </div>
        `).join('');
        
        document.getElementById('addCardResults').innerHTML = resultsHTML || '<p class="col-span-full text-center opacity-50">No cards found</p>';
    } catch (error) {
        console.error('Error searching cards:', error);
    }
}

/**
 * Add card to deck
 */
window.addCardToDeck = function(cardName, cardImage) {
    const category = document.getElementById('addCardCategory').value;
    const arr = getDeckCategoryArray(editingDeck, category);

    const existingCard = arr.find(c => c.name === cardName);
    const limit = (GAME_REGISTRY[editingDeck.game]?.deck?.rules?.copyLimit) || 4;

    if (existingCard) {
        if (existingCard.quantity < limit) {
            existingCard.quantity++;
        } else {
            alert(`Maximum ${limit} copies of a card allowed`);
            return;
        }
    } else {
        arr.push({
            name: cardName,
            quantity: 1
        });
    }

    document.getElementById('addCardSearch').value = '';
    document.getElementById('addCardResults').innerHTML = '';
    
    renderDeckView();
}

/**
 * Send deck to overlay
 */
window.sendDeckToOverlay = function() {
    if (!currentViewedDeck) return;
    
    if (window.socket) {
        window.socket.emit('decklist-update', {
            deck: currentViewedDeck,
            show: true
        });
        
        alert('Deck sent to overlay!');
    }
}

/**
 * Drag and drop handlers
 */
window.handleCardDragStart = function(event, category, index) {
    const arr = editingDeck ? getDeckCategoryArray(editingDeck, category) : null;
    if (!arr || !arr[index]) {
        console.error('Invalid drag start:', category, index);
        return;
    }

    draggedCard = arr[index];
    draggedFromCategory = category;
    draggedFromIndex = index;
    event.target.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', '');
}

window.handleCardDragEnd = function(event) {
    event.target.classList.remove('dragging');
    
    document.querySelectorAll('.drag-over').forEach(el => {
        el.classList.remove('drag-over');
    });
}

window.handleDragOver = function(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    
    const grid = event.currentTarget;
    grid.classList.add('drag-over');
}

window.handleDragLeave = function(event) {
    event.currentTarget.classList.remove('drag-over');
}

window.handleDrop = function(event, targetCategory) {
    event.preventDefault();
    event.currentTarget.classList.remove('drag-over');
    
    if (!draggedCard || !draggedFromCategory || draggedFromIndex === null) return;

    const targetArr = getDeckCategoryArray(editingDeck, targetCategory);
    const fromArr = getDeckCategoryArray(editingDeck, draggedFromCategory);

    const targetElement = event.target.closest('.deck-card-item');
    let targetIndex = targetArr.length;

    if (targetElement && targetElement.dataset.category === targetCategory) {
        targetIndex = parseInt(targetElement.dataset.index) || 0;

        const rect = targetElement.getBoundingClientRect();
        const midpoint = rect.left + rect.width / 2;
        if (event.clientX > midpoint) {
            targetIndex++;
        }
    }

    if (draggedFromCategory === targetCategory) {
        const [removed] = fromArr.splice(draggedFromIndex, 1);

        if (targetIndex > draggedFromIndex) {
            targetIndex--;
        }

        targetArr.splice(targetIndex, 0, removed);
    } else {
        const [removed] = fromArr.splice(draggedFromIndex, 1);
        targetArr.splice(targetIndex, 0, removed);
    }

    draggedCard = null;
    draggedFromCategory = null;
    draggedFromIndex = null;
    
    renderDeckView();
}