/**
 * caldav.mjs — CalDAV HTTP 客户端（群晖日历）
 *
 * 从 OpenClaw 插件 synology-calendar/src/caldav.ts 移植，
 * 逻辑保持原样（PROPFIND/REPORT/PUT/DELETE/GET + iCal 解析/构建 + 中英文日历别名）。
 * 零框架依赖：仅用全局 fetch / crypto / Buffer。
 */
export class CalDavClient {
  constructor(config) {
    this.config = config;
    /** Cached calendar name→path map, populated lazily */
    this.calendarCache = null;
  }

  get baseUrl() {
    let url = this.config.url;
    if (!url.endsWith("/")) url += "/";
    return url;
  }

  /** Detect system timezone (e.g. Asia/Shanghai) */
  get systemTimezone() {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  /** Format Date to iCal local time with TZID: YYYYMMDDTHHMMSS */
  formatIcalLocal(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const h = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    const s = String(d.getSeconds()).padStart(2, "0");
    return `${y}${m}${day}T${h}${min}${s}`;
  }

  get authHeader() {
    const raw = `${this.config.username}:${this.config.password}`;
    return "Basic " + Buffer.from(raw, "utf-8").toString("base64");
  }

  async request(method, path, body, contentType, depth) {
    // Server-returned hrefs may be absolute paths (/caldav.php/...) or relative to baseUrl
    const url = path.startsWith("http")
      ? path
      : path.startsWith("/")
        ? new URL(path, this.baseUrl).toString()
        : this.baseUrl + path.replace(/^\//, "");
    const headers = {
      Authorization: this.authHeader,
    };
    if (depth) headers["Depth"] = depth;
    if (body) {
      headers["Content-Type"] = contentType || "text/xml; charset=utf-8";
    }
    const res = await fetch(url, { method, headers, body });
    const text = await res.text();
    return { status: res.status, body: text };
  }

  /** Get deduplicated list of all calendars as {name, path} pairs. */
  async getAllCalendars() {
    const map = await this.getCalendarMap();
    const seen = new Set();
    const out = [];
    for (const [name, path] of Object.entries(map)) {
      if (!path || seen.has(path)) continue;
      seen.add(path);
      out.push({ name, path });
    }
    return out;
  }

  /** Get full calendar path for a named calendar. Config overrides take priority. */
  async getCalendarPath(calendar) {
    if (this.config.calendars?.[calendar]) {
      return this.config.calendars[calendar];
    }
    const map = await this.getCalendarMap();
    const path = map[calendar];
    if (path) return path;
    const home = map["home"] || map["家庭"] || Object.values(map)[0];
    return home || "";
  }

  /** Get lazy-initialized calendar name→path map */
  async getCalendarMap() {
    if (this.calendarCache) return this.calendarCache;
    const calendars = await this.discoverCalendars();
    const map = {};
    for (const cal of calendars) {
      // Strip /caldav.php/ prefix for consistent paths
      const path = cal.href.replace(/^\/?caldav\.php\/?/, "");
      map[cal.displayName] = path;
      for (const alias of this.aliasesFor(cal)) {
        map[alias] = path;
      }
      const seg = cal.href.replace(/\/$/, "").split("/").pop();
      if (seg) map[seg] = path;
    }
    if (this.config.calendars) {
      for (const [name, path] of Object.entries(this.config.calendars)) {
        map[name] = path;
      }
    }
    this.calendarCache = map;
    return map;
  }

  /** Semantic aliases for a discovered calendar (中文/English common names) */
  aliasesFor(cal) {
    const display = cal.displayName;
    const aliases = [];
    if (/家庭|home|family/i.test(display)) aliases.push("home", "家庭", "family");
    if (/工作|work|office/i.test(display)) aliases.push("work", "工作", "office");
    if (/个人|personal|private/i.test(display)) aliases.push("personal", "个人", "private");
    if (/inbox|待办|任务|todo/i.test(display)) aliases.push("inbox", "待办", "todo");
    return aliases;
  }

  /** Resolve full URL for a calendar path and optional UID */
  eventUrl(calendarPath, uid) {
    const base = this.baseUrl + calendarPath.replace(/^\//, "");
    return uid ? `${base.replace(/\/$/, "")}/${uid}.ics` : base;
  }

  // ─── XML Parsing (lightweight, no external deps) ───

  textContent(xml, tag) {
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
    const m = re.exec(xml);
    return m ? m[1].trim() : undefined;
  }

  allTextContents(xml, tag) {
    const results = [];
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
    let m;
    while ((m = re.exec(xml)) !== null) {
      results.push(m[1].trim());
    }
    return results;
  }

  /** Find all response blocks from a multistatus response */
  parseResponses(xml) {
    const blocks = [];
    const re = /<d:response[\s\S]*?>([\s\S]*?)<\/d:response>/gi;
    const re2 = /<response[\s\S]*?>([\s\S]*?)<\/response>/gi;
    let m;
    while ((m = re.exec(xml)) !== null) blocks.push(m[0]);
    if (blocks.length === 0) {
      while ((m = re2.exec(xml)) !== null) blocks.push(m[0]);
    }
    return blocks;
  }

  /** Extract href from a response block */
  parseHref(responseXml) {
    return this.textContent(responseXml, "d:href")
      || this.textContent(responseXml, "href")
      || "";
  }

  // ─── Calendar Discovery (RFC 4791 / Synology flow) ───

  async discoverCalendars() {
    const principal = await this.findCurrentUserPrincipal();
    const homeSet = await this.findCalendarHomeSet(principal);
    return this.listCalendars(homeSet);
  }

  /** Step 1: find current-user-principal href from the server root */
  async findCurrentUserPrincipal() {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:current-user-principal />
  </d:prop>
</d:propfind>`;

    const res = await this.request("PROPFIND", "", body, undefined, "0");
    if (res.status !== 207) {
      throw new Error(`Principal discovery failed: HTTP ${res.status} - ${res.body}`);
    }

    const m = /<[^>]*current-user-principal[^>]*>([\s\S]*?)<\/[^>]*current-user-principal[^>]*>/i.exec(res.body);
    if (!m) throw new Error("No current-user-principal found in server response");
    const href = this.textContent(m[1], "href") || this.textContent(m[1], "d:href");
    if (!href) throw new Error("current-user-principal href is empty");
    return href;
  }

  /** Step 2: find calendar-home-set href for a principal */
  async findCalendarHomeSet(principalPath) {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <c:calendar-home-set />
  </d:prop>
</d:propfind>`;

    const res = await this.request("PROPFIND", principalPath, body, undefined, "0");
    if (res.status !== 207) {
      throw new Error(`calendar-home-set discovery failed: HTTP ${res.status} - ${res.body}`);
    }

    const m = /<[^>]*calendar-home-set[^>]*>([\s\S]*?)<\/[^>]*calendar-home-set[^>]*>/i.exec(res.body);
    if (!m) throw new Error("No calendar-home-set found in server response");
    const href = this.textContent(m[1], "href") || this.textContent(m[1], "d:href");
    if (!href) throw new Error("calendar-home-set href is empty");
    return href;
  }

  /** Step 3: list calendar collections under the calendar-home-set */
  async listCalendars(homeSetPath) {
    const propfindBody = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">
  <d:prop>
    <d:displayname />
    <d:resourcetype />
    <cs:getctag />
  </d:prop>
</d:propfind>`;

    const res = await this.request("PROPFIND", homeSetPath, propfindBody, undefined, "1");
    if (res.status !== 207) {
      throw new Error(`Calendar discovery failed: HTTP ${res.status} - ${res.body}`);
    }

    const calendars = [];
    const responses = this.parseResponses(res.body);

    for (const resp of responses) {
      const href = this.parseHref(resp);
      const resTypes = this.allTextContents(resp, "d:resourcetype").join(" ")
        + " " + this.allTextContents(resp, "resourcetype").join(" ");

      if (!resTypes.includes("calendar")) continue;
      if (href.includes("/.in/") || href.includes("/.out/")) continue;

      calendars.push({
        href,
        displayName: this.textContent(resp, "d:displayname")
          || this.textContent(resp, "displayname")
          || href,
        ctag: this.textContent(resp, "cs:getctag")
          || this.textContent(resp, "getctag"),
      });
    }

    return calendars;
  }

  // ─── Query Events ───

  async queryEvents(params) {
    const fmtDate = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const reportBody = `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:C="urn:ietf:params:xml:ns:caldav"
                   xmlns:d="DAV:">
  <d:prop>
    <d:getetag />
    <C:calendar-data />
  </d:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="${fmtDate(params.startDate)}" end="${fmtDate(params.endDate)}" />
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;

    const res = await this.request("REPORT", params.calendarPath, reportBody);
    if (res.status !== 207) {
      throw new Error(`Event query failed: HTTP ${res.status} - ${res.body}`);
    }

    const events = [];
    const responses = this.parseResponses(res.body);

    for (const resp of responses) {
      const href = this.parseHref(resp);
      const icalData = this.textContent(resp, "C:calendar-data")
        || this.textContent(resp, "calendar-data")
        || "";
      const etag = this.textContent(resp, "d:getetag")
        || this.textContent(resp, "getetag");

      if (!icalData) continue;

      const event = this.parseVEvent(icalData);
      if (event) {
        event.href = href;
        event.etag = etag;
        events.push(event);
      }
    }

    return events;
  }

  // ─── Create Event ───

  async createEvent(calendarPath, params) {
    const uid = crypto.randomUUID();
    const ical = this.buildVEvent(uid, params);
    const url = this.eventUrl(calendarPath, uid);

    const res = await this.request("PUT", url, ical, "text/calendar; charset=utf-8");
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Event creation failed: HTTP ${res.status} - ${res.body}`);
    }

    return uid;
  }

  // ─── Update Event ───

  async updateEvent(calendarPath, uid, params) {
    const existing = await this.getEvent(calendarPath, uid);

    const merged = {
      title: params.title ?? existing.summary,
      startTime: params.startTime ?? this.parseIcalDate(existing.dtstart),
      endTime: params.endTime ?? this.parseIcalDate(existing.dtend),
      description: params.description ?? existing.description,
      location: params.location ?? existing.location,
    };

    const ical = this.buildVEvent(uid, merged);
    const url = this.eventUrl(calendarPath, uid);

    const res = await this.request("PUT", url, ical, "text/calendar; charset=utf-8");
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Event update failed: HTTP ${res.status} - ${res.body}`);
    }

    return {
      uid,
      summary: merged.title,
      dtstart: this.formatIcalDate(merged.startTime),
      dtend: this.formatIcalDate(merged.endTime),
      description: merged.description,
      location: merged.location,
      status: "CONFIRMED",
    };
  }

  // ─── Delete Event ───

  async deleteEvent(calendarPath, uid) {
    const url = this.eventUrl(calendarPath, uid);
    const res = await this.request("DELETE", url);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Event deletion failed: HTTP ${res.status} - ${res.body}`);
    }
  }

  // ─── Get Single Event ───

  async getEvent(calendarPath, uid) {
    const url = this.eventUrl(calendarPath, uid);
    const res = await this.request("GET", url);
    if (res.status !== 200) {
      throw new Error(`Event fetch failed: HTTP ${res.status} - ${res.body}`);
    }

    const event = this.parseVEvent(res.body);
    if (!event) {
      throw new Error("Failed to parse event data");
    }
    event.href = url;
    return event;
  }

  // ─── VTODO (Task) Operations ───

  async queryTodos(calendarPath, startDate, endDate) {
    let filterXml;
    if (startDate && endDate) {
      const fmt = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
      filterXml = `
        <C:filter>
          <C:comp-filter name="VCALENDAR">
            <C:comp-filter name="VTODO">
              <C:time-range start="${fmt(startDate)}" end="${fmt(endDate)}" />
            </C:comp-filter>
          </C:comp-filter>
        </C:filter>`;
    } else {
      filterXml = `
        <C:filter>
          <C:comp-filter name="VCALENDAR">
            <C:comp-filter name="VTODO" />
          </C:comp-filter>
        </C:filter>`;
    }

    const reportBody = `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:C="urn:ietf:params:xml:ns:caldav"
                   xmlns:d="DAV:">
  <d:prop>
    <d:getetag />
    <C:calendar-data />
  </d:prop>
  ${filterXml}
</C:calendar-query>`;

    const res = await this.request("REPORT", calendarPath, reportBody);
    if (res.status !== 207) {
      throw new Error(`Todo query failed: HTTP ${res.status} - ${res.body}`);
    }

    const todos = [];
    const responses = this.parseResponses(res.body);

    for (const resp of responses) {
      const href = this.parseHref(resp);
      const icalData = this.textContent(resp, "C:calendar-data")
        || this.textContent(resp, "calendar-data")
        || "";
      const etag = this.textContent(resp, "d:getetag")
        || this.textContent(resp, "getetag");

      if (!icalData) continue;

      const todo = this.parseVTodo(icalData);
      if (todo) {
        todo.href = href;
        todo.etag = etag;
        todos.push(todo);
      }
    }

    return todos;
  }

  async createTodo(calendarPath, params) {
    const uid = crypto.randomUUID();
    const ical = this.buildVTodo(uid, params);
    const url = this.eventUrl(calendarPath, uid);

    const res = await this.request("PUT", url, ical, "text/calendar; charset=utf-8");
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Todo creation failed: HTTP ${res.status} - ${res.body}`);
    }

