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
const INITIAL_EQUITY_PERCENTAGE = 0.01; // 1% of equity for the first trade
const MARTINGALE_MULTIPLIER = 1.5; // Double the position size for subsequent Martingale entries

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

// Robust restart mechanism variables
let restartAttempts = 0;
const MAX_RESTART_ATTEMPTS = 5; // Max attempts to restart a cycle if orders are stuck
const RESTART_RETRY_DELAY = 15000; // 15 seconds delay between restart attempts


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
        // console.error('Invalid parameters for signature generation. Params:', paramsString, 'SecretKey Exists:', !!secretKey);
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
    if (!API_KEY || (needsSignature && !SECRET_KEY)) {
         console.error('API credentials not configured. API_KEY Exists:', !!API_KEY, 'SECRET_KEY Exists:', !!SECRET_KEY, 'Needs Signature:', needsSignature);
        throw new Error('API credentials not configured');
    }
    
    const timestamp = Date.now();
    let queryStringWithTimestamp = '';
    let finalQueryString = '';
    let requestBody = null; // For POST requests, body should be formed from params typically.

    const paramsWithTimestamp = { ...params, timestamp };

    if (method === 'GET' || method === 'DELETE') {
        queryStringWithTimestamp = createQueryString(paramsWithTimestamp);
        if (needsSignature) {
            const signature = generateSignature(queryStringWithTimestamp, SECRET_KEY);
            finalQueryString = `${queryStringWithTimestamp}&signature=${signature}`;
        } else {
            finalQueryString = queryStringWithTimestamp;
        }
    } else { // POST
        // For POST, BingX typically expects parameters in the query string for signature,
        // and potentially in the body if it's form data or JSON (though many of their signed POSTs use query params).
        // The provided code puts all params in query string for POST as well.
        queryStringWithTimestamp = createQueryString(paramsWithTimestamp);
         if (needsSignature) {
            const signature = generateSignature(queryStringWithTimestamp, SECRET_KEY);
            finalQueryString = `${queryStringWithTimestamp}&signature=${signature}`;
        } else {
            // This case (POST without signature) is unusual for sensitive actions.
            // If params were meant for body, this would need adjustment.
            // Assuming all params for POST also go into query string as per original structure.
            finalQueryString = queryStringWithTimestamp;
        }
        // If params were meant for the body for POST:
        // requestBody = params; // or JSON.stringify(params) if Content-Type: application/json
        // And queryStringForSignature would not include these body params.
        // However, current structure implies query string for all.
    }

    const url = `${API_BASE_URL}${path}${finalQueryString ? '?' + finalQueryString : ''}`;
    const headers = {
        'X-BX-APIKEY': API_KEY,
    };
    // If POSTing JSON data, add: 'Content-Type': 'application/json'
    // If POSTing form data, Axios handles it or use 'Content-Type': 'application/x-www-form-urlencoded'

    try {
        // console.debug(`[API Request] ${method} ${url}`); // Verbose
        const response = await axios({
            method: method,
            url: url,
            headers: headers,
            data: method === 'POST' ? requestBody : null, // BingX POST often uses query params, body might be empty or specific.
        });
        // console.debug(`[API Response] ${path}:`, response.data); // Verbose

        if (path === '/openApi/user/auth/userDataStream') { // Special handling for listenKey
            if (response.data.listenKey) {
                return response.data;
            }
            throw new Error('Failed to create listenKey: ' + JSON.stringify(response.data));
        }

        if (response.data.code !== 0 && response.data.code !== "0") { // API might return code as string "0"
            console.error(`API Error from ${path}: Code ${response.data.code}, Msg: ${response.data.msg}`, response.data);
            throw new Error(`API Error: ${response.data.msg || 'Unknown error'} (Code: ${response.data.code || 'Unknown'})`);
        }
        return response.data.data || response.data; // Some responses might have data directly
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
    if (now - balanceCache.timestamp < BALANCE_CACHE_TTL && balanceCache.value > 0) {
        return balanceCache.value;
    }

    try {
        const balanceData = await apiRequest('GET', '/openApi/swap/v2/user/balance', { currency: 'USDT' });
        if (balanceData?.balance?.balance) { // Adjusted path based on typical BingX response
            const newBalance = parseFloat(balanceData.balance.balance);
            if (newBalance > 0) {
                balanceCache = {
                    value: newBalance,
                    timestamp: now
                };
                // console.log(`Workspaceed account balance: ${newBalance} USDT`);
                return newBalance;
            }
        }
        console.warn('Could not parse balance from API response or balance is zero:', balanceData);
        return balanceCache.value; // Return old cached value if new is invalid
    } catch (error) {
        console.error('Error fetching account balance:', error.message);
        return balanceCache.value; // Return cached value on error
    }
}

let priceCache = { value: 0, timestamp: 0 };
const PRICE_CACHE_TTL = 10000; // 10 seconds

