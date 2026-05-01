/* controllers/checkoutController.js */

const orderService = require('../services/orderService'); 
const checkoutService = require('../services/checkoutService'); 
const jobsService = require('../services/jobsService'); 
const { sendCsvResponse } = require('../utils/csvUtils'); 
const { handleOrderResponse } = require('../utils/responseUtils');
const { Transform } = require('stream');
const { withTransaction } = require('../utils/dbUtils');
const AppError = require('../utils/AppError'); // Fixed missing global import

// ==========================================
// --- CHECKOUT CORE ---
// ==========================================

exports.externalCheckout = async (request, reply) => {
    const payload = { ...request.body, idempotencyKey: request.headers['idempotency-key'] || request.body.idempotencyKey };
    const newOrder = await withTransaction(async (session) => {
        return await checkoutService.processExternalCheckout(payload, session);
    });
    reply.code(201);
    return { success: true, message: `External Order Accepted from ${request.body.source}`, orderId: newOrder._id, orderNumber: newOrder.orderNumber };
};

exports.onlineCheckout = async (request, reply) => {
    const payload = { ...request.body, idempotencyKey: request.headers['idempotency-key'] || request.body.idempotencyKey };
    const newOrder = await withTransaction(async (session) => {
        return await checkoutService.processOnlineCheckout(payload, session);
    });
    reply.code(201);
    return { success: true, message: 'Order Placed Successfully', orderId: newOrder._id };
};

exports.posCheckout = async (request, reply) => {
    const payload = { ...request.body, idempotencyKey: request.headers['idempotency-key'] || request.body.idempotencyKey };
    const newOrder = await withTransaction(async (session) => {
        return await checkoutService.processPosCheckout(payload, session);
    });
    reply.code(201);
    return { success: true, message: 'POS Transaction Complete', orderId: newOrder._id, orderData: newOrder };
};

// ==========================================
// --- PHASE 3 OMNI-CART CHECKOUT ---
// ==========================================

