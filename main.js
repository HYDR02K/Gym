'use strict';

const {
  Plugin,
  ItemView,
  Modal,
  Setting,
  PluginSettingTab,
  Notice,
  normalizePath,
  moment,
} = require('obsidian');

const VIEW_TYPE_FITNESS = 'fitness-tracker-view';

const TABLE_HEADER = '| Exercise | Set | Weight | Reps |\n| --- | --- | --- | --- |';

const DEFAULT_SETTINGS = {
  folder: 'Fitness/Logs',
  unit: 'kg',
  weekStart: 1, // 0 = Sunday, 1 = Monday
  metric: 'volume', // volume | sets | done
  accent: '#5b8def',
  statsLimit: 8,
  statsWindow: 90, // days of history used for the stats table
  glass: true,
};

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

function parseSetTable(content) {
  const out = [];
  const lines = content.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    const cells = line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());
    if (cells.length < 4) continue;
    if (/^:?-{2,}/.test(cells[0])) continue;
    if (/^exercise$/i.test(cells[0])) continue;
    const weight = parseFloat(cells[2]);
    const reps = parseInt(cells[3], 10);
    if (!cells[0]) continue;
    if (Number.isNaN(weight) && Number.isNaN(reps)) continue;
    out.push({
      exercise: cells[0],
      set: cells[1],
      weight: Number.isNaN(weight) ? 0 : weight,
      reps: Number.isNaN(reps) ? 0 : reps,
    });
  }
  return out;
}

