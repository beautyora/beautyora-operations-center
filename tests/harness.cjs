'use strict';
/**
 * Test harness: runs the real src/*.gs code inside a Node vm with in-memory fakes of
 * Notion API, Google Drive, and the Apps Script services it uses.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const SRC = path.join(__dirname, '..', 'src');
const VALID_TOKEN = 'secret-test-token';

/* ------------------------------------------------------------------ Notion fake */
class FakeNotion {
  constructor() {
    this.sources = {};
    this.pages = {};
    this.blocks = {};
    this.comments = [];
    this.users = [{ object: 'user', id: 'user-1', type: 'person', name: '운영 담당', person: { email: 'admin@beautyora.test' } }];
    this.clock = Date.parse('2026-09-28T01:00:00.000Z');
    this.calls = [];
    this.failNext = null;
    this.databases = {};
  }
  tick() { this.clock += 60000; return new Date(this.clock).toISOString(); }
  id() { return crypto.randomUUID(); }

  addSource(key, spec) {
    const id = spec.id || this.id();
    const properties = {};
    Object.keys(spec.properties).forEach((name) => {
      const def = spec.properties[name];
      const type = def.type;
      const prop = { id: def.id || name.slice(0, 2) + crypto.randomBytes(2).toString('hex'), name, type };
      prop[type] = {};
      if (def.options) prop[type].options = def.options.map((o) => ({ id: crypto.randomBytes(3).toString('hex'), name: o, color: 'default' }));
      if (def.relation) prop.relation = { data_source_id: def.relation, type: 'dual_property' };
      properties[name] = prop;
    });
    const databaseId = this.id();
    this.sources[id] = { object: 'data_source', id, name: key, parent: { type: 'database_id', database_id: databaseId }, properties };
    this.databases[databaseId] = { object: 'database', id: databaseId, parent: { type: 'page_id', page_id: 'parent-page-0000' }, data_sources: [{ id }] };
    return id;
  }

  propByKey(source, key) {
    if (source.properties[key]) return source.properties[key];
    return Object.values(source.properties).find((p) => p.id === key);
  }

  convert(def, value) {
    const type = def.type;
    const out = { id: def.id, type };
    const rich = (items) => (items || []).map((item) => ({ type: 'text', text: { content: item.text.content }, plain_text: item.text.content }));
    const option = (name) => {
      if (!name) return null;
      let found = (def[type].options || []).find((o) => o.name === name);
      if (!found) {
        found = { id: crypto.randomBytes(3).toString('hex'), name, color: 'default' };
        def[type].options = (def[type].options || []).concat([found]);
      }
      return { id: found.id, name: found.name, color: found.color };
    };
    switch (type) {
      case 'title': out.title = rich(value.title); break;
      case 'rich_text': out.rich_text = rich(value.rich_text); break;
      case 'select': out.select = value.select ? option(value.select.name) : null; break;
      case 'multi_select': out.multi_select = (value.multi_select || []).map((o) => option(o.name)); break;
      case 'number': out.number = value.number; break;
      case 'url': out.url = value.url; break;
      case 'email': out.email = value.email; break;
      case 'phone_number': out.phone_number = value.phone_number; break;
      case 'checkbox': out.checkbox = !!value.checkbox; break;
      case 'date': out.date = value.date ? { start: value.date.start, end: null } : null; break;
      case 'relation': out.relation = (value.relation || []).map((r) => ({ id: r.id })); break;
      case 'people': out.people = (value.people || []).map((p) => ({ id: p.id, name: 'user' })); break;
      case 'files': out.files = value.files || []; break;
      default: throw this.error(400, 'validation_error', `Property type ${type} not writable`);
    }
    return out;
  }

  emptyProp(def) {
    const empty = { title: [], rich_text: [], select: null, multi_select: [], number: null, url: null, email: null, phone_number: null, checkbox: false, date: null, relation: [], people: [], files: [] };
    const out = { id: def.id, type: def.type };
    if (def.type === 'created_time') out.created_time = null;
    else if (def.type === 'last_edited_time') out.last_edited_time = null;
    else if (def.type === 'formula') out.formula = { type: 'string', string: '' };
    else if (def.type === 'rollup') out.rollup = { type: 'number', number: null };
    else out[def.type] = Object.prototype.hasOwnProperty.call(empty, def.type) ? JSON.parse(JSON.stringify(empty[def.type])) : null;
    return out;
  }

