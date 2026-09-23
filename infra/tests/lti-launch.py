#!/usr/bin/env python3
"""Drive an LTI 1.3 launch against Portikus, for the smoke and security tests.

Runs on the platform VM (it is fed to `python3 -` over ssh), where the public
host name resolves to Caddy and Caddy's root certificate is installed.  It
prints one JSON object and never prints a token, state or nonce.

  launch MOCK_URL SITE PERSON COURSE
      The whole browser flow with the mock LMS (docs/EPIC-13.md, "The mock
      LMS"): the mock's launch page and form, /lti/login, the mock's /authorize, then
      /lti/launch.  Then asks /auth/me, /courses and one admin route with the
      new session, and posts the same id_token and state a second time.

  forge SITE ISSUER CLIENT_ID
      Starts a real login for a registered platform, then posts tokens no
      platform signed to /lti/launch: one with alg "none", one with a made-up
      RS256 signature, one with no state cookie, and the used state again.
"""
import base64
import hashlib
import http.cookiejar
import json
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

CA = "/etc/portikus/caddy-root.crt"
# One cookie per login, named from the state's hash (docs/EPIC-13.md, ruling 16).
STATE_COOKIE_PREFIX = "__Host-portikus_lti_state_"
SESSION_COOKIE = "__Host-portikus_session"
ADMIN_ROUTE = "/admin/users"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def opener(jar, follow):
    handlers = [
        urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=CA)),
        urllib.request.HTTPCookieProcessor(jar),
    ]
    if not follow:
        handlers.append(NoRedirect())
    return urllib.request.build_opener(*handlers)


def request(op, url, data=None, headers=None):
    """Returns (status, headers, body); a 3xx or error status is not raised."""
    body = urllib.parse.urlencode(data).encode() if data is not None else None
    req = urllib.request.Request(url, data=body, headers=headers or {})
    try:
        with op.open(req, timeout=15) as res:
            return res.status, res.headers, res.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as err:
        return err.code, err.headers, err.read().decode("utf-8", "replace")


def form_fields(page):
    """The action and hidden inputs of the mock's auto-submitting form."""
    action = re.search(r'<form[^>]*action="([^"]*)"', page)
    fields = {
        name: value.replace("&quot;", '"').replace("&#39;", "'").replace("&lt;", "<")
        .replace("&gt;", ">").replace("&amp;", "&")
        for name, value in re.findall(r'<input type="hidden" name="([^"]*)" value="([^"]*)"', page)
    }
    return (action.group(1).replace("&amp;", "&") if action else None), fields


def cookie(jar, name):
    return next((c for c in jar if c.name == name), None)


def state_cookie_name(state):
    return STATE_COOKIE_PREFIX + hashlib.sha256(state.encode()).hexdigest()[:16]


def state_cookie_attributes(headers, state):
    """The state cookie's attributes, sorted and lower-cased, Expires left out."""
    for line in headers.get_all("Set-Cookie") or []:
        if line.startswith(state_cookie_name(state) + "="):
            parts = (part.strip().lower() for part in line.split(";")[1:])
            return ";".join(sorted(p for p in parts if p and not p.startswith("expires=")))
    return ""


def launch(mock, site, person, course):
    jar = http.cookiejar.CookieJar()
    follow, stay = opener(jar, True), opener(jar, False)
    out = {}

    # The launch page carries a per-process form token that /start requires.
    status, _, page = request(follow, f"{mock}/")
    token = re.search(r'name="form_token" value="([^"]*)"', page)
    out["mock_page"] = status
    status, _, page = request(follow, f"{mock}/start", {
        "person": person, "course": course, "form_token": token.group(1) if token else ""})
    action, fields = form_fields(page)
    out["mock_start"] = status
    if action != f"{site}/lti/login":
        out["error"] = "the mock's form does not post to this site's /lti/login"
        return out

    status, headers, _ = request(stay, action, fields)
    out["login"] = status
    location = headers.get("Location", "")
    state = (urllib.parse.parse_qs(urllib.parse.urlsplit(location).query).get("state") or [""])[0]
    out["state_cookie"] = state_cookie_attributes(headers, state)
    out["login_redirect_origin"] = urllib.parse.urlsplit(location)._replace(path="", query="", fragment="").geturl()

    status, _, page = request(follow, location)
    action, fields = form_fields(page)
    out["authorize"] = status
    if action != f"{site}/lti/launch" or "id_token" not in fields:
        out["error"] = "the mock's /authorize did not post an id_token to /lti/launch"
        return out

    status, headers, _ = request(stay, action, fields)
    out["launch"] = status
    out["launch_location"] = headers.get("Location", "")
    out["session"] = cookie(jar, SESSION_COOKIE) is not None

    status, _, body = request(stay, f"{site}/auth/me")
    out["me"] = status
    if status == 200:
        me = json.loads(body)
        out["role"] = me.get("role")
    status, _, body = request(stay, f"{site}/courses")
    out["courses"] = status
    if status == 200:
        courses = json.loads(body)
        out["course_titles"] = [c.get("title") for c in courses]
        if courses:
            status, _, body = request(stay, f"{site}/courses/{courses[0]['id']}/members")
            out["members"] = status
            if status == 200:
                members = json.loads(body).get("members", [])
                out["member_names"] = sorted(m.get("displayName") for m in members)
                out["member_fields"] = sorted({key for m in members for key in m})
    status, _, _ = request(stay, f"{site}{ADMIN_ROUTE}")
    out["admin"] = status

    # The same token and state again, state cookie included: the state row
    # went with the first launch, so this is refused.
    replay, replay_jar = with_state_cookie(site, fields.get("state", ""))
    status, _, _ = request(replay, action, fields)
    out["replay"] = status
    out["replay_session"] = cookie(replay_jar, SESSION_COOKIE) is not None
    return out


