# 开发备忘

## 项目概述

B站动态分组筛选助手，油猴脚本（Tampermonkey UserScript），通过拦截 B 站动态 API 实现按关注分组过滤动态。

## 关键架构决策

### fetch 拦截器内必须同步补齐数据

B 站动态页的无限滚动加载依赖 API 返回的 `offset` 和 `items` 来决定是否继续加载。**绝对不能返回空 `items` 给前端**，否则前端会认为数据已加载完毕，停止触发后续请求。

正确做法：当过滤后 `items` 为空时，在拦截器内部用 `_fetch`（原始 fetch）循环拉取后续页面，攒够数据后再一次性返回。

错误做法（已踩坑）：
- 返回空 `items` + 用 `scrollTo` 滚到底部试图触发加载 → B 站前端不会响应
- 返回空 `items` + `setTimeout` 异步调用 fetch → 数据返回给调用者而非 B 站前端，无法注入动态流

### B 站动态 API 分页机制

- 接口路径：`/x/polymer/web-dynamic/v1/feed/all`
- 分页方式：基于 `offset` 字段（非页码），每次请求返回下一页的 `offset`
- `has_more`：布尔值，表示是否还有更多数据
- 返回给前端的 response 必须保持 `offset`、`has_more`、`items` 三者一致

## 注意事项

- 文件是 JavaScript，扩展名必须为 `.js`，不要用 `.java`
- `_fetch` 是保存的原始 `unsafeWindow.fetch` 引用，用它发请求可以绕过拦截器
- `GM_xmlhttpRequest` 用于跨域请求（如获取分组成员），普通页面内 API 用 `_fetch`
- 循环拉取需要设置上限（`MAX_EMPTY_PAGES`），防止无限循环
