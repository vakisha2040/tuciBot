const state = require('./state');
const { getCurrentPrice, waitForFirstPrice, startPolling, stopPolling } = require('./priceFeed');
const { analyze } = require('./technical');
const bybit = require('./binanceClient');

const TRAILING_DISTANCE = 400;
const TRAILING_THRESHOLD = 300;
const PROFIT_POINT = 300;
const ORDER_SIZE = 1; // You can load this from config if needed

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

function trailBoundary(side, price, trailingDistance, trailingThreshold) {
  let boundary = side === 'Buy'
    ? price - trailingDistance
    : price + trailingDistance;
  state.addTrailingBoundary({ side, boundary, price, timestamp: Date.now() });
  sendMessage(`Boundary for ${side} trade trailed to ${boundary}, maintaining ${trailingDistance} points`);
}

async function handleSignal(signal, currentPrice) {
  let mainTrade = state.getMainTrade();
  let hedgeTrade = state.getHedgeTrade();
  let hedgeCloseBoundary = state.getHedgeCloseBoundary();

  state.setLastSignal(signal);
  state.setLastPrice(currentPrice);

  // --- Main Trade Logic ---
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

  // --- Hedge Trade Logic ---
  hedgeTrade = state.getHedgeTrade();
  if (hedgeTrade) {
    const hedgeBreakthrough = getBreakthroughPrice(hedgeTrade, 'hedge');
    if (hedgeTrade.side === 'Buy') {
      switch (signal) {
        case 'BUY':
        case 'TAKE_PROFIT_LONG':
          sendMessage('Buy hedge is running strong');
          break;
        case 'STOP_LOSS_LONG':
          if (currentPrice > hedgeBreakthrough) {
            await closeHedgeTrade(currentPrice);
            state.setHedgeCloseBoundary(currentPrice);
            trailBoundary('Sell', currentPrice, TRAILING_DISTANCE, TRAILING_THRESHOLD);
            hedgeTrade = null;
          }
          break;
      }
    } else if (hedgeTrade.side === 'Sell') {
      switch (signal) {
        case 'SELL':
        case 'TAKE_PROFIT_SHORT':
          sendMessage('Sell hedge is running strong');
          break;
        case 'STOP_LOSS_SHORT':
          if (currentPrice < hedgeBreakthrough) {
            await closeHedgeTrade(currentPrice);
            state.setHedgeCloseBoundary(currentPrice);
            trailBoundary('Buy', currentPrice, TRAILING_DISTANCE, TRAILING_THRESHOLD);
            hedgeTrade = null;
          }
          break;
      }
    }
    hedgeCloseBoundary = state.getHedgeCloseBoundary();
    if (hedgeCloseBoundary && (
      (hedgeTrade && hedgeTrade.side === 'Sell' && currentPrice >= hedgeCloseBoundary) ||
      (hedgeTrade && hedgeTrade.side === 'Buy' && currentPrice <= hedgeCloseBoundary)
    )) {
      await openHedgeTrade(hedgeTrade.side, currentPrice);
      state.clearHedgeCloseBoundary();
    }
  }
  state.saveState();
}

// --- New Logic: Auto Hedge on Price Drop ---
async function autoHedgeCheck(currentPrice, signal) {
  const mainTrade = state.getMainTrade();
  const hedgeTrade = state.getHedgeTrade();
  // Only if mainTrade is open, no signal, and no hedgeTrade
  if (mainTrade && !signal && !hedgeTrade) {
    if (mainTrade.side === 'Buy') {
      // If price drops 300 points below open price
      if (currentPrice <= mainTrade.openPrice - PROFIT_POINT) {
        await openHedgeTrade('Sell', currentPrice);
        sendMessage('Auto-hedge SELL opened as price dropped 300 points below main BUY trade!');
      }
    } else if (mainTrade.side === 'Sell') {
      // If price rises 300 points above open price
      if (currentPrice >= mainTrade.openPrice + PROFIT_POINT) {
        await openHedgeTrade('Buy', currentPrice);
        sendMessage('Auto-hedge BUY opened as price rose 300 points above main SELL trade!');
      }
    }
  }
}

// --- Monitoring Loop ---
let monitoring = false;
async function monitorPrice() {
  monitoring = true;
  while (monitoring && state.isRunning()) {
    try {
      const currentPrice = getCurrentPrice();
      const signal = await analyze();

      // Handle regular signal logic
      if (typeof signal === 'string' && typeof currentPrice === 'number') {
        await handleSignal(signal, currentPrice);
      } else {
        // No signal: check auto-hedge
        await autoHedgeCheck(currentPrice, signal);
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (err) {
      sendMessage(`Monitor error: ${err.message}`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

// --- Start/Stop with resume ---
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
