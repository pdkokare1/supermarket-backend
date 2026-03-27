/* routes/productRoutes.js */

const Product = require('../models/Product');
const Distributor = require('../models/Distributor'); 

let Redis = null;
let redisCache = null;
try {
    Redis = require('ioredis');
    if (process.env.REDIS_URL) {
        redisCache = new Redis(process.env.REDIS_URL);
    }
} catch (e) {}

const invalidateProductCache = async () => {
    if (redisCache) {
        try {
            let cursor = '0';
            do {
                const [newCursor, keys] = await redisCache.scan(cursor, 'MATCH', 'products:*', 'COUNT', 100);
                cursor = newCursor;
                if (keys.length > 0) {
                    await redisCache.del(...keys);
                }
            } while (cursor !== '0');
        } catch(e) {}
    }
};

const productSchema = {
    schema: {
        body: {
            type: 'object',
            required: ['name', 'category'],
            properties: {
                name: { type: 'string' },
                category: { type: 'string' },
                brand: { type: 'string' },
                distributorName: { type: 'string' },
                imageUrl: { type: 'string' },
                searchTags: { type: 'string' },
                hsnCode: { type: 'string' },
                taxRate: { type: 'number' },
                taxType: { type: 'string', enum: ['Inclusive', 'Exclusive'] }
            }
        }
    }
};

const restockSchema = {
    schema: {
        body: {
            type: 'object',
            required: ['variantId', 'addedQuantity', 'purchasingPrice', 'newSellingPrice'],
            properties: {
                variantId: { type: 'string' },
                invoiceNumber: { type: 'string' },
                addedQuantity: { type: 'number', minimum: 1 },
                purchasingPrice: { type: 'number', minimum: 0 },
                newSellingPrice: { type: 'number', minimum: 0 },
                paymentStatus: { type: 'string', enum: ['Paid', 'Credit'] }, 
                storeId: { type: 'string' } 
            }
        }
    }
};

const rtvSchema = {
    schema: {
        body: {
            type: 'object',
            required: ['variantId', 'returnedQuantity', 'refundAmount'],
            properties: {
                variantId: { type: 'string' },
                distributorName: { type: 'string' },
                returnedQuantity: { type: 'number', minimum: 1 },
                refundAmount: { type: 'number', minimum: 0 },
                reason: { type: 'string' },
                storeId: { type: 'string' } 
            }
        }
    }
};

const getProductsSchema = {
    schema: {
        querystring: {
            type: 'object',
            properties: {
                all: { type: 'string' },
                search: { type: 'string' },
                category: { type: 'string' },
                brand: { type: 'string' },
                distributor: { type: 'string' },
                stockStatus: { type: 'string' },
                page: { type: 'string' },
                limit: { type: 'string' },
                sort: { type: 'string' }
            }
        }
    }
};

