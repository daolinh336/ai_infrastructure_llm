export interface StaticResourceLimitConfig {
  maxTotalContainers: number;
  maxAbsurdReplicas: number;
  maxCpu: number;
  maxMemoryGb: number;
}

export interface InfrastructureSchemaLimitConfig {
  maxServiceReplicas: number;
}

export const DEFAULT_STATIC_RESOURCE_LIMITS: StaticResourceLimitConfig = {
  maxTotalContainers: 50,
  maxAbsurdReplicas: 100_000,
  maxCpu: 4,
  maxMemoryGb: 8,
};

export const DEFAULT_INFRASTRUCTURE_SCHEMA_LIMITS: InfrastructureSchemaLimitConfig = {
  maxServiceReplicas: 70,
};

const ENV_MAX_TOTAL_CONTAINERS = 'INFRA_MAX_TOTAL_CONTAINERS';
const ENV_MAX_ABSURD_REPLICAS = 'INFRA_MAX_ABSURD_REPLICAS';
const ENV_MAX_CPU = 'INFRA_MAX_CPU';
const ENV_MAX_MEMORY_GB = 'INFRA_MAX_MEMORY_GB';
const ENV_MAX_SERVICE_REPLICAS = 'INFRA_MAX_SERVICE_REPLICAS';

function readPositiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name]);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function readPositiveNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name]);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

export function loadStaticResourceLimitConfig(
  env: NodeJS.ProcessEnv = process.env,
): StaticResourceLimitConfig {
  return {
    maxTotalContainers: readPositiveInteger(
      env,
      ENV_MAX_TOTAL_CONTAINERS,
      DEFAULT_STATIC_RESOURCE_LIMITS.maxTotalContainers,
    ),
    maxAbsurdReplicas: readPositiveInteger(
      env,
      ENV_MAX_ABSURD_REPLICAS,
      DEFAULT_STATIC_RESOURCE_LIMITS.maxAbsurdReplicas,
    ),
    maxCpu: readPositiveNumber(env, ENV_MAX_CPU, DEFAULT_STATIC_RESOURCE_LIMITS.maxCpu),
    maxMemoryGb: readPositiveNumber(
      env,
      ENV_MAX_MEMORY_GB,
      DEFAULT_STATIC_RESOURCE_LIMITS.maxMemoryGb,
    ),
  };
}

export function loadInfrastructureSchemaLimitConfig(
  env: NodeJS.ProcessEnv = process.env,
): InfrastructureSchemaLimitConfig {
  return {
    maxServiceReplicas: readPositiveInteger(
      env,
      ENV_MAX_SERVICE_REPLICAS,
      DEFAULT_INFRASTRUCTURE_SCHEMA_LIMITS.maxServiceReplicas,
    ),
  };
}