  applyProps(page, source, props) {
    Object.keys(props || {}).forEach((key) => {
      const def = this.propByKey(source, key);
      if (!def) throw this.error(400, 'validation_error', `${key} is not a property that exists.`);
      page.properties[def.name] = this.convert(def, props[key]);
    });
  }

  materialize(page) {
    const source = this.sources[page.parent.data_source_id];
    const copy = JSON.parse(JSON.stringify(page));
    Object.values(source.properties).forEach((def) => {
      if (!copy.properties[def.name]) copy.properties[def.name] = this.emptyProp(def);
      const p = copy.properties[def.name];
      p.id = def.id;
      if (def.type === 'created_time') p.created_time = page.created_time;
      if (def.type === 'last_edited_time') p.last_edited_time = page.last_edited_time;
    });
    return copy;
  }

  createPage(sourceId, properties, extra) {
    const source = this.sources[sourceId];
    if (!source) throw this.error(404, 'object_not_found', 'data source not found');
    const id = this.id();
    const time = this.tick();
    const page = { object: 'page', id, url: 'https://www.notion.so/' + id.replace(/-/g, ''), created_time: time, last_edited_time: time, archived: false, in_trash: false, parent: { type: 'data_source_id', data_source_id: sourceId }, properties: {} };
    this.applyProps(page, source, properties || {});
    this.pages[id] = page;
    this.blocks[id] = [];
    return page;
  }

  text(prop) {
    if (!prop) return '';
    const v = prop[prop.type];
    if (prop.type === 'title' || prop.type === 'rich_text') return (v || []).map((t) => t.plain_text).join('');
    if (prop.type === 'select') return v ? v.name : '';
    if (prop.type === 'date') return v ? v.start : '';
    return v;
  }

  matches(page, filter, source) {
    if (!filter) return true;
    if (filter.and) return filter.and.every((f) => this.matches(page, f, source));
    if (filter.or) return filter.or.some((f) => this.matches(page, f, source));
    const def = this.propByKey(source, filter.property);
    if (!def) throw this.error(400, 'validation_error', 'Could not find property ' + filter.property);
    const prop = page.properties[def.name] || this.emptyProp(def);
    const cond = filter[def.type] || filter.rich_text || filter.title || filter.select || filter.relation || filter.checkbox || filter.date || filter.number;
    if (!cond) throw this.error(400, 'validation_error', 'filter type mismatch for ' + def.name);
    if (def.type === 'relation') return (prop.relation || []).some((r) => r.id.replace(/-/g, '') === String(cond.contains).replace(/-/g, ''));
    if (def.type === 'checkbox') return !!prop.checkbox === !!cond.equals;
    if (def.type === 'multi_select') return (prop.multi_select || []).some((o) => o.name === cond.contains);
    if (def.type === 'date') {
      const v = prop.date ? prop.date.start.slice(0, 10) : '';
      if (!v) return false;
      if (cond.on_or_before) return v <= cond.on_or_before;
      if (cond.on_or_after) return v >= cond.on_or_after;
      if (cond.equals) return v === cond.equals;
      return true;
    }
    const value = this.text(prop);
    if (Object.prototype.hasOwnProperty.call(cond, 'equals')) return String(value) === String(cond.equals);
    if (cond.contains) return String(value).includes(cond.contains);
    if (cond.is_empty) return !value;
    return true;
  }

  query(sourceId, body) {
    const source = this.sources[sourceId];
    if (!source) throw this.error(404, 'object_not_found', 'data source not found');
    let list = Object.values(this.pages).filter((p) => p.parent.data_source_id === sourceId && !p.archived);
    list = list.filter((p) => this.matches(p, body.filter, source));
    (body.sorts || []).slice().reverse().forEach((sort) => {
      const dir = sort.direction === 'descending' ? -1 : 1;
      list.sort((a, b) => {
        let av, bv;
        if (sort.timestamp) { av = a[sort.timestamp]; bv = b[sort.timestamp]; } else {
          const def = this.propByKey(source, sort.property);
          av = this.text(a.properties[def.name]) || ''; bv = this.text(b.properties[def.name]) || '';
        }
        return av < bv ? -dir : av > bv ? dir : 0;
      });
    });
    const size = Math.min(body.page_size || 100, 100);
    const start = body.start_cursor ? Number(body.start_cursor) : 0;
    const slice = list.slice(start, start + size);
    const more = start + size < list.length;
    return { object: 'list', results: slice.map((p) => this.materialize(p)), has_more: more, next_cursor: more ? String(start + size) : null };
  }

  error(status, code, message) {
    const e = new Error(message);
    e.status = status; e.code = code;
    return e;
  }

