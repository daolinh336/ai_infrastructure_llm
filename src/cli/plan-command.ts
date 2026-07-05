import {
  diffAdjustScope,
  validateAdjustReplicas,
  detectSupportedAdjustChanges,
} from './adjust-policy.js';
import type { Command } from 'commander';
import chalk from 'chalk';
import type {
  AgentRunResult,
  ApprovedAction,
  InfrastructureSpec,
  ProgressReporter,
  VerifiedRuntimeSnapshot,
  VerificationReport,
} from '../domain/types.js';
import { ReActAgent } from '../agent/react-agent.js';
import {
  ClosedLoopGuard,
  loadClosedLoopGuardConfig,
} from '../agent/closed-loop-guard.js';
import {
  cliInputSchema,
  validateInfrastructureSpec,
  validateValidatedQuery,
} from '../domain/schemas.js';
import {
  ExecutionEngine,
  type DeployPreparationResult,
} from '../execution/execution-engine.js';

import { runClosedLoopDeploy } from './deploy-loop.js';
import { buildResourceRefs } from '../agent/standard-verifier-agent.js';
import { createProvider } from '../llm/provider.js';
import {
  getStateDatabasePath,
  discardManagedProjectState,
  loadProjectState,
  saveVerifiedRuntimeSnapshot,
} from '../state/sqlite-state-store.js';
import {
  StaticGateway,
  type StaticGatewayResult,
} from '../static-gateway/static-gateway.js';
import { normalizeProjectName } from '../domain/project-identity.js';
import {
  createDockerMcpGatewayFromEnv,
  createProgressFileLogger,
  createProgressPrinter,
  getErrorMessage,
  loadDockerPullRetryPolicyFromEnv,
  printDetailedDryRunPreview,
  printGuardTelemetry,
  printPreflightReport,
  printRevisionPatchResults,
  printStaticGatewayMetrics,
  requestCliApproval,
  requestPlanningClarification,
  requestRevisionClarification,
  requestRuntimeApproval,
} from './shared.js';
import type { DockerMcpGateway } from '../execution/docker-mcp-gateway.js';
import { toReplicaContainerNames } from '../execution/container-names.js';

