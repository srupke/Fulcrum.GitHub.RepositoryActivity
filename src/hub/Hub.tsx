import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { GitHubApiClient, MockGitHubApiClient } from '../api/github-api';
import type { IGitHubApiClient, OrgInfo, RepoInfo, CommitInfo } from '../api/github-api';

// ── Types ────────────────────────────────────────────────────────────────────

interface RepoActivityRow {
  id: string;
  orgName: string;
  repoName: string;
  repoHtmlUrl: string;
  defaultBranch: string;
  commits: CommitInfo[];
  prCount: number;
  isLocked: boolean;
  latestSha: string;
  capped: boolean;
  error?: string;
}

interface RepoSelection {
  repoName: string;
  selected: boolean;
}

interface OrgConfig {
  orgName: string;
  enabled: boolean;
  scanAllRepos: boolean;
  repos: RepoSelection[];
}

type ActionStatus = 'working' | 'success' | 'failed' | 'exists';

type SortKey = 'repo' | 'org' | 'branch' | 'commits' | 'prs' | 'lastCommitDate' | 'lastAuthor';
type SortDir = 'asc' | 'desc';

const CONFIG_KEY = 'repo-activity-config';
const BRANCH_NAME_RE = /^[a-zA-Z0-9._/\-]+$/;

// ── Helpers ──────────────────────────────────────────────────────────────────

function defaultSince(): string {
  const d = new Date();
  d.setDate(d.getDate() - 14);
  return d.toISOString().split('T')[0];
}

function formatDate(iso: string | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

function firstLine(msg: string): string {
  return msg.split('\n')[0];
}

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return <span className="text-gray-300 ml-1">↕</span>;
  return <span className="text-brand-600 ml-1">{dir === 'asc' ? '↑' : '↓'}</span>;
}

