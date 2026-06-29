# Roadmap Chi Tiết 11 Phase — ReAct-Centric

## Locked Mini Project Runtime Path

The final 11-phase roadmap must satisfy this mandatory end-to-end path:

```text
planned
  -> render Docker Compose YAML preview
  -> ask the user for explicit y/n approval
  -> if yes, write docker-compose.yaml as an execution artifact
  -> call the approved MCP tool
  -> MCP server calls Docker Engine API
  -> observe Docker containers/networks/volumes/images
  -> verify desired-vs-actual runtime state
  -> save desired state + actual state
  -> status / drift / destroy operate from desired spec + actual Docker observation
  -> controlled fault injection demo can stop/delete/alter runtime resources
  -> observe drift/failure
  -> classify failure
  -> preview repair/healing plan
  -> ask y/n approval
  -> apply approved repair through MCP/Docker adapter
  -> observe and verify healed state
```

Hard requirements:

- Default dry-run must stay no-prompt and non-mutating. Real apply approval must remain mandatory.
- If a later experiment adds dry-run approval, it only authorizes accepting preview output as planning evidence; it must not write the final `docker-compose.yaml`, call MCP apply, or mutate Docker.
- The CLI must ask the user for explicit y/n approval before every side-effecting runtime action.
- Approval or rejection must become a structured ReAct observation.
- `docker-compose.yaml` must be written only after approval and treated as an artifact, not as the source of truth.
- Docker Compose CLI is not the runtime apply backend for this roadmap.
- Runtime apply must use Docker Engine API behind a narrow MCP boundary.
- Neither the LLM, the ReAct Agent, nor the CLI may connect directly to Docker Engine API.
- The only allowed mutation path is `ReAct/Execution -> DockerMcpGateway -> approved MCP route -> Docker Engine API`.
- SQLite is the primary state storage layer. Domain state snapshots are validated with Zod and stored as JSON payloads inside `state/infra-state.sqlite`; YAML is only generated artifact/config output.
- State may save a pending preview before approval, but final desired/actual state must only be saved after runtime observation verifies actual Docker state.
- Healing/reconciliation must follow the same approval rule as apply: the system may detect and propose repair automatically, but it must not recreate, restart, remove, pull, or mutate runtime resources without an approved typed action.
- The project should support a controlled demo where a human intentionally stops/removes containers, removes images, or changes runtime state; the system must report drift/failure, explain evidence, preview repair, request approval, apply the approved repair, then verify the healed state.

Phase coupling rules:

- Phase 6 produces deterministic preview, dependency-aware dry-run evidence, impact/policy observation, and artifact target path.
- Phase 7 defines pending preview state separately from final desired/actual runtime state.
- Phase 8 consumes Phase 6/7 outputs through ReAct approval tools; CLI is only the UI transport for y/n approval.
- Phase 8 default dry-run emits preview evidence without approval; Phase 8 apply approval writes the approved compose artifact and emits typed `ApprovedAction`.
- Phase 9 turns `ApprovedAction` into narrow MCP tool contracts; it does not expose raw Docker or shell tools.
- Phase 10 implements those MCP contracts with Docker Engine API behind the Docker Runtime Adapter and read-only observation/verifier tools.
- Phase 11 proves the whole chain end-to-end through apply/status/destroy/drift/healing, including controlled manual fault injection.

## Mục Đích

Tài liệu này bám sát yêu cầu bài toán: xây dựng CLI quản lý hạ tầng bằng ngôn ngữ tự nhiên, sử dụng **AI Agent theo kiến trúc ReAct** để phân tích yêu cầu, lập kế hoạch, gọi tools, quan sát kết quả, và lặp lại cho tới khi hạ tầng đạt trạng thái mong muốn.

Trong roadmap này, **ReAct là xương sống kiến trúc**. Các phần còn lại không đứng ngoài ReAct, mà là tool hoặc observation được Agent điều phối:

- Static Gateway là lớp lọc trước ReAct, gồm auxiliary LLM router/parser và code static validator.
- **InfrastructureSpec là source of truth cho desired infrastructure state**.
- **ExecutionPlan là lớp thủ tục** mô tả validate, preview, approve, apply, observe đối với spec.
- **Docker Compose YAML chỉ là artifact** được render từ spec để preview, preflight, và execution support; không phải canonical domain model.
- LLM provider là reasoning engine.
- Validator là deterministic observation tool.
- MetaVerifier là tầng kiểm tra logic/spec/plan không chạm runtime.
- ToolVerifier là tầng kiểm tra thực tế bằng read-only tools sau khi MetaVerifier pass.
- VerificationReport là contract chuẩn để Planner/Agent nhận kết quả verify thay vì đọc log thô.
- Adaptive verification cho phép Verifier chọn tool kiểm tra phù hợp theo loại lỗi và evidence cần thu thập.
- Compose renderer là preview/action tool.
- State Manager là memory + observation store.
- Approval/policy là action gate.
- MCP server là Tool System bắt buộc.
- Docker Engine API là runtime thật phía sau MCP server.
- Drift detector là observation tool.
- Reconciliation/healing là workflow có kiểm soát: detect lỗi hoặc drift, phân loại, tạo repair plan, preview, xin approval, apply qua MCP/runtime adapter, observe lại, rồi verify. Healing không được là LLM tự sửa trực tiếp.

Mục tiêu cuối cùng:

- người dùng nhập lệnh ngôn ngữ tự nhiên qua CLI
- ReAct Agent phân tích, lập kế hoạch, hành động, quan sát, lặp lại
- tích hợp ít nhất một LLM provider thật: Gemini hoặc OpenAI
- output LLM được chuẩn hóa và validate trước khi đi tiếp
- sinh Docker Compose YAML để dry-run preview
- bắt buộc có MCP server làm Tool System
- MCP server gọi Docker Engine API để thao tác container, network, volume, image
- State Manager lưu desired state và actual state
- `show status`, `destroy all`, và drift detection hoạt động end-to-end
- demo lỗi/healing có kiểm soát hoạt động end-to-end: user có thể dừng/xóa container, xóa image, hoặc tạo drift thủ công; hệ thống phát hiện, giải thích, preview repair, xin approval, heal, và verify lại

