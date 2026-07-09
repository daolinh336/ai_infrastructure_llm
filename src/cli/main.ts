import { stdin as input, stdout as output } from 'node:process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Command } from 'commander';
import chalk from 'chalk';
import { buildResourceRefs } from '../agent/standard-verifier-agent.js';
import { runDockerDoctor } from '../doctor/docker-doctor.js';
import { buildDriftReport } from '../execution/drift-detector.js';
import { ExecutionEngine } from '../execution/execution-engine.js';
import { buildRepairPlan } from '../execution/repair-planner.js';
import { deriveSpecFromRuntime } from '../execution/spec-sync.js';
import { isProtectedDockerNetwork } from '../execution/protected-docker-resources.js';
import { toReplicaContainerNames } from '../execution/container-names.js';
import { normalizeProjectName } from '../domain/project-identity.js';
import { clearManagedProjectState, clearManagedStateAfterDestroyAll, listProjectStates, loadProjectState, loadState, saveVerifiedRuntimeSnapshot } from '../state/sqlite-state-store.js';
import { StatusService, formatDriftStatusSummary, formatStatusSnapshots } from '../status/status-service.js';
import { registerPlanCommand } from './plan-command.js';
import { finishOperationMetrics, startOperationMetrics } from '../metrics/metrics.js';
import type { DriftReport, InfrastructureStateSnapshot, RepairPlan, RuntimeActualState, VerifiedRuntimeSnapshot } from '../domain/types.js';
import {
  collectDestroyAllTargets,
  createDockerMcpGatewayFromEnv,
  createProgressPrinter,
  getErrorMessage,
  isMissingDockerResourceError,
  isCommanderDisplayExitError,
  loadDockerPullRetryPolicyFromEnv,
  loadLocalEnvFile,
  printDockerDoctorReport,
} from './shared.js';

loadLocalEnvFile();

const program = new Command();

program
  .name('infra-react-agent')
  .description('Natural-language infrastructure management CLI with a ReAct-style agent')
  .version('0.1.0')
  .exitOverride();
registerPlanCommand(program);
program
  .command('doctor')
  .description('Run read-only setup checks')
  .option('--docker', 'Check Docker CLI and Docker Desktop engine reachability read-only', false)
  .action(async (options) => {
    if (!options.docker) {
      console.log(chalk.yellow('No doctor check selected. Use doctor --docker.'));
      return;
    }

    const doctorMetrics = startOperationMetrics({
      operationType: 'doctor',
      provider: process.env.INFRA_AGENT_PROVIDER ?? null,
    });
    const report = await runDockerDoctor();
    printDockerDoctorReport(report);
    await finishOperationMetrics(doctorMetrics, { success: report.status !== 'failed', errorMessage: report.status === 'failed' ? report.issues.join('; ') : null });

    if (report.status === 'failed') {
      process.exitCode = 1;
    }
  });

program
  .command('observe')
  .description('Observe current Docker runtime state using MCP')
  .action(async () => {
    const mcpClient = createDockerMcpGatewayFromEnv();
    try {
      await mcpClient.initialize();
      const containers = await mcpClient.listContainers(true);
      const networks = await mcpClient.listNetworks();
      const volumes = await mcpClient.listVolumes();
      const images = await mcpClient.listImages();

      console.log(chalk.cyan('Docker runtime state:'));
      console.log(chalk.green('Containers:'));
      for (const c of containers) {
        console.log('  ' + c.name + ' (' + (c.image ?? 'unknown') + ', ' + (c.status ?? 'unknown') + ')');
      }
      if (containers.length === 0) console.log('  (none)');

      console.log(chalk.green('Networks:'));
      for (const n of networks) {
        console.log('  ' + n.name + ' (' + (n.status ?? 'unknown') + ')');
      }
      if (networks.length === 0) console.log('  (none)');

      console.log(chalk.green('Volumes:'));
      for (const v of volumes) {
        console.log('  ' + v.name + ' (' + (v.status ?? 'unknown') + ')');
      }
      if (volumes.length === 0) console.log('  (none)');

      console.log(chalk.green('Images:'));
      for (const i of images) {
        console.log('  ' + i.reference + ' (' + (i.id ?? 'no-id') + ')');
      }
      if (images.length === 0) console.log('  (none)');
    } catch (error) {
      console.log(chalk.red('Observe failed:'));
      console.log('- ' + getErrorMessage(error));
      process.exitCode = 1;
    } finally {
      await mcpClient.shutdown();
    }
  });

