const test=require('node:test'),assert=require('node:assert/strict');
const {render}=require('../../public/chat-markdown');
test('截图中的行内公式、多个不等式与中文列表正常渲染',()=>{
 const html=render(String.raw`按形状选取 **9 个圆形、12 个五角星**，共 21 个：

- 五角星苹果味和西瓜味只有 \(7+4=11\) 个。
- 桃子味和西瓜味只有 \(6+4=10\) 个。

按圆形数量 \(r\) 分情况：\(3\le r\le8\)、\(9\le r\le15\)、\(16\le r\le17\)、\(18\le r\le20\)。`);
 assert.equal((html.match(/class="chat-math-inline"/g)||[]).length,7);assert.equal((html.match(/class="katex"/g)||[]).length,7);assert.match(html,/≤/);assert.match(html,/<strong>9 个圆形、12 个五角星<\/strong>/);assert.match(html,/<ul><li>/);assert.doesNotMatch(html,/chat-math-fallback/);
});
test('独立公式跨行保留分数、上下标及aligned结构，美元公式也支持',()=>{
 const html=render(String.raw`行内 $x^2+1$，以及
\[
\begin{aligned}
f(x)&=\frac{1}{2}x^2\\
g(x)&=\sum_{i=1}^{n}i
\end{aligned}
\]

$$\sqrt{x+y}$$`);
 assert.equal((html.match(/class="katex"/g)||[]).length,3);assert.equal((html.match(/class="chat-math-display"/g)||[]).length,2);assert.doesNotMatch(html,/chat-math-fallback/);assert.match(html,/frac/);
});
test('Markdown不会把公式的乘号、比较符或换行当成格式，粗体公式仍有效',()=>{
 const html=render(String.raw`**\(a*b*c<d\)** 与 \(a
+b\)`);assert.equal((html.match(/class="katex"/g)||[]).length,2);assert.doesNotMatch(html,/<em>/);assert.match(html,/<strong><span class="chat-math-inline">/);
});
test('代码块及单个或多个反引号包围的代码保持原样，不渲染公式或链接',()=>{
 const source='`\\(x\\)` 和 ``$y$``\n\n```tex\n\\[a+b\\]\n[x](https://example.com)\n```';const html=render(source);
 assert.doesNotMatch(html,/class="katex"|<a /);assert.match(html,/<code>\\\(x\\\)<\/code>/);assert.match(html,/<code>\$y\$<\/code>/);assert.match(html,/<pre><code>\\\[a\+b\\\]/);
});
test('价格、转义美元与未完成的流式公式不被误改，补全后正常显示',()=>{
 const html=render(String.raw`价格 $5 和 $10，另有 \$20。未完成 \(x^2`);assert.doesNotMatch(html,/class="katex"/);assert.match(html,/价格 \$5 和 \$10/);assert.match(html,/\\\(x\^2/);
 assert.match(render(String.raw`补全 \(x^2\)`),/class="katex"/);
 assert.doesNotMatch(render(String.raw`转义 \\(x\\)`),/class="katex"/);
});
test('不受信任的HTML和TeX命令不能生成活动元素，链接属性不会插入公式HTML',()=>{
 for(const source of ['<img src=x onerror=alert(1)>',String.raw`\(\href{javascript:alert(1)}{x}\)`,String.raw`\(\htmlStyle{position:fixed}{x}\)`,String.raw`[链接](https://example.com/\(x\))`]){
  const html=render(source);assert.doesNotMatch(html,/<img|<script|href="javascript:|style="[^"]*position\s*:\s*fixed|href="[^">]*<span/);
 }
 const link=render('[正常](https://example.com/?a=1&b=2)');assert.match(link,/rel="noopener noreferrer"/);assert.match(link,/a=1&amp;b=2/);
});
test('无效公式回退为原文，递归宏有界且不会污染下一条回复',()=>{
 assert.match(render(String.raw`\(\notARealCommand{x}\)`),/chat-math-fallback/);
 assert.match(render(String.raw`\(\def\a{\a}\a\)`),/chat-math-fallback/);
 render(String.raw`\(\gdef\myLocalOnly{z}\myLocalOnly\)`);assert.match(render(String.raw`\(\myLocalOnly\)`),/chat-math-fallback/);
 assert.match(render('普通 **粗体** 与 *斜体*'),/<strong>粗体<\/strong> 与 <em>斜体<\/em>/);
});
