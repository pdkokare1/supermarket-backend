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

// --- NEW: Multipart support for secure Cloudinary uploads ---
fastify.register(require('@fastify/multipart'), {
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB Limit
    }
});

// --- JWT Security Registration ---
fastify.register(require('@fastify/jwt'), {
    secret: process.env.JWT_SECRET || 'fallback_super_secret_key_change_in_production'
});

fastify.decorate("authenticate", async function(request, reply) {
    try {
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

// --- Global Security Bouncer (The Lock) ---
fastify.addHook("onRequest", async (request, reply) => {
    if (request.method === 'OPTIONS') return;

    const publicRoutes = [
        '/',
        '/api/auth/login',
        '/api/auth/setup',
        '/api/products' // Ensuring customers can browse products
    ];

    const basePath = request.url.split('?')[0];
    const isPublic = publicRoutes.includes(basePath);

    if (!isPublic) {
        try {
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

// Global Error Handler
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

// Initialize Background CRON Jobs
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
