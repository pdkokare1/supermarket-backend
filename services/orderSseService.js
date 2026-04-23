/* services/orderSseService.js */

let redisPub = null;
let redisSub = null;

let adminConnections = [];
let customerConnections = {};

// OPTIMIZATION: Max Connection Thresholds to prevent memory leaks during proxy ungraceful disconnects
const MAX_ADMIN_CONNECTIONS = 150;
const MAX_CUSTOMER_CONNECTIONS = 5;

try {
    const Redis = require('ioredis');
    if (process.env.REDIS_URL) {
        
        // OPTIMIZATION: Applied resilient connection parameters for SSE Redis links
        const redisConfig = {
            maxRetriesPerRequest: null,
            retryStrategy: (times) => Math.min(times * 100, 3000)
        };
        
        redisPub = new Redis(process.env.REDIS_URL, redisConfig);
        redisSub = new Redis(process.env.REDIS_URL, redisConfig);
        
        // OPTIMIZATION: Subscribe to both the legacy stream channel and the new horizontally-scaled operations channel
        redisSub.subscribe('ORDER_STREAM_EVENT', 'DAILYPICK_ORDER_EVENTS');
        
        redisSub.on('message', (channel, message) => {
            if (channel === 'ORDER_STREAM_EVENT') {
                const parsed = JSON.parse(message);
                if (parsed.target === 'admin') {
                    adminConnections.forEach(conn => {
                        if (!conn.destroyed) conn.write(`data: ${parsed.payload}\n\n`);
                    });
                } else if (parsed.target === 'customer' && customerConnections[parsed.orderId]) {
                    customerConnections[parsed.orderId].forEach(conn => {
                        if (!conn.destroyed) conn.write(`data: ${parsed.payload}\n\n`);
                    });
                }
            } 
            // OPTIMIZATION: Bridge core service updates directly to Admin SSE streams
            else if (channel === 'DAILYPICK_ORDER_EVENTS') {
                try {
                    const parsed = JSON.parse(message);
                    
                    // ENTERPRISE FIX: Handles the new array-based micro-batching from eventEmitter seamlessly
                    const events = Array.isArray(parsed) ? parsed : [parsed];
                    
                    events.forEach(evt => {
                        const bridgePayload = JSON.stringify({ type: evt.eventName, ...evt.payload });
                        adminConnections.forEach(conn => {
                            if (!conn.destroyed) conn.write(`data: ${bridgePayload}\n\n`);
                        });
                    });
                } catch (err) {
                    console.error("SSE Batch Parsing Error:", err.message);
                }
            }
        });
        
        redisSub.on('error', (err) => console.error("Redis Sub SSE Error:", err.message));
    }
} catch (e) {
    console.error("Redis Initialization Error in SSE Service:", e);
}

// OPTIMIZATION: Captured interval in a variable so it can be explicitly destroyed during container shutdown to prevent Memory Leaks
const heartbeatInterval = setInterval(() => {
    adminConnections = adminConnections.filter(conn => {
        if (conn.destroyed || !conn.writable) {
            
            // DEPRECATION CONSULTATION: Original code just called conn.destroy()
            /* conn.destroy(); */

            // OPTIMIZATION: Clear dangling listeners before destruction to ensure 
            // proper Node.js Garbage Collection for memory leak prevention.
            conn.removeAllListeners();
            conn.destroy(); 
            return false;
        }
        try {
            // FIX: Explicitly send a named heartbeat comment to prevent HTTP/2 proxy drops
            conn.write(': heartbeat\n\n');
            return true;
        } catch (e) {
            conn.removeAllListeners();
            conn.destroy();
            return false; 
        }
    });

    for (const orderId in customerConnections) {
        customerConnections[orderId] = customerConnections[orderId].filter(conn => {
            if (conn.destroyed || !conn.writable) {
                conn.removeAllListeners();
                conn.destroy();
                return false;
            }
            try {
                // FIX: Explicitly send a named heartbeat comment to prevent HTTP/2 proxy drops
                conn.write(': heartbeat\n\n');
                return true;
            } catch (e) {
                conn.removeAllListeners();
                conn.destroy();
                return false;
            }
        });
        if (customerConnections[orderId].length === 0) delete customerConnections[orderId];
    }
}, 15000);

