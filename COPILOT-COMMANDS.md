# 📋 Copy-paste commands

Every block below is self-contained: paste it into a terminal **inside the project you want to set up**.

It copies files out of `github/awesome-copilot` into `.github/`. No auth, no tools beyond `curl`.


## CORE — the 14 essentials

<sub>14 items · 50 files</sub>

```bash
B=https://raw.githubusercontent.com/github/awesome-copilot/main
mkdir -p .github/agents .github/instructions .github/skills

curl -fsSL -o .github/agents/software-engineer-agent-v1.agent.md $B/agents/software-engineer-agent-v1.agent.md
curl -fsSL -o .github/agents/principal-software-engineer.agent.md $B/agents/principal-software-engineer.agent.md
curl -fsSL -o .github/agents/swe-subagent.agent.md $B/agents/swe-subagent.agent.md
curl -fsSL -o .github/agents/debug.agent.md $B/agents/debug.agent.md
curl -fsSL -o .github/agents/critical-thinking.agent.md $B/agents/critical-thinking.agent.md
curl -fsSL -o .github/instructions/security-and-owasp.instructions.md $B/instructions/security-and-owasp.instructions.md
curl -fsSL -o .github/instructions/code-review-generic.instructions.md $B/instructions/code-review-generic.instructions.md
curl -fsSL -o .github/instructions/self-explanatory-code-commenting.instructions.md $B/instructions/self-explanatory-code-commenting.instructions.md
curl -fsSL -o .github/instructions/taming-copilot.instructions.md $B/instructions/taming-copilot.instructions.md
curl -fsSL -o .github/instructions/spec-driven-workflow-v1.instructions.md $B/instructions/spec-driven-workflow-v1.instructions.md
mkdir -p .github/skills/quality-playbook .github/skills/quality-playbook/agents .github/skills/quality-playbook/phase_prompts .github/skills/quality-playbook/references
curl -fsSL -o .github/skills/quality-playbook/LICENSE.txt $B/skills/quality-playbook/LICENSE.txt
curl -fsSL -o .github/skills/quality-playbook/SKILL.md $B/skills/quality-playbook/SKILL.md
curl -fsSL -o .github/skills/quality-playbook/agents/calibration_orchestrator.md $B/skills/quality-playbook/agents/calibration_orchestrator.md
curl -fsSL -o .github/skills/quality-playbook/agents/quality-playbook-claude.agent.md $B/skills/quality-playbook/agents/quality-playbook-claude.agent.md
curl -fsSL -o .github/skills/quality-playbook/agents/quality-playbook.agent.md $B/skills/quality-playbook/agents/quality-playbook.agent.md
curl -fsSL -o .github/skills/quality-playbook/phase_prompts/README.md $B/skills/quality-playbook/phase_prompts/README.md
curl -fsSL -o .github/skills/quality-playbook/phase_prompts/iteration.md $B/skills/quality-playbook/phase_prompts/iteration.md
curl -fsSL -o .github/skills/quality-playbook/phase_prompts/phase1.md $B/skills/quality-playbook/phase_prompts/phase1.md
curl -fsSL -o .github/skills/quality-playbook/phase_prompts/phase2.md $B/skills/quality-playbook/phase_prompts/phase2.md
curl -fsSL -o .github/skills/quality-playbook/phase_prompts/phase3.md $B/skills/quality-playbook/phase_prompts/phase3.md
curl -fsSL -o .github/skills/quality-playbook/phase_prompts/phase4.md $B/skills/quality-playbook/phase_prompts/phase4.md
curl -fsSL -o .github/skills/quality-playbook/phase_prompts/phase5.md $B/skills/quality-playbook/phase_prompts/phase5.md
curl -fsSL -o .github/skills/quality-playbook/phase_prompts/phase6.md $B/skills/quality-playbook/phase_prompts/phase6.md
curl -fsSL -o .github/skills/quality-playbook/phase_prompts/single_pass.md $B/skills/quality-playbook/phase_prompts/single_pass.md
curl -fsSL -o .github/skills/quality-playbook/quality_gate.py $B/skills/quality-playbook/quality_gate.py
curl -fsSL -o .github/skills/quality-playbook/references/challenge_gate.md $B/skills/quality-playbook/references/challenge_gate.md
curl -fsSL -o .github/skills/quality-playbook/references/code-only-mode.md $B/skills/quality-playbook/references/code-only-mode.md
curl -fsSL -o .github/skills/quality-playbook/references/constitution.md $B/skills/quality-playbook/references/constitution.md
curl -fsSL -o .github/skills/quality-playbook/references/defensive_patterns.md $B/skills/quality-playbook/references/defensive_patterns.md
curl -fsSL -o .github/skills/quality-playbook/references/exploration_patterns.md $B/skills/quality-playbook/references/exploration_patterns.md
curl -fsSL -o .github/skills/quality-playbook/references/functional_tests.md $B/skills/quality-playbook/references/functional_tests.md
curl -fsSL -o .github/skills/quality-playbook/references/iteration.md $B/skills/quality-playbook/references/iteration.md
curl -fsSL -o .github/skills/quality-playbook/references/orchestrator_protocol.md $B/skills/quality-playbook/references/orchestrator_protocol.md
curl -fsSL -o .github/skills/quality-playbook/references/requirements_pipeline.md $B/skills/quality-playbook/references/requirements_pipeline.md
curl -fsSL -o .github/skills/quality-playbook/references/requirements_refinement.md $B/skills/quality-playbook/references/requirements_refinement.md
curl -fsSL -o .github/skills/quality-playbook/references/requirements_review.md $B/skills/quality-playbook/references/requirements_review.md
curl -fsSL -o .github/skills/quality-playbook/references/review_protocols.md $B/skills/quality-playbook/references/review_protocols.md
curl -fsSL -o .github/skills/quality-playbook/references/run_state_schema.md $B/skills/quality-playbook/references/run_state_schema.md
curl -fsSL -o .github/skills/quality-playbook/references/schema_mapping.md $B/skills/quality-playbook/references/schema_mapping.md
curl -fsSL -o .github/skills/quality-playbook/references/spec_audit.md $B/skills/quality-playbook/references/spec_audit.md
curl -fsSL -o .github/skills/quality-playbook/references/verification.md $B/skills/quality-playbook/references/verification.md
mkdir -p .github/skills/security-review .github/skills/security-review/references
curl -fsSL -o .github/skills/security-review/SKILL.md $B/skills/security-review/SKILL.md
curl -fsSL -o .github/skills/security-review/references/language-patterns.md $B/skills/security-review/references/language-patterns.md
curl -fsSL -o .github/skills/security-review/references/report-format.md $B/skills/security-review/references/report-format.md
curl -fsSL -o .github/skills/security-review/references/secret-patterns.md $B/skills/security-review/references/secret-patterns.md
curl -fsSL -o .github/skills/security-review/references/vuln-categories.md $B/skills/security-review/references/vuln-categories.md
curl -fsSL -o .github/skills/security-review/references/vulnerable-packages.md $B/skills/security-review/references/vulnerable-packages.md
mkdir -p .github/skills/doublecheck .github/skills/doublecheck/assets
curl -fsSL -o .github/skills/doublecheck/SKILL.md $B/skills/doublecheck/SKILL.md
curl -fsSL -o .github/skills/doublecheck/assets/verification-report-template.md $B/skills/doublecheck/assets/verification-report-template.md
mkdir -p .github/skills/conventional-commit
curl -fsSL -o .github/skills/conventional-commit/SKILL.md $B/skills/conventional-commit/SKILL.md
```


