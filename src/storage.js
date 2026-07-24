const fs = require('fs');
const config = require('./config');

let notifiedJobs = new Set();

function extractJobId(input) {
  if (!input) return '';
  // Upwork job IDs start with ~ followed by hexadecimal characters (e.g., ~01efc9b9de3a9e5888)
  const match = input.match(/~[0-9a-fA-F]+/);
  return match ? match[0] : input;
}

function load() {
  if (!fs.existsSync(config.NOTIFIED_JOBS_PATH)) return;

  try {
    const data = JSON.parse(fs.readFileSync(config.NOTIFIED_JOBS_PATH, 'utf8'));
    // Migrate old format URLs to pure Job IDs automatically
    const migrated = data.map(item => extractJobId(item)).filter(Boolean);
    notifiedJobs = new Set(migrated);
    console.log(`📦 Loaded ${notifiedJobs.size} unique job IDs from ${config.NOTIFIED_JOBS_PATH}`);
  } catch (e) {
    console.error('⚠️ Error reading notified_jobs.json:', e.message);
  }
}

function save() {
  try {
    let entries = Array.from(notifiedJobs);
    if (entries.length > config.LIMITS.MAX_NOTIFIED_JOBS) {
      entries = entries.slice(entries.length - config.LIMITS.MAX_NOTIFIED_JOBS);
      notifiedJobs = new Set(entries);
    }
    fs.writeFileSync(config.NOTIFIED_JOBS_PATH, JSON.stringify(entries, null, 2), 'utf8');
  } catch (e) {
    console.error('⚠️ Error saving notified_jobs.json:', e.message);
  }
}

function has(jobLink) {
  const jobId = extractJobId(jobLink);
  return notifiedJobs.has(jobId);
}

function add(jobLink) {
  const jobId = extractJobId(jobLink);
  if (jobId) {
    notifiedJobs.add(jobId);
  }
}

module.exports = { load, save, has, add };
