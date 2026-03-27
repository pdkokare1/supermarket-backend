/* routes/promotionRoutes.js */

const Promotion = require('../models/Promotion');

const promotionSchema = {
    schema: {
        body: {
            type: 'object',
            properties: {
                // Legacy
                name: { type: 'string' },
                type: { type: 'string' },
                value: { type: 'number' },
                minCartValue: { type: 'number' },
                applicableCategory: { type: 'string' },
                startDate: { type: 'string' },
                endDate: { type: 'string' },
                buyQty: { type: 'number' },
                getQty: { type: 'number' },
                startTime: { type: 'string' },
                endTime: { type: 'string' },
                // Phase 3 UI Fields
                code: { type: 'string' },
                discountType: { type: 'string' },
                discountValue: { type: 'number' },
                minOrderValue: { type: 'number' }
            }
        }
    }
};

const getPromotionsSchema = {
    schema: {
        querystring: {
            type: 'object',
            properties: {
                all: { type: 'string' }
            }
        }
    }
};

async function promotionRoutes(fastify, options) {
    
    fastify.get('/api/promotions', { preHandler: [fastify.authenticate], ...getPromotionsSchema }, async (request, reply) => {
        try {
            let filter = request.query.all === 'true' ? {} : { isActive: true };
            const promotions = await Promotion.find(filter).sort({ createdAt: -1 }).lean();
            
            // Map legacy fields back to UI standard if missing
            const mappedPromotions = promotions.map(p => ({
                ...p,
                code: p.code || p.name,
                discountType: p.discountType || p.type,
                discountValue: p.discountValue || p.value,
                minOrderValue: p.minOrderValue || p.minCartValue
            }));

            return { success: true, count: mappedPromotions.length, data: mappedPromotions };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error' });
        }
    });

    fastify.post('/api/promotions', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...promotionSchema }, async (request, reply) => {
        try {
            const payload = request.body;
            
            const newPromotion = new Promotion({
                name: payload.name || payload.code,
                code: payload.code,
                type: payload.type || payload.discountType,
                discountType: payload.discountType,
                value: payload.value || payload.discountValue,
                discountValue: payload.discountValue,
                minCartValue: payload.minCartValue || payload.minOrderValue,
                minOrderValue: payload.minOrderValue,
                applicableCategory: payload.applicableCategory,
                startDate: payload.startDate,
                endDate: payload.endDate
            });
            
            if (payload.buyQty) newPromotion.set('buyQty', payload.buyQty, { strict: false });
            if (payload.getQty) newPromotion.set('getQty', payload.getQty, { strict: false });
            if (payload.startTime) newPromotion.set('startTime', payload.startTime, { strict: false });
            if (payload.endTime) newPromotion.set('endTime', payload.endTime, { strict: false });
            
            await newPromotion.save();

            if (fastify.broadcastToPOS) fastify.broadcastToPOS({ type: 'PROMOTION_ADDED', promotionId: newPromotion._id });

            return { success: true, message: 'Promotion created', data: newPromotion };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error' });
        }
    });

    fastify.put('/api/promotions/:id/toggle', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, async (request, reply) => {
        try {
            const promo = await Promotion.findById(request.params.id);
            if (!promo) return reply.status(404).send({ success: false, message: 'Not found' });
            
            promo.isActive = !promo.isActive;
            await promo.save();

            if (fastify.broadcastToPOS) fastify.broadcastToPOS({ type: 'PROMOTION_TOGGLED', promotionId: promo._id, isActive: promo.isActive });

            return { success: true, message: 'Promotion toggled', data: promo };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error' });
        }
    });
}

module.exports = promotionRoutes;
