/* server.js */

const Fastify = require('fastify');
const mongoose = require('mongoose');
require('dotenv').config();

const cluster = require('cluster');
const os = require('os');
const connectDB = require('./config/db');

const fastify = Fastify({
    logger: process.env.NODE_ENV === 'production' ? { level: 'error' } : true 
});

const PORT = process.env.PORT || 3000;

let redisClient = null;
try {
    const Redis = require('ioredis');
    if (process.env.REDIS_URL) {
        redisClient = new Redis(process.env.REDIS_URL);
    }
} catch(e) {
    console.warn('[SERVER] Redis initialization failed:', e.message);
}

// --- Modularized Setups ---
require('./plugins/middlewareSetup')(fastify, redisClient); 
require('./plugins/authSetup')(fastify);
require('./plugins/wsSetup')(fastify);
require('./plugins/errorHandler')(fastify);

// --- Global State ---
let latestInventoryReport = {
    lowStock: [],
    deadStock: [],
    lastGenerated: null
};

// --- Modularized System Routes ---
fastify.register(require('./routes/systemRoutes'), {
    redisClient,
    getLatestInventoryReport: () => latestInventoryReport
});

// --- Feature Routes ---
fastify.register(require('./routes')); 

// ==========================================
// --- INITIALIZATION HELPERS ---
// ==========================================

const setupGracefulShutdown = () => {
    const listeners = ['SIGINT', 'SIGTERM'];
    listeners.forEach((signal) => {
        process.on(signal, async () => {
            fastify.log.info(`${signal} received. Shutting down gracefully...`);
            
            if (typeof fastify.closeAllSSE === 'function') fastify.closeAllSSE();
            
            setTimeout(() => {
                fastify.log.error('Forcing shutdown after timeout. Some active processes may have been terminated.');
                process.exit(1);
            }, 15000).unref(); 

            try {
                await fastify.close();
                await mongoose.connection.close();
                if (redisClient) await redisClient.quit();
                if (typeof fastify.closeRedisWS === 'function') await fastify.closeRedisWS(); 
                
                fastify.log.info('Clean shutdown complete.');
                process.exit(0);
            } catch (err) {
                fastify.log.error('Error during shutdown:', err);
                process.exit(1);
            }
        });
    });
};

const initScheduler = () => {
    require('./jobs/cronScheduler')(fastify, (newReport) => {
        latestInventoryReport = newReport;
    });
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

const setupCluster = () => {
    connectDB(fastify).then(() => {
        initScheduler();
        const numCPUs = os.cpus().length;
        console.log(`[CLUSTER] Primary Process ${process.pid} running. Distributing traffic across ${numCPUs} CPUs...`);
        
        for (let i = 0; i < numCPUs; i++) cluster.fork(); 

        cluster.on('exit', (worker, code, signal) => {
            console.log(`[CLUSTER] Worker ${worker.process.pid} died or crashed. Auto-restarting...`);
            cluster.fork(); 
        });
    });
};

// ==========================================
// --- EXECUTION BOOTSTRAP ---
// ==========================================

setupGracefulShutdown();

if (process.env.ENABLE_CLUSTERING === 'true' && cluster.isPrimary) {
    setupCluster();
} else if (process.env.ENABLE_CLUSTERING !== 'true') {
    initScheduler();
    startServer(); 
} else {
    startServer(); // Worker processes
}
