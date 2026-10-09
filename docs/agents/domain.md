# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

This repository uses a single-context layout:

- **`CONTEXT.md`** at the repository root: read the domain glossary and model.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.

If these files don't exist, proceed silently. The `/domain-modeling` skill creates them lazily when terms or decisions actually get resolved.

## File structure

```text
/
├── CONTEXT.md
└── docs/adr/
    └── <number>-<decision>.md
```

Paths in this document are relative to the `cocos_live_probe` repository root, including when this repository is checked out as a submodule.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, or a test name), use the term as defined in `CONTEXT.md`.

If the concept you need isn't in the glossary yet, reconsider whether the project uses it or note a real gap for `/domain-modeling`.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly with the ADR reference and the reason for reopening the decision.
