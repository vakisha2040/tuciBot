const state = require('./state');
const { getCurrentPrice, waitForFirstPrice, startPolling, stopPolling } = require('./priceFeed');
const { analyze } = require('./technical');
const bybit = require('./binanceClient');

// Trailing system parameters
const TRAILING_STEP = 400;         // Move trailing boundary after this much profit move
const TRAILING_DISTANCE = 300;     // Boundary is always this far from current price
const PROFIT_POINT = 300;          // Used for breakthrough logic
const ORDER_SIZE = 1;

let maxPriceForTrailing = null;    // For BUY main trade
let minPriceForTrailing = null;    // For SELL main trade

function sendMessage(msg) {
  console.log(msg);
}

function resetTrailingExtrema() {
  maxPriceForTrailing = null;
  minPriceForTrailing = null;
}

// --- Trailing boundary update (core logic) ---
function updateTrailingBoundary(side, currentPrice) {
  if (side === 'Buy') {
    if (maxPriceForTrailing === null) maxPriceForTrailing = currentPrice;
    // If price moves up at least TRAILING_STEP since last boundary update
    if (currentPrice - maxPriceForTrailing >= TRAILING_STEP) {
      maxPriceForTrailing = currentPrice;
      const boundary = currentPrice - TRAILING_DISTANCE;
      state.setMainHedgeBoundary({
        side: 'Buy',
        boundary,
        price: currentPrice,
        timestamp: Date.now()
      });
      sendMessage(`BUY trailing boundary moved up to ${boundary}, maintaining 300 points below price`);
    }
  } else if (side === 'Sell') {
    if (minPriceForTrailing === null) minPriceForTrailing = currentPrice;
    // If price moves down at least TRAILING_STEP since last boundary update
    if (minPriceForTrailing - currentPrice >= TRAILING_STEP) {
      minPriceForTrailing = currentPrice;
      const boundary = currentPrice + TRAILING_DISTANCE;
      state.setMainHedgeBoundary({
        side: 'Sell',
        boundary,
        price: currentPrice,
        timestamp: Date.now()
      });
      sendMessage(`SELL trailing boundary moved down to ${boundary}, maintaining 300 points above price`);
    }
  }
}

// --- Trade action helpers ---
async function openMainTrade(side, price) {
  try {
    await bybit.openMainTrade(side, ORDER_SIZE);
    sendMessage(`Opened main trade ${side} at ${price}`);
    state.setMainTrade({ side, openPrice: price });
    resetTrailingExtrema(); // Reset trailing extrema when new trade opened
    state.setMainHedgeBoundary({
      side,
      boundary: side === 'Buy' ? price - TRAILING_DISTANCE : price + TRAILING_DISTANCE,
      price,
      timestamp: Date.now()
    });
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
    resetTrailingExtrema();
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

// --- Signal handling ---
function getBreakthroughPrice(trade) {
  if (!trade) return null;
  return trade.side === 'Buy'
    ? trade.openPrice + PROFIT_POINT
    : trade.openPrice - PROFIT_POINT;
}

async function handleSignal(signal, currentPrice) {
  let mainTrade = state.getMainTrade();
  let hedgeTrade = state.getHedgeTrade();

  state.setLastSignal(signal);
  state.setLastPrice(currentPrice);

  // Main trade open/close
  switch (signal) {
    case 'BUY':
      if (!mainTrade) {
        await openMainTrade('Buy', currentPrice);
        mainTrade = state.getMainTrade();
      }
      break;
    case 'SELL':
      if (!mainTrade) {
        await openMainTrade('Sell', currentPrice);
        mainTrade = state.getMainTrade();
      }
      break;
    case 'TAKE_PROFIT_LONG':
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

  // Hedge trade close logic
  hedgeTrade = state.getHedgeTrade();
  if (hedgeTrade) {
    const hedgeBreakthrough = getBreakthroughPrice(hedgeTrade);
    if (
      (hedgeTrade.side === 'Buy' && signal === 'STOP_LOSS_LONG' && currentPrice > hedgeBreakthrough) ||
      (hedgeTrade.side === 'Sell' && signal === 'STOP_LOSS_SHORT' && currentPrice < hedgeBreakthrough)
    ) {
      await closeHedgeTrade(currentPrice);
      sendMessage(`Hedge trade closed on ${signal} and price above breakthrough.`);
    }
  }
  state.saveState();
}

// --- Auto-hedge logic ---
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

// --- Monitoring loop ---
async function monitorPrice() {
  monitoring = true;
  while (monitoring && state.isRunning()) {
    try {
      const currentPrice = getCurrentPrice();
      const signal = await analyze();
      await handleSignal(signal, currentPrice);

      const mainTrade = state.getMainTrade();
      const mainHedgeBoundary = state.getMainHedgeBoundary();

      // Update trailing boundary for main trade
      if (mainTrade) {
        updateTrailingBoundary(mainTrade.side, currentPrice);
      }
    // In your monitoring loop, after updateTrailingBoundary:
if (mainTrade && mainHedgeBoundary) {
  const breakthrough = getBreakthroughPrice(mainTrade);

  // For BUY main trade
  if (mainTrade.side === 'Buy' && currentPrice <= mainHedgeBoundary.boundary) {
    if (currentPrice > breakthrough) {
      await closeMainTrade(currentPrice);
      sendMessage('Main BUY trade closed as price reached trailing boundary above breakthrough.');
    } else {
      await openHedgeTrade('Sell', currentPrice);
      sendMessage('Hedge SELL trade opened as price reached trailing boundary below breakthrough.');
    }
  }

  // For SELL main trade
  if (mainTrade.side === 'Sell' && currentPrice >= mainHedgeBoundary.boundary) {
    if (currentPrice < breakthrough) {
      await closeMainTrade(currentPrice);
      sendMessage('Main SELL trade closed as price reached trailing boundary below breakthrough.');
    } else {
      await openHedgeTrade('Buy', currentPrice);
      sendMessage('Hedge BUY trade opened as price reached trailing boundary above breakthrough.');
    }
  }
}
      // Trailing boundary trigger logic
      if (mainTrade && mainHedgeBoundary) {
        // If price drops to boundary (BUY) or rises to boundary (SELL)
        if (
          (mainTrade.side === 'Buy' && currentPrice <= mainHedgeBoundary.boundary) ||
          (mainTrade.side === 'Sell' && currentPrice >= mainHedgeBoundary.boundary)
        ) {
          await closeMainTrade(currentPrice);
          sendMessage('Main trade closed as price reached trailing boundary.');
        }
      }





      
      // Auto-hedge check
      await autoHedgeCheck(currentPrice, signal);

      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (err) {
      sendMessage(`Monitor error: ${err.message}`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

// --- Bot control and state management ---
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
  resetTrailingExtrema();
  sendMessage('♻️ Bot state cleared. Ready for fresh start.');
}

module.exports = {
  startBot,
  stopBot,
  monitorPrice,
  resumeBotState,
  clearBotState,
};
