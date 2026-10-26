# Podcast Asset — Foundations And Confirmed Scripts

Status: P1 foundations, P2 script editing/confirmation/assisted writing, P3a read-only audio preflight and P3b default-disabled audio execution/download are implemented. P3b is validated with mocked provider calls and local media processing, not a new paid production run. Full editorial gates, audio acceptance and publication remain pending.

## Scope And Evidence

A single episode remains an `Asset(asset_type="podcast")`. Projects may group episodes, but an episode does not require a Project or a new channel entity.

P0 user feedback confirms the existing short technical, six-minute technical, and Cherry speech MP3 samples can be uploaded, saved, approved, and stored as drafts in the target Official Account. Playback and pause work in both mobile preview and the desktop backend. This is user-reported validation, not automated publication or independent verification. Detailed article insertion steps, seeking, complete playback, real-episode quality, and public publication remain follow-up checks.

P1 adds persistence and configuration contracts only. It does not perform TTS, generate audition samples, upload to WeChat, publish articles, run migrations against the live database, or expand the earlier P0 spending authorization.

## Persistence

| Table | Responsibility | Implemented database constraints |
| --- | --- | --- |
| `asset_podcast_configs` | Current per-Asset configuration and optimistic revision | One row per Asset; positive revision; target duration 1–30 minutes; cascading Asset deletion |
| `asset_podcast_script_approvals` | Immutable confirmation records containing spoken text, hashes, source/config snapshots, confirming user and time | Asset ownership inherited through parent; positive config revision; composite identity for render references |
| `asset_audio_renders` | Audio jobs, idempotency, frozen configuration, explicit budget, state, lease fencing token, final object/hash/duration | Same-Asset approval FK; unique `(asset_id, idempotency_key)`; at most one active or outcome-unknown render per Asset; nonnegative budget; allowed states |
| `asset_audio_segments` | Ordered, hash-addressed synthesis units | Unique position within render; allowed states; nonnegative position; cascading render deletion |
| `asset_audio_attempts` | Per-segment provider-call observations | Segment/render composite FK; unique positive attempt number; allowed states; nullable nonnegative reported characters and cost |

Ownership is checked against the parent Asset at the API boundary; child rows do not duplicate a potentially inconsistent `user_id`. Explicit script confirmation creates immutable approvals. P3b's separately authorized creation endpoint persists frozen renders/segments, and its Worker records attempts with lease fencing. Generic Asset edits and Agent tools cannot create or authorize these jobs.

Provider-call observations use `NULL` for unknown charges and usage, never an invented zero. Monetary fields use fixed-precision decimals. `outcome_unknown` participates in the active-render uniqueness constraint so a timeout cannot silently authorize a second concurrent billable job.

Render states: `queued`, `generating`, `assembling`, `ready`, `failed`, `canceled`, `outcome_unknown`, `abandoned`. Segment states remain `queued`, `generating`, `ready`, `failed`, `canceled`, `outcome_unknown`; manual abandonment does not rewrite them. Attempt states: `started`, `succeeded`, `failed`, `outcome_unknown`. Asset lifecycle status remains independent of these execution states.

## Available HTTP Contracts

All requests use the existing browser → Gateway → PKG authentication path.

| Operation | Contract |
| --- | --- |
| Create an episode draft | `POST /assets` with `asset_type="podcast"`; atomically creates default configuration |
| List/filter episodes | Existing `GET /assets?asset_type=podcast` and Asset analytics filters |
| Read voice directory | `GET /assets/podcast/voices`; authentication required; no provider request |
| Read configuration | `GET /assets/{asset_id}/podcast`; no writes or lazy initialization |
| Replace configuration | `PUT /assets/{asset_id}/podcast`; full configuration plus `base_revision` |

Configuration defaults: provider `qwen`, region `cn-beijing`, model `qwen3-tts-flash`, voice `Cherry`, target duration six minutes, optional timezone-aware information cutoff. Only this provider/region/model tuple is accepted initially. It is an audio configuration, not the Harness Chat model setting.

