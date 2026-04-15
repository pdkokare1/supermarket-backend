/* controllers/customerController.js */

const customerService = require('../services/customerService');
const { sendCsvResponse } = require('../utils/csvUtils'); 

// ==========================================
// --- CONTROLLER EXPORTS ---
// ==========================================

exports.getCustomersFromOrders = async (request, reply) => {
    const customerList = await customerService.getAggregatedCustomers();
    return { success: true, count: customerList.length, data: customerList };
};

exports.exportCustomers = async (request, reply) => {
    const exportData = await customerService.getCustomersForExport();
    return sendCsvResponse(reply, exportData, 'customers');
};

exports.getProfile = async (request, reply) => {
    const cust = await customerService.getCustomerByPhone(request.params.phone);
    return { success: true, data: cust || null };
};

exports.updateLimit = async (request, reply) => {
    const { isCreditEnabled, creditLimit, name } = request.body;
    const cust = await customerService.updateCustomerLimit(request.params.phone, name, isCreditEnabled, creditLimit);
    // REMOVED: request.server.broadcastToPOS (Now handled by Service events)
    return { success: true, data: cust };
};

exports.recordPayment = async (request, reply) => {
    const cust = await customerService.recordPayment(request.params.phone, request.body.amount);
    // REMOVED: request.server.broadcastToPOS (Now handled by Service events)
    return { success: true, data: cust, message: 'Payment recorded successfully' };
};

exports.getAllCustomers = async (request, reply) => {
    const customers = await customerService.getAllCustomers();
    return { success: true, count: customers.length, data: customers };
};
