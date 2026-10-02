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

const bot = new TelegramBot(token);

// ======================================================
// BINANCE FUTURES
// ONLY FOR COIN LIST
// ======================================================

const binance = new ccxt.binance({
    options: {
        defaultType: 'future'
    },
    enableRateLimit: true
});

// ======================================================
// BITGET FUTURES
// ONLY FOR SIGNAL / CANDLES
// ======================================================

const bitget = new ccxt.bitget({
    options: {
        defaultType: 'swap'
    },
    enableRateLimit: true
});

// ======================================================
// SETTINGS
// ======================================================

const TIMEFRAME = '1d';

const EMA_PERIOD = 20;

const CANDLE_LIMIT = 100;

const SCAN_DELAY = 150;

// ======================================================
// DUPLICATE PROTECTION
// ======================================================

const sentSignals = new Set();

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
// EMA
// ======================================================

function calculateEMA(values, period) {

    if (
        !values ||
        values.length < period
    ) {
        return [];
    }

    const multiplier =
        2 / (period + 1);

    const ema = [];

    // Initial SMA
    let sum = 0;

    for (
        let i = 0;
        i < period;
        i++
    ) {
        sum += values[i];
    }

    let previousEMA =
        sum / period;

    ema.push(previousEMA);

    // EMA
    for (
        let i = period;
        i < values.length;
        i++
    ) {

        const currentEMA =
            (
                values[i] -
                previousEMA
            ) * multiplier +
            previousEMA;

        ema.push(currentEMA);

        previousEMA =
            currentEMA;
    }

    return ema;
}

// ======================================================
// GET BINANCE FUTURES COINS
// ======================================================

async function getBinanceFuturesCoins() {

    try {

        console.log(
            'Loading Binance Futures markets...'
        );

        await binance.loadMarkets();

        const coins = [];

        for (
            const symbol of Object.keys(
                binance.markets
            )
        ) {

            const market =
                binance.markets[symbol];

            if (!market) continue;

            // Only Binance Futures
            if (
                market.future !== true
            ) {
                continue;
            }

            // Only USDT-M
            if (
                market.linear !== true
            ) {
                continue;
            }

            if (
                market.quote !== 'USDT'
            ) {
                continue;
            }

            // Active only
            if (
                market.active === false
            ) {
                continue;
            }

            coins.push(symbol);
        }

        coins.sort();

        console.log(
            `Binance USDT-M Futures coins: ${coins.length}`
        );

        return coins;

    } catch (error) {

        console.error(
            'Binance market error:',
            error.message
        );

        return [];
    }
}

// ======================================================
// FIND MATCHING BITGET USDT PERPETUAL
// ======================================================

function findBitgetSymbol(
    binanceSymbol
) {

    const [base, quote] =
        binanceSymbol.split('/');

    // --------------------------------------------------
    // Direct unified symbol
    // --------------------------------------------------

    const direct =
        bitget.markets[
            binanceSymbol
        ];

    if (
        direct &&
        direct.swap === true &&
        direct.linear === true &&
        direct.quote === 'USDT' &&
        direct.active !== false
    ) {

        return direct.symbol;
    }

    // --------------------------------------------------
    // Search Bitget markets
    // --------------------------------------------------

    for (
        const symbol of Object.keys(
            bitget.markets
        )
    ) {

        const market =
            bitget.markets[symbol];

        if (!market) continue;

        // USDT perpetual only
        if (
            market.swap !== true
        ) {
            continue;
        }

        if (
            market.linear !== true
        ) {
            continue;
        }

        if (
            market.base !== base
        ) {
            continue;
        }

        if (
            market.quote !== quote
        ) {
            continue;
        }

        if (
            market.active === false
        ) {
            continue;
        }

        return market.symbol;
    }

    return null;
}

// ======================================================
// ANALYZE COIN
// ======================================================

