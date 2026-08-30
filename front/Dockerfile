FROM node:22-bookworm-slim AS build
WORKDIR /app/front
COPY front/package*.json ./
RUN npm ci
COPY front/ ./
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app/front
ENV NODE_ENV=production PORT=4000 API_BASE_URL=http://api:3000
COPY front/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/front/dist ./dist
EXPOSE 4000
CMD ["node", "dist/front/server/server.mjs"]
