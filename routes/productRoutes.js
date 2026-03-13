const Product = require('../models/Product');

async function productRoutes(fastify, options) {
    // GET /api/products - Fetch products
    // Customers fetch active items. Admin app adds ?all=true to fetch everything.
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

    // POST /api/products - Add a new item to the catalog
    fastify.post('/api/products', async (request, reply) => {
        try {
            const { name, price, weightOrVolume, category } = request.body;
            const newProduct = new Product({ name, price, weightOrVolume, category });
            await newProduct.save();
            return { success: true, message: 'Product added successfully', data: newProduct };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error creating product' });
        }
    });

    // PUT /api/products/:id/toggle - Master switch for In-Stock / Out-of-Stock
    fastify.put('/api/products/:id/toggle', async (request, reply) => {
        try {
            const product = await Product.findById(request.params.id);
            if (!product) return reply.status(404).send({ success: false, message: 'Product not found' });
            
            // Instantly flip the visibility status
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

    // GET /api/seed - Temporary utility route to populate the database
    fastify.get('/api/seed', async (request, reply) => {
        try {
            // Clear existing products to prevent duplicates
            await Product.deleteMany({});
            
            const sampleProducts = [
                { name: 'Fresh Cow Milk', price: 60, weightOrVolume: '1 Liter', category: 'Dairy' },
                { name: 'Whole Wheat Bread', price: 45, weightOrVolume: '400g', category: 'Bakery' },
                { name: 'Farm Fresh Eggs', price: 80, weightOrVolume: '1 Dozen', category: 'Dairy' },
                { name: 'Organic Bananas', price: 50, weightOrVolume: '1 kg', category: 'Produce' },
                { name: 'Basmati Rice', price: 120, weightOrVolume: '1 kg', category: 'Pantry' },
                { name: 'Toor Dal', price: 160, weightOrVolume: '1 kg', category: 'Pantry' },
                { name: 'Amul Butter', price: 55, weightOrVolume: '100g', category: 'Dairy' }
            ];

            await Product.insertMany(sampleProducts);
            
            return { 
                success: true, 
                message: 'DailyPick database successfully seeded with sample products!' 
            };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error seeding database' });
        }
    });
}

module.exports = productRoutes;
