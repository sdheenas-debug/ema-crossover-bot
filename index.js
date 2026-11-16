
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
const CANDLE_LIMIT = 100;
const MAX_CANDLE_PAGES = 5;
const MIN_COMPLETED_CANDLES = 45;

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

if (!TELEGRAM_TOKEN || !CHAT_ID) {
    throw new Error(
        "Missing TELEGRAM_TOKEN or CHAT_ID GitHub Secrets"
    );
}

// ==========================================
// EXCHANGE
// ==========================================

const bitget = new ccxt.bitget({
    enableRateLimit: true,
    timeout: 30000,
    options: {
        defaultType: "spot"
    }
});

const bot = new TelegramBot(TELEGRAM_TOKEN);

// ==========================================
// EXCLUSIONS
// ==========================================

const STABLECOIN_BASES = new Set([
    "USDT", "USDC", "BUSD", "DAI", "TUSD",
    "FDUSD", "USDE", "USDS", "USDD", "USDP",
    "PYUSD", "USDK", "UST", "USTC", "FRAX",
    "LUSD", "GUSD", "EURC", "EURS", "EURT",
    "XAUT", "PAXG"
]);

// Known traditional-asset and tokenized-asset symbols.
// This blacklist is not a complete crypto asset classifier.

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

function isAllowedSpotMarket(market) {
    const base = String(market.base || "").toUpperCase();

    if (market.spot !== true) return false;
    if (market.swap === true) return false;
    if (market.future === true) return false;
    if (market.option === true) return false;

    if (market.quote !== "USDT") return false;
    if (market.active === false) return false;

    if (!base) return false;

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
            {
                disable_web_page_preview: true
            }
        );
    }
}

// ==========================================
// SIGNAL HISTORY
// ==========================================

const STATE_DIR = ".signal-state";
const STATE_FILE = path.join(
    STATE_DIR,
    "sent-signals.json"
);

function loadSignalHistory() {
    try {
        if (!fs.existsSync(STATE_FILE)) {
            return {};
        }

        return JSON.parse(
            fs.readFileSync(STATE_FILE, "utf8")
        );
    } catch {
        return {};
    }
}

