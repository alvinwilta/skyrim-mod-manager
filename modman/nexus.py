"""Nexus Mods access: public GraphQL for collections, browser-session link
generation (CDP), and plain-HTTP file downloads with resume."""

import logging
import os
import re
import time
import urllib.parse

import requests
from playwright.sync_api import sync_playwright

import subprocess

from .config import BROWSER_CMD, CDP_URL, DOWNLOADS_DIR, GAME, GAME_ID

log = logging.getLogger(__name__)

COLLECTION_QUERY = """
query CollectionRevisionMods($slug: String!, $revision: Int, $viewAdultContent: Boolean = false) {
  collectionRevision(slug: $slug, revision: $revision, viewAdultContent: $viewAdultContent) {
    externalResources { id name resourceType resourceUrl }
    modFiles { fileId optional file { fileId name scanned: scannedV2 size sizeInBytes version
      mod { adultContent author category game { id domainName } modId name pictureUrl summary version
        uploader { avatar memberId name } } } }
  }
}"""

BROWSER_HEADERS = {
    "Origin": "https://www.nexusmods.com",
    "Referer": "https://www.nexusmods.com/",
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
}

GENERATE_URL_JS = """
async ( body ) => {
    const r = await fetch( '/Core/Libs/Common/Managers/Downloads?GenerateDownloadUrl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
        body: body
    } );
    if ( r.status != 200 )
        throw new Error( 'GenerateDownloadUrl failed: ' + r.status );
    return ( await r.json() ).url;
}
"""


def retry(func, *args, tries=5, **kwargs):
    for attempt in range(tries):
        try:
            return func(*args, **kwargs)
        except Exception as e:
            log.info("attempt %d/%d failed: %s", attempt + 1, tries, e)
            time.sleep(1 + attempt)
    return None


def fetch_collection(url):
    """Fetch a collection modlist from a nexusmods collection URL.

    Returns a payload shaped like the CollectionRevisionMods response
    ({"data": {"collectionRevision": ...}}), or raises ValueError."""
    m = re.search(r"nexusmods\.com/games/[^/]+/collections/([^/?#]+)", url)
    if not m:
        raise ValueError("not a collection url (expected .../games/<game>/collections/<slug>)")

    r = requests.post(
        "https://api-router.nexusmods.com/graphql",
        json={
            "query": COLLECTION_QUERY,
            "variables": {"slug": m.group(1), "viewAdultContent": True},
            "operationName": "CollectionRevisionMods",
        },
        headers={**BROWSER_HEADERS, "x-graphql-operationname": "CollectionRevisionMods"},
        timeout=30,
    )
    r.raise_for_status()
    d = r.json()
    rev = (d.get("data") or {}).get("collectionRevision")
    if not rev:
        raise ValueError(f"collection not found: {d.get('errors')}")
    return {"data": {"collectionRevision": rev}}


def _graphql(query, variables=None):
    r = requests.post(
        "https://api-router.nexusmods.com/graphql",
        json={"query": query, "variables": variables or {}},
        headers=BROWSER_HEADERS,
        timeout=30,
    )
    r.raise_for_status()
    d = r.json()
    if not d.get("data"):
        raise ValueError(f"graphql error: {d.get('errors')}")
    return d["data"]


# files in these categories are no longer downloadable
DEAD_FILE_CATEGORIES = {"OLD_VERSION", "REMOVED", "ARCHIVED"}

_game_ids = {GAME: int(GAME_ID)}


def game_id_for(domain):
    if domain not in _game_ids:
        game = _graphql("query($d: String!) { game(domainName: $d) { id } }", {"d": domain})["game"]
        if not game:
            raise ValueError(f"unknown game domain: {domain}")
        _game_ids[domain] = game["id"]
    return _game_ids[domain]


def fetch_mod(url):
    """Fetch a single mod's current files from a mod page URL.

    Returns a payload in the same shape as a collection modlist, so the
    diff/download pipeline can treat it identically."""
    m = re.search(r"nexusmods\.com/([^/]+)/mods/(\d+)", url)
    if not m:
        raise ValueError("not a mod url (expected nexusmods.com/<game>/mods/<id>)")
    domain, mod_id = m.group(1), int(m.group(2))

    game = _graphql("query($d: String!) { game(domainName: $d) { id domainName } }", {"d": domain})["game"]
    if not game:
        raise ValueError(f"unknown game domain: {domain}")

    nodes = _graphql(
        """query($g: Int!, $m: Int!) { legacyMods(ids: [{gameId: $g, modId: $m}]) {
             nodes { modId name version author summary adultContent pictureUrl
                     modCategory { name } uploader { name memberId avatar } } } }""",
        {"g": game["id"], "m": mod_id},
    )["legacyMods"]["nodes"]
    if not nodes:
        raise ValueError(f"mod {mod_id} not found on {domain}")
    info = nodes[0]

    files = _graphql(
        "query($m: ID!, $g: ID!) { modFiles(modId: $m, gameId: $g) { fileId name version sizeInBytes category primary } }",
        {"m": mod_id, "g": game["id"]},
    )["modFiles"]

    mod = {
        "adultContent": info["adultContent"],
        "author": info["author"],
        "category": (info.get("modCategory") or {}).get("name"),
        "game": {"id": game["id"], "domainName": game["domainName"]},
        "modId": info["modId"],
        "name": info["name"],
        "pictureUrl": info["pictureUrl"],
        "summary": info["summary"],
        "uploader": info["uploader"],
        "version": info["version"],
    }
    mod_files = [
        {
            "fileId": int(f["fileId"]),
            "optional": f["category"] != "MAIN",
            "file": {
                "fileId": int(f["fileId"]),
                "name": f["name"],
                "size": 0,
                "sizeInBytes": f["sizeInBytes"],
                "version": f["version"],
                "mod": mod,
            },
        }
        for f in files
        if f["category"] not in DEAD_FILE_CATEGORIES
    ]
    return {"data": {"collectionRevision": {"externalResources": [], "modFiles": mod_files}}}


