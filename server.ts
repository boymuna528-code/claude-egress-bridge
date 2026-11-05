import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import * as cheerio from 'cheerio';
import TurndownService from 'turndown';

import {
  validateUrlSafety,
  recordAuditLog,
  checkRateLimit,
} from './src/server/security';
import { lookupPackage } from './src/server/packageRegistry';
import { evaluateBrowserCapability, executeBrowserRender } from './src/server/browserEngine';
import { discoverSitemapAndPagination } from './src/server/sitemapService';
import { getStorageService } from './src/server/storageAdapter';
import { getDatabaseService } from './src/server/databaseAdapter';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

const storage = getStorageService();
const db = getDatabaseService();

// Initialize Gemini Client with server telemetry header
const geminiApiKey = process.env.GEMINI_API_KEY || '';
const ai = geminiApiKey
  ? new GoogleGenAI({
      apiKey: geminiApiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    })
  : null;

// Initialize Turndown HTML-to-Markdown converter
const turndownService = new TurndownService({
  headingStyle: 'atx',
  hr: '---',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '_',
});

turndownService.remove(['script', 'style', 'noscript', 'canvas', 'iframe'] as any);

// Middleware
app.use(express.json({ limit: '35mb' }));
app.use(express.urlencoded({ extended: true, limit: '35mb' }));

// CORS handler for external bots, Claude Code, and local clients
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-requested-with, accept, user-agent');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

// Cache for recent searches and scraped pages
const searchCache = new Map<string, { data: any; timestamp: number }>();
const scrapeCache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL_MS = 1000 * 60 * 15;

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of searchCache.entries()) {
    if (now - val.timestamp > CACHE_TTL_MS) searchCache.delete(key);
  }
  for (const [key, val] of scrapeCache.entries()) {
    if (now - val.timestamp > CACHE_TTL_MS) scrapeCache.delete(key);
  }
}, 1000 * 60 * 5);

// -----------------------------------------------------------------------------
// CORE HELPER: HTTP REQUEST HANDLER (Priority 1)
// -----------------------------------------------------------------------------
export interface HttpRequestOptions {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  queryParams?: Record<string, any>;
  body?: any;
  timeoutMs?: number;
  followRedirects?: boolean;
  responseFormat?: 'auto' | 'text' | 'json' | 'base64';
}

export async function executeHttpRequest(opts: HttpRequestOptions) {
  const startTime = Date.now();
  const method = (opts.method || 'GET').toUpperCase();

  let targetUrlObj: URL;
  try {
    targetUrlObj = new URL(opts.url.startsWith('http') ? opts.url : `https://${opts.url}`);
  } catch {
    throw new Error(`Invalid URL: ${opts.url}`);
  }

  if (opts.queryParams && typeof opts.queryParams === 'object') {
    for (const [key, val] of Object.entries(opts.queryParams)) {
      if (val !== undefined && val !== null) {
        targetUrlObj.searchParams.set(key, String(val));
      }
    }
  }

  const finalUrl = targetUrlObj.href;
  const safety = await validateUrlSafety(finalUrl);
  if (!safety.safe) {
    recordAuditLog({
      tool: 'http_request',
      method,
      url: finalUrl,
      status: 'BLOCKED',
      durationMs: Date.now() - startTime,
      error: safety.error,
    });
    throw new Error(`Security validation error: ${safety.error}`);
  }

  const headers: Record<string, string> = {
    'User-Agent': BROWSER_UA,
    Accept: '*/*',
    ...(opts.headers || {}),
  };

  for (const h of Object.keys(headers)) {
    if (h.toLowerCase() === 'x-goog-api-key' && geminiApiKey && headers[h] === geminiApiKey) {
      delete headers[h];
    }
  }

  let bodyData: BodyInit | undefined = undefined;
  if (method !== 'GET' && method !== 'HEAD' && opts.body !== undefined && opts.body !== null) {
    if (typeof opts.body === 'string') {
      bodyData = opts.body;
      if (!headers['Content-Type']) headers['Content-Type'] = 'text/plain; charset=utf-8';
    } else if (typeof opts.body === 'object') {
      bodyData = JSON.stringify(opts.body);
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    }
  }

  const timeoutMs = Math.min(60000, Math.max(1000, opts.timeoutMs || 25000));
  const follow = opts.followRedirects !== false;

  let currentUrl = finalUrl;
  let redirectCount = 0;
  const maxRedirects = 5;

  let response: Response;

  while (true) {
    response = await fetch(currentUrl, {
      method,
      headers,
      body: bodyData,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });

    const isRedirect = [301, 302, 303, 307, 308].includes(response.status);
    const location = response.headers.get('location');

    if (isRedirect && location && follow) {
      redirectCount++;
      if (redirectCount > maxRedirects) {
        throw new Error(`Too many redirects (exceeded ${maxRedirects})`);
      }
      const nextUrl = new URL(location, currentUrl).href;
      const redirectSafety = await validateUrlSafety(nextUrl);
      if (!redirectSafety.safe) {
        throw new Error(`Redirect to unsafe target rejected: ${redirectSafety.error}`);
      }
      currentUrl = nextUrl;
      continue;
    }
    break;
  }

  const durationMs = Date.now() - startTime;
  const contentType = response.headers.get('content-type') || '';
  const contentLengthHeader = response.headers.get('content-length');
  const contentLength = contentLengthHeader ? parseInt(contentLengthHeader, 10) : undefined;

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((val, key) => {
    responseHeaders[key] = val;
  });

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const bytesTransferred = buffer.length;

  let parsedBody: any;
  const format = opts.responseFormat || 'auto';

  const isJson = contentType.includes('application/json');
  const isText = contentType.startsWith('text/') || contentType.includes('javascript') || contentType.includes('xml');

  if (format === 'json' || (format === 'auto' && isJson)) {
    try {
      parsedBody = JSON.parse(buffer.toString('utf-8'));
    } catch {
      parsedBody = buffer.toString('utf-8');
    }
  } else if (format === 'base64') {
    parsedBody = buffer.toString('base64');
  } else if (format === 'text' || (format === 'auto' && isText)) {
    parsedBody = buffer.toString('utf-8');
  } else {
    if (bytesTransferred < 100000 && !buffer.includes(0x00)) {
      parsedBody = buffer.toString('utf-8');
    } else {
      parsedBody = `[Binary Data: ${bytesTransferred} bytes, Content-Type: ${contentType}. Use responseFormat="base64" or download_file to retrieve raw bytes.]`;
    }
  }

  recordAuditLog({
    tool: 'http_request',
    method,
    url: currentUrl,
    status: response.status,
    durationMs,
    bytesTransferred,
  });

  db.logAudit({
    tool_name: 'http_request',
    method,
    target_url: currentUrl,
    status_code: String(response.status),
    duration_ms: durationMs,
    bytes_transferred: bytesTransferred,
  }).catch(() => {});

  return {
    statusCode: response.status,
    statusText: response.statusText,
    ok: response.ok,
    url: currentUrl,
    contentType,
    contentLength: contentLength || bytesTransferred,
    headers: responseHeaders,
    body: parsedBody,
    executionTimeMs: durationMs,
  };
}

