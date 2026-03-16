const puppeteer = require('puppeteer');
const http = require('http');
const fs = require('fs');
const path = require('path');
const handler = require('serve-handler');

const PORT = 3333;
const OUT = path.join(__dirname, '../www/cv.pdf');

async function main() {
  // Spin up a local static server
  const server = http.createServer((req, res) => {
    return handler(req, res, { public: path.join(__dirname, '../www') });
  });

  await new Promise(r => server.listen(PORT, r));
  console.log(`Server running on http://localhost:${PORT}`);

  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  // Set light theme via localStorage before page loads
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('theme', 'light');
  });

  await page.goto(`http://localhost:${PORT}/#cv`, { waitUntil: 'networkidle0' });

  // Wait for fonts and animations
  await new Promise(r => setTimeout(r, 1500));

  await page.pdf({
    path: OUT,
    format: 'A4',
    printBackground: true,
    preferCSSPageSize: true,
  });

  console.log(`PDF generated: ${OUT}`);
  await browser.close();
  server.close();
}

main().catch(err => { console.error(err); process.exit(1); });
