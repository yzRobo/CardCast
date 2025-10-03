Magic: The Gathering Integration Plan for CardCast
Project Context
CardCast is a streaming overlay tool for TCG content creators built with:

Backend: Express.js server with Socket.io for real-time communication
Frontend: Vanilla JavaScript (no React/Vue/Angular)
Database: SQLite via better-sqlite3
UI: DaisyUI + Tailwind CSS
Architecture: Traditional server-side rendering with WebSocket updates

Current Status: Fully functional Pokemon TCG support. MTG is listed in config but not implemented.

Current Architecture Overview
File Structure
CardCast/
├── server.js                    # Main Express server & Socket.io hub
├── config.json                  # User configuration (ports, enabled games)
├── index.html                   # Main control interface
├── pokemon-match-control.html   # Pokemon-specific control panel
├── src/
│   ├── database.js             # SQLite wrapper with game-agnostic methods
│   ├── tcg-api.js              # API integration for all games (Pokemon currently)
│   ├── tcgcsv-api.js           # Alternative API source
│   └── overlay-server.js       # State management for all overlays
├── public/
│   ├── js/
│   │   └── main.js             # Main control panel logic (vanilla JS)
│   └── css/
│       └── style.css           # Compiled Tailwind styles
├── overlays/
│   ├── main.html               # Card display overlay (dual cards with VS)
│   ├── prizes.html             # Pokemon prize tracker
│   ├── decklist.html           # Deck list overlay
│   └── pokemon-match.html      # Full Pokemon match overlay
└── data/
    └── cardcast.db             # SQLite database (auto-created)
Key Architecture Patterns
1. Multi-Game Support Pattern:

Each game has methods in src/tcg-api.js (e.g., downloadPokemonCards(), parsePokemonCard())
Database uses a game column to separate data (e.g., 'pokemon', 'magic')
Server routes accept :game parameter (e.g., /api/search/:game)

2. State Management Pattern:

All live overlay state stored in src/overlay-server.js class
State includes: current displayed cards, prize cards, deck list, match state
State persists across WebSocket reconnections

3. WebSocket Communication Pattern:

Control panels emit events (e.g., pokemon-match-update)
server.js receives and relays to overlay-server.js
overlay-server.js updates state and broadcasts to all connected overlays
Overlays listen and update their display in real-time

4. Overlay Registration Pattern:

Overlays emit register-overlay with type (e.g., 'pokemon-match', 'prizes')
Server tracks connected overlays and sends current state on registration
Control panels can check overlay connection status


Pokemon Implementation Reference
Understanding the current Pokemon implementation is crucial as MTG will follow the same pattern:
Data Flow for Pokemon

Download: User clicks download → POST /api/download/pokemon → tcg-api.js:downloadPokemonCards() → Fetches from PokemonTCG.io API → Parses with parsePokemonCard() → Stores in database via database.js
Search: User types in search → search WebSocket event → database.js:searchCards('pokemon', query) → Returns results → Displays in UI
Control: User updates match state → WebSocket event (e.g., active-pokemon) → overlay-server.js updates state → Broadcasts to overlays
Display: Overlay receives event → Updates DOM with vanilla JS → Visual changes appear in OBS

Pokemon State Structure (in overlay-server.js)

Player names, records, games won
Active Pokemon for each player
Bench Pokemon (up to 5 per player)
Prize cards (6 per player with taken/remaining tracking)
Stadium card
Turn indicator
Timer state
Match settings


API Selection: magicthegathering.io
Recommended API: https://api.magicthegathering.io/v1/
Rationale:

Same developer as PokemonTCG.io (consistency with existing code)
No API key required (easier setup)
Simple REST structure similar to current Pokemon implementation
5000 requests/hour rate limit (sufficient for CardCast use case)
Returns comprehensive MTG data including card images

Key Endpoints:

/v1/sets - List all MTG sets
/v1/cards?set=<setcode> - Get all cards from a specific set
/v1/cards?name=<name> - Search cards by name
Pagination: 100 cards per page (same as Pokemon)

