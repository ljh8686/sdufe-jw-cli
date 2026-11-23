#!/usr/bin/env node
/**
 * 山东财经大学 教务系统（jw.sdufe.edu.cn，强智 jsxsd）命令行工具
 *
 * 用法：
 *   node jw.mjs                     当前第几周 + 今天有什么课（默认）
 *   node jw.mjs brief               一行摘要：周次 + 今天课 + 成绩概况（早报用）
 *   node jw.mjs week                当前第几周 / 共几周
 *   node jw.mjs today | tomorrow    今天 / 明天有什么课
 *   node jw.mjs timetable           整学期课表（--week N 只看某周，--full 带老师和周次）
 *   node jw.mjs grades              成绩（默认最近一个有成绩的学期，--all 全部，--semester X 指定）
 *   node jw.mjs gpa                 成绩统计：学分 / 加权平均分 / 加权绩点 / 挂科（自算，含挂科）
 *   node jw.mjs audit               学业审核一条龙：官方绩点 + 各类学分要求/已修/在途/还需 + 通选明细
 *   node jw.mjs plan                执行计划（培养方案课程 + 学分分布）
 *   node jw.mjs exams               考试安排
 *   node jw.mjs login               只验证账号密码
 *   任意命令加 --json               输出结构化 JSON
 *   任意命令加 --no-cache           跳过会话缓存，强制重新登录
 *
 * 账号密码来源（按优先级）：
 *   JW_USER / JW_PASS / JW_BASE 环境变量
 *   -> 同级目录上一层的 config.json  {"user":"学号","password":"密码","base":"http://jw.sdufe.edu.cn"}
 *
 * 原理：登录页把 学号/密码 各做一次 base64，用 "%%%" 拼起来放进 encoded 字段 POST 到
 *      /jsxsd/xk/LoginToXk，成功后拿 JSESSIONID 即可访问所有页面。页面无验证码。
 *      会话 cookie 与当前周次缓存在 .cache/session.json，20 分钟内复用，省掉重复登录。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const CACHE_PATH = path.join(ROOT, '.cache', 'session.json');

const DAY_NAMES = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];
const SESSION_TTL = 20 * 60 * 1000; // cookie 复用时长
const WEEK_TTL = 10 * 60 * 1000; // 周次缓存时长

/* ---------------------------------------------------------------- 配置 & 工具 */

