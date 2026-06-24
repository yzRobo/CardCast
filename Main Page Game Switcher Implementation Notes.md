# Main Page Game Switcher - CardCast Implementation Plan

Status as of 2026-06-23. This is a CROSS-CUTTING refactor doc (not a single-game doc). It
makes CardCast's main page (`index.html` + `public/js/main.js`) fully game-aware so a
single game selector drives the entire page - search, deck builder, overlay/OBS links,
and match-control links - with each game cleanly separated so switching games never breaks
another. Produced in the style of the per-game `<Game> Implementation Notes.md` docs.

This refactor is FOUNDATIONAL for the per-game overlay work: once the game registry below
exists, adding a new game's match-control button and overlay links becomes a one-line
registry entry instead of editing branching logic. Recommended to do this BEFORE (or
alongside) the first new per-game overlay.

---

## Agent kickoff prompt

Copy-paste this to an LLM coding agent working in the CardCast repo:

> You are refactoring CardCast's main page so one game selector drives the entire page.
> Read this ENTIRE file first. Do NOT modify the data layer (scrapers/parsers/DB schema)
> or the server's API routes. The work is client-side: `index.html` and
> `public/js/main.js` (and the small CSS in `public/css`). Today the page is hardcoded for
> Pokemon with some Magic bolted on, and there are TWO `selectGame` functions (one in
> main.js, one overriding it in index.html) - consolidate them into a single data-driven
> switcher backed by a GAME_REGISTRY (section 2). Work phase by phase; after each phase,
> stop and report what changed and how you verified it (load the page, switch games, check
> each panel updates and nothing leaks between games). No emojis anywhere. Start with
> Phase 1 using its per-phase prompt below.

---

## 0. Current state (what the review found)

- Search BACKEND is game-agnostic and works: `/api/search/:game` and `/api/card/:game/:id`
  accept every game in `AVAILABLE_GAMES`; `handleSearch` already uses `currentGame`. So
  search is not actually Pokemon-only - the surrounding UI is.
- Pokemon-hardcoded client pieces (the real problem):
  - `addSelectedToDeck` (`public/js/main.js`) buckets only into pokemon/trainers/energy.
  - `parseDeckList` (`public/js/deck-parser.js`) detects only pokemon/magic.
  - `updateCardPreview` / `displaySearchResults` show Pokemon-ish meta (e.g. `hp`).
  - Match Controls sidebar: `pokemonMatchBtn` / `mtgMatchBtn` shown by hardcoded
    `gameId ===` checks.
  - OBS Browser Sources list (`index.html` ~line 562) is a STATIC list: Main, Pokemon
    Match, MTG, Prizes, Decklist - not driven by the selected game.
  - `pokemonMatchControls` block shown only for `gameId === 'pokemon'`.
- FOOTGUN: there are two `selectGame` definitions. `public/js/main.js` defines and exports
  `window.selectGame`; `index.html` (~line 768) does
  `const originalSelectGame = window.selectGame; window.selectGame = function(...) {...}`
  to wrap it. Any per-game UI change must currently touch both. This refactor removes the
  override and centralizes behavior.
- Deck context already has a `deckGameSelect` dropdown and saved decks are already keyed by
  game (`localStorage.savedDecks[game]`) - good building blocks to reuse.

---

## 1. Goal

A single game selector (dropdown) at the top of the main page. Changing it sets
`currentGame` and rebuilds every game-specific panel from a per-game config, so:
- Search + card preview show the right per-game meta.
- Deck builder uses the right categories, rules, formats, and shows only that game's saved
  decks.
- OBS Browser Sources lists exactly that game's overlays.
- Match Controls shows exactly that game's control-panel link(s).
- Switching games never leaves another game's state/links/categories on screen.

The existing left sidebar games list can stay (clicking a game still selects it) but must
stay in sync with the dropdown - both call the same `selectGame`.

---

## 2. Design - a client-side GAME_REGISTRY

Introduce one config object (e.g. `public/js/game-registry.js`, loaded before `main.js`)
that is the single source of truth for per-game main-page behavior. Shape:

