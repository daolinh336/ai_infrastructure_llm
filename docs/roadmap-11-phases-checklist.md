# Checklist Roadmap 11 Phase — ReAct-Centric

## Locked Mini Project Runtime Path

- [ ] `planned -> preview -> y/n approval -> write docker-compose.yaml -> MCP apply -> Docker Engine API -> observe -> verify -> save desired/actual -> status/drift/destroy` is implemented end-to-end
- [x] default dry-run is no-prompt and non-mutating
- [ ] optional future dry-run review/approval records preview acceptance as a structured ReAct observation
- [ ] optional future dry-run review/approval only controls whether preview output is accepted for later approval input
- [x] default dry-run does not write final `docker-compose.yaml`, call MCP apply, or mutate Docker
- [ ] ReAct calls an approval tool before every side-effecting runtime action; CLI is only the UI transport
- [ ] approval/rejection is recorded as a structured ReAct observation
- [x] `docker-compose.yaml` is written only after user approval
- [x] Docker Compose CLI is not the final runtime apply backend
- [x] runtime apply uses Docker Engine API behind DockerMcpGateway and the vendored Supernova MCP server
- [x] LLM/ReAct Agent/CLI never connect directly to Docker Engine API
- [x] SQLite is the primary state storage layer at `state/infra-state.sqlite`; JSON objects are validated domain payloads inside SQLite, and YAML is artifact output only
- [ ] final desired/actual state is saved only after actual Docker runtime observation and verification
- [x] Phase 6 output feeds Phase 8 approval input
- [ ] Phase 8 `ApprovedAction` feeds Phase 9 MCP contract and Phase 10 runtime adapter
- [x] Phase 10 runtime observation feeds Phase 11 state/status/drift/destroy
- [ ] controlled fault-injection demo is supported: manual stop/remove container, remove image, remove network/volume, or container mismatch can be observed as drift/failure
- [ ] healing path is controlled: detect -> classify -> repair preview -> y/n approval -> MCP repair -> Docker Engine API -> observe -> verify -> save healed actual state
- [ ] rejected repair approval records drift/failure evidence without mutating runtime

## Cách Dùng

Checklist này bám sát roadmap ReAct-centric trong `docs/roadmap-11-phases.md`.

Quy ước:

- chỉ tick khi có bằng chứng trong code/test/log
- docs are tracked in repo; README and canonical roadmap/checklist must match current code/test evidence
- ReAct là kiến trúc điều phối trung tâm
- Static Gateway chạy ngay sau CLI input và trước ReAct
- Static Gateway có thể dùng auxiliary LLM router và Structured LLM Parser để classify/extract, nhưng không được dùng như ReAct Agent
- Static Gateway chỉ tạo `ValidatedQuery`, không tạo execution plan thay ReAct
- Static Gateway tuyệt đối không gọi Docker Engine API, MCP runtime tool, Docker Compose CLI, hoặc inspect runtime state
- LLM parser chỉ trích xuất JSON; code validator mới kiểm tra logic tĩnh bằng schema/rule deterministic
- validator là observation tool bắt buộc
- validator không được lập kế hoạch, tự repair, tự approve, hoặc tự chọn action thay ReAct
- MetaVerifier kiểm tra logic/spec/plan không chạm runtime
- ToolVerifier kiểm tra actual state bằng read-only tools sau khi MetaVerifier pass
- verifier phải trả `VerificationReport` có schema cố định thay vì bắt Planner đọc log thô
- adaptive verification cho phép verifier chọn tool phù hợp theo loại lỗi, nhưng chỉ trong allowed read-only tool surface
- MCP server là Tool System bắt buộc
- Docker Engine API là runtime chính phía sau MCP server

---

## Phase 1 — CLI Scaffold Và ReAct Trace Baseline

