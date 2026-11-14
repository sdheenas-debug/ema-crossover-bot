
import ccxt from 'ccxt';
import TelegramBot from 'node-telegram-bot-api';
import fs from 'node:fs/promises';
import path from 'node:path';

// ======================================================
// ENVIRONMENT
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
// BITGET EXCHANGE
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

// ======================================================
// SIGNAL HISTORY
// ======================================================

const STATE_DIR = '.signal-state';

const STATE_FILE = path.join(
    STATE_DIR,
    'sent-signals.json'
);

let sentSignals = new Set();

// ======================================================
// LOAD PREVIOUS SIGNALS
// ======================================================

async function loadSignalHistory() {

    try {

        const data = await fs.readFile(
            STATE_FILE,
            'utf8'
        );

        const saved = JSON.parse(data);

        sentSignals = new Set(saved);

        console.log(
            `Previous signals loaded: ${sentSignals.size}`
        );

    } catch {

        sentSignals = new Set();

        console.log(
            'No previous signal history found.'
        );
    }
}

// ======================================================
// SAVE SIGNAL HISTORY
// ======================================================

async function saveSignalHistory() {

    await fs.mkdir(
        STATE_DIR,
        { recursive: true }
    );

    await fs.writeFile(
        STATE_FILE,
        JSON.stringify([...sentSignals]),
        'utf8'
    );
}

// ======================================================
// DUPLICATE PROTECTION
// ======================================================

function signalKey(
    symbol,
    side,
    candleTimestamp
) {

    return `${symbol}_${side}_${candleTimestamp}`;
}

// ======================================================
// SLEEP
// ======================================================

