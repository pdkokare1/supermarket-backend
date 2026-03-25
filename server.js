const Fastify = require('fastify');
const mongoose = require('mongoose');
require('dotenv').config();
const User = require('./models/User'); 

// --- NEW IMPORTS FOR PHASE 5: SCALING ---
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

// --- RESTORED & SECURED CORS POLICY ---
fastify.register(require('@fastify/cors'), { 
    origin: true, 
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With']
});

// --- PERFORMANCE: High-Speed Response Compression ---
fastify.register(require('@fastify/compress'), { global: true });

fastify.register(require('@fastify/multipart'), {
    limits: {
        fileSize: 5 * 1024 * 1024 
    }
});

// --- CAPABILITY: Cookie Parsing for Refresh Tokens ---
fastify.register(require('@fastify/cookie'), {
    secret: process.env.COOKIE_SECRET || 'fallback-secret-123',
    hook: 'onRequest'
});

// --- CAPABILITY: Real-Time WebSockets ---
fastify.register(require('@fastify/websocket'));

// --- DEVOPS: Auto-Generated API Documentation ---
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

// --- SECURITY: Enterprise RS256 Asymmetric Encryption ---
if (!process.env.JWT_PRIVATE_KEY || !process.env.JWT_PUBLIC_KEY) {
    fastify.log.error("CRITICAL: JWT_PRIVATE_KEY or JWT_PUBLIC_KEY is missing. Server shutting down.");
    process.exit(1);
}

fastify.register(require('@fastify/jwt'), {
    secret: {
        // The .replace() ensures Railway's environment variable formatting doesn't break the PEM structure
        private: process.env.JWT_PRIVATE_KEY.replace(/\\n/g, '\n'),
        public: process.env.JWT_PUBLIC_KEY.replace(/\\n/g, '\n')
    },
    sign: { algorithm: 'RS256' }
});

fastify.decorate("authenticate", async function(request, reply) {
    try {
        const decoded = await request.jwtVerify();
        
        const user = await User.findById(decoded.id).select('tokenVersion isActive');
        if (!user || !user.isActive || user.tokenVersion !== decoded.tokenVersion) {
            throw new Error('Token revoked or user inactive');
        }
    } catch (err) {
        reply.status(401).send({ success: false, message: 'Unauthorized: Invalid or missing token.' });
    }
});

fastify.decorate("verifyAdmin", async function(request, reply) {
    if (request.user && request.user.role !== 'Admin') {
        reply.status(403).send({ success: false, message: 'Forbidden: Admin access required.' });
        throw new Error('Forbidden: Admin access required.'); 
    }
});

// --- UTILITY: Global WebSocket Broadcaster ---
fastify.decorate('broadcastToPOS', function (message) {
    if (!fastify.websocketServer) return;
    fastify.websocketServer.clients.forEach(function each(client) {
        if (client.readyState === 1) { 
            client.send(JSON.stringify(message));
        }
    });
});

// --- ROUTE: WebSocket Connection Endpoint ---
fastify.register(async function (fastify) {
    fastify.get('/api/ws/pos', { websocket: true }, (connection, req) => {
        connection.socket.on('message', message => {
            fastify.log.info(`[WS] Received: ${message}`);
        });
        connection.socket.send(JSON.stringify({ type: 'CONNECTION_ESTABLISHED', message: 'Connected to DailyPick Real-Time Server' }));
    });
});

// EXPLICIT ROUTE REGISTRATION 
fastify.register(require('./routes/productRoutes'));
fastify.register(require('./routes/orderRoutes'));
fastify.register(require('./routes/categoryRoutes'));
fastify.register(require('./routes/brandRoutes')); 
fastify.register(require('./routes/distributorRoutes')); 
fastify.register(require('./routes/expenseRoutes')); 
fastify.register(require('./routes/authRoutes')); 
fastify.register(require('./routes/promotionRoutes')); 
fastify.register(require('./routes/shiftRoutes'));

// --- OBSERVABILITY: Real-Time APM Error Interceptor ---
fastify.setErrorHandler(function (error, request, reply) {
    const apmLog = {
        event: 'CRITICAL_ERROR',
        timestamp: new Date().toISOString(),
        method: request.method,
        url: request.url,
        userId: request.user ? request.user.id : 'Unauthenticated',
        errorName: error.name,
        errorMessage: error.message,
        payload: request.body ? '[REDACTED]' : null 
    };
    
    fastify.log.error(`[APM MONITOR] ${JSON.stringify(apmLog)}`);
    if (process.env.NODE_ENV !== 'production') fastify.log.error(error); 

    reply.status(error.statusCode || 500).send({
        success: false,
        message: error.message || 'Internal Server Error'
    });
});

let latestInventoryReport = {
    lowStock: [],
    deadStock: [],
    lastGenerated: null
};

fastify.get('/api/inventory/report', async (request, reply) => {
    return { success: true, data: latestInventoryReport };
});

fastify.get('/api/health', async (request, reply) => {
    const dbStatus = mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected';
    let redisStatus = 'Not Configured';
    
    if (redisClient) {
        try {
            await redisClient.ping();
            redisStatus = 'Connected';
        } catch (e) {
            redisStatus = 'Disconnected';
        }
    }
    
    const memoryUsage = process.memoryUsage();
    const systemHealth = {
        status: dbStatus === 'Connected' ? 'Healthy' : 'Error',
        database: dbStatus,
        redis: redisStatus,
        uptime: process.uptime(),
        memory: {
            free: `${(os.freemem() / 1024 / 1024).toFixed(2)} MB`,
            total: `${(os.totalmem() / 1024 / 1024).toFixed(2)} MB`,
            rss: `${(memoryUsage.rss / 1024 / 1024).toFixed(2)} MB`
        },
        cpuLoad: os.loadavg()
    };
    
    if (dbStatus !== 'Connected') {
        reply.status(503).send(systemHealth);
    } else {
        reply.send(systemHealth);
    }
});

fastify.get('/', async (request, reply) => {
    return { 
        status: 'Active',
        message: 'Supermarket Fastify Backend MVP is running and connected!' 
    };
});

// --- ENHANCED GRACEFUL SHUTDOWN ---
const listeners = ['SIGINT', 'SIGTERM'];
listeners.forEach((signal) => {
    process.on(signal, async () => {
        fastify.log.info(`${signal} received. Shutting down gracefully...`);
        
        setTimeout(() => {
            fastify.log.error('Forcing shutdown after timeout. Some active processes may have been terminated.');
            process.exit(1);
        }, 15000).unref(); 

        try {
            await fastify.close();
            await mongoose.connection.close();
            if (redisClient) await redisClient.quit();
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
    try {
        await fastify.listen({ port: PORT, host: '0.0.0.0' });
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

// --- SCALING & JOB SCHEDULING ---
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
        fastify.listen({ port: PORT, host: '0.0.0.0' }).catch(err => {
            fastify.log.error(err);
            process.exit(1);
        });
    });
} else {
    startServer();
}
