// main.js
const axios = require('axios');
const CryptoJS = require('crypto-js'); // crypto-js로 변경
const WebSocket = require('ws');
const { RSI } = require('technicalindicators');

// ###################################################################################
// #                          USER CONFIGURATION                                     #
// ###################################################################################
const API_KEY = "N6FCCypIiKnpZlB4BnvhYWBHb4iwIqg47RgSmbhVbTK209Nc3O9DPN0tnyUr3z9qDgynFYMgRUNngt39Jy4Nw"
const SECRET_KEY = "oWLdJW3w4mGguaJHItsWBYoEWelcwwaJt5riUFIpXabDsTy8Tw4qfr58kQHGbPD7LFZAbkmww02kon4FSckA"
const SYMBOL = "BTC-USDT";
const LEVERAGE = 100;
let INITIAL_EQUITY_PERCENTAGE = 0.02;
const MARTINGALE_MULTIPLIER = 1.5;
const MAX_MARTINGALE_ENTRIES = 20;
const EXIT_ROI_THRESHOLD = -0.10;

const TELEGRAM_BOT_TOKEN = "7909240753:AAEpRSMjQpkFsKWUwVfVAyDP4ORjuA__i4g";
const TELEGRAM_CHAT_ID = "1148538638";

const FEE_LIMIT = 0.000064;
const FEE_MARKET = 0.00016;

const MARTINGALE_DROP_FEE_MULTIPLIER = 7;
const MARTINGALE_TAKE_PROFIT_FEE_MULTIPLIER = 1.2;
const BASE_SLIPPAGE_PERCENT = 0.002;
const MAX_SLIPPAGE_PERCENT = 0.005;
const MIN_PROFIT_PERCENT = 0.0005;
const VOLATILITY_FACTOR = 3;
const VOLATILITY_WINDOW = 60000;
const MAX_VOLATILITY_THRESHOLD = 0.01;
const BASE_COOLDOWN_PERIOD = 30000;
const VOLATILITY_COOLDOWN_MULTIPLIER = 2;
const MIN_POSITION_SIZE_FACTOR = 0.5;

// RSI Configuration
const RSI_PERIOD = 14;
const RSI_LOWER_BOUND = 40; // 변경
const RSI_UPPER_BOUND = 70; // 변경
const RSI_CANDLE_INTERVAL = "1m";

const API_BASE_URL = 'https://open-api.bingx.com';
const WEBSOCKET_URL = 'wss://open-api-swap.bingx.com/swap-market';

// ###################################################################################
// #                          STATE VARIABLES                                        #
// ###################################################################################
let totalInitialEquityUSD = 0;
let currentMartingaleLevel = 0;
let isCancellingOrders = false;
let volumeStats = { lastMinute: 0, last5Minutes: 0, lastHour: 0, trades: [], lastUpdate: Date.now() };
let currentPosition = { quantity: 0, averageEntryPrice: 0, entryValueUSD: 0, side: 'LONG', positionId: null, openOrderId: null, takeProfitOrderId: null, martingaleBuyOrderId: null };
let activeListenKey = null;
let ws = null;
let isBotActive = false;
let lastMarketBuyPrice = 0;
let lastMartingaleBuyPrice = 0;
let initialPositionQuantity = 0;
let isCoolingDown = false;
let lastVolatilityAlert = 0;
let lastTradeActivityTime = Date.now();
let targetVolumeUSD = 0;
let totalTradedVolumeUSD = 0;
let currentRsi = NaN;

// ###################################################################################
// #                          API UTILITIES                                          #
// ###################################################################################
function generateSignature(paramsString, apiSecret) {
    return CryptoJS.enc.Hex.stringify(CryptoJS.HmacSHA256(paramsString, apiSecret));
}

function buildQueryString(params, includeTimestamp = true, urlEncode = false) {
    const allParams = includeTimestamp ? { ...params, timestamp: Date.now() } : { ...params };
    const sortedKeys = Object.keys(allParams).sort();
    let queryString = sortedKeys.map(key => {
        const value = allParams[key];
        return `${key}=${urlEncode ? encodeURIComponent(value) : value}`;
    }).join('&');
    return queryString;
}

async function apiRequest(method, path, params = {}, needsSignature = true) {
    if (needsSignature && (!API_KEY || !SECRET_KEY)) {
        throw new Error('API credentials not configured for a signed request');
    }

    let url = `${API_BASE_URL}${path}`;
    const headers = { 
        'X-BX-APIKEY': API_KEY,
        'User-Agent': 'NodeClient/1.0'
    };
    let requestData = null;
    let queryStringForUrl = '';

    if (method === 'GET' || method === 'DELETE') {
        queryStringForUrl = buildQueryString(params, true, true);
        if (needsSignature) {
            const queryStringForSig = buildQueryString(params, true, false);
            const signature = generateSignature(queryStringForSig, SECRET_KEY);
            queryStringForUrl += `&signature=${signature}`;
        }
        if (queryStringForUrl) {
            url += `?${queryStringForUrl}`;
        }
    } else if (method === 'POST' || method === 'PUT') {
        queryStringForUrl = buildQueryString(params, true, true); // POST/PUT도 URL에 파라미터 포함하여 서명
        if (needsSignature) {
            const queryStringForSig = buildQueryString(params, true, false); // 서명용은 인코딩 X
            const signature = generateSignature(queryStringForSig, SECRET_KEY);
            queryStringForUrl += `&signature=${signature}`;
        }
        if (queryStringForUrl) {
            url += `?${queryStringForUrl}`;
        }
        // POST/PUT 요청 시 data 필드는 null로 유지 (파라미터는 URL에 포함)
        // 만약 API가 본문에 파라미터를 요구한다면, 이 부분을 수정하고 Content-Type도 설정해야 함.
        // headers['Content-Type'] = 'application/x-www-form-urlencoded';
        // requestData = buildQueryString(params, false, true); // timestamp 없이, URL 인코딩된 본문
    }

    try {
        const config = {
            method: method,
            url: url,
            headers: headers,
            data: requestData, 
            transformResponse: (resp) => {
                return resp; 
            }
        };
        const response = await axios(config);

        let responseData;
        try {
            if (response.data === "" && response.status === 200) {
                if (path === '/openApi/user/auth/userDataStream' && method === 'PUT') {
                    return {}; 
                }
            }
            responseData = JSON.parse(response.data);
        } catch (e) {
            console.error('Failed to parse API response JSON:', response.data, 'Status:', response.status);
            if (!(response.data === "" && response.status === 200)) {
                throw new Error('API response is not valid JSON or unexpected empty response');
            }
            responseData = {};
        }
        
        if (path === '/openApi/user/auth/userDataStream') { 
            if (method === 'POST' && responseData.listenKey) return responseData;
            if (method === 'PUT' && response.status === 200) return responseData; 
            if (method === 'DELETE' && response.status === 200) return responseData; 
            throw new Error(`Failed to ${method} listenKey: ` + JSON.stringify(responseData));
        }

        if (responseData.code !== 0 && responseData.code !== "0") { 
            console.error(`API Error from ${path}:`, responseData);
            throw new Error(`API Error: ${responseData.msg || 'Unknown error'} (Code: ${responseData.code || 'Unknown'})`);
        }
        return responseData.data || responseData; 
    } catch (error) {
        const errorMessage = error.response && error.response.data && error.response.data.msg ? 
                           `API Error: ${error.response.data.msg} (Code: ${error.response.data.code})` : 
                           (error.isAxiosError ? error.message : error.toString());
        console.error(`Error during API request to ${path}: ${errorMessage}`);
        if (error.response) {
            console.error('Error response status:', error.response.status);
        }
        throw error; 
    }
}