function loadConfig() {
  let cfg = {};
  try {
    cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    /* 没有配置文件就走环境变量 */
  }
  const user = process.env.JW_USER || cfg.user;
  const password = process.env.JW_PASS || cfg.password;
  const base = (process.env.JW_BASE || cfg.base || 'http://jw.sdufe.edu.cn').replace(/\/+$/, '');
  if (!user || !password) {
    throw new Error(
      `缺少账号密码：请在 ${CONFIG_PATH} 写入 {"user":"学号","password":"密码"}，或设置 JW_USER / JW_PASS 环境变量`,
    );
  }
  return { user, password, base };
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripTags(html) {
  return decodeEntities(
    String(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(div|p|li|tr|td|th)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 单元格文本：去标签、压空格 */
function cellText(html) {
  return stripTags(html).replace(/\s+/g, ' ').trim();
}

const num = (v) => {
  const n = parseFloat(String(v).replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/* ---------------------------------------------------------------- 会话缓存 */

function readCache() {
  try {
    return JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(patch) {
  try {
    mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    const cur = readCache() || {};
    writeFileSync(CACHE_PATH, JSON.stringify({ ...cur, ...patch }));
  } catch {
    /* 缓存写不了就算了，不影响主流程 */
  }
}

/** 数据缓存：把 audit 这类多请求结果存 10 分钟，重复调用零网络开销 */
const DATA_TTL = 10 * 60 * 1000;

function readData(key) {
  const c = readCache();
  const d = c && c.data && c.data[key];
  if (d && Date.now() - (d.at || 0) < DATA_TTL) return d.v;
  return null;
}

function writeData(key, v) {
  const c = readCache() || {};
  const data = { ...(c.data || {}), [key]: { at: Date.now(), v } };
  writeCache({ data });
}

/** 培养方案名（如「2024 物流管理」）：永久缓存，方案不会变，取一次就够 */
function readPlanName() {
  const c = readCache();
  return (c && c.data && c.data.planName && c.data.planName.v) || '';
}

function writePlanName(name) {
  if (!name) return;
  const c = readCache() || {};
  writeCache({ data: { ...(c.data || {}), planName: { at: Date.now(), v: name } } });
}

/* ---------------------------------------------------------------- 网络 */

function cookieOf(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return list.map((c) => c.split(';')[0]).join('; ');
}

async function login(ctx) {
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  const encoded = b64(ctx.user) + '%%%' + b64(ctx.password);
  const body = new URLSearchParams({
    userAccount: ctx.user,
    userPassword: ctx.password,
    encoded,
  });
  const res = await fetch(ctx.base + '/jsxsd/xk/LoginToXk', {
    method: 'POST',
    body,
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const loc = res.headers.get('location') || '';
  const cookie = cookieOf(res);
  if (res.status >= 300 && res.status < 400 && /xsMain/i.test(loc)) {
    ctx.cookie = cookie;
    return true;
  }
  const text = await res.text();
  const raw = stripTags(text).replace(/\s+/g, ' ').trim().slice(0, 200);
  const hint = raw.length > 6 ? raw : `HTTP ${res.status}${loc ? ' → ' + loc : ''}`;
  throw new Error(
    `登录失败：${hint}\n  当前账号 ${ctx.user}。请确认：① 密码是否正确（改过密码要同步 ${CONFIG_PATH} 或 JW_PASS 环境变量）② 账号是否被锁定 ③ 是否在校内网（校外需先连 VPN）`,
  );
}

class LoginExpired extends Error {}

async function rawGet(ctx, p) {
  const res = await fetch(ctx.base + p, { headers: { cookie: ctx.cookie }, redirect: 'follow' });
  const text = await res.text();
  if (/name="userAccount"|请输入账号/.test(text) && /登录/.test(text)) throw new LoginExpired('登录状态失效');
  return text;
}

async function rawPost(ctx, p, body) {
  const res = await fetch(ctx.base + p, {
    method: 'POST',
    body,
    headers: { cookie: ctx.cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    redirect: 'follow',
  });
  const text = await res.text();
  if (/name="userAccount"|请输入账号/.test(text) && /登录/.test(text)) throw new LoginExpired('登录状态失效');
  return text;
}

/** 带自动重登的请求：cookie 过期时重新登录一次 */
async function withRetry(ctx, fn) {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof LoginExpired)) throw e;
    await login(ctx);
    writeCache({ at: Date.now(), cookie: ctx.cookie, week: null, weekAt: 0 });
    return await fn();
  }
}

const get = (ctx, p) => withRetry(ctx, () => rawGet(ctx, p));
const post = (ctx, p, body) => withRetry(ctx, () => rawPost(ctx, p, body));

/* ---------------------------------------------------------------- 当前周 */

async function currentWeek(ctx, { noCache = false } = {}) {
  if (!noCache) {
    const c = readCache();
    if (c && c.week && Date.now() - (c.weekAt || 0) < WEEK_TTL) return c.week;
  }
  const html = await get(ctx, '/jsxsd/framework/xsMain_new.jsp');
  const t = stripTags(html);
  const m = /第\s*(\d+)\s*周\s*\/\s*(\d+)\s*周/.exec(t);
  if (!m) throw new Error('没能从首页读出当前周次（页面可能改版，用 ego 浏览器看一眼）');
  const info = { week: Number(m[1]), total: Number(m[2]) };
  const sem = /(20\d{2}-\d{4}-[123])/.exec(t);
  if (sem) info.semester = sem[1];
  writeCache({ week: info, weekAt: Date.now() });
  return info;
}

/* ---------------------------------------------------------------- 通用表格解析 */

/**
 * 解析 id="dataList" 这类强智列表表格。
 * 返回 { headers, rows, empty }，rows 为「按表头命名的对象数组」。
 */
function parseDataTable(html, id = 'dataList') {
  const at = html.indexOf(`id="${id}"`);
  if (at < 0) return { headers: [], rows: [], empty: true };
  const start = html.lastIndexOf('<table', at);
  const end = html.indexOf('</table>', at);
  const seg = html.slice(start < 0 ? at : start, end < 0 ? undefined : end);
  const trs = [...seg.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]);
  let headers = [];
  const raw = [];
  for (const tr of trs) {
    const ths = [...tr.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => cellText(m[1]));
    if (ths.length && !headers.length) {
      headers = ths;
      continue;
    }
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => cellText(m[1]));
    if (tds.length) raw.push(tds);
  }
  const empty = raw.length === 0 || raw.every((r) => r.length === 1 && /未查询到数据/.test(r[0]));
  const rows = empty
    ? []
    : raw.map((tds) => {
        if (!headers.length) return Object.fromEntries(tds.map((v, i) => ['c' + i, v]));
        const o = {};
        headers.forEach((h, i) => (o[h] = tds[i] ?? ''));
        return o;
      });
  return { headers, rows, empty };
}

/* ---------------------------------------------------------------- 课表 */

function fontVal(inner, title) {
  const re = new RegExp("<font[^>]*title=['\"]" + title + "['\"][^>]*>([^<]*)</font>", 'i');
  const m = re.exec(inner);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}

function parseCell(html) {
  const items = [];
  if (!html) return items;
  const re = /<div\b([^>]*)>([\s\S]*?)<\/div>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const inner = m[2];
    if (!/kbcontent/i.test(attrs)) continue;
    const name = stripTags(inner.split(/<font/i)[0]).trim();
    if (!name) continue;
    const item = {
      name,
      teacher: fontVal(inner, '老师'),
      weeks: fontVal(inner, '周次\\(节次\\)'),
      room: fontVal(inner, '教室'),
    };
    // 同一门课在页面里通常有两个 div（一个显示、一个悬停显示详情），只保留带老师的那份
    const key = [item.name, item.weeks, item.room].join('|');
    const dup = items.find((x) => x.key === key);
    if (dup) {
      if (!dup.teacher && item.teacher) dup.teacher = item.teacher;
      continue;
    }
    items.push({ key, ...item });
  }
  return items;
}

function parseGrid(html) {
  const start = html.indexOf('id="kbtable"');
  if (start < 0) throw new Error('课表页里没有 kbtable（可能没登录成功，或页面改版）');
  const end = html.indexOf('</table>', start);
  const seg = html.slice(start, end < 0 ? undefined : end);
  const rows = seg
    .split(/<tr[^>]*>/i)
    .slice(1)
    .map((r) => r.split(/<\/tr>/i)[0]);
  // 每一行结构：<th>节次</th> + 7 个 <td>（星期一…星期日）
  const grid = [];
  for (const rowHtml of rows) {
    const th = /<th[^>]*>([\s\S]*?)<\/th>/i.exec(rowHtml);
    const label = th ? stripTags(th[1]).replace(/\s+/g, '') : '';
    if (!/节/.test(label)) continue;
    const cells = rowHtml
      .split(/<td[^>]*>/i)
      .slice(1)
      .map((c) => c.split(/<\/td>/i)[0]);
    const row = { label, cells: [] };
    for (let i = 0; i < cells.length && i < 7; i++) {
      row.cells.push({ day: i + 1, items: parseCell(cells[i]) });
    }
    grid.push(row);
  }
  // 备注行：<th>备注:</th><td id="bz_td" colspan="7">…</td>（未排时间/未排课表的课）
  let remark = '';
  const bz = /id="bz_td"[^>]*>([\s\S]*?)<\/td>/i.exec(seg);
  if (bz) {
    remark = stripTags(bz[1])
      .replace(/\s+/g, ' ')
      .replace(/教学安排中未排课表课程[:：]/g, '')
      .trim();
  }
  return { grid, remark };
}

function selectedSemester(html) {
  const seg = /<select[^>]*id="xnxq01id"[^>]*>([\s\S]*?)<\/select>/i.exec(html);
  if (!seg) return null;
  const opt = /<option[^>]*value="([^"]+)"[^>]*selected[^>]*>/i.exec(seg[1]);
  if (opt) return opt[1];
  const first = /<option[^>]*value="([^"]+)"/i.exec(seg[1]);
  return first ? first[1] : null;
}

async function fetchTimetable(ctx, semester, zc) {
  const qs = new URLSearchParams();
  if (semester) qs.set('xnxq01id', semester);
  if (zc) qs.set('zc', String(zc));
  const q = qs.toString();
  const html = await get(ctx, '/jsxsd/xskb/xskb_list.do' + (q ? '?' + q : ''));
  const { grid, remark } = parseGrid(html);
  return { semester: semester || selectedSemester(html), grid, remark };
}

/* ---------------------------------------------------------------- 周次判断 */

function weekIn(spec, week) {
  const m = /^([\d,\-]+)\s*\((周|单周|双周)\)$/.exec(String(spec || '').trim());
  if (!m) return false;
  const list = [];
  for (const part of m[1].split(',')) {
    const [a, b] = part.split('-').map(Number);
    if (!Number.isFinite(a)) continue;
    if (Number.isFinite(b)) for (let i = a; i <= b; i++) list.push(i);
    else list.push(a);
  }
  if (!list.includes(week)) return false;
  if (m[2] === '单周') return week % 2 === 1;
  if (m[2] === '双周') return week % 2 === 0;
  return true;
}

function itemsForWeek(grid, week) {
  const out = [];
  for (const row of grid) {
    for (const cell of row.cells) {
      for (const it of cell.items) {
        if (weekIn(it.weeks, week)) out.push({ ...it, day: cell.day, slot: row.label });
      }
    }
  }
  return out;
}

/** 周次简写：1-18(周) -> ''，1-18(单周) -> '单'，其余保留 */
function weekTag(spec) {
  const s = String(spec || '');
  if (/^1-1[5-9]\(周\)$/.test(s) || /^1-2[01]\(周\)$/.test(s)) return '';
  if (/\(单周\)$/.test(s)) return '单';
  if (/\(双周\)$/.test(s)) return '双';
  return s.replace(/\(周\)$/, '');
}

/* ---------------------------------------------------------------- 成绩 */

/**
 * 查询成绩。
 * @param semester '' = 全部学期
 * @param mode 'max' 显示最好成绩（重修/补考取最高）| 'all' 显示全部记录
 */
async function fetchGrades(ctx, { semester = '', mode = 'max', kind = '', name = '' } = {}) {
  const body = new URLSearchParams({ kksj: semester, kcxz: kind, xsfs: mode, fxkc: '', kcmc: name });
  const html = await post(ctx, '/jsxsd/kscj/cjcx_list', body);
  const { rows } = parseDataTable(html);
  return rows
    .filter((r) => r['课程名称'])
    .map((r) => ({
      semester: r['开课学期'],
      code: r['课程编号'],
      name: r['课程名称'],
      scoreRaw: r['成绩'],
      score: num(r['成绩']),
      credit: num(r['学分']) ?? 0,
      gpa: num(r['绩点']) ?? 0,
      examKind: r['考试性质'],
      nature: r['课程性质'],
      attr: r['课程属性'],
    }));
}

/** 成绩统计：学分、加权平均分、加权绩点、挂科、按性质分组 */
function summarize(grades) {
  const s = {
    courses: grades.length,
    credits: 0,
    passedCredits: 0,
    weightedScore: 0,
    weightedGpa: 0,
    passedGpaSum: 0,
    passedScoreSum: 0,
    passedScoreCredit: 0,
    failed: [],
    byNature: {},
    bySemester: {},
  };
  for (const g of grades) {
    if (!g.credit) continue;
    s.credits += g.credit;
    if (g.score != null) s.weightedScore += g.score * g.credit;
    s.weightedGpa += g.gpa * g.credit;
    const passed = g.score == null || g.score >= 60;
    if (passed) {
      s.passedCredits += g.credit;
      s.passedGpaSum += g.gpa * g.credit;
      if (g.score != null) {
        s.passedScoreSum += g.score * g.credit;
        s.passedScoreCredit += g.credit;
      }
    } else s.failed.push(g);

    const n = (s.byNature[g.nature || '未标注'] ||= { credits: 0, passed: 0, courses: 0 });
    n.credits += g.credit;
    n.courses += 1;
    if (passed) n.passed += g.credit;

    const sem = (s.bySemester[g.semester] ||= { credits: 0, gpa: 0, score: 0, courses: 0 });
    sem.credits += g.credit;
    sem.gpa += g.gpa * g.credit;
    if (g.score != null) sem.score += g.score * g.credit;
    sem.courses += 1;
  }
  s.avgScore = s.credits ? s.weightedScore / s.credits : 0;
  s.avgGpa = s.credits ? s.weightedGpa / s.credits : 0;
  // 官方口径：挂科不计入分子分母，与教务系统「平均学分绩点查询」一致
  s.officialGpa = s.passedCredits ? s.passedGpaSum / s.passedCredits : 0;
  s.officialScore = s.passedScoreCredit ? s.passedScoreSum / s.passedScoreCredit : 0;
  return s;
}

/** 最近一个有成绩的学期 */
function latestSemester(grades) {
  const sems = [...new Set(grades.map((g) => g.semester))].filter(Boolean).sort();
  return sems.length ? sems[sems.length - 1] : '';
}

/**
 * 解析没有 id="dataList" 的表格（学业完成情况、通选课修读情况页都是 class="Nsb_table"）。
 * 返回 [{ headers, rows: string[][] }]，rows 是纯数组，空单元格保留为空串。
 */
function parseClassTables(html) {
  const out = [];
  const re = /<table[^>]*class="[^"]*Nsb_table[^"]*"[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const start = m.index;
    const end = html.indexOf('</table>', start);
    if (end < 0) continue;
    const tbl = html.slice(start, end + 8);
    const trs = [...tbl.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((r) => r[0]);
    let headers = null;
    const rows = [];
    for (const tr of trs) {
      const ths = [...tr.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((x) => cellText(x[1]));
      if (!headers && ths.length) {
        headers = ths;
        continue;
      }
      const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => cellText(x[1]));
      if (tds.length) rows.push(tds);
    }
    out.push({ headers: headers || [], rows });
  }
  return out;
}

/* ---------------------------------------------------------------- 学业审核（audit） */

/** 官方平均学分绩点：/kscj/cjcx_avg（排除挂科的算法，和自算的 gpa 略有差异） */
async function fetchOfficialGpa(ctx) {
  const html = await get(ctx, '/jsxsd/kscj/cjcx_avg');
  const { rows } = parseDataTable(html);
  const r = rows.find((x) => String(x['学号'] || '').trim());
  if (!r) throw new Error('平均学分绩点页没有数据（可能还没出成绩）');
  return {
    id: String(r['学号']).trim(),
    name: r['姓名'],
    major: r['专业名称'],
    className: r['班级名称'],
    earnedCredits: num(r['所修总学分']) ?? 0,
    courses: num(r['课程门数']) ?? 0,
    avgScore: num(r['平均分']),
    avgCreditScore: num(r['平均学分绩']),
    gpa: num(r['平均学分绩点']),
  };
}

/**
 * 学业完成情况（按课程性质）：要求 / 已修 / 正修读 / 还需。
 * 两段式：先 GET xxwcqk_idxOnxz.do 拿修读方案编号 ndzydm，再 POST xxwcqkOnkcxz.do。
 */
async function fetchRequirement(ctx) {
  const page = await get(ctx, '/jsxsd/xxwcqk/xxwcqk_idxOnxz.do');
  const m = /name="ndzydm"\s+value="([^"]+)"/.exec(page);
  if (!m) throw new Error('没找到修读方案编号 ndzydm（页面可能改版）');
  const body = new URLSearchParams({ ndzydm: m[1], jx0301zxjhid: '' });
  const html = await post(ctx, '/jsxsd/xxwcqk/xxwcqkOnkcxz.do', body);
  const tables = parseClassTables(html);
  const t = tables.find((x) => x.headers.some((h) => /要求学分/.test(h)));
  if (!t) throw new Error('学业完成情况页没有找到学分要求表');
  const items = t.rows
    .filter((r) => r[0])
    .map((r) => ({
      nature: r[0],
      required: num(r[1]) ?? 0,
      earned: num(r[2]) ?? 0,
      ongoing: num(r[3]) ?? 0,
      remaining: num(r[4]) ?? 0,
    }));
  const h2 = /<h2>\s*([\s\S]{0,60}?)\s*专业修读情况审核报告/.exec(html);
  const planName = h2 ? cellText(h2[1]) : '';
  writePlanName(planName);
  return { planName, items };
}

