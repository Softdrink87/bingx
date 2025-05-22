// main.js
const axios = require('axios');
const crypto = require('crypto');
const WebSocket = require('ws');
const logger = require('./logger'); // Import the Winston logger

// Global Error Handlers
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // TODO: Consider graceful shutdown or cleanup
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  // TODO: Consider graceful shutdown or cleanup
  // For critical errors, it might be best to exit after logging
  // process.exit(1); 
});

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
        logger.debug('[DEBUG] GET/DELETE params with timestamp:', allParams);
        
        if (needsSignature) {
            queryString = createQueryString(allParams);
            logger.debug('[DEBUG] Query string for signature:', queryString);
            
            const signature = generateSignature(queryString, SECRET_KEY);
            logger.debug('[DEBUG] Generated signature:', signature);
            
            queryString += `&signature=${signature}`;
            logger.debug('[DEBUG] Final query string:', queryString);
        } else {
            queryString = createQueryString(allParams);
        }
    } else { // POST
        const allParams = { ...params, timestamp };
        logger.debug('[DEBUG] POST params with timestamp:', allParams);
        
        queryString = createQueryString(allParams);
        logger.debug('[DEBUG] POST query string for signature:', queryString);
        
        if (needsSignature) {
            const signature = generateSignature(queryString, SECRET_KEY);
            logger.debug('[DEBUG] POST generated signature:', signature);
            
            queryString += `&signature=${signature}`;
            logger.debug('[DEBUG] POST final query string:', queryString);
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
        logger.info(`Response from ${path}:`, response.data);
        // Special handling for listenKey endpoint which doesn't follow standard response format
        if (path === '/openApi/user/auth/userDataStream') {
            if (response.data.listenKey) {
                return response.data;
            }
            logger.error('Failed to create listenKey: ' + JSON.stringify(response.data));
            throw new Error('Failed to create listenKey: ' + JSON.stringify(response.data));
        }

        if (response.data.code !== 0) {
            logger.error(`API Error from ${path}:`, response.data);
            throw new Error(`API Error: ${response.data.msg || 'Unknown error'} (Code: ${response.data.code || 'Unknown'})`);
        }
        return response.data.data;
    } catch (error) {
        logger.error(`Error during API request to ${path}:`, error.isAxiosError ? error.message : error, error.stack);
        if (error.response) {
            logger.error('Error response data:', error.response.data);
            logger.error('Error response status:', error.response.status);
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
        logger.error('Error fetching account balance:', error, error.stack);
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
        logger.error('Error fetching price:', error, error.stack);
        return priceCache.value; // Return cached value on error
    }
}

async function setLeverage() {
    logger.info(`Setting leverage for ${SYMBOL} to ${LEVERAGE}x for LONG side...`);
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
        logger.info(`Leverage for ${SYMBOL} (LONG) set to ${LEVERAGE}x successfully.`);
        // If you also want to set for SHORT or ensure BOTH is set:
        // await apiRequest('POST', '/openApi/swap/v2/trade/leverage', {
        //     symbol: SYMBOL,
        //     side: 'SHORT',
        //     leverage: LEVERAGE,
        // });
        // logger.info(`Leverage for ${SYMBOL} (SHORT) set to ${LEVERAGE}x successfully.`);

    } catch (error) {
        logger.error('Error setting leverage:', error.message, error.stack);
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
        logger.info(`Adjusted ${type} ${side} price with dynamic slippage tolerance: ${price}`);
    } else if (type === 'LIMIT' && !price) {
        throw new Error('Limit orders require a price');
    }
    
    logger.info(`[Order] Placing ${type} ${side} ${quantity} ${symbol} at ${price || 'Market'}`);
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
            logger.info(`Order placed successfully. Order ID: ${orderResponse.order.orderId}`);
            const order = orderResponse.order;
            if (params.isMartingale) {
                order.isMartingale = true; // Track martingale orders
            }
            return order;
        }
        logger.error('Failed to place order, response:', orderResponse);
        return null;
    } catch (error) {
        logger.error('Error placing order:', error.message, error.stack);
        return null;
    }
}

async function getOpenOrders(symbol) {
    logger.info(`Fetching open orders for ${symbol}...`);
    try {
        const openOrdersData = await apiRequest('GET', '/openApi/swap/v2/trade/openOrders', { symbol });
        return openOrdersData.orders || [];
    } catch (error) {
        logger.error('Error fetching open orders:', error, error.stack);
        return [];
    }
}

async function cancelOrder(symbol, orderId) {
    logger.info(`Attempting to cancel order ${orderId}...`);
    try {
        const result = await apiRequest('DELETE', '/openApi/swap/v2/trade/order', {
            symbol,
            orderId: orderId.toString(),
        });
        logger.info(`Cancel confirmation for order ${orderId}:`, {
            apiCode: result.code,
            apiMsg: result.msg,
            orderId: result.orderId || orderId
        });
        return true;
    } catch (error) {
        logger.error(`Detailed error cancelling order ${orderId}:`, {
            errorCode: error.response?.data?.code,
            errorMsg: error.response?.data?.msg || error.message,
            orderId,
            symbol,
            stack: error.stack
        });
        return false;
    }
}

async function getCurrentPosition(symbol) {
    logger.info(`Fetching current position for ${symbol}...`);
    try {
        const positionData = await apiRequest('GET', '/openApi/swap/v2/user/positions', { symbol });
        if (positionData && Array.isArray(positionData) && positionData.length > 0) {
            // Find the LONG position for the given symbol
            const longPosition = positionData.find(p => p.symbol === symbol && p.positionSide === 'LONG');
            if (longPosition && parseFloat(longPosition.positionAmt) > 0) {
                logger.info('Current LONG position:', longPosition);
                return {
                    quantity: parseFloat(longPosition.positionAmt),
                    averageEntryPrice: parseFloat(longPosition.avgPrice),
                    positionId: longPosition.positionId, // Assuming API provides this
                    // Add other relevant fields
                };
            }
        }
        logger.info(`No active LONG position found for ${symbol}.`);
        return null; // No active position or error
    } catch (error) {
        logger.error('Error fetching current position:', error, error.stack);
        return null;
    }
}

