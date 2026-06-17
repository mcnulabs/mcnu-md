// Conversion engine. Strategy: try markitdown (Python) first — it handles the
// widest range of formats with the best fidelity. If it's missing, times out, or
// errors on a given file, fall back to a per-format Node converter.
import { spawn } from 'node:child_process';
import { writeFile, unlink, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { config } from './config.js';

// turndown is CommonJS; bridge require() into ESM.
const require = createRequire(import.meta.url);

// ---- format detection (by extension; markitdown sniffs content itself) ----
const EXT = {
    pdf: 'pdf',
    doc: 'docx', docx: 'docx',
    xls: 'xlsx', xlsx: 'xlsx', csv: 'csv',
    html: 'html', htm: 'html',
    txt: 'text', md: 'text', markdown: 'text', log: 'text',
    json: 'text', xml: 'text', yaml: 'text', yml: 'text',
    pptx: 'pptx',
};
export function detectKind(filename) {
    const ext = (filename.split('.').pop() || '').toLowerCase();
    return { ext, kind: EXT[ext] || 'unknown' };
}

// ---- markitdown (Python) via a temp file ----
let _markitdownOk = null;   // cache availability after first probe
export async function markitdownAvailable() {
    if (!config.markitdownEnabled) return false;
    if (_markitdownOk !== null) return _markitdownOk;
    _markitdownOk = await new Promise((resolve) => {
        const p = spawn(config.markitdownCmd, ['--help'], { stdio: 'ignore' });
        p.on('error', () => resolve(false));
        p.on('close', (code) => resolve(code === 0));
    });
    return _markitdownOk;
}

async function runMarkitdown(filePath) {
    return new Promise((resolve, reject) => {
        const out = [], err = [];
        const p = spawn(config.markitdownCmd, [filePath], { stdio: ['ignore', 'pipe', 'pipe'] });
        const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('markitdown timed out')); }, config.markitdownTimeoutMs);
        p.stdout.on('data', (d) => out.push(d));
        p.stderr.on('data', (d) => err.push(d));
        p.on('error', (e) => { clearTimeout(timer); reject(e); });
        p.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
            else reject(new Error(Buffer.concat(err).toString('utf8').slice(0, 500) || `markitdown exit ${code}`));
        });
    });
}

// ---- Node fallbacks (lazy-imported so a missing optional dep can't crash boot) ----
async function nodeFallback(buf, kind, filename) {
    switch (kind) {
        case 'pdf': {
            const { default: pdfParse } = await import('pdf-parse');
            const data = await pdfParse(buf);
            return data.text.replace(/\n{3,}/g, '\n\n').trim();
        }
        case 'docx': {
            const mammoth = await import('mammoth');
            const { value: html } = await mammoth.convertToHtml({ buffer: buf });
            return htmlToMd(html);
        }
        case 'xlsx':
        case 'csv': {
            const XLSX = (await import('xlsx')).default ?? (await import('xlsx'));
            const wb = XLSX.read(buf, { type: 'buffer' });
            const parts = [];
            const multi = wb.SheetNames.length > 1;
            for (const name of wb.SheetNames) {
                if (multi) parts.push(`## ${name}\n`);
                const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, defval: '' });
                if (!rows.length) { parts.push('_(empty)_', ''); continue; }
                const cols = Math.max(...rows.map((r) => r.length));
                const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
                const fmt = (r) => '| ' + Array.from({ length: cols }, (_, i) => cell(r[i])).join(' | ') + ' |';
                parts.push(fmt(rows[0]));                                  // header
                parts.push('| ' + Array(cols).fill('---').join(' | ') + ' |'); // separator
                for (let i = 1; i < rows.length; i++) parts.push(fmt(rows[i]));
                parts.push('');
            }
            return parts.join('\n').trim();
        }
        case 'html':
            return htmlToMd(stripBom(buf.toString('utf8')));
        case 'text':
            return stripBom(buf.toString('utf8'));
        case 'pptx':
            throw new Error('PowerPoint needs markitdown — not installed on the server.');
        default:
            throw new Error(`Unsupported format: ${filename}. Try a PDF, Word, Excel, HTML, or text file.`);
    }
}

let _turndown = null;
function htmlToMd(html) {
    if (!_turndown) {
        const TurndownService = require('turndown');
        _turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
    }
    return _turndown.turndown(html).replace(/\n{3,}/g, '\n\n').trim();
}

// ---- public entry ----
// Returns { markdown, engine, kind }. Throws on hard failure.
export async function convert(buf, filename) {
    const { kind } = detectKind(filename);

    // markitdown first (if available and not a trivially-text file).
    if (await markitdownAvailable() && kind !== 'text') {
        let tmpDir;
        try {
            tmpDir = await mkdtemp(path.join(tmpdir(), 'mcnu-md-'));
            const tmpFile = path.join(tmpDir, sanitize(filename));
            await writeFile(tmpFile, buf);
            const md = await runMarkitdown(tmpFile);
            await unlink(tmpFile).catch(() => {});
            if (md && md.trim()) return { markdown: md.trim(), engine: 'markitdown', kind };
            // empty output → fall through to Node
        } catch (_) {
            // markitdown failed on this file → fall through to Node fallback
        }
    }

    const md = await nodeFallback(buf, kind, filename);
    return { markdown: md, engine: 'node', kind };
}

function sanitize(name) {
    return (name || 'file').replace(/[^\w.\-]+/g, '_').slice(0, 120) || 'file';
}

function stripBom(s) {
    return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}
