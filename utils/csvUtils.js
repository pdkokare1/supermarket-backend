/* utils/csvUtils.js */

const { Parser } = require('json2csv');
const readline = require('readline'); // OPTIMIZATION: Added for memory-safe read streams

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

// ENTERPRISE OPTIMIZATION: Memory-Safe Bulk Processing (The "OOM CSV Import" Fix)
// Streams massive CSV uploads line-by-line instead of loading the entire file into V8 memory, preventing worker crashes.
exports.processCsvStream = async (fileStream, batchSize = 500, processBatchCallback) => {
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
    let headers = [];
    let batch = [];
    let isFirstLine = true;

    for await (const line of rl) {
        if (isFirstLine) {
            // Safely extract and clean headers
            headers = line.split(',').map(h => h.trim().replace(/^"|"$/g, ''));
            isFirstLine = false;
            continue;
        }
        
        const values = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
        if (values.length !== headers.length) continue; // Safely skip malformed rows
        
        let rowObj = {};
        headers.forEach((header, index) => {
            rowObj[header] = values[index];
        });
        batch.push(rowObj);

        if (batch.length >= batchSize) {
            await processBatchCallback([...batch]);
            batch = [];
            // Yield the event loop to prevent API freezing during massive imports
            await new Promise(resolve => setImmediate(resolve));
        }
    }
    
    if (batch.length > 0) {
        await processBatchCallback(batch);
    }
};
