/* controllers/collectiveController.js */
'use strict';

const Collective = require('../models/Collective');
const checkoutService = require('../services/checkoutService');
const AppError = require('../utils/AppError');
const { withTransaction } = require('../utils/dbUtils');

exports.createCollective = async (request, reply) => {
    const { masterProductId, variantId, productName, originalPriceRs, dropoffAddress, storeId } = request.body;

    // Apply a flat 15% discount for anyone willing to wait for a 5-person group buy
    const collectiveDiscountRs = Math.floor(originalPriceRs * 0.85);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 Hour Countdown

    const newCollective = new Collective({
        masterProductId,
        variantId,
        productName,
        originalPriceRs,
        collectiveDiscountRs,
        targetParticipants: 5,
        dropoffAddress,
        storeId,
        expiresAt
    });

    await newCollective.save();

    return { 
        success: true, 
        message: 'Group Buy Collective Initiated! Share the link with your neighbors.', 
        collectiveId: newCollective._id 
    };
};

exports.joinCollective = async (request, reply) => {
    const { customerPhone, razorpayAuthId } = request.body;
    const collectiveId = request.params.id;

    const result = await withTransaction(async (session) => {
        const collective = await Collective.findById(collectiveId).session(session);

        if (!collective) throw new AppError('Collective not found.', 404);
        if (collective.status !== 'GATHERING') throw new AppError('This Group Buy has already closed.', 400);
        if (new Date() > collective.expiresAt) {
            collective.status = 'FAILED';
            await collective.save({ session });
            throw new AppError('This Group Buy has expired.', 400);
        }

        // Add the user's pre-authorized payment lock to the pool
        collective.participants.push({ customerPhone, razorpayAuthId });

        // If the threshold is hit, execute the Pinduoduo Protocol
        if (collective.participants.length >= collective.targetParticipants) {
            collective.status = 'SUCCESSFUL';
            
            // Synthesize a massive Omni-Cart order with 0 delivery fee, 
            // grouping all 5 items to a single GPS drop-off
            const bulkItems = [{
                productId: collective.masterProductId,
                variantId: collective.variantId,
                name: collective.productName,
                price: collective.collectiveDiscountRs,
                qty: collective.targetParticipants, // Bulk Quantity
                storeId: collective.storeId
            }];

            const synthesizedPayload = {
                idempotencyKey: `COLLECTIVE-${collective._id}`,
                customerName: `Collective Drop: ${collective.participants.length} Neighbors`,
                customerPhone: collective.participants[0].customerPhone, // Primary Contact
                deliveryAddress: collective.dropoffAddress,
                items: bulkItems,
                deliveryType: 'Instant',
                scheduleTime: 'ASAP',
                paymentMethod: 'Online',
                notes: '[PINDUODUO PROTOCOL] Bulk Group Buy Drop-Off. Items are pre-paid.',
                storeId: collective.storeId,
                deliveryFeeAmount: 0 // Waived for bulk logistics efficiency
            };

            // Inject the order straight into your existing checkout engine
            await checkoutService.processOnlineCheckout(synthesizedPayload, session);
        }

        await collective.save({ session });
        return collective;
    });

    return { 
        success: true, 
        message: result.status === 'SUCCESSFUL' ? 'Threshold Reached! Bulk Order Dispatched.' : 'Successfully joined the Collective. Waiting for neighbors...',
        status: result.status 
    };
};
