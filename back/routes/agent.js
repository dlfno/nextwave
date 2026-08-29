const express = require('express');
const router = express.Router();
const runner = require('../agents/runner');
const rogue = require('../agents/rogue');

// Consola y control de los agentes.

router.get('/decisions', (req, res) => {
  res.json({ running: runner.isRunning(), decisions: runner.decisions });
});

router.post('/start', (req, res) => {
  runner.start();
  res.json({ running: true });
});

router.post('/stop', (req, res) => {
  runner.stop();
  res.json({ running: false });
});

// Demo: simular que el agente intenta un vuelo fuera de su mandato ("alucinación")
router.post('/attempt/:flightId', async (req, res) => {
  try {
    res.json(await runner.forceAttempt(Number(req.params.flightId)));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Bonus: lanzar la batería de ataques del agente adversarial
router.post('/rogue/attack', (req, res) => {
  try {
    res.json(rogue.attackAll());
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
