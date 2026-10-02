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
// BINANCE USDⓈ-M FUTURES
// USED ONLY FOR COIN LIST
// ======================================================

const binance = new ccxt.binanceusdm({
    enableRateLimit: true
});

// ======================================================
// BITGET USDT PERPETUAL
// USED ONLY FOR SIGNAL DATA
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
// EMA CALCULATION
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

    // --------------------------------------------------
    // INITIAL SMA
    // --------------------------------------------------

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

    // --------------------------------------------------
    // EMA
    // --------------------------------------------------

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
// GET BINANCE USDⓈ-M FUTURES COINS
// ======================================================

async function getBinanceFuturesCoins() {

    try {

        console.log(
            '======================================'
        );

        console.log(
            'Loading Binance USDⓈ-M Futures...'
        );

        console.log(
            '======================================'
        );

        await binance.loadMarkets();

        const coins = [];

        for (
            const symbol of Object.keys(
                binance.markets
            )
        ) {

            try {

                const market =
                    binance.markets[symbol];

                if (!market) {
                    continue;
                }

                // ==================================================
                // CONTRACT
                // ==================================================

                if (
                    market.contract !== true
                ) {

                    continue;
                }

                // ==================================================
                // LINEAR / USDT-M
                // ==================================================

                if (
                    market.linear !== true
                ) {

                    continue;
                }

                // ==================================================
                // SETTLEMENT USDT
                // ==================================================

                if (
                    market.settle !== 'USDT'
                ) {

                    continue;
                }

                // ==================================================
                // PERPETUAL
                // ==================================================

                if (
                    market.swap !== true
                ) {

                    continue;
                }

                // ==================================================
                // ACTIVE
                // ==================================================

                if (
                    market.active === false
                ) {

                    continue;
                }

                coins.push(symbol);

            } catch (error) {

                console.error(
                    `Binance filter error ${symbol}:`,
                    error.message
                );
            }
        }

        coins.sort();

        console.log(
            `Binance USDⓈ-M USDT perpetuals: ${coins.length}`
        );

        return coins;

    } catch (error) {

        console.error(
            'Binance Futures error:',
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

    /*
     * Binance symbol examples:
     *
     * BTC/USDT:USDT
     * ETH/USDT:USDT
     * SOL/USDT:USDT
     */

    const base =
        binanceSymbol
            .split('/')[0];

    // ==================================================
    // SEARCH BITGET
    // ==================================================

    for (
        const symbol of Object.keys(
            bitget.markets
        )
    ) {

        const market =
            bitget.markets[symbol];

        if (!market) {
            continue;
        }

        // --------------------------------------------------
        // PERPETUAL
        // --------------------------------------------------

        if (
            market.swap !== true
        ) {

            continue;
        }

        // --------------------------------------------------
        // LINEAR
        // --------------------------------------------------

        if (
            market.linear !== true
        ) {

            continue;
        }

        // --------------------------------------------------
        // SAME BASE
        // --------------------------------------------------

        if (
            market.base !== base
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
        // FETCH BITGET 1D CANDLES
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
        // IMPORTANT
        // ==================================================

        /*
         *
         * candles[length - 1]
         * = CURRENT FORMING CANDLE
         *
         * candles[length - 2]
         * = LAST COMPLETED CANDLE
         *
         * candles[length - 3]
         * = PREVIOUS COMPLETED CANDLE
         *
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
        // VALIDATE DATA
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
            ema20.length === 0
        ) {

            return false;
        }

        // ==================================================
        // EMA OFFSET
        // ==================================================

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
        // VALIDATE
        // ==================================================

        if (
            !Number.isFinite(lastEMA20) ||
            !Number.isFinite(previousEMA20) ||
            !Number.isFinite(lastClose) ||
            !Number.isFinite(previousClose)
        ) {

            return false;
        }

        // ==================================================
        // LONG CROSS
        // ==================================================

        /*
         *
         * Previous CLOSED candle:
         *
         * Close <= EMA20
         *
         * Latest CLOSED candle:
         *
         * Close > EMA20
         *
         */

        const bullishCross =
            previousClose <=
                previousEMA20 &&
            lastClose >
                lastEMA20;

        // ==================================================
        // SHORT CROSS
        // ==================================================

        /*
         *
         * Previous CLOSED candle:
         *
         * Close >= EMA20
         *
         * Latest CLOSED candle:
         *
         * Close < EMA20
         *
         */

        const bearishCross =
            previousClose >=
                previousEMA20 &&
            lastClose <
                lastEMA20;

        // ==================================================
        // NO CROSS
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

        // ==================================================
        // MEMORY LIMIT
        // ==================================================

        if (
            sentSignals.size > 5000
        ) {

            const first =
                sentSignals
                    .values()
                    .next()
                    .value;

            sentSignals.delete(
                first
            );
        }

        // ==================================================
        // BASE ASSET
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

🔎 *Coin List:* Binance USDⓈ-M Futures

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

${
    side === 'LONG'
        ? `Previous Close ≤ EMA20
Latest Close > EMA20`
        : `Previous Close ≥ EMA20
Latest Close < EMA20`
}

━━━━━━━━━━━━━━━━━━━━

✅ Binance Futures Coin
✅ Bitget USDT Perpetual
✅ 1D Timeframe
✅ 20 EMA Cross
✅ Candle CLOSED

━━━━━━━━━━━━━━━━━━━━

⚠️ Signal is based ONLY on
the completed 1D candle.

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
            `SIGNAL`
        );

        console.log(
            `Binance : ${binanceSymbol}`
        );

        console.log(
            `Bitget  : ${bitgetSymbol}`
        );

        console.log(
            `Side    : ${side}`
        );

        console.log(
            `Close   : ${lastClose}`
        );

        console.log(
            `EMA20   : ${lastEMA20}`
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
            ' BINANCE FUTURES → BITGET EMA20 SCANNER'
        );
        console.log(
            '=========================================='
        );
        console.log('');

        // ==================================================
        // LOAD BITGET MARKETS
        // ==================================================

        console.log(
            'Loading Bitget markets...'
        );

        await bitget.loadMarkets();

        console.log(
            `Bitget markets loaded: ${
                Object.keys(
                    bitget.markets
                ).length
            }`
        );

        // ==================================================
        // GET BINANCE FUTURES COINS
        // ==================================================

        const binanceCoins =
            await getBinanceFuturesCoins();

        if (
            !binanceCoins.length
        ) {

            console.error(
                'No Binance USDⓈ-M Futures coins found.'
            );

            await bot.sendMessage(
                chatId,
                '⚠️ No Binance USDⓈ-M Futures coins found.'
            );

            return;
        }

        // ==================================================
        // MATCH BINANCE → BITGET
        // ==================================================

        const pairs = [];

        let noBitgetMatch = 0;

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

                noBitgetMatch++;

                continue;
            }

            pairs.push({
                binanceSymbol,
                bitgetSymbol
            });
        }

        console.log('');
        console.log(
            `Binance Futures coins : ${binanceCoins.length}`
        );

        console.log(
            `Bitget matching coins : ${pairs.length}`
        );

        console.log(
            `No Bitget match       : ${noBitgetMatch}`
        );

        // ==================================================
        // TELEGRAM START
        // ==================================================

        await bot.sendMessage(
            chatId,
            `🔍 *EMA20 1D SCANNER STARTED*

🔎 *Coin Source*
Binance USDⓈ-M Futures

📊 *Signal Source*
Bitget USDT Perpetual

⏰ *Timeframe*
1D

📈 *Indicator*
20 EMA

━━━━━━━━━━━━━━━━━━━━

🪙 Binance Futures:
*${binanceCoins.length}*

🔗 Bitget Matching:
*${pairs.length}*

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
        // SCAN ALL MATCHING COINS
        // ==================================================

        let totalSignals =
            0;

        let scanned =
            0;

        for (
            const pair of pairs
        ) {

            scanned++;

            console.log(
                `[${scanned}/${pairs.length}] ${pair.binanceSymbol}`
            );

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
            `✅ *1D EMA20 SCAN FINISHED*

━━━━━━━━━━━━━━━━━━━━

🔎 Binance Futures:
*${binanceCoins.length}*

📊 Bitget Matching:
*${pairs.length}*

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
            `Signals: ${totalSignals}`
        );
        console.log(
            `Time: ${duration}s`
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
