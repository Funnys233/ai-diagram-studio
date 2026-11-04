// 出站 HTTP(S) JSON 传输：超时、企业代理自签名证书 CA 兜底
// 从 server.js 原样抽出（含 buildCaBundle / httpsPost / isCertError 语义），
// 额外支持 http: 协议（仅限本机地址，由 provider-store 的 baseUrl 校验保证）。
const http = require('http');
const https = require('https');
const fs = require('fs');
const { execSync } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { createParser } = require('./sse');

let caBundleCache; // undefined=未尝试, null=不可用, Buffer=可用

function buildCaBundle() {
  if (caBundleCache !== undefined) return caBundleCache;
  caBundleCache = null;
  try {
    if (process.platform === 'darwin') {
      const parts = [];
      if (fs.existsSync('/etc/ssl/cert.pem')) parts.push(fs.readFileSync('/etc/ssl/cert.pem', 'utf8'));
      for (const kc of ['/Library/Keychains/System.keychain', `${process.env.HOME}/Library/Keychains/login.keychain-db`]) {
        try { parts.push(execSync(`security find-certificate -a -p "${kc}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch { /* 忽略 */ }
      }
      const bundle = parts.join('\n');
      if ((bundle.match(/BEGIN CERTIFICATE/g) || []).length > 0) caBundleCache = Buffer.from(bundle);
    }
  } catch { caBundleCache = null; }
  return caBundleCache;
}

function isCertError(e) {
  const code = e && (e.code || (e.cause && e.cause.code));
  return ['SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT'].includes(code);
}

/** POST JSON，返回 { status, data }；data 尽力解析为 JSON（非 JSON 时为 null） */
function postJson(urlStr, headers, payload, timeoutMs, ca, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const isHttps = u.protocol === 'https:';
    const body = Buffer.from(JSON.stringify(payload));
    const req = (isHttps ? https : http).request({
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: { ...headers, 'Content-Length': body.length },
      timeout: timeoutMs,
      signal: options.signal,
      ...(isHttps && ca ? { ca } : {}),
      ...(options.connection || {}),
    }, (res) => {
      const chunks = [];
      let bytes = 0;
      // Some subscription responses contain valid SSE but omit Content-Type.
      // Only a caller whose endpoint contract requires SSE may opt in; the
      // model parser still has to observe its terminal completion event.
      const streaming = res.statusCode === 200 && options.onEvent
        && (options.expectSse === true || /text\/event-stream/i.test(res.headers['content-type'] || ''));
      const decoder = new StringDecoder('utf8');
      let complete = false;
      const parser = streaming ? createParser(event => {
        if (complete) return;
        options.onEvent(event);
        complete = options.isComplete?.() === true;
      }) : null;
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('模型响应连接中断')));
      res.on('data', (c) => {
        try {
          bytes += c.length;
          if (bytes > (options.maxBytes || 4194304)) throw new Error('模型响应超过大小限制');
          if (parser) {
            parser.push(decoder.write(c));
            // SSE completion is explicit. Some relays continue sending pings
            // after [DONE]/message_stop/response.completed without closing HTTP.
            if (complete) {
              resolve({ status: res.statusCode, streaming: true });
              res.destroy(); req.destroy();
            }
          }
          else chunks.push(c);
        } catch (e) { reject(e); req.destroy(e); res.destroy(); }
      });
      res.on('end', () => {
        try {
          if (parser) {
            parser.push(decoder.end());
            resolve({ status: res.statusCode, streaming: true });
          } else {
            const text = Buffer.concat(chunks).toString('utf8');
            let data = null;
            try { data = text ? JSON.parse(text) : null; } catch { /* protocol validator reports it */ }
            resolve({ status: res.statusCode, data, text });
          }
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）`)); });
    req.on('error', reject);
    req.end(body);
  });
}

/** 带 CA 兜底的 POST；网络层错误统一抛给上层映射为可读错误（绝不关闭 TLS 校验） */
async function postJsonWithCaFallback(urlStr, headers, payload, timeoutMs, options = {}) {
  try {
    return await postJson(urlStr, headers, payload, timeoutMs, undefined, options);
  } catch (e) {
    if (!options.signal?.aborted && isCertError(e)) {
      const ca = buildCaBundle();
      if (ca) return postJson(urlStr, headers, payload, timeoutMs, ca, options);
    }
    throw e;
  }
}

/** GET JSON（获取模型列表用） */
function getJson(urlStr, headers, timeoutMs, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const isHttps = u.protocol === 'https:';
    const req = (isHttps ? https : http).request({
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: { ...headers },
      timeout: timeoutMs,
      signal:options.signal,
      ...(options.connection||{}),
    }, (res) => {
      const chunks = [];let bytes=0;
      res.on('error',reject);res.on('aborted',()=>reject(new Error('模型列表连接中断')));
      res.on('data', (c) => {bytes+=c.length;if(bytes>4194304){const e=new Error('模型列表超过大小限制');reject(e);req.destroy(e);res.destroy();}else chunks.push(c);});
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }
        resolve({ status: res.statusCode, data, text });
      });
    });
    req.on('timeout', () => { req.destroy(new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）`)); });
    req.on('error', reject);
    req.end();
  });
}

module.exports = { postJson, postJsonWithCaFallback, getJson, buildCaBundle, isCertError };
