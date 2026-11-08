import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Locates the Antigravity conversation the user is currently looking at.
 *
 * Signals (all plain files written by the Antigravity daemon):
 *  - annotations/<id>.pbtxt   rewritten with `last_user_view_time` whenever the user views a chat
 *                             (this is how switching to an old chat is detected).
 *  - brain/<id>/.system_generated/logs/transcript.jsonl
 *                             created on the first message of a new chat (birth time = new chat signal).
 *  - conversations/<id>.db    contains the workspace URI the chat belongs to.
 *
 * The active chat is the root (non-subagent) conversation of this workspace with the most recent
 * user signal. Transcript writes from chats running in the background do NOT steal focus.
 */

export interface ActiveConversation {
  conversationId: string;
  transcriptPath: string;
}

export interface WorkspaceFolderRef {
  fsPath: string;
  /** Exact URI strings, e.g. vscode Uri.toString() and Uri.toString(true). Derived from fsPath if omitted. */
  uris?: string[];
}

const ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;
const MAX_CANDIDATES = 60;
const DB_SCAN_LIMIT = 256 * 1024 * 1024;
const TRANSCRIPT_SNIFF_BYTES = 64 * 1024;

export function getAgyRoot(): string {
  return path.join(os.homedir(), '.gemini', 'antigravity');
}
export function getBrainDir(): string {
  return path.join(getAgyRoot(), 'brain');
}
export function getAnnotationsDir(): string {
  return path.join(getAgyRoot(), 'annotations');
}
export function getConversationsDir(): string {
  return path.join(getAgyRoot(), 'conversations');
}
export function transcriptPathFor(convId: string): string {
  return path.join(getBrainDir(), convId, '.system_generated', 'logs', 'transcript.jsonl');
}

async function statSafe(p: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(p);
  } catch {
    return null;
  }
}

async function readdirSafe(p: string): Promise<string[]> {
  try {
    return await fs.promises.readdir(p);
  } catch {
    return [];
  }
}

/** Lowercase, forward slashes, decoded drive colon. Makes paths and file URIs comparable. */
function normalizeHaystack(s: string): string {
  return s.toLowerCase().replace(/%3a/g, ':').replace(/\\+/g, '/');
}

function normalizeFolder(folder: string): string {
  return normalizeHaystack(folder).replace(/\/+$/, '');
}

/**
 * True if `needle` occurs in `hay` and is not immediately followed by another path-name character.
 * In exact mode a following '/' or '%' also disqualifies, so links to files *inside* a folder
 * (e.g. file:///c%3A/proj/src/a.ts mentioned in chat text) do not count as the workspace itself.
 */
function containsPath(hay: string, needle: string, exact: boolean): boolean {
  if (!needle) return false;
  const bad = exact ? /[a-z0-9_.\-/%]/ : /[a-z0-9_.-]/;
  let idx = hay.indexOf(needle);
  while (idx !== -1) {
    const next = hay.charAt(idx + needle.length);
    if (!bad.test(next)) return true;
    idx = hay.indexOf(needle, idx + 1);
  }
  return false;
}

/**
 * Streams a file looking for any needle.
 * exact=true: needles are lowercased workspace URIs, matched verbatim (used for conversations/<id>.db).
 * exact=false: needles are normalized folder paths, matched loosely (fallback for transcripts).
 */
async function fileContainsAny(filePath: string, needles: string[], limit: number, exact: boolean): Promise<boolean> {
  if (needles.length === 0) return false;
  let fd: fs.promises.FileHandle | null = null;
  try {
    fd = await fs.promises.open(filePath, 'r');
    const chunkSize = 1024 * 1024;
    const overlap = 1024;
    const buf = Buffer.alloc(chunkSize);
    let pos = 0;
    let carry = '';
    while (pos < limit) {
      const { bytesRead } = await fd.read(buf, 0, Math.min(chunkSize, limit - pos), pos);
      if (bytesRead <= 0) break;
      // latin1 is byte-preserving, so ASCII paths inside binary (sqlite/protobuf) stay intact.
      const raw = carry + buf.toString('latin1', 0, bytesRead);
      const hay = exact ? raw.toLowerCase() : normalizeHaystack(raw);
      for (const n of needles) {
        if (containsPath(hay, n, exact)) return true;
      }
      carry = hay.slice(-overlap);
      pos += bytesRead;
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd) await fd.close().catch(() => {});
  }
}

async function readHead(filePath: string, bytes: number): Promise<string> {
  let fd: fs.promises.FileHandle | null = null;
  try {
    fd = await fs.promises.open(filePath, 'r');
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fd.read(buf, 0, bytes, 0);
    return buf.toString('utf8', 0, bytesRead);
  } catch {
    return '';
  } finally {
    if (fd) await fd.close().catch(() => {});
  }
}

export class ConversationFinder {
  /** Positive results only; negatives are re-checked because metadata may arrive later. */
  private workspaceMatch = new Set<string>();
  private subagentIds = new Set<string>();
  private rootIds = new Set<string>();
  private needles: string[] = [];
  private uriNeedles: string[] = [];

  constructor(workspaceFolders: WorkspaceFolderRef[]) {
    this.setWorkspaceFolders(workspaceFolders);
  }