program
  .command('destroy-all')
  .alias('destroy-all-infra')
  .description('Destroy every Docker resource created by this tool after strict user verification')
  .option('--remove-volumes', 'Also remove volumes referenced by saved tool state', false)
  .option('--yes', 'Skip interactive approval by typing the verification phrase automatically', false)
  .action(async (options) => {
    const destroyAllMetrics = startOperationMetrics({
      operationType: 'destroy-all',
      provider: process.env.INFRA_AGENT_PROVIDER ?? null,
    });
    const state = await loadState();
    const projectStates = await listProjectStates();
    const mcpClient = createDockerMcpGatewayFromEnv();
    try {
      await mcpClient.initialize();
      const actual = await mcpClient.observeActualState();
      const targets = collectDestroyAllTargets(state, projectStates, actual, Boolean(options.removeVolumes));

      console.log(chalk.red('Destroy all preview for infrastructure managed by this tool:'));
      console.log('- Projects: ' + (targets.projects.join(', ') || 'none'));
      console.log('- Containers: ' + (targets.containers.join(', ') || 'none'));
      console.log('- Networks: ' + (targets.networks.join(', ') || 'none'));
      console.log('- Volumes: ' + (targets.volumes.join(', ') || (options.removeVolumes ? 'none' : 'preserved; use --remove-volumes')));
      console.log('- Images: preserved');
      console.log(chalk.yellow('Targets are limited to resources from saved state'));

      const totalTargets = targets.containers.length + targets.networks.length + targets.volumes.length;
      if (totalTargets === 0) {
        console.log(chalk.green('No managed Docker resources found to destroy.'));
        await finishOperationMetrics(destroyAllMetrics, { success: true });
        return;
      }

      const verificationPhrase = `destroy all ${targets.projects.join(',') || 'managed-infra'}`;
      if (!options.yes) {
        const readline = createInterface({ input, output });
        try {
          console.log(chalk.red('Carefully verify the resources above before continuing.'));
          const answer = (await readline.question(chalk.yellow(`Type exactly "${verificationPhrase}" to continue: `))).trim();
          if (answer !== verificationPhrase) {
            console.log(chalk.yellow('Destroy-all rejected. No Docker mutation performed.'));
            await finishOperationMetrics(destroyAllMetrics, { success: true, errorMessage: 'destroy-all rejected' });
            return;
          }
        } finally {
          readline.close();
        }
      }

      mcpClient.setAllowMutations(true);
      const removed = { containers: [] as string[], networks: [] as string[], volumes: [] as string[] };
      const warnings: Array<{ resource: string; message: string }> = [];
      const failed: Array<{ resource: string; error: string }> = [];
      try {
        for (const container of targets.containers) {
          try {
            await mcpClient.stopContainer(container);
            await mcpClient.removeContainer(container);
            removed.containers.push(container);
          } catch (error) {
            if (isMissingDockerResourceError(error)) {
              warnings.push({ resource: 'container:' + container, message: 'already absent' });
            } else {
              failed.push({ resource: 'container:' + container, error: getErrorMessage(error) });
            }
          }
        }
        for (const network of targets.networks) {
          try {
            await mcpClient.removeNetwork(network);
            removed.networks.push(network);
          } catch (error) {
            if (isMissingDockerResourceError(error)) {
              warnings.push({ resource: 'network:' + network, message: 'already absent' });
            } else {
              failed.push({ resource: 'network:' + network, error: getErrorMessage(error) });
            }
          }
        }
        for (const volume of targets.volumes) {
          try {
            await mcpClient.removeVolume(volume);
            removed.volumes.push(volume);
          } catch (error) {
            if (isMissingDockerResourceError(error)) {
              warnings.push({ resource: 'volume:' + volume, message: 'already absent' });
            } else {
              failed.push({ resource: 'volume:' + volume, error: getErrorMessage(error) });
            }
          }
        }
      } finally {
        mcpClient.setAllowMutations(false);
      }

      console.log(chalk.green('Destroy-all completed.'));
      console.log('- Containers removed: ' + (removed.containers.join(', ') || 'none'));
      console.log('- Networks removed: ' + (removed.networks.join(', ') || 'none'));
      console.log('- Volumes removed: ' + (removed.volumes.join(', ') || 'none'));
      if (warnings.length > 0) {
        console.log(chalk.yellow('Warnings:'));
        for (const entry of warnings) {
          console.log(`  - ${entry.resource}: ${entry.message}`);
        }
      }
      if (failed.length > 0) {
        console.log(chalk.yellow('Failures:'));
        for (const entry of failed) {
          console.log(`  - ${entry.resource}: ${entry.error}`);
        }
        process.exitCode = 1;
      }
      const stateProjectName = state?.current?.desired.projectName ?? targets.projects[0] ?? 'managed-infra';
      await clearManagedStateAfterDestroyAll({
        projectName: stateProjectName,
        request: state?.current?.request ?? null,
        summary: `Destroy-all removed ${removed.containers.length} container(s), ${removed.networks.length} network(s), and ${removed.volumes.length} volume(s). Verified SQLite snapshots were cleared.`,
      });
      console.log(chalk.green('SQLite state updated: verified snapshots cleared.'));
      await finishOperationMetrics(destroyAllMetrics, { success: failed.length === 0, errorMessage: failed.length === 0 ? null : failed.map((entry) => entry.error).join('; ') });
    } catch (error) {
      console.log(chalk.red('Destroy-all failed:'));
      console.log('- ' + getErrorMessage(error));
      process.exitCode = 1;
      await finishOperationMetrics(destroyAllMetrics, { success: false, errorMessage: getErrorMessage(error) });
    } finally {
      await mcpClient.shutdown();
    }
  });

