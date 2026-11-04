(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory(require('./vendor/katex/katex.min.js'));
  else root.DiagramMarkdown=factory(root.katex);
})(typeof globalThis!=='undefined'?globalThis:this,function(katex){
  'use strict';
  const cache=new Map();
  const escapeHtml=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  function math(source,tex,display){
    const key=(display?'block:':'inline:')+source;
    if(cache.has(key))return cache.get(key);
    let html;
    try{
      if(!katex?.renderToString||tex.length>12000)throw Error('Math unavailable');
      html=katex.renderToString(tex,{displayMode:display,output:'htmlAndMathml',throwOnError:true,trust:false,strict:'ignore',maxExpand:1000,maxSize:20,macros:{}});
    }catch{html=`<span class="chat-math-fallback">${escapeHtml(source)}</span>`;}
    html=`<span class="chat-math-${display?'display':'inline'}">${html}</span>`;
    if(cache.size>=128)cache.delete(cache.keys().next().value);
    cache.set(key,html);return html;
  }
  function mathEnd(value,start,close){
    let depth=0,escapedNext=false;
    for(let i=start;i<value.length;i++){
      if(escapedNext){escapedNext=false;continue;}
      if(!depth&&value.startsWith(close,i))return i;
      if(value[i]==='\\')escapedNext=true;
      else if(value[i]==='{')depth++;
      else if(value[i]==='}')depth=Math.max(0,depth-1);
    }
    return -1;
  }
  function render(value){
    value=String(value).replace(/\r\n?/g,'\n');
    let prefix='\uE000math:';while(value.includes(prefix))prefix+=':';
    const tokens=[];
    const token=html=>{const key=prefix+tokens.length+'\uE001';tokens.push({key,html});return key;};
    function protect(text){
      let result='',escapedNext=false;
      for(let i=0;i<text.length;){
        if(escapedNext){result+=text[i++];escapedNext=false;continue;}
        if(text[i]==='`'){
          const marker=/^`+/.exec(text.slice(i))[0];let end=text.indexOf(marker,i+marker.length);
          while(end!==-1&&(text[end-1]==='`'||text[end+marker.length]==='`'))end=text.indexOf(marker,end+marker.length);
          if(end!==-1){result+=token(`<code>${escapeHtml(text.slice(i+marker.length,end))}</code>`);i=end+marker.length;continue;}
        }
        const open=text.startsWith('\\[',i)?'\\[':text.startsWith('\\(',i)?'\\(':text.startsWith('$$',i)?'$$':text[i]==='$'?'$':null;
        if(open){
          const close=open==='\\['?'\\]':open==='\\('?'\\)':open,from=i+open.length,end=mathEnd(text,from,close);
          const tex=end!==-1?text.slice(from,end):'';
          // Avoid treating prices such as "$5 and $10" as inline mathematics.
          if(end!==-1&&(open!=='$'||(tex&&!/^\s|\s$/.test(tex)&&!tex.includes('\n')&&!/\d/.test(text[end+1]||'')&&text[end+1]!=='$'))){
            result+=token(math(text.slice(i,end+close.length),tex,open==='$$'||open==='\\['));i=end+close.length;continue;
          }
        }
        if(text[i]==='\\')escapedNext=true;
        result+=text[i++];
      }
      return result;
    }
    // Protect formulae before Markdown can interpret *, links or line breaks.
    // Fenced and inline code remain literal, including their TeX delimiters.
    const protectedLines=[],buffer=[];let fenced=false;
    const flush=()=>{if(buffer.length){protectedLines.push(protect(buffer.join('\n')));buffer.length=0;}};
    for(const line of value.split('\n')){
      if(line.trim().startsWith('```')){flush();protectedLines.push(line);fenced=!fenced;}
      else if(fenced)protectedLines.push(line);
      else buffer.push(line);
    }
    flush();
    function inlineMarkdown(text){
      let html=escapeHtml(text);
      html=html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,(match,label,rawUrl)=>{
        // Never restore generated markup inside an HTML attribute.
        if(rawUrl.includes(prefix))return match;
        try{const url=new URL(rawUrl.replaceAll('&amp;','&'));if(!['http:','https:'].includes(url.protocol))return label;return `<a href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;}catch{return label;}
      });
      html=html.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
      return html.replace(/(^|[^*])\*([^*\n]+)\*/g,'$1<em>$2</em>');
    }
    const html=[];let paragraph=[],list='',code=null;
    const closeParagraph=()=>{if(paragraph.length)html.push(`<p>${paragraph.map(inlineMarkdown).join('<br>')}</p>`);paragraph=[];};
    const closeList=()=>{if(list){html.push(`</${list}>`);list='';}};
    for(const line of protectedLines.join('\n').split('\n')){
      if(line.trim().startsWith('```')){closeParagraph();closeList();if(code===null)code=[];else{html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);code=null;}continue;}
      if(code!==null){code.push(line);continue;}
      const heading=/^(#{1,3})\s+(.+)$/.exec(line),bullet=/^\s*[-*+]\s+(.+)$/.exec(line),numbered=/^\s*\d+[.)]\s+(.+)$/.exec(line);
      if(!line.trim()){closeParagraph();closeList();continue;}
      if(heading){closeParagraph();closeList();const level=heading[1].length;html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);continue;}
      if(bullet||numbered){closeParagraph();const next=bullet?'ul':'ol';if(list!==next){closeList();list=next;html.push(`<${list}>`);}html.push(`<li>${inlineMarkdown((bullet||numbered)[1])}</li>`);continue;}
      closeList();paragraph.push(line);
    }
    closeParagraph();closeList();if(code!==null)html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
    let result=html.join('');for(const item of tokens)result=result.split(item.key).join(item.html);
    return result;
  }
  return {render};
});
