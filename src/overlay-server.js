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
        
        // Add Pokemon Match state
        this.pokemonMatch = {
            player1: {
                name: 'Player 1',
                active: null,
                bench: [],
                benchSize: 5,
                prizes: 6,
                prizesTaken: [],
                record: { wins: 0, losses: 0, ties: 0 },
                matchScore: 0,
                turnActions: { energy: false, supporter: false, retreat: false }
            },
            player2: {
                name: 'Player 2',
                active: null,
                bench: [],
                benchSize: 5,
                prizes: 6,
                prizesTaken: [],
                record: { wins: 0, losses: 0, ties: 0 },
                matchScore: 0,
                turnActions: { energy: false, supporter: false, retreat: false }
            },
            currentTurn: 1,
            timer: { minutes: 50, seconds: 0 },
            gameNumber: 1,
            matchFormat: 'Best of 3',
            stadium: ''
        };
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
        
        // Update regular prize cards
        if (this.prizeCards[playerKey] && !this.prizeCards[playerKey].taken.includes(index)) {
            this.prizeCards[playerKey].taken.push(index);
        }
        
        // Update Pokemon match prizes
        if (this.pokemonMatch[playerKey]) {
            if (!this.pokemonMatch[playerKey].prizesTaken.includes(index)) {
                this.pokemonMatch[playerKey].prizesTaken.push(index);
                this.pokemonMatch[playerKey].prizes = 6 - this.pokemonMatch[playerKey].prizesTaken.length;
            }
        }
        
        this.io.emit('prize-taken', {
            player: player,
            index: index,
            remaining: 6 - this.pokemonMatch[playerKey].prizesTaken.length,
            timestamp: Date.now()
        });
    }
    
    resetPrizes() {
        this.prizeCards = {
            player1: { total: 6, taken: [] },
            player2: { total: 6, taken: [] }
        };
        
        this.pokemonMatch.player1.prizesTaken = [];
        this.pokemonMatch.player1.prizes = 6;
        this.pokemonMatch.player2.prizesTaken = [];
        this.pokemonMatch.player2.prizes = 6;
        
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
    
    // NEW METHODS FOR POKEMON MATCH FEATURES
    
    // Stadium management
    updateStadium(stadium) {
        this.pokemonMatch.stadium = stadium;
        this.io.emit('stadium-update', {
            stadium: stadium,
            timestamp: Date.now()
        });
    }
    
    // Player record management
    updatePlayerRecord(player, record) {
        const playerKey = `player${player}`;
        if (this.pokemonMatch[playerKey]) {
            this.pokemonMatch[playerKey].record = record;
        }
        this.io.emit('record-update', {
            player: player,
            record: record,
            timestamp: Date.now()
        });
    }
    
    // Match score management
    updateMatchScore(player, score) {
        const playerKey = `player${player}`;
        if (this.pokemonMatch[playerKey]) {
            this.pokemonMatch[playerKey].matchScore = score;
        }
        this.io.emit('match-score-update', {
            player: player,
            score: score,
            timestamp: Date.now()
        });
    }
    
    // Turn actions management
    updateTurnActions(player, actions) {
        const playerKey = `player${player}`;
        if (this.pokemonMatch[playerKey]) {
            this.pokemonMatch[playerKey].turnActions = actions;
        }
        this.io.emit('turn-actions-update', {
            player: player,
            actions: actions,
            timestamp: Date.now()
        });
    }
    
    resetTurnActions() {
        this.pokemonMatch.player1.turnActions = { energy: false, supporter: false, retreat: false };
        this.pokemonMatch.player2.turnActions = { energy: false, supporter: false, retreat: false };
        this.io.emit('turn-actions-reset', {
            timestamp: Date.now()
        });
    }
    
    // Bench size management
    updateBenchSize(player, size) {
        const playerKey = `player${player}`;
        if (this.pokemonMatch[playerKey]) {
            this.pokemonMatch[playerKey].benchSize = size;
        }
        this.io.emit('bench-size-update', {
            player: player,
            size: size,
            timestamp: Date.now()
        });
    }
    
    // Update Pokemon match state
    updatePokemonMatch(data) {
        if (data.player1) {
            this.pokemonMatch.player1 = { ...this.pokemonMatch.player1, ...data.player1 };
        }
        if (data.player2) {
            this.pokemonMatch.player2 = { ...this.pokemonMatch.player2, ...data.player2 };
        }
        if (data.stadium !== undefined) {
            this.pokemonMatch.stadium = data.stadium;
        }
        
        this.io.emit('pokemon-match-update', data);
    }
    
    // Active Pokemon management
    updateActivePokemon(player, pokemon) {
        const playerKey = `player${player}`;
        if (this.pokemonMatch[playerKey]) {
            this.pokemonMatch[playerKey].active = pokemon;
        }
        this.io.emit('active-pokemon', {
            player: player,
            pokemon: pokemon,
            timestamp: Date.now()
        });
    }
    
    // Bench management
    updateBench(player, bench) {
        const playerKey = `player${player}`;
        if (this.pokemonMatch[playerKey]) {
            this.pokemonMatch[playerKey].bench = bench;
        }
        this.io.emit('bench-update', {
            player: player,
            bench: bench,
            timestamp: Date.now()
        });
    }
    
    getState() {
        return {
            currentCards: this.currentCards,
            prizeCards: this.prizeCards,
            decklist: this.decklist,
            settings: this.overlaySettings,
            gameSettings: this.gameSettings,
            pokemonMatch: this.pokemonMatch  // Include Pokemon match state
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
        this.pokemonMatch.player1.name = player1;
        this.pokemonMatch.player2.name = player2;
        
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