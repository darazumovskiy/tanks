// ПАРАЛЛАКС. Standalone ES module; decisions use only the public arena state.
const PI = Math.PI, TAU = PI * 2, DT = 1 / 30;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const angle = a => { a = (a + PI) % TAU; return (a < 0 ? a + TAU : a) - PI; };
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
let walls = [], width = 1600, height = 900, nodes = [], edges = [], faces = [];
let previous = null, enemyTurn = 0, enemyAcceleration = 0, target = null;
let navigationTick = -100, orbit = 1, shotCount = 0, lastDamageTime = 0, lastHp = 0;

function contact(x, y, r, w) {
  const dx = x - clamp(x, w.x, w.x + w.w), dy = y - clamp(y, w.y, w.y + w.h);
  const d2 = dx * dx + dy * dy;
  if (d2 >= r * r) return null;
  if (d2 > 1e-9) { const d = Math.sqrt(d2); return { nx: dx / d, ny: dy / d, depth: r - d }; }
  const l = x - w.x, rr = w.x + w.w - x, t = y - w.y, b = w.y + w.h - y;
  const d = Math.min(l, rr, t, b);
  if (d === l) return { nx: -1, ny: 0, depth: l + r };
  if (d === rr) return { nx: 1, ny: 0, depth: rr + r };
  if (d === t) return { nx: 0, ny: -1, depth: t + r };
  return { nx: 0, ny: 1, depth: b + r };
}

function free(x, y, pad = 26) {
  return x >= pad && x <= width - pad && y >= pad && y <= height - pad &&
    !walls.some(w => contact(x, y, pad, w));
}

function intersects(ax, ay, bx, by, w, pad) {
  const dx = bx - ax, dy = by - ay;
  let lo = 0, hi = 1;
  if (Math.abs(dx) < 1e-9) { if (ax < w.x - pad || ax > w.x + w.w + pad) return false; }
  else {
    let a = (w.x - pad - ax) / dx, b = (w.x + w.w + pad - ax) / dx;
    if (a > b) [a, b] = [b, a];
    lo = Math.max(lo, a); hi = Math.min(hi, b);
    if (lo > hi) return false;
  }
  if (Math.abs(dy) < 1e-9) { if (ay < w.y - pad || ay > w.y + w.h + pad) return false; }
  else {
    let a = (w.y - pad - ay) / dy, b = (w.y + w.h + pad - ay) / dy;
    if (a > b) [a, b] = [b, a];
    lo = Math.max(lo, a); hi = Math.min(hi, b);
  }
  return lo <= hi;
}

function clear(a, b, pad = 5.1) {
  for (const w of walls) {
    if (!intersects(a.x, a.y, b.x, b.y, w, pad)) continue;
    if (pad <= 10 || intersects(a.x, a.y, b.x, b.y, w, 0) || contact(a.x, a.y, pad, w) || contact(b.x, b.y, pad, w)) return false;
    // Swept-circle clearance has rounded corners, just like the engine hull.
    // A square-expanded obstacle can falsely imprison a tank beside a corner.
    for (const x of [w.x, w.x + w.w]) for (const y of [w.y, w.y + w.h]) {
      if (segmentDistance2(x, y, a.x, a.y, b.x, b.y) < pad * pad) return false;
    }
  }
  return true;
}

// Engine-equivalent acceleration, hull turning, wall sliding and reverse gear.
function move(p, throttle, turn, st) {
  p.heading = angle(p.heading + turn * st.turnRate * DT);
  const desired = throttle * st.maxSpeed * (throttle < 0 ? 0.6 : 1);
  p.speed += clamp(desired - p.speed, -14, 14);
  p.x += Math.cos(p.heading) * p.speed * DT;
  p.y += Math.sin(p.heading) * p.speed * DT;
  let bump = false;
  for (let pass = 0; pass < 2; pass++) {
    for (const w of walls) {
      const c = contact(p.x, p.y, 24, w);
      if (c) { p.x += c.nx * c.depth; p.y += c.ny * c.depth; bump = true; }
    }
    const x = clamp(p.x, 24, width - 24), y = clamp(p.y, 24, height - 24);
    if (x !== p.x || y !== p.y) bump = true;
    p.x = x; p.y = y;
  }
  if (bump) p.speed *= 0.6;
  return bump;
}