function sleep(ms) {

    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

// ======================================================
// CHEBYSHEV TYPE I FILTER
// ======================================================

function cosh(x) {

    return (
        Math.exp(x) +
        Math.exp(-x)
    ) / 2;
}

function sinh(x) {

    return (
        Math.exp(x) -
        Math.exp(-x)
    ) / 2;
}

function acosh(x) {

    if (x < 1) {
        return NaN;
    }

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

    if (
        !values ||
        !values.length ||
        length <= 0
    ) {
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

    const g =
        (a - b) / (a + b);

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
// RSI PRIMED CHARTPRIME CALCULATION
// ======================================================

function calculateRSIPrimed(
    source,
    length = RSI_LENGTH,
    smoothing = RSI_SMOOTHING
) {

    if (
        !source ||
        source.length <
        length + smoothing + 5
    ) {
        return [];
    }

    // STEP 1: Smooth source

    const filteredSource =
        calculateChebyshevI(
            source,
            smoothing,
            RSI_RIPPLE
        );

    // STEP 2: Price changes

    const changes =
        filteredSource.map(
            (value, index) => {

                if (index === 0) {
                    return 0;
                }

                return (
                    value -
                    filteredSource[index - 1]
                );
            }
        );

    // STEP 3: Gains

    const gains =
        changes.map(
            value => Math.max(value, 0)
        );

    // STEP 4: Losses

    const losses =
        changes.map(
            value => Math.max(-value, 0)
        );

    // STEP 5: Filter gains

    const filteredGains =
        calculateChebyshevI(
            gains,
            length,
            RSI_RIPPLE
        );

    // STEP 6: Filter losses

    const filteredLosses =
        calculateChebyshevI(
            losses,
            length,
            RSI_RIPPLE
        );

    // STEP 7: RSI

    const rsi = [];

    for (
        let i = 0;
        i < source.length;
        i++
    ) {

        const up = filteredGains[i];

        const down = filteredLosses[i];

        let value;

        if (down === 0) {

            value = 100;

        } else {

            value =
                100 -
                (
                    100 /
                    (1 + up / down)
                );
        }

        rsi.push(value);
    }

    return rsi;
}

// ======================================================
// GET TOP 100 BITGET USDT PERPETUAL COINS
// SORT BY 24H QUOTE VOLUME
// ======================================================

async function getBitgetCoins() {

    try {

        console.log(
            'Loading Bitget markets...'
        );

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

        for (
            const symbol of Object.keys(
                exchange.markets
            )
        ) {

            const market =
                exchange.markets[symbol];

            if (!market) continue;

            // Perpetual only

            if (market.swap !== true) {
                continue;
            }

            // Linear contract only

            if (market.linear !== true) {
                continue;
            }

            // USDT quote

            if (market.quote !== 'USDT') {
                continue;
            }

            // USDT settlement

            if (market.settle !== 'USDT') {
                continue;
            }

            // Active market

            if (market.active === false) {
                continue;
            }

            // Exclude stablecoins

            if (stableCoins.has(market.base)) {
                continue;
            }

            const ticker = tickers[symbol];

            if (!ticker) continue;

            let volume =
                Number(ticker.quoteVolume);

            if (
                !Number.isFinite(volume) ||
                volume <= 0
            ) {

                const baseVolume =
                    Number(ticker.baseVolume);

                const lastPrice =
                    Number(ticker.last);

                volume =
                    baseVolume * lastPrice;
            }

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

        // Highest 24H volume first

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
            'Market error:',
            error.message
        );

        return [];
    }
}

// ======================================================
// TELEGRAM - SCANNED COINS LIST
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

        const coinList =
            chunk.map(
                (coin, index) =>
                    `${i + index + 1}. ${coin.symbol}`
            ).join('\n');

        const message = `
📊 BITGET SCANNED COINS

🏦 Market: USDT Perpetual

⏰ Timeframe: 1W

🪙 Total Coins: ${coins.length}

📋 List: ${Math.floor(i / 25) + 1}/${totalChunks}

━━━━━━━━━━━━━━━━━━━━

${coinList}

━━━━━━━━━━━━━━━━━━━━

📈 RSI Primed [ChartPrime]

Length: 35
Smoothing: 3
Auto MA Multiplier: 1

🟢 BUY: RSI reversal from 0–30

🔴 SELL: RSI reversal from 70–100
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
// WEEKLY RSI REVERSAL
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

        if (
            !candles ||
            candles.length < 100
        ) {
            return false;
        }

        // ==================================================
        // CLOSED CANDLE INDEXES
        // ==================================================

        const lastClosedIndex =
            candles.length - 2;

        const previousClosedIndex =
            candles.length - 3;

        const olderClosedIndex =
            candles.length - 4;

        // ==================================================
        // OHLC DATA
        // ==================================================

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
                .some(
                    value => !Number.isFinite(value)
                )
        ) {
            return false;
        }

        // ==================================================
        // RSI PRIMED CANDLE
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
        // RSI VALUES - THREE CLOSED WEEKS
        // ==================================================

        const olderRSI =
            rsiClose[olderClosedIndex];

        const previousRSI =
            rsiClose[previousClosedIndex];

        const currentRSI =
            rsiClose[lastClosedIndex];

        // Latest RSI candle OHLC

        const currentRSIOpen =
            rsiOpen[lastClosedIndex];

        const currentRSIHigh =
            rsiHigh[lastClosedIndex];

        const currentRSILow =
            rsiLow[lastClosedIndex];

        if (
            ![
                olderRSI,
                previousRSI,
                currentRSI,
                currentRSIOpen,
                currentRSIHigh,
                currentRSILow
            ].every(Number.isFinite)
        ) {
            return false;
        }

        // ==================================================
        // BUY CONDITION
        //
        // Example:
        // 35 -> 30 -> 25 -> 20 -> 10 -> 12
        //
        // Previous RSI must be <= 30
        // Previous RSI must be falling
        // Current RSI must turn upward
        // Current RSI must remain <= 30
        // ==================================================

        const buySignal =

            previousRSI <= BUY_LEVEL &&

            olderRSI > previousRSI &&

            currentRSI > previousRSI &&

            currentRSI <= BUY_LEVEL;

        // ==================================================
        // SELL CONDITION
        //
        // Example:
        // 65 -> 70 -> 80 -> 90 -> 85
        //
        // Previous RSI must be >= 70
        // Previous RSI must be rising
        // Current RSI must turn downward
        // Current RSI must remain >= 70
        // ==================================================

        const sellSignal =

            previousRSI >= SELL_LEVEL &&

            olderRSI < previousRSI &&

            currentRSI < previousRSI &&

            currentRSI >= SELL_LEVEL;

        // ==================================================
        // NO SIGNAL
        // ==================================================

        if (
            !buySignal &&
            !sellSignal
        ) {
            return false;
        }

        // ==================================================
        // SIGNAL SIDE
        // ==================================================

        const side =
            buySignal ? 'BUY' : 'SELL';

        const emoji =
            buySignal ? '🟢' : '🔴';

        // ==================================================
        // DUPLICATE PROTECTION
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
        // COIN
        // ==================================================

        const base = coin.base;

        // ==================================================
        // TRADINGVIEW LINK
        // ==================================================

        const tradingViewUrl =
            `https://www.tradingview.com/chart/?symbol=BITGET:${base}USDT.P`;

        // ==================================================
        // TELEGRAM SIGNAL MESSAGE
        // ==================================================

        const message = `
${emoji} *RSI PRIMED ${side} REVERSAL*

━━━━━━━━━━━━━━━━━━━━

🪙 *Coin:* #${base}

🏦 *Exchange:* Bitget

⏰ *Timeframe:* WEEKLY (1W)

━━━━━━━━━━━━━━━━━━━━

📊 *INDICATOR SETTINGS*

Indicator: RSI Primed [ChartPrime]

Style: Candle

Length: ${RSI_LENGTH}

Smoothing: ${RSI_SMOOTHING}

Auto MA Multiplier: ${RSI_AUTO_MA_MULTIPLIER}

━━━━━━━━━━━━━━━━━━━━

📈 *THREE CLOSED WEEKLY RSI VALUES*

Older RSI:
${olderRSI.toFixed(4)}

Previous RSI:
${previousRSI.toFixed(4)}

Current RSI:
${currentRSI.toFixed(4)}

━━━━━━━━━━━━━━━━━━━━

📊 *CURRENT RSI CANDLE*

Open:
${currentRSIOpen.toFixed(4)}

High:
${currentRSIHigh.toFixed(4)}

Low:
${currentRSILow.toFixed(4)}

Close:
${currentRSI.toFixed(4)}

━━━━━━━━━━━━━━━━━━━━

${emoji} *${side} REVERSAL CONFIRMED*

${
    side === 'BUY'
        ? `RSI was falling below 30.
Previous RSI: ${previousRSI.toFixed(2)}
Current RSI: ${currentRSI.toFixed(2)}
RSI has turned upward.`
        : `RSI was rising above 70.
Previous RSI: ${previousRSI.toFixed(2)}
Current RSI: ${currentRSI.toFixed(2)}
RSI has turned downward.`
}

━━━━━━━━━━━━━━━━━━━━

✅ Three closed weekly candles checked

✅ RSI reversal confirmed

✅ Bitget USDT Perpetual

🔗 [Open TradingView Chart](${tradingViewUrl})
`;

        // ==================================================
        // SEND TELEGRAM FIRST
        // ==================================================

        await bot.sendMessage(
            chatId,
            message,
            {
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            }
        );

        // ==================================================
        // SAVE ONLY AFTER SUCCESSFUL DELIVERY
        // ==================================================

        sentSignals.add(key);

        await saveSignalHistory();

        console.log('');
        console.log('==============================');
        console.log('RSI REVERSAL SIGNAL');
        console.log(`Coin: ${symbol}`);
        console.log(`Side: ${side}`);
        console.log(`Older RSI: ${olderRSI.toFixed(2)}`);
        console.log(`Previous RSI: ${previousRSI.toFixed(2)}`);
        console.log(`Current RSI: ${currentRSI.toFixed(2)}`);
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

    let totalSignals = 0;

    let scanned = 0;

    let failed = 0;

    try {

        console.log('');
        console.log('==========================================');
        console.log('BITGET WEEKLY RSI PRIMED REVERSAL SCANNER');
        console.log('==========================================');

        // Load history

        await loadSignalHistory();

        // ==================================================
        // GET TOP 100 COINS
        // ==================================================

        const coins =
            await getBitgetCoins();

        if (!coins.length) {

            await bot.sendMessage(
                chatId,
                '⚠️ No eligible Bitget USDT perpetual pairs found.'
            );

            return;
        }

        // ==================================================
        // SEND ALL SCANNED COINS
        // ==================================================

        await sendScannedCoins(coins);

        // ==================================================
        // START MESSAGE
        // ==================================================

        await bot.sendMessage(
            chatId,
            `🚀 *WEEKLY RSI PRIMED REVERSAL SCANNER STARTED*

━━━━━━━━━━━━━━━━━━━━

🏦 Exchange: Bitget

📊 Market: USDT Perpetual

⏰ Timeframe: 1W

🪙 Coins: ${coins.length}

━━━━━━━━━━━━━━━━━━━━

📈 *RSI PRIMED CHARTPRIME*

Length: 35

Smoothing: 3

Auto MA Multiplier: 1

━━━━━━━━━━━━━━━━━━━━

🟢 *BUY*

RSI falls below 30 and turns upward.

🔴 *SELL*

RSI rises above 70 and turns downward.

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
                    `Failed: ${coin.symbol}`,
                    error.message
                );
            }

            await sleep(SCAN_DELAY);
        }

        // ==================================================
        // SCAN DURATION
        // ==================================================

        const duration =
            (
                (Date.now() - startTime) / 1000
            ).toFixed(1);

        // ==================================================
        // FINAL SUMMARY
        // ==================================================

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

Length: ${RSI_LENGTH}

Smoothing: ${RSI_SMOOTHING}

Auto MA Multiplier: ${RSI_AUTO_MA_MULTIPLIER}

━━━━━━━━━━━━━━━━━━━━

🟢 BUY: RSI turns upward inside 0–30

🔴 SELL: RSI turns downward inside 70–100

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

        console.error(
            'RUN ERROR:',
            error
        );

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
// START
// ONE SCAN PER GITHUB ACTION
// ======================================================

run();