// ###################################################################################
// #                          TELEGRAM UTILITIES                                     #
// ###################################################################################
async function sendTelegramMessage(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.warn('Telegram bot token or chat ID not configured. Skipping Telegram message.');
        return;
    }
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    try {
        await axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'Markdown' });
    } catch (error) {
        console.error('Error sending Telegram message:', error.response ? error.response.data : error.message);
    }
}

// ###################################################################################
// #                          BINGX API FUNCTIONS                                    #
// ###################################################################################
let balanceCache = { value: 0, timestamp: 0 };
const BALANCE_CACHE_TTL = 60000;
async function getAccountBalance() {
    const now = Date.now();
    if (now - balanceCache.timestamp < BALANCE_CACHE_TTL) return balanceCache.value;
    try {
        const balanceData = await apiRequest('GET', '/openApi/swap/v2/user/balance', { currency: 'USDT' });
        if (balanceData?.balance?.balance) {
            balanceCache = { value: parseFloat(balanceData.balance.balance), timestamp: now };
            return balanceCache.value;
        }
        console.warn('[getAccountBalance] Balance data not found in response:', balanceData);
        return 0;
    } catch (error) {
        console.error('Error fetching account balance:', error);
        return balanceCache.value;
    }
}

let priceCache = { value: 0, timestamp: 0 };
const PRICE_CACHE_TTL = 10000;
async function getCurrentBtcPrice() {
    const now = Date.now();
    if (now - priceCache.timestamp < PRICE_CACHE_TTL) return priceCache.value;
    try {
        const priceData = await apiRequest('GET', '/openApi/swap/v2/quote/price', { symbol: SYMBOL }, false);
        if (priceData?.price) {
            priceCache = { value: parseFloat(priceData.price), timestamp: now };
            return priceCache.value;
        }
        console.warn('[getCurrentBtcPrice] Price data not found in response:', priceData);
        return 0;
    } catch (error) {
        console.error('Error fetching price:', error);
        return priceCache.value;
    }
}

async function setLeverage() {
    console.log(`Setting leverage for ${SYMBOL} to ${LEVERAGE}x for LONG side...`);
    try {
        await apiRequest('POST', '/openApi/swap/v2/trade/leverage', { symbol: SYMBOL, side: 'LONG', leverage: LEVERAGE });
        console.log(`Leverage for ${SYMBOL} (LONG) set to ${LEVERAGE}x successfully.`);
    } catch (error) {
        // console.error('Error setting leverage:', error.message); // apiRequest에서 로깅
    }
}

async function placeOrder(symbol, side, positionSide, type, quantity, price = null, stopPrice = null) {
    if (!symbol || !side || !positionSide || !type || !quantity) throw new Error('Missing required order parameters');
    if (quantity <= 0) throw new Error('Invalid order quantity: Must be greater than 0. Received: ' + quantity);
    
    const orderParams = { symbol, side, positionSide, type, quantity: quantity.toString() };
    if (type !== 'MARKET') {
        orderParams.timeInForce = 'GTC';
        if (price !== null) orderParams.price = price.toString();
    }
    if (stopPrice !== null && (type === 'STOP_MARKET' || type === 'TAKE_PROFIT_MARKET' || type === 'STOP')) {
         orderParams.stopPrice = stopPrice.toString();
    }
    if (type === 'LIMIT' && side === 'BUY' && currentMartingaleLevel > 0) orderParams.clientOrderID = `martingale_${Date.now()}_${currentMartingaleLevel}`;

    console.log(`[Order] Placing ${type} ${side} ${quantity.toFixed(5)} ${symbol} at ${price ? price.toFixed(5) : 'Market'}`);
    try {
        const orderResponseData = await apiRequest('POST', '/openApi/swap/v2/trade/order', orderParams);
        if (orderResponseData && orderResponseData.orderId) {
            console.log(`Order placed successfully. Order ID: ${orderResponseData.orderId}`);
            return { orderId: orderResponseData.orderId, ...orderResponseData };
        }
        console.error('Failed to place order, API response data:', orderResponseData);
        return null;
    } catch (error) {
        return null;
    }
}

async function getOpenOrders(symbol) {
    console.log(`Fetching open orders for ${symbol}...`);
    try {
        const response = await apiRequest('GET', '/openApi/swap/v2/trade/openOrders', { symbol });
        return response.orders || [];
    } catch (error) {
        return [];
    }
}

async function cancelOrder(symbol, orderId) {
    console.log(`Attempting to cancel order ${orderId}...`);
    try {
        const response = await apiRequest('DELETE', '/openApi/swap/v2/trade/order', { symbol, orderId: orderId.toString() });
        console.log(`Cancel confirmation for order ${orderId}:`, response);
        if (response && response.orderId === orderId.toString()) return true; 
        return response; 
    } catch (error) {
        return false;
    }
}

async function getCurrentPosition(symbol) {
    console.log(`Fetching current position for ${symbol}...`);
    try {
        const positionDataArray = await apiRequest('GET', '/openApi/swap/v2/user/positions', { symbol });
        if (positionDataArray && Array.isArray(positionDataArray) && positionDataArray.length > 0) {
            const longPosition = positionDataArray.find(p => p.positionSide === 'LONG');
            if (longPosition && parseFloat(longPosition.positionAmt) > 0) {
                return {
                    quantity: parseFloat(longPosition.positionAmt),
                    averageEntryPrice: parseFloat(longPosition.avgPrice),
                    positionId: longPosition.positionId,
                    liquidationPrice: parseFloat(longPosition.liqPrice)
                };
            }
        }
        console.log(`No active LONG position found for ${symbol}.`);
        return null;
    } catch (error) {
        return null;
    }
}