function buildMap(s) {
  walls = s.arena.walls; width = s.arena.width; height = s.arena.height;
  nodes = []; edges = []; faces = [];
  const add = (x, y) => {
    if (free(x, y, 27) && !nodes.some(n => Math.hypot(n.x - x, n.y - y) < 2)) nodes.push({ x, y });
  };
  for (const w of walls) {
    for (const x of [w.x - 30, w.x + w.w + 30])
      for (const y of [w.y - 30, w.y + w.h + 30]) add(x, y);
    faces.push({ axis: 0, value: w.x - 5, lo: w.y + 2, hi: w.y + w.h - 2 },
      { axis: 0, value: w.x + w.w + 5, lo: w.y + 2, hi: w.y + w.h - 2 },
      { axis: 1, value: w.y - 5, lo: w.x + 2, hi: w.x + w.w - 2 },
      { axis: 1, value: w.y + w.h + 5, lo: w.x + 2, hi: w.x + w.w - 2 });
  }
  for (const k of s.repairKits) add(k.x, k.y);
  for (let a = 0; a < TAU; a += PI / 4) add(width / 2 + 110 * Math.cos(a), height / 2 + 110 * Math.sin(a));
  faces.push({ axis: 0, value: 5, lo: 6, hi: height - 6 },
    { axis: 0, value: width - 5, lo: 6, hi: height - 6 },
    { axis: 1, value: 5, lo: 6, hi: width - 6 },
    { axis: 1, value: height - 5, lo: 6, hi: width - 6 });
  edges = nodes.map(() => []);
  for (let i = 0; i < nodes.length; i++) for (let j = 0; j < i; j++) {
    if (clear(nodes[i], nodes[j], 25.5)) {
      const d = distance(nodes[i], nodes[j]);
      edges[i].push([j, d]); edges[j].push([i, d]);
    }
  }
}

// Visibility graph: routes through real corridors, with hull clearance.
function route(from, to) {
  if (free(to.x, to.y, 24.1) && clear(from, to, 25)) return { point: to, length: distance(from, to) };
  const n = nodes.length, d = new Float64Array(n).fill(Infinity), done = new Uint8Array(n);
  const previousNode = new Int16Array(n).fill(-1);
  for (let i = 0; i < n; i++) if (clear(from, nodes[i], 23.7)) d[i] = distance(from, nodes[i]);
  let best = Infinity, goal = -1;
  for (let k = 0; k < n; k++) {
    let u = -1, nearest = Infinity;
    for (let i = 0; i < n; i++) if (!done[i] && d[i] < nearest) { nearest = d[i]; u = i; }
    if (u < 0 || nearest >= best) break;
    done[u] = 1;
    if (clear(nodes[u], to, 25)) {
      const total = nearest + distance(nodes[u], to);
      if (total < best) { best = total; goal = u; }
    }
    for (const [v, cost] of edges[u]) if (nearest + cost < d[v]) { d[v] = nearest + cost; previousNode[v] = u; }
  }
  const reachesGoal = goal >= 0;
  if (!reachesGoal) {
    // A target touching a rounded corner may lie inside our conservative
    // navigation padding. Approach the nearest reachable node to the target;
    // minimizing path + straight-line gap here would park at an earlier corner.
    let gap = Infinity;
    for (let i = 0; i < n; i++) {
      const remaining = distance(nodes[i], to);
      if (Number.isFinite(d[i]) && remaining < gap) { gap = remaining; best = d[i] + remaining; goal = i; }
    }
  }
  if (goal < 0) {
    const escape = nodes.reduce((a, b) => distance(from, a) < distance(from, b) ? a : b, to);
    return { point: escape, length: distance(from, escape) + distance(escape, to) };
  }
  const path = reachesGoal ? [to] : [];
  for (let u = goal; u >= 0; u = previousNode[u]) path.push(nodes[u]);
  path.reverse();
  // Keep the next segment: rebuilding a route at a reached corner must not
  // select that same corner forever. Five pixels fit inside our 30 px margin.
  let index = 0;
  while (index < path.length - 1 && (clear(from, path[index + 1], 24.1) || distance(from, path[index]) < 5)) index++;
  return { point: path[index], next: path[index + 1], length: best };
}

