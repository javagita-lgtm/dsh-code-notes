/**
 * Obsidian 序列化层：把解释稿（explainer）转成 Obsidian 能直接吃下的文件。
 *
 * - Markdown 笔记：frontmatter + 业务逻辑 + Mermaid 流程图 + Markmap
 *   思维图（包在 ` ```markmap ` 块里，Obsidian 装了 Markmap 插件即可渲染）
 * - `.canvas` 画布：Obsidian 原生 Canvas JSON（1.0 结构：nodes + edges）
 * - `_index.md`：一个库索引，所有讲解笔记都双链到这里
 *
 * 这些函数是纯函数（只做字符串处理），便于脱离 Host 单测。
 */

/** 推断文件在 Mermaid / Canvas 上使用的语言标签。 */
export function languageOf(path) {
  const match = /\.([a-z0-9]+)$/iu.exec(path ?? '');
  return match === null ? 'text' : match[1].toLowerCase();
}

/** 把任意文本安全地嵌入围栏代码块（自动加长围栏，避免内容里出现 ``` 截断）。 */
export function fence(text, info = '') {
  const body = typeof text === 'string' ? text : '';
  const longest = (body.match(/`{3,}/gu) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}${info}\n${body.replace(/\s+$/u, '')}\n${ticks}`;
}

/** 把文本转成可以放进 YAML 标量的一行（保留中文，去掉换行与引号风险）。 */
export function yamlScalar(value) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  if (text === '') return '""';
  if (/^[\w./@+-]+$/u.test(text)) return text;
  return `"${text.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
}

/** YAML 列表项，值为空时返回空数组字面量。 */
export function yamlList(values) {
  const items = (values ?? []).filter((value) => typeof value === 'string' && value.trim() !== '');
  if (items.length === 0) return '[]';
  return `\n${items.map((item) => `  - ${yamlScalar(item)}`).join('\n')}`;
}

/**
 * 从解释稿里拆出一个能独立渲染的 Mermaid 图。
 * 模型偶尔会带回 ```mermaid 围栏或 `graph` 之外的说明文字，这里统一清洗。
 */
export function cleanMermaid(source, fallbackTitle) {
  let text = String(source ?? '').trim();
  if (text === '') return '';
  const fenced = /```(?:mermaid)?\s*\n([\s\S]*?)```/u.exec(text);
  if (fenced !== null) text = fenced[1].trim();
  if (!/^(graph|flowchart|sequenceDiagram|stateDiagram|stateDiagram-v2|classDiagram|erDiagram|journey|gantt|mindmap)\b/mu.test(text)) {
    const lines = ['flowchart TD', `  n0["${String(fallbackTitle ?? '流程').replace(/"/gu, "'")}"]`];
    const steps = text.split(/\n+/u).map((line) => line.replace(/^[-*\d.\s]+/u, '').trim()).filter((line) => line !== '');
    steps.slice(0, 8).forEach((step, index) => {
      lines.push(`  n${index + 1}["${step.replace(/"/gu, "'")}"]`);
      lines.push(`  n${index} --> n${index + 1}`);
    });
    return lines.join('\n');
  }
  return text;
}

/**
 * 生成 Markmap 思维导图源码（Markdown 层级），根节点是本次讲解主题。
 * 模型给出的树状结构会被归一化成纯 Markdown 标题层级。
 */
export function buildMarkmap(explainer) {
  const root = String(explainer?.title ?? '代码讲解').replace(/\s+/gu, ' ').trim() || '代码讲解';
  const stems = Array.isArray(explainer?.mindmap) ? explainer.mindmap : [];
  const lines = [`# ${root}`];
  const walk = (nodes, depth) => {
    for (const node of nodes) {
      const label = typeof node === 'string' ? node : String(node?.label ?? '').trim();
      if (label === '') continue;
      lines.push(`${'  '.repeat(Math.max(0, depth - 1))}- ${label.replace(/\s+/gu, ' ')}`);
      if (typeof node === 'object' && Array.isArray(node?.children)) walk(node.children, depth + 1);
    }
  };
  walk(stems, 1);
  if (lines.length === 1) {
    lines.push('- 业务逻辑', '- 调用流程', '- 关键数据流');
  }
  return lines.join('\n');
}

/** 生成 Obsidian 笔记的完整 Markdown。 */
export function renderMarkdown(explainer, options = {}) {
  const files = Array.isArray(explainer?.files) ? explainer.files : [];
  const title = String(explainer?.title ?? '代码讲解').trim() || '代码讲解';
  const generatedAt = String(explainer?.generatedAt ?? new Date().toISOString());
  const links = options.linkNotes === false ? false : true;
  const link = (target) => (links && target !== undefined && target !== '' ? `[[${target}]]` : null);
  const out = [];

  out.push('---');
  out.push(`title: ${yamlScalar(title)}`);
  out.push('tags:');
  out.push('  - 代码讲解');
  out.push('  - ai-generated');
  out.push('files:'.concat(yamlList(files)));
  out.push(`generated: ${yamlScalar(generatedAt)}`);
  out.push(`session: ${yamlScalar(explainer?.sessionId ?? '')}`);
  out.push(`source: dsh-code-notes`);
  out.push('---');
  out.push('');
  out.push(`# ${title}`);
  out.push('');
  out.push(`> 由 AI 在编码过程中自动生成 · ${generatedAt.replace('T', ' ').replace(/\..+$/u, '')}`);
  out.push('');

  if (files.length > 0) {
    out.push('## 涉及文件');
    out.push('');
    out.push(files.map((file) => `- ${link(String(file)) ?? `\`${file}\``}`).join('\n'));
    out.push('');
  }

  const business = String(explainer?.business ?? '').trim();
  out.push('## 业务逻辑');
  out.push('');
  out.push(business === '' ? '_（模型未给出业务逻辑说明）_' : business);
  out.push('');

  const flow = cleanMermaid(explainer?.mermaid, title);
  if (flow !== '') {
    out.push('## 调用流程');
    out.push('');
    out.push(fence(flow, 'mermaid'));
    out.push('');
  }

  const markmap = buildMarkmap(explainer);
  out.push('## 思维导图（Markmap）');
  out.push('');
  out.push('> Obsidian 安装 Markmap 插件后，下面的代码块会渲染成可折叠的思维树；未安装时它就是纯文本大纲。');
  out.push('');
  out.push(fence(markmap, 'markmap'));
  out.push('');

  const keypoints = Array.isArray(explainer?.keypoints) ? explainer.keypoints : [];
  if (keypoints.length > 0) {
    out.push('## 要点');
    out.push('');
    out.push(keypoints.map((point) => `- ${String(point)}`).join('\n'));
    out.push('');
  }

  const risks = Array.isArray(explainer?.risks) ? explainer.risks : [];
  if (risks.length > 0) {
    out.push('## 注意 / 风险');
    out.push('');
    out.push(risks.map((risk) => `- ${String(risk)}`).join('\n'));
    out.push('');
  }

  const snippets = Array.isArray(explainer?.snippets) ? explainer.snippets : [];
  const useful = snippets.filter((item) => item !== null && typeof item === 'object' && typeof item.code === 'string' && item.code.trim() !== '');
  if (useful.length > 0) {
    out.push('## 原文对照');
    out.push('');
    for (const snippet of useful) {
      const where = [snippet.file, snippet.symbol].filter((part) => typeof part === 'string' && part !== '').join(' · ');
      out.push(`### ${where === '' ? '代码片段' : where}`);
      out.push('');
      if (typeof snippet.note === 'string' && snippet.note.trim() !== '') {
        out.push(snippet.note.trim());
        out.push('');
      }
      out.push(fence(snippet.code, languageOf(snippet.file)));
      out.push('');
    }
  }

  out.push('---');
  out.push('');
  out.push('_由 dsh-code-notes 自动生成，可手工修改；重新讲解会覆盖同名笔记。_');
  return `${out.join('\n')}\n`;
}

/** 把纯文本按固定宽度切成多行（Canvas 文本节点不会自动换行）。 */
export function wrapText(text, width) {
  const limit = Math.max(8, Number(width) || 46);
  const result = [];
  for (const rawLine of String(text ?? '').split('\n')) {
    if (rawLine.length <= limit) {
      result.push(rawLine);
      continue;
    }
    let line = '';
    for (const char of rawLine) {
      if (line.length >= limit) {
        result.push(line);
        line = '';
      }
      line += char;
    }
    if (line !== '') result.push(line);
  }
  return result.join('\n');
}

/**
 * 生成 Obsidian Canvas（.canvas）JSON。
 * 结构：中央讲解卡 → 文件区 → 流程图区 → 思维图区；边用 fromSide/toSide 定位。
 */
export function buildCanvas(explainer) {
  const title = String(explainer?.title ?? '代码讲解').trim() || '代码讲解';
  const files = Array.isArray(explainer?.files) ? explainer.files : [];
  const business = String(explainer?.business ?? '').trim();
  const nodes = [];
  const edges = [];
  const push = (node) => {
    nodes.push(node);
    return node.id;
  };

  const rootId = push({
    id: 'note-root',
    type: 'text',
    text: `# ${title}\n\n${wrapText(business || '业务逻辑讲解', 40)}`,
    x: 0,
    y: 0,
    width: 480,
    height: 420,
    color: '5'
  });

  files.slice(0, 8).forEach((file, index) => {
    const id = `note-file-${index}`;
    push({
      id,
      type: 'file',
      file: String(file),
      x: -560,
      y: index * 260,
      width: 460,
      height: 220
    });
    edges.push({ id: `edge-file-${index}`, fromNode: id, fromSide: 'right', toNode: rootId, toSide: 'left', label: '涉及文件' });
  });

  const flow = cleanMermaid(explainer?.mermaid, title);
  if (flow !== '') {
    const flowId = push({
      id: 'note-flow',
      type: 'text',
      text: wrapText(`## 调用流程\n\n${flow}`, 60),
      x: 600,
      y: 0,
      width: 560,
      height: 420,
      color: '4'
    });
    edges.push({ id: 'edge-flow', fromNode: rootId, fromSide: 'right', toNode: flowId, toSide: 'left', label: '流程' });
  }

  const markmap = buildMarkmap(explainer);
  const mindId = push({
    id: 'note-mind',
    type: 'text',
    text: wrapText(`## 思维导图\n\n${markmap}`, 60),
    x: 600,
    y: 480,
    width: 560,
    height: 420,
    color: '6'
  });
  edges.push({ id: 'edge-mind', fromNode: rootId, fromSide: 'bottom', toNode: mindId, toSide: 'left', label: '思维结构' });

  return { nodes, edges };
}

/** 生成索引笔记内容（每个讲解笔记一行双链）。 */
export function renderIndex(entries, folder) {
  const out = [
    '---',
    'tags:',
    '  - 代码讲解',
    '  - index',
    '---',
    '',
    '# 代码讲解索引',
    '',
    `_目录：\`${folder}\` · 由 dsh-code-notes 自动维护_`,
    ''
  ];
  const sorted = [...(entries ?? [])].sort((a, b) => String(b?.generatedAt ?? '').localeCompare(String(a?.generatedAt ?? '')));
  if (sorted.length === 0) {
    out.push('_暂无笔记_');
  } else {
    for (const entry of sorted) {
      const files = Array.isArray(entry?.files) ? entry.files.join('、') : '';
      out.push(`- ${entry?.generatedAt?.replace?.('T', ' ')?.replace?.(/\..+$/u, '') ?? ''} [[${entry?.noteName}]] ${files === '' ? '' : `· ${files}`}`.replace(/\s+$/u, ''));
    }
  }
  out.push('');
  return out.join('\n');
}

/** 由标题生成稳定、可作双链目标、且不含非法文件名字符的笔记名。 */
export function noteNameOf(title, stamp) {
  const safe = String(title ?? '代码讲解')
    .replace(/[\\/:*?"<>|#^[\]]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 60) || '代码讲解';
  return `${stamp}-${safe}`;
}
