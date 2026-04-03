const promotionService = require('../services/promotionService');
const catchAsync = require('../utils/catchAsync');

exports.getPromotions = catchAsync(async (request, reply) => {
    const promos = await promotionService.getPromotions(request.query.all);
    return { success: true, count: promos.length, data: promos };
}, 'fetching promotions');

exports.createPromotion = catchAsync(async (request, reply) => {
    const newPromo = await promotionService.createPromotion(request.body);
    if (request.server.broadcastToPOS) request.server.broadcastToPOS({ type: 'PROMOTION_ADDED', promotionId: newPromo._id });
    return { success: true, message: 'Promotion created', data: newPromo };
}, 'creating promotion');

exports.togglePromotion = catchAsync(async (request, reply) => {
    const promo = await promotionService.togglePromotion(request.params.id);
    if (request.server.broadcastToPOS) request.server.broadcastToPOS({ type: 'PROMOTION_TOGGLED', promotionId: promo._id, isActive: promo.isActive });
    return { success: true, message: 'Promotion toggled', data: promo };
}, 'toggling promotion');
