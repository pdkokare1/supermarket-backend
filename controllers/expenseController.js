/* controllers/expenseController.js */

const expenseService = require('../services/expenseService');
const catchAsync = require('../utils/catchAsync');

exports.uploadReceipt = catchAsync(async (request, reply) => {
    const data = await request.file();
    if (!data) return reply.status(400).send({ success: false, message: 'No file uploaded' });

    const secureUrl = await expenseService.uploadReceiptToCloud(data.file);
    return { success: true, receiptUrl: secureUrl };
}, 'Expense Receipt Upload');

exports.createExpense = catchAsync(async (request, reply) => {
    const newExpense = await expenseService.createExpense(request.body);
    return { success: true, message: 'Expense logged to cloud!', data: newExpense };
}, 'saving expense');

exports.getExpenses = catchAsync(async (request, reply) => {
    const expenses = await expenseService.getExpenses(request.query.dateStr);
    return { success: true, data: expenses };
}, 'fetching expenses');
