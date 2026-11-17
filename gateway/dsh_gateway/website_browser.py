"""Submit a configured password form in Chromium on the gateway, outside dsh."""

from __future__ import annotations

import re
from contextlib import AsyncExitStack
from dataclasses import dataclass
from urllib.parse import urlsplit

from .config import DEMO_LOGIN_HOST, demo_login_enabled
from .website_egress import public_https_proxy


class WebsiteBrowserError(RuntimeError):
    """A fixed stage name and, optionally, a Chromium network error code."""

    def __init__(self, stage: str, network_code: str = "") -> None:
        super().__init__(stage)
        self.stage = stage
        self.detail = f"{stage}: {network_code}" if network_code else stage


@dataclass(frozen=True)
class Website:
    origin: str
    login_path: str
    success_path: str
    username_selector: str
    password_selector: str
    submit_selector: str
    cookies: tuple[str, ...]


@dataclass(frozen=True)
class PublicWebsite:
    origin: str
    login_url: str


# The checks and fill run in one document. No selector, destination or cookie
# name is accepted from the caller; an administrator configures each site.
_SUBMIT = r"""({ origin, path, selectors, account, password }) => {
  if (location.origin !== origin || (path !== null && location.pathname !== path) || window !== window.top) return false;
  const visible = field => !field.matches(':disabled') && !field.readOnly && field.getClientRects().length > 0
      && getComputedStyle(field).visibility !== 'hidden';
  const only = items => items.length === 1 ? items[0] : null;
  const isSubmit = e => (e instanceof HTMLButtonElement || e instanceof HTMLInputElement) && e.type === 'submit';
  let user, pass, button;
  if (selectors !== null) {
    [user, pass, button] = selectors.map(s => only(document.querySelectorAll(s)));
  } else {
    pass = only([...document.querySelectorAll('input[type=password]')].filter(visible));
    if (!pass?.form || pass.autocomplete.split(/\s+/).includes('new-password') || !pass.name) return false;
    const controls = [...pass.form.elements];
    const usernames = controls.filter(e => e instanceof HTMLInputElement && ['email','text','tel'].includes(e.type)
        && e.name && visible(e) && !/one-time-code|captcha|verify|otp|code/i.test(e.autocomplete + ' ' + e.name));
    const explicit = usernames.filter(e => e.autocomplete.split(/\s+/).includes('username'));
    const likely = usernames.filter(e => e.type === 'email' || /user|email|account|login|identifier|phone/i.test(e.name));
    user = only(explicit.length ? explicit : likely.length ? likely : usernames);
    button = only(controls.filter(e => isSubmit(e) && visible(e)));
    const intent = `${location.pathname} ${button?.innerText ?? button?.value ?? ''}`;
    if (/sign[ -]?up|register|create[ -]?account|reset[ -]?password|change[ -]?password|注册|重置密码|修改密码/i.test(intent)) return false;
  }
  if (!(user instanceof HTMLInputElement) || !['email', 'text', 'tel'].includes(user.type)
      || !(pass instanceof HTMLInputElement) || pass.type !== 'password'
      || !isSubmit(button) || [user, pass, button].some(e => e.matches(':disabled'))
      || user.readOnly || pass.readOnly) return false;
  const form = pass.form;
  if (!form || user.form !== form || button.form !== form) return false;
  const action = () => new URL(button.hasAttribute('formaction') ? button.formAction : form.action);
  const allowed = () => action().origin === origin && !action().username && !action().password
    && (button.getAttribute('formmethod') || form.method).toLowerCase() === 'post'
    && ['', '_self'].includes(button.getAttribute('formtarget') ?? form.target);
  if (!allowed()) return false;
  for (const [field, value] of [[user, account], [pass, password]]) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (!allowed()) return false;
  HTMLFormElement.prototype.requestSubmit.call(form, button);
  return true;
}"""


