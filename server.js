/* server.js */

const Fastify = require('fastify');
const mongoose = require('mongoose');
require('dotenv').config();

const cluster = require('cluster');
const os = require('os');

const fastify = Fastify({
    logger: process.env.NODE_ENV === 'production' ? { level: 'error' } : true 
});

const PORT = process.env.PORT || 3000;

fastify.register(require('@fastify/helmet'));

let redisClient = null;
try {
    const Redis = require('ioredis');
    if (process.env.REDIS_URL) {
        redisClient = new Redis(process.env.REDIS_URL);
    }
} catch(e) {}

const rateLimitConfig = {
    max: 100,
    timeWindow: '1 minute'
};
if (redisClient) {
    rateLimitConfig.redis = redisClient; 
}
fastify.register(require('@fastify/rate-limit'), rateLimitConfig);

const dynamicOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [];
const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    process.env.FRONTEND_URL,
    ...dynamicOrigins
].filter(Boolean);

fastify.register(require('@fastify/cors'), { 
    origin: allowedOrigins, 
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With']
});

fastify.register(require('@fastify/compress'), { global: true });

fastify.register(require('@fastify/multipart'), {
    limits: {
        fileSize: 5 * 1024 * 1024 
    }
});

if (process.env.NODE_ENV === 'production' && !process.env.COOKIE_SECRET) {
    fastify.log.error("CRITICAL SECURITY ALERT: Missing COOKIE_SECRET in production. Shutting down.");
    process.exit(1);
}
fastify.register(require('@fastify/cookie'), {
    secret: process.env.COOKIE_SECRET || 'dev-fallback-secret-123',
    hook: 'onRequest'
});

fastify.register(require('@fastify/websocket'));
fastify.register(require('@fastify/swagger'), {
    swagger: {
        info: { title: 'DailyPick API', description: 'Enterprise Backend API', version: '1.0.0' },
        consumes: ['application/json'],
        produces: ['application/json']
    }
});
fastify.register(require('@fastify/swagger-ui'), {
    routePrefix: '/api/docs',
    uiConfig: { docExpansion: 'none', deepLinking: false }
});

// --- Modularized Setups ---
require('./plugins/authSetup')(fastify);
require('./plugins/wsSetup')(fastify);
require('./plugins/errorHandler')(fastify); // NEW: Extracted Error Handler

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
fastify.register(require('./routes')); // NEW: Loads all routes from routes/index.js

const listeners = ['SIGINT', 'SIGTERM'];
listeners.forEach((signal) => {
    process.on(signal, async () => {
        fastify.log.info(`${signal} received. Shutting down gracefully...`);
        
        if (typeof fastify.closeAllSSE === 'function') {
            fastify.closeAllSSE();
        }
        
        setTimeout(() => {
            fastify.log.error('Forcing shutdown after timeout. Some active processes may have been terminated.');
            process.exit(1);
        }, 15000).unref(); 

        try {
            await fastify.close();
            await mongoose.connection.close();
            if (redisClient) await redisClient.quit();
            // Call the cleanup method mapped from wsSetup.js
            if (typeof fastify.closeRedisWS === 'function') {
                await fastify.closeRedisWS(); 
            }
            fastify.log.info('Clean shutdown complete.');
            process.exit(0);
        } catch (err) {
            fastify.log.error('Error during shutdown:', err);
            process.exit(1);
        }
    });
});

const connectDB = async () => {
    if (mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2) return true;
    let retries = 5;
    while (retries) {
        try {
            await mongoose.connect(process.env.MONGO_URI, {
                maxPoolSize: 50
            });
            fastify.log.info(`Successfully connected to MongoDB Atlas by Process ${process.pid}`);
            return true;
        } catch (err) {
            console.error(`CRITICAL ERROR CONNECTING TO MONGODB. Retries left: ${retries - 1}`, err.message);
            retries -= 1;
            if (retries === 0) process.exit(1);
            await new Promise(res => setTimeout(res, 5000));
        }
    }
};

const startServer = async () => {
    await connectDB();
    
    // --- PHASE 6: Initialize Automated Cloud Backups ---
    require('./jobs/backupCron')(fastify);
    
    try {
        await fastify.listen({ port: PORT, host: '0.0.0.0' });
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

if (process.env.ENABLE_CLUSTERING === 'true' && cluster.isPrimary) {
    connectDB().then(() => {
        require('./jobs/cronScheduler')(fastify, (newReport) => {
            latestInventoryReport = newReport;
        });

        const numCPUs = os.cpus().length;
        console.log(`[CLUSTER] Primary Process ${process.pid} running. Distributing traffic across ${numCPUs} CPUs...`);
        
        for (let i = 0; i < numCPUs; i++) {
            cluster.fork(); 
        }

        cluster.on('exit', (worker, code, signal) => {
            console.log(`[CLUSTER] Worker ${worker.process.pid} died or crashed. Auto-restarting...`);
            cluster.fork(); 
        });
    });
} else if (process.env.ENABLE_CLUSTERING !== 'true') {
    connectDB().then(() => {
        require('./jobs/cronScheduler')(fastify, (newReport) => {
            latestInventoryReport = newReport;
        });
        
        // --- PHASE 6: Initialize Automated Cloud Backups ---
        require('./jobs/backupCron')(fastify);

        fastify.listen({ port: PORT, host: '0.0.0.0' }).catch(err => {
            fastify.log.error(err);
            process.exit(1);
        });
    });
} else {
    startServer();
}
