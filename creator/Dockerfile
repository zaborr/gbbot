# Build from the repository root:  docker build -f creator/Dockerfile .
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY creator/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY creator/src ./src
USER node
EXPOSE 3100
CMD ["node", "src/server.mjs"]