- [x] `npm run build` pass
- [x] `npm run typecheck` pass
- [x] `npm run lint` pass
- [x] `npm test` pass
- [x] CLI `plan` chạy được
- [x] CLI `status` chạy được
- [x] dry-run nói rõ không ghi state và không deploy Docker
- [x] save-state nói rõ chỉ lưu desired state, chưa apply runtime
- [x] status hiển thị pending preview/current verified state và actual runtime observation status
- [x] output có observations/plan steps như ReAct trace sơ khai

Definition of done:

- [x] dev workflow cơ bản ổn định
- [x] scaffold đủ sạch để sang domain validation

---

## Phase 2 — Domain Validation Làm ReAct Observation Tool

- [x] schema rõ cho `InfrastructureService`
- [x] schema rõ cho `InfrastructureSpec`
- [x] schema rõ cho `ExecutionPlan`
- [x] schema rõ cho `AgentRunResult`
- [x] schema rõ cho `StateSnapshot`
- [x] validate CLI input
- [x] validate infra spec trước render compose
- [x] validate state snapshot trước save/load
- [x] validation error dễ đọc
- [x] test valid nginx + 2 backend + postgres spec
- [x] test reject invalid service name
- [x] test reject invalid replicas
- [x] test reject invalid port mapping
- [x] test reject invalid dependency
- [x] test execution rejects invalid agent result

Definition of done:

- [x] mọi domain object đi qua Zod validation trước khi dùng
- [x] test phủ các trường hợp hợp lệ và không hợp lệ

---

## Phase 3 — Static Gateway Làm Lọc Trước ReAct

- [x] Intent router phân loại create/update/status/destroy/drift/out-of-scope/unsafe
- [x] Structured LLM Parser trích xuất draft query JSON
- [x] Code static validator kiểm tra logic tĩnh (port, replicas, image whitelist, dangerous mounts, privileged mode, host namespace, resource limits)
- [x] `ValidatedQuery` là đầu vào duy nhất cho ReAct
- [x] Static Gateway từ chối input không hợp lệ trước khi gọi ReAct
- [x] Static Gateway không gọi Docker/MCP/runtime
- [x] test intent classification
- [x] test static rejection (port 99999, replica -2, privileged mode, v.v.)
- [x] test parser JSON output được validate bằng Zod

Definition of done:

- [x] ReAct chỉ nhận `ValidatedQuery` qua gateway
- [x] Static rejection không bao giờ đến ReAct

---

## Phase 4 — Provider Thật Và Structured Output

- [x] OpenAI provider thực qua Responses API
- [x] `completeStructured()` dùng `text.format.type = "json_schema"` và `strict: true`
- [x] Stub provider vẫn hoạt động offline cho test/dev
- [x] Chỉ hỗ trợ `stub|openai|gemini`
- [x] Static Gateway gọi `completeStructured()` cho classify và parse
- [x] ReAct reasoning dùng structured output `react_reasoning_output`
- [x] JSON output parse thất bại -> `DomainValidationError`
- [x] LLM reasoning fail -> observation, không phải runtime action
- [x] CLI `--provider` hỗ trợ stub|openai|gemini
- [x] thiếu API key fail rõ ràng
- [x] test OpenAI provider cấu hình đúng
- [x] test provider path cho `stub|openai|gemini`
- [x] smoke test OpenAI thật (skip mặc định)
- [x] test static gateway với stub
- [x] test ReAct structured reasoning observation

Definition of done:

- [x] đường provider OpenAI thật hoạt động
- [x] structured JSON từ LLM luôn qua Zod validation
- [x] LLM output không bao giờ trực tiếp thành source of truth

---

## Phase 5 — Prompt-to-Spec ReAct Loop

- [x] `propose_draft_spec` tool step trong ReAct
- [x] validation step trước final plan
- [x] `repair_infra_spec` cho draft spec không hợp lệ
- [x] `build_execution_plan` consume validated `InfrastructureSpec`
- [x] plan `assumptions` là first-class field
- [x] normalize image alias (postresql, redos, v.v.)
- [x] test draft spec fail -> repair -> validate -> plan
- [x] test "Tao postresql va redos" hiểu đúng
- [x] test "tao cho toi 300 cai image, 1000 cai container" được ReAct clarify

