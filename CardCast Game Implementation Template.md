# CardCast Game Implementation Template

A reusable skeleton for adding full overlay support for a new TCG to CardCast. Copy this
file to `<Game> Implementation Notes.md` and fill in every `<PLACEHOLDER>`. Worked
instances of this template: `Gundam Implementation Notes.md`, `One Piece Implementation
Notes.md`.

The structure is deliberately split so most of it is game-agnostic and only the mapping
table, design decisions, deck rules, and formats change per game. If a slot below makes
you ask "what is the answer for this game?" - that question is the point; answering it is
how you discover everything the build needs.

Convention: no emojis in CardCast docs.

---

## 0. How to use this template (the workflow)

1. Profile the game's data that is already in CardCast (Step 1 below). Run the DB query.
2. Confirm the game's rules: life/win condition, board zones, resource system, deck
   construction, formats/banlist. Cite official sources.
3. Fill the mapping table (Section 3.1) - map each CardCast overlay element to the
   game's equivalent. Empty/awkward cells are findings, not gaps to skip.
4. Note the deltas vs the Pokemon baseline (variable counts, single featured card,
   attachable resources, missing captured fields, etc.). These deltas are the real work.
5. Lock the design decisions (Section 3.2) - ask the user the per-game design questions.
6. Fill deck building (Section 4) and formats (Section 4.5).
7. Fill the file-by-file plan (Section 5) - the file set is almost always the same.
8. List open decisions and references.

Fill-in checklist (every item must be answered before building):
- [ ] Data layer status: is ingest/parse/schema/search/images already wired? card count?
- [ ] Captured fields vs needed fields - any field the overlay/deck rules need but the
      parser does not capture yet? (common miss: color/attribute, subtypes)
- [ ] Life/win track: fixed or variable count? where does the number come from?
- [ ] Featured card: is there a single dominant card (Leader/etc.) or none?
- [ ] Board zone: name, max size, per-card stats shown.
- [ ] Resource system: static counter, ramping, attachable?
- [ ] Extra single-card zones (base/stage/field)?
- [ ] Deck construction rules: main size, secondary deck, copy limit, color rules.
- [ ] Categories for the decklist overlay + custom builder (from card_type).
- [ ] Formats/banlist: set pools, official restricted list, color identity.
- [ ] Import sources + export text shape (resolve by card number locally).

### 0.1 Embedded agent prompts (required in every filled doc)

Each filled `<Game> Implementation Notes.md` is meant to be handed to an LLM coding agent.
So every doc MUST embed ready-to-use prompts:

- One "## Agent kickoff prompt" block near the top - a copy-paste blockquote that tells
  the agent to read the whole file, names the Pokemon files as the pattern of record,
  states the guardrails (do not touch the data layer; no emojis; work phase by phase and
  stop/report after each), and says to start with Phase 1.
- One "Phase N prompt:" blockquote inside the phasing section for each phase - a short
  imperative naming the files to touch and the acceptance criteria.

Keep prompts concrete and file-specific so the user only has to say "read this file and
get started." See `Gundam Implementation Notes.md` or `One Piece Implementation Notes.md`
for the established shape.

---

## 1. Data layer status (profile what already exists)

Run this to profile the game (replace `<game>` with the game id):

```
node -e "const D=require('better-sqlite3');const db=new D('data/cardcast.db',{readonly:true});
const g='<game>';console.log('count',db.prepare('SELECT COUNT(*) c FROM cards WHERE game=?').get(g).c);
console.log(db.prepare('SELECT card_type,COUNT(*) c FROM cards WHERE game=? GROUP BY card_type ORDER BY c DESC').all(g));
db.close();"
```

Fill in:
- Game id: `<game>` | Display name: `<Name>`
- Source: `<API or scrape source>` (file: `<src/... >`).
- Ingest/parse: `<TCGApi.fetch...Cards / parse...CardData>` - DONE? `<yes/no>`
- Schema: per-game columns `<col list>` - present? `<yes/no>`
- APIs accept the game (in `AVAILABLE_GAMES`)? `<yes/no>`
- Cards currently in DB: `<N>`
- card_type distribution: `<...>`
- Per-card stat fields and their coverage: `<field: count, ...>`
- FIELDS NEEDED BUT NOT CAPTURED: `<e.g. color/attribute>` (data-layer add required: `<yes/no>`)

### 1.1 Color / identity capture across games (reference, as of 2026-06-23)

Color (or its per-game equivalent) is the most common "needed but maybe not captured"
field, because for several games it gates deck legality (color identity). Status:

