const axios = require('axios');
const config = require('./config');
const { extractTextFromResume } = require('./resume-parser');

async function generateProposal(jobTitle, jobDescription, freelancerName = '') {
  if (!config.GEMINI_API_KEY) {
    console.log('⚠️ GEMINI_API_KEY is missing in configuration. Skipping proposal generation.');
    return '';
  }

  const resumeText = await extractTextFromResume();
  const hasResume = !!resumeText;

  console.log(`🤖 Generating AI proposal for job: "${jobTitle}"...`);

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${config.GEMINI_API_KEY}`;

    const hasName = freelancerName && freelancerName !== 'Unknown User';
    const signOffLine = hasName ? `Looking forward to connecting.\n\n${freelancerName}` : 'Looking forward to connecting.';

    // Build portfolio section for the prompt
    const portfolioLinks = config.PORTFOLIO_PROJECTS || [];
    const portfolioSection = portfolioLinks.length > 0
      ? `\nCandidate's Portfolio Projects (use ONLY these real links, pick the 2-3 most relevant to the job):\n${portfolioLinks.map((p, i) => `${i + 1}. ${p.name} - ${p.url}${p.description ? ' (' + p.description + ')' : ''}`).join('\n')}\n`
      : '';

    const promptText = [
      'You are an expert Full-Stack / AI freelancer writing a professional Upwork cover letter.',
      '',
      `Job Title: ${jobTitle}`,
      `Job Description:\n${jobDescription}`,
      '',
      hasResume ? `Candidate's Resume/Skillset Profile:\n${resumeText}` : '',
      portfolioSection,
      '',
      'PROPOSAL STRUCTURE (follow this exact order):',
      '',
      'PARAGRAPH 1 - OPENING HOOK (1-2 sentences):',
      '- Start with "Hey," on a new line.',
      '- In the VERY FIRST sentence after the greeting, state your relevant experience that directly matches THIS specific job. The client must immediately see that you have done similar work before.',
      '- Example tone: "I have already worked on similar [type] platforms involving [relevant tech/features]. I can help you in this project."',
      '',
      'PARAGRAPH 2 - RELEVANT PROJECTS (2-3 project links):',
      '- Write "Relevant Projects:" on a new line.',
      portfolioLinks.length > 0
        ? '- Pick the 2-3 projects from the provided portfolio list that are MOST relevant to this specific job. List each project link on its own line with just the URL.'
        : '- If no portfolio links are available, skip this section entirely.',
      '',
      'PARAGRAPH 3 - SKILLS & EXPERIENCE (brief bullet list):',
      '- Write "My experience includes:" on a new line.',
      '- List the candidate\'s key relevant tech skills in short lines (not full sentences), matching the job requirements.',
      '- Keep this section tight: 4-5 lines maximum.',
      '',
      'PARAGRAPH 4 - VALUE & APPROACH (1-2 sentences):',
      '- A brief statement about concrete, production-level experience that sets you apart (not generic claims).',
      '',
      'PARAGRAPH 5 - CLOSING & CALL TO ACTION (1-2 sentences):',
      '- Express availability and invite the client to discuss architecture/details.',
      `- Sign off with: "${signOffLine}"`,
      '',
      'STRICT RULES:',
      '1. PLAIN TEXT ONLY. No markdown, no asterisks, no bold, no headers, no bullet point characters. Use plain line breaks.',
      '2. ZERO emojis, icons, or pictographs anywhere.',
      '3. Do NOT fabricate any projects, links, or experience not provided in the resume or portfolio list.',
      '4. Do NOT use cliches: "Dear Hiring Manager", "I am a perfect fit", "I am writing to express my interest".',
      '5. Do NOT include any placeholders like [Link], [Project], [Name]. If information is missing, omit it.',
      '6. Keep the total proposal under 200 words.',
      '7. If the job description asks specific questions, answer them naturally inside the cover letter text.',
      '',
      '8. OUTPUT STRUCTURE: Start the output exactly with a "AI JOB SUMMARY:" header followed by 3-4 bullet points detailing the core requirements, deliverables, and required tech stack of the job. Immediately after the bullet points, write a line: "MATCH SCORE: XX%" (where XX is the estimated match percentage out of 100 based on how well the candidate\'s resume matches the job requirements). Then, write a "PROPOSAL:" divider on its own line. After this divider, write the actual cover letter/proposal following the structure above. Write everything in clean, standard PLAIN TEXT.',
    ].filter(Boolean).join('\n');

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
          timeout: 60000
        });
        break; // Success!
      } catch (err) {
        attempts++;
        const isTransient = err.message.includes('timeout') || 
                            err.code === 'ECONNABORTED' ||
                            (err.response && (err.response.status === 429 || err.response.status === 503 || err.response.status === 500));
        
        if (isTransient && attempts < maxAttempts) {
          const statusText = err.response ? `HTTP ${err.response.status}` : 'Timeout/Network Error';
          console.warn(`⚠️ Gemini request failed (${statusText}). Retrying in 10 seconds... (Attempt ${attempts}/${maxAttempts})`);
          await delay(10000);
        } else {
          throw err; // Fail if not a transient error or if all attempts are exhausted
        }
      }
    }

    // Parse the response
    const candidates = response.data && response.data.candidates;
    if (candidates && candidates.length > 0) {
      const text = candidates[0].content && candidates[0].content.parts && candidates[0].content.parts[0].text;
      if (text) {
        console.log('✅ Proposal successfully generated by Gemini AI!');
        const textVal = text.trim();
        const parts = textVal.split(/(?:📝\s*)?PROPOSAL:/i);
        const summary = parts[0].replace(/(?:📋\s*)?AI\s+JOB\s+SUMMARY:/i, '').trim();
        const proposal = parts[1] ? parts[1].trim() : textVal;

        const scoreMatch = summary.match(/(?:🎯\s*)?MATCH\s*SCORE:\s*(\d+%\s*)/i) || 
                           summary.match(/MATCH\s*SCORE:\s*(\d+%\s*)/i) ||
                           summary.match(/(\d+%\s*)/);
        const score = scoreMatch ? scoreMatch[1].trim() : 'Unknown';
        
        // Remove the score details line from the clean summary text to avoid duplication
        const summaryClean = summary.replace(/(?:🎯\s*)?MATCH\s*SCORE:\s*\d+%\s*/i, '')
                                    .replace(/MATCH\s*SCORE:\s*\d+%\s*/i, '')
                                    .replace(/\b\d+%\s*/i, '')
                                    .trim();

        return { summary: summaryClean, proposal, score };
      }
    }

    console.warn('⚠️ Gemini API response format invalid.');
    return { 
      summary: '⚠️ Proposal formatting error from Gemini response.', 
      proposal: '⚠️ GEMINI RESPONSE ERROR: Gemini API returned invalid text structure. Tap \'Edit with AI 🤖\' to retry.', 
      score: 'Unknown' 
    };
  } catch (err) {
    const errorText = formatGeminiErrorMessage(err);
    console.error('❌ Failed to generate proposal via Gemini:', errorText);

    const fallbackProposal = `⚠️ GEMINI AI LIMIT / API ERROR:
${errorText}

💡 You can tap 'Edit with AI 🤖' to retry generating or 'Edit Manually ✍️' to write your custom cover letter!`;

    return { 
      summary: '⚠️ Proposal generation paused due to Gemini API rate limit or server error.', 
      proposal: fallbackProposal, 
      score: 'Error' 
    };
  }
}