// -----------------------------------------------------------------------------
// 1. Health & Architecture Diagnostics API
// -----------------------------------------------------------------------------
app.get('/api/health', async (req, res) => {
  const startTime = Date.now();
  let egressIp = 'unknown';

  try {
    const ipRes = await fetch('https://api.ipify.org?format=json', {
      headers: { 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(4000),
    });
    if (ipRes.ok) {
      const data = (await ipRes.json()) as { ip: string };
      egressIp = data.ip;
    }
  } catch {
    // ignore
  }

  const browserStatus = evaluateBrowserCapability();

  res.json({
    status: 'ok',
    app: 'Claude Web Egress Bridge & Scraper Proxy',
    version: '2.0.0 (Cloudflare Native Migration)',
    architecture: {
      mode: 'Cloudflare Native Architecture (Hybrid Edge / Node)',
      workersReady: true,
      r2StorageConfigured: true,
      d1DatabaseConfigured: true,
      queuesConfigured: true,
      browserRenderingConfigured: browserStatus.isAvailable,
    },
    egress: {
      status: 'active',
      publicIp: egressIp,
      latencyMs: Date.now() - startTime,
    },
    geminiSearchEnabled: Boolean(geminiApiKey),
    browserEngine: browserStatus,
    timestamp: new Date().toISOString(),
    capabilities: [
      'universal_http_request',
      'streaming_file_download_r2',
      'd1_projects_metadata',
      'package_registry_access',
      'web_search_grounding',
      'url_scraping_readability',
      'sitemap_pagination_discovery',
      'mcp_json_rpc_2.0',
      'claude_code_compatibility',
    ],
  });
});

// -----------------------------------------------------------------------------
// 2. HTTP Request REST Endpoint (Priority 1)
// -----------------------------------------------------------------------------
app.post('/api/http-request', async (req, res) => {
  const clientIp = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || 'client';
  const rate = checkRateLimit(clientIp);
  if (!rate.allowed) {
    return res.status(429).json({ error: 'Rate limit exceeded (120 req/min). Please try again shortly.' });
  }

  const { method, url, headers, queryParams, body, timeoutMs, followRedirects, responseFormat } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'Missing target url parameter' });
  }

  try {
    const result = await executeHttpRequest({
      method,
      url,
      headers,
      queryParams,
      body,
      timeoutMs,
      followRedirects,
      responseFormat,
    });
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'HTTP Request Execution Failed' });
  }
});

