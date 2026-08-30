FROM node:20-alpine
WORKDIR /app
COPY server.js index.html labels.json star.svg ./
ENV PORT=80 DOCKER_SOCKET=/var/run/docker.sock
EXPOSE 80
CMD ["node", "server.js"]
