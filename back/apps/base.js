// Andamiaje común a los 3 servicios: mismo stack de middleware que el app.js monolítico.
const express = require('express');
const logger = require('morgan');
const cors = require('cors');

require('../db'); // SQLite compartido: CREATE TABLE IF NOT EXISTS + seed idempotente

function makeApp(mount) {
  const app = express();
  app.use(cors());
  app.use(logger('dev'));
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.get('/health', (req, res) => res.json({ ok: true }));
  mount(app);
  return app;
}

module.exports = { makeApp };
