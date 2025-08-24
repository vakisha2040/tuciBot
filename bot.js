// bot.js
const config = require('./config.json');
const state = require('./state');
const { getCurrentPrice, waitForFirstPrice, startPolling, stopPolling } = require('./priceFeed');
const { analyze } = require('./technical');
const exchange = require('./binanceClient'); // assumed exchange client

/**
 * ====================== HELPERS ======================
 */
const now = () => Date.now();
const sendMessage = (m) => console.log(m);

function computeBreakthrough(side, openPrice) {
  return side === 'Buy'
    ? openPrice + config.boundaryGap
    : openPrice - config.boundaryGap;
}
function isBeyondBreakthrough(side, price, breakthrough) {
  return side === 'Buy' ? price >= breakthrough : price <= breakthrough;
}

/**
 * ====================== MAIN BOUNDARY (TRAILING) ======================
 */
function setMainBoundary(side, refPrice) {
  const boundary = side === 'Buy'
    ? refPrice - config.boundaryGap
    : refPrice + config.boundaryGap;

  state.setMainHedgeBoundary({
    side,
    boundary,
    price: refPrice,
    timestamp: now()
  });
  sendMessage(`📍 Main boundary set at ${boundary} for ${side}`);
}

function clearMainBoundary() {
  state.clearMainHedgeBoundary();
}

function trailMainBoundary(mainTrade, currentPrice) {
  if (!mainTrade) return;
  const { side, openPrice } = mainTrade;

  const profitProgress = side === 'Buy'
    ? currentPrice - openPrice
    : openPrice - currentPrice;

  if (profitProgress < config.minTrailMove) return;

  const targetBoundary = side === 'Buy'
    ? currentPrice - config.boundaryGap
    : currentPrice + config.boundaryGap;

  const existing = state.getMainHedgeBoundary();
  if (!existing) {
    state.setMainHedgeBoundary({ side, boundary: targetBoundary, price: currentPrice, timestamp: now() });
    sendMessage(`📈 Boundary initialized @ ${targetBoundary}`);
    return;
  }

  const shouldTighten =
    (side === 'Buy' && targetBoundary > existing.boundary) ||
    (side === 'Sell' && targetBoundary < existing.boundary);

  if (shouldTighten) {
    state.setMainHedgeBoundary({ side, boundary: targetBoundary, price: currentPrice, timestamp: now() });
    sendMessage(`📈 Boundary tightened to ${targetBoundary}`);
  }
}

/**
 * ====================== TRADE ACTIONS ======================
 */
async function openMainTrade(side, price) {
  try {
    await exchange.openMainTrade(side, config.entrySize);
    const breakthrough = computeBreakthrough(side, price);

    state.setMainTrade({ side, openPrice: price, breakthrough });
    setMainBoundary(side, price);
    sendMessage(`✅ MAIN ${side} opened @ ${price} (breakthrough ${breakthrough})`);
  } catch (e) {
    sendMessage(`❌ Failed to open main: ${e.message || e}`);
  }
}

async function closeMainTrade(price) {
  const trade = state.getMainTrade();
  if (!trade) return;

  try {
    await exchange.closeMainTrade(trade.side, config.entrySize);
    const pnl = (price - trade.openPrice) * (trade.side === 'Buy' ? 1 : -1);

    state.logProfitLoss('main', pnl);
    state.clearMainTrade();
    clearMainBoundary();
    sendMessage(`✅ MAIN ${trade.side} closed @ ${price} (PnL ${pnl})`);
  } catch (e) {
    sendMessage(`❌ Failed to close main: ${e.message || e}`);
  }
}

async function openHedgeTrade(side, price) {
  if (state.getHedgeTrade()) {
    sendMessage(`⚠️ Hedge already exists, skipping`);
    return;
  }
  if (Date.now() < state.getCooldown()) {
    sendMessage(`⚠️ Hedge cooldown active, skipping`);
    return;
  }

  try {
    await exchange.openHedgeTrade(side, config.entrySize);
    const breakthrough = computeBreakthrough(side, price);

    state.setHedgeTrade({ side, openPrice: price, breakthrough });
    state.setCooldown(Date.now() + config.cooldownMs);
    sendMessage(`✅ HEDGE ${side} opened @ ${price} (breakthrough ${breakthrough})`);
  } catch (e) {
    sendMessage(`❌ Failed to open hedge: ${e.message || e}`);
  }
}

