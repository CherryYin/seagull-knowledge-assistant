# FastAPI Python 后端工程编码规范 v2

> 适用场景：FastAPI 后端服务开发、团队代码评审、新人 onboarding、生产服务治理  
> 推荐技术栈：FastAPI / Pydantic v2 / SQLAlchemy 2.x / Alembic / pytest / ruff / mypy 或 pyright  
> 核心目标：让代码不仅能运行，还能长期维护、稳定上线、快速排障

---

## 0. 执行等级

为了避免规范变成一份"什么都重要"的清单，本文按执行强度分为三类。

### P0 必须遵守

违反 P0 通常意味着不应合并或不应上线：

- 安全与敏感信息保护
- 输入校验与响应契约
- 统一异常处理
- 数据库事务与一致性
- 幂等性
- 外部调用 timeout 与重试边界
- 数据库迁移安全
- 生产配置与密钥管理
- 请求日志、错误日志和 request_id

### P1 强烈推荐

P1 是团队长期维护质量的基础，除非有明确理由，否则应遵守：

- 清晰分层
- 类型标注
- 自动化测试
- CI 检查
- 结构化日志
- Repository 或等价的数据访问边界
- 中间件统一处理横切逻辑

### P2 按需采用

P2 适用于复杂度较高的生产系统，不要求所有项目一开始就全部引入：

- 分布式锁
- 消息队列
- 链路追踪
- 复杂缓存策略
- 完整 Unit of Work 模式
- 游标分页
- 复杂限流和熔断

---

## 1. 快速执行版：20 条核心规则

适合小团队、MVP、新项目初始化阶段。

1. 路由函数只处理 HTTP 协议，不写复杂业务逻辑。
2. 所有外部输入必须经过 Pydantic 校验。
3. 请求模型、响应模型、数据库 ORM 模型应分离。
4. Service 层不依赖 `Request`、`Response`、`HTTPException`。
5. 数据库访问必须和业务逻辑保持清晰边界。
6. 所有外部 HTTP 调用必须设置 timeout。
7. `async def` 中禁止直接调用阻塞 IO。
8. 列表接口必须分页，并限制最大 `limit`。
9. 用户输入禁止拼接 SQL。
10. 不要使用 `except Exception: pass` 吞异常。
11. 业务异常必须转换为统一错误响应。
12. 日志必须带 `request_id`，禁止记录密码、Token、Cookie、API Key。
13. 密钥和生产配置只能来自环境变量或安全配置系统。
14. 重要写接口必须考虑幂等性。
15. 数据库事务边界必须清晰。
16. 数据库 schema 变更必须有 Alembic migration。
17. Bug 修复必须补回归测试。
18. PR 必须通过 format、lint、type check、test。
19. 不要在 PR 中混入无关重构或大范围格式化。
20. 涉及发布风险的变更必须写清楚回滚方案。

---

## 2. 推荐项目结构

```text
src/
  app/
    main.py
    api/
      v1/
        routers/
          users.py
          orders.py
        dependencies.py
    core/
      config.py
      logging.py
      middleware.py
      security.py
      exceptions.py
    schemas/
      user.py
      order.py
    models/
      user.py
      order.py
    services/
      user_service.py
      order_service.py
    repositories/
      user_repository.py
      order_repository.py
    clients/
      payment_client.py
    db/
      session.py
      migrations/
    tasks/
      email_tasks.py
    utils/
tests/
  unit/
  integration/
  e2e/
```

职责要求：

- `api` 层负责路由、参数解析、依赖注入、响应转换。
- `schemas` 层负责请求和响应模型。
- `services` 层负责业务规则和用例编排。
- `repositories` 层负责数据库查询和持久化。
- `clients` 层负责第三方服务调用。
- `core` 层负责配置、日志、中间件、异常、安全基础设施。

Repository 层不是所有项目的硬性要求。复杂查询多、多人协作、未来可能切换存储实现的项目推荐使用 Repository；简单 CRUD 服务可以让 service 直接使用 `AsyncSession`，但必须保持数据访问逻辑和业务逻辑边界清楚。

