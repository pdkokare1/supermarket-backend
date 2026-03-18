const Order = require('../models/Order');
const Product = require('../models/Product'); // <-- Needed for cancelling orders (stock refund)
const Customer = require('../models/Customer'); // <-- Needed for persistent credit ledger

// In-memory radio channels for live devices
let adminConnections = [];
let customerConnections = {};

// --- Heartbeat Interval ---
// Keeps connections alive so the cloud proxy doesn't drop them
setInterval(() => {
    adminConnections = adminConnections.filter(conn => !conn.destroyed);
    adminConnections.forEach(conn => conn.write(':\n\n'));

    for (const orderId in customerConnections) {
        customerConnections[orderId] = customerConnections[orderId].filter(conn => !conn.destroyed);
        customerConnections[orderId].forEach(conn => conn.write(':\n\n'));
        if (customerConnections[orderId].length === 0) delete customerConnections[orderId];
    }
}, 15000);

async function orderRoutes(fastify, options) {

    // 1. PUSH CHANNEL: ADMIN LIVE STREAM
    fastify.get('/api/orders/stream/admin', (request, reply) => {
        reply.hijack(); 
        
        reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',  // <-- RESTORED: Bypasses strict browser blocks
            'X-Accel-Buffering': 'no'            // <-- Forces Railway to send data instantly
        });
        reply.raw.write('data: {"message": "Admin Stream Connected"}\n\n');
        
        adminConnections.push(reply.raw);

        request.raw.on('close', () => {
            adminConnections = adminConnections.filter(conn => conn !== reply.raw);
        });
    });

    // 2. PUSH CHANNEL: CUSTOMER TRACKING STREAM
    fastify.get('/api/orders/stream/customer/:id', (request, reply) => {
        reply.hijack(); 
        
        const orderId = request.params.id;
        
        reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',  // <-- RESTORED
            'X-Accel-Buffering': 'no'            // <-- Forces Railway to send data instantly
        });
        reply.raw.write('data: {"message": "Tracking Stream Connected"}\n\n');
        
        if (!customerConnections[orderId]) customerConnections[orderId] = [];
        customerConnections[orderId].push(reply.raw);

        request.raw.on('close', () => {
            customerConnections[orderId] = customerConnections[orderId].filter(conn => conn !== reply.raw);
        });
    });

    // 3. POST /api/orders - Checkout (With Real-Time Admin Broadcast)
    fastify.post('/api/orders', async (request, reply) => {
        try {
            const { 
                customerName, customerPhone, deliveryAddress, items, 
                totalAmount, deliveryType, scheduleTime, paymentMethod 
            } = request.body;
            
            // --- Pay Later Credit Check Logic ---
            if (paymentMethod === 'Pay Later') {
                const customerProfile = await Customer.findOne({ phone: customerPhone });
                
                if (!customerProfile || !customerProfile.isCreditEnabled) {
                    return reply.status(400).send({ success: false, message: 'Pay Later is not enabled for this account.' });
                }
                if ((customerProfile.creditUsed + totalAmount) > customerProfile.creditLimit) {
                    return reply.status(400).send({ success: false, message: `Credit limit exceeded. Available credit: ₹${customerProfile.creditLimit - customerProfile.creditUsed}` });
                }
                
                // Deduct from their available credit by increasing their used amount
                customerProfile.creditUsed += totalAmount;
                await customerProfile.save();
            }

            // --- Auto-create/update customer profile permanently in the background ---
            let custProfile = await Customer.findOne({ phone: customerPhone });
            if (!custProfile) {
                custProfile = new Customer({ phone: customerPhone, name: customerName });
                await custProfile.save();
            } else if (custProfile.name !== customerName) {
                custProfile.name = customerName; // Update name if they changed it
                await custProfile.save();
            }

            const newOrder = new Order({
                customerName, customerPhone, deliveryAddress, items, totalAmount,
                paymentMethod: paymentMethod || 'Cash on Delivery',
                deliveryType: deliveryType || 'Instant', 
                scheduleTime: scheduleTime || 'ASAP'
            });

            await newOrder.save();
            
            // INSTANTLY PUSH TO ALL CONNECTED ADMIN TABLETS (With Safety Check)
            adminConnections.forEach(conn => {
                if (!conn.destroyed) {
                    conn.write(`data: ${JSON.stringify({ type: 'NEW_ORDER', order: newOrder })}\n\n`);
                }
            });

            return { success: true, message: 'Order Placed Successfully', orderId: newOrder._id };
        } catch (error) {
            fastify.log.error('Checkout Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error processing checkout' });
        }
    });

    // 4. PUT /api/orders/:id/dispatch - Triggers Customer Broadcast
    fastify.put('/api/orders/:id/dispatch', async (request, reply) => {
        try {
            const order = await Order.findByIdAndUpdate(
                request.params.id, 
                { status: 'Dispatched' }, 
                { new: true }
            );
            
            if (!order) return reply.status(404).send({ success: false, message: 'Order not found' });

            // INSTANTLY PUSH TO THE SPECIFIC CUSTOMER'S PHONE (With Safety Check)
            if (customerConnections[order._id]) {
                customerConnections[order._id].forEach(conn => {
                    if (!conn.destroyed) {
                        conn.write(`data: ${JSON.stringify({ type: 'STATUS_UPDATE', status: 'Dispatched' })}\n\n`);
                    }
                });
            }

            return { success: true, data: order };
        } catch (error) {
            fastify.log.error('Dispatch Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error dispatching order' });
        }
    });

    // --- Cancel Order & Refund Stock ---
    fastify.put('/api/orders/:id/cancel', async (request, reply) => {
        try {
            const { reason } = request.body;
            const order = await Order.findById(request.params.id);
            
            if (!order) return reply.status(404).send({ success: false, message: 'Order not found' });
            
            order.status = 'Cancelled';

            // --- Refund Credit Limit if cancelled ---
            if (order.paymentMethod === 'Pay Later') {
                const custProfile = await Customer.findOne({ phone: order.customerPhone });
                if (custProfile) {
                    custProfile.creditUsed -= order.totalAmount;
                    if (custProfile.creditUsed < 0) custProfile.creditUsed = 0;
                    await custProfile.save();
                }
            }

            // Safely refund stock for each item
            for (const item of order.items) {
                try {
                    const product = await Product.findById(item.productId);
                    if (product && product.variants) {
                        const variant = product.variants.id(item.variantId);
                        if (variant) {
                            variant.stock += item.qty;
                            await product.save();
                        }
                    }
                } catch(e) {
                    fastify.log.error('Stock Refund Error for item:', item, e);
                }
            }

            await order.save();

            // Broadcast to Customer if connected
            if (customerConnections[order._id]) {
                customerConnections[order._id].forEach(conn => {
                    if (!conn.destroyed) {
                        conn.write(`data: ${JSON.stringify({ type: 'STATUS_UPDATE', status: 'Cancelled' })}\n\n`);
                    }
                });
            }

            return { success: true, message: 'Order Cancelled and Stock Refunded', data: order };
        } catch (error) {
            fastify.log.error('Cancel Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error cancelling order' });
        }
    });

    // --- Analytics Aggregation ---
    fastify.get('/api/orders/analytics', async (request, reply) => {
        try {
            // Get all orders completed or dispatched
            const orders = await Order.find({ status: { $in: ['Dispatched', 'Completed'] } });
            
            let revenueLast7Days = [0,0,0,0,0,0,0]; // Today is index 6
            const today = new Date();
            today.setHours(23,59,59,999);
            const sevenDaysAgo = new Date(today);
            sevenDaysAgo.setDate(today.getDate() - 6);
            sevenDaysAgo.setHours(0,0,0,0);

            let itemFrequency = {};

            orders.forEach(o => {
                const orderDate = new Date(o.createdAt);
                if (orderDate >= sevenDaysAgo && orderDate <= today) {
                    // Calculate which day bucket (0-6)
                    const dayDiff = Math.floor((orderDate - sevenDaysAgo) / (1000 * 60 * 60 * 24));
                    if(dayDiff >= 0 && dayDiff <= 6) {
                        revenueLast7Days[dayDiff] += o.totalAmount;
                    }
                }
                
                // Track top items
                o.items.forEach(i => {
                    const key = `${i.name} (${i.selectedVariant})`;
                    if (!itemFrequency[key]) itemFrequency[key] = { qty: 0, revenue: 0 };
                    itemFrequency[key].qty += i.qty;
                    itemFrequency[key].revenue += (i.price * i.qty);
                });
            });

            // Sort top items
            const topItems = Object.entries(itemFrequency)
                .map(([name, stats]) => ({ name, qty: stats.qty, revenue: stats.revenue }))
                .sort((a,b) => b.qty - a.qty)
                .slice(0, 5); // Top 5

            return { 
                success: true, 
                data: {
                    chartLabels: ['Day 1', 'Day 2', 'Day 3', 'Day 4', 'Day 5', 'Yesterday', 'Today'],
                    revenueData: revenueLast7Days,
                    topItems: topItems
                }
            };
        } catch (error) {
            fastify.log.error('Analytics Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error fetching analytics' });
        }
    });

    // --- Customer CRM Aggregation ---
    fastify.get('/api/orders/customers', async (request, reply) => {
        try {
            const orders = await Order.find({ status: { $ne: 'Cancelled' } });
            let customers = {};

            orders.forEach(o => {
                const phone = o.customerPhone || 'Unknown';
                if (!customers[phone]) {
                    customers[phone] = {
                        name: o.customerName || 'Guest',
                        phone: phone,
                        orderCount: 0,
                        lifetimeValue: 0,
                        lastOrderDate: o.createdAt
                    };
                }
                customers[phone].orderCount += 1;
                customers[phone].lifetimeValue += o.totalAmount;
                if (new Date(o.createdAt) > new Date(customers[phone].lastOrderDate)) {
                    customers[phone].lastOrderDate = o.createdAt;
                    customers[phone].name = o.customerName; // Update to latest known name
                }
            });

            const customerList = Object.values(customers).sort((a,b) => b.lifetimeValue - a.lifetimeValue);

            return { success: true, count: customerList.length, data: customerList };
        } catch (error) {
            fastify.log.error('CRM Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error fetching customers' });
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

    // =========================================================
    // --- CUSTOMER CREDIT MANAGEMENT ROUTES ---
    // =========================================================

    // Fetch a specific customer's credit profile
    fastify.get('/api/customers/profile/:phone', async (request, reply) => {
        try {
            const cust = await Customer.findOne({ phone: request.params.phone });
            if (!cust) return { success: true, data: null }; 
            return { success: true, data: cust };
        } catch (error) {
            reply.status(500).send({ success: false, message: 'Error fetching profile' });
        }
    });

    // Update Credit Limit & Enable/Disable (NOW AUTO-CREATES MISSING USERS)
    fastify.put('/api/customers/profile/:phone/limit', async (request, reply) => {
        try {
            const { isCreditEnabled, creditLimit, name } = request.body;
            let cust = await Customer.findOne({ phone: request.params.phone });
            
            // If the user isn't in the new Customer DB, create them instantly!
            if (!cust) {
                cust = new Customer({ 
                    phone: request.params.phone, 
                    name: name || 'Valued Customer' 
                });
            }
            
            cust.isCreditEnabled = isCreditEnabled;
            cust.creditLimit = Number(creditLimit);
            await cust.save();
            
            return { success: true, data: cust };
        } catch (error) {
            reply.status(500).send({ success: false, message: 'Error updating limit' });
        }
    });

    // Record a partial or full payment from a customer
    fastify.post('/api/customers/profile/:phone/pay', async (request, reply) => {
        try {
            const { amount } = request.body;
            let cust = await Customer.findOne({ phone: request.params.phone });
            
            if (!cust) return reply.status(404).send({ success: false, message: 'Customer not found.' });
            
            cust.creditUsed -= Number(amount);
            if (cust.creditUsed < 0) cust.creditUsed = 0; // Prevent negative balances
            
            await cust.save();
            return { success: true, data: cust, message: 'Payment recorded successfully' };
        } catch (error) {
            reply.status(500).send({ success: false, message: 'Error recording payment' });
        }
    });

}

module.exports = orderRoutes;
