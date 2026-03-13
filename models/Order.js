const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
    customerName: { type: String, default: 'Guest Customer' }, // Temporary until Firebase is wired
    items: { type: Array, required: true },
    totalAmount: { type: Number, required: true },
    status: { type: String, default: 'Order Placed' },
    paymentMethod: { type: String, default: 'Cash on Delivery' }
}, { timestamps: true });

module.exports = mongoose.model('Order', orderSchema);
