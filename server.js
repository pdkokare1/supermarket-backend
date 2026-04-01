/* server.js */

const Fastify = require('fastify');
const mongoose = require('mongoose');
require('dotenv').config();

const cluster = require('cluster');
const connectDB = require('./config/db');
const { setupGracefulShutdown, setupCluster } = require('./utils/serverProcessUtils');

const fastify = Fastify({
    logger: process.env.NODE_ENV === 'production' ? { level: 'error' } : true 
});

const PORT = process.env.PORT || 3000;

let redisClient = null;

const initRedis = () => {
    try {
        const Redis = require('ioredis');
        if (process.env.REDIS_URL) {
            redisClient = new Redis(process.env.REDIS_URL);
        }
    } catch(e) {
        console.warn('[SERVER] Redis initialization failed:', e.message);
    }
};

initRedis();

// --- Modularized Setups ---
require('./plugins/middlewareSetup')(fastify, redisClient); 
require('./plugins/authSetup')(fastify);
require('./plugins/wsSetup')(fastify);
require('./plugins/errorHandler')(fastify);

// --- Modularized System Routes ---
fastify.register(require('./routes/systemRoutes'), {
    redisClient
});

// --- Feature Routes ---
fastify.register(require('./routes')); 

// ==========================================
// --- INITIALIZATION HELPERS ---
// ==========================================

const handleInventoryReport = async (newReport) => {
    // OPTIMIZATION: Write report directly to Redis to ensure all workers share the exact same state.
    if (redisClient) {
        try {
            await redisClient.set('cache:inventory:report', JSON.stringify(newReport), 'EX', 86400); // 24h cache
        } catch(e) {
            fastify.log.error('Failed to update inventory report in Redis:', e);
        }
    }
};

const initScheduler = () => {
    require('./jobs/cronScheduler')(fastify, handleInventoryReport);
};

const startServer = async () => {
    await connectDB(fastify);
    require('./jobs/backupCron')(fastify); 
    
    try {
        await fastify.listen({ port: PORT, host: '0.0.0.0' });
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

// ==========================================
// --- EXECUTION BOOTSTRAP ---
// ==========================================

setupGracefulShutdown(fastify, redisClient);

if (process.env.ENABLE_CLUSTERING === 'true' && cluster.isPrimary) {
    setupCluster(fastify, connectDB, initScheduler);
} else if (process.env.ENABLE_CLUSTERING !== 'true') {
    initScheduler();
    startServer(); 
} else {
    startServer(); // Worker processes
}
