/* controllers/productController.js */

const Product = require('../models/Product');
const inventoryService = require('../services/inventoryService');
const productService = require('../services/productService');
const { handleControllerError } = require('../utils/errorUtils'); 
const cacheUtils = require('../utils/cacheUtils');

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
        // OPTIMIZED: The controller now purely handles the request, 
        // delegating all DB/Cache heavy lifting to the Service layer.
        const responseData = await productService.getPaginatedProducts(request.query);
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
        // OPTIMIZED: Dynamically spread the body, then strip protected fields. 
        // Makes the route immune to future schema additions.
        const updateData = { ...request.body };
        delete updateData._id;
        delete updateData.isArchived;
        delete updateData.isActive;
        
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
