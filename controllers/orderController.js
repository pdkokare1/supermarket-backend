/* controllers/orderController.js */

const orderService = require('../services/orderService'); 
const checkoutService = require('../services/checkoutService'); 
const jobsService = require('../services/jobsService'); 
const { sendCsvResponse } = require('../utils/csvUtils'); 
const { handleOrderResponse } = require('../utils/responseUtils');
const { Transform } = require('stream');
const { withTransaction } = require('../utils/dbUtils'); // OPTIMIZATION: Imported for Controller-level transaction boundaries

// ==========================================
// --- CONTROLLER EXPORTS ---
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

exports.assignDriver = async (request, reply) => {
    const { driverName, driverPhone } = request.body;
    const order = await orderService.assignDriverToOrder(request.params.id, driverName, driverPhone);
    return handleOrderResponse(reply, order, 'Driver assigned successfully');
};

exports.updateStatus = async (request, reply) => {
    const { status } = request.body;
    let order = await orderService.updateOrderStatus(request.params.id, status);

    // AUTOMATED LAST-MILE LOGISTICS TRIGGER
    if (status === 'Packed' && process.env.ENABLE_LOGISTICS_AUTOMATION === 'true') {
        try {
            const mockDriver = {
                name: "Auto Rider (Shadowfax Sandbox)",
                phone: "+91 99999 00000",
                trackingId: `SFX-${Math.floor(Math.random() * 1000000)}`
            };
            order = await orderService.assignDriverToOrder(request.params.id, mockDriver.name, mockDriver.phone);
            order.trackingLink = `https://track.shadowfax.in/${mockDriver.trackingId}`;
        } catch (error) {
            request.server.log.error(`Logistics Sandbox Error: ${error.message}`);
        }
    }
    return handleOrderResponse(reply, order);
};

exports.dispatchOrder = async (request, reply) => {
    const order = await orderService.dispatchOrder(request.params.id);
    return handleOrderResponse(reply, order);
};

exports.partialRefund = async (request, reply) => {
    const order = await orderService.processPartialRefund(request.params.id, request.body, request.user);
    return { success: true, message: 'Item Partially Refunded', data: order };
};

exports.cancelOrder = async (request, reply) => {
    const order = await orderService.processCancelOrder(request.params.id, request.body.reason, request.user);
    return { success: true, message: 'Order Cancelled and Stock Refunded', data: order };
};

exports.getOrders = async (request, reply) => {
    return await orderService.getOrdersList(request.query);
};

exports.exportOrders = async (request, reply) => {
    await jobsService.enqueueTask('EXPORT_ORDERS', { 
        email: request.user?.email || process.env.TARGET_EMAIL,
        query: request.query 
    });
    reply.code(202);
    return { success: true, message: 'Export job queued securely. You will receive the CSV via email shortly.' };
};

exports.getOrderById = async (request, reply) => {
    const order = await orderService.getOrderById(request.params.id);
    return handleOrderResponse(reply, order);
};

// ==========================================
// --- NEW: PHASE 3 OMNI-CART CHECKOUT ---
// ==========================================

