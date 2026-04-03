/* routes/expenseRoutes.js */

const expenseController = require('../controllers/expenseController');

const expenseBodySchema = {
    schema: {
        body: {
            type: 'object',
            required: ['desc', 'amount', 'dateStr', 'timeStr'],
            properties: {
                desc: { type: 'string' }, amount: { type: 'number' },
                dateStr: { type: 'string' }, timeStr: { type: 'string' }, receiptUrl: { type: 'string' }
            }
        }
    }
};

const expenseQuerySchema = {
    schema: { querystring: { type: 'object', properties: { dateStr: { type: 'string' } } } }
};

async function expenseRoutes(fastify, options) {
    fastify.post('/api/expenses/upload', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, expenseController.uploadReceipt);
    fastify.post('/api/expenses', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...expenseBodySchema }, expenseController.createExpense);
    fastify.get('/api/expenses', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...expenseQuerySchema }, expenseController.getExpenses);
}

module.exports = expenseRoutes;
