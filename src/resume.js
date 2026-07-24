const axios = require('axios');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { extractTextFromResume } = require('./resume-parser');

async function parseResumeToRules(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Resume file not found at: ${filePath}`);
  }

  const resumeText = await extractTextFromResume(filePath);
  if (!resumeText) {
    throw new Error('Could not extract text content from the resume file.');
  }

  if (!config.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is missing in configurations.');
  }

  console.log(`🧠 Analyzing resume "${path.basename(filePath)}" using Gemini...`);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${config.GEMINI_API_KEY}`;

  const promptText = [
    'You are an expert career consultant. Analyze the candidate\'s resume text below and generate optimized job search queries and matching filters for Upwork.',
    '',
    'Resume Content:',
    resumeText,
    '',
    'Strict Output Guidelines:',
    '1. Return ONLY a valid JSON object matching the exact structure below. Do not wrap the JSON in markdown code blocks like ```json ... ```. Do not add any text before or after the JSON.',
    '2. The output structure must be:',
    '{',
    '  "freelancer_name": "the candidate\'s full name extracted from the resume, e.g., \'Himanshu Vashishtha\'",',
    '  "search_queries": [ "top 5-9 highly relevant, search-optimized search terms to search on Upwork, lowercase and brief, e.g., \'react developer\', \'node.js developer\'" ],',
    '  "target_keywords": [ "top 15-20 specific programming languages, frameworks, libraries, databases, and concepts found in the resume, e.g., \'react\', \'node\', \'express\', \'typescript\', \'stripe\'" ],',
    '  "ignore_keywords": [ "standard noise keywords to filter out mismatching jobs, e.g., \'wordpress\', \'php\', \'shopify\', \'unpaid\', \'equity\'" ],',
    '  "min_budget": 500',
    '}',
    '3. Search queries must be optimized for Upwork search (short, standard phrases). Target keywords should match the candidate\'s actual skillset.',
  ].join('\n');

  let response;
  let attempts = 0;
  const maxAttempts = 3;
  const delay = ms => new Promise(r => setTimeout(r, ms));

  while (attempts < maxAttempts) {
    try {
      response = await axios.post(url, {
        contents: [{
          parts: [{ text: promptText }]
        }]
      }, {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 30000
      });
      break;
    } catch (err) {
      attempts++;
      if (err.response && err.response.status === 429 && attempts < maxAttempts) {
        console.warn(`⚠️ Rate limited (429). Retrying in 10 seconds... (Attempt ${attempts}/${maxAttempts})`);
        await delay(10000);
      } else {
        throw err;
      }
    }
  }

  const candidates = response.data && response.data.candidates;
  if (candidates && candidates.length > 0) {
    let text = candidates[0].content && candidates[0].content.parts && candidates[0].content.parts[0].text;
    if (text) {
      text = text.trim();
      if (text.startsWith('```')) {
        text = text.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
      }
      return JSON.parse(text);
    }
  }

  throw new Error('Gemini API returned an invalid response format.');
}

async function generateRulesFromResume() {
  const { getResumeFile } = require('./resume-parser');
  const filePath = getResumeFile();
  if (!filePath) {
    console.log('⚠️ Skipping rules auto-generation. Default rules.json will be used.');
    return false;
  }

  const stats = fs.statSync(filePath);
  const cachePath = path.resolve(__dirname, '..', '.resume_cache.json');
  
  let cache = {};
  if (fs.existsSync(cachePath)) {
    try {
      cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    } catch {}
  }

  const currentModifiedTime = stats.mtimeMs;
  const currentSize = stats.size;

  const rulesPath = path.resolve(__dirname, '..', 'rules.json');
  let hasName = false;
  if (fs.existsSync(rulesPath)) {
    try {
      const rulesObj = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
      if (rulesObj.freelancer_name) {
        hasName = true;
      }
    } catch {}
  }

  if (cache.last_modified === currentModifiedTime && cache.size === currentSize && hasName) {
    console.log('📄 Resume file is unchanged and freelancer name exists. Skipping rules regeneration.');
    return false;
  }

  try {
    const rules = await parseResumeToRules(filePath);
    fs.writeFileSync(rulesPath, JSON.stringify(rules, null, 2), 'utf8');

    fs.writeFileSync(cachePath, JSON.stringify({
      last_modified: currentModifiedTime,
      size: currentSize
    }), 'utf8');

    console.log('✅ rules.json successfully updated based on your resume!');
    return true;
  } catch (err) {
    console.error('❌ Failed to generate rules from resume:', err.message);
    return false;
  }
}

module.exports = { generateRulesFromResume, parseResumeToRules };