  handle(method, url, body) {
    const u = new URL(url);
    const p = u.pathname.replace(/^\/v1/, '');
    this.calls.push(method.toUpperCase() + ' ' + p);
    if (this.failNext && this.failNext.test(method.toUpperCase() + ' ' + p)) {
      const f = this.failNext; this.failNext = null;
      throw this.error(f.status || 500, 'internal_server_error', 'simulated failure');
    }
    let m;
    if (method === 'get' && p === '/users/me') return { object: 'user', id: 'bot', type: 'bot', name: '뷰티오라 운영센터' };
    if (method === 'get' && p === '/users') return { results: this.users, has_more: false };
    if (method === 'get' && p === '/views') throw this.error(404, 'object_not_found', 'views not available');
    if ((m = p.match(/^\/data_sources\/([^/]+)$/))) {
      const source = this.sources[decodeURIComponent(m[1])];
      if (!source) throw this.error(404, 'object_not_found', 'no source');
      if (method === 'get') return JSON.parse(JSON.stringify(source));
      if (method === 'patch') {
        Object.keys(body.properties || {}).forEach((key) => {
          const existing = this.propByKey(source, key);
          const spec = body.properties[key];
          const type = Object.keys(spec)[0];
          if (existing) { if (spec[type] && spec[type].options) existing[type].options = spec[type].options.map((o) => ({ id: o.id || crypto.randomBytes(3).toString('hex'), name: o.name, color: o.color || 'default' })); }
          else {
            const prop = { id: crypto.randomBytes(2).toString('hex'), name: key, type };
            prop[type] = spec[type] || {};
            if (prop[type].options) prop[type].options = prop[type].options.map((o) => ({ id: crypto.randomBytes(3).toString('hex'), name: o.name, color: o.color || 'default' }));
            source.properties[key] = prop;
          }
        });
        return JSON.parse(JSON.stringify(source));
      }
    }
    if ((m = p.match(/^\/data_sources\/([^/]+)\/query$/)) && method === 'post') return this.query(decodeURIComponent(m[1]), body || {});
    if (p === '/pages' && method === 'post') return this.materialize(this.createPage(body.parent.data_source_id, body.properties, body));
    if ((m = p.match(/^\/pages\/([^/]+)$/))) {
      const page = this.pages[decodeURIComponent(m[1])];
      if (!page) throw this.error(404, 'object_not_found', 'no page');
      if (method === 'get') return this.materialize(page);
      if (method === 'patch') {
        this.applyProps(page, this.sources[page.parent.data_source_id], body.properties || {});
        page.last_edited_time = this.tick();
        return this.materialize(page);
      }
    }
    if ((m = p.match(/^\/blocks\/([^/]+)\/children$/))) {
      const id = decodeURIComponent(m[1]);
      if (method === 'get') {
        const list = this.blocks[id] || [];
        return { results: list.map((b) => Object.assign({}, b, { has_children: !!(this.blocks[b.id] || []).length })), has_more: false };
      }
      if (method === 'patch') {
        const add = (parent, children) => (children || []).map((child) => {
          const block = Object.assign({ object: 'block', id: this.id() }, JSON.parse(JSON.stringify(child)));
          const data = block[block.type] || {};
          if (data.rich_text) data.rich_text = data.rich_text.map((t) => Object.assign({}, t, { plain_text: t.text.content }));
          const nested = data.children; delete data.children;
          this.blocks[parent] = (this.blocks[parent] || []).concat([block]);
          this.blocks[block.id] = [];
          add(block.id, nested);
          return block;
        });
        add(id, body.children);
        if (this.pages[id]) this.pages[id].last_edited_time = this.tick();
        return { results: [] };
      }
    }
    if ((m = p.match(/^\/blocks\/([^/]+)$/)) && method === 'patch') {
      const id = decodeURIComponent(m[1]);
      for (const parent of Object.keys(this.blocks)) {
        const block = (this.blocks[parent] || []).find((b) => b.id === id);
        if (block) {
          const data = body[block.type];
          block[block.type] = Object.assign({}, block[block.type], { rich_text: data.rich_text.map((t) => Object.assign({}, t, { plain_text: t.text.content })) });
          return block;
        }
      }
      throw this.error(404, 'object_not_found', 'no block');
    }
    if (p === '/comments' && method === 'post') { this.comments.push({ page: body.parent.page_id, text: body.rich_text.map((t) => t.text.content).join('') }); return {}; }
    if (p === '/databases' && method === 'post') {
      const props = {};
      Object.keys(body.initial_data_source.properties).forEach((name) => {
        const spec = body.initial_data_source.properties[name];
        const type = Object.keys(spec)[0];
        props[name] = { type, options: spec[type] && spec[type].options ? spec[type].options.map((o) => o.name) : undefined, relation: type === 'relation' ? spec.relation.data_source_id : undefined };
      });
      const id = this.addSource('link', { properties: props });
      const db = this.databases[this.sources[id].parent.database_id];
      return db;
    }
    if ((m = p.match(/^\/databases\/([^/]+)$/)) && method === 'get') {
      const db = this.databases[decodeURIComponent(m[1])];
      if (!db) throw this.error(404, 'object_not_found', 'no db');
      return db;
    }
    throw this.error(400, 'invalid_request_url', 'Unhandled ' + method + ' ' + p);
  }
}

