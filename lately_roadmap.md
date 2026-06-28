# Lately Roadmap — Các bước tiếp theo (sau Phase 9+10)

> Ngày lập: 2026-06-23. File mới, độc lập với `docs/roadmap-11-phases.md`.
> Đối chiếu trực tiếp với code/test hiện tại, không dựa trên ghi chú cũ.

## 0. Trạng thái hiện tại (đã xác thực bằng build/test)

Đã xác minh thực tế trên máy:

- `npm run typecheck`: pass
- `npm run lint`: 0 lỗi
- `npx vitest run --pool=threads`: 95 passed / 2 skipped
- `npm test` mặc định (forks pool) báo `spawn EPERM` trong sandbox — hạn chế môi trường, không phải lỗi code. Nên đặt pool mặc định `threads` để CI ổn định.

Đã thật, hoạt động:

- Phase 1–8: CLI `plan`/`status`/`observe`/`doctor`, ReAct linear pipeline, Static Gateway, OpenAI + Gemini provider (first-class qua `.env`), compose rendering, dry-run dependency-aware, SQLite, Phase 8 approval boundary.
- Phase 9+10 (gộp): `DockerMcpClient` (JSON-RPC → `@modelcontextprotocol/server-docker`), `deployWithDocker()` (networks → pull → create/start theo dependency order), `StandardVerifierAgent.verify()/compareState()`, `--deploy` (kèm `--apply`), verifier tự chạy sau deploy.

Còn hở (gắn trực tiếp với các giai đoạn dưới):

- Sau deploy+verify, CLI **không lưu** desired/actual vào SQLite → `show status` vẫn báo "Actual runtime state: not observed".
- `deployWithDocker()` không rollback/partial-cleanup (chỉ reset gate trong `finally`).
- Không có integration test với Docker daemon thật (toàn mock/subprocess stub).
- Không có lệnh `destroy`, không có drift detector, không có healing.
- ReAct `run()` là **pipeline tuyến tính**, không có while-loop → hiện không có risk lặp vô hạn, nhưng khi thêm self-repair loop (Giai đoạn C) sẽ cần guard (Giai đoạn D).
---

## 1. Audit lời mentor — lỗi chưa fix / đề xuất chưa sửa

Nguồn: `docs/mentor-feedback.md` (17/06/2026). Đối chiếu với code/test hôm nay.

| # | Lời mentor | Trạng thái | Bằng chứng / ghi chú |
|---|---|---|---|
| 1 | Mới dừng ở dry-run, chưa deploy Docker thật | **Phần lớn đã làm** | `deployWithDocker()` đã có và chạy qua `--deploy`. Còn hở: chưa có integration test daemon thật, chưa có rollback. → Giai đoạn A + B |
| 2 | Bug dependency khi thiếu middle-tier (nginx + mysql không có backend) | **ĐÃ FIX** | `validateTopologyGraph()` trong `src/domain/schemas.ts:239`, test `tests/topology-validation.test.ts` phủ proxy+db không backend (reject), backend không proxy (warning). |
| 3 | State management sơ khai, status chỉ đọc file, không so với Docker | **Còn mở** | SQLite đã là storage chính, nhưng actual state vẫn `not-observed`, `show status` chưa có desired-vs-actual thật, chưa có drift. → Giai đoạn A + B |
| 4 | Không hỗ trợ follow-up / interactive correction giữa chừng | **Chưa làm** | Ghi note "chờ sau Phase 11". → đưa vào Giai đoạn C (interactive refinement) hoặc mục mở rộng riêng. |
| 5 | Compose chưa production-ready: POSTGRES_PASSWORD hardcode, không healthcheck, node:20-alpine không CMD (exit ngay), policy detect nhưng chưa auto-resolve | **CHƯA FIX** | `src/agent/react-agent.ts:1437` `POSTGRES_PASSWORD: 'app'`, tương tự MySQL/MariaDB/Mongo/Keycloak (:1449-1507). `render-compose()` (`src/compose/render-compose.ts`) chỉ render image/replicas/ports/environment/depends_on/volumes/networks — **không** healthcheck, không command/CMD, không restart. → mục riêng Giai đoạn A (compose hardening). |