Alternative Considered: Scryfall API (more comprehensive but more complex, requires User-Agent headers, stricter policies)

MTG-Specific Requirements
Game Mechanics Differences from Pokemon
Life System:

Standard formats: 20 life
Commander format: 40 life
No prize cards (different win condition)

Commander Damage Tracking:

Critical rule: 21 combat damage from a single Commander causes a player to lose
Must track damage FROM each opponent's Commander separately
Only relevant in Commander format

Resource System:

Land cards are the resource (unlike Pokemon energy)
Typically one land per turn limit
Land count is important information for viewers

Turn Structure:

More complex than Pokemon with distinct phases:

Untap, Upkeep, Draw, Main Phase 1, Combat (multiple substeps), Main Phase 2, End Step


Viewers benefit from seeing current phase

Board State:

More complex than Pokemon with many permanent types
Creatures have power/toughness (e.g., 3/4)
Planeswalkers have loyalty counters
Enchantments, artifacts, and other permanents
"Featured permanents" concept: highlight 3-6 key cards


Phase 1: Data and API Integration
Goal
Enable CardCast to fetch, parse, and store MTG card data from magicthegathering.io API.
Implementation Location
All work happens in src/tcg-api.js
Required Methods
Method 1: downloadMTGCards(incremental, setCount, progressCallback)

Purpose: Main download orchestrator for MTG data
Parameters:

incremental: boolean - if true, only download new sets; if false, full download
setCount: string - 'all', '3', '5', '10', or number of recent sets to download
progressCallback: function - called with progress updates for UI


Process:

Fetch set list from /v1/sets endpoint
If incremental, check database for existing sets and filter
If setCount is limited, take most recent N sets
For each set, fetch all cards using /v1/cards?set=<code>
Parse each card with parseMagicCard()
Batch insert into database (100-500 cards at a time for performance)
Emit progress updates via callback
Handle pagination (API returns 100 cards per page)
Implement retry logic for network failures
Add delays between requests to respect rate limits



Method 2: parseMagicCard(data)

Purpose: Transform API response into CardCast database format
Input: Raw JSON from magicthegathering.io
Output: Object matching database schema
Fields to extract:

Basic: name, manaCost, type, rarity, set, setName, number, imageUrl
Gameplay: power, toughness, text, colors, colorIdentity
Additional: artist, flavor, multiverseid, legalities
Create searchable text combining name, type, text


Standardize: Handle null values, normalize formats, ensure image URLs are absolute

Method 3: getMTGSets()

Purpose: Retrieve all MTG sets from database for UI display
Return: Array of set objects with name, code, card count
Used by: Set selection UI in download interface

Method 4: searchMTGCards(query)

Purpose: Search local database for MTG cards
Note: This might leverage existing database.js:searchCards() with game='magic'
Handle: Set codes, card names, partial matches, fuzzy search

Database Integration
The existing database.js already supports multiple games via the game column. MTG cards will use game='magic'.
Key Database Methods to Use:

insertCard(cardData) - Already game-agnostic
searchCards(game, query) - Pass 'magic' as game parameter
getGameStats() - Will automatically include MTG when data exists
clearGameData(game) - Pass 'magic' to clear MTG data

Schema Notes:

Existing schema supports all MTG data
mana_cost field already exists for MTG
attack/defense can be repurposed for power/toughness
data JSON column can store MTG-specific fields (colors, legalities, etc.)


Phase 2: Backend API Endpoints
Goal
Create Express routes for MTG operations that mirror Pokemon structure.
Implementation Location
All routes added to server.js
Required Endpoints
Endpoint 1: GET /api/magic/sets

Purpose: Return all MTG sets available in database
Response: JSON array of set objects
Used by: Download interface set selector
Pattern: Same as existing /api/pokemon/sets

Endpoint 2: GET /api/search/magic

Purpose: Search MTG cards in local database
Query parameter: q (search query)
Response: JSON with results array and count
Note: Main /api/search/:game route already exists, just need to enable for 'magic'