## CODING — write, refactor, debug, TDD

<sub>30 items · 42 files</sub>

```bash
B=https://raw.githubusercontent.com/github/awesome-copilot/main
mkdir -p .github/agents .github/instructions .github/skills

curl -fsSL -o .github/agents/software-engineer-agent-v1.agent.md $B/agents/software-engineer-agent-v1.agent.md
curl -fsSL -o .github/agents/blueprint-mode.agent.md $B/agents/blueprint-mode.agent.md
curl -fsSL -o .github/agents/swe-subagent.agent.md $B/agents/swe-subagent.agent.md
curl -fsSL -o .github/agents/qa-subagent.agent.md $B/agents/qa-subagent.agent.md
curl -fsSL -o .github/agents/debug.agent.md $B/agents/debug.agent.md
curl -fsSL -o .github/agents/janitor.agent.md $B/agents/janitor.agent.md
curl -fsSL -o .github/agents/wg-code-alchemist.agent.md $B/agents/wg-code-alchemist.agent.md
curl -fsSL -o .github/agents/tdd-red.agent.md $B/agents/tdd-red.agent.md
curl -fsSL -o .github/agents/tdd-green.agent.md $B/agents/tdd-green.agent.md
curl -fsSL -o .github/agents/tdd-refactor.agent.md $B/agents/tdd-refactor.agent.md
curl -fsSL -o .github/agents/address-comments.agent.md $B/agents/address-comments.agent.md
curl -fsSL -o .github/agents/api-architect.agent.md $B/agents/api-architect.agent.md
curl -fsSL -o .github/agents/repo-architect.agent.md $B/agents/repo-architect.agent.md
curl -fsSL -o .github/instructions/object-calisthenics.instructions.md $B/instructions/object-calisthenics.instructions.md
curl -fsSL -o .github/instructions/oop-design-patterns.instructions.md $B/instructions/oop-design-patterns.instructions.md
curl -fsSL -o .github/instructions/performance-optimization.instructions.md $B/instructions/performance-optimization.instructions.md
curl -fsSL -o .github/instructions/qa-engineering-best-practices.instructions.md $B/instructions/qa-engineering-best-practices.instructions.md
curl -fsSL -o .github/instructions/task-implementation.instructions.md $B/instructions/task-implementation.instructions.md
mkdir -p .github/skills/refactor
curl -fsSL -o .github/skills/refactor/SKILL.md $B/skills/refactor/SKILL.md
mkdir -p .github/skills/review-and-refactor
curl -fsSL -o .github/skills/review-and-refactor/SKILL.md $B/skills/review-and-refactor/SKILL.md
mkdir -p .github/skills/refactor-method-complexity-reduce
curl -fsSL -o .github/skills/refactor-method-complexity-reduce/SKILL.md $B/skills/refactor-method-complexity-reduce/SKILL.md
mkdir -p .github/skills/diagnose
curl -fsSL -o .github/skills/diagnose/SKILL.md $B/skills/diagnose/SKILL.md
mkdir -p .github/skills/bug-reproduction-brief
curl -fsSL -o .github/skills/bug-reproduction-brief/SKILL.md $B/skills/bug-reproduction-brief/SKILL.md
mkdir -p .github/skills/acquire-codebase-knowledge .github/skills/acquire-codebase-knowledge/assets/templates .github/skills/acquire-codebase-knowledge/references .github/skills/acquire-codebase-knowledge/scripts
curl -fsSL -o .github/skills/acquire-codebase-knowledge/SKILL.md $B/skills/acquire-codebase-knowledge/SKILL.md
curl -fsSL -o .github/skills/acquire-codebase-knowledge/assets/templates/ARCHITECTURE.md $B/skills/acquire-codebase-knowledge/assets/templates/ARCHITECTURE.md
curl -fsSL -o .github/skills/acquire-codebase-knowledge/assets/templates/CONCERNS.md $B/skills/acquire-codebase-knowledge/assets/templates/CONCERNS.md
curl -fsSL -o .github/skills/acquire-codebase-knowledge/assets/templates/CONVENTIONS.md $B/skills/acquire-codebase-knowledge/assets/templates/CONVENTIONS.md
curl -fsSL -o .github/skills/acquire-codebase-knowledge/assets/templates/INTEGRATIONS.md $B/skills/acquire-codebase-knowledge/assets/templates/INTEGRATIONS.md
curl -fsSL -o .github/skills/acquire-codebase-knowledge/assets/templates/STACK.md $B/skills/acquire-codebase-knowledge/assets/templates/STACK.md
curl -fsSL -o .github/skills/acquire-codebase-knowledge/assets/templates/STRUCTURE.md $B/skills/acquire-codebase-knowledge/assets/templates/STRUCTURE.md
curl -fsSL -o .github/skills/acquire-codebase-knowledge/assets/templates/TESTING.md $B/skills/acquire-codebase-knowledge/assets/templates/TESTING.md
curl -fsSL -o .github/skills/acquire-codebase-knowledge/references/inquiry-checkpoints.md $B/skills/acquire-codebase-knowledge/references/inquiry-checkpoints.md
curl -fsSL -o .github/skills/acquire-codebase-knowledge/references/stack-detection.md $B/skills/acquire-codebase-knowledge/references/stack-detection.md
curl -fsSL -o .github/skills/acquire-codebase-knowledge/scripts/scan.py $B/skills/acquire-codebase-knowledge/scripts/scan.py
mkdir -p .github/skills/context-map
curl -fsSL -o .github/skills/context-map/SKILL.md $B/skills/context-map/SKILL.md
mkdir -p .github/skills/what-context-needed
curl -fsSL -o .github/skills/what-context-needed/SKILL.md $B/skills/what-context-needed/SKILL.md
mkdir -p .github/skills/git-commit
curl -fsSL -o .github/skills/git-commit/SKILL.md $B/skills/git-commit/SKILL.md
mkdir -p .github/skills/conventional-branch
curl -fsSL -o .github/skills/conventional-branch/SKILL.md $B/skills/conventional-branch/SKILL.md
mkdir -p .github/skills/github-release .github/skills/github-release/references
curl -fsSL -o .github/skills/github-release/SKILL.md $B/skills/github-release/SKILL.md
curl -fsSL -o .github/skills/github-release/references/commit-classification.md $B/skills/github-release/references/commit-classification.md
curl -fsSL -o .github/skills/github-release/references/semver-rules.md $B/skills/github-release/references/semver-rules.md
mkdir -p .github/skills/em-dash
curl -fsSL -o .github/skills/em-dash/SKILL.md $B/skills/em-dash/SKILL.md
```


## DOCS — READMEs, ADRs, tutorials, diagrams

