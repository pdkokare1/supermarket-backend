/* utils/csvUtils.js */

const { Parser } = require('json2csv');

exports.sendCsvResponse = (reply, data, filenamePrefix) => {
    const dateStr = new Date().toISOString().split('T')[0];
    
    reply.header('Content-Type', 'text/csv');
    reply.header('Content-Disposition', `attachment; filename="${filenamePrefix}_export_${dateStr}.csv"`);
    
    // OPTIMIZED: Stream handling via chunking for heavy exports.
    // Instead of forcing Node to allocate a massive 50MB+ string in memory, we stream it directly to the socket.
    if (data && data.length > 2000) {
        const parserWithHeader = new Parser({ header: true });
        const parserNoHeader = new Parser({ header: false });
        
        // Write header and first chunk
        const firstChunk = data.slice(0, 1000);
        reply.raw.write(parserWithHeader.parse(firstChunk) + '\n');
        
        // Write remaining chunks directly to raw TCP socket stream
        for (let i = 1000; i < data.length; i += 1000) {
            const chunk = data.slice(i, i + 1000);
            reply.raw.write(parserNoHeader.parse(chunk) + '\n');
        }
        
        reply.raw.end();
        return reply;
    } else {
        const csv = new Parser().parse(data || []);
        return reply.send(csv);
    }
};
