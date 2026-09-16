import ccxt from 'ccxt';
import pkg from 'technicalindicators';
const { BollingerBands, ATR } = pkg;
import TelegramBot from 'node-telegram-bot-api';

const token = process.env.TELEGRAM_TOKEN;
const chatId = process.env.CHAT_ID;
const bot = new TelegramBot(token);

const exchange = new ccxt.bitget({
    'options': { 'defaultType': 'swap' },
    'enableRateLimit': true
});

// Removed 15m. Using highly reliable Swing Timeframes: 1h & 4h
const timeframes = ['1h', '4h'];
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

            if ((isMajor || isCheap) && ticker.quoteVolume > 500000) {
                filteredSymbols.push(symbol);
            }
        }
        filteredSymbols.sort((a, b) => tickers[b].quoteVolume - tickers[a].quoteVolume);
        return filteredSymbols.slice(0, 200); 
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

        // Bollinger Bands Calculation (20 period, 2 Standard Deviations)
        const bbArr = BollingerBands.calculate({ period: 20, stdDev: 2, values: closePrices });
        const atrArr = ATR.calculate({ high: highPrices, low: lowPrices, close: closePrices, period: 14 });

        // T-1: Current Closed Candle
        const currentClose = closePrices[closePrices.length - 2];
        const currentVol = volumes[volumes.length - 2];
        const currentBB = bbArr[bbArr.length - 2];
        const currentAtr = atrArr[atrArr.length - 1];

        // Average Volume of the last 20 candles
        const avgVol = volumes.slice(-22, -2).reduce((a, b) => a + b, 0) / 20;

        // Custom Rolling VWAP Calculation (Last 20 Periods)
        let sumTPV = 0;
        let sumVol = 0;
        for(let i = closePrices.length - 22; i < closePrices.length - 2; i++) {
             let typicalPrice = (highPrices[i] + lowPrices[i] + closePrices[i]) / 3;
             sumTPV += typicalPrice * volumes[i];
             sumVol += volumes[i];
        }
        const currentVWAP = sumTPV / sumVol;

        if (!currentBB || !currentVWAP) return false;

        let side = "";
        let emoji = "";
        let breakoutType = "";

        // STRATEGY LOGIC: Bollinger Band Breakout + VWAP Confirmation + Volume Spike

        // 1. BULLISH BREAKOUT (LONG)
        // Condition: Closed above Upper BB + High Volume + Above VWAP
        if (currentClose > currentBB.upper && currentVol > (avgVol * 1.8) && currentClose > currentVWAP) {
            side = "LONG Opportunity";
            emoji = "🟢";
            breakoutType = "🚀 BULLISH VOLATILITY BREAKOUT";
        }
        // 2. BEARISH BREAKOUT (SHORT)
        // Condition: Closed below Lower BB + High Volume + Below VWAP
        else if (currentClose < currentBB.lower && currentVol > (avgVol * 1.8) && currentClose < currentVWAP) {
            side = "SHORT Opportunity";
            emoji = "🔴";
            breakoutType = "🩸 BEARISH VOLATILITY BREAKOUT";
        }

        if (side) {
            const baseAsset = symbol.split('/')[0]; 
            const binanceChartUrl = `https://www.tradingview.com/chart/?symbol=BINANCE:${baseAsset}USDT.P`;
            
            // Auto TP/SL Calculation based on ATR
            let sl, tp1;
            if (side.includes("LONG")) {
                sl = currentBB.middle; // Stop Loss at middle band
                tp1 = currentClose + (currentAtr * 3.0);
            } else {
                sl = currentBB.middle; // Stop Loss at middle band
                tp1 = currentClose - (currentAtr * 3.0);
            }
            
            const message = `
${emoji} *${side}*
--------------------------
⚡ *Signal:* ${breakoutType}
✅ *Confirmation:* High Volume + VWAP Trend
🪙 *Coin:* #${baseAsset}
⏰ *Timeframe:* ${timeframe}
💰 *Breakout Price:* ${currentClose}
🎯 *VWAP Level:* ${currentVWAP.toFixed(4)}
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
        
        await bot.sendMessage(chatId, `🔍 *Pro Breakout Scanner Started*\nStrategy: Bollinger Bands + VWAP + Volume\nScanning Top ${coins.length} Coins (1h & 4h)...`);

        for (const tf of timeframes) {
            for (const coin of coins) {
                const signalFound = await analyzeCoin(coin, tf);
                if (signalFound) totalSignals++;
                await new Promise(res => setTimeout(res, 300));
            }
        }
        
        if (totalSignals === 0) {
            await bot.sendMessage(chatId, `✅ Scan Finished. No valid institutional breakouts found right now.`);
        } else {
            await bot.sendMessage(chatId, `✅ Scan Finished. Found ${totalSignals} Sniper Breakouts!`);
        }
    } catch (error) { 
        console.error("Run Error:", error.message); 
    }
}

run();
