import ccxt from 'ccxt';
import pkg from 'technicalindicators';
const { EMA, RSI, ADX, ATR, SMA } = pkg;
import TelegramBot from 'node-telegram-bot-api';

const token = process.env.TELEGRAM_TOKEN;
const chatId = process.env.CHAT_ID;

if (!token || !chatId) {
    throw new Error('TELEGRAM_TOKEN or CHAT_ID is missing');
}

const bot = new TelegramBot(token);

const exchange = new ccxt.bitget({
    'options': { 'defaultType': 'swap' },
    'enableRateLimit': true
});

// Only 4h, 1d, 1w are active.
const timeframes = ['4h', '1d', '1w'];

const majorCoins = [
    'BTC/USDT',
    'BNB/USDT',
    'SOL/USDT',
    'ETH/USDT'
];

async function getFilteredPairs() {
    try {

        const tickers = await exchange.fetchTickers();

        let filteredSymbols = [];

        for (const symbol in tickers) {

            try {

                const ticker = tickers[symbol];

                if (!ticker) continue;

                const base = symbol.split(':')[0];

                const isMajor =
                    majorCoins.includes(base);

                const isCheap =
                    ticker.last < 15 &&
                    symbol.endsWith('USDT');

                if (
                    (isMajor || isCheap) &&
                    ticker.quoteVolume > 500000
                ) {
                    filteredSymbols.push(symbol);
                }

            } catch (e) {
                console.error(
                    `Ticker error ${symbol}:`,
                    e.message
                );
            }
        }

        filteredSymbols.sort(
            (a, b) =>
                tickers[b].quoteVolume -
                tickers[a].quoteVolume
        );

        return filteredSymbols.slice(0, 600);

    } catch (e) {

        console.error(
            'getFilteredPairs Error:',
            e.message
        );

        return [];
    }
}

