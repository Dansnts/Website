const puppeteer = require('puppeteer');
const http = require('http');
const path = require('path');
const handler = require('serve-handler');

const PORT = 3336;

async function main() {
  const server = http.createServer((req, res) => {
    return handler(req, res, { public: path.join(__dirname, '../templates') });
  });

  await new Promise(r => server.listen(PORT, r));
  console.log(`Server running on http://localhost:${PORT}`);

  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();

  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('theme', 'light');
  });

  await page.goto(`http://localhost:${PORT}/cv-pictet-en.html`, { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 1500));

  const out = path.join(__dirname, '../output/cv-pictet-en.pdf');

  await page.pdf({
    path: out,
    format: 'A4',
    printBackground: true,
    preferCSSPageSize: true,
  });

  console.log(`PDF generated: ${out}`);

  await browser.close();
  server.close();
}

main().catch(err => { console.error(err); process.exit(1); });
