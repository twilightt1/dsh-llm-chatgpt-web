import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import {
  compileNativeSecurityPolicy,
  resolveNativeSecurityConfig,
} from '../src/native/policy.ts'
import type { NativePolicyRuntimeIdentity } from '../src/native/types.ts'

const readTool: ToolSchema = {
  name: 'read_file',
  description: 'read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
}
const searchTool: ToolSchema = {
  name: 'search',
  description: 'search workspace',
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
}
const writeTool: ToolSchema = {
  name: 'write_file',
  description: 'write a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
}
const user: Message = {
  id: MessageId('user-1'),
  role: 'user',
  content: [{ type: 'text', text: 'inspect the workspace' }],
  source: { kind: 'user' },
}
const runtime: NativePolicyRuntimeIdentity = {
  adapterVersion: '0.7.0-test',
  connectorRuntime: 'external',
  connectorName: 'DSH Native',
  brokerSocketPath: '/tmp/dsh-native.sock',
  nativeRuntimeConfigPath: '/tmp/native-runtime.json',
}
const existingWorkspace = process.cwd()

function request(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'chatgpt-web',
    model: 'chatgpt-web/high',
    messages: [user],
    tools: [readTool, searchTool, writeTool],
    maxTokens: 512,
    sessionId: 'session-1' as never,
    ...overrides,
  }
}

describe('native security config', () => {
  it('resolves compatible defaults', () => {
    expect(resolveNativeSecurityConfig(undefined, '/tmp/project')).toEqual({
      toolPolicy: 'full',
      workspaceRoot: '/tmp/project',
      workspaceRootSource: 'process.cwd',
      approval: 'none',
      rules: [],
      evidenceLimits: { maxBytes: 65_536, maxLines: 200 },
    })
  })

  it('expands home and rejects unsafe or malformed configuration', () => {
    expect(resolveNativeSecurityConfig({ workspaceRoot: '~/project' }).workspaceRoot)
      .toBe(join(homedir(), 'project'))
    expect(() => resolveNativeSecurityConfig({ workspaceRoot: 'bad\u0000root' })).toThrow(/control|NUL/i)
    expect(() => resolveNativeSecurityConfig({ workspaceRoot: 'line\nroot' })).toThrow(/control|newline/i)
    expect(() => resolveNativeSecurityConfig({ toolPolicy: 'other' as never })).toThrow(/toolPolicy/i)
    expect(() => resolveNativeSecurityConfig({ approval: 'other' as never })).toThrow(/approval/i)
    expect(() => resolveNativeSecurityConfig({ evidenceLimits: { maxBytes: 255 } })).toThrow(/maxBytes/i)
    expect(() => resolveNativeSecurityConfig({ evidenceLimits: { maxLines: 0 } })).toThrow(/maxLines/i)
  })

  it('validates exact rules and secure capability requirements', () => {
    expect(() => resolveNativeSecurityConfig({ rules: [{ ...readTool, tool: '' } as never] })).toThrow(/tool/i)
    expect(() => resolveNativeSecurityConfig({ rules: [{ tool: ' read_file', capability: 'workspace.read' }] })).toThrow(/trim/i)
    expect(() => resolveNativeSecurityConfig({ rules: [
      { tool: 'read_file', capability: 'workspace.read' },
      { tool: 'read_file', capability: 'workspace.read' },
    ] })).toThrow(/duplicate/i)
    expect(() => resolveNativeSecurityConfig({ rules: [{
      tool: 'read_file', capability: 'workspace.read', pathArguments: ['/path~2bad'],
    }] })).toThrow(/pointer|escape/i)
    expect(() => resolveNativeSecurityConfig({
      toolPolicy: 'evidence-only',
      rules: [{ tool: 'run', capability: 'side-effect', pathArguments: ['/path'] }],
    })).toThrow(/side-effect/i)
    expect(() => resolveNativeSecurityConfig({
      toolPolicy: 'evidence-only',
      rules: [{ tool: 'read_file', capability: 'workspace.read' }],
    })).toThrow(/path/i)
    expect(() => resolveNativeSecurityConfig({
      toolPolicy: 'allowlist',
      rules: [{ tool: 'run', capability: 'execution.read' }],
    })).toThrow(/sanitized|result/i)
    expect(resolveNativeSecurityConfig({
      toolPolicy: 'allowlist',
      rules: [{ tool: 'run', capability: 'execution.read', result: 'sanitized-evidence' }],
    }).rules[0]).toEqual({
      tool: 'run', capability: 'execution.read', pathArguments: [], result: 'sanitized-evidence',
    })
  })
})

