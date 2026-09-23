// 로컬 경로. JINSIL_HOME으로 테스트 격리 가능.
import os from 'node:os';
import path from 'node:path';

export const home = () => process.env.JINSIL_HOME || path.join(os.homedir(), '.jinsil');
export const dataDir = () => path.join(home(), 'data');
export const appDir = version => path.join(home(), 'app', version);
export const configFile = () => path.join(home(), 'config.json');
export const deviceFile = () => path.join(home(), 'device.json');
export const submitStateFile = () => path.join(home(), 'data', 'submitted.jsonl');
