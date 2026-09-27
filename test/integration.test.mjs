import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import Llm, { LlmAdapter, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import Agents from '@deepseek-ai/dsh-agent'
import Sessions from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Prompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Loop from '@deepseek-ai/dsh-agent-loop'
import * as Todo from '@deepseek-ai/dsh-tool-todo'
import * as continuation from '../lib/index.js'

const text = value => ({ type: 'text', text: value })
const tool = (id, argumentsValue = '{}') => ({ type: 'tool-call', id: ToolCallId(id), name: 'fixture_tool', arguments: argumentsValue })

async function fixture(t, script, options = {}) {
  const ctx = new Context()
  for (const plugin of [Sessions, Projections, Agents, Llm, Prompt, Tools]) await ctx.plugin(plugin)
  await ctx.plugin(Loop, {})
  await ctx.plugin(Todo, { allowParallelInProgress: true })
  if (options.plugin !== false) await ctx.plugin(continuation, options.config || {})
  const requests = [], events = [], executions = []
  ctx.on('session/event', (_session, event) => events.push(event))
  const adapter = new class extends LlmAdapter {
    async *stream(request) {
      const index = requests.push(request) - 1
      if (index >= script.length) throw new Error('Unexpected extra model request')
      const entry = script[index]
      if (entry.before) await entry.before(request, handle.agent)
      for (const [index, block] of (entry.blocks || []).entries()) yield { type: 'block-end', index, block }
      yield { type: 'finish', reason: entry.reason || { kind: 'stop' } }
    }
  }()
  ctx.llm.registerAdapter(['fixture'], adapter)
  ctx.tools.register({
    name: 'fixture_tool', description: 'Controlled integration fixture',
    parameters: { type: 'object', properties: {}, additionalProperties: true },
    output: { schema: { type: 'object' }, render: (_args, value) => [text(JSON.stringify(value))] },
    async execute(args, execution) {
      executions.push({ args, callId: execution.callId })
      if (options.conclude) execution.concludeTurn()
      return { ok: true }
    }
  })
  const handle = await ctx.agents.create({ sessionId: randomUUID(), agentOptions: { provider: 'fixture', model: 'fixture-model', maxTokens: 8192 } })
  t.after(async () => { await handle.dispose(); await ctx.fiber.dispose() })
  handle.agent.followup(createUserMessage({ content: [text('Complete the fixture task')], source: { kind: 'user' } }))
  await handle.agent.whenIdle()
  return { ctx, handle, requests, events, executions }
}

test('real DSH baseline stops at max-tokens', async t => {
  const f = await fixture(t, [{ blocks: [text('partial')], reason: { kind: 'max-tokens' } }], { plugin: false })
  assert.equal(f.requests.length, 1)
  assert.equal(f.events.find(e => e.type === 'turn/end').data.reason.kind, 'max-tokens')
})

test('output limit continues tools and final response in the same real DSH turn', async t => {
  const f = await fixture(t, [
    { blocks: [text('partial')], reason: { kind: 'max-tokens' } },
    { blocks: [tool('after-limit')], reason: { kind: 'tool-calls' } },
    { blocks: [text('completed')] }
  ])
  assert.equal(f.requests.length, 3)
  assert.equal(f.executions.length, 1)
  assert.equal(f.events.filter(e => e.type === 'turn/start').length, 1)
  assert.equal(f.events.filter(e => e.type === 'turn/end').length, 1)
  assert.equal(f.events.filter(e => e.type === 'step/start').length, 3)
  assert.ok(f.requests[1].messages.some(m => m.role === 'assistant' && m.content.some(b => b.text === 'partial')))
  assert.ok(f.requests[2].messages.some(m => m.role === 'tool'))
  assert.ok(f.requests.every(request => request.maxTokens === 8192))
})

test('normal completion is never automatically reopened', async t => {
  const f = await fixture(t, [{ blocks: [text('done')] }])
  assert.equal(f.requests.length, 1)
  assert.equal(f.events.filter(e => e.type === 'user/message' && e.data.source.kind === 'turn-continuation').length, 0)
})

test('DSH excludes truncated tool calls, and continuation executes only a fresh complete call', async t => {
  const f = await fixture(t, [
    { blocks: [tool('cut', '{"value":')], reason: { kind: 'max-tokens' } },
    { blocks: [tool('fresh', '{"value":42}')], reason: { kind: 'tool-calls' } },
    { blocks: [text('done')] }
  ])
  assert.deepEqual(f.executions.map(e => e.callId), ['fresh'])
  assert.equal(f.events.filter(e => e.type === 'tool/call' && e.data.callId === 'cut').length, 0)
  assert.ok(!f.requests[1].messages.some(m => m.content.some(b => b.type === 'tool-call' && b.id === 'cut')))
  assert.equal(f.requests.length, 3)
})

test('explicit tool conclusion after truncation is respected', async t => {
  const f = await fixture(t, [
    { blocks: [text('partial')], reason: { kind: 'max-tokens' } },
    { blocks: [tool('conclude')], reason: { kind: 'tool-calls' } }
  ], { conclude: true })
  assert.equal(f.requests.length, 2)
  assert.equal(f.executions.length, 1)
})

test('repeated output limits keep the original turn open without lowering the output cap', async t => {
  const f = await fixture(t, [
    ...Array.from({ length: 4 }, (_, i) => ({ blocks: [text(`part ${i}`)], reason: { kind: 'max-tokens' } })),
    { blocks: [text('done')] }
  ])
  assert.equal(f.requests.length, 5)
  assert.equal(f.events.filter(e => e.type === 'turn/start').length, 1)
  assert.equal(f.events.filter(e => e.type === 'turn/end').length, 1)
  assert.ok(f.requests.every(r => r.maxTokens === 8192 && r.model === 'fixture-model' && r.provider === 'fixture'))
  const prompts = f.events.filter(e => e.type === 'user/message' && e.data.source.kind === 'turn-continuation')
  assert.equal(prompts.length, 4)
  assert.ok(prompts.every(e => e.data.source.cause === 'max-tokens'))
})

test('user cancellation while continuing stays stopped', async t => {
  const f = await fixture(t, [
    { blocks: [text('partial')], reason: { kind: 'max-tokens' } },
    { before: (_request, agent) => agent.cancel({ kind: 'user' }), blocks: [text('cancelled')] }
  ])
  assert.equal(f.requests.length, 2)
  assert.equal(f.events.filter(e => e.type === 'turn/end').at(-1).data.reason.kind, 'aborted')
  assert.equal(f.handle.agent.inbox.nextStep.length, 0)
})

test('configured continuation budget and disabled mode are respected', async t => {
  const script = [
    { blocks: [text('one')], reason: { kind: 'max-tokens' } },
    { blocks: [text('two')], reason: { kind: 'max-tokens' } }
  ]
  const bounded = await fixture(t, script, { config: { maxContinuations: 1 } })
  assert.equal(bounded.requests.length, 2)
  const disabled = await fixture(t, script.slice(0, 1), { config: { enabled: false } })
  assert.equal(disabled.requests.length, 1)
})

test('existing human steering is preserved without duplicate limit continuation', async t => {
  const f = await fixture(t, [
    {
      before: (_request, agent) => agent.steer(createUserMessage({ content: [text('Use this correction')], source: { kind: 'user' } })),
      blocks: [text('partial')], reason: { kind: 'max-tokens' }
    },
    { blocks: [tool('steered')], reason: { kind: 'tool-calls' } },
    { blocks: [text('done')] }
  ])
  assert.equal(f.requests.length, 3)
  assert.ok(f.requests[1].messages.some(m => m.role === 'user' && m.content.some(b => b.text === 'Use this correction')))
  assert.equal(f.events.filter(e => e.type === 'user/message' && e.data.source.cause === 'max-tokens').length, 0)
  assert.equal(f.events.filter(e => e.type === 'turn/start').length, 1)
})

test('provider failures after a continuation are not turned into endless retries', async t => {
  const f = await fixture(t, [
    { blocks: [text('partial')], reason: { kind: 'max-tokens' } },
    { reason: { kind: 'error', failure: { code: 'QUOTA_EXCEEDED', message: 'fixture quota error' } } }
  ])
  assert.equal(f.requests.length, 2)
  assert.equal(f.events.filter(e => e.type === 'turn/end').at(-1).data.reason.kind, 'error')
})

test('a later normal turn does not inherit continuation state', async t => {
  const f = await fixture(t, [
    { blocks: [text('partial')], reason: { kind: 'max-tokens' } },
    { blocks: [text('first task done')] },
    { blocks: [text('second task done')] }
  ])
  f.handle.agent.followup(createUserMessage({ content: [text('A new task')], source: { kind: 'user' } }))
  await f.handle.agent.whenIdle()
  assert.equal(f.requests.length, 3)
  const endings = f.events.filter(e => e.type === 'turn/end')
  assert.equal(endings.length, 2)
  assert.equal(endings[1].data.reason.kind, 'completed')
  assert.equal(f.events.filter(e => e.type === 'user/message' && e.data.source.kind === 'turn-continuation').length, 1)
})

const todos = (id, status) => ({ type: 'tool-call', id: ToolCallId(id), name: 'todo_write', arguments: JSON.stringify({ todos: [{ content: 'Verify and deliver the artifact', status }] }) })

test('observed premature stop pattern with pending todos completes in one turn', async t => {
  const f = await fixture(t, [
    { blocks: [todos('plan', 'in_progress')], reason: { kind: 'tool-calls' } },
    { blocks: [{ type: 'reasoning', text: 'Next I need to validate the result.' }, text('\n\n')] },
    { blocks: [text("Now I'll finalize and deliver the results.")] },
    { blocks: [text('最後收尾：')] },
    { blocks: [tool('verify')], reason: { kind: 'tool-calls' } },
    { blocks: [todos('finish-plan', 'completed')], reason: { kind: 'tool-calls' } },
    { blocks: [text('Verified artifact delivered.')] }
  ])
  assert.equal(f.requests.length, 7)
  assert.equal(f.executions.length, 1)
  assert.equal(f.events.filter(e => e.type === 'turn/start').length, 1)
  assert.equal(f.events.filter(e => e.type === 'turn/end').length, 1)
  assert.equal(f.events.filter(e => e.type === 'turn/end')[0].data.reason.kind, 'completed')
  assert.equal(f.events.filter(e => e.type === 'user/message' && e.data.source.cause === 'unfinished-todos').length, 3)
})

test('a real blocker can yield unfinished todos and explain without looping', async t => {
  const f = await fixture(t, [
    { blocks: [todos('plan', 'pending')], reason: { kind: 'tool-calls' } },
    { blocks: [text('Access is missing.')] },
    { blocks: [{ type: 'tool-call', id: ToolCallId('yield'), name: 'continuation_yield', arguments: JSON.stringify({ reason: 'Required deployment credential is unavailable.' }) }], reason: { kind: 'tool-calls' } },
    { blocks: [text('Please supply the missing deployment credential.')] }
  ])
  assert.equal(f.requests.length, 4)
  assert.equal(f.events.filter(e => e.type === 'turn/start').length, 1)
})

test('unfinished-todo continuation can be disabled independently', async t => {
  const f = await fixture(t, [
    { blocks: [todos('plan', 'pending')], reason: { kind: 'tool-calls' } },
    { blocks: [text('Next I will work.')] }
  ], { config: { continueIncompleteTodos: false } })
  assert.equal(f.requests.length, 2)
})
