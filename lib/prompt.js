/**
 * 喂给后台讲解模型的提示词与输出解析。
 *
 * 设计要点：
 * - 讲解走「旁路」调用：不进入主对话历史，不污染 AI 编码的上下文（省钱、不干扰主任务）。
 * - 输出必须是<b>严格 JSON</b>，这样同一份解释稿既能渲染成面板卡片，也能落成 Markdown /
 *   Mermaid / Markmap / Canvas 四种 Obsidian 形态，不必再写正则去抠文本。
 * - 抽取失败时退回「把整段文本当业务说明」，保证至少有东西可看。
 */

export const SYSTEM_PROMPT = [
  '你是一名资深全栈工程师兼技术讲师，正在给同事讲解刚刚被 AI 改动的代码。',
  '目标读者：需要维护这段代码、但没参与刚才那次修改的开发者。',
  '',
  '讲解要求：',
  '1. 先讲「这段代码解决什么业务问题」，再讲「具体怎么实现的」；用业务语言开头，不要一上来就贴代码。',
  '2. 明确指出关键函数/类/模块之间的调用关系与数据流向，为后面画流程图提供素材。',
  '3. 指出输入输出、边界条件、错误处理，以及这次改动可能引入的风险或需要后续补的地方。',
  '4. 不要臆造代码里不存在的行为；不确定就写进 risks。',
  '5. 全部使用简体中文。代码标识符、文件名保持原文。',
  '',
  '只输出一个 JSON 对象，不要 Markdown 代码围栏，不要任何额外说明。字段如下：',
  '{',
  '  "title": "8-20 字的讲解标题，概括这次改动的业务价值",',
  '  "business": "业务逻辑说明，200-500 字，可用小标题与列表（Markdown）",',
  '  "mermaid": "一段合法的 Mermaid flowchart 源码，展示调用流程或数据流（节点标签可用中文，但用双引号包住）",',
  '  "mindmap": [ { "label": "根主题", "children": [ { "label": "子主题", "children": [ { "label": "细节" } ] } ] } ],',
  '  "keypoints": ["三条以内的关键结论"],',
  '  "risks": ["潜在风险或注意事项，没有就给空数组"],',
  '  "snippets": [ { "file": "相对路径", "symbol": "函数名", "note": "这段代码在做什么", "code": "核心代码片段，不超过 40 行" } ]',
  '}',
  '',
  '硬性约束：',
  '- mermaid 必须是 flowchart 或 graph 开头，只能使用合法语法，不要写 ``` 围栏。',
  '- mindmap 最多 3 层深、总共不超过 20 个节点。',
  '- snippets 最多 3 段；code 必须是改动范围内的真实代码，不要补全或改写。'
].join('\n');

/** 把一次改动打包成模型输入。 */
export function buildUserPrompt(job, labels = {}) {
  const title = labels.title ?? '代码讲解记录';
  const sections = [];
  sections.push(`【任务】讲解下面这些文件本次的改动（${title}）。`);
  sections.push('');
  sections.push('【改动清单】');
  for (const file of job.files) {
    const stats = file.status === 'deleted'
      ? '文件已被删除'
      : `新增 ${file.added} 行 / 删除 ${file.removed} 行`;
    sections.push(`- ${file.path}（${stats}${file.truncated ? '，正文已截断' : ''}）`);
  }
  sections.push('');
  if (job.instruction !== undefined && job.instruction.trim() !== '') {
    sections.push('【本次特别关注】');
    sections.push(job.instruction.trim());
    sections.push('');
  }
  for (const file of job.files) {
    sections.push(`【文件】${file.path}`);
    if (file.diff !== undefined && file.diff.trim() !== '') {
      sections.push(`【本次改动】\n\`\`\`diff\n${file.diff.trim()}\n\`\`\``);
    }
    if (file.status === 'deleted') {
      sections.push('（文件已删除，无正文）');
    } else {
      sections.push(`【改动后的完整内容】\n\`\`\`${file.language}\n${file.content.trim()}\n\`\`\``);
    }
    sections.push('');
  }
  sections.push('请严格按系统提示中的 JSON 结构输出。');
  return sections.join('\n');
}