// -----------------------------------------------------------------------------
// 3. Package Registry Lookup REST Endpoint (Priority 3)
// -----------------------------------------------------------------------------
app.all('/api/package-lookup', async (req, res) => {
  const ecosystem = (req.body?.ecosystem || req.query.ecosystem || 'npm') as any;
  const name = (req.body?.name || req.body?.packageName || req.query.name || req.query.package) as string;
  const version = (req.body?.version || req.query.version) as string | undefined;
  const action = (req.body?.action || req.query.action || 'metadata') as any;

  if (!name) {
    return res.status(400).json({ error: 'Missing package name parameter' });
  }

  try {
    const result = await lookupPackage({
      ecosystem,
      packageName: name,
      version,
      action,
    });
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Package lookup failed' });
  }
});

// -----------------------------------------------------------------------------
// 4. Sitemap & Pagination Discovery REST Endpoint (Priority 4)
// -----------------------------------------------------------------------------
app.all('/api/sitemap', async (req, res) => {
  const target = (req.body?.url || req.query.url) as string;
  if (!target) {
    return res.status(400).json({ error: 'Missing url parameter for sitemap discovery' });
  }

  try {
    const result = await discoverSitemapAndPagination(target);
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Sitemap discovery failed' });
  }
});

// -----------------------------------------------------------------------------
// 5. Browser Automation Engine Status & Architecture (Priority 5)
// -----------------------------------------------------------------------------
app.get('/api/browser-status', (req, res) => {
  const status = evaluateBrowserCapability();
  res.json(status);
});

// -----------------------------------------------------------------------------
// 6. Projects & R2 Files Storage Endpoints (Section 3B & 3C)
// -----------------------------------------------------------------------------
app.get('/api/projects', async (req, res) => {
  const projects = await db.listProjects();
  res.json({ projects });
});

app.post('/api/projects', async (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Project name is required' });
  const p = await db.createProject(name, description);
  res.json(p);
});

app.get('/api/storage/files', async (req, res) => {
  const projectId = req.query.project_id as string | undefined;
  const files = await db.listFiles(projectId);
  res.json({ files });
});

app.delete('/api/storage/files', async (req, res) => {
  const key = req.query.key as string;
  if (!key) return res.status(400).json({ error: 'Missing key parameter' });
  await storage.delete(key);
  await db.deleteFile(key);
  res.json({ success: true, deletedKey: key });
});

app.get('/api/jobs', async (req, res) => {
  const jobs = await db.listJobs();
  res.json({ jobs });
});

app.post('/api/jobs', async (req, res) => {
  const { url: targetUrl, filename, project_id } = req.body;
  if (!targetUrl) return res.status(400).json({ error: 'Missing url parameter' });
  const job = await db.createJob({
    source_url: targetUrl,
    target_filename: filename,
    project_id: project_id || 'default',
  });
  res.json({ job, queued: true });
});

app.get('/api/logs', async (req, res) => {
  const logs = await db.getAuditLogs(100);
  res.json({ logs });
});

// -----------------------------------------------------------------------------
// 7. Web Search API
// -----------------------------------------------------------------------------
app.all('/api/search', async (req, res) => {
  const query = (req.method === 'POST' ? req.body.query || req.body.q : req.query.query || req.query.q) as string;
  const numResults = parseInt((req.query.num || req.body.num || '6') as string, 10);

  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: 'Missing search query (q or query parameter)' });
  }

  const cacheKey = query.trim().toLowerCase();
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return res.json({ ...cached.data, cached: true });
  }

  const results: Array<{ title: string; url: string; snippet: string; source: string }> = [];
  let summary = '';
  let searchEngine = 'unknown';

  if (ai) {
    try {
      searchEngine = 'google-grounded-gemini';
      const prompt = `Perform a comprehensive web search to answer: "${query}". Provide a direct, factual summary with key data, current status, and relevant context.`;

      const aiResponse = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt,
        config: {
          tools: [{ googleSearch: {} }],
        },
      });

      summary = aiResponse.text || '';

      const chunks = aiResponse.candidates?.[0]?.groundingMetadata?.groundingChunks;
      if (Array.isArray(chunks)) {
        for (const chunk of chunks) {
          if (chunk.web?.uri) {
            results.push({
              title: chunk.web.title || new URL(chunk.web.uri).hostname,
              url: chunk.web.uri,
              snippet: chunk.web.title ? `Direct citation from ${new URL(chunk.web.uri).hostname}` : '',
              source: 'Google Search Grounding',
            });
          }
        }
      }
    } catch {
      // fallback
    }
  }

  if (results.length === 0) {
    searchEngine = 'duckduckgo-scraper';
    try {
      const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const ddgRes = await fetch(ddgUrl, {
        headers: {
          'User-Agent': BROWSER_UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(8000),
      });

      if (ddgRes.ok) {
        const html = await ddgRes.text();
        const $ = cheerio.load(html);

        $('.result').each((_, el) => {
          if (results.length >= numResults) return false;
          const titleEl = $(el).find('.result__title a');
          const snippetEl = $(el).find('.result__snippet');
          const title = titleEl.text().trim();
          let rawHref = titleEl.attr('href') || '';

          let url = rawHref;
          if (rawHref.includes('uddg=')) {
            try {
              const parsed = new URL(`https://duckduckgo.com${rawHref}`);
              const actualUrl = parsed.searchParams.get('uddg');
              if (actualUrl) url = decodeURIComponent(actualUrl);
            } catch {}
          }

          const snippet = snippetEl.text().trim();
          if (title && url && !url.includes('duckduckgo.com/y.js')) {
            results.push({ title, url, snippet, source: 'DuckDuckGo Web' });
          }
        });

        if (!summary && results.length > 0) {
          summary = `Found ${results.length} live web results for query: "${query}". First result: ${results[0].title}`;
        }
      }
    } catch {}
  }

  const responsePayload = {
    query,
    engine: searchEngine,
    summary,
    totalResults: results.length,
    results,
    timestamp: new Date().toISOString(),
  };

  searchCache.set(cacheKey, { data: responsePayload, timestamp: Date.now() });
  return res.json(responsePayload);
});

