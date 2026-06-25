#!/usr/bin/env node
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { Command } from 'commander';
import chalk from 'chalk';
import { ReActAgent } from './agent/react-agent.js';
import { cliInputSchema } from './domain/schemas.js';
import { runDockerDoctor, type DockerDoctorReport } from './doctor/docker-doctor.js';
import {
  ExecutionEngine,
  type ApplyPreparationResult,
} from './execution/execution-engine.js';
import { isSecretLikeKey, type SecretResolutionResult, type ResolvedSecret } from './compose/secret-resolver.js';
import { createApprovalResult } from './execution/phase8-approval.js';
import { DockerMcpGateway } from "./execution/docker-mcp-gateway.js";
import { loadState, saveVerifiedRuntimeSnapshot, saveStateOperationRecord } from "./state/sqlite-state-store.js";
import { buildResourceRefs } from "./agent/standard-verifier-agent.js";
import { buildDriftReport } from "./execution/drift-detector.js";
import { buildRepairPlan } from "./execution/repair-planner.js";
import { deriveSpecFromRuntime } from "./execution/spec-sync.js";
import { createProvider } from './llm/provider.js';
import { getStateDatabasePath } from './state/sqlite-state-store.js';
import { StaticGateway } from './static-gateway/static-gateway.js';
import { StatusService } from './status/status-service.js';
import type {
  ApprovalRequest,
  DetailedDryRunPreview,
  ExecutionScheduleStep,
  PreflightReport,
  ProgressEvent,
  ProgressPhase,
  StaticGatewayMetrics,
} from './domain/types.js';

loadLocalEnvFile();

const program = new Command();

program
  .name('infra-react-agent')
  .description('Natural-language infrastructure management CLI with a ReAct-style agent')
  .version('0.1.0')
  .exitOverride();
