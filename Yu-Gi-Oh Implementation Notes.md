# Yu-Gi-Oh! - CardCast Implementation Plan

Status as of 2026-06-23. Produced from `CardCast Game Implementation Template.md`. Covers
the on-stream Match Overlay + Deck Building. No feature code written yet; the data layer
is complete. Design decisions are made by CardCast's maintainer's proxy (you) - the repo
owner does not play Yu-Gi-Oh, so the board-state choices below are recommendations to
build unless overridden.

---

## Agent kickoff prompt

Copy-paste this to an LLM coding agent working in the CardCast repo:

> You are adding Yu-Gi-Oh! match-overlay + deck-building support to CardCast. Read this
> ENTIRE file first. The data layer is done - do NOT modify scrapers/parsers/DB schema.
> Mirror the existing Pokemon implementation as the pattern of record:
> `overlays/pokemon-match.html`, `pokemon-match-control.html`, the `pokemonMatch` state
> in `src/overlay-server.js`, and the `server.js` socket wiring. Work phase by phase in
> the order in this document; after each phase, stop and report what changed and how you
> verified it. No emojis anywhere. Start with Phase 1 using its per-phase prompt below.

---

## 0. Data layer status (done)

- Source: YGOPRODeck (free, no key; returns all cards in one response). File:
  `src/tcg-api.js` (`fetchYugiohCards` / `parseYugiohCardData`).
- Schema columns: `attack`, `defense`, `level`, `rank`, `link_value`, `pendulum_scale`,
  `attribute`, `monster_type`.
- Cards in DB: 13,904. Coverage: monster_type 13,902, level 8,490, attribute 8,949
  (monsters), attack 8,259, defense 7,612, link_value 452, rank 0 (NOTE: XYZ "rank" is
  currently stored in `level`; treat level-or-rank as one displayed value, or map rank in
  a future data tweak).
- card_type: Effect Monster, Spell Card, Trap Card, XYZ Monster, Fusion Monster, Normal
  Monster, Tuner Monster, Synchro Monster, Link Monster, Pendulum Effect Monster, Flip
  Effect Monster, Ritual Effect Monster.
- Color: N/A. Yu-Gi-Oh has no color mechanic; its closest axis is `attribute`
  (DARK/LIGHT/EARTH/WATER/FIRE/WIND/DIVINE) which does NOT gate deckbuilding. Do not add
  a color identity rule.

---

## 1. The match feature stack

1-2. Data ingestion + DB - DONE. 3. Server state - no `yugiohMatch` yet. 4. Overlay -
none. 5. Control - none. Decklist overlay is generic (renders any categories); just add
the YGO category names to its `CATEGORY_ORDER`.

---

## 2. Feature A - Match overlay + control

### 2.1 Mapping table

| Pokemon element | Yu-Gi-Oh equivalent | Notes |
|---|---|---|
| Prize cards (6) | Life Points (start 8000) | Big number per player; the headline. Color by healthy/low/critical. |
| Active Pokemon (HP bar + tools) | Monster Zones (up to 5) | Featured board: each monster shows ATK / DEF and battle position. |
| Bench (5-7) | (folded into the 5 monster zones) | YGO has 5 main monster zones; show them as the board row. |
| Stadium (shared) | Field Spell (1 slot) | Single shared-ish field card per player. |
| (new) | Spell/Trap row (up to 5) | Smaller row or a count; set cards shown face-down. |
| Turn flags (Energy/Supporter/Retreat) | Normal Summon used (1/turn) | Single per-turn flag; YGO's clear once-per-turn action. |
| (new) | Phase indicator | Draw/Standby/Main1/Battle/Main2/End. |
| (counts) | Hand / Deck / Extra Deck / GY / Banished | optional secondary counters. |
| Bo3 / timer / turn indicator | same | YGO matches are Bo3 with side decking. |

### 2.2 Design decisions (recommended)

- Headline = the two Life Point totals (large, 8000), active-player highlighted.
- Board = a row of up to 5 Monster Zones per player; each card shows ATK/DEF and a
  position badge (Attack = upright, Defense = rotated/face-down). HP-style bar is NOT
  appropriate (no per-monster HP) - show ATK/DEF as static chips.
