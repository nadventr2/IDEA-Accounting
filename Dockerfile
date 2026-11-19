FROM node:20-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /data/uploads /data/backups
ENV PORT=3003 HOST=0.0.0.0 \
    DATABASE_PATH=/data/accounting.db \
    UPLOAD_DIR=/data/uploads \
    BACKUP_DIR=/data/backups
EXPOSE 3003
CMD ["node", "server/server_new.js"]
