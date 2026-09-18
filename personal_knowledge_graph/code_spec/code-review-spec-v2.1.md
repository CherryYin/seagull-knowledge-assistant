# Code Review 规范（Spec）v2.2

> 适用场景：指导 AI 进行代码审查 ｜ 作为团队 Code Review 标准
> 技术栈：Python（FastAPI / Pydantic / SQLAlchemy 2.0 / pytest）
> 版本：v2.2（基于 Claude × DeepSeek × Gemini × GPT-5.5 交叉审查反馈修订）

---

## 1. 总则

### 1.1 Review 的目标

Code Review 不是"找茬"，而是保障以下四个方面：

- **正确性**：代码是否准确实现了需求，边界条件是否覆盖
- **可维护性**：六个月后其他人（或自己）能否快速理解和修改
- **一致性**：是否与项目现有风格和架构决策保持统一
- **安全性**：是否存在注入、泄露、权限绕过等风险

### 1.2 严重性分级

所有 Review 意见必须标注等级，便于快速决策：

| 等级 | 标记 | 含义 | 处理要求 |
|------|------|------|----------|
| P0 - 阻断 | 🔴 MUST FIX | Bug、安全漏洞、数据丢失风险 | 必须修复后才能合并 |
| P1 - 重要 | 🟡 SHOULD FIX | 设计问题、明显冗余、缺失错误处理 | 强烈建议本次修复 |
| P2 - 建议 | 🔵 SUGGESTION | 可读性优化、更优写法、小重构 | 可纳入后续迭代 |
| P3 - 讨论 | 💬 DISCUSSION | 架构方向、技术选型、风格偏好 | 仅供讨论，不阻塞合并 |

#### 1.2.1 典型问题分级速查

当不确定某个问题属于哪个等级时，参考以下默认分级：

| 问题类型 | 默认分级 | 升/降级条件 |
|---------|---------|------------|
| 空 `except` / 吞异常 | P0 | 有明确日志记录且为非关键旁路逻辑 → P1 |
| 硬编码密钥或密码 | P0 | — |
| 未处理用户输入边界 | P1 | 涉及资金/权限 → P0 |
| N+1 查询 | P1 | 数据量大或高频调用 → P0 |
| 缺少错误处理（外部调用） | P1 | — |
| 未使用的 import / 变量 | P2 | — |
| 缺少类型标注 | P2 | 公共 API → P1 |
| 注释掉的无用代码 | P2 | — |
| 命名风格不一致 | P2 | 同一 PR 内大量不一致 → P1 |
| 可用更优写法 | P3 | — |

### 1.3 AI Review 使用说明

将代码提交给 AI 审查时，建议使用以下 prompt 模板：

```
请对以下代码进行 Code Review，遵循我们的 Review 规范。

项目背景：[简要说明项目功能和架构]
本次变更目的：[说明这次改动要解决什么问题]
需要重点关注：[可选，指定特别关心的维度]

代码如下：
[粘贴代码或提供文件路径]

请按 P0-P3 分级输出问题，每个问题给出：
1. 问题所在（引用具体行号或代码片段）
2. 问题原因
3. 修复建议（给出改后的代码）
如果有写得特别好的设计决策，也请简要指出。
```

> **提示**：P2/P3 级别的问题（未使用 import、类型标注缺失、命名风格等）应尽量通过 Linter 工具（如 Ruff、Mypy）自动化检测。人工或 AI Review 的精力应集中在 Linter 无法覆盖的 P0/P1 问题上。如果项目使用 Cursor 等 AI 编辑器，可将本规范作为 `.cursorrules` 文件，让 AI 在生成代码阶段就对齐标准。

### 1.4 原则冲突时的优先级

本规范中的各项指标（函数行数、参数个数等）是信号而非铁律。当两条原则冲突时，按以下优先级从高到低取舍：

1. **正确性** — Bug 修复优先于任何代码风格改进
2. **安全性** — 安全问题不可妥协
3. **可读性 / 可维护性** — 对下一个读代码的人友好，优先于"优雅"
4. **性能** — 除非已测量为瓶颈，否则不为性能牺牲可读性
5. **硬性指标** — 行数、参数个数等仅作为 code smell 的触发器，不机械执行

