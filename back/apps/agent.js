// Servicio Agente (:3003).
// Consola de los agentes + el loop de Marta, que compra vía POST al Merchant por HTTP.
const { makeApp } = require('./base');
const runner = require('../agents/runner');

const app = makeApp((a) => {
  a.use('/api/agent', require('../routes/agent'));
});

runner.start();

module.exports = app;