async function analyzeCoin(
    binanceSymbol,
    bitgetSymbol
) {

    try {

        // ==================================================
        // BITGET 1D CANDLES
        // ==================================================

        const candles =
            await bitget.fetchOHLCV(
                bitgetSymbol,
                TIMEFRAME,
                undefined,
                CANDLE_LIMIT
            );

        if (
            !candles ||
            candles.length <
            EMA_PERIOD + 5
        ) {
            return false;
        }

        // ==================================================
        // CLOSED CANDLE INDEX
        // ==================================================

        /*
         * Last candle:
         * candles[length - 1]
         * = currently forming candle
         *
         * Last CLOSED:
         * candles[length - 2]
         *
         * Previous CLOSED:
         * candles[length - 3]
         */

        const lastClosedIndex =
            candles.length - 2;

        const previousClosedIndex =
            candles.length - 3;

        // ==================================================
        // CLOSE PRICES
        // ==================================================

        const closes =
            candles.map(
                candle =>
                    Number(candle[4])
            );

        const timestamps =
            candles.map(
                candle =>
                    candle[0]
            );

        // ==================================================
        // EMA20
        // ==================================================

        const ema20 =
            calculateEMA(
                closes,
                EMA_PERIOD
            );

        const emaOffset =
            EMA_PERIOD - 1;

        const lastEMAIndex =
            lastClosedIndex -
            emaOffset;

        const previousEMAIndex =
            previousClosedIndex -
            emaOffset;

        if (
            lastEMAIndex < 0 ||
            previousEMAIndex < 0
        ) {
            return false;
        }

        const lastEMA20 =
            ema20[lastEMAIndex];

        const previousEMA20 =
            ema20[previousEMAIndex];

        // ==================================================
        // CLOSED CANDLE CLOSE
        // ==================================================

        const lastClose =
            closes[lastClosedIndex];

        const previousClose =
            closes[previousClosedIndex];

        // ==================================================
        // EMA20 CROSS
        // ==================================================

        // LONG:
        //
        // Previous candle close
        // was below / equal EMA20
        //
        // Latest CLOSED candle close
        // is above EMA20

        const bullishCross =
            previousClose <=
                previousEMA20 &&
            lastClose >
                lastEMA20;

        // SHORT:
        //
        // Previous candle close
        // was above / equal EMA20
        //
        // Latest CLOSED candle close
        // is below EMA20

        const bearishCross =
            previousClose >=
                previousEMA20 &&
            lastClose <
                lastEMA20;

        // ==================================================
        // NO SIGNAL
        // ==================================================

        if (
            !bullishCross &&
            !bearishCross
        ) {
            return false;
        }

        // ==================================================
        // SIDE
        // ==================================================

        const side =
            bullishCross
                ? 'LONG'
                : 'SHORT';

        const emoji =
            bullishCross
                ? '🟢'
                : '🔴';

        // ==================================================
        // DUPLICATE PROTECTION
        // ==================================================

        const candleTimestamp =
            timestamps[lastClosedIndex];

        const key =
            signalKey(
                binanceSymbol,
                side,
                candleTimestamp
            );

        if (
            sentSignals.has(key)
        ) {
            return false;
        }

        sentSignals.add(key);

        // Keep memory small
        if (
            sentSignals.size > 5000
        ) {

            const first =
                sentSignals
                    .values()
                    .next()
                    .value;

            sentSignals.delete(first);
        }

        // ==================================================
        // BASE COIN
        // ==================================================

        const base =
            binanceSymbol
                .split('/')[0];

        // ==================================================
        // TRADINGVIEW
        // ==================================================

        const tradingViewUrl =
            `https://www.tradingview.com/chart/?symbol=BITGET:${base}USDT.P`;

        // ==================================================
        // TELEGRAM MESSAGE
        // ==================================================

        const message = `
${emoji} *20 EMA ${side} CROSS*
━━━━━━━━━━━━━━━━━━━━

🪙 *Coin:* #${base}

⏰ *Timeframe:* 1D

🔎 *Coin List:* Binance USDT-M Futures

📊 *Signal:* Bitget USDT Perpetual

━━━━━━━━━━━━━━━━━━━━
📈 *PREVIOUS CLOSED CANDLE*

*Close:*
${previousClose}

*EMA20:*
${previousEMA20.toPrecision(10)}

━━━━━━━━━━━━━━━━━━━━
📈 *LATEST CLOSED CANDLE*

*Close:*
${lastClose}

*EMA20:*
${lastEMA20.toPrecision(10)}

━━━━━━━━━━━━━━━━━━━━

${emoji} *20 EMA CROSS CONFIRMED*

${side === 'LONG'
    ? `Previous Close ≤ EMA20
Latest Close > EMA20`
    : `Previous Close ≥ EMA20
Latest Close < EMA20`
}

━━━━━━━━━━━━━━━━━━━━

✅ Binance Futures Coin
✅ Bitget Perpetual
✅ 1D Timeframe
✅ 20 EMA Cross
✅ Candle CLOSED

━━━━━━━━━━━━━━━━━━━━

⚠️ Signal is generated only
after the 1D candle has CLOSED.

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

        console.log(
            `SIGNAL | ${binanceSymbol} | ${bitgetSymbol} | ${side}`
        );

        return true;

    } catch (error) {

        console.error(
            `Analyze error ${binanceSymbol}:`,
            error.message
        );

        return false;
    }
}

// ======================================================
// MAIN
// ======================================================

async function run() {

    const startTime =
        Date.now();

    try {

        console.log(
            '=========================================='
        );

        console.log(
            'BINANCE FUTURES → BITGET EMA20 SCANNER'
        );

        console.log(
            '=========================================='
        );

        // ==================================================
        // LOAD BITGET
        // ==================================================

        await bitget.loadMarkets();

        // ==================================================
        // GET BINANCE FUTURES COINS
        // ==================================================

        const binanceCoins =
            await getBinanceFuturesCoins();

        if (
            !binanceCoins.length
        ) {

            await bot.sendMessage(
                chatId,
                '⚠️ No Binance USDT-M Futures coins found.'
            );

            return;
        }

        // ==================================================
        // MATCH WITH BITGET
        // ==================================================

        const pairs = [];

        for (
            const binanceSymbol
            of binanceCoins
        ) {

            const bitgetSymbol =
                findBitgetSymbol(
                    binanceSymbol
                );

            if (
                !bitgetSymbol
            ) {
                continue;
            }

            pairs.push({
                binanceSymbol,
                bitgetSymbol
            });
        }

        console.log(
            `Bitget matching perpetuals: ${pairs.length}`
        );

        // ==================================================
        // START MESSAGE
        // ==================================================

        await bot.sendMessage(
            chatId,
            `🔍 *EMA20 1D SCANNER STARTED*

🔎 *Coin Source:*
Binance USDT-M Futures

📊 *Signal Source:*
Bitget USDT Perpetual

⏰ *Timeframe:*
1D

📈 *Indicator:*
20 EMA

🪙 Binance Futures:
*${binanceCoins.length}*

🔗 Bitget Matching:
*${pairs.length}*

━━━━━━━━━━━━━━━━━━━━

🟢 LONG:
Previous Close ≤ EMA20
Latest Closed Close > EMA20

🔴 SHORT:
Previous Close ≥ EMA20
Latest Closed Close < EMA20

━━━━━━━━━━━━━━━━━━━━

Only 20 EMA cross.
No other indicators.`,
            {
                parse_mode: 'Markdown'
            }
        );

        // ==================================================
        // SCAN ALL
        // ==================================================

        let totalSignals = 0;

        for (
            const pair of pairs
        ) {

            const signalFound =
                await analyzeCoin(
                    pair.binanceSymbol,
                    pair.bitgetSymbol
                );

            if (
                signalFound
            ) {
                totalSignals++;
            }

            await sleep(
                SCAN_DELAY
            );
        }

        // ==================================================
        // FINISH
        // ==================================================

        const duration =
            (
                (
                    Date.now() -
                    startTime
                ) / 1000
            ).toFixed(1);

        await bot.sendMessage(
            chatId,
            `✅ *1D EMA20 SCAN FINISHED*

🔎 Binance Futures:
*${binanceCoins.length}*

📊 Bitget Matching:
*${pairs.length}*

🎯 Signals:
*${totalSignals}*

⏱️ Scan Time:
*${duration}s*`,
            {
                parse_mode: 'Markdown'
            }
        );

        console.log(
            `Scan finished. Signals: ${totalSignals}`
        );

    } catch (error) {

        console.error(
            'RUN ERROR:',
            error
        );

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
