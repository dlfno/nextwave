#!/bin/sh
set -eu

create_signing_key() {
  node --input-type=module -e "import { exportJWK, generateKeyPair } from 'jose'; const { privateKey } = await generateKeyPair('ES256', { extractable: true }); process.stdout.write(JSON.stringify(await exportJWK(privateKey)));"
}

mkdir -p /app/runtime-secrets
if [ -z "${MANDATE_SIGNING_PRIVATE_JWK:-}" ]; then
  if [ ! -f /app/runtime-secrets/mandate-signing.jwk ]; then
    create_signing_key > /app/runtime-secrets/mandate-signing.jwk
    chmod 600 /app/runtime-secrets/mandate-signing.jwk
  fi
  MANDATE_SIGNING_PRIVATE_JWK=$(cat /app/runtime-secrets/mandate-signing.jwk)
  export MANDATE_SIGNING_PRIVATE_JWK
fi
if [ -z "${VUELAYA_SIGNING_PRIVATE_JWK:-}" ]; then
  if [ ! -f /app/runtime-secrets/checkout-signing.jwk ]; then
    create_signing_key > /app/runtime-secrets/checkout-signing.jwk
    chmod 600 /app/runtime-secrets/checkout-signing.jwk
  fi
  VUELAYA_SIGNING_PRIVATE_JWK=$(cat /app/runtime-secrets/checkout-signing.jwk)
  export VUELAYA_SIGNING_PRIVATE_JWK
fi
if [ -z "${AGENT_SIGNING_PRIVATE_JWK:-}" ]; then
  if [ ! -f /app/runtime-secrets/agent-signing.jwk ]; then
    create_signing_key > /app/runtime-secrets/agent-signing.jwk
    chmod 600 /app/runtime-secrets/agent-signing.jwk
  fi
  AGENT_SIGNING_PRIVATE_JWK=$(cat /app/runtime-secrets/agent-signing.jwk)
  export AGENT_SIGNING_PRIVATE_JWK
fi

/app/database/scripts/migrate.sh
/app/database/scripts/seed.sh
if [ "${DEMO_BOOTSTRAP_ACCOUNTS:-false}" = "true" ]; then
  npm run demo:reset
fi
exec node dist/server.js