async function cancelAllOpenOrders(symbol) {
    console.log(`Attempting to cancel all open orders for ${symbol}...`);
    try {
        const response = await apiRequest('DELETE', '/openApi/swap/v2/trade/allOpenOrders', { symbol }); 
        console.log(`Cancel all orders confirmation:`, response);
        if (response && (response.success || (response.data && response.data.success))) {
            return true;
        }
        console.warn('Cancel all open orders might not have been fully successful:', response);
        return false; 
    } catch (error) {
        return false;
    }
}

async function getKlines(symbol, interval, limit) {
    console.log(`Fetching ${limit} ${interval} klines for ${symbol}...`);
    try {
        const klinesData = await apiRequest('GET', '/openApi/swap/v3/quote/klines', { symbol, interval, limit }, false);
        if (!klinesData || !Array.isArray(klinesData)) {
            console.warn(`[getKlines] klinesData is not an array or is null/undefined for ${symbol} ${interval}. Data:`, klinesData);
            return [];
        }
        return klinesData.map((k, index) => {
            const open = parseFloat(k.open);
            const high = parseFloat(k.high);
            const low = parseFloat(k.low);
            const close = parseFloat(k.close);
            const volume = parseFloat(k.volume);
            const timestamp = parseInt(k.time);
            if (isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close) || isNaN(volume) || isNaN(timestamp)) {
                console.warn(`[getKlines] Invalid data in kline at index ${index} for ${symbol} ${interval}. Raw: ${JSON.stringify(k)}`);
                return null;
            }
            return { timestamp, open, high, low, close, volume };
        }).filter(k => k !== null);
    } catch (error) {
        return [];
    }
}

// ###################################################################################
// #                          RSI CALCULATION                                        #
// ###################################################################################
function calculateRsi(klines) {
    if (!klines || klines.length < RSI_PERIOD) {
        console.warn(`[RSI] Not enough kline data for RSI. Need ${RSI_PERIOD}, got ${klines ? klines.length : 0}`);
        return NaN;
    }
    const closePrices = klines.map(k => k.close);
    try {
        const rsiResult = RSI.calculate({ period: RSI_PERIOD, values: closePrices });
        if (rsiResult && rsiResult.length > 0) return rsiResult[rsiResult.length - 1];
        console.warn('[RSI] RSI.calculate returned invalid results.');
        return NaN;
    } catch (error) {
        console.error('[RSI] Error calculating RSI:', error);
        return NaN;
    }
}

async function fetchAndProcessRsiData() {
    try {
        const klines = await getKlines(SYMBOL, RSI_CANDLE_INTERVAL, RSI_PERIOD + 100);
        if (klines && klines.length > 0) {
            const newRsi = calculateRsi(klines);
            if (!isNaN(newRsi)) {
                console.log(`[RSI] Current RSI (${SYMBOL}): ${newRsi.toFixed(2)}`); // 항상 콘솔에 로그 출력
                if (newRsi !== currentRsi) {
                    // const rsiMessage = `📈 *실시간 RSI (${SYMBOL})*\n현재 RSI (${RSI_PERIOD}): ${newRsi.toFixed(2)}`;
                    // sendTelegramMessage(rsiMessage).catch(console.error); 
                }
                currentRsi = newRsi;
            } else {
                console.warn('[RSI] Calculated RSI is NaN.');
                currentRsi = NaN;
            }
        } else {
            console.warn('[RSI] No klines data for RSI calculation.');
            if (!isNaN(currentRsi)) {
                 // sendTelegramMessage(`⚠️ *RSI 업데이트 실패 (${SYMBOL})*\nK-line 데이터 부족. 이전 RSI: ${currentRsi.toFixed(2)}`).catch(console.error);
            }
            currentRsi = NaN;
        }
    } catch (error) {
        console.error('[RSI] Error fetching/processing RSI data:', error);
        currentRsi = NaN;
    }
}

// ###################################################################################
// #                          WEBSOCKET HANDLING                                     #
// ###################################################################################
async function createListenKey() {
    console.log('Creating ListenKey...');
    try {
        const responseData = await apiRequest('POST', '/openApi/user/auth/userDataStream');
        if (responseData && responseData.listenKey) {
            console.log('ListenKey created:', responseData.listenKey);
            return responseData.listenKey;
        }
        console.error('Failed to create ListenKey, response data:', responseData);
        return null;
    } catch (error) {
        return null;
    }
}

async function keepAliveListenKey(key) {
    if (!key) return;
    console.log('Pinging ListenKey to keep alive...');
    try {
        await apiRequest('PUT', '/openApi/user/auth/userDataStream', { listenKey: key });
        console.log('ListenKey kept alive.');
    } catch (error) {
        activeListenKey = await createListenKey();
        if (activeListenKey) {
            console.log('[DEBUG] keepAliveListenKey: Calling connectWebSocket after refreshing listen key.');
            connectWebSocket();
        } else {
            console.error("Failed to get a new listen key after keep-alive failure. Bot stopping.");
            isBotActive = false;
        }
    }
}

let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10; 
const RECONNECT_BASE_DELAY = 5000; 
const MAX_RECONNECT_DELAY = 60000; 
const PING_INTERVAL = 15000; 
const HEALTH_CHECK_INTERVAL = 10000; 
let pingIntervalId = null;
let healthCheckIntervalId = null;
let lastReceivedMessageTime = 0;

function cleanupWebSocket() {
    if (pingIntervalId) clearInterval(pingIntervalId);
    if (healthCheckIntervalId) clearInterval(healthCheckIntervalId);
    pingIntervalId = null;
    healthCheckIntervalId = null;
    lastReceivedMessageTime = 0;
}

