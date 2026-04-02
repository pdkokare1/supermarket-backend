/* services/notificationService.js */

const nodemailer = require('nodemailer');

exports.sendAdminEmail = async (fastify, subject, htmlContent, textContent) => {
    if (process.env.EMAIL_USER && process.env.EMAIL_PASS && process.env.TARGET_EMAIL) {
        try {
            const transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
            });
            
            const mailOptions = {
                from: `"DailyPick Server" <${process.env.EMAIL_USER}>`,
                to: process.env.TARGET_EMAIL,
                subject: subject
            };
            
            if (htmlContent) mailOptions.html = htmlContent;
            if (textContent) mailOptions.text = textContent;

            await transporter.sendMail(mailOptions);
            return true;
        } catch (emailErr) {
            if (fastify) fastify.log.error('Failed to send Admin Email:', emailErr);
            return false;
        }
    }
    return false;
};

exports.sendWhatsAppMessage = async (phone, messageText, fastify = null) => {
    if (phone && phone.length >= 10 && process.env.CALLMEBOT_API_KEY) {
        try {
            const encodedText = encodeURIComponent(messageText);
            const waUrl = `https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${encodedText}&apikey=${process.env.CALLMEBOT_API_KEY}`;
            
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3000);
            await fetch(waUrl, { signal: controller.signal });
            clearTimeout(timeoutId);
            return true;
        } catch (waErr) {
            if (fastify) fastify.log.error('Failed to send WhatsApp:', waErr);
            return false;
        }
    }
    return false;
};

exports.sendAdminWhatsApp = async (fastify, messageText) => {
    if (process.env.WA_PHONE_NUMBER) {
        return await exports.sendWhatsAppMessage(process.env.WA_PHONE_NUMBER, messageText, fastify);
    }
    return false;
};