---

## 3. FastAPI 路由规范

URL 使用资源名词，优先使用复数形式：

```text
GET    /api/v1/users
GET    /api/v1/users/{user_id}
POST   /api/v1/users
PATCH  /api/v1/users/{user_id}
DELETE /api/v1/users/{user_id}
```

避免：

```text
POST /getUser
POST /createUser
GET  /userList
```

路由函数应保持轻量：

```python
@router.get("/{user_id}", response_model=UserResponse)
async def get_user(
    user_id: UUID,
    service: UserService = Depends(get_user_service),
) -> UserResponse:
    user = await service.get_user(user_id)
    return UserResponse.model_validate(user)
```

禁止在路由中直接写复杂业务逻辑、SQL 查询、第三方 API 编排或事务控制。

---

## 4. Pydantic Schema 规范

请求模型和响应模型应分离：

```python
class CreateUserRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    email: EmailStr


class UserResponse(BaseModel):
    id: UUID
    name: str
    email: EmailStr
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)
```

要求：

- 字符串字段应设置长度限制。
- 列表字段应设置最大数量。
- 金额使用 `Decimal`，不要使用 `float`。
- 时间使用 timezone-aware `datetime`。
- ID 优先使用 `UUID` 或明确的整数类型。
- 响应模型必须显式列出可返回字段，避免泄露内部字段。

对于内部服务或高频读取接口，可以谨慎使用 `from_attributes` 降低转换成本，但仍必须显式定义响应字段。

---

## 5. Service 层规范

Service 层负责业务逻辑，不处理 HTTP 细节：

```python
class UserService:
    def __init__(self, user_repository: UserRepository):
        self.user_repository = user_repository

    async def create_user(self, request: CreateUserRequest) -> User:
        existing_user = await self.user_repository.get_by_email(request.email)
        if existing_user:
            raise EmailAlreadyExistsError(request.email)

        user = User(name=request.name, email=request.email)
        return await self.user_repository.create(user)
```

要求：

- 不要在 service 中抛 `HTTPException`。
- 不要在 service 中依赖 FastAPI 的 `Request` 或 `Response`。
- Service 方法命名应表达业务意图。
- 复杂流程可以拆成私有方法，但不要为了形式过度拆分。
- Service 应尽量可被 API、CLI、后台任务复用。

---

## 6. SQLAlchemy Session 与依赖注入

推荐使用 `async_sessionmaker` 管理 session：

```python
engine = create_async_engine(
    settings.database_url,
    pool_size=10,
    max_overflow=20,
    pool_timeout=30,
    pool_pre_ping=True,
)

AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    expire_on_commit=False,
)
```

请求级 session 依赖：

```python
async def get_db_session() -> AsyncIterator[AsyncSession]:
    async with AsyncSessionLocal() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()
```

Service 依赖示例：

```python
async def get_user_service(
    session: AsyncSession = Depends(get_db_session),
) -> UserService:
    repository = UserRepository(session)
    return UserService(repository)
```

要求：

- 每个请求使用独立 session。
- 不要把 session 存成全局可变对象。
- 不要跨请求复用 session。
- 不要在多个不相关函数中隐式 commit。
- 连接池大小应结合服务并发、数据库容量和部署副本数评估。

连接池默认建议：

- 小型服务：`pool_size=5-10`，`max_overflow=10-20`
- 中型服务：`pool_size=10-20`，`max_overflow=20-40`
- `pool_timeout` 建议 30 秒以内
- 生产环境建议开启 `pool_pre_ping=True`

实际值必须结合数据库最大连接数、服务副本数和峰值并发调整。

---

## 7. 事务规范

事务边界应由业务用例决定，通常放在 service 层。

轻量推荐：

```python
async def create_order(self, request: CreateOrderRequest) -> Order:
    async with self.session.begin():
        order = await self.order_repository.create(request)
        await self.inventory_repository.reserve(order.items)
        return order
```

