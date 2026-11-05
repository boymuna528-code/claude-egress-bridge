import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import crypto from 'crypto';

export interface StorageObjectMeta {
  key: string;
  size: number;
  uploaded: string;
  etag: string;
  contentType?: string;
  customMetadata?: Record<string, string>;
  sha256?: string;
}

export interface IStorageService {
  put(
    key: string,
    body: any,
    options?: {
      contentType?: string;
      customMetadata?: Record<string, string>;
      sha256?: string;
    }
  ): Promise<{ key: string; size: number; etag: string; sha256: string }>;

  get(key: string): Promise<{
    body: any;
    size: number;
    contentType: string;
    sha256?: string;
    customMetadata?: Record<string, string>;
    stream: () => NodeJS.ReadableStream | ReadableStream;
    arrayBuffer: () => Promise<ArrayBuffer>;
  } | null>;

  delete(key: string): Promise<void>;

  list(prefix?: string, limit?: number): Promise<StorageObjectMeta[]>;

  createSignedDownloadUrl(key: string, baseUrl: string, expiresInSeconds?: number): Promise<string>;
}

// -----------------------------------------------------------------------------
// 1. Cloudflare R2 Storage Implementation
// -----------------------------------------------------------------------------
export class CloudflareR2Storage implements IStorageService {
  private bucket: any; // R2Bucket from @cloudflare/workers-types

  constructor(bucket: any) {
    this.bucket = bucket;
  }

  async put(
    key: string,
    body: any,
    options?: { contentType?: string; customMetadata?: Record<string, string>; sha256?: string }
  ) {
    const putOptions: any = {
      httpMetadata: {
        contentType: options?.contentType || 'application/octet-stream',
      },
      customMetadata: {
        ...(options?.customMetadata || {}),
        sha256: options?.sha256 || '',
        uploadedAt: new Date().toISOString(),
      },
    };

    const obj = await this.bucket.put(key, body, putOptions);
    return {
      key: obj.key,
      size: obj.size,
      etag: obj.etag,
      sha256: options?.sha256 || obj.customMetadata?.sha256 || '',
    };
  }

  async get(key: string) {
    const obj = await this.bucket.get(key);
    if (!obj) return null;

    return {
      body: obj.body,
      size: obj.size,
      contentType: obj.httpMetadata?.contentType || 'application/octet-stream',
      sha256: obj.customMetadata?.sha256,
      customMetadata: obj.customMetadata,
      stream: () => obj.body,
      arrayBuffer: () => obj.arrayBuffer(),
    };
  }

  async delete(key: string) {
    await this.bucket.delete(key);
  }

  async list(prefix?: string, limit = 100): Promise<StorageObjectMeta[]> {
    const listed = await this.bucket.list({ prefix, limit });
    return listed.objects.map((o: any) => ({
      key: o.key,
      size: o.size,
      uploaded: o.uploaded.toISOString(),
      etag: o.etag,
      contentType: o.httpMetadata?.contentType,
      customMetadata: o.customMetadata,
      sha256: o.customMetadata?.sha256,
    }));
  }

  async createSignedDownloadUrl(key: string, baseUrl: string, expiresInSeconds = 3600): Promise<string> {
    // Generate secure token URL backed by the worker endpoint
    const expiresAt = Date.now() + expiresInSeconds * 1000;
    const token = crypto
      .createHmac('sha256', 'egress-bridge-secret')
      .update(`${key}:${expiresAt}`)
      .digest('hex')
      .substring(0, 32);

    return `${baseUrl}/api/download/file/${encodeURIComponent(key)}?exp=${expiresAt}&sig=${token}`;
  }
}

// -----------------------------------------------------------------------------
// 2. Local Disk Storage Implementation (Dev & Node.js Fallback)
// -----------------------------------------------------------------------------
export class LocalDiskStorage implements IStorageService {
  private static instance: LocalDiskStorage;
  private baseDir: string;
  private metaMap: Map<string, StorageObjectMeta> = new Map();

