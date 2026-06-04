import { Command } from 'commander';
import chalk from 'chalk';
import { ReActAgent } from './agent/react-agent.js';
import { cliInputSchema } from './domain/schemas.js';
import { ExecutionEngine } from './execution/execution-engine.js';
import { createProvider } from './llm/provider.js';
import { getStateFilePath } from './state/file-state-store.js';
import { StatusService } from './status/status-service.js';

const program = new Command();

program
  .name('infra-react-agent')
  .description('Natural-language infrastructure management CLI with a ReAct-style agent')
  .version('0.1.0');

program
  .command('plan')
  .description('Analyze a natural-language infrastructure request and produce a plan')
  .argument('<prompt>', 'Natural-language request describing the target infrastructure')
  .option('--dry-run', 'Render outputs without executing changes', true)
  .option('--provider <provider>', 'LLM provider to use (openai|gemini|ollama)', 'openai')
  .action(async (prompt, options) => {
    const input = cliInputSchema.parse({
      prompt,
      dryRun: options.dryRun ?? true,
      provider: options.provider,
    });


    /// react agent bat dau lam viec: thought -> action -> xem log
    const agent = new ReActAgent(createProvider(input.provider));
    const engine = new ExecutionEngine();
    const result = await agent.run({ raw: input.prompt });


    /// chay thu hoac chay that
    const execution = input.dryRun
      ? await engine.dryRun(result)
      : await engine.apply(result);


    //in bao cao ra teminal

    console.log(chalk.cyan('Summary:'));
    console.log(result.plan.summary);
    console.log();

    console.log(chalk.cyan('Observations:'));
    for (const observation of result.observations) {
      console.log(`- [${observation.source}] ${observation.message}`);
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

    console.log(chalk.cyan('Generated docker-compose.yaml:'));
    console.log(execution.composeYaml);
    console.log();

    console.log(chalk.cyan('State file:'));
    console.log(getStateFilePath());
    console.log();

    console.log(
      input.dryRun
        ? chalk.yellow('Dry run only. No deployment executed.')
        : chalk.green('State saved. Deployment hooks can be added next.'),
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
