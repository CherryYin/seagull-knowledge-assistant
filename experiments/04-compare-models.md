# Experiment 04: 跨模型对比 — 同一任务不同模型

测试同一 workflow 在不同模型下的表现差异。

## 目的

- 对比 DeepSeek vs 其他模型在知识研究任务上的表现
- 验证 Harness 的模型切换能力
- 为 PKG 的模型选择提供数据支撑

## 实验设计

选取 Experiment 02 (Topic Research) 作为基准任务，固定 topic 和 prompt，
分别用以下模型跑：

| Model | Provider |
|-------|----------|
| deepseek-chat | DeepSeek |
| gpt-4o-mini | OpenAI |
| claude-3.5-haiku | Anthropic |

## 对比维度

| 维度 | 测量方式 |
|------|----------|
| 检索调用次数 | Trajectory View 统计 |
| 产出长度 | 输出 token 数 |
| 引用准确性 | 人工 review source ID 是否匹配 |
| 知识缺口诚实度 | 是否明确标注了不确定的部分 |
| 总 token 消耗 | Harness 的 usage 统计 |
| 延迟 | 运行时间 |

## 运行方式

在 dsh settings 中切换 model provider，使用相同的 prompt 分别跑三轮，
对比 Trajectory View。
