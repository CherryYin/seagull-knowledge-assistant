# Experiment 07: Research Question Design — 从缺口到可检验 RQ

把已确认的文献缺口收敛为边界清楚、可证伪且可执行的研究问题。

## 前置输入

- Experiment 06 的 Literature Survey Artifact
- 用户确认的目标缺口
- 可用数据、工具、时间和伦理约束

## Prompt 模板

```text
基于当前 Session 中已确认的 Literature Survey Artifact，为「{GAP}」设计研究问题。

1. 不重新发明文献结论；引用前一阶段的证据和缺口。
2. 生成 2-4 个候选 RQ，并检查对象、变量、比较条件、边界和可证伪性。
3. 对每个候选评估新颖性、价值、可行性、所需证据和主要混淆因素。
4. 推荐一个主 RQ，可选附带子问题或假设。
5. 输出 RQ Design Artifact，不要自动保存。
```

## 阶段产物

```markdown
## Confirmed Gap
## Candidate RQs
## Feasibility Matrix
## Selected RQ
## Subquestions or Hypotheses
## Operational Definitions
## Risks and Assumptions
## Stage Decision
```

## 完成门槛

- [ ] 主 RQ 是疑问句且可通过观察或实验回答
- [ ] 关键术语有操作性定义
- [ ] 明确成功证据与可能的反证
- [ ] 约束与混淆因素有记录
- [ ] 用户确认后才进入 Experiment 08
