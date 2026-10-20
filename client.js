/**
 * 浏览器半区：聊天页输入框旁的「讲解」入口 + 展开后的侧边讲解面板。
 *
 * 渲染位置：`conversation.composer.dock`（输入框下方、会话内插槽）。
 * 面板用内联展开而不是新建主面板，这样它天然贴着当前会话，也能拿到 sessionId。
 *
 * 数据：全部走包装好的 `/api/dsh-code-notes/*` 本机路由；
 * 生成的讲解同时被 Host 写成 Obsidian 笔记，这里只负责预览、复制、跳转与重讲。
 */

window.__ModuleLoader__.load({
  id: 'dsh-code-notes',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useMemo, useRef } = React;

    const API = '/api/dsh-code-notes';
    const NS = 'dsh-code-notes';

    /* ===== 内联设置表单（与主面板同文件，避免客户端模块多文件加载问题） ===== */
    function Field({ label, hint, children }) {
      return h('label', { className: 'cn-field' },
        h('span', { className: 'cn-field-label' }, label),
        children,
        hint !== undefined && hint !== '' ? h('span', { className: 'cn-field-hint' }, hint) : null);
    }

    function SettingsForm({ config, busy, onSave }) {
      const [vaultPath, setVaultPath] = useState(config.vaultPath ?? '');
      const [folder, setFolder] = useState(config.folder ?? 'CodeNotes');
      const [mode, setMode] = useState(config.mode ?? 'auto');
      const [provider, setProvider] = useState(config.provider ?? '');
      const [model, setModel] = useState(config.model ?? '');
      const [writeCanvas, setWriteCanvas] = useState(config.writeCanvas !== false);
      const [linkNotes, setLinkNotes] = useState(config.linkNotes !== false);

      useEffect(() => {
        setVaultPath(config.vaultPath ?? '');
        setFolder(config.folder ?? 'CodeNotes');
        setMode(config.mode ?? 'auto');
        setProvider(config.provider ?? '');
        setModel(config.model ?? '');
        setWriteCanvas(config.writeCanvas !== false);
        setLinkNotes(config.linkNotes !== false);
      }, [config]);

      const submit = (event) => {
        event.preventDefault();
        void onSave({
          vaultPath: vaultPath.trim(),
          folder: folder.trim() === '' ? 'CodeNotes' : folder.trim(),
          mode,
          provider: provider.trim(),
          model: model.trim(),
          writeCanvas,
          linkNotes
        });
      };

      return h('form', { className: 'cn-form cn-scroll', onSubmit: submit },
        h(Field, { label: 'Obsidian 库目录', hint: '选中含 .obsidian 文件夹的那个目录，例如 D:/Notes/MyVault' },
          h('input', {
            className: 'cn-input',
            value: vaultPath,
            placeholder: 'D:/Notes/MyVault',
            spellCheck: false,
            onChange: (event) => setVaultPath(event.target.value)
          })),
        h(Field, { label: '写入子目录', hint: '笔记、画布与 _index.md 都写在这个子目录里' },
          h('input', { className: 'cn-input', value: folder, spellCheck: false, onChange: (event) => setFolder(event.target.value) })),
        h(Field, { label: '触发方式' },
          h('div', { className: 'cn-row' },
            h('button', { type: 'button', className: 'cn-tab', 'data-active': mode === 'auto' ? '' : undefined, onClick: () => setMode('auto') }, '自动（改完代码就讲解）'),
            h('button', { type: 'button', className: 'cn-tab', 'data-active': mode === 'manual' ? '' : undefined, onClick: () => setMode('manual') }, '手动（/讲解 或按钮）'))),
        h(Field, { label: '讲解模型（可选）', hint: '留空则跟随当前会话模型；想省钱可以填便宜的 provider/model' },
          h('div', { className: 'cn-row' },
            h('input', { className: 'cn-input', value: provider, placeholder: 'provider，如 workbuddy', spellCheck: false, onChange: (event) => setProvider(event.target.value) }),
            h('input', { className: 'cn-input', value: model, placeholder: 'model，如 deepseek-v4.1-flash', spellCheck: false, onChange: (event) => setModel(event.target.value) }))),
        h('div', { className: 'cn-row cn-row-tight' },
          h('label', { className: 'cn-check' },
            h('input', { type: 'checkbox', checked: writeCanvas, onChange: (event) => setWriteCanvas(event.target.checked) }),
            h('span', null, '生成 .canvas 画布')),
          h('label', { className: 'cn-check' },
            h('input', { type: 'checkbox', checked: linkNotes, onChange: (event) => setLinkNotes(event.target.checked) }),
            h('span', null, '写入 [[双链]]'))),
        h('div', { className: 'cn-row' },
          h('button', { type: 'submit', className: 'cn-btn cn-btn-primary', disabled: busy }, busy ? '保存中…' : '保存设置'),
          h('span', { className: 'cn-field-hint' }, '保存后写回 profile 的 cordis.patch.yml，重启不丢失')));
    }

    /** 极简 Markdown 渲染：标题 / 列表 / 围栏代码 / 行内代码 / 粗体 / 链接。 */
    function renderInline(text) {
      const nodes = [];
      const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/gu;
      let last = 0;
      let match;
      let key = 0;
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > last) nodes.push(text.slice(last, match.index));
        const token = match[0];
        if (token.startsWith('`')) {
          nodes.push(h('code', { key: `c${key++}`, className: 'cn-inline-code' }, token.slice(1, -1)));
        } else if (token.startsWith('**')) {
          nodes.push(h('strong', { key: `b${key++}` }, token.slice(2, -2)));
        } else {
          const link = /\[([^\]]+)\]\(([^)]+)\)/u.exec(token);
          nodes.push(h('a', { key: `a${key++}`, href: link?.[2], target: '_blank', rel: 'noreferrer' }, link?.[1] ?? token));
        }
        last = match.index + token.length;
      }
      if (last < text.length) nodes.push(text.slice(last));
      return nodes;
    }

    function Markdown({ text }) {
      const blocks = useMemo(() => {
        const lines = String(text ?? '').split('\n');
        const out = [];
        let buffer = [];
        let fence = null;
        const flush = () => {
          if (buffer.length === 0) return;
          out.push({ kind: 'p', text: buffer.join(' ') });
          buffer = [];
        };
        for (const line of lines) {
          const fenceMatch = /^```(\w*)\s*$/u.exec(line.trim());
          if (fence !== null) {
            if (fenceMatch !== null) {
              out.push({ kind: 'code', lang: fence.lang, text: fence.lines.join('\n') });
              fence = null;
            } else {
              fence.lines.push(line);
            }
            continue;
          }
          if (fenceMatch !== null) {
            flush();
            fence = { lang: fenceMatch[1], lines: [] };
            continue;
          }
          const heading = /^(#{1,4})\s+(.*)$/u.exec(line);
          if (heading !== null) {
            flush();
            out.push({ kind: 'h', level: heading[1].length, text: heading[2] });
            continue;
          }
          const item = /^\s*([-*]|\d+\.)\s+(.*)$/u.exec(line);
          if (item !== null) {
            flush();
            const last = out[out.length - 1];
            if (last?.kind === 'ul') last.items.push(item[2]);
            else out.push({ kind: 'ul', items: [item[2]] });
            continue;
          }
          if (line.trim() === '') {
            flush();
            continue;
          }
          buffer.push(line.trim());
        }
        flush();
        if (fence !== null) out.push({ kind: 'code', lang: fence.lang, text: fence.lines.join('\n') });
        return out;
      }, [text]);
      return h('div', { className: 'cn-md' }, blocks.map((block, index) => {
        if (block.kind === 'h') {
          const Tag = block.level <= 2 ? 'h3' : 'h4';
          return h(Tag, { key: index }, renderInline(block.text));
        }
        if (block.kind === 'ul') {
          return h('ul', { key: index }, block.items.map((item, itemIndex) => h('li', { key: itemIndex }, renderInline(item))));
        }
        if (block.kind === 'code') {
          return h('pre', { key: index, className: 'cn-code' }, h('code', null, block.text));
        }
        return h('p', { key: index }, renderInline(block.text));
      }));
    }

    const STYLE_ID = 'dsh-code-notes-style';
    const CSS = `
      .cn-root { display: flex; flex-direction: column; width: 100%; }
      .cn-trigger { align-self: flex-end; display: inline-flex; align-items: center; gap: 6px;
        border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
        color: var(--dsw-alias-label-secondary); border-radius: 999px; padding: 3px 10px;
        font-size: 12px; line-height: 18px; cursor: pointer; transition: color .15s, border-color .15s; }
      .cn-trigger:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
      .cn-trigger[data-active] { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
      .cn-badge { min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; font-size: 11px;
        display: inline-flex; align-items: center; justify-content: center;
        background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); }
      .cn-panel { margin-top: 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px;
        background: var(--dsw-alias-bg-layer-1); max-height: 46vh; display: flex; flex-direction: column; overflow: hidden; }
      .cn-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px;
        border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); }
      .cn-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
      .cn-sub { font-size: 11px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .cn-grow { flex: 1 1 auto; min-width: 0; }
      .cn-btn { border: 1px solid var(--dsw-alias-border-l1); background: transparent; border-radius: 8px;
        color: var(--dsw-alias-label-secondary); font-size: 12px; padding: 3px 8px; cursor: pointer; white-space: nowrap; }
      .cn-btn:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
      .cn-btn:disabled { opacity: .5; cursor: default; }
      .cn-body { display: flex; min-height: 0; flex: 1 1 auto; }
      .cn-list { width: 196px; flex: none; border-right: 1px solid var(--dsw-alias-border-l1); overflow: auto; }
      .cn-list-item { width: 100%; text-align: left; border: 0; background: transparent; cursor: pointer;
        padding: 8px 10px; display: flex; flex-direction: column; gap: 2px; border-bottom: 1px solid var(--dsw-alias-border-l1); }
      .cn-list-item[data-active] { background: var(--dsw-alias-bg-layer-2); }
      .cn-list-title { font-size: 12px; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .cn-list-meta { font-size: 11px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .cn-detail { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
      .cn-detail-head { display: flex; gap: 6px; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1); flex-wrap: wrap; }
      .cn-scroll { overflow: auto; padding: 10px 14px; }
      .cn-md { font-size: 13px; line-height: 1.65; color: var(--dsw-alias-label-primary); }
      .cn-md h3, .cn-md h4 { margin: 10px 0 6px; font-size: 13px; }
      .cn-md p { margin: 6px 0; }
      .cn-md ul { margin: 6px 0 6px 18px; padding: 0; }
      .cn-inline-code { background: var(--dsw-alias-bg-layer-2); border-radius: 4px; padding: 0 4px; font-size: 12px; }
      .cn-code { background: var(--dsw-alias-bg-layer-2); border-radius: 8px; padding: 8px 10px; overflow: auto;
        font-size: 12px; line-height: 1.5; margin: 6px 0; }
      .cn-chips { display: flex; flex-wrap: wrap; gap: 4px; margin: 6px 0 2px; }
      .cn-chip { font-size: 11px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; padding: 0 8px;
        color: var(--dsw-alias-label-secondary); }
      .cn-empty { padding: 18px 14px; font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.7; }
      .cn-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; padding: 6px 10px; }
      .cn-tabs { display: flex; gap: 4px; margin: 0 0 8px; }
      .cn-tab { border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 12px;
        padding: 3px 8px; border-radius: 6px; cursor: pointer; }
      .cn-tab[data-active] { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
      .cn-pending { padding: 4px 12px 8px; font-size: 11px; color: var(--dsw-alias-state-warn-primary); }
      .cn-form { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px 14px; }
      .cn-field { display: flex; flex-direction: column; gap: 4px; }
      .cn-field-label { font-size: 12px; color: var(--dsw-alias-label-primary); }
      .cn-field-hint { font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .cn-row { display: flex; gap: 6px; align-items: center; }
      .cn-row-tight { align-items: center; }
      .cn-input { flex: 1 1 auto; min-width: 0; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
        background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
        font-size: 12px; padding: 5px 8px; outline: none; }
      .cn-input:focus { border-color: var(--dsw-alias-brand-primary); }
      .cn-check { display: inline-flex; align-items: center; gap: 6px; font-size: 12px;
        color: var(--dsw-alias-label-secondary); cursor: pointer; }
      .cn-btn-primary { background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base);
        border-color: var(--dsw-alias-brand-primary); }
      .cn-btn-primary:hover { color: var(--dsw-alias-bg-base); filter: brightness(1.05); }
    `;

    function insertStyle() {
      if (typeof document === 'undefined') return () => {};
      // 旧样式表（来自上一版客户端模块的 HMR 残留）先移除，避免两套规则叠加。
      document.getElementById(STYLE_ID)?.remove();
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
      return () => {
        style.remove();
      };
    }

    async function callApi(path, body) {
      const response = await fetch(`${API}${path}`, body === undefined
        ? { method: 'GET' }
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
          });
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error(`接口返回了非 JSON 内容（HTTP ${response.status}）`);
      }
      if (payload === null || typeof payload !== 'object') throw new Error('接口返回格式异常');
      if (payload.ok !== true && response.status >= 400) {
        throw new Error(payload.error ?? `请求失败（HTTP ${response.status}）`);
      }
      return payload;
    }

    const formatTime = (iso) => {
      if (typeof iso !== 'string') return '';
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return iso;
      const pad = (value) => String(value).padStart(2, '0');
      return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    };

    /**
     * 开发诊断：把最近一次状态快照挂到触发按钮的 data 属性上，
     * 出问题时可以在 DevTools 里直接看「接口有没有回、配置读到没有」。
     * 不影响正常渲染，也不含敏感信息。
     */
    function appendDevDiagnostics(element, state) {
      const info = {
        sessionId: state.sessionId ?? null,
        hasConfig: state.config !== undefined,
        alive: state.config?.alive === true,
        version: state.config?.version ?? null,
        vault: state.config?.vaultPath ?? null,
        notes: Array.isArray(state.notes) ? state.notes.length : 0,
        pending: Array.isArray(state.changes) ? state.changes.length : 0
      };
      if (element !== null && typeof element === 'object' && element.props !== undefined) {
        element.props['data-cn-diag'] = JSON.stringify(info);
      }
    }

    function ExplainerPanel({ sessionId, labels }) {
      const t = (key, fallback) => (typeof labels === 'function' ? labels(key) : undefined) ?? fallback;
      const [open, setOpen] = useState(false);
      const [notes, setNotes] = useState([]);
      const [changes, setChanges] = useState([]);
      const [config, setConfig] = useState(undefined);
      const [activeId, setActiveId] = useState(undefined);
      const [tab, setTab] = useState('business');
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState(undefined);
      const [notice, setNotice] = useState(undefined);
      const [showSettings, setShowSettings] = useState(false);
      const pollRef = useRef(0);

      const refresh = useCallback(async () => {
        if (typeof sessionId !== 'string' || sessionId === '') return;
        try {
          const payload = await callApi(`/history?sessionId=${encodeURIComponent(sessionId)}`);
          const entries = Array.isArray(payload.entries) ? payload.entries : [];
          setNotes(entries);
          setConfig(payload.config);
          setActiveId((current) => (entries.some((entry) => entry.id === current) ? current : entries[0]?.id));
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        }
      }, [sessionId]);

      useEffect(() => {
        void refresh();
      }, [refresh]);

      // 打开面板时轮询一次，用于在没有推送通道时感知新生成的讲解（vault 修改后自动刷新配置）
      useEffect(() => {
        if (!open) return undefined;
        const timer = window.setInterval(() => {
          pollRef.current += 1;
          void refresh();
        }, 6000);
        return () => window.clearInterval(timer);
      }, [open, refresh]);

      const saveSetting = async (patch) => {
        setBusy(true);
        setError(undefined);
        setNotice(undefined);
        try {
          const payload = await callApi('/settings', { config: patch });
          setConfig(payload.config);
          if (payload.persisted === false) {
            setNotice('设置已生效，但未能写回 cordis.patch.yml，重启后会恢复默认值');
          } else {
            setNotice('设置已保存');
          }
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
          setBusy(false);
        }
      };

      const generate = async () => {
        if (busy) return;
        setBusy(true);
        setError(undefined);
        setNotice(undefined);
        try {
          const payload = await callApi('/explain', { sessionId });
          if (payload.ok !== true) throw new Error(payload.error ?? t('panel.failed', '讲解失败'));
          setNotes((current) => [payload.note, ...current.filter((entry) => entry.id !== payload.note.id)]);
          setActiveId(payload.note.id);
          setNotice(payload.written?.ok === true ? t('panel.written', '已写入') : (payload.written?.error ?? ''));
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
          setBusy(false);
          void refresh();
        }
      };

      const writeToVault = async () => {
        if (activeId === undefined) return;
        setBusy(true);
        setError(undefined);
        try {
          const payload = await callApi('/write', { sessionId, noteId: activeId });
          if (payload.ok !== true) throw new Error(payload.error ?? '写入失败');
          setNotice(t('panel.written', '已写入'));
          await refresh();
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
          setBusy(false);
        }
      };

      const openVault = async () => {
        try {
          const payload = await callApi('/open', { sessionId, noteId: activeId });
          if (payload.ok !== true) throw new Error(payload.error ?? '打开失败');
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        }
      };

      const copyMarkdown = async () => {
        const active = notes.find((entry) => entry.id === activeId);
        if (active?.markdown !== undefined) {
          try {
            await navigator.clipboard.writeText(active.markdown);
            setNotice(t('panel.copied', '已复制'));
            return;
          } catch {
            // 退回到服务端渲染的笔记
          }
        }
        try {
          const response = await fetch(`${API}/history?sessionId=${encodeURIComponent(sessionId)}`);
          const payload = await response.json();
          const note = (payload.entries ?? []).find((entry) => entry.id === activeId);
          const markdown = note?.markdown ?? (note?.explainer ? renderFallbackMarkdown(note.explainer) : '');
          await navigator.clipboard.writeText(markdown);
          setNotice(t('panel.copied', '已复制'));
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        }
      };

      const active = notes.find((entry) => entry.id === activeId);
      const explainer = active?.explainer;
      const pending = changes.length;

      const trigger = h('button', {
        type: 'button',
        className: 'cn-trigger',
        'data-active': open ? '' : undefined,
        onClick: () => {
          setOpen((value) => !value);
        },
        title: open ? t('panel.close', '收起讲解') : t('panel.open', '讲解')
      },
        h('span', { 'aria-hidden': 'true' }, '✦'),
        h('span', null, open ? t('panel.close', '收起讲解') : t('panel.open', '讲解')),
        pending > 0 ? h('span', { className: 'cn-badge' }, String(pending)) : null);

      appendDevDiagnostics(trigger, { sessionId, config, notes, changes });

      if (!open) return h('div', { className: 'cn-root' }, trigger);

      // 首次使用（尚未填 Obsidian 库目录，或手动点开设置）时展示设置表单
      if (config !== undefined && ((config.vaultPath ?? '') === '' || showSettings)) {
        return h('div', { className: 'cn-root' },
          trigger,
          h('section', { className: 'cn-panel', 'aria-label': t('panel.settings', '设置') },
            h('header', { className: 'cn-head' },
              h('div', { className: 'cn-grow' },
                h('div', { className: 'cn-title' }, t('panel.settings', '设置')),
                h('div', { className: 'cn-sub' }, '填写 Obsidian 库目录后即可自动生成讲解笔记')),
              showSettings && (config.vaultPath ?? '') !== ''
                ? h('button', { type: 'button', className: 'cn-btn', onClick: () => setShowSettings(false) }, '返回讲解')
                : null),
            error !== undefined ? h('div', { className: 'cn-error' }, error) : null,
            notice !== undefined && notice !== '' ? h('div', { className: 'cn-pending' }, notice) : null,
            h(SettingsForm, {
              config,
              busy,
              onSave: async (patch) => {
                await saveSetting(patch);
                setShowSettings(false);
              }
            })));
      }

      return h('div', { className: 'cn-root' },
        trigger,
        h('section', { className: 'cn-panel', 'aria-label': t('panel.title', '代码讲解') },
          h('header', { className: 'cn-head' },
            h('div', { className: 'cn-grow' },
              h('div', { className: 'cn-title' }, t('panel.title', '代码讲解')),
              h('div', { className: 'cn-sub' },
                config?.vaultResolved === undefined
                  ? t('panel.configMissing', '未配置 Obsidian 库目录')
                  : `${config.vaultResolved} / ${config.folder}`)),
            h('button', { type: 'button', className: 'cn-btn', onClick: generate, disabled: busy || pending === 0,
              title: pending === 0 ? t('panel.noChanges', '当前会话还没有捕获到代码改动。') : t('panel.generate', '重新讲解') },
              busy ? t('panel.loading', '讲解生成中…') : t('panel.generateAll', '讲解当前会话改动')),
            h('button', { type: 'button', className: 'cn-btn', onClick: writeToVault, disabled: active === undefined || busy }, t('panel.write', '写入 Obsidian')),
            h('button', { type: 'button', className: 'cn-btn', onClick: openVault }, t('panel.openVault', '在 Obsidian 中打开')),
            h('button', { type: 'button', className: 'cn-btn', onClick: () => setShowSettings(true) }, t('panel.settings', '设置'))),
          error !== undefined ? h('div', { className: 'cn-error' }, error) : null,
          notice !== undefined && notice !== '' ? h('div', { className: 'cn-pending' }, notice) : null,
          pending > 0 ? h('div', { className: 'cn-pending' }, `待讲解：${changes.map((change) => change.path).join('、')}`) : null,
          notes.length === 0
            ? h('div', { className: 'cn-empty' },
                t('panel.empty', '还没有讲解记录。让 AI 改一次代码，或在输入框发送 /讲解 <文件或范围>。'))
            : h('div', { className: 'cn-body' },
                h('div', { className: 'cn-list', role: 'list' },
                  notes.map((entry) => h('button', {
                    key: entry.id,
                    type: 'button',
                    role: 'listitem',
                    className: 'cn-list-item',
                    'data-active': entry.id === activeId ? '' : undefined,
                    onClick: () => setActiveId(entry.id)
                  },
                    h('span', { className: 'cn-list-title' }, entry.title ?? t('note.title', '代码讲解记录')),
                    h('span', { className: 'cn-list-meta' }, `${formatTime(entry.generatedAt)} · ${(entry.files ?? []).length} 个文件`)))),
                h('div', { className: 'cn-detail' },
                  h('div', { className: 'cn-detail-head' },
                    h('div', { className: 'cn-tabs' },
                      h('button', { type: 'button', className: 'cn-tab', 'data-active': tab === 'business' ? '' : undefined, onClick: () => setTab('business') }, t('note.business', '业务逻辑')),
                      h('button', { type: 'button', className: 'cn-tab', 'data-active': tab === 'flow' ? '' : undefined, onClick: () => setTab('flow') }, t('note.flow', '调用流程')),
                      h('button', { type: 'button', className: 'cn-tab', 'data-active': tab === 'mind' ? '' : undefined, onClick: () => setTab('mind') }, t('note.mind', '思维导图')),
                      h('button', { type: 'button', className: 'cn-tab', 'data-active': tab === 'diff' ? '' : undefined, onClick: () => setTab('diff') }, t('note.diff', '改动'))),
                    h('div', { className: 'cn-grow' }),
                    h('button', { type: 'button', className: 'cn-btn', onClick: copyMarkdown }, t('panel.copyMarkdown', '复制 Markdown'))),
                  h('div', { className: 'cn-scroll' },
                    explainer === undefined
                      ? h('div', { className: 'cn-empty' }, t('panel.loading', '讲解生成中…'))
                      : tab === 'business'
                        ? h(Markdown, { text: explainer.business ?? '' })
                        : tab === 'flow'
                          ? h('pre', { className: 'cn-code' }, h('code', null, explainer.mermaid ?? ''))
                          : tab === 'mind'
                            ? h(Markdown, { text: mindToOutline(explainer.mindmap) })
                            : h('div', null,
                                (active?.explainer?.diffs ?? []).map((diff, index) => h('div', { key: index },
                                  h('div', { className: 'cn-chips' },
                                    h('span', { className: 'cn-chip' }, diff.path),
                                    h('span', { className: 'cn-chip' }, `+${diff.added} / -${diff.removed}`)),
                                  h('pre', { className: 'cn-code' }, h('code', null, diff.diff ?? ''))))),
                    explainer !== undefined && Array.isArray(explainer.risks) && explainer.risks.length > 0
                      ? h('div', { className: 'cn-chips', style: { padding: '0 14px 10px' } },
                          explainer.risks.map((risk, index) => h('span', { key: index, className: 'cn-chip' }, `⚠ ${risk}`)))
                      : null
                  )))));
    }

    function mindToOutline(nodes) {
      const lines = [];
      const walk = (items, depth) => {
        for (const node of items ?? []) {
          const label = typeof node === 'string' ? node : node?.label;
          if (typeof label !== 'string' || label === '') continue;
          lines.push(`${'  '.repeat(depth)}- ${label}`);
          if (typeof node === 'object' && Array.isArray(node.children)) walk(node.children, depth + 1);
        }
      };
      walk(nodes, 0);
      return lines.length === 0 ? '_（模型未给出思维结构）_' : lines.join('\n');
    }

    function renderFallbackMarkdown(explainer) {
      const lines = [`# ${explainer.title ?? '代码讲解'}`, '', explainer.business ?? ''];
      if (typeof explainer.mermaid === 'string' && explainer.mermaid !== '') {
        lines.push('', '## 调用流程', '', '```mermaid', explainer.mermaid, '```');
      }
      lines.push('', '## 思维导图', '', mindToOutline(explainer.mindmap));
      return lines.join('\n');
    }

    return {
      inject: ['slots', 'locale', 'connection'],
      apply(ctx) {
        const dictionary = globalThis.__DSH_CODE_NOTES_I18N__ ?? {};
        const locale = ctx.get('locale');
        if (locale !== undefined && typeof locale.register === 'function') {
          const zh = dictionary.zh ?? {};
          const en = dictionary.en ?? {};
          ctx.effect(() => locale.register(NS, 'zh', zh), 'dsh-code-notes: zh dictionary');
          ctx.effect(() => locale.register(NS, 'en', en), 'dsh-code-notes: en dictionary');
        }
        // 标签函数：locale 服务提供 bind 时走它，否则退回内置中文文案。
        const labels = (key) => {
          try {
            if (locale !== undefined && typeof locale.bind === 'function') return locale.bind(NS)(key);
          } catch {
            // 本地字典缺失时用内置中文兜底
          }
          return undefined;
        };
        ctx.effect(() => insertStyle(), 'dsh-code-notes: style');
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'code-notes',
          order: 40,
          label: () => labels('panel.open') ?? '讲解',
          locale: NS,
          inject: (sessionId) => ({ sessionId })
        }, (props) => {
          const sessionId = props?.sessionId ?? props?.inject?.sessionId;
          return h(ExplainerPanel, { sessionId, labels });
        }));
      }
    };
  }
});