复杂项目可以引入 Unit of Work：

```python
async def create_order(self, request: CreateOrderRequest) -> Order:
    async with self.unit_of_work.transaction():
        order = await self.order_repository.create(request)
        await self.inventory_service.reserve(order.items)
        return order
```

要求：

- 一个业务用例应有一个清晰事务边界。
- 外部 HTTP 调用不应放在数据库事务中长期阻塞。
- 重试逻辑必须考虑幂等性。
- 不要在 repository 中随意 commit。
- 需要保证一致性的多个数据库操作必须放在同一事务中。

---

## 8. 统一错误处理

定义业务异常基类：

```python
class AppError(Exception):
    code: str = "APP_ERROR"
    message: str = "Application error"
    status_code: int = 400


class UserNotFoundError(AppError):
    code = "USER_NOT_FOUND"
    message = "User not found"
    status_code = 404
```

统一处理业务异常：

```python
@app.exception_handler(AppError)
async def app_error_handler(request: Request, exc: AppError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "error": {
                "code": exc.code,
                "message": exc.message,
            },
            "request_id": request.state.request_id,
        },
    )
```

统一处理请求校验错误：

```python
@app.exception_handler(RequestValidationError)
async def validation_error_handler(
    request: Request,
    exc: RequestValidationError,
) -> JSONResponse:
    return JSONResponse(
        status_code=422,
        content={
            "error": {
                "code": "VALIDATION_ERROR",
                "message": "Invalid request parameters",
                "details": exc.errors(),
            },
            "request_id": request.state.request_id,
        },
    )
```

数据库唯一约束、外键约束等异常应转换为明确业务异常：

```python
try:
    await session.commit()
except IntegrityError as exc:
    await session.rollback()
    raise EmailAlreadyExistsError() from exc
```

第三方服务异常应包装为内部异常：

```python
class PaymentServiceUnavailableError(AppError):
    code = "PAYMENT_SERVICE_UNAVAILABLE"
    message = "Payment service is temporarily unavailable"
    status_code = 503
```

要求：

- 不要把堆栈信息返回给客户端。
- 错误码必须稳定、可搜索、可监控。
- 外部服务的非标准错误不要直接透传给前端。
- 日志应记录原始异常和关键上下文。

---

## 9. 统一响应格式

成功响应：

```json
{
  "data": {},
  "request_id": "req_xxx"
}
```

错误响应：

```json
{
  "error": {
    "code": "USER_NOT_FOUND",
    "message": "User not found"
  },
  "request_id": "req_xxx"
}
```

分页响应：

```json
{
  "data": [],
  "pagination": {
    "limit": 20,
    "offset": 0,
    "total": 100
  },
  "request_id": "req_xxx"
}
```

要求：

- API 响应结构应稳定。
- 错误码属于 API 契约，不应随意改名。
- 已发布字段不要随意删除或改变类型。

---

## 10. 中间件规范

推荐通过 middleware 处理横切逻辑：

- request_id 注入
- 访问日志
- 慢请求检测
- CORS
- 全局异常兜底
- 简单限流

request_id middleware 示例：

```python
class RequestIdMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        request_id = request.headers.get("X-Request-ID") or str(uuid4())
        request.state.request_id = request_id

        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        return response
```

推荐顺序：

1. TrustedHost / ProxyHeaders
2. CORS
3. request_id
4. 访问日志和耗时统计
5. 限流
6. 业务路由

要求：

- request_id 应贯穿日志、错误响应、外部调用 header。
- 慢请求阈值应可配置。
- middleware 中不要写复杂业务逻辑。
- 需要用户身份的权限检查应放在依赖或业务层，不应放在通用 middleware 中硬编码。

---

## 11. 日志与可观测性

推荐结构化日志，至少包含：

- `request_id`
- `method`
- `path`
- `status_code`
- `duration_ms`
- `user_id`，如果已登录
- 关键业务资源 ID

禁止记录：

