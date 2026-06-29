import { McpAgentDO } from "./mcp-agent.js";
import type { Env, ApiKeyRecord } from "./types.js";

// Re-export Durable Object for wrangler
export { McpAgentDO };

type McpAgentStub = DurableObjectStub<McpAgentDO>;

/**
 * Docker MCP Cloudflare Worker — Routing Layer
 *
 * Architecture:
 *   Client (Claude/Cursor/Agent)
 *     → Routing Worker (this file: auth, CORS, rate limiting)
 *       → McpAgentDO (per-user Durable Object: tool dispatch)
 *         → User's Docker daemon via Cloudflare Tunnel
 *
 * Free tier: read-only tools, 50 calls/day
 * Standard tier ($19/mo): full access, 500 calls/day
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, mcp-session-id, mcp-protocol-version, Authorization",
  "Access-Control-Expose-Headers": "mcp-session-id",
  "Access-Control-Max-Age": "86400",
}
const LANDING_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Docker MCP Hosted — Managed Docker Infrastructure for AI Agents</title>
  <meta name="description" content="Run your AI agent's Docker tools in the cloud. Hosted MCP server with health checks, auto-restart, and per-user isolation. Free tier available.">
  <style>
    :root {
      --bg: #0a0a0f;
      --surface: #12121a;
      --border: #1e1e2e;
      --text: #e4e4e7;
      --muted: #71717a;
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --green: #22c55e;
      --orange: #f59e0b;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
    }
    .container { max-width: 960px; margin: 0 auto; padding: 0 24px; }
    
    /* Nav */
    nav {
      border-bottom: 1px solid var(--border);
      padding: 16px 0;
    }
    nav .container {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .logo { font-size: 18px; font-weight: 700; color: var(--text); text-decoration: none; }
    .logo span { color: var(--accent); }
    nav a { color: var(--muted); text-decoration: none; font-size: 14px; }
    nav a:hover { color: var(--text); }

    /* Hero */
    .hero {
      padding: 80px 0 60px;
      text-align: center;
    }
    .hero h1 {
      font-size: 48px;
      font-weight: 800;
      line-height: 1.1;
      margin-bottom: 20px;
      letter-spacing: -0.02em;
    }
    .hero h1 span { color: var(--accent); }
    .hero p {
      font-size: 18px;
      color: var(--muted);
      max-width: 600px;
      margin: 0 auto 32px;
    }
    .hero-buttons { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
    .btn {
      display: inline-block;
      padding: 12px 28px;
      border-radius: 8px;
      font-size: 15px;
      font-weight: 600;
      text-decoration: none;
      transition: all 0.15s;
      cursor: pointer;
      border: none;
    }
    .btn-primary { background: var(--accent); color: white; }
    .btn-primary:hover { background: var(--accent-hover); }
    .btn-secondary { background: var(--surface); color: var(--text); border: 1px solid var(--border); }
    .btn-secondary:hover { border-color: var(--accent); }

    /* Install command */
    .install {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px 24px;
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 14px;
      color: var(--green);
      margin-top: 24px;
      display: inline-block;
    }
    .install .comment { color: var(--muted); }

    /* Features */
    .features {
      padding: 60px 0;
      border-top: 1px solid var(--border);
    }
    .features h2 {
      text-align: center;
      font-size: 28px;
      margin-bottom: 48px;
    }
    .feature-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 24px;
    }
    .feature-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
    }
    .feature-card h3 {
      font-size: 16px;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .feature-card p { color: var(--muted); font-size: 14px; }
    .icon { font-size: 20px; }

    /* Pricing */
    .pricing {
      padding: 60px 0;
      border-top: 1px solid var(--border);
    }
    .pricing h2 {
      text-align: center;
      font-size: 28px;
      margin-bottom: 12px;
    }
    .pricing .subtitle {
      text-align: center;
      color: var(--muted);
      margin-bottom: 48px;
    }
    .pricing-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 24px;
      max-width: 700px;
      margin: 0 auto;
    }
    .pricing-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 32px;
    }
    .pricing-card.featured {
      border-color: var(--accent);
      position: relative;
    }
    .pricing-card.featured::before {
      content: 'MOST POPULAR';
      position: absolute;
      top: -12px;
      left: 50%;
      transform: translateX(-50%);
      background: var(--accent);
      color: white;
      font-size: 11px;
      font-weight: 700;
      padding: 4px 12px;
      border-radius: 4px;
      letter-spacing: 0.05em;
    }
    .pricing-card h3 { font-size: 20px; margin-bottom: 4px; }
    .price { font-size: 36px; font-weight: 800; margin: 16px 0; }
    .price span { font-size: 16px; font-weight: 400; color: var(--muted); }
    .pricing-card ul { list-style: none; margin: 24px 0; }
    .pricing-card li {
      padding: 8px 0;
      font-size: 14px;
      color: var(--muted);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .pricing-card li::before { content: '✓'; color: var(--green); font-weight: 700; }

    /* How it works */
    .how {
      padding: 60px 0;
      border-top: 1px solid var(--border);
    }
    .how h2 {
      text-align: center;
      font-size: 28px;
      margin-bottom: 48px;
    }
    .steps {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 32px;
      max-width: 800px;
      margin: 0 auto;
    }
    .step { text-align: center; }
    .step-num {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: var(--accent);
      color: white;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 16px;
      margin-bottom: 16px;
    }
    .step h3 { font-size: 16px; margin-bottom: 8px; }
    .step p { color: var(--muted); font-size: 14px; }

    /* FAQ */
    .faq {
      padding: 60px 0;
      border-top: 1px solid var(--border);
    }
    .faq h2 {
      text-align: center;
      font-size: 28px;
      margin-bottom: 48px;
    }
    .faq-item {
      border-bottom: 1px solid var(--border);
      padding: 20px 0;
    }
    .faq-item h3 { font-size: 16px; margin-bottom: 8px; }
    .faq-item p { color: var(--muted); font-size: 14px; }

    /* Footer */
    footer {
      border-top: 1px solid var(--border);
      padding: 32px 0;
      text-align: center;
      color: var(--muted);
      font-size: 13px;
    }
    footer a { color: var(--muted); text-decoration: none; }
    footer a:hover { color: var(--text); }
  </style>
</head>
<body>
  <nav>
    <div class="container">
      <a href="/" class="logo">docker<span>mcp</span></a>
      <div style="display:flex;gap:20px;">
        <a href="#pricing">Pricing</a>
        <a href="#how">Get Started</a>
        <a href="https://github.com/friendlygeorge/docker-mcp-server">GitHub</a>
      </div>
    </div>
  </nav>

  <section class="hero">
    <div class="container">
      <h1>Your agent's Docker tools,<br><span>hosted in the cloud</span></h1>
      <p>Stop managing MCP server deployments. Connect your AI agent to Docker via a managed endpoint — health checks, auto-restart, and per-user isolation included.</p>
      <div class="hero-buttons">
        <a href="#pricing" class="btn btn-primary">Start Free</a>
        <a href="https://github.com/friendlygeorge/docker-mcp-server" class="btn btn-secondary">View on GitHub</a>
      </div>
      <div class="install">
        <span class="comment"># Connect in one command:</span><br>
        npx @supernova123/docker-mcp-server --hosted
      </div>
    </div>
  </section>

  <section class="features">
    <div class="container">
      <h2>Everything your agent needs to manage Docker</h2>
      <div class="feature-grid">
        <div class="feature-card">
          <h3><span class="icon">🔍</span> Health Checks</h3>
          <p>Continuous container health monitoring with configurable thresholds. Your agent knows when something is wrong before you do.</p>
        </div>
        <div class="feature-card">
          <h3><span class="icon">🔄</span> Auto-Restart</h3>
          <p>Crashed containers restart automatically. Set restart policies per-container and let your agent handle the rest.</p>
        </div>
        <div class="feature-card">
          <h3><span class="icon">📊</span> Live Monitoring</h3>
          <p>Real-time container stats, log streaming, and event watching. 39 tools covering the full Docker lifecycle.</p>
        </div>
        <div class="feature-card">
          <h3><span class="icon">🏗️</span> Compose Management</h3>
          <p>Deploy, monitor, and manage multi-container applications. docker-compose up, down, logs, and restart — all via MCP.</p>
        </div>
        <div class="feature-card">
          <h3><span class="icon">🔐</span> Per-User Isolation</h3>
          <p>Each user gets their own Durable Object with isolated state and rate limits. No cross-tenant data leakage.</p>
        </div>
        <div class="feature-card">
          <h3><span class="icon">⚡</span> Zero Config</h3>
          <p>No servers to manage. No Docker daemon to expose. Just connect your agent and start working.</p>
        </div>
      </div>
    </div>
  </section>

  <section class="pricing" id="pricing">
    <div class="container">
      <h2>Simple, transparent pricing</h2>
      <p class="subtitle">Start free. Upgrade when you need more.</p>
      <div class="pricing-grid">
        <div class="pricing-card">
          <h3>Free</h3>
          <div class="price">$0 <span>/month</span></div>
          <ul>
            <li>Read-only tools (inspect, list, logs)</li>
            <li>50 requests/day</li>
            <li>Community support</li>
            <li>Single Docker host</li>
          </ul>
          <a href="#" class="btn btn-secondary" style="width:100%;text-align:center;">Get Started</a>
        </div>
        <div class="pricing-card featured">
          <h3>Standard</h3>
          <div class="price">$19 <span>/month</span></div>
          <ul>
            <li>All 39 Docker tools</li>
            <li>500 requests/day</li>
            <li>Health checks & auto-restart</li>
            <li>Container exec & file transfer</li>
            <li>Priority support</li>
          </ul>
          <a href="#" class="btn btn-primary" style="width:100%;text-align:center;">Subscribe</a>
        </div>
      </div>
    </div>
  </section>

  <section class="how" id="how">
    <div class="container">
      <h2>Up and running in 3 steps</h2>
      <div class="steps">
        <div class="step">
          <div class="step-num">1</div>
          <h3>Connect your Docker host</h3>
          <p>Install Cloudflare Tunnel on your machine. One command exposes your Docker daemon securely.</p>
        </div>
        <div class="step">
          <div class="step-num">2</div>
          <h3>Get your API key</h3>
          <p>Sign up and receive a unique API key. Free tier included, upgrade anytime.</p>
        </div>
        <div class="step">
          <div class="step-num">3</div>
          <h3>Point your agent</h3>
          <p>Add the hosted endpoint to your MCP client config. Your agent now has full Docker access.</p>
        </div>
      </div>
    </div>
  </section>

  <section class="faq">
    <div class="container">
      <h2>Frequently asked questions</h2>
      <div class="faq-item">
        <h3>How does my agent connect to my Docker host?</h3>
        <p>Through Cloudflare Tunnel. You run a lightweight tunnel on your machine that securely proxies Docker API calls. No ports exposed, no firewall changes needed.</p>
      </div>
      <div class="faq-item">
        <h3>Is my Docker data secure?</h3>
        <p>Yes. Each user gets an isolated Durable Object on Cloudflare's edge. Your Docker daemon is only accessible through your authenticated tunnel. We never see your container data.</p>
      </div>
      <div class="faq-item">
        <h3>What MCP clients are supported?</h3>
        <p>Any client that supports the MCP protocol: Claude Desktop, Cursor, Windsurf, Continue, and more. Just point it at the hosted endpoint.</p>
      </div>
      <div class="faq-item">
        <h3>Can I self-host instead?</h3>
        <p>Absolutely. The server is open source on GitHub. The hosted version is for people who want zero-ops convenience.</p>
      </div>
    </div>
  </section>

  <footer>
    <div class="container">
      <p>Built by <a href="https://github.com/friendlygeorge">Nova</a> · Open source under MIT · <a href="https://github.com/friendlygeorge/docker-mcp-server">GitHub</a></p>
    </div>
  </footer>
</body>
</html>`;
;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // ── Health check ──────────────────────────────────────────
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", version: "0.4.0" }),
        { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    // ── Landing page (no auth required) ──────────────────────
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(LANDING_PAGE, {
        headers: { "Content-Type": "text/html; charset=utf-8", ...CORS_HEADERS },
      });
    }

    // ── Authentication ────────────────────────────────────────
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Missing or invalid Authorization header. Use: Bearer <api-key>" }),
        { status: 401, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    const apiKey = authHeader.slice(7);
    const keyRecord = await env.API_KEYS.get<ApiKeyRecord>(apiKey, "json");

    if (!keyRecord || !keyRecord.active) {
      return new Response(
        JSON.stringify({ error: "Invalid or inactive API key" }),
        { status: 401, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    // ── Route to McpAgentDO ───────────────────────────────────
    if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
      // Deterministic DO ID per user — same user always hits same DO
      const doId = env.MCP_AGENT.idFromName(keyRecord.userId);
      const stub = env.MCP_AGENT.get(doId) as McpAgentStub;

      // Initialize the DO with user info (idempotent)
      await stub.initialize(keyRecord.userId, keyRecord.tier);

      // Forward the MCP request to the DO
      const doResponse = await stub.handleMcpRequest(request);

      // Add CORS headers to DO response
      const response = new Response(doResponse.body, {
        status: doResponse.status,
        headers: { ...Object.fromEntries(doResponse.headers), ...CORS_HEADERS },
      });

      return response;
    }


    // ── Tunnel URL registration ─────────────────────────────
    if (url.pathname === "/tunnel" && request.method === "POST") {
      const body = await request.json<{ tunnelUrl: string }>();
      if (!body?.tunnelUrl) {
        return new Response(
          JSON.stringify({ error: "Missing tunnelUrl in request body" }),
          { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
        );
      }

      const doId = env.MCP_AGENT.idFromName(keyRecord.userId);
      const stub = env.MCP_AGENT.get(doId) as McpAgentStub;
      await stub.initialize(keyRecord.userId, keyRecord.tier);
      const result = await stub.setTunnelUrl(body.tunnelUrl);

      if (!result.ok) {
        return new Response(
          JSON.stringify({ error: "Invalid tunnel URL. Must be a valid HTTPS URL." }),
          { status: 400, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
        );
      }

      return new Response(
        JSON.stringify({ ok: true, tunnelUrl: result.tunnelUrl }),
        { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    // ── Get tunnel URL ──────────────────────────────────────
    if (url.pathname === "/tunnel" && request.method === "GET") {
      const doId = env.MCP_AGENT.idFromName(keyRecord.userId);
      const stub = env.MCP_AGENT.get(doId) as McpAgentStub;
      await stub.initialize(keyRecord.userId, keyRecord.tier);
      const tunnelUrl = await stub.getTunnelUrl();

      return new Response(
        JSON.stringify({ tunnelUrl: tunnelUrl || null }),
        { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    // ── API key info (for debugging) ──────────────────────────
    if (url.pathname === "/me") {
      return new Response(
        JSON.stringify({
          userId: keyRecord.userId,
          tier: keyRecord.tier,
          active: keyRecord.active,
        }),
        { headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
      );
    }

    // ── 404 ───────────────────────────────────────────────────
    return new Response(
      JSON.stringify({ error: "Not found. Use POST /mcp for MCP requests." }),
      { status: 404, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
    );
  },
};