function zoneRadius(s, time) {
  const start = Math.hypot(width / 2, height / 2) + 60;
  return start + (s.zone.finalRadius - start) * clamp((time - s.zone.shrinkStart) / (s.zone.shrinkEnd - s.zone.shrinkStart), 0, 1);
}

function strategy(s) {
  const { me, enemy } = s;
  const los = clear(me, enemy, 7), dist = distance(me, enemy);
  let range = enemy.stats.maxSpeed > 180 ? 300 : 350;
  if (shotCount > 12 && s.time - lastDamageTime > 12) range = 210;
  if (enemy.stats.damage / enemy.stats.reloadTime > me.stats.damage / me.stats.reloadTime * 1.2) range += 90;
  range = Math.min(range, zoneRadius(s, s.time + 4) * 1.25);
  const safe = zoneRadius(s, s.time + 5) - 55;
  let goal = enemy, kind = 'hunt';
  if (distance(me, s.zone) > safe) {
    const candidates = nodes.filter(n => distance(n, s.zone) < Math.max(125, safe - 85));
    let best = Infinity;
    for (const n of candidates) {
      const r = route(me, n);
      const v = r.length + Math.abs(distance(n, enemy) - Math.min(range, 230)) * 0.4;
      if (v < best) { best = v; goal = n; kind = 'zone'; }
    }
  }
  if (kind !== 'zone' && me.maxHp - me.hp >= 30) {
    let best = Infinity;
    for (const k of s.repairKits) {
      if (distance(k, s.zone) > safe - 15) continue;
      const r = route(me, k), eta = r.length / me.stats.maxSpeed;
      if (!k.active && k.respawnIn > eta + 1.5) continue;
      const enemyEta = distance(enemy, k) / enemy.stats.maxSpeed;
      if (enemyEta + 1 < eta && distance(enemy, k) < 100 && enemy.hp < enemy.maxHp - 15) continue;
      const value = r.length + Math.max(0, k.respawnIn - eta) * 130;
      if (value < best && (r.length < 700 || me.hp < me.maxHp * 0.45)) { best = value; goal = k; kind = 'kit'; }
    }
  }
  if (kind === 'hunt' && los && dist < range + 180) return { kind: 'fight', point: enemy, range, los };
  const path = route(me, goal);
  return { kind, point: path.point, next: path.next, goal, range, los };
}

function enemyForecast(s, frames = 80) {
  const e = s.enemy, p = { x: e.x, y: e.y, heading: e.heading, speed: e.speed };
  const out = [{ x: p.x, y: p.y }];
  for (let i = 1; i <= frames; i++) {
    const t = i * DT;
    // Fast opponents can change course before the shell arrives; extrapolate
    // their current turn for a shorter interval instead of inventing a long arc.
    const tr = enemyTurn * Math.exp(-Math.max(0, t - (e.stats.maxSpeed > 150 ? 0.12 : 0.35)) * 2.5);
    const speed = clamp(e.speed + enemyAcceleration * Math.min(t, 0.18), -e.stats.maxSpeed * 0.6, e.stats.maxSpeed);
    move(p, speed / (e.stats.maxSpeed * (speed < 0 ? 0.6 : 1)), tr / e.stats.turnRate, e.stats);
    out.push({ x: p.x, y: p.y });
  }
  return out;
}

function predict(forecast, t) {
  const u = clamp(t / DT, 0, forecast.length - 1), i = Math.floor(u), k = u - i;
  const a = forecast[i], b = forecast[Math.min(i + 1, forecast.length - 1)];
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}

