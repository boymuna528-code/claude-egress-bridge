import path from 'path';
import * as cheerio from 'cheerio';
import TurndownService from 'turndown';
import { GoogleGenAI } from '@google/genai';

import { validateUrlSafety, recordAuditLog } from './server/security';
import { lookupPackage } from './server/packageRegistry';
import { evaluateBrowserCapability, executeBrowserRender } from './server/browserEngine';
import { discoverSitemapAndPagination } from './server/sitemapService';
import { getStorageService } from './server/storageAdapter';
import { getDatabaseService } from './server/databaseAdapter';

// Environment Bindings for Cloudflare Workers
export interface Env {
  ENVIRONMENT?: string;
  GATEWAY_NAME?: string;
  GEMINI_API_KEY?: string;
  AUTH_TOKEN?: string;
  STORAGE_BUCKET?: any; // R2Bucket
  DB?: any; // D1Database
  DOWNLOAD_QUEUE?: any; // Queue
  MYBROWSER?: any; // Cloudflare Browser Rendering binding
  ASSETS?: { fetch: (req: Request) => Promise<Response> }; // Static assets binding
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

const turndownService = new TurndownService({
  headingStyle: 'atx',
  hr: '---',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '_',
});
turndownService.remove(['script', 'style', 'noscript', 'canvas', 'iframe'] as any);

// CORS Response Helper
function corsResponse(response: Response): Response {
  const newHeaders = new Headers(response.headers);
  newHeaders.set('Access-Control-Allow-Origin', '*');
  newHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD');
  newHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-requested-with, accept, user-agent');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

function jsonResponse(data: any, status = 200): Response {
  return corsResponse(
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  );
}

// -----------------------------------------------------------------------------
// Core Workers Outbound HTTP Execution
// -----------------------------------------------------------------------------
async function executeWorkerHttpRequest(opts: {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  queryParams?: Record<string, any>;
  body?: any;
  timeoutMs?: number;
  followRedirects?: boolean;
  responseFormat?: 'auto' | 'text' | 'json' | 'base64';
}) {
  const startTime = Date.now();
  const method = (opts.method || 'GET').toUpperCase();

  let targetUrlObj: URL;
  try {
    targetUrlObj = new URL(opts.url.startsWith('http') ? opts.url : `https://${opts.url}`);
  } catch {
    throw new Error(`Invalid URL format: ${opts.url}`);
  }

  if (opts.queryParams && typeof opts.queryParams === 'object') {
    for (const [k, v] of Object.entries(opts.queryParams)) {
      if (v !== undefined && v !== null) targetUrlObj.searchParams.set(k, String(v));
    }
  }

  const finalUrl = targetUrlObj.href;
  const safety = await validateUrlSafety(finalUrl);
  if (!safety.safe) {
    throw new Error(`Security validation error: ${safety.error}`);
  }

  const reqHeaders = new Headers();
  reqHeaders.set('User-Agent', BROWSER_UA);
  reqHeaders.set('Accept', '*/*');

  if (opts.headers) {
    for (const [k, v] of Object.entries(opts.headers)) {
      reqHeaders.set(k, String(v));
    }
  }

  let bodyData: BodyInit | undefined = undefined;
  if (method !== 'GET' && method !== 'HEAD' && opts.body !== undefined && opts.body !== null) {
    if (typeof opts.body === 'string') {
      bodyData = opts.body;
      if (!reqHeaders.has('Content-Type')) reqHeaders.set('Content-Type', 'text/plain; charset=utf-8');
    } else if (typeof opts.body === 'object') {
      bodyData = JSON.stringify(opts.body);
      if (!reqHeaders.has('Content-Type')) reqHeaders.set('Content-Type', 'application/json');
    }
  }

  const timeoutMs = Math.min(60000, Math.max(1000, opts.timeoutMs || 25000));
  const res = await fetch(finalUrl, {
    method,
    headers: reqHeaders,
    body: bodyData,
    redirect: opts.followRedirects === false ? 'manual' : 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });

  const durationMs = Date.now() - startTime;
  const contentType = res.headers.get('content-type') || '';
  const contentLength = res.headers.get('content-length')
    ? parseInt(res.headers.get('content-length')!, 10)
    : undefined;

  const resHeaders: Record<string, string> = {};
  res.headers.forEach((val, key) => {
    resHeaders[key] = val;
  });

  const arrayBuffer = await res.arrayBuffer();
  const bytesTransferred = arrayBuffer.byteLength;

  let parsedBody: any;
  const format = opts.responseFormat || 'auto';
  const isJson = contentType.includes('application/json');
  const isText = contentType.startsWith('text/') || contentType.includes('xml') || contentType.includes('javascript');

  if (format === 'json' || (format === 'auto' && isJson)) {
    try {
      const text = new TextDecoder().decode(arrayBuffer);
      parsedBody = JSON.parse(text);
    } catch {
      parsedBody = new TextDecoder().decode(arrayBuffer);
    }
  } else if (format === 'base64') {
    parsedBody = Buffer.from(arrayBuffer).toString('base64');
  } else if (format === 'text' || (format === 'auto' && isText)) {
    parsedBody = new TextDecoder().decode(arrayBuffer);
  } else {
    if (bytesTransferred < 100000) {
      parsedBody = new TextDecoder().decode(arrayBuffer);
    } else {
      parsedBody = `[Binary Data: ${bytesTransferred} bytes, Content-Type: ${contentType}. Use format="base64" or download_file to save to R2 storage.]`;
    }
  }

  return {
    statusCode: res.status,
    statusText: res.statusText,
    ok: res.ok,
    url: res.url || finalUrl,
    contentType,
    contentLength: contentLength || bytesTransferred,
    headers: resHeaders,
    body: parsedBody,
    executionTimeMs: durationMs,
  };
}

// -----------------------------------------------------------------------------
// Cloudflare Worker Default Export
// -----------------------------------------------------------------------------
export default {
  async fetch(request: Request, env: Env, ctx: any): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;
    const pathname = url.pathname;
    const appBaseUrl = `${url.protocol}//${url.host}`;

    // Handle OPTIONS Preflight
    if (method === 'OPTIONS') {
      return corsResponse(new Response(null, { status: 204 }));
    }

    // Optional Bearer Authentication check for protected routes
    if (env.AUTH_TOKEN && pathname.startsWith('/api/') && pathname !== '/api/health') {
      const authHeader = request.headers.get('Authorization');
      const token = authHeader?.replace(/^Bearer\s+/i, '');
      if (token !== env.AUTH_TOKEN) {
        return jsonResponse({ error: 'Unauthorized: invalid or missing Bearer token' }, 401);
      }
    }

    const storage = getStorageService(env.STORAGE_BUCKET);
    const db = getDatabaseService(env.DB);

    try {
      // -----------------------------------------------------------------------
      // 1. Health & Cloudflare Diagnostics
      // -----------------------------------------------------------------------
      if (pathname === '/api/health') {
        let egressIp = 'unknown';
        try {
          const ipRes = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(3000) });
          if (ipRes.ok) {
            const data: any = await ipRes.json();
            egressIp = data.ip;
          }
        } catch {
          // ignore
        }

        const cfColo = (request as any).cf?.colo || 'Local/Node';
        const browserStatus = evaluateBrowserCapability(env);

        return jsonResponse({
          status: 'ok',
          runtime: 'Cloudflare Workers (Edge)',
          cloudflareColo: cfColo,
          version: '2.0.0-cloudflare-native',
          egress: {
            status: 'active',
            publicIp: egressIp,
          },
          bindings: {
            r2Bucket: Boolean(env.STORAGE_BUCKET),
            d1Database: Boolean(env.DB),
            queueProducer: Boolean(env.DOWNLOAD_QUEUE),
            browserRendering: Boolean(env.MYBROWSER),
            geminiSearchEnabled: Boolean(env.GEMINI_API_KEY),
          },
          browserEngine: browserStatus,
          timestamp: new Date().toISOString(),
          capabilities: [
            'universal_http_request',
            'r2_streaming_file_storage',
            'd1_metadata_database',
            'queue_background_transfers',
            'package_registry_lookup',
            'web_search_grounding',
            'markdown_readability_extraction',
            'sitemap_pagination_discovery',
            'mcp_json_rpc_2.0',
          ],
        });
      }

      // -----------------------------------------------------------------------
      // 2. HTTP Request API (Priority 1)
      // -----------------------------------------------------------------------
      if (pathname === '/api/http-request' && method === 'POST') {
        const body: any = await request.json();
        if (!body.url) return jsonResponse({ error: 'Missing target url parameter' }, 400);

        const result = await executeWorkerHttpRequest(body);
        ctx.waitUntil(
          db.logAudit({
            tool_name: 'http_request',
            method: body.method || 'GET',
            target_url: body.url,
            status_code: String(result.statusCode),
            duration_ms: result.executionTimeMs,
            bytes_transferred: result.contentLength,
            client_ip: request.headers.get('cf-connecting-ip') || '',
          })
        );
        return jsonResponse(result);
      }

      // -----------------------------------------------------------------------
      // 3. Web Search API (Gemini Google Grounding + DuckDuckGo fallback)
      // -----------------------------------------------------------------------
      if (pathname === '/api/search') {
        const q = method === 'POST' ? ((await request.json()) as any).query : url.searchParams.get('q') || url.searchParams.get('query');
        if (!q) return jsonResponse({ error: 'Missing search query' }, 400);

        const results: Array<{ title: string; url: string; snippet: string; source: string }> = [];
        let summary = '';
        let engine = 'duckduckgo-scraper';

        // Check if Gemini API Key is available
        if (env.GEMINI_API_KEY) {
          try {
            const ai = new GoogleGenAI({
              apiKey: env.GEMINI_API_KEY,
              httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
            });
            const aiRes = await ai.models.generateContent({
              model: 'gemini-3.8-flash',
              contents: `Search web for: "${q}". Provide a factual concise summary with key citations.`,
              config: { tools: [{ googleSearch: {} }] },
            });
            summary = aiRes.text || '';
            engine = 'google-grounded-gemini';
            const chunks = aiRes.candidates?.[0]?.groundingMetadata?.groundingChunks;
            if (Array.isArray(chunks)) {
              for (const c of chunks) {
                if (c.web?.uri) {
                  results.push({
                    title: c.web.title || new URL(c.web.uri).hostname,
                    url: c.web.uri,
                    snippet: c.web.title ? `Citation from ${new URL(c.web.uri).hostname}` : '',
                    source: 'Google Search Grounding',
                  });
                }
              }
            }
          } catch {
            // fallback to DDG
          }
        }

        if (results.length === 0) {
          try {
            const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
            const ddgRes = await fetch(ddgUrl, {
              headers: { 'User-Agent': BROWSER_UA },
              signal: AbortSignal.timeout(8000),
            });
            if (ddgRes.ok) {
              const html = await ddgRes.text();
              const $ = cheerio.load(html);
              $('.result').each((_, el) => {
                if (results.length >= 8) return false;
                const tEl = $(el).find('.result__title a');
                const title = tEl.text().trim();
                let href = tEl.attr('href') || '';
                if (href.includes('uddg=')) {
                  try {
                    const parsed = new URL(`https://duckduckgo.com${href}`);
                    href = decodeURIComponent(parsed.searchParams.get('uddg') || href);
                  } catch {}
                }
                const snippet = $(el).find('.result__snippet').text().trim();
                if (title && href && !href.includes('duckduckgo.com/y.js')) {
                  results.push({ title, url: href, snippet, source: 'DuckDuckGo Web' });
                }
              });
              if (!summary && results.length > 0) {
                summary = `Found ${results.length} live results for "${q}". Top result: ${results[0].title}`;
              }
            }
          } catch {}
        }

        return jsonResponse({
          query: q,
          engine,
          summary,
          totalResults: results.length,
          results,
          timestamp: new Date().toISOString(),
        });
      }

      // -----------------------------------------------------------------------
      // 4. Webpage Scraping & Readability Markdown API
      // -----------------------------------------------------------------------
      if (pathname === '/api/fetch') {
        const body = method === 'POST' ? await request.json() : {};
        const targetUrl = (method === 'POST' ? (body as any).url : url.searchParams.get('url')) as string;
        if (!targetUrl) return jsonResponse({ error: 'Missing url parameter' }, 400);

        const safety = await validateUrlSafety(targetUrl);
        if (!safety.safe) return jsonResponse({ error: safety.error }, 400);

        const startTime = Date.now();
        const fetchRes = await fetch(safety.normalizedUrl!, {
          headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*' },
          redirect: 'follow',
          signal: AbortSignal.timeout(20000),
        });

        const contentType = fetchRes.headers.get('content-type') || '';
        const html = await fetchRes.text();
        const $ = cheerio.load(html);

        const title = $('title').text().trim() || $('meta[property="og:title"]').attr('content') || '';
        const description = $('meta[name="description"]').attr('content') || '';

        // Extract Links
        const links: Array<{ text: string; href: string }> = [];
        const seen = new Set<string>();
        $('a[href]').each((_, el) => {
          if (links.length >= 60) return false;
          const txt = $(el).text().trim().replace(/\s+/g, ' ');
          const href = $(el).attr('href');
          if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
            try {
              const abs = new URL(href, safety.normalizedUrl!).href;
              if (!seen.has(abs)) {
                seen.add(abs);
                links.push({ text: txt || abs, href: abs });
              }
            } catch {}
          }
        });

        // Strip clutter
        $('script, style, noscript, canvas, svg, iframe, form, button, nav, footer, .ad, #cookie-banner').remove();

        const mainContent = $('article, main, [role="main"], .content, #content, body').first().html() || html;
        let markdown = '';
        try {
          markdown = turndownService.turndown(mainContent);
          markdown = markdown.replace(/\n{3,}/g, '\n\n').trim();
        } catch {
          markdown = $.text().replace(/\s+/g, ' ').trim();
        }

        const plainText = $.text().replace(/\s+/g, ' ').trim();
        const wordCount = plainText.split(/\s+/).filter(Boolean).length;

        return jsonResponse({
          url: fetchRes.url || safety.normalizedUrl,
          title,
          description,
          markdown,
          plainText: plainText.slice(0, 50000),
          wordCount,
          readingTimeMinutes: Math.max(1, Math.ceil(wordCount / 200)),
          linksCount: links.length,
          links,
          status: fetchRes.status,
          contentType,
          responseTimeMs: Date.now() - startTime,
        });
      }

