"""The root site job's value rules (ADR 0059): a request file, checked again.

They mirror packages/contracts/src/site.ts, which the API checks first, and
trust nothing the API checked. packaging/site/tests/fixtures/values.json holds
values both must agree on. Every free-text value reaches a root Ansible run,
so braces and control characters are refused in every field, and then each
field's own pattern applies.

Python standard library only, as the job that imports it (ADR 0030).
"""

import json
import re
import urllib.parse

KINDS = ("proxy-hosts", "lti-platforms", "address", "signin", "keep", "rollback")
PROVIDERS = ("dex", "entra", "google", "oidc")
# Loopback ports Portikus's own services use; packages/contracts SITE_RESERVED_PORTS.
RESERVED_PORTS = (3000, 3001, 3128, 3129, 3130, 3199, 5000, 5001, 5300, 5398, 5399, 5432, 5556, 5557,
                  7400, 8792, 8796)
MAX_PROXY_HOSTS = 50
MAX_PLATFORMS = 20
MAX_DEPLOYMENT_IDS = 20
MAX_GOOGLE_DOMAINS = 20

# zod's uuid(), lower case as the API writes it.
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", re.ASCII)
DATETIME_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?Z", re.ASCII)
# packages/contracts host-name.ts: labels only, no leading or trailing dot.
HOST_RE = re.compile(r"(?=.{1,253}\Z)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
                     r"(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*", re.ASCII)
# The debconf question's host-name rule: lower case, at least one dot.
SITE_HOST_RE = re.compile(r"([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?", re.ASCII)
IDENTIFIER_RE = re.compile(r"[A-Za-z0-9._~:@/+=-]+", re.ASCII)
GROUP_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9 ._:@/=,()+-]*", re.ASCII)
TENANT_RE = re.compile(r"[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}", re.ASCII)
CLAIM_RE = re.compile(r"[A-Za-z0-9_.:/-]+", re.ASCII)
# JavaScript's \s, which the contract's patterns and String.prototype.trim use.
JS_SPACE = "".join(chr(c) for c in (0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, *range(0x2000, 0x200B),
                                     0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF))
OIDC_ISSUER_RE = re.compile(r"https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[^" + re.escape(JS_SPACE) + r"?#]*)?")
# Printable ASCII: stricter than the browser's URL parser, which would percent-encode the rest.
URL_RE = re.compile(r"https://[!-~]+", re.ASCII)


class Refused(Exception):
    """A request the job will not apply; `code` is one of the job's CODES."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


# jscpd:ignore-start -- each root job is a standalone script, so this stays a copy of the alerts job's.
def _no_duplicates(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise ValueError("duplicate key")
        out[key] = value
    return out


def parse_json(raw):
    try:
        text = raw.decode("utf-8") if isinstance(raw, bytes) else raw
        return json.loads(text, object_pairs_hook=_no_duplicates)
    except (UnicodeDecodeError, ValueError):
        raise Refused("invalid_request")


def _keys(obj, required, optional=()):
    if not isinstance(obj, dict):
        raise Refused("invalid_request")
    keys = set(obj)
    if not set(required) <= keys or not keys <= set(required) | set(optional):
        raise Refused("invalid_request")
# jscpd:ignore-end


def js_length(value):
    """A string's length as JavaScript counts it, in UTF-16 code units."""
    return len(value.encode("utf-16-le", "surrogatepass")) // 2


def is_site_text(value):
    """No braces, a template's delimiters, and no C0, DEL or C1 control character."""
    return not any(c in "{}" or ord(c) < 0x20 or 0x7F <= ord(c) <= 0x9F for c in value)


def site_text(value, max_length):
    if not isinstance(value, str) or js_length(value) > max_length or not is_site_text(value):
        raise Refused("invalid_value")
    return value


def is_host_name(value):
    return bool(HOST_RE.fullmatch(value)) and not value.rsplit(".", 1)[-1].isdigit()


def check_proxy_host(value):
    """A host the API may reach through the egress proxy: never an address, a port or a URL."""
    if not is_host_name(site_text(value, 253)):
        raise Refused("invalid_value")
    return value