Endpoint 3: POST /api/download/magic

Purpose: Initiate MTG card download from API
Body: { incremental: boolean, setCount: string }
Response: Success message or error
Process: Validates game is 'magic', calls tcgApi.downloadMTGCards()
Note: Route structure exists, just enable for 'magic' parameter

Endpoint 4: GET /api/magic/stats

Purpose: Return MTG data statistics
Response: Card count, set count, last update time, cache size
Used by: Dashboard to show data status
Pattern: Same as existing /api/pokemon/stats

Endpoint 5: DELETE /api/games/magic/data

Purpose: Clear all MTG data from database
Response: Success confirmation
Note: Route exists, just enable for 'magic' parameter

Configuration Updates
Update config.json default structure:

Ensure games.magic.enabled: true
Set games.magic.dataPath: null (uses default paths)

Update server.js game validation:

Currently only allows Pokemon operations
Remove "coming soon" blocks for MTG
Enable MTG in download, search, and stats endpoints


Phase 3: State Management for MTG Matches
Goal
Create a comprehensive state structure for tracking live MTG matches, stored in overlay-server.js.
Implementation Location
Extend src/overlay-server.js class
State Structure Design
Root: this.mtgMatch object containing:
Per-Player Data (player1 and player2 objects):

name: string - Player name for display
record: string - Match record (e.g., "2-1-0" for 2 wins, 1 loss, 0 draws)
gamesWon: number - Games won in current match (best of 3)
life: number - Current life total (20 for standard, 40 for commander)
commanderDamage: object - Keys are opponent commander names, values are damage taken

Example: { "Atraxa": 18, "Gishath": 12 }
Only relevant for Commander format


lands: number - Current land count on battlefield
featuredPermanents: array - Up to 6 card objects to highlight

Each object contains: name, imageUrl, power, toughness, type


turnActions: object - Tracking actions taken this turn

landPlayed: boolean
spellCast: boolean
Other format-specific actions as needed



Global Match Data:

activePlayer: number - 1 or 2, indicates whose turn it is
currentPhase: string - Current turn phase

Options: 'untap', 'upkeep', 'draw', 'main1', 'combat', 'main2', 'end'


timer: number - Match timer in seconds
format: string - Game format

Options: 'standard', 'modern', 'commander', 'legacy', 'vintage', 'pioneer'
Affects starting life and whether Commander damage tracking is shown



Required State Methods
Each method updates internal state AND broadcasts via Socket.io.
Life Total Management:

updateMTGLife(player, life) - Set player's life total
Emit: mtg-life-update event with player number and new life

Commander Damage Management:

updateCommanderDamage(player, opponentCommanderName, damage) - Update damage from specific Commander
Emit: mtg-commander-damage-update event
Important: Track separately per commander, not total

Land Tracking:

updateLands(player, count) - Set player's land count
Emit: mtg-lands-update event

Featured Permanents Management:

addFeaturedPermanent(player, card) - Add card to featured list (max 6)
removeFeaturedPermanent(player, index) - Remove card at index
clearFeaturedPermanents(player) - Remove all featured permanents
Emit: Appropriate events for each action

Phase Tracking:

updatePhase(phase) - Set current turn phase
Emit: mtg-phase-update event

Player Management:

updateMTGPlayerName(player, name) - Set player name
updatePlayerRecord(player, record) - Update match record
updateGamesWon(player, gamesWon) - Update games won in current match
Emit: Appropriate events

Turn Actions:

setTurnAction(player, action, value) - Mark action as taken/not taken
resetTurnActions(player) - Clear all turn actions (call on turn change)
Emit: mtg-turn-actions-update event

Match Control:

resetMTGMatch() - Reset all match state to defaults
switchActivePlayer() - Toggle active player
updateFormat(format) - Change game format (affects life totals)

State Retrieval:

Extend existing getState() method to include mtgMatch object
Used when overlays reconnect to get current state