exports.omniCartCheckout = async (request, reply) => {
    // Handles a single transaction containing items from multiple independent stores
    const payload = { ...request.body, idempotencyKey: request.headers['idempotency-key'] || request.body.idempotencyKey };
    
    // Payload expectation: payload.carts = [{ storeId: "DMART", items: [...] }, { storeId: "KIRANA", items: [...] }]
    if (!payload.carts || !Array.isArray(payload.carts)) {
        throw new AppError('Omni-Cart requires an array of store-specific carts.', 400);
    }

    const splitShipmentGroupId = `OMNI-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    let masterCartTotalRs = 0;
    const generatedOrders = [];

    await withTransaction(async (session) => {
        for (const storeCart of payload.carts) {
            // Re-map the payload to utilize existing checkout architecture silently
            const subPayload = {
                ...payload,
                storeId: storeCart.storeId,
                items: storeCart.items,
                deliveryType: storeCart.deliveryType || payload.deliveryType, // Added: Granular routing per cart for Store-in-Store vs Local
                idempotencyKey: `${payload.idempotencyKey}-${storeCart.storeId}`,
                splitShipmentGroupId: splitShipmentGroupId // Groups them together
            };
            
            // Send sub-order to existing trusted checkout service
            const newOrder = await checkoutService.processOnlineCheckout(subPayload, session);
            masterCartTotalRs += newOrder.totalAmount; // Accumulate Rs total
            generatedOrders.push(newOrder);
        }
        
        // Once all individual store sub-orders are secure, stamp them with the Unified Total
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
// --- NEW: PHASE 6 OMNI-LOYALTY SUPER WALLET (INTERCEPTOR) ---
// ============================================================================
const originalOmniCartCheckoutPhase6 = exports.omniCartCheckout;

exports.omniCartCheckout = async (request, reply) => {
    // 1. Execute the core omni-cart logic unmodified to respect transaction boundaries
    const result = await originalOmniCartCheckoutPhase6(request, reply);
    
    // 2. Post-Process Loyalty Points if the transaction was successful
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
                
                // We apply discount to the subtotal, ensuring we don't drop below 0
                const maxDiscountForOrder = order.totalAmount; 
                const discountForThisOrder = Math.min(maxDiscountForOrder, pointsToUse);
                
                order.discountAmount = (order.discountAmount || 0) + discountForThisOrder;
                order.totalAmount = order.totalAmount - discountForThisOrder;
                order.notes = `${order.notes || ''} [Loyalty Applied: Rs ${discountForThisOrder}]`.trim();
                
                await order.save();
                
                pointsToUse -= discountForThisOrder;
                totalDiscountApplied += discountForThisOrder;
            }
            
            // Deduct the used points from the customer's Super Wallet
            cust.loyaltyPoints -= totalDiscountApplied;
            await cust.save();
            
            // Update the unified Master Cart Total across all sub-orders
            const newMasterTotal = result.masterCartTotalRs - totalDiscountApplied;
            await Order.updateMany(
                { splitShipmentGroupId },
                { $set: { masterCartTotalRs: newMasterTotal } }
            );
            
            result.masterCartTotalRs = newMasterTotal;
            result.message += ` (Redeemed: ${totalDiscountApplied} Pts)`;
            
        } else if (!useLoyalty && cust && result.masterCartTotalRs > 0) {
            // 3. Reward new loyalty points for this purchase (1 point per 100 Rs)
            const earnedPoints = Math.floor(result.masterCartTotalRs / 100);
            if (earnedPoints > 0) {
                cust.loyaltyPoints = (cust.loyaltyPoints || 0) + earnedPoints;
                await cust.save();
            }
        }
    }
    
    // ============================================================================
    // --- NEW: PHASE 7 GST & TAX RECONCILIATION ENGINE ---
    // ============================================================================
    if (result.success && result.splitShipmentGroupId) {
        const Order = require('../models/Order');
        const orders = await Order.find({ splitShipmentGroupId: result.splitShipmentGroupId });
        
        for (let order of orders) {
            let totalCgst = 0;
            let totalSgst = 0;
            
            order.items.forEach(item => {
                // Determine tax slab (5% for Groceries, 18% standard for Electronics/Others)
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
            
            // B2B Flagging for Enterprise ITCs
            if (order.fulfillmentType === 'STORE_DELIVERY') {
                order.b2bTaxInvoice = true;
            }
            
            await order.save();
        }
    }

    return result;
};

// ============================================================================
// --- NEW: PHASE 9 PROOF OF DELIVERY & FRAUD SHIELD HOOKS ---
// ============================================================================
const originalDispatchOrderPhase9 = exports.dispatchOrder;

exports.dispatchOrder = async (request, reply) => {
    // Generate a secure 4-digit OTP before dispatching to combat shrinkage
    const Order = require('../models/Order');
    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    
    await Order.findByIdAndUpdate(request.params.id, { deliveryOtp: otp });
    
    return await originalDispatchOrderPhase9(request, reply);
};

const originalUpdateStatusPhase9 = exports.updateStatus;

exports.updateStatus = async (request, reply) => {
    const { status, otp } = request.body;
    const Order = require('../models/Order');
    const Customer = require('../models/Customer');
    const AppError = require('../utils/AppError');
    
    const order = await Order.findById(request.params.id);
    if (!order) throw new AppError('Order not found', 404);

    // 1. Proof of Delivery (OTP Check)
    if (status === 'Delivered' && order.deliveryOtp) {
        if (request.user && request.user.role === 'Delivery_Agent') {
            if (!otp || order.deliveryOtp !== otp.toString()) {
                throw new AppError('Invalid Delivery OTP. Please ask the customer for their 4-digit PIN.', 400);
            }
        }
    }

    // 2. Fraud Shield (COD Rejection Tracking)
    if ((status === 'Returned' || status === 'Failed') && order.paymentMethod === 'Cash on Delivery') {
        await Customer.findOneAndUpdate(
            { phone: order.customerPhone },
            { $inc: { codRejections: 1, trustScore: -10 } }
        );
    }

    return await originalUpdateStatusPhase9(request, reply);
};

// ============================================================================
// --- NEW: PHASE 10 AUTOMATED GATEWAY REFUNDS ---
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
            // Automate the refund API call instantly
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
// --- NEW: PHASE 11 CUSTOMER RATING & FEEDBACK LOOP ---
// ============================================================================
exports.rateOrder = async (request, reply) => {
    const { rating } = request.body;
    const orderId = request.params.id;
    
    if (!rating || rating < 1 || rating > 5) {
        return reply.code(400).send({ success: false, message: 'Valid rating 1-5 required.' });
    }

    const Order = require('../models/Order');
    const Store = require('../models/Store');
    
    // Support Omni-Cart groups or individual order IDs
    let orders = [];
    if (orderId.startsWith('OMNI-')) {
        orders = await Order.find({ splitShipmentGroupId: orderId });
    } else {
        const o = await Order.findById(orderId);
        if (o) orders.push(o);
    }
    
    if (orders.length === 0) {
        return reply.code(404).send({ success: false, message: 'Order not found.' });
    }

    for (const order of orders) {
        order.customerRating = rating;
        await order.save();
        
        // Dynamically update the fulfilling Store's trust score
        if (order.storeId) {
            const scoreMod = rating >= 4 ? 1 : -1;
            await Store.findByIdAndUpdate(order.storeId, {
                $inc: { 'analytics.trustScore': scoreMod }
            }).catch(() => {});
        }
    }
    
    return { success: true, message: 'Thank you for your feedback!' };
};

// ============================================================================
// --- NEW: PHASE 10 SPATIAL RIDER LOCATION PING (Mapbox Bridge) ---
// ============================================================================
exports.updateRiderLocation = async (request, reply) => {
    const { riderId, lat, lng } = request.body;
    
    // Update Shift's spatial location for the $geoNear routing queries
    const Shift = require('../models/Shift');
    await Shift.findByIdAndUpdate(riderId, {
        spatialLocation: {
            type: 'Point',
            coordinates: [lng, lat]
        }
    });
    
    // Fire event so Firebase Realtime DB / SSE can pick it up to animate the Mapbox UI
    const appEvents = require('../utils/eventEmitter');
    appEvents.emit('RIDER_LOCATION_UPDATED', { riderId, coordinates: [lng, lat] });
    
    return reply.code(200).send({ success: true, message: 'Location synced' });
};
