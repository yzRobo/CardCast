# Disney Lorcana - CardCast Implementation Plan

Status as of 2026-06-23. Produced from `CardCast Game Implementation Template.md`. Covers
the on-stream Match Overlay + Deck Building. No feature code written yet; the data layer
is complete (including ink/color, fixed 2026-06-23). The repo owner does not play Lorcana,
so the board-state choices below are recommendations to build unless overridden.

---

## Agent kickoff prompt

Copy-paste this to an LLM coding agent working in the CardCast repo:

> You are adding Disney Lorcana match-overlay + deck-building support to CardCast. Read
> this ENTIRE file first. The data layer is done - do NOT modify scrapers/parsers/DB
> schema. Mirror the existing Pokemon implementation as the pattern of record:
> `overlays/pokemon-match.html`, `pokemon-match-control.html`, the `pokemonMatch` state
> in `src/overlay-server.js`, and the `server.js` socket wiring. Work phase by phase in
> the order in this document; after each phase, stop and report what changed and how you
> verified it. No emojis anywhere. Start with Phase 1 using its per-phase prompt below.

---

## 0. Data layer status (done)

- Source: Lorcast `api.lorcast.com` (free, no key). File: `src/tcg-api.js`
  (`fetchLorcanaCards` / `parseLorcanaCardData`).
- Schema columns: `ink_cost`, `strength`, `willpower`, `lore_value`, `inkable`, plus the
  shared `colors` (= ink).
- Cards in DB: 2,916. Coverage: ink_cost 2,916, colors (ink) 2,916, willpower 2,329,
  lore_value 2,252, inkable 2,209, strength 2,134.
- card_type: Character (2,231), Action (214), Item (210), Action / Song (163),
  Location (98).
- Color = INK: Amber, Amethyst, Emerald, Ruby, Sapphire, Steel. Captured in shared
  `colors`; dual-ink stored slash-joined (e.g. "Amethyst/Sapphire"). Decks are 1-2 inks,
  so ink IS a deckbuilding constraint - split `colors` on "/".

---

## 1. The match feature stack

1-2. Data ingestion + DB - DONE. 3. No `lorcanaMatch` yet. 4. No overlay. 5. No control.
Decklist overlay is generic (renders any categories via CATEGORY_ORDER/CATEGORY_ACCENT) -
just add the Lorcana category names there.

KEY DIFFERENCE FROM EVERY OTHER GAME: Lorcana has no life total. You win by being first to
20 LORE. The headline tracker counts UP to 20, not down from a life value.

---

## 2. Feature A - Match overlay + control

### 2.1 Mapping table

| Pokemon element | Lorcana equivalent | Notes |
|---|---|---|
| Prize cards (6) | LORE track (0 -> 20, first to 20 wins) | Headline. A progress bar/counter going UP, not a depleting life. |
| Active Pokemon (HP bar + tools) | Characters in play (row) | Each: Strength / Willpower / Lore, ready/exerted state, AND accumulated damage toward Willpower (banished when damage >= willpower) - track damage like Pokemon HP depletion. |
| Bench | (folded into the characters row) | No fixed slots; show characters in play. |
| Stadium (shared) | Locations (per player, can be multiple) | Locations have Willpower + a per-turn Lore value; show as small cards. |
| (new) | INK count (available / total in inkwell) | The resource. Each turn a card may be inked face-down; ink pays costs. |
| Items | small chips / count | optional. |
| Turn flags | (optional) "inked this turn" | one-per-turn ink action; or drop. |
| Bo3 / timer / turn indicator | same | reuse. |

### 2.2 Design decisions (recommended)

- Headline = the LORE race: a 0-20 progress bar + number per player (clearly a count-up to
  20). Highlight the leader.
