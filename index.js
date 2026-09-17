import ccxt from 'ccxt';
import pkg from 'technicalindicators';
import TelegramBot from 'node-telegram-bot-api';

const {
    EMA,
    RSI,
    ADX,
    ATR,
    SMA
} = pkg;

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

const TIMEFRAMES = ['4h', '1d', '1w'];

const MAX_COINS = 600;

const MIN_QUOTE_VOLUME = 500000;

const MAX_PRICE = 15;

const CANDLE_LIMIT = 150;

const RSI_PERIOD = 14;

const EMA_PERIOD = 20;

const ATR_PERIOD = 14;

const ADX_PERIOD = 14;

const VOLUME_MA_PERIOD = 20;

const RSI_OVERSOLD = 30;

const RSI_OVERBOUGHT = 70;

// ======================================================
// MAJOR COINS
// ======================================================

const majorCoins = [
    'BTC/USDT',
    'BNB/USDT',
    'SOL/USDT',
    'ETH/USDT'
];

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
    return Number.isFinite(value) ? value : fallback;
}

// ======================================================
// GET FILTERED PAIRS
// ======================================================

async function getFilteredPairs() {

    try {

        const tickers = await exchange.fetchTickers();

        const filteredSymbols = [];

        for (const symbol of Object.keys(tickers)) {

            try {

                const ticker = tickers[symbol];

                if (!ticker) continue;

                const last = safeNumber(ticker.last);
                const quoteVolume = safeNumber(ticker.quoteVolume);

                if (!last || !quoteVolume) continue;

                // Only USDT contracts
                if (!symbol.endsWith('USDT')) continue;

                const base = symbol.split('/')[0];

                const isMajor = majorCoins.includes(symbol);

                const isCheap = last < MAX_PRICE;

                if (
                    (isMajor || isCheap) &&
                    quoteVolume > MIN_QUOTE_VOLUME
                ) {
                    filteredSymbols.push({
                        symbol,
                        quoteVolume
                    });
                }

            } catch (err) {
                console.error(
                    `Ticker error ${symbol}:`,
                    err.message
                );
            }
        }

        filteredSymbols.sort(
            (a, b) => b.quoteVolume - a.quoteVolume
        );

        const result = filteredSymbols
            .slice(0, MAX_COINS)
            .map(x => x.symbol);

        console.log(
            `Filtered ${result.length} symbols`
        );

        return result;

    } catch (error) {

        console.error(
            'getFilteredPairs error:',
            error.message
        );

        return [];
    }
}

// ======================================================
// VWAP
// ======================================================

function calculateVWAP(
    highPrices,
    lowPrices,
    closePrices,
    volumes,
    startIndex,
    endIndex
) {

    let sumTPV = 0;
    let sumVolume = 0;

    for (
        let i = startIndex;
        i <= endIndex;
        i++
    ) {

        const typicalPrice =
            (
                highPrices[i] +
                lowPrices[i] +
                closePrices[i]
            ) / 3;

        const volume = volumes[i];

        sumTPV += typicalPrice * volume;
        sumVolume += volume;
    }

    if (sumVolume === 0) {
        return 0;
    }

    return sumTPV / sumVolume;
}

// ======================================================
// RSI DIVERGENCE
// ======================================================

function detectBullishDivergence(
    lows,
    rsiValues,
    candleStartIndex,
    rsiStartIndex
) {

    if (candleStartIndex < 2) return false;

    const priceCurrent = lows[candleStartIndex];
    const pricePrevious = lows[candleStartIndex - 1];

    const rsiCurrent = rsiValues[rsiStartIndex];
    const rsiPrevious = rsiValues[rsiStartIndex - 1];

    return (
        priceCurrent < pricePrevious &&
        rsiCurrent > rsiPrevious
    );
}

function detectBearishDivergence(
    highs,
    rsiValues,
    candleStartIndex,
    rsiStartIndex
) {

    if (candleStartIndex < 2) return false;

    const priceCurrent = highs[candleStartIndex];
    const pricePrevious = highs[candleStartIndex - 1];

    const rsiCurrent = rsiValues[rsiStartIndex];
    const rsiPrevious = rsiValues[rsiStartIndex - 1];

    return (
        priceCurrent > pricePrevious &&
        rsiCurrent < rsiPrevious
    );
}

// ======================================================
// ANALYZE COIN
// ======================================================

