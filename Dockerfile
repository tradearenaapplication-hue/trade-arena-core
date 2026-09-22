# Dockerfile for Railway - ultra minimal
FROM node:22-alpine

WORKDIR /app

# Copy package files and install
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts 2>&1 | tail -5

# Copy source
COPY . .

# Expose
EXPOSE 3001

# Start
CMD ["node", "server.js"]