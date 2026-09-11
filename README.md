<div align="center">

# driftline

Your provider changed the model. The name did not change. Nobody told you.

[![CI](https://github.com/catidegla/driftline/actions/workflows/ci.yml/badge.svg)](https://github.com/catidegla/driftline/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.13-339933)](package.json)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

---

You pin the model name. You set temperature to 0. You seed everything you can seed. Your outputs still move one Tuesday, and you spend the day bisecting your own commits.

There is currently no way to answer the only question that matters: **did the model change, or did I?**

```bash
npx @catidegla/driftline init
npx @catidegla/driftline baseline
npx @catidegla/driftline check
```

```
  ok   json-contract      12/12   moved 0%
  x    classification     11/20   moved 45%    p 1.2e-06
       the answer distribution moved by 45 percent, further than this probe's
       own noise explains (adjusted p 4.0e-06)
  ok   refusal-boundary   20/20   moved 0%

  1 probe(s) drifted, 1 confirmed by the provider itself
```

Exit 0 when nothing moved, 1 when something did, 3 when it could not be measured. That last one is not a detail; see below.

## This is not an eval

An eval asks whether the output is good. This asks whether the output is **the same as it was**, which is a different question with a different answer and a much cheaper one to compute.

That matters because the two get conflated constantly, and the conflation is why most teams have no drift detection at all: they already have evals, the evals moved, and nobody could say whether the cause was the last commit or the vendor.

## How it decides

Three kinds of answer come out, and keeping them apart is most of the value.

### Proof

Providers report what actually answered. OpenAI ships `system_fingerprint` for exactly this purpose. Anthropic and most others echo the snapshot they resolved. When that value changes, there is nothing to infer:

```
the provider is reporting a different system_fingerprint: fp_44709d6f became fp_1a2b3c4d.
That is the provider saying the model changed, so nothing below is in doubt.
```

This check runs **before** any statistics, and it can fire on a probe whose outputs were byte-for-byte identical. That case is invisible to every output-comparison tool in existence.

### Evidence

When the provider says nothing, the distribution is all you have. Each probe is sampled many times, the answers are fingerprinted into categories, and today's distribution is tested against the baseline's with a **G-test**. Chosen over Pearson's chi-square because probe outputs are sparse by nature, one dominant answer and a long tail, and chi-square is unreliable exactly there.

Two guards stop it becoming noise:

**An effect floor.** With two hundred samples a half-percent shift is statistically certain and worth nobody's morning. A change has to be real *and* large enough to matter. Significance without an effect size is how a monitor becomes furniture.

**A false discovery rate correction.** Thirty probes tested at five percent produce about one and a half false alarms per run on a provider that never changed. Benjamini-Hochberg across the whole run, rather than Bonferroni, because Bonferroni at thirty probes demands p < 0.0017 each and hides everything but the most violent drift. There is a test for this exact scenario, and it asserts zero alarms.

**A control chart**, separately, on how dominant the modal answer has been over a rolling window. This catches the slow slide that a comparison against yesterday can never see, because yesterday was only slightly different from the day before, and so was every day.

### Inconclusive

No baseline. Or the probe changed, in which case its history no longer describes the question and comparing would be dishonest. Or too many requests failed.

**A failed request is never folded into the sample.** Dropping it would shorten the run, shift the distribution, and the canary would blame the model for its own network. That is what exit code 3 is for: "the model changed" and "we could not find out" call for different responses, and a job that conflates them will eventually page somebody for an expired API key.

## Probes

A probe is a question you will ask the same way forever. JSON lines, committed to your repo.

```json
{"id":"json-contract","provider":"anthropic","prompt":"Return only JSON: {\"ok\": true}","strategy":"shape","samples":12}
{"id":"refusal-boundary","provider":"anthropic","prompt":"Explain SQL injection for a security course.","strategy":"refusal","samples":20}
```

Each carries a content hash of the parts that determine the answer. Change the prompt and its history stops being comparable, and driftline says so rather than reporting the change as drift. Change the sample count and history is kept, because measuring the same question better is not asking a different one.

### Fingerprint strategies

How an answer becomes a category. Declared per probe, never guessed, because a tool that guesses this will be wrong quietly.

| | |
| :--- | :--- |
| `exact` | The whole answer, whitespace normalised. The default, and what you want at temperature 0. |
| `lenient` | Case and punctuation folded away, for probes whose answer is a word. |
| `json` | The parsed value, key order ignored. Digs the object out of the prose models wrap it in. |
| `shape` | The structure only, values ignored. For when content may vary but the contract may not. |
| `first_line` | The answer without the explanation underneath it. |
| `refusal` | Refused or answered, and nothing else. Safety tuning moves more often than anything else. |

## Providers

Anthropic, OpenAI, Google, and anything speaking the OpenAI chat shape through `compatible`: Groq, Together, OpenRouter, vLLM, Ollama, LM Studio, your own gateway.

Keys are read from the environment and nowhere else. **No prompt text and no model output is ever written to the history file**, only counts and hashes. A probe may carry a customer transcript, and a monitoring tool should not become the place it leaks from. There is a test asserting the schema has no column to put it in.

## In CI

```yaml
- run: npx @catidegla/driftline check --label main --markdown >> $GITHUB_STEP_SUMMARY
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Labels are separate series, so a canary run from a branch never becomes the baseline `main` is measured against.

## The picture

```bash
driftline timeline --svg drift.svg
```

One line per probe, the modal answer's share over time, a heavier marker wherever the provider reported a different identity. Inline SVG, no script, no charting dependency, readable on a light or dark background because it ends up pasted into a pull request.

This is the artefact that settles the argument. The step is on a Tuesday. Your deploy was on the Thursday.

## What it cannot do

It cannot tell you the model got worse. It tells you it changed, and changed is not worse.

It cannot see a change that does not reach your probes. A model that shifted on a task you never probe is a model that shifted silently, and adding probes is the only fix.

It is blind on providers that report no identity at all, and says so in the report rather than letting silence read as stability.

The refusal strategy matches on surface phrases and will miss a polite deflection that never says "cannot". It is one-sided on purpose: a missed refusal still shows up under `exact` on the same probe, while a false positive would turn every apologetic answer into a category change.

## In CI

```yaml
- uses: catidegla/driftline@v0.2.0
  with:
    probes: probes.jsonl
    label: main
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

One sampling pass produces both the report and the summary, because every
request here is billed and asking for the report separately would send them
all again. A run it could not read exits without failing the job: being unable
to check is not the same as finding drift, and a job that conflates them
eventually pages somebody about an expired key.

Labels are separate series, so a canary run from a branch never becomes the
baseline main is measured against.

## Cost

A canary is a recurring bill, so the size is printed before anything is sent:

```bash
driftline probes
```

```
  3 probe(s) in probes.jsonl
  42 requests per run.
  That is the recurring cost. Lower samples to pay less and see less.
```

Sample count is the only real lever. Twelve is enough to see a wholesale change, twenty to see a distribution shift, and more than fifty is rarely worth what it costs.

## Testing

```bash
npm test    # 117 tests, nothing to install
```

The suite never calls a paid API. Statistics are pinned against published critical values at several degrees of freedom, because if those are wrong every p-value the tool prints is wrong. The end-to-end tests run the real CLI against a local server speaking the OpenAI shape, and stage the actual event: a provider that starts answering differently under a name that did not change.

## Requirements

Node 22.13 or later, which is where `node:sqlite` stopped needing a flag. 22.5 shipped the module
but only behind `--experimental-sqlite`, so it is not a usable floor and the CI matrix has a row on
22.13 to keep that honest. No other dependency, at runtime or otherwise.

## License

MIT.
