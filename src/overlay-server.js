// src/overlay-server.js - CardCast Overlay Manager
class OverlayServer {
    constructor(io) {
        this.io = io;
        this.currentCards = {
            left: null,
            right: null
        };
        this.prizeCards = {
            player1: { total: 6, taken: [] },
            player2: { total: 6, taken: [] }
        };
        this.decklist = {
            title: 'My Deck',
            format: 'Standard',
            game: 'pokemon',
            categories: {}
        };
        this.overlaySettings = {
            theme: 'championship',
            showAnimations: true,
            cardDisplayDuration: 0,
            position: 'bottom-center'
        };
        this.gameSettings = {};
    }
    
    updateCard(cardData, position = 'left') {
        this.currentCards[position] = cardData;
        this.io.emit('card-update', {
            card: cardData,
            position: position,
            settings: this.overlaySettings,
            timestamp: Date.now()
        });
    }
    
    clearCard(position = 'both') {
        if (position === 'both') {
            this.currentCards.left = null;
            this.currentCards.right = null;
        } else {
            this.currentCards[position] = null;
        }
        
        this.io.emit('card-clear', {
            position: position,
            timestamp: Date.now()
        });
    }
    
    updatePrizes(data) {
        if (data.player1) {
            this.prizeCards.player1 = data.player1;
        }
        if (data.player2) {
            this.prizeCards.player2 = data.player2;
        }
        
        this.io.emit('prizes-update', {
            ...this.prizeCards,
            game: data.game,
            show: data.show !== undefined ? data.show : true,
            timestamp: Date.now()
        });
    }
    
    takePrize(player, index) {
        const playerKey = `player${player}`;
        if (this.prizeCards[playerKey] && !this.prizeCards[playerKey].taken.includes(index)) {
            this.prizeCards[playerKey].taken.push(index);
            
            this.io.emit('prize-taken', {
                player: player,
                index: index,
                remaining: this.prizeCards[playerKey].total - this.prizeCards[playerKey].taken.length,
                timestamp: Date.now()
            });
        }
    }
    
    resetPrizes() {
        this.prizeCards = {
            player1: { total: 6, taken: [] },
            player2: { total: 6, taken: [] }
        };
        
        this.io.emit('prizes-reset', {
            ...this.prizeCards,
            timestamp: Date.now()
        });
    }
    
    updateDecklist(deckData) {
        if (deckData.deck) {
            this.decklist = { ...this.decklist, ...deckData.deck };
        }
        
        this.io.emit('decklist-update', {
            deck: this.decklist,
            show: deckData.show !== undefined ? deckData.show : true,
            timestamp: Date.now()
        });
    }
    
    addCardToDeck(category, card) {
        if (!this.decklist.categories[category]) {
            this.decklist.categories[category] = [];
        }
        
        // Check if card already exists and increment quantity
        const existingCard = this.decklist.categories[category].find(c => c.name === card.name);
        if (existingCard) {
            existingCard.quantity = (existingCard.quantity || 1) + 1;
        } else {
            this.decklist.categories[category].push({ ...card, quantity: 1 });
        }
        
        this.io.emit('decklist-add-card', {
            category: category,
            card: card,
            timestamp: Date.now()
        });
        
        // Also emit full update for sync
        this.updateDecklist({ deck: this.decklist, show: true });
    }
    
    removeCardFromDeck(category, cardName) {
        if (this.decklist.categories[category]) {
            const cardIndex = this.decklist.categories[category].findIndex(c => c.name === cardName);
            if (cardIndex !== -1) {
                const card = this.decklist.categories[category][cardIndex];
                if (card.quantity > 1) {
                    card.quantity--;
                } else {
                    this.decklist.categories[category].splice(cardIndex, 1);
                }
                
                this.io.emit('decklist-remove-card', {
                    category: category,
                    cardName: cardName,
                    timestamp: Date.now()
                });
                
                this.updateDecklist({ deck: this.decklist, show: true });
            }
        }
    }
    
    clearDecklist() {
        this.decklist.categories = {};
        this.io.emit('decklist-clear', {
            timestamp: Date.now()
        });
    }
    
