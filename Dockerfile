FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY public ./public
COPY db ./db

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV DATABASE_PATH=/data/data.sqlite

RUN mkdir -p /data

EXPOSE 3000

CMD ["node", "server.js"]
