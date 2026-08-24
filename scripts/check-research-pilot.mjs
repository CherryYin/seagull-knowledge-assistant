import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const labRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function source(path) {
  return readFile(resolve(labRoot, path), 'utf8')
}

function includesAll(value, path, markers) {
  for (const marker of markers) {
    assert.ok(value.includes(marker), `${path} is missing Research Pilot marker: ${marker}`)
  }
}

const stages = [
  {
    file: 'experiments/06-literature-survey.md',
    name: 'Literature Survey',
    sections: [
      '## Scope',
      '## Search Log',
      '## Evidence Map',
      '## Consensus',
      '## Conflicts',
      '## Method Gaps',
      '## Candidate Research Gaps',
      '## Sources Consulted',
      '## Stage Decision',
    ],
  },
  {
    file: 'experiments/07-rq-design.md',
    name: 'RQ Design',
    sections: [
      '## Confirmed Gap',
      '## Candidate RQs',
      '## Feasibility Matrix',
      '## Selected RQ',
      '## Subquestions or Hypotheses',
      '## Operational Definitions',
      '## Risks and Assumptions',
      '## Stage Decision',
    ],
  },
  {
    file: 'experiments/08-experiment-design.md',
    name: 'Experiment Design',
    sections: [
      '## Research Question',
      '## Experimental Units',
      '## Methods and Baselines',
      '## Experiment Matrix',
      '## Metrics and Rubric',
      '## Data and Sampling',
      '## Reproducibility Controls',
      '## Failure and Stop Conditions',
      '## Execution Checklist',
      '## Stage Decision',
    ],
  },
  {
    file: 'experiments/09-execute-evaluate.md',
    name: 'Execute and Evaluate',
    sections: [
      '## Protocol Version',
      '## Run Ledger',
      '## Deviations',
      '## Metric Results',
      '## Qualitative Findings',
      '## Error Analysis',
      '## RQ Answer',
      '## Threats to Validity',
      '## Reproduction Notes',
      '## Stage Decision',
    ],
  },
  {
    file: 'experiments/10-paper-drafting.md',
    name: 'Paper Drafting',
    sections: [
      '## Claim-Evidence Outline',
      '## Title and Abstract',
      '## Introduction',
      '## Related Work',
      '## Method',
      '## Results',
      '## Discussion',
      '## Limitations',
      '## Conclusion',
      '## References and TODOs',
      '## Save or Publish Recommendation',
    ],
  },
]

export async function checkResearchPilot() {
  const preset = await source('.dsh/.agent-presets/research-pilot/preset.yml')
  const agent = await source('.dsh/.agent-presets/research-pilot/agent.cordis.yml')
  const skill = await source('.dsh/.agent-presets/research-pilot/skills/research-pilot.md')

  includesAll(preset, '.dsh/.agent-presets/research-pilot/preset.yml', [
    'name: 研究课题驾驶舱',
    'order: 65',
  ])
  includesAll(agent, '.dsh/.agent-presets/research-pilot/agent.cordis.yml', [
    'skill 工具加载 research-pilot',
    '用户确认后才能进入下一阶段',
    '不得自动写入 PKG',
  ])
  includesAll(skill, '.dsh/.agent-presets/research-pilot/skills/research-pilot.md', [
    'Treat the current Harness Session as the Research Dossier',
    'Advance only after the current stage meets its gate and the user confirms.',
    'Gate status: `blocked`, `ready_for_review`, or `confirmed`',
    'Explicit reminder that no PKG write occurred',
  ])

  for (const [index, stage] of stages.entries()) {
    const experiment = await source(stage.file)
    includesAll(skill, '.dsh/.agent-presets/research-pilot/skills/research-pilot.md', [
      `### ${index + 1}. ${stage.name}`,
      ...stage.sections,
    ])
    includesAll(experiment, stage.file, [
      ...stage.sections,
      '## 完成门槛',
      '用户',
    ])
  }

  return { stages: stages.length, checkedFiles: stages.length + 3 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkResearchPilot()
  console.log(JSON.stringify({ ok: true, ...result }))
}
