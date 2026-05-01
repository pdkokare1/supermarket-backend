/* services/notificationService.js */

const nodemailer = require('nodemailer');
const jobsService = require('./jobsService');

// ==========================================
// --- FIRE-AND-FORGET QUEUE WRAPPERS ---
// ==========================================

exports.sendAdminEmail = async (fastify, subject, htmlContent, textContent) => {
    // DEPRECATION CONSULTATION: Awaiting Nodemailer blocks the main thread
    /*
    const transporter = nodemailer.createTransport({...});
    await transporter.sendMail(mailOptions);
    */
    
    // OPTIMIZATION: True Fire-and-Forget. Detaches from the main thread completely to prevent checkouts from failing if the queue drops.
    setImmediate(() => {
        jobsService.enqueueTask('EMAIL', { subject, htmlContent, textContent }).catch(e => {
            if (fastify && fastify.log) fastify.log.error('Email Queue Error:', e.message);
        });
    });
    return true;
};

exports.sendWhatsAppMessage = async (phone, messageText, fastify = null) => {
    // DEPRECATION CONSULTATION: Awaiting external fetch blocks the main thread
    /*
    const waUrl = ...
    await fetch(waUrl, { signal: controller.signal });
    */

    // OPTIMIZATION: True Fire-and-Forget dispatch.
    setImmediate(() => {
        jobsService.enqueueTask('WHATSAPP', { phone, messageText }).catch(e => {
            if (fastify && fastify.log) fastify.log.error('WA Queue Error:', e.message);
        });
    });
    return true;
};

exports.sendAdminWhatsApp = async (fastify, messageText) => {
    if (process.env.WA_PHONE_NUMBER) {
        return await exports.sendWhatsAppMessage(process.env.WA_PHONE_NUMBER, messageText, fastify);
    }
    return false;
};

// ==========================================
// --- BACKGROUND EXECUTORS ---
// ==========================================

exports.executeAdminEmail = async (fastify, subject, htmlContent, textContent, attachments = null) => {
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
            if (attachments) mailOptions.attachments = attachments;

            await transporter.sendMail(mailOptions);
            return true;
        } catch (emailErr) {
            if (fastify) fastify.log.error('Failed to send Admin Email:', emailErr);
            return false;
        }
    }
    return false;
};

exports.executeWhatsAppMessage = async (phone, messageText, fastify = null) => {
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

// ============================================================================
// --- MODIFIED: PHASE 28 VERNACULAR LOCALIZATION ENGINE ---
// ============================================================================
const originalSendWhatsAppPhase10 = exports.sendWhatsAppMessage;

exports.sendWhatsAppMessage = async (phone, messageText, fastify = null) => {
    try {
        const Customer = require('../models/Customer');
        const cust = await Customer.findOne({ phone }).lean();
        
        let finalMessage = messageText;

        // VERNACULAR TRANSLATION: Expand TAM by speaking the customer's language
        if (cust && cust.languagePreference) {
            const i18n = {
                'HI': {
                    'Order Received': 'ऑर्डर मिल गया',
                    'Dispatched': 'रवाना हो गया',
                    'Delivered': 'डिलीवर हो गया',
                    'Thanks for shopping': 'खरीदारी के लिए धन्यवाद'
                },
                'MR': {
                    'Order Received': 'ऑर्डर प्राप्त झाला',
                    'Dispatched': 'पाठवले आहे',
                    'Delivered': 'पोहोचवले आहे',
                    'Thanks for shopping': 'खरेदीबद्दल धन्यवाद'
                }
            };

            const dict = i18n[cust.languagePreference];
            if (dict) {
                // Highly performant string replacement for known templates
                for (const [eng, loc] of Object.entries(dict)) {
                    finalMessage = finalMessage.replace(eng, loc);
                }
            }
        }

        // Instantly offload to Redis to guarantee zero blocking on the checkout thread
        const cacheUtils = require('../utils/cacheUtils');
        const redisClient = cacheUtils.getClient();
        if (redisClient) {
            await redisClient.lpush('queue:notifications:whatsapp', JSON.stringify({
                phone,
                messageText: finalMessage,
                timestamp: Date.now()
            }));
            return true;
        }
    } catch (e) {
        if (fastify) fastify.log.warn('Redis queue unavailable, falling back to standard jobsService.');
    }
    
    // Fallback to legacy queue if Redis is temporarily unreachable
    return await originalSendWhatsAppPhase10(phone, messageText, fastify);
};
