# ---- Build stage ----------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ---- Production stage ------------------------------------------------------
FROM node:20-alpine AS production
WORKDIR /app
ENV NODE_ENV=production

# Install only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Bring in the compiled JS from the build stage (no source/TS in the final image)
COPY --from=build /app/dist ./dist

EXPOSE 3001

# Uses the built-in /health route (see src/index.ts)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- "http://localhost:${PORT:-3001}/health" || exit 1

USER node
CMD ["node", "dist/index.js"]
