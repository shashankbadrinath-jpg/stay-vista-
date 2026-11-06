FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
ENV npm_config_nodedir=/usr/local
RUN npm ci --omit=dev
COPY . .
ENV DATA_DIR=/data NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/server.js"]
