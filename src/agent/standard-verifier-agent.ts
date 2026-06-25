import type { DockerMcpGateway } from '../execution/docker-mcp-gateway.js';
import type {
  InfrastructureSpec,
  RuntimeActualState,
  RuntimeResourceRefs,
  VerificationReport,
} from '../domain/types.js';
import { validateVerificationReport } from '../domain/schemas.js';
import { buildDriftReport } from '../execution/drift-detector.js';
import type { VerifierAgent } from './agent-interfaces.js';

export class StandardVerifierAgent implements VerifierAgent {
  async verify(
    desiredSpec: InfrastructureSpec,
    dockerMcpClient: DockerMcpGateway,
  ): Promise<VerificationReport> {
    const checkedAt = new Date().toISOString();
    const issues: string[] = [];
    const evidence: string[] = [];

    try {
      if (!dockerMcpClient.isInitialized) {
        return validateVerificationReport({
          status: 'uncertain',
          scope: 'tool-runtime',
          checkedAt,
          issues: ['DockerMcpClient is not initialized.'],
          evidence: [],
          errorReason: 'Cannot verify because Docker MCP client is not initialized.',
          revisionHint: 'Call initialize() before verify().',
          confidence: 0,
        });
      }

      const containers = await dockerMcpClient.listContainers(true);
      const networks = await dockerMcpClient.listNetworks();
      const volumes = await dockerMcpClient.listVolumes();
      const images = await dockerMcpClient.listImages();
      const actual: RuntimeActualState = { source: 'mcp-readonly', containers, networks, volumes, images, lastObservedAt: checkedAt };
      const drift = buildDriftReport(desiredSpec, actual, checkedAt);
      if (drift.status !== 'none') {
        for (const finding of drift.findings) { issues.push(finding.message); }
        evidence.push('Drift report: ' + drift.summary);
      } else {
        evidence.push('Drift report: no drift detected.');
      }

      evidence.push('Observed ' + String(containers.length) + ' container(s), ' + String(networks.length) + ' network(s), ' + String(volumes.length) + ' volume(s), ' + String(images.length) + ' image(s).');

      for (const service of desiredSpec.services) {
        const expectedName = toContainerName(desiredSpec.projectName, service.name);
        const matchingContainers = containers.filter(
          (c) => c.name === expectedName || c.name.includes(service.name),
        );

        if (matchingContainers.length === 0) {
          issues.push('Service "' + service.name + '" has no matching container (expected: ' + expectedName + ').');
          continue;
        }

        if (service.replicas && service.replicas > 1) {
          if (matchingContainers.length !== service.replicas) {
            issues.push('Service "' + service.name + '" expected ' + String(service.replicas) + ' replica(s), found ' + String(matchingContainers.length) + '.');
          } else {
            evidence.push('Service "' + service.name + '" has ' + String(service.replicas) + ' replica(s) as expected.');
          }
        }

        const container = matchingContainers[0];
        if (container && container.image && !container.image.includes(service.image.split(':')[0]!)) {
          issues.push('Service "' + service.name + '" image mismatch: expected "' + service.image + '", running "' + container.image + '".');
        } else {
          evidence.push('Service "' + service.name + '" running expected image.');
        }

        if (service.ports && service.ports.length > 0) {
          const actualPorts = (container && container.ports) ? container.ports : [];
          const missingPorts = service.ports.filter((p) => !actualPorts.some((ap) => ap.includes(p.split(':')[0]!)));
          if (missingPorts.length > 0) {
            issues.push('Service "' + service.name + '" missing port mappings: ' + missingPorts.join(', ') + '.');
          } else {
            evidence.push('Service "' + service.name + '" has expected port mappings.');
          }
        }
      }

      for (const network of desiredSpec.networks) {
        const networkExists = networks.some((n) => n.name === network);
        if (!networkExists) {
          issues.push('Network "' + network + '" is declared in spec but not found in Docker.');
        } else {
          evidence.push('Network "' + network + '" found in Docker.');
        }
      }

      for (const service of desiredSpec.services) {
        for (const volume of service.volumes ?? []) {
          const volumeName = volume.split(':')[0];
          const volumeExists = volumes.some((v) => v.name === volumeName);
          if (!volumeExists) {
            issues.push('Volume "' + volumeName + '" declared in service "' + service.name + '" but not found in Docker.');
          }
        }
      }

      const status = issues.length === 0 ? 'passed' : 'failed';
      return validateVerificationReport({
        status,
        scope: 'tool-runtime',
        checkedAt,
        issues,
        evidence,
        errorReason: issues.length > 0 ? 'Verification found ' + String(issues.length) + ' issue(s).' : null,
        revisionHint: issues.length > 0 ? 'Re-run plan or repair the deployment to match the desired spec.' : null,
        confidence: issues.length === 0 ? 0.95 : 0.6,
      });
    } catch (error) {
      return validateVerificationReport({
        status: 'uncertain',
        scope: 'tool-runtime',
        checkedAt,
        issues: ['Verification failed with error: ' + getErrorMessage(error)],
        evidence: [],
        errorReason: 'Unexpected error during verification.',
        revisionHint: 'Check Docker daemon and MCP connectivity.',
        confidence: 0,
      });
    }
  }

  async compareState(
    desired: InfrastructureSpec,
    actual: RuntimeActualState,
  ): Promise<VerificationReport> {
    const checkedAt = new Date().toISOString();
    const issues: string[] = [];
    const evidence: string[] = [];

    for (const service of desired.services) {
      const matchingContainer = actual.containers.find(
        (c) => c.name.includes(service.name),
      );
      if (!matchingContainer) {
        issues.push('Service "' + service.name + '" not found in actual state.');
        continue;
      }
      evidence.push('Service "' + service.name + '" found in actual state.');
    }

    const status = issues.length === 0 ? 'passed' : 'failed';
    return validateVerificationReport({
      status,
      scope: 'tool-runtime',
      checkedAt,
      issues,
      evidence,
      errorReason: issues.length > 0 ? 'Desired state differs from actual state.' : null,
      revisionHint: issues.length > 0 ? 'Re-run plan or repair the deployment.' : null,
      confidence: status === 'passed' ? 0.9 : 0.5,
    });
  }
}

export function buildResourceRefs(
  projectName: string,
  actual: RuntimeActualState,
): RuntimeResourceRefs {
  return {
    projectName,
    containers: actual.containers.map((c) => c.name),
    networks: actual.networks.map((n) => n.name),
    volumes: actual.volumes.map((v) => v.name),
    images: actual.images.map((i) => i.reference),
  };
}

function toContainerName(projectName: string, serviceName: string): string {
  return projectName + '-' + serviceName.replace(/[_\\s]+/g, '-');
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