async function cancelAllOpenOrders(symbol) {
    logger.info(`Attempting to cancel all open orders for ${symbol}...`);
    try {
        const result = await apiRequest('DELETE', '/openApi/swap/v2/trade/allOpenOrders', {
            symbol,
        });
        logger.info(`Cancel all orders confirmation:`, result);
        return true;
    } catch (error) {
        logger.error(`Detailed error cancelling all orders:`, error, error.stack);
        return false;
    }
}


// ###################################################################################
// #                          WEBSOCKET HANDLING                                     #
// ###################################################################################

async function createListenKey() {
    logger.info('Creating ListenKey...');
    try {
        const response = await apiRequest('POST', '/openApi/user/auth/userDataStream', {}, true);
        if (response && response.listenKey) {
            logger.info('ListenKey created:', response.listenKey);
            return response.listenKey;
        }
        logger.error('Failed to create ListenKey.');
        return null;
    } catch (error) {
        logger.error('Error creating ListenKey:', error, error.stack);
        return null;
    }
}

async function keepAliveListenKey(key) {
    if (!key) return;
    logger.info('Pinging ListenKey to keep alive...');
    try {
        await apiRequest('PUT', '/openApi/user/auth/userDataStream', { listenKey: key }, true);
        logger.info('ListenKey kept alive.');
    } catch (error) {
        logger.error('Error keeping ListenKey alive:', error, error.stack);
        // Consider re-creating the listen key if it fails repeatedly
        activeListenKey = await createListenKey(); // Attempt to get a new key
        if (activeListenKey) {
            connectWebSocket(); // Reconnect with the new key
        } else {
            logger.error("Failed to get a new listen key after keep-alive failure. Bot stopping.");
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

// Store interval IDs globally to manage them across initializeBot calls
let keepAliveIntervalId = null;
let volumeDisplayIntervalId = null;
let watchdogIntervalId = null;


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
        logger.error('Cannot connect to WebSocket without a ListenKey. Will retry after delay from close handler.');
        return;
    }
    // reconnectAttempts is now managed primarily in the 'close' handler's retry logic.
    // Resetting here on every connectWebSocket call might prematurely reset the counter
    // if connectWebSocket is called for reasons other than a successful reconnect.
    // reconnectAttempts = 0; // Moved to ws.on('open')

    const wsUrlWithKey = `${WEBSOCKET_URL}?listenKey=${activeListenKey}`;
    logger.info(`Connecting to WebSocket: ${wsUrlWithKey}`);

    // Clean up any existing connection
    if (ws) {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            logger.info("Closing existing WebSocket connection...");
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
                logger.debug('[WebSocket] Sent ping');
            } catch (e) {
                logger.error('[WebSocket] Ping failed:', e, e.stack);
            }
        }
    }, PING_INTERVAL);

    ws.on('open', () => {
        logger.info('WebSocket connection established.');
        reconnectAttempts = 0; // Reset reconnect attempts ONLY on successful connection
        lastReceivedMessageTime = Date.now(); // Consider connection open as a sign of life
        // Send initial ping to establish connection health
        ws.ping();
    });

    ws.on('message', (data) => {
        lastReceivedMessageTime = Date.now(); // Update on any message
        try {
            let messageString = data.toString();

            // Handle Ping/Pong protocol from server (if it sends 'Ping')
            if (messageString === 'Ping') {
                logger.info('[WebSocket] Received Ping from server, sending Pong');
                ws.send('Pong'); // Ensure ws is defined and open before sending
                return;
            }
            
            // Handle GZIP compressed messages
            if (data instanceof Buffer) {
                try {
                    messageString = require('zlib').gunzipSync(data).toString();
                } catch (e) {
                    logger.warn('[WebSocket] Received binary message, GZIP decompression failed or not GZIP:', e);
                    // Potentially log the raw buffer if small or relevant for debugging
                    return; // Skip further processing if decompression fails
                }
            }

            // Process JSON messages
            if (messageString.startsWith('{') || messageString.startsWith('[')) {
                const message = JSON.parse(messageString);
                // lastReceivedMessageTime updated at the start of 'message' handler
                
                if (message.e === 'ORDER_TRADE_UPDATE') {
                    handleWebSocketMessage(message); // Error handling is now inside handleWebSocketMessage
                } else if (message.e === 'aggTrade') {  // Handle trade volume data
                    const tradeQty = parseFloat(message.q);
                    volumeStats.trades.push({
                        quantity: tradeQty,
                        time: Date.now()
                    });
                    updateVolumeStats();
                } else if (message.e !== 'SNAPSHOT') { // Skip logging for SNAPSHOT messages
                    logger.info(`[WebSocket] Received message type: ${message.e}`);
                }
            }

        } catch (error) {
            logger.error('Error processing WebSocket message:', error, 'Raw data:', data.toString(), error.stack);
        }
    });

    ws.on('error', (error) => {
        logger.error('WebSocket error:', error, error.stack);
        // Consider reconnection logic here
    });

    ws.on('close', async (code, reason) => {
        logger.info(`WebSocket connection closed. Code: ${code}, Reason: ${reason.toString()}`);
        cleanupWebSocket();
        
        if (!isBotActive) return;

        // Classify error type
        const isTemporaryError = [1000, 1001, 1005, 1006].includes(code);
        const isPermanentError = [1002, 1003, 1007, 1008, 1009, 1010, 1011].includes(code);
        
        if (isPermanentError) {
            logger.error('Permanent WebSocket error detected. Stopping bot.');
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
        
        logger.info(`Attempting to reconnect WebSocket in ${(delay/1000).toFixed(1)} seconds (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
        
        setTimeout(async () => {
            try {
                if (!activeListenKey || code === 1006) { // Refresh key on abnormal closure
                    logger.info('Refreshing listen key...');
                    activeListenKey = await createListenKey();
                }
                
                if (activeListenKey) {
                    connectWebSocket();
                } else {
                    logger.error("Failed to get a new listen key for reconnection");
                    isBotActive = false;
                }
            } catch (error) {
                logger.error("WebSocket reconnection failed:", error, error.stack);
                    // Check reconnectAttempts again here AFTER the async operation and its potential failure
                    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                        logger.error('Maximum reconnect attempts reached after a failed reconnection cycle. Stopping bot.');
                        isBotActive = false;
                    } else {
                        // Schedule next attempt normally
                        // connectWebSocket(); // This would be an immediate retry, stick to setTimeout
                    }
                }
            } else { // activeListenKey is null after createListenKey attempt
                 logger.error(`Failed to obtain a new listen key (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}). Will retry after delay.`);
                 if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                    logger.error('Maximum reconnect attempts reached while trying to get a new listen key. Stopping bot.');
                    isBotActive = false;
                 }
            }
            // If isBotActive is false, the setTimeout for the next attempt should not proceed.
            if (isBotActive) {
                // This setTimeout is for the next cycle of trying to connectWebSocket
                // It's already wrapped in the 'close' handler's setTimeout.
                // The logic should be: if current attempt failed, the 'close' handler's setTimeout handles the delay to the *next* attempt.
                // No need for an additional setTimeout(connectWebSocket, delay) here.
            } else {
                logger.info("Bot is inactive, no further reconnection attempts will be scheduled from this path.");
            }
        }, delay); // delay for the current reconnection attempt cycle
    });

    // Add health check monitoring
    healthCheckInterval = setInterval(() => {
        if (!isBotActive || !ws || ws.readyState !== WebSocket.OPEN) {
            logger.debug('Health check: Bot not active or WebSocket not open. Skipping ping.');
            return;
        }
        const timeSinceLastMessage = Date.now() - lastReceivedMessageTime;
        if (timeSinceLastMessage > PING_INTERVAL * 2) { // If no message for 2 ping intervals
            logger.warn(`No messages received for ${timeSinceLastMessage/1000} seconds. Sending explicit ping.`);
            try {
                ws.ping(); // Send a ping to see if connection is still alive
            } catch (e) {
                logger.error('[WebSocket] Health check ping failed:', e, e.stack);
                // ws.close() might be too aggressive here, as 'error' or 'close' event should handle it.
                // If ping fails, it usually means the underlying connection is already dead or will be closed soon.
            }
        }
        if (timeSinceLastMessage > 60000) { // 1 minute without messages
            logger.warn(`No messages received for ${timeSinceLastMessage/1000} seconds. Closing WebSocket to trigger reconnection.`);
            if (ws) ws.close(4002, "Health check timeout"); // Custom close code
        }
    }, HEALTH_CHECK_INTERVAL);
}

async function handleWebSocketMessage(message) {
    try {
        if (message.e === 'ORDER_TRADE_UPDATE') {
            const orderData = message.o;

            if (orderData.X === 'PARTIALLY_FILLED') {
                logger.warn('Order PARTIALLY_FILLED:', orderData);
                // Depending on strategy, may need to update partial fill quantity or wait for full fill.
                // For now, just logging. If issues arise, this needs more specific handling.
                // Update volume stats for the partial fill
                const tradeQtyPartial = parseFloat(orderData.l); // 'l' is last filled quantity
                if (tradeQtyPartial > 0) {
                    volumeStats.trades.push({ quantity: tradeQtyPartial, time: Date.now() });
                    updateVolumeStats();
                }
                // Potentially update currentPosition with partial info if strategy requires it.
                // currentPosition.quantity += parseFloat(orderData.l); // Example, if tracking this way.
                return; // Often, one might wait for the 'FILLED' status for final action.
            }

            if (orderData.X === 'FILLED') {
            // Get fresh price data to handle rapid market movements
            const currentPrice = await getCurrentBtcPrice();
            
            logger.info(`Order Update [${orderData.X}]:`, {
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
                        logger.warn(`Large price deviation detected: ${(priceDifference * 100).toFixed(2)}%`);
                        // Adjust strategy for unexpected fill price
                        currentMartingaleLevel = Math.min(currentMartingaleLevel, 2); // Reduce martingale levels
                        logger.info(`Martingale level reduced to ${currentMartingaleLevel} due to price deviation`);
                    }
                }
            }

            // Handle filled orders
            if (orderData.X === 'FILLED') {
                // Update volume stats for any fill
                const tradeQtyFilled = parseFloat(orderData.q);
                volumeStats.trades.push({ quantity: tradeQtyFilled, time: Date.now() });
                updateVolumeStats();

                if (orderData.o === 'MARKET' && orderData.S === 'BUY') {
                    updateStateOnInitialFill(orderData);
                    // NOTE: The original code had a setTimeout to call executeInitialMarketBuy again
                    // if currentPosition.quantity was 0. This seems like a potential bug or
                    // a case that shouldn't happen if the initial buy is successful.
                    // For now, I'm preserving the idea but it should be reviewed.
                    // The call to placeInitialFollowUpOrders is usually what should happen next.
                    if (currentPosition.quantity > 0) {
                         await placeInitialFollowUpOrders();
                    } else {
                         logger.warn('Initial market buy filled but position quantity is zero. Re-evaluating.', orderData);
                         // Potentially re-attempt or handle error, for now, let's log and see.
                         // The old logic was:
                         // setTimeout(() => {
                         //    executeInitialMarketBuy().catch(err => logger.error('Error in executeInitialMarketBuy retry:', err, err.stack));
                         // }, 1000);
                    }
                } else if (orderData.o === 'LIMIT' && orderData.S === 'BUY') { // Martingale Buy
                    updateStateOnMartingaleFill(orderData);
                    // It's crucial to get the updated aggregated position from the exchange
                    // as multiple martingale levels affect average price and total quantity.
                    const updatedPosition = await getCurrentPosition(SYMBOL);
                    if (updatedPosition) {
                        currentPosition.quantity = updatedPosition.quantity;
                        currentPosition.averageEntryPrice = updatedPosition.averageEntryPrice;
                        currentPosition.entryValueUSD = currentPosition.quantity * currentPosition.averageEntryPrice; // Recalculate
                    } else {
                        logger.error('Martingale buy filled, but failed to fetch updated position. State may be inconsistent.', orderData);
                        // Decide on error handling: stop, retry, etc. For now, will proceed cautiously.
                    }
                    
                    if (currentMartingaleLevel < MAX_MARTINGALE_ENTRIES) {
                        await placeNextMartingaleStageOrders();
                    } else {
                        const currentPrice = await getCurrentBtcPrice();
                        const roi = (currentPrice - currentPosition.averageEntryPrice) / currentPosition.averageEntryPrice;
                        if (roi <= EXIT_ROI_THRESHOLD) {
                            logger.info(`Martingale limit reached and ROI ${roi.toFixed(4)} <= ${EXIT_ROI_THRESHOLD} threshold. Exiting position.`);
                            const sellOrder = await placeOrder(SYMBOL, 'SELL', 'LONG', 'MARKET', currentPosition.quantity);
                            if (sellOrder) {
                                logger.info('Market SELL order placed to exit position.');
                                // The fill of this SELL order will trigger cancelAllOpenOrdersAndReset via its own ORDER_TRADE_UPDATE
                            }
                        } else {
                            logger.info(`Maximum martingale entries reached, but ROI ${roi.toFixed(4)} is above exit threshold. Holding position, will place new TP.`);
                             // Place a new TP based on the current aggregated position
                            const takeProfitPrice = adjustPricePrecision(
                                currentPosition.averageEntryPrice * (1 + (FEE_LIMIT * MARTINGALE_TAKE_PROFIT_FEE_MULTIPLIER))
                            );
                            const tpOrder = await placeOrder(SYMBOL, 'SELL', 'LONG', 'LIMIT', currentPosition.quantity, takeProfitPrice);
                            if (tpOrder) setTakeProfitOrderId(tpOrder.orderId);

                        }
                    }
                } else if (orderData.o === 'TAKE_PROFIT_MARKET' && orderData.S === 'SELL') {
                    updateStateOnTPSell(orderData);
                    logger.info('Take profit order filled. Trade cycle completed.');
                    
                    // Resetting environment and potentially starting a new cycle
                    await cancelAllOpenOrdersAndReset(orderData.s); // This now calls resetTradingState()
                    logger.info('Trading environment reset complete after TP.');

                    // Adjust initial equity percentage conservatively
                    INITIAL_EQUITY_PERCENTAGE = Math.max(
                        0.005, // minEquityPercentage
                        INITIAL_EQUITY_PERCENTAGE * 0.8 // reductionFactor
                    );
                    logger.info(`Adjusted initial equity percentage to ${(INITIAL_EQUITY_PERCENTAGE * 100).toFixed(2)}% for next cycle`);

                    if (isBotActive) {
                        logger.info('Preparing to start new trading cycle after TP.');
                        // Add delay to ensure clean state
                        await new Promise(resolve => setTimeout(resolve, 1000)); 
                        const remainingOrders = await getOpenOrders(SYMBOL);
                        if (remainingOrders.length === 0) {
                            logger.info('Starting new conservative trading cycle after TP.');
                            await executeInitialMarketBuy();
                        } else {
                            logger.error('Cannot start new cycle after TP - open orders still exist:', remainingOrders);
                        }
                    }
                } else if (orderData.S === 'SELL' && orderData.ps === 'LONG') { // General sell closing a LONG position (could be liquidation or manual close response)
                    logger.info('Long position closed by a SELL order. Order details:', orderData);
                    await cancelAllOpenOrdersAndReset(orderData.s); // This resets state
                    INITIAL_EQUITY_PERCENTAGE = 0.01; // Reset to original
                    logger.info('Trading environment reset and equity percentage restored.');
                    if (isBotActive) {
                        logger.info('Immediately restarting trading cycle after position close.');
                        await executeInitialMarketBuy();
                    }
                }
            }
        } else if (['CANCELED', 'REJECTED', 'EXPIRED'].includes(orderData.X)) {
            logger.warn(`Order ${orderData.i} (${orderData.o} ${orderData.S}) was ${orderData.X}. ClientOrderId: ${orderData.c}. Reason: ${orderData.rc || 'N/A'}`);
            
            const orderIdStr = orderData.i.toString();
            let wasCritical = false;

            if (currentPosition.takeProfitOrderId && orderIdStr === currentPosition.takeProfitOrderId) {
                logger.warn(`Current Take Profit order ${orderIdStr} was ${orderData.X}.`);
                clearTakeProfitOrderId();
                wasCritical = true;
                // If a TP order fails, we might need to try placing it again, especially if the position is still open.
                if (currentPosition.quantity > 0 && isBotActive) {
                    logger.info(`Attempting to replace failed TP order for position quantity: ${currentPosition.quantity}`);
                    const takeProfitPrice = adjustPricePrecision(currentPosition.averageEntryPrice * (1 + (FEE_LIMIT * MARTINGALE_TAKE_PROFIT_FEE_MULTIPLIER)));
                    const newTpOrder = await placeOrder(SYMBOL, 'SELL', 'LONG', 'LIMIT', currentPosition.quantity, takeProfitPrice);
                    if (newTpOrder) {
                        setTakeProfitOrderId(newTpOrder.orderId);
                    } else {
                        logger.error(`Failed to replace TP order after ${orderData.X}. Bot state might be risky.`);
                        // Potentially stop bot or alert heavily.
                    }
                }
            }
            if (currentPosition.martingaleBuyOrderId && orderIdStr === currentPosition.martingaleBuyOrderId) {
                logger.warn(`Current Martingale Buy order ${orderIdStr} was ${orderData.X}.`);
                clearMartingaleBuyOrderId();
                wasCritical = true;
                // If a Martingale buy order fails, the strategy might be broken.
                // Depending on the reason (e.g. insufficient margin vs. temporary issue),
                // the bot might need to stop or attempt to place the next stage differently.
                // For now, we'll log and rely on the general strategy flow. If it was the *current*
                // expected buy, the bot might not progress.
                logger.error(`Martingale Buy Order ${orderIdStr} failed (${orderData.X}). Manual review of strategy state might be needed if bot doesn't recover.`);
                // Could consider stopping the bot if a Martingale buy is essential and fails.
                // isBotActive = false; 
            }
            if (currentPosition.openOrderId && orderIdStr === currentPosition.openOrderId && (orderData.o === 'MARKET' && orderData.S === 'BUY')) {
                 logger.error(`Initial Market Buy order ${orderIdStr} appears to have failed with status ${orderData.X}. This is unexpected for a market order. Review needed.`);
                 wasCritical = true;
                 // If initial buy fails, retry or stop.
                 if(isBotActive){
                    logger.info('Retrying initial market buy after a short delay due to previous failure.');
                    setTimeout(() => executeInitialMarketBuy(), 5000); // Retry after 5s
                 }
            }

            if (!wasCritical) {
                 logger.info(`Non-critical order ${orderIdStr} (${orderData.o} ${orderData.S}) was ${orderData.X}.`);
            }

        }
    } else if (message.e === 'ACCOUNT_UPDATE') {
        // ACCOUNT_UPDATE might provide info on balances or positions.
        // For now, we rely on ORDER_TRADE_UPDATE for fills and getCurrentPosition for explicit checks.
        logger.debug('Account Update (not actively processed for state changes):', message);
    } else if (message.e === 'listenKeyExpired') {
        logger.error('ListenKey expired. Attempting to refresh and reconnect WebSocket.');
        activeListenKey = null; // Invalidate current key
        if (ws) {
            ws.close(4001, "Listen key expired"); // Custom close code for specific handling in 'onclose'
        }
        // The 'close' handler will attempt to recreate the listen key.
        // If it fails repeatedly, isBotActive will be set to false there.
    }
    // Catch any other message types or unknown structures
    else if (message.e) {
        logger.info(`[WebSocket] Received unhandled message type: ${message.e}`, message);
    } else {
        logger.warn('[WebSocket] Received message with unknown structure:', message);
    }
    } catch (error) {
        logger.error('FATAL: Error in handleWebSocketMessage top-level:', error, error.stack, "Raw message:", message);
        // Depending on the severity, consider if the bot should stop or if the error
        // is isolated to this message. For now, log and continue, but this is a critical log.
    }
}

