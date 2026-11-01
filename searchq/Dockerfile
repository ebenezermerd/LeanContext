# The gateway has no runtime dependencies; Node strips the TypeScript types itself.
FROM node:24-alpine
WORKDIR /app
COPY src/gateway.ts ./src/gateway.ts
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/health >/dev/null || exit 1
CMD ["node", "src/gateway.ts"]
