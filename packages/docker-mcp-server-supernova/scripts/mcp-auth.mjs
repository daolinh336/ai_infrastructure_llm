#!/usr/bin/env node
// Authenticate with MCP Registry via GitHub OIDC
// Usage: node scripts/mcp-auth.mjs
// Outputs: registry_jwt to stdout

const REGISTRY_URL = 'https://registry.modelcontextprotocol.io';

// Step 1: Get GitHub OIDC token
const oidcUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
const oidcToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

if (!oidcUrl || !oidcToken) {
  console.error('ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN are required');
  console.error('These are automatically available in GitHub Actions with id-token: write permission');
  process.exit(1);
}

console.error('Requesting GitHub OIDC token...');

const audience = 'registry.modelcontextprotocol.io';
const tokenResp = await fetch(`${oidcUrl}&audience=${audience}`, {
  headers: { 'Authorization': `bearer ${oidcToken}` },
});

if (!tokenResp.ok) {
  console.error(`Failed to get OIDC token: ${tokenResp.status} ${await tokenResp.text()}`);
  process.exit(1);
}

const { value: githubToken } = await tokenResp.json();
console.error(`Got OIDC token (${githubToken.length} chars)`);

// Step 2: Exchange for registry JWT
console.error('Authenticating with MCP Registry...');

const authResp = await fetch(`${REGISTRY_URL}/v0.1/auth/github-oidc`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: githubToken }),
});

const authData = await authResp.json();
const jwt = authData.registry_token || authData.token || authData.jwt;

if (!jwt) {
  console.error('Failed to authenticate:', JSON.stringify(authData));
  process.exit(1);
}

console.error('Authenticated with MCP Registry');

// Output JWT to stdout (consumed by publish script)
process.stdout.write(jwt);
