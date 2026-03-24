const Fastify = require('fastify');
const mongoose = require('mongoose');
require('dotenv').config();
const User = require('./models/User'); 

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
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*'
});

fastify.register(require('@fastify/multipart'), {
    limits: {
        fileSize: 5 * 1024 * 1024 
    }
});

if (!process.env.JWT_SECRET) {
    if (process.env.NODE_ENV === 'production') {
        fastify.log.error("CRITICAL: JWT_SECRET is missing in production. Server shutting down.");
        process.exit(1);
    } else {
        fastify.log.warn("WARNING: JWT_SECRET is missing. Using temporary dev secret.");
    }
}

fastify.register(require('@fastify/jwt'), {
    secret: process.env.JWT_SECRET || 'TEMPORARY_DEV_SECRET_DO_NOT_USE_IN_PROD'
});

fastify.decorate("authenticate", async function(request, reply) {
    try {
        if (request.query && request.query.token) {
            request.headers.authorization = `Bearer ${request.query.token}`;
        }
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
        '/api/health' // Explicitly make healthcheck public
    ];
    
    const basePath = request.url.split('?')[0];
    const isPublic = basePath === '/' || publicPrefixes.some(prefix => basePath.startsWith(prefix));

    if (!isPublic) {
        try {
            if (request.query && request.query.token) {
                request.headers.authorization = `Bearer ${request.query.token}`;
            }
            const decoded = await request.jwtVerify(); 
            
            const user = await User.findById(decoded.id).select('tokenVersion isActive');
            if (!user || !user.isActive || user.tokenVersion !== decoded.tokenVersion) {
                throw new Error('Token revoked');
            }
            
            request.user = decoded; // Bind user to request for audit logging later
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

fastify.setErrorHandler(function (error, request, reply) {
    fastify.log.error(error);
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

// --- NEW FUNCTIONALITY: Dedicated DevOps Health Probe ---
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
    
    // If DB is offline, throw a 503 so Railway auto-restarts the instance
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

require('./jobs/cronScheduler')(fastify, (newReport) => {
    latestInventoryReport = newReport;
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
    try {
        await mongoose.connect(process.env.MONGO_URI, {
            maxPoolSize: 50
        });
        fastify.log.info('Successfully connected to MongoDB Atlas');
        
        await fastify.listen({ port: PORT, host: '0.0.0.0' });
    } catch (err) {
        console.error('CRITICAL ERROR CONNECTING TO MONGODB:', err.message);
        process.exit(1);
    }
};

startServer();