- INK counter per player (available/total), the resource readout.
- Characters row: each card shows Strength/Willpower/Lore, a ready/exerted (upright/
  tilted) state, and accumulated damage (a small "damage / willpower" readout, analogous
  to Pokemon's HP bar - the character is banished when damage reaches willpower); exerted
  = quested or challenged this turn.
- Locations: a small slot or row per player (Willpower + Lore/turn). Items: optional chips.
- Turn flag: optional single "inked this turn"; otherwise drop the flag row.

### 2.3 Per-player layout

Header (name, record, games-won) | LORE track 0-20 (large) | INK available/total |
Characters row (Strength/Willpower/Lore + exerted) | Locations row | optional Items.
Shared bar: timer / whose-turn / Bo3.

### 2.4 State shape (`overlayServer.lorcanaMatch`)

```
playerN: { name, record, gamesWon, lore: 0, ink: { available: 0, total: 0 },
           characters: [ {id,name,image,strength,willpower,lore,damage:0,exerted:bool} ],
           locations: [ {id,name,image,willpower,lore} ],
           items: [ {id,name,image} ] }
activePlayer, timer, gameNumber, matchFormat: 'Core'
```

### 2.5 Socket events (`lorcana-*`)

`lorcana-match-update`, `lorcana-lore-update`, `lorcana-ink-update`,
`lorcana-character-update` (set/clear/exert), `lorcana-location-update`,
`lorcana-item-update`, plus reused generic `record-update`, `match-score-update`,
`turn-switch`, `timer-*`, `toggle-lorcana-match`, `lorcana-match-reset`.

---

## 3. Feature B - Deck building

### 3.1 Construction rules

- Deck: minimum 60 cards. Max 4 copies per card (by full name incl. version). Up to 2
  inks per deck (ink identity from the shared `colors`). No sideboard in standard play.

### 3.2 Categories (decklist overlay + builder)

`Characters`, `Actions` (incl. Songs), `Items`, `Locations`. Derive from `card_type`.

### 3.3 Import (parser)

Extend `public/js/deck-parser.js` with `parseLorcanaDeckList` + a `lorcana` branch in
`detectGameType`. Lorcana exports (Dreamborn, Pixelborn, inkdecks, ravensburger app) are
usually `quantity name` lines, sometimes with set/number. Strategy: parse `^(\d+)x?\s+`
quantity + name; resolve by name (and set/number if present) against the local DB;
categorize by `card_type`. TODO: capture a real Dreamborn/inkdecks export to finalize.

### 3.4 Custom build

UPDATE 2026-06-23 (switcher landed): `addSelectedToDeck`, search meta and the saved-decks
list are GENERIC now - do NOT generalize them or add a button/edit `selectGame`. Instead
register Lorcana in `public/js/game-registry.js` with `deck.categories`
`['Characters','Actions','Items','Locations']`, `deck.categorize(card)`, `deck.rules`
`{ main:60, copyLimit:4, maxInks:2 }`, and `searchMeta(card)`.

Confirmed `card_type` -> category (from the DB): `Character` -> Characters; `Action` and
`Action / Song` -> Actions; `Item` -> Items; `Location` -> Locations. The 2-ink check is a
build-time warning (ink from the shared `colors`, split on "/"; dual-ink counts toward
both). Saved decks persist + filter per game via `localStorage.savedDecks['lorcana']`.

### 3.5 Formats

A format = legal set pool (+ minimal banlist). Recommended: `Core` (current rotation - the
default competitive format) and `Infinity` (all sets). Ravensburger publishes a short
banned/restricted list; store editable. Label + opt-in legality filter (with the 2-ink
rule as a build warning).

### 3.6 Decklist overlay (now GENERIC - no per-game branch)

`overlays/decklist.html` is game-agnostic (rewritten 2026-06-23): it renders any
`currentDeck.categories` ordered by a `CATEGORY_ORDER` array + `CATEGORY_ACCENT` colors.
For Lorcana, append the categories in order: Characters, Actions, Items, Locations
(optional ink-colored accents). Send the deck via `decklist-update` as
`{ title, game:'lorcana', categories:{ Characters:[{name,quantity}], ... } }`.

---

## 4. File-by-file work plan

New files:
- `overlays/lorcana-match.html` (copy `overlays/pokemon-match.html`).
- `lorcana-match-control.html` (copy `pokemon-match-control.html`).

Edited:
- `src/overlay-server.js` - `lorcanaMatch` state + mutators + `getState()`.
- `server.js` - `/lorcana-match` + `/lorcana-match-control` routes; register/request-state
  branches; `lorcana-*` relays; `overlayStates`; disconnect; banner.
- `public/js/game-registry.js` - register `lorcana`: `matchControls` (->
  `/lorcana-match-control`), `overlays[]` (`/lorcana-match`, `/overlay`, `/decklist`),
  `deck.categories/categorize/rules`, `searchMeta`. ONLY main-page wiring needed.
- `public/js/deck-parser.js` - `parseLorcanaDeckList` + detection.
- `public/js/main.js` / `index.html` - usually no change (generic); touch only for bespoke
  Lorcana deck stats (incl. ink) or a saved-deck -> overlay section mapping.
- `overlays/decklist.html` - add the Lorcana categories to `CATEGORY_ORDER`/`CATEGORY_ACCENT`
  (generic overlay, no per-game branch).

No data-layer changes (ink/color already captured).

---

## 5. Phasing + per-phase prompts

- Phase 1 - Deck foundation: `parseLorcanaDeckList`, categories, custom build with 2-ink
  rule, Core/Infinity formats, decklist categories registered.
- Phase 2 - Match overlay/control: `lorcanaMatch` + server wiring +
  `overlays/lorcana-match.html` (LORE race + ink + characters) + `lorcana-match-control.html`
  + index button.

Phase 1 prompt:
> Implement Phase 1 for Lorcana (deck foundation). Add `parseLorcanaDeckList` to
> `public/js/deck-parser.js` (quantity+name lines, resolve by name against the DB,
> categorize by card_type into Characters/Actions/Items/Locations). Register Lorcana in
> `public/js/game-registry.js` (`deck.categories/categorize/rules` with a 60-card / 4-copy /
> max-2-ink check, ink from the shared `colors` split on "/"; `searchMeta`) -
> `addSelectedToDeck` is already generic. Add Core + Infinity
> formats. Add the Lorcana category names to `CATEGORY_ORDER` in `overlays/decklist.html`
> (generic overlay - no branch). Report with a sample import.

Phase 2 prompt:
> Implement Phase 2 for Lorcana (match overlay/control). Add `lorcanaMatch` to
> `src/overlay-server.js` (see state shape) + mutators + getState; wire
> routes/registration/relays in `server.js`; build `overlays/lorcana-match.html` (per
> player: name/record/games-won, a LORE progress track 0->20 as the headline, an
> ink available/total counter, a characters row showing Strength/Willpower/Lore +
> exerted state, and a locations row) and `lorcana-match-control.html` to drive it; add
> Lorcana's `matchControls` (-> `/lorcana-match-control`) + `overlays[]` to
> `public/js/game-registry.js`. Mirror the Pokemon files. IMPORTANT: lore counts
> UP to 20 (win), it is not a depleting life total. Report observed render.

---

## 6. Open decisions

1. LORE display: progress bar to 20, a 0-20 pip track, or a big number? (Plan: bar +
   number.)
2. Show Strength/Willpower/Lore on every character, or just Lore + exerted state?
3. Locations: dedicated row, or fold into characters?
4. Format default: Core (rotation) vs Infinity.

## 7. References

- Lorcast (data source): https://lorcast.com / https://api.lorcast.com
- Official rules (win at 20 lore, 60-card, 4-of, 2 inks): https://www.disneylorcana.com/en-US/how-to-play
