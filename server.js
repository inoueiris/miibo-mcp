#!/usr/bin/env node
// miibo MCP サーバー
// miibo チャットAPI (https://docs.miibo.tech/reference/チャット) をMCPツール化し、
// Claude Code から AI社員（miiboエージェント）に話しかけられるようにする。
// 設定: employees.json（社員名 → agent_id / api_key。git管理外）

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const MIIBO_API_URL = 'https://api-mebo.dev/api'
const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), 'employees.json')

function loadConfig() {
  let raw
  try {
    raw = readFileSync(CONFIG_PATH, 'utf-8')
  } catch {
    throw new Error(
      `設定ファイルがありません: ${CONFIG_PATH}\n` +
      'employees.json.example をコピーして agent_id / api_key を記入してください。'
    )
  }
  const config = JSON.parse(raw)
  if (!config.employees || Object.keys(config.employees).length === 0) {
    throw new Error('employees.json に社員が1名も定義されていません。')
  }
  return config
}

// APIキーやIDとして妥当な値か（空・日本語プレースホルダを弾く）
function isFilled(value) {
  return typeof value === 'string' && value.length > 0 && /^[\x21-\x7e]+$/.test(value)
}

function resolveEmployee(config, name) {
  const emp = config.employees[name]
  if (!emp) {
    const known = Object.keys(config.employees).join('、')
    throw new Error(`社員「${name}」は未設定です。設定済み: ${known}`)
  }
  const apiKey = isFilled(emp.api_key) ? emp.api_key : config.default_api_key
  if (!isFilled(emp.agent_id) || !isFilled(apiKey)) {
    throw new Error(`社員「${name}」の agent_id または api_key が未記入（またはプレースホルダのまま）です。employees.json を確認してください。`)
  }
  return { agentId: emp.agent_id, apiKey, role: emp.role || '' }
}

function resolveAdmin(config) {
  if (!isFilled(config.admin_api_key) || !isFilled(config.admin_uid)) {
    throw new Error('employees.json の admin_api_key / admin_uid が未記入（またはプレースホルダのまま）です。miibo管理画面のAdmin APIキー発行欄で確認してください。')
  }
  return { apiKey: config.admin_api_key, uid: config.admin_uid }
}

async function miiboAdminFetch(config, method, path, body) {
  const { apiKey, uid } = resolveAdmin(config)
  const res = await fetch(`${MIIBO_API_URL.replace('/api', '')}/admin/${uid}${path}`, {
    method,
    headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text().catch(() => '')
  if (!res.ok) {
    throw new Error(`miibo 管理APIエラー: ${res.status} ${text}`.trim())
  }
  try { return JSON.parse(text) } catch { return { raw: text } }
}

const server = new McpServer({ name: 'miibo', version: '0.1.0' })

server.registerTool(
  'miibo_admin_list_agents',
  {
    description: 'miiboアカウントが所有する全エージェントのID一覧を取得する（管理API。admin_api_key/admin_uidが必要）',
    inputSchema: {},
  },
  async () => {
    const config = loadConfig()
    const json = await miiboAdminFetch(config, 'GET', '/agents')
    return { content: [{ type: 'text', text: JSON.stringify(json, null, 2) }] }
  }
)

server.registerTool(
  'miibo_admin_create_or_update_agent',
  {
    description:
      'miiboエージェントを新規作成または更新する（管理API）。agent_id を渡すと更新、省略すると新規作成。' +
      '新規作成時はチャット用APIキーも同時発行し、レスポンスの id / issuedAgentApiKey を employees.json に転記すること。',
    inputSchema: {
      displayName: z.string().max(100).describe('エージェント表示名（例: 営業アシスタントAI）'),
      description: z.string().max(120).describe('エージェントの説明（120文字以内）'),
      prompt: z.string().describe('システムプロンプト全文（6000トークン以内）'),
      llm: z.string().describe('LLMモデル名（例: claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5-20251001）'),
      scope: z.enum(['public', 'private']).default('private').describe('公開範囲。機密ナレッジを扱う場合は private'),
      temperature: z.number().min(0).max(1).optional().describe('温度（省略時はmiibo既定）'),
      photoUrl: z.string().default('').describe('アバター画像URL（任意）'),
      providerName: z.string().optional().describe('提供者名（省略時は employees.json の provider_name）'),
      useKnowledgeDataStore: z.boolean().default(true).describe('ナレッジデータストアを使うか'),
      agent_id: z.string().optional().describe('更新対象のエージェントID（省略で新規作成）'),
    },
  },
  async ({ displayName, description, prompt, llm, scope, temperature, photoUrl, providerName, useKnowledgeDataStore, agent_id }) => {
    const config = loadConfig()
    const agent = {
      displayName,
      description,
      photoUrl,
      providerName: providerName ?? config.provider_name ?? '',
      scope,
      llmSettings: { llm, prompt, ...(temperature !== undefined ? { temperature } : {}) },
      knowledge: { knowledgeDataStore: { useKnowledgeDataStore } },
    }
    if (agent_id) agent.id = agent_id
    const body = { agent, issueAgentApiKey: !agent_id }
    const json = await miiboAdminFetch(config, agent_id ? 'PUT' : 'POST', '/agent', body)
    return { content: [{ type: 'text', text: JSON.stringify(json, null, 2) }] }
  }
)

server.registerTool(
  'miibo_add_knowledge',
  {
    description:
      '社員のナレッジデータストアにRAG素材（テキスト）を登録/更新する。' +
      'labelが既存と同じ場合は更新。社員のチャット用APIキー（employees.json）を使う。',
    inputSchema: {
      employee: z.string().describe('社員名（employees.json のキー）'),
      label: z.string().describe('ナレッジのラベル（例: 会社概要）。同名で上書き更新'),
      text: z.string().max(50000).describe('登録する本文（50000文字以内）'),
    },
  },
  async ({ employee, label, text }) => {
    const config = loadConfig()
    const { agentId, apiKey } = resolveEmployee(config, employee)
    const res = await fetch('https://api-mebo.dev/datastore', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, agent_id: agentId, label, text }),
    })
    const resText = await res.text().catch(() => '')
    if (!res.ok) {
      throw new Error(`miibo ナレッジ登録エラー: ${res.status} ${resText}`.trim())
    }
    return { content: [{ type: 'text', text: `登録完了: ${employee} / ${label}${resText ? `\n${resText}` : ''}` }] }
  }
)

