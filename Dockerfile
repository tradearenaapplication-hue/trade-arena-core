FROM node:20-alpine

WORKDIR /app

<<<<<<< HEAD
# Install dependencies
COPY package*.json ./
RUN npm ci --production

# Copy application code
COPY . .

# Create necessary directories
RUN mkdir -p logs

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3001
ENV HOST=0.0.0.0

# Expose port
EXPOSE 3001

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs
RUN adduser -S trader -u 1001 -G nodejs
RUN chown -R trader:nodejs /app
USER trader

# Health check endpoint
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "const http = require('http'); http.get('http://localhost:3001/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"

# Start the application
CMD ["node", "server.js"]
=======
# Enable pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy package files
COPY package.json pnpm-lock.yaml* ./

# Install dependencies
RUN pnpm install --frozen-lockfile || pnpm install || npm install

# Copy application source
COPY . .

# Expose default server port
EXPOSE 3001

# Start the Express server
CMD ["node", "server.js"]
>>>>>>> bf749b26813ee921116b00ae8b1b9d78070a12ae
