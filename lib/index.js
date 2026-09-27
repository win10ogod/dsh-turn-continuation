import z from '@deepseek-ai/schemastery'
import { createUserMessage, lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm'

export const name = 'turn-continuation'
export const inject = ['agents', 'sessions', 'tools']
export const Config = z.object({
  enabled: z.boolean().default(true),
  maxContinuations: z.number().step(1).min(0).default(0)
})

const SOURCE = 'turn-continuation'
const resumeText = 'The previous model response reached its output-token limit. Continue the same task from the retained conversation and current workspace. Preserve completed work and tool results; do not restart or repeat completed operations. Tool calls cut off in that response were not executed: issue complete fresh calls if still needed. Continue until the task is completed, or explain a genuine blocker.'
const toolsText = 'Continue the current task from the tool results just received. Preserve completed work; finish the task or explain a genuine blocker.'

/** Extend the current turn through public Agent hooks; never start a follow-up turn. */
export function apply(ctx, config = {}) {
  if (config.enabled === false) return
  const maxContinuations = config.maxContinuations ?? 0
  if (!Number.isSafeInteger(maxContinuations) || maxContinuations < 0) throw new Error('maxContinuations must be a nonnegative safe integer (0 means unlimited)')
  const states = new WeakMap()

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      states.set(session, { turn: event.data.turn, count: 0, sawLimit: false, latest: null, concluded: false })
      return
    }
    const state = states.get(session)
    if (!state) return
    if (event.type === 'turn/end') {
      states.delete(session)
      return
    }
    if (event.type === 'assistant/message' && event.data.turn === state.turn) {
      const reason = lastAssistantStreamChunk(event.data.stream || [], 'finish')?.reason?.kind || 'stop'
      state.latest = {
        step: event.data.step, reason,
        calls: event.data.message.content.filter(block => block.type === 'tool-call'),
        results: new Set(), handled: false
      }
      state.concluded = false
      if (reason === 'max-tokens') state.sawLimit = true
    } else if (event.type === 'tool/result' && event.data.step === state.latest?.step) {
      state.latest.results.add(event.data.message.toolCallId)
    }
  })

  ctx.on('tools/result', (execution, result) => {
    if (execution.parent || !result.concludesTurn) return
    const state = states.get(execution.agent?.session)
    if (state) state.concluded = true
  })

  ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
    if (signal.aborted) return
    const state = states.get(agent.session)
    const last = state?.latest
    if (!last || state.turn !== turn || last.handled || state.concluded) return
    const limited = last.reason === 'max-tokens'
    // rc.2 retains a max-tokens turn-ending flag after later successful steps.
    // Keep consuming ordinary tool results in that same turn, until a real
    // final response or explicit tool conclusion is reached.
    const afterTools = state.sawLimit && last.calls.length > 0 &&
      last.calls.every(call => last.results.has(call.id)) &&
      (last.reason === 'tool-calls' || last.reason === 'stop')
    if (!limited && !afterTools) return
    if (limited && maxContinuations > 0 && state.count >= maxContinuations) return
    if (signal.aborted || agent.inbox.nextStep.length > 0) return
    last.handled = true
    if (limited) state.count++
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: limited ? resumeText : toolsText }],
      source: { kind: SOURCE, cause: limited ? 'max-tokens' : 'tool-results', turn, step: last.step }
    }))
  })

  ctx.on('agent/disposed', ({ agent }) => states.delete(agent.session))
}
