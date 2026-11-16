
import ccxt from "ccxt";
import TelegramBot from "node-telegram-bot-api";
import fs from "node:fs";
import path from "node:path";

// ==========================================
// CONFIGURATION
// ==========================================

const MAX_COINS = 100;

const TIMEFRAME = "1w";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const RSI_LENGTH = 35;
const RSI_SMOOTHING = 3;

const BUY_LEVEL = 30;
const SELL_LEVEL = 70;

const HISTORY_WEEKS = 180;
const CANDLE_LIMIT = 200;
const MIN_COMPLETED_CANDLES = 50;

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

if (!TELEGRAM_TOKEN || !CHAT_ID) {
    throw new Error("Missing TELEGRAM_TOKEN or CHAT_ID GitHub Secrets");
}

const bot = new TelegramBot(TELEGRAM_TOKEN);

const bitget = new ccxt.bitget({
    enableRateLimit: true,
    timeout: 30000,
    options: {
        defaultType: "spot"
    }
});

const binance = new ccxt.binance({
    enableRateLimit: true,
    timeout: 30000,
    options: {
        defaultType: "spot"
    }
});

// ==========================================
// EXCLUSIONS
// ==========================================

// Known stablecoin bases
const STABLECOIN_BASES = new Set([
    "USDT", "USDC", "BUSD", "DAI", "TUSD",
    "FDUSD", "USDE", "USDS", "USDD", "USDP",
    "PYUSD", "USDK", "UST", "USTC", "FRAX",
    "LUSD", "GUSD", "EURC", "EURS", "EURT",
    "XAUT", "PAXG"
]);

// Known non-crypto / tokenized traditional assets.
// This is a manual exclusion list, not a complete asset classifier.
const NON_CRYPTO_BASES = new Set([
    "SPY", "QQQ", "TSLA", "AAPL", "NVDA",
    "MSFT", "AMZN", "META", "GOOGL", "GOOG",
    "MSTR", "COIN", "PLTR", "AMD", "INTC",
    "ORCL", "IBM", "DELL", "WDC", "MU",
    "TSM", "MRVL", "SMCI", "BABA", "PDD",
    "NIO", "XPEV", "LI", "SAMSUNG", "EWY",
    "UVXY", "GLD", "SLV", "USO", "UNG",
    "XPT", "XPD", "XAG", "XAU"
]);

function isLeveragedToken(base) {
    return /(\d+[LS]|UP|DOWN|BULL|BEAR)$/i.test(base);
}

function isAllowedCryptoMarket(market) {
    const base = String(market.base || "").toUpperCase();

    if (market.spot !== true) return false;
    if (market.swap === true) return false;
    if (market.future === true) return false;
    if (market.option === true) return false;

    if (market.quote !== "USDT") return false;
    if (market.active === false) return false;

    if (STABLECOIN_BASES.has(base)) return false;
    if (NON_CRYPTO_BASES.has(base)) return false;
    if (isLeveragedToken(base)) return false;

    return true;
}

// ==========================================
// TELEGRAM
// ==========================================

async function sendTelegram(message) {
    const MAX_LENGTH = 3500;

    for (let i = 0; i < message.length; i += MAX_LENGTH) {
        await bot.sendMessage(
            CHAT_ID,
            message.slice(i, i + MAX_LENGTH),
            { disable_web_page_preview: true }
        );
    }
}

// ==========================================
// SIGNAL HISTORY
// ==========================================

const STATE_DIR = ".signal-state";
const STATE_FILE = path.join(STATE_DIR, "sent-signals.json");

function loadSignalHistory() {
    try {
        if (!fs.existsSync(STATE_FILE)) {
            return {};
        }

        return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    } catch {
        return {};
    }
}

function saveSignalHistory(history) {
    fs.mkdirSync(STATE_DIR, { recursive: true });

    fs.writeFileSync(
        STATE_FILE,
        JSON.stringify(history, null, 2)
    );
}

// ==========================================
// BITGET SPOT TOP 100
// ==========================================

