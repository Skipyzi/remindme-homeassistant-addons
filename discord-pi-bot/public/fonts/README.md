# Local font assets

The harness works without network fonts — nothing here is fetched at runtime,
which matters because the add-on is served through Home Assistant ingress on a
Pi that may have no outbound access.

## Bundled faces

| File | Family | Used for |
| --- | --- | --- |
| `fraunces-normal-300-700.woff2`, `fraunces-italic-300-700.woff2` | Fraunces (variable: weight, optical size) | display — wordmark, greeting, headings, big readings (`--font-display`) |
| `ibm-plex-sans-normal-400-600.woff2`, `ibm-plex-sans-italic-400.woff2` | IBM Plex Sans (variable weight) | reading text — replies, cards, panels (`--font`) |
| `ibm-plex-mono-normal-400.woff2`, `ibm-plex-mono-normal-500.woff2` | IBM Plex Mono | code, figures and small details (`--font-mono`) |

All are Latin subsets from Google Fonts, declared via `@font-face` at the top
of `styles.css`. System fallback stacks remain in the variables so the layout
holds if a file is ever missing.

## Licence

All three families are licensed under the **SIL Open Font License 1.1**, which
permits redistribution alongside this add-on provided the licence travels with
them and they are not sold on their own.

- Fraunces — © The Fraunces Project Authors
  <https://fonts.google.com/specimen/Fraunces>
- IBM Plex Sans, IBM Plex Mono — © IBM Corp.
  <https://github.com/IBM/plex>

Full licence text: <https://openfontlicense.org>

## Replacing or extending

Drop a new `.woff2` here and update the matching `@font-face` `src` in
`styles.css`. To cover more scripts, re-export a wider subset.
