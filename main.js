// main.js
const axios = require('axios');
const crypto = require('crypto');
const WebSocket = require('ws');

// ###################################################################################
// #                          USER CONFIGURATION                                     #
// ###################################################################################
const API_KEY = "qhxtZWMafFAiFI8i6GAdwFfDdsPDSoNwHFpFEg1e4QDV9znMhImtHWS9wjR7ZM9Iz0Lau1Yw6JFOOgSXAfA"
const SECRET_KEY = "o6YlTcQzmzDMocYsszuTbF7AXHdxZtSk4f76QPPWW1wSUQCMdRMUTJCRB3uR3g3Pn3PeLi4xyhf0qjTU7Q"
const SYMBOL = "BTC-USDT";
const LEVERAGE = 100; // 50x leverage
let INITIAL_EQUITY_PERCENTAGE = 0.01; // 1% of equity for the first trade
const MARTINGALE_MULTIPLIER = 1.5; // Double the position size for subsequent Martingale entries
const MAX_MARTINGALE_ENTRIES = 6; // Maximum martingale attempt count
const EXIT_ROI_THRESHOLD = -0.10; // Position liquidation threshold when ROI <= -10%

// Fee percentages (as decimals)
const FEE_LIMIT = 0.000064; // 0.0064%
const FEE_MARKET = 0.00016;  // 0.016%

// Take Profit / Martingale Entry Logic Percentages (as decimals)
const INITIAL_TAKE_PROFIT_PERCENTAGE = 0.00032; // 0.032% (Market buy price * (1 + 0.032%))
const MARTINGALE_DROP_FEE_MULTIPLIER = 7; // Drop by (Limit Fee * 7) for Martingale limit buy
const MARTINGALE_TAKE_PROFIT_FEE_MULTIPLIER = 2; // Take profit at (Avg Buy Price * (1 + Limit Fee * 2))
const BASE_SLIPPAGE_PERCENT = 0.002; // 0.2% base slippage tolerance
const MAX_SLIPPAGE_PERCENT = 0.005; // 0.5% maximum allowed slippage
const MIN_PROFIT_PERCENT = 0.0005; // 0.05% minimum profit target
const VOLATILITY_FACTOR = 3; // Multiplier for volatility-adjusted slippage
const VOLATILITY_WINDOW = 60000; // 1 minute window for volatility calculation
const MAX_VOLATILITY_THRESHOLD = 0.01; // 1% - pause trading if volatility exceeds this
const BASE_COOLDOWN_PERIOD = 30000; // 30 seconds base cooling off period
const VOLATILITY_COOLDOWN_MULTIPLIER = 2; // Cooldown multiplier for extreme volatility
const MIN_POSITION_SIZE_FACTOR = 0.5; // Minimum position size during high volatility


const API_BASE_URL = 'https://open-api.bingx.com';
const WEBSOCKET_URL = 'wss://open-api-swap.bingx.com/swap-market';
// For VST (Demo Trading), use:
// const API_BASE_URL = 'https://open-api-vst.bingx.com';
// const WEBSOCKET_URL = 'wss://open-api-vst.bingx.com/swap-market';


// ###################################################################################
// #                          STATE VARIABLES                                        #
// ###################################################################################
let totalInitialEquityUSD = 0; // To be fetched once at the start
let currentMartingaleLevel = 0; // 0 for initial trade, 1 for first martingale, etc.
let isCancellingOrders = false; // Lock to prevent order creation during cancellation
// Volume tracking
let volumeStats = {
    lastMinute: 0,
    last5Minutes: 0,
    lastHour: 0,
    trades: [],
    lastUpdate: Date.now()
};
let currentPosition = { // Stores details of the current aggregated position
    quantity: 0,          // Total quantity in BTC
    averageEntryPrice: 0,
    entryValueUSD: 0,     // Total USD value at entry (without leverage)
    side: 'LONG',
    positionId: null,     // If available from API
    openOrderId: null,    // ID of the current open order (e.g., TP or next Martingale buy)
    takeProfitOrderId: null,
    martingaleBuyOrderId: null,
};
let activeListenKey = null;
let ws = null;
let isBotActive = false; // To control the bot's operation loop
let lastMarketBuyPrice = 0; // Price of the very first market buy of a cycle
let lastMartingaleBuyPrice = 0; // Price of the last filled Martingale buy order
let initialPositionQuantity = 0; // Quantity of the initial market buy
let isCoolingDown = false; // Flag for volatility-induced cooldown
let lastVolatilityAlert = 0; // Time of last volatility alert


// ###################################################################################
// #                          API UTILITIES                                          #
// ###################################################################################

/**
 * Generates the HMAC-SHA256 signature for API requests.
 * @param {string} paramsString - The query string or request body.
 * @param {string} secretKey - The API secret key.
 * @returns {string} The hexadecimal signature.
 */
function generateSignature(paramsString, secretKey) {
    if (!secretKey || !paramsString) {
        throw new Error('Invalid parameters for signature generation');
    }
    return crypto.createHmac('sha256', secretKey).update(paramsString).digest('hex');
}

/**
 * Creates a query string from an object, sorted alphabetically.
 * @param {object} params - The parameters object.
 * @returns {string} The formatted query string.
 */
