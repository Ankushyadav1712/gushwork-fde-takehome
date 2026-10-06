# Callback in one small container. SQLite lives at DB_PATH; mount a volume at /data to keep it.
FROM node:25-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY shared ./shared
COPY public ./public
ENV PORT=3000 DB_PATH=/data/callback.db
EXPOSE 3000
CMD ["node", "server/index.js"]