### Quyết định hội nghị đã được tuân thủ

- MCP là đường duy nhất (không dockerode) — đúng kiến trúc hiện tại.
- Verifier là tool trong tool system trước, chưa tách dual-agent (overkill cho mini project) — đúng hiện tại (`StandardVerifierAgent`).

### Tóm tắt còn nợ mentor

- **Mentor #5 (compose hardening)**: fix deterministic, không cần LLM — nên làm sớm, ghép vào Giai đoạn A.
- **Mentor #3 (state + drift)**: Giai đoạn A (lưu state) + Giai đoạn B (drift).
- **Mentor #1 (rollback + integration test)**: Giai đoạn A (rollback) + Giai đoạn B (E2E thật).
- **Mentor #4 (follow-up)**: Giai đoạn C hoặc mở rộng riêng.
---

## 2. Giai đoạn A — Lưu desired/actual sau observe+verify + đóng cửa sổ runtime ↔ SQLite + compose hardening

Mục tiêu: sau khi deploy + verify thành công, desired (neo `InfrastructureSpec`) và actual (Docker observation) phải persist vào SQLite, và `show status` hiển thị desired-vs-actual. Đồng thời fix nợ mentor #5 (compose) và #1-rollback.

### Sprint A.1 — Hàm lưu verified runtime state

- [ ] Thêm hàm `saveVerifiedRuntimeState(input)` trong `src/state/sqlite-state-store.ts`: nhận `desired: InfrastructureSpec` + `actual: RuntimeActualState` + `verification: VerificationReport`, gói thành `VerifiedRuntimeSnapshot`, ghi vào `current` của singleton state, đẩy 1 `StateOperationRecord` (type `verified-runtime`) vào `history`.
- [ ] `desired` phải là `InfrastructureSpec` đã `validateInfrastructureSpec` (neo source-of-truth, không phải compose artifact).
- [ ] `actual` phải đến từ Docker observation thật (qua `DockerMcpClient` read-only tools).
- [ ] Test: lưu → load → `current.desired` == spec, `current.actual.source` != 'not-observed', `current.verification.status` phản ánh report.

### Sprint A.2 — Tích hợp vào CLI deploy flow

- [ ] Trong `src/cli.ts` nhánh `--deploy`, sau `agent.verifyAfterApply(result.plan)` thành công, gọi `saveVerifiedRuntimeState` với desired = `result.plan.spec`, actual = observation thu được, verification = report.
- [ ] Nếu verify fail/status=uncertain: **không** lưu `current` verified; ghi history record `verification-failed` kèm evidence, không mutate thêm.
- [ ] Quan sát actual phải dùng read-only MCP tools (`listContainers`/`inspectContainer`/`listImages`/`listNetworks`/`listVolumes`) — tách thành hàm `observeActualState(mcpClient, spec)` trả `RuntimeActualState`.
- [ ] Test (mock MCP): deploy → verify pass → load state thấy `current` có desired + actual thật.

### Sprint A.3 — `show status` desired vs actual

- [ ] `StatusService.showStatus()` (`src/status/status-service.ts`) khi có `current` verified: in `desired.services` vs `actual.containers` dạng bảng so sánh (name, image, status, ports). Khi `actual.source === 'not-observed'` giữ thông điệp hiện tại.
- [ ] Thêm tùy chọn `--json` cho lệnh `status` (output máy đọc được) — nợ mentor #3/Issue 6.
- [ ] Test: có verified state → status in desired vs actual; không có → in "not observed".

### Sprint A.4 — Compose hardening (nợ mentor #5, deterministic)

