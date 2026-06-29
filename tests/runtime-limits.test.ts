import { describe, expect, it } from 'vitest';
import {
  loadInfrastructureSchemaLimitConfig,
  loadStaticResourceLimitConfig,
} from '../src/config/runtime-limits.js';
import { infrastructureServiceSchema } from '../src/domain/schemas.js';

describe('runtime limit configuration', () => {
  it('loads static resource limits from env with defaults', () => {
    expect(loadStaticResourceLimitConfig({})).toEqual({
      maxTotalContainers: 10,
      maxAbsurdReplicas: 100_000,
      maxCpu: 4,
      maxMemoryGb: 8,
    });

    expect(
      loadStaticResourceLimitConfig({
        INFRA_MAX_TOTAL_CONTAINERS: '20',
        INFRA_MAX_ABSURD_REPLICAS: '200000',
        INFRA_MAX_CPU: '8',
        INFRA_MAX_MEMORY_GB: '16',
      }),
    ).toEqual({
      maxTotalContainers: 20,
      maxAbsurdReplicas: 200_000,
      maxCpu: 8,
      maxMemoryGb: 16,
    });
  });

  it('loads service replica schema limit from env', () => {
    expect(loadInfrastructureSchemaLimitConfig({})).toEqual({ maxServiceReplicas: 50 });
    expect(loadInfrastructureSchemaLimitConfig({ INFRA_MAX_SERVICE_REPLICAS: '75' })).toEqual({
      maxServiceReplicas: 75,
    });
  });

  it('applies service replica schema limit at validation time', () => {
    const previous = process.env.INFRA_MAX_SERVICE_REPLICAS;
    process.env.INFRA_MAX_SERVICE_REPLICAS = '2';

    try {
      expect(
        infrastructureServiceSchema.safeParse({
          kind: 'backend',
          name: 'api',
          image: 'node:20-alpine',
          replicas: 3,
        }).success,
      ).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.INFRA_MAX_SERVICE_REPLICAS;
      } else {
        process.env.INFRA_MAX_SERVICE_REPLICAS = previous;
      }
    }
  });
});
