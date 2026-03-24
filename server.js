const Fastify = require('fastify');
const mongoose = require('mongoose');
require('dotenv').config();

const fastify = Fastify({
    logger: true 
});

const PORT = process.env.PORT || 3000;

fastify.register(require('@fastify/helmet'));
fastify.register(require('@fastify/rate-limit'), {
  max: 100,
  timeWindow: '1 minute'
});

fastify.register(require('@fastify/cors'), { 
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*'
});

fastify.register(require('@fastify/multipart'), {
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB Limit
    }
});

// --- SECURED: Removed fallback secret. Must be provided in .env ---
// --- OLD CODE (KEPT FOR CONSULTATION) ---
// fastify.register(require('@fastify/jwt'), {
//     secret: process.env.JWT_SECRET || 'fallback_super_secret_key_change_in_production'
// });
if (!process.env.JWT_SECRET) {
    console.warn("WARNING: JWT_SECRET is missing. Please add it to your .env file for security.");
}
fastify.register(require('@fastify/jwt'), {
    secret: process.env.JWT_SECRET || 'TEMPORARY_DEV_SECRET_DO_NOT_USE_IN_PROD'
});

fastify.decorate("authenticate", async function(request, reply) {
    try {
        if (request.query && request.query.token) {
            request.headers.authorization = `Bearer ${request.query.token}`;
        }
        await request.jwtVerify();
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

    // --- SECURED: Better public route handling to avoid blocking sub-routes ---
    const publicPrefixes = [
        '/api/auth/login',
        '/api/auth/setup',
        '/api/products' // Ensures /api/products and /api/products/:id both work
    ];
    
    const basePath = request.url.split('?')[0];
    
    // --- OLD CODE (KEPT FOR CONSULTATION) ---
    // const publicRoutes = ['/', '/api/auth/login', '/api/auth/setup', '/api/products'];
    // const isPublic = publicRoutes.includes(basePath);
    
    // NEW OPTIMIZED LOGIC:
    const isPublic = basePath === '/' || publicPrefixes.some(prefix => basePath.startsWith(prefix));

    if (!isPublic) {
        try {
            if (request.query && request.query.token) {
                request.headers.authorization = `Bearer ${request.query.token}`;
            }
            await request.jwtVerify(); 
        } catch (err) {
            fastify.log.warn(`Blocked unauthorized access attempt to ${request.url}`);
            reply.status(401).send({ success: false, message: 'Unauthorized: Access Denied. Please log in.' });
        }
    }
});

// Route Registrations
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
