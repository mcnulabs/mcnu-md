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
// Returns { markdown, engine, kind, mdError? }. Throws only on hard failure
// (both engines unusable). mdError carries why markitdown was skipped, if it was.
export async function convert(buf, filename, log) {
    const { kind } = detectKind(filename);
    let mdError = null;

    // markitdown first (if available and not a trivially-text file).
    if (await markitdownAvailable() && kind !== 'text') {
        let tmpDir;
        try {
            tmpDir = await mkdtemp(path.join(tmpdir(), 'mcnu-md-'));
            const tmpFile = path.join(tmpDir, sanitize(filename));
            await writeFile(tmpFile, buf);
            const md = await runMarkitdown(tmpFile);
            await unlink(tmpFile).catch(() => {});
            if (md && md.trim()) return { markdown: tidy(md), engine: 'markitdown', kind };
            mdError = 'markitdown returned empty output';
        } catch (e) {
            mdError = e.message || String(e);
        }
        if (mdError && log) log.warn({ mdError, filename, kind }, 'markitdown failed; using Node fallback');
    }

    const md = await nodeFallback(buf, kind, filename);
    return { markdown: tidy(md), engine: 'node', kind, mdError };
}

function sanitize(name) {
    return (name || 'file').replace(/[^\w.\-]+/g, '_').slice(0, 120) || 'file';
}

function stripBom(s) {
    return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
}

// Repair mangled text from PDFs — chiefly LaTeX-generated ones, where accented
// letters are emitted as a base letter + a separate accent glyph (not Unicode NFC).
// Romanian (ă â î ș ț) is the common victim, plus a few Western-European accents.
function repairText(s) {
    // 1) Unicode NFC — folds genuine combining marks (U+0300..U+036F) onto their base.
    s = s.normalize('NFC');

    // Accent glyphs LaTeX leaves behind when it can't emit a precomposed letter.
    //   ˘ U+02D8 breve · ˆ U+02C6 circumflex · ¸ U+00B8 cedilla · ı/ȷ dotless i/j
    const BREVE = '˘', CIRC = 'ˆ', DOTLESS_I = 'ı', DOTLESS_J = 'ȷ', CEDILLA = '¸';

    // Does this document actually look LaTeX-mangled? If none of these glyphs are
    // present, the text is clean — skip ALL repair so we never touch good prose.
    const mangled = s.includes(BREVE) || s.includes(CIRC) || s.includes(CEDILLA) || s.includes(DOTLESS_I);
    if (!mangled) return s;

    // 2) Modifier-letter accents that sit BEFORE or AFTER the base letter.
    const pairs = [
        [BREVE + 'a', 'ă'], ['a' + BREVE, 'ă'], [BREVE + 'A', 'Ă'], ['A' + BREVE, 'Ă'],
        [CIRC + 'a', 'â'], ['a' + CIRC, 'â'], [CIRC + 'A', 'Â'], ['A' + CIRC, 'Â'],
        [CIRC + 'i', 'î'], ['i' + CIRC, 'î'], [CIRC + 'I', 'Î'], ['I' + CIRC, 'Î'],
        [CIRC + DOTLESS_I, 'î'], [DOTLESS_I + CIRC, 'î'],
        ['s' + CEDILLA, 'ș'], ['t' + CEDILLA, 'ț'], ['S' + CEDILLA, 'Ș'], ['T' + CEDILLA, 'Ț'],
        [CEDILLA + 's', 'ș'], [CEDILLA + 't', 'ț'], [CEDILLA + 'S', 'Ș'], [CEDILLA + 'T', 'Ț'],
    ];
    for (const [from, to] of pairs) s = s.split(from).join(to);

    // 3) Comma-below printed as a LITERAL comma directly followed by a letter
    //    (e.g. "s,ir", "construct,ia", "s,i"). A real comma is followed by a space
    //    or end-of-clause, so the letter-lookahead distinguishes them. Doubly safe:
    //    this whole block only runs when `mangled` is true.
    s = s.replace(/([sS]),(?=\p{L})/gu, (_, c) => (c === 's' ? 'ș' : 'Ș'))
         .replace(/([tT]),(?=\p{L})/gu, (_, c) => (c === 't' ? 'ț' : 'Ț'));

    // 4) Stray dotless i/j with no accent → normal i/j.
    s = s.split(DOTLESS_I).join('i').split(DOTLESS_J).join('j');

    // 5) Drop any orphan accent glyphs that didn't bind to a letter.
    s = s.replace(new RegExp(`[${BREVE}${CIRC}${CEDILLA}]`, 'g'), '');

    return s;
}

// Normalize whitespace: older markitdown (esp. on PDFs) emits "shredded" output —
// every fragment on its own line, a stray bullet marker on a line by itself, and a
// blank line between everything. Collapse that without merging real paragraphs.
function tidy(md) {
    let s = repairText(stripBom(md))
        .replace(/\r\n/g, '\n')            // CRLF → LF
        .replace(/[ \t]+$/gm, '');         // trailing spaces per line

    // Drop lines that are ONLY an orphan list/bullet marker (•, -, *, –, —) with no
    // text — these are layout artifacts from PDF extraction, not real list items.
    s = s.replace(/^[ \t]*[•·▪◦‣*\-–—][ \t]*$/gm, '');

    // Collapse any run of 2+ blank lines down to a single blank line. (A single blank
    // line is a real paragraph break in Markdown, so we keep one — but not the long
    // runs that shredding produces.)
    s = s.replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n');

    return s.trim();
}
