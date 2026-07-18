# miibo-mcp

miiboチャットAPIをMCPツール化し、Claude CodeからAI社員（miiboエージェント）に直接話しかけるためのMCPサーバー。

## 構成

```
Claude Code ──(MCP/stdio)── server.js ──(HTTPS)── miibo チャットAPI
                                │                  https://api-mebo.dev/api
                                └─ employees.json（社員名→agent_id/api_key。git管理外）
```

- 本リポジトリは通信の器のみ。AI社員の原本（プロンプト・RAG素材）は別途管理する
- APIキー・agent_idは `employees.json` に置き、コミットしない

## セットアップ

1. `cp employees.json.example employees.json`
2. miibo管理画面からAPIキーとagent_idを転記
3. Claude Codeに登録（済みなら不要）:
   `claude mcp add miibo -s user -- node ~/project/miibo-mcp/server.js`

## ツール

| ツール | 説明 | 必要なキー |
|---|---|---|
| `miibo_chat` | 社員に発話を送り応答を取得。`uid` 固定で会話継続、変更で新規スレッド | チャット用 |
| `miibo_list_employees` | 設定済み社員の一覧（name / role / ready） | 不要 |
| `miibo_admin_create_or_update_agent` | エージェントの新規作成（チャット用キー同時発行）/ 更新 | Admin |
| `miibo_admin_list_agents` | 所有エージェントのID一覧 | Admin |
| `miibo_add_knowledge` | ナレッジデータストアへRAG素材を登録/更新（同labelで上書き） | チャット用 |

キーは2系統: **チャット用APIキー**（エージェントに紐づく。`default_api_key` / 社員別 `api_key`）と **Admin APIキー**（`admin_api_key` + `admin_uid`。エージェント作成・一覧に使用）。

## ライセンス

MIT License（[LICENSE](LICENSE) を参照）