describe('CompiledNativeSecurityPolicy', () => {
  it('keeps full mode compatible while returning detached immutable preparation', () => {
    const config = resolveNativeSecurityConfig(undefined, existingWorkspace)
    const compiled = compileNativeSecurityPolicy(config, ['/tmp/private-runtime.json'])
    const original = request()
    const prepared = compiled.prepareRequest(original, runtime)

    expect(prepared.providerOptions).toEqual(original)
    expect(prepared.providerOptions).not.toBe(original)
    expect(prepared.providerOptions.messages).not.toBe(original.messages)
    expect(prepared.providerOptions.tools).not.toBe(original.tools)
    expect(prepared.providerOptions.signal).toBe(original.signal)
    expect(prepared.summary.tools).toEqual([
      expect.objectContaining({ tool: 'read_file', capability: 'full-unrestricted', result: 'raw-unbounded', outputProvenance: 'unverified-full' }),
      expect.objectContaining({ tool: 'search', capability: 'full-unrestricted', result: 'raw-unbounded', outputProvenance: 'unverified-full' }),
      expect.objectContaining({ tool: 'write_file', capability: 'full-unrestricted', result: 'raw-unbounded', outputProvenance: 'unverified-full' }),
    ])
    expect(Object.isFrozen(prepared.providerOptions)).toBe(true)
    expect(Object.isFrozen(prepared.providerOptions.messages)).toBe(true)
    expect(Object.isFrozen(prepared.providerOptions.tools)).toBe(true)
    expect(prepared.nativeRound).toBeUndefined()
  })

  it('filters secure tools in original inventory order and handles empty effective inventory', () => {
    const config = resolveNativeSecurityConfig({
      toolPolicy: 'evidence-only',
      rules: [
        { tool: 'search', capability: 'workspace.search', pathArguments: ['/path'] },
        { tool: 'read_file', capability: 'workspace.read', pathArguments: ['/path'] },
      ],
    }, existingWorkspace)
    const compiled = compileNativeSecurityPolicy(config, [])
    expect(compiled.workspaceBoundary?.canonicalRoot).toBe(existingWorkspace)
    const prepared = compiled.prepareRequest(request(), runtime)
    expect(prepared.providerOptions.tools?.map(tool => tool.name)).toEqual(['read_file', 'search'])
    expect(prepared.summary.tools.map(tool => tool.tool)).toEqual(['read_file', 'search'])
    expect(prepared.inventoryHash).toMatch(/^[a-f0-9]{64}$/)
    expect(prepared.approvalHash).toMatch(/^[a-f0-9]{64}$/)

    const empty = compileNativeSecurityPolicy(resolveNativeSecurityConfig({
      toolPolicy: 'allowlist',
      rules: [{ tool: 'missing', capability: 'workspace.read', pathArguments: ['/path'] }],
    }, existingWorkspace), []).prepareRequest(request(), runtime)
    expect(empty.providerOptions.tools).toEqual([])
    expect(empty.summary.tools).toEqual([])
  })

  it('rejects duplicate actual schemas and keeps auxiliary secure requests tool-free', () => {
    const config = resolveNativeSecurityConfig({
      toolPolicy: 'allowlist',
      rules: [{ tool: 'read_file', capability: 'workspace.read', pathArguments: ['/path'] }],
    }, existingWorkspace)
    const compiled = compileNativeSecurityPolicy(config, [])
    expect(() => compiled.prepareRequest(request({ tools: [readTool, readTool] }), runtime)).toThrow(/duplicate/i)
    const prepared = compiled.prepareRequest(request({ purpose: 'session-title' }), runtime)
    expect(prepared.providerOptions.tools).toEqual([])
    expect(prepared.nativeRound).toBeUndefined()
  })

  it('changes approval identity when runtime identity changes', () => {
    const compiled = compileNativeSecurityPolicy(resolveNativeSecurityConfig({
      toolPolicy: 'allowlist',
      rules: [{ tool: 'read_file', capability: 'workspace.read', pathArguments: ['/path'] }],
    }, existingWorkspace), [])
    const first = compiled.prepareRequest(request({ tools: [readTool] }), runtime)
    const second = compiled.prepareRequest(request({ tools: [readTool] }), {
      ...runtime,
      adapterVersion: '0.7.1-test',
    })
    expect(first.policyHash).toBe(second.policyHash)
    expect(first.inventoryHash).toBe(second.inventoryHash)
    expect(first.approvalHash).not.toBe(second.approvalHash)
  })
})
