# Trading Bot Logic Documentation

## Overview

This bot manages two types of trades: **main trades** and **hedge trades**. Its logic is designed to minimize risk and maximize profit by dynamically responding to market signals, using breakthrough prices and trailing boundaries, and promoting hedge trades to main trades when conditions are met.

---

## Core Concepts

- **Main Trade:** The primary trading position (Buy/Sell).
- **Hedge Trade:** A protective position opened when the market moves against the main trade.
- **Breakthrough Price:** A reference price used to determine when to close or promote trades (main trade’s open price ± 300 points).
- **Trailing Boundary:** Used for trailing stops (typically 400 points).
- **Hedge Boundary:** Set 250 points away from the hedge close price or 300 points away from the main trade entry price for initial protection; this boundary trails in one direction only (up for Buy, down for Sell).

---

## Main Trade Logic

1. **Opening**
   - When a `BUY` or `SELL` signal is received and no main trade is active, open a main trade.
   - Upon opening a main trade, immediately set a **hedge boundary** 300 points below the entry price (for BUY) or above (for SELL).
   - The hedge boundary **trails up** (for BUY) or **trails down** (for SELL) with the price, only moving in a direction that improves protection.

2. **Monitoring & Response**
   - If the current price drops (for BUY main) or rises (for SELL main) back to the trailing hedge boundary:
     - **If the hedge boundary price is above (BUY) or below (SELL) the breakthrough price:**
       - **Close the main trade** and wait for a new signal.
     - **If the hedge boundary price is at or below (BUY) or at or above (SELL) the breakthrough price:**
       - **Open a hedge trade** (SELL if main is BUY, BUY if main is SELL).

---

## Hedge Trade Logic

1. **Opening**
   - A hedge trade is opened when the price hits the trailing hedge boundary and is at or below (BUY) or at or above (SELL) the breakthrough price.
   - A hedge trade may also be opened by auto-hedge logic if price moves 300 points against the main trade without an explicit signal.

2. **Promotion**
   - If both main and hedge trades are active and a STOP_LOSS signal arrives with price above breakthrough:
     - **Close the main trade.**
     - **Promote the hedge trade to the new main trade** (do not close/reopen, just update role).
     - Set a new hedge boundary 250 points away from the promotion price, trailing only in the favorable direction.

3. **Closing**
   - Hedge trades are only closed if:
     - For Buy hedge: signal is `STOP_LOSS_LONG` **and** price is above hedge breakthrough.
     - For Sell hedge: signal is `STOP_LOSS_SHORT` **and** price is below hedge breakthrough.
   - After closing, set a new one-way trailing boundary 250 points away from the close price.

---

## Boundary Logic

- **Main Trade Boundary:**  
  Trailed by 400 points; moves both ways.
- **Hedge Boundary:**  
  - For main trade: 300 points from entry price, trailing in one direction only.
  - For hedge promotion/close: 250 points from event price, trailing in one direction only (up for Buy, down for Sell).

---

## Auto-Hedge Feature

- If a main trade exists, no signal, and no hedge trade is active:
  - If price moves 300 points against main trade, open a hedge trade in the opposite direction.

---

## Example Scenarios

### **Main Buy, Hedge Sell, Promotion**

1. Main trade: BUY 1 BTC @ $26,000.
2. Price rises to $26,400, hedge boundary trails up to $26,100.
3. Price drops to $26,100:
   - If hedge boundary ($26,100) is above breakthrough ($26,300), close main trade.
   - If hedge boundary ($26,100) is below breakthrough ($26,300), open hedge trade (SELL).

---

## Summary Table

| Condition | Action |
|-----------|--------|
| Price drops to trailing hedge boundary, boundary above breakthrough | Close main trade |
| Price drops to trailing hedge boundary, boundary at/below breakthrough | Open hedge trade |
| Main and Hedge active, STOP_LOSS signal, price above breakthrough | Close main, promote hedge to main, set new hedge boundary |
| Hedge trade close signal and price above/below breakthrough | Close hedge, set new boundary |

---

## Risk Management

- Only one main and one hedge trade open at any time.
- Boundaries and breakthroughs reduce exposure to large losses.
- Promotion logic ensures the bot adapts to trend reversals and keeps risk under control.

---

## Version History

- **2025-08:** Updated main trade logic—hedge boundary now trails up from entry, triggers either main close or hedge open based on breakthrough comparison.
- **Earlier:** Standard main/hedge logic, breakthrough price logic, auto-hedge feature.

---

For more details, see the code comments in `bot.js`.
