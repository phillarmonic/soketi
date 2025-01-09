ARG VERSION=18

FROM --platform=$BUILDPLATFORM node:$VERSION-alpine AS build
RUN apk add --no-cache --update git python3 py3-pip py3-setuptools gcompat bash curl && \
    apk add --virtual build-dependencies build-base gcc wget && \
    ln -sf python3 /usr/bin/python

RUN curl -fsSL https://get.pnpm.io/install.sh | ENV="$HOME/.bashrc" SHELL="$(which bash)" sh - \
    && ln -s /root/.local/share/pnpm/pnpm /usr/local/bin/pnpm

# Shell configuration
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV PYTHONUNBUFFERED=1

COPY . /tmp/build

WORKDIR /tmp/build

RUN set -e ; \
    pnpm install; \
    pnpm ci ; \
    pnpm run build ; \
    pnpm ci --omit=dev --ignore-scripts ; \
    pnpm prune --production ; \
    rm -rf node_modules/*/test/ node_modules/*/tests/ ; \
    pnpm install -g modclean ; \
    modclean -n default:safe --run ; \
    mkdir -p /app ; \
    cp -r bin/ dist/ node_modules/ LICENSE package.json package-lock.json README.md /app/


FROM node:$VERSION-alpine
ARG TARGETPLATFORM

RUN apk add --no-cache --update libc6-compat gcompat bash

# Shell configuration
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN if [ -e /lib/ld-linux-x86-64.so.2 ]; then rm -f /lib/ld-linux-x86-64.so.2; fi; \
    ln -s /lib/libc.musl-x86_64.so.1 /lib/ld-linux-x86-64.so.2


COPY --from=build /app /app

WORKDIR /app

EXPOSE 6001

ENTRYPOINT ["node", "/app/bin/server.js", "start"]