Runtime path cuối cùng:

```text
CLI
  -> Static Gateway
  -> Auxiliary LLM Intent Check
  -> Structured LLM Parser
  -> Code Static Validator
  -> ValidatedQuery
  -> ReAct Agent Core
  -> Reason with LLM
  -> Act: propose draft intent/spec
  -> Observe: validator result
  -> Act: meta-verify spec/plan
  -> Observe: VerificationReport for logic completeness/consistency
  -> Act: render preview / build plan
  -> Observe: preview/policy result
  -> Act: request approval
  -> Observe: approval result
  -> Act: call MCP tool
  -> MCP Server / Tool System
  -> Docker Engine API
  -> Observe: runtime state
  -> Act: tool-verify actual runtime with adaptive read-only tools
  -> Observe: VerificationReport for desired-vs-actual result
  -> State Manager
  -> Drift Detection
  -> Reconciliation / Healing proposal
  -> Approval
  -> Approved repair through MCP/Docker adapter
  -> Observe healed runtime state
  -> Verify healed desired-vs-actual state
```

Nguyên tắc trung tâm:

```text
Raw query đi qua static validation trước.
Static validation không chạm Docker Engine API.
Static validation không gọi MCP runtime tool.
Static validation không thay ReAct suy luận.
Auxiliary LLM router/parser không phải ReAct Agent.
Structured LLM Parser chỉ trích xuất JSON, không kiểm tra logic thay code.
Auxiliary LLM router/parser không tạo execution plan.
LLM đề xuất.
Validator kiểm chứng.
MetaVerifier kiểm tra logic/spec/plan trước runtime.
ToolVerifier kiểm tra actual state bằng read-only tools sau runtime/preflight.
VerificationReport đóng gói kết quả verify theo schema cố định.
Verifier được chọn tool linh hoạt theo loại lỗi, nhưng chỉ trong allowed read-only tool surface.
ReAct điều phối.
Validator không lập kế hoạch thay ReAct.
Validator không tự chọn hành động tiếp theo.
MCP thực thi tool.
Docker chạy runtime thật.
Observation quay lại ReAct.
Fault injection là kịch bản demo hợp lệ, nhưng chỉ được dùng để tạo observation/drift; mọi healing mutation vẫn phải qua preview, approval, MCP contract, runtime adapter, và verifier.
```

Validator chỉ được trả lời các câu hỏi dạng:

- input có đúng schema không
- input có hợp domain rule không
- có lỗi/policy warning nào cần Agent biết không
- observation có đủ rõ để Agent repair, hỏi lại user, hoặc dừng an toàn không

Validator không được tự làm các việc của ReAct:

- không tự suy luận topology từ prompt
- không tự chọn service/runtime action tiếp theo
- không tự repair prompt/spec mà không đi qua Agent
- không tự gọi MCP/Docker
- không thay thế approval hoặc policy gate

Static Gateway là lớp khiên đầu tiên ngay sau CLI input. Nó xử lý phần tĩnh trước khi ReAct được phép chạy:

1. **Auxiliary LLM Intent Check**

   Dùng model nhỏ/rẻ như GPT-4o-mini hoặc Gemini Flash để phân loại ý định:

   - đây có phải lệnh quản lý/triển khai hạ tầng không
   - đây là create/update/status/destroy/drift hay out-of-scope
   - câu lệnh có dấu hiệu lạm dụng/bất hợp lệ không, ví dụ "hack facebook"

   Nếu out-of-scope hoặc unsafe thì reject ngay. Ví dụ:

   - "Kể cho tôi một câu chuyện cười" -> reject vì không phải lệnh hạ tầng
   - "Làm sao để hack facebook" -> reject vì unsafe/out-of-scope

2. **Structured LLM Parser**

   Dùng Structured Output hoặc Function Calling để ép LLM trả về duy nhất một JSON theo schema hẹp. Parser này chỉ làm nhiệm vụ "dịch thuật" từ ngôn ngữ tự nhiên sang dữ liệu có cấu trúc, không được tự validate logic:

   - service intent
   - requested replicas
   - requested images/runtimes
   - requested ports
   - destructive intent flag
   - missing information hints

   Nếu thông tin không có trong câu user, parser để `null` hoặc mảng rỗng theo schema. Parser không được tự bịa default quan trọng, không được tự kết luận `port 99999` hợp lệ hay `replicas = -2` là sai; phần đó thuộc code validator.

3. **Code Static Validator**

   Kiểm tra JSON nháp bằng schema/rule deterministic, ví dụ Zod trong Node.js/TypeScript. Đây là nơi fail-fast và trả lỗi ngay cho CLI:

   - prompt có rỗng hoặc sai format không
   - các tham số tĩnh rõ ràng có vô lý không, ví dụ `replica = -2`
   - port có ngoài `1..65535` không
   - intent rủi ro cao có cần confirmation flag không, ví dụ `destroy all`
   - query có thiếu thông tin bắt buộc để đưa vào ReAct không, ví dụ yêu cầu tạo service cụ thể nhưng thiếu image name theo policy hiện hành
   - naming convention Docker cho container/volume/network
   - security guardrails
   - resource bounds
   - image whitelist

Đầu ra hợp lệ của lớp này là `ValidatedQuery`, ví dụ:

```text
raw: original user prompt
normalizedPrompt: normalized prompt text
intent: create/update/status/destroy/drift
draft: structured extracted query
riskFlags: [...]
securityFindings: [...]
resourceEstimate: optional static estimate
clarificationRequired: true/false
clarificationQuestion: optional
```

Nếu `clarificationRequired = true`, CLI hỏi lại user và **không gọi ReAct Agent**. Nếu query hợp lệ, ReAct mới bắt đầu suy luận.

Nếu code validator fail, CLI trả lỗi ngay và **không đánh thức ReAct Agent**. Ví dụ:

