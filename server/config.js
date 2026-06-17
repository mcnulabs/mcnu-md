import 'dotenv/config';

const isProd = process.env.NODE_ENV === 'production';

export const config = {
    isProd,
    port: parseInt(process.env.PORT || '3007', 10),
    host: process.env.HOST || '127.0.0.1',

    // Upload limits — public service, so keep these sane.
    maxBytes: parseInt(process.env.MD_MAX_BYTES || '26214400', 10),   // 25 MB per file

    // Per-IP rate limit (sliding window).
    rateMax: parseInt(process.env.MD_RATE_MAX || '30', 10),           // conversions...
    rateWindowMs: parseInt(process.env.MD_RATE_WINDOW_MS || '3600000', 10), // ...per hour

    // markitdown: command to invoke (Python). Empty/-disabled → Node-only.
    markitdownCmd: process.env.MARKITDOWN_CMD || 'markitdown',
    markitdownEnabled: process.env.MARKITDOWN_DISABLED !== '1',
    markitdownTimeoutMs: parseInt(process.env.MARKITDOWN_TIMEOUT_MS || '60000', 10),

    summaryToken: process.env.SUMMARY_TOKEN || '',
};