async function productRoutes(fastify, options) {
    
    fastify.get('/api/products', getProductsSchema, async (request, reply) => {
        try {
            const sortedQuery = Object.keys(request.query).sort().reduce((acc, key) => {
                acc[key] = request.query[key];
                return acc;
            }, {});
            
            const cacheKey = `products:${JSON.stringify(sortedQuery)}`;
            if (redisCache) {
                const cachedResponse = await redisCache.get(cacheKey);
                if (cachedResponse) {
                    return JSON.parse(cachedResponse);
                }
            }

            let filter = request.query.all === 'true' 
                ? { isArchived: { $ne: true } } 
                : { isActive: true, isArchived: { $ne: true } };
            
            if (request.query.search) { 
                filter.$or = [ 
                    { name: { $regex: request.query.search, $options: 'i' } }, 
                    { searchTags: { $regex: request.query.search, $options: 'i' } } 
                ]; 
            }
            
            if (request.query.category && request.query.category !== 'All') filter.category = request.query.category; 
            if (request.query.brand && request.query.brand !== 'All') filter.brand = request.query.brand;
            if (request.query.distributor && request.query.distributor !== 'All') filter.distributorName = request.query.distributor;

            if (request.query.stockStatus === 'out') {
                filter['variants.stock'] = { $lte: 0 };
            } else if (request.query.stockStatus === 'dead') {
                filter['variants.stock'] = { $gt: 15 };
            } else if (request.query.stockStatus === 'low') {
                filter.$expr = {
                    $anyElementTrue: {
                        $map: {
                            input: "$variants",
                            as: "v",
                            in: {
                                $and: [
                                    { $gt: ["$$v.stock", 0] },
                                    { $lte: ["$$v.stock", { $ifNull: ["$$v.lowStockThreshold", 5] }] }
                                ]
                            }
                        }
                    }
                };
            }
            
            const page = parseInt(request.query.page) || 1; 
            const limit = parseInt(request.query.limit); 
            
            let sortQuery = { createdAt: -1 };
            if (request.query.sort === 'name_asc') sortQuery = { name: 1 };
            if (request.query.sort === 'stock_low') sortQuery = { "variants.stock": 1 }; 
            
            let query = Product.find(filter).sort(sortQuery);
            
            if (limit) { 
                const skip = (page - 1) * limit; 
                query = query.skip(skip).limit(limit); 
            }
            
            const [products, total] = await Promise.all([
                query.lean(), 
                Product.countDocuments(filter)
            ]);
            
            const responseData = { success: true, count: products.length, total: total, data: products };
            
            if (redisCache) {
                await redisCache.set(cacheKey, JSON.stringify(responseData), 'EX', 3600); 
            }

            return responseData;
        } catch (error) { 
            fastify.log.error(error); 
            reply.status(500).send({ success: false, message: 'Server Error' }); 
        }
    });

    fastify.post('/api/products', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...productSchema }, async (request, reply) => {
        try {
            const { name, category, brand, distributorName, imageUrl, searchTags, variants, hsnCode, taxRate, taxType } = request.body;
            
            const newProduct = new Product({ 
                name, category, brand, distributorName, imageUrl, searchTags, variants, hsnCode, taxRate, taxType 
            });
            
            await newProduct.save();
            await invalidateProductCache(); 
            
            if (fastify.broadcastToPOS) fastify.broadcastToPOS({ type: 'INVENTORY_UPDATED', productId: newProduct._id });
            
            return { success: true, message: 'Product added', data: newProduct };
        } catch (error) { 
            fastify.log.error(error); 
            reply.status(500).send({ success: false, message: 'Server Error' }); 
        }
    });

    fastify.put('/api/products/:id', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...productSchema }, async (request, reply) => {
        try {
            const { name, category, brand, distributorName, imageUrl, searchTags, variants, hsnCode, taxRate, taxType } = request.body;
            
            const updateData = { name, category, brand, distributorName, searchTags, variants, hsnCode, taxRate, taxType };
            if (imageUrl !== undefined && imageUrl !== null) updateData.imageUrl = imageUrl;
            
            const updatedProduct = await Product.findByIdAndUpdate(
                request.params.id, 
                { $set: updateData }, 
                { new: true, runValidators: true }
            );
            
            if (!updatedProduct) return reply.status(404).send({ success: false, message: 'Not found' });
            
            await invalidateProductCache(); 
            
            if (fastify.broadcastToPOS) fastify.broadcastToPOS({ type: 'INVENTORY_UPDATED', productId: updatedProduct._id });

            return { success: true, message: 'Product updated', data: updatedProduct };
        } catch (error) { 
            fastify.log.error(error); 
            reply.status(500).send({ success: false, message: 'Server Error' }); 
        }
    });

    fastify.put('/api/products/:id/archive', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, async (request, reply) => {
        try {
            const product = await Product.findById(request.params.id);
            if (!product) return reply.status(404).send({ success: false, message: 'Not found' });
            
            product.isArchived = true; 
            product.isActive = false; 
            await product.save();
            
            await invalidateProductCache(); 
            
            if (fastify.broadcastToPOS) fastify.broadcastToPOS({ type: 'INVENTORY_UPDATED', productId: product._id });

            return { success: true, message: `Product archived securely`, data: product };
        } catch (error) { 
            fastify.log.error(error); 
            reply.status(500).send({ success: false, message: 'Server Error' }); 
        }
    });

    fastify.put('/api/products/:id/restock', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...restockSchema }, async (request, reply) => {
        try {
            const { variantId, invoiceNumber, addedQuantity, purchasingPrice, newSellingPrice, paymentStatus, storeId } = request.body;
            
            const product = await Product.findById(request.params.id);
            if (!product) return reply.status(404).send({ success: false, message: 'Product not found' });
            
            const variant = product.variants.id(variantId);
            if (!variant) return reply.status(404).send({ success: false, message: 'Variant not found' });
            
            variant.purchaseHistory.push({ 
                invoiceNumber, 
                addedQuantity: Number(addedQuantity), 
                purchasingPrice: Number(purchasingPrice), 
                sellingPrice: Number(newSellingPrice),
                storeId: storeId 
            });
            
            variant.stock += Number(addedQuantity); 
            variant.price = Number(newSellingPrice);

            if (storeId) {
                let locStock = variant.locationInventory.find(l => l.storeId && l.storeId.toString() === storeId);
                if (locStock) {
                    locStock.stock += Number(addedQuantity);
                } else {
                    variant.locationInventory.push({ storeId: storeId, stock: Number(addedQuantity) });
                }
            }
            
            await product.save();
            
            if (paymentStatus === 'Credit' && product.distributorName) {
                const totalCost = Number(addedQuantity) * Number(purchasingPrice);
                await Distributor.findOneAndUpdate(
                    { name: product.distributorName },
                    { $inc: { totalPendingAmount: totalCost } },
                    { upsert: true }
                );
            }

            await invalidateProductCache(); 
            
            if (fastify.broadcastToPOS) fastify.broadcastToPOS({ type: 'INVENTORY_UPDATED', productId: product._id, message: 'Stock Refilled', storeId: storeId });

            return { success: true, message: 'Restock processed successfully', data: product };
        } catch (error) { 
            fastify.log.error(error); 
            reply.status(500).send({ success: false, message: 'Server Error' }); 
        }
    });

    fastify.put('/api/products/:id/rtv', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...rtvSchema }, async (request, reply) => {
        try {
            const { variantId, distributorName, returnedQuantity, refundAmount, reason, storeId } = request.body;
            
            const product = await Product.findById(request.params.id);
            if (!product) return reply.status(404).send({ success: false, message: 'Product not found' });
            
            const variant = product.variants.id(variantId);
            if (!variant) return reply.status(404).send({ success: false, message: 'Variant not found' });
            
            if (variant.stock < returnedQuantity) return reply.status(400).send({ success: false, message: 'Not enough stock to return' });

            variant.returnHistory.push({ distributorName, returnedQuantity: Number(returnedQuantity), refundAmount: Number(refundAmount), reason, storeId });
            
            variant.stock -= Number(returnedQuantity); 

            if (storeId) {
                let locStock = variant.locationInventory.find(l => l.storeId && l.storeId.toString() === storeId);
                if (locStock && locStock.stock >= returnedQuantity) {
                    locStock.stock -= Number(returnedQuantity);
                }
            }
            
            await product.save();
            await invalidateProductCache(); 
            
            if (fastify.broadcastToPOS) fastify.broadcastToPOS({ type: 'INVENTORY_UPDATED', productId: product._id, message: 'Stock Returned', storeId: storeId });

            return { success: true, message: 'RTV processed successfully', data: product };
        } catch (error) { 
            fastify.log.error(error); 
            reply.status(500).send({ success: false, message: 'Server Error processing RTV' }); 
        }
    });

    fastify.put('/api/products/:id/toggle', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, async (request, reply) => {
        try {
            const product = await Product.findById(request.params.id);
            if (!product) return reply.status(404).send({ success: false, message: 'Not found' });
            
            product.isActive = !product.isActive; 
            await product.save();
            
            await invalidateProductCache(); 
            
            if (fastify.broadcastToPOS) fastify.broadcastToPOS({ type: 'INVENTORY_UPDATED', productId: product._id });

            return { success: true, message: `Toggled`, data: product };
        } catch (error) { 
            fastify.log.error(error); 
            reply.status(500).send({ success: false, message: 'Server Error' }); 
        }
    });

    fastify.post('/api/products/transfer', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, async (request, reply) => {
        try {
            const { productId, variantId, fromStoreId, toStoreId, quantity } = request.body;
            
            if (!productId || !variantId || !fromStoreId || !toStoreId || !quantity || quantity <= 0) {
                return reply.status(400).send({ success: false, message: 'Invalid transfer parameters.' });
            }

            const product = await Product.findById(productId);
            if (!product) return reply.status(404).send({ success: false, message: 'Product not found.' });

            const variant = product.variants.id(variantId);
            if (!variant) return reply.status(404).send({ success: false, message: 'Variant not found.' });

            let fromLoc = variant.locationInventory.find(l => l.storeId.toString() === fromStoreId);
            let toLoc = variant.locationInventory.find(l => l.storeId.toString() === toStoreId);

            if (!fromLoc || fromLoc.stock < quantity) {
                return reply.status(400).send({ success: false, message: 'Insufficient stock at source location.' });
            }

            fromLoc.stock -= quantity;
            
            if (toLoc) {
                toLoc.stock += quantity;
            } else {
                variant.locationInventory.push({ storeId: toStoreId, stock: quantity });
            }

            await product.save();
            await invalidateProductCache();

            const AuditLog = require('../models/AuditLog');
            if (AuditLog) {
                await AuditLog.create({
                    action: 'STOCK_TRANSFER',
                    targetType: 'Product',
                    targetId: product._id.toString(),
                    username: request.user ? request.user.username : 'Admin',
                    details: { variantId, fromStoreId, toStoreId, quantity }
                }).catch(e => fastify.log.error('AuditLog Error:', e));
            }

            if (fastify.broadcastToPOS) fastify.broadcastToPOS({ type: 'INVENTORY_UPDATED', productId: product._id, message: 'Stock Transferred' });

            return { success: true, message: 'Stock transferred successfully.' };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error during stock transfer' });
        }
    });
}

module.exports = productRoutes;
