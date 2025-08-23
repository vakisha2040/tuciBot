const state = require('./state');
const { getCurrentPrice, waitForFirstPrice, startPolling, stopPolling } = require('./priceFeed');
const { analyze } = require('./technical');
const bybit = require('./binanceClient');

const TRAILING_DISTANCE = 400;
const TRAILING_THRESHOLD = 300;
const PROFIT_POINT = 300;
const ORDER_SIZE = 1; // Adjust as needed or pull from config

let mainTrade = null;
let hedgeTrade = null;
let hedgeCloseBoundary = null;

// --- Helper Functions ---
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
  // Integrate with your messaging/notification system
  console.log(msg);
}

// --- Trade Actions using broker ---
async function openMainTrade(side, price) {
  try {
    await bybit.openMainTrade(side, ORDER_SIZE);
    sendMessage(`Opened main trade ${side} at ${price}`);
    state.setMainTrade({ side, openPrice: price });
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
    state.clearMainTrade();
  } catch (e) {
    sendMessage(`Failed to close main trade: ${e.message}`);
  }
}
async function openHedgeTrade(side, price) {
  try {
    await bybit.openHedgeTrade(side, ORDER_SIZE);
    sendMessage(`Opened hedge trade ${side} at ${price}`);
    state.setHedgeTrade({ side, openPrice: price });
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
    state.clearHedgeTrade();
  } catch (e) {
    sendMessage(`Failed to close hedge trade: ${e.message}`);
  }
}

// --- Trailing boundary logic ---
function trailBoundary(side, price, trailingDistance, trailingThreshold) {
  let boundary = side === 'Buy'
    ? price - trailingDistance
    : price + trailingDistance;
  sendMessage(`Boundary for ${side} trade trailed to ${boundary}, maintaining ${trailingDistance} points`);
  // Could persist/update state here as needed
}

// --- Signal Handler ---
async function handleSignal(signal, currentPrice) {
  mainTrade = state.getMainTrade();
  hedgeTrade = state.getHedgeTrade();

  // ---------- MAIN TRADE LOGIC ----------
  switch (signal) {
    case 'BUY':
      if (!mainTrade) {
        mainTrade = { side: 'Buy', openPrice: currentPrice };
        await openMainTrade('Buy', currentPrice);
      }
      break;

    case 'TAKE_PROFIT_LONG':
      if (mainTrade && mainTrade.side === 'Buy') {
        const breakthrough = getBreakthroughPrice(mainTrade);
        if (currentPrice > breakthrough) {
          await closeMainTrade(currentPrice);
          mainTrade = null;
          hedgeCloseBoundary = null;
        } else {
          hedgeTrade = { side: 'Sell', openPrice: currentPrice };
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
          hedgeTrade = { side: 'Sell', openPrice: currentPrice };
          await openHedgeTrade('Sell', currentPrice);
        }
      }
      break;

    case 'SELL':
      if (!mainTrade) {
        mainTrade = { side: 'Sell', openPrice: currentPrice };
        await openMainTrade('Sell', currentPrice);
      }
      break;

    case 'TAKE_PROFIT_SHORT':
      if (mainTrade && mainTrade.side === 'Sell') {
        const breakthrough = getBreakthroughPrice(mainTrade);
        if (currentPrice < breakthrough) {
          await closeMainTrade(currentPrice);
          mainTrade = null;
        } else {
          hedgeTrade = { side: 'Buy', openPrice: currentPrice };
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
          hedgeTrade = { side: 'Buy', openPrice: currentPrice };
          await openHedgeTrade('Buy', currentPrice);
        }
      }
      break;
  }

  // ---------- HEDGE TRADE LOGIC ----------
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
            hedgeCloseBoundary = currentPrice;
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
            hedgeCloseBoundary = currentPrice;
            trailBoundary('Buy', currentPrice, TRAILING_DISTANCE, TRAILING_THRESHOLD);
            hedgeTrade = null;
          }
          break;
      }
    }
    // If price crosses back to hedgeCloseBoundary, open new hedge
    if (hedgeCloseBoundary && (
      (hedgeTrade && hedgeTrade.side === 'Sell' && currentPrice >= hedgeCloseBoundary) ||
      (hedgeTrade && hedgeTrade.side === 'Buy' && currentPrice <= hedgeCloseBoundary)
    )) {
      await openHedgeTrade(hedgeTrade.side, currentPrice);
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

      if (typeof signal === 'string' && typeof currentPrice === 'number') {
        await handleSignal(signal, currentPrice);
      } else {
        sendMessage('Waiting for valid signal and price...');
      }
      await new Promise(resolve => setTimeout(resolve, 1000)); // Poll every second
    } catch (err) {
      sendMessage(`Monitor error: ${err.message}`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

// --- Start/Stop ---
async function startBot() {
  startPolling(1000);
  await waitForFirstPrice();
  state.startBot();
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

// --- Export ---
module.exports = {
  startBot,
  stopBot,
  monitorPrice, // for manual control if needed
};
