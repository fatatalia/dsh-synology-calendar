# dsh-synology-calendar — 群晖日历插件

Synology Calendar（CalDAV）接入 dsh：`calendar_*` / `todo_*` 共 9 个工具（查询、创建、更新、删除日程与待办），随 dsh web 启停，零 dsh 框架改动。

## 功能

- **CalDAV 客户端**（`lib/caldav.mjs`）：PROPFIND / REPORT / PUT / DELETE / GET + iCal 解析/构建，零框架依赖（仅全局 `fetch` / `crypto` / `Buffer`）
- **工具**：`calendar_query_events` / `calendar_create_event` / `calendar_update_event` / `calendar_delete_event` / `todo_list` / `todo_create` / `todo_update` / `todo_complete` / `todo_delete`
- **配置页**：web UI Settings → 群晖日历（CalDAV URL / 用户名 / 密码 / 日历表）
- **凭据安全**：密码存 dsh credentials（`.credentials.yaml`，0600），不落 settings

## 目录

```
dsh-synology-calendar/
├── index.js              # host 插件：CalDAV 工具 + Typert remote（配置/密码读写）
├── client.js             # 浏览器 bundle：Settings → 群晖日历 配置页
├── lib/caldav.mjs        # CalDAV HTTP 客户端 + iCal 解析/构建
├── cordis.patch.yml      # bundle patch（插入 host 插件行）
└── package.json
```

挂载：web profile（`~/.dsh/profiles/web/`）`package.json` → `dependencies["dsh-synology-calendar"] = "link:<project>/dsh-synology-calendar"`，bundles 列表含 `dsh-synology-calendar`。

## 配置

`$DSH_HOME/settings.yaml` 的 `calendar:` 段（可在配置页编辑）：

```yaml
calendar:
  url: "https://<synology-host>/caldav.php/"
  username: "user@example.com"
  calendars: {}    # 日历别名表，可选
```

密码经配置页保存到 dsh credentials（ref: `CALDAV_PASSWORD`）。

## 开发要点

- 新插件项目必须建依赖软链（否则 import `@deepseek-ai/*` 报 ERR_MODULE_NOT_FOUND）：
  ```sh
  mkdir -p node_modules && ln -sfn /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai node_modules/@deepseek-ai
  ```
- 改代码后重启 web 生效（web profile 的 HMR 已禁用）
