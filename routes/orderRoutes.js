const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Customer = require('../models/Customer');
const AuditLog = require('../models/AuditLog'); 
const { Parser } = require('json2csv'); 

let Redis = null;
let redisPub = null;
let redisSub = null;
let redisCache = null; 
try {
    Redis = require('ioredis');
    if (process.env.REDIS_URL) {
        redisPub = new Redis(process.env.REDIS_URL);
        redisSub = new Redis(process.env.REDIS_URL);
        redisCache = new Redis(process.env.REDIS_URL);
        
        redisSub.subscribe('ORDER_STREAM_EVENT');
        redisSub.on('message', (channel, message) => {
            if (channel === 'ORDER_STREAM_EVENT') {
                const parsed = JSON.parse(message);
                if (parsed.target === 'admin') {
                    adminConnections.forEach(conn => {
                        if (!conn.destroyed) conn.write(`data: ${parsed.payload}\n\n`);
                    });
                } else if (parsed.target === 'customer' && customerConnections[parsed.orderId]) {
                    customerConnections[parsed.orderId].forEach(conn => {
                        if (!conn.destroyed) conn.write(`data: ${parsed.payload}\n\n`);
                    });
                }
            }
        });
    }
} catch (e) {}

let adminConnections = [];
let customerConnections = {};

setInterval(() => {
    adminConnections = adminConnections.filter(conn => {
        if (conn.destroyed || !conn.writable) return false;
        try {
            conn.write(':\n\n');
            return true;
        } catch (e) {
            return false; 
        }
    });

    for (const orderId in customerConnections) {
        customerConnections[orderId] = customerConnections[orderId].filter(conn => {
            if (conn.destroyed || !conn.writable) return false;
            try {
                conn.write(':\n\n');
                return true;
            } catch (e) {
                return false;
            }
        });
        if (customerConnections[orderId].length === 0) delete customerConnections[orderId];
    }
}, 15000);

const posCheckoutSchema = {
    schema: {
        body: {
            type: 'object',
            required: ['items', 'totalAmount'],
            properties: {
                customerPhone: { type: 'string' },
                items: { type: 'array' },
                totalAmount: { type: 'number' },
                taxAmount: { type: 'number' },
                discountAmount: { type: 'number' },
                paymentMethod: { type: 'string' },
                pointsRedeemed: { type: 'number' },
                notes: { type: 'string' },
                storeId: { type: 'string' }, 
                registerId: { type: 'string' } 
            }
        }
    }
};

const onlineCheckoutSchema = {
    schema: {
        body: {
            type: 'object',
            required: ['items', 'totalAmount', 'customerName', 'customerPhone', 'deliveryAddress'],
            properties: {
                customerName: { type: 'string' },
                customerPhone: { type: 'string' },
                deliveryAddress: { type: 'string' },
                items: { type: 'array' },
                totalAmount: { type: 'number' },
                paymentMethod: { type: 'string' },
                deliveryType: { type: 'string' },
                scheduleTime: { type: 'string' },
                notes: { type: 'string' },
                storeId: { type: 'string' } 
            }
        }
    }
};

const statusSchema = { schema: { body: { type: 'object', required: ['status'], properties: { status: { type: 'string' } } } } };
const cancelSchema = { schema: { body: { type: 'object', required: ['reason'], properties: { reason: { type: 'string' } } } } };
const limitSchema = { schema: { body: { type: 'object', required: ['isCreditEnabled', 'creditLimit'], properties: { isCreditEnabled: { type: 'boolean' }, creditLimit: { type: 'number' }, name: { type: 'string' } } } } };
const paySchema = { schema: { body: { type: 'object', required: ['amount'], properties: { amount: { type: 'number', minimum: 0 } } } } };
const assignDriverSchema = { schema: { body: { type: 'object', required: ['driverName'], properties: { driverName: { type: 'string' }, driverPhone: { type: 'string' } } } } };

const getOrdersSchema = {
    schema: {
        querystring: {
            type: 'object',
            properties: {
                tab: { type: 'string' },
                dateFilter: { type: 'string' },
                page: { type: 'string' },
                limit: { type: 'string' }
            }
        }
    }
};