program
  .command('status')
  .description('Show verified infrastructure snapshot(s)')
  .option('--drift', 'Also detect live drift against Docker runtime via MCP', false)
  .option('--repair', 'After drift detection, preview repair and ask yes/no/sync', false)
  .option('--prjName <name>', 'Only show status/drift for one verified project')
  .action(async (options) => {
    const reportProgress = createProgressPrinter();
    reportProgress({
      phase: 'cli',
      message: 'thinking... start status command.',
    });
    reportProgress({
      phase: 'execution',
      message: 'acting... load saved infrastructure snapshot.',
    });
    const requestedProjectName = options.prjName ? normalizeProjectName(String(options.prjName)) : null;
    const statusMetrics = startOperationMetrics({
      operationType: options.drift ? 'drift' : 'status',
      projectName: requestedProjectName,
      provider: process.env.INFRA_AGENT_PROVIDER ?? null,
    });
    let statusSuccess = true;
    let statusError: string | null = null;
    const selectedProjectState = requestedProjectName ? await loadProjectState(requestedProjectName) : null;
    const projectStates = requestedProjectName
      ? (selectedProjectState?.current ? [selectedProjectState] : [])
      : await listProjectStates();
    const engine = new ExecutionEngine({
      dockerPullRetry: loadDockerPullRetryPolicyFromEnv(),
    });
    reportProgress({
      phase: 'execution',
      message: 'observe... status snapshot loaded.',
    });
    if (options.repair && !options.drift) {
      console.log(chalk.yellow('Option --repair requires --drift. Example: aiagent status --drift --repair'));
      process.exitCode = 1;
      await finishOperationMetrics(statusMetrics, { success: false, errorMessage: 'Option --repair requires --drift' });
      return;
    }
    if (options.drift) {
      const projectsToCheck = requestedProjectName
        ? (() => {
            const target = projectStates.find((state) => state.current?.desired.projectName === requestedProjectName) ?? null;
            return target ? [target] : [];
          })()
        : projectStates.filter((state) => state.current);
      if (projectsToCheck.length === 0) {
        console.log(chalk.yellow(requestedProjectName
          ? 'No verified runtime snapshot found for project "' + requestedProjectName + '"; cannot detect drift.'
          : 'No verified runtime snapshot found; cannot detect drift.'));
        await finishOperationMetrics(statusMetrics, { success: true });
        return;
      }
      for (const projectState of projectsToCheck) {
        if (!projectState.current) continue;
        const project = projectState.current.desired.projectName;
        const mcpClient = createDockerMcpGatewayFromEnv();
        try {
          await mcpClient.initialize();
          const { drift, actual } = await engine.detectRuntimeDrift(projectState.current, mcpClient);
          if (options.repair && drift.status !== 'none') {
            const resolution = await promptAndApplyDriftResolution(projectState.current, mcpClient, engine, drift, actual);
            if (resolution) {
              const driftReportPath = await writeProjectDriftReport(
                project,
                resolution.state.current!,
                resolution.drift,
                resolution.actual,
              );
              console.log(formatDriftStatusSummary(resolution.state, resolution.drift, driftReportPath));
              continue;
            }
          }
          const renderedState = {
            ...projectState,
            current: {
              ...projectState.current,
              actual,
              driftReport: drift,
            },
          };
          const driftReportPath = await writeProjectDriftReport(project, projectState.current, drift, actual);
          console.log(formatStatusSnapshots([renderedState]));
          console.log(chalk.cyan('Live drift for project "' + project + '":'));
          console.log('- ' + drift.summary);
          console.log('- Report file: ' + driftReportPath);
        } catch (error) {
          console.log(chalk.red('Drift detection failed for project "' + project + '":'));
          console.log('- ' + getErrorMessage(error));
          process.exitCode = 1;
          statusSuccess = false;
          statusError = getErrorMessage(error);
        } finally {
          await mcpClient.shutdown();
        }
      }
      await finishOperationMetrics(statusMetrics, { success: statusSuccess, errorMessage: statusError });
      return;
    }
    const status = await new StatusService().showStatus(requestedProjectName);
    console.log(status);
    await finishOperationMetrics(statusMetrics, { success: true });
  });

