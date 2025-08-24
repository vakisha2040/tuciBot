// bot.js
const state = require('./state');
const { getCurrentPrice, waitForFirstPrice, startPolling, stopPolling } = require('./priceFeed');
const { analyze } = require('./technical');
const bybit = require('./binanceClient');

/**
 * ====================== CONFIG ======================
 */
const ORDER_SIZE = 1;

// Breakthrough distance (+/- from entry)
const PROFIT_POINT = 300;

// Main trailing rules
const TRAIL_GAP = 300;        // boundary gap from current price
const TRAIL_ACTIVATION = 400; // start trailing only after this much profit

// Cooldowns / guards
const HEDGE_COOLDOWN_MS = 5000;

/**
 * ====================== INTERNAL FLAGS ======================
 */
let monitoring = false;
let hedgeOpeningInProgress = false;
let mainOpeningInProgress = false;
let lastHedgeOpenAt = 0;

/**
 * ====================== HELPERS ======================
 */
const now = () => Date.now();
const sendMessage = (m) => console.log(m);
const hedgeCooldownActive = () => now() - lastHedgeOpenAt < HEDGE_COOLDOWN_MS;
const markHedgeOpened = () => { lastHedgeOpenAt = now(); };

function computeBreakthrough(side, openPrice) {
  return side === 'Buy' ? openPrice + PROFIT_POINT : openPrice - PROFIT_POINT;
}
function isBeyondBreakthrough(side, price, breakthrough) {
  return side === 'Buy' ? price >= breakthrough : price <= breakthrough;
}

/**
 * ====================== MAIN BOUNDARY (TRAILING) ======================
 * One-way, 300-pt gap, activates after >= 400 profit move
 */
function setMainBoundary(side, refPrice) {
  const boundary = side === 'Buy' ? refPrice - TRAIL_GAP : refPrice + TRAIL_GAP;
  state.setMainHedgeBoundary({ side, boundary, price: refPrice, timestamp: now() });
  sendMessage(`Main boundary set @ ${boundary} (gap ${TRAIL_GAP}) for ${side}.`);
}
function clearMainBoundary() {
  state.clearMainHedgeBoundary?.();
}

function trailMainBoundary(mainTrade, currentPrice) {
  if (!mainTrade) return;
  const { side, openPrice } = mainTrade;

  // Only trail after >= 400 pts profit from entry
  const profitProgress = side === 'Buy'
    ? currentPrice - openPrice
    : openPrice - currentPrice;
  if (profitProgress < TRAIL_ACTIVATION) return;

  const targetBoundary = side === 'Buy'
    ? currentPrice - TRAIL_GAP
    : currentPrice + TRAIL_GAP;

  const existing = state.getMainHedgeBoundary();
  if (!existing) {
    state.setMainHedgeBoundary({ side, boundary: targetBoundary, price: currentPrice, timestamp: now() });
    sendMessage(`Main boundary initialized (trail) -> ${targetBoundary}`);
    return;
  }

  // One-way tighten only
  const shouldTighten =
    (side === 'Buy' && targetBoundary > existing.boundary) ||
    (side === 'Sell' && targetBoundary < existing.boundary);

  if (shouldTighten) {
    state.setMainHedgeBoundary({ side, boundary: targetBoundary, price: currentPrice, timestamp: now() });
    sendMessage(`Main boundary tightened -> ${targetBoundary}`);
  }
}

/**
 * ====================== TRADE ACTIONS ======================
 * We store breakthrough on both main and hedge trades.
 */
async function openMainTrade(side, price) {
  if (mainOpeningInProgress) return;
  mainOpeningInProgress = true;
  try {
    await bybit.openMainTrade(side, ORDER_SIZE);
    const breakthrough = computeBreakthrough(side, price);
    state.setMainTrade({ side, openPrice: price, breakthrough });
    setMainBoundary(side, price);
    state.saveState();
    sendMessage(`Opened MAIN ${side} @ ${price} (breakthrough ${breakthrough}).`);
  } catch (e) {
    sendMessage(`Failed to open main trade: ${e.message || e}`);
  } finally {
    mainOpeningInProgress = false;
  }
}

