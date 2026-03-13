const Order = require('../models/Order');

async function orderRoutes(fastify, options) {
    // POST /api/orders - Receive cart data and delivery details
    fastify.post('/api/orders', async (request, reply) => {
        try {
            const { 
                customerName, 
                customerPhone, 
                deliveryAddress, 
                items, 
                totalAmount,
                deliveryType,
                scheduleTime
            } = request.body;
            
            // Construct the database ticket with the new routing and schedule data
            const newOrder = new Order({
                customerName,
                customerPhone,
                deliveryAddress,
                items,
                totalAmount,
                deliveryType: deliveryType || 'Instant',
                scheduleTime: scheduleTime || 'ASAP'
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
            reply.status(500).send({ 
                success: false, 
                message: 'Server Error processing checkout' 
            });
        }
    });

    // GET /api/orders - Dispatch active orders to the Admin Live Operations Center
    fastify.get('/api/orders', async (request, reply) => {
        try {
            // Fetch all orders, sorting by the newest first (-1)
            const orders = await Order.find().sort({ createdAt: -1 });
            
            return { 
                success: true, 
                count: orders.length,
                data: orders 
            };
        } catch (error) {
            fastify.log.error('Dispatch Error:', error);
            reply.status(500).send({ 
                success: false, 
                message: 'Server Error fetching orders' 
            });
        }
    });

    // GET /api/orders/:id - Fetch a single order's status for the customer app
    fastify.get('/api/orders/:id', async (request, reply) => {
        try {
            const order = await Order.findById(request.params.id);
            
            if (!order) {
                return reply.status(404).send({ 
                    success: false, 
                    message: 'Order not found' 
                });
            }
            
            return { 
                success: true, 
                data: order 
            };
        } catch (error) {
            fastify.log.error('Tracking Error:', error);
            reply.status(500).send({ 
                success: false, 
                message: 'Server Error fetching order status' 
            });
        }
    });
}

module.exports = orderRoutes;
