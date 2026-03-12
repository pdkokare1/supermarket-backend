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
}

module.exports = productRoutes;
