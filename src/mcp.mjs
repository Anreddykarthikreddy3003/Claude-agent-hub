/** Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0), no dependencies. */
import readline from 'node:readline';
import { statusText, weekText, bestText } from './report.mjs';
import { switchTo } from './switcher.mjs';
import { rankViews } from './engine.mjs';
import { snapshot, refreshUsage } from './collector.mjs';
import { saveConfig } from './store.mjs';

const TOOLS = [
  {
    name: 'account_status',
    description: 'Show every Claude account with 5-hour and weekly usage, reset times, and which account is active.',
    inputSchema: { type: 'object', properties: { refresh: { type: 'boolean', description: 'Fetch live usage first' } } },
  },
  {
    name: 'best_account',
    description: 'Rank usable Claude accounts best-first (weekly urgency, then soonest 5h reset).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'switch_account',
    description: 'Switch Claude Code to a named account, or to the best available one if no name is given.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
  },
  {
    name: 'weekly_plan',
    description: 'Weekly-limit plan: what is left per account, when it resets, and whether any will be wasted.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'codex_ask',
    description:
      'Start a NEW conversation with OpenAI Codex (a separate AI agent) and get its reply. Use when the user wants Codex involved (debate, review, testing, building, second opinion). Returns Codex\'s answer, commands it ran, files it changed, and a thread id for codex_continue. Pass the user\'s rules for Codex verbatim inside prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Full instructions for Codex: its role, the task, the user\'s rules, and the context it needs.' },
        cwd: { type: 'string', description: 'Absolute path of the project folder Codex works in (use the current project).' },
        sandbox: {
          type: 'string',
          enum: ['read-only', 'workspace-write', 'danger-full-access'],
          description: 'read-only = discuss/review only (default). workspace-write = may edit files and run commands inside cwd. danger-full-access = no sandbox: only if the user explicitly allowed it.',
        },
        label: { type: 'string', description: 'Name for Codex in the transcript, e.g. "Codex (critic)".' },
        model: { type: 'string', description: 'Optional Codex model override.' },
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh'], description: 'Optional reasoning effort.' },
      },
      required: ['prompt', 'cwd'],
    },
  },
  {
    name: 'codex_continue',
    description: 'Send the next message in an existing Codex conversation (Codex remembers everything said in that thread). Use for debate rounds, follow-up questions, or "re-test after the fix".',
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string', description: 'Thread id returned by codex_ask.' },
        prompt: { type: 'string', description: 'The next message to Codex.' },
        cwd: { type: 'string', description: 'Same project folder as the original call.' },
        sandbox: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'] },
        label: { type: 'string' },
      },
      required: ['thread_id', 'prompt', 'cwd'],
    },
  },
  {
    name: 'agent_start',
    description:
      'Start a live helper agent in the Agent Hub (visible to the user in the IDE dashboard) and give it its first task. Platforms: claude, codex, hermes, kimi, opencode, agy. Returns a compact summary when the turn ends (or after wait_seconds). Use for debates, reviews, build/test loops, second opinions. Pass the user\'s rules verbatim in task.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short unique name, e.g. "critic", "tester".' },
        platform: { type: 'string', enum: ['claude', 'codex', 'hermes', 'kimi', 'opencode', 'agy'] },
        task: { type: 'string', description: 'First message: the task, scope, the user\'s rules, and "write long findings to a file and give the path".' },
        role: { type: 'string', description: 'One line, e.g. "skeptical reviewer". Shown on the dashboard and prefixed to the task.' },
        cwd: { type: 'string', description: 'Absolute project path.' },
        permission: { type: 'string', enum: ['read', 'edit', 'full'], description: 'read (default) = no edits; edit = may edit/run inside the project; full = no sandbox (only if the user allowed it).' },
        model: { type: 'string', description: 'Only if the user asked for a specific model. Codex defaults to gpt-6.1-sol. An unknown model returns the list to show the user.' },
        effort: { type: 'string', description: 'Optional reasoning effort (Codex).' },
        parent: { type: 'string', description: 'Name of the agent that this one reports to, for the Agent Map.' },
        wait_seconds: { type: 'number', description: 'Max seconds to wait for the turn to finish (default 900, 0 = don\'t wait).' },
      },
      required: ['name', 'platform', 'task', 'cwd'],
    },
  },
  {
    name: 'agent_send',
    description: 'Send the next message to a live hub agent (it keeps its own session/context). from = who is speaking, e.g. "master" or another agent\'s name, so the Agent Map shows who talks to whom. Returns a compact summary of its reply.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string' },
        text: { type: 'string' },
        from: { type: 'string', description: 'Default "master".' },
        wait_seconds: { type: 'number' },
      },
      required: ['agent', 'text'],
    },
  },
  {
    name: 'agent_read',
    description: 'Read an agent\'s current state and latest reply (compact). detail=true adds the last tool calls/errors. Never returns the whole transcript; it gives the file path instead.',
    inputSchema: { type: 'object', properties: { agent: { type: 'string' }, detail: { type: 'boolean' } }, required: ['agent'] },
  },
  { name: 'agent_list', description: 'List hub agents with status, platform, model, tokens.', inputSchema: { type: 'object', properties: {} } },
  { name: 'agent_stop', description: 'Stop an agent\'s current turn and clear its queue.', inputSchema: { type: 'object', properties: { agent: { type: 'string' } }, required: ['agent'] } },
  { name: 'agent_retry', description: 'Retry an agent\'s last message (after a login/model fix or an error).', inputSchema: { type: 'object', properties: { agent: { type: 'string' } }, required: ['agent'] } },
  {
    name: 'agent_set_model',
    description: 'Change an agent\'s model. If the model does not exist, returns the table of available models to show the user.',
    inputSchema: { type: 'object', properties: { agent: { type: 'string' }, model: { type: 'string' } }, required: ['agent', 'model'] },
  },
  {
    name: 'models_list',
    description: 'Table of models available for a platform (codex, opencode, agy publish lists).',
    inputSchema: { type: 'object', properties: { platform: { type: 'string' } }, required: ['platform'] },
  },
  {
    name: 'set_priming',
    description: 'Turn 24/7 automatic session priming on or off.',
    inputSchema: { type: 'object', properties: { on: { type: 'boolean' } }, required: ['on'] },
  },
];