The voice catalog is a checked-in snapshot of the 48 non-realtime voices, with official source and check date. Names, genders and languages are displayed metadata; IDs such as `Eldric Sage`, `Ono Anna` and `Radio Gol` retain their spaces exactly. The server validates membership in its own catalog. Catalog availability does not certify credentials, regional authorization, quotas, pricing or voice licensing; these remain adapter/deployment checks before generation.

PUT locks the owned Asset and configuration, compares the revision, validates the voice, and commits a new revision. Stale writes return 409; unsupported voice IDs and malformed/extra configuration fields return 422. Foreign/missing Assets return 404. Non-podcast Assets and archived configuration writes return 409. Missing configuration is an error, not a GET-side write. Omitted configuration fields in PUT take their declared defaults; callers should send the complete configuration read from GET.

State responses now report `script_approval_available=true` and `audio_generation_available=false`. Confirmation is not audio generation, acceptance, delivery or publication.

## P2 — Script Workflow

Open **Assets → Podcast card → 创建播客 · Create Podcast**, **Create an Asset → 播客 · Podcast**, or `/assets/podcast/new`. The creation guide transfers the working title, question/angle and selected materials without creating an episode or requesting a model. Existing Podcast Asset links redirect to `/assets/{id}/podcast`. A saved episode can use the existing explicit Project association dialog.

| Method and path | Behavior |
| --- | --- |
| `POST /assets/podcast` | Atomically create an episode, initial owned material references and selected configuration |
| `GET /assets/{id}/podcast/draft` | Read saved editor fields, actual spoken text, bounded material previews, server input hash, latest approval and approval issues |
| `PUT /assets/{id}/podcast/draft` | Save the complete draft and configuration only when `base_input_hash` matches authoritative saved inputs |
| `POST /assets/{id}/podcast/script-approvals` | Explicitly confirm the saved script using only `base_input_hash`; clients cannot submit approved text, hashes, author or snapshots |

Saving incomplete drafts is allowed. Approval requires a title, author angle, nonblank script and a timezone-aware information cutoff. Materials are optional for manually written or pasted scripts, including an existing blog post; such scripts can be saved, confirmed and preflighted without importing a Source/Note/Wiki. Empty source snapshots do not imply fact verification. If materials are selected, they must remain owned and available. There are at most 20 distinct materials total, 1,000 preview characters per material and 80,000 script characters. Inaccessible/deleted references remain visible as unavailable instead of silently disappearing. Material-grounded Agent candidate generation still requires available materials.

The spoken text is **title + body**, separated by a blank line, with deterministic newline/line-end normalization. Outline, author angle and source excerpts are not silently appended to speech. Markdown is not automatically converted: the editor clearly requests plain spoken text. Reading rules are versioned in the configuration snapshot; pronunciation substitutions are not yet supported.

Confirmation locks the owned Asset/configuration and shared-locks owned material rows in deterministic order. It computes SHA-256 hashes server-side over actual spoken text and canonical saved draft/material/configuration inputs. Source hashes cover full selected content, not only visible excerpts. Approval persists immutable spoken text, bounded source snapshots, configuration/revision and the current authenticated author. Duplicate confirmations of unchanged current inputs return the existing approval; they never create audio jobs.

Status is derived as `unconfirmed`, `current` or `stale`. Script, title, outline, angle, references, material content or configuration changes make older snapshots historical. Every configuration change increments its revision, including changes later reverted. Generic Podcast content updates are blocked in favor of the optimistic draft endpoint. Archived episodes are read-only. Approval does not advance the Asset's delivery state.

The editor preserves dirty content across failed saves/refetches, reports 409 conflicts explicitly and offers deliberate server reload/local recovery rather than silently overwriting edits. Recovery is browser-local and scoped to user/episode; unavailable or full storage is reported. Refresh/close and intercepted link navigation warn about unsaved changes; browser history navigation still relies on local recovery. Review recovered old-base text before explicitly saving against a newer server version.

### Optional Assisted Writing

