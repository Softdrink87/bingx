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
const MARTINGALE_DROP_FEE_MULTIPLIER = 7; // Drop by (Limit Fee * 5) for Martingale limit buy
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

    // Removed verbose debug logging to reduce unnecessary operations

    if (method === 'GET' || method === 'DELETE') {
        const allParams = { ...params, timestamp };
        console.log('[DEBUG] GET/DELETE params with timestamp:', allParams);
        
        if (needsSignature) {
            queryString = createQueryString(allParams);
            console.log('[DEBUG] Query string for signature:', queryString);
            
            const signature = generateSignature(queryString, SECRET_KEY);
            console.log('[DEBUG] Generated signature:', signature);
            
            queryString += `&signature=${signature}`;
            console.log('[DEBUG] Final query string:', queryString);
        } else {
            queryString = createQueryString(allParams);
        }
    } else { // POST
        const allParams = { ...params, timestamp };
        console.log('[DEBUG] POST params with timestamp:', allParams);
        
        queryString = createQueryString(allParams);
        console.log('[DEBUG] POST query string for signature:', queryString);
        
        if (needsSignature) {
            const signature = generateSignature(queryString, SECRET_KEY);
            console.log('[DEBUG] POST generated signature:', signature);
            
            queryString += `&signature=${signature}`;
            console.log('[DEBUG] POST final query string:', queryString);
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
            data: method === 'POST' ? requestBody : null, // Adjust if POST body is needed
        });
        console.log(`Response from ${path}:`, response.data);
        // Special handling for listenKey endpoint which doesn't follow standard response format
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
        // positionSide can be LONG, SHORT, or BOTH.
        // If your account is in One-Way Mode, use BOTH.
        // If in Hedge Mode, specify LONG or SHORT.
        // For this bot, we are only trading LONG.
        await apiRequest('POST', '/openApi/swap/v2/trade/leverage', {
            symbol: SYMBOL,
            side: 'LONG', // Or 'BOTH' if in one-way mode
            leverage: LEVERAGE,
            timestamp: Date.now()
        });
        console.log(`Leverage for ${SYMBOL} (LONG) set to ${LEVERAGE}x successfully.`);
        // If you also want to set for SHORT or ensure BOTH is set:
        // await apiRequest('POST', '/openApi/swap/v2/trade/leverage', {
        //     symbol: SYMBOL,
        //     side: 'SHORT',
        //     leverage: LEVERAGE,
        // });
        // console.log(`Leverage for ${SYMBOL} (SHORT) set to ${LEVERAGE}x successfully.`);

    } catch (error) {
        console.error('Error setting leverage:', error.message);
        // It's possible leverage is already set, or other issues.
        // Check error code for specifics (e.g., 100403 might mean no change needed or position exists)
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
    // Validate order parameters
    if (!symbol || !side || !positionSide || !type || !quantity) {
        throw new Error('Missing required order parameters');
    }
    if (quantity <= 0) {
        throw new Error('Invalid order quantity');
    }
    
    // Get fresh price data for market orders
    if (type === 'MARKET') {
        const currentPrice = await getCurrentBtcPrice();
        if (side === 'BUY') {
            // Calculate dynamic slippage and position adjustment based on recent volatility
            const recentVolatility = calculateRecentVolatility();
            const dynamicSlippage = BASE_SLIPPAGE_PERCENT * (1 + (recentVolatility * VOLATILITY_FACTOR));
            const positionSizeFactor = Math.max(MIN_POSITION_SIZE_FACTOR, 1 - (recentVolatility * 10));
            
            // Adjust buy price and quantity with volatility-based scaling
            price = currentPrice * (1 + dynamicSlippage);
            quantity *= positionSizeFactor;
        } else {
            // Calculate dynamic slippage based on recent volatility
            const recentVolatility = calculateRecentVolatility();
            const dynamicSlippage = BASE_SLIPPAGE_PERCENT * (1 + (recentVolatility * VOLATILITY_FACTOR));
            
            // Adjust sell price with dynamic slippage tolerance
            price = currentPrice * (1 - dynamicSlippage);
        }
        console.log(`Adjusted ${type} ${side} price with dynamic slippage tolerance: ${price}`);
    } else if (type === 'LIMIT' && !price) {
        throw new Error('Limit orders require a price');
    }
    
    console.log(`[Order] Placing ${type} ${side} ${quantity} ${symbol} at ${price || 'Market'}`);
    const params = {
        symbol,
        side,
        positionSide,
        type,
        quantity: quantity.toString(),
        isMartingale: (type === 'LIMIT' && side === 'BUY'), // Mark martingale buy orders
        timeInForce: 'GTC' // Good-Til-Canceled to maintain orders through volatility
    };

    if (price !== null) {
        params.price = price.toString();
    }
    if (stopPrice !== null) {
        params.stopPrice = stopPrice.toString();
    }
    if (takeProfitParams) {
        params.takeProfit = JSON.stringify({
            type: 'TAKE_PROFIT_MARKET',
            quantity: quantity.toString(),
            stopPrice: takeProfitParams.stopPrice.toString(),
            workingType: 'MARK_PRICE'
        });
    }
    if (stopLossParams) {
        params.stopLoss = JSON.stringify(stopLossParams);
    }

    try {
        const orderResponse = await apiRequest('POST', '/openApi/swap/v2/trade/order', params);
        if (orderResponse && orderResponse.order) {
            console.log(`Order placed successfully. Order ID: ${orderResponse.order.orderId}`);
            const order = orderResponse.order;
            if (params.isMartingale) {
                order.isMartingale = true; // Track martingale orders
            }
            return order;
        }
        console.error('Failed to place order, response:', orderResponse);
        return null;
    } catch (error) {
        console.error('Error placing order:', error.message);
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
        console.log(`Cancel confirmation for order ${orderId}:`, {
            apiCode: result.code,
            apiMsg: result.msg,
            orderId: result.orderId || orderId
        });
        return true;
    } catch (error) {
        console.error(`Detailed error cancelling order ${orderId}:`, {
            errorCode: error.response?.data?.code,
            errorMsg: error.response?.data?.msg || error.message,
            orderId,
            symbol
        });
        return false;
    }
}