async function cancelAllOpenOrdersAndReset(symbol) {
    logger.info(`Starting order cancellation and environment reset for ${symbol}`);
    
    try {
        // 1. Cancel all open orders
        await cancelAllOpenOrders(symbol);
        // Get only orders that are active and cancellable
        const openOrders = (await getOpenOrders(symbol)).filter(o =>
            o.status === 'NEW' || o.status === 'PARTIALLY_FILLED'
        );
        logger.info(`Found ${openOrders.length} cancellable orders to cancel`);
        
        const cancellationPromises = openOrders.map(order => {
            logger.info(`Cancelling order ${order.orderId} (${order.type} ${order.side} ${order.quantity} @ ${order.price})`);
            return cancelOrder(symbol, order.orderId);
        });
        
        const results = await Promise.allSettled(cancellationPromises);
        
        // Check for any failures
        const failedCancellations = results.filter(r => r.status === 'rejected');
        if (failedCancellations.length > 0) {
            logger.error('Failed to cancel some orders:', failedCancellations);
            throw new Error(`Failed to cancel ${failedCancellations.length} orders`);
        }
        
        logger.info('Successfully cancelled all open orders');
        
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
                logger.info(`Found ${remainingOrders.length} cancellable orders remaining, retrying in ${retryDelayMs}ms (attempt ${attempts}/${maxAttempts})`);
                logger.info('Remaining order IDs:', remainingOrders.map(o => o.orderId));
                await new Promise(resolve => setTimeout(resolve, retryDelayMs));
            }
        }
        
        if (remainingOrders.length > 0) {
            logger.error('Uncancelled orders after all attempts:', remainingOrders.map(o => ({
                id: o.orderId,
                status: o.status,
                type: o.type,
                price: o.price,
                quantity: o.quantity
            })));
            throw new Error(`${remainingOrders.length} orders still open after cancellation (${maxAttempts} attempts)`);
        }
        
        logger.info(`Verification complete - no open orders remain after ${attempts} attempt(s)`);
        
        // 3. Reset trading environment
        resetTradingState();
        
    } catch (error) {
        logger.error('Error during order cancellation and reset:', error, error.stack);
        throw error; // Re-throw to allow upstream handling
    } finally {
        isCancellingOrders = false; // Always release the lock
        logger.info('Order cancellation lock released');
    }
}