async function analyzeCoin(symbol, timeframe) {

    try {

        // --------------------------------------------------
        // FETCH CANDLES
        // --------------------------------------------------

        const candles = await exchange.fetchOHLCV(
            symbol,
            timeframe,
            undefined,
            CANDLE_LIMIT
        );

        if (!candles || candles.length < 80) {
            return false;
        }

        // --------------------------------------------------
        // IMPORTANT:
        // Last candle is normally still forming.
        // We use the LAST COMPLETED candle.
        // --------------------------------------------------

        const lastClosedCandleIndex = candles.length - 2;

        const previousClosedCandleIndex =
            candles.length - 3;

        if (
            lastClosedCandleIndex < 50 ||
            previousClosedCandleIndex < 0
        ) {
            return false;
        }

        // --------------------------------------------------
        // OHLCV
        // --------------------------------------------------

        const timestamps = candles.map(c => c[0]);

        const openPrices = candles.map(c => c[1]);

        const highPrices = candles.map(c => c[2]);

        const lowPrices = candles.map(c => c[3]);

        const closePrices = candles.map(c => c[4]);

        const volumes = candles.map(c => c[5]);

        // --------------------------------------------------
        // INDICATORS
        // --------------------------------------------------

        const rsiArr = RSI.calculate({
            period: RSI_PERIOD,
            values: closePrices
        });

        const adxArr = ADX.calculate({
            period: ADX_PERIOD,
            high: highPrices,
            low: lowPrices,
            close: closePrices
        });

        const atrArr = ATR.calculate({
            period: ATR_PERIOD,
            high: highPrices,
            low: lowPrices,
            close: closePrices
        });

        const ema20Arr = EMA.calculate({
            period: EMA_PERIOD,
            values: closePrices
        });

        const volMaArr = SMA.calculate({
            period: VOLUME_MA_PERIOD,
            values: volumes
        });

        // --------------------------------------------------
        // CORRECT INDICATOR ALIGNMENT
        //
        // Indicator arrays start AFTER their warm-up period.
        // Do NOT use closePrices index directly.
        // --------------------------------------------------

        const rsiOffset =
            closePrices.length - rsiArr.length;

        const adxOffset =
            closePrices.length - adxArr.length;

        const atrOffset =
            closePrices.length - atrArr.length;

        const emaOffset =
            closePrices.length - ema20Arr.length;

        const volOffset =
            closePrices.length - volMaArr.length;

        const rsiIndex =
            lastClosedCandleIndex - rsiOffset;

        const rsiPrevIndex =
            previousClosedCandleIndex - rsiOffset;

        const adxIndex =
            lastClosedCandleIndex - adxOffset;

        const adxPrevIndex =
            previousClosedCandleIndex - adxOffset;

        const atrIndex =
            lastClosedCandleIndex - atrOffset;

        const emaIndex =
            lastClosedCandleIndex - emaOffset;

        const volIndex =
            lastClosedCandleIndex - volOffset;

        // --------------------------------------------------
        // VALIDATION
        // --------------------------------------------------

        if (
            rsiIndex < 3 ||
            rsiPrevIndex < 0 ||
            adxIndex < 1 ||
            adxPrevIndex < 0 ||
            atrIndex < 0 ||
            emaIndex < 0 ||
            volIndex < 0
        ) {
            return false;
        }

        // --------------------------------------------------
        // INDICATOR VALUES
        // --------------------------------------------------

        const lastRsi =
            rsiArr[rsiIndex];

        const prevRsi =
            rsiArr[rsiPrevIndex];

        const rsi2 =
            rsiArr[rsiIndex - 2];

        const rsi3 =
            rsiArr[rsiIndex - 3];

        const lastAdx =
            adxArr[adxIndex].adx;

        const prevAdx =
            adxArr[adxPrevIndex].adx;

        const lastAtr =
            atrArr[atrIndex];

        const lastEma20 =
            ema20Arr[emaIndex];

        const volMa =
            volMaArr[volIndex];

        // --------------------------------------------------
        // CLOSED CANDLE DATA
        // --------------------------------------------------

        const lastOpen =
            openPrices[lastClosedCandleIndex];

        const lastHigh =
            highPrices[lastClosedCandleIndex];

        const lastLow =
            lowPrices[lastClosedCandleIndex];

        const lastClose =
            closePrices[lastClosedCandleIndex];

        const currentVolume =
            volumes[lastClosedCandleIndex];

        const prevOpen =
            openPrices[previousClosedCandleIndex];

        const prevClose =
            closePrices[previousClosedCandleIndex];

        // --------------------------------------------------
        // RSI HISTORY
        // --------------------------------------------------

        const rsiHistory = [
            rsi3,
            rsi2,
            prevRsi,
            lastRsi
        ];

        const lowestRecentRsi =
            Math.min(...rsiHistory);

        const highestRecentRsi =
            Math.max(...rsiHistory);

        // --------------------------------------------------
        // RSI HOOK
        //
        // LONG:
        // RSI touched <= 30 recently
        // AND last two RSI values are rising
        //
        // SHORT:
        // RSI touched >= 70 recently
        // AND last two RSI values are falling
        // --------------------------------------------------

        const isRsiBottomHook =
            lowestRecentRsi <= RSI_OVERSOLD &&
            lastRsi > prevRsi &&
            prevRsi >= rsi2;

        const isRsiTopHook =
            highestRecentRsi >= RSI_OVERBOUGHT &&
            lastRsi < prevRsi &&
            prevRsi <= rsi2;

        // --------------------------------------------------
        // RSI DIVERGENCE
        // --------------------------------------------------

        const bullishDivergence =
            detectBullishDivergence(
                lowPrices,
                rsiArr,
                lastClosedCandleIndex,
                rsiIndex
            );

        const bearishDivergence =
            detectBearishDivergence(
                highPrices,
                rsiArr,
                lastClosedCandleIndex,
                rsiIndex
            );

        // --------------------------------------------------
        // SUPPORT / RESISTANCE
        // Use previous candles only.
        // Do not include current candle.
        // --------------------------------------------------

        const structureStart =
            Math.max(
                0,
                lastClosedCandleIndex - 12
            );

        const structureEnd =
            lastClosedCandleIndex - 2;

        const recentLows =
            lowPrices.slice(
                structureStart,
                structureEnd + 1
            );

        const recentHighs =
            highPrices.slice(
                structureStart,
                structureEnd + 1
            );

        if (
            recentLows.length < 5 ||
            recentHighs.length < 5
        ) {
            return false;
        }

        const support =
            Math.min(...recentLows);

        const resistance =
            Math.max(...recentHighs);

        // --------------------------------------------------
        // LIQUIDITY SWEEP
        // --------------------------------------------------

        const isBullishSweep =
            lastLow < support &&
            lastClose > support;

        const isBearishSweep =
            lastHigh > resistance &&
            lastClose < resistance;

        // --------------------------------------------------
        // MARKET STRUCTURE
        // --------------------------------------------------

        const isBullishBOS =
            lastClose > resistance;

        const isBearishBOS =
            lastClose < support;

        // --------------------------------------------------
        // VOLUME
        // --------------------------------------------------

        const volumeSpike =
            currentVolume > volMa * 1.8;

        const volumeAboveAverage =
            currentVolume > volMa;

        // --------------------------------------------------
        // ADX
        // --------------------------------------------------

        const adxFalling =
            lastAdx < prevAdx;

        const adxStrong =
            lastAdx >= 20;

        const sellersExhausted =
            prevAdx > 25 &&
            adxFalling;

        const buyersExhausted =
            prevAdx > 25 &&
            adxFalling;

        // --------------------------------------------------
        // CANDLE PATTERN
        // --------------------------------------------------

        const body =
            Math.abs(
                lastClose - lastOpen
            );

        const lowerWick =
            Math.min(
                lastOpen,
                lastClose
            ) - lastLow;

        const upperWick =
            lastHigh -
            Math.max(
                lastOpen,
                lastClose
            );

        let candlePattern = 'Normal';

        if (
            body > 0 &&
            lowerWick >= body * 2 &&
            upperWick <= body * 0.5
        ) {

            candlePattern =
                '🔨 Bullish Hammer';

        } else if (
            prevClose < prevOpen &&
            lastClose > lastOpen &&
            lastClose > prevOpen
        ) {

            candlePattern =
                '🐂 Bullish Engulfing';

        } else if (
            body > 0 &&
            upperWick >= body * 2 &&
            lowerWick <= body * 0.5
        ) {

            candlePattern =
                '🌠 Bearish Shooting Star';

        } else if (
            prevClose > prevOpen &&
            lastClose < lastOpen &&
            lastClose < prevOpen
        ) {

            candlePattern =
                '🐻 Bearish Engulfing';
        }

        // --------------------------------------------------
        // CANDLE CONFIRMATION
        // --------------------------------------------------

        const bullishCandle =
            candlePattern === '🔨 Bullish Hammer' ||
            candlePattern === '🐂 Bullish Engulfing';

        const bearishCandle =
            candlePattern === '🌠 Bearish Shooting Star' ||
            candlePattern === '🐻 Bearish Engulfing';

        // --------------------------------------------------
        // VWAP
        // --------------------------------------------------

        const vwapStart =
            Math.max(
                0,
                lastClosedCandleIndex - 20
            );

        const lastVwap =
            calculateVWAP(
                highPrices,
                lowPrices,
                closePrices,
                volumes,
                vwapStart,
                lastClosedCandleIndex
            );

        // --------------------------------------------------
        // EMA / VWAP LOCATION
        // --------------------------------------------------

        const priceAboveEMA =
            lastClose > lastEma20;

        const priceBelowEMA =
            lastClose < lastEma20;

        const priceAboveVWAP =
            lastClose > lastVwap;

        const priceBelowVWAP =
            lastClose < lastVwap;

        // ==================================================
        // SCORE
        // ==================================================

        let longScore = 0;
        let shortScore = 0;

        const longReasons = [];
        const shortReasons = [];

        // --------------------------------------------------
        // LONG RSI
        // --------------------------------------------------

        if (isRsiBottomHook) {

            longScore += 4;

            longReasons.push(
                `🔥 RSI Bottom Hook ${lowestRecentRsi.toFixed(1)} → ${lastRsi.toFixed(1)}`
            );
        }

        if (bullishDivergence) {

            longScore += 3;

            longReasons.push(
                '📈 Bullish RSI Divergence'
            );
        }

        // --------------------------------------------------
        // SHORT RSI
        // --------------------------------------------------

        if (isRsiTopHook) {

            shortScore += 4;

            shortReasons.push(
                `🔥 RSI Top Hook ${highestRecentRsi.toFixed(1)} → ${lastRsi.toFixed(1)}`
            );
        }

        if (bearishDivergence) {

            shortScore += 3;

            shortReasons.push(
                '📉 Bearish RSI Divergence'
            );
        }

        // --------------------------------------------------
        // LIQUIDITY
        // --------------------------------------------------

        if (isBullishSweep) {

            longScore += 3;

            longReasons.push(
                '🧹 Bullish Liquidity Sweep'
            );
        }

        if (isBearishSweep) {

            shortScore += 3;

            shortReasons.push(
                '🧹 Bearish Liquidity Sweep'
            );
        }

        // --------------------------------------------------
        // CANDLE
        // --------------------------------------------------

        if (bullishCandle) {

            longScore += 2;

            longReasons.push(
                `🕯️ ${candlePattern}`
            );
        }

        if (bearishCandle) {

            shortScore += 2;

            shortReasons.push(
                `🕯️ ${candlePattern}`
            );
        }

        // --------------------------------------------------
        // VOLUME
        // --------------------------------------------------

        if (volumeSpike) {

            longScore += 1;
            shortScore += 1;

            longReasons.push(
                '🔥 Volume Spike'
            );

            shortReasons.push(
                '🔥 Volume Spike'
            );

        } else if (volumeAboveAverage) {

            longScore += 0.5;
            shortScore += 0.5;
        }

        // --------------------------------------------------
        // ADX
        // --------------------------------------------------

        if (adxStrong) {

            longScore += 1;
            shortScore += 1;
        }

        // --------------------------------------------------
        // EXHAUSTION
        // --------------------------------------------------

        if (sellersExhausted) {

            longScore += 2;

            longReasons.push(
                '🔥 Sellers Exhausted'
            );
        }

        if (buyersExhausted) {

            shortScore += 2;

            shortReasons.push(
                '🔥 Buyers Exhausted'
            );
        }

        // --------------------------------------------------
        // EMA / VWAP
        //
        // These are confirmation only.
        // --------------------------------------------------

        if (priceAboveEMA) {

            longScore += 1;

            longReasons.push(
                '📊 Price Above EMA20'
            );
        }

        if (priceBelowEMA) {

            shortScore += 1;

            shortReasons.push(
                '📊 Price Below EMA20'
            );
        }

        if (priceAboveVWAP) {

            longScore += 1;

            longReasons.push(
                '📌 Price Above VWAP'
            );
        }

        if (priceBelowVWAP) {

            shortScore += 1;

            shortReasons.push(
                '📌 Price Below VWAP'
            );
        }

        // ==================================================
        // SIGNAL DECISION
        // ==================================================

        let side = null;
        let emoji = '';
        let score = 0;
        let setupMsg = [];

        // RSI hook is mandatory.
        // Score decides confidence.

        if (
            isRsiBottomHook &&
            longScore >= 5 &&
            longScore > shortScore
        ) {

            side = 'LONG Opportunity';

            emoji = '🟢';

            score = longScore;

            setupMsg = longReasons;

        } else if (
            isRsiTopHook &&
            shortScore >= 5 &&
            shortScore > longScore
        ) {

            side = 'SHORT Opportunity';

            emoji = '🔴';

            score = shortScore;

            setupMsg = shortReasons;
        }

        // No signal
        if (!side) {
            return false;
        }

        // ==================================================
        // CONFIDENCE
        // ==================================================

        let confidence = 'MEDIUM';

        if (score >= 10) {

            confidence = 'HIGH';

        } else if (score >= 7) {

            confidence = 'MEDIUM';

        } else {

            confidence = 'LOW';
        }

        // ==================================================
        // FUNDING + OI
        // ==================================================

        let fundingStr = 'N/A';

        let oiStr = 'N/A';

        let liqData = 'Normal';

        try {

            const funding =
                await exchange.fetchFundingRate(symbol);

            if (
                funding &&
                Number.isFinite(
                    funding.fundingRate
                )
            ) {

                const fr =
                    funding.fundingRate * 100;

                fundingStr =
                    `${fr.toFixed(4)}%`;

                if (
                    side.includes('LONG') &&
                    fr < -0.01
                ) {

                    liqData =
                        '🔥 Short-Squeeze Risk';

                }

                if (
                    side.includes('SHORT') &&
                    fr > 0.01
                ) {

                    liqData =
                        '🔥 Long-Liquidation Risk';
                }
            }

        } catch (error) {

            console.error(
                `Funding error ${symbol}:`,
                error.message
            );
        }

        try {

            const oiData =
                await exchange.fetchOpenInterest(symbol);

            if (
                oiData &&
                Number.isFinite(
                    oiData.openInterestValue
                )
            ) {

                oiStr =
                    `$${(
                        oiData.openInterestValue /
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
        // SL / TP
        // ==================================================

        let sl;
        let tp1;
        let tp2;

        if (side.includes('LONG')) {

            // Swing low + ATR protection
            sl =
                Math.min(
                    lastLow,
                    support
                ) -
                lastAtr * 0.5;

            tp1 =
                lastClose +
                lastAtr * 2;

            tp2 =
                lastClose +
                lastAtr * 3.5;

        } else {

            sl =
                Math.max(
                    lastHigh,
                    resistance
                ) +
                lastAtr * 0.5;

            tp1 =
                lastClose -
                lastAtr * 2;

            tp2 =
                lastClose -
                lastAtr * 3.5;
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
            timestamps[lastClosedCandleIndex];

        const key =
            signalKey(
                symbol,
                timeframe,
                side,
                candleTimestamp
            );

        if (sentSignals.has(key)) {

            return false;
        }

        sentSignals.add(key);

        // Keep memory manageable
        if (sentSignals.size > 5000) {

            const first =
                sentSignals.values().next().value;

            sentSignals.delete(first);
        }

        // ==================================================
        // CHART
        // ==================================================

        const baseAsset =
            symbol.split('/')[0];

        const tradingViewUrl =
            `https://www.tradingview.com/chart/?symbol=BITGET:${baseAsset}USDT.P`;

        // ==================================================
        // ADX STATUS
        // ==================================================

        let adxStatus = 'Normal';

        if (
            side.includes('LONG') &&
            sellersExhausted
        ) {

            adxStatus =
                '🔥 Sellers Exhausted';

        } else if (
            side.includes('SHORT') &&
            buyersExhausted
        ) {

            adxStatus =
                '🔥 Buyers Exhausted';

        } else if (lastAdx >= 30) {

            adxStatus =
                '💪 Strong Trend';

        } else if (lastAdx < 20) {

            adxStatus =
                '⚠️ Weak Trend';
        }

        // ==================================================
        // MESSAGE
        // ==================================================

        const message = `
${emoji} *${side}*
━━━━━━━━━━━━━━━━━━━━

🎯 *Confidence:* ${confidence}
⭐ *Score:* ${score.toFixed(1)}

🪙 *Coin:* #${baseAsset}
⏰ *Timeframe:* ${timeframe}

💰 *Entry Price:* ${lastClose}

━━━━━━━━━━━━━━━━━━━━
🧩 *REVERSAL CONFIRMATIONS*

${setupMsg.map(x => '✅ ' + x).join('\n')}

━━━━━━━━━━━━━━━━━━━━
📊 *TECHNICALS*

*RSI:* ${prevRsi.toFixed(1)} ➡️ ${lastRsi.toFixed(1)}
*RSI Recent Low:* ${lowestRecentRsi.toFixed(1)}
*RSI Recent High:* ${highestRecentRsi.toFixed(1)}

*EMA 20:* ${lastEma20.toFixed(6)}
*VWAP:* ${lastVwap.toFixed(6)}

*ADX:* ${lastAdx.toFixed(1)}
*ADX Status:* ${adxStatus}

*Volume:* ${
    volumeSpike
        ? '🔥 SPIKE'
        : volumeAboveAverage
            ? 'Above Average'
            : 'Normal'
}

*Pattern:* ${candlePattern}

━━━━━━━━━━━━━━━━━━━━
🏦 *DERIVATIVES*

*Open Interest:* ${oiStr}
*Funding:* ${fundingStr}
*Risk:* ${liqData}

━━━━━━━━━━━━━━━━━━━━
🎯 *TRADE LEVELS*

*Entry:* ${lastClose}

*TP1:* ${tp1.toPrecision(6)}
*TP2:* ${tp2.toPrecision(6)}

*SL:* ${sl.toPrecision(6)}

*R:R TP1:* 1:${rr1.toFixed(2)}
*R:R TP2:* 1:${rr2.toFixed(2)}

━━━━━━━━━━━━━━━━━━━━
📌 *STRUCTURE*

*Support:* ${support.toPrecision(6)}
*Resistance:* ${resistance.toPrecision(6)}

*Bullish Sweep:* ${
    isBullishSweep ? '✅' : '❌'
}

*Bearish Sweep:* ${
    isBearishSweep ? '✅' : '❌'
}

*Bullish Divergence:* ${
    bullishDivergence ? '✅' : '❌'
}

*Bearish Divergence:* ${
    bearishDivergence ? '✅' : '❌'
}

━━━━━━━━━━━━━━━━━━━━
⚠️ *Signal is based on closed candles.*
Use proper position sizing and risk management.

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

        console.log(
            `SIGNAL ${symbol} ${timeframe} ${side} Score=${score}`
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
            'Starting Smart RSI Reversal Scanner...'
        );

        const coins =
            await getFilteredPairs();

        if (!coins.length) {

            await bot.sendMessage(
                chatId,
                '⚠️ No coins found after filtering.'
            );

            return;
        }

        await bot.sendMessage(
            chatId,
            `🔍 *Smart RSI Reversal Scanner Started*

💰 Price Filter: < $${MAX_PRICE}
📊 Volume: > $${MIN_QUOTE_VOLUME.toLocaleString()}
🪙 Coins: ${coins.length}
⏰ Timeframes: 4H / 1D / 1W

🎯 RSI Bottom/Top Hook + Divergence + Liquidity + Volume + EMA + VWAP + ADX`
            ,
            {
                parse_mode: 'Markdown'
            }
        );

        let totalSignals = 0;

        // ==================================================
        // TIMEFRAME FIRST
        // ==================================================

        for (const timeframe of TIMEFRAMES) {

            console.log(
                `Scanning ${timeframe}...`
            );

            for (const coin of coins) {

                const signalFound =
                    await analyzeCoin(
                        coin,
                        timeframe
                    );

                if (signalFound) {

                    totalSignals++;
                }

                // Small delay
                await sleep(300);
            }
        }

        const duration =
            (
                (Date.now() - startTime) /
                1000
            ).toFixed(1);

        const statusMessage =
            totalSignals === 0
                ? `✅ *Scan Finished*

No valid RSI reversal setups found.

🪙 Coins: ${coins.length}
⏰ TF: 4H / 1D / 1W
⏱️ Time: ${duration}s`
                : `✅ *Scan Finished*

🎯 Signals Found: *${totalSignals}*

🪙 Coins: ${coins.length}
⏰ TF: 4H / 1D / 1W
⏱️ Time: ${duration}s`;

        await bot.sendMessage(
            chatId,
            statusMessage,
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
