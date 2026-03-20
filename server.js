const Fastify = require('fastify');
const mongoose = require('mongoose');
const cron = require('node-cron');
const Product = require('./models/Product'); // Needed for the cron job
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
fastify.register(require('./routes/categoryRoutes'));
fastify.register(require('./routes/brandRoutes')); 
fastify.register(require('./routes/distributorRoutes')); 
fastify.register(require('./routes/promotionRoutes')); // <-- NEW: Registered Promotion Routes for Phase 1

// Basic Health Check Route
fastify.get('/', async (request, reply) => {
    return { 
        status: 'Active',
        message: 'Supermarket Fastify Backend MVP is running and connected!' 
    };
});

// --- Automated Low-Stock Alert System ---
// Runs every day at 09:00 AM server time
cron.schedule('0 9 * * *', async () => {
    fastify.log.info('Running Daily Low-Stock CRON Job...');
    try {
        const products = await Product.find({ isActive: true });
        let lowStockCount = 0;
        
        products.forEach(p => {
            if (p.variants) {
                p.variants.forEach(v => {
                    if (v.stock <= (v.lowStockThreshold || 5)) {
                        lowStockCount++;
                    }
                });
            }
        });

        if (lowStockCount > 0) {
            fastify.log.info(`CRON ALERT: You have ${lowStockCount} items running low on stock.`);
            // In the future, you can put a fetch() here to trigger a free WhatsApp API (like UltraMsg/CallMeBot)
        }
    } catch (err) {
        fastify.log.error('CRON Job Error:', err);
    }
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