<sub>38 items · 90 files</sub>

```bash
B=https://raw.githubusercontent.com/github/awesome-copilot/main
mkdir -p .github/agents .github/instructions .github/skills

curl -fsSL -o .github/agents/project-documenter.agent.md $B/agents/project-documenter.agent.md
curl -fsSL -o .github/agents/se-technical-writer.agent.md $B/agents/se-technical-writer.agent.md
curl -fsSL -o .github/agents/code-tour.agent.md $B/agents/code-tour.agent.md
curl -fsSL -o .github/agents/adr-generator.agent.md $B/agents/adr-generator.agent.md
curl -fsSL -o .github/agents/technical-content-evaluator.agent.md $B/agents/technical-content-evaluator.agent.md
curl -fsSL -o .github/agents/markdown-accessibility-assistant.agent.md $B/agents/markdown-accessibility-assistant.agent.md
curl -fsSL -o .github/agents/specification.agent.md $B/agents/specification.agent.md
curl -fsSL -o .github/instructions/markdown.instructions.md $B/instructions/markdown.instructions.md
curl -fsSL -o .github/instructions/markdown-gfm.instructions.md $B/instructions/markdown-gfm.instructions.md
curl -fsSL -o .github/instructions/markdown-content-creation.instructions.md $B/instructions/markdown-content-creation.instructions.md
curl -fsSL -o .github/instructions/markdown-accessibility.instructions.md $B/instructions/markdown-accessibility.instructions.md
curl -fsSL -o .github/instructions/update-docs-on-code-change.instructions.md $B/instructions/update-docs-on-code-change.instructions.md
curl -fsSL -o .github/instructions/self-explanatory-code-commenting.instructions.md $B/instructions/self-explanatory-code-commenting.instructions.md
mkdir -p .github/skills/documentation-writer
curl -fsSL -o .github/skills/documentation-writer/SKILL.md $B/skills/documentation-writer/SKILL.md
mkdir -p .github/skills/create-readme
curl -fsSL -o .github/skills/create-readme/SKILL.md $B/skills/create-readme/SKILL.md
mkdir -p .github/skills/readme-blueprint-generator
curl -fsSL -o .github/skills/readme-blueprint-generator/SKILL.md $B/skills/readme-blueprint-generator/SKILL.md
mkdir -p .github/skills/create-architectural-decision-record
curl -fsSL -o .github/skills/create-architectural-decision-record/SKILL.md $B/skills/create-architectural-decision-record/SKILL.md
mkdir -p .github/skills/oo-component-documentation .github/skills/oo-component-documentation/assets .github/skills/oo-component-documentation/references
curl -fsSL -o .github/skills/oo-component-documentation/SKILL.md $B/skills/oo-component-documentation/SKILL.md
curl -fsSL -o .github/skills/oo-component-documentation/assets/documentation-template.md $B/skills/oo-component-documentation/assets/documentation-template.md
curl -fsSL -o .github/skills/oo-component-documentation/references/create-mode.md $B/skills/oo-component-documentation/references/create-mode.md
curl -fsSL -o .github/skills/oo-component-documentation/references/update-mode.md $B/skills/oo-component-documentation/references/update-mode.md
mkdir -p .github/skills/comment-code-generate-a-tutorial
curl -fsSL -o .github/skills/comment-code-generate-a-tutorial/SKILL.md $B/skills/comment-code-generate-a-tutorial/SKILL.md
mkdir -p .github/skills/add-educational-comments
curl -fsSL -o .github/skills/add-educational-comments/SKILL.md $B/skills/add-educational-comments/SKILL.md
mkdir -p .github/skills/create-llms
curl -fsSL -o .github/skills/create-llms/SKILL.md $B/skills/create-llms/SKILL.md
mkdir -p .github/skills/update-llms
curl -fsSL -o .github/skills/update-llms/SKILL.md $B/skills/update-llms/SKILL.md
mkdir -p .github/skills/create-agentsmd
curl -fsSL -o .github/skills/create-agentsmd/SKILL.md $B/skills/create-agentsmd/SKILL.md
mkdir -p .github/skills/update-markdown-file-index
curl -fsSL -o .github/skills/update-markdown-file-index/SKILL.md $B/skills/update-markdown-file-index/SKILL.md
mkdir -p .github/skills/code-tour .github/skills/code-tour/references .github/skills/code-tour/scripts
curl -fsSL -o .github/skills/code-tour/SKILL.md $B/skills/code-tour/SKILL.md
curl -fsSL -o .github/skills/code-tour/references/codetour-schema.json $B/skills/code-tour/references/codetour-schema.json
curl -fsSL -o .github/skills/code-tour/references/examples.md $B/skills/code-tour/references/examples.md
curl -fsSL -o .github/skills/code-tour/scripts/generate_from_docs.py $B/skills/code-tour/scripts/generate_from_docs.py
curl -fsSL -o .github/skills/code-tour/scripts/validate_tour.py $B/skills/code-tour/scripts/validate_tour.py
mkdir -p .github/skills/repo-story-time
curl -fsSL -o .github/skills/repo-story-time/SKILL.md $B/skills/repo-story-time/SKILL.md
mkdir -p .github/skills/doc-and-modernize .github/skills/doc-and-modernize/references
curl -fsSL -o .github/skills/doc-and-modernize/SKILL.md $B/skills/doc-and-modernize/SKILL.md
curl -fsSL -o .github/skills/doc-and-modernize/references/copilot-instructions.template.md $B/skills/doc-and-modernize/references/copilot-instructions.template.md
curl -fsSL -o .github/skills/doc-and-modernize/references/migration-hazards.md $B/skills/doc-and-modernize/references/migration-hazards.md
mkdir -p .github/skills/create-tldr-page
curl -fsSL -o .github/skills/create-tldr-page/SKILL.md $B/skills/create-tldr-page/SKILL.md
mkdir -p .github/skills/architecture-blueprint-generator
curl -fsSL -o .github/skills/architecture-blueprint-generator/SKILL.md $B/skills/architecture-blueprint-generator/SKILL.md
mkdir -p .github/skills/folder-structure-blueprint-generator
curl -fsSL -o .github/skills/folder-structure-blueprint-generator/SKILL.md $B/skills/folder-structure-blueprint-generator/SKILL.md
mkdir -p .github/skills/drawio .github/skills/drawio/scripts
curl -fsSL -o .github/skills/drawio/SKILL.md $B/skills/drawio/SKILL.md
curl -fsSL -o .github/skills/drawio/scripts/drawio-to-png.mjs $B/skills/drawio/scripts/drawio-to-png.mjs
curl -fsSL -o .github/skills/drawio/scripts/package.json $B/skills/drawio/scripts/package.json
mkdir -p .github/skills/excalidraw-diagram-generator .github/skills/excalidraw-diagram-generator/references .github/skills/excalidraw-diagram-generator/scripts .github/skills/excalidraw-diagram-generator/templates
curl -fsSL -o .github/skills/excalidraw-diagram-generator/SKILL.md $B/skills/excalidraw-diagram-generator/SKILL.md
curl -fsSL -o .github/skills/excalidraw-diagram-generator/references/element-types.md $B/skills/excalidraw-diagram-generator/references/element-types.md
curl -fsSL -o .github/skills/excalidraw-diagram-generator/references/excalidraw-schema.md $B/skills/excalidraw-diagram-generator/references/excalidraw-schema.md
curl -fsSL -o .github/skills/excalidraw-diagram-generator/scripts/.gitignore $B/skills/excalidraw-diagram-generator/scripts/.gitignore
curl -fsSL -o .github/skills/excalidraw-diagram-generator/scripts/README.md $B/skills/excalidraw-diagram-generator/scripts/README.md
curl -fsSL -o .github/skills/excalidraw-diagram-generator/scripts/add-arrow.py $B/skills/excalidraw-diagram-generator/scripts/add-arrow.py
curl -fsSL -o .github/skills/excalidraw-diagram-generator/scripts/add-icon-to-diagram.py $B/skills/excalidraw-diagram-generator/scripts/add-icon-to-diagram.py
curl -fsSL -o .github/skills/excalidraw-diagram-generator/scripts/split-excalidraw-library.py $B/skills/excalidraw-diagram-generator/scripts/split-excalidraw-library.py
curl -fsSL -o .github/skills/excalidraw-diagram-generator/templates/business-flow-swimlane-template.excalidraw $B/skills/excalidraw-diagram-generator/templates/business-flow-swimlane-template.excalidraw
curl -fsSL -o .github/skills/excalidraw-diagram-generator/templates/class-diagram-template.excalidraw $B/skills/excalidraw-diagram-generator/templates/class-diagram-template.excalidraw
curl -fsSL -o .github/skills/excalidraw-diagram-generator/templates/data-flow-diagram-template.excalidraw $B/skills/excalidraw-diagram-generator/templates/data-flow-diagram-template.excalidraw
curl -fsSL -o .github/skills/excalidraw-diagram-generator/templates/er-diagram-template.excalidraw $B/skills/excalidraw-diagram-generator/templates/er-diagram-template.excalidraw
curl -fsSL -o .github/skills/excalidraw-diagram-generator/templates/flowchart-template.excalidraw $B/skills/excalidraw-diagram-generator/templates/flowchart-template.excalidraw
curl -fsSL -o .github/skills/excalidraw-diagram-generator/templates/mindmap-template.excalidraw $B/skills/excalidraw-diagram-generator/templates/mindmap-template.excalidraw
curl -fsSL -o .github/skills/excalidraw-diagram-generator/templates/relationship-template.excalidraw $B/skills/excalidraw-diagram-generator/templates/relationship-template.excalidraw
curl -fsSL -o .github/skills/excalidraw-diagram-generator/templates/sequence-diagram-template.excalidraw $B/skills/excalidraw-diagram-generator/templates/sequence-diagram-template.excalidraw
mkdir -p .github/skills/plantuml-ascii
curl -fsSL -o .github/skills/plantuml-ascii/SKILL.md $B/skills/plantuml-ascii/SKILL.md
mkdir -p .github/skills/markdown-to-html .github/skills/markdown-to-html/references
curl -fsSL -o .github/skills/markdown-to-html/SKILL.md $B/skills/markdown-to-html/SKILL.md
curl -fsSL -o .github/skills/markdown-to-html/references/basic-markdown-to-html.md $B/skills/markdown-to-html/references/basic-markdown-to-html.md
curl -fsSL -o .github/skills/markdown-to-html/references/basic-markdown.md $B/skills/markdown-to-html/references/basic-markdown.md
curl -fsSL -o .github/skills/markdown-to-html/references/code-blocks-to-html.md $B/skills/markdown-to-html/references/code-blocks-to-html.md
curl -fsSL -o .github/skills/markdown-to-html/references/code-blocks.md $B/skills/markdown-to-html/references/code-blocks.md
curl -fsSL -o .github/skills/markdown-to-html/references/collapsed-sections-to-html.md $B/skills/markdown-to-html/references/collapsed-sections-to-html.md
curl -fsSL -o .github/skills/markdown-to-html/references/collapsed-sections.md $B/skills/markdown-to-html/references/collapsed-sections.md
curl -fsSL -o .github/skills/markdown-to-html/references/gomarkdown.md $B/skills/markdown-to-html/references/gomarkdown.md
curl -fsSL -o .github/skills/markdown-to-html/references/hugo.md $B/skills/markdown-to-html/references/hugo.md
curl -fsSL -o .github/skills/markdown-to-html/references/jekyll.md $B/skills/markdown-to-html/references/jekyll.md
curl -fsSL -o .github/skills/markdown-to-html/references/marked.md $B/skills/markdown-to-html/references/marked.md
curl -fsSL -o .github/skills/markdown-to-html/references/pandoc.md $B/skills/markdown-to-html/references/pandoc.md
curl -fsSL -o .github/skills/markdown-to-html/references/tables-to-html.md $B/skills/markdown-to-html/references/tables-to-html.md
curl -fsSL -o .github/skills/markdown-to-html/references/tables.md $B/skills/markdown-to-html/references/tables.md
curl -fsSL -o .github/skills/markdown-to-html/references/writing-mathematical-expressions-to-html.md $B/skills/markdown-to-html/references/writing-mathematical-expressions-to-html.md
curl -fsSL -o .github/skills/markdown-to-html/references/writing-mathematical-expressions.md $B/skills/markdown-to-html/references/writing-mathematical-expressions.md
mkdir -p .github/skills/md-to-docx .github/skills/md-to-docx/scripts
curl -fsSL -o .github/skills/md-to-docx/SKILL.md $B/skills/md-to-docx/SKILL.md
curl -fsSL -o .github/skills/md-to-docx/scripts/md-to-docx.mjs $B/skills/md-to-docx/scripts/md-to-docx.mjs
curl -fsSL -o .github/skills/md-to-docx/scripts/package.json $B/skills/md-to-docx/scripts/package.json
mkdir -p .github/skills/convert-pdf-to-md .github/skills/convert-pdf-to-md/references .github/skills/convert-pdf-to-md/scripts
curl -fsSL -o .github/skills/convert-pdf-to-md/SKILL.md $B/skills/convert-pdf-to-md/SKILL.md
curl -fsSL -o .github/skills/convert-pdf-to-md/references/setup.md $B/skills/convert-pdf-to-md/references/setup.md
curl -fsSL -o .github/skills/convert-pdf-to-md/scripts/convert_pdf_to_md.py $B/skills/convert-pdf-to-md/scripts/convert_pdf_to_md.py
curl -fsSL -o .github/skills/convert-pdf-to-md/scripts/requirements.txt $B/skills/convert-pdf-to-md/scripts/requirements.txt
mkdir -p .github/skills/convert-word-to-md .github/skills/convert-word-to-md/references .github/skills/convert-word-to-md/scripts
curl -fsSL -o .github/skills/convert-word-to-md/SKILL.md $B/skills/convert-word-to-md/SKILL.md
curl -fsSL -o .github/skills/convert-word-to-md/references/setup.md $B/skills/convert-word-to-md/references/setup.md
curl -fsSL -o .github/skills/convert-word-to-md/scripts/convert_word_to_md.py $B/skills/convert-word-to-md/scripts/convert_word_to_md.py
curl -fsSL -o .github/skills/convert-word-to-md/scripts/requirements.txt $B/skills/convert-word-to-md/scripts/requirements.txt
mkdir -p .github/skills/convert-excel-to-md .github/skills/convert-excel-to-md/references .github/skills/convert-excel-to-md/scripts
curl -fsSL -o .github/skills/convert-excel-to-md/SKILL.md $B/skills/convert-excel-to-md/SKILL.md
curl -fsSL -o .github/skills/convert-excel-to-md/references/setup.md $B/skills/convert-excel-to-md/references/setup.md
curl -fsSL -o .github/skills/convert-excel-to-md/scripts/convert_excel_to_md.py $B/skills/convert-excel-to-md/scripts/convert_excel_to_md.py
curl -fsSL -o .github/skills/convert-excel-to-md/scripts/requirements.txt $B/skills/convert-excel-to-md/scripts/requirements.txt
```


