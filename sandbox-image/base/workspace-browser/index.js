/**
 * Host face of the workspace browser plugin: a system prompt section that
 * tells the agent when to use the browser tools (mcp__browser__*, mounted by
 * this bundle's cordis.patch.yml). The live view runs in the browser
 * (./client.js); this row also makes dsh's client module table serve it.
 */
export const name = 'workspace-browser'
export const inject = ['systemPrompt']

export function apply(ctx) {
  ctx.systemPrompt.section({
    name: 'tool:remote-browser',
    order: 2360,
    interpolate: false,
    text: [
      'The mcp__browser__* tools drive one Chromium in this workspace, shown live to the user in the "Remote browser" sidebar tab. Use them only when the task needs a real browser:',
      '- the user asks you to open, look at, or operate a web page or web app;',
      '- a site needs interaction that web_fetch cannot do: signing in, filling forms, clicking through pages, or content rendered by JavaScript;',
      '- the user asks you to check how something you built looks or behaves in a browser.',
      'Do not open the browser on your own to check files you generated (HTML pages, charts, documents): finish when the file is written and its source is correct, then tell the user where it is and offer to check it in the browser. To read a static page or search, use web_fetch or web_search.',
      'When the user asks you to check something in the browser, look at what they asked about, fix real defects, and stop; do not iterate on cosmetic details or test other screen sizes and themes unless asked.',
      'Build what was asked: when the user asks for something simple, do not add features such as theme switchers, mobile menus, or animations they did not request.',
      'Local files open directly as file:///absolute/path; no HTTP server is needed. Screenshots and other browser output files go to /tmp/playwright-mcp.',
    ].join('\n'),
  })
}
