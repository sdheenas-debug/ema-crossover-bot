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

const timeframes = ['1h', '4h', '1d'];

async function getFilteredPairs() {
    try {
        const tickers = await exchange.fetchTickers();
        let filteredSymbols = [];
        for (const symbol in tickers) {
            const ticker = tickers[symbol];
            if (symbol.endsWith('USDT') && ticker.quoteVolume > 1000000) {
                filteredSymbols.push(symbol);
            }
        }
        filteredSymbols.sort((a, b) => tickers[b].quoteVolume - tickers[a].quoteVolume);
        return filteredSymbols.slice(0, 150); // Top 150 High Volume Coins
    } catch (e) { return []; }
}

async function analyzeCoin(symbol, timeframe) {
    try {
        const candles = await exchange.fetchOHLCV(symbol, timeframe, undefined, 100);
        if (candles.length < 50) return false;

        const highPrices = candles.map(c => c[2]);
        const lowPrices = candles.map(c => c[3]);
        const closePrices = candles.map(c => c[4]);
        const volumes = candles.map(c => c[5]);

        // 1. STANDARD INDICATORS
        const ema20Arr = EMA.calculate({ period: 20, values: closePrices });
        const rsiArr = RSI.calculate({ period: 14, values: closePrices });
        const adxArr = ADX.calculate({ high: highPrices, low: lowPrices, close: closePrices, period: 14 });
        const atrArr = ATR.calculate({ high: highPrices, low: lowPrices, close: closePrices, period: 14 });
        const volMaArr = SMA.calculate({ period: 20, values: volumes });

        const currentEma20 = ema20Arr[ema20Arr.length - 1];
        const currentRsi = rsiArr[rsiArr.length - 1];
        const currentAdx = adxArr[adxArr.length - 1].adx;
        const currentAtr = atrArr[atrArr.length - 1];
        const currentVolMa = volMaArr[volMaArr.length - 1];

        // Custom VWAP Calculation (Rolling 20 periods)
        let sumTPV = 0, sumVol = 0;
        for(let i = closePrices.length - 20; i < closePrices.length; i++) {
             let typicalPrice = (highPrices[i] + lowPrices[i] + closePrices[i]) / 3;
             sumTPV += typicalPrice * volumes[i];
             sumVol += volumes[i];
        }
        const currentVwap = sumTPV / sumVol;

        // Current & Previous Candle Data
        const currentClose = closePrices[closePrices.length - 1];
        const currentHigh = highPrices[highPrices.length - 1];
        const currentLow = lowPrices[lowPrices.length - 1];
        const currentVol = volumes[volumes.length - 1];

        // 2. SMC PRICE ACTION LOGIC (Support/Resistance & Liquidity Sweep)
        // Find recent Swing Low (Support) and Swing High (Resistance) from previous 5 to 10 candles
        const recentLows = lowPrices.slice(-10, -2);
        const recentHighs = highPrices.slice(-10, -2);
        const swingLowSupport = Math.min(...recentLows);
        const swingHighResistance = Math.max(...recentHighs);

        // Bullish Liquidity Sweep: Wicks below support but closes back inside/above
        const isBullishLiqSweep = currentLow < swingLowSupport && currentClose > swingLowSupport;
        // Bearish Liquidity Sweep: Wicks above resistance but closes back inside/below
        const isBearishLiqSweep = currentHigh > swingHighResistance && currentClose < swingHighResistance;

        // CHoCH / BOS Logic
        const isBullishChoch = currentClose > swingHighResistance;
        const isBearishChoch = currentClose < swingLowSupport;

        // Volume Anomaly (Liquidation footprint)
        const isVolSpike = currentVol > (currentVolMa * 1.8);

        let side = "", emoji = "", setupDetails = [];

        // --- LONG ENTRY SETUP ---
        if (isBullishLiqSweep || (isBullishChoch && currentClose > currentVwap)) {
            if (isVolSpike) { // Smart money is entering
                side = "LONG (SMC Setup)"; emoji = "🟢";
                if (isBullishLiqSweep) setupDetails.push("🧹 Bullish Liquidity Sweep (Stop Hunt)");
                if (isBullishChoch) setupDetails.push("📈 CHoCH (Trend Reversal)");
                if (currentClose > currentVwap) setupDetails.push("⚖️ Price Above VWAP");
                if (currentEma20 > currentVwap) setupDetails.push("✅ EMA 20 Confirming");
            }
        }
        // --- SHORT ENTRY SETUP ---
        else if (isBearishLiqSweep || (isBearishChoch && currentClose < currentVwap)) {
            if (isVolSpike) { // Smart money is entering
                side = "SHORT (SMC Setup)"; emoji = "🔴";
                if (isBearishLiqSweep) setupDetails.push("🧹 Bearish Liquidity Sweep (Bull Trap)");
                if (isBearishChoch) setupDetails.push("📉 CHoCH (Trend Reversal)");
                if (currentClose < currentVwap) setupDetails.push("⚖️ Price Below VWAP");
                if (currentEma20 < currentVwap) setupDetails.push("✅ EMA 20 Confirming");
            }
        }

        if (side && setupDetails.length > 0) {
            
            // 3. FETCH DERIVATIVES DATA (Funding & Open Interest)
            let fundingRate = "N/A", openInterest = "N/A", liqAlert = "";
            try {
                const funding = await exchange.fetchFundingRate(symbol);
                if (funding && funding.fundingRate) {
                    const fr = funding.fundingRate * 100;
                    fundingRate = `${fr.toFixed(4)}%`;
                    if (side.includes("LONG") && fr < -0.01) liqAlert = "🔥 High Short-Squeeze Probability";
                    if (side.includes("SHORT") && fr > 0.01) liqAlert = "🔥 Long-Liquidation Cascade Possible";
                }
                const oiData = await exchange.fetchOpenInterest(symbol);
                if (oiData && oiData.openInterestValue) {
                    openInterest = `$${(oiData.openInterestValue / 1000000).toFixed(2)}M`;
                }
            } catch (e) { /* ignore fetching errors */ }

            const baseAsset = symbol.split('/')[0]; 
            const binanceChartUrl = `https://www.tradingview.com/chart/?symbol=BINANCE:${baseAsset}USDT.P`;
            
            // Auto TP/SL Calculation based on ATR
            let sl = side.includes("LONG") ? currentLow - (currentAtr * 1.0) : currentHigh + (currentAtr * 1.0);
            let tp = side.includes("LONG") ? currentClose + (currentAtr * 2.5) : currentClose - (currentAtr * 2.5);

            const message = `
${emoji} *${side}*
--------------------------
🧩 *Smart Money Concepts:*
${setupDetails.map(s => s).join("\n")}
--------------------------
🪙 *Coin:* #${baseAsset}
⏰ *Timeframe:* ${timeframe}
💰 *Price:* ${currentClose}
📊 *RSI:* ${currentRsi.toFixed(2)} | *ADX:* ${currentAdx.toFixed(2)}
⚖️ *VWAP:* ${currentVwap.toFixed(4)} | *EMA 20:* ${currentEma20.toFixed(4)}
--------------------------
🏦 *Derivatives Data:*
*Funding Rate:* ${fundingRate}
*Open Interest:* ${openInterest}
*Liquidation Risk:* ${liqAlert || "Normal"}
--------------------------
💵 *Take Profit:* ${tp.toPrecision(5)}
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
        
        await bot.sendMessage(chatId, `🧠 *God-Tier SMC Bot Started*\nTracking Liquidity Sweeps, CHoCH, VWAP, Funding & OI...\nScanning Top ${coins.length} Coins...`);

        for (const tf of timeframes) {
            for (const coin of coins) {
                const signalFound = await analyzeCoin(coin, tf);
                if (signalFound) totalSignals++;
                await new Promise(res => setTimeout(res, 500));
            }
        }
        
        const statusMsg = totalSignals === 0 
            ? "✅ Scan Finished: No Smart Money manipulation detected right now." 
            : `✅ Scan Finished: Found ${totalSignals} Institutional Setups.`;
        await bot.sendMessage(chatId, statusMsg);
    } catch (error) { 
        console.error("Run Error:", error.message); 
    }
}

run();