def _cdp_alive():
    try:
        requests.get(f"{CDP_URL}/json/version", timeout=2)
        return True
    except Exception:
        return False


def ensure_browser():
    """Start the dedicated browser if its CDP port isn't answering.

    Returns the Popen handle if we spawned it (caller may close it after use),
    None if a browser was already running."""
    if _cdp_alive():
        return None
    log.info("starting browser for link generation")
    proc = subprocess.Popen(
        BROWSER_CMD, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True
    )
    for _ in range(30):
        if _cdp_alive():
            return proc
        time.sleep(1)
    proc.terminate()
    raise Exception("could not start the download browser (is chromium installed?)")


class LinkGenerator:
    """Generates signed CDN download urls through the user's logged-in browser.

    Attaches to a running Chromium-family browser over CDP (it must be started
    with --remote-debugging-port), opens an isolated context with the Nexus
    session cookies copied in, and calls the site's own GenerateDownloadUrl
    endpoint from a page on the nexusmods.com origin.

    The page must be an old-layout mod page: the game landing page redirects to
    the redesigned site, and from there the endpoint answers an empty list."""

    def __init__(self, anchor_domain, anchor_mod_id):
        self._anchor = f"https://www.nexusmods.com/{anchor_domain}/mods/{anchor_mod_id}"

    def __enter__(self):
        self._spawned = ensure_browser()
        self._pw = sync_playwright().start()
        self._own_context = None
        try:
            cdp = self._pw.chromium.connect_over_cdp(CDP_URL)
            anchor = self._anchor

            # prefer an isolated window with copied cookies; but session cookies
            # don't always transfer, so verify and fall back to the user's own
            # context (a short-lived tab in their window)
            try:
                self._cdp = cdp
                self._own_context = cdp.new_context()
                self._page = self._own_context.new_page()
                self._copy_session_cookies()
                self._page.goto(anchor, wait_until="domcontentloaded")
                if self._logged_in() or self._refresh_session():
                    return self
                log.info("copied cookies not authenticated; using main browser context")
                self._own_context.close()
            except Exception:
                pass
            self._own_context = None

            self._page = cdp.contexts[0].new_page()
            self._page.goto(anchor, wait_until="domcontentloaded")
            # a freshly spawned browser can serve the first page before the
            # session is restored — allow a few reloads before giving up
            for _ in range(3):
                if self._logged_in():
                    break
                time.sleep(2)
                self._page.reload(wait_until="domcontentloaded")
            if not self._logged_in():
                # leave the window open so the user can log in, then retry
                self._spawned = None
                raise Exception(
                    "not logged into nexusmods.com — log in using the browser window that just opened, then retry"
                )
        except Exception:
            self._pw.stop()
            raise
        return self

    def _logged_in(self):
        return not self._page.evaluate("document.body.innerText.includes('Log in')")

    def _copy_session_cookies(self):
        self._own_context.clear_cookies()
        self._own_context.add_cookies(
            [c for c in self._cdp.contexts[0].cookies() if "nexusmods" in c.get("domain", "")]
        )

    def _refresh_session(self):
        """Re-copy fresh session cookies from the user's browser and reload.
        Returns True if the page is authenticated afterwards."""
        if not self._own_context:
            return False
        log.info("refreshing nexus session cookies")
        self._copy_session_cookies()
        self._page.reload(wait_until="domcontentloaded")
        return self._logged_in()

    def __exit__(self, *exc):
        try:
            if self._own_context:
                self._own_context.close()
            else:
                self._page.close()
        finally:
            self._pw.stop()
            if self._spawned:  # we started the browser, so clean it up
                self._spawned.terminate()

    def generate(self, file_id, game_id=GAME_ID, mod_id=None, domain=GAME):
        body = f"fid={file_id}&game_id={game_id}"
        url = self._page.evaluate(GENERATE_URL_JS, body)
        if not url and mod_id:
            # some mod pages already run the redesigned frontend, where the
            # legacy endpoint answers an empty list — hop to the file's own page
            self._page.goto(
                f"https://www.nexusmods.com/{domain}/mods/{mod_id}",
                wait_until="domcontentloaded",
            )
            url = self._page.evaluate(GENERATE_URL_JS, body)
        if not url and not self._logged_in() and self._refresh_session():
            url = self._page.evaluate(GENERATE_URL_JS, body)
        if not url:
            raise Exception(f"no download url for file {file_id}")
        return url


def filename_for(url, base):
    """On-disk filename: sanitized base + extension taken from the CDN url."""
    return base + os.path.splitext(urllib.parse.urlparse(url).path)[1]


def fetch_file(session, url, filename, entry):
    """Stream a file into DOWNLOADS_DIR with Range-resume. Updates entry['got']."""
    path = os.path.join(DOWNLOADS_DIR, filename)
    existing = os.path.getsize(path) if os.path.exists(path) else 0

    response = session.get(
        url, allow_redirects=True, stream=True, timeout=60,
        headers={"Range": f"bytes={existing}-"} if existing > 0 else {},
    )

    if response.status_code == 416:  # already complete
        return True
    if response.status_code not in (200, 206):
        raise Exception(f"HTTP {response.status_code} for {filename}")
    if response.status_code == 200 and existing > 0:  # server ignored the Range
        existing = 0

    entry["got"] = existing
    with open(path, "ab" if existing > 0 else "wb") as f:
        for chunk in response.iter_content(chunk_size=256 * 1024):
            if chunk:
                f.write(chunk)
                entry["got"] += len(chunk)
    return True