| Game | Color mechanic | Gates deckbuilding? | Captured? |
|---|---|---|---|
| Magic | Colors (WUBRG) | Yes | Yes - shared `colors` + `color_identity` |
| Gundam | Color (Blue/Green/Red/White/Purple) | Yes (max 2) | Yes - `gd_color`, mirrored into shared `colors` |
| One Piece | Color (must match Leader) | Yes | Yes - shared `colors` from optcgapi `card_color` (incl. multicolor) |
| Lorcana | Ink (Amber/Amethyst/Emerald/Ruby/Sapphire/Steel) | Yes (max 2 inks) | Yes - shared `colors` from Lorcast `ink`/`inks` (dual joined with "/") |
| Digimon | Color (color + color2) | Yes | Yes - shared `colors` from digimoncard.io `color`/`color2` |
| Yu-Gi-Oh | Attribute (DARK/LIGHT/...) - not true color | No | Yes - `attribute` (monsters only); not color, does not gate decks |
| Pokemon | Energy Type (Fire/Water/...) | No (mix freely) | No - cosmetic only (overlay/energy symbols) |

Convention: a color-bearing game populates the shared `colors` column (in addition to
any game-specific column) so cross-game color-identity tooling reads color uniformly. As
of 2026-06-23 Magic, Gundam, One Piece, Lorcana and Digimon all do - no deckbuilding
color gaps remain.

WATCH OUT (lesson from Digimon): do not assume a game-specific column that mentions color
actually holds the CARD's color. Digimon's `digivolve_color` was the color required to
digivolve INTO the card (`evolution_color`), NOT the card's own color - so a naive mirror
would have stored the wrong color (e.g. Omnimon as Red instead of White). Always confirm
against the source API which field is the card's identity color.

Multicolor format: standardized to slash-joined ("Green/Red", "Amethyst/Sapphire",
"Purple/Red") across One Piece, Lorcana and Digimon. Magic uses concatenated WUBRG
letters (its own convention); Gundam is single-color. Split on "/" for those three;
treat Magic per its letters.

---

## 2. The match feature stack (the 5 layers)

1. Data ingestion - `<status>`
2. Database - `<status>`
3. Server state - `src/overlay-server.js` holds `this.<game>Match`; mutators re-broadcast.
4. Overlay (OBS source) - `overlays/<game>-match.html`, self-contained 1920x1080 page.
5. Control panel - `<game>-match-control.html`, surfaced by the game's `matchControls`
   entry in `public/js/game-registry.js` (`GAME_REGISTRY`) - NOT by editing `selectGame`.

Socket contract: control emits -> `server.js` relays -> overlay-server stores -> overlay
renders. Reuse the Pokemon/MTG pattern.

---

## 3. Feature A - Match overlay + control

### 3.1 Mapping table (fill per game)

| CardCast element (Pokemon baseline) | `<Game>` equivalent | Notes |
|---|---|---|
| Life/win track - Prize cards (6) | `<e.g. Shields(6) / Leader Life(var) / ...>` | fixed or variable? |
| Active card (HP bar + Tool chips) | `<featured card or N/A>` | single featured card? |
| Bench (5-7) | `<board zone, max size>` | per-card stats shown |
| Stadium (shared) | `<field/base/stage or dropped>` | |
| Resource system (none in Pokemon) | `<counter / ramp / attachable>` | |
| Turn flags (Energy/Supporter/Retreat) | `<keep / which / drop>` | |
| Bo3 / timer / turn indicator | same | reuse verbatim |

### 3.2 Design decisions to lock with the user (per game)

- Board representation: featured-card + row, or equal grid? `<decision>`
- Turn-flag row: keep (which flags) or drop? `<decision>`
- Extra zones (field/base/stage, resource counter): include which? `<decision>`
- Life/win track: fixed count or parameterized from a card? `<decision>`
- Color theming of player boards? `<decision>`

### 3.3 Per-player board layout

`<bullet list of the vertical board sections, top to bottom>`

### 3.4 State shape (`overlayServer.<game>Match`, mirrors `pokemonMatch`)

```
playerN: { name, record:{wins,losses,ties}, gamesWon,
           <life track>, <board array>, <resource>, <extra zones> }
<top-level>: currentTurn, timer, gameNumber, matchFormat
```

### 3.5 Socket events (new `<game>-*` namespace)

`<list the events: board update/clear, hp/power, attach, life-taken, resource-update,
reset, toggle, plus reused generic record/turn/timer events>`

---

## 4. Feature B - Deck building

### 4.1 Official deck construction rules

- Main deck: `<size>` cards - `<card types allowed>`. Max `<N>` per card number.
- Secondary deck (if any): `<e.g. resource deck 10 / DON!! deck 10 / none>`.
- Color rules: `<e.g. up to 2 colors / must match leader / none>`.
- Other: `<leader required, recommended composition, etc.>`

### 4.2 Deck categories (drive overlay + builder + validation)

`<Category list derived from card_type, e.g. Units/Pilots/Commands/Bases/Resources>`.
Category is derived from the card's `card_type` (authoritative), not import headers.

Validation (non-blocking warnings): `<main != size, secondary != size, >N copies,
color rule violations>`.

### 4.3 Deck import (parser)

