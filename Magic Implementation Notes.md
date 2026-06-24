# Magic: The Gathering - CardCast Implementation Plan

Status as of 2026-06-23. Produced from `CardCast Game Implementation Template.md`. Magic
is the one game that already has a partial match overlay (built months ago, Commander-
focused). The decision here is to RESTART clean on "MTG proper" (60-card Standard, 20
life) and drop the Commander-specific complexity for now. The data layer is complete.

IMPLEMENTED 2026-06-23 (branch `feat/gundam-support`, uncommitted). Phases 1-3 done and
verified; Phase 4 poison included, the banlist legality filter deferred (structure only).
Reusable Playwright checks: `scripts/verify-mtg-match.mjs` (overlay, 27 checks),
`scripts/verify-mtg-control.mjs` (control, 34), `scripts/verify-mtg-deck.mjs` (deck import,
11). Three pre-existing bugs were fixed in passing: records never reached the overlay
(`mtg-record-update` vs `mtg-player-record-update`), "Set Active" only toggled (player-
switch ignored its payload), and lands never updated (control sent `count`, server read
`lands`). MTG keeps its server-authoritative model (state in `src/overlay-server.js`); only
the visual/UX pattern mirrors Pokemon.

IMPORTANT (read before building): unlike the other game docs, Magic already has working
files - `overlays/mtg-match.html`, `mtg-match-control.html`, the `mtgMatch` state in
`src/overlay-server.js`, the `mtg-*` socket relays in `server.js`, the `magic` entry in
`public/js/game-registry.js` (the Main Page Game Switcher landed 2026-06-23 - there is no
`mtgMatchBtn`/`selectGame` hardcoding anymore; the match button + OBS links + deck
categories/`searchMeta` all come from that registry entry), and MTG deck import in
`public/js/deck-parser.js`. This is a refactor/refocus, not greenfield. Prefer rebuilding
the overlay + control cleanly against the current architecture (mirroring the newer
Pokemon implementation) over patching the old Commander-era code.

---

## Agent kickoff prompt

Copy-paste this to an LLM coding agent working in the CardCast repo:

> You are refocusing Magic: The Gathering match-overlay support in CardCast onto "MTG
> proper" (60-card constructed, 20 starting life) and removing the Commander-specific
> pieces. Read this ENTIRE file first. The data layer is done - do NOT modify
> scrapers/parsers/DB schema. Magic already has older files (`overlays/mtg-match.html`,
> `mtg-match-control.html`, `mtgMatch` in `src/overlay-server.js`, `mtg-*` relays in
> `server.js`). Use the NEWER Pokemon implementation (`overlays/pokemon-match.html`,
> `pokemon-match-control.html`, `pokemonMatch` state, server wiring) as the pattern of
> record, and rebuild Magic to match that pattern. Work phase by phase in the order in
> this document; after each phase, stop and report what changed and how you verified it.
> No emojis anywhere. Start with Phase 1 using its per-phase prompt below.

---

## 0. Data layer status (done)

- Source: Scryfall (free, no key; bulk download preferred). File: `src/tcg-api.js`
  (`fetchMagicCards` / `parseMagicCardData`).
- Schema columns: `mana_cost`, `cmc`, `power`, `toughness`, `loyalty`, `colors`,
  `color_identity`, `type_line`, `oracle_text`, `flavor_text`.
- Cards in DB: 60,220. Coverage: type_line 60,209, mana_cost 55,037, cmc 54,827,
  power/toughness 30,196 (creatures), loyalty 682 (planeswalkers), colors 48,839,
  color_identity 54,501.
- card_type (from type_line): Instant, Sorcery, Enchantment, Artifact, Aura, Land,
  Equipment, and many `Creature - X` subtypes.
- No fields needed-but-missing. Color is fully captured (shared `colors` + the MTG-only
  `color_identity`); MTG uses concatenated WUBRG letters (e.g. "WU"), not slash-joined.

---

## 1. The match feature stack (current state)

1-2. Data ingestion + DB - DONE.
3. Server state - `mtgMatch` EXISTS in `src/overlay-server.js` (life, commanderDamage,
   lands, featuredPermanents, phase, format, record, gamesWon, turnActions
   {landPlayed, spellCast}, activePlayer). Commander-specific bits to remove: commander
   damage, 40-life format switching.
4. Overlay - `overlays/mtg-match.html` EXISTS (player containers, life display with
   healthy/low/critical states, turn actions, commander-damage section, phase indicator,
   format badge, timer, featured permanents).
