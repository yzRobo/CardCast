# One Piece Card Game - CardCast Implementation Plan

Status as of 2026-06-23. Single source of truth for One Piece (OPTCG) support in
CardCast. Produced from `CardCast Game Implementation Template.md`. Covers two features:
the on-stream Match Overlay (Pokemon-style) and Deck Building. No code for these features
has been written yet; the data layer (below) is already complete. Design decisions in
Section 2.2 are PROPOSED - confirm with the user before building (unlike Gundam, which is
locked).

---

## Agent kickoff prompt

Copy-paste this to an LLM coding agent working in the CardCast repo:

> You are adding One Piece Card Game match-overlay + deck-building support to CardCast.
> Read this ENTIRE file first. The data layer is done (color was fixed 2026-06-23) - do
> NOT modify scrapers/parsers/DB schema. Mirror the existing Pokemon implementation as the
> pattern of record: `overlays/pokemon-match.html`, `pokemon-match-control.html`, the
> `pokemonMatch` state in `src/overlay-server.js`, and the `server.js` socket wiring. The
> match-overlay design in section 2.2 is PROPOSED, not locked - confirm those choices with
> the user before building Feature A (featured Leader + 5-character row, variable Life from
> the Leader, DON!! attach UI, Stage slot). Work phase by phase; after each phase, stop and
> report what changed and how you verified it. No emojis anywhere. Start with Phase 1
> (deck foundation) using its per-phase context.

---

## 0. What already exists (the data layer is done)

One Piece is wired end-to-end for card data.

- Source: optcgapi.com (`https://optcgapi.com/api/`, free, no key). Clean JSON with a
  real self-hosted `card_image` URL.
- Ingest/parse: `TCGApi.fetchOnePieceCards` / `parseOnePieceCardData` in `src/tcg-api.js`.
- Schema: One Piece columns in `src/database.js` - `cost`, `op_power`, `counter`,
  `life`, `don_value`, `trigger_text`.
- APIs already accept `onepiece` (in `AVAILABLE_GAMES`).
- Config: `onepiece: { enabled: true }`.
- `overlay-server.js` already has an `onepiece` block in `setupGameOverlay`
  (showLife, lifeTotal:4, showDonDeck, showTrash, showLeader, categories
  Characters/Events/Stages/Leaders).
- Data on disk: 2,558 One Piece cards across 51 set codes in `data/cardcast.db`.

Card data shape (real distributions from the DB):
- `card_type`: Character (1,989), Event (391), Leader (132), Stage (46).
- Stats coverage: cost (2,407), op_power (1,974), counter (1,561), life (132 - leaders
  only), don_value (200 - a per-card `[DON!! xN]` requirement parsed from text, NOT the
  DON!! deck), trigger_text (472), card_text (2,411).
- Leader `life` values: 4 (59) and 5 (66) dominate; 1/2/3/6 are rare promos/specials.

### Data-layer color gap - RESOLVED 2026-06-23

- Color is now captured. `parseOnePieceCardData` maps optcgapi `card_color` into the
  shared `colors` column, and all 2,558 existing rows were backfilled from the API
  (6 colors + multicolor leaders, e.g. "Green Red"). Color identity validation and
  theming can now read `colors`. Note: optcgapi space-joins multicolor (e.g.
  "Green Red"); the deck color rule should split on whitespace. No other data-layer
  work remains for OP - everything else is overlay/control/deck UI.
- Cross-game note: Lorcana has the SAME gap (its ink color is not captured, only the
  `inkable` boolean). Same fix shape (map Lorcast ink into `colors` + re-download).
  Magic, Gundam and Digimon already capture color; see the color matrix in
  `CardCast Game Implementation Template.md` section 1.1.

---

## 1. The match feature stack

1. Data ingestion - DONE.
2. Database - DONE (One Piece columns; color add pending, see above).
3. Server state - no `onePieceMatch` yet.
4. Overlay - no `overlays/onepiece-match.html` yet.
5. Control panel - no `onepiece-match-control.html` yet.

---

## 2. Feature A - One Piece Match Overlay + Control

### 2.1 Game -> overlay mapping

| Pokemon element | One Piece equivalent | Notes |
|---|---|---|
| Prize cards (6) | Leader Life (VARIABLE, 4-5, leader-defined) | Life cards taken like prizes. Count is NOT fixed - parameterize from the chosen Leader's `life`. |
| Active Pokemon (HP bar + Tool chips) | Leader (single featured card: Power, colors) | OP has one dominant Leader - closer to Pokemon's single active than Gundam's grid. |
| Bench (5-7) | Character Area (max 5) | Each Character: Power, optional Counter, attached DON!! count. |
| Stadium (shared) | Stage (1 per player) | Single stage card slot. |
| (new) | DON!! counter (X/10, active/rested, attachable) | Ramping resource; each attached DON!! gives a character +1000 power. |
| Turn flags (Energy/Supporter/Retreat) | proposed: drop or single "DON!! added this turn" | Confirm with user. |
| Bo3 / timer / turn indicator | same | Reuse verbatim. |