    updateSettings(settings) {
        this.overlaySettings = { ...this.overlaySettings, ...settings };
        this.io.emit('settings-update', {
            settings: this.overlaySettings,
            timestamp: Date.now()
        });
    }
    
    getState() {
        return {
            currentCards: this.currentCards,
            prizeCards: this.prizeCards,
            decklist: this.decklist,
            settings: this.overlaySettings,
            gameSettings: this.gameSettings
        };
    }
    
    // Handle different game-specific overlay features
    setupGameOverlay(game) {
        const gameConfigs = {
            pokemon: {
                showPrizes: true,
                prizeCount: 6,
                showBench: true,
                showEnergy: true,
                showStadium: true,
                categories: ['Pokemon', 'Trainer', 'Energy']
            },
            magic: {
                showLife: true,
                lifeTotal: 20,
                showCommander: true,
                showGraveyard: true,
                showExile: true,
                showMana: true,
                categories: ['Creatures', 'Spells', 'Artifacts', 'Enchantments', 'Planeswalkers', 'Lands']
            },
            yugioh: {
                showLifePoints: true,
                lifeTotal: 8000,
                showGraveyard: true,
                showExtraDeck: true,
                showBanished: true,
                showFieldZones: true,
                categories: ['Monsters', 'Spells', 'Traps', 'Extra Deck']
            },
            lorcana: {
                showInkwell: true,
                showLore: true,
                loreToWin: 20,
                showCharacters: true,
                showItems: true,
                categories: ['Characters', 'Actions', 'Items', 'Locations']
            },
            onepiece: {
                showLife: true,
                lifeTotal: 4,
                showDonDeck: true,
                showTrash: true,
                showLeader: true,
                categories: ['Characters', 'Events', 'Stages', 'Leaders']
            },
            digimon: {
                showMemory: true,
                memoryGauge: 10,
                showBreedingArea: true,
                showSecurity: true,
                securityCount: 5,
                categories: ['Digimon', 'Tamers', 'Options']
            },
            fab: {
                showLife: true,
                lifeTotal: 40,
                showPitch: true,
                showArsenal: true,
                showChainLink: true,
                categories: ['Attacks', 'Reactions', 'Equipment', 'Instants']
            },
            starwars: {
                showResources: true,
                showBase: true,
                baseHealth: 30,
                showLeader: true,
                showDiscard: true,
                categories: ['Units', 'Events', 'Upgrades', 'Leaders']
            }
        };
        
        this.gameSettings = gameConfigs[game] || {};
        
        // Update decklist categories for the game
        if (this.gameSettings.categories) {
            // Initialize empty categories
            const newCategories = {};
            this.gameSettings.categories.forEach(cat => {
                newCategories[cat] = this.decklist.categories[cat] || [];
            });
            this.decklist.categories = newCategories;
        }
        
        this.io.emit('game-setup', {
            game: game,
            settings: this.gameSettings,
            timestamp: Date.now()
        });
        
        return this.gameSettings;
    }
    
    // Handle match state
    updateMatchState(state) {
        this.io.emit('match-state', {
            state: state,
            timestamp: Date.now()
        });
    }
    
    // Player names
    updatePlayerNames(player1, player2) {
        this.io.emit('player-names', {
            player1: player1,
            player2: player2,
            timestamp: Date.now()
        });
    }
    
    // Score tracking
    updateScore(player1Score, player2Score) {
        this.io.emit('score-update', {
            player1: player1Score,
            player2: player2Score,
            timestamp: Date.now()
        });
    }
    
    // Timer functionality
    startTimer(duration = 50 * 60) { // 50 minutes default
        this.io.emit('timer-start', {
            duration: duration,
            timestamp: Date.now()
        });
    }
    
    pauseTimer() {
        this.io.emit('timer-pause', {
            timestamp: Date.now()
        });
    }
    
    resetTimer() {
        this.io.emit('timer-reset', {
            timestamp: Date.now()
        });
    }
}

module.exports = OverlayServer;