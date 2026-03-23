const Order = require('../models/Order');
const Product = require('../models/Product');
const Customer = require('../models/Customer');

// In-memory radio channels for live devices
let adminConnections = [];
let customerConnections = {};

// --- Heartbeat Interval ---
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

    fastify.get('/api/orders/stream/admin', (request, reply) => {
        reply.hijack(); 
        reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',  
            'X-Accel-Buffering': 'no'            
        });
        reply.raw.write('data: {"message": "Admin Stream Connected"}\n\n');
        
        adminConnections.push(reply.raw);

        request.raw.on('close', () => {
            adminConnections = adminConnections.filter(conn => conn !== reply.raw);
        });
    });

    fastify.get('/api/orders/stream/customer/:id', (request, reply) => {
        reply.hijack(); 
        const orderId = request.params.id;
        
        reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',  
            'X-Accel-Buffering': 'no'            
        });
        reply.raw.write('data: {"message": "Tracking Stream Connected"}\n\n');
        
        if (!customerConnections[orderId]) customerConnections[orderId] = [];
        customerConnections[orderId].push(reply.raw);

        request.raw.on('close', () => {
            customerConnections[orderId] = customerConnections[orderId].filter(conn => conn !== reply.raw);
        });
    });

    fastify.post('/api/orders', async (request, reply) => {
        try {
            const { 
                customerName, customerPhone, deliveryAddress, items, 
                totalAmount, deliveryType, scheduleTime, paymentMethod 
            } = request.body;
            
            if (paymentMethod === 'Pay Later') {
                const customerProfile = await Customer.findOne({ phone: customerPhone });
                
                if (!customerProfile || !customerProfile.isCreditEnabled) {
                    return reply.status(400).send({ success: false, message: 'Pay Later is not enabled for this account.' });
                }
                if ((customerProfile.creditUsed + totalAmount) > customerProfile.creditLimit) {
                    return reply.status(400).send({ success: false, message: `Credit limit exceeded. Available credit: ₹${customerProfile.creditLimit - customerProfile.creditUsed}` });
                }
                customerProfile.creditUsed += totalAmount;
                await customerProfile.save();
            }

            let custProfile = await Customer.findOne({ phone: customerPhone });
            if (!custProfile) {
                custProfile = new Customer({ phone: customerPhone, name: customerName });
                await custProfile.save();
            } else if (custProfile.name !== customerName) {
                custProfile.name = customerName; 
                await custProfile.save();
            }

            const newOrder = new Order({
                customerName, customerPhone, deliveryAddress, items, totalAmount,
                paymentMethod: paymentMethod || 'Cash on Delivery',
                deliveryType: deliveryType || 'Instant', 
                scheduleTime: scheduleTime || 'ASAP'
            });

            await newOrder.save();
            
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

    fastify.post('/api/orders/pos', async (request, reply) => {
        try {
            const { customerPhone, items, totalAmount, taxAmount, discountAmount, paymentMethod, splitDetails, pointsRedeemed } = request.body;
            let finalCustomerName = 'Walk-in Guest';

            if (customerPhone) {
                let custProfile = await Customer.findOne({ phone: customerPhone });
                if (custProfile) {
                    finalCustomerName = custProfile.name;
                    
                    if (pointsRedeemed && pointsRedeemed > 0) {
                        custProfile.loyaltyPoints = (custProfile.loyaltyPoints || 0) - pointsRedeemed;
                        if (custProfile.loyaltyPoints < 0) custProfile.loyaltyPoints = 0;
                    }

                    const earnedPoints = Math.floor(totalAmount / 100);
                    custProfile.loyaltyPoints = (custProfile.loyaltyPoints || 0) + earnedPoints;
                    
                    if (paymentMethod === 'Pay Later') {
                        if (!custProfile.isCreditEnabled) return reply.status(400).send({ success: false, message: 'Pay Later disabled.' });
                        if ((custProfile.creditUsed + totalAmount) > custProfile.creditLimit) {
                            return reply.status(400).send({ success: false, message: 'Credit limit exceeded.' });
                        }
                        custProfile.creditUsed += totalAmount;
                    }
                    await custProfile.save();
                } else {
                    const earnedPoints = Math.floor(totalAmount / 100);
                    custProfile = new Customer({ 
                        phone: customerPhone, 
                        name: 'In-Store Customer',
                        loyaltyPoints: earnedPoints
                    });
                    await custProfile.save();
                    finalCustomerName = 'In-Store Customer';
                }
            }

            for (const item of items) {
                try {
                    const product = await Product.findById(item.productId);
                    if (product && product.variants) {
                        const variant = product.variants.id(item.variantId);
                        if (variant && variant.stock >= item.qty) {
                            variant.stock -= item.qty;
                            await product.save();
                        }
                    }
                } catch(e) {
                    fastify.log.error('POS Stock Deduction Error:', e);
                }
            }

            const newOrder = new Order({
                customerName: finalCustomerName, 
                customerPhone: customerPhone || '', 
                deliveryAddress: 'In-Store Purchase', 
                items: items, 
                totalAmount: totalAmount,
                taxAmount: taxAmount || 0,           
                discountAmount: discountAmount || 0, 
                paymentMethod: paymentMethod,
                splitDetails: splitDetails || { cash: 0, upi: 0 }, 
                deliveryType: 'Instant', 
                status: 'Completed' 
            });

            await newOrder.save();

            return { success: true, message: 'POS Transaction Complete', orderId: newOrder._id, orderData: newOrder };
        } catch (error) {
            fastify.log.error('POS Checkout Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error processing POS transaction' });
        }
    });

    fastify.put('/api/orders/:id/status', async (request, reply) => {
        try {
            const { status } = request.body;
            const order = await Order.findByIdAndUpdate(
                request.params.id, 
                { status: status }, 
                { new: true }
            );
            
            if (!order) return reply.status(404).send({ success: false, message: 'Order not found' });

            if (customerConnections[order._id]) {
                customerConnections[order._id].forEach(conn => {
                    if (!conn.destroyed) {
                        conn.write(`data: ${JSON.stringify({ type: 'STATUS_UPDATE', status: status })}\n\n`);
                    }
                });
            }

            return { success: true, data: order };
        } catch (error) {
            fastify.log.error('Status Update Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error updating status' });
        }
    });

    fastify.put('/api/orders/:id/dispatch', async (request, reply) => {
        try {
            const order = await Order.findByIdAndUpdate(
                request.params.id, 
                { status: 'Dispatched' }, 
                { new: true }
            );
            
            if (!order) return reply.status(404).send({ success: false, message: 'Order not found' });

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

    fastify.put('/api/orders/:id/cancel', async (request, reply) => {
        try {
            const { reason } = request.body;
            const order = await Order.findById(request.params.id);
            
            if (!order) return reply.status(404).send({ success: false, message: 'Order not found' });
            
            order.status = 'Cancelled';

            if (order.paymentMethod === 'Pay Later') {
                const custProfile = await Customer.findOne({ phone: order.customerPhone });
                if (custProfile) {
                    custProfile.creditUsed -= order.totalAmount;
                    if (custProfile.creditUsed < 0) custProfile.creditUsed = 0;
                    await custProfile.save();
                }
            }

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

    fastify.get('/api/orders/analytics', async (request, reply) => {
        try {
            const orders = await Order.find({ status: { $in: ['Dispatched', 'Completed'] } });
            
            let revenueLast7Days = [0,0,0,0,0,0,0]; 
            const today = new Date();
            today.setHours(23,59,59,999);
            const sevenDaysAgo = new Date(today);
            sevenDaysAgo.setDate(today.getDate() - 6);
            sevenDaysAgo.setHours(0,0,0,0);

            let itemFrequency = {};

            orders.forEach(o => {
                const orderDate = new Date(o.createdAt);
                if (orderDate >= sevenDaysAgo && orderDate <= today) {
                    const dayDiff = Math.floor((orderDate - sevenDaysAgo) / (1000 * 60 * 60 * 24));
                    if(dayDiff >= 0 && dayDiff <= 6) {
                        revenueLast7Days[dayDiff] += o.totalAmount;
                    }
                }
                
                o.items.forEach(i => {
                    const key = `${i.name} (${i.selectedVariant})`;
                    if (!itemFrequency[key]) itemFrequency[key] = { qty: 0, revenue: 0 };
                    itemFrequency[key].qty += i.qty;
                    itemFrequency[key].revenue += (i.price * i.qty);
                });
            });

            const topItems = Object.entries(itemFrequency)
                .map(([name, stats]) => ({ name, qty: stats.qty, revenue: stats.revenue }))
                .sort((a,b) => b.qty - a.qty)
                .slice(0, 5); 

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
                    customers[phone].name = o.customerName; 
                }
            });

            const customerList = Object.values(customers).sort((a,b) => b.lifetimeValue - a.lifetimeValue);

            return { success: true, count: customerList.length, data: customerList };
        } catch (error) {
            fastify.log.error('CRM Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error fetching customers' });
        }
    });

    fastify.get('/api/orders', async (request, reply) => {
        try {
            const orders = await Order.find().sort({ createdAt: -1 });
            return { success: true, count: orders.length, data: orders };
        } catch (error) {
            fastify.log.error('Dispatch Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error fetching orders' });
        }
    });

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

    fastify.get('/api/customers/profile/:phone', async (request, reply) => {
        try {
            const cust = await Customer.findOne({ phone: request.params.phone });
            if (!cust) return { success: true, data: null }; 
            return { success: true, data: cust };
        } catch (error) {
            reply.status(500).send({ success: false, message: 'Error fetching profile' });
        }
    });

    fastify.put('/api/customers/profile/:phone/limit', async (request, reply) => {
        try {
            const { isCreditEnabled, creditLimit, name } = request.body;
            let cust = await Customer.findOne({ phone: request.params.phone });
            
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

    fastify.post('/api/customers/profile/:phone/pay', async (request, reply) => {
        try {
            const { amount } = request.body;
            let cust = await Customer.findOne({ phone: request.params.phone });
            
            if (!cust) return reply.status(404).send({ success: false, message: 'Customer not found.' });
            
            cust.creditUsed -= Number(amount);
            if (cust.creditUsed < 0) cust.creditUsed = 0; 
            
            await cust.save();
            return { success: true, data: cust, message: 'Payment recorded successfully' };
        } catch (error) {
            reply.status(500).send({ success: false, message: 'Error recording payment' });
        }
    });

    // --- NEW: Phase 5 Endpoint for Khata Scanning ---
    fastify.get('/api/customers', async (request, reply) => {
        try {
            const customers = await Customer.find({});
            return { success: true, count: customers.length, data: customers };
        } catch (error) {
            fastify.log.error('CRM Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error fetching all customers' });
        }
    });

}

module.exports = orderRoutes;