server.registerTool(
  'miibo_list_employees',
  {
    description: 'miiboに登録済みのAI社員一覧（名前・役割・会話可能かどうか）を返す',
    inputSchema: {},
  },
  async () => {
    const config = loadConfig()
    const list = Object.entries(config.employees).map(([name, emp]) => ({
      name,
      role: emp.role || '',
      ready: isFilled(emp.agent_id) && (isFilled(emp.api_key) || isFilled(config.default_api_key)),
    }))
    return { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] }
  }
)

server.registerTool(
  'miibo_chat',
  {
    description:
      'AI社員（miiboエージェント）に発話を送り、応答を受け取る。' +
      '同じ uid を使い続けると会話履歴が継続する。別の話題を新規に始めたいときは uid を変える。',
    inputSchema: {
      employee: z.string().describe('社員名。miibo_list_employees で確認できる'),
      utterance: z.string().describe('社員への発話（質問・依頼・議題など）'),
      uid: z.string().optional().describe('会話スレッドID。省略時は "claude-code-<社員名>"'),
      state: z.record(z.string(), z.string()).optional().describe(
        'ユーザーステート（miiboのstate変数に渡すキーと値）。' +
        '値をAIに読ませるには、エージェントのシステムプロンプト側に #{キー名} と書いて埋め込んでおく必要がある。' +
        'プロンプトに埋め込みが無いと、渡しても応答には反映されない。'
      ),
    },
  },
  async ({ employee, utterance, uid, state }) => {
    const config = loadConfig()
    const { agentId, apiKey } = resolveEmployee(config, employee)

    const body = {
      api_key: apiKey,
      agent_id: agentId,
      utterance,
      uid: uid || `claude-code-${employee}`,
    }
    // state はオブジェクトのまま渡す。JSON文字列化して送ると miibo は HTTP 400（空ボディ）を返す。
    // 実機検証済み: state=文字列 → 400 / state=オブジェクト → 200。
    if (state) body.state = state

    const res = await fetch(MIIBO_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`miibo APIエラー: ${res.status} ${errText}`.trim())
    }
    const json = await res.json()
    const text = json.bestResponse?.utterance || ''
    if (!text) {
      throw new Error(`miiboから空応答が返りました: ${JSON.stringify(json).slice(0, 500)}`)
    }
    return { content: [{ type: 'text', text }] }
  }
)

const transport = new StdioServerTransport()
await server.connect(transport)