export function registerPlanCommand(program: Command): void {
  program
    .command('plan')
    .description(
      'Plan, approve, and deploy natural-language infrastructure to Docker',
    )
    .argument(
      '<prompt>',
      'Quoted natural-language request describing the target infrastructure, e.g. "Tao nginx port 80"',
    )
    .option(
      '--dry-run',
      'Render outputs without writing state or deploying Docker',
      true,
    )
    .option(
      '--deploy',
      'After approval, write compose artifact and deploy to Docker via MCP',
      false,
    )
    .option('--prjName <name>', 'Unique projectName for create/adjust routing')
    .option(
      '--adjust',
      'Adjust an existing deployed project; asks yes/no/other and deploys on approval',
      false,
    )
    .option(
      '--provider <provider>',
      'LLM provider to use (openai|gemini)',
      process.env.INFRA_AGENT_PROVIDER ?? 'openai',
    )
    .action(async (prompt, options) => {
      const traceLogPath = `${process.cwd()}\\agent-trace.log`;
      const reportProgressToFile = createProgressFileLogger(traceLogPath);
      const printProgress = createProgressPrinter();
      const reportProgress: ReturnType<typeof createProgressFileLogger> = (
        event,
      ) => {
        reportProgressToFile(event);
        if (event.phase === 'execution' || event.phase === 'observe') {
          printProgress(event);
        }
      };
      console.log(chalk.cyan(`Agent trace log: ${traceLogPath}`));
      const normalizedOptions = normalizePlanOptions(options);
      const deployRequested = normalizedOptions.deployRequested;
      const adjustRequested = normalizedOptions.adjustRequested;
      const applyRequested = deployRequested || adjustRequested;
      const input = cliInputSchema.parse({
        prompt,
        dryRun: applyRequested ? false : true,
        provider: normalizedOptions.provider,
      });
      const requestedProjectName = normalizedOptions.prjName
        ? normalizeProjectName(normalizedOptions.prjName)
        : null;
      if (!requestedProjectName) {
        console.error(chalk.red('CLI failed.'));
        console.error(
          'plan requires --prjName so projectName stays unique and routable across create/adjust flows.',
        );
        process.exitCode = 1;
        return;
      }
      if (adjustRequested && !requestedProjectName) {
        console.error(chalk.red('CLI failed.'));
        console.error(
          '--adjust requires --prjName so the CLI can load the correct saved infrastructure context.',
        );
        process.exitCode = 1;
        return;
      }
      if (adjustRequested && deployRequested) {
        console.error(chalk.red('CLI failed.'));
        console.error(
          '--adjust already runs approval + deploy. Remove --deploy and use the single adjust command.',
        );
        process.exitCode = 1;
        return;
      }
      if (requestedProjectName) {
        const existingProjectState =
          await loadProjectState(requestedProjectName);
        const exists =
          existingProjectState?.current !== null &&
          existingProjectState?.current !== undefined;
        if (adjustRequested && !exists) {
          console.error(chalk.red('CLI failed.'));
          console.error(
            `Project "${requestedProjectName}" does not have a verified deployment. Deploy the project before using --adjust.`,
          );
          process.exitCode = 1;
          return;
        }
        if (!adjustRequested && exists) {
          console.error(chalk.red('CLI failed.'));
          console.error(
            `Project "${requestedProjectName}" already exists. Use --adjust to update it, or choose another --prjName.`,
          );
          process.exitCode = 1;
          return;
        }
      }
      let adjustProjectState: Awaited<ReturnType<typeof loadProjectState>> =
        null;
      const adjustCurrentSnapshot = adjustRequested
        ? ((adjustProjectState = await loadProjectState(requestedProjectName))
            ?.current ?? null)
        : null;
      if (adjustRequested && !adjustCurrentSnapshot) {
        console.error(chalk.red('CLI failed.'));
        console.error(
          `Project "${requestedProjectName}" does not have a Current Verified Snapshot. Deploy/sync project before using --adjust.`,
        );
        process.exitCode = 1;
        return;
      }
      if (
        adjustRequested &&
        adjustCurrentSnapshot?.desired.projectName !== requestedProjectName
      ) {
        console.error(chalk.red('CLI failed.'));
        console.error(
          `Loaded snapshot projectName "${adjustCurrentSnapshot?.desired.projectName}" does not match requested --prjName "${requestedProjectName}".`,
        );
        process.exitCode = 1;
        return;
      }

      if (adjustRequested && adjustCurrentSnapshot) {
        const driftGatePassed = await verifyNoRuntimeDriftBeforeAdjust(
          requestedProjectName,
          adjustCurrentSnapshot,
          reportProgress,
        );
        if (!driftGatePassed) {
          process.exitCode = 1;
          return;
        }
      }

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
        phase: 'gate',
        message: 'acting... run pre-ReAct LLM gate and validators.',
      });
      const gatewayResult: StaticGatewayResult = adjustRequested
        ? {
            status: 'validated',
            validatedQuery: validateValidatedQuery({
              raw: input.prompt,
              normalizedPrompt: input.prompt,
              intent: 'update',
              draft: {
                raw: input.prompt,
                normalizedPrompt: input.prompt,
                intent: 'update',
                projectName: requestedProjectName,
                services: [],
                destructive: false,
                missingInformation: [],
              },
              riskFlags: [],
              securityFindings: [],
              resourceEstimate: {
                totalContainers: 0,
                maxCpu: null,
                maxMemoryGb: null,
              },
              clarificationRequired: false,
              clarificationQuestion: null,
            }),
            issues: [],
            metrics: {
              intentAccepted: 1,
              intentRejected: 0,
              clarificationRequired: 0,
              schemaValidationPassed: 1,
              schemaValidationFailed: 0,
              securityBlocked: 0,
              resourceLimitBlocked: 0,
              imageWhitelistBlocked: 0,
              runtimeCallsDuringStaticValidation: 0,
              reactInvocationsAfterStaticValidationFailure: 0,
            },
          }
        : await gateway.validate(input.prompt);

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
        console.log(
          chalk.yellow('Clarification required before ReAct starts.'),
        );
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
      const agent = new ReActAgent(
        provider,
        reportProgress,
        {},
        undefined,
        undefined,
        { logEnabled: true },
      );
      const engine = new ExecutionEngine({
        dockerPullRetry: loadDockerPullRetryPolicyFromEnv(),
        progress: reportProgress,
      });
      let result: AgentRunResult;
      if (adjustRequested && requestedProjectName) {
        const projectState = adjustProjectState;
        const currentSnapshot = adjustCurrentSnapshot;
        if (!currentSnapshot) {
          throw new Error(
            `Project "${requestedProjectName}" does not have a current snapshot for adjustment.`,
          );
        }
        const currentComposeYaml =
          currentSnapshot.composeArtifact.previewContent;
        const adjustFeedback = [
          'User adjustment request:',
          input.prompt,
          '',
          'Original request context:',
          currentSnapshot.request.raw,
          '',
          'Current desired InfrastructureSpec JSON context:',
          JSON.stringify(currentSnapshot.desired, null, 2),
          '',
          'Current rendered docker-compose.yaml context:',
          currentComposeYaml,
        ].join('\n');
        const revisionResult = await agent.reviseFromFeedback({
          desiredSpec: currentSnapshot.desired,
          revisionObservation: {
            verificationReport: null,
            userFeedback: {
              message: input.prompt,
              submittedAt: new Date().toISOString(),
            },
            driftSummary: null,
          },
          stateSnapshot: projectState,
          attemptIndex: 0,
        });
        const revisedSpec = validateInfrastructureSpec({
          ...revisionResult.revisedSpec,
          projectName: requestedProjectName,
        });

        const supportedAdjustChanges = detectSupportedAdjustChanges(
          revisedSpec,
          currentSnapshot.desired,
        );
        if (supportedAdjustChanges.length === 0) {
          console.error(chalk.red('CLI failed.'));
          console.error(
            chalk.yellow('T\u00ednh n\u0103ng \u0111ang ph\u00e1t tri\u1ec3n.'),
          );
          console.error(
            chalk.yellow(
              '--adjust hiện chỉ hỗ trợ tăng/giảm replicas cho backend/database. Không phát hiện được thay đổi replica hợp lệ từ yêu cầu này.',
            ),
          );
          process.exitCode = 1;
          return;
        }

        const adjustScopeViolations = diffAdjustScope(
          revisedSpec,
          currentSnapshot.desired,
        );
        if (adjustScopeViolations.length > 0) {
          console.error(chalk.red('CLI failed.'));
          console.error(
            chalk.yellow('T\u00ednh n\u0103ng \u0111ang ph\u00e1t tri\u1ec3n.'),
          );
          console.error(
            chalk.yellow(
              '--adjust hiện chỉ hỗ trợ tăng/giảm replicas cho backend/database. Các thay đổi ngoài replica như port/image/env chưa được hỗ trợ.',
            ),
          );
          for (const violation of adjustScopeViolations) {
            console.error(chalk.gray(`- ${violation.message}`));
          }
          process.exitCode = 1;
          return;
        }

        const adjustReplicaViolations = validateAdjustReplicas(
          revisedSpec,
          currentSnapshot.desired,
        );
        if (adjustReplicaViolations.length > 0) {
          console.error(chalk.red('CLI failed.'));
          console.error(
            chalk.yellow('T\u00ednh n\u0103ng \u0111ang ph\u00e1t tri\u1ec3n.'),
          );
          for (const violation of adjustReplicaViolations) {
            console.error(
              chalk.red(`- ${violation.serviceName}: ${violation.message}`),
            );
          }
          process.exitCode = 1;
          return;
        }

        result = {
          status: 'planned',
          request: {
            raw: input.prompt,
            normalizedPrompt: input.prompt,
            intent: 'update',
          },
          plan: {
            summary: revisionResult.revisionSummary,
            spec: revisedSpec,
            assumptions: revisionResult.assumptions,
            steps: [
              {
                id: 'generate-compose',
                description:
                  'Regenerate compose from adjusted desired-state spec.',
                action: 'generate-compose',
              },
              {
                id: 'write-state',
                description: 'Persist adjusted desired-state snapshot.',
                action: 'write-state',
                dependsOn: ['generate-compose'],
              },
              {
                id: 'deploy-compose',
                description: 'Deploy adjusted runtime after approval.',
                action: 'deploy-compose',
                dependsOn: ['write-state'],
              },
              {
                id: 'inspect-drift',
                description: 'Inspect runtime after adjustment.',
                action: 'inspect-drift',
                dependsOn: ['deploy-compose'],
              },
            ],
          },
          observations: [
            {
              source: 'observe:state',
              message: `Loaded current verified snapshot for project "${requestedProjectName}".`,
            },
            { source: 'observe:user_feedback', message: adjustFeedback },
            {
              source: 'observe:planner_revision',
              message: revisionResult.revisionSummary,
            },
          ],
          trace: [
            {
              id: 'adjust-reason',
              phase: 'reason',
              message: 'Adjust request: ' + input.prompt,
              toolName: 'reviseFromFeedback',
            },
            {
              id: 'adjust-observe',
              phase: 'observe',
              message: revisionResult.revisionSummary,
              toolName: null,
            },
          ],
        };
      } else {
        const validatedQuery = requestedProjectName
          ? validateValidatedQuery({
              ...gatewayResult.validatedQuery,
              draft: {
                ...gatewayResult.validatedQuery.draft,
                projectName: requestedProjectName,
              },
            })
          : gatewayResult.validatedQuery;
        result = await agent.run(validatedQuery);
        result = enforcePlannedProjectName(result, requestedProjectName);
      }

      while (result.status === 'clarification') {
        console.log(chalk.yellow('Clarification required by ReAct Agent.'));
        console.log(result.clarificationQuestion);
        if (result.uncertainties?.length) {
          console.log();
          console.log(chalk.cyan('Blocking planning uncertainties:'));
          for (const uncertainty of result.uncertainties) {
            console.log(`- ${uncertainty.id}: ${uncertainty.message}`);
          }
        }
        console.log();
        if (result.guardTelemetry) {
          printGuardTelemetry(result.guardTelemetry);
          console.log();
        }
        if (result.clarificationContext && result.uncertainties?.length) {
          console.log();
          console.log(
            chalk.cyan('Answer now to let planner continue in same run.'),
          );
          const answer = await requestPlanningClarification(result);
          const resumedResult = await agent.continueFromClarification(
            result.clarificationContext,
            answer,
          );

          if (resumedResult.status === 'clarification') {
            console.log();
            console.log(
              chalk.yellow(
                'Still needs clarification. Continuing in same run.',
              ),
            );
            result = resumedResult;
            continue;
          }

          if (resumedResult.status !== 'planned') {
            console.log();
            console.log(chalk.red('ReAct Agent blocked after clarification.'));
            console.log(`- Reason: ${resumedResult.blockReason}`);
            return;
          }

          console.log();
          console.log(
            chalk.green('Clarification applied. Continuing with resumed plan.'),
          );
          result = enforcePlannedProjectName(
            resumedResult,
            requestedProjectName,
          );
        } else {
          return;
        }
      }

      if (result.status === 'blocked') {
        console.log(chalk.red('ReAct Agent blocked by loop guard.'));
        console.log(`- Reason: ${result.blockReason}`);
        console.log(`- Iterations: ${result.iterations}`);
        printGuardTelemetry(result.guardTelemetry);
        console.log();
        process.exitCode = 1;
        return;
      }

      if (result.guardTelemetry) {
        printGuardTelemetry(result.guardTelemetry);
      }

      reportProgress({
        phase: 'execution',
        message: applyRequested
          ? 'acting... render dry-run output and run deploy preflight.'
          : 'acting... render dry-run output and compose preview.',
      });
      const execution = applyRequested
        ? await engine.prepareDeploy(result)
        : await engine.dryRun(result);
      reportProgress({
        phase: 'execution',
        message: applyRequested
          ? 'observe... deploy preflight prepared; no Docker deployment executed.'
          : 'observe... dry-run completed without state mutation.',
      });

      console.log(chalk.cyan('Summary:'));
      console.log(result.plan.summary);
      console.log();

      console.log(chalk.cyan('Assumptions:'));
      for (const assumption of result.plan.assumptions) {
        console.log(`- ${assumption}`);
      }
      console.log();

      console.log(chalk.cyan('Plan steps:'));
      for (const step of result.plan.steps) {
        const dependencyText = step.dependsOn?.length
          ? ` (depends on: ${step.dependsOn.join(', ')})`
          : '';
        console.log(`- ${step.id}: ${step.description}${dependencyText}`);
      }
      console.log();

      if (input.dryRun || applyRequested) {
        printDetailedDryRunPreview(
          execution.dryRunPreview,
          execution.secretResolution,
        );
      }

      console.log(
        chalk.cyan(
          applyRequested
            ? 'docker-compose.yaml preview:'
            : 'Generated docker-compose.yaml:',
        ),
      );
      console.log(execution.composeYaml);
      console.log();

      if (
        execution.secretResolution &&
        execution.secretResolution.services.some((svc) =>
          svc.secrets.some((sec) => sec.source === 'auto-generated'),
        )
      ) {
        console.log(
          chalk.gray(
            '💡 Auto-generated passwords are saved to: state/generated-secrets.env (after deploy).',
          ),
        );
        console.log(
          chalk.gray(
            'Tip: .env values are used whenever present; missing passwords are auto-generated.',
          ),
        );
        console.log();
      }

      if (applyRequested) {
        let currentResult = result;
        let deployPreparation = execution as DeployPreparationResult;
        printPreflightReport(deployPreparation.preflight);

        if (!deployPreparation.approvalRequest) {
          console.log(
            chalk.red(
              'deploy stopped. Preflight failed; docker-compose.yaml was not written.',
            ),
          );
          process.exitCode = 1;
          return;
        }

        let { approval, decision: previewDecision } = await requestCliApproval(
          deployPreparation.approvalRequest,
        );

        while (previewDecision.choice === 'other') {
          console.log(
            chalk.cyan(
              'User provided feedback. Returning to planner for revision...',
            ),
          );
          if (previewDecision.userFeedback) {
            console.log(`- Feedback: ${previewDecision.userFeedback.message}`);
          }
          let revisionResult = await agent.reviseFromFeedback({
            desiredSpec: currentResult.plan.spec,
            revisionObservation: {
              verificationReport: null,
              userFeedback: previewDecision.userFeedback,
              driftSummary: null,
            },
            stateSnapshot: null,
            attemptIndex: 0,
          });
          if (revisionResult.revisionDecision === 'needs-user-input') {
            const clarificationFeedback =
              await requestRevisionClarification(revisionResult);
            if (clarificationFeedback) {
              revisionResult = await agent.reviseFromFeedback({
                desiredSpec: currentResult.plan.spec,
                revisionObservation: {
                  verificationReport: null,
                  userFeedback: clarificationFeedback,
                  driftSummary: null,
                },
                stateSnapshot: null,
                attemptIndex: 0,
              });
            }
          }
          console.log(
            chalk.cyan(`- Revision summary: ${revisionResult.revisionSummary}`),
          );
          printRevisionPatchResults(revisionResult);
          for (const assumption of revisionResult.assumptions) {
            console.log(chalk.gray(`  - ${assumption}`));
          }
          if (revisionResult.revisionDecision === 'needs-user-input') {
            console.log(
              chalk.yellow(
                'Revision still needs clarification. docker-compose.yaml preview was not regenerated from the unchanged plan.',
              ),
            );
            process.exitCode = 1;
            return;
          }
          currentResult = {
            ...currentResult,
            plan: {
              ...currentResult.plan,
              spec: revisionResult.revisedSpec,
              assumptions: [
                ...currentResult.plan.assumptions,
                ...revisionResult.assumptions,
              ],
            },
            observations: [
              ...currentResult.observations,
              {
                source: 'observe:user_feedback',
                message:
                  previewDecision.userFeedback?.message ??
                  'User selected other without additional feedback.',
              },
              {
                source: 'observe:planner_revision',
                message: revisionResult.revisionSummary,
              },
            ],
          };
          deployPreparation = await engine.prepareDeploy(currentResult);
          printPreflightReport(deployPreparation.preflight);
          if (!deployPreparation.approvalRequest) {
            console.log(
              chalk.red(
                'deploy stopped after feedback revision. Preflight failed; docker-compose.yaml was not written.',
              ),
            );
            process.exitCode = 1;
            return;
          }
          console.log(chalk.cyan('Revised docker-compose.yaml preview:'));
          console.log(deployPreparation.composeYaml);
          ({ approval, decision: previewDecision } = await requestCliApproval(
            deployPreparation.approvalRequest,
          ));
        }

        const deployResult = await engine.completeDeploy(
          deployPreparation,
          approval,
        );

        if (!deployResult.approvedAction) {
          console.log(
            chalk.yellow(
              'Approval rejected. docker-compose.yaml was not written.',
            ),
          );
          console.log(
            chalk.yellow('No Docker, MCP, or runtime mutation was performed.'),
          );
          console.log(chalk.yellow('No deployment state was saved.'));
          return;
        }

        console.log(chalk.green('ApprovedAction created.'));
        console.log(`- id: ${deployResult.approvedAction.id}`);
        console.log(`- compose artifact: ${deployResult.composeArtifactPath}`);
        console.log(
          `- compose hash: ${deployResult.approvedAction.composeArtifact.previewSha256}`,
        );
        if (deployResult.generatedSecretsPath) {
          console.log(
            chalk.gray(
              `- generated secrets: ${deployResult.generatedSecretsPath}`,
            ),
          );
          console.log(
            chalk.gray(
              '  Tip: .env values are used whenever present; missing passwords are auto-generated.',
            ),
          );
        }

        {
          console.log(chalk.cyan('Deploying to Docker via MCP...'));
          const mcpClient = createDockerMcpGatewayFromEnv();
          const closedLoopGuard = new ClosedLoopGuard(
            loadClosedLoopGuardConfig(),
          );
          try {
            await mcpClient.initialize();
            const mcpCommand = mcpClient.connectionCommand;
            const capabilityReport = mcpClient.capabilityReport;
            console.log(chalk.cyan('Docker MCP preflight:'));
            console.log(`- profile: ${mcpClient.runtimeProfileName}`);
            console.log(
              `- command: ${mcpCommand.command} ${mcpCommand.args.join(' ')}`,
            );
            console.log(
              `- server: ${mcpClient.serverInfo?.name ?? 'unknown'}@${mcpClient.serverInfo?.version ?? 'unknown'}`,
            );
            console.log(
              `- missing operations: ${capabilityReport?.missingOperations.join(', ') || 'none'}`,
            );
            const adjustRollbackSnapshot = adjustRequested
              ? adjustCurrentSnapshot
              : null;
            if (adjustRollbackSnapshot) {
              console.log(
                chalk.cyan(
                  'Adjust deploy: destroying previous runtime before applying revised compose...',
                ),
              );
              const destroyResult = await engine.destroyWithDocker(
                adjustRollbackSnapshot,
                mcpClient,
                {
                  projectName: adjustRollbackSnapshot.desired.projectName,
                  removeVolumes: false,
                },
              );
              if (destroyResult.verificationReport.status !== 'passed') {
                throw new Error(
                  'Adjust deploy could not fully destroy previous runtime before apply: ' +
                    destroyResult.verificationReport.issues.join('; '),
                );
              }
              console.log(
                chalk.green(
                  'Previous runtime destroyed; applying adjusted runtime.',
                ),
              );
            }
            const deployLoopResult = await runClosedLoopDeploy({
              agent,
              engine,
              mcpClient,
              closedLoopGuard,
              approvedAction: deployResult.approvedAction,
              plan: currentResult.plan,
              requestRuntimeApproval,
              requestRevisionClarification,
              saveVerifiedRuntimeSnapshot,
              log: (message) => console.log(chalk.cyan(message)),
              progress: reportProgress,
            });

            if (deployLoopResult.status === 'passed') {
              console.log(
                chalk.green(
                  'Saved verified runtime state to SQLite after deploy.',
                ),
              );
              if (adjustRollbackSnapshot) {
                await refreshAdjustStateAfterDeploy(
                  mcpClient,
                  adjustRollbackSnapshot,
                  deployLoopResult.currentApprovedAction,
                );
              }
              if (deployLoopResult.successfulDeployResult) {
                printDockerDeploySummary(
                  deployLoopResult.currentApprovedAction.validatedSpec,
                  deployLoopResult.successfulDeployResult,
                  deployLoopResult.attempts,
                  deployLoopResult.revisionHistory.length,
                );
              }
            } else {
              console.log(
                chalk.red(
                  `Closed-loop deploy ended with status: ${deployLoopResult.status}`,
                ),
              );
              if (adjustRollbackSnapshot) {
                console.log(
                  chalk.yellow(
                    'Adjusted deployment failed; rolling back previous verified runtime...',
                  ),
                );
                await rollbackAdjustToSnapshot(
                  engine,
                  adjustRollbackSnapshot,
                  mcpClient,
                );
                console.log(
                  chalk.green(
                    'Rollback completed; previous verified runtime restored.',
                  ),
                );
              } else {
                await discardManagedProjectState(
                  deployLoopResult.currentApprovedAction.validatedSpec
                    .projectName,
                );
                console.log(
                  chalk.yellow(
                    'All deployment state for this project was discarded.',
                  ),
                );
              }
              const lastRevision = deployLoopResult.revisionHistory.at(-1);
              if (lastRevision) {
                console.log(chalk.red('Failure details:'));
                if (deployLoopResult.failureReason) {
                  console.log(
                    `- stop reason: ${deployLoopResult.failureReason}`,
                  );
                }
                console.log(
                  `- revision decision: ${lastRevision.revisionDecision}`,
                );
                console.log(
                  `- revision summary: ${lastRevision.revisionSummary}`,
                );
                if (lastRevision.findings.length > 0) {
                  console.log('- verifier findings:');
                  lastRevision.findings.forEach((finding) => {
                    const resourceLabel = finding.resourceName
                      ? ` (${finding.resourceKind}:${finding.resourceName})`
                      : ` (${finding.resourceKind})`;
                    const expectedActual =
                      finding.expected || finding.actual
                        ? ` expected=${finding.expected ?? 'n/a'} actual=${finding.actual ?? 'n/a'}`
                        : '';
                    const evidence = finding.evidence[0]
                      ? ` evidence=${finding.evidence[0]}`
                      : '';
                    console.log(
                      `  - ${finding.code}${resourceLabel}${expectedActual}${evidence}`,
                    );
                    if (finding.suggestedAction?.summary) {
                      console.log(
                        `    suggested fix: ${finding.suggestedAction.summary}`,
                      );
                    }
                  });
                }
                if (lastRevision.userFeedback?.message) {
                  console.log(
                    `- last user feedback: ${lastRevision.userFeedback.message}`,
                  );
                }
              } else {
                console.log(chalk.red('Failure details:'));
                console.log('- no revision history recorded before stop');
                console.log(
                  '- suggested fix: rerun with clearer target/service feedback, then approve revision',
                );
              }
              process.exitCode = 1;
              return;
            }
          } catch (error) {
            console.log(chalk.red('Docker deploy failed:'));
            console.log(`- ${getErrorMessage(error)}`);
            const adjustRollbackSnapshot = adjustRequested
              ? adjustCurrentSnapshot
              : null;
            if (adjustRollbackSnapshot) {
              try {
                console.log(
                  chalk.yellow(
                    'Adjusted deployment failed; rolling back previous verified runtime...',
                  ),
                );
                await rollbackAdjustToSnapshot(
                  engine,
                  adjustRollbackSnapshot,
                  mcpClient,
                );
                console.log(
                  chalk.green(
                    'Rollback completed; previous verified runtime restored.',
                  ),
                );
              } catch (rollbackError) {
                console.log(chalk.red('Rollback failed:'));
                console.log(`- ${getErrorMessage(rollbackError)}`);
              }
            } else if (deployResult.approvedAction) {
              await discardManagedProjectState(
                deployResult.approvedAction.validatedSpec.projectName,
              );
              console.log(
                chalk.yellow(
                  'All deployment state for this project was discarded.',
                ),
              );
            }
            process.exitCode = 1;
            return;
          } finally {
            await mcpClient.shutdown();
          }
        }

        console.log();
        console.log(chalk.cyan('State database:'));
        console.log(getStateDatabasePath());
        console.log();
        return;
      }

      console.log(chalk.cyan('State database:'));
      console.log(getStateDatabasePath());
      console.log();

      console.log(
        chalk.yellow(
          'Dry run only. No state saved and no Docker deployment executed.',
        ),
      );
    });
}

