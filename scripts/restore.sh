#!/usr/bin/env bash
# Restore user-map from backup
set -e

DATA_DIR="${DATA_DIR:-./data}"
BACKUP_PATH="$1"

if [ -z "$BACKUP_PATH" ]; then
  echo "Usage: $0 <backup-file.db>"
  echo "Available backups:"
  ls -la "${DATA_DIR}/backups/"users_*.db 2>/dev/null || echo "  No backups found."
  exit 1
fi

if [ ! -f "$BACKUP_PATH" ]; then
  echo "Error: File not found: $BACKUP_PATH"
  exit 1
fi

TARGET_DB="${DATA_DIR}/users.db"
cp "$BACKUP_PATH" "$TARGET_DB"
echo "Restored from: $BACKUP_PATH -> $TARGET_DB"
