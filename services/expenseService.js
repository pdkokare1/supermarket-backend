/* services/expenseService.js */

const Expense = require('../models/Expense');
const cloudinary = require('cloudinary').v2;
const AppError = require('../utils/AppError');
const appEvents = require('../utils/eventEmitter'); // Added for event-driven updates

exports.uploadReceiptToCloud = async (fileStream) => {
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            { folder: 'dailypick_expenses' },
            (error, result) => {
                if (error) reject(new AppError('Receipt upload failed', 500));
                else resolve(result.secure_url);
            }
        );
        fileStream.pipe(uploadStream);
    });
};

exports.createExpense = async (payload) => {
    const { desc, amount, dateStr, timeStr, receiptUrl } = payload;
    const newExpense = new Expense({ desc, amount, dateStr, timeStr, receiptUrl });
    await newExpense.save();

    // EVENT: Notify admin real-time tracking of new expense
    appEvents.emit('EXPENSE_LOGGED', { amount: newExpense.amount });

    return newExpense;
};

exports.getExpenses = async (dateStr) => {
    let filter = {};
    if (dateStr) filter.dateStr = dateStr;
    
    return await Expense.find(filter).sort({ createdAt: -1 }).lean();
};
