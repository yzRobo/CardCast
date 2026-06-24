// src/overlay-server.js - CardCast Overlay Manager
class OverlayServer {
    constructor(io) {
        this.io = io;
        this.currentCards = {
            left: null,
            right: null
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

        // MTG Match State (MTG proper: 60-card constructed, 20 life - no Commander).
        this.mtgMatch = {
            player1: this.freshMTGPlayer('Player 1'),
            player2: this.freshMTGPlayer('Player 2'),
            activePlayer: 1,
            currentPhase: 'main1',
            timer: 0,
            matchFormat: 'Standard'
        };

        // Gundam Match State (mirrors pokemonMatch; locked design: equal 6-unit
        // grid, Shields=6, per-player Base + Resources, no turn-flag row).
        this.gundamMatch = {
            player1: this.freshGundamPlayer('Player 1'),
            player2: this.freshGundamPlayer('Player 2'),
            currentTurn: 1,
            timer: { minutes: 50, seconds: 0 },
            gameNumber: 1,
            matchFormat: 'Best of 3'
        };

        // Yu-Gi-Oh! Match State (mirrors gundamMatch; design: 8000 LP headline, a
        // row of 5 Monster Zones with ATK/DEF + battle position, a 5-slot Spell/
        // Trap row + Field Spell slot, a once-per-turn Normal Summon flag, a phase
        // stepper, and optional zone counts).
        this.yugiohMatch = {
            player1: this.freshYugiohPlayer('Player 1'),
            player2: this.freshYugiohPlayer('Player 2'),
            currentTurn: 1,
            currentPhase: 'Main1',
            timer: { minutes: 40, seconds: 0 },
            gameNumber: 1,
            matchFormat: 'Best of 3'
        };

        // One Piece Match State (mirrors gundamMatch; locked design: featured
        // Leader + Power, a variable-length Life pip-track seeded from the Leader's
        // life, a DON!! X/10 active/rested counter with per-character attach, a
        // Character Area row of up to 5, and a single Stage slot. No turn-flag row.
        this.onePieceMatch = {
            player1: this.freshOnePiecePlayer('Player 1'),
            player2: this.freshOnePiecePlayer('Player 2'),
            currentTurn: 1,
            timer: { minutes: 50, seconds: 0 },
            gameNumber: 1,
            matchFormat: 'Best of 3'
        };

        // Disney Lorcana Match State (mirrors onePieceMatch; locked design: NO life
        // total - the headline is a LORE race counting UP to 20 (first to 20 wins).
        // Each player also has an Ink resource (available/total), a row of up to 6
        // Characters (Strength/Willpower/Lore + accumulated damage toward Willpower +
        // ready/exerted), up to 3 Locations (Willpower + Lore/turn), and optional
        // Items. No turn-flag row.
        this.lorcanaMatch = {
            player1: this.freshLorcanaPlayer('Player 1'),
            player2: this.freshLorcanaPlayer('Player 2'),
            currentTurn: 1,
            timer: { minutes: 50, seconds: 0 },
            gameNumber: 1,
            matchFormat: 'Best of 3'
        };

        // Digimon Match State (mirrors gundamMatch/lorcanaMatch). TWO Digimon-unique
        // mechanics drive the design: a per-player 5-card SECURITY stack (the loss
        // track, mirrors Gundam shields) and a SINGLE SHARED MEMORY gauge in the
        // center running -10 (P1 side) .. 0 .. +10 (P2 side) - NOT a per-player value.
        // Plus a Battle Area row (Digimon shown as digivolution stacks with DP+level),
        // a Breeding Area slot, Tamer chips, and optional zone counts.
        this.digimonMatch = {
            memory: 0, // SHARED, -10 (P1 side) .. 0 .. +10 (P2 side)
            player1: this.freshDigimonPlayer('Player 1'),
            player2: this.freshDigimonPlayer('Player 2'),
            currentTurn: 1,
            timer: { minutes: 50, seconds: 0 },
            gameNumber: 1,
            matchFormat: 'Best of 3'
        };
    }

    // A blank Digimon player board. security is the fixed 5-pip loss track (mirrors
    // Gundam shields). battle is a fixed 6-slot row (null = empty); each entry is a
    // digivolution stack rendered as one card with DP/level and a stack-depth badge.
    // breeding is the single egg-incubator slot; tamers is a free chip list.
    freshDigimonPlayer(name) {
        return {
            name,
            record: { wins: 0, losses: 0, ties: 0 },
            gamesWon: 0,
            security: 5,
            securityTaken: [],
            battle: [null, null, null, null, null, null], // {id,name,image,dp,level,colors,stack}
            breeding: null,                                // {id,name,image,dp,level,colors}|null
            tamers: [],                                    // {id,name,image}
            counts: { hand: 0, deck: 0, trash: 0, eggDeck: 0 }
        };
    }

    // A blank Lorcana player board. lore counts UP toward loreGoal (20 = win) - it
    // is NOT a depleting life total. characters is a fixed 6-slot row and locations
    // a fixed 3-slot row (null = empty); items is a free list of chips.
    freshLorcanaPlayer(name) {
        return {
            name,
            record: { wins: 0, losses: 0, ties: 0 },
            gamesWon: 0,
            lore: 0,
            loreGoal: 20,
            ink: { available: 0, total: 0 },
            characters: [null, null, null, null, null, null], // {id,name,image,strength,willpower,lore,damage,exerted}
            locations: [null, null, null],                     // {id,name,image,willpower,lore}
            items: []                                          // {id,name,image}
        };
    }

    // A blank One Piece player board. characters is a fixed 5-slot row (null =
    // empty). Life total defaults to 4 and is reseeded from the Leader's life when
    // a Leader is assigned. DON!! is a ramping active/rested counter out of 10.
    freshOnePiecePlayer(name) {
        return {
            name,
            record: { wins: 0, losses: 0, ties: 0 },
            gamesWon: 0,
            leader: null,                                 // {id,name,image,power,colors}
            life: { total: 4, taken: [] },                // total seeded from leader.life
            don: { active: 0, rested: 0, max: 10 },
            characters: [null, null, null, null, null],   // {id,name,image,power,counter,donAttached}
            stage: null                                   // {id,name,image}|null
        };
    }

    // A blank Yu-Gi-Oh! player board. monsters / spellsTraps are fixed 5-slot
    // rows (null = empty zone). 8000 starting LP; one Normal Summon per turn.
    freshYugiohPlayer(name) {
        return {
            name,
            record: { wins: 0, losses: 0, ties: 0 },
            gamesWon: 0,
            lifePoints: 8000,
            normalSummonUsed: false,
            monsters: [null, null, null, null, null],   // {id,name,image,atk,def,position:'atk'|'def'|'set'}
            spellsTraps: [null, null, null, null, null], // {id,name,image,faceDown:bool}
            fieldSpell: null,                            // {id,name,image}|null
            counts: { hand: 0, deck: 0, extra: 0, graveyard: 0, banished: 0 }
        };
    }

    // A blank Gundam player board. units is a fixed 6-slot grid (null = empty cell).
    freshGundamPlayer(name) {
        return {
            name,
            record: { wins: 0, losses: 0, ties: 0 },
            gamesWon: 0,
            shields: 6,
            shieldsTaken: [],
            resources: { active: 0, total: 0, ex: false },
            units: [null, null, null, null, null, null],
            base: null
        };
    }

    // A blank MTG player board. 20 starting life; poison is the alt loss
    // condition (overlay hides it until > 0). No Commander damage / 40-life.
    freshMTGPlayer(name) {
        return {
            name,
            record: '0-0-0',
            gamesWon: 0,
            life: 20,
            poison: 0,
            lands: 0,
            featuredPermanents: [],
            turnActions: { landPlayed: false, spellCast: false }
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
    
    takePrize(player, index) {
        const playerKey = `player${player}`;

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
        this.pokemonMatch.player1.prizesTaken = [];
        this.pokemonMatch.player1.prizes = 6;
        this.pokemonMatch.player2.prizesTaken = [];
        this.pokemonMatch.player2.prizes = 6;

        this.io.emit('prizes-reset', {
            timestamp: Date.now()
        });
    }

    // ============ MTG MATCH METHODS ============
    
    resetMTGMatch() {
        this.mtgMatch = {
            player1: this.freshMTGPlayer(this.mtgMatch.player1.name),
            player2: this.freshMTGPlayer(this.mtgMatch.player2.name),
            activePlayer: 1,
            currentPhase: 'main1',
            timer: 0,
            matchFormat: this.mtgMatch.matchFormat
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
    
    // MTG Poison Counters (alt loss condition; 10 poison = lethal)
    updateMTGPoison(player, poison) {
        if (player !== 1 && player !== 2) return;

        this.mtgMatch[`player${player}`].poison = Math.max(0, poison);

        this.io.emit('mtg-poison-update', {
            player: player,
            poison: this.mtgMatch[`player${player}`].poison,
            timestamp: Date.now()
        });

        console.log(`Player ${player} poison updated to ${poison}`);
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
    
    // MTG Match Control. Pass an explicit 1/2 to set the active player directly
    // (so "Set Active" buttons work); call with no target to toggle.
    switchMTGActivePlayer(target) {
        if (target === 1 || target === 2) {
            this.mtgMatch.activePlayer = target;
        } else {
            this.mtgMatch.activePlayer = this.mtgMatch.activePlayer === 1 ? 2 : 1;
        }

        this.io.emit('mtg-player-switch', {
            activePlayer: this.mtgMatch.activePlayer,
            timestamp: Date.now()
        });

        console.log(`Active player set to Player ${this.mtgMatch.activePlayer}`);
    }

    // Format is a label only in MTG proper - it never changes life (always 20).
    updateMTGFormat(format) {
        this.mtgMatch.matchFormat = format;

        this.io.emit('mtg-format-update', {
            format: format,
            timestamp: Date.now()
        });

        console.log(`Format changed to ${format}`);
    }

    // Match timer (seconds). Kept in state so a freshly-loaded overlay can
    // hydrate the current value via state-update; the control drives the count.
    updateMTGTimer(seconds) {
        this.mtgMatch.timer = Math.max(0, seconds | 0);

        this.io.emit('mtg-timer-update', {
            seconds: this.mtgMatch.timer,
            timestamp: Date.now()
        });
    }
    
    // ============ END MTG METHODS ============

    // ============ GUNDAM MATCH METHODS ============

    // Bulk update (player boards / turn / game / format) - used on control load + show.
    updateGundamMatch(data) {
        if (data.player1) this.gundamMatch.player1 = { ...this.gundamMatch.player1, ...data.player1 };
        if (data.player2) this.gundamMatch.player2 = { ...this.gundamMatch.player2, ...data.player2 };
        if (data.currentTurn !== undefined) this.gundamMatch.currentTurn = data.currentTurn;
        if (data.gameNumber !== undefined) this.gundamMatch.gameNumber = data.gameNumber;
        if (data.matchFormat !== undefined) this.gundamMatch.matchFormat = data.matchFormat;
        this.io.emit('gundam-match-update', data);
    }

    // Set or clear (unit=null) a battle-area grid cell (0-5).
    setGundamUnit(player, index, unit) {
        const key = `player${player}`;
        if (!this.gundamMatch[key] || index < 0 || index > 5) return;
        this.gundamMatch[key].units[index] = unit;
        this.io.emit('gundam-unit-update', { player, index, unit, timestamp: Date.now() });
    }

    setGundamUnitHp(player, index, currentHp, maxHp) {
        const key = `player${player}`;
        const unit = this.gundamMatch[key] && this.gundamMatch[key].units[index];
        if (!unit) return;
        unit.currentHp = currentHp;
        if (maxHp !== undefined) unit.maxHp = maxHp;
        this.io.emit('gundam-unit-hp', { player, index, currentHp, maxHp: unit.maxHp, timestamp: Date.now() });
    }

    // Pair (pilot object) or unpair (pilot=null) a Pilot onto a unit.
    setGundamPilot(player, index, pilot) {
        const key = `player${player}`;
        const unit = this.gundamMatch[key] && this.gundamMatch[key].units[index];
        if (!unit) return;
        unit.pilot = pilot;
        this.io.emit('gundam-pilot-pair', { player, index, pilot, timestamp: Date.now() });
    }

    setGundamBase(player, base) {
        const key = `player${player}`;
        if (!this.gundamMatch[key]) return;
        this.gundamMatch[key].base = base;
        this.io.emit('gundam-base-update', { player, base, timestamp: Date.now() });
    }

    setGundamBaseHp(player, currentHp, maxHp) {
        const key = `player${player}`;
        const base = this.gundamMatch[key] && this.gundamMatch[key].base;
        if (!base) return;
        base.currentHp = currentHp;
        if (maxHp !== undefined) base.maxHp = maxHp;
        this.io.emit('gundam-base-hp', { player, currentHp, maxHp: base.maxHp, timestamp: Date.now() });
    }

    setGundamResources(player, resources) {
        const key = `player${player}`;
        if (!this.gundamMatch[key]) return;
        this.gundamMatch[key].resources = { ...this.gundamMatch[key].resources, ...resources };
        this.io.emit('gundam-resource-update', { player, resources: this.gundamMatch[key].resources, timestamp: Date.now() });
    }

    // Toggle a shield as taken/restored (mirrors the prize-card take logic).
    takeGundamShield(player, index) {
        const p = this.gundamMatch[`player${player}`];
        if (!p) return;
        const i = p.shieldsTaken.indexOf(index);
        if (i === -1) p.shieldsTaken.push(index);
        else p.shieldsTaken.splice(i, 1);
        p.shields = 6 - p.shieldsTaken.length;
        this.io.emit('gundam-shield-taken', { player, index, shieldsTaken: p.shieldsTaken, shields: p.shields, timestamp: Date.now() });
    }

    setGundamShields(player, taken) {
        const p = this.gundamMatch[`player${player}`];
        if (!p) return;
        p.shieldsTaken = Array.isArray(taken) ? taken : [];
        p.shields = 6 - p.shieldsTaken.length;
        this.io.emit('gundam-shield-taken', { player, index: null, shieldsTaken: p.shieldsTaken, shields: p.shields, timestamp: Date.now() });
    }

    resetGundamShields() {
        this.gundamMatch.player1.shieldsTaken = [];
        this.gundamMatch.player1.shields = 6;
        this.gundamMatch.player2.shieldsTaken = [];
        this.gundamMatch.player2.shields = 6;
        this.io.emit('gundam-shields-reset', { timestamp: Date.now() });
    }

    updateGundamRecord(player, record) {
        const key = `player${player}`;
        if (this.gundamMatch[key]) this.gundamMatch[key].record = record;
        this.io.emit('gundam-record-update', { player, record, timestamp: Date.now() });
    }

    updateGundamGamesWon(player, gamesWon) {
        const key = `player${player}`;
        if (this.gundamMatch[key]) this.gundamMatch[key].gamesWon = gamesWon;
        this.io.emit('gundam-games-won-update', { player, gamesWon, timestamp: Date.now() });
    }

    resetGundamMatch() {
        const p1 = this.gundamMatch.player1.name;
        const p2 = this.gundamMatch.player2.name;
        this.gundamMatch = {
            player1: this.freshGundamPlayer(p1),
            player2: this.freshGundamPlayer(p2),
            currentTurn: 1,
            timer: { minutes: 50, seconds: 0 },
            gameNumber: 1,
            matchFormat: this.gundamMatch.matchFormat || 'Best of 3'
        };
        this.io.emit('gundam-match-reset', { timestamp: Date.now() });
        console.log('Gundam match reset');
    }

    // ============ END GUNDAM METHODS ============

    // ============ YU-GI-OH! MATCH METHODS ============

    // Bulk update (player boards / turn / phase / game / format) - control load + show.
    updateYugiohMatch(data) {
        if (data.player1) this.yugiohMatch.player1 = { ...this.yugiohMatch.player1, ...data.player1 };
        if (data.player2) this.yugiohMatch.player2 = { ...this.yugiohMatch.player2, ...data.player2 };
        if (data.currentTurn !== undefined) this.yugiohMatch.currentTurn = data.currentTurn;
        if (data.currentPhase !== undefined) this.yugiohMatch.currentPhase = data.currentPhase;
        if (data.gameNumber !== undefined) this.yugiohMatch.gameNumber = data.gameNumber;
        if (data.matchFormat !== undefined) this.yugiohMatch.matchFormat = data.matchFormat;
        this.io.emit('yugioh-match-update', data);
    }

    updateYugiohLife(player, lifePoints) {
        const key = `player${player}`;
        if (!this.yugiohMatch[key]) return;
        this.yugiohMatch[key].lifePoints = Math.max(0, lifePoints | 0);
        this.io.emit('yugioh-life-update', { player, lifePoints: this.yugiohMatch[key].lifePoints, timestamp: Date.now() });
    }

    // Set or clear (monster=null) a Monster Zone (0-4).
    setYugiohMonster(player, index, monster) {
        const key = `player${player}`;
        if (!this.yugiohMatch[key] || index < 0 || index > 4) return;
        this.yugiohMatch[key].monsters[index] = monster;
        this.io.emit('yugioh-monster-update', { player, index, monster, timestamp: Date.now() });
    }

    setYugiohMonsterPosition(player, index, position) {
        const key = `player${player}`;
        const m = this.yugiohMatch[key] && this.yugiohMatch[key].monsters[index];
        if (!m) return;
        m.position = position;
        this.io.emit('yugioh-monster-position', { player, index, position, timestamp: Date.now() });
    }

    // Set or clear (card=null) a Spell/Trap Zone (0-4).
    setYugiohSpellTrap(player, index, card) {
        const key = `player${player}`;
        if (!this.yugiohMatch[key] || index < 0 || index > 4) return;
        this.yugiohMatch[key].spellsTraps[index] = card;
        this.io.emit('yugioh-spelltrap-update', { player, index, card, timestamp: Date.now() });
    }

    setYugiohField(player, field) {
        const key = `player${player}`;
        if (!this.yugiohMatch[key]) return;
        this.yugiohMatch[key].fieldSpell = field;
        this.io.emit('yugioh-field-update', { player, field, timestamp: Date.now() });
    }

    setYugiohCounts(player, counts) {
        const key = `player${player}`;
        if (!this.yugiohMatch[key]) return;
        this.yugiohMatch[key].counts = { ...this.yugiohMatch[key].counts, ...counts };
        this.io.emit('yugioh-counts-update', { player, counts: this.yugiohMatch[key].counts, timestamp: Date.now() });
    }

    setYugiohNormalSummon(player, used) {
        const key = `player${player}`;
        if (!this.yugiohMatch[key]) return;
        this.yugiohMatch[key].normalSummonUsed = !!used;
        this.io.emit('yugioh-normal-summon', { player, used: !!used, timestamp: Date.now() });
    }

    updateYugiohPhase(phase) {
        this.yugiohMatch.currentPhase = phase;
        this.io.emit('yugioh-phase-update', { phase, timestamp: Date.now() });
    }

    updateYugiohRecord(player, record) {
        const key = `player${player}`;
        if (this.yugiohMatch[key]) this.yugiohMatch[key].record = record;
        this.io.emit('yugioh-record-update', { player, record, timestamp: Date.now() });
    }

    updateYugiohGamesWon(player, gamesWon) {
        const key = `player${player}`;
        if (this.yugiohMatch[key]) this.yugiohMatch[key].gamesWon = gamesWon;
        this.io.emit('yugioh-games-won-update', { player, gamesWon, timestamp: Date.now() });
    }

    resetYugiohMatch() {
        const p1 = this.yugiohMatch.player1.name;
        const p2 = this.yugiohMatch.player2.name;
        this.yugiohMatch = {
            player1: this.freshYugiohPlayer(p1),
            player2: this.freshYugiohPlayer(p2),
            currentTurn: 1,
            currentPhase: 'Main1',
            timer: { minutes: 40, seconds: 0 },
            gameNumber: 1,
            matchFormat: this.yugiohMatch.matchFormat || 'Best of 3'
        };
        this.io.emit('yugioh-match-reset', { timestamp: Date.now() });
        console.log('Yu-Gi-Oh match reset');
    }

    // ============ END YU-GI-OH! METHODS ============

    // ============ ONE PIECE MATCH METHODS ============

    // Bulk update (player boards / turn / game / format) - control load + show.
    updateOnePieceMatch(data) {
        if (data.player1) this.onePieceMatch.player1 = { ...this.onePieceMatch.player1, ...data.player1 };
        if (data.player2) this.onePieceMatch.player2 = { ...this.onePieceMatch.player2, ...data.player2 };
        if (data.currentTurn !== undefined) this.onePieceMatch.currentTurn = data.currentTurn;
        if (data.gameNumber !== undefined) this.onePieceMatch.gameNumber = data.gameNumber;
        if (data.matchFormat !== undefined) this.onePieceMatch.matchFormat = data.matchFormat;
        this.io.emit('onepiece-match-update', data);
    }

    // Set or clear (leader=null) the featured Leader. Assigning a Leader reseeds the
    // Life pip-track length from leader.life (and clears taken) unless seedLife is
    // explicitly false; the control can still override the count via setOnePieceLifeTotal.
    setOnePieceLeader(player, leader, seedLife = true) {
        const key = `player${player}`;
        const p = this.onePieceMatch[key];
        if (!p) return;
        p.leader = leader;
        if (leader && seedLife && leader.life != null) {
            p.life = { total: Math.max(1, leader.life | 0), taken: [] };
        }
        this.io.emit('onepiece-leader-update', { player, leader, life: p.life, timestamp: Date.now() });
    }

    setOnePieceLifeTotal(player, total) {
        const key = `player${player}`;
        const p = this.onePieceMatch[key];
        if (!p) return;
        p.life.total = Math.max(0, total | 0);
        // Drop any taken indices that no longer fit the new track length.
        p.life.taken = (p.life.taken || []).filter(i => i < p.life.total);
        this.io.emit('onepiece-life-total', { player, total: p.life.total, taken: p.life.taken, timestamp: Date.now() });
    }

    // Toggle a Life card as taken/restored (mirrors the prize/shield take logic).
    takeOnePieceLife(player, index) {
        const p = this.onePieceMatch[`player${player}`];
        if (!p) return;
        const i = p.life.taken.indexOf(index);
        if (i === -1) p.life.taken.push(index);
        else p.life.taken.splice(i, 1);
        this.io.emit('onepiece-life-taken', { player, index, taken: p.life.taken, total: p.life.total, timestamp: Date.now() });
    }

    setOnePieceLife(player, taken) {
        const p = this.onePieceMatch[`player${player}`];
        if (!p) return;
        p.life.taken = Array.isArray(taken) ? taken : [];
        this.io.emit('onepiece-life-taken', { player, index: null, taken: p.life.taken, total: p.life.total, timestamp: Date.now() });
    }

    resetOnePieceLife() {
        this.onePieceMatch.player1.life.taken = [];
        this.onePieceMatch.player2.life.taken = [];
        this.io.emit('onepiece-life-reset', {
            player1: this.onePieceMatch.player1.life,
            player2: this.onePieceMatch.player2.life,
            timestamp: Date.now()
        });
    }

    // DON!! ramp counter: { active, rested, max }. Partial updates merge.
    setOnePieceDon(player, don) {
        const p = this.onePieceMatch[`player${player}`];
        if (!p) return;
        p.don = { ...p.don, ...don };
        this.io.emit('onepiece-don-update', { player, don: p.don, timestamp: Date.now() });
    }

    // Set or clear (character=null) a Character Area slot (0-4).
    setOnePieceCharacter(player, index, character) {
        const key = `player${player}`;
        if (!this.onePieceMatch[key] || index < 0 || index > 4) return;
        this.onePieceMatch[key].characters[index] = character;
        this.io.emit('onepiece-character-update', { player, index, character, timestamp: Date.now() });
    }

    setOnePieceCharacterPower(player, index, power) {
        const c = this.onePieceMatch[`player${player}`] && this.onePieceMatch[`player${player}`].characters[index];
        if (!c) return;
        c.power = power;
        this.io.emit('onepiece-character-power', { player, index, power, timestamp: Date.now() });
    }

    // Attach/detach DON!! to a Character (each attached DON!! = +1000 power on the
    // overlay readout). donAttached is the count on that character.
    setOnePieceDonAttach(player, index, donAttached) {
        const c = this.onePieceMatch[`player${player}`] && this.onePieceMatch[`player${player}`].characters[index];
        if (!c) return;
        c.donAttached = Math.max(0, donAttached | 0);
        this.io.emit('onepiece-don-attach', { player, index, donAttached: c.donAttached, timestamp: Date.now() });
    }

    setOnePieceStage(player, stage) {
        const key = `player${player}`;
        if (!this.onePieceMatch[key]) return;
        this.onePieceMatch[key].stage = stage;
        this.io.emit('onepiece-stage-update', { player, stage, timestamp: Date.now() });
    }

    updateOnePieceRecord(player, record) {
        const key = `player${player}`;
        if (this.onePieceMatch[key]) this.onePieceMatch[key].record = record;
        this.io.emit('onepiece-record-update', { player, record, timestamp: Date.now() });
    }

    updateOnePieceGamesWon(player, gamesWon) {
        const key = `player${player}`;
        if (this.onePieceMatch[key]) this.onePieceMatch[key].gamesWon = gamesWon;
        this.io.emit('onepiece-games-won-update', { player, gamesWon, timestamp: Date.now() });
    }

    resetOnePieceMatch() {
        const p1 = this.onePieceMatch.player1.name;
        const p2 = this.onePieceMatch.player2.name;
        this.onePieceMatch = {
            player1: this.freshOnePiecePlayer(p1),
            player2: this.freshOnePiecePlayer(p2),
            currentTurn: 1,
            timer: { minutes: 50, seconds: 0 },
            gameNumber: 1,
            matchFormat: this.onePieceMatch.matchFormat || 'Best of 3'
        };
        this.io.emit('onepiece-match-reset', { timestamp: Date.now() });
        console.log('One Piece match reset');
    }

    // ============ END ONE PIECE METHODS ============

    // ============ DISNEY LORCANA MATCH METHODS ============

    // Bulk update (player boards / turn / game / format) - control load + show.
    updateLorcanaMatch(data) {
        if (data.player1) this.lorcanaMatch.player1 = { ...this.lorcanaMatch.player1, ...data.player1 };
        if (data.player2) this.lorcanaMatch.player2 = { ...this.lorcanaMatch.player2, ...data.player2 };
        if (data.currentTurn !== undefined) this.lorcanaMatch.currentTurn = data.currentTurn;
        if (data.gameNumber !== undefined) this.lorcanaMatch.gameNumber = data.gameNumber;
        if (data.matchFormat !== undefined) this.lorcanaMatch.matchFormat = data.matchFormat;
        this.io.emit('lorcana-match-update', data);
    }

    // The LORE race headline: counts UP toward loreGoal (20 = win). Clamped to
    // [0, loreGoal]; never a depleting life total.
    setLorcanaLore(player, lore) {
        const p = this.lorcanaMatch[`player${player}`];
        if (!p) return;
        const goal = p.loreGoal || 20;
        p.lore = Math.max(0, Math.min(goal, lore | 0));
        this.io.emit('lorcana-lore-update', { player, lore: p.lore, loreGoal: goal, timestamp: Date.now() });
    }

    // Ink resource readout: { available, total }. Partial updates merge; available
    // is clamped to total.
    setLorcanaInk(player, ink) {
        const p = this.lorcanaMatch[`player${player}`];
        if (!p) return;
        p.ink = { ...p.ink, ...ink };
        p.ink.total = Math.max(0, p.ink.total | 0);
        p.ink.available = Math.max(0, Math.min(p.ink.total, p.ink.available | 0));
        this.io.emit('lorcana-ink-update', { player, ink: p.ink, timestamp: Date.now() });
    }

    // Set or clear (character=null) a Character row slot (0-5).
    setLorcanaCharacter(player, index, character) {
        const key = `player${player}`;
        if (!this.lorcanaMatch[key] || index < 0 || index > 5) return;
        this.lorcanaMatch[key].characters[index] = character;
        this.io.emit('lorcana-character-update', { player, index, character, timestamp: Date.now() });
    }

    // Accumulated damage toward Willpower (banished when damage >= willpower).
    setLorcanaCharacterDamage(player, index, damage) {
        const c = this.lorcanaMatch[`player${player}`] && this.lorcanaMatch[`player${player}`].characters[index];
        if (!c) return;
        c.damage = Math.max(0, damage | 0);
        this.io.emit('lorcana-character-damage', { player, index, damage: c.damage, timestamp: Date.now() });
    }

    // Ready/exerted (upright/tilted) state - quested or challenged this turn.
    setLorcanaCharacterExert(player, index, exerted) {
        const c = this.lorcanaMatch[`player${player}`] && this.lorcanaMatch[`player${player}`].characters[index];
        if (!c) return;
        c.exerted = !!exerted;
        this.io.emit('lorcana-character-exert', { player, index, exerted: c.exerted, timestamp: Date.now() });
    }

    // Set or clear (location=null) a Location row slot (0-2).
    setLorcanaLocation(player, index, location) {
        const key = `player${player}`;
        if (!this.lorcanaMatch[key] || index < 0 || index > 2) return;
        this.lorcanaMatch[key].locations[index] = location;
        this.io.emit('lorcana-location-update', { player, index, location, timestamp: Date.now() });
    }

    // Replace the optional Items chip list wholesale.
    setLorcanaItems(player, items) {
        const key = `player${player}`;
        if (!this.lorcanaMatch[key]) return;
        this.lorcanaMatch[key].items = Array.isArray(items) ? items : [];
        this.io.emit('lorcana-item-update', { player, items: this.lorcanaMatch[key].items, timestamp: Date.now() });
    }

    updateLorcanaRecord(player, record) {
        const key = `player${player}`;
        if (this.lorcanaMatch[key]) this.lorcanaMatch[key].record = record;
        this.io.emit('lorcana-record-update', { player, record, timestamp: Date.now() });
    }

    updateLorcanaGamesWon(player, gamesWon) {
        const key = `player${player}`;
        if (this.lorcanaMatch[key]) this.lorcanaMatch[key].gamesWon = gamesWon;
        this.io.emit('lorcana-games-won-update', { player, gamesWon, timestamp: Date.now() });
    }

    resetLorcanaMatch() {
        const p1 = this.lorcanaMatch.player1.name;
        const p2 = this.lorcanaMatch.player2.name;
        this.lorcanaMatch = {
            player1: this.freshLorcanaPlayer(p1),
            player2: this.freshLorcanaPlayer(p2),
            currentTurn: 1,
            timer: { minutes: 50, seconds: 0 },
            gameNumber: 1,
            matchFormat: this.lorcanaMatch.matchFormat || 'Best of 3'
        };
        this.io.emit('lorcana-match-reset', { timestamp: Date.now() });
        console.log('Lorcana match reset');
    }

    // ============ END DISNEY LORCANA METHODS ============

    // ============ DIGIMON MATCH METHODS ============

    // Bulk update (shared memory / player boards / turn / game / format) - control
    // load + show. memory is the SHARED gauge, so it lives at the top level.
    updateDigimonMatch(data) {
        if (data.memory !== undefined) this.digimonMatch.memory = Math.max(-10, Math.min(10, data.memory | 0));
        if (data.player1) this.digimonMatch.player1 = { ...this.digimonMatch.player1, ...data.player1 };
        if (data.player2) this.digimonMatch.player2 = { ...this.digimonMatch.player2, ...data.player2 };
        if (data.currentTurn !== undefined) this.digimonMatch.currentTurn = data.currentTurn;
        if (data.gameNumber !== undefined) this.digimonMatch.gameNumber = data.gameNumber;
        if (data.matchFormat !== undefined) this.digimonMatch.matchFormat = data.matchFormat;
        this.io.emit('digimon-match-update', data);
    }

    // The SHARED memory gauge (one widget for both players). Clamped to [-10, 10];
    // negative = Player 1's side, positive = Player 2's side, 0 = neutral center.
    setDigimonMemory(value) {
        this.digimonMatch.memory = Math.max(-10, Math.min(10, value | 0));
        this.io.emit('digimon-memory-update', { memory: this.digimonMatch.memory, timestamp: Date.now() });
    }

    // Toggle a security card as taken/restored (mirrors the prize/shield take logic).
    takeDigimonSecurity(player, index) {
        const p = this.digimonMatch[`player${player}`];
        if (!p) return;
        const i = p.securityTaken.indexOf(index);
        if (i === -1) p.securityTaken.push(index);
        else p.securityTaken.splice(i, 1);
        p.security = 5 - p.securityTaken.length;
        this.io.emit('digimon-security-taken', { player, index, securityTaken: p.securityTaken, security: p.security, timestamp: Date.now() });
    }

    setDigimonSecurity(player, taken) {
        const p = this.digimonMatch[`player${player}`];
        if (!p) return;
        p.securityTaken = Array.isArray(taken) ? taken : [];
        p.security = 5 - p.securityTaken.length;
        this.io.emit('digimon-security-taken', { player, index: null, securityTaken: p.securityTaken, security: p.security, timestamp: Date.now() });
    }

    resetDigimonSecurity() {
        this.digimonMatch.player1.securityTaken = [];
        this.digimonMatch.player1.security = 5;
        this.digimonMatch.player2.securityTaken = [];
        this.digimonMatch.player2.security = 5;
        this.io.emit('digimon-security-reset', { timestamp: Date.now() });
    }

    // Set, clear (unit=null), or edit (full object incl dp/level/stack) a Battle Area
    // slot (0-5). A digivolution stack is one unit with a stack-depth count.
    setDigimonBattle(player, index, unit) {
        const key = `player${player}`;
        if (!this.digimonMatch[key] || index < 0 || index > 5) return;
        this.digimonMatch[key].battle[index] = unit;
        this.io.emit('digimon-battle-update', { player, index, unit, timestamp: Date.now() });
    }

    setDigimonBreeding(player, breeding) {
        const key = `player${player}`;
        if (!this.digimonMatch[key]) return;
        this.digimonMatch[key].breeding = breeding;
        this.io.emit('digimon-breeding-update', { player, breeding, timestamp: Date.now() });
    }

    // Replace the Tamer chip list wholesale.
    setDigimonTamers(player, tamers) {
        const key = `player${player}`;
        if (!this.digimonMatch[key]) return;
        this.digimonMatch[key].tamers = Array.isArray(tamers) ? tamers : [];
        this.io.emit('digimon-tamer-update', { player, tamers: this.digimonMatch[key].tamers, timestamp: Date.now() });
    }

    setDigimonCounts(player, counts) {
        const key = `player${player}`;
        if (!this.digimonMatch[key]) return;
        this.digimonMatch[key].counts = { ...this.digimonMatch[key].counts, ...counts };
        this.io.emit('digimon-counts-update', { player, counts: this.digimonMatch[key].counts, timestamp: Date.now() });
    }

    updateDigimonRecord(player, record) {
        const key = `player${player}`;
        if (this.digimonMatch[key]) this.digimonMatch[key].record = record;
        this.io.emit('digimon-record-update', { player, record, timestamp: Date.now() });
    }

    updateDigimonGamesWon(player, gamesWon) {
        const key = `player${player}`;
        if (this.digimonMatch[key]) this.digimonMatch[key].gamesWon = gamesWon;
        this.io.emit('digimon-games-won-update', { player, gamesWon, timestamp: Date.now() });
    }

    resetDigimonMatch() {
        const p1 = this.digimonMatch.player1.name;
        const p2 = this.digimonMatch.player2.name;
        this.digimonMatch = {
            memory: 0,
            player1: this.freshDigimonPlayer(p1),
            player2: this.freshDigimonPlayer(p2),
            currentTurn: 1,
            timer: { minutes: 50, seconds: 0 },
            gameNumber: 1,
            matchFormat: this.digimonMatch.matchFormat || 'Best of 3'
        };
        this.io.emit('digimon-match-reset', { timestamp: Date.now() });
        console.log('Digimon match reset');
    }

    // ============ END DIGIMON MATCH METHODS ============

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
            decklist: this.decklist,
            settings: this.overlaySettings,
            gameSettings: this.gameSettings,
            pokemonMatch: this.pokemonMatch,
            mtgMatch: this.mtgMatch,
            gundamMatch: this.gundamMatch,
            yugiohMatch: this.yugiohMatch,
            onePieceMatch: this.onePieceMatch,
            lorcanaMatch: this.lorcanaMatch,
            digimonMatch: this.digimonMatch
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
                categories: ['Digimon', 'Tamers', 'Options', 'Digi-Egg']
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