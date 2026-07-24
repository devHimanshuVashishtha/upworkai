const imaps = require('imap-simple');
const simpleParser = require('mailparser').simpleParser;
const cheerio = require('cheerio');
const axios = require('axios');

// 1. Gmail Connection Settings
const config = {
    imap: {
        user: 'himanshuvashishtha001.hp@gmail.com',
        password: 'eaeu zouc xkph wece', // KEEP THIS PRIVATE ON YOUR MACHINE
        host: 'imap.gmail.com',
        port: 993,
        tls: true,
        tlsOptions: { rejectUnauthorized: false },
        authTimeout: 3000
    }
};

// 2. Telegram Bot Settings
const TELEGRAM_TOKEN = '8576672177:AAGKj3NheEgtqYKXGhITF8FJT2mK-4-DpPY'; // KEEP THIS PRIVATE ON YOUR MACHINE
const CHAT_ID = '1246929441';

async function checkUpworkEmails() {
    console.log('🤖 Bot connecting to Gmail...');

    try {
        const connection = await imaps.connect(config);
        console.log('✅ Successfully connected to inbox!');

        await connection.openBox('INBOX');

        // 3. Search Criteria & Fetch Options
        const searchCriteria = ['UNSEEN', ['FROM', 'donotreply@upwork.com']];
        // CHANGED: markSeen is set to true so you don't get duplicate alerts every 5 minutes!
        const fetchOptions = { bodies: [''], markSeen: true };

        const messages = await connection.search(searchCriteria, fetchOptions);

        if (messages.length === 0) {
            console.log('📭 No new Upwork emails found right now.');
            connection.end();
            return;
        }

        console.log(`🎉 Found ${messages.length} new alerts! Processing...`);

        for (let item of messages) {
            const rawPart = item.parts.find(part => part.which === '');
            if (!rawPart || !rawPart.body) continue;

            const mail = await simpleParser(rawPart.body);

            console.log('\n==================================');
            console.log(`📩 Subject: ${mail.subject}`);

            // 4. Cheerio HTML Parsing & Smart Filtering
            if (mail.html) {
                console.log('🔍 Loading HTML into Cheerio...');
                const $ = cheerio.load(mail.html);

                // Extract all plain text from the email body for keyword analysis
                const emailText = $('body').text().toLowerCase();

                // Define the core skills you care about
                const targetSkills = ['mern', 'react', 'node', 'full stack', 'mongodb', 'express'];

                // Smart Filter: Check if the email mentions at least one of your target stacks
                const isMatch = targetSkills.some(skill => emailText.includes(skill));

                if (!isMatch) {
                    console.log('🗑️ Job skipped: Does not match MERN/Full Stack criteria.');
                    console.log('==================================\n');
                    continue;
                }

                console.log('🎯 Match found! Extracting job links...');
                const links = $('a').toArray();

                for (const element of links) {
                    const linkText = $(element).text().trim();
                    const linkHref = $(element).attr('href');

                    if (linkHref && linkHref.includes('/jobs/')) {
                        console.log(`\n💼 Job Found: ${linkText}`);
                        console.log(`🔗 Link: ${linkHref}`);

                        // 5. Telegram Webhook Delivery
                        if (TELEGRAM_TOKEN !== 'YOUR_SECRET_TELEGRAM_TOKEN') {
                            const telegramUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;

                            const payload = {
                                chat_id: CHAT_ID,
                                text: `🚨 *New MERN Stack Job Match!*\n\n*Apply Here:* [Click to view Job](${linkHref})`,
                                parse_mode: 'Markdown'
                            };

                            try {
                                console.log('🚀 Firing Telegram message...');
                                await axios.post(telegramUrl, payload);
                                console.log('✅ Successfully sent to Telegram!');
                            } catch (err) {
                                console.error('❌ Failed to send Telegram message:', err.message);
                            }
                        } else {
                            console.log('⚠️ Telegram skipped: Add your live token at the top of the file.');
                        }
                    }
                }
            } else {
                console.log('❌ No HTML found in this email.');
            }
            console.log('==================================\n');
        }

        connection.end();
        console.log('💤 Bot disconnecting from Gmail.');

    } catch (error) {
        console.error('😢 The bot bumped into an error:', error);
    }
}

// Start the daemon loop
checkUpworkEmails();

const CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes

setInterval(() => {
    const time = new Date().toLocaleTimeString();
    console.log(`\n⏳ [${time}] Waking up to check for new Upwork jobs...`);
    checkUpworkEmails();
}, CHECK_INTERVAL);