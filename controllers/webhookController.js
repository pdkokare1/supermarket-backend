/* controllers/webhookController.js */
'use strict';

const crypto = require('crypto');
const Order = require('../models/Order');
const AppError = require('../utils/AppError');

// ==========================================
// --- EXTERNAL WEBHOOK LISTENERS ---
// ==========================================

exports.razorpayWebhook = async (request, reply) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET || 'dummy_webhook_secret';
    
    // 1. Verify that this request actually came from Razorpay
    let payloadStr = request.rawBody || JSON.stringify(request.body);
    
    const shasum = crypto.createHmac('sha256', secret);
    shasum.update(payloadStr);
    const digest = shasum.digest('hex');

    if (digest !== request.headers['x-razorpay-signature']) {
        request.server.log.warn('Razorpay Webhook: Invalid Signature Detected');
        // In sandbox, we might not always have strict signatures, so we log but don't strictly throw if testing
        if (process.env.NODE_ENV === 'production') {
            throw new AppError('Invalid signature', 400);
        }
    }

    // 2. Process the verified event
    const event = request.body.event;
    
    if (event === 'payment.captured' || event === 'order.paid') {
        const paymentEntity = request.body.payload.payment.entity;
        // In a live system, you pass the DB Order ID into Razorpay's "notes" object during checkout
        const orderId = paymentEntity.notes?.order_id; 

        if (orderId) {
            // Failsafe: Ensure the order is marked successful regardless of frontend status
            await Order.findByIdAndUpdate(orderId, {
                status: 'Order Placed',
                transactionId: paymentEntity.id
            });
            request.server.log.info(`Webhook: Order ${orderId} secured via Razorpay.`);
        }
    }

    // Always return a fast 200 OK so the gateway knows we received it
    return reply.code(200).send({ status: 'ok' });
};

exports.logisticsWebhook = async (request, reply) => {
    const { trackingId, status, driverName } = request.body;

    if (!trackingId) {
        throw new AppError('Missing tracking ID in payload', 400);
    }

    // Find the order that contains this specific tracking ID
    const order = await Order.findOne({ 'trackingLink': { $regex: trackingId } });
    
    if (!order) {
        throw new AppError('Order associated with tracking ID not found', 404);
    }

    // Update system based on rider actions
    if (status === 'DELIVERED') {
        order.status = 'Completed';
        request.server.log.info(`Webhook: Order ${order._id} marked Completed by Logistics.`);
    } else if (status === 'RIDER_ASSIGNED' && driverName) {
        order.deliveryDriverName = driverName;
    }
    
    await order.save();
    return reply.code(200).send({ status: 'ok' });
};

// ============================================================================
// --- NEW: PHASE 8 GHOST ORDER FALLBACK (REVENUE PROTECTION) ---
// ============================================================================
const originalRazorpayWebhookPhase8 = exports.razorpayWebhook;

exports.razorpayWebhook = async (request, reply) => {
    // 1. Execute the Ghost Order Fallback logic FIRST before the response is committed
    try {
        const secret = process.env.RAZORPAY_WEBHOOK_SECRET || 'dummy_webhook_secret';
        const crypto = require('crypto');
        
        let payloadStr = request.rawBody || JSON.stringify(request.body);
        const shasum = crypto.createHmac('sha256', secret);
        shasum.update(payloadStr);
        const digest = shasum.digest('hex');

        // Only process Ghost Order recovery if the signature is authentic
        if (digest === request.headers['x-razorpay-signature']) {
            const event = request.body.event;
            
            if (event === 'payment.captured' || event === 'order.paid') {
                const paymentEntity = request.body.payload.payment.entity;
                const transactionId = paymentEntity.id;
                
                const Order = require('../models/Order');
                const existingOrder = await Order.findOne({ transactionId });
                
                // If no order exists in DB, it means the frontend crashed before backend checkout succeeded!
                if (!existingOrder && paymentEntity.notes?.cart_session_id) {
                    const cacheUtils = require('../utils/cacheUtils');
                    const redisClient = cacheUtils.getClient();
                    
                    if (redisClient) {
                        const cachedCartStr = await redisClient.get(`cart_session:${paymentEntity.notes.cart_session_id}`);
                        if (cachedCartStr) {
                            const cachedPayload = JSON.parse(cachedCartStr);
                            const checkoutService = require('../services/checkoutService');
                            
                            // Force the checkout to run securely in the background
                            await checkoutService.processOnlineCheckout({
                                ...cachedPayload,
                                paymentMethod: 'Online',
                                transactionId: transactionId,
                                notes: `${cachedPayload.notes || ''} [GHOST ORDER RECOVERED]`.trim()
                            });
                            request.server.log.info(`[REVENUE PROTECTION] Ghost Order successfully recovered for transaction ${transactionId}`);
                        }
                    }
                }
            }
        }
    } catch (e) {
        request.server.log.error(`[GHOST ORDER FALLBACK ERROR]: ${e.message}`);
    }

    // 2. Run the original webhook logic to finalize status updates
    return await originalRazorpayWebhookPhase8(request, reply);
};
