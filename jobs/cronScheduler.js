const cron = require('node-cron');
const mongoose = require('mongoose');
const Product = require('../models/Product'); 
const Order = require('../models/Order');     
const Expense = require('../models/Expense'); 
const Customer = require('../models/Customer'); 
const nodemailer = require('nodemailer');    
const axios = require('axios');              
const cloudinary = require('cloudinary').v2; 

// --- NEW IMPORTS FOR MEMORY OPTIMIZATION ---
const fs = require('fs');
const path = require('path');
const os = require('os');

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

async function runWithLock(jobName, fastify, task) {
    try {
        const lockSchema = new mongoose.Schema({ jobName: { type: String, unique: true }, lockedAt: Date });
        const CronLock = mongoose.models.CronLock || mongoose.model('CronLock', lockSchema);
        
        await CronLock.updateOne({ jobName }, { $setOnInsert: { jobName, lockedAt: null } }, { upsert: true }).catch(() => true);

        const tenMinsAgo = new Date(Date.now() - 10 * 60 * 1000);
        const lock = await CronLock.findOneAndUpdate(
            { jobName, $or: [{ lockedAt: null }, { lockedAt: { $lt: tenMinsAgo } }] },
            { $set: { lockedAt: new Date() } }
        );

        if (!lock) {
            fastify.log.info(`[CRON] ${jobName} skipped (locked by another server instance).`);
            return; 
        }

        await task();
        await CronLock.updateOne({ jobName }, { $set: { lockedAt: null } });
    } catch (error) {
        fastify.log.error(`[CRON] Lock Error in ${jobName}:`, error);
        const CronLock = mongoose.models.CronLock;
        if (CronLock) await CronLock.updateOne({ jobName }, { $set: { lockedAt: null } }).catch(() => true);
    }
}

// --- OPTIMIZATION HELPERS: Cursor to File Stream ---
// Writes large collections directly to disk in chunks to avoid Out-Of-Memory crashes
const createBackupFile = async (model, filename) => {
    const filePath = path.join(os.tmpdir(), filename);
    const writeStream = fs.createWriteStream(filePath);
    writeStream.write('[\n');
    const cursor = model.find({}).lean().cursor();
    
    let isFirst = true;
    for await (const doc of cursor) {
        if (!isFirst) writeStream.write(',\n');
        writeStream.write(JSON.stringify(doc));
        isFirst = false;
    }
    
    writeStream.write('\n]');
    writeStream.end();
    
    await new Promise(resolve => writeStream.on('finish', resolve));
    return filePath;
};

const uploadFileToCloudinary = (filePath, filename) => {
    return new Promise((resolve, reject) => {
        cloudinary.uploader.upload(filePath, { 
            resource_type: 'raw', 
            public_id: `backups/${filename}`, 
            format: 'json' 
        }, (error, result) => {
            if (error) reject(error);
            else resolve(result.secure_url);
        });
    });
};

