/**
 * Regression: context-injection sources are free-form BLOCK tags.
 *
 * The injected messages DSH and third-party plugins append before a step are
 * a different layer from the runtime-context snapshot items: this tag list
 * decides whether a whole message appears, the snapshot checklist decides what
 * the message contains.
 *
 * What this pins:
 *   1. `filterInjectedMessages` treats its second argument as a BLOCK list:
 *      a named kind is dropped, every other injected kind keeps riding along,
 *      `user` is never dropped and `runtime-context` is left to the assemble
 *      side. An absent or empty list blocks nothing.
 *   2. `normalizePreset` stores `injectionBlocks` as a deduplicated block list.
 *      The OLD `injections` allow list is ignored, never reversed: an upgraded
 *      preset goes back to "everything injects" instead of silently muting the
 *      sources it used to allow.
 *   3. No source catalog and no `agent/pre-step` observation exists: the page
 *      ships no known kinds, and the self-check reports exactly the tags the
 *      user typed.
 *   4. `installAgentScope` installs the pre-step listener with `prepend: true`
 *      only when the preset actually has tags, and filters the decision it
 *      gets back.
 *   5. The editor is a tag input: add on Enter / 「添加」, remove with the tag's
 *      × button or Backspace on an empty box, reject `user` / duplicates /
 *      blanks. The group renders after 提示词 and before the runtime-context
 *      item list.
 *   6. Saving writes `injectionBlocks`; the self-check shows the blocked tags
 *      (or says that nothing is blocked).
 *
 * Run: node test/verify-injection-sources.mjs
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PresetStore, filterInjectedMessages, normalizePreset } from '../index.js'
import { classNameOf, findNodes, mountStudio, textOf } from './_studio-harness.mjs'

console.log('# 注入来源过滤：tag 列表 = 屏蔽列表')
const MESSAGES = [
  { source: { kind: 'user' } },
  { source: { kind: 'time-context' } },
  { source: { kind: 'plugin:trilogy' } },
  { source: { kind: 'runtime-context' } },
  { source: { kind: 'context-pilot' } },
  { source: { kind: 'vendor:telemetry' } },
]
const kindsOf = (messages) => messages.map((message) => message.source.kind)

assert.equal(filterInjectedMessages(MESSAGES, undefined), MESSAGES, 'unmanaged preset keeps every message')
assert.deepEqual(filterInjectedMessages(MESSAGES, []), MESSAGES, 'an empty tag list blocks nothing')
assert.deepEqual(
  kindsOf(filterInjectedMessages(MESSAGES, ['time-context'])),
  ['user', 'plugin:trilogy', 'runtime-context', 'context-pilot', 'vendor:telemetry'],
  'only the tagged kind is dropped; everything else is allowed',
)
assert.deepEqual(
  kindsOf(filterInjectedMessages(MESSAGES, ['plugin:trilogy', 'context-pilot'])),
  ['user', 'time-context', 'runtime-context', 'vendor:telemetry'],
  'a third-party kind is blocked exactly like an official one',
)
assert.deepEqual(
  kindsOf(filterInjectedMessages(MESSAGES, ['runtime-context'])),
  kindsOf(MESSAGES),
  'runtime-context stays in pre-step (the assemble side owns it)',
)
assert.deepEqual(
  kindsOf(filterInjectedMessages(MESSAGES, ['user'])),
  kindsOf(MESSAGES),
  'the real user input is never dropped',
)

console.log('# 预设归一化：injectionBlocks 的未管理 / 空数组 / 去重 / 旧字段忽略')
assert.equal(normalizePreset({ id: 'p1', name: 'P1' }).injectionBlocks, undefined, 'absent field stays unmanaged')
assert.deepEqual(
  normalizePreset({ id: 'p2', name: 'P2', injectionBlocks: [] }).injectionBlocks,
  [],
  'an empty block list is stored as-is',
)
assert.deepEqual(
  normalizePreset({ id: 'p3', name: 'P3', injectionBlocks: ['time-context', 'time-context', ''] }).injectionBlocks,
  ['time-context'],
  'duplicates and blanks are removed',
)
assert.equal(
  normalizePreset({ id: 'p4', name: 'P4', injections: ['time-context'] }).injectionBlocks,
  undefined,
  'the old allow list is ignored, not reversed into a block list',
)
assert.deepEqual(
  normalizePreset({ id: 'p5', name: 'P5', injections: ['time-context'], injectionBlocks: ['context-pilot'] })
    .injectionBlocks,
  ['context-pilot'],
  'the new field wins; the old one is never read',
)
assert.deepEqual(
  normalizePreset({ id: 'p6', name: 'P6', injectionBlocks: ['user', 'context-pilot'] }).injectionBlocks,
  ['context-pilot'],
  'the real user input is never stored as a blockable tag',
)

console.log('# 自检报告：只报告用户输入的屏蔽 tag')
const dataFile = join(tmpdir(), 'injection-blocks-test.json')
const store = new PresetStore({ get: () => undefined }, { dataFile })
const unmanaged = store.injectionFilterReport(undefined)
assert.equal(unmanaged.managed, false, 'no field = unmanaged')
assert.deepEqual(unmanaged.blocked, [], 'unmanaged blocks nothing')
const managed = store.injectionFilterReport(['vendor:telemetry', 'user', '', 'vendor:telemetry', 'context-pilot'])
assert.equal(managed.managed, true)
assert.deepEqual(managed.blocked, ['context-pilot', 'vendor:telemetry'], 'sorted, deduped, user/blanks removed')
assert.deepEqual(store.injectionFilterReport([]), { managed: true, blocked: [] }, 'an empty list reports no blocks')

console.log('# 安装：有 tag 才装 pre-step，按屏蔽列表过滤')
const handlers = []
const agent = {
  id: 'a1',
  session: { header: { agentPreset: 'p1' } },
  ctx: {
    fiber: { assertActive() {} },
    get: () => undefined,
    on: (event, callback, options) => {
      handlers.push({ event, callback, options })
      return () => {}
    },
  },
}
store.presets = [
  normalizePreset({ id: 'p1', name: 'P1', injectionBlocks: ['time-context', 'context-pilot'] }),
]
store.installAgentScope(agent)
const preStep = handlers.find((entry) => entry.event === 'agent/pre-step')
assert(preStep !== undefined, 'the agent scope installs a pre-step listener for a tagged preset')
assert.equal(preStep.options?.prepend, true, 'prepend keeps it outside every injector')
const decision = await preStep.callback({ agent }, () => ({ kind: 'enter', messages: MESSAGES }))
assert.deepEqual(
  kindsOf(decision.messages),
  ['user', 'plugin:trilogy', 'runtime-context', 'vendor:telemetry'],
  'the runtime decision drops exactly the tagged sources',
)

// A preset without tags has nothing to observe and nothing to drop, so it must
// not install a listener at all.
const untaggedHandlers = []
const untaggedAgent = {
  id: 'a2',
  session: { header: { agentPreset: 'p2' } },
  ctx: {
    fiber: { assertActive() {} },
    get: () => undefined,
    on: (event, callback, options) => {
      untaggedHandlers.push({ event, callback, options })
      return () => {}
    },
  },
}
store.presets = [normalizePreset({ id: 'p2', name: 'P2' })]
store.installAgentScope(untaggedAgent)
assert.equal(
  untaggedHandlers.filter((entry) => entry.event === 'agent/pre-step').length,
  0,
  'no tags = no pre-step listener',
)

// `runtime-context` is an assemble-side tag: it must not install a pre-step
// listener either.
const runtimeHandlers = []
const runtimeAgent = {
  id: 'a3',
  session: { header: { agentPreset: 'p3' } },
  ctx: {
    fiber: { assertActive() {} },
    get: () => undefined,
    on: (event, callback, options) => {
      runtimeHandlers.push({ event, callback, options })
      return () => {}
    },
  },
}
store.presets = [normalizePreset({ id: 'p3', name: 'P3', injectionBlocks: ['runtime-context'] })]
store.installAgentScope(runtimeAgent)
assert.equal(
  runtimeHandlers.filter((entry) => entry.event === 'agent/pre-step').length,
  0,
  'a runtime-context-only tag list is handled by the assemble side, not pre-step',
)

// ── Client half ──────────────────────────────────────────────────────────
const INJECTION_META = {
  registryAvailable: true,
  contextCatalog: [],
  sectionCatalog: [],
  capabilities: ['snapshotContexts', 'requiredSuppression', 'contextRegistryTruth', 'injectionBlocks'],
}
const PLAIN_PRESET = {
  id: 'custom-inject01',
  name: '注入',
  description: '',
  instructions: '你是助手。',
  instructionMode: 'append',
  injectionBlocks: undefined,
  contexts: undefined,
  skills: [],
  tools: { mode: 'all', names: [] },
  enabled: true,
  order: 0,
  status: {},
}
const LABEL = '屏蔽的注入来源'
const buttonsIn = (tree) => findNodes(tree, (n) => n.type === 'button')
const labelled = (tree, label) => buttonsIn(tree).filter((node) => textOf(node) === label)
const isCard = (node) => classNameOf(node).split(' ').includes('aps-card')
const saves = (studio) => studio.calls.filter((call) => call.endpoint === 'save').map((call) => call.body)
const fieldFor = (tree, label) =>
  findNodes(
    tree,
    (node) =>
      classNameOf(node) === 'aps-field' &&
      findNodes(node, (inner) => classNameOf(inner) === 'aps-label').some((inner) => textOf(inner) === label),
  )[0]
const tagField = (tree) => fieldFor(tree, LABEL)
const tagLabels = (tree) => {
  const field = tagField(tree)
  if (field === undefined) return []
  return findNodes(field, (node) => classNameOf(node) === 'aps-tagLabel').map(textOf)
}
const tagInput = (tree) => {
  const field = tagField(tree)
  if (field === undefined) return undefined
  return findNodes(field, (node) => node.type === 'input' && node.props?.type === 'text')[0]
}
const tagRemove = (tree, kind) => {
  const field = tagField(tree)
  if (field === undefined) return undefined
  return findNodes(
    field,
    (node) =>
      classNameOf(node) === 'aps-tagRemove' && String(node.props?.['aria-label'] ?? '').includes(kind),
  )[0]
}
const tagAddButton = (tree) => findNodes(tagField(tree), (node) => node.type === 'button' && textOf(node) === '添加')[0]
const openEditor = async (studio, tree) => {
  const card = findNodes(tree, isCard)[0]
  await findNodes(card, (node) => classNameOf(node).includes('aps-cardMain'))[0].props.onClick()
  return studio.root.flush()
}
const settleInspect = async (studio) => {
  await studio.root.flush()
  await new Promise((resolve) => setTimeout(resolve, 380))
  return studio.root.flush()
}

console.log('# 编辑器：tag 输入、删除、校验与保存')
{
  const studio = mountStudio({
    presets: [PLAIN_PRESET],
    meta: INJECTION_META,
    inspectView: {
      available: true,
      surfaceCount: 0,
      tools: [],
      blockedTools: [],
      skills: [],
      missingSkills: [],
      contexts: [],
      blockedContexts: [],
      forcedContexts: [],
      injectionFilter: { managed: false, blocked: [] },
    },
  })
  let tree = await openEditor(studio, await studio.root.settle())
  const heads = findNodes(tree, (node) => classNameOf(node) === 'aps-groupHead').map(textOf)
  const prompt = heads.indexOf('提示词')
  assert(heads.includes('上下文注入'), `injection group rendered: ${heads.join(' / ')}`)
  assert.equal(heads.indexOf('上下文注入'), prompt + 1, 'the group sits directly after 提示词')
  assert.equal(heads.indexOf('runtime-context 注入'), prompt + 2, 'and before the runtime-context item list')

  assert.equal(tagField(tree) !== undefined, true, 'the tag editor is rendered')
  assert.deepEqual(tagLabels(tree), [], 'an unmanaged preset starts with no tags')
  assert(
    findNodes(tagField(tree), (node) => classNameOf(node) === 'aps-hint').some((node) =>
      textOf(node).includes('还没有添加 tag'),
    ),
    'the empty list explains that every source is allowed',
  )

  // Enter adds a tag; the remove button takes it away.
  tagInput(tree).props.onChange({ target: { value: 'context-pilot' } })
  tree = await studio.root.flush()
  tagInput(tree).props.onKeyDown({ key: 'Enter', preventDefault() {} })
  tree = await studio.root.flush()
  assert.deepEqual(tagLabels(tree), ['context-pilot'], 'Enter adds the typed source as a tag')
  assert(textOf(tree).includes('屏蔽 1 个来源'), 'the group head counts the blocked tags')

  // The 「添加」 button adds too.
  tagInput(tree).props.onChange({ target: { value: 'runtime-context' } })
  tree = await studio.root.flush()
  tagAddButton(tree).props.onClick()
  tree = await studio.root.flush()
  assert.deepEqual(tagLabels(tree), ['context-pilot', 'runtime-context'], 'the add button appends the tag')
  assert(
    textOf(tree).includes('tag 列表包含 runtime-context'),
    'a runtime-context tag explains that the whole snapshot is removed',
  )

  // Validation: user, duplicates and blanks never enter the list.
  tagInput(tree).props.onChange({ target: { value: 'user' } })
  tree = await studio.root.flush()
  tagInput(tree).props.onKeyDown({ key: 'Enter', preventDefault() {} })
  tree = await studio.root.flush()
  assert.deepEqual(tagLabels(tree), ['context-pilot', 'runtime-context'], 'user is never added')
  assert(textOf(tagField(tree)).includes('不能屏蔽'), 'the user rejection is explained')

  tagInput(tree).props.onChange({ target: { value: 'context-pilot' } })
  tree = await studio.root.flush()
  tagInput(tree).props.onKeyDown({ key: 'Enter', preventDefault() {} })
  tree = await studio.root.flush()
  assert.deepEqual(tagLabels(tree), ['context-pilot', 'runtime-context'], 'a duplicate is not added twice')
  assert(textOf(tagField(tree)).includes('已在屏蔽列表中'), 'the duplicate rejection is explained')

  tagInput(tree).props.onChange({ target: { value: '   ' } })
  tree = await studio.root.flush()
  tagInput(tree).props.onKeyDown({ key: 'Enter', preventDefault() {} })
  tree = await studio.root.flush()
  assert.deepEqual(tagLabels(tree), ['context-pilot', 'runtime-context'], 'a blank tag is not added')
  assert(textOf(tagField(tree)).includes('不能为空'), 'the blank rejection is explained')

  // The × button removes one tag; an empty box + Backspace removes the last.
  await tagRemove(tree, 'context-pilot').props.onClick()
  tree = await studio.root.flush()
  assert.deepEqual(tagLabels(tree), ['runtime-context'], 'the × button removes exactly one tag')

  tagInput(tree).props.onChange({ target: { value: '' } })
  tree = await studio.root.flush()
  tagInput(tree).props.onKeyDown({ key: 'Backspace', preventDefault() {} })
  tree = await studio.root.flush()
  assert.deepEqual(tagLabels(tree), [], 'Backspace on an empty box removes the last tag')

  // The final list is written as-is.
  tagInput(tree).props.onChange({ target: { value: 'time-context' } })
  tree = await studio.root.flush()
  tagInput(tree).props.onKeyDown({ key: 'Enter', preventDefault() {} })
  tree = await studio.root.flush()
  await labelled(tree, '保存')[0].props.onClick()
  await studio.root.flush()
  assert.deepEqual(saves(studio).at(-1).injectionBlocks, ['time-context'], 'saving writes the tag list')
}

console.log('# 编辑器：已有 tag 的预设原样显示')
{
  const studio = mountStudio({
    presets: [{ ...PLAIN_PRESET, injectionBlocks: ['context-pilot', 'runtime-context'] }],
    meta: INJECTION_META,
    inspectView: {
      available: true,
      surfaceCount: 0,
      tools: [],
      blockedTools: [],
      skills: [],
      missingSkills: [],
      contexts: [],
      blockedContexts: [],
      forcedContexts: [],
      injectionFilter: { managed: true, blocked: ['context-pilot', 'runtime-context'] },
    },
  })
  const tree = await openEditor(studio, await studio.root.settle())
  assert.deepEqual(tagLabels(tree), ['context-pilot', 'runtime-context'], 'stored tags render as-is')
  assert(textOf(tree).includes('屏蔽 2 个来源'), 'the count follows the stored list')
  assert(
    textOf(tree).includes('tag 列表包含 runtime-context'),
    'the runtime-context warning follows the stored list',
  )
}

console.log('# 自检：只显示用户输入的屏蔽 tag')
{
  const studio = mountStudio({
    presets: [PLAIN_PRESET],
    meta: INJECTION_META,
    inspectView: {
      available: true,
      surfaceCount: 0,
      tools: [],
      blockedTools: [],
      skills: [],
      missingSkills: [],
      contexts: [],
      blockedContexts: [],
      forcedContexts: [],
      injectionFilter: { managed: true, blocked: ['context-pilot', 'vendor:telemetry'] },
    },
  })
  await openEditor(studio, await studio.root.settle())
  const tree = await settleInspect(studio)
  assert(
    findNodes(tree, (node) => classNameOf(node) === 'aps-fact').some((node) =>
      textOf(node).includes('屏蔽的上下文注入来源 2 项'),
    ),
    'the summary counts exactly the blocked tags',
  )
  assert(
    findNodes(tree, (node) => classNameOf(node) === 'aps-nameListTitle').some((node) =>
      textOf(node).includes('屏蔽的上下文注入来源（2）'),
    ),
    'the list title carries the count',
  )
  assert(
    findNodes(tree, (node) => classNameOf(node) === 'aps-nameList').some((node) =>
      textOf(node).includes('context-pilot'),
    ),
    'the tags themselves are listed',
  )
}

console.log('# 自检：未管理 / 空 tag 列表的措辞')
{
  const studio = mountStudio({
    presets: [PLAIN_PRESET],
    meta: INJECTION_META,
    inspectView: {
      available: true,
      surfaceCount: 0,
      tools: [],
      blockedTools: [],
      skills: [],
      missingSkills: [],
      contexts: [],
      blockedContexts: [],
      forcedContexts: [],
      injectionFilter: { managed: false, blocked: [] },
    },
  })
  await openEditor(studio, await studio.root.settle())
  let tree = await settleInspect(studio)
  assert(
    findNodes(tree, (node) => classNameOf(node) === 'aps-fact').some((node) =>
      textOf(node).includes('未管理上下文注入来源'),
    ),
    'an unmanaged preset says so',
  )
  assert(
    findNodes(tree, (node) => classNameOf(node) === 'aps-nameListTitle').every(
      (node) => textOf(node).includes('上下文注入来源') === false,
    ),
    'an unmanaged preset renders no injection list',
  )
}

{
  const studio = mountStudio({
    presets: [PLAIN_PRESET],
    meta: INJECTION_META,
    inspectView: {
      available: true,
      surfaceCount: 0,
      tools: [],
      blockedTools: [],
      skills: [],
      missingSkills: [],
      contexts: [],
      blockedContexts: [],
      forcedContexts: [],
      injectionFilter: { managed: true, blocked: [] },
    },
  })
  await openEditor(studio, await studio.root.settle())
  const tree = await settleInspect(studio)
  assert(
    findNodes(tree, (node) => classNameOf(node) === 'aps-fact').some((node) =>
      textOf(node).includes('没有屏蔽任何上下文注入来源'),
    ),
    'an empty tag list says nothing is blocked',
  )
}

console.log('OK')