function dateFromName(basename) {
  const m = basename.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/* ------------------------------------------------------------------ */
/* Frontmatter helpers                                                 */
/* ------------------------------------------------------------------ */

function upsertFrontmatter(content, key, value) {
  if (value === undefined || value === null || value === '') return content;
  if (!content.startsWith('---')) {
    return `---\n${key}: ${value}\n---\n\n` + content;
  }
  const end = content.indexOf('\n---', 3);
  if (end === -1) return content;
  const head = content.slice(0, end);
  const tail = content.slice(end);
  const re = new RegExp(`^${key}:.*$`, 'm');
  if (re.test(head)) {
    const current = head.match(re)[0].slice(key.length + 1).trim();
    if (current) return content; // don't clobber something already filled in
    return head.replace(re, `${key}: ${value}`) + tail;
  }
  return head + `\n${key}: ${value}` + tail;
}

/* ------------------------------------------------------------------ */
/* Aggregation                                                         */
/* ------------------------------------------------------------------ */

async function loadSessions(plugin) {
  const folder = normalizePath(plugin.settings.folder);
  const prefix = folder.endsWith('/') ? folder : folder + '/';
  const files = plugin.app.vault
    .getMarkdownFiles()
    .filter((f) => f.path === folder || f.path.startsWith(prefix));

  const sessions = [];
  for (const file of files) {
    const cache = plugin.app.metadataCache.getFileCache(file) || {};
    const fm = cache.frontmatter || {};
    let date = fm.date ? String(fm.date).slice(0, 10) : dateFromName(file.basename);
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

    let content = '';
    try {
      content = await plugin.app.vault.cachedRead(file);
    } catch (e) {
      continue;
    }
    const sets = parseSetTable(content);
    const volume = sets.reduce((a, s) => a + s.weight * s.reps, 0);
    sessions.push({
      file,
      date,
      activity: fm.activity ? String(fm.activity) : file.basename.replace(/^\d{4}-\d{2}-\d{2}\s*/, ''),
      bodyweight: typeof fm.bodyweight === 'number' ? fm.bodyweight : parseFloat(fm.bodyweight) || null,
      sets,
      volume,
    });
  }
  sessions.sort((a, b) => (a.date < b.date ? -1 : 1));
  return sessions;
}

function byDate(sessions) {
  const map = new Map();
  for (const s of sessions) {
    const existing = map.get(s.date);
    if (existing) {
      existing.volume += s.volume;
      existing.sets += s.sets.length;
      existing.activities.push(s.activity);
    } else {
      map.set(s.date, {
        volume: s.volume,
        sets: s.sets.length,
        activities: [s.activity].filter(Boolean),
      });
    }
  }
  return map;
}

function streaks(dayMap) {
  const days = [...dayMap.keys()].sort();
  if (!days.length) return { current: 0, longest: 0 };

  let longest = 0;
  let run = 0;
  let prev = null;
  for (const d of days) {
    if (prev && moment(d).diff(moment(prev), 'days') === 1) run += 1;
    else run = 1;
    longest = Math.max(longest, run);
    prev = d;
  }

  const today = moment().format('YYYY-MM-DD');
  const yesterday = moment().subtract(1, 'day').format('YYYY-MM-DD');
  const last = days[days.length - 1];
  let current = 0;
  if (last === today || last === yesterday) {
    current = 1;
    let cursor = moment(last);
    while (true) {
      cursor = cursor.subtract(1, 'day');
      if (dayMap.has(cursor.format('YYYY-MM-DD'))) current += 1;
      else break;
    }
  }
  return { current, longest };
}

function exerciseStats(sessions, windowDays, limit) {
  const cutoff = moment().subtract(windowDays, 'days').format('YYYY-MM-DD');
  const map = new Map();
  for (const s of sessions) {
    if (s.date < cutoff) continue;
    for (const set of s.sets) {
      const key = set.exercise.toLowerCase();
      let e = map.get(key);
      if (!e) {
        e = {
          name: set.exercise,
          lastDate: null,
          lastSets: [],
          best: { weight: 0, reps: 0 },
          totalSets: 0,
          sessions: new Set(),
        };
        map.set(key, e);
      }
      e.totalSets += 1;
      e.sessions.add(s.date);
      if (e.lastDate !== s.date) {
        if (!e.lastDate || s.date > e.lastDate) {
          e.lastDate = s.date;
          e.lastSets = [];
        }
      }
      if (e.lastDate === s.date) e.lastSets.push(set);
      const better =
        set.weight > e.best.weight ||
        (set.weight === e.best.weight && set.reps > e.best.reps);
      if (better) e.best = { weight: set.weight, reps: set.reps };
    }
  }
  return [...map.values()]
    .sort((a, b) => (a.lastDate < b.lastDate ? 1 : a.lastDate > b.lastDate ? -1 : b.totalSets - a.totalSets))
    .slice(0, limit);
}

function topSet(sets) {
  if (!sets || !sets.length) return null;
  return sets.reduce((best, s) => {
    if (!best) return s;
    if (s.weight > best.weight) return s;
    if (s.weight === best.weight && s.reps > best.reps) return s;
    return best;
  }, null);
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function fmtNum(n) {
  if (!isFinite(n)) return '0';
  if (Math.abs(n) >= 10000) return Math.round(n / 1000) + 'k';
  return String(Math.round(n * 10) / 10);
}

function renderSummary(parent, dayMap, sessions, monthKey, settings) {
  const monthDays = [...dayMap.entries()].filter(([d]) => d.startsWith(monthKey));
  const volume = monthDays.reduce((a, [, v]) => a + v.volume, 0);
  const { current, longest } = streaks(dayMap);
  const lastBw = [...sessions].reverse().find((s) => s.bodyweight);

  const grid = parent.createDiv({ cls: 'ft-summary' });
  const card = (label, value, sub) => {
    const c = grid.createDiv({ cls: 'ft-card' });
    c.createDiv({ cls: 'ft-card-value', text: value });
    c.createDiv({ cls: 'ft-card-label', text: label });
    if (sub) c.createDiv({ cls: 'ft-card-sub', text: sub });
  };

  card('days trained', String(monthDays.length), moment(monthKey, 'YYYY-MM').format('MMMM'));
  card('day streak', String(current), longest ? `best ${longest}` : '');
  card(`volume (${settings.unit})`, fmtNum(volume), 'this month');
  card('bodyweight', lastBw ? `${fmtNum(lastBw.bodyweight)}` : '—', lastBw ? moment(lastBw.date).format('D MMM') : 'not logged');
}

function renderHeatmap(parent, dayMap, monthMoment, settings, onDayClick) {
  const monthKey = monthMoment.format('YYYY-MM');
  const wrap = parent.createDiv({ cls: 'ft-heatmap' });

  const values = [...dayMap.entries()]
    .filter(([d]) => d.startsWith(monthKey))
    .map(([, v]) => (settings.metric === 'sets' ? v.sets : v.volume));
  const max = Math.max(1, ...values);

  const weekdays = [];
  for (let i = 0; i < 7; i++) {
    weekdays.push(moment().day((settings.weekStart + i) % 7).format('dd').slice(0, 1));
  }
  const head = wrap.createDiv({ cls: 'ft-grid ft-grid-head' });
  weekdays.forEach((d) => head.createDiv({ cls: 'ft-weekday', text: d }));

  const grid = wrap.createDiv({ cls: 'ft-grid' });
  const first = monthMoment.clone().startOf('month');
  const daysInMonth = monthMoment.daysInMonth();
  let lead = (first.day() - settings.weekStart + 7) % 7;
  for (let i = 0; i < lead; i++) grid.createDiv({ cls: 'ft-day ft-empty' });

  const today = moment().format('YYYY-MM-DD');
  for (let d = 1; d <= daysInMonth; d++) {
    const key = first.clone().date(d).format('YYYY-MM-DD');
    const entry = dayMap.get(key);
    const cell = grid.createDiv({ cls: 'ft-day' });
    cell.createSpan({ cls: 'ft-day-num', text: String(d) });
    if (key === today) cell.addClass('ft-today');
    if (key > today) cell.addClass('ft-future');

    if (entry) {
      let level = 1;
      if (settings.metric !== 'done') {
        const value = settings.metric === 'sets' ? entry.sets : entry.volume;
        level = Math.min(4, Math.max(1, Math.ceil((value / max) * 4)));
      } else {
        level = 3;
      }
      cell.addClass('ft-l' + level);
      const acts = entry.activities.filter(Boolean).join(', ');
      cell.setAttr(
        'aria-label',
        `${moment(key).format('ddd D MMM')} — ${acts || 'workout'} · ${entry.sets} sets · ${fmtNum(entry.volume)} ${settings.unit}`
      );
      cell.addClass('ft-has-tip');
    }
    if (onDayClick) {
      cell.addEventListener('click', () => onDayClick(key, entry));
      cell.addClass('ft-clickable');
    }
  }
}

function renderStats(parent, sessions, settings) {
  const rows = exerciseStats(sessions, settings.statsWindow, settings.statsLimit);
  const wrap = parent.createDiv({ cls: 'ft-stats' });
  if (!rows.length) {
    wrap.createDiv({
      cls: 'ft-empty-state',
      text: 'No sets logged yet. Log a workout to start building stats.',
    });
    return;
  }

  const table = wrap.createEl('table', { cls: 'ft-table' });
  const thead = table.createEl('thead').createEl('tr');
  ['Exercise', 'Last session', 'Best set'].forEach((h) => thead.createEl('th', { text: h }));
  const tbody = table.createEl('tbody');

  for (const r of rows) {
    const tr = tbody.createEl('tr');
    const nameCell = tr.createEl('td');
    nameCell.createDiv({ cls: 'ft-ex-name', text: r.name });
    nameCell.createDiv({
      cls: 'ft-ex-sub',
      text: `${r.sessions.size} session${r.sessions.size === 1 ? '' : 's'} · ${r.totalSets} sets`,
    });

    const top = topSet(r.lastSets);
    const lastCell = tr.createEl('td');
    lastCell.createDiv({
      cls: 'ft-ex-main',
      text: top ? `${fmtNum(top.weight)}${settings.unit} × ${top.reps}` : '—',
    });
    lastCell.createDiv({
      cls: 'ft-ex-sub',
      text: `${r.lastSets.length} set${r.lastSets.length === 1 ? '' : 's'} · ${moment(r.lastDate).format('D MMM')}`,
    });

    const bestCell = tr.createEl('td');
    bestCell.createDiv({
      cls: 'ft-ex-main',
      text: r.best.weight ? `${fmtNum(r.best.weight)}${settings.unit} × ${r.best.reps}` : '—',
    });
  }
}

/* ------------------------------------------------------------------ */
/* Sidebar view                                                        */
/* ------------------------------------------------------------------ */

class FitnessView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.month = moment().startOf('month');
  }

  getViewType() {
    return VIEW_TYPE_FITNESS;
  }
  getDisplayText() {
    return 'Fitness tracker';
  }
  getIcon() {
    return 'dumbbell';
  }

  async onOpen() {
    await this.render();
  }

  async render() {
    const root = this.contentEl;
    root.empty();
    root.addClass('ft-root');
    root.toggleClass('ft-glass', !!this.plugin.settings.glass);
    root.style.setProperty('--ft-accent', this.plugin.settings.accent);

    const sessions = await loadSessions(this.plugin);
    const dayMap = byDate(sessions);

    const header = root.createDiv({ cls: 'ft-header' });
    const nav = header.createDiv({ cls: 'ft-nav' });
    const prev = nav.createEl('button', { cls: 'ft-icon-btn', text: '‹' });
    nav.createSpan({ cls: 'ft-month', text: this.month.format('MMMM YYYY') });
    const next = nav.createEl('button', { cls: 'ft-icon-btn', text: '›' });
    prev.onclick = () => {
      this.month = this.month.clone().subtract(1, 'month');
      this.render();
    };
    next.onclick = () => {
      this.month = this.month.clone().add(1, 'month');
      this.render();
    };

    const logBtn = header.createEl('button', { cls: 'ft-primary', text: 'Log workout' });
    logBtn.onclick = () => this.plugin.openLogModal();

    renderSummary(root, dayMap, sessions, this.month.format('YYYY-MM'), this.plugin.settings);
    renderHeatmap(root, dayMap, this.month, this.plugin.settings, (key, entry) => {
      if (entry) this.plugin.openNoteForDate(key);
      else this.plugin.openLogModal(key);
    });
    renderStats(root, sessions, this.plugin.settings);
  }
}