// ###################################################################################
// #                          STATE UPDATE FUNCTIONS                                 #
// ###################################################################################

function resetTradingState() {
    logger.info('Resetting trading state variables...');
    currentMartingaleLevel = 0;
    lastMarketBuyPrice = 0;
    lastMartingaleBuyPrice = 0;
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
    // activeListenKey should likely persist or be handled by connection logic.
    // isBotActive is handled separately.
    // isCoolingDown is handled by activateCooldown.
    logger.info('Trading state variables reset.');
}

function updateStateOnInitialFill(orderData) {
    logger.info('Updating state for initial fill:', orderData);
    lastMarketBuyPrice = parseFloat(orderData.p);
    currentPosition.quantity = parseFloat(orderData.q);
    currentPosition.averageEntryPrice = lastMarketBuyPrice;
    currentPosition.entryValueUSD = currentPosition.quantity * lastMarketBuyPrice;
    currentPosition.side = 'LONG';
    currentPosition.openOrderId = orderData.i.toString(); // Assuming 'i' is the orderId
}

function updateStateOnMartingaleFill(orderData) {
    logger.info('Updating state for Martingale fill:', orderData);
    lastMartingaleBuyPrice = parseFloat(orderData.p);
    currentMartingaleLevel++;
    // currentPosition quantity and averageEntryPrice should be updated based on exchange data
    // by calling getCurrentPosition() after this, or from the fill data if comprehensive.
    // For now, we assume getCurrentPosition() will be called to refresh accurately.
    currentPosition.openOrderId = orderData.i.toString();
}