function connectWebSocket() {
    if (!activeListenKey) {
        console.error('Cannot connect to WebSocket without a ListenKey.');
        return;
    }
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.log('Maximum reconnect attempts reached. Resetting counter and trying again...');
        reconnectAttempts = 0; 
        return;
    }
    const wsUrlWithKey = `${WEBSOCKET_URL}?listenKey=${activeListenKey}`;
    console.log(`[DEBUG] connectWebSocket entry. Current ws state: ${ws ? ws.readyState : 'null'}. Connecting to WebSocket: ${wsUrlWithKey}`);
    if (ws) {
        console.log(`[DEBUG] Cleaning up existing WebSocket. State: ${ws.readyState}`);
        ws.removeAllListeners();
        if (ws.readyState === WebSocket.OPEN) ws.close();
        else if (ws.readyState === WebSocket.CONNECTING) {
            try { ws.close(); } catch (e) { console.warn("Error closing WebSocket during cleanup:", e.message); }
        }
        ws = null;
    }
    ws = new WebSocket(wsUrlWithKey);
    pingIntervalId = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            try { ws.ping(); } catch (e) { console.error('[WebSocket] Ping failed:', e); }
        }
    }, PING_INTERVAL);
    ws.on('open', () => {
        console.log('[DEBUG] WebSocket: "open" event. Connection established. ReadyState:', ws.readyState);
        reconnectAttempts = 0;
        ws.ping();
    });
    ws.on('message', (data) => {
        try {
            let messageString = data.toString();
            if (messageString === 'Ping') return ws.send('Pong');
            if (data instanceof Buffer) {
                try { messageString = require('zlib').gunzipSync(data).toString(); } catch (e) { /* ignore */ }
            }
            if (messageString.startsWith('{') || messageString.startsWith('[')) {
                const message = JSON.parse(messageString);
                lastReceivedMessageTime = Date.now(); 
                if (message.e === 'ORDER_TRADE_UPDATE') handleWebSocketMessage(message).catch(console.error);
                else if (message.e === 'aggTrade') {  
                    volumeStats.trades.push({ quantity: parseFloat(message.q), time: Date.now() });
                    updateVolumeStats();
                }
            }
        } catch (error) {
            console.error('Error processing WebSocket message:', error, 'Raw data:', data.toString());
        }
    });
    ws.on('error', (error) => console.error('[DEBUG] WebSocket: "error" event. Error:', error));
    ws.on('close', async (code, reason) => {
        console.log(`[DEBUG] WebSocket: "close" event. Code: ${code}, Reason: ${reason.toString()}.`);
        cleanupWebSocket();
        if (!isBotActive) return;
        const isPermanentError = [1002, 1003, 1007, 1008, 1009, 1010, 1011].includes(code);
        if (isPermanentError) {
            console.error('Permanent WebSocket error detected. Stopping bot.');
            isBotActive = false;
            return;
        }
        const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts++), MAX_RECONNECT_DELAY) + (Math.random() * 2000);
        console.log(`Attempting to reconnect WebSocket in ${(delay/1000).toFixed(1)}s (attempt ${reconnectAttempts})...`);
        setTimeout(async () => {
            try {
                if (!activeListenKey || code === 1006) activeListenKey = await createListenKey();
                if (activeListenKey) connectWebSocket();
                else { console.error("Failed to get new listen key for reconnection. Bot stopping."); isBotActive = false; }
            } catch (error) {
                console.error("[DEBUG] WebSocket reconnection failed:", error);
                if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) setTimeout(connectWebSocket, delay);
                else { console.error('Max reconnect attempts reached. Stopping bot.'); isBotActive = false; }
            }
        }, delay);
    });
    healthCheckIntervalId = setInterval(() => {
        if (lastReceivedMessageTime === 0 && ws && ws.readyState === WebSocket.OPEN) lastReceivedMessageTime = Date.now();
        const timeSinceLastMessage = Date.now() - lastReceivedMessageTime;
        if (ws && ws.readyState === WebSocket.OPEN && timeSinceLastMessage > 60000) {
            console.warn(`No messages received for ${timeSinceLastMessage/1000}s. Reconnecting...`);
            ws.close(); 
        }
    }, HEALTH_CHECK_INTERVAL);
}

