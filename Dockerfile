FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY server.mjs upstream.mjs tenants.mjs shared.mjs canvas.mjs instrumentation.mjs ./

ENV NODE_ENV=production
ENV PORT=3100

EXPOSE 3100

CMD ["node", "--import", "./instrumentation.mjs", "server.mjs"]
