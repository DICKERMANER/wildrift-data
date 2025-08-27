// deps: npm i node-fetch@3 cheerio
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

const DB_PATH = './wildrift_database.json';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ------------------------- 基礎工具 -------------------------
const norm = s => String(s || '').trim().toLowerCase();
const readJSON = p => JSON.parse(fs.readFileSync(p, 'utf-8'));
const writeJSON = (p, obj) => fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf-8');

async function fetchHtml(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function log(...args) {
  console.log('[WR]', ...args);
}

// ------------------------- 索引工具（支援 CN/TW 雙辭典） -------------------------
function indexArrayDual(arr, into, intoTW, policy = 'first_wins') {
  for (const it of (arr || [])) {
    const en = it.en ?? it.EN ?? it.name_en;
    const cn = it.cn ?? it.cn_name ?? it.name_cn;
    const tw = it.tw ?? it.name_tw;
    if (!en) continue;
    const k = norm(en);

    const write = (table, val) => {
      if (!val) return;
      if (policy === 'first_wins') {
        if (!(k in table)) table[k] = val;
      } else {
        table[k] = val;
      }
    };

    write(into, cn);     // en -> cn
    write(intoTW, tw);   // en -> tw
  }
}

// ------------------------- 1) 建立映射辭典 -------------------------
function buildMappings(dbPath) {
  const db = readJSON(dbPath);
  const baseDir = db.mapping_files.base_dir || './mappings/';
  const baseAbs = path.resolve(path.dirname(dbPath), baseDir);
  const dedupe = db.mapping_strategy?.dedupe_policy || 'first_wins';
  const telemetry = db.mapping_strategy?.telemetry;
  const telemetryFile = db.mapping_strategy?.telemetry_file
    ? path.resolve(path.dirname(dbPath), db.mapping_strategy.telemetry_file)
    : null;

  const load = (entry) => {
    const files = Array.isArray(entry) ? entry : [entry];
    const mergedCN = {};
    const mergedTW = {};
    for (const f of files) {
      const p = path.resolve(baseAbs, f);
      if (!fs.existsSync(p)) {
        log('mapping file missing, skip:', f);
        continue;
      }
      const j = readJSON(p);
      if (j.type === 'champions') {
        indexArrayDual(j.data, mergedCN, mergedTW, dedupe);
      } else if (j.type === 'runes') {
        indexArrayDual(j.keystones, mergedCN, mergedTW, dedupe);
        if (j.minor) for (const group of Object.values(j.minor)) {
          indexArrayDual(group, mergedCN, mergedTW, dedupe);
        }
      } else if (j.type === 'items') {
        for (const sec of Object.keys(j)) {
          if (Array.isArray(j[sec])) indexArrayDual(j[sec], mergedCN, mergedTW, dedupe);
        }
      } else if (j.type === 'summoners') {
        indexArrayDual(j.data, mergedCN, mergedTW, dedupe);
      }
    }
    return { cn: mergedCN, tw: mergedTW };
  };

  const maps = {
    champions: load(db.mapping_files.champions),
    runes:     load(db.mapping_files.runes),
    items:     load(db.mapping_files.items),
    summoners: load(db.mapping_files.summoners),
    policy:    db.mapping_strategy || {}
  };

  // 供缺失鍵記錄
  maps._telemetry = (type, key, locale='cn') => {
    if (!telemetry || !telemetryFile) return;
    const line = `[${new Date().toISOString()}] ${type} :: ${locale} :: ${key}\n`;
    fs.appendFileSync(telemetryFile, line, 'utf-8');
  };

  return maps;
}

function mapName(dicts, type, en, locale = 'cn') {
  const k = norm(en);
  const tbl = dicts?.[type]?.[locale] || {};
  if (tbl[k]) return tbl[k];
  dicts._telemetry?.(type, en, locale);
  return dicts.policy?.missing_policy === 'fallback_en' ? en : '';
}

// ------------------------- 2) 自動抓最新版本（強化版） -------------------------
const VERSION_RE = /(\d+\.\d+[a-z]?)/i;

async function extractFromListPage(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  // 候選連結
  const candidates = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim();
    if (!/\/news\//.test(href)) return;
    if (VERSION_RE.test(text) || /版本更新|Patch\s*Notes/i.test(text)) {
      const full = href.startsWith('http') ? href : new URL(href, url).toString();
      candidates.push({ url: full, title: text });
    }
  });

  // 用第一個候選（官方列表通常最新在最前）
  if (candidates.length) return candidates[0];

  // 後備：OpenGraph 標題或首個 h1
  const og = $('meta[property="og:title"]').attr('content');
  if (og && VERSION_RE.test(og)) return { url, title: og };

  const h1 = $('h1').first().text().trim();
  if (h1 && VERSION_RE.test(h1)) return { url, title: h1 };

  return null;
}

