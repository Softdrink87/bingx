const validLevels = ['info', 'warn', 'error'];

function logMessage(level, type, message) {
    if (!validLevels.includes(level)) {
        console.error(`Invalid log level: ${level}`);
        return;
    }
    console.log(`[${level}] [${type}] ${message}`);
}

function logStatus(message, level = 'info') {
    logMessage(level, 'STATUS', message);
}

function logProgress(message, level = 'info') {
    logMessage(level, 'PROGRESS', message);
}

const crypto = require('crypto');
const WebSocket = require('ws');
const axios = require('axios'); // axios import 추가
const zlib = require('zlib'); // zlib import 추가

// ###################################################################################
// #                          USER CONFIGURATION                                     #
// ###################################################################################
const API_KEY = "N6FCCypIiKnpZlB4BnvhYWBHb4iwIqg47RgSmbhVbTK209Nc3O9DPN0tnyUr3z9qDgynFYMgRUNngt39Jy4Nw"
const SECRET_KEY = "oWLdJW3w4mGguaJHItsWBYoEWelcwwaJt5riUFIpXabDsTy8Tw4qfr58kQHGbPD7LFZAbkmww02kon4FSckA"
const SYMBOL = "BTC-USDT";
const LEVERAGE = 50; // 50x leverage
let INITIAL_EQUITY_PERCENTAGE = 0.01; // 1% of equity for the first trade
const MARTINGALE_MULTIPLIER = 1.5; // Double the position size for subsequent Martingale entries
const MAX_MARTINGALE_ENTRIES = 5; // Maximum additional martingale entries after initial trade (e.g., 5 means initial + 5 martingales)
const EXIT_ROI_THRESHOLD = -0.10; // Position liquidation threshold when ROI <= -10%

// Fee percentages (as decimals)
const FEE_LIMIT = 0.000064; // 0.0064%
const FEE_MARKET = 0.00016;  // 0.016%

// Take Profit / Martingale Entry Logic Percentages (as decimals)
const INITIAL_TAKE_PROFIT_PERCENTAGE = 0.00032; // 0.032% (Market buy price * (1 + 0.032%))
const MARTINGALE_DROP_FEE_MULTIPLIER = 7; // Drop by (Limit Fee * 5) for Martingale limit buy
const MARTINGALE_TAKE_PROFIT_FEE_MULTIPLIER = 1.3; // Take profit at (Avg Buy Price * (1 + Limit Fee * 2))
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

/**
 * 주문 상태 캐시 시스템 클래스
 */
/**
 * 고급 주문 캐시 관리 클래스
 * 특징:
 * - TTL + 이벤트 기반 이중 무효화 시스템
 * - 오류 복구 및 자동 갱신 메커니즘
 * - 상태 변경 감지 및 지능형 캐싱
 */
class OpenOrdersCache {
    constructor() {
        this.cache = new Map();
        this.statusIndex = new Map(); // 상태별 인덱스: {status -> orderIds}
        this.duplicateHash = new Map(); // 중복 검사용 해시: {normalizedParams -> timestamp}
        this.lastUpdated = 0;
        this.cacheTTL = 30000; // 기본 30초 캐시 유지
        this.errorCount = 0;
        this.maxErrorsBeforeReset = 3; // 연속 오류 시 자동 리셋
        this.cacheStats = { // 캐시 히트율 통계
            hits: 0,
            misses: 0,
            lastReset: Date.now()
        };
    }

    /**
     * 캐시 무효화 필요 여부 확인 (지능형 검사)
     * @returns {boolean} 갱신 필요 시 true
     */
    needsRefresh() {
        const timeBased = Date.now() - this.lastUpdated > this.cacheTTL;
        const errorBased = this.errorCount >= this.maxErrorsBeforeReset;
        return timeBased || errorBased;
    }

    /**
     * 캐시 무효화 (강제 및 선택적)
     * @param {boolean} [fullReset=false] 완전 초기화 여부
     */
    invalidate(fullReset = false) {
        if (fullReset) {
            this.cache.clear();
            this.statusIndex.clear();
            this.lastUpdated = 0;
            this.errorCount = 0;
            console.log('[Cache] Full cache reset executed');
        } else {
            this.lastUpdated = 0; // 다음 요청 시 갱신 유도
            console.log('[Cache] Cache marked for refresh');
        }
    }

    /**
     * 단일 주문 업데이트 (상태 변경 감지 포함)
     * @param {object} orderData 주문 데이터
     * @returns {boolean} 상태 변경이 발생했는지 여부
     */
    updateOrder(orderData) {
        if (!orderData || !orderData.s || !orderData.X) return false;

        const orderId = orderData.i.toString();
        const existing = this.cache.get(orderId);
        const newStatus = orderData.X;
        
        // 기존 상태 인덱스 업데이트
        if (existing) {
            const prevStatus = existing.status;
            if (prevStatus !== newStatus) {
                this.#updateStatusIndex(orderId, prevStatus, newStatus);
            }
        }

        // 주문 데이터 업데이트
        const order = {
            symbol: orderData.s,
            side: orderData.S,
            type: orderData.o,
            status: newStatus,
            price: parseFloat(orderData.p),
            quantity: parseFloat(orderData.q),
            isMartingale: orderData.m,
            timestamp: orderData.T,
            lastUpdated: Date.now()
        };
        
        this.cache.set(orderId, order);
        if (!existing) {
            this.#updateStatusIndex(orderId, null, newStatus);
        }
        
        return existing?.status !== newStatus;
    }

    /**
     * 배치 주문 업데이트 (최적화된 처리)
     * @param {Array} orders 주문 리스트
     * @param {boolean} [incremental=false] 증분 업데이트 여부
     */
    updateAll(orders, incremental = false) {
        if (!incremental) {
            this.cache.clear();
            this.statusIndex.clear();
        }

        const batchUpdate = {};
        orders.forEach(order => {
            const orderId = order.orderId.toString();
            const orderStatus = order.status || 'UNKNOWN';
            
            batchUpdate[orderId] = {
                symbol: order.symbol,
                side: order.side,
                type: order.type,
                status: orderStatus,
                price: parseFloat(order.price),
                quantity: parseFloat(order.origQty),
                isMartingale: order.isMartingale,
                timestamp: order.time,
                lastUpdated: Date.now()
            };
            
            this.#updateStatusIndex(orderId,
                incremental ? this.cache.get(orderId)?.status : null,
                orderStatus);
        });