Phase 4: Control Panel Interface
Goal
Create an HTML control panel where the stream operator manages the MTG match state.
Implementation Location
Create mtg-match-control.html in root directory (same level as pokemon-match-control.html)
UI Components Needed
Component 1: Player Information Panels (2x, one per player)

Player name input field
Record display/input (W-L-D format)
Games won counter (for best-of-3 display)

Component 2: Life Counter (2x, one per player)

Large numeric display showing current life
Increment/decrement buttons (typically +1/-1, +5/-5)
Direct input field for manual adjustment
Color coding: green when >20, yellow 10-20, red <10
Special handling: 40 life for Commander format

Component 3: Commander Damage Tracker (Commander format only)

Section for each player
Ability to add opponent commander names
Track damage from each commander separately
Visual warning when approaching 21 (lethal threshold)
Show/hide based on format selection

Component 4: Land Counter (2x, one per player)

Numeric display with increment/decrement
Quick set buttons (1, 2, 3, 4, 5 lands for early game)
Important for viewers to gauge game progress

Component 5: Featured Permanents Manager (2x, one per player)

Card search input (searches MTG database)
Display search results with images
Click to add card to featured list (max 6 cards)
Featured list display with card images
Remove button for each card
Drag to reorder (optional enhancement)

Component 6: Phase Selector

Buttons or dropdown for each turn phase
Visual indicator of current phase
Quick phase buttons: Main, Combat, End (most common)
Full phase list: Untap, Upkeep, Draw, Main 1, Combat, Main 2, End

Component 7: Turn Actions Tracker

Checkboxes for common tracked actions:

Land played this turn
Spell cast this turn
Other format-specific actions


Auto-reset on turn change option

Component 8: Match Controls

Active player indicator/switch button
Format selector (Standard, Modern, Commander, etc.)
Timer controls: Start, Pause, Reset
Reset match button (clears all state)
Game counter: Increment when game ends

Component 9: Overlay Connection Status

Indicator showing if MTG overlay is connected to OBS
Refresh/reconnect button

Component 10: Quick Access Card Search

Persistent search bar at top
Quick card lookup without adding to featured
Display card image in modal/popout

Control Panel JavaScript (public/js/mtg-control.js)
Purpose: Handle all control panel interactions and WebSocket communication.
Key Functions Needed:

Socket.io connection and registration
Life adjustment handlers
Commander damage management
Card search and autocomplete
Featured permanents addition/removal
Phase updates
State synchronization on load
Real-time updates from overlay server

WebSocket Events to Emit:

All state changes from components above
Format: event name matches overlay-server method (e.g., mtg-life-update)

WebSocket Events to Listen For:

overlay-connected - Update connection status
State echo events - Confirm changes applied
Other control panels' changes (if multiple operators)


Phase 5: OBS Overlay Interface
Goal
Create the visual overlay that displays in OBS, showing the MTG match state to stream viewers.
Implementation Location
Create overlays/mtg-match.html in overlays directory
Overlay Visual Components
Component 1: Player Information Display (2x)

Position: Top-left for Player 1, top-right for Player 2
Contents:

Player name (large, readable)
Life total (very large, primary focus)
Match record (W-L-D)
Games won in current match


Styling: Semi-transparent background, clear fonts, good contrast

Component 2: Land Counter Display (2x)

Position: Below player info
Contents:

Land icon or symbol
Current land count


Styling: Smaller than life total, but clearly visible

Component 3: Commander Damage Display (Commander format only)

Position: Below land counter or in corner
Contents:

List of opponent commanders
Damage taken from each
Visual warning (red/pulsing) when approaching 21


Styling: Compact but clear, only shown when format is Commander

Component 4: Featured Permanents Display (2x)

Position: Bottom of screen, one row per player
Contents:

Small card images (up to 6)
Card names below images
Power/toughness if creature


Styling: Cards in horizontal row, hover for larger view (optional)

Component 5: Phase Indicator

Position: Center bottom or top center
Contents: Current turn phase with icon
Styling: Clear, changes color/animates on phase change