function Spinner({ size = 4 }: { size?: number }) {
  return (
    <svg className={`animate-spin h-${size} w-${size} text-brand-600`} fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function BranchBadge({ branch }: { branch: string }) {
  const colors: Record<string, string> = {
    main: 'bg-green-100 text-green-800',
    master: 'bg-yellow-100 text-yellow-800',
    develop: 'bg-blue-100 text-blue-800',
  };
  const cls = colors[branch] ?? 'bg-gray-100 text-gray-700';
  return <span className={`inline-block px-2 py-0.5 rounded text-xs font-mono font-medium ${cls}`}>{branch}</span>;
}

function StatusCell({ id, lockStatuses, unlockStatuses, branchStatuses, isLocked }:
  { id: string; lockStatuses: Record<string, ActionStatus>; unlockStatuses: Record<string, ActionStatus>; branchStatuses: Record<string, ActionStatus>; isLocked: boolean }) {
  if (branchStatuses[id]) {
    const s = branchStatuses[id];
    if (s === 'working') return <Spinner size={4} />;
    if (s === 'success') return <span className="text-green-600 text-lg" title="Branch created">✔</span>;
    if (s === 'exists') return <span className="text-gray-400 text-lg" title="Branch already exists">⊘</span>;
    if (s === 'failed') return <span className="text-red-500 text-lg" title="Failed">⚠</span>;
  }
  if (lockStatuses[id]) {
    const s = lockStatuses[id];
    if (s === 'working') return <Spinner size={4} />;
    if (s === 'success') return <span className="text-gray-600 text-lg" title="Branch locked">🔒</span>;
    if (s === 'failed') return <span className="text-red-500 text-lg" title="Failed">⚠</span>;
  }
  if (unlockStatuses[id]) {
    const s = unlockStatuses[id];
    if (s === 'working') return <Spinner size={4} />;
    if (s === 'success') return <span className="text-gray-600 text-lg" title="Branch unlocked">🔓</span>;
    if (s === 'failed') return <span className="text-red-500 text-lg" title="Failed">⚠</span>;
  }
  if (isLocked) return <span className="text-gray-500 text-lg" title="Branch locked">🔒</span>;
  return null;
}

// ── Main component ────────────────────────────────────────────────────────────

interface HubProps {
  isMock: boolean;
  userEmail: string;
  onSignOut: () => void;
}

export default function ActivityHub({ isMock, userEmail, onSignOut }: HubProps) {
  const api = useMemo<IGitHubApiClient>(
    () => (isMock ? new MockGitHubApiClient() : new GitHubApiClient()),
    [isMock]
  );

  // Scan state
  const [org, setOrg] = useState('');
  const [sinceDate, setSinceDate] = useState(defaultSince);
  const [loading, setLoading] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [repoActivity, setRepoActivity] = useState<RepoActivityRow[]>([]);
  const [totalRepos, setTotalRepos] = useState(0);
  const [scannedCount, setScannedCount] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');

  // Selection & action state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lockStatuses, setLockStatuses] = useState<Record<string, ActionStatus>>({});
  const [unlockStatuses, setUnlockStatuses] = useState<Record<string, ActionStatus>>({});
  const [branchStatuses, setBranchStatuses] = useState<Record<string, ActionStatus>>({});
  const [actionsOpen, setActionsOpen] = useState(false);
  const actionsRef = useRef<HTMLDivElement>(null);

  // Branch modal state
  const [branchModalOpen, setBranchModalOpen] = useState(false);
  const [branchName, setBranchName] = useState('');
  const [branchConflicts, setBranchConflicts] = useState<string[]>([]);
  const [branchPhase, setBranchPhase] = useState<'input' | 'checking' | 'confirming' | 'creating'>('input');

  // Sort state
  const [sortKey, setSortKey] = useState<SortKey>('lastCommitDate');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // Config modal state
  const [configModalOpen, setConfigModalOpen] = useState(false);
  const [savedOrgs, setSavedOrgs] = useState<OrgConfig[]>([]);
  const [configOrgs, setConfigOrgs] = useState<OrgConfig[]>([]);
  const [availableOrgs, setAvailableOrgs] = useState<OrgInfo[]>([]);
  const [repoLoadStatus, setRepoLoadStatus] = useState<Record<string, 'loading' | 'done' | 'error'>>({});
  const [expandedOrgs, setExpandedOrgs] = useState<Set<string>>(new Set());
  const [orgRepos, setOrgRepos] = useState<Record<string, RepoInfo[]>>({});
  const [repoSearch, setRepoSearch] = useState<Record<string, string>>({});

  // ── Load config from localStorage on mount ─────────────────────────────────

  useEffect(() => {
    try {
      const raw = localStorage.getItem(CONFIG_KEY);
      if (raw) setSavedOrgs(JSON.parse(raw));
    } catch {}
  }, []);

  // ── Click outside actions dropdown ────────────────────────────────────────

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (actionsRef.current && !actionsRef.current.contains(e.target as Node)) {
        setActionsOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // ── Sorted results ────────────────────────────────────────────────────────

  const sortedActivity = useMemo(() => {
    const mult = sortDir === 'asc' ? 1 : -1;
    return [...repoActivity].sort((a, b) => {
      switch (sortKey) {
        case 'repo': return mult * a.repoName.localeCompare(b.repoName);
        case 'org': return mult * a.orgName.localeCompare(b.orgName);
        case 'branch': return mult * a.defaultBranch.localeCompare(b.defaultBranch);
        case 'commits': return mult * (a.commits.length - b.commits.length);
        case 'prs': return mult * (a.prCount - b.prCount);
        case 'lastCommitDate': {
          const ta = a.commits[0]?.authorDate ? new Date(a.commits[0].authorDate).getTime() : 0;
          const tb = b.commits[0]?.authorDate ? new Date(b.commits[0].authorDate).getTime() : 0;
          return mult * (ta - tb);
        }
        case 'lastAuthor': return mult * (a.commits[0]?.authorName ?? '').localeCompare(b.commits[0]?.authorName ?? '');
        default: return 0;
      }
    });
  }, [repoActivity, sortKey, sortDir]);

  const isMultiOrg = useMemo(() => {
    const orgs = new Set(repoActivity.map(r => r.orgName));
    return orgs.size > 1;
  }, [repoActivity]);

  // ── Sort handler ──────────────────────────────────────────────────────────

  const handleSort = useCallback((key: SortKey) => {
    setSortKey(prev => {
      if (prev === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
      else setSortDir('desc');
      return key;
    });
  }, []);

  // ── Selection handlers ────────────────────────────────────────────────────

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    setSelectedIds(prev =>
      prev.size === sortedActivity.length
        ? new Set()
        : new Set(sortedActivity.map(r => r.id))
    );
  }, [sortedActivity]);

  // ── Scan ─────────────────────────────────────────────────────────────────

  const scan = useCallback(async () => {
    setLoading(true);
    setScanned(false);
    setRepoActivity([]);
    setSelectedIds(new Set());
    setLockStatuses({});
    setUnlockStatuses({});
    setBranchStatuses({});
    setErrorMsg('');

    try {
      // Determine which orgs + repos to scan
      const orgsToScan: Array<{ orgName: string; repoFilter?: string[] }> = [];

      if (savedOrgs.length > 0) {
        for (const cfg of savedOrgs.filter(o => o.enabled)) {
          if (cfg.scanAllRepos) {
            orgsToScan.push({ orgName: cfg.orgName });
          } else {
            const selected = cfg.repos.filter(r => r.selected).map(r => r.repoName);
            if (selected.length > 0) orgsToScan.push({ orgName: cfg.orgName, repoFilter: selected });
          }
        }
      } else if (org.trim()) {
        orgsToScan.push({ orgName: org.trim() });
      }

      if (orgsToScan.length === 0) {
        setErrorMsg('Enter an organization name or configure organizations to scan.');
        return;
      }

      // Gather all repos
      const allRepos: Array<{ orgName: string; repoName: string }> = [];
      for (const { orgName, repoFilter } of orgsToScan) {
        const repos = await api.getRepos(orgName);
        const filtered = repoFilter ? repos.filter(r => repoFilter.includes(r.name)) : repos;
        for (const r of filtered) allRepos.push({ orgName, repoName: r.name });
      }

      setTotalRepos(allRepos.length);
      setScannedCount(0);

      const results: RepoActivityRow[] = [];

      for (const { orgName, repoName } of allRepos) {
        try {
          const activity = await api.getActivity(orgName, repoName, sinceDate + 'T00:00:00Z');
          if (activity.commits.length > 0) {
            const row: RepoActivityRow = {
              id: `${orgName}/${repoName}`,
              orgName,
              repoName,
              repoHtmlUrl: `https://github.com/${orgName}/${repoName}`,
              defaultBranch: activity.defaultBranch,
              commits: activity.commits,
              prCount: activity.prCount,
              isLocked: activity.isLocked,
              latestSha: activity.latestSha,
              capped: activity.capped,
            };
            results.push(row);
            setRepoActivity([...results]);
          }
        } catch (err) {
          results.push({
            id: `${orgName}/${repoName}`,
            orgName,
            repoName,
            repoHtmlUrl: `https://github.com/${orgName}/${repoName}`,
            defaultBranch: '',
            commits: [],
            prCount: 0,
            isLocked: false,
            latestSha: '',
            capped: false,
            error: String(err),
          });
          setRepoActivity([...results]);
        }
        setScannedCount(c => c + 1);
      }

      setScanned(true);
    } catch (err) {
      setErrorMsg(String(err));
    } finally {
      setLoading(false);
    }
  }, [api, org, sinceDate, savedOrgs]);

  // ── Lock / Unlock ─────────────────────────────────────────────────────────

  const handleLock = useCallback(async () => {
    setActionsOpen(false);
    const ids = selectedIds.size > 0 ? [...selectedIds] : sortedActivity.map(r => r.id);
    const targets = sortedActivity.filter(r => ids.includes(r.id) && r.defaultBranch);

    setLockStatuses(prev => {
      const next = { ...prev };
      targets.forEach(r => { next[r.id] = 'working'; });
      return next;
    });

    await Promise.all(targets.map(async row => {
      try {
        await api.lockBranch(row.orgName, row.repoName, row.defaultBranch);
        setLockStatuses(prev => ({ ...prev, [row.id]: 'success' }));
        setRepoActivity(prev => prev.map(r => r.id === row.id ? { ...r, isLocked: true } : r));
      } catch {
        setLockStatuses(prev => ({ ...prev, [row.id]: 'failed' }));
      }
    }));
  }, [api, selectedIds, sortedActivity]);

  const handleUnlock = useCallback(async () => {
    setActionsOpen(false);
    const ids = selectedIds.size > 0 ? [...selectedIds] : sortedActivity.map(r => r.id);
    const targets = sortedActivity.filter(r => ids.includes(r.id) && r.defaultBranch);

    setUnlockStatuses(prev => {
      const next = { ...prev };
      targets.forEach(r => { next[r.id] = 'working'; });
      return next;
    });

    await Promise.all(targets.map(async row => {
      try {
        await api.unlockBranch(row.orgName, row.repoName, row.defaultBranch);
        setUnlockStatuses(prev => ({ ...prev, [row.id]: 'success' }));
        setRepoActivity(prev => prev.map(r => r.id === row.id ? { ...r, isLocked: false } : r));
      } catch {
        setUnlockStatuses(prev => ({ ...prev, [row.id]: 'failed' }));
      }
    }));
  }, [api, selectedIds, sortedActivity]);

  // ── Create Branch ─────────────────────────────────────────────────────────

  const openBranchModal = useCallback(() => {
    setActionsOpen(false);
    setBranchName('');
    setBranchConflicts([]);
    setBranchPhase('input');
    setBranchModalOpen(true);
  }, []);

  const handleBranchCheck = useCallback(async () => {
    if (!BRANCH_NAME_RE.test(branchName)) return;
    setBranchPhase('checking');

    const ids = selectedIds.size > 0 ? [...selectedIds] : sortedActivity.map(r => r.id);
    const targets = sortedActivity.filter(r => ids.includes(r.id) && r.latestSha);

    setBranchStatuses(prev => {
      const next = { ...prev };
      targets.forEach(r => { next[r.id] = 'working'; });
      return next;
    });

    const conflicts: string[] = [];
    await Promise.all(targets.map(async row => {
      const result = await api.branchExists(row.orgName, row.repoName, branchName);
      if (result.exists) conflicts.push(row.id);
      setBranchStatuses(prev => ({ ...prev, [row.id]: result.exists ? 'exists' : undefined as any }));
    }));

    setBranchConflicts(conflicts);
    if (conflicts.length === 0) {
      await executeBranchCreate(targets);
    } else {
      setBranchPhase('confirming');
    }
  }, [api, branchName, selectedIds, sortedActivity]);

  const executeBranchCreate = useCallback(async (
    targets: RepoActivityRow[]
  ) => {
    setBranchPhase('creating');
    const toCreate = targets.filter(r => !branchConflicts.includes(r.id));

    setBranchStatuses(prev => {
      const next = { ...prev };
      toCreate.forEach(r => { next[r.id] = 'working'; });
      return next;
    });

    await Promise.all(toCreate.map(async row => {
      try {
        await api.createBranch(row.orgName, row.repoName, branchName, row.latestSha);
        setBranchStatuses(prev => ({ ...prev, [row.id]: 'success' }));
      } catch {
        setBranchStatuses(prev => ({ ...prev, [row.id]: 'failed' }));
      }
    }));

    setBranchModalOpen(false);
  }, [api, branchName, branchConflicts]);

  const handleBranchConfirm = useCallback(async () => {
    const ids = selectedIds.size > 0 ? [...selectedIds] : sortedActivity.map(r => r.id);
    const targets = sortedActivity.filter(r => ids.includes(r.id) && r.latestSha);
    await executeBranchCreate(targets);
  }, [executeBranchCreate, selectedIds, sortedActivity]);

  // ── Export CSV ────────────────────────────────────────────────────────────

  const handleExport = useCallback(() => {
    setActionsOpen(false);
    const rows = selectedIds.size > 0
      ? sortedActivity.filter(r => selectedIds.has(r.id))
      : sortedActivity;

    const headers = ['Repository', 'Org', 'Default Branch', 'URL', 'Commits', 'Last Commit Date', 'Last Author', 'Last Commit Message'];
    const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;

    const csvRows = rows.map(r => {
      const last = r.commits[0];
      return [
        r.repoName,
        r.orgName,
        r.defaultBranch,
        r.repoHtmlUrl,
        r.capped ? '500+' : String(r.commits.length),
        last?.authorDate ?? '',
        last?.authorName ?? '',
        firstLine(last?.message ?? ''),
      ].map(esc).join(',');
    });

    const csv = [headers.join(','), ...csvRows].join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `repo-activity-${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [sortedActivity, selectedIds]);

  // ── Config modal ──────────────────────────────────────────────────────────

  const openConfig = useCallback(async () => {
    const merged: OrgConfig[] = [...savedOrgs];
    setConfigOrgs(JSON.parse(JSON.stringify(merged)));
    setConfigModalOpen(true);

    try {
      const orgs = await api.getOrgs();
      setAvailableOrgs(orgs);
      // Add any orgs from the App installation not yet in config
      setConfigOrgs(prev => {
        const existing = new Set(prev.map(o => o.orgName));
        const added: OrgConfig[] = orgs
          .filter(o => !existing.has(o.login))
          .map(o => ({ orgName: o.login, enabled: false, scanAllRepos: true, repos: [] }));
        return [...prev, ...added];
      });
    } catch {}
  }, [api, savedOrgs]);

  const saveConfig = useCallback(() => {
    setSavedOrgs(configOrgs);
    localStorage.setItem(CONFIG_KEY, JSON.stringify(configOrgs));
    setConfigModalOpen(false);
  }, [configOrgs]);

  const toggleOrgEnabled = useCallback((orgName: string) => {
    setConfigOrgs(prev => prev.map(o => o.orgName === orgName ? { ...o, enabled: !o.enabled } : o));
  }, []);

  const toggleOrgScanAll = useCallback((orgName: string) => {
    setConfigOrgs(prev => prev.map(o => o.orgName === orgName ? { ...o, scanAllRepos: !o.scanAllRepos } : o));
  }, []);

  const toggleOrgExpanded = useCallback(async (orgName: string) => {
    setExpandedOrgs(prev => {
      const next = new Set(prev);
      next.has(orgName) ? next.delete(orgName) : next.add(orgName);
      return next;
    });

    if (!orgRepos[orgName]) {
      setRepoLoadStatus(prev => ({ ...prev, [orgName]: 'loading' }));
      try {
        const repos = await api.getRepos(orgName);
        setOrgRepos(prev => ({ ...prev, [orgName]: repos }));
        setConfigOrgs(prev => prev.map(o => {
          if (o.orgName !== orgName) return o;
          const existingNames = new Set(o.repos.map(r => r.repoName));
          const newRepos = repos.filter(r => !existingNames.has(r.name)).map(r => ({ repoName: r.name, selected: false }));
          return { ...o, repos: [...o.repos, ...newRepos] };
        }));
        setRepoLoadStatus(prev => ({ ...prev, [orgName]: 'done' }));
      } catch {
        setRepoLoadStatus(prev => ({ ...prev, [orgName]: 'error' }));
      }
    }
  }, [api, orgRepos]);

  const toggleRepoSelected = useCallback((orgName: string, repoName: string) => {
    setConfigOrgs(prev => prev.map(o => {
      if (o.orgName !== orgName) return o;
      return { ...o, repos: o.repos.map(r => r.repoName === repoName ? { ...r, selected: !r.selected } : r) };
    }));
  }, []);

  // ── Derived values ────────────────────────────────────────────────────────

  const enabledOrgs = savedOrgs.filter(o => o.enabled);
  const configuredOrgNames = enabledOrgs.map(o => o.orgName).join(', ');
  const selectedCount = selectedIds.size;
  const activeTargetCount = selectedCount > 0 ? selectedCount : sortedActivity.length;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <svg className="h-6 w-6 text-brand-600" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
          </svg>
          <h1 className="text-lg font-semibold text-gray-900">Repository Activity</h1>
          {isMock && (
            <span className="text-xs bg-yellow-100 text-yellow-800 px-2 py-0.5 rounded font-medium">MOCK</span>
          )}
        </div>
        <div className="flex items-center gap-4 text-sm text-gray-500">
          <span>{userEmail}</span>
          <button
            onClick={onSignOut}
            className="text-gray-500 hover:text-gray-700 underline text-xs"
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="px-6 py-5 max-w-screen-2xl mx-auto">
        {/* Settings card */}
        <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4">
          <div className="flex flex-wrap items-end gap-4">
            {enabledOrgs.length > 0 ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-500">Scope:</span>
                <span className="bg-brand-50 text-brand-700 border border-brand-100 rounded-full px-3 py-1 text-sm font-medium">
                  {configuredOrgNames}
                </span>
              </div>
            ) : (
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-gray-600">Organization</label>
                <input
                  type="text"
                  value={org}
                  onChange={e => setOrg(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && !loading && scan()}
                  placeholder="e.g. my-org"
                  className="border border-gray-300 rounded px-3 py-1.5 text-sm w-56 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
                />
              </div>
            )}

            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-gray-600">Commits since</label>
              <input
                type="date"
                value={sinceDate}
                onChange={e => setSinceDate(e.target.value)}
                className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>

            <button
              onClick={scan}
              disabled={loading}
              className="flex items-center gap-2 bg-brand-600 hover:bg-brand-700 disabled:bg-brand-300 text-white text-sm font-medium px-4 py-1.5 rounded transition-colors"
            >
              {loading && <Spinner size={4} />}
              {loading ? `Scanning… ${scannedCount} / ${totalRepos}` : 'Scan Repositories'}
            </button>

            <button
              onClick={openConfig}
              className="flex items-center gap-2 border border-gray-300 hover:bg-gray-50 text-gray-700 text-sm font-medium px-4 py-1.5 rounded transition-colors"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              Configure
            </button>
          </div>
        </div>

        {/* Error banner */}
        {errorMsg && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 mb-4 flex items-start gap-2 text-sm">
            <span className="text-red-500 shrink-0 mt-0.5">⚠</span>
            <span>{errorMsg}</span>
            <button onClick={() => setErrorMsg('')} className="ml-auto text-red-400 hover:text-red-600">✕</button>
          </div>
        )}

        {/* Results */}
        {(scanned || (loading && repoActivity.length > 0)) && (
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            {/* Toolbar */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100 bg-gray-50">
              <span className="text-sm text-gray-600">
                {loading
                  ? `Scanning… ${scannedCount} / ${totalRepos} — ${repoActivity.length} with activity`
                  : `${sortedActivity.length} repositor${sortedActivity.length === 1 ? 'y' : 'ies'} with activity since ${sinceDate}`}
              </span>

              <div className="flex items-center gap-2">
                {selectedCount > 0 && (
                  <span className="text-xs text-gray-500">{selectedCount} selected</span>
                )}

                <button
                  onClick={handleSelectAll}
                  className="text-xs text-brand-600 hover:text-brand-800 font-medium"
                >
                  {selectedCount === sortedActivity.length ? 'Deselect all' : 'Select all'}
                </button>

                {/* Actions dropdown */}
                <div className="relative" ref={actionsRef}>
                  <button
                    onClick={() => setActionsOpen(o => !o)}
                    className="flex items-center gap-1 border border-gray-300 hover:bg-gray-50 text-gray-700 text-sm font-medium px-3 py-1.5 rounded transition-colors"
                  >
                    Actions
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  {actionsOpen && (
                    <div className="absolute right-0 mt-1 w-44 bg-white rounded-lg border border-gray-200 shadow-lg z-20 py-1">
                      <button
                        onClick={handleLock}
                        className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50 flex items-center gap-2"
                      >
                        🔒 Lock branch ({activeTargetCount})
                      </button>
                      <button
                        onClick={handleUnlock}
                        className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50 flex items-center gap-2"
                      >
                        🔓 Unlock branch ({activeTargetCount})
                      </button>
                      <div className="border-t border-gray-100 my-1" />
                      <button
                        onClick={openBranchModal}
                        className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50 flex items-center gap-2"
                      >
                        ⎇ Create branch ({activeTargetCount})
                      </button>
                      <div className="border-t border-gray-100 my-1" />
                      <button
                        onClick={handleExport}
                        className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50 flex items-center gap-2"
                      >
                        ⬇ Export CSV ({activeTargetCount})
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="w-8 px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selectedCount > 0 && selectedCount === sortedActivity.length}
                        onChange={handleSelectAll}
                        className="rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                      />
                    </th>
                    {isMultiOrg && (
                      <th
                        className="px-3 py-2 text-left font-medium text-gray-600 cursor-pointer hover:text-gray-900 whitespace-nowrap"
                        onClick={() => handleSort('org')}
                      >
                        Org <SortIcon active={sortKey === 'org'} dir={sortDir} />
                      </th>
                    )}
                    <th
                      className="px-3 py-2 text-left font-medium text-gray-600 cursor-pointer hover:text-gray-900 whitespace-nowrap"
                      onClick={() => handleSort('repo')}
                    >
                      Repository <SortIcon active={sortKey === 'repo'} dir={sortDir} />
                    </th>
                    <th
                      className="px-3 py-2 text-left font-medium text-gray-600 cursor-pointer hover:text-gray-900 whitespace-nowrap"
                      onClick={() => handleSort('branch')}
                    >
                      Default Branch <SortIcon active={sortKey === 'branch'} dir={sortDir} />
                    </th>
                    <th
                      className="px-3 py-2 text-right font-medium text-gray-600 cursor-pointer hover:text-gray-900 whitespace-nowrap"
                      onClick={() => handleSort('commits')}
                    >
                      Commits <SortIcon active={sortKey === 'commits'} dir={sortDir} />
                    </th>
                    <th
                      className="px-3 py-2 text-right font-medium text-gray-600 cursor-pointer hover:text-gray-900 whitespace-nowrap"
                      onClick={() => handleSort('prs')}
                    >
                      Open PRs <SortIcon active={sortKey === 'prs'} dir={sortDir} />
                    </th>
                    <th
                      className="px-3 py-2 text-left font-medium text-gray-600 cursor-pointer hover:text-gray-900 whitespace-nowrap"
                      onClick={() => handleSort('lastCommitDate')}
                    >
                      Last Commit <SortIcon active={sortKey === 'lastCommitDate'} dir={sortDir} />
                    </th>
                    <th className="px-3 py-2 text-left font-medium text-gray-600">Last Message</th>
                    <th className="px-3 py-2 w-10" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {sortedActivity.map(row => (
                    <tr
                      key={row.id}
                      className={`hover:bg-gray-50 transition-colors ${selectedIds.has(row.id) ? 'bg-brand-50' : ''} ${row.error ? 'opacity-60' : ''}`}
                    >
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(row.id)}
                          onChange={() => toggleSelect(row.id)}
                          className="rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                        />
                      </td>
                      {isMultiOrg && (
                        <td className="px-3 py-2 text-gray-500 text-xs">{row.orgName}</td>
                      )}
                      <td className="px-3 py-2">
                        <a
                          href={`${row.repoHtmlUrl}/tree/${row.defaultBranch}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-brand-600 hover:underline font-medium"
                        >
                          {row.repoName}
                        </a>
                        {row.error && <div className="text-xs text-red-500 mt-0.5">{row.error}</div>}
                      </td>
                      <td className="px-3 py-2">
                        {row.defaultBranch && <BranchBadge branch={row.defaultBranch} />}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {row.error ? '—' : row.capped ? '500+' : row.commits.length}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {row.prCount > 0 ? (
                          <a
                            href={`${row.repoHtmlUrl}/pulls`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-brand-600 hover:underline"
                          >
                            {row.prCount}
                          </a>
                        ) : (
                          <span className="text-gray-400">{row.error ? '—' : '0'}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {row.commits[0] && (
                          <>
                            <div className="text-gray-900">{formatDate(row.commits[0].authorDate)}</div>
                            <div className="text-xs text-gray-400">{row.commits[0].authorName}</div>
                          </>
                        )}
                      </td>
                      <td className="px-3 py-2 max-w-xs">
                        <span className="block truncate text-gray-600" title={firstLine(row.commits[0]?.message ?? '')}>
                          {firstLine(row.commits[0]?.message ?? '')}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-center">
                        <StatusCell
                          id={row.id}
                          lockStatuses={lockStatuses}
                          unlockStatuses={unlockStatuses}
                          branchStatuses={branchStatuses}
                          isLocked={row.isLocked}
                        />
                      </td>
                    </tr>
                  ))}
                  {sortedActivity.length === 0 && !loading && (
                    <tr>
                      <td colSpan={isMultiOrg ? 9 : 8} className="px-4 py-8 text-center text-gray-400 text-sm">
                        No repositories found with commits since {sinceDate}.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* ── Branch Creation Modal ──────────────────────────────────────────── */}
      {branchModalOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md">
            <div className="px-6 py-4 border-b border-gray-200">
              <h2 className="text-base font-semibold text-gray-900">Create Branch</h2>
            </div>
            <div className="px-6 py-4">
              {branchPhase === 'input' && (
                <>
                  <p className="text-sm text-gray-600 mb-3">
                    Create a new branch from the tip of the default branch in{' '}
                    <strong>{activeTargetCount}</strong> repositor{activeTargetCount === 1 ? 'y' : 'ies'}.
                  </p>
                  <label className="text-xs font-medium text-gray-600 block mb-1">Branch name</label>
                  <input
                    autoFocus
                    type="text"
                    value={branchName}
                    onChange={e => setBranchName(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && BRANCH_NAME_RE.test(branchName) && handleBranchCheck()}
                    placeholder="e.g. release/v2.0"
                    className="border border-gray-300 rounded px-3 py-2 text-sm w-full focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                  {branchName && !BRANCH_NAME_RE.test(branchName) && (
                    <p className="text-xs text-red-500 mt-1">
                      Only letters, numbers, dots, hyphens, underscores, and slashes are allowed.
                    </p>
                  )}
                </>
              )}
              {branchPhase === 'checking' && (
                <div className="flex items-center gap-3 text-gray-600 text-sm">
                  <Spinner /> Checking for existing branches…
                </div>
              )}
              {branchPhase === 'confirming' && (
                <>
                  <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2 mb-3">
                    Branch <strong>{branchName}</strong> already exists in {branchConflicts.length} repositor{branchConflicts.length === 1 ? 'y' : 'ies'} (shown with ⊘). Proceed with the remaining {activeTargetCount - branchConflicts.length}?
                  </p>
                  <ul className="text-xs text-gray-500 space-y-0.5 max-h-32 overflow-y-auto">
                    {branchConflicts.map(id => <li key={id} className="text-amber-600">⊘ {id}</li>)}
                  </ul>
                </>
              )}
              {branchPhase === 'creating' && (
                <div className="flex items-center gap-3 text-gray-600 text-sm">
                  <Spinner /> Creating branches…
                </div>
              )}
            </div>
            <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-2">
              <button
                onClick={() => setBranchModalOpen(false)}
                className="border border-gray-300 hover:bg-gray-50 text-gray-700 text-sm font-medium px-4 py-1.5 rounded"
              >
                Cancel
              </button>
              {branchPhase === 'input' && (
                <button
                  onClick={handleBranchCheck}
                  disabled={!BRANCH_NAME_RE.test(branchName)}
                  className="bg-brand-600 hover:bg-brand-700 disabled:bg-brand-300 text-white text-sm font-medium px-4 py-1.5 rounded"
                >
                  Create
                </button>
              )}
              {branchPhase === 'confirming' && (
                <button
                  onClick={handleBranchConfirm}
                  className="bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium px-4 py-1.5 rounded"
                >
                  Proceed ({activeTargetCount - branchConflicts.length})
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Config Modal ──────────────────────────────────────────────────── */}
      {configModalOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col">
            <div className="px-6 py-4 border-b border-gray-200">
              <h2 className="text-base font-semibold text-gray-900">Configure Organizations</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                Enable organizations and choose which repositories to scan.
              </p>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
              {configOrgs.length === 0 && (
                <p className="text-sm text-gray-500">Loading organizations from GitHub App installations…</p>
              )}
              {configOrgs.map(cfg => (
                <div key={cfg.orgName} className="border border-gray-200 rounded-lg overflow-hidden">
                  {/* Org header */}
                  <div className="flex items-center gap-3 px-4 py-2 bg-gray-50">
                    <input
                      type="checkbox"
                      checked={cfg.enabled}
                      onChange={() => toggleOrgEnabled(cfg.orgName)}
                      id={`org-${cfg.orgName}`}
                      className="rounded border-gray-300 text-brand-600"
                    />
                    <label htmlFor={`org-${cfg.orgName}`} className="font-medium text-sm text-gray-900 flex-1 cursor-pointer">
                      {cfg.orgName}
                    </label>
                    {cfg.enabled && (
                      <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={cfg.scanAllRepos}
                          onChange={() => toggleOrgScanAll(cfg.orgName)}
                          className="rounded border-gray-300 text-brand-600"
                        />
                        All repos
                      </label>
                    )}
                    {cfg.enabled && !cfg.scanAllRepos && (
                      <button
                        onClick={() => toggleOrgExpanded(cfg.orgName)}
                        className="text-xs text-brand-600 hover:underline"
                      >
                        {expandedOrgs.has(cfg.orgName) ? 'Collapse' : 'Select repos'}
                      </button>
                    )}
                  </div>

                  {/* Repo list */}
                  {cfg.enabled && !cfg.scanAllRepos && expandedOrgs.has(cfg.orgName) && (
                    <div className="px-4 py-2">
                      {repoLoadStatus[cfg.orgName] === 'loading' && (
                        <div className="flex items-center gap-2 text-sm text-gray-500 py-1">
                          <Spinner size={3} /> Loading repos…
                        </div>
                      )}
                      {repoLoadStatus[cfg.orgName] === 'error' && (
                        <p className="text-xs text-red-500">Failed to load repositories.</p>
                      )}
                      {repoLoadStatus[cfg.orgName] === 'done' && (
                        <>
                          <input
                            type="text"
                            placeholder="Filter repos…"
                            value={repoSearch[cfg.orgName] ?? ''}
                            onChange={e => setRepoSearch(prev => ({ ...prev, [cfg.orgName]: e.target.value }))}
                            className="border border-gray-200 rounded px-2 py-1 text-xs w-full mb-2 focus:outline-none focus:ring-1 focus:ring-brand-500"
                          />
                          <div className="grid grid-cols-2 gap-x-4 gap-y-1 max-h-40 overflow-y-auto">
                            {cfg.repos
                              .filter(r => !repoSearch[cfg.orgName] || r.repoName.toLowerCase().includes(repoSearch[cfg.orgName].toLowerCase()))
                              .map(r => (
                                <label key={r.repoName} className="flex items-center gap-1.5 text-xs cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={r.selected}
                                    onChange={() => toggleRepoSelected(cfg.orgName, r.repoName)}
                                    className="rounded border-gray-300 text-brand-600"
                                  />
                                  <span className="truncate font-mono">{r.repoName}</span>
                                </label>
                              ))}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              ))}

              {/* Add org manually */}
              <div className="pt-2">
                <button
                  onClick={() => {
                    const name = window.prompt('GitHub organization name:');
                    if (name?.trim()) {
                      setConfigOrgs(prev => [
                        ...prev,
                        { orgName: name.trim(), enabled: true, scanAllRepos: true, repos: [] },
                      ]);
                    }
                  }}
                  className="text-xs text-brand-600 hover:underline flex items-center gap-1"
                >
                  + Add organization
                </button>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-2">
              <button
                onClick={() => setConfigModalOpen(false)}
                className="border border-gray-300 hover:bg-gray-50 text-gray-700 text-sm font-medium px-4 py-1.5 rounded"
              >
                Cancel
              </button>
              <button
                onClick={saveConfig}
                className="bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium px-4 py-1.5 rounded"
              >
                Save Configuration
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
