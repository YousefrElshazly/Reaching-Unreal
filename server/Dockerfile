FROM node:20-alpine

WORKDIR /app

# Install deps using lockfile if present, fall back to npm install otherwise.
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY server.js ./

ENV NODE_ENV=production
ENV PORT=1234
ENV DATA_DIR=/data

VOLUME ["/data"]
EXPOSE 1234

CMD ["node", "server.js"]
