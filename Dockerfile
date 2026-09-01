FROM node:20-alpine
RUN apk add --no-cache docker-cli docker-cli-compose git openssh-client
WORKDIR /app
COPY server.js index.html labels.json star.svg ./
ENV PORT=80 DOCKER_SOCKET=/var/run/docker.sock DATA_DIR=/data
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "require('http').get('http://127.0.0.1/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
CMD ["node", "server.js"]
