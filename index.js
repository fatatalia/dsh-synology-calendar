/**
 * dsh-synology-calendar — 群晖日历插件（host 半部分）
 *
 * 从 OpenClaw 插件 synology-calendar 移植：CalDAV 客户端 + 8 个日历工具。
 * 配置：url/username/calendars 走 settings（热生效 + 配置页）；
 * 密码存 dsh credentials（ref: CALDAV_PASSWORD），经本插件 remote 读写
 * （不走 apiproxy 的 credentials.* 特权通道，域名访问也能改）。
 */
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import z from "@deepseek-ai/schemastery";
import { homedir } from "node:os";
import { join } from "node:path";
import { CalDavClient } from "./lib/caldav.mjs";

export const name = "dsh-synology-calendar";

export const inject = ["typert", "settings", "tools", "credentials"];

export const Config = z.object({
  settingsPath: z.string().default(join(homedir(), ".dsh", "settings.yaml")),
});

/** `calendar` settings namespace。 */
const CalendarSchema = z.object({
  url: z.string(),
  username: z.string(),
  calendars: z.dict(z.string()),
});

/** 密码 credential ref（存 .credentials.yaml）。 */
const PASSWORD_REF = "CALDAV_PASSWORD";

// ── Typert wire schemas（宽松 parse） ───────────────────────────────────────
function parseObj() {
  return { parse(value) { if (typeof value !== "object" || value === null) throw new Error("expected object"); return value; } };
}
const getResultSchema = parseObj();
const setPayloadSchema = parseObj();
const setResultSchema = parseObj();

const MANIFEST = {
  package: "dsh-synology-calendar",
  face: "host",
  schemas: [],
  invocations: [
    {
      id: "dsh-synology-calendar#calendar/getConfig",
      service: "calendar",
      namespace: "calendar",
      method: "getConfig",
      invocation: { kind: "direct" },
      parameters: [],
      result: { mode: "strict", typeSymbol: "dsh-synology-calendar#CalendarConfig", schema: getResultSchema },
    },
    {
      id: "dsh-synology-calendar#calendar/setConfig",
      service: "calendar",
      namespace: "calendar",
      method: "setConfig",
      invocation: { kind: "direct" },
      parameters: [
        { name: "payload", wire: "payload", source: "json", codec: { mode: "strict", typeSymbol: "dsh-synology-calendar#SetPayload", schema: setPayloadSchema } },
      ],
      result: { mode: "strict", typeSymbol: "dsh-synology-calendar#SetResult", schema: setResultSchema },
    },
    {
      id: "dsh-synology-calendar#calendar/setPassword",
      service: "calendar",
      namespace: "calendar",
      method: "setPassword",
      invocation: { kind: "direct" },
      parameters: [
        { name: "payload", wire: "payload", source: "json", codec: { mode: "strict", typeSymbol: "dsh-synology-calendar#SetPasswordPayload", schema: setPayloadSchema } },
      ],
      result: { mode: "strict", typeSymbol: "dsh-synology-calendar#SetResult", schema: setResultSchema },
    },
    {
      id: "dsh-synology-calendar#calendar/passwordState",
      service: "calendar",
      namespace: "calendar",
      method: "passwordState",
      invocation: { kind: "direct" },
      parameters: [],
      result: { mode: "strict", typeSymbol: "dsh-synology-calendar#PasswordState", schema: getResultSchema },
    },
  ],
  model: { services: [], events: [], objects: [] },
};

