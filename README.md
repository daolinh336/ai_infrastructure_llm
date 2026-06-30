# Infra ReAct Agent

Natural-language infrastructure management CLI using a ReAct-style agent, typed domain validation, Docker Compose previews, SQLite state, and guarded Docker runtime execution through MCP.

## Source of truth

The codebase is the source of truth for current behavior. Documentation in this repository describes what is implemented in `src/`, `packages/`, and `tests/`.

Key implementation entry points:

- `src/cli/main.ts`: CLI commands for doctor, observe, status, destroy, destroy-all, and repair.
- `src/cli/plan-command.ts`: natural-language plan, dry-run, apply, save-state, and deploy flow.
- `src/static-gateway/static-gateway.ts`: pre-ReAct validation and structured query gate.
- `src/agent/`: ReAct orchestration, planner/verifier agents, internal tools, loop guards, and feedback revision helpers.
- `src/domain/`: Zod schemas and domain types for specs, plans, state, approvals, runtime observations, drift, repair, and verification.
- `src/compose/`: Docker Compose rendering and generated secret handling.
- `src/execution/`: approval/preflight, dependency scheduling, Docker MCP gateway, deploy/destroy/repair/drift execution, runtime limits, policy, and cleanup.
- `src/state/sqlite-state-store.ts`: SQLite persistence for pending previews, approvals, verified runtime snapshots, history, and operation records.
- `src/status/status-service.ts`: status rendering over saved state and runtime comparison reports.
- `packages/docker-mcp-server-supernova/`: vendored Docker MCP server used by the default runtime profile.
- `tests/`: unit, integration, e2e, policy, and chaos pipeline tests.

## Architecture

The CLI keeps the planning model, runtime execution, and saved state separate:

- `InfrastructureSpec` is the canonical desired-state model.
- `ExecutionPlan` explains the intended validate, preview, approve, apply, observe, and verify procedure.
- Docker Compose YAML is a generated artifact for preview and execution support, not the canonical model.
- SQLite stores validated JSON payloads for pending previews, approved actions, verified desired/actual runtime snapshots, drift reports, repair reports, and history.
- Docker runtime mutations go through `DockerMcpGateway`, route metadata, policy checks, and an approval-controlled mutation gate.
- Observation and verification use read-only MCP routes after runtime actions.

## Implemented CLI commands

```bash
npm run dev -- plan "Create a web application with nginx, 2 node backends, and postgres"
npm run dev -- plan "Create a web application with nginx, 2 node backends, and postgres" --save-state
npm run dev -- plan "Create nginx on port 8080" --apply
npm run dev -- plan "Create nginx on port 8080" --apply --deploy
npm run dev -- doctor --docker
npm run dev -- observe
npm run dev -- status
npm run dev -- status --drift
npm run dev -- repair
npm run dev -- repair --approve-risky
npm run dev -- destroy
npm run dev -- destroy --remove-volumes
npm run dev -- destroy-all
npm run dev -- destroy-all --remove-volumes
```

Command behavior:

- `plan` validates a natural-language request, runs the Static Gateway, runs the ReAct agent, renders a detailed dry-run preview, and prints trace/observations.
- `plan --save-state` stores a pending preview in SQLite without Docker mutation.
- `plan --apply` runs preflight, asks for approval, writes `docker-compose.yaml`, writes generated secrets when needed, and saves an approved action.
- `plan --apply --deploy` deploys approved resources through Docker MCP, observes actual runtime state, verifies the result, and saves a verified runtime snapshot.
- `doctor --docker` performs read-only Docker setup checks.
- `observe` lists current Docker containers, networks, volumes, and images through MCP.
- `status` reads SQLite state and prints pending/current saved infrastructure status.
- `status --drift` observes Docker runtime state through MCP and compares it with the saved desired state.
- `repair` previews supported drift repairs, asks for approval, applies approved repair actions through MCP, observes again, verifies drift resolution, and updates SQLite when clean.
- `destroy` removes resources for the current verified project after approval.
- `destroy-all` removes resources tracked by saved tool state after strict verification.

## Runtime safety

Runtime safety is enforced in code, not by documentation convention:

