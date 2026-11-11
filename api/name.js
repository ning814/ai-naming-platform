// api/name.js
// Vercel Node.js Serverless Function：AI 起名（多模型切换版）
// - modelConfigMap 统一存放 4 家模型的地址 / 密钥 / 模型名
// - 一套共用 fetch 调用逻辑，SSE 流式转发给前端
// - 结束后把「用户需求 / 名字方案 / 使用的模型」写入 Supabase 的 name_history
// - 所有密钥只从环境变量读取，代码中不含任何明文密钥

export const maxDuration = 60;

// ---------------------------------------------------------------------------
// 模型配置表：新增模型只要往这里加一项，主调用逻辑不用改
// ---------------------------------------------------------------------------
const MODEL_CONFIG_MAP = {
  doubao: {
    label: '豆包 · 火山方舟',
    baseURL: process.env.DOUBAO_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v1',
    apiKey: process.env.DOUBAO_API_KEY || '',
    envKey: 'DOUBAO_API_KEY',
    model: process.env.DOUBAO_MODEL || 'doubao-seed-2-1-pro-260915',
  },
  deepseek: {
    label: 'DeepSeek',
    baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    envKey: 'DEEPSEEK_API_KEY',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  },
  qwen: {
    label: '通义千问 · 百炼',
    // 必须用 compatible-mode 地址，普通 DashScope 地址不兼容 OpenAI 协议
    baseURL: process.env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY || '',
    envKey: 'QWEN_API_KEY（或 DASHSCOPE_API_KEY）',
    model: process.env.QWEN_MODEL || 'qwen-plus',
  },
  kimi: {
    label: 'Kimi · 月之暗面',
    baseURL: process.env.MOONSHOT_BASE_URL || 'https://api.moonshot.cn/v1',
    apiKey: process.env.MOONSHOT_API_KEY || '',
    envKey: 'MOONSHOT_API_KEY',
    model: process.env.MOONSHOT_MODEL || 'kimi-k3.1-pro',
  },
};

const DEFAULT_MODEL = 'kimi';
const SUPABASE_TABLE = process.env.SUPABASE_TABLE || 'name_history';

// ---------------------------------------------------------------------------
// 提示词
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `你是一位精通中文命名文化的起名专家，擅长结合字义、音韵、典籍意象与现代审美为人、品牌、店铺、宠物和作品起名。

必须遵守：
1. 恰好给出 3 组方案，每组只给 1 个名字。
2. 严格按下面的格式输出，不要输出开场白、结尾总结、表格、Markdown 标题或代码块：
第1组：名字
寓意：……（30-60 字，说明字义、出处或意象、读音感受）
第2组：名字
寓意：……
第3组：名字
寓意：……
3. 紧扣用户给出的姓氏、用途、性别、风格、字数等条件；未提供的信息按该用途的常见偏好合理补足，不要反问用户。
4. 三组方案之间要有明显风格差异，避免谐音雷同、生僻难读字和多音字歧义。
5. 若用户要求「英文名」，则名字用英文、寓意仍用简体中文解释；其余情况使用简体中文，不使用 emoji。`;

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 把表单字段拼成一段自然语言需求 */
function buildRequirement(body) {
  const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const surname = clean(body.surname, 20);
  const type = clean(body.type, 20);
  const gender = clean(body.gender, 10);
  const style = Array.isArray(body.style)
    ? body.style.map((s) => clean(s, 10)).filter(Boolean).join('、')
    : clean(body.style, 30);
  const length = clean(body.length, 10);
  const extra = clean(body.extra, 300);

  const parts = [];
  if (surname) parts.push(`姓氏/主体：${surname}`);
  if (type) parts.push(`用途：${type}`);
  if (gender && gender !== '不限') parts.push(`性别倾向：${gender}`);
  if (style) parts.push(`风格偏好：${style}`);
  if (length) parts.push(`名字字数：${length}`);
  if (extra) parts.push(`补充需求：${extra}`);

  return parts.join('；');
}

/** 从模型输出中解析 3 组方案 */
function parseGroups(text) {
  const groups = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const head = line.match(/^第\s*[一二三1-3]\s*组\s*[：:]\s*(.*)$/);
    if (head) {
      const name = head[1].replace(/[。，,；;、\s]+$/, '').trim();
      if (name) groups.push({ name, meaning: '' });
      continue;
    }

    const meaning = line.match(/^寓\s*意\s*[：:]\s*(.*)$/);
    if (meaning && groups.length) {
      const last = groups[groups.length - 1];
      last.meaning = (last.meaning ? last.meaning + ' ' : '') + meaning[1].trim();
    }
  }
  return groups.slice(0, 3);
}