```text
User: Tạo 1 web app port 99999, replica -2
Structured LLM Parser: { "services": [{ "port": 99999, "replicas": -2 }] }
Code Static Validator: fail
CLI: Port phải nằm trong 1..65535; replicas phải >= 1.
ReAct: not invoked
Docker/MCP: not invoked
```

Static Gateway tuyệt đối không được:

- gọi Docker Engine API
- gọi MCP server/runtime tool
- gọi Docker Compose CLI
- inspect container/network/volume/image thật
- tạo execution plan thay ReAct
- tự repair infrastructure spec thay ReAct
- gọi auxiliary LLM như một Agent reasoning step

### Static Validation Rules Và Metrics Check

Các tiêu chí static check bắt buộc cho mini project:

- **Intent relevance**: chỉ nhận lệnh hạ tầng; reject joke/chat/off-topic/unsafe cyber request.
- **Naming convention**: container, volume, network chỉ dùng `[A-Za-z0-9_-]`, không có dấu cách hoặc ký tự lạ.
- **Security guardrails**: block yêu cầu mount `/var/run/docker.sock`, `/etc`, `/`, host path nhạy cảm, `privileged: true`, host network/pid/ipc nếu xuất hiện.
- **Resource bounds**: tổng container không quá `10`; nếu hỗ trợ tài nguyên thì CPU `<= 4`, RAM `<= 8GB`.
- **Image whitelist**: chỉ cho runtime/image được phép trong baseline, ví dụ `nginx`, `node`, `python`, `postgres`, `mysql`, `redis`.
- **Replica/port sanity**: replicas phải dương và nằm trong limit; port phải đúng `host:container` và nằm trong `1..65535`.
- **High-risk intent flag**: `destroy all` hoặc thao tác destructive không reject mặc định, nhưng phải bật confirmation/risk flag.
- **Clarification trigger**: thiếu image/runtime bắt buộc thì hỏi lại trước ReAct.

Static validation không kiểm tra điều kiện động của host. Các check như "port 80 có đang bị chiếm không", "container hiện có là gì", "network đã tồn tại chưa" phải nằm sau ReAct dưới dạng MCP/Docker observation.

Metrics cần log/test:

- `intentAccepted`, `intentRejected`, `unsafeRejected`, `clarificationRequired`
- `schemaValidationPassed`, `schemaValidationFailed`
- `securityBlocked`, `resourceLimitBlocked`, `imageWhitelistBlocked`
- `runtimeCallsDuringStaticValidation = 0`
- test case off-topic: "Kể cho tôi một câu chuyện cười" -> reject
- test case unsafe: "Làm sao để hack facebook" -> reject
- test case security: "mount /var/run/docker.sock" -> block
- test case missing image: "Tạo web app" theo policy yêu cầu image -> clarification
- test case invalid static logic: "Tạo 1 web app port 99999, replica -2" -> code validator reject, ReAct not invoked

---

## Tổng Quan 11 Phase

1. **Phase 1 — CLI scaffold và ReAct trace baseline**
2. **Phase 2 — Domain validation làm ReAct observation tool**
3. **Phase 3 — Static Gateway và ReAct Agent Tool interface**
4. **Phase 4 — Auxiliary router + Structured LLM parser và provider output**
5. **Phase 5 — Prompt-to-spec ReAct loop**
6. **Phase 6 — Compose preview, detailed dry-run, và policy observation**
7. **Phase 7 — State Manager như ReAct memory**
8. **Phase 8 — Approval gate, split-Act execution, và dependency-aware execution**
9. **Phase 9 — Custom MCP Tool System contract**
10. **Phase 10 — MCP server + Docker Engine API runtime**
11. **Phase 11 — End-to-end ReAct apply/status/destroy/drift + hardening**

### Current implementation sync

Code/test/CLI behavior hien da duoc sync den **Phase 9+10 runtime boundary**: approval/preflight/typed `ApprovedAction`, DockerMcpGateway deploy, runtime observation, va post-deploy verification da co.

Da co that:
- Static Gateway truoc ReAct
- structured ReAct trace va internal tool loop
- OpenAI provider path cung stub provider deterministic
- prompt-to-spec planning tu `ValidatedQuery` sang `InfrastructureSpec`
- compose preview artifact
- detailed dependency-aware dry-run va policy/readiness observations
- SQLite state store (`state/infra-state.sqlite`) voi pending preview/current verified runtime shape/history, va Zod-validated JSON payloads
- `plan --apply` preflight + y/n approval + write `docker-compose.yaml` sau approval + create `ApprovedAction`
- `doctor --docker` read-only Docker Desktop setup check
- status read model tren saved state memory

Chua co that:
- Phase 9+10 DockerMcpGateway deploy/observe/verify via vendored Supernova MCP server
- Phase 11 drift/destroy/healing end-to-end remains future hardening

Trang thai canonical hien tai nam trong README va `docs/roadmap-11-phases-checklist.md`; cac historical phase notes da duoc xoa khoi workflow final.
Các năng lực nâng cao không chờ tới sau Phase 11 mới thiết kế. Chúng được kéo vào roadmap sớm dưới dạng boundary/contract, rồi harden dần:

- self-repair loop bắt đầu từ Phase 5 khi validation fail
- tool result memory bắt đầu từ Phase 7
- detailed dependency-aware dry-run bắt đầu từ Phase 6 như preview chính trước mọi runtime mutation
- split-Act pipeline bắt đầu từ Phase 8: propose action -> build typed tool call -> preflight validate -> approve -> execute -> observe
- MetaVerifier + ToolVerifier tách rõ từ Phase 8: logic/spec verification trước, runtime/tool verification sau
- VerificationReport bắt đầu từ Phase 8 để Planner nhận feedback chuẩn form cho repair/retry/ask-user
- adaptive verification tool selection bắt đầu từ Phase 9/10, chỉ trong tool surface read-only đã được allow
- Run Agent + Verifier Agent bắt đầu từ Phase 8/10 với verifier chỉ có read-only tools
- custom MCP contract bắt đầu từ Phase 9, không đợi xong Phase 11
- dual-environment, reconciliation, và verifier-heavy workflows được mở rộng sau khi runtime path đã ổn

