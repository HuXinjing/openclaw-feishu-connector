#!/usr/bin/env bash
# Backup user-map (SQLite) and user token store
set -e

DATA_DIR="${DATA_DIR:-./data}"
DB_PATH="${DATA_DIR}/users.db"
BACKUP_DIR="${DATA_DIR}/backups"

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Backup SQLite user-map
if [ -f "$DB_PATH" ]; then
  cp "$DB_PATH" "$BACKUP_DIR/users_${TIMESTAMP}.db"
  echo "Backup saved: $BACKUP_DIR/users_${TIMESTAMP}.db"
else
  echo "No SQLite DB found at $DB_PATH, skipping."
fi

# Also backup JSON if exists
if [ -f "${DATA_DIR}/users.json" ]; then
  cp "${DATA_DIR}/users.json" "$BACKUP_DIR/users_json_${TIMESTAMP}.json"
  echo "JSON backup saved: $BACKUP_DIR/users_json_${TIMESTAMP}.json"
fi

# Keep only last 30 backups
if [ -d "$BACKUP_DIR" ]; then
  ls -t "$BACKUP_DIR"/users_*.db 2>/dev/null | tail -n +31 | xargs rm -f 2>/dev/null || true
  ls -t "$BACKUP_DIR"/users_json_*.json 2>/dev/null | tail -n +31 | xargs rm -f 2>/dev/null || true
fi

echo "Backup complete."