async function analyzeCoin(symbol, timeframe) {

    try {

        // =====================================================
        // OHLCV
        // =====================================================

        const candles =
            await exchange.fetchOHLCV(
                symbol,
                timeframe,
                undefined,
                100
            );

        if (candles.length < 50) {
            return false;
        }

        const openPrices =
            candles.map(c => c[1]);

        const highPrices =
            candles.map(c => c[2]);

        const lowPrices =
            candles.map(c => c[3]);

        const closePrices =
            candles.map(c => c[4]);

        const volumes =
            candles.map(c => c[5]);

        // Last completely CLOSED candle.
        const lastIndex =
            closePrices.length - 2;

        const previousIndex =
            closePrices.length - 3;

        // =====================================================
        // INDICATORS
        // =====================================================

        const rsiArr =
            RSI.calculate({
                period: 14,
                values: closePrices
            });

        const adxArr =
            ADX.calculate({
                high: highPrices,
                low: lowPrices,
                close: closePrices,
                period: 14
            });

        const atrArr =
            ATR.calculate({
                high: highPrices,
                low: lowPrices,
                close: closePrices,
                period: 14
            });

        const ema20Arr =
            EMA.calculate({
                period: 20,
                values: closePrices
            });

        const volMaArr =
            SMA.calculate({
                period: 20,
                values: volumes
            });

        // =====================================================
        // CORRECT INDICATOR ALIGNMENT
        // =====================================================

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

        const rsiLastIndex =
            lastIndex - rsiOffset;

        const adxLastIndex =
            lastIndex - adxOffset;

        const atrLastIndex =
            lastIndex - atrOffset;

        const emaLastIndex =
            lastIndex - emaOffset;

        const volLastIndex =
            lastIndex - volOffset;

        if (
            rsiLastIndex < 6 ||
            adxLastIndex < 1 ||
            atrLastIndex < 0 ||
            emaLastIndex < 0 ||
            volLastIndex < 0
        ) {
            return false;
        }

        // =====================================================
        // RSI VALUES
        // =====================================================

        const lastRsi =
            rsiArr[rsiLastIndex];

        const prevRsi =
            rsiArr[rsiLastIndex - 1];

        const rsi2 =
            rsiArr[rsiLastIndex - 2];

        const rsi3 =
            rsiArr[rsiLastIndex - 3];

        const rsi4 =
            rsiArr[rsiLastIndex - 4];

        const rsi5 =
            rsiArr[rsiLastIndex - 5];

        const rsi6 =
            rsiArr[rsiLastIndex - 6];

        // =====================================================
        // OTHER INDICATORS
        // =====================================================

        const lastAdx =
            adxArr[adxLastIndex].adx;

        const prevAdx =
            adxArr[adxLastIndex - 1].adx;

        const lastAtr =
            atrArr[atrLastIndex];

        const lastEma20 =
            ema20Arr[emaLastIndex];

        const volMa =
            volMaArr[volLastIndex];

        // =====================================================
        // CURRENT CLOSED CANDLE
        // =====================================================

        const lastOpen =
            openPrices[lastIndex];

        const lastHigh =
            highPrices[lastIndex];

        const lastLow =
            lowPrices[lastIndex];

        const lastClose =
            closePrices[lastIndex];

        const currentVol =
            volumes[lastIndex];

        const prevClose =
            closePrices[previousIndex];

        const prevOpen =
            openPrices[previousIndex];

        // =====================================================
        // VWAP
        // =====================================================

        let sumTPV = 0;
        let sumVol = 0;

        for (
            let i = lastIndex - 20;
            i <= lastIndex;
            i++
        ) {

            const typicalPrice =
                (
                    highPrices[i] +
                    lowPrices[i] +
                    closePrices[i]
                ) / 3;

            sumTPV +=
                typicalPrice * volumes[i];

            sumVol += volumes[i];
        }

        const lastVwap =
            sumVol > 0
                ? sumTPV / sumVol
                : 0;

        // =====================================================
        // SMC
        // =====================================================

        const recentLows =
            lowPrices.slice(-12, -2);

        const recentHighs =
            highPrices.slice(-12, -2);

        const support =
            Math.min(...recentLows);

        const resistance =
            Math.max(...recentHighs);

        const isBullishSweep =
            lastLow < support &&
            lastClose > support;

        const isBearishSweep =
            lastHigh > resistance &&
            lastClose < resistance;

        const isBullishChoch =
            lastClose > resistance;

        const isBearishChoch =
            lastClose < support;

        const volSpike =
            currentVol > volMa * 1.8;

        const isExhausted =
            prevAdx > 25 &&
            lastAdx < prevAdx;

        // =====================================================
        // CANDLE PATTERNS
        // =====================================================

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

        let candlePattern = "Normal";

        if (
            lowerWick >= 2 * body &&
            upperWick <= body * 0.5 &&
            body > 0
        ) {

            candlePattern =
                "🔨 Bullish Hammer";

        } else if (
            prevClose < prevOpen &&
            lastClose > lastOpen &&
            lastClose > prevOpen
        ) {

            candlePattern =
                "🐂 Bullish Engulfing";

        } else if (
            upperWick >= 2 * body &&
            lowerWick <= body * 0.5 &&
            body > 0
        ) {

            candlePattern =
                "🌠 Bearish Shooting Star";

        } else if (
            prevClose > prevOpen &&
            lastClose < lastOpen &&
            lastClose < prevOpen
        ) {

            candlePattern =
                "🐻 Bearish Engulfing";
        }

        // =====================================================
        // 🟢 NEW RSI CONFIRMED BOTTOM LOGIC
        // =====================================================
        //
        // Example:
        //
        // 35 → 31 → 27 → 25 → 26 → 28
        //              ↓    ↑     ↑
        //            BOTTOM      CONFIRMED
        //
        // RSI must:
        //
        // 1. Reach <= 30
        // 2. Create a local bottom
        // 3. Rise for TWO closed candles
        //
        // =====================================================

        const bottomCandidate =
            rsi2 <= 30 &&
            rsi2 < rsi3 &&
            rsi2 < prevRsi;

        const confirmedLong =
            bottomCandidate &&
            prevRsi > rsi2 &&
            lastRsi > prevRsi;

        // =====================================================
        // 🔴 NEW RSI CONFIRMED TOP LOGIC
        // =====================================================
        //
        // Example:
        //
        // 65 → 69 → 73 → 75 → 74 → 72
        //              ↑    ↓     ↓
        //             TOP      CONFIRMED
        //
        // =====================================================

        const topCandidate =
            rsi2 >= 70 &&
            rsi2 > rsi3 &&
            rsi2 > prevRsi;

        const confirmedShort =
            topCandidate &&
            prevRsi < rsi2 &&
            lastRsi < prevRsi;

        // =====================================================
        // SIGNAL
        // =====================================================

        let side = "";
        let emoji = "";
        let setupMsg = [];

        if (confirmedLong) {

            side =
                "LONG Opportunity";

            emoji = "🟢";

            setupMsg.push(
                `🔥 RSI Bottom Confirmed (${rsi2.toFixed(1)} ➡️ ${prevRsi.toFixed(1)} ➡️ ${lastRsi.toFixed(1)})`
            );

            if (isBullishSweep) {

                setupMsg.push(
                    "🧹 Liquidity Sweep (Stop Hunt)"
                );
            }

            if (isBullishChoch) {

                setupMsg.push(
                    "📈 BOS/CHoCH (Broke Resistance)"
                );
            }

        } else if (confirmedShort) {

            side =
                "SHORT Opportunity";

            emoji = "🔴";

            setupMsg.push(
                `🔥 RSI Top Confirmed (${rsi2.toFixed(1)} ➡️ ${prevRsi.toFixed(1)} ➡️ ${lastRsi.toFixed(1)})`
            );

            if (isBearishSweep) {

                setupMsg.push(
                    "🧹 Liquidity Sweep (Bull Trap)"
                );
            }

            if (isBearishChoch) {

                setupMsg.push(
                    "📉 BOS/CHoCH (Broke Support)"
                );
            }
        }

        // =====================================================
        // NO SIGNAL
        // =====================================================

        if (!side) {
            return false;
        }

        // =====================================================
        // FUNDING + OPEN INTEREST
        // =====================================================

        let fundingStr = "N/A";
        let oiStr = "N/A";
        let liqData = "Normal";

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

                const fr =
                    funding.fundingRate * 100;

                fundingStr =
                    `${fr.toFixed(4)}%`;

                if (
                    side.includes("LONG") &&
                    fr < -0.01
                ) {

                    liqData =
                        "🔥 High Short-Squeeze Risk";
                }

                if (
                    side.includes("SHORT") &&
                    fr > 0.01
                ) {

                    liqData =
                        "🔥 Long-Liquidation Cascade";
                }
            }

            const oiData =
                await exchange.fetchOpenInterest(
                    symbol
                );

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

        } catch (e) {

            console.error(
                `Funding/OI error ${symbol}:`,
                e.message
            );
        }

        // =====================================================
        // CHART
        // =====================================================

        const baseAsset =
            symbol.split('/')[0];

        const binanceChartUrl =
            `https://www.tradingview.com/chart/?symbol=BINANCE:${baseAsset}USDT.P`;

        // =====================================================
        // ATR SL / TP
        // =====================================================

        let sl =
            side.includes("LONG")
                ? lastLow - (lastAtr * 0.5)
                : lastHigh + (lastAtr * 0.5);

        let tp1 =
            side.includes("LONG")
                ? lastClose + (lastAtr * 2.0)
                : lastClose - (lastAtr * 2.0);

        let tp2 =
            side.includes("LONG")
                ? lastClose + (lastAtr * 3.5)
                : lastClose - (lastAtr * 3.5);

        // =====================================================
        // ADX STATUS
        // =====================================================

        let adxStatus =
            side.includes("LONG")
                ? (
                    isExhausted
                        ? "🔥 SELLERS EXHAUSTED"
                        : "⚠️ Falling Knife (Wait)"
                )
                : (
                    isExhausted
                        ? "🔥 BUYERS EXHAUSTED"
                        : "⚠️ Still Pumping (Wait)"
                );

        // =====================================================
        // TELEGRAM MESSAGE
        // =====================================================

        const message = `
${emoji} *${side}*
--------------------------
🧩 *Smart Money Triggers:*

${setupMsg.map(s => "✅ " + s).join("\n")}

--------------------------
🪙 *Coin:* #${baseAsset}
⏰ *TF:* ${timeframe}

💰 *Price:* ${lastClose}

--------------------------
📊 *RSI REVERSAL:*

*RSI Pattern:*
${rsi6.toFixed(1)} → ${rsi5.toFixed(1)} → ${rsi4.toFixed(1)} → ${rsi3.toFixed(1)} → ${rsi2.toFixed(1)} → ${prevRsi.toFixed(1)} → ${lastRsi.toFixed(1)}

*Current RSI:* ${lastRsi.toFixed(1)}

*Bottom:* ${
    confirmedLong
        ? `🟢 ${rsi2.toFixed(1)}`
        : "N/A"
}

*Top:* ${
    confirmedShort
        ? `🔴 ${rsi2.toFixed(1)}`
        : "N/A"
}

*RSI Trend:* ${
    lastRsi > prevRsi
        ? "⬆️ Rising"
        : "⬇️ Falling"
}

--------------------------
📊 *TECHNICALS:*

*EMA 20:* ${lastEma20.toFixed(4)}

*VWAP:* ${lastVwap.toFixed(4)}

*ADX Trend:* ${adxStatus}

*Volume:* ${
    volSpike
        ? "🔥 VOLUME SPIKE"
        : "Normal"
}

*Pattern:* ${candlePattern}

--------------------------
🏦 *ORDER FLOW / DERIVATIVES:*

*Open Interest:* ${oiStr}

*Funding Rate:* ${fundingStr}

*Liquidation Data:* ${liqData}

--------------------------
💵 *TAKE PROFIT:*

TP1: ${tp1.toPrecision(5)}

TP2: ${tp2.toPrecision(5)}

🛑 *STOP LOSS:*

${sl.toPrecision(5)}

--------------------------
🔗 [Open Binance Chart](${binanceChartUrl})
`;

        await bot.sendMessage(
            chatId,
            message,
            {
                parse_mode: 'Markdown'
            }
        );

        console.log(
            `SIGNAL: ${symbol} | ${timeframe} | ${side}`
        );

        return true;

    } catch (e) {

        console.error(
            `Analyze Error ${symbol} ${timeframe}:`,
            e.message
        );

        return false;
    }
}

