# Infra ReAct Agent

`infra-react-agent` is a natural-language infrastructure management CLI built around a ReAct-style AI Agent. A user describes the target infrastructure in plain language, and the system validates the request, generates a plan, previews the result, asks for approval, executes through a runtime plugin, observes the runtime state, and stores verified state in SQLite.

## Mini-Project Contributions

This mini-project contributes three concrete pieces, all backed by code rather than only diagrams:

1. **Guarded AI Agent architecture**: the implementation separates natural-language interpretation, domain modeling, validation, policy, approval, and runtime execution. The LLM helps interpret intent and propose structured plans, but deterministic TypeScript/Zod code decides what can become an `InfrastructureSpec`, what needs approval, and what may touch Docker.
2. **`InfrastructureSpec` as desired state**: `InfrastructureSpec` is the central model for target infrastructure. Docker Compose YAML is rendered from that model as an artifact, not treated as the source of truth. This keeps the design open to future target compilers such as Kubernetes manifests, cloud resources, or process-based runtime specs.
3. **Safe Docker lifecycle flow**: Docker support is organized as a guarded runtime path: dry-run preview, preflight, human approval, Docker MCP gateway, SQLite verified snapshots, runtime observation, verification, drift detection, and repair/destroy workflows.

The current implementation is Docker-first, but not Docker-locked. Existing extension points are visible in the separation between `src/domain/`, `src/compose/`, `src/execution/`, `src/state/`, and the vendored Docker MCP server package.

### Contribution-to-code evidence

| Contribution | Code evidence | What it proves |
| --- | --- | --- |
| Natural-language boundary | `src/static-gateway/static-gateway.ts`, `src/agent/` | prompts are classified, parsed, planned, revised, and observed before execution |
| Domain model boundary | `src/domain/types.ts`, `src/domain/schemas.ts` | `InfrastructureSpec`, plans, previews, approvals, actual state, and drift reports are typed and validated |
| Compose as artifact | `src/compose/render-compose.ts`, `src/execution/execution-engine.ts` | Compose YAML is generated from validated desired state during dry-run/deploy preparation |
| Policy and approval | `src/execution/phase8-approval.ts`, `src/execution/tool-policy.ts`, `src/execution/mcp-routing-table.ts` | preflight, risk classification, approval requests, and MCP route metadata are explicit |
| Runtime adapter boundary | `src/execution/docker-mcp-gateway.ts`, `src/execution/mcp-connection-plug.ts` | Docker mutation goes through a gateway with capability preflight and mutation gating |
| State and drift | `src/state/sqlite-state-store.ts`, `src/status/status-service.ts`, `src/execution/drift-detector.ts` | desired/actual snapshots are persisted and later compared against observed runtime state |

## 1. Project Overview

### What this project does

This project turns natural-language infrastructure requests into a controlled infrastructure lifecycle.

Instead of requiring a user to manually write Compose files or call Docker commands directly, the CLI can take a request such as:

```bash
aiagent plan "Create a web application with nginx, 2 node backends, and postgres" --prjName web-stack --dry-run
```

From there, the system:

1. classifies the infrastructure intent,
2. parses the request into structured input,
3. plans with a ReAct-style Agent,
4. validates the domain objects,
5. renders a preview and Docker Compose artifact,
6. runs preflight and policy checks,
7. asks for approval before runtime mutation,
8. deploys through the Docker MCP runtime plugin,
9. observes the actual runtime state,
10. verifies desired state against actual state,
11. stores verified snapshots in SQLite for later status, drift, repair, and destroy flows.

### Current scope

The current implementation focuses on Docker as the first runtime target:

- Docker Compose YAML is used as a preview and deployment-support artifact.
- Docker MCP is the runtime boundary.
- SQLite stores desired and actual state snapshots.
- The CLI supports plan, deploy, observe, status, drift detection, repair, and destroy flows.