---

## Phase 1 — CLI Scaffold Và ReAct Trace Baseline

### Mục tiêu

Làm CLI scaffold chạy ổn định và giữ dấu vết ReAct cơ bản trong output.

### Kết quả mong đợi

- `npm run build`, `npm run typecheck`, `npm run lint`, `npm test` pass
- CLI có `plan` và `status`
- dry-run không ghi state và không deploy Docker
- `--save-state` chỉ lưu desired state
- output có các phần tương ứng ReAct sơ khai: summary, observations, plan steps

### Trọng tâm implementation

- ổn định TypeScript build/typecheck
- làm output CLI rõ nghĩa
- tách `Desired state saved` và `Last applied`
- giữ ReAct trace dù agent còn đơn giản

### Non-goals

- chưa LLM provider thật
- chưa MCP server
- chưa Docker Engine API
- chưa deploy runtime thật

---

## Phase 2 — Domain Validation Làm ReAct Observation Tool

### Mục tiêu

Biến validator thành lớp quan sát deterministic đầu tiên của ReAct. Agent/LLM có thể đề xuất sai, nhưng validation sẽ trả observation rõ để Agent sửa hoặc dừng.

### Kết quả mong đợi

- schema cho `InfrastructureService`, `InfrastructureSpec`, `ExecutionPlan`, `AgentRunResult`, `StateSnapshot`
- validator helpers trả lỗi rõ
- compose renderer validate spec trước khi render
- execution engine validate agent result trước khi dry-run/save-state
- state store validate snapshot trước save/load
- validation failure có thể trở thành observation trong ReAct loop sau này

### ReAct mapping

```text
Reason:
  User wants nginx + 2 backend + postgres.

Act:
  propose_infra_spec

Observe:
  validate_infra_spec result

If invalid:
  Reason about validation errors and repair or ask user.
```

### Vì sao quan trọng

Phase này làm ReAct an toàn hơn. ReAct không còn là LLM tự do sinh object rồi đi tiếp; mỗi output phải đi qua observation kiểm chứng.

Validator ở Phase 2 không phải planner. Nó chỉ biến output không đáng tin từ LLM/Agent thành observation có cấu trúc:

```text
valid: true/false
issues: [...]
warnings: [...]
suggestedNextObservation: optional context for Agent
```

Quyền quyết định tiếp theo vẫn thuộc ReAct Agent:

- nếu valid: Agent có thể đi bước preview/plan tiếp theo
- nếu invalid: Agent có thể sửa draft, gọi tool lại, hỏi user, hoặc dừng
- nếu policy warning: Agent phải đưa vào preview/approval flow

---

## Phase 3 — Static Gateway Và ReAct Agent Tool Interface

### Mục tiêu

Dựng cổng static trước ReAct và nâng `ReActAgent` từ một method scaffold thành orchestrator có step, tool, observation rõ ràng.

### Kết quả mong đợi

- có pre-ReAct Static Gateway
- có type cho `IntentClassification`
- có type cho `DraftQuery`
- có type cho `ValidatedQuery`
- có type cho `ReActStep`
- có type cho `AgentTool`
- `ReActAgent.run()` nhận `ValidatedQuery`, không nhận raw prompt trực tiếp
- agent loop có thể chạy nhiều bước
- validator được bọc thành internal tool
- compose renderer được bọc thành internal tool
- state read/write được bọc thành internal tool
- chưa cần Docker/MCP thật nhưng interface phải mở đường cho MCP tools

### Tool nội bộ đề xuất

- `propose_draft_spec`
- `validate_infra_spec`
- `build_execution_plan`
- `render_compose_preview`
- `save_desired_state`
- `load_state`

### Definition of done

Trước khi vào Agent:

```text
raw query -> auxiliary intent check -> structured LLM parser -> code static validator -> ValidatedQuery
```

Static validation chỉ được trả kết quả lọc đầu vào hoặc câu hỏi clarification:

```text
valid: true/false
riskFlags: [...]
clarificationRequired: true/false
clarificationQuestion: optional
```

Nó không được đụng Docker Engine API, MCP, Compose CLI, runtime state, hoặc dùng LLM như ReAct planner/reasoner.

Nếu code static validator fail:

```text
return CLI error -> stop
```

Không gọi `ReActAgent.run()`, không gọi MCP, không gọi Docker.

Agent có thể biểu diễn luồng:

```text
Reason -> Act(tool) -> Observe(result) -> Reason -> Act(next tool)
```

Không chỉ là:

```text
run() -> buildSeedPlan()
```

Agent Tool interface phải giữ được boundary:

```text
Tool returns observation.
Agent decides next action.
```

Validator/renderer/state tools không được tự điều phối toàn bộ workflow. Chúng là tool được Agent gọi, không phải Agent thứ hai trá hình.

---

## Phase 4 — Auxiliary Router + Structured LLM Parser Và Provider Output

### Mục tiêu

Tích hợp ít nhất một provider thật và tách rõ hai đường dùng LLM:

- auxiliary LLM cho Static Gateway: intent router + draft parser
- ReAct LLM cho Agent Core: reasoning/planning có tool observations

### Kết quả mong đợi

- tích hợp Gemini hoặc OpenAI
- provider-specific code nằm trong `src/llm/`
- có model/config riêng cho auxiliary router/parser, ưu tiên model nhỏ/rẻ như GPT-4o-mini hoặc Gemini Flash
- intent router trả output có schema hẹp: infra/out-of-scope/unsafe + intent type
- structured parser trả JSON nháp có schema hẹp, dùng Structured Output hoặc Function Calling
- structured parser để `null` cho thông tin thiếu và không tự validate logic
- code validator mới quyết định port/replica/image/name/security có hợp lệ không
- ReAct LLM response có structured format
- ReAct LLM output được parse thành draft intent/spec/action
- lỗi parse/validation của auxiliary LLM không gọi ReAct nếu query bị reject/clarification
- lỗi parse/validation trong ReAct loop quay lại thành observation

