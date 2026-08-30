import 'dotenv/config';

import type { JWK } from 'jose';

import { createNubeViaSimulator } from './nubevia-app.js';

const privateJwk = process.env.NUBEVIA_SIGNING_PRIVATE_JWK;
if (!privateJwk) throw new Error('NUBEVIA_SIGNING_PRIVATE_JWK is required');

const port = Number.parseInt(process.env.PORT ?? '3100', 10);
const app = await createNubeViaSimulator({
  privateJwk: JSON.parse(privateJwk) as JWK,
  keyId: process.env.NUBEVIA_SIGNING_KEY_ID ?? 'nubevia-checkout-1',
});

app.listen(port, () => {
  process.stdout.write(`NubeVia UCP merchant listening on port ${port}\n`);
});