5. Control - `mtg-match-control.html` EXISTS (Commander-era).

Deck import - EXISTS: `parseMTGDeckList` in `public/js/deck-parser.js` handles Arena /
Moxfield / TCGplayer formats (mainboard + sideboard). The decklist overlay
(`overlays/decklist.html`) is generic (renders any categories) and already lists
Creatures/Spells/Lands in its `CATEGORY_ORDER`.

---

## 2. Feature A - Match overlay + control (MTG proper)

### 2.1 Mapping table

| Pokemon element | Magic equivalent | Notes |
|---|---|---|
| Prize cards (6) | Life total (starts 20) | Big number per player; healthy/low/critical color. The headline. |
| Active Pokemon (HP bar + tools) | Featured Permanents (small row of key cards) | Keep the existing featuredPermanents concept (threats/bombs on the battlefield). |
| Bench | (not used) | MTG has no fixed board slots; the battlefield is open. Represent only featured permanents. |
| Stadium | (not used) | drop. |
| (new) | Lands in play (count) | ramp/resource readout (already in mtgMatch). |
| (new) | Phase indicator | Untap/Upkeep/Draw/Main1/Combat/Main2/End2/End. |
| Turn flags (Energy/Supporter/Retreat) | Land played / Spell cast | Keep (already in mtgMatch.turnActions). |
| (optional) | Poison counters (0-10) | MTG-proper alt loss condition; small optional counter. |
| Bo3 / timer / turn indicator | same | Reuse. |

### 2.2 Design decisions (recommended; confirm)

- DROP Commander damage and the 40-life format switch. Default format = Standard, life
  20. Keep a simple format LABEL (Standard) on the bar.
- Headline = the two life totals (large, center-weighted), with active-player highlight.
- Keep Featured Permanents as a small per-player row (operator adds key cards from
  search), with optional tap/summoning-sick state if cheap to add.
- Keep Lands count + Phase indicator + Land/Spell turn flags (they read well on stream).
- Add optional Poison counter per player (hidden when 0).

### 2.3 Per-player layout

Header (name, record, games-won) | Life total (large) | Lands count | Featured
Permanents row | turn flags (Land/Spell) | optional Poison. Shared bar: format / timer /
phase / whose-turn.

### 2.4 State shape (refactor `mtgMatch`)

```
playerN: { name, record, gamesWon, life: 20, poison: 0, lands: 0,
           featuredPermanents: [ {id,name,image,tapped?} ], turnActions:{landPlayed,spellCast} }
activePlayer, currentPhase, timer, gameNumber, matchFormat: 'Standard'
```
Remove: commanderDamage, 40-life logic.

### 2.5 Socket events

Reuse the existing `mtg-*` events, minus `mtg-commander-damage-update`. Keep
`mtg-life-update`, `mtg-lands-update`, `mtg-permanent-add/remove/clear`,
`mtg-phase-update`, `mtg-turn-action`, `mtg-player-switch`, `mtg-*-name/record/games`,
`mtg-match-reset`. Add `mtg-poison-update` (optional).

---

## 3. Feature B - Deck building

### 3.1 Construction rules (MTG proper / Standard-style constructed)

- Main deck: minimum 60 cards. Max 4 copies per card name (except basic lands).
- Sideboard: up to 15 (already parsed). Optional on the overlay.
- Color identity is informational in constructed (no hard color limit like Commander).

### 3.2 Categories (decklist overlay + builder)

`Creatures`, `Instants/Sorceries (Spells)`, `Artifacts`, `Enchantments`, `Planeswalkers`,
`Lands`. Derive from `type_line`. The decklist overlay already buckets Creatures/Spells/
Lands for the footer; keep that.

### 3.3 Import - DONE

`parseMTGDeckList` already supports Arena, Moxfield, and TCGplayer text. Verify it routes
into the categories above; resolve names against the local DB (set code optional).

### 3.4 Custom build

DONE 2026-06-23 via the registry: `addSelectedToDeck` is already generic and Magic's
`deck.categorize` (buckets by `card_type`/`type_line`) + `searchMeta` (mana cost) live in
the `magic` entry of `public/js/game-registry.js`. Saved decks persist + filter per game
via `localStorage.savedDecks['magic']`. Remaining/optional: live stats (total /60,
per-category counts, 4-copy check with basics exempt) from `deck.rules`.

### 3.5 Formats

