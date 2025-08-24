const state = require('./state');
const { getCurrentPrice, waitForFirstPrice, startPolling, stopPolling } = require('./priceFeed');
const { analyze } = require('./technical');
const bybit = require('./binanceClient');

const PROFIT_POINT = 300;
const ORDER_SIZE = 1;
const HEDGE_BOUNDARY_DISTANCE = 250; // For promoted hedge or closed hedge
const HEDGE_BOUNDARY_MAIN_DISTANCE = 300; // For main trade trailing hedge boundary

// Helper: Breakthrough price calculation
function getBreakthroughPrice(trade, type = 'main') {
  if (!trade) return null;
  if (type === 'main' || type === 'hedge') {
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
    trailMainHedgeBoundary(side, price, price); // Set initial main hedge boundary
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
    state.clearMainHedgeBoundary();
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

// Trailing boundary for hedge trade (ONE WAY TRAIL UP)
function trailHedgeBoundary(side, price) {
  let boundary;
  if (side === 'Buy') {
    boundary = price - HEDGE_BOUNDARY_DISTANCE;
    state.setHedgeBoundary({ side, boundary, price, timestamp: Date.now() });
    sendMessage(`Hedge boundary for BUY trailed up to ${boundary}, 250 points below price`);
  } else if (side === 'Sell') {
    boundary = price + HEDGE_BOUNDARY_DISTANCE;
    state.setHedgeBoundary({ side, boundary, price, timestamp: Date.now() });
    sendMessage(`Hedge boundary for SELL trailed down to ${boundary}, 250 points above price`);
  }
}

// Trailing boundary for main trade hedge (ONE WAY TRAIL UP)
function trailMainHedgeBoundary(side, mainEntry, currentPrice) {
  let boundary;
  if (side === 'Buy') {
    boundary = currentPrice - HEDGE_BOUNDARY_MAIN_DISTANCE;
    const existing = state.getMainHedgeBoundary();
    if (!existing || boundary > existing.boundary) {
      state.setMainHedgeBoundary({ side, boundary, price: currentPrice, timestamp: Date.now() });
      sendMessage(`Main hedge boundary for BUY trailed up to ${boundary} (300 points below price)`);
    }
  } else if (side === 'Sell') {
    boundary = currentPrice + HEDGE_BOUNDARY_MAIN_DISTANCE;
    const existing = state.getMainHedgeBoundary();
    if (!existing || boundary < existing.boundary) {
      state.setMainHedgeBoundary({ side, boundary, price: currentPrice, timestamp: Date.now() });
      sendMessage(`Main hedge boundary for SELL trailed down to ${boundary} (300 points above price)`);
    }
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
      trailHedgeBoundary(hedgeTrade.side, currentPrice);
      sendMessage(`Main BUY trade closed, hedge promoted to main. New hedge boundary set at ${currentPrice}.`);
      state.saveState();
      mainTrade = state.getMainTrade();
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
      trailHedgeBoundary(hedgeTrade.side, currentPrice);
      sendMessage(`Hedge trade closed on ${signal} and price above breakthrough. New hedge boundary set.`);
    }
  }
  state.saveState();
}

// --- Main trade hedge boundary logic correction ---
async function monitorPrice() {
  monitoring = true;
  while (monitoring && state.isRunning()) {
    try {
      const currentPrice = getCurrentPrice();
      const signal = await analyze();
      await handleSignal(signal, currentPrice);

      // Activate auto-hedge protection!
      await autoHedgeCheck(currentPrice, signal);

      // --- Main hedge boundary trailing and trigger logic ---
      const mainTrade = state.getMainTrade();
      const mainHedgeBoundary = state.getMainHedgeBoundary();

      if (mainTrade && mainHedgeBoundary) {
        // Trail boundary only in one direction
        trailMainHedgeBoundary(mainTrade.side, mainTrade.openPrice, currentPrice);

        const breakthrough = getBreakthroughPrice(mainTrade);
        // If price drops back to the hedge boundary
        if (
          (mainTrade.side === 'Buy' && currentPrice <= mainHedgeBoundary.boundary) ||
          (mainTrade.side === 'Sell' && currentPrice >= mainHedgeBoundary.boundary)
        ) {
          // If hedge boundary is above breakthrough (for BUY), below for SELL
          if (
            (mainTrade.side === 'Buy' && mainHedgeBoundary.boundary > breakthrough) ||
            (mainTrade.side === 'Sell' && mainHedgeBoundary.boundary < breakthrough)
          ) {
            // Close main trade and wait for new signal
            await closeMainTrade(currentPrice);
            sendMessage('Main trade closed as price dropped to trailing hedge boundary above breakthrough. Waiting for new signal.');
          } else {
            // Open hedge trade
            await openHedgeTrade(mainTrade.side === 'Buy' ? 'Sell' : 'Buy', currentPrice);
            sendMessage('Hedge trade opened as price dropped to trailing hedge boundary at/below breakthrough.');
          }
        }
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (err) {
      sendMessage(`Monitor error: ${err.message}`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

// Auto-hedge logic (now called in monitorPrice)
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
