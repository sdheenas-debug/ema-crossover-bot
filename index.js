import ccxt from 'ccxt';
import pkg from 'technicalindicators';
const { EMA, RSI, ADX, ATR, SMA } = pkg;
import TelegramBot from 'node-telegram-bot-api';

const token = process.env.TELEGRAM_TOKEN;
const chatId = process.env.CHAT_ID;
const bot = new TelegramBot(token);

const exchange = new ccxt.bitget({
    'options': { 'defaultType': 'swap' },
    'enableRateLimit': true
});

const timeframes = ['4h', '1d', '1w'];
const majorCoins = ['BTC/USDT', 'BNB/USDT', 'SOL/USDT', 'ETH/USDT'];

async function getFilteredPairs() {
    try {
        const tickers = await exchange.fetchTickers();
        let filteredSymbols = [];
        for (const symbol in tickers) {
            const ticker = tickers[symbol];
            const base = symbol.split(':')[0];
            const isMajor = majorCoins.includes(base);
            const isCheap = ticker.last < 10 && symbol.endsWith('USDT');

            if ((isMajor || isCheap) && ticker.quoteVolume > 1000000) {
                filteredSymbols.push(symbol);
            }
        }
        filteredSymbols.sort((a, b) => tickers[b].quoteVolume - tickers[a].quoteVolume);
        return filteredSymbols.slice(0, 150); // Top 150
    } catch (e) { return []; }
}

