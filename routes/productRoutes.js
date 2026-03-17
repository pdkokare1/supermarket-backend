const Product = require('../models/Product');
const Category = require('../models/Category');

async function productRoutes(fastify, options) {
    // GET /api/products - Fetch products (Now supports safe pagination and search)
    fastify.get('/api/products', async (request, reply) => {
        try {
            let filter = request.query.all === 'true' ? {} : { isActive: true };
            
            // Apply Search Filtering if provided
            if (request.query.search) {
                filter.$or = [
                    { name: { $regex: request.query.search, $options: 'i' } },
                    { searchTags: { $regex: request.query.search, $options: 'i' } }
                ];
            }
            
            // Apply Category Filtering if provided
            if (request.query.category && request.query.category !== 'All') {
                filter.category = request.query.category;
            }

            // Safe Pagination Logic: If no limit is sent (like your live storefront), fetch everything.
            const page = parseInt(request.query.page) || 1;
            const limit = parseInt(request.query.limit); 
            
            let query = Product.find(filter).sort({ createdAt: -1 });
            
            if (limit) {
                const skip = (page - 1) * limit;
                query = query.skip(skip).limit(limit);
            }

            const products = await query;
            const total = await Product.countDocuments(filter); // Useful if you want total page counts later

            return { success: true, count: products.length, total: total, data: products };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error fetching products' });
        }
    });

    // POST /api/products - Add a single item
    fastify.post('/api/products', async (request, reply) => {
        try {
            const { name, category, imageUrl, searchTags, variants } = request.body;
            const newProduct = new Product({ name, category, imageUrl, searchTags, variants });
            await newProduct.save();
            return { success: true, message: 'Product added successfully', data: newProduct };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error creating product' });
        }
    });

    // PUT /api/products/:id - Edit an existing product
    fastify.put('/api/products/:id', async (request, reply) => {
        try {
            const { name, category, imageUrl, searchTags, variants } = request.body;
            
            const updateData = { name, category, searchTags, variants };
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

    // POST /api/products/bulk - Excel/CSV Import
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
            // Seed Categories
            await Category.deleteMany({});
            const sampleCategories = [
                { name: 'Milk & Dairy' }, { name: 'Ice Creams & Desserts' }, 
                { name: 'Chocolates & Sweets' }, { name: 'Kitchen & Groceries' }, 
                { name: 'Fruits & Vegetables' }, { name: 'Snacks & Drinks' }
            ];
            await Category.insertMany(sampleCategories);

            // Seed Products
            await Product.deleteMany({});
            const sampleProducts = [
                { name: 'Fresh Cow Milk', category: 'Milk & Dairy', searchTags: 'liquid, morning, chai, tea', imageUrl: '', variants: [{ weightOrVolume: '1 Liter', price: 60, stock: 50 }] },
                { name: 'Vanilla Ice Cream Tub', category: 'Ice Creams & Desserts', searchTags: 'cold, sweet, summer, frozen', imageUrl: '', variants: [{ weightOrVolume: '500 ml', price: 150, stock: 20 }] },
                { name: 'Farm Fresh Eggs', category: 'Milk & Dairy', searchTags: 'protein, breakfast, poultry', imageUrl: '', variants: [{ weightOrVolume: '1 Dozen', price: 80, stock: 30 }] },
                { name: 'Organic Bananas', category: 'Fruits & Vegetables', searchTags: 'fruit, yellow, healthy', imageUrl: '', variants: [{ weightOrVolume: '1 kg', price: 50, stock: 40 }] }
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
