#!/usr/bin/env bash
# Starts a disposable local PostgreSQL (16+) for `npm run test:db`. No Supabase or Docker needed:
# tests/db/setup.ts loads a small Supabase-compatible shim (roles, auth.uid()) before the migrations.
set -euo pipefail
PGBIN="${PGBIN:-$(dirname "$(command -v initdb 2>/dev/null || echo /usr/lib/postgresql/16/bin/initdb)")}"
DATA="${PGDATA_DIR:-.pgdata}"
PORT="${PGPORT:-54329}"
if [ ! -d "$DATA" ]; then "$PGBIN/initdb" -D "$DATA" -U postgres --auth=trust >/dev/null; fi
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$DATA/log" start
echo "Test database server running on socket /tmp port $PORT. Run: npm run test:db"
