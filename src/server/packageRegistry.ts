import { validateUrlSafety } from './security';

export interface PackageLookupOptions {
  ecosystem: 'npm' | 'pypi' | 'github' | 'crates';
  packageName: string;
  version?: string;
  action?: 'metadata' | 'versions' | 'releases' | 'readme' | 'download_url';
}

const REGISTRY_UA = 'Claude-Web-Egress-Bridge/1.2 (Package Inspector; contact: support)';

export async function lookupPackage(options: PackageLookupOptions) {
  const { ecosystem, packageName, version, action = 'metadata' } = options;
  const cleanName = packageName.trim();

  if (!cleanName) {
    throw new Error('Missing package name');
  }

  // 1. NPM Registry (registry.npmjs.org)
  if (ecosystem === 'npm') {
    // e.g. express or @types/node -> encodeURIComponent for scoped packages
    const encodedPkg = cleanName.startsWith('@')
      ? `@${encodeURIComponent(cleanName.slice(1))}`
      : encodeURIComponent(cleanName);

    const npmUrl = `https://registry.npmjs.org/${encodedPkg}`;
    const safety = await validateUrlSafety(npmUrl);
    if (!safety.safe) throw new Error(safety.error);

    const res = await fetch(npmUrl, {
      headers: { 'User-Agent': REGISTRY_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      if (res.status === 404) throw new Error(`npm package '${cleanName}' not found in registry.npmjs.org`);
      throw new Error(`npm registry returned HTTP ${res.status}: ${res.statusText}`);
    }

    const data: any = await res.json();
    const latestVersion = data['dist-tags']?.latest || Object.keys(data.versions || {}).pop() || '';
    const targetVersion = version && version !== 'latest' ? version : latestVersion;
    const versionObj = data.versions?.[targetVersion] || {};

    if (action === 'versions') {
      return {
        ecosystem: 'npm',
        name: data.name,
        latest: latestVersion,
        distTags: data['dist-tags'],
        versions: Object.keys(data.versions || {}),
        time: data.time,
      };
    }

    if (action === 'readme') {
      return {
        ecosystem: 'npm',
        name: data.name,
        version: targetVersion,
        readme: data.readme || versionObj.readme || 'No README text provided in npm metadata.',
      };
    }

    if (action === 'download_url') {
      const tarball = versionObj.dist?.tarball;
      return {
        ecosystem: 'npm',
        name: data.name,
        version: targetVersion,
        tarballUrl: tarball,
        integrity: versionObj.dist?.integrity,
        shasum: versionObj.dist?.shasum,
        fileCount: versionObj.dist?.fileCount,
        unpackedSize: versionObj.dist?.unpackedSize,
      };
    }

    // Default: 'metadata'
    return {
      ecosystem: 'npm',
      name: data.name,
      description: data.description || versionObj.description || '',
      latestVersion,
      requestedVersion: targetVersion,
      license: versionObj.license || data.license || 'Unknown',
      homepage: data.homepage || versionObj.homepage || '',
      repository: data.repository?.url || versionObj.repository?.url || '',
      author: data.author || versionObj.author,
      dependencies: versionObj.dependencies || {},
      devDependencies: versionObj.devDependencies || {},
      tarballUrl: versionObj.dist?.tarball || '',
      unpackedSize: versionObj.dist?.unpackedSize,
      keywords: data.keywords || [],
      publishedTime: data.time?.[targetVersion] || data.time?.modified,
      note: 'Package metadata retrieved via remote gateway. (Does not install into Claude environment).',
    };
  }

  // 2. PyPI (pypi.org / files.pythonhosted.org)
  if (ecosystem === 'pypi') {
    const pypiUrl = version && version !== 'latest'
      ? `https://pypi.org/pypi/${encodeURIComponent(cleanName)}/${encodeURIComponent(version)}/json`
      : `https://pypi.org/pypi/${encodeURIComponent(cleanName)}/json`;

    const safety = await validateUrlSafety(pypiUrl);
    if (!safety.safe) throw new Error(safety.error);

    const res = await fetch(pypiUrl, {
      headers: { 'User-Agent': REGISTRY_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      if (res.status === 404) throw new Error(`PyPI package '${cleanName}' not found on pypi.org`);
      throw new Error(`PyPI returned HTTP ${res.status}: ${res.statusText}`);
    }

    const data: any = await res.json();
    const info = data.info || {};
    const releases = data.releases || {};
    const targetVersion = info.version || version || 'latest';
    const currentFiles = data.urls || releases[targetVersion] || [];

    if (action === 'versions') {
      return {
        ecosystem: 'pypi',
        name: info.name,
        latest: info.version,
        versions: Object.keys(releases),
      };
    }

    if (action === 'readme') {
      return {
        ecosystem: 'pypi',
        name: info.name,
        version: targetVersion,
        descriptionContentType: info.description_content_type,
        readme: info.description || 'No description provided.',
      };
    }

    if (action === 'download_url' || action === 'releases') {
      return {
        ecosystem: 'pypi',
        name: info.name,
        version: targetVersion,
        releaseFiles: currentFiles.map((f: any) => ({
          filename: f.filename,
          packagetype: f.packagetype, // bdist_wheel, sdist
          pythonVersion: f.python_version,
          sizeBytes: f.size,
          uploadTime: f.upload_time_iso_8601 || f.upload_time,
          url: f.url,
          hashes: f.digests,
        })),
      };
    }

    // Default metadata
    return {
      ecosystem: 'pypi',
      name: info.name,
      version: info.version,
      summary: info.summary,
      author: info.author,
      authorEmail: info.author_email,
      license: info.license,
      homePage: info.home_page || info.project_urls?.Homepage || '',
      projectUrls: info.project_urls || {},
      requiresDist: info.requires_dist || [],
      requiresPython: info.requires_python,
      downloadFilesCount: currentFiles.length,
      primaryDownloadUrl: currentFiles[0]?.url || '',
      note: 'PyPI metadata retrieved via remote gateway. (Does not install into Claude environment).',
    };
  }

  // 3. GitHub Repositories & Releases (api.github.com)
  if (ecosystem === 'github') {
    // cleanName format: owner/repo
    const parts = cleanName.split('/');
    if (parts.length < 2) {
      throw new Error("GitHub repository must be in 'owner/repo' format (e.g. 'anthropics/claude-code' or 'expressjs/express')");
    }
    const [owner, repo] = parts;
    const repoUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

    const safety = await validateUrlSafety(repoUrl);
    if (!safety.safe) throw new Error(safety.error);

    if (action === 'releases') {
      const releasesUrl = `${repoUrl}/releases`;
      const res = await fetch(releasesUrl, {
        headers: { 'User-Agent': REGISTRY_UA, Accept: 'application/vnd.github.v3+json' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`GitHub releases API returned HTTP ${res.status}`);
      const releasesData = (await res.json()) as any[];
      return {
        ecosystem: 'github',
        repo: `${owner}/${repo}`,
        releases: releasesData.slice(0, 10).map((r: any) => ({
          tag: r.tag_name,
          name: r.name,
          publishedAt: r.published_at,
          tarballUrl: r.tarball_url,
          zipballUrl: r.zipball_url,
          assets: (r.assets || []).map((a: any) => ({
            name: a.name,
            size: a.size,
            downloadUrl: a.browser_download_url,
            contentType: a.content_type,
          })),
        })),
      };
    }

    if (action === 'readme') {
      const readmeUrl = `${repoUrl}/readme`;
      const res = await fetch(readmeUrl, {
        headers: { 'User-Agent': REGISTRY_UA, Accept: 'application/vnd.github.v3.raw' },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`GitHub README returned HTTP ${res.status}`);
      const readmeText = await res.text();
      return {
        ecosystem: 'github',
        repo: `${owner}/${repo}`,
        readme: readmeText,
      };
    }

    // Default metadata
    const res = await fetch(repoUrl, {
      headers: { 'User-Agent': REGISTRY_UA, Accept: 'application/vnd.github.v3+json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`GitHub repo returned HTTP ${res.status}: ${res.statusText}`);
    const data: any = await res.json();

    return {
      ecosystem: 'github',
      fullName: data.full_name,
      description: data.description,
      stars: data.stargazers_count,
      forks: data.forks_count,
      openIssues: data.open_issues_count,
      defaultBranch: data.default_branch,
      language: data.language,
      license: data.license?.spdx_id || data.license?.name,
      homepage: data.homepage,
      htmlUrl: data.html_url,
      cloneUrl: data.clone_url,
      tarballUrl: `${data.html_url}/archive/refs/heads/${data.default_branch}.tar.gz`,
      updatedAt: data.updated_at,
    };
  }

  // 4. Crates.io (Rust ecosystem)
  if (ecosystem === 'crates') {
    const cratesUrl = `https://crates.io/api/v1/crates/${encodeURIComponent(cleanName)}`;
    const safety = await validateUrlSafety(cratesUrl);
    if (!safety.safe) throw new Error(safety.error);

    const res = await fetch(cratesUrl, {
      headers: { 'User-Agent': REGISTRY_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Crates.io returned HTTP ${res.status}`);
    const data: any = await res.json();
    const crate = data.crate || {};

    return {
      ecosystem: 'crates',
      name: crate.name,
      maxVersion: crate.max_version,
      description: crate.description,
      downloads: crate.downloads,
      documentation: crate.documentation,
      repository: crate.repository,
      homepage: crate.homepage,
      recentVersions: (data.versions || []).slice(0, 5).map((v: any) => ({
        num: v.num,
        dl_path: `https://crates.io${v.dl_path}`,
        crate_size: v.crate_size,
      })),
    };
  }

  throw new Error(`Unsupported ecosystem: ${ecosystem}. Supported: npm, pypi, github, crates`);
}
