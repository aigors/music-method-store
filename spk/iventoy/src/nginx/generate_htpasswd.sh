#!/bin/sh
# Generate htpasswd file for iVentoy nginx reverse proxy
# Usage: generate_htpasswd.sh <username> <password> <output_file>

set -e

USERNAME="$1"
PASSWORD="$2"
OUTPUT="$3"

if [ -z "$USERNAME" -o -z "$PASSWORD" -o -z "$OUTPUT" ]; then
    echo "Usage: $0 <username> <password> <output_file>" >&2
    exit 1
fi

SALT=$(openssl rand -base64 6 2>/dev/null | tr -dc 'a-zA-Z0-9./' | head -c 8)
if [ -z "$SALT" ]; then
    SALT="iventoy0"
fi

HASH=$(openssl passwd -apr1 -salt "$SALT" "$PASSWORD" 2>/dev/null)

if [ -z "$HASH" ]; then
    echo "Failed to generate password hash" >&2
    exit 1
fi

echo "${USERNAME}:${HASH}" > "$OUTPUT"
chmod 640 "$OUTPUT"

echo "Generated htpasswd for user: ${USERNAME}"