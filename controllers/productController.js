/* controllers/productController.js */
'use strict';

const inventoryService = require('../services/inventoryService');
const productService = require('../services/productService');
const productCacheService = require('../services/productCacheService');

// --- NEW IMPORTS FOR B2B OMNICHANNEL ---
const MasterProduct = require('../models/MasterProduct');
const StoreInventory = require('../models/StoreInventory');

exports.getProducts = async (request, reply) => {
    // ENFORCING TENANT BOUNDARY: Auto-inject storeId so users only see their store's inventory
    const queryPayload = { ...request.query };
    if (request.user && request.user.tenantId) {
        queryPayload.storeId = request.user.tenantId;
    }

    const sortedQuery = Object.keys(queryPayload).sort().reduce((result, key) => {
        result[key] = queryPayload[key];
        return result;
    }, {});
    
    const cacheKey = `products:catalog:${JSON.stringify(sortedQuery)}`;
    const productData = await productCacheService.fetchWithCoalescing(
        cacheKey,
        300, 
        async () => await productService.getPaginatedProducts(queryPayload)
    );

    return { 
        success: true, 
        message: productData.message || 'Products fetched successfully', 
        count: productData.count,
        total: productData.total,
        data: productData.data 
    };
};

exports.createProduct = async (request, reply) => {
    // ENFORCING TENANT BOUNDARY
    const payload = { ...request.body };
    if (request.user && request.user.tenantId) {
        payload.storeId = request.user.tenantId;
    }

    const newProduct = await productService.createProduct(payload);
    await productCacheService.invalidateProductCache();
    return { success: true, message: 'Product added', data: newProduct };
};

exports.updateProduct = async (request, reply) => {
    const payload = { ...request.body };
    if (request.user && request.user.tenantId) {
        payload.storeId = request.user.tenantId;
    }

    const updatedProduct = await productService.updateProduct(request.params.id, payload);
    if (!updatedProduct) return reply.status(404).send({ success: false, message: 'Product Not found' });
    
    await productCacheService.invalidateProductCache();
    return { success: true, message: 'Product updated', data: updatedProduct };
};

exports.archiveProduct = async (request, reply) => {
    const product = await productService.archiveProduct(request.params.id);
    if (!product) return reply.status(404).send({ success: false, message: 'Product Not found' });
    
    await productCacheService.invalidateProductCache();
    return { success: true, message: `Product archived securely`, data: product };
};

exports.toggleProductStatus = async (request, reply) => {
    const product = await productService.toggleProductStatus(request.params.id);
    if (!product) return reply.status(404).send({ success: false, message: 'Product Not found' });
    
    await productCacheService.invalidateProductCache();
    return { success: true, message: `Product Status Toggled`, data: product };
};

exports.restockProduct = async (request, reply) => {
    const payload = { ...request.body };
    if (request.user && request.user.tenantId) {
        payload.storeId = request.user.tenantId;
    }

    const product = await inventoryService.processRestock(request.params.id, payload);
    return { success: true, message: 'Restock processed successfully', data: product };
};

exports.rtvProduct = async (request, reply) => {
    const payload = { ...request.body };
    if (request.user && request.user.tenantId) {
        payload.storeId = request.user.tenantId;
    }

    const product = await inventoryService.processRTV(request.params.id, payload);
    return { success: true, message: 'RTV processed successfully', data: product };
};

exports.transferStock = async (request, reply) => {
    const username = request.user ? request.user.username : 'Admin';
    await inventoryService.processTransfer(request.body, username, request.server.log.error.bind(request.server.log));
    return { success: true, message: 'Stock transferred successfully.' };
};

// ============================================================================
// NEW B2B OMNICHANNEL FUNCTIONS: THE PLATFORM MASTER CATALOG INTEGRATION
// ============================================================================

exports.getGlobalCatalog = async (request, reply) => {
    // Allows onboarded stores to search the master database so they don't have to create products manually
    const queryPayload = { ...request.query };
    
    const limit = parseInt(queryPayload.limit) || 20;
    const page = parseInt(queryPayload.page) || 1;
    const skip = (page - 1) * limit;

    let query = { isActive: true };
    
    // Enterprise Text Search against the indexes in MasterProduct.js
    if (queryPayload.search) {
        query.$text = { $search: queryPayload.search };
    }
    if (queryPayload.category) {
        query.category = queryPayload.category;
    }

    const masterProducts = await MasterProduct.find(query).skip(skip).limit(limit).lean();
    const total = await MasterProduct.countDocuments(query);

    return { 
        success: true, 
        message: 'Global catalog fetched successfully', 
        count: masterProducts.length,
        total: total,
        data: masterProducts 
    };
};

