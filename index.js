import ccxt from 'ccxt';
import pkg from 'technicalindicators';
const { EMA } = pkg;
import TelegramBot from 'node-telegram-bot-api';

const token = process.env.TELEGRAM_TOKEN;
const chatId = process.env.CHAT_ID;
const bot = new TelegramBot(token);

// Using Bitget to bypass GitHub IP restrictions
const exchange = new ccxt.bitget({
    'options': { 'defaultType': 'swap' },
    'enableRateLimit': true
});

// ONLY 15m timeframe as requested
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
        
        // Sort by volume and pick top 250 active coins
        filteredSymbols.sort((a, b) => tickers[b].quoteVolume - tickers[a].quoteVolume);
        return filteredSymbols.slice(0, 250); 
    } catch (e) { 
        return []; 
    }
}

async function analyzeCoin(symbol, timeframe) {
    try {
        const candles = await exchange.fetchOHLCV(symbol, timeframe, undefined, 100);
        if (candles.length < 60) return false;

        const closePrices = candles.map(c => c[4]);
        
        // Calculate EMAs
        const ema20Arr = EMA.calculate({ period: 20, values: closePrices });
        const ema50Arr = EMA.calculate({ period: 50, values: closePrices });

        // We use length - 2 for the last CLOSED candle
        // We use length - 3 for the PREVIOUS closed candle
        // This prevents fake signals from open/moving candles
        const currentEma20 = ema20Arr[ema20Arr.length - 2];
        const prevEma20 = ema20Arr[ema20Arr.length - 3];
        
        const currentEma50 = ema50Arr[ema50Arr.length - 2];
        const prevEma50 = ema50Arr[ema50Arr.length - 3];

        const lastClosedPrice = closePrices[closePrices.length - 2];

        if (!currentEma20 || !currentEma50) return false;

        let side = "";
        let emoji = "";
        let alertType = "";

        // CROSSOVER LOGIC
        // LONG: EMA 20 was below EMA 50, but now crossed ABOVE EMA 50
        if (prevEma20 <= prevEma50 && currentEma20 > currentEma50) {
            side = "LONG Opportunity";
            emoji = "🟢";
            alertType = "🔥 BULLISH CROSSOVER (EMA 20 Crossed Above EMA 50)";
        } 
        // SHORT: EMA 20 was above EMA 50, but now crossed BELOW EMA 50
        else if (prevEma20 >= prevEma50 && currentEma20 < currentEma50) {
            side = "SHORT Opportunity";
            emoji = "🔴";
            alertType = "🔥 BEARISH CROSSOVER (EMA 20 Crossed Below EMA 50)";
        }

        if (side) {
            const baseAsset = symbol.split('/')[0]; 
            const binanceChartUrl = `https://www.tradingview.com/chart/?symbol=BINANCE:${baseAsset}USDT.P`;
            
            const message = `
${emoji} *${side}*
--------------------------
⚡ *Signal:* ${alertType}
🪙 *Coin:* #${baseAsset}
⏰ *Timeframe:* ${timeframe}
💰 *Close Price:* ${lastClosedPrice}
📈 *EMA 20:* ${currentEma20.toFixed(4)}
📉 *EMA 50:* ${currentEma50.toFixed(4)}
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
        
        await bot.sendMessage(chatId, `🔍 *15m Crossover Scanner Started*\nStrategy: EMA 20 / EMA 50 Cross\nScanning Top ${coins.length} Coins...`);

        for (const tf of timeframes) {
            for (const coin of coins) {
                const signalFound = await analyzeCoin(coin, tf);
                if (signalFound) totalSignals++;
                await new Promise(res => setTimeout(res, 300));
            }
        }
        
        if (totalSignals === 0) {
            await bot.sendMessage(chatId, `✅ Scan Finished. No new EMA Crossovers found right now.`);
        } else {
            await bot.sendMessage(chatId, `✅ Scan Finished. Total Crossovers Found: ${totalSignals}`);
        }
    } catch (error) { 
        console.error("Run Error:", error.message); 
    }
}

run();