function createQueryString(params) {
    return Object.keys(params)
        .sort()
        .map(key => `${key}=${encodeURIComponent(params[key])}`)
        .join('&');
}

/**
 * Makes a request to the BingX API.
 * @param {string} method - HTTP method (GET, POST, DELETE).
 * @param {string} path - API endpoint path.
 * @param {object} params - Request parameters (for GET query or POST body).
 * @param {boolean} needsSignature - Whether the endpoint requires a signature.
 * @returns {Promise<object>} The API response data.
 */
async function apiRequest(method, path, params = {}, needsSignature = true) {
    if (!API_KEY || !SECRET_KEY) {
        throw new Error('API credentials not configured');
    }
    
    const timestamp = Date.now();
    let queryString = '';
    let requestBody = null;

    if (method === 'GET' || method === 'DELETE') {
        const allParams = { ...params, timestamp };
        // console.log('[DEBUG] GET/DELETE params with timestamp:', allParams);
        
        if (needsSignature) {
            queryString = createQueryString(allParams);
            // console.log('[DEBUG] Query string for signature:', queryString);
            
            const signature = generateSignature(queryString, SECRET_KEY);
            // console.log('[DEBUG] Generated signature:', signature);
            
            queryString += `&signature=${signature}`;
            // console.log('[DEBUG] Final query string:', queryString);
        } else {
            queryString = createQueryString(allParams);
        }
    } else { // POST
        const allParams = { ...params, timestamp };
        // console.log('[DEBUG] POST params with timestamp:', allParams);
        
        queryString = createQueryString(allParams);
        // console.log('[DEBUG] POST query string for signature:', queryString);
        
        if (needsSignature) {
            const signature = generateSignature(queryString, SECRET_KEY);
            // console.log('[DEBUG] POST generated signature:', signature);
            
            queryString += `&signature=${signature}`;
            // console.log('[DEBUG] POST final query string:', queryString);
        }
    }

    const url = `${API_BASE_URL}${path}${queryString ? '?' + queryString : ''}`;
    const headers = {
        'X-BX-APIKEY': API_KEY,
    };

    try {
        const response = await axios({
            method: method,
            url: url,
            headers: headers,
            data: method === 'POST' ? requestBody : null, 
        });
        // console.log(`Response from ${path}:`, response.data);
        if (path === '/openApi/user/auth/userDataStream') {
            if (response.data.listenKey) {
                return response.data;
            }
            throw new Error('Failed to create listenKey: ' + JSON.stringify(response.data));
        }

        if (response.data.code !== 0) {
            console.error(`API Error from ${path}:`, response.data);
            throw new Error(`API Error: ${response.data.msg || 'Unknown error'} (Code: ${response.data.code || 'Unknown'})`);
        }
        return response.data.data;
    } catch (error) {
        console.error(`Error during API request to ${path}:`, error.isAxiosError ? error.message : error);
        if (error.response) {
            console.error('Error response data:', error.response.data);
            console.error('Error response status:', error.response.status);
        }
        throw error;
    }
}

// ###################################################################################
// #                          BINGX API FUNCTIONS                                    #
// ###################################################################################

let balanceCache = { value: 0, timestamp: 0 };
const BALANCE_CACHE_TTL = 60000; // 1 minute

async function getAccountBalance() {
    const now = Date.now();
    if (now - balanceCache.timestamp < BALANCE_CACHE_TTL) {
        return balanceCache.value;
    }

    try {
        const balanceData = await apiRequest('GET', '/openApi/swap/v2/user/balance', { currency: 'USDT' });
        if (balanceData?.balance?.balance) {
            balanceCache = {
                value: parseFloat(balanceData.balance.balance),
                timestamp: now
            };
            return balanceCache.value;
        }
        return 0;
    } catch (error) {
        console.error('Error fetching account balance:', error);
        return balanceCache.value; // Return cached value on error
    }
}

let priceCache = { value: 0, timestamp: 0 };
const PRICE_CACHE_TTL = 10000; // 10 seconds

async function getCurrentBtcPrice() {
    const now = Date.now();
    if (now - priceCache.timestamp < PRICE_CACHE_TTL) {
        return priceCache.value;
    }

    try {
        const priceData = await apiRequest('GET', '/openApi/swap/v2/quote/price', { symbol: SYMBOL }, false);
        if (priceData?.price) {
            priceCache = {
                value: parseFloat(priceData.price),
                timestamp: now
            };
            return priceCache.value;
        }
        return 0;
    } catch (error) {
        console.error('Error fetching price:', error);
        return priceCache.value; // Return cached value on error
    }
}

async function setLeverage() {
    console.log(`Setting leverage for ${SYMBOL} to ${LEVERAGE}x for LONG side...`);
    try {
        await apiRequest('POST', '/openApi/swap/v2/trade/leverage', {
            symbol: SYMBOL,
            side: 'LONG', 
            leverage: LEVERAGE,
            timestamp: Date.now()
        });
        console.log(`Leverage for ${SYMBOL} (LONG) set to ${LEVERAGE}x successfully.`);
    } catch (error) {
        console.error('Error setting leverage:', error.message);
    }
}


