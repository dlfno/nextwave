// Servicio Wallet / Autorizador "PagoSeguro" (:3001).
// Dueño de mandatos, tickets, verificación (POST /api/wallet/verify), disputas y del trail.
const { makeApp } = require('./base');

module.exports = makeApp((app) => {
  app.use('/api/wallet', require('../routes/wallet'));
  app.use('/api/audit', require('../routes/audit'));
  app.use('/api/disputes', require('../routes/disputes'));
});