Docker is not the architectural limit of the project. It is the first runtime plugin used to demonstrate the viability of the larger Agent-driven architecture.

### Main use cases

| Use case | Primary command | Result |
| --- | --- | --- |
| Preview a new stack | `plan --dry-run --prjName` | Generates a plan and Compose preview without mutating Docker |
| Deploy a new stack | `plan --deploy --prjName` | Previews, asks for approval, deploys through Docker MCP, saves verified state |
| Adjust replicas | `plan --adjust --prjName` | Adjusts an existing verified project; currently limited to backend/database replica changes |
| Check Docker setup | `doctor --docker` | Runs a read-only Docker Engine API check |
| Observe live Docker state | `observe` | Lists containers, networks, volumes, and images through MCP |
| View saved infrastructure state | `status` | Reads verified snapshots from SQLite |
| Detect drift | `status --drift` | Compares saved desired state against live Docker runtime state |
| Repair drift | `status --drift --repair` or `repair` | Builds a repair plan, asks for approval, repairs or syncs |
| Destroy one project | `destroy -p <name>` | Removes managed resources for a single verified project |
| Destroy all managed infrastructure | `destroy-all` | Removes every managed resource after strict confirmation |

### CLI commands

```bash
Usage: infra-react-agent [options] [command]

Options:
  -V, --version                            output the version number
  -h, --help                               display help for command

Commands:
  plan [options] <prompt>                  Plan, approve, and deploy natural-language infrastructure to Docker
  doctor [options]                         Run read-only setup checks
  observe                                  Observe current Docker runtime state using MCP
  destroy-all|destroy-all-infra [options]  Destroy every Docker resource created by this tool after strict user verification
  status [options]                         Show verified infrastructure snapshot(s)
  destroy [options]                        Destroy Docker resources belonging to the current verified project via MCP
  repair                                   Detect drift, preview repair plan, get approval, then deploy repair via MCP
  help [command]                           display help for command
```

### Key command options

#### `plan [options] <prompt>`

```bash
aiagent plan "Create nginx on port 8080" --prjName nginx-demo --dry-run
aiagent plan "Create nginx on port 8080" --prjName nginx-demo --deploy
aiagent plan "Scale backend to 3 replicas" --prjName web-stack --adjust
```

- `--dry-run`: renders outputs without writing verified state or deploying Docker. Default: `true`.
- `--deploy`: writes the Compose artifact and deploys through Docker MCP after approval. Default: `false`.
- `--prjName <name>`: unique project name used for create and adjust routing. Required by the current implementation.
- `--adjust`: adjusts an existing verified deployment; currently limited to backend/database replica changes. Default: `false`.
- `--provider <provider>`: `openai` or `gemini`. Default: `openai` or `INFRA_AGENT_PROVIDER`.

#### `doctor [options]`

```bash
aiagent doctor --docker
```

- `--docker`: performs a read-only Docker Engine API reachability check.

#### `observe`

```bash
aiagent observe
```

Lists the current Docker runtime state through MCP.

#### `status [options]`

```bash
aiagent status
aiagent status --prjName web-stack
aiagent status --prjName web-stack --drift
aiagent status --prjName web-stack --drift --repair
```

- `--drift`: compares live Docker runtime state with the saved desired state.
- `--repair`: after drift detection, previews repair and asks for `yes`, `no`, or `sync`. Requires `--drift`.
- `--prjName <name>`: targets one verified project.

#### `destroy [options]`

```bash
aiagent destroy --project web-stack
aiagent destroy --project web-stack --remove-volumes
aiagent destroy -p web-stack --remove-volumes --yes
```

- `-p, --project <name>`: project name override.
- `--remove-volumes`: also removes project volumes.
- `--yes`: skips interactive approval.

#### `destroy-all|destroy-all-infra [options]`

```bash
aiagent destroy-all
aiagent destroy-all --remove-volumes
aiagent destroy-all-infra --remove-volumes --yes
```

