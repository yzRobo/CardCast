// src/overlay-server.js - CardCast Overlay Manager
class OverlayServer {
    constructor(io) {
        this.io = io;
        this.currentCard = null;
        this.prizeCards = {
            player1: [],
            player2: []
        };
        this.decklist = [];
        this.overlaySettings = {
            theme: 'championship',
            showAnimations: true,
            cardDisplayDuration: 0,
            position: 'bottom-center'
        };
    }
    
    updateCard(cardData) {
        this.currentCard = cardData;
        this.io.emit('card-update', {
            card: cardData,
            settings: this.overlaySettings,
            timestamp: Date.now()
        });
    }
    
    clearCard() {
        this.currentCard = null;
        this.io.emit('card-clear', {
            timestamp: Date.now()
        });
    }
    
    updatePrizes(player, cards) {
        if (player === 'player1' || player === 'player2') {
            this.prizeCards[player] = cards;
            this.io.emit('prizes-update', {
                player,
                cards,
                timestamp: Date.now()
            });
        }
    }
    
    updateDecklist(cards) {
        this.decklist = cards;
        this.io.emit('decklist-update', {
            cards,
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
            currentCard: this.currentCard,
            prizeCards: this.prizeCards,
            decklist: this.decklist,
            settings: this.overlaySettings
        };
    }
    
    // Handle different game-specific overlay features
    setupGameOverlay(game) {
        switch(game) {
            case 'pokemon':
                return {
                    showPrizes: true,
                    prizeCount: 6,
                    showBench: true,
                    showEnergy: true
                };
            case 'magic':
                return {
                    showLife: true,
                    showCommander: true,
                    showGraveyard: true,
                    showExile: true
                };
            case 'yugioh':
                return {
                    showLifePoints: true,
                    showGraveyard: true,
                    showExtraDeck: true,
                    showBanished: true
                };
            case 'lorcana':
                return {
                    showInkwell: true,
                    showLore: true,
                    showCharacters: true
                };
            case 'onepiece':
                return {
                    showLife: true,
                    showDonDeck: true,
                    showTrash: true
                };
            default:
                return {};
        }
    }
}

module.exports = OverlayServer;