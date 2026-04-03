/* services/brandService.js */

const Brand = require('../models/Brand');
const AppError = require('../utils/AppError');

exports.getAllBrands = async () => {
    return await Brand.find().sort({ name: 1 }).lean();
};

exports.createBrand = async (name) => {
    try {
        const newBrand = new Brand({ name });
        await newBrand.save();
        return newBrand;
    } catch (error) {
        if (error.code === 11000) {
            throw new AppError('Brand already exists', 400);
        }
        throw error;
    }
};