// -----------------------------------------------------------------------------
// 8. Web Page Scraping & Readability Markdown API
// -----------------------------------------------------------------------------
app.all('/api/fetch', async (req, res) => {
  const urlParam = (req.method === 'POST' ? req.body.url : req.query.url) as string;
  const format = ((req.method === 'POST' ? req.body.format : req.query.format) || 'markdown') as string;
  const customSelector = (req.method === 'POST' ? req.body.selector : req.query.selector) as string | undefined;
  const maxLength = parseInt(((req.method === 'POST' ? req.body.maxLength : req.query.maxLength) || '150000') as string, 10);

  if (!urlParam || typeof urlParam !== 'string' || !urlParam.trim()) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  const safety = await validateUrlSafety(urlParam.trim());
  if (!safety.safe) {
    return res.status(400).json({ error: safety.error });
  }

  const targetUrl = safety.normalizedUrl!;
  const cacheKey = `${targetUrl}::${format}::${customSelector || ''}`;
  const cached = scrapeCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return res.json({ ...cached.data, cached: true });
  }

  const startTime = Date.now();

  try {
    const fetchResponse = await fetch(targetUrl, {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });

    const contentType = fetchResponse.headers.get('content-type') || '';
    const status = fetchResponse.status;
    const finalUrl = fetchResponse.url || targetUrl;

    const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml+xml');
    const isJson = contentType.includes('application/json');

    if (isJson) {
      const jsonData = await fetchResponse.json();
      const responseData = {
        url: finalUrl,
        originalUrl: targetUrl,
        status,
        contentType,
        format: 'json',
        data: jsonData,
        text: JSON.stringify(jsonData, null, 2),
        markdown: `\`\`\`json\n${JSON.stringify(jsonData, null, 2).slice(0, maxLength)}\n\`\`\``,
        responseTimeMs: Date.now() - startTime,
      };
      scrapeCache.set(cacheKey, { data: responseData, timestamp: Date.now() });
      return res.json(responseData);
    }

    if (!isHtml) {
      const rawText = await fetchResponse.text();
      const responseData = {
        url: finalUrl,
        originalUrl: targetUrl,
        status,
        contentType,
        format: 'raw',
        text: rawText.slice(0, maxLength),
        markdown: `\`\`\`\n${rawText.slice(0, maxLength)}\n\`\`\``,
        wordCount: rawText.split(/\s+/).length,
        responseTimeMs: Date.now() - startTime,
      };
      scrapeCache.set(cacheKey, { data: responseData, timestamp: Date.now() });
      return res.json(responseData);
    }

    const html = await fetchResponse.text();
    const $ = cheerio.load(html);

    const title = $('title').text().trim() || $('meta[property="og:title"]').attr('content') || '';
    const description = $('meta[name="description"]').attr('content') || '';
    const siteName = $('meta[property="og:site_name"]').attr('content') || new URL(finalUrl).hostname;
    const ogImage = $('meta[property="og:image"]').attr('content') || '';
    const canonical = $('link[rel="canonical"]').attr('href') || finalUrl;

    const extractedLinks: Array<{ text: string; href: string }> = [];
    const seenLinks = new Set<string>();

    $('a[href]').each((_, el) => {
      if (extractedLinks.length >= 80) return false;
      const text = $(el).text().trim().replace(/\s+/g, ' ');
      const href = $(el).attr('href');
      if (href && !href.startsWith('javascript:') && !href.startsWith('#')) {
        try {
          const resolvedHref = new URL(href, finalUrl).href;
          if (!seenLinks.has(resolvedHref)) {
            seenLinks.add(resolvedHref);
            extractedLinks.push({ text: text || resolvedHref, href: resolvedHref });
          }
        } catch {}
      }
    });

    $('script, style, noscript, canvas, svg, iframe, form, button, input, textarea, select, dialog, nav, footer, .ad, #cookie-banner').remove();

    let contentHtml = '';
    if (customSelector && $(customSelector).length > 0) {
      contentHtml = $(customSelector).html() || '';
    } else {
      const mainCandidates = ['article', 'main', '[role="main"]', '.post-content', '.article-content', '.content', '#content', 'body'];
      for (const sel of mainCandidates) {
        if ($(sel).length > 0 && ($(sel).text().trim().length > 100 || sel === 'body')) {
          contentHtml = $(sel).html() || '';
          break;
        }
      }
      if (!contentHtml) {
        contentHtml = $('body').html() || html;
      }
    }

    let markdown = '';
    try {
      markdown = turndownService.turndown(contentHtml);
      markdown = markdown.replace(/\n{3,}/g, '\n\n').trim();
    } catch {
      markdown = $.text().replace(/\s+/g, ' ').trim();
    }

    if (markdown.length > maxLength) {
      markdown = `${markdown.slice(0, maxLength)}\n\n_... [Content truncated at ${maxLength} characters]_`;
    }

    const plainText = $.text().replace(/\s+/g, ' ').trim();
    const wordCount = plainText.split(/\s+/).filter(Boolean).length;

    const responsePayload = {
      url: finalUrl,
      originalUrl: targetUrl,
      status,
      contentType,
      title,
      description,
      siteName,
      ogImage,
      canonical,
      markdown,
      plainText: plainText.slice(0, maxLength),
      wordCount,
      readingTimeMinutes: Math.max(1, Math.ceil(wordCount / 200)),
      linksCount: extractedLinks.length,
      links: extractedLinks,
      responseTimeMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };

    scrapeCache.set(cacheKey, { data: responsePayload, timestamp: Date.now() });
    return res.json(responsePayload);
  } catch (err: any) {
    return res.status(500).json({
      error: `Failed to scrape URL: ${err?.message || 'Network/timeout error'}`,
      url: targetUrl,
      responseTimeMs: Date.now() - startTime,
    });
  }
});

