# Dockerfile for Railway deployment - using node:22-slim for smaller size
FROM node:22-slim

WORKDIR /app

# Copy package files and install production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts 2>&1 | tail -20

# Copy source code
COPY . .

# Expose port
EXPOSE 3001

# Start the server
CMD ["node", "server.js"]