Definition of done:

- [x] InfrastructureSpec là desired-state source of truth
- [x] Docker Compose chỉ là preview artifact

---

## Phase 6 — Compose Generation Và Dry-Run Preview

- [x] compose renderer sinh YAML từ validated spec
- [x] detailed dry-run preview: services, containers, ports, volumes, networks
- [x] dependency-aware execution schedule
- [x] policy findings trong dry-run
- [x] artifact target path trong dry-run
- [x] explicit no-side-effect evidence (dockerCalled=false, mcpCalled=false, stateSaved=false, artifactWritten=false)
- [x] test render-compose với nhiều service types
- [x] test dependency schedule đúng thứ tự
- [x] test dry-run preview không gọi Docker/MCP

Definition of done:

- [x] dry-run preview đủ chi tiết để user ra quyết định approve/reject
- [x] compose preview deterministic và testable

---

## Phase 7 — SQLite State Persistence

- [x] SQLite tại `state/infra-state.sqlite` qua `better-sqlite3`
- [x] domain snapshots Zod-validated, serialized JSON payload trong SQLite
- - [x] pending preview state tách riêng final desired/actual
- [x] test SQLite save/load roundtrip
- [x] test schema validation trên state load

Definition of done:

- [x] SQLite là storage layer chính
- [x] state model tách pending vs desired/actual

---

## Phase 8 — Approval/Preflight/Typed ApprovedAction Control Boundary

- [x] `plan --apply` chạy Phase 8 preflight
- [x] `classifyPhase8ApplyAction()` phân loại artifact-write
- [x] `classifyDockerDeployAction()` phân loại runtime-create (cho Phase 9/10)
- [x] `runPhase8Preflight()` kiểm tra meta-verification, dry-run evidence, policy findings
- [x] `buildApprovalRequest()` tạo request có preview evidence
- [x] explicit y/n approval gate
- [x] approval rejected -> no compose write, no MCP call, no Docker mutation
- [x] approval accepted -> write docker-compose.yaml artifact, create `ApprovedAction`
- [x] `ApprovedAction` có hash, classification, preflight report, validated spec
- [x] `doctor --docker` read-only Docker CLI/Desktop setup check
- [x] test Phase 8 approval flow
- [x] test rejection no-op
- [x] test preflight fail blocks approval

Definition of done:

- [x] runtime mutation chỉ xảy ra từ typed, validated, approved input
- [x] Phase 8 là control boundary trước runtime

---

## Phase 9+10 — Docker MCP Client + Pluggable Agents + Runtime Deploy (MERGED)

> Phase 9 (Custom MCP Tool System Contract) và Phase 10 (MCP Server + Docker Engine API Runtime) được merged thành một phase duy nhất.
> Sử dụng vendored Supernova Docker MCP server spawn làm subprocess, giao tiếp qua stdin/stdout JSON-RPC.

### Sprint 9+10.1: MCP Client Infrastructure & Pluggable Agents

- [x] `DockerMcpGateway` implement JSON-RPC protocol với `packages/docker-mcp-server-supernova` (dùng `npx -y packages/docker-mcp-server-supernova`)
- [x] read-only methods: `listContainers`, `inspectContainer`, `listImages`, `listNetworks`, `listVolumes`
- [x] mutation methods (behind `setAllowMutations` gate): `createNetwork`, `pullImage`, `createContainer`, `startContainer`, `stopContainer`, `removeContainer`
- [x] Giao thức an toàn 3 lớp (allowMutations mặc định false, mutate methods ném lỗi nếu chưa mở gate, deployWithDocker mở/khóa gate qua try/finally)
- [x] Định nghĩa interface `PlannerAgent` và `VerifierAgent` pluggable (src/agent/agent-interfaces.ts)
- [x] Triển khai `StandardPlannerAgent` tự động đọc thông tin Docker qua MCP client (nếu có) trước khi tạo spec
- [x] Triển khai `StandardVerifierAgent` dùng read-only tools để kiểm trạng thái thực tế và so sánh desired vs actual, trả về `VerificationReport` cố định
- [x] Viết test suite độc lập cho MCP client, deploy flow, và pluggable agents (`tests/tool-registry-policy.test.ts`, `tests/execution-engine-transactional-deploy.test.ts`, `tests/standard-verifier-agent.test.ts`)

