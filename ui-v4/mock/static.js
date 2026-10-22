#!/usr/bin/env node
// Tiny static file server for ui-v4 (no caching, binds 0.0.0.0:8099).
// Node built-ins only.  node mock/static.js   |  PORT=8100 node mock/static.js
'use strict';
var http = require('http');
var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var PORT = parseInt(process.env.PORT || '8099', 10);
var HOST = process.env.HOST || '0.0.0.0';

var MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.md': 'text/plain; charset=utf-8',
  '.gpx': 'application/gpx+xml', '.mp4': 'video/mp4', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
};

http.createServer(function (req, res) {
  var p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  var file = path.normalize(path.join(ROOT, p));
  if (file.indexOf(ROOT) !== 0) { res.writeHead(403); return res.end('forbidden'); }
  fs.stat(file, function (err, st) {
    if (err || !st.isFile()) {
      if (!err && st.isDirectory()) { file = path.join(file, 'index.html'); return serve(file); }
      res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found: ' + p);
    }
    serve(file);
  });
  function serve(file) {
    fs.readFile(file, function (err, data) {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(data);
    });
  }
}).listen(PORT, HOST, function () {
  console.log('[static] serving ' + ROOT + ' on http://' + HOST + ':' + PORT);
});
