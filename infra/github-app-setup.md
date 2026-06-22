# GitHub App Setup Guide

This document walks through creating and configuring the GitHub App that the Lambda API uses to access GitHub repositories. No user-level tokens are involved — the App authenticates as itself using a private key stored in AWS Secrets Manager.

---

## Step 1 — Create the GitHub App

1. Go to **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App** (or your org's Settings if this should be an org-owned App).

2. Fill in the fields:

   | Field | Value |
   |---|---|
   | **GitHub App name** | `Fulcrum Repository Activity` (or any name) |
   | **Homepage URL** | Your CloudFront URL (from stack output `SiteUrl`) |
   | **Webhook** | Uncheck "Active" — this app does not use webhooks |

3. **Permissions — Repository:**

   | Permission | Level |
   |---|---|
   | Contents | Read-only (for commits and default branch info) |
   | Metadata | Read-only (required by GitHub for all Apps) |
   | Pull requests | Read-only |
   | Administration | Read and write (for branch lock/unlock via branch protection) |

4. **Where can this GitHub App be installed?** — Choose:
   - **Only on this account** if it's for your own org only
   - **Any account** if you want it installable by others

5. Click **Create GitHub App**.

---

## Step 2 — Generate a Private Key

1. On the App's settings page, scroll to **Private keys** and click **Generate a private key**.
2. A `.pem` file downloads automatically. Keep it safe — you cannot retrieve it again.

---

## Step 3 — Store the Private Key in Secrets Manager

The deploy script creates a Secrets Manager secret with a placeholder value. Update it with the real key.

### Format the private key for JSON

The PEM file contains literal newlines. To store it in a JSON string you must escape them as `\n`. On PowerShell:

```powershell
$pem = Get-Content "path\to\your-app.YYYY-MM-DD.private-key.pem" -Raw
$escaped = $pem.Replace("`r`n", "\n").Replace("`n", "\n").TrimEnd("\n")
$appId = "YOUR_NUMERIC_APP_ID"  # shown on the App settings page

$secret = @{ appId = $appId; privateKey = $escaped } | ConvertTo-Json -Compress

aws secretsmanager put-secret-value `
  --secret-id '/fulcrum-github-repo-activity/github-app' `
  --secret-string $secret
```

> **Tip:** The App ID is shown at the top of the App's settings page under "App ID". It is a plain number, e.g. `12345`.

---

## Step 4 — Install the App on Your Organization(s)

1. On the App's settings page, click **Install App** in the left sidebar.
2. Choose the organization(s) you want to scan.
3. Select **All repositories** or choose specific repos.
4. Click **Install**.

Repeat for each organization you want the tool to scan. The tool will automatically detect all installed organizations via the API.

---

## Step 5 — Create Cognito Users

The Cognito User Pool is configured for admin-only user creation (no self-service sign-up). Create accounts for your team:

```powershell
# Replace values as appropriate
$poolId = "us-east-1_XXXXXXXX"  # from stack output UserPoolId

aws cognito-idp admin-create-user `
  --user-pool-id $poolId `
  --username user@example.com `
  --temporary-password "TempPass1!" `
  --user-attributes Name=email,Value=user@example.com Name=email_verified,Value=true
```

Users will be prompted to set a permanent password on first login.

---

## Permissions Reference

| GitHub App Permission | Why it's needed |
|---|---|
| **Contents: Read** | List commits on the default branch |
| **Metadata: Read** | Required by GitHub for all Apps (repo list, branch info) |
| **Pull requests: Read** | Count open PRs targeting the default branch |
| **Administration: Read & Write** | Read and set branch protection rules (for branch lock/unlock) |

> **Note:** If you do not need the Lock/Unlock feature, you can grant **Administration: Read** only and remove the lock/unlock buttons from the UI.

---

## Rotating the Private Key

1. Go to the App's settings → **Private keys** → **Generate a private key**.
2. Update Secrets Manager with the new key (see Step 3).
3. Delete the old key from the App settings.

The Lambda caches the App instance in memory per container. After updating the secret, a cold start (new Lambda container) will pick up the new key automatically. You can force a cold start by deploying a dummy environment variable change.
