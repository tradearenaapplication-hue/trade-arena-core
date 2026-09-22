# Dockerfile for Railway deployment - no build step needed (bundles pre-built)
FROM node:22-alpine

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install production dependencies only
RUN npm install -g pnpm@9.12.0 && pnpm install --frozen-lockfile --prod --ignore-scripts

# Copy source code
COPY . .

# Expose port
EXPOSE 3001

# Start the server
CMD ["node", "server.js"]