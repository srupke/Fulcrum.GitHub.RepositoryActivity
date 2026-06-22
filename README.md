# Fulcrum GitHub Repository Activity

A web application for scanning GitHub organizations to identify repositories with recent commit activity on their default branch. Provides bulk actions: branch lock/unlock, branch creation, and CSV export.

## Architecture

```
Browser (React SPA)
  │  HTTPS
  ▼
CloudFront
  ├── /           → S3 (static Vite bundle)
  └── /api/*      → API Gateway (JWT-protected) → Lambda → GitHub App → GitHub API
                                    │
                               Cognito JWT
                               validation
```

**Authentication:** AWS Cognito Hosted UI. Supports local email/password accounts (admin-created) and/or company SSO via **SAML 2.0** (Okta, Azure AD, ADFS) or **OIDC** (Azure AD, Okta). Both can be active simultaneously.  
**GitHub access:** A GitHub App with read permissions on repositories. The private key is stored in AWS Secrets Manager. No user-level PATs or OAuth tokens.

## Features

- **Scan** one or multiple GitHub organizations for repositories with commits since a chosen date
- **Configure** multi-org scanning with per-org repo selection, saved in localStorage
- **Sortable table** — repo, org, branch, commit count, open PRs, last commit date/author/message
- **Lock / Unlock** the default branch via GitHub branch protection rules (requires App admin permission)
- **Create Branch** across selected repos with conflict detection
- **Export CSV** of selected or all results

## Getting Started

### Local development with mock data

No AWS account required — uses built-in mock data.

```powershell
npm install
npm run dev:mock
# Opens http://localhost:3000
```

### Local development against real AWS

1. Deploy the stack first (see [Deployment](#deployment) below).
2. Copy `.env.local.example` to `.env.local` and fill in the stack outputs.
3. `npm run dev` — proxies `/api/*` to the deployed API Gateway.

## Deployment

### Prerequisites

- AWS CLI configured
- AWS SAM CLI (`winget install Amazon.SAM-CLI`)
- Node.js 20+
- A GitHub App (see [infra/github-app-setup.md](infra/github-app-setup.md))

### First deploy

```powershell
cd infra
.\deploy.ps1 -GitHubAppId 12345
```

With a custom domain (ACM certificate must be in **us-east-1** regardless of deploy region):

```powershell
.\deploy.ps1 `
  -GitHubAppId 12345 `
  -CustomDomain repo-activity.example.com `
  -HostedZoneId Z1234EXAMPLE `
  -AcmCertificateArn arn:aws:acm:us-east-1:123456789012:certificate/...
```

After deploy, update the GitHub App private key in Secrets Manager — see [infra/github-app-setup.md](infra/github-app-setup.md).

### With company SSO (optional)

SAML and OIDC providers are opt-in — omit these parameters and only local accounts are used.

```powershell
# SAML (Okta, Azure AD enterprise app, ADFS, Ping…)
.\deploy.ps1 -GitHubAppId 12345 `
  -SamlMetadataUrl 'https://your-idp.example.com/metadata' `
  -SamlProviderName 'CompanySSO'

# OIDC (Azure AD modern, Okta, Auth0…)
.\deploy.ps1 -GitHubAppId 12345 `
  -OidcIssuerUrl 'https://login.microsoftonline.com/{tenant}/v2.0' `
  -OidcClientId 'your-client-id' `
  -OidcClientSecret 'your-client-secret' `
  -OidcProviderName 'AzureAD'
```

See [infra/cognito-sso-setup.md](infra/cognito-sso-setup.md) for what your IT team needs to configure on the IdP side.

### Subsequent deploys (SPA changes only)

```powershell
.\deploy.ps1 -SkipBuild
```

## Project Structure

```
├── .vscode/
│   ├── launch.json         F5 launch configs (Mock and Live modes)
│   └── tasks.json          VS Code tasks (start server, build)
├── src/                    React SPA (Vite + TypeScript + Tailwind CSS)
│   ├── api/github-api.ts   API client + mock client
│   ├── hub/Hub.tsx         Main UI component
│   ├── App.tsx             Cognito auth wrapper
│   └── main.tsx            Amplify config + React root
├── lambda/                 Node.js 20 Lambda API
│   └── src/
│       ├── handler.ts      Route handler (/api/orgs, /repos, /activity, /branch/*)
│       └── github-client.ts  GitHub App auth via Octokit + Secrets Manager
├── infra/
│   ├── template.yml        SAM template (Cognito + Lambda + API GW + S3 + CloudFront)
│   ├── deploy.ps1          One-command deployment script
│   ├── github-app-setup.md  GitHub App creation and installation guide
│   └── cognito-sso-setup.md  SAML / OIDC SSO configuration guide
└── .env.local.example      Environment variable template for local dev
```

## GitHub App Permissions Required

| Permission | Level | Purpose |
|---|---|---|
| Contents | Read | Commits, default branch info |
| Metadata | Read | Repository list |
| Pull requests | Read | Open PR count |
| Administration | Read & Write | Branch protection rules (lock/unlock) |