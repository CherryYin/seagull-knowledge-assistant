# Harness² newsletter 隔离试验

这是实验目录，不是已安装的 Harness 插件。它不会注册工具、修改 presets、启动服务或自动提升生产配置。

## Seagull Experiment Lab 页面

打开 `/lab` → **隔离对比实验**。原有 Skill / Workflow 功能保留在另一个标签页。
页面接入的是下述**人工候选提示词 A/B**，不是官方完整的递归自动优化器；不执行官方任意任务、编辑工具或现有 Harness Session。

1. 点击「新建 Newsletter 对比实验」：只准备提示词快照和内置虚构样例，不调用模型。
2. 查看方案、只读提示词和训练素材，设置本实验总预算（最多 2 元），点击本地预检。
3. 配置、凭据、价格、预算和状态均通过后，勾选发送素材及计费确认。仅管理员可启动使用服务器凭据的计费任务。
4. 独立进程运行 6 次训练请求。页面只轮询已有记录；关闭浏览器不会取消或重跑实验。
5. 左右比较 A/B，分别记录三组取舍和原因。评审不可覆盖；三组评审齐全后才允许单独预检和确认 2 次留出复验。留出素材在启动该阶段前不展示。
6. 复验后人工评审，显式保存当前报告为 Note。相同报告按内容指纹复用同一 Note，不覆盖用户编辑；报告变化生成新的快照 Note。保存使用当前用户经 Gateway 的正常 PKG Notes API，不直接写 PKG 数据库。页面不会自动应用提示词或发布内容。

### 服务配置

在 `bff/.env` 设置（模板见 `bff/.env.example`）：

```dotenv
HARNESS2_LAB_EXECUTION_ENABLED=true
HARNESS2_LAB_KEY_FILE=/tmp/seagull-harness2-key-XXXXXX
```

Key 文件的安全创建命令见下文。也可以使用专用环境变量 `HARNESS2_DEEPSEEK_API_KEY`，但不使用生产通用 Key，不在网页、Note 或命令行参数中填写密钥。未配置时页面仍支持准备方案、查看记录和保存报告；预检明确显示阻塞原因。配置变更仅需重启 BFF，不需要重启 PKG、Worker 或 Harness。本次开发不会自动重启任何服务或执行付费请求。

`HARNESS2_LAB_PYTHON` 默认 `python3`，仅使用 Python 标准库。默认数据目录为 Lab 所有的 `.dsh/run/harness2/`：SQLite 保存用户归属、阶段授权与状态，每个实验有独立的持久目录保存提示词、输入、调用账本、输出及评审。目录必须为服务用户所有且权限 `0700`，不提交 Git。可用 `HARNESS2_LAB_DATA_DIR` 配置绝对路径，备份或容器部署时必须持久挂载整个目录，不要清理运行中的目录；不依赖 PKG 数据库迁移。

`lab_gateway.js` 是 BFF 调用的 Lab 所有适配器；固定启动 `lab_bridge.py`，无 shell、无浏览器指定路径或可执行文件。子进程环境只传递必要路径、Lab 配置和专用凭据，不继承生产 Key、PKG 数据库连接、Harness 服务 token 或代理配置。执行是按需的独立进程，不新增常驻服务，也不是容器级沙箱。

### Gateway 合同与安全边界

所有 `/api/lab/harness2` 请求均经 Gateway 向 PKG `/auth/me` 核验当前用户；无凭据 401，跨用户 ID 404，计费启动还要求管理员。浏览器不能调用内部 worker 操作。

| 方法 | 路径（前缀 `/api/lab/harness2`） | 行为 |
| --- | --- | --- |
| GET / POST | `/` | 列表 / 新建不计费方案 |
| GET | `/{id}` | 读取输入、输出、遥测及评审，不启动模型 |
| POST | `/{id}/preflight` | `phase`、`budget_cny`；零网络预检，成功产生十分钟有效的确认凭据 |
| POST | `/{id}/start` | `preflight_id`、`confirm_send_synthetic=true`；202，确认后按需启动独立执行器 |
| POST | `/{id}/review` | `case_id`、`winner`、`reason`；仅追加人工评审 |
| POST | `/{id}/note` | 显式将当前报告保存为用户的 Note |

预检凭据绑定用户、实验、阶段、总预算、输入指纹和价格版本；启动时再次核验。SQLite 事务及唯一阶段记录拒绝重复启动，原调用器继续执行文件锁、持久预算预留与不可重跑阶段标记。总预算不能在留出阶段扩大。价格过期不会自动续期，原命令行实验和旧预算授权不会自动导入页面。

异常或结果未知均停止，不自动重试、不释放未知预算。BFF 重启不主动终止已启动的独立实验；读取状态时若发现执行进程已消失则标记中断，不恢复队列或重发模型请求。启动确认丢失时应刷新核查，不能用创建新实验来隐式重试。新实验必须单独确认新的计费授权。本地费用控制不是服务商账单硬限额。

不新增 PKG 表、API 或 Harness 工具；原 `/api/lab/*` 和 `/api/experiments/*` 转发仍保留，仅新增专属 `/api/lab/harness2` 路由。

