const crypto = require('crypto');

// Ed25519 nativo de Node. Sirve para firmar mandatos (Wallet) y requests de compra (agentes).

function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

// Serialización canónica: llaves ordenadas para que firma y verificación vean los mismos bytes
function canonical(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
  return (
    '{' +
    Object.keys(obj)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(obj[k]))
      .join(',') +
    '}'
  );
}

function sign(payload, privateKeyPem) {
  const key = crypto.createPrivateKey(privateKeyPem);
  return crypto.sign(null, Buffer.from(canonical(payload)), key).toString('base64');
}

function verify(payload, signatureB64, publicKeyPem) {
  try {
    const key = crypto.createPublicKey(publicKeyPem);
    return crypto.verify(null, Buffer.from(canonical(payload)), key, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

module.exports = { generateKeyPair, canonical, sign, verify, sha256 };