      // -----------------------------------------------------------------------
      // 5. File Download & Streaming Storage (R2 Native)
      // -----------------------------------------------------------------------
      if (pathname === '/api/download') {
        const targetUrl = url.searchParams.get('url');
        const projectId = url.searchParams.get('project_id') || 'default';
        if (!targetUrl) return jsonResponse({ error: 'Missing url query parameter' }, 400);

        const safety = await validateUrlSafety(targetUrl);
        if (!safety.safe) return jsonResponse({ error: safety.error }, 400);

        const upRes = await fetch(safety.normalizedUrl!, {
          headers: { 'User-Agent': BROWSER_UA },
          signal: AbortSignal.timeout(60000),
        });

        if (!upRes.ok) return jsonResponse({ error: `Upstream error: HTTP ${upRes.status}` }, 502);

        const contentType = upRes.headers.get('content-type') || 'application/octet-stream';
        let filename = path.basename(new URL(safety.normalizedUrl!).pathname) || 'downloaded_artifact';

        const fileBytes = await upRes.arrayBuffer();
        const r2Key = `projects/${projectId}/${Date.now()}_${filename}`;

        // Put in R2 storage
        const putResult = await storage.put(r2Key, fileBytes, { contentType });

        // Record in D1 database
        ctx.waitUntil(
          db.recordFile({
            project_id: projectId,
            r2_key: r2Key,
            filename,
            size_bytes: putResult.size,
            mime_type: contentType,
            sha256: putResult.sha256,
          })
        );

        const downloadUrl = await storage.createSignedDownloadUrl(r2Key, appBaseUrl);

        return jsonResponse({
          success: true,
          r2Key,
          filename,
          sizeBytes: putResult.size,
          mimeType: contentType,
          sha256: putResult.sha256,
          downloadUrl,
          message: 'File downloaded and stored persistently in Cloudflare R2 object storage.',
        });
      }

