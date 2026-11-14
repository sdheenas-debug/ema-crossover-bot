
import ccxt from 'ccxt';
import TelegramBot from 'node-telegram-bot-api';
import fs from 'node:fs/promises';
import path from 'node:path';

// ======================================================
// ENV
// ======================================================

const token = process.env.TELEGRAM_TOKEN;
const chatId = process.env.CHAT_ID;

if (!token || !chatId) {
    throw new Error('TELEGRAM_TOKEN or CHAT_ID is missing');
}

// ======================================================
// TELEGRAM
// ======================================================

const bot = new TelegramBot(token);

// ======================================================
// BITGET
// ======================================================

const exchange = new ccxt.bitget({
    options: {
        defaultType: 'swap'
    },
    enableRateLimit: true,
    timeout: 30000
});

// ======================================================
// SETTINGS
// ======================================================

const TIMEFRAME = '1w';

const RSI_LENGTH = 35;
const RSI_SMOOTHING = 3;
const RSI_AUTO_MA_MULTIPLIER = 1;

const RSI_RIPPLE = 0.5;

const BUY_LEVEL = 30;
const SELL_LEVEL = 70;

const MAX_COINS = 100;
const CANDLE_LIMIT = 300;

const SCAN_DELAY = 150;

const STATE_DIR = '.signal-state';
const STATE_FILE = path.join(STATE_DIR, 'sent-signals.json');

// ======================================================
// DUPLICATE PROTECTION - PERSISTENT
// ======================================================

let sentSignals = new Set();

async function loadSignalHistory() {
    try {
        const data = await fs.readFile(STATE_FILE, 'utf8');
        const saved = JSON.parse(data);

        sentSignals = new Set(saved);

        console.log(`Previous signals loaded: ${sentSignals.size}`);

    } catch {
        sentSignals = new Set();
        console.log('No previous signal history found.');
    }
}

async function saveSignalHistory() {
    await fs.mkdir(STATE_DIR, { recursive: true });

    await fs.writeFile(
        STATE_FILE,
        JSON.stringify([...sentSignals]),
        'utf8'
    );
}

function signalKey(symbol, side, candleTimestamp) {
    return `${symbol}_${side}_${candleTimestamp}`;
}

// ======================================================
// SLEEP
// ======================================================

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ======================================================
// CHEBYSHEV TYPE I FILTER
// ======================================================

function cosh(x) {
    return (Math.exp(x) + Math.exp(-x)) / 2;
}

function sinh(x) {
    return (Math.exp(x) - Math.exp(-x)) / 2;
}

function acosh(x) {
    if (x < 1) return NaN;

    return Math.log(
        x + Math.sqrt(x * x - 1)
    );
}

function asinh(x) {
    return Math.log(
        x + Math.sqrt(x * x + 1)
    );
}

function calculateChebyshevI(
    values,
    length,
    ripple = 0.5
) {
    if (!values || !values.length || length <= 0) {
        return [];
    }

    const a = cosh(
        (1 / length) *
        acosh(1 / (1 - ripple))
    );

    const b = sinh(
        (1 / length) *
        asinh(1 / ripple)
    );

    const g = (a - b) / (a + b);

    const output = [];

    let previous = 0;

    for (const value of values) {

        const current =
            (1 - g) * value +
            g * previous;

        output.push(current);

        previous = current;
    }

    return output;
}

// ======================================================
// RSI PRIMED [CHARTPRIME]
// RSI CANDLE CALCULATION
// ======================================================

function calculateRSIPrimed(
    source,
    length = RSI_LENGTH,
    smoothing = RSI_SMOOTHING
) {
    if (
        !source ||
        source.length < length + smoothing + 5
    ) {
        return [];
    }

    // Filter source

    const filteredSource =
        calculateChebyshevI(
            source,
            smoothing,
            RSI_RIPPLE
        );

    // Price changes

    const changes = filteredSource.map(
        (value, index) => {

            if (index === 0) return 0;

            return value - filteredSource[index - 1];
        }
    );

    // Positive and negative changes

    const gains = changes.map(
        value => Math.max(value, 0)
    );

    const losses = changes.map(
        value => Math.max(-value, 0)
    );

    // Filter gains and losses

    const filteredGains =
        calculateChebyshevI(
            gains,
            length,
            RSI_RIPPLE
        );

    const filteredLosses =
        calculateChebyshevI(
            losses,
            length,
            RSI_RIPPLE
        );

    // RSI values

    const rsi = [];

    for (let i = 0; i < source.length; i++) {

        const up = filteredGains[i];
        const down = filteredLosses[i];

        let value;

        if (down === 0) {
            value = 100;
        } else {
            value = 100 - (
                100 / (1 + up / down)
            );
        }

        rsi.push(value);
    }

    return rsi;
}