- Spell/Trap = a slimmer row of up to 5 (set cards render as face-down backs), plus a
  Field Spell slot. If that is too busy, fall back to counts only.
- Single turn flag: "Normal Summon used". Phase stepper for the rest.
- Optional counters: Hand / Deck / Extra / GY / Banished.

### 2.3 Per-player layout

Header (name, record, games-won) | Life Points (large) | Monster Zones row (up to 5, ATK/
DEF + position) | Spell/Trap row + Field slot | Normal-Summon flag | optional zone counts.
Shared bar: timer / phase / whose-turn / Bo3.

### 2.4 State shape (`overlayServer.yugiohMatch`)

```
playerN: { name, record, gamesWon, lifePoints: 8000, normalSummonUsed: false,
           monsters: [ {id,name,image,atk,def,position:'atk'|'def'|'set'} x up to 5 ],
           spellsTraps: [ {id,name,image,faceDown:bool} x up to 5 ],
           fieldSpell: {id,name,image}|null,
           counts: { hand, deck, extra, graveyard, banished } }
activePlayer, currentPhase, timer, gameNumber, matchFormat: 'Advanced'
```

### 2.5 Socket events (`yugioh-*`)

`yugioh-match-update`, `yugioh-life-update`, `yugioh-monster-update` (set/clear zone),
`yugioh-monster-position`, `yugioh-spelltrap-update`, `yugioh-field-update`,
`yugioh-counts-update`, `yugioh-phase-update`, `yugioh-normal-summon`, plus reused generic
`record-update`, `match-score-update`, `turn-switch`, `timer-*`, `toggle-yugioh-match`,
`yugioh-match-reset`.

---

## 3. Feature B - Deck building

### 3.1 Construction rules

- Main Deck: 40-60 cards. Extra Deck: 0-15 (Fusion/Synchro/XYZ/Link/Pendulum). Side Deck:
  0-15. Max 3 copies per card name.
- Legality via the Forbidden & Limited list (banlist): Forbidden (0), Limited (1),
  Semi-Limited (2). TCG and OCG lists differ.

### 3.2 Categories (decklist overlay + builder)

`Monsters`, `Spells`, `Traps`, and a separate `Extra Deck` section (Fusion/Synchro/XYZ/
Link/Pendulum), plus optional `Side Deck`. Derive Monster/Spell/Trap from `card_type`;
route Extra-Deck monster types into the Extra section.

### 3.3 Import (parser)

Extend `public/js/deck-parser.js` with `parseYugiohDeckList` + a `yugioh` branch in
`detectGameType`. YGO exports (YDK from YGOPRODeck/Dueling Nexus, or text) are usually
card-ID or name based with `#main` / `#extra` / `!side` section markers. Strategy: honor
the section markers; resolve by passcode/name against the local DB; otherwise categorize
by `card_type`. TODO: capture a real .ydk and a text export sample to finalize.

### 3.4 Custom build

UPDATE 2026-06-23 (switcher landed): `addSelectedToDeck`, search meta and the saved-decks
list are GENERIC now - do NOT generalize them or add a button/edit `selectGame`. Register
Yu-Gi-Oh in `public/js/game-registry.js` with `deck.categories`
`['Monsters','Spells','Traps','Extra','Side']`, `deck.categorize(card)`, `deck.rules`
`{ main:[40,60], extra:15, side:15, copyLimit:3 }`, and `searchMeta(card)`.

Confirmed `card_type` -> category (from the DB): `Spell Card` -> Spells; `Trap Card` ->
Traps; a monster type containing `Fusion`/`Synchro`/`Xyz`/`Link` -> Extra; any other
`* Monster` -> Monsters. (Edge cases: `Skill Card`/`Token` - decide per use; Side deck is
import-driven, not from `card_type`.) Saved decks persist + filter per game via
`localStorage.savedDecks['yugioh']`.

### 3.5 Formats

A format = banlist snapshot (+ region). Recommended: `Advanced (TCG)` default (current TCG
F&L list), plus `Traditional` (Forbidden -> Limited) and `Advanced (OCG)` later. Banlist
stored as forbidden[]/limited[]/semiLimited[], editable. Label + opt-in legality filter.
Source: official Konami F&L list.

### 3.6 Decklist overlay (now GENERIC - no per-game branch)

