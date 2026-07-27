# Use official Playwright Chromium Node.js image with pre-installed browsers
FROM mcr.microsoft.com/playwright:v1.45.0-jammy

# Install unzip to allow Puppeteer chrome-headless-shell to extract successfully
RUN apt-get update && apt-get install -y unzip && rm -rf /var/lib/apt/lists/*

# Set container working directory
WORKDIR /usr/src/app

# Copy dependency manifests
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Install exact Chromium version matching Playwright package dependency
RUN npx playwright install chromium

# Copy application source code
COPY . .

# Set default headless mode to false for xvfb headful execution in cloud
ENV HEADLESS=false

# Expose debugging port if needed (internal use)
EXPOSE 9222

# Launch the orchestrator bot
CMD [ "npm", "start" ]
