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

    // POST /api/products - Add a single item
    fastify.post('/api/products', async (request, reply) => {
        try {
            const { name, category, imageUrl, variants } = request.body;
            const newProduct = new Product({ name, category, imageUrl, variants });
            await newProduct.save();
            return { success: true, message: 'Product added successfully', data: newProduct };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error creating product' });
        }
    });

    // --- NEW: PUT /api/products/:id - Edit an existing product ---
    fastify.put('/api/products/:id', async (request, reply) => {
        try {
            const { name, category, imageUrl, variants } = request.body;
            
            // Build the update object. If imageUrl is empty string, we let it update to empty (removing image)
            // or if it's undefined we don't update it (keeps existing image if no new one uploaded)
            const updateData = { name, category, variants };
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
                // Upsert logic: Match by name.
                const result = await Product.updateOne(
                    { name: p.name },
                    { $set: {
                        category: p.category,
                        imageUrl: p.imageUrl || '',
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
            await Product.deleteMany({});
            const sampleProducts = [
                { name: 'Fresh Cow Milk', category: 'Dairy', imageUrl: '', variants: [{ weightOrVolume: '1 Liter', price: 60, stock: 50 }, { weightOrVolume: '500 ml', price: 32, stock: 50 }] },
                { name: 'Whole Wheat Bread', category: 'Bakery', imageUrl: '', variants: [{ weightOrVolume: '400g', price: 45, stock: 20 }] },
                { name: 'Farm Fresh Eggs', category: 'Dairy', imageUrl: '', variants: [{ weightOrVolume: '1 Dozen', price: 80, stock: 30 }, { weightOrVolume: '6 Pack', price: 45, stock: 15 }] },
                { name: 'Organic Bananas', category: 'Produce', imageUrl: '', variants: [{ weightOrVolume: '1 kg', price: 50, stock: 40 }] },
                { name: 'Basmati Rice', category: 'Pantry', imageUrl: '', variants: [{ weightOrVolume: '1 kg', price: 120, stock: 100 }, { weightOrVolume: '5 kg', price: 550, stock: 20 }] },
                { name: 'Toor Dal', category: 'Pantry', imageUrl: '', variants: [{ weightOrVolume: '1 kg', price: 160, stock: 50 }] },
                { name: 'Amul Butter', category: 'Dairy', imageUrl: '', variants: [{ weightOrVolume: '100g', price: 55, stock: 40 }, { weightOrVolume: '500g', price: 260, stock: 10 }] }
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