/* ------------------------------------------------------------------ */
/* Log modal                                                           */
/* ------------------------------------------------------------------ */

class WorkoutModal extends Modal {
  constructor(plugin, date) {
    super(plugin.app);
    this.plugin = plugin;
    this.date = date || moment().format('YYYY-MM-DD');
    this.activity = '';
    this.bodyweight = '';
    this.rows = [{ exercise: '', weight: '', reps: '', sets: '3' }];
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('ft-modal');
    contentEl.style.setProperty('--ft-accent', this.plugin.settings.accent);
    contentEl.createEl('h2', { text: 'Log workout' });

    new Setting(contentEl).setName('Date').addText((t) => {
      t.inputEl.type = 'date';
      t.setValue(this.date);
      t.onChange((v) => (this.date = v));
    });

    new Setting(contentEl)
      .setName('Activity')
      .setDesc('Push day, Legs, Run, Swim — whatever you call it')
      .addText((t) => {
        t.setPlaceholder('Push day');
        t.onChange((v) => (this.activity = v));
        this.plugin.knownActivities().then((list) => {
          if (!list.length) return;
          const id = 'ft-activities';
          const dl = contentEl.createEl('datalist');
          dl.id = id;
          list.forEach((a) => dl.createEl('option', { value: a }));
          t.inputEl.setAttr('list', id);
        });
      });

    new Setting(contentEl).setName(`Bodyweight (${this.plugin.settings.unit})`).addText((t) => {
      t.inputEl.type = 'number';
      t.setPlaceholder('optional');
      t.onChange((v) => (this.bodyweight = v));
    });

    contentEl.createEl('h3', { text: 'Exercises' });
    this.rowsEl = contentEl.createDiv({ cls: 'ft-rows' });
    this.renderRows();

    const addBtn = contentEl.createEl('button', { cls: 'ft-add', text: '+ Add exercise' });
    addBtn.onclick = () => {
      this.rows.push({ exercise: '', weight: '', reps: '', sets: '3' });
      this.renderRows();
    };

    const footer = contentEl.createDiv({ cls: 'ft-footer' });
    const cancel = footer.createEl('button', { text: 'Cancel' });
    cancel.onclick = () => this.close();
    const save = footer.createEl('button', { cls: 'ft-primary', text: 'Save workout' });
    save.onclick = () => this.save();
  }

