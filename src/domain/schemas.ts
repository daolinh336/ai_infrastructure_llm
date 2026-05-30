import { z } from 'zod';

export const cliInputSchema = z.object({
  prompt: z.string().min(1, 'Prompt must not be empty.'),
  dryRun: z.boolean().default(false),
  provider: z.enum(['openai', 'gemini', 'ollama']).default('openai'),
});

export type CliInput = z.infer<typeof cliInputSchema>;
