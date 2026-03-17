const puppeteer = require('puppeteer');
const http = require('http');
const path = require('path');
const handler = require('serve-handler');

const PORT = 3333;

async function generatePdf(page, lang) {
  const out = path.join(__dirname, `../www/cv-${lang}.pdf`);

  await page.evaluateOnNewDocument((l) => {
    localStorage.setItem('theme', 'light');
    localStorage.setItem('site-lang', l);
  }, lang);

  await page.goto(`http://localhost:${PORT}/#cv`, { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 1500));

  await page.pdf({
    path: out,
    format: 'A4',
    printBackground: true,
    preferCSSPageSize: true,
  });

  console.log(`PDF generated: ${out}`);
}

async function main() {
  const server = http.createServer((req, res) => {
    return handler(req, res, { public: path.join(__dirname, '../www') });
  });

  await new Promise(r => server.listen(PORT, r));
  console.log(`Server running on http://localhost:${PORT}`);

  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const pageFr = await browser.newPage();
  await generatePdf(pageFr, 'fr');

  const pageEn = await browser.newPage();
  await generatePdf(pageEn, 'en');

  await browser.close();
  server.close();
}

main().catch(err => { console.error(err); process.exit(1); });
