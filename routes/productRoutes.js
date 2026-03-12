const Product = require('../models/Product');

async function productRoutes(fastify, options) {
    // GET /api/products - Fetch all active products for the storefront
    fastify.get('/api/products', async (request, reply) => {
        try {
            // Only fetch products that are currently active and in-stock
            const products = await Product.find({ isActive: true });
            return { success: true, count: products.length, data: products };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error fetching products' });
        }
    });

    // GET /api/seed - Temporary utility route to populate the database
    fastify.get('/api/seed', async (request, reply) => {
        try {
            // Clear existing products to prevent duplicates if the route is hit multiple times
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

            // Bulk insert the sample data
            await Product.insertMany(sampleProducts);
            
            return { 
                success: true, 
                message: 'The Gamut database successfully seeded with 7 sample products!' 
            };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error seeding database' });
        }
    });
}

module.exports = productRoutes;
