const Shift = require('../models/Shift');
const Order = require('../models/Order');
const AuditLog = require('../models/AuditLog'); // --- NEW: Integrated Security Auditing ---

const openShiftSchema = {
    schema: {
        body: {
            type: 'object',
            required: ['startingFloat'],
            properties: {
                userName: { type: 'string' },
                startingFloat: { type: 'number', minimum: 0 }
            }
        }
    }
};

const closeShiftSchema = {
    schema: {
        body: {
            type: 'object',
            required: ['shiftId', 'actualCash'],
            properties: {
                shiftId: { type: 'string' },
                actualCash: { type: 'number', minimum: 0 }
            }
        }
    }
};

async function shiftRoutes(fastify, options) {
    
    fastify.post('/api/shifts/open', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...openShiftSchema }, async (request, reply) => {
        try {
            const { userName, startingFloat } = request.body;
            
            const existingShift = await Shift.findOne({ status: 'Open' });
            if (existingShift) {
                return reply.status(400).send({ success: false, message: 'A shift is already open. Close it first.' });
            }

            const newShift = new Shift({
                userName: userName || 'Cashier',
                startingFloat: Number(startingFloat) || 0,
                status: 'Open'
            });
            
            await newShift.save();

            // --- SECURITY HARDENING: Generate Audit Log for Drawer Open ---
            await AuditLog.create({
                userId: request.user ? request.user.id : null,
                username: request.user ? request.user.username : userName || 'System',
                action: 'SHIFT_OPENED',
                targetType: 'Shift',
                targetId: newShift._id.toString(),
                details: { startingFloat: newShift.startingFloat }
            }).catch(e => fastify.log.error('AuditLog Error:', e));

            // --- NEW: Real-Time POS Notification ---
            if (fastify.broadcastToPOS) fastify.broadcastToPOS({ type: 'SHIFT_OPENED', shiftId: newShift._id });

            return { success: true, data: newShift, message: 'Register Opened Successfully!' };
        } catch (error) {
            fastify.log.error('Open Shift Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error opening shift' });
        }
    });

    fastify.get('/api/shifts/current', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, async (request, reply) => {
        try {
            // --- OPTIMIZATION: Added .lean() for faster memory allocation ---
            const currentShift = await Shift.findOne({ status: 'Open' }).lean();
            return { success: true, data: currentShift || null };
        } catch (error) {
            fastify.log.error('Fetch Shift Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error fetching shift' });
        }
    });

    fastify.put('/api/shifts/close', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...closeShiftSchema }, async (request, reply) => {
        try {
            const { shiftId, actualCash } = request.body;
            const shift = await Shift.findById(shiftId);
            
            if (!shift || shift.status === 'Closed') {
                return reply.status(400).send({ success: false, message: 'Shift not found or already closed.' });
            }

            const endTime = new Date();
            
            // Calculate strictly the cash sales processed during THIS exact shift's active hours
            const shiftOrders = await Order.find({
                createdAt: { $gte: shift.startTime, $lte: endTime },
                status: { $ne: 'Cancelled' }
            });

            let cashSales = 0;
            shiftOrders.forEach(o => {
                if (o.paymentMethod === 'Cash') {
                    cashSales += o.totalAmount;
                } else if (o.paymentMethod === 'Split' && o.splitDetails) {
                    cashSales += (o.splitDetails.cash || 0);
                }
            });

            // The drawer should contain the starting float PLUS all cash sales
            const expectedCash = shift.startingFloat + cashSales;

            shift.endTime = endTime;
            shift.expectedCash = expectedCash;
            shift.actualCash = Number(actualCash);
            shift.status = 'Closed';

            await shift.save();

            const discrepancy = shift.actualCash - shift.expectedCash;

            // --- SECURITY HARDENING: Generate Audit Log for Drawer Close ---
            await AuditLog.create({
                userId: request.user ? request.user.id : null,
                username: request.user ? request.user.username : 'System',
                action: 'SHIFT_CLOSED',
                targetType: 'Shift',
                targetId: shift._id.toString(),
                details: { expectedCash, actualCash: shift.actualCash, discrepancy }
            }).catch(e => fastify.log.error('AuditLog Error:', e));

            // --- NEW: Real-Time POS Notification ---
            if (fastify.broadcastToPOS) fastify.broadcastToPOS({ type: 'SHIFT_CLOSED', shiftId: shift._id });

            return { 
                success: true, 
                message: 'Register Closed Successfully', 
                data: shift,
                discrepancy: discrepancy 
            };
        } catch (error) {
            fastify.log.error('Close Shift Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error closing shift' });
        }
    });

}

module.exports = shiftRoutes;