典型场景：一个 60 行的线性函数如果逻辑清晰、无重复，比拆成 4 个只调用一次的子函数更好。"函数不超过 50 行"是提醒你检查是否需要拆分，不是强制你拆分。

### 1.5 按变更风险的 Review 策略

不是所有变更都需要同等强度的审查。根据变更的**风险等级**而非单纯行数来调整策略：

| 风险等级 | 典型场景 | Review 策略 |
|---------|---------|-------------|
| 高风险 | 涉及资金、权限、核心业务流程、数据库 schema 变更 | 全维度严格审查，即使只改了 10 行 |
| 中风险 | 常规功能开发、API 新增、业务逻辑调整 | 完整执行本规范 |
| 低风险 | 文案修改、日志调整、依赖版本升级、纯重命名 | 聚焦 P0/P1，可豁免风格细节 |
| 大规模重构 | 单次变更超过 300 行 | 建议拆分为多个 PR；若无法拆分，需架构层面优先审查 |

---

## 2. 架构与设计

### 2.1 分层职责

```
Router (API 层)      → 参数校验、响应序列化，不含业务逻辑
Service (业务层)     → 业务规则、流程编排、事务管理
Repository (数据层)  → 数据库查询、ORM 操作、缓存读写
Schema (数据契约)    → Pydantic model，输入/输出/内部 DTO 分离
```

**审查要点：**

- Router 层是否混入了业务逻辑（如条件判断、数据组装）
- 数据访问是否集中且可测试（可以通过 Repository 层隔离，也可以 Service 直接使用 session，关键是事务边界清晰、便于 mock 测试）
- 是否存在跨层调用（如 Router 直接执行数据库查询）
- 单个函数/方法是否承担了多个职责

### 2.2 确定性逻辑 vs. LLM 调用边界（Route B 原则）

对于涉及 AI/LLM 的项目，需要特别检查：

- 业务规则是否被错误地交给 LLM 处理（应该用确定性规则引擎）
- LLM 是否仅用于其擅长的任务：自然语言理解、非结构化→结构化转换、语义判断
- 决策路由、流程分支是否用代码（if/match/状态机）而非 LLM prompt 实现
- LLM 调用是否有 fallback 机制和超时处理

### 2.3 依赖管理

- 是否引入了不必要的第三方库（能用标准库解决的就不要引入）
- 新增依赖是否经过基本评估（许可证兼容性、维护活跃度、包体积）
- 是否存在循环导入
- `poetry.lock` / `uv.lock` / `requirements.txt` 是否随代码一起提交
- 版本约束是否合理（推荐使用 lock 文件锁定完整依赖树，`pyproject.toml` 中可用 `~=` 或 `>=,<` 约束兼容范围，避免无上限的 `>=`）
- dev 依赖（pytest、ruff、mypy 等）是否与生产依赖分离
- 新增的库与现有框架版本是否兼容（如 SQLAlchemy 2.x 与特定 alembic 版本）

---

## 3. 代码质量

### 3.1 冗余与死代码

这是 AI 生成代码最常见的问题，需要重点排查：

| 冗余类型 | 示例 | 处理 |
|---------|------|------|
| 未使用的 import | `import os` 但全文未用 | 删除 |
| 未调用的函数/类 | 定义了 `helper()` 但无人调用 | 删除或确认是否为公共接口 |
| 重复逻辑 | 两个函数做了几乎相同的事 | 抽取公共方法 |
| 过度封装 | 只有一处调用的单行包装函数 | 内联 |
| 注释掉的代码 | `# old_func()` | 删除，用 git 历史追溯 |
| 冗余条件判断 | `if x is not None: if x: ...` | 简化 |
| AI 生成的占位代码 | `pass`、`TODO`、示例数据 | 实现或删除 |

### 3.2 命名规范

```python
# 模块名：小写 + 下划线
order_service.py

# 类名：PascalCase
class OrderService:

# 函数/方法/变量：snake_case
def calculate_total_price(order_items: list[OrderItem]) -> Decimal:

# 常量：全大写 + 下划线
MAX_RETRY_COUNT = 3
DEFAULT_PAGE_SIZE = 20

# 私有属性/方法：单下划线前缀
def _validate_internal(self):

# Pydantic model：名词，区分用途
class OrderCreateRequest(BaseModel):   # 输入
class OrderResponse(BaseModel):        # 输出
class OrderInDB(BaseModel):            # 内部 DTO
```

