/* controllers/expenseController.js */

const expenseService = require('../services/expenseService');

exports.uploadReceipt = async (request, reply) => {
    const data = await request.file();
    if (!data) return reply.status(400).send({ success: false, message: 'No file uploaded' });

    try {
        const secureUrl = await expenseService.uploadReceiptToCloud(data.file);
        return { success: true, receiptUrl: secureUrl };
    } finally {
        // OPTIMIZATION: Critical memory leak protection.
        // Ensures the raw Node.js stream is fully drained and destroyed from RAM,
        // even if the Cloudinary upload fails mid-stream.
        if (data && data.file) {
            data.file.resume();
            if (typeof data.file.destroy === 'function') {
                data.file.destroy();
            }
        }
    }
};

exports.createExpense = async (request, reply) => {
    const newExpense = await expenseService.createExpense(request.body);
    
    // REMOVED: request.server.broadcastToPOS (Now handled by Service events)

    return { success: true, message: 'Expense logged to cloud!', data: newExpense };
};

exports.getExpenses = async (request, reply) => {
    const expenses = await expenseService.getExpenses(request.query.dateStr);
    return { success: true, data: expenses };
};