// ======================================================
// GET TOP 100 BITGET USDT PERPETUAL COINS
// RANKING: 24H QUOTE VOLUME
// ======================================================

async function getBitgetCoins() {

    try {

        console.log('Loading Bitget markets...');

        await exchange.loadMarkets();

        const tickers =
            await exchange.fetchTickers();

        const stableCoins = new Set([
            'USDT',
            'USDC',
            'BUSD',
            'DAI',
            'TUSD',
            'FDUSD',
            'USDE',
            'USDS',
            'USD1',
            'USDD',
            'PYUSD',
            'USDP',
            'EUR',
            'EURC'
        ]);

        const coins = [];

        for (const symbol of Object.keys(exchange.markets)) {

            const market = exchange.markets[symbol];

            if (!market) continue;

            if (market.swap !== true) continue;

            if (market.linear !== true) continue;

            if (market.quote !== 'USDT') continue;

            if (market.settle !== 'USDT') continue;

            if (market.active === false) continue;

            if (stableCoins.has(market.base)) continue;

            const ticker = tickers[symbol];

            if (!ticker) continue;

            const volume = Number(ticker.quoteVolume);

            if (
                !Number.isFinite(volume) ||
                volume <= 0
            ) {
                continue;
            }

            coins.push({
                symbol,
                base: market.base,
                volume
            });
        }

        // Highest volume first

        coins.sort(
            (a, b) => b.volume - a.volume
        );

        const topCoins =
            coins.slice(0, MAX_COINS);

        console.log(
            `Eligible pairs: ${coins.length}`
        );

        console.log(
            `Selected pairs: ${topCoins.length}`
        );

        return topCoins;

    } catch (error) {

        console.error(
            'Market loading error:',
            error.message
        );

        return [];
    }
}

// ======================================================
// TELEGRAM - SEND ALL SCANNED COINS
// 25 COINS PER MESSAGE
// ======================================================

async function sendScannedCoins(coins) {

    const totalChunks =
        Math.ceil(coins.length / 25);

    for (
        let i = 0;
        i < coins.length;
        i += 25
    ) {

        const chunk =
            coins.slice(i, i + 25);

        const coinList = chunk.map(
            (coin, index) =>
                `${i + index + 1}. ${coin.symbol}`
        ).join('\n');

        const message = `
📊 BITGET SCANNED COINS

Market: USDT Perpetual
Timeframe: 1W

Total Coins: ${coins.length}

Message: ${Math.floor(i / 25) + 1}/${totalChunks}

━━━━━━━━━━━━━━━━━━━━

${coinList}

━━━━━━━━━━━━━━━━━━━━

Indicator: RSI Primed [ChartPrime]
Length: ${RSI_LENGTH}
Smoothing: ${RSI_SMOOTHING}

🟢 BUY: RSI 0–30
🔴 SELL: RSI 70–100
`;

        await bot.sendMessage(
            chatId,
            message,
            {
                disable_web_page_preview: true
            }
        );
    }
}

// ======================================================
// ANALYZE COIN
// ======================================================

