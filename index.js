
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
const SCAN_DELAY = 150;

const STATE_DIR = ".signal-state";
const STATE_FILE = path.join(
  STATE_DIR,
  "sent-signals.json"
);

// ==================================================
// 2. NON-CRYPTO BLACKLIST
// ==================================================

// Editable denylist based on the non-crypto symbols
// found in your previous Bitget market list.
//
// This is not a universal crypto classification database.

const NON_CRYPTO_BASES = new Set([
  // Stocks / tokenized stocks
  "NVDA",
  "SNDK",
  "MSTR",
  "MU",
  "CRCL",
  "COIN",
  "AAOI",
  "GOOGL",
  "SKHYNIX",
  "NBIS",
  "BMNR",
  "ARM",
  "INTC",
  "HOOD",
  "AMZN",
  "AMD",
  "CRWV",
  "RKLB",
  "MSFT",
  "AVGO",
  "TSLA",
  "IREN",
  "OPENAI",
  "ANTHROPIC",
  "SHELL",

  // ETFs / leveraged ETFs
  "SOXL",
  "SOXS",
  "KORU",
  "QQQ",
  "SQQQ",
  "TQQQ",
  "MSTU",
  "NVDL",
  "SKHY",
  "SKDD",
  "INTW",
  "CSOPSK2LHKD",

  // Commodities / commodity-linked contracts
  "XAU",
  "XAG",
  "XAUT",
  "PAXG",
  "NATGAS",
  "CL",
  "BZ",

  // Other synthetic / non-crypto symbols
  "SPCX",
  "SNXX",
  "DRAM",
  "CBRS",
  "CAP",
  "ZCSH",
  "BTW"
]);

const STABLECOIN_BASES = new Set([
  "USDC",
  "USDE",
  "DAI",
  "FDUSD",
  "TUSD",
  "USDP",
  "PYUSD",
  "USDS",
  "USDT"
]);

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
    await sendTelegram(
      message.slice(i, i + maxLength)
    );
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
    const data = await fs.readFile(
      STATE_FILE,
      "utf8"
    );

    sentSignals = new Set(JSON.parse(data));

  } catch {
    sentSignals = new Set();
  }
}

async function saveSignalHistory() {
  await fs.mkdir(STATE_DIR, {
    recursive: true
  });

  await fs.writeFile(
    STATE_FILE,
    JSON.stringify([...sentSignals], null, 2)
  );
}

// ==================================================
// 5. LEVERAGED TOKEN FILTER
// ==================================================

function isLeveragedToken(base) {
  return /(?:\d+[LS]|[LS]\d+)$/i.test(base);
}

// ==================================================
// 6. GET TOP 100 CRYPTO USDT PERPETUAL COINS
// ==================================================

