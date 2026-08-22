# Experiment 05: 实验流程 → Skill + Workflow 双输出

验证通过 Harness 实验的流程，固化为 PKG Skill + Harness Workflow 配置。

## 目的

- 把 Harness 实验验证过的 agent 流程固化为可复用的资产
- 输出两部分：PKG Skill（供 PKG Action Agent 使用）+ Harness Workflow 配置（供 Harness 复现）
- 对比实验轨迹与固化后 skill 的执行效果

## 实验流程

### Phase 1：在 Harness 中设计并验证

```
在 Harness Web UI 中设计一个知识研究任务，例如：
"搜索 PKG 中关于 {topic} 的所有 notes 和 sources，
 阅读最相关的 3 条，再用 pkg_search hybrid 补充检索相关概念，
 然后输出结构化研究报告，等待用户决定是否保存。"

跑通后观察 Trajectory View，记录：
- 工具调用顺序
- 每步的输出质量
- 是否有多余步骤或遗漏
```

### Phase 2：固化为双输出

用以下 Harness prompt 让 agent 自动生成 Skill + Workflow：

```
你刚完成了一个实验流程。请根据你的 Trajectory，生成两个文件：

1. PKG Skill (Markdown 格式):
---
name: {skill-name}
description: {一句话描述}
args:
  - name: topic
    description: 研究主题
    required: true
---

## 执行步骤
1. ...
2. ...

## 输出格式
...

## 评估标准
- [ ] ...

2. Harness Workflow 配置 (YAML):
# 记录本次实验的 prompt、工具列表、参数配置

请将两者分别输出，不要写入 PKG；等待用户 review 和显式保存。
```

### Phase 3：验证固化效果

| 对比维度 | Harness 实验 | PKG Skill |
|----------|-------------|-----------|
| 工具调用数 | Trajectory View 统计 | PKG agent_runs 统计 |
| 产出质量 | 人工 review | 人工 review |
| 可复现性 | fork 同 prompt 重跑 | 不同用户调同一 skill |
| Token 消耗 | Harness usage | PKG usage |

## 双输出模板

### A. PKG Skill (.md)

```markdown
---
name: research-topic-validated
description: 经过 Harness 实验验证的深度研究流程 — 统一搜索 PKG → 综合报告
args:
  - name: topic
    description: 研究主题
    required: true
---

请对「$@」执行经过验证的深度研究流程。

## 执行步骤

1. **知识检索**：用 search_knowledge 以 hybrid 模式搜索 $@，top_k=5
2. **深度阅读**：对最相关的 2-3 条结果用 read_note / read_source 读取全文
3. **关联补检**：用 search_knowledge hybrid 搜索核心概念，补充相关 Source、Note 或 Wiki
4. **综合输出**：基于所有证据输出结构化报告：

## 研究报告

### 核心发现
- 从 PKG 中检索到的关键信息（标注来源 ID）

### 知识关联
- PKG Source、Note 或 Wiki 中已有的相关概念

### 知识缺口
- 当前 PKG 中缺失但相关的内容

### 建议行动
- 基于现有知识的下一步建议

## 约束
- 先搜 PKG，不要跳过检索
- 每项发现标注来源
- 区分「PKG 记录的事实」和「你的推断」
- 完成后等待用户在 Seagull 显式保存
```

### B. Harness Workflow 配置 (.yml)

```yaml
# Harness Workflow: research-topic-validated
# 验证日期: 2026-08-19
# 来源实验: experiments/05-experiment-to-skill.md

name: research-topic-validated
description: 经过验证的深度研究流程

model:
  provider: qwen
  name: qwen-plus
  temperature: 0.3

tools:
  - pkg_search
  - pkg_read_note
  - pkg_read_source

system_prompt: |
  你是 PKG 知识研究 agent。执行经过实验验证的深度研究流程：
  1. 先用 pkg_search 以 hybrid 模式检索
  2. 阅读最相关的 2-3 条
  3. 用 pkg_search hybrid 补充检索核心概念
  4. 输出结构化报告
  5. 等待用户 review 和显式保存

  每步标注来源，区分事实与推断。
```

## 运行方式

1. 在 Harness Web UI 中按 Phase 1 设计并跑通实验
2. 用 Phase 2 的 prompt 让 agent 生成双输出
3. 把 Skill `.md` 放到 PKG 的 `skills/` 目录
4. 把 Workflow `.yml` 放到 `deepseek-knowledge-lab/experiments/workflows/`
5. 在 PKG Web UI 中调 `/skills` 验证 skill 是否加载
6. 在 Harness 中用 fork 对比实验轨迹 vs skill 执行轨迹
