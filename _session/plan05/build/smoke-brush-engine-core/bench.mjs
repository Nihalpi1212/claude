export default async function (page, logs) {
  const r = await page.evaluate(async () => {
    const { dabCanvas, dabDrawSide } = await import('/lib/brush.js');
    const { createCanvas } = await import('/lib/document.js');
    const out = {};
    const buf = createCanvas(4000, 4000);
    const b = buf.getContext('2d');
    const tgt = createCanvas(4000, 4000);
    const t = tgt.getContext('2d');
    const size = 2500, side = dabDrawSide(size);
    const dab = dabCanvas(size, 0, '#000000');
    out.dabSide = [dab.width, side];
    const time = (label, n, fn) => { b.getImageData(0,0,1,1); t.getImageData(0,0,1,1); const t0 = performance.now(); for (let i = 0; i < n; i++) { fn(i); b.getImageData(0,0,1,1); t.getImageData(0,0,1,1); } out[label] = ((performance.now() - t0) / n).toFixed(1); };
    time('scaled-subpixel', 8, (i) => { b.globalAlpha = 1; b.drawImage(dab, 600.3 + i * 88, 600.7 + i * 88, side, side); });
    time('scaled-int', 8, (i) => { b.drawImage(dab, 600 + i * 88, 600 + i * 88, side, side); });
    time('unscaled-int', 8, (i) => { b.drawImage(dab, 600 + i * 88, 600 + i * 88); });
    time('unscaled-subpixel', 8, (i) => { b.drawImage(dab, 600.3 + i * 88, 600.7 + i * 88); });
    const exact = createCanvas(side, side);
    exact.getContext('2d').drawImage(dab, 0, 0, side, side);
    time('exact-int', 8, (i) => { b.drawImage(exact, 600 + i * 88, 600 + i * 88); });
    b.imageSmoothingEnabled = false;
    time('exact-subpixel-nosmooth', 8, (i) => { b.drawImage(exact, 600.3 + i * 88, 600.7 + i * 88); });
    b.imageSmoothingEnabled = true;
    time('copy-rect-2900', 4, () => { t.globalCompositeOperation = 'copy'; t.drawImage(buf, 500, 500, 2900, 2900, 500, 500, 2900, 2900); });
    t.globalCompositeOperation = 'source-over';
    time('over-rect-2900', 4, () => { t.drawImage(buf, 500, 500, 2900, 2900, 500, 500, 2900, 2900); });
    return out;
  });
  logs.push(JSON.stringify(r));
}
