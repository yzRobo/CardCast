# Gundam Card Game - CardCast Implementation Plan

Status as of 2026-06-23. This document is the single source of truth for everything
planned for Gundam support in CardCast. It covers two features: the on-stream Match
Overlay (Pokemon-style) and Deck Building (import, custom build, formats). No code for
these features has been written yet; the data layer (below) is already complete.

---

## Agent kickoff prompt

Copy-paste this to an LLM coding agent working in the CardCast repo:

> You are adding Gundam Card Game match-overlay + deck-building support to CardCast. Read
> this ENTIRE file first. The data layer is done - do NOT modify scrapers/parsers/DB
> schema. Mirror the existing Pokemon implementation as the pattern of record:
> `overlays/pokemon-match.html`, `pokemon-match-control.html`, the `pokemonMatch` state in
> `src/overlay-server.js`, and the `server.js` socket wiring. The match-overlay design is
> LOCKED (section 2.2): equal 6-unit grid, no turn-flag row, include Base + Resources,
> Shields=6. Work phase by phase in the order in this document; after each phase, stop and
> report what changed and how you verified it. No emojis anywhere. Start with Phase 1
> (deck foundation) using the suggested phasing section.

---

## 0. What already exists (the data layer is done)

Gundam is already wired end-to-end for card data. None of this needs to change.

- Scraper: `src/scrapers/gundam-scraper.js` (gundam-gcg.com; boosters + ST starter decks).
- Ingest/parse: `TCGApi.fetchGundamCards` / `parseGundamCardData` in `src/tcg-api.js`.
- Schema: `gd_*` columns in `src/database.js` (+ `addGundamColumns` migration).
- APIs already accept `gundam` (it is in `AVAILABLE_GAMES`): `/api/search/:game`,
  `/api/card/:game/:id`, `/api/download/:game`, `/api/download-images/:game`, lazy
  `/cache/images/...`.
- Config: `gundam: { enabled: true }` in `config.json`.
- Data on disk: 1,494 Gundam cards currently in `data/cardcast.db`.

Card data shape (real distributions from the DB):
- `card_type`: UNIT (774), COMMAND (227), PILOT (197), RESOURCE (139), BASE (87),
  plus tokens (UNIT TOKEN, EX RESOURCE, EX BASE).
- `gd_color`: Blue / Green / Red / White / Purple, plus "-" (colorless). Color is
  already scraped from the site's COLOR stat (gd_color is 100% populated). As of
  2026-06-23 it is also mirrored into the shared `colors` column (parser writes both;
  existing rows backfilled - 1,285 colored, 209 colorless left null) so the cross-game
  color-identity tooling reads color the same way for every game. No re-scrape was
  needed; the color data was already present.
- Stats: `gd_ap`, `gd_hp`, `gd_level` (Lv.), `gd_cost`, `gd_zone`, `gd_trait`,
  `gd_link`, `gd_sp`, `gd_block_icon`. `card_number` like `GD01-001`, `ST01-001`,
  `EB01-001`. `set_code` like GD01-GD04, ST01-ST10, EB01, EX*, promos.

---

## 1. The Match feature stack (how Pokemon is built)

The Pokemon match feature is a 5-layer stack. For Gundam, layers 1-2 are done; layers
3-5 are what we build.

1. Data ingestion - DONE (scraper + parse).
2. Database - DONE (`gd_*` columns, search, card fetch, images).
3. Server state - `src/overlay-server.js` holds authoritative in-memory match state
   (`this.pokemonMatch`, `this.mtgMatch`) and re-broadcasts on mutation. No
   `gundamMatch` yet.
4. Overlay (OBS source) - `overlays/pokemon-match.html`, a self-contained 1920x1080
   page that registers over socket.io and renders. No Gundam equivalent.
5. Control panel - `pokemon-match-control.html`, searches cards and emits socket
   events; surfaced from the main UI by the game's `matchControls` entry in
   `public/js/game-registry.js` (the `selectGame` override was removed 2026-06-23).
   No Gundam equivalent.

Socket contract is the glue: control emits -> `server.js` relays -> overlay-server
stores -> overlay renders.

---

## 2. Feature A - Gundam Match Overlay + Control

### 2.1 Game -> overlay mapping

