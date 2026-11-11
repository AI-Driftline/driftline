# Registry rules

How `registry/models.json` is kept in sync with the providers' deprecation pages. A scheduled agent follows these rules every day; people editing by hand follow them too.

## Sources

- OpenAI: https://developers.openai.com/api/docs/deprecations
- Anthropic: https://platform.claude.com/docs/en/about-claude/model-deprecations
- Google: https://ai.google.dev/gemini-api/docs/deprecations

Only these three pages count. No blog posts, forum threads or emails.

## Entry fields

`id`, `provider` (openai | anthropic | google), `retires` (YYYY-MM-DD), `qualifier`, optional `replacement`, `kind` (omit for text; else audio | image | video | embedding | moderation | agent), `announced` (date of the notice, when the page gives one), `routes: true` (see below).

## Qualifiers

- OpenAI shutdown dates → `exact`.
- Anthropic "not sooner than" / retirement dates → `not-before` unless the page states a fixed retirement date, then `exact`.
- Google table "shutdown date" → `earliest` (Google says these are earliest possible dates).
- Google "effective <date>, requests to X route to Y" → `exact` with `routes: true`; `retires` = the date routing starts; `replacement` = Y.

## What to change

- New model ID with a date on a page → add it. Use the exact ID spelling from the page. One entry per ID; a row listing an alias and a snapshot ("gpt-image-2 | gpt-image-2-2026-04-21") gives two entries.
- Changed date or replacement → update the entry.
- Replacement written as "X or Y" → use X.
- No date given ("no shutdown date announced", "N/A") → leave the model out.
- A model that disappears from a page → leave it in (pages drop old rows).
- Never add aliases the page does not name (e.g. `gpt-4o` when only snapshots are listed).
- Set `checked` to today's date whenever the three pages were compared, even if nothing else changed.
- If the page is ambiguous or contradicts itself, keep the later date and say so in `note`.

## Before pushing

`npm test` must pass. Commit message: `Registry re-checked YYYY-MM-DD: <what changed>` or `Registry re-checked YYYY-MM-DD: no changes`. No co-author lines. Pushing to `main` starts the release workflow (new v0.1.x tag, v0 moved), and the website rebuilds from it.
