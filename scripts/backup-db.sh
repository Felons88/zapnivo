#!/usr/bin/env bash
# backup-db.sh — MANUAL, owner-run encrypted pg_dump for Zapnivo.
#
# STATUS: UNVERIFIED — this script has never been executed end-to-end and no
# restore from its output has ever succeeded. It is a documented starting
# point, not a proven backup. See docs/RECOVERY.md ("Independent backup
# strategy — UNVERIFIED").
#
# Why manual: pg_dump/pg_restore cannot run inside Vercel serverless. Run this
# from an operator machine or a scheduled job you control (cron, GitHub
# Action runner, etc.). NEVER run it with production write access beyond the
# read-only dump itself.
#
# Required env (set in YOUR shell / secrets manager — never commit values):
#   DATABASE_URL            Postgres connection string for the Supabase
#                           project (Dashboard → Project Settings → Database →
#                           Connection string; use the SESSION pooler or
#                           direct connection — NOT the app runtime env).
#   BACKUP_ENCRYPTION_KEY   Passphrase for symmetric encryption (age or gpg).
#                           MUST be separate from DEVICE_CREDENTIAL_KEK and
#                           every app secret — see docs/RECOVERY.md key
#                           separation rule. Store it in your password manager.
# Optional env:
#   BACKUP_DIR              Output directory (default: ./backups)
#   BACKUP_KEEP             Dumps to retain locally (default: 14; remote
#                           retention is enforced by bucket lifecycle rules)
#   BACKUP_S3_URI           Optional s3://bucket/prefix — upload via aws cli if
#                           set (bucket MUST be private; see docs/RECOVERY.md).
#
# Usage:
#   DATABASE_URL='postgres://...' BACKUP_ENCRYPTION_KEY='...' ./scripts/backup-db.sh
#
# After a successful run: verify the file decrypts (`age -d`/`gpg -d` to /dev/null
# or a scratch DB), then record nothing in-app — app-side recording is only for
# RESTORE TESTS (system_recovery_tests), not dumps.

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required (Supabase connection string — see header)}"
: "${BACKUP_ENCRYPTION_KEY:?BACKUP_ENCRYPTION_KEY is required (dedicated backup key — see docs/RECOVERY.md)}"

BACKUP_DIR="${BACKUP_DIR:-./backups}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/zapnivo-$STAMP.dump"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR" 2>/dev/null || true

echo "[backup-db] starting dump at $STAMP (public schema; auth schema NOT included — see docs/RECOVERY.md)"

# Public schema only. Custom-format dump is compressed + pg_restore-able.
# --no-owner --no-privileges keeps the dump portable across projects.
pg_dump "$DATABASE_URL" \
  --schema=public \
  --format=custom \
  --no-owner \
  --no-privileges \
  --file="$OUT"

# Symmetric encryption — prefer age if present, else gpg AES256.
if command -v age >/dev/null 2>&1; then
  age -p -o "$OUT.age" "$OUT" <<< "$BACKUP_ENCRYPTION_KEY"
  rm -f "$OUT"
  FINAL="$OUT.age"
elif command -v gpg >/dev/null 2>&1; then
  gpg --batch --yes --cipher-algo AES256 --passphrase "$BACKUP_ENCRYPTION_KEY" \
      --output "$OUT.gpg" "$OUT"
  rm -f "$OUT"
  FINAL="$OUT.gpg"
else
  echo "[backup-db] WARNING: neither 'age' nor 'gpg' found — dump left UNENCRYPTED at $OUT" >&2
  echo "[backup-db] Install age (https://age-encryption.org) or gpg and re-run; do NOT upload an unencrypted dump." >&2
  exit 1
fi

echo "[backup-db] encrypted dump written: $FINAL"

# Local retention — keep newest BACKUP_KEEP dumps only.
ls -1t "$BACKUP_DIR"/zapnivo-*.dump.* 2>/dev/null | tail -n +$((BACKUP_KEEP + 1)) | xargs -r rm -f

# Optional off-site upload — bucket MUST be private (docs/RECOVERY.md).
if [ -n "${BACKUP_S3_URI:-}" ]; then
  if command -v aws >/dev/null 2>&1; then
    aws s3 cp "$FINAL" "$BACKUP_S3_URI/$(basename "$FINAL")" --only-show-errors
    echo "[backup-db] uploaded to $BACKUP_S3_URI"
  else
    echo "[backup-db] WARNING: BACKUP_S3_URI set but 'aws' cli missing — dump kept local only" >&2
  fi
fi

echo "[backup-db] done. NEXT STEPS (manual):"
echo "  1. Verify the dump decrypts AND restores into a scratch DB (docs/RECOVERY.md isolated procedure)."
echo "  2. Confirm remote retention/lifecycle rules on the destination bucket."
echo "  3. Wire a dead-man's-switch heartbeat so a missed run alerts (docs/RECOVERY.md monitoring)."
echo "  4. Schedule quarterly restore drills; record each in /system/recovery."
