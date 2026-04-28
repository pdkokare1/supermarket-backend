// Repository: supermarket-backend
// File: routes/migrateRoute.js

const Product = require('../models/Product');
const Store = require('../models/Store');
const Register = require('../models/Register');

// --- NEW: PHASE 3 ENTERPRISE MODELS ---
const MasterProduct = require('../models/MasterProduct');
const StoreInventory = require('../models/StoreInventory');

async function migrateRoute(fastify, options) {
    
    // =========================================================================
    // LEGACY MIGRATION (V2) - PRESERVED EXACTLY AS REQUESTED
    // =========================================================================
    fastify.get('/api/system/migrate-v2', async (request, reply) => {
        try {
            // 1. Create default store if it doesn't exist
            let mainStore = await Store.findOne({ name: 'Main Store' });
            if (!mainStore) {
                mainStore = new Store({ name: 'Main Store', location: 'Headquarters' });
                await mainStore.save();
            }

            // 2. Create default register if it doesn't exist
            let mainRegister = await Register.findOne({ storeId: mainStore._id });
            if (!mainRegister) {
                mainRegister = new Register({ name: 'Counter 1', storeId: mainStore._id });
                await mainRegister.save();
            }

            // 3. Migrate all products safely
            const products = await Product.find({});
            let updatedCount = 0;

            for (const product of products) {
                let needsSave = false;
                if (product.variants) {
                    product.variants.forEach(variant => {
                        // Check if this variant already has stock assigned to the Main Store
                        const hasLoc = variant.locationInventory && variant.locationInventory.find(l => l.storeId.toString() === mainStore._id.toString());
                        
                        if (!hasLoc) {
                            // Safely copy the legacy global stock into the new Store bucket
                            variant.locationInventory.push({
                                storeId: mainStore._id,
                                stock: variant.stock || 0
                            });
                            needsSave = true;
                        }
                    });
                }
                if (needsSave) {
                    await product.save();
                    updatedCount++;
                }
            }

            return { 
                success: true, 
                message: `✅ MIGRATION COMPLETE! Created 'Main Store' & 'Counter 1'. Safely migrated inventory for ${updatedCount} products. You can now log into your POS.`
            };
        } catch (error) {
            fastify.log.error('Migration error:', error);
            return reply.status(500).send({ success: false, message: 'Migration failed. Please check logs.' });
        }
    });

    // =========================================================================
    // NEW: ENTERPRISE ECOSYSTEM MIGRATION (V3)
    // Safely transforms Legacy Products -> Master Catalog + Tenant Inventory
    // =========================================================================
    fastify.get('/api/system/migrate-v3-enterprise', async (request, reply) => {
        try {
            // 1. Ensure we have an active Tenant Store to attach local stock to
            let mainStore = await Store.findOne({ name: 'Main Store' });
            if (!mainStore) {
                mainStore = new Store({ name: 'Main Store', location: 'Headquarters', storeType: 'ENTERPRISE' });
                await mainStore.save();
            }

            const legacyProducts = await Product.find({}).lean();
            let masterCreated = 0;
            let inventoryLinked = 0;

            for (const legacyProduct of legacyProducts) {
                // 2. Build the Universal Global Truth (MasterProduct)
                // Check if we already migrated this to prevent duplicates on multiple script runs
                let master = await MasterProduct.findOne({ name: legacyProduct.name });
                
                if (!master) {
                    master = new MasterProduct({
                        name: legacyProduct.name,
                        category: legacyProduct.category || 'Uncategorized',
                        brand: legacyProduct.brand || 'Generic',
                        imageUrl: legacyProduct.imageUrl || '',
                        description: legacyProduct.description || '',
                        searchTags: legacyProduct.searchTags || '',
                        status: 'ACTIVE', // Automatically approve existing catalog items
                        variants: []
                    });

                    // Map legacy sub-variants to Global Master format
                    if (legacyProduct.variants && legacyProduct.variants.length > 0) {
                        legacyProduct.variants.forEach(v => {
                            master.variants.push({
                                weightOrVolume: v.weightOrVolume || 'N/A',
                                sku: v.sku || `SKU-${Date.now()}-${Math.floor(Math.random() * 1000)}`, // Auto-generate if missing
                                taxRate: v.taxRate || 0
                            });
                        });
                    } else {
                        // Fallback if a legacy product somehow has no variants
                        master.variants.push({ weightOrVolume: 'Standard', sku: `SKU-${Date.now()}` });
                    }

                    await master.save();
                    masterCreated++;
                }

                // 3. Build the Local Tenant Link (StoreInventory)
                // Now link the specific Store's stock and prices to the Master Truth
                for (let i = 0; i < master.variants.length; i++) {
                    const globalVariant = master.variants[i];
                    // Pull the legacy local data (assuming 1-to-1 array mapping for legacy items)
                    const legacyVariant = (legacyProduct.variants && legacyProduct.variants[i]) ? legacyProduct.variants[i] : {};
                    
                    const existingInventory = await StoreInventory.findOne({
                        storeId: mainStore._id,
                        masterProductId: master._id,
                        variantId: globalVariant._id
                    });

                    if (!existingInventory) {
                        const newInventory = new StoreInventory({
                            storeId: mainStore._id,
                            masterProductId: master._id,
                            variantId: globalVariant._id,
                            mrp: Number(legacyVariant.price) || 0,
                            sellingPrice: Number(legacyVariant.price) || 0,
                            stockCount: Number(legacyVariant.stock) || 0,
                            reorderLevel: Number(legacyVariant.lowStockThreshold) || 5,
                            status: (Number(legacyVariant.stock) > 0) ? 'in_stock' : 'out_of_stock'
                        });

                        await newInventory.save();
                        inventoryLinked++;
                    }
                }
            }

            return { 
                success: true, 
                message: `✅ ENTERPRISE MIGRATION COMPLETE! Translated ${legacyProducts.length} legacy items into ${masterCreated} Universal Master Products. Safely linked ${inventoryLinked} Store Inventory records for B2C aggregation.`
            };

        } catch (error) {
            fastify.log.error('Enterprise Migration error:', error);
            return reply.status(500).send({ success: false, message: 'Migration failed. Please check logs.' });
        }
    });
}

module.exports = migrateRoute;
