FROM node:20-alpine

WORKDIR /app

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy package files
COPY package.json pnpm-lock.yaml* ./

# Install dependencies
RUN pnpm install --frozen-lockfile || pnpm install || npm install

# Copy application source
COPY . .

# Expose default server port
EXPOSE 3001

# Start the Express server
CMD ["node", "server.js"]
