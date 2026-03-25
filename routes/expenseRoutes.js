const Expense = require('../models/Expense');

const expenseBodySchema = {
    schema: {
        body: {
            type: 'object',
            required: ['desc', 'amount', 'dateStr', 'timeStr'],
            properties: {
                desc: { type: 'string' },
                amount: { type: 'number' },
                dateStr: { type: 'string' },
                timeStr: { type: 'string' }
            }
        }
    }
};

const expenseQuerySchema = {
    schema: {
        querystring: {
            type: 'object',
            properties: {
                dateStr: { type: 'string' }
            }
        }
    }
};

async function expenseRoutes(fastify, options) {

    // --- SECURED: Added Auth and Admin RBAC hooks + Validation ---
    fastify.post('/api/expenses', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...expenseBodySchema }, async (request, reply) => {
        try {
            const { desc, amount, dateStr, timeStr } = request.body;
            
            const newExpense = new Expense({ desc, amount, dateStr, timeStr });
            await newExpense.save();
            
            return { success: true, message: 'Expense logged to cloud!', data: newExpense };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error saving expense' });
        }
    });

    // --- SECURED: Added Auth and Admin RBAC hooks + Validation ---
    fastify.get('/api/expenses', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...expenseQuerySchema }, async (request, reply) => {
        try {
            const { dateStr } = request.query;
            let filter = {};
            
            if (dateStr) {
                filter.dateStr = dateStr;
            }
            
            const expenses = await Expense.find(filter).sort({ createdAt: -1 });
            
            return { success: true, data: expenses };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error fetching expenses' });
        }
    });

}

module.exports = expenseRoutes;
