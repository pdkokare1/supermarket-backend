/* config/logger.js */
'use strict';

const buildLoggerConfig = () => {
    const isProduction = process.env.NODE_ENV === 'production';
    
    if (isProduction) {
        return { 
            level: 'info',
            stream: require('pino').destination({ sync: false, minLength: 4096 }),
            redact: ['req.headers.authorization', 'req.headers.cookie'] 
        };
    }

    return {
        transport: {
            target: 'pino-pretty',
            options: {
                translateTime: 'HH:MM:ss Z',
                ignore: 'pid,hostname'
            }
        }
    };
};

module.exports = buildLoggerConfig();
