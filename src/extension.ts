import * as fs from 'node:fs';
import * as vscode from 'vscode';
import {
  ConversationFinder,
  WorkspaceFolderRef,
  getAnnotationsDir,
  getBrainDir,
} from './conversationFinder.js';
import { TranscriptTailer } from './transcriptTailer.js';

const FALLBACK_SCAN_MS = 4000;
const EVENT_DEBOUNCE_MS = 150;
const STALE_RUNNING_MS = 2 * 60 * 1000;

let statusBarItem: vscode.StatusBarItem;
let log: vscode.OutputChannel;
let finder: ConversationFinder;
let currentTailer: TranscriptTailer | null = null;
let currentConvId: string | null = null;
let scanTimer: NodeJS.Timeout | null = null;
let debounceTimer: NodeJS.Timeout | null = null;
let watchers: fs.FSWatcher[] = [];
let scanning = false;
let scanQueued = false;
let disposed = false;

interface SessionMetrics {
  activeContextTokens: number;
  freshInputTokens: number;
  cacheReadTokens: number;
  lastOutputTokens: number;
  stepIndex: number;
  isRunning: boolean;
}

function emptyMetrics(): SessionMetrics {
  return {
    activeContextTokens: 0,
    freshInputTokens: 0,
    cacheReadTokens: 0,
    lastOutputTokens: 0,
    stepIndex: 0,
    isRunning: false,
  };
}

let metrics: SessionMetrics = emptyMetrics();

function formatTokens(count: number): string {
  if (count >= 1_000_000) return (count / 1_000_000).toFixed(1) + 'M';
  if (count >= 1_000) return (count / 1_000).toFixed(1) + 'k';
  return String(count);
}

function updateStatusBar(): void {
  if (!statusBarItem) return;

  if (!currentConvId) {
    statusBarItem.text = '$(pulse) AGY: no session';
    statusBarItem.tooltip = 'Antigravity Context Monitor: waiting for a chat in this workspace';
    return;
  }

  const tokStr = formatTokens(metrics.activeContextTokens);
  const total = metrics.activeContextTokens;
  const cachePct = total > 0 ? Math.round((metrics.cacheReadTokens / total) * 100) : 0;
  const icon = metrics.isRunning ? '$(sync~spin)' : '$(pulse)';

  statusBarItem.text = `${icon} AGY: ${tokStr} tok (${cachePct}% cached)`;

  const tooltip = new vscode.MarkdownString('', true);
  tooltip.isTrusted = {
    enabledCommands: ['antigravityMonitor.refresh', 'antigravityMonitor.openTranscript'],
  };

  const shortId = currentConvId.slice(0, 8);
  tooltip.appendMarkdown(`### Antigravity Context Monitor\n\n`);
  tooltip.appendMarkdown(`- **Active Context**: **${metrics.activeContextTokens.toLocaleString()} tokens** (${cachePct}% cached)\n`);
  tooltip.appendMarkdown(`- **Fresh Input**: ${metrics.freshInputTokens.toLocaleString()} tokens\n`);
  tooltip.appendMarkdown(`- **Cache Read**: ${metrics.cacheReadTokens.toLocaleString()} tokens\n`);
  tooltip.appendMarkdown(`- **Last Output**: ${metrics.lastOutputTokens.toLocaleString()} tokens\n`);
  tooltip.appendMarkdown(`- **Step**: #${metrics.stepIndex}\n`);
  tooltip.appendMarkdown(`- **State**: ${metrics.isRunning ? 'running' : 'idle'}\n`);
  tooltip.appendMarkdown(`- **Session**: \`${shortId}...\`\n\n`);
  tooltip.appendMarkdown(`---\n[Refresh](command:antigravityMonitor.refresh) | [Open Transcript](command:antigravityMonitor.openTranscript)`);

  statusBarItem.tooltip = tooltip;
}

function handleEntry(entry: any): void {
  if (!entry || typeof entry !== 'object') return;

  if (entry.type === 'USER_INPUT') {
    metrics.isRunning = true;
  } else if (entry.type === 'PLANNER_RESPONSE') {
    const inTokens = Number(entry.input_tokens) || 0;
    const cacheTokens = Number(entry.cache_read_tokens) || 0;
    const outTokens = Number(entry.output_tokens) || 0;

    if (inTokens + cacheTokens > 0) {
      metrics.activeContextTokens = inTokens + cacheTokens;
      metrics.freshInputTokens = inTokens;
      metrics.cacheReadTokens = cacheTokens;
      metrics.lastOutputTokens = outTokens;
    }
    metrics.stepIndex = Number(entry.step_index) || metrics.stepIndex + 1;
    // A response with tool calls means the agent keeps working; without them it is the final answer.
    metrics.isRunning = Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0;
  } else {
    return;
  }
  updateStatusBar();
}

function detachTailer(): void {
  if (currentTailer) {
    currentTailer.dispose();
    currentTailer = null;
  }
}

