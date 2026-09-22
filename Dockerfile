# Dockerfile for Railway deployment - use npm for faster installs
FROM node:22-alpine

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install production dependencies with npm (faster in Docker)
RUN npm ci --omit=dev --ignore-scripts --prefer-offline --no-audit --no-fund

# Copy source code
COPY . .

# Expose port
EXPOSE 3001

# Start the server
CMD ["node", "server.js"]