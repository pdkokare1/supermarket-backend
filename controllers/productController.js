/* controllers/productController.js */

const inventoryService = require('../services/inventoryService');
const productService = require('../services/productService');
const { handleControllerError } = require('../utils/errorUtils'); 

// ==========================================
// --- CONTROLLER EXPORTS ---
// ==========================================

exports.getProducts = async (request, reply) => {
    try {
        return await productService.getPaginatedProducts(request.query);
    } catch (error) { 
        handleControllerError(request, reply, error, 'fetching products');
    }
};

exports.createProduct = async (request, reply) => {
    try {
        const newProduct = await productService.createProduct(request.server, request.body);
        return { success: true, message: 'Product added', data: newProduct };
    } catch (error) { 
        handleControllerError(request, reply, error, 'creating product');
    }
};

exports.updateProduct = async (request, reply) => {
    try {
        const updatedProduct = await productService.updateProduct(request.server, request.params.id, { ...request.body });
        if (!updatedProduct) return reply.status(404).send({ success: false, message: 'Product Not found' });
        
        return { success: true, message: 'Product updated', data: updatedProduct };
    } catch (error) { 
        handleControllerError(request, reply, error, 'updating product');
    }
};

exports.archiveProduct = async (request, reply) => {
    try {
        const product = await productService.archiveProduct(request.server, request.params.id);
        if (!product) return reply.status(404).send({ success: false, message: 'Product Not found' });
        
        return { success: true, message: `Product archived securely`, data: product };
    } catch (error) { 
        handleControllerError(request, reply, error, 'archiving product');
    }
};

exports.toggleProductStatus = async (request, reply) => {
    try {
        const product = await productService.toggleProductStatus(request.server, request.params.id);
        if (!product) return reply.status(404).send({ success: false, message: 'Product Not found' });
        
        return { success: true, message: `Product Status Toggled`, data: product };
    } catch (error) { 
        handleControllerError(request, reply, error, 'toggling status');
    }
};

exports.restockProduct = async (request, reply) => {
    try {
        const product = await inventoryService.processRestock(request.params.id, request.body);
        // Note: Broadcast is handled internally by inventory service or can be called here if decoupled
        if (request.server.broadcastToPOS) {
            request.server.broadcastToPOS({ type: 'INVENTORY_UPDATED', productId: product._id, message: 'Stock Refilled', storeId: request.body.storeId });
        }
        return { success: true, message: 'Restock processed successfully', data: product };
    } catch (error) { 
        if (error.message.includes('not found')) return reply.status(404).send({ success: false, message: error.message });
        handleControllerError(request, reply, error, 'restocking product');
    }
};

exports.rtvProduct = async (request, reply) => {
    try {
        const product = await inventoryService.processRTV(request.params.id, request.body);
        if (request.server.broadcastToPOS) {
            request.server.broadcastToPOS({ type: 'INVENTORY_UPDATED', productId: product._id, message: 'Stock Returned', storeId: request.body.storeId });
        }
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
        if (request.server.broadcastToPOS) {
            request.server.broadcastToPOS({ type: 'INVENTORY_UPDATED', productId: product._id, message: 'Stock Transferred' });
        }
        return { success: true, message: 'Stock transferred successfully.' };
    } catch (error) {
        if (error.message.includes('not found') || error.message.includes('Insufficient') || error.message.includes('Invalid')) {
            return reply.status(400).send({ success: false, message: error.message });
        }
        handleControllerError(request, reply, error, 'during stock transfer');
    }
};