function updateStateOnTPSell(orderData) {
    logger.info('Updating state for TP sell:', orderData);
    // Position is now closed or reduced.
    // Resetting specific parts of currentPosition, full reset will be handled by cancelAllOpenOrdersAndReset
    currentPosition.takeProfitOrderId = null; 
}

function setOpenOrderId(orderId) {
    currentPosition.openOrderId = orderId ? orderId.toString() : null;
}

function setTakeProfitOrderId(orderId) {
    currentPosition.takeProfitOrderId = orderId ? orderId.toString() : null;
}

function clearTakeProfitOrderId() {
    currentPosition.takeProfitOrderId = null;
}

function setMartingaleBuyOrderId(orderId) {
    currentPosition.martingaleBuyOrderId = orderId ? orderId.toString() : null;
}

function clearMartingaleBuyOrderId() {
    currentPosition.martingaleBuyOrderId = null;
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
            logger.warn(`HIGH VOLATILITY - ${logMessage}`);
            lastVolatilityAlert = Date.now();
        } else {
            logger.info(logMessage);
        }
    }
    
    return averageChange * (volatilityRatio > 2 ? 1.2 : 1); // Adjust volatility measure for strong trends
}

function activateCooldown(currentVolatility) {
    // Calculate adaptive cooldown duration based on volatility severity
    const severity = currentVolatility / MAX_VOLATILITY_THRESHOLD;
    const duration = BASE_COOLDOWN_PERIOD * Math.min(VOLATILITY_COOLDOWN_MULTIPLIER, severity);
    
    isCoolingDown = true;
    logger.info(`Starting cooldown for ${(duration/1000).toFixed(1)} seconds due to ${(currentVolatility*100).toFixed(2)}% volatility`);
    
    // Cancel all pending orders when entering cooldown
    cancelAllOpenOrders(SYMBOL).then(() => {
        logger.info('All pending orders cancelled during cooldown');
    }).catch(err => {
        logger.error('Error cancelling orders during cooldown:', err, err.stack);
    });
    
    setTimeout(() => {
        isCoolingDown = false;
        logger.info('Cooldown period ended, resuming trading');
    }, duration);
}

