import type { Command } from 'commander';
import chalk from 'chalk';
import type { AgentRunResult, InfrastructureSpec } from '../domain/types.js';
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
import { createProvider } from '../llm/provider.js';
import {
  getStateDatabasePath,
  loadProjectState,
  projectExists,
  saveVerifiedRuntimeSnapshot,
} from '../state/sqlite-state-store.js';
import { StaticGateway } from '../static-gateway/static-gateway.js';
import { normalizeProjectName } from '../domain/project-identity.js';
import {
  createDockerMcpGatewayFromEnv,
  createProgressPrinter,
  getErrorMessage,
  loadDockerPullRetryPolicyFromEnv,
  printDetailedDryRunPreview,
  printGuardTelemetry,
  printObservations,
  printPreflightReport,
  printRevisionPatchResults,
  printStaticGatewayMetrics,
  printTrace,
  requestCliApproval,
  requestPlanningClarification,
  requestRevisionClarification,
  requestRuntimeApproval,
} from './shared.js';

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
      '--save-state',
      'Persist the desired state snapshot without deploying Docker',
      false,
    )
    .option(
      '--deploy',
      'After approval, write compose artifact and deploy to Docker via MCP',
      false,
    )
    .option(
      '--prjName <name>',
      'Unique projectName for create/adjust routing',
    )
    .option(
      '--adjust',
      'Adjust an existing project plan instead of creating a new one',
      false,
    )
    .option(
      '--provider <provider>',
      'LLM provider to use (openai|gemini)',
      process.env.INFRA_AGENT_PROVIDER ?? 'openai',
    )
    .action(async (prompt, options) => {
      const reportProgress = createProgressPrinter();
      const saveStateRequested = Boolean(options.saveState);
      const deployRequested = Boolean(options.deploy);
      const input = cliInputSchema.parse({
        prompt,
        dryRun:
          deployRequested || saveStateRequested
            ? false
            : (options.dryRun ?? true),
        provider: options.provider,
      });
      const adjustRequested = Boolean(options.adjust);
      const requestedProjectName = options.prjName ? normalizeProjectName(String(options.prjName)) : null;
      if (!requestedProjectName) {
        console.error(chalk.red('CLI failed.'));
        console.error('plan requires --prjName so projectName stays unique and routable across create/adjust flows.');
        process.exitCode = 1;
        return;
      }
      if (adjustRequested && !requestedProjectName) {
        console.error(chalk.red('CLI failed.'));
        console.error('--adjust requires --prjName so the CLI can load the correct saved infrastructure context.');
        process.exitCode = 1;
        return;
      }
      if (requestedProjectName) {
        const exists = await projectExists(requestedProjectName);
        if (adjustRequested && !exists) {
          console.error(chalk.red('CLI failed.'));
          console.error(`Project "${requestedProjectName}" does not exist. Create a new project by removing --adjust.`);
          process.exitCode = 1;
          return;
        }
        if (!adjustRequested && exists) {
          console.error(chalk.red('CLI failed.'));
          console.error(`Project "${requestedProjectName}" already exists. Use --adjust to update it, or choose another --prjName.`);
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
      });
      let result: AgentRunResult;
      if (adjustRequested && requestedProjectName) {
        const projectState = await loadProjectState(requestedProjectName);
        const currentSnapshot = projectState?.current ?? null;
        if (!currentSnapshot) {
          console.error(chalk.red('CLI failed.'));
          console.error(`Project "${requestedProjectName}" does not have a Current Verified Snapshot. Deploy/sync project before using --adjust.`);
          process.exitCode = 1;
          return;
        }
        if (currentSnapshot.desired.projectName !== requestedProjectName) {
          console.error(chalk.red('CLI failed.'));
          console.error(
            `Loaded snapshot projectName "${currentSnapshot.desired.projectName}" does not match requested --prjName "${requestedProjectName}".`,
          );
          process.exitCode = 1;
          return;
        }
        const mcpClient = createDockerMcpGatewayFromEnv();
        try {
          await mcpClient.initialize();
          const { drift } = await engine.detectRuntimeDrift(currentSnapshot, mcpClient);
          if (drift.status !== 'none') {
            console.error(chalk.red('CLI failed.'));
            console.error(`Project "${requestedProjectName}" has drift: ${drift.summary}`);
            console.error('Please sync or repair before using --adjust.');
            process.exitCode = 1;
            return;
          }
        } finally {
          await mcpClient.shutdown();
        }
        const currentComposeYaml = currentSnapshot.composeArtifact.previewContent;
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
            userFeedback: { message: adjustFeedback, submittedAt: new Date().toISOString() },
            driftSummary: null,
          },
          stateSnapshot: projectState,
          attemptIndex: 0,
        });
        const revisedSpec = validateInfrastructureSpec({
          ...revisionResult.revisedSpec,
          projectName: requestedProjectName,
        });
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
              { id: 'generate-compose', description: 'Regenerate compose from adjusted desired-state spec.', action: 'generate-compose' },
              { id: 'write-state', description: 'Persist adjusted desired-state snapshot.', action: 'write-state', dependsOn: ['generate-compose'] },
              { id: 'deploy-compose', description: 'Deploy adjusted runtime after approval.', action: 'deploy-compose', dependsOn: ['write-state'] },
              { id: 'inspect-drift', description: 'Inspect runtime after adjustment.', action: 'inspect-drift', dependsOn: ['deploy-compose'] },
            ],
          },
          observations: [
            { source: 'observe:state', message: `Loaded current verified snapshot for project "${requestedProjectName}".` },
            { source: 'observe:user_feedback', message: adjustFeedback },
            { source: 'observe:planner_revision', message: revisionResult.revisionSummary },
          ],
          trace: [],
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
        if (result.clarificationChoices?.length) {
          console.log();
          console.log(chalk.cyan('Available choices:'));
          for (const choice of result.clarificationChoices) {
            console.log(
              `- ${choice.id}. ${choice.label}: ${choice.description}`,
            );
          }
          if (result.allowOther) {
            console.log('- other. Provide a different custom answer.');
          }
        }
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
        printObservations(result.observations);
        printTrace(result.trace);

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
              chalk.yellow('Still needs clarification. Continuing in same run.'),
            );
            result = resumedResult;
            continue;
          }

          if (resumedResult.status !== 'planned') {
            console.log();
            console.log(
              chalk.red('ReAct Agent blocked after clarification.'),
            );
            console.log(`- Reason: ${resumedResult.blockReason}`);
            return;
          }

          console.log();
          console.log(
            chalk.green('Clarification applied. Continuing with resumed plan.'),
          );
          printObservations(resumedResult.observations);
          printTrace(resumedResult.trace);
          result = enforcePlannedProjectName(resumedResult, requestedProjectName);
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
        message: deployRequested
          ? 'acting... render dry-run output and run deploy preflight.'
          : input.dryRun
            ? 'acting... render dry-run output and compose preview.'
            : 'acting... persist pending preview memory without Docker deployment.',
      });
      const execution = deployRequested
        ? await engine.prepareDeploy(result)
        : input.dryRun
          ? await engine.dryRun(result)
          : await engine.savePendingPreview(result);
      reportProgress({
        phase: 'execution',
        message: deployRequested
          ? 'observe... deploy preflight prepared; no Docker deployment executed.'
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

      if (input.dryRun || deployRequested) {
        printDetailedDryRunPreview(
          execution.dryRunPreview,
          execution.secretResolution,
        );
      }

      console.log(
        chalk.cyan(
          deployRequested
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

      if (deployRequested) {
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
            const clarificationFeedback = await requestRevisionClarification(
              revisionResult,
            );
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
          console.log();
          console.log(chalk.cyan('State database:'));
          console.log(getStateDatabasePath());
          console.log();
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
            });

            if (deployLoopResult.status === 'passed') {
              console.log(
                chalk.green(
                  'Saved verified runtime state to SQLite after deploy.',
                ),
              );
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
              const lastRevision = deployLoopResult.revisionHistory.at(-1);
              if (lastRevision) {
                console.log(chalk.red('Failure details:'));
                if (deployLoopResult.failureReason) {
                  console.log(`- stop reason: ${deployLoopResult.failureReason}`);
                }
                console.log(`- revision decision: ${lastRevision.revisionDecision}`);
                console.log(`- revision summary: ${lastRevision.revisionSummary}`);
                if (lastRevision.findings.length > 0) {
                  console.log('- verifier findings:');
                  lastRevision.findings.forEach((finding) => {
                    const resourceLabel = finding.resourceName ? ` (${finding.resourceKind}:${finding.resourceName})` : ` (${finding.resourceKind})`;
                    const expectedActual = finding.expected || finding.actual
                      ? ` expected=${finding.expected ?? 'n/a'} actual=${finding.actual ?? 'n/a'}`
                      : '';
                    const evidence = finding.evidence[0] ? ` evidence=${finding.evidence[0]}` : '';
                    console.log(`  - ${finding.code}${resourceLabel}${expectedActual}${evidence}`);
                    if (finding.suggestedAction?.summary) {
                      console.log(`    suggested fix: ${finding.suggestedAction.summary}`);
                    }
                  });
                }
                if (lastRevision.userFeedback?.message) {
                  console.log(`- last user feedback: ${lastRevision.userFeedback.message}`);
                }
              } else {
                console.log(chalk.red('Failure details:'));
                console.log('- no revision history recorded before stop');
                console.log('- suggested fix: rerun with clearer target/service feedback, then approve revision');
              }
              process.exitCode = 1;
            }
          } catch (error) {
            console.log(chalk.red('Docker deploy failed:'));
            console.log(`- ${getErrorMessage(error)}`);
            process.exitCode = 1;
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
        input.dryRun
          ? chalk.yellow(
              'Dry run only. No state saved and no Docker deployment executed.',
            )
          : chalk.green(
              'Pending preview saved. No Docker deployment executed.',
            ),
      );
    });
}