After saving an angle, cutoff and at least one available material, users may explicitly consent to sending the saved inputs to the current Harness model. This may incur model fees independently of any TTS budget. The editor rechecks the server input hash, then uses the existing `knowledge-lab` preset through Gateway with a new ephemeral session. No new writable Agent tool or special preset is added. The prompt requests text-only JSON and no tool calls; it includes at most 20 bounded material excerpts, the saved outline and a current script of at most 12,000 characters. Longer existing scripts are rejected before calling the model, not silently truncated.

Candidates must bind the Asset and exact saved input hash, include 1–200 paragraphs, cite only selected available materials and contain at least one material association. Outline, body, warnings and total response size are bounded. The editor displays candidates separately and rechecks saved/local state before explicit application. Applying changes only the local outline/body/source mapping; save and immutable confirmation remain separate user actions. Malformed, stale, interrupted or failed runs leave the original script untouched. Cancellation stops reception and attempts a remote cancel; already incurred usage may remain billable and remote completion cannot be assumed.

This is material-grounded assisted writing, not the full confirmed Intent/Evidence/Claim workflow. Model text and source associations still require editorial verification. Audition remains deferred as requested. No TTS call, new paid test, WeChat upload or live business migration is performed by this workflow.

### Paragraph Sources

Paragraphs are split on blank lines after deterministic newline/line-end normalization. Optional `paragraph_sources` covers the complete current body in order, with a SHA-256 of each paragraph and distinct selected Source/Note/Wiki references. Empty references denote an unassociated opinion/transition, not verified facts. PKG validates positions, hashes and reference membership on create/save. The dedicated endpoint stores mappings in protected Asset metadata `podcast_script_v1`; generic metadata writes cannot inject or erase them. This bounded script annotation is not audio execution/configuration state and requires no additional migration.

Mappings participate in the authoritative input hash; approval material snapshots also record paragraph indexes. Episodes without mappings preserve the previous fingerprint format. Manual body/material changes clear old mappings in the editor to avoid silently carrying stale attribution. Users can associate paragraphs manually or apply candidate associations, then save and reconfirm.

## Editor Content Layout

Long editor content uses independently scrollable regions capped at the smaller of half the viewport and 24rem: paragraph sources, spoken-text preview, historical approval text, Agent candidate content, audio segmentation/warnings and task history. Short content keeps its natural height. Section headings and main confirmation/application controls stay outside the long-content region. Regions are named, keyboard-focusable and retain native page scroll chaining; desktop and narrow-screen layouts have browser coverage.

## Explicit Web Research And Material Adoption

The Podcast editor includes **联网搜索素材** alongside existing Source/Note/Wiki selection. Users enter a specific topic and explicitly click search; only that query is sent through the authenticated Gateway to the existing `POST /discovery/web-search/preview`, using existing Tavily credential resolution. Neither script text nor the complete authoring context is sent by this action. Search may consume provider quota; results do not automatically become Discovery items, Sources or Asset references. No automatic search occurs when opening/editing an episode or requesting a material-grounded writing candidate.

Candidates show title, safe original HTTP(S) URL/domain, search provider, provider-reported publication time (unknown remains unknown), and bounded summary. Unsafe/credential-bearing URLs are discarded, duplicate canonical URLs collapsed and URL path case preserved. Titles are limited to 500 characters and summaries to 10,000; only up to 20 returned candidates are considered, with eight requested by default. Publication times and snippets are unverified, not retrieval timestamps or fact-check results. Searches do not automatically enforce the episode's information cutoff; users must verify dates and original pages.

After explicit selection and confirmation, `POST /discovery/web-results/save` saves at most 20 bounded, user-submitted results as owned Sources in one transaction. This endpoint is not evidence of provider authenticity. Metadata records the search query, provider, reported date, `content_scope=search_summary`, `fact_check_status=unverified` and explicit-save retention. No page fetch, embedding/model/TTS request or recommendation write occurs. Existing exact canonical-URL Sources belonging to the user are reused without modifying their title/content/hash/metadata; new Sources have deterministic owner/URL IDs and conflict-safe insertion, so repeated/concurrent saves do not duplicate or overwrite those Sources. Other users' Sources are never returned or reused. No migration is needed.

