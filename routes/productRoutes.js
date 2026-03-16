const Product = require('../models/Product');

async function productRoutes(fastify, options) {
    // GET /api/products - Fetch products
    fastify.get('/api/products', async (request, reply) => {
        try {
            const filter = request.query.all === 'true' ? {} : { isActive: true };
            const products = await Product.find(filter).sort({ createdAt: -1 });
            return { success: true, count: products.length, data: products };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error fetching products' });
        }
    });

    // POST /api/products - Add a single item (Now accepts Images)
    fastify.post('/api/products', async (request, reply) => {
        try {
            const { name, price, weightOrVolume, category, imageUrl } = request.body;
            const newProduct = new Product({ name, price, weightOrVolume, category, imageUrl });
            await newProduct.save();
            return { success: true, message: 'Product added successfully', data: newProduct };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error creating product' });
        }
    });

    // --- NEW: POST /api/products/bulk - Excel/CSV Import ---
    fastify.post('/api/products/bulk', async (request, reply) => {
        try {
            const { products } = request.body;
            if (!Array.isArray(products)) return reply.status(400).send({ success: false, message: 'Invalid format' });

            let updatedCount = 0;
            let insertedCount = 0;

            for (const p of products) {
                // Upsert logic: Match by name. If it exists, update it. If not, create it.
                const result = await Product.updateOne(
                    { name: p.name },
                    { $set: {
                        price: p.price,
                        weightOrVolume: p.weightOrVolume,
                        category: p.category,
                        imageUrl: p.imageUrl || ''
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
            await Product.deleteMany({});
            const sampleProducts = [
                { name: 'Fresh Cow Milk', price: 60, weightOrVolume: '1 Liter', category: 'Dairy', imageUrl: '' },
                { name: 'Whole Wheat Bread', price: 45, weightOrVolume: '400g', category: 'Bakery', imageUrl: '' },
                { name: 'Farm Fresh Eggs', price: 80, weightOrVolume: '1 Dozen', category: 'Dairy', imageUrl: '' },
                { name: 'Organic Bananas', price: 50, weightOrVolume: '1 kg', category: 'Produce', imageUrl: '' },
                { name: 'Basmati Rice', price: 120, weightOrVolume: '1 kg', category: 'Pantry', imageUrl: '' },
                { name: 'Toor Dal', price: 160, weightOrVolume: '1 kg', category: 'Pantry', imageUrl: '' },
                { name: 'Amul Butter', price: 55, weightOrVolume: '100g', category: 'Dairy', imageUrl: '' }
            ];
            await Product.insertMany(sampleProducts);
            return { success: true, message: 'DailyPick database successfully seeded with sample products!' };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error seeding database' });
        }
    });
}

module.exports = productRoutes;