### 2.2 Proposed design decisions (CONFIRM before building)

- Board: FEATURED LEADER slot (large, with Power) + Character Area row (up to 5). This
  differs from Gundam's no-lead 6-grid because OP has a central Leader.
- Life: parameterized count, auto-set from the selected Leader's `life` (default 4-5),
  shown as a taken/remaining tracker (reuse the prize/shield grid, variable length).
- DON!! counter: show `X/10` with active/rested split, and allow marking DON!! attached
  to a specific Character (drives a +N000 power readout). More dynamic than Gundam
  resources - this is the main new UI piece.
- Stage: single slot per player (optional, can be empty).
- Turn-flag row: proposed DROP (OP has no rigid per-turn limits beyond 1 DON!!/turn) -
  or a single "DON!! added" flag. Confirm.
- Color theming: optional accent by Leader color (OP leaders are strongly color-coded).

### 2.3 Per-player board layout (vertical side panel)

- Header: name, record (W-L-T), games-won.
- Leader: featured card with Power and color.
- Life: variable-length taken/remaining tracker (from Leader life).
- DON!!: `X/10` active/rested counter (+ attached-to-character markers).
- Character Area: row of up to 5, each = art + Power + attached-DON!! + optional Counter.
- Stage: single card slot.
- Shared match-info bar: Bo3 / timer / whose-turn.

### 2.4 State shape (`overlayServer.onePieceMatch`, mirrors `pokemonMatch`)

```
playerN: {
  name, record:{wins,losses,ties}, gamesWon,
  leader: { id, name, image, power, colors } | null,
  life: { total: 4, taken: [] },              // total seeded from leader.life
  don: { active: 0, rested: 0, max: 10 },
  characters: [ { id, name, image, power, counter, donAttached: 0 } x up to 5 ],
  stage: { id, name, image } | null
}
currentTurn, timer, gameNumber, matchFormat
```

### 2.5 Socket events (new `onepiece-*` namespace)

`onepiece-match-update`, `onepiece-leader-update`, `onepiece-life-total` (set count from
leader), `onepiece-life-taken` / `onepiece-life-reset`, `onepiece-don-update`,
`onepiece-character-update` (set/clear slot), `onepiece-character-power`,
`onepiece-don-attach`, `onepiece-stage-update`, plus reused generic `record-update`,
`match-score-update`, `turn-switch`, `timer-*`, `toggle-onepiece-match`,
`onepiece-match-reset`.

---

## 3. Feature B - Deck building

### 3.1 Official deck construction rules

