const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');

// Polyfill missing browser globals to prevent PDF.js backend crashes in modern Node environments
if (typeof global.DOMMatrix === 'undefined') {
  global.DOMMatrix = class DOMMatrix {};
}
if (typeof global.ImageData === 'undefined') {
  global.ImageData = class ImageData {};
}
if (typeof global.Path2D === 'undefined') {
  global.Path2D = class Path2D {};
}

function getResumeFile() {
  const rootDir = path.resolve(__dirname, '..');
  const files = fs.readdirSync(rootDir);
  const supportedExtensions = ['.pdf', '.docx', '.txt'];

  // Find the first file that contains 'resume' or 'cv' in its name and has a supported extension
  const resumeFile = files.find(file => {
    const ext = path.extname(file).toLowerCase();
    if (!supportedExtensions.includes(ext)) return false;

    const name = path.basename(file, ext).toLowerCase();
    return name.includes('resume') || name.includes('cv') || name === 'profile';
  });

  return resumeFile ? path.join(rootDir, resumeFile) : null;
}

async function extractTextFromResume(filePath) {
  const activePath = filePath || getResumeFile();
  if (!activePath) {
    console.log('📝 No resume or CV file (.txt, .pdf, or .docx) found.');
    return null;
  }

  const ext = path.extname(activePath).toLowerCase();
  console.log(`📄 Found resume file: ${path.basename(activePath)} (${ext.toUpperCase()})`);

  try {
    if (ext === '.txt') {
      return fs.readFileSync(activePath, 'utf8').trim();
    } else if (ext === '.pdf') {
      const dataBuffer = fs.readFileSync(activePath);
      const { PDFParse } = require('pdf-parse');
      const parser = new PDFParse(new Uint8Array(dataBuffer));
      const data = await parser.getText();
      return data.text.trim();
    } else if (ext === '.docx') {
      const result = await mammoth.extractRawText({ path: activePath });
      return result.value.trim();
    } else {
      console.warn(`⚠️ Unsupported resume format: ${ext}. Please use PDF, DOCX, or TXT.`);
      return null;
    }
  } catch (err) {
    console.error(`❌ Failed to extract text from resume:`, err.message);
    return null;
  }
}

module.exports = { extractTextFromResume, getResumeFile };
