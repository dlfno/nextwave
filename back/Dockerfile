FROM node:22-bookworm-slim AS build
WORKDIR /app/back
COPY back/package*.json ./
RUN npm ci
COPY back/ ./
RUN npm run build

FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client && rm -rf /var/lib/apt/lists/*
WORKDIR /app/back
ENV NODE_ENV=production
COPY back/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/back/dist ./dist
COPY database /app/database
COPY back/docker-entrypoint.sh ./docker-entrypoint.sh
COPY back/nubevia-entrypoint.sh ./nubevia-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh ./nubevia-entrypoint.sh
EXPOSE 3000 3100
CMD ["./docker-entrypoint.sh"]
