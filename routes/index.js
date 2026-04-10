/* routes/index.js */

const fs = require('fs');
const path = require('path');

async function apiRoutes(fastify, options) {
    const routesDir = __dirname;
    const files = await fs.promises.readdir(routesDir);

    // MAINTAINABILITY: Centralized list of files to ignore during dynamic registration.
    const EXCLUDED_FILES = ['index.js', 'systemRoutes.js', 'migrateRoute.js'];

    for (const file of files) {
        // Registers all files ending in 'Routes.js' that are not in the exclusion list.
        if (file.endsWith('Routes.js') && !EXCLUDED_FILES.includes(file)) {
            fastify.register(require(path.join(routesDir, file)));
        }
    }
}

module.exports = apiRoutes;
