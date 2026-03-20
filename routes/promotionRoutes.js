const Promotion = require('../models/Promotion');

async function promotionRoutes(fastify, options) {
    
    // Get all active promotions
    fastify.get('/api/promotions', async (request, reply) => {
        try {
            let filter = request.query.all === 'true' ? {} : { isActive: true };
            const promotions = await Promotion.find(filter).sort({ createdAt: -1 });
            return { success: true, count: promotions.length, data: promotions };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error' });
        }
    });

    // Create a new promotion
    fastify.post('/api/promotions', async (request, reply) => {
        try {
            const { name, type, value, minCartValue, applicableCategory, startDate, endDate } = request.body;
            
            const newPromotion = new Promotion({
                name, type, value, minCartValue, applicableCategory, startDate, endDate
            });
            
            await newPromotion.save();
            return { success: true, message: 'Promotion created', data: newPromotion };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error' });
        }
    });

    // Toggle active status
    fastify.put('/api/promotions/:id/toggle', async (request, reply) => {
        try {
            const promo = await Promotion.findById(request.params.id);
            if (!promo) return reply.status(404).send({ success: false, message: 'Not found' });
            
            promo.isActive = !promo.isActive;
            await promo.save();
            return { success: true, message: 'Promotion toggled', data: promo };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error' });
        }
    });
}

module.exports = promotionRoutes;
