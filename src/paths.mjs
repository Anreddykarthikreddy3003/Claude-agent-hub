import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOME = os.homedir();

/** Where this tool keeps its own data (account slots, state, logs). */
export const DATA = process.env.CAM_HOME || path.join(HOME, '.claude-accounts');

/** The Claude Code config folder that the IDE extension / CLI actually uses. */
export const MAIN_DIR = process.env.CAM_MAIN_CONFIG_DIR || path.join(HOME, '.claude');
export const MAIN_CREDS = path.join(MAIN_DIR, '.credentials.json');
export const MAIN_STATE = process.env.CAM_MAIN_CONFIG_DIR
  ? path.join(MAIN_DIR, '.claude.json')
  : path.join(HOME, '.claude.json');
export const MAIN_SETTINGS = path.join(MAIN_DIR, 'settings.json');

export const SLOTS = path.join(DATA, 'slots');

export const FILES = {
  config: path.join(DATA, 'config.json'),
  accounts: path.join(DATA, 'accounts.json'),
  state: path.join(DATA, 'state.json'),
  /** Precomputed snapshot the editor UI reads directly (no process spawns). */
  status: path.join(DATA, 'status.json'),
  log: path.join(DATA, 'log.jsonl'),
  opsLock: path.join(DATA, 'ops.lock'),
  stateLock: path.join(DATA, 'state.lock'),
  pid: path.join(DATA, 'daemon.pid'),
  backups: path.join(DATA, 'backups'),
  primeCwd: path.join(DATA, 'prime-cwd'),
  launcher: path.join(DATA, 'run-hidden.vbs'),
};

/** Project root (the plugin root). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BIN = path.join(ROOT, 'bin', 'cam.mjs');

export const slotDir = (name) => path.join(SLOTS, name);
export const slotCreds = (name) => path.join(slotDir(name), '.credentials.json');
export const slotState = (name) => path.join(slotDir(name), '.claude.json');
