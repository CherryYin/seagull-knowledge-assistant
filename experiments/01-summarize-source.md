# Experiment 01: Source Summarization A/B

对比不同 prompt 策略对同一知识源的总结质量。

## 目的

- 测试 agent 从 PKG 检索 source → 阅读理解 → 产出 summary 的完整管道
- 对比两种 prompt 策略：结构导向 vs 自由探索
- 通过 Harness 的 Trajectory View 对比工具调用路径和产出质量

## 实验变量

| 变量 | Variant A | Variant B |
|------|-----------|-----------|
| Prompt 策略 | 结构化五段式 | 自由探索式 |
| 输出格式 | 固定 sections | 自然段落 |

## Variant A — 结构化总结

```
请从我的 PKG 知识库中找一份最近导入的 source，用 pkg_list_sources 浏览，
再用 pkg_read_source 阅读完整内容。然后按以下结构输出总结：

## Summary
## Key Ideas
## Related Knowledge
## Questions
## Recommended Actions

完成后用 pkg_save_note 将总结保存为笔记。
```

## Variant B — 自由探索

```
浏览我的知识库，找到一份你觉得有意思的 source。仔细阅读它，然后用自己的方式
写一份总结，重点放在你觉得最重要的发现上。格式不限。完成后保存为笔记。
```

## 评估维度

- [ ] 覆盖度：关键信息是否遗漏
- [ ] 结构质量：输出是否清晰可读
- [ ] 关联能力：是否正确引用了 PKG 中已有知识
- [ ] 工具调用效率：检索/阅读步骤是否合理
- [ ] 保存是否成功：note 是否正确写回 PKG

## 运行方式

在 dsh Web UI 中分别用 Variant A 和 Variant B 的 prompt 启动 agent，
对比两次运行的 Trajectory View。