async function analyzeCoin(symbol, timeframe) {
    try {
        const candles = await exchange.fetchOHLCV(symbol, timeframe, undefined, 100);
        if (candles.length < 50) return false;

        const openPrices = candles.map(c => c[1]);
        const highPrices = candles.map(c => c[2]);
        const lowPrices = candles.map(c => c[3]);
        const closePrices = candles.map(c => c[4]);
        const volumes = candles.map(c => c[5]);

        const lastIndex = closePrices.length - 2; // Last completely closed candle
        const prevIndex = closePrices.length - 3; // Previous closed candle

        // 1. INDICATORS
        const rsiArr = RSI.calculate({ period: 14, values: closePrices });
        const adxArr = ADX.calculate({ high: highPrices, low: lowPrices, close: closePrices, period: 14 });
        const atrArr = ATR.calculate({ high: highPrices, low: lowPrices, close: closePrices, period: 14 });
        const ema20Arr = EMA.calculate({ period: 20, values: closePrices });
        const volMaArr = SMA.calculate({ period: 20, values: volumes });

        if (!rsiArr[lastIndex] || !adxArr[lastIndex] || !ema20Arr[lastIndex]) return false;

        const lastRsi = rsiArr[lastIndex];
        const prevRsi = rsiArr[prevIndex];
        const lastAdx = adxArr[lastIndex].adx;
        const prevAdx = adxArr[prevIndex].adx;
        const lastAtr = atrArr[lastIndex];
        const lastEma20 = ema20Arr[lastIndex];
        const volMa = volMaArr[lastIndex];

        // 2. VWAP Calculation
        let sumTPV = 0, sumVol = 0;
        for(let i = lastIndex - 20; i <= lastIndex; i++) {
             let typicalPrice = (highPrices[i] + lowPrices[i] + closePrices[i]) / 3;
             sumTPV += typicalPrice * volumes[i];
             sumVol += volumes[i];
        }
        const lastVwap = sumTPV / sumVol;

        const lastClose = closePrices[lastIndex];
        const lastOpen = openPrices[lastIndex];
        const lastHigh = highPrices[lastIndex];
        const lastLow = lowPrices[lastIndex];
        const currentVol = volumes[lastIndex];

        const prevClose = closePrices[prevIndex];
        const prevOpen = openPrices[prevIndex];

        // 3. SMC LOGIC: Support/Resistance, Sweep & BOS/CHoCH
        const recentLows = lowPrices.slice(-12, -2);
        const recentHighs = highPrices.slice(-12, -2);
        const support = Math.min(...recentLows);
        const resistance = Math.max(...recentHighs);

        const isBullishSweep = lastLow < support && lastClose > support;
        const isBearishSweep = lastHigh > resistance && lastClose < resistance;
        const isBullishChoch = lastClose > resistance;
        const isBearishChoch = lastClose < support;

        const volSpike = currentVol > (volMa * 1.8); 
        const isExhausted = prevAdx > 25 && lastAdx < prevAdx;

        // 4. Candlestick Patterns
        const body = Math.abs(lastClose - lastOpen);
        const lowerWick = Math.min(lastOpen, lastClose) - lastLow;
        const upperWick = lastHigh - Math.max(lastOpen, lastClose);

        let candlePattern = "Normal";
        if (lowerWick >= 2 * body && upperWick <= body * 0.5 && body > 0) candlePattern = "🔨 Bullish Hammer";
        else if (prevClose < prevOpen && lastClose > lastOpen && lastClose > prevOpen) candlePattern = "🐂 Bullish Engulfing";
        else if (upperWick >= 2 * body && lowerWick <= body * 0.5 && body > 0) candlePattern = "🌠 Bearish Shooting Star";
        else if (prevClose > prevOpen && lastClose < lastOpen && lastClose < prevOpen) candlePattern = "🐻 Bearish Engulfing";

        let side = "", emoji = "", setupMsg = [];

        // ==========================================
        // STRICT TRIGGER: ONLY RSI TOP & BOTTOM HOOKS
        // ==========================================
        const isRsiBottomHook = (prevRsi <= 30 && lastRsi > prevRsi);
        const isRsiTopHook = (prevRsi >= 70 && lastRsi < prevRsi);

        if (isRsiBottomHook) {
            side = "LONG Opportunity"; emoji = "🟢";
            setupMsg.push("🔥 RSI Hook UP (Exact Bottom Caught)");
            // Adding SMC confirmations IF they happened at the same time
            if (isBullishSweep) setupMsg.push("🧹 Liquidity Sweep (Stop Hunt)");
            if (isBullishChoch) setupMsg.push("📈 BOS/CHoCH (Broke Resistance)");
        } 
        else if (isRsiTopHook) {
            side = "SHORT Opportunity"; emoji = "🔴";
            setupMsg.push("🔥 RSI Hook DOWN (Exact Top Caught)");
            // Adding SMC confirmations IF they happened at the same time
            if (isBearishSweep) setupMsg.push("🧹 Liquidity Sweep (Bull Trap)");
            if (isBearishChoch) setupMsg.push("📉 BOS/CHoCH (Broke Support)");
        }

        // If the strict RSI rule is met, send message
        if (side) {
            let fundingStr = "N/A", oiStr = "N/A", liqData = "Normal";
            try {
                const funding = await exchange.fetchFundingRate(symbol);
                if (funding && funding.fundingRate) {
                    const fr = funding.fundingRate * 100;
                    fundingStr = `${fr.toFixed(4)}%`;
                    if (side.includes("LONG") && fr < -0.01) liqData = "🔥 High Short-Squeeze Risk";
                    if (side.includes("SHORT") && fr > 0.01) liqData = "🔥 Long-Liquidation Cascade";
                }
                const oiData = await exchange.fetchOpenInterest(symbol);
                if (oiData && oiData.openInterestValue) {
                    oiStr = `$${(oiData.openInterestValue / 1000000).toFixed(2)}M`;
                }
            } catch (e) {}

            const baseAsset = symbol.split('/')[0];
            const binanceChartUrl = `https://www.tradingview.com/chart/?symbol=BINANCE:${baseAsset}USDT.P`;
            
            let sl = side.includes("LONG") ? lastLow - (lastAtr * 0.5) : lastHigh + (lastAtr * 0.5);
            let tp1 = side.includes("LONG") ? lastClose + (lastAtr * 2.0) : lastClose - (lastAtr * 2.0);
            let tp2 = side.includes("LONG") ? lastClose + (lastAtr * 3.5) : lastClose - (lastAtr * 3.5);

            let adxStatus = side.includes("LONG") 
                ? (isExhausted ? "🔥 SELLERS EXHAUSTED" : "⚠️ Falling Knife (Wait)")
                : (isExhausted ? "🔥 BUYERS EXHAUSTED" : "⚠️ Still Pumping (Wait)");

            const message = `
${emoji} *${side}*
--------------------------
🧩 *Smart Money Triggers:*
${setupMsg.map(s => "✅ " + s).join("\n")}
--------------------------
🪙 *Coin:* #${baseAsset} | ⏰ *TF:* ${timeframe}
💰 *Price:* ${lastClose}
--------------------------
📊 *TECHNICALS:*
*RSI:* ${prevRsi.toFixed(1)} ➡️ ${lastRsi.toFixed(1)} (${lastRsi > prevRsi ? "⬆️ Rising" : "⬇️ Falling"})
*EMA 20:* ${lastEma20.toFixed(4)}
*VWAP:* ${lastVwap.toFixed(4)}
*ADX Trend:* ${adxStatus}
*Volume:* ${volSpike ? "🔥 VOLUME SPIKE" : "Normal"}
*Pattern:* ${candlePattern}
--------------------------
🏦 *ORDER FLOW / DERIVATIVES:*
*Open Interest:* ${oiStr}
*Funding Rate:* ${fundingStr}
*Liquidation Data:* ${liqData}
--------------------------
💵 *Take Profit:* ${tp1.toPrecision(5)} | ${tp2.toPrecision(5)}
🛑 *Stop Loss:* ${sl.toPrecision(5)}
--------------------------
🔗 [Open Binance Chart](${binanceChartUrl})`;
            
            await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
            return true;
        }
    } catch (e) {}
    return false;
}

async function run() {
    try {
        const coins = await getFilteredPairs();
        let totalSignals = 0;

        await bot.sendMessage(chatId, `🔍 *Strict RSI Reversal & SMC Bot*\nTracking Top & Bottom Hooks ONLY...\nScanning Top ${coins.length} Coins...`);

        for (const tf of timeframes) {
            for (const coin of coins) {
                const signalFound = await analyzeCoin(coin, tf);
                if (signalFound) totalSignals++;
                await new Promise(res => setTimeout(res, 500));
            }
        }

        const statusMsg = totalSignals === 0 
            ? "✅ Scan Finished: No Exact RSI Reversals found." 
            : `✅ Scan Finished: Caught ${totalSignals} Perfect RSI Reversals.`;
        await bot.sendMessage(chatId, statusMsg);
    } catch (error) { console.error("Run Error:", error.message); }
}

run();
