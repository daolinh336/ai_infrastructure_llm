# Infra ReAct Agent

`infra-react-agent` là một CLI quản lý và vận hành hạ tầng bằng ngôn ngữ tự nhiên. Người dùng mô tả mục tiêu hạ tầng bằng prompt, hệ thống dùng AI Agent kiểu ReAct để lập kế hoạch, validate, preview, xin phê duyệt, triển khai qua runtime plugin, quan sát kết quả và lưu trạng thái verified.

> Định hướng dài hạn: AI Agent là lõi điều phối. Docker/Docker Compose là plugin minh họa đầu tiên; Kubernetes, AWS, GCP, on-prem hoặc runtime như JAR runner có thể được tích hợp bằng MCP server hoặc runtime adapter tương ứng.

## 1. Giới thiệu dự án

### 1.1 Dự án giải quyết vấn đề gì?

Trong vận hành hạ tầng, người dùng thường phải biết nhiều công cụ khác nhau: Docker, Docker Compose, Kubernetes, cloud CLI/API, scripts on-prem, process managers, hoặc lệnh chạy ứng dụng như `java -jar`. Dự án này hướng tới việc đưa một lớp AI Agent đứng giữa người dùng và các công cụ đó.

Thay vì yêu cầu người dùng viết ngay YAML hoặc chạy Docker/K8s/cloud commands thủ công, hệ thống cho phép nhập yêu cầu dạng tự nhiên:

```bash
npm run dev -- plan "Create a web application with nginx, 2 node backends, and postgres" --prjName web-stack --dry-run
```

Hệ thống sẽ:

1. Phân loại ý định hạ tầng.
2. Parse yêu cầu thành cấu trúc trung gian.
3. Lập kế hoạch bằng ReAct Agent.
4. Validate domain object bằng schema.
5. Sinh Docker Compose preview.
6. Chạy preflight và policy checks.
7. Hỏi người dùng phê duyệt trước mutation.
8. Deploy qua Docker MCP nếu được duyệt.
9. Observe Docker runtime sau deploy.
10. Verify desired state với actual state.
11. Lưu snapshot vào SQLite để status, drift, repair, destroy.

### 1.2 Phạm vi hiện tại

Trong mini-project hiện tại, runtime được hiện thực là Docker local:

- Docker Compose YAML là artifact preview/deploy support.
- Docker MCP Gateway là runtime boundary.
- SQLite lưu desired/actual snapshots.
- CLI hỗ trợ vòng đời: plan, deploy, observe, status, drift, repair, destroy.

Docker **không phải giới hạn đề tài**. Docker chỉ là runtime plugin đầu tiên để chứng minh kiến trúc. Khi cần Kubernetes, cloud hoặc on-prem, hướng đi là thêm MCP server/adapter mới và giữ lại lõi Agent + validation + policy + state.

### 1.3 Các use case chính

| Use case | Command chính | Ý nghĩa |
| --- | --- | --- |
| Preview hạ tầng mới | `plan --dry-run --prjName` | Lập kế hoạch và xem compose preview, không mutate Docker. |
| Deploy hạ tầng mới | `plan --deploy --prjName` | Preview, xin approval, deploy qua Docker MCP, observe, save SQLite. |
| Điều chỉnh replica | `plan --adjust --prjName` | Adjust project đã verified; hiện support replica backend/database. |
| Kiểm tra môi trường Docker | `doctor --docker` | Read-only ping Docker Engine API. |
| Quan sát Docker runtime | `observe` | List containers/networks/volumes/images qua MCP. |
| Xem saved status | `status` | Đọc SQLite verified snapshots. |
| Detect drift | `status --drift` | So sánh SQLite desired state với Docker actual state. |
| Repair drift | `status --drift --repair` hoặc `repair` | Preview repair, hỏi yes/no/sync, repair hoặc sync state. |
| Xóa một project | `destroy -p <name>` | Xóa resources managed của project sau approval. |
| Xóa toàn bộ managed infra | `destroy-all` | Dọn toàn bộ resources do tool quản lý sau strict verification. |

