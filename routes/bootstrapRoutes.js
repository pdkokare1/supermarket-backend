/* routes/bootstrapRoutes.js */
'use strict';

const Category = require('../models/Category');
const Brand = require('../models/Brand');
const Distributor = require('../models/Distributor');
const Promotion = require('../models/Promotion');

async function bootstrapRoutes(fastify, options) {
    // OPTIMIZATION: Consolidated Bootstrap Payload to eliminate CORS preflight waterfall
    fastify.get('/api/bootstrap', { preHandler: [fastify.authenticate] }, async (request, reply) => {
        try {
            // Fetch all core UI data in a single parallel sweep
            const [categories, brands, distributors, promotions] = await Promise.all([
                Category.find({}).lean(),
                Brand.find({}).lean(),
                Distributor.find({}).lean(),
                Promotion.find({ isActive: true }).lean()
            ]);

            return {
                success: true,
                data: {
                    categories,
                    brands,
                    distributors,
                    promotions
                }
            };
        } catch (error) {
            request.log.error(error);
            reply.status(500).send({ success: false, message: 'Failed to fetch bootstrap payload' });
        }
    });
}

module.exports = bootstrapRoutes;