- 密码
- Token
- Cookie
- API Key
- 身份证号
- 银行卡号
- 其他敏感个人信息

健康检查：

```text
GET /healthz
GET /readyz
```

指标建议：

- 请求总数
- 请求失败数
- 请求耗时
- 慢请求数量
- 数据库连接池使用率
- 外部服务调用耗时
- 后台任务失败数

复杂系统建议接入 tracing，并把 `request_id` 或 `correlation_id` 传递到下游服务。

---

## 12. 配置管理

使用 `pydantic-settings`：

```python
class Settings(BaseSettings):
    app_env: str = "local"
    database_url: str
    redis_url: str | None = None
    log_level: str = "INFO"

    model_config = SettingsConfigDict(env_file=".env")
```

配置优先级：

```text
环境变量 > .env 文件 > 默认值
```

要求：

- 生产环境只依赖环境变量或安全配置系统，不依赖 `.env` 文件。
- `.env` 不应提交到 Git。
- 必需配置缺失时应启动失败。
- 配置项必须有类型声明。
- 密钥、Token、数据库密码不得硬编码。

---

## 13. 外部服务调用

使用 `httpx.AsyncClient`，必须设置 timeout：

```python
async with httpx.AsyncClient(timeout=5.0) as client:
    response = await client.post(url, json=payload)
    response.raise_for_status()
```

要求：

- 必须设置连接、读取和总超时。
- 必须区分超时、网络错误、HTTP 错误和业务错误。
- 第三方响应必须转换为内部模型。
- 不稳定服务应有重试策略。
- 重试必须配合指数退避和抖动，避免重试风暴。
- 非幂等操作不得盲目重试，除非有幂等键或业务流水号。

推荐重试原则：

- 只重试网络抖动、超时、`429`、部分 `5xx`。
- 不重试 `400`、`401`、`403`、业务校验失败。
- 设置最大重试次数和总耗时预算。

---

## 14. 异步编程规范

禁止在 `async def` 中直接调用：

- `time.sleep`
- `requests`
- 同步数据库驱动
- 大文件同步读写
- 大量 CPU 密集型计算

阻塞操作应放到线程池：

```python
result = await asyncio.to_thread(blocking_function, arg1, arg2)
```

或：

```python
result = await anyio.to_thread.run_sync(blocking_function, arg1, arg2)
```

并发控制示例：

```python
semaphore = asyncio.Semaphore(10)

async def limited_call(item: Item) -> Result:
    async with semaphore:
        return await client.call(item)

results = await asyncio.gather(*(limited_call(item) for item in items))
```

要求：

- `asyncio.gather` 批量并发必须有数量上限。
- 外部 IO 必须有 timeout。
- CPU 密集型任务应交给 worker 或独立服务。
- 建议在 CI 中启用 `ruff` 的异步相关规则，例如 `ASYNC`。

---

## 15. 后台任务与优雅停机

FastAPI `BackgroundTasks` 只适合轻量任务：

- 简单通知
- 非关键日志
- 短耗时异步动作

以下场景不应只依赖 `BackgroundTasks`：

- 长时间任务
- 必须成功的业务流程
- 需要重试、死信队列或任务状态追踪的任务
- 批处理任务

按复杂度选择方案：

- 1-3 个轻量任务：`BackgroundTasks`
- 中等复杂度：Redis 队列加后台消费者
- 高可靠任务：Celery、Arq、Dramatiq、RQ 或消息队列

优雅停机要求：

- 收到 `SIGTERM` 后停止接收新请求。
- 给进行中的请求和任务预留合理完成时间。
- 关闭数据库连接池、HTTP client、消息队列连接。
- 长任务应支持中断、续跑或补偿。

---

## 16. 安全规范

必须做到：

- 所有接口明确鉴权策略。
- 权限检查基于用户、角色、资源关系。
- 文件上传限制大小、类型、后缀和存储路径。
- 登录、注册、验证码、搜索等接口应限流。
- CORS 只允许可信域名。
- 密码使用 `bcrypt`、`argon2` 等安全哈希算法。
- 敏感操作记录审计日志。
- 错误信息避免暴露账号是否存在等敏感状态。

