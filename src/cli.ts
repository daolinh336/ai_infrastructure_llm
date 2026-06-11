#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { ReActAgent } from './agent/react-agent.js';
import { cliInputSchema } from './domain/schemas.js';
import { ExecutionEngine } from './execution/execution-engine.js';
import { createProvider } from './llm/provider.js';
import { getStateFilePath } from './state/file-state-store.js';
import { StaticGateway } from './static-gateway/static-gateway.js';
import { StatusService } from './status/status-service.js';
import type { ProgressEvent, ProgressPhase, StaticGatewayMetrics } from './domain/types.js';

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
  .option('--save-state', 'Persist the desired state snapshot without deploying Docker', false)
  .option(
    '--provider <provider>',
    'LLM provider to use (stub|openai|gemini|ollama)',
    process.env.INFRA_AGENT_PROVIDER ?? 'stub',
  )
  .action(async (prompt, options) => {
    const reportProgress = createProgressPrinter();
    const saveStateRequested = Boolean(options.saveState);
    const input = cliInputSchema.parse({
      prompt,
      dryRun: saveStateRequested ? false : options.dryRun ?? true,
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
    const agent = new ReActAgent(provider, reportProgress);
    const engine = new ExecutionEngine();
    const result = await agent.run(gatewayResult.validatedQuery);

    if (result.status === 'clarification') {
      console.log(chalk.yellow('Clarification required by ReAct Agent.'));
      console.log(result.clarificationQuestion);
      console.log();
      printObservations(result.observations);
      printTrace(result.trace);
      return;
    }

    reportProgress({
      phase: 'execution',
      message: input.dryRun
        ? 'acting... render dry-run output and compose preview.'
        : 'acting... persist desired state snapshot without Docker deployment.',
    });
    const execution = input.dryRun
      ? await engine.dryRun(result)
      : await engine.saveDesiredState(result);
    reportProgress({
      phase: 'execution',
      message: input.dryRun
        ? 'observe... dry-run completed without state mutation.'
        : 'observe... desired state saved; no Docker deployment executed.',
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

    console.log(chalk.cyan('Generated docker-compose.yaml:'));
    console.log(execution.composeYaml);
    console.log();

    console.log(chalk.cyan('State file:'));
    console.log(getStateFilePath());
    console.log();

    console.log(
      input.dryRun
        ? chalk.yellow('Dry run only. No state saved and no Docker deployment executed.')
        : chalk.green('Desired state saved. No Docker deployment executed.'),
    );
  });

program
  .command('status')
  .description('Show the current desired/actual infrastructure snapshot')
  .action(async () => {
    const reportProgress = createProgressPrinter();
    reportProgress({
      phase: 'cli',
      message: 'thinking... start status command.',
    });
    reportProgress({
      phase: 'execution',
      message: 'acting... load saved infrastructure snapshot.',
    });
    const status = await new StatusService().showStatus();
    reportProgress({
      phase: 'execution',
      message: 'observe... status snapshot loaded.',
    });
    console.log(status);
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
