import { execFile } from 'node:child_process';

export interface DockerDoctorCommandOutput {
  stdout: string;
  stderr: string;
}

export type DockerDoctorCommandRunner = (
  command: string,
  args: string[],
) => Promise<DockerDoctorCommandOutput>;

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
  runner: DockerDoctorCommandRunner = defaultDockerDoctorCommandRunner,
  checkedAt = new Date().toISOString(),
): Promise<DockerDoctorReport> {
  const commands: DockerDoctorCommandRecord[] = [];
  const issues: string[] = [];
  const evidence: string[] = [
    'Docker doctor is read-only and does not call docker run, pull, compose, create, start, stop, or remove.',
  ];
  const cliCheck = await runDoctorCommand(runner, 'docker', ['--version']);
  commands.push(cliCheck);

  if (!cliCheck.ok) {
    issues.push('Docker CLI was not found or could not be executed.');

    return {
      status: 'failed',
      checkedAt,
      dockerCliFound: false,
      engineReachable: false,
      commands,
      issues,
      evidence,
    };
  }

  evidence.push('Docker CLI responded to docker --version.');

  const engineCheck = await runDoctorCommand(runner, 'docker', ['version']);
  commands.push(engineCheck);

  if (!engineCheck.ok) {
    issues.push('Docker Desktop engine is not reachable via read-only docker version.');
  } else {
    evidence.push('Docker Desktop engine responded to read-only docker version.');
  }

  return {
    status: issues.length ? 'failed' : 'passed',
    checkedAt,
    dockerCliFound: true,
    engineReachable: engineCheck.ok,
    commands,
    issues,
    evidence,
  };
}

export function defaultDockerDoctorCommandRunner(
  command: string,
  args: string[],
): Promise<DockerDoctorCommandOutput> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        timeout: 10_000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }

        resolve({
          stdout,
          stderr,
        });
      },
    );
  });
}

async function runDoctorCommand(
  runner: DockerDoctorCommandRunner,
  command: string,
  args: string[],
): Promise<DockerDoctorCommandRecord> {
  try {
    const output = await runner(command, args);

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
