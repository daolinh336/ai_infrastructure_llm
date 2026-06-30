import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { renderCompose } from '../src/compose/render-compose.js';
import { repairExposedSecrets } from '../src/compose/secret-policy-repair.js';
import { resolveSecrets } from '../src/compose/secret-resolver.js';
import { buildDependencyAwareExecutionSchedule, buildDetailedDryRunPreview } from '../src/execution/dependency-schedule.js';
import type { ExecutionPlan, InfrastructureSpec } from '../src/domain/types.js';

describe('secret policy auto-repair', () => {
  it('replaces obvious env secrets before compose rendering and reports the repair', () => {
    const spec: InfrastructureSpec = {
      projectName: 'sample-infra',
      services: [
        {
          kind: 'database',
          name: 'postgres',
          image: 'postgres:16',
          environment: { POSTGRES_PASSWORD: 'abcabcabc' },
        },
      ],
      networks: ['app-network'],
      volumes: [],
    };
    const secretResolution = resolveSecrets(spec, null, {
      env: { POSTGRES_PASSWORD: 'abcabcabc' },
    });
    const repair = repairExposedSecrets(secretResolution.updatedSpec, secretResolution);
    const plan: ExecutionPlan = {
      summary: 'Create postgres',
      spec: repair.updatedSpec,
      assumptions: ['Compose preview shows repaired secrets explicitly.'],
      steps: [{ id: 'compose', description: 'Generate compose', action: 'generate-compose' }],
    };

    const composeYaml = renderCompose(plan.spec);
    const parsed = YAML.parse(composeYaml) as {
      services: Record<string, { environment?: Record<string, string> }>;
    };
    const preview = buildDetailedDryRunPreview(
      plan,
      composeYaml,
      buildDependencyAwareExecutionSchedule(plan.spec),
      secretResolution,
      repair,
    );

    expect(repair.repairedSecrets).toEqual([
      expect.objectContaining({
        serviceName: 'postgres',
        key: 'POSTGRES_PASSWORD',
        envVarName: 'POSTGRES_PASSWORD',
        originalSource: 'env-file',
        reason: 'repeated pattern password',
      }),
    ]);
    expect(parsed.services.postgres?.environment?.POSTGRES_PASSWORD).toMatch(/^pw-[a-f0-9]{24}$/);
    expect(parsed.services.postgres?.environment?.POSTGRES_PASSWORD).not.toBe('abcabcabc');
    expect(preview.policyFindings).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        code: 'secret-policy-auto-repaired',
        resourceName: 'postgres',
        message: expect.stringContaining('automatically replaced in the compose YAML'),
      }),
    );
    expect(JSON.stringify(preview.policyFindings)).not.toContain('abcabcabc');
  });

  it('leaves non-obvious env secrets unchanged', () => {
    const spec: InfrastructureSpec = {
      projectName: 'sample-infra',
      services: [
        {
          kind: 'database',
          name: 'postgres',
          image: 'postgres:16',
          environment: { POSTGRES_PASSWORD: 'safe-env-password-2026' },
        },
      ],
      networks: ['app-network'],
      volumes: [],
    };
    const secretResolution = resolveSecrets(spec, null, {
      env: { POSTGRES_PASSWORD: 'safe-env-password-2026' },
    });

    const repair = repairExposedSecrets(secretResolution.updatedSpec, secretResolution);

    expect(repair.repairedSecrets).toEqual([]);
    expect(repair.updatedSpec.services[0]?.environment?.POSTGRES_PASSWORD).toBe('safe-env-password-2026');
  });
});