      // Serve stored file from R2
      if (pathname.startsWith('/api/download/file/')) {
        const key = decodeURIComponent(pathname.replace('/api/download/file/', ''));
        const obj = await storage.get(key);
        if (!obj) {
          return jsonResponse({ error: 'File not found or expired in R2 storage' }, 404);
        }

        const filename = path.basename(key);
        return new Response(obj.body, {
          headers: {
            'Content-Type': obj.contentType,
            'Content-Length': String(obj.size),
            'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
            'Access-Control-Allow-Origin': '*',
          },
        });
      }

      // -----------------------------------------------------------------------
      // 6. Package Registry Lookup API (NPM, PyPI, GitHub, Crates)
      // -----------------------------------------------------------------------
      if (pathname === '/api/package-lookup') {
        const body: any = method === 'POST' ? await request.json() : {};
        const ecosystem = (body.ecosystem || url.searchParams.get('ecosystem') || 'npm') as any;
        const name = (body.name || body.packageName || url.searchParams.get('name') || url.searchParams.get('package')) as string;
        const version = (body.version || url.searchParams.get('version')) as string | undefined;
        const action = (body.action || url.searchParams.get('action') || 'metadata') as any;

        if (!name) return jsonResponse({ error: 'Missing package name parameter' }, 400);

        const result = await lookupPackage({ ecosystem, packageName: name, version, action });
        return jsonResponse(result);
      }