const addAdminConnection = (conn) => {
    // ENTERPRISE FIX: Cull oldest zombie connections if limit breached
    if (adminConnections.length >= MAX_ADMIN_CONNECTIONS) {
        const oldest = adminConnections.shift();
        if (oldest && !oldest.destroyed) { oldest.removeAllListeners(); oldest.destroy(); }
    }
    adminConnections.push(conn);
};

const removeAdminConnection = (conn) => {
    adminConnections = adminConnections.filter(c => c !== conn);
};

const addCustomerConnection = (orderId, conn) => {
    if (!customerConnections[orderId]) customerConnections[orderId] = [];
    
    // ENTERPRISE FIX: Cull oldest zombie connections for a single order stream
    if (customerConnections[orderId].length >= MAX_CUSTOMER_CONNECTIONS) {
        const oldest = customerConnections[orderId].shift();
        if (oldest && !oldest.destroyed) { oldest.removeAllListeners(); oldest.destroy(); }
    }
    customerConnections[orderId].push(conn);
};

const removeCustomerConnection = (orderId, conn) => {
    if (customerConnections[orderId]) {
        customerConnections[orderId] = customerConnections[orderId].filter(c => c !== conn);
    }
};

const publishEvent = (target, payload, additionalData = {}) => {
    if (redisPub) {
        redisPub.publish('ORDER_STREAM_EVENT', JSON.stringify({ target, payload, ...additionalData })).catch(() => {});
    } else {
        if (target === 'admin') {
            adminConnections.forEach(conn => {
                if (!conn.destroyed) conn.write(`data: ${payload}\n\n`);
            });
        } else if (target === 'customer' && customerConnections[additionalData.orderId]) {
            customerConnections[additionalData.orderId].forEach(conn => {
                if (!conn.destroyed) conn.write(`data: ${payload}\n\n`);
            });
        }
    }
};

const setSSEHeaders = (request, reply) => {
    reply.hijack(); 
    if (reply.raw.socket) reply.raw.socket.setTimeout(0); 
    
    // FIX: Added 'Connection': 'keep-alive' required for proxy environments
    reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': request.headers.origin || '*',  
        'Access-Control-Allow-Credentials': 'true',
        'X-Accel-Buffering': 'no'            
    });
};

const initializeAdminStream = (request, reply) => {
    setSSEHeaders(request, reply);
    reply.raw.write('data: {"message": "Admin Stream Connected"}\n\n');
    addAdminConnection(reply.raw);

    request.raw.on('close', () => {
        removeAdminConnection(reply.raw);
    });
};

const initializeCustomerStream = (request, reply, orderId) => {
    setSSEHeaders(request, reply);
    reply.raw.write('data: {"message": "Tracking Stream Connected"}\n\n');
    addCustomerConnection(orderId, reply.raw);

    request.raw.on('close', () => {
        removeCustomerConnection(orderId, reply.raw);
    });
};

const notifyNewOrder = (request, order, storeId, source = null) => {
    const payloadObj = { type: 'NEW_ORDER', order };
    if (source) payloadObj.source = source;
    
    publishEvent('admin', JSON.stringify(payloadObj), { storeId });

    if (request.server.broadcastToPOS) {
        const posPayload = { type: 'NEW_ORDER', orderId: order._id, storeId };
        if (source) posPayload.source = source;
        request.server.broadcastToPOS(posPayload);
    }
};

const notifyStatusUpdate = (request, orderId, status, storeId) => {
    const payload = JSON.stringify({ type: 'STATUS_UPDATE', status });
    publishEvent('customer', payload, { orderId });

    if (request.server.broadcastToPOS) {
        request.server.broadcastToPOS({ type: 'ORDER_STATUS_UPDATED', orderId, status, storeId });
    }
};

const closeAllConnections = () => {
    // OPTIMIZATION: Native interval termination to prevent "Zombie" background loops during worker reloads
    clearInterval(heartbeatInterval);
    
    adminConnections.forEach(conn => { if (!conn.destroyed) conn.end(); });
    for (const orderId in customerConnections) {
        customerConnections[orderId].forEach(conn => { if (!conn.destroyed) conn.end(); });
    }
};

module.exports = {
    redisPub,
    redisSub,
    addAdminConnection,
    removeAdminConnection,
    addCustomerConnection,
    removeCustomerConnection,
    publishEvent,
    setSSEHeaders,
    initializeAdminStream,
    initializeCustomerStream,
    notifyNewOrder,
    notifyStatusUpdate,
    closeAllConnections
};