def check_site_host(value):
    """The site's host name or a Google domain: lower case, at least one dot."""
    if not SITE_HOST_RE.fullmatch(site_text(value, 253)) or not is_host_name(value):
        raise Refused("invalid_value")
    return value


def check_https_url(value, default_port):
    """An https URL with a host name and no user name; default_port also refuses any port but 443."""
    if not URL_RE.fullmatch(site_text(value, 500)) or "\\" in value:
        raise Refused("invalid_value")
    try:
        parts = urllib.parse.urlsplit(value)
        port = parts.port
    except ValueError:
        raise Refused("invalid_value")
    if "@" in parts.netloc or not is_host_name((parts.hostname or "").lower()):
        raise Refused("invalid_value")
    if default_port and port not in (None, 443):
        raise Refused("invalid_value")
    return value


def url_host(url):
    return (urllib.parse.urlsplit(url).hostname or "").lower()


def check_identifier(value):
    if not IDENTIFIER_RE.fullmatch(site_text(value, 255)):
        raise Refused("invalid_value")
    return value


def check_group(value):
    if not GROUP_RE.fullmatch(site_text(value, 200)):
        raise Refused("invalid_value")
    return value


def check_tenant(value):
    if not isinstance(value, str) or not TENANT_RE.fullmatch(value):
        raise Refused("invalid_value")
    return value


def check_oidc_issuer(value):
    if not OIDC_ISSUER_RE.fullmatch(site_text(value, 500)):
        raise Refused("invalid_value")
    return value


def check_groups_claim(value):
    if not CLAIM_RE.fullmatch(site_text(value, 100)):
        raise Refused("invalid_value")
    return value


def check_client_secret(value):
    if js_length(site_text(value, 500)) < 16:
        raise Refused("invalid_value")
    return value


def check_platform_name(value):
    if site_text(value, 60).strip(JS_SPACE) == "":
        raise Refused("invalid_value")
    return value