## QUALITY — review, security, testing

<sub>18 items · 97 files</sub>

```bash
B=https://raw.githubusercontent.com/github/awesome-copilot/main
mkdir -p .github/agents .github/instructions .github/skills

curl -fsSL -o .github/agents/quality-playbook.agent.md $B/agents/quality-playbook.agent.md
curl -fsSL -o .github/agents/wg-code-sentinel.agent.md $B/agents/wg-code-sentinel.agent.md
curl -fsSL -o .github/agents/se-security-reviewer.agent.md $B/agents/se-security-reviewer.agent.md
curl -fsSL -o .github/agents/se-system-architecture-reviewer.agent.md $B/agents/se-system-architecture-reviewer.agent.md
curl -fsSL -o .github/agents/doublecheck.agent.md $B/agents/doublecheck.agent.md
curl -fsSL -o .github/instructions/security-and-owasp.instructions.md $B/instructions/security-and-owasp.instructions.md
curl -fsSL -o .github/instructions/code-review-generic.instructions.md $B/instructions/code-review-generic.instructions.md
mkdir -p .github/skills/quality-playbook .github/skills/quality-playbook/agents .github/skills/quality-playbook/phase_prompts .github/skills/quality-playbook/references
curl -fsSL -o .github/skills/quality-playbook/LICENSE.txt $B/skills/quality-playbook/LICENSE.txt
curl -fsSL -o .github/skills/quality-playbook/SKILL.md $B/skills/quality-playbook/SKILL.md
curl -fsSL -o .github/skills/quality-playbook/agents/calibration_orchestrator.md $B/skills/quality-playbook/agents/calibration_orchestrator.md
curl -fsSL -o .github/skills/quality-playbook/agents/quality-playbook-claude.agent.md $B/skills/quality-playbook/agents/quality-playbook-claude.agent.md
curl -fsSL -o .github/skills/quality-playbook/agents/quality-playbook.agent.md $B/skills/quality-playbook/agents/quality-playbook.agent.md
curl -fsSL -o .github/skills/quality-playbook/phase_prompts/README.md $B/skills/quality-playbook/phase_prompts/README.md
curl -fsSL -o .github/skills/quality-playbook/phase_prompts/iteration.md $B/skills/quality-playbook/phase_prompts/iteration.md
curl -fsSL -o .github/skills/quality-playbook/phase_prompts/phase1.md $B/skills/quality-playbook/phase_prompts/phase1.md
curl -fsSL -o .github/skills/quality-playbook/phase_prompts/phase2.md $B/skills/quality-playbook/phase_prompts/phase2.md
curl -fsSL -o .github/skills/quality-playbook/phase_prompts/phase3.md $B/skills/quality-playbook/phase_prompts/phase3.md
curl -fsSL -o .github/skills/quality-playbook/phase_prompts/phase4.md $B/skills/quality-playbook/phase_prompts/phase4.md
curl -fsSL -o .github/skills/quality-playbook/phase_prompts/phase5.md $B/skills/quality-playbook/phase_prompts/phase5.md
curl -fsSL -o .github/skills/quality-playbook/phase_prompts/phase6.md $B/skills/quality-playbook/phase_prompts/phase6.md
curl -fsSL -o .github/skills/quality-playbook/phase_prompts/single_pass.md $B/skills/quality-playbook/phase_prompts/single_pass.md
curl -fsSL -o .github/skills/quality-playbook/quality_gate.py $B/skills/quality-playbook/quality_gate.py
curl -fsSL -o .github/skills/quality-playbook/references/challenge_gate.md $B/skills/quality-playbook/references/challenge_gate.md
curl -fsSL -o .github/skills/quality-playbook/references/code-only-mode.md $B/skills/quality-playbook/references/code-only-mode.md
curl -fsSL -o .github/skills/quality-playbook/references/constitution.md $B/skills/quality-playbook/references/constitution.md
curl -fsSL -o .github/skills/quality-playbook/references/defensive_patterns.md $B/skills/quality-playbook/references/defensive_patterns.md
curl -fsSL -o .github/skills/quality-playbook/references/exploration_patterns.md $B/skills/quality-playbook/references/exploration_patterns.md
curl -fsSL -o .github/skills/quality-playbook/references/functional_tests.md $B/skills/quality-playbook/references/functional_tests.md
curl -fsSL -o .github/skills/quality-playbook/references/iteration.md $B/skills/quality-playbook/references/iteration.md
curl -fsSL -o .github/skills/quality-playbook/references/orchestrator_protocol.md $B/skills/quality-playbook/references/orchestrator_protocol.md
curl -fsSL -o .github/skills/quality-playbook/references/requirements_pipeline.md $B/skills/quality-playbook/references/requirements_pipeline.md
curl -fsSL -o .github/skills/quality-playbook/references/requirements_refinement.md $B/skills/quality-playbook/references/requirements_refinement.md
curl -fsSL -o .github/skills/quality-playbook/references/requirements_review.md $B/skills/quality-playbook/references/requirements_review.md
curl -fsSL -o .github/skills/quality-playbook/references/review_protocols.md $B/skills/quality-playbook/references/review_protocols.md
curl -fsSL -o .github/skills/quality-playbook/references/run_state_schema.md $B/skills/quality-playbook/references/run_state_schema.md
curl -fsSL -o .github/skills/quality-playbook/references/schema_mapping.md $B/skills/quality-playbook/references/schema_mapping.md
curl -fsSL -o .github/skills/quality-playbook/references/spec_audit.md $B/skills/quality-playbook/references/spec_audit.md
curl -fsSL -o .github/skills/quality-playbook/references/verification.md $B/skills/quality-playbook/references/verification.md
mkdir -p .github/skills/security-review .github/skills/security-review/references
curl -fsSL -o .github/skills/security-review/SKILL.md $B/skills/security-review/SKILL.md
curl -fsSL -o .github/skills/security-review/references/language-patterns.md $B/skills/security-review/references/language-patterns.md
curl -fsSL -o .github/skills/security-review/references/report-format.md $B/skills/security-review/references/report-format.md
curl -fsSL -o .github/skills/security-review/references/secret-patterns.md $B/skills/security-review/references/secret-patterns.md
curl -fsSL -o .github/skills/security-review/references/vuln-categories.md $B/skills/security-review/references/vuln-categories.md
curl -fsSL -o .github/skills/security-review/references/vulnerable-packages.md $B/skills/security-review/references/vulnerable-packages.md
mkdir -p .github/skills/codeql .github/skills/codeql/references
curl -fsSL -o .github/skills/codeql/SKILL.md $B/skills/codeql/SKILL.md
curl -fsSL -o .github/skills/codeql/references/alert-management.md $B/skills/codeql/references/alert-management.md
curl -fsSL -o .github/skills/codeql/references/cli-commands.md $B/skills/codeql/references/cli-commands.md
curl -fsSL -o .github/skills/codeql/references/compiled-languages.md $B/skills/codeql/references/compiled-languages.md
curl -fsSL -o .github/skills/codeql/references/sarif-output.md $B/skills/codeql/references/sarif-output.md
curl -fsSL -o .github/skills/codeql/references/troubleshooting.md $B/skills/codeql/references/troubleshooting.md
curl -fsSL -o .github/skills/codeql/references/workflow-configuration.md $B/skills/codeql/references/workflow-configuration.md
mkdir -p .github/skills/secret-scanning .github/skills/secret-scanning/references
curl -fsSL -o .github/skills/secret-scanning/SKILL.md $B/skills/secret-scanning/SKILL.md
curl -fsSL -o .github/skills/secret-scanning/references/alerts-and-remediation.md $B/skills/secret-scanning/references/alerts-and-remediation.md
curl -fsSL -o .github/skills/secret-scanning/references/custom-patterns.md $B/skills/secret-scanning/references/custom-patterns.md
curl -fsSL -o .github/skills/secret-scanning/references/push-protection.md $B/skills/secret-scanning/references/push-protection.md
mkdir -p .github/skills/threat-model-analyst .github/skills/threat-model-analyst/references .github/skills/threat-model-analyst/references/skeletons
curl -fsSL -o .github/skills/threat-model-analyst/SKILL.md $B/skills/threat-model-analyst/SKILL.md
curl -fsSL -o .github/skills/threat-model-analyst/references/analysis-principles.md $B/skills/threat-model-analyst/references/analysis-principles.md
curl -fsSL -o .github/skills/threat-model-analyst/references/diagram-conventions.md $B/skills/threat-model-analyst/references/diagram-conventions.md
curl -fsSL -o .github/skills/threat-model-analyst/references/incremental-orchestrator.md $B/skills/threat-model-analyst/references/incremental-orchestrator.md
curl -fsSL -o .github/skills/threat-model-analyst/references/orchestrator.md $B/skills/threat-model-analyst/references/orchestrator.md
curl -fsSL -o .github/skills/threat-model-analyst/references/output-formats.md $B/skills/threat-model-analyst/references/output-formats.md
curl -fsSL -o .github/skills/threat-model-analyst/references/skeletons/skeleton-architecture.md $B/skills/threat-model-analyst/references/skeletons/skeleton-architecture.md
curl -fsSL -o .github/skills/threat-model-analyst/references/skeletons/skeleton-assessment.md $B/skills/threat-model-analyst/references/skeletons/skeleton-assessment.md
curl -fsSL -o .github/skills/threat-model-analyst/references/skeletons/skeleton-dfd.md $B/skills/threat-model-analyst/references/skeletons/skeleton-dfd.md
curl -fsSL -o .github/skills/threat-model-analyst/references/skeletons/skeleton-findings.md $B/skills/threat-model-analyst/references/skeletons/skeleton-findings.md
curl -fsSL -o .github/skills/threat-model-analyst/references/skeletons/skeleton-incremental-html.md $B/skills/threat-model-analyst/references/skeletons/skeleton-incremental-html.md
curl -fsSL -o .github/skills/threat-model-analyst/references/skeletons/skeleton-inventory.md $B/skills/threat-model-analyst/references/skeletons/skeleton-inventory.md
curl -fsSL -o .github/skills/threat-model-analyst/references/skeletons/skeleton-stride-analysis.md $B/skills/threat-model-analyst/references/skeletons/skeleton-stride-analysis.md
curl -fsSL -o .github/skills/threat-model-analyst/references/skeletons/skeleton-summary-dfd.md $B/skills/threat-model-analyst/references/skeletons/skeleton-summary-dfd.md
curl -fsSL -o .github/skills/threat-model-analyst/references/skeletons/skeleton-threatmodel.md $B/skills/threat-model-analyst/references/skeletons/skeleton-threatmodel.md
curl -fsSL -o .github/skills/threat-model-analyst/references/tmt-element-taxonomy.md $B/skills/threat-model-analyst/references/tmt-element-taxonomy.md
curl -fsSL -o .github/skills/threat-model-analyst/references/verification-checklist.md $B/skills/threat-model-analyst/references/verification-checklist.md
mkdir -p .github/skills/eval-driven-dev .github/skills/eval-driven-dev/references .github/skills/eval-driven-dev/references/runnable-examples .github/skills/eval-driven-dev/resources
curl -fsSL -o .github/skills/eval-driven-dev/SKILL.md $B/skills/eval-driven-dev/SKILL.md
curl -fsSL -o .github/skills/eval-driven-dev/references/1-a-project-analysis.md $B/skills/eval-driven-dev/references/1-a-project-analysis.md
curl -fsSL -o .github/skills/eval-driven-dev/references/1-b-entry-point.md $B/skills/eval-driven-dev/references/1-b-entry-point.md
curl -fsSL -o .github/skills/eval-driven-dev/references/1-c-eval-criteria.md $B/skills/eval-driven-dev/references/1-c-eval-criteria.md
curl -fsSL -o .github/skills/eval-driven-dev/references/2a-instrumentation.md $B/skills/eval-driven-dev/references/2a-instrumentation.md
curl -fsSL -o .github/skills/eval-driven-dev/references/2b-implement-runnable.md $B/skills/eval-driven-dev/references/2b-implement-runnable.md
curl -fsSL -o .github/skills/eval-driven-dev/references/2c-capture-and-verify-trace.md $B/skills/eval-driven-dev/references/2c-capture-and-verify-trace.md
curl -fsSL -o .github/skills/eval-driven-dev/references/3-define-evaluators.md $B/skills/eval-driven-dev/references/3-define-evaluators.md
curl -fsSL -o .github/skills/eval-driven-dev/references/4-build-dataset.md $B/skills/eval-driven-dev/references/4-build-dataset.md
curl -fsSL -o .github/skills/eval-driven-dev/references/5-run-tests.md $B/skills/eval-driven-dev/references/5-run-tests.md
curl -fsSL -o .github/skills/eval-driven-dev/references/6-analyze-outcomes.md $B/skills/eval-driven-dev/references/6-analyze-outcomes.md
curl -fsSL -o .github/skills/eval-driven-dev/references/evaluators.md $B/skills/eval-driven-dev/references/evaluators.md
curl -fsSL -o .github/skills/eval-driven-dev/references/runnable-examples/cli-app.md $B/skills/eval-driven-dev/references/runnable-examples/cli-app.md
curl -fsSL -o .github/skills/eval-driven-dev/references/runnable-examples/fastapi-web-server.md $B/skills/eval-driven-dev/references/runnable-examples/fastapi-web-server.md
curl -fsSL -o .github/skills/eval-driven-dev/references/runnable-examples/standalone-function.md $B/skills/eval-driven-dev/references/runnable-examples/standalone-function.md
curl -fsSL -o .github/skills/eval-driven-dev/references/testing-api.md $B/skills/eval-driven-dev/references/testing-api.md
curl -fsSL -o .github/skills/eval-driven-dev/references/wrap-api.md $B/skills/eval-driven-dev/references/wrap-api.md
curl -fsSL -o .github/skills/eval-driven-dev/resources/setup.sh $B/skills/eval-driven-dev/resources/setup.sh
curl -fsSL -o .github/skills/eval-driven-dev/resources/verify_step6_completion.py $B/skills/eval-driven-dev/resources/verify_step6_completion.py
mkdir -p .github/skills/webapp-testing .github/skills/webapp-testing/assets
curl -fsSL -o .github/skills/webapp-testing/SKILL.md $B/skills/webapp-testing/SKILL.md
curl -fsSL -o .github/skills/webapp-testing/assets/test-helper.js $B/skills/webapp-testing/assets/test-helper.js
mkdir -p .github/skills/pytest-coverage
curl -fsSL -o .github/skills/pytest-coverage/SKILL.md $B/skills/pytest-coverage/SKILL.md
mkdir -p .github/skills/javascript-typescript-jest
curl -fsSL -o .github/skills/javascript-typescript-jest/SKILL.md $B/skills/javascript-typescript-jest/SKILL.md
mkdir -p .github/skills/playwright-generate-test
curl -fsSL -o .github/skills/playwright-generate-test/SKILL.md $B/skills/playwright-generate-test/SKILL.md
mkdir -p .github/skills/incident-postmortem
curl -fsSL -o .github/skills/incident-postmortem/SKILL.md $B/skills/incident-postmortem/SKILL.md
```


