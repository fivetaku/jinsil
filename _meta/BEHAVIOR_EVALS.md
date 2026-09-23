# Behavior regression

Run cases only in a disposable workspace generated through the official path,
not in a live user workspace. The runtime can write evaluation artifacts.

```bash
python3 scripts/generate_workspace.py kb-eval knowledge-base --output-dir /tmp/wb-eval
python3 scripts/evaluate_workspace.py /tmp/wb-eval/kb-eval \
  /tmp/wb-eval/kb-eval/_meta/evals/harness_cases.json --runtime codex
```

Use `--runtime claude` for a separate Claude run in another fresh workspace.
Each case starts a new session, so later cases must recover state from files.
There is no implicit retry. Failures stop a live run; JSONL contains case ID,
verdict, runtime, elapsed seconds and failed artifact checks. Missing runtime,
nonzero runtime exit and timeout are failures, not evidence of a harness defect.

`--check-only` grades existing artifacts without a model call and labels the
result `artifact_only`; it is never live behavior proof. Checks require nonempty
case IDs and prompts, at least one confined JSON path, a sequence of object keys,
and an independently specified expected value. Boolean and numeric values differ.
Do not grade the model's own claims of success. Use fresh targets to prevent
pre-existing passing artifacts from masking a failed action.

The initial KB seed covers structured intake, duplicate handling, update/history
and a cross-session query. It does not prove relation inference, citation quality
or every possible natural-language routing boundary. Add domain-specific cases
with independently known evidence before claiming those capabilities.
Tests of the scorer are offline; live model results are evaluated separately.