exports.omniCartCheckout = async (request, reply) => {
    const payload = { ...request.body, idempotencyKey: request.headers['idempotency-key'] || request.body.idempotencyKey };
    
    if (!payload.carts || !Array.isArray(payload.carts)) {
        throw new AppError('Omni-Cart requires an array of store-specific carts.', 400);
    }

    const splitShipmentGroupId = `OMNI-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    let masterCartTotalRs = 0;
    const generatedOrders = [];

    await withTransaction(async (session) => {
        for (const storeCart of payload.carts) {
            const subPayload = {
                ...payload,
                storeId: storeCart.storeId,
                items: storeCart.items,
                deliveryType: storeCart.deliveryType || payload.deliveryType, 
                idempotencyKey: `${payload.idempotencyKey}-${storeCart.storeId}`,
                splitShipmentGroupId: splitShipmentGroupId 
            };
            
            const newOrder = await checkoutService.processOnlineCheckout(subPayload, session);
            masterCartTotalRs += newOrder.totalAmount; 
            generatedOrders.push(newOrder);
        }
        
        if (generatedOrders.length > 0) {
            const Order = require('../models/Order');
            await Order.updateMany(
                { splitShipmentGroupId: splitShipmentGroupId },
                { $set: { masterCartTotalRs: masterCartTotalRs } },
                { session }
            );
        }
    });

    reply.code(201);
    return { 
        success: true, 
        message: 'Omni-Cart Checkout Complete', 
        splitShipmentGroupId: splitShipmentGroupId,
        masterCartTotalRs: masterCartTotalRs,
        totalShipments: generatedOrders.length
    };
};

// ============================================================================
// --- PHASE 6 OMNI-LOYALTY SUPER WALLET (INTERCEPTOR) ---
// ============================================================================
const originalOmniCartCheckoutPhase6 = exports.omniCartCheckout;

exports.omniCartCheckout = async (request, reply) => {
    const result = await originalOmniCartCheckoutPhase6(request, reply);
    
    if (result.success && request.body.customerPhone) {
        const phone = request.body.customerPhone;
        const useLoyalty = request.body.useLoyaltyPoints === true || request.body.useLoyaltyPoints === 'true';
        const { splitShipmentGroupId } = result;
        
        const Order = require('../models/Order');
        const Customer = require('../models/Customer');
        
        const cust = await Customer.findOne({ phone });
        const orders = await Order.find({ splitShipmentGroupId });
        
        if (useLoyalty && cust && cust.loyaltyPoints > 0 && orders.length > 0) {
            let pointsToUse = cust.loyaltyPoints;
            let totalDiscountApplied = 0;
            
            for (let order of orders) {
                if (pointsToUse <= 0) break;
                
                const maxDiscountForOrder = order.totalAmount; 
                const discountForThisOrder = Math.min(maxDiscountForOrder, pointsToUse);
                
                order.discountAmount = (order.discountAmount || 0) + discountForThisOrder;
                order.totalAmount = order.totalAmount - discountForThisOrder;
                order.notes = `${order.notes || ''} [Loyalty Applied: Rs ${discountForThisOrder}]`.trim();
                
                await order.save();
                
                pointsToUse -= discountForThisOrder;
                totalDiscountApplied += discountForThisOrder;
            }
            
            cust.loyaltyPoints -= totalDiscountApplied;
            await cust.save();
            
            const newMasterTotal = result.masterCartTotalRs - totalDiscountApplied;
            await Order.updateMany(
                { splitShipmentGroupId },
                { $set: { masterCartTotalRs: newMasterTotal } }
            );
            
            result.masterCartTotalRs = newMasterTotal;
            result.message += ` (Redeemed: ${totalDiscountApplied} Pts)`;
            
        } else if (!useLoyalty && cust && result.masterCartTotalRs > 0) {
            const earnedPoints = Math.floor(result.masterCartTotalRs / 100);
            if (earnedPoints > 0) {
                cust.loyaltyPoints = (cust.loyaltyPoints || 0) + earnedPoints;
                await cust.save();
            }
        }
    }
    
    // --- PHASE 7 GST & TAX RECONCILIATION ENGINE ---
    if (result.success && result.splitShipmentGroupId) {
        const Order = require('../models/Order');
        const orders = await Order.find({ splitShipmentGroupId: result.splitShipmentGroupId });
        
        for (let order of orders) {
            let totalCgst = 0;
            let totalSgst = 0;
            
            order.items.forEach(item => {
                const isEssential = item.categorySnapshot === 'Groceries' || item.categorySnapshot === 'Dairy & Breakfast';
                const taxRate = isEssential ? 0.05 : 0.18; 
                
                const itemTax = (item.price * item.qty) * taxRate;
                totalCgst += (itemTax / 2);
                totalSgst += (itemTax / 2);
            });
            
            order.taxBreakdown = {
                cgstRs: Number(totalCgst.toFixed(2)),
                sgstRs: Number(totalSgst.toFixed(2)),
                totalTaxRs: Number((totalCgst + totalSgst).toFixed(2))
            };
            
            if (order.fulfillmentType === 'STORE_DELIVERY') order.b2bTaxInvoice = true;
            
            await order.save();
        }
    }

    return result;
};

// ============================================================================
// --- PHASE 16 HYBRID DELIVERY ROUTING (B2B ENTERPRISE FLEET DISPATCH) ---
// ============================================================================
const originalOnlineCheckoutPhase16 = exports.onlineCheckout;

exports.onlineCheckout = async (request, reply) => {
    const result = await originalOnlineCheckoutPhase16(request, reply);
    if (result.success && result.orderId) {
        await executeHybridDeliveryRouting(result.orderId, request.server);
    }
    return result;
};

const originalOmniCartCheckoutPhase16 = exports.omniCartCheckout;

exports.omniCartCheckout = async (request, reply) => {
    const result = await originalOmniCartCheckoutPhase16(request, reply);
    if (result.success && result.splitShipmentGroupId) {
        const Order = require('../models/Order');
        const subOrders = await Order.find({ splitShipmentGroupId: result.splitShipmentGroupId }).select('_id');
        for (const subOrder of subOrders) {
            await executeHybridDeliveryRouting(subOrder._id, request.server);
        }
    }
    return result;
};

// Core Dispatch Logic (Moved securely to Checkout domain)
async function executeHybridDeliveryRouting(orderId, server) {
    try {
        const Order = require('../models/Order');
        const Store = require('../models/Store');
        const axios = require('axios');

        const order = await Order.findById(orderId);
        if (!order || !order.storeId) return;

        const store = await Store.findById(order.storeId);
        
        if (store && store.storeType === 'ENTERPRISE' && store.apiIntegration && store.apiIntegration.webhookUrl) {
            order.fulfillmentType = 'STORE_DELIVERY';
            order.partnerTrackingId = `ENT-${order.orderNumber || orderId.toString().slice(-6)}`;
            await order.save();

            axios.post(store.apiIntegration.webhookUrl, {
                event: 'NEW_ORDER_DISPATCH',
                dailyPickOrderId: order._id,
                partnerTrackingId: order.partnerTrackingId,
                customer: { name: order.customerName, phone: order.customerPhone, address: order.deliveryAddress },
                items: order.items,
                totalAmountRs: order.totalAmount
            }, {
                headers: { 'x-api-key': store.apiIntegration.apiSecretKey },
                timeout: 10000 
            }).catch(e => {
                if (server && server.log) server.log.error(`Hybrid Routing Webhook Failed for Store ${store.name}: ${e.message}`);
                const { logFailedWebhook } = require('./enterpriseController');
                logFailedWebhook(store._id, store.apiIntegration.webhookUrl, order, e.message);
            });
        } else {
            const appEvents = require('../utils/eventEmitter');
            appEvents.emit('RIDER_DISPATCH_REQUIRED', { orderId: order._id, storeId: store._id });
        }
    } catch (error) {
        if (server && server.log) server.log.error(`Hybrid Delivery Routing execution failed: ${error.message}`);
    }
}