## PLANNING — specs, plans, task breakdown

<sub>18 items · 18 files</sub>

```bash
B=https://raw.githubusercontent.com/github/awesome-copilot/main
mkdir -p .github/agents .github/instructions .github/skills

curl -fsSL -o .github/agents/task-planner.agent.md $B/agents/task-planner.agent.md
curl -fsSL -o .github/agents/task-researcher.agent.md $B/agents/task-researcher.agent.md
curl -fsSL -o .github/agents/implementation-plan.agent.md $B/agents/implementation-plan.agent.md
curl -fsSL -o .github/agents/plan.agent.md $B/agents/plan.agent.md
curl -fsSL -o .github/agents/planner.agent.md $B/agents/planner.agent.md
curl -fsSL -o .github/agents/specification.agent.md $B/agents/specification.agent.md
curl -fsSL -o .github/instructions/spec-driven-workflow-v1.instructions.md $B/instructions/spec-driven-workflow-v1.instructions.md
curl -fsSL -o .github/instructions/memory-bank.instructions.md $B/instructions/memory-bank.instructions.md
mkdir -p .github/skills/create-implementation-plan
curl -fsSL -o .github/skills/create-implementation-plan/SKILL.md $B/skills/create-implementation-plan/SKILL.md
mkdir -p .github/skills/update-implementation-plan
curl -fsSL -o .github/skills/update-implementation-plan/SKILL.md $B/skills/update-implementation-plan/SKILL.md
mkdir -p .github/skills/create-specification
curl -fsSL -o .github/skills/create-specification/SKILL.md $B/skills/create-specification/SKILL.md
mkdir -p .github/skills/update-specification
curl -fsSL -o .github/skills/update-specification/SKILL.md $B/skills/update-specification/SKILL.md
mkdir -p .github/skills/breakdown-feature-implementation
curl -fsSL -o .github/skills/breakdown-feature-implementation/SKILL.md $B/skills/breakdown-feature-implementation/SKILL.md
mkdir -p .github/skills/breakdown-plan
curl -fsSL -o .github/skills/breakdown-plan/SKILL.md $B/skills/breakdown-plan/SKILL.md
mkdir -p .github/skills/breakdown-test
curl -fsSL -o .github/skills/breakdown-test/SKILL.md $B/skills/breakdown-test/SKILL.md
mkdir -p .github/skills/structured-autonomy-plan
curl -fsSL -o .github/skills/structured-autonomy-plan/SKILL.md $B/skills/structured-autonomy-plan/SKILL.md
mkdir -p .github/skills/structured-autonomy-implement
curl -fsSL -o .github/skills/structured-autonomy-implement/SKILL.md $B/skills/structured-autonomy-implement/SKILL.md
mkdir -p .github/skills/structured-autonomy-generate
curl -fsSL -o .github/skills/structured-autonomy-generate/SKILL.md $B/skills/structured-autonomy-generate/SKILL.md
```


