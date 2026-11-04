// Shared local-edit compiler. The model proposes operations; the host preserves
// the original document and enforces the selected scope before constructing XML.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./xml'), require('./graphmodel'));
  else root.DiagramEdit = factory(root.DiagramXml, root.DiagramModel);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Xml, Model) {
  'use strict';
  class EditError extends Error {
    constructor(message, code = 'invalid-edit') { super(message); this.name = 'EditError'; this.code = code; }
  }
  const object = x => x && typeof x === 'object' && !Array.isArray(x);
  function fail(message, code) { throw new EditError(message, code); }
  function keys(value, allowed, name) {
    if (!object(value) || Object.keys(value).some(k => !allowed.includes(k))) fail(`${name} 含有未支持的字段`);
  }
  function indexModel(xml) {
    const checked = Model.validateGraphModel(xml);
    if (!checked.ok) fail(checked.error.message);
    const doc = Xml.parse(xml), root = Xml.firstChild(doc.root, 'root'), cells = new Map();
    for (const entry of Model.collectCells(root)) {
      const id = entry.cell.attributes.id ?? entry.wrapper?.attributes.id;
      const node = entry.wrapper || entry.cell;
      cells.set(id, { ...entry, id, node, label: entry.wrapper ? entry.wrapper.attributes.label || '' : entry.cell.attributes.value || '',
        kind: entry.cell.attributes.vertex === '1' ? 'node' : entry.cell.attributes.edge === '1' ? 'edge' : 'layer' });
    }
    return { xml, doc, root, cells };
  }
  function resolveScope(xml, targetIds) {
    const index = indexModel(xml);
    if (!Array.isArray(targetIds) || !targetIds.length || targetIds.length > 200 || targetIds.some(id => typeof id !== 'string' || !id || id.length > 200)) {
      fail('请选择 1–200 个节点或连线', 'invalid-edit-targets');
    }
    const targets = [...new Set(targetIds)], allowed = new Set(targets);
    for (const id of targets) if (!index.cells.has(id) || index.cells.get(id).kind === 'layer') fail(`无法修改目标 ${id}，请重新选择节点或连线`, 'invalid-edit-targets');
    // Selecting a group authorizes its descendants, never its ancestors.
    for (let i = 0; i < index.cells.size; i++) {
      let added = false;
      for (const e of index.cells.values()) if (!allowed.has(e.id) && allowed.has(e.cell.attributes.parent)) { allowed.add(e.id); added = true; }
      if (!added) break;
    }
    if (allowed.size > 1000) fail('选区包含过多子元素，请缩小修改范围');
    return { index, targetIds: targets, allowed, cells: [...allowed].map(id => ({ id, label: index.cells.get(id).label, kind: index.cells.get(id).kind })) };
  }
  function minimizeTargets(xml, ids) {
    if(!Array.isArray(ids)||ids.length>5000)fail('选区数据过大');
    const index=indexModel(xml), selected=new Set(ids);
    for(const id of selected)if(typeof id!=='string'||!index.cells.has(id)||index.cells.get(id).kind==='layer')fail('选区包含无效元素');
    return [...selected].filter(id=>{
      let parent=index.cells.get(id).cell.attributes.parent;const seen=new Set([id]);
      while(parent){if(seen.has(parent)||seen.size>128)fail('选区父子关系成环或过深');seen.add(parent);if(selected.has(parent))return false;parent=index.cells.get(parent)?.cell.attributes.parent;}
      return true;
    });
  }
  function parsePatch(content) {
    let patch = content;
    if (typeof patch === 'string') {
      const text = patch.trim(), fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
      try { patch = JSON.parse(fence ? fence[1] : text); } catch { fail('局部修改必须返回一个 JSON 对象，不接受完整 XML'); }
    }
    keys(patch, ['version', 'operations'], '局部修改');
    if (patch.version !== 1 || !Array.isArray(patch.operations) || patch.operations.length > 100) fail('局部修改版本须为 1，操作数量不能超过 100');
    return patch;
  }
  function scalar(value, name) {
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 10000000) fail(`${name} 必须是有限数值`);
    return String(value);
  }
  function label(value) { if (typeof value !== 'string' || value.length > 4000) fail('标签必须是 4000 字以内的文本'); return value; }
  function mergeStyle(original, values) {
    if (!object(values) || Object.keys(values).length > 50) fail('样式必须是字段对象');
    const parts = (original || '').split(';').filter(Boolean);
    for (const [key, value] of Object.entries(values)) {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) fail('样式字段名不合法');
      if (value !== null && !(['string', 'number', 'boolean'].includes(typeof value)) || typeof value === 'number' && !Number.isFinite(value)) fail('样式值不合法');
      const str = String(value);
      if (value !== null && (str.length > 1000 || /[;\x00-\x1f]/.test(str))) fail('样式值包含不支持的分隔符或超长内容');
      for (let i = parts.length - 1; i >= 0; i--) if (parts[i].split('=')[0] === key) parts.splice(i, 1);
      if (value !== null) parts.push(`${key}=${typeof value === 'boolean' ? (value ? '1' : '0') : str}`);
    }
    return parts.length ? parts.join(';') + ';' : '';
  }
  function set(node, name, value) {
    if (!node.attributeOrder.includes(name)) node.attributeOrder.push(name);
    node.attributes[name] = value;
  }
  function openTag(node) {
    return `<${node.name}${node.attributeOrder.filter(k => node.attributes[k] !== undefined).map(k => ` ${k}="${Xml.escapeAttr(node.attributes[k])}"`).join('')}${node.selfClosing ? '/>' : '>'}`;
  }
  function geometryChanges(node, values, kind) {
    keys(values, ['x','y','width','height','points'], '几何修改');
    for (const axis of ['x','y','width','height']) if (values[axis] !== undefined) {
      if ((axis === 'width' || axis === 'height') && values[axis] <= 0) fail('节点宽高必须为正');
      set(node, axis, scalar(values[axis], axis));
    }
    if (values.points !== undefined) {
      if (kind !== 'edge' || !Array.isArray(values.points) || values.points.length > 30) fail('路由点仅用于选中的连线，最多 30 个');
      node.children = node.children.filter(c => !(c.name === 'Array' && c.attributes.as === 'points'));
      if (values.points.length) {
        const points = values.points.map(p => { keys(p,['x','y'],'路由点'); return `<mxPoint x="${scalar(p.x,'x')}" y="${scalar(p.y,'y')}"/>`; }).join('');
        node.children.push(Xml.parse(`<Array as="points">${points}</Array>`).root);
      }
      node.selfClosing = node.children.length === 0;
    }
  }
  function styleSignature(style) {
    const props = Object.create(null), names=[];
    for(const p of String(style||'').split(';').filter(Boolean)) {
      const split=p.indexOf('='); if(split<0)names.push(p);else props[p.slice(0,split)]=p.slice(split+1);
    }
    return [names,Object.keys(props).sort().map(k=>[k,props[k]])];
  }
  function signature(node) {
    return JSON.stringify([node.name,Object.keys(node.attributes).sort().map(k=>[k,k==='style'?styleSignature(node.attributes[k]):node.attributes[k]]),node.textParts.map(p=>p.value.trim()).filter(Boolean),node.children.map(signature)]);
  }
  function diff(before, after) {
    const a = indexModel(before), b = indexModel(after), added=[],removed=[],updated=[];
    for (const [id, entry] of a.cells) {
      const next = b.cells.get(id);
      if (!next) removed.push({id,label:entry.label,kind:entry.kind});
      else if (signature(entry.node) !== signature(next.node)) {
        const fields=[];
        if (entry.label !== next.label) fields.push('文字');
        if(['source','target'].some(k=>entry.cell.attributes[k]!==next.cell.attributes[k]))fields.push('连接端点');
        if (JSON.stringify(styleSignature(entry.cell.attributes.style)) !== JSON.stringify(styleSignature(next.cell.attributes.style))) fields.push('样式');
        const ga=Xml.firstChild(entry.cell,'mxGeometry'),gb=Xml.firstChild(next.cell,'mxGeometry');
        if ((ga&&signature(ga)) !== (gb&&signature(gb))) fields.push('位置/尺寸/路由');
        updated.push({id,label:next.label,kind:next.kind,fields});
      }
    }
    for (const [id,entry] of b.cells) if (!a.cells.has(id)) added.push({id,label:entry.label,kind:entry.kind});
    return {added,removed,updated,total:added.length+removed.length+updated.length};
  }
  function applyPatch(original, content, targetIds, options = {}) {
    const patch = parsePatch(content), scope = resolveScope(original,targetIds), {index,allowed} = scope;
    const edits=[], seen=new Set(), removed=new Set(), additions=[], idMap=Object.create(null), allIds=new Set(index.cells.keys());
    let counter=0;
    for (const op of patch.operations) {
      if (!object(op) || typeof op.id !== 'string' || !op.id || op.id.length > 200 || seen.has(op.id)) fail('每个操作必须有唯一的元素 ID');
      seen.add(op.id);
      if (op.op === 'add') {
        if (index.cells.has(op.id)) fail('新增元素不能复用已有 ID');
        const real=options.idMap?.[op.id] || `ai-edit-${options.nonce || 'new'}-${++counter}`;
        if (typeof real !== 'string' || !real || real.length > 200 || allIds.has(real)) fail('新增元素 ID 冲突');
        idMap[op.id]=real;allIds.add(real);
      } else if (!['update','remove'].includes(op.op) || !allowed.has(op.id)) fail(`操作超出选区：${op.id}`, 'edit-out-of-scope');
    }
    for (const op of patch.operations) if (op.op === 'remove') {
      keys(op,['op','id'],'删除操作');removed.add(op.id);
      for (let i=0;i<index.cells.size;i++) {
        let changed=false;
        for (const e of index.cells.values()) if (!removed.has(e.id) && removed.has(e.cell.attributes.parent)) { removed.add(e.id);changed=true; }
        if(!changed)break;
      }
    }
    // Remove incident edges and edge labels together to keep graph references valid.
    for(let i=0;i<index.cells.size;i++) {
      let changed=false;
      for (const e of index.cells.values()) if (!removed.has(e.id) && (e.kind==='edge' && (removed.has(e.cell.attributes.source) || removed.has(e.cell.attributes.target)) || removed.has(e.cell.attributes.parent))) {removed.add(e.id);changed=true;}
      if(!changed)break;
    }
    const ref=id=>idMap[id] || id;
    const parents=new Set(['1']);
    for(const id of allowed) parents.add(index.cells.get(id).cell.attributes.parent);
    const addKinds=new Map(patch.operations.filter(o=>o.op==='add').map(o=>[idMap[o.id],o.kind]));
    for (const op of patch.operations) {
      if(op.op==='remove')continue;
      if(op.op==='update') {
        keys(op,['op','id','label','style','geometry','source','target'],'更新操作');
        if (removed.has(op.id)) fail('不能同时修改被删除节点、后代或关联边');
        if (op.label === undefined && op.style === undefined && op.geometry === undefined && op.source === undefined && op.target === undefined) fail('更新操作没有任何字段');
        const e=index.cells.get(op.id);
        for(const key of ['source','target'])if(op[key]!==undefined) {
          const id=ref(op[key]);
          if(e.kind!=='edge'||typeof id!=='string'||removed.has(id)||!(id===e.cell.attributes[key]||allowed.has(id)&&index.cells.get(id)?.kind==='node'||addKinds.get(id)==='node'))fail('只有选中连线可更换端点，新的端点必须在选区或本次新增节点中');
          set(e.cell,key,id);
        }
        if(op.label!==undefined) { const n=e.wrapper||e.cell;set(n,e.wrapper?'label':'value',label(op.label)); }
        if(op.style!==undefined)set(e.cell,'style',mergeStyle(e.cell.attributes.style,op.style));
        if(op.label!==undefined&&e.wrapper)edits.push({start:e.wrapper.start,end:e.wrapper.openEnd,text:openTag(e.wrapper)});
        if(op.style!==undefined||op.source!==undefined||op.target!==undefined||op.label!==undefined&&!e.wrapper)edits.push({start:e.cell.start,end:e.cell.openEnd,text:openTag(e.cell)});
        if(op.geometry!==undefined){const g=Xml.firstChild(e.cell,'mxGeometry');geometryChanges(g,op.geometry,e.kind);edits.push({start:g.start,end:g.end,text:Model.serializeNode(g)});}
      } else {
        keys(op,['op','id','kind','label','style','geometry','parent','source','target'],'新增操作');
        if (!['node','edge'].includes(op.kind)) fail('新增元素须为 node 或 edge');
        const parent=ref(op.parent||'1');
        if (removed.has(parent) || !(parents.has(parent) || allowed.has(parent) && index.cells.get(parent)?.kind==='node' || addKinds.get(parent)==='node')) fail('新增元素的容器超出范围');
        const attrs={id:idMap[op.id],value:label(op.label===undefined?'':op.label),style:mergeStyle('',op.style||{}),[op.kind==='node'?'vertex':'edge']:'1',parent};
        if(op.kind==='edge')for(const key of ['source','target']){
          const id=ref(op[key]);
          if(typeof id!=='string'||removed.has(id)||!(allowed.has(id)&&index.cells.get(id)?.kind==='node'||addKinds.get(id)==='node'))fail('新增连线只能连接选区节点和本次新增节点');
          attrs[key]=id;
        }
        const g=Xml.parse(op.kind==='node'?'<mxGeometry x="0" y="0" width="120" height="60" as="geometry"/>':'<mxGeometry relative="1" as="geometry"/>').root;
        geometryChanges(g,op.geometry||{},op.kind);
        additions.push(`<mxCell${Object.entries(attrs).map(([k,v])=>` ${k}="${Xml.escapeAttr(v)}"`).join('')}>${Model.serializeNode(g)}</mxCell>`);
      }
    }
    for(const id of removed){const n=index.cells.get(id).node;edits.push({start:n.start,end:n.end,text:''});}
    if(additions.length)edits.push({start:index.root.innerEnd,end:index.root.innerEnd,text:additions.join('')});
    edits.sort((a,b)=>b.start-a.start);
    let xml=original,previous=original.length;
    for(const edit of edits){if(edit.end>previous)fail('修改片段发生重叠');xml=xml.slice(0,edit.start)+edit.text+xml.slice(edit.end);previous=edit.start;}
    const merged=indexModel(xml);
    for(const entry of merged.cells.values()) {
      const seenParents=new Set();let cursor=entry;
      while(cursor) {
        if(seenParents.has(cursor.id)||seenParents.size>128)fail('元素父子关系成环或层级过深');
        seenParents.add(cursor.id);cursor=merged.cells.get(cursor.cell.attributes.parent);
      }
    }
    const checked=Model.validateGraphModel(xml);
    if(!checked.ok)fail('合并后图表不合法：'+checked.error.message);
    const changes=diff(original,xml);
    for(const change of changes.updated)if(!allowed.has(change.id))fail('受保护元素被修改：'+change.id,'edit-out-of-scope');
    for(const change of changes.removed)if(!removed.has(change.id))fail('受保护元素被删除：'+change.id,'edit-out-of-scope');
    return {xml:changes.total?xml:original,patch,idMap,changes,targetIds:scope.targetIds,scopeIds:[...allowed],stats:checked.stats,
      requiresReview:changes.added.length>0||changes.removed.length>0||changes.updated.length>5||changes.updated.some(c=>c.fields.includes('连接端点'))};
  }
  function verifyCandidate(original, result, targetIds) {
    if (!object(result) || !object(result.idMap)) fail('局部修改响应缺少校验信息');
    const expected=applyPatch(original,result.patch,targetIds,{idMap:result.idMap});
    if(expected.xml!==result.xml||JSON.stringify(expected.changes)!==JSON.stringify(result.changes)||expected.requiresReview!==result.requiresReview)fail('局部修改结果与变更说明不一致');
    return expected;
  }
  function rebase(original, current, content, targetIds, idMap) {
    const expected=applyPatch(original,content,targetIds,{idMap});
    const before=resolveScope(original,targetIds),latest=resolveScope(current,targetIds);
    if(JSON.stringify([...before.allowed].sort())!==JSON.stringify([...latest.allowed].sort()))fail('选区的子元素已变化，请重新选择并发送');
    const read=new Set([...before.allowed,...expected.changes.removed.map(c=>c.id)]);
    for(const id of [...read]) {
      let entry=before.index.cells.get(id);
      while(entry?.cell.attributes.parent){read.add(entry.cell.attributes.parent);entry=before.index.cells.get(entry.cell.attributes.parent);}
    }
    for(const id of read) {
      const a=before.index.cells.get(id),b=latest.index.cells.get(id);
      if(!a||!b||signature(a.node)!==signature(b.node))fail('目标或关联元素已被修改，请重新选择并发送');
    }
    const result=applyPatch(current,content,targetIds,{idMap});
    if(result.changes.removed.some(c=>!expected.changes.removed.some(old=>old.id===c.id)))fail('删除会影响新加入的关联元素，请重新选择并发送');
    return result;
  }
  function summary(changes) {
    const parts=[];
    for(const [key,verb] of [['updated','修改'],['added','新增'],['removed','删除']]) {
      const nodes=changes[key].filter(c=>c.kind==='node').length,edges=changes[key].filter(c=>c.kind==='edge').length;
      if(nodes)parts.push(`${verb} ${nodes} 个节点`);if(edges)parts.push(`${verb} ${edges} 条连线`);
    }
    return parts.length?parts.join('，'):'没有需要应用的变更';
  }
  return {EditError,indexModel,resolveScope,minimizeTargets,parsePatch,applyPatch,verifyCandidate,rebase,diff,summary};
});
