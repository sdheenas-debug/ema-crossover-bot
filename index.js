import ccxt from 'ccxt';
import pkg from 'technicalindicators';
const { EMA, ATR } = pkg;
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

        const highPrices = candles.map(c => c[2]);
        const lowPrices = candles.map(c => c[3]);
        const closePrices = candles.map(c => c[4]);

        const ema20Arr = EMA.calculate({ period: 20, values: closePrices });
        const ema50Arr = EMA.calculate({ period: 50, values: closePrices });
        const atrArr = ATR.calculate({ high: highPrices, low: lowPrices, close: closePrices, period: 14 });

        // T-1: Current Closed Candle
        const currentLow = lowPrices[lowPrices.length - 2];
        const currentHigh = highPrices[highPrices.length - 2];
        const currentClose = closePrices[closePrices.length - 2];
        const currentEma20 = ema20Arr[ema20Arr.length - 2];
        const currentEma50 = ema50Arr[ema50Arr.length - 2];
        const currentAtr = atrArr[atrArr.length - 1];

        // T-2: Previous Closed Candle
        const prevLow = lowPrices[lowPrices.length - 3];
        const prevHigh = highPrices[highPrices.length - 3];
        const prevEma20 = ema20Arr[ema20Arr.length - 3];

        if (!currentEma20 || !currentEma50) return false;

        let side = "";
        let emoji = "";

        // --- PERFECT RETEST LOGIC ---

        // 1. LONG RETEST
        // Condition A: Uptrend (EMA 20 > EMA 50)
        // Condition B: Prev candle was completely above EMA 20 (Flying)
        // Condition C: Current candle's Low touched/dipped below EMA 20 (Retest)
        // Condition D: Current candle Closed ABOVE EMA 20 (Successful Bounce/Rejection)
        if (currentEma20 > currentEma50) {
            if (prevLow > prevEma20 && currentLow <= currentEma20 && currentClose > currentEma20) {
                side = "LONG (EMA 20 Retest)";
                emoji = "🟢";
            }
        }

        // 2. SHORT RETEST
        // Condition A: Downtrend (EMA 20 < EMA 50)
        // Condition B: Prev candle was completely below EMA 20 (Falling)
        // Condition C: Current candle's High touched/poked above EMA 20 (Retest)
        // Condition D: Current candle Closed BELOW EMA 20 (Successful Rejection)
        else if (currentEma20 < currentEma50) {
            if (prevHigh < prevEma20 && currentHigh >= currentEma20 && currentClose < currentEma20) {
                side = "SHORT (EMA 20 Retest)";
                emoji = "🔴";
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
⚡ *Signal:* 🔥 PERFECT RETEST (Sniper Entry)
🪙 *Coin:* #${baseAsset}
⏰ *Timeframe:* ${timeframe}
💰 *Entry Price:* ${currentClose}
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
        
        await bot.sendMessage(chatId, `🔍 *15m Retest Scanner Started*\nStrategy: EMA 20 Pullback & Bounce\nScanning Top ${coins.length} Coins...`);

        for (const tf of timeframes) {
            for (const coin of coins) {
                const signalFound = await analyzeCoin(coin, tf);
                if (signalFound) totalSignals++;
                await new Promise(res => setTimeout(res, 300));
            }
        }
        
        if (totalSignals === 0) {
            await bot.sendMessage(chatId, `✅ Scan Finished. No Retest setups found. Waiting for pullbacks...`);
        } else {
            await bot.sendMessage(chatId, `✅ Scan Finished. Found ${totalSignals} Perfect Retest Signals.`);
        }
    } catch (error) { 
        console.error("Run Error:", error.message); 
    }
}

run();
