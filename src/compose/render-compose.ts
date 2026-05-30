import type { InfrastructureSpec } from '../domain/types.js';
import YAML from 'yaml';

export function renderCompose(spec: InfrastructureSpec): string {
  const compose = {
    services: Object.fromEntries(
      spec.services.map((service) => [
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
          networks: spec.networks,
        },
      ]),
    ),
    networks: Object.fromEntries(spec.networks.map((name) => [name, {}])),
    volumes: Object.fromEntries(spec.volumes.map((name) => [name, {}])),
  };

  return YAML.stringify(compose);
}
