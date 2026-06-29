import { stdin as input, stdout as output } from 'node:process';
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
import { clearManagedStateAfterDestroyAll, loadState, saveStateOperationRecord, saveVerifiedRuntimeSnapshot } from '../state/sqlite-state-store.js';
import { StatusService } from '../status/status-service.js';
import { registerPlanCommand } from './plan-command.js';
import {
  collectDestroyAllTargets,
  createDockerMcpGatewayFromEnv,
  createProgressPrinter,
  getErrorMessage,
  isMissingDockerResourceError,
  isCommanderDisplayExitError,
  isCommanderExcessArgumentsError,
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

    const report = await runDockerDoctor();
    printDockerDoctorReport(report);

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
    const state = await loadState();
    const mcpClient = createDockerMcpGatewayFromEnv();
    try {
      await mcpClient.initialize();
      const actual = await mcpClient.observeActualState();
      const targets = collectDestroyAllTargets(state, actual, Boolean(options.removeVolumes));

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
        summary: `Destroy-all removed ${removed.containers.length} container(s), ${removed.networks.length} network(s), and ${removed.volumes.length} volume(s). Current and pending SQLite snapshots were cleared.`,
      });
      console.log(chalk.green('SQLite state updated: current and pending preview cleared.'));
    } catch (error) {
      console.log(chalk.red('Destroy-all failed:'));
      console.log('- ' + getErrorMessage(error));
      process.exitCode = 1;
    } finally {
      await mcpClient.shutdown();
    }
  });

