
import ccxt from "ccxt";
import TelegramBot from "node-telegram-bot-api";
import fs from "fs/promises";
import path from "path";

// ==================================================
// 1. CONFIGURATION
// ==================================================

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

if (!TELEGRAM_TOKEN || !CHAT_ID) {
  throw new Error("Missing TELEGRAM_TOKEN or CHAT_ID");
}

const bot = new TelegramBot(TELEGRAM_TOKEN);

const exchange = new ccxt.bitget({
  enableRateLimit: true,
  timeout: 30000,
  options: {
    defaultType: "swap"
  }
});

const TIMEFRAME = "1w";

const RSI_LENGTH = 35;
const RSI_SMOOTHING = 3;
const RSI_AUTO_MA_MULTIPLIER = 1;

const BUY_LEVEL = 30;
const SELL_LEVEL = 70;

const NEAR_BUY = 35;
const NEAR_SELL = 65;

const MAX_COINS = 100;
const CANDLE_LIMIT = 300;
const SCAN_DELAY = 200;

const STATE_DIR = ".signal-state";
const STATE_FILE = path.join(
  STATE_DIR,
  "sent-signals.json"
);

// ==================================================
// 2. NON-CRYPTO BLACKLIST
// ==================================================

const NON_CRYPTO_BASES = new Set([
  // Stocks / tokenized stocks
  "NVDA", "SNDK", "MSTR", "MU", "CRCL", "COIN",
  "AAOI", "GOOGL", "SKHYNIX", "NBIS", "BMNR",
  "ARM", "INTC", "HOOD", "AMZN", "AMD", "CRWV",
  "RKLB", "MSFT", "AVGO", "TSLA", "IREN",
  "OPENAI", "ANTHROPIC", "SHELL",
  "TSM", "WDC", "DELL", "AXTI", "ZHONGJI",
  "PLTR", "ORCL", "CXMT", "SAMSUNG", "MRVL",
  "COHR", "MRNA", "AAPL", "MINIMAX",

  // ETFs / leveraged ETFs
  "SOXL", "SOXS", "KORU", "QQQ", "SQQQ",
  "TQQQ", "MSTU", "NVDL", "SKHY", "SKDD",
  "INTW", "CSOPSK2LHKD", "SPY", "EWY", "UVXY",
  "CSOPSS2LHKD",

  // Commodities
  "XAU", "XAG", "XAUT", "PAXG",
  "NATGAS", "CL", "BZ", "XPT",

  // Other identified non-crypto candidates
  "SPCX", "SNXX", "DRAM", "CBRS",
  "CAP", "ZCSH", "BTW", "STRC"
]);

const STABLECOIN_BASES = new Set([
  "USDC", "USDE", "DAI", "FDUSD",
  "TUSD", "USDP", "PYUSD", "USDS", "USDT"
]);

function isLeveragedToken(base) {
  return /(?:\d+[LS]|[LS]\d+)$/i.test(base);
}

// ==================================================
// 3. TELEGRAM HELPERS
// ==================================================

async function sendTelegram(message) {
  await bot.sendMessage(CHAT_ID, message, {
    disable_web_page_preview: true
  });
}

