import type { AgentToolResult } from '../domain/types.js';
import type { AgentToolDefinition } from './tool-types.js';

export class AgentToolRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentToolRegistryError';
  }
}

export class AgentToolRegistry {
  private readonly tools = new Map<string, AgentToolDefinition>();

  constructor(tools: AgentToolDefinition[] = []) {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  register(tool: AgentToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new AgentToolRegistryError(`Duplicate agent tool registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(toolName: string): AgentToolDefinition {
    const tool = this.tools.get(toolName);
    if (!tool) {
      throw new AgentToolRegistryError(`Unknown agent tool: ${toolName}`);
    }
    return tool;
  }

  listTools(): Array<Pick<AgentToolDefinition, 'name' | 'description' | 'category'>> {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      category: tool.category,
    }));
  }

  async invoke(toolName: string, input: unknown): Promise<AgentToolResult> {
    return this.get(toolName).invoke(input);
  }
}
