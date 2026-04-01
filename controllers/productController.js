/* controllers/productController.js */

const Product = require('../models/Product');
const inventoryService = require('../services/inventoryService');
const productService = require('../services/productService');
const { handleControllerError } = require('../utils/errorUtils'); 
const cacheUtils = require('../utils/cacheUtils'); // NEW IMPORT

// ==========================================
// --- HELPER FUNCTIONS ---
// ==========================================

const syncAndBroadcast = async (request, productId, extraPayload = {}) => {
    await cacheUtils.invalidateByPattern('products:*');
    if (request.server.broadcastToPOS) {
        request.server.broadcastToPOS({ type: 'INVENTORY_UPDATED', productId, ...extraPayload });
    }
};

// ==========================================
// --- CONTROLLER EXPORTS ---
// ==========================================

exports.getProducts = async (request, reply) => {
    try {
        const cacheKey = cacheUtils.generateKey('products', request.query);
        const cachedData = await cacheUtils.getCachedData(cacheKey);
        if (cachedData) return cachedData;

        const filter = productService.buildProductQuery(request.query); 
        const page = parseInt(request.query.page) || 1; 
        const limit = parseInt(request.query.limit); 
        
        let sortQuery = { createdAt: -1 };
        if (request.query.sort === 'name_asc') sortQuery = { name: 1 };
        if (request.query.sort === 'stock_low') sortQuery = { "variants.stock": 1 }; 
        
        let query = Product.find(filter).sort(sortQuery);
        if (limit) query = query.skip((page - 1) * limit).limit(limit); 
        
        const [products, total] = await Promise.all([query.lean(), Product.countDocuments(filter)]);
        
        const responseData = { success: true, count: products.length, total: total, data: products };
        await cacheUtils.setCachedData(cacheKey, responseData, 3600);
        
        return responseData;
    } catch (error) { 
        handleControllerError(request, reply, error, 'fetching products');
    }
};

exports.createProduct = async (request, reply) => {
    try {
        const newProduct = new Product(request.body);
        await newProduct.save();
        
        await syncAndBroadcast(request, newProduct._id);
        return { success: true, message: 'Product added', data: newProduct };
    } catch (error) { 
        handleControllerError(request, reply, error, 'creating product');
    }
};

exports.updateProduct = async (request, reply) => {
    try {
        const { name, category, brand, distributorName, imageUrl, searchTags, variants, hsnCode, taxRate, taxType } = request.body;
        const updateData = { name, category, brand, distributorName, searchTags, variants, hsnCode, taxRate, taxType };
        if (imageUrl !== undefined && imageUrl !== null) updateData.imageUrl = imageUrl;
        
        const updatedProduct = await Product.findByIdAndUpdate(
            request.params.id, 
            { $set: updateData }, 
            { new: true, runValidators: true }
        );
        
        if (!updatedProduct) return reply.status(404).send({ success: false, message: 'Product Not found' });
        
        await syncAndBroadcast(request, updatedProduct._id);
        return { success: true, message: 'Product updated', data: updatedProduct };
    } catch (error) { 
        handleControllerError(request, reply, error, 'updating product');
    }
};

exports.archiveProduct = async (request, reply) => {
    try {
        const product = await Product.findById(request.params.id);
        if (!product) return reply.status(404).send({ success: false, message: 'Product Not found' });
        
        product.isArchived = true; 
        product.isActive = false; 
        await product.save();
        
        await syncAndBroadcast(request, product._id);
        return { success: true, message: `Product archived securely`, data: product };
    } catch (error) { 
        handleControllerError(request, reply, error, 'archiving product');
    }
};

exports.toggleProductStatus = async (request, reply) => {
    try {
        const product = await Product.findById(request.params.id);
        if (!product) return reply.status(404).send({ success: false, message: 'Product Not found' });
        
        product.isActive = !product.isActive; 
        await product.save();
        
        await syncAndBroadcast(request, product._id);
        return { success: true, message: `Product Status Toggled`, data: product };
    } catch (error) { 
        handleControllerError(request, reply, error, 'toggling status');
    }
};

exports.restockProduct = async (request, reply) => {
    try {
        const product = await inventoryService.processRestock(request.params.id, request.body);
        await syncAndBroadcast(request, product._id, { message: 'Stock Refilled', storeId: request.body.storeId });
        return { success: true, message: 'Restock processed successfully', data: product };
    } catch (error) { 
        if (error.message.includes('not found')) return reply.status(404).send({ success: false, message: error.message });
        handleControllerError(request, reply, error, 'restocking product');
    }
};

exports.rtvProduct = async (request, reply) => {
    try {
        const product = await inventoryService.processRTV(request.params.id, request.body);
        await syncAndBroadcast(request, product._id, { message: 'Stock Returned', storeId: request.body.storeId });
        return { success: true, message: 'RTV processed successfully', data: product };
    } catch (error) { 
        if (error.message.includes('not found') || error.message.includes('Not enough stock')) return reply.status(400).send({ success: false, message: error.message });
        handleControllerError(request, reply, error, 'processing RTV');
    }
};

exports.transferStock = async (request, reply) => {
    try {
        const username = request.user ? request.user.username : 'Admin';
        const product = await inventoryService.processTransfer(request.body, username, request.server.log.error.bind(request.server.log));
        await syncAndBroadcast(request, product._id, { message: 'Stock Transferred' });
        return { success: true, message: 'Stock transferred successfully.' };
    } catch (error) {
        if (error.message.includes('not found') || error.message.includes('Insufficient') || error.message.includes('Invalid')) {
            return reply.status(400).send({ success: false, message: error.message });
        }
        handleControllerError(request, reply, error, 'during stock transfer');
    }
};
