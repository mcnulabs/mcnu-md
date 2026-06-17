import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { convert, markitdownAvailable } from './convert.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

const app = Fastify({ logger: { level: 'warn' }, trustProxy: config.isProd, bodyLimit: config.maxBytes + 65536 });
await app.register(fastifyMultipart, { limits: { fileSize: config.maxBytes, files: 1 } });
await app.register(fastifyStatic, { root: publicDir, prefix: '/' });

// ---- security headers (applied to every response) ----
const CSP = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
].join('; ');
app.addHook('onSend', async (req, reply) => {
    reply.header('Content-Security-Policy', CSP);
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    if (config.isProd) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
});

// ---- per-IP sliding-window rate limit ----
const hits = new Map();   // ip -> [timestamps]
function rateLimited(ip) {
    const now = Date.now();
    const cutoff = now - config.rateWindowMs;
    const arr = (hits.get(ip) || []).filter((t) => t > cutoff);
    if (arr.length >= config.rateMax) { hits.set(ip, arr); return true; }
    arr.push(now); hits.set(ip, arr);
    return false;
}
// periodic cleanup so the map can't grow unbounded
setInterval(() => {
    const cutoff = Date.now() - config.rateWindowMs;
    for (const [ip, arr] of hits) {
        const live = arr.filter((t) => t > cutoff);
        if (live.length) hits.set(ip, live); else hits.delete(ip);
    }
}, config.rateWindowMs).unref?.();

let conversions = 0;   // lifetime counter (in-memory) for the console summary

// ---- convert ----
app.post('/api/convert', async (req, reply) => {
    const ip = req.ip || '?';
    if (rateLimited(ip)) {
        return reply.code(429).send({ error: `Rate limit: ${config.rateMax} conversions/hour. Try again later.` });
    }
    let data;
    try { data = await req.file(); }
    catch (e) {
        if (e.code === 'FST_REQ_FILE_TOO_LARGE') {
            return reply.code(413).send({ error: `File too large. Max ${Math.round(config.maxBytes / 1048576)} MB.` });
        }
        return reply.code(400).send({ error: 'Upload failed.' });
    }
    if (!data) return reply.code(400).send({ error: 'No file uploaded.' });

    let buf;
    try { buf = await data.toBuffer(); }
    catch (e) {
        if (e.code === 'FST_REQ_FILE_TOO_LARGE') {
            return reply.code(413).send({ error: `File too large. Max ${Math.round(config.maxBytes / 1048576)} MB.` });
        }
        return reply.code(400).send({ error: 'Could not read file.' });
    }
    if (!buf || buf.length === 0) return reply.code(400).send({ error: 'Empty file.' });

    const filename = data.filename || 'file';
    try {
        const { markdown, engine, kind } = await convert(buf, filename);
        conversions++;
        return { ok: true, markdown, engine, kind, filename, bytes: buf.length };
    } catch (e) {
        req.log.warn({ err: e.message, filename }, 'convert failed');
        return reply.code(422).send({ error: e.message || 'Conversion failed.' });
    }
});

// ---- console summary (token) ----
app.get('/api/summary', async (req, reply) => {
    if (!config.summaryToken || req.headers['x-summary-token'] !== config.summaryToken) {
        return reply.code(401).send({ error: 'unauthorized' });
    }
    return { ok: true, numbers: [
        { label: 'Conversions', value: String(conversions) },
        { label: 'Engine', value: (await markitdownAvailable()) ? 'markitdown' : 'node' },
    ] };
});

// ---- health ----
app.get('/api/health', async () => ({ ok: true, markitdown: await markitdownAvailable() }));

app.get('/', (req, reply) => reply.sendFile('index.html'));

let notFoundHtml = '<h1>404</h1>';
try { notFoundHtml = readFileSync(path.join(publicDir, '404.html'), 'utf8'); } catch (_) {}
app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
    if ((req.headers.accept || '').includes('text/html')) return reply.code(404).type('text/html').send(notFoundHtml);
    return reply.code(404).send('Not found');
});

try {
    await app.listen({ port: config.port, host: config.host });
    const md = await markitdownAvailable();
    console.log(`\n  MCNU MD on http://${config.host}:${config.port}  ·  engine: ${md ? 'markitdown + node fallback' : 'node only'}\n`);
} catch (err) { app.log.error(err); process.exit(1); }