| Pokemon element | Gundam equivalent | Notes |
|---|---|---|
| Prize cards (6) | Shields (6) | 1:1 - reuse the 6-slot grid, relabel. Shields are Gundam's life track. |
| Active Pokemon (HP bar + Tool chips) | Unit (AP/HP + paired Pilot chip) | Pilot pairing reuses the tool-attachment mechanic. |
| Bench (5-7) | Battle Area (max 6 units) | Gundam caps the battle area at 6 units. |
| Stadium (shared) | dropped | Gundam has no shared field zone. |
| (new) | Base slot per player (HP) | BASE cards / EX Base defend with HP. |
| (new) | Resource counter per player | active/total + EX Resource flag. |
| Turn flags (Energy/Supporter/Retreat) | dropped | Gundam has no rigid per-turn limits. |
| Bo3 / timer / turn indicator | same | Reuse verbatim. |

### 2.2 Locked design decisions (user-selected 2026-06-23)

- Battle Area = equal 6-unit grid (3x2), NOT a featured lead unit. Each cell: card
  art + AP chip + HP bar (currentHp/maxHp) + optional paired Pilot chip.
- Drop the per-player turn-flag row; reclaim the space.
- Include BOTH a per-player Base slot (with HP) and a Resource counter (active/total
  + EX Resource flag).

### 2.3 Per-player board layout (vertical side panel, P1 left / P2 right)

- Header: name, record (W-L-T), games-won.
- Shields: 6-slot row (reuse prize-card grid + taken logic).
- Resources: counter `active/total` with EX Resource indicator.
- Battle Area: equal 6-unit grid, each cell = art + AP + HP bar + Pilot chip.
- Base: single card slot with its own HP bar.
- Shared match-info bar: Bo3 / timer / whose-turn (verbatim from Pokemon).

### 2.4 State shape (`overlayServer.gundamMatch`, mirrors `pokemonMatch`)

```
playerN: {
  name, record:{wins,losses,ties}, gamesWon,
  shields: 6, shieldsTaken: [],
  resources: { active: 0, total: 0, ex: false },
  units: [ { id, name, image, ap, maxHp, currentHp, pilot:{name,image}|null } x up to 6 ],
  base: { id, name, image, maxHp, currentHp } | null
}
currentTurn, timer, gameNumber, matchFormat
```

### 2.5 Socket events (new `gundam-*` namespace, mirroring pokemon/mtg)

`gundam-match-update`, `gundam-unit-update` (set/clear a grid slot), `gundam-unit-hp`,
`gundam-pilot-pair`, `gundam-base-update`, `gundam-base-hp`, `gundam-resource-update`,
`gundam-shield-taken`, `gundam-shields-reset`, `record-update` / `match-score-update`
(reuse generic), `turn-switch`, `timer-*` (reuse), `toggle-gundam-match`,
`gundam-match-reset`.

---

## 3. Feature B - Deck Building (the foundational piece)

This underpins both the decklist overlay and the match control (a loaded deck lets the
operator quick-add units to the board and filter search to legal/owned cards). Today's
deck system is Pokemon/MTG-only and "formats" are a cosmetic label.

### 3.1 Official Gundam deck construction rules

- Main deck: exactly 50 cards - Units, Pilots, Commands, Bases. Max 4 copies per card
  number.
- Resource deck: exactly 10 cards - Resource cards only. No per-card copy limit.
- Colors: up to 2 colors in a deck (warn, do not hard-block, on import).
- Recommended composition (guidance only): Units 25-28, Pilots 6-8, Commands 8-10,
  Bases 4-6.

### 3.2 Deck data model & categories

Decklist categories for Gundam (drives the overlay + custom builder + validation):
`Units`, `Pilots`, `Commands`, `Bases`, `Resources`. Category is derived from the
card's `card_type` in the DB (authoritative), not from import section headers.

Validation surfaced to the user (non-blocking warnings):
- main (Units+Pilots+Commands+Bases) != 50.
- resources != 10.
- any card number with > 4 copies.
- more than 2 distinct `gd_color` values among non-colorless cards.

### 3.3 Deck import (parser)

Extend `public/js/deck-parser.js`:
- Add `parseGundamDeckList(lines)` and a `gundam` branch to `detectGameType`
  (detect the `GDxx-NNN` / `STxx-NNN` / `EBxx-NNN` card-number token, and/or builder
  section headers like "Resource Deck").
