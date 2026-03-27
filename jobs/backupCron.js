/* jobs/backupCron.js */

const cron = require('node-cron');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

module.exports = function(fastify) {
    // Schedule: Runs every Sunday at 3:00 AM Server Time
    cron.schedule('0 3 * * 0', async () => {
        if (!process.env.BACKUP_EMAIL || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
            fastify.log.warn('[SECURITY] Backup Cron: Email configuration missing. Skipping automated backup.');
            return;
        }

        fastify.log.info('[SECURITY] Starting automated Cloud Database Backup...');
        
        try {
            // 1. Extract all collections dynamically
            const collections = await mongoose.connection.db.listCollections().toArray();
            const backupData = {};

            for (let col of collections) {
                const data = await mongoose.connection.db.collection(col.name).find({}).toArray();
                backupData[col.name] = data;
            }

            // 2. Write to temporary local JSON file
            const backupString = JSON.stringify(backupData, null, 2);
            const fileName = `DailyPick_Backup_${new Date().toISOString().split('T')[0]}.json`;
            const filePath = path.join(__dirname, `../${fileName}`);
            fs.writeFileSync(filePath, backupString);

            // 3. Configure Email Transport
            const transporter = nodemailer.createTransport({
                service: 'gmail', // Defaulting to Gmail, change if using AWS SES/SendGrid
                auth: {
                    user: process.env.SMTP_USER,
                    pass: process.env.SMTP_PASS
                }
            });

            // 4. Send Email with Attachment
            await transporter.sendMail({
                from: `"DailyPick Security Watchdog" <${process.env.SMTP_USER}>`,
                to: process.env.BACKUP_EMAIL,
                subject: `🔒 Automated Database Backup - ${new Date().toLocaleDateString()}`,
                text: 'Attached is the automated weekly secure backup of your entire MongoDB database. Keep this file safe.',
                attachments: [
                    {
                        filename: fileName,
                        path: filePath
                    }
                ]
            });

            // 5. Clean up local file to save disk space
            fs.unlinkSync(filePath); 
            fastify.log.info('[SECURITY] Automated backup completed and emailed securely.');

        } catch (error) {
            fastify.log.error('[SECURITY] Backup Cron Error:', error);
        }
    });
};
