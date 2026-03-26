const Distributor = require('../models/Distributor');

const distributorSchema = {
    schema: {
        body: {
            type: 'object',
            required: ['name'],
            properties: {
                name: { type: 'string' }
            }
        }
    }
};

// --- NEW SCHEMA: B2B Payment Processing ---
const distributorPaymentSchema = {
    schema: {
        body: {
            type: 'object',
            required: ['amount'],
            properties: {
                amount: { type: 'number', minimum: 1 },
                paymentMode: { type: 'string' },
                referenceNote: { type: 'string' }
            }
        }
    }
};

async function distributorRoutes(fastify, options) {
    fastify.get('/api/distributors', { preHandler: [fastify.authenticate] }, async (request, reply) => {
        try {
            // --- OPTIMIZATION: Added .lean() for faster memory allocation ---
            const distributors = await Distributor.find().sort({ name: 1 }).lean();
            return { success: true, count: distributors.length, data: distributors };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error fetching distributors' });
        }
    });

    fastify.post('/api/distributors', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...distributorSchema }, async (request, reply) => {
        try {
            const { name } = request.body;
            const newDistributor = new Distributor({ name });
            await newDistributor.save();

            // --- NEW: Real-Time POS Notification ---
            if (fastify.broadcastToPOS) fastify.broadcastToPOS({ type: 'DISTRIBUTOR_ADDED', distributorId: newDistributor._id });

            return { success: true, message: 'Distributor added', data: newDistributor };
        } catch (error) {
            if (error.code === 11000) return reply.status(400).send({ success: false, message: 'Distributor already exists' });
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error creating distributor' });
        }
    });

    // --- NEW FUNCTIONALITY: Log Supplier Payments (Accounts Payable) ---
    fastify.post('/api/distributors/:id/pay', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...distributorPaymentSchema }, async (request, reply) => {
        try {
            const { amount, paymentMode, referenceNote } = request.body;
            
            const distributor = await Distributor.findById(request.params.id);
            if (!distributor) {
                return reply.status(404).send({ success: false, message: 'Distributor not found' });
            }

            // Ensure we don't reduce pending amount below zero
            const actualDeduction = Math.min(distributor.totalPendingAmount, amount);
            
            distributor.totalPendingAmount -= actualDeduction;
            distributor.totalPaidAmount += amount;
            
            distributor.paymentHistory.push({
                amount: amount,
                paymentMode: paymentMode || 'Cash',
                referenceNote: referenceNote || 'Manual Payment Logged'
            });

            await distributor.save();

            if (fastify.broadcastToPOS) fastify.broadcastToPOS({ type: 'DISTRIBUTOR_UPDATED', distributorId: distributor._id });

            return { success: true, message: 'Payment logged successfully', data: distributor };
        } catch (error) {
            fastify.log.error('Distributor Payment Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error processing payment' });
        }
    });
}

module.exports = distributorRoutes;