module.exports = function(fastify, updateInventoryReport) {
    
    // --- Routine Deliveries Automation ---
    cron.schedule('0 6 * * *', () => {
        runWithLock('RoutineDeliveries', fastify, async () => {
            fastify.log.info('Running 6:00 AM Routine Deliveries CRON Job...');
            try {
                const routineOrders = await Order.find({ deliveryType: 'Routine', status: { $ne: 'Cancelled' } }).lean();
                
                if (routineOrders.length > 0) {
                    const newOrdersToInsert = routineOrders.map(ro => ({
                        customerName: ro.customerName,
                        customerPhone: ro.customerPhone,
                        deliveryAddress: ro.deliveryAddress,
                        items: ro.items,
                        totalAmount: ro.totalAmount,
                        paymentMethod: ro.paymentMethod,
                        deliveryType: 'Instant', 
                        scheduleTime: 'Generated via Routine',
                        status: 'Order Placed'
                    }));
                    
                    await Order.insertMany(newOrdersToInsert);
                }
                fastify.log.info(`Successfully generated ${routineOrders.length} routine orders for today.`);
            } catch (err) {
                fastify.log.error('6:00 AM Routine CRON Job Error:', err);
            }
        });
    });

    // --- Daily Inventory & Velocity ---
    cron.schedule('0 9 * * *', () => {
        runWithLock('DailyInventory', fastify, async () => {
            fastify.log.info('Running Daily Inventory & Velocity CRON Job...');
            try {
                const velocityDays = Number(process.env.VELOCITY_DAYS) || 14;
                const lowStockThreshold = Number(process.env.LOW_STOCK_THRESHOLD) || 5;
                const deadStockQty = Number(process.env.DEAD_STOCK_QTY) || 15;
                const deadStockDays = Number(process.env.DEAD_STOCK_DAYS) || 30;

                const dateAgo = new Date();
                dateAgo.setDate(dateAgo.getDate() - velocityDays);

                const velocityAgg = await Order.aggregate([
                    { 
                        $match: { 
                            createdAt: { $gte: dateAgo },
                            status: { $in: ['Completed', 'Dispatched'] }
                        } 
                    },
                    { $unwind: "$items" },
                    { 
                        $group: { 
                            _id: "$items.variantId", 
                            totalSold: { $sum: "$items.qty" } 
                        } 
                    }
                ]);

                let variantSales = {};
                velocityAgg.forEach(v => {
                    if (v._id) variantSales[v._id.toString()] = v.totalSold;
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

                if (updateInventoryReport) {
                    updateInventoryReport({
                        lowStock: lowStockItems,
                        deadStock: deadStockItems,
                        lastGenerated: new Date()
                    });
                }

                if (lowStockItems.length > 0 && process.env.EMAIL_USER && process.env.EMAIL_PASS && process.env.TARGET_EMAIL) {
                    const transporter = nodemailer.createTransport({
                        service: 'gmail',
                        auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
                    });
                    
                    let htmlList = lowStockItems.map(item => `<li><strong>${item.name} (${item.variant})</strong> - Stock: <span style="color:red;">${item.stock}</span> (Runway: ${item.daysLeft} days)</li>`).join('');
                    
                    const htmlContent = `
                        <h2 style="color: #dc2626;">Daily Inventory Alert: Low Stock ⚠️</h2>
                        <p>The following <strong>${lowStockItems.length} items</strong> have fallen below their minimum stock threshold or have less than 3 days of runway left:</p>
                        <ul>${htmlList}</ul>
                        <p>Log in to the DailyPick Admin Panel to process Supplier Purchase Orders.</p>
                    `;

                    await transporter.sendMail({
                        from: `"DailyPick Server" <${process.env.EMAIL_USER}>`,
                        to: process.env.TARGET_EMAIL,
                        subject: `⚠️ Action Required: ${lowStockItems.length} items need restock`, 
                        html: htmlContent
                    });
                    fastify.log.info('9:00 AM Low Stock Email Alert sent successfully.');
                }

                fastify.log.info(`CRON REPORT: ${lowStockItems.length} Low Stock, ${deadStockItems.length} Dead Stock.`);
            } catch (err) {
                fastify.log.error('CRON Job Error:', err);
            }
        });
    });

    // --- EOD Report & Backup ---
    cron.schedule('15 23 * * *', () => {
        runWithLock('EODBackup', fastify, async () => {
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
                let reportText = `📈 *DailyPick EOD Report*\nDate: ${dateString}\n\n` +
                                 `*Total Orders:* ${todaysOrders.length}\n` +
                                 `*Gross Revenue:* ₹${totalRevenue.toFixed(2)}\n\n` +
                                 `*Breakdown:*\n` +
                                 `💵 Cash: ₹${cash.toFixed(2)}\n` +
                                 `📱 UPI: ₹${upi.toFixed(2)}\n` +
                                 `⏳ Pay Later: ₹${payLater.toFixed(2)}\n\n` +
                                 `*Expenses & Profit:*\n` +
                                 `📉 Total Expenses: ₹${totalExpenses.toFixed(2)}\n` +
                                 `💰 Net Profit: ₹${netProfit.toFixed(2)}\n\n`;

                const datePrefix = new Date().toISOString().split('T')[0];
                let emailAppend = '';

                try {
                    // --- OPTIMIZATION REPLACEMENT: Buffer replaced with streaming file writes ---
                    const productsPath = await createBackupFile(Product, `products_${datePrefix}.json`);
                    const customersPath = await createBackupFile(Customer, `customers_${datePrefix}.json`);
                    
                    const ordersPath = path.join(os.tmpdir(), `orders_${datePrefix}.json`);
                    fs.writeFileSync(ordersPath, JSON.stringify(todaysOrders, null, 2));

                    const [prodUrl, custUrl, orderUrl] = await Promise.all([
                        uploadFileToCloudinary(productsPath, `products_${datePrefix}`),
                        uploadFileToCloudinary(customersPath, `customers_${datePrefix}`),
                        uploadFileToCloudinary(ordersPath, `orders_${datePrefix}`)
                    ]);

                    // Cleanup temporary files
                    fs.unlinkSync(productsPath);
                    fs.unlinkSync(customersPath);
                    fs.unlinkSync(ordersPath);

                    emailAppend = `\n\nSecure Database Backups (Valid via Cloudinary):\n📦 Products: ${prodUrl}\n👥 Customers: ${custUrl}\n🛒 Orders: ${orderUrl}`;
                } catch (cloudinaryErr) {
                    fastify.log.error('Cloudinary Backup Failed:', cloudinaryErr);
                    emailAppend = `\n\n(Warning: Secure Cloudinary Backups failed. Check API Keys.)`;
                }

                // --- ISOLATION: Try/Catch wrappers around external services ---
                if (process.env.EMAIL_USER && process.env.EMAIL_PASS && process.env.TARGET_EMAIL) {
                    try {
                        const transporter = nodemailer.createTransport({
                            service: 'gmail',
                            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
                        });
                        
                        await transporter.sendMail({
                            from: `"DailyPick Server" <${process.env.EMAIL_USER}>`,
                            to: process.env.TARGET_EMAIL,
                            subject: `EOD Report & Backup: ₹${netProfit.toFixed(2)} Net Profit`, 
                            text: reportText + emailAppend
                        });
                        fastify.log.info('11:15 PM EOD Email sent successfully.');
                    } catch (emailErr) {
                        fastify.log.error('Failed to send EOD Email:', emailErr);
                    }
                }

                if (process.env.WA_PHONE_NUMBER && process.env.CALLMEBOT_API_KEY) {
                    try {
                        const encodedText = encodeURIComponent(reportText + `Great work today! 🚀`);
                        const waUrl = `https://api.callmebot.com/whatsapp.php?phone=${process.env.WA_PHONE_NUMBER}&text=${encodedText}&apikey=${process.env.CALLMEBOT_API_KEY}`;
                        
                        await axios.get(waUrl);
                        fastify.log.info('EOD WhatsApp sent successfully.');
                    } catch (waErr) {
                        fastify.log.error('Failed to send EOD WhatsApp:', waErr);
                    }
                }

            } catch (err) {
                fastify.log.error('11:15 PM EOD CRON Job Error:', err);
            }
        });
    });
};
