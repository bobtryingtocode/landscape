// Copies the web app into www/ for the native build and points it at the hosted API.
// Set LANDSCAPE_API to your Vercel address (e.g. https://landscape-henna.vercel.app) — or edit the default below.
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));   // mobile/scripts
const mobile = join(here, '..');                          // mobile/
const root = join(mobile, '..');                           // repo root
const api = (process.env.LANDSCAPE_API || 'https://landscape-henna.vercel.app').replace(/\/$/, '');
let html = readFileSync(join(root, 'index.html'), 'utf8');
html = html.replace(/window\.LS_CONFIG=\{([^}]*)\};/, (m, inner) => { const rest = inner.replace(/,?\s*apiBase:"[^"]*"/, '').replace(/^,|,$/g, ''); return `window.LS_CONFIG={${rest ? rest + ',' : ''}apiBase:"${api}"};`; });
if (!html.includes(`apiBase:"${api}"`)) throw new Error('Could not find window.LS_CONFIG in index.html');
// Service worker is for the web; the native shell has its own bundle.
html = html.replace(/if\('serviceWorker' in navigator[^\n]*\n/, '');
mkdirSync(join(mobile, 'www', 'icons'), { recursive: true });
writeFileSync(join(mobile, 'www', 'index.html'), html);
cpSync(join(root, 'icons'), join(mobile, 'www', 'icons'), { recursive: true });
if (existsSync(join(root, 'manifest.webmanifest'))) cpSync(join(root, 'manifest.webmanifest'), join(mobile, 'www', 'manifest.webmanifest'));
console.log('www/ updated → API at', api);