async function closeMainTrade(price) {
  const trade = state.getMainTrade();
  if (!trade) return;
  try {
    await bybit.closeMainTrade(trade.side, ORDER_SIZE);
    const pnl = (price - trade.openPrice) * (trade.side === 'Buy' ? 1 : -1);
    state.logProfitLoss('main', pnl);
    state.clearMainTrade();
    clearMainBoundary();
    state.saveState();
    sendMessage(`Closed MAIN ${trade.side} @ ${price} (PnL ${pnl}).`);
  } catch (e) {
    sendMessage(`Failed to close main trade: ${e.message || e}`);
  }
}

async function openHedgeTrade(side, price) {
  if (hedgeOpeningInProgress) return;
  if (hedgeCooldownActive()) {
    sendMessage(`Skip hedge open: cooldown (${HEDGE_COOLDOWN_MS} ms).`);
    return;
  }
  if (state.getHedgeTrade()) {
    sendMessage('Skip hedge open: hedge already exists.');
    return;
  }
  hedgeOpeningInProgress = true;
  try {
    await bybit.openHedgeTrade(side, ORDER_SIZE);
    const breakthrough = computeBreakthrough(side, price);
    state.setHedgeTrade({ side, openPrice: price, breakthrough });
    state.saveState();
    markHedgeOpened();
    sendMessage(`Opened HEDGE ${side} @ ${price} (breakthrough ${breakthrough}).`);
  } catch (e) {
    sendMessage(`Failed to open hedge: ${e.message || e}`);
  } finally {
    hedgeOpeningInProgress = false;
  }
}

async function closeHedgeTrade(price) {
  const trade = state.getHedgeTrade();
  if (!trade) return;
  try {
    await bybit.closeHedgeTrade(trade.side, ORDER_SIZE);
    const pnl = (price - trade.openPrice) * (trade.side === 'Buy' ? 1 : -1);
    state.logProfitLoss('hedge', pnl);
    state.clearHedgeTrade();
    state.saveState();
    sendMessage(`Closed HEDGE ${trade.side} @ ${price} (PnL ${pnl}).`);
  } catch (e) {
    sendMessage(`Failed to close hedge: ${e.message || e}`);
  }
}

/**
 * ====================== CORE DECISION LOGIC ======================
 */

// Called when main boundary is hit
async function onMainBoundaryHit(currentPrice) {
  const main = state.getMainTrade();
  if (!main) return;

  const { side, breakthrough } = main;
  // Check breakthrough FIRST (your rule)
  if (isBeyondBreakthrough(side, currentPrice, breakthrough)) {
    // Close the main favorably
    await closeMainTrade(currentPrice);

    // If a hedge exists, TRANSFORM hedge → main (carry over hedge breakthrough)
    const hedge = state.getHedgeTrade();
    if (hedge) {
      state.setMainTrade({
        side: hedge.side,
        openPrice: hedge.openPrice,
        breakthrough: hedge.breakthrough, // NOTE: hedge breakthrough becomes main breakthrough
      });
      state.clearHedgeTrade();
      // New boundary at 300 gap from current price
      setMainBoundary(hedge.side, currentPrice);
      state.saveState();
      sendMessage(`TRANSFORM: Hedge (${hedge.side}) → MAIN. Breakthrough carried over: ${hedge.breakthrough}.`);
    }
  } else {
    // Not beyond breakthrough → open hedge instead of closing the main
    const hedgeSide = side === 'Buy' ? 'Sell' : 'Buy';
    await openHedgeTrade(hedgeSide, currentPrice);
    sendMessage(`Boundary hit but not beyond breakthrough → opened HEDGE ${hedgeSide}.`);
  }
}