  renderRows() {
    this.rowsEl.empty();
    const head = this.rowsEl.createDiv({ cls: 'ft-row ft-row-head' });
    ['Exercise', `Weight (${this.plugin.settings.unit})`, 'Reps', 'Sets', ''].forEach((h) =>
      head.createDiv({ text: h })
    );

    this.rows.forEach((row, i) => {
      const el = this.rowsEl.createDiv({ cls: 'ft-row' });
      const name = el.createEl('input', { type: 'text' });
      name.placeholder = 'Bench press';
      name.value = row.exercise;
      name.oninput = () => (row.exercise = name.value);

      const weight = el.createEl('input', { type: 'number' });
      weight.value = row.weight;
      weight.oninput = () => (row.weight = weight.value);

      const reps = el.createEl('input', { type: 'number' });
      reps.value = row.reps;
      reps.oninput = () => (row.reps = reps.value);

      const sets = el.createEl('input', { type: 'number' });
      sets.value = row.sets;
      sets.oninput = () => (row.sets = sets.value);

      const del = el.createEl('button', { cls: 'ft-icon-btn', text: '×' });
      del.onclick = () => {
        this.rows.splice(i, 1);
        if (!this.rows.length) this.rows.push({ exercise: '', weight: '', reps: '', sets: '3' });
        this.renderRows();
      };
    });
  }

