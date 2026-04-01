/* controllers/customerController.js */

const customerService = require('../services/customerService');
const { handleControllerError } = require('../utils/errorUtils'); 
const { sendCsvResponse } = require('../utils/csvUtils'); 

// ==========================================
// --- CONTROLLER EXPORTS ---
// ==========================================

exports.getCustomersFromOrders = async (request, reply) => {
    try {
        const customerList = await customerService.getAggregatedCustomers();
        return { success: true, count: customerList.length, data: customerList };
    } catch (error) {
        handleControllerError(request, reply, error, 'Customer - Fetching from orders');
    }
};

exports.exportCustomers = async (request, reply) => {
    try {
        const exportData = await customerService.getCustomersForExport();
        return sendCsvResponse(reply, exportData, 'customers');
    } catch (error) {
        handleControllerError(request, reply, error, 'Customer - Exporting');
    }
};

exports.getProfile = async (request, reply) => {
    try {
        const cust = await customerService.getCustomerByPhone(request.params.phone);
        return { success: true, data: cust || null };
    } catch (error) {
        handleControllerError(request, reply, error, 'Customer - Fetching profile');
    }
};

exports.updateLimit = async (request, reply) => {
    try {
        const { isCreditEnabled, creditLimit, name } = request.body;
        const cust = await customerService.updateCustomerLimit(request.params.phone, name, isCreditEnabled, creditLimit);
        return { success: true, data: cust };
    } catch (error) {
        handleControllerError(request, reply, error, 'Customer - Updating limit');
    }
};

exports.recordPayment = async (request, reply) => {
    try {
        const cust = await customerService.recordPayment(request.params.phone, request.body.amount);
        return { success: true, data: cust, message: 'Payment recorded successfully' };
    } catch (error) {
        handleControllerError(request, reply, error, 'Customer - Recording payment');
    }
};

exports.getAllCustomers = async (request, reply) => {
    try {
        const customers = await customerService.getAllCustomers();
        return { success: true, count: customers.length, data: customers };
    } catch (error) {
        handleControllerError(request, reply, error, 'Customer - Fetching all');
    }
};
