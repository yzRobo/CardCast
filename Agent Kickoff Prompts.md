# CardCast Agent Kickoff Prompts

Copy-paste prompts to start a fresh LLM coding-agent chat for each piece of work. Every
prompt enforces the same flow: read the plan doc, then study the current code, then
confirm understanding, and ONLY THEN write code - phase by phase, stopping to report and
verify after each phase.

Each prompt pairs with its `... Implementation Notes.md` file in this repo. The data layer
is already complete for every game, so none of these touch scrapers/parsers/DB schema.

The Main Page Game Switcher has LANDED and `public/js/game-registry.js` exists - each game
registers its entry there (matchControls + overlays + deck.categories/categorize/rules +
searchMeta) rather than hardcoding a button. Games can run in any order. Magic is a
refocus of existing code; Gundam and One Piece have the richest plans.

NOTE FOR EVERY GAME: the match phase builds BOTH the overlay (`overlays/<game>-match.html`)
AND its own dedicated control page (`<game>-match-control.html`) - one control page per
game, mirroring the Pokemon pair - and registers the game in the GAME_REGISTRY so the
switcher surfaces that control page + overlay links when the game is selected.

## Status after the Gundam build (2026-06-23)

Gundam shipped first and established the pattern for every remaining game, committed as the
2.0 baseline (`feat/gundam-support`). The next agents have LESS to do than their docs imply:

