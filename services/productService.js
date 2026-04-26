/* services/productService.js */
'use strict';

const mongoose = require('mongoose');
const MasterProduct = require('../models/MasterProduct');
const StoreInventory = require('../models/StoreInventory');
const cacheUtils = require('../utils/cacheUtils');
const appEvents = require('../utils/eventEmitter');
const { buildProductQuery, buildInventoryQuery } = require('../utils/queryBuilderUtils');
const { getPaginationOptions, getSortQuery } = require('../utils/paginationUtils');
const { fetchWithCoalescing } = require('./productCacheService');

// CONFIGURATION: Centralized Cache TTL (1 hour)
const CACHE_TTL = 3600;

// MODULARITY: Strictly event-driven. Redis invalidation is deferred to event listeners.
const triggerProductUpdates = async (productId) => {
    appEvents.emit('PRODUCT_UPDATED', { productId, pattern: 'products:*' });
};

exports.getPaginatedProducts = async (queryParams) => {
    const cacheKey = cacheUtils.generateKey('products', queryParams);
    
    return await fetchWithCoalescing(cacheKey, CACHE_TTL, async () => {
        const { limit, skip } = getPaginationOptions(queryParams);
        const sortQuery = getSortQuery(queryParams.sort) || { createdAt: -1 };
        
        // MULTI-TENANT PATH: Stitching local inventory to master catalog
        if (queryParams.storeId) {
            const storeIdObj = new mongoose.Types.ObjectId(queryParams.storeId);
            
            // --- NEW: B2B OMNICHANNEL SEARCH BRIDGE ---
            // If the local store is searching by name/category, we must resolve those against the Master table first.
            let masterIdFilter = {};
            if (queryParams.search || (queryParams.category && queryParams.category !== 'All') || (queryParams.brand && queryParams.brand !== 'All')) {
                const masterQuery = buildProductQuery({ ...queryParams, all: 'true' }); // Ignore master archive status for local search
                const matchedMasters = await MasterProduct.find(masterQuery).select('_id').lean();
                masterIdFilter = { $in: matchedMasters.map(m => m._id) };
            }
            
            // Use the localized query builder to handle stock filters (low, out, dead)
            let inventoryMatch = buildInventoryQuery(queryParams, queryParams.storeId);
            
            // Inject the master ID filter if a text/category search was performed
            if (Object.keys(masterIdFilter).length > 0) {
                inventoryMatch.masterProductId = masterIdFilter;
            }

            // Group the individual inventory SKUs back into logical products
            const pipeline = [
                { $match: inventoryMatch },
                { $group: {
                    _id: '$masterProductId',
                    variants: { $push: '$$ROOT' }
                }},
                { $skip: skip },
                { $limit: limit || 50 }
            ];
            
            const groupedInventory = await StoreInventory.aggregate(pipeline);
            const masterIds = groupedInventory.map(g => g._id);
            
            const totalAgg = await StoreInventory.aggregate([
                { $match: inventoryMatch },
                { $group: { _id: '$masterProductId' } },
                { $count: 'total' }
            ]);
            
            const masterProducts = await MasterProduct.find({ _id: { $in: masterIds } }).lean();
            
            // Reconstruct the legacy Product JSON shape to prevent frontend breakage
            const data = masterProducts.map(master => {
                const storeData = groupedInventory.find(g => g._id.toString() === master._id.toString());
                if (!storeData) return master;
                
                const localVariants = master.variants.map(mv => {
                    const localV = storeData.variants.find(sv => sv.variantId.toString() === mv._id.toString());
                    return {
                        ...mv,
                        inventoryId: localV ? localV._id : null,
                        price: localV ? localV.sellingPrice : 0,
                        stock: localV ? localV.stock : 0,
                        lowStockThreshold: localV ? localV.lowStockThreshold : 5,
                        purchaseHistory: localV ? localV.purchaseHistory : [],
                        returnHistory: localV ? localV.returnHistory : [],
                        isActive: localV ? localV.isActive : false
                    };
                });
                
                return { ...master, variants: localVariants };
            });
            
            const totalCount = totalAgg.length ? totalAgg[0].total : 0;
            return { success: true, message: 'Store Inventory fetched successfully', count: data.length, total: totalCount, data };
            
        } else {
            // SUPERADMIN PATH: Global Master Catalog
            const filter = buildProductQuery(queryParams); 
            const [total, products] = await Promise.all([
                MasterProduct.countDocuments(filter),
                MasterProduct.find(filter)
                    .sort(sortQuery)
                    .skip(skip)
                    .limit(limit || 50)
                    .lean() 
            ]);

            return { success: true, message: 'Global Catalog fetched successfully', count: products.length, total: total, data: products };
        }
    });
};