  constructor(baseDir = '/tmp/egress_storage') {
    this.baseDir = baseDir;
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  public static getInstance(): LocalDiskStorage {
    if (!LocalDiskStorage.instance) {
      LocalDiskStorage.instance = new LocalDiskStorage();
    }
    return LocalDiskStorage.instance;
  }

  private getFilePath(key: string): string {
    const safeKey = key.replace(/[^a-zA-Z0-9_\-./]/g, '_');
    return path.join(this.baseDir, safeKey);
  }

  async put(
    key: string,
    body: any,
    options?: { contentType?: string; customMetadata?: Record<string, string>; sha256?: string }
  ) {
    const filePath = this.getFilePath(key);
    const dir = path.dirname(filePath);
    await fsp.mkdir(dir, { recursive: true });

    let finalBuffer: Buffer;
    let sha256 = options?.sha256 || '';

    if (Buffer.isBuffer(body)) {
      finalBuffer = body;
    } else if (typeof body === 'string') {
      finalBuffer = Buffer.from(body, 'utf-8');
    } else if (body instanceof ArrayBuffer) {
      finalBuffer = Buffer.from(body);
    } else if (body && typeof body.arrayBuffer === 'function') {
      finalBuffer = Buffer.from(await body.arrayBuffer());
    } else {
      // ReadableStream or object
      finalBuffer = Buffer.from(JSON.stringify(body));
    }

    if (!sha256) {
      sha256 = crypto.createHash('sha256').update(finalBuffer).digest('hex');
    }

    await fsp.writeFile(filePath, finalBuffer);

    const meta: StorageObjectMeta = {
      key,
      size: finalBuffer.length,
      uploaded: new Date().toISOString(),
      etag: `"${sha256.substring(0, 16)}"`,
      contentType: options?.contentType || 'application/octet-stream',
      customMetadata: options?.customMetadata,
      sha256,
    };

    this.metaMap.set(key, meta);

    return {
      key,
      size: finalBuffer.length,
      etag: meta.etag,
      sha256,
    };
  }

  async get(key: string) {
    const filePath = this.getFilePath(key);
    if (!fs.existsSync(filePath)) return null;

    const stat = await fsp.stat(filePath);
    const meta = this.metaMap.get(key);

    return {
      body: fs.createReadStream(filePath),
      size: stat.size,
      contentType: meta?.contentType || 'application/octet-stream',
      sha256: meta?.sha256,
      customMetadata: meta?.customMetadata,
      stream: () => fs.createReadStream(filePath),
      arrayBuffer: async () => {
        const buf = await fsp.readFile(filePath);
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      },
    };
  }

  async delete(key: string) {
    const filePath = this.getFilePath(key);
    if (fs.existsSync(filePath)) {
      await fsp.unlink(filePath);
    }
    this.metaMap.delete(key);
  }

  async list(prefix?: string, limit = 100): Promise<StorageObjectMeta[]> {
    const results: StorageObjectMeta[] = [];
    for (const [k, meta] of this.metaMap.entries()) {
      if (!prefix || k.startsWith(prefix)) {
        results.push(meta);
        if (results.length >= limit) break;
      }
    }
    return results;
  }

  async createSignedDownloadUrl(key: string, baseUrl: string, expiresInSeconds = 3600): Promise<string> {
    const expiresAt = Date.now() + expiresInSeconds * 1000;
    const token = crypto
      .createHmac('sha256', 'egress-bridge-secret')
      .update(`${key}:${expiresAt}`)
      .digest('hex')
      .substring(0, 32);

    return `${baseUrl}/api/download/file/${encodeURIComponent(key)}?exp=${expiresAt}&sig=${token}`;
  }
}

// -----------------------------------------------------------------------------
// Storage Factory
// -----------------------------------------------------------------------------
export function getStorageService(r2Bucket?: any): IStorageService {
  if (r2Bucket) {
    return new CloudflareR2Storage(r2Bucket);
  }
  return LocalDiskStorage.getInstance();
    }
