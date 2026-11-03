#!/usr/bin/env node
import readline from 'node:readline';
import { loadConfig } from './config.mjs';
import { createLogger } from './util.mjs';
import { searchHistory, archiveStats } from './archive.mjs';
import path from 'node:path';

/**
 * MCP stdio server：把控制台 HTTP API 包成 MCP 工具，
 * 让 DSH（或任意支持 MCP 的客户端）直接「操控 QQ」。
 *
 * 用法（在 MCP 客户端配置里）：
 *   command: node
 *   args: ["/path/to/snowluma-qq/src/mcp.mjs", "--config", "/path/to/config.json"]
 */

const log = createLogger('mcp', process.env.QQ_LOG_LEVEL || 'warn');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--config') out.configPath = argv[++i];
  }
  return out;
}

const cfg = loadConfig(parseArgs(process.argv.slice(2)));
const dataDir = () => path.resolve(cfg.storage.dataDir || 'data');
const controlBase = `http://${cfg.control.host}:${cfg.control.port}`;

async function api(path, { method = 'GET', body } = {}) {
  const url = `${controlBase}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(cfg.control.token || '')}`;
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    throw new Error(json.error || `控制台返回 HTTP ${res.status}`);
  }
  return json;
}

import { TOOLS, makeCallTool } from './tools.mjs';

async function raw(action, params = {}) {
  const r = await api('/api/raw', { method: 'POST', body: { action, params } });
  return r.data;
}

const callTool = makeCallTool({ api, raw, dataDir });

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', async (line) => {
  const raw = line.trim();
  if (!raw) return;
  let req;
  try {
    req = JSON.parse(raw);
  } catch {
    log.warn('收到非 JSON 行，忽略');
    return;
  }
  const { id, method, params } = req;

  // 通知类消息没有 id，不需要回复
  if (id === undefined || id === null) return;

  try {
    switch (method) {
      case 'initialize': {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: params?.protocolVersion || '2024-11-05',
            capabilities: { tools: { listChanged: false }, resources: {}, prompts: {} },
            serverInfo: { name: 'snowluma-qq', version: '0.1.0' },
            instructions:
              '这些工具用来操控一个接了 SnowLuma 的 QQ 账号：查状态、看群、读聊天记录、发消息、@人、开关自动聊天、改人设，以及 direct 调用任意 OneBot 动作。发消息前先确认 scope（group:群号 / private:QQ号）。',
          },
        });
        break;
      }
      case 'ping':
        send({ jsonrpc: '2.0', id, result: {} });
        break;
      case 'tools/list':
        send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
        break;
      case 'tools/call': {
        const name = params?.name;
        const args = params?.arguments || {};
        try {
          const result = await callTool(name, args);
          send({ jsonrpc: '2.0', id, result });
        } catch (err) {
          send({ jsonrpc: '2.0', id, result: textResult(`调用 ${name} 失败：${err.message}`, true) });
        }
        break;
      }
      case 'resources/list':
        send({ jsonrpc: '2.0', id, result: { resources: [] } });
        break;
      case 'prompts/list':
        send({ jsonrpc: '2.0', id, result: { prompts: [] } });
        break;
      default:
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `不支持的方法：${method}` } });
    }
  } catch (err) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: err.message } });
  }
});

rl.on('close', () => process.exit(0));
