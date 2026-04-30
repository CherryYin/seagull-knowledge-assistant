# AI 应用调用大模型工程编码规范

> 适用场景：基于 OpenAI / Anthropic / DeepSeek / Gemini / 本地模型等 LLM 的 AI 应用  
> 定位：后端底座之上的 AI 应用层规范  
> 核心目标：把不稳定的模型能力放进稳定、可控、可观测、可评测的工程系统里

---

## 1. 执行等级

### P0 必须遵守

- API Key、模型凭证、用户隐私数据不得泄露。
- 所有 LLM 调用必须设置 timeout。
- 用户输入、工具返回、RAG 内容不得默认可信。
- 结构化输出必须做 schema 校验。
- 重要业务动作不得只依赖模型自然语言判断。
- 大模型失败时必须有明确错误处理或降级策略。
- 日志不得记录敏感 prompt、Token、密钥、PII。
- Prompt、模型版本、参数变更必须可追踪。

### P1 强烈推荐

- 封装统一 LLM Client 和 provider adapter。
- Prompt 模板版本化管理。
- 对关键 AI 能力建立 eval 测试集。
- 记录 token 用量、延迟、失败率、模型名称。
- 对工具调用做权限、参数和结果校验。
- 对 RAG 检索结果记录来源和引用。
- 对流式输出、取消请求、重试、并发做统一管理。

### P2 按需采用

- 多模型路由。
- 成本预算控制。
- Prompt A/B 测试。
- 人工反馈闭环。
- 自动化回归评测。
- Guardrails。
- Agent 多步骤执行框架。

---

## 2. 基本原则

AI 应用不是把用户输入拼进 prompt 后发给模型。

必须坚持：

- 模型输出不可默认可信。
- 用户输入和检索上下文不可默认可信。
- 工具权限由代码判断，不由模型决定。
- Prompt 和模型参数必须版本化。
- 关键业务结果必须可校验。
- 成本、延迟、失败率必须可观测。
- 失败、超时、限流、模型波动必须有处理策略。

---

## 3. 推荐项目结构

```text
src/
  app/
    ai/
      clients/
        base.py
        router.py
        adapters/
          openai_adapter.py
          anthropic_adapter.py
          deepseek_adapter.py
      prompts/
        summarize_note.v1.md
        classify_intent.v1.md
      schemas/
        messages.py
        outputs.py
        tools.py
      services/
        chat_service.py
        rag_service.py
        summarization_service.py
      tools/
        search_tool.py
        document_tool.py
      evals/
        datasets/
        scorers/
        runners/
      safety/
        moderation.py
        prompt_injection.py
        output_filter.py
      memory/
        conversation_memory.py
        summarizer.py
      observability/
        tracing.py
        token_usage.py
```

---

## 4. LLM Client 与 Provider Adapter

业务代码不应直接依赖供应商 SDK。

推荐内部统一模型：

```python
class LLMMessage(BaseModel):
    role: Literal["system", "user", "assistant", "tool"]
    content: str | list[ContentPart]
    name: str | None = None


class LLMResponse(BaseModel):
    content: str
    model: str
    provider: str
    input_tokens: int | None = None
    output_tokens: int | None = None
    finish_reason: str | None = None
```

Provider adapter 负责吸收差异：

- OpenAI function calling 与 Anthropic tool use 的 schema 差异。
- streaming chunk 的事件格式差异。
- 多模态输入的 content part 差异。
- token usage 字段差异。
- 错误码、限流、内容安全拒绝的差异。
- JSON mode / structured output 支持差异。

统一 client 负责：

- timeout。
- 重试。
- 错误转换。
- token 统计。
- trace 记录。
- 成本估算。
- prompt version 记录。

不建议强行抹平所有差异。与业务无关的供应商细节应在 adapter 层吸收；与能力选择有关的差异，例如是否支持 vision、tool streaming、strict schema，可以通过 capability 暴露给 model router。

---

## 5. 模型配置与路由

模型名称、温度、最大 token、timeout 不应硬编码在业务逻辑中。

```python
class LLMSettings(BaseSettings):
    default_model: str = "gpt-4o-mini"
    default_temperature: float = 0.2
    default_timeout_seconds: float = 30
    max_output_tokens: int = 2048
```

不同任务应有独立配置：