- Strategy: card-number-keyed and tolerant. For each non-empty, non-header line:
  - leading quantity: `^(\d+)\s*x?\s+`
  - card-number token: `([A-Z]{2,4}\d{2}-\d{3}[A-Za-z0-9_]*)`
  - resolve by `card_number` (game='gundam') -> name, `card_type`, image; categorize
    by `card_type`. Lines with no number fall back to name match.
- Supports exports from ExBurst (exburst.dev) and the EGMAN deck builder
  (deckbuilder.egmanevents.com), plus the official builder. Both are card-number
  based, so the number-keyed resolver is robust regardless of exact layout.
- TODO: capture one real text export from each of ExBurst and EGMAN to finalize the
  header/whitespace handling (the number-keyed core works without it).

The resolver should run against the local DB via the existing
`/api/search` / `/api/card` endpoints (no new external calls).

### 3.4 Custom deck building (registry-driven)

UPDATE 2026-06-23 (switcher landed): `addSelectedToDeck`, search meta and the saved-decks
list are GENERIC now - do NOT generalize them or add a button/edit `selectGame`. Register
Gundam in `public/js/game-registry.js` instead:
- `deck.categories` `['Units','Pilots','Commands','Bases','Resources']`, plus
  `deck.categorize(card)` and `deck.rules` `{ main:50, resources:10, copyLimit:4 }`,
  and `searchMeta(card)`.
- Confirmed `card_type` -> category (from the DB, values are ALL CAPS): `UNIT` (and
  `UNIT TOKEN` / `UNIT・TOKEN`) -> Units; `PILOT` -> Pilots; `COMMAND` -> Commands; `BASE`
  (and `EX BASE`) -> Bases; `RESOURCE` (and `EX RESOURCE`) -> Resources. Have `categorize`
  uppercase/trim and match by prefix so the TOKEN / EX variants and the fullwidth "・"
  fall into the right bucket.
- Saved decks persist + filter per game via `localStorage.savedDecks['gundam']`; export
  single deck back to a card-number text format both builders can re-import.
- Live deck stats while building come from `deck.rules` (per-category counts, main /50,
  resources /10, color check, 4-copy check).

### 3.5 Formats (EGMAN set-based)

Introduce a real (lightweight) format concept, replacing the cosmetic 'Standard'
label for Gundam. A format = a name + a set of legal `set_code`s (+ an optional
banlist hook for later).

Recommended definitions (verify exact set membership against the
egmanevents.com/gundam-gdXX-format pages before shipping):

```
gundamFormats = {
  unlimited: { name: 'Unlimited',     sets: '*' },                 // all downloaded sets (default)
  gd04:      { name: 'GD04 Standard', sets: [GD01..GD04, ST01..ST10, EB01, EX*, promos] },
  gd03:      { name: 'GD03',          sets: [..through GD03] },
  gd02:      { name: 'GD02',          sets: [..through GD02] },
  gd01:      { name: 'GD01',          sets: [GD01, ST01..ST04, EX*] }
}
```

Usage:
- The deck's format label shows on the decklist overlay header and the match-info bar.
- Optional "legal only" toggle filters card search / deck building to the format's
  legal set pool (recommended default: label-only; legality filter is an opt-in toggle
  so it never blocks a casual build).
- Banlist/restricted list: keep as a small editable list per format we can update when
  official or EGMAN announcements happen (currently negligible for a new game).

Decision to confirm: do formats only LABEL a deck, or also RESTRICT search/build? Plan
assumes label-by-default + opt-in legality filter.

### 3.6 Decklist overlay (now GENERIC - no per-game branch)

`overlays/decklist.html` was rewritten 2026-06-23 to be game-agnostic: it renders any
`currentDeck.categories` and orders them by a `CATEGORY_ORDER` array, coloring each via a
`CATEGORY_ACCENT` map (unknown categories sort last, default accent). No per-game footer/
branch. For Gundam, just append the categories to those two structures:
- `CATEGORY_ORDER`: Units, Pilots, Commands, Bases, Resources (in that order).
- `CATEGORY_ACCENT` (optional): e.g. Units=blue, Pilots=amber, Commands=red, Bases=green,
  Resources=slate.
