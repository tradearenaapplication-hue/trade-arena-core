 # ACOUSTIC Integration TODO

## Completed Steps
- [x] Add script tags to index.html (sfx-engine.js, fx-engine.js, voice-engine.js, audio-engine.js, ACOUSTIC_CORE.js)
- [x] Add ACOUSTIC initialization to app-rebuild.js initAppRebuildV42()
- [x] Add ACOUSTIC controls to TradeArenaApp public API

## Pending Steps
- [x] Add ACOUSTIC control UI (mute/volume buttons in header) — header AV controls in index.html already had SFX/voice/audio toggles; added a volume slider wired to ACOUSTIC.setVolume(). ACOUSTIC_CORE.js no longer creates a duplicate panel when #avControls exists.
- [x] Connect ACOUSTIC to trading events (trade execution sounds) — index.html already calls ACOUSTIC.onTradeOpen() on trade open; verified.
- [x] Connect ACOUSTIC to profit/loss events (win/lose sounds) — index.html already calls ACOUSTIC.onWin()/onLoss()/onTakeProfit() on trade close; verified.
- [x] Test ACOUSTIC initialization works — fixed the broken TradeArenaApp.ACOUSTIC API: ACOUSTIC_CORE.js now provides toggle()/setVolume()/playEvent()/isEnabled, and app-rebuild.js no longer tries `new ACOUSTICCore()` (that class never existed). Verified with a Node stub test on 2026-11-18: init, toggle, setVolume(0.7), playEvent('win'/'loss'/'takeProfit') all passed; unknown events return false.

## Technical Details
- ACOUSTICCore is instantiated in initAppRebuildV42()
- Available at window.ACOUSTIC
- Audio engines loaded: sfx-engine.js, fx-engine.js, voice-engine.js, audio-engine.js
- Public API: TradeArenaApp.ACOUSTIC.toggle(), .setVolume(), .playEvent(), .isEnabled()
