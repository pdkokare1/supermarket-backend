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

fastify.register(require('@fastify/cors'), { 
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : false
});

// --- PERFORMANCE: High-Speed Response Compression ---
fastify.register(require('@fastify/compress'), { global: true });

fastify.register(require('@fastify/multipart'), {
    limits: {
        fileSize: 5 * 1024 * 1024 
    }
});

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

if (!process.env.JWT_SECRET) {
    fastify.log.error("CRITICAL: JWT_SECRET is missing. Server shutting down to prevent unauthorized token minting.");
    process.exit(1);
}

fastify.register(require('@fastify/jwt'), {
    secret: process.env.JWT_SECRET
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
    }
});

fastify.addHook("onRequest", async (request, reply) => {
    if (request.method === 'OPTIONS') return;

    const publicPrefixes = [
        '/api/auth/login',
        '/api/auth/setup',
        '/api/products',
        '/api/health', 
        '/api/docs' // Exempt Swagger UI from JWT checks
    ];
    
    const basePath = request.url.split('?')[0];
    const isPublic = basePath === '/' || publicPrefixes.some(prefix => basePath.startsWith(prefix));

    if (!isPublic) {
        try {
            const decoded = await request.jwtVerify(); 
            
            const user = await User.findById(decoded.id).select('tokenVersion isActive');
            if (!user || !user.isActive || user.tokenVersion !== decoded.tokenVersion) {
                throw new Error('Token revoked');
            }
            
            request.user = decoded; 
        } catch (err) {
            fastify.log.warn(`Blocked unauthorized access attempt to ${request.url}`);
            reply.status(401).send({ success: false, message: 'Unauthorized: Access Denied. Please log in.' });
        }
    }
});

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
    // Generate an isolated, clean log of exactly what failed and who triggered it
    const apmLog = {
        event: 'CRITICAL_ERROR',
        timestamp: new Date().toISOString(),
        method: request.method,
        url: request.url,
        userId: request.user ? request.user.id : 'Unauthenticated',
        errorName: error.name,
        errorMessage: error.message,
        // Strip sensitive data to comply with security standards
        payload: request.body ? '[REDACTED]' : null 
    };
    
    fastify.log.error(`[APM MONITOR] ${JSON.stringify(apmLog)}`);
    if (process.env.NODE_ENV !== 'production') fastify.log.error(error); // Keep stack trace in dev

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
    
    if (dbStatus !== 'Connected') {
        reply.status(503).send({ status: 'Error', database: dbStatus, redis: redisStatus });
    } else {
        reply.send({ status: 'Healthy', database: dbStatus, redis: redisStatus });
    }
});

fastify.get('/', async (request, reply) => {
    return { 
        status: 'Active',
        message: 'Supermarket Fastify Backend MVP is running and connected!' 
    };
});

const listeners = ['SIGINT', 'SIGTERM'];
listeners.forEach((signal) => {
    process.on(signal, async () => {
        fastify.log.info(`${signal} received. Shutting down gracefully...`);
        
        setTimeout(() => {
            fastify.log.error('Forcing shutdown after timeout.');
            process.exit(1);
        }, 10000).unref();

        await fastify.close();
        await mongoose.connection.close();
        process.exit(0);
    });
});

const startServer = async () => {
    let retries = 5;
    while (retries) {
        try {
            await mongoose.connect(process.env.MONGO_URI, {
                maxPoolSize: 50
            });
            fastify.log.info(`Successfully connected to MongoDB Atlas by Worker ${process.pid}`);
            break;
        } catch (err) {
            console.error(`CRITICAL ERROR CONNECTING TO MONGODB. Retries left: ${retries - 1}`, err.message);
            retries -= 1;
            if (retries === 0) process.exit(1);
            await new Promise(res => setTimeout(res, 5000));
        }
    }

    try {
        await fastify.listen({ port: PORT, host: '0.0.0.0' });
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

// --- SCALING & JOB SCHEDULING ---
if (process.env.ENABLE_CLUSTERING === 'true' && cluster.isPrimary) {
    // Primary Node: Initializes the cron job exactly once and forks workers
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
} else if (process.env.ENABLE_CLUSTERING !== 'true') {
    // Standalone Mode (Railway/Vercel default): Initializes cron and runs server on one process
    require('./jobs/cronScheduler')(fastify, (newReport) => {
        latestInventoryReport = newReport;
    });
    startServer();
} else {
    // Clustered Worker Nodes: Exclusively handle traffic
    startServer();
}