async function handleWebSocketMessage(message) {
    if (message.e === 'ORDER_TRADE_UPDATE') {
        const orderData = message.o;
        if (orderData.X === 'FILLED') {
            lastTradeActivityTime = Date.now();
            const currentPrice = await getCurrentBtcPrice();
            console.log(`Order Update [${orderData.X}]: Symbol: ${orderData.s}, Side: ${orderData.S}, Type: ${orderData.o}, Qty: ${orderData.q}, Price: ${orderData.p}, OrderID: ${orderData.i}, Current Market: ${currentPrice}`);
            const tradeValueUSD = parseFloat(orderData.q) * parseFloat(orderData.p);
            console.log(`[거래량] 구매/판매 발생: ${orderData.q} ${orderData.s.split('-')[0]} (${tradeValueUSD.toFixed(2)} USDT)`);
            
            totalTradedVolumeUSD += tradeValueUSD;
            console.log(`[누적 거래량] 현재 총 누적 거래량: ${totalTradedVolumeUSD.toFixed(2)} USDT`);

            if (targetVolumeUSD > 0 && totalTradedVolumeUSD >= targetVolumeUSD) {
                console.log(`목표 거래량 ${targetVolumeUSD.toFixed(2)} USDT 달성! 봇을 종료합니다.`);
                isBotActive = false; cleanupWebSocket(); process.exit(0);
            }

            if (orderData.o === 'MARKET' && orderData.S === 'BUY' && lastMarketBuyPrice > 0) {
                const filledPrice = parseFloat(orderData.p);
                const expectedPriceRangeMax = lastMarketBuyPrice * (1 + BASE_SLIPPAGE_PERCENT * 2);
                if (filledPrice > expectedPriceRangeMax) {
                     console.warn(`Large price deviation detected for initial BUY: ${( (filledPrice - lastMarketBuyPrice) / lastMarketBuyPrice * 100).toFixed(2)}%`);
                }
            }

            if (orderData.o === 'MARKET' && orderData.S === 'BUY') { // Initial Market Buy
                console.log('Initial market buy order filled.');
                lastMarketBuyPrice = parseFloat(orderData.p);
                currentPosition.quantity = parseFloat(orderData.q);
                currentPosition.averageEntryPrice = lastMarketBuyPrice;
                currentPosition.entryValueUSD = currentPosition.quantity * lastMarketBuyPrice;
                currentPosition.side = 'LONG';
                initialPositionQuantity = parseFloat(orderData.q);
                const msg = `✨ *초기 시장가 매수 체결!* ✨\n\n*심볼:* ${orderData.s}\n*수량:* ${parseFloat(orderData.q).toFixed(5)}\n*가격:* ${parseFloat(orderData.p).toFixed(1)} USDT\n*총 가치:* ${tradeValueUSD.toFixed(2)} USDT\n\n*현재 잔액:* ${(await getAccountBalance()).toFixed(2)} USDT\n*총 누적 거래량:* ${totalTradedVolumeUSD.toFixed(2)} USDT`;
                sendTelegramMessage(msg).catch(console.error);
                placeInitialStrategyOrders().catch(console.error);
                volumeStats.trades.push({ quantity: parseFloat(orderData.q), time: Date.now() });
                updateVolumeStats();
            } else if (orderData.o === 'LIMIT' && orderData.S === 'BUY') { // Martingale Buy
                console.log('Martingale buy order filled.');
                lastMartingaleBuyPrice = parseFloat(orderData.p);
                currentMartingaleLevel++;
                const newQuantity = currentPosition.quantity + parseFloat(orderData.q);
                currentPosition.averageEntryPrice = ((currentPosition.averageEntryPrice * currentPosition.quantity) + (parseFloat(orderData.p) * parseFloat(orderData.q))) / newQuantity;
                currentPosition.quantity = newQuantity;
                currentPosition.entryValueUSD = currentPosition.quantity * currentPosition.averageEntryPrice;
                const msg = `💧 *물타기 매수 체결 (레벨 ${currentMartingaleLevel})* 💧\n\n*심볼:* ${orderData.s}\n*수량:* ${parseFloat(orderData.q).toFixed(5)}\n*가격:* ${parseFloat(orderData.p).toFixed(1)} USDT\n*총 가치:* ${tradeValueUSD.toFixed(2)} USDT\n*평균 진입가:* ${currentPosition.averageEntryPrice.toFixed(1)} USDT\n\n*현재 잔액:* ${(await getAccountBalance()).toFixed(2)} USDT\n*총 누적 거래량:* ${totalTradedVolumeUSD.toFixed(2)} USDT`;
                sendTelegramMessage(msg).catch(console.error);
                volumeStats.trades.push({ quantity: parseFloat(orderData.q), time: Date.now() });
                updateVolumeStats();
                if (currentMartingaleLevel < MAX_MARTINGALE_ENTRIES) {
                    await placeNextMartingaleStageOrders().catch(console.error);
                } else {
                    console.log(`Maximum martingale entries (${MAX_MARTINGALE_ENTRIES}) reached.`);
                    const roi = (currentPrice - currentPosition.averageEntryPrice) / currentPosition.averageEntryPrice;
                     if (roi <= EXIT_ROI_THRESHOLD) {
                        console.log(`Martingale limit reached and ROI ${roi.toFixed(4)} <= ${EXIT_ROI_THRESHOLD} threshold. Exiting position.`);
                        const sellOrder = await placeOrder(SYMBOL, 'SELL', 'LONG', 'MARKET', currentPosition.quantity);
                        if (sellOrder) {
                            console.log('Market SELL order placed to exit position after max martingale.');
                            await cancelAllOpenOrdersAndReset(SYMBOL);
                        }
                    } else {
                         console.log(`Max martingale entries reached, ROI ${roi.toFixed(4)} is above exit threshold. Holding.`);
                    }
                }
            } else if ((orderData.o === 'TAKE_PROFIT_MARKET' || orderData.o === 'LIMIT') && orderData.S === 'SELL') { // Take Profit
                console.log('Take profit order filled. Trade cycle completed.');
                volumeStats.trades.push({ quantity: parseFloat(orderData.q), time: Date.now() });
                updateVolumeStats();
                await cancelAllOpenOrdersAndReset(orderData.s);
                INITIAL_EQUITY_PERCENTAGE = Math.max(0.005, INITIAL_EQUITY_PERCENTAGE * 0.8);
                console.log(`Adjusted initial equity percentage to ${(INITIAL_EQUITY_PERCENTAGE * 100).toFixed(2)}% for next cycle`);
                if (isBotActive) {
                    console.log('익절 완료. 새로운 거래 사이클을 시작합니다.');
                    const msg = `✅ *익절 완료!* 🎉\n\n*심볼:* ${orderData.s}\n*수량:* ${parseFloat(orderData.q).toFixed(5)}\n*가격:* ${parseFloat(orderData.p).toFixed(1)} USDT\n*총 가치:* ${tradeValueUSD.toFixed(2)} USDT\n\n새로운 사이클 시작. *현재 잔액:* ${(await getAccountBalance()).toFixed(2)} USDT\n*총 누적 거래량:* ${totalTradedVolumeUSD.toFixed(2)} USDT`;
                    sendTelegramMessage(msg).catch(console.error);
                    await executeInitialMarketBuy();
                }
            }
        } else if (['CANCELED', 'REJECTED', 'EXPIRED'].includes(orderData.X)) {
            console.log(`Order ${orderData.i} (${orderData.o} ${orderData.S}) was ${orderData.X}.`);
            if (currentPosition.takeProfitOrderId && orderData.i.toString() === currentPosition.takeProfitOrderId.toString()) currentPosition.takeProfitOrderId = null;
            if (currentPosition.martingaleBuyOrderId && orderData.i.toString() === currentPosition.martingaleBuyOrderId.toString()) currentPosition.martingaleBuyOrderId = null;
        }
    } else if (message.e === 'ACCOUNT_UPDATE') {
        console.log('Account Update:', message);
    } else if (message.e === 'listenKeyExpired') {
        console.error('ListenKey expired. Attempting to refresh and reconnect WebSocket.');
        activeListenKey = null; 
        activeListenKey = await createListenKey();
        if (activeListenKey) connectWebSocket();
        else { console.error("Failed to refresh ListenKey. Bot stopping."); isBotActive = false; }
    }
}

async function cancelAllOpenOrdersAndReset(symbol) {
    console.log(`Starting order cancellation and environment reset for ${symbol}`);
    isCancellingOrders = true;
    try {
        await cancelAllOpenOrders(symbol);
        let attempts = 0;
        const maxAttempts = 5;
        let openOrders = [];
        while (attempts < maxAttempts) {
            openOrders = (await getOpenOrders(symbol)).filter(o => o.status === 'NEW' || o.status === 'PARTIALLY_FILLED');
            if (openOrders.length === 0) break;
            console.log(`Found ${openOrders.length} active orders remaining, retrying cancellation (attempt ${attempts + 1}/${maxAttempts})`);
            for (const order of openOrders) await cancelOrder(symbol, order.orderId);
            await new Promise(resolve => setTimeout(resolve, 2000));
            attempts++;
        }
        if (openOrders.length > 0) console.error('Uncancelled orders after all attempts:', openOrders.map(o => o.orderId));
        else console.log('Successfully cancelled all open orders and verified.');
        currentPosition = { quantity: 0, averageEntryPrice: 0, entryValueUSD: 0, side: 'LONG', positionId: null, openOrderId: null, takeProfitOrderId: null, martingaleBuyOrderId: null };
        currentMartingaleLevel = 0;
        lastMarketBuyPrice = 0;
        lastMartingaleBuyPrice = 0;
        initialPositionQuantity = 0;
        console.log('Trading environment reset. Martingale level:', currentMartingaleLevel);
        console.log('[DEBUG] cancelAllOpenOrdersAndReset: Environment reset complete.');
    } catch (error) {
        console.error('Error during order cancellation and reset:', error);
    } finally {
        isCancellingOrders = false;
        console.log('Order cancellation lock released.');
    }
}