- [ ] `render-compose()`: thêm `restart: unless-stopped` mặc định (trừ khi user tắt); thêm `healthcheck` cho DB (postgres/mysql/mariadb/mongo: `pg_isready`/`mysqladmin ping`/`mongosh ping`); thêm `command` giữ sống cho service `node` thuần (vd `tail -f /dev/null`) để không exit ngay.
- [ ] Mật khẩu DB: không hardcode `'app'`. Sinh giá trị mặc định ổn định-per-project (hash từ projectName) hoặc yêu cầu env, và đánh dấu `(generated)` trong preview. Giữ secret-redaction hiện có trong dry-run.
- [ ] Policy/dry-run: cảnh báo khi DB thiếu password mạnh, khi service không có healthcheck, khi image không có CMD rõ — nhưng vẫn render (auto-resolve deterministic, không cần LLM).
- [ ] Test: render DB spec → có `healthcheck` + `restart`; render node spec → có `command`/`restart`; không còn `POSTGRES_PASSWORD: 'app'` literal cố định.

### Sprint A.5 — Deploy rollback + error handling cơ bản

- [ ] `deployWithDocker()` (`src/execution/execution-engine.ts:211`): theo dõi resources đã tạo; khi lỗi giữa chừng, rollback theo thứ tự ngược (stop+remove containers đã start → remove networks đã tạo). Giữ `setAllowMutations(false)` trong `finally`.
- [ ] Phân loại lỗi rõ: `DeploymentError` mang `phase` ∈ {`network`|`pull`|`create`|`start`} để CLI in gợi ý sửa.
- [ ] Test (mock MCP): inject lỗi ở bước create container → assert containers/networks trước đó bị cleanup, gate bị khóa lại.

### Tiêu chí hoàn thành Giai đoạn A

- Deploy + verify thành công → SQLite có `current` với desired (`InfrastructureSpec`) + actual (observation thật).
- `show status` in desired vs actual; `--json` hoạt động.
- Compose có healthcheck/restart/command cho node; không còn password hardcode cố định.
- Deploy lỗi → rollback cleanup + error phân loại; không leak resources.
---

## 3. Giai đoạn B — Drift / Destroy / Healing end-to-end + error handling

Mục tiêu: chứng minh chuỗi `apply → status → drift → destroy → healing` end-to-end, đúng locked runtime path của roadmap gốc, kèm controlled fault-injection.

### Sprint B.1 — Drift detector + lệnh `status --drift`

- [ ] `DriftDetector` (mới, `src/status/drift-detector.ts`): nhận `desired: InfrastructureSpec` + `actual: RuntimeActualState`, trả `DriftReport` có schema cố định (status, drifts[], evidence[], repairHints[]). So sánh: service thiếu/thừa, image mismatch, port mismatch, running status, env (chọn lọc), network/volume thiếu.
- [ ] Khi evidence không đủ → status `uncertain` + `ask-user`, không tự tin sai.
- [ ] Lệnh `status --drift`: load desired từ SQLite, observe actual qua MCP read-only, chạy DriftDetector, in report.
- [ ] Test (mock): desired có 2 container, actual thiếu 1 → drift `missing-container`; image khác → `image-mismatch`; status `uncertain` khi inspect không trả đủ.

### Sprint B.2 — Lệnh `destroy`

- [ ] Lệnh `destroy`: load desired spec → preview tài nguyên sẽ remove (containers/networks/volumes theo projectName) → hỏi y/n → qua Approval gate → gọi MCP mutation tools theo thứ tự an toàn (stop → remove containers → remove networks → remove volumes) → observe → verify rỗng → lưu actual (source `destroyed`) vào SQLite.
- [ ] `DockerMcpClient` cần methods removeContainer/removeNetwork/removeVolume sau gate `setAllowMutations`.
- [ ] Reject nếu không có desired đã lưu (không destroy mù).
- [ ] Test (mock): destroy → assert MCP remove được gọi đúng thứ tự, actual sau = empty, approval rejected → không mutate.

### Sprint B.3 — Healing end-to-end (fault injection → repair)

- [ ] Fault injection demo: hỗ trợ stop/remove container, remove image, remove network/volume bằng tay → system observe drift.
- [ ] Flow: `detect drift → classify (DriftReport) → repair preview (RepairProposal có typed actions) → y/n approval → MCP repair → observe → verify healed → save healed actual`.
- [ ] `RepairProposal` phải là typed action (recreate container / restart / pull image / recreate network), qua preflight + approval, không LLM tự sửa runtime.
- [ ] Approval rejected → ghi drift/failure evidence, không mutate.
- [ ] Test (mock): container thiếu → repair recreate → verify pass → actual cập nhật; approval rejected → không có MCP mutation call.

