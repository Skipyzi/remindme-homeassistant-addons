# Local font assets

The harness works without network fonts — nothing here is fetched at runtime,
which matters because the add-on is served through Home Assistant ingress on a
Pi that may have no outbound access.

## Bundled faces

| File | Family | Used for |
| --- | --- | --- |
| `big-shoulders-stencil-text-700.woff2` | Big Shoulders Stencil Text, weight 700 | stencil display type — wordmark, headings (`--display`) |
| `share-tech-mono.woff2` | Share Tech Mono, weight 400 | everything else (`--mono`) |

Both are Latin subsets from Google Fonts, declared via `@font-face` at the top
of `styles.css`. System fallback stacks remain in `--display` and `--mono` so
the layout holds if a file is ever missing.

## Licence

Both faces are licensed under the **SIL Open Font License 1.1**, which permits
redistribution alongside this add-on provided the licence travels with them and
they are not sold on their own.

- Big Shoulders Stencil Text — © The Big Shoulders Project Authors
  <https://fonts.google.com/specimen/Big+Shoulders+Stencil+Text>
- Share Tech Mono — © Carrois Apostrophe
  <https://fonts.google.com/specimen/Share+Tech+Mono>

Full licence text: <https://openfontlicense.org>

## Replacing or extending

Drop a new `.woff2` here and update the matching `@font-face` `src` in
`styles.css`. To cover more scripts, re-export a wider subset — these files
carry Latin only, which is why they are ~14 KB each.
