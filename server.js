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
// fastify.register(require('./routes/promotionRoutes')); // Uncomment if you added this in Phase 1

// --- NEW PHASE 5: Global Object to store the CRON job results ---
let latestInventoryReport = {
    lowStock: [],
    deadStock: [],
    lastGenerated: null
};

// --- NEW PHASE 5: Endpoint to fetch the CRON job report ---
fastify.get('/api/inventory/report', async (request, reply) => {
    return { success: true, data: latestInventoryReport };
});
// ----------------------------------------------------------------

// Basic Health Check Route
fastify.get('/', async (request, reply) => {
    return { 
        status: 'Active',
        message: 'Supermarket Fastify Backend MVP is running and connected!' 
    };
});

// --- UPGRADED PHASE 5: Automated Low-Stock & Dead-Stock CRON Job ---
// Runs every day at 09:00 AM server time
cron.schedule('0 9 * * *', async () => {
    fastify.log.info('Running Daily Inventory CRON Job...');
    try {
        const products = await Product.find({ isActive: true });
        let lowStockItems = [];
        let deadStockItems = [];
        
        products.forEach(p => {
            if (p.variants) {
                p.variants.forEach(v => {
                    // Check Low Stock
                    if (v.stock <= (v.lowStockThreshold || 5)) {
                        lowStockItems.push({ name: p.name, variant: v.weightOrVolume, stock: v.stock });
                    }
                    // NEW: Check Dead Stock (e.g., highly overstocked > 15 units)
                    if (v.stock > 15) {
                        deadStockItems.push({ name: p.name, variant: v.weightOrVolume, stock: v.stock });
                    }
                });
            }
        });

        // Save results to memory so the frontend can fetch it via /api/inventory/report
        latestInventoryReport = {
            lowStock: lowStockItems,
            deadStock: deadStockItems,
            lastGenerated: new Date()
        };

        fastify.log.info(`CRON REPORT: ${lowStockItems.length} Low Stock, ${deadStockItems.length} Dead Stock.`);
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
