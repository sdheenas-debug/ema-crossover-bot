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
// EXCHANGE
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

const TIMEFRAMES = ['4h', '1d'];

const CANDLE_LIMIT = 100;

const EMA_PERIOD = 20;

// Scan ALL USDT perpetual coins.
// No price filter.
// No volume filter.

const SCAN_DELAY = 250;

// ======================================================
// DUPLICATE PROTECTION
// ======================================================

const sentSignals = new Set();

function signalKey(symbol, timeframe, side, candleTimestamp) {
    return `${symbol}_${timeframe}_${side}_${candleTimestamp}`;
}

// ======================================================
// SLEEP
// ======================================================

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ======================================================
// SAFE NUMBER
// ======================================================

function safeNumber(value, fallback = 0) {
    const number = Number(value);

    return Number.isFinite(number)
        ? number
        : fallback;
}

// ======================================================
// EMA
// ======================================================

function calculateEMA(values, period) {

    if (!values || values.length < period) {
        return [];
    }

    const multiplier = 2 / (period + 1);

    const ema = [];

    // Initial SMA
    let sum = 0;

    for (let i = 0; i < period; i++) {
        sum += values[i];
    }

    let previousEMA = sum / period;

    ema.push(previousEMA);

    // Remaining EMA values
    for (let i = period; i < values.length; i++) {

        const currentEMA =
            (
                values[i] - previousEMA
            ) * multiplier +
            previousEMA;

        ema.push(currentEMA);

        previousEMA = currentEMA;
    }

    return ema;
}

// ======================================================
// GET ALL USDT PERPETUAL COINS
// ======================================================

async function getAllUSDTPerpetualCoins() {

    try {

        console.log('Loading Bitget markets...');

        await exchange.loadMarkets();

        const symbols = [];

        for (const symbol of Object.keys(exchange.markets)) {

            try {

                const market =
                    exchange.markets[symbol];

                if (!market) continue;

                // Only swap contracts
                if (!market.swap) continue;

                // Only linear USDT contracts
                if (!market.linear) continue;

                if (
                    market.quote !== 'USDT'
                ) {
                    continue;
                }

                // Active markets only
                if (
                    market.active === false
                ) {
                    continue;
                }

                symbols.push(symbol);

            } catch (error) {

                console.error(
                    `Market filter error ${symbol}:`,
                    error.message
                );
            }
        }

        symbols.sort();

        console.log(
            `Found ${symbols.length} USDT perpetual coins`
        );

        return symbols;

    } catch (error) {

        console.error(
            'Market loading error:',
            error.message
        );

        return [];
    }
}

// ======================================================
// ANALYZE COIN
// ======================================================