- Send the deck via `decklist-update` as `{ title, game:'gundam', categories:{ Units:[{name,quantity}], ... } }`.

---

## 4. Integration: deck building <-> match control

Once a Gundam deck is loaded/saved, the Gundam match control should be able to:
- Filter card search to the loaded deck (mirrors Pokemon's "search deck only" toggle).
- Quick-add a deck Unit straight into a battle-area grid slot (prefills AP/HP from
  `gd_ap`/`gd_hp`), and pair a deck Pilot onto a unit.
This is why deck building is foundational: it speeds up live operation of the overlay.

---

## 5. File-by-file work plan

New files:
- `overlays/gundam-match.html` - overlay (copy `overlays/pokemon-match.html`; 6-unit
  grid renderer, shields, resources, base, match bar). Registers as `gundam-match`.
- `gundam-match-control.html` - control panel (copy `pokemon-match-control.html`;
  search->assign unit/pilot/base, shield + resource trackers, HP setters, timer,
  records, reset). Registers control `gundam-match`.

Edited files:
- `src/overlay-server.js` - add `this.gundamMatch` state + mutators; add to
  `getState()`.
- `server.js` - routes `/gundam-match` + `/gundam-match-control`; `gundam-match`
  branches in register-overlay and request-state; `gundam-*` relays; add to
  `overlayStates`; disconnect emit; startup banner.
- `public/js/game-registry.js` - register `gundam`: `matchControls` (->
  `/gundam-match-control`), `overlays[]` (`/gundam-match`, `/overlay`, `/decklist`),
  `deck.categories/categorize/rules`, `searchMeta`. ONLY main-page wiring needed (the
  switcher rebuilds Match Controls, OBS sources, deck buckets and search meta from it).
- `public/js/deck-parser.js` - `parseGundamDeckList` + `gundam` detection.
- `public/js/main.js` / `index.html` - usually no change (`addSelectedToDeck` +
  `currentDeckList` are generic now); touch only for bespoke Gundam deck stats or a
  saved-deck -> overlay section mapping.
- `overlays/decklist.html` - add the Gundam categories to `CATEGORY_ORDER`/`CATEGORY_ACCENT`
  (generic overlay, no per-game branch).
- `src/database.js` (optional) - add `gd_ap, gd_hp` to the shared search `SELECT` so
  Gundam search tiles can show AP/HP.

No data-layer changes required.

CSS note: overlays are self-contained `<style>` (no rebuild). Control + index use the
compiled `public/css/style.css`; rebuild CSS only if new utility classes are
introduced (see the CardCast design-system memory).

---

## 6. Suggested phasing

- Phase 1 - Deck foundation (B): deck model + `parseGundamDeckList` + formats +
  custom build + decklist categories registered. Foundational; independently useful
  (the generic decklist overlay works for Gundam immediately).
- Phase 2 - Match overlay/control (A): `gundamMatch` state, server wiring,
  `overlays/gundam-match.html`, `gundam-match-control.html`, index button.
- Phase 3 - Integration: deck-aware match control (search-deck-only, quick-add units
  from deck).

A and B are largely independent; Phase 1 first because the user flagged deck building
as foundational and it makes Phase 2's control panel faster to operate.

---

## 7. Open decisions / questions

1. Decklist overlay: RESOLVED - the overlay is now generic; just register the Gundam
   category names in `CATEGORY_ORDER` (no footer-stats choice needed).
2. Formats: label-only by default with an opt-in legality filter (assumed), or enforce
   legality in search/build?
3. Exact set membership of each EGMAN GDxx format (verify against
   egmanevents.com/gundam-gdXX-format pages).
4. Resource counter on the overlay: show active/total split, or a single number?
5. Color theming: accent player boards by deck `gd_color`, or keep P1 indigo / P2 red?

---

## 8. External references

- Official deck-building rules: https://www.gundam-gcg.com/en/news/decks-build.html
- Official card database (scrape source): https://www.gundam-gcg.com/en/cards
- EGMAN Events (Gundam hub, set-based formats): https://egmanevents.com/gundam
- EGMAN deck builder: https://deckbuilder.egmanevents.com/gundam/deck
- ExBurst (Gundam hub + builder + decklists): https://exburst.dev/gundam/
- ExBurst deck builder: https://exburst.dev/gundam/deckbuilder
