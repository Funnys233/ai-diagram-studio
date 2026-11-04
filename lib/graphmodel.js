/**
 * mxGraphModel 结构与几何校验 + 确定性布局变换（零依赖，Node 与浏览器共用）
 *
 * 校验范围（在 lib/xml.js 的语法校验之上）：
 *   - 根节点必须是 <mxGraphModel>，且包含唯一的 <root>
 *   - 每个 mxCell 必须有非空的唯一 id
 *   - 必须以 id="0"（根）与 id="1"（默认图层，parent="0"）为骨架
 *   - parent / source / target 必须引用已存在的 id
 *   - vertex=1 必须有 <mxGeometry>，且 x/y/width/height 为有限数值、宽高不为负
 *   - edge=1 必须有 <mxGeometry>，source/target 至少一个存在（支持 sourcePoint 悬空连线）
 *   - 允许合法容器 / 分组（swimlane、group 只是 style + parent，不额外限制）
 *   - 允许 <UserObject>/<object> 包装的「扩展属性」单元格
 *   - 单元数量上限，避免超大图拖垮服务
 */
(function (global, factory) {
  const xml = (typeof module === 'object' && module.exports)
    ? require('./xml.js')
    : global.DiagramXml;
  const api = factory(xml);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else global.DiagramModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Xml) {
  'use strict';

  const DEFAULT_MAX_CELLS = 5000;
  const WRAPPER_NAMES = ['UserObject', 'object'];
  const ROOT_CHILD_NAMES = ['mxCell'].concat(WRAPPER_NAMES);

  function err(code, message) {
    return { ok: false, error: { code, message } };
  }

  function toNumber(value) {
    if (value === undefined || value === null) return null;
    const str = String(value).trim();
    if (str === '') return null;
    const num = Number(str);
    return Number.isFinite(num) ? num : NaN;
  }

  /** 收集 <root> 下的所有单元格；返回 [{ cell, wrapper }] */
  function collectCells(rootEl) {
    const cells = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.name === 'mxCell') {
          cells.push({ cell: child, wrapper: null });
        } else if (WRAPPER_NAMES.indexOf(child.name) !== -1) {
          const inner = child.children.filter((c) => c.name === 'mxCell');
          if (inner.length === 0) {
            // 允许空的 UserObject？不允许，会产生不可见垃圾数据
            cells.push({ cell: null, wrapper: child });
          }
          inner.forEach((c) => cells.push({ cell: c, wrapper: child }));
        } else {
          cells.push({ cell: null, wrapper: child, unknown: child.name });
        }
      }
      return null;
    };
    walk(rootEl);
    return cells;
  }

  /** 有效 id：draw.io 的 <UserObject>/<object> 包装把 id 放在外层，内层 mxCell 不带 id */
  function effectiveId(entry) {
    if (!entry || !entry.cell) return undefined;
    if (entry.cell.attributes.id !== undefined) return entry.cell.attributes.id;
    if (entry.wrapper && entry.wrapper.attributes.id !== undefined) return entry.wrapper.attributes.id;
    return undefined;
  }

  /**
   * 校验 mxGraphModel。
   * @param {string} modelXml
   * @param {{maxCells?: number}} [options]
   * @returns {{ok: true, stats: object} | {ok: false, error: {code: string, message: string}}}
   */
  function validateGraphModel(modelXml, options) {
    const opts = options || {};
    const maxCells = opts.maxCells || DEFAULT_MAX_CELLS;

    if (typeof modelXml !== 'string' || modelXml.trim() === '') {
      return err('empty-input', '图表 XML 为空');
    }

    let parsed;
    try {
      parsed = Xml.parse(modelXml);
    } catch (e) {
      if (e && e.name === 'XmlError') {
        return err('xml-' + e.code, e.message);
      }
      throw e;
    }

    const root = parsed.root;
    if (root.name !== 'mxGraphModel') {
      return err('bad-root', `根节点必须是 <mxGraphModel>，实际是 <${root.name}>`);
    }

    const unknownChildren = root.children.filter((c) => c.name !== 'root');
    if (unknownChildren.length > 0) {
      return err('unexpected-root-child', `<mxGraphModel> 下出现了非法元素 <${unknownChildren[0].name}>，只允许 <root>`);
    }
    const rootEls = Xml.childElements(root, 'root');
    if (rootEls.length === 0) return err('missing-root', '<mxGraphModel> 缺少 <root> 元素');
    if (rootEls.length > 1) return err('duplicate-root', '<mxGraphModel> 中出现了多个 <root> 元素');

    const cellEntries = collectCells(rootEls[0]);
    const unknown = cellEntries.find((entry) => entry.unknown);
    if (unknown) {
      return err('unexpected-cell', `<root> 下出现了非法元素 <${unknown.unknown}>，只允许 mxCell 与 UserObject/object 包装`);
    }
    const emptyWrapper = cellEntries.find((entry) => !entry.cell);
    if (emptyWrapper) {
      return err('empty-wrapper', `<${emptyWrapper.wrapper.name}> 包装内缺少 <mxCell>`);
    }

    if (cellEntries.length > maxCells) {
      return err('too-many-cells', `图表单元格数量 ${cellEntries.length} 超过上限 ${maxCells}`);
    }

    const ids = new Map();
    const stats = { cells: 0, vertices: 0, edges: 0, containers: 0 };

    for (const entry of cellEntries) {
      const cell = entry.cell;
      const id = effectiveId(entry);
      if (id === undefined || id === '') {
        return err('missing-id', '存在没有 id 的 mxCell 单元格');
      }
      if (ids.has(id)) {
        return err('duplicate-id', `存在重复的单元格 id="${id}"`);
      }
      const isVertex = cell.attributes.vertex === '1';
      const isEdge = cell.attributes.edge === '1';
      if (isVertex && isEdge) {
        return err('vertex-and-edge', `id="${id}" 同时声明了 vertex="1" 与 edge="1"`);
      }
      ids.set(id, { cell, wrapper: entry.wrapper, isVertex, isEdge });
      stats.cells++;
      if (isVertex) stats.vertices++;
      if (isEdge) stats.edges++;
    }

    if (!ids.has('0')) return err('missing-root-cell', '缺少 id="0" 的根单元格');
    if (ids.get('0').cell.attributes.parent !== undefined) {
      return err('root-cell-parent', 'id="0" 是根单元格，不应带 parent 属性');
    }
    if (!ids.has('1')) return err('missing-layer-cell', '缺少 id="1" 的默认图层单元格');
    if (ids.get('1').cell.attributes.parent !== '0') {
      return err('bad-layer-parent', 'id="1" 的 parent 必须是 "0"');
    }

    for (const [id, info] of ids) {
      const { cell, isVertex, isEdge } = info;
      const parent = cell.attributes.parent;
      if (id !== '0') {
        if (parent === undefined || parent === '') {
          return err('missing-parent', `id="${id}" 缺少 parent 属性`);
        }
        if (!ids.has(parent)) {
          return err('invalid-parent-ref', `id="${id}" 的 parent="${parent}" 指向不存在的单元格`);
        }
      } else if (parent !== undefined) {
        return err('root-cell-parent', 'id="0" 不应带 parent 属性');
      }

      const geometryNodes = Xml.childElements(cell, 'mxGeometry');
      const unknownCellChildren = cell.children.filter((c) => c.name !== 'mxGeometry');
      if (unknownCellChildren.length > 0) {
        return err('unexpected-cell-child', `id="${id}" 内含非法子元素 <${unknownCellChildren[0].name}>，只允许 <mxGeometry>`);
      }
      if (geometryNodes.length > 1) {
        return err('duplicate-geometry', `id="${id}" 含多个 <mxGeometry>`);
      }
      const geometry = geometryNodes[0] || null;

      if ((isVertex || isEdge) && !geometry) {
        return err('missing-geometry', `id="${id}" 声明了 ${isVertex ? 'vertex' : 'edge'} 但缺少 <mxGeometry>`);
      }

      if (geometry) {
        for (const axis of ['x', 'y', 'width', 'height']) {
          const raw = geometry.attributes[axis];
          if (raw === undefined) continue;
          const num = toNumber(raw);
          if (num === null) continue;
          if (Number.isNaN(num)) {
            return err('bad-geometry', `id="${id}" 的 ${axis}="${raw}" 不是合法数值`);
          }
          if ((axis === 'width' || axis === 'height') && num < 0) {
            return err('bad-geometry', `id="${id}" 的 ${axis}=${num} 不能为负数`);
          }
        }
        if (isVertex) {
          for (const axis of ['width', 'height']) {
            if (geometry.attributes[axis] === undefined) {
              return err('missing-size', `节点 id="${id}" 缺少 ${axis}，无法确定图形尺寸`);
            }
            if (toNumber(geometry.attributes[axis]) === 0) {
              return err('zero-size', `节点 id="${id}" 的 ${axis} 为 0，无法渲染`);
            }
          }
        }
        for (const point of geometry.children) {
          if (point.name !== 'mxPoint' && point.name !== 'mxRectangle' && point.name !== 'Array') {
            return err('unexpected-geometry-child', `id="${id}" 的 <mxGeometry> 内含非法元素 <${point.name}>`);
          }
          for (const axis of ['x', 'y', 'width', 'height']) {
            const raw = point.attributes[axis];
            if (raw === undefined) continue;
            const num = toNumber(raw);
            if (num !== null && Number.isNaN(num)) {
              return err('bad-geometry', `id="${id}" 的 ${point.name} 上 ${axis}="${raw}" 不是合法数值`);
            }
          }
        }
      }

      if (isEdge) {
        const source = cell.attributes.source;
        const target = cell.attributes.target;
        for (const [key, value] of [['source', source], ['target', target]]) {
          if (value === undefined || value === '') continue;
          if (!ids.has(value)) {
            return err('invalid-edge-ref', `连线 id="${id}" 的 ${key}="${value}" 指向不存在的节点`);
          }
        }
        const hasPoint = geometry && geometry.children.some((c) => c.name === 'mxPoint');
        if ((source === undefined || source === '') && (target === undefined || target === '')) {
          if (!hasPoint) {
            return err('dangling-edge', `连线 id="${id}" 既没有 source/target，也没有悬空端点`);
          }
        }
      }

      if (isVertex && cell.attributes.style && /(?:^|;)(swimlane|group)(?:=|;|$)/.test(cell.attributes.style)) {
        stats.containers++;
      }
    }

    return {
      ok: true,
      stats,
      root,
      source: parsed.source,
      declaration: parsed.declaration,
    };
  }

  function serializeNode(node) {
    const attrs = (node.attributeOrder || Object.keys(node.attributes))
      .filter((name) => node.attributes[name] !== undefined)
      .map((name) => ` ${name}="${Xml.escapeAttr(node.attributes[name])}"`)
      .join('');
    if (node.selfClosing || (node.children.length === 0 && node.textParts.length === 0)) {
      return `<${node.name}${attrs}/>`;
    }
    const inner = node.textParts.map((p) => Xml.escapeText(p.value)).join('')
      + node.children.map(serializeNode).join('');
    return `<${node.name}${attrs}>${inner}</${node.name}>`;
  }

  /** 布局变换无法处理的图形结构（调用方应保留原图并向用户说明） */
  class LayoutError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'LayoutError';
      this.code = code;
    }
  }

  function parseStartSize(style) {
    if (!style) return 0;
    const m = /(?:^|;)startSize=(-?\d+(?:\.\d+)?)/.exec(style);
    return m ? Number(m[1]) : 0;
  }

  /**
   * 确定性布局变换：把当前图表整体改为横向（从左到右）或纵向（从上到下）。
   *
   * 按图形层级处理：
   *   - 子节点在**父容器的局部坐标系**里排布（swimlane 会偏移 startSize），
   *     父容器尺寸随子节点排布调整，保证子节点始终落在容器内
   *   - 顶层节点（parent 不是顶点，例如挂在默认图层上）按目标方向整体排布
   *   - 只改 x/y/width/height，保留全部 id、标签、样式、扩展属性与连线几何
   *   - 遇到暂不支持的结构（挂在连线上的单元格、父子成环、相对几何顶点）明确抛错，
   *     由调用方保留原图
   * @returns {{xml: string, moved: number, total: number, containers: number}}
   */
  function applyLayout(modelXml, direction) {
    const parsed = Xml.parse(modelXml);
    const rootEls = Xml.childElements(parsed.root, 'root');
    if (rootEls.length !== 1) throw new LayoutError('missing-root', '<mxGraphModel> 缺少唯一的 <root>');

    const horizontal = direction !== 'vertical';
    const GAP = horizontal ? 60 : 40;
    const PAD = 20;

    const nodes = new Map();
    for (const { cell } of collectCells(rootEls[0])) {
      if (!cell) continue;
      const id = cell.attributes.id;
      if (id === undefined) continue;
      nodes.set(id, {
        id,
        cell,
        geometry: Xml.firstChild(cell, 'mxGeometry'),
        vertex: cell.attributes.vertex === '1',
        edge: cell.attributes.edge === '1',
        visible: cell.attributes.visible !== '0',
        parentId: cell.attributes.parent || null,
        startSize: parseStartSize(cell.attributes.style),
        children: [],
      });
    }

    // 建立父子关系（只有顶点能作为容器），并检测环路 / 层级过深
    for (const node of nodes.values()) {
      if (!node.parentId) continue;
      const parent = nodes.get(node.parentId);
      if (!parent) continue;
      if (parent.edge) {
        throw new LayoutError('layout-edge-child', `单元格 id="${node.id}" 挂在连线 id="${parent.id}" 上，示例引擎暂不支持这种结构`);
      }
      if (parent.vertex) parent.children.push(node);
      let cursor = parent;
      let hops = 0;
      const seen = new Set([node.id]);
      while (cursor) {
        if (seen.has(cursor.id)) {
          throw new LayoutError('layout-cycle', `单元格父子关系存在环（涉及 id="${cursor.id}"），示例引擎暂不支持`);
        }
        seen.add(cursor.id);
        if (++hops > 64) {
          throw new LayoutError('layout-too-deep', '单元格父子层级过深，示例引擎暂不支持该结构');
        }
        cursor = cursor.parentId ? nodes.get(cursor.parentId) : null;
      }
    }

    let moved = 0;
    function attrNumber(node, axis) {
      const raw = node.geometry ? node.geometry.attributes[axis] : undefined;
      const num = toNumber(raw);
      return (num === null || Number.isNaN(num)) ? 0 : num;
    }
    function setAttr(node, axis, value) {
      const g = node.geometry;
      if (!g) return;
      if (g.attributeOrder.indexOf(axis) === -1) g.attributeOrder.push(axis);
      g.attributes[axis] = String(value);
    }
    function sizeOf(node) {
      const g = node.geometry;
      if (!g) return { w: 120, h: 60 };
      const w = toNumber(g.attributes.width);
      const h = toNumber(g.attributes.height);
      return {
        w: (w === null || Number.isNaN(w) || w <= 0) ? 120 : w,
        h: (h === null || Number.isNaN(h) || h <= 0) ? 60 : h,
      };
    }

    const movableChildren = (node) => node.children
      .filter((c) => c.vertex && c.geometry && c.visible);

    /** 自底向上：先排子容器，再排本级子节点，最后按需调整容器尺寸 */
    function layoutContainer(node) {
      for (const child of node.children) {
        if (child.vertex && child.geometry && child.children.length) layoutContainer(child);
      }
      const kids = movableChildren(node);
      if (kids.length === 0) return;

      kids.sort((a, b) => (horizontal
        ? (attrNumber(a, 'y') - attrNumber(b, 'y')) || (attrNumber(a, 'x') - attrNumber(b, 'x'))
        : (attrNumber(a, 'x') - attrNumber(b, 'x')) || (attrNumber(a, 'y') - attrNumber(b, 'y'))));

      const real = node.vertex && node.geometry;
      // 泳道标题（startSize）会占用容器顶部，两种方向都必须避开，否则子节点会被标题遮住
      const headerOffset = real ? (node.startSize + PAD) : 0;
      const startMain = real
        ? (horizontal ? PAD : headerOffset)
        : Math.min.apply(null, kids.map((c) => (horizontal ? attrNumber(c, 'x') : attrNumber(c, 'y'))));
      const startCross = real
        ? (horizontal ? headerOffset : PAD)
        : Math.min.apply(null, kids.map((c) => (horizontal ? attrNumber(c, 'y') : attrNumber(c, 'x'))));

      let cursor = startMain;
      let maxCross = 0;
      for (const child of kids) {
        const { w, h } = sizeOf(child);
        const x = horizontal ? cursor : startCross;
        const y = horizontal ? startCross : cursor;
        if (attrNumber(child, 'x') !== x) { setAttr(child, 'x', x); moved++; }
        if (attrNumber(child, 'y') !== y) { setAttr(child, 'y', y); moved++; }
        if (horizontal) { cursor += w + GAP; maxCross = Math.max(maxCross, h); }
        else { cursor += h + GAP; maxCross = Math.max(maxCross, w); }
      }

      // 真实容器：把尺寸调整到刚好容纳排布后的子节点（位置不动）
      if (real) {
        const size = sizeOf(node);
        const needW = horizontal ? (cursor - GAP + PAD) : (startCross + maxCross + PAD);
        const needH = horizontal ? (startCross + maxCross + PAD) : (cursor - GAP + PAD);
        const nextW = Math.max(size.w, Math.ceil(needW));
        const nextH = Math.max(size.h, Math.ceil(needH));
        if (size.w !== nextW) { setAttr(node, 'width', nextW); moved++; }
        if (size.h !== nextH) { setAttr(node, 'height', nextH); moved++; }
      }
    }

    // 全部容器（含嵌套）自底向上排布
    for (const node of nodes.values()) {
      if (!node.vertex || !node.geometry) continue;
      if (node.geometry.attributes.relative === '1') {
        throw new LayoutError('layout-relative-vertex', `节点 id="${node.id}" 使用相对几何（relative=1），示例引擎暂不支持这种结构`);
      }
      if (node.children.length) layoutContainer(node);
    }

    // 顶层节点（parent 不是顶点）整体按目标方向排布
    const roots = [];
    for (const node of nodes.values()) {
      if (!node.vertex || !node.geometry || !node.visible) continue;
      if (node.geometry.attributes.relative === '1') continue;
      const parent = node.parentId ? nodes.get(node.parentId) : null;
      if (parent && parent.vertex) continue; // 属于某个容器，已处理
      roots.push(node);
    }
    roots.sort((a, b) => (horizontal
      ? (attrNumber(a, 'y') - attrNumber(b, 'y')) || (attrNumber(a, 'x') - attrNumber(b, 'x'))
      : (attrNumber(a, 'x') - attrNumber(b, 'x')) || (attrNumber(a, 'y') - attrNumber(b, 'y'))));

    let cursor = horizontal ? 80 : 60;
    for (const node of roots) {
      const { w, h } = sizeOf(node);
      const x = horizontal ? cursor : 340;
      const y = horizontal ? 220 : cursor;
      if (attrNumber(node, 'x') !== x) { setAttr(node, 'x', x); moved++; }
      if (attrNumber(node, 'y') !== y) { setAttr(node, 'y', y); moved++; }
      cursor += (horizontal ? w + GAP : h + GAP);
    }

    let containerChildren = 0;
    let containers = 0;
    for (const node of nodes.values()) {
      if (!node.vertex || !node.geometry || node.children.length === 0) continue;
      containers++;
      containerChildren += movableChildren(node).length;
    }

    return {
      xml: serializeNode(parsed.root),
      moved,
      total: roots.length + containerChildren,
      containers,
    };
  }

  function numberOr(value, fallback) {
    const num = toNumber(value);
    return (num === null || Number.isNaN(num)) ? fallback : num;
  }

  /** 概览统计：给日志与「已更新」提示用，避免打印整张图 */
  function summarize(modelXml) {
    const result = validateGraphModel(modelXml, { maxCells: Infinity });
    if (!result.ok) return { ok: false, error: result.error, vertices: 0, edges: 0, cells: 0 };
    const rootEls = Xml.childElements(result.root, 'root');
    const labels = [];
    for (const { cell } of collectCells(rootEls[0])) {
      if (!cell || cell.attributes.vertex !== '1') continue;
      if (labels.length >= 6) break;
      if (cell.attributes.value) labels.push(cell.attributes.value);
    }
    return { ok: true, ...result.stats, labels };
  }

  return {
    validateGraphModel,
    applyLayout,
    LayoutError,
    summarize,
    serializeNode,
    collectCells,
    DEFAULT_MAX_CELLS,
  };
});