/**
 * 只取培养方案名（「2024 物流管理」）。
 * 方案编号 ndzydm 是从登录账号自己的页面读的，不写死专业，
 * 所以换个专业的同学跑出来的就是他自己那套方案。
 */
async function fetchPlanName(ctx) {
  const cached = readPlanName();
  if (cached) return cached;
  const audit = readData('audit');
  if (audit && audit.planName) {
    writePlanName(audit.planName);
    return audit.planName;
  }
  const page = await get(ctx, '/jsxsd/xxwcqk/xxwcqk_idxOnxz.do');
  const m = /name="ndzydm"\s+value="([^"]+)"/.exec(page);
  if (!m) return '';
  const html = await post(ctx, '/jsxsd/xxwcqk/xxwcqkOnkcxz.do', new URLSearchParams({ ndzydm: m[1], jx0301zxjhid: '' }));
  const h2 = /<h2>\s*([\s\S]{0,60}?)\s*专业修读情况审核报告/.exec(html);
  const name = h2 ? cellText(h2[1]) : '';
  writePlanName(name);
  return name;
}

/** 通选课（公选课）修读情况：分类要求 + 已修明细 */
async function fetchTongxuan(ctx) {
  const html = await get(ctx, '/jsxsd/xxwcqk/xstxkxdqk.do');
  const tables = parseClassTables(html);
  const catRows = (tables[0] && tables[0].rows) || [];
  const categories = catRows
    .filter((r) => r[0] && r[0] !== '总学分')
    .map((r) => ({ category: r[0], required: num(r[1]) ?? 0, earned: num(r[2]) ?? 0, ongoing: num(r[3]) ?? 0 }));
  const totalRow = catRows.find((r) => r[0] === '总学分') || [];
  const courses = ((tables[1] && tables[1].rows) || [])
    .filter((r) => r[0])
    .map((r) => ({ code: r[0], name: r[1], credit: num(r[2]) ?? 0, scoreRaw: r[3], category: r[4] }));
  return {
    categories,
    total: { earned: num(totalRow[2]) ?? 0, ongoing: num(totalRow[3]) ?? 0 },
    courses,
  };
}