async function getBitgetCoins() {
  console.log("Loading Bitget markets...");

  await exchange.loadMarkets();

  const tickers = await exchange.fetchTickers();

  const coins = Object.values(exchange.markets)
    .filter(market => {

      const base = String(
        market.base || ""
      ).toUpperCase();

      // Only perpetual contracts
      if (market.swap !== true) return false;

      // Only linear contracts
      if (market.linear !== true) return false;

      // Only USDT quoted contracts
      if (market.quote !== "USDT") return false;

      // Only USDT settled contracts
      if (market.settle !== "USDT") return false;

      // Exclude inactive markets
      if (market.active === false) return false;

      // Exclude markets explicitly identified as stocks
      if (market.stock === true) return false;

      // Exclude known non-crypto assets
      if (NON_CRYPTO_BASES.has(base)) return false;

      // Exclude stablecoins
      if (STABLECOIN_BASES.has(base)) return false;

      // Exclude common leveraged token suffixes
      if (isLeveragedToken(base)) return false;

      return true;
    })
    .map(market => {

      const ticker = tickers[market.symbol];

      if (!ticker) return null;

      const last = Number(ticker.last);
      const quoteVolume = Number(ticker.quoteVolume);
      const baseVolume = Number(ticker.baseVolume);

      // Prefer actual 24H quote volume.
      // Fallback only when quoteVolume is unavailable.

      let volume24h = quoteVolume;

      if (
        !Number.isFinite(volume24h) ||
        volume24h <= 0
      ) {
        volume24h = baseVolume * last;
      }

      if (
        !Number.isFinite(volume24h) ||
        volume24h <= 0
      ) {
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
    .sort((a, b) => {
      return b.volume24h - a.volume24h;
    })
    .slice(0, MAX_COINS);

  console.log(
    `Selected ${coins.length} crypto candidates`
  );

  return coins;
}

// ==================================================
// 7. WILDER RSI CALCULATION
// ==================================================

function calculateRSI(values, period = 35) {
  if (values.length <= period) {
    return [];
  }

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

  function getValue(gain, loss) {

    if (gain === 0 && loss === 0) {
      return 50;
    }

    if (loss === 0) {
      return 100;
    }

    if (gain === 0) {
      return 0;
    }

    const rs = gain / loss;

    return 100 - (100 / (1 + rs));
  }

  result[period] = getValue(
    avgGain,
    avgLoss
  );

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {

    const change = values[i] - values[i - 1];

    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);

    avgGain =
      ((avgGain * (period - 1)) + gain) / period;

    avgLoss =
      ((avgLoss * (period - 1)) + loss) / period;

    result[i] = getValue(
      avgGain,
      avgLoss
    );
  }

  return result;
}

// ==================================================
// 8. RSI SMOOTHING
// ==================================================

function smoothRSI(values, smoothing = 3) {

  return values.map((value, index) => {

    if (value === null) {
      return null;
    }

    const start = Math.max(
      0,
      index - smoothing + 1
    );

    const window = values.slice(
      start,
      index + 1
    );

    if (window.some(v => v === null)) {
      return null;
    }

    return window.reduce(
      (sum, v) => sum + v,
      0
    ) / window.length;
  });
}

// ==================================================
// 9. RSI STATUS
// ==================================================

function getRSIStatus(rsi) {

  if (rsi <= BUY_LEVEL) {
    return "🟢 BUY ZONE";
  }

  if (rsi <= NEAR_BUY) {
    return "🟡 NEAR BUY";
  }

  if (rsi >= SELL_LEVEL) {
    return "🔴 SELL ZONE";
  }

  if (rsi >= NEAR_SELL) {
    return "🟠 NEAR SELL";
  }

  return "⚪ NEUTRAL";
}

// ==================================================
// 10. ANALYZE WEEKLY CANDLES
// ==================================================

async function analyzeCoin(coin) {

  try {

    const candles = await exchange.fetchOHLCV(
      coin.symbol,
      TIMEFRAME,
      undefined,
      CANDLE_LIMIT
    );

    if (
      !candles ||
      candles.length < RSI_LENGTH + 10
    ) {
      return {
        coin,
        error: true,
        status: "INSUFFICIENT DATA"
      };
    }

    // Remove current forming weekly candle.
    const completed = candles.slice(0, -1);

    if (
      completed.length < RSI_LENGTH + 5
    ) {
      return {
        coin,
        error: true,
        status: "INSUFFICIENT COMPLETED CANDLES"
      };
    }

    const closes = completed.map(
      candle => candle[4]
    );

    const rawRSI = calculateRSI(
      closes,
      RSI_LENGTH
    );

    const rsiValues = smoothRSI(
      rawRSI,
      RSI_SMOOTHING
    );

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
        error: true,
        status: "RSI NOT READY"
      };
    }

    // BUY:
    // Older RSI was higher than previous RSI.
    // Previous RSI is <= 30.
    // Current RSI turns upward and remains <= 30.

    const buySignal =
      olderRSI > previousRSI &&
      previousRSI <= BUY_LEVEL &&
      currentRSI > previousRSI &&
      currentRSI <= BUY_LEVEL;

    // SELL:
    // Older RSI was lower than previous RSI.
    // Previous RSI is >= 70.
    // Current RSI turns downward and remains >= 70.

    const sellSignal =
      olderRSI < previousRSI &&
      previousRSI >= SELL_LEVEL &&
      currentRSI < previousRSI &&
      currentRSI >= SELL_LEVEL;

    const candleDate = new Date(
      completed[last][0]
    ).toISOString().slice(0, 10);

    return {
      coin,
      currentRSI,
      previousRSI,
      olderRSI,
      buySignal,
      sellSignal,
      status: getRSIStatus(currentRSI),
      candleDate,
      error: false
    };

  } catch (error) {

    console.error(
      `Error scanning ${coin.symbol}:`,
      error.message
    );

    return {
      coin,
      error: true,
      status: "SCAN ERROR",
      errorMessage: error.message
    };
  }
}

// ==================================================
// 11. TELEGRAM TOP 100 LIST
// ==================================================

async function sendCoinList(coins) {

  let message =
    "📋 BITGET TOP CRYPTO USDT PERPETUAL\n";

  message += "━━━━━━━━━━━━━━━━━━━━\n";
  message += "Filter: Crypto candidates\n";
  message += "Ranking: 24H Quote Volume\n\n";

  for (let i = 0; i < coins.length; i++) {

    const coin = coins[i];

    message +=
      `${i + 1}. ${coin.base}/USDT` +
      ` | ${formatVolume(coin.volume24h)}\n`;
  }

  message += "\n━━━━━━━━━━━━━━━━━━━━\n";
  message += `Total selected: ${coins.length}`;

  await sendLongMessage(message);
}

