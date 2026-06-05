import type { InfrastructureSpec } from '../domain/types.js';
import { validateInfrastructureSpec } from '../domain/schemas.js';
import YAML from 'yaml';

export function renderCompose(spec: InfrastructureSpec): string {
  const validSpec = validateInfrastructureSpec(spec);
  const compose = {
    services: Object.fromEntries(
      validSpec.services.map((service) => [
        service.name,
        {
          image: service.image,
          ...(service.replicas && service.replicas > 1
            ? { deploy: { replicas: service.replicas } }
            : {}),
          ...(service.ports?.length ? { ports: service.ports } : {}),
          ...(service.environment ? { environment: service.environment } : {}),
          ...(service.dependsOn?.length ? { depends_on: service.dependsOn } : {}),
          ...(service.volumes?.length ? { volumes: service.volumes } : {}),
          networks: validSpec.networks,
        },
      ]),
    ),
    networks: Object.fromEntries(validSpec.networks.map((name) => [name, {}])),
    volumes: Object.fromEntries(validSpec.volumes.map((name) => [name, {}])),
  };

  return YAML.stringify(compose);
}