`overlays/decklist.html` is game-agnostic (rewritten 2026-06-23): it renders any
`currentDeck.categories` ordered by a `CATEGORY_ORDER` array + `CATEGORY_ACCENT` colors.
For Yu-Gi-Oh, append the categories in order: Monsters, Spells, Traps, Extra Deck, Side
Deck. Send the deck via `decklist-update` as
`{ title, game:'yugioh', categories:{ Monsters:[{name,quantity}], ... } }` (the Extra and
Side sections are just additional category keys - no special footer needed).

---

## 4. File-by-file work plan

New files:
- `overlays/yugioh-match.html` (copy `overlays/pokemon-match.html`).
- `yugioh-match-control.html` (copy `pokemon-match-control.html`).

Edited:
- `src/overlay-server.js` - `yugiohMatch` state + mutators + `getState()`.
- `server.js` - `/yugioh-match` + `/yugioh-match-control` routes; register/request-state
  branches; `yugioh-*` relays; `overlayStates`; disconnect; banner.
- `public/js/game-registry.js` - register `yugioh`: `matchControls` (->
  `/yugioh-match-control`), `overlays[]` (`/yugioh-match`, `/overlay`, `/decklist`),
  `deck.categories/categorize/rules`, `searchMeta`. ONLY main-page wiring needed.
- `public/js/deck-parser.js` - `parseYugiohDeckList` + detection.
- `public/js/main.js` / `index.html` - usually no change (generic); touch only for bespoke
  YGO deck stats or a saved-deck -> overlay section mapping.
- `overlays/decklist.html` - generic; add Monsters/Spells/Traps/Extra Deck/Side Deck to
  `CATEGORY_ORDER` (Extra/Side are just extra category keys).

No data-layer changes (optional later: map XYZ `rank` into its own column).

---

## 5. Phasing + per-phase prompts

- Phase 1 - Deck foundation: `parseYugiohDeckList`, categories incl. Extra/Side, custom
  build, formats/banlist, decklist overlay sections.
- Phase 2 - Match overlay/control: `yugiohMatch` state + server wiring +
  `overlays/yugioh-match.html` + `yugioh-match-control.html` + index button.
- Phase 3 - Polish: zone counts, phase stepper, position toggles.

Phase 1 prompt:
> Implement Phase 1 for Yu-Gi-Oh (deck foundation). Add `parseYugiohDeckList` to
> `public/js/deck-parser.js` honoring #main/#extra/!side markers and resolving by
> passcode/name against the DB; categorize Monsters/Spells/Traps and route Extra-Deck
> monster types into an Extra section. Register Yu-Gi-Oh in `public/js/game-registry.js`
> (`deck.categories/categorize/rules`, `searchMeta`) - `addSelectedToDeck` is already
> generic; add an Advanced(TCG) format + banlist structure;
> add Extra/Side sections to the yugioh branch of `overlays/decklist.html`. Report with a
> sample import.

Phase 2 prompt:
> Implement Phase 2 for Yu-Gi-Oh (match overlay/control). Add `yugiohMatch` to
> `src/overlay-server.js` (see state shape in the notes) + mutators + getState; wire
> routes/registration/relays in `server.js`; build `overlays/yugioh-match.html` (per
> player: name/record/games-won, large Life Points, a row of up to 5 monster zones with
> ATK/DEF + position badge, a spell/trap row + field slot, a Normal-Summon flag) and
> `yugioh-match-control.html` to drive it; add Yu-Gi-Oh's `matchControls` (->
> `/yugioh-match-control`) + `overlays[]` to `public/js/game-registry.js`.
> Mirror the Pokemon files. Report observed render.

---

## 6. Open decisions

1. Show full Spell/Trap row + Field slot, or just counts (cleaner)?
2. Per-monster meta: ATK/DEF only, or also Level/Rank and position icons?
3. Banlist region default: TCG (recommended) vs OCG.
4. Worth a small data tweak to store XYZ Rank separately from Level?

## 7. References

- YGOPRODeck (data source): https://ygoprodeck.com/api-guide/
- Official Forbidden & Limited list: https://www.yugioh-card.com/en/limited/
- Basic rules (8000 LP, 40-60 main, 3-of): https://www.yugioh-card.com/en/rulebook/