async function verifyNoRuntimeDriftBeforeAdjust(
  projectName: string,
  snapshot: VerifiedRuntimeSnapshot,
  reportProgress: ProgressReporter,
): Promise<boolean> {
  reportProgress({
    phase: 'observe',
    message: `acting... verify no runtime drift before adjusting project "${projectName}".`,
  });

  const engine = new ExecutionEngine({
    dockerPullRetry: loadDockerPullRetryPolicyFromEnv(),
    progress: reportProgress,
  });
  const mcpClient = createDockerMcpGatewayFromEnv();
  try {
    await mcpClient.initialize();
    const { drift } = await engine.detectRuntimeDrift(snapshot, mcpClient);
    if (drift.status === 'none') {
      reportProgress({
        phase: 'observe',
        message: `observe... no runtime drift detected for project "${projectName}"; adjust may continue.`,
      });
      return true;
    }

    console.error(chalk.red('CLI failed.'));
    console.error(`Project "${projectName}" has drift: ${drift.summary}`);
    for (const finding of drift.findings) {
      console.error(
        `- [${finding.severity}] ${finding.resourceType}/${finding.resourceName}: ${finding.message}`,
      );
    }
    console.error('Please sync or repair before using --adjust.');
    return false;
  } catch (error) {
    console.error(chalk.red('CLI failed.'));
    console.error(
      `Could not verify drift-free runtime for project "${projectName}" before --adjust.`,
    );
    console.error('- ' + getErrorMessage(error));
    console.error(
      'Please run status --drift first, then sync or repair before using --adjust.',
    );
    return false;
  } finally {
    await mcpClient.shutdown();
  }
}

