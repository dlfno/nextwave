// Configuración de los 3 servicios (DECISIONS #33). Antes eran un solo proceso Express;
// ahora wallet / merchant / agent corren por separado y se hablan por HTTP. La base de
// datos SQLite sigue siendo un archivo compartido (simplificación deliberada del demo).

const PORTS = { wallet: 3001, merchant: 3002, agent: 3003, all: 3000 };

module.exports = {
  PORTS,
  // URLs que un servicio usa para llamar a otro. Sobreescribibles por entorno para
  // desplegar cada parte en su propio host.
  walletUrl: process.env.WALLET_URL || `http://localhost:${PORTS.wallet}`,
  merchantUrl: process.env.MERCHANT_URL || `http://localhost:${PORTS.merchant}`,
};