async function getCurrentPosition(symbol) {
    console.log(`Fetching current position for ${symbol}...`);
    try {
        const positionData = await apiRequest('GET', '/openApi/swap/v2/user/positions', { symbol });
        if (positionData && Array.isArray(positionData) && positionData.length > 0) {
            // Find the LONG position for the given symbol
            const longPosition = positionData.find(p => p.symbol === symbol && p.positionSide === 'LONG');
            if (longPosition && parseFloat(longPosition.positionAmt) > 0) {
                console.log('Current LONG position:', longPosition);
                return {
                    quantity: parseFloat(longPosition.positionAmt),
                    averageEntryPrice: parseFloat(longPosition.avgPrice),
                    positionId: longPosition.positionId, // Assuming API provides this
                    // Add other relevant fields
                };
            }
        }
        console.log(`No active LONG position found for ${symbol}.`);
        return null; // No active position or error
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
        // Consider re-creating the listen key if it fails repeatedly
        activeListenKey = await createListenKey(); // Attempt to get a new key
        if (activeListenKey) {
            connectWebSocket(); // Reconnect with the new key
        } else {
            console.error("Failed to get a new listen key after keep-alive failure. Bot stopping.");
            isBotActive = false;
        }
    }
}


let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10; // Maximum 10 reconnect attempts
const RECONNECT_BASE_DELAY = 5000; // 5 seconds base delay
const MAX_RECONNECT_DELAY = 60000; // 1 minute maximum delay
const PING_INTERVAL = 15000; // 15 seconds (BingX recommends <30s)
const HEALTH_CHECK_INTERVAL = 10000; // 10 seconds
let pingInterval = null;
let healthCheckInterval = null;
let connectionActive = false;
let lastReceivedMessageTime = 0;

function cleanupWebSocket() {
    if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
    }
    if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
    }
    connectionActive = false;
    lastReceivedMessageTime = 0;
}