限流方案可按项目复杂度选择：

- 单进程小服务：进程内限流
- 多副本服务：Redis 限流
- 网关统一入口：网关限流
- FastAPI 可评估 `slowapi` 或自研 Redis middleware

---

## 17. 幂等性规范

以下场景必须考虑幂等：

- 创建订单
- 支付回调
- 消息消费
- 文件导入
- 扣减库存
- 发放权益
- 第三方回调

常用方式：

- `Idempotency-Key`
- 数据库唯一约束
- 业务流水号
- 状态机约束
- 去重表

要求：

- 重试不得造成重复扣款、重复发货、重复发消息。
- 幂等逻辑必须有测试覆盖。
- 幂等键应有过期策略或归档策略。

---

## 18. 分页、排序与查询

默认分页：

```text
limit: 默认 20，最大 100
offset: 默认 0
```

大数据量推荐游标分页：

```text
cursor
limit
```

要求：

- 列表接口必须分页。
- `limit` 必须设置最大值。
- 排序字段必须白名单校验。
- 过滤条件必须限制复杂度。
- 高频列表接口必须关注索引和执行计划。

---

## 19. 数据库迁移规范

使用 Alembic 管理迁移。

要求：

- 每个 schema 变更必须有 migration。
- migration 文件必须人工 review。
- 生产大表变更必须评估锁表风险。
- 删除字段、改字段类型需分阶段发布。
- migration 必须在测试环境验证。

危险操作：

- 直接删除列。
- 直接重命名列。
- 大表添加非空无默认字段。
- 大表创建索引但未使用并发方式。
- 修改高频访问字段类型。
- 在迁移中执行不可控的大量数据更新。

推荐分阶段变更：

1. 添加新字段，允许为空。
2. 应用双写或兼容读取。
3. 后台回填数据。
4. 切换读取逻辑。
5. 删除旧字段或旧逻辑。

---

## 20. 测试规范

测试分层：

- 单元测试：service、工具函数、业务规则。
- 集成测试：API、数据库、外部依赖 mock。
- E2E 测试：核心用户流程。

推荐目录：

```text
tests/
  conftest.py
  factories/
    user_factory.py
  unit/
  integration/
  e2e/
```

数据库 fixture 示例：

```python
@pytest.fixture
async def db_session() -> AsyncIterator[AsyncSession]:
    async with TestingSessionLocal() as session:
        async with session.begin():
            yield session
            await session.rollback()
```

测试数据推荐使用 factory：

```python
def build_user(**overrides: Any) -> User:
    data = {
        "id": uuid4(),
        "name": "Test User",
        "email": "test@example.com",
    }
    data.update(overrides)
    return User(**data)
```

要求：

- 核心业务逻辑必须有单元测试。
- Bug 修复必须补回归测试。
- API 测试覆盖成功、失败、权限不足、参数错误。
- 外部服务调用必须 mock。
- 数据库测试应使用独立测试库，并通过事务回滚或 truncate 隔离数据。

测试命名：

```python
def test_create_user_should_fail_when_email_already_exists():
    ...
```

---

## 21. 类型标注与代码风格

统一使用：

```bash
ruff check .
black --check .
mypy .
pytest
```

命名规范：

- 函数、变量：`snake_case`
- 类名：`PascalCase`
- 常量：`UPPER_SNAKE_CASE`
- 私有方法：`_private_method`

要求：

- 公共函数必须标注参数和返回值。
- Service、Repository、Client 方法必须标注返回值。
- 禁止使用 `Any` 作为返回类型，除非是框架集成边界，并写明原因。
- 复杂 `dict` 应定义 Pydantic 模型、`TypedDict` 或 dataclass。
- 不要留下死代码、调试日志和无意义注释。

---

## 22. CI 与提交规范

每个 PR 至少执行：

```bash
ruff check .
black --check .
mypy .
pytest
```

