// MCNU MD — public converter. Upload → /api/convert → show markdown.
const $ = (id) => document.getElementById(id);
const dropCard = $('dropCard'), dropInner = $('dropInner'), dropBusy = $('dropBusy'), busyText = $('busyText');
const fileInput = $('fileInput'), browseBtn = $('browseBtn');
const resultCard = $('resultCard'), output = $('output'), resultMeta = $('resultMeta'), err = $('err');
const copyBtn = $('copyBtn'), dlBtn = $('dlBtn');
let lastName = 'document';

// engine badge
fetch('/api/health').then((r) => r.json()).then((h) => {
    $('engineBadge').textContent = h.markitdown ? 'engine: markitdown' : 'engine: node';
}).catch(() => {});

// ---- file selection ----
browseBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { if (fileInput.files[0]) upload(fileInput.files[0]); });

// ---- drag & drop ----
['dragenter', 'dragover'].forEach((ev) =>
    dropCard.addEventListener(ev, (e) => { e.preventDefault(); dropCard.classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) =>
    dropCard.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'dragleave' && dropCard.contains(e.relatedTarget)) return; dropCard.classList.remove('drag'); }));
dropCard.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) upload(f);
});
// allow paste of a file anywhere on the page
addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.kind === 'file');
    if (item) { const f = item.getAsFile(); if (f) upload(f); }
});

// ---- upload + convert ----
async function upload(file) {
    err.hidden = true; err.textContent = '';
    lastName = (file.name || 'document').replace(/\.[^.]+$/, '');
    dropInner.hidden = true; dropBusy.hidden = false;
    busyText.textContent = `Converting ${file.name}…`;

    const fd = new FormData();
    fd.append('file', file, file.name);
    try {
        const res = await fetch('/api/convert', { method: 'POST', body: fd });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { showError(data.error || `Failed (${res.status})`); return; }
        show(data);
    } catch (_) {
        showError('Network error — is the file too large or the connection down?');
    } finally {
        dropBusy.hidden = true; dropInner.hidden = false; fileInput.value = '';
    }
}

function show(data) {
    output.value = data.markdown || '';
    const kb = data.bytes ? ` · ${(data.bytes / 1024).toFixed(0)} KB in` : '';
    resultMeta.textContent = `${data.filename} · via ${data.engine}${kb} · ${data.markdown.length.toLocaleString()} chars out`;
    resultCard.hidden = false;
    resultCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function showError(msg) {
    err.textContent = msg; err.hidden = false;
    resultCard.hidden = true;
}

// ---- copy / download ----
copyBtn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(output.value); flash(copyBtn, 'COPIED'); }
    catch (_) { output.select(); document.execCommand('copy'); flash(copyBtn, 'COPIED'); }
});
dlBtn.addEventListener('click', () => {
    const blob = new Blob([output.value], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${lastName}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
});
function flash(btn, txt) {
    const old = btn.textContent; btn.textContent = txt;
    setTimeout(() => { btn.textContent = old; }, 1200);
}