async def sign_in(site: Website | PublicWebsite, username: str, password: str) -> list[dict]:
    """Return only the configured same-host secure cookies from a fresh login."""
    # Optional: gateways without the separately configured sign-in origin do
    # not need Playwright or a local Chromium installation.
    from playwright.async_api import Error as BrowserError, async_playwright

    host = urlsplit(site.origin).hostname
    public = isinstance(site, PublicWebsite)
    # The local demo is served by OrbStack, outside any configured Internet proxy.
    args = ["--no-proxy-server"] if host == DEMO_LOGIN_HOST and demo_login_enabled() else []
    stage = "browser-start"
    try:
        async with AsyncExitStack() as stack:
            proxy = None
            if public:
                proxy = await stack.enter_async_context(public_https_proxy(host))
                args.extend(["--disable-quic", "--dns-prefetch-disable", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"])
            playwright = await stack.enter_async_context(async_playwright())
            browser = await playwright.chromium.launch(chromium_sandbox=True, timeout=15000, args=args, proxy=proxy)
            try:
                context = await browser.new_context(service_workers="block", accept_downloads=False)
                page = await context.new_page()
                page.set_default_timeout(12000)
                stage = "site-unreachable"
                await page.goto(site.login_url if public else site.origin + site.login_path, wait_until="domcontentloaded")
                stage = "form-unavailable"
                if public:
                    await page.locator('input[type="password"]:visible').first.wait_for()
                else:
                    await page.locator(site.password_selector).wait_for(state="visible")
                initial_path = urlsplit(page.url).path
                initial_cookies = {_cookie_id(c): c["value"] for c in await context.cookies(site.origin)} if public else {}
                success_response = False

                def at_success(url: str) -> bool:
                    target = urlsplit(str(url))
                    if f"{target.scheme}://{target.netloc}" != site.origin:
                        return False
                    return target.path != initial_path if public else target.path == site.success_path

                def track_response(response):
                    nonlocal success_response
                    if (response.request.is_navigation_request() and response.frame == page.main_frame
                            and at_success(response.url)):
                        success_response = 200 <= response.status < 300

                page.on("response", track_response)
                submitted = await page.evaluate(_SUBMIT, {
                    "origin": site.origin, "path": None if public else site.login_path,
                    "selectors": None if public else [site.username_selector, site.password_selector, site.submit_selector],
                    "account": username, "password": password,
                })
                if not submitted:
                    raise WebsiteBrowserError("form-unavailable")
                stage = "login-not-confirmed"
                await page.wait_for_url(at_success, wait_until="domcontentloaded")
                if not success_response:
                    raise WebsiteBrowserError(stage)
                if public and await page.locator(
                    'input[type="password"]:visible, input[autocomplete="one-time-code"]:visible, '
                    'input[name*="captcha" i]:visible, input[name*="otp" i]:visible'
                ).count():
                    raise WebsiteBrowserError("confirmation-required")
                stage = "session-cookie-missing"
                cookies = [c for c in await context.cookies(page.url)
                           if c["secure"] and c["domain"].lstrip(".") == host
                           and not c.get("partitionKey") and c["value"]]
                if public:
                    cookies = [c for c in cookies if c["httpOnly"] and password not in c["value"]
                               and initial_cookies.get(_cookie_id(c)) != c["value"]]
                else:
                    cookies = [c for c in cookies if c["name"] in site.cookies]
                if (not cookies or len(cookies) > 16 or (not public and
                        (len(cookies) != len(site.cookies) or {c["name"] for c in cookies} != set(site.cookies)))):
                    raise WebsiteBrowserError(stage)
                return [{k: c[k] for k in ("name", "value", "path", "expires", "httpOnly", "sameSite")} for c in cookies]
            finally:
                await browser.close()
    except BrowserError as error:
        match = re.search(r"\bnet::(ERR_[A-Z0-9_]{1,70})\b", str(error).split("\n", 1)[0])
        raise WebsiteBrowserError(stage, match.group(1) if match else "") from None


def _cookie_id(cookie: dict) -> tuple:
    return cookie["name"], cookie["domain"], cookie["path"]
