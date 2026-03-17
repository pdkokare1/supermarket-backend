const mongoose = require('mongoose');

const distributorSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true }
}, { timestamps: true });

module.exports = mongoose.model('Distributor', distributorSchema);
