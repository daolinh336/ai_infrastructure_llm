# Vendored Supernova Docker MCP Server

This package is a vendored Docker MCP server used by the root `infra-react-agent` CLI.
It is not the user-facing product surface and is not published from this repository.

## Role in this repo

- Root CLI builds it with `npm run build:supernova-mcp`.
- `DockerMcpGateway` starts `node packages/docker-mcp-server-supernova/dist/index.js` by default.
- Runtime mutations still pass through the root project's approval gate, route table, and policy checks.
- Tests for this package stay here to verify the vendored server still builds and exposes the tool behavior expected by the root gateway.

## Local commands

```bash
npm --prefix packages/docker-mcp-server-supernova install
npm --prefix packages/docker-mcp-server-supernova run build
npm --prefix packages/docker-mcp-server-supernova test
```

## Boundary

Do not expose this package directly to the ReAct agent as a broad Docker API surface.
The final workflow goes through the root `DockerMcpGateway` and its narrow typed operations.
