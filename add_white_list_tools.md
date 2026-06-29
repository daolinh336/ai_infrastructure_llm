# Plan: Role-Based MCP Whitelist Cho Planner / Executor / Verifier

## Summary
- Tích hợp security boundary theo role: `planner-readonly`, `verifier-readonly`, `executor-approved`, và `admin-disabled`.
- LLM/planner không được gọi raw Supernova tools; mọi runtime access đi qua interface hẹp và whitelist ở gateway/policy layer.
- Executor chỉ mutate sau approval, preflight pass, và resource scope hợp lệ.
- Verifier dùng MCP read-only client riêng, không share mutation-enabled client với executor.

## Key Changes
- Thêm role/mode vào Docker MCP layer:
  - `PlannerRuntimeReader`: context đọc tối thiểu cho planner.
  - `VerifierRuntimeReader`: observation/read-only sâu cho verifier.
  - `ApprovedDockerExecutor`: preflight read + approved mutate cho executor.
  - `AdminRuntimeTools`: để future, disabled mặc định.
- Mở rộng route metadata trong `E:\vdt\ai_infra_llm\src\execution\mcp-routing-table.ts`:
  - `allowedRoles`
  - `riskLevel`
  - `requiresApproval`
  - `requiresResourceScope`
  - `secretSensitive`
  - `externalNetwork`
  - `expensive`
- `DockerMcpGateway` enforce role whitelist trong `executeRoute()` trước khi gọi MCP.
- Không truyền full `DockerMcpGateway` vào planner/verifier nữa; chỉ truyền interface hẹp đúng role.
- Tạo gateway factory, ví dụ:
  - `createPlannerRuntimeReader()`
  - `createVerifierRuntimeReader()`
  - `createApprovedDockerExecutor(approvalContext)`
- Giữ Supernova all-tools test để kiểm tra compatibility, nhưng app gateway chỉ expose whitelist theo role.

## Role Whitelist

### Planner: `planner-readonly`
- Mục đích: giúp lập spec tốt hơn, tránh conflict.
- Cho phép:
  - `list_containers`
  - `list_images`
  - `list_networks`
  - `list_volumes`
  - `docker_info`
- Có thể thêm sau, nhưng phải redact:
  - `inspect_container`
- Cấm tuyệt đối:
  - mọi mutate route
  - `exec_in_container`
  - `copy_to_container`
  - `registry_*`
  - `use_context`
  - `prune_*`
  - `scan_image`
  - `vulnerability_report`
- Interface đề xuất:
  - `listUsedHostPorts()`
  - `listContainerNames()`
  - `listImageReferences()`
  - `listNetworkNames()`
  - `listVolumeNames()`

### Verifier: `verifier-readonly`
- Mục đích: kiểm chứng actual state sau deploy/repair.
- Cho phép:
  - `list_containers`
  - `inspect_container`
  - `list_images`
  - `list_networks`
  - `list_volumes`
  - `stream_logs`
  - `container_stats`
  - `docker_info`
- Chỉ inspect/log resource thuộc desired project hoặc attempt scope khi có scope.
- Cấm tuyệt đối:
  - mọi create/start/stop/remove/prune/pull/build/run
  - `exec_in_container`
  - `copy_to_container`
  - `use_context`
  - `registry_*`
- Interface đề xuất:
  - `observeActualStateWithInspect({ containerNames })`
  - `inspectContainer(name)`
  - `readContainerLogs(name, tail)`
  - `readContainerStats(name)`

### Executor: `executor-approved`
- Mục đích: thực thi `ApprovedAction` sau preview + approval.
- Cho phép preflight read:
  - `list_containers`
  - `inspect_container`
  - `list_images`
  - `list_networks`
  - `list_volumes`
- Cho phép mutate sau approval:
  - `pull_image`
  - `run_container`
  - `start_container`
  - `stop_container`
  - `create_network`
  - `create_volume`
