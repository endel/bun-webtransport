#!/bin/bash
# Generate short-lived ECDSA P-256 certificates for browser WebTransport
# Browser requires cert validity <= 14 days

CERT_DIR="$(dirname "$0")/certs"
mkdir -p "$CERT_DIR"

openssl ecparam -name prime256v1 -genkey -noout -out "$CERT_DIR/server.key" 2>/dev/null

openssl req -new -x509 \
  -key "$CERT_DIR/server.key" \
  -out "$CERT_DIR/server.crt" \
  -days 13 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  2>/dev/null

echo "Certificates generated in $CERT_DIR/ (valid for 13 days)"
echo "  server.crt"
echo "  server.key"