program
  .command('destroy')
  .description('Destroy Docker resources belonging to the current verified project via MCP')
  .option('-p, --project <name>', 'Project name override (defaults to current verified state)')
  .option('--remove-volumes', 'Also remove project volumes', false)
  .option('--yes', 'Skip interactive approval', false)
  .action(async (options) => {
    const state = await loadState();
    const engine = new ExecutionEngine({
      dockerPullRetry: loadDockerPullRetryPolicyFromEnv(),
    });
    const project = options.project ?? state?.current?.desired.projectName;
    if (!project) {
      console.log(chalk.red('No current verified runtime snapshot found. Run a deploy first.'));
      process.exitCode = 1;
      return;
    }
    const destroyMetrics = startOperationMetrics({
      operationType: 'destroy',
      projectName: project,
      provider: process.env.INFRA_AGENT_PROVIDER ?? null,
    });
    const projectState = options.project ? await loadProjectState(project) : state;
    if (!projectState?.current) {
      console.log(chalk.red(`No verified managed state found for project "${project}".`));
      process.exitCode = 1;
      await finishOperationMetrics(destroyMetrics, { success: false, errorMessage: 'No verified managed state found' });
      return;
    }
    const destroySnapshot = projectState.current;
    const expectedContainers = destroySnapshot.desired.services.flatMap((service) =>
      toReplicaContainerNames(project, service),
    );
    const expectedNetworks = new Set(destroySnapshot.desired.networks);
    const expectedVolumes = new Set(destroySnapshot.desired.volumes);
    const previewContainers = (destroySnapshot.resourceRefs?.containers ?? expectedContainers)
      .filter((name) => name.startsWith(project + '-') || expectedContainers.includes(name));
    const previewNetworks = (destroySnapshot.resourceRefs?.networks ?? destroySnapshot.desired.networks)
      .filter((name) => !isProtectedDockerNetwork(name) && (name.startsWith(project + '-') || expectedNetworks.has(name)));
    const previewVolumes = (destroySnapshot.resourceRefs?.volumes ?? destroySnapshot.desired.volumes)
      .filter((name) => name.startsWith(project + '-') || expectedVolumes.has(name));
    console.log(chalk.cyan('Destroy preview for project "' + project + '":'));
    console.log('- Containers: ' + (previewContainers.join(', ') || 'none'));
    console.log('- Networks: ' + (previewNetworks.join(', ') || 'none'));
    if (options.removeVolumes) console.log('- Volumes: ' + (previewVolumes.join(', ') || 'none'));
    console.log('- Images: preserved');
    if (!options.yes) {
      const readline = createInterface({ input, output });
      try {
        const answer = (await readline.question(chalk.yellow('Approve destroying these resources? (y/N) '))).trim().toLowerCase();
        if (answer !== 'y' && answer !== 'yes') {
          console.log(chalk.yellow('Destroy rejected. No Docker mutation performed.'));
          await finishOperationMetrics(destroyMetrics, { success: true });
          return;
        }
      } finally { readline.close(); }
    }
      const mcpClient = createDockerMcpGatewayFromEnv();
    try {
      await mcpClient.initialize();
      const result = await engine.destroyWithDocker(destroySnapshot, mcpClient, { projectName: project, removeVolumes: Boolean(options.removeVolumes) });
      console.log(result.removalErrors.length === 0 ? chalk.green('Destroy completed via MCP.') : chalk.yellow('Destroy partially completed via MCP.'));
      console.log('- Containers removed: ' + (result.containersRemoved.join(', ') || 'none'));
      console.log('- Networks removed: ' + (result.networksRemoved.join(', ') || 'none'));
      console.log('- Volumes removed: ' + (result.volumesRemoved.join(', ') || 'none'));
      if (result.removalErrors.length > 0) {
        console.log(chalk.yellow('- Resources not removed:'));
        for (const issue of result.removalErrors) {
          console.log('  - ' + issue);
        }
      }


      // Post-destroy: verify and persist state
      console.log(chalk.cyan('Post-destroy verification:'));
      console.log('- Status: ' + result.verificationReport.status);
      if (result.verificationReport.issues.length > 0) {
        for (const issue of result.verificationReport.issues) {
          console.log('  - ' + issue);
        }
      }
      if (result.verificationReport.evidence.length > 0) {
        for (const item of result.verificationReport.evidence) {
          console.log('  - ' + item);
        }
      }

      if (result.verificationReport.status === 'passed') {
        await clearManagedProjectState({
          projectName: project,
          request: destroySnapshot.request,
          summary: `Destroy completed for project "${project}"; managed SQLite state was cleared.`,
        });
        console.log(chalk.green('SQLite state cleared for destroyed project.'));
      } else {
        await clearManagedProjectState({
          projectName: project,
          request: destroySnapshot.request,
          summary: `Destroy verification failed for project "${project}"; managed SQLite state was cleared by user policy. Issues: ${result.verificationReport.issues.join('; ')}`,
        });
        console.log(chalk.yellow('Destroy verification did not pass; managed SQLite state for this project was cleared.'));
      }
      await finishOperationMetrics(destroyMetrics, { success: result.verificationReport.status === 'passed', errorMessage: result.verificationReport.status === 'passed' ? null : result.verificationReport.issues.join('; ') });
    } catch (error) {
      console.log(chalk.red('Destroy failed:'));
      console.log('- ' + getErrorMessage(error));
      process.exitCode = 1;
      await finishOperationMetrics(destroyMetrics, { success: false, errorMessage: getErrorMessage(error) });
    } finally {
      await mcpClient.shutdown();
    }
  });