**审查要点：**

- 名称是否准确反映用途（避免 `data`、`info`、`tmp`、`result` 等模糊命名）
- bool 变量是否用 `is_`/`has_`/`can_` 前缀
- 避免缩写（`calc_amt` → `calculate_amount`），除非是领域内广泛认可的缩写
- 同一概念全项目是否统一命名（不要一处叫 `user`，一处叫 `account`）

### 3.3 函数设计

- 单个函数不超过 50 行（不含文档和空行）
- 参数不超过 5 个，超过时考虑用 Pydantic model 或 dataclass 封装
- 避免 bool 参数控制分支（拆成两个函数）
- 函数要有单一明确的返回类型
- 避免副作用隐藏在看似纯函数的函数中

### 3.4 类型标注

```python
# ✅ 好：完整标注
def get_user_orders(
    user_id: int,
    status: OrderStatus | None = None,
    limit: int = 20,
) -> list[OrderResponse]:

# ❌ 差：缺失标注
def get_user_orders(user_id, status=None, limit=20):
```

- 所有公共函数必须有完整的参数和返回值类型标注
- 内部函数建议标注，至少标注返回值
- 使用 `X | None` 而非 `Optional[X]`（Python 3.10+）
- 复杂类型使用 `TypeAlias` 提高可读性

### 3.5 注释与文档

- 复杂业务逻辑、公共库 API、非显然行为的函数和类必须有 docstring（具体格式遵循项目约定，如 Google style / NumPy style）；签名自解释的简单函数（如 `get_user_by_id(user_id: int) -> User`）可免
- 注释应解释"为什么这样做"，而非"代码在做什么"——代码本身应该自解释
- 复杂业务规则（如计费逻辑、状态机转换、特殊的边界处理）必须有注释说明背景和决策原因
- 不要留下过度注释（AI 生成代码的常见问题：每行都有注释，反而增加噪音）

---

## 4. 错误处理

### 4.1 异常策略

```python
# ✅ 好：定义业务异常，携带上下文
class OrderNotFoundError(AppBaseError):
    def __init__(self, order_id: int):
        super().__init__(
            message=f"Order {order_id} not found",
            error_code="ORDER_NOT_FOUND",
            status_code=404,
        )

# ❌ 差：裸 raise 或 catch-all
raise Exception("order not found")

try:
    ...
except Exception:
    pass  # 吞掉异常
```

**审查要点：**

- 是否存在空的 `except` 或 `except Exception: pass`（吞异常）
- 是否在不该捕获的地方捕获（让异常自然冒泡到全局处理器）
- 异常信息是否包含足够的调试上下文（如 ID、输入参数）
- 外部调用（HTTP、DB、文件 I/O）是否有异常处理
- 是否区分了可恢复和不可恢复的错误

### 4.2 输入校验

- API 输入是否通过 Pydantic validator 校验
- 是否校验了业务规则（如金额为正数、日期范围合理）
- 是否对用户输入做了格式和长度约束（防止恶意超长输入、格式注入）
- 注意：XSS 防护主要依赖输出侧转义（模板引擎、前端渲染），不应依赖输入校验；SQL 注入防护依赖参数化查询（见 7.1）

### 4.3 日志与可观测性

```python
# ✅ 好：结构化日志，含上下文
logger.info(
    "Order created",
    extra={"order_id": order.id, "user_id": user.id, "amount": str(order.total)},
)

# ❌ 差：非结构化，缺乏上下文
print("order created")
logger.info(f"order created: {order}")  # 可能泄露敏感信息
```

- 关键业务操作是否有日志记录
- 日志是否使用结构化格式
- 是否避免了在日志中输出敏感信息（密码、token、身份证号）
- 错误日志是否包含 traceback

---

## 5. 数据库与 ORM

### 5.1 SQLAlchemy 2.0 规范

