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
    
    // 1. Cryptographically verify that this request actually came from Razorpay
    const shasum = crypto.createHmac('sha256', secret);
    shasum.update(JSON.stringify(request.body));
    const digest = shasum.digest('hex');

    if (digest !== request.headers['x-razorpay-signature']) {
        request.server.log.warn('Razorpay Webhook: Invalid Signature Detected');
        throw new AppError('Invalid signature', 400);
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
