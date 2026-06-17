// Drifting pixel-nabla field — the MCNU Labs signature background.
(function () {
    const cv = document.getElementById('bg');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const reduce = matchMedia('(prefers-reduced-motion:reduce)').matches;
    let W, H, glyphs = [];
    const NAB = ['#######', '.#####.', '..###..', '...#...'];

    function size() {
        W = innerWidth; H = innerHeight;
        const dpr = devicePixelRatio || 1;
        cv.width = W * dpr; cv.height = H * dpr;
        cv.style.width = W + 'px'; cv.style.height = H + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        glyphs = [];
        const n = Math.floor(W * H / 34000);
        for (let i = 0; i < n; i++) glyphs.push({
            x: Math.random() * W, y: Math.random() * H,
            s: 1 + Math.random() * 2, vy: 5 + Math.random() * 12,
            a: 0.04 + Math.random() * 0.08,
            c: Math.random() < 0.5 ? '#22D3EE' : '#A78BFA',
        });
    }
    function draw() {
        ctx.clearRect(0, 0, W, H);
        for (const g of glyphs) {
            ctx.globalAlpha = g.a; ctx.fillStyle = g.c;
            for (let y = 0; y < NAB.length; y++)
                for (let x = 0; x < NAB[0].length; x++)
                    if (NAB[y][x] === '#') ctx.fillRect(g.x + x * g.s, g.y + y * g.s, g.s, g.s);
            g.y += reduce ? 0 : g.vy * 0.016;
            if (g.y > H + 20) { g.y = -20; g.x = Math.random() * W; }
        }
        ctx.globalAlpha = 1;
        requestAnimationFrame(draw);
    }
    size();
    addEventListener('resize', size);
    requestAnimationFrame(draw);
})();