/** 一条命令拿全部学业数据：官方绩点 + 学分要求 + 通选明细（10 分钟缓存） */
async function fetchAudit(ctx, { noCache = false } = {}) {
  if (!noCache) {
    const hit = readData('audit');
    if (hit) return hit;
  }
  const [official, requirement, tongxuan] = [
    await fetchOfficialGpa(ctx),
    await fetchRequirement(ctx),
    await fetchTongxuan(ctx),
  ];
  const data = { at: new Date().toISOString(), official, planName: requirement.planName, requirement: requirement.items, tongxuan };
  writeData('audit', data);
  return data;
}

function fmtCredit(n) {
  if (n == null || !Number.isFinite(n)) return '-';
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
}

function printAudit(a) {
  const g = a.official;
  const lines = [];
  lines.push(`${a.planName ? a.planName + ' · ' : ''}官方平均学分绩点 ${g.gpa ?? '-'}（平均分 ${g.avgScore ?? '-'} · 平均学分绩 ${g.avgCreditScore ?? '-'}）`);
  lines.push(`已修 ${fmtCredit(g.earnedCredits)} 学分 / ${g.courses} 门`);
  const total = a.requirement.find((r) => r.nature === '总计') || {};
  lines.push(`毕业要求 ${fmtCredit(total.required)} 学分 · 正修读 ${fmtCredit(total.ongoing)} · 还需 ${fmtCredit(total.remaining)} 学分`);
  lines.push('');
  lines.push('| 课程性质 | 要求 | 已修 | 正修读 | 还需 |');
  lines.push('|---|---|---|---|---|');
  for (const r of a.requirement) {
    lines.push(`| ${r.nature} | ${fmtCredit(r.required)} | ${fmtCredit(r.earned)} | ${fmtCredit(r.ongoing)} | ${fmtCredit(r.remaining)} |`);
  }
  const tx = a.requirement.find((r) => r.nature === '通选');
  if (tx) {
    lines.push('');
    lines.push(`**公选课（通选）**：要求 ${fmtCredit(tx.required)} 学分，已修 ${fmtCredit(tx.earned)}，在途 ${fmtCredit(tx.ongoing)}，还差 **${fmtCredit(tx.remaining)}** 学分`);
    const cats = a.tongxuan.categories.filter((c) => c.earned || c.ongoing);
    if (cats.length) {
      lines.push('');
      lines.push('| 通选类别 | 已修 | 在途 |');
      lines.push('|---|---|---|');
      for (const c of cats) lines.push(`| ${c.category} | ${fmtCredit(c.earned)} | ${fmtCredit(c.ongoing)} |`);
    }
    const ongoing = a.tongxuan.courses.filter((c) => /正在修读/.test(c.scoreRaw || ''));
    if (ongoing.length) {
      lines.push('');
      lines.push('在途课程：' + ongoing.map((c) => `${c.name}(${c.credit})`).join('、'));
    }
  }
  return lines.join('\n');
}

