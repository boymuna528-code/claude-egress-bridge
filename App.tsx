import React, { useState, useEffect } from 'react';
import {
  Search,
  Globe,
  Download,
  Terminal,
  Copy,
  Check,
  ExternalLink,
  ShieldCheck,
  FileText,
  RefreshCw,
  Code,
  Sparkles,
  Link2,
  BookOpen,
  Zap,
  AlertCircle,
  Clock,
  ArrowRight,
  Package,
  Layers,
  Bot,
  Map as MapIcon,
  Cpu,
  Shield,
  FileDown,
  Activity,
  Send,
  Database,
  Cloud,
  FolderKanban,
  HardDrive,
  Upload,
  Trash2,
  CheckCircle2,
  XCircle,
  HelpCircle,
  Smartphone,
  Server,
  Play,
  RotateCcw,
} from 'lucide-react';

interface HealthData {
  status: string;
  runtime?: string;
  cloudflareColo?: string;
  version: string;
  architecture?: {
    mode: string;
    workersReady: boolean;
    r2StorageConfigured: boolean;
    d1DatabaseConfigured: boolean;
    queuesConfigured: boolean;
    browserRenderingConfigured: boolean;
  };
  egress: {
    status: string;
    publicIp: string;
    latencyMs?: number;
  };
  geminiSearchEnabled: boolean;
  browserEngine?: {
    isAvailable: boolean;
    status: string;
    engineType?: string;
    message: string;
  };
  timestamp: string;
}

interface ProjectItem {
  id: string;
  name: string;
  description?: string;
  created_at: string;
  updated_at: string;
}

interface StoredFileItem {
  id: string;
  project_id?: string;
  r2_key: string;
  filename: string;
  size_bytes: number;
  mime_type: string;
  sha256: string;
  created_at: string;
}

interface JobItem {
  id: string;
  project_id?: string;
  source_url: string;
  target_filename?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  progress_percent: number;
  bytes_downloaded: number;
  r2_key?: string;
  error_message?: string;
  created_at: string;
}

interface AuditLogItem {
  id: string;
  created_at: string;
  tool_name: string;
  method: string;
  target_url: string;
  status_code: string;
  duration_ms: number;
  bytes_transferred?: number;
  client_ip?: string;
  error_message?: string;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<
    'http' | 'r2' | 'projects' | 'download' | 'packages' | 'search' | 'scrape' | 'browser' | 'claude' | 'security'
  >('http');

  const [health, setHealth] = useState<HealthData | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // 1. HTTP Request State
  const [httpMethod, setHttpMethod] = useState<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'>('GET');
  const [httpUrl, setHttpUrl] = useState('https://api.github.com/zen');
  const [httpHeaders, setHttpHeaders] = useState('{\n  "Accept": "application/json"\n}');
  const [httpBody, setHttpBody] = useState('');
  const [httpLoading, setHttpLoading] = useState(false);
  const [httpResponse, setHttpResponse] = useState<any>(null);
  const [httpError, setHttpError] = useState<string | null>(null);

  // 2. R2 Storage State
  const [storedFiles, setStoredFiles] = useState<StoredFileItem[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [selectedProject, setSelectedProject] = useState('default');
  const [manualDownloadUrl, setManualDownloadUrl] = useState('');

  // 3. Projects & Jobs State
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [jobs, setJobs] = useState<JobItem[]>([]);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectDesc, setNewProjectDesc] = useState('');
  const [asyncJobUrl, setAsyncJobUrl] = useState('');

  // 4. Download State
  const [dlUrl, setDlUrl] = useState('');
  const [dlLoading, setDlLoading] = useState(false);
  const [dlResult, setDlResult] = useState<any>(null);
  const [dlError, setDlError] = useState<string | null>(null);

  // 5. Package Registry State
  const [pkgEcosystem, setPkgEcosystem] = useState<'npm' | 'pypi' | 'github' | 'crates'>('npm');
  const [pkgName, setPkgName] = useState('express');
  const [pkgVersion, setPkgVersion] = useState('');
  const [pkgAction, setPkgAction] = useState<'metadata' | 'versions' | 'releases' | 'readme' | 'download_url'>('metadata');
  const [pkgLoading, setPkgLoading] = useState(false);
  const [pkgData, setPkgData] = useState<any>(null);
  const [pkgError, setPkgError] = useState<string | null>(null);