async function analyzeCoin(coin) {

    const symbol = coin.symbol;

    try {

        // Fetch weekly candles

        const candles =
            await exchange.fetchOHLCV(
                symbol,
                TIMEFRAME,
                undefined,
                CANDLE_LIMIT
            );

        if (
            !candles ||
            candles.length < 100
        ) {
            return false;
        }

        // Last completed weekly candle

        const lastClosedIndex =
            candles.length - 2;

        const previousClosedIndex =
            candles.length - 3;

        // OHLC values

        const opens =
            candles.map(c => Number(c[1]));

        const highs =
            candles.map(c => Number(c[2]));

        const lows =
            candles.map(c => Number(c[3]));

        const closes =
            candles.map(c => Number(c[4]));

        const timestamps =
            candles.map(c => c[0]);

        if (
            [...opens, ...highs, ...lows, ...closes]
                .some(value => !Number.isFinite(value))
        ) {
            return false;
        }

        // RSI Primed Candle values

        const rsiOpen =
            calculateRSIPrimed(opens);

        const rsiHigh =
            calculateRSIPrimed(highs);

        const rsiLow =
            calculateRSIPrimed(lows);

        const rsiClose =
            calculateRSIPrimed(closes);

        if (
            !rsiOpen.length ||
            !rsiHigh.length ||
            !rsiLow.length ||
            !rsiClose.length
        ) {
            return false;
        }

        // Latest completed RSI candle

        const lastRSI =
            rsiClose[lastClosedIndex];

        const previousRSI =
            rsiClose[previousClosedIndex];

        const lastRSIOpen =
            rsiOpen[lastClosedIndex];

        const lastRSIHigh =
            rsiHigh[lastClosedIndex];

        const lastRSILow =
            rsiLow[lastClosedIndex];

        if (
            !Number.isFinite(lastRSI) ||
            !Number.isFinite(previousRSI)
        ) {
            return false;
        }

        // ==================================================
        // SIGNAL CONDITIONS
        // Alert when RSI ENTERS the zone
        // ==================================================

        const buySignal =
            previousRSI > BUY_LEVEL &&
            lastRSI <= BUY_LEVEL;

        const sellSignal =
            previousRSI < SELL_LEVEL &&
            lastRSI >= SELL_LEVEL;

        if (!buySignal && !sellSignal) {
            return false;
        }

        const side =
            buySignal ? 'BUY' : 'SELL';

        const emoji =
            buySignal ? '🟢' : '🔴';

        // ==================================================
        // PERSISTENT DUPLICATE PROTECTION
        // ==================================================

        const candleTimestamp =
            timestamps[lastClosedIndex];

        const key =
            signalKey(
                symbol,
                side,
                candleTimestamp
            );

        if (sentSignals.has(key)) {
            return false;
        }

        // ==================================================
        // COIN DETAILS
        // ==================================================

        const base = coin.base;

        const tradingViewUrl =
            `https://www.tradingview.com/chart/?symbol=BITGET:${base}USDT.P`;

        // ==================================================
        // TELEGRAM SIGNAL
        // ==================================================

        const message = `
${emoji} *RSI PRIMED ${side} SIGNAL*

━━━━━━━━━━━━━━━━━━━━

🪙 *Coin:* #${base}

🏦 *Exchange:* Bitget

⏰ *Timeframe:* WEEKLY (1W)

━━━━━━━━━━━━━━━━━━━━

📊 *INDICATOR SETTINGS*

RSI Primed [ChartPrime]

Style: Candle

Length: ${RSI_LENGTH}

Smoothing: ${RSI_SMOOTHING}

Auto MA Multiplier: ${RSI_AUTO_MA_MULTIPLIER}

━━━━━━━━━━━━━━━━━━━━

📈 *PREVIOUS CLOSED WEEK*

RSI Close:
${previousRSI.toFixed(4)}

━━━━━━━━━━━━━━━━━━━━

📈 *LATEST CLOSED WEEK*

RSI Open:
${lastRSIOpen.toFixed(4)}

RSI High:
${lastRSIHigh.toFixed(4)}

RSI Low:
${lastRSILow.toFixed(4)}

RSI Close:
${lastRSI.toFixed(4)}

━━━━━━━━━━━━━━━━━━━━

${emoji} *${side} CONDITION*

${
    side === 'BUY'
        ? 'Previous RSI > 30\nLatest RSI ≤ 30'
        : 'Previous RSI < 70\nLatest RSI ≥ 70'
}

━━━━━━━━━━━━━━━━━━━━

✅ Weekly candle CLOSED

✅ RSI Primed calculation

✅ Bitget USDT Perpetual

🔗 [Open TradingView Chart](${tradingViewUrl})
`;

        await bot.sendMessage(
            chatId,
            message,
            {
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            }
        );

        // Save only after successful Telegram delivery

        sentSignals.add(key);

        await saveSignalHistory();

        console.log(
            `SIGNAL: ${symbol} | ${side} | RSI ${lastRSI.toFixed(2)}`
        );

        return true;

    } catch (error) {

        console.error(
            `Analyze error ${symbol}:`,
            error.message
        );

        return false;
    }
}

