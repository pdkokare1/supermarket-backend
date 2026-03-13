const Order = require('../models/Order');

async function orderRoutes(fastify, options) {
    // POST /api/orders - Receive cart data and create a new order ticket
    fastify.post('/api/orders', async (request, reply) => {
        try {
            const { items, totalAmount } = request.body;
            
            // Construct the database ticket
            const newOrder = new Order({
                items: items,
                totalAmount: totalAmount
            });

            // Lock it into MongoDB
            await newOrder.save();
            
            return { 
                success: true, 
                message: 'Order Placed Successfully', 
                orderId: newOrder._id 
            };
        } catch (error) {
            fastify.log.error('Checkout Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error processing checkout' });
        }
    });
}

module.exports = orderRoutes;
