# Trading Bot Logic Documentation

## Overview

This bot manages two types of trades: **main trades** and **hedge trades**. Its logic is designed to minimize risk and maximize profit by dynamically responding to market signals, using breakthrough prices and trailing boundaries, and promoting hedge trades to main trades when conditions are met.

---

## Core Concepts

- **Main Trade:** The primary trading position (Buy/Sell).
- **Hedge Trade:** A protective position opened when the market moves against the main trade.
- **Breakthrough Price:** A reference price used to determine when to close or promote trades (main trade’s open price ± 300 points).
- **Trailing Boundary:** Used for trailing stops (typically 400 points).
- **Hedge Boundary:** Set 250 points away from the hedge close price; it trails in one direction only (up for Buy, down for Sell).

---

## Trade Lifecycle

### 1. Main Trade Opening

- Opened when a `BUY` or `SELL` signal is received and no main trade is active.

### 2. Hedge Trade Opening

- Opened when price moves 300 points against the main trade, or as dictated by signals such as `STOP_LOSS_LONG/SHORT` (if price is NOT above/below breakthrough).

### 3. Hedge Promotion to Main Trade

If both main and hedge trades are active:
- **Main Trade is Buy:**  
  If signal is `STOP_LOSS_LONG` **and** price is above breakthrough:
  - Close main trade.
  - Promote hedge trade to main trade (without closing/reopening).
  - Set a new hedge boundary 250 points from the close price, trailing up (for Buy) or down (for Sell).

- **Main Trade is Sell:**  
  If signal is `STOP_LOSS_SHORT` **and** price is above breakthrough:
  - Close main trade.
  - Promote hedge trade to main trade.
  - Set new hedge boundary as above.

### 4. Hedge Trade Closing

- Hedge trades are closed only if:
  - Buy hedge: signal is `STOP_LOSS_LONG` **and** price is above hedge breakthrough.
  - Sell hedge: signal is `STOP_LOSS_SHORT` **and** price is below hedge breakthrough.
- After closing a hedge trade, set a new hedge boundary 250 points from the close price, trailing in one direction only.

---

## Boundary Logic

- **Main Trade Boundary:**  
  Trailed by 400 points, moves both ways.
- **Hedge Boundary:**  
  Set 250 points from hedge close/promotion price, trails up for Buy or down for Sell — i.e., it only moves in the direction of increasing profit potential.

---

## Auto-Hedge Feature

- If main trade exists, no signal, and no hedge trade is active:
  - If price moves 300 points against main trade, open a hedge trade in the opposite direction.

---

## Bot Control Functions

- `startBot()`, `stopBot()`, `resumeBotState()`, `clearBotState()`: Manage bot lifecycle and restore state.
- `monitorPrice()`: Main loop that checks price and signal, calling trade/signal handlers.

---

## Example Scenarios

### **Main Buy, Hedge Sell, Promotion**

1. Main trade: BUY 1 BTC @ $26,000.
2. Price drops to $25,700, hedge trade: SELL 1 BTC @ $25,700.
3. Price rises to $26,350, signal is `STOP_LOSS_LONG`, breakthrough is $26,300.
4. Main trade closes (profit: $350).
5. Hedge trade (SELL @ $25,700) becomes main trade.
6. New hedge boundary set at $26,100 (250 points above close price); trails down only.

---

## Summary Table

| Condition | Action | Outcome |
|-----------|--------|---------|
| Main and Hedge active, STOP_LOSS signal, price above breakthrough | Close main, promote hedge to main, set new hedge boundary | Only main trade remains, boundary trails one way |
| Signal and price conditions for hedge close | Close hedge, set new boundary | Hedge closed, boundary trails one way |
| Price moves 300 points against main, no hedge | Open hedge trade | Both trades active |
| Price/signal favors main | Main trade logic executes | Trade opened/closed as per signal |

---

## Risk Management

- Only one main and one hedge trade open at any time.
- Boundaries and breakthroughs reduce exposure to large losses.
- Promotion logic ensures the bot adapts to trend reversals and keeps risk under control.

---

## Version History

- **2025-08:** Added one-way trailing boundary for hedge close and hedge-to-main promotion.
- **Earlier:** Standard main/hedge logic, breakthrough price logic, auto-hedge feature.

---

For more details, see the code comments in `bot.js`.
