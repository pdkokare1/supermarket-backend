/* jobs/backupCron.js */

const cron = require('node-cron');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

module.exports = function(fastify) {
    cron.schedule('0 3 * * 0', async () => {
        if (!process.env.BACKUP_EMAIL || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
            fastify.log.warn('[SECURITY] Backup Cron: Email configuration missing. Skipping automated backup.');
            return;
        }

        fastify.log.info('[SECURITY] Starting automated Cloud Database Backup...');
        
        const fileName = `DailyPick_Backup_${new Date().toISOString().split('T')[0]}.json`;
        const filePath = path.join(__dirname, `../${fileName}`);
        
        try {
            const fileStream = fs.createWriteStream(filePath);
            fileStream.write('{\n');
            
            const collections = await mongoose.connection.db.listCollections().toArray();
            
            for (let i = 0; i < collections.length; i++) {
                const colName = collections[i].name;
                fileStream.write(`  "${colName}": [\n`);
                
                const cursor = mongoose.connection.db.collection(colName).find({});
                let isFirstDoc = true;
                
                for await (const doc of cursor) {
                    if (!isFirstDoc) fileStream.write(',\n');
                    fileStream.write(`    ${JSON.stringify(doc)}`);
                    isFirstDoc = false;
                }
                
                fileStream.write('\n  ]');
                if (i < collections.length - 1) fileStream.write(',');
                fileStream.write('\n');
            }
            fileStream.write('}\n');
            fileStream.end();

            await new Promise(resolve => fileStream.on('finish', resolve));

            const transporter = nodemailer.createTransport({
                service: 'gmail', 
                auth: {
                    user: process.env.SMTP_USER,
                    pass: process.env.SMTP_PASS
                }
            });

            await transporter.sendMail({
                from: `"DailyPick Security Watchdog" <${process.env.SMTP_USER}>`,
                to: process.env.BACKUP_EMAIL,
                subject: `🔒 Automated Database Backup - ${new Date().toLocaleDateString()}`,
                text: 'Attached is the automated weekly secure backup of your entire MongoDB database. Keep this file safe.',
                attachments: [{ filename: fileName, path: filePath }]
            });

            fastify.log.info('[SECURITY] Automated backup completed and emailed securely.');

        } catch (error) {
            fastify.log.error('[SECURITY] Backup Cron Error:', error);
        } finally {
            // OPTIMIZATION: Guaranteed cleanup prevents server disk space exhaustion
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath); 
            }
        }
    });
};
