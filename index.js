import ccxt from 'ccxt';
import TelegramBot from 'node-telegram-bot-api';

// ======================================================
// ENV
// ======================================================

const token = process.env.TELEGRAM_TOKEN;
const chatId = process.env.CHAT_ID;

if (!token || !chatId) {
    throw new Error(
        'TELEGRAM_TOKEN or CHAT_ID is missing'
    );
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

function calculateEMA(
    values,
    period
) {

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

    // EMA calculation
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
// GET ALL BITGET USDT PERPETUALS
// ======================================================

async function getBitgetCoins() {

    try {

        console.log(
            'Loading Bitget markets...'
        );

        await exchange.loadMarkets();

        const coins = [];

        for (
            const symbol of Object.keys(
                exchange.markets
            )
        ) {

            try {

                const market =
                    exchange.markets[symbol];

                if (!market) {
                    continue;
                }

                // --------------------------------------------------
                // PERPETUAL SWAP ONLY
                // --------------------------------------------------

                if (
                    market.swap !== true
                ) {
                    continue;
                }

                // --------------------------------------------------
                // LINEAR CONTRACT
                // --------------------------------------------------

                if (
                    market.linear !== true
                ) {
                    continue;
                }

                // --------------------------------------------------
                // USDT QUOTE
                // --------------------------------------------------

                if (
                    market.quote !== 'USDT'
                ) {
                    continue;
                }

                // --------------------------------------------------
                // USDT SETTLEMENT
                // --------------------------------------------------

                if (
                    market.settle &&
                    market.settle !== 'USDT'
                ) {
                    continue;
                }

                // --------------------------------------------------
                // ACTIVE
                // --------------------------------------------------

                if (
                    market.active === false
                ) {
                    continue;
                }

                coins.push(symbol);

            } catch (error) {

                console.error(
                    `Market filter error ${symbol}:`,
                    error.message
                );
            }
        }

        coins.sort();

        console.log(
            `Bitget USDT perpetuals found: ${coins.length}`
        );

        return coins;

    } catch (error) {

        console.error(
            'Bitget market error:',
            error.message
        );

        return [];
    }
}

// ======================================================
// ANALYZE COIN
// ======================================================

async function analyzeCoin(
    symbol
) {

    try {

        // ==================================================
        // FETCH 1D CANDLES
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
         * = current/forming candle
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
        // VALIDATE
        // ==================================================

        if (
            closes.some(
                price =>
                    !Number.isFinite(price)
            )
        ) {
            return false;
        }

        // ==================================================
        // EMA20
        // ==================================================

        const ema20 =
            calculateEMA(
                closes,
                EMA_PERIOD
            );

        if (
            !ema20.length
        ) {
            return false;
        }

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

        // ==================================================
        // EMA VALUES
        // ==================================================

        const lastEMA20 =
            ema20[lastEMAIndex];

        const previousEMA20 =
            ema20[previousEMAIndex];

        // ==================================================
        // CLOSED CANDLE CLOSES
        // ==================================================

        const lastClose =
            closes[lastClosedIndex];

        const previousClose =
            closes[previousClosedIndex];

        // ==================================================
        // LONG CROSS
        // ==================================================

        const bullishCross =
            previousClose <=
                previousEMA20 &&
            lastClose >
                lastEMA20;

        // ==================================================
        // SHORT CROSS
        // ==================================================

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
                symbol,
                side,
                candleTimestamp
            );

        if (
            sentSignals.has(key)
        ) {
            return false;
        }

        sentSignals.add(key);

        // Keep memory manageable
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
            symbol
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

🏦 *Exchange:* Bitget

⏰ *Timeframe:* 1D

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

${
    side === 'LONG'
        ? `Previous Close ≤ EMA20
Latest Close > EMA20`
        : `Previous Close ≥ EMA20
Latest Close < EMA20`
}

━━━━━━━━━━━━━━━━━━━━

✅ Bitget USDT Perpetual
✅ 1D Timeframe
✅ 20 EMA Cross
✅ Candle CLOSED

━━━━━━━━━━━━━━━━━━━━

⚠️ Signal is generated only
after the 1D candle has CLOSED.

🔗 [Open Bitget Chart](${tradingViewUrl})
`;

        // ==================================================
        // TELEGRAM
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
        console.log(
            '=============================='
        );
        console.log(
            'SIGNAL'
        );
        console.log(
            `Coin : ${symbol}`
        );
        console.log(
            `Side : ${side}`
        );
        console.log(
            `Close: ${lastClose}`
        );
        console.log(
            `EMA20: ${lastEMA20}`
        );
        console.log(
            '=============================='
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

    const startTime =
        Date.now();

    try {

        console.log('');
        console.log(
            '=========================================='
        );
        console.log(
            '       BITGET 1D EMA20 SCANNER'
        );
        console.log(
            '=========================================='
        );
        console.log('');

        // ==================================================
        // GET ALL BITGET COINS
        // ==================================================

        const coins =
            await getBitgetCoins();

        if (
            !coins.length
        ) {

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
            `🔍 *BITGET EMA20 SCANNER STARTED*

🏦 Exchange:
*Bitget*

📊 Market:
*USDT Perpetual*

⏰ Timeframe:
*1D*

📈 Indicator:
*20 EMA*

🪙 Coins:
*${coins.length}*

━━━━━━━━━━━━━━━━━━━━

🟢 LONG

Previous Close ≤ EMA20

Latest Closed Close > EMA20

━━━━━━━━━━━━━━━━━━━━

🔴 SHORT

Previous Close ≥ EMA20

Latest Closed Close < EMA20

━━━━━━━━━━━━━━━━━━━━

Only:

*1D CLOSED CANDLE*
+
*20 EMA CROSS*`,
            {
                parse_mode: 'Markdown'
            }
        );

        // ==================================================
        // SCAN
        // ==================================================

        let totalSignals =
            0;

        let scanned =
            0;

        for (
            const symbol of coins
        ) {

            scanned++;

            console.log(
                `[${scanned}/${coins.length}] ${symbol}`
            );

            const signalFound =
                await analyzeCoin(
                    symbol
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
        // DURATION
        // ==================================================

        const duration =
            (
                (
                    Date.now() -
                    startTime
                ) / 1000
            ).toFixed(1);

        // ==================================================
        // FINISHED
        // ==================================================

        await bot.sendMessage(
            chatId,
            `✅ *BITGET 1D EMA20 SCAN FINISHED*

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

📈 Method:

*20 EMA Closed Candle Cross*`,
            {
                parse_mode: 'Markdown'
            }
        );

        console.log('');
        console.log(
            '=========================================='
        );
        console.log(
            'SCAN FINISHED'
        );
        console.log(
            `Coins   : ${coins.length}`
        );
        console.log(
            `Signals : ${totalSignals}`
        );
        console.log(
            `Time    : ${duration}s`
        );
        console.log(
            '=========================================='
        );

    } catch (error) {

        console.error(
            'RUN ERROR:',
            error
        );

        try {

            await bot.sendMessage(
                chatId,
                `❌ *Scanner Error*

${error.message}`,
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
