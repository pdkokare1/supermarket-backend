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
    }, 
    timeStr: { 
        type: String, 
        required: true 
    }, 
    // --- NEW: Digital Receipt Attachment ---
    receiptUrl: { 
        type: String, 
        default: '' 
    },
    createdAt: { 
        type: Date, 
        default: Date.now 
    }
});

module.exports = mongoose.model('Expense', expenseSchema);
