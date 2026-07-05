# Vendored Supernova Docker MCP Server

This package is a vendored Docker MCP server used by the root `infra-react-agent` CLI.
It is not the user-facing product surface and is not published from this repository.

## Role in this repo

- The root CLI builds it with `npm run build:supernova-mcp`.
- `DockerMcpGateway` starts `node packages/docker-mcp-server-supernova/dist/index.js` by default.
- Runtime mutations still pass through the root project's approval gate, route table, and policy checks.
- This package is treated as a runtime plugin implementation, not as an independent test target in this repository.

## Local commands

```bash
npm --prefix packages/docker-mcp-server-supernova install
npm --prefix packages/docker-mcp-server-supernova run build
```

## Boundary

Do not expose this package directly to the ReAct agent as a broad Docker API surface.
The final workflow goes through the root `DockerMcpGateway` and its narrow typed operations.