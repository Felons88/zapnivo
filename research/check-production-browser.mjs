import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
try {
  for (const { viewport, crawler } of [
    { viewport: { width: 1440, height: 900 }, crawler: false },
    { viewport: { width: 390, height: 844 }, crawler: true },
  ]) {
    const page = await browser.newPage({ viewport, ...(crawler ? { userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' } : {}) });
    const failures = [];
    const mapbox = [];
    page.on('requestfailed', request => failures.push(`${request.url()} ${request.failure()?.errorText}`));
    page.on('response', response => {
      if (response.url().includes('mapbox.com')) mapbox.push(`${response.status()} ${new URL(response.url()).pathname}`);
    });
    const response = await page.goto('https://www.zapnivo.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(18000);
    const report = {
      viewport,
      crawler,
      status: response?.status(),
      title: await page.title(),
      mapLoading: await page.getByText('Loading station map…').count(),
      mapUnavailable: await page.getByText('The station map is temporarily unavailable.').count(),
      mapbox,
      failures,
      horizontalOverflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    };
    console.log(JSON.stringify(report, null, 2));
    await page.close();
  }
} finally {
  await browser.close();
}
