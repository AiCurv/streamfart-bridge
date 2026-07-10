#!/usr/bin/env bash
set -euo pipefail

PAYLOAD="$1"
MAX_FILE_SIZE_BYTES=$((8 * 1024 * 1024 * 1024))
DL_DIR="/tmp/dl"
RESULTS_JSON="/tmp/results.json"

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

rm -rf "$DL_DIR"
mkdir -p "$DL_DIR"
echo '{"mode":"'"$MODE"'","chat_id":"'"$CHAT_ID"'","files":[]}' > "$RESULTS_JSON"

send_alert() {
  local msg="$1"
  if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$CHAT_ID" ] && [ "$CHAT_ID" != "null" ]; then
    curl -fsS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${CHAT_ID}" \
      --data-urlencode "text=${msg}" \
      -d parse_mode=HTML 2>/dev/null || true
  fi
}

check_disk() {
  local available
  available=$(df /tmp | awk 'NR==2{print $4 * 1024}')
  if [ "$available" -lt $((2 * 1024 * 1024 * 1024)) ]; then
    echo "WARNING: Low disk space: $(numfmt --to=iec "$available")"
    send_alert "⚠️ Runner disk space low: $(numfmt --to=iec "$available") remaining."
  fi
}

i=0
while [ "$i" -lt "$URL_COUNT" ]; do
  URL=$(jq -r ".urls[$i]" "$PAYLOAD")
  echo ""
  echo "==> [$((i+1))/$URL_COUNT] Processing: $URL"

  TMP_FILE="${DL_DIR}/file_${i}.bin"

  echo "    Downloading..."
  HTTP_CODE=$(curl -L -o "$TMP_FILE" -w "%{http_code}" -fsSL --connect-timeout 30 --max-time 3600 "$URL" 2>/dev/null || true)

  if [ ! -f "$TMP_FILE" ] || [ ! -s "$TMP_FILE" ]; then
    echo "    ERROR: Download failed or empty (HTTP $HTTP_CODE)"
    if echo "$URL" | grep -qE '^https?://storage\.to/'; then
      FILE_ID=$(echo "$URL" | sed -E 's#^https?://storage\.to/(r/)?##; s#\?.*##; s#/.*##')
      CDN_URL=$(curl -fsSL "https://storage.to/$FILE_ID" 2>/dev/null | grep -oE 'https://cdn\.storage\.to/[^"]*\?[^"]+' | head -1 || true)
      if [ -n "$CDN_URL" ]; then
        curl -L -o "$TMP_FILE" -fsSL --connect-timeout 30 --max-time 3600 "$CDN_URL" || true
      fi
    fi
    if echo "$URL" | grep -qE '^https?://pixeldrain\.(com|dev)/'; then
      if ! echo "$URL" | grep -qE '/api/file/'; then
        PD_ID=$(echo "$URL" | sed -E 's#^https?://pixeldrain\.(com|dev)/##; s#\?.*##; s#/.*##')
        curl -L -o "$TMP_FILE" -fsSL "https://pixeldrain.com/api/file/${PD_ID}?download" || true
      fi
    fi
  fi

  if [ ! -f "$TMP_FILE" ] || [ ! -s "$TMP_FILE" ]; then
    echo "    SKIP: Could not download $URL"
    send_alert "❌ Failed to download: $URL"
    i=$((i+1))
    continue
  fi

  FILE_SIZE=$(stat -c%s "$TMP_FILE" 2>/dev/null || echo "0")
  FILE_SIZE_HUMAN=$(numfmt --to=iec "$FILE_SIZE")
  echo "    Downloaded: $FILE_SIZE_HUMAN"

  if [ "$FILE_SIZE" -gt "$MAX_FILE_SIZE_BYTES" ]; then
    echo "    CAP HIT: File exceeds 8GB ($FILE_SIZE_HUMAN). Skipping."
    send_alert "⚠️ File exceeds 8GB cap ($FILE_SIZE_HUMAN). Skipped."
    rm -f "$TMP_FILE"
    i=$((i+1))
    continue
  fi

  # Try to detect filename from URL or Content-Disposition
  DETECTED_NAME=$(basename "$URL" | sed 's/[?].*//' | sed 's/%20/ /g')
  if [ -z "$DETECTED_NAME" ] || [ "$DETECTED_NAME" = "/" ] || [ ${#DETECTED_NAME} -gt 200 ]; then
    DETECTED_NAME="file_${i}.bin"
  fi
  # Rename to detected name for better storageto metadata
  mv "$TMP_FILE" "${DL_DIR}/${DETECTED_NAME}" 2>/dev/null || true
  UPLOAD_FILE="${DL_DIR}/${DETECTED_NAME}"
  if [ ! -f "$UPLOAD_FILE" ]; then
    UPLOAD_FILE="$TMP_FILE"
  fi

  echo "    Uploading to Storage.to..."
  UPLOAD_OUTPUT="${DL_DIR}/upload_${i}.json"
  UPLOAD_ERR="${DL_DIR}/upload_${i}_err.txt"

  # storageto upload: --no-token avoids invalid header from Sanctum tokens with pipe chars.
  # The CLI will auto-generate an anonymous visitor token for 3-day expiry uploads.
  if storageto upload --no-token --json "$UPLOAD_FILE" > "$UPLOAD_OUTPUT" 2> "$UPLOAD_ERR"; then
    echo "    Upload succeeded"
  else
    EXIT_CODE=$?
    echo "    Upload FAILED (exit=$EXIT_CODE)"
    cat "$UPLOAD_ERR" 2>/dev/null || true
    cat "$UPLOAD_OUTPUT" 2>/dev/null || true
    send_alert "❌ Upload failed for: $URL"
    rm -f "$UPLOAD_FILE" "$TMP_FILE" "$UPLOAD_OUTPUT" "$UPLOAD_ERR"
    i=$((i+1))
    continue
  fi

  # Parse storageto upload --json output
  # Single file: { "file_info": { "id", "url", "raw_url", "filename", "size", "human_size", "expires_at" } }
  # Collection:  { "collection_info": { "id", "url", "expires_at" }, "is_collection": true,
  #                "files": [ { "id", "url", "raw_url", "filename", ... } ] }
  DIRECT_URL=""
  PUBLIC_URL=""
  EXPIRES_AT=""
  FILE_NAME=""

  if [ -f "$UPLOAD_OUTPUT" ] && jq -e . "$UPLOAD_OUTPUT" >/dev/null 2>&1; then
    echo "    Raw storageto output:"
    cat "$UPLOAD_OUTPUT"

    if jq -e '.file_info' "$UPLOAD_OUTPUT" >/dev/null 2>&1; then
      DIRECT_URL=$(jq -r '.file_info.raw_url // empty' "$UPLOAD_OUTPUT")
      PUBLIC_URL=$(jq -r '.file_info.url // empty' "$UPLOAD_OUTPUT")
      EXPIRES_AT=$(jq -r '.file_info.expires_at // "3 days"' "$UPLOAD_OUTPUT")
      FILE_NAME=$(jq -r '.file_info.filename // .file_info.name // "unknown"' "$UPLOAD_OUTPUT")
    elif jq -e '.is_collection' "$UPLOAD_OUTPUT" >/dev/null 2>&1; then
      # Multi-file collection uploaded at once
      # The collection_info has the aggregate URL
      PUBLIC_URL=$(jq -r '.collection_info.url // empty' "$UPLOAD_OUTPUT")
      EXPIRES_AT=$(jq -r '.collection_info.expires_at // "3 days"' "$UPLOAD_OUTPUT")
      FILE_NAME="collection"
      # Extract per-file details from the collection
      FILE_COUNT=$(jq '.files | length' "$UPLOAD_OUTPUT" 2>/dev/null || echo "0")
      ci=0
      while [ "$ci" -lt "$FILE_COUNT" ]; do
        F_NAME=$(jq -r ".files[$ci].filename // .files[$ci].name // \"file_$ci\"" "$UPLOAD_OUTPUT")
        F_PUBLIC=$(jq -r ".files[$ci].url // empty" "$UPLOAD_OUTPUT")
        F_DIRECT=$(jq -r ".files[$ci].raw_url // empty" "$UPLOAD_OUTPUT")
        F_EXPIRES=$(jq -r ".files[$ci].expires_at // \"3 days\"" "$UPLOAD_OUTPUT")

        RESULTS_TEMP="${DL_DIR}/results_tmp.json"
        jq --arg name "$F_NAME" \
           --arg public_url "$F_PUBLIC" \
           --arg direct_url "$F_DIRECT" \
           --arg expires_at "$F_EXPIRES" \
           '.files += [{"name": $name, "public_url": $public_url, "direct_url": $direct_url, "expires_at": $expires_at}]' \
           "$RESULTS_JSON" > "$RESULTS_TEMP"
        mv "$RESULTS_TEMP" "$RESULTS_JSON"

        ci=$((ci+1))
      done

      # For collection, we already added all files above; skip the single-file append below
      rm -f "$UPLOAD_FILE" "$TMP_FILE" "$UPLOAD_OUTPUT" "$UPLOAD_ERR"
      check_disk
      i=$((i+1))
      continue
    else
      # Fallback: try generic fields
      DIRECT_URL=$(jq -r '.raw_url // .direct_url // empty' "$UPLOAD_OUTPUT")
      PUBLIC_URL=$(jq -r '.url // .public_url // empty' "$UPLOAD_OUTPUT")
      FILE_NAME=$(jq -r '.filename // .name // "file_'"$i"'"' "$UPLOAD_OUTPUT")
      EXPIRES_AT="3 days"
    fi
  fi

  if [ -z "$FILE_NAME" ] || [ "$FILE_NAME" = "null" ]; then
    FILE_NAME="$DETECTED_NAME"
  fi

  echo "    Result: name=$FILE_NAME public=$PUBLIC_URL direct=$DIRECT_URL"

  RESULTS_TEMP="${DL_DIR}/results_tmp.json"
  jq --arg name "$FILE_NAME" \
     --arg public_url "$PUBLIC_URL" \
     --arg direct_url "$DIRECT_URL" \
     --arg expires_at "$EXPIRES_AT" \
     '.files += [{"name": $name, "public_url": $public_url, "direct_url": $direct_url, "expires_at": $expires_at}]' \
     "$RESULTS_JSON" > "$RESULTS_TEMP"
  mv "$RESULTS_TEMP" "$RESULTS_JSON"

  echo "    Cleaning up: $UPLOAD_FILE"
  rm -f "$UPLOAD_FILE" "$TMP_FILE" "$UPLOAD_OUTPUT" "$UPLOAD_ERR"

  check_disk
  i=$((i+1))
done

echo ""
echo "=== Transfer Complete ==="
TOTAL_UPLOADED=$(jq '.files | length' "$RESULTS_JSON")
echo "Successfully uploaded: $TOTAL_UPLOADED / $URL_COUNT files"
cat "$RESULTS_JSON"
rm -rf "$DL_DIR"
echo "=== Done ==="
