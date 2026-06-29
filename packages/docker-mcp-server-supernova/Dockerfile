FROM node:22-slim AS builder

WORKDIR /app

# Copy package files first for better layer caching
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Production stage
FROM node:22-slim

WORKDIR /app

# Copy package files and install production deps only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Copy built output
COPY --from=builder /app/dist/ ./dist/

# The server communicates via stdio (MCP transport)
# No EXPOSE needed — stdio transport doesn't listen on a port

ENTRYPOINT ["node", "dist/index.js"]