/**
 * Places an order on BingX.
 * @param {string} symbol - Trading symbol (e.g., 'BTC-USDT').
 * @param {string} side - 'BUY' or 'SELL'.
 * @param {string} positionSide - 'LONG' or 'SHORT' (or 'BOTH' for one-way mode).
 * @param {string} type - Order type ('MARKET', 'LIMIT', 'TAKE_PROFIT_MARKET', etc.).
 * @param {number} quantity - Order quantity in base asset (BTC for BTC-USDT).
 * @param {number} [price] - Order price (required for LIMIT orders).
 * @param {number} [stopPrice] - Trigger price for conditional orders.
 * @param {object} [takeProfitParams] - Optional take profit parameters.
 * @param {object} [stopLossParams] - Optional stop loss parameters.
 * @returns {Promise<object|null>} The order details from API or null on failure.
 */
async function placeOrder(symbol, side, positionSide, type, quantity, price = null, stopPrice = null, takeProfitParams = null, stopLossParams = null) {
    if (!symbol || !side || !positionSide || !type || !quantity) {
        throw new Error('Missing required order parameters');
    }
    if (quantity <= 0) {
        throw new Error('Invalid order quantity: Must be greater than 0. Received: ' + quantity);
    }
    
    if (type === 'MARKET') {
        const currentPrice = await getCurrentBtcPrice();
        const recentVolatility = calculateRecentVolatility();
        const dynamicSlippage = BASE_SLIPPAGE_PERCENT * (1 + (recentVolatility * VOLATILITY_FACTOR));
        
        if (side === 'BUY') {
            const positionSizeFactor = Math.max(MIN_POSITION_SIZE_FACTOR, 1 - (recentVolatility * 10));
            price = currentPrice * (1 + dynamicSlippage);
            quantity *= positionSizeFactor;
        } else { // SELL
            price = currentPrice * (1 - dynamicSlippage);
        }
        console.log(`Adjusted ${type} ${side} price with dynamic slippage tolerance: ${price}`);
    } else if (type === 'LIMIT' && !price) {
        throw new Error('Limit orders require a price');
    }
    
    console.log(`[Order] Placing ${type} ${side} ${quantity.toFixed(5)} ${symbol} at ${price ? price.toFixed(5) : 'Market'}`);
    const params = {
        symbol,
        side,
        positionSide,
        type,
        quantity: quantity.toString(), // Ensure quantity is a string
        timeInForce: 'GTC' 
    };

    if (price !== null) {
        params.price = price.toString(); // Ensure price is a string
    }
    if (stopPrice !== null) {
        params.stopPrice = stopPrice.toString();
    }
    // Marking Martingale BUY orders for potential specific cancellation logic later
    if (type === 'LIMIT' && side === 'BUY' && currentMartingaleLevel > 0) { 
        params.isMartingale = true;
    }


    try {
        const orderResponse = await apiRequest('POST', '/openApi/swap/v2/trade/order', params);
        if (orderResponse && orderResponse.order) {
            console.log(`Order placed successfully. Order ID: ${orderResponse.order.orderId}`);
            const order = orderResponse.order;
            if (params.isMartingale) { // Ensure this custom flag is attached if needed
                order.isMartingale = true;
            }
            return order;
        }
        console.error('Failed to place order, response:', orderResponse);
        return null;
    } catch (error) {
        console.error(`Error placing order (${type} ${side} ${quantity} ${symbol}):`, error.message);
        return null;
    }
}

async function getOpenOrders(symbol) {
    console.log(`Fetching open orders for ${symbol}...`);
    try {
        const openOrdersData = await apiRequest('GET', '/openApi/swap/v2/trade/openOrders', { symbol });
        return openOrdersData.orders || [];
    } catch (error) {
        console.error('Error fetching open orders:', error);
        return [];
    }
}

async function cancelOrder(symbol, orderId) {
    console.log(`Attempting to cancel order ${orderId}...`);
    try {
        const result = await apiRequest('DELETE', '/openApi/swap/v2/trade/order', {
            symbol,
            orderId: orderId.toString(),
        });
        console.log(`Cancel confirmation for order ${orderId}:`, result);
        return true;
    } catch (error) {
        console.error(`Detailed error cancelling order ${orderId}:`, error);
        return false;
    }
}

async function getCurrentPosition(symbol) {
    console.log(`Fetching current position for ${symbol}...`);
    try {
        const positionData = await apiRequest('GET', '/openApi/swap/v2/user/positions', { symbol });
        if (positionData && Array.isArray(positionData) && positionData.length > 0) {
            const longPosition = positionData.find(p => p.symbol === symbol && p.positionSide === 'LONG');
            if (longPosition && parseFloat(longPosition.positionAmt) > 0) {
                console.log('Current LONG position:', longPosition);
                return {
                    quantity: parseFloat(longPosition.positionAmt),
                    averageEntryPrice: parseFloat(longPosition.avgPrice),
                    positionId: longPosition.positionId, 
                };
            }
        }
        console.log(`No active LONG position found for ${symbol}.`);
        return null; 
    } catch (error) {
        console.error('Error fetching current position:', error);
        return null;
    }
}

