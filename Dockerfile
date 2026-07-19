FROM mcr.microsoft.com/devcontainers/javascript-node:24-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vitest.config.ts ./
COPY config ./config
COPY scripts ./scripts
COPY src ./src
COPY public ./public
RUN npm run build && npm prune --omit=dev

FROM mcr.microsoft.com/devcontainers/javascript-node:24-bookworm AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN mkdir -p /data /workspaces && chown node:node /data /workspaces
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./package.json
USER node
EXPOSE 3000 4001
CMD ["npm", "start"]
