<#
.SYNOPSIS
  Deploy Fulcrum GitHub Repository Activity to AWS.

.DESCRIPTION
  1. Runs `sam build` to compile the Lambda TypeScript via esbuild.
  2. Runs `sam deploy` to create/update the CloudFormation stack.
  3. Reads stack outputs (Cognito IDs, S3 bucket, CloudFront ID).
  4. Builds the Vite SPA with the correct environment variables.
  5. Syncs the built SPA to S3 (long cache for assets, no-cache for HTML).
  6. Invalidates the CloudFront cache.

.PARAMETER AppName
  Stack / resource name prefix. Default: fulcrum-github-repo-activity

.PARAMETER GitHubAppId
  Numeric GitHub App ID.  Required on first deploy; optional on updates.

.PARAMETER CustomDomain
  Optional custom domain, e.g. repo-activity.example.com

.PARAMETER HostedZoneId
  Route 53 Hosted Zone ID. Required when CustomDomain is provided.

.PARAMETER AcmCertificateArn
  ACM certificate ARN in us-east-1 for the custom domain. Required when CustomDomain is set.

.PARAMETER AwsRegion
  AWS region to deploy into. Default: us-east-1

.PARAMETER SkipBuild
  Skip the SAM build + deploy step (re-use existing stack, just redeploy the SPA).

.EXAMPLE
  # First deploy with custom domain
  .\deploy.ps1 -GitHubAppId 12345 -CustomDomain repo.example.com -HostedZoneId ZXYZ -AcmCertificateArn arn:aws:acm:us-east-1:...

  # Redeploy SPA only (faster iteration)
  .\deploy.ps1 -SkipBuild
#>
param(
  [string]$AppName        = 'fulcrum-github-repo-activity',
  [string]$GitHubAppId    = '',
  [string]$CustomDomain   = '',
  [string]$HostedZoneId   = '',
  [string]$AcmCertificateArn = '',
  [string]$AwsRegion      = 'us-east-1',
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$ScriptDir = $PSScriptRoot
$RepoRoot  = Split-Path $ScriptDir -Parent

function Log([string]$msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Die([string]$msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

# ── 1. SAM build + deploy ──────────────────────────────────────────────────

if (-not $SkipBuild) {
  Log "Building Lambda (SAM + esbuild)…"
  Push-Location $ScriptDir
  sam build --template template.yml
  if ($LASTEXITCODE -ne 0) { Die "sam build failed." }

  $params = @(
    "--stack-name", $AppName,
    "--region",     $AwsRegion,
    "--capabilities", "CAPABILITY_IAM",
    "--resolve-s3",
    "--no-confirm-changeset",
    "--parameter-overrides",
      "AppName=$AppName"
  )

  if ($GitHubAppId)        { $params += "GitHubAppId=$GitHubAppId" }
  if ($CustomDomain)       { $params += "CustomDomain=$CustomDomain" }
  if ($HostedZoneId)       { $params += "HostedZoneId=$HostedZoneId" }
  if ($AcmCertificateArn)  { $params += "AcmCertificateArn=$AcmCertificateArn" }

  Log "Deploying CloudFormation stack '$AppName'…"
  sam deploy @params
  if ($LASTEXITCODE -ne 0) { Die "sam deploy failed." }
  Pop-Location
}

# ── 2. Read stack outputs ──────────────────────────────────────────────────

Log "Reading stack outputs…"
$stack = aws cloudformation describe-stacks `
  --stack-name $AppName `
  --region     $AwsRegion `
  --query      "Stacks[0].Outputs" `
  --output     json | ConvertFrom-Json

function Output([string]$key) {
  ($stack | Where-Object { $_.OutputKey -eq $key }).OutputValue
}

$BucketName       = Output 'WebsiteBucketName'
$DistributionId   = Output 'CloudFrontDistributionId'
$UserPoolId       = Output 'UserPoolId'
$UserPoolClientId = Output 'UserPoolClientId'
$CognitoDomain    = Output 'CognitoDomain'
$ApiEndpoint      = Output 'ApiEndpoint'
$SiteUrl          = Output 'SiteUrl'

if (-not $BucketName)     { Die "Could not read WebsiteBucketName from stack outputs." }
if (-not $DistributionId) { Die "Could not read CloudFrontDistributionId from stack outputs." }

Write-Host ""
Write-Host "  Site URL          : $SiteUrl"
Write-Host "  S3 Bucket         : $BucketName"
Write-Host "  CloudFront ID     : $DistributionId"
Write-Host "  User Pool ID      : $UserPoolId"
Write-Host "  User Pool Client  : $UserPoolClientId"
Write-Host "  Cognito Domain    : $CognitoDomain"
Write-Host "  API Endpoint      : $ApiEndpoint"
Write-Host ""

# ── 3. Build Vite SPA ─────────────────────────────────────────────────────

Log "Building SPA (Vite)…"
Push-Location $RepoRoot

$env:VITE_USER_POOL_ID       = $UserPoolId
$env:VITE_USER_POOL_CLIENT_ID = $UserPoolClientId
$env:VITE_COGNITO_DOMAIN     = $CognitoDomain
$env:VITE_API_URL            = $ApiEndpoint
$env:VITE_MOCK               = 'false'

npm run build
if ($LASTEXITCODE -ne 0) { Die "npm run build failed." }
Pop-Location

# ── 4. Upload to S3 ───────────────────────────────────────────────────────

Log "Uploading to S3 bucket '$BucketName'…"

# Hashed assets: 1-year immutable cache
aws s3 sync "$RepoRoot/dist/assets" "s3://$BucketName/assets" `
  --region $AwsRegion `
  --cache-control "public, max-age=31536000, immutable" `
  --delete

# HTML + root files: no-cache so browsers always revalidate
aws s3 sync "$RepoRoot/dist" "s3://$BucketName" `
  --region $AwsRegion `
  --exclude "assets/*" `
  --cache-control "no-cache, no-store, must-revalidate" `
  --delete

if ($LASTEXITCODE -ne 0) { Die "S3 sync failed." }

# ── 5. Invalidate CloudFront ──────────────────────────────────────────────

Log "Invalidating CloudFront distribution '$DistributionId'…"
aws cloudfront create-invalidation `
  --distribution-id $DistributionId `
  --paths "/*" | Out-Null

if ($LASTEXITCODE -ne 0) { Die "CloudFront invalidation failed." }

# ── Done ──────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "Deploy complete!" -ForegroundColor Green
Write-Host "  $SiteUrl" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. If you used PLACEHOLDER for the GitHub App private key, update the secret:"
Write-Host "     aws secretsmanager put-secret-value --secret-id '/$AppName/github-app' --secret-string '{""appId"":""YOUR_ID"",""privateKey"":""-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----""}'"
Write-Host "  2. Create Cognito users: aws cognito-idp admin-create-user --user-pool-id $UserPoolId --username user@example.com"
Write-Host "  3. Install the GitHub App on your organization(s): see infra/github-app-setup.md"