## WEB — React / Next.js / TS / Tailwind / a11y

<sub>15 items · 17 files</sub>

```bash
B=https://raw.githubusercontent.com/github/awesome-copilot/main
mkdir -p .github/agents .github/instructions .github/skills

curl -fsSL -o .github/agents/expert-react-frontend-engineer.agent.md $B/agents/expert-react-frontend-engineer.agent.md
curl -fsSL -o .github/agents/expert-nextjs-developer.agent.md $B/agents/expert-nextjs-developer.agent.md
curl -fsSL -o .github/instructions/nextjs.instructions.md $B/instructions/nextjs.instructions.md
curl -fsSL -o .github/instructions/nextjs-tailwind.instructions.md $B/instructions/nextjs-tailwind.instructions.md
curl -fsSL -o .github/instructions/tailwind-v4-vite.instructions.md $B/instructions/tailwind-v4-vite.instructions.md
curl -fsSL -o .github/instructions/nodejs-javascript-vitest.instructions.md $B/instructions/nodejs-javascript-vitest.instructions.md
curl -fsSL -o .github/instructions/playwright-typescript.instructions.md $B/instructions/playwright-typescript.instructions.md
curl -fsSL -o .github/instructions/a11y.instructions.md $B/instructions/a11y.instructions.md
curl -fsSL -o .github/instructions/vue.instructions.md $B/instructions/vue.instructions.md
curl -fsSL -o .github/instructions/svelte.instructions.md $B/instructions/svelte.instructions.md
mkdir -p .github/skills/anti-ui-slop
curl -fsSL -o .github/skills/anti-ui-slop/SKILL.md $B/skills/anti-ui-slop/SKILL.md
mkdir -p .github/skills/premium-frontend-ui
curl -fsSL -o .github/skills/premium-frontend-ui/SKILL.md $B/skills/premium-frontend-ui/SKILL.md
mkdir -p .github/skills/web-design-reviewer .github/skills/web-design-reviewer/references
curl -fsSL -o .github/skills/web-design-reviewer/SKILL.md $B/skills/web-design-reviewer/SKILL.md
curl -fsSL -o .github/skills/web-design-reviewer/references/framework-fixes.md $B/skills/web-design-reviewer/references/framework-fixes.md
curl -fsSL -o .github/skills/web-design-reviewer/references/visual-checklist.md $B/skills/web-design-reviewer/references/visual-checklist.md
mkdir -p .github/skills/chrome-devtools
curl -fsSL -o .github/skills/chrome-devtools/SKILL.md $B/skills/chrome-devtools/SKILL.md
mkdir -p .github/skills/playwright-generate-test
curl -fsSL -o .github/skills/playwright-generate-test/SKILL.md $B/skills/playwright-generate-test/SKILL.md
```


