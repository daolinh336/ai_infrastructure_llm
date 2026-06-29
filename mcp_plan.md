# Thiết Kế Chuẩn Chính Chủ: Docker MCP Gateway

## Summary
- Chuyển runtime boundary sang **Docker MCP Gateway chính chủ**: `docker mcp gateway run`.
- Mục tiêu security: **100% runtime Docker operations đi qua MCP**, không còn fallback `docker inspect` qua Docker CLI.
- Agent vẫn chỉ sinh `InfrastructureSpec`; `ExecutionEngine` vẫn quyết định typed actions; `DockerMcpGateway` chỉ gọi MCP tools đã whitelist.
- Nếu Docker MCP Gateway hoặc required tools chưa sẵn sàng, hệ thống **fail closed trước khi mutate Docker**.

## Key Changes
- **Runtime profile chính chủ**
  - Thêm cấu hình MCP runtime profile mặc định: `command: docker`, `args: ["mcp", "gateway", "run"]`.
  - Cho phép override qua env để dev/test: `INFRA_DOCKER_MCP_COMMAND`, `INFRA_DOCKER_MCP_ARGS`.
  - Không dùng shell MCP server và không expose raw command/path API.

- **Capability preflight bắt buộc**
  - Trước deploy, gọi `tools/list` và kiểm tra đủ tool tối thiểu: list containers/images/networks/volumes, pull image, create/start/stop/remove container, create/remove network, create/remove volume, inspect container.
  - Nếu tool name của Docker Gateway khác `uvx mcp-server-docker`, thêm `DockerMcpRouteProfile` để map theo server capability thay vì hard-code một route table duy nhất.
  - Nếu thiếu `inspect_container` hoặc equivalent inspect tool: dừng với lỗi “MCP observation capability missing”, không fallback CLI.

- **Strict observation mode**
  - Xóa hoặc disable mặc định nhánh gọi `docker inspect` trực tiếp trong `E:\vdt\ai_infra_llm\src\execution\docker-mcp-gateway.ts`.
  - `inspectContainer()` chỉ được gọi qua MCP; lỗi inspect làm verification failed/blocked, không âm thầm chuyển sang Docker CLI.
  - `observeActualStateWithInspect()` không chấp nhận list-only observation trong deploy verification strict mode.

- **Official Gateway setup contract**
  - Document prerequisite: Docker Desktop phiên bản có Docker MCP Toolkit/Gateway và command `docker mcp gateway run`.
  - Document MCP catalog/server cần bật để expose Docker runtime tools.
  - Nếu máy chưa có `docker mcp`, CLI báo rõ: “Install/enable Docker MCP Toolkit in Docker Desktop”, không tự fallback sang `uvx`.

## Implementation Notes
- Sửa tập trung quanh `E:\vdt\ai_infra_llm\src\execution\docker-mcp-gateway.ts`, `E:\vdt\ai_infra_llm\src\execution\mcp-routing-table.ts`, và deploy preflight trong execution/CLI.
- Giữ `McpConnectionPlug` stdio JSON-RPC hiện tại vì tương thích `docker mcp gateway run`.
- Thêm profile route theo capability discovery để tránh phụ thuộc tên tool của third-party `uvx`.
- Giữ `uvx mcp-server-docker` chỉ như dev profile explicit, không phải đường production/security chuẩn.

## Test Plan
- Unit test: missing `inspect_container` trong `tools/list` làm deploy preflight fail trước mutation.
- Unit test: `inspectContainer()` không gọi Docker CLI fallback trong strict mode.
- Unit test: route profile resolve đúng tool names từ Docker Gateway hoặc báo thiếu capability rõ ràng.
- Manual verify sau khi Docker Desktop hỗ trợ MCP:
  - `docker mcp gateway run` handshake được.
  - `node dist/cli/index.js observe` chỉ gọi MCP tools.
  - `node dist/cli/index.js plan "Tao nginx port 8088" --apply --deploy` chạy preflight, approve, deploy, inspect, verify qua MCP.

## Assumptions
- Chọn hướng **chuẩn chính chủ**: Docker Desktop sẽ được nâng cấp/cấu hình để có `docker mcp gateway run`.
- Không chấp nhận Shell/Bash MCP server vì phá boundary security.
- Không chấp nhận Docker CLI fallback trong verification path.
- Nếu Docker official Gateway chưa expose Docker runtime tool tương đương, hệ thống sẽ fail closed thay vì quay lại `uvx` hoặc CLI.
