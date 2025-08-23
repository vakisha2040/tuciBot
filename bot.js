const state = require('./state');
const { getCurrentPrice, waitForFirstPrice, startPolling, stopPolling } = require('./priceFeed');
const { analyze } = require('./technical');
const bybit = require('./binanceClient');

const TRAILING_DISTANCE = 400;
const TRAILING_THRESHOLD = 300;
const PROFIT_POINT = 300;
const ORDER_SIZE = 1;
const HEDGE_BOUNDARY_DISTANCE = 250; // New boundary for hedge close

// Helper: Breakthrough price calculation
function getBreakthroughPrice(trade, type = 'main') {
  if (!trade) return null;
  if (type === 'main') {
    return trade.side === 'Buy'
      ? trade.openPrice + PROFIT_POINT
      : trade.openPrice - PROFIT_POINT;
  } else if (type === 'hedge') {
    return trade.side === 'Buy'
      ? trade.openPrice + PROFIT_POINT
      : trade.openPrice - PROFIT_POINT;
  }
  return null;
}

function sendMessage(msg) {
  console.log(msg);
}

// Trade actions
async function openMainTrade(side, price) {
  try {
    await bybit.openMainTrade(side, ORDER_SIZE);
    sendMessage(`Opened main trade ${side} at ${price}`);
    state.setMainTrade({ side, openPrice: price });
    state.saveState();
  } catch (e) {
    sendMessage(`Failed to open main trade: ${e.message}`);
  }
}
async function closeMainTrade(price) {
  try {
    const trade = state.getMainTrade();
    if (!trade) return;
    await bybit.closeMainTrade(trade.side, ORDER_SIZE);
    sendMessage(`Closed main trade ${trade.side} at ${price}`);
    state.logProfitLoss('main', (price - trade.openPrice) * (trade.side === 'Buy' ? 1 : -1));
    state.clearMainTrade();
    state.saveState();
  } catch (e) {
    sendMessage(`Failed to close main trade: ${e.message}`);
  }
}
async function openHedgeTrade(side, price) {
  try {
    await bybit.openHedgeTrade(side, ORDER_SIZE);
    sendMessage(`Opened hedge trade ${side} at ${price}`);
    state.setHedgeTrade({ side, openPrice: price });
    state.saveState();
  } catch (e) {
    sendMessage(`Failed to open hedge trade: ${e.message}`);
  }
}
async function closeHedgeTrade(price) {
  try {
    const trade = state.getHedgeTrade();
    if (!trade) return;
    await bybit.closeHedgeTrade(trade.side, ORDER_SIZE);
    sendMessage(`Closed hedge trade ${trade.side} at ${price}`);
    state.logProfitLoss('hedge', (price - trade.openPrice) * (trade.side === 'Buy' ? 1 : -1));
    state.clearHedgeTrade();
    state.saveState();
  } catch (e) {
    sendMessage(`Failed to close hedge trade: ${e.message}`);
  }
}

// Trailing boundary for main trade
function trailBoundary(side, price, trailingDistance, trailingThreshold) {
  let boundary = side === 'Buy'
    ? price - trailingDistance
    : price + trailingDistance;
  state.addTrailingBoundary({ side, boundary, price, timestamp: Date.now() });
  sendMessage(`Boundary for ${side} trade trailed to ${boundary}, maintaining ${trailingDistance} points`);
}

// Trailing boundary for hedge trade (ONE WAY TRAIL UP)
function trailHedgeBoundary(side, price) {
  // Only trail up in one direction
  let boundary;
  if (side === 'Buy') {
    // For Buy, trail up only if price increases
    boundary = price - HEDGE_BOUNDARY_DISTANCE;
    state.setHedgeBoundary({ side, boundary, price, timestamp: Date.now() });
    sendMessage(`Hedge boundary for BUY trailed up to ${boundary}, 250 points below price`);
  } else if (side === 'Sell') {
    // For Sell, trail down only if price decreases
    boundary = price + HEDGE_BOUNDARY_DISTANCE;
    state.setHedgeBoundary({ side, boundary, price, timestamp: Date.now() });
    sendMessage(`Hedge boundary for SELL trailed down to ${boundary}, 250 points above price`);
  }
}

