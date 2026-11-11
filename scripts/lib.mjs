import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = path.join(ROOT, 'out');
export const SITE = path.join(OUT, 'site');

export function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
export function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 1) + '\n');
}
export function loadConfig() {
  let c;
  try { c = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); }
  catch (e) { throw new Error(`В config.json ошибка записи (часто это лишняя или пропущенная запятая, кавычка или скобка): ${e.message}`); }
  return { autoPublish: false, startDate: '', timezone: 'Asia/Baku', publishLanguage: 'en', shareToFeed: true, login: 'unified', apiVersion: 'v26.0', minStock: 3, produceBatch: 3, autoProduce: true, ...c };
}
export function loadState() {
  const s = readJSON(path.join(ROOT, 'state.json'), {});
  return { history: [], lastRefresh: null, ...s, history: Array.isArray(s.history) ? s.history : [] };
}
export function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}
export function summary(md) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
}