program
.command('repair')
.description('Detect drift, preview repair plan, get approval, then deploy repair via MCP')
.action(async () => {
  const state = await loadState();
  const engine = new ExecutionEngine({
    dockerPullRetry: loadDockerPullRetryPolicyFromEnv(),
  });
  if (!state || !state.current) {
    console.log(chalk.red('No current verified runtime snapshot found. Run a deploy first.'));
    process.exitCode = 1;
    return;
  }
  const project = state.current.desired.projectName;
  const repairMetrics = startOperationMetrics({
    operationType: 'drift',
    projectName: project,
    provider: process.env.INFRA_AGENT_PROVIDER ?? null,
  });
  const mcpClient = createDockerMcpGatewayFromEnv();
  try {
    await mcpClient.initialize();
    const { drift, actual } = await engine.detectRuntimeDrift(state.current, mcpClient);
    console.log(chalk.cyan('Drift report for project "' + project + '":'));
    console.log('- ' + drift.summary);
    for (const finding of drift.findings) { console.log('  - [' + finding.severity + '] ' + finding.message); }
    const resolution = await promptAndApplyDriftResolution(state.current, mcpClient, engine, drift, actual);
    if (resolution) {
      const driftReportPath = await writeProjectDriftReport(
        project,
        resolution.state.current!,
        resolution.drift,
        resolution.actual,
      );
      console.log(formatDriftStatusSummary(resolution.state, resolution.drift, driftReportPath));
    }
    await finishOperationMetrics(repairMetrics, { success: true });
  } catch (error) {
    console.log(chalk.red('Repair failed:'));
    console.log('- ' + getErrorMessage(error));
    process.exitCode = 1;
    await finishOperationMetrics(repairMetrics, { success: false, errorMessage: getErrorMessage(error) });
  } finally {
    await mcpClient.shutdown();
  }
});

type DriftResolutionChoice = 'repair' | 'reject' | 'sync';

interface AppliedDriftResolution {
  state: InfrastructureStateSnapshot;
  drift: DriftReport;
  actual: RuntimeActualState;
}