        Object.entries(batchUpdate).forEach(([k, v]) => this.cache.set(k, v));
        this.lastUpdated = Date.now();
        this.errorCount = 0; // 성공 시 오류 카운터 리셋
    }

    // 비공개 메소드: 상태 인덱스 관리
    #updateStatusIndex(orderId, oldStatus, newStatus) {
        if (oldStatus) {
            const orders = this.statusIndex.get(oldStatus);
            if (orders) {
                const index = orders.indexOf(orderId);
                if (index !== -1) orders.splice(index, 1);
            }
        }
        if (newStatus) {
            if (!this.statusIndex.has(newStatus)) {
                this.statusIndex.set(newStatus, []);
            }
            this.statusIndex.get(newStatus).push(orderId);
        }
    }

    /**
     * 주문 조회 (성능 최적화 버전)
     * @param {string} orderId 주문 ID
     * @returns {object|null} 주문 정보 또는 null
     */
    getOrder(orderId) {
        return this.cache.get(orderId.toString()) || null;
    }

    /**
     * 심볼별 주문 리스트 조회 (필터링 지원)
     * @param {string} symbol 심볼
     * @param {string} [statusFilter] 상태 필터
     * @returns {Array} 주문 리스트
     */
    getOrdersBySymbol(symbol, statusFilter) {
        let orders = Array.from(this.cache.values())
            .filter(o => o.symbol === symbol);
            
        if (statusFilter) {
            orders = orders.filter(o => o.status === statusFilter);
        }
        return orders;
    }

    /**
     * 주문 파라미터 정규화 (소수점 8자리 반올림, 대문자 변환)
     * @param {object} orderParams 주문 파라미터
     * @returns {string} 정규화된 해시 키
     */
    #normalizeParams(orderParams) {
        // 시장가 주문(MARKET)의 경우 price를 해시 키에서 제외하거나, 0으로 고정하여 중복 체크를 피합니다.
        // 현재는 isDuplicate에서 MARKET 주문을 건너뛰므로, 여기서는 기본 동작을 유지합니다.
        return [
            orderParams.symbol.toUpperCase(),
            orderParams.side.toUpperCase(),
            orderParams.type.toUpperCase(),
            Number(orderParams.price?.toFixed(8) || 0), 
            Number(orderParams.quantity.toFixed(8))
        ].join('|');
    }
    /**
     * 중복 주문 확인 (향상된 검증 로직)
     * @param {object} orderParams 주문 파라미터
     * @param {number} [timeWindow=60000] 중복 검사 시간 창 (기본 60초)
     * @returns {boolean} 중복 여부
     */
    isDuplicate(orderParams, timeWindow = 60000) {
        // MARKET 타입의 주문은 항상 중복 검사를 건너뜀 (매번 새로운 주문으로 간주)
        if (orderParams.type === 'MARKET') {
            this.cacheStats.misses++; 
            return false;
        }

        const hashKey = this.#normalizeParams(orderParams);
        const existing = this.duplicateHash.get(hashKey);
        const now = Date.now();
        
        if (existing && (now - existing) < timeWindow) {
            this.cacheStats.hits++;
            return true;
        }
        
        this.duplicateHash.set(hashKey, now);
        this.cacheStats.misses++;
        return false;
    }

    /**
     * 캐시 통계 조회
     * @returns {object} 캐시 히트율 통계
     */
    getCacheStats() {
        const total = this.cacheStats.hits + this.cacheStats.misses;
        return {
            ...this.cacheStats,
            hitRate: total > 0 ? (this.cacheStats.hits / total).toFixed(4) : 0,
            windowDuration: Date.now() - this.cacheStats.lastReset
        };
    }

    /**
     * 오류 핸들링 메소드
     * @param {Error} error 발생한 오류 객체
     */
    handleError(error) {
        console.error('[Cache Error]', error.message);
        this.errorCount++;
        if (this.errorCount >= this.maxErrorsBeforeReset) {
            this.invalidate(true);
            console.warn('[Cache] Auto-reset triggered due to repeated errors');
        }
    }
}

