/* controllers/supportController.js */

const orderService = require('../services/orderService'); 
const { withTransaction } = require('../utils/dbUtils');
const AppError = require('../utils/AppError');

// ==========================================
// --- SUPPORT & REFUND CORE ---
// ==========================================

exports.partialRefund = async (request, reply) => {
    const order = await orderService.processPartialRefund(request.params.id, request.body, request.user);
    return { success: true, message: 'Item Partially Refunded', data: order };
};

exports.cancelOrder = async (request, reply) => {
    const order = await orderService.processCancelOrder(request.params.id, request.body.reason, request.user);
    return { success: true, message: 'Order Cancelled and Stock Refunded', data: order };
};

// ============================================================================
// --- PHASE 10 AUTOMATED GATEWAY REFUNDS ---
// ============================================================================
const originalCancelOrderPhase10 = exports.cancelOrder;

exports.cancelOrder = async (request, reply) => {
    const result = await originalCancelOrderPhase10(request, reply);
    
    if (result.success && result.data && result.data.paymentMethod === 'Online' && result.data.transactionId) {
        try {
            const Razorpay = require('razorpay');
            const razorpay = new Razorpay({
                key_id: process.env.RAZORPAY_KEY_ID || 'dummy_key',
                key_secret: process.env.RAZORPAY_KEY_SECRET || 'dummy_secret',
            });
            await razorpay.payments.refund(result.data.transactionId, { amount: Math.round(result.data.totalAmount * 100) });
            result.message += ' (Refund processed securely via Razorpay)';
        } catch (e) {
            request.server.log.error(`Razorpay Refund Error: ${e.message}`);
            result.message += ' (Manual Razorpay dashboard refund required)';
        }
    }
    return result;
};

const originalPartialRefundPhase10 = exports.partialRefund;

exports.partialRefund = async (request, reply) => {
    const Order = require('../models/Order');
    const preOrder = await Order.findById(request.params.id);
    const originalAmount = preOrder ? preOrder.totalAmount : 0;
    
    const result = await originalPartialRefundPhase10(request, reply);
    
    if (result.success && result.data && result.data.paymentMethod === 'Online' && result.data.transactionId && originalAmount > result.data.totalAmount) {
        const refundAmountRs = originalAmount - result.data.totalAmount;
        try {
            const Razorpay = require('razorpay');
            const razorpay = new Razorpay({
                key_id: process.env.RAZORPAY_KEY_ID || 'dummy_key',
                key_secret: process.env.RAZORPAY_KEY_SECRET || 'dummy_secret',
            });
            await razorpay.payments.refund(result.data.transactionId, { amount: Math.round(refundAmountRs * 100) });
            result.message += ` (Rs ${refundAmountRs} refunded via Razorpay)`;
        } catch (e) {
            request.server.log.error(`Razorpay Partial Refund Error: ${e.message}`);
        }
    }
    return result;
};

// ============================================================================
// --- PHASE 24 AUTOMATED MICRO-REFUNDS (OPS SAVER) ---
// ============================================================================
exports.reportIssue = async (request, reply) => {
    const Order = require('../models/Order');
    const Customer = require('../models/Customer');
    const { orderId, imageBase64, disputedAmountRs } = request.body; 
    const cloudinary = require('cloudinary').v2;

    const order = await Order.findById(orderId);
    if (!order) return reply.code(404).send({ success: false, message: 'Order not found' });

    let imageUrl = null;
    if (imageBase64) {
        try {
            const uploadRes = await cloudinary.uploader.upload(`data:image/jpeg;base64,${imageBase64}`, { folder: 'dailyPick_disputes' });
            imageUrl = uploadRes.secure_url;
        } catch (e) {
            request.server.log.error('Cloudinary Dispute Upload Error:', e);
        }
    }

    const customer = await Customer.findOne({ phone: order.customerPhone });
    
    if (customer && customer.trustScore > 90 && disputedAmountRs && disputedAmountRs <= 100) {
        customer.loyaltyPoints += disputedAmountRs; 
        await customer.save();

        order.status = 'Partially Refunded';
        order.notes = `${order.notes || ''} [AUTO-RESOLVED: Rs ${disputedAmountRs} credited to Loyalty Wallet for damaged item. Proof: ${imageUrl || 'No image'}]`.trim();
        await order.save();

        return { success: true, message: `Issue auto-resolved! Rs ${disputedAmountRs} has been instantly credited to your wallet.` };
    }

    order.status = 'Disputed';
    order.notes = `${order.notes || ''} [ISSUE REPORTED: Photo Proof attached]`.trim();
    if (imageUrl) order.notes += ` -> ${imageUrl}`;
    await order.save();

    return { success: true, message: 'Issue reported successfully. Our team will review the photo proof.' };
};

// ============================================================================
// --- PHASE 11 CUSTOMER RATING & FEEDBACK LOOP ---
// ============================================================================
exports.rateOrder = async (request, reply) => {
    const { rating } = request.body;
    const orderId = request.params.id;
    
    if (!rating || rating < 1 || rating > 5) return reply.code(400).send({ success: false, message: 'Valid rating 1-5 required.' });

    const Order = require('../models/Order');
    const Store = require('../models/Store');
    
    let orders = [];
    if (orderId.startsWith('OMNI-')) {
        orders = await Order.find({ splitShipmentGroupId: orderId });
    } else {
        const o = await Order.findById(orderId);
        if (o) orders.push(o);
    }
    
    if (orders.length === 0) return reply.code(404).send({ success: false, message: 'Order not found.' });

    for (const order of orders) {
        order.customerRating = rating;
        await order.save();
        if (order.storeId) {
            const scoreMod = rating >= 4 ? 1 : -1;
            await Store.findByIdAndUpdate(order.storeId, { $inc: { 'analytics.trustScore': scoreMod } }).catch(() => {});
        }
    }
    
    return { success: true, message: 'Thank you for your feedback!' };
};

