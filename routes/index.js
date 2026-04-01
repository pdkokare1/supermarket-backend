/* routes/index.js */

const fs = require('fs');
const path = require('path');

function apiRoutes(fastify, options) {
    // Dynamically read all files in the current directory synchronously
    const routesDir = __dirname;
    const files = fs.readdirSync(routesDir);

    for (const file of files) {
        // Skip this index.js file and ensure it's a javascript file
        if (file !== 'index.js' && file.endsWith('.js')) {
            fastify.register(require(path.join(routesDir, file)));
        }
    }
}

module.exports = apiRoutes;
