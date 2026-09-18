# Experiment 10: Paper Drafting — 从证据到可审阅草稿

把同一 Harness Session 中已确认的研究产物组装成论文草稿，不补造引用或实验结果。

## 前置输入

- Literature Survey Artifact
- RQ Design Artifact
- Experiment Protocol Artifact
- Evaluation Artifact
- 目标稿件类型与受众

## Prompt 模板

```text
基于当前 Session 的四类已确认 Artifact 起草「{TITLE_OR_TOPIC}」。

1. 先建立 claim-evidence outline，确保每个主要论点能追溯到 PKG 对象或实验 run。
2. 缺失引用、统计量或实验细节用 TODO 标记，不得编造。
3. 区分相关工作中的外部主张、实验观察和作者解释。
4. 生成可审阅的 Markdown 草稿；只有用户要求时才转换为 LaTeX。
5. 输出保存建议，但不自动写入 PKG。
```

## 阶段产物

```markdown
## Claim-Evidence Outline
## Title and Abstract
## Introduction
## Related Work
## Method
## Results
## Discussion
## Limitations
## Conclusion
## References and TODOs
## Save or Publish Recommendation
```

## 完成门槛

- [ ] 主要 claim 可追溯到 Source/Note/Wiki ID 或 run ledger
- [ ] 未验证内容和缺失引用以 TODO 明示
- [ ] Results 与 Discussion 分离
- [ ] Limitations 不被省略
- [ ] 最终稿由用户通过 Seagull 显式保存为 Writing Document 或 Review Note