async function attachToConversation(convId: string, transcriptPath: string): Promise<void> {
  detachTailer();
  currentConvId = convId;
  metrics = emptyMetrics();
  updateStatusBar();
  log.appendLine(`${new Date().toISOString()} attach ${convId}`);

  const tailer = new TranscriptTailer(transcriptPath);
  currentTailer = tailer;
  tailer.on('entry', (e) => {
    if (currentTailer === tailer) handleEntry(e);
  });
  tailer.on('reset', () => {
    if (currentTailer !== tailer) return;
    metrics = emptyMetrics();
    updateStatusBar();
  });
  tailer.on('error', () => {});

  await tailer.start();
  if (currentTailer !== tailer) return;

  // An old chat that was cancelled mid-run must not spin forever.
  try {
    const st = await fs.promises.stat(transcriptPath);
    if (Date.now() - st.mtimeMs > STALE_RUNNING_MS) metrics.isRunning = false;
  } catch {}
  updateStatusBar();
}

function getWorkspaceFolders(): WorkspaceFolderRef[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => ({
    fsPath: f.uri.fsPath,
    uris: [f.uri.toString(), f.uri.toString(true)],
  }));
}

/** Serialized: never runs twice at once, but a request during a scan triggers one more pass. */
async function scan(): Promise<void> {
  if (disposed) return;
  if (scanning) {
    scanQueued = true;
    return;
  }
  scanning = true;
  try {
    do {
      scanQueued = false;
      const active = await finder.findActive();
      if (disposed) return;
      if (active) {
        if (active.conversationId !== currentConvId || !currentTailer) {
          await attachToConversation(active.conversationId, active.transcriptPath);
        }
      } else if (currentConvId === null) {
        updateStatusBar();
      }
    } while (scanQueued && !disposed);
  } catch (err) {
    log.appendLine(`${new Date().toISOString()} scan error: ${String(err)}`);
  } finally {
    scanning = false;
  }
}

function scheduleScan(): void {
  if (disposed) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    scan().catch(() => {});
  }, EVENT_DEBOUNCE_MS);
}

function tryWatch(target: string, recursive: boolean, onEvent: (filename: string) => void): boolean {
  try {
    const w = fs.watch(target, { recursive, persistent: false }, (_evt, filename) => {
      onEvent(filename ? String(filename) : '');
    });
    w.on('error', () => {
      try { w.close(); } catch {}
      watchers = watchers.filter((x) => x !== w);
    });
    watchers.push(w);
    return true;
  } catch {
    return false;
  }
}

function startWatchers(): void {
  for (const w of watchers) {
    try { w.close(); } catch {}
  }
  watchers = [];

  // Viewing a chat rewrites annotations/<id>.pbtxt: instant switch detection.
  tryWatch(getAnnotationsDir(), false, () => scheduleScan());

  // A new chat creates brain/<id>/.../transcript.jsonl. Only creation matters here; writes to
  // the current transcript are handled by the tailer, and writes to background chats are ignored.
  const onBrain = (filename: string) => {
    const f = filename.replace(/\\/g, '/');
    if (!f || !f.includes('/') || f.endsWith('transcript.jsonl')) {
      if (currentConvId && f.startsWith(currentConvId + '/')) return;
      scheduleScan();
    }
  };
  if (!tryWatch(getBrainDir(), true, onBrain)) {
    tryWatch(getBrainDir(), false, onBrain);
  }
}

export async function activate(context: vscode.ExtensionContext) {
  disposed = false;
  log = vscode.window.createOutputChannel('Antigravity Context Monitor');
  context.subscriptions.push(log);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'antigravityMonitor.refresh';
  statusBarItem.text = '$(pulse) AGY: starting';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  finder = new ConversationFinder(getWorkspaceFolders());

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityMonitor.refresh', async () => {
      finder.clearCaches();
      detachTailer();
      currentConvId = null;
      startWatchers();
      await scan();
      updateStatusBar();
    }),
    vscode.commands.registerCommand('antigravityMonitor.openTranscript', async () => {
      if (currentTailer?.filePath) {
        const doc = await vscode.workspace.openTextDocument(currentTailer.filePath);
        await vscode.window.showTextDocument(doc);
      } else {
        vscode.window.showInformationMessage('No active transcript to open.');
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      finder.setWorkspaceFolders(getWorkspaceFolders());
      currentConvId = null;
      detachTailer();
      scheduleScan();
    }),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) scheduleScan();
    })
  );

  startWatchers();
  await scan();

  // Safety net: watchers can miss events (network drives, sleep/resume, dirs created later).
  scanTimer = setInterval(() => {
    if (watchers.length < 2) startWatchers();
    scan().catch(() => {});
  }, FALLBACK_SCAN_MS);
}

export function deactivate() {
  disposed = true;
  if (scanTimer) clearInterval(scanTimer);
  if (debounceTimer) clearTimeout(debounceTimer);
  for (const w of watchers) {
    try { w.close(); } catch {}
  }
  watchers = [];
  detachTailer();
  if (statusBarItem) statusBarItem.dispose();
}
