const express = require('express');
const router = express.Router();
const audit = require('../lib/audit');

router.get('/trail', (req, res) => res.json(audit.trail(300)));
router.get('/trail/verify', (req, res) => res.json(audit.verifyChain()));

module.exports = router;
