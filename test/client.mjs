/**
 * 客户端模块冒烟：用假的 __ModuleLoader__ / React / ctx 加载 client.js，
 * 验证插件对象形态、插槽注册与首帧渲染不抛错。
 * 运行：node test/client.mjs
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');

let spec;
const registered = [];
const injected = [];
let stylesAdded = 0;

globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      spec = value;
    },
    create() {}
  }
};
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '', remove() {} }),
  head: { appendChild: () => { stylesAdded += 1; } }
};

// Node 的 ESM 不认 window；这里只是让它能运行，不影响 window 的赋值
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (factory) => factory,
  useRef: (initial) => ({ current: initial })
};

await import('../client.js').catch(() => {});
assert.ok(spec !== undefined, '__ModuleLoader__.load 未被调用');
assert.equal(spec.id, 'dsh-code-notes');

const mod = spec.factory((name) => {
  if (name === 'react') return React;
  return {};
});
assert.deepEqual(mod.inject, ['slots', 'locale', 'connection']);

const makeCtx = () => ({
  get: () => undefined,
  effect: (fn) => {
    const dispose = fn();
    return () => {
      if (typeof dispose === 'function') dispose();
    };
  },
  on: () => () => {},
  slots: {
    inject: (key, callback) => {
      injected.push(key);
      callback();
      return () => {};
    },
    register: (options, component) => {
      registered.push({ options, component });
      return () => {};
    }
  },
  locale: { register: () => () => {}, bind: () => (key) => undefined }
});

mod.apply(makeCtx());
assert.deepEqual(injected, ['conversation.composer.dock']);
assert.equal(registered.length, 1);
assert.equal(registered[0].options.name, 'conversation.composer.dock');
assert.equal(registered[0].options.id, 'code-notes');
assert.equal(stylesAdded, 1, '样式表应插入一次');

const Panel = registered[0].component;
const tree = Panel({ sessionId: 'session-test' });
assert.ok(tree !== undefined && tree !== null);
// 组件返回的是 <ExplainerPanel> 元素：React 交给宿主渲染函数组件
assert.equal(typeof tree.type, 'function');
const inner = tree.type(tree.props);
assert.equal(inner.type, 'div');
assert.equal(inner.props.className, 'cn-root');
const trigger = inner.children[0];
assert.equal(trigger.props.className, 'cn-trigger');
assert.ok(trigger.props['data-cn-diag'] !== undefined, '诊断信息应挂在触发按钮上');
// 关闭状态只渲染触发按钮
assert.equal(inner.children.length, 1);

// 没有 sessionId 时也不应抛错（面板只显示空态）
const empty = Panel({ sessionId: undefined });
assert.ok(empty !== null);

console.log('PASS  客户端模块：factory 形态与插槽注册正确');
console.log('PASS  首帧渲染：触发按钮 + 面板骨架，无异常');
