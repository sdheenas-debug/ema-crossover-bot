import ccxt from 'ccxt';
import pkg from 'technicalindicators';
// Added RSI and ADX along with EMA and ATR
const { EMA, ATR, RSI, ADX } = pkg;
import TelegramBot from 'node-telegram-bot-api';

const token = process.env.TELEGRAM_TOKEN;
const chatId = process.env.CHAT_ID;
const bot = new TelegramBot(token);

const exchange = new ccxt.bitget({
    'options': { 'defaultType': 'swap' },
    'enableRateLimit': true
});

// 15m Scalping / Day Trading
const timeframes = ['15m'];

async function getFilteredPairs() {
    try {
        const tickers = await exchange.fetchTickers();
        let filteredSymbols = [];
        
        for (const symbol in tickers) {
            const ticker = tickers[symbol];
            if (symbol.endsWith('USDT') && ticker.quoteVolume > 500000) {
                filteredSymbols.push(symbol);
            }
        }
        filteredSymbols.sort((a, b) => tickers[b].quoteVolume - tickers[a].quoteVolume);
        return filteredSymbols.slice(0, 250); 
    } catch (e) { return []; }
}

async function analyzeCoin(symbol, timeframe) {
    try {
        const candles = await exchange.fetchOHLCV(symbol, timeframe, undefined, 100);
        if (candles.length < 60) return false;

        const openPrices = candles.map(c => c[1]);
        const highPrices = candles.map(c => c[2]);
        const lowPrices = candles.map(c => c[3]);
        const closePrices = candles.map(c => c[4]);

        const ema20Arr = EMA.calculate({ period: 20, values: closePrices });
        const ema50Arr = EMA.calculate({ period: 50, values: closePrices });
        const atrArr = ATR.calculate({ high: highPrices, low: lowPrices, close: closePrices, period: 14 });
        const rsiArr = RSI.calculate({ period: 14, values: closePrices });
        const adxArr = ADX.calculate({ high: highPrices, low: lowPrices, close: closePrices, period: 14 });

        // T-1: Current Closed Candle Data
        const currentLow = lowPrices[lowPrices.length - 2];
        const currentHigh = highPrices[highPrices.length - 2];
        const currentClose = closePrices[closePrices.length - 2];
        
        const currentEma20 = ema20Arr[ema20Arr.length - 2];
        const currentEma50 = ema50Arr[ema50Arr.length - 2];
        const currentAtr = atrArr[atrArr.length - 1];
        const currentRsi = rsiArr[rsiArr.length - 2];
        
        const currentAdx = adxArr[adxArr.length - 2].adx;
        const prevAdx = adxArr[adxArr.length - 3].adx;

        // T-2: Previous Closed Candle Data
        const prevLow = lowPrices[lowPrices.length - 3];
        const prevHigh = highPrices[highPrices.length - 3];
        const prevEma20 = ema20Arr[ema20Arr.length - 3];

        if (!currentEma20 || !currentEma50 || !currentRsi || !currentAdx) return false;

        let side = "";
        let emoji = "";
        let strategyName = "";
        let adxStatus = "";

        // ADX Exhaustion Logic (Trend is dying)
        const isExhausted = prevAdx > 25 && currentAdx < prevAdx;

        // ==========================================
        // STRATEGY 1: RSI EXTREME REVERSAL (Top/Bottom)
        // ==========================================
        if (currentRsi >= 10 && currentRsi <= 30 && isExhausted) {
            side = "LONG Opportunity";
            emoji = "🟢";
            strategyName = "🔥 BOTTOM REVERSAL (RSI Oversold + ADX)";
            adxStatus = "Sellers Exhausted (Sniper Entry)";
        } 
        else if (currentRsi >= 70 && currentRsi <= 100 && isExhausted) {
            side = "SHORT Opportunity";
            emoji = "🔴";
            strategyName = "🔥 TOP REVERSAL (RSI Overbought + ADX)";
            adxStatus = "Buyers Exhausted (Sniper Entry)";
        }
        // ==========================================
        // STRATEGY 2: EMA 20 PERFECT RETEST
        // ==========================================
        // Long Retest
        else if (currentEma20 > currentEma50) {
            if (prevLow > prevEma20 && currentLow <= currentEma20 && currentClose > currentEma20) {
                side = "LONG Opportunity";
                emoji = "🟢";
                strategyName = "📈 EMA 20 PERFECT RETEST";
                adxStatus = currentAdx > 25 ? "Strong Trend Continuing" : "Normal Trend";
            }
        }
        // Short Retest
        else if (currentEma20 < currentEma50) {
            if (prevHigh < prevEma20 && currentHigh >= currentEma20 && currentClose < currentEma20) {
                side = "SHORT Opportunity";
                emoji = "🔴";
                strategyName = "📉 EMA 20 PERFECT RETEST";
                adxStatus = currentAdx > 25 ? "Strong Trend Continuing" : "Normal Trend";
            }
        }

        if (side) {
            const baseAsset = symbol.split('/')[0]; 
            const binanceChartUrl = `https://www.tradingview.com/chart/?symbol=BINANCE:${baseAsset}USDT.P`;
            
            // Auto TP/SL Calculation based on ATR (Risk:Reward = 1:2)
            let sl, tp1;
            if (side.includes("LONG")) {
                sl = currentClose - (currentAtr * 1.5);
                tp1 = currentClose + (currentAtr * 3.0);
            } else {
                sl = currentClose + (currentAtr * 1.5);
                tp1 = currentClose - (currentAtr * 3.0);
            }
            
            const message = `
${emoji} *${side}*
--------------------------
⚡ *Strategy:* ${strategyName}
🎯 *ADX Status:* ${adxStatus}
🪙 *Coin:* #${baseAsset}
⏰ *Timeframe:* ${timeframe}
💰 *Entry Price:* ${currentClose}
📊 *RSI (14):* ${currentRsi.toFixed(2)}
📈 *EMA 20:* ${currentEma20.toFixed(4)}
--------------------------
💵 *Take Profit:* ${tp1.toPrecision(5)}
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
        
        await bot.sendMessage(chatId, `🔍 *15m Dual-Strategy Scanner Started*\nTarget: RSI Reversals & EMA Retests\nScanning Top ${coins.length} Coins...`);

        for (const tf of timeframes) {
            for (const coin of coins) {
                const signalFound = await analyzeCoin(coin, tf);
                if (signalFound) totalSignals++;
                await new Promise(res => setTimeout(res, 300));
            }
        }
        
        if (totalSignals === 0) {
            await bot.sendMessage(chatId, `✅ Scan Finished. No Sniper or Retest setups found right now.`);
        } else {
            await bot.sendMessage(chatId, `✅ Scan Finished. Found ${totalSignals} Perfect Signals.`);
        }
    } catch (error) { 
        console.error("Run Error:", error.message); 
    }
}

run();
