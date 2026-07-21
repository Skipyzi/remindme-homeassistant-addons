"""Write SearXNG's settings.yml from the add-on options.

Home Assistant is the source of truth: the options are the settings, and
this file is rewritten on every start. Only the pieces that matter for a
private, LAN-facing instance driving an automated JSON API are set; the
rest is left to SearXNG's defaults through `use_default_settings`.

The secret key is the exception — it is generated once and kept in /data,
so signed sessions survive a restart instead of being invalidated each
boot.
"""

import json
import os
import pathlib
import secrets

OPTIONS = pathlib.Path("/data/options.json")
SECRET = pathlib.Path("/data/secret_key")


def load_options() -> dict:
    try:
        return json.loads(OPTIONS.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def secret_key() -> str:
    if not SECRET.exists():
        SECRET.write_text(secrets.token_hex(32), encoding="utf-8")
        SECRET.chmod(0o600)
    return SECRET.read_text(encoding="utf-8").strip()


def main() -> None:
    options = load_options()
    instance_name = options.get("instance_name") or "SearXNG"
    base_url = options.get("base_url") or ""

    # json.dumps yields a correctly quoted YAML scalar for any string, so a
    # name or URL with a colon or quote in it cannot break the document.
    lines = [
        "# Generated from the add-on options on every start. Change the",
        "# options in Home Assistant, not this file — edits here are lost.",
        "use_default_settings: true",
        "server:",
        f"  secret_key: {json.dumps(secret_key())}",
        # Off, so the add-on's own JSON requests are never rate-limited or",
        # turned away as "not a browser". The instance is not public.
        "  limiter: false",
        "  public_instance: false",
        "  image_proxy: true",
        f"  base_url: {json.dumps(base_url) if base_url else 'false'}",
        "general:",
        f"  instance_name: {json.dumps(instance_name)}",
        "search:",
        "  # json is what the RemindMe web_search tool reads; html is the UI.",
        "  formats:",
        "    - html",
        "    - json",
        # Turn off engines that cannot work on this box, so they stop failing
        # to load on every start and stop being queried on every search.
        # use_default_settings merges these by name, leaving every other
        # engine at its default. Delete an entry to bring that engine back.
        "engines:",
        # ahmia and torch search Tor onion services and need a Tor proxy.
        "  - name: ahmia",
        "    disabled: true",
        "  - name: torch",
        "    disabled: true",
        # Wikidata's SPARQL endpoint returns 403 to datacenter/self-hosted
        # IPs, so its infobox never initialises here. Web results are
        # unaffected; this only drops the Wikidata info panel.
        "  - name: wikidata",
        "    disabled: true",
        "",
    ]

    target = pathlib.Path(
        os.environ.get("__SEARXNG_SETTINGS_PATH", "/etc/searxng/settings.yml")
    )
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("\n".join(lines), encoding="utf-8")
    print(f"[searxng] wrote {target} (instance: {instance_name!r})")


if __name__ == "__main__":
    main()