async function refreshAdjustStateAfterDeploy(
  mcpClient: DockerMcpGateway,
  previousSnapshot: VerifiedRuntimeSnapshot,
  approvedAction: ApprovedAction,
): Promise<void> {
  const previousVolumes = new Set(previousSnapshot.desired.volumes);
  const nextVolumes = new Set(approvedAction.validatedSpec.volumes);
  const preservedVolumes = [...previousVolumes].filter(
    (volume) => !nextVolumes.has(volume),
  );

  if (preservedVolumes.length > 0) {
    console.log(
      chalk.cyan(
        'Adjust deploy: preserving volumes no longer declared in desired state.',
      ),
    );
    for (const volume of preservedVolumes) {
      console.log(chalk.gray(`- preserved volume: ${volume}`));
    }
  }

  const containerNames = approvedAction.validatedSpec.services.flatMap(
    (service) =>
      toReplicaContainerNames(
        approvedAction.validatedSpec.projectName,
        service,
      ),
  );
  const actual = await mcpClient.observeActualStateWithInspect({
    containerNames,
  });
  const verificationReport: VerificationReport = {
    status: 'passed',
    scope: 'tool-runtime',
    checkedAt: new Date().toISOString(),
    issues: [],
    findings: [],
    evidence:
      preservedVolumes.length > 0
        ? [
            'Adjusted runtime deployed; volumes removed from desired state were preserved on disk.',
          ]
        : ['Adjusted runtime deployed; no volumes needed preservation.'],
    errorReason: null,
    revisionHint: null,
    confidence: 0.95,
  };

  const resourceRefs = buildResourceRefs(
    approvedAction.validatedSpec.projectName,
    actual,
    approvedAction.validatedSpec,
  );
  const desiredVolumes = new Set(approvedAction.validatedSpec.volumes);

  await saveVerifiedRuntimeSnapshot({
    approvedAction,
    actual,
    verificationReport,
    operation: 'deploy',
    resourceRefs: {
      ...resourceRefs,
      volumes: resourceRefs.volumes.filter((volume) =>
        desiredVolumes.has(volume),
      ),
    },
  });
}
async function rollbackAdjustToSnapshot(
  engine: ExecutionEngine,
  snapshot: VerifiedRuntimeSnapshot,
  mcpClient: DockerMcpGateway,
): Promise<void> {
  const rollbackResult = buildPlannedResultFromSnapshot(
    snapshot,
    'Rollback to previous verified snapshot after failed adjust deploy.',
  );
  const rollbackPreparation = await engine.prepareDeploy(rollbackResult);
  if (!rollbackPreparation.approvalRequest) {
    throw new Error(
      'Rollback preparation failed preflight; previous verified snapshot could not be redeployed.',
    );
  }
  const respondedAt = new Date().toISOString();
  const rollbackExecution = await engine.completeDeploy(rollbackPreparation, {
    id: `rollback-${Date.now()}`,
    requestId: rollbackPreparation.approvalRequest.id,
    decision: 'approved',
    respondedAt,
    approvedBy: 'cli-user',
    reason: 'system rollback after failed adjust deploy',
  });
  if (!rollbackExecution.approvedAction) {
    throw new Error('Rollback ApprovedAction was not created.');
  }

  await engine.destroyWithDocker(null, mcpClient, {
    projectName: snapshot.desired.projectName,
    removeVolumes: false,
  });
  await engine.deployWithDocker(rollbackExecution.approvedAction, mcpClient);
  const containerNames = snapshot.desired.services.flatMap((service) =>
    toReplicaContainerNames(snapshot.desired.projectName, service),
  );
  const actual = await mcpClient.observeActualStateWithInspect({
    containerNames,
  });
  const verificationReport: VerificationReport = {
    status: 'passed',
    scope: 'tool-runtime',
    checkedAt: new Date().toISOString(),
    issues: [],
    findings: [],
    evidence: [
      'Rollback redeployed previous verified snapshot after failed adjust deploy.',
    ],
    errorReason: null,
    revisionHint: null,
    confidence: 0.95,
  };
  await saveVerifiedRuntimeSnapshot({
    sourceSnapshot: snapshot,
    actual,
    verificationReport,
    operation: 'deploy',
    resourceRefs: buildResourceRefs(
      snapshot.desired.projectName,
      actual,
      snapshot.desired,
    ),
  });
}