```python
# ✅ 好：2.0 风格
from sqlalchemy import select

stmt = select(Order).where(Order.user_id == user_id).order_by(Order.created_at.desc())
result = await session.execute(stmt)
orders = result.scalars().all()

# ❌ 差：1.x 遗留风格
orders = session.query(Order).filter_by(user_id=user_id).all()
```

**审查要点：**

- 是否使用 2.0 风格的 `select()` 而非 1.x 的 `session.query()`
- 是否存在 N+1 查询（循环中逐条查询关联数据）
- 批量操作是否使用 `bulk_insert_mappings` 或 `insert().values()`
- 事务边界是否清晰（Service 层控制，而非 Repository 内自行 commit）
- 是否有必要的索引

### 5.2 事务原子性

- 一个 Service 方法原则上对应一个事务单元，方法结束时统一 commit 或 rollback
- 禁止在循环中调用 `session.commit()`（如需分批处理大数据量，应显式标注并使用独立的批处理方法）
- 跨 Service 调用时，确保共享同一个 session/事务，避免部分成功部分失败的中间状态

### 5.3 数据库迁移

- 迁移文件是否与 model 变更一致
- 是否有不可逆迁移需要额外注意
- 迁移是否考虑了大表的锁表风险

---

## 6. API 设计

### 6.1 FastAPI 路由规范

```python
# ✅ 好：清晰的路由定义
@router.post(
    "/orders",
    response_model=OrderResponse,
    status_code=status.HTTP_201_CREATED,
    summary="创建订单",
    responses={
        409: {"description": "订单重复"},
    },
)
async def create_order(
    request: OrderCreateRequest,
    service: OrderService = Depends(get_order_service),
) -> OrderResponse:
    return await service.create_order(request)
```

**审查要点：**

- URL 是否遵循 RESTful 风格（资源名词复数，动词用 HTTP method 表示）
- 是否正确使用了 HTTP 状态码
- 是否使用依赖注入管理 Service/DB session
- 响应是否通过 `response_model` 过滤了内部字段
- 是否有必要的 rate limiting 和权限校验

### 6.2 Pydantic Model 规范

```python
# ✅ 好：输入输出分离，带校验器
class OrderCreateRequest(BaseModel):
    model_config = ConfigDict(strict=True)

    product_id: int = Field(..., gt=0)
    quantity: int = Field(..., ge=1, le=999)
    shipping_address: str = Field(..., min_length=1, max_length=500)

    @field_validator("shipping_address")
    @classmethod
    def strip_address(cls, v: str) -> str:
        return v.strip()


class OrderResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    status: OrderStatus
    total: Decimal
    created_at: datetime
```

- 输入 model 和输出 model 是否分离（不要用同一个 model）
- 敏感字段是否在 Response model 中排除
- 是否使用 `Field` 约束做了基础校验

---

## 7. 安全性

### 7.1 必查项

| 检查项 | 具体要求 |
|--------|----------|
| 密钥管理 | 不硬编码 API key/密码，使用环境变量或 Secret Manager |
| SQL 注入 | 禁止字符串拼接 SQL，使用参数化查询 |
| SSRF | 外部 URL 输入需校验白名单 |
| 权限校验 | 每个接口是否验证了用户身份和资源归属 |
| 数据脱敏 | 日志和响应中不暴露敏感信息 |
| CORS | 生产环境不允许 `allow_origins=["*"]` |
| 依赖安全 | 是否有已知漏洞的依赖版本 |

### 7.2 AI/LLM 相关安全

- Prompt 是否防范了注入攻击（用户输入是否直接拼入 system prompt）
- LLM 输出是否经过校验后才用于下游逻辑
- API key 是否在服务端管理，而非暴露给前端
- 是否有 token 用量监控和限制机制

---

## 8. 测试

### 8.1 测试覆盖要求

```python
# ✅ 好：清晰的测试结构
class TestOrderService:
    """订单服务单元测试"""

    async def test_create_order_success(self, mock_repo):
        """正常创建订单"""
        request = OrderCreateRequest(product_id=1, quantity=2, shipping_address="北京市")
        order = await service.create_order(request)
        assert order.status == OrderStatus.PENDING
        mock_repo.save.assert_called_once()

    async def test_create_order_product_not_found(self, mock_repo):
        """商品不存在时抛出异常"""
        mock_repo.get_product.return_value = None
        with pytest.raises(ProductNotFoundError):
            await service.create_order(request)

    async def test_create_order_insufficient_stock(self, mock_repo):
        """库存不足时抛出异常"""
        ...
```

