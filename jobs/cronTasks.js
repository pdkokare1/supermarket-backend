/* jobs/cronTasks.js */

const mongoose = require('mongoose');
const Product = require('../models/Product'); 
const Order = require('../models/Order');     
const Customer = require('../models/Customer'); 
const cloudinary = require('cloudinary').v2; 

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib'); 

// --- IMPORTED MODULAR SERVICES ---
const inventoryService = require('../services/inventoryService');
const jobsService = require('../services/jobsService'); 
const auditService = require('../services/auditService');
const analyticsService = require('../services/analyticsService'); 
const notificationService = require('../services/notificationService'); 

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const lockSchema = new mongoose.Schema({ jobName: { type: String, unique: true }, lockedAt: Date });
const CronLock = mongoose.models.CronLock || mongoose.model('CronLock', lockSchema);

// ==========================================
// --- CRON JOB EXPORTS ---
// ==========================================

async function runWithLock(jobName, fastify, task) {
    // OPTIMIZATION: Enterprise Redis Distributed Lock
    // Uses atomic SET NX (Not eXists) to guarantee only ONE core in the cluster acquires the lock.
    const lockKey = `cron_lock:${jobName}`;
    const lockTTLSeconds = 10 * 60; // 10 minutes max lock time
    
    try {
        const acquired = await fastify.redis.set(lockKey, 'LOCKED', 'EX', lockTTLSeconds, 'NX');
        
        if (!acquired) {
            fastify.log.info(`[CRON] ${jobName} skipped (locked by another cluster worker via Redis).`);
            return;
        }

        // DEPRECATION CONSULTATION:
        // The MongoDB locking logic below has been replaced by the Redis lock above for faster, atomic operations.
        // It is commented out rather than deleted per your strict requirements.
        /*
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
        */

        await task();
        
        // MongoDB lock release (Commented out)
        // await CronLock.updateOne({ jobName }, { $set: { lockedAt: null } });

    } catch (error) {
        fastify.log.error(`[CRON] Lock Error in ${jobName}:`, error);
        // MongoDB error fallback (Commented out)
        // if (CronLock) await CronLock.updateOne({ jobName }, { $set: { lockedAt: null } }).catch(() => true);
    } finally {
        // OPTIMIZATION: Guarantee lock release via Redis even if the task fails
        await fastify.redis.del(lockKey).catch(() => true);
    }
}

const createBackupFile = async (model, filename, query = {}) => {
    const filePath = path.join(os.tmpdir(), `${filename}.gz`);
    const fileStream = fs.createWriteStream(filePath);
    const gzipStream = zlib.createGzip();

    gzipStream.pipe(fileStream);
    gzipStream.write('[\n');
    
    const cursor = model.find(query).lean().cursor();
    
    let isFirst = true;
    
    for await (const doc of cursor) {
        if (!isFirst) {
            const canWriteComma = gzipStream.write(',\n');
            if (!canWriteComma) await new Promise(resolve => gzipStream.once('drain', resolve));
        }
        
        // DEPRECATION CONSULTATION:
        // Ignoring backpressure causes silent Out-Of-Memory crashes.
        /*
        gzipStream.write(JSON.stringify(doc));
        isFirst = false;
        counter++;
        if (counter % 100 === 0) {
            await new Promise(resolve => setImmediate(resolve));
        }
        */

        // OPTIMIZED: Strict memory backpressure handling
        const canWrite = gzipStream.write(JSON.stringify(doc));
        isFirst = false;
        
        if (!canWrite) {
            await new Promise(resolve => gzipStream.once('drain', resolve));
        } else {
            // Still yield to event loop occasionally if buffer is empty but stream is busy
            await new Promise(resolve => setImmediate(resolve));
        }
    }
    
    gzipStream.write('\n]');
    gzipStream.end();
    
    await new Promise(resolve => fileStream.on('finish', resolve));
    return filePath;
};

const uploadFileToCloudinary = async (filePath, filename, retries = 3) => {
    for (let i = 0; i < retries; i++) {
        try {
            return await new Promise((resolve, reject) => {
                cloudinary.uploader.upload(filePath, { 
                    resource_type: 'raw', 
                    public_id: `backups/${filename}`, 
                    format: 'json' 
                }, (error, result) => {
                    if (error) reject(error);
                    else resolve(result.secure_url);
                });
            });
        } catch (error) {
            if (i === retries - 1) throw error;
            await new Promise(res => setTimeout(res, 2000)); 
        }
    }
};

