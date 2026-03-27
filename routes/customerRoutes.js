/* routes/customerRoutes.js */

const Customer = require('../models/Customer');
const Order = require('../models/Order');
const { Parser } = require('json2csv');

const limitSchema = { schema: { body: { type: 'object', required: ['isCreditEnabled', 'creditLimit'], properties: { isCreditEnabled: { type: 'boolean' }, creditLimit: { type: 'number' }, name: { type: 'string' } } } } };
const paySchema = { schema: { body: { type: 'object', required: ['amount'], properties: { amount: { type: 'number', minimum: 0 } } } } };

async function customerRoutes(fastify, options) {

    fastify.get('/api/orders/customers', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, async (request, reply) => {
        try {
            const customerList = await Order.aggregate([
                { $match: { status: { $ne: 'Cancelled' } } },
                { $sort: { createdAt: 1 } }, 
                { 
                    $group: {
                        _id: { $ifNull: ["$customerPhone", "Unknown"] },
                        name: { $last: { $ifNull: ["$customerName", "Guest"] } },
                        phone: { $last: { $ifNull: ["$customerPhone", "Unknown"] } },
                        orderCount: { $sum: 1 },
                        lifetimeValue: { $sum: "$totalAmount" },
                        lastOrderDate: { $max: "$createdAt" }
                    }
                },
                { $sort: { lifetimeValue: -1 } },
                { $project: { _id: 0 } } 
            ]);

            return { success: true, count: customerList.length, data: customerList };
        } catch (error) {
            fastify.log.error('CRM Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error fetching customers' });
        }
    });

    fastify.get('/api/customers/export', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, async (request, reply) => {
        try {
            const customers = await Customer.find({}).lean();
            const exportData = customers.map(c => ({
                Name: c.name,
                Phone: c.phone,
                LoyaltyPoints: c.loyaltyPoints || 0,
                CreditEnabled: c.isCreditEnabled ? 'Yes' : 'No',
                CreditLimit: c.creditLimit || 0,
                CreditUsed: c.creditUsed || 0,
                JoinedDate: new Date(c.createdAt).toLocaleDateString()
            }));

            const json2csvParser = new Parser();
            const csv = json2csvParser.parse(exportData);

            reply.header('Content-Type', 'text/csv');
            reply.header('Content-Disposition', `attachment; filename="customers_export_${new Date().toISOString().split('T')[0]}.csv"`);
            return reply.send(csv);
        } catch (error) {
            fastify.log.error('Export Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error exporting customers' });
        }
    });

    fastify.get('/api/customers/profile/:phone', { preHandler: [fastify.authenticate] }, async (request, reply) => {
        try {
            const cust = await Customer.findOne({ phone: request.params.phone }).lean();
            if (!cust) return { success: true, data: null }; 
            return { success: true, data: cust };
        } catch (error) {
            reply.status(500).send({ success: false, message: 'Error fetching profile' });
        }
    });

    fastify.put('/api/customers/profile/:phone/limit', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...limitSchema }, async (request, reply) => {
        try {
            const { isCreditEnabled, creditLimit, name } = request.body;
            let cust = await Customer.findOne({ phone: request.params.phone });
            
            if (!cust) {
                cust = new Customer({ 
                    phone: request.params.phone, 
                    name: name || 'Valued Customer' 
                });
            }
            
            cust.isCreditEnabled = isCreditEnabled;
            cust.creditLimit = Number(creditLimit);
            await cust.save();
            
            return { success: true, data: cust };
        } catch (error) {
            reply.status(500).send({ success: false, message: 'Error updating limit' });
        }
    });

    fastify.post('/api/customers/profile/:phone/pay', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...paySchema }, async (request, reply) => {
        try {
            const { amount } = request.body;
            let cust = await Customer.findOne({ phone: request.params.phone });
            
            if (!cust) return reply.status(404).send({ success: false, message: 'Customer not found.' });
            
            cust.creditUsed -= Number(amount);
            if (cust.creditUsed < 0) cust.creditUsed = 0; 
            
            await cust.save();
            return { success: true, data: cust, message: 'Payment recorded successfully' };
        } catch (error) {
            reply.status(500).send({ success: false, message: 'Error recording payment' });
        }
    });

    fastify.get('/api/customers', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, async (request, reply) => {
        try {
            const customers = await Customer.find({}).lean();
            return { success: true, count: customers.length, data: customers };
        } catch (error) {
            fastify.log.error('CRM Error:', error);
            reply.status(500).send({ success: false, message: 'Server Error fetching all customers' });
        }
    });
}

module.exports = customerRoutes;
