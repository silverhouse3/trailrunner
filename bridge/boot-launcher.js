#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// Boot Launcher — Tiny HTTP service for boot selector actions
//
// Runs on port 4511 and handles requests from boot-selector.html to
// launch iFit or other apps that can't be opened via browser intents.
//
// Started by Termux:Boot alongside the selector page.
// ═══════════════════════════════════════════════════════════════════════════

const http = require('http');
const { exec } = require('child_process');

const PORT = 4511;
const IFIT_PACKAGE = 'com.ifit.eru';

const server = http.createServer((req, res) => {
  // CORS for local browser requests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.url === '/launch-ifit') {
    console.log('[boot-launcher] Launching iFit...');
    exec(`am start -n ${IFIT_PACKAGE}/.MainActivity`, (err) => {
      if (err) {
        // Fallback: try launching via package without activity name
        exec(`monkey -p ${IFIT_PACKAGE} -c android.intent.category.LAUNCHER 1`, (err2) => {
          if (err2) console.error('[boot-launcher] Failed to launch iFit:', err2.message);
        });
      }
    });
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');

  } else if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'boot-launcher' }));

  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[boot-launcher] Listening on http://127.0.0.1:${PORT}`);
});

// Auto-exit after 2 minutes (selector should have been used by then)
setTimeout(() => {
  console.log('[boot-launcher] Auto-exit after timeout');
  process.exit(0);
}, 120000);
