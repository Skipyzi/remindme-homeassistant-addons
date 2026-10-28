# Local font assets

The console works without network fonts — nothing here is fetched at runtime,
which matters because the app is served through Home Assistant ingress on a
Pi that may have no outbound access.

## Bundled face

| File | Family | Used for |
| --- | --- | --- |
| `geist-mono.woff2` | Geist Mono (variable weight 100–900) | everything: the console matches the Swiss Black Home Assistant theme |

Declared via `@font-face` at the top of `styles.css`, with a system monospace
fallback so the layout holds if the file is ever missing.

## Licence

Geist Mono is by Vercel, under the SIL Open Font License 1.1
(https://github.com/vercel/geist-font).
