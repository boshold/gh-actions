FROM node:26-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80
ARG DEPLOYMENT_REVISION=""
ENV DEPLOYMENT_REVISION=$DEPLOYMENT_REVISION
# The server needs no package manager; dropping npm keeps its bundled dependencies out of the scan.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
COPY server.mjs ./
EXPOSE 3000
CMD ["node", "server.mjs"]