async function getCurrentBtcPrice() {
    const now = Date.now();
    if (now - priceCache.timestamp < PRICE_CACHE_TTL && priceCache.value > 0) {
        return priceCache.value;
    }

    try {
        // This endpoint typically does not require a signature.
        const priceData = await apiRequest('GET', '/openApi/swap/v2/quote/price', { symbol: SYMBOL }, false);
        if (priceData?.price) {
            const currentPrice = parseFloat(priceData.price);
             if (currentPrice > 0) {
                priceCache = {
                    value: currentPrice,
                    timestamp: now
                };
                // console.log(`Workspaceed BTC price: ${currentPrice}`);
                return currentPrice;
            }
        }
        console.warn('Could not parse price from API response or price is zero:', priceData);
        return priceCache.value; // Return old cached if new invalid
    } catch (error) {
        console.error('Error fetching current BTC price:', error.message);
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
            // timestamp is added by apiRequest
        });
        console.log(`Leverage for ${SYMBOL} (LONG) set to ${LEVERAGE}x successfully.`);
    } catch (error) {
        console.error('Error setting leverage:', error.message);
        // Check for specific error codes if needed, e.g., if leverage is already set.
        // BingX error code 80015: "The leverage cannot be modified. It is the same as the current leverage."
        // BingX error code 100403: Can mean various things, including "Position already exists, cannot modify leverage" if margin mode conflicts.
        if (error.message && (error.message.includes("80015") || error.message.includes("leverage cannot be modified"))) {
            console.log("Leverage is already set to the desired value or cannot be modified at this time.");
        } else if (error.message && error.message.includes("100403")) {
             console.warn("Could not set leverage (100403), possibly due to existing position or margin mode. Ensure Hedge Mode is active for per-side leverage setting.");
        }
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
 * @param {string} [clientOrderId] - Optional client order ID.
 * @returns {Promise<object|null>} The order details from API or null on failure.
 */
async function placeOrder(symbol, side, positionSide, type, quantity, price = null, clientOrderId = null) {
    if (!symbol || !side || !positionSide || !type || quantity <= 0) {
        console.error('Missing or invalid required order parameters:', { symbol, side, positionSide, type, quantity });
        throw new Error('Missing or invalid required order parameters');
    }
    if ((type === 'LIMIT' || type.startsWith('TAKE_PROFIT') || type.startsWith('STOP')) && !price && type !== 'TAKE_PROFIT_MARKET' && type !== 'STOP_MARKET') {
        // TAKE_PROFIT_MARKET and STOP_MARKET might not require a price if they use stopPrice.
        // However, our strategy uses LIMIT for TP, so price is needed.
        if (type === 'LIMIT' && !price) {
           console.error('Limit orders require a price.');
           throw new Error('Limit orders require a price.');
        }
    }
    
    const params = {
        symbol,
        side,
        positionSide,
        type,
        quantity: quantity.toFixed(5), // Adjust precision as needed for BTC
        // timestamp will be added by apiRequest
    };

    if (price !== null) {
        params.price = adjustPricePrecision(price).toString();
    }
    if (clientOrderId) {
        params.clientOrderID = clientOrderId;
    }
    
    // For TAKE_PROFIT_MARKET, it might require stopPrice and workingType
    if (type === 'TAKE_PROFIT_MARKET') {
        // This is usually a conditional order; ensure logic passes stopPrice if used this way.
        // Our current strategy uses LIMIT for TP. If TP_MARKET is intended, parameters need careful review.
        // params.stopPrice = price.toString(); // If price is the trigger for TP_MARKET
        // params.workingType = "MARK_PRICE";
        console.warn("Using TAKE_PROFIT_MARKET without explicit stopPrice setup in params, ensure this is intended or use LIMIT for TP.");
    }


    console.log(`[Order] Placing ${type} ${side} ${quantity.toFixed(5)} ${symbol} ${positionSide} ${price ? `@ ${params.price}` : 'Market'}`);

    try {
        const orderResponse = await apiRequest('POST', '/openApi/swap/v2/trade/order', params);
        if (orderResponse && orderResponse.order) {
            console.log(`Order placed successfully. Order ID: ${orderResponse.order.orderId}, Client Order ID: ${orderResponse.order.clientOrderID}`);
            // Add `isMartingale` if this is a martingale buy, for local tracking.
            // This won't be part of the `orderResponse.order` from API.
            // It should be handled when the order object is stored locally.
            return orderResponse.order;
        }
        console.error('Failed to place order, unexpected response structure:', orderResponse);
        return null;
    } catch (error) {
        console.error(`Error placing ${type} ${side} order:`, error.message);
        return null;
    }
}

async function getOpenOrders(symbol) {
    // console.log(`Workspaceing open orders for ${symbol}...`); // Can be verbose
    try {
        const response = await apiRequest('GET', '/openApi/swap/v2/trade/openOrders', { symbol });
        // console.log('Raw open orders response:', response); 
        return response.orders || [];
    } catch (error) {
        console.error('Error fetching open orders:', error.message);
        return [];
    }
}

async function cancelOrder(symbol, orderId) {
    console.log(`Attempting to cancel order ${orderId} for ${symbol}...`);
    try {
        // DELETE request for cancelling a single order
        const result = await apiRequest('DELETE', '/openApi/swap/v2/trade/order', {
            symbol,
            orderId: orderId.toString(),
            // timestamp added by apiRequest
        });
        // Successful cancellation might return the details of the cancelled order
        // {"code":0,"msg":"","data":{"orderId":"123","symbol":"BTC-USDT", ...}}
        if (result && (result.code === 0 || result.code === "0")) {
             console.log(`Order ${orderId} cancellation request successful. Response:`, result.order || result);
             return true;
        } else {
            // Error code 100407: "Order cancellation failed as it has been filled."
            // Error code 100408: "Order cancellation failed as it has been cancelled."
            // Error code 100409: "Order does not exist."
            if (result && result.code && [100407, "100407", 100408, "100408", 100409, "100409"].includes(result.code)) {
                console.log(`Order ${orderId} already processed or does not exist: ${result.msg} (Code: ${result.code})`);
                return true; // Treat as success for cleanup purposes
            }
            console.warn(`Failed to cancel order ${orderId}. Response:`, result);
            return false;
        }
    } catch (error) {
        console.error(`Error cancelling order ${orderId}:`, error.message);
         if (error.message && (error.message.includes("100407") || error.message.includes("100408") || error.message.includes("100409"))) {
            console.log(`Order ${orderId} likely already processed or non-existent (error in catch).`);
            return true; // Treat as success
        }
        return false;
    }
}

async function getCurrentPosition(symbol) {
    // console.log(`Workspaceing current position for ${symbol}...`); // Can be verbose
    try {
        const positionData = await apiRequest('GET', '/openApi/swap/v2/user/positions', { symbol });
        if (positionData && Array.isArray(positionData) && positionData.length > 0) {
            const longPosition = positionData.find(p => p.symbol === symbol && p.positionSide === 'LONG');
            if (longPosition && parseFloat(longPosition.positionAmt) > 0) {
                // console.log('Current LONG position details:', longPosition);
                return {
                    quantity: parseFloat(longPosition.positionAmt),
                    averageEntryPrice: parseFloat(longPosition.avgPrice),
                    positionId: longPosition.positionId, 
                    unrealizedPnl: parseFloat(longPosition.unrealisedPnl) // Example: add more fields
                };
            }
        }
        // console.log(`No active LONG position found for ${symbol}.`);
        return null; 
    } catch (error) {
        console.error('Error fetching current position:', error.message);
        return null;
    }
}

async function cancelAllOpenOrders(symbol) {
    console.log(`Attempting to cancel ALL open orders for ${symbol} via bulk endpoint...`);
    try {
        const result = await apiRequest('DELETE', '/openApi/swap/v2/trade/allOpenOrders', {
            symbol,
            // timestamp added by apiRequest
        });
        if (result && (result.code === 0 || result.code === "0")) {
            console.log(`Bulk cancel all orders request successful for ${symbol}. Success: ${result.success?.length || 0}, Failed: ${result.failed?.length || 0}`);
            if (result.failed && result.failed.length > 0) {
                console.warn('Some orders failed to cancel in bulk:', result.failed);
            }
            return true;
        }
        console.warn(`Bulk cancel all orders for ${symbol} request failed or had unexpected response:`, result);
        return false;
    } catch (error) {
        console.error(`Error in bulk cancelling all orders for ${symbol}:`, error.message);
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
        console.error('Failed to create ListenKey, response missing listenKey field:', response);
        return null;
    } catch (error) {
        console.error('Error creating ListenKey:', error.message);
        return null;
    }
}

async function keepAliveListenKey(key) {
    if (!key) {
        console.warn('No listenKey provided to keepAliveListenKey.');
        return;
    }
    console.log('Pinging ListenKey to keep alive...');
    try {
        // For PUT, BingX expects listenKey in query params for signature.
        await apiRequest('PUT', '/openApi/user/auth/userDataStream', { listenKey: key }, true);
        console.log('ListenKey kept alive successfully.');
    } catch (error) {
        console.error('Error keeping ListenKey alive:', error.message);
        activeListenKey = await createListenKey(); 
        if (activeListenKey) {
            console.log("Recreated listen key after keep-alive failure. Reconnecting WebSocket...");
            connectWebSocket(); 
        } else {
            console.error("Failed to get a new listen key after keep-alive failure. Bot stopping critical operations.");
            isBotActive = false; // Critical failure
        }
    }
}


let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10; 
const RECONNECT_BASE_DELAY = 5000; 
const MAX_RECONNECT_DELAY = 60000; 
const PING_INTERVAL_WS = 20000; // WebSocket PING (client to server) e.g. every 20s
const LISTEN_KEY_KEEPALIVE_INTERVAL = 20 * 60 * 1000; // API PUT request every 20 mins
let wsPingIntervalId = null; // For WebSocket PING
let listenKeyKeepAliveIntervalId = null; // For API PUT

function cleanupWebSocketResources() {
    if (wsPingIntervalId) {
        clearInterval(wsPingIntervalId);
        wsPingIntervalId = null;
    }
    // Note: listenKeyKeepAliveIntervalId is managed by initializeBot, not directly by ws connection state
}

function connectWebSocket() {
    if (!activeListenKey) {
        console.error('Cannot connect to WebSocket: No active ListenKey.');
        // Attempt to re-acquire listen key if bot is supposed to be active
        if (isBotActive) {
            console.log("Attempting to re-acquire listen key for WebSocket connection...");
            createListenKey().then(key => {
                if (key) {
                    activeListenKey = key;
                    connectWebSocket(); // Retry connection
                } else {
                    console.error("Still no listen key. WebSocket connection aborted.");
                }
            });
        }
        return;
    }
    
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        console.log("WebSocket already open or connecting. Aborting new connection attempt.");
        return;
    }

    cleanupWebSocketResources(); // Clean up previous intervals if any

    const wsUrlWithKey = `${WEBSOCKET_URL}?listenKey=${activeListenKey}`;
    console.log(`Connecting to WebSocket: ${wsUrlWithKey}`);

    ws = new WebSocket(wsUrlWithKey);

    ws.on('open', () => {
        console.log('WebSocket connection established.');
        reconnectAttempts = 0; 
        // Send initial ping to confirm connection
        if (ws.readyState === WebSocket.OPEN) {
            ws.ping(() => console.debug('[WebSocket] Initial Ping sent on open.'));
        }
        // Setup periodic WebSocket ping
        wsPingIntervalId = setInterval(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.ping((err) => {
                    if (err) console.error('[WebSocket] Error sending ping:', err);
                    // else console.debug('[WebSocket] Ping sent.');
                });
            } else {
                 // console.debug('[WebSocket] Skipping ping, WebSocket not open.');
            }
        }, PING_INTERVAL_WS);
    });

    ws.on('message', (data) => {
        try {
            let messageString = data.toString();

            if (messageString === 'Ping') {
                // console.debug('[WebSocket] Received Ping from server, sending Pong.');
                if (ws.readyState === WebSocket.OPEN) ws.send('Pong');
                return;
            }
            if (messageString === 'Pong') {
                // console.debug('[WebSocket] Received Pong from server (our ping was acknowledged).');
                return;
            }
            
            // BingX does not typically send GZIP compressed messages over WebSocket for user data stream.
            // If they did, zlib would be needed here. Assuming plain text JSON.

            if (messageString.startsWith('{') || messageString.startsWith('[')) {
                const message = JSON.parse(messageString);
                // console.debug('[WebSocket] Received JSON message:', message); // Can be very verbose

                if (message.e === 'ORDER_TRADE_UPDATE') {
                    console.log(`[WebSocket] ORDER_TRADE_UPDATE: ID ${message.o?.i}, Status ${message.o?.X}, Type ${message.o?.o}`);
                    handleWebSocketMessage(message).catch(err => 
                        console.error("Error handling ORDER_TRADE_UPDATE message:", err, "Message:", message)
                    );
                } else if (message.e === 'ACCOUNT_UPDATE') {
                    console.log('[WebSocket] ACCOUNT_UPDATE:', message);
                    // Potentially update balance cache here if needed, or rely on periodic fetch.
                } else if (message.e === 'listenKeyExpired') {
                    console.error('[WebSocket] ListenKey expired message received. Refreshing key and reconnecting...');
                    activeListenKey = null; // Invalidate current key
                    ws.close(4001, "ListenKey Expired"); // Close with custom code
                    // Reconnection will be handled by 'close' event, which will attempt to get new key
                } else if (message.e !== 'aggTrade' && message.e !== 'depthUpdate' && message.code !== 0 && message.code !== "0"){ // Filter out frequent, non-critical messages
                    // console.log(`[WebSocket] Received other message type: ${message.e || 'N/A'} Code: ${message.code}`, message);
                }
            } else {
                console.log('[WebSocket] Received non-JSON message:', messageString);
            }
        } catch (error) {
            console.error('Error processing WebSocket message:', error, 'Raw data:', data.toString());
        }
    });

    ws.on('pong', () => {
        // console.debug('[WebSocket] Pong received (our ping was acknowledged).');
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error.message);
        // 'close' event will usually follow, handling reconnection.
    });

    ws.on('close', async (code, reason) => {
        console.log(`WebSocket connection closed. Code: ${code}, Reason: ${reason ? reason.toString() : 'N/A'}`);
        cleanupWebSocketResources(); // Important to clear intervals
        ws = null; // Clear the ws object

        if (!isBotActive && code !== 4001) { // 4001 is our custom code for listen key expired, which should always try to reconnect
             console.log("Bot is not active, WebSocket will not attempt to reconnect unless it was a listenKey expiry.");
             return;
        }

        // Handle specific closure codes
        if (code === 1000 || code === 1001 || code === 1005 ) { // Normal closure, Going Away, No Status Rcvd (often recoverable)
            // Proceed with standard reconnection logic
        } else if (code === 4001) { // Custom code for listenKeyExpired
             console.log("ListenKey expired, attempting to get a new key and reconnect immediately.");
             activeListenKey = null; // Ensure it's cleared
        } else if ([1002, 1003, 1007, 1008, 1009, 1010, 1011].includes(code)) { // Protocol error, Unacceptable data, etc. (Potentially permanent)
            console.error(`Permanent or critical WebSocket error (Code: ${code}). Checking if listen key needs refresh.`);
            // It might be a bad listen key or server-side issue not resolvable by simple reconnect.
            // Forcing a listen key refresh might help.
            activeListenKey = null;
        }


        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            console.error('Maximum WebSocket reconnect attempts reached. Stopping further automatic reconnections for now. Bot may be unhealthy.');
            isBotActive = false; // Consider the bot unhealthy if WS cannot be maintained.
            return;
        }
        
        const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY) + (Math.random() * 1000);
        reconnectAttempts++;
        
        console.log(`Attempting to reconnect WebSocket in ${(delay/1000).toFixed(1)}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
        
        setTimeout(async () => {
            try {
                if (!activeListenKey) { 
                    console.log('Attempting to refresh listen key before WebSocket reconnection...');
                    const newKey = await createListenKey();
                    if (newKey) {
                        activeListenKey = newKey;
                    } else {
                        console.error("Failed to get a new listen key. WebSocket reconnection will likely fail or be delayed.");
                        // Schedule another attempt for connectWebSocket itself rather than just key.
                        connectWebSocket(); // Retry the whole connection process.
                        return;
                    }
                }
                connectWebSocket(); // Attempt to reconnect
            } catch (error) {
                console.error("Exception during WebSocket reconnection attempt scheduler:", error);
                // This catch is for errors in the setTimeout callback logic itself, not connectWebSocket errors.
            }
        }, delay);
    });
}

async function handleWebSocketMessage(message) {
    if (message.e === 'ORDER_TRADE_UPDATE') {
        const orderData = message.o;
        // Example: {"e":"ORDER_TRADE_UPDATE","E":1687868862888,"o":{"s":"BTC-USDT","c":"customOrderId123","S":"BUY","o":"LIMIT","f":"GTC","q":"0.001","p":"25000","X":"NEW","i":"1234567890123456789","l":"0","z":"0","T":1687868862880,...}}
        // Statuses: NEW, PARTIALLY_FILLED, FILLED, CANCELED, REJECTED, EXPIRED

        console.log(`[WS Order Update] ID: ${orderData.i}, Symbol: ${orderData.s}, Side: ${orderData.S}, Type: ${orderData.o}, Status: ${orderData.X}, Qty: ${orderData.q}, Price: ${orderData.p}`);

        if (orderData.X === 'FILLED') {
            const filledPrice = parseFloat(orderData.ap || orderData.p); // avgPrice or price
            const filledQty = parseFloat(orderData.z || orderData.q);   // cumQuote or quantity

            // Initial Market Buy Filled
            if (orderData.o === 'MARKET' && orderData.S === 'BUY' && orderData.i.toString() === currentPosition.openOrderId?.toString()) {
                console.log(`Initial market buy order ${orderData.i} FILLED. Price: ${filledPrice}, Qty: ${filledQty}`);
                lastMarketBuyPrice = filledPrice;
                currentPosition.quantity = filledQty;
                currentPosition.averageEntryPrice = filledPrice;
                currentPosition.entryValueUSD = filledQty * filledPrice;
                currentPosition.side = 'LONG';
                currentPosition.openOrderId = null; // Clear market order ID

                await placeInitialFollowUpOrders();

            } // Martingale Limit Buy Filled
            else if (orderData.o === 'LIMIT' && orderData.S === 'BUY' && orderData.i.toString() === currentPosition.martingaleBuyOrderId?.toString()) {
                console.log(`Martingale buy order ${orderData.i} FILLED. Price: ${filledPrice}, Qty: ${filledQty}`);
                lastMartingaleBuyPrice = filledPrice; // Price of this specific martingale fill
                currentPosition.martingaleBuyOrderId = null; // Clear this specific martingale order ID

                // Critical: Fetch current position from exchange to get accurate avgPrice and total quantity
                const freshPosition = await getCurrentPosition(SYMBOL);
                if (freshPosition) {
                    console.log(`Updating position state after martingale buy. Old Qty: ${currentPosition.quantity}, Old AvgPrice: ${currentPosition.averageEntryPrice}`);
                    currentPosition.quantity = freshPosition.quantity;
                    currentPosition.averageEntryPrice = freshPosition.averageEntryPrice;
                    console.log(`New Qty: ${currentPosition.quantity}, New AvgPrice: ${currentPosition.averageEntryPrice}`);
                } else {
                    console.error("CRITICAL: Could not fetch position details after martingale fill. State might be inconsistent.");
                    // Fallback: update based on order data, but this is less reliable for avgPrice
                    currentPosition.quantity += filledQty;
                    // Avg price calculation here would be complex and error-prone without full position data.
                    // (currentPosition.averageEntryPrice * (currentPosition.quantity - filledQty) + filledPrice * filledQty) / currentPosition.quantity;
                }
                currentMartingaleLevel++;
                console.log(`Martingale level advanced to: ${currentMartingaleLevel}`);
                await placeNextMartingaleStageOrders(); // This will cancel old TP/Martingale and place new ones

            } // Take Profit Limit Sell Filled
            else if (orderData.o === 'LIMIT' && orderData.S === 'SELL' && orderData.i.toString() === currentPosition.takeProfitOrderId?.toString()) {
                console.log(`Take profit order ${orderData.i} FILLED. Price: ${filledPrice}, Qty: ${filledQty}. Trade cycle completed.`);
                currentPosition.takeProfitOrderId = null;
                
                restartAttempts = 0; // Reset restart attempt counter for this new cycle conclusion

                try {
                    console.log('Attempting to cancel all orders and reset trading environment post-TP...');
                    await cancelAllOpenOrdersAndReset(orderData.s); // Symbol from order data
                    console.log('Order cancellation and reset process completed post-TP.');

                    currentMartingaleLevel = 0;
                    console.log('Martingale level reset for new cycle.');

                    if (isBotActive) {
                        console.log('Bot is active. Preparing to start new trading cycle post-TP...');
                        await new Promise(resolve => setTimeout(resolve, 2000)); // Delay for exchange state
                        await attemptSafeRestart(orderData.s);
                    } else {
                        console.log('Bot is not active. New trading cycle will not be started post-TP.');
                    }
                } catch (error) {
                    console.error(`Error during TAKE_PROFIT completion and restart for order ${orderData.i}:`, error);
                    if (isBotActive) {
                        console.error('Scheduling a delayed restart attempt due to error in TP completion.');
                        setTimeout(() => attemptSafeRestart(orderData.s), RESTART_RETRY_DELAY); // Use defined delay
                    }
                }
            } // General Sell order filled (e.g. manual close, stop loss, etc.)
            else if (orderData.S === 'SELL') {
                 console.log(`A SELL order ${orderData.i} (${orderData.o}) was FILLED. Assuming position closed. Price: ${filledPrice}, Qty: ${filledQty}.`);
                 // This could be a TP not tracked by takeProfitOrderId, or a stop loss, or manual close.
                 // Regardless, if it's a sell that reduces position to zero or near zero, we should reset.
                
                restartAttempts = 0; // Reset restart attempt counter

                try {
                    console.log(`General SELL order ${orderData.i} filled. Attempting full reset and restart.`);
                    await cancelAllOpenOrdersAndReset(orderData.s);
                    console.log('Order cancellation and reset process completed post general SELL.');

                    currentMartingaleLevel = 0;
                    console.log('Martingale level reset for new cycle.');

                    if (isBotActive) {
                        console.log('Bot is active. Preparing to start new trading cycle post general SELL...');
                        await new Promise(resolve => setTimeout(resolve, 2000)); 
                        await attemptSafeRestart(orderData.s);
                    } else {
                        console.log('Bot is not active. New trading cycle will not be started.');
                    }
                } catch (error) {
                    console.error(`Error during general SELL completion and restart for order ${orderData.i}:`, error);
                    if (isBotActive) {
                        console.error('Scheduling a delayed restart attempt due to error in general SELL completion.');
                        setTimeout(() => attemptSafeRestart(orderData.s), RESTART_RETRY_DELAY);
                    }
                }
            } else {
                 console.log(`FILLED order ${orderData.i} does not match current known open orders (TP: ${currentPosition.takeProfitOrderId}, Martingale: ${currentPosition.martingaleBuyOrderId}, Initial: ${currentPosition.openOrderId}) or is not a BUY type that advances state.`);
            }

        } else if (orderData.X === 'CANCELED' || orderData.X === 'REJECTED' || orderData.X === 'EXPIRED') {
            console.log(`Order ${orderData.i} (${orderData.o} ${orderData.S}) was ${orderData.X}. ClientOrderID: ${orderData.c}`);
            if (currentPosition.takeProfitOrderId && orderData.i.toString() === currentPosition.takeProfitOrderId.toString()) {
                console.log(`Tracked Take Profit order ${orderData.i} is now ${orderData.X}.`);
                currentPosition.takeProfitOrderId = null;
                // Decide if TP needs to be re-placed. This depends on strategy.
                // If a position still exists, a TP should likely be active.
            }
            if (currentPosition.martingaleBuyOrderId && orderData.i.toString() === currentPosition.martingaleBuyOrderId.toString()) {
                console.log(`Tracked Martingale Buy order ${orderData.i} is now ${orderData.X}.`);
                currentPosition.martingaleBuyOrderId = null;
                // Decide if Martingale order needs to be re-placed.
            }
            if (currentPosition.openOrderId && orderData.i.toString() === currentPosition.openOrderId.toString()) {
                console.log(`Tracked Initial Market Buy order ${orderData.i} is now ${orderData.X}. This is unusual for market orders unless rejected.`);
                currentPosition.openOrderId = null;
            }
            // Potentially, if an essential order fails, try to reset or re-evaluate state.
            // E.g., if TP is cancelled while position is open, bot should try to place a new TP.
            // This part needs more sophisticated logic based on why it was cancelled and what the current position is.
            const pos = await getCurrentPosition(SYMBOL);
            if (pos && pos.quantity > 0 && !currentPosition.takeProfitOrderId) {
                console.warn("Position exists but no Take Profit order ID is tracked. Attempting to re-place TP.");
                // This is a simplified re-placement; might need more context from `currentPosition.averageEntryPrice`
                const tpPrice = adjustPricePrecision(currentPosition.averageEntryPrice * (1 + (FEE_LIMIT * MARTINGALE_TAKE_PROFIT_FEE_MULTIPLIER))); // Example logic
                if (currentPosition.averageEntryPrice > 0 && currentPosition.quantity > 0){
                    const newTpOrder = await placeOrder(SYMBOL, 'SELL', 'LONG', 'LIMIT', currentPosition.quantity, tpPrice);
                    if (newTpOrder) currentPosition.takeProfitOrderId = newTpOrder.orderId;
                } else {
                    console.error("Cannot re-place TP: missing position data (avgEntryPrice or quantity).")
                }
            }

        }
    } else if (message.e === 'ACCOUNT_UPDATE') {
        // console.log('Account Update (WebSocket):', message); // Can be verbose
        // This can provide updates on balances or positions.
        // Could be used to preemptively update balanceCache or verify position state.
        // For now, primarily relying on direct order updates and REST API calls for critical state.
    }
}

async function cancelAllOpenOrdersAndReset(symbol) {
    if (isCancellingOrders) {
        console.warn("Cancellation already in progress, skipping new request for cancelAllOpenOrdersAndReset.");
        return;
    }
    isCancellingOrders = true;
    console.log(`--- Starting Full Order Cancellation and State Reset for ${symbol} ---`);
    
    try {
        // 1. Attempt bulk cancellation first
        await cancelAllOpenOrders(symbol); 
        await new Promise(resolve => setTimeout(resolve, 500)); // Short delay for exchange to process bulk cancel

        // 2. Iteratively check and cancel remaining active orders
        let attempts = 0;
        const maxAttempts = 5; 
        const retryDelayMs = 1500; 
        let openOrdersStillActive = [];

        while (attempts < maxAttempts) {
            const allOpen = await getOpenOrders(symbol);
            openOrdersStillActive = allOpen.filter(o => o.status === 'NEW' || o.status === 'PARTIALLY_FILLED');
            
            if (openOrdersStillActive.length === 0) {
                console.log(`All active orders confirmed cancelled for ${symbol} after ${attempts + 1} check(s).`);
                break;
            }

            console.log(`Found ${openOrdersStillActive.length} active orders remaining for ${symbol}. Attempting individual cancellation (Attempt ${attempts + 1}/${maxAttempts}).`);
            const cancellationPromises = openOrdersStillActive.map(order => 
                cancelOrder(symbol, order.orderId)
            );
            
            const results = await Promise.allSettled(cancellationPromises);
            results.forEach((result, index) => {
                if (result.status === 'rejected') {
                    console.warn(`Failed to cancel order ${openOrdersStillActive[index].orderId} during retry:`, result.reason);
                }
            });
            
            attempts++;
            if (attempts < maxAttempts && openOrdersStillActive.length > 0) { // Check again before delaying
                 const checkStillOpen = await getOpenOrders(symbol);
                 if (!checkStillOpen.some(o => o.status === 'NEW' || o.status === 'PARTIALLY_FILLED')) {
                    console.log(`All active orders confirmed cancelled for ${symbol} on re-check.`);
                    openOrdersStillActive = []; // Ensure loop exits
                    break;
                 }
                console.log(`Delaying ${retryDelayMs}ms before next check/cancel attempt...`);
                await new Promise(resolve => setTimeout(resolve, retryDelayMs));
            }
        }

        if (openOrdersStillActive.length > 0) {
            console.error(`CRITICAL: ${openOrdersStillActive.length} orders still OPEN for ${symbol} after ${maxAttempts} attempts:`, openOrdersStillActive.map(o => ({ id: o.orderId, status: o.status, type: o.type })));
            // This is a problem. The bot might not be able to proceed safely.
            // For now, we will reset state, but this situation needs monitoring.
            // throw new Error(`${openOrdersStillActive.length} orders still open after cancellation attempts.`); // Or handle more gracefully
        } else {
            console.log(`Successfully ensured no 'NEW' or 'PARTIALLY_FILLED' orders remain for ${symbol}.`);
        }
        
        // 3. Reset bot's internal trading state
        console.log('Resetting internal trading state variables...');
        currentPosition = {
            quantity: 0, averageEntryPrice: 0, entryValueUSD: 0, side: 'LONG',
            positionId: null, openOrderId: null, takeProfitOrderId: null, martingaleBuyOrderId: null,
        };
        currentMartingaleLevel = 0;
        lastMarketBuyPrice = 0;
        lastMartingaleBuyPrice = 0;
        
        console.log('Martingale level reset to 0. Current position quantity reset to 0.');
        console.log('--- Full Order Cancellation and State Reset COMPLETED ---');
        
    } catch (error) {
        console.error('Critical error during cancelAllOpenOrdersAndReset:', error.message);
        // Even on error, try to reset state to a safe default, but this situation is problematic.
         currentPosition = { quantity: 0, averageEntryPrice: 0, entryValueUSD: 0, side: 'LONG', positionId: null, openOrderId: null, takeProfitOrderId: null, martingaleBuyOrderId: null };
         currentMartingaleLevel = 0;
        // throw error; // Re-throw if the caller needs to handle it specifically
    } finally {
        isCancellingOrders = false;
        // console.log('Order cancellation lock released.');
    }
}

// ###################################################################################
// #                          BOT TRADING LOGIC                                      #
// ###################################################################################

let priceHistory = []; // For volatility calculation
// updateVolumeStats and calculateRecentVolatility are not directly used by core logic in this version
// but can be useful for monitoring or adaptive strategies.
function updatePriceHistory() {
    const currentPrice = priceCache.value; // Use cached price
    const now = Date.now();
    if (currentPrice > 0) {
        priceHistory.push({ price: currentPrice, time: now });
        priceHistory = priceHistory.filter(p => p.time > now - VOLATILITY_WINDOW); // Keep relevant window
    }
}
// Periodically update price history for volatility calculation
setInterval(updatePriceHistory, 5000); // Update every 5 seconds, for example


function calculateRecentVolatility() {
    if (priceHistory.length < 20) return 0; // Need enough data points (e.g., > 20 for 1 min with 5s interval)
    
    const prices = priceHistory.map(p => p.price);
    const returns = [];
    for (let i = 1; i < prices.length; i++) {
        returns.push((prices[i] - prices[i-1]) / prices[i-1]);
    }
    if (returns.length === 0) return 0;

    const stdDev = Math.sqrt(returns.map(x => Math.pow(x - (returns.reduce((a,b)=>a+b,0)/returns.length), 2)).reduce((a,b)=>a+b,0) / returns.length);
    // Annualize/Periodize if needed, for now, this is a measure over VOLATILITY_WINDOW
    // console.log(`Calculated volatility (stdDev of returns): ${stdDev.toFixed(6)}`);
    return stdDev;
}

function activateCooldown(duration) {
    if (isCoolingDown) {
        console.log("Already in cooldown period.");
        return;
    }
    isCoolingDown = true;
    console.warn(`High volatility detected! Activating trading cooldown for ${(duration / 1000).toFixed(1)} seconds.`);
    
    // Cancel all pending orders before cooldown
    cancelAllOpenOrdersAndReset(SYMBOL).then(() => {
        console.log('All pending orders cancelled due to cooldown activation.');
    }).catch(err => {
        console.error('Error cancelling orders during cooldown activation:', err);
    });
    
    setTimeout(() => {
        isCoolingDown = false;
        console.log('Cooldown period ended. Resuming trading operations.');
        // Potentially trigger a cycle start if appropriate and no cycle is active
        if (isBotActive && currentPosition.quantity === 0 && !currentPosition.openOrderId) {
            console.log("Attempting to start a new cycle after cooldown.");
            attemptSafeRestart(SYMBOL);
        }
    }, duration);
}


function calculateQuantity(currentEquityUSD, percentageOfEquity, price, leverage) {
    if (price <= 0 || currentEquityUSD <= 0) {
        console.error("Invalid price or equity for quantity calculation.", {price, currentEquityUSD});
        return 0;
    }
    // This is the notional value of the position
    const positionValueUSDLeveraged = currentEquityUSD * percentageOfEquity * leverage;
    
    // BingX min order size for BTC-USDT perpetual is typically 0.0001 BTC (contract value)
    // Min notional value usually around 5 USDT.
    const MIN_NOTIONAL_VALUE_USDT = 5; 
    const MIN_QUANTITY_BTC = 0.0001;

    if (positionValueUSDLeveraged < MIN_NOTIONAL_VALUE_USDT) {
        console.warn(`Calculated leveraged position value ${positionValueUSDLeveraged.toFixed(2)} USDT is below exchange minimum ${MIN_NOTIONAL_VALUE_USDT} USDT. Adjusting to minimum.`);
        // This would require calculating quantity based on MIN_NOTIONAL_VALUE_USDT
        // quantityBTC = MIN_NOTIONAL_VALUE_USDT / price;
        // For this strategy, we'll use a fixed small quantity for the initial buy for simplicity as per executeInitialMarketBuy
        // This function is more for a dynamic sizing strategy. The bot uses a fixed 0.0001 BTC.
    }

    let quantityBTC = positionValueUSDLeveraged / price;

    if (quantityBTC < MIN_QUANTITY_BTC) {
         console.warn(`Calculated BTC quantity ${quantityBTC.toFixed(8)} is below minimum ${MIN_QUANTITY_BTC}. Using minimum quantity.`);
         quantityBTC = MIN_QUANTITY_BTC;
    }
    
    // Precision for BTC quantity on BingX is usually 4-5 decimal places for orders.
    return parseFloat(quantityBTC.toFixed(5)); 
}


function adjustPricePrecision(price) {
    // For BTC-USDT, tick size is typically 0.1 (1 decimal place for price).
    // Check BingX API documentation for the specific symbol if not BTC-USDT.
    // Example: return parseFloat(price.toFixed(1)); for BTC-USDT
    return parseFloat(price.toFixed(1)); // Adjust to 1 decimal place for BTC/USDT price
}

async function executeInitialMarketBuy() {
    if (isCancellingOrders) {
        console.log(`Skipping initial market buy: Order cancellation in progress.`);
        return;
    }
    if (isCoolingDown) {
        console.log(`Skipping initial market buy: Bot is in cooldown period.`);
        return;
    }
    if (currentPosition.quantity > 0 || currentPosition.openOrderId) {
        console.log(`Skipping initial market buy: Existing position or open order detected. Qty: ${currentPosition.quantity}, Open Order ID: ${currentPosition.openOrderId}`);
        return;
    }

    console.log('--- Executing Initial Market Buy ---');
    try {
        const currentPrice = await getCurrentBtcPrice();
        if (currentPrice <= 0) {
            console.error("Cannot execute market buy: Invalid current price.");
            throw new Error("Invalid current price for initial market buy.");
        }

        // Volatility check (simplified)
        const volatility = calculateRecentVolatility(); // Assumes priceHistory is updated
        if (volatility > MAX_VOLATILITY_THRESHOLD) {
            console.warn(`High volatility (${(volatility*100).toFixed(4)}%) detected. Activating cooldown.`);
            activateCooldown(BASE_COOLDOWN_PERIOD * VOLATILITY_COOLDOWN_MULTIPLIER);
            throw new Error("High volatility, cooldown activated."); // Stop this attempt
        }
        
        // Using a fixed small quantity for the first trade as per original intent.
        // Dynamic sizing can be re-introduced here if desired using calculateQuantity.
        const fixedInitialQuantityBTC = 0.0001; 
        
        // const balance = await getAccountBalance();
        // const quantity = calculateQuantity(balance, INITIAL_EQUITY_PERCENTAGE, currentPrice, LEVERAGE);
        const quantity = fixedInitialQuantityBTC;


        if (quantity <= 0) {
            console.error('Invalid calculated quantity for initial buy (<=0). Cannot proceed.');
            throw new Error("Calculated quantity is zero or negative.");
        }

        console.log(`Placing initial market buy for ${quantity.toFixed(5)} ${SYMBOL} at current market price (approx ${currentPrice}).`);
        const order = await placeOrder(
            SYMBOL,
            'BUY',
            'LONG',
            'MARKET',
            quantity
        );

        if (order && order.orderId) {
            currentPosition.openOrderId = order.orderId; // Track the new market order
            console.log(`Initial market buy order PLACED. Order ID: ${order.orderId}. Waiting for FILL confirmation via WebSocket.`);
            // State (lastMarketBuyPrice, currentPosition.quantity etc.) will be updated on WebSocket FILL message.
        } else {
            console.error('Failed to place initial market buy order or orderId missing in response.');
            // This failure should be caught by attemptSafeRestart if it was called from there.
            throw new Error("Failed to place initial market buy order.");
        }
    } catch (error) {
        console.error('Error executing initial market buy:', error.message);
        // Re-throw error so that if attemptSafeRestart called this, it can handle retry.
        throw error; 
    }
}

async function placeInitialFollowUpOrders() {
    if (isCancellingOrders || currentPosition.quantity <= 0 || currentPosition.averageEntryPrice <= 0) {
        console.log('Skipping initial follow-up orders: Cancellation in progress, or no valid position.');
        return;
    }
    console.log('--- Placing Initial Follow-Up Orders (TP and First Martingale) ---');
    try {
        // Ensure previous TP/Martingale orders are cleared if any (should be handled by reset, but as a safeguard)
        if(currentPosition.takeProfitOrderId) await cancelOrder(SYMBOL, currentPosition.takeProfitOrderId);
        if(currentPosition.martingaleBuyOrderId) await cancelOrder(SYMBOL, currentPosition.martingaleBuyOrderId);
        currentPosition.takeProfitOrderId = null;
        currentPosition.martingaleBuyOrderId = null;


        // 1. Place Take Profit order
        // TP based on initial entry, covering market buy fee and a small profit
        const takeProfitPrice = adjustPricePrecision(
            currentPosition.averageEntryPrice * (1 + INITIAL_TAKE_PROFIT_PERCENTAGE) // Example: entry + 0.032%
        );
        
        console.log(`Placing initial Take Profit LIMIT order for ${currentPosition.quantity.toFixed(5)} ${SYMBOL} at ${takeProfitPrice}.`);
        const tpOrder = await placeOrder(
            SYMBOL,
            'SELL',
            'LONG',
            'LIMIT', // Using LIMIT for TP
            currentPosition.quantity,
            takeProfitPrice
        );
        
        if (tpOrder && tpOrder.orderId) {
            currentPosition.takeProfitOrderId = tpOrder.orderId;
            console.log(`Initial Take Profit order placed. ID: ${tpOrder.orderId}`);
        } else {
            console.error('Failed to place initial Take Profit order.');
            // If TP fails, the position is unprotected. Critical. Bot might need to retry or pause.
        }
        
        // 2. Place first Martingale buy order (if strategy uses Martingale from level 0)
        if (currentMartingaleLevel < 5) { // Max 5 levels of Martingale
            const nextMartingaleBuyPrice = adjustPricePrecision(
                lastMarketBuyPrice * (1 - (FEE_LIMIT * MARTINGALE_DROP_FEE_MULTIPLIER)) // Drop from last *market* buy
            );
            const nextMartingaleQuantity = parseFloat((currentPosition.quantity * MARTINGALE_MULTIPLIER).toFixed(5));
            
            console.log(`Placing first Martingale LIMIT BUY order for ${nextMartingaleQuantity} ${SYMBOL} at ${nextMartingaleBuyPrice}.`);
            const mbOrder = await placeOrder(
                SYMBOL,
                'BUY',
                'LONG',
                'LIMIT',
                nextMartingaleQuantity,
                nextMartingaleBuyPrice
                // clientOrderID: `martingale_${currentMartingaleLevel + 1}_${Date.now()}` // Optional: for easier tracking
            );
            
            if (mbOrder && mbOrder.orderId) {
                currentPosition.martingaleBuyOrderId = mbOrder.orderId;
                console.log(`First Martingale buy order placed. ID: ${mbOrder.orderId}`);
            } else {
                console.error('Failed to place first Martingale buy order.');
            }
        } else {
            console.log("Max martingale level reached at initial stage, no first Martingale buy order placed.");
        }
    } catch (error) {
        console.error('Error placing initial follow-up orders:', error.message);
    }
}

async function placeNextMartingaleStageOrders() {
    if (isCancellingOrders || currentPosition.quantity <= 0 || currentPosition.averageEntryPrice <= 0) {
        console.log('Skipping next martingale stage: Cancellation in progress or no valid position.');
        return;
    }
    console.log(`--- Placing Next Martingale Stage Orders (Level ${currentMartingaleLevel}) ---`);
    
    try {
        // 1. Cancel existing Take Profit order (as average price has changed)
        if (currentPosition.takeProfitOrderId) {
            console.log(`Cancelling existing TP order: ${currentPosition.takeProfitOrderId}`);
            await cancelOrder(SYMBOL, currentPosition.takeProfitOrderId);
            currentPosition.takeProfitOrderId = null;
        }
        // 2. Cancel existing (older) Martingale buy order if any (this function is called AFTER a martingale fill)
        // The specific filled martingale order ID is already cleared by handleWebSocketMessage.
        // If there was another one for a deeper level that's now wrong, it should be cleared.
        // However, `cancelAllOpenOrdersAndReset` is more thorough, but here we are mid-cycle.
        // For safety, let's ensure no OTHER martingale buy order is lingering.
        // This is tricky if not using clientOrderIds to identify them.
        // For now, we rely on `currentPosition.martingaleBuyOrderId` being the *next* one to place.
        // The one that just filled should have been cleared.

        // 3. Place new Take Profit for the entire aggregated position
        const newTakeProfitPrice = adjustPricePrecision(
            currentPosition.averageEntryPrice * (1 + (FEE_LIMIT * MARTINGALE_TAKE_PROFIT_FEE_MULTIPLIER))
        );
        
        console.log(`Placing new Take Profit for aggregated position (${currentPosition.quantity.toFixed(5)} ${SYMBOL}) at ${newTakeProfitPrice}. Avg Entry: ${currentPosition.averageEntryPrice}`);
        const newTpOrder = await placeOrder(
            SYMBOL,
            'SELL',
            'LONG',
            'LIMIT',
            currentPosition.quantity,
            newTakeProfitPrice
        );
        if (newTpOrder && newTpOrder.orderId) {
            currentPosition.takeProfitOrderId = newTpOrder.orderId;
            console.log(`New Take Profit order placed. ID: ${newTpOrder.orderId}`);
        } else {
            console.error('CRITICAL: Failed to place new Take Profit order after martingale.');
            // Position is now larger and potentially without TP. Needs robust handling.
        }

        // 4. Place next Martingale buy order if not exceeding max levels
        if (currentMartingaleLevel < 5) { // Max 5 levels (0, 1, 2, 3, 4)
            // Price drop calculation should be based on the last actual fill price of a martingale order,
            // or if none, the initial market buy. Using `lastMartingaleBuyPrice` which should be updated upon fill.
            // If this is the first martingale (level 1), lastMartingaleBuyPrice might not be set yet, so use avg entry as base.
            const basePriceForNextDrop = lastMartingaleBuyPrice > 0 ? lastMartingaleBuyPrice : currentPosition.averageEntryPrice;

            const nextMartingaleBuyPrice = adjustPricePrecision(
                basePriceForNextDrop * (1 - (FEE_LIMIT * MARTINGALE_DROP_FEE_MULTIPLIER))
            );
            // Quantity for next martingale buy is a multiple of the *current total position* or *initial size*
            // Original code: currentPosition.quantity * MARTINGALE_MULTIPLIER
            // This means quantity grows very fast. Let's assume it's based on initial trade size * multiplier ^ level
            // For simplicity, using the provided: current total quantity * multiplier
            const nextMartingaleQuantity = parseFloat((currentPosition.quantity * MARTINGALE_MULTIPLIER).toFixed(5)); 

            console.log(`Placing next Martingale (level ${currentMartingaleLevel+1}) LIMIT BUY for ${nextMartingaleQuantity} ${SYMBOL} at ${nextMartingaleBuyPrice}.`);
            const nextMbOrder = await placeOrder(
                SYMBOL,
                'BUY',
                'LONG',
                'LIMIT',
                nextMartingaleQuantity,
                nextMartingaleBuyPrice
                // clientOrderID: `martingale_${currentMartingaleLevel + 1}_${Date.now()}`
            );
            if (nextMbOrder && nextMbOrder.orderId) {
                currentPosition.martingaleBuyOrderId = nextMbOrder.orderId;
                console.log(`Next Martingale buy order (for level ${currentMartingaleLevel+1}) placed. ID: ${nextMbOrder.orderId}`);
            } else {
                console.error(`Failed to place next Martingale buy order for level ${currentMartingaleLevel+1}.`);
            }
        } else {
            console.log(`Max Martingale level (${currentMartingaleLevel}) reached. No further Martingale buy orders will be placed.`);
            currentPosition.martingaleBuyOrderId = null; // Ensure no old ID lingers
        }
    } catch (error) {
        console.error(`Error placing next Martingale stage orders (level ${currentMartingaleLevel}):`, error.message);
    }
}

async function attemptSafeRestart(symbol) {
    if (!isBotActive) {
        console.log("attemptSafeRestart: Bot is not active. Aborting restart.");
        return;
    }
    console.log(`--- Attempting Safe Restart for ${symbol}. Attempt: ${restartAttempts + 1}/${MAX_RESTART_ATTEMPTS} ---`);

    try {
        // Ensure any lingering cancellations are finished or wait.
        if (isCancellingOrders) {
            console.warn("attemptSafeRestart: Order cancellation is still in progress. Delaying restart attempt.");
            if (restartAttempts < MAX_RESTART_ATTEMPTS -1) {
                restartAttempts++;
                setTimeout(() => attemptSafeRestart(symbol), RESTART_RETRY_DELAY);
            } else {
                 console.error("attemptSafeRestart: Max restart attempts reached while waiting for order cancellation to finish.");
                 restartAttempts = 0; // Reset for next cycle
            }
            return;
        }

        // Double check position and open orders
        await cancelAllOpenOrdersAndReset(symbol); // Run a thorough cleanup again.

        const openOrders = await getOpenOrders(symbol);
        const activeRemainingOrders = openOrders.filter(o =>
            o.status === 'NEW' || o.status === 'PARTIALLY_FILLED'
        );
        const currentPos = await getCurrentPosition(symbol);

        if (activeRemainingOrders.length === 0 && (!currentPos || currentPos.quantity === 0)) {
            console.log('No active conflicting orders or positions found. Proceeding with new trading cycle via executeInitialMarketBuy.');
            restartAttempts = 0; // Reset counter on success before execution
            await executeInitialMarketBuy(); // This can throw error
            console.log("--- Safe Restart: executeInitialMarketBuy initiated. ---")
        } else {
            console.error(`Cannot start new cycle - ${activeRemainingOrders.length} active orders still exist OR position quantity is ${currentPos?.quantity || 'N/A'}.`);
            activeRemainingOrders.forEach(o => console.log(`Remaining order: ID ${o.orderId}, Status ${o.status}, Type ${o.type}, Side ${o.side}`));
            if (currentPos && currentPos.quantity > 0) console.log(`Existing position: Qty ${currentPos.quantity}, AvgPrice ${currentPos.averageEntryPrice}`);

            if (restartAttempts < MAX_RESTART_ATTEMPTS -1) {
                restartAttempts++;
                console.log(`Scheduling retry for safe restart in ${RESTART_RETRY_DELAY / 1000} seconds.`);
                setTimeout(() => attemptSafeRestart(symbol), RESTART_RETRY_DELAY);
            } else {
                console.error('CRITICAL: Maximum restart attempts reached. Halting automatic restart for this cycle. Manual intervention may be needed.');
                // isBotActive = false; // Optionally stop the bot if it can't recover.
                restartAttempts = 0; // Reset for future manual or watchdog restart
            }
        }
    } catch (error) { // Catch errors from executeInitialMarketBuy or API calls within this function
        console.error('Error during safe restart attempt itself:', error.message);
        if (restartAttempts < MAX_RESTART_ATTEMPTS -1) {
            restartAttempts++;
            console.log(`Scheduling retry for safe restart due to error, in ${RESTART_RETRY_DELAY / 1000} seconds.`);
            setTimeout(() => attemptSafeRestart(symbol), RESTART_RETRY_DELAY);
        } else {
            console.error('CRITICAL: Maximum restart attempts reached after error during restart. Halting automatic restart.');
            // isBotActive = false;
            restartAttempts = 0;
        }
    }
}


async function runBotCycle() { // This is the entry point for a new full cycle
    if (!isBotActive) {
        console.log('Bot is not active. Not starting new cycle via runBotCycle.');
        return;
    }
    
    console.log('--- Preparing for new Trading Cycle via runBotCycle ---');
    try {
        // Ensure leverage is set (idempotent)
        await setLeverage(); 
        
        // Reset martingale level for a truly new cycle start
        currentMartingaleLevel = 0;
        restartAttempts = 0; // Reset restart attempts counter too

        // Clean up any existing state and orders before starting fresh
        console.log("Running pre-cycle cleanup (cancelAllOpenOrdersAndReset)...");
        await cancelAllOpenOrdersAndReset(SYMBOL);
        
        // Check if a position still exists (e.g., if cleanup failed or manual position)
        const existingPosition = await getCurrentPosition(SYMBOL);
        if (existingPosition && existingPosition.quantity > 0) {
            console.warn(`A position of ${existingPosition.quantity} ${SYMBOL} still exists. Cannot start a new cycle automatically. Manual review needed or ensure cleanup is effective.`);
            // isBotActive = false; // Or pause and alert
            return;
        }

        // Proceed to attempt starting the cycle
        await attemptSafeRestart(SYMBOL);

    } catch (error) {
        console.error('Error in runBotCycle:', error.message);
        // If runBotCycle itself fails critically, schedule a re-initialization or alert.
        // This could be from setLeverage or initial getCurrentPosition.
        if (isBotActive) { // If still active, try to recover initialization after a delay
            console.error("Scheduling a full re-initialization due to error in runBotCycle.");
            setTimeout(initializeBot, 30000); // Delay before re-init
        }
    }
}

let initializeAttempts = 0;
const MAX_INITIALIZE_ATTEMPTS = 5;

async function initializeBot() {
    if (isBotActive && activeListenKey && ws && ws.readyState === WebSocket.OPEN) {
        console.log("Bot already initialized and WebSocket is open.");
        return;
    }
    
    initializeAttempts++;
    if (initializeAttempts > MAX_INITIALIZE_ATTEMPTS) {
        console.error("MAXIMUM INITIALIZATION ATTEMPTS REACHED. BOT REMAINS INACTIVE.");
        isBotActive = false; // Explicitly set inactive
        return; // Stop trying to initialize
    }

    console.log(`\n=== Initializing Trading Bot (Attempt ${initializeAttempts}/${MAX_INITIALIZE_ATTEMPTS}) ===`);
    isBotActive = true; // Assume active unless a critical failure occurs
    
    try {
        // Initial balance fetch (totalInitialEquityUSD is not used in current fixed quantity logic but good to have)
        totalInitialEquityUSD = await getAccountBalance();
        console.log(`Initial account equity: ${totalInitialEquityUSD} USDT`);
        if (totalInitialEquityUSD <= 0) {
            console.warn("Account balance is zero or could not be fetched. Bot may not function correctly.");
            // isBotActive = false; // Consider this a critical failure for some strategies
        }

        activeListenKey = await createListenKey();
        if (!activeListenKey) {
            console.error('Failed to create listen key during initialization. Bot cannot receive account updates.');
            isBotActive = false; // Critical failure
            throw new Error('Failed to create listen key');
        }
        
        connectWebSocket(); // Establishes WebSocket connection using activeListenKey
        
        // Clear previous interval if any to prevent multiple listeners
        if (listenKeyKeepAliveIntervalId) clearInterval(listenKeyKeepAliveIntervalId);
        listenKeyKeepAliveIntervalId = setInterval(() => {
            if (activeListenKey && isBotActive) { // Only keep alive if bot is active and key exists
                keepAliveListenKey(activeListenKey);
            }
        }, LISTEN_KEY_KEEPALIVE_INTERVAL); // e.g., every 20 minutes
        
        // (Volume stats display can be re-added if needed)
        // setInterval(displayVolumeStats, 60000); 

        console.log("Bot initialization sequence complete. Starting first trading cycle logic...");
        initializeAttempts = 0; // Reset counter on successful initialization path
        await runBotCycle(); // Start the first trading cycle logic

    } catch (error) {
        console.error('Error during bot initialization:', error.message);
        isBotActive = false; // Ensure bot is marked inactive on init failure
        console.log(`Attempting to reinitialize bot in ${10 * initializeAttempts} seconds...`);
        setTimeout(initializeBot, 10000 * initializeAttempts); // Exponential backoff for re-initialization
    }
}

// Global error handling (optional, but good for unhandled rejections)
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Application specific logging, throwing an error, or other logic here
});
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Application specific logging, cleanup, and exit
  // For a 24/7 bot, you might try a graceful shutdown or alert, then exit to be restarted by a process manager.
  // process.exit(1); // Exiting might be too drastic without a process manager like PM2
});


// Start the bot
initializeBot();