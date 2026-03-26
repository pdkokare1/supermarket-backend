const Product = require('../models/Product');
const Store = require('../models/Store');
const Register = require('../models/Register');

async function migrateRoute(fastify, options) {
    // Hidden, one-time route to safely migrate legacy data
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
}

module.exports = migrateRoute;