## 当前范围

- `upstream_demo.py` 运行固定版本的官方确定性 Demo，验证递归试跑、选择和经验库的本地执行链；没有模型调用，也不验证 newsletter 质量。
- `trial.py` 准备 newsletter **单条 In Depth 提示词**的离线 A/B 材料，并登记外部提供的结果和人工取舍。它没有接入官方优化循环或 DeepSeek Harness 执行器，不是完整 pipeline 基准。
- `paid_trial.py` 是单独、显式授权的纯文本 API 调用器，固定 DeepSeek V4 Flash 非思考模式，只发送本目录提示词及内置虚构素材，不连接现有 Harness 或生产系统。`trial.py` 本身仍不联网。
- 基线通过 Python AST 只读提取现有 `_NEWSLETTER_DETAIL_SYSTEM_PROMPT`；不 import PKG，因此不加载应用配置、数据库或 `.env`。
- `candidate.md` 是人工编写的待测候选，不是 Harness² 自动优化的结果。三个训练样例和一个留出样例均为明确标记的虚构素材，不读取你的真实资料。
- 新实验的基线与候选都要求中文 `title`、`summary`、`detail` JSON，保持与 Newsletter 单条生成合同一致；已有实验保留冻结的提示词与输出，不回写、不重跑。
- 只创建系统临时目录；实验目录权限为 `0700`。没有生产配置应用、微信发布、TTS、模型自动评分或自动重试入口。付费调用必须单独执行 `paid_trial.py execute`，离线 prepare/report 和付费 plan 都不发请求。

隔离方式是限定代码路径、独立进程、精简环境变量与临时目录，**不是容器级安全沙箱**。不要用 Demo 启动器运行未经审查的上游修改，不要把真实密钥、Cookie 或原始网络响应放进结果文件。不要直接使用带有生产工具权限的现有 Harness Session 来替代独立调用器。

## 官方 Demo

官方项目：`google-research/harness2`。已审查的固定版本为 `1cfe254e8d25b15f37048c3730134686abe60335`，运行前校验版本、工作区干净且没有 `.env`。不安装 Python 依赖，不使用 PKG 的 `.venv` 或真实 HOME。只运行确定性 Demo，不启动官方真实任务执行器。父进程通过 Python audit hook 拒绝 socket 操作；这不是针对任意子进程的网络沙箱，Demo 子进程仅执行该固定版本生成的算术脚本。

从仓库根目录运行；下载仅在用户允许后进行：

```bash
CHECKOUT=$(mktemp -d /tmp/seagull-harness2-source-XXXXXX)
git clone https://github.com/google-research/harness2.git "$CHECKOUT/upstream"
git -C "$CHECKOUT/upstream" checkout --detach 1cfe254e8d25b15f37048c3730134686abe60335
python3 -I -B deepseek-knowledge-lab/experiments/harness2-newsletter/upstream_demo.py \
  --source "$CHECKOUT/upstream"
```

结果写入另一个 `seagull-harness2-demo-*` 临时目录。`editor_calls` 是本地脚本编辑器调用次数，不是 API 调用次数，也不是模型费用。

## 准备 newsletter 对比

从仓库根目录运行，不需要启动任何服务：

```bash
LAB=deepseek-knowledge-lab/experiments/harness2-newsletter
RUN=$(python3 -I -B "$LAB/trial.py" prepare)
printf '%s\n' "$RUN"
python3 -I -B "$LAB/trial.py" report --run "$RUN"
```

每个 JSON packet 包含 `messages`、`temperature=0.25`、`max_output_tokens=1200` 和 `tools=[]`。这只是任务合同，不会给现有 Harness 安装或强制施加工具禁用策略。先只使用 `train/`；完成候选调整并冻结后才使用 `holdout/`。修改候选后必须重新 prepare，不能混用不同输入或提示词的输出。固定模型 ID、参数、素材和输出上限；用量元数据若手工登记，不能视为服务商核验过的遥测。后续调用器需把输出上限翻译为服务商对应参数，不能直接假设 packet 是某个 API 的请求体。

只有完成单独授权的无工具模型试跑后，才登记真实输出。以下响应结构仅为格式示例，**不是模型结果**：

```json
{
  "text": "替换为真实模型输出",
  "model": "替换为实际使用的完整模型 ID",
  "temperature": 0.25,
  "max_output_tokens": 1200,
  "elapsed_ms": null,
  "retry_count": null,
  "input_tokens": null,
  "output_tokens": null
}
```

```bash
python3 -I -B "$LAB/trial.py" record --run "$RUN" \
  --case limited-announcement --variant baseline --response /tmp/baseline-response.json
python3 -I -B "$LAB/trial.py" record --run "$RUN" \
  --case limited-announcement --variant candidate --response /tmp/candidate-response.json
python3 -I -B "$LAB/trial.py" review --run "$RUN" \
  --case limited-announcement --winner candidate --reason '填写你实际核对后的取舍依据'
python3 -I -B "$LAB/trial.py" report --run "$RUN"
```

