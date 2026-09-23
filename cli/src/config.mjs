import fs from 'node:fs';
import path from 'node:path';
import { configFile, deviceFile, home } from './paths.mjs';

export const DEFAULT_SERVER = 'https://jinsil.axwith.com';
export const DEFAULT_PORT = 10199;

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
function writeJson(f, v) {
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(f, 0o600);
}
export function loadConfig() {
  return { server: DEFAULT_SERVER, port: DEFAULT_PORT, auto_submit: false, consented_at: null, ...(readJson(configFile()) || {}) };
}
export function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  writeJson(configFile(), next);
  return next;
}
export const loadDevice = () => readJson(deviceFile());
export const saveDevice = d => writeJson(deviceFile(), d);
export const removeDevice = () => fs.rmSync(deviceFile(), { force: true });
export const ensureHome = () => { fs.mkdirSync(home(), { recursive: true, mode: 0o700 }); fs.chmodSync(home(), 0o700); };
