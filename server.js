const Fastify = require('fastify');
const mongoose = require('mongoose');
const cron = require('node-cron');
const Product = require('./models/Product'); 
const Order = require('./models/Order');     
const Expense = require('./models/Expense'); 
const Customer = require('./models/Customer'); 
const nodemailer = require('nodemailer');    
const axios = require('axios');              
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

fastify.register(require('./routes/productRoutes'));
fastify.register(require('./routes/orderRoutes'));
fastify.register(require('./routes/categoryRoutes'));
fastify.register(require('./routes/brandRoutes')); 
fastify.register(require('./routes/distributorRoutes')); 
fastify.register(require('./routes/expenseRoutes')); 
fastify.register(require('./routes/authRoutes')); 

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

// --- NEW: Feature C (Routine Deliveries Automation) ---
cron.schedule('0 6 * * *', async () => {
    fastify.log.info('Running 6:00 AM Routine Deliveries CRON Job...');
    try {
        const routineOrders = await Order.find({ deliveryType: 'Routine', status: { $ne: 'Cancelled' } });
        
        for (const ro of routineOrders) {
            const newOrder = new Order({
                customerName: ro.customerName,
                customerPhone: ro.customerPhone,
                deliveryAddress: ro.deliveryAddress,
                items: ro.items,
                totalAmount: ro.totalAmount,
                paymentMethod: ro.paymentMethod,
                deliveryType: 'Instant', 
                scheduleTime: 'Generated via Routine',
                status: 'Order Placed'
            });
            await newOrder.save();
        }
        fastify.log.info(`Successfully generated ${routineOrders.length} routine orders for today.`);
    } catch (err) {
        fastify.log.error('6:00 AM Routine CRON Job Error:', err);
    }
});