async function closeHedgeTrade(price) {
  const trade = state.getHedgeTrade();
  if (!trade) return;

  try {
    await exchange.closeHedgeTrade(trade.side, config.entrySize);
    const pnl = (price - trade.openPrice) * (trade.side === 'Buy' ? 1 : -1);

    state.logProfitLoss('hedge', pnl);
    state.clearHedgeTrade();
    sendMessage(`✅ HEDGE ${trade.side} closed @ ${price} (PnL ${pnl})`);
  } catch (e) {
    sendMessage(`❌ Failed to close hedge: ${e.message || e}`);
  }
}

/**
 * ====================== CORE DECISION LOGIC ======================
 */
async function onMainBoundaryHit(currentPrice) {
  const main = state.getMainTrade();
  if (!main) return;

  const { side, breakthrough } = main;

  if (isBeyondBreakthrough(side, currentPrice, breakthrough)) {
    // Close main
    await closeMainTrade(currentPrice);

    // Transform hedge → main if hedge exists
    const hedge = state.getHedgeTrade();
    if (hedge) {
      state.setMainTrade({
        side: hedge.side,
        openPrice: hedge.openPrice,
        breakthrough: hedge.breakthrough
      });
      state.clearHedgeTrade();
      setMainBoundary(hedge.side, currentPrice);
      sendMessage(`🔄 Hedge transformed into MAIN ${hedge.side}`);
    }
  } else {
    // Otherwise, open opposite hedge
    const hedgeSide = side === 'Buy' ? 'Sell' : 'Buy';
    await openHedgeTrade(hedgeSide, currentPrice);
    sendMessage(`📉 Main boundary hit, opened HEDGE ${hedgeSide}`);
  }
}

async function maybeCloseHedgeOnSignal(signal, currentPrice) {
  if (!/STOP_LOSS|TAKE_PROFIT/.test(signal)) return;

  const hedge = state.getHedgeTrade();
  if (!hedge) return;

  if (isBeyondBreakthrough(hedge.side, currentPrice, hedge.breakthrough)) {
    await closeHedgeTrade(currentPrice);

    // Reset boundary for existing main
    const main = state.getMainTrade();
    if (main) {
      setMainBoundary(main.side, currentPrice);
      sendMessage(`🔄 Hedge closed → main boundary reset at ${currentPrice}`);
    }
  } else {
    sendMessage(`ℹ️ Hedge signal ignored, breakthrough not reached`);
  }
}

/**
 * ====================== SIGNAL HANDLER ======================
 */
async function handleSignal(signal, currentPrice) {
  state.setLastSignal(signal);
  state.setLastPrice(currentPrice);

  await maybeCloseHedgeOnSignal(signal, currentPrice);

  const main = state.getMainTrade();

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
}

/**
 * ====================== MONITOR LOOP ======================
 */
async function monitorPrice() {
  while (state.isRunning()) {
    try {
      const price = getCurrentPrice();
      if (!price) {
        await new Promise(r => setTimeout(r, 250));
        continue;
      }

      const signal = await analyze().catch(() => null);
      await handleSignal(signal, price);

      const main = state.getMainTrade();
      const boundary = state.getMainHedgeBoundary();

      if (main) {
        trailMainBoundary(main, price);

        if (boundary) {
          const hit =
            (main.side === 'Buy' && price <= boundary.boundary) ||
            (main.side === 'Sell' && price >= boundary.boundary);

          if (hit) await onMainBoundaryHit(price);
        }
      }

      await new Promise(r => setTimeout(r, config.pollInterval));
    } catch (err) {
      sendMessage(`⚠️ Monitor error: ${err?.message || err}`);
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

/**
 * ====================== LIFECYCLE ======================
 */
async function startBot() {
  startPolling(config.pollInterval);
  await waitForFirstPrice();
  state.startBot();
  monitorPrice();
  sendMessage('🤖 Bot started');
}

function stopBot() {
  stopPolling();
  state.stopBot();
  sendMessage('🛑 Bot stopped');
}

module.exports = {
  startBot,
  stopBot,
  monitorPrice
};