- Static validation rejects empty, out-of-scope, unsafe, or malformed requests before ReAct planning starts.
- Domain objects are validated with Zod before they become specs, plans, approvals, state records, or runtime reports.
- Dry-run is the default path and does not write final artifacts or mutate Docker.
- `--deploy` requires `--apply`, so Docker mutation only happens after the plan is approved.
- `DockerMcpGateway` blocks mutate/destructive routes unless its mutation gate is explicitly enabled in the execution path.
- MCP routes are declared in `src/execution/mcp-routing-table.ts` with read/mutate/destructive metadata.
- Runtime operations use dependency-aware ordering and cleanup logic for failed deploy attempts.
- Verification reads actual Docker state through MCP and records evidence in SQLite.

## Docker MCP runtime

The default Docker runtime profile is `supernova-local`:

```bash
npm --prefix packages/docker-mcp-server-supernova install
npm run build:supernova-mcp
npm run test:e2e:docker-mcp
```

Runtime path:

```text
CLI -> ExecutionEngine -> DockerMcpGateway -> Supernova MCP stdio server -> dockerode -> Docker Engine API
```

Useful runtime environment variables:

```bash
INFRA_DOCKER_MCP_REQUEST_TIMEOUT_MS=120000
INFRA_DOCKER_PULL_MAX_ATTEMPTS=3
INFRA_DOCKER_PULL_RETRY_INITIAL_DELAY_MS=1000
INFRA_DOCKER_PULL_RETRY_MAX_DELAY_MS=5000
INFRA_DOCKER_PULL_RETRY_BACKOFF_FACTOR=2
```

`npm run test:e2e:docker-mcp:all-tools` is a broader diagnostic for the vendored MCP server. It is not required for the main deploy path.

## LLM providers

Supported runtime provider names are `openai` and `gemini`.

```bash
INFRA_AGENT_PROVIDER=openai
INFRA_AGENT_FALLBACK_PROVIDER=gemini
OPENAI_API_KEY=your_openai_key
OPENAI_BASE_URL=https://api.vietapi.tech/v1
OPENAI_REACT_MODEL=gpt-5.5
OPENAI_AUX_MODEL=gpt-5.5
OPENAI_TEMPERATURE=0.1

GEMINI_API_KEY=your_gemini_key
GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta
GEMINI_REACT_MODEL=gemini-2.5-flash
GEMINI_AUX_MODEL=gemini-2.5-flash
```

Provider notes:

- OpenAI uses the `openai` package and can use an OpenAI-compatible `OPENAI_BASE_URL`.
- Gemini uses direct Google `generateContent` HTTP calls through `GEMINI_BASE_URL`.
- Tests use `TestLlmProvider` fixtures; the CLI runtime path expects OpenAI or Gemini structured output.

## Runtime limits

The CLI loads `.env` at startup. These limits are read by static validation, schema validation, loop guards, and runtime helpers:

```bash
INFRA_AGENT_MAX_REACT_ITERATIONS=14
INFRA_AGENT_REPEAT_TOLERANCE=3
INFRA_AGENT_MAX_CALLS_PER_TOOL=5
INFRA_AGENT_NO_PROGRESS_TOLERANCE=3
INFRA_AGENT_MAX_VERIFY_REVISE_ITERATIONS=3
INFRA_AGENT_SPEC_STAGNATION_TOLERANCE=2
INFRA_AGENT_REPEATED_FAILURE_TOLERANCE=2

INFRA_MAX_TOTAL_CONTAINERS=10
INFRA_MAX_SERVICE_REPLICAS=50
INFRA_MAX_ABSURD_REPLICAS=100000
INFRA_MAX_CPU=4
INFRA_MAX_MEMORY_GB=8
```

## Development commands

```bash
npm install
npm run build
npm run typecheck
npm run lint
npm test
npm run build:supernova-mcp
npm run test:e2e:docker-mcp
npm run test:supernova-mcp
npm run test:chaos
npm run test:pipeline
```

Known validation notes from the current local environment:

- `npm run build`, `npm run typecheck`, and `npm run lint` pass.
- `npm test` can fail when local environment variables override runtime-limit defaults expected by `tests/runtime-limits.test.ts`.
- `npm run test:e2e:docker-mcp:all-tools` can fail in the `container_resource_usage` diagnostic when Docker stats omit CPU usage fields.

## Docs kept in this repository

- `README.md`: current implementation and operation guide.
- `docs/tool-system-policy.vi.md`: current internal tool and runtime policy notes.
- `docs/testing/three-tier-chaos-matrix.md`: real Docker chaos matrix tied to `tests/three-tier-chaos-pipeline.test.ts`.
