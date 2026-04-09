FROM node:22-alpine

# Install core runtime dependencies for media and documents
RUN apk add --no-cache \
    ffmpeg \
    ghostscript \
    python3 \
    curl \
    ca-certificates

# Securely install the latest yt-dlp release (standalone executable requires python3)
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

# Install npm production dependencies
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy application source
COPY . .

# Create non-root runtime user and writable data directories
RUN addgroup -S toolspage && adduser -S toolspage -G toolspage \
    && mkdir -p /data/outputs /app/data \
    && chown -R toolspage:toolspage /data /app

ENV NODE_ENV=production
ENV OUTPUT_LOCAL_DIR=/data/outputs
EXPOSE 8080

USER toolspage

CMD ["node", "server/index.js"]
