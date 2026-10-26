const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  for (const f of ['a-night-cluster', 'b-m-sport', 'c-estoril-obc']) {
    const p = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    await p.goto('file://' + __dirname + '/' + f + '.html');
    await p.waitForTimeout(1500);
    await p.screenshot({ path: __dirname + '/' + f + '.png', fullPage: true });
  }
  await b.close();
})();
