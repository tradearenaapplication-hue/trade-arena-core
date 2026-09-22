# Dockerfile for Railway deployment - minimal with pre-built node_modules
FROM node:22-alpine

WORKDIR /app

# Install pnpm globally
RUN npm install -g pnpm@9.12.0

# Copy only package files first for better caching
COPY package.json pnpm-lock.yaml ./

# Install only production dependencies (faster, smaller)
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# Copy source code
COPY . .

# Expose port
EXPOSE 3001

# Start the server
CMD ["node", "server.js"]