/** Remote service：读写日历配置 + 密码。 */
class CalendarService extends TypertRemoteService {
  constructor(ctx, scope) {
    super(ctx, "calendar");
    this.scope = scope;
    this.credentials = ctx.get("credentials");
  }
  getConfig() {
    const snap = this.scope.get();
    return {
      url: snap?.url ?? "",
      username: snap?.username ?? "",
      calendars: snap?.calendars ?? {},
      writable: true,
    };
  }
  async setConfig(payload) {
    const patch = {};
    for (const k of ["url", "username", "calendars"]) {
      if (payload?.[k] !== undefined) patch[k] = payload[k];
    }
    if (Object.keys(patch).length === 0) return { ok: true };
    await this.scope.update(patch);
    return { ok: true };
  }
  /** 保存密码到 credentials（空值 = 清除）。 */
  async setPassword(payload) {
    const value = payload?.password;
    if (value) await this.credentials?.set(credentialRef(PASSWORD_REF), String(value));
    else await this.credentials?.unset(credentialRef(PASSWORD_REF));
    return { ok: true };
  }
  /** 密码是否已配置（不返回密码本身）。 */
  async passwordState() {
    const info = await this.credentials?.describe?.(credentialRef(PASSWORD_REF));
    return { configured: !!info?.configured, writable: info?.writable ?? true };
  }
}

/** 读取密码（每次现取，改密码即生效）。 */
async function resolvePassword(credentials) {
  if (!credentials) throw new Error("credentials 服务不可用");
  const got = await credentials.resolve(credentialRef(PASSWORD_REF));
  if (!got?.value) throw new Error("CALDAV 密码未配置：请在设置页填写密码");
  return got.value;
}

async function buildClient(credentials, cfg) {
  return new CalDavClient({
    url: cfg.url,
    username: cfg.username,
    password: await resolvePassword(credentials),
    calendars: cfg.calendars,
  });
}

/** iCal date (20260302T120536Z) → YYYY-MM-DD */
function fmtIcalDate(icalDate) {
  const m = /^(\d{4})(\d{2})(\d{2})T/.exec(icalDate);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : icalDate;
}

function fmtEvent(event) {
  const parts = [`- ${event.summary}`];
  if (event.dtstart) parts.push(`  开始: ${event.dtstart}`);
  if (event.dtend) parts.push(`  结束: ${event.dtend}`);
  if (event.description) parts.push(`  描述: ${event.description}`);
  if (event.location) parts.push(`  地点: ${event.location}`);
  if (event.uid) parts.push(`  UID: ${event.uid}`);
  return parts.join("\n");
}

