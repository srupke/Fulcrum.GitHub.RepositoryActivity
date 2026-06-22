# Cognito SSO Setup Guide

Cognito federates with your company's identity provider so users log in with their existing corporate credentials. The SPA, Lambda, and API Gateway require no changes — Cognito handles the IdP interaction and issues its own JWT tokens to the app.

The Cognito Hosted UI will show both options side by side:
- Email + password (local Cognito accounts, already configured)
- "Sign in with [Company]" button (SSO)

---

## Option A — SAML 2.0

Works with: **Okta, Azure AD/Entra ID (enterprise apps), ADFS, Ping Identity, OneLogin**, and any SAML 2.0 compliant IdP.

### What you need from IT / the IdP admin

| Item | Where to find it |
|---|---|
| **SAML metadata URL** | Okta: App → Sign On tab → Identity Provider metadata. Azure AD: Enterprise App → Single sign-on → App Federation Metadata Url. |
| **Email attribute name** | Usually `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress` (the default). Ask IT if your IdP uses a different name. |

### What IT needs to configure in the IdP

They register Cognito as a **Service Provider (SP)**:

| SP field | Value |
|---|---|
| **SP Entity ID / Audience URI** | `urn:amazon:cognito:sp:{UserPoolId}` |
| **ACS URL / SSO URL** | `https://{AppName}-{AccountId}.auth.{Region}.amazoncognito.com/saml2/idpresponse` |
| **Name ID format** | Email address |
| **Attribute to map** | Email address → `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress` (or your chosen attribute name) |

> The UserPoolId and Cognito domain are in the stack outputs after first deploy.

### Deploy command

```powershell
.\deploy.ps1 `
  -GitHubAppId 12345 `
  -SamlMetadataUrl 'https://your-idp.example.com/app/abc123/sso/saml/metadata' `
  -SamlProviderName 'CompanySSO'
  # -SamlEmailAttribute 'email'   # only if your IdP uses a non-standard attribute name
```

---

## Option B — OIDC / OAuth 2.0

Works with: **Azure AD/Entra ID (modern), Okta, Google Workspace, Auth0**, and any OpenID Connect compliant IdP.

### What you need from IT / the IdP admin

| Item | Example |
|---|---|
| **Issuer / Discovery URL** | Azure AD: `https://login.microsoftonline.com/{tenantId}/v2.0` |
| | Okta: `https://{yourDomain}.okta.com/oauth2/default` |
| **Client ID** | Created when IT registers the app in the IdP |
| **Client Secret** | Created alongside the client ID |

### What IT needs to configure in the IdP

They register a new **OAuth 2.0 / OIDC application**:

| Field | Value |
|---|---|
| **Application type** | Web / Confidential client |
| **Redirect URI** | `https://{AppName}-{AccountId}.auth.{Region}.amazoncognito.com/oauth2/idpresponse` |
| **Scopes** | `openid`, `email`, `profile` |

### Deploy command

```powershell
.\deploy.ps1 `
  -GitHubAppId 12345 `
  -OidcIssuerUrl 'https://login.microsoftonline.com/{tenantId}/v2.0' `
  -OidcClientId 'your-client-id' `
  -OidcClientSecret 'your-client-secret' `
  -OidcProviderName 'AzureAD'
```

---

## Using both SAML and OIDC simultaneously

Pass all parameters together — both providers will be created and both buttons will appear in the Cognito Hosted UI:

```powershell
.\deploy.ps1 `
  -GitHubAppId 12345 `
  -SamlMetadataUrl 'https://...' `
  -SamlProviderName 'OktaSAML' `
  -OidcIssuerUrl 'https://...' `
  -OidcClientId 'xxx' `
  -OidcClientSecret 'yyy' `
  -OidcProviderName 'AzureAD'
```

---

## Access control: who can log in via SSO?

By default, **any user who can authenticate with your IdP** can access the app. If you need to restrict access (e.g. to a specific department or group):

**Option 1 — Restrict at the IdP level (recommended)**
Configure the IdP app registration to be visible only to specific users/groups. IT controls who has access without any app changes.

**Option 2 — Cognito Pre-Authentication Lambda trigger**
Add a Lambda trigger to the User Pool that checks an attribute from the SAML assertion or OIDC token (e.g. group membership) and throws an error to block unwanted users. This requires additional development.

---

## Removing an SSO provider

Re-deploy without the SSO parameters:

```powershell
# Remove SAML — omit -SamlMetadataUrl
.\deploy.ps1 -GitHubAppId 12345

# Or to clear a specific provider, pass its parameter as empty string
.\deploy.ps1 -GitHubAppId 12345 -SamlMetadataUrl ''
```

CloudFormation will delete the `SamlIdentityProvider` resource and remove it from the User Pool Client.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Invalid SAML response" | ACS URL misconfigured in the IdP. Verify it matches the Cognito domain exactly. |
| "Attributes could not be mapped" | Email attribute name mismatch. Check `SamlEmailAttribute` vs. what the IdP sends. |
| OIDC redirect loop | Redirect URI in the IdP doesn't match the Cognito `/oauth2/idpresponse` URL exactly. |
| "User does not exist" error | Can occur if the email attribute is missing from the assertion. Check IdP attribute mapping. |