### ReAct mapping

```text
Pre-ReAct:
  Auxiliary router/parser classify/extract only.
  Code validator emits ValidatedQuery or rejection.

Reason:
  ReAct LLM reads ValidatedQuery and observations.

Act:
  produce_structured_draft

Observe:
  parse_result / validation_result
```

### Guardrail

Auxiliary LLM không được lập plan, không được tự repair spec, không được gọi Docker/MCP, và không được thay ReAct suy luận topology.

ReAct LLM không được gọi Docker trực tiếp, không được gọi MCP side-effecting tool khi chưa validate/approve, không được tự tạo raw Docker Engine payload.

---

## Phase 5 — Prompt-To-Spec ReAct Loop

### Mục tiêu

Thay seed plan hard-code bằng vòng ReAct tạo, validate, sửa, hoặc hỏi lại cho tới khi có `InfrastructureSpec` hợp lệ.

`InfrastructureSpec` từ phase này phải được xem là **source of truth cho desired state**. Execution plan được sinh ra từ spec đã validate. Docker Compose YAML chỉ là artifact render từ spec để preview, preflight, và hỗ trợ execution; không được trở thành canonical model thay cho spec.

### Kết quả mong đợi

Prompt:

```text
Tạo một web application gồm nginx reverse proxy, 2 instance node.js backend, và 1 postgresql database
```

được chuyển thành:

- nginx reverse proxy
- backend replicas = 2
- postgres database
- network chung
- postgres volume
- dependency postgres -> backend -> nginx

### ReAct loop mong muốn

```text
Reason: infer topology
Act: propose draft spec
Observe: validation failed or passed
Reason: repair missing fields or ask clarification
Act: validate again
Observe: validation passed
Act: build execution plan
Observe: plan validation passed
```

### Definition of done

Các prompt khác nhau tạo spec/plan khác nhau, không còn chỉ trả template cố định.

---

## Phase 6 — Compose Preview, Detailed Dry-Run, Và Policy Observation

### Mục tiêu

Đưa Docker Compose preview, detailed dry-run, dependency-aware execution schedule, và policy warning vào ReAct observation trước khi có side effect.

Compose ở phase này phải được giữ đúng vai trò là **artifact**:
- render từ `InfrastructureSpec` đã validate
- dùng để preview tác động dự kiến
- dùng làm input hỗ trợ cho preflight validation hoặc execution adapter ở phase sau nếu cần
- không thay thế desired-state model trong state store, drift detection, hay approval logic

### Kết quả mong đợi

- render compose YAML deterministic từ validated spec
- dry-run hiển thị cực kỳ chi tiết tài nguyên sẽ tạo, thứ tự sẽ tạo, và điều kiện chờ/sẵn sàng dự kiến
- dry-run có detailed report theo dependency order, không chạy runtime execution và không mutate Docker/host
- build dependency-aware execution schedule: network/volume foundation -> database/data layer -> application/backend layer -> routing/proxy layer
- preview readiness/wait gates: database healthy trước backend, backend ready/running trước reverse proxy
- preview có warnings cơ bản: exposed ports, default secrets, volumes
- policy result trở thành observation cho Agent
- chưa runtime side effect trong dry-run
- preview phải chỉ rõ artifact sẽ được ghi ở đâu sau approval, ví dụ `docker-compose.yaml`
- phase này không được ghi artifact execution cuối cùng thay cho approval gate; final write thuộc Phase 8/11 sau khi user trả lời `y`

### Handoff sang Phase 7/8

Phase 6 bàn giao cho Phase 7/8:

- validated `InfrastructureSpec`
- deterministic compose preview text
- dependency-aware execution schedule
- detailed dry-run resource report
- impact/policy summary
- artifact target path dự kiến, ví dụ `docker-compose.yaml`

Các dữ liệu này là observation để Phase 8 hỏi approval. Chúng không được tự tạo runtime side effect.

### ReAct mapping

```text
Reason:
  Spec đã validate; cần lập thứ tự thực thi dự kiến theo dependency trước khi preview.

Act:
  build_dependency_aware_execution_schedule

Observe:
  execution schedule: foundation -> data -> application -> proxy, kèm wait/readiness gates

Reason:
  Execution schedule hợp lệ; có thể render compose artifact preview từ source-of-truth spec.

Act:
  render_compose_preview

Observe:
  compose YAML preview

Reason:
  Compose preview đã có; cần mô tả chi tiết những gì apply thật sẽ tạo mà không thực thi.

Act:
  build_detailed_dry_run_preview

Observe:
  resources to create, dependency order, service replicas, ports, networks, volumes, env, artifact target path, and actions not performed

Reason:
  Dry-run report đã đủ dữ liệu; cần đánh giá policy warning trước khi user review.

Act:
  evaluate_policy

Observe:
  warnings / blockers
```

---

## Phase 7 — State Manager Như ReAct Memory

### Mục tiêu

Biến State Manager thành memory/observation store cho ReAct trên SQLite, không phải file JSON/YAML làm source of truth.

State ở phase này phải lưu được cả:
- **desired state canonical** dưới dạng `InfrastructureSpec`
- metadata/tham chiếu tới compose artifact đã render
- observation về actual runtime state
- các mốc verification và failure signals phục vụ status, drift, retry, và debugging

### Kết quả mong đợi

- state có schema version trong SQLite
- lưu source prompt, desired spec, compose artifact, timestamps
- phân biệt desired/actual
- lưu ReAct trace hoặc operation history ở mức tối thiểu
- state load/save validate schema bằng Zod trước/sau khi serialize JSON payload vào SQLite
- có trạng thái pending/preview riêng nếu cần lưu trước approval
- desired/actual state chính thức chỉ được lưu sau khi runtime observation và verification trả kết quả
- actual state phải đến từ Docker observation qua MCP/read-only verifier, không được suy ra từ compose artifact