A format = legal set pool + banlist. Recommended: `Standard` (current rotation set pool +
Standard banlist - default), plus `Pioneer`/`Modern`/`Legacy` as larger set pools later.
Banlist stored per format (editable). Default behavior: label + opt-in legality filter.
Source for banlists/rotation: official WotC banned-and-restricted page.

### 3.6 Decklist overlay (now GENERIC - no per-game branch)

`overlays/decklist.html` is game-agnostic (rewritten 2026-06-23): it renders any
`currentDeck.categories` ordered by a `CATEGORY_ORDER` array + `CATEGORY_ACCENT` colors
(it already lists Creatures/Spells/Lands). Ensure the Magic categories are present in
`CATEGORY_ORDER`: Creatures, Spells, Artifacts, Enchantments, Planeswalkers, Lands. Send
the deck via `decklist-update` as `{ title, game:'magic', categories:{ Creatures:[...], ... } }`.

---

## 4. File-by-file work plan

Edit (refactor):
- `src/overlay-server.js` - simplify `mtgMatch` (drop commanderDamage + 40-life);
  remove `updateCommanderDamage`; keep the rest; add `poison` (optional).
- `overlays/mtg-match.html` - rebuild against the Pokemon pattern: life headline, lands,
  featured permanents, phase, turn flags, optional poison. Remove commander-damage UI.
- `mtg-match-control.html` - rebuild control to match (life +/-, lands, add/remove
  featured permanents from search, phase stepper, turn flags, reset). Remove commander UI.
- `server.js` - drop `mtg-commander-damage-update` relay; keep the rest; banner already
  lists MTG.
- `public/js/game-registry.js` - the `magic` entry already provides matchControls
  (-> `/mtg-match-control`), overlays, `deck.categories/categorize` and `searchMeta`;
  extend it rather than editing `main.js`/`selectGame`.
- `overlays/decklist.html` - generic; just ensure the Magic categories exist in
  `CATEGORY_ORDER` (Creatures/Spells/Lands already there).

No new files needed (the mtg-match routes/files already exist). No data-layer changes.

---

## 5. Phasing

- Phase 1 - De-Commander the state + overlay: simplify `mtgMatch`, rebuild
  `overlays/mtg-match.html` to the life/lands/permanents/phase layout.
- Phase 2 - Rebuild `mtg-match-control.html` to drive the new overlay.
- Phase 3 - Deck building polish: confirm `parseMTGDeckList` -> categories, generalize
  custom build, add the formats/banlist label.
- Phase 4 - Optional: poison counters; format set-pool filter.

Per-phase prompts:

Phase 1:
> Implement Phase 1 for Magic. In `src/overlay-server.js` simplify `mtgMatch` to MTG
> proper: 20 life, drop commanderDamage and 40-life switching, add `poison:0`. Then
> rebuild `overlays/mtg-match.html` to show, per player: name/record/games-won, a large
> life total (healthy/low/critical color), lands count, a featured-permanents row, and
> Land/Spell turn flags; shared bar with format(Standard)/timer/phase/active-player.
> Mirror the structure of `overlays/pokemon-match.html`. Report the new state shape and a
> screenshot/observed render.

Phase 2:
> Implement Phase 2 for Magic. Rebuild `mtg-match-control.html` to drive the Phase 1
> overlay over the existing `mtg-*` socket events (life +/-, lands, add/remove featured
> permanents via card search, phase stepper, turn flags, names/records/games, reset).
> Remove all Commander-damage UI. Mirror `pokemon-match-control.html`.

Phase 3:
> Implement Phase 3 for Magic. Confirm `parseMTGDeckList` routes into the categories
> Creatures/Spells/Artifacts/Enchantments/Planeswalkers/Lands; generalize
> `addSelectedToDeck` in `public/js/main.js` for those buckets; add a Standard format
> label + banlist structure (label-only + opt-in legality filter).

---

## 6. Open decisions

1. Keep any Commander support behind a future flag, or remove entirely for now? (Plan:
   remove now, re-add later as its own format.)
2. Featured-permanents: show tap state and counters, or just name/art?
3. Poison counters: include in v1 or defer?
4. Which Standard set pool / banlist snapshot to seed the format with?

## 7. References

- Scryfall (data source): https://scryfall.com/docs/api
- Official banned & restricted: https://magic.wizards.com/en/banned-restricted-list
- Comprehensive rules (life=20, deck>=60, 4-of): https://magic.wizards.com/en/rules