async function runExpiryMonitor(fastify) {
    fastify.log.info('Running 12:00 AM Expiry & Wastage Monitor CRON Job...');
    try {
        const expiringItems = await inventoryService.getExpiringProducts(7);

        if (expiringItems.length > 0) {
            fastify.log.warn(`[WASTAGE WARNING] ${expiringItems.length} items expiring within 7 days.`);
            if (fastify.broadcastToPOS) {
                fastify.broadcastToPOS({ 
                    type: 'EXPIRY_WARNING', 
                    message: `⚠️ ${expiringItems.length} items are nearing expiry! Push these items today to prevent wastage.`,
                    items: expiringItems 
                });
            }
        }
    } catch(err) {
        fastify.log.error('Expiry Monitor Error:', err);
    }
}

async function runDataRetentionCleanup(fastify) {
    fastify.log.info('Running 3:00 AM Data Retention Cleanup (90 Days)...');
    try {
        const deletedOrders = await jobsService.deleteOldCancelledOrders(90);
        const deletedLogs = await auditService.deleteOldAuditLogs(90);

        fastify.log.info(`[CLEANUP] Deleted ${deletedOrders.deletedCount} old cancelled orders and ${deletedLogs.deletedCount} old audit logs.`);
    } catch(err) {
        fastify.log.error('Data Retention Cleanup Error:', err);
    }
}

async function runRoutineDeliveries(fastify) {
    fastify.log.info('Running 6:00 AM Routine Deliveries CRON Job...');
    try {
        const generatedCount = await jobsService.generateRoutineDeliveries();
        if (generatedCount > 0) {
            fastify.log.info(`Successfully generated ${generatedCount} routine orders for today.`);
        }
    } catch (err) {
        fastify.log.error('6:00 AM Routine CRON Job Error:', err);
    }
}

async function runDailyInventory(fastify, updateInventoryReport) {
    fastify.log.info('Running Daily Inventory & Velocity CRON Job...');
    try {
        const velocityDays = Number(process.env.VELOCITY_DAYS) || 14;
        const lowStockThreshold = Number(process.env.LOW_STOCK_THRESHOLD) || 5;
        const deadStockQty = Number(process.env.DEAD_STOCK_QTY) || 15;
        const deadStockDays = Number(process.env.DEAD_STOCK_DAYS) || 30;

        const { lowStockItems, deadStockItems } = await inventoryService.calculateSalesVelocityAndStock(
            velocityDays, lowStockThreshold, deadStockQty, deadStockDays
        );

        if (updateInventoryReport) {
            updateInventoryReport({
                lowStock: lowStockItems,
                deadStock: deadStockItems,
                lastGenerated: new Date()
            });
        }

        if (lowStockItems.length > 0) {
            let htmlList = lowStockItems.map(item => `<li><strong>${item.name} (${item.variant})</strong> - Stock: <span style="color:red;">${item.stock}</span> (Runway: ${item.daysLeft} days)</li>`).join('');
            
            const htmlContent = `
                <h2 style="color: #dc2626;">Daily Inventory Alert: Low Stock ⚠️</h2>
                <p>The following <strong>${lowStockItems.length} items</strong> have fallen below their minimum stock threshold or have less than 3 days of runway left:</p>
                <ul>${htmlList}</ul>
                <p>Log in to the DailyPick Admin Panel to process Supplier Purchase Orders.</p>
            `;

            const emailSent = await notificationService.sendAdminEmail(fastify, `⚠️ Action Required: ${lowStockItems.length} items need restock`, htmlContent);
            if (emailSent) fastify.log.info('9:00 AM Low Stock Email Alert sent successfully.');
        }

        fastify.log.info(`CRON REPORT: ${lowStockItems.length} Low Stock, ${deadStockItems.length} Dead Stock.`);
    } catch (err) {
        fastify.log.error('CRON Job Error:', err);
    }
}

