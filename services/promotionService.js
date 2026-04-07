/* services/promotionService.js */

const Promotion = require('../models/Promotion');
const AppError = require('../utils/AppError');
const cacheUtils = require('../utils/cacheUtils');

exports.getPromotions = async (all) => {
    // OPTIMIZED: Cache active promotions using O(1) hash maps.
    // Active promotions are fetched frequently by the POS; this prevents constant database hits.
    const cacheKey = all === 'true' ? 'promotions:all' : 'promotions:active';
    
    const cachedData = await cacheUtils.getCachedData(cacheKey);
    if (cachedData) return cachedData;

    const filter = all === 'true' ? {} : { isActive: true };
    
    // OPTIMIZED: Strict memory projection via .lean() to prevent mongoose object bloat
    const promotions = await Promotion.find(filter).sort({ createdAt: -1 }).lean();
    
    const formatted = promotions.map(p => ({
        ...p, 
        code: p.code || p.name, 
        discountType: p.discountType || p.type,
        discountValue: p.discountValue || p.value, 
        minOrderValue: p.minOrderValue || p.minCartValue
    }));

    // Cache the result for 1 hour
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
    
    // Invalidate cache immediately on new promotion creation
    await cacheUtils.invalidateByPattern('promotions:*');
    
    return newPromotion;
};

exports.togglePromotion = async (id) => {
    const promo = await Promotion.findById(id);
    if (!promo) throw new AppError('Not found', 404);
    
    promo.isActive = !promo.isActive;
    await promo.save();
    
    // Invalidate cache immediately on status toggle
    await cacheUtils.invalidateByPattern('promotions:*');
    
    return promo;
};