### ReAct mapping

```text
Act:
  load_state

Observe:
  previous desired/actual state

Act:
  save_state

Observe:
  state saved
```

### Vì sao quan trọng

ReAct cần memory để làm status, drift, retry, và future reconciliation.

---

## Phase 8 — Approval Gate, Split-Act Execution, Và Dependency-Aware Execution

### Mục tiêu

Thiết lập action gate và tách pha Act thành pipeline kiểm soát được, để ReAct không thể tạo runtime side effect nếu chưa qua preview/preflight/approval.

Phase này cũng bắt đầu thiết kế healing như một action được kiểm soát, không phải một hành vi tự động nguy hiểm. Khi hệ thống phát hiện lỗi hoặc drift, Agent chỉ được tạo `RepairProposal`/`RepairAction` có typed schema, evidence, preview, và approval requirement. Việc restart/recreate/pull/remove thật vẫn thuộc Phase 10/11 sau MCP/runtime adapter.

Phase này cũng phải làm rõ error-handling pipeline:
- validation failure, policy block, approval rejection, preflight failure, runtime failure, và verification mismatch đều phải được phân loại rõ
- mỗi failure mode phải quay lại ReAct như observation có cấu trúc thay vì chỉ là log text
- verifier/observer chỉ dùng read-only capability và không được có quyền mutate runtime
- verification phải tách hai tầng: MetaVerifier kiểm tra spec/plan không chạm hạ tầng; ToolVerifier kiểm tra runtime/preflight bằng read-only tools sau khi meta verification pass

### Kết quả mong đợi

- execution plan có action types rõ
- actions có dependency order
- classify action: read-only, state-write, runtime-create, runtime-destroy
- tách Act thành các bước: action proposal, typed action builder, preflight validator, approval gate, executor, observer
- preflight validator kiểm tra schema, policy, current state, dependency-aware dry-run evidence, và approval requirement trước khi executor được chạy
- approval marker cho action side-effecting
- approval gate phải được gọi như ReAct approval tool; CLI chỉ là UI transport để user trả lời y/n cho mọi runtime-create/runtime-destroy/state-mutating apply
- nếu user trả lời `n`, action dừng an toàn và rejection trở thành ReAct observation
- nếu user trả lời `y`, hệ thống mới được ghi `docker-compose.yaml` execution artifact và tạo approved runtime action
- executor chỉ nhận typed approved action, không nhận raw LLM text hoặc raw Docker payload
- verifier read-only path được thiết kế từ phase này, chưa cần đủ thông minh ngay
- `VerificationReport` có schema rõ cho kết quả verify: status, scope, issues, evidence, errorReason, revisionHint, confidence
- MetaVerifier trả `VerificationReport` cho lỗi logic/spec/plan như thiếu service, dependency mâu thuẫn, replica/port vô lý, hoặc plan không khớp request
- ToolVerifier trả `VerificationReport` cho lỗi thực tế như container không chạy, port bị chiếm, network/volume thiếu, healthcheck/log báo lỗi
- verifier không bắt buộc chạy mọi check cố định; nó có thể chọn check phù hợp theo failure type và evidence đã có
- `destroy all` có preview và confirmation riêng
- define `DriftReport` hoặc failure report cho lỗi runtime dự kiến: missing container, stopped container, missing image, missing network/volume, port conflict, healthcheck/log failure, desired-vs-actual mismatch, và `uncertain` khi evidence chưa đủ
- define `RepairProposal`/`RepairAction` cho healing: restart stopped container, recreate missing container, pull missing image, recreate missing network, recreate missing volume với cảnh báo data-loss, hoặc ask-user khi intervention không an toàn
- repair/healing proposal phải đi qua preview và explicit y/n approval như apply/destroy, không auto-mutate runtime
- khi LLM suy luận sai, MetaVerifier/VerificationReport phải biến lỗi thành structured observation để Planner repair, retry, ask user, hoặc stop an toàn

### ReAct mapping

```text
Reason:
  Applying will create containers and expose port 80.

Act:
  build_typed_action

Observe:
  preflight validation result

Act:
  meta_verify_spec_plan

Observe:
  VerificationReport(status, issues, errorReason, revisionHint)

Act:
  request_approval

Observe:
  approved / rejected

Act:
  write_compose_artifact

Observe:
  artifact_written / artifact_write_rejected

Act:
  execute_approved_action_through_mcp

Observe:
  runtime result / runtime failure

Act:
  verify_runtime_state

Observe:
  VerificationReport(desired-vs-actual evidence)

Reason:
  Actual runtime is missing/stopped/mismatched; build a repair proposal rather than mutating immediately.

Act:
  build_repair_proposal

Observe:
  DriftReport + RepairProposal with evidence, risk, and preview

Act:
  request_repair_approval

Observe:
  repair approved / rejected
```

### Guardrail

Không action runtime nào đi từ LLM/prompt sang MCP nếu chưa có validation, preview, preflight, user y/n approval, và approval marker. Verifier/validator không được có quyền mutate runtime.

### Handoff sang Phase 9/10

Phase 8 không tự gọi Docker Engine API. Phase này chỉ tạo `ApprovedAction` có schema rõ, gồm:

- validated desired spec
- compose artifact text và target path
- approval result
- policy/preflight evidence
- dependency order
- requested runtime operation
- optional repair proposal when action is intended to heal drift/failure

`ApprovedAction` là input duy nhất mà Phase 9 MCP contract và Phase 10 Docker runtime được phép nhận.

---

## Phase 9 — Custom MCP Tool System Contract

### Mục tiêu

Thiết kế custom hoặc wrapper MCP server như tool boundary bắt buộc cho ReAct Agent. MCP tools là các Act mà Agent có thể gọi sau khi đã validate/preflight/approve.

Final apply path phải đi qua custom MCP contract của project rồi tới Docker Runtime Adapter gọi Docker Engine API. Generic Docker tool surfaces không được expose trực tiếp cho LLM; Agent chỉ nhìn thấy custom tool contract hẹp của project.