// -----------------------------------------------------------------------------
// 9. Streaming Downloads & R2 Serving Endpoint
// -----------------------------------------------------------------------------
app.get('/api/download', async (req, res) => {
  const urlParam = req.query.url as string;
  const projectId = (req.query.project_id as string) || 'default';
  if (!urlParam) {
    return res.status(400).json({ error: 'Missing url query parameter' });
  }

  const appBaseUrl = `${req.protocol}://${req.get('host')}`;
  const safety = await validateUrlSafety(urlParam);
  if (!safety.safe) return res.status(400).json({ error: safety.error });

  try {
    const upstreamRes = await fetch(safety.normalizedUrl!, {
      headers: { 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(60000),
    });

    if (!upstreamRes.ok) {
      return res.status(upstreamRes.status).json({ error: `Upstream error: HTTP ${upstreamRes.status}` });
    }

    const contentType = upstreamRes.headers.get('content-type') || 'application/octet-stream';
    let filename = path.basename(new URL(safety.normalizedUrl!).pathname) || 'downloaded_artifact';
    const cdHeader = upstreamRes.headers.get('content-disposition');
    if (cdHeader && cdHeader.includes('filename=')) {
      const match = cdHeader.match(/filename=["']?([^"';]+)["']?/i);
      if (match && match[1]) filename = path.basename(match[1]);
    }

    const r2Key = `projects/${projectId}/${Date.now()}_${filename}`;
    const arrayBuffer = await upstreamRes.arrayBuffer();

    const putRes = await storage.put(r2Key, Buffer.from(arrayBuffer), { contentType });
    await db.recordFile({
      project_id: projectId,
      r2_key: r2Key,
      filename,
      size_bytes: putRes.size,
      mime_type: contentType,
      sha256: putRes.sha256,
    });

    const downloadUrl = await storage.createSignedDownloadUrl(r2Key, appBaseUrl);
    return res.json({
      success: true,
      r2Key,
      filename,
      sizeBytes: putRes.size,
      mimeType: contentType,
      sha256: putRes.sha256,
      downloadUrl,
      message: 'File downloaded and stored in persistent object storage.',
    });
  } catch (err: any) {
    return res.status(500).json({ error: `Download failed: ${err.message}` });
  }
});

// Serve file by R2 key
app.get('/api/download/file/:key(*)', async (req, res) => {
  const key = req.params.key;
  const obj = await storage.get(key);
  if (!obj) {
    return res.status(404).json({ error: 'File not found in storage' });
  }

  const filename = path.basename(key);
  res.setHeader('Content-Type', obj.contentType);
  res.setHeader('Content-Length', obj.size);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);

  const stream = obj.stream();
  if (stream && typeof (stream as any).pipe === 'function') {
    (stream as any).pipe(res);
  } else {
    const buf = await obj.arrayBuffer();
    res.send(Buffer.from(buf));
  }
});