### Sprint B.4 — Error handling phân biệt 4 loại failure

- [ ] Định nghĩa error taxonomy: `ValidationError` (schema/spec), `PreflightError` (policy/state/dry-run), `RuntimeError` (Docker/MCP), `VerificationError` (desired≠actual). Mỗi loại có code + evidence + gợi ý sửa khác nhau.
- [ ] CLI in lỗi theo loại, ReAct observation mang loại lỗi để self-repair (Giai đoạn C) phân nhánh.
- [ ] Test: mỗi loại lỗi → assert message/code đúng, flow dừng đúng điểm.

### Sprint B.5 — Integration test với Docker daemon thật (nợ mentor #1)

- [ ] Test gated bởi env (vd `RUN_DOCKER_INTEGRATION=1` + Docker available): deploy nginx đơn giản → observe → verify → destroy. Skip mặc định.
- [ ] Không phụ thuộc mock cho path này; chứng minh MCP → Docker Engine thật chạy.

### Tiêu chí hoàn thành Giai đoạn B

- `status --drift` báo drift có evidence; `uncertain` khi thiếu.
- `destroy` có approval + cleanup + verify rỗng.
- Healing flow khóa đúng: detect → classify → preview → y/n → repair → observe → verify → save.
- Lỗi 4 loại phân biệt rõ; có ít nhất 1 integration test daemon thật.
---

## 4. Giai đoạn C — Self-repair loop, tool result memory, long-horizon planning

Mục tiêu: nâng ReAct từ pipeline tuyến tính thành loop có khả năng tự sửa + nhớ, nhưng có guard (Giai đoạn D) để không quay luẩn quẩn.

### Sprint C.1 — Self-repair loop (validation / MetaVerifier fail)

- [ ] Khi `ValidationError`/`VerificationError` (MetaVerifier) → feed `VerificationReport` (status, issues, revisionHint) về Planner để sửa spec/plan rồi retry. Giới hạn N lần (guard Giai đoạn D).
- [ ] Khi `RuntimeError`/ToolVerifier fail → đề xuất rollback/retry proposal, không tự mutate.
- [ ] Giữ nguyên rule: LLM chỉ đề xuất; schema/policy/approval/observation mới quyết định đi tiếp.

### Sprint C.2 — Tool result memory

- [ ] Lưu trace/observations/tool-results làm memory artifact trong SQLite (hoặc bảng riêng) để retry và explain.
- [ ] `VerificationReport` chuẩn hóa thành memory/replay artifact.
- [ ] Lệnh `explain`/`replay` in lại ReAct trace để debug (nợ roadmap nâng cấp).

### Sprint C.3 — Long-horizon planning

- [ ] Chia task lớn thành nhiều sub-plan; mỗi sub-plan qua validate → preview → approve → apply → observe → verify riêng.
- [ ] Adaptive verification: verifier chọn read-only tool theo loại lỗi (compose syntax / Docker logs / desired-vs-actual), trong allowed tool surface, không mutate.

### Sprint C.4 — Interactive correction (nợ mentor #4)

- [ ] Cho user can thiệp giữa chừng: "đổi port 80 → 8080", "bỏ nginx" → cập nhật desired spec → re-preview → re-approve. Đây là refinement loop có approval, không mutate ngầm.

### Tiêu chí hoàn thành Giai đoạn C

- Self-repair retry có giới hạn, feed `VerificationReport` đúng.
- Tool results được lưu làm memory; có `explain`/`replay`.
- Long-horizon chia sub-plan; adaptive verification trong tool surface cho phép.
- Interactive correction hoạt động qua approval gate.
---

## 5. Giai đoạn D — Chống agent lặp vô hạn / quagmire guard

Mục tiêu: khi Giai đoạn C thêm loop, đảm bảo agent luôn kết thúc và thoát, không quay luẩn quẩn.

