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
                endDate: { type: 'string' }
            }
        }
    }
};

// --- NEW PERFORMANCE SCHEMA: Fastify Query Parsing ---
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
    
    // Get all active promotions (Now optimized with Query Schema and .lean())
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

    // Create a new promotion
    fastify.post('/api/promotions', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...promotionSchema }, async (request, reply) => {
        try {
            const { name, type, value, minCartValue, applicableCategory, startDate, endDate } = request.body;
            
            const newPromotion = new Promotion({
                name, type, value, minCartValue, applicableCategory, startDate, endDate
            });
            
            await newPromotion.save();

            // --- NEW: Real-Time POS Notification ---
            if (fastify.broadcastToPOS) fastify.broadcastToPOS({ type: 'PROMOTION_ADDED', promotionId: newPromotion._id });

            return { success: true, message: 'Promotion created', data: newPromotion };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error' });
        }
    });

    // Toggle active status
    fastify.put('/api/promotions/:id/toggle', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, async (request, reply) => {
        try {
            const promo = await Promotion.findById(request.params.id);
            if (!promo) return reply.status(404).send({ success: false, message: 'Not found' });
            
            promo.isActive = !promo.isActive;
            await promo.save();

            // --- NEW: Real-Time POS Notification ---
            if (fastify.broadcastToPOS) fastify.broadcastToPOS({ type: 'PROMOTION_TOGGLED', promotionId: promo._id, isActive: promo.isActive });

            return { success: true, message: 'Promotion toggled', data: promo };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error' });
        }
    });
}

module.exports = promotionRoutes;
