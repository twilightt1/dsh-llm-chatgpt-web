/**
 * ChatGPT model/effort resolution.
 *
 * Vendored from codex-chatgpt-web `src/adapters/chatgpt-web/model.ts`
 * (MIT, (c) 2026 codex-chatgpt-web contributors) with one change: the backend
 * model ids are defined locally instead of imported from the upstream catalog.
 * No behavioral changes.
 * @module dsh-llm-chatgpt-web/chatgpt-model
 */

/** ChatGPT web backend behind the Sol (reasoning-selector) surface. */
export const CHATGPT_WEB_SOL_BACKEND_MODEL = 'gpt-5.6-sol'
/** ChatGPT web backend behind the Luna (Free/Go) surface. */
export const CHATGPT_WEB_LUNA_BACKEND_MODEL = 'gpt-5.6-luna'

export interface ChatGptWebCapabilities {
  localToolsEnabled: boolean
  solAvailable: boolean
  proAvailable: boolean
}

export interface ChatGptWebModelMode {
  modelId: string
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  displayLabel: 'Luna' | 'Think' | 'Instant' | 'Medium' | 'High' | 'Extra High' | 'Pro'
  uiEffortIndex: 0 | 1 | 2 | 3 | 4 | null
  thinkEnabled: boolean
  localTools: boolean
}

export function resolveChatGptWebModelMode(
  modelId: string,
  reasoning: string | undefined,
  capabilities: ChatGptWebCapabilities,
): ChatGptWebModelMode {
  if (modelId === CHATGPT_WEB_LUNA_BACKEND_MODEL) {
    if (capabilities.solAvailable) {
      throw new Error('ChatGPT Luna is not available while the account exposes the Sol model selector')
    }
    const effort = reasoning ?? 'low'
    if (effort !== 'low' && effort !== 'medium') {
      throw new Error(`ChatGPT Luna mode is not supported: ${effort}`)
    }
    const thinkEnabled = effort === 'medium'
    return {
      modelId,
      effort,
      displayLabel: thinkEnabled ? 'Think' : 'Luna',
      uiEffortIndex: null,
      thinkEnabled,
      localTools: capabilities.localToolsEnabled,
    }
  }
  if (modelId !== CHATGPT_WEB_SOL_BACKEND_MODEL) {
    throw new Error(`ChatGPT web model is not supported: ${modelId}`)
  }
  if (!capabilities.solAvailable) {
    throw new Error('ChatGPT Sol modes are not available for this Luna-only account')
  }
  const effort = reasoning ?? 'high'
  switch (effort) {
    case 'low':
      return { modelId, effort, displayLabel: 'Instant', uiEffortIndex: 0, thinkEnabled: false, localTools: capabilities.localToolsEnabled }
    case 'medium':
      return { modelId, effort, displayLabel: 'Medium', uiEffortIndex: 1, thinkEnabled: false, localTools: capabilities.localToolsEnabled }
    case 'high':
      return { modelId, effort, displayLabel: 'High', uiEffortIndex: 2, thinkEnabled: false, localTools: capabilities.localToolsEnabled }
    case 'xhigh':
      if (!capabilities.proAvailable) throw new Error('ChatGPT Extra High effort is not available for this account')
      return { modelId, effort, displayLabel: 'Extra High', uiEffortIndex: 3, thinkEnabled: false, localTools: capabilities.localToolsEnabled }
    case 'max':
      if (!capabilities.proAvailable) throw new Error('ChatGPT Pro effort is not available for this account')
      return { modelId, effort, displayLabel: 'Pro', uiEffortIndex: 4, thinkEnabled: false, localTools: capabilities.localToolsEnabled }
    default:
      throw new Error(`ChatGPT web effort is not supported: ${effort}`)
  }
}
