# Security

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it responsibly.

**Email:** security@friendlygeorge.org

Please do not file public GitHub issues for security bugs.

## Supported Versions

The latest release on npm (`@supernova123/docker-mcp-server`) is the only supported version. Security fixes are applied to the latest release only.

## Threat Model

This server has **full Docker daemon access** via the Docker socket (`/var/run/docker.sock`). It is designed for **local development and trusted environments**.

**In scope:**
- Input validation on all tool parameters (command injection, path traversal, env injection)
- Output sanitization (ANSI escape stripping, invisible Unicode removal, output size caps)
- Schema-level bounds on all numeric and array parameters

**Out of scope:**
- Exposing this server to untrusted users or the public internet
- Running in multi-tenant environments without additional isolation
- Docker socket access control (by design, the server needs full daemon access)

**Key security properties:**
- No embedded credentials — the server uses the Docker socket, not API tokens
- No network egress — all communication is local Docker API calls
- Zod input validation on every tool parameter
- Output sanitization prevents prompt injection via command output
- Read-only tools marked with `readOnlyHint: true` in MCP metadata

## Security Hardening (v0.2.5+)

Starting with v0.2.5, the server includes:
- **Command validation:** `exec_in_container` rejects shell metacharacters and enforces POSIX path rules
- **Path validation:** `build_image` restricts build context to local absolute paths (no URLs)
- **Output sanitization:** ANSI escapes, invisible Unicode, and Docker stream headers are stripped
- **Output size caps:** Log output capped at 100KB, general output at 1MB
- **Parameter bounds:** Command arrays limited to 50 args, env to 50 vars, log tail to 10K lines
- **Timeout enforcement:** Health watch (600s max), event listening (300s max)

## Dependencies

Run `npm audit` regularly. The CI pipeline includes `npm audit --audit-level=high` on every push.

## License

MIT — see [LICENSE](LICENSE) for details.