async function promptAndApplyDriftResolution(
  snapshot: VerifiedRuntimeSnapshot,
  mcpClient: ReturnType<typeof createDockerMcpGatewayFromEnv>,
  engine: ExecutionEngine,
  drift: DriftReport,
  actual: RuntimeActualState,
): Promise<AppliedDriftResolution | null> {
  if (drift.status === 'none') {
    console.log(chalk.green('No drift detected; nothing to repair or sync.'));
    return null;
  }

  const plan = buildRepairPlan(drift);
  printRepairPlanPreview(plan);

  const choice = await requestDriftResolutionChoice(plan);
  if (choice === 'reject') {
    console.log(chalk.yellow('Repair rejected. No Docker mutation or SQLite sync was performed.'));
    return null;
  }

  if (choice === 'sync') {
    return syncSnapshotToRuntime(snapshot, actual, drift);
  }

  if (plan.actions.length === 0) {
    console.log(chalk.yellow('No repair actions to run. Use sync only if Docker runtime should become desired state.'));
    return null;
  }

  const project = snapshot.desired.projectName;
  const { report, actual: actualAfterRepair } = await engine.repairWithDocker(snapshot, mcpClient, plan.actions);
  const driftAfterRepair = buildDriftReport(snapshot.desired, actualAfterRepair);
  if (report.status === 'applied' && driftAfterRepair.status === 'none') {
    const resourceRefs = buildResourceRefs(project, actualAfterRepair, snapshot.desired);
    const savedState = await saveVerifiedRuntimeSnapshot({
      sourceSnapshot: snapshot,
      actual: actualAfterRepair,
      verificationReport: {
        status: 'passed',
        scope: 'tool-runtime',
        checkedAt: new Date().toISOString(),
        issues: [],
        evidence: ['Repair applied successfully. Drift resolved.'],
        errorReason: null,
        revisionHint: null,
        confidence: 0.95,
      },
      operation: 'repair',
      resourceRefs,
      driftReport: driftAfterRepair,
      repairReport: report,
    });
    const state = (await loadProjectState(project)) ?? savedState;
    return { state, drift: driftAfterRepair, actual: actualAfterRepair };
  } else {
    console.log(chalk.cyan('Repair report:'));
    console.log('- Status: ' + report.status);
    console.log('- Actions attempted: ' + String(report.actionsAttempted.length));
    console.log('- Actions succeeded: ' + String(report.actionsSucceeded.length));
    console.log('- Actions failed: ' + String(report.actionsFailed.length));
    for (const failure of report.actionsFailed) {
      console.log('  - ' + failure.action.kind + ' ' + failure.action.resourceName + ': ' + failure.error);
    }
    console.log(chalk.cyan('Post-repair drift:'));
    console.log('- ' + driftAfterRepair.summary);
    console.log(chalk.yellow('Repair incomplete or drift remains; no SQLite state was changed.'));
    return null;
  }
}

function printRepairPlanPreview(plan: RepairPlan): void {
  console.log(chalk.cyan('Repair plan preview:'));
  console.log('- Total actions: ' + String(plan.actions.length));
  console.log('- Safe actions: ' + String(plan.actions.filter((a) => a.risk === 'safe').length));
  console.log('- Approval-required: ' + String(plan.actions.filter((a) => a.risk === 'approval-required').length));
  console.log('- Actions to run: ' + String(plan.actions.length));
  for (const action of plan.actions) {
    console.log('  - [' + action.risk + '] ' + action.kind + ' ' + action.resourceName);
  }
}

async function requestDriftResolutionChoice(plan: RepairPlan): Promise<DriftResolutionChoice> {
  const readline = createInterface({ input, output });
  try {
    while (true) {
      const answer = (await readline.question(
        chalk.yellow('Choose drift resolution: [y]es repair / [n]o / [s]ync Docker -> SQLite desired state '),
      )).trim().toLowerCase();
      if (answer === 'y' || answer === 'yes') {
        return 'repair';
      }
      if (answer === 'n' || answer === 'no' || answer.length === 0) {
        return 'reject';
      }
      if (answer === 's' || answer === 'sync') {
        return 'sync';
      }
      console.log(chalk.yellow('dont understand'));
      console.log(chalk.cyan('Choose y / n / sync.'));
      if (plan.actions.length === 0) {
        console.log(chalk.cyan('There are no repair actions; sync is the only state-changing option here.'));
      }
    }
  } finally {
    readline.close();
  }
}