## BACKEND — Go / Rust / shell / SQL / Docker / CI

<sub>12 items · 24 files</sub>

```bash
B=https://raw.githubusercontent.com/github/awesome-copilot/main
mkdir -p .github/agents .github/instructions .github/skills

curl -fsSL -o .github/instructions/go.instructions.md $B/instructions/go.instructions.md
curl -fsSL -o .github/instructions/rust.instructions.md $B/instructions/rust.instructions.md
curl -fsSL -o .github/instructions/shell.instructions.md $B/instructions/shell.instructions.md
curl -fsSL -o .github/instructions/containerization-docker-best-practices.instructions.md $B/instructions/containerization-docker-best-practices.instructions.md
curl -fsSL -o .github/instructions/github-actions-ci-cd-best-practices.instructions.md $B/instructions/github-actions-ci-cd-best-practices.instructions.md
curl -fsSL -o .github/instructions/devops-core-principles.instructions.md $B/instructions/devops-core-principles.instructions.md
mkdir -p .github/skills/sql-code-review
curl -fsSL -o .github/skills/sql-code-review/SKILL.md $B/skills/sql-code-review/SKILL.md
mkdir -p .github/skills/postgresql-code-review
curl -fsSL -o .github/skills/postgresql-code-review/SKILL.md $B/skills/postgresql-code-review/SKILL.md
mkdir -p .github/skills/multi-stage-dockerfile
curl -fsSL -o .github/skills/multi-stage-dockerfile/SKILL.md $B/skills/multi-stage-dockerfile/SKILL.md
mkdir -p .github/skills/github-actions-hardening .github/skills/github-actions-hardening/references
curl -fsSL -o .github/skills/github-actions-hardening/SKILL.md $B/skills/github-actions-hardening/SKILL.md
curl -fsSL -o .github/skills/github-actions-hardening/references/injection.md $B/skills/github-actions-hardening/references/injection.md
curl -fsSL -o .github/skills/github-actions-hardening/references/permissions-and-tokens.md $B/skills/github-actions-hardening/references/permissions-and-tokens.md
curl -fsSL -o .github/skills/github-actions-hardening/references/report-format.md $B/skills/github-actions-hardening/references/report-format.md
curl -fsSL -o .github/skills/github-actions-hardening/references/supply-chain.md $B/skills/github-actions-hardening/references/supply-chain.md
curl -fsSL -o .github/skills/github-actions-hardening/references/triggers-and-privilege.md $B/skills/github-actions-hardening/references/triggers-and-privilege.md
mkdir -p .github/skills/github-actions-efficiency .github/skills/github-actions-efficiency/references
curl -fsSL -o .github/skills/github-actions-efficiency/SKILL.md $B/skills/github-actions-efficiency/SKILL.md
curl -fsSL -o .github/skills/github-actions-efficiency/references/actions.md $B/skills/github-actions-efficiency/references/actions.md
curl -fsSL -o .github/skills/github-actions-efficiency/references/patterns.md $B/skills/github-actions-efficiency/references/patterns.md
curl -fsSL -o .github/skills/github-actions-efficiency/references/reporting.md $B/skills/github-actions-efficiency/references/reporting.md
curl -fsSL -o .github/skills/github-actions-efficiency/references/review-rubric.md $B/skills/github-actions-efficiency/references/review-rubric.md
mkdir -p .github/skills/dependabot .github/skills/dependabot/references
curl -fsSL -o .github/skills/dependabot/SKILL.md $B/skills/dependabot/SKILL.md
curl -fsSL -o .github/skills/dependabot/references/dependabot-yml-reference.md $B/skills/dependabot/references/dependabot-yml-reference.md
curl -fsSL -o .github/skills/dependabot/references/example-configs.md $B/skills/dependabot/references/example-configs.md
curl -fsSL -o .github/skills/dependabot/references/pr-commands.md $B/skills/dependabot/references/pr-commands.md
```


