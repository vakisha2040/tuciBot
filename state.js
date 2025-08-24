// state.js - cleaned up for hedge → main breakthrough system
const fs = require("fs");
const path = require("path");

const STATE_FILE = path.join(__dirname, "state.json");

let state = {
  running: false,
  mainTrade: null,              // { id, side, qty, openPrice, breakthroughPrice }
  hedgeTrade: null,             // { id, side, qty, openPrice, breakthroughPrice }
  mainHedgeBoundary: null,      // { side, boundary, price, timestamp }
  hedgeCloseBoundary: null,     // { side, boundary, price, timestamp }
  lastSignal: null,             // 'BUY' | 'SELL' | 'WAIT'
  lastPrice: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

// ---- persistence ----
function saveState() {
  state.updatedAt = Date.now();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      const raw = fs.readFileSync(STATE_FILE);
      state = JSON.parse(raw);
    } catch (e) {
      console.error("⚠️ Failed to load state.json, using defaults", e);
    }
  }
}

// ---- trade management ----
function setMainTrade(trade) {
  state.mainTrade = trade;
  saveState();
}
function getMainTrade() {
  return state.mainTrade;
}
function clearMainTrade() {
  state.mainTrade = null;
  saveState();
}

function setHedgeTrade(trade) {
  state.hedgeTrade = trade;
  saveState();
}
function getHedgeTrade() {
  return state.hedgeTrade;
}
function clearHedgeTrade() {
  state.hedgeTrade = null;
  saveState();
}

// ---- hedge boundaries ----
function setMainHedgeBoundary(boundary) {
  state.mainHedgeBoundary = boundary;
  saveState();
}
function getMainHedgeBoundary() {
  return state.mainHedgeBoundary;
}
function clearMainHedgeBoundary() {
  state.mainHedgeBoundary = null;
  saveState();
}

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

// ---- signals ----
function setLastSignal(signal, price) {
  state.lastSignal = signal;
  state.lastPrice = price;
  saveState();
}
function getLastSignal() {
  return { signal: state.lastSignal, price: state.lastPrice };
}

// ---- lifecycle ----
function setRunning(r) {
  state.running = r;
  saveState();
}
function isRunning() {
  return state.running;
}

// ---- reset ----
function resetState() {
  state = {
    running: false,
    mainTrade: null,
    hedgeTrade: null,
    mainHedgeBoundary: null,
    hedgeCloseBoundary: null,
    lastSignal: null,
    lastPrice: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  saveState();
}

// ---- init load ----
loadState();

module.exports = {
  getMainTrade,
  setMainTrade,
  clearMainTrade,
  getHedgeTrade,
  setHedgeTrade,
  clearHedgeTrade,
  getMainHedgeBoundary,
  setMainHedgeBoundary,
  clearMainHedgeBoundary,
  getHedgeCloseBoundary,
  setHedgeCloseBoundary,
  clearHedgeCloseBoundary,
  setLastSignal,
  getLastSignal,
  setRunning,
  isRunning,
  resetState,
};
