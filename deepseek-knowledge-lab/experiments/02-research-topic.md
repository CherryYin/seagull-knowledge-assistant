# Experiment 02: Topic Research — Deep Research Pipeline

测试 agent 的深度研究能力：搜索 PKG → 阅读 → 综合 → 产出研究报告。

## 目的

- 测试多步检索 + 阅读理解 + 结构化产出的 pipeline
- 对比不同检索策略（vector vs hybrid）对研究结果的影响
- 验证 agent 是否正确区分知识库已有知识和自身推断

## Prompt 模板

```
请对以下主题做深度研究：「{TOPIC}」

步骤：
1. 用 pkg_search 以 hybrid 模式搜索，找最相关的 5 条结果
2. 用 pkg_read_note / pkg_read_source 阅读最相关的 2-3 条
3. 对核心概念补充执行一次 pkg_search hybrid 检索，确认是否遗漏相关 Source、Note 或 Wiki
4. 综合所有发现，形成一份结构化报告：

# {TOPIC} 研究报告

## 研究概述
## 核心发现
## 知识缺口
## 结论与建议

完成后输出报告，不要写入 PKG；由用户在 Seagull 点击 “Save as Writing Document” 决定是否保存。
```

## 实验变量

| 变量 | Variant A | Variant B |
|------|-----------|-----------|
| 检索模式 | vector（语义搜索） | hybrid（语义+关键词） |
| 结果数量 | top_k=3 | top_k=8 |

## 评估维度

- [ ] 检索覆盖度：是否找到了最相关的知识
- [ ] 阅读深度：是否正确理解了关键内容
- [ ] 综合质量：发现之间的关联是否合理
- [ ] 来源引用：是否正确标注了 PKG 来源 ID
- [ ] 知识缺口识别：是否诚实标注了"不知道"的部分
