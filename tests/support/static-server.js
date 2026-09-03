const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const types = {
  '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.pdf': 'application/pdf', '.woff2': 'font/woff2'
};

http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.resolve(root, '.' + pathname);
  if (file !== root && !file.startsWith(root + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.stat(file, (error, stat) => {
    const target = !error && stat.isDirectory() ? path.join(file, 'index.html') : file;
    fs.readFile(target, (readError, body) => {
      if (readError) return res.writeHead(404).end('Not found');
      res.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream' });
      res.end(body);
    });
  });
}).listen(4173, '127.0.0.1');
