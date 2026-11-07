/* ha-timer: Lovelace card showing a clock that keeps counting into negative numbers. */
const pad2 = (n) => (n < 10 ? "0" : "") + n;

const isTimerId = (id) => id.indexOf("timer.") === 0;

const fmt = (sec) => {
  const neg = sec < 0;
  const s = Math.floor(Math.abs(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const p = pad2;
  const body = h > 0 ? `${h}:${p(m)}:${p(s % 60)}` : `${p(m)}:${p(s % 60)}`;
  return (neg ? "-" : "") + body;
};

const parseDuration = (v) => {
  if (typeof v === "number") return v;
  const parts = String(v).split(":").map(Number);
  if (parts.some(isNaN)) return 0;
  return parts.reduce((a, n) => a * 60 + n, 0);
};

class HaMtgTimerCard extends HTMLElement {
  setConfig(config) {
    if (!config.entity) throw new Error("You need to define an entity");
    this._config = Object.assign({}, config);
    this._key = `ha-timer:${config.entity}`;
    try {
      this._s = JSON.parse(localStorage.getItem(this._key)) || {};
    } catch (e) {
      this._s = {};
    }
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
      this.shadowRoot.innerHTML = `
        <style>
          ha-card { padding: 16px; text-align: center; }
          .name { font-weight: bold; font-size: var(--mtg-timer-name-font-size, var(--mtg-timer-font-size, 6rem)); color: var(--secondary-text-color); }
          .clock { font-size: var(--mtg-timer-font-size, 6rem); font-weight: 500;
                   font-variant-numeric: tabular-nums; color: var(--primary-text-color); }
          .clock.negative { color: var(--error-color, #db4437); }
          .clock.stopped { cursor: pointer; }
          .name { cursor: pointer; }
          input.edit { font: inherit; font-size: 4rem; width: 8ch; text-align: center;
                       background: var(--card-background-color); color: var(--primary-text-color);
                       border: 1px solid var(--divider-color); border-radius: 8px; }
          .controls { margin-top: 8px; display: flex; gap: 8px; justify-content: center; }
          button { font: inherit; font-size: 1.5rem; padding: 12px 28px; border-radius: 8px; border: none; cursor: pointer;
                   background: var(--primary-color); color: var(--text-primary-color, #fff); }
        </style>
        <ha-card>
          <div class="name"></div>
          <div class="clock"></div>
          <div class="controls"><button class="toggle">Start</button></div>
        </ha-card>`;
      this.shadowRoot.querySelector(".name").addEventListener("click", () => this._editName());
      this.shadowRoot.querySelector(".clock").addEventListener("click", () => this._edit());
      this.shadowRoot.querySelector(".toggle").addEventListener("click", () => this._toggle());
    }
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  connectedCallback() {
    this._interval = setInterval(() => this._render(), 250);
  }

  disconnectedCallback() {
    clearInterval(this._interval);
  }

  getCardSize() {
    return 2;
  }

  static getStubConfig() {
    return { entity: "timer.example" };
  }

  // Local state _s: lastEnd (ms, finish time seen while active), over ({end, frozen}) = overtime
  // phase after HA reset the finished timer to idle. frozen (seconds) is set while paused in overtime.
  _title_value() {
    const te = this._config.title_entity;
    if (te) {
      const st = this._hass && this._hass.states[te];
      return st && st.state !== "unknown" && st.state !== "unavailable" ? st.state : "";
    }
    return this._s.title;
  }

  _setTitle(v) {
    const te = this._config.title_entity;
    if (te) {
      this._hass.callService("input_text", "set_value", { entity_id: te, value: v });
      return;
    }
    const saveLocal = () => {
      if (v) this._s.title = v;
      else delete this._s.title;
      this._save();
    };
    if (isTimerId(this._config.entity) && !this._config.name) {
      // Rename the helper itself (admin only); other devices see the new friendly name.
      this._hass
        .callWS({ type: "config/entity_registry/update", entity_id: this._config.entity, name: v || null })
        .then(() => {
          delete this._s.title;
          this._save();
        });
      return;
    }
    saveLocal();
  }

  _title() {
    return this._s.title ? { title: this._s.title } : {};
  }

  _save() {
    try {
      localStorage.setItem(this._key, JSON.stringify(this._s));
    } catch (e) {
      /* ignore */
    }
  }

  // Returns { seconds, running } or null when unavailable.
  _compute() {
    const st = this._hass && this._hass.states[this._config.entity];
    if (!st) return null;
    const now = Date.now();
    const a = st.attributes;
    const domain = this._config.entity.split(".")[0];

    if (domain === "timer") {
      const s = this._s;
      if (st.state === "active" && a.finishes_at) {
        const end = new Date(a.finishes_at).getTime();
        if (s.lastEnd !== end || s.over) {
          this._s = Object.assign({}, this._s, { lastEnd: end });
          this._save();
        }
        return { seconds: (end - now) / 1000, running: true };
      }
      if (st.state === "paused") {
        if (s.lastEnd || s.over) {
          this._s = this._title();
          this._save();
        }
        return { seconds: parseDuration(a.remaining || 0), running: false };
      }
      // idle: either never started, or finished and now counting into negatives locally
      if (!s.over && s.lastEnd && s.lastEnd <= now + 1000) {
        this._s = Object.assign({}, this._title(), { over: { end: s.lastEnd, frozen: null } });
        this._save();
      }
      const over = this._s.over;
      if (over) {
        if (over.frozen !== null) return { seconds: over.frozen, running: false };
        return { seconds: (over.end - now) / 1000, running: true };
      }
      return { seconds: parseDuration(a.duration || 0), running: false };
    }

    // input_datetime / sensor with a timestamp: count to that moment, then go negative.
    let end;
    if (domain === "input_datetime" && a.timestamp !== undefined && a.has_date && a.has_time) {
      end = a.timestamp * 1000;
    } else {
      end = new Date(st.state).getTime();
    }
    if (isNaN(end)) return null;
    return { seconds: (end - now) / 1000, running: true, noControls: true };
  }

  _call(service, data = {}) {
    this._hass.callService("timer", service, Object.assign({ entity_id: this._config.entity }, data));
  }

  _toggle() {
    const r = this._compute();
    const st = this._hass.states[this._config.entity];
    if (!r || !st) return;
    const over = this._s.over;
    if (r.running) {
      if (over) {
        over.frozen = (over.end - Date.now()) / 1000;
        this._save();
      } else {
        this._call("pause");
      }
    } else if (over) {
      over.end = Date.now() + over.frozen * 1000;
      over.frozen = null;
      this._save();
    } else {
      const data = {};
      if (st.state === "idle" && this._config.duration) data.duration = this._config.duration;
      this._call("start", data);
    }
    this._render();
  }

  // Click the clock to type a new time; the timer is then set to it and stopped (ss, mm:ss or h:mm:ss).
  _edit() {
    const r = this._compute();
    if (this._editing || !r || r.noControls) return;
    this._editing = true;
    const clock = this.shadowRoot.querySelector(".clock");
    const input = document.createElement("input");
    input.className = "edit";
    input.placeholder = "mm:ss";
    input.value = fmt(Math.max(0, r.seconds));
    clock.style.display = "none";
    clock.parentNode.insertBefore(input, clock.nextSibling);
    input.focus();
    input.select();
    const done = (apply) => {
      if (!this._editing) return;
      this._editing = false;
      const v = input.value.trim();
      input.parentNode.removeChild(input);
      clock.style.display = "";
      const secs = parseDuration(v);
      if (apply && v && secs > 0) this._setRemaining(secs);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") done(true);
      else if (e.key === "Escape") done(false);
    });
    input.addEventListener("blur", () => done(true));
  }

  // Click the title to rename; an empty value restores the default. Stored in localStorage.
  _editName() {
    if (this._editing) return;
    this._editing = true;
    const nameEl = this.shadowRoot.querySelector(".name");
    const input = document.createElement("input");
    input.className = "edit";
    input.style.width = "100%";
    input.style.boxSizing = "border-box";
    input.value = nameEl.textContent;
    nameEl.style.display = "none";
    nameEl.parentNode.insertBefore(input, nameEl.nextSibling);
    input.focus();
    input.select();
    const done = (apply) => {
      if (!this._editing) return;
      this._editing = false;
      const v = input.value.trim();
      input.parentNode.removeChild(input);
      if (apply) this._setTitle(v);
      this._render();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") done(true);
      else if (e.key === "Escape") done(false);
    });
    input.addEventListener("blur", () => done(true));
  }

  _setRemaining(secs) {
    this._s = this._title();
    this._save();
    const p = pad2;
    const duration = `${p(Math.floor(secs / 3600))}:${p(Math.floor((secs % 3600) / 60))}:${p(secs % 60)}`;
    this._call("start", { duration });
    setTimeout(() => this._call("pause"), 300);
  }

  _render() {
    if (!this._config || !this.shadowRoot || this._editing) return;
    const r = this._compute();
    const st = this._hass && this._hass.states[this._config.entity];
    const name = this._title_value() || this._config.name || (st && st.attributes.friendly_name) || "";
    const nameEl = this.shadowRoot.querySelector(".name");
    nameEl.textContent = name;
    nameEl.style.display = this._config.hide_name || !name ? "none" : "";
    const clock = this.shadowRoot.querySelector(".clock");
    clock.textContent = r ? fmt(r.seconds) : "--:--";
    clock.classList.toggle("negative", !!r && r.seconds <= -1);
    clock.classList.toggle("stopped", !!r && !r.noControls);
    const isTimer = isTimerId(this._config.entity);
    const controls = this.shadowRoot.querySelector(".controls");
    controls.style.display = isTimer && !this._config.hide_controls && r && !r.running ? "" : "none";
      }
}

customElements.define("ha-timer-card", HaMtgTimerCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: "ha-timer-card",
  name: "MTG Timer Card",
  description: "Countdown clock that continues into negative numbers.",
});
