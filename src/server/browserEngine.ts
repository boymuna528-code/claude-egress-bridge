export interface BrowserEngineStatus {
  isAvailable: boolean;
  engineType: 'cloudflare_browser_rendering' | 'local_chromium' | 'unsupported';
  status: 'active' | 'binding_missing' | 'requires_paid_plan';
  message: string;
  capabilities: {
    javascriptEvaluation: boolean;
    screenshots: boolean;
    pdfGeneration: boolean;
    interactionClicksAndForms: boolean;
    sessionManagement: boolean;
  };
  setupInstructions: {
    cloudflareBrowserRendering: string[];
    externalPlaywrightWorker: string[];
  };
}

export function evaluateBrowserCapability(env?: any): BrowserEngineStatus {
  // 1. Check for Cloudflare Browser Rendering binding (env.MYBROWSER)
  if (env?.MYBROWSER) {
    return {
      isAvailable: true,
      engineType: 'cloudflare_browser_rendering',
      status: 'active',
      message: 'Cloudflare Browser Rendering (Puppeteer) binding is active and ready for JavaScript execution.',
      capabilities: {
        javascriptEvaluation: true,
        screenshots: true,
        pdfGeneration: true,
        interactionClicksAndForms: true,
        sessionManagement: true,
      },
      setupInstructions: {
        cloudflareBrowserRendering: ['Already enabled via binding MYBROWSER in wrangler.jsonc'],
        externalPlaywrightWorker: [],
      },
    };
  }

  // 2. Unbound status - Honest reporting as requested
  return {
    isAvailable: false,
    engineType: 'cloudflare_browser_rendering',
    status: 'binding_missing',
    message:
      'Cloudflare Browser Rendering binding (MYBROWSER) is not attached. Running real headless Chromium on Cloudflare requires enabling Browser Rendering (available on Workers Paid / Workers Browser Rendering addon).',
    capabilities: {
      javascriptEvaluation: false,
      screenshots: false,
      pdfGeneration: false,
      interactionClicksAndForms: false,
      sessionManagement: false,
    },
    setupInstructions: {
      cloudflareBrowserRendering: [
        '1. In Cloudflare Dashboard, navigate to Compute (Workers) > Browser Rendering.',
        '2. Enable Browser Rendering for your account.',
        '3. Ensure wrangler.jsonc has the binding: "browser": { "binding": "MYBROWSER" }',
        '4. Deploy via wrangler deploy.',
      ],
      externalPlaywrightWorker: [
        'Alternative: Connect to an external Playwright/Chromium container service via WebSocket or HTTP endpoint.',
        'Set BROWSERLESS_WS_ENDPOINT or PLAYWRIGHT_SERVICE_URL in your environment variables.',
      ],
    },
  };
}

export interface BrowserRenderRequest {
  url: string;
  waitForSelector?: string;
  takeScreenshot?: boolean;
  javascript?: string;
}

export async function executeBrowserRender(req: BrowserRenderRequest, env?: any) {
  const capability = evaluateBrowserCapability(env);

  // If real Cloudflare Browser Rendering binding is present:
  if (env?.MYBROWSER) {
    try {
      let puppeteer: any;
      try {
        const pkg = '@cloudflare/puppeteer';
        puppeteer = await (Function('m', 'return import(m)')(pkg));
      } catch {
        // Fallback if not available
      }

      if (puppeteer && puppeteer.launch) {
        const browser = await puppeteer.launch(env.MYBROWSER);
        const page = await browser.newPage();
        await page.goto(req.url, { waitUntil: 'networkidle2', timeout: 30000 });

        if (req.waitForSelector) {
          await page.waitForSelector(req.waitForSelector, { timeout: 10000 });
        }

        let screenshotBase64: string | undefined = undefined;
        if (req.takeScreenshot) {
          const imgBuffer = await page.screenshot({ fullPage: false, type: 'jpeg', quality: 80 });
          screenshotBase64 = Buffer.from(imgBuffer).toString('base64');
        }

        const html = await page.content();
        const title = await page.title();
        await browser.close();

        return {
          success: true,
          engine: 'cloudflare_browser_rendering',
          title,
          url: req.url,
          html,
          screenshotBase64,
          message: 'Page rendered with Cloudflare Browser Rendering engine.',
        };
      }
    } catch (browserErr: any) {
      return {
        success: false,
        engine: 'cloudflare_browser_rendering',
        error: `Browser Rendering Execution Error: ${browserErr.message}`,
      };
    }
  }

  // Honest reporting: We do NOT fake browser automation using basic HTTP fetch!
  return {
    success: false,
    engine: 'unsupported',
    status: capability.status,
    targetUrl: req.url,
    message: capability.message,
    diagnostics: capability,
    recommendation:
      'For static HTML content and APIs, use the "fetch_webpage" or "http_request" tools instead. To enable JavaScript SPA rendering and screenshots, enable Cloudflare Browser Rendering on your account.',
  };
}