### 1.4 CLI hiện có

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

#### `plan [options] <prompt>`

```bash
npm run dev -- plan "Create nginx on port 8080" --prjName nginx-demo --dry-run
npm run dev -- plan "Create nginx on port 8080" --prjName nginx-demo --deploy
npm run dev -- plan "Scale backend to 3 replicas" --prjName web-stack --adjust
```

Flags:

- `--dry-run`: render output without writing state or deploying Docker. Default: `true`.
- `--deploy`: after approval, write compose artifact and deploy via Docker MCP. Default: `false`.
- `--prjName <name>`: unique project name for create/adjust routing. Required by current implementation.
- `--adjust`: adjust an existing deployed project; asks yes/no/other and deploys on approval. Default: `false`.
- `--provider <provider>`: LLM provider, `openai` or `gemini`. Default: `openai` or `INFRA_AGENT_PROVIDER`.
- `-h, --help`: show command help.

#### `doctor [options]`

```bash
npm run dev -- doctor --docker
```

Flags:

- `--docker`: read-only Docker Engine API check.
- `-h, --help`: show command help.

#### `observe`

```bash
npm run dev -- observe
```

Read-only MCP observation of Docker containers, networks, volumes and images.

#### `status [options]`

```bash
npm run dev -- status
npm run dev -- status --prjName web-stack
npm run dev -- status --prjName web-stack --drift
npm run dev -- status --prjName web-stack --drift --repair
```

Flags:

- `--drift`: also detect live drift against Docker runtime via MCP.
- `--repair`: after drift detection, preview repair and ask yes/no/sync. Requires `--drift`.
- `--prjName <name>`: show status/drift for one verified project.
- `-h, --help`: show command help.

#### `destroy [options]`

```bash
npm run dev -- destroy --project web-stack
npm run dev -- destroy --project web-stack --remove-volumes
npm run dev -- destroy -p web-stack --remove-volumes --yes
```

Flags:

- `-p, --project <name>`: project name override. Defaults to current verified state.
- `--remove-volumes`: also remove project volumes. Default: `false`.
- `--yes`: skip interactive approval. Default: `false`.
- `-h, --help`: show command help.

#### `destroy-all|destroy-all-infra [options]`

```bash
npm run dev -- destroy-all
npm run dev -- destroy-all --remove-volumes
npm run dev -- destroy-all-infra --remove-volumes --yes
```

Flags:

- `--remove-volumes`: also remove volumes referenced by saved tool state. Default: `false`.
- `--yes`: skip strict verification phrase. Default: `false`.
- `-h, --help`: show command help.

#### `repair`

```bash
npm run dev -- repair
```

Detects drift for the current verified snapshot, previews a repair plan, asks for yes/no/sync, then applies approved repair through MCP.

## 2. Kiến trúc chính

### 2.1 Sơ đồ lớp tổng quát

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

### 2.2 Lõi Agent và runtime plugin

Dự án tách rõ hai phần:

- **AI Agent core**: hiểu yêu cầu, lập kế hoạch, validate, preview, approval, state, observation.
- **Runtime plugin**: công cụ triển khai cụ thể như Docker MCP, K8s MCP, AWS/GCP MCP, on-prem adapter, JAR runner.

Hiện tại repo đã hiện thực Docker plugin. Kiến trúc vẫn hướng tới mở rộng bằng cách thêm plugin mới thay vì viết lại Agent.

### 2.3 Luồng dữ liệu `plan --dry-run`

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

### 2.4 Luồng dữ liệu `plan --deploy`

```text
Prompt
  -> dry-run/preview path
  -> runPhase8Preflight()
  -> buildApprovalRequest()
  -> requestCliApproval(): yes/no/other
     -> no: stop
     -> other: reviseFromFeedback(), regenerate preview
     -> yes: write compose artifact
             init DockerMcpGateway
             enable mutation gate
             deploy resources by dependency order
             observe actual runtime
             verify
             saveVerifiedRuntimeSnapshot()
```

### 2.5 Luồng dữ liệu `status --drift --repair`

