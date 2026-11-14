# Driftline

See how your prompts change **before** an AI model is retired.

![Driftline flags retired and retiring models on the exact line of a pull request, then lists them in the job summary](docs/demo.gif)

Driftline is a GitHub Action. It finds the OpenAI, Anthropic, Google and Amazon Bedrock model IDs in your code, checks them against the providers' published retirement dates, and runs your real prompts on both the current and the replacement model so you can see what changes before you switch.

It runs inside your own CI with your own API keys. There is no Driftline server: prompts go straight from your runner to your AI provider.

## What you get

- **Annotations** on the exact file and line of retired or retiring models (the 50 most urgent; the rest are in the report).
- **A report** in the job summary, and optionally a GitHub issue that updates itself on each run and closes itself once nothing is left to fix.
- **Drift tests (Pro):** each prompt in `.driftline/prompts.yml` runs on both models. You get a similarity score per prompt, and a hard failure if a JSON answer stops parsing.

Outside CI: `npx -y @aidriftline/driftline .` scans any repository once, an [MCP server](#mcp-server) lets AI coding agents look up model IDs, and every model page at [aidriftline.com/models](https://aidriftline.com/models/) has free email alerts (30 days, 7 days and the day itself, plus date changes).

## Quick start

1. Copy [`examples/driftline.yml`](examples/driftline.yml) to `.github/workflows/driftline.yml`.
2. Optional, for drift tests (Pro): copy [`examples/prompts.yml`](examples/prompts.yml) to `.driftline/prompts.yml` and add your provider API keys as repository secrets.
3. Activate your Pro key once per GitHub account or organization, from inside one of its repositories:

   ```sh
   npx @aidriftline/driftline activate <your-license-key>
   ```

   It prints a license code. Save that code as the secret `DRIFTLINE_LICENSE_KEY`. A key works on up to 3 GitHub accounts or organizations; `npx @aidriftline/driftline deactivate <code>` frees one.

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

No install, no key:

```sh
npx @aidriftline/driftline path/to/your/repo          # report
npx @aidriftline/driftline path/to/your/repo --json   # same, as JSON
```

Exit code 1 means a retired model is used in code.

## For AI coding agents

If you are an agent (Claude Code, Cursor, Copilot, Codex…) changing code that calls OpenAI, Anthropic or Google: run `npx -y @aidriftline/driftline . --json` before you pick or keep a model ID, and do not introduce an ID whose `status` is `retired` or `at-risk`. Without a shell, look the ID up in [`registry/models.json`](registry/models.json) or at `https://aidriftline.com/models/<model-id>/`. More, including a snippet for `AGENTS.md` / `CLAUDE.md`: [aidriftline.com/agents](https://aidriftline.com/agents/).

### MCP server

Driftline also runs as an [MCP](https://modelcontextprotocol.io) server, so your agent can ask it directly. Tools: `check_models` (status, date and replacement for a list of IDs), `scan_project` (retired and retiring IDs in a folder, with file and line) and `upcoming_retirements` (what retires in the next N days). It reads the daily-updated list from aidriftline.com and falls back to the copy in the package when offline.

[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=driftline&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBhaWRyaWZ0bGluZS9kcmlmdGxpbmUiLCJtY3AiXX0%3D)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522driftline%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522%2540aidriftline%252Fdriftline%2522%252C%2522mcp%2522%255D%257D)

Claude Code:

```sh
claude mcp add driftline -- npx -y @aidriftline/driftline mcp
```

Cursor, Windsurf, Claude Desktop and other clients (`mcp.json` / `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "driftline": { "command": "npx", "args": ["-y", "@aidriftline/driftline", "mcp"] }
  }
}
```

Needs Node 20+. Free, no key.

## Retirement data

[`registry/models.json`](registry/models.json) comes from the official pages ([OpenAI](https://developers.openai.com/api/docs/deprecations), [Anthropic](https://platform.claude.com/docs/en/about-claude/model-deprecations), [Google](https://ai.google.dev/gemini-api/docs/deprecations)) and is kept in line with them automatically:

- A script compares every entry with those pages every 6 hours (date, replacement, new models on a page).
- An AI check runs daily, and right away when the script finds a difference. It follows written rules ([`docs/registry-rules.md`](docs/registry-rules.md)), and its changes ship only after they pass the same script and the test suite.
- Until a difference is fixed, the affected models are marked "under review" in reports, MCP answers and model pages, and email alerts for them wait, so nobody gets a wrong date.

Each entry records the date it was last checked. Google publishes only the *earliest* possible shutdown date, so Driftline reports those models as "may stop working" rather than "retired". Anthropic's "not sooner than" dates are informational and never trigger a warning. Audio, image, video and embedding models are scanned and reported too, but only text models are drift-tested. Some Google models are not shut down but *routed*: after the date, requests to the old ID are answered by the replacement model (`routes: true` in the registry). Driftline flags those too, because the call keeps working while the answers change.

Amazon Bedrock sets its own dates, per model and per region, and they often differ from the model maker's (Claude Opus 4.1 left Anthropic's API on 5 August 2026 but runs on Bedrock until 8 January 2027). Bedrock model IDs such as `us.anthropic.claude-opus-4-1-20250805-v1:0` or `meta.llama3-70b-instruct-v1:0` are checked against [Bedrock's own page](https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle-legacy.html), read by script every 6 hours. Reports show the earliest region's date, how the other regions differ, and when "extended access" (possibly higher prices) starts.

Every model also has its own page with the date, replacement and source: [aidriftline.com/models](https://aidriftline.com/models/).

## Versions

Releases are numbered `0.x.y`. A new `x` means new features; a new `y` means fixes or updated retirement data, which can ship several times a week. `uses: AI-Driftline/driftline@v0` always runs the newest release, and the Action reads the live retirement list at aidriftline.com either way, so a provider's change reaches you without a new version.

## Development

```sh
npm test
```

No dependencies. Node 20 or later.

## License

[Elastic License 2.0](LICENSE). You can use Driftline for free in your own CI. You may not offer it as a hosted service, or remove or work around the Pro license-key check.