async function extractPatchFromArticle(articleUrl) {
  const html = await fetchHtml(articleUrl);
  const $ = cheerio.load(html);
  const h1 = $('h1').first().text().trim();
  const t  = $('time').first();
  const published = t.length ? (t.attr('datetime') || t.text().trim()) : null;
  const m = h1.match(VERSION_RE) || ($('title').text().match(VERSION_RE));
  if (m) return { patch: m[1].toLowerCase(), url: articleUrl, title: h1 || null, published_at: published };
  return null;
}

async function fetchLatestPatch(db) {
  const sources = db.patch_check_sources || [];
  for (const src of sources) {
    try {
      const cand = await extractFromListPage(src);
      if (!cand) continue;
      // 標題就含版本
      const inTitle = cand.title && cand.title.match(VERSION_RE);
      if (inTitle) {
        const html = await fetchHtml(cand.url);
        const $ = cheerio.load(html);
        const t  = $('time').first();
        const published = t.length ? (t.attr('datetime') || t.text().trim()) : null;
        return { patch: inTitle[1].toLowerCase(), url: cand.url, title: cand.title, published_at: published, source: src };
      }
      // 否則進文章頁抓 h1
      const detail = await extractPatchFromArticle(cand.url);
      if (detail) return { ...detail, source: src };
    } catch (e) {
      log('patch source fail:', src, e.message);
      continue;
    }
  }
  throw new Error('未能自動取得最新版本號');
}

// 版本比較：6.2 < 6.2a < 6.2b…；6.3 > 6.2x
function parsePatch(p) {
  const m = String(p || '').trim().match(/^(\d+)\.(\d+)([a-z])?$/i);
  if (!m) return null;
  const major = +m[1], minor = +m[2], suf = (m[3] || '').toLowerCase();
  const sufRank = suf ? suf.charCodeAt(0) : 0; // a=97, b=98…
  return { major, minor, sufRank };
}
function cmpPatch(a, b) {
  const A = parsePatch(a), B = parsePatch(b);
  if (!A || !B) return 0;
  if (A.major !== B.major) return A.major - B.major;
  if (A.minor !== B.minor) return A.minor - B.minor;
  return A.sufRank - B.sufRank;
}

async function updatePatchInfo(dbPath) {
  const db = readJSON(dbPath);
  const latest = await fetchLatestPatch(db);

  const cur = db.patch_current;
  if (!cur || cmpPatch(latest.patch, cur) > 0) {
    db.patch_current = latest.patch;
    db.patch_latest_url = latest.url;
    db.patch_published_at = latest.published_at || null;
    db.patch_source = latest.source;
    db.patch_history = db.patch_history || [];
    db.patch_history.unshift({ patch: latest.patch, url: latest.url, at: new Date().toISOString() });
    writeJSON(dbPath, db);
    log('PATCH updated ->', latest.patch);
  } else {
    log('PATCH keep', cur, '(latest seen:', latest.patch, ')');
  }
  return latest.patch;
}

// ------------------------- 3) 社群搜尋（Douyin / TikTok） -------------------------
function safeJsonParse(txt) {
  try { return JSON.parse(txt); } catch { return null; }
}

