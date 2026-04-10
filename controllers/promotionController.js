/* controllers/promotionController.js */

const promotionService = require('../services/promotionService');
const catchAsync = require('../utils/catchAsync');

exports.getPromotions = catchAsync(async (request, reply) => {
    const promos = await promotionService.getPromotions(request.query.all);
    return { success: true, count: promos.length, data: promos };
}, 'fetching promotions');

exports.createPromotion = catchAsync(async (request, reply) => {
    const newPromo = await promotionService.createPromotion(request.body);
    // REMOVED: request.server.broadcastToPOS (Now handled by Service events)
    return { success: true, message: 'Promotion created', data: newPromo };
}, 'creating promotion');

exports.togglePromotion = catchAsync(async (request, reply) => {
    const promo = await promotionService.togglePromotion(request.params.id);
    // REMOVED: request.server.broadcastToPOS (Now handled by Service events)
    return { success: true, message: 'Promotion toggled', data: promo };
}, 'toggling promotion');
