const Product = require('../models/Product');
const Category = require('../models/Category');

async function productRoutes(fastify, options) {
    // GET /api/products
    fastify.get('/api/products', async (request, reply) => {
        try {
            let filter = request.query.all === 'true' ? {} : { isActive: true };
            
            if (request.query.search) {
                filter.$or = [
                    { name: { $regex: request.query.search, $options: 'i' } },
                    { searchTags: { $regex: request.query.search, $options: 'i' } }
                ];
            }
            
            if (request.query.category && request.query.category !== 'All') {
                filter.category = request.query.category;
            }

            const page = parseInt(request.query.page) || 1;
            const limit = parseInt(request.query.limit); 
            
            let query = Product.find(filter).sort({ createdAt: -1 });
            
            if (limit) {
                const skip = (page - 1) * limit;
                query = query.skip(skip).limit(limit);
            }

            const products = await query;
            const total = await Product.countDocuments(filter);

            return { success: true, count: products.length, total: total, data: products };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error fetching products' });
        }
    });

    // POST /api/products - Add a single item (Updated with brand & distributor)
    fastify.post('/api/products', async (request, reply) => {
        try {
            const { name, category, brand, distributorName, imageUrl, searchTags, variants } = request.body;
            const newProduct = new Product({ name, category, brand, distributorName, imageUrl, searchTags, variants });
            await newProduct.save();
            return { success: true, message: 'Product added successfully', data: newProduct };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error creating product' });
        }
    });

    // PUT /api/products/:id - Edit an existing product (Updated with brand & distributor)
    fastify.put('/api/products/:id', async (request, reply) => {
        try {
            const { name, category, brand, distributorName, imageUrl, searchTags, variants } = request.body;
            
            const updateData = { name, category, brand, distributorName, searchTags, variants };
            if (imageUrl !== undefined && imageUrl !== null) {
                updateData.imageUrl = imageUrl;
            }

            const updatedProduct = await Product.findByIdAndUpdate(
                request.params.id,
                { $set: updateData },
                { new: true, runValidators: true }
            );

            if (!updatedProduct) {
                return reply.status(404).send({ success: false, message: 'Product not found' });
            }

            return { success: true, message: 'Product updated successfully', data: updatedProduct };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error updating product' });
        }
    });

    // NEW: PUT /api/products/:id/restock - Process incoming shipment and log history
    fastify.put('/api/products/:id/restock', async (request, reply) => {
        try {
            const { variantId, invoiceNumber, addedQuantity, purchasingPrice, newSellingPrice } = request.body;
            
            const product = await Product.findById(request.params.id);
            if (!product) return reply.status(404).send({ success: false, message: 'Product not found' });

            const variant = product.variants.id(variantId);
            if (!variant) return reply.status(404).send({ success: false, message: 'Variant not found' });

            // 1. Log the shipment in the ledger
            variant.purchaseHistory.push({
                invoiceNumber,
                addedQuantity: Number(addedQuantity),
                purchasingPrice: Number(purchasingPrice),
                sellingPrice: Number(newSellingPrice)
            });

            // 2. Update live stock and retail price
            variant.stock += Number(addedQuantity);
            variant.price = Number(newSellingPrice);

            await product.save();

            return { success: true, message: 'Restock processed successfully', data: product };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error processing restock' });
        }
    });

    // POST /api/products/bulk - Excel/CSV Import (Updated)
    fastify.post('/api/products/bulk', async (request, reply) => {
        try {
            const { products } = request.body;
            if (!Array.isArray(products)) return reply.status(400).send({ success: false, message: 'Invalid format' });

            let updatedCount = 0;
            let insertedCount = 0;

            for (const p of products) {
                const result = await Product.updateOne(
                    { name: p.name },
                    { $set: {
                        category: p.category,
                        brand: p.brand || '',
                        distributorName: p.distributorName || '',
                        imageUrl: p.imageUrl || '',
                        searchTags: p.searchTags || '',
                        variants: p.variants || []
                    }},
                    { upsert: true } 
                );
                
                if (result.upsertedCount > 0) insertedCount++;
                else if (result.modifiedCount > 0) updatedCount++;
            }
            
            return { success: true, message: `Imported! Added ${insertedCount}, Updated ${updatedCount}.` };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error during bulk import' });
        }
    });

    // PUT /api/products/:id/toggle - Master switch for In-Stock / Out-of-Stock
    fastify.put('/api/products/:id/toggle', async (request, reply) => {
        try {
            const product = await Product.findById(request.params.id);
            if (!product) return reply.status(404).send({ success: false, message: 'Product not found' });
            
            product.isActive = !product.isActive;
            await product.save();
            
            return { 
                success: true, 
                message: `${product.name} is now ${product.isActive ? 'Live' : 'Hidden'}`, 
                data: product 
            };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error updating product' });
        }
    });

    // GET /api/seed - Temporary utility route
    fastify.get('/api/seed', async (request, reply) => {
        try {
            await Category.deleteMany({});
            const sampleCategories = [
                { name: 'Milk & Dairy' }, { name: 'Ice Creams & Desserts' }, 
                { name: 'Chocolates & Sweets' }, { name: 'Kitchen & Groceries' }, 
                { name: 'Fruits & Vegetables' }, { name: 'Snacks & Drinks' }
            ];
            await Category.insertMany(sampleCategories);

            await Product.deleteMany({});
            const sampleProducts = [
                { name: 'Fresh Cow Milk', category: 'Milk & Dairy', searchTags: 'liquid, morning, chai, tea', imageUrl: '', variants: [{ weightOrVolume: '1 Liter', price: 60, stock: 50, sku: '' }] },
                { name: 'Vanilla Ice Cream Tub', category: 'Ice Creams & Desserts', searchTags: 'cold, sweet, summer, frozen', imageUrl: '', variants: [{ weightOrVolume: '500 ml', price: 150, stock: 20, sku: '' }] },
                { name: 'Farm Fresh Eggs', category: 'Milk & Dairy', searchTags: 'protein, breakfast, poultry', imageUrl: '', variants: [{ weightOrVolume: '1 Dozen', price: 80, stock: 30, sku: '' }] },
                { name: 'Organic Bananas', category: 'Fruits & Vegetables', searchTags: 'fruit, yellow, healthy', imageUrl: '', variants: [{ weightOrVolume: '1 kg', price: 50, stock: 40, sku: '' }] }
            ];
            await Product.insertMany(sampleProducts);

            return { success: true, message: 'Categories and Products successfully seeded!' };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error seeding database' });
        }
    });
}

module.exports = productRoutes;
