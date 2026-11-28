# syntax=docker/dockerfile:1

FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json ./
COPY server/package.json server/package-lock.json ./server/
COPY dashboard/package.json dashboard/package-lock.json ./dashboard/

RUN npm --prefix server ci && npm --prefix dashboard ci

COPY server ./server
COPY dashboard ./dashboard

RUN npm run build

FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY server/package.json server/package-lock.json ./server/

RUN npm --prefix server ci --omit=dev && npm cache clean --force

COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/dashboard/dist ./dashboard/dist

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server/dist/index.js"]