### Sprint 9+10.2: Docker Deploy & Runtime Apply

- [x] `deployWithDocker()` trong execution-engine: networks -> pull images -> create/start containers theo dependency order
- [x] Tích hợp deploy vào CLI flow với flag `--deploy` (khi đi kèm `--apply`), yêu cầu Approval gate và ApprovedAction hợp lệ trước khi gọi MCP
- [x] Verifier chạy tự động sau deploy thành công để xuất VerificationReport hiển thị lên màn hình
- [ ] deploy error handling và rollback/partial-cleanup
- [ ] deploy integration test với Docker daemon thật (hiện tại test suite sử dụng mock/subprocess stub)
- [ ] verifier chạy read-only sau apply/preflight để kiểm desired vs actual

### Sprint 9+10.3: State Update After Runtime

- [ ] state lưu desired/actual sau observe + verify actual Docker runtime vào SQLite
- [ ] desired state được neo vào validated `InfrastructureSpec`
- [ ] compose chỉ được lưu/xử lý như artifact hoặc reference
- [ ] `show status` hiển thị desired vs actual từ SQLite

Definition of done:

- [x] deployWithDocker() chạy thật qua MCP client
- [x] ToolVerifier đọc actual state sau apply và trả VerificationReport
- [ ] state lưu desired + actual sau runtime observation vào SQLite

---

## Phase 11 — Status/Drift/Destroy/Healing End-to-End

- [ ] end-to-end flow khóa đúng: `planned -> preview -> y/n -> write docker-compose.yaml -> MCP -> Docker Engine API -> observe -> verify -> save desired/actual`
- [ ] `destroy all` có confirmation và gọi MCP tool
- [ ] drift detector so sánh desired với actual runtime
- [ ] demo user stop container bằng tay -> hệ thống detect stopped/mismatch -> preview restart -> approval -> repair -> verify running
- [ ] demo user remove container bằng tay -> hệ thống detect missing -> preview recreate -> approval -> repair -> verify present/running
- [ ] demo user remove image bằng tay -> hệ thống detect missing image -> preview pull/recreate impact -> approval -> repair -> verify image/container
- [ ] demo user remove network/volume bằng tay -> hệ thống detect missing resource -> preview recreate and risk warning -> approval or ask-user
- [ ] demo container unhealthy/config drift -> verifier dùng healthcheck/log/evidence; nếu thiếu evidence thì báo `uncertain`, không tự sửa mù
- [ ] rejected repair approval records drift/failure evidence and performs no runtime mutation
- [ ] healing state update saves healed actual state only after observe + verify
- [ ] policy/verification/logging đủ tốt để debug
- [ ] error handling đủ rõ để phân biệt validation/preflight/runtime/verification failure

Definition of done:

- [ ] mini project đáp ứng yêu cầu chức năng chính
- [ ] ReAct là xương sống end-to-end, không chỉ là tên folder
- [ ] split-Act pipeline, custom MCP contract, preflight validation, và verifier không còn là TODO sau roadmap
- [ ] MetaVerifier + ToolVerifier không còn bị gom chung thành một bước verify mơ hồ
- [ ] VerificationReport trở thành contract feedback chính giữa Verifier và Planner
- [ ] status/drift dựa trên desired spec + actual observation, không dựa trên compose artifact đơn lẻ
- [ ] end-to-end flow khóa đúng: `planned -> preview -> y/n -> write docker-compose.yaml -> MCP -> Docker Engine API -> observe -> verify -> save desired/actual`
- [ ] healing flow khóa đúng: `fault injection -> observe drift -> classify -> repair preview -> y/n approval -> MCP repair -> observe -> verify -> save healed actual`