function advanceBullet(b) {
  const steps = Math.ceil(Math.hypot(b.vx, b.vy) * DT / 6), dt = DT / steps;
  const segments = [];
  for (let j = 0; j < steps && !b.dead; j++) {
    const x = b.x, y = b.y;
    b.x += b.vx * dt; b.y += b.vy * dt;
    let c = null;
    if (b.x < 5) c = { nx: 1, ny: 0, depth: 5 - b.x };
    else if (b.x > width - 5) c = { nx: -1, ny: 0, depth: b.x - (width - 5) };
    else if (b.y < 5) c = { nx: 0, ny: 1, depth: 5 - b.y };
    else if (b.y > height - 5) c = { nx: 0, ny: -1, depth: b.y - (height - 5) };
    else for (const w of walls) { c = contact(b.x, b.y, 5, w); if (c) break; }
    if (c) {
      if (b.bouncesLeft <= 0) { b.dead = true; break; }
      b.bouncesLeft--; b.canHitOwner = true;
      b.x += c.nx * c.depth; b.y += c.ny * c.depth;
      const dot = b.vx * c.nx + b.vy * c.ny;
      b.vx -= 2 * dot * c.nx; b.vy -= 2 * dot * c.ny;
    } else if (!b.mine || b.canHitOwner) segments.push(x, y, b.x, b.y);
  }
  return segments;
}

function bulletForecast(s, frames) {
  const out = [];
  for (const source of s.bullets) {
    if (distance(source, s.me) > Math.hypot(source.vx, source.vy) * frames * DT + 200) continue;
    const b = { ...source }, path = [];
    for (let i = 0; i < frames; i++) path.push(b.dead ? [] : advanceBullet(b));
    if (path.some(p => p.length)) out.push({ path, damage: b.damage });
  }
  return out;
}

// A low-confidence future shot rewards changing course before the enemy fires.
// Existing shells always outweigh this hypothesis. A wall or an unreachable
// turret angle cancels it, so cover remains useful.
function anticipate(s, frames, forecast) {
  const e = s.enemy, m = s.me;
  if (e.reloadLeft > 0.55) return null;
  const frame = Math.max(0, Math.ceil(e.reloadLeft / DT) - 1), when = frame * DT;
  const origin = predict(forecast, when + DT), speed = e.stats.bulletSpeed;
  let t = (distance(origin, m) - 34) / speed, point;
  for (let i = 0; i < 4; i++) {
    point = { x: m.x + m.vx * (when + t), y: m.y + m.vy * (when + t) };
    t = (distance(origin, point) - 34) / speed;
  }
  const a = Math.atan2(point.y - origin.y, point.x - origin.x);
  if (Math.abs(angle(a - e.turret)) > e.stats.turretRate * (when + DT) + 0.09) return null;
  const b = { x: origin.x + 34 * Math.cos(a), y: origin.y + 34 * Math.sin(a),
    vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, bouncesLeft: 1, mine: false, canHitOwner: false };
  if (!free(b.x, b.y, 5) || !clear(b, point, 5)) return null;
  const path = [];
  for (let i = 0; i < frames; i++) path.push(i < frame || b.dead ? [] : advanceBullet(b));
  return { path, damage: e.stats.damage * 0.12 };
}

function segmentDistance2(x, y, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return (x - ax - dx * t) ** 2 + (y - ay - dy * t) ** 2;
}

function control(p, heading, reverse, st, halt = false) {
  const diff = angle(heading - p.heading - (reverse ? PI : 0));
  return { turn: clamp(diff / (st.turnRate * DT), -1, 1),
    throttle: halt ? 0 : (reverse ? -1 : 1) * (Math.abs(diff) > 1.3 ? 0 : Math.abs(diff) > 0.7 ? 0.45 : 1) };
}