function buildPlannedResultFromSnapshot(
  snapshot: VerifiedRuntimeSnapshot,
  summary: string,
): AgentRunResult {
  return {
    status: 'planned',
    request: snapshot.request,
    plan: {
      summary,
      spec: snapshot.desired,
      assumptions: [
        'Using previous verified snapshot as rollback source of truth.',
      ],
      steps: [
        {
          id: 'generate-compose',
          description: 'Regenerate compose from previous verified spec.',
          action: 'generate-compose',
        },
        {
          id: 'write-state',
          description: 'Persist rollback desired-state snapshot.',
          action: 'write-state',
          dependsOn: ['generate-compose'],
        },
        {
          id: 'deploy-compose',
          description: 'Redeploy previous verified runtime.',
          action: 'deploy-compose',
          dependsOn: ['write-state'],
        },
        {
          id: 'inspect-drift',
          description: 'Inspect runtime after rollback.',
          action: 'inspect-drift',
          dependsOn: ['deploy-compose'],
        },
      ],
    },
    observations: [
      {
        source: 'observe:state',
        message: 'Loaded previous verified snapshot for rollback.',
      },
    ],
    trace: [
      {
        id: 'rollback-reason',
        phase: 'reason',
        message:
          'Rollback to previous verified snapshot after failed adjust deploy.',
        toolName: null,
      },
    ],
  };
}