/**
 * Displays volume statistics in the console
 */
function displayVolumeStats() {
    logger.info('\x1b[36m%s\x1b[0m', `=== Volume Statistics ===`);  // Cyan color
    logger.info(`Last Minute:  ${volumeStats.lastMinute.toFixed(4)} BTC`);
    logger.info(`Last 5 Minutes: ${volumeStats.last5Minutes.toFixed(4)} BTC`);
    logger.info(`Last Hour:    ${volumeStats.lastHour.toFixed(4)} BTC`);
    logger.info('\x1b[36m%s\x1b[0m', `=========================`);
}
function calculateQuantity(currentEquityUSD, percentage, price, leverage) {
    if (price <= 0) return 0;
    const MIN_ORDER_VALUE = 2.0; // Minimum order value in USDT
    
    let positionValueUSD = currentEquityUSD * percentage * leverage;
    
    // Ensure minimum order value requirement is met
    if (positionValueUSD < MIN_ORDER_VALUE) {
        logger.warn(`Calculated order value ${positionValueUSD} is below minimum ${MIN_ORDER_VALUE}. Adjusting...`);
        positionValueUSD = MIN_ORDER_VALUE;
    }
    
    const quantityBTC = positionValueUSD / price;
    
    // Additional validation for minimum quantity if needed
    // const MIN_QUANTITY = 0.001; // Example minimum quantity for BTC
    // if (quantityBTC < MIN_QUANTITY) {
    //     logger.warn(`Calculated quantity ${quantityBTC} is below minimum ${MIN_QUANTITY}`);
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
    if (!isBotActive) {
        logger.warn('executeInitialMarketBuy: Bot is not active. Skipping initial market buy.');
        return;
    }
    if (isCancellingOrders) {
        logger.info('executeInitialMarketBuy: Order cancellation in progress. Skipping initial market buy.');
        return;
    }
    if (isCoolingDown) {
        logger.info('executeInitialMarketBuy: Bot is cooling down. Skipping initial market buy.');
        return;
    }
    if (!activeListenKey) {
        logger.warn('executeInitialMarketBuy: WebSocket listen key is not active. Skipping initial market buy due to potential connectivity issues.');
        return;
    }

    // Safeguard: Check for existing position before initial buy
    // This can be resource-intensive if called too often.
    // Relies on cancelAllOpenOrdersAndReset being effective.
    // For now, we'll assume previous cycle cleanup was sufficient.
    // const existingPosition = await getCurrentPosition(SYMBOL);
    // if (existingPosition && existingPosition.quantity > 0) {
    //     logger.warn(`executeInitialMarketBuy: Attempted to place initial buy, but an existing position was found for ${SYMBOL} with quantity ${existingPosition.quantity}. Aborting.`);
    //     return;
    // }
    
    // Redundant checks for isCancellingOrders and isCoolingDown were removed as they are handled at the function start.

    // Check current volatility before proceeding
    const currentVolatility = calculateRecentVolatility();
    if (currentVolatility > MAX_VOLATILITY_THRESHOLD) {
        logger.warn(`Volatility too high (${(currentVolatility*100).toFixed(2)}%), entering cooldown`);
        activateCooldown(currentVolatility);
        return;
    }
    
    // Reduce position size if volatility is elevated but below threshold
    let quantity = 0.0001; // Fixed quantity for initial entry
    if (currentVolatility > MAX_VOLATILITY_THRESHOLD * 0.7) {
        const reduction = 1 - (currentVolatility / MAX_VOLATILITY_THRESHOLD);
        quantity *= Math.max(MIN_POSITION_SIZE_FACTOR, reduction);
        logger.info(`Reducing position size to ${(quantity.toFixed(6))} due to elevated volatility`);
    }

    // Additional check for consecutive volatility spikes
    if (Date.now() - lastVolatilityAlert < BASE_COOLDOWN_PERIOD * 2) {
        logger.warn('Recent volatility alerts detected, extending cooldown');
        activateCooldown(BASE_COOLDOWN_PERIOD * 2);
        return;
    }
    logger.info('Executing initial market buy...');
    try {
        logger.info(`Placing initial market buy for ${quantity} ${SYMBOL}`);
        const order = await placeOrder(
            SYMBOL,
            'BUY',
            'LONG',
            'MARKET',
            quantity
        );

        if (order) {
            setOpenOrderId(order.orderId);
            logger.info('Initial market buy order placed:', order);
        } else {
            logger.error('Failed to place initial market buy order');
        }
    } catch (error) {
        logger.error('Error executing initial market buy:', error, error.stack);
    }
}

