/* controllers/promotionController.js */

const promotionService = require('../services/promotionService');

exports.getPromotions = async (request, reply) => {
    const promos = await promotionService.getPromotions(request.query.all);
    return { success: true, count: promos.length, data: promos };
};

exports.createPromotion = async (request, reply) => {
    const newPromo = await promotionService.createPromotion(request.body);
    // REMOVED: request.server.broadcastToPOS (Now handled by Service events)
    return { success: true, message: 'Promotion created', data: newPromo };
};

exports.togglePromotion = async (request, reply) => {
    const promo = await promotionService.togglePromotion(request.params.id);
    // REMOVED: request.server.broadcastToPOS (Now handled by Service events)
    return { success: true, message: 'Promotion toggled', data: promo };
};