/** 去掉模型可能包上的 Markdown 围栏。 */
function stripFence(text) {
  const trimmed = String(text ?? '').trim();
  const match = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/u.exec(trimmed);
  return match === null ? trimmed : match[1].trim();
}

/** 从任意文本里找出第一个平衡的 JSON 对象。 */
function extractJsonObject(text) {
  const source = String(text ?? '');
  const start = source.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return undefined;
}

const asStringArray = (value) => (Array.isArray(value)
  ? value.map((item) => (typeof item === 'string' ? item.trim() : String(item ?? '').trim())).filter((item) => item !== '')
  : []);

const normalizeMindNode = (node, depth = 0) => {
  if (depth > 3) return undefined;
  if (typeof node === 'string') {
    const label = node.trim();
    return label === '' ? undefined : { label };
  }
  if (node === null || typeof node !== 'object') return undefined;
  const label = String(node.label ?? node.title ?? node.name ?? '').trim();
  if (label === '') return undefined;
  const children = Array.isArray(node.children)
    ? node.children.map((child) => normalizeMindNode(child, depth + 1)).filter((child) => child !== undefined)
    : undefined;
  return children === undefined || children.length === 0 ? { label } : { label, children };
};

/**
 * 解析模型的输出。永远返回一个可渲染的解释稿；
 * `fallback: true` 表示 JSON 解析失败、退回了纯文本模式。
 */
export function parseExplainer(raw, context = {}) {
  const text = stripFence(raw);
  const jsonText = extractJsonObject(text);
  const fallbackTitle = context.title ?? '代码讲解';
  const base = {
    title: fallbackTitle,
    files: Array.isArray(context.files) ? context.files : [],
    sessionId: context.sessionId,
    generatedAt: context.generatedAt ?? new Date().toISOString(),
    provider: context.provider,
    model: context.model
  };
  if (jsonText === undefined) {
    return {
      ...base,
      business: text,
      mermaid: '',
      mindmap: [],
      keypoints: [],
      risks: [],
      snippets: [],
      fallback: true
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return {
      ...base,
      business: text,
      mermaid: '',
      mindmap: [],
      keypoints: [],
      risks: [],
      snippets: [],
      fallback: true
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ...base,
      business: text,
      mermaid: '',
      mindmap: [],
      keypoints: [],
      risks: [],
      snippets: [],
      fallback: true
    };
  }
  const mind = Array.isArray(parsed.mindmap)
    ? parsed.mindmap.map((node) => normalizeMindNode(node)).filter((node) => node !== undefined)
    : (parsed.mindmap !== null && typeof parsed.mindmap === 'object'
      ? [normalizeMindNode(parsed.mindmap)].filter((node) => node !== undefined)
      : []);
  const snippetOf = (item) => {
    if (item === null || typeof item !== 'object') return undefined;
    const code = typeof item.code === 'string' ? item.code : '';
    if (code.trim() === '') return undefined;
    return {
      file: typeof item.file === 'string' ? item.file : undefined,
      symbol: typeof item.symbol === 'string' ? item.symbol : undefined,
      note: typeof item.note === 'string' ? item.note : undefined,
      code
    };
  };
  return {
    ...base,
    title: (typeof parsed.title === 'string' && parsed.title.trim() !== '' ? parsed.title.trim() : fallbackTitle).slice(0, 120),
    business: typeof parsed.business === 'string' ? parsed.business.trim() : '',
    mermaid: typeof parsed.mermaid === 'string' ? parsed.mermaid : '',
    mindmap: mind,
    keypoints: asStringArray(parsed.keypoints),
    risks: asStringArray(parsed.risks),
    snippets: (Array.isArray(parsed.snippets) ? parsed.snippets.map(snippetOf).filter((item) => item !== undefined) : []).slice(0, 3),
    fallback: false
  };
}