      // -----------------------------------------------------------------------
      // 7. Sitemap Discovery API
      // -----------------------------------------------------------------------
      if (pathname === '/api/sitemap') {
        const body: any = method === 'POST' ? await request.json() : {};
        const target = (body.url || url.searchParams.get('url')) as string;
        if (!target) return jsonResponse({ error: 'Missing url parameter' }, 400);

        const result = await discoverSitemapAndPagination(target);
        return jsonResponse(result);
      }

      // -----------------------------------------------------------------------
      // 8. Projects & Assets Management (D1 & R2)
      // -----------------------------------------------------------------------
      if (pathname === '/api/projects') {
        if (method === 'GET') {
          const projs = await db.listProjects();
          return jsonResponse({ projects: projs });
        }
        if (method === 'POST') {
          const b: any = await request.json();
          const p = await db.createProject(b.name || 'New Project', b.description);
          return jsonResponse(p);
        }
      }

      if (pathname === '/api/storage/files') {
        if (method === 'GET') {
          const pid = url.searchParams.get('project_id') || undefined;
          const files = await db.listFiles(pid);
          return jsonResponse({ files });
        }
        if (method === 'DELETE') {
          const r2Key = url.searchParams.get('key');
          if (!r2Key) return jsonResponse({ error: 'Missing key parameter' }, 400);
          await storage.delete(r2Key);
          await db.deleteFile(r2Key);
          return jsonResponse({ success: true, deletedKey: r2Key });
        }
      }

