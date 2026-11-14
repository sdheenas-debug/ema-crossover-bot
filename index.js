
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

// Bitget: Top 100 volume ranking
const bitget = new ccxt.bitget({
  enableRateLimit: true,
  timeout: 30000,
  options: {
    defaultType: "swap"
  }
});

// Binance USD-M Futures: historical RSI data
const binance = new ccxt.binanceusdm({
  enableRateLimit: true,
  timeout: 30000
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

// Request 120 weeks of weekly candles.
// 150 is the requested maximum count in this scanner.
const HISTORY_WEEKS = 120;
const CANDLE_LIMIT = 150;

const MIN_COMPLETED_CANDLES = 45;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const SCAN_DELAY = 200;

const STATE_DIR = ".signal-state";
const STATE_FILE = path.join(
  STATE_DIR,
  "sent-signals.json"
);

// ==================================================
// 2. NON-CRYPTO BLACKLIST
// ==================================================

// Denylist based on the non-crypto assets seen
// in your Bitget market list.
// Review newly listed assets before adding them.

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
  await fs.mkdir(STATE_DIR, {
    recursive: true
  });

  await fs.writeFile(
    STATE_FILE,
    JSON.stringify([...sentSignals], null, 2)
  );
}

// ==================================================
// 5. BITGET TOP 100 VOLUME RANKING
// ==================================================

async function getBitgetTopCoins() {
  console.log("Loading Bitget markets...");

  await bitget.loadMarkets();

  const tickers = await bitget.fetchTickers();

  const coins = Object.values(bitget.markets)
    .filter(market => {
      const base = String(
        market.base || ""
      ).toUpperCase();

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
        base,
        symbol: market.symbol,
        volume24h,
        lastPrice: last
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.volume24h - a.volume24h)
    .slice(0, MAX_COINS);

  console.log(
    `Bitget top candidates: ${coins.length}`
  );

  return coins;
}

// ==================================================
// 6. MATCH BINANCE USD-M FUTURES MARKETS
// ==================================================

async function matchBinanceMarkets(bitgetCoins) {
  console.log("Loading Binance USD-M Futures markets...");

  await binance.loadMarkets();

  const binanceMarkets = Object.values(binance.markets);

  const binanceByBase = new Map();

  for (const market of binanceMarkets) {
    if (market.swap !== true) continue;
    if (market.linear !== true) continue;
    if (market.quote !== "USDT") continue;
    if (market.settle !== "USDT") continue;
    if (market.active === false) continue;

    const base = String(
      market.base || ""
    ).toUpperCase();

    if (!binanceByBase.has(base)) {
      binanceByBase.set(base, market);
    }
  }

  const matched = [];
  const unmatched = [];

  for (const coin of bitgetCoins) {
    const binanceMarket = binanceByBase.get(
      coin.base.toUpperCase()
    );

    if (!binanceMarket) {
      unmatched.push(coin);
      continue;
    }

    matched.push({
      ...coin,
      binanceSymbol: binanceMarket.symbol
    });
  }

  console.log(
    `Binance matched: ${matched.length}`
  );

  console.log(
    `Binance unmatched: ${unmatched.length}`
  );

  return {
    matched,
    unmatched
  };
}

// ==================================================
// 7. FETCH BINANCE HISTORICAL WEEKLY CANDLES
// ==================================================

async function fetchBinanceWeeklyCandles(symbol) {
  const since =
    Date.now() -
    (HISTORY_WEEKS + 3) * WEEK_MS;

  const candles = await binance.fetchOHLCV(
    symbol,
    TIMEFRAME,
    since,
    CANDLE_LIMIT
  );

  if (!Array.isArray(candles)) {
    throw new Error("Invalid Binance OHLCV response");
  }

  // Validate and sort candle data.
  const validCandles = candles
    .filter(c =>
      Array.isArray(c) &&
      c.length >= 6 &&
      Number.isFinite(Number(c[0])) &&
      Number.isFinite(Number(c[4]))
    )
    .sort((a, b) => a[0] - b[0]);

  // Remove duplicate candle timestamps.
  const uniqueCandles = [
    ...new Map(
      validCandles.map(c => [c[0], c])
    ).values()
  ];

  // Keep only fully closed weekly candles.
  const now = Date.now();

  const completedCandles = uniqueCandles.filter(
    candle => candle[0] + WEEK_MS <= now
  );

  return {
    received: candles.length,
    unique: uniqueCandles.length,
    completed: completedCandles
  };
}

// ==================================================
// 8. WILDER RSI CALCULATION
// ==================================================

function calculateRSI(values, period = 35) {
  if (values.length <= period) {
    return [];
  }

  const result = new Array(
    values.length
  ).fill(null);

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
    if (gain === 0 && loss === 0) return 50;
    if (loss === 0) return 100;
    if (gain === 0) return 0;

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
// 9. RSI SMOOTHING
// ==================================================

function smoothRSI(values, smoothing = 3) {
  return values.map((value, index) => {
    if (!Number.isFinite(value)) {
      return null;
    }

    const start = index - smoothing + 1;

    if (start < 0) {
      return null;
    }

    const window = values.slice(
      start,
      index + 1
    );

    if (
      window.length !== smoothing ||
      window.some(v => !Number.isFinite(v))
    ) {
      return null;
    }

    return window.reduce(
      (sum, v) => sum + v,
      0
    ) / smoothing;
  });
}

// ==================================================
// 10. RSI STATUS
// ==================================================

function getRSIStatus(rsi) {
  if (rsi <= BUY_LEVEL) return "🟢 BUY ZONE";
  if (rsi <= NEAR_BUY) return "🟡 NEAR BUY";
  if (rsi >= SELL_LEVEL) return "🔴 SELL ZONE";
  if (rsi >= NEAR_SELL) return "🟠 NEAR SELL";

  return "⚪ NEUTRAL";
}

// ==================================================
// 11. ANALYZE COIN USING BINANCE DATA
// ==================================================

async function analyzeCoin(coin) {
  try {
    console.log(
      `[BINANCE FETCH] ${coin.binanceSymbol}`
    );

    const data = await fetchBinanceWeeklyCandles(
      coin.binanceSymbol
    );

    const completed = data.completed;

    if (
      completed.length <
      MIN_COMPLETED_CANDLES
    ) {
      throw new Error(
        `Insufficient Binance history. ` +
        `Received=${data.received}, ` +
        `Completed=${completed.length}, ` +
        `Required=${MIN_COMPLETED_CANDLES}`
      );
    }

    const closes = completed.map(
      candle => Number(candle[4])
    );

    if (
      closes.some(
        value =>
          !Number.isFinite(value) ||
          value <= 0
      )
    ) {
      throw new Error("Invalid Binance closing prices");
    }

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
      !Number.isFinite(currentRSI) ||
      !Number.isFinite(previousRSI) ||
      !Number.isFinite(olderRSI)
    ) {
      throw new Error(
        "RSI calculation returned invalid values"
      );
    }

    // BUY reversal:
    // RSI was falling, then turns upward inside BUY zone.

    const buySignal =
      olderRSI > previousRSI &&
      previousRSI <= BUY_LEVEL &&
      currentRSI > previousRSI &&
      currentRSI <= BUY_LEVEL;

    // SELL reversal:
    // RSI was rising, then turns downward inside SELL zone.

    const sellSignal =
      olderRSI < previousRSI &&
      previousRSI >= SELL_LEVEL &&
      currentRSI < previousRSI &&
      currentRSI >= SELL_LEVEL;

    const lastCompletedCandle =
      completed[completed.length - 1];

    const candleDate = new Date(
      lastCompletedCandle[0]
    ).toISOString().slice(0, 10);

    console.log(
      `[SUCCESS] ${coin.base} RSI=${formatNumber(currentRSI)}`
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
      candleCount: completed.length,
      error: false
    };

  } catch (error) {
    const reason =
      `${error.name || "Error"}: ${error.message}`;

    console.error(
      `[SCAN ERROR] ${coin.base}: ${reason}`
    );

    return {
      coin,
      error: true,
      status: "BINANCE SCAN ERROR",
      errorMessage: reason
    };
  }
}

// ==================================================
// 12. SEND BITGET TOP 100 LIST
// ==================================================

async function sendCoinList(coins, matched, unmatched) {
  const matchedBases = new Set(
    matched.map(c => c.base)
  );

  let message =
    "📋 BITGET TOP CRYPTO USDT PERPETUAL\n";

  message += "━━━━━━━━━━━━━━━━━━━━\n";
  message += "Ranking: Bitget 24H Quote Volume\n";
  message += "RSI Source: Binance USD-M Futures\n\n";

  for (let i = 0; i < coins.length; i++) {
    const coin = coins[i];

    const matchStatus = matchedBases.has(coin.base)
      ? "✅"
      : "❌";

    message +=
      `${i + 1}. ${coin.base}/USDT ` +
      `${matchStatus} | ${formatVolume(coin.volume24h)}\n`;
  }

  message += "\n━━━━━━━━━━━━━━━━━━━━\n";
  message += `Bitget Top Candidates: ${coins.length}\n`;
  message += `Binance Matched: ${matched.length}\n`;
  message += `Binance Unmatched: ${unmatched.length}\n`;

  await sendLongMessage(message);
}

// ==================================================
// 13. SEND RSI REPORT
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
  message += "Ranking Source: Bitget\n";
  message += "RSI Source: Binance USD-M Futures\n";
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
        `${item.coin.base}: ` +
        `${formatNumber(item.currentRSI)}\n`;
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
// 14. BUY / SELL TELEGRAM ALERT
// ==================================================

async function sendSignal(result) {
  const type = result.buySignal
    ? "BUY"
    : "SELL";

  const key =
    `${result.coin.base}_${type}_${result.candleDate}`;

  if (sentSignals.has(key)) {
    return false;
  }

  let message = type === "BUY"
    ? "🟢 WEEKLY BUY REVERSAL SIGNAL\n"
    : "🔴 WEEKLY SELL REVERSAL SIGNAL\n";

  message += "━━━━━━━━━━━━━━━━━━━━\n";

  message += `Coin: ${result.coin.base}/USDT\n`;
  message += `Bitget Ranking: ${formatVolume(result.coin.volume24h)}\n`;
  message += `RSI Exchange: Binance USD-M Futures\n`;
  message += `Binance Pair: ${result.coin.binanceSymbol}\n`;
  message += "Timeframe: 1W\n\n";

  message +=
    `Older RSI: ${formatNumber(result.olderRSI)}\n`;

  message +=
    `Previous RSI: ${formatNumber(result.previousRSI)}\n`;

  message +=
    `Current RSI: ${formatNumber(result.currentRSI)}\n\n`;

  message += `Completed Candle: ${result.candleDate}\n`;

  message += "━━━━━━━━━━━━━━━━━━━━\n";
  message += "⚠️ Confirm before trading.";

  await sendTelegram(message);

  sentSignals.add(key);
  await saveSignalHistory();

  return true;
}

// ==================================================
// 15. ERROR DIAGNOSTICS
// ==================================================

async function sendErrorDiagnostics(
  errorDetails,
  unmatched
) {
  if (
    errorDetails.length === 0 &&
    unmatched.length === 0
  ) {
    await sendTelegram(
      "✅ BINANCE DATA MATCH CHECK\n" +
      "All selected pairs matched and scanned successfully."
    );

    return;
  }

  const counts = {};

  for (const item of errorDetails) {
    counts[item.status] =
      (counts[item.status] || 0) + 1;
  }

  let message = "🔍 SCAN DIAGNOSTICS\n";
  message += "━━━━━━━━━━━━━━━━━━━━\n";

  message += "ERROR SUMMARY:\n";

  for (const [status, count] of Object.entries(counts)) {
    message += `${status}: ${count}\n`;
  }

  message += `\nBinance Unmatched Pairs: ${unmatched.length}\n`;

  if (unmatched.length > 0) {
    message += "\nUNMATCHED PAIRS:\n";

    for (const coin of unmatched.slice(0, 20)) {
      message += `${coin.base}/USDT\n`;
    }
  }

  if (errorDetails.length > 0) {
    message += "\nFIRST 20 SCAN ERRORS:\n";

    for (const item of errorDetails.slice(0, 20)) {
      message += `\n${item.symbol}\n`;
      message += `${item.reason}\n`;
    }
  }

  await sendLongMessage(message);
}

// ==================================================
// 16. MAIN SCANNER
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

  // Step 1: Get Bitget Top 100.
  const bitgetCoins = await getBitgetTopCoins();

  if (bitgetCoins.length === 0) {
    throw new Error("No Bitget USDT crypto candidates found");
  }

  // Step 2: Match Binance USD-M perpetual pairs.
  const {
    matched,
    unmatched
  } = await matchBinanceMarkets(bitgetCoins);

  await sendTelegram(
    "🚀 HYBRID WEEKLY RSI SCANNER STARTED\n" +
    "━━━━━━━━━━━━━━━━━━━━\n" +
    "Ranking Exchange: Bitget\n" +
    "RSI Data Exchange: Binance USD-M Futures\n" +
    "Market: USDT Perpetual\n" +
    `Bitget Candidates: ${bitgetCoins.length}\n` +
    `Binance Matched: ${matched.length}\n` +
    `Binance Unmatched: ${unmatched.length}\n` +
    "Timeframe: 1W\n" +
    `RSI Length: ${RSI_LENGTH}\n` +
    `RSI Smoothing: ${RSI_SMOOTHING}\n` +
    `Auto MA Multiplier setting: ${RSI_AUTO_MA_MULTIPLIER}\n` +
    "Completed weekly candles only."
  );

  // Show Bitget rankings and Binance match status.
  await sendCoinList(
    bitgetCoins,
    matched,
    unmatched
  );

  // Step 3: Scan only exact matching Binance markets.
  for (const coin of matched) {
    const result = await analyzeCoin(coin);

    scanned++;

    if (result.error) {
      failed++;

      errorDetails.push({
        symbol: coin.base + "/USDT",
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
            `BUY alert failed for ${coin.base}:`,
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
            `SELL alert failed for ${coin.base}:`,
            error.message
          );
        }
      }
    }

    console.log(
      `${scanned}/${matched.length} ${coin.base}: ` +
      (
        result.error
          ? result.errorMessage
          : `RSI ${formatNumber(result.currentRSI)} ${result.status}`
      )
    );

    await delay(SCAN_DELAY);
  }

  // Step 4: Diagnostics.
  await sendErrorDiagnostics(
    errorDetails,
    unmatched
  );

  // Step 5: RSI report.
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

  // Step 6: Final summary.
  await sendTelegram(
    "✅ HYBRID WEEKLY SCAN COMPLETED\n" +
    "━━━━━━━━━━━━━━━━━━━━\n" +
    `Bitget Candidates: ${bitgetCoins.length}\n` +
    `Binance Matched: ${matched.length}\n` +
    `Binance Unmatched: ${unmatched.length}\n` +
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

  console.log("Hybrid scanner completed.");
}

// ==================================================
// 17. START
// ==================================================

run().catch(async error => {
  console.error("Scanner failed:", error);

  try {
    await sendTelegram(
      "❌ HYBRID SCANNER FAILED\n" +
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