async function orderRoutes(fastify, options) {

    fastify.decorate('closeAllSSE', () => {
        adminConnections.forEach(conn => { if (!conn.destroyed) conn.end(); });
        for (const orderId in customerConnections) {
            customerConnections[orderId].forEach(conn => { if (!conn.destroyed) conn.end(); });
        }
    });

    fastify.get('/api/orders/stream/admin', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, (request, reply) => {
        reply.hijack(); 
        reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': request.headers.origin || '*',  
            'Access-Control-Allow-Credentials': 'true',
            'X-Accel-Buffering': 'no'            
        });
        reply.raw.write('data: {"message": "Admin Stream Connected"}\n\n');
        
        adminConnections.push(reply.raw);

        request.raw.on('close', () => {
            adminConnections = adminConnections.filter(conn => conn !== reply.raw);
        });
    });

    fastify.get('/api/orders/stream/customer/:id', { preHandler: [fastify.authenticate] }, (request, reply) => {
        reply.hijack(); 
        const orderId = request.params.id;
        
        reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': request.headers.origin || '*',  
            'Access-Control-Allow-Credentials': 'true',
            'X-Accel-Buffering': 'no'            
        });
        reply.raw.write('data: {"message": "Tracking Stream Connected"}\n\n');
        
        if (!customerConnections[orderId]) customerConnections[orderId] = [];
        customerConnections[orderId].push(reply.raw);

        request.raw.on('close', () => {
            customerConnections[orderId] = customerConnections[orderId].filter(conn => conn !== reply.raw);
        });
    });

    fastify.post('/api/orders', { preHandler: [fastify.authenticate], ...onlineCheckoutSchema }, async (request, reply) => {
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            const { 
                customerName, customerPhone, deliveryAddress, items, 
                totalAmount, deliveryType, scheduleTime, paymentMethod, notes, storeId 
            } = request.body;
            
            if (paymentMethod === 'Pay Later') {
                const customerProfile = await Customer.findOne({ phone: customerPhone }).session(session);
                
                if (!customerProfile || !customerProfile.isCreditEnabled) {
                    await session.abortTransaction(); session.endSession();
                    return reply.status(400).send({ success: false, message: 'Pay Later is not enabled for this account.' });
                }
                if ((customerProfile.creditUsed + totalAmount) > customerProfile.creditLimit) {
                    await session.abortTransaction(); session.endSession();
                    return reply.status(400).send({ success: false, message: `Credit limit exceeded. Available credit: ₹${customerProfile.creditLimit - customerProfile.creditUsed}` });
                }
                customerProfile.creditUsed += totalAmount;
                await customerProfile.save({ session });
            }

            let custProfile = await Customer.findOne({ phone: customerPhone }).session(session);
            if (!custProfile) {
                custProfile = new Customer({ phone: customerPhone, name: customerName });
                await custProfile.save({ session });
            } else if (custProfile.name !== customerName) {
                custProfile.name = customerName; 
                await custProfile.save({ session });
            }

            // --- RACE CONDITION FIX: Atomic Quantity Verification ---
            for (const item of items) {
                const globalUpdate = await Product.updateOne(
                    { 
                        _id: item.productId, 
                        "variants._id": item.variantId,
                        "variants.stock": { $gte: item.qty } // Must have enough stock exactly when query runs
                    },
                    { $inc: { "variants.$.stock": -item.qty } },
                    { session }
                );

                if (globalUpdate.modifiedCount === 0) {
                    await session.abortTransaction(); session.endSession();
                    return reply.status(400).send({ success: false, message: `Insufficient global stock for item: ${item.name}` });
                }

                if (storeId) {
                    const localUpdate = await Product.updateOne(
                        { 
                            _id: item.productId,
                            "variants": { 
                                $elemMatch: { 
                                    "_id": item.variantId, 
                                    "locationInventory": { $elemMatch: { "storeId": storeId, "stock": { $gte: item.qty } } } 
                                } 
                            }
                        },
                        { $inc: { "variants.$[var].locationInventory.$[loc].stock": -item.qty } },
                        { arrayFilters: [{ "var._id": item.variantId }, { "loc.storeId": storeId }], session }
                    );
                    
                    if (localUpdate.modifiedCount === 0) {
                        await session.abortTransaction(); session.endSession();
                        return reply.status(400).send({ success: false, message: `Insufficient local store stock for item: ${item.name}` });
                    }
                }
            }

            const counter = await mongoose.model('OrderCounter').findByIdAndUpdate(
                { _id: 'orderId' },
                { $inc: { seq: 1 } },
                { new: true, upsert: true, session }
            );
            const orderNumber = `ORD-${counter.seq}`;
            const dateString = new Date().toISOString().split('T')[0];

            const newOrder = new Order({
                orderNumber, 
                dateString,
                storeId: storeId || null, 
                notes: notes || '',
                customerName, customerPhone, deliveryAddress, items, totalAmount,
                paymentMethod: paymentMethod || 'Cash on Delivery',
                deliveryType: deliveryType || 'Instant', 
                scheduleTime: scheduleTime || 'ASAP'
            });

            await newOrder.save({ session });
            await session.commitTransaction();
            session.endSession();
            
            if (redisCache) {
                try { await redisCache.del('orders:analytics'); } catch(e) {}
            }
            
            const payload = JSON.stringify({ type: 'NEW_ORDER', order: newOrder });
            if (redisPub) {
                redisPub.publish('ORDER_STREAM_EVENT', JSON.stringify({ target: 'admin', payload, storeId: storeId }));
            } else {
                adminConnections.forEach(conn => {
                    if (!conn.destroyed) {
                        conn.write(`data: ${payload}\n\n`);
                    }
                });
            }

            if (fastify.broadcastToPOS) fastify.broadcastToPOS({ type: 'NEW_ORDER', orderId: newOrder._id, storeId: storeId });

            if (customerPhone && customerPhone.length >= 10 && process.env.CALLMEBOT_API_KEY && process.env.WA_PHONE_NUMBER) {
                const msg = `DailyPick Order Received! 🛒\nOrder ID: ${newOrder.orderNumber}\nTotal: ₹${totalAmount}\nDelivery: ${scheduleTime}\nThanks for shopping!`;
                const waUrl = `https://api.callmebot.com/whatsapp.php?phone=${customerPhone}&text=${encodeURIComponent(msg)}&apikey=${process.env.CALLMEBOT_API_KEY}`;
                
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 3000);
                fetch(waUrl, { signal: controller.signal })
                    .catch(() => {})
                    .finally(() => clearTimeout(timeoutId)); 
            }

            return { success: true, message: 'Order Placed Successfully', orderId: newOrder._id };
        } catch (error) {
            await session.abortTransaction();
            session.endSession();
            fastify.log.error('Checkout Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error processing checkout' });
        }
    });

    fastify.post('/api/orders/pos', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...posCheckoutSchema }, async (request, reply) => {
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            const { customerPhone, items, totalAmount, taxAmount, discountAmount, paymentMethod, splitDetails, pointsRedeemed, notes, storeId, registerId } = request.body;
            let finalCustomerName = 'Walk-in Guest';

            if (customerPhone) {
                let custProfile = await Customer.findOne({ phone: customerPhone }).session(session);
                if (custProfile) {
                    finalCustomerName = custProfile.name;
                    
                    if (pointsRedeemed && pointsRedeemed > 0) {
                        custProfile.loyaltyPoints = (custProfile.loyaltyPoints || 0) - pointsRedeemed;
                        if (custProfile.loyaltyPoints < 0) custProfile.loyaltyPoints = 0;
                    }

                    const earnedPoints = Math.floor(totalAmount / 100);
                    custProfile.loyaltyPoints = (custProfile.loyaltyPoints || 0) + earnedPoints;
                    
                    if (paymentMethod === 'Pay Later') {
                        if (!custProfile.isCreditEnabled) {
                            await session.abortTransaction();
                            session.endSession();
                            return reply.status(400).send({ success: false, message: 'Pay Later disabled.' });
                        }
                        if ((custProfile.creditUsed + totalAmount) > custProfile.creditLimit) {
                            await session.abortTransaction();
                            session.endSession();
                            return reply.status(400).send({ success: false, message: 'Credit limit exceeded.' });
                        }
                        custProfile.creditUsed += totalAmount;
                    }
                    await custProfile.save({ session });
                } else {
                    const earnedPoints = Math.floor(totalAmount / 100);
                    custProfile = new Customer({ 
                        phone: customerPhone, 
                        name: 'In-Store Customer',
                        loyaltyPoints: earnedPoints
                    });
                    await custProfile.save({ session });
                    finalCustomerName = 'In-Store Customer';
                }
            }

            // --- RACE CONDITION FIX: Atomic Quantity Verification ---
            for (const item of items) {
                const globalUpdate = await Product.updateOne(
                    { 
                        _id: item.productId, 
                        "variants._id": item.variantId,
                        "variants.stock": { $gte: item.qty } 
                    },
                    { $inc: { "variants.$.stock": -item.qty } },
                    { session }
                );

                if (globalUpdate.modifiedCount === 0) {
                    await session.abortTransaction(); session.endSession();
                    return reply.status(400).send({ success: false, message: `Insufficient global stock for item: ${item.name}` });
                }

                if (storeId) {
                    const localUpdate = await Product.updateOne(
                        { 
                            _id: item.productId,
                            "variants": { 
                                $elemMatch: { 
                                    "_id": item.variantId, 
                                    "locationInventory": { $elemMatch: { "storeId": storeId, "stock": { $gte: item.qty } } } 
                                } 
                            }
                        },
                        { $inc: { "variants.$[var].locationInventory.$[loc].stock": -item.qty } },
                        { arrayFilters: [{ "var._id": item.variantId }, { "loc.storeId": storeId }], session }
                    );
                    
                    if (localUpdate.modifiedCount === 0) {
                        await session.abortTransaction(); session.endSession();
                        return reply.status(400).send({ success: false, message: `Insufficient local store stock for item: ${item.name}` });
                    }
                }
            }

            const counter = await mongoose.model('OrderCounter').findByIdAndUpdate(
                { _id: 'orderId' },
                { $inc: { seq: 1 } },
                { new: true, upsert: true, session }
            );
            const orderNumber = `ORD-${counter.seq}`;
            const dateString = new Date().toISOString().split('T')[0];

            const newOrder = new Order({
                orderNumber, 
                dateString,
                storeId: storeId || null,       
                registerId: registerId || null, 
                notes: notes || '',
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

            await newOrder.save({ session });
            await session.commitTransaction();
            session.endSession();
            
            if (redisCache) {
                try { await redisCache.del('orders:analytics'); } catch(e) {}
            }

            if (fastify.broadcastToPOS) fastify.broadcastToPOS({ type: 'NEW_ORDER', orderId: newOrder._id, source: 'POS', storeId: storeId });

            if (customerPhone && customerPhone.length >= 10 && process.env.CALLMEBOT_API_KEY && process.env.WA_PHONE_NUMBER) {
                const loyaltyMsg = pointsRedeemed > 0 ? ` Points Redeemed: ${pointsRedeemed}.` : '';
                const msg = `Thank you for shopping at DailyPick! 🛒\nOrder: ${newOrder.orderNumber}\nTotal: ₹${totalAmount}\n${loyaltyMsg}\nVisit again!`;
                const waUrl = `https://api.callmebot.com/whatsapp.php?phone=${customerPhone}&text=${encodeURIComponent(msg)}&apikey=${process.env.CALLMEBOT_API_KEY}`;
                
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 3000);
                fetch(waUrl, { signal: controller.signal })
                    .catch(() => {})
                    .finally(() => clearTimeout(timeoutId)); 
            }

            return { success: true, message: 'POS Transaction Complete', orderId: newOrder._id, orderData: newOrder };
        } catch (error) {
            await session.abortTransaction();
            session.endSession();
            fastify.log.error('POS Checkout Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error processing POS transaction' });
        }
    });

    fastify.put('/api/orders/:id/driver', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...assignDriverSchema }, async (request, reply) => {
        try {
            const { driverName, driverPhone } = request.body;
            const order = await Order.findByIdAndUpdate(
                request.params.id, 
                { deliveryDriverName: driverName, driverPhone: driverPhone || '' }, 
                { new: true }
            );
            
            if (!order) return reply.status(404).send({ success: false, message: 'Order not found' });
            return { success: true, data: order, message: 'Driver assigned successfully' };
        } catch (error) {
            fastify.log.error('Driver Assignment Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error assigning driver' });
        }
    });

    fastify.put('/api/orders/:id/status', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...statusSchema }, async (request, reply) => {
        try {
            const { status } = request.body;
            const order = await Order.findByIdAndUpdate(
                request.params.id, 
                { status: status }, 
                { new: true }
            );
            
            if (!order) return reply.status(404).send({ success: false, message: 'Order not found' });

            const payload = JSON.stringify({ type: 'STATUS_UPDATE', status: status });
            if (redisPub) {
                redisPub.publish('ORDER_STREAM_EVENT', JSON.stringify({ target: 'customer', orderId: order._id, payload }));
            } else {
                if (customerConnections[order._id]) {
                    customerConnections[order._id].forEach(conn => {
                        if (!conn.destroyed) conn.write(`data: ${payload}\n\n`);
                    });
                }
            }

            if (fastify.broadcastToPOS) fastify.broadcastToPOS({ type: 'ORDER_STATUS_UPDATED', orderId: order._id, status: status, storeId: order.storeId });

            return { success: true, data: order };
        } catch (error) {
            fastify.log.error('Status Update Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error updating status' });
        }
    });

    fastify.put('/api/orders/:id/dispatch', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, async (request, reply) => {
        try {
            const order = await Order.findByIdAndUpdate(
                request.params.id, 
                { status: 'Dispatched' }, 
                { new: true }
            );
            
            if (!order) return reply.status(404).send({ success: false, message: 'Order not found' });

            const payload = JSON.stringify({ type: 'STATUS_UPDATE', status: 'Dispatched' });
            if (redisPub) {
                redisPub.publish('ORDER_STREAM_EVENT', JSON.stringify({ target: 'customer', orderId: order._id, payload }));
            } else {
                if (customerConnections[order._id]) {
                    customerConnections[order._id].forEach(conn => {
                        if (!conn.destroyed) conn.write(`data: ${payload}\n\n`);
                    });
                }
            }

            if (fastify.broadcastToPOS) fastify.broadcastToPOS({ type: 'ORDER_STATUS_UPDATED', orderId: order._id, status: 'Dispatched', storeId: order.storeId });

            return { success: true, data: order };
        } catch (error) {
            fastify.log.error('Dispatch Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error dispatching order' });
        }
    });

    fastify.put('/api/orders/:id/partial-refund', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, async (request, reply) => {
        const session = await mongoose.startSession();
        session.startTransaction();
        try {
            const { productId, variantId, qtyToRefund, newTotalAmount } = request.body;
            const order = await Order.findById(request.params.id).session(session);
            if (!order) {
                await session.abortTransaction(); session.endSession();
                return reply.status(404).send({ success: false, message: 'Order not found' });
            }

            await Product.updateOne(
                { _id: productId, "variants._id": variantId },
                { $inc: { "variants.$.stock": qtyToRefund } },
                { session }
            );

            if (order.storeId) {
                await Product.updateOne(
                    { _id: productId },
                    { $inc: { "variants.$[var].locationInventory.$[loc].stock": qtyToRefund } },
                    { arrayFilters: [{ "var._id": variantId }, { "loc.storeId": order.storeId }], session }
                ).catch(() => {});
            }

            let updatedItems = [];
            for(let item of order.items) {
                if(item.productId === productId && item.variantId === variantId) {
                    item.qty = item.qty - qtyToRefund;
                    if(item.qty > 0) updatedItems.push(item);
                } else {
                    updatedItems.push(item);
                }
            }
            order.items = updatedItems;

            if (order.paymentMethod === 'Pay Later') {
                const diff = order.totalAmount - newTotalAmount;
                if (diff > 0) {
                    const custProfile = await Customer.findOne({ phone: order.customerPhone }).session(session);
                    if (custProfile) {
                        custProfile.creditUsed -= diff;
                        if (custProfile.creditUsed < 0) custProfile.creditUsed = 0;
                        await custProfile.save({ session });
                    }
                }
            }
            
            order.totalAmount = newTotalAmount;
            await order.save({ session });

            await AuditLog.create([{
                userId: request.user.id,
                username: request.user.username,
                action: 'PARTIAL_REFUND',
                targetType: 'Order',
                targetId: order._id.toString(),
                details: { refundedItem: productId, qty: qtyToRefund }
            }], { session });

            await session.commitTransaction();
            session.endSession();
            
            if (redisCache) { try { await redisCache.del('orders:analytics'); } catch(e) {} }
            return { success: true, message: 'Item Partially Refunded', data: order };
        } catch (error) {
            await session.abortTransaction();
            session.endSession();
            fastify.log.error('Partial Refund Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error processing refund' });
        }
    });

    fastify.put('/api/orders/:id/cancel', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...cancelSchema }, async (request, reply) => {
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            const { reason } = request.body;
            const order = await Order.findById(request.params.id).session(session);
            
            if (!order) {
                await session.abortTransaction(); session.endSession();
                return reply.status(404).send({ success: false, message: 'Order not found' });
            }
            
            order.status = 'Cancelled';

            if (order.paymentMethod === 'Pay Later') {
                const custProfile = await Customer.findOne({ phone: order.customerPhone }).session(session);
                if (custProfile) {
                    custProfile.creditUsed -= order.totalAmount;
                    if (custProfile.creditUsed < 0) custProfile.creditUsed = 0;
                    await custProfile.save({ session });
                }
            }

            for (const item of order.items) {
                await Product.updateOne(
                    { _id: item.productId, "variants._id": item.variantId },
                    { $inc: { "variants.$.stock": item.qty } },
                    { session }
                );

                if (order.storeId) {
                    await Product.updateOne(
                        { _id: item.productId },
                        { $inc: { "variants.$[var].locationInventory.$[loc].stock": item.qty } },
                        { arrayFilters: [{ "var._id": item.variantId }, { "loc.storeId": order.storeId }], session }
                    ).catch(() => {});
                }
            }

            await order.save({ session });
            
            const logEntry = new AuditLog({
                userId: request.user ? request.user.id : null,
                username: request.user ? request.user.username : 'System',
                action: 'CANCEL_ORDER',
                targetType: 'Order',
                targetId: order._id.toString(),
                details: { reason: reason || 'Not provided', amountRefunded: order.totalAmount }
            });
            await logEntry.save({ session });
            
            await session.commitTransaction();
            session.endSession();
            
            if (redisCache) {
                try { await redisCache.del('orders:analytics'); } catch(e) {}
            }

            const payload = JSON.stringify({ type: 'STATUS_UPDATE', status: 'Cancelled' });
            if (redisPub) {
                redisPub.publish('ORDER_STREAM_EVENT', JSON.stringify({ target: 'customer', orderId: order._id, payload }));
            } else {
                if (customerConnections[order._id]) {
                    customerConnections[order._id].forEach(conn => {
                        if (!conn.destroyed) conn.write(`data: ${payload}\n\n`);
                    });
                }
            }

            if (fastify.broadcastToPOS) fastify.broadcastToPOS({ type: 'ORDER_STATUS_UPDATED', orderId: order._id, status: 'Cancelled', storeId: order.storeId });

            return { success: true, message: 'Order Cancelled and Stock Refunded', data: order };
        } catch (error) {
            await session.abortTransaction();
            session.endSession();
            fastify.log.error('Cancel Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error cancelling order' });
        }
    });

    fastify.get('/api/orders/analytics', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, async (request, reply) => {
        try {
            if (redisCache) {
                const cachedAnalytics = await redisCache.get('orders:analytics');
                if (cachedAnalytics) {
                    return JSON.parse(cachedAnalytics); 
                }
            }
            
            const today = new Date();
            today.setHours(23, 59, 59, 999);
            const sevenDaysAgo = new Date(today);
            sevenDaysAgo.setDate(today.getDate() - 6);
            sevenDaysAgo.setHours(0, 0, 0, 0);

            const revenueAgg = await Order.aggregate([
                {
                    $match: {
                        status: { $in: ['Dispatched', 'Completed'] },
                        createdAt: { $gte: sevenDaysAgo, $lte: today }
                    }
                },
                {
                    $group: {
                        _id: "$dateString",
                        dailyRevenue: { $sum: "$totalAmount" }
                    }
                },
                { $sort: { _id: 1 } }
            ]);

            let revenueLast7Days = [0, 0, 0, 0, 0, 0, 0];
            const datesToMap = [];
            for(let i=0; i<7; i++){
                const d = new Date(sevenDaysAgo);
                d.setDate(sevenDaysAgo.getDate() + i);
                datesToMap.push(d.toISOString().split('T')[0]);
            }
            
            revenueAgg.forEach(item => {
                const index = datesToMap.indexOf(item._id);
                if (index !== -1) revenueLast7Days[index] = item.dailyRevenue;
            });

            const topItemsAgg = await Order.aggregate([
                {
                    $match: {
                        status: { $in: ['Dispatched', 'Completed'] },
                        createdAt: { $gte: sevenDaysAgo, $lte: today }
                    }
                },
                { $unwind: "$items" },
                {
                    $group: {
                        _id: {
                            name: "$items.name",
                            variant: "$items.selectedVariant"
                        },
                        qty: { $sum: "$items.qty" },
                        revenue: { $sum: { $multiply: ["$items.price", "$items.qty"] } }
                    }
                },
                { $sort: { qty: -1 } },
                { $limit: 5 }
            ]);

            const topItems = topItemsAgg.map(item => ({
                name: `${item._id.name} (${item._id.variant})`,
                qty: item.qty,
                revenue: item.revenue
            }));

            const responsePayload = { 
                success: true, 
                data: {
                    chartLabels: ['Day 1', 'Day 2', 'Day 3', 'Day 4', 'Day 5', 'Yesterday', 'Today'],
                    revenueData: revenueLast7Days,
                    topItems: topItems
                }
            };
            
            if (redisCache) {
                await redisCache.set('orders:analytics', JSON.stringify(responsePayload), 'EX', 900);
            }

            return responsePayload;
        } catch (error) {
            fastify.log.error('Analytics Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error fetching analytics' });
        }
    });

    fastify.get('/api/orders/customers', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, async (request, reply) => {
        try {
            const customerList = await Order.aggregate([
                { $match: { status: { $ne: 'Cancelled' } } },
                { $sort: { createdAt: 1 } }, 
                { 
                    $group: {
                        _id: { $ifNull: ["$customerPhone", "Unknown"] },
                        name: { $last: { $ifNull: ["$customerName", "Guest"] } },
                        phone: { $last: { $ifNull: ["$customerPhone", "Unknown"] } },
                        orderCount: { $sum: 1 },
                        lifetimeValue: { $sum: "$totalAmount" },
                        lastOrderDate: { $max: "$createdAt" }
                    }
                },
                { $sort: { lifetimeValue: -1 } },
                { $project: { _id: 0 } } 
            ]);

            return { success: true, count: customerList.length, data: customerList };
        } catch (error) {
            fastify.log.error('CRM Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error fetching customers' });
        }
    });

    fastify.get('/api/orders', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...getOrdersSchema }, async (request, reply) => {
        try {
            let filter = {};

            if (request.query.tab === 'Instant') filter.deliveryType = { $ne: 'Routine' };
            if (request.query.tab === 'Routine') filter.deliveryType = 'Routine';

            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const yesterday = new Date(today);
            yesterday.setDate(yesterday.getDate() - 1);
            const sevenDaysAgo = new Date(today);
            sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

            if (request.query.dateFilter === 'Today') {
                filter.createdAt = { $gte: today };
            } else if (request.query.dateFilter === 'Yesterday') {
                filter.createdAt = { $gte: yesterday, $lt: today };
            } else if (request.query.dateFilter === '7Days') {
                filter.createdAt = { $gte: sevenDaysAgo };
            }

            const page = parseInt(request.query.page) || 1;
            const limit = parseInt(request.query.limit);

            let query = Order.find(filter).sort({ createdAt: -1 });

            if (limit) {
                const skip = (page - 1) * limit;
                query = query.skip(skip).limit(limit);
            }

            const [orders, total, pendingOrders] = await Promise.all([
                query.lean(),
                Order.countDocuments(filter),
                Order.find({ status: { $in: ['Order Placed', 'Packing'] } }).lean()
            ]);

            const pendingRevenue = pendingOrders.reduce((sum, o) => sum + o.totalAmount, 0);

            return { 
                success: true, 
                count: orders.length, 
                total: total, 
                data: orders,
                stats: {
                    pendingCount: pendingOrders.length,
                    pendingRevenue: pendingRevenue
                }
            };
        } catch (error) {
            fastify.log.error('Fetch Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error fetching orders' });
        }
    });

    fastify.get('/api/orders/export', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, async (request, reply) => {
        try {
            const orders = await Order.find().sort({ createdAt: -1 }).lean();
            const exportData = orders.map(o => ({
                OrderID: o.orderNumber || o._id.toString(),
                Date: new Date(o.createdAt).toLocaleString(),
                CustomerName: o.customerName,
                Phone: o.customerPhone,
                TotalAmount: o.totalAmount,
                Status: o.status,
                PaymentMethod: o.paymentMethod,
                DeliveryType: o.deliveryType
            }));

            const json2csvParser = new Parser();
            const csv = json2csvParser.parse(exportData);

            reply.header('Content-Type', 'text/csv');
            reply.header('Content-Disposition', `attachment; filename="orders_export_${new Date().toISOString().split('T')[0]}.csv"`);
            return reply.send(csv);
        } catch (error) {
            fastify.log.error('Export Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error exporting orders' });
        }
    });

    fastify.get('/api/customers/export', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, async (request, reply) => {
        try {
            const customers = await Customer.find({}).lean();
            const exportData = customers.map(c => ({
                Name: c.name,
                Phone: c.phone,
                LoyaltyPoints: c.loyaltyPoints || 0,
                CreditEnabled: c.isCreditEnabled ? 'Yes' : 'No',
                CreditLimit: c.creditLimit || 0,
                CreditUsed: c.creditUsed || 0,
                JoinedDate: new Date(c.createdAt).toLocaleDateString()
            }));

            const json2csvParser = new Parser();
            const csv = json2csvParser.parse(exportData);

            reply.header('Content-Type', 'text/csv');
            reply.header('Content-Disposition', `attachment; filename="customers_export_${new Date().toISOString().split('T')[0]}.csv"`);
            return reply.send(csv);
        } catch (error) {
            fastify.log.error('Export Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error exporting customers' });
        }
    });

    fastify.get('/api/orders/:id', { preHandler: [fastify.authenticate] }, async (request, reply) => {
        try {
            const order = await Order.findById(request.params.id).lean();
            if (!order) return reply.status(404).send({ success: false, message: 'Order not found' });
            return { success: true, data: order };
        } catch (error) {
            fastify.log.error('Tracking Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error fetching order status' });
        }
    });

    fastify.get('/api/customers/profile/:phone', { preHandler: [fastify.authenticate] }, async (request, reply) => {
        try {
            const cust = await Customer.findOne({ phone: request.params.phone }).lean();
            if (!cust) return { success: true, data: null }; 
            return { success: true, data: cust };
        } catch (error) {
            reply.status(500).send({ success: false, message: 'Error fetching profile' });
        }
    });

    fastify.put('/api/customers/profile/:phone/limit', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...limitSchema }, async (request, reply) => {
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

    fastify.post('/api/customers/profile/:phone/pay', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...paySchema }, async (request, reply) => {
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

    fastify.get('/api/customers', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, async (request, reply) => {
        try {
            const customers = await Customer.find({}).lean();
            return { success: true, count: customers.length, data: customers };
        } catch (error) {
            fastify.log.error('CRM Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error fetching all customers' });
        }
    });

}

module.exports = orderRoutes;