- Cho phép cleanup/destructive có scope:
  - `remove_container`
  - `remove_network`
  - `remove_volume`
- Cấm mặc định:
  - `prune_*`
  - `exec_in_container`
  - `copy_to_container`
  - `use_context`
  - `registry_login`
  - `registry_push`
  - `compose_*`
  - `scan_image`
  - `vulnerability_report`
- Interface đề xuất:
  - `preflightDeployment(spec)`
  - `pullImage(ref)`
  - `createNetwork(name, labels)`
  - `createVolume(name, labels)`
  - `createContainer(specWithLabels)`
  - `cleanupAttemptScope(attemptScope)`

### Admin: `admin-disabled`
- Không dùng trong deploy path thường.
- Chỉ bật bằng explicit future policy cho:
  - `exec_in_container`
  - `copy_to_container`
  - `copy_from_container`
  - `use_context`
  - `registry_login`
  - `registry_push`
  - `prune_*`
  - `compose_*`
  - `build_image`
  - `scan_image`
  - `vulnerability_report`

## Implementation Plan

### 1. Define Capability Types
- Tạo module mới `E:\vdt\ai_infra_llm\src\execution\mcp-capabilities.ts`.
- Định nghĩa:
  - `DockerMcpRole = 'planner-readonly' | 'verifier-readonly' | 'executor-approved' | 'admin-disabled'`
  - `McpOperationName`
  - `ApprovalContext`
  - `ResourceScope`
  - `RoutePolicyDecision`
- Tạo helper:
  - `isReadOnlyRole(role)`
  - `requiresApproval(route)`
  - `requiresScope(route)`
  - `redactToolArgs(route, args)`

### 2. Extend Route Table
- Cập nhật `DOCKER_MCP_ROUTES` để chứa role whitelist.
- Route hiện có phải map như sau:
  - planner: read list/info only
  - verifier: read/list/inspect/log/stats
  - executor: preflight read + approved mutate subset
- Không thêm toàn bộ 51 Supernova tools vào app route table mặc định.
- Nếu route admin được khai báo, đặt `allowedRoles: ['admin-disabled']` và fail closed.

### 3. Enforce Role In Gateway
- `DockerMcpGatewayOptions` thêm `role`.
- Default role không được là mutate; chọn `verifier-readonly` hoặc require explicit role.
- `executeRoute(operation, args, context?)` kiểm tra:
  - operation tồn tại trong route table
  - role hiện tại nằm trong `allowedRoles`
  - mutate route có approval context hợp lệ
  - destructive route có resource scope
  - args không chứa unredacted secrets khi log/audit
- `setAllowMutations(true)` không còn đủ một mình; phải có `ApprovalContext`.

### 4. Introduce Narrow Interfaces
- Tạo `E:\vdt\ai_infra_llm\src\execution\runtime-ports.ts`.
- Định nghĩa:
  - `PlannerRuntimeReader`
  - `VerifierRuntimeReader`
  - `ApprovedDockerExecutor`
- Adapter classes:
  - `DockerPlannerRuntimeReader`
  - `DockerVerifierRuntimeReader`
  - `DockerApprovedExecutor`
- Các adapter wrap `DockerMcpGateway` role tương ứng, không expose raw `callTool`.

### 5. Refactor Planner
- Sửa `PlannerAgent.proposeSpec()` để nhận `PlannerRuntimeReader` thay vì `DockerMcpGateway`.
- `StandardPlannerAgent` chỉ đọc:
  - container names
  - image refs
  - network names
  - used host ports
- Không inspect env/secrets trong planner.
- Nếu reader fail, planner tiếp tục với state snapshot như hiện tại.

### 6. Refactor Verifier
- Sửa `VerifierAgent.verify()` nhận `VerifierRuntimeReader`.
- `RuntimeEnvironmentReader` nhận read-only interface, không nhận full gateway.
- Verifier không có method mutate trong type system.
- `verifyAfterApply()` tạo/nhận verifier reader riêng, không dùng executor instance đang `allowMutations`.

