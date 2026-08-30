#!/bin/sh
set -eu

repository_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
docker compose -f "$repository_dir/compose.demo.yaml" exec -T api env DEMO_RESET_IF_EMPTY=false npm run demo:reset
printf '%s\n' 'Demo reset complete. Reload http://localhost:4000 before the next rehearsal.'