- 意图识别：低 temperature、低成本模型。
- 摘要：低 temperature、中等上下文模型。
- 创意生成：较高 temperature。
- 高风险决策辅助：低 temperature、强模型、强校验。
- 代码生成：强模型、结构化约束、eval 回归。

多模型路由可以依据：

- 任务类型。
- 成本预算。
- 延迟要求。
- 上下文长度。
- 安全等级。
- 供应商可用性。
- 是否需要 tool use 或多模态。

---

## 6. Prompt 管理

Prompt 是工程资产，应版本化、可 review、可回滚。

推荐：

```text
prompts/
  summarize_note.v1.md
  summarize_note.v2.md
  classify_intent.v1.md
```

Prompt 推荐结构：

```md
# Role

你是一个...

# Task

请完成...

# Input

{{ user_input }}

# Constraints

- 不要编造不存在的信息
- 如果信息不足，返回 unknown
- 输出必须符合 JSON schema

# Output Format

...
```

要求：

- Prompt 修改必须经过 code review。
- 关键 prompt 变更必须跑 eval。
- Prompt 中不得硬编码密钥、内部地址或敏感信息。
- 用户输入与 system 指令必须分离。
- RAG 文档内容必须作为数据传入，不得混入控制指令区。

---

## 7. 用户输入与 Prompt Injection 防护

用户输入不可默认可信。

要求：

- 限制用户输入长度。
- 限制文件、网页、RAG 文档大小。
- 用户输入不得拼进 system prompt 的控制区域。
- 用户输入和检索内容只能作为数据，不作为指令。
- 高风险场景应使用规则、模型或 guardrails 检测 injection。

基础检测示例：

```python
INJECTION_PATTERNS = [
    r"ignore.*previous.*instruction",
    r"system\s+prompt",
    r"you\s+are\s+now\s+",
    r"pretend\s+you\s+are\s+",
    r"developer\s+message",
]


def detect_prompt_injection(text: str) -> bool:
    return any(re.search(pattern, text, re.I) for pattern in INJECTION_PATTERNS)
```

规则检测只能作为基础防线。高风险系统应考虑专门的 prompt injection 检测模型、Rebuff、NeMo Guardrails 或自研安全分类器。

---

## 8. 结构化输出

凡是后续代码要消费模型输出，都必须使用结构化输出和 schema 校验。

```python
class IntentResult(BaseModel):
    intent: Literal["search", "summarize", "chat", "unknown"]
    confidence: float = Field(ge=0, le=1)
    reason: str
```

要求：

- 不依赖自然语言字符串做业务判断。
- JSON 输出必须 parse 后校验。
- 校验失败应重试、降级或返回明确错误。
- 禁止用正则解析复杂 JSON。
- 模型输出字段必须有默认值、范围或枚举约束。

结构化输出失败处理顺序：

1. 记录原始错误和 prompt version。
2. 使用更严格的 repair prompt 重试一次。
3. 仍失败则降级或返回明确错误。
4. 将失败样例加入 eval 数据集。

---

## 9. 工具调用

模型可以建议调用工具，但工具执行必须由代码控制。

要求：

- 工具参数必须 schema 校验。
- 工具权限必须由后端判断。
- 工具执行前检查当前用户权限。
- 工具返回内容不可默认可信。
- 工具调用次数必须有限制。
- 高风险工具必须有人类确认或二次校验。

高风险工具：

- 删除数据。
- 修改权限。
- 发邮件或消息。
- 下单、支付、退款。
- 写数据库。
- 调用外部系统产生副作用。

工具定义应包含：

- 名称。
- 描述。
- 输入 schema。
- 输出 schema。
- 权限要求。
- 是否有副作用。
- 超时。
- 最大调用次数。

---

## 10. RAG 检索

RAG 内容属于外部上下文，不等于事实。

要求：

- 检索结果必须记录来源。
- 返回答案尽量附带引用。
- 检索内容限制 token 长度。
- 多文档拼接时保留文档边界。
- 检索结果不得覆盖 system prompt。
- 用户上传文档需做权限校验。
- 文档中的 prompt injection 需要隔离。

推荐上下文格式：

```text
[Document 1]
source: ...
content: ...

[Document 2]
source: ...
content: ...
```

答案生成时应明确要求：

- 只基于给定文档回答。
- 信息不足时说不知道。
- 不确定时给出不确定性。
- 引用对应 source。

