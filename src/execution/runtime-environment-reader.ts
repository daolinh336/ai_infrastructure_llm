import type {
  InfrastructureSpec,
  RuntimeActualState,
  RuntimeContainerSummary,
} from '../domain/types.js';
import type { DockerMcpGateway } from './docker-mcp-gateway.js';
import { toReplicaContainerNames } from './container-names.js';

export interface RuntimeEnvironmentReadOptions {
  containerNames?: string[];
}

export interface PlannerRuntimeReader {
  listUsedHostPorts(): Promise<Array<{ hostPort: string; containerName: string }>>;
  listContainerNames(): Promise<string[]>;
  listImageReferences(): Promise<string[]>;
  listNetworkNames(): Promise<string[]>;
  listVolumeNames(): Promise<string[]>;
  inspectContainerSummary(name: string): Promise<RuntimeContainerSummary | null>;
}

export class DockerMcpPlannerRuntimeReader implements PlannerRuntimeReader {
  constructor(private readonly gateway: DockerMcpGateway) {}

  async listUsedHostPorts(): Promise<Array<{ hostPort: string; containerName: string }>> {
    return this.gateway.listUsedHostPorts();
  }

  async listContainerNames(): Promise<string[]> {
    const containers = await this.gateway.listContainers(true);
    return containers.map((container) => container.name);
  }

  async listImageReferences(): Promise<string[]> {
    const images = await this.gateway.listImages();
    return images.map((image) => image.reference);
  }

  async listNetworkNames(): Promise<string[]> {
    const networks = await this.gateway.listNetworks();
    return networks.map((network) => network.name);
  }

  async listVolumeNames(): Promise<string[]> {
    const volumes = await this.gateway.listVolumes();
    return volumes.map((volume) => volume.name);
  }

  async inspectContainerSummary(name: string): Promise<RuntimeContainerSummary | null> {
    return this.gateway.inspectContainerSummary(name);
  }
}

export function createPlannerRuntimeReader(gateway: DockerMcpGateway): PlannerRuntimeReader {
  return new DockerMcpPlannerRuntimeReader(gateway);
}

export interface VerifierRuntimeReader {
  readonly isReady: boolean;
  read(
    desiredSpec: InfrastructureSpec,
    options?: RuntimeEnvironmentReadOptions,
  ): Promise<RuntimeActualState>;
  readLogs(containerName: string, tailLines?: number): Promise<string | null>;
}

export class DockerMcpVerifierRuntimeReader implements VerifierRuntimeReader {
  constructor(private readonly gateway: DockerMcpGateway) {}

  get isReady(): boolean {
    return this.gateway.isInitialized;
  }

  async read(
    desiredSpec: InfrastructureSpec,
    options: RuntimeEnvironmentReadOptions = {},
  ): Promise<RuntimeActualState> {
    return readRuntimeEnvironment(this.gateway, desiredSpec, options);
  }

  async readLogs(containerName: string, tailLines = 80): Promise<string | null> {
    return this.gateway.readContainerLogs(containerName, tailLines);
  }
}

export function createVerifierRuntimeReader(gateway: DockerMcpGateway): VerifierRuntimeReader {
  return new DockerMcpVerifierRuntimeReader(gateway);
}

export class RuntimeEnvironmentReader {
  constructor(private readonly gateway: DockerMcpGateway) {}

  async read(
    desiredSpec: InfrastructureSpec,
    options: RuntimeEnvironmentReadOptions = {},
  ): Promise<RuntimeActualState> {
    const containerNames = options.containerNames ?? desiredSpec.services.flatMap((service) =>
      toReplicaContainerNames(desiredSpec.projectName, service),
    );
    return this.gateway.observeActualStateWithInspect({ containerNames });
  }

  async readLogs(containerName: string, tailLines = 80): Promise<string | null> {
    return this.gateway.readContainerLogs(containerName, tailLines);
  }

  async readUsedHostPorts(): Promise<Array<{ hostPort: string; containerName: string }>> {
    return this.gateway.listUsedHostPorts();
  }
}

function readRuntimeEnvironment(
  gateway: DockerMcpGateway,
  desiredSpec: InfrastructureSpec,
  options: RuntimeEnvironmentReadOptions = {},
): Promise<RuntimeActualState> {
  const containerNames = options.containerNames ?? desiredSpec.services.flatMap((service) =>
    toReplicaContainerNames(desiredSpec.projectName, service),
  );
  return gateway.observeActualStateWithInspect({ containerNames });
}
