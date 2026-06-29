import type { Command } from 'commander';
import chalk from 'chalk';
import { ReActAgent } from '../agent/react-agent.js';
import {
  ClosedLoopGuard,
  loadClosedLoopGuardConfig,
} from '../agent/closed-loop-guard.js';
import { cliInputSchema } from '../domain/schemas.js';
import {
  ExecutionEngine,
  type ApplyPreparationResult,
} from '../execution/execution-engine.js';

import { runClosedLoopDeploy } from './deploy-loop.js';
import { createProvider } from '../llm/provider.js';
import {
  getStateDatabasePath,
  saveVerifiedRuntimeSnapshot,
} from '../state/sqlite-state-store.js';
import { StaticGateway } from '../static-gateway/static-gateway.js';
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
      'Analyze a natural-language infrastructure request and produce a plan',
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
      '--apply',
      'Run Phase 8 preflight, request approval, then write docker-compose.yaml without Docker deployment',
      false,
    )
    .option(
      '--save-state',
      'Persist the desired state snapshot without deploying Docker',
      false,
    )
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
        dryRun:
          applyRequested || saveStateRequested
            ? false
            : (options.dryRun ?? true),
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
      const effectiveProvider =
        deployRequested &&
        input.provider === 'stub' &&
        process.env.OPENAI_API_KEY?.trim()
          ? 'openai'
          : input.provider;
      if (effectiveProvider !== input.provider) {
        reportProgress({
          phase: 'cli',
          message: `acting... OPENAI_API_KEY found; using provider "${effectiveProvider}" for deploy-time ReAct revision.`,
        });
      }
      const provider = createProvider(effectiveProvider);
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
      let result = await agent.run(gatewayResult.validatedQuery);

      if (result.status === 'clarification') {
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

          if (resumedResult.status !== 'planned') {
            console.log();
            if (resumedResult.status === 'clarification') {
              console.log(
                chalk.yellow('Still needs clarification after first answer.'),
              );
              console.log(resumedResult.clarificationQuestion);
            } else {
              console.log(
                chalk.red('ReAct Agent blocked after clarification.'),
              );
              console.log(`- Reason: ${resumedResult.blockReason}`);
            }
            return;
          }

          console.log();
          console.log(
            chalk.green('Clarification applied. Continuing with resumed plan.'),
          );
          printObservations(resumedResult.observations);
          printTrace(resumedResult.trace);
          result = resumedResult;
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
            '💡 Auto-generated passwords are saved to: state/generated-secrets.env (after --apply).',
          ),
        );
        console.log(
          chalk.gray(
            '💡 .env only seeds passwords for NEW services; deployed services keep passwords in state/Docker.',
          ),
        );
        console.log();
      }

      if (applyRequested) {
        let currentResult = result;
        let applyPreparation = execution as ApplyPreparationResult;
        printPreflightReport(applyPreparation.preflight);

        if (!applyPreparation.approvalRequest) {
          console.log(
            chalk.red(
              'Phase 8 apply stopped. Preflight failed; docker-compose.yaml was not written.',
            ),
          );
          process.exitCode = 1;
          return;
        }

        let { approval, decision: previewDecision } = await requestCliApproval(
          applyPreparation.approvalRequest,
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
          applyPreparation = await engine.prepareApply(currentResult);
          printPreflightReport(applyPreparation.preflight);
          if (!applyPreparation.approvalRequest) {
            console.log(
              chalk.red(
                'Phase 8 apply stopped after feedback revision. Preflight failed; docker-compose.yaml was not written.',
              ),
            );
            process.exitCode = 1;
            return;
          }
          console.log(chalk.cyan('Revised docker-compose.yaml preview:'));
          console.log(applyPreparation.composeYaml);
          ({ approval, decision: previewDecision } = await requestCliApproval(
            applyPreparation.approvalRequest,
          ));
        }

        const applyResult = await engine.completeApply(
          applyPreparation,
          approval,
        );

        if (!applyResult.approvedAction) {
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
        console.log(`- id: ${applyResult.approvedAction.id}`);
        console.log(`- compose artifact: ${applyResult.composeArtifactPath}`);
        console.log(
          `- compose hash: ${applyResult.approvedAction.composeArtifact.previewSha256}`,
        );
        if (applyResult.generatedSecretsPath) {
          console.log(
            chalk.gray(
              `- generated secrets: ${applyResult.generatedSecretsPath}`,
            ),
          );
          console.log(
            chalk.gray(
              '  💡 .env only seeds new services; deployed services keep passwords in state/Docker.',
            ),
          );
        }

        if (deployRequested) {
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
              approvedAction: applyResult.approvedAction,
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
            } else {
              console.log(
                chalk.red(
                  `Closed-loop deploy ended with status: ${deployLoopResult.status}`,
                ),
              );
              process.exitCode = 1;
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
          console.log(
            chalk.green(
              'Phase 8 apply completed: compose artifact written, no Docker deployment executed.',
            ),
          );
        }
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
