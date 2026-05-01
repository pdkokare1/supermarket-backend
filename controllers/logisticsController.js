/* controllers/logisticsController.js */

const orderService = require('../services/orderService'); 
const jobsService = require('../services/jobsService'); 
const { handleOrderResponse } = require('../utils/responseUtils');
const AppError = require('../utils/AppError');

// ==========================================
// --- LOGISTICS & DISPATCH CORE ---
// ==========================================

exports.assignDriver = async (request, reply) => {
    const { driverName, driverPhone } = request.body;
    const order = await orderService.assignDriverToOrder(request.params.id, driverName, driverPhone);
    return handleOrderResponse(reply, order, 'Driver assigned successfully');
};

exports.updateStatus = async (request, reply) => {
    const { status } = request.body;
    let order = await orderService.updateOrderStatus(request.params.id, status);

    // --- PHASE 32 PROJECT FIREFLY (IoT PICK-TO-LIGHT SYSTEM) ---
    if (status === 'Packing') {
        try {
            const Order = require('../models/Order');
            const orderData = await Order.findById(request.params.id).lean();
            
            if (orderData && orderData.items && orderData.items.length > 0) {
                const shelfIds = orderData.items.map(item => item.variantId.toString());
                
                request.server.log.info(`[FIREFLY IoT] Transmitting 2.4GHz Zigbee activation payload to ESL nodes: ${shelfIds.join(', ')}`);
                
                const appEvents = require('../utils/eventEmitter');
                appEvents.emit('IOT_SHELF_ACTIVATE', { 
                    storeId: orderData.storeId, 
                    orderId: orderData._id,
                    shelfIds: shelfIds,
                    color: '#00FF00', 
                    flashPattern: 'STROBE'
                });
            }
        } catch (e) {
            request.server.log.error(`[FIREFLY IoT] Hardware transmission failed: ${e.message}`);
        }
    }

    if (status === 'Packed' && process.env.ENABLE_LOGISTICS_AUTOMATION === 'true') {
        try {
            const mockDriver = { name: "Auto Rider (Shadowfax Sandbox)", phone: "+91 99999 00000", trackingId: `SFX-${Math.floor(Math.random() * 1000000)}` };
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

// ============================================================================
// --- PHASE 9 PROOF OF DELIVERY & FRAUD SHIELD HOOKS ---
// ============================================================================
const originalDispatchOrderPhase9 = exports.dispatchOrder;

exports.dispatchOrder = async (request, reply) => {
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
    
    const order = await Order.findById(request.params.id);
    if (!order) throw new AppError('Order not found', 404);

    if (status === 'Delivered' && order.deliveryOtp) {
        if (request.user && request.user.role === 'Delivery_Agent') {
            if (!otp || order.deliveryOtp !== otp.toString()) {
                throw new AppError('Invalid Delivery OTP. Please ask the customer for their 4-digit PIN.', 400);
            }
        }
    }

    if ((status === 'Returned' || status === 'Failed') && order.paymentMethod === 'Cash on Delivery') {
        await Customer.findOneAndUpdate(
            { phone: order.customerPhone },
            { $inc: { codRejections: 1, trustScore: -10 } }
        );
    }

    return await originalUpdateStatusPhase9(request, reply);
};

// ============================================================================
// --- RIDER GPS PING & SURGE ENGINE ---
// ============================================================================

exports.updateRiderLocation = async (request, reply) => {
    const { riderId, lat, lng } = request.body;
    
    const Shift = require('../models/Shift');
    await Shift.findByIdAndUpdate(riderId, {
        spatialLocation: { type: 'Point', coordinates: [lng, lat] },
        lastPingTime: Date.now()
    });
    
    const appEvents = require('../utils/eventEmitter');
    appEvents.emit('RIDER_LOCATION_UPDATED', { riderId, coordinates: [lng, lat] });
    
    return reply.code(200).send({ success: true, message: 'Location synced' });
};

exports.getSurgePricing = async (request, reply) => {
    const Order = require('../models/Order');
    const Shift = require('../models/Shift'); 

    const pendingOrders = await Order.countDocuments({ 
        fulfillmentType: 'PLATFORM_DELIVERY', 
        status: { $in: ['Order Placed', 'Packing', 'Dispatched'] } 
    });
    const activeRiders = await Shift.countDocuments({ status: 'ACTIVE', role: 'Delivery_Agent' }) || 1;

    const loadRatio = pendingOrders / activeRiders;
    let deliveryFee = 20; 
    let surgeActive = false;
    let surgeMessage = null;

    if (loadRatio > 5) {
        deliveryFee = 40;
        surgeActive = true;
        surgeMessage = "High demand in your area. Delivery fee increased to ensure fast assignment.";
    } else if (loadRatio > 8) {
        deliveryFee = 60;
        surgeActive = true;
        surgeMessage = "Extreme demand! Delivery fee surged. Riders are operating at max capacity.";
    }

    return { success: true, surgeActive, deliveryFee, message: surgeMessage };
};
