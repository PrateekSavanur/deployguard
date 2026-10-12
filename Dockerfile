# Build stage — no native modules (SQLite comes from node:sqlite), so this is just a prod install
FROM node:24-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Runtime stage
FROM node:24-alpine

# tini for proper signal handling
RUN apk add --no-cache tini

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/
COPY public/ ./public/
COPY scripts/ ./scripts/

RUN mkdir -p /data \
    && addgroup -S -g 10001 deployguard && adduser -S -u 10001 -G deployguard deployguard \
    && chown -R deployguard:deployguard /data

USER deployguard

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/deployguard.db

EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
