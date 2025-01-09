#!/usr/bin/env bash

figlet "Soketi"
echo -e "Version 1.1.0\n"
echo -e "Originally by https://github.com/soketi/soketi \n"
echo "Version Built by Phillarmonic Software https://github.com/phillarmonic/soketi"

echo "Starting up..."
exec node /app/bin/server.js start