function drive(s, tactical, forecast) {
  const { me, enemy } = s, st = me.stats, frames = 30;
  const threats = bulletForecast(s, frames);
  const incoming = anticipate(s, frames, forecast);
  if (incoming) threats.push(incoming);
  const bearing = Math.atan2(enemy.y - me.y, enemy.x - me.x);
  const combat = tactical.kind === 'fight';
  const desired = combat ? bearing + orbit * Math.acos(clamp((distance(me, enemy) - tactical.range) / 130, -0.9, 0.9))
    : Math.atan2(tactical.point.y - me.y, tactical.point.x - me.x);
  const choices = [{ heading: desired, reverse: false, follow: !combat }, { heading: desired, reverse: true, follow: !combat }];
  for (let i = 0; i < 16; i++) choices.push({ heading: me.heading + i * TAU / 16, reverse: false });
  for (const offset of [-0.8, 0, 0.8]) choices.push({ heading: me.heading + PI + offset, reverse: true });
  choices.push({ heading: desired, halt: true }, { heading: me.heading, halt: true });
  let best = Infinity, result = null;
  const initialDistance = distance(me, tactical.point);
  for (const choice of choices) {
    const p = { x: me.x, y: me.y, speed: me.speed, heading: me.heading };
    let cost = 0, first = null;
    const risks = new Float64Array(threats.length);
    for (let i = 0; i < frames; i++) {
      const waypoint = choice.follow && tactical.next && (distance(p, tactical.point) < 5 || clear(p, tactical.next, 24.1)) ? tactical.next : tactical.point;
      const heading = choice.follow ? Math.atan2(waypoint.y - p.y, waypoint.x - p.x) : choice.heading;
      const halt = choice.halt || (choice.follow && !tactical.next && distance(p, waypoint) < 3);
      const a = control(p, heading, choice.reverse, st, halt);
      if (choice.follow && !tactical.next) a.throttle *= Math.min(1, Math.sqrt(840 * Math.max(0, distance(p, waypoint) - 1)) / st.maxSpeed);
      if (i === 0) first = a;
      if (move(p, a.throttle, a.turn, st)) cost += 1.5;
      const ed = distance(p, forecast[i + 1]);
      if (ed < 52) cost += (52 - ed) * 0.2;
      if (distance(p, s.zone) > zoneRadius(s, s.time + (i + 1) * DT) - 6) cost += 5;
      for (let j = 0; j < threats.length; j++) {
        const seg = threats[j].path[i];
        let d2 = Infinity;
        for (let k = 0; k < seg.length; k += 4) d2 = Math.min(d2, segmentDistance2(p.x, p.y, seg[k], seg[k + 1], seg[k + 2], seg[k + 3]));
        if (d2 < 65 * 65) {
          const d = Math.sqrt(d2);
          const risk = d < 30 ? 1 + (30 - d) * 0.03 : Math.exp(-(d - 30) / 9) * 0.6;
          risks[j] = Math.max(risks[j], risk * (1 - i * 0.009));
        }
      }
    }
    for (let j = 0; j < threats.length; j++) cost += risks[j] * threats[j].damage * 7;
    if (combat) {
      const e = forecast[frames], d = distance(p, e);
      cost += Math.max(0, Math.abs(d - tactical.range) - 35) * 0.045;
      if (d < 150) cost += (150 - d) * 0.09;
      const dx = p.x - me.x, dy = p.y - me.y;
      cost -= (dx * -Math.sin(bearing) + dy * Math.cos(bearing)) * orbit * 0.014;
      if (!clear(p, e, 7)) cost += me.reloadLeft < 0.25 ? 5 : 1;
      if (clear(p, e, 6) && enemy.reloadLeft < 0.6) {
        const lateral = Math.abs((p.x - me.x) * -Math.sin(bearing) + (p.y - me.y) * Math.cos(bearing));
        cost += Math.max(0, 60 - lateral) * 0.035;
      }
    } else {
      const remaining = tactical.next && clear(p, tactical.next, 24.1)
        ? distance(p, tactical.next) - distance(tactical.point, tactical.next) : distance(p, tactical.point);
      cost += (remaining - initialDistance) * 0.07;
      if (!clear(p, tactical.point, 24)) cost += 12;
    }
    if (choice.reverse) cost += 0.2;
    cost += Math.abs(first.turn) * 0.025;
    if (cost < best) { best = cost; result = { ...first, end: p }; }
  }
  if (combat && result) {
    const lateral = (result.end.x - me.x) * -Math.sin(bearing) + (result.end.y - me.y) * Math.cos(bearing);
    if (Math.abs(lateral) > 35) orbit = Math.sign(lateral);
  }
  return result || { throttle: 0, turn: 0 };
}

