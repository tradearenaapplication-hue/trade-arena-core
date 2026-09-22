# Dockerfile for Railway deployment - using npm for faster builds
FROM node:22-alpine

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install dependencies with npm (faster than pnpm in Docker)
RUN npm ci --ignore-scripts

# Copy source code
COPY . .

# Build the React app
RUN npm run build

# Expose port
EXPOSE 3001

# Start the server
CMD ["node", "server.js"]