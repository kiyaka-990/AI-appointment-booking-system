# Production image for the appointment booking workflow.
# Node 24 ships node:sqlite, so there are still no dependencies to install.
FROM node:24-alpine AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATABASE_PATH=/data/booking.db

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY public ./public
COPY config ./config
COPY prompts ./prompts
COPY scripts ./scripts

RUN mkdir -p /data && chown -R node:node /app /data
USER node

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
