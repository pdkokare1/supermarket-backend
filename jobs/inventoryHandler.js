/* jobs/inventoryHandler.js */

const cacheUtils = require('../utils/cacheUtils');
const StoreInventory = require('../models/StoreInventory');
const MasterProduct = require('../models/MasterProduct');
const https = require('https'); // For downloading massive ERP dumps
const csvUtils = require('../utils/csvUtils');

exports.handleInventoryReport = async (redisClient, fastify, newReport) => {
    // OPTIMIZED: Replaced raw redis call with centralized cacheUtils
    await cacheUtils.setCachedData('cache:inventory:report', newReport, 86400); 
};

// --- NEW: PHASE 1 ASYNC INGESTION WORKER ---
// Offloads heavy 500MB+ CSV parsing from legacy ERPs to the background
exports.processEnterpriseBatchUpload = async (fastify, payload) => {
    const { storeId, fileUrl } = payload;
    
    fastify.log.info(`[BACKGROUND WORKER] Starting Enterprise Batch Import for Store ${storeId}`);

    try {
        // Stream the file directly from S3/URL to avoid loading 500MB into memory
        https.get(fileUrl, async (res) => {
            if (res.statusCode !== 200) {
                fastify.log.error(`Failed to download batch file: Status ${res.statusCode}`);
                return;
            }

            let successCount = 0;

            // Utilize existing memory-safe stream processor from utils/csvUtils.js
            await csvUtils.processCsvStream(res, 1000, async (batch) => {
                const bulkOps = [];

                for (const row of batch) {
                    // ERP CSV Expected format: sku, stock, price
                    if (!row.sku) continue; 

                    // Cross-reference with our Universal Master Data Hub
                    const masterDoc = await MasterProduct.findOne({ "variants.sku": row.sku }).lean();
                    if (!masterDoc) continue;

                    bulkOps.push({
                        updateOne: {
                            filter: { storeId: storeId, masterProductId: masterDoc._id },
                            update: {
                                $set: {
                                    stockCount: Number(row.stock) || 0,
                                    sellingPrice: Number(row.price) || 0
                                }
                            },
                            upsert: true
                        }
                    });
                }

                if (bulkOps.length > 0) {
                    const result = await StoreInventory.bulkWrite(bulkOps);
                    successCount += result.modifiedCount + result.upsertedCount;
                }
            });

            fastify.log.info(`[BACKGROUND WORKER] Batch Import Complete. Upserted ${successCount} items for Store ${storeId}.`);
            // Cache invalidation could go here
        });

    } catch (error) {
        fastify.log.error(`[BACKGROUND WORKER] Fatal Error in Batch Ingestion: ${error.message}`);
    }
};