## META — bootstrap a repo + discovery

<sub>12 items · 12 files</sub>

```bash
B=https://raw.githubusercontent.com/github/awesome-copilot/main
mkdir -p .github/agents .github/instructions .github/skills

curl -fsSL -o .github/agents/prompt-builder.agent.md $B/agents/prompt-builder.agent.md
curl -fsSL -o .github/instructions/agents.instructions.md $B/instructions/agents.instructions.md
curl -fsSL -o .github/instructions/instructions.instructions.md $B/instructions/instructions.instructions.md
curl -fsSL -o .github/instructions/prompt.instructions.md $B/instructions/prompt.instructions.md
mkdir -p .github/skills/copilot-instructions-blueprint-generator
curl -fsSL -o .github/skills/copilot-instructions-blueprint-generator/SKILL.md $B/skills/copilot-instructions-blueprint-generator/SKILL.md
mkdir -p .github/skills/technology-stack-blueprint-generator
curl -fsSL -o .github/skills/technology-stack-blueprint-generator/SKILL.md $B/skills/technology-stack-blueprint-generator/SKILL.md
mkdir -p .github/skills/code-exemplars-blueprint-generator
curl -fsSL -o .github/skills/code-exemplars-blueprint-generator/SKILL.md $B/skills/code-exemplars-blueprint-generator/SKILL.md
mkdir -p .github/skills/project-workflow-analysis-blueprint-generator
curl -fsSL -o .github/skills/project-workflow-analysis-blueprint-generator/SKILL.md $B/skills/project-workflow-analysis-blueprint-generator/SKILL.md
mkdir -p .github/skills/create-agentsmd
curl -fsSL -o .github/skills/create-agentsmd/SKILL.md $B/skills/create-agentsmd/SKILL.md
mkdir -p .github/skills/suggest-awesome-github-copilot-agents
curl -fsSL -o .github/skills/suggest-awesome-github-copilot-agents/SKILL.md $B/skills/suggest-awesome-github-copilot-agents/SKILL.md
mkdir -p .github/skills/suggest-awesome-github-copilot-instructions
curl -fsSL -o .github/skills/suggest-awesome-github-copilot-instructions/SKILL.md $B/skills/suggest-awesome-github-copilot-instructions/SKILL.md
mkdir -p .github/skills/suggest-awesome-github-copilot-skills
curl -fsSL -o .github/skills/suggest-awesome-github-copilot-skills/SKILL.md $B/skills/suggest-awesome-github-copilot-skills/SKILL.md
```
