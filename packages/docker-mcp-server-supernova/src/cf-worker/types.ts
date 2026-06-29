// Types for Docker MCP Cloudflare Worker

export interface Env {
  MCP_AGENT: DurableObjectNamespace;
  API_KEYS: KVNamespace;
}

export interface ApiKeyRecord {
  userId: string;
  tier: 'free' | 'standard' | 'premium';
  createdAt: string;
  active: boolean;
}

export interface UserState {
  userId: string;
  tier: 'free' | 'standard' | 'premium';
  toolCallsToday: number;
  lastReset: string;
  // Per-tier limits
  maxToolCallsPerDay: number;
}

export const TIER_LIMITS: Record<string, number> = {
  free: 50,       // 50 tool calls/day
  standard: 500,  // 500 tool calls/day (unlimited in practice for $19/mo)
  premium: 5000,  // 5000 tool calls/day
};

export interface ToolRequest {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResponse {
  content: Array<{ type: 'text' | 'image'; text?: string; data?: string }>;
  isError?: boolean;
}
