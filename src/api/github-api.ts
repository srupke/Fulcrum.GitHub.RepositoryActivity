import { fetchAuthSession } from 'aws-amplify/auth';

// ── Data shapes ─────────────────────────────────────────────────────────────

export interface OrgInfo {
  login: string;
  name: string;
  avatarUrl: string;
}

export interface RepoInfo {
  id: number;
  name: string;
  fullName: string;
  defaultBranch: string;
  htmlUrl: string;
  private: boolean;
}

export interface CommitInfo {
  sha: string;
  message: string;
  authorName: string;
  authorDate: string;
}

export interface RepoActivity {
  defaultBranch: string;
  commits: CommitInfo[];
  prCount: number;
  isLocked: boolean;
  latestSha: string;
  capped: boolean;
}

export interface BranchExistsResult {
  exists: boolean;
  sha?: string;
}

// ── Client interface ─────────────────────────────────────────────────────────

export interface IGitHubApiClient {
  getOrgs(): Promise<OrgInfo[]>;
  getRepos(org: string): Promise<RepoInfo[]>;
  getActivity(org: string, repo: string, since: string): Promise<RepoActivity>;
  branchExists(org: string, repo: string, branch: string): Promise<BranchExistsResult>;
  lockBranch(org: string, repo: string, branch: string): Promise<void>;
  unlockBranch(org: string, repo: string, branch: string): Promise<void>;
  createBranch(org: string, repo: string, branch: string, sha: string): Promise<void>;
}

// ── Real API client (calls Lambda via CloudFront) ────────────────────────────

export class GitHubApiClient implements IGitHubApiClient {
  private async fetch<T>(path: string, options?: RequestInit): Promise<T> {
    const session = await fetchAuthSession();
    const token = session.tokens?.accessToken?.toString() ?? '';
    const res = await window.fetch(path, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(options?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`${res.status}: ${text}`);
    }
    return res.json();
  }

  getOrgs() {
    return this.fetch<OrgInfo[]>('/api/orgs');
  }

  getRepos(org: string) {
    return this.fetch<RepoInfo[]>(`/api/repos?org=${encodeURIComponent(org)}`);
  }

  getActivity(org: string, repo: string, since: string) {
    return this.fetch<RepoActivity>(
      `/api/activity?org=${encodeURIComponent(org)}&repo=${encodeURIComponent(repo)}&since=${encodeURIComponent(since)}`
    );
  }

  branchExists(org: string, repo: string, branch: string) {
    return this.fetch<BranchExistsResult>(
      `/api/branch/exists?org=${encodeURIComponent(org)}&repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}`
    );
  }

  lockBranch(org: string, repo: string, branch: string) {
    return this.fetch<void>('/api/branch/lock', {
      method: 'POST',
      body: JSON.stringify({ org, repo, branch }),
    });
  }

  unlockBranch(org: string, repo: string, branch: string) {
    return this.fetch<void>('/api/branch/unlock', {
      method: 'POST',
      body: JSON.stringify({ org, repo, branch }),
    });
  }

  createBranch(org: string, repo: string, branch: string, sha: string) {
    return this.fetch<void>('/api/branch/create', {
      method: 'POST',
      body: JSON.stringify({ org, repo, branch, sha }),
    });
  }
}

// ── Mock client (local development without AWS) ──────────────────────────────

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

const MOCK_ORGS: OrgInfo[] = [
  { login: 'my-org', name: 'My Organization', avatarUrl: '' },
  { login: 'another-org', name: 'Another Org', avatarUrl: '' },
];

const MOCK_REPOS: Record<string, RepoInfo[]> = {
  'my-org': [
    { id: 1, name: 'api-service', fullName: 'my-org/api-service', defaultBranch: 'main', htmlUrl: 'https://github.com/my-org/api-service', private: false },
    { id: 2, name: 'web-frontend', fullName: 'my-org/web-frontend', defaultBranch: 'main', htmlUrl: 'https://github.com/my-org/web-frontend', private: false },
    { id: 3, name: 'data-pipeline', fullName: 'my-org/data-pipeline', defaultBranch: 'develop', htmlUrl: 'https://github.com/my-org/data-pipeline', private: true },
    { id: 4, name: 'infra-configs', fullName: 'my-org/infra-configs', defaultBranch: 'main', htmlUrl: 'https://github.com/my-org/infra-configs', private: true },
    { id: 5, name: 'legacy-app', fullName: 'my-org/legacy-app', defaultBranch: 'master', htmlUrl: 'https://github.com/my-org/legacy-app', private: false },
  ],
  'another-org': [
    { id: 6, name: 'shared-lib', fullName: 'another-org/shared-lib', defaultBranch: 'main', htmlUrl: 'https://github.com/another-org/shared-lib', private: false },
    { id: 7, name: 'cli-tools', fullName: 'another-org/cli-tools', defaultBranch: 'main', htmlUrl: 'https://github.com/another-org/cli-tools', private: false },
    { id: 8, name: 'docs-site', fullName: 'another-org/docs-site', defaultBranch: 'gh-pages', htmlUrl: 'https://github.com/another-org/docs-site', private: false },
    { id: 9, name: 'archived-service', fullName: 'another-org/archived-service', defaultBranch: 'main', htmlUrl: 'https://github.com/another-org/archived-service', private: false },
  ],
};

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

