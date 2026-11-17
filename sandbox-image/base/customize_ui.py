"""Small, version-checked UI customizations of the official dsh npm package.

Run at image build time. Match the pinned release exactly and prepare both
bundles before writing either, so an upstream change fails the build rather
than silently shipping a partially working picker. No Host APIs are changed.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re

VERSION = "0.2.2-alpha.3"
BASE_MARKER = "// dsh-cloud: non-project conversations v1\n"
REMOVAL_MARKER = "// dsh-cloud: non-project conversations v2\n"
MARKER = "// dsh-cloud: non-project conversations v3\n"
NO_PROJECT = "::dsh-cloud-no-project"


def once(source: str, before: str, after: str) -> str:
    if source.count(before) != 1:
        raise ValueError(f"dsh UI changed: expected one occurrence of {before[:100]!r}")
    return source.replace(before, after, 1)


def workspace_bundle(source: str) -> str:
    source = once(source, 'const ADD_WORKSPACE = "::add-workspace";',
                  f'const NO_PROJECT = "{NO_PROJECT}";\n\t\tconst ADD_WORKSPACE = "::add-workspace";')
    source = once(source,
                  'if (stray.length > 0) groups.push(buildGroup("", void 0, void 0, void 0, "", orderedUngrouped(stray, ungroupedOrder, list.byId)));',
                  'groups.push(buildGroup("", void 0, void 0, void 0, "", orderedUngrouped(stray, ungroupedOrder, list.byId)));')
    source = once(source,
                  'if (workspace === void 0) throw new Error(`uiWorkspace.connectWorkspace: unknown workspace ${workspaceId}`);',
                  'if (workspace === void 0 && workspaceId !== NO_PROJECT) throw new Error(`uiWorkspace.connectWorkspace: unknown workspace ${workspaceId}`);')
    source = once(source,
                  'const attempt = this.createInWorkspace(workspace, reuse).finally(() => {',
                  'const attempt = (workspaceId === NO_PROJECT ? this.createOutsideWorkspace(reuse) : this.createInWorkspace(workspace, reuse)).finally(() => {')
    source = once(source, 'createInWorkspace(workspace, options) {', '''createOutsideWorkspace(options) {
                const snapshot = this.workspaces.list.getSnapshot();
                const members = new Set(snapshot.items.flatMap((item) => item.sessionIds));
                const cwd = this.ctx.remote.$host.home;
                const sessions = this.sessions.list.getSnapshot();
                const blank = sessions.ids.find((id) => {
                    const summary = sessions.byId[id];
                    const preset = summary?.projectionValues?.agentPreset;
                    return summary?.blank && summary.cwd === cwd && !members.has(id)
                        && !snapshot.archivedSessionIds.includes(id)
                        && (options.agentPreset === void 0 || typeof preset !== "string" || preset === options.agentPreset);
                });
                return this.createNamed({
                    cwd,
                    ...blank === void 0 ? {} : { sessionId: blank },
                    ...options.agentPreset === void 0 ? {} : { agentPreset: options.agentPreset }
                });
            }
            createInWorkspace(workspace, options) {''')
    source = once(source, 'const target = workspaceId ?? currentWorkspaceId ?? recent;',
                  'const target = workspaceId ?? (current !== void 0 && currentWorkspaceId === void 0 ? NO_PROJECT : currentWorkspaceId ?? recent);')

    # The non-project bucket is a section heading, rather than a folder row.
    start = source.index('\t\tfunction UngroupedProjectRow(props) {')
    end = source.index('\n\t\t/** A real Workspace', start)
    source = source[:start] + '''        function UngroupedProjectRow({ group, onToggle, onCreate, t, useRemoteAccess }) {
            const create = useRemoteAccess("session/create");
            return react.createElement("div", {
                className: "dsh-cloud-no-project-heading",
                "data-row-key": "workspace:",
                role: "treeitem", "aria-expanded": group.expanded, tabIndex: 0,
                style: {
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    height: 36, marginTop: 12, marginBottom: 4,
                    paddingLeft: "var(--dsh-sidebar-row-padding)", paddingRight: 4,
                    color: "var(--dsw-alias-label-tertiary)", cursor: "pointer"
                },
                onClick: onToggle,
                onKeyDown: (event) => {
                    if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
                        event.preventDefault(); onToggle();
                    }
                }
            }, react.createElement("span", null, t("group.ungrouped")),
            create && react.createElement("button", {
                type: "button", className: WorkspaceBrowser_module_css_default.iconButton,
                "aria-label": t("actions.newSession.aria", { name: t("group.ungrouped") }),
                title: t("actions.newSession"),
                onClick: (event) => { event.stopPropagation(); onCreate(); }
            }, react.createElement(_deepseek_ai_dsh_client_ui_primitives.IconNewChatOutlineRegular, { size: 16 })));
        }''' + source[end:]
    source = once(source, '''if (group.workspaceId !== void 0) {
									setGroupExpanded(group.key, true);
									startSession(group.workspaceId);
								}''', '''setGroupExpanded(group.key, true);
                                startSession(group.workspaceId ?? NO_PROJECT);''')
    source = once(source, 'const menuIsEmpty = items.length === 0;', '''if (!addOnly) items.unshift({
                id: NO_PROJECT, label: t("group.ungrouped"), disabled: flowBusy,
                icon: react.createElement(_deepseek_ai_dsh_client_ui_primitives.IconNewChatOutlineRegular, { size: 16 })
            });
            const menuIsEmpty = items.length === 0;''')
    source = once(source, 'const addIsTheOnlyEntry = !pinAdd && listSettled && addEntries.length === 1;',
                  'const addIsTheOnlyEntry = addOnly && !pinAdd && listSettled && addEntries.length === 1;')
    source = once(source, '"group.ungrouped": "未分组"', '"group.ungrouped": "非工作区"')
    source = once(source, '"group.ungrouped": "Ungrouped"', '"group.ungrouped": "Don\'t work in a project"')
    source = source.replace('其会话将显示在“未分组”下', '其会话将显示在“非工作区”下')
    source = source.replace('appear under Ungrouped', 'appear under Don\'t work in a project')
    return BASE_MARKER + source


def conversation_bundle(source: str) -> str:
    source = once(source, 'const chipTitle = storedChipTitle === void 0 ? void 0 : workspaceDisplayTitle(storedChipTitle, t("workspace.defaultName"));',
                  f'''const outsideProject = pendingWorkspaceId === "{NO_PROJECT}" || (sessionId !== void 0 && workspaces.phase === "ready" && sessionWorkspace === void 0);
            const chipTitle = outsideProject ? t("hero.noProject") : storedChipTitle === void 0 ? void 0 : workspaceDisplayTitle(storedChipTitle, t("workspace.defaultName"));''')
    source = once(source, 'selectedId: pendingWorkspaceId ?? sessionWorkspace?.workspaceId,',
                  f'selectedId: pendingWorkspaceId ?? sessionWorkspace?.workspaceId ?? (sessionId === void 0 ? void 0 : "{NO_PROJECT}"),')
    source = once(source, 'if (pendingWorkspaceId === void 0) return;', f'''if (pendingWorkspaceId === void 0) return;
                if (pendingWorkspaceId === "{NO_PROJECT}") {{
                    if (sessionId !== void 0 && sessionWorkspace === void 0) setPendingWorkspaceId(void 0);
                    return;
                }}''')
    source = once(source, '''pendingWorkspaceId,
				sessionWorkspace?.workspaceId,''', '''pendingWorkspaceId,
                sessionId,
				sessionWorkspace?.workspaceId,''')

    def copy(match: re.Match) -> str:
        label = "非工作区" if match[1] == "探索未至之境" else "Don't work in a project"
        return f'{match[0]},\n            "hero.noProject": {json.dumps(label, ensure_ascii=False)}'

    source, count = re.subn(r'"hero.headline": "([^"\n]*)"', copy, source)
    if count < 2 or '"hero.noProject": "非工作区"' not in source:
        raise ValueError("dsh conversation locale dictionaries changed")
    return BASE_MARKER + source


def removable_conversations(source: str) -> str:
    """Give blank drafts the same reversible removal path as other sessions."""
    source = once(source, '...getTriggerProps(row.blank ? void 0 : {',
                  '...getTriggerProps({')
    source = once(source, '''!row.blank && (0, react_jsx_runtime.jsxs)("span", {
							className: Rows_module_css_default.rowActions,''', '''(0, react_jsx_runtime.jsxs)("span", {
							className: Rows_module_css_default.rowActions,''')
    # A blank draft can be removed, but cannot yet be renamed or forked.
    source = once(source, '''ctx.workspaces.list,
						ctx.locale,
						...endpoints.map''', '''ctx.workspaces.list,
                        ctx.sessions.list,
						ctx.locale,
						...endpoints.map''')
    source = once(source, '''resolve
				}), `ui-workspace: ${id} menu`);''', '''resolve: (target) => {
                        const blank = ctx.sessions.list.getSnapshot().byId[target.sessionId]?.blank;
                        return blank && id !== "archive" ? [] : resolve(target);
                    }
				}), `ui-workspace: ${id} menu`);''')
    # Removed drafts retain their text and remain reachable in the archive view.
    source = once(source, 'if (session.blank && session.id !== current) return false;',
                  'if (session.blank && session.id !== current && !archived.has(session.id)) return false;')
    source = once(source, '''await this.workspaces.unarchiveSession(sessionId);
			}''', '''await this.workspaces.unarchiveSession(sessionId);
                if (this.sessions.list.getSnapshot().byId[sessionId]?.blank) this.openSession(sessionId);
			}''')
    for before, after in [
        ('"menu.archiveSession": "归档会话"', '"menu.archiveSession": "移除对话"'),
        ('"actions.archive": "归档会话"', '"actions.archive": "移除对话"'),
        ('"menu.archiveSession": "Archive session"', '"menu.archiveSession": "Remove conversation"'),
        ('"actions.archive": "Archive"', '"actions.archive": "Remove conversation"'),
    ]:
        source = once(source, before, after)
    return source


def workspace_composer_controls(source: str) -> str:
    """Show the workspace permission picker only for a registered membership."""
    source = once(source, 'function InputBar({ useSession, useInput,',
                  'function InputBar({ useWorkspaces, useSession, useInput,')
    source = once(source, 'const input = useInput((s) => s);', '''const input = useInput((s) => s);
            const inWorkspace = useWorkspaces((state) => sessionId !== void 0 && state.items.some((workspace) => workspace.sessionIds.includes(sessionId)));''')
    return once(source,
                'sessionId === void 0 ? null : renderSlot("conversation.input.permission", { locked })',
                'sessionId === void 0 || !inWorkspace ? null : renderSlot("conversation.input.permission", { locked })')


def customize(root: Path) -> None:
    version = json.loads((root / "package.json").read_text())["version"]
    if version != VERSION:
        raise ValueError(f"dsh UI customizations support {VERSION}; review the changes for {version}")
    packages = root / "node_modules/@deepseek-ai"
    pending = []
    for name, transform in [("dsh-client-ui-workspace", workspace_bundle), ("dsh-client-ui-conversation", conversation_bundle)]:
        path = packages / name / "lib/client.js"
        source = path.read_text()
        if source.startswith(MARKER):
            continue
        if not source.startswith((BASE_MARKER, REMOVAL_MARKER)):
            source = transform(source)
        if source.startswith(BASE_MARKER):
            if name == "dsh-client-ui-workspace":
                source = removable_conversations(source)
            source = once(source, BASE_MARKER, REMOVAL_MARKER)
        if name == "dsh-client-ui-conversation":
            source = workspace_composer_controls(source)
        pending.append((path, once(source, REMOVAL_MARKER, MARKER)))
    for path, source in pending:
        path.write_text(source)
        print(f"Customized {path.parent.parent.name}: non-project conversations")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path, nargs="?", default=Path("/usr/local/lib/node_modules/@deepseek-ai/dsh"))
    customize(parser.parse_args().root)
