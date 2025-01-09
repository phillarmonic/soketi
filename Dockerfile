ARG VERSION=18

FROM --platform=$BUILDPLATFORM node:$VERSION-alpine AS build
RUN apk add --no-cache --update git python3 py3-pip py3-setuptools gcompat bash curl figlet && \
    apk add --virtual build-dependencies build-base gcc wget && \
    ln -sf python3 /usr/bin/python

# Shell configuration
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV PYTHONUNBUFFERED=1

COPY . /tmp/build

WORKDIR /tmp/build

RUN set -e ; \
    npm install; \
    npm ci; \
    npm run build ; \
    npm ci --omit=dev --ignore-scripts ; \
    npm prune --production ; \
    rm -rf node_modules/*/test/ node_modules/*/tests/ ; \
    npm install -g modclean ; \
    modclean -n default:safe --run ; \
    mkdir -p /app ; \
    cp -r bin/ dist/ node_modules/ LICENSE package.json package-lock.json README.md /app/


FROM node:$VERSION-alpine
ARG TARGETPLATFORM

RUN apk add --no-cache --update libc6-compat gcompat bash figlet

# Shell configuration
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN case "${TARGETPLATFORM}" in \
    "linux/amd64") \
        if [ -e /lib/ld-linux-x86-64.so.2 ]; then rm -f /lib/ld-linux-x86-64.so.2; fi; \
        ln -s /lib/libc.musl-x86_64.so.1 /lib/ld-linux-x86-64.so.2 \
        ;; \
    "linux/arm64") \
        if [ -e /lib/ld-linux-aarch64.so.1 ]; then rm -f /lib/ld-linux-aarch64.so.1; fi; \
        ln -s /lib/libc.musl-aarch64.so.1 /lib/ld-linux-aarch64.so.1 \
        ;; \
    "linux/arm/v7") \
        if [ -e /lib/ld-linux-armhf.so.3 ]; then rm -f /lib/ld-linux-armhf.so.3; fi; \
        ln -s /lib/libc.musl-armhf.so.1 /lib/ld-linux-armhf.so.3 \
        ;; \
    *) echo "Unsupported platform: ${TARGETPLATFORM}" && exit 1 ;; \
    esac


COPY --from=build /app /app

WORKDIR /app

EXPOSE 6001

COPY --chmod=0755 docker/sh/entrypoint.sh /usr/local/bin/soketi-entrypoint

ENTRYPOINT ["soketi-entrypoint"]