---

## Lint Và Test Issues Cần Fix

- [x] 0 lint errors (unused vars trong `standard-planner-agent.ts`, `docker-mcp-gateway.ts`, `execution-engine.ts`, và test files đã được sửa hoàn tất)
- [x] `_fix.cjs` stray file ở repo root đã được xoá
- [x] `npm test` chạy thành công 86/86 test cases mượt mà trên Windows mà không bị lỗi EPERM
- [x] Cập nhật các import và code style để đáp ứng tiêu chuẩn eslint strict của dự án

---

## Đường Nâng Cấp ReAct Sau Baseline

- [ ] self-repair loop khi validation fail
- [ ] self-repair loop khi MetaVerifier fail
- [ ] self-repair/retry/rollback proposal khi ToolVerifier fail
- [ ] tool result memory
- [ ] long-horizon planning
- [ ] chuẩn hóa `VerificationReport` thành memory/replay artifact
- [ ] adaptive verification tool selection có policy và tests riêng
- [ ] nâng verifier agent read-only thành verifier-heavy workflow
- [ ] nâng Run Agent + Verify Agent thành mô hình multi-agent ổn định
- [ ] nâng preflight validation thành dual-environment execution khi runtime boundary đã ổn định
- [ ] reconciliation/remediation loop cho drift
- [ ] controlled fault-injection demo suite cho stop/remove container, missing image/network/volume, unhealthy container, và `uncertain` evidence path
- [ ] explain/replay ReAct trace cho debugging

---

## Ghi Chú Tiến Độ

- Phase gần nhất đã triển khai: `Phase 9+10 (gộp) - Triển khai cơ bản (MCP Client, Pluggable Agents, CLI Deploy & Post-Deploy Verify).`
- Phase 1–8 hoàn thành theo code/test. 86 tests pass, 1 skipped, typecheck pass, build pass.
- Phase 9+10 (MERGED):
  - `DockerMcpGateway` (JSON-RPC tới `packages/docker-mcp-server-supernova` qua `npx -y packages/docker-mcp-server-supernova`), `StandardPlannerAgent` (Docker-aware), `classifyDockerDeployAction`, `runDockerPreflight` đã hoàn tất.
  - Pluggable agents `PlannerAgent` và `VerifierAgent` đã định nghĩa và được inject thành công vào `ReActAgent`.
  - `deployWithDocker()` đã hoàn tất (tạo networks, pull images, tạo/start containers theo dependency order) và được tích hợp thành công vào CLI flow qua flag `--deploy` (kèm `--apply`).
  - Verifier `StandardVerifierAgent` tự động chạy sau khi deploy hoàn tất để tạo báo cáo so sánh trạng thái mong muốn và thực tế.
- Lint & Test: Đã dọn dẹp sạch sẽ (0 lint errors, đã xoá `_fix.cjs`, 86 tests passed 100%).
- Blocker/Gap hiện tại:
  - Docker daemon integration tests (hiện test sử dụng mock/subprocess stub).
  - Deploy error handling và rollback/cleanup khi gặp lỗi.
  - Lưu desired + actual state vào SQLite sau khi verify actual runtime thành công.
  - Cập nhật lệnh `show status` hiển thị desired vs actual từ SQLite.
  - Triển khai Phase 11 (Drift, Destroy, Healing end-to-end).
- Quyết định kiến trúc gần nhất:
  - SQLite via better-sqlite3 là storage layer chính.
  - `InfrastructureSpec` là desired-state source of truth.
  - `DockerMcpGateway` wraps community MCP Docker server thay vì viết custom server (được chuyển làm hướng nâng cấp sau Phase 11).
