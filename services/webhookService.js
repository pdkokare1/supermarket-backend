/* services/webhookService.js */
'use strict';

const mongoose = require('mongoose');
const crypto = require('crypto'); // ENTERPRISE OPTIMIZATION: Imported for cryptographic signatures

// Define the DLQ Model directly in the service for portability without mutating models/
const WebhookLogSchema = new mongoose.Schema({
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store' },
    webhookUrl: { type: String, required: true },
    payload: { type: Object, required: true },
    status: { type: String, enum: ['PENDING', 'SUCCESS', 'FAILED'], default: 'PENDING' },
    error: { type: String },
    retryCount: { type: Number, default: 0 },
    nextRetryAt: { type: Date }
}, { timestamps: true });

const WebhookLog = mongoose.models.WebhookLog || mongoose.model('WebhookLog', WebhookLogSchema);

exports.WebhookLog = WebhookLog;

exports.dispatchFulfillmentWebhook = async (order, store) => {
    if (!store.apiIntegration || !store.apiIntegration.webhookUrl) {
        return; // Not an enterprise store configured with a webhook
    }

    const payload = {
        event: 'order.created',
        orderNumber: order.orderNumber || order._id,
        items: order.items.filter(i => i.storeId && i.storeId.toString() === store._id.toString()),
        customerInfo: {
            name: order.customerName,
            phone: order.customerPhone,
            address: order.deliveryAddress
        },
        timestamp: new Date().toISOString()
    };

    const log = await WebhookLog.create({
        orderId: order._id,
        storeId: store._id,
        webhookUrl: store.apiIntegration.webhookUrl,
        payload: payload
    });

    try {
        const fetchMethod = typeof fetch !== 'undefined' ? fetch : require('node-fetch');
        
        // ENTERPRISE OPTIMIZATION: Generate an HMAC SHA-256 signature of the payload
        // This prevents man-in-the-middle tampering and hides your raw secret key
        const payloadString = JSON.stringify(payload);
        const secretKey = store.apiIntegration.apiSecretKey || 'secure-key';
        const signature = crypto.createHmac('sha256', secretKey).update(payloadString).digest('hex');

        const response = await fetchMethod(store.apiIntegration.webhookUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-dailypick-signature': signature 
            },
            body: payloadString
        });

        if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);

        log.status = 'SUCCESS';
        await log.save();
        console.log(`✅ Webhook dispatched successfully to ${store.name}`);
    } catch (error) {
        log.status = 'FAILED';
        log.error = error.message;
        log.nextRetryAt = new Date(Date.now() + 15 * 60000); // Queue for retry in 15 mins
        await log.save();
        console.error(`❌ Webhook failed for ${store.name}. Added to Dead Letter Queue (DLQ).`);
    }
};

exports.retryFailedWebhook = async (logId) => {
    const log = await WebhookLog.findById(logId);
    if (!log || log.status === 'SUCCESS') return { success: false, message: 'Invalid or completed log' };

    try {
        const fetchMethod = typeof fetch !== 'undefined' ? fetch : require('node-fetch');
        
        // Ensure signatures are regenerated properly during retry
        const payloadString = JSON.stringify(log.payload);
        const Store = require('../models/Store');
        const store = await Store.findById(log.storeId).select('apiIntegration.apiSecretKey');
        const secretKey = (store && store.apiIntegration && store.apiIntegration.apiSecretKey) ? store.apiIntegration.apiSecretKey : 'secure-key';
        const signature = crypto.createHmac('sha256', secretKey).update(payloadString).digest('hex');

        const response = await fetchMethod(log.webhookUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-dailypick-signature': signature
            },
            body: payloadString
        });

        if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);

        log.status = 'SUCCESS';
        log.error = null;
        await log.save();
        return { success: true, message: 'Retry successful' };
    } catch (error) {
        log.retryCount += 1;
        log.error = error.message;
        // Exponential backoff logic
        log.nextRetryAt = new Date(Date.now() + (Math.pow(2, log.retryCount) * 15 * 60000)); 
        await log.save();
        return { success: false, message: error.message };
    }
};

exports.getFailedWebhooks = async () => {
    return await WebhookLog.find({ status: 'FAILED' }).sort({ createdAt: -1 }).lean();
};