Component 6: Active Player Indicator

Position: Highlight or border around active player's info
Styling: Animated glow, different color, or arrow pointing to active player

Component 7: Timer Display (optional)

Position: Bottom center or top center
Contents: Match timer counting up
Styling: Unobtrusive but readable

Overlay JavaScript (inline in mtg-match.html)
Purpose: Listen for state changes and update DOM in real-time.
Key Functions:

Socket.io connection with register-overlay for 'mtg-match'
Request current state on load (request-state event)
DOM update functions for each component
Smooth animations for value changes
Format-based component visibility (hide Commander damage in non-Commander)

WebSocket Events to Listen For:

mtg-match-state - Full state on connection/reconnection
mtg-life-update - Update life displays
mtg-lands-update - Update land counts
mtg-commander-damage-update - Update commander damage
mtg-permanent-added / mtg-permanent-removed - Update featured permanents
mtg-phase-update - Update phase display
mtg-player-switch - Update active player indicator
mtg-format-update - Show/hide format-specific components

State Restoration:

On page load or reconnection, request full state
Apply all state values to DOM
Ensures overlay shows correct info even after browser source refresh

Styling Considerations
Transparency: Background must be transparent for OBS chroma key or direct alpha
Readability: High contrast text, large fonts for life totals
Animation: Smooth transitions for number changes, not jarring
Responsiveness: Fixed 1920x1080 layout for OBS consistency
Themes: Consider light/dark mode options
Customization: CSS variables for easy color/size adjustments

Phase 6: Server WebSocket Event Handling
Goal
Wire up all WebSocket events between control panel, server, overlay-server, and overlays.
Implementation Location
Add event handlers to server.js Socket.io configuration section
Event Flow Pattern
Standard Flow for All MTG Events:

Control panel emits event (e.g., mtg-life-update)
server.js receives event in socket.on() handler
server.js calls appropriate method on overlayServer instance
overlayServer updates internal state
overlayServer emits event to ALL clients via io.emit()
All connected overlays receive event and update display
Control panels receive event as confirmation

Example Event: Life Total Update

Control panel: socket.emit('mtg-life-update', { player: 1, life: 18 })
Server receives and logs
Server calls: overlayServer.updateMTGLife(1, 18)
overlayServer updates state and broadcasts
Overlays update DOM to show new life total

Required Event Handlers
Create handlers for each state management method from Phase 3:

Life total changes
Commander damage updates
Land count changes
Featured permanent additions/removals
Phase updates
Player name/record changes
Active player switches
Turn action updates
Match resets
Format changes

Registration Events
Overlay Registration:

Event: register-overlay with type 'mtg-match'
Action: Add to tracking set, send current mtgMatch state
Important: Send full state so overlay can sync immediately

Control Panel Registration:

Event: register-control with type 'mtg-match'
Action: Add to tracking set, send overlay connection status

State Request Events
Request State:

Event: request-state with type 'mtg-match'
Response: Send current mtgMatch state from overlayServer
Used by: Overlays on reconnection, control panels on load

Disconnection Handling

Track disconnects to update connection status indicators
Clean up tracking sets
Keep state in overlayServer (persistent across connections)


Phase 7: Frontend Integration
Goal
Add MTG game option to main control interface and enable full functionality.
Implementation Location
Modify index.html and public/js/main.js
Changes to index.html
Game Selector:

Existing game selector dropdown/tabs
Ensure "Magic: The Gathering" option is present and functional
Remove any "Coming Soon" badges or disabled states

Download Interface:

MTG should appear in game selection
Download options: full vs incremental, set count selector
Progress bar shows MTG download progress

Search Interface:

Search should work when MTG is selected as active game
Display results with MTG-specific formatting:

Mana cost displayed with symbols
Power/toughness for creatures
Card type clearly shown



Statistics Display:

Show MTG card count, set count, last update
Show cache size for MTG images

Changes to main.js
Game Selection Logic:

Update game switching to enable MTG
Remove any conditional "coming soon" messages for MTG

Download Handlers:

