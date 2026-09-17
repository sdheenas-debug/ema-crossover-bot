import ccxt from 'ccxt';
import pkg from 'technicalindicators';
const { RSI, ATR } = pkg;
import TelegramBot from 'node-telegram-bot-api';

const token = process.env.TELEGRAM_TOKEN;
const chatId = process.env.CHAT_ID;
const bot = new TelegramBot(token);

const exchange = new ccxt.bitget({
    'options': { 'defaultType': 'swap' },
    'enableRateLimit': true
});

const timeframes = ['1h', '4h', '1d'];
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
        return filteredSymbols.slice(0, 150); 
    } catch (e) { return []; }
}

async function analyzeCoin(symbol, timeframe) {
    try {
        const candles = await exchange.fetchOHLCV(symbol, timeframe, undefined, 100);
        if (candles.length < 50) return false;

        // Use length - 2 for the Last CLOSED candle, length - 3 for PREVIOUS closed candle
        const lastClosedIndex = candles.length - 2;
        const prevClosedIndex = candles.length - 3;

        const openPrices = candles.map(c => c[1]);
        const highPrices = candles.map(c => c[2]);
        const lowPrices = candles.map(c => c[3]);
        const closePrices = candles.map(c => c[4]);
        const volumes = candles.map(c => c[5]);

        const rsiArr = RSI.calculate({ period: 14, values: closePrices });
        const atrArr = ATR.calculate({ high: highPrices, low: lowPrices, close: closePrices, period: 14 });

        const lastRsi = rsiArr[lastClosedIndex];
        const prevRsi = rsiArr[prevClosedIndex];
        const lastAtr = atrArr[lastClosedIndex];

        const lastClose = closePrices[lastClosedIndex];
        const lastOpen = openPrices[lastClosedIndex];
        const lastHigh = highPrices[lastClosedIndex];
        const lastLow = lowPrices[lastClosedIndex];

        const prevClose = closePrices[prevClosedIndex];
        const prevOpen = openPrices[prevClosedIndex];

        if (!lastRsi || !prevRsi) return false;

        // Candlestick Pattern Logic (On the last closed candle)
        const body = Math.abs(lastClose - lastOpen);
        const lowerWick = Math.min(lastOpen, lastClose) - lastLow;
        const upperWick = lastHigh - Math.max(lastOpen, lastClose);

        const isBullishHammer = (lowerWick > body * 1.5) && (upperWick < body * 0.5);
        const isBullishEngulfing = (prevClose < prevOpen) && (lastClose > lastOpen) && (lastClose > prevOpen);
        const isBullishCandle = isBullishHammer || isBullishEngulfing || (lastClose > lastOpen);

        const isBearishShootingStar = (upperWick > body * 1.5) && (lowerWick < body * 0.5);
        const isBearishEngulfing = (prevClose > prevOpen) && (lastClose < lastOpen) && (lastClose < prevOpen);
        const isBearishCandle = isBearishShootingStar || isBearishEngulfing || (lastClose < lastOpen);

        let side = "", emoji = "", setupMsg = "";

        // ==========================================
        // 1. EXACT BOTTOM REVERSAL (LONG)
        // Condition: Prev RSI was <= 30 (Deep Bottom). Current RSI has hooked UP. Bullish Candle formed.
        // ==========================================
        if (prevRsi <= 30 && lastRsi > prevRsi && isBullishCandle) {
            side = "LONG Opportunity";
            emoji = "🟢";
            setupMsg = "🔥 BOTTOM CAUGHT (RSI Hooked UP from Oversold)";
        }
        
        // ==========================================
        // 2. EXACT TOP REVERSAL (SHORT)
        // Condition: Prev RSI was >= 70 (Absolute Top). Current RSI has hooked DOWN. Bearish Candle formed.
        // ==========================================
        else if (prevRsi >= 70 && lastRsi < prevRsi && isBearishCandle) {
            side = "SHORT Opportunity";
            emoji = "🔴";
            setupMsg = "🔥 TOP CAUGHT (RSI Hooked DOWN from Overbought)";
        }

        if (side) {
            let fundingRate = "N/A";
            try {
                const funding = await exchange.fetchFundingRate(symbol);
                if (funding && funding.fundingRate) {
                    fundingRate = `${(funding.fundingRate * 100).toFixed(4)}%`;
                }
            } catch (e) {}

            const baseAsset = symbol.split('/')[0]; 
            const binanceChartUrl = `https://www.tradingview.com/chart/?symbol=BINANCE:${baseAsset}USDT.P`;
            
            // Auto TP/SL
            let sl = side.includes("LONG") ? lastLow - (lastAtr * 0.5) : lastHigh + (lastAtr * 0.5);
            let tp1 = side.includes("LONG") ? lastClose + (lastAtr * 2.0) : lastClose - (lastAtr * 2.0);
            let tp2 = side.includes("LONG") ? lastClose + (lastAtr * 3.5) : lastClose - (lastAtr * 3.5);

            let candleType = "Reversal Confirmed";
            if (isBullishHammer) candleType = "🔨 Bullish Hammer";
            if (isBullishEngulfing) candleType = "🐂 Bullish Engulfing";
            if (isBearishShootingStar) candleType = "🌠 Shooting Star";
            if (isBearishEngulfing) candleType = "🐻 Bearish Engulfing";

            const message = `
${emoji} *${side}*
--------------------------
🎯 *Setup:* ${setupMsg}
🕯️ *Pattern:* ${candleType}
--------------------------
🪙 *Coin:* #${baseAsset}
⏰ *Timeframe:* ${timeframe}
💰 *Entry Price:* ${lastClose}
📊 *RSI Hook:* ${prevRsi.toFixed(1)} ➡️ ${lastRsi.toFixed(1)}
🏦 *Funding:* ${fundingRate}
--------------------------
💵 *Take Profit 1:* ${tp1.toPrecision(5)}
💵 *Take Profit 2:* ${tp2.toPrecision(5)}
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
        
        await bot.sendMessage(chatId, `🔍 *Top & Bottom Catcher Started*\nStrategy: Exact RSI Reversal Hooks\nScanning Top ${coins.length} Coins...`);

        for (const tf of timeframes) {
            for (const coin of coins) {
                const signalFound = await analyzeCoin(coin, tf);
                if (signalFound) totalSignals++;
                await new Promise(res => setTimeout(res, 500));
            }
        }
        
        const statusMsg = totalSignals === 0 
            ? "✅ Scan Finished: No exact Top or Bottom reversals right now." 
            : `✅ Scan Finished: Caught ${totalSignals} Exact Reversals.`;
        await bot.sendMessage(chatId, statusMsg);
    } catch (error) { 
        console.error("Run Error:", error.message); 
    }
}

run();
