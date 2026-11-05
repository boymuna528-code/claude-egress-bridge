export interface ProjectRecord {
  id: string;
  name: string;
  description?: string;
  created_at: string;
  updated_at: string;
}

export interface FileRecord {
  id: string;
  project_id?: string;
  r2_key: string;
  filename: string;
  size_bytes: number;
  mime_type: string;
  sha256: string;
  metadata_json?: string;
  created_at: string;
}

export interface DownloadJobRecord {
  id: string;
  project_id?: string;
  source_url: string;
  target_filename?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  progress_percent: number;
  bytes_downloaded: number;
  total_bytes?: number;
  r2_key?: string;
  sha256?: string;
  error_message?: string;
  created_at: string;
  updated_at: string;
}

export interface AuditRecord {
  id: string;
  tool_name: string;
  method: string;
  target_url: string;
  status_code: string;
  duration_ms: number;
  bytes_transferred?: number;
  client_ip?: string;
  error_message?: string;
  created_at: string;
}

export interface IDatabaseService {
  // Projects
  listProjects(): Promise<ProjectRecord[]>;
  createProject(name: string, description?: string, id?: string): Promise<ProjectRecord>;
  getProject(id: string): Promise<ProjectRecord | null>;
  deleteProject(id: string): Promise<void>;

  // Files
  recordFile(file: Omit<FileRecord, 'id' | 'created_at'>): Promise<FileRecord>;
  listFiles(projectId?: string): Promise<FileRecord[]>;
  getFile(r2Key: string): Promise<FileRecord | null>;
  deleteFile(r2Key: string): Promise<void>;

  // Jobs
  createJob(job: { source_url: string; target_filename?: string; project_id?: string }): Promise<DownloadJobRecord>;
  updateJob(
    id: string,
    updates: Partial<Omit<DownloadJobRecord, 'id' | 'created_at'>>
  ): Promise<DownloadJobRecord | null>;
  getJob(id: string): Promise<DownloadJobRecord | null>;
  listJobs(limit?: number): Promise<DownloadJobRecord[]>;

  // Audit Logs
  logAudit(audit: Omit<AuditRecord, 'id' | 'created_at'>): Promise<void>;
  getAuditLogs(limit?: number): Promise<AuditRecord[]>;
}

// -----------------------------------------------------------------------------
// 1. Cloudflare D1 Database Implementation
// -----------------------------------------------------------------------------
export class CloudflareD1Database implements IDatabaseService {
  private db: any; // D1Database from @cloudflare/workers-types

  constructor(db: any) {
    this.db = db;
  }

  async listProjects(): Promise<ProjectRecord[]> {
    const res = await this.db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
    return res.results || [];
  }

  async createProject(name: string, description?: string, id?: string): Promise<ProjectRecord> {
    const pid = id || `proj_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const now = new Date().toISOString();
    await this.db
      .prepare('INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind(pid, name, description || '', now, now)
      .run();
    return { id: pid, name, description, created_at: now, updated_at: now };
  }

  async getProject(id: string): Promise<ProjectRecord | null> {
    const res = await this.db.prepare('SELECT * FROM projects WHERE id = ?').bind(id).first();
    return res || null;
  }

  async deleteProject(id: string): Promise<void> {
    await this.db.prepare('DELETE FROM projects WHERE id = ?').bind(id).run();
  }

  async recordFile(file: Omit<FileRecord, 'id' | 'created_at'>): Promise<FileRecord> {
    const fid = `file_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const now = new Date().toISOString();
    await this.db
      .prepare(
        'INSERT INTO files (id, project_id, r2_key, filename, size_bytes, mime_type, sha256, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        fid,
        file.project_id || 'default',
        file.r2_key,
        file.filename,
        file.size_bytes,
        file.mime_type,
        file.sha256,
        file.metadata_json || '{}',
        now
      )
      .run();

    return { id: fid, created_at: now, ...file };
  }

  async listFiles(projectId?: string): Promise<FileRecord[]> {
    if (projectId) {
      const res = await this.db
        .prepare('SELECT * FROM files WHERE project_id = ? ORDER BY created_at DESC')
        .bind(projectId)
        .all();
      return res.results || [];
    }
    const res = await this.db.prepare('SELECT * FROM files ORDER BY created_at DESC').all();
    return res.results || [];
  }

  async getFile(r2Key: string): Promise<FileRecord | null> {
    const res = await this.db.prepare('SELECT * FROM files WHERE r2_key = ?').bind(r2Key).first();
    return res || null;
  }

  async deleteFile(r2Key: string): Promise<void> {
    await this.db.prepare('DELETE FROM files WHERE r2_key = ?').bind(r2Key).run();
  }

