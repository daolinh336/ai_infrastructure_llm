import { DurableObject } from "cloudflare:workers";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { TIER_LIMITS, type UserState, type Env } from "./types.js";

/**
 * McpAgentDO — Durable Object that hosts a per-user MCP server.
 *
 * Each user gets their own DO instance (deterministic ID from userId).
 * The DO holds per-user state (rate limits, tier) and proxies tool
 * calls to the user's Docker daemon via Cloudflare Tunnel.
 *
 * Architecture:
 *   Routing Worker (auth, CORS) → McpAgentDO (tool dispatch) → User's Docker daemon
 */
export class McpAgentDO extends DurableObject {
  private state: DurableObjectState;
  private userState: UserState | null = null;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.state = state;
  }

  async initialize(userId: string, tier: string): Promise<void> {
    const existing = await this.state.storage.get<UserState>("userState");
    if (!existing) {
      const newUser: UserState = {
        userId,
        tier: tier as UserState["tier"],
        toolCallsToday: 0,
        lastReset: new Date().toISOString().split("T")[0],
        maxToolCallsPerDay: TIER_LIMITS[tier] || TIER_LIMITS.free,
      };
      await this.state.storage.put("userState", newUser);
      this.userState = newUser;
    } else {
      this.userState = existing;
      // Reset daily counter if needed
      const today = new Date().toISOString().split("T")[0];
      if (existing.lastReset !== today) {
        existing.toolCallsToday = 0;
        existing.lastReset = today;
        await this.state.storage.put("userState", existing);
      }
    }
  }


  async setTunnelUrl(url: string): Promise<{ ok: boolean; tunnelUrl: string }> {
    // Validate URL format
    try {
      new URL(url);
    } catch {
      return { ok: false, tunnelUrl: "" };
    }
    await this.state.storage.put("tunnelUrl", url);
    return { ok: true, tunnelUrl: url };
  }

  async getTunnelUrl(): Promise<string> {
    return (await this.state.storage.get<string>("tunnelUrl")) || "";
  }

  async handleMcpRequest(request: Request): Promise<Response> {
    if (!this.userState) {
      return new Response("User not initialized", { status: 500 });
    }

    // Check rate limit
    if (this.userState.toolCallsToday >= this.userState.maxToolCallsPerDay) {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: `Rate limit exceeded: ${this.userState.maxToolCallsPerDay} calls/day for ${this.userState.tier} tier`,
          },
          id: null,
        }),
        { status: 429, headers: { "Content-Type": "application/json" } }
      );
    }

    // Create MCP server for this request
    const server = this.createServer();
    const transport = new WebStandardStreamableHTTPServerTransport();

    await server.connect(transport);
    const response = await transport.handleRequest(request);

    // Increment counter on successful tool call
    this.userState.toolCallsToday++;
    await this.state.storage.put("userState", this.userState);

    return response;
  }

  private createServer(): McpServer {
    const server = new McpServer({
      name: "docker-mcp-hosted",
      version: "0.4.0",
    });

    // ── Container Management ──────────────────────────────────
    server.registerTool(
      "list_containers",
      { description: "List Docker containers with optional filters" },
      async () => this.proxyToDocker("list_containers", {})
    );

    server.registerTool(
      "inspect_container",
      {
        description: "Get detailed info about a Docker container",
        inputSchema: { name: z.string() },
      },
      async ({ name }) => this.proxyToDocker("inspect_container", { name })
    );

    server.registerTool(
      "start_container",
      {
        description: "Start a stopped Docker container",
        inputSchema: { name: z.string() },
      },
      async ({ name }) => this.proxyToDocker("start_container", { name })
    );

    server.registerTool(
      "stop_container",
      {
        description: "Stop a running Docker container",
        inputSchema: { name: z.string(), timeout: z.number().optional() },
      },
      async ({ name, timeout }) =>
        this.proxyToDocker("stop_container", { name, timeout })
    );

    server.registerTool(
      "restart_container",
      {
        description: "Restart a Docker container",
        inputSchema: { name: z.string() },
      },
      async ({ name }) => this.proxyToDocker("restart_container", { name })
    );

    server.registerTool(
      "remove_container",
      {
        description: "Remove a Docker container",
        inputSchema: { name: z.string(), force: z.boolean().optional() },
      },
      async ({ name, force }) =>
        this.proxyToDocker("remove_container", { name, force })
    );

    server.registerTool(
      "create_container",
      {
        description: "Create a new Docker container from an image",
        inputSchema: {
          image: z.string(),
          name: z.string().optional(),
          ports: z.record(z.string()).optional(),
          env: z.record(z.string()).optional(),
          volumes: z.array(z.string()).optional(),
        },
      },
      async (params) => this.proxyToDocker("create_container", params)
    );

    // ── Compose Lifecycle ─────────────────────────────────────
    server.registerTool(
      "compose_up",
      {
        description: "Start services defined in a docker-compose.yml file",
        inputSchema: {
          project: z.string(),
          path: z.string().optional(),
          detach: z.boolean().optional(),
        },
      },
      async (params) => this.proxyToDocker("compose_up", params)
    );

    server.registerTool(
      "compose_down",
      {
        description: "Stop and remove services defined in a docker-compose.yml file",
        inputSchema: { project: z.string(), path: z.string().optional() },
      },
      async (params) => this.proxyToDocker("compose_down", params)
    );

    server.registerTool(
      "compose_ps",
      {
        description: "List services in a Compose project",
        inputSchema: { project: z.string() },
      },
      async ({ project }) => this.proxyToDocker("compose_ps", { project })
    );

    server.registerTool(
      "compose_logs",
      {
        description: "Get logs from Compose services",
        inputSchema: {
          project: z.string(),
          service: z.string().optional(),
          tail: z.number().optional(),
        },
      },
      async (params) => this.proxyToDocker("compose_logs", params)
    );

    // ── Monitoring ────────────────────────────────────────────
    server.registerTool(
      "fleet_status",
      {
        description: "Get status overview of all Docker containers",
      },
      async () => this.proxyToDocker("fleet_status", {})
    );

    server.registerTool(
      "search_logs",
      {
        description: "Search container logs by keyword",
        inputSchema: {
          name: z.string(),
          query: z.string(),
          tail: z.number().optional(),
        },
      },
      async (params) => this.proxyToDocker("search_logs", params)
    );

    server.registerTool(
      "watch_events",
      {
        description: "Stream Docker daemon events (containers, images, networks)",
        inputSchema: { since: z.string().optional() },
      },
      async (params) => this.proxyToDocker("watch_events", params)
    );

    // ── Image Management ──────────────────────────────────────
    server.registerTool(
      "list_images",
      { description: "List Docker images on the host" },
      async () => this.proxyToDocker("list_images", {})
    );

    server.registerTool(
      "pull_image",
      {
        description: "Pull a Docker image from a registry",
        inputSchema: { image: z.string() },
      },
      async ({ image }) => this.proxyToDocker("pull_image", { image })
    );

    // ── Network & Volume ──────────────────────────────────────
    server.registerTool(
      "list_networks",
      { description: "List Docker networks" },
      async () => this.proxyToDocker("list_networks", {})
    );

    server.registerTool(
      "list_volumes",
      { description: "List Docker volumes" },
      async () => this.proxyToDocker("list_volumes", {})
    );

    return server;
  }

  /**
   * Proxy a tool call to the user's Docker daemon via Cloudflare Tunnel.
   *
   * Architecture: The user runs `docker-mcp-server` locally, exposed via
   * `cloudflared tunnel`. This DO forwards the tool call request to that
   * endpoint. The tunnel URL is stored per-user in KV or passed at init.
   *
   * For now, returns a placeholder response. Real implementation connects
   * to the user's tunnel endpoint.
   */
  private async proxyToDocker(
    tool: string,
    args: Record<string, unknown>
  ): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    // TODO: Connect to user's Cloudflare Tunnel endpoint
    // The tunnel URL should be stored in KV or passed during user setup.
    // For now, return a structured placeholder.
    const tunnelUrl = await this.state.storage.get<string>("tunnelUrl");

    if (!tunnelUrl) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "No Docker tunnel configured. Please set up a Cloudflare Tunnel to connect your Docker daemon.",
              tool,
              args,
            }),
          },
        ],
      };
    }

    // Forward the tool call to the user's tunnel
    try {
      const response = await fetch(tunnelUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/call",
          params: { name: tool, arguments: args },
          id: crypto.randomUUID(),
        }),
      });

      const result = (await response.json()) as {
        result?: { content: Array<{ type: string; text: string }> };
        error?: { message: string };
      };

      if (result.error) {
        return {
          content: [{ type: "text", text: `Error: ${result.error.message}` }],
        };
      }

      if (result.result?.content) {
        return {
          content: result.result.content.map((c) => ({
            type: "text" as const,
            text: c.text || "",
          })),
        };
      }

      return { content: [{ type: "text", text: "No result" }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Tunnel connection failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  }
}
