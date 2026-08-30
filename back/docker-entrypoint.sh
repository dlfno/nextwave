#!/bin/sh
set -eu

create_signing_key() {
  node --input-type=module -e "import { exportJWK, generateKeyPair } from 'jose'; const { privateKey } = await generateKeyPair('ES256', { extractable: true }); process.stdout.write(JSON.stringify(await exportJWK(privateKey)));"
}

if [ -z "${MANDATE_SIGNING_PRIVATE_JWK:-}" ]; then
  MANDATE_SIGNING_PRIVATE_JWK=$(create_signing_key)
  export MANDATE_SIGNING_PRIVATE_JWK
fi
if [ -z "${VUELAYA_SIGNING_PRIVATE_JWK:-}" ]; then
  VUELAYA_SIGNING_PRIVATE_JWK=$(create_signing_key)
  export VUELAYA_SIGNING_PRIVATE_JWK
fi

/app/database/scripts/migrate.sh
/app/database/scripts/seed.sh
if [ "${DEMO_BOOTSTRAP_ACCOUNTS:-false}" = "true" ]; then
  npm run demo:reset
fi
exec node dist/server.js