async function cancelAllOpenOrders(symbol) {
    console.log(`Attempting to cancel all open orders for ${symbol}...`);
    try {
        const result = await apiRequest('DELETE', '/openApi/swap/v2/trade/allOpenOrders', {
            symbol,
        });
        console.log(`Cancel all orders confirmation:`, result);
        return true;
    } catch (error) {
        console.error(`Detailed error cancelling all orders:`, error);
        return false;
    }
}


// ###################################################################################
// #                          WEBSOCKET HANDLING                                     #
// ###################################################################################

async function createListenKey() {
    console.log('Creating ListenKey...');
    try {
        const response = await apiRequest('POST', '/openApi/user/auth/userDataStream', {}, true);
        if (response && response.listenKey) {
            console.log('ListenKey created:', response.listenKey);
            return response.listenKey;
        }
        console.error('Failed to create ListenKey.');
        return null;
    } catch (error) {
        console.error('Error creating ListenKey:', error);
        return null;
    }
}

async function keepAliveListenKey(key) {
    if (!key) return;
    console.log('Pinging ListenKey to keep alive...');
    try {
        await apiRequest('PUT', '/openApi/user/auth/userDataStream', { listenKey: key }, true);
        console.log('ListenKey kept alive.');
    } catch (error) {
        console.error('Error keeping ListenKey alive:', error);
        activeListenKey = await createListenKey(); 
        if (activeListenKey) {
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
    console.log(`Connecting to WebSocket: ${wsUrlWithKey}`);

    if (ws) {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            console.log("Closing existing WebSocket connection...");
            ws.removeAllListeners();
            ws.close();
        }
    }

    ws = new WebSocket(wsUrlWithKey);

    pingIntervalId = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            try {
                ws.ping();
            } catch (e) {
                console.error('[WebSocket] Ping failed:', e);
            }
        }
    }, PING_INTERVAL);

    ws.on('open', () => {
        console.log('WebSocket connection established.');
        reconnectAttempts = 0; 
        ws.ping();
    });

    ws.on('message', (data) => {
        try {
            let messageString = data.toString();
            if (messageString === 'Ping') {
                return ws.send('Pong');
            }
            if (data instanceof Buffer) {
                try {
                    messageString = require('zlib').gunzipSync(data).toString();
                } catch (e) {
                    // console.log('[WebSocket] Non-GZIP binary message or already uncompressed');
                }
            }
            if (messageString.startsWith('{') || messageString.startsWith('[')) {
                const message = JSON.parse(messageString);
                lastReceivedMessageTime = Date.now(); 
                
                if (message.e === 'ORDER_TRADE_UPDATE') {
                    handleWebSocketMessage(message).catch(console.error);
                } else if (message.e === 'aggTrade') {  
                    const tradeQty = parseFloat(message.q);
                    volumeStats.trades.push({
                        quantity: tradeQty,
                        time: Date.now()
                    });
                    updateVolumeStats();
                } else if (message.e !== 'SNAPSHOT') { 
                    // console.log(`[WebSocket] Received message type: ${message.e}`);
                }
            }
        } catch (error) {
            console.error('Error processing WebSocket message:', error, 'Raw data:', data.toString());
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });

    ws.on('close', async (code, reason) => {
        console.log(`WebSocket connection closed. Code: ${code}, Reason: ${reason.toString()}`);
        cleanupWebSocket();
        
        if (!isBotActive) return;

        const isPermanentError = [1002, 1003, 1007, 1008, 1009, 1010, 1011].includes(code);
        if (isPermanentError) {
            console.error('Permanent WebSocket error detected. Stopping bot.');
            isBotActive = false;
            return;
        }

        const baseDelay = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
        const jitter = Math.random() * 2000; 
        const delay = baseDelay + jitter;
        reconnectAttempts++;
        
        console.log(`Attempting to reconnect WebSocket in ${(delay/1000).toFixed(1)} seconds (attempt ${reconnectAttempts})...`);
        
        setTimeout(async () => {
            try {
                if (!activeListenKey || code === 1006) { 
                    console.log('Refreshing listen key...');
                    activeListenKey = await createListenKey();
                }
                if (activeListenKey) {
                    connectWebSocket();
                } else {
                    console.error("Failed to get a new listen key for reconnection. Bot stopping.");
                    isBotActive = false;
                }
            } catch (error) {
                console.error("WebSocket reconnection failed:", error);
                if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                     setTimeout(connectWebSocket, delay); // Try again after delay
                } else {
                    console.error('Maximum reconnect attempts reached. Stopping bot.');
                    isBotActive = false;
                }
            }
        }, delay);
    });

    healthCheckIntervalId = setInterval(() => {
        if (lastReceivedMessageTime === 0 && ws.readyState === WebSocket.OPEN) { // If connected but no message yet
             lastReceivedMessageTime = Date.now(); // Start timer
        }
        const timeSinceLastMessage = Date.now() - lastReceivedMessageTime;
        if (ws.readyState === WebSocket.OPEN && timeSinceLastMessage > 60000) { 
            console.warn(`No messages received for ${timeSinceLastMessage/1000} seconds. Reconnecting...`);
            ws.close(); 
        }
    }, HEALTH_CHECK_INTERVAL);
}