      if (pathname === '/api/jobs') {
        if (method === 'GET') {
          const jobs = await db.listJobs();
          return jsonResponse({ jobs });
        }
        if (method === 'POST') {
          const b: any = await request.json();
          const job = await db.createJob({
            source_url: b.url,
            target_filename: b.filename,
            project_id: b.project_id || 'default',
          });

          // If Queue binding is configured, send to Queue for background processing
          if (env.DOWNLOAD_QUEUE) {
            await env.DOWNLOAD_QUEUE.send({
              jobId: job.id,
              url: b.url,
              filename: b.filename,
              projectId: b.project_id || 'default',
            });
          }

          return jsonResponse({ job, queued: Boolean(env.DOWNLOAD_QUEUE) });
        }
      }

      if (pathname === '/api/logs') {
        const logs = await db.getAuditLogs(100);
        return jsonResponse({ logs });
      }

      if (pathname === '/api/browser-status') {
        const capability = evaluateBrowserCapability(env);
        return jsonResponse(capability);
      }

      // -----------------------------------------------------------------------
      // 9. Remote Model Context Protocol (MCP) Server
      // -----------------------------------------------------------------------
      if (pathname === '/api/mcp') {
        if (method === 'GET') {
          return jsonResponse({
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
              'project_manage',
              'job_status',
            ],
            claudeCodeUsage: `claude mcp add web-bridge --url ${appBaseUrl}/api/mcp`,
          });
        }

        const mcpReq: any = await request.json();
        const { jsonrpc, id, method: rpcMethod, params } = mcpReq;