function extractDouyin(html) {
  const $ = cheerio.load(html);
  // Douyin 會把資料放在 <script id="RENDER_DATA">（URL-encoded 的 JSON）
  const raw = $('#RENDER_DATA').text();
  if (!raw) return [];
  let decoded = null;
  try {
    // RENDER_DATA 通常是 URL 編碼 + base64（依線上調整）
    const urldec = decodeURIComponent(raw);
    decoded = safeJsonParse(Buffer.from(urldec, 'base64').toString('utf-8')) || safeJsonParse(urldec);
  } catch {}
  if (!decoded) return [];

  const results = [];
  const walk = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (k.includes('aweme') && Array.isArray(v)) {
        for (const it of v) {
          const title = it?.desc || it?.title || '';
          const url = it?.share_url || it?.link?.url || '';
          const tm = it?.create_time || it?.time;
          if (title && url) results.push({ title, url, time: tm, source: 'douyin' });
        }
      } else if (typeof v === 'object') {
        walk(v);
      }
    }
  };
  walk(decoded);
  // 若為空，用回退策略：抓可見 a[href]（常失敗，因多為動態）
  if (!results.length) {
    $('a[href]').each((_, el) => {
      const t = $(el).text().trim();
      const href = $(el).attr('href') || '';
      if (t && href && /douyin\.com\/video/.test(href)) {
        results.push({ title: t, url: href, source: 'douyin' });
      }
    });
  }
  return results.slice(0, 10);
}

function extractTikTok(html, baseURL) {
  const $ = cheerio.load(html);
  // TikTok 會在 <script id="SIGI_STATE"> 放較完整的 JSON
  const state = $('#SIGI_STATE').text();
  const data = safeJsonParse(state);
  const results = [];
  if (data) {
    const ItemModule = data.ItemModule || {};
    for (const it of Object.values(ItemModule)) {
      const title = it?.desc || '';
      const id = it?.id;
      const url = id ? new URL(`/@${it.author}/video/${id}`, baseURL).toString() : null;
      if (title && url) results.push({ title, url, time: it?.createTime, source: 'tiktok' });
    }
  }
  // 後備：抓可見 a[href]
  if (!results.length) {
    $('a[href]').each((_, el) => {
      const t = $(el).text().trim();
      const href = $(el).attr('href') || '';
      if (t && /\/video\//.test(href)) {
        const full = href.startsWith('http') ? href : new URL(href, baseURL).toString();
        results.push({ title: t, url: full, source: 'tiktok' });
      }
    });
  }
  return results.slice(0, 10);
}

async function searchCommunity(keyword, limit = 6) {
  const db = readJSON(DB_PATH);
  const sources = db.community_sources || [];
  const out = [];

  for (const s of sources) {
    try {
      const base = s.url.replace(/\/+$/, '');
      // Douyin
      if (/douyin\.com/.test(base)) {
        const url = `${base}/search/${encodeURIComponent(keyword)}`;
        const html = await fetchHtml(url, 15000);
        out.push(...extractDouyin(html));
      }
      // TikTok
      else if (/tiktok\.com/.test(base)) {
        const url = `${base}/search?q=${encodeURIComponent(keyword)}`;
        const html = await fetchHtml(url, 15000);
        out.push(...extractTikTok(html, base));
      }
    } catch (e) {
      log('community search fail:', s.url, e.message);
    }
  }

  // 簡單去重 + 截取
  const seen = new Set();
  const uniq = [];
  for (const it of out) {
    const key = it.url;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    uniq.push(it);
    if (uniq.length >= limit) break;
  }
  return uniq;
}

// ------------------------- 4) 啟動：更新版本 + 載入映射 -------------------------
export async function bootstrap() {
  await updatePatchInfo(DB_PATH);           // 更新版本號

  const dicts = buildMappings(DB_PATH);     // 構建映射

  // 示例：en -> CN / TW
  log(
    'CN:', mapName(dicts, 'champions', 'Lee Sin', 'cn'),     // 李青
    'TW:', mapName(dicts, 'champions', 'Lee Sin', 'tw')      // 李星（若表中有 tw）
  );

  // 若要臨時測試社群搜尋：設環境變數 WR_COMMUNITY_SEARCH
  if (process.env.WR_COMMUNITY_SEARCH) {
    const kw = process.env.WR_COMMUNITY_SEARCH;
    const vids = await searchCommunity(kw, 6);
    log('community results for', kw, '=>', vids);
  }
  return { dicts };
}

// 直接跑
bootstrap().catch(e => (console.error(e), process.exit(1)));
