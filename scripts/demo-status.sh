#!/bin/sh
set -eu

base_url=${NEXTWAVE_DEMO_URL:-http://localhost:4000}
printf 'Liveness: '
curl --fail --silent --show-error "$base_url/health"
printf '\nReadiness: '
curl --fail --silent --show-error "$base_url/ready"
printf '\n'