/* ---------------------------------------------------------------- 培养方案 / 考试 */

async function fetchPlan(ctx) {
  const html = await get(ctx, '/jsxsd/pyfa/pyfa_query');
  const { rows } = parseDataTable(html);
  return rows
    .filter((r) => r['课程名称'])
    .map((r) => ({
      semester: r['开课学期'],
      code: r['课程编号'],
      name: r['课程名称'],
      dept: r['开课单位'],
      credit: num(r['学分']) ?? 0,
      hours: num(r['总学时']) ?? 0,
      assess: r['考核方式'],
      nature: r['课程性质'],
    }));
}

async function fetchExams(ctx) {
  const html = await get(ctx, '/jsxsd/xsks/xsksap_list');
  const { rows } = parseDataTable(html);
  return rows
    .filter((r) => r['课程名称'])
    .map((r) => ({
      session: r['考试场次'],
      code: r['课程编号'],
      name: r['课程名称'],
      time: r['考试时间'],
      room: r['考场'],
      seat: r['座位号'],
    }));
}

/* ---------------------------------------------------------------- 输出 */

function printWeekTable(grid, { full = false } = {}) {
  const header = ['节次', ...DAY_NAMES];
  const lines = [];
  lines.push('| ' + header.join(' | ') + ' |');
  lines.push('|' + header.map(() => '---').join('|') + '|');
  for (const row of grid) {
    const cols = [row.label];
    for (let d = 1; d <= 7; d++) {
      const cell = row.cells.find((c) => c.day === d);
      const txt =
        cell && cell.items.length
          ? cell.items
              .map((i) => {
                const tag = weekTag(i.weeks);
                if (full) {
                  return `${i.name}${i.teacher ? ' ' + i.teacher : ''}${i.room ? ' ' + i.room : ''}（${i.weeks}）`;
                }
                return `${i.name}${i.room ? ' ' + i.room : ''}${tag ? `[${tag}]` : ''}`;
              })
              .join('<br>')
          : '';
      cols.push(txt);
    }
    lines.push('| ' + cols.join(' | ') + ' |');
  }
  return lines.join('\n');
}

