# Edvance

基于 [Hile](https://github.com/cevio/hile) 与 [Deep Agents](https://docs.langchain.com/oss/javascript/deepagents/overview) 的海关走私案调查助手：支持多模态输入（文本 + 图片）、按需加载技能（Skills），用于证据识别、案情分析与结构化输出。

## 技术栈

- **运行时**: Node.js (ESM)
- **服务容器**: [@hile/core](https://www.npmjs.com/package/@hile/core)
- **HTTP**: [@hile/http](https://www.npmjs.com/package/@hile/http)（Koa + bodyparser）
- **Agent**: [deepagents](https://www.npmjs.com/package/deepagents) + [LangChain](https://js.langchain.com/) + [@langchain/openai](https://www.npmjs.com/package/@langchain/openai)
- **数据**: [@hile/typeorm](https://www.npmjs.com/package/@hile/typeorm) + MongoDB（按需）

## 环境要求

- Node.js >= 20
- pnpm（推荐）

## 环境变量

在项目根目录创建 `.env`，或通过 `--env-file` 指定：

| 变量 | 说明 |
|------|------|
| `HTTP_PORT` | HTTP 服务端口，默认示例 `9527` |
| `AI_API_KEY` | 大模型 API Key（兼容 OpenAI 的厂商均可） |
| `AI_API_URL` | 大模型 API Base URL（如阿里云 DashScope 兼容地址） |
| `AI_MODEL` | 模型名称（如 `qwen3.5-plus`） |

可选（TypeORM/MongoDB）：

- `TYPEORM_TYPE` / `TYPEORM_HOST` / `TYPEORM_PORT` / `TYPEORM_DATABASE` 等

## 安装与运行

```bash
pnpm install
pnpm run build
pnpm run dev    # 开发：--dev --env-file .env
# 或
pnpm run start  # 生产
```

服务默认监听 `http://127.0.0.1:9527`（以 `HTTP_PORT` 为准）。

## 项目结构

```
edvance/
├── src/
│   ├── http.boot.ts          # HTTP 服务启动（Hile 服务）
│   ├── controllers/          # 路由控制器
│   │   ├── index.controller.ts
│   │   ├── agent.controller.ts                 # POST /agent
│   │   ├── evidence-types.controller.ts        # GET /evidence-types
│   │   └── evidence-data/[id]/index.controller.ts # GET /evidence-data/:id
│   ├── entities/
│   │   ├── evidence-type.entity.ts
│   │   └── customs-inspection-record.entity.ts
│   ├── services/
│   │   └── agent.service.ts     # Deep Agent 定义（模型、backend、skills、tools）
│   ├── tools/
│   │   ├── console.tool.ts
│   │   └── mongodb-store.tool.ts # MongoDB 落库工具 mongodb_store
│   └── utils/
│       └── image.ts            # 多模态消息构建（文本 + 图片）
├── system_prompts/
│   └── SOUL.md                 # 系统提示词（海关走私案调查专员）
├── skills/                     # Agent 技能（SKILL.md + frontmatter）
│   └── smuggle-image-evidence-json/
│       ├── SKILL.md
│       └── schemas/
│           └── customs_inspection_record.json
├── .env
├── package.json
└── README.md
```

## API

### `GET /`

健康检查。

**响应示例：**

```json
{
  "ok": true,
  "message": "Hello from hile"
}
```

---

### `POST /agent`

与海关调查助手对话，支持纯文本或文本 + 图片（多模态）。

**请求体（JSON）：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `message` | string | 是* | 用户问题或指令 |
| `images` | array | 否 | 图片列表，用于识图分析 |

\* 若提供 `images`，可省略 `message`，将自动使用「请根据图片内容进行分析。」

**图片项格式（`images[]`）：**

- `{ "path": "/服务端本地绝对路径/to/image.jpg" }`
- 支持：`.jpg` / `.jpeg` / `.png` / `.gif` / `.webp`

**响应：** 助手回复的纯文本（或序列化后的内容）。

**示例：**

```bash
curl -X POST http://127.0.0.1:9527/agent \
  -H "Content-Type: application/json" \
  -d '{"message": "请识别这张单据类型并提取关键字段"}'
```

---

### `GET /evidence-types`

列出所有证据类型。

**响应类型：**

```json
[
  { "id": "string", "name": "string" }
]
```

**响应示例：**

```json
[
  { "id": "customs_inspection_record", "name": "查验记录单" },
  { "id": "other_evidence", "name": "其他证据" }
]
```

---

### `GET /evidence-data/:id`

按类型 `id` 查询该类型下所有已入库数据。

**路径参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | 是 | 证据类型 ID（如 `customs_inspection_record`） |

**响应示例：**

```json
[
  {
    "id": "66e7...",
    "typeId": "customs_inspection_record",
    "typeName": "查验记录单",
    "data": { "declaration_no": "3104..." },
    "extra": { "notes": "..." },
    "sourceImages": ["/workspace/a.jpg"],
    "createdAt": "2026-03-02T10:00:00.000Z",
    "updatedAt": "2026-03-02T10:00:00.000Z"
  }
]
```

**错误响应：**

- 未提供 `id`：`400 { "error": "请提供类型 id" }`
- 数据库未连接：`500 { "error": "MongoDB 连接未就绪" }`

## 系统提示词与技能

- **SOUL**（`system_prompts/SOUL.md`）：固定角色为「海关走私案调查专员」，负责证据识别、整理、分析、归档与案情回答，并遵守以证据为准、表述严谨、边界意识等准则。
- **Skills**（`skills/*/SKILL.md`）：Deep Agent 从 `/skills/` 按需加载，每个技能为一份带 YAML frontmatter（`name`、`description`）的 Markdown，用于证据解析、字段提取、类型分类/生成、证据存储等能力扩展。
- **工具**：当前提供 `mongodb_store`，用于将证据结构化结果写入 MongoDB。会维护类型集合 `evidence_types` 与数据集合 `customs_inspection_records`（见 `smuggle-image-evidence-json` 技能约定）。

## 脚本说明

| 命令 | 说明 |
|------|------|
| `pnpm run build` | 编译 TypeScript |
| `pnpm run dev` | 开发模式启动（带 .env） |
| `pnpm run start` | 生产模式启动（`hile start`） |
| `pnpm run agent` | 运行示例 Agent 脚本（需先 build，见 `dist/agent/weather.example.js`） |

## License

ISC
