var express = require('express');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
var cors = require('cors');

require('./db'); // inicializa SQLite + seed

var walletRouter = require('./routes/wallet');
var merchantRouter = require('./routes/merchant');
var auditRouter = require('./routes/audit');
var disputesRouter = require('./routes/disputes');
var agentRouter = require('./routes/agent');
var runner = require('./agents/runner');

var app = express();

app.use(cors());
app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/api/wallet', walletRouter);
app.use('/api/merchant', merchantRouter);
app.use('/api/audit', auditRouter);
app.use('/api/disputes', disputesRouter);
app.use('/api/agent', agentRouter);

runner.start();

module.exports = app;