function printDayList(items, day) {
  if (!items.length) return `${DAY_NAMES[day - 1]}：没课。`;
  const lines = [`${DAY_NAMES[day - 1]}：`];
  for (const it of items) {
    lines.push(`  ${it.slot} ${it.name}${it.teacher ? ' ' + it.teacher : ''}${it.room ? ' ' + it.room : ''}`);
  }
  return lines.join('\n');
}

function printGradeTable(grades, { compact = false } = {}) {
  if (!grades.length) return '（没有成绩记录）';
  if (compact) {
    return grades.map((g) => `${g.name} ${g.scoreRaw}`).join('；');
  }
  const lines = ['| 学期 | 课程 | 成绩 | 学分 | 绩点 | 性质 |', '|---|---|---|---|---|---|'];
  for (const g of grades) {
    const flag = g.score != null && g.score < 60 ? ' 🔴' : '';
    lines.push(
      `| ${g.semester} | ${g.name}${flag} | ${g.scoreRaw} | ${g.credit} | ${g.gpa} | ${g.nature || '-'} |`,
    );
  }
  return lines.join('\n');
}

function printStats(s) {
  const lines = [];
  lines.push(`已修 ${s.courses} 门 / ${s.credits} 学分（通过 ${s.passedCredits} 学分）`);
  lines.push(`加权平均分 ${s.avgScore.toFixed(2)} · 加权绩点 ${s.avgGpa.toFixed(3)}（含挂科）`);
  lines.push(`官方口径 ${s.officialScore.toFixed(2)} / 绩点 ${s.officialGpa.toFixed(2)}（排除挂科，同教务系统）`);
  if (s.failed.length) {
    lines.push(`挂科 ${s.failed.length} 门：` + s.failed.map((f) => `${f.name}(${f.scoreRaw})`).join('、'));
  } else {
    lines.push('无挂科 🎉');
  }
  lines.push('');
  lines.push('| 学期 | 门数 | 学分 | 加权分 | 绩点 |');
  lines.push('|---|---|---|---|---|');
  for (const sem of Object.keys(s.bySemester).sort()) {
    const v = s.bySemester[sem];
    lines.push(
      `| ${sem} | ${v.courses} | ${v.credits} | ${(v.score / v.credits).toFixed(2)} | ${(v.gpa / v.credits).toFixed(2)} |`,
    );
  }
  lines.push('');
  lines.push('| 课程性质 | 门数 | 学分 | 已通过 |');
  lines.push('|---|---|---|---|');
  for (const [k, v] of Object.entries(s.byNature).sort((a, b) => b[1].credits - a[1].credits)) {
    lines.push(`| ${k} | ${v.courses} | ${v.credits} | ${v.passed} |`);
  }
  return lines.join('\n');
}

/* ---------------------------------------------------------------- main */

const argv = process.argv.slice(2);
const isFlag = (s) => s && s.startsWith('--');
const cmd = argv.length && !isFlag(argv[0]) ? argv[0] : 'status';
const has = (n) => argv.includes('--' + n);
function opt(name, def = null) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v && !isFlag(v) ? v : true;
}
const asJson = has('json');
const noCache = has('no-cache');
const wantsHelp = has('help') || cmd === 'help' || cmd === '-h' || cmd === 'usage';