```text
SQLite verified snapshot
  -> observe actual Docker runtime via MCP
  -> buildDriftReport()
  -> buildRepairPlan()
  -> ask yes/no/sync
     -> yes: repairWithDocker(), observe, verify, save snapshot
     -> sync: deriveSpecFromRuntime(), save desired state from runtime
     -> no: no mutation, no state change
```

### 2.6 Luồng dữ liệu `destroy`

```text
SQLite verified project snapshot
  -> compute managed resources
  -> preview destroy targets
  -> approval prompt
  -> destroyWithDocker()
  -> post-destroy verification
  -> clearManagedProjectState()
```

### 2.7 Các module chính

| Module | Vai trò |
| --- | --- |
| `src/cli/main.ts` | CLI commands: doctor, observe, status, destroy, destroy-all, repair. |
| `src/cli/plan-command.ts` | Natural-language plan, dry-run, deploy, adjust flow. |
| `src/static-gateway/static-gateway.ts` | Pre-ReAct validation and structured query gate. |
| `src/agent/` | ReAct orchestration, internal tools, loop guards, planner/verifier. |
| `src/domain/` | Types, Zod schemas, structured output schemas, trusted images, topology. |
| `src/compose/` | Docker Compose rendering and secret handling. |
| `src/execution/` | Execution engine, MCP gateway, routing, policy, drift, repair, destroy. |
| `src/state/sqlite-state-store.ts` | SQLite persistence for verified snapshots and history. |
| `src/status/status-service.ts` | Status rendering over saved state and runtime comparison. |
| `src/llm/provider.ts` | OpenAI/Gemini provider abstraction. |
| `packages/docker-mcp-server-supernova/` | Vendored Docker MCP server used by default runtime profile. |
| `tests/` | Unit, integration, e2e and chaos tests. |

### 2.8 Domain model quan trọng

- `InfrastructureSpec`: canonical desired-state model.
- `InfrastructureService`: service definition with kind, image, replicas, ports, env, dependencies and volumes.
- `ExecutionPlan`: agent-produced summary, assumptions and steps.
- `DetailedDryRunPreview`: user-facing preview before mutation.
- `RuntimeActualState`: observed runtime evidence.
- `VerifiedRuntimeSnapshot`: saved desired + actual + verification snapshot.
- `DriftReport`: desired-vs-actual comparison.
- `RepairPlan`: supported repair actions for drift.

### 2.9 State model

SQLite database:

```text
state/infra-state.sqlite
```

Main tables:

- `state_snapshots`: singleton current snapshot.
- `project_state_snapshots`: per-project current snapshots.
- `state_operations`: operation history.

### 2.10 Runtime safety

Runtime safety is enforced in code:

- Static Gateway rejects non-infrastructure or unsafe prompts before ReAct planning.
- Zod validates domain objects before execution/state persistence.
- Dry-run is default and performs no Docker mutation.
- Mutating/destructive MCP routes require approval.
- `DockerMcpGateway` blocks mutations unless its mutation gate is enabled.
- Route metadata in `src/execution/mcp-routing-table.ts` classifies read/mutate/destructive actions.
- Deploy uses dependency-aware ordering and cleanup/rollback logic.
- Observation and verification run after runtime actions.

### 2.11 Docker MCP runtime

Default runtime profile:

```text
supernova-local
```

Runtime path:

```text
CLI -> ExecutionEngine -> DockerMcpGateway -> Supernova MCP stdio server -> Dockerode -> Docker Engine API
```

Default command:

```bash
node packages/docker-mcp-server-supernova/dist/index.js
```

Can be overridden with:

```bash
INFRA_DOCKER_MCP_PROFILE=official
INFRA_DOCKER_MCP_COMMAND=...
INFRA_DOCKER_MCP_ARGS=...
```

### 2.12 Mở rộng sang runtime khác

To add a new runtime such as Kubernetes, AWS, GCP, on-prem or JAR runner:

1. Define a narrow capability contract.
2. Build an MCP server or runtime adapter.
3. Add input/output schemas.
4. Add route metadata: read/mutate/destructive, risk, approvalRequired.
5. Add renderer/preview format if needed.
6. Add observation parser.
7. Add verifier/drift integration.
8. Add state persistence compatibility.
9. Add tests and docs.

## 3. Prerequisites và cài đặt

### 3.1 Prerequisites

Required:

- Node.js `>=20`
- npm
- Docker Desktop or Docker Engine reachable from the machine
- PowerShell, bash, or any shell capable of running npm scripts

Required for LLM runtime:

- OpenAI-compatible API key, or
- Gemini API key

Required for real Docker deploy/e2e:

- Docker daemon running
- Supernova Docker MCP server built

Optional:

- `OPENAI_BASE_URL` if using an OpenAI-compatible gateway
- Docker Desktop MCP Gateway if using the `official` profile

### 3.2 Install dependencies

```bash
npm install
```

If working directly on the vendored Docker MCP package:

```bash
npm --prefix packages/docker-mcp-server-supernova install
```

### 3.3 Configure environment

Create or update `.env` in the repository root.

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

Runtime and guard limits:

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

### 3.4 Build and validate

```bash
npm run build
npm run typecheck
npm run lint
npm test
```

### 3.5 Build Docker MCP runtime

```bash
npm run build:supernova-mcp
```

Optional package-level tests:

```bash
npm run test:supernova-mcp
```

### 3.6 Check Docker setup

```bash
npm run dev -- doctor --docker
```

### 3.7 Run a safe dry-run

```bash
npm run dev -- plan "Create nginx on port 8080" --prjName nginx-demo --dry-run
```

This should print:

- static validation metrics,
- agent summary,
- assumptions,
- plan steps,
- detailed dry-run preview,
- generated `docker-compose.yaml` preview,
- state database path,
- dry-run notice.

### 3.8 Deploy after approval

```bash
npm run dev -- plan "Create nginx on port 8080" --prjName nginx-demo --deploy
```

Expected behavior:

1. CLI prints dry-run and compose preview.
2. CLI prints preflight report.
3. CLI asks for approval.
4. If user chooses `y`, it writes compose artifact and deploys through Docker MCP.
5. CLI observes runtime and saves verified state.

### 3.9 Observe and status

```bash
npm run dev -- observe
npm run dev -- status --prjName nginx-demo
npm run dev -- status --prjName nginx-demo --drift
```

### 3.10 Repair drift

```bash
npm run dev -- status --prjName nginx-demo --drift --repair
```

Choose:

- `y` / `yes`: repair runtime to match SQLite desired state.
- `n` / `no`: do nothing.
- `s` / `sync`: update SQLite desired state from current runtime.

### 3.11 Destroy resources

Destroy one project:

```bash
npm run dev -- destroy --project nginx-demo --remove-volumes
```

Destroy all managed resources:

```bash
npm run dev -- destroy-all --remove-volumes
```

### 3.12 Run built CLI

Build first:

```bash
npm run build
```

Then:

```bash
npm run start -- plan "Create nginx on port 8080" --prjName nginx-demo --dry-run
```

Installed binary names after build/package usage:

```bash
aiagent --help
infra-react-agent --help
```

### 3.13 Useful test commands

```bash
npm run test:e2e:docker-mcp
npm run test:e2e:docker-mcp:all-tools
npm run test:chaos
npm run test:pipeline
```

Notes:

- `test:e2e:docker-mcp` requires Docker and built Supernova MCP server.
- `test:chaos` runs real Docker lifecycle scenarios.
- `test:e2e:docker-mcp:all-tools` is a broader diagnostic and may be more environment-sensitive.

## 4. Additional documentation

- `docs/project-onboarding-vi.md`: detailed onboarding and use-case guide for new contributors.
- `docs/tool-system-policy.vi.md`: internal tool and runtime policy notes.
- `docs/testing/three-tier-chaos-matrix.md`: real Docker chaos matrix and lifecycle scenarios.
- `packages/docker-mcp-server-supernova/README.md`: notes for the vendored Docker MCP package.