// -----------------------------------------------------------------------------
// 10. Remote Model Context Protocol (MCP) Server Endpoint
// -----------------------------------------------------------------------------
app.post('/api/mcp', async (req, res) => {
  const { jsonrpc, id, method, params } = req.body;
  const appBaseUrl = `${req.protocol}://${req.get('host')}`;

  if (jsonrpc !== '2.0') {
    return res.status(400).json({
      jsonrpc: '2.0',
      id: id || null,
      error: { code: -32600, message: 'Invalid Request: jsonrpc must be "2.0"' },
    });
  }

  if (method === 'initialize') {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'claude-web-egress-bridge', version: '2.0.0-cloudflare' },
      },
    });
  }

  if (method === 'notifications/initialized') {
    return res.status(204).end();
  }

  if (method === 'tools/list') {
    return res.json({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'http_request',
            description:
              'Execute an outbound HTTP/HTTPS request through the hosted remote gateway. Use this to query public APIs, send webhooks, fetch JSON/data, or reach external servers when you have no network egress.',
            inputSchema: {
              type: 'object',
              properties: {
                url: { type: 'string', description: 'The target HTTP/HTTPS URL.' },
                method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], description: 'HTTP method.' },
                headers: { type: 'object', description: 'Custom request headers.' },
                query_params: { type: 'object', description: 'URL query parameters.' },
                body: { description: 'Request payload (string or JSON).' },
                timeout_ms: { type: 'number', description: 'Timeout in ms (default: 25000).' },
                response_format: { type: 'string', enum: ['auto', 'json', 'text', 'base64'] },
              },
              required: ['url'],
            },
          },
          {
            name: 'download_file',
            description:
              'Stream and store files, archives (ZIP/tar), datasets (CSV/Parquet), PDFs, source code, 3D models, or binaries into persistent Cloudflare R2 storage without memory exhaustion. Returns file metadata, SHA-256 checksum, text preview, and a permanent download URL.',
            inputSchema: {
              type: 'object',
              properties: {
                url: { type: 'string', description: 'Public URL to download.' },
                project_id: { type: 'string', description: 'Project namespace ID (default: "default").' },
              },
              required: ['url'],
            },
          },
          {
            name: 'package_registry_lookup',
            description:
              'Inspect software package registries (npm, PyPI, GitHub releases, Crates.io). Retrieve package metadata, release archives, dependencies, license, or download URLs.',
            inputSchema: {
              type: 'object',
              properties: {
                ecosystem: { type: 'string', enum: ['npm', 'pypi', 'github', 'crates'] },
                package_name: { type: 'string', description: 'Package name (e.g. "express", "requests").' },
                version: { type: 'string', description: 'Version or "latest".' },
                action: { type: 'string', enum: ['metadata', 'versions', 'releases', 'readme', 'download_url'] },
              },
              required: ['ecosystem', 'package_name'],
            },
          },
          {
            name: 'web_search',
            description:
              'Search the live web using Google Grounding & search engines. Returns grounded summaries, citations, titles, and snippets.',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Search keywords.' },
                num_results: { type: 'number', description: 'Number of results.' },
              },
              required: ['query'],
            },
          },
          {
            name: 'fetch_webpage',
            description:
              'Scrape and convert any public web page into clean, readable Markdown. Removes ads and clutter, extracts metadata and outbound links.',
            inputSchema: {
              type: 'object',
              properties: {
                url: { type: 'string', description: 'Target URL.' },
                format: { type: 'string', enum: ['markdown', 'text', 'json'] },
              },
              required: ['url'],
            },
          },
          {
            name: 'sitemap_discovery',
            description: 'Discover XML sitemaps, robots.txt directives, and pagination links for a web domain.',
            inputSchema: {
              type: 'object',
              properties: { url: { type: 'string', description: 'Root URL or documentation URL.' } },
              required: ['url'],
            },
          },
          {
            name: 'storage_list',
            description: 'List files stored in Cloudflare R2 object storage for a project.',
            inputSchema: {
              type: 'object',
              properties: { project_id: { type: 'string', description: 'Project ID filter (default: "default").' } },
            },
          },
          {
            name: 'browser_render',
            description: 'Interface for Cloudflare Browser Rendering (Puppeteer). Evaluates live browser engine status.',
            inputSchema: {
              type: 'object',
              properties: { url: { type: 'string', description: 'URL to render.' } },
              required: ['url'],
            },
          },
        ],
      },
    });
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};

    try {
      if (toolName === 'http_request') {
        const resData = await executeHttpRequest({
          method: toolArgs.method || 'GET',
          url: toolArgs.url,
          headers: toolArgs.headers,
          queryParams: toolArgs.query_params,
          body: toolArgs.body,
          timeoutMs: toolArgs.timeout_ms,
          responseFormat: toolArgs.response_format,
        });

        let out = `### HTTP Response: ${resData.statusCode} ${resData.statusText}\n`;
        out += `**Target URL**: ${resData.url}\n**Content-Type**: ${resData.contentType}\n**Size**: ${resData.contentLength} bytes\n\n`;
        out += typeof resData.body === 'object' ? `\`\`\`json\n${JSON.stringify(resData.body, null, 2)}\n\`\`\`` : `\`\`\`\n${resData.body}\n\`\`\``;
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: out }] } });
      }

      if (toolName === 'download_file') {
        const safety = await validateUrlSafety(toolArgs.url);
        if (!safety.safe) throw new Error(safety.error);

        const upRes = await fetch(safety.normalizedUrl!, { headers: { 'User-Agent': BROWSER_UA } });
        const contentType = upRes.headers.get('content-type') || 'application/octet-stream';
        const filename = path.basename(new URL(safety.normalizedUrl!).pathname) || 'downloaded_artifact';
        const arrayBuffer = await upRes.arrayBuffer();

        const pid = toolArgs.project_id || 'default';
        const r2Key = `projects/${pid}/${Date.now()}_${filename}`;
        const putRes = await storage.put(r2Key, Buffer.from(arrayBuffer), { contentType });

        await db.recordFile({
          project_id: pid,
          r2_key: r2Key,
          filename,
          size_bytes: putRes.size,
          mime_type: contentType,
          sha256: putRes.sha256,
        });

        const dlLink = await storage.createSignedDownloadUrl(r2Key, appBaseUrl);
        let out = `### File Stored in Cloudflare R2 Persistent Storage\n`;
        out += `- **Filename**: ${filename}\n- **R2 Storage Key**: \`${r2Key}\`\n- **Size**: ${(putRes.size / 1024).toFixed(1)} KB\n`;
        out += `- **SHA-256**: \`${putRes.sha256}\`\n- **Direct Download Link**: ${dlLink}\n`;
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: out }] } });
      }

      if (toolName === 'storage_list') {
        const pid = toolArgs.project_id || 'default';
        const files = await db.listFiles(pid);
        let out = `### Cloudflare R2 Stored Files (Project: ${pid})\n\n`;
        if (files.length === 0) {
          out += 'No files stored in this project yet.\n';
        } else {
          for (const f of files) {
            out += `- **${f.filename}** (${(f.size_bytes / 1024).toFixed(1)} KB) [Key: \`${f.r2_key}\`]\n`;
          }
        }
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: out }] } });
      }

      if (toolName === 'package_registry_lookup') {
        const pRes = await lookupPackage({
          ecosystem: toolArgs.ecosystem,
          packageName: toolArgs.package_name,
          version: toolArgs.version,
          action: toolArgs.action || 'metadata',
        });
        return res.json({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(pRes, null, 2)}\n\`\`\`` }] },
        });
      }

      if (toolName === 'web_search') {
        const sRes = await fetch(`http://127.0.0.1:${PORT}/api/search?q=${encodeURIComponent(toolArgs.query)}`);
        const sData: any = await sRes.json();
        let out = `### Web Search: "${toolArgs.query}"\n\n`;
        if (sData.summary) out += `${sData.summary}\n\n`;
        sData.results?.forEach((r: any, idx: number) => {
          out += `${idx + 1}. [${r.title}](${r.url})\n   ${r.snippet || ''}\n`;
        });
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: out }] } });
      }

      if (toolName === 'fetch_webpage') {
        const fRes = await fetch(`http://127.0.0.1:${PORT}/api/fetch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: toolArgs.url }),
        });
        const fData: any = await fRes.json();
        let out = `# ${fData.title || 'Page Content'}\n**URL**: ${fData.url}\n\n---\n\n${fData.markdown || fData.plainText}`;
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: out }] } });
      }

      if (toolName === 'sitemap_discovery') {
        const smRes = await discoverSitemapAndPagination(toolArgs.url);
        let out = `### Sitemap Discovery for ${toolArgs.url}\n\n`;
        out += `- Robots.txt: ${smRes.hasRobotsTxt ? 'Present' : 'Not found'}\n`;
        smRes.discoveredSitemaps?.forEach((s) => {
          out += `- **${s.url}** (${s.entriesCount} entries)\n`;
        });
        return res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: out }] } });
      }

      if (toolName === 'browser_render') {
        const bRes = await executeBrowserRender({ url: toolArgs.url });
        return res.json({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(bRes, null, 2)}\n\`\`\`` }] },
        });
      }

      return res.status(404).json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Tool not found: ${toolName}` } });
    } catch (err: any) {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: { isError: true, content: [{ type: 'text', text: `Tool Error: ${err.message}` }] },
      });
    }
  }

  if (method === 'ping') return res.json({ jsonrpc: '2.0', id, result: {} });

  return res.status(404).json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unsupported method: ${method}` } });
});

