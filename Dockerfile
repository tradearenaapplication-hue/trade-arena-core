# Dockerfile for Railway deployment - minimal
FROM node:22-alpine

WORKDIR /app

# Copy package files and install only production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Copy source code
COPY . .

# Expose port
EXPOSE 3001

# Start the server
CMD ["node", "server.js"]