Extend `public/js/deck-parser.js`: add `parse<Game>DeckList(lines)` + a `<game>` branch
in `detectGameType`. Strategy: card-number-keyed and tolerant - match the game's card
number token (`<regex, e.g. [A-Z]{2,4}\d{2}-\d{3}>`), resolve by `card_number` against
the local DB, categorize by `card_type`. Lines with no number fall back to name match.
Import sources: `<sites>`. TODO: capture one real export sample per source to finalize
header handling (the number-keyed core works regardless).

### 4.4 Custom deck building (registry-driven)

UPDATE 2026-06-23: the Main Page Game Switcher landed, so `addSelectedToDeck`,
`displaySearchResults`, `updateCardPreview` and the saved-decks list are already GENERIC -
they read the active game from `public/js/game-registry.js`. Do NOT edit `main.js` for
bucketing/meta and do NOT add a hardcoded match button or touch `selectGame` (the old
two-`selectGame` footgun is gone). Instead add the game's entry to `GAME_REGISTRY` with:
`deck.categories` (ordered labels), `deck.categorize(card)` (a `card_type` switch returning
a label), `deck.rules`, and `searchMeta(card)` (the per-card stat line). Saved decks
already persist + filter per game via `localStorage.savedDecks['<game>']`; export back to a
card-number text format. Live stats while building come from `deck.rules`.

### 4.5 Formats

A format = name + legal `set_code` pool (+ optional banlist/restricted list + color
identity rule). NOTE: "formats" are only a cosmetic 'Standard' label in CardCast today -
a real format concept is net-new the first time any game needs it.

`<Define the formats for this game: set pools, official banlist source, color rules.>`
Recommended default: format LABELS a deck (shown on overlay) + an opt-in "legal only"
filter for search/build; do not hard-block casual builds.

### 4.6 Decklist overlay (now GENERIC - no per-game branch needed)

`overlays/decklist.html` was rewritten 2026-06-23 to be game-agnostic. It renders ANY
`currentDeck.categories` and orders them by a `CATEGORY_ORDER` array, coloring each via a
`CATEGORY_ACCENT` map (unknown categories sort last with a default accent). There is no
hardcoded per-game footer/branch anymore. To support a game you only:
- append the game's category names to `CATEGORY_ORDER` (for nice ordering) and optionally
  add accent colors in `CATEGORY_ACCENT`; and
- send the deck via `decklist-update` as
  `{ title, game, categories: { <Category>: [{ name, quantity }] } }`.
Category `<order>` for this game: `<list>`.

---

## 5. Integration: deck building <-> match control

A loaded deck lets the match control: filter search to the deck, and quick-add a
board card straight into a slot (prefilling stats from the card's columns). This is why
deck building is foundational and usually sequenced first.

---

## 6. File-by-file work plan (standard set)

New files:
- `overlays/<game>-match.html` - overlay (copy `overlays/pokemon-match.html`).
- `<game>-match-control.html` - control panel (copy `pokemon-match-control.html`).

Edited files:
- `src/overlay-server.js` - add `this.<game>Match` state + mutators; add to `getState()`.
- `server.js` - routes `/<game>-match` + `/<game>-match-control`; register-overlay +
  request-state branches; `<game>-*` relays; `overlayStates`; disconnect emit; banner.
- `public/js/game-registry.js` - add/extend the game's `GAME_REGISTRY` entry:
  `matchControls` (-> `/<game>-match-control`), `overlays[]` (e.g. `/<game>-match`, plus the
  generic `/overlay` + `/decklist`), `deck.categories`, `deck.categorize(card)`,
  `deck.rules`, `searchMeta(card)`. This is the ONLY main-page wiring needed: the switcher
  rebuilds Match Controls, OBS sources, deck buckets, search meta and the saved-decks
  filter from it. Do NOT add a hardcoded button or edit `selectGame`.
- `public/js/deck-parser.js` - `parse<Game>DeckList` + detection.
- `public/js/main.js` / `index.html` - usually NO change (generic now); touch only if the
  game needs bespoke deck stats or a saved-deck -> overlay section mapping in
  `showDeckOnOverlay`.
- `overlays/decklist.html` - add the game's category names to `CATEGORY_ORDER` (+ optional
  `CATEGORY_ACCENT`); overlay is generic, no per-game branch.
- `src/tcg-api.js` / `src/database.js` - ONLY if a needed field is not captured yet
  (e.g. add a color/attribute mapping + column).

CSS note: overlays are self-contained `<style>` (no rebuild). Control + index use compiled
`public/css/style.css`; rebuild CSS only if new utility classes are introduced.

---

## 7. Suggested phasing

- Phase 1 - Deck foundation (B): model + parser + formats + custom build + decklist
  overlay branch. Foundational and independently useful.
- Phase 2 - Match overlay/control (A): state + server wiring + overlay + control + button.
- Phase 3 - Integration: deck-aware match control.

---

## 8. Open decisions / questions

`<numbered list of per-game decisions still to confirm>`

## 9. External references

`<official rules, card database/source, format/banlist sources, deck builders>`
