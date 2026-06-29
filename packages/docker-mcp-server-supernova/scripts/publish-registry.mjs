#!/usr/bin/env node
// Publish server.json to MCP Registry
// Usage: REGISTRY_JWT=xxx node scripts/publish-registry.mjs

import { readFileSync } from 'fs';
import { resolve } from 'path';

const REGISTRY_URL = 'https://registry.modelcontextprotocol.io';
const jwt = process.env.REGISTRY_JWT;

if (!jwt) {
  console.error('REGISTRY_JWT environment variable is required');
  process.exit(1);
}

const serverJson = readFileSync(resolve('server.json'), 'utf8');

console.log('Publishing to MCP Registry...');

const resp = await fetch(`${REGISTRY_URL}/v0.1/publish`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${jwt}`,
  },
  body: serverJson,
});

const data = await resp.json();
console.log('Response:', JSON.stringify(data, null, 2));

if (data.name) {
  console.log('Published to MCP Registry');
} else if (data.error) {
  console.error('Publish failed:', data.error);
  process.exit(1);
} else {
  console.error('Unexpected response');
  process.exit(1);
}