def check_port(value):
    """443, or 1024 to 65535 and not a port Portikus uses. bool is an int in Python, so it is refused first."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) \
            or (isinstance(value, float) and not value.is_integer()):
        raise Refused("invalid_value")
    port = int(value)
    if port in RESERVED_PORTS:
        raise Refused("reserved_port")
    if port != 443 and not 1024 <= port <= 65535:
        raise Refused("invalid_value")
    return port


def _list(value, max_length, min_length=0):
    if not isinstance(value, list):
        raise Refused("invalid_value")
    if len(value) > max_length:
        raise Refused("too_many")
    if len(value) < min_length:
        raise Refused("invalid_value")
    return value


def _unique(values):
    if len(set(values)) != len(values):
        raise Refused("duplicate")
    return values


def check_hosts(value):
    return _unique([check_proxy_host(host) for host in _list(value, MAX_PROXY_HOSTS)])


def check_platform(platform):
    """One platform in the platforms-file version 1 shape (ADR 0025): HTTPS only, never a mock."""
    _keys(platform, ["name", "issuer", "clientId", "authLoginUrl", "keysetUrl", "deploymentIds", "mock"],
          ["authTokenUrl"])
    if platform["mock"] is not False:
        raise Refused("mock_platform" if platform["mock"] is True else "invalid_value")
    out = {
        "name": check_platform_name(platform["name"]),
        "issuer": check_https_url(platform["issuer"], False),
        "clientId": check_identifier(platform["clientId"]),
        "authLoginUrl": check_https_url(platform["authLoginUrl"], False),
        "keysetUrl": check_https_url(platform["keysetUrl"], True),
    }
    if "authTokenUrl" in platform:
        out["authTokenUrl"] = check_https_url(platform["authTokenUrl"], True)
    out["deploymentIds"] = [check_identifier(d) for d in _list(platform["deploymentIds"], MAX_DEPLOYMENT_IDS, 1)]
    out["mock"] = False
    return out


def check_platforms(value):
    platforms = [check_platform(p) for p in _list(value, MAX_PLATFORMS)]
    _unique([p["name"] for p in platforms])
    _unique([(p["issuer"], p["clientId"]) for p in platforms])
    return platforms


def check_trial_ref(value):
    if not isinstance(value, str) or not UUID_RE.fullmatch(value):
        raise Refused("invalid_request")
    return value


SIGNIN_NEEDS = {"dex": (), "entra": ("entraTenantId", "clientId"), "google": ("googleDomains", "clientId"),
                "oidc": ("oidcIssuer", "clientId")}
SIGNIN_OPTIONAL = ("entraTenantId", "googleDomains", "oidcIssuer", "clientId", "groupsClaim", "groups")


def check_signin(doc):
    """The signin body, every optional field checked whether or not its provider uses it, as zod does."""
    provider = doc["provider"]
    if not isinstance(provider, str) or provider not in PROVIDERS:
        raise Refused("invalid_value")
    out = {"provider": provider}
    if "entraTenantId" in doc:
        out["entraTenantId"] = check_tenant(doc["entraTenantId"])
    if "googleDomains" in doc:
        domains = _list(doc["googleDomains"], MAX_GOOGLE_DOMAINS, 1)
        out["googleDomains"] = _unique([check_site_host(d) for d in domains])
    if "oidcIssuer" in doc:
        out["oidcIssuer"] = check_oidc_issuer(doc["oidcIssuer"])
    if "clientId" in doc:
        out["clientId"] = check_identifier(doc["clientId"])
    if "groupsClaim" in doc:
        out["groupsClaim"] = check_groups_claim(doc["groupsClaim"])
    if "groups" in doc:
        groups = doc["groups"]
        if not isinstance(groups, dict) or set(groups) != {"student", "instructor", "admin"}:
            raise Refused("invalid_value")
        out["groups"] = {role: check_group(groups[role]) for role in ("student", "instructor", "admin")}
    secret = doc["clientSecret"]
    out["clientSecret"] = None if secret is None else check_client_secret(secret)
    for field in SIGNIN_NEEDS[provider]:
        if field not in out:
            raise Refused("invalid_value")
    if provider == "dex" and out["clientSecret"] is not None:
        raise Refused("invalid_value")
    return out


BODY_KEYS = {
    "proxy-hosts": (["hosts"], ()),
    "lti-platforms": (["platforms"], ()),
    "address": (["host", "port"], ()),
    "signin": (["provider", "clientSecret"], SIGNIN_OPTIONAL),
    "keep": (["trialId"], ()),
    "rollback": (["trialId"], ()),
}


def check_request(doc, job_id):
    """A whole request file: the head the API adds, then the kind's own body."""
    if not isinstance(doc, dict) or not isinstance(doc.get("kind"), str) or doc["kind"] not in KINDS:
        raise Refused("invalid_request")
    kind = doc["kind"]
    required, optional = BODY_KEYS[kind]
    _keys(doc, ["version", "id", "kind", "requestedAt", *required], optional)
    if type(doc["version"]) is not int or doc["version"] != 1 or doc["id"] != job_id \
            or not isinstance(doc["requestedAt"], str) or not DATETIME_RE.fullmatch(doc["requestedAt"]):
        raise Refused("invalid_request")
    if kind == "proxy-hosts":
        return {"hosts": check_hosts(doc["hosts"])}
    if kind == "lti-platforms":
        return {"platforms": check_platforms(doc["platforms"])}
    if kind == "address":
        return {"host": check_site_host(doc["host"]), "port": check_port(doc["port"])}
    if kind == "signin":
        return check_signin(doc)
    return {"trialId": check_trial_ref(doc["trialId"])}


def identity(answers):
    """What a client secret was issued for: the provider, its tenant or issuer, and the client ID."""
    provider = answers.get("provider", "dex")
    return (provider,
            answers.get("entra_tenant_id", "") if provider == "entra" else "",
            answers.get("oidc_issuer", "") if provider == "oidc" else "",
            answers.get("client_id", ""))
