import { describe, expect, it } from 'vitest';
import { renderCompose } from '../src/compose/render-compose.js';

describe('renderCompose', () => {
  it('renders services, networks, and volumes', () => {
    const yaml = renderCompose({
      projectName: 'demo',
      networks: ['app-network'],
      volumes: ['db-data'],
      services: [
        {
          kind: 'database',
          name: 'postgres',
          image: 'postgres:16',
          volumes: ['db-data:/var/lib/postgresql/data'],
        },
      ],
    });

    expect(yaml).toContain('postgres:');
    expect(yaml).toContain('networks:');
    expect(yaml).toContain('volumes:');
  });
});