async function getBitgetTopCoins() {
    console.log("Loading Bitget Spot markets...");

    await bitget.loadMarkets();

    const tickers = await bitget.fetchTickers();

    const coins = Object.values(bitget.markets)
        .filter(market => isAllowedCryptoMarket(market))
        .map(market => {
            // Define base inside map scope
            const base = String(market.base || "").toUpperCase();

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

    console.log(`Bitget Spot Top coins: ${coins.length}`);

    return coins;
}

// ==========================================
// BINANCE SPOT MATCHING
// ==========================================

async function getBinanceSpotMarkets() {
    console.log("Loading Binance Spot markets...");

    await binance.loadMarkets();

    const marketMap = new Map();

    for (const market of Object.values(binance.markets)) {
        if (market.spot !== true) continue;
        if (market.swap === true) continue;
        if (market.future === true) continue;
        if (market.option === true) continue;

        if (market.quote !== "USDT") continue;
        if (market.active === false) continue;

        const base = String(market.base || "").toUpperCase();

        if (!base) continue;

        // Only exact BASE/USDT spot pair
        if (market.symbol !== `${base}/USDT`) continue;

        if (!marketMap.has(base)) {
            marketMap.set(base, market.symbol);
        }
    }

    return marketMap;
}

// ==========================================
// CHEBYSHEV TYPE I FILTER
// ChartPrime calculation
// ==========================================

function chebyshevI(source, length, ripple = 0.5) {
    if (!Number.isFinite(length) || length <= 0) {
        throw new Error("Invalid Chebyshev length");
    }

    const a = Math.cosh(
        (1 / length) * Math.acosh(1 / (1 - ripple))
    );

    const b = Math.sinh(
        (1 / length) * Math.asinh(1 / ripple)
    );

    return (a - b) / (a + b);
}

function applyChebyshevFilter(values, length, ripple = 0.5) {
    const g = chebyshevI(length, length, ripple);
    const output = [];

    let previous = 0;

    for (const value of values) {
        if (!Number.isFinite(value)) {
            output.push(null);

            // Pine nz(previous[1]) becomes zero after na
            previous = 0;
            continue;
        }

        const current =
            (1 - g) * value +
            g * previous;

        output.push(current);
        previous = current;
    }

    return output;
}

// ==========================================
// CHARTPRIME RSI
// ==========================================

function chartPrimeRSI(source, length, smoothing) {
    // First filter the source
    const filteredSource = applyChebyshevFilter(
        source,
        smoothing,
        0.5
    );

    const up = [];
    const down = [];

    for (let i = 0; i < filteredSource.length; i++) {
        if (
            i === 0 ||
            filteredSource[i] === null ||
            filteredSource[i - 1] === null
        ) {
            up.push(null);
            down.push(null);
            continue;
        }

        const change =
            filteredSource[i] - filteredSource[i - 1];

        up.push(Math.max(change, 0));
        down.push(Math.max(-change, 0));
    }

    // Filter upward and downward movements
    const upFiltered = applyChebyshevFilter(
        up,
        length,
        0.5
    );

    const downFiltered = applyChebyshevFilter(
        down,
        length,
        0.5
    );

    const rsi = [];

    for (let i = 0; i < upFiltered.length; i++) {
        const u = upFiltered[i];
        const d = downFiltered[i];

        if (u === null || d === null) {
            rsi.push(null);
            continue;
        }

        if (d === 0) {
            rsi.push(100);
            continue;
        }

        const value =
            100 - (100 / (1 + u / d));

        rsi.push(
            Number.isFinite(value)
                ? value
                : null
        );
    }

    return rsi;
}

// ==========================================
// CHARTPRIME OHLC RSI
// ==========================================

function calculateChartPrimeOHLC(candles) {
    const open = candles.map(c => Number(c[1]));
    const high = candles.map(c => Number(c[2]));
    const low = candles.map(c => Number(c[3]));
    const close = candles.map(c => Number(c[4]));

    return {
        open: chartPrimeRSI(
            open,
            RSI_LENGTH,
            RSI_SMOOTHING
        ),

        high: chartPrimeRSI(
            high,
            RSI_LENGTH,
            RSI_SMOOTHING
        ),

        low: chartPrimeRSI(
            low,
            RSI_LENGTH,
            RSI_SMOOTHING
        ),

        close: chartPrimeRSI(
            close,
            RSI_LENGTH,
            RSI_SMOOTHING
        )
    };
}

// ==========================================
// BINANCE COMPLETED WEEKLY CANDLES
// ==========================================

async function getWeeklyCandles(symbol) {
    const since =
        Date.now() -
        HISTORY_WEEKS * WEEK_MS;

    const candles = await binance.fetchOHLCV(
        symbol,
        TIMEFRAME,
        since,
        CANDLE_LIMIT
    );

    if (!Array.isArray(candles)) {
        throw new Error("Invalid candle response");
    }

    const now = Date.now();

    const unique = new Map();

    for (const candle of candles) {
        if (!Array.isArray(candle) || candle.length < 6) {
            continue;
        }

        const timestamp = Number(candle[0]);

        if (!Number.isFinite(timestamp)) continue;

        // Exclude currently forming weekly candle
        if (timestamp + WEEK_MS > now) continue;

        const values = candle.slice(1, 6).map(Number);

        if (!values.every(Number.isFinite)) continue;

        unique.set(timestamp, [
            timestamp,
            ...values
        ]);
    }

    return [...unique.values()]
        .sort((a, b) => a[0] - b[0]);
}

// ==========================================
// REVERSAL SIGNAL DETECTION
// ==========================================

function detectReversal(rsiValues) {
    const values = rsiValues.filter(
        value => Number.isFinite(value)
    );

    if (values.length < 3) {
        return null;
    }

    const current = values[values.length - 1];
    const previous = values[values.length - 2];

    // BUY:
    // RSI is still <= 30 and turns upward.
    if (
        current <= BUY_LEVEL &&
        previous <= BUY_LEVEL &&
        current > previous
    ) {
        let segmentStart = values.length - 2;

        while (
            segmentStart > 0 &&
            values[segmentStart - 1] <= BUY_LEVEL
        ) {
            segmentStart--;
        }

        const previousSegment = values.slice(
            segmentStart,
            values.length - 1
        );

        const lowest = Math.min(...previousSegment);

        // Alert only on the first upward reversal
        // from the lowest point of the oversold segment.
        if (previous <= lowest + 1e-10) {
            return {
                type: "BUY",
                previous,
                current
            };
        }
    }

    // SELL:
    // RSI is still >= 70 and turns downward.
    if (
        current >= SELL_LEVEL &&
        previous >= SELL_LEVEL &&
        current < previous
    ) {
        let segmentStart = values.length - 2;

        while (
            segmentStart > 0 &&
            values[segmentStart - 1] >= SELL_LEVEL
        ) {
            segmentStart--;
        }

        const previousSegment = values.slice(
            segmentStart,
            values.length - 1
        );

        const highest = Math.max(...previousSegment);

        // Alert only on the first downward reversal
        // from the highest point of the overbought segment.
        if (previous >= highest - 1e-10) {
            return {
                type: "SELL",
                previous,
                current
            };
        }
    }

    return null;
}

// ==========================================
// RSI ZONES
// ==========================================

function getRSIZone(value) {
    if (value <= 30) return "OVERSOLD";
    if (value < 50) return "BEARISH";
    if (value < 70) return "BULLISH";
    return "OVERBOUGHT";
}

function formatNumber(value) {
    return Number(value).toFixed(2);
}

function formatVolume(value) {
    return "$" + Number(value).toLocaleString("en-US", {
        maximumFractionDigits: 0
    });
}

// ==========================================
// SCAN ONE COIN
// ==========================================

async function scanCoin(coin, binanceMarkets) {
    const binanceSymbol = binanceMarkets.get(coin.base);

    if (!binanceSymbol) {
        return {
            ...coin,
            matched: false,
            valid: false,
            reason: "No exact Binance Spot BASE/USDT pair"
        };
    }

    const candles = await getWeeklyCandles(binanceSymbol);

    if (candles.length < MIN_COMPLETED_CANDLES) {
        return {
            ...coin,
            matched: true,
            binanceSymbol,
            valid: false,
            reason: `Insufficient completed candles: ${candles.length}`
        };
    }

    const rsiData = calculateChartPrimeOHLC(candles);

    const rsi = rsiData.close;
    const currentRSI = rsi[rsi.length - 1];

    if (!Number.isFinite(currentRSI)) {
        return {
            ...coin,
            matched: true,
            binanceSymbol,
            valid: false,
            reason: "Invalid ChartPrime RSI"
        };
    }

    const previousRSI = rsi[rsi.length - 2];

    const signal = detectReversal(rsi);

    const lastCandle = candles[candles.length - 1];

    return {
        ...coin,
        matched: true,
        binanceSymbol,
        valid: true,
        candles: candles.length,
        rsi: currentRSI,
        previousRSI,
        zone: getRSIZone(currentRSI),
        candleTimestamp: lastCandle[0],
        signal
    };
}

// ==========================================
// MAIN SCANNER
// ==========================================

async function main() {
    const startTime = Date.now();

    console.log("Starting Bitget Spot + Binance Spot scanner");

    await sendTelegram(
        "🚀 SPOT RSI SCANNER STARTED\n\n" +
        "Ranking: Bitget Spot Top 100\n" +
        "RSI Data: Binance Spot\n" +
        "Timeframe: Weekly (1W)\n" +
        "RSI: ChartPrime Primed\n" +
        "Length: 35\n" +
        "Smoothing: 3\n" +
        "BUY: Oversold reversal <= 30\n" +
        "SELL: Overbought reversal >= 70\n" +
        "Candle: Completed weekly only"
    );

    const history = loadSignalHistory();

    const topCoins = await getBitgetTopCoins();

    const binanceMarkets = await getBinanceSpotMarkets();

    const results = [];

    let errors = 0;

    for (let i = 0; i < topCoins.length; i++) {
        const coin = topCoins[i];

        console.log(
            `[${i + 1}/${topCoins.length}] ${coin.base}`
        );

        try {
            const result = await scanCoin(
                coin,
                binanceMarkets
            );

            results.push(result);

        } catch (error) {
            errors++;

            console.error(
                `${coin.base}: ${error.message}`
            );

            results.push({
                ...coin,
                matched: binanceMarkets.has(coin.base),
                valid: false,
                reason: error.message
            });
        }
    }

    // ======================================
    // TOP 100 REPORT
    // ======================================

    const topReport = [
        "📊 BITGET SPOT TOP 100",
        "Ranking: 24H Quote Volume",
        "RSI Source: Binance Spot",
        "--------------------------------"
    ];

    for (const result of results) {
        const status = result.matched
            ? "MATCHED"
            : "UNMATCHED";

        const rsiText = result.valid
            ? `RSI ${formatNumber(result.rsi)}`
            : "RSI N/A";

        topReport.push(
            `#${results.indexOf(result) + 1} ${result.base} | ` +
            `${status} | ${rsiText} | ` +
            `${formatVolume(result.volume24h)}`
        );
    }

    await sendTelegram(topReport.join("\n"));

    // ======================================
    // RSI ZONE REPORT
    // ======================================

    const validResults = results.filter(
        result => result.valid
    );

    const oversold = validResults.filter(
        result => result.rsi <= 30
    );

    const bearish = validResults.filter(
        result => result.rsi > 30 && result.rsi < 50
    );

    const bullish = validResults.filter(
        result => result.rsi >= 50 && result.rsi < 70
    );

    const overbought = validResults.filter(
        result => result.rsi >= 70
    );

    function zoneText(title, coins) {
        const lines = [
            `${title} (${coins.length})`
        ];

        for (const coin of coins) {
            lines.push(
                `${coin.base}: ${formatNumber(coin.rsi)}`
            );
        }

        return lines.join("\n");
    }

    const zoneReport = [
        "📈 CHARTPRIME RSI REPORT",
        `Length: ${RSI_LENGTH}`,
        `Smoothing: ${RSI_SMOOTHING}`,
        "Timeframe: 1W",
        "--------------------------------",
        zoneText("🔴 OVERSOLD <= 30", oversold),
        "",
        zoneText("🟠 BEARISH 30-50", bearish),
        "",
        zoneText("🟢 BULLISH 50-70", bullish),
        "",
        zoneText("🔵 OVERBOUGHT >= 70", overbought)
    ].join("\n");

    await sendTelegram(zoneReport);

    // ======================================
    // BUY / SELL ALERTS
    // ======================================

    const newSignals = [];

    for (const result of validResults) {
        if (!result.signal) continue;

        const type = result.signal.type;

        const signalKey =
            `${result.base}_${type}_${result.candleTimestamp}`;

        if (history[signalKey]) continue;

        const signalMessage = [
            type === "BUY"
                ? "🟢 CHARTPRIME BUY REVERSAL"
                : "🔴 CHARTPRIME SELL REVERSAL",
            "",
            `Coin: ${result.base}/USDT`,
            `Bitget Rank: #${results.indexOf(result) + 1}`,
            `RSI Previous: ${formatNumber(result.signal.previous)}`,
            `RSI Current: ${formatNumber(result.signal.current)}`,
            `RSI Length: ${RSI_LENGTH}`,
            `Smoothing: ${RSI_SMOOTHING}`,
            "Timeframe: 1W",
            `Completed Candle: ${new Date(result.candleTimestamp).toISOString()}`,
            `Bitget Volume: ${formatVolume(result.volume24h)}`,
            "",
            "Data: Binance Spot",
            "Ranking: Bitget Spot"
        ].join("\n");

        await sendTelegram(signalMessage);

        history[signalKey] = {
            base: result.base,
            type,
            candleTimestamp: result.candleTimestamp,
            sentAt: new Date().toISOString()
        };

        newSignals.push(result);
    }

    // Keep state file compact
    const historyKeys = Object.keys(history);

    if (historyKeys.length > 5000) {
        const sorted = historyKeys.sort(
            (a, b) =>
                new Date(history[a].sentAt).getTime() -
                new Date(history[b].sentAt).getTime()
        );

        for (const key of sorted.slice(0, 1000)) {
            delete history[key];
        }
    }

    saveSignalHistory(history);

    // ======================================
    // DIAGNOSTICS
    // ======================================

    const matched = results.filter(
        result => result.matched
    ).length;

    const unmatched = results.length - matched;

    const invalid = results.filter(
        result => result.matched && !result.valid
    ).length;

    const elapsed = (
        (Date.now() - startTime) / 1000
    ).toFixed(1);

    const diagnostics = [
        "🔍 SCANNER DIAGNOSTICS",
        "--------------------------------",
        `Bitget Top Coins: ${topCoins.length}`,
        `Binance Matched: ${matched}`,
        `Binance Unmatched: ${unmatched}`,
        `Valid RSI Results: ${validResults.length}`,
        `Invalid RSI Results: ${invalid}`,
        `API / Scan Errors: ${errors}`,
        `Oversold: ${oversold.length}`,
        `Overbought: ${overbought.length}`,
        `New BUY/SELL Signals: ${newSignals.length}`,
        `Total Signal History: ${Object.keys(history).length}`,
        `Execution Time: ${elapsed} seconds`
    ].join("\n");

    await sendTelegram(diagnostics);

    console.log(diagnostics);

    console.log("Scanner completed successfully.");
}

// ==========================================
// ERROR HANDLER
// ==========================================

main()
    .catch(async error => {
        console.error("SCANNER FAILED:", error);

        try {
            await sendTelegram(
                "❌ SPOT RSI SCANNER FAILED\n\n" +
                String(error.stack || error.message || error)
            );
        } catch (telegramError) {
            console.error(
                "Telegram error:",
                telegramError.message
            );
        }

        process.exitCode = 1;
    })
    .finally(async () => {
        try {
            await bitget.close();
            await binance.close();
        } catch {
            // Ignore exchange shutdown errors
        }
    });
