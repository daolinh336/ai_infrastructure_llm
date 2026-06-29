# He thong tool va policy runtime

## Muc tieu

Nang cap nay giu nguyen workflow nguoi dung hien tai:

`lenh ngon ngu tu nhien -> agent lap ke hoach -> validate -> preview/dry-run -> y/n approval -> deploy -> observe/status/drift`

Thay doi nam o kien truc noi bo: tool duoc quan ly bang registry, runtime action co metadata/policy ro hon, deploy that theo huong all-or-nothing.

## Agent tool registry

Agent tool la cac cong cu noi bo TypeScript phuc vu qua trinh lap ke hoach, validate, render preview va luu state. Tool registry gom:

- `src/agent/tool-types.ts`: contract cho internal tool.
- `src/agent/tool-registry.ts`: dang ky, lookup, list va invoke tool.
- `src/agent/internal-tools.ts`: mot file chung gom 11 internal tools, schema va category.
- `src/agent/react-agent.ts`: chi giu orchestration va lookup tool qua registry.

Moi tool co metadata:

- `name`: ten duy nhat.
- `description`: mo ta ngan.
- `category`: `read`, `plan`, `validate`, `preview`, hoac `state`.
- `inputSchema`: Zod schema tuy chon.
- `outputSchema`: Zod schema tuy chon.
- `invoke(input)`: handler thuc thi.

## Agent tools hien tai

- `load_state`: doc SQLite state.
- `resolve_image_reference`: chuan hoa image reference.
- `propose_draft_spec`: tao draft infrastructure spec.
- `repair_infra_spec`: sua spec khi validate fail.
- `build_execution_plan`: tao execution plan.
- `validate_infra_spec`: validate desired spec.
- `build_dependency_aware_execution_schedule`: tao schedule theo dependency.
- `render_compose_preview`: render Docker Compose preview.
- `build_detailed_dry_run_preview`: tao dry-run preview chi tiet.
- `evaluate_dry_run_policy`: danh gia policy preview.
- `save_state`: luu state/pending preview.

## Runtime policy

Runtime policy nam tai `src/execution/tool-policy.ts`.

Quy tac hien tai:

- Tool `read`, `plan`, `validate`, `preview`, `state`: khong can approval runtime.
- Runtime `mutate`: can approval.
- Runtime `destructive`: can approval.
- Dry-run khong duoc chay `mutate` hoac `destructive`.

Docker MCP gateway van dung `setAllowMutations(true)` nhu approval context noi bo. Neu chua bat co nay, route mutate/destructive bi chan.

Gateway runtime mac dinh la vendored Supernova MCP server: `node packages/docker-mcp-server-supernova/dist/index.js`. Co the override co kiem soat bang `INFRA_DOCKER_MCP_COMMAND`, `INFRA_DOCKER_MCP_ARGS`, hoac chon debug profile `INFRA_DOCKER_MCP_PROFILE=official` cho Docker Desktop MCP Gateway. He thong khong fallback ngam sang Docker CLI neu MCP runtime thieu.

## Docker MCP route metadata

Docker MCP route table nam tai `src/execution/mcp-routing-table.ts`. Moi route co:

- `operation`: ten operation typed trong code.
- `mcpToolName`: ten tool tren MCP server.
- `category`: `read` hoac `mutate`.
- `destructive`: co xoa/dung/thay doi resource ton tai hay khong.
- `approvalRequired`: co can approval hay khong.
- `riskLevel`: `low`, `medium`, `high`.

Route table giu ten operation typed noi bo. `DockerMcpGateway` goi `tools/list` de resolve ten tool thuc te cua MCP server truoc khi chay. Neu thieu capability bat buoc, preflight fail closed truoc runtime mutation.

Observation/verification chi doc runtime qua MCP. `inspectContainer` khong goi `docker inspect`, va log/readback khong goi `docker logs` neu MCP server khong expose tool tuong ung.

Read routes:

- `listContainers`
- `inspectContainer`
- `listImages`
- `listNetworks`
- `listVolumes`

Mutate/destructive routes:

- `pullImage`
- `createContainer`
- `startContainer`
- `stopContainer`
- `restartContainer`
- `removeContainer`
- `removeImage`
- `createNetwork`
- `removeNetwork`
- `createVolume`
- `removeVolume`

## All-or-nothing deploy

Deploy that phai theo nguyen tac: mot la deploy day du, hai la rollback nhung resource vua tao.

Quy tac hien tai:

- Truoc khi tao resource, engine kiem tra container mong muon da ton tai nhung khong running hay khong.
- Neu co container ton tai nhung stopped/exited, deploy bi chan de tranh mutate resource cu.
- Neu tao resource moi thanh cong roi buoc sau fail, engine rollback resource moi theo thu tu nguoc.
- Rollback gom: stop/remove container moi, remove network moi, remove volume moi.
- Image da pull khong bi remove mac dinh vi day la cache, khong phai running infrastructure.
- Neu rollback fail, error tra ve kem so luong cleanup success/fail va leftover.

## Cach them internal tool moi

1. Tao handler tool hoac factory tool.
2. Dinh nghia `name`, `description`, `category`.
3. Gan `inputSchema` va `outputSchema` neu co the.
4. Dang ky tool vao registry mac dinh cua agent.
5. Them test cho happy path va validation fail.
6. Neu tool co side effect runtime, khong dat trong agent tool; dua qua execution/runtime boundary va policy gate.
