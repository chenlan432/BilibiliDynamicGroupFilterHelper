// ==UserScript==
// @name         B站动态分组筛选助手 v17.0
// @namespace    http://tampermonkey.net/
// @version      17.0
// @description  在B站动态页面按关注分组筛选动态，支持多分组筛选、分组搜索、自动加载历史动态
// @author       You
// @match        https://t.bilibili.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @connect      api.bilibili.com
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // ========== 配置常量 ==========
    const CONFIG = {
        CACHE_TTL: 3600000,
        PAGE_SIZE: 50,
        SCROLL_COOLDOWN: 150,
        API_RETRY_COUNT: 3,
        API_RETRY_DELAY: 1000,
        API_TIMEOUT: 10000,
        REQUEST_INTERVAL: 30,
        MAX_EMPTY_PAGES: 200,
        AUTO_FETCH_DELAY: 50,
        DYNAMIC_API_PATH: '/x/polymer/web-dynamic/v1/feed/all',
        MEMBER_API: 'https://api.bilibili.com/x/relation/tag',
        GROUPS_API: 'https://api.bilibili.com/x/relation/tags'
    };

    // ========== 状态管理 ==========
    const State = {
        groups: [],
        currentGroupIds: new Set(),
        currentGroupNames: new Map(),
        memberSet: null,
        panelVisible: false,
        filterStats: { total: 0, shown: 0 },
        readyPromise: null,
        hasMore: true,
        emptyCount: 0
    };

    const log = (...args) => console.log('[分组筛选]', ...args);

    // ========== 初始化：兼容旧版单分组存储 ==========
    function loadSavedGroups() {
        const savedId = GM_getValue('currentGroupId', null);
        const savedName = GM_getValue('currentGroupName', '');
        const savedIds = GM_getValue('currentGroupIds', null);
        const savedNames = GM_getValue('currentGroupNames', null);

        if (savedIds && Array.isArray(savedIds)) {
            savedIds.forEach(id => State.currentGroupIds.add(id));
            if (savedNames) {
                Object.entries(savedNames).forEach(([k, v]) => State.currentGroupNames.set(Number(k), v));
            }
        } else if (savedId) {
            State.currentGroupIds.add(savedId);
            if (savedName) {
                State.currentGroupNames.set(savedId, savedName);
            }
            saveGroupSelection();
        }
    }

    function saveGroupSelection() {
        const ids = Array.from(State.currentGroupIds);
        const names = {};
        State.currentGroupNames.forEach((v, k) => { names[k] = v; });
        GM_setValue('currentGroupIds', ids);
        GM_setValue('currentGroupNames', names);
        GM_setValue('currentGroupId', ids.length === 1 ? ids[0] : null);
        GM_setValue('currentGroupName', ids.length === 1 ? (State.currentGroupNames.get(ids[0]) || '') : '');
    }

    async function init() {
        loadSavedGroups();
        if (State.currentGroupIds.size > 0) {
            log('加载分组:', Array.from(State.currentGroupIds));
            await loadSelectedGroupMembers();
            if (!State.memberSet?.size) {
                State.currentGroupIds.clear();
                State.currentGroupNames.clear();
                saveGroupSelection();
            }
        }
    }

    State.readyPromise = init();

    // ========== 通用请求工具 ==========
    function gmFetch(url, options = {}) {
        const { timeout = CONFIG.API_TIMEOUT, retries = CONFIG.API_RETRY_COUNT, retryDelay = CONFIG.API_RETRY_DELAY } = options;

        const attempt = (remaining) => {
            return new Promise((resolve, reject) => {
                const req = GM_xmlhttpRequest({
                    method: 'GET',
                    url,
                    withCredentials: true,
                    timeout,
                    onload: r => {
                        try {
                            const data = JSON.parse(r.responseText);
                            resolve(data);
                        } catch (e) {
                            log('JSON 解析失败:', url, e.message);
                            reject(e);
                        }
                    },
                    onerror: e => {
                        log('请求失败:', url, e);
                        reject(new Error('请求失败'));
                    },
                    ontimeout: () => {
                        log('请求超时:', url);
                        reject(new Error('请求超时'));
                    }
                });
            }).catch(err => {
                if (remaining > 1) {
                    const delay = retryDelay * (retries - remaining + 1);
                    log(`重试 (${retries - remaining + 1}/${retries - 1}):`, url);
                    return new Promise(r => setTimeout(r, delay)).then(() => attempt(remaining - 1));
                }
                throw err;
            });
        };

        return attempt(retries);
    }

    // ========== 分组成员拉取（支持缓存） ==========
    async function fetchMembers(tagId, useCache = true) {
        if (useCache) {
            const cached = GM_getValue(`m_${tagId}`, null);
            const time = GM_getValue(`t_${tagId}`, 0);
            if (cached?.length && Date.now() - time < CONFIG.CACHE_TTL) {
                log(`使用缓存: 分组${tagId}, ${cached.length}人`);
                return cached;
            }
        }

        const all = [];
        let page = 1;

        while (true) {
            try {
                const data = await gmFetch(
                    `${CONFIG.MEMBER_API}?tagid=${tagId}&pn=${page}&ps=${CONFIG.PAGE_SIZE}`
                );
                if (data.code === 0 && data.data) {
                    data.data.forEach(u => all.push(String(u.mid)));
                    if (data.data.length === CONFIG.PAGE_SIZE) {
                        page++;
                        await new Promise(r => setTimeout(r, CONFIG.REQUEST_INTERVAL));
                    } else {
                        break;
                    }
                } else {
                    log(`分组${tagId}获取异常, code:`, data.code);
                    break;
                }
            } catch (e) {
                log(`分组${tagId}第${page}页拉取失败:`, e.message);
                break;
            }
        }

        if (all.length > 0) {
            GM_setValue(`m_${tagId}`, all);
            GM_setValue(`t_${tagId}`, Date.now());
        }
        return all;
    }

    // ========== 多分组成员合并 ==========
    async function loadSelectedGroupMembers() {
        const allMembers = [];
        for (const groupId of State.currentGroupIds) {
            const members = await fetchMembers(groupId);
            allMembers.push(...members);
        }
        if (allMembers.length > 0) {
            State.memberSet = new Set(allMembers.map(String));
            log(`成员总数: ${State.memberSet.size}`);
        } else {
            State.memberSet = null;
        }
    }

    // ========== API 拦截 ==========
    const _fetch = unsafeWindow.fetch;
    unsafeWindow.fetch = async function(...args) {
        const res = await _fetch.apply(this, args);
        const url = args[0]?.url || args[0];

        if (typeof url === 'string' && url.includes(CONFIG.DYNAMIC_API_PATH)) {
            await State.readyPromise;

            if (State.memberSet?.size) {
                try {
                    const clone = res.clone();
                    const data = await clone.json();

                    if (data.code === 0 && data.data) {
                        const items = data.data.items || [];
                        const origLen = items.length;
                        let apiHasMore = !!data.data.has_more;
                        let nextOffset = data.data.offset || '';

                        const filtered = items.filter(item => {
                            const mid = String(item?.modules?.module_author?.mid || '');
                            return mid && State.memberSet.has(mid);
                        });

                        State.filterStats.total += origLen;
                        State.filterStats.shown += filtered.length;

                        log(`过滤: ${origLen} -> ${filtered.length}, offset: ${nextOffset}, hasMore: ${apiHasMore}`);

                        // 核心修复：如果过滤后为空且还有更多数据，在拦截器内循环拉取后续页面
                        // 直到攒到有效数据或没有更多数据为止，避免返回空 items 导致前端停止加载
                        const collectedItems = [...filtered];
                        let continuousFetchCount = 0;

                        while (collectedItems.length === 0 && apiHasMore && continuousFetchCount < CONFIG.MAX_EMPTY_PAGES) {
                            continuousFetchCount++;
                            showLoading(true);
                            log(`自动拉取第 ${continuousFetchCount} 页, offset: ${nextOffset}`);

                            await new Promise(r => setTimeout(r, CONFIG.AUTO_FETCH_DELAY));

                            try {
                                const pageUrl = new URL(typeof url === 'string' ? url : url.toString(), location.origin);
                                pageUrl.searchParams.set('offset', nextOffset);
                                pageUrl.searchParams.delete('update_baseline');

                                const pageRes = await _fetch(pageUrl.toString(), { credentials: 'include' });
                                const pageData = await pageRes.json();

                                if (pageData.code === 0 && pageData.data) {
                                    const pageItems = pageData.data.items || [];
                                    apiHasMore = !!pageData.data.has_more;
                                    nextOffset = pageData.data.offset || '';

                                    const pageFiltered = pageItems.filter(item => {
                                        const mid = String(item?.modules?.module_author?.mid || '');
                                        return mid && State.memberSet.has(mid);
                                    });

                                    State.filterStats.total += pageItems.length;
                                    State.filterStats.shown += pageFiltered.length;
                                    collectedItems.push(...pageFiltered);

                                    log(`续拉第${continuousFetchCount}页: ${pageItems.length} -> ${pageFiltered.length}, offset: ${nextOffset}, hasMore: ${apiHasMore}`);
                                } else {
                                    log('续拉页面异常, code:', pageData.code);
                                    break;
                                }
                            } catch (e) {
                                log('续拉请求失败:', e.message);
                                break;
                            }
                        }

                        showLoading(false);

                        if (continuousFetchCount > 0) {
                            State.emptyCount += continuousFetchCount;
                            log(`共连续拉取 ${continuousFetchCount} 页, 最终收集 ${collectedItems.length} 条`);
                        }
                        if (collectedItems.length > 0) {
                            State.emptyCount = 0;
                        }

                        State.hasMore = apiHasMore;

                        // 用收集到的数据 + 最新的 offset 构建返回结果
                        data.data.items = collectedItems;
                        data.data.offset = nextOffset;
                        data.data.has_more = apiHasMore;

                        if (!apiHasMore) {
                            log('已到达数据末尾');
                        }

                        updateUI();

                        return new Response(JSON.stringify(data), {
                            status: res.status,
                            statusText: res.statusText,
                            headers: res.headers
                        });
                    }
                } catch (e) {
                    log('拦截处理异常:', e.message, e.stack);
                }
            }
        }
        return res;
    };

    // ========== 样式（语义化类名） ==========
    GM_addStyle(`
        .gf-panel{position:fixed;top:80px;right:30px;z-index:99999;background:#fff;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.15);padding:15px;width:300px;max-height:75vh;overflow-y:auto;display:none;font-family:system-ui,sans-serif}
        .gf-panel-title{font-weight:700;font-size:15px;color:#00a1d6;border-bottom:2px solid #00a1d6;padding-bottom:10px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center}
        .gf-close-btn{cursor:pointer;color:#999;font-size:18px;line-height:1}.gf-close-btn:hover{color:red}
        .gf-current-group{background:#fff3e0;padding:8px 10px;border-radius:6px;margin-bottom:10px;font-size:12px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:4px}
        .gf-current-group-tag{background:#ff980020;padding:2px 8px;border-radius:4px;font-size:11px}
        .gf-search-box{width:100%;padding:8px 10px;border:1px solid #e0e0e0;border-radius:6px;font-size:13px;outline:none;box-sizing:border-box;margin-bottom:8px}
        .gf-search-box:focus{border-color:#00a1d6}
        .gf-group-list{max-height:45vh;overflow-y:auto}
        .gf-group-item{padding:10px 12px;margin:4px 0;background:#f5f5f5;border-radius:8px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;font-size:14px;transition:all .2s}
        .gf-group-item:hover{background:#e3f2fd}
        .gf-group-item.on{background:#00a1d6;color:#fff}
        .gf-group-item.on .gf-group-count{color:rgba(255,255,255,.8)}
        .gf-group-count{font-size:12px;opacity:.7}
        .gf-stats{font-size:12px;color:#666;text-align:center;padding:8px 0;border-top:1px solid #eee;margin-top:10px}
        .gf-action-btn{width:100%;padding:10px;margin-top:8px;border:none;border-radius:8px;color:#fff;font-size:13px;cursor:pointer;transition:opacity .2s}
        .gf-action-btn:hover{opacity:.9}
        .gf-btn-refresh{background:linear-gradient(135deg,#4caf50,#66bb6a)}
        .gf-btn-clear-cache{background:linear-gradient(135deg,#ff9800,#ffb74d)}
        .gf-cancel-btn{background:#ff5722;padding:4px 10px;font-size:12px;border-radius:4px;border:none;color:#fff;cursor:pointer}
        .gf-cancel-btn:hover{opacity:.85}
        .gf-tip{font-size:11px;color:#888;margin-top:10px;line-height:1.5;background:#f9f9f9;padding:8px;border-radius:6px}
        .gf-toggle-btn{position:fixed;top:80px;right:30px;z-index:100000;background:linear-gradient(135deg,#00a1d6,#00b5e5);color:#fff;border:none;padding:12px 18px;border-radius:25px;cursor:pointer;font-size:14px;box-shadow:0 4px 15px rgba(0,161,214,.4);transition:transform .2s}
        .gf-toggle-btn:hover{transform:translateY(-2px)}
        .gf-toggle-btn.on{background:linear-gradient(135deg,#ff9800,#ffb74d)}
        .gf-loading{position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.8);color:#fff;padding:10px 20px;border-radius:20px;font-size:13px;z-index:99999;display:none}
        .gf-progress-bar{height:3px;background:#00a1d6;border-radius:2px;transition:width .3s;margin-top:6px}
        .gf-hidden{display:none!important}
    `);

    // ========== UI 创建 ==========
    function createUI() {
        const btn = document.createElement('button');
        btn.className = 'gf-toggle-btn' + (State.currentGroupIds.size > 0 ? ' on' : '');
        btn.id = 'gf-toggle-btn';
        btn.textContent = getToggleBtnText();
        document.body.appendChild(btn);

        const panel = document.createElement('div');
        panel.className = 'gf-panel';
        panel.id = 'gf-panel';
        document.body.appendChild(panel);

        const ld = document.createElement('div');
        ld.className = 'gf-loading';
        ld.id = 'gf-loading';
        ld.textContent = '正在加载更多历史动态...';
        document.body.appendChild(ld);

        btn.onclick = () => {
            State.panelVisible = !State.panelVisible;
            panel.style.display = State.panelVisible ? 'block' : 'none';
            btn.style.display = State.panelVisible ? 'none' : 'block';
            if (State.panelVisible && !State.groups.length) loadGroups();
        };

        // 事件委托：面板内所有点击统一处理
        panel.addEventListener('click', handlePanelClick);
    }

    function getToggleBtnText() {
        if (State.currentGroupIds.size === 0) return '📁 分组筛选';
        if (State.currentGroupIds.size === 1) {
            const name = State.currentGroupNames.values().next().value || '';
            return `🔍 ${name}`;
        }
        return `🔍 已选${State.currentGroupIds.size}个分组`;
    }

    function showLoading(show) {
        const ld = document.getElementById('gf-loading');
        if (ld) ld.style.display = show ? 'block' : 'none';
    }

    // ========== 事件委托处理 ==========
    function handlePanelClick(e) {
        const target = e.target;

        // 关闭按钮
        if (target.closest('[data-action="close"]')) {
            State.panelVisible = false;
            document.getElementById('gf-panel').style.display = 'none';
            document.getElementById('gf-toggle-btn').style.display = 'block';
            return;
        }

        // 刷新页面
        if (target.closest('[data-action="refresh"]')) {
            location.reload();
            return;
        }

        // 清除缓存
        if (target.closest('[data-action="clear-cache"]')) {
            State.groups.forEach(g => {
                GM_setValue(`m_${g.tagid}`, null);
                GM_setValue(`t_${g.tagid}`, 0);
            });
            alert('缓存已清除');
            location.reload();
            return;
        }

        // 取消筛选
        if (target.closest('[data-action="cancel"]')) {
            clearSelection();
            return;
        }

        // 分组项点击
        const groupItem = target.closest('.gf-group-item');
        if (groupItem) {
            const id = groupItem.dataset.id;
            if (id === 'all') {
                clearSelection();
            } else {
                toggleGroup(Number(id), groupItem.dataset.name);
            }
            return;
        }
    }

    // ========== 加载分组列表 ==========
    function loadGroups() {
        const panel = document.getElementById('gf-panel');
        panel.innerHTML = '<div style="text-align:center;padding:20px;color:#999">加载中...</div>';
        gmFetch(CONFIG.GROUPS_API)
            .then(data => {
                if (data.code === 0 && data.data) {
                    State.groups = data.data;
                    render();
                } else {
                    panel.innerHTML = '<div style="color:red;padding:20px">获取失败，请确保已登录</div>';
                }
            })
            .catch(e => {
                log('加载分组列表失败:', e.message);
                panel.innerHTML = '<div style="color:red;padding:20px">加载失败，请重试</div>';
            });
    }

    // ========== 渲染面板 ==========
    function render() {
        const panel = document.getElementById('gf-panel');
        const selectedNames = Array.from(State.currentGroupNames.values());
        let html = '';

        // 标题栏
        html += `<div class="gf-panel-title">
            <span>📁 分组筛选</span>
            <span class="gf-close-btn" data-action="close">✕</span>
        </div>`;

        // 当前选中状态
        if (State.currentGroupIds.size > 0) {
            html += `<div class="gf-current-group">
                <span>🔍 已选分组：</span>
                ${selectedNames.map(n => `<span class="gf-current-group-tag">${n}</span>`).join('')}
                <button class="gf-cancel-btn" data-action="cancel">取消全部</button>
            </div>`;
        }

        // 搜索框
        html += `<input class="gf-search-box" id="gf-search-box" type="text" placeholder="搜索分组..." />`;

        // 分组列表
        html += `<div class="gf-group-list" id="gf-group-list">`;
        html += `<div class="gf-group-item ${State.currentGroupIds.size === 0 ? 'on' : ''}" data-id="all">
            <span>📺 全部动态</span>
        </div>`;
        State.groups.forEach(g => {
            const isSelected = State.currentGroupIds.has(g.tagid);
            html += `<div class="gf-group-item ${isSelected ? 'on' : ''}" data-id="${g.tagid}" data-name="${g.name}">
                <span>📂 ${g.name}</span>
                <span class="gf-group-count">${g.count}</span>
            </div>`;
        });
        html += `</div>`;

        // 统计信息
        html += `<div class="gf-stats" id="gf-stats">${State.currentGroupIds.size > 0 ? `显示 ${State.filterStats.shown} 条` : '点击分组进行筛选（支持多选）'}</div>`;

        // 操作按钮
        html += `<button class="gf-action-btn gf-btn-refresh" data-action="refresh">🔄 刷新页面</button>`;
        html += `<button class="gf-action-btn gf-btn-clear-cache" data-action="clear-cache">🗑️ 清除缓存</button>`;

        // 提示
        html += `<div class="gf-tip">💡 支持多选分组。选择后刷新页面生效，向下滚动自动加载更多。</div>`;

        panel.innerHTML = html;

        // 搜索框事件（不通过委托，使用input事件）
        const searchBox = document.getElementById('gf-search-box');
        if (searchBox) {
            searchBox.addEventListener('input', handleSearch);
            // 阻止点击冒泡，防止触发委托
            searchBox.addEventListener('click', e => e.stopPropagation());
        }
    }

    // ========== 搜索过滤分组 ==========
    function handleSearch(e) {
        const keyword = e.target.value.trim().toLowerCase();
        const list = document.getElementById('gf-group-list');
        if (!list) return;

        list.querySelectorAll('.gf-group-item').forEach(item => {
            if (item.dataset.id === 'all') return;
            const name = (item.dataset.name || '').toLowerCase();
            item.classList.toggle('gf-hidden', keyword !== '' && !name.includes(keyword));
        });
    }

    // ========== 更新统计 ==========
    function updateUI() {
        const stats = document.getElementById('gf-stats');
        if (stats && State.currentGroupIds.size > 0) {
            stats.textContent = `显示 ${State.filterStats.shown} 条，过滤 ${State.filterStats.total - State.filterStats.shown} 条`;
        }
        const btn = document.getElementById('gf-toggle-btn');
        if (btn) {
            btn.textContent = getToggleBtnText();
        }
    }

    // ========== 切换分组选中 ==========
    async function toggleGroup(id, name) {
        if (State.currentGroupIds.has(id)) {
            State.currentGroupIds.delete(id);
            State.currentGroupNames.delete(id);
        } else {
            State.currentGroupIds.add(id);
            State.currentGroupNames.set(id, name);
        }

        saveGroupSelection();

        if (State.currentGroupIds.size === 0) {
            State.memberSet = null;
            State.filterStats = { total: 0, shown: 0 };
            State.emptyCount = 0;
            showLoading(false);
            updateToggleBtn();
            render();
            return;
        }

        const stats = document.getElementById('gf-stats');
        if (stats) stats.textContent = '加载分组成员...';

        State.filterStats = { total: 0, shown: 0 };
        State.hasMore = true;
        State.emptyCount = 0;

        await loadSelectedGroupMembers();

        if (!State.memberSet?.size) {
            if (stats) stats.textContent = '所选分组没有成员';
            return;
        }

        updateToggleBtn();
        render();
    }

    function updateToggleBtn() {
        const btn = document.getElementById('gf-toggle-btn');
        if (!btn) return;
        btn.className = 'gf-toggle-btn' + (State.currentGroupIds.size > 0 ? ' on' : '');
        btn.textContent = getToggleBtnText();
    }

    // ========== 清除选择 ==========
    function clearSelection() {
        State.currentGroupIds.clear();
        State.currentGroupNames.clear();
        State.memberSet = null;
        State.filterStats = { total: 0, shown: 0 };
        State.emptyCount = 0;

        saveGroupSelection();
        showLoading(false);
        updateToggleBtn();

        location.reload();
    }

    // ========== 启动 ==========
    if (document.body) {
        createUI();
        log('v17.0 已加载');
    } else {
        document.addEventListener('DOMContentLoaded', () => {
            createUI();
            log('v17.0 已加载');
        });
    }
})();
