// ChatJevPT themes: "modern" (the default) and "y2k".
//
// Switching only flips <html data-ui-theme="y2k"> and saves the choice, so the
// chat, an answer that's still typing, the input and the cost meter are never
// touched. The inline script in index.html's <head> applies the saved theme
// before first paint; this file adds the switch, the mute button, the Y2K-only
// decorations, the sparkle cursor trail and the WebAudio sound effects.
//
// app.js tells us what happened through window CustomEvents:
//   jev:send, jev:char (detail: char), jev:done (detail: {spicy}),
//   jev:rated (detail: label), jev:error
(() => {
  const root = document.documentElement;
  const THEME_KEY = "jev-ui-theme";
  const SOUND_KEY = "jev-sound";

  const store = {
    get(key) {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch {}
    },
  };

  const isY2K = () => root.dataset.uiTheme === "y2k";
  let soundOn = store.get(SOUND_KEY) !== "off";
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");

  // ---- Controls -----------------------------------------------------------

  const controls = document.createElement("div");
  controls.className = "theme-controls";
  controls.innerHTML = `
    <button type="button" class="theme-switch" id="theme-switch" aria-label="Y2K theme" title="Switch between the Modern and Y2K looks">
      <span class="to-y2k">✨ Y2K</span><span class="to-modern">Modern</span>
    </button>
    <button type="button" class="sound-toggle" id="sound-toggle" aria-label="Sound effects" title="Sound effects on/off">
      <span class="sound-on" aria-hidden="true">🔊</span><span class="sound-off" aria-hidden="true">🔇</span>
    </button>`;
  const themeSwitch = controls.querySelector("#theme-switch");
  const soundToggle = controls.querySelector("#sound-toggle");

  function syncControls() {
    themeSwitch.setAttribute("aria-pressed", String(isY2K()));
    soundToggle.setAttribute("aria-pressed", String(soundOn));
    root.classList.toggle("y2k-muted", !soundOn);
  }

  function setTheme(theme) {
    if (theme === "y2k") root.dataset.uiTheme = "y2k";
    else delete root.dataset.uiTheme;
    store.set(THEME_KEY, theme);
    syncControls();
  }

  themeSwitch.addEventListener("click", () => {
    setTheme(isY2K() ? "modern" : "y2k");
    if (isY2K()) sounds.boot();
  });

  soundToggle.addEventListener("click", () => {
    soundOn = !soundOn;
    store.set(SOUND_KEY, soundOn ? "on" : "off");
    syncControls();
    if (soundOn) sounds.unmute();
  });

  // ---- Y2K-only decorations (hidden in Modern by y2k.css) ------------------

  function hits() {
    let n = Number(store.get("jev-y2k-hits")) || 0;
    store.set("jev-y2k-hits", String(++n));
    return String(1337 + n * 7).padStart(7, "0");
  }

  const marquee = document.createElement("div");
  marquee.className = "y2k-only y2k-marquee";
  marquee.setAttribute("aria-hidden", "true");
  const marqueeText =
    "★彡 WeLcOmE 2 ChatJevPT 2000!!! 彡★ The ONLY chatbot that spells 1 letter at a time ★ " +
    "Now with 200 characters!!! ★ Sign my guestbook ★ Y2K compliant ★ ";
  marquee.innerHTML = `<div class="y2k-marquee-track"><span>${marqueeText}</span><span>${marqueeText}</span></div>`;

  const footer = document.createElement("footer");
  footer.className = "y2k-only y2k-footer";
  footer.setAttribute("aria-hidden", "true");
  footer.innerHTML = `
    <hr class="y2k-hr" />
    <p class="y2k-construction"><span>🚧</span> This site is UNDER CONSTRUCTION!! pardon our dust <span>👷</span></p>
    <p class="y2k-counter-row">You are visitor #<span class="y2k-counter">${hits()
      .split("")
      .map((d) => `<b>${d}</b>`)
      .join("")}</span></p>
    <div class="y2k-badges">
      <span class="b-netscape">Netscape<br />NOW!</span>
      <span class="b-800">Best viewed in<br />800x600</span>
      <span class="b-y2k">Y2K<br />COMPLIANT</span>
      <span class="b-notepad">Made with<br />Notepad</span>
    </div>
    <p class="y2k-webring">&lt;&lt; Prev · <u>JevRing</u> · Random · Next &gt;&gt;</p>
    <p class="y2k-updated">Last updated 12/31/1999 · Sign my guestbook!! 📖 · ©1999 Jev's Homepage</p>`;

  function mount() {
    const topbar = document.querySelector(".topbar");
    if (topbar) {
      // Before the account menu if there is one, otherwise at the end.
      const account = topbar.querySelector(".account");
      topbar.insertBefore(controls, account ?? null);
      topbar.after(marquee);
    }
    const main = document.getElementById("main");
    if (main) main.after(footer);
    syncControls();
  }

  // ---- Sparkle cursor trail (Y2K, mouse only, not with reduced motion) ------

  const SPARKS = ["✦", "✧", "★", "✩", "·", "✶"];
  let lastSpark = 0;
  let liveSparks = 0;
  document.addEventListener(
    "pointermove",
    (event) => {
      if (!isY2K() || event.pointerType !== "mouse" || !finePointer.matches || reducedMotion.matches) return;
      const now = performance.now();
      if (now - lastSpark < 35 || liveSparks > 24) return;
      lastSpark = now;
      const spark = document.createElement("span");
      spark.className = "y2k-sparkle";
      spark.setAttribute("aria-hidden", "true");
      spark.textContent = SPARKS[(Math.random() * SPARKS.length) | 0];
      spark.style.left = `${event.clientX + (Math.random() * 12 - 6)}px`;
      spark.style.top = `${event.clientY + (Math.random() * 12 - 6)}px`;
      spark.style.color = `hsl(${(Math.random() * 360) | 0} 100% 65%)`;
      liveSparks++;
      const done = () => {
        if (!spark.isConnected) return;
        spark.remove();
        liveSparks--;
      };
      spark.addEventListener("animationend", done);
      setTimeout(done, 1200);
      document.body.append(spark);
    },
    { passive: true },
  );

  // ---- Sound effects (Y2K only, synthesized, after a user gesture) ---------

  let unlocked = false;
  let ctx = null;
  let master = null;
  let noiseBuffer = null;

  function audio() {
    if (!isY2K() || !soundOn || !unlocked) return null;
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try {
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = 0.6;
        master.connect(ctx.destination);
      } catch {
        ctx = null;
        return null;
      }
    }
    if (ctx.state === "suspended") {
      try {
        ctx.resume()?.catch?.(() => {});
      } catch {}
    }
    return ctx;
  }

  // Browsers only let audio start after the person does something.
  const unlock = (event) => {
    if (!event.isTrusted) return;
    unlocked = true;
    audio(); // creates/resumes inside the gesture (Safari needs that)
  };
  document.addEventListener("pointerdown", unlock, true);
  document.addEventListener("keydown", unlock, true);

  function tone({ freq, to, type = "sine", at = 0, dur = 0.15, vol = 0.15, attack = 0.006, vibrato = 0 }) {
    const c = audio();
    if (!c) return;
    const t = c.currentTime + at;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain);
    gain.connect(master);
    if (vibrato) {
      const lfo = c.createOscillator();
      const depth = c.createGain();
      lfo.frequency.value = 6;
      depth.gain.value = vibrato;
      lfo.connect(depth);
      depth.connect(osc.frequency);
      lfo.start(t);
      lfo.stop(t + dur + 0.05);
    }
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  function noise({ at = 0, dur = 0.3, vol = 0.1, type = "bandpass", freq = 1000, to, q = 1 }) {
    const c = audio();
    if (!c) return;
    if (!noiseBuffer) {
      noiseBuffer = c.createBuffer(1, c.sampleRate, c.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    const t = c.currentTime + at;
    const src = c.createBufferSource();
    src.buffer = noiseBuffer;
    const filter = c.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(freq, t);
    if (to) filter.frequency.exponentialRampToValueAtTime(to, t + dur);
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    src.start(t);
    src.stop(t + Math.min(dur + 0.05, 1));
  }

  const notes = (list, opts) => {
    let at = 0;
    for (const [freq, dur] of list) {
      tone({ ...opts, freq, at, dur: dur * 1.1 });
      at += dur;
    }
  };

  let lastBlip = 0;
  const sounds = {
    blip(char) {
      const now = performance.now();
      if (now - lastBlip < 60 || !char || !char.trim()) return;
      lastBlip = now;
      const code = char.toLowerCase().charCodeAt(0);
      tone({ freq: 480 + ((code * 37) % 420) + Math.random() * 60, type: "square", dur: 0.035, vol: 0.02 });
    },
    send() {
      // Dial-up handshake, abridged: two chirps and a hiss.
      tone({ freq: 1150, to: 2300, type: "sine", dur: 0.12, vol: 0.07 });
      tone({ freq: 2100, type: "square", at: 0.13, dur: 0.06, vol: 0.025 });
      tone({ freq: 1650, type: "square", at: 0.2, dur: 0.06, vol: 0.025 });
      noise({ at: 0.05, dur: 0.35, vol: 0.05, freq: 500, to: 4500, q: 2 });
    },
    done() {
      tone({ freq: 1318.5, dur: 0.6, vol: 0.09 });
      tone({ freq: 1975.5, dur: 0.45, vol: 0.035, at: 0.01 });
    },
    sizzle() {
      noise({ dur: 0.9, vol: 0.07, type: "highpass", freq: 3500 });
      for (let i = 0; i < 9; i++) noise({ at: Math.random() * 0.75, dur: 0.04, vol: 0.12, type: "highpass", freq: 2000 });
      tone({ freq: 220, to: 70, type: "sawtooth", at: 0.05, dur: 0.5, vol: 0.03 });
    },
    error() {
      for (const freq of [233.1, 246.9, 349.2]) tone({ freq, type: "square", dur: 0.5, vol: 0.035 });
      tone({ freq: 160, to: 70, at: 0.02, dur: 0.3, vol: 0.12 });
    },
    rated(label) {
      switch (label) {
        case "Terrible": // sad trombone
          notes([[392, 0.34], [370, 0.34], [349.2, 0.34]], { type: "sawtooth", vol: 0.045 });
          tone({ freq: 329.6, at: 1.02, dur: 1.0, type: "sawtooth", vol: 0.045, vibrato: 7 });
          break;
        case "Bad":
          notes([[440, 0.16], [349.2, 0.3]], { type: "triangle", vol: 0.09 });
          break;
        case "Solid":
          notes([[660, 0.1], [660, 0.16]], { type: "sine", vol: 0.08 });
          break;
        case "Good":
          notes([[523.3, 0.12], [784, 0.25]], { type: "triangle", vol: 0.1 });
          break;
        case "Perfect": // fanfare
          notes([[523.3, 0.11], [523.3, 0.11], [523.3, 0.11], [659.3, 0.32], [523.3, 0.16], [784, 0.5]], { type: "square", vol: 0.04 });
          for (const freq of [392, 523.3, 1046.5]) tone({ freq, type: "triangle", at: 0.97, dur: 0.6, vol: 0.05 });
          break;
      }
    },
    boot() {
      // A "you've got Y2K" startup chord.
      [311.1, 392, 466.2, 622.3, 784].forEach((freq, i) => tone({ freq, type: "triangle", at: i * 0.07, dur: 1.1 - i * 0.07, vol: 0.05 }));
    },
    unmute() {
      tone({ freq: 880, to: 1760, dur: 0.12, vol: 0.06 });
    },
  };

  let lastError = -Infinity;
  window.addEventListener("jev:send", () => sounds.send());
  window.addEventListener("jev:char", (event) => sounds.blip(event.detail));
  window.addEventListener("jev:error", () => {
    lastError = performance.now();
    sounds.error();
  });
  window.addEventListener("jev:done", (event) => {
    if (event.detail?.spicy) return sounds.sizzle();
    if (performance.now() - lastError < 500) return; // the error chord already played
    sounds.done();
  });
  window.addEventListener("jev:rated", (event) => sounds.rated(event.detail));

  // Another tab switched themes: follow along.
  window.addEventListener("storage", (event) => {
    if (event.key === THEME_KEY) {
      if (event.newValue === "y2k") root.dataset.uiTheme = "y2k";
      else delete root.dataset.uiTheme;
      syncControls();
    } else if (event.key === SOUND_KEY) {
      soundOn = event.newValue !== "off";
      syncControls();
    }
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
