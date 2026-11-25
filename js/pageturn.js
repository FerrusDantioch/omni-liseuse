/* ============================================================
   TOURNEPAGE EN FEUILLE PLIÉE ET GESTES TACTILES / SOURIS
   ============================================================ */

import {
  $,
  LONG_PRESS_DELAY,
  anyOverlayOpen,
  clamp,
  showToast,
  state
} from "./state.js";

const TURN_COMPLETE_RATIO = 0.28; /* part tournée au-delà de laquelle la page passe */
const TURN_FLICK_SPEED = 0.35;    /* px/ms : un geste vif tourne la page */
const TURN_TAP_DURATION = 560;    /* ms : page tournée par un toucher ou une touche */
const SYSTEM_EDGE = 32;           /* px en bas d'écran réservés au geste système */

const easeOut = t => 1 - Math.pow(1 - t, 3);
const easeInOut = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
export const prefersReducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function clipPolygon(points, distance, sign) {
  const result = [];

  for (let index = 0; index < points.length; index++) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const da = sign * distance(a[0], a[1]);
    const db = sign * distance(b[0], b[1]);

    if (da >= 0) result.push(a);

    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      result.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }

  return result;
}

function polygonCss(points) {
  if (points.length < 3) return "polygon(0 0, 0 0, 0 0)";
  return `polygon(${points.map(([x, y]) => `${x.toFixed(1)}px ${y.toFixed(1)}px`).join(",")})`;
}

function takeSnapshot(engine) {
  try { return engine.snapshot?.() || null; } catch (_) { return null; }
}

function blankPaper() {
  const blank = document.createElement("div");
  blank.className = "turn-blank";
  return blank;
}

export class PageTurn {
  constructor(engine, direction, options = {}) {
    const surface = $("readerSurface");

    this.engine = engine;
    this.direction = direction;
    this.width = Math.max(1, surface.clientWidth);
    this.height = Math.max(1, surface.clientHeight);
    this.cornerY = typeof options.grabY === "number" && options.grabY < this.height / 2 ? 0 : this.height;
    this.live = options.live !== false;
    this.previous = options.previous || null;

    this.progress = direction > 0 ? 0 : 1;
    this.dy = 0;
    this.offset = 0;
    this.started = false;
    this.aborted = false;
    this.hurried = false;
    this.blocked = false;
    this.error = null;
    this.frame = 0;
    this.drawQueued = false;
    this.done = null;

    this.ready = this.prepare();
  }

  async prepare() {
    if (this.previous) {
      this.previous.hurry();
      await this.previous.finished();
    }

    if (this.aborted || state.current?.engine !== this.engine) return;

    if (this.engine.canGo && !this.engine.canGo(this.direction)) {
      this.blocked = true;
      return;
    }

    const layer = $("turnLayer");
    const page = takeSnapshot(this.engine);

    layer.classList.toggle("pdf", Boolean(this.engine?.isPdf));
    layer.classList.add("active");
    this.started = true;

    if (this.direction > 0) {
      this.setSheet(page, takeSnapshot(this.engine));
      this.setUnder(this.live ? null : blankPaper());
      this.render();
      if (this.live) await this.move(1);
    } else {
      this.setUnder(page || blankPaper());
      this.setSheet(null, null);
      this.render();
      if (this.live) await this.move(-1);
    }
  }

  async move(direction) {
    try {
      await this.engine.go(direction);
      this.offset += direction;
      if (direction > 0) this.setUnder(null);
      else this.setSheet(takeSnapshot(this.engine), takeSnapshot(this.engine));
    } catch (error) {
      this.error = error;
    }
  }

  setSheet(front, ghost) {
    $("turnSheet").replaceChildren(front || blankPaper());
    $("turnGhost").replaceChildren(...(ghost ? [ghost] : []));
  }

  setUnder(node) {
    $("turnUnder").replaceChildren(...(node ? [node] : []));
    $("turnUnder").hidden = !node;
  }

  drag(dx, dy) {
    if (this.done) return;

    this.progress = this.direction > 0
      ? clamp(-dx / this.width, 0, 1)
      : clamp(1 - dx / this.width, 0, 1);
    this.dy = dy;

    if (!this.drawQueued) {
      this.drawQueued = true;
      requestAnimationFrame(() => {
        this.drawQueued = false;
        if (!this.done) this.render();
      });
    }
  }

