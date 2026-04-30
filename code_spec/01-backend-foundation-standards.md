# 后端底座工程编码规范

> 适用场景：FastAPI / Python 后端服务的基础工程规范  
> 定位：为 AI 应用、业务 API、后台任务、管理端接口提供稳定底座  
> 核心目标：让服务可维护、可测试、可观测、可发布、可回滚

---

## 1. 执行等级

### P0 必须遵守

- 不得硬编码密钥、Token、数据库地址、生产配置。
- 所有外部输入必须校验。
- API 错误响应必须统一，不得暴露堆栈。
- 数据库事务边界必须清晰。
- 外部 HTTP 调用必须设置 timeout。
- 日志不得记录敏感信息。
- 数据库 schema 变更必须有 migration。
- CI 必须通过 lint、format、test。

### P1 强烈推荐

- 路由、业务逻辑、数据访问保持清晰分层。
- Service 层不依赖 FastAPI HTTP 细节。
- 使用结构化日志和 request_id。
- 公共函数、Service、Repository、Client 方法必须有类型标注。
- 核心业务逻辑必须有测试。

### P2 按需采用

- Repository 层。
- Unit of Work。
- 链路追踪。
- 分布式锁。
- 消息队列。
- 复杂缓存策略。

---

## 2. 推荐项目结构

```text
src/
  app/
    main.py
    api/
      v1/
        routers/
        dependencies.py
    core/
      config.py
      logging.py
      middleware.py
      exceptions.py
      security.py
    schemas/
    models/
    services/
    repositories/
    clients/
    db/
      session.py
      migrations/
    tasks/
    utils/
tests/
  unit/
  integration/
  e2e/
```

职责边界：

- `api`：HTTP 路由、参数解析、依赖注入、响应转换。
- `schemas`：请求和响应模型。
- `services`：业务规则和用例编排。
- `repositories`：数据库访问。
- `clients`：外部系统调用。
- `core`：配置、日志、中间件、异常、安全基础能力。

Repository 不是所有项目的硬性要求。简单 CRUD 服务可以让 service 直接使用 `AsyncSession`，但必须保持数据访问逻辑和业务规则边界清楚。

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

## 4. Schema 与输入校验

请求模型、响应模型、ORM 模型应分离：

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

- 字符串字段设置长度限制。
- 列表字段设置最大数量。
- 金额使用 `Decimal`，不要使用 `float`。
- 时间使用 timezone-aware `datetime`。
- 响应模型显式列出可返回字段，避免泄露内部字段。

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

- 不在 service 中抛 `HTTPException`。
- 不在 service 中依赖 `Request` 或 `Response`。
- Service 方法命名表达业务意图。
- Service 应能被 API、CLI、后台任务复用。

---

## 6. Session 与依赖注入

推荐使用 `async_sessionmaker`：

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

要求：

- 每个请求使用独立 session。
- 不跨请求复用 session。
- 不把 session 存成全局可变对象。
- 不在 repository 中随意 commit。
- 连接池大小必须结合数据库最大连接数、服务副本数和峰值并发评估。

---

## 7. 事务规范

轻量推荐：

```python
async def create_order(self, request: CreateOrderRequest) -> Order:
    async with self.session.begin():
        order = await self.order_repository.create(request)
        await self.inventory_repository.reserve(order.items)
        return order
```

要求：

- 一个业务用例对应一个清晰事务边界。
- 外部 HTTP 调用不应放在数据库事务中长期阻塞。
- 重试逻辑必须考虑幂等性。
- 需要保证一致性的多个数据库操作必须放在同一事务中。

复杂项目可以引入 Unit of Work，但不要为了形式过早引入复杂抽象。

---

## 8. 统一异常处理

业务异常：

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

统一处理：

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

要求：

- `RequestValidationError` 统一格式化。
- `IntegrityError` 转换为明确业务异常。
- 第三方服务异常包装为内部异常。
- 不把 Python 堆栈返回给客户端。
- 错误码稳定、可搜索、可监控。

---

## 9. 中间件规范

推荐 middleware 处理横切逻辑：

- request_id 注入。
- 请求日志。
- 慢请求检测。
- CORS。
- 简单限流。
- 全局异常兜底。

推荐顺序：

1. TrustedHost / ProxyHeaders
2. CORS
3. request_id
4. 访问日志和耗时统计
5. 限流
6. 业务路由

要求：

- request_id 贯穿日志、错误响应、外部调用 header。
- middleware 中不写复杂业务逻辑。
- 权限检查不要硬编码在通用 middleware 中。

---

## 10. 日志与可观测性

请求日志至少包含：

- `request_id`
- `method`
- `path`
- `status_code`
- `duration_ms`
- `user_id`
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

建议监控：

- 请求总数、失败数、耗时。
- 慢请求数量。
- 数据库连接池使用率。
- 外部服务调用耗时。
- 后台任务失败数。

---

## 11. 配置管理

配置优先级：

```text
环境变量 > .env 文件 > 默认值
```

要求：

- 生产环境只依赖环境变量或安全配置系统，不依赖 `.env`。
- `.env` 不提交到 Git。
- 必需配置缺失时启动失败。
- 配置项有类型声明。
- 密钥不得硬编码。

---

## 12. 外部调用

使用异步 HTTP client，并设置 timeout：

```python
async with httpx.AsyncClient(timeout=5.0) as client:
    response = await client.post(url, json=payload)
    response.raise_for_status()
```

要求：

- 区分超时、网络错误、HTTP 错误、业务错误。
- 第三方响应转换为内部模型。
- 重试使用指数退避和抖动。
- 非幂等操作不得盲目重试。

---

## 13. 异步与并发

禁止在 `async def` 中直接调用：

- `time.sleep`
- `requests`
- 同步数据库驱动
- 大文件同步读写
- 大量 CPU 密集型计算

阻塞操作放到线程池：

```python
result = await asyncio.to_thread(blocking_function, arg1, arg2)
```

并发必须有限制：

```python
semaphore = asyncio.Semaphore(10)

async def limited_call(item: Item) -> Result:
    async with semaphore:
        return await client.call(item)
```

要求：

- `asyncio.gather` 批量并发必须有数量上限。
- 外部 IO 必须有 timeout。
- CPU 密集型任务交给 worker 或独立服务。

---

## 14. 数据库迁移

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

---

## 15. 测试规范

推荐目录：

```text
tests/
  conftest.py
  factories/
  unit/
  integration/
  e2e/
```

要求：

- 核心业务逻辑必须有单元测试。
- Bug 修复必须补回归测试。
- API 测试覆盖成功、失败、权限不足、参数错误。
- 外部服务调用必须 mock。
- 数据库测试使用独立测试库，并通过事务回滚或 truncate 隔离数据。

---

## 16. CI 与提交

每个 PR 至少执行：

```bash
ruff check .
black --check .
mypy .
pytest
```

提交信息推荐：

```text
feat: add user creation API
fix: handle payment callback idempotency
refactor: simplify user service
test: add order API integration tests
docs: update backend coding standards
```

要求：

- CI 不通过不得合并。
- 一个提交只做一类事情。
- 不提交 `.env`、密钥、临时文件。
- PR 描述说明变更目的、测试方式和风险点。

---

## 17. 最终原则

合格的后端底座应满足：

- 输入可信之前必须先校验。
- 业务逻辑有清晰边界。
- 错误可被调用方理解，也可被工程师排查。
- 数据一致性和幂等性有明确设计。
- 线上问题能通过日志、指标和 request_id 快速定位。
- 自动化测试和 CI 能拦住常见回归。
- 架构复杂度与项目阶段匹配。