program
  .command('plan')
  .description('Analyze a natural-language infrastructure request and produce a plan')
  .argument(
    '<prompt>',
    'Quoted natural-language request describing the target infrastructure, e.g. "Tao nginx port 80"',
  )
  .option('--dry-run', 'Render outputs without writing state or deploying Docker', true)
  .option(
    '--apply',
    'Run Phase 8 preflight, request approval, then write docker-compose.yaml without Docker deployment',
    false,
  )
  .option('--save-state', 'Persist the desired state snapshot without deploying Docker', false)
  .option(
    '--deploy',
    'After approval, deploy to Docker via MCP (requires --apply)',
    false,
  )
  .option(
    '--provider <provider>',
    'LLM provider to use (stub|openai|gemini)',
    process.env.INFRA_AGENT_PROVIDER ?? 'stub',
  )
  .action(async (prompt, options) => {
    const reportProgress = createProgressPrinter();
    const applyRequested = Boolean(options.apply);
    const saveStateRequested = Boolean(options.saveState);
    const deployRequested = Boolean(options.deploy);
    const input = cliInputSchema.parse({
      prompt,
      dryRun: applyRequested || saveStateRequested ? false : options.dryRun ?? true,
      provider: options.provider,
    });

    reportProgress({
      phase: 'cli',
      message: `thinking... start plan command for provider "${input.provider}".`,
    });

    reportProgress({
      phase: 'cli',
      message: 'acting... create provider and static gateway.',
    });
    const provider = createProvider(input.provider);
    const gateway = new StaticGateway(provider, reportProgress);

    reportProgress({
      phase: 'static',
      message: 'acting... run pre-ReAct static gateway.',
    });
    const gatewayResult = await gateway.validate(input.prompt);

    console.log(chalk.cyan('Static validation:'));

    if (gatewayResult.status === 'rejected') {
      console.log(chalk.red(gatewayResult.reason));
      for (const issue of gatewayResult.issues) {
        console.log(`- ${issue}`);
      }
      console.log();
      printStaticGatewayMetrics(gatewayResult.metrics);
      process.exitCode = 1;
      return;
    }

    if (gatewayResult.status === 'clarification') {
      console.log(chalk.yellow('Clarification required before ReAct starts.'));
      console.log(gatewayResult.question);
      console.log();
      printStaticGatewayMetrics(gatewayResult.metrics);
      return;
    }

    console.log(chalk.green('ValidatedQuery ready. ReAct Agent may start.'));
    printStaticGatewayMetrics(gatewayResult.metrics);
    console.log();

    reportProgress({
      phase: 'plan',
      message: 'thinking... create ReAct Agent and begin planning loop.',
    });
    const dockerMcpOpts = deployRequested ? new DockerMcpGateway() : undefined;
    const agent = new ReActAgent(provider, reportProgress, {}, undefined, undefined, dockerMcpOpts, { logEnabled: true });
    const engine = new ExecutionEngine();
    const result = await agent.run(gatewayResult.validatedQuery);

    if (result.status === 'clarification') {
      console.log(chalk.yellow('Clarification required by ReAct Agent.'));
      console.log(result.clarificationQuestion);
      console.log();
      if (result.guardTelemetry) {
        printGuardTelemetry(result.guardTelemetry);
        console.log();
      }
      printObservations(result.observations);
      printTrace(result.trace);
      return;
    }

    if (result.status === 'blocked') {
      console.log(chalk.red('ReAct Agent blocked by loop guard.'));
      console.log(`- Reason: ${result.blockReason}`);
      console.log(`- Iterations: ${result.iterations}`);
      printGuardTelemetry(result.guardTelemetry);
      console.log();
      printObservations(result.observations);
      printTrace(result.trace);
      process.exitCode = 1;
      return;
    }

    if (result.guardTelemetry) {
      printGuardTelemetry(result.guardTelemetry);
    }

    reportProgress({
      phase: 'execution',
      message: applyRequested
        ? 'acting... render dry-run output and run Phase 8 preflight.'
        : input.dryRun
          ? 'acting... render dry-run output and compose preview.'
          : 'acting... persist pending preview memory without Docker deployment.',
    });
    const execution = applyRequested
      ? await engine.prepareApply(result)
      : input.dryRun
        ? await engine.dryRun(result)
        : await engine.savePendingPreview(result);
    reportProgress({
      phase: 'execution',
      message: applyRequested
        ? 'observe... Phase 8 preflight prepared; no Docker deployment executed.'
        : input.dryRun
          ? 'observe... dry-run completed without state mutation.'
          : 'observe... pending preview saved; no Docker deployment executed.',
    });

    console.log(chalk.cyan('Summary:'));
    console.log(result.plan.summary);
    console.log();

    console.log(chalk.cyan('Assumptions:'));
    for (const assumption of result.plan.assumptions) {
      console.log(`- ${assumption}`);
    }
    console.log();

    printObservations(result.observations);
    printTrace(result.trace);

    console.log(chalk.cyan('Plan steps:'));
    for (const step of result.plan.steps) {
      const dependencyText = step.dependsOn?.length
        ? ` (depends on: ${step.dependsOn.join(', ')})`
        : '';
      console.log(`- ${step.id}: ${step.description}${dependencyText}`);
    }
    console.log();

    if (input.dryRun || applyRequested) {
      printDetailedDryRunPreview(execution.dryRunPreview, execution.secretResolution);
    }

    console.log(chalk.cyan(applyRequested ? 'docker-compose.yaml preview:' : 'Generated docker-compose.yaml:'));
    console.log(execution.composeYaml);
    console.log();

    if (execution.secretResolution && execution.secretResolution.services.some((svc) => svc.secrets.some((sec) => sec.source === 'auto-generated'))) {
      console.log(chalk.gray('💡 Mật khẩu tự sinh được lưu tại: state/generated-secrets.env (sau --apply).'));
      console.log(chalk.gray('💡 .env chỉ seed mật khẩu cho service MỚI; service đã deploy giữ mật khẩu trong state/Docker.'));
      console.log();
    }

    if (applyRequested) {
      const applyPreparation = execution as ApplyPreparationResult;
      printPreflightReport(applyPreparation.preflight);

      if (!applyPreparation.approvalRequest) {
        console.log(chalk.red('Phase 8 apply stopped. Preflight failed; docker-compose.yaml was not written.'));
        process.exitCode = 1;
        return;
      }

      const approval = await requestCliApproval(applyPreparation.approvalRequest);
      const applyResult = await engine.completeApply(applyPreparation, approval);

      if (!applyResult.approvedAction) {
        console.log(chalk.yellow('Approval rejected. docker-compose.yaml was not written.'));
        console.log(chalk.yellow('No Docker, MCP, or runtime mutation was performed.'));
        console.log();
        console.log(chalk.cyan('State database:'));
        console.log(getStateDatabasePath());
        console.log();
        return;
      }

      console.log(chalk.green('ApprovedAction created.'));
      console.log(`- id: ${applyResult.approvedAction.id}`);
      console.log(`- compose artifact: ${applyResult.composeArtifactPath}`);
      console.log(`- compose hash: ${applyResult.approvedAction.composeArtifact.previewSha256}`);
      if (applyResult.generatedSecretsPath) {
        console.log(chalk.gray(`- generated secrets: ${applyResult.generatedSecretsPath}`));
        console.log(chalk.gray('  💡 .env chỉ seed cho service mới; service đã deploy giữ mật khẩu trong state/Docker.'));
      }

      if (deployRequested) {
        console.log(chalk.cyan('Deploying to Docker via MCP...'));
        const mcpClient = new DockerMcpGateway();
        try {
          await mcpClient.initialize();
          const deployResult = await engine.deployWithDocker(
            applyResult.approvedAction,
            mcpClient,
          );
          console.log(chalk.green('Docker deploy completed.'));
          console.log(`- Networks created: ${deployResult.networksCreated.join(", ") || "none"}`);
          console.log(`- Images pulled: ${deployResult.imagesPulled.join(", ") || "none"}`);
          console.log(`- Containers started: ${deployResult.containersStarted.map((c) => c.name).join(", ") || "none"}`);

          const verificationReport = await agent.verifyAfterApply(result.plan, mcpClient);
          const actualState = await mcpClient.observeActualState();
          const resourceRefs = buildResourceRefs(applyResult.approvedAction.validatedSpec.projectName, actualState);
          const driftReport = buildDriftReport(applyResult.approvedAction.validatedSpec, actualState);
          if (verificationReport.status === 'passed') {
            await saveVerifiedRuntimeSnapshot({
              approvedAction: applyResult.approvedAction,
              actual: actualState,
              verificationReport,
              operation: 'deploy',
              resourceRefs,
              driftReport,
            });
            console.log(chalk.green('Saved verified runtime state to SQLite after deploy.'));
          } else {
            console.log(chalk.yellow('Verification did not pass; current runtime state was not saved as verified.'));
          }
          console.log(chalk.cyan('Post-deploy verification:'));
          console.log(`- Status: ${verificationReport.status}`);
          if (verificationReport.issues.length > 0) {
            for (const issue of verificationReport.issues) {
              console.log(`  - ${issue}`);
            }
          }
          if (verificationReport.evidence.length > 0) {
            for (const item of verificationReport.evidence) {
              console.log(`  - ${item}`);
            }
          }
          if (driftReport.status !== 'none') {
            console.log(chalk.cyan('Drift report:'));
            console.log(`- ${driftReport.summary}`);
            for (const finding of driftReport.findings) {
              console.log(`  - [${finding.severity}] ${finding.message}`);
            }
          }
        } catch (error) {
          console.log(chalk.red('Docker deploy failed:'));
          console.log(`- ${getErrorMessage(error)}`);
          process.exitCode = 1;
        } finally {
          await mcpClient.shutdown();
        }
      } else {
        console.log('- Docker called: false');
        console.log('- MCP called: false');
      }
      console.log();
      console.log(chalk.cyan('State database:'));
      console.log(getStateDatabasePath());
      console.log();
      if (!deployRequested) {
        console.log(chalk.green('Phase 8 apply completed: compose artifact written, no Docker deployment executed.'));
      }
      return;
    }

    console.log(chalk.cyan('State database:'));
    console.log(getStateDatabasePath());
    console.log();

    console.log(
      input.dryRun
        ? chalk.yellow('Dry run only. No state saved and no Docker deployment executed.')
        : chalk.green('Pending preview saved. No Docker deployment executed.'),
    );
  });
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
    const mcpClient = new DockerMcpGateway();
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
    const engine = new ExecutionEngine();
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
      const mcpClient = new DockerMcpGateway();
      try {
        await mcpClient.initialize();
        const { drift, actual } = await engine.detectRuntimeDrift(state.current, mcpClient);
        console.log(chalk.cyan('Live drift:'));
        console.log('- ' + drift.summary);
        for (const finding of drift.findings) {
          console.log('  - [' + finding.severity + '] ' + finding.message);
        }

        if (drift.status === 'none') {
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
          console.log(chalk.yellow('No action taken. No Docker mutation was performed.'));
          await saveStateOperationRecord({ type: 'repair-rejected', projectName: project, request: state.current.request, summary: 'No action chosen from status --drift. Drift detected: ' + drift.summary });
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
            const resourceRefs = buildResourceRefs(project, actual);
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
          const resourceRefs = buildResourceRefs(project, actualAfterRepair);
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
    const engine = new ExecutionEngine();
    if (!state || !state.current) {
      console.log(chalk.red('No current verified runtime snapshot found. Run a deploy first.'));
      process.exitCode = 1;
      return;
    }
    const project = options.project ?? state.current.desired.projectName;
    console.log(chalk.cyan('Destroy preview for project "' + project + '":'));
    console.log('- Containers: ' + (state.current.resourceRefs?.containers.join(', ') || state.current.desired.services.map((s) => project + '-' + s.name).join(', ') || 'none'));
    console.log('- Networks: ' + (state.current.resourceRefs?.networks.join(', ') || state.current.desired.networks.join(', ') || 'none'));
    if (options.removeVolumes) console.log('- Volumes: ' + (state.current.resourceRefs?.volumes.join(', ') || 'none'));
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
    const mcpClient = new DockerMcpGateway();
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
        const resourceRefs = buildResourceRefs(project, result.actual);
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
  const engine = new ExecutionEngine();
  if (!state || !state.current) {
    console.log(chalk.red('No current verified runtime snapshot found. Run a deploy first.'));
    process.exitCode = 1;
    return;
  }
  const project = state.current.desired.projectName;
  const mcpClient = new DockerMcpGateway();
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
      const resourceRefs = buildResourceRefs(project, actualAfterRepair);
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

function printStaticGatewayMetrics(metrics: StaticGatewayMetrics): void {
  console.log(chalk.cyan('Static validation metrics:'));
  console.log(`- intentAccepted: ${metrics.intentAccepted}`);
  console.log(`- intentRejected: ${metrics.intentRejected}`);
  console.log(`- unsafeRejected: ${metrics.unsafeRejected}`);
  console.log(`- clarificationRequired: ${metrics.clarificationRequired}`);
  console.log(`- schemaValidationPassed: ${metrics.schemaValidationPassed}`);
  console.log(`- schemaValidationFailed: ${metrics.schemaValidationFailed}`);
  console.log(`- securityBlocked: ${metrics.securityBlocked}`);
  console.log(`- resourceLimitBlocked: ${metrics.resourceLimitBlocked}`);
  console.log(`- imageWhitelistBlocked: ${metrics.imageWhitelistBlocked}`);
  console.log(
    `- runtimeCallsDuringStaticValidation: ${metrics.runtimeCallsDuringStaticValidation}`,
  );
  console.log(
    `- reactInvocationsAfterStaticValidationFailure: ${metrics.reactInvocationsAfterStaticValidationFailure}`,
  );
}

function printObservations(observations: Array<{ source: string; message: string }>): void {
  console.log(chalk.cyan('Observations:'));
  for (const observation of observations) {
    console.log(`- [${observation.source}] ${observation.message}`);
  }
  console.log();
}

function printTrace(
  trace: Array<{ id: string; phase: string; toolName: string | null; message: string }> | undefined,
): void {
  if (!trace?.length) {
    return;
  }

  console.log(chalk.cyan('ReAct trace:'));
  for (const step of trace) {
    const toolText = step.toolName ? ` via ${step.toolName}` : '';
    console.log(`- ${step.id} [${step.phase}${toolText}]: ${step.message}`);
  }
  console.log();
}

function printDetailedDryRunPreview(
  preview: DetailedDryRunPreview,
  secretResolution?: SecretResolutionResult,
): void {
  console.log(chalk.cyan('Detailed dry-run preview:'));
  console.log(`Project: ${preview.projectName}`);
  console.log(`Services: ${preview.totalServices}`);
  console.log(`Container count if applied: ${preview.totalContainers}`);
  console.log(`Compose artifact target: ${preview.artifactTargetPath} (not written)`);
  console.log(
    `Runtime side effects: Docker called=${preview.dockerCalled}, MCP called=${preview.mcpCalled}, state saved=${preview.stateSaved}`,
  );
  console.log();

  console.log(chalk.cyan('Resources that would be created:'));
  console.log(`- Networks: ${preview.networks.join(', ') || 'none'}`);
  console.log(`- Volumes: ${preview.volumes.join(', ') || 'none'}`);
  console.log();

  console.log(chalk.cyan('Execution order:'));
  for (const step of preview.schedule.steps) {
    console.log(formatScheduleStep(step));
  }
  console.log();

  console.log(chalk.cyan('Dependency graph:'));
  for (const entry of preview.schedule.dependencyGraph) {
    console.log(
      `- ${entry.serviceName}: depends on ${entry.dependsOn.join(', ') || 'none'}; dependents ${entry.dependents.join(', ') || 'none'}`,
    );
  }
  console.log();

  const environmentPreviewResolution = secretResolution;

  console.log(chalk.cyan('Service details:'));
  for (const service of preview.services) {
    console.log(`- ${service.name} (${service.kind})`);
    console.log(`  image: ${service.image}`);
    console.log(`  replicas: ${service.replicas}`);
    console.log(`  depends on: ${service.dependsOn.join(', ') || 'none'}`);
    console.log(`  dependents: ${service.dependents.join(', ') || 'none'}`);
    console.log(`  ports: ${service.ports.join(', ') || 'none'}`);
    console.log(`  volumes: ${service.volumes.join(', ') || 'none'}`);
    console.log(`  environment keys: ${service.environmentKeys.join(', ') || 'none'}`);
    console.log(`  environment preview: ${formatEnvironmentPreview(service.environment, service.name, environmentPreviewResolution)}`);
    console.log(`  wait condition: ${service.waitCondition}`);
    console.log(
      `  readiness enforced now: ${service.readinessEnforced ? 'yes' : 'no, preview only'}`,
    );
    for (const warning of service.warnings) {
      console.log(`  warning: ${warning}`);
    }
  }
  console.log();

  console.log(chalk.cyan('Policy findings:'));
  if (!preview.policyFindings.length) {
    console.log('- none');
  }
  for (const finding of preview.policyFindings) {
    const target = finding.resourceName ? ` (${finding.resourceName})` : '';
    console.log(`- [${finding.severity}] ${finding.code}${target}: ${finding.message}`);
  }
  console.log();

  console.log(chalk.cyan('Actions not performed:'));
  for (const action of preview.actionsNotPerformed) {
    console.log(`- ${action}`);
  }
  console.log();
}

function printPreflightReport(preflight: PreflightReport): void {
  const statusColor = preflight.status === 'passed' ? chalk.green : chalk.red;

  console.log(chalk.cyan('Phase 8 preflight:'));
  console.log(`Status: ${statusColor(preflight.status)}`);
  console.log(`Checked at: ${preflight.checkedAt}`);
  console.log(`Meta verifier: ${preflight.verificationReport.status}`);

  if (preflight.issues.length) {
    console.log(chalk.cyan('Preflight issues:'));
    for (const issue of preflight.issues) {
      console.log(`- ${issue}`);
    }
  }

  console.log(chalk.cyan('Preflight evidence:'));
  for (const item of preflight.evidence) {
    console.log(`- ${item}`);
  }
  console.log();
}

async function requestCliApproval(request: ApprovalRequest) {
  console.log(chalk.cyan('Approval request:'));
  console.log(`- action: ${request.action}`);
  console.log(`- target: ${request.artifactTargetPath}`);
  console.log(`- compose hash: ${request.composePreviewSha256}`);
  console.log(`- containers if later applied: ${request.totalContainers}`);
  console.log('- Phase 8 will not call Docker or MCP.');
  console.log();

  const readline = createInterface({ input, output });

  try {
    const answer = (
      await readline.question(
        chalk.yellow('Approve writing docker-compose.yaml and creating ApprovedAction? (y/N) '),
      )
    )
      .trim()
      .toLowerCase();
    const decision = answer === 'y' || answer === 'yes' ? 'approved' : 'rejected';

    return createApprovalResult({
      request,
      decision,
      reason: decision === 'approved' ? 'Approved from CLI prompt.' : 'Rejected from CLI prompt.',
    });
  } finally {
    readline.close();
  }
}

function printDockerDoctorReport(report: DockerDoctorReport): void {
  const statusColor = report.status === 'passed' ? chalk.green : chalk.red;

  console.log(chalk.cyan('Docker doctor:'));
  console.log(`Status: ${statusColor(report.status)}`);
  console.log(`Checked at: ${report.checkedAt}`);
  console.log(`Docker CLI found: ${report.dockerCliFound}`);
  console.log(`Docker engine reachable: ${report.engineReachable}`);
  console.log();

  console.log(chalk.cyan('Commands executed:'));
  for (const command of report.commands) {
    console.log(`- ${command.command} ${command.args.join(' ')}: ${command.ok ? 'ok' : 'failed'}`);
    if (command.errorMessage) {
      console.log(`  error: ${command.errorMessage}`);
    }
  }
  console.log();

  if (report.issues.length) {
    console.log(chalk.cyan('Issues:'));
    for (const issue of report.issues) {
      console.log(`- ${issue}`);
    }
    console.log();
  }

  console.log(chalk.cyan('Evidence:'));
  for (const item of report.evidence) {
    console.log(`- ${item}`);
  }
  console.log();
}

function formatScheduleStep(step: ExecutionScheduleStep): string {
  const waitText = step.waitCondition ? `; wait: ${step.waitCondition}` : '';
  const dependencyText = step.dependsOn.length ? `; waits for: ${step.dependsOn.join(', ')}` : '';
  const dependentText = step.dependents.length ? `; then allows: ${step.dependents.join(', ')}` : '';
  const replicaText = step.replicas && step.replicas > 1 ? `; replicas: ${step.replicas}` : '';

  return [
    `- ${step.order}. ${step.levelName}: ${step.action}`,
    dependencyText,
    dependentText,
    replicaText,
    waitText,
  ].join('');
}

function formatEnvironmentPreview(
  environment: Record<string, string>,
  serviceName?: string,
  secretResolution?: SecretResolutionResult,
): string {
  const entries = Object.entries(environment);

  if (!entries.length) {
    return 'none';
  }

  const resolutionByService = new Map<string, Map<string, ResolvedSecret>>();
  for (const service of secretResolution?.services ?? []) {
    const byKey = new Map<string, ResolvedSecret>();
    for (const secret of service.secrets) {
      byKey.set(secret.key, secret);
    }
    resolutionByService.set(service.serviceName, byKey);
  }

  return entries
    .map(([key, value]) => {
      if (!isSecretLikeKey(key)) {
        return `${key}=${value}`;
      }
      const resolved = serviceName ? resolutionByService.get(serviceName)?.get(key) : undefined;
      const sourceText = resolved ? ` (${resolved.source})` : '';
      return `${key}=**********${sourceText}`;
    })
    .join(', ');
}

function printGuardTelemetry(telemetry: import('./domain/types.js').GuardTelemetry): void {
  console.log(chalk.cyan('ReAct loop guard telemetry:'));
  console.log(`- Outcome: ${telemetry.outcome}${telemetry.blockReason ? ` (${telemetry.blockReason})` : ''}`);
  console.log(`- Iterations: ${telemetry.iterations}`);
  const counts = telemetry.perToolCounts.map((entry) => `${entry.tool}=${entry.count}${entry.capped ? ' (capped)' : ''}`).join(', ');
  console.log(`- Tool calls: ${counts || 'none'}`);
  if (telemetry.deltaHistory.length > 0) {
    console.log('- Delta history:');
    for (const entry of telemetry.deltaHistory) {
      console.log(`    iter ${entry.iteration}: hasDelta=${entry.hasDelta} specHash=${entry.specHash} issueCount=${entry.issueCount}`);
    }
  }
  if (telemetry.logFilePath) {
    console.log(chalk.gray(`- Loop log: ${telemetry.logFilePath}`));
  }
}

function loadLocalEnvFile(): void {
  try {
    process.loadEnvFile('.env');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return;
    }

    throw error;
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isCommanderExcessArgumentsError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'commander.excessArguments'
  );
}

function isCommanderDisplayExitError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'exitCode' in error &&
    error.exitCode === 0
  );
}

function createProgressPrinter(): (event: ProgressEvent) => void {
  const counts = new Map<ProgressPhase, number>();
  let headerPrinted = false;

  return (event: ProgressEvent) => {
    if (!headerPrinted) {
      console.log(chalk.cyan('Progress:'));
      headerPrinted = true;
    }

    const nextCount = (counts.get(event.phase) ?? 0) + 1;
    counts.set(event.phase, nextCount);

    const toolText = event.toolName ? ` via ${event.toolName}` : '';
    console.log(
      chalk.gray(`- ${event.phase}${nextCount}${toolText}: ${event.message}`),
    );
  };
}
