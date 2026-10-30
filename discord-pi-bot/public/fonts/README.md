# Local font assets

The console works without network fonts — nothing here is fetched at runtime,
which matters because the app is served through Home Assistant ingress on a
Pi that may have no outbound access.

## Bundled face

| File | Family | Used for |
| --- | --- | --- |
| `geist-sans.woff2` | Geist (variable weight 100–900) | text: a friendlier face for the Swiss Black look |
| `geist-mono.woff2` | Geist Mono (variable weight 100–900) | times, model names and code |

Declared via `@font-face` at the top of `styles.css`, with system fallbacks
so the layout holds if a file is ever missing.

## Licence

Geist and Geist Mono are by Vercel, under the SIL Open Font License 1.1
(https://github.com/vercel/geist-font). `geist-sans.woff2` is
`Geist-Variable.woff2` from the `geist` npm package, 1.8.2.
