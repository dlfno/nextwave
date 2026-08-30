#!/bin/sh
set -eu

mkdir -p /app/nubevia-secrets
if [ -z "${NUBEVIA_SIGNING_PRIVATE_JWK:-}" ]; then
  if [ ! -f /app/nubevia-secrets/signing.jwk ]; then
    node --input-type=module -e "import { exportJWK, generateKeyPair } from 'jose'; const { privateKey } = await generateKeyPair('ES256', { extractable: true }); process.stdout.write(JSON.stringify(await exportJWK(privateKey)));" > /app/nubevia-secrets/signing.jwk
    chmod 600 /app/nubevia-secrets/signing.jwk
  fi
  NUBEVIA_SIGNING_PRIVATE_JWK=$(cat /app/nubevia-secrets/signing.jwk)
  export NUBEVIA_SIGNING_PRIVATE_JWK
fi

exec node dist/merchant-simulator/nubevia-server.js