/* ------------------------------------------------------------------ Drive fake */
class FakeDrive {
  constructor() { this.items = {}; this.seq = 0; this.root = this.folder('뷰티오라_테스트_파일', null); }
  nextId(prefix) { this.seq++; return prefix + String(this.seq).padStart(26, '0'); }
  folder(name, parent) {
    const id = this.nextId('fold');
    this.items[id] = { id, name, folder: true, parents: parent ? [parent] : [] };
    return id;
  }
  folderApi(id) {
    const self = this;
    const item = this.items[id];
    if (!item || !item.folder) throw new Error('Drive 폴더 없음: ' + id);
    const iter = (list) => { let i = 0; return { hasNext: () => i < list.length, next: () => list[i++] }; };
    const children = () => Object.values(self.items).filter((x) => x.folder && x.parents[0] === id);
    return {
      getId: () => id, getName: () => item.name, getUrl: () => 'https://drive.google.com/drive/folders/' + id,
      getFolders: () => iter(children().map((c) => self.folderApi(c.id))),
      getFiles: () => iter(Object.values(self.items).filter((x) => !x.folder && !x.trashed && x.parents[0] === id).map((f) => ({ getId: () => f.id, getName: () => f.name, getMimeType: () => f.mimeType, getLastUpdated: () => new Date(f.modifiedTime || f.createdTime) }))),
      getFoldersByName: (name) => iter(children().filter((c) => c.name === name).map((c) => self.folderApi(c.id))),
      createFolder: (name) => self.folderApi(self.folder(name, id))
    };
  }
  file(resource, blob) {
    const id = this.nextId('file');
    const file = { id, name: resource.name, mimeType: resource.mimeType || (blob && blob.getContentType()) || '', parents: resource.parents || [], appProperties: Object.assign({}, resource.appProperties || {}), description: resource.description || '', createdTime: new Date(Date.UTC(2026, 8, 28, 0, this.seq)).toISOString(), size: blob ? String(blob.getBytes().length) : '0', trashed: false };
    file.webViewLink = 'https://drive.google.com/file/d/' + id + '/view';
    file.thumbnailLink = 'https://thumb.test/' + id + '=s220';
    this.items[id] = file;
    return file;
  }
  matchesQuery(file, q) {
    if (file.folder || file.trashed) return false;
    const re = /appProperties has \{ key='([^']+)' and value='((?:[^'\\]|\\.)*)' \}/g;
    let m, ok = true;
    while ((m = re.exec(q))) { if ((file.appProperties || {})[m[1]] !== m[2].replace(/\\'/g, "'")) ok = false; }
    return ok;
  }
  api() {
    const self = this;
    return {
      Files: {
        create: (resource, blob) => {
          if (resource.mimeType === 'application/vnd.google-apps.spreadsheet') { const f = self.file(resource, blob); f.converted = true; return f; }
          return JSON.parse(JSON.stringify(self.file(resource, blob)));
        },
        list: (opts) => ({ files: Object.values(self.items).filter((f) => self.matchesQuery(f, opts.q)).map((f) => JSON.parse(JSON.stringify(f))) }),
        get: (id) => { const f = self.items[id]; if (!f || f.folder) throw new Error('File not found: ' + id); return JSON.parse(JSON.stringify(f)); },
        update: (resource, id) => {
          const f = self.items[id]; if (!f) throw new Error('File not found: ' + id);
          if (resource.appProperties) f.appProperties = Object.assign({}, f.appProperties, resource.appProperties);
          if (resource.description != null) f.description = resource.description;
          return JSON.parse(JSON.stringify(f));
        },
        remove: (id) => { delete self.items[id]; },
        copy: (resource, id) => {
          const src = self.items[id]; if (!src || src.folder) throw new Error('File not found: ' + id);
          return JSON.parse(JSON.stringify(self.file(Object.assign({ name: src.name, mimeType: src.mimeType }, resource), null)));
        }
      }
    };
  }
}

/* ------------------------------------------------------------------ Apps Script fakes */
function formatDate(date, tz, pattern) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return pattern.replace("'T'", 'T').replace('yyyy', get('year')).replace('MM', get('month')).replace('dd', get('day'))
    .replace('HH', get('hour')).replace('mm', get('minute')).replace('ss', get('second')).replace('XXX', '+09:00');
}

function blob(bytes, type, name) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  return { getBytes: () => Array.from(buf).map((b) => (b > 127 ? b - 256 : b)), getContentType: () => type, getName: () => name, setName(n) { name = n; return this; } };
}

function createEnv(options) {
  options = options || {};
  const notion = new FakeNotion();
  const drive = new FakeDrive();
  const props = {};
  const cache = new Map();
  const triggers = [];
  const mail = [];
  const user = { active: options.user || 'admin@beautyora.test', effective: 'owner@beautyora.test' };
  let form = null;
  const legacyBooks = {};

  const context = {
    console: options.quiet === false ? console : { log() {}, error() {}, warn() {} },
    JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set, isFinite, isNaN, encodeURIComponent, decodeURIComponent, Intl,
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null),
      setProperty: (k, v) => { props[k] = String(v); },
      deleteProperty: (k) => { delete props[k]; }
    }) },
    CacheService: { getScriptCache: () => ({
      get: (k) => (cache.has(k) ? cache.get(k) : null),
      getAll: (keys) => { const o = {}; keys.forEach((k) => { if (cache.has(k)) o[k] = cache.get(k); }); return o; },
      put: (k, v) => { if (String(v).length > 100000) throw new Error('cache value too large'); cache.set(k, String(v)); },
      putAll: (o) => Object.keys(o).forEach((k) => { if (String(o[k]).length > 100000) throw new Error('cache value too large'); cache.set(k, String(o[k])); }),
      remove: (k) => cache.delete(k)
    }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
    Session: {
      getActiveUser: () => ({ getEmail: () => user.active }),
      getEffectiveUser: () => ({ getEmail: () => user.effective })
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, text) => Array.from(crypto.createHash('sha256').update(String(text), 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)),
      getUuid: () => crypto.randomUUID(),
      formatDate,
      base64Decode: (s) => Array.from(Buffer.from(String(s), 'base64')).map((b) => (b > 127 ? b - 256 : b)),
      base64Encode: (bytes) => Buffer.from(bytes.map((b) => b & 255)).toString('base64'),
      base64EncodeWebSafe: (s) => Buffer.from(String(s)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      newBlob: (bytes, type, name) => blob(Array.isArray(bytes) ? Buffer.from(bytes.map((b) => b & 255)) : Buffer.from(String(bytes || '')), type, name),
      sleep: () => {}
    },
    UrlFetchApp: { fetch: (url, opts) => {
      if (url.indexOf('https://api.notion.com/') === 0) {
        if (opts.headers.Authorization !== 'Bearer ' + VALID_TOKEN) return response(401, { message: 'API token is invalid.' });
        try {
          return response(200, notion.handle(opts.method, url, opts.payload ? JSON.parse(opts.payload) : null));
        } catch (e) {
          if (e.status) return response(e.status, { object: 'error', code: e.code, message: e.message });
          throw e;
        }
      }
      if (url.indexOf('https://thumb.test/') === 0) return { getResponseCode: () => 200, getBlob: () => blob(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'), 'image/png'), getHeaders: () => ({}) };
      throw new Error('Unexpected fetch ' + url);
    } },
    DriveApp: { getFolderById: (id) => drive.folderApi(id) },
    Drive: drive.api(),
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (t) => { const i = triggers.indexOf(t); if (i >= 0) triggers.splice(i, 1); },
      newTrigger: (handler) => {
        const b = { forForm: () => b, onFormSubmit: () => b, timeBased: () => b, everyHours: () => b, create: () => { const uid = 't' + triggers.length + 1; const t = { getHandlerFunction: () => handler, getUniqueId: () => uid }; triggers.push(t); return t; } };
        return b;
      },
      getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/TEST/exec' }),
      getOAuthToken: () => 'oauth-token'
    },
    MailApp: { getRemainingDailyQuota: () => 100, sendEmail: (to, subject, body) => mail.push({ to, subject, body }) },
    FormApp: { openById: () => { if (!form) throw new Error('form not found'); return form; } },
    SpreadsheetApp: { openById: (id) => {
      if (legacyBooks[id]) return legacyBooks[id];
      const file = drive.items[id];
      if (file && file.converted) return { getSheets: () => [{ getDataRange: () => ({ getDisplayValues: () => options.workbookValues || [] }) }] };
      throw new Error('spreadsheet not found ' + id);
    } },
    HtmlService: {
      createHtmlOutputFromFile: (name) => ({ getContent: () => fs.readFileSync(path.join(SRC, name + '.html'), 'utf8') }),
      createTemplateFromFile: (name) => template(name, context),
      XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' }
    }
  };
  function response(code, json) {
    return { getResponseCode: () => code, getContentText: () => JSON.stringify(json), getHeaders: () => ({}) };
  }
  vm.createContext(context);
  const code = fs.readdirSync(SRC).filter((f) => f.endsWith('.gs')).sort().map((f) => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n;\n');
  vm.runInContext(code + '\n;this.__run = function (name, args) { return eval(name).apply(null, args || []); };', context, { filename: 'apps-script.js' });

  const env = {
    context, notion, drive, props, cache, triggers, mail, user,
    call: (name, ...args) => context.__run(name, args),
    api: (action, payload, token) => context.__run('api', [{ action, payload: payload || {}, token }]),
    setUser: (email) => { user.active = email; },
    clearCache: () => cache.clear(),
    setForm: (f) => { form = f; },
    addLegacyBook: (id, book) => { legacyBooks[id] = book; }
  };
  return env;
}

/** Minimal Apps Script HtmlTemplate: <?= ?> escaped, <?!= ?> raw, <? ?> code. */
function template(name, context) {
  const source = fs.readFileSync(path.join(SRC, name + '.html'), 'utf8');
  const t = {};
  t.evaluate = () => {
    let js = 'var __o="";with(__data){';
    let last = 0;
    const re = /<\?(!?=)?([\s\S]*?)\?>/g;
    let m;
    while ((m = re.exec(source))) {
      js += '__o+=' + JSON.stringify(source.slice(last, m.index)) + ';';
      const expr = m[2].trim().replace(/;$/, '');
      if (m[1] === '=') js += '__o+=__esc(' + expr + ');';
      else if (m[1] === '!=') js += '__o+=(' + expr + ');';
      else js += m[2];
      last = re.lastIndex;
    }
    js += '__o+=' + JSON.stringify(source.slice(last)) + ';}return __o;';
    const data = Object.assign({}, t);
    const fn = new Function('__data', '__esc', 'include_', js);
    const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const html = fn(data, esc, (n) => context.include_(n));
    const out = { html, title: '', setTitle(v) { out.title = v; return out; }, addMetaTag() { return out; }, setXFrameOptionsMode(v) { out.xframe = v; return out; }, getContent: () => html };
    return out;
  };
  return t;
}

/* ------------------------------------------------------------------ seed data */
function seed(env, opts) {
  opts = opts || {};
  const n = env.notion;
  const brandId = n.addSource('brand', { properties: {
    '브랜드명': { type: 'title' }, '브랜드 ID': { type: 'rich_text' },
    '진행 단계': { type: 'select', options: ['접수·검토', '조건 협의', '통화 예정', '통화 완료', '확정', '보류'] },
    '협력사/회사명': { type: 'rich_text' }, '재영업 단계': { type: 'select', options: ['조건협의'] }, '재영업 분류': { type: 'select', options: ['확인 필요'] },
    '우선순위': { type: 'select', options: ['1순위', '2순위', '3순위'] }, '브랜드 담당자': { type: 'rich_text' }, '연락처': { type: 'rich_text' }, '이메일': { type: 'rich_text' },
    '카테고리': { type: 'multi_select', options: ['스킨케어(베이직)', '메이크업'] }, '희망 거래 방식': { type: 'multi_select', options: ['사입', '위탁'] },
    '희망 영역': { type: 'multi_select', options: ['약국', '백화점'] }, '희망 채널 1순위': { type: 'rich_text' }, '희망 채널 2순위': { type: 'rich_text' },
    '순위 무관 희망 채널': { type: 'rich_text' }, '현재 판매 채널': { type: 'rich_text' }, '판매 채널': { type: 'multi_select', options: ['쿠팡'] },
    '핵심 메모': { type: 'rich_text' }, '다음 행동': { type: 'rich_text' }, '참고 링크/자료': { type: 'rich_text' }, '구글 드라이브': { type: 'url' },
    '상품 특장점': { type: 'rich_text' }, '대표 상품군': { type: 'rich_text' }, '사업자 번호': { type: 'rich_text' }, '접수일': { type: 'date' },
    '브랜드 런칭일자': { type: 'date' }, '미팅일': { type: 'date' }, '폼 제출': { type: 'checkbox' }, '이슈 여부': { type: 'select', options: ['이슈'] },
    '소통 담당자': { type: 'people' }, '사업자등록증 Drive URL': { type: 'url' }, '브랜드 소개서 Drive URL': { type: 'url' }, '계약서 Drive URL': { type: 'url' },
    '기타 브랜드 자료 Drive URL': { type: 'url' }, '최근 수정': { type: 'last_edited_time' }
  } });
  const productId = n.addSource('product', { properties: {
    '상품명': { type: 'title' }, '운영센터 상품 ID': { type: 'rich_text' }, '브랜드': { type: 'relation', relation: brandId },
    '등록 검수 상태': { type: 'select', options: ['검수 대기', '승인 완료', '보완 필요', '반려'] },
    '대표 이미지 Drive URL': { type: 'url' }, '상세페이지 Drive URL': { type: 'url' }, '바코드(텍스트)': { type: 'rich_text' }, '옵션명': { type: 'rich_text' },
    '제품 설명': { type: 'rich_text' }, '소비자가': { type: 'number' }, '매입가(매입 가능시)': { type: 'number' }, '공급가(위탁 가능시)': { type: 'number' },
    '오프라인 위탁 판매가': { type: 'number' }, '온라인 최저가': { type: 'number' }, 'MOQ': { type: 'number' },
    '카테고리': { type: 'multi_select', options: ['스킨케어(베이직)', '메이크업', '미분류'] }, '참고 링크': { type: 'url' },
    '노출 희망 채널': { type: 'multi_select', options: ['온라인 B2C', '약국'] }, '이미지': { type: 'files' }, '최초 등록일': { type: 'created_time' },
    '검토 상태': { type: 'select', options: ['자료 수집', '추천'] }, '검토 메모': { type: 'rich_text' }, '입출고 이력': { type: 'relation', relation: 'movement-ds' }
  } });
  const storeId = n.addSource('store', { properties: { '매장명': { type: 'title' }, '매장 코드': { type: 'rich_text' }, '운영 상태': { type: 'select', options: ['운영 중'] }, '채널 유형': { type: 'select', options: ['약국'] }, '기본 거래 방식': { type: 'select', options: ['위탁'] }, '입점 상품 운영': { type: 'relation', relation: 'inventory-ds' } } });
  const movementId = n.addSource('movement', { id: 'movement-ds', properties: { '이력명': { type: 'title' }, '상품': { type: 'relation', relation: productId }, '입점 매장': { type: 'relation', relation: storeId }, '수량 (+/-)': { type: 'number' }, '구분': { type: 'select', options: ['최초 입고', '추가 입고', '반품', '회수', '재고 조정'] }, '입출고 방향': { type: 'select', options: ['+', '-'] }, '처리일': { type: 'date' }, '처리 상태': { type: 'select', options: ['예정', '완료', '취소'] }, '비고': { type: 'rich_text' }, '브랜드 연결(회사명용)': { type: 'relation', relation: brandId } } });
  const inventoryId = n.addSource('inventory', { id: 'inventory-ds', properties: { '관리명': { type: 'title' }, '상품': { type: 'relation', relation: productId }, '입점 매장': { type: 'relation', relation: storeId }, '실재고': { type: 'number' }, '브랜드사': { type: 'relation', relation: brandId }, '샘플·DP 수량': { type: 'number' }, '입점 상태': { type: 'select', options: ['입점 예정', '입점 완료', '판매 중단'] }, '판매 방식': { type: 'select', options: ['위탁', '매입'] }, '위탁 공급가': { type: 'number' }, '위탁 매장 판매가': { type: 'number' }, '진열 위치': { type: 'rich_text' }, '특이사항': { type: 'rich_text' }, '특이사항 유형': { type: 'multi_select', options: ['수량 불일치'] }, '확인 필요': { type: 'checkbox' }, '납품일': { type: 'date' } } });
  const activityId = n.addSource('activity', { properties: { '이력명': { type: 'title' }, '브랜드': { type: 'relation', relation: brandId }, '일자': { type: 'date' }, '연락 방식': { type: 'select', options: ['전화', '이메일', '미팅', '메신저', '기타'] }, '결과': { type: 'select', options: ['완료', '부재', '회신 대기'] }, '상대방 담당자': { type: 'rich_text' }, '통화 내용': { type: 'rich_text' }, '다음 행동': { type: 'rich_text' }, '후속 확인일': { type: 'date' }, '후속 완료': { type: 'checkbox' }, '상담 담당자': { type: 'people' } } });
  const termsId = n.addSource('terms', { properties: { '조건명': { type: 'title' }, '벤더': { type: 'relation', relation: brandId }, '상품': { type: 'relation', relation: productId }, '거래 방식': { type: 'multi_select', options: ['위탁', '사입'] }, '검토 상태': { type: 'select', options: ['사용 중'] }, '매입가(매입 가능시)': { type: 'number' }, '현재 채택': { type: 'checkbox' }, '기준일': { type: 'date' } } });
  n.sources[brandId].properties['공급조건'] = { id: 'rel1', name: '공급조건', type: 'relation', relation: { data_source_id: termsId } };

  Object.assign(env.props, {
    BO_NOTION_TOKEN: 'secret-test-token', BO_ADMIN_EMAILS: 'admin@beautyora.test, second@beautyora.test',
    BO_NOTION_BRAND_DATA_SOURCE_ID: brandId, BO_NOTION_PRODUCT_DATA_SOURCE_ID: productId,
    BO_NOTION_ACTIVITY_DATA_SOURCE_ID: activityId, BO_ROOT_FOLDER_ID: env.drive.root,
    BO_PARTNER_WEBAPP_URL: 'https://script.google.com/macros/s/PARTNER/exec'
  });
  if (!opts.skipDiscovery) Object.assign(env.props, { BO_NOTION_INVENTORY_DATA_SOURCE_ID: inventoryId, BO_NOTION_MOVEMENT_DATA_SOURCE_ID: movementId, BO_NOTION_STORE_DATA_SOURCE_ID: storeId, BO_NOTION_TERMS_DATA_SOURCE_ID: termsId });

  const brand = (name, code, stage, extra) => n.createPage(brandId, Object.assign({
    '브랜드명': { title: [{ text: { content: name } }] }, '브랜드 ID': { rich_text: [{ text: { content: code } }] },
    '진행 단계': { select: { name: stage } }, '협력사/회사명': { rich_text: [{ text: { content: name + ' 주식회사' } }] }
  }, extra || {}));
  const b1 = brand('루엠', 'BO-0001', '확정', { '사업자 번호': { rich_text: [{ text: { content: '123-45-67890' } }] } });
  const b2 = brand('셀리본', 'BO-0002', '조건 협의');
  const b3 = brand('새싹랩', 'BO-0003', '접수·검토', { '접수일': { date: { start: '2026-09-27' } }, '사업자 번호': { rich_text: [{ text: { content: '1234567890' } }] } });
  const product = (brandPage, name, pid, review, barcode) => n.createPage(productId, {
    '상품명': { title: [{ text: { content: name } }] }, '운영센터 상품 ID': { rich_text: [{ text: { content: pid } }] },
    '브랜드': { relation: [{ id: brandPage.id }] }, '등록 검수 상태': { select: review ? { name: review } : null },
    '바코드(텍스트)': { rich_text: [{ text: { content: barcode || '' } }] }, '소비자가': { number: 25000 }, '카테고리': { multi_select: [{ name: '스킨케어(베이직)' }] }
  });
  const p1 = product(b1, '시카 리페어 앰플', 'PRD-0001-AAAA', '승인 완료', '8800000000011');
  const p2 = product(b1, '수분 크림', 'PRD-0002-BBBB', '검수 대기', '8800000000028');
  const p3 = product(b2, '립 틴트', 'PRD-0003-CCCC', '승인 완료', '8800000000035');
  const s1 = n.createPage(storeId, { '매장명': { title: [{ text: { content: '팜픽 홍대점' } }] } });
  const inv = n.createPage(inventoryId, { '관리명': { title: [{ text: { content: '홍대 · 앰플' } }] }, '상품': { relation: [{ id: p1.id }] }, '입점 매장': { relation: [{ id: s1.id }] }, '실재고': { number: 10 }, '확인 필요': { checkbox: true } });
  return { ids: { brandId, productId, storeId, movementId, inventoryId, activityId, termsId }, b1, b2, b3, p1, p2, p3, s1, inv };
}

module.exports = { createEnv, seed, FakeNotion, FakeDrive };
