FROM node:26-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5
ARG DEPLOYMENT_REVISION=""
ENV DEPLOYMENT_REVISION=$DEPLOYMENT_REVISION
# The server needs no package manager; dropping npm keeps its bundled dependencies out of the scan.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
COPY server.mjs ./
EXPOSE 3000
CMD ["node", "server.mjs"]
