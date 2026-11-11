# Contributing

Thanks for wanting to help. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug

[Open an issue](https://github.com/OwenWright8/docket/issues/new) with:

- the Docket version (Settings → About), your AI server (Ollama, LM Studio…) and the model
- what you typed or which email it was about (remove anything private), what you expected and what happened
- anything relevant from the **Activity** page or `docker compose logs docket`

Remove email addresses, passwords and keys before pasting logs or settings.

## Making a change

Docket is a small codebase on purpose: a Node 24 server (TypeScript run directly, built-in SQLite, Fastify) and a React + Tailwind UI.

```sh
npm ci
npm run dev       # API on :8585, UI on http://localhost:5173
npm test          # unit tests + the API end to end against a fake Ollama and mailbox
npm run typecheck
```

`npm run build && npm run dev:demo` runs everything against the fakes in `scripts/fakes.ts`, with sample email.

A few house rules:

- **Never write to a mailbox.** Folders are opened read-only and nothing is flagged, moved or deleted.
- **Check everything the model says.** Every reply is constrained to a JSON schema and then validated field by field (`cleanAiTask`, `aiTriageEmail` in `server/ai.ts`). Don't trust a date, a category or a repeat because the model produced it.
- **Everything works without the AI.** A feature that needs the model needs a fallback, even a plain one.
- **If a real model and the fake disagree, the fake is wrong.** When you fix a bug a real model showed you, teach `scripts/fakes.ts` to behave the same way, and add a test that fails without your fix.
- **Migrations are append-only.** Never edit one that has shipped in a release; add a new one to the end of the list in `server/db.ts`.
- **Write UI text for the person using it.** Plain words, and say what will happen ("you'll get a push at 5 PM"), not how.
- **Update the README** when a setting or a self-hosting step changes.

Label your pull request `feature`, `fix`, `self-hosting` or `breaking`; the release notes are grouped by label.

## License

By contributing, you agree your contribution is released under the [MIT License](LICENSE).
