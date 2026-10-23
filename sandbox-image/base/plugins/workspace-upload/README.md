# dsh-cloud-workspace-upload

Upload button for dsh's Files panel: files or a whole folder go into the conversation's project directory. See "Uploading files into a workspace" in the repository README for what users see and the limits.

| File | Role |
|---|---|
| `index.js` | Host face: `POST api/dshCloudFiles/check` (which paths already exist or cannot be written) and `POST api/dshCloudFiles/upload?session=&path=&conflict=fail\|overwrite\|rename` (streams one file), both owner-only routes on dsh's connection |
| `client.js` | Client face: the button in the `sidebar.right.tab.files.actions` slot, written in dsh's client bundle format so it needs no build |
| `cordis.patch.yml` | Inserts the host row `workspace-upload` |

Config: `maxFileBytes` (default 200 MB), set with a config patch on the `workspace-upload` row. The package has no dependencies, so it validates its config itself and fails at load on a bad value.

The upload route resolves the Session's working directory from the Session header (`sessions`, then `sessionPersistence`), never from the request. A path segment that is empty, `.`, `..`, contains `\` or a control character, or exceeds 200 bytes is refused; so is a parent directory whose real path leaves the working directory. `conflict=fail` and `rename` place the file with a hard link, which fails instead of replacing a file created meanwhile.
