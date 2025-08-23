# Trading Bot Overview

This document explains the structure, functions, and logic within `bot.js`, which powers an automated trading bot using Bybit/Binance (via `binanceClient`). The bot is designed to manage main and hedge trades, persist state for reliability, and resume safely after interruptions.

---

## Table of Contents

1. [Core Purpose](#core-purpose)
2. [Main Components](#main-components)
    - [Imports & Constants](#imports--constants)
    - [State Persistence](#state-persistence)
    - [Trade Actions](#trade-actions)
    - [Signal Handling Logic](#signal-handling-logic)
    - [Monitoring Loop](#monitoring-loop)
    - [Bot Lifecycle Functions](#bot-lifecycle-functions)
    - [Resume and Clear State](#resume-and-clear-state)
3. [Trading Logic](#trading-logic)
    - [Main Trade Management](#main-trade-management)
    - [Hedge Trade Management](#hedge-trade-management)
    - [Trailing Boundary Management](#trailing-boundary-management)
    - [Profit/Loss Logging](#profitloss-logging)
4. [Persistence and Recovery](#persistence-and-recovery)
5. [Usage Guide](#usage-guide)
6. [Extending the Bot](#extending-the-bot)

---

## Core Purpose

`bot.js` automates trading based on signals generated from market analysis. It manages entry and exit for both main and hedge trades, applies trailing boundaries for risk/profit management, and robustly persists all relevant state so that the bot can recover from restarts, crashes, or manual stops.

---

## Main Components

### Imports & Constants

- **Imports:**  
  - `state.js`: Handles persistent saving/loading of bot status and trade data.
  - `priceFeed.js`: Provides real-time price updates.
  - `technical.js`: Runs analysis and generates trading signals.
  - `binanceClient.js`: Connects to broker for trade execution.

- **Constants:**  
  - `TRAILING_DISTANCE`, `TRAILING_THRESHOLD`, `PROFIT_POINT`, `ORDER_SIZE`: Parameters for trade and risk logic.

---

### State Persistence

The bot uses `state.js` to persist:
- Bot running status.
- Main and hedge trade details.
- Trailing boundaries.
- Last signal and price.
- Hedge close boundary.
- Profit/loss history.

Each relevant action triggers a call to `state.saveState()`, ensuring up-to-date disk storage in `state.json`.

---

### Trade Actions

These functions interact with the broker via `binanceClient` and update persistent state:

- `openMainTrade(side, price)`: Opens a main trade, saves its details.
- `closeMainTrade(price)`: Closes the current main trade, logs profit/loss, clears state.
- `openHedgeTrade(side, price)`: Opens a hedge trade, saves its details.
- `closeHedgeTrade(price)`: Closes the current hedge trade, logs profit/loss, clears state.

All functions handle errors and notify via `sendMessage`.

---

### Signal Handling Logic

The core of the bot is the `handleSignal(signal, currentPrice)` function. It:

1. Loads the latest main/hedge trade and hedge boundary from state.
2. Persists the incoming signal and price.
3. Applies trading logic:
    - Opens trades as dictated by signals (`BUY`, `SELL`).
    - Closes trades when profit/stop-loss conditions are met.
    - Manages hedge trades when a main trade is threatened.
    - Applies trailing boundaries for risk management.
    - Reopens hedge trades if price crosses boundary after closure.

All state changes are saved immediately.

---

### Monitoring Loop

- `monitorPrice()` is the main event loop:
    - Runs while the bot is marked "running".
    - Fetches the latest price and trading signal.
    - Calls `handleSignal()` to act on current market conditions.
    - Waits 1 second between iterations (customizable).

---

### Bot Lifecycle Functions

- `startBot()`:  
  - Starts price polling.
  - Waits for first price tick.
  - Sets bot as running.
  - Calls `resumeBotState()` to report current state.
  - Starts monitoring loop.

- `stopBot()`:  
  - Stops price polling.
  - Sets bot as not running.
  - Stops monitoring loop.

---

### Resume and Clear State

- `resumeBotState()`:  
  - Loads and prints details of open trades, last signal/price, and boundaries from disk.
  - Does not start trading—just reports what will be resumed.

- `clearBotState()`:  
  - Stops price polling if running.
  - Calls `state.resetBotState()` to clear all persisted data for a true fresh start.
  - Prints a reset message.

---

## Trading Logic

### Main Trade Management

- On `BUY` or `SELL` signal: Opens a new main trade if none is open.
- On `TAKE_PROFIT_*` or `STOP_LOSS_*`: Closes main trade if breakthrough price is met, or opens a hedge trade otherwise.

### Hedge Trade Management

- Opens a hedge trade if main trade is under threat and breakthrough not met.
- Closes hedge trade when stop-loss/profit condition is met.
- Sets and trails boundary after hedge closure.
- Reopens hedge trade if price crosses boundary again.

### Trailing Boundary Management

- Uses `trailBoundary()` to update trailing boundaries after hedge closure.
- Boundaries are saved in persistent state for recovery and audit.

### Profit/Loss Logging

- Every trade closure logs profit or loss (main/hedge) to state for historical analysis.

---

## Persistence and Recovery

- All trades, boundaries, signals, prices, and P/L logs are saved to disk.
- On bot restart, `resumeBotState()` shows current status.
- `startBot()` resumes trading logic using the last saved state, so open positions and boundaries persist across outages.

---

## Usage Guide

- **Start the Bot:**  
  `startBot()` — resumes any open trades and begins monitoring/trading.

- **Stop the Bot:**  
  `stopBot()` — halts price monitoring and trading.

- **Check Current Status:**  
  `resumeBotState()` — prints details of trades and boundaries.

- **Clear All State for a Fresh Start:**  
  `clearBotState()` — wipes all persistent state and prepares bot for a new run.

---

## Extending the Bot

- Add new trading signals in `handleSignal()`.
- Integrate advanced trailing logic or risk management.
- Enhance P/L tracking and reporting.
- Connect to other brokers by adapting the trade functions.

---

## Example Function Reference

- `startBot()`: Start/resume bot, begin monitoring.
- `stopBot()`: Stop bot safely.
- `clearBotState()`: Reset all state.
- `resumeBotState()`: Report what trades/boundaries will be resumed.
- `monitorPrice()`: Main event loop, not called directly (used by `startBot()`).
- Trade and boundary management functions: Open/close main and hedge trades, trail boundaries, persist all state.

---

## Conclusion

`bot.js` is designed for reliability, safety, and extensibility. Every action is persisted, so your trading logic never loses track of positions, even if interrupted. The modular design makes it easy to debug, extend, and operate in production.

For further details on each module (`state.js`, `priceFeed.js`, `technical.js`, `binanceClient.js`), see their respective documentation.
