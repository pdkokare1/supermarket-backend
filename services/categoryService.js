/* services/categoryService.js */

const Category = require('../models/Category');
const cacheUtils = require('../utils/cacheUtils');
const AppError = require('../utils/AppError');

exports.getAllCategories = async () => {
    // Relying on our centralized cache utility instead of a manual route connection
    const cachedCategories = await cacheUtils.getCachedData('categories:all');
    if (cachedCategories) return cachedCategories;

    const categories = await Category.find().sort({ name: 1 }).lean();
    const responseData = { success: true, count: categories.length, data: categories };

    await cacheUtils.setCachedData('categories:all', responseData, 86400); // 24 hours
    return responseData;
};

exports.createCategory = async (name) => {
    try {
        const newCategory = new Category({ name });
        await newCategory.save();
        
        // Invalidate Cache so the next fetch gets the new category
        await cacheUtils.deleteKey('categories:all');
        
        return newCategory;
    } catch (error) {
        if (error.code === 11000) {
            throw new AppError('Category already exists', 400);
        }
        throw error; // Let the catchAsync wrapper handle generic server errors
    }
};