// MAIN SIGNAL HANDLER WITH PROMOTION LOGIC AND HEDGE TRAILING
async function handleSignal(signal, currentPrice) {
  let mainTrade = state.getMainTrade();
  let hedgeTrade = state.getHedgeTrade();

  state.setLastSignal(signal);
  state.setLastPrice(currentPrice);

  // --- PROMOTION LOGIC: Hedge becomes main if STOP_LOSS signal and price above breakthrough ---
  if (mainTrade && hedgeTrade) {
    const mainBreakthrough = getBreakthroughPrice(mainTrade);
    // Main BUY logic
    if (
      mainTrade.side === 'Buy' &&
      signal === 'STOP_LOSS_LONG' &&
      currentPrice > mainBreakthrough
    ) {
      await closeMainTrade(currentPrice); // Close main trade
      // Promote hedge to main trade without closing
      state.setMainTrade({ side: hedgeTrade.side, openPrice: hedgeTrade.openPrice });
      state.clearHedgeTrade();
      // Set new hedge close boundary for the new main trade (250 points away, trail up only)
      trailHedgeBoundary(hedgeTrade.side, currentPrice);
      sendMessage(`Main BUY trade closed, hedge promoted to main. New hedge boundary set at ${currentPrice}.`);
      state.saveState();
      mainTrade = state.getMainTrade(); // refresh reference
      hedgeTrade = null;
      return;
    }
    // Main SELL logic
    if (
      mainTrade.side === 'Sell' &&
      signal === 'STOP_LOSS_SHORT' &&
      currentPrice > mainBreakthrough
    ) {
      await closeMainTrade(currentPrice); // Close main trade
      state.setMainTrade({ side: hedgeTrade.side, openPrice: hedgeTrade.openPrice });
      state.clearHedgeTrade();
      trailHedgeBoundary(hedgeTrade.side, currentPrice);
      sendMessage(`Main SELL trade closed, hedge promoted to main. New hedge boundary set at ${currentPrice}.`);
      state.saveState();
      mainTrade = state.getMainTrade();
      hedgeTrade = null;
      return;
    }
  }

  // --- Main Trade Logic (standard) ---
  switch (signal) {
    case 'BUY':
      if (!mainTrade) {
        await openMainTrade('Buy', currentPrice);
        mainTrade = state.getMainTrade();
      }
      break;
    case 'TAKE_PROFIT_LONG':
      if (mainTrade && mainTrade.side === 'Buy') {
        const breakthrough = getBreakthroughPrice(mainTrade);
        if (currentPrice > breakthrough) {
          await closeMainTrade(currentPrice);
          mainTrade = null;
          state.clearHedgeCloseBoundary();
        } else {
          await openHedgeTrade('Sell', currentPrice);
        }
      }
      break;
    case 'STOP_LOSS_LONG':
      if (mainTrade && mainTrade.side === 'Buy') {
        const breakthrough = getBreakthroughPrice(mainTrade);
        if (currentPrice > breakthrough) {
          await closeMainTrade(currentPrice);
          mainTrade = null;
        } else {
          await openHedgeTrade('Sell', currentPrice);
        }
      }
      break;
    case 'SELL':
      if (!mainTrade) {
        await openMainTrade('Sell', currentPrice);
        mainTrade = state.getMainTrade();
      }
      break;
    case 'TAKE_PROFIT_SHORT':
      if (mainTrade && mainTrade.side === 'Sell') {
        const breakthrough = getBreakthroughPrice(mainTrade);
        if (currentPrice < breakthrough) {
          await closeMainTrade(currentPrice);
          mainTrade = null;
        } else {
          await openHedgeTrade('Buy', currentPrice);
        }
      }
      break;
    case 'STOP_LOSS_SHORT':
      if (mainTrade && mainTrade.side === 'Sell') {
        const breakthrough = getBreakthroughPrice(mainTrade);
        if (currentPrice < breakthrough) {
          await closeMainTrade(currentPrice);
          mainTrade = null;
        } else {
          await openHedgeTrade('Buy', currentPrice);
        }
      }
      break;
  }

  // --- Hedge Trade Logic: CLOSE only on STOP_LOSS_LONG or STOP_LOSS_SHORT (with price above/below breakthrough) ---
  hedgeTrade = state.getHedgeTrade();
  if (hedgeTrade) {
    const hedgeBreakthrough = getBreakthroughPrice(hedgeTrade, 'hedge');
    if (
      (hedgeTrade.side === 'Buy' && signal === 'STOP_LOSS_LONG' && currentPrice > hedgeBreakthrough) ||
      (hedgeTrade.side === 'Sell' && signal === 'STOP_LOSS_SHORT' && currentPrice < hedgeBreakthrough)
    ) {
      await closeHedgeTrade(currentPrice);
      // Set new hedge boundary for trailing (one way, 250 points)
      trailHedgeBoundary(hedgeTrade.side, currentPrice);
      sendMessage(`Hedge trade closed on ${signal} and price above breakthrough. New hedge boundary set.`);
    }
    // If signal is present but price not above/below breakthrough, do nothing
  }
  state.saveState();
}

// Auto-hedge logic
async function autoHedgeCheck(currentPrice, signal) {
  const mainTrade = state.getMainTrade();
  const hedgeTrade = state.getHedgeTrade();
  if (mainTrade && !signal && !hedgeTrade) {
    if (mainTrade.side === 'Buy' && currentPrice <= mainTrade.openPrice - PROFIT_POINT) {
      await openHedgeTrade('Sell', currentPrice);
      sendMessage('Auto-hedge SELL opened as price dropped 300 points below main BUY trade!');
    }
    if (mainTrade.side === 'Sell' && currentPrice >= mainTrade.openPrice + PROFIT_POINT) {
      await openHedgeTrade('Buy', currentPrice);
      sendMessage('Auto-hedge BUY opened as price rose 300 points above main SELL trade!');
    }
  }
}

let monitoring = false;
async function monitorPrice() {
  monitoring = true;
  while (monitoring && state.isRunning()) {
    try {
      const currentPrice = getCurrentPrice();
      const signal = await analyze();
      if (typeof signal === 'string' && typeof currentPrice === 'number') {
        await handleSignal(signal, currentPrice);
      } else {
        await autoHedgeCheck(currentPrice, signal);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (err) {
      sendMessage(`Monitor error: ${err.message}`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

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
  if (mainTrade) sendMessage(`Resuming main trade: ${mainTrade.side} at ${mainTrade.openPrice}`);
  if (hedgeTrade) sendMessage(`Resuming hedge trade: ${hedgeTrade.side} at ${hedgeTrade.openPrice}`);
  if (lastSignal && lastPrice) sendMessage(`Last signal: ${lastSignal}, Last price: ${lastPrice}`);
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