function printDockerDeploySummary(
  spec: InfrastructureSpec,
  deployResult: NonNullable<Awaited<ReturnType<typeof runClosedLoopDeploy>>['successfulDeployResult']>,
  attempts: number,
  revisionCount: number,
): void {
  console.log(chalk.green('Docker deployment completed.'));
  console.log(`- project: ${spec.projectName}`);
  console.log(`- attempts: ${attempts}${revisionCount > 0 ? ` (${revisionCount} revision${revisionCount === 1 ? '' : 's'} before success)` : ''}`);
  console.log(`- services: ${formatServiceSummary(spec)}`);
  console.log(`- containers: ${formatList(deployResult.containersStarted.map((container) => container.name))}`);
  console.log(`- images: ${formatList(deployResult.imagesPulled)}`);
  console.log(`- networks: ${formatList(deployResult.networksCreated)}`);
}

function formatServiceSummary(spec: InfrastructureSpec): string {
  if (spec.services.length === 0) {
    return 'none';
  }
  return spec.services
    .map((service) => {
      const replicas = service.replicas && service.replicas > 1 ? ` x${service.replicas}` : '';
      const ports = service.ports?.length ? ` ports ${service.ports.join(',')}` : '';
      return `${service.kind}/${service.name}${replicas} (${service.image}${ports})`;
    })
    .join('; ');
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(', ') : 'none';
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












