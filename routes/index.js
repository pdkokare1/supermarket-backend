/* routes/index.js */

const fs = require('fs');
const path = require('path');

async function apiRoutes(fastify, options) {
    // Dynamically read all files in the current directory asynchronously
    const routesDir = __dirname;
    const files = await fs.promises.readdir(routesDir);

    for (const file of files) {
        // Skip this index.js file and ensure it's a javascript file
        if (file !== 'index.js' && file.endsWith('.js')) {
            fastify.register(require(path.join(routesDir, file)));
        }
    }
}

module.exports = apiRoutes;
