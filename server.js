// Optional local test server. On GitHub Pages this file isn't used; Pages serves docs/ directly.
// Spotify requires loopback redirect URIs to use 127.0.0.1 (not "localhost").
const http = require("http");
const fs = require("fs");
const path = require("path");

const HOST = "127.0.0.1";
const PORT = 8888;
const SITE_DIR = path.join(__dirname, "docs");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, `http://${HOST}`).pathname);
    let filePath = path.normalize(path.join(SITE_DIR, urlPath));
    if (!filePath.startsWith(SITE_DIR)) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    // Like GitHub Pages: folders serve index.html, and "/glasses" redirects to "/glasses/".
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      if (!urlPath.endsWith("/")) {
        res.writeHead(301, { Location: urlPath + "/" }).end();
        return;
      }
      filePath = path.join(filePath, "index.html");
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404).end("Not found");
        return;
      }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(filePath)] || "application/octet-stream" });
      res.end(data);
    });
  })
  .listen(PORT, HOST, () => {
    console.log(`Spotify Controller:  http://${HOST}:${PORT}/`);
    console.log(`Glasses version:     http://${HOST}:${PORT}/glasses/`);
  });