**审查要点：**

- 是否覆盖了正常路径、异常路径和边界条件
- 测试是否真正验证了行为（不只是"不报错"）
- Mock 是否合理（只 mock 外部依赖，不 mock 被测对象内部逻辑）
- 测试命名是否描述了场景（`test_create_order_insufficient_stock`）
- 是否有集成测试覆盖关键流程

### 8.2 测试反模式

- 测试中硬编码时间戳或依赖系统时间
- 测试之间有隐式依赖（顺序敏感）
- 对实现细节断言而非对行为断言
- 测试代码本身存在逻辑错误

### 8.3 可测试性设计检查

Review 不仅要检查测试本身，还要识别那些"让代码难以测试"的设计：

- 函数内部是否硬编码了 `datetime.now()`、`uuid4()` 等非确定性调用？（应通过参数注入或依赖注入）
- 是否存在难以 mock 的全局状态或模块级单例？
- 业务逻辑是否与 I/O（数据库、HTTP 请求、文件操作）紧密耦合？（应将纯逻辑抽出为可独立测试的函数）
- 类的构造函数是否做了过多的初始化工作（如建立连接、读取配置），导致实例化即产生副作用？

---

## 9. 性能

### 9.1 常见性能问题

| 问题 | 识别方式 | 解决方案 |
|------|---------|---------|
| N+1 查询 | 循环中调用 ORM 关联属性 | 使用 `selectinload` / `joinedload` |
| 大量数据一次性加载 | `select(X).all()` 无分页 | 加 `limit/offset` 或游标分页 |
| 同步阻塞 | 在 async 函数中调用同步 I/O | 使用 `run_in_executor` 或异步库 |
| 重复计算 | 循环中重复调用无副作用函数 | 提取到循环外或加缓存 |
| 无缓存 | 高频不变数据每次查库 | Redis 缓存 + 合理 TTL |
| 串行外部调用 | 多个独立 API 调用顺序执行 | `asyncio.gather` 并发 |

### 9.2 异步规范

```python
# ✅ 好：独立任务并发执行
user, products, promotions = await asyncio.gather(
    user_service.get_user(user_id),
    product_service.list_products(product_ids),
    promotion_service.get_active_promotions(),
)

# ❌ 差：顺序等待
user = await user_service.get_user(user_id)
products = await product_service.list_products(product_ids)
promotions = await promotion_service.get_active_promotions()
```

**`asyncio.gather` 的异常处理陷阱：**

默认情况下，`gather` 中任一任务抛出异常会立即向调用者传播，但其余任务**不会被自动取消**——它们会继续运行，变成无人等待的孤儿协程（可能导致资源泄漏或意外副作用）。需要根据场景选择策略：

```python
# 策略一：任一失败即终止（适合"全部成功才有意义"的场景）
user, products = await asyncio.gather(
    user_service.get_user(user_id),
    product_service.list_products(product_ids),
)  # 默认行为，某个失败会抛异常

# 策略二：容忍部分失败（适合"尽量多拿结果"的场景）
results = await asyncio.gather(
    fetch_primary_data(),
    fetch_optional_enrichment(),
    return_exceptions=True,
)
# 需要逐个检查 results 中是否有 Exception 实例
for r in results:
    if isinstance(r, Exception):
        logger.warning(f"Partial failure: {r}")
```

---

## 10. 配置与环境

- 配置是否通过 Pydantic `BaseSettings` 管理
- 是否区分了开发/测试/生产环境配置
- 敏感配置是否通过环境变量注入（而非配置文件）
- 默认值是否合理且安全

```python
# ✅ 好：Pydantic Settings
class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env")

    database_url: str
    redis_url: str = "redis://localhost:6379/0"
    debug: bool = False
    max_retry: int = 3

settings = Settings()
```

---

## 11. Review 流程（给人类和 AI 的共同指引）

### 11.1 Review 前的准备

