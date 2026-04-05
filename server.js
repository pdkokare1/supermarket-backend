/* server.js */

const Fastify = require('fastify');
const mongoose = require('mongoose');
require('dotenv').config();

const cluster = require('cluster');
const connectDB = require('./config/db');
const initRedis = require('./config/redis'); 
const { handleInventoryReport } = require('./jobs/inventoryHandler'); 
const { setupGracefulShutdown, setupCluster } = require('./utils/serverProcessUtils');

// Added trustProxy so Fastify can read headers passing through Railway's proxy.
// Changed production log level to 'info' so traffic is visible in the Railway dashboard.
const fastify = Fastify({
    logger: process.env.NODE_ENV === 'production' ? { level: 'info' } : true,
    trustProxy: true 
});

const PORT = process.env.PORT || 3000;

const redisClient = initRedis();

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

const initScheduler = () => {
    require('./jobs/cronScheduler')(fastify, (newReport) => handleInventoryReport(redisClient, fastify, newReport));
};

const startServer = async () => {
    await connectDB(fastify);
    require('./jobs/backupCron')(fastify); 
    
    try {
        await fastify.listen({ port: PORT, host: '0.0.0.0' });
        fastify.log.info(`Server successfully bound to port ${PORT}`);
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
    startServer(); 
}