program
  .command('status')
  .description('Show the current desired/actual infrastructure snapshot')
  .option('--drift', 'Also detect live drift against Docker runtime via MCP', false)
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
    const state = await loadState();
    const engine = new ExecutionEngine({
      dockerPullRetry: loadDockerPullRetryPolicyFromEnv(),
    });
    const status = await new StatusService().showStatus();
    reportProgress({
      phase: 'execution',
      message: 'observe... status snapshot loaded.',
    });
    console.log(status);
    if (options.drift) {
      if (!state || !state.current) {
        console.log(chalk.yellow('No current verified runtime snapshot; cannot detect drift.'));
        return;
      }
      const project = state.current.desired.projectName;
      const mcpClient = createDockerMcpGatewayFromEnv();
      try {
        await mcpClient.initialize();
        const { drift, actual } = await engine.detectRuntimeDrift(state.current, mcpClient);
        console.log(chalk.cyan('Live drift:'));
        console.log('- ' + drift.summary);
        for (const finding of drift.findings) {
          console.log('  - [' + finding.severity + '] ' + finding.message);
        }

        if (drift.status === 'none') {
          const resourceRefs = buildResourceRefs(project, actual, state.current.desired);
          await saveVerifiedRuntimeSnapshot({
            sourceSnapshot: state.current,
            actual,
            verificationReport: {
              status: 'passed',
              scope: 'tool-runtime',
              checkedAt: drift.checkedAt,
              issues: [],
              evidence: ['Drift check observed Docker runtime via MCP list+inspect.'],
              errorReason: null,
              revisionHint: null,
              confidence: 0.95,
            },
            operation: 'sync',
            resourceRefs,
            driftReport: drift,
          });
          console.log(chalk.green('Saved live actual state and drift report to SQLite.'));
          console.log(chalk.green('No drift detected; nothing to fix.'));
          return;
        }

        const plan = buildRepairPlan(drift);
        const safeActions = plan.actions.filter((a) => a.risk === 'safe');
        const riskyActions = plan.actions.filter((a) => a.risk === 'approval-required');
        console.log(chalk.cyan('Repair plan preview:'));
        console.log('- Total actions: ' + String(plan.actions.length));
        console.log('- Safe actions: ' + String(safeActions.length));
        console.log('- Approval-required: ' + String(riskyActions.length));
        for (const action of plan.actions) {
          console.log('  - [' + action.risk + '] ' + action.kind + ' ' + action.resourceName);
        }

        const readline = createInterface({ input, output });
        let choice = 'n';
        try {
          const answer = (await readline.question(chalk.yellow('Drift detected. Apply repair (y), skip (n), or sync runtime as truth (s)? [y/n/s] '))).trim().toLowerCase();
          choice = answer === 'y' || answer === 'yes' ? 'y' : answer === 's' || answer === 'sync' ? 's' : 'n';
        } finally {
          readline.close();
        }

        if (choice === 'n') {
          console.log(chalk.yellow('No action taken. No Docker mutation was performed. SQLite unchanged.'));
          return;
        }

        if (choice === 's') {
          console.log(chalk.cyan('Current runtime configuration:'));
          console.log(chalk.green('Containers:'));
          for (const c of actual.containers) {
            console.log('  - ' + c.name + ' | image=' + (c.image ?? 'unknown') + ' | status=' + (c.status ?? 'unknown') + ' | ports=' + (c.ports.join(',') || 'none'));
          }
          if (actual.containers.length === 0) console.log('  (none)');
          console.log(chalk.green('Networks:'));
          for (const n of actual.networks) { console.log('  - ' + n.name); }
          if (actual.networks.length === 0) console.log('  (none)');
          console.log(chalk.green('Volumes:'));
          for (const v of actual.volumes) { console.log('  - ' + v.name); }
          if (actual.volumes.length === 0) console.log('  (none)');
          console.log(chalk.green('Images:'));
          for (const i of actual.images) { console.log('  - ' + i.reference); }
          if (actual.images.length === 0) console.log('  (none)');
          const syncedSpec = deriveSpecFromRuntime(actual, state.current.desired);
          console.log(chalk.cyan('Synced desired spec (runtime as truth):'));
          console.log('- Services: ' + syncedSpec.services.map((s) => s.name + ' (' + s.image + ')').join(', '));
          console.log('- Networks: ' + (syncedSpec.networks.join(', ') || 'none'));
          console.log('- Volumes: ' + (syncedSpec.volumes.join(', ') || 'none'));
          const driftAfterSync = buildDriftReport(syncedSpec, actual);
          try {
            const resourceRefs = buildResourceRefs(project, actual, state.current.desired);
            await saveVerifiedRuntimeSnapshot({ sourceSnapshot: state.current, desired: syncedSpec, actual, verificationReport: { status: 'passed', scope: 'tool-runtime', checkedAt: new Date().toISOString(), issues: [], evidence: ['Runtime accepted as truth via sync from status --drift.'], errorReason: null, revisionHint: null, confidence: 0.95 }, operation: 'sync', resourceRefs, driftReport: driftAfterSync });
            console.log(chalk.green('Synced verified runtime state to SQLite (runtime as truth).'));
            console.log(chalk.cyan('Post-sync drift:'));
            console.log('- ' + driftAfterSync.summary);
            await saveStateOperationRecord({ type: 'verified-runtime-saved', projectName: project, request: state.current.request, summary: 'Runtime synced as truth from status --drift. Desired spec updated to match runtime.' });
          } catch (syncError) {
            console.log(chalk.red('Sync failed: derived spec from runtime was rejected by validation.'));
            console.log('- ' + getErrorMessage(syncError));
            await saveStateOperationRecord({ type: 'drift-observed', projectName: project, request: state.current.request, summary: 'Sync aborted: ' + getErrorMessage(syncError) });
          }
          return;
        }

        const { report, actual: actualAfterRepair } = await engine.repairWithDocker(state.current, mcpClient, plan.actions);
        console.log(chalk.cyan('Repair report:'));
        console.log('- Status: ' + report.status);
        console.log('- Actions attempted: ' + String(report.actionsAttempted.length));
        console.log('- Actions succeeded: ' + String(report.actionsSucceeded.length));
        console.log('- Actions failed: ' + String(report.actionsFailed.length));
        for (const failure of report.actionsFailed) {
          console.log('  - ' + failure.action.kind + ' ' + failure.action.resourceName + ': ' + failure.error);
        }

        const driftAfterRepair = buildDriftReport(state.current.desired, actualAfterRepair);
        console.log(chalk.cyan('Post-repair drift:'));
        console.log('- ' + driftAfterRepair.summary);

        if (report.status === 'applied' && driftAfterRepair.status === 'none') {
          const resourceRefs = buildResourceRefs(project, actualAfterRepair, state.current.desired);
          await saveVerifiedRuntimeSnapshot({ sourceSnapshot: state.current, actual: actualAfterRepair, verificationReport: { status: 'passed', scope: 'tool-runtime', checkedAt: new Date().toISOString(), issues: [], evidence: ['Repair applied successfully from status --drift. Drift resolved.'], errorReason: null, revisionHint: null, confidence: 0.95 }, operation: 'repair', resourceRefs, driftReport: driftAfterRepair, repairReport: report });
          console.log(chalk.green('Saved verified runtime state to SQLite after repair.'));
          await saveStateOperationRecord({ type: 'verified-runtime-saved', projectName: project, request: state.current.request, summary: 'Drift repaired from status --drift and verified runtime state synced to SQLite.' });
        } else {
          console.log(chalk.yellow('Repair incomplete or drift remains; current state was not saved as healed.'));
          await saveStateOperationRecord({ type: 'drift-observed', projectName: project, request: state.current.request, summary: 'Repair ' + report.status + ' from status --drift. Remaining drift: ' + driftAfterRepair.summary });
        }
      } catch (error) {
        console.log(chalk.red('Drift detection failed:'));
        console.log('- ' + getErrorMessage(error));
        process.exitCode = 1;
      } finally {
        await mcpClient.shutdown();
      }
    }
  });