// Reflect the moving target in each face to solve legal one-bounce shots.
function aim(s, origin, forecast) {
  const { me, enemy } = s, speed = me.stats.bulletSpeed;
  let best = null;
  const consider = face => {
    let t = Math.max(0.01, (distance(origin, enemy) - 34) / speed), p, virtual, bounce;
    for (let i = 0; i < 4; i++) {
      // The new bullet already advances on the firing tick. Adding another
      // frame here systematically leads a moving target too far.
      p = predict(forecast, t); virtual = { ...p };
      if (face) {
        if (face.axis === 0) virtual.x = 2 * face.value - p.x;
        else virtual.y = 2 * face.value - p.y;
      }
      t = (distance(origin, virtual) - 34) / speed;
    }
    if (t < 0 || t > (face ? 2.25 : 2.5)) return;
    const a = Math.atan2(virtual.y - origin.y, virtual.x - origin.x);
    const muzzle = { x: origin.x + 34 * Math.cos(a), y: origin.y + 34 * Math.sin(a) };
    if (!free(muzzle.x, muzzle.y, 5.01)) return;
    if (face) {
      const denom = face.axis === 0 ? virtual.x - origin.x : virtual.y - origin.y;
      const k = (face.value - (face.axis === 0 ? origin.x : origin.y)) / denom;
      if (k <= 0.025 || k >= 0.975) return;
      bounce = { x: origin.x + k * (virtual.x - origin.x), y: origin.y + k * (virtual.y - origin.y) };
      const tangent = face.axis === 0 ? bounce.y : bounce.x;
      if (tangent < face.lo || tangent > face.hi || distance(origin, bounce) < 45) return;
      if (!clear(muzzle, bounce, 4.8) || !clear(bounce, p, 4.8)) return;
      if (segmentDistance2(origin.x, origin.y, bounce.x, bounce.y, p.x, p.y) < 45 * 45) return;
    } else if (!clear(muzzle, p, 5.2)) return;
    const score = t + Math.abs(angle(a - me.turret)) * 0.15 + (face ? 0.18 : 0);
    if (!best || score < best.score) best = { a, t, score, bounce, point: p };
  };
  consider(null);
  if (!best || (me.reloadLeft < 0.15 && best.t > 0.8)) for (const f of faces) consider(f);
  if (!best) {
    const p = predict(forecast, Math.min(1, distance(origin, enemy) / speed));
    return { turretTurn: clamp(angle(Math.atan2(p.y - origin.y, p.x - origin.x) - me.turret) / (2.8 * DT), -1, 1), fire: false };
  }
  const diff = angle(best.a - me.turret), turretTurn = clamp(diff / (2.8 * DT), -1, 1);
  const error = Math.abs(angle(best.a - me.turret - turretTurn * 2.8 * DT));
  const fire = me.reloadLeft <= DT + 1e-6 && error < Math.atan2(15, speed * best.t + 34);
  if (fire) shotCount++;
  return { turretTurn, fire };
}

export default {
  name: 'ПАРАЛЛАКС',
  motto: 'Ты целишься в прошлое.',
  stats: { armor: 2, engine: 1, gun: 2, reload: 5 },
  init(info) {
    buildMap(info.view); previous = null; enemyTurn = 0; enemyAcceleration = 0;
    target = null; navigationTick = -100; orbit = info.side ? -1 : 1;
    shotCount = 0; lastDamageTime = 0; lastHp = info.view.enemy.hp;
  },
  tick(s) {
    if (!target && !nodes.length) this.init({ view: s, side: s.side });
    if (previous && s.tick > previous.tick) {
      const dt = (s.tick - previous.tick) * s.dt;
      const turn = clamp(angle(s.enemy.heading - previous.heading) / dt, -s.enemy.stats.turnRate, s.enemy.stats.turnRate);
      enemyTurn = turn * 0.65 + enemyTurn * 0.35;
      enemyAcceleration = clamp((s.enemy.speed - previous.speed) / dt, -420, 420) * 0.6 + enemyAcceleration * 0.4;
    }
    previous = { tick: s.tick, heading: s.enemy.heading, speed: s.enemy.speed };
    if (s.enemy.hp < lastHp) lastDamageTime = s.time;
    lastHp = s.enemy.hp;
    if (s.tick - navigationTick >= 6 || !target || (target.kind !== 'fight' && distance(s.me, target.point) < 35)) {
      target = strategy(s); navigationTick = s.tick;
    }
    const forecast = enemyForecast(s);
    const movement = drive(s, target, forecast);
    const origin = { x: s.me.x, y: s.me.y, speed: s.me.speed, heading: s.me.heading };
    move(origin, movement.throttle, movement.turn, s.me.stats);
    const shot = aim(s, origin, forecast);
    return { throttle: movement.throttle, turn: movement.turn, turretTurn: shot.turretTurn, fire: shot.fire };
  },
};
