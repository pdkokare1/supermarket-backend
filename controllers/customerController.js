/* controllers/customerController.js */

const { Parser } = require('json2csv');
const customerService = require('../services/customerService');

exports.getCustomersFromOrders = async (request, reply) => {
    try {
        const customerList = await customerService.getAggregatedCustomers();
        return { success: true, count: customerList.length, data: customerList };
    } catch (error) {
        request.server.log.error('CRM Error:', error);
        reply.status(500).send({ success: false, message: 'Server Error fetching customers' });
    }
};

exports.exportCustomers = async (request, reply) => {
    try {
        const customers = await customerService.getAllCustomers();
        const exportData = customers.map(c => ({
            Name: c.name,
            Phone: c.phone,
            LoyaltyPoints: c.loyaltyPoints || 0,
            CreditEnabled: c.isCreditEnabled ? 'Yes' : 'No',
            CreditLimit: c.creditLimit || 0,
            CreditUsed: c.creditUsed || 0,
            JoinedDate: new Date(c.createdAt).toLocaleDateString()
        }));

        const csv = new Parser().parse(exportData);

        reply.header('Content-Type', 'text/csv');
        reply.header('Content-Disposition', `attachment; filename="customers_export_${new Date().toISOString().split('T')[0]}.csv"`);
        return reply.send(csv);
    } catch (error) {
        request.server.log.error('Export Error:', error);
        reply.status(500).send({ success: false, message: 'Server Error exporting customers' });
    }
};

exports.getProfile = async (request, reply) => {
    try {
        const cust = await customerService.getCustomerByPhone(request.params.phone);
        return { success: true, data: cust || null };
    } catch (error) {
        reply.status(500).send({ success: false, message: 'Error fetching profile' });
    }
};

exports.updateLimit = async (request, reply) => {
    try {
        const { isCreditEnabled, creditLimit, name } = request.body;
        const cust = await customerService.updateCustomerLimit(request.params.phone, name, isCreditEnabled, creditLimit);
        return { success: true, data: cust };
    } catch (error) {
        reply.status(500).send({ success: false, message: 'Error updating limit' });
    }
};

exports.recordPayment = async (request, reply) => {
    try {
        const cust = await customerService.recordPayment(request.params.phone, request.body.amount);
        return { success: true, data: cust, message: 'Payment recorded successfully' };
    } catch (error) {
        if (error.message === 'Customer not found.') return reply.status(404).send({ success: false, message: error.message });
        reply.status(500).send({ success: false, message: 'Error recording payment' });
    }
};

exports.getAllCustomers = async (request, reply) => {
    try {
        const customers = await customerService.getAllCustomers();
        return { success: true, count: customers.length, data: customers };
    } catch (error) {
        request.server.log.error('CRM Error:', error);
        reply.status(500).send({ success: false, message: 'Server Error fetching all customers' });
    }
};