---

## 11. 对话上下文管理

多轮对话必须管理 context window，不应无限追加历史消息。

上下文预算建议：

- system prompt：固定预算。
- 最近对话：优先保留。
- 历史摘要：压缩保留。
- 工具结果：只保留当前任务相关部分。
- 用户长期记忆：显式授权后保留。

推荐策略：

```text
最终上下文 =
  system prompt
  + 用户画像或长期记忆摘要
  + 历史对话摘要
  + 最近 N 轮消息
  + 当前任务相关工具结果
  + 当前用户输入
```

要求：

- 设定每次请求的最大上下文 token 预算。
- 超长历史使用摘要压缩。
- 摘要本身也应标注生成时间和来源范围。
- 关键事实 memory 应有来源和过期策略。
- 用户可删除或清空长期记忆。
- 不把无关历史、敏感历史默认发送给模型。

---

## 12. 流式输出工程模式

推荐状态机：

```python
class StreamState(str, Enum):
    STREAMING = "streaming"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    TIMEOUT = "timeout"
    ERROR = "error"
```

推荐事件格式：

```json
{"type": "delta", "content": "..."}
{"type": "metadata", "model": "xxx", "request_id": "xxx"}
{"type": "error", "code": "LLM_TIMEOUT", "message": "..."}
{"type": "done", "finish_reason": "stop"}
```

流式输出 + 结构化校验推荐模式：

1. 流式 chunk 先展示给用户。
2. 后端同时聚合完整响应。
3. 生成结束后对完整响应做 schema 校验。
4. 校验通过后落库为 `completed`。
5. 校验失败则标记为 `error` 或触发 repair。
6. 客户端断开、超时、异常时标记对应状态。

要求：

- 不要把 partial chunk 当作最终结果。
- 客户端断开后及时取消下游 LLM 请求。
- 需要落库时区分草稿、完成、取消、超时、失败。
- 流式内容也要经过必要的安全过滤。

---

## 13. 输出安全过滤

模型输出也不可默认可信。

需要过滤或拦截：

- 敏感个人信息。
- 密钥、Token、内部地址。
- 越权内容。
- 违反产品安全边界的内容。
- 非法、危险或不合规内容。

基础示例：

```python
BLOCKED_PATTERNS = [
    r"api[_-]?key\s*[:=]",
    r"bearer\s+[a-z0-9._-]+",
    r"password\s*[:=]",
]


def filter_output(content: str) -> tuple[str, bool]:
    blocked = any(re.search(pattern, content, re.I) for pattern in BLOCKED_PATTERNS)
    if blocked:
        return "输出包含敏感内容，已被安全策略拦截。", True
    return content, False
```

要求：

- 高风险产品应使用专门 moderation 或 guardrails。
- 输出过滤命中必须记录安全事件，但不要记录敏感原文。
- 过滤策略应可测试、可配置、可审计。

---

## 14. 超时、重试与降级

所有 LLM 调用必须设置 timeout。

要求：

- timeout 小于接口整体 SLA。
- 只对可恢复错误重试。
- 重试有最大次数。
- 重试使用指数退避和抖动。
- 用户取消请求时取消下游 LLM 调用。
- 模型不可用时有降级策略。

可重试：

- 网络抖动。
- 超时。
- `429`。
- 部分 `5xx`。

不可盲目重试：

- 认证失败。
- 参数错误。
- 内容安全拒绝。
- 业务校验失败。

降级方式：

- 返回明确错误。
- 使用低成本或备用模型。
- 使用缓存结果。
- 切换到非 AI 规则逻辑。
- 提示用户稍后重试。

---

## 15. 成本与预算控制

必须记录：

- input tokens。
- output tokens。
- model。
- provider。
- estimated cost。
- user_id / tenant_id。
- task type。

预算维度：

- 单用户每日预算。
- 单会话预算。
- 单任务预算。
- 后台批处理总预算。
- 高成本模型调用次数。

预算超限行为必须明确：

- 返回"今日调用次数已用完"。
- 队列延迟执行。
- 请求用户确认继续。
- 降级到低成本模型，但必须明确记录。
- 拒绝高成本功能。

禁止静默使用质量不可控的模型替代关键能力。

---

## 16. 缓存

适合缓存：

