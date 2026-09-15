#!/usr/bin/env node
/* 最小的模型适配器：把一个 OpenAI 兼容的 chat/completions 调用变成标准输入输出。
 *
 * Atlas 服务端不内置 HTTP 客户端，也不私自读取任何凭据：它把配置好的
 * base_url / model / api_key 与已经拼好的提示词从 stdin 交给这个进程，本进程
 * 只做一件事——发一次请求，把回答写到 stdout。取消就是杀进程。
 *
 * 输入（stdin，JSON）：
 *   { base_url, model, api_key, prompt, timeout_ms }
 * 输出（stdout，JSON）：
 *   成功 { ok: true, text, model, usage }
 *   失败 { ok: false, error, detail }
 *
 * 无第三方依赖：只用 Node 自带的 fetch。
 */
import { readFileSync } from 'node:fs';

async function main() {
  let input = '';
  try {
    input = readFileSync(0, 'utf8');
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'stdin_unreadable', detail: String(e && e.message) }));
    return;
  }
  let request;
  try {
    request = JSON.parse(input);
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'stdin_not_json', detail: String(e && e.message) }));
    return;
  }
  const baseUrl = String(request.base_url || '').replace(/\/+$/, '');
  const model = String(request.model || '');
  if (!baseUrl) { process.stdout.write(JSON.stringify({ ok: false, error: 'base_url_required' })); return; }
  if (!model) { process.stdout.write(JSON.stringify({ ok: false, error: 'model_required' })); return; }
  if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'base_url_must_be_http', detail: baseUrl }));
    return;
  }
  const timeout = Math.min(Math.max(Number(request.timeout_ms) || 60000, 1000), 300000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(request.api_key ? { Authorization: `Bearer ${request.api_key}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: String(request.prompt || '') }],
        temperature: 0.2,
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      process.stdout.write(JSON.stringify({ ok: false, error: `http_${response.status}`, detail: text.slice(0, 2000) }));
      return;
    }
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
    const choice = parsed && Array.isArray(parsed.choices) ? parsed.choices[0] : null;
    const content = choice && choice.message && typeof choice.message.content === 'string'
      ? choice.message.content
      : (parsed && typeof parsed.content === 'string' ? parsed.content : null);
    if (content === null) {
      process.stdout.write(JSON.stringify({ ok: false, error: 'response_has_no_content', detail: text.slice(0, 2000) }));
      return;
    }
    process.stdout.write(JSON.stringify({ ok: true, text: content, model: parsed && parsed.model ? parsed.model : model, usage: parsed && parsed.usage ? parsed.usage : null }));
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || String(e.message || '').includes('aborted'));
    process.stdout.write(JSON.stringify({ ok: false, error: aborted ? 'timeout' : 'request_failed', detail: String((e && e.message) || e) }));
  } finally {
    clearTimeout(timer);
  }
}

main();
