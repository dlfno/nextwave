// Servicio Merchant "VuelaYa" (:3002).
// Catálogo y checkout. En cada checkout consulta al Wallet por HTTP (services/checkout.js).
const { makeApp } = require('./base');

module.exports = makeApp((app) => {
  app.use('/api/merchant', require('../routes/merchant'));
});