exports.addMasterProductToStore = async (request, reply) => {
    // 1-Click B2B Onboarding: Copies a Master Product into a Store's local inventory
    const { masterProductId, variantId, sellingPrice, stock, lowStockThreshold } = request.body;
    
    // Fallback to payload storeId if tenantId isn't on the request (e.g., Enterprise API sync)
    const storeId = request.user && request.user.tenantId ? request.user.tenantId : request.body.storeId;

    if (!storeId) {
        return reply.status(400).send({ success: false, message: 'Store ID is required for catalog bridging' });
    }

    // Guard Clause: Prevent duplicate onboarding
    const existingInventory = await StoreInventory.findOne({ storeId, masterProductId, variantId });
    if (existingInventory) {
        return reply.status(400).send({ success: false, message: 'Product already exists in your local store inventory' });
    }

    // Fetch Master Product to enforce compliance linkage for billing and taxonomy
    const masterProduct = await MasterProduct.findById(masterProductId);
    if (!masterProduct) {
        return reply.status(404).send({ success: false, message: 'Master Product not found' });
    }

    const variantDetails = masterProduct.variants.id(variantId) || masterProduct.variants.find(v => v._id.toString() === variantId.toString());
    if (!variantDetails) {
         return reply.status(404).send({ success: false, message: 'Variant not found in Master Catalog' });
    }

    const newStoreInventory = new StoreInventory({
        storeId,
        masterProductId,
        variantId,
        sellingPrice, // Stores set their own local Rs price
        stock: stock || 0,
        lowStockThreshold: lowStockThreshold || 5,
        categorySnapshot: masterProduct.category, // NEW: B2B Compliance Linkage
        hsnCodeSnapshot: variantDetails.hsnCode // NEW: B2B Billing Linkage
    });

    await newStoreInventory.save();

    return {
        success: true,
        message: 'Product successfully integrated into local inventory',
        data: newStoreInventory
    };
};

// --- NEW: PILLAR B - DISTRIBUTOR WHOLESALE SUBMISSION ---
exports.submitWholesaleItem = async (request, reply) => {
    const payload = { ...request.body };
    
    // Enforce B2B Distributor tracking
    payload.submittedBy = request.user && request.user.tenantId ? request.user.tenantId : (request.user ? request.user._id : null);
    
    // Hardcode strict queue governance 
    payload.status = 'PENDING_APPROVAL';
    payload.isActive = false; // Hidden until HQ SuperAdmin approves
    
    const newMasterProduct = new MasterProduct(payload);
    await newMasterProduct.save();

    return { success: true, message: 'Wholesale item submitted to HQ for approval.', data: newMasterProduct };
};

// ============================================================================
// --- NEW: PHASE 10 HEURISTIC ASSOCIATION ENGINE (SMART CART UPSELLS) ---
// ============================================================================
exports.getSmartCartUpsells = async (request, reply) => {
    const { cartCategories = [], storeId } = request.body;
    const targetStoreId = storeId || (request.user ? request.user.tenantId : null);
    
    let query = { isActive: true, stock: { $gt: 0 } };
    if (targetStoreId) query.storeId = targetStoreId;
    
    // Core Algorithmic Filter: Find items sharing the customer's current cart categories
    if (cartCategories.length > 0) {
        query.categorySnapshot = { $in: cartCategories };
    }
    
    // Sort by stock as a proxy for high-volume availability, limit to 5 suggestions
    const upsells = await StoreInventory.find(query)
        .sort({ stock: -1 }) 
        .limit(5)
        .populate('masterProductId', 'name imageUrl category variants')
        .lean();
        
    // Format perfectly to match the frontend's product rendering engine
    const formattedUpsells = upsells.map(inv => {
        const master = inv.masterProductId || {};
        const variant = (master.variants || []).find(v => v._id && v._id.toString() === inv.variantId.toString()) || {};
        return {
            _id: master._id,
            name: master.name || 'Suggested Item',
            imageUrl: master.imageUrl,
            category: inv.categorySnapshot,
            variants: [{
                _id: inv.variantId,
                price: inv.sellingPrice,
                stock: inv.stock,
                weightOrVolume: variant.weightOrVolume || '1 unit',
                storeId: inv.storeId
            }]
        };
    });
    
    return { success: true, data: formattedUpsells };
};

// ============================================================================
// --- NEW: PHASE 10 CATALOG LOCKDOWN & BARCODE DISCOVERY ---
// ============================================================================
exports.searchByBarcode = async (request, reply) => {
    const { barcode } = request.params;
    const MasterProduct = require('../models/MasterProduct');
    
    const product = await MasterProduct.findOne({ 'compliance.gs1Barcode': barcode }).lean();
    if (!product) {
        return reply.code(404).send({ success: false, message: 'Barcode not found in Master Catalog. You may submit it for review.' });
    }
    return { success: true, message: 'Product found', data: product };
};

// WRAPPER: Overrides legacy product creation to enforce the B2B Single Truth logic
const originalCreateProductPhase10 = exports.createProduct;
exports.createProduct = async (request, reply) => {
    // Enforce strict B2B Catalog lockdown. Stores cannot create freeform items if they have a recognized barcode.
    if (request.body.compliance && request.body.compliance.gs1Barcode) {
        const MasterProduct = require('../models/MasterProduct');
        const exists = await MasterProduct.findOne({ 'compliance.gs1Barcode': request.body.compliance.gs1Barcode });
        if (exists) {
            const AppError = require('../utils/AppError');
            throw new AppError('Strict Catalog Policy: This GS1 Barcode already exists in the Master Database. Please use the 1-Click "Add to Store" bridging API instead of creating a duplicate.', 409);
        }
    }
    return await originalCreateProductPhase10(request, reply);
};