async function callTool(name, args = {}) {
  switch (name) {
    case 'account_status':
      if (args.refresh) await refreshUsage();
      return statusText();
    case 'best_account':
      await refreshUsage({ maxAgeMs: 60e3 });
      return bestText();
    case 'switch_account': {
      let target = args.name;
      if (!target) {
        await refreshUsage({ maxAgeMs: 60e3 });
        const { st, views } = snapshot();
        target = rankViews(views.filter((v) => v.name !== st.active))[0]?.name;
        if (!target) return 'No other account is usable right now.';
      }
      const r = await switchTo(target, 'requested via MCP');
      return r.changed ? `Switched ${r.from ?? '?'} → ${r.to}. New chats use ${r.to}.` : `Already on ${r.to}.`;
    }
    case 'weekly_plan':
      await refreshUsage({ maxAgeMs: 5 * 60e3 });
      return weekText();
    case 'codex_ask':
    case 'codex_continue': {
      const { runCodex, logExchange, formatResult } = await import('./codex.mjs');
      const r = await runCodex({
        prompt: args.prompt,
        threadId: name === 'codex_continue' ? args.thread_id : null,
        sandbox: args.sandbox || 'read-only',
        cwd: args.cwd || process.cwd(),
        model: args.model || null,
        effort: args.effort || null,
      });
      const log = logExchange(r, args.prompt, args.label || 'Codex');
      return formatResult(r, log);
    }
    case 'agent_start':
    case 'agent_send':
    case 'agent_read':
    case 'agent_list':
    case 'agent_stop':
    case 'agent_retry':
    case 'agent_set_model':
    case 'models_list':
      return hubTool(name, args);
    case 'set_priming':
      saveConfig({ ready: !!args.on });
      return `24/7 priming is now ${args.on ? 'ON' : 'OFF'}.`;
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Agent Hub tools: compact results (context engineering: never dump raw streams) ──
const clipText = (s, n) => (s && s.length > n ? `${s.slice(0, n)}\n…[${s.length - n} more chars in the transcript]` : s || '');

async function summarize(nameOrId, { detail = false } = {}) {
  const { hub } = await import('./hub/client.mjs');
  const a = await hub('GET', `/api/agents/${encodeURIComponent(nameOrId)}`);
  const ev = await hub('GET', `/api/agents/${encodeURIComponent(a.id)}/events?limit=400`);
  const lastUser = ev.map((e) => e.kind).lastIndexOf('user');
  const turn = ev.slice(lastUser + 1);
  const tools = turn.filter((e) => e.kind === 'tool');
  const failed = tools.filter((e) => e.ok === false);
  const files = [...new Set(turn.filter((e) => e.kind === 'file').map((e) => e.text))];
  const reply = [...turn].reverse().find((e) => e.kind === 'assistant')?.text || '';
  const t = a.tokens || {};
  const lines = [
    `[${a.name} · ${a.platform}${a.model ? ' ' + a.model : ''} · ${a.status}${a.statusDetail && a.statusDetail !== a.status ? ` (${a.statusDetail.split('\n')[0]})` : ''}${a.queue ? ` · ${a.queue} queued` : ''} · ${t.turns || 0} turns · tokens in ${t.input || 0} / out ${t.output || 0}${t.cached ? ` / cached ${t.cached}` : ''}]`,
  ];
  if (tools.length || files.length) lines.push(`This turn: ${tools.length} tool calls${failed.length ? ` (${failed.length} exited non-zero; may be expected)` : ''}${files.length ? `; files changed: ${files.slice(0, 15).join(', ')}` : ''}`);
  if (detail) {
    for (const e of turn.filter((x) => x.kind === 'tool' || x.kind === 'error' || x.kind === 'system').slice(-15))
      lines.push(`  • ${e.kind === 'tool' ? `${e.name}: ${e.text}${e.ok === false ? ` → failed${e.detail ? `\n${clipText(e.detail, 600)}` : ''}` : ''}` : `${e.kind}: ${clipText(e.text, 400)}`}`);
  }
  if (a.status === 'error' || a.status === 'needs-login' || a.status === 'waiting') lines.push(`⚠ ${a.statusDetail}`);
  lines.push('--- latest reply ---', clipText(reply, 3500) || '(no reply yet)');
  lines.push(`(transcript: ${a.transcript})`);
  return lines.join('\n');
}

async function hubTool(name, args) {
  const { hub, waitForAgent } = await import('./hub/client.mjs');
  const wait = async (id) => {
    const secs = args.wait_seconds ?? 900;
    if (secs > 0) await waitForAgent(id, secs * 1000);
    return summarize(id);
  };
  try {
    switch (name) {
      case 'agent_start': {
        const r = await hub('POST', '/api/agents', { ...args, from: 'master' });
        return `Started ${r.agent.name} (${r.agent.platform}${r.agent.model ? ' ' + r.agent.model : ''}). The user can watch it in the dashboard.\n` + (await wait(r.agent.id));
      }
      case 'agent_send': {
        const r = await hub('POST', `/api/agents/${encodeURIComponent(args.agent)}/send`, { text: args.text, from: args.from || 'master' });
        return (r.queued ? `Queued (position ${r.position}); it is busy.\n` : '') + (await wait(args.agent));
      }
      case 'agent_read':
        return summarize(args.agent, { detail: !!args.detail });
      case 'agent_list': {
        const list = await hub('GET', '/api/agents');
        if (!list.length) return 'No hub agents.';
        return list.map((a) => `${a.name} · ${a.platform}${a.model ? ' ' + a.model : ''} · ${a.status}${a.queue ? ` (${a.queue} queued)` : ''} · tokens ${a.tokens?.input || 0}/${a.tokens?.output || 0}`).join('\n');
      }
      case 'agent_stop':
        await hub('POST', `/api/agents/${encodeURIComponent(args.agent)}/stop`);
        return `Stopped ${args.agent}.`;
      case 'agent_retry':
        await hub('POST', `/api/agents/${encodeURIComponent(args.agent)}/retry`);
        return wait(args.agent);
      case 'agent_set_model': {
        const r = await hub('POST', `/api/agents/${encodeURIComponent(args.agent)}/model`, { model: args.model });
        return `Model set to ${r.model}.`;
      }
      case 'models_list': {
        const { modelTable } = await import('./hub/models.mjs');
        return modelTable(args.platform);
      }
    }
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

export function runMcp() {
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const { id, method, params } = msg;
    const reply = (result) => id !== undefined && send({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => id !== undefined && send({ jsonrpc: '2.0', id, error: { code, message } });
    try {
      if (method === 'initialize')
        return reply({
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'claude-agent-hub', version: '1.0.0' },
        });
      if (method === 'ping') return reply({});
      if (method === 'tools/list') return reply({ tools: TOOLS });
      if (method === 'tools/call') {
        try {
          const text = await callTool(params?.name, params?.arguments || {});
          return reply({ content: [{ type: 'text', text }] });
        } catch (e) {
          return reply({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
        }
      }
      if (method?.startsWith('notifications/')) return;
      fail(-32601, `Method not found: ${method}`);
    } catch (e) {
      fail(-32603, e.message);
    }
  });
}