  // 6. Search State
  const [searchQuery, setSearchQuery] = useState('');
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchData, setSearchData] = useState<any>(null);

  // 7. Scrape State
  const [scrapeUrl, setScrapeUrl] = useState('');
  const [scrapeLoading, setScrapeLoading] = useState(false);
  const [scrapeData, setScrapeData] = useState<any>(null);

  // 8. Browser Engine State
  const [browserInfo, setBrowserInfo] = useState<any>(null);

  // 9. Security & Audit Logs State
  const [auditLogs, setAuditLogs] = useState<AuditLogItem[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);

  // Claude deployment subtab
  const [deployGuideTab, setDeployGuideTab] = useState<'mobile' | 'cli' | 'mcp-config'>('mobile');

  const appBaseUrl = typeof window !== 'undefined' ? window.location.origin : 'https://your-worker.workers.dev';

  // Load server health & diagnostics
  const checkHealth = async () => {
    setHealthLoading(true);
    try {
      const res = await fetch('/api/health');
      if (res.ok) {
        const data = await res.json();
        setHealth(data);
      }
    } catch {
      // ignore
    } finally {
      setHealthLoading(false);
    }
  };

  const loadFiles = async (pId = selectedProject) => {
    setFilesLoading(true);
    try {
      const res = await fetch(`/api/storage/files?project_id=${pId}`);
      if (res.ok) {
        const data = await res.json();
        setStoredFiles(data.files || []);
      }
    } catch {
      // ignore
    } finally {
      setFilesLoading(false);
    }
  };

  const loadProjectsAndJobs = async () => {
    try {
      const pRes = await fetch('/api/projects');
      if (pRes.ok) {
        const pData = await pRes.json();
        setProjects(pData.projects || []);
      }
      const jRes = await fetch('/api/jobs');
      if (jRes.ok) {
        const jData = await jRes.json();
        setJobs(jData.jobs || []);
      }
    } catch {
      // ignore
    }
  };

  const loadLogs = async () => {
    setLogsLoading(true);
    try {
      const res = await fetch('/api/logs');
      if (res.ok) {
        const data = await res.json();
        setAuditLogs(data.logs || []);
      }
    } catch {
      // ignore
    } finally {
      setLogsLoading(false);
    }
  };

  const loadBrowserStatus = async () => {
    try {
      const res = await fetch('/api/browser-status');
      if (res.ok) {
        const data = await res.json();
        setBrowserInfo(data);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    checkHealth();
    loadProjectsAndJobs();
    loadFiles();
    loadBrowserStatus();
  }, []);

  useEffect(() => {
    if (activeTab === 'r2') loadFiles(selectedProject);
    if (activeTab === 'projects') loadProjectsAndJobs();
    if (activeTab === 'security') loadLogs();
  }, [activeTab]);

  const handleCopy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // 1. Execute HTTP Request
  const handleHttpRequest = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!httpUrl.trim()) return;

    setHttpLoading(true);
    setHttpError(null);
    setHttpResponse(null);

    let parsedHeaders: Record<string, string> = {};
    if (httpHeaders.trim()) {
      try {
        parsedHeaders = JSON.parse(httpHeaders);
      } catch {
        setHttpError('Invalid JSON format in custom headers.');
        setHttpLoading(false);
        return;
      }
    }

    let parsedBody: any = undefined;
    if (httpBody.trim() && httpMethod !== 'GET' && httpMethod !== 'HEAD') {
      try {
        parsedBody = JSON.parse(httpBody);
      } catch {
        parsedBody = httpBody;
      }
    }

    try {
      const res = await fetch('/api/http-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: httpMethod,
          url: httpUrl.trim(),
          headers: parsedHeaders,
          body: parsedBody,
          timeoutMs: 25000,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status} returned from gateway`);
      setHttpResponse(data);
    } catch (err: any) {
      setHttpError(err.message || 'HTTP request failed');
    } finally {
      setHttpLoading(false);
    }
  };

  // 2. Package Registry Lookup
  const handlePackageLookup = async (e?: React.FormEvent, customPkg?: string) => {
    if (e) e.preventDefault();
    const pkg = customPkg || pkgName;
    if (!pkg.trim()) return;

    setPkgLoading(true);
    setPkgError(null);
    setPkgData(null);
    if (customPkg) setPkgName(pkg);

    try {
      const res = await fetch('/api/package-lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ecosystem: pkgEcosystem,
          name: pkg.trim(),
          version: pkgVersion.trim() || undefined,
          action: pkgAction,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Package lookup failed');
      setPkgData(data);
    } catch (err: any) {
      setPkgError(err.message || 'Error querying package registry');
    } finally {
      setPkgLoading(false);
    }
  };

  // 3. R2 Direct Download
  const handleDownloadToR2 = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const url = manualDownloadUrl || dlUrl;
    if (!url.trim()) return;

    setDlLoading(true);
    setDlError(null);
    setDlResult(null);

    try {
      const res = await fetch(`/api/download?url=${encodeURIComponent(url.trim())}&project_id=${selectedProject}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Download failed');
      setDlResult(data);
      loadFiles(selectedProject);
    } catch (err: any) {
      setDlError(err.message || 'Download failed');
    } finally {
      setDlLoading(false);
    }
  };

  // 4. Create Project
  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProjectName.trim()) return;

    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newProjectName.trim(), description: newProjectDesc.trim() }),
      });
      if (res.ok) {
        setNewProjectName('');
        setNewProjectDesc('');
        loadProjectsAndJobs();
      }
    } catch {
      // ignore
    }
  };

  // 5. Create Background Download Job
  const handleCreateAsyncJob = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!asyncJobUrl.trim()) return;

    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: asyncJobUrl.trim(), project_id: selectedProject }),
      });
      if (res.ok) {
        setAsyncJobUrl('');
        loadProjectsAndJobs();
      }
    } catch {
      // ignore
    }
  };

  // 6. Delete File from R2
  const handleDeleteFile = async (r2Key: string) => {
    if (!confirm(`Delete ${r2Key} from storage?`)) return;
    try {
      await fetch(`/api/storage/files?key=${encodeURIComponent(r2Key)}`, { method: 'DELETE' });
      loadFiles(selectedProject);
    } catch {
      // ignore
    }
  };

  // 7. Web Search
  const handleSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!searchQuery.trim()) return;
    setSearchLoading(true);
    try {
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: searchQuery }),
      });
      const data = await res.json();
      setSearchData(data);
    } catch {
      // ignore
    } finally {
      setSearchLoading(false);
    }
  };

  // 8. Scrape URL
  const handleScrape = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!scrapeUrl.trim()) return;
    setScrapeLoading(true);
    try {
      const res = await fetch('/api/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: scrapeUrl }),
      });
      const data = await res.json();
      setScrapeData(data);
    } catch {
      // ignore
    } finally {
      setScrapeLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-indigo-500/30">
      {/* Top Header */}
      <header className="border-b border-slate-800 bg-slate-900/95 backdrop-blur sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-orange-500 via-amber-500 to-indigo-600 p-0.5 shadow-lg shadow-orange-500/20">
              <div className="w-full h-full bg-slate-950 rounded-[10px] flex items-center justify-center">
                <Cloud className="w-5 h-5 text-orange-400" />
              </div>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-bold text-base sm:text-lg tracking-tight text-white">Claude Web Egress Bridge</h1>
                <span className="text-[10px] font-bold uppercase tracking-wider bg-orange-500/10 text-orange-400 border border-orange-500/30 px-2 py-0.5 rounded-full flex items-center gap-1">
                  <Cloud className="w-2.5 h-2.5" /> Cloudflare Native v2.0
                </span>
              </div>
              <p className="text-xs text-slate-400 hidden sm:block">
                Workers Edge &bull; R2 Persistent Storage &bull; D1 Database &bull; Queues &bull; Remote MCP
              </p>
            </div>
          </div>

          {/* Infrastructure Health Badges */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800/80 border border-slate-700/80 text-xs">
              <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-slate-300 font-mono text-[11px]">
                Egress: {health?.egress.publicIp || '34.34.246.104'}
              </span>
              <button
                onClick={checkHealth}
                disabled={healthLoading}
                className="text-slate-400 hover:text-white transition-colors ml-1 p-0.5"
                title="Refresh Cloudflare Status"
              >
                <RefreshCw className={`w-3 h-3 ${healthLoading ? 'animate-spin' : ''}`} />
              </button>
            </div>

            <button
              onClick={() => handleCopy(appBaseUrl, 'bridge-url')}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition-all shadow-sm active:scale-95"
            >
              {copiedId === 'bridge-url' ? <Check className="w-3.5 h-3.5 text-emerald-300" /> : <Copy className="w-3.5 h-3.5" />}
              <span>Copy Endpoint</span>
            </button>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 flex gap-1 sm:gap-2 overflow-x-auto scrollbar-none border-t border-slate-800/60 pt-1">
          {[
            { id: 'http', label: 'HTTP Request', icon: Send, badge: 'Priority 1' },
            { id: 'r2', label: 'R2 Object Storage', icon: HardDrive, badge: 'R2 Native' },
            { id: 'projects', label: 'Projects & Jobs', icon: FolderKanban, badge: 'D1 + Queue' },
            { id: 'download', label: 'Streaming Download', icon: Download, badge: 'Priority 2' },
            { id: 'packages', label: 'Package Registries', icon: Package, badge: 'Priority 3' },
            { id: 'search', label: 'Web Search', icon: Search, badge: undefined },
            { id: 'scrape', label: 'URL Scraper', icon: BookOpen, badge: undefined },
            { id: 'browser', label: 'Browser Engine', icon: Cpu, badge: 'CF Browser' },
            { id: 'claude', label: 'Claude MCP & Deploy', icon: Bot, badge: 'MCP 2.0' },
            { id: 'security', label: 'Security & Logs', icon: Shield, badge: 'SSRF Safe' },
          ].map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`flex items-center gap-2 px-3.5 py-2.5 border-b-2 text-xs sm:text-sm font-medium transition-all whitespace-nowrap ${
                  isActive
                    ? 'border-orange-500 text-orange-400 bg-orange-500/5'
                    : 'border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-700'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{tab.label}</span>
                {tab.badge && (
                  <span
                    className={`ml-1 px-1.5 py-0.2 text-[10px] rounded-full font-medium ${
                      isActive
                        ? 'bg-orange-500/20 text-orange-300 border border-orange-500/40'
                        : 'bg-slate-800 text-slate-400 border border-slate-700'
                    }`}
                  >
                    {tab.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8">
        {/* =================================================================== */}
        {/* TAB 1: HTTP REQUEST (PRIORITY 1)                                    */}
        {/* =================================================================== */}
        {activeTab === 'http' && (
          <div className="space-y-6">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 sm:p-6 shadow-xl relative overflow-hidden">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
                <div>
                  <h2 className="text-lg font-bold text-white flex items-center gap-2">
                    <Send className="w-5 h-5 text-indigo-400" />
                    Universal Outbound HTTP Request Tool (MCP: http_request)
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Cloudflare Worker native outbound gateway: execute GET, POST, PUT, PATCH, DELETE, HEAD requests with SSRF protection.
                  </p>
                </div>
                <div className="flex items-center gap-2 text-xs bg-indigo-500/10 text-indigo-300 border border-indigo-500/30 px-3 py-1 rounded-lg">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Outbound Edge Active</span>
                </div>
              </div>

              {/* Presets */}
              <div className="flex flex-wrap items-center gap-2 mb-4">
                <span className="text-[11px] font-medium text-slate-500 uppercase tracking-wider">Test Presets:</span>
                {[
                  { label: 'GitHub Zen API', method: 'GET', url: 'https://api.github.com/zen', body: '' },
                  { label: 'PyPI Requests Metadata', method: 'GET', url: 'https://pypi.org/pypi/requests/json', body: '' },
                  { label: 'NPM Express Package', method: 'GET', url: 'https://registry.npmjs.org/express/latest', body: '' },
                  { label: 'JSONPlaceholder POST', method: 'POST', url: 'https://jsonplaceholder.typicode.com/posts', body: '{\n  "title": "egress test",\n  "body": "from cloudflare worker",\n  "userId": 1\n}' },
                  { label: 'Public IP Echo', method: 'GET', url: 'https://api.ipify.org?format=json', body: '' },
                ].map((preset, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      setHttpMethod(preset.method as any);
                      setHttpUrl(preset.url);
                      setHttpBody(preset.body);
                    }}
                    className="text-xs px-2.5 py-1 rounded-lg bg-slate-800/80 hover:bg-slate-700/80 text-slate-300 border border-slate-700/60 transition-colors"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>

              <form onSubmit={handleHttpRequest} className="space-y-4">
                <div className="flex flex-col sm:flex-row gap-2">
                  <select
                    value={httpMethod}
                    onChange={(e) => setHttpMethod(e.target.value as any)}
                    className="bg-slate-950 border border-slate-800 text-slate-100 font-mono text-sm rounded-xl px-4 py-3 focus:outline-none focus:border-indigo-500 font-bold shrink-0"
                  >
                    <option value="GET">GET</option>
                    <option value="POST">POST</option>
                    <option value="PUT">PUT</option>
                    <option value="PATCH">PATCH</option>
                    <option value="DELETE">DELETE</option>
                    <option value="HEAD">HEAD</option>
                  </select>
                  <input
                    type="url"
                    value={httpUrl}
                    onChange={(e) => setHttpUrl(e.target.value)}
                    placeholder="Enter public endpoint (e.g. https://api.github.com/zen)..."
                    className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-100 font-mono placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                  />
                  <button
                    type="submit"
                    disabled={httpLoading || !httpUrl.trim()}
                    className="px-6 py-3 rounded-xl bg-gradient-to-r from-orange-600 to-indigo-600 hover:from-orange-500 hover:to-indigo-500 text-white font-medium text-sm transition-all disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-orange-600/20 active:scale-95 shrink-0"
                  >
                    {httpLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                    <span>Execute</span>
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">
                      Custom Request Headers (JSON):
                    </label>
                    <textarea
                      value={httpHeaders}
                      onChange={(e) => setHttpHeaders(e.target.value)}
                      rows={3}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs font-mono text-slate-200 focus:outline-none focus:border-indigo-500"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">
                      Request Body (JSON or Text payload for POST/PUT/PATCH):
                    </label>
                    <textarea
                      value={httpBody}
                      onChange={(e) => setHttpBody(e.target.value)}
                      placeholder={httpMethod === 'GET' || httpMethod === 'HEAD' ? 'N/A for GET/HEAD requests' : '{\n  "key": "value"\n}'}
                      disabled={httpMethod === 'GET' || httpMethod === 'HEAD'}
                      rows={3}
                      className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs font-mono text-slate-200 focus:outline-none focus:border-indigo-500 disabled:opacity-40"
                    />
                  </div>
                </div>
              </form>
            </div>

            {httpError && (
              <div className="p-4 rounded-xl bg-rose-950/40 border border-rose-800/80 text-rose-200 text-sm flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold">HTTP Request Failed</p>
                  <p className="text-xs text-rose-300 mt-0.5">{httpError}</p>
                </div>
              </div>
            )}

            {httpResponse && (
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-3">
                  <div className="flex items-center gap-3">
                    <span
                      className={`px-2.5 py-1 rounded-lg text-xs font-mono font-bold ${
                        httpResponse.statusCode >= 200 && httpResponse.statusCode < 300
                          ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                          : 'bg-amber-500/10 text-amber-400 border border-amber-500/30'
                      }`}
                    >
                      {httpResponse.statusCode} {httpResponse.statusText}
                    </span>
                    <span className="text-xs text-slate-400 font-mono truncate">{httpResponse.url}</span>
                  </div>

                  <div className="flex items-center gap-3 text-xs text-slate-400 font-mono">
                    <span>Latency: {httpResponse.executionTimeMs}ms</span>
                    <span>&bull;</span>
                    <span>Size: {httpResponse.contentLength} bytes</span>
                    <button
                      onClick={() => handleCopy(JSON.stringify(httpResponse.body, null, 2), 'http-res-body')}
                      className="text-indigo-400 hover:text-indigo-300 flex items-center gap-1 font-sans"
                    >
                      {copiedId === 'http-res-body' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>Copy Body</span>
                    </button>
                  </div>
                </div>

                <div>
                  <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Response Body:</h4>
                  <pre className="p-4 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-emerald-400 overflow-x-auto max-h-[450px] leading-relaxed">
                    {typeof httpResponse.body === 'object'
                      ? JSON.stringify(httpResponse.body, null, 2)
                      : String(httpResponse.body)}
                  </pre>
                </div>
              </div>
            )}
          </div>
        )}

        {/* =================================================================== */}
        {/* TAB 2: CLOUDFLARE R2 OBJECT STORAGE (SECTION 3B & 6)                */}
        {/* =================================================================== */}
        {activeTab === 'r2' && (
          <div className="space-y-6">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 sm:p-6 shadow-xl space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-bold text-white flex items-center gap-2">
                    <HardDrive className="w-5 h-5 text-orange-400" />
                    Cloudflare R2 Object Storage Browser
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Zero-egress-fee persistent object storage for multi-gigabyte ZIP archives, BVH animations, 3D models, PDFs, and code repositories.
                  </p>
                </div>
                <button
                  onClick={() => loadFiles(selectedProject)}
                  disabled={filesLoading}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium rounded-lg flex items-center gap-1.5 border border-slate-700 self-start sm:self-auto"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${filesLoading ? 'animate-spin' : ''}`} />
                  <span>Refresh Storage</span>
                </button>
              </div>

              {/* Direct Ingest to R2 Form */}
              <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-3">
                <h4 className="text-xs font-semibold text-slate-300 flex items-center gap-1.5">
                  <Download className="w-3.5 h-3.5 text-orange-400" />
                  <span>Ingest Remote Asset directly into R2 Storage:</span>
                </h4>
                <div className="flex flex-col sm:flex-row gap-2">
                  <select
                    value={selectedProject}
                    onChange={(e) => {
                      setSelectedProject(e.target.value);
                      loadFiles(e.target.value);
                    }}
                    className="bg-slate-900 border border-slate-800 text-slate-200 text-xs rounded-xl px-3 py-2.5 font-medium shrink-0"
                  >
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        Project: {p.name}
                      </option>
                    ))}
                  </select>

                  <input
                    type="url"
                    value={manualDownloadUrl}
                    onChange={(e) => setManualDownloadUrl(e.target.value)}
                    placeholder="Enter file URL to stream into R2 (e.g. dataset.csv, model.glb, archive.zip)..."
                    className="flex-1 bg-slate-900 border border-slate-800 text-slate-100 font-mono text-xs rounded-xl px-3 py-2.5 focus:outline-none focus:border-orange-500"
                  />

                  <button
                    onClick={handleDownloadToR2}
                    disabled={dlLoading || !manualDownloadUrl.trim()}
                    className="px-5 py-2.5 bg-orange-600 hover:bg-orange-500 text-white text-xs font-semibold rounded-xl flex items-center justify-center gap-1.5 disabled:opacity-50 shrink-0"
                  >
                    {dlLoading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <HardDrive className="w-3.5 h-3.5" />}
                    <span>Stream to R2</span>
                  </button>
                </div>
              </div>

              {/* Stored Files Table */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                    Stored Objects in R2 Bucket ({storedFiles.length}):
                  </h4>
                  <span className="text-xs text-slate-500">Persistent storage backed by Cloudflare R2</span>
                </div>

                {storedFiles.length === 0 ? (
                  <div className="text-center py-10 bg-slate-950 rounded-xl border border-slate-800 text-slate-500 text-xs">
                    No files stored in this project yet. Use the stream downloader or Claude MCP to ingest assets.
                  </div>
                ) : (
                  <div className="divide-y divide-slate-800 border border-slate-800 rounded-xl overflow-hidden max-h-[500px] overflow-y-auto">
                    {storedFiles.map((file) => (
                      <div key={file.id} className="p-3.5 bg-slate-950/70 hover:bg-slate-900 flex items-center justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-xs text-slate-200 truncate">{file.filename}</span>
                            <span className="text-[10px] bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded font-mono">
                              {(file.size_bytes / 1024).toFixed(1)} KB
                            </span>
                          </div>
                          <div className="text-[11px] font-mono text-slate-500 truncate mt-0.5">
                            R2 Key: {file.r2_key} &bull; SHA-256: {file.sha256.substring(0, 16)}...
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <a
                            href={`/api/download/file/${encodeURIComponent(file.r2_key)}`}
                            target="_blank"
                            rel="noreferrer"
                            className="px-3 py-1.5 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/40 text-indigo-300 border border-indigo-500/30 text-xs font-medium flex items-center gap-1"
                          >
                            <Download className="w-3.5 h-3.5" />
                            <span>Download</span>
                          </a>
                          <button
                            onClick={() => handleDeleteFile(file.r2_key)}
                            className="p-1.5 rounded-lg bg-rose-950/30 hover:bg-rose-900/50 text-rose-400 border border-rose-800/40 text-xs"
                            title="Delete from R2"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* =================================================================== */}
        {/* TAB 3: PROJECTS & ASYNC QUEUE JOBS (SECTION 3C & 3D)                */}
        {/* =================================================================== */}
        {activeTab === 'projects' && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Project Manager */}
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-bold text-base text-white flex items-center gap-2">
                    <FolderKanban className="w-4 h-4 text-indigo-400" />
                    <span>D1 Project Namespaces</span>
                  </h3>
                  <span className="text-xs text-slate-400 font-mono">{projects.length} projects</span>
                </div>

                <form onSubmit={handleCreateProject} className="space-y-2">
                  <input
                    type="text"
                    value={newProjectName}
                    onChange={(e) => setNewProjectName(e.target.value)}
                    placeholder="New Project Name (e.g. 3D-Animation-Packs)..."
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
                  />
                  <input
                    type="text"
                    value={newProjectDesc}
                    onChange={(e) => setNewProjectDesc(e.target.value)}
                    placeholder="Description (optional)..."
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
                  />
                  <button
                    type="submit"
                    disabled={!newProjectName.trim()}
                    className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-xl disabled:opacity-50"
                  >
                    Create Project
                  </button>
                </form>

                <div className="divide-y divide-slate-800 border border-slate-800 rounded-xl overflow-hidden max-h-60 overflow-y-auto">
                  {projects.map((p) => (
                    <div key={p.id} className="p-3 bg-slate-950/70 hover:bg-slate-900 flex items-center justify-between">
                      <div>
                        <div className="font-semibold text-xs text-slate-200">{p.name}</div>
                        <div className="text-[10px] text-slate-500 font-mono">ID: {p.id}</div>
                      </div>
                      <button
                        onClick={() => {
                          setSelectedProject(p.id);
                          setActiveTab('r2');
                          loadFiles(p.id);
                        }}
                        className="text-xs text-indigo-400 hover:underline font-medium"
                      >
                        View Files &rarr;
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Background Queues Jobs Tracker */}
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-bold text-base text-white flex items-center gap-2">
                    <Activity className="w-4 h-4 text-orange-400" />
                    <span>Cloudflare Queue Transfer Jobs</span>
                  </h3>
                  <span className="text-xs text-slate-400 font-mono">{jobs.length} jobs</span>
                </div>

                <form onSubmit={handleCreateAsyncJob} className="space-y-2">
                  <input
                    type="url"
                    value={asyncJobUrl}
                    onChange={(e) => setAsyncJobUrl(e.target.value)}
                    placeholder="URL for non-blocking background queue transfer..."
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-100 font-mono focus:outline-none focus:border-orange-500"
                  />
                  <button
                    type="submit"
                    disabled={!asyncJobUrl.trim()}
                    className="w-full py-2 bg-orange-600 hover:bg-orange-500 text-white text-xs font-semibold rounded-xl disabled:opacity-50"
                  >
                    Enqueue Background Transfer
                  </button>
                </form>

                <div className="divide-y divide-slate-800 border border-slate-800 rounded-xl overflow-hidden max-h-60 overflow-y-auto">
                  {jobs.length === 0 ? (
                    <div className="text-center py-8 text-slate-500 text-xs bg-slate-950">No background jobs active</div>
                  ) : (
                    jobs.map((j) => (
                      <div key={j.id} className="p-3 bg-slate-950/70 hover:bg-slate-900 text-xs">
                        <div className="flex items-center justify-between">
                          <span className="font-mono text-[11px] text-slate-400 truncate max-w-[200px]">{j.source_url}</span>
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                              j.status === 'completed'
                                ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                                : j.status === 'processing'
                                ? 'bg-amber-500/10 text-amber-400 border border-amber-500/30 animate-pulse'
                                : 'bg-slate-800 text-slate-400'
                            }`}
                          >
                            {j.status}
                          </span>
                        </div>
                        <div className="text-[10px] text-slate-500 mt-1 font-mono">
                          ID: {j.id} &bull; Progress: {j.progress_percent}%
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* =================================================================== */}
        {/* TAB 4: STREAMING DOWNLOAD (PRIORITY 2)                              */}
        {/* =================================================================== */}
        {activeTab === 'download' && (
          <div className="space-y-6">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 sm:p-6 shadow-xl space-y-4">
              <div>
                <h2 className="text-lg font-bold text-white flex items-center gap-2">
                  <Download className="w-5 h-5 text-indigo-400" />
                  Universal Streaming File Downloader (MCP: download_file)
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Stream downloads for ZIP, PDF, CSV, JSON, source code, images, and binary artifacts directly into persistent R2 storage.
                </p>
              </div>

              <form onSubmit={handleDownloadToR2} className="space-y-3">
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="url"
                    value={dlUrl}
                    onChange={(e) => setDlUrl(e.target.value)}
                    placeholder="Enter file URL (e.g. https://raw.githubusercontent.com/.../data.json or archive.zip)..."
                    className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-100 font-mono placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                  />
                  <button
                    type="submit"
                    disabled={dlLoading || !dlUrl.trim()}
                    className="px-6 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-sm transition-all disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/20 active:scale-95 shrink-0"
                  >
                    {dlLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                    <span>Stream & Save</span>
                  </button>
                </div>
              </form>
            </div>

            {dlResult && (
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl space-y-3">
                <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    <h3 className="font-bold text-sm text-white">Stored in R2: {dlResult.filename}</h3>
                  </div>
                  <a
                    href={dlResult.downloadUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-lg flex items-center gap-1.5"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Download File</span>
                  </a>
                </div>
                <div className="text-xs font-mono text-slate-300 space-y-1">
                  <div>R2 Key: {dlResult.r2Key}</div>
                  <div>Size: {(dlResult.sizeBytes / 1024).toFixed(1)} KB</div>
                  <div>SHA-256: {dlResult.sha256}</div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* =================================================================== */}
        {/* TAB 5: PACKAGE REGISTRIES (PRIORITY 3)                              */}
        {/* =================================================================== */}
        {activeTab === 'packages' && (
          <div className="space-y-6">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 sm:p-6 shadow-xl space-y-4">
              <div>
                <h2 className="text-lg font-bold text-white flex items-center gap-2">
                  <Package className="w-5 h-5 text-indigo-400" />
                  Package Registry Inspector (NPM, PyPI, GitHub, Crates)
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Search package metadata, release archives, dependencies, and download URLs from official registries.
                </p>
              </div>

              <form onSubmit={handlePackageLookup} className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                  <select
                    value={pkgEcosystem}
                    onChange={(e) => setPkgEcosystem(e.target.value as any)}
                    className="bg-slate-950 border border-slate-800 text-slate-100 font-mono text-xs sm:text-sm rounded-xl px-3 py-3 font-semibold focus:outline-none focus:border-indigo-500"
                  >
                    <option value="npm">NPM (registry.npmjs.org)</option>
                    <option value="pypi">PyPI (pypi.org)</option>
                    <option value="github">GitHub Releases</option>
                    <option value="crates">Rust (crates.io)</option>
                  </select>

                  <input
                    type="text"
                    value={pkgName}
                    onChange={(e) => setPkgName(e.target.value)}
                    placeholder={pkgEcosystem === 'github' ? 'owner/repo (e.g. anthropics/claude-code)' : 'package name...'}
                    className="sm:col-span-2 bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-100 font-mono focus:outline-none focus:border-indigo-500"
                  />

                  <button
                    type="submit"
                    disabled={pkgLoading || !pkgName.trim()}
                    className="px-5 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-sm transition-all disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/20 active:scale-95"
                  >
                    {pkgLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                    <span>Inspect</span>
                  </button>
                </div>
              </form>
            </div>

            {pkgData && (
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl space-y-4">
                <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                  <div className="flex items-center gap-2">
                    <Package className="w-4 h-4 text-indigo-400" />
                    <h3 className="font-bold text-sm text-white">
                      {pkgData.name || pkgData.fullName} ({pkgData.ecosystem?.toUpperCase()})
                    </h3>
                  </div>
                  {(pkgData.tarballUrl || pkgData.primaryDownloadUrl) && (
                    <a
                      href={`/api/download?url=${encodeURIComponent(pkgData.tarballUrl || pkgData.primaryDownloadUrl)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="px-3 py-1.5 rounded-lg bg-orange-600 hover:bg-orange-500 text-white text-xs font-semibold flex items-center gap-1.5"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>Stream Archive to R2</span>
                    </a>
                  )}
                </div>
                <pre className="p-4 bg-slate-950 border border-slate-800 rounded-xl text-xs font-mono text-slate-300 overflow-x-auto max-h-[450px]">
                  {JSON.stringify(pkgData, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}

        {/* =================================================================== */}
        {/* TAB 6: WEB SEARCH & TAB 7: SCRAPER                                  */}
        {/* =================================================================== */}
        {activeTab === 'search' && (
          <div className="space-y-6">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 sm:p-6 shadow-xl space-y-3">
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <Search className="w-5 h-5 text-indigo-400" />
                Live Web Search & Grounding (MCP: web_search)
              </h2>
              <form onSubmit={handleSearch} className="flex gap-2">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search the web (e.g. 'Cloudflare Workers R2 pricing 2025')..."
                  className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                />
                <button
                  type="submit"
                  disabled={searchLoading || !searchQuery.trim()}
                  className="px-6 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-sm transition-all disabled:opacity-50 flex items-center gap-2"
                >
                  {searchLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                  <span>Search</span>
                </button>
              </form>
            </div>

            {searchData && (
              <div className="space-y-3">
                {searchData.summary && (
                  <div className="p-4 bg-indigo-950/20 border border-indigo-500/30 rounded-xl text-xs text-slate-200 leading-relaxed whitespace-pre-line">
                    {searchData.summary}
                  </div>
                )}
                {searchData.results?.map((r: any, idx: number) => (
                  <div key={idx} className="p-3.5 bg-slate-900 border border-slate-800 rounded-xl">
                    <a href={r.url} target="_blank" rel="noreferrer" className="font-semibold text-xs text-indigo-400 hover:underline">
                      {r.title}
                    </a>
                    <p className="text-[11px] text-slate-500 font-mono truncate">{r.url}</p>
                    {r.snippet && <p className="text-xs text-slate-300 mt-1">{r.snippet}</p>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'scrape' && (
          <div className="space-y-6">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 sm:p-6 shadow-xl space-y-3">
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <BookOpen className="w-5 h-5 text-indigo-400" />
                Readability Web Scraper (MCP: fetch_webpage)
              </h2>
              <form onSubmit={handleScrape} className="flex gap-2">
                <input
                  type="url"
                  value={scrapeUrl}
                  onChange={(e) => setScrapeUrl(e.target.value)}
                  placeholder="Enter URL to scrape into clean Markdown..."
                  className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-100 font-mono focus:outline-none focus:border-indigo-500"
                />
                <button
                  type="submit"
                  disabled={scrapeLoading || !scrapeUrl.trim()}
                  className="px-6 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-sm transition-all disabled:opacity-50 flex items-center gap-2"
                >
                  {scrapeLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                  <span>Scrape</span>
                </button>
              </form>
            </div>

            {scrapeData && (
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl space-y-4">
                <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                  <h3 className="font-bold text-sm text-white">{scrapeData.title || 'Page Content'}</h3>
                  <button
                    onClick={() => handleCopy(scrapeData.markdown || scrapeData.plainText, 'scrape-copy')}
                    className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold rounded-lg flex items-center gap-1.5"
                  >
                    {copiedId === 'scrape-copy' ? <Check className="w-3.5 h-3.5 text-emerald-300" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>Copy Markdown</span>
                  </button>
                </div>
                <div className="prose prose-invert prose-indigo max-w-none text-xs text-slate-200 whitespace-pre-wrap max-h-96 overflow-y-auto p-4 bg-slate-950 rounded-xl border border-slate-800">
                  {scrapeData.markdown || scrapeData.plainText}
                </div>
              </div>
            )}
          </div>
        )}

        {/* =================================================================== */}
        {/* TAB 8: CLOUDFLARE BROWSER ENGINE (PRIORITY 5 & SECTION 5)           */}
        {/* =================================================================== */}
        {activeTab === 'browser' && (
          <div className="space-y-6">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 sm:p-6 shadow-xl space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-bold text-white flex items-center gap-2">
                    <Cpu className="w-5 h-5 text-orange-400" />
                    Cloudflare Browser Rendering (Puppeteer Engine)
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Real headless browser automation running on Cloudflare’s global edge.
                  </p>
                </div>
                <span
                  className={`text-xs px-3 py-1 rounded-full font-semibold border ${
                    browserInfo?.isAvailable
                      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                      : 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                  }`}
                >
                  {browserInfo?.isAvailable ? 'CF Browser Rendering Active' : 'Requires Cloudflare Workers Paid Plan'}
                </span>
              </div>

              {/* Honest Evaluation Card */}
              <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-amber-300">
                  <AlertCircle className="w-4 h-4 text-amber-400" />
                  <span>Cloudflare Browser Rendering Status</span>
                </div>
                <p className="text-xs text-slate-300 leading-relaxed">
                  {browserInfo?.message ||
                    'Cloudflare Browser Rendering binding (MYBROWSER) is configured in wrangler.jsonc. When deployed to a Workers Paid account, it provides full Puppeteer browser automation (clicks, forms, JavaScript execution, and screenshots).'}
                </p>

                <div className="p-3 bg-slate-900 rounded-xl border border-slate-800 text-xs text-slate-300 space-y-2">
                  <div className="font-semibold text-indigo-300">How to Enable in Cloudflare Dashboard:</div>
                  <ol className="list-decimal pl-4 space-y-1 text-slate-400">
                    <li>Log in to the Cloudflare Dashboard on mobile or desktop.</li>
                    <li>Go to Workers & Pages &gt; Browser Rendering.</li>
                    <li>Click &quot;Enable Browser Rendering&quot; on your account.</li>
                    <li>Deploy the worker: <code>wrangler deploy</code> (or via Cloudflare Dashboard upload).</li>
                  </ol>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* =================================================================== */}
        {/* TAB 9: CLAUDE MCP & CLOUDFLARE DEPLOYMENT GUIDE (SECTION 8 & 11)   */}
        {/* =================================================================== */}
        {activeTab === 'claude' && (
          <div className="space-y-6">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 sm:p-6 shadow-xl space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-bold text-white flex items-center gap-2">
                    <Bot className="w-5 h-5 text-purple-400" />
                    Connect Claude Free / Claude Code via Remote MCP
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Universal remote Model Context Protocol endpoint giving Claude Free genuine outbound internet access.
                  </p>
                </div>
                <div className="text-xs font-mono bg-purple-500/10 text-purple-300 border border-purple-500/30 px-3 py-1 rounded-lg">
                  MCP Endpoint: {appBaseUrl}/api/mcp
                </div>
              </div>

              {/* Sub-tabs */}
              <div className="flex flex-wrap gap-2 border-b border-slate-800 pb-3">
                {[
                  { id: 'mobile', label: 'Android Phone / Web Dashboard Deploy', icon: Smartphone },
                  { id: 'cli', label: 'Wrangler CLI Deploy', icon: Terminal },
                  { id: 'mcp-config', label: 'Claude Connection Settings', icon: Bot },
                ].map((st) => {
                  const Icon = st.icon;
                  return (
                    <button
                      key={st.id}
                      onClick={() => setDeployGuideTab(st.id as any)}
                      className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-all flex items-center gap-1.5 ${
                        deployGuideTab === st.id
                          ? 'bg-purple-600 text-white shadow-md shadow-purple-600/20'
                          : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      <Icon className="w-3.5 h-3.5" />
                      <span>{st.label}</span>
                    </button>
                  );
                })}
              </div>

              {/* Guide 1: Android Phone Deployment */}
              {deployGuideTab === 'mobile' && (
                <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 space-y-3 text-xs leading-relaxed">
                  <div className="font-semibold text-orange-400 text-sm flex items-center gap-1.5">
                    <Smartphone className="w-4 h-4" />
                    <span>How to Deploy from Android Phone via Cloudflare Web Dashboard:</span>
                  </div>
                  <ol className="list-decimal pl-5 space-y-2 text-slate-300">
                    <li>
                      <strong>Create R2 Bucket:</strong> Open <a href="https://dash.cloudflare.com" target="_blank" rel="noreferrer" className="text-indigo-400 underline">dash.cloudflare.com</a> on your phone &rarr; <em>R2 Object Storage</em> &rarr; <em>Create bucket</em> named <code className="text-orange-300">claude-egress-assets</code>.
                    </li>
                    <li>
                      <strong>Create D1 Database:</strong> In the dashboard, tap <em>Workers & Pages</em> &rarr; <em>D1 SQL Database</em> &rarr; <em>Create database</em> named <code className="text-orange-300">claude_egress_db</code>. Tap the console tab and run the SQL migration from <code className="text-orange-300">migrations/0001_initial_schema.sql</code>.
                    </li>
                    <li>
                      <strong>Deploy Worker:</strong> Tap <em>Create Worker</em> named <code className="text-orange-300">claude-web-egress-bridge</code> &rarr; in Settings &gt; Bindings, bind:
                      <ul className="list-disc pl-4 mt-1 space-y-0.5 text-slate-400">
                        <li>R2: <code className="text-slate-200">STORAGE_BUCKET</code> &rarr; <code className="text-slate-200">claude-egress-assets</code></li>
                        <li>D1: <code className="text-slate-200">DB</code> &rarr; <code className="text-slate-200">claude_egress_db</code></li>
                      </ul>
                    </li>
                    <li>
                      <strong>Connect to Claude:</strong> Copy your worker URL (e.g. <code className="text-emerald-400">https://claude-web-egress-bridge.&lt;user&gt;.workers.dev/api/mcp</code>) and add it to Claude!
                    </li>
                  </ol>
                </div>
              )}

              {/* Guide 2: Wrangler CLI */}
              {deployGuideTab === 'cli' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-xs font-semibold text-slate-300">
                    <span>One-Click CLI Commands:</span>
                    <button
                      onClick={() =>
                        handleCopy(
                          `# 1. Create R2 bucket\nnpx wrangler r2 bucket create claude-egress-assets\n\n# 2. Create D1 database\nnpx wrangler d1 create claude_egress_db\n\n# 3. Apply schema migrations\nnpx wrangler d1 execute claude_egress_db --file=migrations/0001_initial_schema.sql\n\n# 4. Deploy worker\nnpx wrangler deploy`,
                          'cli-full-cmd'
                        )
                      }
                      className="text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
                    >
                      {copiedId === 'cli-full-cmd' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>Copy All Commands</span>
                    </button>
                  </div>
                  <pre className="p-4 bg-slate-950 border border-slate-800 rounded-xl font-mono text-xs text-emerald-400 overflow-x-auto leading-relaxed">
{`# 1. Create R2 bucket
npx wrangler r2 bucket create claude-egress-assets

# 2. Create D1 database
npx wrangler d1 create claude_egress_db

# 3. Apply database migration
npx wrangler d1 execute claude_egress_db --file=migrations/0001_initial_schema.sql

# 4. Deploy Worker
npx wrangler deploy`}
                  </pre>
                </div>
              )}

              {/* Guide 3: Claude Connection */}
              {deployGuideTab === 'mcp-config' && (
                <div className="space-y-3">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs font-semibold text-slate-300">
                      <span>Claude Code CLI Command:</span>
                      <button
                        onClick={() => handleCopy(`claude mcp add web-bridge --url ${appBaseUrl}/api/mcp`, 'claude-add')}
                        className="text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
                      >
                        {copiedId === 'claude-add' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                        <span>Copy</span>
                      </button>
                    </div>
                    <pre className="p-3 bg-slate-950 border border-slate-800 rounded-xl font-mono text-xs text-emerald-400 overflow-x-auto">
                      claude mcp add web-bridge --url {appBaseUrl}/api/mcp
                    </pre>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs font-semibold text-slate-300">
                      <span>Or ~/.claude.json Configuration:</span>
                      <button
                        onClick={() =>
                          handleCopy(
                            JSON.stringify(
                              {
                                mcpServers: {
                                  'web-bridge': {
                                    url: `${appBaseUrl}/api/mcp`,
                                    transport: 'http',
                                  },
                                },
                              },
                              null,
                              2
                            ),
                            'json-config'
                          )
                        }
                        className="text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
                      >
                        {copiedId === 'json-config' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                        <span>Copy JSON</span>
                      </button>
                    </div>
                    <pre className="p-3 bg-slate-950 border border-slate-800 rounded-xl font-mono text-xs text-slate-300 overflow-x-auto">
{JSON.stringify(
  {
    mcpServers: {
      'web-bridge': {
        url: `${appBaseUrl}/api/mcp`,
        transport: 'http',
      },
    },
  },
  null,
  2
)}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* =================================================================== */}
        {/* TAB 10: SECURITY CONTROLS & AUDIT LOGS (PRIORITY 7)                 */}
        {/* =================================================================== */}
        {activeTab === 'security' && (
          <div className="space-y-6">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 sm:p-6 shadow-xl space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-bold text-white flex items-center gap-2">
                    <Shield className="w-5 h-5 text-emerald-400" />
                    Security Controls & Persistent Audit Trail
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Real-time SSRF defense, DNS rebinding mitigation, rate limiting, and D1 persistent audit logs.
                  </p>
                </div>
                <button
                  onClick={loadLogs}
                  disabled={logsLoading}
                  className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium rounded-lg flex items-center gap-1.5 border border-slate-700"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${logsLoading ? 'animate-spin' : ''}`} />
                  <span>Refresh Logs</span>
                </button>
              </div>

              {/* Logs Table */}
              <div className="space-y-2 pt-2">
                <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
                  Outbound Request History ({auditLogs.length}):
                </h4>

                {auditLogs.length === 0 ? (
                  <div className="text-center py-8 bg-slate-950 rounded-xl border border-slate-800 text-slate-500 text-xs">
                    No requests recorded yet.
                  </div>
                ) : (
                  <div className="divide-y divide-slate-800 border border-slate-800 rounded-xl overflow-hidden max-h-[450px] overflow-y-auto">
                    {auditLogs.map((log) => (
                      <div key={log.id} className="p-3 bg-slate-950/70 hover:bg-slate-900 flex items-center justify-between gap-4 text-xs">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-mono font-bold text-slate-300">{log.method}</span>
                            <span className="font-mono text-indigo-400 truncate">{log.target_url}</span>
                          </div>
                          <div className="text-[11px] text-slate-500 mt-0.5 flex items-center gap-2">
                            <span>Tool: {log.tool_name}</span>
                            <span>&bull;</span>
                            <span>{new Date(log.created_at).toLocaleTimeString()}</span>
                          </div>
                        </div>

                        <div className="flex items-center gap-3 shrink-0 font-mono text-[11px]">
                          <span
                            className={`px-2 py-0.5 rounded font-bold ${
                              log.status_code === 'BLOCKED' || parseInt(log.status_code, 10) >= 400
                                ? 'bg-rose-500/10 text-rose-400 border border-rose-500/30'
                                : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                            }`}
                          >
                            {log.status_code}
                          </span>
                          <span className="text-slate-400">{log.duration_ms}ms</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-800/80 bg-slate-950 py-3.5 px-4 text-center text-xs text-slate-400">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2">
          <span>Claude Web Egress Bridge &bull; Cloudflare Native Migration Architecture</span>
          <div className="flex items-center gap-4">
            <span className="font-mono text-[11px]">Public Egress: {health?.egress.publicIp || 'Active'}</span>
            <button onClick={() => handleCopy(appBaseUrl, 'footer-url')} className="hover:text-slate-200">
              Copy URL
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
