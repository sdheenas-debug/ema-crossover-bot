
import ccxt from "ccxt";
import TelegramBot from "node-telegram-bot-api";
import fs from "fs/promises";
import path from "path";

// ==========================================
// CONFIGURATION
// ==========================================

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

if (!TELEGRAM_TOKEN || !CHAT_ID) {
  throw new Error("Missing TELEGRAM_TOKEN or CHAT_ID");
}

const bot = new TelegramBot(TELEGRAM_TOKEN);

const exchange = new ccxt.bitget({
  apiKey: process.env.BITGET_API_KEY || undefined,
  secret: process.env.BITGET_SECRET || undefined,
  password: process.env.BITGET_PASSWORD || undefined,
  enableRateLimit: true,
  options: {
    defaultType: "swap",
  },
});

const TIMEFRAME = "1w";

const RSI_LENGTH = 35;
const RSI_SMOOTHING = 3;
const RSI_AUTO_MA_MULTIPLIER = 1;

const BUY_LEVEL = 30;
const SELL_LEVEL = 70;

const MAX_COINS = 100;
const CANDLE_LIMIT = 300;
const SCAN_DELAY = 150;

const NEAR_BUY = 35;
const NEAR_SELL = 65;

const STATE_DIR = ".signal-state";
const STATE_FILE = path.join(STATE_DIR, "sent-signals.json");

// ==========================================
// TELEGRAM
// ==========================================

async function sendTelegram(message) {
  await bot.sendMessage(CHAT_ID, message, {
    disable_web_page_preview: true,
  });
}

async function sendLongMessage(message) {
  const maxLength = 3500;

  for (let i = 0; i < message.length; i += maxLength) {
    await sendTelegram(message.slice(i, i + maxLength));
  }
}

// ==========================================
// SIGNAL HISTORY
// ==========================================

let sentSignals = new Set();

async function loadSignalHistory() {
  try {
    const data = await fs.readFile(STATE_FILE, "utf8");
    sentSignals = new Set(JSON.parse(data));
  } catch {
    sentSignals = new Set();
  }
}

async function saveSignalHistory() {
  await fs.mkdir(STATE_DIR, { recursive: true });

  await fs.writeFile(
    STATE_FILE,
    JSON.stringify([...sentSignals], null, 2)
  );
}

// ==========================================
// UTILITIES
// ==========================================

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatNumber(value) {
  return Number(value).toFixed(2);
}

function getRSIStatus(rsi) {
  if (rsi <= BUY_LEVEL) return "🟢 BUY ZONE";
  if (rsi <= NEAR_BUY) return "🟡 NEAR BUY";
  if (rsi >= SELL_LEVEL) return "🔴 SELL ZONE";
  if (rsi >= NEAR_SELL) return "🟠 NEAR SELL";
  return "⚪ NEUTRAL";
}

// ==========================================
// RSI CALCULATION
// ==========================================

// Wilder RSI calculation
function calculateRSI(values, period = 35) {
  if (values.length <= period) return [];

  const result = new Array(values.length).fill(null);

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  function rsiValue(gain, loss) {
    if (loss === 0 && gain === 0) return 50;
    if (loss === 0) return 100;
    if (gain === 0) return 0;

    const rs = gain / loss;
    return 100 - (100 / (1 + rs));
  }

  result[period] = rsiValue(avgGain, avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);

    avgGain = ((avgGain * (period - 1)) + gain) / period;
    avgLoss = ((avgLoss * (period - 1)) + loss) / period;

    result[i] = rsiValue(avgGain, avgLoss);
  }

  return result;
}

// Simple smoothing of RSI values.
// This is a configurable approximation, not a verified
// implementation of the original ChartPrime Pine indicator.
function smoothRSI(values, smoothing = 3) {
  return values.map((value, index) => {
    if (value === null) return null;

    const start = Math.max(0, index - smoothing + 1);
    const window = values.slice(start, index + 1);

    if (window.some(v => v === null)) return null;

    return window.reduce((sum, v) => sum + v, 0) / window.length;
  });
}

// ==========================================
// GET TOP 100 BITGET COINS
// ==========================================