  async save() {
    const entries = [];
    for (const r of this.rows) {
      const name = (r.exercise || '').trim();
      if (!name) continue;
      const count = Math.max(1, parseInt(r.sets, 10) || 1);
      const weight = parseFloat(r.weight);
      const reps = parseInt(r.reps, 10);
      for (let i = 1; i <= count; i++) {
        entries.push({
          exercise: name,
          set: i,
          weight: Number.isNaN(weight) ? 0 : weight,
          reps: Number.isNaN(reps) ? 0 : reps,
        });
      }
    }

    if (!this.activity.trim() && !entries.length) {
      new Notice('Add an activity name or at least one exercise.');
      return;
    }

    try {
      const file = await this.plugin.writeWorkout({
        date: this.date,
        activity: this.activity.trim(),
        bodyweight: this.bodyweight,
        entries,
      });
      new Notice(`Logged ${moment(this.date).format('D MMM')}`);
      this.close();
      this.plugin.refreshViews();
      if (this.plugin.settings.openAfterSave !== false) {
        // no-op by default; the note is available in the sidebar heatmap
      }
      return file;
    } catch (e) {
      console.error(e);
      new Notice('Could not write the workout note. Check the folder path in settings.');
    }
  }
}

/* ------------------------------------------------------------------ */
/* Settings tab                                                        */
/* ------------------------------------------------------------------ */

class FitnessSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Log folder')
      .setDesc('Where workout notes are created. One note per day.')
      .addText((t) =>
        t.setValue(this.plugin.settings.folder).onChange(async (v) => {
          this.plugin.settings.folder = v.trim() || DEFAULT_SETTINGS.folder;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Weight unit')
      .addDropdown((d) =>
        d
          .addOptions({ kg: 'kg', lb: 'lb' })
          .setValue(this.plugin.settings.unit)
          .onChange(async (v) => {
            this.plugin.settings.unit = v;
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          })
      );

    new Setting(containerEl)
      .setName('Heatmap intensity')
      .setDesc('What the shade of each day represents.')
      .addDropdown((d) =>
        d
          .addOptions({ volume: 'Total volume', sets: 'Number of sets', done: 'Just trained or not' })
          .setValue(this.plugin.settings.metric)
          .onChange(async (v) => {
            this.plugin.settings.metric = v;
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          })
      );

    new Setting(containerEl)
      .setName('Week starts on')
      .addDropdown((d) =>
        d
          .addOptions({ 0: 'Sunday', 1: 'Monday' })
          .setValue(String(this.plugin.settings.weekStart))
          .onChange(async (v) => {
            this.plugin.settings.weekStart = parseInt(v, 10);
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          })
      );

    new Setting(containerEl)
      .setName('Accent colour')
      .setDesc('Used for the heatmap shades.')
      .addText((t) => {
        t.inputEl.type = 'color';
        t.setValue(this.plugin.settings.accent).onChange(async (v) => {
          this.plugin.settings.accent = v;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        });
      });

    new Setting(containerEl)
      .setName('Translucent panels')
      .setDesc('Frosted-glass backgrounds. Turn off for flat panels.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.glass).onChange(async (v) => {
          this.plugin.settings.glass = v;
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        })
      );

    new Setting(containerEl)
      .setName('Exercises shown in stats')
      .addSlider((s) =>
        s
          .setLimits(3, 20, 1)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.statsLimit)
          .onChange(async (v) => {
            this.plugin.settings.statsLimit = v;
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          })
      );

    new Setting(containerEl)
      .setName('Stats look back')
      .setDesc('Days of history included in the exercise table.')
      .addSlider((s) =>
        s
          .setLimits(14, 365, 7)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.statsWindow)
          .onChange(async (v) => {
            this.plugin.settings.statsWindow = v;
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          })
      );
  }
}

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

