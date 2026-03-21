const mongoose = require('mongoose');

const expenseSchema = new mongoose.Schema({
    desc: { 
        type: String, 
        required: true 
    },
    amount: { 
        type: Number, 
        required: true 
    },
    dateStr: { 
        type: String, 
        required: true 
    }, // e.g., "Sat Mar 21 2026" - Matches your frontend exactly
    timeStr: { 
        type: String, 
        required: true 
    }, // e.g., "10:30 AM"
    createdAt: { 
        type: Date, 
        default: Date.now 
    }
});

module.exports = mongoose.model('Expense', expenseSchema);