const MOCK_ACTIVITY: Record<string, RepoActivity> = {
  'my-org/api-service': {
    defaultBranch: 'main', latestSha: 'abc123', capped: false, prCount: 3, isLocked: false,
    commits: [
      { sha: 'abc123', message: 'feat: add rate limiting middleware\n\nPrevents abuse of the public endpoints.', authorName: 'Alice Johnson', authorDate: daysAgo(1) },
      { sha: 'def456', message: 'fix: correct auth token expiry handling', authorName: 'Bob Smith', authorDate: daysAgo(3) },
      { sha: 'ghi789', message: 'chore: update dependencies', authorName: 'Alice Johnson', authorDate: daysAgo(5) },
    ],
  },
  'my-org/web-frontend': {
    defaultBranch: 'main', latestSha: 'bbb222', capped: false, prCount: 1, isLocked: false,
    commits: [
      { sha: 'bbb222', message: 'feat: dark mode toggle in settings page', authorName: 'Carol Davis', authorDate: daysAgo(2) },
      { sha: 'ccc333', message: 'fix: mobile nav z-index issue', authorName: 'Carol Davis', authorDate: daysAgo(6) },
    ],
  },
  'my-org/data-pipeline': {
    defaultBranch: 'develop', latestSha: 'ddd444', capped: false, prCount: 0, isLocked: true,
    commits: [
      { sha: 'ddd444', message: 'refactor: migrate ETL jobs to Spark 3.5', authorName: 'Dave Wilson', authorDate: daysAgo(4) },
    ],
  },
  'my-org/infra-configs': {
    defaultBranch: 'main', latestSha: 'eee555', capped: false, prCount: 2, isLocked: false,
    commits: [
      { sha: 'eee555', message: 'feat: add CloudFront WAF rules', authorName: 'Alice Johnson', authorDate: daysAgo(1) },
      { sha: 'fff666', message: 'fix: Lambda memory settings for prod', authorName: 'Bob Smith', authorDate: daysAgo(7) },
    ],
  },
  // legacy-app and archived-service have no recent commits → filtered out
  'my-org/legacy-app': {
    defaultBranch: 'master', latestSha: '', capped: false, prCount: 0, isLocked: false,
    commits: [],
  },
  'another-org/shared-lib': {
    defaultBranch: 'main', latestSha: 'ggg777', capped: false, prCount: 0, isLocked: true,
    commits: [
      { sha: 'ggg777', message: 'release: v2.4.1', authorName: 'Eve Martinez', authorDate: daysAgo(2) },
      { sha: 'hhh888', message: 'fix: null pointer in deserializer', authorName: 'Frank Lee', authorDate: daysAgo(5) },
    ],
  },
  'another-org/cli-tools': {
    defaultBranch: 'main', latestSha: 'iii999', capped: false, prCount: 1, isLocked: false,
    commits: [
      { sha: 'iii999', message: 'feat: add --dry-run flag to deploy command', authorName: 'Frank Lee', authorDate: daysAgo(3) },
    ],
  },
  'another-org/docs-site': {
    defaultBranch: 'gh-pages', latestSha: 'jjjaaa', capped: false, prCount: 0, isLocked: false,
    commits: [
      { sha: 'jjjaaa', message: 'docs: update API reference for v3', authorName: 'Grace Kim', authorDate: daysAgo(1) },
    ],
  },
  'another-org/archived-service': {
    defaultBranch: 'main', latestSha: '', capped: false, prCount: 0, isLocked: false,
    commits: [],
  },
};

export class MockGitHubApiClient implements IGitHubApiClient {
  async getOrgs(): Promise<OrgInfo[]> {
    await delay(200);
    return [...MOCK_ORGS];
  }

  async getRepos(org: string): Promise<RepoInfo[]> {
    await delay(150);
    return [...(MOCK_REPOS[org] ?? [])];
  }

  async getActivity(org: string, repo: string, _since: string): Promise<RepoActivity> {
    await delay(100 + Math.random() * 400);
    const key = `${org}/${repo}`;
    const activity = MOCK_ACTIVITY[key];
    if (!activity) throw new Error(`No mock data for ${key}`);
    return { ...activity, commits: [...activity.commits] };
  }

  async branchExists(org: string, repo: string, _branch: string): Promise<BranchExistsResult> {
    await delay(100);
    // Mock: "release/v2.0" exists in api-service
    if (org === 'my-org' && repo === 'api-service') {
      return { exists: true, sha: 'abc123' };
    }
    return { exists: false };
  }

  async lockBranch(_org: string, _repo: string, _branch: string): Promise<void> {
    await delay(300);
  }

  async unlockBranch(_org: string, _repo: string, _branch: string): Promise<void> {
    await delay(300);
  }

  async createBranch(_org: string, _repo: string, _branch: string, _sha: string): Promise<void> {
    await delay(400);
  }
}
