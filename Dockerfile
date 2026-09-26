FROM node:22-alpine

WORKDIR /app

# Copy package files first so the dependency layer is cached.
# Uses npm (package-lock.json is committed) rather than pnpm: there is no
# pnpm-lock.yaml in this repo, and mixing package managers made installs
# non-reproducible between local and Railway.
COPY package.json package-lock.json ./

# Install production dependencies only.
RUN npm ci --omit=dev --ignore-scripts

# Copy application source
COPY . .

# Set environment variables
ENV NODE_ENV=production
ENV HOST=0.0.0.0

# Railway injects PORT at runtime; default only if unset.
ENV PORT=3001

# Expose default server port
EXPOSE 3001

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S trader -u 1001 -G nodejs && \
    chown -R trader:nodejs /app

# Health check endpoint
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "const http = require('http'); http.get('http://localhost:'+(process.env.PORT||3001)+'/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"

USER trader

# Start the Express server. server.js serves the repo-root index.html at "/".
CMD ["node", "server.js"]