def with_state_cookie(site, state):
    """An opener whose jar holds the state cookie, as the browser that started the login would."""
    jar = http.cookiejar.CookieJar()
    jar.set_cookie(http.cookiejar.Cookie(
        0, state_cookie_name(state), state, None, False, urllib.parse.urlsplit(site).hostname,
        False, False, "/", True, True, None, False, None, None, {}))
    return opener(jar, False), jar


def b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def forged_token(site, issuer, client_id, alg):
    now = int(time.time())
    header = {"alg": alg, "typ": "JWT", "kid": "forged"}
    claims = {
        "iss": issuer,
        "aud": client_id,
        "sub": "forged-subject",
        "iat": now,
        "exp": now + 300,
        "nonce": "forged",
        "https://purl.imsglobal.org/spec/lti/claim/message_type": "LtiResourceLinkRequest",
        "https://purl.imsglobal.org/spec/lti/claim/version": "1.3.0",
        "https://purl.imsglobal.org/spec/lti/claim/target_link_uri": f"{site}/",
        "https://purl.imsglobal.org/spec/lti/claim/roles": [
            "http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor"
        ],
    }
    signature = "" if alg == "none" else b64(os.urandom(256))
    return f"{b64(json.dumps(header).encode())}.{b64(json.dumps(claims).encode())}.{signature}"


def start_login(site, issuer, client_id):
    """A real login: the jar gets the state cookie, the state comes back."""
    jar = http.cookiejar.CookieJar()
    stay = opener(jar, False)
    status, headers, _ = request(stay, f"{site}/lti/login", {
        "iss": issuer,
        "client_id": client_id,
        "login_hint": "sectest",
        "target_link_uri": f"{site}/",
    })
    query = urllib.parse.parse_qs(urllib.parse.urlsplit(headers.get("Location", "")).query)
    return status, stay, jar, (query.get("state") or [""])[0]


def forge(site, issuer, client_id):
    out = {}
    for name, alg in (("alg_none", "none"), ("bad_signature", "RS256")):
        status, stay, jar, state = start_login(site, issuer, client_id)
        out[f"{name}_login"] = status
        status, _, _ = request(stay, f"{site}/lti/launch", {
            "id_token": forged_token(site, issuer, client_id, alg), "state": state})
        out[name] = status
        out[f"{name}_session"] = cookie(jar, SESSION_COOKIE) is not None

    # No state cookie: a login-CSRF launch posted from another browser.
    status, _, _, state = start_login(site, issuer, client_id)
    status, _, _ = request(opener(http.cookiejar.CookieJar(), False), f"{site}/lti/launch", {
        "id_token": forged_token(site, issuer, client_id, "RS256"), "state": state})
    out["no_cookie"] = status

    # A state used once cannot be used again, cookie and all.
    status, stay, jar, state = start_login(site, issuer, client_id)
    token = forged_token(site, issuer, client_id, "RS256")
    request(stay, f"{site}/lti/launch", {"id_token": token, "state": state})
    replay, _ = with_state_cookie(site, state)
    status, _, _ = request(replay, f"{site}/lti/launch", {"id_token": token, "state": state})
    out["replayed_state"] = status
    return out


def main():
    if len(sys.argv) == 6 and sys.argv[1] == "launch":
        result = launch(*sys.argv[2:])
    elif len(sys.argv) == 5 and sys.argv[1] == "forge":
        result = forge(*sys.argv[2:])
    else:
        sys.exit(__doc__)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