async function getBitgetCoins() {
  console.log("Loading Bitget markets...");

  await exchange.loadMarkets();

  const tickers = await exchange.fetchTickers();

  const stablecoins = new Set([
    "USDC",
    "USDE",
    "DAI",
    "FDUSD",
    "TUSD",
    "USDP",
    "PYUSD",
    "USDS",
  ]);

  const coins = Object.values(exchange.markets)
    .filter(market => {
      return (
        market.swap === true &&
        market.linear === true &&
        market.quote === "USDT" &&
        market.settle === "USDT" &&
        market.active !== false &&
        !stablecoins.has(market.base)
      );
    })
    .map(market => {
      const ticker = tickers[market.symbol];

      if (!ticker) return null;

      const volume =
        Number(ticker.quoteVolume) ||
        (Number(ticker.baseVolume) * Number(ticker.last));

      if (!Number.isFinite(volume) || volume <= 0) return null;

      return {
        symbol: market.symbol,
        base: market.base,
        volume,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, MAX_COINS);

  return coins;
}

// ==========================================
// RSI ANALYSIS
// ==========================================

async function analyzeCoin(coin) {
  try {
    const candles = await exchange.fetchOHLCV(
      coin.symbol,
      TIMEFRAME,
      undefined,
      CANDLE_LIMIT
    );

    if (!candles || candles.length < RSI_LENGTH + 10) {
      return {
        coin,
        status: "INSUFFICIENT DATA",
        error: true,
      };
    }

    // Exclude currently forming weekly candle.
    const completed = candles.slice(0, -1);

    if (completed.length < RSI_LENGTH + 5) {
      return {
        coin,
        status: "INSUFFICIENT DATA",
        error: true,
      };
    }

    const closes = completed.map(c => c[4]);

    const rawRSI = calculateRSI(closes, RSI_LENGTH);
    const rsiValues = smoothRSI(rawRSI, RSI_SMOOTHING);

    const last = rsiValues.length - 1;

    const currentRSI = rsiValues[last];
    const previousRSI = rsiValues[last - 1];
    const olderRSI = rsiValues[last - 2];

    if (
      currentRSI === null ||
      previousRSI === null ||
      olderRSI === null
    ) {
      return {
        coin,
        status: "RSI NOT READY",
        error: true,
      };
    }

    const buySignal =
      previousRSI <= BUY_LEVEL &&
      olderRSI > previousRSI &&
      currentRSI > previousRSI &&
      currentRSI <= BUY_LEVEL;

    const sellSignal =
      previousRSI >= SELL_LEVEL &&
      olderRSI < previousRSI &&
      currentRSI < previousRSI &&
      currentRSI >= SELL_LEVEL;

    return {
      coin,
      currentRSI,
      previousRSI,
      olderRSI,
      buySignal,
      sellSignal,
      status: getRSIStatus(currentRSI),
      candleDate: new Date(completed[last][0]).toISOString().slice(0, 10),
      error: false,
    };

  } catch (error) {
    console.error(`Error ${coin.symbol}:`, error.message);

    return {
      coin,
      status: "SCAN ERROR",
      error: true,
      errorMessage: error.message,
    };
  }
}

// ==========================================
// TELEGRAM: COIN LIST
// ==========================================

async function sendCoinList(coins) {
  let message = "📋 BITGET TOP 100 COINS\n";
  message += "━━━━━━━━━━━━━━━━━━━━\n";
  message += "Market: USDT Perpetual\n";
  message += "Ranking: 24H Volume\n\n";

  for (let i = 0; i < coins.length; i++) {
    message += `${i + 1}. ${coins[i].base}/USDT\n`;
  }

  await sendLongMessage(message);
}

// ==========================================
// TELEGRAM: RSI REPORT
// ==========================================

async function sendRSIReport(results) {
  const valid = results.filter(r => !r.error);

  const buyZone = valid.filter(r => r.currentRSI <= 30);
  const nearBuy = valid.filter(r => r.currentRSI > 30 && r.currentRSI <= 35);
  const neutral = valid.filter(r => r.currentRSI > 35 && r.currentRSI < 65);
  const nearSell = valid.filter(r => r.currentRSI >= 65 && r.currentRSI < 70);
  const sellZone = valid.filter(r => r.currentRSI >= 70);

  let message = "📊 WEEKLY RSI REPORT\n";
  message += "━━━━━━━━━━━━━━━━━━━━\n";
  message += "Exchange: Bitget\n";
  message += "Timeframe: 1W\n";
  message += `RSI: ${RSI_LENGTH}, Smooth: ${RSI_SMOOTHING}\n`;
  message += "Completed candles only\n\n";

  message += "🟢 BUY ZONE (RSI ≤ 30)\n";

  if (buyZone.length === 0) message += "No coins\n";

  for (const r of buyZone) {
    message += `${r.coin.base}: ${formatNumber(r.currentRSI)}\n`;
  }

  message += "\n🟡 NEAR BUY (30–35)\n";

  if (nearBuy.length === 0) message += "No coins\n";

  for (const r of nearBuy) {
    message += `${r.coin.base}: ${formatNumber(r.currentRSI)}\n`;
  }

  message += "\n⚪ NEUTRAL (35–65)\n";

  for (const r of neutral) {
    message += `${r.coin.base}: ${formatNumber(r.currentRSI)}\n`;
  }

  message += "\n🟠 NEAR SELL (65–70)\n";

  if (nearSell.length === 0) message += "No coins\n";

  for (const r of nearSell) {
    message += `${r.coin.base}: ${formatNumber(r.currentRSI)}\n`;
  }

  message += "\n🔴 SELL ZONE (RSI ≥ 70)\n";

  if (sellZone.length === 0) message += "No coins\n";

  for (const r of sellZone) {
    message += `${r.coin.base}: ${formatNumber(r.currentRSI)}\n`;
  }

  message += "\n━━━━━━━━━━━━━━━━━━━━\n";
  message += `Valid: ${valid.length}\n`;
  message += `Scan Errors: ${results.length - valid.length}\n`;

  await sendLongMessage(message);
}

// ==========================================
// TELEGRAM: BUY / SELL ALERTS
// ==========================================

async function sendSignal(result) {
  const type = result.buySignal ? "BUY" : "SELL";

  const key =
    `${result.coin.symbol}_${type}_${result.candleDate}`;

  if (sentSignals.has(key)) {
    return false;
  }

  let message = "";

  if (type === "BUY") {
    message += "🟢 WEEKLY BUY REVERSAL SIGNAL\n";
  } else {
    message += "🔴 WEEKLY SELL REVERSAL SIGNAL\n";
  }

  message += "━━━━━━━━━━━━━━━━━━━━\n";
  message += `Coin: ${result.coin.base}/USDT\n`;
  message += `Exchange: Bitget\n`;
  message += `Market: USDT Perpetual\n`;
  message += `Timeframe: ${TIMEFRAME}\n\n`;

  message += `Older RSI: ${formatNumber(result.olderRSI)}\n`;
  message += `Previous RSI: ${formatNumber(result.previousRSI)}\n`;
  message += `Current RSI: ${formatNumber(result.currentRSI)}\n\n`;

  message += `Completed candle: ${result.candleDate}\n`;
  message += "━━━━━━━━━━━━━━━━━━━━\n";
  message += "⚠️ Indicator confirmation required.";

  await sendTelegram(message);

  sentSignals.add(key);
  await saveSignalHistory();

  return true;
}

// ==========================================
// MAIN SCANNER
// ==========================================

async function run() {
  const startTime = Date.now();

  let scanned = 0;
  let failed = 0;
  let buySignals = 0;
  let sellSignals = 0;

  await loadSignalHistory();

  const coins = await getBitgetCoins();

  if (coins.length === 0) {
    throw new Error("No eligible Bitget USDT perpetual markets found");
  }

  await sendTelegram(
    "🚀 WEEKLY RSI SCANNER STARTED\n" +
    "━━━━━━━━━━━━━━━━━━━━\n" +
    `Exchange: Bitget\n` +
    `Market: USDT Perpetual\n` +
    `Timeframe: ${TIMEFRAME}\n` +
    `Coins: ${coins.length}\n` +
    `RSI Length: ${RSI_LENGTH}\n` +
    `Smoothing: ${RSI_SMOOTHING}\n` +
    `Auto MA Multiplier setting: ${RSI_AUTO_MA_MULTIPLIER}\n` +
    "Completed weekly candles only."
  );

  await sendCoinList(coins);

  const results = [];

  for (const coin of coins) {
    const result = await analyzeCoin(coin);

    scanned++;

    if (result.error) {
      failed++;
    } else {
      results.push(result);

      if (result.buySignal) {
        const sent = await sendSignal(result);
        if (sent) buySignals++;
      }

      if (result.sellSignal) {
        const sent = await sendSignal(result);
        if (sent) sellSignals++;
      }
    }

    console.log(
      `${scanned}/${coins.length} ${coin.symbol}: ` +
      (result.error
        ? result.status
        : `RSI ${formatNumber(result.currentRSI)} ${result.status}`)
    );

    await delay(SCAN_DELAY);
  }

  await sendRSIReport(results);

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  const nearBuyCount = results.filter(
    r => r.currentRSI > 30 && r.currentRSI <= 35
  ).length;

  const nearSellCount = results.filter(
    r => r.currentRSI >= 65 && r.currentRSI < 70
  ).length;

  await sendTelegram(
    "✅ WEEKLY SCAN COMPLETED\n" +
    "━━━━━━━━━━━━━━━━━━━━\n" +
    `Coins Selected: ${coins.length}\n` +
    `Coins Scanned: ${scanned}\n` +
    `Valid RSI Results: ${results.length}\n` +
    `Scan Errors: ${failed}\n\n` +
    `New BUY Signals: ${buySignals}\n` +
    `New SELL Signals: ${sellSignals}\n` +
    `Near BUY: ${nearBuyCount}\n` +
    `Near SELL: ${nearSellCount}\n\n` +
    `Scan Time: ${duration} seconds\n` +
    "Completed weekly candles only."
  );

  console.log("Scan completed.");
}

// ==========================================
// START
// ==========================================

run()
  .catch(async error => {
    console.error("Scanner failed:", error);

    try {
      await sendTelegram(
        "❌ SCANNER FAILED\n" + error.message
      );
    } catch (telegramError) {
      console.error("Telegram error:", telegramError.message);
    }

    process.exitCode = 1;
  });
