
import ccxt from 'ccxt';
import TelegramBot from 'node-telegram-bot-api';

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
// BITGET ONLY
// ======================================================

const exchange = new ccxt.bitget({
    options: {
        defaultType: 'swap'
    },
    enableRateLimit: true
});

// ======================================================
// RSI PRIMED SETTINGS - CHARTPRIME
// ======================================================

const TIMEFRAME = '1w';

const RSI_LENGTH = 35;
const RSI_SMOOTHING = 3;
const RSI_AUTO_MA_MULTIPLIER = 1;

const RSI_RIPPLE = 0.5;

const BUY_LEVEL = 30;
const SELL_LEVEL = 70;

const CANDLE_LIMIT = 300;

const MAX_COINS = 100;
const SCAN_DELAY = 150;

// ======================================================
// DUPLICATE PROTECTION
// ======================================================

const sentSignals = new Set();

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
// RSI PRIMED [CHARTPRIME]
// ======================================================

function cosh(x) {
    return (Math.exp(x) + Math.exp(-x)) / 2;
}

function sinh(x) {
    return (Math.exp(x) - Math.exp(-x)) / 2;
}

function acosh(x) {
    if (x < 1) return NaN;
    return Math.log(x + Math.sqrt(x * x - 1));
}

function asinh(x) {
    return Math.log(x + Math.sqrt(x * x + 1));
}

function calculateChebyshevI(
    values,
    length,
    ripple = 0.5
) {

    if (!values || !values.length) {
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
// RSI PRIMED CALCULATION
// ChartPrime RSI
// Length 35
// Smoothing 3
// ======================================================

function calculateRSIPrimed(
    source,
    length = RSI_LENGTH,
    smoothing = RSI_SMOOTHING
) {

    if (!source || source.length < length + smoothing + 5) {
        return [];
    }

    // STEP 1: Filter source

    const filteredSource =
        calculateChebyshevI(
            source,
            smoothing,
            RSI_RIPPLE
        );

    // STEP 2: Calculate changes

    const changes = filteredSource.map(
        (value, index) => {
            if (index === 0) return 0;

            return value - filteredSource[index - 1];
        }
    );

    // STEP 3: Positive and negative changes

    const gains = changes.map(
        value => Math.max(value, 0)
    );

    const losses = changes.map(
        value => Math.max(-value, 0)
    );

    // STEP 4: Chebyshev filtering

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

    // STEP 5: RSI calculation

    const rsi = [];

    for (let i = 0; i < source.length; i++) {

        const up = filteredGains[i];
        const down = filteredLosses[i];

        let value;

        if (down === 0) {
            value = 100;
        } else if (up === 0) {
            value = 0;
        } else {

            const rs = up / down;

            value = 100 - (100 / (1 + rs));
        }

        rsi.push(value);
    }

    return rsi;
}

// ======================================================
// GET TOP 100 BITGET USDT PERPETUALS
// RANKED BY 24H QUOTE VOLUME
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

            if (!Number.isFinite(volume) || volume <= 0) {
                continue;
            }

            coins.push({
                symbol,
                base: market.base,
                volume
            });
        }

        // Highest 24H volume first

        coins.sort((a, b) => b.volume - a.volume);

        const topCoins = coins.slice(0, MAX_COINS);

        console.log(
            `Top ${topCoins.length} Bitget USDT perpetuals loaded`
        );

        return topCoins;

    } catch (error) {

        console.error(
            'Market error:',
            error.message
        );

        return [];
    }
}

// ======================================================
// ANALYZE COIN
// WEEKLY RSI PRIMED
// ======================================================