const USAGE = `sdufe-jw — 山东财经大学教务系统查询（纯 HTTP，不需要浏览器、没有验证码）

用法：node scripts/jw.mjs <命令> [选项]

命令：
  status            当前第几周 + 今天有什么课（无参数时默认）
  brief             一行摘要：周次 + 今天课 + 成绩概况（早报/定时任务首选）
  audit             学业审核：官方绩点 + 各类学分「要求/已修/在途/还需」+ 公选课明细（别名 credit / xf）
  week              只报当前周次 / 总周数
  today | tomorrow  今天 / 明天上什么课
  timetable         整学期课表（--week N 只看某周 / --semester 学期 / --full 带老师）
  grades            成绩（--all 全部学期 / --semester 学期 / --failed 只看挂科 / --compact 一行式）
  gpa               成绩统计：学分、加权分、绩点（含挂科 + 官方口径）、挂科清单、按学期/性质分布
  plan              培养方案（--semester 学期 额外列出该学期计划课程）
  exams             考试安排
  login             验证账号密码（会真发一次请求）

选项：
  --json      输出结构化 JSON（所有命令支持）
  --no-cache  强制重新登录，并跳过 audit 的 10 分钟数据缓存
  --help      显示本帮助

账号：环境变量 JW_USER / JW_PASS / JW_BASE，或与本文件同目录上一层的 config.json
      首次使用：cp config.example.json config.json 然后填入学号密码
更多说明见 README.md / SKILL.md`;

function todayIndex() {
  const d = new Date().getDay(); // 0=周日
  return d === 0 ? 7 : d;
}