function printDockerDeploySummary(
  spec: InfrastructureSpec,
  deployResult: NonNullable<
    Awaited<ReturnType<typeof runClosedLoopDeploy>>['successfulDeployResult']
  >,
  attempts: number,
  revisionCount: number,
): void {
  console.log(chalk.green('Docker deployment completed.'));
  console.log(`- project: ${spec.projectName}`);
  console.log(
    `- attempts: ${attempts}${revisionCount > 0 ? ` (${revisionCount} revision${revisionCount === 1 ? '' : 's'} before success)` : ''}`,
  );
  console.log(`- services: ${formatServiceSummary(spec)}`);
  console.log(
    `- containers: ${formatList(deployResult.containersStarted.map((container) => container.name))}`,
  );
  console.log(`- images: ${formatList(deployResult.imagesPulled)}`);
  console.log(`- networks: ${formatList(deployResult.networksCreated)}`);
}

function formatServiceSummary(spec: InfrastructureSpec): string {
  if (spec.services.length === 0) {
    return 'none';
  }
  return spec.services
    .map((service) => {
      const replicas =
        service.replicas && service.replicas > 1 ? ` x${service.replicas}` : '';
      const ports = service.ports?.length
        ? ` ports ${service.ports.join(',')}`
        : '';
      return `${service.kind}/${service.name}${replicas} (${service.image}${ports})`;
    })
    .join('; ');
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(', ') : 'none';
}

function normalizePlanOptions(options: Record<string, unknown>): {
  deployRequested: boolean;
  adjustRequested: boolean;
  provider: string;
  prjName: string | null;
} {
  const rawProjectName = typeof options.prjName === 'string' ? options.prjName : null;
  const projectAdjustSuffix = rawProjectName?.match(/^(?<projectName>.+)--adjust$/);

  return {
    deployRequested: Boolean(options.deploy),
    adjustRequested: Boolean(options.adjust) || projectAdjustSuffix !== null,
    provider: typeof options.provider === 'string' ? options.provider : process.env.INFRA_AGENT_PROVIDER ?? 'openai',
    prjName: projectAdjustSuffix?.groups?.projectName ?? rawProjectName,
  };
}

function enforcePlannedProjectName(
  result: AgentRunResult,
  projectName: string,
): AgentRunResult {
  if (result.status !== 'planned') return result;
  if (result.plan.spec.projectName === projectName) return result;

  return {
    ...result,
    plan: {
      ...result.plan,
      spec: validateInfrastructureSpec({ ...result.plan.spec, projectName }),
    },
  };
}
