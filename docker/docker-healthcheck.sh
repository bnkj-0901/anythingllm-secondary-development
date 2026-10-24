#!/bin/bash

# Both processes are required for chat and document ingestion.
curl --fail --silent --max-time 4 --output /dev/null \
  "http://localhost:${SERVER_PORT:-3001}/api/ping" &&
curl --fail --silent --max-time 4 --output /dev/null \
  "http://localhost:${COLLECTOR_PORT:-8888}/health"
