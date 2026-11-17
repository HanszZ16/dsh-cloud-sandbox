"""The Vault's server-rendered login list and password forms."""

from __future__ import annotations

import html
from urllib.parse import urlsplit


def vault_markup(entries: list[dict], grant: str, editable: bool, notice: str = "") -> str:
    esc = html.escape
    token = f'<input type="hidden" name="grant" value="{esc(grant)}">' if grant else ""
    status = f'<p class="vault-notice" role="status">{esc(notice)}</p>' if notice else ""
    add = f"""<details class="vault-add"><summary>＋ 新建登录</summary>
<form method="post" autocomplete="off">{token}
<label>网站地址<input type="url" name="site" placeholder="https://example.com" maxlength="2048" required></label>
<label>网站账号<input name="username" maxlength="320" required></label>
<label>网站密码<input name="password" type="password" autocomplete="new-password" maxlength="1024" required></label>
<button name="action" value="save">保存到保险库</button></form></details>""" if editable else ""
    rows = []
    for entry in entries:
        ident = int(entry["id"])
        host = esc(urlsplit(entry["origin"]).hostname or entry["origin"])
        username = esc(entry["username"])
        hidden_id = f'<input type="hidden" name="id" value="{ident}">'
        change = f"""<form method="post" autocomplete="off">{token}{hidden_id}
<label>替换密码<input name="password" type="password" autocomplete="new-password" maxlength="1024" required></label>
<button name="action" value="replace">保存新密码</button></form>""" if editable else ""
        rows.append(f"""<details class="vault-item" data-vault-item><summary>
<span class="vault-icon" aria-hidden="true">{_KEY}</span><span class="vault-identity" data-vault-label>
<strong>{host}</strong> <span>{username}</span></span><span class="vault-chevron" aria-hidden="true">›</span></summary>
<div class="vault-edit"><p>{esc(entry['origin'])} · 密码已保护</p>{change}
<form method="post">{token}{hidden_id}<button class="secondary danger" name="action" value="delete">删除登录</button></form>
</div></details>""")
    collection = "".join(rows)
    empty = "" if entries else '<div class="vault-empty"><strong>还没有保存的登录</strong><span>可以新建一条，或在安全表单登录时勾选保存。</span></div>'
    return f"""<p>用于网站登录的账号单独保存在这里。每次使用仍需你授权。</p>{status}
<div class="vault-toolbar"><span class="vault-count">登录账号 <strong>{len(entries)}</strong></span>
<label class="vault-search"><span class="sr-only">搜索保险库</span><input type="search" data-vault-search placeholder="搜索保险库" autocomplete="off"></label>{add}</div>
<div class="vault-list">{collection}{empty}<p class="vault-empty" data-vault-no-results hidden>没有符合的登录记录。</p></div>
<form class="vault-footer" method="post">{token}<button class="secondary" name="action" value="logout">锁定保险库</button></form>"""


_KEY = ('<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
        'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="16" cy="8" r="4"/>'
        '<path d="M13.2 10.8 5 19v-4h4v-4"/></svg>')
