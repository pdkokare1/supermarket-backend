const Shift = require('../models/Shift');
const Order = require('../models/Order');

async function shiftRoutes(fastify, options) {
    
    fastify.post('/api/shifts/open', async (request, reply) => {
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
            return { success: true, data: newShift, message: 'Register Opened Successfully!' };
        } catch (error) {
            fastify.log.error('Open Shift Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error opening shift' });
        }
    });

    fastify.get('/api/shifts/current', async (request, reply) => {
        try {
            const currentShift = await Shift.findOne({ status: 'Open' });
            return { success: true, data: currentShift || null };
        } catch (error) {
            fastify.log.error('Fetch Shift Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error fetching shift' });
        }
    });

    fastify.put('/api/shifts/close', async (request, reply) => {
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
