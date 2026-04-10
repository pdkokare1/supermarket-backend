/* services/promotionService.js */

const Promotion = require('../models/Promotion');
const AppError = require('../utils/AppError');
const cacheUtils = require('../utils/cacheUtils');
const appEvents = require('../utils/eventEmitter'); // Added for event-driven updates

exports.getPromotions = async (all) => {
    const cacheKey = all === 'true' ? 'promotions:all' : 'promotions:active';
    
    const cachedData = await cacheUtils.getCachedData(cacheKey);
    if (cachedData) return cachedData;

    const filter = all === 'true' ? {} : { isActive: true };
    const promotions = await Promotion.find(filter).sort({ createdAt: -1 }).lean();
    
    const formatted = promotions.map(p => ({
        ...p, 
        code: p.code || p.name, 
        discountType: p.discountType || p.type,
        discountValue: p.discountValue || p.value, 
        minOrderValue: p.minOrderValue || p.minCartValue
    }));

    await cacheUtils.setCachedData(cacheKey, formatted, 3600);
    return formatted;
};

exports.createPromotion = async (payload) => {
    const newPromotion = new Promotion({
        name: payload.name || payload.code, code: payload.code, type: payload.type || payload.discountType,
        discountType: payload.discountType, value: payload.value || payload.discountValue, discountValue: payload.discountValue,
        minCartValue: payload.minCartValue || payload.minOrderValue, minOrderValue: payload.minOrderValue,
        applicableCategory: payload.applicableCategory, startDate: payload.startDate, endDate: payload.endDate
    });
    if (payload.buyQty) newPromotion.set('buyQty', payload.buyQty, { strict: false });
    if (payload.getQty) newPromotion.set('getQty', payload.getQty, { strict: false });
    if (payload.startTime) newPromotion.set('startTime', payload.startTime, { strict: false });
    if (payload.endTime) newPromotion.set('endTime', payload.endTime, { strict: false });
    
    await newPromotion.save();
    await cacheUtils.invalidateByPattern('promotions:*');
    
    // EVENT: Notify system of new promotion
    appEvents.emit('PROMOTION_ADDED', { promotionId: newPromotion._id });
    
    return newPromotion;
};

exports.togglePromotion = async (id) => {
    const promo = await Promotion.findById(id);
    if (!promo) throw new AppError('Not found', 404);
    
    promo.isActive = !promo.isActive;
    await promo.save();
    await cacheUtils.invalidateByPattern('promotions:*');
    
    // EVENT: Notify system of status change
    appEvents.emit('PROMOTION_TOGGLED', { promotionId: promo._id, isActive: promo.isActive });
    
    return promo;
};
