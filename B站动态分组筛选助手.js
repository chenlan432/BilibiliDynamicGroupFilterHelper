// ==UserScript==
// @name         B站动态分组筛选助手
// @namespace    https://github.com/chenlan432/BilibiliDynamicGroupFilterHelper
// @version      18.0.0
// @description  在 B 站动态页面按关注分组筛选动态，支持多分组、搜索、安全缓存与自动补页
// @author       chenlan432
// @license      MIT
// @homepageURL  https://github.com/chenlan432/BilibiliDynamicGroupFilterHelper
// @supportURL   https://github.com/chenlan432/BilibiliDynamicGroupFilterHelper/issues
// @updateURL    https://raw.githubusercontent.com/chenlan432/BilibiliDynamicGroupFilterHelper/main/B%E7%AB%99%E5%8A%A8%E6%80%81%E5%88%86%E7%BB%84%E7%AD%9B%E9%80%89%E5%8A%A9%E6%89%8B.js
// @downloadURL  https://raw.githubusercontent.com/chenlan432/BilibiliDynamicGroupFilterHelper/main/B%E7%AB%99%E5%8A%A8%E6%80%81%E5%88%86%E7%BB%84%E7%AD%9B%E9%80%89%E5%8A%A9%E6%89%8B.js
// @match        https://t.bilibili.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        unsafeWindow
// @connect      api.bilibili.com
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    const pageWindow = typeof unsafeWindow !== 'undefined' && unsafeWindow
        ? unsafeWindow
        : window;

    const CONFIG = Object.freeze({
        CACHE_SCHEMA: 2,
        CACHE_TTL_MS: 60 * 60 * 1000,
        MEMBER_PAGE_SIZE: 50,
        MAX_MEMBER_PAGES: 100,
        API_REQUEST_INTERVAL_MS: 250,
        API_RETRY_COUNT: 2,
        API_RETRY_BASE_DELAY_MS: 700,
        API_TIMEOUT_MS: 10000,
        INITIAL_MEMBER_WAIT_MS: 2000,
        DYNAMIC_SCAN_MAX_PAGES: 10,
        DYNAMIC_SCAN_MAX_MS: 6000,
        DYNAMIC_SCAN_DELAY_MS: 350,
        DYNAMIC_API_PATH: '/x/polymer/web-dynamic/v1/feed/all',
        MEMBER_API: 'https://api.bilibili.com/x/relation/tag',
        GROUPS_API: 'https://api.bilibili.com/x/relation/tags'
    });

    const STORAGE = Object.freeze({
        SELECTION: 'gf_selection_v2',
        CACHE_PREFIX: 'gf_member_v2_',
        LEGACY_IDS: 'currentGroupIds',
        LEGACY_NAMES: 'currentGroupNames',
        LEGACY_ID: 'currentGroupId',
        LEGACY_NAME: 'currentGroupName'
    });

    // ========== 可独立测试的纯函数 ==========

    function normalizeId(value) {
        if (value === null || value === undefined) return '';
        return String(value);
    }

    function normalizeSelection(stored, legacy = {}) {
        const ids = new Set();
        const names = new Map();

        const add = (rawId, rawName) => {
            const id = normalizeId(rawId);
            if (!id) return;
            ids.add(id);
            if (typeof rawName === 'string' && rawName) names.set(id, rawName);
        };

        if (stored && stored.version === 2 && Array.isArray(stored.groups)) {
            stored.groups.forEach(group => add(group?.id, group?.name));
        } else {
            const hasLegacyId = legacy.id !== null
                && legacy.id !== undefined
                && legacy.id !== '';
            const legacyIds = Array.isArray(legacy.ids)
                ? legacy.ids
                : (hasLegacyId ? [legacy.id] : []);
            const legacyNames = legacy.names && typeof legacy.names === 'object'
                ? legacy.names
                : {};

            legacyIds.forEach(id => {
                const key = normalizeId(id);
                add(id, legacyNames[key] || (legacyIds.length === 1 ? legacy.name : ''));
            });
        }

        return {
            ids: Array.from(ids),
            names: Object.fromEntries(names)
        };
    }

    function mergeMemberLists(lists) {
        const merged = new Set();
        lists.forEach(list => {
            if (!Array.isArray(list)) return;
            list.forEach(mid => {
                const normalized = normalizeId(mid);
                if (normalized) merged.add(normalized);
            });
        });
        return merged;
    }

    function extractDynamicMid(item) {
        return normalizeId(item?.modules?.module_author?.mid);
    }

    function filterDynamicItems(items, memberSet) {
        if (!Array.isArray(items) || !memberSet || typeof memberSet.has !== 'function') {
            return [];
        }
        return items.filter(item => {
            const mid = extractDynamicMid(item);
            return mid && memberSet.has(mid);
        });
    }

    function parseMemberPage(data) {
        if (!data || data.code !== 0) {
            throw new Error(`分组成员接口返回异常 code=${data?.code ?? 'unknown'}`);
        }

        const payload = data.data;
        const list = Array.isArray(payload)
            ? payload
            : (Array.isArray(payload?.list) ? payload.list : null);

        if (!list) {
            throw new Error('分组成员接口数据格式异常');
        }

        return list
            .map(user => normalizeId(user?.mid))
            .filter(Boolean);
    }

    function buildNextPageUrl(originalUrl, offset, baseUrl = 'https://t.bilibili.com/') {
        const url = new URL(originalUrl, baseUrl);
        if (offset === null || offset === undefined || offset === '') {
            url.searchParams.delete('offset');
        } else {
            url.searchParams.set('offset', String(offset));
        }
        url.searchParams.delete('update_baseline');
        return url.toString();
    }

    function isDynamicFeedUrl(url, baseUrl = 'https://t.bilibili.com/') {
        if (!url) return false;
        try {
            const resolved = new URL(url, baseUrl);
            const hostname = resolved.hostname.toLowerCase();
            return (
                hostname === 'bilibili.com'
                || hostname.endsWith('.bilibili.com')
            )
                && resolved.pathname === CONFIG.DYNAMIC_API_PATH;
        } catch {
            return false;
        }
    }

    function classifyHttpStatus(status) {
        const code = Number(status);
        if (code === 401 || code === 403) {
            return { kind: 'auth', retryable: false };
        }
        if (code === 412) {
            return { kind: 'risk', retryable: false };
        }
        if (code === 429) {
            return { kind: 'rate-limit', retryable: false };
        }
        if (code === 408 || code === 425 || code >= 500) {
            return { kind: 'transient', retryable: true };
        }
        return { kind: 'http', retryable: false };
    }

    function classifyApiCode(code) {
        const value = Number(code);
        if (value === -101 || value === -111) {
            return { kind: 'auth', retryable: false };
        }
        if (value === -352 || value === -412) {
            return { kind: 'risk', retryable: false };
        }
        if (value === -509) {
            return { kind: 'rate-limit', retryable: false };
        }
        return { kind: 'api', retryable: false };
    }

    function setsEqual(left, right) {
        if (left.size !== right.size) return false;
        for (const value of left) {
            if (!right.has(value)) return false;
        }
        return true;
    }

    // 测试钩子只用于 Node 单元测试；正常浏览器环境不会设置这个对象。
    if (pageWindow.__GF_TEST_HOOK__) {
        pageWindow.__GF_TEST_HOOK__({
            CONFIG,
            normalizeSelection,
            mergeMemberLists,
            extractDynamicMid,
            filterDynamicItems,
            parseMemberPage,
            buildNextPageUrl,
            isDynamicFeedUrl,
            classifyHttpStatus,
            classifyApiCode,
            setsEqual
        });
        return;
    }

    if (pageWindow.__GF_GROUP_FILTER_INSTALLED__) return;
    pageWindow.__GF_GROUP_FILTER_INSTALLED__ = true;

    // ========== 状态 ==========

    const State = {
        groups: [],
        selectedIds: new Set(),
        selectedNames: new Map(),
        draftIds: new Set(),
        draftNames: new Map(),
        memberSet: null,
        memberReady: false,
        memberLoading: false,
        memberNotice: null,
        initialMemberTimedOut: false,
        selectionVersion: 0,
        panelVisible: false,
        groupsLoading: false,
        groupsError: '',
        searchKeyword: '',
        filterStats: { scanned: 0, shown: 0, pages: 0 },
        filterNotice: null,
        status: { text: '', kind: 'info' },
        loadingCount: 0,
        readyPromise: null
    };

    const UI = {
        button: null,
        panel: null,
        summary: null,
        search: null,
        list: null,
        stats: null,
        status: null,
        applyButton: null,
        loading: null
    };

    let rawFetch = null;
    let apiQueueTail = Promise.resolve();
    let apiLastStartedAt = 0;

    class BiliRequestError extends Error {
        constructor(message, options = {}) {
            super(message);
            this.name = 'BiliRequestError';
            this.kind = options.kind || 'network';
            this.retryable = Boolean(options.retryable);
            this.status = options.status || 0;
            this.code = options.code ?? null;
        }
    }

    function createAbortError() {
        try {
            return new DOMException('操作已取消', 'AbortError');
        } catch {
            const error = new Error('操作已取消');
            error.name = 'AbortError';
            return error;
        }
    }

    function isAbortError(error) {
        return error?.name === 'AbortError';
    }

    function throwIfAborted(signal) {
        if (signal?.aborted) throw createAbortError();
    }

    function sleep(ms, signal) {
        if (!ms) {
            if (signal?.aborted) return Promise.reject(createAbortError());
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                cleanup();
                resolve();
            }, ms);

            const onAbort = () => {
                clearTimeout(timer);
                cleanup();
                reject(createAbortError());
            };

            const cleanup = () => {
                if (signal) signal.removeEventListener('abort', onAbort);
            };

            if (signal?.aborted) {
                onAbort();
                return;
            }
            if (signal) signal.addEventListener('abort', onAbort, { once: true });
        });
    }

    function debugLog(...args) {
        try {
            if (pageWindow.localStorage.getItem('GF_DEBUG') === '1') {
                console.log('[分组筛选]', ...args);
            }
        } catch {
            // 忽略 localStorage 被禁用的情况
        }
    }

    function storageGet(key, fallback) {
        try {
            return GM_getValue(key, fallback);
        } catch (error) {
            debugLog('读取存储失败:', key, error);
            return fallback;
        }
    }

    function storageSet(key, value) {
        try {
            GM_setValue(key, value);
            return true;
        } catch (error) {
            debugLog('写入存储失败:', key, error);
            return false;
        }
    }

    function storageDelete(key) {
        try {
            if (typeof GM_deleteValue === 'function') {
                GM_deleteValue(key);
            } else {
                GM_setValue(key, null);
            }
            return true;
        } catch (error) {
            debugLog('删除存储失败:', key, error);
            return false;
        }
    }

    function memberCacheKey(tagId) {
        return `${STORAGE.CACHE_PREFIX}${normalizeId(tagId)}`;
    }

    function readMemberCache(tagId) {
        const raw = storageGet(memberCacheKey(tagId), null);
        if (
            !raw
            || raw.schema !== CONFIG.CACHE_SCHEMA
            || raw.complete !== true
            || !Array.isArray(raw.members)
        ) {
            return null;
        }

        const fetchedAt = Number(raw.fetchedAt);
        return {
            members: raw.members.map(normalizeId).filter(Boolean),
            fresh: Number.isFinite(fetchedAt)
                && Date.now() - fetchedAt >= 0
                && Date.now() - fetchedAt < CONFIG.CACHE_TTL_MS
        };
    }

    function writeMemberCache(tagId, members) {
        storageSet(memberCacheKey(tagId), {
            schema: CONFIG.CACHE_SCHEMA,
            tagId: normalizeId(tagId),
            members: Array.from(new Set(members.map(normalizeId).filter(Boolean))),
            fetchedAt: Date.now(),
            complete: true
        });
    }

    function loadStoredSelection() {
        const stored = storageGet(STORAGE.SELECTION, null);
        const legacy = {
            ids: storageGet(STORAGE.LEGACY_IDS, null),
            names: storageGet(STORAGE.LEGACY_NAMES, null),
            id: storageGet(STORAGE.LEGACY_ID, null),
            name: storageGet(STORAGE.LEGACY_NAME, '')
        };
        return normalizeSelection(stored, legacy);
    }

    function applyLoadedSelection(selection) {
        State.selectedIds = new Set(selection.ids);
        State.selectedNames = new Map(Object.entries(selection.names));
        State.draftIds = new Set(State.selectedIds);
        State.draftNames = new Map(State.selectedNames);
    }

    function persistSelection(ids, names) {
        return storageSet(STORAGE.SELECTION, {
            version: 2,
            groups: Array.from(ids).map(id => ({
                id,
                name: names.get(id) || ''
            }))
        });
    }

    function scheduleApiTask(task, signal) {
        const run = apiQueueTail.then(async () => {
            throwIfAborted(signal);
            const waitMs = Math.max(
                0,
                CONFIG.API_REQUEST_INTERVAL_MS - (Date.now() - apiLastStartedAt)
            );
            if (waitMs) await sleep(waitMs, signal);
            throwIfAborted(signal);
            apiLastStartedAt = Date.now();
            return task();
        });

        apiQueueTail = run.catch(() => undefined);
        return run;
    }

    function gmRequestOnce(url) {
        return new Promise((resolve, reject) => {
            let settled = false;

            const settle = (callback, value) => {
                if (settled) return;
                settled = true;
                callback(value);
            };

            try {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url,
                    withCredentials: true,
                    timeout: CONFIG.API_TIMEOUT_MS,
                    onload: response => {
                        const status = Number(response.status) || 0;
                        if (status < 200 || status >= 300) {
                            const httpInfo = classifyHttpStatus(status);
                            settle(reject, new BiliRequestError(
                                `HTTP ${status || 'unknown'}`,
                                {
                                    kind: status ? httpInfo.kind : 'network',
                                    retryable: status ? httpInfo.retryable : true,
                                    status
                                }
                            ));
                            return;
                        }

                        let data;
                        try {
                            data = JSON.parse(response.responseText);
                        } catch {
                            settle(reject, new BiliRequestError('接口返回内容不是 JSON', {
                                kind: 'parse',
                                retryable: false,
                                status
                            }));
                            return;
                        }
                        settle(resolve, { data, status });
                    },
                    onerror: () => {
                        settle(reject, new BiliRequestError('网络请求失败', {
                            kind: 'network',
                            retryable: true
                        }));
                    },
                    ontimeout: () => {
                        settle(reject, new BiliRequestError('请求超时', {
                            kind: 'timeout',
                            retryable: true
                        }));
                    },
                    onabort: () => {
                        settle(reject, createAbortError());
                    }
                });
            } catch (error) {
                settle(reject, error);
            }
        });
    }

    async function requestJson(url, options = {}) {
        const retries = options.retries ?? CONFIG.API_RETRY_COUNT;

        for (let attempt = 0; ; attempt += 1) {
            try {
                return await scheduleApiTask(() => gmRequestOnce(url));
            } catch (error) {
                if (
                    attempt >= retries
                    || !error.retryable
                ) {
                    throw error;
                }

                const delay = CONFIG.API_RETRY_BASE_DELAY_MS * (2 ** attempt);
                debugLog(`请求重试 ${attempt + 1}/${retries}:`, url, delay);
                await sleep(delay);
            }
        }
    }

    function createApiCodeError(data, label) {
        const code = Number(data?.code);
        const info = classifyApiCode(code);
        return new BiliRequestError(
            `${label}失败，code=${Number.isFinite(code) ? code : 'unknown'}`,
            {
                kind: info.kind,
                retryable: info.retryable,
                code
            }
        );
    }

    async function fetchMembersFromApi(tagId) {
        const members = [];
        let page = 1;

        while (page <= CONFIG.MAX_MEMBER_PAGES) {
            const url = new URL(CONFIG.MEMBER_API);
            url.searchParams.set('tagid', normalizeId(tagId));
            url.searchParams.set('pn', String(page));
            url.searchParams.set('ps', String(CONFIG.MEMBER_PAGE_SIZE));

            const { data } = await requestJson(url.toString(), { retries: 1 });
            if (!data || data.code !== 0) {
                throw createApiCodeError(data, '获取分组成员');
            }

            const pageMembers = parseMemberPage(data);
            members.push(...pageMembers);

            if (pageMembers.length < CONFIG.MEMBER_PAGE_SIZE) {
                return Array.from(new Set(members));
            }
            page += 1;
        }

        throw new BiliRequestError('分组成员页数超过安全上限', {
            kind: 'incomplete',
            retryable: false
        });
    }

    async function getGroupMembers(tagId) {
        const cached = readMemberCache(tagId);

        if (cached?.fresh) {
            return {
                ok: true,
                source: 'cache',
                members: cached.members,
                error: null
            };
        }

        try {
            const members = await fetchMembersFromApi(tagId);
            writeMemberCache(tagId, members);
            return {
                ok: true,
                source: 'network',
                members,
                error: null
            };
        } catch (error) {
            return {
                ok: false,
                source: cached ? 'stale' : 'none',
                members: cached?.members || [],
                error
            };
        }
    }

    function getErrorSummary(error) {
        if (!error) return '未知错误';
        if (error.kind === 'auth') {
            return 'B 站登录状态已失效或权限不足，请重新登录后重试。';
        }
        if (error.kind === 'risk' || error.kind === 'rate-limit') {
            return 'B 站请求受限，请稍后再试。';
        }
        if (error.kind === 'timeout') return '请求超时，请检查网络后重试。';
        if (error.kind === 'network') return '网络连接失败，请检查网络后重试。';
        if (error.kind === 'incomplete') return '成员数据未完整拉取，本次未更新缓存。';
        return error.message || '请求失败';
    }

    function hydrateMembersFromCache(ids) {
        const caches = ids.map(readMemberCache);
        const allCached = caches.every(Boolean);
        const hasStale = caches.some(cache => cache && !cache.fresh);

        if (allCached) {
            State.memberSet = mergeMemberLists(caches.map(cache => cache.members));
            State.memberReady = true;
            State.memberNotice = hasStale
                ? { text: '正在后台更新分组成员，当前先使用本地缓存。', kind: 'info' }
                : null;
        }

        return { allCached };
    }

    async function refreshSelectedMembers(ids, version) {
        const results = [];
        const fatalKinds = ['auth', 'risk', 'rate-limit'];
        State.memberLoading = !State.memberReady;
        updateUI();

        try {
            for (const id of ids) {
                if (version !== State.selectionVersion) return;
                const result = await getGroupMembers(id);
                results.push(result);
                const globalNetworkFailure = result.source === 'none'
                    && ['timeout', 'network'].includes(result.error?.kind);
                if (
                    !result.ok
                    && (fatalKinds.includes(result.error?.kind) || globalNetworkFailure)
                ) {
                    break;
                }
            }

            if (version !== State.selectionVersion) return;

            const everyGroupUsable = results.length > 0
                && results.every(result => result.source !== 'none');
            const errors = results.filter(result => result.error);

            if (everyGroupUsable) {
                State.memberSet = mergeMemberLists(results.map(result => result.members));
                State.memberReady = true;

                if (errors.length) {
                    State.memberNotice = {
                        text: '部分分组成员更新失败，当前暂用本地缓存。',
                        kind: 'warning'
                    };
                } else if (State.memberSet.size === 0) {
                    State.memberNotice = {
                        text: '所选分组中没有成员。',
                        kind: 'warning'
                    };
                } else {
                    State.memberNotice = null;
                }
            } else {
                State.memberReady = false;
                State.memberNotice = {
                    text: `分组成员加载失败，筛选暂未启用。${getErrorSummary(errors[0]?.error)}`,
                    kind: 'error'
                };
            }

            if (State.memberNotice) {
                setStatus(State.memberNotice.text, State.memberNotice.kind);
            } else if (State.initialMemberTimedOut) {
                State.memberNotice = {
                    text: '分组成员已就绪，请点击“刷新动态”应用筛选。',
                    kind: 'info'
                };
                setStatus(State.memberNotice.text, State.memberNotice.kind);
            } else if (State.selectedIds.size) {
                setStatus('分组成员已就绪。', 'success');
            }
        } finally {
            State.memberLoading = false;
            updateUI();
        }
    }

    async function initialize() {
        const selection = loadStoredSelection();
        applyLoadedSelection(selection);
        State.selectionVersion += 1;
        const version = State.selectionVersion;

        if (State.selectedIds.size === 0) {
            State.memberSet = new Set();
            State.memberReady = true;
            return;
        }

        const ids = Array.from(State.selectedIds);
        const cacheState = hydrateMembersFromCache(ids);
        let refreshFinished = false;
        const refresh = refreshSelectedMembers(ids, version)
            .catch(error => {
                State.memberReady = false;
                State.memberNotice = {
                    text: `分组成员加载失败。${getErrorSummary(error)}`,
                    kind: 'error'
                };
                setStatus(State.memberNotice.text, State.memberNotice.kind);
                updateUI();
            })
            .finally(() => {
                refreshFinished = true;
            });
        if (!cacheState.allCached) {
            setStatus('正在同步分组成员…', 'info');
            await Promise.race([
                refresh,
                sleep(CONFIG.INITIAL_MEMBER_WAIT_MS)
            ]);
            if (!State.memberReady && !refreshFinished) {
                State.initialMemberTimedOut = true;
                setStatus(
                    '分组成员仍在后台加载，首次动态可能暂时显示为未筛选。',
                    'warning'
                );
            }
        }
    }

    function getRequestUrl(input) {
        if (typeof input === 'string') return input;
        if (input && typeof input.url === 'string') return input.url;
        try {
            return String(input || '');
        } catch {
            return '';
        }
    }

    function getRequestSignal(input, init) {
        if (init?.signal) return init.signal;
        if (input && typeof input === 'object' && input.signal) return input.signal;
        return undefined;
    }

    function createJsonResponse(data, originalResponse) {
        const ResponseCtor = pageWindow.Response || Response;
        const contentType = originalResponse.headers.get('content-type') || 'application/json';
        const response = new ResponseCtor(JSON.stringify(data), {
            status: originalResponse.status,
            statusText: originalResponse.statusText,
            headers: { 'content-type': contentType }
        });

        try {
            Object.defineProperty(response, 'url', { value: originalResponse.url });
        } catch {
            // Response.url 是只读属性时忽略
        }
        return response;
    }

    function addFilteredItems(target, sourceItems, memberSet, seenIds, stats) {
        stats.scanned += Array.isArray(sourceItems) ? sourceItems.length : 0;
        const matched = filterDynamicItems(sourceItems, memberSet);

        matched.forEach(item => {
            const itemId = normalizeId(item?.id_str || item?.id);
            if (itemId && seenIds.has(itemId)) return;
            if (itemId) seenIds.add(itemId);
            target.push(item);
            stats.shown += 1;
        });
    }

    async function fetchDynamicPageJson(url, signal, deadline) {
        return scheduleApiTask(async () => {
            if (Date.now() >= deadline) {
                throw new BiliRequestError('自动补页时间预算已用完', {
                    kind: 'timeout',
                    retryable: false
                });
            }
            const ControllerCtor = pageWindow.AbortController || AbortController;
            const controller = new ControllerCtor();
            const timer = setTimeout(
                () => controller.abort(),
                Math.max(1, Math.min(
                    CONFIG.API_TIMEOUT_MS,
                    deadline - Date.now()
                ))
            );
            const onAbort = () => controller.abort(signal?.reason);
            if (signal) {
                if (signal.aborted) controller.abort(signal.reason);
                else signal.addEventListener('abort', onAbort, { once: true });
            }

            try {
                throwIfAborted(controller.signal);
                const response = await rawFetch.call(pageWindow, url, {
                    credentials: 'include',
                    signal: controller.signal
                });

                if (!response.ok) {
                    const info = classifyHttpStatus(response.status);
                    throw new BiliRequestError(`HTTP ${response.status}`, {
                        kind: info.kind,
                        retryable: info.retryable,
                        status: response.status
                    });
                }

                const data = await response.json();
                if (!data || data.code !== 0) {
                    throw createApiCodeError(data, '加载后续动态');
                }
                return data;
            } catch (error) {
                if (
                    isAbortError(error)
                    && !signal?.aborted
                    && controller.signal.aborted
                ) {
                    throw new BiliRequestError('请求超时', {
                        kind: 'timeout',
                        retryable: true
                    });
                }
                throw error;
            } finally {
                clearTimeout(timer);
                if (signal) signal.removeEventListener('abort', onAbort);
            }
        }, signal);
    }

    async function buildFilteredDynamicData(data, requestUrl, signal) {
        const payload = data.data;
        const memberSet = State.memberSet;
        if (!payload || !memberSet?.size) return null;

        const collected = [];
        const seenIds = new Set();
        const stats = { scanned: 0, shown: 0, pages: 1 };
        addFilteredItems(collected, payload.items, memberSet, seenIds, stats);

        let hasMore = Boolean(payload.has_more);
        let offset = payload.offset ?? '';
        let extraPages = 0;
        let loadingStarted = false;
        const startedAt = Date.now();
        const deadline = startedAt + CONFIG.DYNAMIC_SCAN_MAX_MS;
        const seenOffsets = new Set();

        try {
            while (
                collected.length === 0
                && hasMore
                && extraPages < CONFIG.DYNAMIC_SCAN_MAX_PAGES
                && Date.now() + CONFIG.DYNAMIC_SCAN_DELAY_MS < deadline
                && offset !== null
                && offset !== undefined
                && offset !== ''
            ) {
                const offsetKey = String(offset);
                if (seenOffsets.has(offsetKey)) break;
                seenOffsets.add(offsetKey);

                if (!loadingStarted) {
                    beginLoading('正在继续查找所选分组的动态…');
                    loadingStarted = true;
                }

                await sleep(CONFIG.DYNAMIC_SCAN_DELAY_MS, signal);
                const nextUrl = buildNextPageUrl(
                    requestUrl,
                    offset,
                    pageWindow.location.href
                );
                const pageData = await fetchDynamicPageJson(nextUrl, signal, deadline);
                const pagePayload = pageData.data || {};
                const pageItems = Array.isArray(pagePayload.items)
                    ? pagePayload.items
                    : [];

                addFilteredItems(collected, pageItems, memberSet, seenIds, stats);
                extraPages += 1;
                stats.pages += 1;

                const previousOffset = offset;
                offset = pagePayload.offset ?? '';
                hasMore = Boolean(pagePayload.has_more);

                if (hasMore && String(offset ?? '') === String(previousOffset ?? '')) {
                    break;
                }
            }
        } finally {
            if (loadingStarted) endLoading();
        }

        const budgetExhausted = collected.length === 0 && hasMore;

        payload.items = collected;
        payload.offset = offset;
        payload.has_more = hasMore;

        State.filterStats.scanned += stats.scanned;
        State.filterStats.shown += stats.shown;
        State.filterStats.pages += stats.pages;
        return { data, extraPages, budgetExhausted };
    }

    async function processDynamicResponse(response, requestUrl, signal) {
        const data = await response.clone().json();
        if (!data || data.code !== 0 || !data.data) return response;

        const result = await buildFilteredDynamicData(data, requestUrl, signal);
        if (!result) return response;

        if (result.budgetExhausted) {
            State.filterNotice = {
                text: `本次已扫描 ${result.extraPages + 1} 页，暂未找到匹配动态。为避免触发 B 站风控，已暂停继续补页。`,
                kind: 'warning'
            };
        } else if (State.filterStats.shown === 0 && !result.data.data.has_more) {
            State.filterNotice = {
                text: '没有找到与所选分组匹配的动态。',
                kind: 'info'
            };
        } else {
            State.filterNotice = null;
        }

        if (State.filterNotice) {
            setStatus(State.filterNotice.text, State.filterNotice.kind);
        } else if (State.memberNotice) {
            setStatus(State.memberNotice.text, State.memberNotice.kind);
        } else {
            setStatus('筛选已生效。', 'success');
        }
        updateUI();
        return createJsonResponse(result.data, response);
    }

    function installFetchInterceptor() {
        rawFetch = pageWindow.fetch;
        if (typeof rawFetch !== 'function') return;

        pageWindow.fetch = async function (...args) {
            const response = await rawFetch.apply(this, args);
            const requestUrl = getRequestUrl(args[0]);

            if (
                !State.selectedIds.size
                || !isDynamicFeedUrl(requestUrl, pageWindow.location.href)
            ) {
                return response;
            }

            if (State.readyPromise) await State.readyPromise;

            if (!State.memberReady || !State.memberSet?.size) {
                if (!State.memberReady) {
                    setStatus('分组成员尚未就绪，本次暂未应用筛选。', 'warning');
                }
                return response;
            }

            try {
                return await processDynamicResponse(
                    response,
                    requestUrl,
                    getRequestSignal(args[0], args[1])
                );
            } catch (error) {
                if (!isAbortError(error)) {
                    const message = `筛选处理失败，本次显示原始动态。${getErrorSummary(error)}`;
                    State.filterNotice = { text: message, kind: 'error' };
                    setStatus(message, State.filterNotice.kind);
                    debugLog('筛选处理失败:', error);
                }
                return response;
            }
        };
    }

    // ========== UI ==========

    function createElement(tagName, className, text) {
        const element = document.createElement(tagName);
        if (className) element.className = className;
        if (text) element.textContent = text;
        return element;
    }

    function setStatus(text, kind = 'info') {
        State.status = { text, kind };
        if (!UI.status) return;
        UI.status.textContent = text;
        UI.status.dataset.kind = kind;
        UI.status.hidden = !text;
    }

    function restoreNoticeStatus() {
        const priority = { info: 1, warning: 2, error: 3 };
        const notice = [State.memberNotice, State.filterNotice]
            .filter(Boolean)
            .sort((left, right) => (priority[right.kind] || 0) - (priority[left.kind] || 0))[0];
        setStatus(notice?.text || '', notice?.kind || 'info');
    }

    function beginLoading(message) {
        State.loadingCount += 1;
        if (UI.loading) {
            UI.loading.textContent = message || '正在加载…';
            UI.loading.hidden = false;
        }
    }

    function endLoading() {
        State.loadingCount = Math.max(0, State.loadingCount - 1);
        if (UI.loading) {
            UI.loading.hidden = State.loadingCount === 0;
        }
    }

    function updateButton() {
        if (!UI.button) return;

        let text = '分组筛选';
        if (State.selectedIds.size === 1) {
            const id = State.selectedIds.values().next().value;
            text = `筛选：${State.selectedNames.get(id) || '1 个分组'}`;
        } else if (State.selectedIds.size > 1) {
            text = `筛选：${State.selectedIds.size} 个分组`;
        }
        if (State.selectedIds.size && State.memberLoading) {
            text += '（同步中）';
        }

        UI.button.textContent = text;
        UI.button.classList.toggle('gf-on', State.selectedIds.size > 0);
        UI.button.setAttribute('aria-expanded', String(State.panelVisible));
        if (!State.selectedIds.size) {
            UI.button.title = '选择关注分组';
        } else if (State.memberLoading) {
            UI.button.title = '正在同步分组成员';
        } else if (!State.memberReady) {
            UI.button.title = '分组成员加载失败，打开面板查看详情';
        } else {
            UI.button.title = `当前已选择 ${State.selectedIds.size} 个分组`;
        }
    }

    function updateStats() {
        if (!UI.stats) return;

        if (State.selectedIds.size === 0) {
            UI.stats.textContent = '未启用分组筛选';
            return;
        }
        if (State.memberLoading) {
            UI.stats.textContent = '正在同步分组成员…';
            return;
        }
        if (!State.memberReady) {
            UI.stats.textContent = '分组成员加载失败，筛选暂未启用';
            return;
        }
        if (!State.memberSet?.size) {
            UI.stats.textContent = '所选分组中没有成员';
            return;
        }

        const stats = State.filterStats;
        const pages = stats.pages ? `，读取 ${stats.pages} 页` : '';
        UI.stats.textContent = `已扫描 ${stats.scanned} 条，显示 ${stats.shown} 条${pages}`;
    }

    function updateActionState() {
        if (!UI.applyButton) return;

        const changed = !setsEqual(State.draftIds, State.selectedIds);
        UI.applyButton.disabled = !changed;

        if (!changed) {
            UI.applyButton.textContent = State.selectedIds.size
                ? '当前选择已保存'
                : '应用筛选';
        } else if (State.draftIds.size === 0) {
            UI.applyButton.textContent = '取消筛选并刷新';
        } else {
            UI.applyButton.textContent = '应用筛选并刷新';
        }
    }

    function updateUI() {
        updateButton();
        updateStats();
        updateActionState();
    }

    function closePanel() {
        State.panelVisible = false;
        if (UI.panel) UI.panel.hidden = true;
        if (UI.button) {
            UI.button.hidden = false;
            UI.button.focus();
        }
        restoreNoticeStatus();
        updateButton();
    }

    function openPanel() {
        State.panelVisible = true;
        State.draftIds = new Set(State.selectedIds);
        State.draftNames = new Map(State.selectedNames);
        State.searchKeyword = '';
        if (UI.search) UI.search.value = '';

        if (UI.panel) UI.panel.hidden = false;
        if (UI.button) UI.button.hidden = true;
        renderPanel();
        updateButton();
        restoreNoticeStatus();

        if (!State.groups.length && !State.groupsLoading) loadGroups();
        setTimeout(() => UI.search?.focus(), 0);
    }

    function createGroupButton(id, name, count, searchable = true) {
        const selected = id === 'all'
            ? State.draftIds.size === 0
            : State.draftIds.has(id);
        const button = createElement('button', 'gf-group-item');
        button.type = 'button';
        button.dataset.groupId = id;
        if (searchable) button.dataset.groupName = name;
        button.classList.toggle('gf-selected', selected);
        button.setAttribute('aria-pressed', String(selected));

        const label = createElement(
            'span',
            'gf-group-name',
            id === 'all' ? '全部动态' : name
        );
        button.appendChild(label);

        if (count !== null && count !== undefined) {
            const countElement = createElement(
                'span',
                'gf-group-count',
                String(count)
            );
            button.appendChild(countElement);
        } else {
            button.appendChild(createElement('span', 'gf-group-check', '✓'));
        }

        button.setAttribute(
            'aria-label',
            id === 'all'
                ? '显示全部动态'
                : `${name}，${count ?? '未知'} 位成员`
        );
        return button;
    }

    function renderGroupList() {
        if (!UI.list) return;
        UI.list.replaceChildren();

        if (State.groupsLoading) {
            UI.list.appendChild(createElement('div', 'gf-list-message', '正在加载分组…'));
            return;
        }

        if (State.groupsError) {
            const errorBox = createElement('div', 'gf-list-message gf-error');
            errorBox.appendChild(createElement('div', '', State.groupsError));
            const retry = createElement('button', 'gf-link-button', '重试');
            retry.type = 'button';
            retry.dataset.action = 'retry-groups';
            errorBox.appendChild(retry);
            UI.list.appendChild(errorBox);
            return;
        }

        UI.list.appendChild(createGroupButton('all', '全部动态', null, false));
        State.groups.forEach(group => {
            UI.list.appendChild(createGroupButton(
                normalizeId(group.tagid),
                group.name || '未命名分组',
                group.count
            ));
        });

        applySearchFilter();
    }

    function renderPanel() {
        if (!UI.panel) return;

        UI.summary.replaceChildren();
        if (State.draftIds.size === 0) {
            UI.summary.appendChild(createElement('span', 'gf-summary-text', '全部动态'));
        } else {
            const summaryLabel = setsEqual(State.draftIds, State.selectedIds)
                ? '当前选择：'
                : '待应用：';
            UI.summary.appendChild(createElement('span', 'gf-summary-text', summaryLabel));
            State.draftIds.forEach(id => {
                UI.summary.appendChild(createElement(
                    'span',
                    'gf-current-group-tag',
                    State.draftNames.get(id) || id
                ));
            });
        }

        renderGroupList();
        updateActionState();
        updateStats();
    }

    function applySearchFilter() {
        if (!UI.list) return;
        const keyword = State.searchKeyword.trim().toLocaleLowerCase();
        const items = UI.list.querySelectorAll('.gf-group-item');
        let visibleCount = 0;

        items.forEach(item => {
            if (item.dataset.groupId === 'all') return;
            const name = (item.dataset.groupName || '').toLocaleLowerCase();
            const hidden = Boolean(keyword) && !name.includes(keyword);
            item.classList.toggle('gf-hidden', hidden);
            if (!hidden) visibleCount += 1;
        });

        const oldEmpty = UI.list.querySelector('.gf-search-empty');
        if (keyword && visibleCount === 0) {
            if (!oldEmpty) {
                UI.list.appendChild(createElement(
                    'div',
                    'gf-list-message gf-search-empty',
                    '没有匹配的分组'
                ));
            }
        } else {
            oldEmpty?.remove();
        }
    }

    function toggleDraftGroup(id) {
        if (id === 'all') {
            State.draftIds.clear();
            State.draftNames.clear();
        } else if (State.draftIds.has(id)) {
            State.draftIds.delete(id);
            State.draftNames.delete(id);
        } else {
            const group = State.groups.find(item => normalizeId(item.tagid) === id);
            State.draftIds.add(id);
            State.draftNames.set(
                id,
                group?.name || State.selectedNames.get(id) || '未命名分组'
            );
        }

        renderPanel();
        Array.from(UI.list?.querySelectorAll('.gf-group-item') || [])
            .find(button => button.dataset.groupId === id)
            ?.focus({ preventScroll: true });
        setStatus(
            setsEqual(State.draftIds, State.selectedIds)
                ? ''
                : '选择已修改，点击“应用筛选并刷新”后生效。',
            'info'
        );
    }

    async function loadGroups() {
        if (State.groupsLoading) return;
        State.groupsLoading = true;
        State.groupsError = '';
        renderGroupList();

        try {
            const { data } = await requestJson(CONFIG.GROUPS_API, { retries: 1 });
            if (!data || data.code !== 0) {
                throw createApiCodeError(data, '获取关注分组');
            }
            if (!Array.isArray(data.data)) {
                throw new BiliRequestError('关注分组接口数据格式异常', {
                    kind: 'parse',
                    retryable: false
                });
            }
            State.groups = data.data.filter(group => (
                group
                && typeof group === 'object'
                && normalizeId(group.tagid) !== ''
            ));
            restoreNoticeStatus();
        } catch (error) {
            State.groupsError = `分组加载失败：${getErrorSummary(error)}`;
            setStatus(State.groupsError, 'error');
        } finally {
            State.groupsLoading = false;
            renderPanel();
        }
    }

    function applyDraftSelection() {
        if (setsEqual(State.draftIds, State.selectedIds)) return;
        if (!persistSelection(State.draftIds, State.draftNames)) {
            setStatus('筛选选择保存失败，请检查浏览器扩展存储权限。', 'error');
            return;
        }
        pageWindow.location.reload();
    }

    function clearMemberCache() {
        const ids = new Set([
            ...State.selectedIds,
            ...State.draftIds,
            ...State.groups.map(group => normalizeId(group.tagid))
        ]);
        let allDeleted = true;
        ids.forEach(id => {
            allDeleted = storageDelete(memberCacheKey(id)) && allDeleted;
            allDeleted = storageDelete(`m_${id}`) && allDeleted;
            allDeleted = storageDelete(`t_${id}`) && allDeleted;
        });
        if (!allDeleted) {
            setStatus('部分成员缓存删除失败，请检查扩展存储权限后重试。', 'error');
            return;
        }
        State.memberSet = null;
        State.memberReady = false;
        State.memberLoading = false;
        setStatus('成员缓存已清除，正在重新加载页面…', 'info');
        pageWindow.location.reload();
    }

    function handlePanelClick(event) {
        const target = event.target;
        const groupButton = target.closest?.('[data-group-id]');
        if (groupButton) {
            toggleDraftGroup(groupButton.dataset.groupId);
            return;
        }

        const actionTarget = target.closest?.('[data-action]');
        if (!actionTarget) return;

        switch (actionTarget.dataset.action) {
            case 'close':
                closePanel();
                break;
            case 'apply':
                applyDraftSelection();
                break;
            case 'refresh':
                pageWindow.location.reload();
                break;
            case 'clear-cache':
                clearMemberCache();
                break;
            case 'retry-groups':
                loadGroups();
                break;
            default:
                break;
        }
    }

    function createUI() {
        if (document.getElementById('gf-toggle-btn')) return;

        const button = createElement('button', 'gf-toggle-btn');
        button.id = 'gf-toggle-btn';
        button.type = 'button';
        button.setAttribute('aria-controls', 'gf-panel');
        button.setAttribute('aria-haspopup', 'dialog');
        UI.button = button;
        button.addEventListener('click', openPanel);
        document.body.appendChild(button);

        const panel = createElement('section', 'gf-panel');
        panel.id = 'gf-panel';
        panel.hidden = true;
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'B 站动态分组筛选');
        panel.addEventListener('click', handlePanelClick);
        UI.panel = panel;
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && State.panelVisible) closePanel();
        });

        const header = createElement('div', 'gf-panel-title');
        header.appendChild(createElement('span', '', '动态分组筛选'));
        const closeButton = createElement('button', 'gf-close-btn', '×');
        closeButton.type = 'button';
        closeButton.dataset.action = 'close';
        closeButton.setAttribute('aria-label', '关闭面板');
        header.appendChild(closeButton);
        panel.appendChild(header);

        const summary = createElement('div', 'gf-current-group');
        UI.summary = summary;
        panel.appendChild(summary);

        const search = createElement('input', 'gf-search-box');
        search.type = 'search';
        search.placeholder = '搜索关注分组…';
        search.setAttribute('aria-label', '搜索关注分组');
        search.addEventListener('input', event => {
            State.searchKeyword = event.target.value;
            applySearchFilter();
        });
        UI.search = search;
        panel.appendChild(search);

        const list = createElement('div', 'gf-group-list');
        list.setAttribute('role', 'group');
        list.setAttribute('aria-label', '关注分组列表');
        UI.list = list;
        panel.appendChild(list);

        const stats = createElement('div', 'gf-stats');
        UI.stats = stats;
        panel.appendChild(stats);

        const status = createElement('div', 'gf-status');
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        UI.status = status;
        panel.appendChild(status);

        const actions = createElement('div', 'gf-actions');

        const applyButton = createElement('button', 'gf-action-btn gf-primary');
        applyButton.type = 'button';
        applyButton.dataset.action = 'apply';
        UI.applyButton = applyButton;
        actions.appendChild(applyButton);

        const secondaryActions = createElement('div', 'gf-secondary-actions');
        const refreshButton = createElement('button', 'gf-secondary-btn', '刷新动态');
        refreshButton.type = 'button';
        refreshButton.dataset.action = 'refresh';
        secondaryActions.appendChild(refreshButton);

        const cacheButton = createElement('button', 'gf-secondary-btn', '清除成员缓存');
        cacheButton.type = 'button';
        cacheButton.dataset.action = 'clear-cache';
        secondaryActions.appendChild(cacheButton);
        actions.appendChild(secondaryActions);
        panel.appendChild(actions);

        const tip = createElement(
            'div',
            'gf-tip',
            '可同时选择多个分组，成员取并集。为避免触发 B 站风控，自动补页设有页数和时间上限。'
        );
        panel.appendChild(tip);

        const loading = createElement('div', 'gf-loading', '正在加载…');
        loading.setAttribute('role', 'status');
        loading.setAttribute('aria-live', 'polite');
        loading.hidden = State.loadingCount === 0;
        UI.loading = loading;
        document.body.appendChild(loading);

        document.body.appendChild(panel);
        setStatus(State.status.text, State.status.kind);
        renderPanel();
        updateUI();
    }

    GM_addStyle(`
        .gf-toggle-btn,
        .gf-panel,
        .gf-loading {
            color-scheme: light dark;
            --gf-bg: #fff;
            --gf-text: #18191c;
            --gf-muted: #61666d;
            --gf-border: #e3e5e7;
            --gf-soft: #f1f2f3;
            --gf-soft-hover: #e3f6fd;
            --gf-primary: #00a1d6;
            --gf-primary-strong: #008fbd;
            --gf-danger: #d03050;
            --gf-warning: #b26a00;
            --gf-success: #16794b;
        }
        .gf-toggle-btn {
            position: fixed;
            top: 80px;
            right: 20px;
            z-index: 100000;
            box-sizing: border-box;
            padding: 10px 16px;
            max-width: min(320px, calc(100vw - 40px));
            overflow: hidden;
            border: 1px solid transparent;
            border-radius: 10px;
            background: var(--gf-primary);
            color: #fff;
            font: 600 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
            box-shadow: 0 4px 16px rgba(0, 161, 214, .28);
            cursor: pointer;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .gf-toggle-btn:hover { background: var(--gf-primary-strong); }
        .gf-toggle-btn:focus-visible,
        .gf-panel button:focus-visible,
        .gf-search-box:focus-visible {
            outline: 2px solid #fb7299;
            outline-offset: 2px;
        }
        .gf-toggle-btn.gf-on { background: #fb7299; }
        .gf-panel {
            position: fixed;
            top: 80px;
            right: 20px;
            z-index: 100001;
            width: min(340px, calc(100vw - 24px));
            max-height: calc(100vh - 104px);
            overflow: auto;
            box-sizing: border-box;
            padding: 14px;
            border: 1px solid var(--gf-border);
            border-radius: 12px;
            background: var(--gf-bg);
            color: var(--gf-text);
            box-shadow: 0 12px 36px rgba(0, 0, 0, .2);
            font: 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
        }
        .gf-panel[hidden],
        .gf-toggle-btn[hidden],
        .gf-loading[hidden],
        .gf-status[hidden] { display: none !important; }
        .gf-panel-title {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 12px;
            padding-bottom: 10px;
            border-bottom: 1px solid var(--gf-border);
            font-size: 15px;
            font-weight: 700;
        }
        .gf-close-btn {
            width: 30px;
            height: 30px;
            border: 0;
            border-radius: 7px;
            background: transparent;
            color: var(--gf-muted);
            font-size: 22px;
            line-height: 1;
            cursor: pointer;
        }
        .gf-close-btn:hover { background: var(--gf-soft); color: var(--gf-text); }
        .gf-current-group {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 5px;
            min-height: 32px;
            margin-bottom: 10px;
            padding: 7px 9px;
            border-radius: 8px;
            background: var(--gf-soft);
            font-size: 12px;
        }
        .gf-summary-text { color: var(--gf-muted); }
        .gf-current-group-tag {
            max-width: 100%;
            overflow: hidden;
            padding: 2px 7px;
            border-radius: 5px;
            background: rgba(251, 114, 153, .14);
            color: #d7466e;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .gf-search-box {
            width: 100%;
            box-sizing: border-box;
            margin-bottom: 8px;
            padding: 8px 10px;
            border: 1px solid var(--gf-border);
            border-radius: 7px;
            background: var(--gf-bg);
            color: var(--gf-text);
            font: inherit;
        }
        .gf-group-list {
            max-height: min(42vh, 360px);
            overflow-y: auto;
            padding-right: 2px;
        }
        .gf-group-item {
            display: flex;
            width: 100%;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            box-sizing: border-box;
            margin: 4px 0;
            padding: 9px 11px;
            border: 1px solid transparent;
            border-radius: 8px;
            background: var(--gf-soft);
            color: var(--gf-text);
            font: inherit;
            text-align: left;
            cursor: pointer;
        }
        .gf-group-item:hover { background: var(--gf-soft-hover); }
        .gf-group-item.gf-selected {
            border-color: var(--gf-primary);
            background: var(--gf-primary);
            color: #fff;
        }
        .gf-group-name {
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .gf-group-count {
            flex: 0 0 auto;
            color: var(--gf-muted);
            font-size: 11px;
        }
        .gf-group-item.gf-selected .gf-group-count { color: rgba(255, 255, 255, .82); }
        .gf-group-check { display: none; flex: 0 0 auto; font-weight: 700; }
        .gf-group-item[aria-pressed="true"] .gf-group-check { display: inline; }
        .gf-hidden { display: none !important; }
        .gf-list-message {
            padding: 18px 8px;
            color: var(--gf-muted);
            text-align: center;
        }
        .gf-error { color: var(--gf-danger); }
        .gf-link-button {
            margin-top: 8px;
            border: 0;
            background: transparent;
            color: var(--gf-primary);
            font: inherit;
            text-decoration: underline;
            cursor: pointer;
        }
        .gf-stats {
            margin-top: 10px;
            padding-top: 8px;
            border-top: 1px solid var(--gf-border);
            color: var(--gf-muted);
            font-size: 12px;
            text-align: center;
        }
        .gf-status {
            margin-top: 6px;
            color: var(--gf-muted);
            font-size: 12px;
            text-align: center;
        }
        .gf-status[data-kind="warning"] { color: var(--gf-warning); }
        .gf-status[data-kind="error"] { color: var(--gf-danger); }
        .gf-status[data-kind="success"] { color: var(--gf-success); }
        .gf-actions { margin-top: 10px; }
        .gf-action-btn,
        .gf-secondary-btn {
            border: 0;
            border-radius: 8px;
            font: inherit;
            cursor: pointer;
        }
        .gf-action-btn {
            width: 100%;
            padding: 10px;
            background: var(--gf-primary);
            color: #fff;
            font-weight: 700;
        }
        .gf-action-btn:hover:not(:disabled) { background: var(--gf-primary-strong); }
        .gf-action-btn:disabled { cursor: default; opacity: .5; }
        .gf-secondary-actions {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 7px;
            margin-top: 7px;
        }
        .gf-secondary-btn {
            padding: 7px;
            border: 1px solid var(--gf-border);
            background: var(--gf-bg);
            color: var(--gf-text);
            font-size: 12px;
        }
        .gf-secondary-btn:hover { background: var(--gf-soft); }
        .gf-tip {
            margin-top: 9px;
            padding: 8px;
            border-radius: 7px;
            background: var(--gf-soft);
            color: var(--gf-muted);
            font-size: 11px;
        }
        .gf-loading {
            position: fixed;
            bottom: 72px;
            left: 50%;
            z-index: 100002;
            max-width: min(360px, calc(100vw - 32px));
            padding: 9px 14px;
            border-radius: 18px;
            background: rgba(17, 18, 20, .9);
            color: #fff;
            font: 12px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
            transform: translateX(-50%);
        }
        html[data-theme="dark"] .gf-toggle-btn,
        html[data-theme="dark"] .gf-panel,
        html[data-theme="dark"] .gf-loading,
        html.dark .gf-toggle-btn,
        html.dark .gf-panel,
        html.dark .gf-loading,
        body[data-theme="dark"] .gf-toggle-btn,
        body[data-theme="dark"] .gf-panel,
        body[data-theme="dark"] .gf-loading,
        body.dark .gf-toggle-btn,
        body.dark .gf-panel,
        body.dark .gf-loading {
            --gf-bg: #202124;
            --gf-text: #e8eaed;
            --gf-muted: #aeb3b9;
            --gf-border: #3c4043;
            --gf-soft: #2d2f31;
            --gf-soft-hover: #183a47;
        }
        @media (prefers-color-scheme: dark) {
            .gf-toggle-btn,
            .gf-panel,
            .gf-loading {
                --gf-bg: #202124;
                --gf-text: #e8eaed;
                --gf-muted: #aeb3b9;
                --gf-border: #3c4043;
                --gf-soft: #2d2f31;
                --gf-soft-hover: #183a47;
            }
        }
        @media (max-width: 520px) {
            .gf-toggle-btn,
            .gf-panel {
                top: auto;
                right: 12px;
                bottom: 12px;
            }
            .gf-panel {
                left: 12px;
                width: auto;
                max-height: calc(100vh - 24px);
            }
            .gf-toggle-btn { right: 12px; }
        }
    `);

    installFetchInterceptor();
    State.readyPromise = initialize().catch(error => {
        debugLog('初始化失败:', error);
        State.memberReady = false;
        setStatus(`初始化失败。${getErrorSummary(error)}`, 'error');
    });

    if (document.body) {
        createUI();
    } else {
        document.addEventListener('DOMContentLoaded', createUI, { once: true });
    }
})();