/** 写入 Supabase（服务端优先用 service_role key，绕过 RLS） */
async function saveRecord({ requirement, names, modelName, rawText }) {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    return { saved: false, error: 'Supabase 环境变量未配置（SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY）' };
  }

  try {
    // 新版 sb_secret_ 密钥不是 JWT，只能放在 apikey 头；放到 Authorization 会被判定 Invalid JWT。
    // 旧版 service_role JWT（eyJ...）两个头都发，兼容性最好。
    const headers = {
      'Content-Type': 'application/json',
      apikey: key,
      Prefer: 'return=representation',
    };
    if (key.startsWith('eyJ')) {
      headers.Authorization = `Bearer ${key}`;
    }

    const resp = await fetch(`${url}/rest/v1/${SUPABASE_TABLE}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        user_requirement: requirement, // 用户起名需求
        name_result: rawText,           // 名字方案（完整文本，含寓意）
        model_name: modelName,          // 使用的模型
        names,                          // 结构化方案，便于页面/报表复用
      }),
    });

    if (!resp.ok) {
      const detail = (await resp.text()).slice(0, 300);
      return { saved: false, error: `Supabase 写入失败（${resp.status}）：${detail}` };
    }

    const rows = await resp.json().catch(() => []);
    return { saved: true, id: Array.isArray(rows) && rows[0] ? rows[0].id : null };
  } catch (err) {
    return { saved: false, error: `Supabase 请求异常：${err.message}` };
  }
}

/** 唯一的模型调用入口：所有模型共用这一套 OpenAI 兼容协议 */
async function requestModel(config, messages) {
  return fetch(`${config.baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      stream: true,
      temperature: 0.8,
      messages,
    }),
  });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
  // GET：返回可选模型列表（前端下拉框用），并标注哪些已配置密钥
  if (req.method === 'GET') {
    const models = Object.entries(MODEL_CONFIG_MAP).map(([key, cfg]) => ({
      key,
      label: cfg.label,
      model: cfg.model,
      configured: Boolean(cfg.apiKey),
    }));
    return res.status(200).json({ models, defaultModel: DEFAULT_MODEL });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: '只支持 GET / POST 请求' });
  }

  const body = typeof req.body === 'string' ? safeJson(req.body) : req.body || {};
  const modelKey = MODEL_CONFIG_MAP[body.model] ? body.model : DEFAULT_MODEL;
  const config = MODEL_CONFIG_MAP[modelKey];

  if (!config.apiKey) {
    return res.status(500).json({
      error: `${config.label} 未配置密钥，请在环境变量中设置 ${config.envKey}`,
      modelKey,
    });
  }

  const requirement = buildRequirement(body);
  if (!requirement) {
    return res.status(400).json({ error: '请至少填写姓氏、用途或补充需求中的一项' });
  }

  let upstream;
  try {
    upstream = await requestModel(config, [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: requirement },
    ]);
  } catch (err) {
    return res.status(502).json({ error: `调用 ${config.label} 失败：${err.message}`, modelKey });
  }

  if (!upstream.ok || !upstream.body) {
    const detail = (await upstream.text().catch(() => '')).slice(0, 300);
    return res.status(502).json({
      error: `${config.label} 返回 ${upstream.status}：${detail}`,
      modelKey,
      model: config.model,
    });
  }

  // 建立流式响应
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  // 客户端中断判断挂在 res 上：Vercel 会预解析 body，req 的 close 可能早于业务逻辑触发
  let clientClosed = false;
  res.on('close', () => {
    if (!res.writableEnded) clientClosed = true;
  });
  const canWrite = () => !clientClosed && !res.writableEnded;

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let fullText = '';
  let streamError = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) {
            fullText += delta;
            if (canWrite()) res.write(delta);
          }
        } catch {
          // 忽略非 JSON 的心跳/注释行
        }
      }
    }
  } catch (err) {
    streamError = err.message;
  }

  // 兜底解析结尾残留
  if (buffer.trim().startsWith('data:')) {
    try {
      const json = JSON.parse(buffer.trim().slice(5).trim());
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) {
        fullText += delta;
        if (canWrite()) res.write(delta);
      }
    } catch {
      /* ignore */
    }
  }

  const names = parseGroups(fullText);
  let saveResult = { saved: false, error: null };

  if (clientClosed) {
    saveResult = { saved: false, error: '客户端已断开，未写入数据库' };
  } else if (fullText.trim()) {
    saveResult = await saveRecord({
      requirement,
      names,
      modelName: config.model,
      rawText: fullText,
    });
  } else {
    saveResult = { saved: false, error: '模型未返回内容' };
  }

  if (!clientClosed) {
    // 元信息用 \u0000 与正文分隔，前端据此拆分
    const meta = {
      modelKey,
      modelLabel: config.label,
      model: config.model,
      requirement,
      names,
      saved: saveResult.saved,
      recordId: saveResult.id || null,
      saveError: saveResult.saved ? null : saveResult.error || null,
      streamError,
      chars: fullText.length,
    };
    try {
      res.write(`\u0000${JSON.stringify(meta)}`);
    } catch {
      /* ignore */
    }
  }

  res.end();
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