async function handleWebSocketMessage(message) {
    if (message.e === 'ORDER_TRADE_UPDATE') {
        const orderData = message.o;
        if (orderData.X === 'FILLED') {
            const currentPrice = await getCurrentBtcPrice(); // Get fresh price
            console.log(`Order Update [${orderData.X}]: Symbol: ${orderData.s}, Side: ${orderData.S}, Type: ${orderData.o}, Qty: ${orderData.q}, Price: ${orderData.p}, OrderID: ${orderData.i}, Current Market: ${currentPrice}`);

            // Price deviation check
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
                initialPositionQuantity = parseFloat(orderData.q); // Set initial quantity global variable

                placeInitialStrategyOrders().catch(console.error); // Call the new strategy function

                volumeStats.trades.push({ quantity: parseFloat(orderData.q), time: Date.now() });
                updateVolumeStats();

            } else if (orderData.o === 'LIMIT' && orderData.S === 'BUY') { // Martingale Buy
                console.log('Martingale buy order filled.');
                lastMartingaleBuyPrice = parseFloat(orderData.p);
                currentMartingaleLevel++;
                
                // Update aggregated position (simplified, real update should come from API or sum up)
                const newQuantity = currentPosition.quantity + parseFloat(orderData.q);
                currentPosition.averageEntryPrice = ((currentPosition.averageEntryPrice * currentPosition.quantity) + (parseFloat(orderData.p) * parseFloat(orderData.q))) / newQuantity;
                currentPosition.quantity = newQuantity;
                currentPosition.entryValueUSD = currentPosition.quantity * currentPosition.averageEntryPrice;


                volumeStats.trades.push({ quantity: parseFloat(orderData.q), time: Date.now() });
                updateVolumeStats();
                
                if (currentMartingaleLevel < MAX_MARTINGALE_ENTRIES) {
                    await placeNextMartingaleStageOrders().catch(console.error);
                } else {
                    console.log(`Maximum martingale entries (${MAX_MARTINGALE_ENTRIES}) reached.`);
                    // Potentially place a final TP based on the new average price or close if ROI is too low
                    const roi = (currentPrice - currentPosition.averageEntryPrice) / currentPosition.averageEntryPrice;
                     if (roi <= EXIT_ROI_THRESHOLD) {
                        console.log(`Martingale limit reached and ROI ${roi.toFixed(4)} <= ${EXIT_ROI_THRESHOLD} threshold. Exiting position.`);
                        const sellOrder = await placeOrder(SYMBOL, 'SELL', 'LONG', 'MARKET', currentPosition.quantity);
                        if (sellOrder) {
                            console.log('Market SELL order placed to exit position after max martingale.');
                            await cancelAllOpenOrdersAndReset(SYMBOL); // Reset after exit
                        }
                    } else {
                         console.log(`Max martingale entries reached, ROI ${roi.toFixed(4)} is above exit threshold. Holding. Consider manual TP.`);
                    }
                }
            } else if ((orderData.o === 'TAKE_PROFIT_MARKET' || orderData.o === 'LIMIT') && orderData.S === 'SELL') { // Take Profit
                console.log('Take profit order filled. Trade cycle completed.');
                volumeStats.trades.push({ quantity: parseFloat(orderData.q), time: Date.now() });
                updateVolumeStats();

                await cancelAllOpenOrdersAndReset(orderData.s); // Cancel any remaining orders (e.g. martingale buy) and reset state

                INITIAL_EQUITY_PERCENTAGE = Math.max(0.005, INITIAL_EQUITY_PERCENTAGE * 0.8); // Conservative adjustment
                console.log(`Adjusted initial equity percentage to ${(INITIAL_EQUITY_PERCENTAGE * 100).toFixed(2)}% for next cycle`);

                if (isBotActive) {
                    console.log('Preparing to start new trading cycle after TP.');
                    await new Promise(resolve => setTimeout(resolve, 1000)); // Delay
                    const remainingOrders = await getOpenOrders(SYMBOL);
                    if (remainingOrders.length === 0) {
                        await executeInitialMarketBuy();
                    } else {
                        console.error('Cannot start new cycle - open orders still exist after TP:', remainingOrders);
                    }
                }
            }
        } else if (['CANCELED', 'REJECTED', 'EXPIRED'].includes(orderData.X)) {
            console.log(`Order ${orderData.i} (${orderData.o} ${orderData.S}) was ${orderData.X}.`);
            if (currentPosition.takeProfitOrderId && orderData.i.toString() === currentPosition.takeProfitOrderId.toString()) {
                currentPosition.takeProfitOrderId = null;
            }
            if (currentPosition.martingaleBuyOrderId && orderData.i.toString() === currentPosition.martingaleBuyOrderId.toString()) {
                currentPosition.martingaleBuyOrderId = null;
            }
            // Add logic here if orders need to be re-placed or strategy adjusted.
            // For example, if a TP is cancelled, should we try to place it again?
        }
    } else if (message.e === 'ACCOUNT_UPDATE') {
        console.log('Account Update:', message);
    } else if (message.e === 'listenKeyExpired') {
        console.error('ListenKey expired. Attempting to refresh and reconnect WebSocket.');
        activeListenKey = null; 
        activeListenKey = await createListenKey();
        if (activeListenKey) {
            connectWebSocket();
        } else {
            console.error("Failed to refresh ListenKey. Bot stopping.");
            isBotActive = false;
        }
    }
}