// ==================================================
// 12. TELEGRAM RSI REPORT
// ==================================================

async function sendRSIReport(results) {

  const buyZone = results.filter(
    r => r.currentRSI <= BUY_LEVEL
  );

  const nearBuy = results.filter(
    r =>
      r.currentRSI > BUY_LEVEL &&
      r.currentRSI <= NEAR_BUY
  );

  const neutral = results.filter(
    r =>
      r.currentRSI > NEAR_BUY &&
      r.currentRSI < NEAR_SELL
  );

  const nearSell = results.filter(
    r =>
      r.currentRSI >= NEAR_SELL &&
      r.currentRSI < SELL_LEVEL
  );

  const sellZone = results.filter(
    r => r.currentRSI >= SELL_LEVEL
  );

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

    for (const r of list) {
      message +=
        `${r.coin.base}: ` +
        `${formatNumber(r.currentRSI)}\n`;
    }

    message += "\n";
  }

  addSection("🟢 BUY ZONE (RSI <= 30)", buyZone);
  addSection("🟡 NEAR BUY (30-35)", nearBuy);
  addSection("⚪ NEUTRAL (35-65)", neutral);
  addSection("🟠 NEAR SELL (65-70)", nearSell);
  addSection("🔴 SELL ZONE (RSI >= 70)", sellZone);

  message += "━━━━━━━━━━━━━━━━━━━━\n";
  message += `Valid RSI Results: ${results.length}\n`;

  await sendLongMessage(message);
}

// ==================================================
// 13. BUY / SELL ALERT
// ==================================================

async function sendSignal(result) {

  const type = result.buySignal
    ? "BUY"
    : "SELL";

  const key =
    `${result.coin.symbol}_${type}_${result.candleDate}`;

  if (sentSignals.has(key)) {
    return false;
  }

  let message = "";

  message += type === "BUY"
    ? "🟢 WEEKLY BUY REVERSAL SIGNAL\n"
    : "🔴 WEEKLY SELL REVERSAL SIGNAL\n";

  message += "━━━━━━━━━━━━━━━━━━━━\n";

  message += `Coin: ${result.coin.base}/USDT\n`;
  message += "Exchange: Bitget\n";
  message += "Market: USDT Perpetual\n";
  message += "Timeframe: 1W\n\n";

  message +=
    `Older RSI: ${formatNumber(result.olderRSI)}\n`;

  message +=
    `Previous RSI: ${formatNumber(result.previousRSI)}\n`;

  message +=
    `Current RSI: ${formatNumber(result.currentRSI)}\n\n`;

  message +=
    `Completed Candle: ${result.candleDate}\n`;

  message += "━━━━━━━━━━━━━━━━━━━━\n";
  message += "⚠️ Confirm before trading.";

  await sendTelegram(message);

  sentSignals.add(key);

  await saveSignalHistory();

  return true;
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

  await loadSignalHistory();

  const coins = await getBitgetCoins();

  if (coins.length === 0) {
    throw new Error(
      "No eligible crypto USDT perpetual markets found"
    );
  }

  await sendTelegram(
    "🚀 CRYPTO-ONLY WEEKLY RSI SCANNER STARTED\n" +
    "━━━━━━━━━━━━━━━━━━━━\n" +
    "Exchange: Bitget\n" +
    "Market: USDT Perpetual\n" +
    "Asset filter: Crypto candidates\n" +
    "Ranking: 24H Quote Volume\n" +
    `Coins: ${coins.length}\n` +
    "Timeframe: 1W\n" +
    `RSI Length: ${RSI_LENGTH}\n` +
    `RSI Smoothing: ${RSI_SMOOTHING}\n` +
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
      (
        result.error
          ? result.status
          : `RSI ${formatNumber(result.currentRSI)} ${result.status}`
      )
    );

    await delay(SCAN_DELAY);
  }

  await sendRSIReport(results);

  const duration = (
    (Date.now() - startTime) / 1000
  ).toFixed(1);

  const nearBuyCount = results.filter(
    r =>
      r.currentRSI > BUY_LEVEL &&
      r.currentRSI <= NEAR_BUY
  ).length;

  const nearSellCount = results.filter(
    r =>
      r.currentRSI >= NEAR_SELL &&
      r.currentRSI < SELL_LEVEL
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

  console.log("Scanner completed successfully.");
}

// ==================================================
// 15. START
// ==================================================

run()
  .catch(async error => {

    console.error("Scanner failed:", error);

    try {
      await sendTelegram(
        "❌ CRYPTO SCANNER FAILED\n" +
        error.message
      );
    } catch (telegramError) {
      console.error(
        "Telegram error:",
        telegramError.message
      );
    }

    process.exitCode = 1;
  });