const ordersCache = new OpenOrdersCache();
// Volume tracking
let volumeStats = {
    lastMinute: 0,
    last5Minutes: 0,
    lastHour: 0,
    lastMinuteUSDT: 0, 
    last5MinutesUSDT: 0, 
    lastHourUSDT: 0,   
    totalBTC: 0,       
    totalUSDT: 0,      
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
    
    const maxRetries = 3;
    let retries = 0;
    const baseDelay = 1000; // 초기 지연 시간 1초
    
    while (retries <= maxRetries) {
        try {
            const timestamp = Date.now();
            let queryString = '';
            let requestBody = null;

            if (method === 'GET' || method === 'DELETE') {
                const allParams = { ...params, timestamp };
                if (needsSignature) {
                    queryString = createQueryString(allParams);
                    const signature = generateSignature(queryString, SECRET_KEY);
                    queryString += `&signature=${signature}`;
                } else {
                    queryString = createQueryString(allParams);
                }
            } else { // POST
                const allParams = { ...params, timestamp };
                queryString = createQueryString(allParams);
                if (needsSignature) {
                    const signature = generateSignature(queryString, SECRET_KEY);
                    queryString += `&signature=${signature}`;
                }
            }

            const url = `${API_BASE_URL}${path}${queryString ? '?' + queryString : ''}`;
            const headers = {
                'X-BX-APIKEY': API_KEY,
            };

            const response = await axios({
                method: method,
                url: url,
                headers: headers,
                data: method === 'POST' ? requestBody : null,
            });
            
            // listenKey 엔드포인트 특별 처리
            if (path === '/openApi/user/auth/userDataStream') {
                if (response.data.listenKey) {
                    return response.data;
                }
                throw new Error('Failed to create listenKey: ' + JSON.stringify(response.data));
            }

            if (response.data.code !== 0) {
                throw new Error(`API Error: ${response.data.msg} (Code: ${response.data.code})`);
            }
            return response.data.data;
            
        } catch (error) {
            if (retries >= maxRetries) {
                console.error(`API 요청 실패 (${maxRetries}회 재시도):`, error.message);
                throw error;
            }
            
            // 지수 백오프 + jitter 적용 (최대 지연 시간의 25% 범위에서 랜덤 조정)
            const delay = baseDelay * Math.pow(2, retries) * (0.75 + Math.random() * 0.25);
            console.warn(`API 요청 실패 (${retries + 1}/${maxRetries} 재시도), ${Math.round(delay)}ms 후 재시도:`, error.message);
            
            await new Promise(resolve => setTimeout(resolve, delay + (retries * 50))); // 추가 지연 차등 적용
            retries++;
            
            // 2회 재시도 이후 캐시 강제 갱신
            if (retries >= 2) {
                ordersCache.invalidate(true);
                console.warn('Forced cache refresh due to repeated API errors');
            }
        }
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
    
    // Prevent duplicate orders with detailed logging
    const orderParams = { symbol, side, positionSide, type, price, quantity };
    console.log('[DEBUG] Checking for duplicate order with params:', orderParams); // 주문 파라미터 로깅
    // MARKET 타입 주문에 대해서는 중복 검사를 건너뜁니다.
    if (type !== 'MARKET' && ordersCache.isDuplicate(orderParams)) { // MARKET 타입에 대한 중복 검사 건너뛰기
        const cacheStats = ordersCache.getCacheStats();
        console.warn(`Duplicate order prevented (Hit Rate: ${(cacheStats.hitRate * 100).toFixed(2)}%)`, {
            orderParams,
            cacheStats
        });
        return { orderId: null, status: 'DUPLICATE' };
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

async function getOpenOrders(symbol, filterActive = true) {
    console.log(`Fetching open orders for ${symbol}...`);
    try {
        const openOrdersData = await apiRequest('GET', '/openApi/swap/v2/trade/openOrders', { symbol });
        const orders = openOrdersData.orders || [];
        
        return filterActive ?
            orders.filter(o => o.status === 'NEW' || o.status === 'PARTIALLY_FILLED') :
            orders;
    } catch (error) {
        console.error('Error fetching open orders:', {
            error: error.message,
            symbol: symbol,
            timestamp: Date.now()
        });
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
        // "order not exist" 에러 (코드 109414)는 무시합니다.
        if (error.response?.data?.code === 109414) {
            console.warn(`[WARN] Attempted to cancel order ${orderId} but it did not exist (Code: 109414). Proceeding.`);
            return true;
        }
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

/**
 * 캐시 강제 갱신 유틸리티 함수
 */
async function refreshOrdersCache() {
    try {
        const openOrders = await getOpenOrders(SYMBOL);
        ordersCache.updateAll(openOrders);
        console.log('[Cache] Manual refresh completed');
    } catch (error) {
        ordersCache.handleError(error);
    }
}

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
    
    // Cleanup any pending orders on disconnect
    if (isBotActive) {
        console.log('[WebSocket Cleanup] Cancelling all open orders due to connection loss');
        cancelAllOpenOrdersAndReset(SYMBOL).catch(err => {
            console.error('[WebSocket Cleanup] Error during cleanup:', err);
        });
    }
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
                    messageString = zlib.gunzipSync(data).toString();
                } catch (e) {
                    console.log('[WebSocket] Non-GZIP binary message');
                }
            }

            // Process JSON messages
            if (messageString.startsWith('{') || messageString.startsWith('[')) {
                const message = JSON.parse(messageString);
                lastReceivedMessageTime = Date.now(); // Update last received time
                
                if (message.e === 'ORDER_TRADE_UPDATE') {
                    // 캐시 업데이트 전처리
                    try {
                        const orderData = message.o;
                        if (orderData && orderData.i) {
                            ordersCache.updateOrder(orderData);
                            
                            // 주문 완료/취소 시 캐시 무효화
                            if (['FILLED', 'CANCELED', 'EXPIRED'].includes(orderData.X)) {
                                ordersCache.invalidate();
                            }
                        }
                    } catch (cacheError) {
                        console.error('[CACHE] Error updating order cache:', cacheError);
                        ordersCache.invalidate();
                    }
                    
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

/**
 * 웹소켓 메시지 처리 (강화된 캐시 관리 로직)
 * @param {object} message 웹소켓 메시지
 * @returns {Promise<void>}
 */
async function handleWebSocketMessage(message) {
    try {
        // 캐시 가용성 검사
        if (!ordersCache || ordersCache.errorCount >= ordersCache.maxErrorsBeforeReset) {
            console.warn('[Cache] Cache system unavailable, forcing refresh');
            await refreshOrdersCache();
            return;
        }
        // 'ORDER_TRADE_UPDATE' 메시지 처리
        if (message.e === 'ORDER_TRADE_UPDATE') {
            const orderData = message.o;
            
            // 주문 유효성 검사
            if (!orderData.s || orderData.s !== SYMBOL) {
                console.warn('Received order update for different symbol:', orderData.s);
                return;
            }
            
            if (orderData.X === 'FILLED') {
                const currentPrice = await getCurrentBtcPrice();
                console.log(`[Order Filled] ${orderData.S} ${orderData.o} ${orderData.q} @ ${orderData.p}`);

                // 캐시 업데이트
                const statusChanged = ordersCache.updateOrder(orderData);
                console.log(`Order Update [${orderData.X}${statusChanged ? ', STATUS CHANGED' : ''}]:`, {
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
                    currentMarketPrice: currentPrice
                });

                // 가격 검증
                const filledPrice = parseFloat(orderData.p);
                let expectedPrice = lastMarketBuyPrice;
                if (orderData.o === 'MARKET' && orderData.S === 'BUY') {
                    expectedPrice = lastMarketBuyPrice * (1 + BASE_SLIPPAGE_PERCENT * 2);
                } else if (orderData.o === 'LIMIT' && orderData.S === 'BUY') {
                    expectedPrice = lastMartingaleBuyPrice * (1 - (FEE_LIMIT * MARTINGALE_DROP_FEE_MULTIPLIER));
                }
                if (expectedPrice > 0) {
                    const priceDifference = Math.abs((filledPrice - expectedPrice) / expectedPrice);
                    if (priceDifference > BASE_SLIPPAGE_PERCENT * 2) {
                        console.warn(`Large price deviation detected: ${(priceDifference * 100).toFixed(2)}%`);
                        currentMartingaleLevel = Math.min(currentMartingaleLevel, 2);
                        console.log(`Martingale level reduced to ${currentMartingaleLevel} due to price deviation`);
                    }
                }

                // 1. 최초 진입(시장가 매수) 체결 시
                if (orderData.o === 'MARKET' && orderData.S === 'BUY') {
                    console.log('Initial market buy order filled.');
                    lastMarketBuyPrice = parseFloat(orderData.p);
                    currentPosition.quantity = parseFloat(orderData.q);
                    currentPosition.averageEntryPrice = lastMarketBuyPrice;
                    currentPosition.entryValueUSD = currentPosition.quantity * lastMarketBuyPrice;
                    currentPosition.side = 'LONG';

                    // 볼륨 통계 업데이트
                    const tradeQty = parseFloat(orderData.q);
                    const tradePrice = parseFloat(orderData.p) || priceCache.value;
                    ordersCache.updateOrder({
                        ...orderData,
                        X: 'FILLED'
                    });
                    
                    volumeStats.trades.push({
                        quantity: tradeQty,
                        price: tradePrice,
                        time: Date.now()
                    });
                    updateVolumeStats();

                    // 시장가 매수 주문의 후속 주문 설정은 executeInitialMarketBuy에서 직접 처리되므로, 여기서 중복 호출하지 않습니다.
                    // 이 로직은 시장가 주문이 체결된 후 포지션 정보를 업데이트하는 데 중점을 둡니다.
                   
                // 마틴게일 매수 체결 처리
                } else if (orderData.o === 'LIMIT' && orderData.S === 'BUY') {
                    await handleMartingaleBuyFill(orderData);

                // 3. 익절(SELL/LONG LIMIT) 체결 시
                } else if ( 
                    (orderData.o === 'LIMIT' && orderData.S === 'SELL') ||
                    (orderData.o === 'TAKE_PROFIT_MARKET' && orderData.S === 'SELL')
                ) {
                    console.log('Take profit order filled. Trade cycle completed.');

                    // 볼륨 통계 업데이트
                    const tradeQty = parseFloat(orderData.q);
                    const tradePrice = parseFloat(orderData.p) || priceCache.value;
                    ordersCache.updateOrder({
                        ...orderData,
                        X: 'FILLED'
                    });
                    
                    volumeStats.trades.push({
                        quantity: tradeQty,
                        price: tradePrice,
                        time: Date.now()
                    });
                    updateVolumeStats();

                    // 익절 완료 후 전체 사이클 재시작
                    await finalizeCycleAndRestart();
                }
            } else if (
                orderData.X === 'CANCELED' ||
                orderData.X === 'REJECTED' ||
                orderData.X === 'EXPIRED'
            ) {
                console.log(`Order ${orderData.i} was ${orderData.X}.`);
                // 해당 주문이 마틴게일 매수 주문이었을 경우에만 null 처리
                if (currentPosition.martingaleBuyOrderId && orderData.i.toString() === currentPosition.martingaleBuyOrderId.toString()) {
                    currentPosition.martingaleBuyOrderId = null;
                }
                // 필요시 재주문/알림 처리 (여기서는 추가적인 액션 없음)
            }
        } else if (message.e === 'ACCOUNT_UPDATE') { 
            console.log('Account Update:', message);
        } else if (message.e === 'listenKeyExpired') {
            console.error('ListenKey expired. Attempting to refresh and reconnect WebSocket.');
            activeListenKey = null;
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
    } catch (error) {
        console.error('[handleWebSocketMessage] Error processing message:', error.message);
    }
}

async function cancelAllOpenOrdersAndReset(symbol) {
    if (isCancellingOrders) {
        console.log('[Order Cleanup] Operation already in progress');
        return;
    }

    isCancellingOrders = true;
    
    try {
        console.log(`[Order Cleanup] Starting cleanup for ${symbol}`);
        
        // 1단계: 모든 미체결 주문 일괄 취소 시도
        const bulkCancelSuccess = await cancelAllOpenOrders(symbol);
        if (!bulkCancelSuccess) {
            console.warn('[Order Cleanup] Bulk cancellation failed or partially failed. Proceeding with individual checks.');
        }
        
        // 2단계: 여전히 남아있는 주문 개별적으로 확인 및 취소 (최대 5회 재시도)
        let ordersRemaining = await getOpenOrders(symbol);
        let retryCount = 0;
        const MAX_RETRY_COUNT = 5;
        while (ordersRemaining.length > 0 && retryCount < MAX_RETRY_COUNT) {
            console.warn(`[Order Cleanup] ${ordersRemaining.length} orders still remain after cancellation. Attempting individual cancellation (retry ${retryCount + 1}/${MAX_RETRY_COUNT})...`);
            await Promise.allSettled(
                ordersRemaining.map(order => cancelOrder(symbol, order.orderId))
            );
            await new Promise(resolve => setTimeout(resolve, 500)); // 짧은 지연 시간
            ordersRemaining = await getOpenOrders(symbol);
            retryCount++;
        }

        if (ordersRemaining.length > 0) {
            console.error(`[Order Cleanup] CRITICAL: ${ordersRemaining.length} orders still remain after multiple cancellation attempts. Manual intervention may be required.`);
            // 여기서는 봇을 멈추지 않고, finalizeCycleAndRestart가 다음 executeInitialMarketBuy를 시도하게끔 합니다.
            // executeInitialMarketBuy 내부에서 openOrders를 다시 확인하여, 완전히 정리되지 않으면 재시도를 유도합니다.
            throw new Error('Failed to clear all open orders during cleanup, but bot will attempt to recover.');
        }

        // 3단계: 포지션 및 마틴게일 관련 상태 변수 초기화
        currentPosition = {
            quantity: 0,
            averageEntryPrice: 0,
            entryValueUSD: 0,
            side: 'LONG',
            positionId: null,
            openOrderId: null,
            takeProfitOrderId: null,
            martingaleBuyOrderId: null
        };
        currentMartingaleLevel = 0;
        lastMarketBuyPrice = 0;
        lastMartingaleBuyPrice = 0;
        ordersCache.duplicateHash.clear(); // 새로운 사이클 시작 시 중복 주문 캐시 초기화

        console.log('[Order Cleanup] Cleanup completed successfully');
    } catch (error) {
        console.error('[Order Cleanup] Failed during cleanup process:', {
            error: error.message,
            stack: error.stack,
            timestamp: Date.now()
        });
        // cleanup 실패 시 봇을 멈추지 않고, finalizeCycleAndRestart가 다음 executeInitialMarketBuy를 시도하게끔 오류를 다시 던집니다.
        throw error; 
    } finally {
        // cleanup 프로세스 완료 여부와 관계없이 lock 해제
        isCancellingOrders = false;
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

/**
 * Updates volume statistics and cleans up old trade data
 */
// Trade price history for volatility calculations
// Price history tracking for volatility calculations
let priceHistory = [];
function updateVolumeStats() {
    const now = Date.now();
    // Clean up trades older than 1 hour
    volumeStats.trades = volumeStats.trades.filter(t => t.time > now - 3600000);

    // Calculate volume for different time frames (BTC)
    volumeStats.lastMinute = volumeStats.trades
        .filter(t => t.time > now - 60000)
        .reduce((sum, t) => sum + t.quantity, 0);

    volumeStats.last5Minutes = volumeStats.trades
        .filter(t => t.time > now - 300000)
        .reduce((sum, t) => sum + t.quantity, 0);

    volumeStats.lastHour = volumeStats.trades
        .filter(t => t.time > now - 3600000) // Changed to 1 hour window
        .reduce((sum, t) => sum + t.quantity, 0);

    // Calculate USDT volume for each period
    volumeStats.lastMinuteUSDT = volumeStats.trades
        .filter(t => t.time > now - 60000)
        .reduce((sum, t) => sum + (t.quantity * (t.price || priceCache.value)), 0);

    volumeStats.last5MinutesUSDT = volumeStats.trades
        .filter(t => t.time > now - 300000)
        .reduce((sum, t) => sum + (t.quantity * (t.price || priceCache.value)), 0);

    volumeStats.lastHourUSDT = volumeStats.trades
        .filter(t => t.time > now - 3600000) // Changed to 1 hour window
        .reduce((sum, t) => sum + (t.quantity * (t.price || priceCache.value)), 0);

    // 누적 전체 거래량 (BTC, USDT)
    volumeStats.totalBTC = volumeStats.trades.reduce((sum, t) => sum + t.quantity, 0);
    volumeStats.totalUSDT = volumeStats.trades.reduce((sum, t) => sum + (t.quantity * (t.price || priceCache.value)), 0);

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
    console.log('\x1b[36m%s\x1b[0m', `=== 거래량 통계 (BTC/USDT) ===`);
    console.log(`1분:   ${volumeStats.lastMinute.toFixed(4)} BTC / ${volumeStats.lastMinuteUSDT.toFixed(2)} USDT`);
    console.log(`5분:   ${volumeStats.last5Minutes.toFixed(4)} BTC / ${volumeStats.last5MinutesUSDT.toFixed(2)} USDT`);
    console.log(`1시간: ${volumeStats.lastHour.toFixed(4)} BTC / ${volumeStats.lastHourUSDT.toFixed(2)} USDT`);
    console.log('-------------------------------');
    console.log(`누적:  ${volumeStats.totalBTC.toFixed(4)} BTC / ${volumeStats.totalUSDT.toFixed(2)} USDT`);
    console.log('\x1b[36m%s\x1b[0m', `===============================`);
}

async function executeInitialMarketBuy() {
    if (isCancellingOrders || isCoolingDown) {
        const reason = isCancellingOrders ? 'order cancellation in progress' : 'cooling down after high volatility';
        console.log(`Skipping market buy - ${reason}`);
        return;
    }

    // 거래 시작 전 open order(특히 open long)이 남아있으면 반드시 모두 취소
    try {
        let openOrders = await getOpenOrders(SYMBOL);
        let attempts = 0;
        // cleanup 이 완전히 끝날 때까지 대기
        while (openOrders.length > 0 && attempts < 5) {
            console.log(`[SYNC] Found ${openOrders.length} open orders before new cycle. Retrying cancellation...`);
            // cancelAllOpenOrdersAndReset 내부에서 모든 상태 초기화 및 재시도를 처리하므로 여기서 직접 return 하지 않습니다.
            await cancelAllOpenOrdersAndReset(SYMBOL); 
            openOrders = await getOpenOrders(SYMBOL); // 재확인
            attempts++;
            await new Promise(resolve => setTimeout(resolve, 500)); // API 과부하 방지를 위한 짧은 지연
        }
        if (openOrders.length > 0) {
            console.error('[SYNC] 거래 시작 전 open order 정리 실패. 다음 사이클 시도 중단.');
            // 모든 주문이 정리되지 않은 상태이므로, 이 함수를 다시 실행해도 의미가 없을 수 있습니다.
            // 봇의 watchdog 타이머가 initializeBot을 다시 호출하여 클린 상태에서 재시도하게끔 합니다.
            throw new Error('Failed to clear all open orders before starting new cycle.');
        }
    } catch (err) {
        console.error('[SYNC] 거래 시작 전 open order 정리 중 에러:', err.message);
        throw err; // 에러를 상위 호출자로 전파하여 initializeBot의 재시도 로직이 작동하게 합니다.
    }

    // Check current volatility before proceeding
    const currentVolatility = calculateRecentVolatility();
    if (currentVolatility > MAX_VOLATILITY_THRESHOLD) {
        console.warn(`Volatility too high (${(currentVolatility*100).toFixed(2)}%), entering cooldown`);
        activateCooldown(currentVolatility);
        return;
    }

    // Additional check for consecutive volatility spikes
    if (Date.now() - lastVolatilityAlert < BASE_COOLDOWN_PERIOD * 2) {
        console.warn('Recent volatility alerts detected, extending cooldown');
        activateCooldown(BASE_COOLDOWN_PERIOD * 2);
        return;
    }
    console.log('Executing initial market buy (동기적 open long/close long)...');
    try {
        const quantity = 0.0001; // Fixed quantity for initial entry

        // 1. open long(시장가 매수) 주문
        console.log(`[SYNC] Placing initial market buy for ${quantity} ${SYMBOL}`);
        const order = await placeOrder(
            SYMBOL,
            'BUY',
            'LONG',
            'MARKET',
            quantity
        );
        // ordersCache.isDuplicate를 MARKET 타입에 대해 건너뛰도록 수정했으므로, 이제 DUPLICATE는 발생하지 않을 것입니다.
        if (!order) { 
            console.error(`[SYNC] Failed to place initial market buy order.`);
            // 주문 실패 시 예외를 던져 runBotCycle에서 에러 처리 및 재시도 로직이 작동하도록 합니다.
            throw new Error(`Failed to place initial market buy order.`);
        }
        currentPosition.openOrderId = order.orderId;
        console.log('[SYNC] Initial market buy order placed:', order);

        // 1단계(시장가 매수 주문)가 성공적으로 제출되었으므로, 바로 2단계(익절/마틴게일 주문)를 진행합니다.
        console.log('[SYNC] Market Buy order submitted. Proceeding to place Take Profit and Martingale orders simultaneously.');
        
        // 시장가 주문은 제출 직후 체결될 가능성이 높으므로, 현재 시장가를 기준으로 포지션 정보를 초기 업데이트합니다.
        // 정확한 체결 가격은 웹소켓 메시지(handleWebSocketMessage)에서 FILLED 이벤트를 통해 업데이트됩니다.
        const currentMarketPriceAtSubmission = await getCurrentBtcPrice();
        if (currentMarketPriceAtSubmission === 0) {
            console.warn('[SYNC] 현재 시장가 정보를 가져올 수 없어 후속 주문을 진행하지 않습니다.');
            throw new Error('Could not fetch current market price for initial position setup.');
        }

        lastMarketBuyPrice = currentMarketPriceAtSubmission; // 초기 시장가로 설정
        currentPosition.quantity = quantity; // 시장가 주문 수량으로 초기 설정
        currentPosition.averageEntryPrice = currentMarketPriceAtSubmission; // 현재 시장가로 초기 설정
        currentPosition.entryValueUSD = currentPosition.quantity * currentPosition.averageEntryPrice;
        currentPosition.side = 'LONG';
        
        await placeInitialFollowUpOrders(); // 즉시 후속 주문 실행

    } catch (error) {
        console.error('[SYNC] 초기 시장가 매수 주문 또는 후속 주문 실행 중 오류 발생:', error.message);
        throw error; // 에러를 상위 호출자로 전파
    }
}

async function placeInitialFollowUpOrders() { // syncOnlyCloseLong 파라미터 제거
    if (isCancellingOrders) {
        console.log('Skipping follow-up orders - order cancellation in progress');
        return;
    }
    
    // 기존 주문 개수 확인
    const initialOpenOrders = await getOpenOrders(SYMBOL);
    if (initialOpenOrders.length > 0) {
        console.error(`[ORDER VALIDATION] Found ${initialOpenOrders.length} open orders before placing follow-ups`);
        await cancelAllOpenOrdersAndReset(SYMBOL);
    }

    console.log('Placing take profit and initial martingale buy orders simultaneously...');
    try {
        const recentVolatility = calculateRecentVolatility();
        const dynamicFeeMultiplier = Math.min(
            MARTINGALE_DROP_FEE_MULTIPLIER * (1 + recentVolatility * 2),
            MARTINGALE_DROP_FEE_MULTIPLIER * 3
        );

        // 익절 가격 계산 (FEE_LIMIT의 2배로 고정)
        const takeProfitPrice = adjustPricePrecision(
            currentPosition.averageEntryPrice * (1 + FEE_LIMIT * 2)
        );
        console.log('[SYNC] Take profit order calculation:', {
            basePrice: currentPosition.averageEntryPrice,
            takeProfitPrice: takeProfitPrice,
            volatility: recentVolatility,
            feeMultiplier: 2 * (1 - recentVolatility)
        });

        // 마틴게일 진입 가격 계산 (lastMarketBuyPrice 기준, FEE_LIMIT의 7배 드롭)
        const martingaleBuyPrice = adjustPricePrecision(
            lastMarketBuyPrice * (1 - FEE_LIMIT * 7)
        );
        console.log('Martingale buy order calculation:', {
            basePrice: lastMarketBuyPrice,
            martingalePrice: martingaleBuyPrice,
            volatility: recentVolatility,
            feeMultiplier: dynamicFeeMultiplier
        });

        // 익절 주문과 마틴게일 주문을 동시에 제출
        const [tpOrder, mbOrder] = await Promise.all([
            placeOrder(
                SYMBOL,
                'SELL',
                'LONG',
                'LIMIT',
                currentPosition.quantity,
                takeProfitPrice
            ),
            placeOrder(
                SYMBOL,
                'BUY',
                'LONG',
                'LIMIT',
                currentPosition.quantity * MARTINGALE_MULTIPLIER,
                martingaleBuyPrice
            )
        ]);

        let ordersSuccessfullyPlaced = 0;
        if (tpOrder) {
            currentPosition.takeProfitOrderId = tpOrder.orderId;
            console.log('[SYNC] Take profit order placed:', {
                orderId: tpOrder.orderId,
                price: takeProfitPrice,
                quantity: currentPosition.quantity,
                volatility: recentVolatility
            });
            ordersSuccessfullyPlaced++;
        } else {
            console.error('[SYNC] Failed to place take profit order');
        }

        if (mbOrder) {
            currentPosition.martingaleBuyOrderId = mbOrder.orderId;
            // currentMartingaleLevel은 체결 시에만 증가합니다.
            console.log('Martingale buy order placed:', {
                orderId: mbOrder.orderId,
                price: martingaleBuyPrice,
                quantity: currentPosition.quantity * MARTINGALE_MULTIPLIER,
                // martingaleLevel: currentMartingaleLevel, // 여기서 레벨을 설정하지 않습니다.
                volatility: recentVolatility
            });
            ordersSuccessfullyPlaced++;
        } else {
            console.error('Failed to place martingale buy order');
        }

        if (ordersSuccessfullyPlaced !== 2) {
            throw new Error(`Expected 2 orders but placed ${ordersSuccessfullyPlaced}. Aborting cycle to re-evaluate.`);
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
        console.log('[WARN] Skipping martingale orders - order cancellation in progress');
        return;
    }
    
    console.log('[DEBUG] Starting next martingale stage:', {
        currentLevel: currentMartingaleLevel,
        maxLevel: MAX_MARTINGALE_ENTRIES
    });
    
    try {
        // 1. Cancel all existing open orders with detailed logging
        console.log('[DEBUG] Cancelling all open orders for new martingale stage');
        try {
            await cancelAllOpenOrdersAndReset(SYMBOL);
            console.log('[DEBUG] Cancel all orders result: success');
        } catch (cancelErr) {
            console.error('[ERROR] Failed to cancel all open orders before martingale stage:', cancelErr);
            // 실패 시 이후 단계로 진행하지 않음
            return;
        }

        // 2. Get current position details from exchange
        const exchangePosition = await getCurrentPosition(SYMBOL);
        if (!exchangePosition) {
            console.error('[ERROR] No current position found for martingale');
            return;
        }
        
        // Update current position state with consistency checks
        console.log('[DEBUG] Updating position state:', {
            previousQuantity: currentPosition.quantity,
            newQuantity: exchangePosition.quantity,
            previousPrice: currentPosition.averageEntryPrice,
            newPrice: exchangePosition.averageEntryPrice
        });
        
        currentPosition.quantity = exchangePosition.quantity;
        currentPosition.averageEntryPrice = exchangePosition.averageEntryPrice;
        currentPosition.entryValueUSD = currentPosition.quantity * currentPosition.averageEntryPrice;
        
        // 3. Calculate take profit price with detailed logging
        // FEE_LIMIT의 2배로 익절 가격 고정
        const takeProfitPrice = adjustPricePrecision(
            currentPosition.averageEntryPrice * (1 + FEE_LIMIT * 2)
        );
        
        console.log('[DEBUG] Take profit calculation:', {
            entryPrice: currentPosition.averageEntryPrice, 
            feeMultiplier: MARTINGALE_TAKE_PROFIT_FEE_MULTIPLIER,
            calculatedPrice: takeProfitPrice
        });

        // Cancel any existing take profit orders
        if (currentPosition.takeProfitOrderId) {
            console.log('[DEBUG] Cancelling existing take profit order:', currentPosition.takeProfitOrderId);
            await cancelOrder(SYMBOL, currentPosition.takeProfitOrderId);
        }
        
        // Place take profit order
        console.log('[DEBUG] Placing take profit order:', {
            quantity: currentPosition.quantity,
            price: takeProfitPrice
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
            console.log('[DEBUG] Take profit order placed:', {
                orderId: tpOrder.orderId,
                price: takeProfitPrice,
                quantity: currentPosition.quantity
            });
        }

        // 4. Calculate next martingale buy parameters
        // First calculate the required variables before margin check
        // FEE_LIMIT의 7배로 마틴게일 진입 가격 고정
        const nextBuyPrice = adjustPricePrecision(
            currentPosition.averageEntryPrice * (1 - FEE_LIMIT * 7)
        );
        
        const nextBuyQuantity = currentPosition.quantity * MARTINGALE_MULTIPLIER;
        const requiredMargin = nextBuyQuantity * nextBuyPrice / LEVERAGE;
        const currentBalance = await getAccountBalance();
        
        console.log('[DEBUG] Martingale buy parameters:', {
            nextBuyPrice: nextBuyPrice,
            nextBuyQuantity: nextBuyQuantity,
            requiredMargin: requiredMargin,
            currentBalance: currentBalance
        });
        
        // Check if we can proceed to next martingale level
        if (currentMartingaleLevel < MAX_MARTINGALE_ENTRIES && currentBalance > requiredMargin * 2) {
            
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
            } else {
                console.error('[MARTINGALE] 다음 마틴게일 매수 주문 실패. 봇 사이클 재평가 필요.');
                throw new Error('Failed to place next martingale buy order.');
            }
        } else {
            console.log('[MARTINGALE] 최대 마틴게일 레벨에 도달했습니다. 익절 또는 청산을 기다립니다.');
        }
    } catch (error) {
        console.error('[ERROR] 다음 마틴게일 주문 처리 중 오류 발생:', error);
        throw error;
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
        console.error('Error in bot cycle:', error.message);
        // runBotCycle 실패 시 봇을 비활성화하지 않고, initializeBot의 watchdog이 재시도하도록 에러를 다시 던집니다.
        throw error;
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
                console.error('Error starting trading cycle (runBotCycle failed):', error.message);
                if (retries < maxRetries) {
                    retries++;
                    const delay = Math.min(1000 * retries, 5000);
                    console.log(`Retrying cycle start in ${delay}ms (attempt ${retries}/${maxRetries})`);
                    setTimeout(startCycle, delay);
                } else {
                    console.error('Maximum retries for starting trading cycle reached. Bot stopping.');
                    isBotActive = false;
                }
            }
        };
        console.log('API 요청 제한 회피를 위해 초기 실행 전 1초 대기');
        await new Promise(resolve => setTimeout(resolve, 1000));
        startCycle();
    } catch (error) {
        console.error('Error initializing bot:', error.message);
        // Enhanced restart logic with exponential backoff
        const delay = Math.min(10000 * (1 + Math.random()), 30000); // Random delay up to 30s
        console.log(`Attempting to reinitialize bot in ${Math.round(delay/1000)} seconds...`);
        setTimeout(() => {
            initializeBot();
        }, delay);
    }
}

/**
 * 마틴게일 매수 주문 체결 처리
 * @param {object} orderData - 체결된 주문 데이터
 */
async function handleMartingaleBuyFill(orderData) {
    console.log('Martingale buy order filled.');
    lastMartingaleBuyPrice = parseFloat(orderData.p);
    currentMartingaleLevel++;

    // 볼륨 통계 업데이트
    const tradeQty = parseFloat(orderData.q);
    const tradePrice = parseFloat(orderData.p) || priceCache.value;
    volumeStats.trades.push({ quantity: tradeQty, price: tradePrice, time: Date.now() });
    updateVolumeStats();

    // 1. 기존 주문 정리 (모든 미체결 주문을 취소하고 상태 변수를 초기화)
    console.log('[STRICT] 마틴게일 체결 - 모든 기존 주문 정리 및 상태 초기화 시작');
    try {
        await cancelAllOpenOrdersAndReset(SYMBOL);
        console.log('[STRICT] 모든 기존 주문 및 상태 초기화 완료.');
    } catch (err) {
        console.error('[STRICT] 마틴게일 체결 후 기존 주문 정리 실패. 봇 사이클 재평가 필요:', err);
        throw err; // 오류를 다시 던져 상위 호출자가 처리하도록 함
    }
    
    // 2. 포지션 정보 갱신
    await updatePositionFromExchange();
    
    // 3. 새 익절 주문 설정 (물타기 단계에서 익절 가격 조정 및 주문)
    await placeNewTakeProfitOrder();

    // 4. 다음 마틴게일 진입 주문 설정 (필요시)
    if (currentMartingaleLevel < MAX_MARTINGALE_ENTRIES) {
        await placeNextMartingaleStageOrders();
    } else {
        console.log('[MARTINGALE] Maximum martingale entries reached. Waiting for take profit or liquidation.');
    }
}

/**
 * 거래소에서 최신 포지션 정보 가져오기
 */
async function updatePositionFromExchange() {
    const exchangePosition = await getCurrentPosition(SYMBOL);
    if (exchangePosition) {
        currentPosition.quantity = exchangePosition.quantity;
        currentPosition.averageEntryPrice = exchangePosition.averageEntryPrice;
        currentPosition.entryValueUSD = currentPosition.quantity * currentPosition.averageEntryPrice;
        console.log(`[POSITION] 포지션 업데이트 완료: 수량=${currentPosition.quantity.toFixed(5)}, 평균 진입가=${currentPosition.averageEntryPrice.toFixed(2)}`);
    } else {
        console.warn('[POSITION] 현재 활성 포지션이 없습니다.');
        // 포지션이 없을 경우, 봇 상태를 초기화할지 여부 결정 필요
        // 여기서는 강제로 초기화하지 않고, 상위 로직에서 판단하도록 함.
        // 예를 들어, runBotCycle에서 포지션이 없으면 initialMarketBuy를 다시 시도하도록 유도할 수 있습니다.
    }
}

/**
 * 새 익절 주문 설정
 */
async function placeNewTakeProfitOrder() {
    // 현재 포지션 정보를 기준으로 익절 가격 계산
    if (currentPosition.quantity <= 0) {
        console.warn('[MARTINGALE] 포지션 수량이 0이므로 새 익절 주문을 설정할 수 없습니다.');
        return; // 포지션이 없으면 익절 주문을 할 필요가 없음
    }

    const newTakeProfitPrice = adjustPricePrecision(
        currentPosition.averageEntryPrice * (1 + (FEE_LIMIT * 2)) // 익절 가격은 평균 진입가 기준
    );
    
    console.log('[MARTINGALE] 새 익절 주문 설정:', {
        수량: currentPosition.quantity,
        가격: newTakeProfitPrice
    });
    
    const tpOrder = await placeOrder(
        SYMBOL,
        'SELL',
        'LONG',
        'LIMIT',
        currentPosition.quantity,
        newTakeProfitPrice
    );
    
    if (tpOrder) {
        currentPosition.takeProfitOrderId = tpOrder.orderId;
        console.log('[MARTINGALE] 익절 주문 완료:', tpOrder.orderId);
    } else {
        console.error('[MARTINGALE] 익절 주문 실패. 봇 사이클 재평가 필요.');
        throw new Error('Failed to place new take profit order.');
    }
}

/**
 * 거래 사이클 완료 처리 및 재시작 (익절 완료 후 전체 사이클을 재시작)
 */
async function finalizeCycleAndRestart() {
    try {
        // 1. 모든 미체결 주문 강제 취소 및 봇 상태 초기화 (확실한 정리)
        console.log('[FINALIZE] 모든 미체결 주문 강제 취소 및 봇 상태 초기화 시작...');
        await cancelAllOpenOrdersAndReset(SYMBOL); // 이 함수는 이미 내부적으로 상태를 초기화합니다.
        console.log('[FINALIZE] 모든 주문 및 상태 초기화 완료.');
        
        // 2. 봇 상태 변수 초기화 (cancelAllOpenOrdersAndReset에서 처리되지만, 명시적으로 다시 확인)
        // INITIAL_EQUITY_PERCENTAGE = 0.01; // 이 값은 초기화 로직에서 변경되지 않아야 함
        // currentMartingaleLevel, lastMarketBuyPrice, lastMartingaleBuyPrice는 cancelAllOpenOrdersAndReset에서 초기화됨
        
        console.log('[FINALIZE] 거래 사이클 완료. 새 사이클 준비 중...');
        
        // 3. 새 거래 사이클 시작
        if (isBotActive) {
            console.log('[FINALIZE] 짧은 지연 후 새 거래 사이클 시작...');
            // 포지션 종료 후 즉시 새로운 사이클 시작을 위해 1초 대기
            await new Promise(resolve => setTimeout(resolve, 1000));
            // executeInitialMarketBuy 호출 시 예외가 발생하면 initializeBot의 재시도 로직이 잡도록 합니다.
            await executeInitialMarketBuy(); // 새로운 사이클의 첫 시장가 매수 주문 실행
        }
    } catch (err) {
        console.error('[FINALIZE] 사이클 마무리 및 재시작 중 오류 발생:', err.message);
        // 에러 발생 시 봇을 비활성화하여 추가적인 문제를 방지
        isBotActive = false;
        console.error('[FINALIZE] 심각한 오류로 인해 봇이 정지되었습니다.');
    }
}

// Start the bot
initializeBot();