1. 确认变更的目的和范围（阅读 PR 描述或需求文档）
2. 先看整体结构（新增/修改了哪些文件），再看具体实现
3. 关注变更的增量，而非已有代码（除非已有代码被本次变更影响）

### 11.2 Review 顺序

建议按以下顺序审查，逐层深入：

```
第一遍：架构层面
  → 文件结构是否合理
  → 模块职责是否清晰
  → 依赖方向是否正确

第二遍：实现层面
  → 逻辑是否正确
  → 边界条件是否覆盖
  → 错误处理是否完善

第三遍：工程规范层面
  → 命名、类型标注、文档
  → 测试覆盖
  → 性能隐患
```

### 11.3 Review 输出格式

每条意见遵循以下模板：

```
[P0/P1/P2/P3] 文件名:行号 - 简要描述

问题：具体说明发现了什么问题
原因：为什么这是个问题
建议：推荐的修改方向（P0/P1 的复杂问题附代码示例；简单或 P2/P3 问题点明方向即可）
```

示例：

```
🔴 [P0] order_service.py:45 - 未处理库存扣减失败

问题：`deduct_stock()` 调用没有捕获异常，库存不足时会抛出未处理的 500 错误
原因：用户会看到服务器内部错误，且订单可能已部分创建导致数据不一致
建议：
    try:
        await stock_service.deduct_stock(product_id, quantity)
    except InsufficientStockError:
        raise OrderCreationError(
            f"Product {product_id} insufficient stock",
            error_code="INSUFFICIENT_STOCK",
        )
```

---

## 12. AI 生成代码的专项检查清单

AI 生成的代码有一些常见的"隐疾"，需要额外关注：

| 序号 | 检查项 | 说明 |
|------|--------|------|
| 1 | 幻觉 API | 调用了不存在的库方法或参数（尤其注意版本差异） |
| 2 | 过度设计 | 简单需求被实现成了复杂的抽象层（不需要的 Factory/Strategy 模式） |
| 3 | 示例残留 | `example.com`、`your-api-key`、`TODO` 等占位内容 |
| 4 | 不一致风格 | 多次生成的代码在命名/结构上不统一 |
| 5 | 缺失边界 | 只实现了 happy path，没有错误处理和边界检查 |
| 6 | 安全盲区 | 硬编码密钥、未校验输入、过于宽松的 CORS |
| 7 | 过度注释 | 每行都有注释，反而降低了可读性 |
| 8 | 依赖膨胀 | 引入整个库只为用一个函数 |
| 9 | 测试表演 | 测试存在但不验证有意义的行为 |
| 10 | 复制粘贴 | 相似逻辑被复制多份而非抽象复用 |

---

## 附录 A：Review Prompt 速查

### 快速全面审查

```
请按照以下维度对代码做全面 Code Review，按 P0-P3 分级输出：
1. 正确性（逻辑错误、边界条件）
2. 安全性（注入、泄露、权限）
3. 冗余度（死代码、重复逻辑、过度封装）
4. 可维护性（命名、结构、类型标注）
5. 性能（N+1、阻塞、缓存缺失）
6. 测试（覆盖率、断言质量）
```

### 聚焦架构审查

```
请以资深后端架构师的视角审查这段代码的架构设计：
- 分层是否清晰（Router / Service / Repository）
- 依赖方向是否正确
- 模块边界是否合理
- 是否存在不必要的复杂度
- 如果涉及 LLM 调用，确定性逻辑和 LLM 任务的边界是否清晰
```

### 聚焦安全审查

```
请以安全工程师的视角审查这段代码，重点检查：
- SQL 注入 / XSS / SSRF 风险
- 认证和授权漏洞
- 敏感信息泄露（日志、响应、配置）
- 依赖项安全性
- 如果涉及 LLM，prompt 注入防护是否到位
```

### 聚焦 AI 生成代码审查

```
这段代码是 AI 生成的，请重点检查 AI 代码常见问题：
- 是否存在幻觉 API（不存在的方法或参数）
- 是否过度设计（不需要的设计模式和抽象层）
- 是否有占位代码残留（TODO、示例数据、硬编码密钥）
- 多次生成的代码风格是否统一
- 是否只实现了 happy path
```