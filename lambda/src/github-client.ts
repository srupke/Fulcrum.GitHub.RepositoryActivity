import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { App } from '@octokit/app';
import { Octokit } from '@octokit/rest';

interface GitHubAppSecret {
  appId: string;
  privateKey: string;
}

let cachedApp: App | null = null;
const smClient = new SecretsManagerClient({});

async function getApp(): Promise<App> {
  if (cachedApp) return cachedApp;

  const res = await smClient.send(new GetSecretValueCommand({
    SecretId: process.env.GITHUB_APP_SECRET_ARN!,
  }));

  const secret: GitHubAppSecret = JSON.parse(res.SecretString!);

  // Private keys stored in JSON have literal \n — normalize to real newlines
  const privateKey = secret.privateKey.replace(/\\n/g, '\n');

  cachedApp = new App({ appId: Number(secret.appId), privateKey });
  return cachedApp;
}

export async function getOctokit(org: string): Promise<Octokit> {
  const app = await getApp();

  let installationId: number;
  try {
    const { data } = await app.octokit.request('GET /orgs/{org}/installation', { org });
    installationId = data.id;
  } catch (e: any) {
    if (e.status !== 404) throw e;
    // Personal account — fall back to user installation endpoint
    const { data } = await app.octokit.request('GET /users/{username}/installation', { username: org });
    installationId = data.id;
  }

  // Exchange installation ID for a short-lived token via the app auth strategy,
  // then create a full @octokit/rest instance (includes rest.* and paginate).
  const { token } = await (app.octokit as any).auth({
    type: 'installation',
    installationId,
  }) as { token: string };

  return new Octokit({ auth: token });
}

export interface InstallationOrg {
  login: string;
  name: string;
  avatarUrl: string;
}

export async function listInstalledOrgs(): Promise<InstallationOrg[]> {
  const app = await getApp();
  const orgs: InstallationOrg[] = [];

  for await (const { installation } of app.eachInstallation.iterator()) {
    const acct = installation.account;
    if (acct) {
      orgs.push({
        login: acct.login ?? '',
        name: (acct as any).name ?? acct.login ?? '',
        avatarUrl: acct.avatar_url ?? '',
      });
    }
  }

  return orgs;
}