  public setWorkspaceFolders(folders: WorkspaceFolderRef[]): void {
    this.needles = folders.map((f) => normalizeFolder(f.fsPath)).filter(Boolean);
    const uris = new Set<string>();
    for (const f of folders) {
      for (const u of f.uris ?? []) {
        const v = u.toLowerCase().replace(/\/+$/, '');
        if (v) uris.add(v);
      }
      if (!f.uris || f.uris.length === 0) {
        // Derive file URIs from the path: file:///c%3a/x and file:///c:/x (Windows) or file:///x.
        const p = normalizeFolder(f.fsPath);
        const m = /^([a-z]):\/(.*)$/.exec(p);
        if (m) {
          uris.add(`file:///${m[1]}%3a/${m[2]}`);
          uris.add(`file:///${m[1]}:/${m[2]}`);
        } else if (p.startsWith('/')) {
          uris.add(`file://${p}`);
        }
      }
    }
    this.uriNeedles = [...uris];
    this.workspaceMatch.clear();
  }

  public clearCaches(): void {
    this.workspaceMatch.clear();
    this.subagentIds.clear();
    this.rootIds.clear();
  }

  public async findActive(): Promise<ActiveConversation | null> {
    const brainDir = getBrainDir();
    const annDir = getAnnotationsDir();

    const brainIds = (await readdirSafe(brainDir)).filter((n) => ID_RE.test(n));
    if (brainIds.length === 0) return null;

    const annNames = await readdirSafe(annDir);
    const hasAnnotations = annNames.length > 0;
    const viewTimes = new Map<string, number>();
    await Promise.all(
      annNames
        .filter((n) => n.endsWith('.pbtxt'))
        .map(async (n) => {
          const id = n.slice(0, -'.pbtxt'.length);
          if (!ID_RE.test(id)) return;
          const st = await statSafe(path.join(annDir, n));
          if (st) viewTimes.set(id, st.mtimeMs);
        })
    );

    const candidates: Array<{ id: string; transcriptPath: string; score: number; mtimeMs: number }> = [];
    await Promise.all(
      brainIds.map(async (id) => {
        const tp = transcriptPathFor(id);
        const st = await statSafe(tp);
        if (!st) return;
        const born = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
        // With annotations available, only user signals count (view time, chat creation).
        // Without them (older builds), fall back to latest transcript write.
        const score = hasAnnotations ? Math.max(viewTimes.get(id) ?? 0, born) : st.mtimeMs;
        candidates.push({ id, transcriptPath: tp, score, mtimeMs: st.mtimeMs });
      })
    );
    if (candidates.length === 0) return null;

    candidates.sort((a, b) => b.score - a.score || b.mtimeMs - a.mtimeMs);
    const top = candidates.slice(0, MAX_CANDIDATES);

    await this.collectSubagentIds(top.slice(0, 30).map((c) => c.id));

    for (const cand of top) {
      if (!(await this.isRoot(cand.id, cand.transcriptPath))) continue;
      if (!(await this.belongsToWorkspace(cand.id, cand.transcriptPath))) continue;
      return { conversationId: cand.id, transcriptPath: cand.transcriptPath };
    }
    return null;
  }

  /** Parents list their children in brain/<parent>/.system_generated/subagents/<child>.json */
  private async collectSubagentIds(parentIds: string[]): Promise<void> {
    await Promise.all(
      parentIds.map(async (pid) => {
        const names = await readdirSafe(path.join(getBrainDir(), pid, '.system_generated', 'subagents'));
        for (const n of names) {
          if (n.endsWith('.json')) this.subagentIds.add(n.slice(0, -'.json'.length));
        }
      })
    );
  }

  private async isRoot(id: string, transcriptPath: string): Promise<boolean> {
    if (this.subagentIds.has(id)) return false;
    if (this.rootIds.has(id)) return true;
    const head = await readHead(transcriptPath, 4096);
    if (!head) return false;
    const firstLine = head.split(/\r?\n/)[0] || '';
    if (firstLine.includes('"source":"SYSTEM"') && firstLine.includes('sender=')) {
      this.subagentIds.add(id);
      return false;
    }
    if (firstLine.endsWith('}')) this.rootIds.add(id);
    return true;
  }

  private async belongsToWorkspace(id: string, transcriptPath: string): Promise<boolean> {
    if (this.needles.length === 0) return true; // no folder open: follow any chat
    if (this.workspaceMatch.has(id)) return true;

    const dbPath = path.join(getConversationsDir(), `${id}.db`);
    if (await statSafe(dbPath)) {
      // The db stores the chat's workspace URI verbatim; this is the authoritative check.
      // No loose fallback here: a chat that merely mentions this folder must not match.
      const ok = await fileContainsAny(dbPath, this.uriNeedles, DB_SCAN_LIMIT, true);
      if (ok) this.workspaceMatch.add(id);
      return ok;
    }
    // Builds without conversations/<id>.db: look for the folder path in the first transcript lines.
    const ok = await fileContainsAny(transcriptPath, this.needles, TRANSCRIPT_SNIFF_BYTES, false);
    if (ok) this.workspaceMatch.add(id);
    return ok;
  }
}