### Kết quả mong đợi

- có MCP tool contracts rõ input/output schema
- tool surface hẹp, capability-scoped
- có allowed-tools policy theo workflow phase
- có custom wrapper nếu cần dùng lại Docker MCP server có sẵn
- không expose shell hoặc raw Docker command
- Execution Engine hoặc Agent Tool Runner gọi MCP client
- có contract tests

### MCP tools đề xuất

- `validate_infra_spec`
- `render_compose_preview`
- `write_compose_artifact`
- `preview_runtime_changes`
- `apply_approved_plan`
- `collect_verification_evidence`
- `inspect_runtime_state`
- `inspect_container_logs_readonly`
- `verify_runtime_state`
- `compare_desired_vs_actual`
- `build_repair_proposal`
- `preview_repair_actions`
- `apply_approved_repair`
- `destroy_all_approved`

MetaVerifier mặc định không phải runtime MCP tool. Nó là internal verifier/policy service hoặc read-only planning tool, dùng để kiểm tra `ValidatedQuery`, `InfrastructureSpec`, và `ExecutionPlan` trước khi action runtime được approve. ToolVerifier mới dùng MCP/read-only runtime tools để thu evidence thực tế.

### ReAct mapping

```text
Act:
  call_mcp_tool(apply_approved_plan)

Observe:
  structured tool result
```

### Anti-goals

- không `run_docker_command(command: string)`
- không `execute_shell`
- không expose trực tiếp 37+ Docker tools generic cho Agent nếu chưa qua wrapper
- không raw Docker Engine payload từ LLM

### Contract lock with Phase 8/10

MCP tools that can mutate runtime must require:

- `approvalId` or equivalent approval marker from Phase 8
- approved `InfrastructureSpec`
- compose artifact reference/path produced after approval
- preflight/policy evidence
- typed operation name such as `apply_approved_plan`, `apply_approved_repair`, or `destroy_all_approved`
- for healing, a `RepairProposal` with drift/failure evidence, risk classification, selected repair action, and approval marker

MCP tools must not accept arbitrary Docker Engine API payloads generated by the LLM. The MCP
server owns translation from typed approved action to Docker Engine API calls.
Read-only verifier/healing evidence tools must not share mutation permissions with apply/repair tools.

---

## Phase 9+10 — Docker MCP Client + Pluggable Agents + Runtime Deploy (MERGED)

> Phase 9 (Custom MCP Tool System Contract) và Phase 10 (MCP Server + Docker Engine API Runtime) được merged thành một phase duy nhất.
> Sử dụng official packages/docker-mcp-server-supernova spawn làm subprocess, giao tiếp qua stdin/stdout JSON-RPC.

### Mục tiêu

Triển khai Docker runtime thật thông qua MCP, đồng thời tách Planner và Verifier thành pluggable components.

### Components mới

- DockerMcpGateway (`src/execution/docker-mcp-gateway.ts`): subprocess MCP transport + route table + typed tool methods + allowMutations safety gate
- PlannerAgent (src/agent/agent-interfaces.ts + standard-planner-agent.ts): Interface + default impl dùng Docker read-only + LLM → InfrastructureSpec
- VerifierAgent (src/agent/agent-interfaces.ts + standard-verifier-agent.ts): Interface + default impl observe Docker → compare vs desired → VerificationReport

### Safety 3 lớp

1. DockerMcpGateway: allowMutations flag mặc định false, mutate methods throw DockerMutationSafetyError
2. Agent code: PlannerAgent + VerifierAgent chỉ gọi read-only methods
3. deployWithDocker(): setAllowMutations(true) trong try/finally + yêu cầu ApprovedAction từ Phase 8

### Mutation path

ReActAgent → ExecutionEngine → DockerMcpGateway → packages/docker-mcp-server-supernova → Docker Engine API

### Kết quả đạt được

- CLI plan --apply --deploy chạy full flow: plan → approve → MCP deploy → verify
- CLI observe command: spawn MCP server, list containers/networks/volumes/images
- CLI đã có getErrorMessage() helper cho error handling
- 7 file mới (docker-mcp-gateway, agent-interfaces, standard-planner-agent, standard-verifier-agent, 3 test files)
- 6 file sửa (types, schemas, react-agent, execution-engine, phase8-approval, cli)
- 86 tests pass (16 files), typecheck + build pass

---

## Phase 11 — End-To-End ReAct Apply/Status/Destroy/Drift + Hardening

### Mục tiêu

Hoàn thiện mini project theo yêu cầu chức năng và làm nền cho ReAct nâng cao.

Ở phase này hệ thống phải thể hiện rõ:
- `InfrastructureSpec` vẫn là source of truth cho desired state
- compose chỉ còn là artifact phục vụ preview/execution support
- actual runtime state và verification result mới quyết định status/drift, không phải giả định từ artifact đã render
- error handling, verification, và observation đủ mạnh để debug và giải thích vì sao hệ thống thành công, lệch trạng thái, hay thất bại

### Kết quả mong đợi

- `plan` chạy ReAct planning loop
- dry-run preview rõ
- approval trước apply
- CLI bắt buộc hỏi user y/n trước apply; không có default yes
- nếu user chọn `n`, không ghi execution artifact, không gọi MCP apply, không mutate Docker
- nếu user chọn `y`, hệ thống ghi `docker-compose.yaml` trước khi gọi MCP apply
- MetaVerifier pass trước mọi runtime apply
- apply gọi MCP server
- MCP server gọi Docker Engine API
- observation quay lại ReAct
- preflight validation path hoạt động trước apply thật và không mutate runtime
- verifier read-only path kiểm tra post-condition sau apply
- ToolVerifier chọn read-only tools phù hợp theo evidence cần kiểm tra thay vì chạy một checklist runtime cứng nhắc
- VerificationReport quay lại Planner để repair/retry/ask-user/stop một cách có cấu trúc
- state lưu desired/actual sau khi observe + verify actual Docker runtime
- `show status` hiển thị desired vs actual
- `destroy all` có confirmation và gọi MCP tool
- drift detector so sánh desired với actual runtime
- healing/reconciliation demo xử lý lỗi do user cố ý tạo: stop container, remove container, remove image, remove network/volume, hoặc container unhealthy/mismatch
- mỗi healing flow phải detect drift, classify lỗi, tạo `RepairProposal`, preview tác động, hỏi approval, apply approved repair qua MCP/Docker adapter, observe lại, verify healed state, rồi update state
- nếu lỗi không đủ evidence hoặc repair có nguy cơ mất dữ liệu, hệ thống phải trả `uncertain`/ask-user thay vì tự sửa
- policy/verification/logging đủ tốt để debug

