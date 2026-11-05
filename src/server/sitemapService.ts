import * as cheerio from 'cheerio';
import { validateUrlSafety } from './security';

export interface SitemapResult {
  target: string;
  robotsTxtUrl: string;
  hasRobotsTxt: boolean;
  sitemapsInRobots: string[];
  discoveredSitemaps: Array<{
    url: string;
    type: 'sitemap' | 'sitemapindex';
    entriesCount: number;
    sampleUrls: string[];
  }>;
  paginationLinks?: string[];
  error?: string;
}

const DISCOVERY_UA = 'Claude-Web-Egress-Bridge/1.2 (Sitemap Crawler)';

export async function discoverSitemapAndPagination(targetUrl: string): Promise<SitemapResult> {
  const safety = await validateUrlSafety(targetUrl);
  if (!safety.safe) {
    throw new Error(safety.error);
  }

  const parsed = new URL(targetUrl);
  const origin = parsed.origin;
  const robotsTxtUrl = `${origin}/robots.txt`;

  const sitemapsInRobots: string[] = [];
  let hasRobotsTxt = false;

  // 1. Inspect robots.txt
  try {
    const robotsRes = await fetch(robotsTxtUrl, {
      headers: { 'User-Agent': DISCOVERY_UA },
      signal: AbortSignal.timeout(8000),
    });
    if (robotsRes.ok) {
      hasRobotsTxt = true;
      const text = await robotsRes.text();
      const lines = text.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.toLowerCase().startsWith('sitemap:')) {
          const sitemapUrl = trimmed.slice(8).trim();
          if (sitemapUrl && !sitemapsInRobots.includes(sitemapUrl)) {
            sitemapsInRobots.push(sitemapUrl);
          }
        }
      }
    }
  } catch {
    // robots.txt might not exist
  }

  // Common sitemap candidates to check
  const candidatesToCheck = [
    ...sitemapsInRobots,
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
    `${origin}/sitemap/sitemap.xml`,
  ];
  const uniqueCandidates = Array.from(new Set(candidatesToCheck));

  const discoveredSitemaps: SitemapResult['discoveredSitemaps'] = [];

  for (const sitemapUrl of uniqueCandidates.slice(0, 4)) {
    try {
      const sRes = await fetch(sitemapUrl, {
        headers: { 'User-Agent': DISCOVERY_UA, Accept: 'application/xml,text/xml,*/*' },
        signal: AbortSignal.timeout(8000),
      });

      if (sRes.ok) {
        const xmlText = await sRes.text();
        const $ = cheerio.load(xmlText, { xmlMode: true });

        const isSitemapIndex = $('sitemapindex').length > 0;
        const isUrlset = $('urlset').length > 0;

        if (isSitemapIndex) {
          const childSitemaps: string[] = [];
          $('sitemap > loc').each((_, el) => {
            if (childSitemaps.length < 20) {
              childSitemaps.push($(el).text().trim());
            }
          });
          discoveredSitemaps.push({
            url: sitemapUrl,
            type: 'sitemapindex',
            entriesCount: $('sitemap').length,
            sampleUrls: childSitemaps,
          });
        } else if (isUrlset) {
          const pageUrls: string[] = [];
          $('url > loc').each((_, el) => {
            if (pageUrls.length < 30) {
              pageUrls.push($(el).text().trim());
            }
          });
          discoveredSitemaps.push({
            url: sitemapUrl,
            type: 'sitemap',
            entriesCount: $('url').length,
            sampleUrls: pageUrls,
          });
        }
      }
    } catch {
      // skip unreachable candidate
    }
  }

  // 2. Discover pagination on the specific target URL if it's an HTML page
  const paginationLinks: string[] = [];
  try {
    const pageRes = await fetch(targetUrl, {
      headers: { 'User-Agent': DISCOVERY_UA },
      signal: AbortSignal.timeout(10000),
    });
    if (pageRes.ok) {
      const html = await pageRes.text();
      const $ = cheerio.load(html);

      // rel="next", rel="prev"
      $('link[rel="next"], a[rel="next"]').each((_, el) => {
        const href = $(el).attr('href');
        if (href) paginationLinks.push(new URL(href, targetUrl).href);
      });

      // Pagination elements (.pagination a, [aria-label*="page" i], ?page=)
      $('.pagination a, [class*="pagination"] a, [class*="paginate"] a').each((_, el) => {
        if (paginationLinks.length < 15) {
          const href = $(el).attr('href');
          if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
            const abs = new URL(href, targetUrl).href;
            if (!paginationLinks.includes(abs)) paginationLinks.push(abs);
          }
        }
      });
    }
  } catch {
    // ignore
  }

  return {
    target: targetUrl,
    robotsTxtUrl,
    hasRobotsTxt,
    sitemapsInRobots,
    discoveredSitemaps,
    paginationLinks: Array.from(new Set(paginationLinks)),
  };
    }
