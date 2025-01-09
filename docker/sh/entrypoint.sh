#!/usr/bin/env bash

figlet "Soketi"
echo -e "Version 1.1.0\n"
echo -e "Originally by https://github.com/soketi/soketi \n"
echo "Version Built by Phillarmonic Software https://github.com/phillarmonic/soketi"

echo "Starting up..."

if [ "$SOKETI_BREAKPOINT_DEBUG" = "true" ]; then
    echo "Starting in debug mode..."
    exec node --inspect=0.0.0.0:9929 /app/bin/server.js start
else
    exec node /app/bin/server.js start
fi
