const EventEmitter = require('events');

class AuthSignals extends EventEmitter {}

// Singleton instance to pass messages between scraper run loop and Telegram polling thread
const authSignals = new AuthSignals();

module.exports = authSignals;