async function syncSnapshotToRuntime(
  snapshot: VerifiedRuntimeSnapshot,
  actual: RuntimeActualState,
  _drift: DriftReport,
): Promise<AppliedDriftResolution | null> {
  const syncedDesired = deriveSpecFromRuntime(actual, snapshot.desired);
  const driftAfterSync = buildDriftReport(syncedDesired, actual);
  if (driftAfterSync.status !== 'none') {
    console.log(chalk.yellow('Sync could not fully reconcile desired state from runtime; no SQLite state was changed.'));
    console.log('- ' + driftAfterSync.summary);
    for (const finding of driftAfterSync.findings) {
      console.log('  - [' + finding.severity + '] ' + finding.message);
    }
    return null;
  }
  const resourceRefs = buildResourceRefs(snapshot.desired.projectName, actual, syncedDesired);
  const savedState = await saveVerifiedRuntimeSnapshot({
    sourceSnapshot: snapshot,
    desired: syncedDesired,
    actual,
    verificationReport: {
      status: 'passed',
      scope: 'tool-runtime',
      checkedAt: new Date().toISOString(),
      issues: [],
      evidence: [
        'User selected sync after drift detection.',
        'SQLite desired state was derived from observed Docker runtime.',
      ],
      errorReason: null,
      revisionHint: null,
      confidence: 0.9,
    },
    operation: 'sync',
    resourceRefs,
    driftReport: driftAfterSync,
    repairReport: null,
  });
  const state = (await loadProjectState(syncedDesired.projectName)) ?? savedState;
  return { state, drift: driftAfterSync, actual };
}

async function writeProjectDriftReport(
  projectName: string,
  snapshot: VerifiedRuntimeSnapshot,
  drift: DriftReport,
  actual: RuntimeActualState,
): Promise<string> {
  const reportsDir = path.resolve('state', 'reports');
  await mkdir(reportsDir, { recursive: true });
  const safeTimestamp = drift.checkedAt.replace(/[:.]/g, '-');
  const reportPath = path.join(reportsDir, `${projectName}-drift-${safeTimestamp}.md`);
  const desired = snapshot.desired;
  const lines = [
    `# Drift Report: ${projectName}`,
    '',
    `- Checked at: ${drift.checkedAt}`,
    `- Status: ${drift.status}`,
    `- Summary: ${drift.summary}`,
    `- SQLite snapshot: ${snapshot.id}`,
    '',
    '## Desired From SQLite',
    '',
    `- Project: ${desired.projectName}`,
    `- Services: ${desired.services.map((service) => `${service.name} x${service.replicas ?? 1}`).join(', ') || 'none'}`,
    `- Networks: ${desired.networks.join(', ') || 'none'}`,
    `- Volumes: ${desired.volumes.join(', ') || 'none'}`,
    '',
    '## Actual From Docker',
    '',
    `- Containers: ${actual.containers.map((container) => `${container.name} (${container.status ?? 'unknown'})`).join(', ') || 'none'}`,
    `- Networks: ${actual.networks.map((network) => network.name).join(', ') || 'none'}`,
    `- Volumes: ${actual.volumes.map((volume) => volume.name).join(', ') || 'none'}`,
    `- Images: ${actual.images.map((image) => image.reference).join(', ') || 'none'}`,
    '',
    '## Findings',
    '',
    ...(drift.findings.length > 0
      ? drift.findings.map((finding) => `- [${finding.severity}] ${finding.resourceType}/${finding.resourceName}: ${finding.message}`)
      : ['- none']),
    '',
  ];
  await writeFile(reportPath, lines.join('\n'), 'utf8');
  return reportPath;
}
program.parseAsync(process.argv).catch((error: unknown) => {
  if (isCommanderDisplayExitError(error)) {
    return;
  }

  if (isCommanderRuntimeError(error)) {
    process.exitCode = getCommanderExitCode(error);
    return;
  }

  console.error(chalk.red('CLI failed.'));
  if (error instanceof Error) {
    console.error(error.message);
  }
  process.exitCode = 1;
});

function isCommanderRuntimeError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('commander.')
  );
}

function getCommanderExitCode(error: unknown): number {
  if (error instanceof Error && 'exitCode' in error && typeof error.exitCode === 'number') {
    return error.exitCode;
  }
  return 1;
}
