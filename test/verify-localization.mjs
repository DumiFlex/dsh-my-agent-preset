import assert from 'node:assert/strict'
import { findNodes, mountStudio, textOf } from './_studio-harness.mjs'

const preset = {
  id: 'custom-review',
  name: 'Review',
  description: 'Review changes',
  instructions: '',
  enabled: true,
  order: 0,
  tools: { mode: 'all', names: [] },
  skills: [],
}

const studio = mountStudio({
  language: 'en',
  presets: [preset, { ...preset, id: 'custom-review-copy', name: 'Review (Copy 1)', order: 1 }],
  meta: {
    registryAvailable: true,
    capabilities: ['snapshotContexts'],
    contextCatalog: [
      { name: 'working-directory:current', label: '当前工作区', description: '工作目录', known: true },
      { name: 'external:custom', label: 'External label', description: '', known: false },
    ],
  },
})

let tree = await studio.root.settle()
const button = (label) => findNodes(tree, (node) =>
  typeof node.props?.onClick === 'function' && textOf(node) === label,
)[0]

await button('Duplicate').props.onClick()
tree = await studio.root.flush()
assert.equal(studio.calls.find((call) => call.endpoint === 'save').body.name, 'Review (Copy 2)')

const fileInput = findNodes(tree, (node) => node.type === 'input' && node.props.type === 'file')[0]
await fileInput.props.onChange({
  target: { files: [{ text: async () => JSON.stringify([{ name: 'Review', description: '' }]) }], value: 'presets.json' },
})
tree = await studio.root.flush()
await button('Import selected').props.onClick()
tree = await studio.root.flush()
assert(studio.calls.some((call) => call.endpoint === 'save' && call.body.name === 'Review (Import 1)'))

findNodes(tree, (node) => node.props?.className === 'aps-cardMain')[0].props.onClick()
tree = await studio.root.flush()
assert.match(textOf(tree), /Current workspace/)
assert.match(textOf(tree), /External label/)
assert.doesNotMatch(textOf(tree), /当前工作区/)

console.log('English localization regressions passed')
