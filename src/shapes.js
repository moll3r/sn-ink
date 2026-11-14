// Hold-to-snap shape recognition: line, triangle, rectangle/quad, circle/ellipse.
// Input: array of [x, y, ...]. Output: { kind, pts: [[x,y,p],...] } or null.

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function pathLength(p) {
  let L = 0;
  for (let i = 1; i < p.length; i++) L += dist(p[i - 1], p[i]);
  return L;
}
function perpDist(p, a, b) {
  const L = dist(a, b);
  if (L === 0) return dist(p, a);
  return Math.abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / L;
}
function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  let maxD = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist(pts[i], pts[0], pts[pts.length - 1]);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= eps) return [pts[0], pts[pts.length - 1]];
  const l = rdp(pts.slice(0, idx + 1), eps), r = rdp(pts.slice(idx), eps);
  return l.slice(0, -1).concat(r);
}
function densify(vertices, closed, step = 4) {
  const out = [];
  const n = vertices.length;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = vertices[i], b = vertices[(i + 1) % n];
    const k = Math.max(1, Math.ceil(dist(a, b) / step));
    for (let j = 0; j < k; j++) out.push([a[0] + (b[0] - a[0]) * j / k, a[1] + (b[1] - a[1]) * j / k, 0.5]);
  }
  const last = closed ? vertices[0] : vertices[n - 1];
  out.push([last[0], last[1], 0.5]);
  return out;
}
function turnAngle(prev, cur, next) {
  const a1 = Math.atan2(cur[1] - prev[1], cur[0] - prev[0]);
  const a2 = Math.atan2(next[1] - cur[1], next[0] - cur[0]);
  let d = Math.abs(a2 - a1);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d; // 0 = straight
}

function fitEllipse(pts) {
  const n = pts.length;
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p[0]; cy += p[1]; }
  cx /= n; cy /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of pts) {
    const dx = p[0] - cx, dy = p[1] - cy;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  sxx /= n; syy /= n; sxy /= n;
  const tr = sxx + syy, det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const l1 = tr / 2 + disc, l2 = Math.max(1e-6, tr / 2 - disc);
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let a = Math.sqrt(2 * l1), b = Math.sqrt(2 * l2);
  // residual: how far each point is from the ellipse, normalized
  const c = Math.cos(theta), s = Math.sin(theta);
  let err = 0;
  for (const p of pts) {
    const dx = p[0] - cx, dy = p[1] - cy;
    const u = (dx * c + dy * s) / a, v = (-dx * s + dy * c) / b;
    err += Math.abs(Math.hypot(u, v) - 1);
  }
  err /= n;
  if (b / a > 0.88) { const r = (a + b) / 2; a = b = r; }
  const out = [];
  const N = 72;
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * 2 * Math.PI;
    const x = a * Math.cos(t), y = b * Math.sin(t);
    out.push([cx + x * c - y * s, cy + x * s + y * c, 0.5]);
  }
  return { err, pts: out, circle: a === b };
}

export function recognize(raw) {
  const pts = raw.filter((p, i) => i === 0 || dist(p, raw[i - 1]) > 0.5);
  if (pts.length < 5) return null;
  const L = pathLength(pts);
  if (L < 30) return null;
  const first = pts[0], last = pts[pts.length - 1];
  const chord = dist(first, last);

  // straight line
  let maxDev = 0;
  for (const p of pts) maxDev = Math.max(maxDev, perpDist(p, first, last));
  if (chord > 25 && maxDev < Math.max(5, 0.07 * chord) && L < chord * 1.25) {
    return { kind: 'line', pts: densify([first, last], false) };
  }

  // open polyline (zigzag, Z, angle bracket): a few straight segments
  if (chord > 0.22 * L) {
    const xs0 = pts.map((p) => p[0]), ys0 = pts.map((p) => p[1]);
    const diag0 = Math.hypot(Math.max(...xs0) - Math.min(...xs0), Math.max(...ys0) - Math.min(...ys0));
    const v = rdp(pts, Math.max(4, diag0 * 0.045));
    const segOk = v.every((q, i) => i === 0 || dist(q, v[i - 1]) > diag0 * 0.12);
    if (v.length >= 3 && v.length <= 6 && segOk) return { kind: 'polyline', pts: densify(v, false) };
    return null;
  }
  let xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const diag = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  if (diag < 20) return null;

  let verts = rdp(pts, diag * 0.075);
  if (dist(verts[0], verts[verts.length - 1]) < diag * 0.25) verts.pop();
  // drop near-straight vertices (cyclic), repeat until stable
  let changed = true;
  while (changed && verts.length > 3) {
    changed = false;
    for (let i = 0; i < verts.length; i++) {
      const v = verts[i], prev = verts[(i - 1 + verts.length) % verts.length], next = verts[(i + 1) % verts.length];
      if (turnAngle(prev, v, next) < 0.45 || dist(prev, v) < diag * 0.08) {
        verts.splice(i, 1); changed = true; break;
      }
    }
  }

  const ell = fitEllipse(pts);
  // Polygons need sharp-ish corners: compare to the ellipse fit.
  if (verts.length === 3 && ell.err > 0.06) {
    return { kind: 'triangle', pts: densify(verts, true) };
  }
  if (verts.length === 4 && ell.err > 0.05) {
    // axis-aligned rectangle if edges are near horizontal/vertical
    const aligned = verts.every((v, i) => {
      const w = verts[(i + 1) % 4];
      const ang = Math.abs(Math.atan2(w[1] - v[1], w[0] - v[0])) % (Math.PI / 2);
      return ang < 0.2 || ang > Math.PI / 2 - 0.2;
    });
    if (aligned) {
      xs = verts.map((v) => v[0]); ys = verts.map((v) => v[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      return { kind: 'rectangle', pts: densify([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], true) };
    }
    return { kind: 'quad', pts: densify(verts, true) };
  }
  if (ell.err < 0.13) return { kind: ell.circle ? 'circle' : 'ellipse', pts: ell.pts };
  return null;
}
