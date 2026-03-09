FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.mjs instrumentation.mjs ./

ENV NODE_ENV=production
ENV PORT=3100

EXPOSE 3100

CMD ["node", "--import", "./instrumentation.mjs", "server.mjs"]
