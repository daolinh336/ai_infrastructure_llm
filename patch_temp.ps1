const fs=require('fs');
const path='src/cli/plan-command.ts';
let text=fs.readFileSync(path,'utf8');
function replaceOnce(from,to){
 const next=text.replace(from,to);
 if(next===text) throw new Error('not found: '+from.slice(0,80));
 text=next;
}
replaceOnce(`    .option(
      '--save-state',
      'Persist the desired state snapshot without deploying Docker',
      false,
    )
`,'');
replaceOnce(`      const saveStateRequested = Boolean(options.saveState);
      const deployRequested = Boolean(options.deploy);
      const adjustRequested = Boolean(options.adjust);
      const input = cliInputSchema.parse({
        prompt,
        dryRun:
          deployRequested || saveStateRequested
            ? false
            : (options.dryRun ?? true),
`, `      const deployRequested = Boolean(options.deploy);
      const adjustRequested = Boolean(options.adjust);
      const input = cliInputSchema.parse({
        prompt,
        dryRun:
          deployRequested
            ? false
            : (options.dryRun ?? true),
`);
replaceOnce(`      if (adjustRequested && saveStateRequested) {
        console.error(chalk.red('CLI failed.'));
        console.error('--adjust không h? tr? --save-state. Ch? có hai k?t qu?: --deploy d? áp d?ng runtime, ho?c b? --deploy d? xem dry-run mà không luu gì.');
        process.exitCode = 1;
        return;
      }
`,'');
replaceOnce(`      const execution = deployRequested
        ? await engine.prepareDeploy(result)
        : input.dryRun
          ? await engine.dryRun(result)
          : await engine.savePendingPreview(result);
`, `      const execution = deployRequested
        ? await engine.prepareDeploy(result)
        : await engine.dryRun(result);
`);
replaceOnly? no. replaceOnce(`          : input.dryRun
            ? 'acting... render dry-run output and compose preview.'
            : 'acting... persist pending preview memory without Docker deployment.',`, `          : 'acting... render dry-run output and compose preview.',`);
replaceOnce(`          : input.dryRun
        console.log();
        return;
      }

      console.log(chalk.cyan('State database:'));
`, `        console.log();
        return;
      }

      console.log(chalk.cyan('State database:'));
`);
"@
# just run via temp file