- `--remove-volumes`: also removes volumes referenced by managed state.
- `--yes`: skips the strict verification phrase.

#### `repair`

```bash
aiagent repair
```

Detects drift for the current verified snapshot, previews a repair plan, asks for `yes`, `no`, or `sync`, and applies the selected path.

## 2. Core Architecture

### High-level architecture

```text
User Prompt / CLI Command
  -> CLI Layer
  -> Static Gateway
  -> ReAct Agent
  -> Domain Schemas
  -> Execution Engine
  -> Preview / Preflight / Approval
  -> Runtime Plugin Gateway
  -> Docker MCP Server (current plugin)
  -> Docker Engine
  -> Observation / Verification
  -> SQLite State
  -> Status / Drift / Repair / Destroy
```

### Core architectural idea

The architecture is intentionally split into two major concerns:

- **AI Agent core**: intent understanding, planning, validation, preview, approval, observation, and state management.
- **Runtime plugin layer**: Docker today, potentially Kubernetes, cloud providers, on-prem adapters, or process runners in the future.

This keeps the Agent from directly becoming a raw infrastructure shell. Runtime actions remain typed, validated, observable, and policy-controlled.

### Main modules

| Module | Responsibility |
| --- | --- |
| `src/cli/main.ts` | Root CLI commands: doctor, observe, status, destroy, destroy-all, repair |
| `src/cli/plan-command.ts` | Natural-language planning, dry-run, deploy, and adjust flow |
| `src/static-gateway/static-gateway.ts` | Pre-ReAct validation, structured query parsing, safety checks |
| `src/agent/` | ReAct orchestration, internal tools, planner/verifier flow, loop guards |
| `src/domain/` | Types, Zod schemas, structured output schemas, topology and identity helpers |
| `src/compose/` | Docker Compose rendering and secret handling |
| `src/execution/` | Execution engine, Docker MCP gateway, routing, policy, drift, repair, destroy |
| `src/state/sqlite-state-store.ts` | SQLite persistence for desired/actual verified snapshots and history |
| `src/status/status-service.ts` | Status rendering and desired-vs-actual reporting |
| `src/llm/provider.ts` | OpenAI/Gemini provider abstraction |
| `packages/docker-mcp-server-supernova/` | Vendored Docker MCP plugin currently used by the runtime gateway |

### Important data models

- `InfrastructureSpec`: canonical desired-state model.
- `InfrastructureService`: service-level desired state including image, replicas, ports, environment, dependencies, and volumes.
- `ExecutionPlan`: plan summary, assumptions, and steps.
- `DetailedDryRunPreview`: preview shown to the user before runtime mutation.
- `RuntimeActualState`: normalized observed runtime state.
- `VerifiedRuntimeSnapshot`: desired state, actual state, verification result, and artifact record saved in SQLite.
- `DriftReport`: desired-vs-actual comparison.
- `RepairPlan`: supported repair actions derived from drift findings.

### Main data flows

#### Dry-run flow

```text
Prompt
  -> cliInputSchema
  -> StaticGateway.validate()
  -> ReActAgent.run()
  -> validateAgentRunResult()
  -> resolveSecrets()
  -> repairExposedSecrets()
  -> namespaceInfrastructureSpec()
  -> renderCompose()
  -> buildDependencyAwareExecutionSchedule()
  -> buildDetailedDryRunPreview()
  -> print preview + docker-compose.yaml
  -> stop without Docker mutation
```

#### Deploy flow

```text
Prompt
  -> dry-run preview path
  -> runPhase8Preflight()
  -> buildApprovalRequest()
  -> requestCliApproval(): yes / no / other
     -> no: stop
     -> other: reviseFromFeedback(), regenerate preview
     -> yes: write compose artifact
             initialize DockerMcpGateway
             enable mutation gate
             deploy resources by dependency order
             observe actual runtime
             verify
             saveVerifiedRuntimeSnapshot()
```