async function analyzeCoin(symbol, timeframe) {

    try {

        // ==================================================
        // FETCH OHLCV
        // ==================================================

        const candles =
            await exchange.fetchOHLCV(
                symbol,
                timeframe,
                undefined,
                CANDLE_LIMIT
            );

        if (
            !candles ||
            candles.length < EMA_PERIOD + 5
        ) {
            return false;
        }

        // ==================================================
        // CLOSED CANDLES
        // ==================================================

        /*
         *
         * candles[candles.length - 1]
         * = current candle, normally still forming
         *
         * candles[candles.length - 2]
         * = LAST COMPLETED CANDLE
         *
         * candles[candles.length - 3]
         * = PREVIOUS COMPLETED CANDLE
         *
         */

        const lastClosedIndex =
            candles.length - 2;

        const previousClosedIndex =
            candles.length - 3;

        if (
            previousClosedIndex < EMA_PERIOD
        ) {
            return false;
        }

        // ==================================================
        // PRICE ARRAYS
        // ==================================================

        const timestamps =
            candles.map(c => c[0]);

        const opens =
            candles.map(c => safeNumber(c[1]));

        const highs =
            candles.map(c => safeNumber(c[2]));

        const lows =
            candles.map(c => safeNumber(c[3]));

        const closes =
            candles.map(c => safeNumber(c[4]));

        const volumes =
            candles.map(c => safeNumber(c[5]));

        // ==================================================
        // EMA20
        // ==================================================

        const ema20 =
            calculateEMA(
                closes,
                EMA_PERIOD
            );

        /*
         * EMA array starts from candle index:
         *
         * EMA_PERIOD - 1
         *
         * Example:
         *
         * candles:
         * 0 1 2 ... 19 20 21
         *
         * EMA:
         *             0  1  2
         *
         */

        const emaOffset =
            EMA_PERIOD - 1;

        const lastEMAIndex =
            lastClosedIndex - emaOffset;

        const previousEMAIndex =
            previousClosedIndex - emaOffset;

        if (
            lastEMAIndex < 1 ||
            previousEMAIndex < 0
        ) {
            return false;
        }

        const lastEMA20 =
            ema20[lastEMAIndex];

        const previousEMA20 =
            ema20[previousEMAIndex];

        // ==================================================
        // CLOSED CANDLE DATA
        // ==================================================

        const lastOpen =
            opens[lastClosedIndex];

        const lastHigh =
            highs[lastClosedIndex];

        const lastLow =
            lows[lastClosedIndex];

        const lastClose =
            closes[lastClosedIndex];

        const previousClose =
            closes[previousClosedIndex];

        const previousOpen =
            opens[previousClosedIndex];

        // ==================================================
        // EMA CROSS
        // ==================================================

        /*
         * LONG:
         *
         * Previous candle CLOSE <= previous EMA20
         *
         * Latest closed candle CLOSE > latest EMA20
         */

        const bullishCross =
            previousClose <= previousEMA20 &&
            lastClose > lastEMA20;

        /*
         * SHORT:
         *
         * Previous candle CLOSE >= previous EMA20
         *
         * Latest closed candle CLOSE < latest EMA20
         */

        const bearishCross =
            previousClose >= previousEMA20 &&
            lastClose < lastEMA20;

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

        let side;
        let emoji;

        if (bullishCross) {

            side = 'LONG';
            emoji = '🟢';

        } else {

            side = 'SHORT';
            emoji = '🔴';
        }

        // ==================================================
        // CANDLE TYPE
        // ==================================================

        const body =
            Math.abs(
                lastClose - lastOpen
            );

        const candleRange =
            lastHigh - lastLow;

        let candleType =
            'Normal';

        if (
            lastClose > lastOpen
        ) {

            candleType =
                '🟢 Bullish Candle';

        } else if (
            lastClose < lastOpen
        ) {

            candleType =
                '🔴 Bearish Candle';

        } else {

            candleType =
                '⚪ Doji';
        }

        // ==================================================
        // CANDLE STRENGTH
        // ==================================================

        let candleStrength =
            0;

        if (candleRange > 0) {

            candleStrength =
                (
                    body /
                    candleRange
                ) * 100;
        }

        // ==================================================
        // VOLUME
        // ==================================================

        const volumeLookback = 20;

        const volumeStart =
            Math.max(
                0,
                lastClosedIndex -
                volumeLookback
            );

        const volumeHistory =
            volumes.slice(
                volumeStart,
                lastClosedIndex
            );

        let averageVolume = 0;

        if (
            volumeHistory.length
        ) {

            averageVolume =
                volumeHistory.reduce(
                    (sum, value) =>
                        sum + value,
                    0
                ) /
                volumeHistory.length;
        }

        const currentVolume =
            volumes[lastClosedIndex];

        const volumeRatio =
            averageVolume > 0
                ? currentVolume /
                  averageVolume
                : 0;

        let volumeStatus =
            'Normal';

        if (
            volumeRatio >= 2
        ) {

            volumeStatus =
                '🔥 Strong Volume';

        } else if (
            volumeRatio >= 1.3
        ) {

            volumeStatus =
                '📈 Above Average';

        } else if (
            volumeRatio < 0.7
        ) {

            volumeStatus =
                '⚠️ Low Volume';
        }

        // ==================================================
        // ATR
        // ==================================================

        const atrPeriod = 14;

        let atr = 0;

        if (
            candles.length >
            atrPeriod + 2
        ) {

            const trueRanges = [];

            for (
                let i = 1;
                i < candles.length;
                i++
            ) {

                const high =
                    highs[i];

                const low =
                    lows[i];

                const previousClosePrice =
                    closes[i - 1];

                const tr =
                    Math.max(
                        high - low,
                        Math.abs(
                            high -
                            previousClosePrice
                        ),
                        Math.abs(
                            low -
                            previousClosePrice
                        )
                    );

                trueRanges.push(tr);
            }

            const atrValues =
                trueRanges.slice(
                    -atrPeriod
                );

            if (
                atrValues.length
            ) {

                atr =
                    atrValues.reduce(
                        (sum, value) =>
                            sum + value,
                        0
                    ) /
                    atrValues.length;
            }
        }

        // ==================================================
        // SUPPORT / RESISTANCE
        // ==================================================

        const structureLookback = 10;

        const structureStart =
            Math.max(
                0,
                lastClosedIndex -
                structureLookback
            );

        const structureLows =
            lows.slice(
                structureStart,
                lastClosedIndex
            );

        const structureHighs =
            highs.slice(
                structureStart,
                lastClosedIndex
            );

        const support =
            structureLows.length
                ? Math.min(
                    ...structureLows
                )
                : lastLow;

        const resistance =
            structureHighs.length
                ? Math.max(
                    ...structureHighs
                )
                : lastHigh;

        // ==================================================
        // SL / TP
        // ==================================================

        let sl;
        let tp1;
        let tp2;

        /*
         * ATR based levels.
         *
         * If ATR cannot be calculated,
         * use percentage fallback.
         */

        const usableATR =
            atr > 0
                ? atr
                : lastClose * 0.02;

        if (
            side === 'LONG'
        ) {

            sl =
                Math.min(
                    lastLow,
                    support
                ) -
                usableATR * 0.5;

            tp1 =
                lastClose +
                usableATR * 2;

            tp2 =
                lastClose +
                usableATR * 3.5;

        } else {

            sl =
                Math.max(
                    lastHigh,
                    resistance
                ) +
                usableATR * 0.5;

            tp1 =
                lastClose -
                usableATR * 2;

            tp2 =
                lastClose -
                usableATR * 3.5;
        }

        // ==================================================
        // RISK / REWARD
        // ==================================================

        const risk =
            Math.abs(
                lastClose - sl
            );

        const reward1 =
            Math.abs(
                tp1 - lastClose
            );

        const reward2 =
            Math.abs(
                tp2 - lastClose
            );

        const rr1 =
            risk > 0
                ? reward1 / risk
                : 0;

        const rr2 =
            risk > 0
                ? reward2 / risk
                : 0;

        // ==================================================
        // DUPLICATE PROTECTION
        // ==================================================

        const candleTimestamp =
            timestamps[lastClosedIndex];

        const key =
            signalKey(
                symbol,
                timeframe,
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
        // FUNDING
        // ==================================================

        let fundingStr =
            'N/A';

        let fundingRate =
            null;

        try {

            const funding =
                await exchange.fetchFundingRate(
                    symbol
                );

            if (
                funding &&
                Number.isFinite(
                    funding.fundingRate
                )
            ) {

                fundingRate =
                    funding.fundingRate;

                fundingStr =
                    `${(
                        fundingRate * 100
                    ).toFixed(4)}%`;
            }

        } catch (error) {

            console.error(
                `Funding error ${symbol}:`,
                error.message
            );
        }

        // ==================================================
        // OPEN INTEREST
        // ==================================================

        let oiStr =
            'N/A';

        try {

            const oi =
                await exchange.fetchOpenInterest(
                    symbol
                );

            if (
                oi &&
                Number.isFinite(
                    oi.openInterestValue
                )
            ) {

                oiStr =
                    `$${(
                        oi.openInterestValue /
                        1000000
                    ).toFixed(2)}M`;
            }

        } catch (error) {

            console.error(
                `OI error ${symbol}:`,
                error.message
            );
        }

        // ==================================================
        // FUNDING RISK
        // ==================================================

        let fundingRisk =
            'Normal';

        if (
            fundingRate !== null
        ) {

            if (
                side === 'LONG' &&
                fundingRate > 0.01
            ) {

                fundingRisk =
                    '⚠️ High Long Funding';

            } else if (
                side === 'SHORT' &&
                fundingRate < -0.01
            ) {

                fundingRisk =
                    '⚠️ High Short Funding';

            } else if (
                side === 'LONG' &&
                fundingRate < -0.01
            ) {

                fundingRisk =
                    '🔥 Short-Squeeze Risk';

            } else if (
                side === 'SHORT' &&
                fundingRate > 0.01
            ) {

                fundingRisk =
                    '🔥 Long-Liquidation Risk';
            }
        }

        // ==================================================
        // SYMBOL
        // ==================================================

        const baseAsset =
            symbol
                .split('/')[0]
                .replace(':USDT', '');

        // ==================================================
        // TRADINGVIEW
        // ==================================================

        const tradingViewSymbol =
            `${baseAsset}USDT.P`;

        const tradingViewUrl =
            `https://www.tradingview.com/chart/?symbol=BITGET:${tradingViewSymbol}`;

        // ==================================================
        // CROSS DISTANCE
        // ==================================================

        const emaDistance =
            (
                (
                    lastClose -
                    lastEMA20
                ) /
                lastEMA20
            ) * 100;

        // ==================================================
        // MESSAGE
        // ==================================================

        const message = `
${emoji} *EMA20 ${side} CROSS*
━━━━━━━━━━━━━━━━━━━━

🪙 *Coin:* #${baseAsset}
⏰ *Timeframe:* ${timeframe}

━━━━━━━━━━━━━━━━━━━━
🎯 *CONFIRMED CROSS*

Previous Close:
\`${previousClose}\`

Previous EMA20:
\`${previousEMA20.toPrecision(8)}\`

━━━━━━━━━━━━━━━━━━━━

Latest Closed Candle:
\`${lastClose}\`

Latest EMA20:
\`${lastEMA20.toPrecision(8)}\`

EMA Distance:
\`${emaDistance.toFixed(2)}%\`

✅ *EMA20 Cross Confirmed*
✅ *Candle CLOSED*

━━━━━━━━━━━━━━━━━━━━
🕯️ *CANDLE*

*Open:* ${lastOpen}
*High:* ${lastHigh}
*Low:* ${lastLow}
*Close:* ${lastClose}

*Type:* ${candleType}
*Body Strength:* ${candleStrength.toFixed(1)}%

━━━━━━━━━━━━━━━━━━━━
📊 *VOLUME*

*Status:* ${volumeStatus}
*Current:* ${currentVolume.toFixed(0)}
*Average:* ${averageVolume.toFixed(0)}
*Ratio:* ${volumeRatio.toFixed(2)}x

━━━━━━━━━━━━━━━━━━━━
📈 *EMA*

*EMA20:* ${lastEMA20.toPrecision(8)}

*Previous EMA20:*
${previousEMA20.toPrecision(8)}

━━━━━━━━━━━━━━━━━━━━
🏦 *DERIVATIVES*

*Open Interest:* ${oiStr}

*Funding:* ${fundingStr}

*Risk:* ${fundingRisk}

━━━━━━━━━━━━━━━━━━━━
🎯 *TRADE LEVELS*

*Entry:* ${lastClose}

*TP1:* ${tp1.toPrecision(8)}

*TP2:* ${tp2.toPrecision(8)}

*SL:* ${sl.toPrecision(8)}

*R:R TP1:* 1:${rr1.toFixed(2)}

*R:R TP2:* 1:${rr2.toFixed(2)}

━━━━━━━━━━━━━━━━━━━━
📌 *STRUCTURE*

*Support:*
${support.toPrecision(8)}

*Resistance:*
${resistance.toPrecision(8)}

━━━━━━━━━━━━━━━━━━━━

⚠️ Signal is generated only
after the candle has CLOSED.

Use proper position sizing
and risk management.

🔗 [Open TradingView Chart](${tradingViewUrl})
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
            `SIGNAL ${symbol} ${timeframe} ${side}`
        );

        return true;

    } catch (error) {

        console.error(
            `Analyze error ${symbol} ${timeframe}:`,
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

        console.log(
            '========================================'
        );

        console.log(
            'SMART EMA20 CROSS SCANNER'
        );

        console.log(
            '========================================'
        );

        // ==================================================
        // GET ALL COINS
        // ==================================================

        const coins =
            await getAllUSDTPerpetualCoins();

        if (
            !coins.length
        ) {

            await bot.sendMessage(
                chatId,
                '⚠️ No active USDT perpetual coins found.'
            );

            return;
        }

        // ==================================================
        // START MESSAGE
        // ==================================================

        await bot.sendMessage(
            chatId,
            `🔍 *EMA20 Cross Scanner Started*

🪙 Coins: *${coins.length}*
⏰ Timeframes: *4H / 1D*

📈 LONG:
Previous Close ≤ EMA20
Latest Closed Close > EMA20

📉 SHORT:
Previous Close ≥ EMA20
Latest Closed Close < EMA20

✅ Only CLOSED candles
🚫 No price filter
🚫 No RSI filter
🚫 No cheap-coin filter

🎯 Scanning ALL eligible USDT perpetual contracts.`,
            {
                parse_mode: 'Markdown'
            }
        );

        let totalSignals =
            0;

        // ==================================================
        // TIMEFRAME FIRST
        // ==================================================

        for (
            const timeframe of TIMEFRAMES
        ) {

            console.log(
                `\n========== ${timeframe} ==========`
            );

            for (
                const coin of coins
            ) {

                const signalFound =
                    await analyzeCoin(
                        coin,
                        timeframe
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
        // FINISHED MESSAGE
        // ==================================================

        const statusMessage =
            totalSignals === 0
                ? `✅ *Scan Finished*

No EMA20 cross signals found.

🪙 Coins scanned: *${coins.length}*
⏰ Timeframes: *4H / 1D*
⏱️ Time: *${duration}s*`

                : `✅ *Scan Finished*

🎯 Signals Found: *${totalSignals}*

🪙 Coins scanned: *${coins.length}*
⏰ Timeframes: *4H / 1D*
⏱️ Time: *${duration}s*`;

        await bot.sendMessage(
            chatId,
            statusMessage,
            {
                parse_mode: 'Markdown'
            }
        );

        console.log(
            `\nScan finished. Signals: ${totalSignals}`
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