```
const GAME_REGISTRY = {
  pokemon: {
    name: 'Pokemon',
    matchControls: [ { label: 'Pokemon Match Control', route: '/pokemon-match-control' } ],
    overlays: [
      { label: 'Pokemon Match', route: '/pokemon-match' },
      { label: 'Prizes',        route: '/prizes' },
      { label: 'Decklist',      route: '/decklist' },
      { label: 'Main',          route: '/overlay' }
    ],
    deck: {
      categories: ['Pokemon', 'Trainers', 'Energy'],
      // how to bucket a card -> category, by card_type/fields
      categorize: (card) => /* ... */,
      rules: { main: 60, copyLimit: 4 },
      formats: ['Standard', 'Expanded']
    },
    // which stat to show on a search result / preview tile
    searchMeta: (card) => card.hp ? `HP ${card.hp}` : ''
  },
  magic:   { ... overlays: [{label:'MTG Match', route:'/mtg-match'}], deck:{categories:['Creatures','Spells','Artifacts','Enchantments','Planeswalkers','Lands'], ...}, ... },
  gundam:  { ... matchControls:[{label:'Gundam Match Control', route:'/gundam-match-control'}], overlays:[{label:'Gundam Match', route:'/gundam-match'}], deck:{categories:['Units','Pilots','Commands','Bases','Resources'], rules:{main:50, secondary:10, copyLimit:4, maxColors:2}}, ... },
  onepiece:{ ... },
  lorcana: { ... },
  digimon: { ... },
  yugioh:  { ... }
};
```

Entries only need to exist for games that have UI; a game with no overlay yet simply omits
`matchControls`/`overlays` (the panels render empty/"coming soon"). THIS REGISTRY IS WHERE
EACH NEW GAME REGISTERS when its overlay/deck support lands - the per-game docs' "add a
button in index.html" step becomes "add/extend this game's registry entry".

`selectGame(gameId)` becomes data-driven: read `GAME_REGISTRY[gameId]`, then
(re)render the Match Controls list, the OBS Browser Sources list, the deck panel
(categories + saved decks filtered to gameId), and set the search placeholder + meta
renderer. Delete the `index.html` override and fold its logic into this one function.

---

## 3. Per-panel behavior after the refactor

- Game selector dropdown: bound to `currentGame`; options from `GAME_REGISTRY` (or
  `/api/games`), disabled/"no data" styling for games without data. Stays in sync with the
  sidebar games list.
- Search + preview: unchanged backend; `displaySearchResults`/`updateCardPreview` call the
  registry's `searchMeta(card)` instead of hardcoding `hp`.
- Deck builder: `addSelectedToDeck` uses `registry.deck.categorize(card)`; the import path
  uses the game's parser (`deck-parser.js` routes by `currentGame`); saved-decks list
  filters to `savedDecks[currentGame]`; deck stats use `registry.deck.rules`.
- OBS Browser Sources: render the list from `registry.overlays` (label + URL + copy
  button), replacing the static block. Keep the copy-button wiring generic.
- Match Controls: render buttons from `registry.matchControls`; show the "select a game"
  hint when the game has none.

---

## 4. File-by-file work plan

New:
- `public/js/game-registry.js` - the `GAME_REGISTRY` object; loaded before `main.js` in
  `index.html`.

Edited:
- `index.html` - add the game-selector dropdown; convert OBS Browser Sources + Match
  Controls blocks to render dynamically; load `game-registry.js`; REMOVE the
  `window.selectGame` override (~line 768) so there is a single switcher.
- `public/js/main.js` - make `selectGame` data-driven from the registry (rebuild all
  panels); generalize `addSelectedToDeck`, `displaySearchResults`, `updateCardPreview`,
  saved-deck rendering to use the registry; keep the sidebar games list in sync with the
  dropdown.
- `public/js/deck-parser.js` - ensure `parseDeckList` routes by `currentGame` (per-game
  parsers are added by the per-game docs; this refactor just makes the main page call the
  right one).
