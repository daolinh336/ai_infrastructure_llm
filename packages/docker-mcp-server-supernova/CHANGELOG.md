# Changelog

## 0.4.2 (2026-06-20)

### Changed
- Added `homepage` and `bugs` fields to package.json for npm registry metadata completeness

## 0.4.1 (2026-06-18)

### Changed
- Expanded npm keywords from 27 to 51 for search visibility
- Fixed server version string to match package.json

## 0.4.0 (2026-06-16)

### Added
- **Registry operations:** `registry_login`, `registry_search`, `registry_push` — authenticate with Docker Hub, ECR, ACR, GCR; search for images; push images to registries
- **Security scanning:** `scan_image`, `vulnerability_report` — scan Docker images for CVEs using Trivy; generate detailed vulnerability reports with remediation recommendations
- **Context management:** `list_contexts`, `use_context`, `inspect_context` — switch between local/remote Docker hosts; inspect context configurations
- 8 new tools (42 → 50 total)
- Tier 1 features from v0.4.0 roadmap (registry, security, context)

### Changed
- Version bumped from 0.3.5 to 0.4.0
- Server name updated in McpServer constructor



## [0.3.5] - 2026-06-14

### Added
- `prune_containers` — Remove all stopped Docker containers with optional label filters
- `prune_images` — Remove unused Docker images (dangling and unreferenced) with optional filters
- `update_container` — Update container resource limits (CPU, memory, CPU shares)

### Changed
- Improved tool descriptions for Glama Quality optimization (commit 255cf60)
- Added CI workflow (GitHub Actions, Node 18/20/22)
- Added `relatedServers` to glama.json


All notable changes to @supernova123/docker-mcp-server will be documented in this file.

## [0.3.4] - 2026-06-14

### Added
- **copy_from_container** tool — copy files from a container to the host filesystem
- **copy_to_container** tool — copy files from the host to a container filesystem
- Glama "Try it now" link in README for zero-install tool testing

## [0.3.3] - 2026-06-13

### Added
- **docker_info** tool — Docker daemon system information (version, OS, kernel, CPU, memory, storage driver, container/image counts)
- **disk_usage** tool — Disk usage breakdown by images, containers, volumes, and build cache with human-readable sizes

## [0.3.2] - 2026-06-13

### Added
- Retry with exponential backoff for transient Docker API errors (`withRetry` wrapper)
- `isRetryableError` classifier for Docker API error codes
- 10 new retry/backoff unit tests

### Fixed
- Transient Docker API errors (ECONNRESET, ETIMEDOUT) now retry automatically

## [0.3.1] - 2026-06-13

### Added
- Startup health check (`checkDockerConnection`) — validates Docker daemon before server start
- Configurable timeout wrapper (`withTimeout`) — prevents indefinite hangs on slow API calls (default 30s)
- Structured error classes: `DockerConnectionError`, `DockerTimeoutError`, `DockerPermissionError`
- Enhanced `formatError()` recognizing structured error types

### Fixed
- Unicode regex in `sanitizeOutput` corrupting log output (#6287)

## [0.3.0] - 2026-06-13

### Added
- Volume management tools: `list_volumes`, `create_volume`, `remove_volume`, `inspect_volume`, `prune_volumes`
- 4 new volume tools bringing total to 31

## [0.2.5] - 2026-06-12

### Added
- SECURITY.md with 6 audit findings and mitigations
- Input validation on all tool parameters
- Output sanitization to prevent prompt injection
- Size caps on container lists and log output
- Timeout caps on API calls

## [0.2.4] - 2026-06-12

### Added
- MCP annotations on all 31 tools (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`)
- Rewrote 6 monitoring tool descriptions for TDQS optimization
- Rewrote 3 C-grade tool descriptions (`compose_logs`, `restart_container`, `stream_logs`)

## [0.2.3] - 2026-06-12

### Fixed
- TDQS optimization — tool description quality improvements

## [0.2.2] - 2026-06-12

### Added
- Glama badges to README

## [0.2.1] - 2026-06-12

### Changed
- Renamed monitoring tools for better Glama Quality score

## [0.2.0] - 2026-06-12

### Added
- Fleet monitoring tools: `fleet_status`, `fleet_stats`, `monitor_dashboard`, `watch_events`, `resource_alert_check`, `search_logs`
- 6 monitoring tools with real Docker API calls
- 21 unit tests for monitoring functionality
- Fleet Monitoring section in README

## [0.1.6] - 2026-06-11

### Added
- Auto-pull missing images in `run_container`
- Dockerfile for Docker Hub MCP org submission

### Fixed
- Handle 304 error when stopping already-stopped containers

## [0.1.4] - 2026-06-11

### Fixed
- Resolve compose path — accept both file and directory paths

## [0.1.2] - 2026-06-11

### Changed
- Optimized npm SEO keywords and descriptions for discoverability

### Added
- 20 unit tests
- Competitive comparison and before/after framing in README
- Use Cases section with concrete agent scenarios

## [0.1.0] - 2026-06-10

### Added
- Initial release: 25 tools across container, compose, exec, health, logs, image, and network modules