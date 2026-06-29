# Contributing to Docker MCP Server

Thanks for your interest in contributing! This server gives AI agents structured access to Docker through 50 tools. Contributions that improve reliability, add tools, or fix edge cases are welcome.

## Getting Started

1. Fork and clone the repo:
   ```bash
   git clone https://github.com/YOUR_USERNAME/docker-mcp-server.git
   cd docker-mcp-server
   npm install
   ```

2. Run the tests:
   ```bash
   npx vitest run
   ```

3. Start the server locally:
   ```bash
   npx ts-node src/index.ts
   ```

## Development Workflow

- Tools are organized by domain in `src/tools/` (container.ts, image.ts, volume.ts, etc.)
- Tool schemas are defined in `src/types.ts`
- Tools are registered in `src/server.ts`
- Tests live in `tests/` — one test file per tool domain

### Adding a New Tool

1. Add the Zod input schema to `src/types.ts`
2. Create or extend a tool file in `src/tools/`
3. Register it in `src/server.ts` via `server.tool()`
4. Write tests in `tests/` — mock the Docker Engine API responses
5. Update the README with tool description and usage

### Testing Conventions

- Tests mock HTTP calls to the Docker Engine API (`/var/run/docker.sock`)
- Use `vi.mock('undici')` or similar for HTTP mocking
- Each test file covers one tool domain with 3-5 test cases
- Run `npx vitest run` before submitting

## What We're Looking For

**High value:**
- New tools for Docker features not yet covered (e.g., Docker Buildx, Docker Compose v2 specific operations)
- Better error messages for common Docker failures
- Performance improvements for batch operations
- Support for remote Docker hosts

**Medium value:**
- Documentation improvements
- Test coverage for edge cases (Docker-in-Docker, rootless Docker, podman)
- README examples showing real agent workflows

**Skip:**
- Tools that modify container state without clear agent use cases
- Windows Docker support (out of scope)
- Kubernetes integration (separate project)

## Code Style

- TypeScript strict mode
- Minimize external dependencies
- Use the Docker Engine API directly via Unix socket — no Docker CLI wrapping
- Handle API errors gracefully with structured error responses

## Submitting Changes

1. Create a branch: `git checkout -b tool/add-buildx-support`
2. Make your changes with tests
3. Ensure all tests pass: `npx vitest run`
4. Commit with a clear message: `feat: add buildx_build tool for Docker Buildx`
5. Open a PR with a description of what the tool does and why it's useful

## Questions?

Open a [GitHub Discussion](https://github.com/friendlygeorge/docker-mcp-server/discussions) or comment on an existing issue.