// Hedge closing logic on STOP_LOSS or TAKE_PROFIT signals
async function maybeCloseHedgeOnSignal(signal, currentPrice) {
  if (!signal) return;
  if (!/STOP_LOSS|TAKE_PROFIT/.test(signal)) return;

  const hedge = state.getHedgeTrade();
  if (!hedge) return;

  // Check hedge breakthrough FIRST (your rule)
  if (isBeyondBreakthrough(hedge.side, currentPrice, hedge.breakthrough)) {
    await closeHedgeTrade(currentPrice);

    // Reset main boundary to 300 gap from this price (if a main exists)
    const main = state.getMainTrade();
    if (main) {
      setMainBoundary(main.side, currentPrice);
      state.saveState();
      sendMessage('Hedge closed on signal beyond breakthrough → main boundary reset to 300 gap from current price.');
    }
  } else {
    // Do nothing (hold hedge)
    sendMessage('Hedge signal received but price not beyond hedge breakthrough → holding hedge.');
  }
}

/**
 * ====================== SIGNAL HANDLER ======================
 */
async function handleSignal(signal, currentPrice) {
  let main = state.getMainTrade();

  state.setLastSignal(signal);
  state.setLastPrice(currentPrice);

  // Hedge close rule (STOP_LOSS / TAKE_PROFIT) based on hedge breakthrough
  await maybeCloseHedgeOnSignal(signal, currentPrice);

  // Basic main open on BUY/SELL signal
  switch (signal) {
    case 'BUY':
      if (!main) await openMainTrade('Buy', currentPrice);
      break;
    case 'SELL':
      if (!main) await openMainTrade('Sell', currentPrice);
      break;
    default:
      break;
  }

  state.saveState();
}

/**
 * ====================== MONITOR LOOP ======================
 */
async function monitorPrice() {
  monitoring = true;

  while (monitoring && state.isRunning()) {
    try {
      const price = getCurrentPrice();
      if (price == null || Number.isNaN(price)) {
        await new Promise(r => setTimeout(r, 250));
        continue;
      }

      const signal = await analyze().catch(() => null);
      await handleSignal(signal, price);

      // Main trailing update + boundary hit check
      const main = state.getMainTrade();
      const boundary = state.getMainHedgeBoundary();

      if (main) {
        trailMainBoundary(main, price);

        if (boundary) {
          const hit =
            (main.side === 'Buy' && price <= boundary.boundary) ||
            (main.side === 'Sell' && price >= boundary.boundary);

          if (hit) {
            await onMainBoundaryHit(price);
          }
        }
      }

      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      sendMessage(`Monitor error: ${err?.message || err}`);
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

/**
 * ====================== LIFECYCLE ======================
 */
async function startBot() {
  startPolling(1000);
  await waitForFirstPrice();
  state.startBot();
  resumeBotState();
  monitoring = true;
  sendMessage('🤖 Bot started');
  monitorPrice();
}

function stopBot() {
  stopPolling();
  state.stopBot();
  monitoring = false;
  sendMessage('🛑 Bot stopped');
}

function resumeBotState() {
  const mainTrade = state.getMainTrade();
  const hedgeTrade = state.getHedgeTrade();
  const lastSignal = state.getLastSignal();
  const lastPrice = state.getLastPrice();

  if (mainTrade) {
    sendMessage(
      `Resuming MAIN ${mainTrade.side} @ ${mainTrade.openPrice} (breakthrough ${mainTrade.breakthrough}).`
    );
  }
  if (hedgeTrade) {
    sendMessage(
      `Resuming HEDGE ${hedgeTrade.side} @ ${hedgeTrade.openPrice} (breakthrough ${hedgeTrade.breakthrough}).`
    );
  }
  if (lastSignal && lastPrice != null) sendMessage(`Last signal: ${lastSignal} @ ${lastPrice}`);
}

function clearBotState() {
  stopPolling();
  state.resetBotState();
  sendMessage('♻️ Bot state cleared. Ready for fresh start.');
}

module.exports = {
  startBot,
  stopBot,
  monitorPrice,
  resumeBotState,
  clearBotState,
};