exports.createProduct = async (productData) => {
    const { storeId, name, category, brand, imageUrl, description, searchTags, variants } = productData;
    
    // 1. Single Source of Truth check
    let masterProduct = await MasterProduct.findOne({ name, category, brand });
    
    if (!masterProduct) {
        masterProduct = new MasterProduct({
            name, category, brand, imageUrl, description, searchTags,
            variants: (variants || []).map(v => ({
                weightOrVolume: v.weightOrVolume,
                sku: v.sku || '',
                hsnCode: v.hsnCode || '',
                taxRate: v.taxRate || 0
            }))
        });
        await masterProduct.save();
    }

    // 2. Multi-Tenant Check: Link to the specific store
    if (storeId && variants && variants.length > 0) {
        const inventoryDocs = variants.map((v, index) => {
            // Safe fallback if variant mapping gets out of sync
            const targetVariantId = masterProduct.variants[index] ? masterProduct.variants[index]._id : masterProduct.variants[0]._id;
            
            return {
                storeId,
                masterProductId: masterProduct._id,
                variantId: targetVariantId,
                sellingPrice: Number(v.price) || 0,
                stock: Number(v.stock) || 0,
                lowStockThreshold: Number(v.lowStockThreshold) || 5,
                isActive: true
            };
        });
        await StoreInventory.insertMany(inventoryDocs);
    }

    await triggerProductUpdates(masterProduct._id);
    
    // Return the master product so frontend gets a valid 200 OK response payload
    return masterProduct; 
};

exports.updateProduct = async (productId, updateData) => {
    const { storeId, _id, isArchived, isActive, variants, ...safeUpdateData } = updateData;
    
    if (storeId) {
        // TENANT OVERRIDE: Update local pricing and stock
        if (variants && variants.length > 0) {
            for (const v of variants) {
                // If the frontend sends back the inventoryId (we injected it in getPaginatedProducts), use it
                const query = v.inventoryId 
                    ? { _id: v.inventoryId, storeId } 
                    : { storeId, masterProductId: productId, variantId: v._id };
                    
                await StoreInventory.findOneAndUpdate(
                    query,
                    { $set: { sellingPrice: v.price, stock: v.stock, lowStockThreshold: v.lowStockThreshold } },
                    { upsert: true }
                );
            }
        }
        if (isActive !== undefined) {
            await StoreInventory.updateMany({ storeId, masterProductId: productId }, { $set: { isActive } });
        }
        await triggerProductUpdates(productId);
        return { success: true, _id: productId }; 
        
    } else {
        // SUPERADMIN: Update Global Catalog core details
        const updatedProduct = await MasterProduct.findByIdAndUpdate(productId, { $set: safeUpdateData }, { new: true, runValidators: true }).lean();
        if (updatedProduct) {
            await triggerProductUpdates(updatedProduct._id);
        }
        return updatedProduct;
    }
};

exports.archiveProduct = async (productId, storeId = null) => {
    if (storeId) {
        await StoreInventory.updateMany({ storeId, masterProductId: productId }, { $set: { isActive: false } });
        await triggerProductUpdates(productId);
        return { _id: productId, isActive: false };
    } else {
        const product = await MasterProduct.findByIdAndUpdate(
            productId, 
            { $set: { isArchived: true, isActive: false } }, 
            { new: true }
        ).lean();
        if (!product) return null;
        await triggerProductUpdates(product._id);
        return product;
    }
};

exports.toggleProductStatus = async (productId, storeId = null) => {
    if (storeId) {
        // Store owner temporarily hiding a product from their local storefront
        const inventoryRecords = await StoreInventory.find({ storeId, masterProductId: productId });
        if (inventoryRecords.length > 0) {
            const newStatus = !inventoryRecords[0].isActive;
            await StoreInventory.updateMany({ storeId, masterProductId: productId }, { $set: { isActive: newStatus } });
        }
        await triggerProductUpdates(productId);
        return { _id: productId };
    } else {
        // SuperAdmin toggling global availability
        const product = await MasterProduct.findByIdAndUpdate(
            productId, 
            [{ $set: { isActive: { $not: "$isActive" } } }], 
            { new: true }
        ).lean();
        if (!product) return null;
        await triggerProductUpdates(product._id);
        return product;
    }
};
