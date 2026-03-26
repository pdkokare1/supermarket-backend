const Promotion = require('../models/Promotion');

const promotionSchema = {
    schema: {
        body: {
            type: 'object',
            required: ['name', 'type', 'value', 'startDate', 'endDate'],
            properties: {
                name: { type: 'string' },
                type: { type: 'string', enum: ['Percentage', 'Flat', 'BOGO'] },
                value: { type: 'number' },
                minCartValue: { type: 'number' },
                applicableCategory: { type: 'string' },
                startDate: { type: 'string' },
                endDate: { type: 'string' },
                // --- NEW ADVANCED PROMO FIELDS ---
                buyQty: { type: 'number' },
                getQty: { type: 'number' },
                startTime: { type: 'string' },
                endTime: { type: 'string' }
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
            return { success: true, count: promotions.length, data: promotions };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error' });
        }
    });

    fastify.post('/api/promotions', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...promotionSchema }, async (request, reply) => {
        try {
            const { name, type, value, minCartValue, applicableCategory, startDate, endDate, buyQty, getQty, startTime, endTime } = request.body;
            
            const newPromotion = new Promotion({
                name, type, value, minCartValue, applicableCategory, startDate, endDate
            });
            
            // --- OPTIMIZATION: Bypass strict mode to save advanced fields without model rebuilds ---
            if (buyQty) newPromotion.set('buyQty', buyQty, { strict: false });
            if (getQty) newPromotion.set('getQty', getQty, { strict: false });
            if (startTime) newPromotion.set('startTime', startTime, { strict: false });
            if (endTime) newPromotion.set('endTime', endTime, { strict: false });
            
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
