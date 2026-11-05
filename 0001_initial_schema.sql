-- Cloudflare D1 Migration: 0001_initial_schema.sql
-- Initial database schema for Claude Web Egress Bridge

-- 1. Projects Table (Isolated project namespaces for storage and execution)
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_projects_created_at ON projects(created_at);

-- 2. Files & Assets Table (Metadata for R2 object storage)
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  r2_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  metadata_json TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_files_project_id ON files(project_id);
CREATE INDEX IF NOT EXISTS idx_files_r2_key ON files(r2_key);
CREATE INDEX IF NOT EXISTS idx_files_created_at ON files(created_at);

-- 3. Download & Async Jobs Table (Cloudflare Queue job tracking)
CREATE TABLE IF NOT EXISTS download_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  source_url TEXT NOT NULL,
  target_filename TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  progress_percent INTEGER DEFAULT 0,
  bytes_downloaded INTEGER DEFAULT 0,
  total_bytes INTEGER,
  r2_key TEXT,
  sha256 TEXT,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON download_jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON download_jobs(created_at);

-- 4. Audit & Egress Security Logs Table
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  tool_name TEXT NOT NULL,
  method TEXT NOT NULL,
  target_url TEXT NOT NULL,
  status_code TEXT,
  duration_ms INTEGER,
  bytes_transferred INTEGER,
  client_ip TEXT,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_tool ON audit_logs(tool_name);

-- 5. MCP Sessions & Auth Records
CREATE TABLE IF NOT EXISTS mcp_sessions (
  id TEXT PRIMARY KEY,
  client_type TEXT,
  user_agent TEXT,
  requests_count INTEGER DEFAULT 0,
  last_active_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Seed Default General Project
INSERT OR IGNORE INTO projects (id, name, description)
VALUES ('default', 'Default Project', 'Primary storage namespace for assets and downloads');