// ###################################################################################
// #                          BOT TRADING LOGIC                                      #
// ###################################################################################
let priceHistory = [];
function updateVolumeStats() {
    const now = Date.now();
    volumeStats.trades = volumeStats.trades.filter(t => t.time > now - 3600000);
    volumeStats.lastMinute = volumeStats.trades.filter(t => t.time > now - 60000).reduce((sum, t) => sum + t.quantity, 0);
    volumeStats.last5Minutes = volumeStats.trades.filter(t => t.time > now - 300000).reduce((sum, t) => sum + t.quantity, 0);
    volumeStats.lastHour = volumeStats.trades.reduce((sum, t) => sum + t.quantity, 0);
    volumeStats.lastUpdate = now;
    const currentPrice = priceCache.value;
    if (currentPrice > 0) {
        priceHistory.push({ price: currentPrice, time: now });
        priceHistory = priceHistory.filter(p => p.time > now - VOLATILITY_WINDOW);
    }
}

function calculateRecentVolatility() {
    if (priceHistory.length < 2) return 0;
    const priceChanges = [];
    for (let i = 1; i < priceHistory.length; i++) {
        priceChanges.push(Math.abs((priceHistory[i].price - priceHistory[i-1].price) / priceHistory[i-1].price));
    }
    return priceChanges.reduce((sum, change) => sum + change, 0) / priceChanges.length;
}

function activateCooldown(currentVolatility) {
    const severity = currentVolatility / MAX_VOLATILITY_THRESHOLD;
    const duration = BASE_COOLDOWN_PERIOD * Math.min(VOLATILITY_COOLDOWN_MULTIPLIER, severity);
    isCoolingDown = true;
    console.log(`Starting cooldown for ${(duration/1000).toFixed(1)}s due to ${(currentVolatility*100).toFixed(2)}% volatility`);
    cancelAllOpenOrders(SYMBOL).then(() => console.log('All pending orders cancelled during cooldown.'))
        .catch(err => console.error('Error cancelling orders during cooldown:', err));
    setTimeout(() => { isCoolingDown = false; console.log('Cooldown ended.'); }, duration);
}

function displayVolumeStats() {
    const rsiDisplay = isNaN(currentRsi) ? "Calculating..." : currentRsi.toFixed(2);
    console.log(`\x1b[36m=== Vol Stats (BTC): 1m: ${volumeStats.lastMinute.toFixed(3)}, 5m: ${volumeStats.last5Minutes.toFixed(3)}, 1h: ${volumeStats.lastHour.toFixed(3)} | Current RSI(${RSI_PERIOD}): ${rsiDisplay} ===\x1b[0m`);
}

function calculateQuantity(currentEquityUSD, percentage, price, leverage) {
    if (price <= 0) return 0;
    const MIN_ORDER_VALUE_USD = 5.0;
    let intendedOrderValueUSD = currentEquityUSD * percentage * leverage;
    let quantityBTC = intendedOrderValueUSD / price;
    if (intendedOrderValueUSD < MIN_ORDER_VALUE_USD) {
        console.warn(`Calculated order value ${intendedOrderValueUSD.toFixed(2)} USD is below minimum. Adjusting.`);
        quantityBTC = MIN_ORDER_VALUE_USD / price;
    }
    return parseFloat(quantityBTC.toFixed(5));
}

function adjustPricePrecision(price) {
    return parseFloat(price.toFixed(1));
}

async function executeInitialMarketBuy() {
    if (isCancellingOrders || isCoolingDown) {
        console.log(`Skipping market buy - ${isCancellingOrders ? 'cancellation in progress' : 'cooling down'}.`);
        return;
    }

    if (isNaN(currentRsi) || currentRsi < RSI_LOWER_BOUND || currentRsi > RSI_UPPER_BOUND) {
        const rsiStatus = isNaN(currentRsi) ? "데이터 없음" : currentRsi.toFixed(2);
        // console.log(`[RSI Condition] Not met: Current RSI ${rsiStatus} (Range: ${RSI_LOWER_BOUND}-${RSI_UPPER_BOUND}). Skipping initial buy.`);
        return;
    }
    console.log(`[RSI Condition] Met (Current RSI: ${currentRsi.toFixed(2)}). Proceeding with initial buy.`);
    
    const currentVolatility = calculateRecentVolatility();
    if (currentVolatility > MAX_VOLATILITY_THRESHOLD) {
        console.warn(`Volatility (${(currentVolatility*100).toFixed(2)}%) too high, entering cooldown.`);
        activateCooldown(currentVolatility);
        return;
    }
    
    console.log('Executing initial market buy...');
    try {
        let quantity = 0.0001; 
        console.log(`Fixed initial position quantity: ${quantity} BTC.`);
        quantity = parseFloat(quantity.toFixed(5));

        if (quantity <=0) {
            console.error("Calculated quantity for initial market buy is 0 or less. Skipping.");
            return;
        }
        console.log(`Placing initial market buy for ${quantity} ${SYMBOL}`);
        const order = await placeOrder(SYMBOL, 'BUY', 'LONG', 'MARKET', quantity);
        if (order) {
            currentPosition.openOrderId = order.orderId;
            console.log('Initial market buy order placed:', order.orderId);
        } else {
            console.error('Failed to place initial market buy order.');
        }
    } catch (error) {
        console.error('Error executing initial market buy:', error);
    }
}

