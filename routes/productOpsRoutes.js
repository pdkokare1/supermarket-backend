/* routes/productOpsRoutes.js */

const Product = require('../models/Product');
const Category = require('../models/Category');
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

async function productOpsRoutes(fastify, options) {
    
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

module.exports = productOpsRoutes;
