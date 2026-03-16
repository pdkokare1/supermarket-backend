const Fastify = require('fastify');
const mongoose = require('mongoose');
require('dotenv').config();

// Initialize Fastify with Pino logging enabled
const fastify = Fastify({
    logger: true 
});

const PORT = process.env.PORT || 3000;

// Register CORS middleware for Vercel communication
fastify.register(require('@fastify/cors'), { 
    origin: '*' 
});

// Register API Routes
fastify.register(require('./routes/productRoutes'));
fastify.register(require('./routes/orderRoutes'));
fastify.register(require('./routes/categoryRoutes')); // <-- NEW: Category Routes Registered

// Basic Health Check Route
fastify.get('/', async (request, reply) => {
    return { 
        status: 'Active',
        message: 'Supermarket Fastify Backend MVP is running and connected!' 
    };
});

// Database Connection and Server Initialization
const startServer = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        fastify.log.info('Successfully connected to MongoDB Atlas');
        
        // Start the server (0.0.0.0 is required for Railway deployments)
        await fastify.listen({ port: PORT, host: '0.0.0.0' });
    } catch (err) {
        console.error('CRITICAL ERROR CONNECTING TO MONGODB:', err.message);
        process.exit(1);
    }
};

startServer();