async function placeInitialStrategyOrders() {
    console.log(`[Strategy] Placing initial strategy orders. Last Market Buy Price: ${lastMarketBuyPrice}, Initial Quantity: ${initialPositionQuantity}`);
    if (isCancellingOrders) { console.log('[Strategy] Skipped: Order cancellation in progress.'); return; }
    if (!lastMarketBuyPrice || !initialPositionQuantity) { console.error('[Strategy] Skipped: Missing price or quantity.'); return; }
    if (initialPositionQuantity <= 0) { console.error('[Strategy] Skipped: initialPositionQuantity is zero or negative.'); return; }

    try {
        const takeProfitPrice = adjustPricePrecision(lastMarketBuyPrice * (1 + MARTINGALE_TAKE_PROFIT_FEE_MULTIPLIER * FEE_LIMIT));
        console.log(`[Strategy] Preparing initial TP (SELL LIMIT): Price=${takeProfitPrice}, Qty=${initialPositionQuantity}`);
        const tpOrder = await placeOrder(SYMBOL, 'SELL', 'LONG', 'LIMIT', initialPositionQuantity, takeProfitPrice);
        if (tpOrder && tpOrder.orderId) {
            currentPosition.takeProfitOrderId = tpOrder.orderId;
            console.log(`[Strategy] Initial TP order placed: ID=${tpOrder.orderId}`);
        } else console.error('[Strategy] Failed to place initial TP order.');

        const martingaleBuyPrice = adjustPricePrecision(lastMarketBuyPrice * (1 - MARTINGALE_DROP_FEE_MULTIPLIER * FEE_LIMIT));
        const martingaleQuantity = parseFloat((initialPositionQuantity * MARTINGALE_MULTIPLIER).toFixed(5));
        console.log(`[Strategy] Preparing initial Martingale (BUY LIMIT): Price=${martingaleBuyPrice}, Qty=${martingaleQuantity}`);
        if (martingaleQuantity <= 0) { console.error('[Strategy] Skipped Martingale: Qty is zero or negative.'); return; }
        const mbOrder = await placeOrder(SYMBOL, 'BUY', 'LONG', 'LIMIT', martingaleQuantity, martingaleBuyPrice);
        if (mbOrder && mbOrder.orderId) {
            currentPosition.martingaleBuyOrderId = mbOrder.orderId;
            console.log(`[Strategy] Initial Martingale order placed: ID=${mbOrder.orderId}`);
        } else console.error('[Strategy] Failed to place initial Martingale order.');
    } catch (error) {
        console.error('[Strategy] Error in placeInitialStrategyOrders:', error.message, error.stack);
    }
}

async function DEPRECATED_placeInitialFollowUpOrders() { /* ... */ }

async function placeNextMartingaleStageOrders() {
    if (isCancellingOrders) { console.log('[Martingale] Skipping: cancellation in progress.'); return; }
    console.log(`[Martingale] Placing next stage. Level: ${currentMartingaleLevel}, AvgPrice: ${currentPosition.averageEntryPrice}, Qty: ${currentPosition.quantity}`);
    if (initialPositionQuantity <= 0) { console.error('[Martingale] Skipped: initialPositionQuantity is zero or negative.'); return; }

    try {
        if (currentPosition.takeProfitOrderId) await cancelOrder(SYMBOL, currentPosition.takeProfitOrderId);
        if (currentPosition.martingaleBuyOrderId) await cancelOrder(SYMBOL, currentPosition.martingaleBuyOrderId);
        currentPosition.takeProfitOrderId = null; currentPosition.martingaleBuyOrderId = null;
        
        const freshPosition = await getCurrentPosition(SYMBOL);
        if (!freshPosition || freshPosition.quantity <= 0) {
            console.error('[Martingale] No current position or zero quantity. Resetting.');
            await cancelAllOpenOrdersAndReset(SYMBOL); return;
        }
        currentPosition.quantity = freshPosition.quantity;
        currentPosition.averageEntryPrice = freshPosition.averageEntryPrice;

        const takeProfitPrice = adjustPricePrecision(currentPosition.averageEntryPrice * (1 + MARTINGALE_TAKE_PROFIT_FEE_MULTIPLIER * FEE_LIMIT));
        console.log(`[Martingale] New TP: Price=${takeProfitPrice}, Qty=${currentPosition.quantity}`);
        const tpOrder = await placeOrder(SYMBOL, 'SELL', 'LONG', 'LIMIT', currentPosition.quantity, takeProfitPrice);
        if (tpOrder) currentPosition.takeProfitOrderId = tpOrder.orderId;

        if (currentMartingaleLevel < MAX_MARTINGALE_ENTRIES) {
            const nextBuyPrice = adjustPricePrecision(currentPosition.averageEntryPrice * (1 - MARTINGALE_DROP_FEE_MULTIPLIER * FEE_LIMIT));
            let nextBuyQuantity = parseFloat((initialPositionQuantity * Math.pow(MARTINGALE_MULTIPLIER, currentMartingaleLevel + 1)).toFixed(5));
            if (nextBuyQuantity <= 0) { console.error(`[Martingale] Invalid nextBuyQuantity: ${nextBuyQuantity}.`); return; }

            const currentBalance = await getAccountBalance();
            const requiredMargin = (nextBuyQuantity * nextBuyPrice) / LEVERAGE;
            const currentMarketPrice = await getCurrentBtcPrice();
            const marketBuyThreshold = nextBuyPrice * (1 - (MARTINGALE_DROP_FEE_MULTIPLIER * FEE_LIMIT * 2));
            let orderType = 'LIMIT', orderPrice = nextBuyPrice;

            if (currentMarketPrice < marketBuyThreshold) {
                console.warn(`[Martingale] Market price (${currentMarketPrice}) significantly below limit buy (${nextBuyPrice}). Executing MARKET buy.`);
                orderType = 'MARKET'; orderPrice = null;
            }

            if (currentBalance > requiredMargin * 1.5) {
                console.log(`[Martingale] Next Buy: Type=${orderType}, Price=${orderPrice ? orderPrice.toFixed(5) : 'Market'}, Qty=${nextBuyQuantity}`);
                const mbOrder = await placeOrder(SYMBOL, 'BUY', 'LONG', orderType, nextBuyQuantity, orderPrice);
                if (mbOrder) currentPosition.martingaleBuyOrderId = mbOrder.orderId;
            } else console.warn(`[Martingale] Insufficient balance for next entry. Required: ${requiredMargin.toFixed(2)}, Available: ${currentBalance.toFixed(2)}`);
        } else console.log('[Martingale] Max entries reached. Only TP placed.');
    } catch (error) {
        console.error('[Martingale] Error placing next stage orders:', error);
    }
}

async function runBotCycle() {
    if (!isBotActive) { console.log('Bot inactive. Not starting cycle.'); return; }
    console.log('Starting new trading cycle...');
    try {
        await setLeverage();
        await cancelAllOpenOrdersAndReset(SYMBOL);
        await executeInitialMarketBuy();
    } catch (error) {
        console.error('Error in bot cycle:', error);
    }
}

