import express, { Request, Response } from "express"
import bodyParser from 'body-parser';
import { chromium, Browser, BrowserContext, Route, Request as PlaywrightRequest, Page } from 'playwright';
import dotenv from 'dotenv';
import UserAgent from 'user-agents';

dotenv.config()

const port = process.env.PORT || 3000

const app = express()
app.use(bodyParser.json());

let browser: Browser;

const AD_SERVING_DOMAINS = [
  'doubleclick.net',
  'adservice.google.com',
  'googlesyndication.com',
  'googletagservices.com',
  'googletagmanager.com',
  'google-analytics.com',
  'adsystem.com',
  'adservice.com',
  'adnxs.com',
  'ads-twitter.com',
  'facebook.net',
  'fbcdn.net',
  'amazon-adsystem.com'
];

interface UrlModel {
  url: string;
  wait_after_load?: number;
  timeout?: number;
  headers?: { [key: string]: string };
  check_selector?: string;
  skip_tls_verification?: boolean;
}

const isValidUrl = (urlString: string): boolean => {
  try {
    new URL(urlString);
    return true;
  } catch (_) {
    return false;
  }
};

const initializeBrowser = async () => {
  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-dev-shm-usage'
    ]
  });
};

//TODO: Proxy, Block Media
const createContext = async (skipTlsVerification: boolean = false): Promise<BrowserContext> => {
  const userAgent = new UserAgent().toString();
  const viewport = { width: 1280, height: 800 };

  const contextOptions: any = {
    userAgent,
    viewport,
    ignoreHTTPSErrors: skipTlsVerification,
  };

  const newContext = await browser.newContext(contextOptions);

  // Intercept all requests to avoid loading ads if there are any.
  await newContext.route('**/*', (route: Route, request: PlaywrightRequest) => {
    const requestUrl = new URL(request.url());
    const hostname = requestUrl.hostname;

    if (AD_SERVING_DOMAINS.some(domain => hostname.includes(domain))) {
      console.log(hostname);
      return route.abort();
    }
    return route.continue();
  });
  
  return newContext;
};

const takeScreenshot = async (page: Page, url: string, waitUntil: 'load' | 'networkidle', waitAfterLoad: number, timeout: number, checkSelector: string | undefined): Promise<Buffer> => {
  console.log(`Navigating to ${url} with waitUntil: ${waitUntil} and timeout: ${timeout}ms`);
  const response = await page.goto(url, { waitUntil, timeout });

  if (waitAfterLoad > 0) {
    await page.waitForTimeout(waitAfterLoad);
  }

  if (checkSelector) {
    try {
      await page.waitForSelector(checkSelector, { timeout });
    } catch (error) {
      throw new Error('Required selector not found');
    }
  }

  const image = await page.screenshot();
  console.log("Success ✅")
  return image;
}


const shutdownBrowser = async () => {
  if (browser) {
    await browser.close();
  }
};

app.get('/', (req: Request, res: Response) => {
  res.send('Hello World')
})

app.post('/screenshot', async (req: Request, res: Response) => {
  console.log(req.body)
  const { url, wait_after_load = 0, timeout = 15000, headers, check_selector, skip_tls_verification = false }: UrlModel = req.body;

  console.log(`================= Screenshot Request =================`);
  console.log(`URL: ${url}`);
  console.log(`Wait After Load: ${wait_after_load}`);
  console.log(`Timeout: ${timeout}`);
  console.log(`Headers: ${headers ? JSON.stringify(headers) : 'None'}`);
  console.log(`Check Selector: ${check_selector ? check_selector : 'None'}`);
  console.log(`Skip TLS Verification: ${skip_tls_verification}`);
  console.log(`==================================================`);

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  if (!isValidUrl(url)) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  if (!browser) {
    await initializeBrowser();
  }

  const requestContext: BrowserContext = await createContext(skip_tls_verification);
  const page = await requestContext.newPage();

  // Set headers if provided
  if (headers) {
    await page.setExtraHTTPHeaders(headers);
  }

  let result: Buffer;

  try {
    // Strategy 1: Normal
    console.log('Attempting strategy 1: Normal load');
    result = await takeScreenshot(page, url, 'load', wait_after_load, timeout, check_selector);
  } catch (error) {
    console.log('Strategy 1 failed, attempting strategy 2: Wait until networkidle');
    try {
      // Strategy 2: Wait until networkidle
      result = await takeScreenshot(page, url, 'networkidle', wait_after_load, timeout, check_selector);
    } catch (finalError) {
      await page.close();
      await requestContext.close();
      return res.status(500).json({ error: 'An error occurred while fetching the page.' });
    }
  }

  await page.close();
  await requestContext.close();

  res.status(200).json({
    data: result.toString("base64"),
  })
})

app.listen(port, () => {
  initializeBrowser().then(() => {
    console.log(`Server is running on port ${port}`);
  });
});

process.on('SIGINT', () => {
  shutdownBrowser().then(() => {
    console.log('Browser closed');
    process.exit(0);
  });
});