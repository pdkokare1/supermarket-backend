const Fastify = require('fastify');
const mongoose = require('mongoose');
const cron = require('node-cron');
const Product = require('./models/Product'); // Needed for the inventory cron job
const Order = require('./models/Order');     // NEW: Needed for the EOD cron job
const nodemailer = require('nodemailer');    // NEW: Needed for Email Reports
const axios = require('axios');              // NEW: Needed for WhatsApp API
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

// --- NEW: Automated EOD Report CRON Job (Email & WhatsApp) ---
// Runs every day at 23:59 (11:59 PM) server time
cron.schedule('59 23 * * *', async () => {
    fastify.log.info('Running EOD Report CRON Job...');
    try {
        // 1. Calculate Today's Sales
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const todaysOrders = await Order.find({
            createdAt: { $gte: today, $lt: tomorrow },
            status: { $ne: 'Cancelled' }
        });

        let totalRevenue = 0;
        let cash = 0;
        let upi = 0;
        let payLater = 0;

        todaysOrders.forEach(o => {
            totalRevenue += o.totalAmount;
            
            if (o.paymentMethod === 'Cash') {
                cash += o.totalAmount;
            } else if (o.paymentMethod === 'UPI') {
                upi += o.totalAmount;
            } else if (o.paymentMethod === 'Pay Later') {
                payLater += o.totalAmount;
            } else if (o.paymentMethod === 'Split' && o.splitDetails) {
                // Incorporating our new Split Payment logic
                cash += (o.splitDetails.cash || 0);
                upi += (o.splitDetails.upi || 0);
            }
        });

        // 2. Format the Message
        const dateString = new Date().toLocaleDateString();
        const reportText = `📈 *DailyPick EOD Report*\nDate: ${dateString}\n\n` +
                           `*Total Orders:* ${todaysOrders.length}\n` +
                           `*Total Revenue:* ₹${totalRevenue.toFixed(2)}\n\n` +
                           `*Breakdown:*\n` +
                           `💵 Cash: ₹${cash.toFixed(2)}\n` +
                           `📱 UPI: ₹${upi.toFixed(2)}\n` +
                           `⏳ Pay Later: ₹${payLater.toFixed(2)}\n\n` +
                           `Great work today! 🚀`;

        // 3. Send Email via Nodemailer
        if (process.env.EMAIL_USER && process.env.EMAIL_PASS && process.env.TARGET_EMAIL) {
            const transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
            });
            await transporter.sendMail({
                from: `"DailyPick Server" <${process.env.EMAIL_USER}>`,
                to: process.env.TARGET_EMAIL,
                subject: `EOD Report: ₹${totalRevenue.toFixed(2)} Revenue`,
                text: reportText
            });
            fastify.log.info('EOD Email sent successfully.');
        } else {
            fastify.log.warn('Skipped Email EOD: Missing EMAIL_USER, EMAIL_PASS, or TARGET_EMAIL in .env');
        }

        // 4. Send WhatsApp via CallMeBot API
        if (process.env.WA_PHONE_NUMBER && process.env.CALLMEBOT_API_KEY) {
            const encodedText = encodeURIComponent(reportText);
            const waUrl = `https://api.callmebot.com/whatsapp.php?phone=${process.env.WA_PHONE_NUMBER}&text=${encodedText}&apikey=${process.env.CALLMEBOT_API_KEY}`;
            
            await axios.get(waUrl);
            fastify.log.info('EOD WhatsApp sent successfully.');
        } else {
            fastify.log.warn('Skipped WhatsApp EOD: Missing WA_PHONE_NUMBER or CALLMEBOT_API_KEY in .env');
        }

    } catch (err) {
        fastify.log.error('EOD CRON Job Error:', err);
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
