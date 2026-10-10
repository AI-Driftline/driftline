# Driftline

See how your prompts change **before** an AI model is retired.

![Driftline flags retired and retiring models on the exact line of a pull request, then lists them in the job summary](docs/demo.gif)

Driftline is a GitHub Action. It finds the OpenAI, Anthropic and Google model IDs in your code, checks them against the providers' published retirement dates, and runs your real prompts on both the current and the replacement model so you can see what changes before you switch.

It runs inside your own CI with your own API keys. There is no Driftline server: prompts go straight from your runner to your AI provider.

## What you get

- **Annotations** on the exact file and line of retired or retiring models (the 50 most urgent; the rest are in the report).
- **A report** in the job summary, and optionally a GitHub issue that updates itself on each run and closes itself once nothing is left to fix.
- **Drift tests (Pro):** each prompt in `.driftline/prompts.yml` runs on both models. You get a similarity score per prompt, and a hard failure if a JSON answer stops parsing.

## Quick start

1. Copy [`examples/driftline.yml`](examples/driftline.yml) to `.github/workflows/driftline.yml`.
2. Optional, for drift tests (Pro): copy [`examples/prompts.yml`](examples/prompts.yml) to `.driftline/prompts.yml` and add your provider API keys as repository secrets.
3. Activate your Pro key once per GitHub account or organization, from inside one of its repositories:

   ```sh
   npx github:AI-Driftline/driftline activate <your-license-key>
   ```

   It prints a license code. Save that code as the secret `DRIFTLINE_LICENSE_KEY`. A key works on up to 3 GitHub accounts or organizations; `npx github:AI-Driftline/driftline deactivate <code>` frees one.

## Inputs

| Input | Default | What it does |
|---|---|---|
| `path` | `.` | Directory to scan |
| `warn-days` | `90` | Models retiring within this many days count as "retires soon" (`0` turns this off) |
| `fail-on` | `retired` | Fail the job on `retired`, `at-risk`, or `never` |
| `prompts-file` | `.driftline/prompts.yml` | Prompts for drift tests (YAML or JSON). Looked up from the repository root, then from `path` |
| `license-key` | | Driftline Pro license code from `activate`; without it only the scan runs |
| `create-issue` | `false` | Open or update one issue labelled `driftline`. Model answers are never put in the issue |
| `show-answers` | `true` | Show model answers in the job summary. In a public repository job summaries are public, so set `false` if your prompts contain private data |
| `github-token` | `github.token` | Needs `issues: write` when `create-issue` is on |

Outputs: `findings` (model references found) and `at-risk` (references to retired or soon-to-retire models).

Model IDs written the Amazon Bedrock way (`anthropic.claude-…-v1:0`, including ARNs), the Google Vertex AI way (`claude-…@20240620`) or with a router prefix (`openrouter/openai/gpt-4`, `vertex_ai/…`) are recognized too. Azure OpenAI deployments follow Microsoft's own retirement dates and are not checked. Mentions in Markdown and text files, such as a changelog, are reported as notices but never fail the build.

Drift tests make two API calls per prompt: one to the current model, one to the replacement. A prompt without `model` is tested on the model in your code that retires first. Calls time out after two minutes and are retried once if the provider is busy. When a provider names a replacement that is itself being retired, Driftline points to the model at the end of that chain.

API keys are read from `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and `GEMINI_API_KEY` (or `GOOGLE_API_KEY`).

## How results are scored

| Result | Meaning |
|---|---|
| ✅ Same | Similarity 0.90 or higher |
| 🟡 Changed | Similarity 0.60–0.90, or the current model is already retired and the new answer needs review |
| 🔴 Broken | Similarity below 0.60, or `expect: json` and the new answer is not valid JSON |

Text is compared with word and word-pair overlap. JSON is compared field by field.

## Run it locally

```sh
node src/cli.js path/to/your/repo
```

## Retirement data

[`registry/models.json`](registry/models.json) is maintained by hand from the official pages ([OpenAI](https://developers.openai.com/api/docs/deprecations), [Anthropic](https://platform.claude.com/docs/en/about-claude/model-deprecations), [Google](https://ai.google.dev/gemini-api/docs/deprecations)) and records the date it was last checked. Google publishes only the *earliest* possible shutdown date, so Driftline reports those models as "may stop working" rather than "retired". Anthropic's "not sooner than" dates are informational and never trigger a warning. Audio, image, video and embedding models are scanned and reported too, but only text models are drift-tested.

## Development

```sh
npm test
```

No dependencies. Node 20 or later.

## License

[Elastic License 2.0](LICENSE). You can use Driftline for free in your own CI. You may not offer it as a hosted service, or remove or work around the Pro license-key check.
