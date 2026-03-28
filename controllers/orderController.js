/* controllers/orderController.js */

const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Customer = require('../models/Customer');
const AuditLog = require('../models/AuditLog'); 
const { Parser } = require('json2csv'); 
const sseService = require('../services/orderSseService');

// ==========================================
// --- NEW HELPER FUNCTIONS (OPTIMIZATION) ---
// ==========================================

// Helper 1: Centralized Redis Cache Invalidation
async function clearAnalyticsCache() {
    if (sseService.redisCache) {
        try { await sseService.redisCache.del('orders:analytics'); } catch(e) {}
    }
}

// Helper 2: Centralized WhatsApp Notification using CallMeBot
function sendWhatsAppMessage(phone, msg) {
    if (phone && phone.length >= 10 && process.env.CALLMEBOT_API_KEY && process.env.WA_PHONE_NUMBER) {
        const waUrl = `https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${encodeURIComponent(msg)}&apikey=${process.env.CALLMEBOT_API_KEY}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 3000);
        fetch(waUrl, { signal: controller.signal }).catch(() => {}).finally(() => clearTimeout(timeoutId)); 
    }
}

// Helper 3: Centralized Order Number Generation
async function generateOrderSequence(session) {
    const counter = await mongoose.model('OrderCounter').findByIdAndUpdate(
        { _id: 'orderId' },
        { $inc: { seq: 1 } },
        { new: true, upsert: true, session }
    );
    return counter.seq;
}

// --- OPTIMIZATION: Consolidated Reusable Inventory Logic ---
async function deductInventory(items, storeId, session) {
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
            return { success: false, message: `Insufficient global stock for item: ${item.name}` };
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
                return { success: false, message: `Insufficient local store stock for item: ${item.name}` };
            }
        }
    }
    return { success: true };
}

// ==========================================
// --- CONTROLLER EXPORTS ---
// ==========================================

exports.streamAdmin = async (request, reply) => {
    reply.hijack(); 
    reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': request.headers.origin || '*',  
        'Access-Control-Allow-Credentials': 'true',
        'X-Accel-Buffering': 'no'            
    });
    reply.raw.write('data: {"message": "Admin Stream Connected"}\n\n');
    
    sseService.addAdminConnection(reply.raw);

    request.raw.on('close', () => {
        sseService.removeAdminConnection(reply.raw);
    });
};

exports.streamCustomer = async (request, reply) => {
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
    
    sseService.addCustomerConnection(orderId, reply.raw);

    request.raw.on('close', () => {
        sseService.removeCustomerConnection(orderId, reply.raw);
    });
};

exports.externalCheckout = async (request, reply) => {
    const apiKey = request.headers['x-api-key'];
    if (!apiKey || apiKey !== process.env.EXTERNAL_API_KEY) {
        return reply.status(401).send({ success: false, message: 'Unauthorized webhook access.' });
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const { source, externalOrderId, customerName, customerPhone, deliveryAddress, items, totalAmount, paymentMethod, notes, storeId } = request.body;

        const inventoryCheck = await deductInventory(items, storeId, session);
        if (!inventoryCheck.success) {
            await session.abortTransaction(); session.endSession();
            return reply.status(400).send(inventoryCheck);
        }

        const seqNumber = await generateOrderSequence(session);
        const orderNumber = `EXT-${source.toUpperCase().substring(0, 3)}-${seqNumber}`;
        const dateString = new Date().toISOString().split('T')[0];
        const formattedNotes = `[${source.toUpperCase()}] Ext ID: ${externalOrderId || 'N/A'}. ${notes || ''}`;

        const newOrder = new Order({
            orderNumber, dateString, storeId: storeId || null, notes: formattedNotes,
            customerName: customerName || `${source} Customer`, customerPhone: customerPhone || '', 
            deliveryAddress: deliveryAddress || `${source} Pickup`, items, totalAmount,
            paymentMethod: paymentMethod || 'Prepaid External', deliveryType: 'Instant', status: 'Order Placed'
        });

        await newOrder.save({ session });
        await session.commitTransaction();
        session.endSession();
        
        await clearAnalyticsCache();
        
        const payload = JSON.stringify({ type: 'NEW_ORDER', order: newOrder, source: source });
        sseService.publishEvent('admin', payload, { storeId });

        if (request.server.broadcastToPOS) request.server.broadcastToPOS({ type: 'NEW_ORDER', orderId: newOrder._id, source: source, storeId: storeId });

        return { success: true, message: `External Order Accepted from ${source}`, orderId: newOrder._id, orderNumber: orderNumber };
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        request.server.log.error('External Checkout Error:', error);
        reply.status(500).send({ success: false, message: 'Server Error processing external checkout' });
    }
};

exports.onlineCheckout = async (request, reply) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const { customerName, customerPhone, deliveryAddress, items, totalAmount, deliveryType, scheduleTime, paymentMethod, notes, storeId } = request.body;
        
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

        const inventoryCheck = await deductInventory(items, storeId, session);
        if (!inventoryCheck.success) {
            await session.abortTransaction(); session.endSession();
            return reply.status(400).send(inventoryCheck);
        }

        const seqNumber = await generateOrderSequence(session);
        const orderNumber = `ORD-${seqNumber}`;
        const dateString = new Date().toISOString().split('T')[0];

        const newOrder = new Order({
            orderNumber, dateString, storeId: storeId || null, notes: notes || '',
            customerName, customerPhone, deliveryAddress, items, totalAmount,
            paymentMethod: paymentMethod || 'Cash on Delivery', deliveryType: deliveryType || 'Instant', scheduleTime: scheduleTime || 'ASAP'
        });

        await newOrder.save({ session });
        await session.commitTransaction();
        session.endSession();
        
        await clearAnalyticsCache();
        
        const payload = JSON.stringify({ type: 'NEW_ORDER', order: newOrder });
        sseService.publishEvent('admin', payload, { storeId });

        if (request.server.broadcastToPOS) request.server.broadcastToPOS({ type: 'NEW_ORDER', orderId: newOrder._id, storeId: storeId });

        const msg = `DailyPick Order Received! 🛒\nOrder ID: ${newOrder.orderNumber}\nTotal: ₹${totalAmount}\nDelivery: ${scheduleTime}\nThanks for shopping!`;
        sendWhatsAppMessage(customerPhone, msg);

        return { success: true, message: 'Order Placed Successfully', orderId: newOrder._id };
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        request.server.log.error('Checkout Error:', error);
        reply.status(500).send({ success: false, message: 'Server Error processing checkout' });
    }
};

exports.posCheckout = async (request, reply) => {
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
                        await session.abortTransaction(); session.endSession();
                        return reply.status(400).send({ success: false, message: 'Pay Later disabled.' });
                    }
                    if ((custProfile.creditUsed + totalAmount) > custProfile.creditLimit) {
                        await session.abortTransaction(); session.endSession();
                        return reply.status(400).send({ success: false, message: 'Credit limit exceeded.' });
                    }
                    custProfile.creditUsed += totalAmount;
                }
                await custProfile.save({ session });
            } else {
                const earnedPoints = Math.floor(totalAmount / 100);
                custProfile = new Customer({ phone: customerPhone, name: 'In-Store Customer', loyaltyPoints: earnedPoints });
                await custProfile.save({ session });
                finalCustomerName = 'In-Store Customer';
            }
        }

        const inventoryCheck = await deductInventory(items, storeId, session);
        if (!inventoryCheck.success) {
            await session.abortTransaction(); session.endSession();
            return reply.status(400).send(inventoryCheck);
        }

        const seqNumber = await generateOrderSequence(session);
        const orderNumber = `ORD-${seqNumber}`;
        const dateString = new Date().toISOString().split('T')[0];

        const newOrder = new Order({
            orderNumber, dateString, storeId: storeId || null, registerId: registerId || null, notes: notes || '',
            customerName: finalCustomerName, customerPhone: customerPhone || '', deliveryAddress: 'In-Store Purchase', 
            items, totalAmount, taxAmount: taxAmount || 0, discountAmount: discountAmount || 0, paymentMethod,
            splitDetails: splitDetails || { cash: 0, upi: 0 }, deliveryType: 'Instant', status: 'Completed' 
        });

        await newOrder.save({ session });
        await session.commitTransaction();
        session.endSession();
        
        await clearAnalyticsCache();

        if (request.server.broadcastToPOS) request.server.broadcastToPOS({ type: 'NEW_ORDER', orderId: newOrder._id, source: 'POS', storeId: storeId });

        const loyaltyMsg = pointsRedeemed > 0 ? ` Points Redeemed: ${pointsRedeemed}.` : '';
        const msg = `Thank you for shopping at DailyPick! 🛒\nOrder: ${newOrder.orderNumber}\nTotal: ₹${totalAmount}\n${loyaltyMsg}\nVisit again!`;
        sendWhatsAppMessage(customerPhone, msg);

        return { success: true, message: 'POS Transaction Complete', orderId: newOrder._id, orderData: newOrder };
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        request.server.log.error('POS Checkout Error:', error);
        reply.status(500).send({ success: false, message: 'Server Error processing POS transaction' });
    }
};

exports.assignDriver = async (request, reply) => {
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
        request.server.log.error('Driver Assignment Error:', error);
        reply.status(500).send({ success: false, message: 'Server Error assigning driver' });
    }
};

exports.updateStatus = async (request, reply) => {
    try {
        const { status } = request.body;
        const order = await Order.findByIdAndUpdate(
            request.params.id, 
            { status: status }, 
            { new: true }
        );
        
        if (!order) return reply.status(404).send({ success: false, message: 'Order not found' });

        const payload = JSON.stringify({ type: 'STATUS_UPDATE', status: status });
        sseService.publishEvent('customer', payload, { orderId: order._id });

        if (request.server.broadcastToPOS) request.server.broadcastToPOS({ type: 'ORDER_STATUS_UPDATED', orderId: order._id, status: status, storeId: order.storeId });

        return { success: true, data: order };
    } catch (error) {
        request.server.log.error('Status Update Error:', error);
        reply.status(500).send({ success: false, message: 'Server Error updating status' });
    }
};

exports.dispatchOrder = async (request, reply) => {
    try {
        const order = await Order.findByIdAndUpdate(
            request.params.id, 
            { status: 'Dispatched' }, 
            { new: true }
        );
        
        if (!order) return reply.status(404).send({ success: false, message: 'Order not found' });

        const payload = JSON.stringify({ type: 'STATUS_UPDATE', status: 'Dispatched' });
        sseService.publishEvent('customer', payload, { orderId: order._id });

        if (request.server.broadcastToPOS) request.server.broadcastToPOS({ type: 'ORDER_STATUS_UPDATED', orderId: order._id, status: 'Dispatched', storeId: order.storeId });

        return { success: true, data: order };
    } catch (error) {
        request.server.log.error('Dispatch Error:', error);
        reply.status(500).send({ success: false, message: 'Server Error dispatching order' });
    }
};

exports.partialRefund = async (request, reply) => {
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
        
        await clearAnalyticsCache();
        
        return { success: true, message: 'Item Partially Refunded', data: order };
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        request.server.log.error('Partial Refund Error:', error);
        reply.status(500).send({ success: false, message: 'Server Error processing refund' });
    }
};

exports.cancelOrder = async (request, reply) => {
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
        
        await clearAnalyticsCache();

        const payload = JSON.stringify({ type: 'STATUS_UPDATE', status: 'Cancelled' });
        sseService.publishEvent('customer', payload, { orderId: order._id });

        if (request.server.broadcastToPOS) request.server.broadcastToPOS({ type: 'ORDER_STATUS_UPDATED', orderId: order._id, status: 'Cancelled', storeId: order.storeId });

        return { success: true, message: 'Order Cancelled and Stock Refunded', data: order };
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        request.server.log.error('Cancel Error:', error);
        reply.status(500).send({ success: false, message: 'Server Error cancelling order' });
    }
};

exports.getAnalytics = async (request, reply) => {
    try {
        if (sseService.redisCache) {
            const cachedAnalytics = await sseService.redisCache.get('orders:analytics');
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
        
        if (sseService.redisCache) {
            await sseService.redisCache.set('orders:analytics', JSON.stringify(responsePayload), 'EX', 900);
        }

        return responsePayload;
    } catch (error) {
        request.server.log.error('Analytics Error:', error);
        reply.status(500).send({ success: false, message: 'Server Error fetching analytics' });
    }
};

exports.getOrders = async (request, reply) => {
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
        request.server.log.error('Fetch Error:', error);
        reply.status(500).send({ success: false, message: 'Server Error fetching orders' });
    }
};

exports.exportOrders = async (request, reply) => {
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
        request.server.log.error('Export Error:', error);
        reply.status(500).send({ success: false, message: 'Server Error exporting orders' });
    }
};

exports.getOrderById = async (request, reply) => {
    try {
        const order = await Order.findById(request.params.id).lean();
        if (!order) return reply.status(404).send({ success: false, message: 'Order not found' });
        return { success: true, data: order };
    } catch (error) {
        request.server.log.error('Tracking Error:', error);
        reply.status(500).send({ success: false, message: 'Server Error fetching order status' });
    }
};