### End-to-end use case

```text
prompt
  -> ReAct plan
  -> validate
  -> preview
  -> preflight validation
  -> ask user y/n approval
  -> if approved, write docker-compose.yaml artifact
  -> MCP apply
  -> Docker runtime adapter
  -> Docker Engine API
  -> observe runtime
  -> verify post-condition
  -> save desired/actual state
  -> status
  -> drift detection
  -> user manually injects fault: stop/remove container, remove image, remove network/volume, or alter runtime state
  -> observe drift/failure
  -> classify failure and collect evidence
  -> propose repair plan
  -> preview repair impact
  -> ask user y/n approval
  -> apply approved repair through MCP/Docker adapter
  -> observe healed runtime
  -> verify desired-vs-actual again
  -> save healed actual state
```

If approval is rejected, the end-to-end flow stops before writing `docker-compose.yaml`, before MCP
apply, and before any Docker Engine API mutation.

For healing demos, if repair approval is rejected, the system must keep the drift/failure report in state history and clearly explain that no repair mutation was performed.

### Mở rộng sau baseline

Các ý dưới đây đã được thiết kế sớm trong Phase 6-10. Sau Phase 11, project chỉ mở rộng độ sâu, độ tự động, và độ tin cậy của chúng:

- **Self-repair ReAct**: validation/runtime error quay lại Agent để sửa spec/plan.
- **MetaVerifier + ToolVerifier**: một tầng kiểm tra logic/spec/plan không chạm runtime, một tầng kiểm tra actual state bằng read-only tools.
- **VerificationReport-first feedback**: Planner không đọc log thô; mọi verifier trả report có status, issues, evidence, errorReason, revisionHint.
- **Adaptive verification**: Verifier chọn tool kiểm tra theo loại lỗi, ví dụ compose syntax khi artifact lỗi, Docker logs khi container không lên, desired-vs-actual compare khi drift.
- **Verifier Agent**: agent riêng chỉ có read-only tools để kiểm tra kết quả, bắt đầu từ contract Phase 8/10.
- **Run Agent + Verify Agent**: một agent apply, một agent verify, không chia sẻ quyền mutate runtime.
- **Dual-environment execution**: apply thử ở môi trường riêng có policy rõ, verify, rồi mới apply thật.
- **Long-horizon planning**: chia task lớn thành nhiều sub-plan.
- **ReAct memory**: lưu trace/observations để retry và explain.
- **Reconciliation loop**: drift detected -> propose repair -> preview -> approve -> apply.
- **Controlled fault-injection demo**: người demo cố ý phá runtime bằng tay; hệ thống chứng minh khả năng observe, reason, propose repair, xin approval, heal, và verify mà không cấp quyền sửa bừa cho LLM.

---

## Nguyên Tắc Xuyên Suốt

1. **ReAct là trung tâm**
   - Mọi module quan trọng nên xuất hiện như tool, observation, memory, hoặc action gate trong ReAct loop.

2. **Validator là observation bắt buộc**
   - LLM output phải qua validation trước khi thành plan/action.

3. **Verifier tách hai tầng**
   - MetaVerifier kiểm tra completeness/consistency của spec/plan trước runtime.
   - ToolVerifier kiểm tra actual state bằng read-only tools sau preflight/apply.
   - Cả hai đều trả `VerificationReport` thay vì log thô.

4. **Adaptive verification có giới hạn**
   - Verifier được chọn tool theo loại lỗi/evidence cần kiểm tra.
   - Tool selection phải nằm trong allowed read-only tool surface và không được mutate runtime.

5. **MCP là Tool System bắt buộc**
   - Agent/CLI không gọi Docker trực tiếp.

6. **Docker Engine API là runtime thật**
   - Docker Engine API nằm sau MCP server và adapter.

7. **LLM không phải nguồn sự thật**
   - LLM đề xuất; schema, policy, approval, observation mới quyết định có đi tiếp không.

8. **Dry-run và approval trước runtime mutation**
   - Create/start/stop/remove/destroy đều phải qua preview, preflight validation, và approval.

9. **Split Act thành pipeline kiểm soát được**
   - LLM chỉ đề xuất action.
   - Action Builder tạo typed tool call.
   - Preflight Validator kiểm chứng schema/policy/state/dry-run evidence trước khi chạy.
   - Executor mới được gọi MCP/runtime.
   - Observer/Verifier đọc lại kết quả.

10. **Desired và actual tách biệt**
   - Desired phải được neo vào `InfrastructureSpec` đã validate như source of truth.
   - Docker Compose chỉ là artifact render từ spec, không phải canonical desired model.
   - Actual đến từ Docker observation và verification read-back.

11. **Không expose raw runtime**
   - Không shell tự do.
   - Không raw Docker command.
   - Không raw Docker Engine payload do LLM tự tạo.

12. **Healing có kiểm soát, không tự chữa mù**
   - Hệ thống phải chấp nhận rằng runtime và LLM đều có thể lỗi.
   - Lỗi phải được biến thành `DriftReport`, `VerificationReport`, hoặc `RepairProposal` có evidence.
   - Repair chỉ được mutate runtime sau preview, policy/preflight check, approval marker, MCP contract, runtime adapter, observation read-back, và verification.
   - Khi evidence không đủ, trạng thái đúng là `uncertain` hoặc ask-user, không phải tự tin sai.