    return uid;
  }

  /** Complete a task by setting STATUS=COMPLETED and PERCENT-COMPLETE=100 */
  async completeTodo(calendarPath, uid) {
    const url = this.eventUrl(calendarPath, uid);
    const res = await this.request("GET", url);
    if (res.status !== 200) {
      throw new Error(`Todo fetch failed: HTTP ${res.status} - ${res.body}`);
    }

    const now = new Date();
    const nowIcal = this.formatIcalDate(now);

    const summary = this.getIcalValue(res.body, "SUMMARY") || "";
    const desc = this.getIcalValue(res.body, "DESCRIPTION");
    const due = this.getIcalValue(res.body, "DUE");

    let ical = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Synology Calendar//dsh Plugin//EN\r\nCALSCALE:GREGORIAN\r\nBEGIN:VTODO\r\nUID:${uid}\r\nSUMMARY:${this.escapeIcal(summary)}\r\nSTATUS:COMPLETED\r\nPERCENT-COMPLETE:100\r\nCOMPLETED:${nowIcal}\r\n`;
    if (desc) ical += `DESCRIPTION:${this.escapeIcal(desc)}\r\n`;
    if (due) ical += `DUE:${due}\r\n`;
    ical += `DTSTAMP:${nowIcal}\r\nEND:VTODO\r\nEND:VCALENDAR`;

    const putRes = await this.request("PUT", url, ical, "text/calendar; charset=utf-8");
    if (putRes.status < 200 || putRes.status >= 300) {
      throw new Error(`Todo completion failed: HTTP ${putRes.status} - ${putRes.body}`);
    }
  }

  /** Update an existing task (VTODO) by UID. Only provided fields are updated. */
  async updateTodo(calendarPath, uid, params) {
    const url = this.eventUrl(calendarPath, uid);
    const res = await this.request("GET", url);
    if (res.status !== 200) {
      throw new Error(`Todo fetch failed: HTTP ${res.status} - ${res.body}`);
    }

    const existing = this.parseVTodo(res.body);
    if (!existing) {
      throw new Error("Failed to parse todo data");
    }

    const summary = params.summary ?? existing.summary;
    const description = params.description !== undefined
      ? params.description
      : existing.description;
    const due = params.due
      ? this.formatIcalDate(params.due).split("T")[0]
      : (existing.due || "").replace(/^[^:]*:?/, "");

    const now = new Date();
    const nowIcal = this.formatIcalDate(now);

    let ical = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Synology Calendar//dsh Plugin//EN\r\nCALSCALE:GREGORIAN\r\nBEGIN:VTODO\r\nUID:${uid}\r\nSUMMARY:${this.escapeIcal(summary)}\r\nSTATUS:${existing.status || "NEEDS-ACTION"}\r\nPERCENT-COMPLETE:${existing.percentComplete ?? 0}\r\n`;
    if (description) ical += `DESCRIPTION:${this.escapeIcal(description)}\r\n`;
    if (due) ical += `DUE;VALUE=DATE:${due}\r\n`;
    if (existing.completed) ical += `COMPLETED:${existing.completed}\r\n`;
    ical += `DTSTAMP:${nowIcal}\r\nEND:VTODO\r\nEND:VCALENDAR`;

    const putRes = await this.request("PUT", url, ical, "text/calendar; charset=utf-8");
    if (putRes.status < 200 || putRes.status >= 300) {
      throw new Error(`Todo update failed: HTTP ${putRes.status} - ${putRes.body}`);
    }

    return {
      uid,
      summary,
      description,
      due,
      status: existing.status || "NEEDS-ACTION",
      percentComplete: existing.percentComplete ?? 0,
    };
  }

  async deleteTodo(calendarPath, uid) {
    await this.deleteEvent(calendarPath, uid);
  }

  // ─── iCalendar parsing/building ───

  parseVEvent(icalText) {
    const uid = this.getIcalValue(icalText, "UID");
    const summary = this.getIcalValue(icalText, "SUMMARY");
    const dtstart = this.getIcalValueWithTz(icalText, "DTSTART");
    const dtend = this.getIcalValueWithTz(icalText, "DTEND");
    const description = this.getIcalValue(icalText, "DESCRIPTION");
    const location = this.getIcalValue(icalText, "LOCATION");
    const status = this.getIcalValue(icalText, "STATUS");

    if (!uid || !summary || !dtstart) return null;

    return {
      uid,
      summary,
      dtstart,
      dtend,
      description,
      location,
      status,
    };
  }

  getIcalValue(ical, name) {
    const re = new RegExp(`^${name}(?:;[^:]*)?:(.*)$`, "m");
    const m = re.exec(ical);
    if (!m) return undefined;
    return this.unescapeIcal(m[1].trim());
  }

  /** Get DTSTART/DTEND with timezone info preserved */
  getIcalValueWithTz(ical, name) {
    const re = new RegExp(`^${name}((?:;[^:]*)?):(.*)$`, "m");
    const m = re.exec(ical);
    if (!m) return "";
    const params = m[1];
    const value = m[2].trim();
    if (params) {
      return `${params}:${value}`;
    }
    return value;
  }

  /** Build VEVENT iCal text */
  buildVEvent(uid, params) {
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Synology Calendar//dsh Plugin//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      `UID:${uid}`,
    ];

    if (params.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${this.formatIcalDate(params.startTime).split("T")[0]}`);
      lines.push(`DTEND;VALUE=DATE:${this.formatIcalDate(params.endTime).split("T")[0]}`);
    } else {
      lines.push(`DTSTART:${this.formatIcalDate(params.startTime)}`);
      lines.push(`DTEND:${this.formatIcalDate(params.endTime)}`);
    }

    lines.push(this.foldLine(`SUMMARY:${this.escapeIcal(params.title)}`));

    if (params.description) {
      const desc = this.escapeIcal(params.description);
      lines.push(this.foldLine(`DESCRIPTION:${desc}`));
    }

    if (params.location) {
      lines.push(this.foldLine(`LOCATION:${this.escapeIcal(params.location)}`));
    }

    lines.push("STATUS:CONFIRMED");
    lines.push(`DTSTAMP:${this.formatIcalDate(new Date())}`);
    lines.push("END:VEVENT");
    lines.push("END:VCALENDAR");

    return lines.join("\r\n");
  }

  /** Parse VTODO from iCal text */
  parseVTodo(icalText) {
    const uid = this.getIcalValue(icalText, "UID");
    const summary = this.getIcalValue(icalText, "SUMMARY");
    const description = this.getIcalValue(icalText, "DESCRIPTION");
    const dtstart = this.getIcalValueWithTz(icalText, "DTSTART");
    const due = this.getIcalValueWithTz(icalText, "DUE");
    const status = this.getIcalValue(icalText, "STATUS");
    const pct = this.getIcalValue(icalText, "PERCENT-COMPLETE");
    const completed = this.getIcalValue(icalText, "COMPLETED");

    if (!uid) return null;

    return {
      uid,
      summary: summary || "(unnamed task)",
      description,
      dtstart,
      due,
      status: status || "NEEDS-ACTION",
      percentComplete: pct ? parseInt(pct, 10) : undefined,
      completed,
    };
  }

  /** Build VTODO iCal text */
  buildVTodo(uid, params) {
    const now = this.formatIcalDate(new Date());
    let ical = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Synology Calendar//dsh Plugin//EN",
      "CALSCALE:GREGORIAN",
      "BEGIN:VTODO",
      `UID:${uid}`,
      `SUMMARY:${this.escapeIcal(params.summary)}`,
      "STATUS:NEEDS-ACTION",
      "PERCENT-COMPLETE:0",
    ];
    if (params.description) {
      ical.push(`DESCRIPTION:${this.escapeIcal(params.description)}`);
    }
    if (params.due) {
      const dateOnly = this.formatIcalDate(params.due).split("T")[0];
      ical.push(`DUE;VALUE=DATE:${dateOnly}`);
    }
    ical.push(`DTSTAMP:${now}`);
    ical.push("END:VTODO");
    ical.push("END:VCALENDAR");
    return ical.join("\r\n");
  }

  /** Format JS Date to iCal UTC format: YYYYMMDDTHHMMSSZ */
  formatIcalDate(d) {
    return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  }

  /** Parse iCal date string to JS Date */
  parseIcalDate(icalDate) {
    const colonIndex = icalDate.lastIndexOf(":");
    const clean = colonIndex >= 0 ? icalDate.slice(colonIndex + 1) : icalDate;
    if (clean.endsWith("Z")) {
      const str = clean.slice(0, -1);
      return new Date(
        `${str.slice(0, 4)}-${str.slice(4, 6)}-${str.slice(6, 8)}T${str.slice(9, 11)}:${str.slice(11, 13)}:${str.slice(13, 15)}Z`,
      );
    }
    if (clean.length === 15) {
      return new Date(
        `${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}T${clean.slice(9, 11)}:${clean.slice(11, 13)}:${clean.slice(13, 15)}Z`,
      );
    }
    return new Date(`${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}`);
  }

  escapeIcal(text) {
    return text
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      .replace(/\n/g, "\\n");
  }

  unescapeIcal(text) {
    return text
      .replace(/\\n/g, "\n")
      .replace(/\\,/g, ",")
      .replace(/\\;/g, ";")
      .replace(/\\\\/g, "\\");
  }

  /** Fold a long iCal line (RFC 5545: max 75 octets per line) */
  foldLine(line) {
    if (line.length <= 75) return line;
    const parts = [];
    parts.push(line.slice(0, 75));
    let remaining = line.slice(75);
    while (remaining.length > 0) {
      parts.push(" " + remaining.slice(0, 74));
      remaining = remaining.slice(74);
    }
    return parts.join("\r\n");
  }

  formatEventDate(icalDate) {
    try {
      return this.parseIcalDate(icalDate).toISOString();
    } catch {
      return icalDate;
    }
  }

  /** Convert VEvent to a plain object for tool output */
  veventToPlain(event) {
    return {
      uid: event.uid,
      title: event.summary,
      start: this.formatEventDate(event.dtstart),
      end: event.dtend ? this.formatEventDate(event.dtend) : undefined,
      description: event.description,
      location: event.location,
      status: event.status,
    };
  }
}