  render() {
    if (!this.started || this.aborted) return;

    const W = this.width;
    const H = this.height;
    const p = this.progress;
    const fromBottom = this.cornerY === H;

    const lift = Math.sin(Math.PI * p) * H * 0.08;
    let x = W - 2 * W * p;
    let y = this.cornerY + (fromBottom ? -lift : lift) + clamp(this.dy * 0.5, -H * 0.3, H * 0.3);
    y = fromBottom ? Math.min(H, y) : Math.max(0, y);

    const keepWithin = (ax, ay, radius) => {
      const distance = Math.hypot(x - ax, y - ay);
      if (distance > radius) {
        x = ax + (x - ax) * radius / distance;
        y = ay + (y - ay) * radius / distance;
      }
    };

    keepWithin(0, this.cornerY, W);
    keepWithin(0, H - this.cornerY, Math.hypot(W, H));

    const sheet = $("turnSheet");
    const flapWrap = $("turnFlapWrap");
    const shade = $("turnShade");
    const vx = W - x;
    const vy = this.cornerY - y;
    const length = Math.hypot(vx, vy);

    if (length < 0.5) {
      sheet.style.clipPath = "none";
      flapWrap.style.visibility = "hidden";
      shade.style.opacity = "0";
      return;
    }

    const nx = vx / length;
    const ny = vy / length;
    const mx = (W + x) / 2;
    const my = (this.cornerY + y) / 2;
    const side = (px, py) => (px - mx) * nx + (py - my) * ny;
    const page = [[0, 0], [W, 0], [W, H], [0, H]];
    const flat = clipPolygon(page, side, -1);
    const lifted = clipPolygon(page, side, 1);
    const reach = Math.max(1, ...lifted.map(([px, py]) => side(px, py)));
    const diagonal = Math.hypot(W, H);
    const angle = Math.atan2(ny, nx);
    const alongFold = `translate(${mx.toFixed(1)}px,${my.toFixed(1)}px) rotate(${angle}rad) translate(0,${-diagonal}px)`;

    sheet.style.clipPath = polygonCss(flat);

    const k = mx * nx + my * ny;
    const flap = $("turnFlap");
    flap.style.transform =
      `matrix(${1 - 2 * nx * nx},${-2 * nx * ny},${-2 * nx * ny},${1 - 2 * ny * ny},${2 * k * nx},${2 * k * ny})`;
    flap.style.clipPath = polygonCss(lifted);
    flapWrap.style.visibility = "visible";

    const flapShade = $("turnFlapShade");
    flapShade.style.width = reach + "px";
    flapShade.style.height = 2 * diagonal + "px";
    flapShade.style.transform = alongFold;

    shade.style.width = clamp(reach * 0.55, 14, W * 0.32) + "px";
    shade.style.height = 2 * diagonal + "px";
    shade.style.transform = alongFold;
    shade.style.opacity = String(Math.min(1, 2.4 * Math.sin(Math.PI * clamp(p, 0, 1))));
  }

  animateTo(target, duration, easing) {
    return new Promise(resolve => {
      const from = this.progress;
      const fromDy = this.dy;
      const start = performance.now();

      const step = now => {
        if (this.aborted) return resolve();

        const t = this.hurried ? 1 : clamp((now - start) / duration, 0, 1);
        const eased = easing(t);
        this.progress = from + (target - from) * eased;
        this.dy = fromDy * (1 - eased);
        this.render();

        if (t < 1) this.frame = requestAnimationFrame(step);
        else resolve();
      };

      this.frame = requestAnimationFrame(step);
    });
  }

  release(velocity = 0) {
    const toward = this.direction > 0 ? -velocity : velocity;
    const amount = this.direction > 0 ? this.progress : 1 - this.progress;
    let complete = amount > TURN_COMPLETE_RATIO || toward > TURN_FLICK_SPEED;
    if (toward < -TURN_FLICK_SPEED * 0.6) complete = false;
    return this.settle(complete, Math.abs(velocity), false);
  }

  play() {
    return this.settle(true, 0, true);
  }

  settle(complete, speed, automatic) {
    if (this.done) return this.done;

    this.done = (async () => {
      if (!this.started) await this.ready;

      if (this.blocked || this.aborted) {
        if (this.blocked && !this.aborted) edgeFeedback(this.direction);
        return;
      }

      if (this.error) complete = false;

      const target = complete === (this.direction > 0) ? 1 : 0;
      const distance = Math.abs(target - this.progress);
      let duration = automatic ? TURN_TAP_DURATION : clamp(distance * 620, 150, 480);
      if (!automatic && speed > 0.6) duration = Math.max(130, duration * 0.7);

      const moving = complete && !this.live ? this.move(this.direction) : null;
      await this.animateTo(target, duration, automatic ? easeInOut : easeOut);
      await this.ready;
      if (moving) await moving;

      if (!complete && this.offset && !this.aborted) {
        try { await this.engine.go(-this.offset); } catch (_) {}
        this.offset = 0;
      }

      if (this.error && !this.aborted) {
        showToast("Page illisible : " + this.error.message, 6000, true);
      }
    })().finally(() => this.cleanup());

    return this.done;
  }

