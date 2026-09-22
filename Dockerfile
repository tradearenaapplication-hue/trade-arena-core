# Dockerfile for Railway deployment
FROM node:22-alpine

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm@9.12.0

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build the React app
RUN pnpm run build

# Expose port
EXPOSE 3001

# Start the server
CMD ["node", "server.js"]