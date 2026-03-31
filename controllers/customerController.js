/* controllers/customerController.js */

const { Parser } = require('json2csv');
const customerService = require('../services/customerService');

// ==========================================
// --- HELPER FUNCTIONS ---
// ==========================================

const handleCustomerError = (request, reply, error, contextMessage) => {
    if (error.message === 'Customer not found.') {
        return reply.status(404).send({ success: false, message: error.message });
    }
    request.server.log.error(`[Customer] ${contextMessage} Error:`, error);
    reply.status(500).send({ success: false, message: `Server Error ${contextMessage.toLowerCase()}` });
};

const formatCustomerForExport = (c) => ({
    Name: c.name,
    Phone: c.phone,
    LoyaltyPoints: c.loyaltyPoints || 0,
    CreditEnabled: c.isCreditEnabled ? 'Yes' : 'No',
    CreditLimit: c.creditLimit || 0,
    CreditUsed: c.creditUsed || 0,
    JoinedDate: new Date(c.createdAt).toLocaleDateString()
});

// ==========================================
// --- CONTROLLER EXPORTS ---
// ==========================================

exports.getCustomersFromOrders = async (request, reply) => {
    try {
        const customerList = await customerService.getAggregatedCustomers();
        return { success: true, count: customerList.length, data: customerList };
    } catch (error) {
        handleCustomerError(request, reply, error, 'fetching customers from orders');
    }
};

exports.exportCustomers = async (request, reply) => {
    try {
        const customers = await customerService.getAllCustomers();
        const exportData = customers.map(formatCustomerForExport);

        const csv = new Parser().parse(exportData);

        reply.header('Content-Type', 'text/csv');
        reply.header('Content-Disposition', `attachment; filename="customers_export_${new Date().toISOString().split('T')[0]}.csv"`);
        return reply.send(csv);
    } catch (error) {
        handleCustomerError(request, reply, error, 'exporting customers');
    }
};

exports.getProfile = async (request, reply) => {
    try {
        const cust = await customerService.getCustomerByPhone(request.params.phone);
        return { success: true, data: cust || null };
    } catch (error) {
        handleCustomerError(request, reply, error, 'fetching profile');
    }
};

exports.updateLimit = async (request, reply) => {
    try {
        const { isCreditEnabled, creditLimit, name } = request.body;
        const cust = await customerService.updateCustomerLimit(request.params.phone, name, isCreditEnabled, creditLimit);
        return { success: true, data: cust };
    } catch (error) {
        handleCustomerError(request, reply, error, 'updating limit');
    }
};

exports.recordPayment = async (request, reply) => {
    try {
        const cust = await customerService.recordPayment(request.params.phone, request.body.amount);
        return { success: true, data: cust, message: 'Payment recorded successfully' };
    } catch (error) {
        handleCustomerError(request, reply, error, 'recording payment');
    }
};

exports.getAllCustomers = async (request, reply) => {
    try {
        const customers = await customerService.getAllCustomers();
        return { success: true, count: customers.length, data: customers };
    } catch (error) {
        handleCustomerError(request, reply, error, 'fetching all customers');
    }
};