cron.schedule('0 9 * * *', async () => {
    fastify.log.info('Running Daily Inventory & Velocity CRON Job...');
    try {
        const velocityDays = Number(process.env.VELOCITY_DAYS) || 14;
        const lowStockThreshold = Number(process.env.LOW_STOCK_THRESHOLD) || 5;
        const deadStockQty = Number(process.env.DEAD_STOCK_QTY) || 15;
        const deadStockDays = Number(process.env.DEAD_STOCK_DAYS) || 30;

        const dateAgo = new Date();
        dateAgo.setDate(dateAgo.getDate() - velocityDays);

        const recentOrders = await Order.find({
            createdAt: { $gte: dateAgo },
            status: { $in: ['Completed', 'Dispatched'] } 
        });

        let variantSales = {}; 
        recentOrders.forEach(order => {
            order.items.forEach(item => {
                if (item.variantId) {
                    variantSales[item.variantId] = (variantSales[item.variantId] || 0) + item.qty;
                }
            });
        });

        const products = await Product.find({ isActive: true });
        let lowStockItems = [];
        let deadStockItems = [];
        let bulkOps = []; 
        
        for (let p of products) {
            let isModified = false;
            
            if (p.variants) {
                p.variants.forEach(v => {
                    const totalSold = variantSales[v._id.toString()] || 0;
                    const dailyAvg = totalSold / velocityDays;
                    v.averageDailySales = Number(dailyAvg.toFixed(2));

                    if (dailyAvg > 0) {
                        v.daysOfStock = Number((v.stock / dailyAvg).toFixed(1));
                    } else {
                        v.daysOfStock = 999;
                    }
                    isModified = true;

                    if (v.stock <= (v.lowStockThreshold || lowStockThreshold) || (v.daysOfStock < 3 && v.stock > 0)) {
                        lowStockItems.push({ 
                            name: p.name, 
                            variant: v.weightOrVolume, 
                            stock: v.stock,
                            daysLeft: v.daysOfStock 
                        });
                    }
                    
                    if (v.stock > deadStockQty && v.daysOfStock > deadStockDays) {
                        deadStockItems.push({ 
                            name: p.name, 
                            variant: v.weightOrVolume, 
                            stock: v.stock,
                            daysLeft: v.daysOfStock 
                        });
                    }
                });
            }
            
            if (isModified) {
                bulkOps.push({
                    updateOne: {
                        filter: { _id: p._id },
                        update: { $set: { variants: p.variants } }
                    }
                });
            }
        }

        if (bulkOps.length > 0) {
            await Product.bulkWrite(bulkOps);
        }

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

cron.schedule('15 23 * * *', async () => {
    fastify.log.info('Running 11:15 PM EOD Report & Backup CRON Job...');
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const todaysOrders = await Order.find({
            createdAt: { $gte: today, $lt: tomorrow },
            status: { $ne: 'Cancelled' }
        }).lean();

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
                cash += (o.splitDetails.cash || 0);
                upi += (o.splitDetails.upi || 0);
            }
        });

        const todayStr = new Date().toDateString();
        const todaysExpenses = await Expense.find({ dateStr: todayStr });
        
        let totalExpenses = 0;
        todaysExpenses.forEach(ex => totalExpenses += ex.amount);
        
        const netProfit = totalRevenue - totalExpenses;

        const dateString = new Date().toLocaleDateString();
        const reportText = `📈 *DailyPick EOD Report*\nDate: ${dateString}\n\n` +
                           `*Total Orders:* ${todaysOrders.length}\n` +
                           `*Gross Revenue:* ₹${totalRevenue.toFixed(2)}\n\n` +
                           `*Breakdown:*\n` +
                           `💵 Cash: ₹${cash.toFixed(2)}\n` +
                           `📱 UPI: ₹${upi.toFixed(2)}\n` +
                           `⏳ Pay Later: ₹${payLater.toFixed(2)}\n\n` +
                           `*Expenses & Profit:*\n` +
                           `📉 Total Expenses: ₹${totalExpenses.toFixed(2)}\n` +
                           `💰 Net Profit: ₹${netProfit.toFixed(2)}\n\n` +
                           `Great work today! 🚀`;

        const allProducts = await Product.find({}).lean();
        const allCustomers = await Customer.find({}).lean();

        const productsBuffer = Buffer.from(JSON.stringify(allProducts, null, 2), 'utf-8');
        const customersBuffer = Buffer.from(JSON.stringify(allCustomers, null, 2), 'utf-8');
        const todaysOrdersBuffer = Buffer.from(JSON.stringify(todaysOrders, null, 2), 'utf-8');

        if (process.env.EMAIL_USER && process.env.EMAIL_PASS && process.env.TARGET_EMAIL) {
            const transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
            });
            await transporter.sendMail({
                from: `"DailyPick Server" <${process.env.EMAIL_USER}>`,
                to: process.env.TARGET_EMAIL,
                subject: `EOD Report & Backup: ₹${netProfit.toFixed(2)} Net Profit`, 
                text: reportText + `\n\n(Attached: Secure daily JSON backups of your store's database.)`,
                attachments: [
                    { filename: `products_backup_${new Date().toISOString().split('T')[0]}.json`, content: productsBuffer },
                    { filename: `customers_backup_${new Date().toISOString().split('T')[0]}.json`, content: customersBuffer },
                    { filename: `todays_orders_backup_${new Date().toISOString().split('T')[0]}.json`, content: todaysOrdersBuffer }
                ]
            });
            fastify.log.info('11:15 PM EOD Email & Backup sent successfully.');
        } else {
            fastify.log.warn('Skipped Email Backup: Missing variables in .env');
        }

        if (process.env.WA_PHONE_NUMBER && process.env.CALLMEBOT_API_KEY) {
            const encodedText = encodeURIComponent(reportText);
            const waUrl = `https://api.callmebot.com/whatsapp.php?phone=${process.env.WA_PHONE_NUMBER}&text=${encodedText}&apikey=${process.env.CALLMEBOT_API_KEY}`;
            
            await axios.get(waUrl);
            fastify.log.info('EOD WhatsApp sent successfully.');
        } else {
            fastify.log.warn('Skipped WhatsApp EOD: Missing variables in .env');
        }

    } catch (err) {
        fastify.log.error('11:15 PM EOD CRON Job Error:', err);
    }
});

const startServer = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        fastify.log.info('Successfully connected to MongoDB Atlas');
        
        await fastify.listen({ port: PORT, host: '0.0.0.0' });
    } catch (err) {
        console.error('CRITICAL ERROR CONNECTING TO MONGODB:', err.message);
        process.exit(1);
    }
};

startServer();
