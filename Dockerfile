FROM node:24-alpine
LABEL org.opencontainers.image.title="Filmderr" \
      org.opencontainers.image.description="A movie night starts with a swipe. Self-hosted Radarr and Plex discovery." \
      org.opencontainers.image.source="https://github.com/FA9US/filmderr" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
COPY --chown=node:node package.json package-lock.json LICENSE THIRD_PARTY_NOTICES.md ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node licenses ./licenses
COPY --chown=node:node server ./server
COPY --chown=node:node public ./public
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3678 FILMDERR_DATA_DIR=/app/data
EXPOSE 3678
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:3678/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.mjs"]