export function apply(ctx, config) {
  const Logger = ctx.logger;
  const log = {
    info: (m) => { console.log(`[cal] ${m}`); try { Logger?.info?.(m); } catch {} },
    warn: (m) => { console.warn(`[cal:warn] ${m}`); try { Logger?.warn?.(m); } catch {} },
    error: (m) => { console.error(`[cal:err] ${m}`); try { Logger?.error?.(m); } catch {} },
  };

  const scope = ctx.settings.register("calendar", CalendarSchema, {
    base: { url: "", username: "", calendars: {} },
  });
  const service = new CalendarService(ctx, scope);
  ctx.effect(() => ctx.typert.register(MANIFEST), "dsh-synology-calendar: typert manifest");

  const credentials = ctx.get("credentials");
  const cfg = () => {
    const snap = scope.get();
    return {
      url: snap?.url ?? "",
      username: snap?.username ?? "",
      calendars: snap?.calendars ?? {},
    };
  };

  // 每次执行现取配置 + 密码（改配置/密码无需重启）。
  const client = async () => buildClient(credentials, cfg());

  // ── 9 个日历工具（defineTool 编译扁平参数为标准 JSON Schema，兼容所有 provider）──
  // ⚠️ 教训（2026-08-15）：output.render 必须返回 content 块数组 [{type:"text",text}]，
  // 返回纯字符串会导致 dsh-llm contentHasImage 递归遍历时 "content.some is not a function"，
  // 且坏记录留在会话历史里会让整个会话后续所有轮次全部失败（需手动修复 session.jsonl）。
  const tools = [
    {
      name: "calendar_query_events",
      description: "查询日历日程（支持日期范围；不传 calendar 时自动查询所有日历并按日历分组返回）。返回事件详情含 UID、标题、时间、描述、地点。",
      parameters: {
        start_date: { type: "string", required: true, description: "开始日期或时间，YYYY-MM-DD 或 ISO 8601" },
        end_date: { type: "string", description: "结束日期或时间；不传则默认到开始日期当天结束" },
        calendar: { type: "string", description: "日历名：home / work / personal（支持中英文）；不传查全部" },
      },
      output: {
        schema: { type: "string" },
        render(args, value) { return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }]; },
      },
      async execute(args) {
        const c = await client();
        const startDate = new Date(args.start_date);
        let endDate;
        if (args.end_date) {
          endDate = new Date(args.end_date);
        } else {
          endDate = new Date(startDate);
          endDate.setHours(23, 59, 59, 999);
        }
        if (!args.calendar) {
          const calendars = await c.getAllCalendars();
          if (calendars.length === 0) return "未发现任何日历。";
          const groups = [];
          let total = 0;
          for (const cal of calendars) {
            const events = await c.queryEvents({ startDate, endDate, calendarPath: cal.path });
            if (events.length === 0) continue;
            total += events.length;
            groups.push(`【${cal.name}】`);
            for (const ev of events) groups.push(fmtEvent(ev));
            groups.push("");
          }
          if (total === 0) return `没有找到 ${args.start_date} 到 ${args.end_date || args.start_date} 之间的日程事件。`;
          return [`找到 ${total} 个事件（全部日历）：`, "", ...groups].join("\n");
        }
        const calendarPath = await c.getCalendarPath(args.calendar);
        const events = await c.queryEvents({ startDate, endDate, calendarPath });
        if (events.length === 0) return `没有找到 ${args.start_date} 到 ${args.end_date || args.start_date} 之间的日程事件。`;
        const lines = [`找到 ${events.length} 个事件：`, ""];
        for (const ev of events) lines.push(fmtEvent(ev));
        return lines.join("\n");
      },
    },
    {
      name: "calendar_create_event",
      description: "创建新的日历日程。",
      parameters: {
        title: { type: "string", required: true, description: "日程标题" },
        start_time: { type: "string", required: true, description: "开始时间，ISO 8601，如 2026-08-20T14:00:00+08:00" },
        end_time: { type: "string", required: true, description: "结束时间，ISO 8601" },
        calendar: { type: "string", description: "日历名：home / work / personal，默认 home" },
        description: { type: "string", description: "日程描述或备注" },
        location: { type: "string", description: "日程地点" },
      },
      output: {
        schema: { type: "string" },
        render(args, value) { return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }]; },
      },
      async execute(args) {
        const c = await client();
        const calendarPath = await c.getCalendarPath(args.calendar || "home");
        const uid = await c.createEvent(calendarPath, {
          title: args.title,
          startTime: new Date(args.start_time),
          endTime: new Date(args.end_time),
          description: args.description,
          location: args.location,
        });
        return `事件创建成功 ✅\n标题: ${args.title}\nUID: ${uid}\n时间: ${args.start_time} → ${args.end_time}${args.location ? `\n地点: ${args.location}` : ""}`;
      },
    },
    {
      name: "calendar_update_event",
      description: "按 UID 修改已有日程。只更新提供的字段，未提供的保持不变。",
      parameters: {
        uid: { type: "string", required: true, description: "要修改的事件 UID" },
        title: { type: "string", description: "新标题" },
        start_time: { type: "string", description: "新开始时间，ISO 8601" },
        end_time: { type: "string", description: "新结束时间，ISO 8601" },
        description: { type: "string", description: "新描述" },
        location: { type: "string", description: "新地点" },
        calendar: { type: "string", description: "日历名：home / work / personal" },
      },
      output: {
        schema: { type: "string" },
        render(args, value) { return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }]; },
      },
      async execute(args) {
        const c = await client();
        const calendarPath = await c.getCalendarPath(args.calendar || "home");
        const updateParams = {};
        if (args.title !== undefined) updateParams.title = args.title;
        if (args.start_time !== undefined) updateParams.startTime = new Date(args.start_time);
        if (args.end_time !== undefined) updateParams.endTime = new Date(args.end_time);
        if (args.description !== undefined) updateParams.description = args.description;
        if (args.location !== undefined) updateParams.location = args.location;
        const result = await c.updateEvent(calendarPath, args.uid, updateParams);
        return `事件更新成功 ✅\n标题: ${result.summary}\nUID: ${result.uid}`;
      },
    },
    {
      name: "calendar_delete_event",
      description: "按 UID 删除日程。",
      parameters: {
        uid: { type: "string", required: true, description: "要删除的事件 UID" },
        calendar: { type: "string", description: "日历名：home / work / personal" },
      },
      output: {
        schema: { type: "string" },
        render(args, value) { return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }]; },
      },
      async execute(args) {
        const c = await client();
        const calendarPath = await c.getCalendarPath(args.calendar || "home");
        await c.deleteEvent(calendarPath, args.uid);
        return `事件已删除 ✅ (UID: ${args.uid})`;
      },
    },
    {
      name: "todo_list",
      description: "列出日历待办任务，可按状态过滤；不传 calendar 时列出所有日历的任务。",
      parameters: {
        calendar: { type: "string", description: "日历名，默认 inbox（home_todo）" },
        status: { type: "string", description: "按状态过滤：NEEDS-ACTION / COMPLETED / IN-PROCESS / CANCELLED" },
      },
      output: {
        schema: { type: "string" },
        render(args, value) { return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }]; },
      },
      async execute(args) {
        const c = await client();
        const filterStatus = args.status?.toUpperCase();
        if (!args.calendar) {
          const calendars = await c.getAllCalendars();
          if (calendars.length === 0) return "未发现任何日历。";
          const groups = [];
          let total = 0;
          for (const cal of calendars) {
            const todos = await c.queryTodos(cal.path);
            const filtered = filterStatus ? todos.filter((t) => t.status === filterStatus) : todos;
            if (filtered.length === 0) continue;
            total += filtered.length;
            groups.push(`【${cal.name}】`);
            for (const t of filtered) {
              const statusIcon = t.status === "COMPLETED" ? "✅" : t.status === "IN-PROCESS" ? "🔄" : "📋";
              const due = t.due ? ` 截止: ${t.due}` : "";
              const done = t.completed ? ` 完成: ${fmtIcalDate(t.completed)}` : "";
              groups.push(`${statusIcon} ${t.summary} [${t.status}]${due}${done}  UID: ${t.uid}`);
            }
            groups.push("");
          }
          if (total === 0) return filterStatus ? `没有 ${filterStatus} 状态的任务。` : "没有任务。";
          return [`找到 ${total} 个任务（全部日历）：`, "", ...groups].join("\n");
        }
        const calPath = await c.getCalendarPath(args.calendar);
        if (!calPath) return "日历未发现: " + args.calendar;
        const todos = await c.queryTodos(calPath);
        if (filterStatus) {
          const filtered = todos.filter((t) => t.status === filterStatus);
          if (filtered.length === 0) return `没有 ${filterStatus} 状态的任务。`;
          const lines = [`找到 ${filtered.length} 个任务（${filterStatus}）：`, ""];
          for (const t of filtered) {
            const due = t.due ? ` 截止: ${t.due}` : "";
            const pct = t.percentComplete !== undefined ? ` 进度: ${t.percentComplete}%` : "";
            const done = t.completed ? ` 完成: ${fmtIcalDate(t.completed)}` : "";
            lines.push(`- ${t.summary}${due}${pct}${done}  UID: ${t.uid}`);
          }
          return lines.join("\n");
        }
        if (todos.length === 0) return "没有任务。";
        const lines = [`找到 ${todos.length} 个任务：`, ""];
        for (const t of todos) {
          const statusIcon = t.status === "COMPLETED" ? "✅" : t.status === "IN-PROCESS" ? "🔄" : "📋";
          const due = t.due ? ` 截止: ${t.due}` : "";
          const done = t.completed ? ` 完成: ${fmtIcalDate(t.completed)}` : "";
          lines.push(`${statusIcon} ${t.summary} [${t.status}]${due}${done}  UID: ${t.uid}`);
        }
        return lines.join("\n");
      },
    },
    {
      name: "todo_create",
      description: "创建新的待办任务。",
      parameters: {
        summary: { type: "string", required: true, description: "任务标题" },
        description: { type: "string", description: "任务描述" },
        due: { type: "string", description: "截止日期（ISO 8601）" },
        calendar: { type: "string", description: "日历名，默认 inbox（home_todo）" },
      },
      output: {
        schema: { type: "string" },
        render(args, value) { return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }]; },
      },
      async execute(args) {
        const c = await client();
        const calPath = await c.getCalendarPath(args.calendar || "inbox");
        if (!calPath) return "日历未发现: " + (args.calendar || "inbox");
        const uid = await c.createTodo(calPath, {
          summary: args.summary,
          description: args.description,
          due: args.due ? new Date(args.due) : undefined,
        });
        return `任务创建成功 ✅\n标题: ${args.summary}\nUID: ${uid}`;
      },
    },
    {
      name: "todo_update",
      description: "按 UID 修改待办任务。只更新提供的字段，未提供的保持不变。",
      parameters: {
        uid: { type: "string", required: true, description: "任务 UID" },
        summary: { type: "string", description: "新任务标题" },
        description: { type: "string", description: "新任务描述" },
        due: { type: "string", description: "新截止日期（ISO 8601）" },
        calendar: { type: "string", description: "日历名，默认 inbox（home_todo）" },
      },
      output: {
        schema: { type: "string" },
        render(args, value) { return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }]; },
      },
      async execute(args) {
        const c = await client();
        const calPath = await c.getCalendarPath(args.calendar || "inbox");
        if (!calPath) return "日历未发现: " + (args.calendar || "inbox");
        const updateParams = {};
        if (args.summary !== undefined) updateParams.summary = args.summary;
        if (args.description !== undefined) updateParams.description = args.description;
        if (args.due !== undefined) updateParams.due = new Date(args.due);
        const result = await c.updateTodo(calPath, args.uid, updateParams);
        let out = `任务更新成功 ✅\n标题: ${result.summary}\nUID: ${result.uid}`;
        if (result.due) out += `\n截止: ${result.due}`;
        return out;
      },
    },
    {
      name: "todo_complete",
      description: "将待办任务标记为完成。",
      parameters: {
        uid: { type: "string", required: true, description: "任务 UID" },
        calendar: { type: "string", description: "日历名，默认 inbox（home_todo）" },
      },
      output: {
        schema: { type: "string" },
        render(args, value) { return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }]; },
      },
      async execute(args) {
        const c = await client();
        const calPath = await c.getCalendarPath(args.calendar || "inbox");
        if (!calPath) return "日历未发现: " + (args.calendar || "inbox");
        await c.completeTodo(calPath, args.uid);
        return `任务已完成 ✅ (UID: ${args.uid})`;
      },
    },
    {
      name: "todo_delete",
      description: "删除待办任务。",
      parameters: {
        uid: { type: "string", required: true, description: "任务 UID" },
        calendar: { type: "string", description: "日历名，默认 inbox（home_todo）" },
      },
      output: {
        schema: { type: "string" },
        render(args, value) { return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }]; },
      },
      async execute(args) {
        const c = await client();
        const calPath = await c.getCalendarPath(args.calendar || "inbox");
        if (!calPath) return "日历未发现: " + (args.calendar || "inbox");
        await c.deleteTodo(calPath, args.uid);
        return `任务已删除 ✅ (UID: ${args.uid})`;
      },
    },
  ];

  for (const tool of tools) ctx.tools.register(defineTool(tool));
  log.info(`已注册 ${tools.length} 个日历工具（Synology Calendar / CalDAV）`);
  log.info(`日历插件已加载，url=${cfg().url || "(未配置)"} username=${cfg().username || "(未配置)"}`);
}
