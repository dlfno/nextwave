#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
database_dir=$(dirname "$script_dir")
database_url=${DATABASE_URL:-postgresql://nextwave:nextwave_dev@localhost:5432/nextwave}

psql "$database_url" -v ON_ERROR_STOP=1 -X -q -c \
  'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'

for migration in "$database_dir"/migrations/*.sql; do
  name=$(basename "$migration")
  applied=$(psql "$database_url" -X -A -t -q \
    -c "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE name = '$name')")

  if [ "$applied" = "t" ]; then
    echo "skip $name"
    continue
  fi

  echo "apply $name"
  psql "$database_url" -v ON_ERROR_STOP=1 -X -f "$migration"
done
