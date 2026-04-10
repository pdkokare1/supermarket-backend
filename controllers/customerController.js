/* controllers/customerController.js */

const customerService = require('../services/customerService');
const catchAsync = require('../utils/catchAsync'); 
const { sendCsvResponse } = require('../utils/csvUtils'); 

// ==========================================
// --- CONTROLLER EXPORTS ---
// ==========================================

exports.getCustomersFromOrders = catchAsync(async (request, reply) => {
    const customerList = await customerService.getAggregatedCustomers();
    return { success: true, count: customerList.length, data: customerList };
}, 'Customer - Fetching from orders');

exports.exportCustomers = catchAsync(async (request, reply) => {
    const exportData = await customerService.getCustomersForExport();
    return sendCsvResponse(reply, exportData, 'customers');
}, 'Customer - Exporting');

exports.getProfile = catchAsync(async (request, reply) => {
    const cust = await customerService.getCustomerByPhone(request.params.phone);
    return { success: true, data: cust || null };
}, 'Customer - Fetching profile');

exports.updateLimit = catchAsync(async (request, reply) => {
    const { isCreditEnabled, creditLimit, name } = request.body;
    const cust = await customerService.updateCustomerLimit(request.params.phone, name, isCreditEnabled, creditLimit);
    
    // MODULARIZED: Notify POS that customer credit limits have changed
    if (request.server.broadcastToPOS) {
        request.server.broadcastToPOS({ type: 'CUSTOMER_UPDATED', phone: cust.phone });
    }

    return { success: true, data: cust };
}, 'Customer - Updating limit');

exports.recordPayment = catchAsync(async (request, reply) => {
    const cust = await customerService.recordPayment(request.params.phone, request.body.amount);
    
    // MODULARIZED: Notify POS that customer credit has been cleared
    if (request.server.broadcastToPOS) {
        request.server.broadcastToPOS({ type: 'CUSTOMER_PAYMENT_RECORDED', phone: cust.phone });
    }

    return { success: true, data: cust, message: 'Payment recorded successfully' };
}, 'Customer - Recording payment');

exports.getAllCustomers = catchAsync(async (request, reply) => {
    const customers = await customerService.getAllCustomers();
    return { success: true, count: customers.length, data: customers };
}, 'Customer - Fetching all');
