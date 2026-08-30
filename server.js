#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '80', 10);
const SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const SELF_NAME = process.env.SELF_NAME || '';
const HTML_FILE = path.join(__dirname, 'index.html');

// Friendly labels/descriptions per container name.
// Override without rebuilding via the SERVICE_LABELS env var (JSON string),
// otherwise read labels.json next to this file.
let labels = {};
try {
  const raw = process.env.SERVICE_LABELS ||
    (fs.existsSync(path.join(__dirname, 'labels.json'))
      ? fs.readFileSync(path.join(__dirname, 'labels.json'), 'utf8')
      : null);
  labels = raw ? JSON.parse(raw) : {};
} catch (err) {
  console.error('ignoring bad labels: ' + err.message);
  labels = {};
}

function dockerApi(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ socketPath: SOCKET, path: pathname }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('docker API timed out')));
  });
}

function toService(c) {
  const ports = [];
  const seen = new Set();
  const push = (p) => {
    const key = p.containerPort + '/' + p.protocol + '/' + p.hostPort;
    if (seen.has(key)) return; // dedupe IPv4/IPv6 dual-stack entries
    seen.add(key);
    ports.push(p);
  };
  if (Array.isArray(c.Ports) && c.Ports.length) {
    // /containers/json summary field (present in current Docker versions)
    for (const p of c.Ports) {
      push({
        containerPort: Number(p.PrivatePort),
        protocol: p.Type || 'tcp',
        hostIp: p.IP || '',
        hostPort: p.PublicPort ? Number(p.PublicPort) : null,
      });
    }
  } else {
    // Fallback: full binding map from inspect-level data
    const portMap = (c.NetworkSettings && c.NetworkSettings.Ports) || {};
    for (const [key, bindings] of Object.entries(portMap)) {
      const [cp, proto] = key.split('/');
      for (const b of bindings || []) {
        push({
          containerPort: Number(cp),
          protocol: proto || 'tcp',
          hostIp: b.HostIp || '',
          hostPort: b.HostPort ? Number(b.HostPort) : null,
        });
      }
    }
  }
  ports.sort((a, b) => a.containerPort - b.containerPort);
  const name = c.Names && c.Names[0] ? c.Names[0].replace(/^\//, '') : c.Id.slice(0, 12);
  const meta = labels[name] || {};
  return {
    name,
    label: meta.label || null,
    description: meta.description || null,
    id: c.Id.slice(0, 12),
    image: c.Image,
    state: c.State,
    health: c.Health ? c.Health.Status : null,
    statusLine: c.Status,
    ports,
    self: name === SELF_NAME,
  };
}

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = new URL(req.url, 'http://internal').pathname; } catch { pathname = req.url; }

  if (pathname === '/api/services') {
    dockerApi('/containers/json')
      .then((list) => {
        const services = list.map(toService).sort((a, b) => a.name.localeCompare(b.name));
        const body = JSON.stringify({ generatedAt: new Date().toISOString(), services });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(body);
      })
      .catch((err) => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'docker api error: ' + err.message }));
      });
    return;
  }

  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    fs.readFile(HTML_FILE, (err, buf) => {
      if (err) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('index.html missing'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
    return;
  }

  const staticFiles = {
    '/favicon.ico': ['star.svg', 'image/svg+xml'],
    '/star.svg': ['star.svg', 'image/svg+xml'],
  };
  if (staticFiles[pathname]) {
    const [file, mime] = staticFiles[pathname];
    fs.readFile(path.join(__dirname, file), (err, buf) => {
      if (err) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('image missing'); return; }
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' });
      res.end(buf);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, '0.0.0.0', () => console.log('service-portal listening on :' + PORT));
