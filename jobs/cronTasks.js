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

// --- NEW IMPORT FOR INGESTION WORKER ---
const inventoryHandler = require('./inventoryHandler');

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
    const lockKey = `cron_lock:${jobName}`;
    const lockTTLSeconds = 10 * 60; 
    try {
        const acquired = await fastify.redis.set(lockKey, 'LOCKED', 'EX', lockTTLSeconds, 'NX');
        if (!acquired) {
            fastify.log.info(`[CRON] ${jobName} skipped (locked by another cluster worker via Redis).`);
            return;
        }
        await task();
    } catch (error) {
        fastify.log.error(`[CRON] Lock Error in ${jobName}:`, error);
    } finally {
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
    let docCount = 0; 
    
    for await (const doc of cursor) {
        docCount++;
        if (!isFirst) {
            const canWriteComma = gzipStream.write(',\n');
            if (!canWriteComma) await new Promise(resolve => gzipStream.once('drain', resolve));
        }
        const canWrite = gzipStream.write(JSON.stringify(doc));
        isFirst = false;
        
        if (!canWrite) {
            await new Promise(resolve => gzipStream.once('drain', resolve));
        } else if (docCount % 500 === 0) {
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

// --- NEW: PHASE 1 MASSIVE DATA INGESTION PIPELINE ---
// Scheduled job to pull legacy ERP dumps from a specific URL or S3 bucket overnight
async function runEnterpriseIngestionSync(fastify) {
    fastify.log.info('Running 2:00 AM Enterprise Ingestion Sync...');
    try {
        // In production, this would query a configuration table to find active Enterprise SFTP drops.
        // Firing the background worker without blocking the event loop:
        const mockPayload = {
            storeId: process.env.ENTERPRISE_SYNC_STORE_ID || 'DEFAULT_ENTERPRISE_ID',
            fileUrl: process.env.ENTERPRISE_SYNC_CSV_URL || 'https://example.com/daily-dump.csv'
        };

        if (mockPayload.fileUrl !== 'https://example.com/daily-dump.csv') {
            await inventoryHandler.processEnterpriseBatchUpload(fastify, mockPayload);
        } else {
            fastify.log.info('[CRON] Ingestion Sync skipped: No active CSV URL configured in environment variables.');
        }

    } catch(err) {
        fastify.log.error('Enterprise Ingestion Sync Error:', err);
    }
}

// ============================================================================
// --- NEW: PHASE 5 AUTONOMOUS B2B PROCUREMENT ENGINE ---
// ============================================================================
async function runAutonomousB2BProcurement(fastify) {
    fastify.log.info('Running Autonomous B2B Procurement Cron...');
    try {
        const StoreInventory = require('../models/StoreInventory');
        const enterpriseController = require('../controllers/enterpriseController');
        
        // Scan the entire database for any local inventory that has fallen below threshold
        const lowStockItems = await StoreInventory.find({ $expr: { $lte: ["$stock", "$lowStockThreshold"] } }).lean();
        let generatedPOCount = 0;

        for (const item of lowStockItems) {
            try {
                // Synthesize the internal Request to route to the lowest-cost Distributor securely
                const mockRequest = {
                    body: {
                        storeId: item.storeId.toString(),
                        masterProductId: item.masterProductId.toString(),
                        variantId: item.variantId.toString(),
                        requestedQty: Math.max(10, item.lowStockThreshold * 2), // Order double threshold or minimum 10
                        deliveryPincode: '400001' // Defaulting to active zone
                    }
                };
                
                // Let the Enterprise engine handle distributor matching and drafting
                await enterpriseController.createB2BPurchaseOrder(mockRequest, null);
                generatedPOCount++;
            } catch (e) {
                // Safely suppress individual drafting failures (e.g. no distributor found) so the loop continues
            }
        }
        
        fastify.log.info(`[AUTONOMOUS B2B] Auto-Drafted ${generatedPOCount} Purchase Orders successfully.`);
    } catch (err) {
        fastify.log.error('Auto-Restock Engine Error:', err);
    }
}

// ============================================================================
// --- NEW: PHASE 17 AUTOMATED B2B SETTLEMENT ENGINE ---
// ============================================================================
async function runEnterpriseSettlements(fastify) {
    fastify.log.info('Running Weekly B2B Enterprise Settlement Cron...');
    try {
        const Store = require('../models/Store');
        const Settlement = require('../models/Settlement');
        
        // Find all Delivered enterprise orders that haven't been settled yet.
        // The aggregate query ensures we don't process an order twice by joining the settlements table.
        const unsettledOrders = await Order.aggregate([
            { $match: { fulfillmentType: 'STORE_DELIVERY', status: 'Delivered' } },
            { 
                $lookup: {
                    from: 'settlements',
                    localField: '_id',
                    foreignField: 'orderId',
                    as: 'existingSettlement'
                }
            },
            { $match: { existingSettlement: { $size: 0 } } }
        ]);

        let processedCount = 0;
        let totalPayoutRs = 0;

        for (const order of unsettledOrders) {
            const store = await Store.findById(order.storeId);
            if (!store) continue;

            // Commercial Terms Calculation (Dynamic Engine)
            const commissionRate = store.commercialTerms?.commissionValue || 5.0;
            const platformCommission = (order.totalAmount * commissionRate) / 100;
            // E.g., Razorpay charges a flat 2% on online transactions
            const gatewayFee = order.paymentMethod === 'Online' ? (order.totalAmount * 0.02) : 0; 
            const netPayout = order.totalAmount - platformCommission - gatewayFee;

            await Settlement.create({
                storeId: store._id,
                orderId: order._id,
                orderNumber: order.orderNumber || order._id.toString().slice(-6),
                totalOrderValue: order.totalAmount,
                platformCommission: platformCommission,
                gatewayFee: gatewayFee,
                netPayoutToStore: netPayout,
                commissionTypeApplied: store.commercialTerms?.commissionType || 'PERCENTAGE',
                status: 'Pending', // Awaits finance team approval or automated direct deposit
                isEnterprisePayout: true,
                marketingAttributionId: order.partnerTrackingId || null
            });
            
            processedCount++;
            totalPayoutRs += netPayout;
        }

        if (processedCount > 0) {
            fastify.log.info(`[B2B SETTLEMENTS] Generated ${processedCount} new settlement records. Total Pending Ledger Payout: Rs ${totalPayoutRs.toFixed(2)}`);
        }
    } catch (err) {
        fastify.log.error('B2B Settlement Engine Error:', err);
    }
}

// ============================================================================
// --- NEW: PHASE 18 AUTOMATED RIDER PAYOUT LEDGER ---
// ============================================================================
async function runRiderPayouts(fastify) {
    fastify.log.info('Running Weekly Rider Payout Ledger Cron...');
    try {
        const Settlement = require('../models/Settlement');
        
        // Scan for successfully delivered Platform Fleet orders that haven't been paid out yet
        const deliveredPlatformOrders = await Order.aggregate([
            { $match: { fulfillmentType: 'PLATFORM_DELIVERY', status: 'Delivered', deliveryDriverName: { $ne: 'Unassigned' } } },
            { $lookup: { from: 'settlements', localField: '_id', foreignField: 'orderId', as: 'existing' } },
            { $match: { existing: { $size: 0 } } }
        ]);

        let count = 0;
        let totalPayout = 0;
        
        for (const order of deliveredPlatformOrders) {
            const dropFee = 40; // Flat Rs 40 per successful drop
            await Settlement.create({
                storeId: order.storeId || new mongoose.Types.ObjectId(), // Tie to store for P&L tracking
                orderId: order._id,
                orderNumber: order.orderNumber || order._id.toString().slice(-6),
                totalOrderValue: 0, 
                platformCommission: 0,
                netPayoutToStore: dropFee, // Used interchangeably here for Rider Payout Value
                status: 'Pending',
                isEnterprisePayout: false,
                disputeReason: `Rider Payout: ${order.deliveryDriverName}` // Hack to store rider name cleanly
            });
            count++;
            totalPayout += dropFee;
        }
        if(count > 0) fastify.log.info(`[RIDER PAYOUTS] Ledger updated. ${count} drops, Total Rs ${totalPayout}`);
    } catch (e) {
        fastify.log.error('Rider Payout Engine Error:', e);
    }
}

// ============================================================================
// --- NEW: PHASE 19 AUTOMATED WHATSAPP CRM (RETENTION ENGINE) ---
// ============================================================================
async function runRetentionCRM(fastify) {
    fastify.log.info('Running Automated Retention CRM Cron...');
    try {
        const Customer = require('../models/Customer');
        
        // Find VIP customers (trust score > 50 or loyalty points > 0) who haven't ordered in exactly 14 days
        const targetDate = new Date();
        targetDate.setDate(targetDate.getDate() - 14);
        
        const startOfDay = new Date(targetDate);
        startOfDay.setHours(0,0,0,0);
        const endOfDay = new Date(targetDate);
        endOfDay.setHours(23,59,59,999);

        const dormantVIPs = await Customer.find({
            lastOrderDate: { $gte: startOfDay, $lte: endOfDay },
            $or: [{ loyaltyPoints: { $gt: 50 } }, { trustScore: { $gt: 80 } }]
        }).lean();

        let messagesSent = 0;
        for (const customer of dormantVIPs) {
            const message = `Hi ${customer.name.split(' ')[0]}! We miss you at DailyPick. 🌟 Use code COMEBACK20 for 20% off your next order. Valid for 48 hours! Order now: https://dailypick.com`;
            
            try {
                if (notificationService.sendCustomerWhatsApp) {
                    await notificationService.sendCustomerWhatsApp(fastify, customer.phone, message);
                } else {
                    fastify.log.info(`[CRM SIMULATION] Would send to ${customer.phone}: ${message}`);
                }
                messagesSent++;
            } catch(e) {}
        }
        
        if (messagesSent > 0) {
            fastify.log.info(`[CRM ENGINE] Sent ${messagesSent} automated win-back campaigns.`);
        }
    } catch (err) {
        fastify.log.error('Retention CRM Engine Error:', err);
    }
}

// ============================================================================
// --- NEW: PHASE 26 ALGORITHMIC STOCK FORECASTING (PREDICTIVE PROCUREMENT) ---
// ============================================================================
async function runDemandForecast(fastify) {
    fastify.log.info('Running Algorithmic Stock Forecasting Cron...');
    try {
        const Order = require('../models/Order');
        const StoreInventory = require('../models/StoreInventory');
        
        // Look at sales velocity over the last 14 days
        const targetDate = new Date();
        targetDate.setDate(targetDate.getDate() - 14);

        // Aggregate all delivered orders to find total quantity sold per variant per store
        const velocityData = await Order.aggregate([
            { $match: { createdAt: { $gte: targetDate }, status: { $in: ['Delivered', 'Completed'] } } },
            { $unwind: "$items" },
            { $group: {
                _id: { storeId: "$storeId", variantId: "$items.variantId" },
                totalSold: { $sum: "$items.qty" }
            }}
        ]);

        let adjustedCount = 0;

        for (const data of velocityData) {
            // Calculate daily velocity
            const dailyVelocity = data.totalSold / 14;
            
            // Set the low stock threshold to 3 days worth of inventory, with an absolute minimum of 5
            const optimalThreshold = Math.max(5, Math.ceil(dailyVelocity * 3));

            // Update the inventory threshold
            const result = await StoreInventory.updateOne(
                { storeId: data._id.storeId, variantId: data._id.variantId, lowStockThreshold: { $ne: optimalThreshold } },
                { $set: { lowStockThreshold: optimalThreshold } }
            );

            if (result.modifiedCount > 0) {
                adjustedCount++;
            }
        }

        if (adjustedCount > 0) {
            fastify.log.info(`[DEMAND FORECAST] Successfully adjusted Low Stock Thresholds for ${adjustedCount} high-velocity items.`);
        }
    } catch (err) {
        fastify.log.error('Demand Forecast Engine Error:', err);
    }
}

// ============================================================================
// --- NEW: PHASE 28 SELF-HEALING LOGISTICS (WATCHDOG AUTO-REASSIGN) ---
// ============================================================================
async function runFleetWatchdog(fastify) {
    fastify.log.info('Running Fleet Watchdog (Self-Healing Logistics)...');
    try {
        const Shift = require('../models/Shift');
        const Order = require('../models/Order');
        const orderService = require('../services/orderService');
        
        // Find riders who haven't pinged their GPS in over 10 minutes
        const tenMinsAgo = new Date(Date.now() - 10 * 60000);
        
        const deadShifts = await Shift.find({
            status: 'ACTIVE',
            role: 'Delivery_Agent',
            lastPingTime: { $lt: tenMinsAgo }
        });

        for (const shift of deadShifts) {
            fastify.log.warn(`[WATCHDOG] Rider ${shift.userName} hasn't pinged in 10 mins. Forcing OFFLINE status.`);
            
            // 1. Kick rider offline so spatial engine stops assigning them new orders
            shift.status = 'Offline';
            await shift.save();

            // 2. Find any active orders currently held hostage by this rider
            const stuckOrders = await Order.find({
                deliveryDriverName: shift.userName,
                status: { $in: ['Dispatched', 'Packing'] }
            });

            for (const order of stuckOrders) {
                fastify.log.warn(`[WATCHDOG] Auto-recovering Order ${order.orderNumber} from dead rider.`);
                
                // Unassign the rider. The existing spatial logic (appEvents) will automatically
                // broadcast this back to the Rider Pool for the next closest active rider to grab.
                await orderService.assignDriverToOrder(order._id, 'Unassigned', '', null);
                
                // Push an alert to Admin Dashboard
                if (fastify.broadcastToPOS) {
                    fastify.broadcastToPOS({ 
                        type: 'WATCHDOG_ALERT', 
                        message: `🚨 Watchdog recovered Order ${order.orderNumber} from inactive rider ${shift.userName}. Re-broadcasting to fleet.`,
                    });
                }
            }
        }
    } catch (err) {
        fastify.log.error('Fleet Watchdog Error:', err);
    }
}

// ============================================================================
// --- NEW: PHASE 29 ABANDONED CART RECOVERY (WIN-BACK ENGINE) ---
// ============================================================================
async function runAbandonedCartRecovery(fastify) {
    fastify.log.info('Running Abandoned Cart Recovery Engine...');
    try {
        const cacheUtils = require('../utils/cacheUtils');
        const redisClient = cacheUtils.getClient();
        
        if (!redisClient) return;

        // Scan Redis for Ghost Order cart sessions that are close to expiring
        // (Assuming TTL was 3600 seconds, look for keys that have < 900 seconds left)
        const keys = await redisClient.keys('cart_session:*');
        let recoveredCount = 0;

        for (const key of keys) {
            const ttl = await redisClient.ttl(key);
            
            // If the cart has been sitting there for ~45 mins (TTL between 0 and 900)
            if (ttl > 0 && ttl <= 900) {
                // Check a separate "notified" flag so we don't spam the user every minute
                const notifiedKey = `notified:${key}`;
                const hasBeenNotified = await redisClient.get(notifiedKey);
                
                if (!hasBeenNotified) {
                    const cartDataStr = await redisClient.get(key);
                    if (cartDataStr) {
                        try {
                            const cartData = JSON.parse(cartDataStr);
                            if (cartData.customerPhone) {
                                const msg = `Hey ${cartData.customerName || 'there'}! You left some items in your DailyPick cart. 🛒 Checkout in the next 30 mins and we'll waive your delivery fee!`;
                                notificationService.sendWhatsAppMessage(cartData.customerPhone, msg).catch(() => {});
                                
                                // Mark as notified for 24 hours
                                await redisClient.set(notifiedKey, 'true', 'EX', 86400);
                                recoveredCount++;
                            }
                        } catch(e) {
                            // Suppress parsing errors on malformed cache
                        }
                    }
                }
            }
        }

        if (recoveredCount > 0) {
            fastify.log.info(`[WIN-BACK ENGINE] Sent ${recoveredCount} abandoned cart notifications.`);
        }
    } catch (err) {
        fastify.log.error('Abandoned Cart Engine Error:', err);
    }
}

// ============================================================================
// --- NEW: PHASE 30 PREDICTIVE FLEET PRE-POSITIONING (HEATMAP ENGINE) ---
// ============================================================================
async function generateFleetHeatmap(fastify) {
    fastify.log.info('Running Predictive Fleet Heatmap Engine...');
    try {
        const Order = require('../models/Order');
        const appEvents = require('../utils/eventEmitter');
        
        // Analyze the previous 24 hours of successful deliveries to predict today's demand
        const yesterday = new Date(Date.now() - 86400000);
        
        // MongoDB Aggregation to cluster orders by GeoJSON coordinates
        const hotspots = await Order.aggregate([
            { $match: { 
                createdAt: { $gte: yesterday }, 
                fulfillmentType: 'PLATFORM_DELIVERY',
                status: 'Delivered',
                'location.coordinates': { $exists: true, $ne: [] }
            }},
            { $group: {
                // Approximate grouping by rounding coordinates (roughly clusters to a few blocks)
                _id: {
                    lat: { $round: [{ $arrayElemAt: ["$location.coordinates", 1] }, 3] },
                    lng: { $round: [{ $arrayElemAt: ["$location.coordinates", 0] }, 3] }
                },
                orderDensity: { $sum: 1 }
            }},
            // Only care about zones with high demand (e.g., > 5 orders yesterday)
            { $match: { orderDensity: { $gte: 5 } } },
            { $sort: { orderDensity: -1 } },
            { $limit: 10 } // Top 10 hottest zones
        ]);

        if (hotspots.length > 0) {
            const formattedHeatmap = hotspots.map(spot => ({
                lat: spot._id.lat,
                lng: spot._id.lng,
                weight: spot.orderDensity
            }));

            // Save to Redis so new riders logging in can fetch it immediately
            const cacheUtils = require('../utils/cacheUtils');
            const redisClient = cacheUtils.getClient();
            if (redisClient) {
                await redisClient.set('fleet_heatmap_live', JSON.stringify(formattedHeatmap), 'EX', 86400); // 24hr TTL
            }

            // Broadcast the new heatmap via SSE directly to active Rider Apps to auto-reroute them
            appEvents.emit('FLEET_HEATMAP_UPDATED', formattedHeatmap);
            
            fastify.log.info(`[HEATMAP ENGINE] Calculated ${hotspots.length} high-density prediction zones. Pushed to active fleet.`);
        }
    } catch (err) {
        fastify.log.error('Fleet Heatmap Engine Error:', err);
    }
}

module.exports = {
    runWithLock,
    runExpiryMonitor,
    runDataRetentionCleanup,
    runRoutineDeliveries,
    runDailyInventory,
    runEODBackup,
    runCloudinaryCleanup,
    runEnterpriseIngestionSync,
    runAutonomousB2BProcurement,
    runEnterpriseSettlements,
    runRiderPayouts,
    runRetentionCRM,
    runDemandForecast,
    runFleetWatchdog,
    runAbandonedCartRecovery,
    generateFleetHeatmap
};