// ======================================================
// MAIN SCANNER
// ======================================================

async function run() {

    const startTime = Date.now();

    let totalSignals = 0;
    let scanned = 0;
    let failed = 0;

    try {

        console.log('');
        console.log('==========================================');
        console.log('BITGET WEEKLY RSI PRIMED SCANNER');
        console.log('==========================================');

        // Load old signal history

        await loadSignalHistory();

        // Get top 100 coins

        const coins =
            await getBitgetCoins();

        if (!coins.length) {

            await bot.sendMessage(
                chatId,
                '⚠️ No eligible Bitget USDT perpetual pairs found.'
            );

            return;
        }

        // Send full coin list to Telegram

        await sendScannedCoins(coins);

        // Scanner started

        await bot.sendMessage(
            chatId,
            `🚀 *WEEKLY RSI PRIMED SCANNER STARTED*

━━━━━━━━━━━━━━━━━━━━

🏦 Exchange: Bitget

📊 Market: USDT Perpetual

⏰ Timeframe: 1W

🪙 Coins: ${coins.length}

━━━━━━━━━━━━━━━━━━━━

📈 RSI Primed [ChartPrime]

Length: 35

Smoothing: 3

Auto MA Multiplier: 1

━━━━━━━━━━━━━━━━━━━━

🟢 BUY: RSI enters 0–30

🔴 SELL: RSI enters 70–100

━━━━━━━━━━━━━━━━━━━━

Only completed weekly candles.`,
            {
                parse_mode: 'Markdown'
            }
        );

        // ==================================================
        // SCAN ALL COINS
        // ==================================================

        for (const coin of coins) {

            scanned++;

            console.log(
                `[${scanned}/${coins.length}] ${coin.symbol}`
            );

            try {

                const signalFound =
                    await analyzeCoin(coin);

                if (signalFound) {
                    totalSignals++;
                }

            } catch (error) {

                failed++;

                console.error(
                    `Scan failed: ${coin.symbol}`,
                    error.message
                );
            }

            await sleep(SCAN_DELAY);
        }

        // ==================================================
        // SCAN SUMMARY
        // ==================================================

        const duration =
            ((Date.now() - startTime) / 1000).toFixed(1);

        const summary = `
✅ *WEEKLY RSI PRIMED SCAN FINISHED*

━━━━━━━━━━━━━━━━━━━━

🏦 Exchange: Bitget

📊 Market: USDT Perpetual

⏰ Timeframe: 1W

🪙 Coins Selected: ${coins.length}

🔍 Coins Scanned: ${scanned}

⚠️ Failed: ${failed}

🎯 New Signals: ${totalSignals}

⏱️ Scan Time: ${duration}s

━━━━━━━━━━━━━━━━━━━━

📈 *RSI PRIMED SETTINGS*

Length: 35

Smoothing: 3

Auto MA Multiplier: 1

🟢 BUY: Enters 0–30

🔴 SELL: Enters 70–100

━━━━━━━━━━━━━━━━━━━━

✅ Completed weekly candles only.
`;

        await bot.sendMessage(
            chatId,
            summary,
            {
                parse_mode: 'Markdown'
            }
        );

        console.log('');
        console.log('==========================================');
        console.log('SCAN FINISHED');
        console.log(`Selected: ${coins.length}`);
        console.log(`Scanned: ${scanned}`);
        console.log(`Failed: ${failed}`);
        console.log(`Signals: ${totalSignals}`);
        console.log(`Duration: ${duration}s`);
        console.log('==========================================');

    } catch (error) {

        console.error('RUN ERROR:', error);

        try {

            await bot.sendMessage(
                chatId,
                `❌ *SCANNER ERROR*\n\n${error.message}`,
                {
                    parse_mode: 'Markdown'
                }
            );

        } catch (telegramError) {

            console.error(
                'Telegram error:',
                telegramError.message
            );
        }

        process.exitCode = 1;
    }
}

// ======================================================
// START - ONE SCAN PER GITHUB ACTION
// ======================================================

run();