Returned Source IDs are added only to the local editor, leaving the script unchanged and clearing stale paragraph associations. A separate **保存修改**/**创建并保存播客** persists the references using the existing input-hash conflict checks; candidate generation and immutable confirmation still require saved inputs. New unsaved episodes can research/adopt without automatically creating an Asset. All material types share the existing 20-reference cap, and archived editors disable search/adoption. Import freezes editor writes while in flight. Search failures remain errors rather than empty successful results; failed/ambiguous imports preserve the selection for explicit idempotent retry, never automatic replay. Sources already stored remain in the library even if the user leaves before saving the episode. Directly pasted scripts may continue without any material association. Harness receives no new write tools.

## P3a — Audio Preflight, Not Execution

The dedicated editor includes **音频生成准备 · 预算预检**. `POST /assets/{id}/podcast/audio-preflight` computes a read-only report through the authenticated Gateway. It never writes a render, starts a Worker, decrypts a credential, calls a provider, generates an audition or authorizes spending. `audio_generation_available` reports deployment/policy/ffmpeg availability, defaults to `false` and does not indicate per-job consent or Worker health. No additional migration beyond the foundations migration is required.

The request contains `base_input_hash`, a positive CNY `budget_limit` of at most 2 (up to four decimal places), an optional explicit personal `credential_id`, and an optional positive `price_per_10k_characters` (up to six decimal places). Extra fields, including secret keys and execution/authorization flags, are rejected. The 2-CNY planning limit does not renew or extend the earlier P0 spending authorization.

Only a current, internally consistent approval of the saved script can be preflighted. Stale input hashes, unconfirmed/stale scripts, unavailable materials and archived episodes return 409; foreign Assets and credentials return 404. Credential checks require the current user's enabled Qwen entry with encrypted secret present and compatible configured region. No credential is selected automatically and deployment credentials are never used as a fallback. This is only a local metadata check, not proof of remote authentication, regional entitlement, balance or quota. Credential secrets/configuration are not included in the report.

The segmentation policy `utf16-300-double-reserve-v3` preserves the exact approved title/body text. It plans at most 300 UTF-16 units per segment, preferring whitespace or sentence boundaries in the latter half of a full window without dropping characters. Every segment includes position, exact text, SHA-256, Unicode character count and a billing reservation of twice the UTF-16 length. The adapter enforces the same UTF-16 limit before any provider request, including supplementary characters. This reduces individual request size after earlier 600-unit jobs encountered connection failures; it does not establish their root cause or guarantee a duration. The version participates in preflight fingerprints and Worker validation, so old reports cannot authorize the new plan and old queued policies fail safely. The reservation includes punctuation, whitespace and title; it is not measured usage or duration.

The user must enter their account's applicable CNY-per-10,000-character price; responses label it `pricing_source=user_entered`, `pricing_verified=false`. Missing prices remain `null`, with unknown costs and an indeterminate budget verdict, never fabricated zero. Estimates reserve two billing characters per UTF-16 unit, round each segment upward to 0.0001 CNY and sum those estimates. The verified public pricing floor is a separate execution safeguard, not automatic account-price selection. Estimates cover one synthesis attempt only and do not represent actual billing, retries, storage/traffic fees, or a guaranteed spending cap.

Missing/disabled/incompatible credentials, unknown price, prices below the safety floor, over-budget estimates and existing active/outcome-unknown renders produce explicit issues and `checks_passed=false`. An unknown provider outcome cannot be treated as a free retry. A passed report does not itself create a task. Execution independently revalidates inputs, authorization, price, credential, current budget and active jobs rather than treating this report as an authorization token.

The UI requests preflight only after an explicit click and keeps script save/confirmation separate. Changed local text, configuration, approval, selected credential, price or budget invalidates the displayed report; state changes during the request reject the response. Failed rechecks clear the previous report rather than displaying an old success. Credential-load errors remain errors, not an empty successful check.

## P3b — Explicit Audio Tasks And Private Downloads

The editor's **本期音频任务** section lists the most recent 20 tasks, segment progress, attempt counts, provider-reported characters/costs and measured duration. Missing usage/cost remains unknown, never zero. `GET/POST /assets/{id}/podcast/audio-renders`, `POST .../{render_id}/cancel` and `GET .../{render_id}/download` use existing browser authentication through the Gateway. Downloads are private, no-store MP3 responses with ownership and SHA-256 checks; no provider URLs or secrets enter the response. Generation/download does not change adoption, delivery or publication state.

Creation requires a matching execution fingerprint, explicit text-to-provider consent and billing-uncertainty acknowledgment, an owned enabled credential, and an idempotency key. The server freezes exact segments and the authorization snapshot transactionally. Reusing the same key/body returns the original task, including after completion; changing the body returns 409. The browser saves an Asset/user-scoped authorization receipt before POST, never auto-resubmits it, and explicitly recovers the identical request after ambiguous network failures or refresh. Failed local receipt persistence prevents submission. No script text or credential secret is stored in this receipt.

Worker execution claims tasks with leases/fencing and revalidates current approval, saved inputs, policy, credential ownership/enabled status and encrypted-key fingerprint before every paid request. Attempts are durably recorded before POST. The native Qwen adapter uses the fixed Beijing endpoint without automatic retries; downloads are restricted to the known result OSS host, upgraded to HTTPS and sent without API Authorization. Responses and audio sizes are bounded. Raw provider WAV and narrowly repaired canonical PCM WAV are retained privately; local ffmpeg concatenates PCM, encodes 128-kbps MP3 and verifies decoding. Duration comes from PCM frames, not an estimate.

Queued tasks can be canceled without calls. Stopping an in-flight task, a lost lease, timeout or ambiguous provider/audio-download result preserves `outcome_unknown` and blocks new tasks for the episode. Cancellation cannot erase this safety lock; an explicit, audited manual-abandonment operation is available as described below, without claiming provider billing was reconciled. Known local failures do not retry automatically; a separately authorized new task may repeat already billed successful segments. Episodes with any audio ledger must be archived rather than deleted. No migration is added in the original P3b execution implementation.

### Pricing And Operator Setup

Official native API and pricing were checked on **2026-10-16**:
- https://help.aliyun.com/zh/model-studio/qwen-tts-api
- https://help.aliyun.com/zh/model-studio/model-pricing

The public Beijing `qwen3-tts-flash` rate is 0.8 CNY per 10,000 billing characters, with each Chinese character counting as two. `podcast_policy.py` enforces a minimum entered rate of 0.8 and disables new execution once this dated policy is more than seven days old (or future-dated). Review official pricing and billing rules before refreshing the policy/version; this is not remote account entitlement or balance verification. The 2-CNY per-task estimate limit does not guarantee the actual bill or renew P0 authorization.

Execution defaults to **off**. When ready, the operator must explicitly configure `PODCAST_AUDIO_ENABLED=true` for both the API and audio Worker, have ffmpeg available, and restart those processes. Use `pkg podcast-worker` from the PKG virtual environment to run only the authorized audio queue without starting collection/scheduled automation. The general `pkg worker` also includes audio when enabled. Configure the selected personal Qwen credential in Settings → API Keys, save/confirm the episode, run preflight, then separately authorize that task. A queued task does not prove a Worker is running. Do not auto-enable this setting, start Workers or reuse the earlier test authorization during development. This implementation has not made a new real paid synthesis call.

### Completed Episode Playback

The owned task history offers an on-demand player only for `ready` renders. “加载试听” uses the existing authenticated Gateway download endpoint, carrying the current cookie or legacy bearer header, then assigns a browser-local blob URL to native audio controls. No token is placed in a URL, no private storage URL is exposed, no media is fetched on page entry and no new TTS task is created. Loading downloads the complete MP3 before playback; seeking subsequently operates on that local blob and does not require server Range support. Native controls provide play, pause, seeking and volume; starting one episode pauses the other episode players.

Closing the player or leaving the page stops playback and releases the blob URL; pending loads can be canceled and are aborted on unmount. Failed, empty or undecodable media show an explicit error and allow manual read-only reload or the existing MP3 download. A 401 follows the shared expired-session flow. Archived assets may still play existing ready renders without mutating them. Playback is not voice-catalog audition, acceptance, publication or a new spending authorization. No API schema change or migration is required.

### Failure Diagnostics

Migration `a37c9e6f402b` adds nullable `failure_details` JSONB to renders and attempts; apply it before restarting the API and Workers. Errors record a bounded, application-generated stage/code, stage elapsed milliseconds, observed HTTP status and format-validated provider request ID. POST request/response, audio URL validation/download/PCM validation, usage validation, local storage, assembly and persistence failures are distinguished. No raw exception message, response body, script, credential or signed URL is persisted or logged.

The owned audio-history contract adds `failure_details` and ordered `attempts` containing segment position, status, start/end timestamps, known provider request ID/characters and diagnostics. A known synthesis request ID and usage survive subsequent download or validation failure. Unknown usage and actual cost remain null rather than zero. UI diagnostics explicitly distinguish elapsed processing/wait time from audio playback duration. Historical tasks lacking details show that the cause cannot be reconstructed, rather than claiming a timeout. Worker warnings include only sanitized structured fields. Unknown-outcome locks, authorization, billing limits, segmentation and no-automatic-retry rules are unchanged; no previous task is rerun or repaired by this migration.

Diagnostics additionally expose optional `exception_type`, `provider_error_code` and `retry_after_seconds` in the existing JSONB, history API and Gateway/UI contract, without a new schema migration. Exception types are selected from fixed known classes rather than arbitrary runtime names; only known provider error codes are retained. HTTP 429 and known throttling codes are classified as `rate_limited`, meaning a frequency or quota restriction, not necessarily a requests-per-minute violation. Network disconnects remain `network_error` with a transport subtype such as `ReadError` or `RemoteProtocolError`; they are not reclassified based on elapsed time. Valid numeric or HTTP-date Retry-After headers are normalized to seconds, bounded to seven days, and displayed as advice at response time rather than a live countdown. Unknown/malformed codes and headers, raw messages and response bodies are not stored. The advice never triggers retry, changes unknown billing, or releases the unknown-outcome lock. Existing historical failures cannot gain details retrospectively.

### Explicit Abandonment And Fresh Generation

Migration `b8e26d409a71` follows diagnostics revision `a37c9e6f402b`, adding a nullable abandonment audit and the terminal render state `abandoned`. Owned `POST /assets/{asset_id}/podcast/audio-renders/{render_id}/abandon` requires both billing-uncertainty and full-regeneration acknowledgments; archived episodes, queued/generating/assembling/ready tasks and stopped-unknown tasks with an unfinished valid lease are rejected. Owner/config/render locks serialize abandonment with new task creation, and repeating it returns the original audit. Downgrade refuses to discard retained abandonment audit.

The operation records actor/time/previous status and acknowledgments, preserving all existing segments, attempts, files, request IDs and unknown charges. It does not retry, enqueue synthesis, refund, resolve billing, delete partial audio or renew the old budget. The UI offers two explicit confirmations, refreshes history and invalidates existing local preflight/consents. Only a separately rechecked and authorized new task can synthesize the entire episode again; it does not resume remaining segments, and cumulative charges can exceed the old task's budget. Replaying an old creation idempotency key still returns the abandoned task. No live business task is abandoned by tests or migrations.

Preflight fingerprints include the retained abandoned-task count, so an old browser tab cannot reuse a pre-abandonment report for a new authorization. Stopping an active request does not immediately enable abandonment: its Worker must first acknowledge exit, or the execution lease must expire. Worker acknowledgment records completion without claiming the provider outcome or billing became known.

## Existing Asset Compatibility

- Existing Asset types, Project links, source/note/wiki ownership checks and default style behavior stay unchanged.
- Podcast configuration and task state live outside generic metadata. Podcast metadata keys `podcast` and `podcast_*` are rejected by generic create/update instead of being interpreted as authoritative state.
- Generic Podcast writes cannot set delivery states (`ready_to_export`, `exported`, `published`) or an export format while audio acceptance/delivery is unavailable.
- The shared readiness check blocks Podcast delivery without accepted audio; existing text exporters and WeChat publishing cannot count a script as an audio delivery.
- Podcast title, script and reference editing uses the dedicated revision-checked endpoint; generic creation applies the same draft bounds. Asset type conversion is not added. Forking creates a fresh episode/default configuration and does not copy approvals or audio jobs.
- UI provides a dedicated Podcast editor, prominent Assets/creation-guide entries and list/diagnostic filtering. Podcast remains excluded from the generic text-generation pipeline; its guide entry opens the dedicated script workflow instead.
- Harness `pkg-client` has session-scoped read helpers only; no new writable Agent tool or automatic result creation is introduced.

## Migration And Validation

Revision `d0e1f2a3b4c5` follows the actual previous head `c9d0e1f2a3b4`. Migration adds five tables and does not rewrite existing Assets. Online downgrade refuses to discard nonempty Podcast tables. Offline SQL cannot inspect data; do not use offline downgrade output as a safe data-deletion workflow.

Service/API tests cover configuration defaults, exact voice IDs, authentication, ownership, archive/revision protection, metadata/snapshot injection, input bounds and existing Asset behavior. Preflight tests additionally cover exact segmentation, emoji/reservation counts, upward monetary rounding, unknown costs, explicit owned credentials, stale/tampered snapshots and active/unknown job blockers with no writes. An explicitly opted-in PostgreSQL test uses a random schema to exercise actual migrations, concurrent saves/confirmations, immutable snapshots, Source/Note/Wiki drift, foreign credentials, read-only preflight, audio constraints and downgrade safety without upgrading the business schema. P3b tests add concurrent idempotency, queued cancellation, policy expiry/feature gating, pre-call input drift, simulated successful synthesis/storage/download, one-call timeout safety and lease fencing/recovery. Adapter tests mock native requests, constrain download hosts/redirects/credentials and validate WAV repair plus real local ffmpeg encoding/decoding. Browser tests cover creation/discoverability, 48 voices, candidate application, source mappings, recovery, read-only archives, budget preflight/staleness, separate audio consents, lost-response receipt recovery, storage-failure prevention and authenticated MP3 downloads.

```bash
cd personal_knowledge_graph
.venv/bin/python -m pytest tests/test_podcasts.py tests/test_assets_service.py tests/test_api_assets.py
.venv/bin/python -m pytest tests/test_podcast_audio.py
.venv/bin/python -m pytest tests/test_podcast_tts.py tests/test_podcast_renders_api.py tests/test_podcast_policy.py
.venv/bin/python -m pytest tests/test_web_materials.py tests/test_api_discovery.py tests/test_discovery.py
SEAGULL_PODCAST_POSTGRES_TEST=1 .venv/bin/python -m pytest tests/test_podcasts_postgres.py
```

Gateway contracts, read-only Harness helpers and the UI SDK have corresponding tests. Real audio and WeChat APIs are not called by these suites.

## Next Stages

1. **P2 follow-up — stronger editorial gates:** integrate confirmed Intent/Evidence/Claim decisions with the dedicated Podcast workflow. Material-grounded candidates, paragraph attribution, manual editing and immutable confirmation are already implemented; associations alone must not imply fact validation.
2. **P3b follow-up — controlled acceptance:** after fresh user budget authorization and operator setup, run a bounded real-provider smoke test; add audio acceptance and provider-side billing reconciliation. Audited manual abandonment with separate fresh generation, default-disabled task execution, private downloads and mocked end-to-end tests are implemented.
3. **P4 — delivery:** immutable script/render/cover export snapshot, MP3 publishing package and manual publication/adoption feedback. Do not infer adoption or publication from a download, accepted audio or a saved WeChat draft.

The planned “choose a voice, then click to audition that voice” interaction remains deferred to the appropriate UI stage: no automatic playback on selection and no paid synthesis merely to audition.