async function cancelAllOpenOrdersAndReset(symbol) {
    console.log(`Starting order cancellation and environment reset for ${symbol}`);
    isCancellingOrders = true;
    try {
        await cancelAllOpenOrders(symbol); // Call the BingX API function
        
        let attempts = 0;
        const maxAttempts = 5;
        const retryDelayMs = 2000;
        let openOrders = [];

        while (attempts < maxAttempts) {
            openOrders = (await getOpenOrders(symbol)).filter(o => o.status === 'NEW' || o.status === 'PARTIALLY_FILLED');
            if (openOrders.length === 0) break;
            
            console.log(`Found ${openOrders.length} active orders remaining, retrying cancellation (attempt ${attempts + 1}/${maxAttempts})`);
            // Individual cancellation for any stragglers not caught by cancelAllOpenOrders
            for (const order of openOrders) {
                await cancelOrder(symbol, order.orderId);
            }
            await new Promise(resolve => setTimeout(resolve, retryDelayMs));
            attempts++;
        }

        if (openOrders.length > 0) {
            console.error('Uncancelled orders after all attempts:', openOrders.map(o => o.orderId));
            // Decide if bot should stop or throw error
        } else {
            console.log('Successfully cancelled all open orders and verified.');
        }

        currentPosition = { quantity: 0, averageEntryPrice: 0, entryValueUSD: 0, side: 'LONG', positionId: null, openOrderId: null, takeProfitOrderId: null, martingaleBuyOrderId: null };
        currentMartingaleLevel = 0;
        lastMarketBuyPrice = 0;
        lastMartingaleBuyPrice = 0;
        initialPositionQuantity = 0; 
        console.log('Trading environment reset. Martingale level:', currentMartingaleLevel);
        
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
    volumeStats.trades = volumeStats.trades.filter(t => t.time > now - 3600000); // Keep 1hr of trades
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
    const averageChange = priceChanges.reduce((sum, change) => sum + change, 0) / priceChanges.length;
    return averageChange; // Simplified: returns average absolute percentage change
}

function activateCooldown(currentVolatility) {
    const severity = currentVolatility / MAX_VOLATILITY_THRESHOLD;
    const duration = BASE_COOLDOWN_PERIOD * Math.min(VOLATILITY_COOLDOWN_MULTIPLIER, severity);
    isCoolingDown = true;
    console.log(`Starting cooldown for ${(duration/1000).toFixed(1)} seconds due to ${(currentVolatility*100).toFixed(2)}% volatility`);
    
    cancelAllOpenOrders(SYMBOL).then(() => {
        console.log('All pending orders cancelled during cooldown initiation.');
    }).catch(err => {
        console.error('Error cancelling orders during cooldown initiation:', err);
    });
    
    setTimeout(() => {
        isCoolingDown = false;
        console.log('Cooldown period ended, resuming trading.');
    }, duration);
}

function displayVolumeStats() {
    console.log(`\x1b[36m=== Vol Stats (BTC): 1m: ${volumeStats.lastMinute.toFixed(3)}, 5m: ${volumeStats.last5Minutes.toFixed(3)}, 1h: ${volumeStats.lastHour.toFixed(3)} ===\x1b[0m`);
}

function calculateQuantity(currentEquityUSD, percentage, price, leverage) {
    if (price <= 0) return 0;
    const MIN_ORDER_VALUE_USD = 5.0; // BingX minimum order value for BTC/USDT perpetual
    
    let intendedOrderValueUSD = currentEquityUSD * percentage * leverage;
    let quantityBTC = intendedOrderValueUSD / price;

    // Ensure minimum order value
    if (intendedOrderValueUSD < MIN_ORDER_VALUE_USD) {
        console.warn(`Calculated order value ${intendedOrderValueUSD.toFixed(2)} USD is below minimum ${MIN_ORDER_VALUE_USD} USD. Adjusting to minimum.`);
        quantityBTC = MIN_ORDER_VALUE_USD / price * leverage; // This seems wrong, leverage is already applied
        quantityBTC = MIN_ORDER_VALUE_USD / price; // Corrected: quantity for a certain USD value at current price
    }
    
    return parseFloat(quantityBTC.toFixed(5)); // BTC typically to 5 decimal places
}

function adjustPricePrecision(price) {
    return parseFloat(price.toFixed(1)); // BTC/USDT price precision is 1 decimal place on BingX
}

async function executeInitialMarketBuy() {
    if (isCancellingOrders || isCoolingDown) {
        console.log(`Skipping market buy - ${isCancellingOrders ? 'cancellation in progress' : 'cooling down'}.`);
        return;
    }
    
    const currentVolatility = calculateRecentVolatility();
    if (currentVolatility > MAX_VOLATILITY_THRESHOLD) {
        console.warn(`Volatility (${(currentVolatility*100).toFixed(2)}%) too high, entering cooldown.`);
        activateCooldown(currentVolatility);
        return;
    }
    
    console.log('Executing initial market buy...');
    try {
        const currentEquity = await getAccountBalance();
        const currentPrice = await getCurrentBtcPrice();
        if (currentPrice === 0) {
            console.error("Cannot calculate quantity: BTC price is 0.");
            return;
        }
        
        let quantity = calculateQuantity(currentEquity, INITIAL_EQUITY_PERCENTAGE, currentPrice, LEVERAGE);
        
        // Reduce position size if volatility is elevated but below threshold
        if (currentVolatility > MAX_VOLATILITY_THRESHOLD * 0.7) {
            const reductionFactor = Math.max(MIN_POSITION_SIZE_FACTOR, 1 - (currentVolatility / MAX_VOLATILITY_THRESHOLD));
            quantity *= reductionFactor;
            console.log(`Reducing initial position size to ${(quantity.toFixed(5))} due to elevated volatility (${(currentVolatility*100).toFixed(2)}%).`);
        }
        quantity = parseFloat(quantity.toFixed(5)); // Final precision check

        if (quantity <=0) {
            console.error("Calculated quantity for initial market buy is 0 or less. Skipping.");
            return;
        }

        console.log(`Placing initial market buy for ${quantity} ${SYMBOL}`);
        const order = await placeOrder(SYMBOL, 'BUY', 'LONG', 'MARKET', quantity);

        if (order) {
            currentPosition.openOrderId = order.orderId; // Track the open order
            // Note: lastMarketBuyPrice and other currentPosition details are set in handleWebSocketMessage on FILL
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
    if (isCancellingOrders) {
        console.log('[Strategy] Skipped: Order cancellation in progress.');
        return;
    }
    if (!lastMarketBuyPrice || !initialPositionQuantity) {
        console.error('[Strategy] Skipped: Missing lastMarketBuyPrice or initialPositionQuantity.', { lastMarketBuyPrice, initialPositionQuantity });
        return;
    }
    if (initialPositionQuantity <= 0) {
        console.error('[Strategy] Skipped: initialPositionQuantity is zero or negative.');
        return;
    }

    try {
        // Take Profit Order (Close Long)
        const takeProfitPrice = adjustPricePrecision(lastMarketBuyPrice * (1 + MARTINGALE_TAKE_PROFIT_FEE_MULTIPLIER * FEE_LIMIT));
        console.log(`[Strategy] Preparing initial take profit (SELL LIMIT): Price=${takeProfitPrice}, Quantity=${initialPositionQuantity}`);
        try {
            const tpOrder = await placeOrder(SYMBOL, 'SELL', 'LONG', 'LIMIT', initialPositionQuantity, takeProfitPrice);
            if (tpOrder && tpOrder.orderId) {
                currentPosition.takeProfitOrderId = tpOrder.orderId;
                console.log(`[Strategy] Initial take profit order placed successfully: ID=${tpOrder.orderId}, Price=${takeProfitPrice}, Quantity=${initialPositionQuantity}`);
            } else {
                console.error('[Strategy] Failed to place initial take profit order. API Response:', tpOrder);
            }
        } catch (error) {
            console.error('[Strategy] Error placing initial take profit order:', error.message, error.stack);
        }

        // Martingale Entry Order (Open Long)
        const martingaleBuyPrice = adjustPricePrecision(lastMarketBuyPrice * (1 - MARTINGALE_DROP_FEE_MULTIPLIER * FEE_LIMIT));
        const martingaleQuantity = parseFloat((initialPositionQuantity * MARTINGALE_MULTIPLIER).toFixed(5));
        
        console.log(`[Strategy] Preparing initial martingale entry (BUY LIMIT): Price=${martingaleBuyPrice}, Quantity=${martingaleQuantity}`);
        if (martingaleQuantity <= 0) {
            console.error('[Strategy] Skipped martingale entry: Calculated quantity is zero or negative.', {martingaleQuantity});
            return;
        }

        try {
            const mbOrder = await placeOrder(SYMBOL, 'BUY', 'LONG', 'LIMIT', martingaleQuantity, martingaleBuyPrice);
            if (mbOrder && mbOrder.orderId) {
                currentPosition.martingaleBuyOrderId = mbOrder.orderId;
                console.log(`[Strategy] Initial martingale entry order placed successfully: ID=${mbOrder.orderId}, Price=${martingaleBuyPrice}, Quantity=${martingaleQuantity}`);
            } else {
                console.error('[Strategy] Failed to place initial martingale entry order. API Response:', mbOrder);
            }
        } catch (error) {
            console.error('[Strategy] Error placing initial martingale entry order:', error.message, error.stack);
        }

    } catch (error) {
        console.error('[Strategy] General error in placeInitialStrategyOrders:', error.message, error.stack);
    }
}

async function DEPRECATED_placeInitialFollowUpOrders() {
    // This function is preserved but no longer called by the primary strategy.
    // Original logic for volatility-adjusted follow-up orders.
    if (isCancellingOrders) {
        console.log('Skipping DEPRECATED follow-up orders - order cancellation in progress');
        return;
    }
    console.log('Executing DEPRECATED_placeInitialFollowUpOrders...');
    // ... (original content of the function)
}


async function placeNextMartingaleStageOrders() {
    if (isCancellingOrders) {
        console.log('[Martingale] Skipping next stage orders - cancellation in progress.');
        return;
    }
    console.log(`[Martingale] Placing next stage orders. Current Level: ${currentMartingaleLevel}, AvgPrice: ${currentPosition.averageEntryPrice}, Current Qty: ${currentPosition.quantity}`);

    try {
        // Cancel existing TP and Martingale buy if they exist from previous stage
        if (currentPosition.takeProfitOrderId) {
            await cancelOrder(SYMBOL, currentPosition.takeProfitOrderId);
            currentPosition.takeProfitOrderId = null;
        }
        if (currentPosition.martingaleBuyOrderId) { // This would be the one that just filled or an older one
            await cancelOrder(SYMBOL, currentPosition.martingaleBuyOrderId);
            currentPosition.martingaleBuyOrderId = null;
        }
        
        // Get updated position details after the last fill
        const freshPosition = await getCurrentPosition(SYMBOL);
        if (!freshPosition || freshPosition.quantity <= 0) {
            console.error('[Martingale] No current position or zero quantity found. Cannot proceed.');
            await cancelAllOpenOrdersAndReset(SYMBOL); // Reset if something is wrong
            return;
        }
        currentPosition.quantity = freshPosition.quantity;
        currentPosition.averageEntryPrice = freshPosition.averageEntryPrice; // Crucial update

        // New Take Profit based on the updated average entry price
        const takeProfitPrice = adjustPricePrecision(currentPosition.averageEntryPrice * (1 + MARTINGALE_TAKE_PROFIT_FEE_MULTIPLIER * FEE_LIMIT));
        console.log(`[Martingale] New TP: Price=${takeProfitPrice}, Quantity=${currentPosition.quantity}`);
        const tpOrder = await placeOrder(SYMBOL, 'SELL', 'LONG', 'LIMIT', currentPosition.quantity, takeProfitPrice);
        if (tpOrder) currentPosition.takeProfitOrderId = tpOrder.orderId;

        // Next Martingale Buy Order
        if (currentMartingaleLevel < MAX_MARTINGALE_ENTRIES) {
            const nextBuyPrice = adjustPricePrecision(currentPosition.averageEntryPrice * (1 - MARTINGALE_DROP_FEE_MULTIPLIER * FEE_LIMIT));
            const nextBuyQuantity = parseFloat((initialPositionQuantity * Math.pow(MARTINGALE_MULTIPLIER, currentMartingaleLevel + 1)).toFixed(5)); // Recalculate based on initial_pos_qty and current level for multiplier
            
            const currentBalance = await getAccountBalance();
            const requiredMargin = (nextBuyQuantity * nextBuyPrice) / LEVERAGE; // Simplified margin check

            if (currentBalance > requiredMargin * 1.5) { // Ensure enough balance for next entry + buffer
                 console.log(`[Martingale] Next Buy: Price=${nextBuyPrice}, Quantity=${nextBuyQuantity}`);
                const mbOrder = await placeOrder(SYMBOL, 'BUY', 'LONG', 'LIMIT', nextBuyQuantity, nextBuyPrice);
                if (mbOrder) currentPosition.martingaleBuyOrderId = mbOrder.orderId;
            } else {
                console.warn(`[Martingale] Insufficient balance for next martingale entry. Required: ${requiredMargin.toFixed(2)}, Available: ${currentBalance.toFixed(2)}`);
                 // Consider placing a TP only and stopping further martingale entries
            }
        } else {
            console.log('[Martingale] Max martingale entries reached. Only TP order placed.');
        }
    } catch (error) {
        console.error('[Martingale] Error placing next stage orders:', error);
    }
}

async function runBotCycle() {
    if (!isBotActive) {
        console.log('Bot is not active. Not starting new cycle.');
        return;
    }
    console.log('Starting new trading cycle...');
    try {
        await setLeverage();
        await cancelAllOpenOrdersAndReset(SYMBOL); // Ensure clean state before starting
        await executeInitialMarketBuy();
    } catch (error) {
        console.error('Error in bot cycle:', error);
    }
}

async function initializeBot() {
    console.log('Initializing trading bot...');
    isBotActive = true;
    
    try {
        activeListenKey = await createListenKey();
        if (!activeListenKey) throw new Error('Failed to create listen key on init');
        connectWebSocket();
        
        setInterval(() => {
            if (activeListenKey) keepAliveListenKey(activeListenKey).catch(console.error);
        }, 30 * 60 * 1000); // every 30 mins
        
        setInterval(displayVolumeStats, 5000);

        let watchdogAttempts = 0;
        setInterval(async () => { // Watchdog
            if (!isBotActive && watchdogAttempts < 5) { // Limit watchdog restart attempts
                watchdogAttempts++;
                console.warn(`Watchdog: Bot inactive. Attempting restart #${watchdogAttempts}...`);
                await initializeBot(); // Try to re-initialize
            } else if (isBotActive) {
                watchdogAttempts = 0; // Reset if bot is active
            } else if (watchdogAttempts >= 5) {
                console.error("Watchdog: Maximum restart attempts reached. Bot remains inactive.");
            }
        }, 60000); // Check every minute
        
        await runBotCycle(); // Start the first cycle
    } catch (error) {
        console.error('Critical Error initializing bot:', error);
        const delay = Math.min(10000 * (1 + Math.random()), 30000);
        console.log(`Attempting to reinitialize bot in ${Math.round(delay/1000)} seconds...`);
        setTimeout(initializeBot, delay);
    }
}

// Start the bot
initializeBot();