function saveSignalHistory(history) {
    fs.mkdirSync(STATE_DIR, {
        recursive: true
    });

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
        .filter(market => isAllowedSpotMarket(market))
        .map(market => {
            const base = String(
                market.base || ""
            ).toUpperCase();

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
        `Bitget Spot Top coins: ${coins.length}`
    );

    return coins;
}

// ==========================================
// BITGET SPOT MARKET VALIDATION
// ==========================================

async function validateBitgetMarkets(coins) {
    const validMarkets = new Map();

    for (const market of Object.values(bitget.markets)) {
        if (!isAllowedSpotMarket(market)) continue;

        const base = String(
            market.base || ""
        ).toUpperCase();

        if (market.symbol !== `${base}/USDT`) {
            continue;
        }

        if (!validMarkets.has(base)) {
            validMarkets.set(base, market.symbol);
        }
    }

    return coins.map(coin => ({
        ...coin,
        matched: validMarkets.has(coin.base),
        spotSymbol: validMarkets.get(coin.base) || null
    }));
}

// ==========================================
// CHEBYSHEV TYPE I FILTER
// ChartPrime formula
// ==========================================

function chebyshevGain(length, ripple = 0.5) {
    const a = Math.cosh(
        (1 / length) *
        Math.acosh(1 / (1 - ripple))
    );

    const b = Math.sinh(
        (1 / length) *
        Math.asinh(1 / ripple)
    );

    return (a - b) / (a + b);
}

function applyChebyshevFilter(
    values,
    length,
    ripple = 0.5
) {
    const g = chebyshevGain(length, ripple);

    const output = [];

    let previous = 0;

    for (const value of values) {
        if (!Number.isFinite(value)) {
            output.push(null);

            // Pine nz(previous[1]) behavior
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

function chartPrimeRSI(
    source,
    length,
    smoothing
) {
    // Filter original source
    const filteredSource = applyChebyshevFilter(
        source,
        smoothing,
        0.5
    );

    const up = [];
    const down = [];

    for (
        let i = 0;
        i < filteredSource.length;
        i++
    ) {
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
            filteredSource[i] -
            filteredSource[i - 1];

        up.push(Math.max(change, 0));

        down.push(Math.max(-change, 0));
    }

    // Filter upward movement
    const upFiltered = applyChebyshevFilter(
        up,
        length,
        0.5
    );

    // Filter downward movement
    const downFiltered = applyChebyshevFilter(
        down,
        length,
        0.5
    );

    const rsi = [];

    for (
        let i = 0;
        i < upFiltered.length;
        i++
    ) {
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
// FETCH BITGET WEEKLY CANDLES
// WITH PAGINATION
// ==========================================

async function getWeeklyCandles(symbol) {
    const initialSince =
        Date.now() -
        HISTORY_WEEKS * WEEK_MS;

    let cursor = initialSince;

    const candleMap = new Map();

    for (
        let page = 0;
        page < MAX_CANDLE_PAGES;
        page++
    ) {
        console.log(
            `${symbol}: Fetching weekly page ${page + 1}`
        );

        const batch = await bitget.fetchOHLCV(
            symbol,
            TIMEFRAME,
            cursor,
            CANDLE_LIMIT
        );

        if (!Array.isArray(batch) || batch.length === 0) {
            break;
        }

        let newestTimestamp = cursor - 1;

        for (const candle of batch) {
            if (!Array.isArray(candle) || candle.length < 6) {
                continue;
            }

            const timestamp = Number(candle[0]);

            if (!Number.isFinite(timestamp)) {
                continue;
            }

            newestTimestamp = Math.max(
                newestTimestamp,
                timestamp
            );

            const values = candle
                .slice(1, 6)
                .map(Number);

            if (!values.every(Number.isFinite)) {
                continue;
            }

            candleMap.set(timestamp, [
                timestamp,
                ...values
            ]);
        }

        // Stop if the API did not return newer candles
        if (newestTimestamp < cursor) {
            break;
        }

        const nextCursor =
            newestTimestamp + WEEK_MS;

        if (nextCursor <= cursor) {
            break;
        }

        cursor = nextCursor;

        // Reached the current period
        if (newestTimestamp + WEEK_MS > Date.now()) {
            break;
        }
    }

    const now = Date.now();

    const completed = [...candleMap.values()]
        .filter(candle => {
            // Weekly candle must be fully closed
            return candle[0] + WEEK_MS <= now;
        })
        .sort((a, b) => a[0] - b[0]);

    return completed;
}

// ==========================================
// REVERSAL SIGNAL DETECTION
// ==========================================

function detectReversal(rsiValues) {
    if (!Array.isArray(rsiValues)) {
        return null;
    }

    const values = rsiValues.filter(
        value => Number.isFinite(value)
    );

    if (values.length < 3) {
        return null;
    }

    const current =
        values[values.length - 1];

    const previous =
        values[values.length - 2];

    // BUY REVERSAL
    // RSI <= 30 and turns upward
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

        const lowest = Math.min(
            ...previousSegment
        );

        if (previous <= lowest + 1e-10) {
            return {
                type: "BUY",
                previous,
                current
            };
        }
    }

    // SELL REVERSAL
    // RSI >= 70 and turns downward
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

        const highest = Math.max(
            ...previousSegment
        );

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
// RSI ZONE
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
    return "$" + Number(value).toLocaleString(
        "en-US",
        {
            maximumFractionDigits: 0
        }
    );
}

function formatDate(timestamp) {
    return new Date(timestamp).toISOString().slice(0, 10);
}

// ==========================================
// SCAN ONE COIN
// ==========================================

async function scanCoin(coin) {
    if (!coin.matched || !coin.spotSymbol) {
        return {
            ...coin,
            valid: false,
            reason: "Bitget Spot pair unavailable"
        };
    }

    const candles = await getWeeklyCandles(
        coin.spotSymbol
    );

    if (candles.length < MIN_COMPLETED_CANDLES) {
        return {
            ...coin,
            valid: false,
            candles: candles.length,
            reason:
                `Insufficient completed weekly candles: ${candles.length}`
        };
    }

    const rsiData = calculateChartPrimeOHLC(
        candles
    );

    const rsi = rsiData.close;

    const currentRSI = rsi[rsi.length - 1];
    const previousRSI = rsi[rsi.length - 2];

    if (
        !Number.isFinite(currentRSI) ||
        !Number.isFinite(previousRSI)
    ) {
        return {
            ...coin,
            valid: false,
            reason: "Invalid ChartPrime RSI"
        };
    }

    const signal = detectReversal(rsi);

    const lastCandle =
        candles[candles.length - 1];

    return {
        ...coin,
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
// ZONE REPORT
// ==========================================

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

// ==========================================
// MAIN SCANNER
// ==========================================

async function main() {
    const startTime = Date.now();

    console.log(
        "Starting Bitget Spot ChartPrime RSI Scanner"
    );

    await sendTelegram(
        "🚀 BITGET SPOT RSI SCANNER STARTED\n\n" +
        "Exchange: Bitget Spot ONLY\n" +
        "Ranking: Top 100 by 24H USDT volume\n" +
        "Timeframe: Weekly (1W)\n" +
        "Indicator: ChartPrime RSI Primed calculation\n" +
        "Length: 35\n" +
        "Smoothing: 3\n" +
        "BUY: RSI <= 30 reversal upward\n" +
        "SELL: RSI >= 70 reversal downward\n" +
        "Candle: Completed weekly only\n" +
        "Futures: Disabled\n" +
        "Binance: Disabled"
    );

    const history = loadSignalHistory();

    // Step 1: Get Top 100
    const topCoins = await getBitgetTopCoins();

    // Step 2: Validate exact Spot BASE/USDT pairs
    const matchedCoins = await validateBitgetMarkets(
        topCoins
    );

    // Step 3: Scan coins
    const results = [];

    let errors = 0;

    for (
        let i = 0;
        i < matchedCoins.length;
        i++
    ) {
        const coin = matchedCoins[i];

        console.log(
            `[${i + 1}/${matchedCoins.length}] ${coin.base}`
        );

        try {
            const result = await scanCoin(coin);

            results.push(result);

        } catch (error) {
            errors++;

            console.error(
                `${coin.base}: ${error.message}`
            );

            results.push({
                ...coin,
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
        "Ranking: 24H USDT Volume",
        "RSI Source: Bitget Spot",
        "--------------------------------"
    ];

    results.forEach((result, index) => {
        const status = result.matched
            ? "MATCHED"
            : "UNMATCHED";

        const rsiText = result.valid
            ? `RSI ${formatNumber(result.rsi)}`
            : "RSI N/A";

        topReport.push(
            `#${index + 1} ${result.base} | ` +
            `${status} | ${rsiText} | ` +
            `${formatVolume(result.volume24h)}`
        );
    });

    await sendTelegram(
        topReport.join("\n")
    );

    // ======================================
    // RSI REPORT
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

        const message = [
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
            `Completed Candle: ${formatDate(result.candleTimestamp)}`,
            `24H Volume: ${formatVolume(result.volume24h)}`,
            "",
            "Exchange: Bitget Spot"
        ].join("\n");

        await sendTelegram(message);

        history[signalKey] = {
            base: result.base,
            type,
            candleTimestamp: result.candleTimestamp,
            sentAt: new Date().toISOString()
        };

        newSignals.push(result);
    }

    // ======================================
    // CLEAN OLD SIGNAL HISTORY
    // ======================================

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
        `Spot Matched: ${matched}`,
        `Spot Unmatched: ${unmatched}`,
        `Valid RSI Results: ${validResults.length}`,
        `Invalid RSI Results: ${invalid}`,
        `API / Scan Errors: ${errors}`,
        `Oversold: ${oversold.length}`,
        `Overbought: ${overbought.length}`,
        `New BUY/SELL Signals: ${newSignals.length}`,
        `Signal History: ${Object.keys(history).length}`,
        `Execution Time: ${elapsed} seconds`
    ].join("\n");

    await sendTelegram(diagnostics);

    console.log(diagnostics);

    console.log(
        "Bitget Spot scanner completed successfully."
    );
}

// ==========================================
// ERROR HANDLER
// ==========================================

main()
    .catch(async error => {
        console.error(
            "SCANNER FAILED:",
            error
        );

        try {
            await sendTelegram(
                "❌ BITGET SPOT RSI SCANNER FAILED\n\n" +
                String(
                    error.stack ||
                    error.message ||
                    error
                )
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
        } catch {
            // Ignore exchange shutdown errors
        }
    });
