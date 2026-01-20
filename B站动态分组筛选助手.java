// ==UserScript==
// @name         B站动态分组筛选助手 v11.0
// @namespace    http://tampermonkey.net/
// @version      11.0
// @description  在B站动态页面按关注分组筛选动态（最终修复版）
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

    // ==================== 全局变量 ====================
    let groups = [];
    let groupMembers = {};
    let currentGroupId = GM_getValue('currentGroupId', null);
    let currentGroupMemberSet = null;
    let panelVisible = false;
    let filterStats = { total: 0, shown: 0 };
    let isReady = false;
    let debugMode = true;

    // ==================== 调试日志 ====================
    function debugLog(...args) {
        if (debugMode) {
            console.log('[分组筛选]', ...args);
        }
    }

    // ==================== 初始化 ====================
    async function initSavedGroup() {
        if (currentGroupId) {
            debugLog(`检测到已保存的分组ID: ${currentGroupId}，正在加载成员...`);
            const members = await getGroupMembersSync(currentGroupId);
            if (members && members.length > 0) {
                // 使用字符串Set
                currentGroupMemberSet = new Set(members.map(m => String(m)));
                debugLog(`分组成员加载完成，共 ${members.length} 人`);
                debugLog(`成员示例:`, Array.from(currentGroupMemberSet).slice(0, 5));
            } else {
                currentGroupId = null;
                currentGroupMemberSet = null;
                GM_setValue('currentGroupId', null);
            }
        }
        isReady = true;
    }

    function getGroupMembersSync(tagId) {
        return new Promise((resolve) => {
            const cached = GM_getValue(`members_${tagId}`, null);
            const cacheTime = GM_getValue(`members_${tagId}_time`, 0);
            const now = Date.now();

            // 缓存1小时
            if (cached && cached.length > 0 && (now - cacheTime < 3600000)) {
                groupMembers[tagId] = cached;
                resolve(cached);
                return;
            }

            const allMembers = [];
            let currentPage = 1;

            function fetchPage() {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: `https://api.bilibili.com/x/relation/tag?tagid=${tagId}&pn=${currentPage}&ps=50`,
                    withCredentials: true,
                    headers: { 'Referer': 'https://t.bilibili.com/' },
                    onload: function(response) {
                        try {
                            const data = JSON.parse(response.responseText);
                            if (data.code === 0 && data.data && data.data.length > 0) {
                                data.data.forEach(user => {
                                    // 字符串存储
                                    allMembers.push(String(user.mid));
                                });
                                if (data.data.length === 50) {
                                    currentPage++;
                                    setTimeout(fetchPage, 50);
                                } else {
                                    groupMembers[tagId] = allMembers;
                                    GM_setValue(`members_${tagId}`, allMembers);
                                    GM_setValue(`members_${tagId}_time`, now);
                                    resolve(allMembers);
                                }
                            } else {
                                groupMembers[tagId] = allMembers;
                                if (allMembers.length > 0) {
                                    GM_setValue(`members_${tagId}`, allMembers);
                                    GM_setValue(`members_${tagId}_time`, now);
                                }
                                resolve(allMembers);
                            }
                        } catch (e) { resolve(allMembers); }
                    },
                    onerror: () => resolve(allMembers)
                });
            }
            fetchPage();
        });
    }

    // ==================== 提取mid ====================
    function extractMidFromItem(item) {
        const possibleMids = [
            item?.modules?.module_author?.mid,
            item?.modules?.module_author?.avatar?.mid,
            item?.module_author?.mid,
            item?.author?.mid,
        ];

        for (const mid of possibleMids) {
            if (mid !== undefined && mid !== null) {
                return String(mid);
            }
        }
        return null;
    }

    // ==================== API 拦截 - 核心过滤逻辑 ====================
    const originalFetch = unsafeWindow.fetch;
    unsafeWindow.fetch = async function(...args) {
        const response = await originalFetch.apply(this, args);
        const url = args[0]?.url || args[0];

        if (typeof url === 'string' && url.includes('/x/polymer/web-dynamic/v1/feed/all')) {
            if (!isReady) {
                await new Promise(resolve => {
                    const check = setInterval(() => {
                        if (isReady) {
                            clearInterval(check);
                            resolve();
                        }
                    }, 50);
                });
            }

            if (currentGroupMemberSet && currentGroupMemberSet.size > 0) {
                const clone = response.clone();
                try {
                    const data = await clone.json();
                    if (data.code === 0 && data.data && data.data.items) {
                        const originalCount = data.data.items.length;
                        const originalHasMore = data.data.has_more;

                        // 核心：筛选匹配的动态
                        const filteredItems = data.data.items.filter(item => {
                            const mid = extractMidFromItem(item);
                            return mid && currentGroupMemberSet.has(mid);
                        });

                        const filteredCount = filteredItems.length;
                        filterStats.total += originalCount;
                        filterStats.shown += filteredCount;

                        debugLog(`API拦截: ${originalCount} -> ${filteredCount}, has_more: ${originalHasMore}`);

                        // 替换为筛选后的数据
                        data.data.items = filteredItems;

                        updateStatusText();

                        return new Response(JSON.stringify(data), {
                            status: response.status,
                            statusText: response.statusText,
                            headers: response.headers
                        });
                    }
                } catch (e) {
                    console.error('[分组筛选] 处理响应失败:', e);
                }
            }
        }
        return response;
    };

    initSavedGroup();

    // ==================== 样式 ====================
    GM_addStyle(`
        .gf-container {
            position: fixed;
            top: 70px;
            right: 20px;
            z-index: 99999;
            background: #fff;
            border-radius: 12px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.15);
            padding: 15px;
            min-width: 280px;
            max-height: 75vh;
            overflow-y: auto;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            display: none;
        }
        .gf-container::-webkit-scrollbar { width: 6px; }
        .gf-container::-webkit-scrollbar-thumb { background: #ddd; border-radius: 3px; }
        .gf-title {
            font-weight: bold;
            font-size: 15px;
            margin-bottom: 12px;
            color: #00a1d6;
            border-bottom: 2px solid #00a1d6;
            padding-bottom: 10px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .gf-item {
            padding: 10px 14px;
            margin: 6px 0;
            cursor: pointer;
            border-radius: 8px;
            transition: all 0.2s ease;
            font-size: 14px;
            background: #f5f5f5;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .gf-item:hover { background: #e3f2fd; transform: translateX(3px); }
        .gf-item.active {
            background: linear-gradient(135deg, #00a1d6, #00b5e5);
            color: #fff;
            box-shadow: 0 2px 8px rgba(0,161,214,0.4);
        }
        .gf-item .count { font-size: 12px; opacity: 0.8; }
        .gf-btn {
            position: fixed;
            top: 70px;
            right: 20px;
            z-index: 100000;
            background: linear-gradient(135deg, #00a1d6, #00b5e5);
            color: #fff;
            border: none;
            padding: 12px 18px;
            border-radius: 25px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            box-shadow: 0 4px 15px rgba(0,161,214,0.4);
            transition: all 0.3s ease;
        }
        .gf-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(0,161,214,0.5); }
        .gf-btn.filtering { background: linear-gradient(135deg, #ff9800, #ffb74d); }
        .gf-close { cursor: pointer; font-size: 18px; color: #999; transition: color 0.2s; }
        .gf-close:hover { color: #ff6b6b; }
        .gf-status {
            font-size: 12px;
            color: #666;
            padding: 8px 0;
            border-top: 1px solid #eee;
            margin-top: 10px;
            text-align: center;
        }
        .gf-tip {
            font-size: 12px;
            color: #666;
            padding: 10px;
            background: #fff3e0;
            border-radius: 6px;
            margin-top: 10px;
            line-height: 1.6;
        }
        .gf-loading { text-align: center; padding: 20px; color: #999; }
        .gf-current {
            font-size: 12px;
            color: #ff9800;
            padding: 8px 10px;
            background: #fff3e0;
            border-radius: 6px;
            margin-bottom: 10px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .gf-clear-btn {
            background: #ff5722;
            color: #fff;
            border: none;
            padding: 4px 10px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        }
        .gf-clear-btn:hover { background: #e64a19; }
        .gf-action-btn {
            width: 100%;
            margin-top: 8px;
            padding: 10px;
            color: #fff;
            border: none;
            border-radius: 8px;
            font-size: 13px;
            cursor: pointer;
            font-weight: 500;
            transition: all 0.2s;
        }
        .gf-action-btn:hover { opacity: 0.9; transform: translateY(-1px); }
        .gf-action-btn.primary { background: linear-gradient(135deg, #4caf50, #66bb6a); }
        .gf-action-btn.warning { background: linear-gradient(135deg, #ff9800, #ffb74d); }
    `);

    // ==================== UI ====================
    function createUI() {
        const btn = document.createElement('button');
        btn.className = 'gf-btn';
        btn.id = 'gf-toggle-btn';

        if (currentGroupId) {
            btn.classList.add('filtering');
            const name = GM_getValue('currentGroupName', '筛选中');
            btn.innerHTML = `🔍 ${name}`;
        } else {
            btn.innerHTML = '📁 分组筛选';
        }
        document.body.appendChild(btn);

        const panel = document.createElement('div');
        panel.className = 'gf-container';
        panel.id = 'gf-panel';
        panel.innerHTML = '<div class="gf-loading">加载中...</div>';
        document.body.appendChild(panel);

        btn.addEventListener('click', () => {
            panelVisible = !panelVisible;
            panel.style.display = panelVisible ? 'block' : 'none';
            btn.style.display = panelVisible ? 'none' : 'block';
            if (panelVisible && groups.length === 0) {
                loadGroups();
            }
        });
    }

    function loadGroups() {
        GM_xmlhttpRequest({
            method: 'GET',
            url: 'https://api.bilibili.com/x/relation/tags',
            withCredentials: true,
            headers: { 'Referer': 'https://t.bilibili.com/' },
            onload: function(response) {
                try {
                    const data = JSON.parse(response.responseText);
                    if (data.code === 0 && data.data) {
                        groups = data.data;
                        renderPanel();
                    } else {
                        document.getElementById('gf-panel').innerHTML =
                            '<div class="gf-loading">⚠️ 获取分组失败，请确保已登录B站</div>';
                    }
                } catch (e) {
                    document.getElementById('gf-panel').innerHTML =
                        '<div class="gf-loading">⚠️ 数据解析错误</div>';
                }
            },
            onerror: () => {
                document.getElementById('gf-panel').innerHTML =
                    '<div class="gf-loading">⚠️ 网络错误</div>';
            }
        });
    }

    function renderPanel() {
        const panel = document.getElementById('gf-panel');
        const savedGroupName = GM_getValue('currentGroupName', '');

        let html = `
            <div class="gf-title">
                <span>📁 关注分组筛选</span>
                <span class="gf-close" id="gf-close">✕</span>
            </div>
        `;

        if (currentGroupId && savedGroupName) {
            html += `
                <div class="gf-current">
                    <span>🔍 当前：<strong>${savedGroupName}</strong></span>
                    <button class="gf-clear-btn" id="gf-clear">取消筛选</button>
                </div>
            `;
        }

        html += `
            <div class="gf-item ${!currentGroupId ? 'active' : ''}" data-id="all">
                <span>📺 显示全部动态</span>
            </div>
        `;

        groups.forEach(g => {
            html += `
                <div class="gf-item ${currentGroupId === g.tagid ? 'active' : ''}" data-id="${g.tagid}" data-name="${g.name}">
                    <span>📂 ${g.name}</span>
                    <span class="count">${g.count}人</span>
                </div>
            `;
        });

        html += `
            <div class="gf-status" id="gf-status">
                ${currentGroupId ? `✅ 筛选中 | 显示 ${filterStats.shown} 条` : '选择分组开始筛选'}
            </div>

            <button id="gf-refresh-btn" class="gf-action-btn primary">🔄 刷新页面应用筛选</button>
            <button id="gf-clearcache-btn" class="gf-action-btn warning">🗑️ 清除缓存重新加载</button>

            <div class="gf-tip">
                ⚠️ <strong>重要说明：</strong><br>
                B站动态API限制只能获取<strong>最近几个月</strong>的动态，这是B站服务器的限制，无法突破。<br><br>
                📖 使用方法：选择分组 → 点击刷新 → 向下滚动加载更多
            </div>
        `;
        panel.innerHTML = html;

        // 绑定事件
        document.getElementById('gf-close').addEventListener('click', () => {
            panelVisible = false;
            panel.style.display = 'none';
            document.getElementById('gf-toggle-btn').style.display = 'block';
        });

        const clearBtn = document.getElementById('gf-clear');
        if (clearBtn) {
            clearBtn.addEventListener('click', clearFilter);
        }

        document.getElementById('gf-refresh-btn').addEventListener('click', () => {
            location.reload();
        });

        document.getElementById('gf-clearcache-btn').addEventListener('click', async () => {
            groups.forEach(g => {
                GM_setValue(`members_${g.tagid}`, null);
                GM_setValue(`members_${g.tagid}_time`, 0);
            });
            if (currentGroupId) {
                GM_setValue(`members_${currentGroupId}`, null);
                GM_setValue(`members_${currentGroupId}_time`, 0);
            }
            alert('缓存已清除，即将刷新页面');
            location.reload();
        });

        // 分组点击
        panel.querySelectorAll('.gf-item').forEach(item => {
            item.addEventListener('click', async () => {
                const tagId = item.dataset.id;
                const tagName = item.dataset.name || '';

                panel.querySelectorAll('.gf-item').forEach(i => i.classList.remove('active'));
                item.classList.add('active');

                if (tagId === 'all') {
                    clearFilter();
                } else {
                    await selectGroup(parseInt(tagId), tagName);
                }
            });
        });
    }

    function updateStatusText() {
        const el = document.getElementById('gf-status');
        if (el && currentGroupId) {
            el.textContent = `✅ 筛选中 | 已显示 ${filterStats.shown} 条，已过滤 ${filterStats.total - filterStats.shown} 条`;
        }
    }

    async function selectGroup(tagId, tagName) {
        const statusEl = document.getElementById('gf-status');
        if (statusEl) statusEl.textContent = '正在加载分组成员...';

        // 清除缓存获取最新数据
        GM_setValue(`members_${tagId}`, null);
        GM_setValue(`members_${tagId}_time`, 0);

        const members = await getGroupMembersSync(tagId);

        if (members.length === 0) {
            if (statusEl) statusEl.textContent = '⚠️ 该分组没有成员';
            return;
        }

        currentGroupId = tagId;
        currentGroupMemberSet = new Set(members.map(m => String(m)));
        filterStats = { total: 0, shown: 0 };

        GM_setValue('currentGroupId', tagId);
        GM_setValue('currentGroupName', tagName);

        debugLog(`已选择分组: ${tagName}, 成员数: ${members.length}`);

        const btn = document.getElementById('gf-toggle-btn');
        btn.classList.add('filtering');
        btn.innerHTML = `🔍 ${tagName}`;

        if (statusEl) {
            statusEl.textContent = `已选择「${tagName}」(${members.length}人)，请刷新页面`;
        }

        renderPanel();
    }

    function clearFilter() {
        currentGroupId = null;
        currentGroupMemberSet = null;
        filterStats = { total: 0, shown: 0 };

        GM_setValue('currentGroupId', null);
        GM_setValue('currentGroupName', '');

        const btn = document.getElementById('gf-toggle-btn');
        btn.classList.remove('filtering');
        btn.innerHTML = '📁 分组筛选';

        renderPanel();
    }

    // ==================== 初始化 ====================
    function init() {
        if (document.body) {
            createUI();
            debugLog('v11.0 最终修复版已加载');
        } else {
            document.addEventListener('DOMContentLoaded', init);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        setTimeout(init, 0);
    }

})();