- 1 Leader card (defines the deck's colors and starting Life).
- Main deck: exactly 50 cards - Characters, Events, Stages. Max 4 copies per card number.
- Every main-deck card must include at least one of the Leader's colors.
- DON!! deck: exactly 10 DON!! cards (uniform; not built from the main deck, not shown
  in the decklist categories).

### 3.2 Deck categories (drive overlay + builder + validation)

`Leader` (1), `Characters`, `Events`, `Stages`. Category derived from `card_type`.
Validation (non-blocking warnings): exactly 1 Leader; main (Characters+Events+Stages)
!= 50; any card number > 4 copies; any card whose color is not in the Leader's colors
(requires the color data-layer add).

### 3.3 Deck import (parser)

Extend `public/js/deck-parser.js`: add `parseOnePieceDeckList(lines)` + a `onepiece`
branch in `detectGameType`. Card-number-keyed: match `([A-Z]{2,4}\d{2}-\d{3})` (e.g.
`OP01-001`, `ST01-002`, `EB01-001`), resolve by `card_number` (game='onepiece') ->
name, `card_type`, image; categorize by `card_type`; the single Leader line becomes the
deck Leader. Lines with no number fall back to name match. Import sources: ExBurst
(exburst.dev), EGMAN deck builder (deckbuilder.egmanevents.com/optcg), onepiece.gg,
official sim exports - all card-number based, resolved locally. TODO: capture one real
export sample to finalize header handling.

### 3.4 Custom deck building (registry-driven)

UPDATE 2026-06-23 (switcher landed): `addSelectedToDeck`, search meta and the saved-decks
list are GENERIC now - do NOT generalize them or add a button/edit `selectGame`. Register
One Piece in `public/js/game-registry.js` with `deck.categories`
`['Leader','Characters','Events','Stages']`, `deck.categorize(card)`, `deck.rules`
`{ main:50, leader:1, copyLimit:4 }`, and `searchMeta(card)`.

Confirmed `card_type` -> category (from the DB): `Leader` -> Leader; `Character` ->
Characters; `Event` -> Events; `Stage` -> Stages. The single Leader line becomes the deck
Leader (sets colors + life); warn on off-color cards as a build-time check. Saved decks
persist + filter per game via `localStorage.savedDecks['onepiece']`; export to card-number
text.

### 3.5 Formats

Unlike Gundam (new game), One Piece is mature and has an OFFICIAL banlist. A format =
legal set pool + the official restricted list + the leader-color identity rule.

- Restriction types (official): Banned cards (0 copies), Restricted cards (1 copy;
  currently none), Banned Pairs (two cards that cannot share a deck) - introduced
  Aug 2025.
- Recommended formats: `Standard` (all legal sets + current banlist - default) and
  `Unlimited` (all sets, no banlist). Optional regional/event formats later.
- Banlist stored as a small editable structure (banned[], restricted[], bannedPairs[])
  we update when Bandai announces changes; source:
  https://en.onepiece-cardgame.com/rules/restriction/
- Default behavior: format LABELS the deck + opt-in "legal only" filter; do not
  hard-block casual builds. Banned-pair checking is a deck-validation warning.

### 3.6 Decklist overlay (now GENERIC - no per-game branch)

`overlays/decklist.html` is game-agnostic (rewritten 2026-06-23): it renders any
`currentDeck.categories` ordered by a `CATEGORY_ORDER` array + `CATEGORY_ACCENT` colors.
For One Piece, append the categories to those structures in order: Leader, Characters,
Events, Stages (optionally give Leader a distinct accent so it reads as the headline).
Send the deck via `decklist-update` as
`{ title, game:'onepiece', categories:{ Leader:[{name,quantity}], Characters:[...], ... } }`.

---

## 4. Integration: deck building <-> match control

A loaded OP deck lets the control: set the Leader (auto-seeding Life total and colors),
filter search to the deck, and quick-add a Character into a board slot (prefilling Power
from `op_power`).

---

## 5. File-by-file work plan

New files:
- `overlays/onepiece-match.html` - overlay (copy `overlays/pokemon-match.html`; featured
  Leader + character row + variable Life tracker + DON!! counter + Stage). Registers as
  `onepiece-match`.
- `onepiece-match-control.html` - control panel (copy `pokemon-match-control.html`;
  Leader picker, Life tracker, DON!! +/- and attach, character slots, Stage, timer,
  records, reset). Registers control `onepiece-match`.

Edited files:
- `src/overlay-server.js` - add `this.onePieceMatch` state + mutators; add to
  `getState()`.
- `server.js` - routes `/onepiece-match` + `/onepiece-match-control`; register-overlay +
  request-state branches; `onepiece-*` relays; `overlayStates`; disconnect emit; banner.
- `public/js/game-registry.js` - register `onepiece`: `matchControls` (->
  `/onepiece-match-control`), `overlays[]` (`/onepiece-match`, `/overlay`, `/decklist`),
  `deck.categories/categorize/rules`, `searchMeta`. ONLY main-page wiring needed.
- `public/js/deck-parser.js` - `parseOnePieceDeckList` + detection.
- `public/js/main.js` / `index.html` - usually no change (generic); touch only for bespoke
  OP deck stats or a saved-deck -> overlay section mapping.
- `overlays/decklist.html` - add the One Piece categories to `CATEGORY_ORDER`/`CATEGORY_ACCENT`
  (generic overlay, no per-game branch).
- DATA-LAYER (One Piece only): DONE 2026-06-23 - `parseOnePieceCardData` maps optcgapi
  `card_color` into `colors`; existing rows backfilled. No further data-layer work.

CSS note: overlays self-contained (no rebuild); control/index use compiled
`public/css/style.css` (rebuild only if new utility classes are added).

---

## 6. Suggested phasing

- Phase 0 - Data add: DONE 2026-06-23 (colors captured + backfilled).
- Phase 1 - Deck foundation (B): model + `parseOnePieceDeckList` + formats/banlist +
  custom build + decklist categories registered.
- Phase 2 - Match overlay/control (A): `onePieceMatch` state, server wiring,
  `overlays/onepiece-match.html`, `onepiece-match-control.html`, index button.
- Phase 3 - Integration: deck-aware control (Leader picker seeds life/colors; quick-add).

---

## 7. Open decisions / questions

1. Confirm the proposed match design (featured Leader + 5-char row; DON!! attach UI;
   drop turn-flags).
2. Life tracker visual: reuse the prize/shield grid at variable length, or a numeric
   counter? (Leader life ranges 4-5, occasionally other.)
3. DON!! display: active/rested split + per-character attach markers, or a single X/10?
4. Decklist overlay: RESOLVED - overlay is now generic; just register the One Piece
   categories in `CATEGORY_ORDER` (no footer-stats choice).
5. Formats: enforce banned-pairs as a hard block or a warning? (Plan assumes warning.)
6. Color source: RESOLVED - optcgapi exposes `card_color`; mapped + backfilled 2026-06-23.

---

## 8. External references

- Official rules / restrictions (banlist): https://en.onepiece-cardgame.com/rules/restriction/
- Data source (already used): https://optcgapi.com/api/
- ExBurst (OP hub + builder + decklists): https://exburst.dev/
- EGMAN deck builder (OP): https://deckbuilder.egmanevents.com/optcg/cards
- onepiece.gg (banlist + meta): https://onepiece.gg/banned-and-restricted-cards/
