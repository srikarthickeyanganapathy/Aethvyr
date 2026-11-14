# Contributing

Thanks for helping improve Velostream. Bug reports, site compatibility reports, translations,
tests and code are all welcome.

## Reporting a bug

Open an issue with:

1. browser and version (Chrome, Edge, Kiwi, Firefox, Firefox for Android), and the Velostream
   version;
2. the page where it happens (or a description if it is private);
3. what you expected and what happened;
4. the console line starting with `[Velostream]` (DevTools → page → `player.html` frame), and for
   detection problems the popup's stream list.

**Do not ask for, or submit, support for DRM-protected services.** Velostream will not circumvent
DRM.

## Development

Setup, build, debugging and the test checklist are in
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md); the design is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```bash
npm install
npm run watch      # rebuild on save, then reload the extension
npm run lint
```

## Pull requests

- One topic per PR, with a description of what changed and how you tested it (browsers, pages).
- `npm run lint` passes, and `npm run build` succeeds for both targets.
- No remote code, CDNs, analytics or new permissions without discussion in an issue first.
- Keep the UI keyboard- and screen-reader accessible: real buttons with labels, focus handling,
  `announce()` for state changes, and respect for reduced motion and high contrast.
- New settings go through `DEFAULT_SETTINGS` and `mergeSettings()` (see
  [docs/SETTINGS.md](docs/SETTINGS.md)).
- Update the docs and [CHANGELOG.md](CHANGELOG.md) (*Unreleased* section) when behaviour changes.

## Commit messages

Use the imperative and a short scope, for example `player: keep GPU canvas upright in FSR`, or
`engine: resend in-flight requests after a reconnect`.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