async function placeInitialFollowUpOrders() {
    if (!isBotActive) {
        logger.warn('placeInitialFollowUpOrders: Bot is not active. Skipping follow-up orders.');
        return;
    }
    if (isCancellingOrders) {
        logger.info('placeInitialFollowUpOrders: Order cancellation in progress. Skipping follow-up orders.');
        return;
    }
    if (isCoolingDown) { // Should ideally be checked before calling this function too
        logger.info('placeInitialFollowUpOrders: Bot is cooling down. Skipping follow-up orders.');
        return;
    }
    if (!activeListenKey) {
        logger.warn('placeInitialFollowUpOrders: WebSocket listen key is not active. Skipping follow-up orders.');
        return;
    }
    if (currentPosition.quantity <= 0) {
        logger.warn('placeInitialFollowUpOrders: No current position quantity to place follow-up orders for. Skipping.');
        return;
    }
    
    logger.info('Placing volatility-adjusted follow-up orders...');
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
        
        logger.info('Placing take profit order:', {
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
            setTakeProfitOrderId(tpOrder.orderId);
            logger.info('Take profit order placed:', {
                orderId: tpOrder.orderId,
                price: takeProfitPrice,
                quantity: currentPosition.quantity,
                volatility: recentVolatility
            });
        } else {
            logger.error('Failed to place take profit order');
        }

        // Calculate Martingale Buy price with volatility adjustment
        const martingaleBuyPrice = adjustPricePrecision(
            lastMarketBuyPrice *
            (1 - (FEE_LIMIT * dynamicFeeMultiplier))
        );
        
        logger.info('Placing martingale buy order:', {
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
            setMartingaleBuyOrderId(mbOrder.orderId);
            logger.info('Martingale buy order placed:', {
                orderId: mbOrder.orderId,
                price: martingaleBuyPrice,
                quantity: currentPosition.quantity * MARTINGALE_MULTIPLIER,
                martingaleLevel: 1,
                volatility: recentVolatility
            });
        } else {
            logger.error('Failed to place martingale buy order');
        }
    } catch (error) {
        logger.error('Error placing follow-up orders:', {
            error: error.message,
            stack: error.stack,
            position: currentPosition,
            timestamp: Date.now()
        });
    }
}

async function placeNextMartingaleStageOrders() {
    if (!isBotActive) {
        logger.warn('placeNextMartingaleStageOrders: Bot is not active. Skipping.');
        return;
    }
    if (isCancellingOrders) {
        logger.info('placeNextMartingaleStageOrders: Order cancellation in progress. Skipping.');
        return;
    }
    if (isCoolingDown) {  // Should ideally be checked before calling this
        logger.info('placeNextMartingaleStageOrders: Bot is cooling down. Skipping.');
        return;
    }
    if (!activeListenKey) {
        logger.warn('placeNextMartingaleStageOrders: WebSocket listen key is not active. Skipping.');
        return;
    }
    // Ensure there's a position to add to or manage TP for.
    // getCurrentPosition is called inside, but an early check on our state is good.
    if (currentPosition.quantity <= 0 && currentMartingaleLevel === 0) { // Be more specific if needed
        logger.warn('placeNextMartingaleStageOrders: No current position or initial Martingale level. Skipping.');
        return;
    }

    logger.info('Placing next martingale stage orders...');
    try {
        // 1. Cancel all existing open orders
        await cancelAllOpenOrdersAndReset(SYMBOL);
        
        // 2. Get current position details from exchange
        const exchangePosition = await getCurrentPosition(SYMBOL);
        if (!exchangePosition) {
            logger.error('No current position found');
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
        
        logger.info(`Placing take profit for ${currentPosition.quantity} @ ${takeProfitPrice}`);
        const tpOrder = await placeOrder(
            SYMBOL,
            'SELL',
            'LONG',
            'LIMIT',
            currentPosition.quantity,
            takeProfitPrice
        );
        
        if (tpOrder) {
            setTakeProfitOrderId(tpOrder.orderId);
            logger.info('Take profit order placed:', tpOrder);
        }

        // 4. Calculate next martingale buy price and quantity
        const nextBuyQuantity = currentPosition.quantity * MARTINGALE_MULTIPLIER; // Defined here
        const nextBuyPrice = adjustPricePrecision( // Defined here
            currentPosition.averageEntryPrice *
            (1 - (FEE_LIMIT * MARTINGALE_DROP_FEE_MULTIPLIER))
        );
        const requiredMargin = nextBuyQuantity * nextBuyPrice / LEVERAGE;
        const currentBalance = await getAccountBalance();
        
        // Allow up to 10 levels if sufficient balance (2x required margin)
        if (currentMartingaleLevel < 10 && currentBalance > requiredMargin * 2) {
            logger.info(`Placing next martingale buy for ${nextBuyQuantity} @ ${nextBuyPrice}`);
            const buyOrder = await placeOrder(
                SYMBOL,
                'BUY',
                'LONG',
                'LIMIT',
                nextBuyQuantity,
                nextBuyPrice
            );
            
            if (buyOrder) {
                setMartingaleBuyOrderId(buyOrder.orderId);
                // currentMartingaleLevel is now updated in updateStateOnMartingaleFill
                logger.info('Martingale buy order placed (Martingale level will be updated on fill confirmation):', buyOrder);
            }
        } else {
            logger.info('Max martingale levels reached or insufficient balance for next level.');
        }
    } catch (error) {
        logger.error('Error placing next martingale orders:', error, error.stack);
    }
}

async function runBotCycle() {
    if (!isBotActive) {
        logger.warn('runBotCycle: Bot is not active. Not starting new cycle.');
        return;
    }
    if (isCancellingOrders) { // Though less likely to be true here if logic flows well
        logger.warn('runBotCycle: Order cancellation in progress. Not starting new cycle.');
        return;
    }
    if (isCoolingDown) {
        logger.info('runBotCycle: Bot is cooling down. Not starting new cycle.');
        return;
    }
    
    logger.info('Starting new trading cycle...');
    try {
        await setLeverage();
        await executeInitialMarketBuy();
    } catch (error) {
        logger.error('Error in bot cycle:', error, error.stack);
    }
}

async function initializeBot() {
    logger.info('Initializing trading bot...');

    // Clear any existing intervals from previous initializations
    if (keepAliveIntervalId) clearInterval(keepAliveIntervalId);
    if (volumeDisplayIntervalId) clearInterval(volumeDisplayIntervalId);
    // Do NOT clear watchdogIntervalId here, as it's meant to restart initializeBot

    isBotActive = true; // Set active status *after* potential cleanup and before new setup
    
    try {
        // Create WebSocket connection for order updates
        activeListenKey = await createListenKey();
        if (!activeListenKey) {
            throw new Error('Failed to create listen key');
        }
        
        connectWebSocket();
        
        // Start keep-alive interval for listen key (every 30 minutes)
        keepAliveIntervalId = setInterval(() => {
            try {
                if (!isBotActive) {
                    logger.info('Bot is not active, stopping keepAliveInterval.');
                    clearInterval(keepAliveIntervalId);
                    keepAliveIntervalId = null;
                    return;
                }
                if (activeListenKey) {
                    keepAliveListenKey(activeListenKey).catch(err => { // This .catch is for the promise from keepAliveListenKey
                        logger.error('Error in keepAliveListenKey execution (async):', err, err.stack);
                    });
                }
            } catch (e) { // Sync error in the interval callback itself
                logger.error("Synchronous error in keepAliveInterval callback:", e, e.stack);
            }
        }, 30 * 60 * 1000);
        
        // Add volume display interval (every 5 seconds)
        volumeDisplayIntervalId = setInterval(() => {
            try {
                if (!isBotActive) {
                    logger.info('Bot is not active, stopping volumeDisplayInterval.');
                    clearInterval(volumeDisplayIntervalId);
                    volumeDisplayIntervalId = null;
                    return;
                }
                displayVolumeStats();
            } catch (e) { // Sync error in displayVolumeStats or the callback
                logger.error("Error in volumeDisplayInterval callback:", e, e.stack);
            }
        }, 5000);

        // Enhanced watchdog timer with backoff strategy
        // Ensure watchdog is started only once, or managed carefully if initializeBot can be re-entered.
        if (!watchdogIntervalId) { // Start watchdog only if it's not already running
            let watchdogAttempts = 0;
            watchdogIntervalId = setInterval(() => {
                try {
                    // This interval should continue running to potentially restart the bot.
                    if (!isBotActive) {
                        watchdogAttempts++;
                        const delay = Math.min(1000 * Math.pow(2, watchdogAttempts), 30000);
                        logger.info(`Watchdog: Bot inactive, attempting to restart in ${delay/1000} seconds (attempt ${watchdogAttempts})...`);
                        // Ensure only one restart attempt is scheduled
                        if (watchdogAttempts === 1) { // Or use a flag to prevent multiple setTimeout
                             setTimeout(() => {
                                if (!isBotActive) { // Re-check before re-initializing
                                    logger.info("Watchdog: Attempting re-initialization.");
                                    initializeBot().then(() => {
                                        watchdogAttempts = 0; // Reset attempts on successful initialization
                                    }).catch(err => {
                                        logger.error("Watchdog: Re-initialization attempt failed.", err);
                                        // watchdogAttempts will continue to increment if bot remains inactive
                                    });
                                } else {
                                     watchdogAttempts = 0; // Bot became active, reset
                                }
                            }, delay);
                        } else if (watchdogAttempts > 5) { // Example: limit rapid restart attempts by watchdog
                            logger.warn("Watchdog: Multiple restart attempts made, consider manual check if bot does not recover.");
                        }
                    } else {
                        watchdogAttempts = 0; // Bot is active, reset attempts
                    }
                } catch (e) {
                    logger.error("Error in watchdogInterval callback:", e, e.stack);
                }
            }, 60000);
        }
        
        // Start the first trading cycle with retry logic
        const maxRetries = 5;
                const delay = Math.min(1000 * Math.pow(2, watchdogAttempts), 30000);
                logger.info(`Watchdog: Bot inactive, attempting to restart in ${delay/1000} seconds (attempt ${watchdogAttempts})...`);
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
            if (!isBotActive) {
                logger.info('Bot is not active. Halting startCycle retries.');
                return;
            }
            try {
                await runBotCycle();
            } catch (error) {
                logger.error('Error starting trading cycle:', error, error.stack);
                if (retries < maxRetries && isBotActive) { // Check isBotActive before retrying
                    retries++;
                    const delay = Math.min(1000 * retries, 5000);
                    logger.info(`Retrying cycle start in ${delay}ms (attempt ${retries}/${maxRetries})`);
                    setTimeout(startCycle, delay);
                } else if (!isBotActive) {
                    logger.info('Bot became inactive during retry delay for startCycle.');
                } else {
                    logger.error('Max retries reached for starting cycle. Bot may not be trading.');
                }
            }
        };
        startCycle();
    } catch (error) {
        logger.error('Error initializing bot:', error, error.stack);
        isBotActive = false; // Ensure bot is marked inactive on initialization error
        // Enhanced restart logic with exponential backoff
        const delay = Math.min(10000 * (1 + Math.random()), 30000); // Random delay up to 30s
        logger.info(`Attempting to reinitialize bot in ${Math.round(delay/1000)} seconds...`);
        setTimeout(() => {
            // Re-initialization should only happen if something external hasn't stopped it.
            // The watchdog is the primary mechanism for restarting.
            // However, if initializeBot itself fails catastrophically, this offers one immediate retry path.
            // For robustness, ensure initializeBot can be called multiple times or that watchdog handles this.
             if (!isBotActive) { // Check if something else has definitively stopped the bot
                logger.info("Re-initialization attempt via setTimeout after error, but bot is marked inactive. Watchdog should handle if needed.");
             } else {
                initializeBot();
             }
        }, delay);
    }
}

// Start the bot
initializeBot();
// To stop the bot gracefully if needed (e.g., on SIGINT)
// process.on('SIGINT', () => {
//     logger.info("SIGINT received. Shutting down bot...");
//     isBotActive = false;
//     if (ws) {
//         ws.close(1000, "Bot shutdown");
//     }
//     // Clear intervals
//     // Note: This requires intervals to be stored in variables accessible here.
//     // clearInterval(keepAliveInterval); 
//     // clearInterval(volumeDisplayInterval);
//     // clearInterval(watchdogInterval);
//     // Add any other cleanup logic
//     logger.info("Bot shutdown complete.");
//     process.exit(0);
// });
