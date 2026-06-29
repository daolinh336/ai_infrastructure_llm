import http from 'node:http';
import { platform } from 'node:os';

export interface DockerDoctorCommandOutput {
  stdout: string;
  stderr: string;
}

export type DockerDoctorEngineApiRunner = () => Promise<DockerDoctorCommandOutput>;

export interface DockerDoctorCommandRecord {
  command: string;
  args: string[];
  ok: boolean;
  stdout: string;
  stderr: string;
  errorMessage: string | null;
}

export interface DockerDoctorReport {
  status: 'passed' | 'failed';
  checkedAt: string;
  dockerCliFound: boolean;
  engineReachable: boolean;
  commands: DockerDoctorCommandRecord[];
  issues: string[];
  evidence: string[];
}

export async function runDockerDoctor(
  runner: DockerDoctorEngineApiRunner = defaultDockerEngineApiPingRunner,
  checkedAt = new Date().toISOString(),
): Promise<DockerDoctorReport> {
  const commands: DockerDoctorCommandRecord[] = [];
  const issues: string[] = [];
  const evidence: string[] = [
    'Docker doctor is read-only and sends GET /_ping to the Docker Engine API.',
    'Docker doctor does not call the Docker CLI, MCP, docker run, pull, compose, create, start, stop, or remove.',
  ];
  const engineCheck = await runDoctorCommand(runner, 'Docker Engine API', ['GET', '/_ping']);
  commands.push(engineCheck);

  if (!engineCheck.ok) {
    issues.push('Docker Desktop engine is not reachable via read-only Docker Engine API ping.');
  } else {
    evidence.push('Docker Desktop engine responded to read-only Docker Engine API ping.');
  }

  return {
    status: issues.length ? 'failed' : 'passed',
    checkedAt,
    dockerCliFound: false,
    engineReachable: engineCheck.ok,
    commands,
    issues,
    evidence,
  };
}

export function defaultDockerEngineApiPingRunner(): Promise<DockerDoctorCommandOutput> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        method: 'GET',
        path: '/_ping',
        socketPath: getDockerEngineSocketPath(),
        timeout: 10_000,
      },
      (response) => {
        let body = '';

        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          if (response.statusCode === 200 && body.trim() === 'OK') {
            resolve({ stdout: body, stderr: '' });
            return;
          }

          reject(
            new Error(
              `Docker Engine API ping returned status ${response.statusCode ?? 'unknown'} with body ${JSON.stringify(body)}`,
            ),
          );
        });
      },
    );

    request.on('timeout', () => {
      request.destroy(new Error('Docker Engine API ping timed out after 10000ms'));
    });
    request.on('error', reject);
    request.end();
  });
}

function getDockerEngineSocketPath(): string {
  return platform() === 'win32' ? '//./pipe/docker_engine' : '/var/run/docker.sock';
}

async function runDoctorCommand(
  runner: DockerDoctorEngineApiRunner,
  command: string,
  args: string[],
): Promise<DockerDoctorCommandRecord> {
  try {
    const output = await runner();

    return {
      command,
      args,
      ok: true,
      stdout: output.stdout,
      stderr: output.stderr,
      errorMessage: null,
    };
  } catch (error) {
    return {
      command,
      args,
      ok: false,
      stdout: '',
      stderr: '',
      errorMessage: getErrorMessage(error),
    };
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
