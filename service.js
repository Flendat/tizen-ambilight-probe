const fs = require('fs');
const http = require('http');

const paths = [
  '/usr/lib/libvideoenhance.so',
  '/usr/lib64/libvideoenhance.so',
  '/lib/libvideoenhance.so'
];

http.createServer((req, res) => {
  const report = {
    service: 'running',
    node: process.version,
    architecture: process.arch,
    libraries: paths.map(path => ({
      path: path,
      exists: fs.existsSync(path)
    }))
  };

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(report, null, 2));
}).listen(18766, '127.0.0.1');
