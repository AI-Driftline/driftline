# Registry rules

How `registry/models.json` is kept in sync with the providers' deprecation pages. A scheduled agent follows these rules every day; people editing by hand follow them too.

## Sources

- OpenAI: https://developers.openai.com/api/docs/deprecations
- Anthropic: https://platform.claude.com/docs/en/about-claude/model-deprecations
- Google: https://ai.google.dev/gemini-api/docs/deprecations

Only these three pages count. No blog posts, forum threads or emails.

## Entry fields

`id`, `provider` (openai | anthropic | google), `retires` (YYYY-MM-DD), `qualifier`, optional `replacement`, optional `replacement_alt`, optional `replacement_note`, optional `previous_replacement` + `replacement_changed` (see below), `kind` (omit for text; else audio | image | video | embedding | moderation | agent), `announced` (date of the notice, when the page gives one), `routes: true` (see below).

## Qualifiers

- OpenAI shutdown dates → `exact`.
- Anthropic "not sooner than" / retirement dates → `not-before` unless the page states a fixed retirement date, then `exact`.
- Google table "shutdown date" → `earliest` (Google says these are earliest possible dates).
- Google "effective <date>, requests to X route to Y" → `exact` with `routes: true`; `retires` = the date routing starts; `replacement` = Y.

## What to change

- New model ID with a date on a page → add it. Use the exact ID spelling from the page. One entry per ID; a row listing an alias and a snapshot ("gpt-image-2 | gpt-image-2-2026-04-21") gives two entries.
- Changed date or replacement → update the entry.
- Changed replacement → also set `previous_replacement` to the old value and `replacement_changed` to today's date (the day the change was seen). If it changes again, overwrite both. Reports, alerts and the outreach list use these to tell people the advice changed.
- Replacement written as "X or Y" → `replacement` = X, `replacement_alt` = Y (both are shown to users). Three or more options: X, then explain the rest in `note`.
- Replacement with an extra instruction, e.g. "gpt-6.1-sol (reasoning.mode: pro) in the Responses API" → `replacement` = the model ID only (`gpt-6.1-sol`), `replacement_note` = the rest in plain words (`reasoning.mode: pro, in the Responses API`). Keep the note when the replacement changes, if the page still gives it.
- No date given ("no shutdown date announced", "N/A") → leave the model out.
- A model that disappears from a page → leave it in (pages drop old rows).
- A model still on the page but whose date was replaced by "no shutdown date announced" / "to be announced" → remove it (it's no longer scheduled), and say so in `note` with the date.
- Never add aliases the page does not name (e.g. `gpt-4o` when only snapshots are listed).
- Set `checked` to today's date whenever the three pages were compared, even if nothing else changed.
- If the page is ambiguous or contradicts itself, keep the later date and say so in `note`.

## Before pushing

`node tools/check-pages.mjs` must report that the registry matches the provider pages. It compares every recent and upcoming entry's date and replacement with the page text by script, so it catches rows that were missed while reading. If it lists a difference you decided to keep (e.g. an ambiguous page), explain it in `note`.

`npm test` must pass. Commit message: `Registry re-checked YYYY-MM-DD: <what changed>` or `Registry re-checked YYYY-MM-DD: no changes`. No co-author lines, and never `[minor]` (that marks new features; registry updates are patch releases). Pushing to `main` starts the release workflow (new v0.x.y tag with the last number raised, v0 moved), and the website rebuilds from it.
