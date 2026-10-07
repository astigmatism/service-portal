FROM node:20-trixie-slim
# The portal image doubles as the default runner environment for project
# update scripts (git, docker CLI + compose) and as the image for the power
# monitor's GPU probe. The probe runs the GPU host's nvidia-smi inside a
# container of this image, and nvidia-smi is a glibc binary, so the base
# must be glibc-based — alpine (musl) cannot execute it. wget stays
# available because deployment update scripts that run in this image use it
# (busybox provided it on the old alpine base).
RUN set -eux; \
    echo 'exit 101' > /usr/sbin/policy-rc.d; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        docker-cli \
        docker-compose \
        git \
        openssh-client \
        wget; \
    rm -f /usr/sbin/policy-rc.d; \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && chmod -R a+rX node_modules
COPY server.js power-monitor.js wallpaper-images.js index.html labels.json star.svg ./
# Release archives may be extracted with a restrictive umask. Keep the files
# readable when a deployment runs the container as a non-root UID.
RUN chmod 644 package*.json server.js power-monitor.js wallpaper-images.js index.html labels.json star.svg
ENV PORT=80 DOCKER_SOCKET=/var/run/docker.sock DATA_DIR=/data
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "require('http').get('http://127.0.0.1/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
CMD ["node", "server.js"]
