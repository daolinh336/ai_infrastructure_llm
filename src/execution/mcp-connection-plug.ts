import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';

// --- JSON-RPC Types ---

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface McpToolContent {
  type: 'text';
  text: string;
}

interface PendingRequest {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// --- McpServerCapabilities ---

export interface McpServerInfo {
  name: string;
  version: string;
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

// --- McpConnectionPlugOptions ---

export interface McpConnectionPlugOptions {
  /** Command to spawn the MCP server subprocess (e.g. 'npx') */
  command: string;
  /** Arguments for the command (e.g. ['-y', '@modelcontextprotocol/server-docker']) */
  args: string[];
  /** Timeout for individual JSON-RPC requests in milliseconds */
  requestTimeoutMs?: number;
  /** Client identity sent during MCP handshake */
  clientInfo?: { name: string; version: string };
  /** Skip the MCP initialize handshake (for testing) */
  skipHandshake?: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CLIENT_INFO = { name: 'infra-react-agent', version: '0.1.0' };

// --- McpConnectionPlug ---

/**
 * Generic MCP transport layer.
 *
 * Spawns an MCP server subprocess, communicates via JSON-RPC 2.0 over
 * stdin/stdout, and manages the connection lifecycle.
 *
 * This class is transport-only — it knows nothing about Docker, approval
 * gates, or mutation categories. Those concerns belong to higher layers.
 */
export class McpConnectionPlug {
  private child: ChildProcess | null = null;
  private readline: ReadlineInterface | null = null;
  private requestId = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  private connected = false;
  private shutdownRequested = false;
  private serverInfoInternal: McpServerInfo | null = null;
  private serverToolsInternal: McpToolDefinition[] | null = null;

  private readonly command: string;
  private readonly args: string[];
  private readonly requestTimeoutMs: number;
  private readonly clientInfo: { name: string; version: string };
  private readonly skipHandshake: boolean;

  constructor(options: McpConnectionPlugOptions) {
    this.command = options.command;
    this.args = options.args;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.clientInfo = options.clientInfo ?? DEFAULT_CLIENT_INFO;
    this.skipHandshake = options.skipHandshake ?? false;
  }

  /** Whether the MCP connection is established and ready for tool calls. */
  get isConnected(): boolean {
    return this.connected;
  }

  /** Server information returned during the MCP handshake. */
  get serverInfo(): McpServerInfo | null {
    return this.serverInfoInternal;
  }

  // --- Lifecycle ---

  /**
   * Spawn the MCP server subprocess and perform the protocol handshake.
   * After this resolves the plug is ready for `callTool()`.
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    this.shutdownRequested = false;
    this.child = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    this.child.on('error', (err) => {
      if (!this.shutdownRequested) this.rejectAllPending(err);
    });

    this.child.on('exit', (code, signal) => {
      if (!this.shutdownRequested) {
        this.rejectAllPending(
          new Error('MCP server exited unexpectedly (code=' + code + ', signal=' + signal + ')'),
        );
      }
      this.connected = false;
    });

    const stdout = this.child.stdout;
    if (!stdout) throw new Error('MCP server stdout not available');
    this.readline = createInterface({
      input: stdout,
      crlfDelay: Infinity,
    });

    this.readline.on('line', (line: string) => { this.handleLine(line); });
    this.readline.on('close', () => {
      if (!this.shutdownRequested) {
        this.rejectAllPending(new Error('MCP server stdout closed unexpectedly'));
      }
    });

    await new Promise<void>((resolve) => setImmediate(resolve));

    if (!this.child || !this.child.pid) {
      throw new Error('Failed to start MCP server subprocess');
    }

    if (!this.skipHandshake) await this.performHandshake();
    this.connected = true;
  }

  /**
   * Shut down the MCP server subprocess and clean up resources.
   */
  async disconnect(): Promise<void> {
    this.shutdownRequested = true;
    this.connected = false;
    this.serverInfoInternal = null;
    this.serverToolsInternal = null;
    this.rejectAllPending(new Error('MCP connection plug is disconnecting'));
    if (this.readline) { this.readline.close(); this.readline = null; }
    if (this.child) {
      try { if (this.child.stdin) this.child.stdin.end(); } catch { /* ignore */ }
      try { this.child.kill(); } catch { /* ignore */ }
      this.child = null;
    }
  }

  // --- Tool Operations ---

  /**
   * Call an MCP tool by name and return the raw text result.
   *
   * This is a generic call — no mutation guard, no routing.
   * Higher layers are responsible for authorization and routing.
   */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    this.ensureConnected();
    const result = await this.sendRequest('tools/call', { name: toolName, arguments: args });
    const toolResult = result as unknown as { content?: McpToolContent[]; isError?: boolean };
    const text = (toolResult.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    if (toolResult.isError) {
      throw new Error('MCP tool error: ' + text);
    }
    return text;
  }

  /**
   * Query the MCP server for its list of available tools.
   * Caches the result after first call; re-queries on reconnect.
   */
  async listTools(): Promise<McpToolDefinition[]> {
    this.ensureConnected();
    if (this.serverToolsInternal !== null) {
      return this.serverToolsInternal;
    }
    const result = await this.sendRequest('tools/list', {});
    const toolsResult = result as unknown as { tools?: McpToolDefinition[] };
    this.serverToolsInternal = toolsResult.tools ?? [];
    return this.serverToolsInternal;
  }

  // --- Internal ---

  private async performHandshake(): Promise<void> {
    const result = await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: this.clientInfo,
    });
    if (!result || !result.serverInfo) {
      throw new Error('MCP handshake failed: server did not return serverInfo');
    }
    const info = result.serverInfo as Record<string, unknown>;
    this.serverInfoInternal = {
      name: String(info.name ?? 'unknown'),
      version: String(info.version ?? 'unknown'),
    };
    this.sendNotification('notifications/initialized', {});
    const toolsResult = await this.sendRequest('tools/list', {});
    this.serverToolsInternal = (toolsResult as { tools?: McpToolDefinition[] }).tools ?? [];
  }

  private ensureConnected(): void {
    if (!this.connected) throw new Error('McpConnectionPlug not connected');
  }

  private sendRequest(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      if (!this.child?.stdin?.writable) {
        reject(new Error('MCP server stdin not available'));
        return;
      }
      const id = this.requestId++;
      const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('MCP request timed out (' + this.requestTimeoutMs + 'ms): ' + method));
      }, this.requestTimeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify(request) + '\n', 'utf8');
    });
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    if (!this.child?.stdin?.writable) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n', 'utf8');
  }

  private handleLine(line: string): void {
    let response: JsonRpcResponse;
    try {
      response = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }
    if (response.id === undefined || response.id === null) return;
    const pending = this.pendingRequests.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingRequests.delete(response.id);
    if (response.error) {
      pending.reject(new Error('MCP error (code=' + response.error.code + '): ' + response.error.message));
    } else {
      pending.resolve(response.result ?? {});
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [_id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }
}