  hurry() {
    this.hurried = true;
    if (!this.done) this.settle(this.direction > 0 ? this.progress > 0.5 : this.progress < 0.5, 0, false);
  }

  finished() {
    return (this.done || this.ready).catch(() => {});
  }

  abort() {
    this.aborted = true;
    this.cleanup();
  }

  cleanup() {
    cancelAnimationFrame(this.frame);
    if (state.activeTurn === this) state.activeTurn = null;
    if (!this.started) return;

    this.started = false;
    const layer = $("turnLayer");
    layer.classList.remove("active", "pdf");
    $("turnSheet").replaceChildren();
    $("turnSheet").style.clipPath = "";
    $("turnGhost").replaceChildren();
    $("turnFlapWrap").style.visibility = "hidden";
    $("turnShade").style.opacity = "0";
    this.setUnder(null);
  }
}

export function edgeFeedback(direction) {
  if (!prefersReducedMotion()) {
    const surface = $("readerSurface");
    surface.animate?.([
      { transform: "translateX(0)" },
      { transform: `translateX(${direction > 0 ? -14 : 14}px)` },
      { transform: "translateX(0)" }
    ], { duration: 260, easing: "ease-out" });
  }
  showToast(direction > 0 ? "Dernière page du livre." : "Première page du livre.", 1600);
}

function rubberBand(dx) {
  const offset = Math.sign(dx) * Math.min(40, Math.abs(dx) * 0.2);
  $("readerSurface").style.transform = `translateX(${offset}px)`;
}

export function resetRubberBand(animated = false) {
  const surface = $("readerSurface");
  const from = surface.style.transform;
  surface.style.transform = "";

  if (animated && from && !prefersReducedMotion() && surface.animate) {
    surface.animate([{ transform: from }, { transform: "translateX(0)" }], {
      duration: 220,
      easing: "ease-out"
    });
  }
}

export async function navigate(direction) {
  const engine = state.current?.engine;
  if (!engine || state.opening) return;

  if (!state.activeTurn && engine.canGo && !engine.canGo(direction)) {
    edgeFeedback(direction);
    return;
  }

  if (prefersReducedMotion()) {
    if (state.navigationBusy) return;
    state.navigationBusy = true;
    try { await engine.go(direction); }
    catch (error) { showToast("Page illisible : " + error.message, 6000, true); }
    finally { state.navigationBusy = false; }
    return;
  }

  const turn = new PageTurn(engine, direction, { previous: state.activeTurn });
  state.activeTurn = turn;
  await turn.play();
}

export function stopTurns() {
  state.gesture = null;
  state.activeTurn?.abort();
  state.activeTurn = null;
  resetRubberBand();
}

/* ============================================================
   GESTES PARTAGÉS STAGE + IFRAME EPUB
   ============================================================ */

function gestureStart(x, y, pointerId, fromFrame) {
  if (!state.current?.engine || state.opening) return false;
  if (anyOverlayOpen()) return false;
  if (y > window.innerHeight - SYSTEM_EDGE) return false;

  if (state.gesture) gestureEnd(state.gesture.lastX, state.gesture.lastY, state.gesture.pointerId, true);

  const now = performance.now();
  const currentGesture = {
    pointerId,
    fromFrame,
    x0: x,
    y0: y,
    lastX: x,
    lastY: y,
    t0: now,
    mode: "pending",
    samples: [{ x, t: now }],
    turn: null,
    direction: 0,
    pressTimer: 0
  };
  state.gesture = currentGesture;

  currentGesture.pressTimer = setTimeout(() => {
    if (state.gesture !== currentGesture || currentGesture.mode !== "pending") return;
    currentGesture.mode = "ignore";
    state.hooks.beginSelection?.(currentGesture.x0, currentGesture.y0);
  }, LONG_PRESS_DELAY);

  return true;
}

function beginDrag(gestureState, direction) {
  const engine = state.current.engine;
  gestureState.direction = direction;
  $("readerStage").classList.add("dragging");

  try { window.getSelection()?.removeAllRanges(); } catch (_) {}

  if (prefersReducedMotion()) {
    gestureState.mode = "swipe";
    return;
  }

  if (!state.activeTurn && engine.canGo && !engine.canGo(direction)) {
    gestureState.mode = "edge";
    return;
  }

  const surfaceTop = $("readerSurface").getBoundingClientRect().top;
  const live = !gestureState.fromFrame || !engine.staysInSection || engine.staysInSection(direction);

  gestureState.turn = new PageTurn(engine, direction, {
    grabY: gestureState.y0 - surfaceTop,
    live,
    previous: state.activeTurn
  });
  state.activeTurn = gestureState.turn;
  gestureState.mode = "turn";
}

