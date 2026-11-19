import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { register } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// Stub DSH runtime peer packages when running unit tests directly on the host outside the container.
register('data:text/javascript,' + encodeURIComponent(`
const STUBS = {
  '@deepseek-ai/dsh-llm': 'export const createUserMessage = x => x; export class BlockAssembler {}; export const resolveRetryPolicy = () => ({});',
  '@deepseek-ai/dsh-tools': 'export const defineTool = x => x;',
  'deep-view/core': 'export const checkShownView = () => ({}); export const showViewDescription = ""; export const showViewParameters = {}; export const validateViewAnswer = () => ({});',
};
export async function resolve(specifier, context, nextResolve) {
  if (specifier in STUBS) return { url: 'data:text/javascript,' + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  return nextResolve(specifier, context);
}
`))

const {
  completeGoal,
  draftGoal,
  markTasks,
  passGoal,
  reworkGoal,
  startGoal,
} = await import('../base/plugins/ds-bot/src/host/goals.js')
const { name, inject } = await import('../base/plugins/ds-bot/src/host/entry.js')

const PLUGIN_DIR = join(import.meta.dirname, '..', 'base', 'plugins', 'ds-bot')

test('ds-bot plugin manifest and cordis bundle patch are properly configured for dsh-cloud-sandbox', async () => {
  assert.equal(name, 'ds-bot')
  assert.ok(inject.includes('sessionController'))
  assert.ok(inject.includes('workspaceRegistry'))

  const pkg = JSON.parse(await readFile(join(PLUGIN_DIR, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'ds-bot')
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  // Peer dependencies are resolved from the global DSH installation in the container image
  assert.equal(pkg.peerDependencies, undefined)

  const defaults = await readFile(join(import.meta.dirname, '..', 'base', 'defaults.cordis.yml'), 'utf8')
  assert.match(defaults, /- id: bot/)
  assert.match(defaults, /workspace: \/home\/agent\/workspaces/)
})

test('ds-bot group goal lifecycle supports stage assignment, rework whipping, and stage-by-stage verification', () => {
  const members = new Map([
    ['chief', { id: 'bot-chief', name: 'Chief' }],
    ['coder', { id: 'bot-coder', name: 'Coder' }],
    ['qa', { id: 'bot-qa', name: 'QA' }],
  ])
  const memberOf = ref => members.get(String(ref).toLowerCase())
  const memberNames = ['Chief', 'Coder', 'QA']
  const room = { id: 'room-1', name: 'Auth Refactor', members: ['bot-chief', 'bot-coder', 'bot-qa'], admin: 'bot-chief' }

  // 1. Draft goal
  const drafted = draftGoal(room, { brief: 'Refactor auth and add rate limiting tests', by: 'user' }, 1000)
  assert.equal(drafted.error, undefined)
  assert.equal(room.goal.status, 'drafting')

  // 2. Start goal with 2 stages
  const started = startGoal(room, {
    title: 'Auth Rate Limiting',
    objective: 'Implement rate limiting and pass unit tests',
    acceptance: 'All rate-limit unit tests pass',
    constraints: ['No external Redis dependency'],
    stages: [
      {
        title: 'Stage 1: Implementation',
        acceptance: 'Middleware written in auth.py',
        tasks: [{ bot: 'Coder', task: 'Implement token bucket rate limiter in auth.py' }],
      },
      {
        title: 'Stage 2: Verification',
        acceptance: 'pytest passes 100%',
        tasks: [{ bot: 'QA', task: 'Write and execute unit tests for rate limiting' }],
      },
    ],
  }, 'bot-chief', memberOf, memberNames, 2000)
  assert.equal(started.error, undefined)
  assert.equal(room.goal.status, 'active')
  assert.equal(room.goal.current, 0)

  // 3. Coder works and reports, but Chief rejects/reworks Stage 1 ("鞭策打回")
  assert.equal(markTasks(room, 'bot-coder', 'pending', 'working', undefined, 2100), true)
  assert.equal(markTasks(room, 'bot-coder', 'working', 'reported', undefined, 2200), true)
  const reworked = reworkGoal(room, {
    reason: 'Missing concurrency lock and no actual file diff in auth.py',
    bot: 'Coder',
  }, 'bot-chief', memberOf, memberNames, 2300)
  assert.equal(reworked.error, undefined)
  assert.equal(room.goal.stages[0].reworks, 1)
  assert.equal(room.goal.stages[0].tasks[0].status, 'pending')

  // 4. Coder reworks and Stage 1 passes -> automatically advances to Stage 2 (QA)
  const passed1 = passGoal(room, { evidence: 'auth.py updated with thread-safe token bucket' }, 'bot-chief', 2500)
  assert.equal(passed1.error, undefined)
  assert.equal(room.goal.current, 1)
  assert.equal(room.goal.stages[0].status, 'passed')
  assert.equal(room.goal.stages[1].status, 'active')

  // 5. Stage 2 passes and Chief completes the overall goal
  const passed2 = passGoal(room, { evidence: 'pytest 14 passed in 0.3s' }, 'bot-chief', 2700)
  assert.equal(passed2.error, undefined)
  const completed = completeGoal(room, {
    evidence: 'auth.py modified and 14 unit tests passing',
    summary: 'Rate limiting implemented and verified by Coder and QA.',
  }, 'bot-chief', 3000)
  assert.equal(completed.error, undefined)
  assert.equal(room.goal.status, 'complete')
})

test('ds-bot capabilities sync ~/.dsh/skills and Admin Console dsh-cloud-mcp-* entries bidirectionally', async () => {
  const { install: installCapabilities } = await import('../base/plugins/ds-bot/src/host/capabilities.js')
  const tempRoot = join(tmpdir(), `ds-bot-cap-test-${Date.now()}`)
  const dshHome = join(tempRoot, '.dsh')
  await mkdir(join(dshHome, 'skills', 'code-review'), { recursive: true })
  await writeFile(
    join(dshHome, 'skills', 'code-review', 'SKILL.md'),
    '---\nname: code-review\ndescription: "Automated code review skill"\n---\n\nAlways check edge cases.\n',
    'utf8',
  )

  const state = { bots: { chief: { id: 'chief', name: 'Chief', capabilities: [] } }, capabilities: { items: {} } }
  const loaderEntries = [
    {
      id: 'dsh-cloud-mcp-github-ent',
      options: {
        id: 'dsh-cloud-mcp-github-ent',
        name: '@deepseek-ai/dsh-mcp-client',
        config: {
          serverName: 'github-ent',
          transport: 'streamable-http',
          url: 'https://mcp.internal.example/sse',
          headers: { Authorization: 'Bearer test' },
        },
      },
    },
  ]
  const rt = {
    dshHome,
    state,
    ctx: {
      get: (service) => (service === 'loader' ? { entries: () => loaderEntries } : undefined),
      on: () => {},
      effect: () => {},
    },
    load: async () => {},
    save: async () => {},
    loadSecrets: async () => {},
    readOnly: () => undefined,
    isMain: () => true,
    botOf: id => state.bots[id],
    isBotSession: () => false,
    warn: () => {},
  }
  installCapabilities(rt)

  try {
    await rt.reconcileCapabilities()
    // 1. Existing ~/.dsh/skills/code-review/SKILL.md was imported into state.capabilities.items
    assert.equal(state.capabilities.items['code-review']?.kind, 'skill')
    assert.equal(state.capabilities.items['code-review']?.description, 'Automated code review skill')
    assert.equal(state.capabilities.items['code-review']?.content, 'Always check edge cases.')

    // 2. Admin Console MCP entry dsh-cloud-mcp-github-ent was imported into state.capabilities.items
    assert.equal(state.capabilities.items['github-ent']?.kind, 'mcp')
    assert.equal(state.capabilities.items['github-ent']?.transport, 'streamable-http')
    assert.equal(state.capabilities.items['github-ent']?.url, 'https://mcp.internal.example/sse')

    // 3. Saving a new skill in DS Bot writes ~/.dsh/skills/<name>/SKILL.md for Classic Agent Mode
    await rt.capabilitySave({
      name: 'sql-tuning',
      kind: 'skill',
      description: 'Optimize SQL queries',
      content: 'Use EXPLAIN ANALYZE before adding indexes.',
    }, { ui: true })
    const written = await readFile(join(dshHome, 'skills', 'sql-tuning', 'SKILL.md'), 'utf8')
    assert.match(written, /name: sql-tuning/)
    assert.match(written, /Use EXPLAIN ANALYZE before adding indexes\./)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

