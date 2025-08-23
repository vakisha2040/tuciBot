const axios = require('axios');

// CONFIG
const SYMBOL = "BTCUSDT";
const INTERVAL = "3m";
const LIMIT = 20; // Fetch 20 candles
const TP_SL_DELTA = 300; // Take profit / Stop loss is ±300 from entry price

async function fetchCandles(symbol = SYMBOL) {
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${INTERVAL}&limit=${LIMIT}`;
  const res = await axios.get(url);
  return res.data.map(c => ({
    openTime: c[0],
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
    time: new Date(c[0]).toLocaleTimeString()
  }));
}

let currentPosition = null; // { type: 'LONG' | 'SHORT', entryPrice: number }
let stopLoss = null;
let takeProfit = null;

function getTradeSignal(candles) {
  if (!candles || candles.length < LIMIT) {
    console.log('Not enough candles!');
    return 'WAIT';
  }

  const last = candles[candles.length - 1];
  const highs20 = candles.slice(0, LIMIT - 1).map(c => c.high);
  const lows20 = candles.slice(0, LIMIT - 1).map(c => c.low);
  const high20 = Math.max(...highs20);
  const low20 = Math.min(...lows20);

  // Entry signals
  if (!currentPosition) {
    if (last.close >= high20) {
      currentPosition = { type: 'LONG', entryPrice: last.close };
      stopLoss = last.close - TP_SL_DELTA; // SL = entry - 300
      takeProfit = last.close + TP_SL_DELTA; // TP = entry + 300
      console.log(`📈 BUY at ${last.close} on ${last.time} | SL: ${stopLoss.toFixed(2)} | TP: ${takeProfit.toFixed(2)}`);
      return 'BUY';
    }
    if (last.close <= low20) {
      currentPosition = { type: 'SHORT', entryPrice: last.close };
      stopLoss = last.close + TP_SL_DELTA; // SL = entry + 300
      takeProfit = last.close - TP_SL_DELTA; // TP = entry - 300
      console.log(`📉 SELL at ${last.close} on ${last.time} | SL: ${stopLoss.toFixed(2)} | TP: ${takeProfit.toFixed(2)}`);
      return 'SELL';
    }
  }

  // Stop Loss & Take Profit
  if (currentPosition) {
    if (currentPosition.type === 'LONG') {
      if (last.close <= stopLoss) {
        console.log(`🛑 STOP LOSS hit for LONG at ${last.close} (${last.time})`);
        currentPosition = null;
        stopLoss = null;
        takeProfit = null;
        return 'STOP_LOSS_LONG';
      }
      if (last.close >= takeProfit) {
        console.log(`🎉 TAKE PROFIT hit for LONG at ${last.close} (${last.time})`);
        currentPosition = null;
        stopLoss = null;
        takeProfit = null;
        return 'TAKE_PROFIT_LONG';
      }
    } else if (currentPosition.type === 'SHORT') {
      if (last.close >= stopLoss) {
        console.log(`🛑 STOP LOSS hit for SHORT at ${last.close} (${last.time})`);
        currentPosition = null;
        stopLoss = null;
        takeProfit = null;
        return 'STOP_LOSS_SHORT';
      }
      if (last.close <= takeProfit) {
        console.log(`🎉 TAKE PROFIT hit for SHORT at ${last.close} (${last.time})`);
        currentPosition = null;
        stopLoss = null;
        takeProfit = null;
        return 'TAKE_PROFIT_SHORT';
      }
    }
  }

  return 'WAIT';
}

async function runBot() {
  const candles = await fetchCandles();
  const signal = getTradeSignal(candles);
  console.log(`[${new Date().toLocaleString()}] 🤖 Bot Signal: ${signal}`);
  return signal;
}

// Run every 2 seconds for demo; change to 300000 for 5min production
setInterval(async () => {
  try {
    await runBot();
  } catch (err) {
    console.error('❌ Error:', err.message);
  }
}, 2000);

module.exports = { runBot };
