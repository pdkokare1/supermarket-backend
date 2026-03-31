/* utils/csvUtils.js */

const { Parser } = require('json2csv');

exports.sendCsvResponse = (reply, data, filenamePrefix) => {
    const csv = new Parser().parse(data);
    const dateStr = new Date().toISOString().split('T')[0];
    
    reply.header('Content-Type', 'text/csv');
    reply.header('Content-Disposition', `attachment; filename="${filenamePrefix}_export_${dateStr}.csv"`);
    return reply.send(csv);
};
