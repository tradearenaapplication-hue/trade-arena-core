# Dockerfile for Railway deployment - simplified
FROM node:22-alpine

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm@9.12.0

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies only (skip build for now)
RUN pnpm install --frozen-lockfile --ignore-scripts

# Copy source code
COPY . .

# Expose port
EXPOSE 3001

# Start the server
CMD ["node", "server.js"]