// ============================================================================
// --- PHASE 25 GHOST ORDER FALLBACK (PAYMENT RESILIENCE) ---
// ============================================================================
exports.razorpayWebhook = async (request, reply) => {
    const crypto = require('crypto');
    const cacheUtils = require('../utils/cacheUtils');
    const checkoutService = require('../services/checkoutService');

    const secret = process.env.RAZORPAY_WEBHOOK_SECRET || 'dummy_webhook_secret';
    const signature = request.headers['x-razorpay-signature'];
    
    if (!signature) return reply.code(400).send({ success: false, message: 'Missing signature' });

    const expectedSignature = crypto.createHmac('sha256', secret).update(JSON.stringify(request.body)).digest('hex');
    if (expectedSignature !== signature) return reply.code(400).send({ success: false, message: 'Invalid signature' });

    const event = request.body.event;
    if (event === 'payment.captured') {
        const payment = request.body.payload.payment.entity;
        const idempotencyKey = payment.notes && payment.notes.idempotencyKey; 
        
        if (idempotencyKey) {
            const redisClient = cacheUtils.getClient();
            if (redisClient) {
                const isProcessed = await redisClient.get(`idem:checkout:${idempotencyKey}`);
                if (!isProcessed) {
                    request.server.log.warn(`[GHOST ORDER RECOVERY] Payment ${payment.id} captured, but order missing. Recovering from cart session...`);
                    const savedCart = await redisClient.get(`cart_session:${idempotencyKey}`);
                    if (savedCart) {
                        try {
                            const payload = JSON.parse(savedCart);
                            payload.transactionId = payment.id;
                            payload.paymentMethod = 'Online';
                            await checkoutService.processOnlineCheckout(payload, null);
                            request.server.log.info(`[GHOST ORDER RECOVERY] Successfully created order for Payment ${payment.id}`);
                        } catch (e) {
                            request.server.log.error(`[GHOST ORDER RECOVERY] Failed to recreate order: ${e.message}`);
                        }
                    }
                }
            }
        }
    }
    return reply.code(200).send({ status: 'ok' });
};

// ============================================================================
// --- PHASE 28 SECURE IN-APP CHAT (CUSTOMER <-> RIDER) ---
// ============================================================================
exports.sendChatMessage = async (request, reply) => {
    const Order = require('../models/Order');
    const { orderId } = request.params;
    const { message, sender } = request.body; 

    if (!message || !['Customer', 'Rider'].includes(sender)) throw new AppError('Invalid chat payload', 400);

    const order = await Order.findByIdAndUpdate(
        orderId, 
        { $push: { chatHistory: { sender, message, timestamp: Date.now() } } },
        { new: true }
    );

    if (!order) throw new AppError('Order not found', 404);

    const appEvents = require('../utils/eventEmitter');
    appEvents.emit('ORDER_CHAT_UPDATED', { orderId: order._id, chat: { sender, message, timestamp: Date.now() } });

    return { success: true, message: 'Chat sent' };
};

exports.getChatHistory = async (request, reply) => {
    const Order = require('../models/Order');
    const order = await Order.findById(request.params.id).select('chatHistory').lean();
    if (!order) throw new AppError('Order not found', 404);
    return { success: true, data: order.chatHistory || [] };
};

// ============================================================================
// --- PHASE 29 SMART SHORT-PICKS (PACKER'S LIFELINE) ---
// ============================================================================
exports.shortPickItem = async (request, reply) => {
    const Order = require('../models/Order');
    const notificationService = require('../services/notificationService');
    const { variantId } = request.body;

    return await withTransaction(async (session) => {
        const order = await Order.findById(request.params.id).session(session);
        if (!order) throw new AppError('Order not found', 404);
        if (order.status !== 'Packing') throw new AppError('Short-picks can only occur during the Packing stage', 400);

        let refundAmountRs = 0;
        let missingItemName = 'an item';

        order.items = order.items.filter(item => {
            if (item.variantId.toString() === variantId) {
                refundAmountRs = item.price * item.qty;
                missingItemName = item.name || 'product';
                return false; 
            }
            return true;
        });

        if (refundAmountRs === 0) throw new AppError('Item not found in this order', 404);

        order.totalAmount -= refundAmountRs;
        order.notes = `${order.notes || ''} [SHORT-PICK: Rs ${refundAmountRs} removed for missing ${missingItemName}]`.trim();
        await order.save({ session });

        if (order.paymentMethod === 'Online' && order.transactionId) {
            try {
                const Razorpay = require('razorpay');
                const razorpay = new Razorpay({
                    key_id: process.env.RAZORPAY_KEY_ID || 'dummy_key',
                    key_secret: process.env.RAZORPAY_KEY_SECRET || 'dummy_secret',
                });
                await razorpay.payments.refund(order.transactionId, { amount: Math.round(refundAmountRs * 100) });
            } catch (e) {
                request.server.log.error(`Razorpay Short-Pick Refund Error: ${e.message}`);
            }
        }

        const msg = `Order Update! We were out of ${missingItemName}, so we've removed it from your cart. Rs ${refundAmountRs} has been refunded. The rest of your order is packing now!`;
        notificationService.sendWhatsAppMessage(order.customerPhone, msg).catch(() => {});

        return { success: true, message: `Short-pick processed. Rs ${refundAmountRs} removed.`, orderId: order._id };
    });
};