- The deck-library generalization is DONE (Gundam's "Phase 0"): saved-deck counts,
  show-on-overlay, clipboard export, deck-only search, and deck-view are now registry-driven.
  Do NOT re-generalize them - just add your game's registry entry + parser + `CATEGORY_ORDER`.
- `public/js/game-registry.js` is the single source of truth. Copy the `gundam` entry as a
  worked example (categories, `<game>CategoryFromType`, rules, label-only formats, searchMeta).
- Concrete reference to mirror (besides Pokemon): `overlays/gundam-match.html`,
  `gundam-match-control.html`, the `gundamMatch` state + mutators in `src/overlay-server.js`,
  the `gundam-match` wiring in `server.js`, `parseGundamDeckList` in `deck-parser.js` (NOTE:
  `parseDeckList` is now async), and the `scripts/verify-gundam-*.mjs` harnesses.
- Preserve legacy saved-deck shapes: Pokemon `{pokemon,trainers,energy}` and MTG
  `{cards,sideboard}` are read by their control pages - do NOT migrate them to `.categories`.
  New games use `.categories`.
- Formats: label-only + an opt-in "legal only" filter is the standard for ALL games.
- Build + verify on the current baseline, then HAND OFF to the architect chat for the commit
  - do NOT commit yourself (the tree co-mingles concerns that need consolidated commits).

---

## 1) Main Page Game Switcher

```
You are working in the CardCast repo (Node/Express + Socket.io, vanilla-JS frontend, better-sqlite3, DaisyUI/Tailwind). Goal: make the main page game-aware via one dropdown + a GAME_REGISTRY, with no cross-game breakage.

STEP 1 - READ THE PLAN. Read `Main Page Game Switcher Implementation Notes.md` in full (kickoff prompt, GAME_REGISTRY design, per-panel behavior, phasing, per-phase prompts).

STEP 2 - STUDY THE CURRENT CODE (do not edit yet). Read and understand:
- index.html (games list ~325, deckGameSelect ~526, OBS Browser Sources ~562, Match Controls ~413, and the selectGame OVERRIDE ~768)
- public/js/main.js (selectGame ~243, handleSearch, displaySearchResults, updateCardPreview, addSelectedToDeck ~921, saved-deck rendering)
- public/js/deck-parser.js (parseDeckList game routing)
- server.js (the /overlay, /prizes, /decklist routes and the match-control routes the registry will link to)

GUARDRAILS:
- There are TWO selectGame functions (main.js defines window.selectGame; index.html overrides it ~768) - consolidate into ONE data-driven switcher.
- Do NOT modify the data layer (scrapers/parsers/DB schema) or server API routes; this is client-side (index.html + public/js/*).
- IGNORE dist-portable/ and seed-build/ (stale generated copies).
- overlays/decklist.html is already GENERIC; the Main Overlay (/overlay) is already a generic single-card display. No emojis.

STEP 3 - CONFIRM UNDERSTANDING BEFORE CODING. Write a short summary: the GAME_REGISTRY shape, which panels selectGame will rebuild, the files you'll touch, and any open questions. Do NOT write code until you've done this and resolved the open questions.

STEP 4 - IMPLEMENT PHASE BY PHASE per the doc. After each phase STOP, report what changed, and verify by loading the page and switching games (every panel updates; nothing leaks between games).
```

---

## 2) Gundam

```
You are working in the CardCast repo (Node/Express + Socket.io, vanilla-JS frontend, better-sqlite3). Goal: add Gundam Card Game match-overlay + deck-building support.

STEP 1 - READ THE PLAN. Read `Gundam Implementation Notes.md` in full (design is LOCKED: equal 6-unit grid, no turn-flag row, include Base + Resources, Shields=6).

STEP 2 - STUDY THE CURRENT CODE (do not edit yet), which you will mirror:
- overlays/pokemon-match.html + pokemon-match-control.html (overlay + control pattern)
- src/overlay-server.js (pokemonMatch state object + mutators + getState)
- server.js (/pokemon-match + /pokemon-match-control routes, the register-overlay/request-state branches, the socket relays, overlayStates, and the disconnect handler - you must add all of these for gundam-match)
- public/js/deck-parser.js + public/js/main.js (deck import + addSelectedToDeck)
- overlays/decklist.html (GENERIC - you register category names in CATEGORY_ORDER/CATEGORY_ACCENT; do NOT add a per-game branch)
- index.html (how a match-control button is surfaced; if the Main Page Game Switcher has landed, register Gundam in GAME_REGISTRY instead)

GUARDRAILS:
- Data layer is DONE (Gundam cards + gd_* fields + colors are populated). Do NOT modify scrapers/parsers/DB schema.
- IGNORE dist-portable/ and seed-build/. No emojis. Overlays are self-contained <style>; rebuild compiled CSS only if you add new utility classes.

STEP 3 - CONFIRM UNDERSTANDING BEFORE CODING. Summarize the gundamMatch state shape, files to touch, socket events, and any open questions. No code until that's done.

STEP 4 - IMPLEMENT PHASE BY PHASE per the doc (Phase 1 deck foundation first). The match phase must build BOTH `overlays/gundam-match.html` AND its dedicated control page `gundam-match-control.html` (mirror the pokemon-match.html / pokemon-match-control.html pair), and register Gundam in the GAME_REGISTRY (matchControls -> /gundam-match-control, plus overlays[]) so the switcher surfaces it. After each phase STOP, report, and verify BOTH the overlay and the control page (exercise the controls).
```

---

## 3) One Piece

```
You are working in the CardCast repo (Node/Express + Socket.io, vanilla-JS frontend, better-sqlite3). Goal: add One Piece Card Game match-overlay + deck-building support.

STEP 1 - READ THE PLAN. Read `One Piece Implementation Notes.md` in full. NOTE: the match-overlay design (section 2.2) is PROPOSED, not locked - featured Leader + 5-character row, variable Life from the Leader, DON!! attach UI, Stage slot. Confirm these with me before building Feature A (the match overlay).

STEP 2 - STUDY THE CURRENT CODE (do not edit yet), which you will mirror:
- overlays/pokemon-match.html + pokemon-match-control.html
- src/overlay-server.js (pokemonMatch state + mutators + getState)
- server.js (/pokemon-match routes, register-overlay/request-state branches, socket relays, overlayStates, disconnect - add the onepiece-match equivalents)
- public/js/deck-parser.js + public/js/main.js
- overlays/decklist.html (GENERIC - register category names; no per-game branch)
- index.html (match-control button; or GAME_REGISTRY if the switcher has landed)

GUARDRAILS:
- Data layer is DONE (OP cards + fields + colors populated). Do NOT modify scrapers/parsers/DB schema.
- IGNORE dist-portable/ and seed-build/. No emojis.

STEP 3 - CONFIRM UNDERSTANDING BEFORE CODING. Summarize the onePieceMatch state shape, files to touch, socket events, and confirm the PROPOSED design choices with me. No code until that's resolved.

STEP 4 - IMPLEMENT PHASE BY PHASE (Phase 1 deck foundation first). The match phase must build BOTH `overlays/onepiece-match.html` AND its dedicated control page `onepiece-match-control.html` (mirror the pokemon-match.html / pokemon-match-control.html pair), and register One Piece in the GAME_REGISTRY (matchControls -> /onepiece-match-control, plus overlays[]) so the switcher surfaces it. After each phase STOP, report, and verify BOTH the overlay and the control page.
```

---

## 4) Magic

```
You are working in the CardCast repo (Node/Express + Socket.io, vanilla-JS frontend, better-sqlite3). Goal: refocus Magic onto "MTG proper" (60-card constructed, 20 life) and remove the Commander-specific pieces.

STEP 1 - READ THE PLAN. Read `Magic Implementation Notes.md` in full. IMPORTANT: this is a REFOCUS, not greenfield - mtgMatch state, overlays/mtg-match.html, mtg-match-control.html, and MTG deck import (deck-parser.js) already exist and are Commander-era.

STEP 2 - STUDY THE CURRENT CODE (do not edit yet):
- overlays/mtg-match.html + mtg-match-control.html + the mtgMatch state in src/overlay-server.js (what exists today, incl. commanderDamage / 40-life to remove)
- overlays/pokemon-match.html + pokemon-match-control.html + the pokemonMatch pattern (the NEWER pattern of record to rebuild Magic against)
- server.js (mtg-* relays and routes)
- public/js/deck-parser.js (parseMTGDeckList) + public/js/main.js (addSelectedToDeck)
- overlays/decklist.html (GENERIC - ensure Magic categories are in CATEGORY_ORDER)

GUARDRAILS:
- Drop Commander damage + 40-life. Default Standard, 20 life. Do NOT modify the data layer.
- IGNORE dist-portable/ and seed-build/. No emojis.

STEP 3 - CONFIRM UNDERSTANDING BEFORE CODING. Summarize the simplified mtgMatch state, what you'll remove vs keep, the files to touch, and any open questions. No code until that's done.

STEP 4 - IMPLEMENT PHASE BY PHASE per the doc. The match phase rebuilds BOTH `overlays/mtg-match.html` AND its dedicated control page `mtg-match-control.html` (aligned to the pokemon-match.html / pokemon-match-control.html pattern, Commander stripped), and registers Magic in the GAME_REGISTRY (matchControls -> /mtg-match-control, plus overlays[]) so the switcher surfaces it. After each phase STOP, report, and verify BOTH the overlay and the control page.
```

---

## 5) Yu-Gi-Oh

```
You are working in the CardCast repo (Node/Express + Socket.io, vanilla-JS frontend, better-sqlite3). Goal: add Yu-Gi-Oh! match-overlay + deck-building support.

STEP 1 - READ THE PLAN. Read `Yu-Gi-Oh Implementation Notes.md` in full (8000 LP headline + a row of up to 5 monster zones with ATK/DEF + battle position; main 40-60 / extra / side deck, 3-of, F&L banlist).

STEP 2 - STUDY THE CURRENT CODE (do not edit yet), which you will mirror:
- overlays/pokemon-match.html + pokemon-match-control.html
- src/overlay-server.js (pokemonMatch state + mutators + getState)
- server.js (/pokemon-match routes, register-overlay/request-state branches, socket relays, overlayStates, disconnect - add yugioh-match equivalents)
- public/js/deck-parser.js + public/js/main.js
- overlays/decklist.html (GENERIC - register Monsters/Spells/Traps/Extra Deck/Side Deck in CATEGORY_ORDER)
- index.html (match-control button; or GAME_REGISTRY if the switcher has landed)

GUARDRAILS:
- Data layer is DONE. Do NOT modify scrapers/parsers/DB schema. IGNORE dist-portable/ and seed-build/. No emojis.

STEP 3 - CONFIRM UNDERSTANDING BEFORE CODING. Summarize the yugiohMatch state shape, files to touch, socket events, and open questions. No code until that's done.

STEP 4 - IMPLEMENT PHASE BY PHASE (Phase 1 deck foundation first). The match phase must build BOTH `overlays/yugioh-match.html` AND its dedicated control page `yugioh-match-control.html` (mirror the pokemon-match.html / pokemon-match-control.html pair), and register Yu-Gi-Oh in the GAME_REGISTRY (matchControls -> /yugioh-match-control, plus overlays[]) so the switcher surfaces it. After each phase STOP, report, and verify BOTH the overlay and the control page.
```

---

## 6) Lorcana

```
You are working in the CardCast repo (Node/Express + Socket.io, vanilla-JS frontend, better-sqlite3). Goal: add Disney Lorcana match-overlay + deck-building support.

STEP 1 - READ THE PLAN. Read `Lorcana Implementation Notes.md` in full. KEY: Lorcana has NO life total - the headline is a LORE race counting UP to 20 (first to 20 wins). Characters also track accumulated damage toward Willpower. Resource = ink. Up to 2 inks per deck.

STEP 2 - STUDY THE CURRENT CODE (do not edit yet), which you will mirror:
- overlays/pokemon-match.html + pokemon-match-control.html
- src/overlay-server.js (pokemonMatch state + mutators + getState)
- server.js (/pokemon-match routes, register-overlay/request-state branches, socket relays, overlayStates, disconnect - add lorcana-match equivalents)
- public/js/deck-parser.js + public/js/main.js
- overlays/decklist.html (GENERIC - register Characters/Actions/Items/Locations in CATEGORY_ORDER)
- index.html (match-control button; or GAME_REGISTRY if the switcher has landed)

GUARDRAILS:
- Data layer is DONE (ink/colors populated). Do NOT modify scrapers/parsers/DB schema. IGNORE dist-portable/ and seed-build/. No emojis.

STEP 3 - CONFIRM UNDERSTANDING BEFORE CODING. Summarize the lorcanaMatch state shape (LORE counts UP; characters have damage), files to touch, socket events, and open questions. No code until that's done.

STEP 4 - IMPLEMENT PHASE BY PHASE (Phase 1 deck foundation first). The match phase must build BOTH `overlays/lorcana-match.html` AND its dedicated control page `lorcana-match-control.html` (mirror the pokemon-match.html / pokemon-match-control.html pair), and register Lorcana in the GAME_REGISTRY (matchControls -> /lorcana-match-control, plus overlays[]) so the switcher surfaces it. After each phase STOP, report, and verify BOTH the overlay and the control page.
```

---

## 7) Digimon

```
You are working in the CardCast repo (Node/Express + Socket.io, vanilla-JS frontend, better-sqlite3). Goal: add Digimon Card Game match-overlay + deck-building support.

STEP 1 - READ THE PLAN. Read `Digimon Implementation Notes.md` in full. KEY: two unique mechanics - SECURITY stack (5) per player (the loss track), and a single SHARED MEMORY gauge (-10..0..+10) in the center between players (NOT per-player). Main deck exactly 50 + a Digi-Egg deck (0-5).

STEP 2 - STUDY THE CURRENT CODE (do not edit yet), which you will mirror (except the shared memory gauge, which has no Pokemon analog):
- overlays/pokemon-match.html + pokemon-match-control.html
- src/overlay-server.js (pokemonMatch state + mutators + getState)
- server.js (/pokemon-match routes, register-overlay/request-state branches, socket relays, overlayStates, disconnect - add digimon-match equivalents)
- public/js/deck-parser.js + public/js/main.js
- overlays/decklist.html (GENERIC - register Digimon/Tamers/Options/Digi-Egg Deck in CATEGORY_ORDER)
- index.html (match-control button; or GAME_REGISTRY if the switcher has landed)

GUARDRAILS:
- Data layer is DONE (colors populated; digivolve_color is the evolution requirement, colors is the card's own color). Do NOT modify scrapers/parsers/DB schema. IGNORE dist-portable/ and seed-build/. No emojis.

STEP 3 - CONFIRM UNDERSTANDING BEFORE CODING. Summarize the digimonMatch state shape (note the SHARED memory value), files to touch, socket events, and open questions. No code until that's done.

STEP 4 - IMPLEMENT PHASE BY PHASE (Phase 1 deck foundation first). The match phase must build BOTH `overlays/digimon-match.html` AND its dedicated control page `digimon-match-control.html` (mirror the pokemon-match.html / pokemon-match-control.html pair), and register Digimon in the GAME_REGISTRY (matchControls -> /digimon-match-control, plus overlays[]) so the switcher surfaces it. After each phase STOP, report, and verify BOTH the overlay and the control page.
```
