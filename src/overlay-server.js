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

        // MTG Match State
        this.mtgMatch = {
            player1: {
                name: 'Player 1',
                record: '0-0-0',
                gamesWon: 0,
                life: 20,
                commanderDamage: {},
                lands: 0,
                featuredPermanents: [],
                turnActions: {
                    landPlayed: false,
                    spellCast: false
                }
            },
            player2: {
                name: 'Player 2',
                record: '0-0-0',
                gamesWon: 0,
                life: 20,
                commanderDamage: {},
                lands: 0,
                featuredPermanents: [],
                turnActions: {
                    landPlayed: false,
                    spellCast: false
                }
            },
            activePlayer: 1,
            currentPhase: 'main1',
            timer: 0,
            format: 'standard'
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
        
        if (this.prizeCards[playerKey] && !this.prizeCards[playerKey].taken.includes(index)) {
            this.prizeCards[playerKey].taken.push(index);
        }
        
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

    // ============ MTG MATCH METHODS ============
    
    resetMTGMatch() {
        const p1Name = this.mtgMatch.player1.name;
        const p2Name = this.mtgMatch.player2.name;
        
        this.mtgMatch = {
            player1: {
                name: p1Name,
                record: '0-0-0',
                gamesWon: 0,
                life: this.mtgMatch.format === 'commander' ? 40 : 20,
                commanderDamage: {},
                lands: 0,
                featuredPermanents: [],
                turnActions: { landPlayed: false, spellCast: false }
            },
            player2: {
                name: p2Name,
                record: '0-0-0',
                gamesWon: 0,
                life: this.mtgMatch.format === 'commander' ? 40 : 20,
                commanderDamage: {},
                lands: 0,
                featuredPermanents: [],
                turnActions: { landPlayed: false, spellCast: false }
            },
            activePlayer: 1,
            currentPhase: 'main1',
            timer: 0,
            format: this.mtgMatch.format
        };
        
        this.io.emit('mtg-match-reset', {
            timestamp: Date.now()
        });
        
        console.log('MTG match reset');
    }
    
    // MTG Life Total Management
    updateMTGLife(player, life) {
        if (player !== 1 && player !== 2) return;
        
        this.mtgMatch[`player${player}`].life = life;
        
        this.io.emit('mtg-life-update', {
            player: player,
            life: life,
            timestamp: Date.now()
        });
        
        console.log(`Player ${player} life updated to ${life}`);
    }
    
    // MTG Commander Damage Management
    updateCommanderDamage(player, commanderName, damage) {
        if (player !== 1 && player !== 2) return;
        
        this.mtgMatch[`player${player}`].commanderDamage[commanderName] = damage;
        
        this.io.emit('mtg-commander-damage-update', {
            player: player,
            commanderName: commanderName,
            damage: damage,
            timestamp: Date.now()
        });
        
        console.log(`Player ${player} took ${damage} commander damage from ${commanderName}`);
    }
    
    // MTG Land Tracking
    updateLands(player, count) {
        if (player !== 1 && player !== 2) return;
        
        this.mtgMatch[`player${player}`].lands = count;
        
        this.io.emit('mtg-lands-update', {
            player: player,
            lands: count,
            timestamp: Date.now()
        });
        
        console.log(`Player ${player} lands updated to ${count}`);
    }
    
    // MTG Featured Permanents Management
    addFeaturedPermanent(player, card) {
        if (player !== 1 && player !== 2) return;
        
        const playerKey = `player${player}`;
        
        // Max 6 featured permanents
        if (this.mtgMatch[playerKey].featuredPermanents.length >= 6) {
            console.log(`Player ${player} already has 6 featured permanents`);
            return;
        }
        
        this.mtgMatch[playerKey].featuredPermanents.push(card);
        
        this.io.emit('mtg-permanent-added', {
            player: player,
            card: card,
            featuredPermanents: this.mtgMatch[playerKey].featuredPermanents,
            timestamp: Date.now()
        });
        
        console.log(`Added ${card.name} to Player ${player}'s featured permanents`);
    }
    
    removeFeaturedPermanent(player, index) {
        if (player !== 1 && player !== 2) return;
        
        const playerKey = `player${player}`;
        
        if (index >= 0 && index < this.mtgMatch[playerKey].featuredPermanents.length) {
            const removed = this.mtgMatch[playerKey].featuredPermanents.splice(index, 1)[0];
            
            this.io.emit('mtg-permanent-removed', {
                player: player,
                index: index,
                card: removed,
                featuredPermanents: this.mtgMatch[playerKey].featuredPermanents,
                timestamp: Date.now()
            });
            
            console.log(`Removed ${removed.name} from Player ${player}'s featured permanents`);
        }
    }
    
    clearFeaturedPermanents(player) {
        if (player !== 1 && player !== 2) return;
        
        const playerKey = `player${player}`;
        this.mtgMatch[playerKey].featuredPermanents = [];
        
        this.io.emit('mtg-permanents-cleared', {
            player: player,
            timestamp: Date.now()
        });
        
        console.log(`Cleared all featured permanents for Player ${player}`);
    }
    
    // MTG Phase Tracking
    updatePhase(phase) {
        this.mtgMatch.currentPhase = phase;
        
        this.io.emit('mtg-phase-update', {
            phase: phase,
            timestamp: Date.now()
        });
        
        console.log(`Phase changed to ${phase}`);
    }
    
    // MTG Player Management
    updateMTGPlayerName(player, name) {
        if (player !== 1 && player !== 2) return;
        
        this.mtgMatch[`player${player}`].name = name;
        
        this.io.emit('mtg-player-name-update', {
            player: player,
            name: name,
            timestamp: Date.now()
        });
    }
    
    updateMTGPlayerRecord(player, record) {
        if (player !== 1 && player !== 2) return;
        
        this.mtgMatch[`player${player}`].record = record;
        
        this.io.emit('mtg-record-update', {
            player: player,
            record: record,
            timestamp: Date.now()
        });
    }
    
    updateMTGGamesWon(player, gamesWon) {
        if (player !== 1 && player !== 2) return;
        
        this.mtgMatch[`player${player}`].gamesWon = gamesWon;
        
        this.io.emit('mtg-games-won-update', {
            player: player,
            gamesWon: gamesWon,
            timestamp: Date.now()
        });
    }
    
    // MTG Turn Actions
    setMTGTurnAction(player, action, value) {
        if (player !== 1 && player !== 2) return;
        
        const playerKey = `player${player}`;
        this.mtgMatch[playerKey].turnActions[action] = value;
        
        this.io.emit('mtg-turn-actions-update', {
            player: player,
            actions: this.mtgMatch[playerKey].turnActions,
            timestamp: Date.now()
        });
    }
    
    resetMTGTurnActions(player) {
        if (player !== 1 && player !== 2) return;
        
        const playerKey = `player${player}`;
        this.mtgMatch[playerKey].turnActions = {
            landPlayed: false,
            spellCast: false
        };
        
        this.io.emit('mtg-turn-actions-update', {
            player: player,
            actions: this.mtgMatch[playerKey].turnActions,
            timestamp: Date.now()
        });
    }
    
    // MTG Match Control
    switchMTGActivePlayer() {
        this.mtgMatch.activePlayer = this.mtgMatch.activePlayer === 1 ? 2 : 1;
        
        this.io.emit('mtg-player-switch', {
            activePlayer: this.mtgMatch.activePlayer,
            timestamp: Date.now()
        });
        
        console.log(`Active player switched to Player ${this.mtgMatch.activePlayer}`);
    }
    
    updateMTGFormat(format) {
        const oldFormat = this.mtgMatch.format;
        this.mtgMatch.format = format;
        
        // Adjust life totals if format changed
        if (format === 'commander' && oldFormat !== 'commander') {
            this.mtgMatch.player1.life = 40;
            this.mtgMatch.player2.life = 40;
        } else if (format !== 'commander' && oldFormat === 'commander') {
            this.mtgMatch.player1.life = 20;
            this.mtgMatch.player2.life = 20;
        }
        
        this.io.emit('mtg-format-update', {
            format: format,
            timestamp: Date.now()
        });
        
        console.log(`Format changed to ${format}`);
    }
    
    // ============ END MTG METHODS ============
    
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
    
    // Pokemon Match Methods
    updateStadium(stadium) {
        this.pokemonMatch.stadium = stadium;
        this.io.emit('stadium-update', {
            stadium: stadium,
            timestamp: Date.now()
        });
    }
    
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
            pokemonMatch: this.pokemonMatch,
            mtgMatch: this.mtgMatch
        };
    }
    
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
        
        if (this.gameSettings.categories) {
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
    
    updateMatchState(state) {
        this.io.emit('match-state', {
            state: state,
            timestamp: Date.now()
        });
    }
    
    updatePlayerNames(player1, player2) {
        this.pokemonMatch.player1.name = player1;
        this.pokemonMatch.player2.name = player2;
        
        this.io.emit('player-names', {
            player1: player1,
            player2: player2,
            timestamp: Date.now()
        });
    }
    
    updateScore(player1Score, player2Score) {
        this.io.emit('score-update', {
            player1: player1Score,
            player2: player2Score,
            timestamp: Date.now()
        });
    }
    
    startTimer(duration = 50 * 60) {
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