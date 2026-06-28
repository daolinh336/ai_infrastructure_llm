import type { InfrastructureSpec, RuntimeActualState } from '../domain/types.js';
import type { DockerMcpGateway } from './docker-mcp-gateway.js';

export interface RuntimeEnvironmentReadOptions {
  containerNames?: string[];
}

export class RuntimeEnvironmentReader {
  constructor(private readonly gateway: DockerMcpGateway) {}

  async read(
    desiredSpec: InfrastructureSpec,
    options: RuntimeEnvironmentReadOptions = {},
  ): Promise<RuntimeActualState> {
    const containerNames = options.containerNames ?? desiredSpec.services.map(
      (service) => desiredSpec.projectName + '-' + service.name.replace(/[_\s]+/g, '-'),
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
