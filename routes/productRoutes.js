/* routes/productRoutes.js */

const Product = require('../models/Product');
const Category = require('../models/Category');
const Distributor = require('../models/Distributor'); 
const { Parser } = require('json2csv'); 
const cloudinary = require('cloudinary').v2; 

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

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

    fastify.post('/api/products/upload', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, async (request, reply) => {
        try {
            const data = await request.file();
            if (!data) return reply.status(400).send({ success: false, message: 'No file uploaded' });

            const uploadResult = await new Promise((resolve, reject) => {
                const uploadStream = cloudinary.uploader.upload_stream(
                    { folder: 'dailypick_products' },
                    (error, result) => {
                        if (error) reject(error);
                        else resolve(result);
                    }
                );
                data.file.pipe(uploadStream);
            });

            return { success: true, imageUrl: uploadResult.secure_url };
        } catch (error) {
            fastify.log.error('Cloudinary Upload Error:', error);
            reply.status(500).send({ success: false, message: 'Image upload failed' });
        }
    });

    fastify.post('/api/products/autofill', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, async (request, reply) => {
        try {
            const { productName } = request.body;
            if (!productName) return reply.status(400).send({ success: false, message: 'Product name required' });
            if (!process.env.GEMINI_API_KEY) return reply.status(400).send({ success: false, message: 'Gemini API key not configured' });

            const prompt = `You are an AI assistant for a supermarket inventory system. Analyze this product name: "${productName}". 
            Return ONLY a valid JSON object with EXACTLY these 3 keys:
            "category" (Choose the closest match from: Dairy & Breakfast, Snacks & Munchies, Cold Drinks & Juices, Personal Care, Cleaning Essentials, Grocery & Kitchen. If none fit, use 'Grocery & Kitchen'),
            "brand" (Extract or guess the brand name, keep it brief. e.g., 'Amul', 'Britannia'),
            "searchTags" (A comma-separated list of 5-8 highly relevant SEO keywords/tags to help cashiers search for it).
            DO NOT include markdown formatting or backticks, return raw JSON only.`;

            const aiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0.1 } 
                })
            });

            const data = await aiRes.json();
            
            if (!data.candidates || data.candidates.length === 0) {
                throw new Error("Invalid response from Gemini");
            }

            let textResult = data.candidates[0].content.parts[0].text.trim();
            
            if (textResult.startsWith('```json')) {
                textResult = textResult.replace(/```json/g, '').replace(/```/g, '').trim();
            }

            const parsed = JSON.parse(textResult);
            return { success: true, data: parsed };
            
        } catch (error) {
            fastify.log.error('Gemini API Error:', error);
            reply.status(500).send({ success: false, message: 'AI Auto-Fill failed to process request' });
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

    fastify.post('/api/products/bulk', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, async (request, reply) => {
        try {
            if (request.isMultipart && request.isMultipart()) {
                const data = await request.file();
                if (!data) return reply.status(400).send({ success: false, message: 'No file uploaded' });
                
                const buffer = await data.toBuffer();
                const csvStr = buffer.toString('utf8');
                const lines = csvStr.split('\n').filter(l => l.trim() !== '');
                
                if (lines.length < 2) return { success: false, message: 'CSV is empty or missing headers' };
                
                const bulkOps = [];
                for (let i = 1; i < lines.length; i++) {
                    const row = lines[i].match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g) || lines[i].split(',');
                    const clean = (val) => (val || '').replace(/^"|"$/g, '').trim();
                    
                    const name = clean(row[0]);
                    const category = clean(row[1]);
                    const brand = clean(row[2]);
                    const dist = clean(row[3]);
                    const sku = clean(row[4]);
                    const cost = parseFloat(clean(row[5])) || 0;
                    const sell = parseFloat(clean(row[6])) || 0;
                    const stock = parseInt(clean(row[7])) || 0;
                    const weight = clean(row[8]);
                    
                    if (name && category) {
                        bulkOps.push({
                            updateOne: {
                                filter: { name: name },
                                update: {
                                    $set: {
                                        category, brand, distributorName: dist,
                                        isActive: true
                                    },
                                    $addToSet: {
                                        variants: {
                                            weightOrVolume: weight || 'Standard',
                                            price: sell,
                                            stock: stock,
                                            sku: sku,
                                            purchaseHistory: cost > 0 ? [{ addedQuantity: stock, purchasingPrice: cost, sellingPrice: sell, date: new Date() }] : []
                                        }
                                    }
                                },
                                upsert: true
                            }
                        });
                    }
                }
                
                if (bulkOps.length > 0) {
                    const result = await Product.bulkWrite(bulkOps);
                    await invalidateProductCache();
                    if (fastify.broadcastToPOS) fastify.broadcastToPOS({ type: 'INVENTORY_UPDATED', message: 'CSV Import Completed' });
                    return { success: true, count: bulkOps.length, message: `Imported ${bulkOps.length} rows.` };
                }
                return { success: false, message: 'No valid products found in CSV' };
            }

            const { products } = request.body;
            if (!Array.isArray(products)) return reply.status(400).send({ success: false, message: 'Invalid format' });
            
            const bulkOps = products.map(p => ({
                updateOne: {
                    filter: { name: p.name },
                    update: { $set: {
                        category: p.category, brand: p.brand || '', distributorName: p.distributorName || '', 
                        imageUrl: p.imageUrl || '', searchTags: p.searchTags || '', variants: p.variants || [],
                        hsnCode: p.hsnCode || '', taxRate: p.taxRate || 0, taxType: p.taxType || 'Inclusive'
                    }},
                    upsert: true
                }
            }));

            if (bulkOps.length > 0) {
                const result = await Product.bulkWrite(bulkOps);
                await invalidateProductCache(); 
                
                if (fastify.broadcastToPOS) fastify.broadcastToPOS({ type: 'INVENTORY_UPDATED', message: 'Bulk Import Completed' });

                return { success: true, message: `Imported! Added ${result.upsertedCount}, Updated ${result.modifiedCount}.` };
            }
            return { success: true, message: `No products to process.` };
        } catch (error) { 
            fastify.log.error(error); 
            reply.status(500).send({ success: false, message: 'Server Error during import' }); 
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

    // --- PHASE 4: MULTI-STORE STOCK TRANSFER ENGINE ---
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

            // Record this transfer securely in the Audit Log
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

    fastify.get('/api/products/export', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, async (request, reply) => {
        try {
            const products = await Product.find({ isArchived: { $ne: true } }).lean();
            const flatProducts = [];

            products.forEach(p => {
                p.variants.forEach(v => {
                    flatProducts.push({
                        Name: p.name, Category: p.category, Brand: p.brand, Distributor: p.distributorName,
                        Variant: v.weightOrVolume, Price: v.price, Stock: v.stock, SKU: v.sku, Status: p.isActive ? 'Active' : 'Inactive'
                    });
                });
            });

            const json2csvParser = new Parser();
            const csv = json2csvParser.parse(flatProducts);

            reply.header('Content-Type', 'text/csv');
            reply.header('Content-Disposition', `attachment; filename="products_export_${new Date().toISOString().split('T')[0]}.csv"`);
            return reply.send(csv);
        } catch (error) {
            fastify.log.error('Export Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error exporting products' });
        }
    });

    fastify.get('/api/seed', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, async (request, reply) => {
        try {
            await Category.deleteMany({});
            const sampleCategories = [{ name: 'Dairy & Breakfast' }, { name: 'Snacks & Munchies' }, { name: 'Cold Drinks & Juices' }, { name: 'Personal Care' }, { name: 'Cleaning Essentials' }, { name: 'Grocery & Kitchen' }];
            await Category.insertMany(sampleCategories);

            await Product.deleteMany({});
            const sampleProducts = [
                { 
                    name: 'Amul Taaza Toned Milk', category: 'Dairy & Breakfast', brand: 'Amul', searchTags: 'milk, liquid, morning, dairy, promo-morning', imageUrl: '[https://m.media-amazon.com/images/I/61H4YpTfGLL._SL1500_.jpg](https://m.media-amazon.com/images/I/61H4YpTfGLL._SL1500_.jpg)', 
                    hsnCode: '0401', taxRate: 0, taxType: 'Inclusive',
                    variants: [{ weightOrVolume: '1 Litre', price: 68, stock: 3, lowStockThreshold: 10, sku: '8901262150171' }] 
                },
                { 
                    name: 'Britannia Fresh White Bread', category: 'Dairy & Breakfast', brand: 'Britannia', searchTags: 'bread, bakery, toast, breakfast, promo-morning', imageUrl: '[https://m.media-amazon.com/images/I/71I3uXhYyPL._SL1500_.jpg](https://m.media-amazon.com/images/I/71I3uXhYyPL._SL1500_.jpg)', 
                    hsnCode: '1905', taxRate: 0, taxType: 'Inclusive',
                    variants: [{ weightOrVolume: '400 g', price: 45, stock: 30, sku: '8901063132030' }] 
                }
            ];
            await Product.insertMany(sampleProducts);
            await invalidateProductCache();

            return { success: true, message: 'Database seeded with Low Stock triggers & Tax data!' };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error seeding database' });
        }
    });
}

module.exports = productRoutes;
