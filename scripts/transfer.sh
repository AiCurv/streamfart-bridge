#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# Core High-Speed Bridge Transmission Script
# ─────────────────────────────────────────────────────────────────
# Reads the flattened JSON payload, downloads each URL via curl,
# uploads to Storage.to via CLI, and harvests the JSON response links.
#
# SAFETY: Individual file cap at 8GB to protect the 14GB free runner
# disk. Files are aggressively deleted after upload to prevent
# out-of-disk termination.
#
# Usage: bash scripts/transfer.sh /tmp/payload.json
# ─────────────────────────────────────────────────────────────────

set -euo pipefail

PAYLOAD="$1"
MAX_FILE_SIZE_BYTES=$((8 * 1024 * 1024 * 1024))  # 8 GB cap
DL_DIR="/tmp/dl"
RESULTS_JSON="/tmp/results.json"

# ─── Parse payload ───
URL_COUNT=$(jq '.urls | length' "$PAYLOAD")
CHAT_ID=$(jq -r '.chat_id' "$PAYLOAD")
MODE=$(jq -r '.mode // "single"' "$PAYLOAD")

echo "=== Transfer Script Starting ==="
echo "Payload: $PAYLOAD"
echo "Total URLs: $URL_COUNT"
echo "Chat ID: $CHAT_ID"
echo "Mode: $MODE"

if [ "$URL_COUNT" -eq 0 ]; then
  echo "ERROR: No URLs in payload"
  exit 1
fi

# ─── Prepare directories ───
rm -rf "$DL_DIR"
mkdir -p "$DL_DIR"

# Initialize results JSON
echo '{"mode":"'"$MODE"'","chat_id":"'"$CHAT_ID"'","files":[]}' > "$RESULTS_JSON"

# ─── Function: send Telegram alert ───
send_alert() {
  local msg="$1"
  if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$CHAT_ID" ] && [ "$CHAT_ID" != "null" ]; then
    curl -fsS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${CHAT_ID}" \
      --data-urlencode "text=${msg}" \
      -d parse_mode=HTML 2>/dev/null || true
  fi
}

# ─── Function: check disk space ───
check_disk() {
  local available
  available=$(df /tmp | awk 'NR==2{print $4 * 1024}')  # in bytes
  if [ "$available" -lt $((2 * 1024 * 1024 * 1024)) ]; then
    echo "WARNING: Low disk space: $(numfmt --to=iec "$available")"
    send_alert "⚠️ Runner disk space low: $(numfmt --to=iec "$available") remaining. Bridge may fail."
  fi
}

