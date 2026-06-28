import type { z } from 'zod';
import type { AgentTool, AgentToolResult } from '../domain/types.js';

export type AgentToolCategory = 'read' | 'plan' | 'validate' | 'preview' | 'state';

export interface AgentToolDefinition extends AgentTool {
  category: AgentToolCategory;
  inputSchema?: z.ZodType<unknown>;
  outputSchema?: z.ZodType<unknown>;
}

export function defineAgentTool(tool: AgentToolDefinition): AgentToolDefinition {
  return {
    ...tool,
    async invoke(input: unknown): Promise<AgentToolResult> {
      let handlerInput = input;
      if (tool.inputSchema) {
        const parsedInput = tool.inputSchema.safeParse(input);
        if (!parsedInput.success) {
          return {
            ok: false,
            observation: `Tool ${tool.name} input validation failed: ${parsedInput.error.message}`,
            data: { issues: parsedInput.error.issues },
          };
        }
        handlerInput = parsedInput.data;
      }

      const result = await tool.invoke(handlerInput);
      if (!result.ok) return result;

      if (tool.outputSchema) {
        const parsedOutput = tool.outputSchema.safeParse(result.data);
        if (!parsedOutput.success) {
          return {
            ok: false,
            observation: `Tool ${tool.name} output validation failed: ${parsedOutput.error.message}`,
            data: { issues: parsedOutput.error.issues },
          };
        }
        return { ...result, data: parsedOutput.data };
      }

      return result;
    },
  };
}