### 7. Refactor Executor
- `ExecutionEngine.deployWithDocker()` nhận `ApprovedDockerExecutor`.
- Executor adapter giữ approval context:
  - approved action id
  - operation id
  - project name
  - attempt scope
  - approved at
- Mọi create operation tự động gắn labels:
  - `infra-react-agent.project`
  - `infra-react-agent.operation-id`
  - `infra-react-agent.approved-action-id`
- Cleanup/remove chỉ được với:
  - resource name thuộc attempt scope, hoặc
  - observed labels match approval context.

### 8. Update CLI Flow
- Planning phase:
  - không tạo mutate gateway.
  - nếu cần runtime context, tạo `planner-readonly` reader.
- Deploy phase:
  - sau approval, tạo `ApprovedDockerExecutor`.
  - tạo `VerifierRuntimeReader` riêng cho pre/post verification.
- Closed loop:
  - executor apply
  - verifier observe/check
  - planner revise only from `VerificationReport`, not from mutate client.

### 9. Audit Logging
- Thêm audit event cho mỗi route call:
  - timestamp
  - role
  - operation
  - MCP tool name
  - approval id nếu có
  - project/operation scope
  - args redacted
  - result status
- Không log:
  - env secret values
  - registry passwords
  - file contents from copy tools
- Audit có thể bắt đầu bằng structured in-memory/log output, sau đó lưu SQLite.

### 10. Compatibility With Supernova
- Giữ `test:e2e:docker-mcp:all-tools` để đảm bảo Supernova server hoạt động.
- Thêm test mới để đảm bảo app gateway không expose raw all-tools.
- Không để `tools/list` tự động mở thêm route cho agent; tool discovery chỉ dùng preflight capability, không dùng authorization.

## Tests

### Unit Tests
- Planner role:
  - allows list/info routes.
  - rejects `run_container`, `pull_image`, `remove_container`, `exec_in_container`.
- Verifier role:
  - allows `inspect_container`, `stream_logs`, `container_stats`.
  - rejects all mutate/admin routes.
- Executor role:
  - rejects mutate without approval context.
  - allows mutate with valid approval context.
  - rejects destructive route without resource scope.
- Route table:
  - every operation has `allowedRoles`.
  - every destructive route has `requiresResourceScope=true`.
  - every external/expensive/admin route is not in planner/verifier/executor normal whitelist.

### Integration Tests
- Planner gets only `PlannerRuntimeReader`; TypeScript test prevents full gateway leak.
- Verifier gets only `VerifierRuntimeReader`; cannot call mutate at compile time.
- Executor deploy labels every created resource.
- Cleanup removes only scoped resources.
- Closed-loop deploy uses separate executor and verifier clients.

### E2E Tests
- Existing:
  - `npm run test:e2e:docker-mcp`
  - `npm run test:e2e:docker-mcp:all-tools`
- Add:
  - `npm run test:e2e:docker-mcp:roles`
- Role E2E scenarios:
  - planner can read ports/images but cannot mutate.
  - executor cannot mutate before approval.
  - executor deploys after approval.
  - verifier observes deployed container using read-only client.
  - verifier fails closed if asked to call mutate.
  - cleanup only removes resources from attempt scope.

## Acceptance Criteria
- No planner/verifier code accepts full `DockerMcpGateway`.
- No code path lets LLM select arbitrary MCP tool names.
- Mutations require executor role + approval context.
- Destructive operations require resource scope.
- Verifier uses a separate read-only runtime reader.
- All existing deploy E2E tests pass.
- New role-boundary E2E passes.
- Supernova all-tools compatibility test still passes but remains separate from app authorization.

## Assumptions
- Planner is allowed read-only context, but not deep secret-bearing inspect by default.
- Executor may perform read preflight checks, but cannot revise plan/spec.
- Verifier must remain read-only even during repair loops.
- Admin/high-risk Supernova tools stay disabled until a separate admin policy is explicitly designed.