module.exports = class FitnessTrackerPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_FITNESS, (leaf) => new FitnessView(leaf, this));

    this.addRibbonIcon('dumbbell', 'Log workout', () => this.openLogModal());

    this.addCommand({
      id: 'log-workout',
      name: 'Log workout',
      callback: () => this.openLogModal(),
    });

    this.addCommand({
      id: 'open-fitness-view',
      name: 'Open fitness tracker',
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: 'open-today-log',
      name: "Open today's workout note",
      callback: () => this.openNoteForDate(moment().format('YYYY-MM-DD')),
    });

    this.registerMarkdownCodeBlockProcessor('fitness', async (source, el, ctx) => {
      await this.renderBlock(source, el);
    });

    this.addSettingTab(new FitnessSettingTab(this.app, this));

    const refresh = debounce(() => this.refreshViews(), 500);
    this.registerEvent(this.app.vault.on('modify', refresh));
    this.registerEvent(this.app.vault.on('create', refresh));
    this.registerEvent(this.app.vault.on('delete', refresh));
    this.registerEvent(this.app.vault.on('rename', refresh));
  }

  onunload() {}

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async activateView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_FITNESS);
    if (existing.length) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE_FITNESS, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  refreshViews() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE_FITNESS).forEach((leaf) => {
      if (leaf.view && typeof leaf.view.render === 'function') leaf.view.render();
    });
  }

  openLogModal(date) {
    new WorkoutModal(this, date).open();
  }

  async knownActivities() {
    const sessions = await loadSessions(this);
    const seen = new Set();
    sessions
      .slice()
      .reverse()
      .forEach((s) => {
        if (s.activity) seen.add(s.activity);
      });
    return [...seen].slice(0, 20);
  }

  async ensureFolder(path) {
    const parts = path.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        try {
          await this.app.vault.createFolder(current);
        } catch (e) {
          /* already exists */
        }
      }
    }
  }

  notePath(date) {
    const folder = normalizePath(this.settings.folder);
    return `${folder}/${date}.md`;
  }

  buildNote({ date, activity, bodyweight, entries }) {
    const fm = ['---', 'type: workout', `date: ${date}`, `activity: ${activity || ''}`];
    if (bodyweight) fm.push(`bodyweight: ${bodyweight}`);
    fm.push('---', '');

    const rows = entries.map((e) => `| ${e.exercise} | ${e.set} | ${e.weight} | ${e.reps} |`);
    const body = [
      `# ${activity || 'Workout'} — ${moment(date).format('ddd D MMM YYYY')}`,
      '',
      '## Sets',
      '',
      TABLE_HEADER,
      ...(rows.length ? rows : ['']),
      '',
      '## Notes',
      '',
      '',
    ];
    return fm.concat(body).join('\n');
  }

  appendToNote(content, { activity, bodyweight, entries }) {
    let out = content;
    out = upsertFrontmatter(out, 'activity', activity);
    out = upsertFrontmatter(out, 'bodyweight', bodyweight);
    if (!entries.length) return out;

    const rows = entries.map((e) => `| ${e.exercise} | ${e.set} | ${e.weight} | ${e.reps} |`);
    const lines = out.split('\n');
    const headerIdx = lines.findIndex((l) => /^\|\s*Exercise\s*\|/i.test(l.trim()));
    if (headerIdx >= 0) {
      let i = headerIdx + 1;
      while (i < lines.length && lines[i].trim().startsWith('|')) i++;
      lines.splice(i, 0, ...rows);
      return lines.join('\n');
    }
    return out.trimEnd() + '\n\n## Sets\n\n' + TABLE_HEADER + '\n' + rows.join('\n') + '\n';
  }

  async writeWorkout({ date, activity, bodyweight, entries }) {
    await this.ensureFolder(normalizePath(this.settings.folder));
    const path = this.notePath(date);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (!existing) {
      return await this.app.vault.create(path, this.buildNote({ date, activity, bodyweight, entries }));
    }
    const content = await this.app.vault.read(existing);
    await this.app.vault.modify(existing, this.appendToNote(content, { activity, bodyweight, entries }));
    return existing;
  }

  async openNoteForDate(date) {
    const path = this.notePath(date);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file) {
      this.openLogModal(date);
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  async renderBlock(source, el) {
    const opts = {};
    source.split('\n').forEach((line) => {
      const m = line.match(/^\s*([\w-]+)\s*:\s*(.+)\s*$/);
      if (m) opts[m[1].toLowerCase()] = m[2].trim();
    });

    const settings = Object.assign({}, this.settings);
    if (opts.metric) settings.metric = opts.metric;
    if (opts.unit) settings.unit = opts.unit;
    if (opts.limit) settings.statsLimit = parseInt(opts.limit, 10) || settings.statsLimit;

    const month = opts.month ? moment(opts.month, 'YYYY-MM') : moment();
    const showStats = opts.stats !== 'false';
    const showSummary = opts.summary !== 'false';
    const showHeatmap = opts.heatmap !== 'false';

    el.empty();
    el.addClass('ft-root', 'ft-embed');
    el.toggleClass('ft-glass', !!settings.glass);
    el.style.setProperty('--ft-accent', settings.accent);

    const sessions = await loadSessions(this);
    const dayMap = byDate(sessions);

    if (opts.title !== 'false') {
      el.createDiv({ cls: 'ft-embed-title', text: opts.title || month.format('MMMM YYYY') });
    }
    if (showSummary) renderSummary(el, dayMap, sessions, month.format('YYYY-MM'), settings);
    if (showHeatmap) renderHeatmap(el, dayMap, month.clone().startOf('month'), settings, null);
    if (showStats) renderStats(el, sessions, settings);
  }
};

function debounce(fn, wait) {
  let t = null;
  return function (...args) {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait);
  };
}