#### Drift and repair flow

```text
Verified SQLite snapshot
  -> observe actual Docker runtime via MCP
  -> buildDriftReport()
  -> buildRepairPlan()
  -> ask yes / no / sync
     -> yes: repair runtime, observe, verify, save snapshot
     -> sync: derive desired state from runtime, verify, save snapshot
     -> no: stop without mutation
```

#### Destroy flow

```text
Verified project snapshot
  -> build destroy preview
  -> ask for approval
  -> destroyWithDocker()
  -> post-destroy verification
  -> clear managed project state
```

### Runtime safety

Runtime safety is implemented in code, not only in documentation:

- Static validation rejects non-infrastructure and unsafe prompts before ReAct planning starts.
- Domain objects are validated with Zod before they become plans, state records, or runtime requests.
- Dry-run is the default path and performs no Docker mutation.
- Runtime mutation only happens after preflight and explicit approval.
- `DockerMcpGateway` blocks mutating and destructive routes unless the mutation gate is enabled.
- MCP routes are declared with category, destructive status, and risk metadata.
- Observation and verification run after runtime actions.
- SQLite persists desired and actual evidence for later drift and repair workflows.

### Runtime plugin model

The current runtime plugin is Docker:

```text
CLI -> ExecutionEngine -> DockerMcpGateway -> Supernova MCP stdio server -> Dockerode -> Docker Engine API
```

The same model can be reused for future targets:

- Kubernetes MCP plugin
- AWS MCP plugin
- GCP MCP plugin
- on-prem runtime adapter
- process or JAR runner plugin

The key rule is unchanged: the Agent stays generic, while runtime-specific capabilities are pushed behind typed plugins.

## 3. Prerequisites and Installation

### Prerequisites

Required:

- Node.js `>=20`
- npm
- Docker Desktop or a reachable Docker Engine
- a shell that can run npm scripts

Required for LLM-backed runs:

- an OpenAI-compatible API key, or
- a Gemini API key

Required for real Docker deployment flows:

- Docker daemon running
- the Docker MCP runtime plugin built

Optional:

- `OPENAI_BASE_URL` for an OpenAI-compatible endpoint
- Docker Desktop MCP Gateway if using the `official` profile

### Install dependencies

```bash
npm install
```

If you are working directly on the vendored Docker MCP plugin package:

```bash
npm --prefix packages/docker-mcp-server-supernova install
```

### Configure environment

Create or update a `.env` file in the repository root.

OpenAI-compatible example:

```bash
INFRA_AGENT_PROVIDER=openai
INFRA_AGENT_FALLBACK_PROVIDER=gemini
OPENAI_API_KEY=your_openai_key
OPENAI_BASE_URL=https://api.example.com/v1
OPENAI_REACT_MODEL=gpt-5.5
OPENAI_AUX_MODEL=gpt-5.5
OPENAI_TEMPERATURE=0.1
```

Gemini example:

```bash
INFRA_AGENT_PROVIDER=gemini
GEMINI_API_KEY=your_gemini_key
GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta
GEMINI_REACT_MODEL=gemini-2.5-flash
GEMINI_AUX_MODEL=gemini-2.5-flash
```

Docker MCP and retry settings:

```bash
INFRA_DOCKER_MCP_REQUEST_TIMEOUT_MS=120000
INFRA_DOCKER_PULL_MAX_ATTEMPTS=3
INFRA_DOCKER_PULL_RETRY_INITIAL_DELAY_MS=1000
INFRA_DOCKER_PULL_RETRY_MAX_DELAY_MS=5000
INFRA_DOCKER_PULL_RETRY_BACKOFF_FACTOR=2
```

Loop and resource limits:

