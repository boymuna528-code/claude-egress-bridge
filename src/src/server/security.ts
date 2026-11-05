import dns from 'dns/promises';
import net from 'net';

export interface SafeUrlResult {
  safe: boolean;
  error?: string;
  normalizedUrl?: string;
  resolvedIp?: string;
}

// Check if an IP is in private, loopback, link-local, or cloud metadata ranges
export function isPrivateOrReservedIp(ip: string): boolean {
  // IPv4 checks
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map((p) => parseInt(p, 10));
    if (parts.length !== 4) return true;

    const [b0, b1] = parts;

    // 0.0.0.0/8 (Current network)
    if (b0 === 0) return true;
    // 10.0.0.0/8 (Private)
    if (b0 === 10) return true;
    // 127.0.0.0/8 (Loopback)
    if (b0 === 127) return true;
    // 169.254.0.0/16 (Link-local & Cloud Metadata)
    if (b0 === 169 && b1 === 254) return true;
    // 172.16.0.0/12 (Private)
    if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
    // 192.168.0.0/16 (Private)
    if (b0 === 192 && b1 === 168) return true;
    // 100.64.0.0/10 (Carrier-grade NAT)
    if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;
    // 192.0.0.0/24, 192.0.2.0/24 (Documentation/Reserved)
    if (b0 === 192 && b1 === 0) return true;
    // 198.18.0.0/15 (Benchmark testing)
    if (b0 === 198 && (b1 === 18 || b1 === 19)) return true;
    // 198.51.100.0/24, 203.0.113.0/24
    if (b0 === 198 && b1 === 51) return true;
    if (b0 === 203 && b1 === 0) return true;
    // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved)
    if (b0 >= 224) return true;

    return false;
  }

  // IPv6 checks
  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();

    // Loopback
    if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
      return true;
    }

    // Unspecified
    if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') {
      return true;
    }

    // Unique local (fc00::/7)
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
      return true;
    }

    // Link-local (fe80::/10)
    if (
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb')
    ) {
      return true;
    }

    // IPv4-mapped IPv6 (::ffff:127.0.0.1, etc.)
    if (normalized.includes('::ffff:')) {
      const v4Part = normalized.split('::ffff:')[1];

      if (v4Part && net.isIPv4(v4Part)) {
        return isPrivateOrReservedIp(v4Part);
      }
    }
  }

  return false;
}

// Blocked hostnames explicitly
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
  'instance-data',
]);

// Validate a URL against SSRF, private networks, and invalid protocols
export async function validateUrlSafety(
  urlStr: string
): Promise<SafeUrlResult> {
  let parsed: URL;

  try {
    parsed = new URL(urlStr);
  } catch {
    return { safe: false, error: 'Invalid URL format' };
  }

  // Only permit HTTP and HTTPS
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      safe: false,
      error: `Protocol '${parsed.protocol}' is forbidden. Only 'http:' and 'https:' are permitted.`,
    };
  }

  const hostname = parsed.hostname.toLowerCase().trim();

  // Check blocked hostnames
  if (
    BLOCKED_HOSTNAMES.has(hostname) ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.local')
  ) {
    return {
      safe: false,
      error: `Access to hostname '${hostname}' is prohibited (internal / metadata network protection).`,
    };
  }

  // If hostname is directly an IP address
  if (net.isIP(hostname)) {
    if (isPrivateOrReservedIp(hostname)) {
      return {
        safe: false,
        error: `Access to private/reserved IP address '${hostname}' is prohibited.`,
      };
    }

    return {
      safe: true,
      normalizedUrl: parsed.href,
      resolvedIp: hostname,
    };
  }

  // DNS Resolution to prevent DNS Rebinding to private IP
  try {
    const lookup = await dns.lookup(hostname, { all: true });

    if (!lookup || lookup.length === 0) {
      return {
        safe: false,
        error: `DNS resolution failed for hostname '${hostname}'.`,
      };
    }

    for (const record of lookup) {
      if (isPrivateOrReservedIp(record.address)) {
        return {
          safe: false,
          error: `Hostname '${hostname}' resolved to prohibited address '${record.address}'.`,
        };
      }
    }

    return {
      safe: true,
      normalizedUrl: parsed.href,
      resolvedIp: lookup[0].address,
    };
  } catch (dnsErr: any) {
    return {
      safe: false,
      error: `DNS resolution error for '${hostname}': ${
        dnsErr.message || 'Domain not found'
      }`,
    };
  }
}

// In-Memory Audit Log for outbound egress requests
export interface AuditLogEntry {
  id: string;
  timestamp: string;
  tool: string;
  method: string;
  url: string;
  status: number | string;
  durationMs: number;
  bytesTransferred?: number;
  error?: string;
}

const auditLogs: AuditLogEntry[] = [];
const MAX_AUDIT_LOGS = 100;

export function recordAuditLog(
  entry: Omit<AuditLogEntry, 'id' | 'timestamp'>
): AuditLogEntry {
  const fullEntry: AuditLogEntry = {
    id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    timestamp: new Date().toISOString(),
    ...entry,
  };

  auditLogs.unshift(fullEntry);

  if (auditLogs.length > MAX_AUDIT_LOGS) {
    auditLogs.pop();
  }

  return fullEntry;
}

export function getAuditLogs(): AuditLogEntry[] {
  return [...auditLogs];
}

// Rate Limiter: Per IP / Session
interface RateLimitBucket {
  count: number;
  resetAt: number;
}

const rateLimitMap = new Map<string, RateLimitBucket>();

export function checkRateLimit(
  key: string,
  maxRequests = 120,
  windowMs = 60000
): { allowed: boolean; remaining: number } {
  const now = Date.now();
  let bucket = rateLimitMap.get(key);

  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 1, resetAt: now + windowMs };
    rateLimitMap.set(key, bucket);

    return {
      allowed: true,
      remaining: maxRequests - 1,
    };
  }

  bucket.count++;

  if (bucket.count > maxRequests) {
    return {
      allowed: false,
      remaining: 0,
    };
  }

  return {
    allowed: true,
    remaining: maxRequests - bucket.count,
  };
}
