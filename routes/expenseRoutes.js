const Expense = require('../models/Expense');
const cloudinary = require('cloudinary').v2; // --- NEW: Added Cloudinary for Receipts ---

const expenseBodySchema = {
    schema: {
        body: {
            type: 'object',
            required: ['desc', 'amount', 'dateStr', 'timeStr'],
            properties: {
                desc: { type: 'string' },
                amount: { type: 'number' },
                dateStr: { type: 'string' },
                timeStr: { type: 'string' },
                receiptUrl: { type: 'string' } // --- NEW ---
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

    // --- NEW: Digital Receipt Upload Route ---
    fastify.post('/api/expenses/upload', { preHandler: [fastify.authenticate, fastify.verifyAdmin] }, async (request, reply) => {
        try {
            const data = await request.file();
            if (!data) return reply.status(400).send({ success: false, message: 'No file uploaded' });

            const uploadResult = await new Promise((resolve, reject) => {
                const uploadStream = cloudinary.uploader.upload_stream(
                    { folder: 'dailypick_expenses' },
                    (error, result) => {
                        if (error) reject(error);
                        else resolve(result);
                    }
                );
                data.file.pipe(uploadStream);
            });

            return { success: true, receiptUrl: uploadResult.secure_url };
        } catch (error) {
            fastify.log.error('Expense Receipt Upload Error:', error);
            reply.status(500).send({ success: false, message: 'Receipt upload failed' });
        }
    });

    fastify.post('/api/expenses', { preHandler: [fastify.authenticate, fastify.verifyAdmin], ...expenseBodySchema }, async (request, reply) => {
        try {
            const { desc, amount, dateStr, timeStr, receiptUrl } = request.body;
            
            const newExpense = new Expense({ desc, amount, dateStr, timeStr, receiptUrl });
            await newExpense.save();
            
            return { success: true, message: 'Expense logged to cloud!', data: newExpense };
        } catch (error) {
            fastify.log.error(error);
            reply.status(500).send({ success: false, message: 'Server Error saving expense' });
        }
    });

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