function formatGeminiErrorMessage(err) {
  const status = err.response ? err.response.status : '';
  const dataDesc = err.response && err.response.data && err.response.data.error ? err.response.data.error.message : '';

  if (status === 429 || (err.message && err.message.includes('429')) || (dataDesc && dataDesc.toLowerCase().includes('quota'))) {
    return '⚠️ Gemini API Rate Limit / Quota Exceeded (HTTP 429). Google API limit reached.';
  }
  if (status === 503 || (err.message && err.message.includes('503'))) {
    return '⚠️ Gemini API Service Overloaded / Temporarily Unavailable (HTTP 503).';
  }
  if (status === 400 || status === 403) {
    return `⚠️ Gemini API Key / Request Error (HTTP ${status}): ${dataDesc || err.message}`;
  }
  return `⚠️ Gemini API Error (${status || 'Network'}): ${dataDesc || err.message || 'Unknown Failure'}`;
}

async function rewriteProposal(originalProposal, jobDescription, instructions) {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${config.GEMINI_API_KEY}`;
    
    const promptText = [
      'You are an expert Upwork proposal writer. Rewrite the original cover letter/proposal based on the user\'s specific instructions.',
      '',
      `Job Description:\n${jobDescription}`,
      '',
      `Original Proposal:\n${originalProposal}`,
      '',
      `User Editing Instructions:\n${instructions}`,
      '',
      'Strict Guidelines:',
      '1. Apply the user instructions directly. Keep the tone professional, persuasive, and completely human.',
      '2. The output must be the cover letter ONLY. If the original proposal had a screening questions section at the bottom, preserve it or adapt it as needed, but do NOT add any conversational meta-text like "Here is your updated proposal".',
      '3. STRICT FORMATTING: Do NOT use any Markdown formatting syntax. Do NOT use asterisks like "**" or "__". Write the entire response in clean PLAIN TEXT.',
      '4. ZERO PLACEHOLDERS OR META-TEXT: Do NOT include any placeholders, bracketed text, templates, or instructions (like "[My Link]", "[Project name]", "[Name]"). Replace any missing links with actual text or omit them. Do NOT add any conversational meta-text (like "Here is the proposal:" or "Updated Proposal:"). Start the proposal section directly with the greeting/cover letter and end strictly with the sign-off.'
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
          headers: { 'Content-Type': 'application/json' },
          timeout: 60000
        });
        break; // Success!
      } catch (err) {
        attempts++;
        const isTransient = err.message.includes('timeout') || 
                            err.code === 'ECONNABORTED' ||
                            (err.response && (err.response.status === 429 || err.response.status === 503 || err.response.status === 500));
        
        if (isTransient && attempts < maxAttempts) {
          const statusText = err.response ? `HTTP ${err.response.status}` : 'Timeout/Network Error';
          console.warn(`⚠️ Gemini rewrite request failed (${statusText}). Retrying in 10 seconds... (Attempt ${attempts}/${maxAttempts})`);
          await delay(10000);
        } else {
          throw err;
        }
      }
    }

    const candidates = response.data && response.data.candidates;
    if (candidates && candidates.length > 0) {
      const text = candidates[0].content && candidates[0].content.parts && candidates[0].content.parts[0].text;
      if (text) {
        return text.trim();
      }
    }
    return '';
  } catch (err) {
    const errorText = formatGeminiErrorMessage(err);
    console.error('❌ Failed to rewrite proposal via Gemini:', errorText);
    throw new Error(errorText);
  }
}

async function generateScreeningAnswer(questionText, jobTitle, jobDescription) {
  if (!config.GEMINI_API_KEY) {
    return 'I have strong experience in this area and would be happy to discuss details.';
  }

  const resumeText = await extractTextFromResume().catch(() => '');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${config.GEMINI_API_KEY}`;
  
  const prompt = [
    `You are an expert full-stack freelancer applying to a job with this title: "${jobTitle}"`,
    `Job Description:`,
    jobDescription,
    ``,
    resumeText ? `Your Resume/Profile:\n${resumeText}` : '',
    ``,
    `The Upwork application has the following screening question:`,
    `"${questionText}"`,
    ``,
    `Write a direct, professional, and brief answer (1-3 sentences) to this question.`,
    `Do NOT fabricate any experience or projects not mentioned in the resume.`,
    `Write the response in clean, standard PLAIN TEXT (no markdown, no bold, no asterisks, no emojis).`
  ].filter(Boolean).join('\n');

  try {
    const response = await axios.post(url, {
      contents: [{ parts: [{ text: prompt }] }]
    }, { timeout: 30000 });

    const candidates = response.data && response.data.candidates;
    if (candidates && candidates.length > 0) {
      const text = candidates[0].content && candidates[0].content.parts && candidates[0].content.parts[0].text;
      if (text) {
        return text.replace(/\p{Extended_Pictographic}/gu, '').trim();
      }
    }
    return 'I have relevant experience in this area and would be happy to discuss details.';
  } catch (err) {
    console.warn(`⚠️ Failed to generate screening answer for "${questionText}":`, err.message);
    return 'I have relevant experience in this area and would be happy to discuss details.';
  }
}

module.exports = { generateProposal, rewriteProposal, generateScreeningAnswer };