function connectWebSocket() {
    if (!activeListenKey) {
        console.error('Cannot connect to WebSocket without a ListenKey.');
        return;
    }
    
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.log('Maximum reconnect attempts reached. Resetting counter and trying again...');
        reconnectAttempts = 0; // Reset counter instead of stopping
        return;
    }

    const wsUrlWithKey = `${WEBSOCKET_URL}?listenKey=${activeListenKey}`;
    console.log(`Connecting to WebSocket: ${wsUrlWithKey}`);

    // Clean up any existing connection
    if (ws) {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            console.log("Closing existing WebSocket connection...");
            ws.removeAllListeners();
            ws.close();
        }
    }

    ws = new WebSocket(wsUrlWithKey);
    connectionActive = true;

    // Setup ping interval
    pingInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            try {
                ws.ping();
                console.debug('[WebSocket] Sent ping');
            } catch (e) {
                console.error('[WebSocket] Ping failed:', e);
            }
        }
    }, PING_INTERVAL);

    ws.on('open', () => {
        console.log('WebSocket connection established.');
        reconnectAttempts = 0; // Reset reconnect attempts on successful connection
        // Send initial ping to establish connection health
        ws.ping();
    });

    ws.on('message', (data) => {
        try {
            let messageString = data.toString();

            // Handle Ping/Pong protocol
            if (messageString === 'Ping') {
                console.log('[WebSocket] Received Ping, sending Pong');
                return ws.send('Pong');
            }

            // Handle GZIP compressed messages
            if (data instanceof Buffer) {
                try {
                    messageString = require('zlib').gunzipSync(data).toString();
                } catch (e) {
                    console.log('[WebSocket] Non-GZIP binary message');
                }
            }

            // Process JSON messages
            if (messageString.startsWith('{') || messageString.startsWith('[')) {
                const message = JSON.parse(messageString);
                lastReceivedMessageTime = Date.now(); // Update last received time
                
                if (message.e === 'ORDER_TRADE_UPDATE') {
                    handleWebSocketMessage(message).catch(console.error);
                } else if (message.e === 'aggTrade') {  // Handle trade volume data
                    const tradeQty = parseFloat(message.q);
                    volumeStats.trades.push({
                        quantity: tradeQty,
                        time: Date.now()
                    });
                    updateVolumeStats();
                } else if (message.e !== 'SNAPSHOT') { // Skip logging for SNAPSHOT messages
                    console.log(`[WebSocket] Received message type: ${message.e}`);
                }
            }

        } catch (error) {
            console.error('Error processing WebSocket message:', error, 'Raw data:', data.toString());
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        // Consider reconnection logic here
    });

    ws.on('close', async (code, reason) => {
        console.log(`WebSocket connection closed. Code: ${code}, Reason: ${reason.toString()}`);
        cleanupWebSocket();
        
        if (!isBotActive) return;

        // Classify error type
        const isTemporaryError = [1000, 1001, 1005, 1006].includes(code);
        const isPermanentError = [1002, 1003, 1007, 1008, 1009, 1010, 1011].includes(code);
        
        if (isPermanentError) {
            console.error('Permanent WebSocket error detected. Stopping bot.');
            isBotActive = false;
            return;
        }

        // Calculate delay with exponential backoff and jitter
        const baseDelay = Math.min(
            RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts),
            MAX_RECONNECT_DELAY
        );
        const jitter = Math.random() * 2000; // Add up to 2 seconds jitter
        const delay = baseDelay + jitter;
        
        reconnectAttempts++;
        
        console.log(`Attempting to reconnect WebSocket in ${(delay/1000).toFixed(1)} seconds (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
        
        setTimeout(async () => {
            try {
                if (!activeListenKey || code === 1006) { // Refresh key on abnormal closure
                    console.log('Refreshing listen key...');
                    activeListenKey = await createListenKey();
                }
                
                if (activeListenKey) {
                    connectWebSocket();
                } else {
                    console.error("Failed to get a new listen key for reconnection");
                    isBotActive = false;
                }
            } catch (error) {
                console.error("WebSocket reconnection failed:", error);
                if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                    connectWebSocket();
                } else {
                    console.error('Maximum reconnect attempts reached. Stopping bot.');
                    isBotActive = false;
                }
            }
        }, delay);
    });

    // Add health check monitoring
    healthCheckInterval = setInterval(() => {
        const timeSinceLastMessage = Date.now() - lastReceivedMessageTime;
        if (timeSinceLastMessage > 60000) { // 1 minute without messages
            console.warn(`No messages received for ${timeSinceLastMessage/1000} seconds. Reconnecting...`);
            ws.close(); // Trigger reconnection
        }
    }, HEALTH_CHECK_INTERVAL);
}

async function handleWebSocketMessage(message) {
    if (message.e === 'ORDER_TRADE_UPDATE') {
        const orderData = message.o;
        if (orderData.X === 'FILLED') {
            // Get fresh price data to handle rapid market movements
            const currentPrice = await getCurrentBtcPrice();
            
            console.log(`Order Update [${orderData.X}]:`, {
                symbol: orderData.s,
                side: orderData.S,
                type: orderData.o,
                quantity: orderData.q,
                price: orderData.p,
                orderId: orderData.i,
                clientOrderId: orderData.c,
                executionType: orderData.x,
                status: orderData.X,
                time: orderData.T,
                currentMarketPrice: currentPrice // Log current price for comparison
            });

            // Validate filled price against expected range
            if (orderData.X === 'FILLED') {
                const filledPrice = parseFloat(orderData.p);
                let expectedPrice = lastMarketBuyPrice;
                
                if (orderData.o === 'MARKET' && orderData.S === 'BUY') {
                    expectedPrice = lastMarketBuyPrice * (1 + BASE_SLIPPAGE_PERCENT * 2); // Allow 2x base slippage
                } else if (orderData.o === 'LIMIT' && orderData.S === 'BUY') {
                    expectedPrice = lastMartingaleBuyPrice * (1 - (FEE_LIMIT * MARTINGALE_DROP_FEE_MULTIPLIER));
                }
                
                if (expectedPrice > 0) {
                    const priceDifference = Math.abs((filledPrice - expectedPrice) / expectedPrice);
                    if (priceDifference > BASE_SLIPPAGE_PERCENT * 2) { // Use 2x base slippage as threshold
                        console.warn(`Large price deviation detected: ${(priceDifference * 100).toFixed(2)}%`);
                        // Adjust strategy for unexpected fill price
                        currentMartingaleLevel = Math.min(currentMartingaleLevel, 2); // Reduce martingale levels
                        console.log(`Martingale level reduced to ${currentMartingaleLevel} due to price deviation`);
                    }
                }
            }

            // Handle filled orders
            if (orderData.X === 'FILLED') {
                if (orderData.o === 'MARKET' && orderData.S === 'BUY') {
                    console.log('Initial market buy order filled.');
                    lastMarketBuyPrice = parseFloat(orderData.p);
                    currentPosition.quantity = parseFloat(orderData.q);
                    currentPosition.averageEntryPrice = lastMarketBuyPrice;
                    currentPosition.entryValueUSD = currentPosition.quantity * lastMarketBuyPrice;
                    currentPosition.side = 'LONG';

                    // Immediately place new market buy order after fill
                    if (currentPosition.quantity === 0) {
                        setTimeout(() => {
                            executeInitialMarketBuy().catch(console.error);
                        }, 1000); // 1 second delay before next buy
                    }

                    // Update volume stats
                    const tradeQty = parseFloat(orderData.q);
                    volumeStats.trades.push({
                        quantity: tradeQty,
                        time: Date.now()
                    });
                    updateVolumeStats();
                } else if (orderData.o === 'LIMIT' && orderData.S === 'BUY') {
                    console.log('Martingale buy order filled.');
                    lastMartingaleBuyPrice = parseFloat(orderData.p);
                    currentMartingaleLevel++;
                    
                    // Update volume stats
                    const tradeQty = parseFloat(orderData.q);
                    volumeStats.trades.push({ quantity: tradeQty, time: Date.now() });
                    updateVolumeStats();
                    
                    if (currentMartingaleLevel < MAX_MARTINGALE_ENTRIES) {
                        await placeNextMartingaleStageOrders().catch(console.error);
                    } else {
                        const currentPrice = await getCurrentBtcPrice();
                        const roi = (currentPrice - currentPosition.averageEntryPrice) / currentPosition.averageEntryPrice;
                        if (roi <= EXIT_ROI_THRESHOLD) {
                            console.log(`Martingale limit reached and ROI ${roi.toFixed(4)} <= ${EXIT_ROI_THRESHOLD} threshold. Exiting position.`);
                            const sellOrder = await placeOrder(SYMBOL, 'SELL', 'LONG', 'MARKET', currentPosition.quantity);
                            if (sellOrder) {
                                console.log('Market SELL order placed to exit position.');
                                await cancelAllOpenOrdersAndReset(SYMBOL);
                            }
                        } else {
                            console.log(`Maximum martingale entries reached, but ROI ${roi.toFixed(4)} is above exit threshold. No further action.`);
                        }
                    }
                } else if (orderData.o === 'TAKE_PROFIT_MARKET' && orderData.S === 'SELL') {
                    console.log('Take profit order filled. Trade cycle completed.');
                    
                    // Update volume stats
                    const tradeQty = parseFloat(orderData.q);
                    volumeStats.trades.push({
                        quantity: tradeQty,
                        time: Date.now()
                    });
                    updateVolumeStats();

                    // 1. Cancel all martingale orders with proper async/await
                    console.log('Starting cancellation of martingale orders...');
                    const allOpenOrders = await getOpenOrders(SYMBOL);
                    const cancellationPromises = allOpenOrders
                        .filter(order => order.isMartingale)
                        .map(order => cancelOrder(SYMBOL, order.orderId));
                    
                    await Promise.all(cancellationPromises);
                    console.log('All martingale orders cancelled');

                    // 2. Reset trading environment with verification
                    console.log('Resetting trading environment...');
                    await cancelAllOpenOrdersAndReset(orderData.s);
                    console.log('Trading environment reset complete');

                    // 3. Adjust initial equity percentage conservatively
                    const originalEquityPercentage = 0.01;
                    const minEquityPercentage = 0.005; // Minimum 0.5%
                    const reductionFactor = 0.8; // Reduce by 20% each cycle
                    
                    INITIAL_EQUITY_PERCENTAGE = Math.max(
                        minEquityPercentage,
                        INITIAL_EQUITY_PERCENTAGE * reductionFactor
                    );
                    
                    console.log(`Adjusted initial equity percentage to ${(INITIAL_EQUITY_PERCENTAGE * 100).toFixed(2)}% for next cycle`);

                    // 4. Start new trading cycle with proper sequencing
                    if (isBotActive) {
                        console.log('Preparing to start new trading cycle...');
                        currentMartingaleLevel++; // Increment martingale level
                        
                        if (currentMartingaleLevel >= MAX_MARTINGALE_ENTRIES) {
                            const currentPrice = parseFloat(data.p);
                            const roi = (currentPrice / entryPrice) - 1;
                            
                            if (roi <= EXIT_ROI_THRESHOLD) {
                                console.log(`Max martingale entries reached (${MAX_MARTINGALE_ENTRIES}) with ROI ${(roi*100).toFixed(2)}% - executing market exit`);
                                await createMarketOrder(SYMBOL, 'sell', position.size);
                            } else {
                                console.log(`Max martingale entries reached (${MAX_MARTINGALE_ENTRIES}) but ROI ${(roi*100).toFixed(2)}% above threshold - holding position`);
                            }
                        } else {
                            console.log(`Current martingale level: ${currentMartingaleLevel}/${MAX_MARTINGALE_ENTRIES}`);
                        }
                        
                        // Add delay to ensure clean state
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        
                        // Verify no open orders remain
                        const remainingOrders = await getOpenOrders(SYMBOL);
                        if (remainingOrders.length === 0) {
                            console.log('Starting new conservative trading cycle');
                            await executeInitialMarketBuy();
                        } else {
                            console.error('Cannot start new cycle - open orders still exist:', remainingOrders);
                        }
                    }
                } else if (orderData.X === 'FILLED' && orderData.S === 'SELL' && orderData.ps === 'LONG') {
                    console.log('Long position closed. Immediately restarting trading cycle...');
                    
                    // 1. Cancel all open orders
                    await cancelAllOpenOrdersAndReset(orderData.s);
                    
                    // 2. Reset initial equity percentage to original value
                    INITIAL_EQUITY_PERCENTAGE = 0.01;
                    
                    // 3. Immediately execute new market buy if bot is active
                    if (isBotActive) {
                        currentMartingaleLevel = 0;
                        console.log('Immediately placing new market buy order');
                        await executeInitialMarketBuy();
                    }
                }
            }
        } else if (orderData.X === 'CANCELED' || orderData.X === 'REJECTED' || orderData.X === 'EXPIRED') {
            console.log(`Order ${orderData.i} was ${orderData.X}.`);
            if (currentPosition.takeProfitOrderId && orderData.i.toString() === currentPosition.takeProfitOrderId.toString()) {
                currentPosition.takeProfitOrderId = null;
            }
            if (currentPosition.martingaleBuyOrderId && orderData.i.toString() === currentPosition.martingaleBuyOrderId.toString()) {
                currentPosition.martingaleBuyOrderId = null;
            }
            // Decide if re-placement is needed or if the bot should stop/alert.
            // This part needs careful logic depending on why an order might fail.
        }
    } else if (message.e === 'ACCOUNT_UPDATE') {
        // Handle account balance or position updates if necessary,
        // though ORDER_TRADE_UPDATE is usually more direct for fills.
        console.log('Account Update:', message);
    } else if (message.e === 'listenKeyExpired') {
        console.error('ListenKey expired. Attempting to refresh and reconnect WebSocket.');
        activeListenKey = null; // Invalidate current key
        // Attempt to get a new key and reconnect
        (async () => {
            activeListenKey = await createListenKey();
            if (activeListenKey) {
                connectWebSocket();
            } else {
                console.error("Failed to refresh ListenKey. Bot stopping.");
                isBotActive = false;
            }
        })();
    }
}

async function cancelAllOpenOrdersAndReset(symbol) {
    console.log(`Starting order cancellation and environment reset for ${symbol}`);
    
    try {
        // 1. Cancel all open orders
        await cancelAllOpenOrders(symbol);
        // Get only orders that are active and cancellable
        const openOrders = (await getOpenOrders(symbol)).filter(o =>
            o.status === 'NEW' || o.status === 'PARTIALLY_FILLED'
        );
        console.log(`Found ${openOrders.length} cancellable orders to cancel`);
        
        const cancellationPromises = openOrders.map(order => {
            console.log(`Cancelling order ${order.orderId} (${order.type} ${order.side} ${order.quantity} @ ${order.price})`);
            return cancelOrder(symbol, order.orderId);
        });
        
        const results = await Promise.allSettled(cancellationPromises);
        
        // Check for any failures
        const failedCancellations = results.filter(r => r.status === 'rejected');
        if (failedCancellations.length > 0) {
            console.error('Failed to cancel some orders:', failedCancellations);
            throw new Error(`Failed to cancel ${failedCancellations.length} orders`);
        }
        
        console.log('Successfully cancelled all open orders');
        
        // 2. Verify no open orders remain with retries
        let remainingOrders = [];
        let attempts = 0;
        const maxAttempts = 5; // Increased from 3
        const retryDelayMs = 2000; // Increased from 1000ms
        
        while (attempts < maxAttempts) {
            // Get only orders that are still active and cancellable
            remainingOrders = (await getOpenOrders(symbol)).filter(o =>
                o.status === 'NEW' || o.status === 'PARTIALLY_FILLED'
            );
            
            if (remainingOrders.length === 0) {
                break;
            }
            
            // Retry cancellation for each remaining order individually
            const retryPromises = remainingOrders.map(order =>
                cancelOrder(symbol, order.orderId)
            );
            await Promise.all(retryPromises);
            
            attempts++;
            if (attempts < maxAttempts) {
                console.log(`Found ${remainingOrders.length} cancellable orders remaining, retrying in ${retryDelayMs}ms (attempt ${attempts}/${maxAttempts})`);
                console.log('Remaining order IDs:', remainingOrders.map(o => o.orderId));
                await new Promise(resolve => setTimeout(resolve, retryDelayMs));
            }
        }
        
        if (remainingOrders.length > 0) {
            console.error('Uncancelled orders after all attempts:', remainingOrders.map(o => ({
                id: o.orderId,
                status: o.status,
                type: o.type,
                price: o.price,
                quantity: o.quantity
            })));
            throw new Error(`${remainingOrders.length} orders still open after cancellation (${maxAttempts} attempts)`);
        }
        
        console.log(`Verification complete - no open orders remain after ${attempts} attempt(s)`);
        
        // 3. Reset trading environment
        currentPosition = {
            quantity: 0,
            averageEntryPrice: 0,
            entryValueUSD: 0,
            side: 'LONG',
            positionId: null,
            openOrderId: null,
            takeProfitOrderId: null,
            martingaleBuyOrderId: null,
        };
        // Reset all trading state variables
        currentMartingaleLevel = 0;
        lastMarketBuyPrice = 0;
        lastMartingaleBuyPrice = 0;
        currentPosition.openOrderId = null;
        currentPosition.takeProfitOrderId = null;
        currentPosition.martingaleBuyOrderId = null;
        
        console.log('Trading environment fully reset');
        console.log('Martingale level reset to:', currentMartingaleLevel);
        
    } catch (error) {
        console.error('Error during order cancellation and reset:', error);
        throw error; // Re-throw to allow upstream handling
    } finally {
        isCancellingOrders = false; // Always release the lock
        console.log('Order cancellation lock released');
    }
}

// ###################################################################################
// #                          BOT TRADING LOGIC                                      #
// ###################################################################################

/**
 * Calculates the quantity of BTC to buy/sell based on equity percentage.
 * @param {number} currentEquityUSD - The current total equity in USD.
 * @param {number} percentage - The percentage of equity to use (e.g., 0.01 for 1%).
 * @param {number} price - The current price of BTC.
 * @param {number} leverage - The leverage to use.
 * @returns {number} The quantity of BTC, adjusted for precision.
 */

/**
 * Updates volume statistics and cleans up old trade data
 */
let priceHistory = [];
function updateVolumeStats() {
    const now = Date.now();
    // Clean up trades older than 1 hour
    volumeStats.trades = volumeStats.trades.filter(t => t.time > now - 3600000);
    
    // Calculate volume for different time frames
    volumeStats.lastMinute = volumeStats.trades
        .filter(t => t.time > now - 60000)
        .reduce((sum, t) => sum + t.quantity, 0);
        
    volumeStats.last5Minutes = volumeStats.trades
        .filter(t => t.time > now - 300000)
        .reduce((sum, t) => sum + t.quantity, 0);
        
    volumeStats.lastHour = volumeStats.trades
        .reduce((sum, t) => sum + t.quantity, 0);
        
    volumeStats.lastUpdate = now;

    // Update price history for volatility calculation
    const currentPrice = priceCache.value;
    if (currentPrice > 0) {
        priceHistory.push({
            price: currentPrice,
            time: now
        });
        // Keep only prices from the last VOLATILITY_WINDOW
        priceHistory = priceHistory.filter(p => p.time > now - VOLATILITY_WINDOW);
    }
}

function calculateRecentVolatility() {
    if (priceHistory.length < 2) return 0;
    
    const priceChanges = [];
    let upwardMoves = 0;
    let downwardMoves = 0;
    let maxDrop = 0;
    let maxRise = 0;
    
    for (let i = 1; i < priceHistory.length; i++) {
        const change = (priceHistory[i].price - priceHistory[i-1].price) / priceHistory[i-1].price;
        const absChange = Math.abs(change);
        priceChanges.push(absChange);
        
        if (change > 0) {
            upwardMoves++;
            maxRise = Math.max(maxRise, change);
        } else if (change < 0) {
            downwardMoves++;
            maxDrop = Math.min(maxDrop, change);
        }
    }
    
    const averageChange = priceChanges.reduce((sum, change) => sum + change, 0) / priceChanges.length;
    const netDirection = upwardMoves - downwardMoves;
    const volatilityRatio = maxRise / Math.abs(maxDrop) || 1;
    
    // Enhanced volatility logging
    if (averageChange > MAX_VOLATILITY_THRESHOLD * 0.8) {
        const logMessage = `Volatility: ${(averageChange*100).toFixed(2)}% ` +
                          `(Up: ${upwardMoves}, Down: ${downwardMoves}) ` +
                          `Max Rise: ${(maxRise*100).toFixed(2)}%, Max Drop: ${(maxDrop*100).toFixed(2)}%`;
        
        if (averageChange > MAX_VOLATILITY_THRESHOLD && Date.now() - lastVolatilityAlert > 30000) {
            console.warn(`HIGH VOLATILITY - ${logMessage}`);
            lastVolatilityAlert = Date.now();
        } else {
            console.log(logMessage);
        }
    }
    
    return averageChange * (volatilityRatio > 2 ? 1.2 : 1); // Adjust volatility measure for strong trends
}

function activateCooldown(currentVolatility) {
    // Calculate adaptive cooldown duration based on volatility severity
    const severity = currentVolatility / MAX_VOLATILITY_THRESHOLD;
    const duration = BASE_COOLDOWN_PERIOD * Math.min(VOLATILITY_COOLDOWN_MULTIPLIER, severity);
    
    isCoolingDown = true;
    console.log(`Starting cooldown for ${(duration/1000).toFixed(1)} seconds due to ${(currentVolatility*100).toFixed(2)}% volatility`);
    
    // Cancel all pending orders when entering cooldown
    cancelAllOpenOrders(SYMBOL).then(() => {
        console.log('All pending orders cancelled during cooldown');
    }).catch(err => {
        console.error('Error cancelling orders during cooldown:', err);
    });
    
    setTimeout(() => {
        isCoolingDown = false;
        console.log('Cooldown period ended, resuming trading');
    }, duration);
}

/**
 * Displays volume statistics in the console
 */
function displayVolumeStats() {
    console.log('\x1b[36m%s\x1b[0m', `=== Volume Statistics ===`);  // Cyan color
    console.log(`Last Minute:  ${volumeStats.lastMinute.toFixed(4)} BTC`);
    console.log(`Last 5 Minutes: ${volumeStats.last5Minutes.toFixed(4)} BTC`);
    console.log(`Last Hour:    ${volumeStats.lastHour.toFixed(4)} BTC`);
    console.log('\x1b[36m%s\x1b[0m', `=========================`);
}
function calculateQuantity(currentEquityUSD, percentage, price, leverage) {
    if (price <= 0) return 0;
    const MIN_ORDER_VALUE = 2.0; // Minimum order value in USDT
    
    let positionValueUSD = currentEquityUSD * percentage * leverage;
    
    // Ensure minimum order value requirement is met
    if (positionValueUSD < MIN_ORDER_VALUE) {
        console.warn(`Calculated order value ${positionValueUSD} is below minimum ${MIN_ORDER_VALUE}. Adjusting...`);
        positionValueUSD = MIN_ORDER_VALUE;
    }
    
    const quantityBTC = positionValueUSD / price;
    
    // Additional validation for minimum quantity if needed
    // const MIN_QUANTITY = 0.001; // Example minimum quantity for BTC
    // if (quantityBTC < MIN_QUANTITY) {
    //     console.warn(`Calculated quantity ${quantityBTC} is below minimum ${MIN_QUANTITY}`);
    //     return 0;
    // }
    
    return parseFloat(quantityBTC.toFixed(5)); // Adjust precision based on symbol requirements
}

/**
 * Adjusts a price to the correct precision for the symbol.
 * @param {number} price - The price to adjust.
 * @returns {number} The adjusted price.
 */
function adjustPricePrecision(price) {
    // BingX requires prices to be in certain increments depending on the symbol
    // For BTC-USDT, the tick size is typically 0.1 (1 decimal place)
    // For LAUNCHCOIN-USDT, it might be different - check API docs
    return parseFloat(price.toFixed(5)); // Default to 5 decimal places
}

async function executeInitialMarketBuy() {
    if (isCancellingOrders || isCoolingDown) {
        const reason = isCancellingOrders ? 'order cancellation in progress' : 'cooling down after high volatility';
        console.log(`Skipping market buy - ${reason}`);
        return;
    }
    
    // Check current volatility before proceeding
    const currentVolatility = calculateRecentVolatility();
    if (currentVolatility > MAX_VOLATILITY_THRESHOLD) {
        console.warn(`Volatility too high (${(currentVolatility*100).toFixed(2)}%), entering cooldown`);
        activateCooldown(currentVolatility);
        return;
    }
    
    // Reduce position size if volatility is elevated but below threshold
    if (currentVolatility > MAX_VOLATILITY_THRESHOLD * 0.7) {
        const reduction = 1 - (currentVolatility / MAX_VOLATILITY_THRESHOLD);
        quantity *= Math.max(MIN_POSITION_SIZE_FACTOR, reduction);
        console.log(`Reducing position size to ${(quantity.toFixed(6))} due to elevated volatility`);
    }

    // Additional check for consecutive volatility spikes
    if (Date.now() - lastVolatilityAlert < BASE_COOLDOWN_PERIOD * 2) {
        console.warn('Recent volatility alerts detected, extending cooldown');
        activateCooldown(BASE_COOLDOWN_PERIOD * 2);
        return;
    }
    console.log('Executing initial market buy...');
    try {
        const quantity = 0.0001; // Fixed quantity for initial entry

        console.log(`Placing initial market buy for ${quantity} ${SYMBOL}`);
        const order = await placeOrder(
            SYMBOL,
            'BUY',
            'LONG',
            'MARKET',
            quantity
        );

        if (order) {
            currentPosition.openOrderId = order.orderId;
            console.log('Initial market buy order placed:', order);
        } else {
            console.error('Failed to place initial market buy order');
        }
    } catch (error) {
        console.error('Error executing initial market buy:', error);
    }
}

async function placeInitialFollowUpOrders() {
    if (isCancellingOrders) {
        console.log('Skipping follow-up orders - order cancellation in progress');
        return;
    }
    
    console.log('Placing volatility-adjusted follow-up orders...');
    try {
        const recentVolatility = calculateRecentVolatility();
        const dynamicFeeMultiplier = Math.min(
            MARTINGALE_DROP_FEE_MULTIPLIER * (1 + recentVolatility * 2),
            MARTINGALE_DROP_FEE_MULTIPLIER * 3
        );

        // Calculate Take Profit price with volatility adjustment
        const takeProfitPrice = adjustPricePrecision(
            currentPosition.averageEntryPrice *
            (1 + Math.max(
                2 * FEE_LIMIT * (1 - recentVolatility),
                MIN_PROFIT_PERCENT
            ))
        );
        
        console.log('Placing take profit order:', {
            basePrice: currentPosition.averageEntryPrice,
            takeProfitPrice: takeProfitPrice,
            volatility: recentVolatility,
            feeMultiplier: 2 * (1 - recentVolatility)
        });

        const tpOrder = await placeOrder(
            SYMBOL,
            'SELL',
            'LONG',
            'LIMIT',
            currentPosition.quantity,
            takeProfitPrice
        );
        
        if (tpOrder) {
            currentPosition.takeProfitOrderId = tpOrder.orderId;
            console.log('Take profit order placed:', {
                orderId: tpOrder.orderId,
                price: takeProfitPrice,
                quantity: currentPosition.quantity,
                volatility: recentVolatility
            });
        } else {
            console.error('Failed to place take profit order');
        }

        // Calculate Martingale Buy price with volatility adjustment
        const martingaleBuyPrice = adjustPricePrecision(
            lastMarketBuyPrice *
            (1 - (FEE_LIMIT * dynamicFeeMultiplier))
        );
        
        console.log('Placing martingale buy order:', {
            basePrice: lastMarketBuyPrice,
            martingalePrice: martingaleBuyPrice,
            volatility: recentVolatility,
            feeMultiplier: dynamicFeeMultiplier
        });

        const mbOrder = await placeOrder(
            SYMBOL,
            'BUY',
            'LONG',
            'LIMIT',
            currentPosition.quantity * MARTINGALE_MULTIPLIER,
            martingaleBuyPrice
        );
        
        if (mbOrder) {
            currentPosition.martingaleBuyOrderId = mbOrder.orderId;
            console.log('Martingale buy order placed:', {
                orderId: mbOrder.orderId,
                price: martingaleBuyPrice,
                quantity: currentPosition.quantity * MARTINGALE_MULTIPLIER,
                martingaleLevel: 1,
                volatility: recentVolatility
            });
        } else {
            console.error('Failed to place martingale buy order');
        }
    } catch (error) {
        console.error('Error placing follow-up orders:', {
            error: error.message,
            stack: error.stack,
            position: currentPosition,
            timestamp: Date.now()
        });
    }
}

async function placeNextMartingaleStageOrders() {
    if (isCancellingOrders) {
        console.log('Skipping martingale orders - order cancellation in progress');
        return;
    }
    console.log('Placing next martingale stage orders...');
    try {
        // 1. Cancel all existing open orders
        await cancelAllOpenOrdersAndReset(SYMBOL);
        
        // 2. Get current position details from exchange
        const exchangePosition = await getCurrentPosition(SYMBOL);
        if (!exchangePosition) {
            console.error('No current position found');
            return;
        }
        
        // Update current position state with latest from exchange
        currentPosition.quantity = exchangePosition.quantity;
        currentPosition.averageEntryPrice = exchangePosition.averageEntryPrice;
        
        // 3. Calculate take profit price including fees for all positions
        const takeProfitPrice = adjustPricePrecision(
            currentPosition.averageEntryPrice *
            (1 + (FEE_LIMIT * MARTINGALE_TAKE_PROFIT_FEE_MULTIPLIER))
        );

        // Cancel any existing take profit orders
        if (currentPosition.takeProfitOrderId) {
            await cancelOrder(SYMBOL, currentPosition.takeProfitOrderId);
        }
        
        console.log(`Placing take profit for ${currentPosition.quantity} @ ${takeProfitPrice}`);
        const tpOrder = await placeOrder(
            SYMBOL,
            'SELL',
            'LONG',
            'LIMIT',
            currentPosition.quantity,
            takeProfitPrice
        );
        
        if (tpOrder) {
            currentPosition.takeProfitOrderId = tpOrder.orderId;
            console.log('Take profit order placed:', tpOrder);
        }

        // 4. Calculate next martingale buy price and quantity
        // Calculate required margin for next level
        const requiredMargin = nextBuyQuantity * nextBuyPrice / LEVERAGE;
        const currentBalance = await getAccountBalance();
        
        // Allow up to 10 levels if sufficient balance (2x required margin)
        if (currentMartingaleLevel < 10 && currentBalance > requiredMargin * 2) {
            const nextBuyPrice = adjustPricePrecision(
                currentPosition.averageEntryPrice *
                (1 - (FEE_LIMIT * MARTINGALE_DROP_FEE_MULTIPLIER))
            );
            
            const nextBuyQuantity = currentPosition.quantity * MARTINGALE_MULTIPLIER;
            
            console.log(`Placing next martingale buy for ${nextBuyQuantity} @ ${nextBuyPrice}`);
            const buyOrder = await placeOrder(
                SYMBOL,
                'BUY',
                'LONG',
                'LIMIT',
                nextBuyQuantity,
                nextBuyPrice
            );
            
            if (buyOrder) {
                currentPosition.martingaleBuyOrderId = buyOrder.orderId;
                currentMartingaleLevel++;
                console.log('Martingale buy order placed:', buyOrder);
            }
        } else {
            console.log('Max martingale levels reached');
        }
    } catch (error) {
        console.error('Error placing next martingale orders:', error);
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
        await executeInitialMarketBuy();
    } catch (error) {
        console.error('Error in bot cycle:', error);
    }
}

async function initializeBot() {
    console.log('Initializing trading bot...');
    isBotActive = true;
    
    try {
        // Create WebSocket connection for order updates
        activeListenKey = await createListenKey();
        if (!activeListenKey) {
            throw new Error('Failed to create listen key');
        }
        
        connectWebSocket();
        
        // Start keep-alive interval for listen key (every 30 minutes)
        setInterval(() => {
            if (activeListenKey) {
                keepAliveListenKey(activeListenKey).catch(err => {
                    console.error('Error keeping listen key alive:', err);
                });
            }
        }, 30 * 60 * 1000);
        
        // Add volume display interval (every 5 seconds)
        setInterval(() => {
            displayVolumeStats();
        }, 5000);

        // Enhanced watchdog timer with backoff strategy
        let watchdogAttempts = 0;
        const watchdogInterval = setInterval(() => {
            if (!isBotActive) {
                watchdogAttempts++;
                const delay = Math.min(1000 * Math.pow(2, watchdogAttempts), 30000);
                console.log(`Watchdog: Bot inactive, attempting to restart in ${delay/1000} seconds (attempt ${watchdogAttempts})...`);
                setTimeout(() => {
                    initializeBot().then(() => {
                        watchdogAttempts = 0;
                    });
                }, delay);
            } else {
                watchdogAttempts = 0;
            }
        }, 60000);
        
        // Start the first trading cycle with retry logic
        const maxRetries = 5;
        let retries = 0;
        const startCycle = async () => {
            try {
                await runBotCycle();
            } catch (error) {
                console.error('Error starting trading cycle:', error);
                if (retries < maxRetries) {
                    retries++;
                    const delay = Math.min(1000 * retries, 5000);
                    console.log(`Retrying cycle start in ${delay}ms (attempt ${retries}/${maxRetries})`);
                    setTimeout(startCycle, delay);
                }
            }
        };
        startCycle();
    } catch (error) {
        console.error('Error initializing bot:', error);
        // Enhanced restart logic with exponential backoff
        const delay = Math.min(10000 * (1 + Math.random()), 30000); // Random delay up to 30s
        console.log(`Attempting to reinitialize bot in ${Math.round(delay/1000)} seconds...`);
        setTimeout(() => {
            initializeBot();
        }, delay);
    }
}

// Start the bot
initializeBot();