Ensure POST /api/download/magic is called with correct parameters
Handle progress updates via Socket.io
Display completion notification

Search Handlers:

Enable search for 'magic' game
Format MTG search results appropriately
Handle card display with MTG-specific layout

Card Display:

When MTG card is displayed via main overlay (dual card display)
Ensure MTG card images load correctly
Format card info appropriately (mana cost, power/toughness, etc.)

Navigation:

Add link/button to open MTG Match Control panel
Add link to MTG Match Overlay URL for OBS

OBS Setup Tab Updates
In the existing OBS Setup tab (shows browser source URLs):

Add new entry: "MTG Match Overlay"
URL: http://localhost:3888/mtg-match
Dimensions: 1920x1080, FPS: 30
Instructions for adding to OBS as browser source

Phase 8: Documentation and Polish
Goal
Document the MTG feature and ensure it's production-ready.
User Documentation
README Updates:

Add MTG to supported games list (move from "Coming Soon")
Add MTG-specific features description
Document MTG overlay setup instructions
Add MTG control panel documentation

API Documentation:

Document new MTG endpoints in API_DOCUMENTATION.md
List new WebSocket events for MTG
Provide example API calls

Control Panel Help:

Add tooltips or help text for MTG-specific features
Explain Commander damage tracking
Explain phase system
Document format differences (life totals, etc.)

Code Documentation
Inline Comments:

Document complex MTG logic
Explain Commander damage calculation
Note format-specific behaviors

Method Documentation:

JSDoc comments for all new methods
Parameter descriptions
Return value descriptions

UI Polish
Control Panel:

Consistent styling with Pokemon control
Smooth transitions
Loading states for card search
Error messages for failed operations
Confirmation dialogs for destructive actions (reset, clear)

Overlay:

Professional appearance
Smooth animations
Consistent with existing overlay style
No visual glitches or flickering

Performance Optimization
Database:

Ensure indexes exist for MTG card queries
Optimize search performance

Image Caching:

Verify all MTG card images cache correctly
Implement lazy loading if needed

WebSocket:

Minimize event frequency
Batch updates where possible
Avoid redundant broadcasts


Implementation Order Recommendation
Suggested order to implement phases:

Phase 1 (Data Integration) - Get card data flowing first
Phase 2 (Backend Endpoints) - Enable API access to data
Test: Verify cards download and search works
Phase 3 (State Management) - Build the state structure
Phase 6 (WebSocket Events) - Wire up communication
Phase 4 (Control Panel) - Build the control interface
Test: Verify control panel updates state
Phase 5 (Overlay) - Build the visual display
Test: Verify full control → overlay flow
Phase 7 (Frontend Integration) - Connect to main UI
Phase 8 (Documentation) - Polish and document


Success Criteria
MTG implementation is complete when:

✅ MTG cards can be downloaded from magicthegathering.io API
✅ MTG cards can be searched in the database
✅ Control panel can manage full MTG match state
✅ Overlay displays match state in real-time
✅ All state updates flow correctly via WebSocket
✅ Multiple formats supported (Standard, Commander, etc.)
✅ Commander damage tracking works correctly
✅ Featured permanents can be added and displayed
✅ Phase tracking works
✅ OBS integration works (transparent overlay, no performance issues)
✅ Works alongside existing Pokemon functionality without conflicts
✅ Code follows existing CardCast patterns and conventions
✅ Documentation is complete


Additional Notes
Code Style: Follow existing CardCast conventions:

Vanilla JavaScript (no frameworks in frontend)
Express route patterns from existing endpoints
Socket.io event naming conventions
Database query patterns from existing methods

Testing Strategy: Test incrementally at each phase, not just at the end.
Compatibility: Ensure MTG implementation doesn't break Pokemon functionality. Both games should work simultaneously.
Extensibility: Design with future games in mind. Keep game-specific logic isolated, use shared patterns where possible.
User Experience: Match the quality and polish of existing Pokemon features. MTG should feel like a native part of CardCast, not an addon.