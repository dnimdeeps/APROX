FROM oven/bun:latest

WORKDIR /app

# Install deps first (layer-cached — only re-runs when package files change)
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

# Copy server source
COPY . .

# Render injects PORT automatically — default 3001 for local dev
ENV PORT=3001
ENV NODE_ENV=production

EXPOSE 3001

CMD ["bun", "run", "index.ts"]