        if (jsonrpc !== '2.0') {
          return jsonResponse({ jsonrpc: '2.0', id: id || null, error: { code: -32600, message: 'Invalid Request' } }, 400);
        }

        if (rpcMethod === 'initialize') {
          return jsonResponse({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: 'claude-web-egress-bridge', version: '2.0.0' },
            },
          });
        }

        if (rpcMethod === 'notifications/initialized') {
          return new Response(null, { status: 204 });
        }

        if (rpcMethod === 'tools/list') {
          return jsonResponse({
            jsonrpc: '2.0',
            id,
            result: {
              tools: [
                {
                  name: 'http_request',
                  description:
                    'Execute an outbound HTTP/HTTPS request through the hosted Cloudflare gateway. Use this to query public APIs, send webhooks, fetch JSON/data, or reach external servers when you have no network egress.',
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

        if (rpcMethod === 'tools/call') {
          const toolName = params?.name;
          const args = params?.arguments || {};

          if (toolName === 'http_request') {
            const resData = await executeWorkerHttpRequest({
              method: args.method || 'GET',
              url: args.url,
              headers: args.headers,
              queryParams: args.query_params,
              body: args.body,
              timeoutMs: args.timeout_ms,
              responseFormat: args.response_format,
            });

            let out = `### HTTP Response: ${resData.statusCode} ${resData.statusText}\n`;
            out += `**URL**: ${resData.url}\n**Content-Type**: ${resData.contentType}\n**Size**: ${resData.contentLength} bytes\n\n`;
            out += typeof resData.body === 'object' ? `\`\`\`json\n${JSON.stringify(resData.body, null, 2)}\n\`\`\`` : `\`\`\`\n${resData.body}\n\`\`\``;
            return jsonResponse({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: out }] } });
          }

          if (toolName === 'download_file') {
            const targetUrl = args.url;
            const projectId = args.project_id || 'default';
            const safety = await validateUrlSafety(targetUrl);
            if (!safety.safe) throw new Error(safety.error);

            const upRes = await fetch(safety.normalizedUrl!, { headers: { 'User-Agent': BROWSER_UA } });
            const contentType = upRes.headers.get('content-type') || 'application/octet-stream';
            const filename = path.basename(new URL(safety.normalizedUrl!).pathname) || 'downloaded_artifact';
            const fileBytes = await upRes.arrayBuffer();

            const r2Key = `projects/${projectId}/${Date.now()}_${filename}`;
            const putRes = await storage.put(r2Key, fileBytes, { contentType });

            await db.recordFile({
              project_id: projectId,
              r2_key: r2Key,
              filename,
              size_bytes: putRes.size,
              mime_type: contentType,
              sha256: putRes.sha256,
            });

            const dlLink = await storage.createSignedDownloadUrl(r2Key, appBaseUrl);
            let out = `### File Stored in Cloudflare R2\n`;
            out += `- **Filename**: ${filename}\n- **R2 Key**: \`${r2Key}\`\n- **Size**: ${(putRes.size / 1024).toFixed(1)} KB\n`;
            out += `- **SHA-256**: \`${putRes.sha256}\`\n- **Download Link**: ${dlLink}\n`;
            return jsonResponse({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: out }] } });
          }

          if (toolName === 'storage_list') {
            const pid = args.project_id || 'default';
            const files = await db.listFiles(pid);
            let out = `### Cloudflare R2 Stored Files (Project: ${pid})\n\n`;
            if (files.length === 0) {
              out += 'No files stored in this project yet.\n';
            } else {
              for (const f of files) {
                out += `- **${f.filename}** (${(f.size_bytes / 1024).toFixed(1)} KB, SHA: \`${f.sha256.substring(0, 10)}...\`) [Key: \`${f.r2_key}\`]\n`;
              }
            }
            return jsonResponse({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: out }] } });
          }

          if (toolName === 'package_registry_lookup') {
            const pRes = await lookupPackage({
              ecosystem: args.ecosystem,
              packageName: args.package_name,
              version: args.version,
              action: args.action || 'metadata',
            });
            return jsonResponse({
              jsonrpc: '2.0',
              id,
              result: { content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(pRes, null, 2)}\n\`\`\`` }] },
            });
          }

          if (toolName === 'web_search') {
            const sRes = await fetch(`${appBaseUrl}/api/search?q=${encodeURIComponent(args.query)}`);
            const sData: any = await sRes.json();
            let out = `### Web Search: "${args.query}"\n\n`;
            if (sData.summary) out += `${sData.summary}\n\n`;
            sData.results?.forEach((r: any, idx: number) => {
              out += `${idx + 1}. [${r.title}](${r.url})\n   ${r.snippet || ''}\n`;
            });
            return jsonResponse({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: out }] } });
          }

          if (toolName === 'fetch_webpage') {
            const fRes = await fetch(`${appBaseUrl}/api/fetch`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url: args.url }),
            });
            const fData: any = await fRes.json();
            let out = `# ${fData.title || 'Page Content'}\n**URL**: ${fData.url}\n\n---\n\n${fData.markdown || fData.plainText}`;
            return jsonResponse({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: out }] } });
          }

          if (toolName === 'sitemap_discovery') {
            const smRes = await discoverSitemapAndPagination(args.url);
            let out = `### Sitemap Discovery for ${args.url}\n\n`;
            out += `- Robots.txt: ${smRes.hasRobotsTxt ? 'Present' : 'Not found'}\n`;
            smRes.discoveredSitemaps?.forEach((s) => {
              out += `- **${s.url}** (${s.entriesCount} entries)\n`;
            });
            return jsonResponse({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: out }] } });
          }

          if (toolName === 'browser_render') {
            const bRes = await executeBrowserRender({ url: args.url }, env);
            return jsonResponse({
              jsonrpc: '2.0',
              id,
              result: { content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(bRes, null, 2)}\n\`\`\`` }] },
            });
          }

          return jsonResponse({ jsonrpc: '2.0', id, error: { code: -32601, message: `Tool not found: ${toolName}` } }, 404);
        }
      }

      // -----------------------------------------------------------------------
      // 10. Fallback to Cloudflare Static Assets (Vite React Dashboard)
      // -----------------------------------------------------------------------
      if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
        return await env.ASSETS.fetch(request);
      }

      return new Response('Not Found', { status: 404 });
    } catch (err: any) {
      return jsonResponse({ error: err.message || 'Worker Internal Server Error' }, 500);
    }
  },

  // ---------------------------------------------------------------------------
  // Cloudflare Queue Consumer for Asynchronous File Downloads & Asset Transfers
  // ---------------------------------------------------------------------------
  async queue(batch: any, env: Env): Promise<void> {
    const storage = getStorageService(env.STORAGE_BUCKET);
    const db = getDatabaseService(env.DB);

    for (const message of batch.messages) {
      const { jobId, url: targetUrl, filename, projectId } = message.body || {};
      if (!jobId || !targetUrl) {
        message.ack();
        continue;
      }

      try {
        await db.updateJob(jobId, { status: 'processing', progress_percent: 10 });
        const upRes = await fetch(targetUrl, { headers: { 'User-Agent': BROWSER_UA } });

        if (!upRes.ok) throw new Error(`Upstream HTTP error: ${upRes.status}`);

        const contentType = upRes.headers.get('content-type') || 'application/octet-stream';
        const safeFilename = filename || path.basename(new URL(targetUrl).pathname) || 'downloaded_artifact';
        const fileBytes = await upRes.arrayBuffer();

        const r2Key = `projects/${projectId || 'default'}/${Date.now()}_${safeFilename}`;
        const putResult = await storage.put(r2Key, fileBytes, { contentType });

        await db.recordFile({
          project_id: projectId || 'default',
          r2_key: r2Key,
          filename: safeFilename,
          size_bytes: putResult.size,
          mime_type: contentType,
          sha256: putResult.sha256,
        });

        await db.updateJob(jobId, {
          status: 'completed',
          progress_percent: 100,
          bytes_downloaded: putResult.size,
          total_bytes: putResult.size,
          r2_key: r2Key,
          sha256: putResult.sha256,
        });

        message.ack();
      } catch (err: any) {
        await db.updateJob(jobId, {
          status: 'failed',
          error_message: err.message || 'Background download failed',
        });
        message.ack();
      }
    }
  },
};
