/* controllers/productController.js */

const inventoryService = require('../services/inventoryService');
const productService = require('../services/productService');
const catchAsync = require('../utils/catchAsync');

// ==========================================
// --- CONTROLLER EXPORTS ---
// ==========================================

exports.getProducts = catchAsync(async (request, reply) => {
    return await productService.getPaginatedProducts(request.query);
}, 'fetching products');

exports.createProduct = catchAsync(async (request, reply) => {
    const newProduct = await productService.createProduct(request.server, request.body);
    return { success: true, message: 'Product added', data: newProduct };
}, 'creating product');

exports.updateProduct = catchAsync(async (request, reply) => {
    const updatedProduct = await productService.updateProduct(request.server, request.params.id, { ...request.body });
    if (!updatedProduct) return reply.status(404).send({ success: false, message: 'Product Not found' });
    return { success: true, message: 'Product updated', data: updatedProduct };
}, 'updating product');

exports.archiveProduct = catchAsync(async (request, reply) => {
    const product = await productService.archiveProduct(request.server, request.params.id);
    if (!product) return reply.status(404).send({ success: false, message: 'Product Not found' });
    return { success: true, message: `Product archived securely`, data: product };
}, 'archiving product');

exports.toggleProductStatus = catchAsync(async (request, reply) => {
    const product = await productService.toggleProductStatus(request.server, request.params.id);
    if (!product) return reply.status(404).send({ success: false, message: 'Product Not found' });
    return { success: true, message: `Product Status Toggled`, data: product };
}, 'toggling status');

exports.restockProduct = catchAsync(async (request, reply) => {
    const product = await inventoryService.processRestock(request.params.id, request.body);
    if (request.server.broadcastToPOS) {
        request.server.broadcastToPOS({ type: 'INVENTORY_UPDATED', productId: product._id, message: 'Stock Refilled', storeId: request.body.storeId });
    }
    return { success: true, message: 'Restock processed successfully', data: product };
}, 'restocking product');

exports.rtvProduct = catchAsync(async (request, reply) => {
    const product = await inventoryService.processRTV(request.params.id, request.body);
    if (request.server.broadcastToPOS) {
        request.server.broadcastToPOS({ type: 'INVENTORY_UPDATED', productId: product._id, message: 'Stock Returned', storeId: request.body.storeId });
    }
    return { success: true, message: 'RTV processed successfully', data: product };
}, 'processing RTV');

exports.transferStock = catchAsync(async (request, reply) => {
    const username = request.user ? request.user.username : 'Admin';
    const product = await inventoryService.processTransfer(request.body, username, request.server.log.error.bind(request.server.log));
    if (request.server.broadcastToPOS) {
        request.server.broadcastToPOS({ type: 'INVENTORY_UPDATED', productId: product._id, message: 'Stock Transferred' });
    }
    return { success: true, message: 'Stock transferred successfully.' };
}, 'during stock transfer');
