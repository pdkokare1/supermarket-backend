const Expense = require('../models/Expense');

async function expenseRoutes(fastify, options) {
    
    // --- OLD CODE (KEPT FOR CONSULTATION) ---
    // fastify.post('/api/expenses', async (request, reply) => { ...

    // --- SECURED: Added Admin RBAC hook ---
    fastify.post('/api/expenses', { preHandler: [fastify.verifyAdmin] }, async (request, reply) => {
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

    // --- OLD CODE (KEPT FOR CONSULTATION) ---
    // fastify.get('/api/expenses', async (request, reply) => { ...

    // --- SECURED: Added Admin RBAC hook ---
    fastify.get('/api/expenses', { preHandler: [fastify.verifyAdmin] }, async (request, reply) => {
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