async function main() {
  if (wantsHelp) return console.log(USAGE);

  const cfg = loadConfig();
  const ctx = { ...cfg };

  // 会话：优先复用缓存 cookie，省掉一次登录往返
  const cache = noCache ? null : readCache();
  if (cache && cache.cookie && Date.now() - (cache.at || 0) < SESSION_TTL) {
    ctx.cookie = cache.cookie;
  } else {
    await login(ctx);
    writeCache({ at: Date.now(), cookie: ctx.cookie, week: null, weekAt: 0 });
  }

  if (cmd === 'login') {
    // 缓存命中也要真发一次请求验证，否则密码改了也报"成功"
    await get(ctx, '/jsxsd/framework/xsMain_new.jsp');
    console.log(`登录成功：${cfg.user} @ ${cfg.base}`);
    return;
  }

  /* ---- brief：一行摘要，早报用 ---- */
  if (cmd === 'brief') {
    const wk = await currentWeek(ctx, { noCache });
    const { grid } = await fetchTimetable(ctx, wk.semester);
    const todays = itemsForWeek(grid, wk.week).filter((i) => i.day === todayIndex());
    const grades = await fetchGrades(ctx, { mode: 'max' });
    const s = summarize(grades);
    const stamp = new Date().toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
    const head = `第${wk.week}/${wk.total}周 · ${stamp} ${DAY_NAMES[todayIndex() - 1]}`;
    const today = todays.length
      ? '今天：' + todays.map((i) => `${i.slot.replace(/^第|节$/g, '')}${i.name}(${i.room})`).join('、')
      : '今天没课';
    const gpaLine = `已修${s.passedCredits}学分·平均${s.officialScore.toFixed(1)}·绩点${s.officialGpa.toFixed(2)}${s.failed.length ? `·挂${s.failed.length}门` : ''}`;
    if (asJson) {
      return console.log(
        JSON.stringify({ week: wk.week, total: wk.total, semester: wk.semester, today: todays, stats: { credits: s.passedCredits, avgScore: s.officialScore, avgGpa: s.officialGpa, failed: s.failed.map((f) => f.name) } }, null, 2),
      );
    }
    console.log(head);
    console.log(today);
    console.log(gpaLine);
    return;
  }

  /* ---- audit：官方绩点 + 学分要求 + 通选明细，一条命令搞定（不依赖周次，先走） ---- */
  if (cmd === 'audit' || cmd === 'credit' || cmd === 'xf') {
    const a = await fetchAudit(ctx, { noCache });
    if (asJson) return console.log(JSON.stringify(a, null, 2));
    console.log(printAudit(a));
    return;
  }

  const wk = await currentWeek(ctx, { noCache });
  const semester = opt('semester') || wk.semester;

  if (cmd === 'week') {
    if (asJson) return console.log(JSON.stringify(wk, null, 2));
    console.log(`当前第 ${wk.week} 周 / 共 ${wk.total} 周${semester ? `（${semester} 学期）` : ''}`);
    return;
  }

  if (cmd === 'status') {
    const { grid } = await fetchTimetable(ctx, semester);
    const todays = itemsForWeek(grid, wk.week).filter((i) => i.day === todayIndex());
    const stamp = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
    console.log(`当前第 ${wk.week} 周 / 共 ${wk.total} 周${semester ? `（${semester}）` : ''} · ${stamp} ${DAY_NAMES[todayIndex() - 1]}`);
    if (!todays.length) console.log('今天没课。');
    else {
      console.log('今天：');
      for (const it of todays)
        console.log(`  ${it.slot} ${it.name}${it.teacher ? ' ' + it.teacher : ''}${it.room ? ' ' + it.room : ''}`);
    }
    return;
  }

  if (cmd === 'today' || cmd === 'tomorrow') {
    const { grid } = await fetchTimetable(ctx, semester);
    let week = wk.week;
    let day = todayIndex();
    if (cmd === 'tomorrow') {
      day += 1;
      if (day > 7) {
        day = 1;
        week += 1;
      }
    }
    const list = itemsForWeek(grid, week).filter((i) => i.day === day);
    if (asJson) return console.log(JSON.stringify({ week, day, items: list }, null, 2));
    if (!list.length) return console.log(`第 ${week} 周 ${DAY_NAMES[day - 1]}：没课。`);
    console.log(`第 ${week} 周 ` + printDayList(list, day));
    return;
  }

  if (cmd === 'timetable' || cmd === 'week-table') {
    const weekFilter = opt('week');
    const { grid, remark } = await fetchTimetable(ctx, semester, weekFilter);
    if (asJson) {
      return console.log(
        JSON.stringify({ semester, currentWeek: wk.week, totalWeeks: wk.total, week: weekFilter, grid, remark }, null, 2),
      );
    }
    console.log(`# ${semester || ''} 学期理论课表${weekFilter ? ` · 第 ${weekFilter} 周` : ''}`);
    console.log(printWeekTable(grid, { full: has('full') }));
    if (remark) console.log('\n备注：' + remark);
    return;
  }

  /* ---- grades ---- */
  if (cmd === 'grades') {
    const all = has('all');
    const onlyFailed = has('failed');
    // --failed 默认跨全部学期找（挂科往往不在本学期）
    let list = await fetchGrades(ctx, { semester: all || onlyFailed ? '' : semester, mode: 'max' });
    if (!list.length && !all && !onlyFailed) {
      // 本学期还没出分，回退到最近有成绩的学期
      const everything = await fetchGrades(ctx, { mode: 'max' });
      const latest = latestSemester(everything);
      list = everything.filter((g) => g.semester === latest);
      console.log(`（${semester} 暂无成绩，以下为最近学期 ${latest}）`);
    }
    if (onlyFailed) {
      list = list.filter((g) => g.score != null && g.score < 60);
      if (!list.length) return console.log('无挂科 🎉');
    }
    if (asJson) return console.log(JSON.stringify({ semester: all ? 'all' : onlyFailed ? 'all' : semester, grades: list }, null, 2));
    console.log(printGradeTable(list, { compact: has('compact') }));
    return;
  }

  /* ---- gpa ---- */
  if (cmd === 'gpa' || cmd === 'stats') {
    const grades = await fetchGrades(ctx, { mode: 'max' });
    const s = summarize(grades);
    if (asJson) return console.log(JSON.stringify(s, null, 2));
    console.log(printStats(s));
    return;
  }

  /* ---- plan ---- */
  if (cmd === 'plan') {
    const plan = await fetchPlan(ctx);
    const bySem = {};
    for (const p of plan) {
      const b = (bySem[p.semester] ||= { credits: 0, courses: 0 });
      b.credits += p.credit;
      b.courses += 1;
    }
    const grades = await fetchGrades(ctx, { mode: 'max' });
    const s = summarize(grades);
    const pname = await fetchPlanName(ctx);
    const totalPlanCredit = plan.reduce((a, p) => a + p.credit, 0);
    if (asJson) return console.log(JSON.stringify({ planName: pname, plan, totalCredits: totalPlanCredit, bySemester: bySem, earned: s }, null, 2));
    console.log(`# 培养方案${pname ? '：' + pname : ''}（${plan.length} 门 / ${totalPlanCredit} 学分）`);
    console.log('');
    console.log('| 学期 | 门数 | 计划学分 | 已修学分 |');
    console.log('|---|---|---|---|');
    for (const sem of Object.keys(bySem).sort()) {
      const earned = s.bySemester[sem] ? s.bySemester[sem].credits : 0;
      console.log(`| ${sem} | ${bySem[sem].courses} | ${bySem[sem].credits} | ${earned} |`);
    }
    if (opt('semester')) {
      const target = opt('semester');
      console.log('');
      console.log(`## ${target} 计划课程`);
      for (const p of plan.filter((x) => x.semester === target)) {
        console.log(`- ${p.name}（${p.credit}学分，${p.nature}，${p.assess}）`);
      }
    }
    return;
  }

  /* ---- exams ---- */
  if (cmd === 'exams') {
    const list = await fetchExams(ctx);
    if (asJson) return console.log(JSON.stringify(list, null, 2));
    if (!list.length) return console.log('暂无考试安排。');
    console.log('| 课程 | 时间 | 考场 | 座位 |');
    console.log('|---|---|---|---|');
    for (const e of list) console.log(`| ${e.name} | ${e.time} | ${e.room} | ${e.seat} |`);
    return;
  }

  console.error(
    `未知命令：${cmd}\n可用：status | brief | audit | week | today | tomorrow | timetable | grades | gpa | plan | exams | login\n（node scripts/jw.mjs --help 看完整说明）`,
  );
  process.exitCode = 1;
}

main().catch((err) => {
  console.error('✗ ' + (err && err.message ? err.message : err));
  process.exitCode = 1;
});