- 摘要。
- 分类结果。
- embedding。
- RAG 检索结果。
- 无隐私的公共问答。

不适合缓存：

- 强个性化回答。
- 包含隐私信息的上下文。
- 权限敏感结果。
- 实时性要求高的内容。

缓存 key 应包含：

- prompt version。
- model。
- temperature。
- 工具版本。
- 输入 hash。
- RAG index version。

监控指标：

- cache hit rate。
- cache miss rate。
- 节省 token。
- 命中后的用户反馈。
- 缓存污染或过期错误。

如果命中率长期低于合理阈值，例如 5%，应评估缓存 key 设计或取消缓存。

---

## 17. Eval 最小可行工作流

Eval 数据来源：

- 核心用户路径。
- 人工构造边界样例。
- 线上失败案例。
- 客服或运营标注样例。
- 安全攻击样例。
- 多语言样例。

推荐 JSONL 格式：

```json
{"id":"case_001","input":"...","expected":{"intent":"search"},"tags":["intent","normal"]}
{"id":"case_002","input":"...","expected":{"blocked":true},"tags":["safety","injection"]}
```

Scorer 类型：

- schema valid。
- exact match。
- contains / not contains。
- embedding similarity。
- LLM judge。
- human label。

落地路径：

1. 先收集 30-50 条核心样例。
2. 每次线上失败后加入回归集。
3. Prompt 或模型变更时跑核心 eval。
4. CI 中跑 smoke eval。
5. 大版本变更跑完整 regression eval。

主观任务，例如文案、客服质量、总结质量，应建立人工标注规范。重要评测建议多人标注，并做一致性检查，例如 Cohen's Kappa，避免单人主观偏差。

---

## 18. Agent 编排

Agent 不能只靠"让模型自己规划"。

推荐模式：确定性编排 + LLM 语义处理。

代码负责：

- 状态流转。
- 权限检查。
- 工具执行。
- 重试。
- 补偿。
- 幂等。
- 预算控制。

LLM 负责：

- 意图识别。
- 信息抽取。
- 文本生成。
- 候选方案生成。
- 非确定性语义判断。

每一步应定义：

- 输入 schema。
- 输出 schema。
- 允许调用的工具。
- 最大执行时间。
- 最大 token。
- 失败恢复策略。

必须限制：

- 最大步骤数。
- 最大工具调用次数。
- 最大 token 预算。
- 最大执行时间。
- 每一步 trace。

禁止：

- 无限制 self-reflection 循环。
- 让模型自行决定执行高风险操作。
- 把流程控制完全交给模型。
- 在没有权限校验的情况下执行工具。

---

## 19. 日志与可观测性

每次 LLM 调用建议记录：

- `request_id`
- `user_id`
- `conversation_id`
- `provider`
- `model`
- `prompt_version`
- `temperature`
- `input_tokens`
- `output_tokens`
- `latency_ms`
- `status`
- `error_code`
- `cache_hit`
- `eval_trace_id`

禁止记录：

- API Key。
- Token。
- 密码。
- Cookie。
- 完整敏感 prompt。
- 用户隐私原文。
- 未脱敏文档内容。

如需排查 prompt，应使用脱敏、采样或仅在安全环境中记录。

---

## 20. 测试规范

单元测试覆盖：

- Prompt 渲染。
- Schema 校验。
- LLM client 错误转换。
- Provider adapter 转换。
- 工具参数校验。
- RAG 上下文拼接。
- 上下文窗口截断。
- 超时、重试、降级逻辑。
- 输出过滤。

集成测试应 mock 模型响应。

禁止普通测试依赖真实大模型稳定输出。真实模型调用应放在 eval、smoke test 或专门的人工触发流程中。

---

## 21. 版本追踪

以下内容必须可追踪：

- prompt version。
- model name。
- model provider。
- temperature。
- max tokens。
- tool schema version。
- RAG index version。
- eval dataset version。
- context policy version。
- safety policy version。

线上结果出现问题时，应能回溯当时使用的完整 AI 配置。

---

## 22. 最终原则

合格的 LLM 调用代码应满足：

- 输入边界清晰。
- Prompt 可版本化。
- 输出可校验。
- 工具调用可控。
- 上下文可管理。
- 成本可统计。
- 错误可处理。
- 行为可观测。
- 效果可评测。
- 安全风险可隔离。