- `public/css/*` - only if new classes are introduced (rebuild compiled CSS if so).

NOT touched: `server.js` API routes, `src/*` data layer, the overlay HTML files.

---

## 5. Phasing + per-phase prompts

- Phase 1 - Registry + data-driven selectGame: add `game-registry.js` (start with the
  games that already have UI: pokemon, magic), refactor `selectGame` to rebuild Match
  Controls + OBS Sources + deck panel from it, and DELETE the index.html override.
- Phase 2 - Game-aware deck builder + search meta: generalize `addSelectedToDeck`,
  `displaySearchResults`, `updateCardPreview`, and saved-deck filtering to the registry.
- Phase 3 - Dropdown UI + no-leak switching: add the top game dropdown, sync it with the
  sidebar list, and verify switching games fully rebuilds every panel with no residue.
- Phase 4 - Backfill registry entries for the remaining games as their overlays land
  (gundam, onepiece, yugioh, lorcana, digimon).

Phase 1 prompt:
> Implement Phase 1 of the Main Page Game Switcher. Create `public/js/game-registry.js`
> exporting `GAME_REGISTRY` with entries for pokemon and magic (matchControls, overlays,
> deck.categories, searchMeta) per the doc. Load it before `public/js/main.js` in
> `index.html`. Refactor `selectGame` in `main.js` to read the registry and rebuild the
> Match Controls list and the OBS Browser Sources list dynamically, and REMOVE the
> `window.selectGame` override in `index.html` so there is exactly one switcher. Verify by
> loading the page and switching between Pokemon and Magic: the match-control button and
> OBS links must change to match. Report what changed.

Phase 2 prompt:
> Implement Phase 2 of the Main Page Game Switcher. Make the deck builder and search
> game-aware via the registry: `addSelectedToDeck` categorizes using
> `GAME_REGISTRY[currentGame].deck.categorize`; `displaySearchResults` and
> `updateCardPreview` use `registry.searchMeta(card)` instead of hardcoded `hp`; the saved-
> decks list shows only `savedDecks[currentGame]`. Verify with Pokemon and one other game
> that adding a searched card buckets correctly and saved decks filter per game.

Phase 3 prompt:
> Implement Phase 3 of the Main Page Game Switcher. Add a game-selector dropdown at the top
> of the main page, bound to `currentGame`, options from the registry/`/api/games` with
> disabled styling for games lacking data. Keep it in sync with the left sidebar games list
> (both call `selectGame`). Verify that switching games via either control fully rebuilds
> Match Controls, OBS Sources, deck categories, and saved decks, with no residue from the
> previous game.

---

## 6. How this connects to the per-game docs

Each `<Game> Implementation Notes.md` currently says "add a `<game>MatchBtn` in
`index.html` and show it in `selectGame`". After this refactor, that step becomes "add (or
fill in) the game's entry in `GAME_REGISTRY` (matchControls + overlays + deck)". If you run
this refactor first, the per-game agents do less and cannot reintroduce the two-selectGame
footgun. Either order works, but registry-first is cleaner.

---

## 7. Open decisions

1. Dropdown placement: top header bar vs above the games sidebar. (Either; header reads
   best.)
2. Keep the left sidebar games list as well, or replace it with the dropdown? (Recommend
   keep both, synced.)
3. Should games without downloaded data be hidden, disabled, or shown with a Download
   prompt in the dropdown? (Recommend disabled + "no data" hint.)
4. Registry location: a plain `public/js/game-registry.js` global (matches the no-build,
   vanilla-JS style) vs inline in index.html. (Recommend the separate file.)

## 8. References (internal)

- `index.html` - main page (games list ~325, deckGameSelect ~526, OBS Sources ~562,
  Match Controls ~413, selectGame override ~768).
- `public/js/main.js` - selectGame, handleSearch, displaySearchResults, updateCardPreview,
  addSelectedToDeck, saved-deck rendering.
- `public/js/deck-parser.js` - parseDeckList (game routing).
- `overlays/` + `*-match-control.html` - the routes the registry links to.