function gestureMove(x, y, pointerId) {
  const gestureState = state.gesture;
  if (!gestureState || gestureState.pointerId !== pointerId) return;

  const now = performance.now();
  gestureState.lastX = x;
  gestureState.lastY = y;
  gestureState.samples.push({ x, t: now });
  while (gestureState.samples.length > 2 && now - gestureState.samples[0].t > 100) {
    gestureState.samples.shift();
  }

  const dx = x - gestureState.x0;
  const dy = y - gestureState.y0;

  if (gestureState.mode === "pending") {
    if (Math.hypot(dx, dy) < 10) return;
    clearTimeout(gestureState.pressTimer);

    const horizontal = Math.abs(dx) > Math.abs(dy) * 1.2;
    const pdfScrolls = !gestureState.fromFrame && state.current.engine.pansHorizontally?.();

    if (!horizontal || pdfScrolls) {
      gestureState.mode = "ignore";
      return;
    }

    beginDrag(gestureState, dx < 0 ? 1 : -1);
  }

  if (gestureState.mode === "turn") gestureState.turn.drag(dx, dy);
  else if (gestureState.mode === "edge") rubberBand(dx);
}

function gestureEnd(x, y, pointerId, cancelled, onLink = false) {
  const gestureState = state.gesture;
  if (!gestureState || gestureState.pointerId !== pointerId) return;

  state.gesture = null;
  clearTimeout(gestureState.pressTimer);
  $("readerStage").classList.remove("dragging");

  const first = gestureState.samples[0];
  const last = gestureState.samples[gestureState.samples.length - 1];
  const velocity = last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
  const dx = (cancelled ? gestureState.lastX : x) - gestureState.x0;

  if (gestureState.mode === "pending") {
    if (!cancelled && !onLink && performance.now() - gestureState.t0 < 650) {
      state.hooks.handleTap?.(x, y);
    }
  } else if (gestureState.mode === "turn") {
    void gestureState.turn.release(cancelled ? 0 : velocity);
  } else if (gestureState.mode === "edge") {
    resetRubberBand(true);
    if (!cancelled) edgeFeedback(gestureState.direction);
  } else if (gestureState.mode === "swipe" && !cancelled) {
    if (Math.abs(dx) > 45 || Math.abs(velocity) > TURN_FLICK_SPEED) {
      void navigate(gestureState.direction);
    }
  }
}

export function setupGestures() {
  const stage = $("readerStage");

  stage.addEventListener("pointerdown", event => {
    if (event.button !== 0 || !event.isPrimary) return;

    if (gestureStart(event.clientX, event.clientY, event.pointerId, false)) {
      try { stage.setPointerCapture(event.pointerId); } catch (_) {}
    }
  });

  stage.addEventListener("pointermove", event => {
    gestureMove(event.clientX, event.clientY, event.pointerId);
  });

  stage.addEventListener("pointerup", event => {
    gestureEnd(event.clientX, event.clientY, event.pointerId, false);
  });

  stage.addEventListener("pointercancel", event => {
    gestureEnd(event.clientX, event.clientY, event.pointerId, true);
  });
}

export function bindEpubGestures(doc) {
  const outer = event => {
    const rect = doc.defaultView?.frameElement?.getBoundingClientRect();
    return {
      x: (rect?.left || 0) + event.clientX,
      y: (rect?.top || 0) + event.clientY
    };
  };

  doc.addEventListener("pointerdown", event => {
    if (event.button !== 0 || !event.isPrimary) return;
    const point = outer(event);

    if (gestureStart(point.x, point.y, event.pointerId, true)) {
      try { event.target.setPointerCapture?.(event.pointerId); } catch (_) {}
    }
  });

  doc.addEventListener("pointermove", event => {
    const point = outer(event);
    gestureMove(point.x, point.y, event.pointerId);
  });

  doc.addEventListener("pointerup", event => {
    const point = outer(event);
    const onLink = Boolean(event.target.closest?.("a[href]"));
    gestureEnd(point.x, point.y, event.pointerId, false, onLink);
  });

  doc.addEventListener("pointercancel", event => {
    const point = outer(event);
    gestureEnd(point.x, point.y, event.pointerId, true);
  });

  doc.addEventListener("keydown", event => state.hooks.handleReaderKey?.(event));
}