async function runEODBackup(fastify) {
    fastify.log.info('Running 11:59 PM EOD Report & Backup CRON Job...');
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const todayStr = new Date().toDateString();

        const f = await analyticsService.getDailyFinancialTotals(today, tomorrow, todayStr);

        const dateString = new Date().toLocaleDateString();
        let reportText = `📈 *DailyPick EOD Report*\nDate: ${dateString}\n\n` +
                         `*Total Orders:* ${f.totalOrderCount}\n` +
                         `*Gross Revenue:* Rs ${f.totalRevenue.toFixed(2)}\n\n` +
                         `*Breakdown:*\n` +
                         `💵 Cash: Rs ${f.cash.toFixed(2)}\n` +
                         `📱 UPI: Rs ${f.upi.toFixed(2)}\n` +
                         `⏳ Pay Later: Rs ${f.payLater.toFixed(2)}\n\n` +
                         `*Expenses & Profit:*\n` +
                         `📉 Total Expenses: Rs ${f.totalExpenses.toFixed(2)}\n` +
                         `💰 Net Profit: Rs ${f.netProfit.toFixed(2)}\n\n`;

        const datePrefix = new Date().toISOString().split('T')[0];
        let emailAppend = '';

        let productsPath = null;
        let customersPath = null;
        let ordersPath = null;

        try {
            productsPath = await createBackupFile(Product, `products_${datePrefix}.json`);
            customersPath = await createBackupFile(Customer, `customers_${datePrefix}.json`);
            
            ordersPath = await createBackupFile(Order, `orders_${datePrefix}.json`, {
                createdAt: { $gte: today, $lt: tomorrow },
                status: { $ne: 'Cancelled' }
            });

            const [prodUrl, custUrl, orderUrl] = await Promise.all([
                uploadFileToCloudinary(productsPath, `products_${datePrefix}.json.gz`),
                uploadFileToCloudinary(customersPath, `customers_${datePrefix}.json.gz`),
                uploadFileToCloudinary(ordersPath, `orders_${datePrefix}.json.gz`)
            ]);

            emailAppend = `\n\nSecure Database Backups (Valid via Cloudinary):\n📦 Products: ${prodUrl}\n👥 Customers: ${custUrl}\n🛒 Orders: ${orderUrl}`;
        } catch (cloudinaryErr) {
            fastify.log.error('Cloudinary Backup Failed:', cloudinaryErr);
            emailAppend = `\n\n(Warning: Secure Cloudinary Backups failed. Check API Keys.)`;
            
            await notificationService.sendAdminWhatsApp(fastify, `CRITICAL: Cloudinary Backup Failed for ${dateString}.`);
        } finally {
            if (productsPath && fs.existsSync(productsPath)) fs.unlinkSync(productsPath);
            if (customersPath && fs.existsSync(customersPath)) fs.unlinkSync(customersPath);
            if (ordersPath && fs.existsSync(ordersPath)) fs.unlinkSync(ordersPath);
        }

        const emailSent = await notificationService.sendAdminEmail(fastify, `EOD Report & Backup: Rs ${f.netProfit.toFixed(2)} Net Profit`, null, reportText + emailAppend);
        if (emailSent) fastify.log.info('11:59 PM EOD Email sent successfully.');

        const waSent = await notificationService.sendAdminWhatsApp(fastify, reportText + `Great work today! 🚀`);
        if (waSent) fastify.log.info('EOD WhatsApp sent successfully.');

    } catch (err) {
        fastify.log.error('11:59 PM EOD CRON Job Error:', err);
    }
}

async function runCloudinaryCleanup(fastify) {
    fastify.log.info('Running 2:00 AM Backup Cleanup CRON Job (90 Days Retention)...');
    try {
        const date90 = new Date();
        date90.setDate(date90.getDate() - 90);
        const datePrefix = date90.toISOString().split('T')[0];
        
        const publicIds = [
            `backups/products_${datePrefix}.json.gz`,
            `backups/customers_${datePrefix}.json.gz`,
            `backups/orders_${datePrefix}.json.gz`,
            `backups/products_${datePrefix}`,
            `backups/customers_${datePrefix}`,
            `backups/orders_${datePrefix}`
        ];
        
        const result = await cloudinary.api.delete_resources(publicIds, { type: 'upload', resource_type: 'raw' });
        fastify.log.info(`Deleted old backups from ${datePrefix}:`, result);
    } catch(err) {
        fastify.log.error('Backup Cleanup Error:', err);
    }
}

module.exports = {
    runWithLock,
    runExpiryMonitor,
    runDataRetentionCleanup,
    runRoutineDeliveries,
    runDailyInventory,
    runEODBackup,
    runCloudinaryCleanup
};
