# Build the client, then ship a small runtime that serves it and the WebSocket
# from a single port — platforms only need to expose one.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server ./server
COPY forms ./forms
COPY tsconfig.json ./
# PORT is supplied by the platform; 8787 is the local default.
EXPOSE 8787
CMD ["npx", "tsx", "server/index.ts"]