可选：

```bash
bandit -r src
pip-audit
alembic check
```

提交信息推荐 Conventional Commits：

```text
feat: add user creation API
fix: handle payment callback idempotency
refactor: simplify user service
test: add order API integration tests
docs: update backend coding standards
```

要求：

- CI 不通过不得合并。
- 不允许跳过测试直接合并。
- 一个提交只做一类事情。
- 不要提交 `.env`、密钥、临时文件。
- PR 描述应说明变更目的、测试方式和风险点。

---

## 23. 生产发布规范

发布前确认：

- CI 全部通过。
- 数据库 migration 已验证。
- 配置项已在目标环境准备。
- 关键指标和日志可观测。
- 有回滚方案。
- 涉及兼容性变更时有灰度或双写方案。
- 涉及外部依赖时有失败降级策略。

上线后观察：

- 错误率
- 请求耗时
- 慢请求
- 数据库连接池
- 外部服务调用失败率
- 后台任务失败率
- 关键业务指标

---

## 24. 小团队裁剪建议

MVP 或小团队可以先强制执行：

- Pydantic 输入校验
- 路由保持轻量
- 统一异常响应
- request_id 和请求日志
- 外部调用 timeout
- 数据库事务清晰
- 列表分页上限
- 密钥不进代码
- 核心业务测试
- CI 跑 lint 和 test

可以暂缓：

- 完整 Repository 层
- 完整 Unit of Work
- 分布式锁
- 链路追踪
- 复杂缓存
- 完整消息队列体系

但暂缓不等于永远不做。当接口开始承载真实用户、资金、权限、异步任务或多人协作时，应逐步补齐对应规范。

---

## 25. PR Review Checklist

### P0 阻断项

- 是否存在硬编码密钥、Token、密码或生产地址？
- 是否把敏感信息写入日志或错误响应？
- 是否有用户输入拼接 SQL？
- 是否存在未设置 timeout 的外部调用？
- 是否在重要写操作中缺少幂等设计？
- 是否存在不清晰的事务边界或错误 commit？
- 是否有 `except Exception: pass` 或吞异常？
- 是否破坏已发布 API 契约？
- 是否有危险数据库迁移未说明风险和回滚？

### P1 重要项

- 路由函数是否过重？
- Service 是否依赖了 FastAPI HTTP 细节？
- 响应字段是否显式可控？
- 列表接口是否有分页上限？
- 是否可能产生 N+1 查询？
- 日志是否包含 request_id 和关键上下文？
- 是否补充了必要测试？
- 类型标注是否足够支持维护？
- PR 是否混入无关改动？

### P2 建议项

- 是否可以简化抽象？
- 是否需要引入缓存、队列、限流或 tracing？
- 是否有更清晰的命名？
- 是否需要补充文档或迁移说明？
- 是否可以降低未来扩展成本？

---

## 26. 反例清单

禁止以下写法：

- 在路由函数中写大量业务逻辑。
- 直接返回 ORM 对象且不控制字段。
- 使用 `except Exception: pass`。
- 在 `async def` 中调用阻塞 IO。
- 外部 HTTP 请求不设置 timeout。
- 用户输入拼接 SQL。
- 日志打印 Token、密码、Cookie。
- 列表接口无限制返回所有数据。
- 业务异常直接暴露堆栈。
- 重要写操作没有幂等设计。
- 修改 API 字段不考虑兼容性。
- migration 自动生成后不 review。
- 为了追求架构完整而过早引入复杂抽象。

---

## 27. 最终原则

一份合格的 FastAPI 后端代码应满足：

- 输入可信之前必须先校验。
- 业务逻辑有清晰边界。
- 错误可被调用方理解，也可被工程师排查。
- 数据一致性和幂等性有明确设计。
- 线上问题能通过日志、指标和 request_id 快速定位。
- 自动化测试和 CI 能拦住常见回归。
- 架构复杂度与项目阶段匹配，不为了形式牺牲交付，也不为了速度牺牲底线。