### Vấn đề hiện tại

- `run()` hiện là pipeline tuyến tính (không while-loop) → chưa có risk. Nhưng self-repair (C.1) sẽ introduced loop. Cần guard ngay khi thêm loop.

### Thiết kế guard

- [ ] **Max-iteration budget**: mỗi loop ReAct có `MAX_REACT_ITERATIONS` (vd 8). Vượt → dừng, trả `AgentRunResult.status = 'blocked'` kèm lý do "iteration budget exhausted" + trace đầy đủ.
- [ ] **Progress/Novelty guard**: theo dõi hash của (reasoning + tool + input) mỗi bước; nếu lặp lại cùng kết quả ≥ 2 lần liên tiếp → coi là quagmire → dừng hoặc buộc `ask_user`.
- [ ] **No-op detection**: nếu 2 vòng liên tiếp không thay đổi spec/plan/observation → break, trả `clarification`/`blocked`.
- [ ] **Per-tool call cap**: mỗi tool chỉ được gọi tối đa K lần trong 1 run (tránh `validate` ↔ `repair` ping-pong vô tận).
- [ ] **Convergence check**: loop chỉ tiếp tục khi có "delta" rõ (spec thay đổi, issue giảm, observation mới); không delta → exit.
- [ ] **Structured exit**: mọi path exit phải trả status xác định (`completed`/`clarification`/`blocked`) + trace + observations; không bao giờ treo.

### Test guard

- [ ] Inject mock provider trả reasoning giống nhau mỗi vòng → assert dừng trong budget, status `blocked`.
- [ ] Inject validate fail → repair fail → validate fail lặp → assert per-tool cap dừng được ping-pong.
- [ ] Assert mọi exit path có trace + status.

### Tiêu chí hoàn thành Giai đoạn D

- Agent luôn kết thúc trong budget; không path treo.
- Loop lặp vô nghĩa bị phát hiện và dừng/ask_user.
- Mọi exit có status + trace.

---

## 6. Thứ tự ưu tiên & phụ thuộc

1. **A.4 (compose hardening)** — làm được ngay, deterministic, đóng nợ mentor #5, không phụ thuộc gì.
2. **A.1–A.3 (lưu state + status desired/actual)** — nền bắt buộc cho B.
3. **A.5 (rollback + error taxonomy cơ bản)** — nền cho B.4.
4. **B.1 (drift)** — cần A đã xong (có actual thật để so).
5. **B.2 (destroy)** — độc lập tương đối, cần MCP remove methods.
6. **B.3 (healing)** — cần B.1 (drift) + A.5 (rollback pattern).
7. **B.4 (error taxonomy)** — nền cho C.1 (self-repair phân nhánh theo loại lỗi).
8. **B.5 (integration test daemon thật)** — sau khi A+B ổn với mock.
9. **D (guard)** — **đồng thời với C.1**; không được thêm self-repair loop trước khi có guard.
10. **C.1–C.4 (self-repair, memory, long-horizon, interactive)** — sau D guard đã có.

---

## 7. Nguyên tắc xuyên suốt (giữ từ roadmap gốc)

- ReAct là xương sống; mọi module là tool/observation/memory/action-gate trong loop.
- Validator là observation bắt buộc; LLM output phải qua validation trước khi thành plan/action.
- Verifier tách 2 tầng: MetaVerifier (logic/spec/plan, không chạm runtime) + ToolVerifier (actual state, read-only).
- MCP là Tool System bắt buộc; Docker Engine API sau MCP; LLM/CLI không kết nối trực tiếp Docker.
- Dry-run + approval trước mọi runtime mutation; compose chỉ là artifact, `InfrastructureSpec` là desired source-of-truth.
- Healing có kiểm soát: detect → classify → preview → y/n → repair → observe → verify → save; không tự sửa mù.
- Khi evidence thiếu → `uncertain`/`ask-user`, không tự tin sai.
- Thêm loop thì phải thêm guard (Giai đoạn D) — không để agent quay luẩn quẩn không thoát được.
