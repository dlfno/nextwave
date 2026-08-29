import { exportJWK, generateKeyPair } from 'jose';

const { privateKey } = await generateKeyPair('ES256', { extractable: true });
process.stdout.write(`${JSON.stringify(await exportJWK(privateKey))}\n`);