// =====================================================
// MAIN RUN
// =====================================================

async function run() {

    try {

        const coins =
            await getFilteredPairs();

        let totalSignals = 0;

        await bot.sendMessage(
            chatId,
            `🔍 *Smart RSI Reversal Bot Started*

Price < $15
Scanning ${coins.length} Coins...

Timeframes:
4H / 1D / 1W

🟢 RSI Bottom → Recovery → LONG
🔴 RSI Top → Recovery → SHORT`,
            {
                parse_mode: 'Markdown'
            }
        );

        // =================================================
        // SCAN
        // =================================================

        for (const tf of timeframes) {

            console.log(
                `Starting ${tf} scan...`
            );

            for (const coin of coins) {

                const signalFound =
                    await analyzeCoin(
                        coin,
                        tf
                    );

                if (signalFound) {
                    totalSignals++;
                }

                await new Promise(
                    res => setTimeout(res, 500)
                );
            }
        }

        // =================================================
        // FINISH
        // =================================================

        const statusMsg =
            totalSignals === 0

                ? "✅ Scan Finished: No Confirmed RSI Reversals found."

                : `✅ Scan Finished: Caught ${totalSignals} Confirmed RSI Reversals.`;

        await bot.sendMessage(
            chatId,
            statusMsg
        );

    } catch (error) {

        console.error(
            "Run Error:",
            error.message
        );

        try {

            await bot.sendMessage(
                chatId,
                `❌ Scanner Error\n${error.message}`
            );

        } catch {}
    }
}

// =====================================================
// START
// =====================================================

run();