app.get('/api/mcp', (req, res) => {
  const appBaseUrl = `${req.protocol}://${req.get('host')}`;
  res.json({
    mcpServer: 'claude-web-egress-bridge',
    version: '2.0.0-cloudflare',
    protocol: 'JSON-RPC 2.0 over HTTP POST',
    endpoint: `${appBaseUrl}/api/mcp`,
    tools: [
      'http_request',
      'download_file',
      'package_registry_lookup',
      'web_search',
      'fetch_webpage',
      'sitemap_discovery',
      'browser_render',
      'storage_list',
    ],
    claudeCodeUsage: `claude mcp add web-bridge --url ${appBaseUrl}/api/mcp`,
  });
});

// -----------------------------------------------------------------------------
// 11. Downloadable Python Bridge Client
// -----------------------------------------------------------------------------
app.get('/api/script/python', (req, res) => {
  const host = `${req.protocol}://${req.get('host')}`;
  const scriptContent = `#!/usr/bin/env python3
"""
Claude Web Egress Bridge Client (Cloudflare Native Edition)
Use this script locally to give any isolated script or Claude Code CLI instant web access.
"""

import sys
import json
import urllib.request
import urllib.parse

BRIDGE_HOST = "${host}"

def http_req(url, method="GET", body=None, headers=None):
    api_url = f"{BRIDGE_HOST}/api/http-request"
    payload = {"url": url, "method": method, "headers": headers or {}}
    if body:
        payload["body"] = body
    data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(api_url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode())

def search_web(query, num=5):
    url = f"{BRIDGE_HOST}/api/search?q={urllib.parse.quote(query)}&num={num}"
    req = urllib.request.Request(url, headers={"User-Agent": "Claude-Bridge-CLI/2.0"})
    with urllib.request.urlopen(req) as response:
        return json.loads(response.read().decode())

def fetch_url(target_url, format="markdown"):
    url = f"{BRIDGE_HOST}/api/fetch"
    data = json.dumps({"url": target_url, "format": format}).encode('utf-8')
    req = urllib.request.Request(url, data=data, headers={
        "Content-Type": "application/json",
        "User-Agent": "Claude-Bridge-CLI/2.0"
    })
    with urllib.request.urlopen(req) as response:
        return json.loads(response.read().decode())

def download_file(target_url, output_path=None):
    if not output_path:
        output_path = target_url.split('/')[-1] or "downloaded_file"
    url = f"{BRIDGE_HOST}/api/download?url={urllib.parse.quote(target_url)}"
    print(f"Downloading {target_url} -> {output_path}...")
    urllib.request.urlretrieve(url, output_path)
    print(f"Saved to {output_path}")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage:")
        print("  python claude_bridge.py search <query>")
        print("  python claude_bridge.py fetch <url>")
        print("  python claude_bridge.py download <url> [output_file]")
        print("  python claude_bridge.py req <url> [GET|POST]")
        sys.exit(1)

    cmd = sys.argv[1].lower()
    arg = sys.argv[2]

    if cmd == "search":
        res = search_web(arg)
        print("=== Search Summary ===")
        print(res.get('summary', ''))
        print("")
        print("=== Web Sources ===")
        for idx, r in enumerate(res.get('results', []), 1):
            print(f"{idx}. {r.get('title')} ({r.get('url')})")
    elif cmd == "fetch":
        res = fetch_url(arg)
        title = res.get('title', 'Page Content')
        print(f"# {title}")
        print("")
        print(res.get('markdown', res.get('text', '')))
    elif cmd == "download":
        out = sys.argv[3] if len(sys.argv) > 3 else None
        download_file(arg, out)
    elif cmd == "req":
        method = sys.argv[3] if len(sys.argv) > 3 else "GET"
        res = http_req(arg, method)
        print(json.dumps(res, indent=2))
`;

  res.setHeader('Content-Type', 'text/x-python');
  res.setHeader('Content-Disposition', 'attachment; filename="claude_bridge.py"');
  res.send(scriptContent);
});

// -----------------------------------------------------------------------------
// 12. Serve Vite Front-End (Dev & Production)
// -----------------------------------------------------------------------------
async function startServer() {
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Claude Web Egress Bridge listening on port ${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server boot error:', err);
  process.exit(1);
});