  async createJob(job: { source_url: string; target_filename?: string; project_id?: string }): Promise<DownloadJobRecord> {
    const jid = `job_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const now = new Date().toISOString();
    await this.db
      .prepare(
        'INSERT INTO download_jobs (id, project_id, source_url, target_filename, status, progress_percent, bytes_downloaded, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(jid, job.project_id || 'default', job.source_url, job.target_filename || '', 'pending', 0, 0, now, now)
      .run();

    return {
      id: jid,
      project_id: job.project_id || 'default',
      source_url: job.source_url,
      target_filename: job.target_filename,
      status: 'pending',
      progress_percent: 0,
      bytes_downloaded: 0,
      created_at: now,
      updated_at: now,
    };
  }

  async updateJob(
    id: string,
    updates: Partial<Omit<DownloadJobRecord, 'id' | 'created_at'>>
  ): Promise<DownloadJobRecord | null> {
    const now = new Date().toISOString();
    const existing = await this.getJob(id);
    if (!existing) return null;

    const updated = { ...existing, ...updates, updated_at: now };
    await this.db
      .prepare(
        'UPDATE download_jobs SET status = ?, progress_percent = ?, bytes_downloaded = ?, total_bytes = ?, r2_key = ?, sha256 = ?, error_message = ?, updated_at = ? WHERE id = ?'
      )
      .bind(
        updated.status,
        updated.progress_percent,
        updated.bytes_downloaded,
        updated.total_bytes || null,
        updated.r2_key || null,
        updated.sha256 || null,
        updated.error_message || null,
        now,
        id
      )
      .run();

    return updated;
  }

  async getJob(id: string): Promise<DownloadJobRecord | null> {
    const res = await this.db.prepare('SELECT * FROM download_jobs WHERE id = ?').bind(id).first();
    return res || null;
  }

  async listJobs(limit = 50): Promise<DownloadJobRecord[]> {
    const res = await this.db
      .prepare('SELECT * FROM download_jobs ORDER BY created_at DESC LIMIT ?')
      .bind(limit)
      .all();
    return res.results || [];
  }

  async logAudit(audit: Omit<AuditRecord, 'id' | 'created_at'>): Promise<void> {
    const aid = `log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const now = new Date().toISOString();
    await this.db
      .prepare(
        'INSERT INTO audit_logs (id, tool_name, method, target_url, status_code, duration_ms, bytes_transferred, client_ip, error_message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        aid,
        audit.tool_name,
        audit.method,
        audit.target_url,
        String(audit.status_code),
        audit.duration_ms,
        audit.bytes_transferred || 0,
        audit.client_ip || '',
        audit.error_message || '',
        now
      )
      .run();
  }

  async getAuditLogs(limit = 100): Promise<AuditRecord[]> {
    const res = await this.db
      .prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?')
      .bind(limit)
      .all();
    return res.results || [];
  }
}

// -----------------------------------------------------------------------------
// 2. Local Database Implementation (Dev & Node.js Fallback)
// -----------------------------------------------------------------------------
export class LocalDatabase implements IDatabaseService {
  private static instance: LocalDatabase;

  private projects: Map<string, ProjectRecord> = new Map();
  private files: Map<string, FileRecord> = new Map();
  private jobs: Map<string, DownloadJobRecord> = new Map();
  private auditLogs: AuditRecord[] = [];

  constructor() {
    // Seed default project
    this.projects.set('default', {
      id: 'default',
      name: 'Default Workspace',
      description: 'Default project storage namespace for downloaded assets',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }

  public static getInstance(): LocalDatabase {
    if (!LocalDatabase.instance) {
      LocalDatabase.instance = new LocalDatabase();
    }
    return LocalDatabase.instance;
  }

  async listProjects(): Promise<ProjectRecord[]> {
    return Array.from(this.projects.values()).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async createProject(name: string, description?: string, id?: string): Promise<ProjectRecord> {
    const pid = id || `proj_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const now = new Date().toISOString();
    const proj: ProjectRecord = { id: pid, name, description, created_at: now, updated_at: now };
    this.projects.set(pid, proj);
    return proj;
  }

  async getProject(id: string): Promise<ProjectRecord | null> {
    return this.projects.get(id) || null;
  }

  async deleteProject(id: string): Promise<void> {
    this.projects.delete(id);
  }

  async recordFile(file: Omit<FileRecord, 'id' | 'created_at'>): Promise<FileRecord> {
    const fid = `file_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const now = new Date().toISOString();
    const rec: FileRecord = { id: fid, created_at: now, ...file };
    this.files.set(file.r2_key, rec);
    return rec;
  }

  async listFiles(projectId?: string): Promise<FileRecord[]> {
    const all = Array.from(this.files.values());
    if (projectId) {
      return all.filter((f) => f.project_id === projectId);
    }
    return all.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async getFile(r2Key: string): Promise<FileRecord | null> {
    return this.files.get(r2Key) || null;
  }

  async deleteFile(r2Key: string): Promise<void> {
    this.files.delete(r2Key);
  }

  async createJob(job: { source_url: string; target_filename?: string; project_id?: string }): Promise<DownloadJobRecord> {
    const jid = `job_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const now = new Date().toISOString();
    const rec: DownloadJobRecord = {
      id: jid,
      project_id: job.project_id || 'default',
      source_url: job.source_url,
      target_filename: job.target_filename,
      status: 'pending',
      progress_percent: 0,
      bytes_downloaded: 0,
      created_at: now,
      updated_at: now,
    };
    this.jobs.set(jid, rec);
    return rec;
  }

  async updateJob(
    id: string,
    updates: Partial<Omit<DownloadJobRecord, 'id' | 'created_at'>>
  ): Promise<DownloadJobRecord | null> {
    const existing = this.jobs.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...updates, updated_at: new Date().toISOString() };
    this.jobs.set(id, updated);
    return updated;
  }

  async getJob(id: string): Promise<DownloadJobRecord | null> {
    return this.jobs.get(id) || null;
  }

  async listJobs(limit = 50): Promise<DownloadJobRecord[]> {
    return Array.from(this.jobs.values())
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit);
  }

  async logAudit(audit: Omit<AuditRecord, 'id' | 'created_at'>): Promise<void> {
    const aid = `log_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const rec: AuditRecord = {
      id: aid,
      created_at: new Date().toISOString(),
      ...audit,
    };
    this.auditLogs.unshift(rec);
    if (this.auditLogs.length > 200) {
      this.auditLogs.pop();
    }
  }

  async getAuditLogs(limit = 100): Promise<AuditRecord[]> {
    return this.auditLogs.slice(0, limit);
  }
}

export function getDatabaseService(d1Db?: any): IDatabaseService {
  if (d1Db) {
    return new CloudflareD1Database(d1Db);
  }
  return LocalDatabase.getInstance();
  }