program
  .command('destroy')
  .description('Destroy Docker resources belonging to the current verified project via MCP')
  .option('--project <name>', 'Project name override (defaults to current verified state)')
  .option('--remove-volumes', 'Also remove project volumes', false)
  .option('--yes', 'Skip interactive approval', false)
  .action(async (options) => {
    const state = await loadState();
    const engine = new ExecutionEngine({
      dockerPullRetry: loadDockerPullRetryPolicyFromEnv(),
    });
    if (!state || !state.current) {
      console.log(chalk.red('No current verified runtime snapshot found. Run a deploy first.'));
      process.exitCode = 1;
      return;
    }
    const project = options.project ?? state.current.desired.projectName;
    const expectedContainers = state.current.desired.services.flatMap((service) =>
      toReplicaContainerNames(project, service),
    );
    const expectedNetworks = new Set(state.current.desired.networks);
    const expectedVolumes = new Set(state.current.desired.volumes);
    const previewContainers = (state.current.resourceRefs?.containers ?? expectedContainers)
      .filter((name) => name.startsWith(project + '-') || expectedContainers.includes(name));
    const previewNetworks = (state.current.resourceRefs?.networks ?? state.current.desired.networks)
      .filter((name) => !isProtectedDockerNetwork(name) && (name.startsWith(project + '-') || expectedNetworks.has(name)));
    const previewVolumes = (state.current.resourceRefs?.volumes ?? state.current.desired.volumes)
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
          return;
        }
      } finally { readline.close(); }
    }
      const mcpClient = createDockerMcpGatewayFromEnv();
    try {
      await mcpClient.initialize();
      const result = await engine.destroyWithDocker(state.current, mcpClient, { projectName: project, removeVolumes: Boolean(options.removeVolumes) });
      console.log(chalk.green('Destroy completed via MCP.'));
      console.log('- Containers removed: ' + (result.containersRemoved.join(', ') || 'none'));
      console.log('- Networks removed: ' + (result.networksRemoved.join(', ') || 'none'));
      console.log('- Volumes removed: ' + (result.volumesRemoved.join(', ') || 'none'));


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
        const resourceRefs = buildResourceRefs(project, result.actual, state.current.desired);
        await saveVerifiedRuntimeSnapshot({
          sourceSnapshot: state.current,
          actual: result.actual,
          verificationReport: result.verificationReport,
          operation: 'destroy',
          resourceRefs,
        });
        console.log(chalk.green('Saved verified runtime state to SQLite after destroy.'));
      } else {
        console.log(chalk.yellow('Destroy verification did not pass; current state was not saved as destroyed.'));
      }
    } catch (error) {
      console.log(chalk.red('Destroy failed:'));
      console.log('- ' + getErrorMessage(error));
      process.exitCode = 1;
    } finally {
      await mcpClient.shutdown();
    }
  });