async function analyzeCoin(coin) {

    const symbol = coin.symbol;

    try {

        // ==================================================
        // FETCH WEEKLY CANDLES
        // ==================================================

        const candles =
            await exchange.fetchOHLCV(
                symbol,
                TIMEFRAME,
                undefined,
                CANDLE_LIMIT
            );

        if (!candles || candles.length < 100) {
            return false;
        }

        // ==================================================
        // CLOSED CANDLE INDEX
        // ==================================================

        const lastClosedIndex = candles.length - 2;

        const previousClosedIndex = candles.length - 3;

        // ==================================================
        // OHLC DATA
        // ==================================================

        const opens = candles.map(c => Number(c[1]));
        const highs = candles.map(c => Number(c[2]));
        const lows = candles.map(c => Number(c[3]));
        const closes = candles.map(c => Number(c[4]));

        const timestamps = candles.map(c => c[0]);

        if (
            [...opens, ...highs, ...lows, ...closes]
                .some(value => !Number.isFinite(value))
        ) {
            return false;
        }

        // ==================================================
        // RSI PRIMED CANDLE CALCULATION
        // ==================================================

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

        // ==================================================
        // RSI CANDLE VALUES
        // STYLE: CANDLE
        // ==================================================

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
        // BUY CONDITION
        // RSI 0 TO 30
        // ==================================================

        const buySignal =
            lastRSI >= 0 &&
            lastRSI <= BUY_LEVEL;

        // ==================================================
        // SELL CONDITION
        // RSI 70 TO 100
        // ==================================================

        const sellSignal =
            lastRSI >= SELL_LEVEL &&
            lastRSI <= 100;

        if (!buySignal && !sellSignal) {
            return false;
        }

        // ==================================================
        // SIDE
        // ==================================================

        const side = buySignal ? 'BUY' : 'SELL';

        const emoji = buySignal ? '🟢' : '🔴';

        // ==================================================
        // DUPLICATE PROTECTION
        // ==================================================

        const candleTimestamp =
            timestamps[lastClosedIndex];

        const key = signalKey(
            symbol,
            side,
            candleTimestamp
        );

        if (sentSignals.has(key)) {
            return false;
        }

        sentSignals.add(key);

        if (sentSignals.size > 5000) {

            const first =
                sentSignals.values().next().value;

            sentSignals.delete(first);
        }

        // ==================================================
        // BASE COIN
        // ==================================================

        const base = coin.base;

        // ==================================================
        // TRADINGVIEW
        // ==================================================

        const tradingViewUrl =
            `https://www.tradingview.com/chart/?symbol=BITGET:${base}USDT.P`;

        // ==================================================
        // TELEGRAM MESSAGE
        // ==================================================

        const message = `
${emoji} *RSI PRIMED ${side} SIGNAL*
━━━━━━━━━━━━━━━━━━━━

🪙 *Coin:* #${base}

🏦 *Exchange:* Bitget

⏰ *Timeframe:* 1W

━━━━━━━━━━━━━━━━━━━━

📊 *INDICATOR SETTINGS*

*Indicator:* RSI Primed [ChartPrime]

*Style:* Candle

*Length:* ${RSI_LENGTH}

*Smoothing:* ${RSI_SMOOTHING}

*Auto MA Multiplier:* ${RSI_AUTO_MA_MULTIPLIER}

━━━━━━━━━━━━━━━━━━━━

📈 *PREVIOUS WEEK*

*RSI Close:*
${previousRSI.toFixed(4)}

━━━━━━━━━━━━━━━━━━━━

📈 *LATEST CLOSED WEEK*

*RSI Open:*
${lastRSIOpen.toFixed(4)}

*RSI High:*
${lastRSIHigh.toFixed(4)}

*RSI Low:*
${lastRSILow.toFixed(4)}

*RSI Close:*
${lastRSI.toFixed(4)}

━━━━━━━━━━━━━━━━━━━━

${emoji} *${side} CONDITION CONFIRMED*

${
    side === 'BUY'
        ? `RSI Primed Close: 0 – 30`
        : `RSI Primed Close: 70 – 100`
}

━━━━━━━━━━━━━━━━━━━━

✅ Weekly RSI Primed
✅ Candle Style
✅ Length 35
✅ Smoothing 3
✅ Completed Weekly Candle
✅ Bitget USDT Perpetual

━━━━━━━━━━━━━━━━━━━━

⚠️ Signal is based on the completed
weekly RSI candle.

🔗 [Open Bitget Chart](${tradingViewUrl})
`;

        // ==================================================
        // SEND TELEGRAM
        // ==================================================

        await bot.sendMessage(
            chatId,
            message,
            {
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            }
        );

        console.log('');
        console.log('==============================');
        console.log('RSI PRIMED SIGNAL');
        console.log(`Coin: ${symbol}`);
        console.log(`Side: ${side}`);
        console.log(`RSI: ${lastRSI.toFixed(4)}`);
        console.log('==============================');

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

    try {

        console.log('');
        console.log('==========================================');
        console.log('     BITGET WEEKLY RSI PRIMED SCANNER');
        console.log('==========================================');

        // ==================================================
        // TOP 100 COINS
        // ==================================================

        const coins = await getBitgetCoins();

        if (!coins.length) {

            await bot.sendMessage(
                chatId,
                '⚠️ No active Bitget USDT perpetuals found.'
            );

            return;
        }

        // ==================================================
        // TELEGRAM START
        // ==================================================

        await bot.sendMessage(
            chatId,
            `🚀 *BITGET WEEKLY RSI PRIMED SCANNER*

━━━━━━━━━━━━━━━━━━━━

🏦 Exchange:
*Bitget*

📊 Market:
*USDT Perpetual*

⏰ Timeframe:
*1 WEEK*

━━━━━━━━━━━━━━━━━━━━

📈 *INDICATOR*

*RSI Primed [ChartPrime]*

Style: Candle

Length: 35

Smoothing: 3

Auto MA Multiplier: 1

━━━━━━━━━━━━━━━━━━━━

🟢 *BUY*

RSI Close: 0 – 30

━━━━━━━━━━━━━━━━━━━━

🔴 *SELL*

RSI Close: 70 – 100

━━━━━━━━━━━━━━━━━━━━

🪙 Coins:
*${coins.length}*

📊 Ranking:
*24H Trading Volume*

━━━━━━━━━━━━━━━━━━━━

✅ Only completed weekly candles
✅ Duplicate signal protection
✅ Telegram alerts`,
            {
                parse_mode: 'Markdown'
            }
        );

        // ==================================================
        // SCAN
        // ==================================================

        let totalSignals = 0;

        let scanned = 0;

        for (const coin of coins) {

            scanned++;

            console.log(
                `[${scanned}/${coins.length}] ${coin.symbol}`
            );

            const signalFound =
                await analyzeCoin(coin);

            if (signalFound) {
                totalSignals++;
            }

            await sleep(SCAN_DELAY);
        }

        // ==================================================
        // DURATION
        // ==================================================

        const duration =
            ((Date.now() - startTime) / 1000).toFixed(1);

        // ==================================================
        // FINISHED
        // ==================================================

        await bot.sendMessage(
            chatId,
            `✅ *WEEKLY RSI PRIMED SCAN FINISHED*

━━━━━━━━━━━━━━━━━━━━

🏦 Exchange:
*Bitget*

🪙 Coins Scanned:
*${coins.length}*

🎯 Signals:
*${totalSignals}*

⏱️ Scan Time:
*${duration}s*

━━━━━━━━━━━━━━━━━━━━

📈 Strategy:

*RSI Primed [ChartPrime]*

Length: 35

Smoothing: 3

Timeframe: 1W

🟢 BUY: RSI 0–30

🔴 SELL: RSI 70–100

━━━━━━━━━━━━━━━━━━━━

✅ Completed weekly candles only`,
            {
                parse_mode: 'Markdown'
            }
        );

        console.log('');
        console.log('==========================================');
        console.log('WEEKLY SCAN FINISHED');
        console.log(`Coins: ${coins.length}`);
        console.log(`Signals: ${totalSignals}`);
        console.log(`Time: ${duration}s`);
        console.log('==========================================');

    } catch (error) {

        console.error('RUN ERROR:', error);

        try {

            await bot.sendMessage(
                chatId,
                `❌ *Scanner Error*\n\n${error.message}`,
                {
                    parse_mode: 'Markdown'
                }
            );

        } catch {}
    }
}

// ======================================================
// START
// ======================================================

run();