```bash
INFRA_AGENT_MAX_REACT_ITERATIONS=14
INFRA_AGENT_REPEAT_TOLERANCE=3
INFRA_AGENT_MAX_CALLS_PER_TOOL=5
INFRA_AGENT_NO_PROGRESS_TOLERANCE=3
INFRA_AGENT_MAX_VERIFY_REVISE_ITERATIONS=5
INFRA_AGENT_SPEC_STAGNATION_TOLERANCE=3
INFRA_AGENT_REPEATED_FAILURE_TOLERANCE=3

INFRA_MAX_TOTAL_CONTAINERS=50
INFRA_MAX_SERVICE_REPLICAS=70
INFRA_MAX_ABSURD_REPLICAS=100000
INFRA_MAX_CPU=4
INFRA_MAX_MEMORY_GB=8
```

### Build the project

```bash
npm run build
npm run typecheck
npm run lint
```

### Build the Docker MCP runtime plugin

```bash
npm run build:supernova-mcp
```

### Validate Docker connectivity

```bash
aiagent doctor --docker
```

### Run a safe dry-run

```bash
aiagent plan "Create nginx on port 8080" --prjName nginx-demo --dry-run
```

Expected output includes:

- static validation metrics,
- planning summary,
- assumptions,
- plan steps,
- detailed dry-run preview,
- generated `docker-compose.yaml` preview,
- state database path,
- explicit dry-run notice.

### Deploy after approval

```bash
aiagent plan "Create nginx on port 8080" --prjName nginx-demo --deploy
```

Expected behavior:

1. the CLI prints preview output,
2. the CLI prints preflight output,
3. the CLI asks for approval,
4. if the user approves, it writes the artifact and deploys through Docker MCP,
5. it observes runtime state and saves a verified SQLite snapshot.

### Observe and inspect saved state

```bash
aiagent observe
aiagent status --prjName nginx-demo
aiagent status --prjName nginx-demo --drift
```

### Repair drift

```bash
aiagent status --prjName nginx-demo --drift --repair
```

Repair choices:

- `yes`: repair runtime to match the saved desired state,
- `no`: do nothing,
- `sync`: update the saved desired state from the current runtime state.

### Destroy resources

Destroy one project:

```bash
aiagent destroy --project nginx-demo --remove-volumes
```

Destroy all managed resources:

```bash
aiagent destroy-all --remove-volumes
```

### Run the built CLI

```bash
npm run build
npm run start -- plan "Create nginx on port 8080" --prjName nginx-demo --dry-run
```

Installed binary names:

```bash
aiagent --help
infra-react-agent --help
```

## 4. Additional Documentation

- `docs/project-onboarding-vi.md`: detailed contributor onboarding and use-case guide.
- `docs/tool-system-policy.vi.md`: runtime tool and policy notes.
- `docs/testing/three-tier-chaos-matrix.md`: real Docker lifecycle and chaos scenarios.
- `packages/docker-mcp-server-supernova/README.md`: notes for the vendored Docker MCP plugin package.

## Demo metrics and LLM call trace

Metrics are opt-in and disabled by default. Enable them with `INFRA_METRICS=1` or run the benchmark helper:

```bash
npm run demo:metrics -- --runs 5
npm run demo:metrics -- --runs 1 --dry-run-only
npm run metrics:report
```

Generated files:

- `state/metrics/llm-calls.jsonl`: one record per LLM call, with schema name, purpose, latency, usage, and safe context fields only.
- `state/metrics/operations.jsonl`: one record per dry-run/deploy/status/drift/destroy operation.
- `state/metrics/demo-summary.md`: aggregate latency, tokens, planner first-pass correctness, and guard triggers.
- `state/metrics/llm-call-report.md`: explains how many times LLM was called, why each step called it, and which context fields were supplied.

Normal plan creation calls LLM 3 times when no clarification/revision is needed: `intent_classification`, `draft_query`, and `react_reasoning_output`. Adjust/revision paths may add `feedback_intent` and `spec_patch_plan`. Status, drift, and destroy do not call LLM by default.
