# Digimon Card Game - CardCast Implementation Plan

Status as of 2026-06-23. Produced from `CardCast Game Implementation Template.md`. Covers
the on-stream Match Overlay + Deck Building. No feature code written yet; the data layer is
complete (including card color, fixed 2026-06-23). The repo owner does not play Digimon, so
the board-state choices below are recommendations to build unless overridden.

---

## Agent kickoff prompt

Copy-paste this to an LLM coding agent working in the CardCast repo:

> You are adding Digimon Card Game match-overlay + deck-building support to CardCast. Read
> this ENTIRE file first. The data layer is done - do NOT modify scrapers/parsers/DB
> schema. Mirror the existing Pokemon implementation as the pattern of record:
> `overlays/pokemon-match.html`, `pokemon-match-control.html`, the `pokemonMatch` state in
> `src/overlay-server.js`, and the `server.js` socket wiring. Work phase by phase in the
> order in this document; after each phase, stop and report what changed and how you
> verified it. No emojis anywhere. Start with Phase 1 using its per-phase prompt below.

---

## 0. Data layer status (done)

- Source: digimoncard.io public API (free, no key; whole series in one response). File:
  `src/tcg-api.js` (`fetchDigimonCards` / `parseDigimonCardData`).
- Schema columns: `play_cost`, `digivolve_cost`, `digivolve_color`, `dp`, `digimon_level`,
  `digimon_type`, `digimon_attribute`, plus the shared `colors` (card's own color).
- Cards in DB: 4,297. Coverage: colors 4,297, play_cost 4,023, digimon_level 3,412, dp
  3,185, digivolve_cost 2,488, digimon_attribute 3,179.
- card_type: Digimon (3,180), Option (527), Tamer (332), Digi-Egg (245), Dual (13).
- Color: captured in shared `colors` (card's OWN color, color + color2 dual joined with
  "/"). NOTE the earlier bug (now fixed): `digivolve_color` is the color required to
  digivolve INTO a card (evolution requirement), NOT the card's color - use `colors` for
  color identity, `digivolve_color` only for the digivolve-cost display.

---

## 1. The match feature stack

1-2. Data ingestion + DB - DONE. 3. No `digimonMatch` yet. 4. No overlay. 5. No control.
Decklist overlay is generic (renders any categories) - just add the Digimon category
names to its CATEGORY_ORDER.

TWO MECHANICS UNIQUE TO DIGIMON drive the overlay design:
- SECURITY stack (5 cards) = the life/loss track. You lose when attacked with an empty
  security stack. Direct analog to Pokemon prizes / Gundam shields, but it is 5, not 6.
- MEMORY gauge = a SINGLE SHARED slider from -10 (one player) through 0 to +10 (the other
  player). Spending memory passes initiative; when memory crosses to the opponent's side,
  the turn ends. This is one shared widget in the center, NOT a per-player value.

---

## 2. Feature A - Match overlay + control

### 2.1 Mapping table

| Pokemon element | Digimon equivalent | Notes |
|---|---|---|
| Prize cards (6) | SECURITY stack (5) | per player; the loss track. Reuse the prize grid at length 5. |
| Active Pokemon (HP bar + tools) | Digimon in the Battle Area (row) | Each: DP and level; digivolution stacks shown as one card. |
| Bench | (folded into battle-area row) | no fixed slots. |
| Stadium (shared) | MEMORY gauge (shared, center) | single slider -10..0..+10 between the two players. |
| (new) | Breeding Area (1 slot) | the digi-egg -> rookie incubator. |
| (new) | Tamers in play (small row/chips) | non-Digimon permanents. |
| Turn flags | (drop) | memory/turn is modeled by the gauge, not flags. |
| (counts) | Hand / Deck / Trash / Digi-Egg deck | optional secondary counters. |
| Bo3 / timer / turn indicator | timer + active side (driven by memory) | reuse timer; "turn" follows the memory gauge owner. |

### 2.2 Design decisions (recommended)

- Per-player headline = SECURITY count (5-pip track, reuse the prize/shield grid).
- Center = the MEMORY gauge: a horizontal slider from -10 (P1) to +10 (P2) with a marker;
  this is the single most "Digimon" piece of the overlay and should be prominent and
  shared, not duplicated per player.
- Battle Area row per player: each Digimon card shows DP and level; a digivolution stack
  is shown as the top card (optionally with a small "stack depth" badge).
- Breeding Area: one small slot per player. Tamers: small chips/row.
- Optional counts: Hand / Deck / Trash / Digi-Egg deck.

### 2.3 Per-player layout + shared center

Per player (left/right): Header (name, record, games-won) | SECURITY 5-pip track | Battle
Area row (DP + level) | Breeding slot | Tamers chips. Center column: shared MEMORY gauge.
Shared bar: timer / whose-turn (from memory) / Bo3.

### 2.4 State shape (`overlayServer.digimonMatch`)

```
memory: 0,                          // shared, -10 (P1 side) .. 0 .. +10 (P2 side)
playerN: { name, record, gamesWon, security: 5, securityTaken: [],
           battle: [ {id,name,image,dp,level,stack:1} ],
           breeding: {id,name,image,dp,level}|null,
           tamers: [ {id,name,image} ],
           counts: { hand, deck, trash, eggDeck } }
activePlayer, timer, gameNumber, matchFormat: 'Standard'
```
(activePlayer can be derived from the sign of `memory`, but keep it explicit for clarity.)

### 2.5 Socket events (`digimon-*`)

`digimon-match-update`, `digimon-memory-update` (the shared gauge), `digimon-security-update`
/ `digimon-security-reset`, `digimon-battle-update` (set/clear/digivolve a slot),
`digimon-breeding-update`, `digimon-tamer-update`, `digimon-counts-update`, plus reused
generic `record-update`, `match-score-update`, `timer-*`, `toggle-digimon-match`,
`digimon-match-reset`. (Turn follows memory, so `turn-switch` may be derived.)

---

## 3. Feature B - Deck building

### 3.1 Construction rules

- Main deck: exactly 50 cards - Digimon, Tamers, Options (NOT Digi-Eggs). Max 4 copies per
  card number.
- Digi-Egg deck: 0-5 Digi-Egg cards (separate, like a mini extra deck).
- Colors: multi-color decks are allowed; there is no hard color limit (unlike OP/Lorcana/
  Gundam), so color is informational, not a build constraint. Still populate/show it.

### 3.2 Categories (decklist overlay + builder)

`Digimon`, `Tamers`, `Options`, and a separate `Digi-Egg Deck` section. Derive from
`card_type` (route `Digi-Egg` and `Dual` appropriately; `Dual` cards count where played).

### 3.3 Import (parser)

Extend `public/js/deck-parser.js` with `parseDigimonDeckList` + a `digimon` branch in
`detectGameType`. Digimon exports (digimoncard.io, digimonmeta, untap) are card-number
based. Strategy: match the card number token `([A-Z]{1,3}\d?-\d{3}|BT\d+-\d{3}|EX\d+-\d{3}|ST\d+-\d{3})`
(card_number in the DB equals the digimoncard.io id, e.g. `BT1-084`); resolve against the
DB; categorize by `card_type`; route Digi-Eggs to the egg-deck section. TODO: capture a
real export sample to finalize the number regex/headers.

### 3.4 Custom build

UPDATE 2026-06-23 (switcher landed): `addSelectedToDeck`, search meta and the saved-decks
list are GENERIC now - do NOT generalize them or add a button/edit `selectGame`. Instead
register Digimon in `public/js/game-registry.js` with `deck.categories`
`['Digimon','Tamer','Option','Digi-Egg']`, `deck.categorize(card)`, `deck.rules`
`{ main:50, egg:5, copyLimit:4 }`, and `searchMeta(card)`.

Confirmed `card_type` -> category (from the DB): `Digimon` (and `Dual`) -> Digimon;
`Tamer` -> Tamer; `Option` -> Option; `Digi-Egg` -> Digi-Egg (egg deck). Saved decks
persist + filter per game via `localStorage.savedDecks['digimon']`.

### 3.5 Formats

A format = legal set pool + official banlist/restrictions. Recommended: `Standard`
(all current-legal sets + Bandai restriction list - default) and `Unlimited`. Store the
restriction list editable. Label + opt-in legality filter. (No color identity rule.)

### 3.6 Decklist overlay (now GENERIC - no per-game branch)

`overlays/decklist.html` is game-agnostic (rewritten 2026-06-23): it renders any
`currentDeck.categories` ordered by a `CATEGORY_ORDER` array + `CATEGORY_ACCENT` colors.
For Digimon, append the categories in order: Digimon, Tamers, Options, Digi-Egg Deck. Send
the deck via `decklist-update` as
`{ title, game:'digimon', categories:{ Digimon:[{name,quantity}], ... } }`.

---

## 4. File-by-file work plan

New files:
- `overlays/digimon-match.html` (copy `overlays/pokemon-match.html`; add the shared
  center MEMORY gauge - the one piece without a Pokemon analog).
- `digimon-match-control.html` (copy `pokemon-match-control.html`; add a memory slider
  control and security 5-pip control).

Edited:
- `src/overlay-server.js` - `digimonMatch` state (incl. shared `memory`) + mutators +
  `getState()`.
- `server.js` - `/digimon-match` + `/digimon-match-control` routes; register/request-state
  branches; `digimon-*` relays; `overlayStates`; disconnect; banner.
- `public/js/game-registry.js` - register `digimon`: `matchControls` (->
  `/digimon-match-control`), `overlays[]` (`/digimon-match`, `/overlay`, `/decklist`),
  `deck.categories/categorize/rules`, `searchMeta`. ONLY main-page wiring needed.
- `public/js/deck-parser.js` - `parseDigimonDeckList` + detection.
- `public/js/main.js` / `index.html` - usually no change (generic); touch only for bespoke
  Digimon deck stats or a saved-deck -> overlay section mapping.
- `overlays/decklist.html` - add the Digimon categories to `CATEGORY_ORDER`/`CATEGORY_ACCENT`
  (generic overlay, no per-game branch).

No data-layer changes (color already captured + corrected).

---

## 5. Phasing + per-phase prompts

- Phase 1 - Deck foundation: `parseDigimonDeckList`, categories incl. Digi-Egg deck,
  custom build (50 + 5), Standard/Unlimited formats, decklist categories registered.
- Phase 2 - Match overlay/control: `digimonMatch` (security + shared memory) + server
  wiring + `overlays/digimon-match.html` + `digimon-match-control.html` + index button.

Phase 1 prompt:
> Implement Phase 1 for Digimon (deck foundation). Add `parseDigimonDeckList` to
> `public/js/deck-parser.js` (card-number-keyed, e.g. BT1-084 / ST1-001 / EX1-001; resolve
> against the DB; categorize Digimon/Tamer/Option and route Digi-Egg to a separate
> egg-deck section). Register Digimon in `public/js/game-registry.js`
> (`deck.categories/categorize/rules` with a 50-main / 5-egg / 4-copy check; `searchMeta`) -
> `addSelectedToDeck` is already generic. Add Standard + Unlimited formats. Add a
> the Digimon category names to `CATEGORY_ORDER` in `overlays/decklist.html` (generic
> overlay - no branch). Report with a sample import.

Phase 2 prompt:
> Implement Phase 2 for Digimon (match overlay/control). Add `digimonMatch` to
> `src/overlay-server.js` including a SHARED `memory` value (-10..+10) plus per-player
> security(5)/battle/breeding/tamers; add mutators + getState; wire
> routes/registration/relays in `server.js`; build `overlays/digimon-match.html` with a
> per-player 5-pip SECURITY track and battle-area row (DP + level) PLUS a single SHARED
> MEMORY gauge slider in the center (-10 on P1 side, +10 on P2 side); and
> `digimon-match-control.html` to drive it (memory slider, security pips, add/clear battle
> cards). Add Digimon's `matchControls` (-> `/digimon-match-control`) + `overlays[]` to
> `public/js/game-registry.js`. Mirror the Pokemon files except for
> the shared memory gauge, which has no Pokemon analog. Report observed render.

---

## 6. Open decisions

1. Memory gauge visual: horizontal slider with a marker (recommended), or two opposing
   bars? It must be a single shared widget.
2. Digivolution stacks: show only the top card, or top card + a stack-depth badge?
3. Show Tamers as a row of cards or as small chips?
4. Include the optional Hand/Deck/Trash/Egg-deck counts in v1, or defer?

## 7. References

- digimoncard.io (data source): https://documenter.getpostman.com/view/14059948/TzecB4fH
- Official rules (security 5, memory gauge, 50-card + 5 egg, 4-of):
  https://world.digimoncard.com/rule/
- Banlist/restrictions: https://world.digimoncard.com/rule/restriction_card/
