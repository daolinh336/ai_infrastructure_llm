import { describe, expect, it } from 'vitest';
import { runDockerDoctor } from '../src/doctor/docker-doctor.js';

describe('Docker doctor', () => {
  it('checks Docker Engine API directly without requiring Docker CLI', async () => {
    const report = await runDockerDoctor(async () => ({ stdout: 'OK', stderr: '' }), '2026-06-28T00:00:00.000Z');

    expect(report).toMatchObject({
      status: 'passed',
      checkedAt: '2026-06-28T00:00:00.000Z',
      dockerCliFound: false,
      engineReachable: true,
      commands: [
        {
          command: 'Docker Engine API',
          args: ['GET', '/_ping'],
          ok: true,
          stdout: 'OK',
          stderr: '',
          errorMessage: null,
        },
      ],
    });
    expect(report.evidence).toContain('Docker doctor is read-only and sends GET /_ping to the Docker Engine API.');
  });

  it('reports engine ping failures', async () => {
    const report = await runDockerDoctor(async () => {
      throw new Error('connect ENOENT');
    });

    expect(report.status).toBe('failed');
    expect(report.engineReachable).toBe(false);
    expect(report.issues).toContain('Docker Desktop engine is not reachable via read-only Docker Engine API ping.');
    expect(report.commands[0]).toMatchObject({
      command: 'Docker Engine API',
      args: ['GET', '/_ping'],
      ok: false,
      errorMessage: 'connect ENOENT',
    });
  });
});
