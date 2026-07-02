import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ServiceSecretResolution } from './secret-resolver.js';

/**
 * Writes `state/generated-secrets.env` after deploy.
 *
 * ONLY auto-generated secrets are recorded here — never passwords the user
 * supplied via `.env`. The file is a read-only reference so the user can look up
 * what the system generated; to use custom values they edit `.env` instead.
 */
export async function writeGeneratedSecretsFile(
  resolutions: ServiceSecretResolution[],
  projectName: string,
  outputDir?: string,
): Promise<string> {
  const dir = outputDir ?? path.resolve('state');
  const targetPath = path.join(dir, 'generated-secrets.env');
  const generatedAt = new Date().toISOString();

  const lines: string[] = [
    '# ================================================================',
    '# AUTO-GENERATED SECRETS — infra-react-agent',
    `# Project: ${projectName}`,
    `# Generated at: ${generatedAt}`,
    '# ----------------------------------------------------------------',
    '# Read-only reference file — do not edit.',
    '# Want custom passwords? Put them in .env, then run plan again.',
    '# ================================================================',
    '',
  ];

  for (const resolution of resolutions) {
    const generated = resolution.secrets.filter((secret) => secret.source === 'auto-generated');
    if (generated.length === 0) {
      continue;
    }
    lines.push(`# Service: ${resolution.serviceName}`);
    for (const secret of generated) {
      lines.push(`${secret.key}=${secret.value}`);
    }
    lines.push('');
  }

  await mkdir(dir, { recursive: true });
  await writeFile(targetPath, lines.join('\n'), 'utf8');
  return targetPath;
}
