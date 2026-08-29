#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
database_dir=$(dirname "$script_dir")
database_url=${DATABASE_URL:-postgresql://nextwave:nextwave_dev@localhost:5432/nextwave}

psql "$database_url" -v ON_ERROR_STOP=1 -X -f "$database_dir/seeds/demo.sql"
