import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getOctokit, listInstalledOrgs } from './github-client';

const MAX_COMMITS = 500;

// ── Response helpers ──────────────────────────────────────────────────────────

function ok(body: unknown): APIGatewayProxyResultV2 {
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function err(status: number, message: string): APIGatewayProxyResultV2 {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: message }) };
}

// ── Branch protection helpers ─────────────────────────────────────────────────

async function setBranchLock(octokit: any, org: string, repo: string, branch: string, locked: boolean) {
  let existing: any = null;
  try {
    const { data } = await octokit.rest.repos.getBranchProtection({ owner: org, repo, branch });
    existing = data;
  } catch {
    // No existing protection rules — start from scratch
  }

  await octokit.rest.repos.updateBranchProtection({
    owner: org,
    repo,
    branch,
    // Preserve any existing rules; default to permissive if none exist
    required_status_checks: existing?.required_status_checks
      ? { strict: existing.required_status_checks.strict, contexts: existing.required_status_checks.contexts }
      : null,
    enforce_admins: existing?.enforce_admins?.enabled ?? false,
    required_pull_request_reviews: existing?.required_pull_request_reviews
      ? {
          dismiss_stale_reviews: existing.required_pull_request_reviews.dismiss_stale_reviews,
          require_code_owner_reviews: existing.required_pull_request_reviews.require_code_owner_reviews,
          required_approving_review_count: existing.required_pull_request_reviews.required_approving_review_count,
          ...(existing.required_pull_request_reviews.dismissal_restrictions
            ? {
                dismissal_restrictions: {
                  users: existing.required_pull_request_reviews.dismissal_restrictions.users?.map((u: any) => u.login) ?? [],
                  teams: existing.required_pull_request_reviews.dismissal_restrictions.teams?.map((t: any) => t.slug) ?? [],
                },
              }
            : {}),
        }
      : null,
    restrictions: existing?.restrictions
      ? {
          users: existing.restrictions.users?.map((u: any) => u.login) ?? [],
          teams: existing.restrictions.teams?.map((t: any) => t.slug) ?? [],
          apps: existing.restrictions.apps?.map((a: any) => a.slug) ?? [],
        }
      : null,
    lock_branch: locked,
  });
}

// ── Handler ───────────────────────────────────────────────────────────────────

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const path = event.rawPath;
  const q = event.queryStringParameters ?? {};
  const body = event.body ? JSON.parse(event.body) : {};

  try {
    // GET /api/orgs — list GitHub App installations
    if (method === 'GET' && path === '/api/orgs') {
      return ok(await listInstalledOrgs());
    }

    // GET /api/repos?org= — list repos in an org
    if (method === 'GET' && path === '/api/repos') {
      if (!q.org) return err(400, 'org is required');
      const octokit = await getOctokit(q.org);
      const repos = await octokit.paginate(octokit.rest.apps.listReposAccessibleToInstallation, { per_page: 100 });
      return ok(repos.map(r => ({
        id: r.id,
        name: r.name,
        fullName: r.full_name,
        defaultBranch: r.default_branch,
        htmlUrl: r.html_url,
        private: r.private,
      })));
    }

    // GET /api/activity?org=&repo=&since= — commits, PRs, lock status
    if (method === 'GET' && path === '/api/activity') {
      const { org, repo, since } = q;
      if (!org || !repo || !since) return err(400, 'org, repo, since are required');

      const octokit = await getOctokit(org);

      const { data: repoData } = await octokit.rest.repos.get({ owner: org, repo });
      const defaultBranch = repoData.default_branch;

      // Paginate commits up to MAX_COMMITS
      const commits: any[] = [];
      let page = 1;
      while (commits.length < MAX_COMMITS) {
        const { data: chunk } = await octokit.rest.repos.listCommits({
          owner: org,
          repo,
          sha: defaultBranch,
          since,
          per_page: 100,
          page,
        });
        commits.push(...chunk);
        if (chunk.length < 100 || commits.length >= MAX_COMMITS) break;
        page++;
      }

      const mappedCommits = commits.slice(0, MAX_COMMITS).map(c => ({
        sha: c.sha,
        message: c.commit.message,
        authorName: c.commit.author?.name ?? c.author?.login ?? '',
        authorDate: c.commit.author?.date ?? '',
      }));

      // Open PRs targeting the default branch
      const { data: prs } = await octokit.rest.pulls.list({
        owner: org,
        repo,
        state: 'open',
        base: defaultBranch,
        per_page: 100,
      });

      // Branch lock status from branch protection
      let isLocked = false;
      try {
        const { data: protection } = await octokit.rest.repos.getBranchProtection({
          owner: org,
          repo,
          branch: defaultBranch,
        });
        isLocked = (protection as any).lock_branch?.enabled === true;
      } catch {
        // Branch has no protection or app lacks admin read permission
      }

      return ok({
        defaultBranch,
        commits: mappedCommits,
        prCount: prs.length,
        isLocked,
        latestSha: commits[0]?.sha ?? '',
        capped: commits.length >= MAX_COMMITS,
      });
    }

    // GET /api/branch/exists?org=&repo=&branch= — check if a branch exists
    if (method === 'GET' && path === '/api/branch/exists') {
      const { org, repo, branch } = q;
      if (!org || !repo || !branch) return err(400, 'org, repo, branch are required');
      const octokit = await getOctokit(org);
      try {
        const { data } = await octokit.rest.repos.getBranch({ owner: org, repo, branch });
        return ok({ exists: true, sha: data.commit.sha });
      } catch (e: any) {
        if (e.status === 404) return ok({ exists: false });
        throw e;
      }
    }

    // POST /api/branch/lock
    if (method === 'POST' && path === '/api/branch/lock') {
      const { org, repo, branch } = body;
      if (!org || !repo || !branch) return err(400, 'org, repo, branch are required');
      const octokit = await getOctokit(org);
      await setBranchLock(octokit, org, repo, branch, true);
      return ok({ ok: true });
    }

    // POST /api/branch/unlock
    if (method === 'POST' && path === '/api/branch/unlock') {
      const { org, repo, branch } = body;
      if (!org || !repo || !branch) return err(400, 'org, repo, branch are required');
      const octokit = await getOctokit(org);
      await setBranchLock(octokit, org, repo, branch, false);
      return ok({ ok: true });
    }

    // POST /api/branch/create
    if (method === 'POST' && path === '/api/branch/create') {
      const { org, repo, branch, sha } = body;
      if (!org || !repo || !branch || !sha) return err(400, 'org, repo, branch, sha are required');
      const octokit = await getOctokit(org);
      await octokit.rest.git.createRef({
        owner: org,
        repo,
        ref: `refs/heads/${branch}`,
        sha,
      });
      return ok({ ok: true });
    }

    return err(404, 'Not Found');
  } catch (e: any) {
    console.error('[handler]', e);
    // Never return 403 or 404 — CloudFront converts those to the SPA index page.
    // Map upstream 403/404 to 400 so the real error reaches the browser.
    const status = (e.status === 403 || e.status === 404) ? 400 : (e.status ?? 500);
    return err(status, e.message ?? 'Internal Server Error');
  }
};