async function initializeBot() {
    console.log('[DEBUG] initializeBot called. Initializing trading bot...');
    if (isBotActive) { console.log('[DEBUG] Bot already active. Skipping.'); return; }
    isBotActive = false;

    const args = process.argv.slice(2);
    const valueIndex = args.indexOf('--value');
    if (valueIndex > -1 && args[valueIndex + 1]) {
        targetVolumeUSD = parseFloat(args[valueIndex + 1]);
        if (isNaN(targetVolumeUSD) || targetVolumeUSD <= 0) {
            console.error('Invalid --value. Provide positive number for target volume.'); process.exit(1);
        }
        console.log(`Target trading volume: ${targetVolumeUSD.toFixed(2)} USDT.`);
    } else console.log('No target volume specified. Bot runs indefinitely.');
    
    try {
        activeListenKey = await createListenKey();
        if (!activeListenKey) throw new Error('Failed to create listen key on init');
        connectWebSocket();
        
        setInterval(() => { if (activeListenKey) keepAliveListenKey(activeListenKey).catch(console.error); }, 30 * 60 * 1000);
        setInterval(displayVolumeStats, 5000); 
        setInterval(reportBotStatus, 5 * 60 * 1000);

        await fetchAndProcessRsiData(); 
        setInterval(fetchAndProcessRsiData, 60 * 1000); 

        setInterval(async () => { 
            if (!isBotActive) return;
            const timeSinceLastActivity = Date.now() - lastTradeActivityTime;
            if (timeSinceLastActivity > 60000) { 
                console.warn(`[Inactivity Check] No trade activity for ${timeSinceLastActivity / 1000}s.`);
                const currentPos = await getCurrentPosition(SYMBOL);
                if (!currentPos || currentPos.quantity === 0) { 
                    console.warn('[Inactivity Check] No active position. Resetting & restarting cycle if RSI allows.');
                    await cancelAllOpenOrdersAndReset(SYMBOL);
                    isBotActive = true; 
                    const msg = `⚠️ *비활성 감지 및 환경 리셋* ⚠️\n\n포지션 없음. RSI 조건 확인 후 새로운 거래 사이클을 시작합니다.\n\n*현재 잔액:* ${(await getAccountBalance()).toFixed(2)} USDT\n*총 누적 거래량:* ${totalTradedVolumeUSD.toFixed(2)} USDT`;
                    sendTelegramMessage(msg).catch(console.error);
                    await executeInitialMarketBuy(); 
                }
            }
        }, 60000);

        isBotActive = true;
        let initialPrice = 0, priceFetchAttempts = 0;
        const MAX_PRICE_FETCH_ATTEMPTS = 10, PRICE_FETCH_RETRY_DELAY = 5000;
        while (initialPrice === 0 && priceFetchAttempts < MAX_PRICE_FETCH_ATTEMPTS) {
            console.log(`[Init] Fetching initial BTC price (attempt ${priceFetchAttempts + 1}/${MAX_PRICE_FETCH_ATTEMPTS})...`);
            initialPrice = await getCurrentBtcPrice();
            if (initialPrice === 0) {
                console.warn(`[Init] Failed to fetch initial BTC price. Retrying in ${PRICE_FETCH_RETRY_DELAY / 1000}s.`);
                await new Promise(resolve => setTimeout(resolve, PRICE_FETCH_RETRY_DELAY));
                priceFetchAttempts++;
            }
        }
        if (initialPrice === 0) {
            console.error("[Init] Failed to fetch initial BTC price. Bot cannot start.");
            isBotActive = false; return;
        }
        console.log(`[Init] Initial BTC price fetched: ${initialPrice}`);
        await runBotCycle();
    } catch (error) {
        console.error('Critical Error initializing bot:', error);
        isBotActive = false;
        const delay = Math.min(10000 * (1 + Math.random()), 30000);
        console.log(`Attempting to reinitialize bot in ${Math.round(delay/1000)}s...`);
        setTimeout(initializeBot, delay);
    }
}

async function fetchAndCalculateIchimoku() { /* Deprecated */ }

// ###################################################################################
// #                          BOT STATUS REPORTING                                   #
// ###################################################################################
async function reportBotStatus() {
    if (!isBotActive) return;
    try {
        const balance = await getAccountBalance();
        const position = await getCurrentPosition(SYMBOL);
        const currentPrice = await getCurrentBtcPrice();
        let message = `📊 *봇 상태 보고 (${SYMBOL})* 📊\n\n`;
        message += `💰 *현재 잔액:* ${balance.toFixed(2)} USDT\n`;
        message += `📈 *현재 가격:* ${currentPrice.toFixed(1)} USDT\n`;
        message += `📊 *현재 RSI (${RSI_PERIOD}):* ${isNaN(currentRsi) ? "계산 중..." : currentRsi.toFixed(2)}\n`;

        if (position && position.quantity > 0) {
            const roi = ((currentPrice - position.averageEntryPrice) / position.averageEntryPrice * 100);
            const roiEmoji = roi >= 0 ? '🟢' : '🔴';
            message += `\n💼 *현재 포지션:*\n`;
            message += `  수량: ${position.quantity.toFixed(5)} BTC\n`;
            message += `  평균 진입가: ${position.averageEntryPrice.toFixed(1)} USDT\n`;
            message += `  청산가: ${position.liquidationPrice ? position.liquidationPrice.toFixed(1) + ' USDT' : 'N/A'}\n`;
            message += `  ROI: ${roiEmoji} ${roi.toFixed(2)}%\n`;
            message += `  마팅게일 레벨: ${currentMartingaleLevel} / ${MAX_MARTINGALE_ENTRIES} (남은 횟수: ${MAX_MARTINGALE_ENTRIES - currentMartingaleLevel})\n`;
        } else {
            message += `\n💼 *현재 포지션:* 없음\n`;
            message += `  마팅게일 레벨: ${currentMartingaleLevel} / ${MAX_MARTINGALE_ENTRIES} (남은 횟수: ${MAX_MARTINGALE_ENTRIES - currentMartingaleLevel})\n`;
        }
        message += `\n📊 *총 누적 거래량:* ${totalTradedVolumeUSD.toFixed(2)} USDT`;
        if (targetVolumeUSD > 0) message += ` (목표: ${targetVolumeUSD.toFixed(2)} USDT)`;
        message += `\n\n_다음 보고까지 5분_`;
        sendTelegramMessage(message).catch(console.error);
    } catch (error) {
        console.error('Error reporting bot status:', error);
    }
}

// Start the bot
initializeBot();
