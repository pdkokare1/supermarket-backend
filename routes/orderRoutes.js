const Order = require('../models/Order');

// In-memory radio channels for live devices
let adminConnections = [];
let customerConnections = {};

async function orderRoutes(fastify, options) {

    // 1. PUSH CHANNEL: ADMIN LIVE STREAM
    fastify.get('/api/orders/stream/admin', (request, reply) => {
        reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });
        reply.raw.write('data: {"message": "Admin Stream Connected"}\n\n');
        
        adminConnections.push(reply.raw);

        // If the admin closes the app, remove their connection
        request.raw.on('close', () => {
            adminConnections = adminConnections.filter(conn => conn !== reply.raw);
        });
    });

    // 2. PUSH CHANNEL: CUSTOMER TRACKING STREAM
    fastify.get('/api/orders/stream/customer/:id', (request, reply) => {
        const orderId = request.params.id;
        
        reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });
        reply.raw.write('data: {"message": "Tracking Stream Connected"}\n\n');
        
        if (!customerConnections[orderId]) customerConnections[orderId] = [];
        customerConnections[orderId].push(reply.raw);

        request.raw.on('close', () => {
            customerConnections[orderId] = customerConnections[orderId].filter(conn => conn !== reply.raw);
        });
    });

    // 3. POST /api/orders - Checkout (Now with Real-Time Admin Broadcast)
    fastify.post('/api/orders', async (request, reply) => {
        try {
            const { customerName, customerPhone, deliveryAddress, items, totalAmount, deliveryType, scheduleTime } = request.body;
            
            const newOrder = new Order({
                customerName, customerPhone, deliveryAddress, items, totalAmount,
                deliveryType: deliveryType || 'Instant', scheduleTime: scheduleTime || 'ASAP'
            });

            await newOrder.save();
            
            // INSTANTLY PUSH TO ALL CONNECTED ADMIN TABLETS
            adminConnections.forEach(conn => {
                conn.write(`data: ${JSON.stringify({ type: 'NEW_ORDER', order: newOrder })}\n\n`);
            });

            return { success: true, message: 'Order Placed Successfully', orderId: newOrder._id };
        } catch (error) {
            fastify.log.error('Checkout Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error processing checkout' });
        }
    });

    // 4. PUT /api/orders/:id/dispatch - NEW ACTION (Triggers Customer Broadcast)
    fastify.put('/api/orders/:id/dispatch', async (request, reply) => {
        try {
            const order = await Order.findByIdAndUpdate(
                request.params.id, 
                { status: 'Dispatched' }, 
                { new: true }
            );
            
            if (!order) return reply.status(404).send({ success: false, message: 'Order not found' });

            // INSTANTLY PUSH TO THE SPECIFIC CUSTOMER'S PHONE
            if (customerConnections[order._id]) {
                customerConnections[order._id].forEach(conn => {
                    conn.write(`data: ${JSON.stringify({ type: 'STATUS_UPDATE', status: 'Dispatched' })}\n\n`);
                });
            }

            return { success: true, data: order };
        } catch (error) {
            fastify.log.error('Dispatch Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error dispatching order' });
        }
    });

    // 5. GET /api/orders - Standard Fetch
    fastify.get('/api/orders', async (request, reply) => {
        try {
            const orders = await Order.find().sort({ createdAt: -1 });
            return { success: true, count: orders.length, data: orders };
        } catch (error) {
            fastify.log.error('Dispatch Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error fetching orders' });
        }
    });

    // 6. GET /api/orders/:id - Standard Tracking Fetch
    fastify.get('/api/orders/:id', async (request, reply) => {
        try {
            const order = await Order.findById(request.params.id);
            if (!order) return reply.status(404).send({ success: false, message: 'Order not found' });
            return { success: true, data: order };
        } catch (error) {
            fastify.log.error('Tracking Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error fetching order status' });
        }
    });
}

module.exports = orderRoutes;