async function sendLongMessage(message) {
  const maxLength = 3500;

  for (let i = 0; i < message.length; i += maxLength) {
    await sendTelegram(message.slice(i, i + maxLength));
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatNumber(value) {
  return Number(value).toFixed(2);
}

function formatVolume(value) {
  return "$" + Number(value).toLocaleString("en-US", {
    maximumFractionDigits: 0
  });
}

// ==================================================
// 4. SIGNAL HISTORY
// ==================================================

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

// ==================================================
// 5. GET TOP CRYPTO USDT PERPETUAL PAIRS
// ==================================================

async function getBitgetCoins() {
  console.log("Loading Bitget markets...");

  await exchange.loadMarkets();

  const tickers = await exchange.fetchTickers();

  const coins = Object.values(exchange.markets)
    .filter(market => {
      const base = String(market.base || "").toUpperCase();

      if (market.swap !== true) return false;
      if (market.linear !== true) return false;
      if (market.quote !== "USDT") return false;
      if (market.settle !== "USDT") return false;
      if (market.active === false) return false;
      if (market.stock === true) return false;

      if (NON_CRYPTO_BASES.has(base)) return false;
      if (STABLECOIN_BASES.has(base)) return false;
      if (isLeveragedToken(base)) return false;

      return true;
    })
    .map(market => {
      const ticker = tickers[market.symbol];

      if (!ticker) return null;

      const last = Number(ticker.last);
      const quoteVolume = Number(ticker.quoteVolume);
      const baseVolume = Number(ticker.baseVolume);

      let volume24h = quoteVolume;

      if (!Number.isFinite(volume24h) || volume24h <= 0) {
        volume24h = baseVolume * last;
      }

      if (!Number.isFinite(volume24h) || volume24h <= 0) {
        return null;
      }

      return {
        symbol: market.symbol,
        base: market.base,
        quote: market.quote,
        volume24h,
        lastPrice: last
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.volume24h - a.volume24h)
    .slice(0, MAX_COINS);

  console.log(`Selected ${coins.length} pairs`);

  return coins;
}

// ==================================================
// 6. RSI CALCULATION
// ==================================================

function calculateRSI(values, period = 35) {
  if (values.length <= period) return [];

  const result = new Array(values.length).fill(null);

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change > 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  function getRSI(gain, loss) {
    if (gain === 0 && loss === 0) return 50;
    if (loss === 0) return 100;
    if (gain === 0) return 0;

    const rs = gain / loss;
    return 100 - (100 / (1 + rs));
  }

  result[period] = getRSI(avgGain, avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);

    avgGain =
      ((avgGain * (period - 1)) + gain) / period;

    avgLoss =
      ((avgLoss * (period - 1)) + loss) / period;

    result[i] = getRSI(avgGain, avgLoss);
  }

  return result;
}

// ==================================================
// 7. RSI SMOOTHING
// ==================================================

function smoothRSI(values, smoothing = 3) {
  return values.map((value, index) => {
    if (value === null) return null;

    const start = Math.max(0, index - smoothing + 1);
    const window = values.slice(start, index + 1);

    if (window.length !== smoothing) return null;
    if (window.some(v => !Number.isFinite(v))) return null;

    return window.reduce((sum, v) => sum + v, 0) / smoothing;
  });
}

// ==================================================
// 8. RSI STATUS
// ==================================================

function getRSIStatus(rsi) {
  if (rsi <= BUY_LEVEL) return "🟢 BUY ZONE";
  if (rsi <= NEAR_BUY) return "🟡 NEAR BUY";
  if (rsi >= SELL_LEVEL) return "🔴 SELL ZONE";
  if (rsi >= NEAR_SELL) return "🟠 NEAR SELL";

  return "⚪ NEUTRAL";
}

// ==================================================
// 9. ANALYZE COIN WITH ERROR DIAGNOSTICS
// ==================================================

async function analyzeCoin(coin) {
  try {
    console.log(`[FETCH] ${coin.symbol}`);

    const candles = await exchange.fetchOHLCV(
      coin.symbol,
      TIMEFRAME,
      undefined,
      CANDLE_LIMIT
    );

    if (!Array.isArray(candles)) {
      throw new Error("OHLCV response is not an array");
    }

    if (candles.length < RSI_LENGTH + 10) {
      throw new Error(
        `Insufficient candles: received ${candles.length}`
      );
    }

    // Exclude the currently forming weekly candle.
    const completed = candles.slice(0, -1);

    if (completed.length < RSI_LENGTH + 5) {
      throw new Error(
        `Insufficient completed candles: ${completed.length}`
      );
    }

    const closes = completed.map(candle => Number(candle[4]));

    if (closes.some(value => !Number.isFinite(value) || value <= 0)) {
      throw new Error("Invalid closing price in OHLCV data");
    }

    const rawRSI = calculateRSI(closes, RSI_LENGTH);

    if (!rawRSI.length) {
      throw new Error("RSI calculation returned empty array");
    }

    const rsiValues = smoothRSI(rawRSI, RSI_SMOOTHING);

    const last = rsiValues.length - 1;

    const currentRSI = rsiValues[last];
    const previousRSI = rsiValues[last - 1];
    const olderRSI = rsiValues[last - 2];

    if (
      !Number.isFinite(currentRSI) ||
      !Number.isFinite(previousRSI) ||
      !Number.isFinite(olderRSI)
    ) {
      throw new Error(
        `Invalid RSI values: current=${currentRSI}, previous=${previousRSI}, older=${olderRSI}`
      );
    }

    const buySignal =
      olderRSI > previousRSI &&
      previousRSI <= BUY_LEVEL &&
      currentRSI > previousRSI &&
      currentRSI <= BUY_LEVEL;

    const sellSignal =
      olderRSI < previousRSI &&
      previousRSI >= SELL_LEVEL &&
      currentRSI < previousRSI &&
      currentRSI >= SELL_LEVEL;

    const candleDate = new Date(
      completed[last][0]
    ).toISOString().slice(0, 10);

    console.log(
      `[SUCCESS] ${coin.symbol} RSI=${formatNumber(currentRSI)}`
    );

    return {
      coin,
      currentRSI,
      previousRSI,
      olderRSI,
      buySignal,
      sellSignal,
      status: getRSIStatus(currentRSI),
      candleDate,
      candleCount: candles.length,
      error: false
    };

  } catch (error) {
    const reason = `${error.name || "Error"}: ${error.message}`;

    console.error(`[SCAN ERROR] ${coin.symbol}: ${reason}`);

    return {
      coin,
      error: true,
      status: "SCAN ERROR",
      errorMessage: reason
    };
  }
}

// ==================================================
// 10. SEND TOP 100 COIN LIST
// ==================================================

async function sendCoinList(coins) {
  let message = "📋 BITGET TOP CRYPTO USDT PERPETUAL\n";
  message += "━━━━━━━━━━━━━━━━━━━━\n";
  message += "Filter: Crypto candidates\n";
  message += "Ranking: 24H Quote Volume\n\n";

  for (let i = 0; i < coins.length; i++) {
    const coin = coins[i];

    message +=
      `${i + 1}. ${coin.base}/USDT | ` +
      `${formatVolume(coin.volume24h)}\n`;
  }

  message += "\n━━━━━━━━━━━━━━━━━━━━\n";
  message += `Total selected: ${coins.length}`;

  await sendLongMessage(message);
}

// ==================================================
// 11. SEND RSI REPORT
// ==================================================

async function sendRSIReport(results) {
  const buyZone = results.filter(r => r.currentRSI <= BUY_LEVEL);

  const nearBuy = results.filter(
    r => r.currentRSI > BUY_LEVEL && r.currentRSI <= NEAR_BUY
  );

  const neutral = results.filter(
    r => r.currentRSI > NEAR_BUY && r.currentRSI < NEAR_SELL
  );

  const nearSell = results.filter(
    r => r.currentRSI >= NEAR_SELL && r.currentRSI < SELL_LEVEL
  );

  const sellZone = results.filter(r => r.currentRSI >= SELL_LEVEL);

  let message = "📊 WEEKLY CRYPTO RSI REPORT\n";
  message += "━━━━━━━━━━━━━━━━━━━━\n";
  message += "Exchange: Bitget\n";
  message += "Market: USDT Perpetual\n";
  message += "Timeframe: 1W\n";
  message += `RSI Length: ${RSI_LENGTH}\n`;
  message += `Smoothing: ${RSI_SMOOTHING}\n`;
  message += "Completed candles only\n\n";

  function addSection(title, list) {
    message += `${title}\n`;

    if (list.length === 0) {
      message += "No coins\n\n";
      return;
    }

    for (const item of list) {
      message +=
        `${item.coin.base}: ${formatNumber(item.currentRSI)}\n`;
    }

    message += "\n";
  }

  addSection("🟢 BUY ZONE (RSI <= 30)", buyZone);
  addSection("🟡 NEAR BUY (30-35)", nearBuy);
  addSection("⚪ NEUTRAL (35-65)", neutral);
  addSection("🟠 NEAR SELL (65-70)", nearSell);
  addSection("🔴 SELL ZONE (RSI >= 70)", sellZone);

  message += "━━━━━━━━━━━━━━━━━━━━\n";
  message += `Valid RSI Results: ${results.length}`;

  await sendLongMessage(message);
}

// ==================================================
// 12. SEND BUY / SELL ALERT
// ==================================================

async function sendSignal(result) {
  const type = result.buySignal ? "BUY" : "SELL";

  const key =
    `${result.coin.symbol}_${type}_${result.candleDate}`;

  if (sentSignals.has(key)) {
    return false;
  }

  let message = type === "BUY"
    ? "🟢 WEEKLY BUY REVERSAL SIGNAL\n"
    : "🔴 WEEKLY SELL REVERSAL SIGNAL\n";

  message += "━━━━━━━━━━━━━━━━━━━━\n";
  message += `Coin: ${result.coin.base}/USDT\n`;
  message += "Exchange: Bitget\n";
  message += "Market: USDT Perpetual\n";
  message += "Timeframe: 1W\n\n";

  message += `Older RSI: ${formatNumber(result.olderRSI)}\n`;
  message += `Previous RSI: ${formatNumber(result.previousRSI)}\n`;
  message += `Current RSI: ${formatNumber(result.currentRSI)}\n\n`;

  message += `Completed Candle: ${result.candleDate}\n`;
  message += "━━━━━━━━━━━━━━━━━━━━\n";
  message += "⚠️ Confirm before trading.";

  await sendTelegram(message);

  sentSignals.add(key);
  await saveSignalHistory();

  return true;
}

// ==================================================
// 13. ERROR DIAGNOSTICS
// ==================================================

async function sendErrorDiagnostics(errorDetails) {
  if (errorDetails.length === 0) return;

  const counts = {};

  for (const item of errorDetails) {
    counts[item.status] = (counts[item.status] || 0) + 1;
  }

  let message = "🔍 SCAN ERROR DIAGNOSTICS\n";
  message += "━━━━━━━━━━━━━━━━━━━━\n";
  message += "ERROR SUMMARY:\n";

  for (const [status, count] of Object.entries(counts)) {
    message += `${status}: ${count}\n`;
  }

  message += "\nFIRST 20 ERROR DETAILS:\n";

  for (const item of errorDetails.slice(0, 20)) {
    message += `\n${item.symbol}\n`;
    message += `${item.reason}\n`;
  }

  await sendLongMessage(message);
}

// ==================================================
// 14. MAIN SCANNER
// ==================================================

async function run() {
  const startTime = Date.now();

  let scanned = 0;
  let failed = 0;
  let buySignals = 0;
  let sellSignals = 0;

  const results = [];
  const errorDetails = [];

  await loadSignalHistory();

  const coins = await getBitgetCoins();

  if (coins.length === 0) {
    throw new Error("No eligible crypto USDT perpetual markets found");
  }

  await sendTelegram(
    "🚀 CRYPTO-ONLY WEEKLY RSI SCANNER STARTED\n" +
    "━━━━━━━━━━━━━━━━━━━━\n" +
    "Exchange: Bitget\n" +
    "Market: USDT Perpetual\n" +
    "Filter: Crypto candidates\n" +
    "Ranking: 24H Quote Volume\n" +
    `Coins: ${coins.length}\n` +
    "Timeframe: 1W\n" +
    `RSI Length: ${RSI_LENGTH}\n` +
    `RSI Smoothing: ${RSI_SMOOTHING}\n` +
    `Auto MA Multiplier setting: ${RSI_AUTO_MA_MULTIPLIER}\n` +
    "Completed weekly candles only."
  );

  await sendCoinList(coins);

  for (const coin of coins) {
    const result = await analyzeCoin(coin);

    scanned++;

    if (result.error) {
      failed++;

      errorDetails.push({
        symbol: coin.symbol,
        status: result.status,
        reason: result.errorMessage || result.status
      });

    } else {
      results.push(result);

      if (result.buySignal) {
        try {
          const sent = await sendSignal(result);
          if (sent) buySignals++;
        } catch (error) {
          console.error(
            `BUY Telegram alert failed for ${coin.symbol}:`,
            error.message
          );
        }
      }

      if (result.sellSignal) {
        try {
          const sent = await sendSignal(result);
          if (sent) sellSignals++;
        } catch (error) {
          console.error(
            `SELL Telegram alert failed for ${coin.symbol}:`,
            error.message
          );
        }
      }
    }

    console.log(
      `${scanned}/${coins.length} ${coin.symbol}: ` +
      (result.error
        ? result.errorMessage
        : `RSI ${formatNumber(result.currentRSI)} ${result.status}`)
    );

    await delay(SCAN_DELAY);
  }

  // Send error details before final report.
  await sendErrorDiagnostics(errorDetails);

  await sendRSIReport(results);

  const duration = (
    (Date.now() - startTime) / 1000
  ).toFixed(1);

  const nearBuyCount = results.filter(
    r => r.currentRSI > BUY_LEVEL && r.currentRSI <= NEAR_BUY
  ).length;

  const nearSellCount = results.filter(
    r => r.currentRSI >= NEAR_SELL && r.currentRSI < SELL_LEVEL
  ).length;

  await sendTelegram(
    "✅ CRYPTO WEEKLY SCAN COMPLETED\n" +
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

  console.log("Scanner completed.");
}

// ==================================================
// 15. START
// ==================================================

run().catch(async error => {
  console.error("Scanner failed:", error);

  try {
    await sendTelegram(
      "❌ CRYPTO SCANNER FAILED\n" +
      `${error.name}: ${error.message}`
    );
  } catch (telegramError) {
    console.error(
      "Telegram error:",
      telegramError.message
    );
  }

  process.exitCode = 1;
});
