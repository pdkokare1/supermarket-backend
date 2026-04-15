/* controllers/categoryController.js */

const categoryService = require('../services/categoryService');

exports.getCategories = async (request, reply) => {
    return await categoryService.getAllCategories();
};

exports.createCategory = async (request, reply) => {
    const newCategory = await categoryService.createCategory(request.body.name);
    
    if (request.server.broadcastToPOS) {
        request.server.broadcastToPOS({ type: 'CATEGORY_ADDED', categoryId: newCategory._id });
    }

    return { success: true, message: 'Category added', data: newCategory };
};