program
.command('repair')
.description('Detect drift, preview repair plan, get approval, then apply repair via MCP')
.option('--approve-risky', 'Include approval-required repair actions in the approval request', false)
.action(async (options) => {
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
  const mcpClient = createDockerMcpGatewayFromEnv();
  try {
    await mcpClient.initialize();
    const { drift } = await engine.detectRuntimeDrift(state.current, mcpClient);
    console.log(chalk.cyan('Drift report for project "' + project + '":'));
    console.log('- ' + drift.summary);
    for (const finding of drift.findings) { console.log('  - [' + finding.severity + '] ' + finding.message); }
    if (drift.status === 'none') { console.log(chalk.green('No drift detected; nothing to repair.')); return; }
    const plan = buildRepairPlan(drift);
    const actionsToApply = plan.actions.filter((a) => a.risk !== 'approval-required' || options.approveRisky);
    console.log(chalk.cyan('Repair plan preview:'));
    console.log('- Total actions: ' + String(plan.actions.length));
    console.log('- Safe actions: ' + String(plan.actions.filter((a) => a.risk === 'safe').length));
    console.log('- Approval-required: ' + String(plan.actions.filter((a) => a.risk === 'approval-required').length));
    console.log('- Actions to apply: ' + String(actionsToApply.length));
    for (const action of actionsToApply) { console.log('  - [' + action.risk + '] ' + action.kind + ' ' + action.resourceName); }
    if (actionsToApply.length === 0) { console.log(chalk.yellow('No repair actions to apply after filtering. Use --approve-risky to include approval-required actions.')); return; }
    const readline = createInterface({ input, output });
    let approved = false;
    try {
      const answer = (await readline.question(chalk.yellow('Approve applying these repair actions? (y/N) '))).trim().toLowerCase();
      approved = answer === 'y' || answer === 'yes';
    } finally { readline.close(); }
    if (!approved) {
      console.log(chalk.yellow('Repair rejected. No Docker mutation was performed.'));
      await saveStateOperationRecord({ type: 'repair-rejected', projectName: project, request: state.current.request, summary: 'Repair rejected by user. Drift detected: ' + drift.summary });
      return;
    }
    const { report, actual: actualAfterRepair } = await engine.repairWithDocker(state.current, mcpClient, actionsToApply);
    console.log(chalk.cyan('Repair report:'));
    console.log('- Status: ' + report.status);
    console.log('- Actions attempted: ' + String(report.actionsAttempted.length));
    console.log('- Actions succeeded: ' + String(report.actionsSucceeded.length));
    console.log('- Actions failed: ' + String(report.actionsFailed.length));
    for (const failure of report.actionsFailed) { console.log('  - ' + failure.action.kind + ' ' + failure.action.resourceName + ': ' + failure.error); }
    const driftAfterRepair = buildDriftReport(state.current.desired, actualAfterRepair);
    console.log(chalk.cyan('Post-repair drift:'));
    console.log('- ' + driftAfterRepair.summary);
    if (report.status === 'applied' && driftAfterRepair.status === 'none') {
      const resourceRefs = buildResourceRefs(project, actualAfterRepair, state.current.desired);
      await saveVerifiedRuntimeSnapshot({ sourceSnapshot: state.current, actual: actualAfterRepair, verificationReport: { status: 'passed', scope: 'tool-runtime', checkedAt: new Date().toISOString(), issues: [], evidence: ['Repair applied successfully. Drift resolved.'], errorReason: null, revisionHint: null, confidence: 0.95 }, operation: 'repair', resourceRefs, driftReport: driftAfterRepair, repairReport: report });
      console.log(chalk.green('Saved verified runtime state to SQLite after repair.'));
    } else {
      console.log(chalk.yellow('Repair incomplete or drift remains; current state was not saved as healed.'));
      await saveStateOperationRecord({ type: 'drift-observed', projectName: project, request: state.current.request, summary: 'Repair ' + report.status + '. Remaining drift: ' + driftAfterRepair.summary });
    }
  } catch (error) {
    console.log(chalk.red('Repair failed:'));
    console.log('- ' + getErrorMessage(error));
    process.exitCode = 1;
  } finally {
    await mcpClient.shutdown();
  }
});
program.parseAsync(process.argv).catch((error: unknown) => {
  if (isCommanderDisplayExitError(error)) {
    return;
  }

  if (isCommanderExcessArgumentsError(error)) {
    console.error(chalk.red('CLI failed.'));
    console.error(
      'The plan command accepts exactly one prompt string. Put the full request inside quotes.',
    );
    console.error(chalk.cyan('Example: aiagent plan "Tao nginx port 80"'));
    process.exitCode = 1;
    return;
  }

  console.error(chalk.red('CLI failed.'));
  if (error instanceof Error) {
    console.error(error.message);
  }
  process.exitCode = 1;
});
