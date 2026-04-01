/* services/orderSseService.js */

let redisPub = null;
let redisSub = null;

let adminConnections = [];
let customerConnections = {};

try {
    const Redis = require('ioredis');
    if (process.env.REDIS_URL) {
        redisPub = new Redis(process.env.REDIS_URL);
        redisSub = new Redis(process.env.REDIS_URL);
        
        redisSub.subscribe('ORDER_STREAM_EVENT');
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
        });
    }
} catch (e) {
    console.error("Redis Initialization Error in SSE Service:", e);
}

// Global Heartbeat to keep SSE connections alive
setInterval(() => {
    adminConnections = adminConnections.filter(conn => {
        if (conn.destroyed || !conn.writable) return false;
        try {
            conn.write(':\n\n');
            return true;
        } catch (e) {
            return false; 
        }
    });

    for (const orderId in customerConnections) {
        customerConnections[orderId] = customerConnections[orderId].filter(conn => {
            if (conn.destroyed || !conn.writable) return false;
            try {
                conn.write(':\n\n');
                return true;
            } catch (e) {
                return false;
            }
        });
        if (customerConnections[orderId].length === 0) delete customerConnections[orderId];
    }
}, 15000);

const addAdminConnection = (conn) => adminConnections.push(conn);
const removeAdminConnection = (conn) => {
    adminConnections = adminConnections.filter(c => c !== conn);
};

const addCustomerConnection = (orderId, conn) => {
    if (!customerConnections[orderId]) customerConnections[orderId] = [];
    customerConnections[orderId].push(conn);
};
const removeCustomerConnection = (orderId, conn) => {
    if (customerConnections[orderId]) {
        customerConnections[orderId] = customerConnections[orderId].filter(c => c !== conn);
    }
};

const publishEvent = (target, payload, additionalData = {}) => {
    if (redisPub) {
        redisPub.publish('ORDER_STREAM_EVENT', JSON.stringify({ target, payload, ...additionalData }));
    } else {
        // Fallback for local memory
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

const closeAllConnections = () => {
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
    closeAllConnections
};
