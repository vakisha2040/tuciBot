const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'state.json');

// Default state structure for extended bot logic
let state = {
  botRunning: false,
  mainTrade: null,         // { side, openPrice, ... }
  hedgeTrade: null,        // { side, openPrice, ... }
  hedgeCloseBoundary: null,
  trailingBoundaries: [],  // Array of trailing boundary records
  lastSignal: null,        // Last signal processed
  lastPrice: null,         // Last price processed
  cooldownUntil: 0,
  profitLoss: [],          // Array of { type, amount, timestamp }
  // Add future fields here
};

// --- Persistence ---
function loadState() {
  try {
    const data = fs.readFileSync(STATE_FILE, 'utf-8');
    state = JSON.parse(data);
  } catch (err) {
    saveState(); // Write default state if file doesn't exist
  }
}
function saveState() {
  // Atomic write for safety
  const tmpFile = STATE_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2));
  fs.renameSync(tmpFile, STATE_FILE);
}

// Load state at startup
loadState();

// --- Bot control ---
function startBot() {
  state.botRunning = true;
  saveState();
}
function stopBot() {
  state.botRunning = false;
  saveState();
}
function isRunning() {
  return !!state.botRunning;
}

// --- Main Trade ---
function setMainTrade(trade) {
  state.mainTrade = trade;
  saveState();
}
function clearMainTrade() {
  state.mainTrade = null;
  saveState();
}
function getMainTrade() {
  return state.mainTrade;
}

// --- Hedge Trade ---
function setHedgeTrade(trade) {
  state.hedgeTrade = trade;
  saveState();
}
function clearHedgeTrade() {
  state.hedgeTrade = null;
  saveState();
}
function getHedgeTrade() {
  return state.hedgeTrade;
}

// --- Hedge Boundary ---
function setHedgeCloseBoundary(boundary) {
  state.hedgeCloseBoundary = boundary;
  saveState();
}
function getHedgeCloseBoundary() {
  return state.hedgeCloseBoundary;
}
function clearHedgeCloseBoundary() {
  state.hedgeCloseBoundary = null;
  saveState();
}

// --- Trailing Boundaries ---
function addTrailingBoundary(boundary) {
  state.trailingBoundaries.push(boundary);
  saveState();
}
function getTrailingBoundaries() {
  return state.trailingBoundaries || [];
}
function clearTrailingBoundaries() {
  state.trailingBoundaries = [];
  saveState();
}

// --- Signal & Price ---
function setLastSignal(signal) {
  state.lastSignal = signal;
  saveState();
}
function getLastSignal() {
  return state.lastSignal;
}
function setLastPrice(price) {
  state.lastPrice = price;
  saveState();
}
function getLastPrice() {
  return state.lastPrice;
}

// --- Cooldown ---
function setCooldown(seconds) {
  state.cooldownUntil = Date.now() + seconds * 1000;
  saveState();
}
function isCooldown() {
  return Date.now() < state.cooldownUntil;
}
function getCooldownUntil() {
  return state.cooldownUntil;
}

// --- Profit/Loss logging ---
function logProfitLoss(type, amount) {
  state.profitLoss.push({
    type,
    amount,
    timestamp: Date.now()
  });
  saveState();
}
function getProfitLossHistory() {
  return state.profitLoss || [];
}
function clearProfitLossHistory() {
  state.profitLoss = [];
  saveState();
}

// --- Bulk clear for full bot reset ---
function resetBotState() {
  state = {
    botRunning: false,
    mainTrade: null,
    hedgeTrade: null,
    hedgeCloseBoundary: null,
    trailingBoundaries: [],
    lastSignal: null,
    lastPrice: null,
    cooldownUntil: 0,
    profitLoss: [],
  };
  saveState();
}

// --- Exports ---
module.exports = {
  startBot,
  stopBot,
  isRunning,
  setMainTrade,
  clearMainTrade,
  getMainTrade,
  setHedgeTrade,
  clearHedgeTrade,
  getHedgeTrade,
  setHedgeCloseBoundary,
  getHedgeCloseBoundary,
  clearHedgeCloseBoundary,
  addTrailingBoundary,
  getTrailingBoundaries,
  clearTrailingBoundaries,
  setLastSignal,
  getLastSignal,
  setLastPrice,
  getLastPrice,
  setCooldown,
  isCooldown,
  getCooldownUntil,
  logProfitLoss,
  getProfitLossHistory,
  clearProfitLossHistory,
  saveState,
  loadState,
  resetBotState,
};
