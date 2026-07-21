# SearXNG

A self-hosted, privacy-respecting metasearch engine, packaged as a Home
Assistant add-on. It runs the official [SearXNG](https://github.com/searxng/searxng)
image with two changes: the settings come from the add-on options, and the
**JSON search API is turned on** so other services — like the RemindMe
`web_search` tool — can query it without a paid search provider.

## Install

1. In Home Assistant, go to **Settings → Add-ons → Add-on Store**, open the
   three-dot menu, and add this repository if you have not already:
   `https://github.com/skipyzi/remindme-homeassistant-addons`
2. Install **SearXNG**, then **Start** it. The first start pulls the upstream
   image and builds the wrapper, which takes a few minutes on a Pi.

## Using it

- **From your network:** browse to `http://<home-assistant-ip>:8181`. The
  host port is `8181` by default; change it under the add-on's **Network**
  tab if it clashes with something.
- **From another add-on** (same Home Assistant): reach it at
  `http://searxng:8080`. Nothing needs the host port for this — add-ons on
  the same Home Assistant resolve each other by name.
- **JSON API:** append `format=json`, for example
  `http://searxng:8080/search?q=raspberry+pi&format=json`. This is off in a
  stock SearXNG; this add-on enables it.

## Options

| Option          | What it does                                                        |
| --------------- | ------------------------------------------------------------------- |
| `instance_name` | The name shown in the web UI.                                       |
| `base_url`      | Set only if you put SearXNG behind a reverse proxy at a public URL. Leave blank otherwise. |

The options are the source of truth: `settings.yml` is rewritten from them
on every start, so edit the options in Home Assistant rather than the file.
A secret key is generated once and kept in `/data/secret_key` so signed
sessions survive a restart.

## Notes

- **No sidebar panel.** SearXNG builds absolute URLs for its assets and does
  not follow Home Assistant's ingress subpath, so it is reached by port
  rather than through an ingress panel.
- **The limiter is off.** The instance is meant for your own network and for
  driving an automated API, where SearXNG's bot-detection would otherwise
  turn requests away. Do not expose it directly to the public internet.
- **Pinning.** The image tracks `searxng:latest` and updates when the add-on
  is rebuilt. To pin a version, change the `FROM` line in the `Dockerfile`.

## Pointing RemindMe at it

Once SearXNG is running, the RemindMe add-on can use it for `web_search`
instead of Exa by pointing at `http://searxng:8080`. See the RemindMe
add-on for its `web_search` configuration.
