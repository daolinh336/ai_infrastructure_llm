import { Command } from 'commander';
import chalk from 'chalk';
import { ReActAgent } from './agent/react-agent.js';
import { cliInputSchema } from './domain/schemas.js';
import { ExecutionEngine } from './execution/execution-engine.js';
import { createProvider } from './llm/provider.js';
import { getStateFilePath } from './state/file-state-store.js';
import { StaticGateway } from './static-gateway/static-gateway.js';
import { StatusService } from './status/status-service.js';
import type { StaticGatewayMetrics } from './domain/types.js';

const program = new Command();

program
  .name('infra-react-agent')
  .description('Natural-language infrastructure management CLI with a ReAct-style agent')
  .version('0.1.0');

program
  .command('plan')
  .description('Analyze a natural-language infrastructure request and produce a plan')
  .argument('<prompt>', 'Natural-language request describing the target infrastructure')
  .option('--dry-run', 'Render outputs without writing state or deploying Docker', true)
  .option('--save-state', 'Persist the desired state snapshot without deploying Docker', false)
  .option('--provider <provider>', 'LLM provider to use (openai|gemini|ollama)', 'openai')
  .action(async (prompt, options) => {
    const saveStateRequested = Boolean(options.saveState);
    const input = cliInputSchema.parse({
      prompt,
      dryRun: saveStateRequested ? false : options.dryRun ?? true,
      provider: options.provider,
    });

    const gateway = new StaticGateway(createProvider(input.provider));
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

    const agent = new ReActAgent(createProvider(input.provider));
    const engine = new ExecutionEngine();
    const result = await agent.run(gatewayResult.validatedQuery);

    const execution = input.dryRun
      ? await engine.dryRun(result)
      : await engine.saveDesiredState(result);

    console.log(chalk.cyan('Summary:'));
    console.log(result.plan.summary);
    console.log();

    console.log(chalk.cyan('Observations:'));
    for (const observation of result.observations) {
      console.log(`- [${observation.source}] ${observation.message}`);
    }
    console.log();

    if (result.trace?.length) {
      console.log(chalk.cyan('ReAct trace:'));
      for (const step of result.trace) {
        const toolText = step.toolName ? ` via ${step.toolName}` : '';
        console.log(`- ${step.id} [${step.phase}${toolText}]: ${step.message}`);
      }
      console.log();
    }

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
    const status = await new StatusService().showStatus();
    console.log(status);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
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