人工逐条核对事实、数字与限定条件；检查指令注入、无依据补写、重复、可读性，并记录达到可发表状态仍需要的修改。允许选 `baseline`、`candidate`、`tie` 或 `neither`，不以更长或更自信作为质量更好。先冻结训练样例结论，再做留出样例验证；小规模虚构样例的改善不能作为真实文章或阅读量提升的证明。

输出与人工取舍只能首次登记，不能覆盖；修正或重新采样请创建新实验。未知耗时、重试和用量保留未知，不按零统计。目录可能被操作系统清理，需要长期保留时手动备份至私人目录，不提交仓库。

## 2 元以内的独立 API 试跑

用户为本次真实 A/B 试跑授权的总预算上限为 **2 元**，不能从先前音频或 Demo 推导授权。该授权仅用于一个实验 run 的 6 次训练请求和人工复核后另行启动的 2 次留出请求，不因 prepare 新 run 自动延续。没有专用凭据时只做本地预检，不会读取生产 `.env` 或回退到 `DEEPSEEK_API_KEY`。

2026-10-20 核对的官方人民币价格采用 `deepseek-v4-flash` 缓存未命中输入 2 元／百万 token、输出 8 元／百万 token，忽略缓存和优惠的节省。官方来源保存在 `pricing.json`。价格策略在北京时间 **2026-10-21 00:00** 到期；到期必须重新核对官方价格，不能仅延长日期。

每次最多发送 16000 字节请求，输出上限 1200 token，按 65536 个输入 token 保守预留：训练阶段 0.844032 元，全部 8 次预留 1.125376 元。该输入预留是工程安全余量，不是精确分词结果；价格估算和本地预算控制**不是服务商账单硬限额**。成功响应必须包含有效用量且不超过预留，才释放多余预留。实际费用以服务商账单为准，模型返回的 token 用量不等于账单验证。

```bash
python3 -I -B "$LAB/paid_trial.py" plan --run "$RUN" --budget-cny 2 --phase train
```

仅支持专用环境变量 `HARNESS2_DEEPSEEK_API_KEY`，或显式传入本人所有、权限 `0600` 的 `/tmp/seagull-harness2-key-*` 文件。不要把 Key 发到聊天里。若需要让执行中的 Codex 使用该 Key，可在你自己的终端创建私人临时文件，只提供文件路径；在另一个终端 export 不会改变已经运行的 Codex 进程环境。

```bash
KEYFILE=$(mktemp /tmp/seagull-harness2-key-XXXXXX)
read -rsp '独立试验 API Key: ' TRIAL_KEY; printf '\n'
printf '%s' "$TRIAL_KEY" > "$KEYFILE"; unset TRIAL_KEY
printf '%s\n' "$KEYFILE"
```

确认预算和文本发送后才执行，CLI 没有明文 Key 参数：

```bash
python3 -I -B "$LAB/paid_trial.py" execute --run "$RUN" --budget-cny 2 \
  --phase train --confirm-send-synthetic --key-file "$KEYFILE"
python3 -I -B "$LAB/trial.py" report --run "$RUN"
```

调用器只 POST 到固定 HTTPS `api.deepseek.com/chat/completions`，关闭环境代理、不跟随重定向、不上传附件，不发送工具定义，不执行模型返回的工具调用。按原样记录模型正文、耗时和选定 token 数，不保存 Key、Authorization 或原始错误响应。

每个阶段只能启动一次。文件锁拒绝并发，计费请求前先 fsync 预算预留账本；请求超时、进程中断、响应缺失用量、模型不符、截断、工具调用或写入异常都会停止，不自动重试，不继续发送后续请求。没有结果的预留以及已标为结果未知的调用会锁定整个 run，不能靠重跑、补一个零费用或开始留出阶段解除。必须先核查服务商记录，也不能把新建 run 当成原有 2 元授权的自动续费。

训练阶段完成后，必须分别登记三个样例的人工取舍；保持候选和输入不变，才可用同一 run 的剩余预算单独启动留出测试：

```bash
python3 -I -B "$LAB/paid_trial.py" execute --run "$RUN" --budget-cny 2 \
  --phase holdout --confirm-send-synthetic --key-file "$KEYFILE"
```

当前代码和安全测试不构成真实效果验证；只有生成了真实模型输出、完成逐项复核后，才能讨论候选是否更好。没有自动提升到生产的入口。

## 验证

```bash
python3 -I -B -m unittest discover \
  -s deepseek-knowledge-lab/experiments/harness2-newsletter -p 'test_*.py' -v
```

测试覆盖零网络／子进程的离线流程、只读提示词提取、训练／留出分开、用量未知与零、模型与参数一致性、不可覆盖记录，以及生产路径、路径穿越、符号链接、提示词篡改、上游版本变化和 `.env` 的拒绝分支。

付费调用器使用纯模拟 transport 测试预算上限、价格过期、专用凭据和显式授权、用量未知／超界、截断／工具调用／模型不符、持久化预留、失败无重试、阶段不可重跑、留出人工复核门槛、重定向拒绝和凭据不落盘。单元测试不会发起真实 API 请求，模拟 token 数和费用不代表真实模型测试结果。
