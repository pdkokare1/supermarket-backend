const Promotion = require('../models/Promotion');
const AppError = require('../utils/AppError');

exports.getPromotions = async (all) => {
    const filter = all === 'true' ? {} : { isActive: true };
    const promotions = await Promotion.find(filter).sort({ createdAt: -1 }).lean();
    return promotions.map(p => ({
        ...p, code: p.code || p.name, discountType: p.discountType || p.type,
        discountValue: p.discountValue || p.value, minOrderValue: p.minOrderValue || p.minCartValue
    }));
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
    return newPromotion;
};

exports.togglePromotion = async (id) => {
    const promo = await Promotion.findById(id);
    if (!promo) throw new AppError('Not found', 404);
    promo.isActive = !promo.isActive;
    await promo.save();
    return promo;
};