# ─── Main download + upload loop ───
i=0
while [ "$i" -lt "$URL_COUNT" ]; do
  URL=$(jq -r ".urls[$i]" "$PAYLOAD")
  echo ""
  echo "==> [$((i+1))/$URL_COUNT] Processing: $URL"

  TMP_FILE="${DL_DIR}/file_${i}.bin"

  # ── Download ──
  echo "    Downloading..."
  HTTP_CODE=$(curl -L -o "$TMP_FILE" -w "%{http_code}" -fsSL --connect-timeout 30 --max-time 3600 "$URL" 2>/dev/null || true)

  if [ ! -f "$TMP_FILE" ] || [ ! -s "$TMP_FILE" ]; then
    echo "    ERROR: Download failed or empty file (HTTP $HTTP_CODE)"
    # For storage.to URLs, try scraping the page for CDN link
    if echo "$URL" | grep -qE '^https?://storage\.to/'; then
      echo "    Attempting storage.to page scrape..."
      FILE_ID=$(echo "$URL" | sed -E 's#^https?://storage\.to/(r/)?##; s#\?.*##; s#/.*##')
      CDN_URL=$(curl -fsSL "https://storage.to/$FILE_ID" 2>/dev/null \
        | grep -oE 'https://cdn\.storage\.to/[^"]*\?[^"]+' \
        | head -1 || true)
      if [ -n "$CDN_URL" ]; then
        echo "    Found CDN URL, retrying download..."
        curl -L -o "$TMP_FILE" -fsSL --connect-timeout 30 --max-time 3600 "$CDN_URL" || true
      fi
    fi

    # For pixeldrain URLs, use API download
    if echo "$URL" | grep -qE '^https?://pixeldrain\.(com|dev)/'; then
      if ! echo "$URL" | grep -qE '/api/file/'; then
        PD_ID=$(echo "$URL" | sed -E 's#^https?://pixeldrain\.(com|dev)/##; s#\?.*##; s#/.*##')
        echo "    Pixeldrain API download for id=$PD_ID"
        curl -L -o "$TMP_FILE" -fsSL "https://pixeldrain.com/api/file/${PD_ID}?download" || true
      fi
    fi
  fi

  # ── Validate downloaded file ──
  if [ ! -f "$TMP_FILE" ] || [ ! -s "$TMP_FILE" ]; then
    echo "    SKIP: Could not download $URL"
    send_alert "❌ Failed to download: $URL"
    i=$((i+1))
    continue
  fi

  FILE_SIZE=$(stat -c%s "$TMP_FILE" 2>/dev/null || echo "0")
  FILE_SIZE_HUMAN=$(numfmt --to=iec "$FILE_SIZE")
  echo "    Downloaded: $FILE_SIZE_HUMAN (HTTP $HTTP_CODE)"

  # ── Size cap check (8GB limit) ──
  if [ "$FILE_SIZE" -gt "$MAX_FILE_SIZE_BYTES" ]; then
    echo "    CAP HIT: File exceeds 8GB limit ($FILE_SIZE_HUMAN). Skipping upload."
    send_alert "⚠️ File from $URL exceeds 8GB cap ($FILE_SIZE_HUMAN). Skipped to protect runner disk."
    rm -f "$TMP_FILE"
    i=$((i+1))
    continue
  fi

  # ── Upload to Storage.to ──
  echo "    Uploading to Storage.to..."
  UPLOAD_OUTPUT="${DL_DIR}/upload_${i}.json"

  # storageto upload --json does NOT support stdin piping; must use file path
  if storageto upload --json "$TMP_FILE" > "$UPLOAD_OUTPUT" 2>&1; then
    echo "    Upload succeeded"
    cat "$UPLOAD_OUTPUT"
  else
    echo "    Upload FAILED"
    cat "$UPLOAD_OUTPUT" 2>/dev/null || true
    send_alert "❌ Upload failed for: $URL"
    rm -f "$TMP_FILE"
    i=$((i+1))
    continue
  fi

  # ── Harvest upload result ──
  # Parse the storageto CLI JSON output for direct + public URLs
  DIRECT_URL=""
  PUBLIC_URL=""
  EXPIRES_AT=""
  FILE_NAME=""

  if [ -f "$UPLOAD_OUTPUT" ] && jq -e . "$UPLOAD_OUTPUT" >/dev/null 2>&1; then
    # Try file_info (single file response)
    if jq -e '.file_info' "$UPLOAD_OUTPUT" >/dev/null 2>&1; then
      DIRECT_URL=$(jq -r '.file_info.raw_url // empty' "$UPLOAD_OUTPUT")
      PUBLIC_URL=$(jq -r '.file_info.url // empty' "$UPLOAD_OUTPUT")
      EXPIRES_AT=$(jq -r '.file_info.expires_at // "3 days"' "$UPLOAD_OUTPUT")
      FILE_NAME=$(jq -r '.file_info.name // "unknown"' "$UPLOAD_OUTPUT")
    # Try collection response
    elif jq -e '.collection_info' "$UPLOAD_OUTPUT" >/dev/null 2>&1; then
      PUBLIC_URL=$(jq -r '.collection_info.url // empty' "$UPLOAD_OUTPUT")
      DIRECT_URL=$(jq -r '.collection_info.raw_url // empty' "$UPLOAD_OUTPUT")
      EXPIRES_AT=$(jq -r '.collection_info.expires_at // "3 days"' "$UPLOAD_OUTPUT")
      FILE_NAME=$(jq -r '.collection_info.name // "collection"' "$UPLOAD_OUTPUT")
    else
      # Generic: try to extract any useful fields
      DIRECT_URL=$(jq -r '.raw_url // .direct_url // .url // empty' "$UPLOAD_OUTPUT")
      PUBLIC_URL=$(jq -r '.public_url // .url // .page_url // empty' "$UPLOAD_OUTPUT")
      FILE_NAME=$(jq -r '.name // .filename // "file_'"$i"'"' "$UPLOAD_OUTPUT")
      EXPIRES_AT="3 days"
    fi
  fi

  # Fallback: derive name from URL
  if [ -z "$FILE_NAME" ] || [ "$FILE_NAME" = "null" ]; then
    FILE_NAME="file_${i}"
  fi

  echo "    Result: $PUBLIC_URL -> $DIRECT_URL"

  # ── Append to results JSON ──
  RESULTS_TEMP="${DL_DIR}/results_tmp.json"
  jq --arg name "$FILE_NAME" \
     --arg public_url "$PUBLIC_URL" \
     --arg direct_url "$DIRECT_URL" \
     --arg expires_at "$EXPIRES_AT" \
     '.files += [{"name": $name, "public_url": $public_url, "direct_url": $direct_url, "expires_at": $expires_at}]' \
     "$RESULTS_JSON" > "$RESULTS_TEMP"
  mv "$RESULTS_TEMP" "$RESULTS_JSON"

  # ── Aggressive cleanup: delete downloaded file immediately ──
  echo "    Cleaning up: $TMP_FILE"
  rm -f "$TMP_FILE"
  rm -f "$UPLOAD_OUTPUT"

  # ── Check disk space after each file ──
  check_disk

  i=$((i+1))
done

# ─── Final summary ───
echo ""
echo "=== Transfer Complete ==="
TOTAL_UPLOADED=$(jq '.files | length' "$RESULTS_JSON")
echo "Successfully uploaded: $TOTAL_UPLOADED / $URL_COUNT files"
cat "$RESULTS_JSON"

# Clean up download directory
rm -rf "$DL_DIR"

echo "=== Done ==="
